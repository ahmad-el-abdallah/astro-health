"""One-off build step: turns one crew's raw NASA crew-state recording into the small
per-second file the live wearable replays (backend/sensor/crew13.json, committed, so nobody
else needs the 122 MB zip).

    .venv/bin/python -m backend.sensor.build ~/Downloads/13.zip

Source: NASA's crew-state physiology dataset, as published for Kaggle's "Reducing
Commercial Aviation Fatalities" -- pilots wired with ECG, respiration, skin conductance (GSR)
and 20 EEG channels at ~256 Hz during three 6-minute tests:
    CA  channelized attention  (one focused task)
    DA  diverted attention     (several tasks at once; Event 5 marks the task periods)
    SS  startle / surprise     (Event 1 marks the startle moments)
The fourth file (LOFT, a long full-flight simulation, 256 MB) isn't used.

What this keeps, per second: heart rate (from ECG R-peaks), breathing rate (from the
respiration belt), a 0-100 stress level (skin conductance scaled to that recording's own
range -- relative, NOT a medical measure) and the event flag; plus the ECG itself at
100 Hz for the moving trace. Pure Python on purpose (no numpy), so the tests run anywhere.
"""
import io
import json
import math
import os
import sys
import zipfile

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "crew13.json")
SEGMENTS = [  # (id, file suffix, label shown on screen, what happens)
    ("focus", "CA", "Focused task", "one demanding task (channelized attention)"),
    ("multitask", "DA", "Multitasking", "several tasks at once (diverted attention)"),
    ("startle", "SS", "Startle test", "sudden surprises (startle / surprise)"),
]
WORK_HZ = 250     # signals are resampled to this before any analysis
TRACE_HZ = 100    # the ECG trace kept for the screen


def read_csv(text):
    """The columns this needs, as float lists: TimeSecs, ECG, R, GSR, Event."""
    lines = text.splitlines()
    head = lines[0].split(",")
    idx = {name: head.index(name) for name in ("TimeSecs", "ECG", "R", "GSR", "Event")}
    cols = {name: [] for name in idx}
    for line in lines[1:]:
        parts = line.split(",")
        if len(parts) < len(head):
            continue
        for name, i in idx.items():
            cols[name].append(float(parts[i]))
    return cols


def resample(t, x, hz):
    """Linear interpolation of (t, x) onto an even grid starting at t[0]. The raw files'
    sample times aren't perfectly even (some are 125 Hz, some 256 Hz)."""
    out, j = [], 0
    n = int((t[-1] - t[0]) * hz)
    for k in range(n):
        tk = t[0] + k / hz
        while j + 1 < len(t) and t[j + 1] < tk:
            j += 1
        if j + 1 >= len(t):
            out.append(x[-1])
            continue
        span = t[j + 1] - t[j]
        f = (tk - t[j]) / span if span > 0 else 0.0
        out.append(x[j] + f * (x[j + 1] - x[j]))
    return out


def moving_average(x, width):
    """Centred moving average (same length), via a running sum."""
    width = max(1, int(width))
    half = width // 2
    pre = [0.0]
    for v in x:
        pre.append(pre[-1] + v)
    out = []
    for i in range(len(x)):
        a, b = max(0, i - half), min(len(x), i - half + width)
        out.append((pre[b] - pre[a]) / (b - a))
    return out


def detrend(x, width):
    base = moving_average(x, width)
    return [a - b for a, b in zip(x, base)]


def r_peaks(ecg, hz):
    """Indexes of the heartbeats (R-peaks) in an evenly sampled ECG. Removes baseline
    wander, picks the polarity where the beats stick out most, then takes local maxima above
    an adaptive threshold (60% of a high percentile in each 4 s window), at least 0.33 s apart
    (no heart rate above ~180)."""
    sig = detrend(ecg, hz * 0.6)
    srt = sorted(sig)
    if abs(srt[int(len(srt) * 0.002)]) > abs(srt[int(len(srt) * 0.998)]):
        sig = [-v for v in sig]  # beats point down on this lead
    win = int(hz * 4)
    refractory = int(hz * 0.33)
    peaks = []
    for w0 in range(0, len(sig), win):
        w = sig[w0:w0 + win]
        if len(w) < 3:
            continue
        thr = sorted(w)[int(len(w) * 0.98)] * 0.6
        for i in range(1, len(w) - 1):
            v = w[i]
            if v > thr and v >= w[i - 1] and v >= w[i + 1]:
                k = w0 + i
                if peaks and k - peaks[-1] < refractory:
                    if v > sig[peaks[-1]]:
                        peaks[-1] = k  # same beat, a higher point
                    continue
                peaks.append(k)
    return peaks


def heart_rate(peaks, hz, n_seconds, window_s=10):
    """Beats per minute for every second: 60 / median beat-to-beat time over the last
    `window_s` seconds. None where there aren't enough beats yet."""
    times = [p / hz for p in peaks]
    out = []
    for s in range(n_seconds):
        lo, hi = s + 1 - window_s, s + 1
        ts = [t for t in times if lo <= t < hi]
        rr = sorted(b - a for a, b in zip(ts, ts[1:]) if 0.3 <= b - a <= 2.0)
        out.append(round(60 / rr[len(rr) // 2]) if len(rr) >= 3 else None)
    return out


def breathing_rate(resp, hz, n_seconds, window_s=30):
    """Breaths per minute for every second, from the respiration belt: smooth it (1 s),
    remove the slow drift (10 s), then count upward crossings with a little hysteresis over
    the last `window_s` seconds."""
    x = detrend(moving_average(resp, hz), hz * 10)
    srt = sorted(abs(v) for v in x)
    band = srt[int(len(srt) * 0.5)] * 0.3  # ignore wiggles near zero
    crossings, armed = [], False
    for i, v in enumerate(x):
        if v < -band:
            armed = True
        elif v > band and armed:
            crossings.append(i / hz)
            armed = False
    out = []
    for s in range(n_seconds):
        lo = max(0, s + 1 - window_s)
        n = sum(1 for t in crossings if lo <= t < s + 1)
        span = s + 1 - lo
        out.append(round(n * 60 / span) if span >= 10 else None)
    return out


def stress_scale(gsr_per_second, baseline_s=30, rest=20, min_rise=0.04):
    """Skin conductance per second -> a 0-100 arousal level within THIS recording.
    The raw level drifts up over a session (electrodes warming), so it isn't used directly:
    what counts is how far it rises above its own slow baseline (the last `baseline_s`
    seconds) -- the quick "skin conductance responses" a startle or a sudden load causes.
    Calm sits around `rest`; the recording's biggest responses reach ~100. Relative arousal
    for a demo, not a medical value."""
    base = []
    for i in range(len(gsr_per_second)):
        w = gsr_per_second[max(0, i - baseline_s):i + 1]
        base.append(sorted(w)[len(w) // 2])  # median of the recent past: ignores the response itself
    rise = [max(0.0, v - b) for v, b in zip(gsr_per_second, base)]
    srt = sorted(rise)
    # Never stretch small ripples to 100: a response only reaches the top when it's at least
    # min_rise of the person's own level (crew 13: everyday ripples ~12-19 units on ~900, the
    # startles 75-130).
    level = sorted(gsr_per_second)[len(gsr_per_second) // 2]
    top = max(srt[int(len(srt) * 0.99)], abs(level) * min_rise) or 1.0
    return [max(0, min(100, round(rest + (100 - rest) * r / top))) for r in rise]


def median_filter(values, width=7):
    """Rolling median: removes one-second glitches (a double-counted beat) but keeps real
    changes that last a few seconds."""
    half = width // 2
    out = []
    for i in range(len(values)):
        w = sorted(v for v in values[max(0, i - half):i + half + 1] if v is not None)
        out.append(w[len(w) // 2] if w else None)
    return out


def per_second_mean(x, hz, n_seconds):
    return [sum(x[s * hz:(s + 1) * hz]) / max(1, len(x[s * hz:(s + 1) * hz])) for s in range(n_seconds)]


def fill_gaps(values):
    """Carry the last known value forward (and the first one back) over None gaps."""
    first = next((v for v in values if v is not None), None)
    out, last = [], first
    for v in values:
        last = v if v is not None else last
        out.append(last)
    return out


def build_segment(cols, marks_events=True):
    t = cols["TimeSecs"]
    ecg = resample(t, cols["ECG"], WORK_HZ)
    resp = resample(t, cols["R"], WORK_HZ)
    gsr = resample(t, cols["GSR"], WORK_HZ)
    ev = resample(t, cols["Event"], WORK_HZ)
    n = len(ecg) // WORK_HZ
    hr = fill_gaps(median_filter(heart_rate(r_peaks(ecg, WORK_HZ), WORK_HZ, n)))
    br = fill_gaps(median_filter(breathing_rate(resp, WORK_HZ, n)))
    stress = stress_scale(per_second_mean(gsr, WORK_HZ, n))
    event = [1 if max(ev[s * WORK_HZ:(s + 1) * WORK_HZ] or [0]) > 0.5 else 0 for s in range(n)]
    if not marks_events:
        event = [0] * n  # CA flags its whole run as "the task" -- nothing worth showing
    # the ECG trace: 100 Hz, baseline removed, scaled to -100..100 for the screen
    trace = detrend(resample([i / WORK_HZ for i in range(len(ecg))], ecg, TRACE_HZ), TRACE_HZ * 0.6)
    srt = sorted(abs(v) for v in trace)
    scale = srt[int(len(srt) * 0.995)] or 1.0
    trace = [max(-127, min(127, round(v / scale * 100))) for v in trace[:n * TRACE_HZ]]
    return {"seconds": n, "hr": hr, "br": br, "stress": stress, "event": event, "ecg": trace}


def build(zip_path, out=OUT):
    z = zipfile.ZipFile(zip_path)
    names = {os.path.basename(n): n for n in z.namelist()}
    crew = next(n.split("_")[0] for n in names if n.endswith(".csv"))
    segments = []
    for seg_id, suffix, label, about in SEGMENTS:
        name = names[f"{crew}_{suffix}.csv"]
        print(f"reading {name}…", flush=True)
        cols = read_csv(io.TextIOWrapper(z.open(name), encoding="utf-8").read())
        seg = build_segment(cols, marks_events=suffix != "CA")
        hr = [v for v in seg["hr"] if v]
        print(f"  {seg['seconds']} s, heart rate {min(hr)}-{max(hr)} bpm, breathing "
              f"{min(v for v in seg['br'] if v)}-{max(v for v in seg['br'] if v)}/min, "
              f"{sum(seg['event'])} event seconds", flush=True)
        segments.append({"id": seg_id, "label": label, "about": about, "test": suffix, **seg})
    data = {
        "source": f"NASA crew-state physiology study (Kaggle: Reducing Commercial Aviation Fatalities), crew {crew}",
        "note": "Real recorded pilot signals, replayed. Stress is skin conductance scaled within each recording -- relative, not medical.",
        "trace_hz": TRACE_HZ,
        "segments": segments,
    }
    with open(out, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    print(f"wrote {out} ({os.path.getsize(out) / 1e6:.2f} MB)")
    return data


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: python -m backend.sensor.build <path to the crew zip, e.g. 13.zip>")
    build(sys.argv[1])
