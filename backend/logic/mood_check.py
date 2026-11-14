"""The daily mood check on the Mind & mood page: Astra asks 3 questions out loud, the
astronaut answers in their own words, and the AI judges today's mood from BOTH what they said
and how they sounded (the on-laptop voice-tone model, backend/services/emotion.py, via the
same conversation pipeline as "Wanna talk?" -- backend/logic/voice_talks.py).

The result is saved as an ordinary mood reading (source 'voice_check'), so the mood chart,
the Wellbeing ring, Trends, Today's mood task and the health AI all use it unchanged.

  questions_for(astro_id, day)  3 questions, the same all mission day, different the next
  tone_line(tone)               the voice-tone result as one line for the AI
  tone_mood(probabilities)      fallback: a mood from the tone alone
  judge(answers, tone)          the AI's verdict, or the fallback when it can't be reached
  save(conn, astro_id, ...)     the mood reading (+ Astra's memory note)
  today_result(conn, astro_id)  today's check, if done (for the card)
"""
import hashlib
import json
import random
from datetime import datetime, timezone

from backend import config
from backend.jobs import scheduler
from backend.logic import astra_memory, health_rules
from backend.services import analyst

QUESTIONS_PER_DAY = 3
MAX_ANSWER = 500
MOOD_SCORES = {"rough": 1, "low": 2, "okay": 3, "good": 4, "great": 5}
SCORE_MOOD = {v: k for k, v in MOOD_SCORES.items()}
SOURCE = "voice_check"

# How each voice tone leans, on the 1-5 mood scale (a demo mapping, PLACEHOLDER).
TONE_MOOD = {"happy": 5, "calm": 4, "surprised": 3, "sad": 2, "fearful": 2, "disgust": 1.5, "angry": 1}
TONE_WORDS = {"happy": "happy", "calm": "calm", "surprised": "surprised", "sad": "sad",
              "fearful": "worried", "disgust": "fed up", "angry": "tense"}

# Last resort, with neither the AI nor a voice tone: a tiny word list.
_LOW_WORDS = ("tired", "exhausted", "sad", "bad", "awful", "stressed", "worried", "anxious", "lonely",
              "angry", "sick", "pain", "hurt", "terrible", "frustrat", "miss", "upset", "rough", "low")
_HIGH_WORDS = ("great", "good", "happy", "fine", "excited", "rested", "calm", "amazing", "fantastic",
               "relaxed", "proud", "enjoy", "fun", "love", "well", "energ")


def mission_day(now=None):
    return scheduler.mission_clock(now)[0]


def questions_for(astro_id, day):
    """3 questions, fixed for this astronaut and mission day; a new set every day."""
    pool = list(config.mood_questions()["questions"])
    seed = int(hashlib.sha256(f"mood-check:{astro_id}:{day}".encode()).hexdigest()[:12], 16)
    return random.Random(seed).sample(pool, min(QUESTIONS_PER_DAY, len(pool)))


def tone_line(tone):
    """The voice-tone result (voice_talks.aggregate) as one line for the AI."""
    if not tone:
        return "not available (no voice clip was analysed)."
    probs = tone["probabilities"]
    top = sorted(probs.items(), key=lambda kv: -kv[1])[:3]
    mix = ", ".join(f"{k} {round(v * 100)}%" for k, v in top)
    return f"mostly {tone['dominant']} ({mix}) over {tone['phrases']} phrase(s). A model's estimate from how they sounded, not certain."


def tone_mood(probabilities):
    """The probability-weighted mood score of a voice-tone mix, rounded to a mood."""
    total = sum(probabilities.get(k, 0) for k in TONE_MOOD) or 1.0
    score = sum(TONE_MOOD[k] * probabilities.get(k, 0) for k in TONE_MOOD) / total
    return SCORE_MOOD[max(1, min(5, round(score)))], score


def _words_mood(answers):
    text = " ".join(a["text"].lower() for a in answers)
    low = sum(text.count(w) for w in _LOW_WORDS)
    high = sum(text.count(w) for w in _HIGH_WORDS)
    if low > high:
        return "low" if low - high > 1 else "okay"
    if high > low:
        return "good"
    return "okay"


def judge(answers, tone):
    """{mood, summary, emotions, source: "ai"|"rules", model?, error?}."""
    try:
        out = analyst.mood_check(answers, tone_line(tone))
        return {**out, "source": "ai", "model": analyst.model_name()}
    except analyst.AnalystError as exc:
        error = str(exc)
    if tone:
        mood, _ = tone_mood(tone["probabilities"])
        word = TONE_WORDS.get(tone["dominant"], tone["dominant"])
        summary = f"From your voice, you sounded mostly {word} today."
        emotions = [word]
    else:
        mood = _words_mood(answers)
        summary = f"From your answers, today looks {mood}."
        emotions = []
    return {"mood": mood, "summary": summary, "emotions": emotions, "source": "rules", "error": error}


def save(conn, astro_id, verdict, answers, tone, talk_id=None, now=None):
    """Store the check as a mood reading. Returns the stored value + its level."""
    now = now or datetime.now(timezone.utc)
    score = MOOD_SCORES[verdict["mood"]]
    level = health_rules.evaluate("mood", score)
    value = {
        "mood": verdict["mood"], "score": score, "note": verdict["summary"],
        "emotions": verdict.get("emotions", []), "checked_by": verdict["source"],
        "model": verdict.get("model"), "tone": tone, "talk_id": talk_id,
        "day": mission_day(), "answers": answers,
    }
    conn.execute(
        "INSERT INTO readings (astronaut_id, ts, indicator, value_json, level, source) VALUES (?, ?, 'mood', ?, ?, ?)",
        (astro_id, now.isoformat(), json.dumps(value), level, SOURCE),
    )
    astra_memory.note_mood(conn, astro_id, verdict["mood"])
    return {**value, "level": level, "ts": now.isoformat()}


def today_result(conn, astro_id, now=None):
    """Today's (this mission day's) latest check, or None."""
    day = mission_day(now)
    row = conn.execute(
        "SELECT ts, value_json, level FROM readings WHERE astronaut_id = ? AND indicator = 'mood' AND source = ? "
        "ORDER BY ts DESC LIMIT 1",
        (astro_id, SOURCE),
    ).fetchone()
    if not row:
        return None
    try:
        value = json.loads(row["value_json"])
    except (TypeError, ValueError):
        return None
    if value.get("day") != day:
        return None
    return {**value, "level": row["level"], "ts": row["ts"]}


def clean_answers(raw, questions):
    """The client's answers, validated: one non-empty answer (<= MAX_ANSWER chars) per
    question of the day, in order. Returns (answers, error)."""
    if not isinstance(raw, list) or len(raw) != len(questions):
        return None, f"{len(questions)} answers are needed"
    out = []
    for q, a in zip(questions, raw):
        text = a.get("text") if isinstance(a, dict) else a
        if not isinstance(text, str) or not text.strip():
            return None, "every question needs an answer"
        out.append({"question": q, "text": " ".join(text.split())[:MAX_ANSWER]})
    return out, None
