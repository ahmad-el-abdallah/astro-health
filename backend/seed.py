"""Creates the crew, object tags, mission settings, and (for any astronaut
with a "story") a 30-day fake history. Uses a fixed random seed, so any
fake history is identical every run. Re-run any time: "Reset demo data" in
Admin calls seed_all() again (it wipes and rebuilds the schema first).

The crew itself is now real (Ahmad and Sameer, with their actual NFC card
UIDs -- see ASTRONAUTS below), not the original fake demo crew from
docs/build-prompt.md section 7; everything else here (object tags, the
mission profile, points/thresholds) is still that spec's placeholder data.
"""
import json
import random
from datetime import datetime, timedelta, timezone

from backend import db
from backend.config import health_rules as load_health_rules, gamification as load_gamification, missions as load_missions
from backend.health_rules import evaluate, symptom_level, overall_level

SEED = 42
DAYS = 30

# Real crew, real NFC cards (UIDs from ~/Desktop/Lifeline/docs/CLAUDE.md, the
# same two cards used there). No "story" key -- unlike a fake demo
# astronaut, they start with a clean slate; their real history builds up
# from actual card taps and check-ins, not a seeded 30-day backstory.
ASTRONAUTS = [
    {"name": "Ahmad", "role": "Crew member", "uid": "9B:25:0F:54", "color": "#4fd1c5",
     "baseline_reaction_ms": 350},
    {"name": "Sameer", "role": "Crew member", "uid": "2B:ED:20:54", "color": "#f4c430",
     "baseline_reaction_ms": 350},
]
SURGEON = {"name": "Dr. Sara Nasser", "role": "Flight surgeon", "uid": "D1000001", "color": "#8bd3ff"}

# uid, type, label, extra data_json
OBJECT_TAGS = [
    ("T2000001", "exercise", "Treadmill", {}),
    ("T2000002", "exercise", "Resistance machine", {}),
    ("T2000003", "exercise", "Exercise bike", {}),
    ("T3000001", "sleep", "Sleep station", {}),
    ("T4000001", "meal", "Food packet: Oatmeal", {"kcal": 320, "protein_g": 12, "calcium_mg": 150, "water_ml": 150}),
    ("T4000002", "meal", "Food packet: Chicken & rice", {"kcal": 480, "protein_g": 35, "calcium_mg": 40, "water_ml": 100}),
    ("T4000003", "meal", "Food packet: Veggie stew", {"kcal": 390, "protein_g": 18, "calcium_mg": 220, "water_ml": 200}),
    ("T4000004", "meal", "Food packet: Protein bar", {"kcal": 250, "protein_g": 20, "calcium_mg": 100, "water_ml": 0}),
    ("T4000005", "meal", "Food packet: Fruit mix", {"kcal": 180, "protein_g": 2, "calcium_mg": 30, "water_ml": 50}),
    ("T4000006", "meal", "Food packet: Dairy pudding", {"kcal": 220, "protein_g": 9, "calcium_mg": 300, "water_ml": 80}),
    ("T5000001", "medicine", "Sleep aid", {}),
    ("T5000002", "medicine", "Pain relief", {}),
    ("T5000003", "medicine", "Motion sickness relief", {}),
    ("T6000001", "bp_guide", "Blood pressure cuff", {}),
    ("E9000001", "emergency", "Emergency card", {}),
]

INDICATORS_DAILY = ["heart_rate", "blood_pressure", "blood_sugar", "temperature", "sleep", "mood", "exercise", "water"]


def _iso(dt):
    return dt.isoformat()


def _day_profile(story, day_index):
    """Returns the day's baseline numbers before per-reading noise, shaped by
    each astronaut's 30-day story (see docs/build-prompt.md section 7)."""
    last_week = day_index >= DAYS - 7
    week3 = 14 <= day_index <= 20
    recovering = 21 <= day_index <= 23

    p = {
        "hr": 70, "sys": 116, "dia": 75, "sugar": 88, "temp": 36.8,
        "sleep": 7.5, "mood": 4, "exercise": 95, "water": 2200,
        "reaction_mult": 1.0, "symptoms": [],
    }
    if story == "steady":
        p["exercise"] = 105  # Lina: healthy, steady, and consistently hits her exercise goal
    elif story == "sleep_decline":
        if last_week:
            # Omar: sleep drops to about 5h, reaction time gets slower
            frac = (day_index - (DAYS - 7)) / 6.0
            p["sleep"] = 7.2 - frac * 2.2
            p["reaction_mult"] = 1.0 + frac * 0.3
            p["mood"] = 4 if frac < 0.5 else 3
            if frac > 0.7:
                p["symptoms"] = ["fatigue"]
    elif story == "bp_rising":
        # Maya: blood pressure slowly rising across the whole month, now YELLOW
        frac = day_index / (DAYS - 1)
        p["sys"] = 116 + frac * 20
        p["dia"] = 75 + frac * 13
    elif story == "mood_dip":
        # Alex: low mood in week 3, recovers after breathing sessions
        if week3:
            p["mood"] = 2
            if day_index >= 16:
                p["symptoms"] = ["headache"]
        elif recovering:
            p["mood"] = 3
        else:
            p["mood"] = 4
    return p


def _noisy(rng, base, spread):
    return base + rng.uniform(-spread, spread)


def _insert_astronaut(conn, name, role, color, baseline_ms):
    cur = conn.execute(
        "INSERT INTO astronauts (name, role, color, baseline_reaction_ms, created_at) VALUES (?, ?, ?, ?, ?)",
        (name, role, color, baseline_ms, _iso(datetime.now(timezone.utc))),
    )
    return cur.lastrowid


def _insert_tag(conn, uid, type_, label, astronaut_id, data):
    conn.execute(
        "INSERT OR REPLACE INTO tags (uid, type, label, astronaut_id, data_json) VALUES (?, ?, ?, ?, ?)",
        (uid, type_, label, astronaut_id, json.dumps(data)),
    )


def _insert_reading(conn, astronaut_id, ts, indicator, value, level, source="seed"):
    conn.execute(
        "INSERT INTO readings (astronaut_id, ts, indicator, value_json, level, source) VALUES (?, ?, ?, ?, ?, ?)",
        (astronaut_id, _iso(ts), indicator, json.dumps(value), level, source),
    )


def _insert_activity(conn, astronaut_id, kind, started_at, ended_at, data):
    conn.execute(
        "INSERT INTO activities (astronaut_id, kind, started_at, ended_at, data_json) VALUES (?, ?, ?, ?, ?)",
        (astronaut_id, kind, _iso(started_at), _iso(ended_at) if ended_at else None, json.dumps(data)),
    )


def _insert_points(conn, astronaut_id, ts, amount, reason):
    if amount:
        conn.execute(
            "INSERT INTO points (astronaut_id, ts, amount, reason) VALUES (?, ?, ?, ?)",
            (astronaut_id, _iso(ts), amount, reason),
        )


def _seed_history(conn, rng, astronaut_id, story, baseline_ms, points_cfg):
    today = datetime.now(timezone.utc).date()
    for day_index in range(DAYS):
        day_date = today - timedelta(days=(DAYS - 1 - day_index))
        morning = datetime(day_date.year, day_date.month, day_date.day, 7, 30, tzinfo=timezone.utc)
        evening = datetime(day_date.year, day_date.month, day_date.day, 19, 0, tzinfo=timezone.utc)
        prof = _day_profile(story, day_index)
        day_levels = []

        hr_m = round(_noisy(rng, prof["hr"], 4))
        hr_e = round(_noisy(rng, prof["hr"], 4))
        for ts, v in ((morning, hr_m), (evening, hr_e)):
            lvl = evaluate("heart_rate", v)
            _insert_reading(conn, astronaut_id, ts, "heart_rate", v, lvl)
            day_levels.append(lvl)

        for ts in (morning, evening):
            sys_v = round(_noisy(rng, prof["sys"], 3))
            dia_v = round(_noisy(rng, prof["dia"], 2))
            lvl = evaluate("blood_pressure", (sys_v, dia_v))
            _insert_reading(conn, astronaut_id, ts, "blood_pressure", {"systolic": sys_v, "diastolic": dia_v}, lvl)
            day_levels.append(lvl)

        sugar_v = round(_noisy(rng, prof["sugar"], 6))
        lvl = evaluate("blood_sugar", sugar_v)
        _insert_reading(conn, astronaut_id, morning, "blood_sugar", sugar_v, lvl)
        day_levels.append(lvl)

        for ts in (morning, evening):
            temp_v = round(_noisy(rng, prof["temp"], 0.2), 1)
            lvl = evaluate("temperature", temp_v)
            _insert_reading(conn, astronaut_id, ts, "temperature", temp_v, lvl)
            day_levels.append(lvl)

        sleep_hours = round(max(3.0, _noisy(rng, prof["sleep"], 0.3)), 1)
        lvl = evaluate("sleep", sleep_hours)
        _insert_reading(conn, astronaut_id, morning, "sleep", sleep_hours, lvl)
        day_levels.append(lvl)
        night_start = morning - timedelta(hours=8, minutes=30)
        _insert_activity(conn, astronaut_id, "sleep", night_start, morning, {"hours": sleep_hours})
        _insert_points(conn, astronaut_id, morning, points_cfg.get("sleep_logged", 0), "sleep logged")
        if sleep_hours >= 7:
            _insert_points(conn, astronaut_id, morning, points_cfg.get("good_sleep_night", 0), "good sleep night")

        mood_v = max(1, min(5, round(_noisy(rng, prof["mood"], 0.6))))
        lvl = evaluate("mood", mood_v)
        _insert_reading(conn, astronaut_id, evening, "mood", mood_v, lvl)
        day_levels.append(lvl)
        _insert_points(conn, astronaut_id, evening, points_cfg.get("mood_logged", 0), "mood logged")

        exercise_min = max(0, round(_noisy(rng, prof["exercise"], 15)))
        lvl = evaluate("exercise", exercise_min)
        _insert_reading(conn, astronaut_id, evening, "exercise", exercise_min, lvl)
        day_levels.append(lvl)
        if exercise_min > 0:
            ex_start = morning + timedelta(hours=1)
            _insert_activity(conn, astronaut_id, "exercise", ex_start, ex_start + timedelta(minutes=exercise_min),
                              {"minutes": exercise_min, "tag": "T2000001"})
            _insert_points(conn, astronaut_id, ex_start, points_cfg.get("exercise_session", 0), "exercise session")
            if exercise_min >= 90:
                _insert_points(conn, astronaut_id, ex_start, points_cfg.get("full_exercise_day", 0), "full exercise day")

        water_ml = max(500, round(_noisy(rng, prof["water"], 250)))
        lvl = evaluate("water", water_ml)
        _insert_reading(conn, astronaut_id, evening, "water", water_ml, lvl)
        day_levels.append(lvl)

        # A couple of meals a day, picked from the seeded food tags.
        for meal_time in (morning + timedelta(hours=4), evening - timedelta(hours=2)):
            food = OBJECT_TAGS[4 + rng.randrange(6)]
            _insert_activity(conn, astronaut_id, "meal", meal_time, meal_time, {"tag": food[0], "label": food[2], **food[3]})
            _insert_points(conn, astronaut_id, meal_time, points_cfg.get("meal_logged", 0), "meal logged")

        # Reaction test roughly every other day.
        if day_index % 2 == 0:
            avg_ms = round(baseline_ms * prof["reaction_mult"] + rng.uniform(-15, 15))
            trials = [max(150, round(avg_ms + rng.uniform(-40, 40))) for _ in range(10)]
            lapses = sum(1 for t in trials if t > 500)
            false_starts = 1 if prof["reaction_mult"] > 1.2 and rng.random() < 0.3 else 0
            lvl = evaluate("reaction_time", (avg_ms, lapses), baseline_reaction_ms=baseline_ms)
            _insert_reading(conn, astronaut_id, evening, "reaction_time", {"avg_ms": avg_ms, "lapses": lapses}, lvl)
            day_levels.append(lvl)
            _insert_activity(conn, astronaut_id, "reaction", evening, evening, {
                "trials_ms": trials, "avg_ms": avg_ms, "lapses": lapses, "false_starts": false_starts,
            })
            _insert_points(conn, astronaut_id, evening, points_cfg.get("reaction_test", 0), "reaction test")

        # Breathing sessions: Alex leans on these to recover from the week-3 mood dip.
        do_breathing = (story == "mood_dip" and 18 <= day_index <= 22) or rng.random() < 0.08
        if do_breathing:
            _insert_activity(conn, astronaut_id, "breathing", evening, evening + timedelta(seconds=60), {"seconds": 60})
            _insert_points(conn, astronaut_id, evening, points_cfg.get("breathing_session", 0), "breathing session")

        symptoms = prof["symptoms"]
        sym_level = symptom_level(symptoms)
        if symptoms:
            conn.execute(
                "INSERT INTO symptoms (astronaut_id, ts, items_json, level) VALUES (?, ?, ?, ?)",
                (astronaut_id, _iso(evening), json.dumps(symptoms), sym_level),
            )
            day_levels.append(sym_level)
            _insert_points(conn, astronaut_id, evening, points_cfg.get("symptom_report", 0), "symptom report")

        overall = overall_level(day_levels)
        note = "All indicators normal" if overall == "GREEN" else "Some indicators need attention"
        conn.execute(
            "INSERT INTO assessments (astronaut_id, ts, overall_level, note, details_json) VALUES (?, ?, ?, ?, ?)",
            (astronaut_id, _iso(evening), overall, note, json.dumps({"levels": day_levels})),
        )
        _insert_points(conn, astronaut_id, evening, points_cfg.get("assess_complete", 0), "daily assessment")
        _insert_points(conn, astronaut_id, morning, points_cfg.get("vitals_check", 0), "vitals check")


def seed_all():
    """Wipes and rebuilds the schema, then fills it with fixed-seed fake data."""
    db.wipe_db()
    db.init_db()
    rng = random.Random(SEED)
    points_cfg = load_gamification()["points"]
    missions_cfg = load_missions()

    with db.write_conn() as conn:
        astronaut_ids = {}
        for a in ASTRONAUTS:
            aid = _insert_astronaut(conn, a["name"], a["role"], a["color"], a["baseline_reaction_ms"])
            astronaut_ids[a["uid"]] = aid
            _insert_tag(conn, a["uid"], "astronaut", a["name"], aid, {})

        surgeon_id = _insert_astronaut(conn, SURGEON["name"], SURGEON["role"], SURGEON["color"], 0)
        _insert_tag(conn, SURGEON["uid"], "surgeon", SURGEON["name"], surgeon_id, {})

        for uid, type_, label, extra in OBJECT_TAGS:
            _insert_tag(conn, uid, type_, label, None, extra)

        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('mission_profile', ?)",
                     (missions_cfg["active_profile"],))
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('emergency_active', 'false')")
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('surgeon_unlocked_until', '')")

        for a in ASTRONAUTS:
            if "story" in a:
                _seed_history(conn, rng, astronaut_ids[a["uid"]], a["story"], a["baseline_reaction_ms"], points_cfg)


if __name__ == "__main__":
    seed_all()
    print("Seeded astro-health demo data.")
