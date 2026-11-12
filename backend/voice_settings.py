"""Station voice settings, chosen by a superuser on /admin and read by every chat page:
which engine speaks Astra's replies, which voice, how much echo, and the other station
effects (radio filter, Quindar beeps, cabin hum, speed, pitch).

Stored as one JSON value in the settings table (key "voice"). Reset demo data drops the
settings table, which simply brings these back to the defaults. An older saved value with
the single `fx` switch is converted (fx on = medium echo + beeps + hum, off = none).
"""
import json

from backend import db

ENGINES = ("browser", "neural")
# Microsoft neural voices (edge-tts), checked against edge_tts.list_voices() on 2026-11-12.
VOICES = {
    "en-US-AriaNeural": ("Aria · calm, American", "female"),
    "en-US-JennyNeural": ("Jenny · friendly, American", "female"),
    "en-US-AvaNeural": ("Ava · warm, American", "female"),
    "en-US-EmmaNeural": ("Emma · bright, American", "female"),
    "en-GB-SoniaNeural": ("Sonia · British", "female"),
    "en-GB-LibbyNeural": ("Libby · British", "female"),
    "en-AU-NatashaNeural": ("Natasha · Australian", "female"),
    "en-US-GuyNeural": ("Guy · calm, American", "male"),
    "en-US-AndrewNeural": ("Andrew · deep, American", "male"),
    "en-US-BrianNeural": ("Brian · relaxed, American", "male"),
    "en-US-ChristopherNeural": ("Christopher · steady, American", "male"),
    "en-GB-RyanNeural": ("Ryan · British", "male"),
    "en-GB-ThomasNeural": ("Thomas · British", "male"),
    "en-AU-WilliamMultilingualNeural": ("William · Australian", "male"),
}
GENDERS = ("female", "male")
ECHO_LEVELS = ("off", "light", "medium", "strong")
PITCHES = ("low", "normal", "high")
RATE_RANGE = (0.8, 1.3)
NOTICES = ("speak", "show", "off")  # Astra speaking first: out loud / card only / off
DEFAULTS = {
    "engine": "browser", "voice": "en-US-AriaNeural", "browser_gender": "female",
    "echo": "medium", "radio": False, "beeps": True, "hum": True, "rate": 1.0, "pitch": "normal",
    "notices": "speak",
}


def _upgrade(saved):
    """Older settings had one `fx` on/off for all the effects."""
    if "fx" in saved and "echo" not in saved:
        on = bool(saved["fx"])
        saved = {**saved, "echo": "medium" if on else "off", "beeps": on, "hum": on}
    return saved


def get():
    with db.write_conn() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = 'voice'").fetchone()
    out = dict(DEFAULTS)
    if row:
        try:
            saved = json.loads(row["value"])
            if isinstance(saved, dict):
                out.update({k: v for k, v in _upgrade(saved).items() if k in DEFAULTS})
        except json.JSONDecodeError:
            pass
    return out


def _is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def validate(body, base=None):
    """Returns (settings, None) or (None, error message). Missing keys keep their value
    (from `base`, or what's saved)."""
    if not isinstance(body, dict):
        return None, "expected a JSON object"
    merged = {**(base or get()), **{k: v for k, v in _upgrade(body).items() if k in DEFAULTS}}
    if merged["engine"] not in ENGINES:
        return None, "engine must be 'browser' or 'neural'"
    if merged["voice"] not in VOICES:
        return None, "unknown voice"
    if merged["browser_gender"] not in GENDERS:
        return None, "browser_gender must be 'female' or 'male'"
    if merged["echo"] not in ECHO_LEVELS:
        return None, "echo must be off, light, medium or strong"
    if merged["notices"] not in NOTICES:
        return None, "notices must be speak, show or off"
    if merged["pitch"] not in PITCHES:
        return None, "pitch must be low, normal or high"
    for k in ("radio", "beeps", "hum"):
        if not isinstance(merged[k], bool):
            return None, f"{k} must be true or false"
    if not _is_num(merged["rate"]) or not RATE_RANGE[0] <= merged["rate"] <= RATE_RANGE[1]:
        return None, f"rate must be between {RATE_RANGE[0]} and {RATE_RANGE[1]}"
    merged["rate"] = round(float(merged["rate"]), 2)
    return merged, None


def save(settings):
    with db.write_conn() as conn:
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('voice', ?)", (json.dumps(settings),))


def public():
    """What the chat pages and the admin card need: the settings plus the voice list."""
    return {
        **get(),
        "voices": [{"id": k, "label": label, "gender": g} for k, (label, g) in VOICES.items()],
    }
