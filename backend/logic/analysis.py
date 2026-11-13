"""Health analysis: the AI decides what's going on with an astronaut; the threshold rules
are only the fallback (docs/CLAUDE.md, "AI health analyst").

Flow:
  any new data (assess, CYD check-in, symptom, tag tap...) -> request(astro_id, trigger)
  -> the worker thread waits DEBOUNCE_S so a burst of changes becomes one call
  -> run_now(): build_context() -> analyst.analyze() (one AI call, outside the DB lock)
       or, if the AI can't be used, rules_result()
  -> apply(): latest reading levels follow the verdict, an `analyses` row is saved,
     the surgeon is alerted on a transition into RED (or when the AI asks), the CYD
     gets status/led, and every browser gets an "analysis" Socket.IO event.
"""
import json
import threading
import time
from datetime import datetime, timedelta, timezone

from backend import db
from backend.config import ai_analyst as load_analyst_cfg, content as load_content, health_rules as load_rules
from backend.config import TIME_SCALE
from backend.hardware import protocol
from backend.jobs import comms, scheduler
from backend.logic import exercise, health_rules, sessions
from backend.services import analyst

DEBOUNCE_S = 5          # wait for a burst of changes to settle
MIN_INTERVAL_S = 20     # never analyze the same astronaut more often than this (free-tier tokens)
REALERT_AFTER_S = 6 * 3600
LEVEL_RANK = {"GRAY": -1, "GREEN": 0, "YELLOW": 1, "RED": 2}

_send_fn = lambda line: None  # noqa: E731 -- replaced by configure()
_emit_fn = lambda event, data: None  # noqa: E731

_cv = threading.Condition()
_pending = {}       # astro_id -> {"due": epoch, "trigger": str}
_busy = set()
_last_run = {}
_run_locks = {}
_worker_started = False


def configure(send_fn, emit_fn):
    """Called once by routes.create_routes() with the CYD bridge + Socket.IO emit."""
    global _send_fn, _emit_fn
    _send_fn, _emit_fn = send_fn, emit_fn


def reset():
    """Tests only: forget queued work and timing."""
    with _cv:
        _pending.clear()
        _busy.clear()
        _last_run.clear()


# ---------------------------------------------------------------- scheduling

def request(astro_id, trigger, delay=None):
    """Ask for an analysis soon. Cheap and non-blocking -- safe to call from anywhere,
    including inside another write_conn (the work happens later on the worker thread)."""
    if astro_id is None:
        return
    now = time.time()
    due = max(now + (DEBOUNCE_S if delay is None else delay), _last_run.get(astro_id, 0) + MIN_INTERVAL_S)
    with _cv:
        cur = _pending.get(astro_id)
        if cur:
            cur["due"] = max(cur["due"], due) if delay is None else min(cur["due"], due)
            if trigger == "assess":
                cur["trigger"] = "assess"
        else:
            _pending[astro_id] = {"due": due, "trigger": trigger}
        _cv.notify_all()
    _emit_fn("analysis_pending", {"astronaut_id": astro_id})


def _worker():
    while True:
        with _cv:
            while True:
                if _pending:
                    astro_id, info = min(_pending.items(), key=lambda kv: kv[1]["due"])
                    wait = info["due"] - time.time()
                    if wait <= 0:
                        del _pending[astro_id]
                        _busy.add(astro_id)
                        break
                    _cv.wait(min(wait, 5))
                else:
                    _cv.wait(5)
        try:
            run_now(astro_id, info["trigger"])
        except Exception as exc:  # the worker must never die mid-demo
            _emit_fn("serial_log", {"direction": "in", "line": {"type": "log", "msg": f"analysis error: {exc}"}})
        finally:
            with _cv:
                _busy.discard(astro_id)
                _cv.notify_all()


def start_worker():
    global _worker_started
    with _cv:
        if _worker_started:
            return
        _worker_started = True
    threading.Thread(target=_worker, daemon=True, name="analysis-worker").start()


def wait_idle(timeout=10.0):
    """Tests: block until nothing is queued or running (or timeout)."""
    end = time.time() + timeout
    with _cv:
        while (_pending or _busy) and time.time() < end:
            _cv.wait(0.05)
        return not (_pending or _busy)


# ---------------------------------------------------------------- context

def _fmt_value(indicator, v):
    if indicator == "blood_pressure" and isinstance(v, dict):
        return f"{v.get('systolic')}/{v.get('diastolic')}"
    if indicator == "reaction_time" and isinstance(v, dict):
        return f"avg {v.get('avg_ms')} ms, {v.get('lapses', 0)} lapses"
    if indicator == "sleep" and isinstance(v, dict):
        return f"{v.get('hours')} h"
    if indicator == "mood" and isinstance(v, dict):
        return f"{v.get('score')}/5 ({v.get('mood')})" + (f', note: "{v["note"][:60]}"' if v.get("note") else "")
    return str(v)


def _number(indicator, v):
    """One comparable number per reading, for the 7-day stats (None if not numeric)."""
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    if isinstance(v, dict):
        key = {"blood_pressure": "systolic", "reaction_time": "avg_ms", "sleep": "hours", "mood": "score"}.get(indicator)
        x = v.get(key) if key else None
        return float(x) if isinstance(x, (int, float)) and not isinstance(x, bool) else None
    return None


def _ranges_line(ind, cfg):
    if ind == "blood_pressure":
        return (f"blood_pressure: GREEN systolic {cfg['systolic_green'][0]}-{cfg['systolic_green'][1]} and diastolic "
                f"{cfg['diastolic_green'][0]}-{cfg['diastolic_green'][1]}; RED systolic >={cfg['systolic_red_high']} or "
                f"<={cfg['systolic_red_low']} or diastolic >={cfg['diastolic_red_high']}; YELLOW in between")
    if ind == "reaction_time":
        return (f"reaction_time: GREEN within {cfg['green_pct']}% of personal baseline, YELLOW up to {cfg['yellow_pct']}% "
                f"slower, RED slower than that or {cfg['red_lapses']}+ lapses")
    if "green_min" in cfg:
        return f"{ind}: GREEN >={cfg['green_min']}, YELLOW >={cfg['yellow_min']}, RED below ({cfg.get('unit', '')})"
    if "green" in cfg:
        yellow = ", ".join(f"{a}-{b}" for a, b in cfg.get("yellow", []))
        return f"{ind}: GREEN {cfg['green'][0]}-{cfg['green'][1]}, YELLOW {yellow}, RED outside ({cfg.get('unit', '')})"
    return None


def _open_toggle(astro_id):
    for info in sessions.open_toggles.values():
        if info["astronaut_id"] == astro_id:
            return info
    return None


def build_context(conn, astro_id, profile=None, for_chat=False):
    """Returns (text for the AI, indicator ids with a reading in the last 24 h, facts).
    Kept compact on purpose: Groq's free plan limits tokens per minute and per day.
    for_chat adds what only Astra's chat needs: the latest messages with the flight surgeon,
    today's alerts (seen or not) and what she remembers about this astronaut."""
    now = datetime.now(timezone.utc)
    rules = load_rules()["indicators"]
    content_cfg = load_content()
    astro = conn.execute("SELECT * FROM astronauts WHERE id = ?", (astro_id,)).fetchone()
    if profile is None:
        _, profile = comms.current_profile()

    since24 = (now - timedelta(hours=24)).isoformat()
    since7 = (now - timedelta(days=7)).isoformat()
    by_ind = {}
    for r in conn.execute(
        "SELECT indicator, ts, value_json, source FROM readings WHERE astronaut_id = ? AND ts >= ? ORDER BY ts DESC",
        (astro_id, since24),
    ):
        by_ind.setdefault(r["indicator"], []).append((r["ts"], json.loads(r["value_json"]), r["source"]))
    week = {}
    for r in conn.execute(
        "SELECT indicator, value_json FROM readings WHERE astronaut_id = ? AND ts >= ?", (astro_id, since7),
    ):
        n = _number(r["indicator"], json.loads(r["value_json"]))
        if n is not None:
            week.setdefault(r["indicator"], []).append(n)
    sym = conn.execute(
        "SELECT ts, items_json, level FROM symptoms WHERE astronaut_id = ? AND ts >= ? ORDER BY ts DESC LIMIT 1",
        (astro_id, since24),
    ).fetchone()
    discomfort = {}
    for r in conn.execute(
        "SELECT region, intensity FROM discomfort WHERE astronaut_id = ? AND ts >= ? ORDER BY ts DESC", (astro_id, since24),
    ):
        discomfort.setdefault(r["region"], r["intensity"])
    try:
        plan = scheduler.day_plan(conn, astro_id)
    except Exception:
        plan = None
    toggle = _open_toggle(astro_id)

    day, day_s = scheduler.mission_clock()
    lines = [
        f"Astronaut: {astro['name']} ({astro['role']}). Personal reaction-time baseline: {astro['baseline_reaction_ms']} ms.",
        f"Mission: {profile.get('label')}. Main hazards: "
        + (", ".join(content_cfg["hazards"][h]["label"] for h in profile.get("main_concerns", []) if h in content_cfg["hazards"]) or "none listed") + ".",
        f"Mission clock now: day {day + 1}, {int(day_s // 3600):02d}:{int(day_s % 3600 // 60):02d} "
        f"(times below are mission time; the clock runs {TIME_SCALE:g}x faster than real time).",
    ]
    if toggle:
        mission_min = round((time.time() - toggle["started_at"]) * TIME_SCALE / 60)
        what = "ASLEEP: sleep tracking is running" if toggle["kind"] == "sleep" else "EXERCISING: workout tracking is running"
        lines.append(f"Right now: {what} (started {scheduler.to_mission_hhmm(toggle['started_iso'])}, {mission_min} mission minutes ago).")
    else:
        lines.append("Right now: no sleep or workout tracking is running.")
    if for_chat:
        try:
            lines += exercise.chat_lines(conn, astro_id)
        except Exception as exc:  # never let the exercise summary break Astra
            print(f"[astra] exercise context skipped: {exc}", flush=True)
    lines.append(f"CYD session open: {'yes' if astro_id in sessions.active_sessions else 'no'}. "
                 f"Emergency: {'ACTIVE - ' + sessions.emergency.get('text', '') if sessions.emergency.get('active') else 'none'}.")

    if by_ind:
        lines.append("Readings in the last 24 h (newest first; mission time, value, source):")
        for ind, rows in by_ind.items():
            unit = rules.get(ind, {}).get("unit", "")
            vals = "; ".join(f"{scheduler.to_mission_hhmm(ts)} {_fmt_value(ind, v)} ({src})" for ts, v, src in rows[:3])
            lines.append(f"- {ind} [{unit}]: {vals}")
    else:
        lines.append("Readings in the last 24 h: none.")
    stats = [f"- {ind}: min {min(v):g}, avg {sum(v) / len(v):.1f}, max {max(v):g} ({len(v)} readings)"
             for ind, v in week.items() if len(v) >= 2]
    if stats:
        lines.append("Last 7 days:")
        lines += stats
    lines.append(f"Symptoms reported (last 24 h): {', '.join(json.loads(sym['items_json'])) or 'none'} "
                 f"at {scheduler.to_mission_hhmm(sym['ts'])}." if sym else "Symptoms reported (last 24 h): none.")
    lines.append("Discomfort the astronaut rated (0-10, by body region): "
                 + (", ".join(f"{k} {v}" for k, v in discomfort.items()) if discomfort else "none") + ".")
    if plan:
        lines.append("Today's routine: " + "; ".join(f"{e['time']} {e['text']} ({e['status']})" for e in plan["entries"]) + ".")
    if for_chat:
        lines += _chat_lines(conn, astro_id, now)
    ref = [line for line in (_ranges_line(ind, rules[ind]) for ind in by_ind if ind in rules) if line]
    if ref:
        lines.append("Reference ranges (general adult ranges, placeholder, guidance only):")
        lines += [f"- {line}" for line in ref]

    facts = {
        "astro": dict(astro), "latest": {ind: rows[0] for ind, rows in by_ind.items()},
        "symptoms": dict(sym) if sym else None, "toggle": toggle, "discomfort": discomfort,
    }
    return "\n".join(lines), list(by_ind.keys()), facts


def _chat_lines(conn, astro_id, now):
    from backend.logic import astra_memory  # small module, imported here to keep startup order simple
    out = []
    now_iso = now.isoformat()
    msgs = conn.execute(
        "SELECT from_role, body, sent_at FROM messages WHERE astronaut_id = ? AND deliver_at <= ? "
        "ORDER BY sent_at DESC LIMIT 3", (astro_id, now_iso),
    ).fetchall()
    if msgs:
        out.append("Latest messages with the flight surgeon (newest first):")
        for m in msgs:
            who = "Flight surgeon" if m["from_role"] == "surgeon" else "Astronaut"
            out.append(f"- {who} at {scheduler.to_mission_hhmm(m['sent_at'])}: {' '.join(m['body'].split())[:150]}")
    else:
        out.append("Messages with the flight surgeon: none yet.")
    since24 = (now - timedelta(hours=24)).isoformat()
    alerts = conn.execute(
        "SELECT ts, text, acknowledged FROM alerts WHERE astronaut_id = ? AND ts >= ? ORDER BY ts DESC LIMIT 3",
        (astro_id, since24),
    ).fetchall()
    if alerts:
        out.append("Alerts sent to the flight surgeon today: " + "; ".join(
            f"{scheduler.to_mission_hhmm(a['ts'])} \"{a['text'][:80]}\" ({'seen by the surgeon' if a['acknowledged'] else 'not seen yet'})"
            for a in alerts) + ".")
    memories = astra_memory.context_lines(conn, astro_id)
    out.append("What you remember about this astronaut (use the #number to forget one): "
               + ("; ".join(memories) if memories else "nothing yet") + ".")
    return out


# ---------------------------------------------------------------- the rules fallback

def _rules_level(ind, value, baseline):
    try:
        if ind == "blood_pressure":
            return health_rules.evaluate(ind, (value["systolic"], value["diastolic"]))
        if ind == "reaction_time":
            return health_rules.evaluate(ind, (value["avg_ms"], value.get("lapses", 0)), baseline_reaction_ms=baseline)
        n = _number(ind, value)
        return health_rules.evaluate(ind, n) if n is not None else None
    except (KeyError, TypeError, ValueError):
        return None


def rules_result(facts):
    """The pre-AI behaviour, used whenever the AI can't be: each latest reading judged
    by config/health_rules.json, overall = the worst one, plus a simple state."""
    rules = load_rules()["indicators"]
    levels = {}
    for ind, (_ts, value, _src) in facts["latest"].items():
        lvl = _rules_level(ind, value, facts["astro"].get("baseline_reaction_ms"))
        if lvl:
            levels[ind] = lvl
    all_levels = list(levels.values()) + ([facts["symptoms"]["level"]] if facts["symptoms"] else [])
    overall = health_rules.overall_level(all_levels) if all_levels else "GREEN"
    toggle = facts["toggle"]
    flagged = [ind for ind, lvl in levels.items() if lvl != "GREEN"]
    sick_signs = {"temperature", "oxygen_saturation"} & set(flagged) or (facts["symptoms"] and facts["symptoms"]["level"] != "GREEN")

    if sessions.emergency.get("active"):
        state = "emergency"
    elif overall == "RED":
        state = "unwell"  # a RED reading matters more than being asleep or mid-workout
    elif toggle and toggle["kind"] == "sleep":
        state = "sleeping"
    elif toggle and toggle["kind"] == "exercise":
        state = "exercising"
    elif not all_levels:
        state = "not_enough_data"
    elif overall == "YELLOW":
        state = "possibly_sick" if sick_signs else "needs_check"
    else:
        state = "well"

    label = lambda ind: rules.get(ind, {}).get("label", ind.replace("_", " "))  # noqa: E731
    if not all_levels:
        summary = "No readings in the last 24 hours yet."
    elif not flagged and not (facts["symptoms"] and facts["symptoms"]["level"] != "GREEN"):
        summary = "All recent readings are inside the normal ranges."
    else:
        summary = "Outside the normal range: " + ", ".join(label(i).lower() for i in flagged or ["symptoms"]) + "."
    reasons = [f"{label(i)} {_fmt_value(i, facts['latest'][i][1])} {rules.get(i, {}).get('unit', '')} is {levels[i]}".replace("  ", " ")
               for i in flagged][:4]
    body = load_content()["body_parts"]
    advice = []
    for ind in flagged:
        part = rules.get(ind, {}).get("body_part")
        tip = body.get(part, {}).get("what_to_do")
        if tip and tip not in advice:
            advice.append(tip)
    return {
        "state": state, "overall_level": overall, "indicator_levels": levels, "body_levels": {},
        "summary": summary, "reasons": reasons, "advice": advice[:3] or ["Keep up your daily checks."],
        "alert_surgeon": overall == "RED",
    }


# ---------------------------------------------------------------- run + apply

def _lock_for(astro_id):
    with _cv:
        return _run_locks.setdefault(astro_id, threading.Lock())


def run_now(astro_id, trigger="manual"):
    """Analyze one astronaut right away. Returns the public analysis dict (or None
    if the astronaut doesn't exist). The AI call happens outside the DB write lock."""
    with _lock_for(astro_id):
        _last_run[astro_id] = time.time()
        _, profile = comms.current_profile()
        with db.write_conn() as conn:
            if not conn.execute("SELECT 1 FROM astronauts WHERE id = ?", (astro_id,)).fetchone():
                return None
            text, indicator_ids, facts = build_context(conn, astro_id, profile)
        source, error, model = "ai", None, analyst.model_name()
        try:
            if not indicator_ids and not facts["symptoms"] and not facts["toggle"] and not facts["discomfort"]:
                raise analyst.AnalystError("no recent data to analyze")
            result = analyst.analyze(text, indicator_ids)
        except analyst.AnalystError as exc:
            source, error, model = "rules", str(exc), None
            result = rules_result(facts)
        return apply(astro_id, result, source, trigger, model=model, error=error, facts=facts)


def _alerting(level, alert_surgeon):
    return level == "RED" or bool(alert_surgeon)


def apply(astro_id, result, source, trigger, model=None, error=None, facts=None):
    cfg = load_analyst_cfg()
    labels = {s["id"]: s["label"] for s in cfg["states"]}
    now = datetime.now(timezone.utc)
    since24 = (now - timedelta(hours=24)).isoformat()
    stored = {**result, "state_label": labels.get(result["state"], result["state"]), "error": error}
    with db.write_conn() as conn:
        astro = conn.execute("SELECT * FROM astronauts WHERE id = ?", (astro_id,)).fetchone()
        prev = conn.execute(
            "SELECT * FROM analyses WHERE astronaut_id = ? ORDER BY ts DESC, id DESC LIMIT 1", (astro_id,)
        ).fetchone()
        # The verdict becomes each indicator's latest level, so tiles, Trends dots, the
        # doctor feed and the CYD all show the same judgement without separate logic.
        for ind, lvl in result["indicator_levels"].items():
            conn.execute(
                "UPDATE readings SET level = ? WHERE id = (SELECT id FROM readings WHERE astronaut_id = ? AND indicator = ? "
                "AND ts >= ? ORDER BY ts DESC LIMIT 1)",
                (lvl, astro_id, ind, since24),
            )
        cur = conn.execute(
            "INSERT INTO analyses (astronaut_id, ts, source, model, trigger, state, overall_level, result_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (astro_id, now.isoformat(), source, model, trigger, result["state"], result["overall_level"], json.dumps(stored)),
        )
        row_id = cur.lastrowid

        prev_alerting = False
        if prev:
            prev_res = json.loads(prev["result_json"])
            prev_age = (now - datetime.fromisoformat(prev["ts"])).total_seconds()
            prev_alerting = _alerting(prev["overall_level"], prev_res.get("alert_surgeon")) and prev_age < REALERT_AFTER_S
        fire = _alerting(result["overall_level"], result["alert_surgeon"]) and not prev_alerting
        alert_text = f"{stored['state_label']}: {result['summary']}"[:200]
        if fire:
            conn.execute(
                "INSERT INTO alerts (astronaut_id, ts, level, text, acknowledged) VALUES (?, ?, ?, ?, 0)",
                (astro_id, now.isoformat(), "RED" if result["overall_level"] == "RED" else "YELLOW", alert_text),
            )
        level_changed = (prev["overall_level"] if prev else None) != result["overall_level"]
        name = astro["name"]

    if fire:
        who = "AI analysis" if source == "ai" else "Rules check"
        comms.queue_report(astro_id, f"{who}: {alert_text}")
        _emit_fn("alert", {"astronaut_id": astro_id, "level": result["overall_level"], "text": alert_text})
    if trigger == "assess" or (astro_id in sessions.active_sessions and level_changed):
        _send_fn(protocol.status(name, result["overall_level"], stored["state_label"][:60]))
        _send_fn(protocol.led(result["overall_level"]))
    public = to_public({"id": row_id, "astronaut_id": astro_id, "ts": now.isoformat(), "source": source, "model": model,
                        "trigger": trigger, "state": result["state"], "overall_level": result["overall_level"],
                        "result_json": json.dumps(stored)})
    _emit_fn("analysis", {**public, "alerted": fire})
    return public


def to_public(row):
    if not row:
        return None
    res = json.loads(row["result_json"])
    return {
        "id": row["id"], "astronaut_id": row["astronaut_id"], "ts": row["ts"], "source": row["source"],
        "model": row["model"], "trigger": row["trigger"], "state": row["state"],
        "state_label": res.get("state_label", row["state"]), "overall_level": row["overall_level"],
        "summary": res.get("summary", ""), "reasons": res.get("reasons", []), "advice": res.get("advice", []),
        "indicator_levels": res.get("indicator_levels", {}), "body_levels": res.get("body_levels", {}),
        "alert_surgeon": res.get("alert_surgeon", False), "error": res.get("error"),
    }


def latest(conn, astro_id, max_age_h=24):
    since = (datetime.now(timezone.utc) - timedelta(hours=max_age_h)).isoformat()
    row = conn.execute(
        "SELECT * FROM analyses WHERE astronaut_id = ? AND ts >= ? ORDER BY ts DESC, id DESC LIMIT 1", (astro_id, since),
    ).fetchone()
    return to_public(dict(row)) if row else None


def is_pending(astro_id):
    with _cv:
        return astro_id in _pending or astro_id in _busy
