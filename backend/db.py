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
    created_at TEXT NOT NULL,
    username TEXT,
    password_hash TEXT,
    face_descriptor_json TEXT
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

CREATE TABLE IF NOT EXISTS discomfort (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    astronaut_id INTEGER NOT NULL,
    region TEXT NOT NULL,
    intensity INTEGER NOT NULL,
    ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_discomfort_astro_region ON discomfort(astronaut_id, region, ts);

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

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS superusers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS journal_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    astronaut_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (astronaut_id) REFERENCES astronauts(id)
);
CREATE INDEX IF NOT EXISTS idx_journal_astro ON journal_entries(astronaut_id, created_at);

-- One row per health analysis (backend/logic/analysis.py): the AI's verdict, or the
-- threshold rules' fallback when the AI couldn't be reached (source = 'ai' | 'rules').
CREATE TABLE IF NOT EXISTS analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    astronaut_id INTEGER NOT NULL,
    ts TEXT NOT NULL,
    source TEXT NOT NULL,
    model TEXT,
    trigger TEXT NOT NULL,
    state TEXT NOT NULL,
    overall_level TEXT NOT NULL,
    result_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analyses_astro ON analyses(astronaut_id, ts);

-- What Astra remembers about an astronaut (backend/logic/astra_memory.py): facts they told
-- her, and things she should ask about again later (follow_up_at, in real UTC time).
CREATE TABLE IF NOT EXISTS astra_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    astronaut_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    text TEXT NOT NULL,
    follow_up_at TEXT,
    followed_up INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'chat'
);
CREATE INDEX IF NOT EXISTS idx_memory_astro ON astra_memory(astronaut_id, created_at);

-- Voice tone ESTIMATES from "Wanna talk?" (backend/services/emotion.py): one row per spoken
-- phrase. Only the scores -- the audio itself is never stored. Kept apart from `readings`
-- on purpose: self-reported mood lives there, and this never feeds mood, levels, the health
-- analysis or alerts. talk_id groups the phrases of one conversation.
CREATE TABLE IF NOT EXISTS voice_tone (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    astronaut_id INTEGER NOT NULL,
    ts TEXT NOT NULL,
    talk_id TEXT NOT NULL,
    label TEXT NOT NULL,
    confidence REAL NOT NULL,
    scores_json TEXT NOT NULL,
    duration_s REAL NOT NULL,
    model TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_voice_tone_astro ON voice_tone(astronaut_id, ts);
CREATE INDEX IF NOT EXISTS idx_voice_tone_talk ON voice_tone(talk_id);

-- One row per "Wanna talk?" conversation (backend/logic/voice_talks.py). The server makes
-- the id; every voice_tone row of that conversation carries it as talk_id. result_json is
-- the conversation-level average of its phrases' seven probabilities (no audio, ever).
CREATE TABLE IF NOT EXISTS voice_talks (
    id TEXT PRIMARY KEY,
    astronaut_id INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL,
    status TEXT NOT NULL,
    phrases_sent INTEGER NOT NULL DEFAULT 0,
    phrases_analysed INTEGER NOT NULL DEFAULT 0,
    phrases_skipped INTEGER NOT NULL DEFAULT 0,
    phrases_failed INTEGER NOT NULL DEFAULT 0,
    result_json TEXT,
    finish_reason TEXT,
    kind TEXT NOT NULL DEFAULT 'talk'
);
CREATE INDEX IF NOT EXISTS idx_voice_talks_astro ON voice_talks(astronaut_id, ended_at);

-- Face Analysis reports (backend/services/face.py): one row per finished 10-15 s webcam
-- observation. Only the report (numbers + text) -- never images, video or landmarks.
CREATE TABLE IF NOT EXISTS face_analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    astronaut_id INTEGER NOT NULL,
    ts TEXT NOT NULL,
    duration_s REAL NOT NULL,
    frames INTEGER NOT NULL,
    usable_frames INTEGER NOT NULL,
    quality TEXT NOT NULL,
    report_json TEXT NOT NULL,
    model TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_face_analyses_astro ON face_analyses(astronaut_id, ts);

-- Pose Analysis reports (backend/services/pose.py): one row per finished ~12 s webcam
-- observation. Only the report (numbers + text) -- never images, video or landmarks.
CREATE TABLE IF NOT EXISTS pose_analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    astronaut_id INTEGER NOT NULL,
    ts TEXT NOT NULL,
    duration_s REAL NOT NULL,
    frames INTEGER NOT NULL,
    usable_frames INTEGER NOT NULL,
    quality TEXT NOT NULL,
    report_json TEXT NOT NULL,
    model TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pose_analyses_astro ON pose_analyses(astronaut_id, ts);
"""


def get_conn():
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _migrate_schema(conn):
    """CREATE TABLE IF NOT EXISTS (used throughout SCHEMA above) only helps a
    brand-new table -- it does nothing once astronauts already exists, so the
    three login-method columns added to astronauts above would never reach
    the user's real, already-populated table without this. First
    migration-style code in this file; keep it this same shape
    (PRAGMA table_info -> ALTER TABLE ADD COLUMN per missing column) if
    another column is ever added to an existing table later."""
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(astronauts)")}
    for col, decl in (("username", "TEXT"), ("password_hash", "TEXT"), ("face_descriptor_json", "TEXT")):
        if col not in cols:
            conn.execute(f"ALTER TABLE astronauts ADD COLUMN {col} {decl}")
    # voice_talks.kind (2026-11-14): "talk" = Wanna talk?, "mood_check" = the daily mood check
    talk_cols = {r["name"] for r in conn.execute("PRAGMA table_info(voice_talks)")}
    if talk_cols and "kind" not in talk_cols:
        conn.execute("ALTER TABLE voice_talks ADD COLUMN kind TEXT NOT NULL DEFAULT 'talk'")


def init_db():
    with WRITE_LOCK:
        conn = get_conn()
        try:
            conn.executescript(SCHEMA)
            _migrate_schema(conn)
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
    """Drops every table so seed.py can rebuild from scratch (Reset demo data)
    -- except `superusers`: that's an account system, not demo data, and
    wiping it would lock the superuser out of /admin until they re-ran the
    create_superuser CLI."""
    with WRITE_LOCK:
        conn = get_conn()
        try:
            conn.execute("PRAGMA foreign_keys = OFF")
            tables = [r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'superusers'"
            )]
            for t in tables:
                conn.execute(f"DROP TABLE IF EXISTS {t}")
            conn.commit()
        finally:
            conn.close()
