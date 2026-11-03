import json

from backend import db, symptoms
from tests.conftest import seed_minimal


def test_catalog_has_the_eight_firmware_symptoms():
    ids = {s["id"] for s in symptoms.catalog()}
    assert ids == {
        "headache", "nausea", "back_pain", "blurry_vision",
        "congestion", "fatigue", "chest_pain", "shortness_of_breath",
    }
    for s in symptoms.catalog():
        assert s["label"]
        assert s["guidance"]


def test_record_inserts_symptom_and_awards_points(fresh_db):
    with db.write_conn() as conn:
        astro_id = seed_minimal(conn)
        lvl = symptoms.record(conn, astro_id, ["headache"])
    assert lvl == "YELLOW"
    with db.write_conn() as conn:
        row = conn.execute("SELECT items_json, level FROM symptoms WHERE astronaut_id = ?", (astro_id,)).fetchone()
        points = conn.execute("SELECT amount, reason FROM points WHERE astronaut_id = ?", (astro_id,)).fetchone()
    assert json.loads(row["items_json"]) == ["headache"]
    assert row["level"] == "YELLOW"
    assert points["reason"] == "symptom_report"


def test_record_red_symptom_level(fresh_db):
    with db.write_conn() as conn:
        astro_id = seed_minimal(conn)
        lvl = symptoms.record(conn, astro_id, ["chest_pain"])
    assert lvl == "RED"


def test_alert_if_red_queues_report_and_emits(fresh_db):
    emitted = []
    with db.write_conn() as conn:
        astro_id = seed_minimal(conn)
    symptoms.alert_if_red(astro_id, ["chest_pain"], "RED", lambda event, data: emitted.append((event, data)))
    with db.write_conn() as conn:
        msg = conn.execute("SELECT body FROM messages WHERE astronaut_id = ?", (astro_id,)).fetchone()
    assert "chest_pain" in msg["body"]
    assert emitted == [("alert", {"astronaut_id": astro_id, "level": "RED", "text": "Red-flag symptom reported"})]


def test_alert_if_red_does_nothing_for_non_red(fresh_db):
    emitted = []
    with db.write_conn() as conn:
        astro_id = seed_minimal(conn)
    symptoms.alert_if_red(astro_id, ["headache"], "YELLOW", lambda event, data: emitted.append((event, data)))
    with db.write_conn() as conn:
        msg = conn.execute("SELECT body FROM messages WHERE astronaut_id = ?", (astro_id,)).fetchone()
    assert msg is None
    assert emitted == []
