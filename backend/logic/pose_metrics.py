"""Pose Analysis measurements: what a laptop webcam can honestly show about posture in ~12 s.

Pure functions over MediaPipe Pose Landmarker output (33 body landmarks per person, each with
x/y in 0..1 of the frame, a relative z, and visibility/presence scores 0..1) and the frame's
overall light, so they're testable without a camera or the model. The frame itself is only
read for its mean brightness; it is never stored or returned. backend/services/pose.py runs
the model and calls these.

What this measures (camera observations in the picture's 2D plane, not health measurements):
  * shoulder alignment: the angle of the shoulder line against the horizontal;
  * hip alignment: the same for the hip line -- only when the hips are clearly in view;
  * visible torso inclination: side-to-side lean of the shoulder-midpoint above the
    hip-midpoint (forward/back lean can't be seen from the front, so it isn't reported);
  * head and upper-body position: head offset from the shoulder centre, head tilt (ear line),
    and head height above the shoulders, in shoulder widths;
  * left/right landmark asymmetry: how far mirrored landmark pairs (shoulders, elbows, wrists,
    hips) are from mirror images of each other, in shoulder widths;
  * movement and stability: how much the upper body moved and swayed over the window;
  * landmark visibility and confidence per body region.

It never infers a spinal, neurological, muscular or balance condition. Every angle includes
the camera's own tilt, and the person's clothing, chair and arm position all affect it.

Thresholds are reasonable starting values, NOT calibrated on this laptop's webcam yet (unlike
face_metrics.py): visibility 0.5 is MediaPipe's own convention for "landmark visible".
"""
import math

import numpy as np

# MediaPipe Pose landmark indices (the person's own left/right)
NOSE = 0
L_EYE, R_EYE = 2, 5
L_EAR, R_EAR = 7, 8
L_SHOULDER, R_SHOULDER = 11, 12
L_ELBOW, R_ELBOW = 13, 14
L_WRIST, R_WRIST = 15, 16
L_HIP, R_HIP = 23, 24
L_KNEE, R_KNEE = 25, 26
L_ANKLE, R_ANKLE = 27, 28
NUM_LANDMARKS = 33

REGIONS = {
    "head": (NOSE, L_EYE, R_EYE, L_EAR, R_EAR),
    "shoulders": (L_SHOULDER, R_SHOULDER),
    "arms": (L_ELBOW, R_ELBOW, L_WRIST, R_WRIST),
    "hips": (L_HIP, R_HIP),
    "legs": (L_KNEE, R_KNEE, L_ANKLE, R_ANKLE),
}
LIVE_SEEN = {"head": 3, "shoulders": 2, "arms": 2, "hips": 2, "legs": 2}
PAIRS = ((L_SHOULDER, R_SHOULDER), (L_ELBOW, R_ELBOW), (L_WRIST, R_WRIST), (L_HIP, R_HIP))

VISIBLE = 0.5            # a landmark counts as seen at or above this visibility (MediaPipe's own cut-off)
GOOD_VISIBILITY = 0.8    # region mean above this = high confidence
EDGE = 0.02              # a landmark this close to the frame edge (or past it) is cut off
TOO_DARK_L = 15          # whole-frame L* (0-100) below this: too dark to find a body
DIM_L = 30
MIN_SHOULDER_W = 0.07    # shoulder width as a share of the frame width (a person standing back to show the hips: ~0.10)
SMALL_SHOULDER_W = 0.10
LARGE_SHOULDER_W = 0.70  # above: too close, the body is cut off
TURNED_RATIO = 0.45      # shoulder width / torso height below this = turned away from the camera
LEVEL_DEG = 2.0          # a line within this of horizontal/vertical is described as "about level"

MIN_WINDOW_S = 6.0
MIN_VALID_SHARE = 0.5
MIN_FRAMES = 20


def _l(value):
    """8-bit grey (0-255) -> L*-like 0-100."""
    return value * 100.0 / 255.0


def landmarks_array(landmarks):
    """MediaPipe landmarks (objects with .x/.y/.z/.visibility or tuples) -> (33, 4) array of
    x, y, z, visibility (x/y normalised 0..1). Missing visibility counts as 0."""
    out = np.zeros((len(landmarks), 4), dtype=np.float64)
    for i, p in enumerate(landmarks):
        if hasattr(p, "x"):
            vis = getattr(p, "visibility", None)
            pres = getattr(p, "presence", None)
            v = vis if vis is not None else 0.0
            if pres is not None:
                v = min(v, pres)
            out[i] = (p.x, p.y, p.z, v)
        else:
            vals = tuple(p)
            out[i] = (vals[0], vals[1], vals[2], vals[3] if len(vals) > 3 else 0.0)
    return out


def seen(lm, i):
    """Is landmark i visible and inside the frame?"""
    x, y, _z, v = lm[i]
    return v >= VISIBLE and EDGE <= x <= 1 - EDGE and EDGE <= y <= 1 - EDGE


def line_angle(a, b, w, h):
    """Angle in degrees of the line a->b against the horizontal, in PIXELS (so a non-square
    frame doesn't distort it). Positive = b is higher in the picture than a."""
    dx = (b[0] - a[0]) * w
    dy = (b[1] - a[1]) * h
    if abs(dx) < 1e-6 and abs(dy) < 1e-6:
        return None
    return math.degrees(math.atan2(-dy, dx))


def tilt(lm, left, right, w, h):
    """Signed tilt of a left/right pair in degrees: positive = the person's LEFT side is
    LOWER in the picture. Uses image y (down is +), independent of mirroring."""
    l, r = lm[left], lm[right]
    dx = abs(l[0] - r[0]) * w
    dy = (l[1] - r[1]) * h  # > 0: left is lower
    if dx < 1e-6:
        return None
    return math.degrees(math.atan2(dy, dx))


def frame_metrics(pose_landmark_lists, bgr, cv2):
    """Everything measured in ONE frame. pose_landmark_lists: MediaPipe's per-person landmark
    lists; bgr: the frame (H x W x 3, uint8); cv2: the OpenCV module (passed in so this file
    imports without it). Returns a dict of numbers only -- no pixels, no landmark list."""
    h, w = bgr.shape[:2]
    poses = len(pose_landmark_lists)
    frame_l = float(_l(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).mean()))
    out = {"poses": poses, "w": w, "h": h, "frame_L": frame_l}
    if poses != 1:
        return out
    lm = landmarks_array(pose_landmark_lists[0])
    if lm.shape[0] < NUM_LANDMARKS:
        out["poses"] = 0
        return out
    for name, idx in REGIONS.items():
        out[f"vis_{name}"] = float(np.mean([min(1.0, max(0.0, lm[i, 3])) for i in idx]))
        out[f"seen_{name}"] = int(sum(1 for i in idx if seen(lm, i)))
    shoulders_ok = seen(lm, L_SHOULDER) and seen(lm, R_SHOULDER)
    hips_ok = seen(lm, L_HIP) and seen(lm, R_HIP)
    out["shoulders_ok"] = int(shoulders_ok)
    out["hips_ok"] = int(hips_ok)
    if not shoulders_ok:
        return out
    ls, rs = lm[L_SHOULDER], lm[R_SHOULDER]
    sw = math.hypot((ls[0] - rs[0]) * w, (ls[1] - rs[1]) * h)  # shoulder width, px
    out["shoulder_w"] = float(sw / w)
    sm = ((ls[0] + rs[0]) / 2, (ls[1] + rs[1]) / 2)
    out["shoulder_mid"] = (float(sm[0]), float(sm[1]))
    t = tilt(lm, L_SHOULDER, R_SHOULDER, w, h)
    if t is not None:
        out["shoulder_tilt"] = float(t)
    centre = sm
    if hips_ok:
        lh, rh = lm[L_HIP], lm[R_HIP]
        hm = ((lh[0] + rh[0]) / 2, (lh[1] + rh[1]) / 2)
        ht = tilt(lm, L_HIP, R_HIP, w, h)
        if ht is not None:
            out["hip_tilt"] = float(ht)
        dx = (sm[0] - hm[0]) * w
        dy = (hm[1] - sm[1]) * h  # shoulders above hips: > 0
        torso_h = math.hypot(dx, dy)
        if dy > 1e-6:
            # positive = the shoulders are further toward the person's LEFT than the hips. In an
            # unmirrored front camera image the person's left is on the image's right (+x).
            side = 1.0 if ls[0] >= rs[0] else -1.0  # which way the person's left points in x
            out["torso_lean"] = float(math.degrees(math.atan2(dx * side, dy)))
            out["torso_ratio"] = float(sw / torso_h)
        centre = ((sm[0] + hm[0]) / 2, (sm[1] + hm[1]) / 2)
    out["centre"] = (float(centre[0]), float(centre[1]))
    # head relative to the shoulders, in shoulder widths
    if seen(lm, NOSE) and sw > 1e-6:
        side = 1.0 if ls[0] >= rs[0] else -1.0
        out["head_offset"] = float((lm[NOSE, 0] - sm[0]) * w * side / sw)  # + = toward the person's left
        out["head_height"] = float((sm[1] - lm[NOSE, 1]) * h / sw)
    if seen(lm, L_EAR) and seen(lm, R_EAR):
        et = tilt(lm, L_EAR, R_EAR, w, h)
        if et is not None:
            out["head_tilt"] = float(et)
    # left/right asymmetry: mirror each right landmark across the body's vertical midline
    mid_x = centre[0]
    diffs = []
    for li, ri in PAIRS:
        if seen(lm, li) and seen(lm, ri) and sw > 1e-6:
            dx = (abs(lm[li, 0] - mid_x) - abs(lm[ri, 0] - mid_x)) * w
            dy = (lm[li, 1] - lm[ri, 1]) * h
            diffs.append(math.hypot(dx, dy) / sw)
    if len(diffs) >= 2:
        out["asymmetry"] = float(np.mean(diffs))
        out["asymmetry_pairs"] = len(diffs)
    return out


def frame_problems(m):
    """Why this frame can't be used for upper-body measures (empty list = usable)."""
    if m.get("poses", 0) == 0:
        return ["too dark to find a body" if m.get("frame_L", 100) < TOO_DARK_L else "no body in view"]
    if m["poses"] > 1:
        return ["more than one person in view"]
    if not m.get("shoulders_ok"):
        return ["shoulders not clearly visible"]
    if m.get("shoulder_w", 0) < MIN_SHOULDER_W:
        return ["body too small in the frame (move closer)"]
    return []


def guidance(m):
    """Short live hints for the preview while recording."""
    if m.get("poses", 0) == 0:
        return ["Too dark to see you: add light" if m.get("frame_L", 100) < TOO_DARK_L else "No body found: sit or stand back so your head and shoulders are in view"]
    if m["poses"] > 1:
        return ["Only one person in view, please"]
    tips = []
    if not m.get("shoulders_ok"):
        tips.append("Both shoulders need to be in view")
    sw = m.get("shoulder_w")
    if sw is not None and sw < SMALL_SHOULDER_W:
        tips.append("Move a little closer")
    elif sw is not None and sw > LARGE_SHOULDER_W:
        tips.append("Move back a little")
    if m.get("shoulders_ok") and not m.get("hips_ok"):
        tips.append("Step back to show your hips (for hip and lean measures)")
    if m.get("torso_ratio") is not None and m["torso_ratio"] < TURNED_RATIO:
        tips.append("Face the camera squarely")
    if m.get("frame_L", 100) < DIM_L and m.get("vis_shoulders", 1) < GOOD_VISIBILITY:
        tips.append("More light would help")  # a dark room alone is fine if the model is sure
    c = m.get("centre")
    if c and not (0.2 < c[0] < 0.8):
        tips.append("Move to the centre of the picture")
    return tips


def live(m):
    """The live status the browser shows while recording (numbers/words only)."""
    return {
        "poses": m.get("poses", 0),
        "usable": not frame_problems(m),
        "guidance": guidance(m),
        # a region counts as in view when both landmarks of a pair (or most of the head) are seen
        "visible": {name: m.get(f"seen_{name}", 0) >= LIVE_SEEN[name] for name in REGIONS} if m.get("poses") == 1 else {},
    }


# ---------------------------------------------------------------------------- the report

DISCLAIMER = ("Camera-based observations of posture and movement in the picture, not a medical "
              "assessment. They cannot detect or rule out any spinal, neurological, muscular or "
              "balance condition.")
GENERAL_LIMITATIONS = [
    "A single front-facing camera sees the body in 2D: forward/backward lean and rotation are not measured.",
    "Every angle includes the camera's own tilt; a laptop screen that isn't level shifts them all.",
    "Clothing, the chair, arm position and what you were doing during the 12 s all change the numbers.",
    "Results compare best with your own earlier sessions taken the same way, not with other people.",
]


def _obs(oid, name, description, limitations, value=None, unit="", display="", reliability="inconclusive", reason=""):
    measured = value is not None and reliability != "inconclusive"
    return {
        "id": oid, "name": name, "status": "measured" if measured else "inconclusive",
        "value": value if measured else None, "unit": unit if measured else "",
        "display": display if measured else "Inconclusive",
        "description": description, "reliability": reliability if measured else "inconclusive",
        "reliability_reason": reason, "limitations": limitations,
    }


def _side_text(deg, lower_word="lower"):
    """Signed tilt (+ = person's left lower) -> plain words."""
    if abs(deg) < LEVEL_DEG:
        return f"about level ({abs(deg):.1f}°)"
    return f"{abs(deg):.1f}° — {'left' if deg > 0 else 'right'} side {lower_word}"


def _vis_rel(mean_vis, frames, share):
    if mean_vis >= GOOD_VISIBILITY and share >= 0.8 and frames >= 60:
        return "high"
    if mean_vis >= 0.65 and share >= 0.6:
        return "medium"
    return "low"


def summarize(frames, duration_s):
    """frames: [{"t": seconds, ...frame_metrics}] for the whole window -> the report."""
    n = len(frames)
    fps = n / duration_s if duration_s > 0 else 0.0
    usable = [f for f in frames if not frame_problems(f)]
    share = len(usable) / n if n else 0.0
    multi = sum(1 for f in frames if f.get("poses", 0) > 1)
    none = sum(1 for f in frames if f.get("poses", 0) == 0)
    dark_none = sum(1 for f in frames if f.get("poses", 0) == 0 and f.get("frame_L", 100) < TOO_DARK_L)
    long_enough = duration_s >= MIN_WINDOW_S
    problem_counts = {}
    for f in frames:
        for p in frame_problems(f):
            problem_counts[p] = problem_counts.get(p, 0) + 1
    top_problem = max(problem_counts, key=problem_counts.get) if problem_counts else ""
    base_ok = long_enough and share >= MIN_VALID_SHARE and len(usable) >= MIN_FRAMES
    why_short = (f"only {duration_s:.1f} s recorded" if not long_enough else
                 (f"a usable body view in only {share:.0%} of frames" + (f" (mostly: {top_problem}, {problem_counts[top_problem]} of {n} frames)" if top_problem else "")) if share < MIN_VALID_SHARE else
                 f"only {len(usable)} usable frames" if len(usable) < MIN_FRAMES else "")

    # ---- detection quality & landmark visibility
    one = [f for f in frames if f.get("poses") == 1]
    vis = {name: (round(float(np.mean([f[f"vis_{name}"] for f in one])), 2) if one else None) for name in REGIONS}
    hips_frames = [f for f in usable if f.get("hips_ok")]
    hips_share = len(hips_frames) / len(usable) if usable else 0.0
    light = float(np.median([f["frame_L"] for f in frames])) if frames else None
    issues = []
    if light is not None and light < DIM_L:
        issues.append("dim lighting")
    if multi:
        issues.append("more than one person at times")
    if none and none < n / 2 and dark_none < n / 2:
        issues.append(f"no body found in {none} of {n} frames")
    if dark_none >= n / 2:
        issues.append("too dark to find a body")
    if usable and hips_share < 0.5:
        issues.append("hips not in view")
    if vis["shoulders"] is not None and vis["shoulders"] < 0.65:
        issues.append("low shoulder visibility")
    sizes = [f["shoulder_w"] for f in usable if f.get("shoulder_w") is not None]
    if sizes and float(np.median(sizes)) < SMALL_SHOULDER_W:
        issues.append("body small in the frame")
    if not one:
        rating = "poor" if (multi or dark_none >= n / 2) else "no body"
    elif share < MIN_VALID_SHARE or (multi and multi >= n / 2):
        rating = "poor"
    else:
        minor = [i for i in issues if i != "hips not in view"]  # sitting at a desk: expected
        rating = "good" if not minor else "fair" if len(minor) <= 2 else "poor"
    quality = {
        "rating": rating, "issues": issues, "frames": n, "usable_frames": len(usable),
        "usable_share": round(share, 3), "fps": round(fps, 1), "duration_s": round(duration_s, 1),
        "frame_light_L": None if light is None else round(light, 1),
        "no_body_frames": none, "multi_person_frames": multi,
        "hips_visible_share": round(hips_share, 3), "visibility": vis,
    }
    obs = []
    obs.append(_obs(
        "landmark_visibility", "Landmark visibility and confidence",
        "How confidently the model saw each body region (MediaPipe visibility, 0–1, averaged over frames with one person), and in how many frames the shoulders and hips were clearly in view.",
        ["Visibility is the model's own confidence, not a check against a real measurement.",
         "Regions out of the picture (often hips and legs at a desk) are expected to score low."],
        value={"regions": vis, "usable_frames": len(usable), "hips_visible_share": round(hips_share, 3)} if one else None,
        display=(", ".join(f"{k} {v:.2f}" for k, v in vis.items() if v is not None)) if one else "",
        reliability="high" if one else "inconclusive",
        reason=(f"{len(one)} of {n} frames had exactly one person" + (f"; {multi} had more than one" if multi else "") if one else
                f"more than one person in view in {multi} of {n} frames" if multi else
                f"too dark to find a body in {dark_none} of {n} frames" if dark_none >= n / 2 else "no body was seen"),
    ))

    names = (("shoulder_alignment", "Shoulder alignment"), ("hip_alignment", "Hip alignment"),
             ("torso_inclination", "Visible torso inclination"), ("head_position", "Head and upper-body position"),
             ("asymmetry", "Left/right landmark asymmetry"), ("movement", "Movement and stability"))
    if not usable:
        for oid, name in names:
            obs.append(_obs(oid, name, "", ["Not enough usable frames to measure."], reason=why_short or "no usable frames"))
        return {"quality": quality, "observations": obs, "limitations": GENERAL_LIMITATIONS, "disclaimer": DISCLAIMER}

    sh_vis = float(np.mean([f["vis_shoulders"] for f in usable]))
    rel = _vis_rel(sh_vis, len(usable), share)

    # ---- shoulder alignment
    st = np.array([f["shoulder_tilt"] for f in usable if f.get("shoulder_tilt") is not None])
    s_med = float(np.median(st)) if len(st) else None
    obs.append(_obs(
        "shoulder_alignment", "Shoulder alignment",
        "The angle of the line between your shoulders against the horizontal, in the picture (the median over the window), and which side sat lower.",
        ["Includes the camera's tilt.", "Shoulder landmarks are estimated through clothing; raised arms move them."],
        value=None if s_med is None else {"tilt_deg": round(s_med, 1), "lower_side": "level" if abs(s_med) < LEVEL_DEG else ("left" if s_med > 0 else "right"), "variation_sd_deg": round(float(st.std()), 1)},
        unit="°", display="" if s_med is None else f"{_side_text(s_med)}; varied ±{float(st.std()):.1f}°",
        reliability=rel if base_ok else "inconclusive",
        reason=why_short or f"{len(st)} usable frames, shoulder visibility {sh_vis:.2f}",
    ))

    # ---- hip alignment (only with the hips clearly in view)
    ht = np.array([f["hip_tilt"] for f in hips_frames if f.get("hip_tilt") is not None])
    hip_ok = base_ok and len(ht) >= MIN_FRAMES and hips_share >= 0.5
    h_med = float(np.median(ht)) if len(ht) else None
    hip_vis = float(np.mean([f["vis_hips"] for f in hips_frames])) if hips_frames else 0.0
    obs.append(_obs(
        "hip_alignment", "Hip alignment",
        "The angle of the line between your hip landmarks against the horizontal, in the picture, and which side sat lower.",
        ["Hip landmarks are estimated through clothing and are less precise than shoulders.", "Sitting, the chair and a desk in front all affect it.", "Includes the camera's tilt."],
        value=None if h_med is None else {"tilt_deg": round(h_med, 1), "lower_side": "level" if abs(h_med) < LEVEL_DEG else ("left" if h_med > 0 else "right"), "variation_sd_deg": round(float(ht.std()), 1)},
        unit="°", display="" if h_med is None else f"{_side_text(h_med)}; varied ±{float(ht.std()):.1f}°",
        reliability=("medium" if hip_vis >= GOOD_VISIBILITY else "low") if hip_ok else "inconclusive",
        reason=why_short or (f"hips clearly in view in only {hips_share:.0%} of usable frames: step back so your hips are in the picture" if not hip_ok else f"{len(ht)} frames with both hips in view, visibility {hip_vis:.2f}"),
    ))

    # ---- visible torso inclination (side-to-side only)
    tl = np.array([f["torso_lean"] for f in hips_frames if f.get("torso_lean") is not None])
    lean_ok = base_ok and len(tl) >= MIN_FRAMES and hips_share >= 0.5
    l_med = float(np.median(tl)) if len(tl) else None
    obs.append(_obs(
        "torso_inclination", "Visible torso inclination",
        "How far the middle of your shoulders sat to one side of the middle of your hips, as an angle from vertical in the picture (side-to-side lean only).",
        ["Forward or backward lean (slouching toward the screen) can't be seen from the front and isn't measured.", "Needs the hips in view.", "Includes the camera's tilt."],
        value=None if l_med is None else {"lean_deg": round(l_med, 1), "toward": "upright" if abs(l_med) < LEVEL_DEG else ("left" if l_med > 0 else "right"), "variation_sd_deg": round(float(tl.std()), 1)},
        unit="°", display="" if l_med is None else ("about upright" if abs(l_med) < LEVEL_DEG else f"leaning {abs(l_med):.1f}° toward your {'left' if l_med > 0 else 'right'}") + f"; varied ±{float(tl.std()):.1f}°",
        reliability=("medium" if hip_vis >= GOOD_VISIBILITY else "low") if lean_ok else "inconclusive",
        reason=why_short or ("the hips weren't in view often enough to measure lean" if not lean_ok else f"{len(tl)} frames with shoulders and hips in view"),
    ))

    # ---- head and upper-body position
    ho = np.array([f["head_offset"] for f in usable if f.get("head_offset") is not None])
    hh = np.array([f["head_height"] for f in usable if f.get("head_height") is not None])
    hd = np.array([f["head_tilt"] for f in usable if f.get("head_tilt") is not None])
    head_ok = base_ok and len(ho) >= MIN_FRAMES
    head_val = None
    head_disp = ""
    if len(ho):
        o = float(np.median(ho))
        head_val = {"offset_shoulder_widths": round(o, 2), "height_shoulder_widths": round(float(np.median(hh)), 2) if len(hh) else None,
                    "head_tilt_deg": round(float(np.median(hd)), 1) if len(hd) >= MIN_FRAMES else None}
        parts = ["head centred over the shoulders" if abs(o) < 0.05 else f"head {abs(o):.0%} of a shoulder width toward your {'left' if o > 0 else 'right'}"]
        if head_val["head_tilt_deg"] is not None:
            parts.append("head tilt " + _side_text(head_val["head_tilt_deg"], "ear lower"))
        if head_val["height_shoulder_widths"] is not None:
            parts.append(f"nose {head_val['height_shoulder_widths']:.2f} shoulder widths above the shoulder line")
        head_disp = "; ".join(parts)
    obs.append(_obs(
        "head_position", "Head and upper-body position",
        "Where your head sat relative to your shoulders: side-to-side offset of the nose from the shoulder centre, head tilt from the ear line, and how high the nose sat above the shoulder line (all in shoulder widths, so distance from the camera doesn't matter).",
        ["Forward head position can't be measured reliably from the front.", "Head height changes with camera height and looking up or down.", "Head tilt needs both ears visible (hair can hide them)."],
        value=head_val, display=head_disp,
        reliability=("medium" if rel == "high" else "low") if head_ok else "inconclusive",
        reason=why_short or ("the nose wasn't visible in enough frames" if not head_ok else f"{len(ho)} frames with the head in view" + ("" if len(hd) >= MIN_FRAMES else "; ears not visible enough for head tilt")),
    ))

    # ---- left/right landmark asymmetry
    asy = np.array([f["asymmetry"] for f in usable if f.get("asymmetry") is not None])
    asy_ok = base_ok and len(asy) >= MIN_FRAMES
    a_med = float(np.median(asy)) if len(asy) else None
    obs.append(_obs(
        "asymmetry", "Left/right landmark asymmetry",
        "How far the matching left and right landmarks (shoulders, elbows, wrists, hips when seen) were from mirror images of each other across the body's midline, in shoulder widths (0 = perfectly mirrored).",
        ["Arm and hand position dominate this number: resting one arm on the desk raises it.", "Describes the pose held in front of the camera, not the body's structure."],
        value=None if a_med is None else {"mean_shoulder_widths": round(a_med, 3), "variation_sd": round(float(asy.std()), 3)},
        display="" if a_med is None else f"{a_med:.2f} shoulder widths on average (0 = mirrored)",
        reliability="low" if asy_ok else "inconclusive",
        reason=why_short or ("not enough frames with two or more left/right pairs in view" if not asy_ok else f"{len(asy)} frames with two or more pairs in view"),
    ))

    # ---- movement and stability
    cs = [f for f in usable if f.get("centre") is not None and f.get("shoulder_w")]
    if len(cs) >= 2:
        cx = np.array([f["centre"][0] for f in cs]); cy = np.array([f["centre"][1] for f in cs])
        w_px = np.array([f["w"] for f in cs], dtype=float); h_px = np.array([f["h"] for f in cs], dtype=float)
        sw = float(np.median([f["shoulder_w"] for f in cs])) * float(np.median(w_px))
        x_px, y_px = cx * w_px, cy * h_px
        sway = float(math.hypot(x_px.std(), y_px.std()) / max(sw, 1e-6))
        steps = np.hypot(np.diff(x_px), np.diff(y_px)) / max(sw, 1e-6)
        dts = np.maximum(np.diff([f["t"] for f in cs]), 1e-3)
        speed = float(np.median(steps / dts))
        path = float(steps.sum())
        tilt_sd = float(st.std()) if len(st) else 0.0
        label = "very still" if sway < 0.03 else "mostly still" if sway < 0.08 else "some movement" if sway < 0.2 else "a lot of movement"
        mv_val = {"sway_shoulder_widths": round(sway, 3), "median_speed_shoulder_widths_per_s": round(speed, 3),
                  "path_shoulder_widths": round(path, 2), "shoulder_tilt_sd_deg": round(tilt_sd, 1), "label": label}
        mv_disp = f"{label}: swayed {sway:.2f} shoulder widths (SD), moved {speed:.2f} shoulder widths/s typically; shoulder angle varied ±{tilt_sd:.1f}°"
    else:
        mv_val, mv_disp = None, ""
    obs.append(_obs(
        "movement", "Movement and stability",
        "How much your upper body moved during the window: sway of the torso centre (standard deviation), typical speed, and how steady the shoulder angle stayed — in shoulder widths, so distance doesn't matter.",
        ["Includes the camera or laptop moving, and talking or gesturing.", "12 s of sitting or standing still in front of a laptop is not a balance test."],
        value=mv_val, display=mv_disp,
        reliability=rel if base_ok and mv_val else "inconclusive",
        reason=why_short or f"{len(cs)} frames with the upper body in view",
    ))
    return {"quality": quality, "observations": obs, "limitations": GENERAL_LIMITATIONS, "disclaimer": DISCLAIMER}
