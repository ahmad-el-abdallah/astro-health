""""Wanna talk?" conversations (backend/logic/voice_talks.py + the /voice-talks routes):
every phrase belongs to one server-made conversation, conversations never mix, the result is
computed only after the conversation is finished, stale ones finish themselves, and adding
the table keeps every existing row. A fake predictor stands in for the model."""
import argparse
import io
import json
import math
import sqlite3
import wave
from datetime import datetime, timedelta, timezone

import pytest

from backend import db
from backend.logic import voice_talks
from backend.services import emotion

AHMAD_UID = "9B:25:0F:54"     # astronaut 1
SAMEER_UID = "2B:ED:20:54"    # astronaut 2
SURGEON_UID = "D1000001"


def wav(seconds=2.0):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"".join(int(8000 * math.sin(i / 7)).to_bytes(2, "little", signed=True) for i in range(int(16000 * seconds))))
    return buf.getvalue()


def scores(**top):
    """Seven probabilities: the given ones, the rest sharing what's left."""
    rest = [k for k in emotion.LABELS if k not in top]
    left = (1.0 - sum(top.values())) / len(rest)
    return {k: top.get(k, left) for k in emotion.LABELS}


@pytest.fixture()
def model(monkeypatch):
    """The model 'ready'; each analysis returns the next queued set of scores."""
    queue = []
    monkeypatch.setattr(emotion, "_predict_samples", lambda samples: dict(queue.pop(0)))
    monkeypatch.setitem(emotion._state, "state", "ready")
    return queue


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    from _pytest.monkeypatch import MonkeyPatch
    mp = MonkeyPatch()
    mp.setattr(db, "DB_PATH", str(tmp_path_factory.mktemp("voice_talks") / "test.db"))
    import app as app_module
    args = argparse.Namespace(port=None, simulate=True, wifi=False, wifi_host=None, wifi_port=None, host="0.0.0.0", web_port=5000)
    flask_app, _s, _b = app_module.create_app(args)
    flask_app.config["TESTING"] = True
    yield flask_app.test_client()
    mp.undo()


def login(client, uid):
    assert client.post("/api/auth/nfc_login", json={"uid": uid}).status_code == 200


def open_talk(client, astro=1):
    res = client.post(f"/api/astronauts/{astro}/voice-talks", json={})
    assert res.status_code == 201, res.get_json()
    return res.get_json()["talk_id"]


def phrase(client, talk, astro=1):
    return client.post(f"/api/astronauts/{astro}/voice-tone?talk={talk}", data=wav(), content_type="audio/wav")


def finish(client, talk, astro=1, **counts):
    return client.post(f"/api/astronauts/{astro}/voice-talks/{talk}/finish", json=counts)


def latest(client, astro=1):
    res = client.get(f"/api/astronauts/{astro}/voice-talks/latest")
    assert res.status_code == 200
    return res.get_json()["talk"]


# ------------------------------------------------------------ conversation ids

def test_each_conversation_gets_its_own_server_made_id(client, model):
    login(client, AHMAD_UID)
    a, b = open_talk(client), open_talk(client)
    assert a != b and a.startswith("talk-") and len(a) == 37


def test_only_the_astronaut_can_open_and_finish_their_conversations(client, model):
    client.post("/api/auth/logout")
    assert client.post("/api/astronauts/1/voice-talks", json={}).status_code == 401
    login(client, SURGEON_UID)
    assert client.post("/api/astronauts/1/voice-talks", json={}).status_code == 403
    login(client, AHMAD_UID)
    talk = open_talk(client)
    login(client, SAMEER_UID)
    assert finish(client, talk).status_code == 403
    assert client.post(f"/api/astronauts/2/voice-talks/{talk}/finish", json={}).status_code == 404  # not Sameer's


def test_a_phrase_needs_a_real_conversation_of_the_same_astronaut(client, model):
    login(client, AHMAD_UID)
    model.append(scores(calm=0.9))
    assert phrase(client, "talk-made-up-by-the-browser").status_code == 404
    login(client, SAMEER_UID)
    sameer_talk = open_talk(client, astro=2)
    login(client, AHMAD_UID)
    assert phrase(client, sameer_talk).status_code == 404  # Ahmad can't add to Sameer's conversation


def test_every_phrase_of_one_conversation_carries_its_id(client, model):
    login(client, AHMAD_UID)
    talk = open_talk(client)
    for s in (scores(calm=0.7), scores(happy=0.6), scores(calm=0.5)):
        model.append(s)
        assert phrase(client, talk).status_code == 200
    rows = [r for r in client.get("/api/astronauts/1/voice-tone?days=1").get_json() if r["talk_id"] == talk]
    assert len(rows) == 3


# ------------------------------------------------------------ aggregation

def test_result_is_the_average_of_that_conversations_phrases(client, model):
    login(client, AHMAD_UID)
    talk = open_talk(client)
    model.extend([scores(calm=0.8, happy=0.1), scores(calm=0.4, happy=0.5)])
    phrase(client, talk)
    phrase(client, talk)
    res = finish(client, talk, phrases_sent=2).get_json()
    assert res["status"] == "complete"
    r = res["result"]
    assert r["phrases"] == 2 and res["phrases_analysed"] == 2
    assert r["probabilities"]["calm"] == pytest.approx(0.6, abs=1e-3)
    assert r["probabilities"]["happy"] == pytest.approx(0.3, abs=1e-3)
    assert set(r["probabilities"]) == set(emotion.LABELS)
    assert sum(r["probabilities"].values()) == pytest.approx(1.0, abs=2e-3)
    assert r["dominant"] == "calm" and r["confidence"] == r["probabilities"]["calm"]


def test_two_conversations_are_never_mixed(client, model):
    login(client, AHMAD_UID)
    one, two = open_talk(client), open_talk(client)
    model.extend([scores(sad=0.9), scores(happy=0.9), scores(sad=0.8)])
    phrase(client, one)
    phrase(client, two)  # interleaved
    phrase(client, one)
    a = finish(client, one).get_json()["result"]
    b = finish(client, two).get_json()["result"]
    assert a["phrases"] == 2 and a["dominant"] == "sad"
    assert b["phrases"] == 1 and b["dominant"] == "happy"
    assert b["probabilities"]["sad"] < 0.1  # none of the other conversation's sadness


def test_the_latest_shows_only_the_last_conversation_not_history(client, model):
    login(client, AHMAD_UID)
    old = open_talk(client)
    model.append(scores(angry=0.9))
    phrase(client, old)
    finish(client, old)
    new = open_talk(client)
    model.append(scores(calm=0.9))
    phrase(client, new)
    finish(client, new)
    t = latest(client)
    assert t["talk_id"] == new
    assert t["result"]["dominant"] == "calm" and t["result"]["phrases"] == 1
    # the history route still has both
    ids = {r["talk_id"] for r in client.get("/api/astronauts/1/voice-tone?days=1").get_json()}
    assert {old, new} <= ids


# ------------------------------------------------------------ pending analyses and completion

def test_result_waits_until_the_conversation_is_finished(client, model):
    login(client, AHMAD_UID)
    talk = open_talk(client)
    model.append(scores(happy=0.7))
    phrase(client, talk)
    # still in the call: not "the latest conversation" yet
    assert latest(client)["talk_id"] != talk
    # call ended, one analysis still running in the browser
    closed = client.post(f"/api/astronauts/1/voice-talks/{talk}/close", json={"phrases_sent": 2}).get_json()
    assert closed["status"] == "analysing"
    t = latest(client)
    assert t["talk_id"] == talk and t["status"] == "analysing" and t["result"] is None
    assert t["phrases_sent"] == 2 and t["phrases_analysed"] == 1  # progress for the loading state
    # the pending analysis lands AFTER the close -- still counted for this conversation
    model.append(scores(happy=0.5))
    assert phrase(client, talk).status_code == 200
    done = finish(client, talk, phrases_sent=2).get_json()
    assert done["status"] == "complete" and done["result"]["phrases"] == 2


def test_finish_is_idempotent_and_closes_the_conversation(client, model):
    login(client, AHMAD_UID)
    talk = open_talk(client)
    model.append(scores(calm=0.9))
    phrase(client, talk)
    first = finish(client, talk, phrases_sent=1).get_json()
    second = finish(client, talk, phrases_sent=5, phrases_failed=5).get_json()
    assert second["result"] == first["result"] and second["phrases_sent"] == 1
    model.append(scores(sad=0.9))
    assert phrase(client, talk).status_code == 409  # no phrases after it's finished


def test_no_analysed_phrases_is_empty_and_all_failed_is_an_error(client, model):
    login(client, AHMAD_UID)
    empty = open_talk(client)
    e = finish(client, empty, phrases_sent=3, phrases_skipped=3).get_json()
    assert e["status"] == "complete" and e["result"] is None and e["phrases_skipped"] == 3
    failed = open_talk(client)
    f = finish(client, failed, phrases_sent=2, phrases_failed=2).get_json()
    assert f["status"] == "failed" and f["result"] is None


def test_a_conversation_the_browser_never_finished_finishes_itself(client, model):
    login(client, AHMAD_UID)
    talk = open_talk(client)
    model.append(scores(surprised=0.8))
    phrase(client, talk)
    client.post(f"/api/astronauts/1/voice-talks/{talk}/close", json={"phrases_sent": 3})
    conn = db.get_conn()
    try:
        assert voice_talks.finalize_stale(conn, 1) == 0  # not stale yet
        later = datetime.now(timezone.utc) + timedelta(seconds=voice_talks.STALE_ANALYSING_S + 5)
        assert voice_talks.finalize_stale(conn, 1, now=later) == 1
        conn.commit()
    finally:
        conn.close()
    t = latest(client)
    assert t["talk_id"] == talk and t["status"] == "complete" and t["finish_reason"] == "timed out"
    assert t["result"]["dominant"] == "surprised"


def test_latest_survives_a_reload_it_comes_from_the_database(client, model):
    login(client, AHMAD_UID)
    talk = open_talk(client)
    model.append(scores(fearful=0.6))
    phrase(client, talk)
    finish(client, talk)
    first = latest(client)
    # a different browser session (a page refresh, another tab) gets the same answer
    client.post("/api/auth/logout")
    login(client, AHMAD_UID)
    assert latest(client) == first


def test_the_surgeon_can_view_the_latest_conversation(client, model):
    login(client, SURGEON_UID)
    assert client.get("/api/astronauts/1/voice-talks/latest").status_code == 200
    login(client, SAMEER_UID)
    assert client.get("/api/astronauts/1/voice-talks/latest").status_code == 403


# ------------------------------------------------------------ the new table keeps old data

def test_adding_the_table_keeps_existing_readings_mood_and_voice_tone(tmp_path, monkeypatch):
    """A database from before conversations existed (voice_tone rows with browser-made talk
    ids, readings, mood): init_db() adds voice_talks and changes nothing else."""
    path = str(tmp_path / "old.db")
    old = sqlite3.connect(path)
    old.executescript("""
        CREATE TABLE readings (id INTEGER PRIMARY KEY AUTOINCREMENT, astronaut_id INTEGER NOT NULL, ts TEXT NOT NULL,
            indicator TEXT NOT NULL, value_json TEXT NOT NULL, level TEXT NOT NULL, source TEXT NOT NULL);
        CREATE TABLE voice_tone (id INTEGER PRIMARY KEY AUTOINCREMENT, astronaut_id INTEGER NOT NULL, ts TEXT NOT NULL,
            talk_id TEXT NOT NULL, label TEXT NOT NULL, confidence REAL NOT NULL, scores_json TEXT NOT NULL,
            duration_s REAL NOT NULL, model TEXT NOT NULL);
    """)
    old.execute("INSERT INTO readings (astronaut_id, ts, indicator, value_json, level, source) VALUES (2, '2026-11-13T10:00:00+00:00', 'mood', '{\"mood\": \"good\", \"score\": 4}', 'GREEN', 'manual')")
    old.execute("INSERT INTO voice_tone (astronaut_id, ts, talk_id, label, confidence, scores_json, duration_s, model) VALUES (2, '2026-11-13T13:11:27+00:00', 'talk-mwezvylk', 'happy', 0.98, ?, 4.5, 'x')",
                (json.dumps(scores(happy=0.98)),))
    old.commit()
    before = {t: old.execute(f"SELECT * FROM {t}").fetchall() for t in ("readings", "voice_tone")}
    old.close()

    monkeypatch.setattr(db, "DB_PATH", path)
    db.init_db()
    db.init_db()  # twice: still fine

    conn = sqlite3.connect(path)
    try:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert "voice_talks" in tables
        for t, rows in before.items():
            assert conn.execute(f"SELECT * FROM {t}").fetchall() == rows
        cols = {r[1] for r in conn.execute("PRAGMA table_info(voice_talks)")}
        assert {"id", "astronaut_id", "status", "result_json", "phrases_sent", "phrases_analysed"} <= cols
        assert not any("audio" in c or "wav" in c for c in cols)
    finally:
        conn.close()
