"""Face ID v2: several enrollment samples, several sign-in frames, a vote with a margin.
Synthetic 128-number descriptors: one "person" is a random base vector, their frames are
that base plus a little noise (distance ~0.3), another person is another base (~1.6 away)."""
import argparse
import json
import random

import pytest

from backend import db
from backend.routes import routes

AHMAD, SAMEER = "9B:25:0F:54", "2B:ED:20:54"


def person(seed):
    rnd = random.Random(seed)
    return [rnd.gauss(0, 0.1) for _ in range(128)]


def frame(base, seed, noise=0.027):
    rnd = random.Random(seed)
    return [x + rnd.gauss(0, noise) for x in base]


A, B = person(1), person(2)


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    from _pytest.monkeypatch import MonkeyPatch
    mp = MonkeyPatch()
    mp.setattr(db, "DB_PATH", str(tmp_path_factory.mktemp("face_id") / "test.db"))
    import app as app_module
    args = argparse.Namespace(port=None, simulate=True, wifi=False, wifi_host=None, wifi_port=None,
                              host="0.0.0.0", web_port=5000)
    flask_app, _, _ = app_module.create_app(args)
    flask_app.config["TESTING"] = True
    yield flask_app.test_client()
    mp.undo()


def login(client, uid):
    assert client.post("/api/auth/nfc_login", json={"uid": uid}).status_code == 200


def test_distances_are_what_the_tests_assume():
    assert 0.2 < routes._face_distance(frame(A, 1), frame(A, 2)) < 0.5
    assert routes._face_distance(A, B) > 1.0


def test_enroll_several_samples_and_reject_bad_sets(client):
    login(client, AHMAD)
    url = "/api/astronauts/1/face_id"
    assert client.post(url, json={"descriptors": [frame(A, i) for i in range(2)]}).status_code == 400  # too few
    assert client.post(url, json={"descriptors": [frame(A, i) for i in range(5)] + [[1, 2]]}).status_code == 400  # a bad one
    mixed = [frame(A, i) for i in range(4)] + [frame(B, i) for i in range(4)]
    assert client.post(url, json={"descriptors": mixed}).status_code == 400  # two faces
    assert client.post(url, json={"descriptors": [frame(A, i) for i in range(8)]}).status_code == 200
    with db.write_conn() as conn:
        stored = json.loads(conn.execute("SELECT face_descriptor_json FROM astronauts WHERE id = 1").fetchone()[0])
    assert stored["v"] == 2 and len(stored["samples"]) == 8 and len(stored["mean"]) == 128


def test_sign_in_needs_two_agreeing_frames_and_rejects_someone_else(client):
    login(client, SAMEER)
    assert client.post("/api/astronauts/2/face_id", json={"descriptors": [frame(B, 100 + i) for i in range(8)]}).status_code == 200
    client.post("/api/auth/logout")
    ok = client.post("/api/auth/face_login", json={"descriptors": [frame(A, 50 + i) for i in range(3)]})
    assert ok.status_code == 200 and ok.get_json()["astronaut_id"] == 1
    client.post("/api/auth/logout")
    assert client.post("/api/auth/face_login", json={"descriptors": [frame(B, 60 + i) for i in range(3)]}).get_json()["astronaut_id"] == 2
    client.post("/api/auth/logout")
    stranger = person(3)
    assert client.post("/api/auth/face_login", json={"descriptors": [frame(stranger, i) for i in range(3)]}).status_code == 401
    # one good frame among strangers isn't enough
    one_good = [frame(A, 70), frame(stranger, 71), frame(stranger, 72)]
    assert client.post("/api/auth/face_login", json={"descriptors": one_good}).status_code == 401
    assert client.post("/api/auth/face_login", json={"descriptors": [[0] * 5]}).status_code == 400


def test_a_frame_halfway_between_two_people_never_counts():
    rows = [({"id": 1}, [A]), ({"id": 2}, [B])]
    mid = [(a + b) / 2 for a, b in zip(A, B)]
    assert routes._match_face_frames([mid, mid, mid], rows) is None
    assert routes._match_face_frames([frame(A, 1), frame(A, 2)], rows)["id"] == 1


def test_old_single_snapshot_rows_and_logins_still_work():
    assert routes._face_samples(json.dumps(A)) == [A]
    assert routes._face_samples("not json") == []
    rows = [({"id": 1}, routes._face_samples(json.dumps(A)))]
    assert routes._match_face_frames([frame(A, 5), frame(A, 6)], rows)["id"] == 1
