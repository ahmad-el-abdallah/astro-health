import argparse

import pytest
from werkzeug.security import check_password_hash

from backend import db, sessions
from backend.create_superuser import create_superuser


@pytest.fixture(scope="module")
def client(tmp_path_factory, monkeypatch_module):
    """Same pattern as tests/test_api.py's client fixture -- its own app and
    throwaway SQLite file, module-scoped since creating a fresh app per test
    would be wasteful."""
    db_path = str(tmp_path_factory.mktemp("admin_auth_test") / "test.db")
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
SURGEON_UID = "D1000001"
SU_USERNAME = "boss"
SU_PASSWORD = "correct horse battery staple"


def login_as(client, uid):
    res = client.post("/api/auth/nfc_login", json={"uid": uid})
    assert res.status_code == 200
    return res.get_json()


def login_admin(client, username=SU_USERNAME, password=SU_PASSWORD):
    return client.post("/api/admin/login", json={"username": username, "password": password})


def test_create_superuser_cli_helper_inserts_a_working_row(client):
    create_superuser(SU_USERNAME, SU_PASSWORD)
    with db.write_conn() as conn:
        row = conn.execute("SELECT * FROM superusers WHERE username = ?", (SU_USERNAME,)).fetchone()
    assert row is not None
    assert row["password_hash"] != SU_PASSWORD
    assert check_password_hash(row["password_hash"], SU_PASSWORD)


def test_admin_login_rejects_unknown_username(client):
    res = login_admin(client, username="nobody")
    assert res.status_code == 401
    assert client.get("/api/admin/me").get_json()["username"] is None


def test_admin_login_rejects_wrong_password(client):
    res = login_admin(client, password="wrong")
    assert res.status_code == 401
    assert client.get("/api/admin/me").get_json()["username"] is None


def test_admin_login_success_and_me(client):
    res = login_admin(client)
    assert res.status_code == 200
    assert res.get_json()["username"] == SU_USERNAME
    assert client.get("/api/admin/me").get_json()["username"] == SU_USERNAME
    client.post("/api/admin/logout")


def test_admin_logout_clears_only_the_admin_session(client):
    login_admin(client)
    login_as(client, AHMAD_UID)
    client.post("/api/admin/logout")
    assert client.get("/api/admin/me").get_json()["username"] is None
    assert client.get("/api/auth/me").get_json()["astronaut_id"] is not None
    client.post("/api/auth/logout")


def test_admin_session_and_astronaut_session_coexist_independently(client):
    login_admin(client)
    login_as(client, AHMAD_UID)
    assert client.get("/api/admin/me").get_json()["username"] == SU_USERNAME
    assert client.get("/api/auth/me").get_json()["astronaut_id"] is not None
    client.post("/api/auth/logout")
    assert client.get("/api/admin/me").get_json()["username"] == SU_USERNAME
    assert client.get("/api/auth/me").get_json()["astronaut_id"] is None
    client.post("/api/admin/logout")


def test_tag_write_routes_reject_a_plain_surgeon_session(client):
    login_as(client, SURGEON_UID)
    assert client.post("/api/tags", json={"uid": "X1", "type": "meal", "label": "x"}).status_code == 401
    assert client.delete("/api/tags/X1").status_code == 401
    client.post("/api/auth/logout")


def test_tag_write_routes_accept_a_superuser_session(client):
    login_admin(client)
    res = client.post("/api/tags", json={"uid": "X1", "type": "meal", "label": "Food packet"})
    assert res.status_code == 200
    uids = [t["uid"] for t in client.get("/api/tags").get_json()]
    assert "X1" in uids
    assert client.delete("/api/tags/X1").status_code == 200
    client.post("/api/admin/logout")


def test_create_astronaut_requires_superuser_and_validates_role(client):
    assert client.post("/api/astronauts", json={"name": "Priya", "role": "Crew member"}).status_code == 401
    login_admin(client)
    assert client.post("/api/astronauts", json={"name": "Priya", "role": "Not a role"}).status_code == 400
    res = client.post("/api/astronauts", json={"name": "Priya", "role": "Crew member"})
    assert res.status_code == 201
    body = res.get_json()
    assert body["name"] == "Priya"
    assert body["role"] == "Crew member"
    client.post("/api/admin/logout")


def test_update_astronaut_role_requires_superuser_and_validates_role(client):
    login_admin(client)
    created = client.post("/api/astronauts", json={"name": "Jun", "role": "Crew member"}).get_json()
    client.post("/api/admin/logout")

    assert client.put(f"/api/astronauts/{created['id']}/role", json={"role": "Flight surgeon"}).status_code == 401
    login_admin(client)
    assert client.put(f"/api/astronauts/{created['id']}/role", json={"role": "Not a role"}).status_code == 400
    res = client.put(f"/api/astronauts/{created['id']}/role", json={"role": "Flight surgeon"})
    assert res.status_code == 200
    assert res.get_json()["role"] == "Flight surgeon"
    client.post("/api/admin/logout")


def test_unknown_tag_backlog_populated_by_handle_scan_and_readable_via_admin_route(client):
    sessions.unknown_tag_backlog.clear()
    client.post("/api/simulate/scan", json={"uid": "GHOST-CARD"})
    login_admin(client)
    backlog = client.get("/api/admin/unknown-tags").get_json()
    entry = next(e for e in backlog if e["uid"] == "GHOST-CARD")
    assert entry["count"] == 1

    client.post("/api/admin/logout")
    client.post("/api/simulate/scan", json={"uid": "GHOST-CARD"})
    login_admin(client)
    backlog = client.get("/api/admin/unknown-tags").get_json()
    entry = next(e for e in backlog if e["uid"] == "GHOST-CARD")
    assert entry["count"] == 2

    assert client.delete("/api/admin/unknown-tags/GHOST-CARD").status_code == 200
    backlog = client.get("/api/admin/unknown-tags").get_json()
    assert not any(e["uid"] == "GHOST-CARD" for e in backlog)
    client.post("/api/admin/logout")


def test_reset_demo_does_not_delete_superuser_accounts(client):
    login_as(client, SURGEON_UID)
    res = client.post("/api/reset-demo")
    assert res.status_code == 200
    client.post("/api/auth/logout")
    assert login_admin(client).status_code == 200
    client.post("/api/admin/logout")
