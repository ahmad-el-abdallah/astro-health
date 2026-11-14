"""Download the official MediaPipe Pose Landmarker (lite) model, once, and verify it.

    .venv/bin/python scripts/pose_analysis/download_model.py          (Windows: .venv\\Scripts\\python)

Source: Google's own MediaPipe model storage, the URL the MediaPipe Pose Landmarker guide
links to (https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker), pinned to
model version 1 (float16) instead of "latest", so every machine gets the same file. The LITE
variant is used: the smallest and fastest of the three (lite / full / heavy), for the CPU.
Destination: models/pose_analysis/pose_landmarker_lite.task (gitignored, like models/ itself).

Same safety as scripts/face_analysis/download_model.py: safe to run again, the download goes
to a temporary file and only replaces the destination once it has passed every check
(Content-Length, Google's own MD5, a valid .task bundle with both TFLite models). Nothing is
uploaded.
"""
import base64
import hashlib
import os
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile

MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task"
OFFICIAL_HOST = "storage.googleapis.com"
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MODEL_PATH = os.path.join(REPO, "models", "pose_analysis", "pose_landmarker_lite.task")
# A .task file is a zip bundle of these TFLite models (checked, not assumed).
EXPECTED_MEMBERS = ("pose_detector.tflite", "pose_landmarks_detector.tflite")
MIN_BYTES = 1_000_000
# The version-1 file as first verified on 2026-11-14 (matched Google's own MD5 for it).
KNOWN_SHA256 = "59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a"
TIMEOUT_S = 60


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def check(path):
    """(ok, message) -- is this a complete, valid Pose Landmarker bundle?"""
    if not os.path.isfile(path):
        return False, "missing"
    size = os.path.getsize(path)
    if size < MIN_BYTES:
        return False, f"too small ({size} bytes)"
    if not zipfile.is_zipfile(path):
        return False, "not a .task bundle (not a zip archive)"
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        bad = z.testzip()
    if bad:
        return False, f"corrupt member {bad}"
    missing = [m for m in EXPECTED_MEMBERS if m not in names]
    if missing:
        return False, f"missing {', '.join(missing)} (has: {', '.join(names)})"
    return True, f"{size:,} bytes, contains {', '.join(names)}"


def download():
    if urllib.request.urlparse(MODEL_URL).hostname != OFFICIAL_HOST:
        raise SystemExit("refusing: the model URL is not Google's official MediaPipe storage")
    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix="pose_landmarker.", suffix=".part", dir=os.path.dirname(MODEL_PATH))
    try:
        req = urllib.request.Request(MODEL_URL, headers={"User-Agent": "astro-health-setup/1.0"})
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r, os.fdopen(fd, "wb") as out:
            if r.status != 200:
                raise RuntimeError(f"HTTP {r.status}")
            expected = int(r.headers.get("Content-Length") or 0)
            google_md5 = next((v.split("=", 1)[1] for v in (r.headers.get_all("x-goog-hash") or []) if v.startswith("md5=")), None)
            md5 = hashlib.md5()
            got = 0
            for block in iter(lambda: r.read(1 << 16), b""):
                out.write(block)
                md5.update(block)
                got += len(block)
        if expected and got != expected:
            raise RuntimeError(f"incomplete download: {got} of {expected} bytes")
        if google_md5 and base64.b64encode(md5.digest()).decode() != google_md5:
            raise RuntimeError("the file doesn't match the MD5 Google's storage reports for it")
        ok, msg = check(tmp)
        if not ok:
            raise RuntimeError(f"downloaded file failed the check: {msg}")
        os.replace(tmp, MODEL_PATH)
        return msg
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def main():
    ok, msg = check(MODEL_PATH)
    if ok:
        print(f"already present: {MODEL_PATH}\n  {msg}\n  sha256 {sha256_of(MODEL_PATH)}")
        return 0
    if os.path.exists(MODEL_PATH):
        print(f"existing file is not valid ({msg}); downloading a fresh copy")
    print(f"downloading {MODEL_URL}")
    try:
        msg = download()
    except urllib.error.HTTPError as e:
        print(f"download failed: HTTP {e.code} {e.reason}")
        return 1
    except urllib.error.URLError as e:
        print(f"download failed: network error ({e.reason}) -- check the internet connection and try again")
        return 1
    except (OSError, RuntimeError) as e:
        print(f"download failed: {e}")
        return 1
    digest = sha256_of(MODEL_PATH)
    print(f"saved {MODEL_PATH}\n  {msg}\n  matches Google's MD5 for it\n  sha256 {digest}"
          + ("" if not KNOWN_SHA256 or digest == KNOWN_SHA256 else "\n  note: differs from the copy verified on 2026-11-14 (Google may have published a new version 1 file)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
