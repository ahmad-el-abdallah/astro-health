"""Face Analysis: MediaPipe Face Landmarker in VIDEO mode, run on THIS laptop.

The browser shows the live camera preview and sends one small JPEG frame at a time (about 10
per second, during a 10–15 s observation window) to this laptop's own backend. Each frame is
decoded in memory, run through the model, measured (backend/logic/face_metrics.py) and then
dropped: no image, video or landmark list is ever stored or sent anywhere. Only the final
report (numbers and text) is saved. No audio is involved.

One Face Landmarker per observation session (VIDEO mode needs its own increasing timestamps),
closed when the session finishes, is cancelled, or goes quiet for SESSION_IDLE_S.

Optional, like the voice tone model: needs requirements-face.txt and
models/face_analysis/face_landmarker.task (scripts/face_analysis/download_model.py). Without
them status() says why, the API answers 503, and nothing else in the app changes.
"""
import os
import threading
import time
import uuid

from backend import config
from backend.logic import face_metrics

MODEL_PATH = os.environ.get("ASTRO_FACE_MODEL") or os.path.join(config.BASE_DIR, "models", "face_analysis", "face_landmarker.task")
MAX_SESSIONS = 2
SESSION_IDLE_S = 30
MAX_WINDOW_S = 20.0
MAX_FRAMES = 400
MAX_FRAME_BYTES = 1024 * 1024
MAX_FRAME_SIDE = 1280
MODEL_NAME = "MediaPipe Face Landmarker (float16 v1)"


class FaceError(ValueError):
    """Bad input (not a JPEG, too big, session full) -> HTTP 400/409."""


class Unavailable(RuntimeError):
    """MediaPipe or the model isn't available -> HTTP 503."""


_state = {"state": "idle", "reason": ""}
_libs = {}
_sessions = {}
_lock = threading.Lock()


def _set(state, reason=""):
    _state["state"], _state["reason"] = state, reason


def status():
    return dict(_state)


def is_ready():
    return _state["state"] == "ready"


def check():
    """Import MediaPipe/OpenCV/NumPy and check the model file (no model is loaded here)."""
    if os.environ.get("ASTRO_NO_FACE") == "1":
        _set("disabled", "turned off (ASTRO_NO_FACE=1)")
        return status()
    try:
        import cv2
        import mediapipe as mp
        import numpy as np
        from mediapipe.tasks import python as mp_tasks
        from mediapipe.tasks.python import vision
    except ImportError as e:
        _set("missing-deps", f"install requirements-face.txt ({e.name or e})")
        return status()
    if not os.path.isfile(MODEL_PATH) or os.path.getsize(MODEL_PATH) < 1_000_000:
        _set("missing-model", "run: python scripts/face_analysis/download_model.py")
        return status()
    _libs.update(cv2=cv2, mp=mp, np=np, tasks=mp_tasks, vision=vision)
    _set("ready", "")
    return status()


def start_checking():
    """At app start, in the background (importing MediaPipe takes a moment)."""
    if os.environ.get("ASTRO_NO_FACE") == "1":
        _set("disabled", "turned off (ASTRO_NO_FACE=1)")
        return
    _set("loading", "checking")
    threading.Thread(target=check, name="face-check", daemon=True).start()


class _Session:
    def __init__(self, astronaut_id):
        self.id = "face-" + uuid.uuid4().hex
        self.astronaut_id = astronaut_id
        self.started = time.monotonic()
        self.last = self.started
        self.frames = []
        self.last_ts = -1
        self.lock = threading.Lock()
        v, t = _libs["vision"], _libs["tasks"]
        options = v.FaceLandmarkerOptions(
            base_options=t.BaseOptions(model_asset_path=MODEL_PATH),
            running_mode=v.RunningMode.VIDEO,
            num_faces=2,  # 2, so "more than one face in view" can be detected and reported
            output_face_blendshapes=False,  # not used: expression scores aren't measurements
            output_facial_transformation_matrixes=True,
        )
        self.landmarker = v.FaceLandmarker.create_from_options(options)

    def close(self):
        try:
            self.landmarker.close()
        except Exception:  # noqa: BLE001
            pass


def _sweep():
    now = time.monotonic()
    for sid in [sid for sid, s in _sessions.items() if now - s.last > SESSION_IDLE_S]:
        _sessions.pop(sid).close()


def start_session(astronaut_id):
    if not is_ready():
        raise Unavailable(_state["reason"] or _state["state"])
    with _lock:
        _sweep()
        for sid in [sid for sid, s in _sessions.items() if s.astronaut_id == astronaut_id]:
            _sessions.pop(sid).close()  # one observation per astronaut at a time (a retake replaces it)
        if len(_sessions) >= MAX_SESSIONS:
            raise FaceError("another face analysis is running")
        s = _Session(astronaut_id)
        _sessions[s.id] = s
    return s.id


def _get(session_id, astronaut_id):
    with _lock:
        s = _sessions.get(session_id)
    if not s or s.astronaut_id != astronaut_id:
        return None
    return s


def decode(jpeg_bytes):
    """JPEG/PNG bytes -> BGR array (in memory only)."""
    cv2, np = _libs["cv2"], _libs["np"]
    if not jpeg_bytes:
        raise FaceError("no image")
    if len(jpeg_bytes) > MAX_FRAME_BYTES:
        raise FaceError("frame too large")
    img = cv2.imdecode(np.frombuffer(jpeg_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
    if img is None or img.ndim != 3:
        raise FaceError("not an image")
    h, w = img.shape[:2]
    if max(h, w) > MAX_FRAME_SIDE:
        raise FaceError("frame larger than 1280 px")
    return img


def add_frame(session_id, astronaut_id, jpeg_bytes, t_ms):
    """One frame of a session -> live feedback {faces, usable, guidance}. The image is dropped
    as soon as it's measured."""
    s = _get(session_id, astronaut_id)
    if not s:
        return None
    with s.lock:
        if len(s.frames) >= MAX_FRAMES or time.monotonic() - s.started > MAX_WINDOW_S + 10:
            raise FaceError("observation window is over")
        img = decode(jpeg_bytes)
        mp_ = _libs["mp"]
        rgb = _libs["cv2"].cvtColor(img, _libs["cv2"].COLOR_BGR2RGB)
        ts = max(int(t_ms), s.last_ts + 1)  # VIDEO mode needs strictly increasing timestamps
        s.last_ts = ts
        res = s.landmarker.detect_for_video(mp_.Image(image_format=mp_.ImageFormat.SRGB, data=_libs["np"].ascontiguousarray(rgb)), ts)
        m = face_metrics.frame_metrics(res.face_landmarks, res.facial_transformation_matrixes, img, _libs["cv2"])
        del img, rgb, res
        m["t"] = ts / 1000.0
        s.frames.append(m)
        s.last = time.monotonic()
    return {"faces": m["faces"], "usable": not face_metrics.frame_problems(m), "guidance": face_metrics.guidance(m), "frames": len(s.frames)}


def finish(session_id, astronaut_id):
    """End the window: the report from this session's frames (and the model is closed)."""
    with _lock:
        s = _sessions.get(session_id)
        if not s or s.astronaut_id != astronaut_id:
            return None
        _sessions.pop(session_id)
    with s.lock:
        frames = s.frames
        s.close()
    if not frames:
        raise FaceError("no frames were received")
    duration = max(frames[-1]["t"] - frames[0]["t"], 0.0) + (frames[1]["t"] - frames[0]["t"] if len(frames) > 1 else 0.0)
    report = face_metrics.summarize(frames, duration)
    report["model"] = MODEL_NAME
    return report


def cancel(session_id, astronaut_id):
    with _lock:
        s = _sessions.get(session_id)
        if not s or s.astronaut_id != astronaut_id:
            return False
        _sessions.pop(session_id)
    s.close()
    return True


def active_sessions():
    with _lock:
        return len(_sessions)
