"""Face Analysis: the measurements (backend/logic/face_metrics.py), the session service and
API (backend/services/face.py + routes), and -- when MediaPipe and the model are installed --
the real Face Landmarker. Synthetic faces stand in for the model in most tests: a 478-point
mesh whose eyelids, cheeks and forehead are where MediaPipe puts them, with eye openness
under the test's control. No real face image is part of the repository; set
ASTRO_FACE_TEST_IMAGE=<photo with one face> to also run the real-face checks locally.
"""
import argparse
import json
import math
import os

import pytest

np = pytest.importorskip("numpy")
cv2 = pytest.importorskip("cv2")

from backend import db  # noqa: E402
from backend.logic import face_metrics as fm  # noqa: E402
from backend.services import face  # noqa: E402

W, H = 640, 480


# ---------------------------------------------------------------- a synthetic face

def synthetic_face(ear=0.31, cx=320, cy=240, width=200, yaw=0.0):
    """478 normalised landmarks (x, y, z) in a face box, with the eye landmarks placed for the
    given eye aspect ratio and the cheek/forehead/lower-lid points where MediaPipe has them."""
    rng = np.random.default_rng(0)
    pts = np.zeros((478, 3))
    pts[:, 0] = cx + (rng.random(478) - 0.5) * width
    pts[:, 1] = cy + (rng.random(478) - 0.5) * width * 1.3
    x0, x1 = cx - width / 2, cx + width / 2
    pts[0] = (x0, cy, 0); pts[1] = (x1, cy, 0)  # pin the box edges
    pts[2] = (cx, cy - width * 0.65, 0); pts[3] = (cx, cy + width * 0.65, 0)

    def eye(idx, ex):
        w = width * 0.18
        h = ear * w  # EAR = h / w with both lid pairs h apart
        ey = cy - width * 0.12
        outer, up1, up2, inner, lo1, lo2 = idx
        pts[outer] = (ex - w / 2, ey, 0); pts[inner] = (ex + w / 2, ey, 0)
        pts[up1] = (ex - w / 6, ey - h / 2, 0); pts[up2] = (ex + w / 6, ey - h / 2, 0)
        pts[lo2] = (ex - w / 6, ey + h / 2, 0); pts[lo1] = (ex + w / 6, ey + h / 2, 0)

    eye(fm.RIGHT_EYE, cx - width * 0.2)
    eye(fm.LEFT_EYE, cx + width * 0.2)
    pts[fm.RIGHT_LOWER_LID] = (cx - width * 0.2, cy - width * 0.08, 0)
    pts[fm.LEFT_LOWER_LID] = (cx + width * 0.2, cy - width * 0.08, 0)
    pts[fm.RIGHT_CHEEK] = (cx - width * 0.25, cy + width * 0.1, 0)
    pts[fm.LEFT_CHEEK] = (cx + width * 0.25, cy + width * 0.1, 0)
    pts[fm.FOREHEAD] = (cx, cy - width * 0.4, 0)
    pts[:, 0] /= W
    pts[:, 1] /= H
    pts[:, 2] /= W
    return [tuple(p) for p in pts]


def matrix(yaw=0.0, pitch=0.0, roll=0.0):
    y, p, r = (math.radians(a) for a in (yaw, pitch, roll))
    rx = np.array([[1, 0, 0], [0, math.cos(p), -math.sin(p)], [0, math.sin(p), math.cos(p)]])
    ry = np.array([[math.cos(y), 0, math.sin(y)], [0, 1, 0], [-math.sin(y), 0, math.cos(y)]])
    rz = np.array([[math.cos(r), -math.sin(r), 0], [math.sin(r), math.cos(r), 0], [0, 0, 1]])
    m = np.eye(4)
    m[:3, :3] = rz @ ry @ rx
    return m


def frame(light=140, under_eye_darker=0, noise=6):
    """A plain skin-coloured frame (BGR) with a little texture; optionally darker under the eyes."""
    rng = np.random.default_rng(1)
    img = np.full((H, W, 3), (light * 0.75, light * 0.85, light), dtype=np.float64)
    img += rng.normal(0, noise, img.shape)
    if under_eye_darker:
        for ex in (320 - 40, 320 + 40):
            cy = int((240 - 16) + 0.4 * ((240 + 20) - (240 - 16)))
            img[cy - 6:cy + 7, ex - 6:ex + 7] -= under_eye_darker
    return np.clip(img, 0, 255).astype(np.uint8)


def run(series, light=140, under_eye_darker=0, fps=10, faces=1):
    """frame_metrics over a series of eye openness values -> summarize()."""
    img = frame(light, under_eye_darker)
    frames = []
    for i, e in enumerate(series):
        lms = [synthetic_face(e)] * faces
        m = fm.frame_metrics(lms, [matrix()] * faces, img, cv2)
        m["t"] = i / fps
        frames.append(m)
    return fm.summarize(frames, len(series) / fps)


def obs(report, oid):
    return next(o for o in report["observations"] if o["id"] == oid)


# ---------------------------------------------------------------- measurements

def test_eye_aspect_ratio_matches_the_eyelid_geometry():
    pts = fm.points(synthetic_face(0.30), W, H)
    assert fm.eye_aspect_ratio(pts, fm.RIGHT_EYE) == pytest.approx(0.30, abs=0.005)
    assert fm.eye_aspect_ratio(fm.points(synthetic_face(0.08), W, H), fm.LEFT_EYE) == pytest.approx(0.08, abs=0.005)


def test_head_pose_reads_the_transformation_matrix():
    yaw, pitch, roll = fm.head_pose(matrix(yaw=15, pitch=-8, roll=4))
    assert (yaw, pitch, roll) == pytest.approx((15, -8, 4), abs=0.5)
    assert fm.head_pose(None) is None
    assert fm.head_pose(np.full((4, 4), np.nan)) is None


def test_open_eyes_and_blinks_are_counted():
    open_, closed = 0.31, 0.08
    series = [open_] * 120
    for start in (20, 60, 95):  # three blinks of 2 frames (0.2 s) each
        series[start] = series[start + 1] = closed
    r = run(series)
    eyes = obs(r, "eye_openness")
    assert eyes["status"] == "measured" and eyes["value"]["open_ratio"] == pytest.approx(0.31, abs=0.01)
    blinks = obs(r, "eye_closures")
    assert blinks["status"] == "measured"
    assert blinks["value"]["count"] == 3
    assert blinks["value"]["mean_duration_s"] == pytest.approx(0.2, abs=0.05)
    assert blinks["value"]["per_minute"] == pytest.approx(3 / 11.9 * 60, rel=0.05)
    assert any("frames per second" in lim for lim in blinks["limitations"])


def test_a_long_closure_is_reported():
    series = [0.31] * 40 + [0.07] * 15 + [0.31] * 65  # eyes shut 1.5 s
    v = obs(run(series), "eye_closures")["value"]
    assert v["count"] == 1 and v["long_closures"] == 1 and v["longest_s"] == pytest.approx(1.5, abs=0.15)


def test_too_short_a_window_is_inconclusive():
    r = run([0.31] * 40)  # 4 s
    for oid in ("eye_openness", "eye_closures", "head_movement", "under_eye", "skin"):
        o = obs(r, oid)
        assert o["status"] == "inconclusive" and o["value"] is None and "4.0 s" in o["reliability_reason"]


def test_no_face_is_reported_plainly():
    img = frame()
    frames = [dict(fm.frame_metrics([], [], img, cv2), t=i / 10) for i in range(120)]
    r = fm.summarize(frames, 12.0)
    assert r["quality"]["rating"] == "no face" and r["quality"]["no_face_frames"] == 120
    assert all(o["status"] == "inconclusive" for o in r["observations"])
    assert fm.guidance(frames[0]) == ["No face found: face the camera"]


def test_a_frame_too_dark_to_find_a_face_says_so():
    img = (frame(150) * 0.05).astype(np.uint8)
    frames = [dict(fm.frame_metrics([], [], img, cv2), t=i / 10) for i in range(120)]
    r = fm.summarize(frames, 12.0)
    assert r["quality"]["rating"] == "poor" and "too dark to find a face" in r["quality"]["issues"]
    assert fm.guidance(frames[0]) == ["Too dark to see your face: add light"]
    assert "too dark to find a face" in obs(r, "eye_openness")["reliability_reason"]


def test_more_than_one_face_is_never_analysed():
    r = run([0.31] * 120, faces=2)
    assert r["quality"]["rating"] == "poor" and r["quality"]["multi_face_frames"] == 120
    assert obs(r, "image_quality")["reliability_reason"].startswith("more than one face in view")
    assert obs(r, "eye_openness")["status"] == "inconclusive"
    assert "more than one face" in obs(r, "eye_openness")["reliability_reason"]


def test_poor_lighting_makes_everything_inconclusive():
    r = run([0.31] * 120, light=25)  # face L* ~ 10
    assert r["quality"]["rating"] == "poor" and "dim lighting" in r["quality"]["issues"]
    assert obs(r, "eye_openness")["status"] == "inconclusive"
    assert "too dark" in obs(r, "eye_openness")["reliability_reason"]


def test_dim_but_usable_light_keeps_eye_measures_but_not_appearance():
    r = run([0.31] * 120, light=60)  # L* ~ 24: dim
    assert obs(r, "eye_openness")["status"] == "measured"
    assert obs(r, "under_eye")["status"] == "inconclusive"
    assert obs(r, "skin")["status"] == "inconclusive"


def test_under_eye_measured_only_in_good_light_and_says_what_it_is():
    r = run([0.31] * 120, light=150, under_eye_darker=30)
    u = obs(r, "under_eye")
    assert u["status"] == "measured" and u["reliability"] == "low"
    assert u["value"]["darker_than_cheek_L"] > 3
    assert "isn't a measure of tiredness" in " ".join(u["limitations"])


def test_skin_colour_is_inconclusive_under_a_colour_cast():
    img = frame(150)
    img[:, :, 0] = np.clip(img[:, :, 0].astype(int) + 90, 0, 255)  # strong blue light
    frames = [dict(fm.frame_metrics([synthetic_face(0.31)], [matrix()], img, cv2), t=i / 10) for i in range(120)]
    s = obs(fm.summarize(frames, 12.0), "skin")
    assert s["status"] == "inconclusive" and "colour cast" in s["reliability_reason"]


def test_head_turned_away_is_flagged_and_appearance_skipped():
    img = frame(150)
    frames = [dict(fm.frame_metrics([synthetic_face(0.31)], [matrix(yaw=30)], img, cv2), t=i / 10) for i in range(120)]
    r = fm.summarize(frames, 12.0)
    assert obs(r, "head_movement")["value"]["yaw_deg"] == pytest.approx(30, abs=1)
    assert obs(r, "under_eye")["status"] == "inconclusive"
    assert "Look straight at the camera" in fm.guidance(frames[0])


def test_the_report_never_names_a_condition():
    text = json.dumps(run([0.31] * 120, light=150)).lower()
    for word in ("anemi", "dehydrat", "disease", "depress", "anxiety", "diagnos is", "you are tired", "fatigued"):
        assert word not in text


def test_frame_metrics_hold_numbers_only():
    m = fm.frame_metrics([synthetic_face()], [matrix()], frame(), cv2)
    assert all(isinstance(v, (int, float, tuple)) for v in m.values())
    assert m["frame_L"] > 0


# ---------------------------------------------------------------- the service + API (fake model)

class FakeResult:
    def __init__(self, faces, ear):
        self.face_landmarks = [synthetic_face(ear)] * faces
        self.facial_transformation_matrixes = [matrix()] * faces


class FakeLandmarker:
    created = 0
    closed = 0

    def __init__(self, script):
        self.script = script
        self.timestamps = []
        FakeLandmarker.created += 1

    def detect_for_video(self, image, ts):
        self.timestamps.append(ts)
        faces, ear = self.script(len(self.timestamps))
        return FakeResult(faces, ear)

    def close(self):
        FakeLandmarker.closed += 1


@pytest.fixture()
def fake_model(monkeypatch):
    """face.py's libraries with the real OpenCV/NumPy and a scripted landmarker."""
    script = {"fn": lambda i: (1, 0.08 if i % 40 in (10, 11) else 0.31)}

    class Vision:
        class RunningMode:
            VIDEO = "video"

        @staticmethod
        def FaceLandmarkerOptions(**kw):
            return kw

        class FaceLandmarker:
            @staticmethod
            def create_from_options(opts):
                assert opts["running_mode"] == "video" and opts["num_faces"] == 2
                return FakeLandmarker(lambda i: script["fn"](i))

    class Tasks:
        @staticmethod
        def BaseOptions(**kw):
            return kw

    class MP:
        class ImageFormat:
            SRGB = "srgb"

        @staticmethod
        def Image(image_format, data):
            return data

    monkeypatch.setattr(face, "_libs", {"cv2": cv2, "np": np, "mp": MP, "tasks": Tasks, "vision": Vision})
    monkeypatch.setitem(face._state, "state", "ready")
    monkeypatch.setattr(face, "_sessions", {})
    return script


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    from _pytest.monkeypatch import MonkeyPatch
    mp = MonkeyPatch()
    mp.setattr(db, "DB_PATH", str(tmp_path_factory.mktemp("face_api") / "test.db"))
    import app as app_module
    args = argparse.Namespace(port=None, simulate=True, wifi=False, wifi_host=None, wifi_port=None, host="0.0.0.0", web_port=5000)
    flask_app, _s, _b = app_module.create_app(args)
    flask_app.config["TESTING"] = True
    yield flask_app.test_client()
    mp.undo()


def login(client, uid):
    assert client.post("/api/auth/nfc_login", json={"uid": uid}).status_code == 200


AHMAD, SAMEER, SURGEON = "9B:25:0F:54", "2B:ED:20:54", "D1000001"
JPEG = cv2.imencode(".jpg", frame(150))[1].tobytes()


def observe(client, n=120, astro=1, fps=10):
    sid = client.post(f"/api/astronauts/{astro}/face/sessions", json={}).get_json()["session_id"]
    last = None
    for i in range(n):
        last = client.post(f"/api/astronauts/{astro}/face/sessions/{sid}/frames?t={int(i * 1000 / fps)}", data=JPEG, content_type="image/jpeg")
        assert last.status_code == 200, last.get_json()
    return sid, last.get_json(), client.post(f"/api/astronauts/{astro}/face/sessions/{sid}/finish", json={})


def test_status_is_open_and_disabled_in_tests(client):
    st = client.get("/api/face/status").get_json()
    assert st["state"] == "disabled" and st["window_s"] == 12 and st["fps"] == 10


def test_only_the_astronaut_records_their_face(client, fake_model):
    client.post("/api/auth/logout")
    assert client.post("/api/astronauts/1/face/sessions", json={}).status_code == 401
    login(client, SURGEON)
    assert client.post("/api/astronauts/1/face/sessions", json={}).status_code == 403
    login(client, SAMEER)
    assert client.post("/api/astronauts/1/face/sessions", json={}).status_code == 403


def test_unavailable_is_503(client, monkeypatch):
    login(client, AHMAD)
    monkeypatch.setitem(face._state, "state", "missing-model")
    assert client.post("/api/astronauts/1/face/sessions", json={}).status_code == 503


def test_a_full_observation_produces_a_stored_report_without_images(client, fake_model):
    login(client, AHMAD)
    FakeLandmarker.closed = 0
    sid, live, res = observe(client)
    assert live["faces"] == 1 and live["usable"] is True and live["frames"] == 120
    assert res.status_code == 200
    rep = res.get_json()
    assert rep["quality"]["frames"] == 120 and rep["quality"]["fps"] == pytest.approx(10, abs=0.5)
    assert obs(rep, "eye_closures")["value"]["count"] == 3  # blinks at frames 10-11, 50-51, 90-91
    assert FakeLandmarker.closed == 1 and face.active_sessions() == 0  # the model is closed after
    latest = client.get("/api/astronauts/1/face/latest").get_json()["analysis"]
    assert latest["id"] == rep["id"] and len(latest["observations"]) == 6
    conn = db.get_conn()
    try:
        row = dict(conn.execute("SELECT * FROM face_analyses WHERE id = ?", (rep["id"],)).fetchone())
        cols = [r[1] for r in conn.execute("PRAGMA table_info(face_analyses)")]
    finally:
        conn.close()
    assert not any(k in c for c in cols for k in ("image", "jpeg", "frame_data", "video", "landmark"))
    assert len(row["report_json"]) < 20000 and "\\xff\\xd8" not in row["report_json"]
    # the session is gone: no more frames, no second finish
    assert client.post(f"/api/astronauts/1/face/sessions/{sid}/frames?t=99999", data=JPEG, content_type="image/jpeg").status_code == 404
    assert client.post(f"/api/astronauts/1/face/sessions/{sid}/finish", json={}).status_code == 404


def test_timestamps_reach_the_model_strictly_increasing(client, fake_model):
    login(client, AHMAD)
    sid = client.post("/api/astronauts/1/face/sessions", json={}).get_json()["session_id"]
    for t in (0, 100, 100, 50, 300):  # repeats / going back are bumped forward
        client.post(f"/api/astronauts/1/face/sessions/{sid}/frames?t={t}", data=JPEG, content_type="image/jpeg")
    ts = face._sessions[sid].landmarker.timestamps
    assert ts == sorted(ts) and len(set(ts)) == len(ts)
    client.post(f"/api/astronauts/1/face/sessions/{sid}/cancel", json={})


def test_live_feedback_for_no_face_and_two_faces(client, fake_model):
    login(client, AHMAD)
    for faces, hint in ((0, "No face found"), (2, "Only one person")):
        fake_model["fn"] = lambda i, f=faces: (f, 0.31)
        sid = client.post("/api/astronauts/1/face/sessions", json={}).get_json()["session_id"]
        live = client.post(f"/api/astronauts/1/face/sessions/{sid}/frames?t=0", data=JPEG, content_type="image/jpeg").get_json()
        assert live["faces"] == faces and live["usable"] is False and live["guidance"][0].startswith(hint)
        client.post(f"/api/astronauts/1/face/sessions/{sid}/cancel", json={})


def test_bad_frames_are_rejected(client, fake_model):
    login(client, AHMAD)
    sid = client.post("/api/astronauts/1/face/sessions", json={}).get_json()["session_id"]
    assert client.post(f"/api/astronauts/1/face/sessions/{sid}/frames?t=0", data=b"not a jpeg", content_type="image/jpeg").status_code == 400
    assert client.post(f"/api/astronauts/1/face/sessions/{sid}/frames?t=0", data=b"0" * (face.MAX_FRAME_BYTES + 1), content_type="image/jpeg").status_code == 413
    huge = cv2.imencode(".jpg", np.zeros((1400, 1400, 3), np.uint8))[1].tobytes()
    assert client.post(f"/api/astronauts/1/face/sessions/{sid}/frames?t=0", data=huge, content_type="image/jpeg").status_code == 400
    assert client.post(f"/api/astronauts/1/face/sessions/{sid}/finish", json={}).status_code == 400  # no frames
    assert face.active_sessions() == 0


def test_another_astronaut_cant_use_your_session(client, fake_model):
    login(client, AHMAD)
    sid = client.post("/api/astronauts/1/face/sessions", json={}).get_json()["session_id"]
    login(client, SAMEER)
    assert client.post(f"/api/astronauts/2/face/sessions/{sid}/frames?t=0", data=JPEG, content_type="image/jpeg").status_code == 404
    assert client.post(f"/api/astronauts/2/face/sessions/{sid}/finish", json={}).status_code == 404
    login(client, AHMAD)
    assert client.post(f"/api/astronauts/1/face/sessions/{sid}/cancel", json={}).get_json()["cancelled"] is True


def test_retake_replaces_the_running_session_and_idle_ones_are_closed(client, fake_model, monkeypatch):
    login(client, AHMAD)
    FakeLandmarker.closed = 0
    a = client.post("/api/astronauts/1/face/sessions", json={}).get_json()["session_id"]
    b = client.post("/api/astronauts/1/face/sessions", json={}).get_json()["session_id"]
    assert a != b and FakeLandmarker.closed == 1 and face.active_sessions() == 1
    monkeypatch.setattr(face, "SESSION_IDLE_S", -1)
    login(client, SAMEER)
    client.post("/api/astronauts/2/face/sessions", json={})  # starting any session sweeps idle ones
    assert b not in face._sessions
    face.cancel(next(iter(face._sessions)), 2)


def test_the_surgeon_can_view_the_latest_report(client, fake_model):
    login(client, SURGEON)
    assert client.get("/api/astronauts/1/face/latest").status_code == 200
    login(client, SAMEER)
    assert client.get("/api/astronauts/1/face/latest").status_code == 403


def test_voice_tone_and_mood_tables_are_untouched_by_face_analysis(client, fake_model):
    conn = db.get_conn()
    try:
        before = {t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("readings", "voice_tone", "voice_talks")}
    finally:
        conn.close()
    login(client, AHMAD)
    observe(client)
    conn = db.get_conn()
    try:
        after = {t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("readings", "voice_tone", "voice_talks")}
    finally:
        conn.close()
    assert after == before


# ---------------------------------------------------------------- the real model (optional)

def _real():
    pytest.importorskip("mediapipe")
    if not os.path.isfile(face.MODEL_PATH):
        pytest.skip("face model not downloaded (scripts/face_analysis/download_model.py)")


@pytest.fixture()
def real_face(monkeypatch):
    _real()
    monkeypatch.delenv("ASTRO_NO_FACE", raising=False)
    monkeypatch.setattr(face, "_sessions", {})
    st = face.check()
    assert st["state"] == "ready", st
    yield
    for sid in list(face._sessions):
        face._sessions.pop(sid).close()


def _real_report(frames_bgr):
    sid = face.start_session(1)
    lives = [face.add_frame(sid, 1, cv2.imencode(".jpg", f)[1].tobytes(), i * 100) for i, f in enumerate(frames_bgr)]
    return lives, face.finish(sid, 1)


def test_real_model_finds_no_face_in_blank_or_patterned_frames(real_face):
    lives, rep = _real_report([frame(150)] * 60)  # a lit, face-less picture
    assert all(l["faces"] == 0 for l in lives)
    assert rep["quality"]["rating"] == "no face" and face.active_sessions() == 0
    lives, rep = _real_report([np.zeros((480, 640, 3), np.uint8)] * 60)  # black: too dark to tell
    assert all(l["faces"] == 0 for l in lives) and lives[-1]["guidance"] == ["Too dark to see your face: add light"]
    assert rep["quality"]["rating"] == "poor" and "too dark to find a face" in rep["quality"]["issues"]


TEST_IMAGE = os.environ.get("ASTRO_FACE_TEST_IMAGE")


@pytest.mark.skipif(not TEST_IMAGE, reason="set ASTRO_FACE_TEST_IMAGE to a local photo with one face")
def test_real_model_on_a_real_face_one_two_and_dark(real_face):
    img = cv2.imread(TEST_IMAGE)
    scale = 640 / img.shape[1]
    img = cv2.resize(img, (640, int(img.shape[0] * scale)))
    lives, rep = _real_report([img] * 121)
    assert lives[-1]["faces"] == 1
    assert obs(rep, "eye_openness")["status"] == "measured" and 0.15 < obs(rep, "eye_openness")["value"]["open_ratio"] < 0.5
    assert abs(obs(rep, "head_movement")["value"]["yaw_deg"]) < 45
    half = img[:, img.shape[1] // 8: img.shape[1] * 5 // 8]
    lives2, rep2 = _real_report([np.hstack([half, half])] * 30)
    assert lives2[-1]["faces"] == 2 and rep2["quality"]["multi_face_frames"] == 30
    lives3, rep3 = _real_report([(img * 0.25).astype(np.uint8)] * 121)
    assert rep3["quality"]["rating"] == "poor" and obs(rep3, "eye_openness")["status"] == "inconclusive"
