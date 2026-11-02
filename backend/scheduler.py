"""Fires the daily routine's reminders (config/routine.json), sped up by
TIME_SCALE for a live demo (docs/build-prompt.md sections 5 and 9.9).

The "day" is real time elapsed since the app started, compressed by
TIME_SCALE: at TIME_SCALE=60, a 24h schedule plays out in 24 real minutes.
Each entry fires once per simulated day it crosses.
"""
import time

from backend import protocol
from backend.config import routine as load_routine, TIME_SCALE

SECONDS_PER_DAY = 86400
_last_fired_cycle = {}


def _hhmm_to_seconds(hhmm):
    h, m = map(int, hhmm.split(":"))
    return h * 3600 + m * 60


def check_and_fire(start_time, send_fn, emit_fn):
    elapsed = (time.time() - start_time) * TIME_SCALE
    day_seconds = elapsed % SECONDS_PER_DAY
    cycle = int(elapsed // SECONDS_PER_DAY)
    for entry in load_routine()["schedule"]:
        target = _hhmm_to_seconds(entry["time"])
        if day_seconds >= target and _last_fired_cycle.get(entry["time"]) != cycle:
            _last_fired_cycle[entry["time"]] = cycle
            send_fn(protocol.reminder(entry["text"]))
            emit_fn("reminder", {"text": entry["text"], "kind": entry["kind"], "time": entry["time"]})
