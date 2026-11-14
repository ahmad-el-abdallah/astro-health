"""The Schedule page's task statuses (backend/jobs/scheduler.py day_plan):
done comes from what the astronaut actually logged in the task's window, not
from anything the browser saw."""
import time
from datetime import datetime, timezone

import pytest

from backend import db
from backend.jobs import scheduler
from tests.conftest import seed_minimal

ROUTINE = {"schedule": [
    {"time": "07:00", "text": "Morning vitals check", "kind": "vitals"},
    {"time": "08:00", "text": "Exercise block", "kind": "exercise"},
    {"time": "13:00", "text": "Midday cardio", "kind": "exercise"},
    {"time": "19:00", "text": "Evening mood check", "kind": "mood"},
]}
SCALE = 60.0


@pytest.fixture()
def clock(fresh_db, monkeypatch):
    monkeypatch.setattr(scheduler, "load_routine", lambda: ROUTINE)
    monkeypatch.setattr(scheduler, "TIME_SCALE", SCALE)
    with db.write_conn() as conn:
        astro_id = seed_minimal(conn)
    base = time.time() - 10_000

    def at(hhmm):
        """Pretend the mission clock reads hhmm on day 1; returns real 'now'."""
        h, m = map(int, hhmm.split(":"))
        scheduler.clock_started_at = base
        return base + (h * 3600 + m * 60) / SCALE

    return astro_id, at


def _log(conn, table, astro_id, epoch, indicator=None):
    ts = datetime.fromtimestamp(epoch, timezone.utc).isoformat()
    if table == "assessments":
        conn.execute("INSERT INTO assessments (astronaut_id, ts, overall_level, note, details_json) VALUES (?, ?, 'GREEN', '', '{}')", (astro_id, ts))
    else:
        conn.execute("INSERT INTO readings (astronaut_id, ts, indicator, value_json, level, source) VALUES (?, ?, ?, '3', 'GREEN', 'manual')", (astro_id, ts, indicator))


def statuses(plan):
    return {e["time"]: e["status"] for e in plan["entries"]}


def test_statuses_follow_the_mission_clock(clock):
    astro_id, at = clock
    with db.write_conn() as conn:
        plan = scheduler.day_plan(conn, astro_id, now=at("07:30"))
    assert plan["day"] == 1
    assert statuses(plan) == {"07:00": "due", "08:00": "upcoming", "13:00": "upcoming", "19:00": "upcoming"}


def test_logged_vitals_mark_the_task_done(clock):
    astro_id, at = clock
    now = at("07:30")
    with db.write_conn() as conn:
        _log(conn, "assessments", astro_id, at("07:10"))
        plan = scheduler.day_plan(conn, astro_id, now=now)
    vitals = plan["entries"][0]
    assert vitals["status"] == "done" and vitals["done_at"] == "07:10"


def test_one_workout_only_counts_for_one_exercise_slot(clock):
    astro_id, at = clock
    with db.write_conn() as conn:
        _log(conn, "readings", astro_id, at("08:20"), "exercise")
        plan = scheduler.day_plan(conn, astro_id, now=at("13:30"))
    st = statuses(plan)
    assert st["08:00"] == "done"
    assert st["13:00"] == "due"


def test_overdue_tasks_become_missed(clock):
    astro_id, at = clock
    with db.write_conn() as conn:
        plan = scheduler.day_plan(conn, astro_id, now=at("12:00"))
    assert statuses(plan)["07:00"] == "missed"


def test_slightly_early_still_counts(clock):
    astro_id, at = clock
    with db.write_conn() as conn:
        _log(conn, "readings", astro_id, at("18:30"), "mood")
        plan = scheduler.day_plan(conn, astro_id, now=at("18:40"))
    assert statuses(plan)["19:00"] == "done"


def test_early_vitals_and_mood_checks_count_but_an_early_workout_does_not(clock):
    """The first vitals check and the (only) mood check of the day count from 00:00 (an early
    Assess, wearable test or daily mood check); other kinds keep the 1-hour-early limit."""
    astro_id, at = clock
    with db.write_conn() as conn:
        _log(conn, "assessments", astro_id, at("02:00"))
        _log(conn, "readings", astro_id, at("02:00"), "mood")
        _log(conn, "readings", astro_id, at("02:00"), "exercise")
        plan = scheduler.day_plan(conn, astro_id, now=at("02:30"))
    st = statuses(plan)
    assert st["07:00"] == "done"      # vitals
    assert st["19:00"] == "done"      # the daily mood check
    assert st["08:00"] == "upcoming"  # a 02:00 workout isn't the 08:00 block
