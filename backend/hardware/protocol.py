"""The serial protocol between the CYD and the laptop: one JSON object per
line (see docs/build-prompt.md section 6). Kept in this one module (and
mirrored in firmware/astro_cyd/protocol.ino) so both sides agree on the
message shapes.
"""
import json

MAX_LINE_BYTES = 512
LEVELS = {"GREEN", "YELLOW", "RED"}

# Messages the CYD sends to the laptop.
CYD_TO_LAPTOP_TYPES = {
    "hello", "scan", "mood", "symptoms", "reaction", "breathing_done",
    "emergency", "cancel_emergency", "end_session", "pong", "log",
}
# Messages the laptop sends to the CYD.
LAPTOP_TO_CYD_TYPES = {
    "session", "status", "toast", "unknown_tag", "exercise", "sleep",
    "reminder", "alert", "emergency", "led", "idle", "ping",
}


def decode(line):
    """Parses one line from the CYD into a dict, or None if it isn't a
    valid JSON object with a "type" field (the firmware may print plain
    debug text on the same serial port -- that's expected, just ignore it).
    """
    line = line.strip()
    if not line:
        return None
    try:
        msg = json.loads(line)
    except ValueError:
        return None
    if not isinstance(msg, dict) or not isinstance(msg.get("type"), str):
        return None
    return msg


def encode(msg_type, **fields):
    """Builds one outgoing line (laptop -> CYD), ending with a newline.
    Raises ValueError if it wouldn't fit the firmware's line buffer.
    """
    msg = {"type": msg_type}
    msg.update(fields)
    line = json.dumps(msg, separators=(",", ":")) + "\n"
    if len(line.encode("utf-8")) > MAX_LINE_BYTES:
        raise ValueError(f"protocol message too long for the CYD buffer: {len(line)} bytes")
    return line


# ---- convenience builders for each laptop -> CYD message type ----

def session(name, uid, level, points):
    return encode("session", name=name, uid=uid, level=level, points=points)


def status(name, level, note):
    return encode("status", name=name, level=level, note=note)


def toast(text, level="GREEN"):
    return encode("toast", text=text, level=level)


def unknown_tag(uid):
    return encode("unknown_tag", uid=uid)


def exercise(event, minutes=0):
    return encode("exercise", event=event, minutes=minutes)


def sleep(event, hours=0):
    return encode("sleep", event=event, hours=hours)


def reminder(text):
    return encode("reminder", text=text)


def alert(level, text):
    return encode("alert", level=level, text=text)


def emergency(active, text=""):
    return encode("emergency", active=active, text=text)


def led(color):
    return encode("led", color=color)


def idle():
    return encode("idle")


def ping():
    return encode("ping")
