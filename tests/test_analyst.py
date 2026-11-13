import json

import pytest

from backend import config
from backend.services import analyst

STATES = {"well", "sleeping", "possibly_sick"}
INDS = {"heart_rate", "temperature"}


def good(**over):
    data = {
        "state": "possibly_sick", "overall_level": "YELLOW",
        "indicator_levels": {"heart_rate": "GREEN", "temperature": "YELLOW"},
        "body_levels": {"immune": "YELLOW"},
        "summary": "Slight fever.", "reasons": ["Temperature 37.9 °C"], "advice": ["Rest and drink water."],
        "alert_surgeon": False,
    }
    data.update(over)
    return json.dumps(data)


def test_parse_accepts_a_valid_answer():
    out = analyst.parse(good(), STATES, INDS)
    assert out["state"] == "possibly_sick"
    assert out["indicator_levels"] == {"heart_rate": "GREEN", "temperature": "YELLOW"}
    assert out["body_levels"] == {"immune": "YELLOW"}
    assert out["alert_surgeon"] is False


def test_parse_handles_code_fences():
    assert analyst.parse("```json\n" + good() + "\n```", STATES, INDS)["overall_level"] == "YELLOW"


@pytest.mark.parametrize("bad", [
    good(state="dancing"),
    good(overall_level="ORANGE"),
    good(indicator_levels={"heart_rate": "BLUE"}),
    good(alert_surgeon="yes"),
    good(alert_surgeon=1),
    good(summary="   "),
    "I think they are fine.",
    "[1, 2, 3]",
])
def test_parse_rejects_bad_answers(bad):
    with pytest.raises(analyst.MalformedOutputError):
        analyst.parse(bad, STATES, INDS)


def test_parse_drops_unknown_indicators_and_regions_and_caps_text():
    raw = good(indicator_levels={"heart_rate": "GREEN", "made_up": "RED"}, body_levels={"tail": "RED", "heart": "GREEN"},
               summary="x" * 1000, reasons=["a", "b", "c", "d", "e", 7], advice=["1", "2", "3", "4"])
    out = analyst.parse(raw, STATES, INDS)
    assert out["indicator_levels"] == {"heart_rate": "GREEN"}
    assert out["body_levels"] == {"heart": "GREEN"}
    assert len(out["summary"]) == analyst.MAX_SUMMARY
    assert out["reasons"] == ["a", "b", "c", "d"] and out["advice"] == ["1", "2", "3"]


def test_available_needs_a_key(monkeypatch):
    monkeypatch.setattr(config, "ai_api_key", lambda: None)
    assert analyst.available() is False
    monkeypatch.setattr(config, "ai_api_key", lambda: "gsk_fake")
    monkeypatch.setattr(analyst, "_backoff_until", 0.0)
    assert analyst.available() is True


def test_analyze_retries_once_on_a_malformed_answer(monkeypatch):
    monkeypatch.setattr(config, "ai_api_key", lambda: "gsk_fake")
    monkeypatch.setattr(analyst, "_backoff_until", 0.0)
    answers = iter(["not json at all", good()])
    calls = []

    def fake_call(messages):
        calls.append(messages)
        return next(answers)

    monkeypatch.setattr(analyst, "_call_once", fake_call)
    out = analyst.analyze("context", ["heart_rate", "temperature"])
    assert out["state"] == "possibly_sick"
    assert len(calls) == 2
    assert calls[1][-2] == {"role": "assistant", "content": "not json at all"}  # shown its own bad answer


def test_analyze_gives_up_after_two_malformed_answers(monkeypatch):
    monkeypatch.setattr(config, "ai_api_key", lambda: "gsk_fake")
    monkeypatch.setattr(analyst, "_backoff_until", 0.0)
    monkeypatch.setattr(analyst, "_call_once", lambda m: "nope")
    with pytest.raises(analyst.MalformedOutputError):
        analyst.analyze("context", ["heart_rate"])


def test_analyze_does_not_retry_a_network_error(monkeypatch):
    monkeypatch.setattr(config, "ai_api_key", lambda: "gsk_fake")
    monkeypatch.setattr(analyst, "_backoff_until", 0.0)
    calls = []

    def boom(messages):
        calls.append(1)
        raise analyst.AnalystError("AI unreachable")

    monkeypatch.setattr(analyst, "_call_once", boom)
    with pytest.raises(analyst.AnalystError):
        analyst.analyze("context", ["heart_rate"])
    assert len(calls) == 1


def test_system_prompt_lists_every_state_and_asks_for_json():
    cfg = config.ai_analyst()
    prompt = analyst._system_prompt(cfg)
    assert "JSON" in prompt
    for s in cfg["states"]:
        assert f'"{s["id"]}"' in prompt


def test_requests_send_a_real_user_agent(monkeypatch):
    """Groq's firewall rejects Python's default User-Agent with a 403 that looks like a bad key."""
    monkeypatch.setattr(config, "ai_api_key", lambda: "gsk_fake")
    seen = {}

    class FakeResp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return json.dumps({"choices": [{"message": {"content": good()}}]}).encode()

    def fake_urlopen(req, timeout):
        seen.update({k.lower(): v for k, v in req.header_items()})
        return FakeResp()

    monkeypatch.setattr(analyst.urllib.request, "urlopen", fake_urlopen)
    assert analyst._call_once([{"role": "user", "content": "hi"}]) == good()
    assert seen["user-agent"] == analyst.USER_AGENT
    assert seen["authorization"] == "Bearer gsk_fake"


# ---- Astra, the crew's chat ----

SYMPTOMS = ["headache", "nausea", "fatigue"]


def chat_answer(actions=None, **extra):
    return json.dumps({"reply": "Should I log that?", "actions": actions or [], **extra})


def test_parse_chat_keeps_every_valid_action_type():
    acts = [
        {"type": "navigate", "page": "sleep"},
        {"type": "log_mood", "mood": "low", "note": "stressed"},
        {"type": "log_sleep", "bedtime": "23:00", "wake_time": "06:30"},
        {"type": "log_symptoms", "items": ["headache", "nausea"]},
    ]
    out = analyst.parse_chat(chat_answer(acts), SYMPTOMS)
    assert out["reply"] == "Should I log that?" and out["actions"] == acts
    more = [
        {"type": "log_vitals", "heart_rate": 72, "blood_pressure": {"systolic": 118, "diastolic": 76}, "temperature": 37.4, "oxygen_saturation": 97},
        {"type": "log_discomfort", "region": "skeleton", "intensity": 6},
        {"type": "journal", "title": "Day 3", "body": "Felt tired after the workout."},
        {"type": "alert_surgeon", "text": "I feel dizzy"},
    ]
    assert analyst.parse_chat(chat_answer(more), SYMPTOMS)["actions"] == more


@pytest.mark.parametrize("bad", [
    {"type": "navigate", "page": "settings"},
    {"type": "log_mood", "mood": "meh"},
    {"type": "log_sleep", "bedtime": "25:00", "wake_time": "06:00"},
    {"type": "log_sleep", "bedtime": "23:00", "wake_time": "23:00"},
    {"type": "log_symptoms", "items": ["made_up"]},
    {"type": "log_vitals", "heart_rate": 720},
    {"type": "log_vitals", "heart_rate": True},
    {"type": "log_vitals", "blood_pressure": {"systolic": 120}},
    {"type": "log_discomfort", "region": "tail", "intensity": 5},
    {"type": "log_discomfort", "region": "heart", "intensity": True},
    {"type": "journal", "title": "x", "body": "   "},
    {"type": "alert_surgeon", "text": ""},
    {"type": "delete_everything"},
    "navigate",
])
def test_parse_chat_drops_each_bad_action_but_keeps_the_reply(bad):
    out = analyst.parse_chat(chat_answer([bad, {"type": "navigate", "page": "overview"}]), SYMPTOMS)
    assert out["reply"] == "Should I log that?"
    assert out["actions"] == [{"type": "navigate", "page": "overview"}]


def test_parse_chat_caps_actions_and_drops_unknown_symptoms_from_a_list():
    acts = [{"type": "navigate", "page": p} for p in ("overview", "body", "trends", "mind", "sleep")]
    assert len(analyst.parse_chat(chat_answer(acts), SYMPTOMS)["actions"]) == analyst.MAX_ACTIONS
    out = analyst.parse_chat(chat_answer([{"type": "log_symptoms", "items": ["headache", "made_up"]}]), SYMPTOMS)
    assert out["actions"] == [{"type": "log_symptoms", "items": ["headache"]}]


def test_parse_chat_turns_old_region_intensity_into_a_discomfort_action():
    out = analyst.parse_chat('{"reply": "ok", "region": "skeleton", "intensity": 6}')
    assert out["actions"] == [{"type": "log_discomfort", "region": "skeleton", "intensity": 6}]


def test_parse_chat_rejects_a_missing_reply_and_caps_length():
    with pytest.raises(analyst.MalformedOutputError):
        analyst.parse_chat('{"actions": []}')
    assert len(analyst.parse_chat(json.dumps({"reply": "x" * 2000}))["reply"]) == analyst.MAX_REPLY


def test_chat_prompt_lists_pages_symptoms_and_asks_to_confirm_saves():
    prompt = analyst._chat_prompt(config.ai_analyst(), SYMPTOMS)
    for page in analyst.PAGES:
        assert f'"{page}"' in prompt
    assert '"headache"' in prompt and "confirm" in prompt


def test_chat_sends_history_in_order_and_retries_once(monkeypatch):
    monkeypatch.setattr(config, "ai_api_key", lambda: "gsk_fake")
    monkeypatch.setattr(analyst, "_backoff_until", 0.0)
    answers = iter(["oops", '{"reply": "You look fine today.", "actions": []}'])
    calls = []

    def fake_call(messages, max_tokens=None, timeout=None):
        calls.append(list(messages))  # a copy: the retry appends to the same list
        return next(answers)

    monkeypatch.setattr(analyst, "_call_once", fake_call)
    history = [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}]
    out = analyst.chat("HR 72", history, "how am I doing?", SYMPTOMS)
    assert out == {"reply": "You look fine today.", "actions": []}
    first = calls[0]
    assert first[0]["role"] == "system" and "HR 72" in first[0]["content"]
    assert first[1:] == history + [{"role": "user", "content": "how am I doing?"}]
    assert len(calls) == 2


def test_chat_retries_when_it_offers_to_save_but_sends_no_action(monkeypatch):
    monkeypatch.setattr(config, "ai_api_key", lambda: "gsk_fake")
    monkeypatch.setattr(analyst, "_backoff_until", 0.0)
    answers = iter([
        '{"reply": "Should I add that to your journal?", "actions": []}',
        '{"reply": "Should I add that to your journal?", "actions": [{"type": "journal", "title": "Run", "body": "Felt easy."}]}',
    ])
    monkeypatch.setattr(analyst, "_call_once", lambda m, max_tokens=None, timeout=None: next(answers))
    out = analyst.chat("ctx", [], "write in my journal: felt easy", SYMPTOMS)
    assert out["actions"] == [{"type": "journal", "title": "Run", "body": "Felt easy."}]


def test_chat_does_not_retry_plain_answers(monkeypatch):
    monkeypatch.setattr(config, "ai_api_key", lambda: "gsk_fake")
    monkeypatch.setattr(analyst, "_backoff_until", 0.0)
    calls = []
    monkeypatch.setattr(analyst, "_call_once", lambda m, max_tokens=None, timeout=None: calls.append(1) or '{"reply": "You look well today.", "actions": []}')
    analyst.chat("ctx", [], "how am I doing?", SYMPTOMS)
    assert len(calls) == 1


def test_chat_for_the_surgeon_never_offers_or_returns_actions(monkeypatch):
    monkeypatch.setattr(config, "ai_api_key", lambda: "gsk_fake")
    monkeypatch.setattr(analyst, "_backoff_until", 0.0)
    sent = []

    def fake_call(messages, max_tokens=None, timeout=None):
        sent.append(messages[0]["content"])
        return '{"reply": "Should I log that?", "actions": [{"type": "log_mood", "mood": "great", "note": ""}]}'

    monkeypatch.setattr(analyst, "_call_once", fake_call)
    out = analyst.chat("ctx", [], "log Ahmad's mood as great", SYMPTOMS, can_act=False)
    assert out["actions"] == [] and len(sent) == 1  # no "missing action" retry either
    assert "flight surgeon" in sent[0] and "cannot save" in sent[0]


def test_chat_skips_a_retry_when_the_time_budget_is_spent(monkeypatch):
    monkeypatch.setattr(config, "ai_api_key", lambda: "gsk_fake")
    monkeypatch.setattr(analyst, "_backoff_until", 0.0)
    clock = [0.0]
    monkeypatch.setattr(analyst.time, "monotonic", lambda: clock[0])
    calls = []

    def slow_call(messages, max_tokens=None, timeout=None):
        calls.append(timeout)
        clock[0] += 20  # the first answer took 20 of the 22 s
        return '{"reply": "Should I add that to your journal?", "actions": []}'

    monkeypatch.setattr(analyst, "_call_once", slow_call)
    out = analyst.chat("ctx", [], "write in my journal: hi", SYMPTOMS)
    assert len(calls) == 1 and calls[0] <= analyst.CHAT_BUDGET_S  # no second, minute-long wait
    assert out["reply"]


# ---- Astra's newer abilities ----
def test_new_actions_are_validated():
    raw = json.dumps({"reply": "ok", "actions": [
        {"type": "message_surgeon", "text": "  Slept well  "},
        {"type": "send_summary", "period": "week"},
        {"type": "start_sleep", "junk": 1},
        {"type": "measure_guide", "indicator": "heart_rate"},
    ]})
    out = analyst.parse_chat(raw, guide_ids=("heart_rate",))
    assert out["actions"] == [
        {"type": "message_surgeon", "text": "Slept well"}, {"type": "send_summary", "period": "week"},
        {"type": "start_sleep"}, {"type": "measure_guide", "indicator": "heart_rate"},
    ]


def test_bad_new_actions_are_dropped():
    bad = [{"type": "message_surgeon", "text": " "}, {"type": "send_summary", "period": "year"},
           {"type": "measure_guide", "indicator": "heart_rate"}, {"type": "remember", "text": ""},
           {"type": "forget", "id": True}, {"type": "forget", "id": "3"}, {"type": "forget", "id": 0}]
    assert analyst.parse_chat(json.dumps({"reply": "ok", "actions": bad})).get("actions") == []


def test_remember_forget_and_emergency():
    raw = json.dumps({"reply": "ok", "actions": [
        {"type": "remember", "text": "Knee  hurts", "follow_up_hours": 6},
        {"type": "remember", "text": "Likes tea", "follow_up_hours": 999},
        {"type": "forget", "id": 4},
        {"type": "emergency"},
    ]})
    out = analyst.parse_chat(raw)["actions"]
    assert out == [{"type": "remember", "text": "Knee hurts", "follow_up_hours": 6}, {"type": "remember", "text": "Likes tea"},
                   {"type": "forget", "id": 4}, {"type": "emergency", "text": "Emergency called by voice"}]


def test_remember_alone_is_not_an_offer_without_an_action():
    out = {"reply": "I'll remember that. Should I log knee pain?", "actions": [{"type": "remember", "text": "x"}]}
    assert analyst._offers_without_action(out)  # the offer to log still needs its action
    out = {"reply": "Should I start your sleep tracking?", "actions": [{"type": "start_sleep"}]}
    assert not analyst._offers_without_action(out)


def test_summary_parses_the_report(monkeypatch):
    monkeypatch.setattr(analyst, "available", lambda: True)
    monkeypatch.setattr(analyst, "_call_once", lambda *a, **k: '{"summary": "  Vitals steady,\\n sleep 7 h. "}')
    assert analyst.summary("ctx", "week") == "Vitals steady, sleep 7 h."
    monkeypatch.setattr(analyst, "_call_once", lambda *a, **k: '{"nope": 1}')
    with pytest.raises(analyst.MalformedOutputError):
        analyst.summary("ctx", "today")


def test_groq_broken_json_400_is_treated_as_a_bad_answer(monkeypatch):
    """Groq's 400 json_validate_failed comes back as the broken text, so the normal
    parse-or-retry path handles it instead of failing the whole chat turn."""
    import io
    import urllib.error
    monkeypatch.setattr(config, "ai_api_key", lambda: "k")
    calls = []

    def fake_urlopen(req, timeout=0):
        calls.append(1)
        if len(calls) == 1:
            body = json.dumps({"error": {"code": "json_validate_failed", "failed_generation": "not json at all"}}).encode()
            raise urllib.error.HTTPError(req.full_url, 400, "Bad Request", {}, io.BytesIO(body))
        payload = {"choices": [{"message": {"content": '{"reply": "Fine.", "actions": []}'}}]}
        return io.BytesIO(json.dumps(payload).encode())

    class Ctx(io.BytesIO):
        def __enter__(self): return self
        def __exit__(self, *a): return False

    monkeypatch.setattr(analyst.urllib.request, "urlopen", lambda req, timeout=0: Ctx(fake_urlopen(req, timeout).getvalue()))
    monkeypatch.setattr(analyst, "_backoff_until", 0)
    out = analyst.chat("ctx", [], "hi")
    assert out["reply"] == "Fine." and len(calls) == 2


def test_set_location_action():
    raw = json.dumps({"reply": "ok", "actions": [{"type": "set_location", "location": "eva"}, {"type": "set_location", "location": "moon"}]})
    assert analyst.parse_chat(raw)["actions"] == [{"type": "set_location", "location": "eva"}]


def test_parse_chat_keeps_a_named_exercise_and_drops_an_unknown_one():
    out = analyst.parse_chat(chat_answer([{"type": "start_workout", "exercise": "ared"}]), SYMPTOMS)
    assert out["actions"] == [{"type": "start_workout", "exercise": "ared"}]
    out = analyst.parse_chat(chat_answer([{"type": "start_workout", "exercise": "yoga"}]), SYMPTOMS)
    assert out["actions"] == [{"type": "start_workout"}]
    assert analyst.parse_chat(chat_answer([{"type": "navigate", "page": "exercise"}]), SYMPTOMS)["actions"][0]["page"] == "exercise"
