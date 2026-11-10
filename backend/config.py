"""Loads config/*.json and a few environment-driven settings.

Every value in config/ is PLACEHOLDER demo data (see docs/build-prompt.md section 7).
"""
import json
import os

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_DIR = os.path.join(BASE_DIR, "config")
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "astro.db")

# Speeds up reminders, comms delay and sleep durations for a live demo.
# 1 = real time. 60 = one simulated hour passes per real minute.
TIME_SCALE = float(os.environ.get("ASTRO_TIME_SCALE", "60"))

NVIDIA_API_KEY_PATH = os.path.join(DATA_DIR, "nvidia_api_key")
# Consultation chat's multi-turn memory: generous-but-bounded, not a cost-
# optimization problem for a demo -- see docs/CLAUDE.md.
MAX_CONSULT_HISTORY_TURNS = 10
MAX_CONSULT_HISTORY_MSG_CHARS = 500


def nvidia_api_key():
    """env var wins (for anyone who prefers that), else the local gitignored
    file, else None -- no key means backend/services/consult.py's AI consultation
    feature is simply unavailable and the Body tab falls back to its own
    keyword-matching reply."""
    env_key = os.environ.get("NVIDIA_API_KEY")
    if env_key:
        return env_key.strip()
    if os.path.exists(NVIDIA_API_KEY_PATH):
        with open(NVIDIA_API_KEY_PATH, "r", encoding="utf-8") as f:
            key = f.read().strip()
        return key or None
    return None


def _load(name):
    path = os.path.join(CONFIG_DIR, f"{name}.json")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def load_all():
    """Returns a dict of all five config files, re-read fresh each call so
    editing a JSON file on disk takes effect without restarting the app."""
    return {
        "health_rules": _load("health_rules"),
        "content": _load("content"),
        "missions": _load("missions"),
        "mission_health": _load("mission_health"),
        "routine": _load("routine"),
        "gamification": _load("gamification"),
        "symptoms": _load("symptoms"),
    }


def health_rules():
    return _load("health_rules")


def content():
    return _load("content")


def missions():
    return _load("missions")


def mission_health():
    return _load("mission_health")


def routine():
    return _load("routine")


def gamification():
    return _load("gamification")


def symptoms():
    return _load("symptoms")
