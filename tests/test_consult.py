import pytest

from backend.services import consult

REGION_IDS = {"brain", "eyes", "heart", "stomach", "skeleton", "muscles", "immune"}


def test_parses_clean_json():
    out = consult.parse_model_output('{"region":"heart","intensity":7,"reply":"Logged it."}', REGION_IDS)
    assert out["region"] == "heart"
    assert out["intensity"] == 7
    assert out["reply"] == "Logged it."


def test_strips_markdown_fence():
    out = consult.parse_model_output('```json\n{"region":"heart","intensity":3,"reply":"ok"}\n```', REGION_IDS)
    assert out["region"] == "heart"
    assert out["intensity"] == 3


def test_unknown_region_is_nulled_along_with_intensity():
    out = consult.parse_model_output('{"region":"toe","intensity":5,"reply":"ok"}', REGION_IDS)
    assert out["region"] is None
    assert out["intensity"] is None
    assert out["reply"] == "ok"


def test_out_of_range_intensity_is_nulled_along_with_region():
    out = consult.parse_model_output('{"region":"heart","intensity":11,"reply":"ok"}', REGION_IDS)
    assert out["region"] is None
    assert out["intensity"] is None
    assert out["reply"] == "ok"


def test_non_integer_intensity_is_nulled():
    out = consult.parse_model_output('{"region":"heart","intensity":"severe","reply":"ok"}', REGION_IDS)
    assert out["intensity"] is None
    assert out["region"] is None


def test_bool_intensity_is_rejected():
    # isinstance(True, int) is True in Python -- must not sneak through as 1.
    out = consult.parse_model_output('{"region":"heart","intensity":true,"reply":"ok"}', REGION_IDS)
    assert out["intensity"] is None
    assert out["region"] is None


def test_non_json_reply_raises():
    with pytest.raises(consult.ConsultError):
        consult.parse_model_output("I think it's your heart.", REGION_IDS)


def test_missing_reply_field_raises():
    with pytest.raises(consult.ConsultError):
        consult.parse_model_output('{"region":"heart","intensity":5}', REGION_IDS)


def test_blank_reply_field_raises():
    with pytest.raises(consult.ConsultError):
        consult.parse_model_output('{"region":"heart","intensity":5,"reply":"   "}', REGION_IDS)


def test_null_region_and_intensity_pass_through():
    out = consult.parse_model_output('{"region":null,"intensity":null,"reply":"Tell me more."}', REGION_IDS)
    assert out["region"] is None
    assert out["intensity"] is None
    assert out["reply"] == "Tell me more."
    assert out["vital"] is None
    assert out["alert_surgeon"] is False
    assert out["alert_text"] is None
    assert out["symptom"] is None
    assert out["start_breathing"] is False
    assert out["trigger_emergency"] is False
    assert out["emergency_text"] is None


def test_available_false_without_a_key(monkeypatch):
    monkeypatch.setattr(consult, "nvidia_api_key", lambda: None)
    assert consult.available() is False


def test_available_true_with_a_key(monkeypatch):
    monkeypatch.setattr(consult, "nvidia_api_key", lambda: "nvapi-fake")
    assert consult.available() is True


FAKE_BODY_PARTS = {
    "heart": {"label": "Heart", "what_it_does": "Pumps blood.", "space_effects": "Fluid shifts up.",
               "what_to_do": "Keep up cardio exercise."},
    "skeleton": {"label": "Skeleton", "what_it_does": "Bone strength.", "space_effects": "Bones lose density.",
                  "what_to_do": "Resistance exercise."},
}


def test_malformed_output_error_is_a_consult_error():
    assert issubclass(consult.MalformedOutputError, consult.ConsultError)


def test_system_prompt_includes_full_region_guidance():
    prompt = consult._system_prompt("Ahmad", "Mars transit", [], FAKE_BODY_PARTS)
    assert "Resistance exercise." in prompt
    assert "Keep up cardio exercise." in prompt


def test_system_prompt_includes_elevated_today_when_present():
    prompt = consult._system_prompt("Ahmad", "Mars transit", [], FAKE_BODY_PARTS, elevated_today=["Heart: YELLOW today"])
    assert "Heart: YELLOW today" in prompt
    assert "Already flagged today" in prompt


def test_system_prompt_omits_elevated_block_when_empty():
    prompt = consult._system_prompt("Ahmad", "Mars transit", [], FAKE_BODY_PARTS, elevated_today=[])
    assert "Already flagged today" not in prompt


def test_ask_forwards_history_in_order(monkeypatch):
    captured = {}

    def fake_call_once(messages):
        captured["messages"] = messages
        return '{"region":"heart","intensity":5,"reply":"ok"}'

    monkeypatch.setattr(consult, "_call_once", fake_call_once)
    monkeypatch.setattr(consult, "nvidia_api_key", lambda: "nvapi-fake")
    history = [{"role": "user", "content": "my back hurts"}, {"role": "assistant", "content": "logged it"}]
    consult.ask("it's worse now", "Ahmad", "Mars transit", [], FAKE_BODY_PARTS, history=history)
    msgs = captured["messages"]
    assert msgs[0]["role"] == "system"
    assert msgs[1:3] == history
    assert msgs[3] == {"role": "user", "content": "it's worse now"}


def test_ask_retries_once_on_malformed_output(monkeypatch):
    calls = []

    def fake_call_once(messages):
        calls.append(messages)
        if len(calls) == 1:
            return "not json"
        return '{"region":"heart","intensity":5,"reply":"ok"}'

    monkeypatch.setattr(consult, "_call_once", fake_call_once)
    out = consult.ask("my heart hurts", "Ahmad", "Mars transit", [], FAKE_BODY_PARTS)
    assert out["region"] == "heart"
    assert out["intensity"] == 5
    assert out["reply"] == "ok"
    assert len(calls) == 2
    # the retry's messages include the bad output + a corrective note
    assert calls[1][-2]["content"] == "not json"
    assert "valid JSON" in calls[1][-1]["content"]


def test_ask_gives_up_after_one_failed_retry(monkeypatch):
    calls = []

    def fake_call_once(messages):
        calls.append(messages)
        return "still not json"

    monkeypatch.setattr(consult, "_call_once", fake_call_once)
    with pytest.raises(consult.MalformedOutputError):
        consult.ask("my heart hurts", "Ahmad", "Mars transit", [], FAKE_BODY_PARTS)
    assert len(calls) == 2


def test_ask_does_not_retry_on_plain_consult_error(monkeypatch):
    calls = []

    def fake_call_once(messages):
        calls.append(messages)
        raise consult.ConsultError("network boom")

    monkeypatch.setattr(consult, "_call_once", fake_call_once)
    with pytest.raises(consult.ConsultError):
        consult.ask("my heart hurts", "Ahmad", "Mars transit", [], FAKE_BODY_PARTS)
    assert len(calls) == 1


SYMPTOM_IDS = {"headache", "nausea", "chest_pain"}


# ---- vital ----

def test_vital_heart_rate_passes_through():
    out = consult.parse_model_output('{"vital":{"heart_rate":140},"reply":"ok"}', REGION_IDS)
    assert out["vital"] == {"heart_rate": 140}


def test_vital_blood_pressure_passes_through():
    out = consult.parse_model_output(
        '{"vital":{"blood_pressure":{"systolic":150,"diastolic":95}},"reply":"ok"}', REGION_IDS)
    assert out["vital"] == {"blood_pressure": {"systolic": 150, "diastolic": 95}}


def test_vital_unknown_key_is_nulled():
    out = consult.parse_model_output('{"vital":{"pulse_ox":98},"reply":"ok"}', REGION_IDS)
    assert out["vital"] is None


def test_vital_bool_value_is_rejected():
    out = consult.parse_model_output('{"vital":{"heart_rate":true},"reply":"ok"}', REGION_IDS)
    assert out["vital"] is None


def test_vital_blood_pressure_missing_diastolic_is_nulled():
    out = consult.parse_model_output('{"vital":{"blood_pressure":{"systolic":150}},"reply":"ok"}', REGION_IDS)
    assert out["vital"] is None


def test_vital_with_multiple_keys_is_nulled():
    out = consult.parse_model_output('{"vital":{"heart_rate":140,"temperature":37},"reply":"ok"}', REGION_IDS)
    assert out["vital"] is None


def test_vital_heart_rate_out_of_range_is_nulled():
    out = consult.parse_model_output('{"vital":{"heart_rate":900},"reply":"ok"}', REGION_IDS)
    assert out["vital"] is None


def test_vital_temperature_negative_is_nulled():
    out = consult.parse_model_output('{"vital":{"temperature":-5},"reply":"ok"}', REGION_IDS)
    assert out["vital"] is None


def test_vital_blood_pressure_out_of_range_is_nulled():
    out = consult.parse_model_output(
        '{"vital":{"blood_pressure":{"systolic":400,"diastolic":95}},"reply":"ok"}', REGION_IDS)
    assert out["vital"] is None


def test_vital_null_passes_through():
    out = consult.parse_model_output('{"vital":null,"reply":"ok"}', REGION_IDS)
    assert out["vital"] is None


# ---- alert_surgeon / alert_text ----

def test_alert_surgeon_true_with_text_passes_through():
    out = consult.parse_model_output(
        '{"alert_surgeon":true,"alert_text":"Chest pain, intensity 8.","reply":"ok"}', REGION_IDS)
    assert out["alert_surgeon"] is True
    assert out["alert_text"] == "Chest pain, intensity 8."


def test_alert_surgeon_true_without_text_is_nulled_as_a_pair():
    out = consult.parse_model_output('{"alert_surgeon":true,"reply":"ok"}', REGION_IDS)
    assert out["alert_surgeon"] is False
    assert out["alert_text"] is None


def test_alert_surgeon_non_bool_is_coerced_false():
    out = consult.parse_model_output('{"alert_surgeon":"yes","alert_text":"x","reply":"ok"}', REGION_IDS)
    assert out["alert_surgeon"] is False
    assert out["alert_text"] is None


def test_alert_text_ignored_when_alert_surgeon_false():
    out = consult.parse_model_output('{"alert_surgeon":false,"alert_text":"should be dropped","reply":"ok"}', REGION_IDS)
    assert out["alert_surgeon"] is False
    assert out["alert_text"] is None


def test_alert_text_blank_string_is_treated_as_missing():
    out = consult.parse_model_output('{"alert_surgeon":true,"alert_text":"   ","reply":"ok"}', REGION_IDS)
    assert out["alert_surgeon"] is False
    assert out["alert_text"] is None


# ---- symptom ----

def test_symptom_known_id_passes_through():
    out = consult.parse_model_output('{"symptom":"headache","reply":"ok"}', REGION_IDS, SYMPTOM_IDS)
    assert out["symptom"] == "headache"


def test_symptom_unknown_id_is_nulled():
    out = consult.parse_model_output('{"symptom":"made_up","reply":"ok"}', REGION_IDS, SYMPTOM_IDS)
    assert out["symptom"] is None


def test_symptom_independent_of_region_intensity():
    out = consult.parse_model_output(
        '{"region":"brain","intensity":7,"symptom":"headache","reply":"ok"}', REGION_IDS, SYMPTOM_IDS)
    assert out["region"] == "brain"
    assert out["intensity"] == 7
    assert out["symptom"] == "headache"


def test_symptom_defaults_to_none_without_a_catalog():
    # known_symptom_ids defaults to an empty set -- old-style callers that
    # don't pass it never match any symptom, rather than erroring.
    out = consult.parse_model_output('{"symptom":"headache","reply":"ok"}', REGION_IDS)
    assert out["symptom"] is None


# ---- start_breathing ----

def test_start_breathing_true_passes_through():
    out = consult.parse_model_output('{"start_breathing":true,"reply":"ok"}', REGION_IDS)
    assert out["start_breathing"] is True


def test_start_breathing_non_bool_is_coerced_false():
    out = consult.parse_model_output('{"start_breathing":"yes","reply":"ok"}', REGION_IDS)
    assert out["start_breathing"] is False


# ---- trigger_emergency / emergency_text ----

def test_trigger_emergency_true_with_text_passes_through():
    out = consult.parse_model_output(
        '{"trigger_emergency":true,"emergency_text":"Crew member unresponsive.","reply":"ok"}', REGION_IDS)
    assert out["trigger_emergency"] is True
    assert out["emergency_text"] == "Crew member unresponsive."


def test_trigger_emergency_true_without_text_is_nulled_as_a_pair():
    out = consult.parse_model_output('{"trigger_emergency":true,"reply":"ok"}', REGION_IDS)
    assert out["trigger_emergency"] is False
    assert out["emergency_text"] is None


def test_trigger_emergency_non_bool_is_coerced_false():
    out = consult.parse_model_output('{"trigger_emergency":"yes","emergency_text":"x","reply":"ok"}', REGION_IDS)
    assert out["trigger_emergency"] is False
    assert out["emergency_text"] is None


# ---- backward compatibility ----

def test_old_style_three_field_output_still_parses_with_safe_defaults():
    out = consult.parse_model_output('{"region":"heart","intensity":5,"reply":"ok"}', REGION_IDS)
    assert out["region"] == "heart"
    assert out["intensity"] == 5
    assert out["vital"] is None
    assert out["alert_surgeon"] is False
    assert out["alert_text"] is None
    assert out["symptom"] is None
    assert out["start_breathing"] is False
    assert out["trigger_emergency"] is False
    assert out["emergency_text"] is None


# ---- system prompt additions ----

def test_system_prompt_includes_vital_instructions():
    prompt = consult._system_prompt("Ahmad", "Mars transit", [], FAKE_BODY_PARTS)
    assert "EXPLICIT numeric vital reading" in prompt
    assert "degrees Celsius" in prompt


def test_system_prompt_includes_alert_surgeon_instructions():
    prompt = consult._system_prompt("Ahmad", "Mars transit", [], FAKE_BODY_PARTS)
    assert "alert_surgeon" in prompt
    assert "explicitly asks you" in prompt


def test_system_prompt_includes_emergency_instructions():
    prompt = consult._system_prompt("Ahmad", "Mars transit", [], FAKE_BODY_PARTS)
    assert "trigger_emergency" in prompt
    assert "unmistakably asks for emergency help right now" in prompt


def test_system_prompt_includes_symptom_catalog():
    catalog = [{"id": "headache", "label": "Headache"}, {"id": "nausea", "label": "Nausea"}]
    prompt = consult._system_prompt("Ahmad", "Mars transit", [], FAKE_BODY_PARTS, catalog)
    assert '"headache" (Headache)' in prompt
    assert '"nausea" (Nausea)' in prompt


def test_system_prompt_includes_schedule_trends_rewards_when_present():
    prompt = consult._system_prompt(
        "Ahmad", "Mars transit", [], FAKE_BODY_PARTS,
        schedule_lines=["07:00 - Morning vitals check"],
        trend_lines=["Heart rate, last 7 days: avg 78 bpm (range 65-95)"],
        rewards_line="Progress: 340 points.",
    )
    assert "07:00 - Morning vitals check" in prompt
    assert "Heart rate, last 7 days" in prompt
    assert "Progress: 340 points." in prompt


def test_system_prompt_omits_new_context_blocks_when_absent():
    prompt = consult._system_prompt("Ahmad", "Mars transit", [], FAKE_BODY_PARTS)
    assert "Today's schedule" not in prompt
    assert "Recent vital trends" not in prompt


# ---- ask() end-to-end forwards every new field ----

def test_ask_forwards_new_fields_end_to_end(monkeypatch):
    def fake_call_once(messages):
        return (
            '{"region":null,"intensity":null,'
            '"vital":{"heart_rate":140},'
            '"alert_surgeon":true,"alert_text":"please check on me",'
            '"symptom":"headache",'
            '"start_breathing":true,'
            '"trigger_emergency":false,"emergency_text":null,'
            '"reply":"Logged."}'
        )

    monkeypatch.setattr(consult, "_call_once", fake_call_once)
    out = consult.ask("my heart rate is 140, headache too", "Ahmad", "Mars transit", [], FAKE_BODY_PARTS,
                       symptoms_catalog=[{"id": "headache", "label": "Headache"}])
    assert out["vital"] == {"heart_rate": 140}
    assert out["alert_surgeon"] is True
    assert out["alert_text"] == "please check on me"
    assert out["symptom"] == "headache"
    assert out["start_breathing"] is True
    assert out["trigger_emergency"] is False
