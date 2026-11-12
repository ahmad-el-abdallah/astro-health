"""Station voice settings, chosen by a superuser on /admin and read by every chat page:
which engine speaks Doctor AI's replies, which neural voice, and whether the station
effects (Quindar beeps, cabin hum, and -- neural only -- reverb/echo) are on.

Stored as one JSON value in the settings table (key "voice"). Reset demo data drops the
settings table, which simply brings these back to the defaults.
"""
import json

from backend import db

ENGINES = ("browser", "neural")
VOICES = {
    "en-US-AriaNeural": "Aria · calm female, American",
    "en-US-JennyNeural": "Jenny · friendly female, American",
    "en-US-GuyNeural": "Guy · calm male, American",
    "en-GB-SoniaNeural": "Sonia · female, British",
    "en-GB-RyanNeural": "Ryan · male, British",
}
DEFAULTS = {"engine": "browser", "voice": "en-US-AriaNeural", "fx": True}


def get():
    with db.write_conn() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = 'voice'").fetchone()
    out = dict(DEFAULTS)
    if row:
        try:
            saved = json.loads(row["value"])
            if isinstance(saved, dict):
                out.update({k: v for k, v in saved.items() if k in DEFAULTS})
        except json.JSONDecodeError:
            pass
    return out


def validate(body):
    """Returns (settings, None) or (None, error message). Missing keys keep their value."""
    if not isinstance(body, dict):
        return None, "expected a JSON object"
    merged = {**get(), **{k: v for k, v in body.items() if k in DEFAULTS}}
    if merged["engine"] not in ENGINES:
        return None, "engine must be 'browser' or 'neural'"
    if merged["voice"] not in VOICES:
        return None, "unknown voice"
    if not isinstance(merged["fx"], bool):
        return None, "fx must be true or false"
    return merged, None


def save(settings):
    with db.write_conn() as conn:
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('voice', ?)", (json.dumps(settings),))


def public():
    """What the chat pages need: the settings plus the voice list (for the admin card)."""
    return {**get(), "voices": [{"id": k, "label": v} for k, v in VOICES.items()]}
