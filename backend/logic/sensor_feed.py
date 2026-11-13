"""The live wearable: replays a real recorded crew session (backend/sensor/crew13.json, built
by backend/sensor/build.py from NASA's crew-state physiology study) as if the astronaut were
wearing a chest strap right now.

While an astronaut's monitor is on:
  * every second a Socket.IO "sensor" event goes to every browser: heart rate, breathing
    rate, stress (0-100) and the event flag for that second, plus one second of the ECG
    trace for the moving line;
  * every SAVE_EVERY_S it saves the last minute's averages as normal readings
    (heart_rate / respiration_rate / stress, source 'wearable'), so tiles, Trends, the doctor
    feed and the AI all see them;
  * the AI health analysis is asked for only when one of those levels CHANGES -- a reading
    a minute must not drain the free AI plan.

In memory, like sessions.active_sessions: a server restart turns every monitor off.
The recording loops when it reaches its end.
"""
import json
import os
import threading
import time
from datetime import datetime, timezone

from backend import db
from backend.logic import health_rules

DATA_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "sensor", "crew13.json")
SAVE_EVERY_S = 60
INDICATORS = ("heart_rate", "respiration_rate", "stress")

_lock = threading.Lock()
_feeds = {}      # astro_id -> {"segment", "started", "last_sent", "last_save", "levels"}
_data = None
_worker_started = False


def _load():
    global _data
    if _data is None:
        with open(DATA_FILE) as f:
            raw = json.load(f)
        raw["by_id"] = {s["id"]: s for s in raw["segments"]}
        _data = raw
    return _data


def segments():
    d = _load()
    return [{"id": s["id"], "label": s["label"], "about": s["about"], "seconds": s["seconds"]} for s in d["segments"]]


def source():
    return _load()["source"]


def _second(feed, now):
    seg = _load()["by_id"][feed["segment"]]
    return int(now - feed["started"]) % seg["seconds"], seg


def _sample(seg, s):
    return {"hr": seg["hr"][s], "br": seg["br"][s], "stress": seg["stress"][s], "event": seg["event"][s]}


def start(astro_id, segment, now=None):
    if segment not in _load()["by_id"]:
        raise ValueError(f"unknown segment: {segment}")
    now = time.time() if now is None else now
    with _lock:
        _feeds[astro_id] = {"segment": segment, "started": now, "last_sent": None, "last_save": now, "levels": {}}
    return status(astro_id, now)


def stop(astro_id):
    with _lock:
        return _feeds.pop(astro_id, None) is not None


def status(astro_id, now=None):
    """None when the monitor is off, else what it's playing and the current second."""
    with _lock:
        feed = dict(_feeds[astro_id]) if astro_id in _feeds else None
    if not feed:
        return None
    now = time.time() if now is None else now
    s, seg = _second(feed, now)
    return {"on": True, "segment": seg["id"], "label": seg["label"], "about": seg["about"],
            "second": s, "seconds": seg["seconds"], "started_at": feed["started"], "source": source(),
            **_sample(seg, s)}


def context_line(astro_id, now=None):
    """One line for the AI's context while the monitor is on (analysis.build_context)."""
    st = status(astro_id, now)
    if not st:
        return None
    seg = _load()["by_id"][st["segment"]]
    recent = range(max(0, st["second"] - 20), st["second"] + 1)
    startle = any(seg["event"][i] for i in recent) and st["segment"] == "startle"
    return (f"Live wearable ON (a real recorded crew session replayed: {st['label'].lower()}, "
            f"{st['about']}): heart rate {st['hr']} bpm, breathing {st['br']}/min, stress {st['stress']}/100 "
            "(skin-conductance arousal, relative, not medical)"
            + ("; a startle/surprise event happened in the last 20 s -- a short spike is normal." if startle else "."))


def _minute_averages(feed, seg, now):
    """Averages over the seconds played since the last save (at most a minute)."""
    span = max(1, min(SAVE_EVERY_S, int(now - feed["last_save"])))
    end = int(now - feed["started"])
    idx = [(end - k) % seg["seconds"] for k in range(span)]
    avg = lambda key: round(sum(seg[key][i] for i in idx) / len(idx))  # noqa: E731
    return {"heart_rate": avg("hr"), "respiration_rate": avg("br"), "stress": avg("stress")}


def save_readings(astro_id, values, now=None):
    """Store the wearable's readings like any other. Returns {indicator: level}."""
    ts = datetime.fromtimestamp(time.time() if now is None else now, timezone.utc).isoformat()
    levels = {}
    with db.write_conn() as conn:
        for ind in INDICATORS:
            lvl = health_rules.evaluate(ind, values[ind])
            levels[ind] = lvl
            conn.execute(
                "INSERT INTO readings (astronaut_id, ts, indicator, value_json, level, source) VALUES (?, ?, ?, ?, ?, 'wearable')",
                (astro_id, ts, ind, json.dumps(values[ind]), lvl),
            )
    return levels


def tick(emit_fn, now=None, request_analysis=None):
    """One step: emit this second for every active monitor, and save once a minute.
    request_analysis(astro_id) is called only when a saved level changed."""
    now = time.time() if now is None else now
    with _lock:
        feeds = {a: f for a, f in _feeds.items()}
    for astro_id, feed in feeds.items():
        s, seg = _second(feed, now)
        if feed["last_sent"] != s:
            feed["last_sent"] = s
            hz = _load()["trace_hz"]
            emit_fn("sensor", {"astronaut_id": astro_id, "segment": seg["id"], "second": s,
                               "ecg": seg["ecg"][s * hz:(s + 1) * hz], **_sample(seg, s)})
        if now - feed["last_save"] >= SAVE_EVERY_S:
            values = _minute_averages(feed, seg, now)
            feed["last_save"] = now
            levels = save_readings(astro_id, values, now)
            emit_fn("cyd_event", {"type": "wearable", "astronaut_id": astro_id, **values})
            changed = levels != feed["levels"]
            feed["levels"] = levels
            if changed and request_analysis:
                request_analysis(astro_id)


def start_worker(emit_fn, request_analysis):
    """Ticks a few times a second so each new second goes out promptly."""
    global _worker_started
    with _lock:
        if _worker_started:
            return
        _worker_started = True

    def loop():
        while True:
            time.sleep(0.25)
            try:
                tick(emit_fn, request_analysis=request_analysis)
            except Exception as exc:  # the demo must never lose this thread
                print(f"[sensor] tick failed: {exc}", flush=True)

    threading.Thread(target=loop, daemon=True, name="sensor-feed").start()


def reset():
    """Tests: every monitor off."""
    with _lock:
        _feeds.clear()
