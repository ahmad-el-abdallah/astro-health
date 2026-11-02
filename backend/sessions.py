"""Tag-tap logic: what happens when a card or tag is scanned (see
docs/build-prompt.md section 12). Pure-ish functions that take send_fn
(writes a protocol line to the CYD) and emit_fn(event, data) (tells the
browser dashboards) as arguments, so this module doesn't need Flask or a
real serial port to be unit tested.

In-memory state only (active_sessions, open toggles): sessions are a
live-demo concept, not history -- history lives in the readings/activities
tables.
"""
import json
import time
from datetime import datetime, timezone

from backend import db, protocol, health_rules, comms
from backend.config import gamification as load_gamification

SESSION_TIMEOUT_S = 120
SURGEON_UNLOCK_S = 10 * 60

# astronaut_id -> {"uid":, "started_at":, "last_activity":}
active_sessions = {}
# tag_uid -> {"astronaut_id":, "kind":, "started_at":}
open_toggles = {}
surgeon_unlocked_until = 0.0
emergency = {"active": False, "text": ""}


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _get_tag(conn, uid):
    return conn.execute("SELECT * FROM tags WHERE uid = ?", (uid,)).fetchone()


def _get_astronaut(conn, astronaut_id):
    return conn.execute("SELECT * FROM astronauts WHERE id = ?", (astronaut_id,)).fetchone()


def _latest_level(conn, astronaut_id):
    row = conn.execute(
        "SELECT overall_level FROM assessments WHERE astronaut_id = ? ORDER BY ts DESC LIMIT 1",
        (astronaut_id,),
    ).fetchone()
    return row["overall_level"] if row else "GREEN"


def _total_points(conn, astronaut_id):
    row = conn.execute("SELECT COALESCE(SUM(amount), 0) AS total FROM points WHERE astronaut_id = ?",
                        (astronaut_id,)).fetchone()
    return row["total"]


def _award(conn, astronaut_id, reason):
    points_cfg = load_gamification()["points"]
    amount = points_cfg.get(reason, 0)
    if amount:
        conn.execute("INSERT INTO points (astronaut_id, ts, amount, reason) VALUES (?, ?, ?, ?)",
                     (astronaut_id, _now_iso(), amount, reason))
    return amount


def _start_session(conn, astronaut, uid, send_fn, emit_fn):
    active_sessions[astronaut["id"]] = {
        "uid": uid, "started_at": time.time(), "last_activity": time.time(),
    }
    level = _latest_level(conn, astronaut["id"])
    points = _total_points(conn, astronaut["id"])
    send_fn(protocol.session(astronaut["name"], uid, level, points))
    send_fn(protocol.led(level))
    emit_fn("session_started", {"astronaut_id": astronaut["id"], "name": astronaut["name"], "level": level, "points": points})


def _end_session(conn, astronaut_id, send_fn, emit_fn):
    active_sessions.pop(astronaut_id, None)
    send_fn(protocol.idle())
    send_fn(protocol.led("OFF"))
    emit_fn("session_ended", {"astronaut_id": astronaut_id})


def end_session_for(astronaut_id, send_fn, emit_fn):
    with db.write_conn() as conn:
        _end_session(conn, astronaut_id, send_fn, emit_fn)


def _handle_astronaut_tag(conn, tag, send_fn, emit_fn):
    astronaut_id = tag["astronaut_id"]
    if astronaut_id in active_sessions:
        _end_session(conn, astronaut_id, send_fn, emit_fn)
        return
    for other_id in list(active_sessions.keys()):
        _end_session(conn, other_id, send_fn, emit_fn)
    astronaut = _get_astronaut(conn, astronaut_id)
    _start_session(conn, astronaut, tag["uid"], send_fn, emit_fn)


def _handle_surgeon_tag(conn, tag, send_fn, emit_fn):
    global surgeon_unlocked_until
    surgeon_unlocked_until = time.time() + SURGEON_UNLOCK_S
    emit_fn("surgeon_unlocked", {"until": surgeon_unlocked_until, "name": tag["label"]})


def start_emergency(text, astronaut_id, send_fn, emit_fn):
    emergency["active"] = True
    emergency["text"] = text
    with db.write_conn() as conn:
        conn.execute("INSERT INTO alerts (astronaut_id, ts, level, text, acknowledged) VALUES (?, ?, 'RED', ?, 0)",
                     (astronaut_id, _now_iso(), text))
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('emergency_active', 'true')")
    send_fn(protocol.emergency(True, text))
    send_fn(protocol.led("RED"))
    emit_fn("emergency", {"active": True, "text": text, "astronaut_id": astronaut_id})
    comms.queue_report(astronaut_id, f"EMERGENCY: {text}")


def cancel_emergency(send_fn, emit_fn):
    emergency["active"] = False
    emergency["text"] = ""
    with db.write_conn() as conn:
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('emergency_active', 'false')")
    send_fn(protocol.emergency(False, ""))
    send_fn(protocol.led("OFF"))
    emit_fn("emergency", {"active": False, "text": ""})


def _current_session_astronaut_id():
    if not active_sessions:
        return None
    return next(iter(active_sessions.keys()))


def _touch_session(astronaut_id):
    if astronaut_id in active_sessions:
        active_sessions[astronaut_id]["last_activity"] = time.time()


def _handle_object_tag(conn, tag, send_fn, emit_fn):
    kind = tag["type"]
    extra = json.loads(tag["data_json"] or "{}")

    if tag["uid"] in open_toggles:
        info = open_toggles.pop(tag["uid"])
        astronaut_id = info["astronaut_id"]
        started_at = info["started_at"]
        duration_s = time.time() - started_at
        _touch_session(astronaut_id)
        if kind == "exercise":
            minutes = max(1, round(duration_s / 60))
            conn.execute(
                "INSERT INTO activities (astronaut_id, kind, started_at, ended_at, data_json) VALUES (?, ?, ?, ?, ?)",
                (astronaut_id, "exercise", info["started_iso"], _now_iso(), json.dumps({"minutes": minutes, "tag": tag["uid"]})),
            )
            lvl = health_rules.evaluate("exercise", minutes)
            conn.execute("INSERT INTO readings (astronaut_id, ts, indicator, value_json, level, source) VALUES (?, ?, 'exercise', ?, ?, 'tag')",
                         (astronaut_id, _now_iso(), json.dumps(minutes), lvl))
            amount = _award(conn, astronaut_id, "exercise_session")
            send_fn(protocol.exercise("stop", minutes))
            send_fn(protocol.toast(f"Workout done: {minutes} min (+{amount} pts)"))
            emit_fn("cyd_event", {"type": "exercise_stop", "astronaut_id": astronaut_id, "minutes": minutes})
        elif kind == "sleep":
            hours = round(duration_s / 3600, 1)
            conn.execute(
                "INSERT INTO activities (astronaut_id, kind, started_at, ended_at, data_json) VALUES (?, ?, ?, ?, ?)",
                (astronaut_id, "sleep", info["started_iso"], _now_iso(), json.dumps({"hours": hours})),
            )
            lvl = health_rules.evaluate("sleep", hours)
            conn.execute("INSERT INTO readings (astronaut_id, ts, indicator, value_json, level, source) VALUES (?, ?, 'sleep', ?, ?, 'tag')",
                         (astronaut_id, _now_iso(), json.dumps(hours), lvl))
            amount = _award(conn, astronaut_id, "sleep_logged")
            send_fn(protocol.sleep("stop", hours))
            send_fn(protocol.toast(f"Slept {hours} h (+{amount} pts)"))
            emit_fn("cyd_event", {"type": "sleep_stop", "astronaut_id": astronaut_id, "hours": hours})
        return

    if kind in ("exercise", "sleep"):
        astronaut_id = _current_session_astronaut_id()
        if astronaut_id is None:
            send_fn(protocol.toast("Tap your card first", "YELLOW"))
            return
        open_toggles[tag["uid"]] = {"astronaut_id": astronaut_id, "kind": kind, "started_at": time.time(), "started_iso": _now_iso()}
        _touch_session(astronaut_id)
        if kind == "exercise":
            send_fn(protocol.exercise("start", 0))
            send_fn(protocol.toast(f"Workout started: {tag['label']}"))
        else:
            send_fn(protocol.sleep("start", 0))
            send_fn(protocol.toast("Good night"))
        emit_fn("cyd_event", {"type": f"{kind}_start", "astronaut_id": astronaut_id})
        return

    # one-shot object tags: meal, medicine, bp_guide
    astronaut_id = _current_session_astronaut_id()
    if astronaut_id is None:
        send_fn(protocol.toast("Tap your card first", "YELLOW"))
        return
    _touch_session(astronaut_id)
    if kind == "meal":
        conn.execute("INSERT INTO activities (astronaut_id, kind, started_at, ended_at, data_json) VALUES (?, ?, ?, ?, ?)",
                     (astronaut_id, "meal", _now_iso(), _now_iso(), json.dumps({"tag": tag["uid"], "label": tag["label"], **extra})))
        amount = _award(conn, astronaut_id, "meal_logged")
        kcal = extra.get("kcal", 0)
        send_fn(protocol.toast(f"Meal logged: {kcal} kcal (+{amount} pts)"))
        emit_fn("cyd_event", {"type": "meal", "astronaut_id": astronaut_id, "label": tag["label"], **extra})
    elif kind == "medicine":
        conn.execute("INSERT INTO activities (astronaut_id, kind, started_at, ended_at, data_json) VALUES (?, ?, ?, ?, ?)",
                     (astronaut_id, "medicine", _now_iso(), _now_iso(), json.dumps({"tag": tag["uid"], "label": tag["label"]})))
        send_fn(protocol.toast(f"Logged: {tag['label']}"))
        emit_fn("cyd_event", {"type": "medicine", "astronaut_id": astronaut_id, "label": tag["label"]})
    elif kind == "bp_guide":
        send_fn(protocol.toast("Check the blood pressure guide on the laptop"))
        emit_fn("cyd_event", {"type": "open_guide", "astronaut_id": astronaut_id, "indicator": "blood_pressure"})


def handle_scan(uid, send_fn, emit_fn):
    """The single entry point for a 'scan' message, whether it came from a
    real CYD over serial or the Simulator panel."""
    with db.write_conn() as conn:
        tag = _get_tag(conn, uid)
        if tag is None:
            send_fn(protocol.unknown_tag(uid))
            emit_fn("unknown_tag", {"uid": uid})
            return
        emit_fn("scan", {"uid": uid, "type": tag["type"], "label": tag["label"]})
        if tag["type"] == "astronaut":
            _handle_astronaut_tag(conn, tag, send_fn, emit_fn)
        elif tag["type"] == "surgeon":
            _handle_surgeon_tag(conn, tag, send_fn, emit_fn)
        elif tag["type"] == "emergency":
            start_emergency("Emergency card scanned", _current_session_astronaut_id(), send_fn, emit_fn)
        else:
            _handle_object_tag(conn, tag, send_fn, emit_fn)


def check_timeouts(send_fn, emit_fn):
    """Call every few seconds from a background loop: ends any session idle
    for more than SESSION_TIMEOUT_S."""
    now = time.time()
    for astronaut_id, info in list(active_sessions.items()):
        if now - info["last_activity"] > SESSION_TIMEOUT_S:
            with db.write_conn() as conn:
                _end_session(conn, astronaut_id, send_fn, emit_fn)


def is_surgeon_unlocked():
    return time.time() < surgeon_unlocked_until
