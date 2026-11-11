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
    "emergency", "cancel_emergency", "end_session", "pong", "log", "active",
    # Flight Surgeon on-device screens (phase 2 of the CYD redesign):
    "view_crew", "ack_alert", "quick_reply",
}
# Messages the laptop sends to the CYD.
LAPTOP_TO_CYD_TYPES = {
    "session", "status", "toast", "unknown_tag", "exercise", "sleep",
    "reminder", "alert", "emergency", "led", "idle", "ping",
    "crew_list", "alerts_list", "inbox_list", "crew_detail",
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

def session(name, uid, level, idle_s=None, role=None, today=None):
    """idle_s: how long the CYD keeps this session open untouched. role: the
    astronaut's role string, for the CYD header's role dot. today: a
    compact {indicator: {"v": display string, "l": level}} snapshot for the
    crew-home vitals tiles (backend/logic/sessions.py's
    _today_vitals_for_cyd()). All three are optional and additive --
    firmware from before 2026-11-11 simply ignores fields it doesn't know."""
    fields = {"name": name, "uid": uid, "level": level}
    if idle_s is not None:
        fields["idle_s"] = int(idle_s)
    if role is not None:
        fields["role"] = role
    if today is not None:
        fields["today"] = today
    return encode("session", **fields)


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


# ---- Flight Surgeon on-device screens (phase 2 of the CYD redesign) ----
# items/vitals shapes match backend/logic/sessions.py's crew_list_for_cyd()/
# alerts_list_for_cyd()/inbox_for_cyd()/crew_detail_for_cyd() exactly -- this
# module only wraps them in a {"type":...} envelope, it never builds them.

def crew_list(items):
    return encode("crew_list", items=items)


def alerts_list(items):
    return encode("alerts_list", items=items)


def inbox_list(items):
    return encode("inbox_list", items=items)


def crew_detail(detail):
    return encode("crew_detail", **detail)
