"""The daily routine (config/routine.json) on the mission clock: fires its
reminders, and works out each task's status for the Schedule page and Doctor AI.

The mission clock is real time elapsed since the app started, compressed by
TIME_SCALE (docs/build-prompt.md sections 5 and 9.9): at TIME_SCALE=60 one real
minute is one mission hour, so a 24h day plays out in 24 real minutes. Each
reminder fires once per mission day it crosses.

A task counts as done when this astronaut actually did the matching thing in
its window (an assessment for "vitals", a mood/sleep/exercise reading or
activity for the others) -- from the database, not from the browser having
seen an event, so every open page and a reload all agree.
"""
import time
from datetime import datetime, timezone

from backend.hardware import protocol
from backend.config import routine as load_routine, TIME_SCALE

SECONDS_PER_DAY = 86400
# Doing a task up to one mission hour before its slot still counts for it.
EARLY_S = 3600
# A task still not done this long (mission time) after its slot is "missed".
MISSED_AFTER_S = 3 * 3600

_last_fired_cycle = {}
# Overwritten by app.py with the moment its background loop starts.
clock_started_at = time.time()

# kind -> queries returning the first matching timestamp in [lo, hi).
_DONE_QUERIES = {
    "vitals": ["SELECT ts AS t FROM assessments WHERE astronaut_id = ? AND ts >= ? AND ts < ? ORDER BY ts LIMIT 1"],
    "mood": ["SELECT ts AS t FROM readings WHERE astronaut_id = ? AND indicator = 'mood' AND ts >= ? AND ts < ? ORDER BY ts LIMIT 1"],
    "exercise": [
        "SELECT ts AS t FROM readings WHERE astronaut_id = ? AND indicator = 'exercise' AND ts >= ? AND ts < ? ORDER BY ts LIMIT 1",
        "SELECT started_at AS t FROM activities WHERE astronaut_id = ? AND kind = 'exercise' AND started_at >= ? AND started_at < ? ORDER BY started_at LIMIT 1",
    ],
    "sleep": [
        "SELECT ts AS t FROM readings WHERE astronaut_id = ? AND indicator = 'sleep' AND ts >= ? AND ts < ? ORDER BY ts LIMIT 1",
        "SELECT started_at AS t FROM activities WHERE astronaut_id = ? AND kind = 'sleep' AND started_at >= ? AND started_at < ? ORDER BY started_at LIMIT 1",
    ],
}


def _hhmm_to_seconds(hhmm):
    h, m = map(int, hhmm.split(":"))
    return h * 3600 + m * 60


def mission_clock(now=None):
    """(mission day index starting at 0, seconds into that mission day)."""
    now = time.time() if now is None else now
    elapsed = max(0.0, (now - clock_started_at) * TIME_SCALE)
    return int(elapsed // SECONDS_PER_DAY), elapsed % SECONDS_PER_DAY


def _real(cycle, day_seconds):
    return clock_started_at + (cycle * SECONDS_PER_DAY + day_seconds) / TIME_SCALE


def _iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat()


def to_mission_hhmm(iso_ts):
    """A real UTC ISO timestamp as mission-clock HH:MM."""
    epoch = datetime.fromisoformat(iso_ts).timestamp()
    # Round to the second first: float error can turn 07:10:00 into 07:09:59.99.
    s = round((epoch - clock_started_at) * TIME_SCALE) % SECONDS_PER_DAY
    return f"{int(s // 3600):02d}:{int(s % 3600 // 60):02d}"


def _first_done(conn, astronaut_id, kind, lo, hi):
    hits = []
    for q in _DONE_QUERIES.get(kind, []):
        row = conn.execute(q, (astronaut_id, _iso(lo), _iso(hi))).fetchone()
        if row:
            hits.append(row["t"])
    return min(hits) if hits else None


def _sleep_started_in(astronaut_id, lo, hi):
    # Sleep tracked with the sleep-station tag has no row until it ends; an open
    # toggle that started in the window counts as "started sleep tracking".
    from backend.logic import sessions
    for info in sessions.open_toggles.values():
        if info["astronaut_id"] == astronaut_id and info["kind"] == "sleep" and lo <= info["started_at"] < hi:
            return info["started_iso"]
    return None


def day_plan(conn, astronaut_id, now=None):
    """Today's routine for one astronaut: every entry plus its status
    ("done" / "due" / "missed" / "upcoming") and, when done, when (mission time)."""
    now = time.time() if now is None else now
    cycle, day_s = mission_clock(now)
    schedule = sorted(load_routine()["schedule"], key=lambda e: _hhmm_to_seconds(e["time"]))
    out = []
    for entry in schedule:
        target = _hhmm_to_seconds(entry["time"])
        same_kind = [_hhmm_to_seconds(e["time"]) for e in schedule if e["kind"] == entry["kind"]]
        prev = max((t for t in same_kind if t < target), default=None)
        nxt = min((t for t in same_kind if t > target), default=None)
        start = max(0, target - EARLY_S, prev if prev is not None else 0)
        end = nxt if nxt is not None else SECONDS_PER_DAY

        done_ts = None
        if day_s >= start:
            lo, hi = _real(cycle, start), min(_real(cycle, end), now + 1)
            done_ts = _first_done(conn, astronaut_id, entry["kind"], lo, hi)
            if done_ts is None and entry["kind"] == "sleep":
                done_ts = _sleep_started_in(astronaut_id, lo, hi)

        if done_ts:
            status = "done"
        elif day_s < target:
            status = "upcoming"
        elif (nxt is not None and day_s >= nxt) or day_s - target > MISSED_AFTER_S:
            status = "missed"
        else:
            status = "due"
        out.append({
            "time": entry["time"], "text": entry["text"], "kind": entry["kind"],
            "seconds": target, "status": status,
            "done_at": to_mission_hhmm(done_ts) if done_ts else None,
        })
    return {
        "day": cycle + 1,
        "day_seconds": day_s,
        "time_scale": TIME_SCALE,
        "entries": out,
    }


def check_and_fire(start_time, send_fn, emit_fn):
    elapsed = (time.time() - start_time) * TIME_SCALE
    day_seconds = elapsed % SECONDS_PER_DAY
    cycle = int(elapsed // SECONDS_PER_DAY)
    for entry in load_routine()["schedule"]:
        target = _hhmm_to_seconds(entry["time"])
        if day_seconds >= target and _last_fired_cycle.get(entry["time"]) != cycle:
            _last_fired_cycle[entry["time"]] = cycle
            send_fn(protocol.reminder(entry["text"]))
            emit_fn("reminder", {"text": entry["text"], "kind": entry["kind"], "time": entry["time"]})
