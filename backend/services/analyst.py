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
CHAT_MAX_TOKENS = 600
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


def _call_once(messages, max_tokens=MAX_TOKENS):
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
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
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


# ---------------------------------------------------------------- the crew's Doctor AI chat

def _chat_prompt(cfg):
    return (
        "\n".join(cfg["chat_instructions"])
        + "\n\nAnswer with ONLY one JSON object, no other text, in exactly this shape:\n"
        '{"reply": "<what you say to the astronaut>",\n'
        ' "region": <one of ' + ", ".join(f'"{r}"' for r in REGIONS) + ' or null>,\n'
        ' "intensity": <whole number 0-10 or null>}\n'
        "Set region and intensity only when the astronaut describes pain or discomfort in a body "
        "region and how strong it is (if they give no number, estimate it from their words); "
        "otherwise both are null."
    )


def parse_chat(raw):
    """Validates the chat answer. A bad region/intensity drops BOTH (never half a log);
    a missing reply is MalformedOutputError."""
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
    region, intensity = data.get("region"), data.get("intensity")
    valid = (region in REGIONS and isinstance(intensity, int) and not isinstance(intensity, bool)
             and 0 <= intensity <= 10)
    return {"reply": reply, "region": region if valid else None, "intensity": intensity if valid else None}


def chat(context_text, history, message, cfg=None):
    """One Doctor AI chat turn. history: [{"role": "user"|"assistant", "content": str}, ...]
    (already sanitized by the route). Raises AnalystError on any failure."""
    if not available():
        raise AnalystError("AI is not configured or is cooling down after an error")
    cfg = cfg or config.ai_analyst()
    messages = [
        {"role": "system", "content": _chat_prompt(cfg) + "\n\nThe astronaut's current data:\n" + context_text},
        *history,
        {"role": "user", "content": message},
    ]
    raw = _call_once(messages, max_tokens=CHAT_MAX_TOKENS)
    try:
        return parse_chat(raw)
    except MalformedOutputError as first:
        messages += [
            {"role": "assistant", "content": raw[:2000]},
            {"role": "user", "content": f"That answer was invalid ({first}). Reply again with ONLY the JSON object in the exact shape asked."},
        ]
        return parse_chat(_call_once(messages, max_tokens=CHAT_MAX_TOKENS))
