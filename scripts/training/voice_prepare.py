"""Voice data: Emozionalmente (Italian, CC BY 4.0), validated and split by speaker.

    .venv/Scripts/python scripts/training/voice_prepare.py

Why this corpus: the app's voice model (Dpngtm/wav2vec2-emotion-recognition) was fine-tuned on
RAVDESS, TESS, CREMA-D and SAVEE (its model card), so none of those can test it fairly -- any
of their clips may have been in its training data. Emozionalmente is independent of all four,
has a clear license (CC BY 4.0, Zenodo 10.5281/zenodo.12616095), 431 speakers with ids, an
official speaker-independent train/dev/test split, 16 kHz mono 16-bit WAV (the app's own input
format), five human ratings per clip, and six of the model's seven labels.

Caveats, kept in every report: it is Italian (the model is English-trained), acted (simulated
emotion, not real feelings), mostly amateur microphones. Its 'neutral' has no model
equivalent ('calm' is not the same thing), so the main comparison uses the six shared labels.

Only the verified archive is read (WAVs are read in memory from the zip, never re-encoded).
Nothing here says anything about anyone's health or psychological state: these are acted
emotional speaking styles.
"""
import csv
import io
import json
import os
import sys
import wave
import zipfile
from collections import Counter

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

ZIP = os.path.join(common.TRAINING, "voice", "raw", "emozionalmente.zip")
ZIP_MD5 = "398c6502dd2b0e1e810f927c12897547"  # Zenodo's checksum for record 12616095
PROC = os.path.join(common.TRAINING, "voice", "processed")
# dataset label -> the app model's label (None = no equivalent)
TO_MODEL = {"anger": "angry", "disgust": "disgust", "fear": "fearful", "joy": "happy", "sadness": "sad", "surprise": "surprised", "neutrality": None}
TRAIN_PER_CLASS = 350  # a representative subset of the official train split; dev and test are used in full


def read_csv(z, name):
    return list(csv.DictReader(io.StringIO(z.read("emozionalmente/metadata/" + name).decode("utf-8-sig"))))


def main():
    os.makedirs(PROC, exist_ok=True)
    digest = common.md5_of(ZIP)
    if digest != ZIP_MD5:
        raise SystemExit(f"archive checksum mismatch: {digest}")
    z = zipfile.ZipFile(ZIP)
    if z.testzip() is not None:
        raise SystemExit("corrupt archive member")
    samples = {r["file_name"]: r for r in read_csv(z, "samples.csv")}
    split_of = {}
    for split in ("train", "dev", "test"):
        for r in read_csv(z, f"split/{split}.csv"):
            split_of[r["file_name"]] = split
    votes, quality = {}, {}
    for r in read_csv(z, "evaluations.csv"):
        votes.setdefault(r["file_name"], []).append(r["emotion_recognized"])
        quality.setdefault(r["file_name"], []).append(r["audio_quality"])

    # speaker leakage check on the official split
    spk_split = {}
    for f, split in split_of.items():
        spk_split.setdefault(samples[f]["actor"], set()).add(split)
    leaking = [s for s, v in spk_split.items() if len(v) > 1]

    rows, rejected, seen = [], [], {}
    for f, s in samples.items():
        info = f"emozionalmente/audio/{f}"
        try:
            data = z.read(info)
            with wave.open(io.BytesIO(data), "rb") as w:
                ch, width, rate, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
                pcm = np.frombuffer(w.readframes(n), dtype="<i2")
        except Exception as e:  # noqa: BLE001
            rejected.append({"file": f, "reason": f"unreadable ({type(e).__name__})"})
            continue
        if ch != 1 or width != 2 or rate != 16000:
            rejected.append({"file": f, "reason": f"format {rate} Hz / {ch} ch / {width * 8}-bit"})
            continue
        dur = len(pcm) / 16000
        if dur < 1.0 or dur > 15.0:  # the app's own accepted range (backend/services/emotion.py)
            rejected.append({"file": f, "reason": f"duration {dur:.2f} s outside 1-15 s"})
            continue
        if not np.any(pcm) or np.abs(pcm).max() < 100:
            rejected.append({"file": f, "reason": "silent"})
            continue
        h = common.sha1_bytes(pcm.tobytes())
        if h in seen:
            rejected.append({"file": f, "reason": f"duplicate audio of {seen[h]}"})
            continue
        seen[h] = f
        v = votes.get(f, [])
        agree = sum(1 for x in v if x == s["emotion_expressed"]) / len(v) if v else None
        majority = Counter(v).most_common(1)[0][0] if v else None
        rows.append({
            "file": f, "speaker": s["actor"], "label": s["emotion_expressed"], "split": split_of.get(f),
            "duration_s": round(dur, 2), "rater_agreement": None if agree is None else round(agree, 2),
            "rater_majority": majority, "raters": len(v),
            "bad_quality_votes": sum(1 for q in quality.get(f, []) if q != "good"),
        })
    rows = [r for r in rows if r["split"]]
    rng = np.random.default_rng(common.SEED)
    train = [r for r in rows if r["split"] == "train"]
    keep = []
    for lab in TO_MODEL:
        pool = [r for r in train if r["label"] == lab]
        keep += [pool[i] for i in sorted(rng.choice(len(pool), size=min(TRAIN_PER_CLASS, len(pool)), replace=False))]
    selected = keep + [r for r in rows if r["split"] in ("dev", "test")]
    for r in selected:
        r["validated"] = r["rater_agreement"] is not None and r["rater_agreement"] >= 0.6  # 3+ of 5 raters heard the intended emotion
    with open(os.path.join(PROC, "clips.json"), "w", encoding="utf-8") as fh:
        json.dump(selected, fh)

    def summary(rs):
        return {"clips": len(rs), "speakers": len({r["speaker"] for r in rs}), "per_class": dict(Counter(r["label"] for r in rs)),
                "validated_3of5": sum(1 for r in rs if r.get("validated"))}
    stats = {split: summary([r for r in selected if r["split"] == split]) for split in ("train", "dev", "test")}
    agree_all = [r["rater_agreement"] for r in rows if r["rater_agreement"] is not None]
    report = {
        "archive_md5_ok": True, "archive_members_ok": True,
        "clips_in_archive": len(samples), "usable": len(rows), "rejected": rejected,
        "official_split_speaker_leakage": leaking,
        "full_corpus_per_class": dict(Counter(r["label"] for r in rows)),
        "full_corpus_speakers": len({r["speaker"] for r in rows}),
        "rater_agreement_mean": round(float(np.mean(agree_all)), 3),
        "rater_agreement_per_class": {lab: round(float(np.mean([r["rater_agreement"] for r in rows if r["label"] == lab and r["rater_agreement"] is not None])), 3) for lab in TO_MODEL},
        "selected": stats,
        "duration_s": {"mean": round(float(np.mean([r["duration_s"] for r in rows])), 2), "max": max(r["duration_s"] for r in rows)},
    }
    common.write_report("voice_data_validation.json", report)
    common.record("voice_emozionalmente", {
        "name": "Emozionalmente: a crowdsourced Italian speech emotional corpus",
        "source": "https://zenodo.org/records/12616095 (also OpenSLR 161)",
        "doi": "10.5281/zenodo.12616095",
        "publication": "F. Catania, J. W. Wilke, F. Garzotto, 'Emozionalmente: a crowdsourced Italian speech emotional corpus', IEEE/ACM TASLP 2025 (DOI 10.1109/TASLPRO.2025.3540662)",
        "license": "CC BY 4.0 (Zenodo record metadata)",
        "commercial_or_demo_use": "allowed with attribution",
        "version": "1.1 (2024-07-01)",
        "downloaded": common.now_iso(),
        "archive": {"file": "voice/raw/emozionalmente.zip", "bytes": os.path.getsize(ZIP), "md5": digest, "md5_matches_zenodo": True},
        "samples_downloaded": len(samples),
        "samples_usable": len(rows),
        "samples_selected": len(selected),
        "rejected": len(rejected),
        "subject_ids": "hashed actor ids; the official split is speaker-independent" + (f" (but {len(leaking)} speakers appear in two splits)" if leaking else " (verified: no speaker in two splits)"),
        "why_this_dataset": "The app's model was trained on RAVDESS, TESS, CREMA-D and SAVEE, so those can't evaluate it fairly; this corpus is independent.",
        "caveats": ["Italian speech; the model is English-trained", "acted emotions, amateur microphones", "'neutral' has no equivalent in the model's labels"],
    })
    print(json.dumps({k: report[k] for k in ("clips_in_archive", "usable", "official_split_speaker_leakage", "rater_agreement_mean", "selected")}, indent=1)[:1500])
    print("rejected:", len(rejected), Counter(r["reason"].split(" ")[0] for r in rejected))


if __name__ == "__main__":
    main()
