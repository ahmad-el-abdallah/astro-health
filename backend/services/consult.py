"""NVIDIA-hosted AI for the Body tab's Consultation chat only -- nothing
else in this app calls out to the internet (docs/build-prompt.md section 4's
"fully offline" rule still holds everywhere else). Entirely optional: with
no key configured, available() is False and the caller (routes.py) is
expected to fall back to the Body tab's own keyword-matching reply, same
"degrades gracefully with zero setup" posture as simulation mode / the
offline serial queue elsewhere in this app.

Model picked by actually querying GET /v1/models with a real key and test-
calling candidates -- most of the catalog 404s ("Function ... Not found for
account") since not every listed model is enabled for every account.

Briefly switched the default to the much larger nvidia/nemotron-3-ultra-550b-a55b
for noticeably better reasoning on multi-symptom/ambiguous messages -- but at
~4-8s per reply (vs. this model's ~1s), once the Face to Face voice mode
shipped that latency read as "stuck," not "thinking," in a live spoken
conversation (user feedback, same day) -- reverted back to
nemotron-3.5-lightning-30b-a3b for both the typed chat and voice. The ultra
model is still a one-line NVIDIA_CHAT_MODEL env var away if the tradeoff
is ever worth it again. Defaults to emitting a long chain-of-thought into
`reasoning_content` and leaving `content` empty unless told not to --
chat_template_kwargs: {"thinking": false} turns that off.
"""
import json
import urllib.error
import urllib.request
import os

from backend.config import nvidia_api_key

API_URL = "https://integrate.api.nvidia.com/v1/chat/completions"
DEFAULT_MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b"
MODEL = os.environ.get("NVIDIA_CHAT_MODEL", DEFAULT_MODEL)
TIMEOUT_S = 12
RETRY_NOTE = (
    "Your last reply wasn't valid JSON (or was missing a usable 'reply' field). "
    "Respond again with ONLY the JSON object, no markdown fence, no other text."
)


class ConsultError(Exception):
    """Raised for any failure talking to NVIDIA or making sense of its
    reply -- callers never get a half-broken result, only a clean decision
    or this one exception to catch and fall back on."""


class MalformedOutputError(ConsultError):
    """The call succeeded but the model's own output couldn't be used (bad
    JSON, missing 'reply') -- the one failure mode ask() retries once,
    unlike network/timeout/empty-content failures where retrying just
    doubles the wait before the caller falls back anyway."""


def available():
    return nvidia_api_key() is not None


def _system_prompt(astro_name, mission_label, mission_hazard_lines, body_parts, symptoms_catalog=(),
                    elevated_today=None, schedule_lines=None, trend_lines=None, rewards_line=None):
    region_block = "\n".join(
        f'- "{rid}" ({info["label"]}): {info["what_it_does"]} In spaceflight: {info["space_effects"]} '
        f'What to do: {info["what_to_do"]}'
        for rid, info in body_parts.items()
    )
    symptom_block = "\n".join(f'- "{s["id"]}" ({s["label"]})' for s in symptoms_catalog)
    hazards = ("\n".join(mission_hazard_lines) + "\n") if mission_hazard_lines else ""
    elevated = (
        "\nAlready flagged today (context only -- mention naturally if relevant, don't force it "
        "into every reply):\n" + "\n".join(elevated_today) + "\n"
    ) if elevated_today else ""
    schedule = (
        "\nToday's schedule (the day's plan -- not a live record of what's already been done):\n"
        + "\n".join(schedule_lines) + "\n"
    ) if schedule_lines else ""
    trends = (
        "\nRecent vital trends (context only, use if relevant to the conversation):\n"
        + "\n".join(trend_lines) + "\n"
    ) if trend_lines else ""
    rewards = f"\n{rewards_line}\n" if rewards_line else ""
    return (
        "You are a self-care triage assistant inside a NASA Space Apps hackathon demo "
        "called Astro Health Station. All data here is PLACEHOLDER demo data, not real "
        "telemetry, and you are not a real doctor -- never claim to be one or give a "
        "diagnosis. Ground every reply in real spaceflight self-care context: isolation "
        "and confinement, radiation exposure, microgravity effects on bone/muscle/fluid "
        "shifts, and a crew with limited medical supplies and a delayed link to Earth. "
        "For anything that sounds severe or dangerous, tell the astronaut to alert the "
        "flight surgeon -- do not try to talk them out of escalating, and you can send that "
        "alert yourself in this chat the moment they explicitly ask you to. Be proactive, not "
        "just reactive: when relevant, volunteer one concrete next step in your reply -- a "
        "specific self-care action, a follow-up question, or (for anything severe) that they "
        "can have you alert the flight surgeon -- rather than only answering the literal "
        "question asked.\n\n"
        f"Astronaut: {astro_name}. Mission: {mission_label}.\n"
        f"{hazards}"
        f"{elevated}"
        f"{schedule}"
        f"{trends}"
        f"{rewards}\n"
        "The body regions you may log, with this app's own guidance for each -- ground your "
        "replies in this, not generic knowledge, since the astronaut sees this same text "
        "elsewhere in the app and your answer should stay consistent with it:\n"
        f"{region_block}\n\n"
        "The known symptom catalog -- separate from the body regions above, and not mutually "
        "exclusive with them (a message can set both a region/intensity AND a symptom id):\n"
        f"{symptom_block}\n\n"
        "The conversation may include earlier turns -- use them for context (for example, a "
        "symptom described as getting worse, or a follow-up answer to something you asked).\n"
        "If a message mentions more than one symptom in different body regions, pick the single "
        "most prominent one for region/intensity and mention the other symptom in your reply "
        "text without logging it separately.\n\n"
        "VITALS: if the astronaut states an EXPLICIT numeric vital reading in this message -- a "
        "heart rate, blood pressure, blood sugar, or temperature with an actual number attached "
        "(e.g. 'my heart rate is 140', 'set my temperature to 38.2', 'blood pressure 150 over "
        "95', 'blood sugar is 180') -- set \"vital\" to a JSON object with exactly one of these "
        "keys: \"heart_rate\" (bpm, a number), \"blood_pressure\" ({\"systolic\": number, "
        "\"diastolic\": number}, mmHg), \"blood_sugar\" (mg/dL, a number), or \"temperature\" "
        "(degrees Celsius, a number -- this app uses Celsius, not Fahrenheit). Never set "
        "\"vital\" from vague language with no number ('my heart is racing', 'I feel hot') -- "
        "only an astronaut-stated number may be logged. If no explicit numeric vital is given "
        "this message, set \"vital\" to null.\n\n"
        "FLIGHT SURGEON ALERT: only set \"alert_surgeon\" to true when the astronaut explicitly "
        "asks you, in this message, to notify, tell, alert, or message the flight surgeon (e.g. "
        "'tell the flight surgeon', 'send an alert about this', 'let the surgeon know'). Never "
        "set it to true just because a symptom sounds severe -- for severe-sounding symptoms, "
        "say in your reply that they can ask you to alert the flight surgeon, but only their own "
        "explicit request sets this field. When true, also set \"alert_text\" to a short (under "
        "120 characters) third-person summary of what to tell the flight surgeon, grounded in "
        "this conversation. If \"alert_surgeon\" is false, set \"alert_text\" to null.\n\n"
        "BREATHING EXERCISE: if the astronaut asks to be walked through a breathing exercise, "
        "set \"start_breathing\" to true and use \"reply\" to actually guide a short technique "
        "(e.g. 4-7-8: breathe in for 4 seconds, hold for 7, exhale for 8) with explicit counted "
        "steps -- for this one case only, \"reply\" may be longer than the usual 1-2 sentence "
        "cap. Otherwise set \"start_breathing\" to false.\n\n"
        "EMERGENCY: only set \"trigger_emergency\" to true if the astronaut unmistakably asks "
        "for emergency help right now, in unambiguous words ('I need help right now', 'this is "
        "an emergency', 'call for help immediately') -- NOT for a severe-sounding symptom alone. "
        "A severe symptom should get \"alert_surgeon\" (if they ask) or a strong recommendation "
        "in \"reply\" to ask for emergency help explicitly -- never infer \"trigger_emergency\" "
        "from pain or fear language by itself. When true, set \"emergency_text\" to a short "
        "factual description for the alert. If false, set \"emergency_text\" to null.\n\n"
        "Respond with ONLY a single JSON object, no markdown code fence, no extra text "
        "before or after it, shaped exactly like:\n"
        '{"region": "<one of the ids above, or null>", "intensity": <integer 0-10, or null>, '
        '"vital": <object with exactly one vital key, or null>, '
        '"alert_surgeon": <true or false>, "alert_text": "<short summary, or null>", '
        '"symptom": "<one of the symptom ids above, or null>", '
        '"start_breathing": <true or false>, '
        '"trigger_emergency": <true or false>, "emergency_text": "<short description, or null>", '
        '"reply": "<a SHORT 1-2 sentence reply to show the astronaut (longer only when guiding '
        'a breathing exercise) -- this gets spoken aloud by text-to-speech, so every extra '
        'sentence directly adds to how long the astronaut waits to hear you; be concise>"}\n'
        "Set region and intensity to null if the message doesn't describe a specific "
        "body-region symptom with a severity (a greeting, a question, something unrelated). "
        "Never invent a region id, symptom id, or vital key that isn't listed above."
    )


def _call_once(messages):
    """The raw network call. Raises plain ConsultError on any failure here
    -- these are never retried (network/timeout/empty-content failures gain
    nothing from a retry but a doubled wait)."""
    key = nvidia_api_key()
    if not key:
        raise ConsultError("no NVIDIA API key configured")

    payload = {
        "model": MODEL,
        "messages": messages,
        "temperature": 0.2,
        "max_tokens": 230,
        "chat_template_kwargs": {"thinking": False},
    }
    req = urllib.request.Request(
        API_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
        raise ConsultError(f"NVIDIA request failed: {exc}") from exc

    try:
        content = body["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ConsultError("unexpected NVIDIA response shape") from exc
    if not content:
        raise ConsultError("NVIDIA response had no content (reasoning likely ate the token budget)")
    return content


def ask(message, astro_name, mission_label, mission_hazard_lines, body_parts, symptoms_catalog=(),
        history=None, elevated_today=None, schedule_lines=None, trend_lines=None, rewards_line=None):
    """Raises ConsultError on any failure. On success returns a dict with
    keys region/intensity/vital/alert_surgeon/alert_text/symptom/
    start_breathing/trigger_emergency/emergency_text/reply -- see
    parse_model_output() for exact types and validation.

    `history`: a list of {"role": "user"|"assistant", "content": str} prior
    turns, already sanitized/truncated by the caller (routes.py) -- this
    function trusts it and just forwards it.
    `symptoms_catalog`: config/symptoms.json's list of {"id","label",...}
    dicts (same shape symptoms.catalog() returns) -- used both to build the
    prompt's symptom list and to validate the model's "symptom" field.
    `elevated_today`/`schedule_lines`/`trend_lines`/`rewards_line`:
    pre-formatted context strings, or None/empty if there's nothing to add
    -- built by the caller (routes.py) from data this app already has
    elsewhere (the body tab's own alert box, config/routine.json, the
    readings table, the rewards route).
    """
    system = {"role": "system", "content": _system_prompt(
        astro_name, mission_label, mission_hazard_lines, body_parts, symptoms_catalog,
        elevated_today, schedule_lines, trend_lines, rewards_line,
    )}
    messages = [system] + (history or []) + [{"role": "user", "content": message}]
    known_region_ids = set(body_parts.keys())
    known_symptom_ids = {s["id"] for s in symptoms_catalog}

    content = _call_once(messages)
    try:
        return parse_model_output(content, known_region_ids, known_symptom_ids)
    except MalformedOutputError:
        retry_messages = messages + [
            {"role": "assistant", "content": content},
            {"role": "user", "content": RETRY_NOTE},
        ]
        content = _call_once(retry_messages)
        return parse_model_output(content, known_region_ids, known_symptom_ids)  # if this also raises, propagate -- caller falls back


# Loose sanity bounds on a stated vital -- confirmed against config/health_rules.json's real
# GREEN/YELLOW bands (heart_rate green 60-100/yellow to 120; blood_sugar green 70-99/yellow to
# 179; temperature is Celsius, green 36.1-37.5/yellow to 38.0; blood_pressure mmHg, systolic
# green 90-129, diastolic green 60-79). These ranges are deliberately far wider than even the
# YELLOW bands -- they only exist to catch a hallucinated/impossible number (a stray "-50" or
# "99999"), never to second-guess a real RED reading the astronaut actually stated.
_VITAL_RANGES = {
    "heart_rate": (30, 250),
    "blood_sugar": (20, 600),
    "temperature": (30, 43),
}
_BP_SYSTOLIC_RANGE = (50, 250)
_BP_DIASTOLIC_RANGE = (30, 150)


def _is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _validate_vital(vital):
    """Returns a clean {"<one key>": <value>} dict, or None if anything
    about the shape/type/range is off -- same "no half-decision" philosophy
    as region/intensity, just for a differently-shaped field."""
    if not isinstance(vital, dict) or len(vital) != 1:
        return None
    (key, value), = vital.items()
    if key == "blood_pressure":
        if not isinstance(value, dict) or set(value.keys()) != {"systolic", "diastolic"}:
            return None
        systolic, diastolic = value.get("systolic"), value.get("diastolic")
        if not _is_number(systolic) or not _is_number(diastolic):
            return None
        if not (_BP_SYSTOLIC_RANGE[0] <= systolic <= _BP_SYSTOLIC_RANGE[1]):
            return None
        if not (_BP_DIASTOLIC_RANGE[0] <= diastolic <= _BP_DIASTOLIC_RANGE[1]):
            return None
        return {"blood_pressure": {"systolic": systolic, "diastolic": diastolic}}
    if key not in _VITAL_RANGES or not _is_number(value):
        return None
    lo, hi = _VITAL_RANGES[key]
    if not (lo <= value <= hi):
        return None
    return {key: value}


def parse_model_output(content, known_region_ids, known_symptom_ids=frozenset()):
    """Pure, network-free -- the actual risk surface, and what tests target
    directly with fake `content` strings."""
    text = content.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise MalformedOutputError(f"model did not return valid JSON: {exc}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("reply"), str) or not data["reply"].strip():
        raise MalformedOutputError("model response missing a usable 'reply'")

    region = data.get("region")
    if region not in known_region_ids:
        region = None

    intensity = data.get("intensity")
    if isinstance(intensity, bool) or not isinstance(intensity, int) or not (0 <= intensity <= 10):
        intensity = None

    # A region with no intensity (or vice versa) can't be logged -- treat as
    # "no decision" rather than guessing a number/region.
    if region is None or intensity is None:
        region, intensity = None, None

    vital = _validate_vital(data.get("vital"))

    # alert_surgeon/alert_text follow the exact same "null/false together, never a half-decision"
    # rule as region/intensity above -- an alert with no text, or text with the flag off, is
    # discarded as a pair rather than guessed at.
    alert_surgeon = data.get("alert_surgeon")
    if not isinstance(alert_surgeon, bool):
        alert_surgeon = False
    alert_text = data.get("alert_text")
    alert_text = alert_text.strip() if isinstance(alert_text, str) and alert_text.strip() else None
    if alert_surgeon and alert_text is None:
        alert_surgeon = False
    if not alert_surgeon:
        alert_text = None

    symptom = data.get("symptom")
    if symptom not in known_symptom_ids:
        symptom = None

    start_breathing = data.get("start_breathing")
    if not isinstance(start_breathing, bool):
        start_breathing = False

    # trigger_emergency/emergency_text: same pairing rule as alert_surgeon/alert_text above --
    # this is the highest-stakes field here, but the pairing *code* is identical; the real safety
    # gate is the system prompt's strict wording (precision over recall), not extra validation.
    trigger_emergency = data.get("trigger_emergency")
    if not isinstance(trigger_emergency, bool):
        trigger_emergency = False
    emergency_text = data.get("emergency_text")
    emergency_text = emergency_text.strip() if isinstance(emergency_text, str) and emergency_text.strip() else None
    if trigger_emergency and emergency_text is None:
        trigger_emergency = False
    if not trigger_emergency:
        emergency_text = None

    return {
        "region": region,
        "intensity": intensity,
        "vital": vital,
        "alert_surgeon": alert_surgeon,
        "alert_text": alert_text,
        "symptom": symptom,
        "start_breathing": start_breathing,
        "trigger_emergency": trigger_emergency,
        "emergency_text": emergency_text,
        "reply": data["reply"].strip(),
    }
