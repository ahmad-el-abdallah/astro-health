"""Face Analysis measurements: what can honestly be measured from a 10–15 s webcam window.

Pure functions over MediaPipe Face Landmarker output (478 landmarks, 52 blendshapes, a 4x4
facial transformation matrix) and the frame itself, so they're testable without a camera or
the model. The frame is only read here to measure light levels in small patches; it is never
stored or returned. backend/services/face.py runs the model and calls these.

What this measures (camera observations, not health measurements):
  * eye openness (eye aspect ratio from the eyelid landmarks) and, over time, eye closures:
    how often, how long, and the share of time the eyes were closed;
  * head position (yaw/pitch/roll from the transformation matrix) and how much the face moved;
  * image quality and framing (light on the face, sharpness, size, centring, faces in view);
  * under-eye appearance: how much darker the skin under the eyes looks than the cheek, in
    the same frame -- only when light, sharpness and pose allow it;
  * visible skin appearance: lightness, colour and evenness under the CURRENT lighting -- only
    without a strong colour cast, and even then it describes the picture, not the skin.

It never infers anemia, dehydration, illness, fatigue, mood or any internal condition. Blink
and closure numbers depend on what the person was doing (reading, talking, the screen), and
blendshape scores are expression estimates, not measurements, so they're not used as values.

Thresholds were set from real model output on this laptop's webcam (2026-11-13): open eyes gave
an eye aspect ratio of ~0.31-0.33, a front-facing head ~0-3 deg, face light L* 33/100 in a dim
room, and a cheek colour of b* -28 (a strong blue cast from the room's light), which is exactly
why skin colour is reported as inconclusive under a colour cast.
"""
import math

import numpy as np

# MediaPipe face mesh indices (canonical 468 + 10 iris points)
RIGHT_EYE = (33, 160, 158, 133, 153, 144)  # outer, upper x2, inner, lower x2 (subject's right)
LEFT_EYE = (362, 385, 387, 263, 373, 380)
RIGHT_LOWER_LID, LEFT_LOWER_LID = 145, 374
RIGHT_CHEEK, LEFT_CHEEK = 50, 280
FOREHEAD = 151

# Quality (face area, L* 0-100 scale)
TOO_DARK_L = 15        # below: the frame isn't used at all (eye landmarks get noisy)
DIM_L = 30             # below: eye measures OK, appearance measures not
TOO_BRIGHT_L = 85
CLIPPED_SHARE = 0.08   # > 8% of face pixels blown out or crushed = exposure problem
# Laplacian variance on the face resized to 200 px wide. Calibrated on the 640 px frames the
# browser sends (the real test photo gave ~32 at 640 px, ~79 at 1280 px, ~3 darkened).
BLURRY = 10
SOFT = 20
MIN_FACE_WIDTH = 0.12  # share of the frame width
SMALL_FACE_WIDTH = 0.15
FRONTAL_DEG = 20       # |yaw|, |pitch| up to this = facing the camera
APPEARANCE_FRONTAL_DEG = 12
COLOUR_CAST_B = -5     # skin should read b* > 0 under neutral light; below this = a cast
COLOUR_CAST_A = 35     # very red cast

# Time-based
MIN_WINDOW_S = 6.0
MIN_VALID_SHARE = 0.5
CLOSED_RATIO = 0.55    # eyes "closed" below this share of the person's own open-eye level
LONG_CLOSURE_S = 1.0


def _l(value):
    """OpenCV 8-bit Lab L (0-255) -> L* (0-100)."""
    return value * 100.0 / 255.0


def points(landmarks, width, height):
    """MediaPipe normalised landmarks (objects with .x/.y/.z or (x, y, z) tuples) -> pixel array."""
    out = np.empty((len(landmarks), 3), dtype=np.float64)
    for i, p in enumerate(landmarks):
        x, y, z = (p.x, p.y, p.z) if hasattr(p, "x") else p
        out[i] = (x * width, y * height, z * width)
    return out


def eye_aspect_ratio(pts, idx):
    """(|p2-p6| + |p3-p5|) / (2 |p1-p4|): ~0.3 open, ~0.1 closed."""
    p = pts[list(idx), :2]
    width = np.linalg.norm(p[0] - p[3])
    if width <= 1e-6:
        return None
    return float((np.linalg.norm(p[1] - p[5]) + np.linalg.norm(p[2] - p[4])) / (2.0 * width))


def head_pose(matrix):
    """4x4 facial transformation matrix -> (yaw, pitch, roll) in degrees, or None."""
    if matrix is None:
        return None
    m = np.asarray(matrix, dtype=np.float64)
    if m.shape != (4, 4) or not np.all(np.isfinite(m)):
        return None
    r = m[:3, :3]
    sy = math.hypot(r[0, 0], r[1, 0])
    pitch = math.degrees(math.atan2(r[2, 1], r[2, 2]))
    yaw = math.degrees(math.atan2(-r[2, 0], sy))
    roll = math.degrees(math.atan2(r[1, 0], r[0, 0]))
    return yaw, pitch, roll


def _patch_lab(lab, cx, cy, radius):
    """Mean L*, a*, b* and L* spread in a small disc of a Lab image, or None off-frame."""
    h, w = lab.shape[:2]
    r = max(2, int(radius))
    x0, x1, y0, y1 = int(cx) - r, int(cx) + r + 1, int(cy) - r, int(cy) + r + 1
    if x0 < 0 or y0 < 0 or x1 > w or y1 > h:
        return None
    block = lab[y0:y1, x0:x1].reshape(-1, 3).astype(np.float64)
    yy, xx = np.mgrid[y0:y1, x0:x1]
    inside = ((xx - cx) ** 2 + (yy - cy) ** 2 <= r * r).reshape(-1)
    v = block[inside]
    if len(v) < 5:
        return None
    lstar = _l(v[:, 0])
    return {"L": float(lstar.mean()), "a": float(v[:, 1].mean() - 128), "b": float(v[:, 2].mean() - 128), "L_sd": float(lstar.std())}


def frame_metrics(face_landmark_lists, matrices, bgr, cv2):
    """Everything measured in ONE frame. face_landmark_lists: MediaPipe's per-face landmark
    lists; matrices: the per-face transformation matrices; bgr: the frame (H x W x 3, uint8);
    cv2: the OpenCV module (passed in so this file imports without it).
    Returns a dict of numbers only -- no pixels."""
    h, w = bgr.shape[:2]
    faces = len(face_landmark_lists)
    # the whole frame's light, so a frame with no face can say whether it was simply too dark
    # (in a real test the model found no face at all in a very dark camera feed)
    frame_l = float(_l(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).mean()))
    out = {"faces": faces, "w": w, "h": h, "frame_L": frame_l}
    if faces != 1:
        return out
    pts = points(face_landmark_lists[0], w, h)
    x0, y0 = pts[:, 0].min(), pts[:, 1].min()
    x1, y1 = pts[:, 0].max(), pts[:, 1].max()
    fw = max(1.0, x1 - x0)
    out["face_w"] = float(fw / w)
    out["center"] = (float((x0 + x1) / 2 / w), float((y0 + y1) / 2 / h))
    out["ear_r"] = eye_aspect_ratio(pts, RIGHT_EYE)
    out["ear_l"] = eye_aspect_ratio(pts, LEFT_EYE)
    pose = head_pose(matrices[0] if matrices else None)
    if pose:
        out["yaw"], out["pitch"], out["roll"] = pose
    # light and sharpness on the face itself
    bx0, by0 = max(0, int(x0)), max(0, int(y0))
    bx1, by1 = min(w, int(x1)), min(h, int(y1))
    if bx1 - bx0 >= 8 and by1 - by0 >= 8:
        face_bgr = bgr[by0:by1, bx0:bx1]
        lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)
        face_l = _l(lab[by0:by1, bx0:bx1, 0].astype(np.float64))
        out["face_L"] = float(face_l.mean())
        out["clipped"] = float(((face_l > 97) | (face_l < 3)).mean())
        gray = cv2.cvtColor(face_bgr, cv2.COLOR_BGR2GRAY)
        scaled = cv2.resize(gray, (200, max(8, int(200 * gray.shape[0] / gray.shape[1]))))
        out["sharpness"] = float(cv2.Laplacian(scaled, cv2.CV_64F).var())
        # appearance patches: under each eye (40% of the way from the lower lid to the cheek),
        # the cheeks, and the forehead
        ue = []
        for lid, cheek in ((RIGHT_LOWER_LID, RIGHT_CHEEK), (LEFT_LOWER_LID, LEFT_CHEEK)):
            c = pts[lid, :2] + 0.4 * (pts[cheek, :2] - pts[lid, :2])
            ue.append(_patch_lab(lab, c[0], c[1], 0.035 * fw))
        ck = [_patch_lab(lab, pts[i, 0], pts[i, 1], 0.05 * fw) for i in (RIGHT_CHEEK, LEFT_CHEEK)]
        fh = _patch_lab(lab, pts[FOREHEAD, 0], pts[FOREHEAD, 1], 0.05 * fw)
        if all(ue) and all(ck):
            out["under_eye_L"] = (ue[0]["L"] + ue[1]["L"]) / 2
            out["cheek_L"] = (ck[0]["L"] + ck[1]["L"]) / 2
        skin = [p for p in ck + [fh] if p]
        if len(skin) == 3:
            out["skin_L"] = float(np.mean([p["L"] for p in skin]))
            out["skin_a"] = float(np.mean([p["a"] for p in skin]))
            out["skin_b"] = float(np.mean([p["b"] for p in skin]))
            out["skin_L_sd"] = float(np.mean([p["L_sd"] for p in skin]))
    return out


def frame_problems(m):
    """Why this frame can't be used for eye/movement measures (empty list = usable)."""
    if m.get("faces", 0) == 0:
        return ["too dark to find a face" if m.get("frame_L", 100) < TOO_DARK_L else "no face in view"]
    if m["faces"] > 1:
        return ["more than one face in view"]
    out = []
    if m.get("face_L") is not None and m["face_L"] < TOO_DARK_L:
        out.append("too dark")
    if m.get("face_w", 0) < MIN_FACE_WIDTH:
        out.append("face too small (move closer)")
    if m.get("ear_r") is None or m.get("ear_l") is None:
        out.append("eyes not measurable")
    return out


def guidance(m):
    """Short live hints for the preview while recording."""
    tips = []
    if m.get("faces", 0) == 0:
        return ["Too dark to see your face: add light" if m.get("frame_L", 100) < TOO_DARK_L else "No face found: face the camera"]
    if m["faces"] > 1:
        return ["Only one person in view, please"]
    L = m.get("face_L")
    if L is not None and L < DIM_L:
        tips.append("More light on your face")
    elif L is not None and L > TOO_BRIGHT_L:
        tips.append("Too bright: avoid direct light")
    if m.get("face_w", 1) < SMALL_FACE_WIDTH:
        tips.append("Move a little closer")
    if abs(m.get("yaw", 0)) > FRONTAL_DEG or abs(m.get("pitch", 0)) > FRONTAL_DEG:
        tips.append("Look straight at the camera")
    cx, cy = m.get("center", (0.5, 0.5))
    if not (0.25 < cx < 0.75 and 0.2 < cy < 0.8):
        tips.append("Centre your face")
    if m.get("sharpness") is not None and m["sharpness"] < BLURRY:
        tips.append("Hold still, image is blurry")
    return tips


# ---------------------------------------------------------------------------- the report

def _obs(oid, name, description, limitations, value=None, unit="", display="", reliability="inconclusive", reason=""):
    measured = value is not None and reliability != "inconclusive"
    return {
        "id": oid, "name": name, "status": "measured" if measured else "inconclusive",
        "value": value if measured else None, "unit": unit if measured else "",
        "display": display if measured else "Inconclusive",
        "description": description, "reliability": reliability if measured else "inconclusive",
        "reliability_reason": reason, "limitations": limitations,
    }


def _closures(times, ears, open_level):
    """Eye-closure events from an eye-openness series: [(start_s, duration_s)]."""
    thr = CLOSED_RATIO * open_level
    events, start, last = [], None, None
    dt = np.median(np.diff(times)) if len(times) > 1 else 0.1
    for t, e in zip(times, ears):
        if e < thr:
            if start is None:
                start = t
            last = t
        elif start is not None:
            events.append((start, last - start + dt))
            start = None
    if start is not None:
        events.append((start, last - start + dt))
    return events, thr


def summarize(frames, duration_s):
    """frames: [{"t": seconds, ...frame_metrics}] for the whole window -> the report."""
    n = len(frames)
    fps = n / duration_s if duration_s > 0 else 0.0
    usable = [f for f in frames if not frame_problems(f)]
    share = len(usable) / n if n else 0.0
    multi = sum(1 for f in frames if f.get("faces", 0) > 1)
    none = sum(1 for f in frames if f.get("faces", 0) == 0)
    long_enough = duration_s >= MIN_WINDOW_S
    # the most common reason frames couldn't be used, said plainly
    problem_counts = {}
    for f in frames:
        for p in frame_problems(f):
            problem_counts[p] = problem_counts.get(p, 0) + 1
    top_problem = max(problem_counts, key=problem_counts.get) if problem_counts else ""
    base_ok = long_enough and share >= MIN_VALID_SHARE and len(usable) >= 20
    time_rel = "high" if (fps >= 12 and share >= 0.9) else "medium" if (fps >= 8 and share >= 0.7) else "low"
    why_short = (f"only {duration_s:.1f} s recorded" if not long_enough else
                 (f"a usable face in only {share:.0%} of frames" + (f" (mostly: {top_problem}, {problem_counts[top_problem]} of {n} frames)" if top_problem else "")) if share < MIN_VALID_SHARE else
                 f"only {len(usable)} usable frames" if len(usable) < 20 else "")
    obs = []

    # ---- image quality & framing
    face_frames = [f for f in frames if f.get("faces") == 1]
    Ls = [f["face_L"] for f in face_frames if f.get("face_L") is not None]
    sharp = [f["sharpness"] for f in face_frames if f.get("sharpness") is not None]
    sizes = [f["face_w"] for f in face_frames if f.get("face_w") is not None]
    clipped = [f["clipped"] for f in face_frames if f.get("clipped") is not None]
    L_med = float(np.median(Ls)) if Ls else None
    s_med = float(np.median(sharp)) if sharp else None
    size_med = float(np.median(sizes)) if sizes else None
    clip_med = float(np.median(clipped)) if clipped else None
    issues = []
    if L_med is not None and L_med < DIM_L:
        issues.append("dim lighting")
    if L_med is not None and L_med > TOO_BRIGHT_L:
        issues.append("very bright lighting")
    if clip_med is not None and clip_med > CLIPPED_SHARE:
        issues.append("over/under-exposed areas on the face")
    if s_med is not None and s_med < SOFT:
        issues.append("soft or blurry image")
    if size_med is not None and size_med < SMALL_FACE_WIDTH:
        issues.append("face small in the frame")
    if multi:
        issues.append("more than one face at times")
    dark_no_face = sum(1 for f in frames if f.get("faces", 0) == 0 and f.get("frame_L", 100) < TOO_DARK_L)
    if dark_no_face >= n / 2:
        issues.append("too dark to find a face")
    severe = (L_med is not None and L_med < TOO_DARK_L) or (s_med is not None and s_med < BLURRY) or (multi and multi >= n / 2)
    if not face_frames:
        rating = "poor" if (multi or dark_no_face >= n / 2) else None
    else:
        rating = "good" if not issues else "fair" if (len(issues) <= 2 and not severe) else "poor"
    quality = {
        "rating": rating or "no face", "issues": issues, "frames": n, "usable_frames": len(usable),
        "usable_share": round(share, 3), "fps": round(fps, 1), "duration_s": round(duration_s, 1),
        "face_light_L": None if L_med is None else round(L_med, 1),
        "sharpness": None if s_med is None else round(s_med, 1),
        "face_width_share": None if size_med is None else round(size_med, 3),
        "no_face_frames": none, "multi_face_frames": multi,
    }
    obs.append(_obs(
        "image_quality", "Image quality and face positioning",
        "How well the camera could see your face: light on the face, sharpness, size in the frame, and frames where no face or more than one face was in view.",
        ["Judged from this camera and room only.", "Sets how much the other observations can be trusted."],
        value=rating, display=(rating or "").capitalize() + (f" — {', '.join(issues)}" if issues else ""),
        reliability="high" if rating else "inconclusive",
        reason=(f"{len(face_frames)} of {n} frames had exactly one face" + (f"; {multi} had more than one" if multi else "") if face_frames else
                f"more than one face in view in {multi} of {n} frames" if multi else
                f"too dark to find a face in {dark_no_face} of {n} frames" if dark_no_face >= n / 2 else "no face was seen"),
    ))

    if not usable:
        for oid, name in (("eye_openness", "Eye openness"), ("eye_closures", "Eye closures"), ("head_movement", "Head position and movement"),
                          ("under_eye", "Under-eye appearance"), ("skin", "Visible skin appearance")):
            obs.append(_obs(oid, name, "", ["Not enough usable frames to measure."], reason=why_short or "no usable frames"))
        return {"quality": quality, "observations": obs}

    times = np.array([f["t"] for f in usable])
    ears = np.array([(f["ear_r"] + f["ear_l"]) / 2 for f in usable])
    asym = np.array([abs(f["ear_r"] - f["ear_l"]) / max(1e-6, (f["ear_r"] + f["ear_l"]) / 2) for f in usable])
    open_level = float(np.percentile(ears, 80))

    # ---- eye openness
    obs.append(_obs(
        "eye_openness", "Eye openness",
        "How open your eyes were while they were open: the eye aspect ratio from the eyelid landmarks (about 0.3 is typical for open eyes), and how much the two eyes differed.",
        ["Changes with head angle, glasses, eyelid shape and where you look.", "A camera measurement, not a sign of tiredness or any condition."],
        value={"open_ratio": round(open_level, 3), "median_ratio": round(float(np.median(ears)), 3), "left_right_difference": round(float(np.median(asym)), 3)},
        display=f"{open_level:.2f} when open (left/right differ by {float(np.median(asym)):.0%})",
        reliability=time_rel if base_ok else "inconclusive",
        reason=why_short or f"{len(usable)} usable frames at {fps:.0f} fps",
    ))

    # ---- eye closures (needs a real open-eye level and enough frames per second)
    events, thr = _closures(times, ears, open_level)
    total_closed = sum(d for _, d in events)
    span = max(1e-6, times[-1] - times[0])
    closure_ok = base_ok and fps >= 5 and open_level >= 0.15
    longest = max((d for _, d in events), default=0.0)
    obs.append(_obs(
        "eye_closures", "Eye closures (blinks)",
        f"Times your eyes closed (below {CLOSED_RATIO:.0%} of your own open level) during the window: how many, how long, and the share of time they were closed.",
        [f"At {fps:.0f} frames per second, very short blinks (under ~{1000 / max(fps, 1):.0f} ms) can be missed.",
         "Blink rate changes a lot with reading, talking and screen use; it isn't a fatigue or health measure.",
         "A 10–15 s window is short; one more or one fewer blink changes the rate a lot."],
        value={"count": len(events), "per_minute": round(len(events) / span * 60, 1), "mean_duration_s": round(total_closed / len(events), 2) if events else 0.0,
               "longest_s": round(longest, 2), "closed_share": round(total_closed / span, 3), "long_closures": sum(1 for _, d in events if d >= LONG_CLOSURE_S)},
        display=f"{len(events)} in {span:.0f} s ({len(events) / span * 60:.0f}/min), longest {longest:.1f} s, eyes closed {total_closed / span:.0%} of the time",
        reliability=("medium" if time_rel == "high" else "low") if closure_ok else "inconclusive",
        reason=why_short or (f"only {fps:.0f} frames per second" if fps < 5 else "open-eye level too low to tell closures apart" if open_level < 0.15 else f"{len(usable)} usable frames at {fps:.0f} fps"),
    ))

    # ---- head position & movement
    posed = [f for f in usable if f.get("yaw") is not None]
    if posed:
        yaw = np.array([f["yaw"] for f in posed]); pitch = np.array([f["pitch"] for f in posed]); roll = np.array([f["roll"] for f in posed])
        cx = np.array([f["center"][0] for f in posed]); cy = np.array([f["center"][1] for f in posed]); fw = np.array([f["face_w"] for f in posed])
        steps = np.hypot(np.diff(cx), np.diff(cy)) / np.maximum(fw[1:], 1e-6)
        dts = np.maximum(np.diff([f["t"] for f in posed]), 1e-3)
        move = float(np.median(steps / dts)) if len(steps) else 0.0
        obs.append(_obs(
            "head_movement", "Head position and movement",
            "Where your head was turned (left/right, up/down, tilt) on average, how much it varied, and how much your face moved across the frame.",
            ["Angles are estimates from a single camera (accurate to a few degrees).", "Movement includes the camera or laptop moving."],
            value={"yaw_deg": round(float(np.median(yaw)), 1), "pitch_deg": round(float(np.median(pitch)), 1), "roll_deg": round(float(np.median(roll)), 1),
                   "yaw_sd": round(float(yaw.std()), 1), "pitch_sd": round(float(pitch.std()), 1), "roll_sd": round(float(roll.std()), 1),
                   "movement_face_widths_per_s": round(move, 3)},
            display=f"turned {float(np.median(yaw)):+.0f}°, tilted {float(np.median(pitch)):+.0f}° / {float(np.median(roll)):+.0f}°; varied ±{max(yaw.std(), pitch.std(), roll.std()):.0f}°; moved {move:.0%} of a face width per second",
            reliability=time_rel if base_ok else "inconclusive", reason=why_short or f"{len(posed)} frames with a head angle",
        ))
    else:
        obs.append(_obs("head_movement", "Head position and movement", "", ["No head angle was available."], reason="no head angles"))

    # ---- under-eye appearance (strict: good light, sharp, frontal, not clipped)
    def appearance_ok(f):
        return (f.get("face_L") is not None and DIM_L <= f["face_L"] <= TOO_BRIGHT_L and f.get("sharpness", 0) >= BLURRY
                and f.get("clipped", 1) <= CLIPPED_SHARE and abs(f.get("yaw", 99)) <= APPEARANCE_FRONTAL_DEG and abs(f.get("pitch", 99)) <= APPEARANCE_FRONTAL_DEG)
    app = [f for f in usable if appearance_ok(f) and f.get("under_eye_L") is not None]
    app_share = len(app) / len(usable)
    ue_ok = base_ok and len(app) >= 15 and app_share >= 0.5
    if app:
        diff = np.array([f["cheek_L"] - f["under_eye_L"] for f in app])
        d = float(np.median(diff))
    else:
        d = None
    obs.append(_obs(
        "under_eye", "Under-eye appearance",
        "How much darker (or lighter) the skin just under your eyes looked than your cheek in the same frames, in L* lightness units (0–100).",
        ["Overhead light, shadows from the brow, glasses, make-up and skin tone all change this.",
         "Compares two areas of the same picture; it isn't a measure of tiredness, sleep or health."],
        value=None if d is None else {"darker_than_cheek_L": round(d, 1), "frames": len(app)},
        display="" if d is None else (f"{abs(d):.0f} L* units {'darker' if d >= 0 else 'lighter'} than the cheek"),
        reliability="low" if ue_ok else "inconclusive",
        reason=(why_short or (f"good-quality frontal frames: {len(app)} of {len(usable)} (light, sharpness or angle not good enough)" if not ue_ok else f"{len(app)} good-quality frontal frames")),
    ))

    # ---- visible skin appearance (only without a strong colour cast)
    sk = [f for f in app if f.get("skin_L") is not None]
    if sk:
        a = float(np.median([f["skin_a"] for f in sk])); b = float(np.median([f["skin_b"] for f in sk]))
        L = float(np.median([f["skin_L"] for f in sk])); sd = float(np.median([f["skin_L_sd"] for f in sk]))
        cast = b < COLOUR_CAST_B or a > COLOUR_CAST_A
    else:
        cast, a, b, L, sd = False, None, None, None, None
    skin_ok = base_ok and len(sk) >= 15 and not cast
    obs.append(_obs(
        "skin", "Visible skin appearance",
        "The colour and evenness of your cheeks and forehead as this camera saw them (CIE L*a*b*: lightness, red–green, yellow–blue), and how even the lightness was.",
        ["Mostly reflects the room's light and the camera's colour processing; it can't be compared between rooms or cameras.",
         "Describes the picture, not the skin's health. No condition can be read from it."],
        value=None if L is None else {"lightness_L": round(L, 1), "a": round(a, 1), "b": round(b, 1), "evenness_sd_L": round(sd, 1)},
        display="" if L is None else f"lightness {L:.0f}, colour a* {a:+.0f} / b* {b:+.0f}, evenness ±{sd:.1f}",
        reliability="low" if skin_ok else "inconclusive",
        reason=(why_short or ("the light has a strong colour cast (b* {:+.0f}): the colour shows the lighting, not the skin".format(b) if cast else
                              f"only {len(sk)} good-quality frontal frames" if len(sk) < 15 else f"{len(sk)} good-quality frontal frames")),
    ))
    return {"quality": quality, "observations": obs}
