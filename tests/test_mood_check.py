"""The daily mood check: questions per day, the AI verdict (and its fallbacks), the routes,
and that its recordings stay out of "Latest Conversation Analysis"."""
import argparse
import json

import pytest

from backend import db
from backend.logic import mood_check, voice_talks
from backend.services import analyst

AHMAD, SURGEON = "9B:25:0F:54", "D1000001"


def test_three_questions_same_all_day_new_the_next_day():
    q = mood_check.questions_for(1, 4)
    assert len(q) == 3 and len(set(q)) == 3
    assert q == mood_check.questions_for(1, 4)
    assert q != mood_check.questions_for(1, 5)
    pool = set(json.load(open("config/mood_questions.json"))["questions"])
    assert set(q) <= pool


def test_tone_mood_mapping():
    assert mood_check.tone_mood({"happy": 0.9, "calm": 0.1})[0] == "great"
    assert mood_check.tone_mood({"calm": 1.0})[0] == "good"
    assert mood_check.tone_mood({"sad": 0.8, "calm": 0.2})[0] == "low"
    assert mood_check.tone_mood({"angry": 1.0})[0] == "rough"


def test_parse_mood_check_validates():
    ok = analyst.parse_mood_check('{"mood": "Low", "summary": " You  sound tired. ", "emotions": ["Tired", 3, "worried"]}')
    assert ok == {"mood": "low", "summary": "You sound tired.", "emotions": ["tired", "worried"]}
    for bad in ('{"mood": "meh", "summary": "x"}', '{"mood": "good", "summary": ""}', '{"mood": true, "summary": "x"}', "nope"):
        with pytest.raises(analyst.MalformedOutputError):
            analyst.parse_mood_check(bad)


ANSWERS = [{"question": "q1", "text": "I'm exhausted and stressed"}, {"question": "q2", "text": "bad sleep, tired"},
           {"question": "q3", "text": "worried about the experiment"}]


def test_judge_falls_back_to_the_voice_tone_then_to_the_words():
    # tests never have an AI key (conftest), so this is the fallback path
    tone = {"dominant": "calm", "confidence": 0.8, "probabilities": {"calm": 0.8, "happy": 0.2}, "phrases": 3}
    v = mood_check.judge(ANSWERS, tone)
    assert v["source"] == "rules" and v["mood"] == "good" and "calm" in v["summary"]
    v = mood_check.judge(ANSWERS, None)
    assert v["source"] == "rules" and v["mood"] == "low"


def test_judge_uses_the_ai_when_it_answers(monkeypatch):
    seen = {}

    def fake(answers, tone_text):
        seen.update(answers=answers, tone=tone_text)
        return {"mood": "okay", "summary": "You sound a bit flat today.", "emotions": ["flat"]}

    monkeypatch.setattr(analyst, "mood_check", fake)
    tone = {"dominant": "sad", "confidence": 0.6, "probabilities": {"sad": 0.6, "calm": 0.4}, "phrases": 2}
    v = mood_check.judge(ANSWERS, tone)
    assert v["source"] == "ai" and v["mood"] == "okay"
    assert "mostly sad" in seen["tone"] and seen["answers"] == ANSWERS


# ---- routes ----

@pytest.fixture(scope="module")
def client(tmp_path_factory):
    from _pytest.monkeypatch import MonkeyPatch
    mp = MonkeyPatch()
    mp.setattr(db, "DB_PATH", str(tmp_path_factory.mktemp("mood_check") / "test.db"))
    import app as app_module
    args = argparse.Namespace(port=None, simulate=True, wifi=False, wifi_host=None, wifi_port=None,
                              host="0.0.0.0", web_port=5000)
    flask_app, _, _ = app_module.create_app(args)
    flask_app.config["TESTING"] = True
    yield flask_app.test_client()
    mp.undo()


def login(client, uid):
    assert client.post("/api/auth/nfc_login", json={"uid": uid}).status_code == 200


def test_the_routes_save_a_mood_reading_and_only_the_astronaut_takes_it(client):
    login(client, AHMAD)
    got = client.get("/api/astronauts/1/mood-check").get_json()
    assert len(got["questions"]) == 3 and got["today"] is None
    assert client.post("/api/astronauts/1/mood-check", json={"answers": ["only one"]}).status_code == 400
    assert client.post("/api/astronauts/1/mood-check", json={"answers": ["a", " ", "c"]}).status_code == 400
    res = client.post("/api/astronauts/1/mood-check", json={"answers": ["I feel great, rested and happy", "good", "fine"]})
    assert res.status_code == 200
    out = res.get_json()
    assert out["mood"] in mood_check.MOOD_SCORES and out["checked_by"] == "rules"
    assert [a["question"] for a in out["answers"]] == got["questions"]
    with db.write_conn() as conn:
        row = conn.execute("SELECT source, value_json FROM readings WHERE indicator = 'mood' ORDER BY id DESC").fetchone()
    assert row["source"] == "voice_check" and json.loads(row["value_json"])["score"] == out["score"]
    assert client.get("/api/astronauts/1/mood-check").get_json()["today"]["mood"] == out["mood"]
    # the surgeon can see it, but can't take it for them
    login(client, SURGEON)
    assert client.get("/api/astronauts/1/mood-check").get_json()["today"]["mood"] == out["mood"]
    assert client.post("/api/astronauts/1/mood-check", json={"answers": ["a", "b", "c"]}).status_code == 403


def test_a_mood_check_recording_never_becomes_the_latest_conversation(client):
    login(client, AHMAD)
    with db.write_conn() as conn:
        before = voice_talks.latest(conn, 1)
        talk = voice_talks.create(conn, 1, "mood_check")
        voice_talks.finish(conn, talk["id"], reason="test")
        assert voice_talks.latest(conn, 1) == before
    res = client.post("/api/astronauts/1/mood-check", json={"answers": ["fine", "ok", "good"], "talk_id": talk["id"]})
    assert res.status_code == 200 and res.get_json()["talk_id"] == talk["id"]
    # someone else's conversation can't be used
    with db.write_conn() as conn:
        other = voice_talks.create(conn, 2, "mood_check")
    assert client.post("/api/astronauts/1/mood-check", json={"answers": ["a", "b", "c"], "talk_id": other["id"]}).status_code == 403
