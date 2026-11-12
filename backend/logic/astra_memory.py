"""What Astra remembers about each astronaut, and what she should ask about again later.

A memory is a short note: something the astronaut told her in the chat ("my knee has hurt
since Tuesday"), or something the app noticed (a low mood, pain of 6/10 or more, logged
symptoms). A note can carry a follow-up time; when it's due, Astra checks in ("Earlier you
said your back hurt, 6/10. How is it now?").

Follow-up delays are in MISSION hours, so they run on the same sped-up clock as the
schedule and reminders (3 mission hours = 3 real minutes at TIME_SCALE 60).
"""
from datetime import datetime, timedelta, timezone

from backend import db
from backend.config import TIME_SCALE

MAX_TEXT = 200
MAX_LIST = 30
AUTO_FOLLOW_UP_HOURS = 3
_announced = set()  # follow-up ids already pushed to browsers this server run


def _now():
    return datetime.now(timezone.utc)


def follow_up_at(hours, now=None):
    """Real UTC time `hours` mission hours from now."""
    return (now or _now()) + timedelta(seconds=float(hours) * 3600 / TIME_SCALE)


def add(conn, astro_id, text, follow_up_hours=None, source="chat"):
    text = " ".join(str(text or "").split())[:MAX_TEXT]
    if not text:
        return None
    due = follow_up_at(follow_up_hours).isoformat() if follow_up_hours else None
    cur = conn.execute(
        "INSERT INTO astra_memory (astronaut_id, created_at, text, follow_up_at, followed_up, source) VALUES (?, ?, ?, ?, 0, ?)",
        (astro_id, _now().isoformat(), text, due, source),
    )
    return cur.lastrowid


def _public(row):
    return {k: row[k] for k in ("id", "created_at", "text", "follow_up_at", "source")} | {"followed_up": bool(row["followed_up"])}


def list_for(conn, astro_id, limit=MAX_LIST):
    rows = conn.execute(
        "SELECT * FROM astra_memory WHERE astronaut_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
        (astro_id, limit),
    ).fetchall()
    return [_public(r) for r in rows]


def due_for(conn, astro_id, now=None):
    now = (now or _now()).isoformat()
    rows = conn.execute(
        "SELECT * FROM astra_memory WHERE astronaut_id = ? AND follow_up_at IS NOT NULL AND followed_up = 0 "
        "AND follow_up_at <= ? ORDER BY follow_up_at",
        (astro_id, now),
    ).fetchall()
    return [_public(r) for r in rows]


def delete(conn, astro_id, mem_id):
    return conn.execute("DELETE FROM astra_memory WHERE id = ? AND astronaut_id = ?", (mem_id, astro_id)).rowcount > 0


def mark_followed_up(conn, astro_id, mem_id):
    return conn.execute(
        "UPDATE astra_memory SET followed_up = 1 WHERE id = ? AND astronaut_id = ?", (mem_id, astro_id)
    ).rowcount > 0


def context_lines(conn, astro_id, limit=15):
    """For the AI: '[#12] knee has hurt since Tuesday (2026-11-10)'."""
    out = []
    for m in list_for(conn, astro_id, limit):
        when = m["created_at"][:10]
        due = " -- ask about it again" if m["follow_up_at"] and not m["followed_up"] else ""
        out.append(f"[#{m['id']}] {m['text']} ({when}){due}")
    return out


def emit_due(emit_fn, now=None):
    """Background tick: push each newly due follow-up to the browsers once per server run.
    A browser opened later still finds it (GET .../memory?due=1) until it's marked done."""
    now_iso = (now or _now()).isoformat()
    with db.write_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM astra_memory WHERE follow_up_at IS NOT NULL AND followed_up = 0 AND follow_up_at <= ?",
            (now_iso,),
        ).fetchall()
    fresh = [r for r in rows if r["id"] not in _announced]
    for r in fresh:
        _announced.add(r["id"])
        emit_fn("astra_followup", {"astronaut_id": r["astronaut_id"], **_public(r)})
    return fresh


# ---- notes the app adds by itself ----
def note_mood(conn, astro_id, mood):
    if mood in ("rough", "low"):
        add(conn, astro_id, f"Felt {mood} (mood check-in)", AUTO_FOLLOW_UP_HOURS, "mood")


def note_pain(conn, astro_id, region_label, intensity):
    if isinstance(intensity, int) and intensity >= 6:
        add(conn, astro_id, f"{region_label} pain {intensity}/10", AUTO_FOLLOW_UP_HOURS, "pain")


def note_symptoms(conn, astro_id, labels):
    if labels:
        add(conn, astro_id, "Reported " + ", ".join(labels), AUTO_FOLLOW_UP_HOURS, "symptoms")
