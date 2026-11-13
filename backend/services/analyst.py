"""The AI health analyst: one call to an OpenAI-compatible chat API (Groq's free plan by
default -- see backend/config.py's AI_* settings) that reads one astronaut's data and
decides what's going on: a state (sleeping, possibly sick...), per-indicator and
per-body-region levels, an overall level, a short explanation, advice, and whether to
alert the flight surgeon.

Nothing here touches the database. backend/logic/analysis.py builds the context, calls
analyze(), and applies the result -- or falls back to the threshold rules when this
raises AnalystError (no key, no internet, rate limit, or an answer that doesn't pass
parse()). The model's output is never trusted as-is: parse() validates every field.

Uses only the standard library (urllib), so no new dependency.
"""
import json
import re
import time
import urllib.error
import urllib.request

from backend import config

TIMEOUT_S = 20
MAX_TOKENS = 900
BACKOFF_S = 60          # after a 429 / network failure, don't hammer the API
LEVELS = ("GREEN", "YELLOW", "RED")
USER_AGENT = "astro-health-station/1.0"
REGIONS = ("brain", "eyes", "heart", "stomach", "skeleton", "muscles", "immune")
MAX_SUMMARY = 300
MAX_REPLY = 600          # the chat's spoken limit too (frontend useVoice speaks <= 600 chars)
CHAT_MAX_TOKENS = 900
CHAT_BUDGET_S = 22       # a whole chat turn, retries included (the page gives up at 30 s)
MIN_RETRY_S = 5
MAX_ITEM = 160

_backoff_until = 0.0


class AnalystError(Exception):
    """Any reason the AI's answer can't be used; the caller falls back to the rules."""


class MalformedOutputError(AnalystError):
    """The model answered, but not with valid JSON in the expected shape (retried once)."""


def available():
    return config.ai_api_key() is not None and time.time() >= _backoff_until


def model_name():
    return config.AI_MODEL


def _system_prompt(cfg):
    states = ", ".join(f'"{s["id"]}" ({s["label"]})' for s in cfg["states"])
    return (
        "\n".join(cfg["instructions"])
        + "\n\nAnswer with ONLY one JSON object, no other text, in exactly this shape:\n"
        '{"state": <one of: ' + states + '>,\n'
        ' "overall_level": "GREEN"|"YELLOW"|"RED",\n'
        ' "indicator_levels": {<indicator id from the data>: "GREEN"|"YELLOW"|"RED", ...},\n'
        ' "body_levels": {<body region id>: "GREEN"|"YELLOW"|"RED", ...},\n'
        ' "summary": "<1-2 sentences>",\n'
        ' "reasons": ["<short fact>", ...],\n'
        ' "advice": ["<short step>", ...],\n'
        ' "alert_surgeon": true|false}\n'
        "Rate every indicator that has a reading in the last 24 hours. Body region ids: "
        + ", ".join(REGIONS) + " (rate only regions the data says something about)."
    )


def _call_once(messages, max_tokens=MAX_TOKENS, timeout=TIMEOUT_S):
    global _backoff_until
    key = config.ai_api_key()
    if not key:
        raise AnalystError("no AI API key configured")
    payload = {
        "model": config.AI_MODEL,
        "messages": messages,
        "temperature": 0.2,
        "max_tokens": max_tokens,
        "response_format": {"type": "json_object"},
    }
    if config.AI_MODEL.startswith("openai/gpt-oss"):
        payload["reasoning_effort"] = "low"  # gpt-oss thinks first; keep it short and fast
    req = urllib.request.Request(
        f"{config.AI_BASE_URL}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        # A real User-Agent matters: Groq's Cloudflare front door answers Python's default
        # "Python-urllib/x" with 403 "error code: 1010" -- it looks like a bad key, but isn't.
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json",
                 "Accept": "application/json", "User-Agent": USER_AGENT},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 429:
            retry = exc.headers.get("retry-after") if exc.headers else None
            try:
                wait = float(retry)
            except (TypeError, ValueError):
                wait = BACKOFF_S
            _backoff_until = time.time() + min(max(wait, 5), 600)
            raise AnalystError("AI rate limit reached") from exc
        if exc.code in (401, 403):
            raise AnalystError("AI key was rejected") from exc
        if exc.code == 400:
            # Groq answers 400 "json_validate_failed" when the model's JSON came out broken
            # (asked for json_object). That's a bad answer, not a bad request: hand the broken
            # text back, so the caller's parse can still rescue it or retry once with a nudge.
            try:
                err = json.loads(exc.read().decode("utf-8")).get("error", {})
            except (ValueError, AttributeError, OSError):
                err = {}
            if isinstance(err, dict) and err.get("code") == "json_validate_failed":
                return str(err.get("failed_generation") or "")
        raise AnalystError(f"AI request failed (HTTP {exc.code})") from exc
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        _backoff_until = time.time() + 15
        raise AnalystError(f"AI unreachable: {exc}") from exc
    try:
        content = body["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise AnalystError("unexpected AI response shape") from exc
    if not content or not content.strip():
        raise MalformedOutputError("AI returned an empty answer")
    return content


def _level(v, what):
    if v not in LEVELS:
        raise MalformedOutputError(f"{what} is not GREEN/YELLOW/RED")
    return v


def _text(v, what, cap):
    if not isinstance(v, str) or not v.strip():
        raise MalformedOutputError(f"{what} must be non-empty text")
    return v.strip()[:cap]


def _text_list(v, what, max_items):
    if v is None:
        return []
    if not isinstance(v, list):
        raise MalformedOutputError(f"{what} must be a list")
    return [x.strip()[:MAX_ITEM] for x in v if isinstance(x, str) and x.strip()][:max_items]


def parse(raw, state_ids, indicator_ids):
    """Strictly validates the model's JSON. Raises MalformedOutputError on anything
    unusable; silently drops harmless extras (unknown indicators/regions)."""
    text = (raw or "").strip()
    if text.startswith("```"):
        text = text.strip("`")
        text = text[text.find("{"):] if "{" in text else text
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        raise MalformedOutputError("no JSON object in the answer")
    try:
        data = json.loads(text[start:end + 1])
    except json.JSONDecodeError as exc:
        raise MalformedOutputError("answer is not valid JSON") from exc
    if not isinstance(data, dict):
        raise MalformedOutputError("answer is not a JSON object")

    if data.get("state") not in state_ids:
        raise MalformedOutputError("unknown state")
    alert = data.get("alert_surgeon", False)
    if not isinstance(alert, bool):  # "yes", 1, etc. are not accepted
        raise MalformedOutputError("alert_surgeon must be true or false")

    indicator_levels = {}
    for k, v in (data.get("indicator_levels") or {}).items():
        if k in indicator_ids:
            indicator_levels[k] = _level(v, f"level for {k}")
    body_levels = {}
    for k, v in (data.get("body_levels") or {}).items():
        if k in REGIONS:
            body_levels[k] = _level(v, f"level for {k}")

    return {
        "state": data["state"],
        "overall_level": _level(data.get("overall_level"), "overall_level"),
        "indicator_levels": indicator_levels,
        "body_levels": body_levels,
        "summary": _text(data.get("summary"), "summary", MAX_SUMMARY),
        "reasons": _text_list(data.get("reasons"), "reasons", 4),
        "advice": _text_list(data.get("advice"), "advice", 3),
        "alert_surgeon": alert,
    }


def analyze(context_text, indicator_ids, cfg=None):
    """context_text: the astronaut's data as compact plain text (analysis.build_context).
    indicator_ids: indicators that actually have readings (anything else is dropped).
    Returns parse()'s dict. Raises AnalystError on any failure."""
    if not available():
        raise AnalystError("AI is not configured or is cooling down after an error")
    cfg = cfg or config.ai_analyst()
    state_ids = {s["id"] for s in cfg["states"]}
    messages = [
        {"role": "system", "content": _system_prompt(cfg)},
        {"role": "user", "content": context_text},
    ]
    raw = _call_once(messages)
    try:
        return parse(raw, state_ids, set(indicator_ids))
    except MalformedOutputError as first:
        # One retry, showing the model its own bad answer -- only for a malformed
        # answer, never for network/limit errors (those raised above already).
        messages += [
            {"role": "assistant", "content": raw[:2000]},
            {"role": "user", "content": f"That answer was invalid ({first}). Reply again with ONLY the JSON object in the exact shape asked."},
        ]
        return parse(_call_once(messages), state_ids, set(indicator_ids))


# ---------------------------------------------------------------- Astra, the crew's chat

PAGES = ("overview", "body", "trends", "mind", "sleep", "mission", "schedule")
MOODS = ("rough", "low", "okay", "good", "great")
MAX_ACTIONS = 4
# Loose sanity limits for vitals said out loud -- a mishearing like "heart rate 720" is
# dropped rather than saved. Units match config/health_rules.json (temperature in °C).
VITAL_LIMITS = {
    "heart_rate": (30, 250), "blood_sugar": (20, 600), "temperature": (30, 43),
    "oxygen_saturation": (50, 100),
}
BP_LIMITS = {"systolic": (50, 250), "diastolic": (30, 150)}


SUMMARY_PERIODS = ("today", "week")
NO_FIELD_ACTIONS = ("start_sleep", "stop_sleep", "start_workout", "stop_workout", "take_vitals", "breathing", "reaction_test")
# Done straight away, without a yes/no card: they don't save health data or send anything
# (a guided activity only saves its result at the end, and has a Stop button).
ACTIVITIES = ("breathing", "reaction_test", "measure_guide")
NO_CONFIRM = ("navigate", "remember", "forget", "emergency") + ACTIVITIES
MAX_MESSAGE = 500


def _chat_prompt(cfg, symptom_ids=(), guide_ids=()):
    return (
        "\n".join(cfg["chat_instructions"])
        + "\n\nAnswer with ONLY one JSON object, no other text, in exactly this shape:\n"
        '{"reply": "<what you say to the astronaut>", "actions": [<zero or more actions>]}\n'
        "Actions you can take (use only these shapes, at most 4):\n"
        '- {"type": "navigate", "page": one of ' + ", ".join(f'"{p}"' for p in PAGES) + "}\n"
        '- {"type": "log_mood", "mood": one of ' + ", ".join(f'"{m}"' for m in MOODS) + ', "note": "<optional short note>"}\n'
        '- {"type": "log_sleep", "bedtime": "HH:MM", "wake_time": "HH:MM"} (24-hour clock)\n'
        '- {"type": "log_symptoms", "items": [symptom ids from: ' + ", ".join(f'"{s}"' for s in symptom_ids) + "]}\n"
        '- {"type": "log_vitals", any of "heart_rate" (bpm), "blood_pressure" {"systolic", "diastolic"} (mmHg), '
        '"blood_sugar" (mg/dL), "temperature" (°C), "oxygen_saturation" (%)}\n'
        '- {"type": "log_discomfort", "region": one of ' + ", ".join(f'"{r}"' for r in REGIONS) + ', "intensity": 0-10}\n'
        '- {"type": "journal", "title": "<short title>", "body": "<what they asked you to write>"}\n'
        '- {"type": "alert_surgeon", "text": "<short message for the flight surgeon>"} (urgent: something is wrong)\n'
        '- {"type": "message_surgeon", "text": "<their message, in their words>"} (a normal, non-urgent message)\n'
        '- {"type": "send_summary", "period": "today" or "week"} (a health summary report to the flight surgeon)\n'
        '- {"type": "start_sleep"} / {"type": "stop_sleep"} (going to bed / woke up: sleep tracking)\n'
        '- {"type": "start_workout"} / {"type": "stop_workout"} (workout tracking)\n'
        '- {"type": "take_vitals"} (take a new vitals reading with the station sensors)\n'
        '- {"type": "breathing"} (a guided 1-minute breathing exercise) / {"type": "reaction_test"} (a 5-tap reaction test)\n'
        '- {"type": "measure_guide", "indicator": one of ' + ", ".join(f'"{g}"' for g in guide_ids) + "} (step-by-step how to measure it)\n"
        '- {"type": "remember", "text": "<short note>", "follow_up_hours": optional 1-72} (a lasting fact or an '
        "ongoing problem worth remembering; follow_up_hours if you should ask about it again later)\n"
        '- {"type": "forget", "id": <memory number>} (they ask you to forget a remembered note)\n'
        '- {"type": "emergency", "text": "<what is happening>"} ONLY for an unmistakable call for help right now '
        "(\"I need help now\", \"emergency\", \"I can't breathe\"). Feeling bad or scared is NOT an emergency: "
        "use alert_surgeon or advice. The app counts down 5 seconds so they can cancel.\n"
        "Rules: only use values the astronaut actually said (never invent a reading or a time; if "
        "pain has no number, estimate it from their words). For anything that saves or sends "
        "(every action except navigate, remember, forget, emergency, breathing, reaction_test and "
        "measure_guide), your reply must say what you will do and ask them to confirm, e.g. \"Should I "
        "log your mood as low?\" -- the app does it only after they say yes. For navigate, just say where "
        "you are taking them; for remember, say you'll remember it; for emergency, say you're calling for "
        "help and they can say cancel; for breathing, reaction_test and measure_guide, say in ONE short "
        "sentence that you're starting it (the app runs it and reads the steps itself, so never list the steps). "
        "If they only chat, actions is []. If your reply offers to do something, the matching action MUST be in actions.\n"
        "Examples:\n"
        '"my mood is low, I\'m stressed" -> {"reply": "Should I log your mood as low, with the note stressed?", '
        '"actions": [{"type": "log_mood", "mood": "low", "note": "stressed"}]}\n'
        '"write in my journal: the run felt easy" -> {"reply": "Should I add that to your journal?", '
        '"actions": [{"type": "journal", "title": "The run", "body": "The run felt easy."}]}\n'
        '"tell the flight surgeon I feel dizzy" -> {"reply": "Should I send the flight surgeon an alert that you feel dizzy?", '
        '"actions": [{"type": "alert_surgeon", "text": "I feel dizzy."}]}\n'
        '"take me to trends" -> {"reply": "Opening Trends.", "actions": [{"type": "navigate", "page": "trends"}]}\n'
        '"tell the doctor I slept well and feel fine" -> {"reply": "Should I send the flight surgeon a message that you slept well and feel fine?", '
        '"actions": [{"type": "message_surgeon", "text": "I slept well and feel fine."}]}\n'
        '"I\'m going to bed" -> {"reply": "Should I start your sleep tracking? Good night.", "actions": [{"type": "start_sleep"}]}\n'
        '"how do I measure my blood pressure?" -> {"reply": "Let\'s do it step by step.", "actions": [{"type": "measure_guide", "indicator": "blood_pressure"}]}\n'
        '"my left knee has hurt since Tuesday" -> {"reply": "I\'ll remember that and check on it later. How bad is it, from 0 to 10?", '
        '"actions": [{"type": "remember", "text": "Left knee has hurt since Tuesday", "follow_up_hours": 6}]}'
    )


# "Should I log …?" with no action attached would make the astronaut's "yes" do nothing.
_OFFERS_TO_SAVE = re.compile(r"\b(should i|shall i|do you want me to|want me to|would you like me to)\b", re.I)


def _offers_without_action(out):
    return not any(a["type"] not in NO_CONFIRM for a in out["actions"]) and bool(_OFFERS_TO_SAVE.search(out["reply"]))


def _num(v, lo, hi):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and lo <= v <= hi


def _hhmm(v):
    if not isinstance(v, str) or len(v) != 5 or v[2] != ":":
        return None
    try:
        h, m = int(v[:2]), int(v[3:])
    except ValueError:
        return None
    return v if 0 <= h <= 23 and 0 <= m <= 59 else None


def _clean_action(a, symptom_ids, guide_ids=()):
    """One action dict -> its validated form, or None to drop it."""
    if not isinstance(a, dict):
        return None
    kind = a.get("type")
    if kind == "navigate":
        return {"type": kind, "page": a["page"]} if a.get("page") in PAGES else None
    if kind == "log_mood":
        if a.get("mood") not in MOODS:
            return None
        note = a.get("note") if isinstance(a.get("note"), str) else ""
        return {"type": kind, "mood": a["mood"], "note": note.strip()[:200]}
    if kind == "log_sleep":
        bed, wake = _hhmm(a.get("bedtime")), _hhmm(a.get("wake_time"))
        return {"type": kind, "bedtime": bed, "wake_time": wake} if bed and wake and bed != wake else None
    if kind == "log_symptoms":
        items = a.get("items")
        if not isinstance(items, list):
            return None
        items = [i for i in dict.fromkeys(items) if isinstance(i, str) and i in symptom_ids]
        return {"type": kind, "items": items} if items else None
    if kind == "log_vitals":
        out = {k: a[k] for k, (lo, hi) in VITAL_LIMITS.items() if k in a and _num(a[k], lo, hi)}
        bp = a.get("blood_pressure")
        if isinstance(bp, dict) and all(_num(bp.get(k), lo, hi) for k, (lo, hi) in BP_LIMITS.items()):
            out["blood_pressure"] = {"systolic": bp["systolic"], "diastolic": bp["diastolic"]}
        return {"type": kind, **out} if out else None
    if kind == "log_discomfort":
        region, intensity = a.get("region"), a.get("intensity")
        ok = region in REGIONS and isinstance(intensity, int) and not isinstance(intensity, bool) and 0 <= intensity <= 10
        return {"type": kind, "region": region, "intensity": intensity} if ok else None
    if kind == "journal":
        body = a.get("body") if isinstance(a.get("body"), str) else ""
        title = a.get("title") if isinstance(a.get("title"), str) else ""
        if not body.strip():
            return None
        return {"type": kind, "title": (title.strip() or body.strip()[:40])[:120], "body": body.strip()[:2000]}
    if kind in ("alert_surgeon", "emergency"):
        text = a.get("text") if isinstance(a.get("text"), str) else ""
        if kind == "emergency":
            return {"type": kind, "text": (text.strip() or "Emergency called by voice")[:200]}
        return {"type": kind, "text": text.strip()[:200]} if text.strip() else None
    if kind == "message_surgeon":
        text = a.get("text") if isinstance(a.get("text"), str) else ""
        return {"type": kind, "text": text.strip()[:MAX_MESSAGE]} if text.strip() else None
    if kind == "send_summary":
        return {"type": kind, "period": a["period"]} if a.get("period") in SUMMARY_PERIODS else None
    if kind in NO_FIELD_ACTIONS:
        return {"type": kind}
    if kind == "measure_guide":
        return {"type": kind, "indicator": a["indicator"]} if a.get("indicator") in guide_ids else None
    if kind == "remember":
        text = a.get("text") if isinstance(a.get("text"), str) else ""
        if not text.strip():
            return None
        out = {"type": kind, "text": " ".join(text.split())[:200]}
        if _num(a.get("follow_up_hours"), 1, 72):
            out["follow_up_hours"] = a["follow_up_hours"]
        return out
    if kind == "forget":
        mid = a.get("id")
        return {"type": kind, "id": mid} if isinstance(mid, int) and not isinstance(mid, bool) and mid > 0 else None
    return None


def parse_chat(raw, symptom_ids=(), guide_ids=()):
    """Validates the chat answer: a reply (required, MalformedOutputError otherwise) and up to
    MAX_ACTIONS actions, each checked on its own -- a bad one is dropped, never half-saved.
    An older-style top-level region/intensity becomes a log_discomfort action."""
    text = (raw or "").strip()
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        raise MalformedOutputError("no JSON object in the answer")
    try:
        data = json.loads(text[start:end + 1])
    except json.JSONDecodeError as exc:
        raise MalformedOutputError("answer is not valid JSON") from exc
    if not isinstance(data, dict):
        raise MalformedOutputError("answer is not a JSON object")
    reply = _text(data.get("reply"), "reply", MAX_REPLY)
    raw_actions = data.get("actions") if isinstance(data.get("actions"), list) else []
    if data.get("region") is not None:
        raw_actions = raw_actions + [{"type": "log_discomfort", "region": data.get("region"), "intensity": data.get("intensity")}]
    actions = []
    for a in raw_actions:
        cleaned = _clean_action(a, set(symptom_ids), set(guide_ids))
        if cleaned and cleaned not in actions:
            actions.append(cleaned)
        if len(actions) == MAX_ACTIONS:
            break
    return {"reply": reply, "actions": actions}


_NO_ACTIONS_NOTE = (
    "\n\nIMPORTANT: you are talking to the flight surgeon about this crew member, not to the "
    "crew member. You cannot save anything or open pages for them: always return \"actions\": [] "
    "and never offer to log or save something; just answer their question from the data."
)


def chat(context_text, history, message, symptom_ids=(), cfg=None, can_act=True, guide_ids=()):
    """One Astra chat turn. history: [{"role": "user"|"assistant", "content": str}, ...]
    (already sanitized by the route). can_act=False (the surgeon asking about a crew
    member): she answers but never offers or returns actions. Raises AnalystError."""
    if not available():
        raise AnalystError("AI is not configured or is cooling down after an error")
    cfg = cfg or config.ai_analyst()
    system = _chat_prompt(cfg, symptom_ids, guide_ids) + ("" if can_act else _NO_ACTIONS_NOTE)
    messages = [
        {"role": "system", "content": system + "\n\nThe astronaut's current data:\n" + context_text},
        *history,
        {"role": "user", "content": message},
    ]
    # The whole turn (first answer + any retry) must fit CHAT_BUDGET_S, so a slow AI can never
    # leave the astronaut on "Thinking…" for a minute: a retry only happens if there's time.
    deadline = time.monotonic() + CHAT_BUDGET_S

    def left():
        return deadline - time.monotonic()

    raw = _call_once(messages, max_tokens=CHAT_MAX_TOKENS, timeout=min(TIMEOUT_S, CHAT_BUDGET_S))
    try:
        out = parse_chat(raw, symptom_ids, guide_ids)
    except MalformedOutputError as first:
        if left() < MIN_RETRY_S:
            raise
        messages += [
            {"role": "assistant", "content": raw[:2000]},
            {"role": "user", "content": f"That answer was invalid ({first}). Reply again with ONLY the JSON object in the exact shape asked."},
        ]
        out = parse_chat(_call_once(messages, max_tokens=CHAT_MAX_TOKENS, timeout=left()), symptom_ids, guide_ids)
        if not can_act:
            out["actions"] = []
        return out
    if not can_act:
        out["actions"] = []
        return out
    if _offers_without_action(out) and left() >= MIN_RETRY_S:
        # One more try: the reply offers to save something, so the action must be there.
        messages += [
            {"role": "assistant", "content": raw[:2000]},
            {"role": "user", "content": "Your reply offers to save something, but actions is empty. Reply again with ONLY the JSON object, including the action(s) you offered."},
        ]
        try:
            retry = parse_chat(_call_once(messages, max_tokens=CHAT_MAX_TOKENS, timeout=left()), symptom_ids, guide_ids)
            if not _offers_without_action(retry):
                return retry
        except AnalystError:
            pass
    return out


# ---------------------------------------------------------------- health summary report

SUMMARY_MAX_TOKENS = 500


def summary(context_text, period, cfg=None):
    """A short health summary for the flight surgeon, written from the astronaut's data
    ("today" or the last 7 days). Plain text, at most MAX_REPLY characters. Raises AnalystError."""
    if not available():
        raise AnalystError("AI is not configured or is cooling down after an error")
    span = "today (the last 24 hours)" if period == "today" else "the last 7 days"
    messages = [
        {"role": "system", "content": (
            "You write a short health summary report from a crew member to their flight surgeon "
            f"on Earth, covering {span}. Use ONLY the data given; never invent readings. Mention "
            "anything out of range, the trend of the key vitals, sleep, mood, symptoms or pain, and "
            "what the crew member is doing about it. 3-5 plain sentences, no lists, no markdown, "
            'no greeting. Answer with ONLY a JSON object: {"summary": "<the report>"}'
        )},
        {"role": "user", "content": context_text},
    ]
    raw = _call_once(messages, max_tokens=SUMMARY_MAX_TOKENS, timeout=TIMEOUT_S)
    text = (raw or "").strip()
    start, end = text.find("{"), text.rfind("}")
    try:
        data = json.loads(text[start:end + 1]) if start != -1 and end != -1 else {}
    except json.JSONDecodeError:
        data = {}
    out = data.get("summary") if isinstance(data, dict) else None
    if not isinstance(out, str) or not out.strip():
        raise MalformedOutputError("no summary in the answer")
    return " ".join(out.split())[:MAX_REPLY]
