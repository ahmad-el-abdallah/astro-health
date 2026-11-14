"""Real spacewalk history (backend/logic/eva_history.py): NASA's EVA log, compared with a live
EVA, real suit problems, the open route, and the AI context line."""
import argparse
from datetime import datetime, timedelta, timezone

from backend import db
from backend.logic import eva_history, location


def test_the_log_loads_with_real_numbers():
    s = eva_history.stats()
    assert s["total"] == 375 and s["completed"] == 368 and s["cancelled"] == 6
    assert (s["first_year"], s["last_year"]) == (1965, 2013) and s["by_country"] == {"Russia": 139, "USA": 236}
    assert s["median_h"] == 6.01 and s["p90_h"] == 7.35
    assert s["record"]["hours"] == 8.93 and "Susan Helms" in s["record"]["crew"]
    assert [d["decade"] for d in s["by_decade"]] == [1960, 1970, 1980, 1990, 2000, 2010]
    assert len(s["done_hours"]) == 368 and s["done_hours"] == sorted(s["done_hours"])


def test_compare_with_real_spacewalks():
    assert eva_history.compare(3)["longer_than_pct"] == 14
    assert "most had ended by" in eva_history.compare(8)["phrase"]
    assert "longer than every spacewalk" in eva_history.compare(9.5)["phrase"]


def test_every_hand_picked_incident_is_found():
    inc = eva_history.incidents()
    assert sum(len(v) for v in inc.values()) == len(eva_history.INCIDENT_PICKS)
    assert set(inc) == {"suit_co2", "suit_pressure", "suit_o2", "cooling"}
    water = [i for i in inc["cooling"] if "water" in i["what"]][0]
    assert water["date"] == "2013-07-16" and "Parmitano" in water["crew"]
    co2 = inc["suit_co2"][0]
    assert co2["crew"] == "Doug Wheelock & Tracy Caldwell Dyson"  # source typo fixed for display


def test_context_line_names_a_matching_problem():
    line = eva_history.context_line(400, ["suit_co2"])
    assert "typical length 6.0 h" in line and "6.7 h" in line and "CO2 in the suit" in line


def test_route_and_ai_context(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "eva.db"))
    import app as app_module
    from backend.logic import analysis
    args = argparse.Namespace(port=None, simulate=True, wifi=False, wifi_host=None, wifi_port=None, host="0.0.0.0", web_port=5000)
    flask_app, _, _ = app_module.create_app(args)
    client = flask_app.test_client()
    data = client.get("/api/eva-history").get_json()  # open, like /content
    assert data["stats"]["completed"] == 368 and "NASA" in data["source"]
    with db.write_conn() as conn:
        location.set(conn, 1, "eva")
        since = location.eva_since(conn, 1)
        ts = (datetime.fromisoformat(since) + timedelta(seconds=1)).isoformat()
        conn.execute("INSERT INTO readings (astronaut_id, ts, indicator, value_json, level, source) VALUES (1, ?, 'suit_co2', '9', 'RED', 'manual')", (ts,))
    with db.write_conn() as conn:
        text, _, _ = analysis.build_context(conn, 1)
    assert "Real spacewalk history" in text and "CO2 in the suit" in text
