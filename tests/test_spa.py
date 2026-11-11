"""Flask serving the React build (frontend/dist): deep links must load the app,
real build files must be served as-is, and /api/* must never be swallowed by it."""
import argparse

import pytest

from backend import config, db


@pytest.fixture(scope="module")
def app_and_dist(tmp_path_factory, monkeypatch_module):
    monkeypatch_module.setattr(db, "DB_PATH", str(tmp_path_factory.mktemp("spa") / "test.db"))
    dist = tmp_path_factory.mktemp("dist")
    (dist / "index.html").write_text("<!doctype html><div id='root'></div>", encoding="utf-8")
    (dist / "assets").mkdir()
    (dist / "assets" / "app.js").write_text("console.log('app')", encoding="utf-8")
    monkeypatch_module.setattr(config, "FRONTEND_DIST", str(dist))
    import app as app_module
    args = argparse.Namespace(port=None, simulate=True, wifi=False, wifi_host=None, wifi_port=None,
                              host="0.0.0.0", web_port=5000)
    flask_app, _socketio, _bridge = app_module.create_app(args)
    flask_app.config["TESTING"] = True
    return flask_app.test_client(), dist


@pytest.fixture(scope="module")
def monkeypatch_module():
    from _pytest.monkeypatch import MonkeyPatch
    mp = MonkeyPatch()
    yield mp
    mp.undo()


@pytest.mark.parametrize("path", ["/", "/body", "/doctor/alerts", "/doctor/crew/2", "/admin", "/crew/overview"])
def test_deep_links_serve_the_app(app_and_dist, path):
    client, _ = app_and_dist
    res = client.get(path)
    assert res.status_code == 200
    assert b"id='root'" in res.data


def test_real_build_files_are_served_as_is(app_and_dist):
    client, _ = app_and_dist
    res = client.get("/assets/app.js")
    assert res.status_code == 200
    assert b"console.log('app')" in res.data


def test_unknown_api_path_is_a_json_404_not_the_app(app_and_dist):
    client, _ = app_and_dist
    res = client.get("/api/definitely-not-a-route")
    assert res.status_code == 404
    assert res.get_json() == {"error": "not found"}


def test_real_api_routes_still_win(app_and_dist):
    client, _ = app_and_dist
    res = client.get("/api/auth/me")
    assert res.status_code == 200
    assert "astronaut_id" in res.get_json()


def test_missing_build_says_how_to_build_it(app_and_dist, monkeypatch, tmp_path):
    client, _ = app_and_dist
    monkeypatch.setattr(config, "FRONTEND_DIST", str(tmp_path / "nothing-here"))
    res = client.get("/body")
    assert res.status_code == 503
    assert b"npm run build" in res.data


def test_old_vanilla_app_is_gone(app_and_dist):
    # /legacy and /static used to serve the pre-React app; now they're just SPA paths.
    client, _ = app_and_dist
    for path in ("/legacy", "/static/js/core/main.js"):
        res = client.get(path)
        assert res.status_code == 200 and b"id='root'" in res.data
