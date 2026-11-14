"""Voice: baseline vs small heads on the app model's own features, on Emozionalmente.

    .venv/Scripts/python scripts/training/voice_train_eval.py

Splits are the corpus's official speaker-independent ones: heads train on a 350-per-class
subset of train, early-stop on dev, and the test speakers (88, never seen) are scored once.

Six labels are shared with the app's model: angry, disgust, fearful, happy, sad, surprised.
Baselines (the production model, unchanged):
  as_deployed   argmax over all 7 model labels ('calm' counts as wrong: it isn't one of the six)
  restricted    argmax over the 6 shared logits only (fairer -- the stronger baseline)
Candidates (trained additional classifiers on top of the frozen production model):
  logit_recal   logistic on the 7 production logits (a re-weighting of the model's own scores)
  pooled_lr     logistic on the model's 256-d pooled vector (its final layer's input)
  mid_lr        logistic on the 768-d mid-layer (8) average
  concat_mlp    one hidden layer (64) on pooled + mid
Selection uses dev macro-F1 only. Speaker-level bootstrap gives the confidence interval.
These are acted emotional speaking styles; no result here says anything about health.
"""
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

PROC = os.path.join(common.TRAINING, "voice", "processed")
MODEL_LABELS = ["angry", "calm", "disgust", "fearful", "happy", "sad", "surprised"]
DS_TO_MODEL = {"anger": "angry", "disgust": "disgust", "fear": "fearful", "joy": "happy", "sadness": "sad", "surprise": "surprised"}
SHARED = ["angry", "disgust", "fearful", "happy", "sad", "surprised"]


def main():
    common.seed_everything()
    clips = json.load(open(os.path.join(PROC, "clips.json"), encoding="utf-8"))
    F = np.load(os.path.join(PROC, "features.npz"))
    pos = {str(f): i for i, f in enumerate(F["files"])}
    missing = [c["file"] for c in clips if c["file"] not in pos]
    if missing:
        raise SystemExit(f"{len(missing)} clips have no features yet (run voice_features.py)")
    six = [c for c in clips if c["label"] in DS_TO_MODEL]

    def take(split, validated=False):
        cs = [c for c in six if c["split"] == split and (not validated or c["validated"])]
        idx = np.array([pos[c["file"]] for c in cs])
        y = np.array([SHARED.index(DS_TO_MODEL[c["label"]]) for c in cs])
        spk = np.array([c["speaker"] for c in cs])
        return cs, idx, y, spk

    feats = {"logits": F["logits"], "pooled": F["pooled"], "mid": F["hid_mid"], "concat": np.hstack([F["pooled"], F["hid_mid"]])}
    _, itr, ytr, _ = take("train")
    _, iva, yva, _ = take("dev")
    sets = {"test_all": take("test"), "test_validated_3of5": take("test", validated=True)}

    def base_as_deployed(idx):
        pred = F["logits"][idx].argmax(1)
        return np.array([SHARED.index(MODEL_LABELS[p]) if MODEL_LABELS[p] in SHARED else -1 for p in pred])

    shared_cols = [MODEL_LABELS.index(l) for l in SHARED]

    def base_restricted(idx):
        return F["logits"][idx][:, shared_cols].argmax(1)

    rep = {"labels": SHARED, "train_clips": int(len(ytr)), "dev_clips": int(len(yva)),
           "train_speakers": len({c["speaker"] for c in six if c["split"] == "train"}),
           "baseline_model": "Dpngtm/wav2vec2-emotion-recognition @ 033a5751 (models/wav2vec2-emotion, unchanged)"}
    cands = {"logit_recal": ("logits", 0, 1e-2), "pooled_lr": ("pooled", 0, 1e-3), "mid_lr": ("mid", 0, 1e-3), "concat_mlp": ("concat", 64, 1e-3)}
    models, infos = {}, {}
    t0 = time.time()
    for name, (fk, hidden, lr) in cands.items():
        m, info = common.train_head(feats[fk][itr], ytr, feats[fk][iva], yva, len(SHARED), hidden=hidden, lr=lr, weight_decay=1e-2,
                                    batch=32, max_epochs=200, patience=15, log_path=os.path.join(common.REPORTS, f"voice_{name}_trainlog.jsonl"))
        models[name], infos[name] = m, info
    rep["training_seconds_total"] = round(time.time() - t0, 1)
    dev = {"baseline_restricted": common.metrics(yva, base_restricted(iva), SHARED)["macro_f1"],
           "baseline_as_deployed": common.metrics(yva, base_as_deployed(iva), SHARED)["macro_f1"]}
    for name, (fk, _h, _lr) in cands.items():
        dev[name] = common.metrics(yva, common.head_predict_proba(models[name], feats[fk][iva]).argmax(1), SHARED)["macro_f1"]
    best = max(cands, key=lambda n: dev[n])
    rep["dev_macro_f1"] = dev
    rep["selected_on_dev"] = best
    rep["training"] = infos
    results = {}
    for sname, (cs, idx, y, spk) in sets.items():
        pr = {"baseline_as_deployed": base_as_deployed(idx), "baseline_restricted": base_restricted(idx)}
        for name, (fk, _h, _lr) in cands.items():
            pr[name] = common.head_predict_proba(models[name], feats[fk][idx]).argmax(1)
        r = {"n": int(len(y)), "speakers": int(len(set(spk))), "metrics": {k: common.metrics(y, v, SHARED) for k, v in pr.items()}}
        r["bootstrap_by_speaker_macro_f1_diff"] = {name: common.bootstrap_diff(y, pr["baseline_restricted"], pr[name], SHARED, n=500, groups=spk) for name in cands}
        # subject-level generalisation: per-speaker accuracy
        per_spk = {}
        for k in ("baseline_restricted", best):
            accs = [float((pr[k][spk == s] == y[spk == s]).mean()) for s in sorted(set(spk))]
            per_spk[k] = {"median": round(float(np.median(accs)), 3), "p10": round(float(np.percentile(accs, 10)), 3), "p90": round(float(np.percentile(accs, 90)), 3),
                          "speakers_better_than_chance": int(sum(a > 1 / 6 for a in accs))}
        better = sum(1 for s in sorted(set(spk)) if (pr[best][spk == s] == y[spk == s]).mean() > (pr["baseline_restricted"][spk == s] == y[spk == s]).mean())
        worse = sum(1 for s in sorted(set(spk)) if (pr[best][spk == s] == y[spk == s]).mean() < (pr["baseline_restricted"][spk == s] == y[spk == s]).mean())
        per_spk["speakers_improved_vs_worse"] = [better, worse]
        r["per_speaker_accuracy"] = per_spk
        if sname == "test_all":
            calm = int((F["logits"][idx].argmax(1) == MODEL_LABELS.index("calm")).sum())
            r["baseline_predicted_calm_count"] = calm
            fails = []
            for c, t, pb, pc in zip(cs, y, pr["baseline_restricted"], pr[best]):
                if pb != t and pc != t:
                    fails.append({"file": c["file"], "true": SHARED[t], "baseline": SHARED[pb], best: SHARED[pc], "rater_agreement": c["rater_agreement"], "rater_majority": c["rater_majority"]})
            r["both_wrong_examples"] = fails[:25]
            r["both_wrong_count"] = len(fails)
            r["both_wrong_mean_rater_agreement"] = round(float(np.mean([f["rater_agreement"] for f in fails if f["rater_agreement"] is not None])), 3) if fails else None
        results[sname] = r
    # neutral: no model label exists; how the deployed model labels neutral clips
    neu = [c for c in clips if c["label"] == "neutrality" and c["split"] == "test"]
    nidx = np.array([pos[c["file"]] for c in neu])
    from collections import Counter
    rep["neutral_test_clips_labelled_by_model_as"] = dict(Counter(MODEL_LABELS[p] for p in F["logits"][nidx].argmax(1)))
    rep["results"] = results
    os.makedirs(common.CANDIDATES, exist_ok=True)
    m = models[best]
    np.savez(os.path.join(common.CANDIDATES, f"voice_{best}.npz"), **{k: v for k, v in m.items() if k != "hidden"}, labels=np.array(SHARED), feature=np.array(cands[best][0]))
    common.write_report("voice_evaluation.json", rep)
    print("dev macro-F1:", {k: round(v, 3) for k, v in dev.items()}, "selected:", best, "train s:", rep["training_seconds_total"])
    for sname, r in results.items():
        print(f"== {sname}: {r['n']} clips, {r['speakers']} speakers")
        for k, mm in r["metrics"].items():
            print(f"  {k:22s} acc {mm['accuracy']:.3f}  bal-acc {mm['balanced_accuracy']:.3f}  macro-F1 {mm['macro_f1']:.3f}")
        print("  bootstrap (vs restricted baseline):", {k: v["ci95"] for k, v in r["bootstrap_by_speaker_macro_f1_diff"].items()})
        print("  per speaker:", r["per_speaker_accuracy"])
    print("neutral clips ->", rep["neutral_test_clips_labelled_by_model_as"])


if __name__ == "__main__":
    main()
