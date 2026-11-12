"""Astra's abilities: messages + summaries to the surgeon, voice sleep/workout tracking, the
voice-screen tests, memory + follow-ups, and the events her notices listen to."""
import argparse
import time
from datetime import datetime, timedelta, timezone

import pytest

from backend import db, voice_settings
from backend.config import TIME_SCALE
from backend.logic import analysis, astra_memory, sessions
from backend.services import analyst

AHMAD_UID = "9B:25:0F:54"
SAMEER_UID = "2B:ED:20:54"
SURGEON_UID = "D1000001"


@pytest.fixture(scope="module")
def monkeypatch_module():
    from _pytest.monkeypatch import MonkeyPatch
    mp = MonkeyPatch()
    yield mp
    mp.undo()


@pytest.fixture(scope="module")
def app_parts(tmp_path_factory, monkeypatch_module):
    monkeypatch_module.setattr(db, "DB_PATH", str(tmp_path_factory.mktemp("astra") / "test.db"))
    import app as app_module
    args = argparse.Namespace(port=None, simulate=True, wifi=False, wifi_host=None, wifi_port=None,
                              host="0.0.0.0", web_port=5000)
    flask_app, socketio, _ = app_module.create_app(args)
    flask_app.config["TESTING"] = True
    return flask_app, socketio


@pytest.fixture()
def client(app_parts):
    return app_parts[0].test_client()


def login(client, uid):
    assert client.post("/api/auth/nfc_login", json={"uid": uid}).status_code == 200


def _astro_id(uid):
    with db.write_conn() as conn:
        return conn.execute("SELECT astronaut_id FROM tags WHERE uid = ?", (uid,)).fetchone()[0]


def _messages(astro_id):
    with db.write_conn() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM messages WHERE astronaut_id = ? ORDER BY id", (astro_id,))]


# ---- messages and summaries ----
def test_message_to_the_surgeon_goes_with_the_comms_delay(client):
    login(client, AHMAD_UID)
    a = _astro_id(AHMAD_UID)
    before = len(_messages(a))
    res = client.post(f"/api/astronauts/{a}/message", json={"text": "  Slept well,   feeling fine. "})
    assert res.status_code == 200 and "deliver_at" in res.get_json()
    last = _messages(a)[-1]
    assert len(_messages(a)) == before + 1 and last["from_role"] == "crew" and last["body"] == "Slept well, feeling fine."
    assert client.post(f"/api/astronauts/{a}/message", json={"text": " "}).status_code == 400


def test_only_the_astronaut_can_use_astras_abilities(client):
    a = _astro_id(AHMAD_UID)
    assert client.post(f"/api/astronauts/{a}/message", json={"text": "hi"}).status_code == 401
    login(client, SURGEON_UID)  # can see Ahmad's data, but can't act as him
    for path, body in [("message", {"text": "hi"}), ("activity", {"kind": "sleep", "action": "start"}),
                       ("reaction", {"avg_ms": 300}), ("memory", {"text": "x"}), ("summary-report", {})]:
        assert client.post(f"/api/astronauts/{a}/{path}", json=body).status_code == 403, path
    assert client.get(f"/api/astronauts/{a}/memory").status_code == 403
    login(client, SAMEER_UID)
    assert client.post(f"/api/astronauts/{a}/message", json={"text": "hi"}).status_code == 403


def test_summary_report_falls_back_to_the_rules_without_ai(client):
    login(client, AHMAD_UID)
    a = _astro_id(AHMAD_UID)
    res = client.post(f"/api/astronauts/{a}/summary-report", json={"period": "week"})
    body = res.get_json()
    assert res.status_code == 200 and body["source"] == "rules"
    assert body["text"].startswith("Health summary (last 7 days): ")
    assert _messages(a)[-1]["body"] == body["text"]


def test_summary_report_uses_the_ai_when_it_answers(client, monkeypatch):
    login(client, AHMAD_UID)
    a = _astro_id(AHMAD_UID)
    monkeypatch.setattr(analyst, "summary", lambda ctx, period: f"All steady ({period}).")
    body = client.post(f"/api/astronauts/{a}/summary-report", json={"period": "bogus"}).get_json()
    assert body["source"] == "ai" and body["text"] == "Health summary (today): All steady (today)."


# ---- sleep / workout by voice ----
def test_sleep_by_voice_is_measured_on_the_mission_clock(client):
    login(client, AHMAD_UID)
    a = _astro_id(AHMAD_UID)
    assert client.post(f"/api/astronauts/{a}/activity", json={"kind": "sleep", "action": "stop"}).status_code == 409
    assert client.post(f"/api/astronauts/{a}/activity", json={"kind": "sleep", "action": "start"}).get_json()["started"]
    assert client.post(f"/api/astronauts/{a}/activity", json={"kind": "sleep", "action": "start"}).get_json()["already"]
    key = sessions.running_toggle(a, "sleep")
    sessions.open_toggles[key]["started_at"] = time.time() - 7 * 3600 / TIME_SCALE  # 7 mission hours ago
    body = client.post(f"/api/astronauts/{a}/activity", json={"kind": "sleep", "action": "stop"}).get_json()
    assert body["kind"] == "sleep" and body["hours"] == 7.0 and body["level"] in ("GREEN", "YELLOW", "RED")
    assert sessions.running_toggle(a, "sleep") is None
    assert client.post(f"/api/astronauts/{a}/activity", json={"kind": "nap", "action": "start"}).status_code == 400


def test_a_tag_started_workout_can_be_stopped_by_voice(client):
    login(client, AHMAD_UID)
    a = _astro_id(AHMAD_UID)
    sessions.open_toggles["TAG-EX"] = {"astronaut_id": a, "kind": "exercise",
                                       "started_at": time.time() - 30 * 60 / TIME_SCALE, "started_iso": "2026-11-13T00:00:00+00:00"}
    body = client.post(f"/api/astronauts/{a}/activity", json={"kind": "exercise", "action": "stop"}).get_json()
    assert body["minutes"] == 30 and "TAG-EX" not in sessions.open_toggles


# ---- voice-screen tests ----
def test_reaction_and_breathing_are_saved(client):
    login(client, AHMAD_UID)
    a = _astro_id(AHMAD_UID)
    body = client.post(f"/api/astronauts/{a}/reaction", json={"avg_ms": 312.4, "lapses": 1}).get_json()
    assert body["avg_ms"] == 312 and body["level"] in ("GREEN", "YELLOW", "RED")
    for bad in [{"avg_ms": 10}, {"avg_ms": True}, {"avg_ms": 300, "lapses": -1}]:
        assert client.post(f"/api/astronauts/{a}/reaction", json=bad).status_code == 400
    assert client.post(f"/api/astronauts/{a}/breathing", json={"seconds": 64}).get_json()["ok"]
    with db.write_conn() as conn:
        kinds = [r[0] for r in conn.execute("SELECT kind FROM activities WHERE astronaut_id = ?", (a,))]
    assert "reaction" in kinds and "breathing" in kinds


# ---- memory and follow-ups ----
def test_memory_add_list_due_done_delete(client):
    login(client, AHMAD_UID)
    a = _astro_id(AHMAD_UID)
    mid = client.post(f"/api/astronauts/{a}/memory", json={"text": "Left knee hurts since Tuesday", "follow_up_hours": 6}).get_json()["id"]
    assert any(m["id"] == mid for m in client.get(f"/api/astronauts/{a}/memory").get_json())
    assert all(m["id"] != mid for m in client.get(f"/api/astronauts/{a}/memory?due=1").get_json())
    with db.write_conn() as conn:
        conn.execute("UPDATE astra_memory SET follow_up_at = ? WHERE id = ?",
                     ((datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat(), mid))
    assert any(m["id"] == mid for m in client.get(f"/api/astronauts/{a}/memory?due=1").get_json())
    assert client.post(f"/api/astronauts/{a}/memory/{mid}/done").status_code == 200
    assert all(m["id"] != mid for m in client.get(f"/api/astronauts/{a}/memory?due=1").get_json())
    assert client.delete(f"/api/astronauts/{a}/memory/{mid}").status_code == 200
    assert client.delete(f"/api/astronauts/{a}/memory/{mid}").status_code == 404
    assert client.post(f"/api/astronauts/{a}/memory", json={"text": "x", "follow_up_hours": 500}).status_code == 400


def test_low_mood_pain_and_symptoms_get_a_follow_up(client):
    login(client, AHMAD_UID)
    a = _astro_id(AHMAD_UID)
    client.post(f"/api/astronauts/{a}/mood", json={"mood": "low"})
    client.post(f"/api/astronauts/{a}/mood", json={"mood": "great"})  # no note for a good mood
    client.post(f"/api/astronauts/{a}/discomfort", json={"region": "skeleton", "intensity": 7})
    client.post(f"/api/astronauts/{a}/discomfort", json={"region": "heart", "intensity": 2})
    client.post(f"/api/astronauts/{a}/symptoms", json={"items": ["headache"]})
    texts = [m["text"] for m in client.get(f"/api/astronauts/{a}/memory").get_json()]
    assert "Felt low (mood check-in)" in texts and "Felt great (mood check-in)" not in texts
    assert any("pain 7/10" in t for t in texts) and not any("pain 2/10" in t for t in texts)
    assert any(t.startswith("Reported ") for t in texts)
    mem = client.get(f"/api/astronauts/{a}/memory").get_json()
    assert all(m["follow_up_at"] for m in mem if m["source"] in ("mood", "pain", "symptoms"))


def test_due_follow_ups_are_pushed_once(app_parts):
    a = _astro_id(AHMAD_UID)
    with db.write_conn() as conn:
        mid = astra_memory.add(conn, a, "Back pain 6/10", 1)
    later = datetime.now(timezone.utc) + timedelta(hours=1)
    sent = []
    astra_memory.emit_due(lambda ev, data: sent.append((ev, data)), now=later)
    astra_memory.emit_due(lambda ev, data: sent.append((ev, data)), now=later)
    ours = [d for ev, d in sent if ev == "astra_followup" and d["id"] == mid]
    assert len(ours) == 1 and ours[0]["astronaut_id"] == a and ours[0]["text"] == "Back pain 6/10"


def test_follow_up_hours_run_on_the_mission_clock():
    now = datetime(2026, 11, 13, tzinfo=timezone.utc)
    assert astra_memory.follow_up_at(3, now) == now + timedelta(seconds=3 * 3600 / TIME_SCALE)


# ---- what Astra knows in the chat ----
def test_chat_context_has_messages_alerts_and_memories(client):
    login(client, AHMAD_UID)
    a = _astro_id(AHMAD_UID)
    client.post(f"/api/astronauts/{a}/alert", json={"text": "I feel dizzy"})
    with db.write_conn() as conn:
        astra_memory.add(conn, a, "Allergic to ibuprofen")
        conn.execute("UPDATE messages SET deliver_at = ? WHERE astronaut_id = ?", ("2000-01-01T00:00:00+00:00", a))
        chat_ctx, _, _ = analysis.build_context(conn, a, for_chat=True)
        plain_ctx, _, _ = analysis.build_context(conn, a)
    assert "Latest messages with the flight surgeon" in chat_ctx
    assert '"I feel dizzy" (not seen yet)' in chat_ctx
    assert "Allergic to ibuprofen" in chat_ctx and "[#" in chat_ctx
    assert "Allergic to ibuprofen" not in plain_ctx  # the health analysis doesn't need it


# ---- the events Astra's notices listen to ----
def test_alert_acknowledged_tells_whose_alert_and_when(app_parts):
    flask_app, socketio = app_parts
    c = flask_app.test_client()
    login(c, AHMAD_UID)
    a = _astro_id(AHMAD_UID)
    c.post(f"/api/astronauts/{a}/alert", json={"text": "Chest feels tight"})
    with db.write_conn() as conn:
        alert_id = conn.execute("SELECT id FROM alerts WHERE text = 'Chest feels tight'").fetchone()[0]
    sio = socketio.test_client(flask_app, flask_test_client=c)
    sio.get_received()
    login(c, SURGEON_UID)
    assert c.post(f"/api/alerts/{alert_id}/ack").status_code == 200
    got = [e["args"][0] for e in sio.get_received() if e["name"] == "alert_acknowledged"]
    assert got and got[0]["astronaut_id"] == a and got[0]["text"] == "Chest feels tight" and got[0]["deliver_at"]


def test_notices_setting_is_validated():
    assert voice_settings.DEFAULTS["notices"] == "speak"
    ok, err = voice_settings.validate({"notices": "show"}, voice_settings.DEFAULTS)
    assert err is None and ok["notices"] == "show"
    assert voice_settings.validate({"notices": "loud"}, voice_settings.DEFAULTS)[1]
