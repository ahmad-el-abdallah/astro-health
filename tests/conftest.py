import json
import os
from datetime import datetime, timezone

import pytest

from backend import config, db
from backend.logic import analysis, sensor_feed, sessions
from backend.services import analyst

# Test apps never start the Pico NFC reader thread (see app.py): it would outlive its test,
# could open the real reader plugged into a dev laptop, and races test_pico_bridge.py.
os.environ["ASTRO_NO_PICO"] = "1"
# ...nor load the optional voice tone model (~1 GB RAM, seconds per test app): tests use a
# fake predictor (test_emotion.py), and the real-model test loads it itself.
os.environ["ASTRO_NO_EMOTION"] = "1"
# ...nor check for the optional face analysis stack; test_face_api.py turns it on itself.
os.environ["ASTRO_NO_FACE"] = "1"
# ...nor for the optional pose analysis stack; test_pose_analysis.py turns it on itself.
os.environ["ASTRO_NO_POSE"] = "1"


@pytest.fixture(autouse=True)
def reset_sessions_state():
    sessions.active_sessions.clear()
    sessions.open_toggles.clear()
    sessions.surgeon_unlocked_until = 0.0
    sessions.emergency["active"] = False
    sessions.emergency["text"] = ""
    sessions.unknown_tag_backlog.clear()
    sessions.current_scan_mode = "cyd"
    sessions.last_scan.clear()
    yield


ANALYSIS_TEST_MODULES = {"test_api", "test_analysis"}


@pytest.fixture(autouse=True)
def no_real_ai(monkeypatch, request):
    """Tests never call a real AI: no key (even if data/ai_api_key exists on this
    machine), so every analysis uses the rules fallback unless a test mocks the AI.
    Analysis runs right away instead of after the demo's debounce. Outside the modules
    that test it, queuing an analysis is a no-op, so the background worker can never
    write into another test's database."""
    monkeypatch.setattr(config, "ai_api_key", lambda: None)
    monkeypatch.setattr(config, "AI_MODEL", "test/main-model")  # fixed models, whatever the env says
    monkeypatch.setattr(config, "AI_FALLBACK_MODELS", ["test/fallback-model"])
    monkeypatch.setattr(analyst, "_model_backoff", {})
    monkeypatch.setattr(analyst, "_last_model", None)
    monkeypatch.setattr(analysis, "DEBOUNCE_S", 0)
    monkeypatch.setattr(analysis, "MIN_INTERVAL_S", 0)
    if request.module.__name__.split(".")[-1] not in ANALYSIS_TEST_MODULES:
        monkeypatch.setattr(analysis, "request", lambda *a, **k: None)
    analysis.reset()
    sensor_feed.reset()  # every live wearable off
    yield
    if analysis._worker_started:
        analysis.wait_idle(5)
    analysis.reset()


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
