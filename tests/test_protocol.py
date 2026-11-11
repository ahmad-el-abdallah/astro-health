from backend.hardware import protocol


def test_decode_valid_scan():
    msg = protocol.decode('{"type":"scan","uid":"A1000002"}\n')
    assert msg == {"type": "scan", "uid": "A1000002"}


def test_decode_ignores_debug_text():
    assert protocol.decode("booting Lifeline v2.0...") is None


def test_decode_ignores_malformed_json():
    assert protocol.decode('{"type":"scan", oops}') is None


def test_decode_ignores_empty_line():
    assert protocol.decode("\n") is None
    assert protocol.decode("") is None


def test_decode_requires_type_field():
    assert protocol.decode('{"uid":"A1000002"}') is None


def test_decode_requires_object_not_list():
    assert protocol.decode('["scan","A1000002"]') is None


def test_encode_roundtrips_through_decode():
    line = protocol.session("Omar Saleh", "A1000002", "YELLOW")
    assert line.endswith("\n")
    msg = protocol.decode(line)
    assert msg == {"type": "session", "name": "Omar Saleh", "uid": "A1000002", "level": "YELLOW"}


def test_session_role_and_today_are_optional_and_additive():
    # Older firmware ignores fields it doesn't know about, so adding
    # role/today here must never break the bare 3-field call above.
    bare = protocol.decode(protocol.session("Omar Saleh", "A1000002", "YELLOW"))
    assert "role" not in bare and "today" not in bare

    today = {"heart_rate": {"v": "72", "l": "GREEN"}}
    full = protocol.decode(protocol.session("Omar Saleh", "A1000002", "YELLOW", 600, "Crew member", today))
    assert full["role"] == "Crew member"
    assert full["today"] == today


def test_each_builder_produces_its_type():
    assert protocol.decode(protocol.status("Omar", "YELLOW", "Short sleep"))["type"] == "status"
    assert protocol.decode(protocol.toast("Meal logged"))["type"] == "toast"
    assert protocol.decode(protocol.unknown_tag("Z1234567"))["type"] == "unknown_tag"


def test_surgeon_cyd_builders_roundtrip():
    crew = protocol.decode(protocol.crew_list([{"id": 2, "n": "Sameer", "l": "YELLOW", "al": 1}]))
    assert crew == {"type": "crew_list", "items": [{"id": 2, "n": "Sameer", "l": "YELLOW", "al": 1}]}

    alerts = protocol.decode(protocol.alerts_list([{"id": 5, "who": "Sameer", "t": "Flagged: heart rate", "ts": "02:58"}]))
    assert alerts["type"] == "alerts_list"
    assert alerts["items"][0]["who"] == "Sameer"

    inbox = protocol.decode(protocol.inbox_list([]))
    assert inbox == {"type": "inbox_list", "items": []}

    detail = protocol.decode(protocol.crew_detail({"id": 2, "n": "Sameer", "l": "YELLOW", "v": {}, "ts": "02:54", "on": False}))
    assert detail["type"] == "crew_detail"
    assert detail["n"] == "Sameer"
    assert detail["on"] is False
    assert protocol.decode(protocol.exercise("start", 0))["type"] == "exercise"
    assert protocol.decode(protocol.sleep("stop", 6.5))["type"] == "sleep"
    assert protocol.decode(protocol.reminder("Time for vitals"))["type"] == "reminder"
    assert protocol.decode(protocol.alert("RED", "Act now"))["type"] == "alert"
    assert protocol.decode(protocol.emergency(True, "Help is coming"))["type"] == "emergency"
    assert protocol.decode(protocol.led("GREEN"))["type"] == "led"
    assert protocol.decode(protocol.idle())["type"] == "idle"
    assert protocol.decode(protocol.ping())["type"] == "ping"


def test_encode_rejects_oversized_message():
    import pytest
    with pytest.raises(ValueError):
        protocol.toast("x" * 600)


def test_type_sets_cover_the_spec_tables():
    assert "scan" in protocol.CYD_TO_LAPTOP_TYPES
    assert "hello" in protocol.CYD_TO_LAPTOP_TYPES
    assert "session" in protocol.LAPTOP_TO_CYD_TYPES
    assert "ping" in protocol.LAPTOP_TO_CYD_TYPES
    # "emergency" is the one type that flows both ways (CYD SOS button, laptop-driven alert).
    assert protocol.CYD_TO_LAPTOP_TYPES & protocol.LAPTOP_TO_CYD_TYPES == {"emergency"}
