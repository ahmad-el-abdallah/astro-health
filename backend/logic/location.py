"""Where each astronaut is right now: inside the station/spacecraft, or outside on a
spacewalk (EVA). Set from the top bar's Location pill (or by Astra, after a yes).

While someone is on EVA, three suit readings (config/health_rules.json: suit_co2,
suit_pressure, suit_o2) join their readings and the AI health analysis treats them as
life-critical. Suit readings only ever count during the EVA they were taken in: back
inside -- or out again on a later EVA -- older suit readings are ignored, so a red CO2
reading can't keep someone red for the rest of the day.

Stored in the settings table as `location:<astronaut_id>` = {"location", "since"}.
"""
import json
from datetime import datetime, timezone

from backend.config import TIME_SCALE

LOCATIONS = ("inside", "eva")
SUIT_PREFIX = "suit_"


def _key(astro_id):
    return f"location:{int(astro_id)}"


def get(conn, astro_id):
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (_key(astro_id),)).fetchone()
    try:
        data = json.loads(row["value"]) if row else {}
    except (TypeError, ValueError):
        data = {}
    if data.get("location") not in LOCATIONS:
        return {"location": "inside", "since": None}
    return {"location": data["location"], "since": data.get("since")}


def set(conn, astro_id, location):
    data = {"location": location, "since": datetime.now(timezone.utc).isoformat()}
    conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (_key(astro_id), json.dumps(data)))
    return data


def eva_since(conn, astro_id):
    """When the current EVA started (ISO), or None when inside."""
    loc = get(conn, astro_id)
    return loc["since"] if loc["location"] == "eva" else None


def is_suit(indicator):
    return str(indicator).startswith(SUIT_PREFIX)


def counts(indicator, ts, since):
    """Does this reading count? Everything does, except suit readings outside the current EVA."""
    return not is_suit(indicator) or (since is not None and ts >= since)


def mission_minutes(since, now=None):
    if not since:
        return 0
    now = now or datetime.now(timezone.utc)
    return round((now - datetime.fromisoformat(since)).total_seconds() * TIME_SCALE / 60)
