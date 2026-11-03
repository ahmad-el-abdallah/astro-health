import json
from datetime import datetime, timezone

import pytest

from backend import db, sessions


@pytest.fixture(autouse=True)
def reset_sessions_state():
    sessions.active_sessions.clear()
    sessions.open_toggles.clear()
    sessions.surgeon_unlocked_until = 0.0
    sessions.emergency["active"] = False
    sessions.emergency["text"] = ""
    sessions.unknown_tag_backlog.clear()
    yield


@pytest.fixture()
def fresh_db(tmp_path, monkeypatch):
    """Points backend.db at a throwaway SQLite file and builds the schema,
    so tests never touch the real data/astro.db."""
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "test.db"))
    db.init_db()
    yield db


def seed_minimal(conn):
    """A tiny fixture crew + a few tags, enough to exercise sessions.py
    without pulling in the full 30-day backstory from seed.py."""
    now = datetime.now(timezone.utc).isoformat()
    cur = conn.execute(
        "INSERT INTO astronauts (name, role, color, baseline_reaction_ms, created_at) VALUES (?, ?, ?, ?, ?)",
        ("Test Astro", "Commander", "#ffffff", 340, now),
    )
    astro_id = cur.lastrowid
    conn.execute("INSERT INTO tags (uid, type, label, astronaut_id, data_json) VALUES (?, 'astronaut', 'Test Astro', ?, '{}')",
                 ("A0000001", astro_id))
    conn.execute("INSERT INTO tags (uid, type, label, astronaut_id, data_json) VALUES ('T2000001', 'exercise', 'Treadmill', NULL, '{}')")
    conn.execute("INSERT INTO tags (uid, type, label, astronaut_id, data_json) VALUES ('T4000001', 'meal', 'Food packet', NULL, ?)",
                 (json.dumps({"kcal": 300}),))
    conn.execute("INSERT INTO tags (uid, type, label, astronaut_id, data_json) VALUES ('E9000001', 'emergency', 'Emergency card', NULL, '{}')")
    conn.execute("INSERT INTO tags (uid, type, label, astronaut_id, data_json) VALUES ('D1000001', 'surgeon', 'Dr Test', NULL, '{}')")
    return astro_id
