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
        "routine": _load("routine"),
        "gamification": _load("gamification"),
    }


def health_rules():
    return _load("health_rules")


def content():
    return _load("content")


def missions():
    return _load("missions")


def routine():
    return _load("routine")


def gamification():
    return _load("gamification")
