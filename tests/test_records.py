"""Crew records: filters, readable values, the daily summary, who may see them, and the
Excel export (a real .xlsx, checked by opening its zip)."""
import argparse
import io
import json
import re
import zipfile
from datetime import date, datetime, timedelta, timezone

import pytest

from backend import db
from backend.auth.create_superuser import create_superuser
from backend.logic import records

AHMAD, SURGEON = "9B:25:0F:54", "D1000001"


def test_parse_filters_defaults_and_bad_values():
    f = records.parse_filters({}, today=date(2026, 11, 14))
    assert (f.start, f.end) == (date(2026, 11, 8), date(2026, 11, 14)) and f.categories == records.CATEGORIES
    f = records.parse_filters({"from": "2026-11-20", "to": "2026-11-10", "tz": "180", "categories": "vitals,nope",
                               "level": "RED", "astronauts": "1,x,2", "q": "  head   ache "})
    assert (f.start, f.end) == (date(2026, 11, 10), date(2026, 11, 20))  # swapped
    assert f.tz_minutes == 180 and f.categories == ("vitals",) and f.level == "RED" and f.astronauts == [1, 2] and f.q == "head ache"
    assert records.parse_filters({"level": "PURPLE", "tz": "abc"}).level == "any"


def test_local_day_range_follows_the_timezone():
    f = records.Filters([], date(2026, 11, 14), date(2026, 11, 14), 180)
    lo, hi = f.utc_range()
    assert lo == datetime(2026, 11, 13, 21, 0, tzinfo=timezone.utc) and hi == datetime(2026, 11, 14, 21, 0, tzinfo=timezone.utc)


def test_readable_values():
    assert records.readable("blood_pressure", {"systolic": 120, "diastolic": 80}) == ("120/80", None)
    assert records.readable("sleep", {"hours": 7.5, "bedtime": "23:00"}) == ("7 h 30 m", 7.5)
    assert records.readable("sleep", 6) == ("6 h 00 m", 6)
    assert records.readable("mood", {"mood": "low", "score": 2}) == ("Low", 2)
    assert records.readable("mood", 4) == ("Good", 4)
    assert records.readable("heart_rate", 72.0) == ("72", 72.0)
    assert records.readable("reaction_time", {"avg_ms": 300, "lapses": 1}) == ("300 ms, 1 lapses", 300)


# ---- with data ----

@pytest.fixture(scope="module")
def client(tmp_path_factory):
    from _pytest.monkeypatch import MonkeyPatch
    mp = MonkeyPatch()
    mp.setattr(db, "DB_PATH", str(tmp_path_factory.mktemp("records") / "test.db"))
    import app as app_module
    args = argparse.Namespace(port=None, simulate=True, wifi=False, wifi_host=None, wifi_port=None,
                              host="0.0.0.0", web_port=5000)
    flask_app, _, _ = app_module.create_app(args)
    flask_app.config["TESTING"] = True
    now = datetime.now(timezone.utc)
    yesterday = now - timedelta(days=1)
    with db.write_conn() as conn:
        def reading(astro, ts, ind, value, level, source="manual"):
            conn.execute("INSERT INTO readings (astronaut_id, ts, indicator, value_json, level, source) VALUES (?,?,?,?,?,?)",
                         (astro, ts.isoformat(), ind, json.dumps(value), level, source))
        reading(1, now, "heart_rate", 70, "GREEN")
        reading(1, now, "heart_rate", 110, "YELLOW")
        reading(1, now, "blood_pressure", {"systolic": 125, "diastolic": 82}, "GREEN")
        reading(1, now, "sleep", {"hours": 7.5, "bedtime": "23:00", "wake_time": "06:30"}, "GREEN")
        reading(1, now, "mood", {"mood": "low", "score": 2, "note": "You sound tired.", "checked_by": "ai", "emotions": ["tired"],
                                 "tone": {"dominant": "calm", "confidence": 0.8}, "answers": [{"text": "a headache all day"},
                                 {"text": "slept badly"}, {"text": "fine"}]}, "YELLOW", "voice_check")
        reading(1, yesterday, "heart_rate", 64, "GREEN")
        reading(2, now, "heart_rate", 180, "RED")
        conn.execute("INSERT INTO symptoms (astronaut_id, ts, items_json, level) VALUES (1, ?, ?, 'YELLOW')", (now.isoformat(), json.dumps(["headache"])))
        conn.execute("INSERT INTO discomfort (astronaut_id, region, intensity, ts) VALUES (1, 'skeleton', 8, ?)", (now.isoformat(),))
        conn.execute("INSERT INTO alerts (astronaut_id, ts, level, text, acknowledged) VALUES (2, ?, 'RED', 'HR 180', 0)", (now.isoformat(),))
        conn.execute("INSERT INTO journal_entries (astronaut_id, title, body, created_at) VALUES (1, 'Day', 'Saw the aurora', ?)", (now.isoformat(),))
        conn.execute("INSERT INTO activities (astronaut_id, kind, started_at, ended_at, data_json) VALUES (1, 'exercise', ?, ?, '{}')",
                     ((now - timedelta(minutes=30)).isoformat(), now.isoformat()))
    create_superuser("boss", "pass1234")
    yield flask_app.test_client()
    mp.undo()


def login(client, uid):
    client.post("/api/admin/logout")
    assert client.post("/api/auth/nfc_login", json={"uid": uid}).status_code == 200


def test_only_the_surgeon_or_a_superuser_sees_records(client):
    client.post("/api/auth/logout")
    client.post("/api/admin/logout")
    assert client.get("/api/records").status_code == 401
    login(client, AHMAD)
    assert client.get("/api/records").status_code == 403
    assert client.get("/api/records/export.xlsx").status_code == 403
    login(client, SURGEON)
    assert client.get("/api/records").status_code == 200
    client.post("/api/auth/logout")
    assert client.post("/api/admin/login", json={"username": "boss", "password": "pass1234"}).status_code == 200
    assert client.get("/api/records").status_code == 200


def test_sections_and_filters(client):
    login(client, SURGEON)
    data = client.get("/api/records?astronauts=1").get_json()
    sec = {s["id"]: s for s in data["sections"]}
    vitals = sec["vitals"]["rows"]
    assert {r["value"] for r in vitals} >= {"70", "110", "125/82"} and all(r["astronaut"] == "Ahmad" for r in vitals)
    check = sec["mood_checks"]["rows"][0]
    assert check["mood"] == "Low" and check["judged_by"] == "AI" and check["answer1"] == "a headache all day" and "calm" in check["voice"]
    assert sec["sleep"]["rows"][0]["hours"] == 7.5 and sec["pain"]["rows"][0]["level"] == "RED"
    assert sec["exercise"]["rows"][0]["minutes"] == 30.0
    assert sec["journal"]["rows"][0]["body"] == "Saw the aurora"
    # level: alerts only
    red = client.get("/api/records?level=RED").get_json()
    assert all(r["level"] == "RED" for s in red["sections"] for r in s["rows"] if "level" in r)
    assert any(s["id"] == "alerts" and s["total"] == 1 for s in red["sections"])
    # categories + search
    only = client.get("/api/records?categories=notes&q=aurora").get_json()
    assert {s["id"] for s in only["sections"]} == {"journal", "voice_tone", "face"} and only["sections"][0]["total"] == 1


def test_daily_summary(client):
    login(client, SURGEON)
    rows = client.get("/api/records?astronauts=1").get_json()["daily"]["rows"]
    today = [r for r in rows if r["hr_max"] == 110][0]
    assert today["hr_min"] == 70 and today["hr_avg"] == 90 and today["bp"] == "125/82" and today["sleep_h"] == 7.5
    assert today["mood"] == "Low (AI check)" and today["pain_max"] == 8 and today["level"] == "YELLOW" and "Headache" in today["symptoms"]
    assert len(rows) == 2  # today and yesterday


def test_the_excel_file(client):
    login(client, SURGEON)
    res = client.get("/api/records/export.xlsx?categories=vitals,checkins,events,notes")
    assert res.status_code == 200 and "attachment; filename=crew-records_" in res.headers["Content-Disposition"]
    z = zipfile.ZipFile(io.BytesIO(res.data))
    sheets = re.findall(r'<sheet name="([^"]+)"', z.read("xl/workbook.xml").decode())
    assert sheets[:3] == ["Summary", "Daily", "Vitals"] and "Mood checks" in sheets and "Journal" in sheets
    strings = z.read("xl/sharedStrings.xml").decode()
    assert "125/82" in strings and "Saw the aurora" in strings and "Not medical advice" in strings
    vitals_xml = z.read(f"xl/worksheets/sheet{sheets.index('Vitals') + 1}.xml").decode()
    assert "<autoFilter" in vitals_xml and 'state="frozen"' in vitals_xml
    assert re.search(r'<c r="A2" s="\d+"><v>4\d{4}\.\d+</v>', vitals_xml)  # an Excel date-time serial, not text
