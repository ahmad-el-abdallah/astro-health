"""Voice regression check on ENGLISH speech: does the new head (trained on Italian
Emozionalmente) make English worse than the production model?

    .venv/Scripts/python scripts/training/voice_crema_check.py   (after voice_train_eval.py)

CREMA-D (ODbL 1.0 / DbCL 1.0, github.com/CheyneyComputerScience/CREMA-D) WAVs for 10 randomly
chosen actors, every clip of the 5 emotions shared with the model (anger, disgust, fear, happy,
sad; CREMA-D has no surprise). CREMA-D was part of the production model's training data, so the
BASELINE number here is optimistic (possibly memorised); the head never saw CREMA-D. This is
not a fair accuracy test of the baseline -- it only answers "would the head hurt English?".
"""
import concurrent.futures as cf
import io
import json
import os
import sys
import time
import wave

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402
from voice_features import MID_LAYER, MODEL_DIR  # noqa: E402

TREE = "https://api.github.com/repos/CheyneyComputerScience/CREMA-D/git/trees/master?recursive=1"
MEDIA = "https://media.githubusercontent.com/media/CheyneyComputerScience/CREMA-D/master/{}"
RAW = os.path.join(common.TRAINING, "voice", "raw", "crema_d_subset")
EMO = {"ANG": "angry", "DIS": "disgust", "FEA": "fearful", "HAP": "happy", "SAD": "sad"}
SHARED = ["angry", "disgust", "fearful", "happy", "sad", "surprised"]
MODEL_LABELS = ["angry", "calm", "disgust", "fearful", "happy", "sad", "surprised"]
N_ACTORS = 10


def main():
    import torch
    from transformers import Wav2Vec2FeatureExtractor, Wav2Vec2ForSequenceClassification
    torch.set_num_threads(4)
    os.makedirs(RAW, exist_ok=True)
    tree = json.loads(common.http_get(TREE))
    wavs = [x["path"] for x in tree["tree"] if x["path"].startswith("AudioWAV/") and x["path"].endswith(".wav")]
    actors = sorted({os.path.basename(p).split("_")[0] for p in wavs})
    rng = np.random.default_rng(common.SEED)
    chosen = set(rng.choice(actors, size=N_ACTORS, replace=False).tolist())
    pick = [p for p in wavs if os.path.basename(p).split("_")[0] in chosen and os.path.basename(p).split("_")[2] in EMO]

    def dl(p):
        out = os.path.join(RAW, os.path.basename(p))
        if not os.path.isfile(out) or os.path.getsize(out) < 1000:
            data = common.http_get(MEDIA.format(p), timeout=60)
            with open(out, "wb") as f:
                f.write(data)
        return out
    with cf.ThreadPoolExecutor(6) as ex:
        paths = list(ex.map(dl, pick))
    extractor = Wav2Vec2FeatureExtractor.from_pretrained(MODEL_DIR, local_files_only=True)
    model = Wav2Vec2ForSequenceClassification.from_pretrained(MODEL_DIR, local_files_only=True).eval()
    head = dict(np.load(os.path.join(common.CANDIDATES, "voice_mid_lr.npz"), allow_pickle=False))
    head["hidden"] = 0
    y, base, cand, spk, rejected, seen = [], [], [], [], [], set()
    t0 = time.time()
    for path in paths:
        name = os.path.basename(path)
        try:
            with wave.open(path, "rb") as w:
                ch, width, rate = w.getnchannels(), w.getsampwidth(), w.getframerate()
                pcm = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")
        except Exception as e:  # noqa: BLE001
            rejected.append(f"{name}: unreadable ({type(e).__name__})")
            continue
        if ch != 1 or width != 2 or rate != 16000 or len(pcm) < 16000:
            rejected.append(f"{name}: {rate} Hz / {ch} ch / {len(pcm) / 16000:.2f} s")
            continue
        h = common.sha1_bytes(pcm.tobytes())
        if h in seen:
            rejected.append(f"{name}: duplicate audio")
            continue
        seen.add(h)
        inputs = extractor(pcm.astype(np.float32) / 32768.0, sampling_rate=16000, return_tensors="pt")
        with torch.inference_mode():
            out = model(**inputs, output_hidden_states=True)
        logits = out.logits[0].numpy()
        mid = out.hidden_states[MID_LAYER][0].mean(0).numpy()
        y.append(SHARED.index(EMO[name.split("_")[2]]))
        base.append(int(np.argmax(logits[[MODEL_LABELS.index(l) for l in SHARED]])))
        cand.append(int(common.head_predict_proba(head, mid[None])[0].argmax()))
        spk.append(name.split("_")[0])
    labels5 = SHARED[:5]
    y, base, cand, spk = map(np.array, (y, base, cand, spk))
    # 'surprised' predictions fall outside the 5 CREMA-D labels: count them as wrong (-1)
    b5 = np.where(base == 5, -1, base)
    c5 = np.where(cand == 5, -1, cand)
    rep = {"dataset": "CREMA-D (ODbL 1.0 / DbCL 1.0)", "actors": sorted(chosen), "clips": int(len(y)), "rejected": rejected,
           "seconds": round(time.time() - t0, 1),
           "warning": "CREMA-D was in the production model's training data: the baseline here may be memorised (optimistic). Use only as a regression check for the head.",
           "baseline_restricted": common.metrics(y, b5, labels5), "candidate_mid_lr": common.metrics(y, c5, labels5),
           "bootstrap_by_speaker_macro_f1_diff": common.bootstrap_diff(y, b5, c5, labels5, n=500, groups=spk)}
    common.write_report("voice_crema_regression_check.json", rep)
    common.record("voice_crema_d_subset", {
        "name": "CREMA-D (10-actor subset, 5 emotions) -- regression check only",
        "source": "https://github.com/CheyneyComputerScience/CREMA-D (AudioWAV via media.githubusercontent.com)",
        "publication": "Cao et al., 'CREMA-D: Crowd-sourced Emotional Multimodal Actors Dataset', IEEE Trans. Affective Computing 2014",
        "license": "Open Database License 1.0; contents: Database Contents License 1.0 (LICENSE.txt in the repository)",
        "commercial_or_demo_use": "allowed (ODbL share-alike applies to redistributed databases; nothing is redistributed here)",
        "version": "GitHub master",
        "downloaded": common.now_iso(),
        "samples_downloaded": len(pick), "samples_usable": int(len(y)), "rejected": rejected,
        "subject_ids": f"actor ids in file names; {N_ACTORS} actors",
        "role": "English regression check for the voice head only; NOT a fair baseline test (the production model was trained on CREMA-D)",
    })
    print(json.dumps({k: rep[k] for k in ("clips", "rejected", "seconds", "bootstrap_by_speaker_macro_f1_diff")}, indent=1))
    for k in ("baseline_restricted", "candidate_mid_lr"):
        m = rep[k]
        print(f"{k:22s} acc {m['accuracy']:.3f} macro-F1 {m['macro_f1']:.3f}", {c: v["f1"] for c, v in m["per_class"].items()})


if __name__ == "__main__":
    main()
