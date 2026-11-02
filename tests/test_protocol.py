from backend import protocol


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
    line = protocol.session("Omar Saleh", "A1000002", "YELLOW", 1509)
    assert line.endswith("\n")
    msg = protocol.decode(line)
    assert msg == {"type": "session", "name": "Omar Saleh", "uid": "A1000002", "level": "YELLOW", "points": 1509}


def test_each_builder_produces_its_type():
    assert protocol.decode(protocol.status("Omar", "YELLOW", "Short sleep"))["type"] == "status"
    assert protocol.decode(protocol.toast("Meal logged"))["type"] == "toast"
    assert protocol.decode(protocol.unknown_tag("Z1234567"))["type"] == "unknown_tag"
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
