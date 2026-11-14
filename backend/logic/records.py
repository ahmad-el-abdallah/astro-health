"""Crew records: everything the astronauts logged, filtered, as readable rows -- for the
Records page (flight surgeon / superuser) and its Excel export (backend/services/excel_export.py).

Nothing new is stored: it reads the tables the rest of the app already writes (readings,
activities, symptoms, discomfort, assessments, alerts, analyses, journal_entries, voice_tone,
face_analyses) and turns their JSON into plain values a spreadsheet can use.

  parse_filters(args)          the page / export query string -> Filters
  collect(conn, filters)       {section_id: [row dict, ...]} for the chosen categories
  daily_summary(conn, filters) one row per astronaut per (local) day
  SECTIONS                     every section: id, title, category, columns
"""
import json
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone

from backend import config

CATEGORIES = ("vitals", "checkins", "events", "notes")
LEVEL_RANK = {"GREEN": 0, "YELLOW": 1, "RED": 2}
LEVEL_WORD = {"GREEN": "Good", "YELLOW": "Check", "RED": "Alert", "GRAY": "No data"}
MAX_DAYS = 366

VITAL_INDICATORS = ("heart_rate", "blood_pressure", "blood_sugar", "temperature", "oxygen_saturation",
                    "respiration_rate", "stress", "reaction_time", "suit_co2", "suit_pressure", "suit_o2")
SOURCE_WORD = {"manual": "Typed", "cyd": "CYD", "wearable": "Wearable", "voice_check": "AI mood check",
               "astra": "Astra", "tag": "NFC tag", "web": "Web"}

# id, title, category, [(column key, header, kind)] -- kind: datetime | date | text | number | level | long
SECTIONS = [
    ("vitals", "Vitals", "vitals", [("time", "Time", "datetime"), ("astronaut", "Astronaut", "text"), ("measure", "Measure", "text"),
                                    ("value", "Value", "text"), ("number", "Number", "number"), ("unit", "Unit", "text"),
                                    ("level", "Level", "level"), ("source", "Source", "text")]),
    ("mood_checks", "Mood checks", "checkins", [("time", "Time", "datetime"), ("astronaut", "Astronaut", "text"), ("mood", "Mood", "text"),
                                                ("score", "Score (1-5)", "number"), ("level", "Level", "level"), ("judged_by", "Judged by", "text"),
                                                ("summary", "AI summary", "long"), ("emotions", "Emotions", "text"), ("voice", "Voice tone", "text"),
                                                ("answer1", "Answer 1", "long"), ("answer2", "Answer 2", "long"), ("answer3", "Answer 3", "long")]),
    ("mood_logs", "Other mood logs", "checkins", [("time", "Time", "datetime"), ("astronaut", "Astronaut", "text"), ("mood", "Mood", "text"),
                                                  ("score", "Score (1-5)", "number"), ("level", "Level", "level"), ("note", "Note", "long"),
                                                  ("source", "Source", "text")]),
    ("sleep", "Sleep", "checkins", [("time", "Logged", "datetime"), ("astronaut", "Astronaut", "text"), ("hours", "Hours", "number"),
                                    ("bedtime", "Bedtime", "text"), ("wake_time", "Wake time", "text"), ("level", "Level", "level"),
                                    ("source", "Source", "text")]),
    ("exercise", "Exercise", "checkins", [("time", "Time", "datetime"), ("astronaut", "Astronaut", "text"), ("activity", "Activity", "text"),
                                          ("minutes", "Minutes", "number"), ("detail", "Detail", "text"), ("level", "Level", "level"),
                                          ("source", "Source", "text")]),
    ("activities", "Other activities", "checkins", [("time", "Started", "datetime"), ("astronaut", "Astronaut", "text"), ("activity", "Activity", "text"),
                                                    ("minutes", "Minutes", "number"), ("detail", "Detail", "long")]),
    ("symptoms", "Symptoms", "events", [("time", "Time", "datetime"), ("astronaut", "Astronaut", "text"), ("symptoms", "Symptoms", "text"),
                                        ("level", "Level", "level")]),
    ("pain", "Pain", "events", [("time", "Time", "datetime"), ("astronaut", "Astronaut", "text"), ("region", "Body part", "text"),
                                ("intensity", "Intensity (0-10)", "number"), ("level", "Level", "level")]),
    ("assessments", "Assessments", "events", [("time", "Time", "datetime"), ("astronaut", "Astronaut", "text"), ("level", "Level", "level"),
                                              ("note", "Note", "long"), ("readings", "Readings", "long")]),
    ("alerts", "Alerts", "events", [("time", "Time", "datetime"), ("astronaut", "Astronaut", "text"), ("level", "Level", "level"),
                                    ("text", "Alert", "long"), ("seen", "Seen by surgeon", "text")]),
    ("analyses", "AI analyses", "events", [("time", "Time", "datetime"), ("astronaut", "Astronaut", "text"), ("state", "State", "text"),
                                           ("level", "Level", "level"), ("summary", "Summary", "long"), ("by", "Checked by", "text"),
                                           ("trigger", "Trigger", "text")]),
    ("journal", "Journal", "notes", [("time", "Time", "datetime"), ("astronaut", "Astronaut", "text"), ("title", "Title", "text"),
                                     ("body", "Entry", "long")]),
    ("voice_tone", "Voice tone", "notes", [("time", "Time", "datetime"), ("astronaut", "Astronaut", "text"), ("tone", "Tone", "text"),
                                           ("confidence", "Confidence %", "number"), ("seconds", "Phrase (s)", "number"), ("kind", "From", "text")]),
    ("face", "Face analysis", "notes", [("time", "Time", "datetime"), ("astronaut", "Astronaut", "text"), ("quality", "Quality", "text"),
                                        ("seconds", "Seconds", "number"), ("summary", "Report", "long")]),
]
SECTION_BY_ID = {s[0]: s for s in SECTIONS}

DAILY_COLUMNS = [("date", "Date", "date"), ("astronaut", "Astronaut", "text"), ("level", "Worst level", "level"),
                 ("hr_avg", "Heart rate avg", "number"), ("hr_min", "HR min", "number"), ("hr_max", "HR max", "number"),
                 ("bp", "Blood pressure (last)", "text"), ("temp_max", "Temperature max °C", "number"),
                 ("spo2_min", "SpO2 min %", "number"), ("sugar_avg", "Blood sugar avg", "number"),
                 ("breathing_avg", "Breathing avg /min", "number"), ("stress_avg", "Stress avg /100", "number"),
                 ("sleep_h", "Sleep (h)", "number"), ("mood", "Mood (last)", "text"), ("exercise_min", "Exercise (min)", "number"),
                 ("symptoms", "Symptoms", "text"), ("pain_max", "Worst pain (0-10)", "number"), ("alerts", "Alerts", "number"),
                 ("ai_state", "AI state (last)", "text")]


@dataclass
class Filters:
    astronauts: list = field(default_factory=list)   # ids; empty = every crew member
    start: date = None
    end: date = None                                  # inclusive
    tz_minutes: int = 0                               # local time = UTC + tz_minutes
    categories: tuple = CATEGORIES
    level: str = "any"                                # any | YELLOW | RED (= at least)
    q: str = ""

    def utc_range(self):
        lo = datetime(self.start.year, self.start.month, self.start.day, tzinfo=timezone.utc) - timedelta(minutes=self.tz_minutes)
        hi = datetime(self.end.year, self.end.month, self.end.day, tzinfo=timezone.utc) + timedelta(days=1) - timedelta(minutes=self.tz_minutes)
        return lo, hi

    def public(self):
        return {"astronauts": self.astronauts, "from": self.start.isoformat(), "to": self.end.isoformat(),
                "tz": self.tz_minutes, "categories": list(self.categories), "level": self.level, "q": self.q}


def parse_filters(args, today=None):
    """args: a dict-like (request.args). Bad values fall back to the defaults instead of failing."""
    today = today or datetime.now(timezone.utc).date()
    try:
        tz = max(-840, min(840, int(args.get("tz", 0))))
    except (TypeError, ValueError):
        tz = 0

    def day(key, default):
        try:
            return date.fromisoformat(str(args.get(key)))
        except (TypeError, ValueError):
            return default
    end = day("to", today)
    start = day("from", end - timedelta(days=6))
    if start > end:
        start, end = end, start
    if (end - start).days > MAX_DAYS:
        start = end - timedelta(days=MAX_DAYS)
    ids = []
    for part in str(args.get("astronauts", "") or "").split(","):
        if part.strip().isdigit():
            ids.append(int(part))
    cats = tuple(c for c in str(args.get("categories", "") or "").split(",") if c in CATEGORIES) or CATEGORIES
    level = args.get("level") if args.get("level") in ("YELLOW", "RED") else "any"
    q = " ".join(str(args.get("q", "") or "").split())[:80]
    return Filters(ids, start, end, tz, cats, level, q)


# ---- helpers ----

def _ts(text):
    try:
        t = datetime.fromisoformat(str(text))
    except (TypeError, ValueError):
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def _local(ts, f):
    """A stored UTC time as a naive LOCAL datetime (what a spreadsheet shows)."""
    t = _ts(ts)
    return (t + timedelta(minutes=f.tz_minutes)).replace(tzinfo=None) if t else None


def _json(text, default=None):
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return default


def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _level_ok(level, f):
    if f.level == "any":
        return True
    return LEVEL_RANK.get(level, -1) >= LEVEL_RANK[f.level]


def _text_ok(row, f, keys):
    if not f.q:
        return True
    needle = f.q.lower()
    return any(needle in str(row.get(k) or "").lower() for k in keys)


def _pain_level(intensity):
    return "RED" if intensity >= 7 else "YELLOW" if intensity >= 4 else "GREEN"


def _mood_word(v):
    labels = {1: "Rough", 2: "Low", 3: "Okay", 4: "Good", 5: "Great"}
    if isinstance(v, dict):
        return (v.get("mood") or labels.get(v.get("score"), "")).capitalize(), _num(v.get("score"))
    return labels.get(v, str(v)), _num(v)


def readable(indicator, value):
    """(display text, number or None) for one reading's stored value."""
    if indicator == "blood_pressure" and isinstance(value, dict):
        return f"{value.get('systolic')}/{value.get('diastolic')}", None
    if indicator == "sleep":
        hours = value.get("hours") if isinstance(value, dict) else value
        if _num(hours) is not None:
            h, m = int(hours), round((hours - int(hours)) * 60)
            return f"{h} h {m:02d} m", round(hours, 2)
    if indicator == "mood":
        word, score = _mood_word(value)
        return word, score
    if indicator == "reaction_time" and isinstance(value, dict):
        return f"{value.get('avg_ms')} ms, {value.get('lapses', 0)} lapses", _num(value.get("avg_ms"))
    if _num(value) is not None:
        n = round(value, 2)
        return (str(int(n)) if float(n).is_integer() else str(n)), n
    return json.dumps(value) if isinstance(value, (dict, list)) else str(value), None


# ---- collection ----

def _astronauts(conn, f):
    rows = conn.execute("SELECT id, name, role FROM astronauts ORDER BY id").fetchall()
    if f.astronauts:
        return {r["id"]: r["name"] for r in rows if r["id"] in f.astronauts}
    return {r["id"]: r["name"] for r in rows if r["role"] != "Flight surgeon"}


def _select(conn, table, ts_col, ids, lo, hi, cols="*"):
    if not ids:
        return []
    marks = ",".join("?" * len(ids))
    return conn.execute(
        f"SELECT {cols} FROM {table} WHERE astronaut_id IN ({marks}) AND {ts_col} >= ? AND {ts_col} < ? ORDER BY {ts_col}",
        (*ids, lo.isoformat(), hi.isoformat()),
    ).fetchall()


def collect(conn, f, sections=None):
    """{section_id: [rows]} for the filter's categories (or the given section ids)."""
    names = _astronauts(conn, f)
    ids = list(names)
    lo, hi = f.utc_range()
    want = set(sections or [s[0] for s in SECTIONS if s[2] in f.categories])
    rules = config.health_rules()["indicators"]
    out = {s: [] for s in want}

    def add(section, row, level=None, search=()):
        if section not in want:
            return
        if level is not None and not _level_ok(level, f):
            return
        if level is None and f.level != "any":
            return  # rows without a level can't meet "Check or worse"
        if search and not _text_ok(row, f, search):
            return
        out[section].append(row)

    readings = _select(conn, "readings", "ts", ids, lo, hi)
    for r in readings:
        value = _json(r["value_json"])
        base = {"time": _local(r["ts"], f), "astronaut": names[r["astronaut_id"]], "astronaut_id": r["astronaut_id"],
                "level": r["level"], "source": SOURCE_WORD.get(r["source"], r["source"])}
        ind = r["indicator"]
        if ind in VITAL_INDICATORS:
            text, number = readable(ind, value)
            add("vitals", {**base, "measure": rules.get(ind, {}).get("label", ind.replace("_", " ")), "value": text,
                           "number": number, "unit": rules.get(ind, {}).get("unit", "")}, r["level"])
        elif ind == "mood":
            word, score = _mood_word(value)
            if r["source"] == "voice_check" and isinstance(value, dict):
                answers = [a.get("text", "") for a in value.get("answers") or []] + ["", "", ""]
                tone = value.get("tone") or {}
                voice = f"{tone.get('dominant')} ({round((tone.get('confidence') or 0) * 100)}%)" if tone else ""
                add("mood_checks", {**base, "mood": word, "score": score, "judged_by": "AI" if value.get("checked_by") == "ai" else "Rules (AI offline)",
                                    "summary": value.get("note", ""), "emotions": ", ".join(value.get("emotions") or []),
                                    "voice": voice, "answer1": answers[0], "answer2": answers[1], "answer3": answers[2]},
                    r["level"], ("summary", "answer1", "answer2", "answer3") if f.q else ())
            else:
                note = value.get("note", "") if isinstance(value, dict) else ""
                add("mood_logs", {**base, "mood": word, "score": score, "note": note}, r["level"], ("note",) if f.q else ())
        elif ind == "sleep":
            text, hours = readable(ind, value)
            v = value if isinstance(value, dict) else {}
            add("sleep", {**base, "hours": hours, "bedtime": v.get("bedtime", ""), "wake_time": v.get("wake_time", "")}, r["level"])
        elif ind in ("exercise", "water"):
            text, number = readable(ind, value)
            add("exercise", {**base, "activity": "Exercise" if ind == "exercise" else "Water", "minutes": number if ind == "exercise" else None,
                             "detail": "" if ind == "exercise" else f"{text} ml"}, r["level"])

    for a in _select(conn, "activities", "started_at", ids, lo, hi):
        data = _json(a["data_json"], {}) or {}
        start, end = _ts(a["started_at"]), _ts(a["ended_at"])
        minutes = round((end - start).total_seconds() / 60, 1) if start and end else None
        minutes = _num(data.get("minutes")) or minutes
        row = {"time": _local(a["started_at"], f), "astronaut": names[a["astronaut_id"]], "astronaut_id": a["astronaut_id"],
               "activity": a["kind"].replace("_", " ").capitalize(), "minutes": minutes}
        if a["kind"] in ("exercise", "workout"):
            detail = data.get("name") or data.get("exercise") or ""
            add("exercise", {**row, "detail": str(detail), "level": None, "source": "Activity"}, None)
        else:
            keep = {k: v for k, v in data.items() if k not in ("type", "uid", "trials_ms")}
            add("activities", {**row, "detail": ", ".join(f"{k.replace('_', ' ')} {v}" for k, v in keep.items())}, None)

    symptom_labels = {s["id"]: s["label"] for s in (config.symptoms().get("symptoms") or []) if isinstance(s, dict)}
    for s in _select(conn, "symptoms", "ts", ids, lo, hi):
        items = _json(s["items_json"], []) or []
        add("symptoms", {"time": _local(s["ts"], f), "astronaut": names[s["astronaut_id"]], "astronaut_id": s["astronaut_id"],
                         "symptoms": ", ".join(symptom_labels.get(i, str(i).replace("_", " ")) for i in items), "level": s["level"]},
            s["level"], ("symptoms",) if f.q else ())
    for d in _select(conn, "discomfort", "ts", ids, lo, hi):
        lvl = _pain_level(d["intensity"])
        add("pain", {"time": _local(d["ts"], f), "astronaut": names[d["astronaut_id"]], "astronaut_id": d["astronaut_id"],
                     "region": d["region"].replace("_", " ").capitalize(), "intensity": d["intensity"], "level": lvl}, lvl)
    for a in _select(conn, "assessments", "ts", ids, lo, hi):
        details = _json(a["details_json"], {}) or {}
        parts = []
        for ind, d in details.items():
            if isinstance(d, dict) and "value" in d and ind in rules:
                text, _ = readable(ind, d["value"])
                parts.append(f"{rules[ind].get('label', ind)} {text} {rules[ind].get('unit', '')}".strip())
        add("assessments", {"time": _local(a["ts"], f), "astronaut": names[a["astronaut_id"]], "astronaut_id": a["astronaut_id"],
                            "level": a["overall_level"], "note": a["note"], "readings": "; ".join(parts)},
            a["overall_level"], ("note",) if f.q else ())
    for a in _select(conn, "alerts", "ts", ids, lo, hi):
        add("alerts", {"time": _local(a["ts"], f), "astronaut": names[a["astronaut_id"]], "astronaut_id": a["astronaut_id"],
                       "level": a["level"], "text": a["text"], "seen": "Yes" if a["acknowledged"] else "No"},
            a["level"], ("text",) if f.q else ())
    for a in _select(conn, "analyses", "ts", ids, lo, hi):
        result = _json(a["result_json"], {}) or {}
        add("analyses", {"time": _local(a["ts"], f), "astronaut": names[a["astronaut_id"]], "astronaut_id": a["astronaut_id"],
                         "state": a["state"].replace("_", " ").capitalize(), "level": a["overall_level"],
                         "summary": result.get("summary", ""), "by": f"AI ({a['model']})" if a["source"] == "ai" else "Rules (AI offline)",
                         "trigger": a["trigger"]}, a["overall_level"], ("summary",) if f.q else ())
    for j in _select(conn, "journal_entries", "created_at", ids, lo, hi):
        add("journal", {"time": _local(j["created_at"], f), "astronaut": names[j["astronaut_id"]], "astronaut_id": j["astronaut_id"],
                        "title": j["title"], "body": j["body"]}, None, ("title", "body") if f.q else ())
    talk_kind = {}
    if "voice_tone" in want and ids:
        talk_kind = {r["id"]: r["kind"] for r in conn.execute(
            f"SELECT id, kind FROM voice_talks WHERE astronaut_id IN ({','.join('?' * len(ids))})", ids)}
    for v in _select(conn, "voice_tone", "ts", ids, lo, hi):
        add("voice_tone", {"time": _local(v["ts"], f), "astronaut": names[v["astronaut_id"]], "astronaut_id": v["astronaut_id"],
                           "tone": v["label"], "confidence": round(v["confidence"] * 100), "seconds": round(v["duration_s"], 1),
                           "kind": "Mood check" if talk_kind.get(v["talk_id"]) == "mood_check" else "Wanna talk?"}, None)
    for fa in _select(conn, "face_analyses", "ts", ids, lo, hi):
        report = _json(fa["report_json"], {}) or {}
        add("face", {"time": _local(fa["ts"], f), "astronaut": names[fa["astronaut_id"]], "astronaut_id": fa["astronaut_id"],
                     "quality": fa["quality"], "seconds": round(fa["duration_s"], 1),
                     "summary": report.get("summary") or "; ".join(str(x) for x in report.get("observations", [])[:4])}, None)
    return out


def daily_summary(conn, f):
    """One row per astronaut per local day, from every kind of data (regardless of which
    categories are shown), filtered by the level filter on the day's worst level."""
    every = Filters(f.astronauts, f.start, f.end, f.tz_minutes, CATEGORIES, "any", "")
    data = collect(conn, every)
    days = {}

    def day_of(row):
        key = (row["time"].date(), row["astronaut_id"])
        if key not in days:
            days[key] = {"date": key[0], "astronaut": row["astronaut"], "levels": [], "hr": [], "bp": None, "temp": [], "spo2": [],
                         "sugar": [], "breathing": [], "stress": [], "sleep": None, "mood": None, "exercise": 0.0,
                         "symptoms": [], "pain": [], "alerts": 0, "ai": None}
        return days[key]

    numbers = {"Heart rate": "hr", "Body temperature": "temp", "Blood oxygen (SpO2)": "spo2", "Blood sugar": "sugar",
               "Breathing rate": "breathing", "Stress (skin response)": "stress"}
    for r in data.get("vitals", []):
        d = day_of(r)
        if r["level"]:
            d["levels"].append(r["level"])
        key = numbers.get(r["measure"])
        if key and r["number"] is not None:
            d[key].append(r["number"])
        if r["measure"] == "Blood pressure":
            d["bp"] = r["value"]
    for section in ("mood_checks", "mood_logs"):
        for r in data.get(section, []):
            d = day_of(r)
            d["levels"].append(r["level"])
            d["mood"] = r["mood"] + (" (AI check)" if section == "mood_checks" else "")
    for r in data.get("sleep", []):
        day_of(r)["sleep"] = r["hours"]
    for r in data.get("exercise", []):
        if r["minutes"]:
            day_of(r)["exercise"] += r["minutes"]
    for r in data.get("symptoms", []):
        d = day_of(r)
        d["levels"].append(r["level"])
        d["symptoms"].extend(x.strip() for x in r["symptoms"].split(",") if x.strip())
    for r in data.get("pain", []):
        day_of(r)["pain"].append(r["intensity"])
    for r in data.get("assessments", []):
        day_of(r)["levels"].append(r["level"])
    for r in data.get("alerts", []):
        d = day_of(r)
        d["alerts"] += 1
        d["levels"].append(r["level"])
    for r in data.get("analyses", []):
        day_of(r)["ai"] = r["state"]

    avg = lambda xs: round(sum(xs) / len(xs), 1) if xs else None  # noqa: E731
    rows = []
    for (day, _), d in sorted(days.items(), key=lambda kv: (kv[0][0], kv[1]["astronaut"]), reverse=True):
        worst = max(d["levels"], key=lambda lv: LEVEL_RANK.get(lv, -1)) if d["levels"] else "GRAY"
        row = {"date": day, "astronaut": d["astronaut"], "level": worst,
               "hr_avg": avg(d["hr"]), "hr_min": min(d["hr"]) if d["hr"] else None, "hr_max": max(d["hr"]) if d["hr"] else None,
               "bp": d["bp"] or "", "temp_max": max(d["temp"]) if d["temp"] else None, "spo2_min": min(d["spo2"]) if d["spo2"] else None,
               "sugar_avg": avg(d["sugar"]), "breathing_avg": avg(d["breathing"]), "stress_avg": avg(d["stress"]),
               "sleep_h": d["sleep"], "mood": d["mood"] or "", "exercise_min": round(d["exercise"], 1) or None,
               "symptoms": ", ".join(dict.fromkeys(d["symptoms"])), "pain_max": max(d["pain"]) if d["pain"] else None,
               "alerts": d["alerts"] or None, "ai_state": d["ai"] or ""}
        if _level_ok(worst, f) or f.level == "any":
            rows.append(row)
    return rows
