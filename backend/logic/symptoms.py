"""The symptom catalog (config/symptoms.json) plus the shared logging logic
used both by a CYD/simulator symptom report (backend/routes/routes.py's
_record_symptoms) and by the web app's manual symptom reporting.
"""
import json
from datetime import datetime, timezone

from backend.config import symptoms as load_symptoms
from backend.logic import health_rules
from backend.jobs import comms


def catalog():
    return load_symptoms()["symptoms"]


def record(conn, astro_id, items):
    """Inserts a symptom report; returns the computed
    level. Callers decide separately how to notify listeners (see
    routes.py's handle_cyd_message trailing cyd_event emit vs. the
    dedicated /symptoms route, which aren't the same for every caller)."""
    now = datetime.now(timezone.utc).isoformat()
    lvl = health_rules.symptom_level(items)
    conn.execute(
        "INSERT INTO symptoms (astronaut_id, ts, items_json, level) VALUES (?, ?, ?, ?)",
        (astro_id, now, json.dumps(items), lvl),
    )
    return lvl


def alert_if_red(astro_id, items, level, emit_fn):
    if level == "RED":
        comms.queue_report(astro_id, f"RED symptoms reported: {', '.join(items)}")
        emit_fn("alert", {"astronaut_id": astro_id, "level": "RED", "text": "Red-flag symptom reported"})
