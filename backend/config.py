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

# How long a CYD session stays open with nobody touching the CYD (real seconds). The
# laptop sends this to the CYD with every session, so changing it never needs a reflash.
SESSION_IDLE_S = int(os.environ.get("ASTRO_SESSION_IDLE_S", "600"))

# The React frontend's built output (frontend/, `npm run build`). Committed to git so a
# laptop without Node can still just `python app.py` -- see docs/CLAUDE.md.
FRONTEND_DIST = os.environ.get("ASTRO_FRONTEND_DIST", os.path.join(BASE_DIR, "frontend", "dist"))

# AI health analyst (backend/services/analyst.py). Any OpenAI-compatible chat API works;
# the default is Groq's free plan. Switch provider by changing these three -- e.g.
# Hugging Face: AI_BASE_URL=https://router.huggingface.co/v1 plus an hf_ token.
AI_BASE_URL = os.environ.get("AI_BASE_URL", "https://api.groq.com/openai/v1").rstrip("/")
AI_MODEL = os.environ.get("AI_MODEL", "openai/gpt-oss-120b")
# Tried in order when AI_MODEL is rate-limited. On Groq's free plan every model has its OWN
# daily allowance (200K tokens/day for gpt-oss-120b, about 65 Astra chat turns), so when the
# main model's day is used up Astra keeps answering with these instead of going quiet.
_GROQ_FALLBACKS = "openai/gpt-oss-20b,qwen/qwen3.8-27b" if "api.groq.com" in AI_BASE_URL else ""
AI_FALLBACK_MODELS = [m.strip() for m in os.environ.get("AI_FALLBACK_MODELS", _GROQ_FALLBACKS).split(",")
                      if m.strip() and m.strip() != AI_MODEL]
AI_API_KEY_PATH = os.path.join(DATA_DIR, "ai_api_key")


def ai_api_key():
    """AI_API_KEY env var, else the gitignored data/ai_api_key file, else None.
    No key just means the AI analyst is unavailable and the rules decide instead."""
    env_key = os.environ.get("AI_API_KEY")
    if env_key and env_key.strip():
        return env_key.strip()
    if os.path.exists(AI_API_KEY_PATH):
        with open(AI_API_KEY_PATH, "r", encoding="utf-8") as f:
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
        "symptoms": _load("symptoms"),
        "ai_analyst": _load("ai_analyst"),
        "exercises": _load("exercises"),
    }


def health_rules():
    return _load("health_rules")


def content():
    return _load("content")


def missions():
    return _load("missions")


def mission_health():
    return _load("mission_health")


def exercises():
    return _load("exercises")


def routine():
    return _load("routine")


def symptoms():
    return _load("symptoms")


def ai_analyst():
    return _load("ai_analyst")


def mood_questions():
    return _load("mood_questions")
