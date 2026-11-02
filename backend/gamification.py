"""Points are awarded where the action happens (sessions.py, routes.py),
using config/gamification.json's point values. This module only computes
badge eligibility and the leaderboard (see docs/build-prompt.md section 9.8).
"""
import json
from datetime import datetime, timedelta, timezone

from backend import db
from backend.config import gamification as load_gamification, health_rules as load_health_rules


def _dates_with_min(conn, astronaut_id, indicator, min_value):
    rows = conn.execute(
        "SELECT ts, value_json FROM readings WHERE astronaut_id = ? AND indicator = ? ORDER BY ts",
        (astronaut_id, indicator),
    ).fetchall()
    dates = set()
    for r in rows:
        value = json.loads(r["value_json"])
        if isinstance(value, (int, float)) and value >= min_value:
            dates.add(r["ts"][:10])
    return dates


def _exercise_day_streak(conn, astronaut_id):
    rules = load_health_rules()["indicators"]["exercise"]
    good_days = _dates_with_min(conn, astronaut_id, "exercise", rules["green_min"])
    today = datetime.now(timezone.utc).date()
    streak = 0
    d = today
    while d.isoformat() in good_days:
        streak += 1
        d -= timedelta(days=1)
    return streak


def _good_sleep_nights(conn, astronaut_id):
    rules = load_health_rules()["indicators"]["sleep"]
    return len(_dates_with_min(conn, astronaut_id, "sleep", rules["green_min"]))


def _breathing_sessions(conn, astronaut_id):
    return conn.execute(
        "SELECT COUNT(*) AS c FROM activities WHERE astronaut_id = ? AND kind = 'breathing'", (astronaut_id,)
    ).fetchone()["c"]


def _complete_check_days(conn, astronaut_id):
    rows = conn.execute("SELECT DISTINCT substr(ts, 1, 10) AS d FROM assessments WHERE astronaut_id = ?",
                         (astronaut_id,)).fetchall()
    return len(rows)


def metrics_for(astronaut_id):
    conn = db.get_conn()
    try:
        return {
            "exercise_days_streak": _exercise_day_streak(conn, astronaut_id),
            "good_sleep_nights": _good_sleep_nights(conn, astronaut_id),
            "breathing_sessions": _breathing_sessions(conn, astronaut_id),
            "complete_check_days": _complete_check_days(conn, astronaut_id),
        }
    finally:
        conn.close()


def _rule_met(rule_text, metrics):
    """Rules in config/gamification.json are always "<metric_name> >= <number>" --
    parsed by hand rather than eval()'d, since a badge rule is still config, not trusted code."""
    metric_name, _, threshold = rule_text.partition(">=")
    metric_name, threshold = metric_name.strip(), threshold.strip()
    return metrics.get(metric_name, 0) >= float(threshold)


def recompute_badges(astronaut_id, emit_fn=None):
    """Checks every badge rule; awards (and emits 'badge' for) any newly earned one."""
    gam = load_gamification()
    metrics = metrics_for(astronaut_id)
    newly_earned = []
    with db.write_conn() as conn:
        already = {r["badge_id"] for r in conn.execute(
            "SELECT badge_id FROM badges WHERE astronaut_id = ?", (astronaut_id,))}
        for badge_id, cfg in gam["badges"].items():
            if badge_id in already:
                continue
            if _rule_met(cfg["rule"], metrics):
                conn.execute("INSERT INTO badges (astronaut_id, badge_id, earned_at) VALUES (?, ?, ?)",
                             (astronaut_id, badge_id, datetime.now(timezone.utc).isoformat()))
                newly_earned.append({"badge_id": badge_id, **cfg})
    if emit_fn:
        for b in newly_earned:
            emit_fn("badge", {"astronaut_id": astronaut_id, **b})
    return newly_earned


def leaderboard_rows():
    conn = db.get_conn()
    try:
        crew = conn.execute("SELECT id, name, color FROM astronauts WHERE role != 'Flight surgeon' ORDER BY id").fetchall()
        out = []
        for a in crew:
            pts = conn.execute("SELECT COALESCE(SUM(amount),0) AS t FROM points WHERE astronaut_id = ?", (a["id"],)).fetchone()["t"]
            out.append({"astronaut_id": a["id"], "name": a["name"], "color": a["color"], "points": pts})
        return sorted(out, key=lambda r: r["points"], reverse=True)
    finally:
        conn.close()
