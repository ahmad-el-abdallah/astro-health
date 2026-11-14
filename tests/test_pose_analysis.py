"""Pose Analysis: the measurements (backend/logic/pose_metrics.py), the session service and
API (backend/services/pose.py + routes), and -- when MediaPipe and the model are installed --
the real Pose Landmarker. Synthetic bodies stand in for the model in most tests: 33
landmarks placed where MediaPipe puts them on a person sitting in front of a laptop, with
shoulder/hip tilt, lean, visibility and sway under the test's control. No image of a person
is part of the repository; set ASTRO_POSE_TEST_IMAGE=<photo of one person, head to hips> to
also run the real-person check locally.
"""
import argparse
import json
import math
import os

import pytest

np = pytest.importorskip("numpy")
cv2 = pytest.importorskip("cv2")

from backend import db  # noqa: E402
from backend.logic import pose_metrics as pm  # noqa: E402
from backend.services import pose  # noqa: E402

W, H = 640, 480


# ---------------------------------------------------------------- a synthetic body

def synthetic_body(shoulder_tilt=0.0, hip_tilt=0.0, lean=0.0, cx=0.5, shoulder_y=0.45, sw=0.30,
                   vis=0.95, hips=True, hip_vis=None, head_offset=0.0, ear_vis=None):
    """33 landmarks (x, y, z, visibility), normalised, for a person facing an UNMIRRORED front
    camera: their left side is on the image's right (+x). Tilt + = the person's left lower."""
    pts = np.zeros((33, 4))
    pts[:, 3] = vis
    sw_px = sw * W
    torso_px = sw_px * 1.25

    def pair(left, right, mid_x_px, mid_y_px, width_px, tilt_deg):
        dy = math.tan(math.radians(tilt_deg)) * width_px / 2
        pts[left, :2] = ((mid_x_px + width_px / 2) / W, (mid_y_px + dy) / H)
        pts[right, :2] = ((mid_x_px - width_px / 2) / W, (mid_y_px - dy) / H)

    hip_mid = (cx * W, shoulder_y * H + torso_px)
    sh_mid = (hip_mid[0] + math.tan(math.radians(lean)) * torso_px, shoulder_y * H)
    pair(pm.L_SHOULDER, pm.R_SHOULDER, sh_mid[0], sh_mid[1], sw_px, shoulder_tilt)
    pair(pm.L_HIP, pm.R_HIP, hip_mid[0], hip_mid[1], sw_px * 0.7, hip_tilt)
    pair(pm.L_ELBOW, pm.R_ELBOW, sh_mid[0], sh_mid[1] + sw_px * 0.6, sw_px * 1.1, shoulder_tilt)
    pair(pm.L_WRIST, pm.R_WRIST, sh_mid[0], sh_mid[1] + sw_px * 1.0, sw_px * 0.8, shoulder_tilt)
    nose = (sh_mid[0] + head_offset * sw_px, sh_mid[1] - sw_px * 0.55)
    pts[pm.NOSE, :2] = (nose[0] / W, nose[1] / H)
    pair(pm.L_EYE, pm.R_EYE, nose[0], nose[1] - sw_px * 0.08, sw_px * 0.2, 0)
    pair(pm.L_EAR, pm.R_EAR, nose[0], nose[1] - sw_px * 0.04, sw_px * 0.45, 0)
    for i in range(33):  # the rest (mouth, hands, feet) near the body, low visibility
        if not pts[i, 0]:
            pts[i, :2] = (cx, min(0.99, shoulder_y + 0.3))
            pts[i, 3] = 0.1
    for i in (pm.L_KNEE, pm.R_KNEE, pm.L_ANKLE, pm.R_ANKLE):
        pts[i, :2] = (cx, 1.2)  # legs below the frame (sitting at a desk)
        pts[i, 3] = 0.05
    if not hips:
        for i in (pm.L_HIP, pm.R_HIP):
            pts[i, 1] = 1.1
            pts[i, 3] = 0.2
    elif hip_vis is not None:
        pts[pm.L_HIP, 3] = pts[pm.R_HIP, 3] = hip_vis
    if ear_vis is not None:
        pts[pm.L_EAR, 3] = pts[pm.R_EAR, 3] = ear_vis
    return [tuple(p) for p in pts]


def frame(light=140):
    rng = np.random.default_rng(1)
    img = np.full((H, W, 3), light, dtype=np.float64) + rng.normal(0, 4, (H, W, 3))
    return np.clip(img, 0, 255).astype(np.uint8)


def run(bodies_fn, n=120, fps=10, light=140, people=1):
    """frame_metrics over n frames (bodies_fn(i) -> landmarks) -> summarize()."""
    img = frame(light)
    frames = []
    for i in range(n):
        lms = [bodies_fn(i)] * people if people else []
        m = pm.frame_metrics(lms, img, cv2)
        m["t"] = i / fps
        frames.append(m)
    return pm.summarize(frames, n / fps), frames


def obs(report, oid):
    return next(o for o in report["observations"] if o["id"] == oid)


IDS = ("landmark_visibility", "shoulder_alignment", "hip_alignment", "torso_inclination", "head_position", "asymmetry", "movement")


# ---------------------------------------------------------------- measurements

def test_tilt_sign_follows_the_persons_own_left_and_right():
    lm = pm.landmarks_array(synthetic_body(shoulder_tilt=5))
    assert pm.tilt(lm, pm.L_SHOULDER, pm.R_SHOULDER, W, H) == pytest.approx(5, abs=0.1)
    lm = pm.landmarks_array(synthetic_body(shoulder_tilt=-3))
    assert pm.tilt(lm, pm.L_SHOULDER, pm.R_SHOULDER, W, H) == pytest.approx(-3, abs=0.1)


def test_a_level_upright_body_is_described_as_such():
    r, _ = run(lambda i: synthetic_body())
    assert r["quality"]["rating"] == "good" and r["quality"]["usable_frames"] == 120
    assert [o["id"] for o in r["observations"]] == list(IDS)
    sh = obs(r, "shoulder_alignment")
    assert sh["status"] == "measured" and sh["value"]["lower_side"] == "level" and "about level" in sh["display"]
    assert obs(r, "torso_inclination")["value"]["toward"] == "upright"
    assert obs(r, "head_position")["value"]["offset_shoulder_widths"] == pytest.approx(0, abs=0.01)
    assert obs(r, "asymmetry")["value"]["mean_shoulder_widths"] == pytest.approx(0, abs=0.01)
    assert obs(r, "movement")["value"]["label"] == "very still"
    assert obs(r, "landmark_visibility")["value"]["regions"]["shoulders"] == pytest.approx(0.95)


def test_shoulder_hip_tilt_and_lean_are_measured_with_the_right_side():
    r, _ = run(lambda i: synthetic_body(shoulder_tilt=6, hip_tilt=-4, lean=5))
    sh, hp, tl = obs(r, "shoulder_alignment"), obs(r, "hip_alignment"), obs(r, "torso_inclination")
    assert sh["value"]["tilt_deg"] == pytest.approx(6, abs=0.2) and sh["value"]["lower_side"] == "left"
    assert "left side lower" in sh["display"]
    assert hp["value"]["tilt_deg"] == pytest.approx(-4, abs=0.2) and hp["value"]["lower_side"] == "right"
    assert tl["value"]["lean_deg"] == pytest.approx(5, abs=0.3) and tl["value"]["toward"] == "left"
    assert obs(r, "asymmetry")["value"]["mean_shoulder_widths"] > 0.05


def test_head_offset_and_tilt_from_the_nose_and_ears():
    r, _ = run(lambda i: synthetic_body(head_offset=-0.2))
    h = obs(r, "head_position")
    assert h["value"]["offset_shoulder_widths"] == pytest.approx(-0.2, abs=0.01)
    assert "toward your right" in h["display"]
    assert h["value"]["head_tilt_deg"] == pytest.approx(0, abs=0.1)
    assert h["value"]["height_shoulder_widths"] == pytest.approx(0.55, abs=0.01)
    # ears hidden (hair): head tilt is left out, the rest stays
    r, _ = run(lambda i: synthetic_body(ear_vis=0.2))
    h = obs(r, "head_position")
    assert h["status"] == "measured" and h["value"]["head_tilt_deg"] is None and "ears not visible" in h["reliability_reason"]


def test_movement_and_sway_are_measured():
    still, _ = run(lambda i: synthetic_body())
    sway, _ = run(lambda i: synthetic_body(cx=0.5 + 0.04 * math.sin(i / 3)))
    s, m = obs(still, "movement")["value"], obs(sway, "movement")["value"]
    assert m["sway_shoulder_widths"] > 0.05 > s["sway_shoulder_widths"]
    assert m["median_speed_shoulder_widths_per_s"] > s["median_speed_shoulder_widths_per_s"]
    assert m["label"] != "very still"


def test_hips_out_of_view_keep_shoulders_but_not_hip_or_lean():
    r, frames = run(lambda i: synthetic_body(hips=False))
    assert obs(r, "shoulder_alignment")["status"] == "measured"
    for oid in ("hip_alignment", "torso_inclination"):
        o = obs(r, oid)
        assert o["status"] == "inconclusive" and o["value"] is None
    assert "step back" in obs(r, "hip_alignment")["reliability_reason"]
    assert "hips not in view" in r["quality"]["issues"] and r["quality"]["rating"] == "good"  # expected at a desk
    assert "Step back to show your hips (for hip and lean measures)" in pm.guidance(frames[0])


def test_no_body_is_reported_plainly():
    r, frames = run(lambda i: None, people=0)
    assert r["quality"]["rating"] == "no body" and r["quality"]["no_body_frames"] == 120
    assert all(o["status"] == "inconclusive" for o in r["observations"])
    assert pm.guidance(frames[0])[0].startswith("No body found")
    assert pm.live(frames[0]) == {"poses": 0, "usable": False, "guidance": pm.guidance(frames[0]), "visible": {}}


def test_a_frame_too_dark_to_find_a_body_says_so():
    r, frames = run(lambda i: None, people=0, light=8)
    assert r["quality"]["rating"] == "poor" and "too dark to find a body" in r["quality"]["issues"]
    assert pm.guidance(frames[0]) == ["Too dark to see you: add light"]
    assert "too dark" in obs(r, "shoulder_alignment")["reliability_reason"]


def test_low_confidence_landmarks_are_not_measured():
    r, frames = run(lambda i: synthetic_body(vis=0.3))  # the model isn't sure of anything
    assert r["quality"]["usable_frames"] == 0 and r["quality"]["rating"] == "poor"
    for oid in IDS[1:]:
        assert obs(r, oid)["status"] == "inconclusive"
    assert "shoulders not clearly visible" in obs(r, "shoulder_alignment")["reliability_reason"]
    assert pm.guidance(frames[0])[0] == "Both shoulders need to be in view"
    # medium confidence: measured, but not with high reliability
    r, _ = run(lambda i: synthetic_body(vis=0.7))
    assert obs(r, "shoulder_alignment")["reliability"] == "medium"
    r, _ = run(lambda i: synthetic_body(vis=0.95))
    assert obs(r, "shoulder_alignment")["reliability"] == "high"


def test_low_confidence_hips_only_drop_the_hip_measures():
    r, _ = run(lambda i: synthetic_body(hip_vis=0.3))
    assert obs(r, "shoulder_alignment")["status"] == "measured"
    assert obs(r, "hip_alignment")["status"] == "inconclusive"


def test_partly_visible_body_in_some_frames():
    # the person leans out of view for 70% of the window
    img = frame()
    frames = []
    for i in range(120):
        lms = [synthetic_body()] if i < 36 else []
        frames.append(dict(pm.frame_metrics(lms, img, cv2), t=i / 10))
    r = pm.summarize(frames, 12.0)
    assert r["quality"]["rating"] == "poor"
    assert obs(r, "shoulder_alignment")["status"] == "inconclusive"
    assert "30%" in obs(r, "shoulder_alignment")["reliability_reason"]


def test_more_than_one_person_is_never_analysed():
    r, frames = run(lambda i: synthetic_body(), people=2)
    assert r["quality"]["rating"] == "poor" and r["quality"]["multi_person_frames"] == 120
    assert obs(r, "shoulder_alignment")["status"] == "inconclusive"
    assert pm.guidance(frames[0]) == ["Only one person in view, please"]


def test_too_short_a_window_is_inconclusive():
    r, _ = run(lambda i: synthetic_body(), n=40)
    for oid in IDS[1:]:
        o = obs(r, oid)
        assert o["status"] == "inconclusive" and "4.0 s" in o["reliability_reason"]


def test_framing_hints():
    img = frame()
    small = pm.frame_metrics([synthetic_body(sw=0.09)], img, cv2)
    assert "Move a little closer" in pm.guidance(small)
    big = pm.frame_metrics([synthetic_body(sw=0.75, shoulder_y=0.6, hips=False)], img, cv2)
    assert "Move back a little" in pm.guidance(big)
    tiny = pm.frame_metrics([synthetic_body(sw=0.05)], img, cv2)
    assert pm.frame_problems(tiny) == ["body too small in the frame (move closer)"]
    side = pm.frame_metrics([synthetic_body(cx=0.15, sw=0.2)], img, cv2)
    assert "Move to the centre of the picture" in pm.guidance(side)
    live = pm.live(pm.frame_metrics([synthetic_body(hips=False)], img, cv2))
    assert live["usable"] is True and live["visible"]["shoulders"] is True and live["visible"]["hips"] is False


def test_the_report_never_names_a_condition_and_carries_its_disclaimer():
    r, _ = run(lambda i: synthetic_body(shoulder_tilt=6, lean=4))
    text = json.dumps(r).lower()
    for word in ("scoliosis", "kyphosis", "lordosis", "parkinson", "stroke", "weakness in", "you have", "diagnosed", "disorder detected"):
        assert word not in text
    assert "not a medical assessment" in r["disclaimer"]
    assert any("2D" in lim for lim in r["limitations"])
    for o in r["observations"]:
        assert o["limitations"], o["id"]


def test_frame_metrics_hold_numbers_only():
    m = pm.frame_metrics([synthetic_body()], frame(), cv2)
    assert all(isinstance(v, (int, float, tuple)) for v in m.values())
    assert "landmarks" not in m


# ---------------------------------------------------------------- the service + API (fake model)

class FakeResult:
    def __init__(self, people, body):
        self.pose_landmarks = [body] * people


class FakeLandmarker:
    created = 0
    closed = 0

    def __init__(self, script):
        self.script = script
        self.timestamps = []
        FakeLandmarker.created += 1

    def detect_for_video(self, image, ts):
        self.timestamps.append(ts)
        people, body = self.script(len(self.timestamps))
        return FakeResult(people, body)

    def close(self):
        FakeLandmarker.closed += 1


@pytest.fixture()
def fake_model(monkeypatch):
    """pose.py's libraries with the real OpenCV/NumPy and a scripted landmarker."""
    script = {"fn": lambda i: (1, synthetic_body(shoulder_tilt=4))}

    class Vision:
        class RunningMode:
            VIDEO = "video"

        @staticmethod
        def PoseLandmarkerOptions(**kw):
            return kw

        class PoseLandmarker:
            @staticmethod
            def create_from_options(opts):
                assert opts["running_mode"] == "video" and opts["num_poses"] == 2
                assert opts["output_segmentation_masks"] is False
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

    monkeypatch.setattr(pose, "_libs", {"cv2": cv2, "np": np, "mp": MP, "tasks": Tasks, "vision": Vision})
    monkeypatch.setitem(pose._state, "state", "ready")
    monkeypatch.setattr(pose, "_sessions", {})
    return script


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    from _pytest.monkeypatch import MonkeyPatch
    mp = MonkeyPatch()
    mp.setattr(db, "DB_PATH", str(tmp_path_factory.mktemp("pose_api") / "test.db"))
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
    sid = client.post(f"/api/astronauts/{astro}/pose/sessions", json={}).get_json()["session_id"]
    last = None
    for i in range(n):
        last = client.post(f"/api/astronauts/{astro}/pose/sessions/{sid}/frames?t={int(i * 1000 / fps)}", data=JPEG, content_type="image/jpeg")
        assert last.status_code == 200, last.get_json()
    return sid, last.get_json(), client.post(f"/api/astronauts/{astro}/pose/sessions/{sid}/finish", json={})


def test_status_is_open_and_disabled_in_tests(client):
    st = client.get("/api/pose/status").get_json()
    assert st["state"] == "disabled" and st["window_s"] == 12 and st["fps"] == 10


def test_only_the_astronaut_records_their_pose(client, fake_model):
    client.post("/api/auth/logout")
    assert client.post("/api/astronauts/1/pose/sessions", json={}).status_code == 401
    login(client, SURGEON)
    assert client.post("/api/astronauts/1/pose/sessions", json={}).status_code == 403
    login(client, SAMEER)
    assert client.post("/api/astronauts/1/pose/sessions", json={}).status_code == 403


def test_unavailable_is_503(client, monkeypatch):
    login(client, AHMAD)
    monkeypatch.setitem(pose._state, "state", "missing-model")
    res = client.post("/api/astronauts/1/pose/sessions", json={})
    assert res.status_code == 503 and res.get_json()["error"] == "pose analysis unavailable"


def test_empty_previous_report_is_null_not_an_error(client):
    login(client, SAMEER)
    res = client.get("/api/astronauts/2/pose/latest")
    assert res.status_code == 200 and res.get_json() == {"analysis": None}


def test_a_full_observation_produces_a_stored_report_without_images(client, fake_model):
    login(client, AHMAD)
    FakeLandmarker.closed = 0
    sid, live, res = observe(client)
    assert live["poses"] == 1 and live["usable"] is True and live["frames"] == 120
    assert live["visible"]["shoulders"] is True
    assert res.status_code == 200
    rep = res.get_json()
    assert rep["quality"]["frames"] == 120 and rep["quality"]["fps"] == pytest.approx(10, abs=0.5)
    assert obs(rep, "shoulder_alignment")["value"]["tilt_deg"] == pytest.approx(4, abs=0.3)
    assert rep["model"] == pose.MODEL_NAME and "disclaimer" in rep and rep["ts"]
    assert FakeLandmarker.closed == 1 and pose.active_sessions() == 0  # the model is closed after
    latest = client.get("/api/astronauts/1/pose/latest").get_json()["analysis"]
    assert latest["id"] == rep["id"] and len(latest["observations"]) == len(IDS)
    assert latest["observations"] == rep["observations"]  # what's shown after a reload is what was made
    conn = db.get_conn()
    try:
        row = dict(conn.execute("SELECT * FROM pose_analyses WHERE id = ?", (rep["id"],)).fetchone())
        cols = [r[1] for r in conn.execute("PRAGMA table_info(pose_analyses)")]
    finally:
        conn.close()
    assert row["astronaut_id"] == 1 and row["frames"] == 120 and row["quality"] == rep["quality"]["rating"]
    assert row["usable_frames"] == 120 and row["model"] == pose.MODEL_NAME
    assert not any(k in c for c in cols for k in ("image", "jpeg", "frame_data", "video", "landmark"))
    assert len(row["report_json"]) < 20000 and "\\xff\\xd8" not in row["report_json"]
    # the session is gone: no more frames, no second finish
    assert client.post(f"/api/astronauts/1/pose/sessions/{sid}/frames?t=99999", data=JPEG, content_type="image/jpeg").status_code == 404
    assert client.post(f"/api/astronauts/1/pose/sessions/{sid}/finish", json={}).status_code == 404


def test_timestamps_reach_the_model_strictly_increasing(client, fake_model):
    login(client, AHMAD)
    sid = client.post("/api/astronauts/1/pose/sessions", json={}).get_json()["session_id"]
    for t in (0, 100, 100, 50, 300):
        client.post(f"/api/astronauts/1/pose/sessions/{sid}/frames?t={t}", data=JPEG, content_type="image/jpeg")
    ts = pose._sessions[sid].landmarker.timestamps
    assert ts == sorted(ts) and len(set(ts)) == len(ts)
    client.post(f"/api/astronauts/1/pose/sessions/{sid}/cancel", json={})


def test_live_feedback_for_no_body_two_people_and_low_confidence(client, fake_model):
    login(client, AHMAD)
    for script, hint in (((0, None), "No body found"), ((2, synthetic_body()), "Only one person"), ((1, synthetic_body(vis=0.3)), "Both shoulders")):
        fake_model["fn"] = lambda i, s=script: s
        sid = client.post("/api/astronauts/1/pose/sessions", json={}).get_json()["session_id"]
        live = client.post(f"/api/astronauts/1/pose/sessions/{sid}/frames?t=0", data=JPEG, content_type="image/jpeg").get_json()
        assert live["poses"] == script[0] and live["usable"] is False and live["guidance"][0].startswith(hint)
        client.post(f"/api/astronauts/1/pose/sessions/{sid}/cancel", json={})


def test_a_no_body_session_still_finishes_with_a_clear_report(client, fake_model):
    login(client, AHMAD)
    fake_model["fn"] = lambda i: (0, None)
    _sid, live, res = observe(client, n=60)
    rep = res.get_json()
    assert res.status_code == 200 and rep["quality"]["rating"] == "no body"
    assert all(o["status"] == "inconclusive" for o in rep["observations"])


def test_bad_frames_and_requests_are_rejected(client, fake_model):
    login(client, AHMAD)
    sid = client.post("/api/astronauts/1/pose/sessions", json={}).get_json()["session_id"]
    base = f"/api/astronauts/1/pose/sessions/{sid}"
    assert client.post(f"{base}/frames?t=0", data=b"not a jpeg", content_type="image/jpeg").status_code == 400
    assert client.post(f"{base}/frames?t=abc", data=JPEG, content_type="image/jpeg").status_code == 400
    assert client.post(f"{base}/frames?t=0", data=b"", content_type="image/jpeg").status_code == 400
    assert client.post(f"{base}/frames?t=0", data=b"0" * (pose.MAX_FRAME_BYTES + 1), content_type="image/jpeg").status_code == 413
    huge = cv2.imencode(".jpg", np.zeros((1400, 1400, 3), np.uint8))[1].tobytes()
    assert client.post(f"{base}/frames?t=0", data=huge, content_type="image/jpeg").status_code == 400
    assert client.post(f"{base}/finish", json={}).status_code == 400  # no frames
    assert pose.active_sessions() == 0
    assert client.post("/api/astronauts/1/pose/sessions/pose-nope/frames?t=0", data=JPEG, content_type="image/jpeg").status_code == 404
    assert client.post("/api/astronauts/1/pose/sessions/pose-nope/cancel", json={}).get_json()["cancelled"] is False


def test_another_astronaut_cant_use_your_session(client, fake_model):
    login(client, AHMAD)
    sid = client.post("/api/astronauts/1/pose/sessions", json={}).get_json()["session_id"]
    login(client, SAMEER)
    assert client.post(f"/api/astronauts/2/pose/sessions/{sid}/frames?t=0", data=JPEG, content_type="image/jpeg").status_code == 404
    assert client.post(f"/api/astronauts/2/pose/sessions/{sid}/finish", json={}).status_code == 404
    login(client, AHMAD)
    assert client.post(f"/api/astronauts/1/pose/sessions/{sid}/cancel", json={}).get_json()["cancelled"] is True


def test_retake_replaces_the_running_session_and_idle_ones_are_closed(client, fake_model, monkeypatch):
    login(client, AHMAD)
    FakeLandmarker.closed = 0
    a = client.post("/api/astronauts/1/pose/sessions", json={}).get_json()["session_id"]
    b = client.post("/api/astronauts/1/pose/sessions", json={}).get_json()["session_id"]
    assert a != b and FakeLandmarker.closed == 1 and pose.active_sessions() == 1
    monkeypatch.setattr(pose, "SESSION_IDLE_S", -1)
    login(client, SAMEER)
    client.post("/api/astronauts/2/pose/sessions", json={})
    assert b not in pose._sessions
    pose.cancel(next(iter(pose._sessions)), 2)


def test_the_surgeon_can_view_the_latest_report(client, fake_model):
    login(client, SURGEON)
    assert client.get("/api/astronauts/1/pose/latest").status_code == 200
    login(client, SAMEER)
    assert client.get("/api/astronauts/1/pose/latest").status_code == 403


def test_pose_and_face_run_independently(client, fake_model):
    """A pose session doesn't touch face sessions, face reports, voice or mood data."""
    from backend.services import face
    conn = db.get_conn()
    try:
        before = {t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("readings", "voice_tone", "voice_talks", "face_analyses")}
    finally:
        conn.close()
    face_sessions = dict(face._sessions)
    login(client, AHMAD)
    observe(client)
    conn = db.get_conn()
    try:
        after = {t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("readings", "voice_tone", "voice_talks", "face_analyses")}
    finally:
        conn.close()
    assert after == before and face._sessions == face_sessions
    assert client.get("/api/face/status").status_code == 200


# ---------------------------------------------------------------- the real model (optional)

def _real():
    pytest.importorskip("mediapipe")
    if not os.path.isfile(pose.MODEL_PATH):
        pytest.skip("pose model not downloaded (scripts/pose_analysis/download_model.py)")


@pytest.fixture()
def real_pose(monkeypatch):
    _real()
    monkeypatch.delenv("ASTRO_NO_POSE", raising=False)
    monkeypatch.setattr(pose, "_sessions", {})
    st = pose.check()
    assert st["state"] == "ready", st
    yield
    for sid in list(pose._sessions):
        pose._sessions.pop(sid).close()


def _real_report(frames_bgr):
    sid = pose.start_session(1)
    lives = [pose.add_frame(sid, 1, cv2.imencode(".jpg", f)[1].tobytes(), i * 100) for i, f in enumerate(frames_bgr)]
    return lives, pose.finish(sid, 1)


def test_real_model_initialises_and_runs_locally(real_pose):
    sid = pose.start_session(1)
    s = pose._sessions[sid]
    assert type(s.landmarker).__name__ == "PoseLandmarker"
    pose.cancel(sid, 1)
    assert pose.active_sessions() == 0


def test_real_model_finds_no_body_in_blank_or_dark_frames(real_pose):
    lives, rep = _real_report([frame(150)] * 60)
    assert all(lv["poses"] == 0 for lv in lives)
    assert rep["quality"]["rating"] == "no body" and pose.active_sessions() == 0
    earth = cv2.resize(cv2.imread(os.path.join(os.path.dirname(__file__), "..", "frontend", "public", "models", "missions", "earth.jpg")), (640, 480))
    lives, rep = _real_report([earth] * 30)  # a lit picture with no person
    assert all(lv["poses"] == 0 for lv in lives)
    lives, rep = _real_report([np.zeros((480, 640, 3), np.uint8)] * 60)
    assert lives[-1]["guidance"] == ["Too dark to see you: add light"]
    assert rep["quality"]["rating"] == "poor" and "too dark to find a body" in rep["quality"]["issues"]


TEST_IMAGE = os.environ.get("ASTRO_POSE_TEST_IMAGE")


@pytest.mark.skipif(not TEST_IMAGE, reason="set ASTRO_POSE_TEST_IMAGE to a local photo of one person (head to hips)")
def test_real_model_on_a_real_person(real_pose):
    img = cv2.imread(TEST_IMAGE)
    scale = min(1.0, pose.MAX_FRAME_SIDE / max(img.shape[:2]))
    img = cv2.resize(img, (int(img.shape[1] * scale), int(img.shape[0] * scale)))
    lives, rep = _real_report([img] * 121)
    assert lives[-1]["poses"] == 1 and lives[-1]["visible"]["shoulders"]
    sh = obs(rep, "shoulder_alignment")
    assert sh["status"] == "measured" and abs(sh["value"]["tilt_deg"]) < 30
    assert obs(rep, "movement")["value"]["label"] in ("very still", "mostly still")  # the same picture 121 times
    lives3, rep3 = _real_report([(img * 0.05).astype(np.uint8)] * 121)
    assert rep3["quality"]["rating"] in ("poor", "no body")
