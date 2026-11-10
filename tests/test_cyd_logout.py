"""Which CYD session endings sign the browser out.

Only the CYD's Done button should (logout_requested); its 2-minute idle timeout must
not -- that bug signed people out of the web app every couple of minutes. Also checks
the web login lasts an hour."""
import argparse
import time

import pytest

from backend import db
from backend.logic import sessions

AHMAD_UID = "9B:25:0F:54"


@pytest.fixture()
def rig(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "test.db"))
    import app as app_module
    args = argparse.Namespace(port=None, simulate=True, wifi=False, wifi_host=None, wifi_port=None,
                              host="0.0.0.0", web_port=5000)
    flask_app, socketio, bridge = app_module.create_app(args)
    flask_app.config["TESTING"] = True
    sock = socketio.test_client(flask_app)
    bridge.inject({"type": "scan", "uid": AHMAD_UID})  # opens Ahmad's CYD session
    astro_id = next(iter(sessions.active_sessions))
    sock.get_received()
    return flask_app, bridge, sock, astro_id


def logout_events(sock):
    return [e for e in sock.get_received() if e["name"] == "logout_requested"]


def test_done_button_signs_the_browser_out(rig):
    _, bridge, sock, _ = rig
    bridge.inject({"type": "end_session", "uid": AHMAD_UID, "reason": "done"})
    assert len(logout_events(sock)) == 1


def test_idle_timeout_does_not_sign_the_browser_out(rig):
    _, bridge, sock, astro_id = rig
    bridge.inject({"type": "end_session", "uid": AHMAD_UID, "reason": "idle"})
    assert logout_events(sock) == []
    assert astro_id not in sessions.active_sessions  # the CYD session still ends


def test_old_firmware_idle_timeout_is_recognised_by_timing(rig):
    _, bridge, sock, astro_id = rig
    sessions.active_sessions[astro_id]["cyd_contact"] = time.time() - 125
    bridge.inject({"type": "end_session", "uid": AHMAD_UID})  # no "reason" (old firmware)
    assert logout_events(sock) == []


def test_old_firmware_done_right_after_activity_still_signs_out(rig):
    _, bridge, sock, _ = rig
    bridge.inject({"type": "end_session", "uid": AHMAD_UID})
    assert len(logout_events(sock)) == 1


def test_web_login_lasts_an_hour(rig):
    flask_app, _, _, _ = rig
    client = flask_app.test_client()
    res = client.post("/api/auth/nfc_login", json={"uid": AHMAD_UID})
    cookie = res.headers.get("Set-Cookie", "")
    assert "Expires=" in cookie
    assert flask_app.permanent_session_lifetime.total_seconds() == 3600


def test_pico_tag_scans_dont_make_the_idle_timeout_look_like_done(rig):
    # A Pico object-tag scan refreshes the laptop's own session activity but never
    # touches the CYD, so the CYD's idle timer still runs out ~2 min after its last
    # contact -- that end_session must not sign the browser out.
    _, bridge, sock, astro_id = rig
    sessions.active_sessions[astro_id]["cyd_contact"] = time.time() - 125
    sessions.active_sessions[astro_id]["last_activity"] = time.time() - 5
    bridge.inject({"type": "end_session", "uid": AHMAD_UID})
    assert logout_events(sock) == []


def test_cyd_touchscreen_messages_count_as_cyd_contact(rig):
    _, bridge, sock, astro_id = rig
    sessions.active_sessions[astro_id]["cyd_contact"] = time.time() - 125
    bridge.inject({"type": "mood", "uid": AHMAD_UID, "value": 4})
    bridge.inject({"type": "end_session", "uid": AHMAD_UID})  # Done right after using the CYD
    assert len(logout_events(sock)) == 1


def test_session_message_tells_the_cyd_its_idle_time(rig):
    from backend.config import SESSION_IDLE_S
    from backend.hardware import protocol
    msg = protocol.decode(protocol.session("Ahmad", AHMAD_UID, "GREEN", SESSION_IDLE_S))
    assert msg["idle_s"] == SESSION_IDLE_S
    assert sessions.SESSION_TIMEOUT_S > SESSION_IDLE_S  # the laptop is only the safety net


def test_using_the_cyd_keeps_the_laptop_session_alive(rig):
    # The bug: the laptop ended the session 2 min after the tap even while the CYD was in use.
    _, bridge, sock, astro_id = rig
    sessions.active_sessions[astro_id]["last_activity"] = time.time() - sessions.SESSION_TIMEOUT_S + 5
    bridge.inject({"type": "active", "uid": AHMAD_UID})
    sessions.check_timeouts(lambda line: None, lambda *a: None)
    assert astro_id in sessions.active_sessions
    assert not [e for e in sock.get_received() if e["name"] == "cyd_event"]  # pings stay quiet
