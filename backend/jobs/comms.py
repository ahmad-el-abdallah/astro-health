"""Earth-to-crew communication delay: a message sent to or from the flight
surgeon waits for the active mission profile's one-way comms delay (sped up
by TIME_SCALE) before it's marked delivered (see docs/build-prompt.md
sections 5 and 9).

A background sweep (see app.py) calls deliver_due_messages() every few
seconds to flip any message whose deliver_at has passed.
"""
from datetime import datetime, timedelta, timezone

from backend import db
from backend.config import missions as load_missions, TIME_SCALE


def current_profile():
    with db.write_conn() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = 'mission_profile'").fetchone()
    profile_id = row["value"] if row else load_missions()["active_profile"]
    return profile_id, load_missions()["profiles"][profile_id]


def delay_seconds():
    _, profile = current_profile()
    delay = profile.get("comms_delay_s", 0)
    if not isinstance(delay, (int, float)):
        delay = 0
    return max(0.0, delay / TIME_SCALE)


def queue_report(astronaut_id, body, from_role="crew"):
    """A report heading to Earth (crew -> surgeon): arrives after the delay."""
    sent_at = datetime.now(timezone.utc)
    deliver_at = sent_at + timedelta(seconds=delay_seconds())
    with db.write_conn() as conn:
        conn.execute(
            "INSERT INTO messages (from_role, astronaut_id, body, sent_at, deliver_at, read) VALUES (?, ?, ?, ?, ?, 0)",
            (from_role, astronaut_id, body, sent_at.isoformat(), deliver_at.isoformat()),
        )
    return deliver_at


def queue_reply(astronaut_id, body):
    """A reply from the surgeon heading back to the crew: also delayed."""
    return queue_report(astronaut_id, body, from_role="surgeon")


def deliver_due_messages(emit_fn):
    now = datetime.now(timezone.utc).isoformat()
    with db.write_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM messages WHERE read = 0 AND deliver_at <= ?", (now,)
        ).fetchall()
        for row in rows:
            conn.execute("UPDATE messages SET read = 1 WHERE id = ?", (row["id"],))
    for row in rows:
        emit_fn("message_delivered", dict(row))
    return rows
