""""Wanna talk?" conversations: one row per conversation in `voice_talks`, so each phrase's
voice tone estimate (`voice_tone`) belongs to exactly one conversation, and the Mind page's
"Latest Conversation Analysis" is computed from THAT conversation's phrases only.

Life of a conversation (the browser drives it, lib/toneTalks.js):
  open    POST .../voice-talks                 -> a new, server-made talk_id (status "active")
  phrase  POST .../voice-tone?talk=<id>        -> accepted only while the talk is active or
                                                  analysing, and only for its own astronaut
  close   POST .../voice-talks/<id>/close      -> the call ended; phrases_sent known; any
                                                  still-running analyses may yet arrive
                                                  (status "analysing" = the page shows loading)
  finish  POST .../voice-talks/<id>/finish     -> every pending analysis settled in the
                                                  browser: the result is computed and stored
                                                  (status "complete", or "failed" if every
                                                  analysis attempt failed)
A browser that never says "finish" (tab closed mid-analysis) doesn't leave the page loading
forever: finalize_stale() completes such talks from whatever phrases arrived, after
STALE_ANALYSING_S once closed, or STALE_ACTIVE_S without any news while still "active".

The result is the plain average of the seven probabilities over the conversation's analysed
phrases (each phrase counts once), renormalised to sum to 1; the dominant tone is the
highest of those averages. Nothing here ever reads or stores audio.
"""
import json
import uuid
from datetime import datetime, timedelta, timezone

from backend.services import emotion

STALE_ANALYSING_S = 90
STALE_ACTIVE_S = 30 * 60
STATUSES = ("active", "analysing", "complete", "failed")


def _now():
    return datetime.now(timezone.utc)


def new_talk_id():
    return "talk-" + uuid.uuid4().hex  # 37 chars, fits the voice-tone route's talk id pattern


KINDS = ("talk", "mood_check")  # "Wanna talk?" / the daily mood check (backend/logic/mood_check.py)


def create(conn, astronaut_id, kind="talk"):
    talk_id = new_talk_id()
    now = _now().isoformat()
    conn.execute(
        "INSERT INTO voice_talks (id, astronaut_id, started_at, updated_at, status, kind) VALUES (?, ?, ?, ?, 'active', ?)",
        (talk_id, astronaut_id, now, now, kind if kind in KINDS else "talk"),
    )
    return get(conn, talk_id)


def get(conn, talk_id):
    row = conn.execute("SELECT * FROM voice_talks WHERE id = ?", (talk_id,)).fetchone()
    return dict(row) if row else None


def accepts_phrases(talk, astronaut_id):
    """(ok, http_status, message) -- may a phrase be added to this talk for this astronaut?"""
    if not talk or talk["astronaut_id"] != astronaut_id:
        return False, 404, "unknown conversation"
    if talk["status"] not in ("active", "analysing"):
        return False, 409, "that conversation is already finished"
    return True, 200, ""


def touch(conn, talk_id):
    conn.execute("UPDATE voice_talks SET updated_at = ? WHERE id = ?", (_now().isoformat(), talk_id))


def close(conn, talk_id, phrases_sent):
    """The call ended. Idempotent; never reopens a finished talk."""
    now = _now().isoformat()
    conn.execute(
        "UPDATE voice_talks SET status = 'analysing', ended_at = COALESCE(ended_at, ?), updated_at = ?, "
        "phrases_sent = MAX(phrases_sent, ?) WHERE id = ? AND status = 'active'",
        (now, now, int(phrases_sent), talk_id),
    )
    return get(conn, talk_id)


def aggregate(conn, talk_id):
    """{dominant, confidence, probabilities{7}, phrases} from THIS talk's analysed phrases only,
    or None when it has none."""
    rows = conn.execute("SELECT scores_json FROM voice_tone WHERE talk_id = ? ORDER BY id", (talk_id,)).fetchall()
    vectors = []
    for r in rows:
        try:
            scores = json.loads(r["scores_json"])
        except (TypeError, ValueError):
            continue
        if isinstance(scores, dict) and all(isinstance(scores.get(k), (int, float)) for k in emotion.LABELS):
            vectors.append([float(scores[k]) for k in emotion.LABELS])
    if not vectors:
        return None
    mean = [sum(v[i] for v in vectors) / len(vectors) for i in range(len(emotion.LABELS))]
    total = sum(mean) or 1.0
    probs = {k: round(m / total, 4) for k, m in zip(emotion.LABELS, mean)}
    dominant = max(probs, key=probs.get)
    return {"dominant": dominant, "confidence": probs[dominant], "probabilities": probs, "phrases": len(vectors)}


def finish(conn, talk_id, phrases_sent=0, phrases_skipped=0, phrases_failed=0, reason="finished"):
    """Every pending analysis has settled: store the conversation's result. Idempotent (a
    second finish leaves the first result alone)."""
    talk = get(conn, talk_id)
    if not talk:
        return None
    if talk["status"] in ("complete", "failed"):
        return talk
    result = aggregate(conn, talk_id)
    analysed = result["phrases"] if result else 0
    sent = max(int(phrases_sent), int(talk["phrases_sent"] or 0), analysed)
    failed = max(0, int(phrases_failed))
    status = "failed" if not analysed and failed else "complete"
    now = _now().isoformat()
    conn.execute(
        "UPDATE voice_talks SET status = ?, ended_at = COALESCE(ended_at, ?), finished_at = ?, updated_at = ?, "
        "phrases_sent = ?, phrases_analysed = ?, phrases_skipped = ?, phrases_failed = ?, result_json = ?, finish_reason = ? "
        "WHERE id = ?",
        (status, now, now, now, sent, analysed, max(0, int(phrases_skipped)), failed,
         json.dumps(result) if result else None, reason, talk_id),
    )
    return get(conn, talk_id)


def finalize_stale(conn, astronaut_id=None, now=None):
    """Finish talks the browser never finished (closed tab, crash). Returns how many."""
    now = now or _now()
    analysing_before = (now - timedelta(seconds=STALE_ANALYSING_S)).isoformat()
    active_before = (now - timedelta(seconds=STALE_ACTIVE_S)).isoformat()
    q = ("SELECT id FROM voice_talks WHERE ((status = 'analysing' AND updated_at < ?) OR (status = 'active' AND updated_at < ?))")
    args = [analysing_before, active_before]
    if astronaut_id is not None:
        q += " AND astronaut_id = ?"
        args.append(astronaut_id)
    ids = [r["id"] for r in conn.execute(q, args).fetchall()]
    for talk_id in ids:
        finish(conn, talk_id, reason="timed out")
    return len(ids)


def public(talk):
    """The API shape (no internal columns)."""
    if not talk:
        return None
    return {
        "talk_id": talk["id"],
        "status": talk["status"],
        "started_at": talk["started_at"],
        "ended_at": talk["ended_at"],
        "finished_at": talk["finished_at"],
        "phrases_sent": talk["phrases_sent"] or 0,
        "phrases_analysed": talk["phrases_analysed"] or 0,
        "phrases_skipped": talk["phrases_skipped"] or 0,
        "phrases_failed": talk["phrases_failed"] or 0,
        "finish_reason": talk["finish_reason"],
        "result": json.loads(talk["result_json"]) if talk["result_json"] else None,
    }


def latest(conn, astronaut_id):
    """The latest conversation that has ENDED (analysing / complete / failed) -- the one the
    Mind page shows. A call still in progress isn't "the latest conversation analysis" yet."""
    finalize_stale(conn, astronaut_id)
    row = conn.execute(
        "SELECT * FROM voice_talks WHERE astronaut_id = ? AND status != 'active' AND kind = 'talk' "
        "ORDER BY COALESCE(ended_at, started_at) DESC, started_at DESC LIMIT 1",
        (astronaut_id,),
    ).fetchone()
    talk = public(dict(row)) if row else None
    if talk and talk["status"] == "analysing":
        # progress so far, for the loading state
        talk["phrases_analysed"] = conn.execute("SELECT COUNT(*) FROM voice_tone WHERE talk_id = ?", (talk["talk_id"],)).fetchone()[0]
    return talk
