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


# ---- the crew's Doctor AI chat ----

def test_parse_chat_keeps_a_valid_region_and_intensity():
    out = analyst.parse_chat('{"reply": "Sorry about your back.", "region": "skeleton", "intensity": 6}')
    assert out == {"reply": "Sorry about your back.", "region": "skeleton", "intensity": 6}


@pytest.mark.parametrize("region,intensity", [("tail", 5), ("heart", True), ("heart", 11), ("heart", "6"), (None, 4), ("heart", None)])
def test_parse_chat_drops_region_and_intensity_together(region, intensity):
    out = analyst.parse_chat(json.dumps({"reply": "ok", "region": region, "intensity": intensity}))
    assert out["region"] is None and out["intensity"] is None and out["reply"] == "ok"


def test_parse_chat_rejects_a_missing_reply_and_caps_length():
    with pytest.raises(analyst.MalformedOutputError):
        analyst.parse_chat('{"region": null, "intensity": null}')
    assert len(analyst.parse_chat(json.dumps({"reply": "x" * 2000}))["reply"]) == analyst.MAX_REPLY


def test_chat_sends_history_in_order_and_retries_once(monkeypatch):
    monkeypatch.setattr(config, "ai_api_key", lambda: "gsk_fake")
    monkeypatch.setattr(analyst, "_backoff_until", 0.0)
    answers = iter(["oops", '{"reply": "You look fine today.", "region": null, "intensity": null}'])
    calls = []

    def fake_call(messages, max_tokens=None):
        calls.append(list(messages))  # a copy: the retry appends to the same list
        return next(answers)

    monkeypatch.setattr(analyst, "_call_once", fake_call)
    history = [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}]
    out = analyst.chat("HR 72", history, "how am I doing?")
    assert out["reply"] == "You look fine today."
    first = calls[0]
    assert first[0]["role"] == "system" and "HR 72" in first[0]["content"]
    assert first[1:] == history + [{"role": "user", "content": "how am I doing?"}]
    assert len(calls) == 2
