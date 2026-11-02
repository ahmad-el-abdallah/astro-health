from backend import db, sessions
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


def test_astronaut_tap_starts_then_ends_session(fresh_db):
    with db.write_conn() as conn:
        astro_id = seed_minimal(conn)
    sent, emitted, send_fn, emit_fn = _recorder()

    sessions.handle_scan("A0000001", send_fn, emit_fn)
    assert astro_id in sessions.active_sessions
    assert any(e[0] == "session_started" for e in emitted)

    sent.clear(); emitted.clear()
    sessions.handle_scan("A0000001", send_fn, emit_fn)
    assert astro_id not in sessions.active_sessions
    assert any(e[0] == "session_ended" for e in emitted)


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


def test_meal_tag_logs_activity_and_awards_points(fresh_db):
    with db.write_conn() as conn:
        astro_id = seed_minimal(conn)
    sent, emitted, send_fn, emit_fn = _recorder()
    sessions.handle_scan("A0000001", send_fn, emit_fn)
    sessions.handle_scan("T4000001", send_fn, emit_fn)
    with db.write_conn() as conn:
        pts = conn.execute("SELECT COALESCE(SUM(amount),0) AS t FROM points WHERE astronaut_id = ?", (astro_id,)).fetchone()["t"]
    assert pts > 0
    assert any("Meal logged" in s for s in sent)


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
