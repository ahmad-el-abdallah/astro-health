"""Pose: how accurate is shoulder/hip tilt for FRONT-FACING people (the webcam case)?

    .venv/Scripts/python scripts/training/pose_tilt_frontal.py   (after pose_eval.py)

COCO mostly shows people from the side or at angles; the app's camera sees someone facing it.
This splits the test-and-val images by how frontal the ANNOTATED body is (ground-truth shoulder
width / torso length, the same ratio pose_metrics uses for 'turned away') and reports tilt
error per group. No training. Uses the model outputs saved by pose_eval.py.
"""
import json
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
import common  # noqa: E402
from backend.logic import pose_metrics as pm  # noqa: E402
from pose_eval import as_lm, best_pose  # noqa: E402

PROC = os.path.join(common.TRAINING, "pose", "processed")


def main():
    sub = json.load(open(os.path.join(PROC, "subset.json"), encoding="utf-8"))["samples"]
    outs = json.load(open(os.path.join(PROC, "mediapipe_outputs.json"), encoding="utf-8"))
    groups = {"frontal (ratio >= 0.6)": [], "angled (ratio < 0.6)": []}
    by_vis = {"both shoulders vis >= 0.9": [], "vis 0.5-0.9": []}
    for s in sub:
        if not s["person"] or s["split"] == "train":
            continue
        o = outs[str(s["image_id"])]
        if not o["poses"]:
            continue
        gt = np.array(s["gt"])
        L, R, LH, RH = pm.L_SHOULDER, pm.R_SHOULDER, pm.L_HIP, pm.R_HIP
        if min(gt[L, 2], gt[R, 2], gt[LH, 2], gt[RH, 2]) == 0:
            continue
        w, h = o["w"], o["h"]
        sw = math.hypot((gt[L, 0] - gt[R, 0]) * w, (gt[L, 1] - gt[R, 1]) * h)
        torso = math.hypot(((gt[L, 0] + gt[R, 0]) - (gt[LH, 0] + gt[RH, 0])) / 2 * w, ((gt[L, 1] + gt[R, 1]) - (gt[LH, 1] + gt[RH, 1])) / 2 * h)
        if torso < 1:
            continue
        p = best_pose(o["poses"], gt)
        lm = as_lm(p)
        if not (pm.seen(lm, L) and pm.seen(lm, R)):
            continue
        g = np.zeros((33, 4)); g[:, :2] = gt[:, :2]
        err = abs(pm.tilt(lm, L, R, w, h) - pm.tilt(g, L, R, w, h))
        groups["frontal (ratio >= 0.6)" if sw / torso >= 0.6 else "angled (ratio < 0.6)"].append(err)
        by_vis["both shoulders vis >= 0.9" if min(lm[L, 3], lm[R, 3]) >= 0.9 else "vis 0.5-0.9"].append(err)

    def summ(e):
        return {"n": len(e), "median_deg": round(float(np.median(e)), 2) if e else None, "p75_deg": round(float(np.percentile(e, 75)), 2) if e else None,
                "p90_deg": round(float(np.percentile(e, 90)), 2) if e else None, "share_within_2deg": round(float(np.mean(np.array(e) <= 2)), 3) if e else None,
                "share_within_5deg": round(float(np.mean(np.array(e) <= 5)), 3) if e else None}
    rep = {"what": "shoulder tilt error (deg), MediaPipe lite vs COCO keypoints, val+test images with shoulders and hips labelled and both shoulders accepted by the app's gate",
           "by_frontalness": {k: summ(v) for k, v in groups.items()}, "by_mediapipe_visibility": {k: summ(v) for k, v in by_vis.items()},
           "app_level_threshold_deg": pm.LEVEL_DEG}
    common.write_report("pose_tilt_accuracy.json", rep)
    print(json.dumps(rep, indent=1))


if __name__ == "__main__":
    main()
