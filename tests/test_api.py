import argparse

import pytest

from backend import db, sessions
from backend.create_superuser import create_superuser


@pytest.fixture(scope="module")
def client(tmp_path_factory, monkeypatch_module):
    """One Flask app for this whole module, backed by its own throwaway
    SQLite file -- creating a fresh app (and its background threads) per
    test would be wasteful and risks cross-test thread interference."""
    db_path = str(tmp_path_factory.mktemp("api_test") / "test.db")
    monkeypatch_module.setattr(db, "DB_PATH", db_path)
    import app as app_module
    args = argparse.Namespace(port=None, simulate=True, wifi=False, wifi_host=None, wifi_port=None,
                               host="0.0.0.0", web_port=5000)
    flask_app, socketio, bridge = app_module.create_app(args)
    flask_app.config["TESTING"] = True
    return flask_app.test_client()


@pytest.fixture(scope="module")
def monkeypatch_module():
    from _pytest.monkeypatch import MonkeyPatch
    mp = MonkeyPatch()
    yield mp
    mp.undo()


AHMAD_UID = "9B:25:0F:54"
SAMEER_UID = "2B:ED:20:54"
SURGEON_UID = "D1000001"


def login_as(client, uid):
    """Logs this test client's session in as whichever astronaut `uid`'s
    NFC card belongs to -- the same thing tapping that card on the CYD
    does for a browser sitting on the login screen."""
    res = client.post("/api/auth/nfc_login", json={"uid": uid})
    assert res.status_code == 200
    return res.get_json()


def test_nfc_login_unassigned_card_is_rejected(client):
    res = client.post("/api/auth/nfc_login", json={"uid": "NOT-A-REAL-CARD"})
    assert res.status_code == 404
    assert client.get("/api/auth/me").get_json()["astronaut_id"] is None


def test_nfc_login_surgeon_card_logs_in_as_the_surgeon(client):
    me = login_as(client, SURGEON_UID)
    assert me["role"] == "Flight surgeon"
    assert client.get("/api/auth/me").get_json()["role"] == "Flight surgeon"


def test_logout_clears_the_session(client):
    login_as(client, AHMAD_UID)
    assert client.get("/api/auth/me").get_json()["astronaut_id"] is not None
    res = client.post("/api/auth/logout")
    assert res.status_code == 200
    assert client.get("/api/auth/me").get_json()["astronaut_id"] is None
    assert client.get("/api/astronauts/1/summary").status_code == 401


def test_logout_also_ends_an_open_cyd_session(client):
    login_as(client, AHMAD_UID)
    client.post("/api/simulate/scan", json={"uid": AHMAD_UID})  # opens a CYD session for Ahmad (id 1)
    assert 1 in sessions.active_sessions
    client.post("/api/auth/logout")
    assert 1 not in sessions.active_sessions


def test_logout_with_no_open_cyd_session_is_a_no_op(client):
    login_as(client, AHMAD_UID)
    assert 1 not in sessions.active_sessions
    res = client.post("/api/auth/logout")
    assert res.status_code == 200


def test_astronauts_list_has_seeded_crew(client):
    login_as(client, SURGEON_UID)
    res = client.get("/api/astronauts")
    assert res.status_code == 200
    names = {a["name"] for a in res.get_json()}
    assert "Ahmad" in names
    assert "Sameer" in names


def test_crew_endpoint_excludes_surgeon(client):
    login_as(client, SURGEON_UID)
    res = client.get("/api/crew")
    assert res.status_code == 200
    crew = res.get_json()
    assert len(crew) == 2
    assert all(a["role"] != "Flight surgeon" for a in crew)


def test_crew_data_is_private_to_its_own_astronaut(client):
    login_as(client, SAMEER_UID)
    res = client.get("/api/astronauts/1/summary")  # Ahmad's data, logged in as Sameer
    assert res.status_code == 403
    res = client.get("/api/crew")  # surgeon-only, logged in as a regular astronaut
    assert res.status_code == 403
    res = client.get("/api/astronauts/2/summary")  # Sameer viewing their own data: fine
    assert res.status_code == 200


def test_scan_starts_a_session_and_summary_reflects_it(client):
    login_as(client, SAMEER_UID)
    res = client.post("/api/simulate/scan", json={"uid": "2B:ED:20:54"})
    assert res.status_code == 200
    summary = client.get("/api/astronauts/2/summary").get_json()
    assert summary["astronaut"]["name"] == "Sameer"
    assert summary["session_active"] is True
    client.post("/api/simulate/scan", json={"uid": "2B:ED:20:54"})  # end it, so later tests start clean


def test_assess_computes_overall_level(client):
    login_as(client, AHMAD_UID)
    client.post("/api/simulate/scan", json={"uid": "9B:25:0F:54"})
    res = client.post("/api/astronauts/1/assess", json={"heart_rate": 72, "blood_pressure": {"systolic": 118, "diastolic": 76}})
    assert res.status_code == 200
    body = res.get_json()
    assert body["overall_level"] in ("GREEN", "YELLOW", "RED")
    assert "heart_rate" in body["details"]
    client.post("/api/simulate/scan", json={"uid": "9B:25:0F:54"})


def test_unknown_tag_is_reported(client):
    login_as(client, SURGEON_UID)
    res = client.post("/api/simulate/scan", json={"uid": "ZZZZZZZZ"})
    assert res.status_code == 200
    tags = client.get("/api/tags").get_json()
    assert all(t["uid"] != "ZZZZZZZZ" for t in tags)  # not auto-added; Admin assigns it


def test_tag_registry_crud(client):
    # Tag writes are superuser-only (docs/CLAUDE.md's "Superuser admin
    # page") -- a plain Flight-Surgeon session is no longer enough.
    create_superuser("tagtest-admin", "tagtest-password")
    res = client.post("/api/admin/login", json={"username": "tagtest-admin", "password": "tagtest-password"})
    assert res.status_code == 200
    res = client.post("/api/tags", json={"uid": "TESTTAG1", "type": "exercise", "label": "Test Rower"})
    assert res.status_code == 200
    tags = client.get("/api/tags").get_json()
    assert any(t["uid"] == "TESTTAG1" for t in tags)
    res = client.delete("/api/tags/TESTTAG1")
    assert res.status_code == 200
    tags = client.get("/api/tags").get_json()
    assert all(t["uid"] != "TESTTAG1" for t in tags)
    client.post("/api/admin/logout")


def test_emergency_start_and_cancel(client):
    res = client.post("/api/emergency", json={"text": "test emergency"})
    assert res.status_code == 200
    assert res.get_json()["active"] is True
    res = client.post("/api/emergency", json={"action": "cancel"})
    assert res.get_json()["active"] is False


def test_mission_profile_can_change(client):
    res = client.put("/api/mission", json={"profile_id": "station"})
    assert res.status_code == 200
    assert res.get_json()["profile_id"] == "station"
    res = client.get("/api/mission")
    assert res.get_json()["profile_id"] == "station"


def test_content_and_health_rules_and_routine_are_served(client):
    for path in ("/api/content", "/api/health-rules", "/api/routine"):
        res = client.get(path)
        assert res.status_code == 200
        assert isinstance(res.get_json(), dict)


def test_leaderboard_and_rewards(client):
    board = client.get("/api/leaderboard").get_json()
    assert len(board) == 2
    assert board[0]["points"] >= board[-1]["points"]
    login_as(client, AHMAD_UID)
    rewards = client.get("/api/rewards/1").get_json()
    assert "points" in rewards and "badge_catalog" in rewards


def test_export_csv(client):
    login_as(client, AHMAD_UID)
    res = client.get("/api/export/1.csv")
    assert res.status_code == 200
    assert res.mimetype == "text/csv"
    assert b"timestamp,indicator,value,level,source" in res.data


def test_symptoms_catalog_is_served(client):
    res = client.get("/api/symptoms/catalog")
    assert res.status_code == 200
    catalog = res.get_json()
    ids = {s["id"] for s in catalog}
    assert "headache" in ids and "chest_pain" in ids
    assert all({"id", "label", "guidance"} <= s.keys() for s in catalog)


def test_log_symptoms_round_trips_into_summary(client):
    login_as(client, AHMAD_UID)
    res = client.post("/api/astronauts/1/symptoms", json={"items": ["headache"]})
    assert res.status_code == 200
    assert res.get_json()["level"] == "YELLOW"
    summary = client.get("/api/astronauts/1/summary").get_json()
    assert summary["symptoms_today"]["items"] == ["headache"]
    assert summary["symptoms_today"]["level"] == "YELLOW"


def test_reset_demo_restores_seeded_crew(client):
    login_as(client, SURGEON_UID)
    client.delete("/api/tags/9B:25:0F:54")
    res = client.post("/api/reset-demo")
    assert res.status_code == 200
    names = {a["name"] for a in client.get("/api/astronauts").get_json()}
    assert "Ahmad" in names
    tags = {t["uid"] for t in client.get("/api/tags").get_json()}
    assert "9B:25:0F:54" in tags
