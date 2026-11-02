"""SQLite schema and connection helpers.

One file, data/astro.db. We open a fresh connection per request / per
background thread (sqlite3 connections are cheap), and serialize every write
through WRITE_LOCK so the serial-bridge thread, the scheduler thread and
Flask request threads never collide.
"""
import sqlite3
import threading
from contextlib import contextmanager

from backend.config import DATA_DIR, DB_PATH
import os

# RLock: a handler (e.g. a tag tap) may open its own write_conn() while
# already inside another one further up the call stack (e.g. an emergency
# tag during handle_scan's write_conn) -- a plain Lock would deadlock there.
WRITE_LOCK = threading.RLock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS astronauts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    color TEXT NOT NULL,
    baseline_reaction_ms INTEGER NOT NULL DEFAULT 350,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tags (
    uid TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    label TEXT NOT NULL,
    astronaut_id INTEGER,
    data_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY (astronaut_id) REFERENCES astronauts(id)
);

CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    astronaut_id INTEGER NOT NULL,
    ts TEXT NOT NULL,
    indicator TEXT NOT NULL,
    value_json TEXT NOT NULL,
    level TEXT NOT NULL,
    source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_readings_astro_ind ON readings(astronaut_id, indicator, ts);

CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    astronaut_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    data_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_activities_astro ON activities(astronaut_id, kind, started_at);

CREATE TABLE IF NOT EXISTS symptoms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    astronaut_id INTEGER NOT NULL,
    ts TEXT NOT NULL,
    items_json TEXT NOT NULL,
    level TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assessments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    astronaut_id INTEGER NOT NULL,
    ts TEXT NOT NULL,
    overall_level TEXT NOT NULL,
    note TEXT NOT NULL,
    details_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    astronaut_id INTEGER,
    ts TEXT NOT NULL,
    level TEXT NOT NULL,
    text TEXT NOT NULL,
    acknowledged INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_role TEXT NOT NULL,
    astronaut_id INTEGER,
    body TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    deliver_at TEXT NOT NULL,
    read INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    astronaut_id INTEGER NOT NULL,
    ts TEXT NOT NULL,
    amount INTEGER NOT NULL,
    reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS badges (
    astronaut_id INTEGER NOT NULL,
    badge_id TEXT NOT NULL,
    earned_at TEXT NOT NULL,
    PRIMARY KEY (astronaut_id, badge_id)
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def get_conn():
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    with WRITE_LOCK:
        conn = get_conn()
        try:
            conn.executescript(SCHEMA)
            conn.commit()
        finally:
            conn.close()


@contextmanager
def write_conn():
    """Use for any INSERT/UPDATE/DELETE: with db.write_conn() as conn: ..."""
    with WRITE_LOCK:
        conn = get_conn()
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()


def wipe_db():
    """Drops every table so seed.py can rebuild from scratch (Reset demo data)."""
    with WRITE_LOCK:
        conn = get_conn()
        try:
            conn.execute("PRAGMA foreign_keys = OFF")
            tables = [r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )]
            for t in tables:
                conn.execute(f"DROP TABLE IF EXISTS {t}")
            conn.commit()
        finally:
            conn.close()
