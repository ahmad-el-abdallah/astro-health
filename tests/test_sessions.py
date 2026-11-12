import json
from datetime import datetime, timedelta, timezone

from backend import db
from backend.hardware import protocol
from backend.jobs import comms
from backend.logic import sessions
from tests.conftest import seed_minimal


def _recorder():
    sent, emitted = [], []
    return sent, emitted, (lambda line: sent.append(line)), (lambda ev, data: emitted.append((ev, data)))


def test_unknown_tag_notifies_cyd_and_ui(fresh_db):
    with db.write_conn() as conn:
        seed_minimal(conn)
    sent, emitted, send_fn, emit_fn = _recorder()
    sessions.handle_scan("ZZZZZZZZ", send_fn, emit_fn)
    assert '"type":"unknown_tag"' in sent[0]
    assert emitted[0] == ("unknown_tag", {"uid": "ZZZZZZZZ"})


def test_astronaut_tap_starts_a_session(fresh_db):
    with db.write_conn() as conn:
        astro_id = seed_minimal(conn)
    sent, emitted, send_fn, emit_fn = _recorder()

    sessions.handle_scan("A0000001", send_fn, emit_fn)
    assert astro_id in sessions.active_sessions
    assert any(e[0] == "session_started" for e in emitted)


def test_web_only_scan_signs_in_but_never_touches_the_cyd(fresh_db):
    """The login page's "this browser only" choice (docs/CLAUDE.md
    "web-only login") -- the scan broadcast the web login needs still
    fires, but no CYD session starts."""
    with db.write_conn() as conn:
        astro_id = seed_minimal(conn)
    sent, emitted, send_fn, emit_fn = _recorder()

    sessions.handle_scan("A0000001", send_fn, emit_fn, web_only=True)

    assert astro_id not in sessions.active_sessions
    assert emitted == [("scan", {"uid": "A0000001", "type": "astronaut", "label": "Test Astro"})]
    assert sent == []


def test_web_only_scan_does_not_disturb_an_already_active_cyd_session(fresh_db):
    with db.write_conn() as conn:
        astro_id = seed_minimal(conn)
        now = datetime.now(timezone.utc).isoformat()
        other_id = conn.execute(
            "INSERT INTO astronauts (name, role, color, baseline_reaction_ms, created_at) VALUES (?, ?, ?, ?, ?)",
            ("Other Astro", "Crew member", "#ffffff", 340, now),
        ).lastrowid
        conn.execute(
            "INSERT INTO tags (uid, type, label, astronaut_id, data_json) VALUES ('A0000002', 'astronaut', 'Other Astro', ?, '{}')",
            (other_id,),
        )
    sent, emitted, send_fn, emit_fn = _recorder()

    sessions.handle_scan("A0000001", send_fn, emit_fn)  # a real tap -- genuinely on the CYD
    sent.clear(); emitted.clear()

    sessions.handle_scan("A0000002", send_fn, emit_fn, web_only=True)  # someone else logging into the web only

    assert astro_id in sessions.active_sessions  # untouched
    assert other_id not in sessions.active_sessions  # not started on the CYD


def test_a_real_tap_honors_the_current_global_scan_mode(fresh_db):
    """A real hardware tap (the Pico, the only NFC reader this system has)
    never sends an explicit web_only flag -- it must fall back to whatever
    the login page last set globally (docs/CLAUDE.md "web-only login"),
    not always default to affecting the CYD."""
    with db.write_conn() as conn:
        astro_id = seed_minimal(conn)
    sent, emitted, send_fn, emit_fn = _recorder()

    sessions.set_scan_mode("web")
    sessions.handle_scan("A0000001", send_fn, emit_fn)  # no web_only passed at all

    assert astro_id not in sessions.active_sessions
    assert sent == []


def test_global_scan_mode_defaults_to_cyd_and_an_explicit_flag_still_overrides(fresh_db):
    with db.write_conn() as conn:
        astro_id = seed_minimal(conn)
    sent, emitted, send_fn, emit_fn = _recorder()

    assert sessions.current_scan_mode == "cyd"  # the long-standing default
    sessions.set_scan_mode("web")
    # An explicit False (e.g. a Simulator call made with "Also sign in my
    # CYD" selected) still wins over the global mode.
    sessions.handle_scan("A0000001", send_fn, emit_fn, web_only=False)
    assert astro_id in sessions.active_sessions


def test_retapping_the_same_card_never_logs_you_out(fresh_db):
    """The CYD is a personal watch (docs/CLAUDE.md "CYD pairing"), not a shared
    kiosk toggled by re-tapping -- only an explicit end_session ("Done" on the
    device, or the web's Log out) ends a session now."""
    with db.write_conn() as conn:
        astro_id = seed_minimal(conn)
    sent, emitted, send_fn, emit_fn = _recorder()

    sessions.handle_scan("A0000001", send_fn, emit_fn)
    sent.clear(); emitted.clear()

    sessions.handle_scan("A0000001", send_fn, emit_fn)  # re-tap the same card
    assert astro_id in sessions.active_sessions  # still logged in
    # handle_scan always emits "scan" (the web login flow needs that broadcast
    # regardless), but nothing else -- no session_ended, no session_started again.
    assert emitted == [("scan", {"uid": "A0000001", "type": "astronaut", "label": "Test Astro"})]
    assert sent == []


def test_tapping_a_different_card_ends_the_first_and_switches(fresh_db):
    with db.write_conn() as conn:
        astro_id = seed_minimal(conn)
        now = datetime.now(timezone.utc).isoformat()
        other_id = conn.execute(
            "INSERT INTO astronauts (name, role, color, baseline_reaction_ms, created_at) VALUES (?, ?, ?, ?, ?)",
            ("Other Astro", "Crew member", "#ffffff", 340, now),
        ).lastrowid
        conn.execute(
            "INSERT INTO tags (uid, type, label, astronaut_id, data_json) VALUES ('A0000002', 'astronaut', 'Other Astro', ?, '{}')",
            (other_id,),
        )
    sent, emitted, send_fn, emit_fn = _recorder()

    sessions.handle_scan("A0000001", send_fn, emit_fn)
    sessions.handle_scan("A0000002", send_fn, emit_fn)  # a real handoff

    assert astro_id not in sessions.active_sessions
    assert other_id in sessions.active_sessions


def test_session_message_carries_role_and_todays_vitals(fresh_db):
    with db.write_conn() as conn:
        astro_id = seed_minimal(conn)
        now = datetime.now(timezone.utc).isoformat()
        conn.execute(
            "INSERT INTO readings (astronaut_id, ts, indicator, value_json, level, source) "
            "VALUES (?, ?, 'heart_rate', ?, 'GREEN', 'manual')",
            (astro_id, now, json.dumps(72)),
        )
        conn.execute(
            "INSERT INTO readings (astronaut_id, ts, indicator, value_json, level, source) "
            "VALUES (?, ?, 'blood_pressure', ?, 'GREEN', 'manual')",
            (astro_id, now, json.dumps({"systolic": 118, "diastolic": 76})),
        )
        conn.execute(
            "INSERT INTO readings (astronaut_id, ts, indicator, value_json, level, source) "
            "VALUES (?, ?, 'mood', ?, 'GREEN', 'cyd')",
            (astro_id, now, json.dumps(4)),
        )
        conn.execute(
            "INSERT INTO readings (astronaut_id, ts, indicator, value_json, level, source) "
            "VALUES (?, ?, 'sleep', ?, 'GREEN', 'manual')",
            (astro_id, now, json.dumps({"hours": 8.0, "bedtime": "23:00", "wake_time": "07:00"})),
        )
    sent, emitted, send_fn, emit_fn = _recorder()
    sessions.handle_scan("A0000001", send_fn, emit_fn)
    session_msg = next(protocol.decode(s) for s in sent if protocol.decode(s) and protocol.decode(s)["type"] == "session")
    assert session_msg["role"] == "Commander"
    assert session_msg["today"] == {
        "heart_rate": {"v": "72", "l": "GREEN"},
        "blood_pressure": {"v": "118/76", "l": "GREEN"},
        "mood": {"v": "Good", "l": "GREEN"},
        "sleep": {"v": "8h 0m", "l": "GREEN"},
    }


def test_session_message_today_is_empty_with_no_readings(fresh_db):
    with db.write_conn() as conn:
        seed_minimal(conn)
    sent, emitted, send_fn, emit_fn = _recorder()
    sessions.handle_scan("A0000001", send_fn, emit_fn)
    session_msg = next(protocol.decode(s) for s in sent if protocol.decode(s) and protocol.decode(s)["type"] == "session")
    assert session_msg["today"] == {}


def test_object_tag_without_session_asks_to_tap_card(fresh_db):
    with db.write_conn() as conn:
        seed_minimal(conn)
    sent, emitted, send_fn, emit_fn = _recorder()
    sessions.handle_scan("T2000001", send_fn, emit_fn)
    assert any("Tap your card first" in s for s in sent)


def test_exercise_tag_toggles_start_and_stop(fresh_db):
    with db.write_conn() as conn:
        astro_id = seed_minimal(conn)
    sent, emitted, send_fn, emit_fn = _recorder()

    sessions.handle_scan("A0000001", send_fn, emit_fn)  # start session
    sessions.handle_scan("T2000001", send_fn, emit_fn)  # start exercise
    assert "T2000001" in sessions.open_toggles

    sessions.handle_scan("T2000001", send_fn, emit_fn)  # stop exercise
    assert "T2000001" not in sessions.open_toggles
    with db.write_conn() as conn:
        row = conn.execute("SELECT * FROM activities WHERE kind = 'exercise' AND astronaut_id = ?", (astro_id,)).fetchone()
    assert row is not None


def test_meal_tag_logs_activity(fresh_db):
    with db.write_conn() as conn:
        astro_id = seed_minimal(conn)
    sent, emitted, send_fn, emit_fn = _recorder()
    sessions.handle_scan("A0000001", send_fn, emit_fn)
    sessions.handle_scan("T4000001", send_fn, emit_fn)
    with db.write_conn() as conn:
        meal = conn.execute("SELECT * FROM activities WHERE kind = 'meal' AND astronaut_id = ?", (astro_id,)).fetchone()
    assert meal is not None
    assert any("Meal logged" in s for s in sent)


def test_resume_paired_session_starts_a_session_when_none_is_active(fresh_db):
    with db.write_conn() as conn:
        astro_id = seed_minimal(conn)
    sent, emitted, send_fn, emit_fn = _recorder()

    sessions.resume_paired_session("A0000001", send_fn, emit_fn)

    assert astro_id in sessions.active_sessions
    assert any(e[0] == "session_started" for e in emitted)


def test_resume_paired_session_refreshes_its_own_stale_active_entry(fresh_db):
    """A board reboot/replug resets the CYD's own curUid to empty, but
    nothing ever clears active_sessions on a mere bridge disconnect -- only
    an explicit end_session does -- so this exact astronaut's own entry is
    typically still sitting there as a stale leftover, not a real conflict.
    The original, too-strict "active_sessions is non-empty -> refuse"
    rule treated that as someone else already using the device and left a
    correctly-paired board stuck at Idle forever. Must resend instead."""
    with db.write_conn() as conn:
        astro_id = seed_minimal(conn)
    sent, emitted, send_fn, emit_fn = _recorder()

    sessions.handle_scan("A0000001", send_fn, emit_fn)  # the original tap
    sent.clear(); emitted.clear()

    sessions.resume_paired_session("A0000001", send_fn, emit_fn)  # the same device reconnecting

    assert astro_id in sessions.active_sessions
    assert any(e[0] == "session_started" for e in emitted)  # resent, not silently dropped
    assert any('"type":"session"' in s for s in sent)


def test_resume_paired_session_never_steals_a_different_active_session(fresh_db):
    with db.write_conn() as conn:
        astro_id = seed_minimal(conn)
        now = datetime.now(timezone.utc).isoformat()
        other_id = conn.execute(
            "INSERT INTO astronauts (name, role, color, baseline_reaction_ms, created_at) VALUES (?, ?, ?, ?, ?)",
            ("Other Astro", "Crew member", "#ffffff", 340, now),
        ).lastrowid
        conn.execute(
            "INSERT INTO tags (uid, type, label, astronaut_id, data_json) VALUES ('A0000002', 'astronaut', 'Other Astro', ?, '{}')",
            (other_id,),
        )
    sent, emitted, send_fn, emit_fn = _recorder()

    sessions.handle_scan("A0000001", send_fn, emit_fn)  # astro_id's session is genuinely active
    sent.clear(); emitted.clear()

    sessions.resume_paired_session("A0000002", send_fn, emit_fn)  # a different device reconnecting

    assert astro_id in sessions.active_sessions  # untouched
    assert other_id not in sessions.active_sessions  # not started either
    assert emitted == []  # a passive reconnect made no visible change


def test_resume_paired_session_ignores_an_unknown_uid(fresh_db):
    with db.write_conn() as conn:
        seed_minimal(conn)
    sent, emitted, send_fn, emit_fn = _recorder()
    sessions.resume_paired_session("ZZZZZZZZ", send_fn, emit_fn)
    assert sessions.active_sessions == {}
    assert sent == [] and emitted == []


def test_resume_paired_session_ignores_a_legacy_surgeon_tag_with_no_account(fresh_db):
    """seed_minimal's 'D1000001' is the pre-login-era surgeon tag shape
    (astronaut_id NULL) -- resuming must never try to start a session for
    an astronaut that doesn't exist."""
    with db.write_conn() as conn:
        seed_minimal(conn)
    sent, emitted, send_fn, emit_fn = _recorder()
    sessions.resume_paired_session("D1000001", send_fn, emit_fn)
    assert sessions.active_sessions == {}
    assert sent == [] and emitted == []


def test_emergency_card_sets_emergency_state(fresh_db):
    with db.write_conn() as conn:
        seed_minimal(conn)
    sent, emitted, send_fn, emit_fn = _recorder()
    sessions.handle_scan("E9000001", send_fn, emit_fn)
    assert sessions.emergency["active"] is True
    assert any('"type":"emergency"' in s and '"active":true' in s for s in sent)

    sent.clear(); emitted.clear()
    sessions.cancel_emergency(send_fn, emit_fn)
    assert sessions.emergency["active"] is False


def test_surgeon_tag_unlocks_surgeon_view(fresh_db):
    with db.write_conn() as conn:
        seed_minimal(conn)
    sent, emitted, send_fn, emit_fn = _recorder()
    assert sessions.is_surgeon_unlocked() is False
    sessions.handle_scan("D1000001", send_fn, emit_fn)
    assert sessions.is_surgeon_unlocked() is True


# ---- Flight Surgeon on-device screens (phase 2 of the CYD redesign) --
# seed_minimal's own "D1000001" tag is the legacy, astronaut_id-less
# surgeon-unlock card (see test above) -- these tests need a *real*,
# logged-in-as astronaut whose role is exactly "Flight surgeon", so they
# seed one directly. Tag type is deliberately "surgeon", matching real
# backend/seed.py's own SURGEON tag exactly (not "astronaut") -- an
# earlier version of this fixture used "astronaut" here, which silently
# missed the real bug (handle_scan() used to route a real,
# astronaut_id-having "surgeon"-type tag to the legacy unlock-only path,
# never starting a session at all -- see the "surgeon home screen showing
# no crew assigned" follow-up entry in docs/CLAUDE.md).
def _seed_surgeon_and_crew(conn):
    now = datetime.now(timezone.utc).isoformat()
    surgeon_id = conn.execute(
        "INSERT INTO astronauts (name, role, color, baseline_reaction_ms, created_at) VALUES (?, 'Flight surgeon', ?, 340, ?)",
        ("Dr. Surgeon", "#2fbfa8", now),
    ).lastrowid
    conn.execute("INSERT INTO tags (uid, type, label, astronaut_id, data_json) VALUES ('S9000001', 'surgeon', 'Dr. Surgeon', ?, '{}')",
                 (surgeon_id,))
    crew_id = seed_minimal(conn)  # "Test Astro", role "Commander", uid A0000001
    return surgeon_id, crew_id


def test_surgeon_session_also_pushes_crew_alerts_and_inbox(fresh_db):
    with db.write_conn() as conn:
        _seed_surgeon_and_crew(conn)
    sent, emitted, send_fn, emit_fn = _recorder()
    sessions.handle_scan("S9000001", send_fn, emit_fn)
    types = [protocol.decode(s)["type"] for s in sent if protocol.decode(s)]
    assert types == ["session", "led", "crew_list", "alerts_list", "inbox_list"]


def test_non_surgeon_session_does_not_push_surgeon_lists(fresh_db):
    with db.write_conn() as conn:
        seed_minimal(conn)
    sent, emitted, send_fn, emit_fn = _recorder()
    sessions.handle_scan("A0000001", send_fn, emit_fn)
    types = [protocol.decode(s)["type"] for s in sent if protocol.decode(s)]
    assert "crew_list" not in types and "alerts_list" not in types and "inbox_list" not in types


def test_crew_list_for_cyd_includes_level_and_open_alert_flag(fresh_db):
    with db.write_conn() as conn:
        _, crew_id = _seed_surgeon_and_crew(conn)
        conn.execute(
            "INSERT INTO assessments (astronaut_id, ts, overall_level, note, details_json) VALUES (?, ?, 'YELLOW', 'x', '{}')",
            (crew_id, datetime.now(timezone.utc).isoformat()),
        )
        conn.execute(
            "INSERT INTO alerts (astronaut_id, ts, level, text, acknowledged) VALUES (?, ?, 'RED', 'Flagged: heart rate', 0)",
            (crew_id, datetime.now(timezone.utc).isoformat()),
        )
        items = sessions.crew_list_for_cyd(conn)
    assert items == [{"id": crew_id, "n": "Test Astro", "l": "YELLOW", "al": 1}]


def test_alerts_list_for_cyd_only_open_newest_first(fresh_db):
    with db.write_conn() as conn:
        _, crew_id = _seed_surgeon_and_crew(conn)
        conn.execute(
            "INSERT INTO alerts (astronaut_id, ts, level, text, acknowledged) VALUES (?, '2026-01-01T00:00:00+00:00', 'RED', 'old, already acked', 1)",
            (crew_id,),
        )
        conn.execute(
            "INSERT INTO alerts (astronaut_id, ts, level, text, acknowledged) VALUES (?, '2026-01-02T00:00:00+00:00', 'RED', 'newer, still open', 0)",
            (crew_id,),
        )
        items = sessions.alerts_list_for_cyd(conn)
    assert len(items) == 1
    assert items[0]["who"] == "Test Astro"
    assert items[0]["t"] == "newer, still open"
    assert items[0]["ts"] == "00:00"


def test_inbox_for_cyd_hides_reports_still_in_transit(fresh_db):
    with db.write_conn() as conn:
        _, crew_id = _seed_surgeon_and_crew(conn)
        future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
        conn.execute(
            "INSERT INTO messages (from_role, astronaut_id, body, sent_at, deliver_at, read) VALUES ('crew', ?, 'help, chest pain', ?, ?, 0)",
            (crew_id, datetime.now(timezone.utc).isoformat(), future),
        )
        assert sessions.inbox_for_cyd(conn) == []  # still in transit -- not shown yet

        past = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
        conn.execute(
            "UPDATE messages SET deliver_at = ? WHERE astronaut_id = ?", (past, crew_id),
        )
        items = sessions.inbox_for_cyd(conn)
    assert len(items) == 1
    assert items[0] == {"astro_id": crew_id, "who": "Test Astro", "body": "help, chest pain", "ts": items[0]["ts"]}


def test_inbox_for_cyd_hides_a_report_already_replied_to(fresh_db):
    """The actual bug report: replying from the CYD made the report
    disappear for a moment, then reappear on the next refresh -- it was
    still "the latest crew message", nothing marked it handled."""
    with db.write_conn() as conn:
        _, crew_id = _seed_surgeon_and_crew(conn)
        past = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
        conn.execute(
            "INSERT INTO messages (from_role, astronaut_id, body, sent_at, deliver_at, read) VALUES ('crew', ?, 'help, chest pain', ?, ?, 1)",
            (crew_id, past, past),
        )
        assert len(sessions.inbox_for_cyd(conn)) == 1  # not replied to yet

    comms.queue_reply(crew_id, "Rest and re-check in 1 hour")  # opens its own write_conn -- can't nest inside the one above

    with db.write_conn() as conn:
        assert sessions.inbox_for_cyd(conn) == []  # replied -- no longer shown

        # A second, later crew report after the reply must still show.
        later = datetime.now(timezone.utc).isoformat()
        conn.execute(
            "INSERT INTO messages (from_role, astronaut_id, body, sent_at, deliver_at, read) VALUES ('crew', ?, 'worse now', ?, ?, 1)",
            (crew_id, later, later),
        )
        items = sessions.inbox_for_cyd(conn)
    assert len(items) == 1 and items[0]["body"] == "worse now"


def test_crew_detail_for_cyd_reports_whether_on_the_cyd_now(fresh_db):
    with db.write_conn() as conn:
        _, crew_id = _seed_surgeon_and_crew(conn)
        detail = sessions.crew_detail_for_cyd(conn, crew_id)
    assert detail["n"] == "Test Astro"
    assert detail["on"] is False

    sessions.active_sessions[crew_id] = {"uid": "A0000001", "started_at": 0, "last_activity": 0, "cyd_contact": 0}
    with db.write_conn() as conn:
        detail = sessions.crew_detail_for_cyd(conn, crew_id)
    assert detail["on"] is True


def test_crew_detail_for_cyd_unknown_astronaut_returns_none(fresh_db):
    with db.write_conn() as conn:
        seed_minimal(conn)
        assert sessions.crew_detail_for_cyd(conn, 9999) is None


def test_refresh_surgeon_cyd_resends_every_tick_even_if_unchanged(fresh_db):
    """Deliberately unconditional (see send_surgeon_payload()'s own
    docstring for why a cached/diffed version was tried and reverted):
    self-healing against this project's documented occasional
    dropped/corrupted serial line matters more than skipping a resend of
    identical data, for a payload this small."""
    with db.write_conn() as conn:
        surgeon_id, _ = _seed_surgeon_and_crew(conn)
        sessions.active_sessions[surgeon_id] = {"uid": "S9000001", "started_at": 0, "last_activity": 0, "cyd_contact": 0}

    sent, emitted, send_fn, emit_fn = _recorder()
    sessions.refresh_surgeon_cyd(send_fn)
    first_types = [protocol.decode(s)["type"] for s in sent if protocol.decode(s)]
    assert first_types == ["crew_list", "alerts_list", "inbox_list"]

    sent.clear()
    sessions.refresh_surgeon_cyd(send_fn)  # nothing changed in between -- still sends again
    second_types = [protocol.decode(s)["type"] for s in sent if protocol.decode(s)]
    assert second_types == ["crew_list", "alerts_list", "inbox_list"]


def test_surgeon_payload_is_resent_on_a_fresh_session(fresh_db):
    with db.write_conn() as conn:
        surgeon_id, _ = _seed_surgeon_and_crew(conn)
    sent, emitted, send_fn, emit_fn = _recorder()
    sessions.handle_scan("S9000001", send_fn, emit_fn)  # tap in
    sessions.end_session_for(surgeon_id, send_fn, emit_fn)  # an explicit end (e.g. "Done") -- a re-tap no longer does this
    sent.clear()
    sessions.handle_scan("S9000001", send_fn, emit_fn)  # tap back in -- same data, must still send
    types = [protocol.decode(s)["type"] for s in sent if protocol.decode(s)]
    assert types == ["session", "led", "crew_list", "alerts_list", "inbox_list"]


def test_a_scan_is_remembered_briefly_for_a_reconnecting_browser(fresh_db, monkeypatch):
    with db.write_conn() as conn:
        seed_minimal(conn)
    sessions.handle_scan("A0000001", lambda line: None, lambda e, d: None, web_only=True)
    recent = sessions.recent_scan()
    assert recent["uid"] == "A0000001" and recent["age_s"] < 1
    monkeypatch.setattr(sessions.time, "time", lambda: sessions.last_scan["at"] + sessions.RECENT_SCAN_S + 1)
    assert sessions.recent_scan() == {}


def test_an_unknown_card_is_not_remembered_as_a_login_scan(fresh_db):
    with db.write_conn() as conn:
        seed_minimal(conn)
    sessions.handle_scan("NOPE0000", lambda line: None, lambda e, d: None)
    assert sessions.recent_scan() == {}
