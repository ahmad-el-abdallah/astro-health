"""The live wearable: the build helpers that turn raw ECG / respiration / skin conductance
into per-second numbers (backend/sensor/build.py), the replay feed
(backend/logic/sensor_feed.py) and its routes."""
import argparse
import math

import pytest

from backend import db
from backend.logic import sensor_feed
from backend.sensor import build

HZ = 250


def synthetic_ecg(bpm, seconds, hz=HZ):
    """A flat line with a sharp spike (an R-peak) every beat, plus slow baseline wander."""
    period = 60 / bpm
    out = []
    for i in range(int(seconds * hz)):
        t = i / hz
        phase = (t % period) / period
        spike = 1000 * math.exp(-((phase - 0.3) * period * 60) ** 2)
        out.append(spike + 200 * math.sin(2 * math.pi * 0.2 * t))
    return out


def test_heart_rate_from_a_synthetic_ecg():
    for bpm in (55, 72, 110):
        ecg = synthetic_ecg(bpm, 40)
        hr = build.heart_rate(build.r_peaks(ecg, HZ), HZ, 40)
        settled = [v for v in hr[15:] if v]
        assert settled and all(abs(v - bpm) <= 2 for v in settled), (bpm, settled[:5])


def test_heart_rate_with_beats_pointing_down():
    ecg = [-v for v in synthetic_ecg(64, 30)]
    hr = [v for v in build.heart_rate(build.r_peaks(ecg, HZ), HZ, 30)[15:] if v]
    assert hr and all(abs(v - 64) <= 2 for v in hr)


def test_breathing_rate_from_a_synthetic_belt():
    for per_min in (8, 15, 24):
        resp = [600 + 40 * math.sin(2 * math.pi * per_min / 60 * i / HZ) for i in range(60 * HZ)]
        br = build.breathing_rate(resp, HZ, 60)
        assert all(abs(v - per_min) <= 2 for v in br[40:]), (per_min, br[40:45])


def test_stress_ignores_slow_drift_but_catches_a_quick_rise():
    drift = [800 + 0.5 * s for s in range(200)]           # electrodes warming: slow climb
    with_startle = drift[:]
    for s in range(120, 128):
        with_startle[s] += 60                              # a sudden skin response
    calm = build.stress_scale(drift)
    assert max(calm) <= 40                                 # the climb alone isn't "stress"
    st = build.stress_scale(with_startle)
    assert max(st[120:128]) == 100 and st[60] <= 40


def test_median_filter_drops_a_one_second_glitch():
    assert build.median_filter([62, 62, 63, 101, 62, 63, 62])[3] == 62


# ---- the replay feed ----

@pytest.fixture
def feed_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "t.db"))
    db.init_db()


def test_the_recording_is_there_and_plausible():
    segs = {s["id"]: s for s in sensor_feed.segments()}
    assert set(segs) == {"focus", "multitask", "startle"}
    data = sensor_feed._load()
    for seg in data["segments"]:
        assert seg["seconds"] > 300
        assert all(40 <= v <= 130 for v in seg["hr"])
        assert all(4 <= v <= 30 for v in seg["br"])
        assert len(seg["ecg"]) == seg["seconds"] * data["trace_hz"]
    assert sum(data["by_id"]["startle"]["event"]) > 0 and sum(data["by_id"]["focus"]["event"]) == 0


def test_feed_emits_each_second_once_and_never_loops(feed_db):
    sent = []
    st = sensor_feed.start(1, "startle", now=1000.0)
    assert st["on"] and st["second"] == 0
    sensor_feed.tick(lambda ev, data: sent.append((ev, data)), now=1000.2)
    sensor_feed.tick(lambda ev, data: sent.append((ev, data)), now=1000.7)  # same second: nothing new
    sensor_feed.tick(lambda ev, data: sent.append((ev, data)), now=1001.1)
    secs = [d["second"] for ev, d in sent if ev == "sensor"]
    assert secs == [0, 1]
    first = sent[0][1]
    assert first["astronaut_id"] == 1 and len(first["ecg"]) == 100 and {"hr", "br", "stress", "event"} <= set(first)
    with db.write_conn() as conn:  # nothing is saved while it runs
        assert conn.execute("SELECT COUNT(*) FROM readings").fetchone()[0] == 0


def test_a_test_that_reaches_its_end_finishes_and_is_saved_as_a_check(feed_db):
    sent, asked = [], []
    length = sensor_feed.start(1, "startle", now=0.0)["seconds"]
    sensor_feed.tick(lambda ev, data: sent.append((ev, data)), now=length + 0.5, request_analysis=asked.append)
    assert sensor_feed.status(1) is None  # it stopped by itself
    events = [ev for ev, _ in sent]
    assert "sensor_changed" in events and "assessment" in events
    done = next(d for ev, d in sent if ev == "sensor_changed")
    assert done["finished"] and done["result"]["results"]["startles"] >= 1
    assert asked == [1]  # the AI is asked once, for the whole test
    with db.write_conn() as conn:
        rows = conn.execute("SELECT indicator, source FROM readings ORDER BY indicator").fetchall()
        assessments = conn.execute("SELECT note FROM assessments").fetchall()
    assert [r[0] for r in rows] == ["heart_rate", "respiration_rate", "stress"]
    assert {r[1] for r in rows} == {"wearable"}
    assert len(assessments) == 1 and "startle test" in assessments[0][0]


def test_finish_early_saves_what_was_played_and_cancel_saves_nothing(feed_db):
    sensor_feed.start(1, "focus", now=0.0)
    result = sensor_feed.stop(1, now=40.0)
    assert result["results"]["seconds"] == 40
    data = sensor_feed._load()["by_id"]["focus"]
    assert result["results"]["heart_rate"] == round(sum(data["hr"][:40]) / 40)
    sensor_feed.start(1, "focus", now=100.0)
    assert sensor_feed.stop(1, save=False, now=150.0) is None
    sensor_feed.start(1, "focus", now=200.0)
    assert sensor_feed.stop(1, now=202.0) is None  # under MIN_SAVE_S: nothing worth saving
    with db.write_conn() as conn:
        assert conn.execute("SELECT COUNT(*) FROM assessments").fetchone()[0] == 1


def test_context_line_mentions_a_recent_startle():
    data = sensor_feed._load()["by_id"]["startle"]
    first_event = data["event"].index(1)
    sensor_feed.start(1, "startle", now=0.0)
    line = sensor_feed.context_line(1, now=first_event + 2)
    assert "Live wearable ON" in line and "startle" in line
    sensor_feed.stop(1)
    assert sensor_feed.context_line(1) is None


def test_unknown_segment_is_refused():
    with pytest.raises(ValueError):
        sensor_feed.start(1, "nap-time")


# ---- routes ----

@pytest.fixture(scope="module")
def client(tmp_path_factory):
    from _pytest.monkeypatch import MonkeyPatch
    mp = MonkeyPatch()
    mp.setattr(db, "DB_PATH", str(tmp_path_factory.mktemp("sensor_api") / "test.db"))
    import app as app_module
    args = argparse.Namespace(port=None, simulate=True, wifi=False, wifi_host=None, wifi_port=None,
                              host="0.0.0.0", web_port=5000)
    flask_app, _, _ = app_module.create_app(args)
    flask_app.config["TESTING"] = True
    yield flask_app.test_client()
    mp.undo()


def login(client, uid):
    assert client.post("/api/auth/nfc_login", json={"uid": uid}).status_code == 200


def test_routes_start_stop_and_only_the_astronaut_controls_it(client):
    assert client.get("/api/sensor/segments").get_json()["segments"][0]["id"] == "focus"
    login(client, "9B:25:0F:54")  # Ahmad, astronaut 1
    assert client.put("/api/astronauts/1/sensor", json={"segment": "nope"}).status_code == 400
    res = client.put("/api/astronauts/1/sensor", json={"segment": "startle"})
    assert res.status_code == 200 and res.get_json()["segment"] == "startle"
    assert client.get("/api/astronauts/1/summary").get_json()["sensor"]["on"] is True
    assert client.put("/api/astronauts/2/sensor", json={"segment": "focus"}).status_code == 403  # someone else's
    login(client, "D1000001")  # the surgeon watches, but can't switch it
    assert client.get("/api/astronauts/1/sensor").get_json()["on"] is True
    assert client.put("/api/astronauts/1/sensor", json={"on": False}).status_code == 403
    login(client, "9B:25:0F:54")
    res = client.put("/api/astronauts/1/sensor", json={"on": False}).get_json()  # finish now
    assert res["on"] is False  # (just started, so under MIN_SAVE_S: finished without a result)
    assert client.get("/api/astronauts/1/summary").get_json()["sensor"] is None


def test_finishing_through_the_route_counts_as_todays_vitals_check(client, monkeypatch):
    login(client, "9B:25:0F:54")
    client.put("/api/astronauts/1/sensor", json={"segment": "multitask"})
    feed = sensor_feed._feeds[1]
    feed["started"] -= 90  # pretend it has been running for 90 s
    res = client.put("/api/astronauts/1/sensor", json={"on": False}).get_json()
    assert res["finished"] and res["result"]["results"]["seconds"] >= 90
    summary = client.get("/api/astronauts/1/summary").get_json()
    assert summary["today"]["respiration_rate"]["value"] == res["result"]["results"]["respiration_rate"]
    assert summary["today"]["heart_rate"]["value"] == res["result"]["results"]["heart_rate"]  # the latest vitals now
    # an assessment, like the Assess button's: that's what ticks off Today's vitals check
    assert summary["last_check"] is not None and summary["overall_level"] == res["result"]["overall_level"]
