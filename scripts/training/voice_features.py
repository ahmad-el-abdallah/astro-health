"""Voice features: run the app's own model (models/wav2vec2-emotion, unchanged) on the selected
Emozionalmente clips, exactly as backend/services/emotion.py does (same feature extractor, same
16 kHz floats), and keep per clip:

  logits      the 7 production logits -> the BASELINE predictions
  pooled      the model's own 256-d pooled vector (projector output averaged over time) -- the
              exact input of its final classifier layer
  hid_last    the 768-d time-average of the last transformer layer
  hid_mid     the 768-d time-average of transformer layer 8 (mid-level features)

    .venv/Scripts/python scripts/training/voice_features.py

Resumable: results are saved every 250 clips to data/training/voice/processed/features.npz.
CPU only, torch threads limited to 4. The model weights are only read, never written.
"""
import io
import json
import os
import sys
import time
import wave
import zipfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
MODEL_DIR = os.path.join(common.REPO, "models", "wav2vec2-emotion")
ZIP = os.path.join(common.TRAINING, "voice", "raw", "emozionalmente.zip")
PROC = os.path.join(common.TRAINING, "voice", "processed")
OUT = os.path.join(PROC, "features.npz")
THREADS = 4
MID_LAYER = 8


def main():
    import torch
    from transformers import Wav2Vec2FeatureExtractor, Wav2Vec2ForSequenceClassification
    torch.set_num_threads(THREADS)
    clips = json.load(open(os.path.join(PROC, "clips.json"), encoding="utf-8"))
    files = [c["file"] for c in clips]
    done = {}
    if os.path.isfile(OUT):
        old = np.load(OUT, allow_pickle=False)
        for i, f in enumerate(old["files"]):
            done[str(f)] = {k: old[k][i] for k in ("logits", "pooled", "hid_last", "hid_mid")}
    extractor = Wav2Vec2FeatureExtractor.from_pretrained(MODEL_DIR, local_files_only=True)
    model = Wav2Vec2ForSequenceClassification.from_pretrained(MODEL_DIR, local_files_only=True).eval()
    assert not getattr(model.config, "use_weighted_layer_sum", False)
    z = zipfile.ZipFile(ZIP)
    t0, n_new = time.time(), 0

    def save():
        keep = [f for f in files if f in done]
        np.savez(OUT, files=np.array(keep), **{k: np.stack([done[f][k] for f in keep]) for k in ("logits", "pooled", "hid_last", "hid_mid")})

    for f in files:
        if f in done:
            continue
        with wave.open(io.BytesIO(z.read(f"emozionalmente/audio/{f}")), "rb") as w:
            pcm = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")
        samples = pcm.astype(np.float32) / 32768.0  # same scaling as emotion.decode_wav
        inputs = extractor(samples, sampling_rate=16000, return_tensors="pt")
        with torch.inference_mode():
            out = model(**inputs, output_hidden_states=True)
            hs = out.hidden_states
            pooled = model.projector(hs[-1]).mean(dim=1)
            check = model.classifier(pooled)
        if not torch.allclose(check, out.logits, atol=1e-4):
            raise SystemExit("pooled vector doesn't reproduce the model's logits")
        done[f] = {"logits": out.logits[0].numpy(), "pooled": pooled[0].numpy(), "hid_last": hs[-1][0].mean(0).numpy(), "hid_mid": hs[MID_LAYER][0].mean(0).numpy()}
        n_new += 1
        if n_new % 250 == 0:
            save()
            el = time.time() - t0
            print(f"{len(done)}/{len(files)}  {el / n_new * 1000:.0f} ms/clip  ~{el / n_new * (len(files) - len(done)) / 60:.1f} min left", flush=True)
    save()
    el = time.time() - t0
    print(f"done: {len(done)} clips, {n_new} new in {el / 60:.1f} min ({el / max(n_new, 1) * 1000:.0f} ms/clip)")
    common.write_report("voice_features_run.json", {"clips": len(done), "new": n_new, "seconds": round(el, 1), "threads": THREADS,
                                                    "model_dir": "models/wav2vec2-emotion (unchanged)", "mid_layer": MID_LAYER})


if __name__ == "__main__":
    main()
