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
from datetime import datetime, timedelta, timezone

from backend import db
from backend.hardware import protocol
from backend.logic import health_rules
from backend.jobs import comms

from backend.config import SESSION_IDLE_S, TIME_SCALE

# The CYD runs the real idle timeout (SESSION_IDLE_S since its last touch) and reports it
# as end_session reason "idle". This laptop-side timeout is only the safety net for when
# no CYD is connected or it went silent, so it's a little longer; CYD touches keep it
# fresh via note_cyd_contact() (any CYD message, including the once-a-minute "active").
SESSION_TIMEOUT_S = SESSION_IDLE_S + 30
SURGEON_UNLOCK_S = 10 * 60

# astronaut_id -> {"uid":, "started_at":, "last_activity":}
active_sessions = {}
# tag_uid -> {"astronaut_id":, "kind":, "started_at":}
open_toggles = {}
surgeon_unlocked_until = 0.0
emergency = {"active": False, "text": ""}

# uid -> {"uid":, "first_seen":, "last_seen":, "count":}: unknown-tag taps
# the superuser admin page (/admin) needs to see even if nobody's browser
# was open at the exact moment of the tap. In-memory only, same live-demo-
# not-history philosophy as active_sessions/open_toggles above -- capped so
# someone repeatedly tapping junk cards can't grow this forever. A dict
# (Python 3.7+ preserves insertion order) re-inserts on every repeat tap so
# iteration order stays oldest-first without a separate timestamp sort.
UNKNOWN_BACKLOG_MAX = 50
unknown_tag_backlog = {}

# The most recent known-card scan: {"uid", "at" (epoch s)}. A browser whose live
# connection was down at that moment asks for it on reconnect (GET /api/recent-scan), so a
# tap made during a brief disconnect isn't silently lost -- see docs/CLAUDE.md
# "Lost NFC scans". In-memory like everything else here.
last_scan = {}
RECENT_SCAN_S = 30


def recent_scan():
    """The last scan if it's under RECENT_SCAN_S old: {"uid", "age_s"}, else {}."""
    if not last_scan:
        return {}
    age = time.time() - last_scan["at"]
    return {"uid": last_scan["uid"], "age_s": round(age, 2)} if age <= RECENT_SCAN_S else {}

# The login page's "Also sign in my CYD" / "This browser only" choice
# (docs/CLAUDE.md "web-only login"), as a *global* current mode rather than
# a per-tap flag -- a real physical tap (the Pico, the only NFC reader this
# whole system actually has) can't carry a browser's preference the way a
# Simulator-originated scan can (it's just a bare {"type":"scan","uid":...}
# line with no way for the hardware to know what any browser has selected).
# set_scan_mode() is called whenever the login page's choice changes, so a
# real tap right after flipping it is covered too, not just software taps.
# In-memory only, same live-demo-not-history philosophy as active_sessions
# above -- resets to "cyd" (today's long-standing default) on every restart.
current_scan_mode = "cyd"


def set_scan_mode(mode):
    global current_scan_mode
    current_scan_mode = "web" if mode == "web" else "cyd"


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


# Bare-number mood readings (the CYD's own face-tap path, see
# routes.py's _record_cyd_value) don't carry the word the web Mental
# Health tab's object-shaped readings do (routes.py's MOOD_SCORES) --
# this is that same 1-5 scale, reversed, so the CYD's own crew-home vital
# tile can show a word either way. Kept here, not imported from routes.py,
# to avoid a circular import (routes.py already imports this module).
_MOOD_SCORE_WORDS = {1: "Rough", 2: "Low", 3: "Okay", 4: "Good", 5: "Great"}


def _today_vitals_for_cyd(conn, astronaut_id):
    """Compact heart_rate/blood_pressure/mood/sleep/temperature snapshot
    for the CYD's crew-home and (phase 2) crew-detail vitals tiles -- same
    last-24h/first-row-wins idiom as routes.py's _today_snapshot(), kept
    here rather than imported from it (routes.py already imports this
    module, so the reverse would be circular). Pre-formatted into short
    display strings so the firmware does zero value-shape parsing of its
    own, matching every reading's dual-shape handling already established
    on the frontend (sleep/mood can be a bare number from a physical
    tag/CYD tap, or a richer object from the web tabs' own POST routes --
    see docs/CLAUDE.md's "sleep/mood readings showed raw JSON" entry)."""
    since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
    rows = {}
    for r in conn.execute(
        "SELECT indicator, value_json, level FROM readings WHERE astronaut_id = ? AND ts >= ? "
        "AND indicator IN ('heart_rate','blood_pressure','mood','sleep','temperature') ORDER BY ts DESC",
        (astronaut_id, since),
    ):
        if r["indicator"] not in rows:
            rows[r["indicator"]] = r
    out = {}
    if "heart_rate" in rows:
        r = rows["heart_rate"]
        out["heart_rate"] = {"v": str(round(json.loads(r["value_json"]))), "l": r["level"]}
    if "blood_pressure" in rows:
        r = rows["blood_pressure"]
        bp = json.loads(r["value_json"])
        out["blood_pressure"] = {"v": f"{bp['systolic']}/{bp['diastolic']}", "l": r["level"]}
    if "mood" in rows:
        r = rows["mood"]
        v = json.loads(r["value_json"])
        word = v["mood"].capitalize() if isinstance(v, dict) else _MOOD_SCORE_WORDS.get(int(v), "?")
        out["mood"] = {"v": word, "l": r["level"]}
    if "sleep" in rows:
        r = rows["sleep"]
        v = json.loads(r["value_json"])
        hours = v["hours"] if isinstance(v, dict) else v
        h, m = int(hours), round((hours - int(hours)) * 60)
        out["sleep"] = {"v": f"{h}h {m}m", "l": r["level"]}
    if "temperature" in rows:
        r = rows["temperature"]
        out["temperature"] = {"v": f"{json.loads(r['value_json']):.1f}", "l": r["level"]}
    return out


# ---- Flight Surgeon on-device screens (phase 2 of the CYD redesign -- see
# docs/CLAUDE.md's "CYD redesign" entries): crew roster, open alerts, and
# the latest incoming crew report, all capped to a handful of items each so
# the encoded line always comfortably fits the firmware's 512-byte buffer
# (protocol.MAX_LINE_BYTES) regardless of how large the crew/alert backlog
# grows -- a hackathon crew is a handful of people, not hundreds. ----
CREW_LIST_MAX = 4
ALERTS_LIST_MAX = 3


def crew_list_for_cyd(conn):
    """Non-surgeon roster for the surgeon's on-device home screen: name,
    overall level, and whether they have an open (unacknowledged) alert."""
    out = []
    for a in conn.execute("SELECT * FROM astronauts WHERE role != 'Flight surgeon' ORDER BY id LIMIT ?", (CREW_LIST_MAX,)):
        has_alert = conn.execute(
            "SELECT 1 FROM alerts WHERE astronaut_id = ? AND acknowledged = 0 LIMIT 1", (a["id"],)
        ).fetchone() is not None
        out.append({"id": a["id"], "n": a["name"], "l": _latest_level(conn, a["id"]), "al": 1 if has_alert else 0})
    return out


def alerts_list_for_cyd(conn):
    """Most recent open alerts, worst/newest first -- same ordering the web
    Alerts screen uses (ts DESC; level isn't re-sorted since every row in
    this table is already RED, the table's only convention)."""
    out = []
    for r in conn.execute(
        "SELECT alerts.id AS id, alerts.ts AS ts, alerts.text AS text, astronauts.name AS who "
        "FROM alerts LEFT JOIN astronauts ON astronauts.id = alerts.astronaut_id "
        "WHERE alerts.acknowledged = 0 ORDER BY alerts.ts DESC LIMIT ?",
        (ALERTS_LIST_MAX,),
    ):
        out.append({"id": r["id"], "who": r["who"] or "?", "t": r["text"][:40], "ts": r["ts"][11:16]})
    return out


def inbox_for_cyd(conn):
    """Just the single latest *delivered*, *not-yet-replied-to* incoming
    crew report, if any -- the mockup's Inbox screen shows one report +
    quick-reply buttons, not a scrollable history (this firmware has no
    scrolling touch model at all yet). Same delay-aware rule
    routes.py's astronaut_messages() uses: a report still in transit
    isn't shown.

    "Replied to" has no dedicated column (the `messages` table's own
    `read` means "delivered", not "handled" -- see docs/CLAUDE.md's "CYD
    redesign phase 2" entry) -- derived instead as "a surgeon-origin
    message to the same astronaut exists with a later sent_at", which is
    true the instant either the CYD's own quick-reply or the web UI's own
    reply (POST /messages) goes out, whichever happens first. Without
    this, replying from the CYD made the report vanish for a moment (the
    firmware's own optimistic local clear) and then reappear on the very
    next refresh, since the report itself was still "the latest crew
    message" with nothing marking it handled."""
    row = conn.execute(
        "SELECT id, astronaut_id, body, sent_at, deliver_at FROM messages "
        "WHERE from_role = 'crew' ORDER BY sent_at DESC LIMIT 1"
    ).fetchone()
    if not row or row["deliver_at"] > _now_iso():
        return []
    already_replied = conn.execute(
        "SELECT 1 FROM messages WHERE astronaut_id = ? AND from_role = 'surgeon' AND sent_at > ? LIMIT 1",
        (row["astronaut_id"], row["sent_at"]),
    ).fetchone() is not None
    if already_replied:
        return []
    astro = _get_astronaut(conn, row["astronaut_id"])
    return [{"astro_id": row["astronaut_id"], "who": astro["name"] if astro else "?",
              "body": row["body"][:120], "ts": row["sent_at"][11:16]}]


def crew_detail_for_cyd(conn, astronaut_id):
    """One crew member's full vitals for the surgeon's Crew Detail screen,
    fetched on demand (a `view_crew` message from the CYD) rather than
    bundled into crew_list_for_cyd -- keeps that list's per-member cost
    small and fixed regardless of how much detail this screen shows."""
    astronaut = _get_astronaut(conn, astronaut_id)
    if not astronaut:
        return None
    last = conn.execute("SELECT MAX(ts) AS t FROM readings WHERE astronaut_id = ?", (astronaut_id,)).fetchone()["t"]
    return {
        "id": astronaut_id, "n": astronaut["name"], "l": _latest_level(conn, astronaut_id),
        "v": _today_vitals_for_cyd(conn, astronaut_id),
        "ts": last[11:16] if last else "",
        "on": astronaut_id in active_sessions,
    }


def send_surgeon_payload(conn, send_fn):
    """Pushes the Flight Surgeon's three on-device lists in one go -- called
    right after her session message (first tap) and again on every
    background tick while she's signed in (see refresh_surgeon_cyd below).

    Deliberately unconditional (no diffing against what was last sent) --
    an earlier version tried caching/skipping unchanged sends to stop the
    firmware from redrawing the whole screen every tick, but that traded
    one bug for a worse one: this project's USB-serial link is documented
    to sometimes corrupt/drop a line in a fast burst (see "USB serial
    reliability" above), and if the one dropped line happened to be part
    of what got cached as "already sent," the CYD could stay stuck showing
    stale/incomplete data indefinitely, since nothing ever looked
    "changed" again to trigger a resend. The screen-redraw-every-tick
    problem is now solved on the firmware side instead
    (`redrawSurgeonHomeThrottled()`, screens.ino), which also makes this
    resend self-healing -- any single dropped line gets corrected on the
    very next tick, a couple of seconds later, instead of needing a
    cache-invalidating change to happen first."""
    send_fn(protocol.crew_list(crew_list_for_cyd(conn)))
    send_fn(protocol.alerts_list(alerts_list_for_cyd(conn)))
    send_fn(protocol.inbox_list(inbox_for_cyd(conn)))


def refresh_surgeon_cyd(send_fn):
    """Called every background tick from app.py, same cadence as
    check_timeouts()."""
    if len(active_sessions) != 1:
        return
    (astronaut_id,) = active_sessions.keys()
    with db.write_conn() as conn:
        astronaut = _get_astronaut(conn, astronaut_id)
        if astronaut and astronaut["role"] == "Flight surgeon":
            send_surgeon_payload(conn, send_fn)


def _start_session(conn, astronaut, uid, send_fn, emit_fn):
    active_sessions[astronaut["id"]] = {
        "uid": uid, "started_at": time.time(), "last_activity": time.time(),
        # When the CYD's own 2-minute idle timer was last reset, as far as the laptop
        # can tell: the session message resets it, and so does any message the CYD
        # sends from its touchscreen. Object-tag scans (from the Pico reader) don't.
        "cyd_contact": time.time(),
    }
    level = _latest_level(conn, astronaut["id"])
    today = _today_vitals_for_cyd(conn, astronaut["id"])
    send_fn(protocol.session(astronaut["name"], uid, level, SESSION_IDLE_S, astronaut["role"], today))
    send_fn(protocol.led(level))
    if astronaut["role"] == "Flight surgeon":
        send_surgeon_payload(conn, send_fn)
    emit_fn("session_started", {"astronaut_id": astronaut["id"], "name": astronaut["name"], "level": level})


def _end_session(conn, astronaut_id, send_fn, emit_fn):
    active_sessions.pop(astronaut_id, None)
    send_fn(protocol.idle())
    send_fn(protocol.led("OFF"))
    emit_fn("session_ended", {"astronaut_id": astronaut_id})


def end_session_for(astronaut_id, send_fn, emit_fn):
    with db.write_conn() as conn:
        _end_session(conn, astronaut_id, send_fn, emit_fn)


def _handle_astronaut_tag(conn, tag, send_fn, emit_fn):
    """A CYD behaves like a personal watch now (docs/CLAUDE.md "CYD pairing"), not a
    shared kiosk you toggle on and off by re-tapping -- re-tapping your own card must
    never log you out, only "Done" on the device (or the web's own Log out button)
    does. Tapping a *different* card still switches the device to them, ending
    whoever was on it (a real handoff)."""
    astronaut_id = tag["astronaut_id"]
    if astronaut_id in active_sessions:
        note_cyd_contact(astronaut_id)  # still a sign of life -- keep the idle timer fresh
        return
    for other_id in list(active_sessions.keys()):
        _end_session(conn, other_id, send_fn, emit_fn)
    astronaut = _get_astronaut(conn, astronaut_id)
    _start_session(conn, astronaut, tag["uid"], send_fn, emit_fn)


def _handle_surgeon_tag(conn, tag, send_fn, emit_fn):
    global surgeon_unlocked_until
    surgeon_unlocked_until = time.time() + SURGEON_UNLOCK_S
    emit_fn("surgeon_unlocked", {"until": surgeon_unlocked_until, "name": tag["label"]})


def resume_paired_session(uid, send_fn, emit_fn):
    """A CYD that's been paired to one astronaut (see docs/CLAUDE.md's "CYD
    pairing") sends its stored UID back on every `hello` -- at cold boot and
    again whenever a new Wi-Fi client connects (e.g. it moved from USB to a
    power bank and only later joined Wi-Fi). This lets it keep representing
    the same astronaut with no fresh NFC tap, the same way a personal watch
    wouldn't ask you to re-authenticate every time you look at it.

    Deliberately never ends or replaces a *different* astronaut's
    already-active session -- a passive reconnect must not be able to log
    someone else out or steal the (shared, one-at-a-time) CYD out from
    under whoever's actually using it right now.

    But a reboot/replug (the CYD's own `curUid` always resets to empty at
    boot) never told the backend the session ended -- nothing clears
    `active_sessions` on a mere bridge disconnect, only an explicit
    end_session does -- so *this exact astronaut's* own entry is often
    still sitting there as a stale leftover, not a real conflict. Refusing
    to touch it in that case (the original, too-strict rule) left the
    device stuck at Idle forever even though it was correctly paired,
    because the backend thought someone was "already using it" when that
    someone was this same device reconnecting. Re-sending the session in
    that case isn't stealing anything -- it's the one legitimate case this
    function exists for."""
    with db.write_conn() as conn:
        tag = _get_tag(conn, uid)
        if not tag or tag["astronaut_id"] is None or tag["type"] not in ("astronaut", "surgeon"):
            return
        astronaut_id = tag["astronaut_id"]
        if any(other_id != astronaut_id for other_id in active_sessions):
            return  # a genuinely different session is active -- don't disturb it
        astronaut = _get_astronaut(conn, astronaut_id)
        if astronaut:
            _start_session(conn, astronaut, uid, send_fn, emit_fn)


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


def note_cyd_contact(astronaut_id):
    """The CYD sent something from its touchscreen for this astronaut (mood,
    symptoms, a test...), so its own idle timer was just reset."""
    if astronaut_id in active_sessions:
        active_sessions[astronaut_id]["cyd_contact"] = time.time()
        active_sessions[astronaut_id]["last_activity"] = time.time()


def seconds_since_cyd_contact(astronaut_id):
    """How long since the CYD's idle timer was last (known to be) reset for this
    astronaut's session, or None if they have no open session."""
    info = active_sessions.get(astronaut_id)
    return None if info is None else time.time() - info["cyd_contact"]


def _touch_session(astronaut_id):
    if astronaut_id in active_sessions:
        active_sessions[astronaut_id]["last_activity"] = time.time()


def _cyd_is(astronaut_id):
    """Only the astronaut on the CYD right now should see its workout/sleep screens."""
    return astronaut_id in active_sessions


def start_toggle(conn, astronaut_id, kind, key, label, send_fn, emit_fn):
    """Start a sleep or workout timer (a tag tap, or Astra: "I'm going to bed")."""
    # Workouts from the Exercises page ("ex:" keys) are timed in real time: the page shows a
    # live stopwatch and a 30-minute session should log 30 minutes. Everything else uses
    # the accelerated mission clock (TIME_SCALE), like the schedule.
    scale = 1 if str(key).startswith("ex:") else TIME_SCALE
    open_toggles[key] = {"astronaut_id": astronaut_id, "kind": kind, "started_at": time.time(), "started_iso": _now_iso(), "time_scale": scale}
    _touch_session(astronaut_id)
    if _cyd_is(astronaut_id):
        if kind == "exercise":
            send_fn(protocol.exercise("start", 0))
            send_fn(protocol.toast(f"Workout started: {label}"))
        else:
            send_fn(protocol.sleep("start", 0))
            send_fn(protocol.toast("Good night"))
    emit_fn("cyd_event", {"type": f"{kind}_start", "astronaut_id": astronaut_id})
    _request_analysis(astronaut_id, f"{kind}_start")


def stop_toggle(conn, key, send_fn, emit_fn):
    """Stop a running timer and log it. The duration is measured on the MISSION clock
    (x TIME_SCALE), the same clock as the schedule and reminders -- so a 5-minute demo
    nap logs 5 hours, not 0.1. Returns {"kind", "minutes"|"hours", "level"}."""
    info = open_toggles.pop(key)
    astronaut_id, kind = info["astronaut_id"], info["kind"]
    mission_s = (time.time() - info["started_at"]) * info.get("time_scale", TIME_SCALE)
    _touch_session(astronaut_id)
    out = {"kind": kind, "astronaut_id": astronaut_id}
    if kind == "exercise":
        minutes = max(1, round(mission_s / 60))
        conn.execute(
            "INSERT INTO activities (astronaut_id, kind, started_at, ended_at, data_json) VALUES (?, ?, ?, ?, ?)",
            (astronaut_id, "exercise", info["started_iso"], _now_iso(), json.dumps({"minutes": minutes, "tag": key})),
        )
        lvl = health_rules.evaluate("exercise", minutes)
        conn.execute("INSERT INTO readings (astronaut_id, ts, indicator, value_json, level, source) VALUES (?, ?, 'exercise', ?, ?, 'tag')",
                     (astronaut_id, _now_iso(), json.dumps(minutes), lvl))
        if _cyd_is(astronaut_id):
            send_fn(protocol.exercise("stop", minutes))
            send_fn(protocol.toast(f"Workout done: {minutes} min"))
        emit_fn("cyd_event", {"type": "exercise_stop", "astronaut_id": astronaut_id, "minutes": minutes})
        out.update(minutes=minutes, level=lvl)
    else:
        hours = round(mission_s / 3600, 1)
        conn.execute(
            "INSERT INTO activities (astronaut_id, kind, started_at, ended_at, data_json) VALUES (?, ?, ?, ?, ?)",
            (astronaut_id, "sleep", info["started_iso"], _now_iso(), json.dumps({"hours": hours})),
        )
        lvl = health_rules.evaluate("sleep", hours)
        conn.execute("INSERT INTO readings (astronaut_id, ts, indicator, value_json, level, source) VALUES (?, ?, 'sleep', ?, ?, 'tag')",
                     (astronaut_id, _now_iso(), json.dumps(hours), lvl))
        if _cyd_is(astronaut_id):
            send_fn(protocol.sleep("stop", hours))
            send_fn(protocol.toast(f"Slept {hours} h"))
        emit_fn("cyd_event", {"type": "sleep_stop", "astronaut_id": astronaut_id, "hours": hours})
        out.update(hours=hours, level=lvl)
    _request_analysis(astronaut_id, f"{kind}_stop")
    return out


def running_toggle(astronaut_id, kind):
    """The key of this astronaut's running sleep/workout timer (tag- or voice-started)."""
    for key, info in open_toggles.items():
        if info["astronaut_id"] == astronaut_id and info["kind"] == kind:
            return key
    return None


def _handle_object_tag(conn, tag, send_fn, emit_fn):
    kind = tag["type"]
    extra = json.loads(tag["data_json"] or "{}")

    if tag["uid"] in open_toggles:
        stop_toggle(conn, tag["uid"], send_fn, emit_fn)
        return

    if kind in ("exercise", "sleep"):
        astronaut_id = _current_session_astronaut_id()
        if astronaut_id is None:
            send_fn(protocol.toast("Tap your card first", "YELLOW"))
            return
        start_toggle(conn, astronaut_id, kind, tag["uid"], tag["label"], send_fn, emit_fn)
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
        kcal = extra.get("kcal", 0)
        send_fn(protocol.toast(f"Meal logged: {kcal} kcal"))
        emit_fn("cyd_event", {"type": "meal", "astronaut_id": astronaut_id, "label": tag["label"], **extra})
    elif kind == "medicine":
        conn.execute("INSERT INTO activities (astronaut_id, kind, started_at, ended_at, data_json) VALUES (?, ?, ?, ?, ?)",
                     (astronaut_id, "medicine", _now_iso(), _now_iso(), json.dumps({"tag": tag["uid"], "label": tag["label"]})))
        send_fn(protocol.toast(f"Logged: {tag['label']}"))
        emit_fn("cyd_event", {"type": "medicine", "astronaut_id": astronaut_id, "label": tag["label"]})
        _request_analysis(astronaut_id, "medicine")
    elif kind == "bp_guide":
        send_fn(protocol.toast("Check the blood pressure guide on the laptop"))
        emit_fn("cyd_event", {"type": "open_guide", "astronaut_id": astronaut_id, "indicator": "blood_pressure"})


def _request_analysis(astronaut_id, trigger):
    """Queue an AI health analysis (backend/logic/analysis.py). Imported lazily: analysis
    imports this module. Queued, not run here -- we're inside handle_scan's write_conn,
    and the worker only runs it a few seconds later, after this transaction commits."""
    from backend.logic import analysis
    analysis.request(astronaut_id, trigger)


def _remember_unknown_tag(uid):
    now = _now_iso()
    if uid in unknown_tag_backlog:
        entry = unknown_tag_backlog.pop(uid)
        entry["last_seen"] = now
        entry["count"] += 1
    else:
        entry = {"uid": uid, "first_seen": now, "last_seen": now, "count": 1}
        if len(unknown_tag_backlog) >= UNKNOWN_BACKLOG_MAX:
            unknown_tag_backlog.pop(next(iter(unknown_tag_backlog)))  # drop oldest
    unknown_tag_backlog[uid] = entry


def unknown_tags():
    """Most-recently-tapped first, for the admin page's backlog list."""
    return list(reversed(list(unknown_tag_backlog.values())))


def clear_unknown_tag(uid):
    unknown_tag_backlog.pop(uid, None)


def handle_scan(uid, send_fn, emit_fn, web_only=None):
    """The single entry point for a 'scan' message, whether it came from a
    real CYD/Pico tap or the Simulator panel.

    `web_only` (docs/CLAUDE.md "web-only login"): sign into just this
    browser without touching the physical CYD's own session. Left as
    `None` (the default for every real hardware tap -- bare JSON with no
    such field), it falls back to `current_scan_mode`, the login page's
    current global choice, so a real Pico tap right after picking "This
    browser only" is covered exactly like a Simulator tap already was. An
    explicit `True`/`False` (the Simulator's own per-call value) still
    overrides that fallback. The "scan" broadcast below always fires
    either way, since that's what the web login listens for; web_only
    just skips the part that would start/end a physical CYD session."""
    if web_only is None:
        web_only = current_scan_mode == "web"
    with db.write_conn() as conn:
        tag = _get_tag(conn, uid)
        if tag is None:
            _remember_unknown_tag(uid)
            send_fn(protocol.unknown_tag(uid))
            emit_fn("unknown_tag", {"uid": uid})
            return
        last_scan.update({"uid": uid, "at": time.time()})
        emit_fn("scan", {"uid": uid, "type": tag["type"], "label": tag["label"]})
        if web_only:
            return
        # A "surgeon" tag predates real login (docs/CLAUDE.md's "Login /
        # access control") -- it used to be a timed PIN-replacement unlock,
        # not an account. seed.py still registers the Flight Surgeon's own
        # card this way (astronaut_id set, same as any crew card), so route
        # it through the real session path exactly like "astronaut" --
        # otherwise her card can start a *web* login (nfc_login does its
        # own tag lookup, unaffected by this) but was never able to start a
        # *CYD* session at all, silently: _handle_surgeon_tag below sends
        # nothing to the board. The legacy astronaut_id-less unlock-only
        # behavior (tests/conftest.py's seed_minimal(), no real account
        # behind it) still falls through to it.
        if tag["type"] == "astronaut" or (tag["type"] == "surgeon" and tag["astronaut_id"] is not None):
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
