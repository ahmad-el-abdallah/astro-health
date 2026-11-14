"""The ISS daily exercise plan (config/exercises.json) against what an astronaut actually
logged. Shared by the Exercises page (routes.py) and Astra's chat context (analysis.py),
so the page and Astra always agree on what's done and what's left.

Workouts use the same timer as the NFC tags and Astra. Timer keys:
  "ex:<astro>:<exercise>"  started from the Exercises page, or by Astra for a named exercise
  an NFC tag uid           matched to an exercise through the tag's label ("treadmill" -> t2)
  "web:<astro>:exercise"   a voice/Astra workout with no exercise named -> "Workout"
"""
import json
import time
from datetime import datetime, timedelta, timezone

from backend.config import TIME_SCALE, exercises as load_exercises
from backend.logic import sessions

# When Astra proposes {"type": "start_workout", "exercise": "t2"}, the page then calls the
# generic /activity start route. This remembers which exercise she named, for a few
# minutes, so that start is logged as the treadmill instead of a plain "Workout".
PENDING_S = 300
_pending = {}  # astro_id -> (exercise id, time.time())


def remember_choice(astro_id, ex_id):
    if any(e["id"] == ex_id for e in load_exercises()["exercises"]):
        _pending[astro_id] = (ex_id, time.time())


def take_choice(astro_id):
    ex_id, at = _pending.pop(astro_id, (None, 0))
    return ex_id if ex_id and time.time() - at <= PENDING_S else None


def find(ex_id, cfg=None):
    cfg = cfg or load_exercises()
    return next((e for e in cfg["exercises"] if e["id"] == ex_id), None)


def exercise_of(conn, key, cfg):
    key = key or ""
    if key.startswith("ex:"):
        ex_id = key.rsplit(":", 1)[-1]
        return ex_id if find(ex_id, cfg) else None
    tag = conn.execute("SELECT label FROM tags WHERE uid = ?", (key,)).fetchone()
    label = (tag["label"] if tag else "").lower()
    for e in cfg["exercises"]:
        if any(w in label for w in e.get("match", [])):
            return e["id"]
    return None


def running(conn, astro_id, cfg):
    key = sessions.running_toggle(astro_id, "exercise")
    if not key:
        return None
    info = sessions.open_toggles.get(key, {})
    ex_id = exercise_of(conn, key, cfg)
    ex = find(ex_id, cfg)
    return {"id": ex_id, "name": ex["name"] if ex else "Workout", "started_at": info.get("started_at"), "time_scale": info.get("time_scale", TIME_SCALE)}


def overview(conn, astro_id):
    cfg = load_exercises()
    names = {e["id"]: e["name"] for e in cfg["exercises"]}
    today = datetime.now().astimezone().date()
    week_start = today - timedelta(days=6)
    since = datetime.combine(week_start, datetime.min.time()).astimezone().astimezone(timezone.utc).isoformat()
    acts = conn.execute(
        "SELECT started_at, ended_at, data_json FROM activities WHERE astronaut_id = ? AND kind = 'exercise' AND started_at >= ? ORDER BY started_at DESC",
        (astro_id, since),
    ).fetchall()
    by_day = {week_start + timedelta(days=i): 0 for i in range(7)}
    done_today, history = {e["id"]: 0 for e in cfg["exercises"]}, []
    for a in acts:
        data = json.loads(a["data_json"] or "{}")
        minutes = int(data.get("minutes") or 0)
        ex_id = exercise_of(conn, data.get("tag"), cfg)
        day = datetime.fromisoformat(a["ended_at"] or a["started_at"]).astimezone().date()
        if day in by_day:
            by_day[day] += minutes
        if day == today and ex_id in done_today:
            done_today[ex_id] += minutes
        if len(history) < 8:
            history.append({"exercise": ex_id, "name": names.get(ex_id, "Workout"), "minutes": minutes,
                            "ended_at": a["ended_at"] or a["started_at"]})
    return {
        "goal_min": cfg["daily_goal_min"],
        "today_min": by_day[today],
        "exercises": [{**e, "done_min": done_today[e["id"]]} for e in cfg["exercises"]],
        "week": [{"date": d.isoformat(), "label": d.strftime("%a"), "minutes": m, "today": d == today} for d, m in by_day.items()],
        "history": history,
        "running": running(conn, astro_id, cfg),
        "sources": cfg.get("sources", []),
    }


def chat_lines(conn, astro_id):
    """Compact lines for Astra's context: today's plan, progress and what's running."""
    o = overview(conn, astro_id)
    parts = [f"{e['name']} [{e['id']}] {e['done_min']}/{e['target_min']} min" for e in o["exercises"]]
    lines = [
        f"Exercise today: {o['today_min']} of {o['goal_min']} min goal. ISS plan: " + "; ".join(parts) + ".",
        "Exercise minutes last 7 days: " + ", ".join(f"{d['label']} {d['minutes']}" for d in o["week"]) + ".",
    ]
    if o["running"]:
        lines.append(f"Exercise running now: {o['running']['name']}.")
    return lines


def reset_today(conn, astro_id, ex_id):
    """Clear today's logged sessions of one exercise (the card's Reset button). Returns how
    many sessions were removed. Other days and other exercises are untouched."""
    cfg = load_exercises()
    today = datetime.now().astimezone().date()
    since = datetime.combine(today, datetime.min.time()).astimezone().astimezone(timezone.utc).isoformat()
    rows = conn.execute(
        "SELECT id, started_at, ended_at, data_json FROM activities WHERE astronaut_id = ? AND kind = 'exercise' AND started_at >= ?",
        (astro_id, since),
    ).fetchall()
    gone = [r["id"] for r in rows
            if exercise_of(conn, json.loads(r["data_json"] or "{}").get("tag"), cfg) == ex_id
            and datetime.fromisoformat(r["ended_at"] or r["started_at"]).astimezone().date() == today]
    for i in gone:
        conn.execute("DELETE FROM activities WHERE id = ?", (i,))
    return len(gone)
