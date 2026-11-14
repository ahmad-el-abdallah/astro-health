"""Pose: evaluate the app's MediaPipe Pose Landmarker (lite, unchanged) against COCO keypoints,
and calibrate the decisions backend/logic/pose_metrics.py makes from its output.

    .venv/Scripts/python scripts/training/pose_eval.py

What is measured (only what COCO can genuinely check -- COCO has no posture labels, so no
posture classifier is trained and no posture label is invented):
  1. body found: positives (one annotated person) vs negatives (no person) -> detection rate
     and false "body found" rate;
  2. "both shoulders in view" and "both hips in view" -- the two gates pose_metrics uses
     before measuring shoulder/hip alignment and lean. Ground truth: both COCO keypoints
     labelled (v > 0). Baseline: pose_metrics.seen() on both (visibility >= 0.5, inside the
     frame);
  3. how accurate the measurements are when a gate says yes: shoulder/hip tilt error in degrees
     (pose_metrics.tilt on MediaPipe vs on COCO points) and keypoint error (PCK).

Candidates (fit on train, early-stopped/selected on val, scored once on the untouched test):
  A. a tuned visibility threshold per gate;
  B. a small logistic gate per pair: visibility, presence and distance to the frame edge of
     both landmarks. Same inputs the app already has -- no new model.
The MediaPipe model itself is never modified.
"""
import json
import math
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
import common  # noqa: E402
from backend.logic import pose_metrics as pm  # noqa: E402

RAW = os.path.join(common.TRAINING, "pose", "raw", "images")
PROC = os.path.join(common.TRAINING, "pose", "processed")
MODEL = os.path.join(common.REPO, "models", "pose_analysis", "pose_landmarker_lite.task")
FRAME_W = 640  # the browser sends 640 px wide frames
PAIRS = {"shoulders": (pm.L_SHOULDER, pm.R_SHOULDER), "hips": (pm.L_HIP, pm.R_HIP)}


def run_model(samples):
    import cv2
    import mediapipe as mp
    from mediapipe.tasks import python as t
    from mediapipe.tasks.python import vision as v
    out_path = os.path.join(PROC, "mediapipe_outputs.json")
    if os.path.isfile(out_path):
        return json.load(open(out_path, encoding="utf-8"))
    opts = v.PoseLandmarkerOptions(base_options=t.BaseOptions(model_asset_path=MODEL), running_mode=v.RunningMode.IMAGE,
                                   num_poses=2, min_pose_detection_confidence=0.5, min_pose_presence_confidence=0.5,
                                   min_tracking_confidence=0.5, output_segmentation_masks=False)
    lm = v.PoseLandmarker.create_from_options(opts)
    outs, t0 = {}, time.time()
    for s in samples:
        img = cv2.imread(os.path.join(RAW, s["file"]))
        scale = FRAME_W / img.shape[1]
        img = cv2.resize(img, (FRAME_W, int(round(img.shape[0] * scale))), interpolation=cv2.INTER_AREA)
        r = lm.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))))
        outs[str(s["image_id"])] = {"w": img.shape[1], "h": img.shape[0],
                                    "poses": [[[p.x, p.y, p.z, p.visibility if p.visibility is not None else 0.0, p.presence if p.presence is not None else 0.0] for p in pose]
                                              for pose in r.pose_landmarks]}
    lm.close()
    json.dump(outs, open(out_path, "w", encoding="utf-8"))
    print(f"model run: {len(samples)} images in {time.time() - t0:.1f} s")
    return outs


def best_pose(poses, gt):
    """The detected pose closest to the annotated person (mean distance over labelled points)."""
    best, bd = None, 1e9
    lab = gt[:, 2] > 0
    for p in poses:
        p = np.array(p)
        d = np.mean(np.hypot(p[lab, 0] - gt[lab, 0], p[lab, 1] - gt[lab, 1])) if lab.any() else 0
        if d < bd:
            best, bd = p, d
    return best


def features(p, pair):
    """Per pair: visibility, presence, and the distance to the nearest frame edge, for both points."""
    f = []
    for i in pair:
        x, y, _z, vis, pres = p[i]
        f += [vis, pres, min(x, 1 - x, y, 1 - y)]
    return f


def as_lm(p):
    """MediaPipe output -> the (33, 4) array pose_metrics uses (visibility = min(vis, presence))."""
    a = np.zeros((33, 4))
    a[:, :3] = p[:, :3]
    a[:, 3] = np.minimum(p[:, 3], p[:, 4])
    return a


def binary(y, yhat):
    return common.metrics(np.asarray(y, int), np.asarray(yhat, int), ["no", "yes"])


def main():
    common.seed_everything()
    sub = json.load(open(os.path.join(PROC, "subset.json"), encoding="utf-8"))["samples"]
    outs = run_model(sub)
    rep = {"model": "MediaPipe Pose Landmarker lite float16 v1 (unchanged), IMAGE mode, 640 px wide, num_poses=2",
           "note": "The app runs VIDEO mode on a live feed; IMAGE mode on stills has no tracking, so this is a per-frame check."}

    # 1. body found
    det = {"pos_found": 0, "pos_exactly_one": 0, "pos": 0, "neg_found": 0, "neg": 0, "neg_false_files": []}
    for s in sub:
        n = len(outs[str(s["image_id"])]["poses"])
        if s["person"]:
            det["pos"] += 1
            det["pos_found"] += n >= 1
            det["pos_exactly_one"] += n == 1
        else:
            det["neg"] += 1
            det["neg_found"] += n >= 1
            if n:
                det["neg_false_files"].append(s["file"])
    y = [int(s["person"]) for s in sub]
    yhat = [int(len(outs[str(s["image_id"])]["poses"]) >= 1) for s in sub]
    rep["body_found"] = {**{k: v for k, v in det.items() if k != "neg_false_files"}, "false_positive_files": det["neg_false_files"],
                         "detection_rate": round(det["pos_found"] / det["pos"], 4), "false_body_rate": round(det["neg_found"] / det["neg"], 4),
                         "metrics": binary(y, yhat)}

    # 2/3. gates and measurement error, on positives where a body was found
    rows = []
    for s in sub:
        if not s["person"]:
            continue
        o = outs[str(s["image_id"])]
        if not o["poses"]:
            continue
        gt = np.array(s["gt"])
        p = best_pose(o["poses"], gt)
        lm = as_lm(p)
        r = {"id": s["image_id"], "split": s["split"], "w": o["w"], "h": o["h"], "n_poses": len(o["poses"])}
        for name, (a, b) in PAIRS.items():
            r[f"{name}_gt"] = int(gt[a, 2] > 0 and gt[b, 2] > 0)
            r[f"{name}_base"] = int(pm.seen(lm, a) and pm.seen(lm, b))
            r[f"{name}_feat"] = features(p, (a, b))
            if r[f"{name}_gt"]:
                g = np.zeros((33, 4)); g[:, :2] = gt[:, :2]
                t_gt = pm.tilt(g, a, b, o["w"], o["h"])
                t_mp = pm.tilt(lm, a, b, o["w"], o["h"])
                r[f"{name}_tilt_err"] = None if t_gt is None or t_mp is None else abs(t_mp - t_gt)
                # keypoint error, normalised by the person box diagonal (PCK@0.1 style)
                bw, bh = s["bbox"][2] / s["w"] * o["w"], s["bbox"][3] / s["h"] * o["h"]
                diag = math.hypot(bw, bh)
                r[f"{name}_kp_err"] = float(np.mean([math.hypot((p[i, 0] - gt[i, 0]) * o["w"], (p[i, 1] - gt[i, 1]) * o["h"]) / diag for i in (a, b)]))
        rows.append(r)
    rep["positives_with_body"] = len(rows)

    def tilt_summary(rs, name, gate_key):
        errs = [r[f"{name}_tilt_err"] for r in rs if r[gate_key] and r[f"{name}_gt"] and r.get(f"{name}_tilt_err") is not None]
        kps = [r[f"{name}_kp_err"] for r in rs if r[gate_key] and r[f"{name}_gt"]]
        wrong = sum(1 for r in rs if r[gate_key] and not r[f"{name}_gt"])
        return {"accepted": sum(1 for r in rs if r[gate_key]), "accepted_but_not_really_in_view": wrong,
                "tilt_error_deg_median": None if not errs else round(float(np.median(errs)), 2),
                "tilt_error_deg_p90": None if not errs else round(float(np.percentile(errs, 90)), 2),
                "pck_0.1": None if not kps else round(float(np.mean(np.array(kps) < 0.1)), 3)}

    test = [r for r in rows if r["split"] == "test"]
    train = [r for r in rows if r["split"] == "train"]
    val = [r for r in rows if r["split"] == "val"]
    rep["split_sizes"] = {"train": len(train), "val": len(val), "test": len(test)}
    gates = {}
    for name in PAIRS:
        ytr = np.array([r[f"{name}_gt"] for r in train]); yva = np.array([r[f"{name}_gt"] for r in val]); yte = np.array([r[f"{name}_gt"] for r in test])
        base_te = np.array([r[f"{name}_base"] for r in test])
        # A. tuned threshold on min(visibility, presence) of both points, plus the same edge margin
        def thr_pred(rs, thr):
            out = []
            for r in rs:
                f = r[f"{name}_feat"]
                vis = min(min(f[0], f[1]), min(f[3], f[4]))
                inside = min(f[2], f[5]) >= pm.EDGE
                out.append(int(vis >= thr and inside))
            return np.array(out)
        grid = np.round(np.arange(0.05, 0.96, 0.05), 2)
        tr_scores = {float(t): binary(ytr, thr_pred(train, t))["macro_f1"] for t in grid}
        best_t = max(tr_scores, key=lambda t: (tr_scores[t], -abs(t - 0.5)))
        # B. logistic gate
        Xtr = np.array([r[f"{name}_feat"] for r in train]); Xva = np.array([r[f"{name}_feat"] for r in val]); Xte = np.array([r[f"{name}_feat"] for r in test])
        model, info = common.train_head(Xtr, ytr, Xva, yva, 2, hidden=0, lr=1e-2, weight_decay=1e-3, batch=16, max_epochs=300, patience=30,
                                        log_path=os.path.join(common.REPORTS, f"pose_{name}_gate_trainlog.jsonl"))
        log_te = common.head_predict_proba(model, Xte).argmax(1)
        thr_te = thr_pred(test, best_t)
        for key, pred in (("base", base_te), ("thr", thr_te), ("logit", log_te)):
            for r, v in zip(test, pred):
                r[f"{name}_{key}_test"] = int(v)
        gates[name] = {
            "test_positives_in_view": int(yte.sum()), "test_n": int(len(yte)),
            "baseline_threshold_0.5": {"metrics": binary(yte, base_te), "measurement": tilt_summary(test, name, f"{name}_base")},
            "candidate_A_tuned_threshold": {"threshold": best_t, "train_macro_f1_by_threshold": tr_scores, "val_macro_f1": binary(yva, thr_pred(val, best_t))["macro_f1"],
                                            "metrics": binary(yte, thr_te), "measurement": tilt_summary(test, name, f"{name}_thr_test")},
            "candidate_B_logistic_gate": {"train": info, "metrics": binary(yte, log_te), "measurement": tilt_summary(test, name, f"{name}_logit_test")},
            "bootstrap_macro_f1_diff_vs_baseline": {"A": common.bootstrap_diff(yte, base_te, thr_te, ["no", "yes"]),
                                                    "B": common.bootstrap_diff(yte, base_te, log_te, ["no", "yes"])},
        }
        np.savez(os.path.join(common.CANDIDATES, f"pose_{name}_gate_logistic.npz"), **{k: v for k, v in model.items() if k != "hidden"}) if os.path.isdir(common.CANDIDATES) else None
    rep["gates"] = gates
    # failure cases (test): baseline says "in view" when it isn't, and vice versa
    fails = []
    for r in test:
        for name in PAIRS:
            if r[f"{name}_base_test"] != r[f"{name}_gt"]:
                fails.append({"image_id": r["id"], "gate": name, "gt_in_view": bool(r[f"{name}_gt"]), "baseline_said": bool(r[f"{name}_base_test"]),
                              "visibility_presence_edge": [round(x, 3) for x in r[f"{name}_feat"]]})
    rep["baseline_failure_cases_test"] = fails[:40]
    rep["baseline_failure_count_test"] = len(fails)
    common.write_report("pose_evaluation.json", rep)
    print(json.dumps({"body_found": {k: rep["body_found"][k] for k in ("detection_rate", "false_body_rate", "pos", "neg")}, "split": rep["split_sizes"]}, indent=1))
    for name, g in gates.items():
        print(name, "test in-view", g["test_positives_in_view"], "/", g["test_n"])
        for k in ("baseline_threshold_0.5", "candidate_A_tuned_threshold", "candidate_B_logistic_gate"):
            m = g[k]["metrics"]
            print(f"  {k:30s} acc {m['accuracy']:.3f} macroF1 {m['macro_f1']:.3f} yes-P {m['per_class']['yes']['precision']:.3f} yes-R {m['per_class']['yes']['recall']:.3f} | {g[k]['measurement']}")
        print("  bootstrap", g["bootstrap_macro_f1_diff_vs_baseline"], "thr", g["candidate_A_tuned_threshold"]["threshold"])


if __name__ == "__main__":
    os.makedirs(common.CANDIDATES, exist_ok=True)
    main()
