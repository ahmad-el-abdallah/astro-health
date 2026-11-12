import json
import time
from datetime import datetime, timedelta, timezone

import pytest

from backend import db
from backend.logic import analysis, sessions
from backend.services import analyst
from tests.conftest import seed_minimal


def _reading(conn, astro_id, indicator, value, level="GREEN", ago_min=0):
    ts = (datetime.now(timezone.utc) - timedelta(minutes=ago_min)).isoformat()
    conn.execute(
        "INSERT INTO readings (astronaut_id, ts, indicator, value_json, level, source) VALUES (?, ?, ?, ?, ?, 'manual')",
        (astro_id, ts, indicator, json.dumps(value), level),
    )


@pytest.fixture()
def astro(fresh_db):
    with db.write_conn() as conn:
        return seed_minimal(conn)


def _ai_answer(**over):
    out = {"state": "possibly_sick", "overall_level": "YELLOW", "indicator_levels": {"temperature": "YELLOW"},
           "body_levels": {"immune": "YELLOW"}, "summary": "Mild fever.", "reasons": ["37.9 °C"],
           "advice": ["Rest."], "alert_surgeon": False}
    out.update(over)
    return out


def test_context_mentions_an_open_sleep_tag_and_week_stats(astro):
    sessions.open_toggles["T3000001"] = {"astronaut_id": astro, "kind": "sleep",
                                         "started_at": time.time() - 60, "started_iso": datetime.now(timezone.utc).isoformat()}
    with db.write_conn() as conn:
        _reading(conn, astro, "heart_rate", 52, ago_min=5)
        _reading(conn, astro, "heart_rate", 70, ago_min=60 * 30)  # older than 24 h, still in the week
    with db.write_conn() as conn:
        text, inds, facts = analysis.build_context(conn, astro)
    assert "ASLEEP" in text
    assert "heart_rate" in inds
    assert "Last 7 days" in text and "min 52, avg 61.0, max 70" in text
    assert "Reference ranges" in text and "heart_rate: GREEN 60-100" in text


def test_ai_verdict_overrides_latest_reading_levels_and_is_saved(astro, monkeypatch):
    with db.write_conn() as conn:
        _reading(conn, astro, "temperature", 37.9, level="RED")  # rules' placeholder level
    monkeypatch.setattr(analyst, "analyze", lambda text, inds: _ai_answer())
    out = analysis.run_now(astro, "manual")
    assert out["source"] == "ai" and out["state"] == "possibly_sick" and out["state_label"] == "Possibly sick"
    with db.write_conn() as conn:
        assert conn.execute("SELECT level FROM readings WHERE indicator = 'temperature'").fetchone()["level"] == "YELLOW"
        assert conn.execute("SELECT COUNT(*) AS c FROM analyses").fetchone()["c"] == 1
        assert analysis.latest(conn, astro)["summary"] == "Mild fever."


def test_red_alerts_the_surgeon_once_per_transition(astro, monkeypatch):
    with db.write_conn() as conn:
        _reading(conn, astro, "temperature", 39.5)
    monkeypatch.setattr(analyst, "analyze", lambda text, inds: _ai_answer(overall_level="RED", state="unwell"))
    analysis.run_now(astro)
    analysis.run_now(astro)  # still RED: no second alert
    with db.write_conn() as conn:
        assert conn.execute("SELECT COUNT(*) AS c FROM alerts").fetchone()["c"] == 1
        assert conn.execute("SELECT COUNT(*) AS c FROM messages WHERE from_role = 'crew'").fetchone()["c"] == 1
    monkeypatch.setattr(analyst, "analyze", lambda text, inds: _ai_answer(overall_level="GREEN", state="well"))
    analysis.run_now(astro)
    monkeypatch.setattr(analyst, "analyze", lambda text, inds: _ai_answer(overall_level="RED", state="unwell"))
    analysis.run_now(astro)  # back into RED: a new alert
    with db.write_conn() as conn:
        assert conn.execute("SELECT COUNT(*) AS c FROM alerts").fetchone()["c"] == 2


def test_ai_can_ask_for_the_surgeon_without_red(astro, monkeypatch):
    with db.write_conn() as conn:
        _reading(conn, astro, "mood", 2)
    monkeypatch.setattr(analyst, "analyze", lambda text, inds: _ai_answer(state="stressed", alert_surgeon=True,
                                                                          indicator_levels={"mood": "YELLOW"}))
    analysis.run_now(astro)
    with db.write_conn() as conn:
        assert conn.execute("SELECT level FROM alerts").fetchone()["level"] == "YELLOW"


def test_rules_fallback_when_the_ai_fails(astro, monkeypatch):
    with db.write_conn() as conn:
        _reading(conn, astro, "temperature", 38.6)
        _reading(conn, astro, "heart_rate", 75)

    def down(text, inds):
        raise analyst.AnalystError("AI unreachable")

    monkeypatch.setattr(analyst, "analyze", down)
    out = analysis.run_now(astro)
    assert out["source"] == "rules" and out["error"] == "AI unreachable"
    assert out["overall_level"] == "RED" and out["state"] == "unwell"
    with db.write_conn() as conn:
        assert conn.execute("SELECT COUNT(*) AS c FROM alerts").fetchone()["c"] == 1


def test_rules_fallback_knows_someone_is_asleep(astro):
    sessions.open_toggles["T3000001"] = {"astronaut_id": astro, "kind": "sleep",
                                         "started_at": time.time(), "started_iso": datetime.now(timezone.utc).isoformat()}
    with db.write_conn() as conn:
        _reading(conn, astro, "heart_rate", 58)
    out = analysis.run_now(astro)  # no key in tests -> rules
    assert out["source"] == "rules" and out["state"] == "sleeping"


def test_rules_fallback_a_red_reading_beats_sleeping(astro):
    sessions.open_toggles["T3000001"] = {"astronaut_id": astro, "kind": "sleep",
                                         "started_at": time.time(), "started_iso": datetime.now(timezone.utc).isoformat()}
    with db.write_conn() as conn:
        _reading(conn, astro, "temperature", 39.2)
    assert analysis.run_now(astro)["state"] == "unwell"


def test_no_data_is_not_sent_to_the_ai(astro, monkeypatch):
    monkeypatch.setattr(analyst, "analyze", lambda *a: pytest.fail("AI should not be called with no data"))
    out = analysis.run_now(astro)
    assert out["state"] == "not_enough_data" and out["source"] == "rules"


def test_a_burst_of_requests_becomes_one_analysis(astro, monkeypatch):
    runs = []
    monkeypatch.setattr(analysis, "run_now", lambda a, t="manual": runs.append((a, t)))
    monkeypatch.setattr(analysis, "DEBOUNCE_S", 0.2)
    analysis.start_worker()
    for trigger in ("cyd_mood", "symptoms", "assess"):
        analysis.request(astro, trigger)
    assert analysis.wait_idle(3)
    assert runs == [(astro, "assess")]
