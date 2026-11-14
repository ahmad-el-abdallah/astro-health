"""The live wearable: replays a real recorded crew session (backend/sensor/crew13.json, built
by backend/sensor/build.py from NASA's crew-state physiology study) as if the astronaut were
wearing a chest strap right now.

It works like a test the astronaut takes:
  * while it runs, every second a Socket.IO "sensor" event goes to every browser: heart rate,
    breathing rate, stress (0-100) and the event flag for that second, plus one second of the
    ECG trace for the moving line. Nothing is saved yet;
  * it plays the recording ONCE. When it reaches the end -- or the astronaut presses
    "Finish & save" -- finish() saves the test's results as their latest readings
    (heart_rate / respiration_rate / stress averages, source 'wearable') plus an assessment,
    exactly like the Assess button does. So the tiles, Trends and the doctor feed show it,
    Today's vitals check counts as done, and the AI analyses it once;
  * cancel (stop(..., save=False)) throws it away.

In memory, like sessions.active_sessions: a server restart cancels any running test.
"""
import json
import os
import threading
import time
from datetime import datetime, timezone

from backend import db
from backend.logic import health_rules

DATA_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "sensor", "crew13.json")
MIN_SAVE_S = 5   # a test shorter than this has nothing worth saving
INDICATORS = ("heart_rate", "respiration_rate", "stress")

_lock = threading.Lock()
_feeds = {}      # astro_id -> {"segment", "started", "last_sent"}
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
    """The second of the recording playing now (stops at the last one: it plays once)."""
    seg = _load()["by_id"][feed["segment"]]
    return max(0, min(int(now - feed["started"]), seg["seconds"] - 1)), seg


def _done(feed, now):
    return now - feed["started"] >= _load()["by_id"][feed["segment"]]["seconds"]


def _sample(seg, s):
    return {"hr": seg["hr"][s], "br": seg["br"][s], "stress": seg["stress"][s], "event": seg["event"][s]}


def start(astro_id, segment, now=None):
    if segment not in _load()["by_id"]:
        raise ValueError(f"unknown segment: {segment}")
    now = time.time() if now is None else now
    with _lock:
        _feeds[astro_id] = {"segment": segment, "started": now, "last_sent": None}
    return status(astro_id, now)


def stop(astro_id, save=True, now=None):
    """End the test. save=True: keep its results (see finish()); returns the result, or None
    when it wasn't running, was cancelled, or ran under MIN_SAVE_S."""
    now = time.time() if now is None else now
    with _lock:
        feed = _feeds.pop(astro_id, None)
    if not feed or not save:
        return None
    return finish(astro_id, feed, now)


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


def results(seg, played_s):
    """The test's results over the seconds actually played: averages, plus the peaks."""
    n = max(1, min(int(played_s), seg["seconds"]))
    avg = lambda key: round(sum(seg[key][:n]) / n)  # noqa: E731
    return {"heart_rate": avg("hr"), "respiration_rate": avg("br"), "stress": avg("stress"),
            "peak_heart_rate": max(seg["hr"][:n]), "peak_stress": max(seg["stress"][:n]),
            "startles": _count_runs(seg["event"][:n]) if seg["id"] == "startle" else 0, "seconds": n}


def _count_runs(flags):
    return sum(1 for i, f in enumerate(flags) if f and (i == 0 or not flags[i - 1]))


def finish(astro_id, feed, now):
    """Save a finished test as the astronaut's latest vitals + an assessment (what the
    Assess button saves, so Today's vitals check is done). Returns the result, or None if it
    ran under MIN_SAVE_S."""
    seg = _load()["by_id"][feed["segment"]]
    played = now - feed["started"]
    if played < MIN_SAVE_S:
        return None
    res = results(seg, played)
    ts = datetime.fromtimestamp(now, timezone.utc).isoformat()
    details = {}
    with db.write_conn() as conn:
        for ind in INDICATORS:
            lvl = health_rules.evaluate(ind, res[ind])
            details[ind] = {"value": res[ind], "level": lvl}
            conn.execute(
                "INSERT INTO readings (astronaut_id, ts, indicator, value_json, level, source) VALUES (?, ?, ?, ?, ?, 'wearable')",
                (astro_id, ts, ind, json.dumps(res[ind]), lvl),
            )
        overall = health_rules.overall_level([d["level"] for d in details.values()])
        flagged = [k.replace("_", " ") for k, d in details.items() if d["level"] == overall]
        test = seg["label"].lower() if seg["label"].lower().endswith("test") else f"{seg['label'].lower()} test"
        note = f"{overall}: wearable {test}" + (f" ({', '.join(flagged)})" if overall != "GREEN" else "")
        details["wearable_test"] = {"value": {"test": seg["id"], "label": seg["label"], **res}, "level": overall}
        conn.execute(
            "INSERT INTO assessments (astronaut_id, ts, overall_level, note, details_json) VALUES (?, ?, ?, ?, ?)",
            (astro_id, ts, overall, note[:120], json.dumps(details)),
        )
    return {"astronaut_id": astro_id, "segment": seg["id"], "label": seg["label"], "overall_level": overall,
            "note": note[:120], "details": details, "results": res}


def announce_finished(result, emit_fn, request_analysis=None):
    """What every finished test tells the browsers (and the AI), from the route or the tick."""
    emit_fn("sensor_changed", {"astronaut_id": result["astronaut_id"], "on": False, "finished": True, "result": result})
    emit_fn("assessment", {"astronaut_id": result["astronaut_id"], "overall_level": result["overall_level"],
                           "note": result["note"], "details": result["details"]})
    if request_analysis:
        request_analysis(result["astronaut_id"])


def tick(emit_fn, now=None, request_analysis=None):
    """One step: emit this second for every running test; a test that reached the end of its
    recording finishes and is saved (request_analysis(astro_id) then runs once)."""
    now = time.time() if now is None else now
    with _lock:
        feeds = {a: f for a, f in _feeds.items()}
    for astro_id, feed in feeds.items():
        if _done(feed, now):
            with _lock:
                if _feeds.get(astro_id) is not feed:
                    continue  # stopped meanwhile
                _feeds.pop(astro_id)
            result = finish(astro_id, feed, now)
            if result:
                announce_finished(result, emit_fn, request_analysis)
            continue
        s, seg = _second(feed, now)
        if feed["last_sent"] != s:
            feed["last_sent"] = s
            hz = _load()["trace_hz"]
            emit_fn("sensor", {"astronaut_id": astro_id, "segment": seg["id"], "second": s,
                               "ecg": seg["ecg"][s * hz:(s + 1) * hz], **_sample(seg, s)})


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
