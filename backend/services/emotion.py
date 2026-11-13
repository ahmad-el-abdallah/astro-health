"""Voice tone estimates for "Wanna talk?": a Wav2Vec2 audio classifier that guesses one of
seven tones (angry, calm, disgust, fearful, happy, sad, surprised) from how a short spoken
phrase SOUNDS -- not from what was said.

Local only. The model runs on this laptop's CPU; the WAV clips the browser sends here are
analysed in memory and thrown away -- never stored, never sent to any other service. Only
the scores are saved (backend/routes/routes.py, `voice_tone` table). (The words themselves
still go through the browser's own speech recognition, which Chrome sends to Google and
Edge to Microsoft -- that's the existing Astra path, not this one.)

An estimate, not a diagnosis: it's a classifier trained on acted speech, so it never feeds
the health analysis, alerts, levels or self-reported mood.

Optional. Needs `pip install -r requirements-emotion.txt` (torch CPU + transformers) and
the model files (`python -m backend.services.emotion download`). Without either, status()
says why, the API answers 503, and the rest of the app works as before. Nothing here is
imported at app start except this module itself (torch/transformers load in a background
thread, so a missing install can't break startup).

Model: Dpngtm/wav2vec2-emotion-recognition (MIT), pinned to one revision and checked by
SHA-256, loaded with local_files_only=True -- the running app never goes online for it.
Preprocessing is the model's own Wav2Vec2FeatureExtractor (16 kHz mono, zero-mean /
unit-variance normalisation), the same as a plain `feature_extractor(audio,
sampling_rate=16000)` call in a notebook.

CLI:  python -m backend.services.emotion download | verify | bench | predict <file.wav>
"""
import array
import hashlib
import io
import json
import os
import sys
import threading
import time
import wave

from backend import config

MODEL_ID = "Dpngtm/wav2vec2-emotion-recognition"
MODEL_REVISION = "033a5751a5bbe5b0b67c2c71e6102c38de35a346"  # Hugging Face, 2026-01-20
MODEL_FILES = ("config.json", "model.safetensors", "preprocessor_config.json")
WEIGHTS_SHA256 = "19c9ffbfd4a6e75f15fa789e4b0c4c028af0b3ecb8bab4d6105321f77dc6a0d4"
LABELS = ("angry", "calm", "disgust", "fearful", "happy", "sad", "surprised")

SAMPLE_RATE = 16000
MIN_SECONDS = 1.0
MAX_SECONDS = 15.0
MAX_WAV_BYTES = 1024 * 1024  # 15 s of 16 kHz 16-bit mono is ~480 KB

MODEL_DIR = os.environ.get("ASTRO_EMOTION_MODEL_DIR") or os.path.join(config.BASE_DIR, "models", "wav2vec2-emotion")
# Leave cores for Flask/Socket.IO (and Vite while developing). Tuned by `bench`.
THREADS = int(os.environ.get("ASTRO_EMOTION_THREADS") or max(1, min(4, (os.cpu_count() or 2) // 2)))


class ToneError(ValueError):
    """The audio itself is unusable (wrong format, too short/long) -> HTTP 400."""


class Unavailable(RuntimeError):
    """The model isn't loaded (not installed, no files, still loading, failed) -> HTTP 503."""


_state = {"state": "idle", "reason": ""}
_model = None
_extractor = None
_infer_lock = threading.Lock()  # one analysis at a time: predictable CPU use
_load_lock = threading.Lock()


def status():
    """{state, reason, model, revision}. state: idle | loading | ready | missing-deps |
    missing-model | error | disabled."""
    return {**_state, "model": MODEL_ID, "revision": MODEL_REVISION[:12]}


def is_ready():
    return _state["state"] == "ready"


def _set(state, reason=""):
    _state["state"] = state
    _state["reason"] = reason


def missing_files(model_dir=None):
    d = model_dir or MODEL_DIR
    return [f for f in MODEL_FILES if not os.path.isfile(os.path.join(d, f))]


def start_loading():
    """Load the model once, in a background thread (it takes a few seconds and ~1 GB of
    RAM). Tests and anyone who doesn't want it set ASTRO_NO_EMOTION=1."""
    if os.environ.get("ASTRO_NO_EMOTION") == "1":
        _set("disabled", "turned off (ASTRO_NO_EMOTION=1)")
        return
    if _state["state"] in ("loading", "ready"):
        return
    _set("loading", "loading the model")
    threading.Thread(target=load, name="emotion-load", daemon=True).start()


def load(model_dir=None):
    """Load (or reload) the model synchronously; sets and returns status()."""
    global _model, _extractor
    with _load_lock:
        d = model_dir or MODEL_DIR
        # Never online at runtime: Hugging Face's offline switches, set before transformers /
        # huggingface_hub are first imported (they read them then), on top of
        # local_files_only=True below. setdefault: `download` (a separate process) is unaffected.
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
        try:
            import torch
            from transformers import Wav2Vec2FeatureExtractor, Wav2Vec2ForSequenceClassification
            from transformers.utils import logging as hf_logging

            hf_logging.disable_progress_bar()  # no "Loading weights" bar in the server terminal
        except ImportError as e:
            _set("missing-deps", f"install requirements-emotion.txt ({e.name or e})")
            return status()
        missing = missing_files(d)
        if missing:
            _set("missing-model", "run: python -m backend.services.emotion download")
            return status()
        try:
            _set("loading", "loading the model")
            torch.set_num_threads(THREADS)
            extractor = Wav2Vec2FeatureExtractor.from_pretrained(d, local_files_only=True)
            model = Wav2Vec2ForSequenceClassification.from_pretrained(d, local_files_only=True)
            model.eval()
            labels = tuple(model.config.id2label[i] for i in range(model.config.num_labels))
            if labels != LABELS:
                _set("error", f"unexpected labels {labels}")
                return status()
            if extractor.sampling_rate != SAMPLE_RATE:
                _set("error", f"unexpected sampling rate {extractor.sampling_rate}")
                return status()
            _extractor, _model = extractor, model
            _predict_samples([0.0] * SAMPLE_RATE)  # warm-up: the first real call isn't slow
            _set("ready", "")
        except Exception as e:  # noqa: BLE001 -- any failure means "not available", never a crash
            _model = _extractor = None
            _set("error", f"{type(e).__name__}: {e}"[:300])
        return status()


def decode_wav(data):
    """Bytes of a 16 kHz, mono, 16-bit PCM WAV -> list of floats in [-1, 1].
    Standard library only, so it works (and is tested) without numpy/torch."""
    if not data:
        raise ToneError("no audio")
    if len(data) > MAX_WAV_BYTES:
        raise ToneError("audio too large")
    try:
        with wave.open(io.BytesIO(data), "rb") as w:
            channels, width, rate, frames = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
            raw = w.readframes(frames)
    except (wave.Error, EOFError) as e:
        raise ToneError(f"not a valid WAV file ({e})") from None
    if channels != 1 or width != 2 or rate != SAMPLE_RATE:
        raise ToneError(f"expected 16 kHz mono 16-bit WAV, got {rate} Hz, {channels} channel(s), {width * 8}-bit")
    pcm = array.array("h")
    pcm.frombytes(raw[: len(raw) // 2 * 2])
    if sys.byteorder == "big":
        pcm.byteswap()
    seconds = len(pcm) / SAMPLE_RATE
    if seconds < MIN_SECONDS:
        raise ToneError(f"too short ({seconds:.1f} s, need {MIN_SECONDS:.0f} s)")
    if seconds > MAX_SECONDS + 0.05:
        raise ToneError(f"too long ({seconds:.1f} s, max {MAX_SECONDS:.0f} s)")
    return [s / 32768.0 for s in pcm]


def _predict_samples(samples):
    import numpy as np
    import torch

    inputs = _extractor(np.asarray(samples, dtype=np.float32), sampling_rate=SAMPLE_RATE, return_tensors="pt")
    with _infer_lock, torch.inference_mode():
        logits = _model(**inputs).logits[0]
    probs = torch.softmax(logits, dim=-1).tolist()
    return {lab: float(p) for lab, p in zip(LABELS, probs)}


def predict(samples):
    """Floats at 16 kHz -> {label, confidence, scores, duration_s, ms}."""
    if not is_ready():
        raise Unavailable(_state["reason"] or _state["state"])
    t0 = time.perf_counter()
    scores = _predict_samples(samples)
    label = max(scores, key=scores.get)
    return {
        "label": label,
        "confidence": round(scores[label], 4),
        "scores": {k: round(v, 4) for k, v in scores.items()},
        "duration_s": round(len(samples) / SAMPLE_RATE, 2),
        "ms": round((time.perf_counter() - t0) * 1000),
    }


def analyze_wav(data):
    """The API's entry point: validate the WAV, then predict. Raises ToneError/Unavailable."""
    if not is_ready():
        raise Unavailable(_state["reason"] or _state["state"])
    return predict(decode_wav(data))


# ---------------------------------------------------------------------------- CLI helpers

def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def verify(model_dir=None):
    """True if every file is there and the weights match the pinned SHA-256."""
    d = model_dir or MODEL_DIR
    missing = missing_files(d)
    if missing:
        print(f"missing in {d}: {', '.join(missing)}")
        return False
    digest = sha256_of(os.path.join(d, "model.safetensors"))
    ok = digest == WEIGHTS_SHA256
    print(f"model.safetensors sha256 {digest} -> {'OK' if ok else 'MISMATCH (expected ' + WEIGHTS_SHA256 + ')'}")
    return ok


def download(model_dir=None):
    """Fetch only the 3 inference files, at the pinned revision, into models/wav2vec2-emotion/."""
    from huggingface_hub import hf_hub_download

    d = model_dir or MODEL_DIR
    os.makedirs(d, exist_ok=True)
    for name in MODEL_FILES:
        hf_hub_download(MODEL_ID, name, revision=MODEL_REVISION, local_dir=d)
        print(f"  {name}")
    with open(os.path.join(d, "SOURCE.json"), "w", encoding="utf-8") as f:
        json.dump({"model": MODEL_ID, "revision": MODEL_REVISION, "files": list(MODEL_FILES)}, f, indent=2)
    return verify(d)


def read_any_wav(path):
    """For the CLI only (e.g. the Kaggle test clip): any PCM WAV -> 16 kHz mono floats.
    Channels are averaged; other rates are resampled with an FFT (close to, not bit-identical
    with, librosa's resampler -- export a 16 kHz copy from the notebook for an exact match)."""
    import numpy as np

    with wave.open(path, "rb") as w:
        channels, width, rate, frames = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(frames)
    dtype = {1: np.uint8, 2: np.int16, 4: np.int32}.get(width)
    if dtype is None:
        raise ToneError(f"{width * 8}-bit WAV not supported here")
    x = np.frombuffer(raw, dtype=dtype).astype(np.float64)
    x = (x - 128) / 128 if width == 1 else x / float(2 ** (8 * width - 1))
    x = x.reshape(-1, channels).mean(axis=1)
    if rate != SAMPLE_RATE:
        n = int(round(len(x) * SAMPLE_RATE / rate))
        spec = np.fft.rfft(x)
        keep = n // 2 + 1
        spec = spec[:keep] if len(spec) >= keep else np.pad(spec, (0, keep - len(spec)))
        x = np.fft.irfft(spec, n) * (n / len(x))
    return x.astype(np.float32).tolist(), rate, channels


def _rss_mb():
    try:
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes

            class PMC(ctypes.Structure):
                _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
                    (n, ctypes.c_size_t) for n in ("PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage",
                                                   "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage",
                                                   "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage")]
            c = PMC()
            c.cb = ctypes.sizeof(PMC)
            kernel = ctypes.WinDLL("kernel32")
            kernel.GetCurrentProcess.restype = wintypes.HANDLE
            info = kernel.K32GetProcessMemoryInfo
            info.argtypes = [wintypes.HANDLE, ctypes.POINTER(PMC), wintypes.DWORD]
            info.restype = wintypes.BOOL
            if not info(kernel.GetCurrentProcess(), ctypes.byref(c), c.cb):
                return float("nan")
            return c.WorkingSetSize / 2**20
        import resource
        return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    except Exception:  # noqa: BLE001
        return float("nan")


def bench(runs=5):
    """Real CPU timings: load time, memory, and latency per clip length and thread count.
    Uses speech-shaped noise -- latency depends on length, not content."""
    import random
    import statistics

    import torch

    before = _rss_mb()
    t0 = time.perf_counter()
    st = load()
    if st["state"] != "ready":
        print("not ready:", st)
        return
    print(f"load {time.perf_counter() - t0:.1f} s, memory +{_rss_mb() - before:.0f} MB "
          f"(process {_rss_mb():.0f} MB), cpu_count {os.cpu_count()}")
    rnd = random.Random(1)
    for threads in sorted({1, 2, 4, THREADS}):
        torch.set_num_threads(threads)
        for seconds in (2, 5, 10, 15):
            clip = [0.1 * rnd.uniform(-1, 1) * (0.5 + 0.5 * abs(((i / 800) % 2) - 1)) for i in range(SAMPLE_RATE * seconds)]
            times = []
            for _ in range(runs):
                times.append(predict(clip)["ms"])
            print(f"threads {threads}  clip {seconds:>2} s  median {statistics.median(times):>5.0f} ms  max {max(times):>5.0f} ms")
    torch.set_num_threads(THREADS)


def _main(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "download":
        print(f"downloading {MODEL_ID} @ {MODEL_REVISION[:12]} -> {MODEL_DIR}")
        return 0 if download() else 1
    if cmd == "verify":
        return 0 if verify() else 1
    if cmd == "bench":
        bench()
        return 0
    if cmd == "predict" and len(argv) > 2:
        st = load()
        if st["state"] != "ready":
            print("not ready:", st)
            return 1
        samples, rate, channels = read_any_wav(argv[2])
        print(f"{argv[2]}: {rate} Hz, {channels} channel(s), {len(samples) / SAMPLE_RATE:.2f} s at 16 kHz")
        r = predict(samples)  # the CLI allows any length (the API caps at 15 s)
        print(json.dumps(r, indent=2))
        return 0
    print(__doc__.split("CLI:")[1].strip())
    return 2


if __name__ == "__main__":
    sys.exit(_main(sys.argv))
