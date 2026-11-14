"""Face: evaluate the app's eye-closure decision (MediaPipe Face Landmarker, unchanged) on the
Open and Closed Eyes subset, and train small single-frame classifiers on the model's outputs.

    .venv/Scripts/python scripts/training/face_eval.py

The app's rule (backend/logic/face_metrics.py): eyes count as closed when the eye aspect ratio
(EAR, from the eyelid landmarks) falls below CLOSED_RATIO (0.55) x the person's OWN open-eye
level, measured over the 12 s window. A still image has no window, so the baseline uses the
open-eye level measured on the user's real webcam and written in face_metrics.py (~0.31):
closed if EAR < 0.55 x 0.31. That is the production threshold for a typical open level.

Candidates (fit on train, selected/early-stopped on val, scored once on the untouched test):
  A. a tuned EAR threshold;
  B. MediaPipe's own eyeBlink blendshape scores (the same .task file already outputs them; the
     app currently turns them off) with a tuned threshold -- no training at all;
  C. a small logistic classifier on EAR + eye blendshapes + head pitch;
  D. the same with one hidden layer (16 units).
The Face Landmarker model is never modified. Images the model finds no face in are counted
separately (they get no decision, in the app too).
"""
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
import common  # noqa: E402
from backend.logic import face_metrics as fm  # noqa: E402

RAW = os.path.join(common.TRAINING, "face", "raw", "images")
PROC = os.path.join(common.TRAINING, "face", "processed")
MODEL = os.path.join(common.REPO, "models", "face_analysis", "face_landmarker.task")
TYPICAL_OPEN_EAR = 0.31  # face_metrics.py: open eyes gave ~0.31-0.33 on the user's webcam
BASE_THR = fm.CLOSED_RATIO * TYPICAL_OPEN_EAR
BLEND = ["eyeBlinkLeft", "eyeBlinkRight", "eyeSquintLeft", "eyeSquintRight", "eyeWideLeft", "eyeWideRight", "eyeLookDownLeft", "eyeLookDownRight"]
FEATS = ["ear_mean", "ear_min", "ear_diff"] + BLEND + ["pitch", "yaw"]


def extract(samples):
    out_path = os.path.join(PROC, "landmarker_features.json")
    if os.path.isfile(out_path):
        return json.load(open(out_path, encoding="utf-8"))
    import cv2
    import mediapipe as mp
    from mediapipe.tasks import python as t
    from mediapipe.tasks.python import vision as v
    opts = v.FaceLandmarkerOptions(base_options=t.BaseOptions(model_asset_path=MODEL), running_mode=v.RunningMode.IMAGE, num_faces=2,
                                   output_face_blendshapes=True, output_facial_transformation_matrixes=True)
    lm = v.FaceLandmarker.create_from_options(opts)
    feats, t0 = {}, time.time()
    for s in samples:
        img = cv2.imread(os.path.join(RAW, s["file"]))
        r = lm.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))))
        f = {"faces": len(r.face_landmarks)}
        if r.face_landmarks:
            pts = fm.points(r.face_landmarks[0], img.shape[1], img.shape[0])
            er, el = fm.eye_aspect_ratio(pts, fm.RIGHT_EYE), fm.eye_aspect_ratio(pts, fm.LEFT_EYE)
            bs = {c.category_name: c.score for c in r.face_blendshapes[0]}
            pose = fm.head_pose(r.facial_transformation_matrixes[0]) if r.facial_transformation_matrixes else None
            f.update({"ear_r": er, "ear_l": el, **{b: bs.get(b, 0.0) for b in BLEND},
                      "yaw": pose[0] if pose else 0.0, "pitch": pose[1] if pose else 0.0})
        feats[s["file"]] = f
    lm.close()
    json.dump(feats, open(out_path, "w", encoding="utf-8"))
    print(f"landmarker: {len(samples)} images in {time.time() - t0:.1f} s")
    return feats


def vec(f):
    ear = [f["ear_r"], f["ear_l"]]
    return [float(np.mean(ear)), float(min(ear)), float(abs(ear[0] - ear[1]))] + [f[b] for b in BLEND] + [f["pitch"], f["yaw"]]


def main():
    common.seed_everything()
    sub = json.load(open(os.path.join(PROC, "subset.json"), encoding="utf-8"))["samples"]
    feats = extract(sub)
    labels = ["open", "closed"]
    rep = {"model": "MediaPipe Face Landmarker float16 v1 (unchanged), IMAGE mode, blendshapes on (for candidates B-D)",
           "baseline_rule": f"closed if mean EAR < {fm.CLOSED_RATIO} x {TYPICAL_OPEN_EAR} = {BASE_THR:.4f} (the app's rule with the user's measured open-eye level)"}
    nf = {}
    rows = {"train": [], "val": [], "test": []}
    for s in sub:
        f = feats[s["file"]]
        y = int(s["label"] == "closed_eyes")
        if f["faces"] == 0 or f.get("ear_r") is None or f.get("ear_l") is None:
            nf.setdefault(s["split"], {}).setdefault(s["label"], 0)
            nf[s["split"]][s["label"]] += 1
            continue
        rows[s["split"]].append((vec(f), y, s["file"], f["faces"]))
    rep["no_face_found"] = nf
    rep["usable_with_face"] = {k: len(v) for k, v in rows.items()}
    X = {k: np.array([r[0] for r in v]) for k, v in rows.items()}
    Y = {k: np.array([r[1] for r in v]) for k, v in rows.items()}
    ear = {k: X[k][:, 0] for k in X}
    blink = {k: X[k][:, 3:5].mean(1) for k in X}

    base = {k: (ear[k] < BASE_THR).astype(int) for k in X}
    rep["ear_by_class_train"] = {"open_median": round(float(np.median(ear["train"][Y["train"] == 0])), 3), "closed_median": round(float(np.median(ear["train"][Y["train"] == 1])), 3)}

    def tune(score, y, closed_when_low):
        cands = np.unique(np.round(score, 3))
        best, bt = -1, None
        for t in cands:
            pred = (score < t) if closed_when_low else (score >= t)
            f1 = common.metrics(y, pred.astype(int), labels)["macro_f1"]
            if f1 > best:
                best, bt = f1, float(t)
        return bt, best
    tA, _ = tune(ear["train"], Y["train"], True)
    tB, _ = tune(blink["train"], Y["train"], False)
    preds = {"baseline_app_rule": base,
             "A_tuned_ear_threshold": {k: (ear[k] < tA).astype(int) for k in X},
             "B_blendshape_eyeBlink_threshold": {k: (blink[k] >= tB).astype(int) for k in X}}
    t0 = time.time()
    mC, infoC = common.train_head(X["train"], Y["train"], X["val"], Y["val"], 2, hidden=0, lr=1e-2, batch=32, patience=25,
                                  log_path=os.path.join(common.REPORTS, "face_logistic_trainlog.jsonl"))
    mD, infoD = common.train_head(X["train"], Y["train"], X["val"], Y["val"], 2, hidden=16, lr=3e-3, batch=32, patience=25,
                                  log_path=os.path.join(common.REPORTS, "face_mlp_trainlog.jsonl"))
    train_s = time.time() - t0
    preds["C_logistic_landmarker_features"] = {k: common.head_predict_proba(mC, X[k]).argmax(1) for k in X}
    preds["D_mlp16_landmarker_features"] = {k: common.head_predict_proba(mD, X[k]).argmax(1) for k in X}
    res = {}
    for name, p in preds.items():
        res[name] = {"val": common.metrics(Y["val"], p["val"], labels), "test": common.metrics(Y["test"], p["test"], labels)}
    res["A_tuned_ear_threshold"]["threshold"] = tA
    res["B_blendshape_eyeBlink_threshold"]["threshold"] = tB
    res["C_logistic_landmarker_features"]["train"] = infoC
    res["D_mlp16_landmarker_features"]["train"] = infoD
    for name in preds:
        if name != "baseline_app_rule":
            res[name]["bootstrap_macro_f1_diff_vs_baseline_test"] = common.bootstrap_diff(Y["test"], base["test"], preds[name]["test"], labels)
    rep["features"] = FEATS
    rep["results"] = res
    rep["training_seconds_C_and_D"] = round(train_s, 1)
    # failure cases of the best candidate and of the baseline on test
    best = max((n for n in preds if n != "baseline_app_rule"), key=lambda n: res[n]["val"]["macro_f1"])
    rep["selected_on_val"] = best
    fails = []
    for (v, y, fname, faces), pb, pc in zip(rows["test"], base["test"], preds[best]["test"]):
        if pb != y or pc != y:
            fails.append({"file": fname, "true": labels[y], "baseline": labels[pb], best: labels[pc], "ear_mean": round(v[0], 3), "eyeBlink_mean": round((v[3] + v[4]) / 2, 3), "pitch": round(v[-2], 1)})
    rep["failure_cases_test"] = fails[:40]
    rep["failure_counts_test"] = {"baseline_wrong": int((base["test"] != Y["test"]).sum()), f"{best}_wrong": int((preds[best]["test"] != Y["test"]).sum())}
    os.makedirs(common.CANDIDATES, exist_ok=True)
    np.savez(os.path.join(common.CANDIDATES, "face_eye_state_logistic.npz"), **{k: v for k, v in mC.items() if k != "hidden"}, features=np.array(FEATS))
    np.savez(os.path.join(common.CANDIDATES, "face_eye_state_mlp16.npz"), **{k: v for k, v in mD.items() if k != "hidden"}, features=np.array(FEATS))
    common.write_report("face_evaluation.json", rep)
    print("no face:", nf, "usable:", rep["usable_with_face"], rep["ear_by_class_train"])
    for name in preds:
        m, mv = res[name]["test"], res[name]["val"]
        print(f"{name:34s} val F1 {mv['macro_f1']:.3f} | test acc {m['accuracy']:.3f} F1 {m['macro_f1']:.3f} closed-P {m['per_class']['closed']['precision']:.3f} closed-R {m['per_class']['closed']['recall']:.3f}  {res[name].get('bootstrap_macro_f1_diff_vs_baseline_test', '')}")
    print("thresholds A", tA, "B", tB, "selected on val:", best)


if __name__ == "__main__":
    main()
