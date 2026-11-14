"""REST API and Socket.IO event wiring (see docs/build-prompt.md sections
9 and 12). create_routes(app, socketio, bridge) is called once from app.py.
"""
import csv
import io
import json
import math
import re
import time
from datetime import datetime, timedelta, timezone

from flask import Blueprint, jsonify, request, Response
from werkzeug.security import check_password_hash, generate_password_hash

from backend import db, seed
from backend.logic import analysis, astra_memory, exercise, location, mood_check, sensor_feed, sessions, health_rules, symptoms, voice_talks
from backend.jobs import comms, scheduler
from backend.hardware import protocol
from backend.auth import auth, admin_auth
from backend.services import analyst, emotion, voice
from backend import voice_settings
from backend.config import (
    content as load_content, missions as load_missions,
    mission_health as load_mission_health,
    routine as load_routine, exercises as load_exercises,
    TIME_SCALE,
)


def row(r):
    return dict(r) if r else None


def rows(rs):
    return [dict(r) for r in rs]


_TALK_ID = re.compile(r"[A-Za-z0-9_-]{1,40}")  # groups one "Wanna talk?" conversation's phrases


# ---- login: shared by the NFC/password/Face ID auth routes below ----

FACE_MATCH_THRESHOLD = 0.6  # field-standard Euclidean threshold -- face-api.js's own default,
                            # also what the Python face_recognition/dlib library uses.


def _valid_descriptor(d):
    return (
        isinstance(d, list) and len(d) == 128
        and all(isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) for x in d)
        # isinstance(x, bool) check: isinstance(True, int) is True in Python.
    )


def _face_distance(a, b):
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))


def _login_response(astro):
    """Same shape returned by every successful login route AND /auth/me, so
    the frontend has one consistent object regardless of which method was
    used. has_password/has_face_id are booleans only -- never the hash or
    the descriptor itself."""
    return {
        "astronaut_id": astro["id"],
        "name": astro["name"],
        "role": astro["role"],
        "username": astro["username"],
        "has_password": bool(astro["password_hash"]),
        "has_face_id": bool(astro["face_descriptor_json"]),
    }


def _authorize_self_or_superuser(conn, astro_id):
    """For an astronaut's own login-credential routes: lets them manage
    their own password/Face ID, or lets a superuser reset it for them
    (account recovery) -- mirrors authorize_view's self-or-surgeon shape,
    but deliberately NOT the Flight Surgeon here: seeing crew health data
    is that role's privilege, resetting someone's login credentials is a
    different kind of power and shouldn't ride along with it."""
    if auth.current_astronaut_id() == astro_id:
        return True, None
    _, err = admin_auth.authorize_superuser(conn)
    if err is None:
        return True, None
    if auth.current_astronaut_id() is not None:
        # Logged in, just as the wrong astronaut and not a superuser --
        # "forbidden," not "not logged in."
        return False, ({"error": "forbidden"}, 403)
    return False, err


def _parse_json_fields(d, *fields):
    for f in fields:
        if f in d and isinstance(d[f], str):
            try:
                d[f] = json.loads(d[f])
            except ValueError:
                pass
    return d


def _compute_body_levels(conn, astro_id):
    """Vitals-only level per body region, from the last 24h of readings
    (same logic astronaut_summary always used, factored out so
    /discomfort/report can reuse it without trusting a client-supplied level)."""
    today_levels = {}
    eva_since = location.eva_since(conn, astro_id)
    for ind_row in conn.execute(
        "SELECT indicator, level, ts FROM readings WHERE astronaut_id = ? AND ts >= ? ORDER BY ts DESC",
        (astro_id, (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()),
    ):
        if not location.counts(ind_row["indicator"], ind_row["ts"], eva_since):
            continue
        if ind_row["indicator"] not in today_levels:
            today_levels[ind_row["indicator"]] = ind_row["level"]
    body_cfg = load_content()["body_parts"]
    body_levels = {}
    for part in body_cfg:
        part_levels = [lvl for ind, lvl in today_levels.items() if health_rules.body_part_for(ind) == part]
        body_levels[part] = health_rules.overall_level(part_levels) if part_levels else "GRAY"
    latest = analysis.latest(conn, astro_id)
    if latest and latest["source"] == "ai" and _analysis_is_current(conn, astro_id, latest):
        body_levels.update({k: v for k, v in latest["body_levels"].items() if k in body_levels})
    return body_levels


def _analysis_is_current(conn, astro_id, latest):
    """True when the analysis already saw the newest reading/symptom (so it can be shown
    as today's verdict); False while a newer reading is still waiting to be analyzed."""
    newest = conn.execute(
        "SELECT MAX(t) AS t FROM (SELECT MAX(ts) AS t FROM readings WHERE astronaut_id = ? "
        "UNION ALL SELECT MAX(ts) FROM symptoms WHERE astronaut_id = ?)", (astro_id, astro_id),
    ).fetchone()["t"]
    return newest is None or latest["ts"] >= newest


def _today_snapshot(conn, astro_id):
    """The last 24 h for one astronaut, shared by /summary (Overview) and /crew (the
    Flight Surgeon's crew cards): latest reading per indicator, latest symptom report,
    and a single status -- the worst of those, or GRAY ("no data") when there's nothing."""
    since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
    eva_since = location.eva_since(conn, astro_id)
    today = {}
    for r in conn.execute(
        "SELECT indicator, value_json, level, ts FROM readings WHERE astronaut_id = ? AND ts >= ? ORDER BY ts DESC",
        (astro_id, since),
    ):
        if not location.counts(r["indicator"], r["ts"], eva_since):
            continue  # a suit reading from outside the current spacewalk
        if r["indicator"] not in today:
            today[r["indicator"]] = {"value": json.loads(r["value_json"]), "level": r["level"], "ts": r["ts"]}
    sym = conn.execute(
        "SELECT items_json, level, ts FROM symptoms WHERE astronaut_id = ? AND ts >= ? ORDER BY ts DESC LIMIT 1",
        (astro_id, since),
    ).fetchone()
    symptoms_today = {"items": json.loads(sym["items_json"]), "level": sym["level"], "ts": sym["ts"]} if sym else None
    levels = [v["level"] for v in today.values()] + ([symptoms_today["level"]] if symptoms_today else [])
    latest = analysis.latest(conn, astro_id)
    current = bool(latest) and _analysis_is_current(conn, astro_id, latest)
    if not levels:
        status = "GRAY"
    elif current:
        status = latest["overall_level"]  # the AI's (or the fallback's) whole-picture verdict
    else:
        status = health_rules.overall_level(levels)
    return {
        "today": today,
        "symptoms_today": symptoms_today,
        "location": location.get(conn, astro_id),
        "sensor": sensor_feed.status(astro_id),
        "status": status,
        "analysis": latest,
        "analysis_current": current,
        "analysis_pending": analysis.is_pending(astro_id),
    }


def _latest_discomfort(conn, astro_id):
    """region -> most recently logged 0-10 discomfort intensity, same
    'first row wins per key' idiom astronaut_summary uses for today_levels."""
    discomfort = {}
    for r in conn.execute(
        "SELECT region, intensity FROM discomfort WHERE astronaut_id = ? ORDER BY ts DESC", (astro_id,)
    ):
        if r["region"] not in discomfort:
            discomfort[r["region"]] = r["intensity"]
    return discomfort


def _discomfort_band(intensity):
    """0-10 slider value -> a level, same thresholds the frontend slider
    uses so the blended color the user sees matches what gets escalated."""
    if intensity >= 7:
        return health_rules.RED
    if intensity >= 4:
        return health_rules.YELLOW
    return health_rules.GREEN


CHAT_HISTORY_TURNS = 8
CHAT_MSG_CHARS = 500


def _sanitize_history(raw):
    """The real trust boundary for chat history: last CHAT_HISTORY_TURNS turns, roles
    exactly user/assistant (a smuggled {"role": "system"} turn is dropped), capped text."""
    if not isinstance(raw, list):
        return []
    out = []
    for item in raw[-CHAT_HISTORY_TURNS:]:
        if not isinstance(item, dict):
            continue
        role, content = item.get("role"), item.get("content")
        if role in ("user", "assistant") and isinstance(content, str) and content.strip():
            out.append({"role": role, "content": content.strip()[:CHAT_MSG_CHARS]})
    return out


# Older CYD firmware's idle timeout is 2 minutes; anything this quiet is that timeout.
CYD_IDLE_GUESS_S = 100


def _save_reaction(conn, astro_id, avg_ms, lapses, source, raw=None):
    """A reaction-time reading (CYD test or Astra's voice-screen test), judged against this
    astronaut's own baseline. Returns the level."""
    baseline = conn.execute("SELECT baseline_reaction_ms FROM astronauts WHERE id = ?", (astro_id,)).fetchone()[0]
    lvl = health_rules.evaluate("reaction_time", (avg_ms, lapses), baseline_reaction_ms=baseline)
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "INSERT INTO readings (astronaut_id, ts, indicator, value_json, level, source) VALUES (?, ?, 'reaction_time', ?, ?, ?)",
        (astro_id, now, json.dumps({"avg_ms": avg_ms, "lapses": lapses}), lvl, source),
    )
    conn.execute(
        "INSERT INTO activities (astronaut_id, kind, started_at, ended_at, data_json) VALUES (?, 'reaction', ?, ?, ?)",
        (astro_id, now, now, json.dumps(raw or {"avg_ms": avg_ms, "lapses": lapses})),
    )
    return lvl


def _save_breathing(conn, astro_id, seconds):
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "INSERT INTO activities (astronaut_id, kind, started_at, ended_at, data_json) VALUES (?, 'breathing', ?, ?, ?)",
        (astro_id, now, now, json.dumps({"seconds": seconds})),
    )


def create_routes(app, socketio, bridge):
    bp = Blueprint("api", __name__, url_prefix="/api")

    def send_fn(line):
        bridge.send(line)

    def emit_fn(event, data):
        socketio.emit(event, data)

    analysis.configure(send_fn, emit_fn)

    # ---- auth: NFC-card login (the main method), plus username/password and
    # Face ID as real, working alternatives. All three funnel into the same
    # auth.login()/_login_response() shape, so the frontend treats a
    # successful login the same way regardless of which method was used. ----
    @bp.post("/auth/nfc_login")
    def nfc_login():
        uid = (request.get_json(force=True) or {}).get("uid")
        with db.write_conn() as conn:
            tag = conn.execute("SELECT * FROM tags WHERE uid = ?", (uid,)).fetchone()
            if not tag or tag["astronaut_id"] is None:
                return jsonify({"error": "that card isn't assigned to a crew member yet"}), 404
            astro = conn.execute("SELECT * FROM astronauts WHERE id = ?", (tag["astronaut_id"],)).fetchone()
        auth.login(astro["id"])
        return jsonify(_login_response(astro))

    @bp.post("/auth/password_login")
    def password_login():
        body = request.get_json(force=True) or {}
        username = (body.get("username") or "").strip().lower()
        password = body.get("password") or ""
        with db.write_conn() as conn:
            astro = conn.execute("SELECT * FROM astronauts WHERE username = ?", (username,)).fetchone()
        if not astro or not astro["password_hash"] or not check_password_hash(astro["password_hash"], password):
            return jsonify({"error": "invalid username or password"}), 401
        auth.login(astro["id"])
        return jsonify(_login_response(astro))

    @bp.post("/auth/face_login")
    def face_login():
        descriptor = (request.get_json(force=True) or {}).get("descriptor")
        if not _valid_descriptor(descriptor):
            return jsonify({"error": "invalid face descriptor"}), 400
        with db.write_conn() as conn:
            candidates = conn.execute(
                "SELECT * FROM astronauts WHERE face_descriptor_json IS NOT NULL"
            ).fetchall()
        # The identity decision happens entirely here, server-side, against
        # descriptors this server already stored -- the browser only ever
        # supplies a fresh measurement, never an identity claim, so a client
        # can't just assert "I'm astronaut 3" to log in as someone else.
        best, best_dist = None, None
        for astro in candidates:
            dist = _face_distance(descriptor, json.loads(astro["face_descriptor_json"]))
            if best_dist is None or dist < best_dist:
                best, best_dist = astro, dist
        if best is None or best_dist > FACE_MATCH_THRESHOLD:
            return jsonify({"error": "face not recognized"}), 401
        auth.login(best["id"])
        return jsonify(_login_response(best))

    @bp.post("/auth/logout")
    def auth_logout():
        astro_id = auth.current_astronaut_id()
        auth.logout()
        # Logging out from the browser now ends that astronaut's CYD session
        # too, if they have one open -- the mirror image of the CYD's "Done"
        # button logging the browser out (see "logout_requested" above).
        # Only touches a session that's actually theirs; doesn't disturb
        # some other astronaut's session if this one already ended/timed out.
        if astro_id is not None and astro_id in sessions.active_sessions:
            sessions.end_session_for(astro_id, send_fn, emit_fn)
        return jsonify({"ok": True})

    @bp.get("/auth/me")
    def auth_me():
        with db.write_conn() as conn:
            astro = auth.current_astronaut(conn)
        if not astro:
            return jsonify({"astronaut_id": None})
        return jsonify(_login_response(astro))

    # ---- account & security: self-service login-method management, plus a
    # superuser recovery path (see _authorize_self_or_superuser above) ----
    @bp.get("/astronauts/<int:astro_id>/account")
    def get_account(astro_id):
        with db.write_conn() as conn:
            _, err = auth.authorize_view(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
            astro = conn.execute("SELECT * FROM astronauts WHERE id = ?", (astro_id,)).fetchone()
            if not astro:
                return jsonify({"error": "not found"}), 404
            tag = conn.execute(
                "SELECT uid FROM tags WHERE astronaut_id = ? AND type IN ('astronaut','surgeon')", (astro_id,)
            ).fetchone()
        return jsonify({
            "username": astro["username"],
            "has_password": bool(astro["password_hash"]),
            "has_face_id": bool(astro["face_descriptor_json"]),
            "nfc_uid": tag["uid"] if tag else None,
        })

    @bp.post("/astronauts/<int:astro_id>/password")
    def set_password(astro_id):
        body = request.get_json(force=True) or {}
        username = (body.get("username") or "").strip().lower()
        password = body.get("password") or ""
        if not (3 <= len(username) <= 40):
            return jsonify({"error": "username must be 3-40 characters"}), 400
        if len(password) < 4:
            return jsonify({"error": "password must be at least 4 characters"}), 400
        with db.write_conn() as conn:
            ok, err = _authorize_self_or_superuser(conn, astro_id)
            if not ok:
                return jsonify(err[0]), err[1]
            astro = conn.execute("SELECT * FROM astronauts WHERE id = ?", (astro_id,)).fetchone()
            if not astro:
                return jsonify({"error": "not found"}), 404
            taken = conn.execute(
                "SELECT id FROM astronauts WHERE username = ? AND id != ?", (username, astro_id)
            ).fetchone()
            if taken:
                return jsonify({"error": "that username is already taken"}), 409
            conn.execute(
                "UPDATE astronauts SET username = ?, password_hash = ? WHERE id = ?",
                (username, generate_password_hash(password), astro_id),
            )
        return jsonify({"ok": True, "username": username})

    @bp.post("/astronauts/<int:astro_id>/face_id")
    def set_face_id(astro_id):
        descriptor = (request.get_json(force=True) or {}).get("descriptor")
        if not _valid_descriptor(descriptor):
            return jsonify({"error": "invalid face descriptor"}), 400
        with db.write_conn() as conn:
            ok, err = _authorize_self_or_superuser(conn, astro_id)
            if not ok:
                return jsonify(err[0]), err[1]
            astro = conn.execute("SELECT * FROM astronauts WHERE id = ?", (astro_id,)).fetchone()
            if not astro:
                return jsonify({"error": "not found"}), 404
            conn.execute(
                "UPDATE astronauts SET face_descriptor_json = ? WHERE id = ?",
                (json.dumps(descriptor), astro_id),
            )
        return jsonify({"ok": True})

    @bp.delete("/astronauts/<int:astro_id>/face_id")
    def clear_face_id(astro_id):
        with db.write_conn() as conn:
            ok, err = _authorize_self_or_superuser(conn, astro_id)
            if not ok:
                return jsonify(err[0]), err[1]
            astro = conn.execute("SELECT * FROM astronauts WHERE id = ?", (astro_id,)).fetchone()
            if not astro:
                return jsonify({"error": "not found"}), 404
            conn.execute("UPDATE astronauts SET face_descriptor_json = NULL WHERE id = ?", (astro_id,))
        return jsonify({"ok": True})

    # ---- astronauts ----
    @bp.get("/astronauts")
    def list_astronauts():
        with db.write_conn() as conn:
            _, err = auth.authorize_surgeon(conn)
            if err:
                return jsonify(err[0]), err[1]
            data = rows(conn.execute("SELECT * FROM astronauts ORDER BY id").fetchall())
        return jsonify(data)

    @bp.get("/astronauts/<int:astro_id>")
    def get_astronaut(astro_id):
        with db.write_conn() as conn:
            _, err = auth.authorize_surgeon(conn)
            if err:
                return jsonify(err[0]), err[1]
            r = conn.execute("SELECT * FROM astronauts WHERE id = ?", (astro_id,)).fetchone()
        if not r:
            return jsonify({"error": "not found"}), 404
        return jsonify(row(r))

    @bp.put("/astronauts/<int:astro_id>")
    def update_astronaut(astro_id):
        body = request.get_json(force=True) or {}
        with db.write_conn() as conn:
            _, err = auth.authorize_surgeon(conn)
            if err:
                return jsonify(err[0]), err[1]
            if not conn.execute("SELECT 1 FROM astronauts WHERE id = ?", (astro_id,)).fetchone():
                return jsonify({"error": "not found"}), 404
            if "name" in body:
                name = body["name"].strip() if isinstance(body["name"], str) else ""
                if not name or len(name) > 60:
                    return jsonify({"error": "name must be 1-60 characters"}), 400
                conn.execute("UPDATE astronauts SET name = ? WHERE id = ?", (name, astro_id))
            r = conn.execute("SELECT * FROM astronauts WHERE id = ?", (astro_id,)).fetchone()
        emit_fn("crew_updated", {"astronaut_id": astro_id})
        return jsonify(row(r))

    # Creating a new astronaut record, and changing an existing one's role,
    # are superuser-only (/admin) -- see docs/CLAUDE.md's "Superuser admin
    # page". Separate from update_astronaut above (name-only rename), which
    # stays Flight-Surgeon-only and untouched.
    @bp.post("/astronauts")
    def create_astronaut():
        body = request.get_json(force=True) or {}
        name = (body.get("name") or "").strip()
        role = body.get("role")
        if not name or role not in ("Crew member", auth.SURGEON_ROLE):
            return jsonify({"error": "name and a valid role ('Crew member' or 'Flight surgeon') are required"}), 400
        with db.write_conn() as conn:
            _, err = admin_auth.authorize_superuser(conn)
            if err:
                return jsonify(err[0]), err[1]
            cur = conn.execute(
                "INSERT INTO astronauts (name, role, color, baseline_reaction_ms, created_at) VALUES (?, ?, ?, 350, ?)",
                (name, role, body.get("color") or "#4fd1c5", datetime.now(timezone.utc).isoformat()),
            )
            r = conn.execute("SELECT * FROM astronauts WHERE id = ?", (cur.lastrowid,)).fetchone()
        return jsonify(row(r)), 201

    @bp.put("/astronauts/<int:astro_id>/role")
    def update_astronaut_role(astro_id):
        body = request.get_json(force=True) or {}
        role = body.get("role")
        if role not in ("Crew member", auth.SURGEON_ROLE):
            return jsonify({"error": "role must be 'Crew member' or 'Flight surgeon'"}), 400
        with db.write_conn() as conn:
            _, err = admin_auth.authorize_superuser(conn)
            if err:
                return jsonify(err[0]), err[1]
            conn.execute("UPDATE astronauts SET role = ? WHERE id = ?", (role, astro_id))
            r = conn.execute("SELECT * FROM astronauts WHERE id = ?", (astro_id,)).fetchone()
        if not r:
            return jsonify({"error": "not found"}), 404
        return jsonify(row(r))

    @bp.get("/astronauts/<int:astro_id>/summary")
    def astronaut_summary(astro_id):
        with db.write_conn() as conn:
            _, err = auth.authorize_view(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
            astro = conn.execute("SELECT * FROM astronauts WHERE id = ?", (astro_id,)).fetchone()
            if not astro:
                return jsonify({"error": "not found"}), 404
            snap = _today_snapshot(conn, astro_id)
            last_assessment = conn.execute(
                "SELECT * FROM assessments WHERE astronaut_id = ? ORDER BY ts DESC LIMIT 1", (astro_id,)
            ).fetchone()
            body_levels = _compute_body_levels(conn, astro_id)
            discomfort = _latest_discomfort(conn, astro_id)
        latest = snap["analysis"]
        if latest and (not last_assessment or latest["ts"] >= last_assessment["ts"]):
            overall_level = latest["overall_level"]
        else:
            overall_level = last_assessment["overall_level"] if last_assessment else "GRAY"
        return jsonify({
            "astronaut": row(astro),
            "today": snap["today"],
            "analysis": latest,
            "analysis_current": snap["analysis_current"],
            "analysis_pending": snap["analysis_pending"],
            "status": snap["status"],
            "overall_level": overall_level,
            "last_check": last_assessment["ts"] if last_assessment else None,
            "body_levels": body_levels,
            "discomfort": discomfort,
            "sensor": sensor_feed.status(astro_id),
            "session_active": astro_id in sessions.active_sessions,
            "symptoms_today": snap["symptoms_today"],
            "location": snap["location"],
        })

    @bp.get("/astronauts/<int:astro_id>/history")
    def astronaut_history(astro_id):
        indicator = request.args.get("indicator", "heart_rate")
        days = int(request.args.get("days", 30))
        since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        with db.write_conn() as conn:
            _, err = auth.authorize_view(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
            data = conn.execute(
                "SELECT ts, value_json, level, source FROM readings WHERE astronaut_id = ? AND indicator = ? "
                "AND ts >= ? ORDER BY ts ASC",
                (astro_id, indicator, since),
            ).fetchall()
        return jsonify([
            {"ts": r["ts"], "value": json.loads(r["value_json"]), "level": r["level"], "source": r["source"]}
            for r in data
        ])

    @bp.post("/astronauts/<int:astro_id>/analyze")
    def analyze_now(astro_id):
        """The "Analyze now" button: runs the analysis immediately (the AI, or the
        rules if it can't be reached) and returns the result."""
        with db.write_conn() as conn:
            _, err = auth.authorize_view(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
        result = analysis.run_now(astro_id, "manual")
        if result is None:
            return jsonify({"error": "not found"}), 404
        return jsonify(result)

    @bp.post("/astronauts/<int:astro_id>/chat")
    def doctor_ai_chat(astro_id):
        """Astra, the crew's chat (typed or spoken): the AI answers from this astronaut's
        data + latest analysis, and may propose actions (open a page, log mood/sleep/
        symptoms/vitals/discomfort, a journal entry, an alert) -- validated in
        analyst.parse_chat. Writes nothing itself: the frontend asks the astronaut to
        confirm, then saves through the normal routes. Actions are only returned when the
        signed-in astronaut is asking about themselves (never the surgeon on someone's
        behalf). 503 with no AI key, 502 on any AI failure (-> keyword quick replies)."""
        body = request.get_json(force=True) or {}
        message = (body.get("message") or "").strip()[:CHAT_MSG_CHARS]
        if not message:
            return jsonify({"error": "message is required"}), 400
        with db.write_conn() as conn:
            _, err = auth.authorize_view(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
            if not conn.execute("SELECT 1 FROM astronauts WHERE id = ?", (astro_id,)).fetchone():
                return jsonify({"error": "not found"}), 404
        if not analyst.configured():  # a short rate-limit back-off is waited out inside chat()
            return jsonify({"error": "AI is not available"}), 503
        _, profile = comms.current_profile()
        with db.write_conn() as conn:
            context, _, _ = analysis.build_context(conn, astro_id, profile, for_chat=True)
            latest = analysis.latest(conn, astro_id)
        if latest:
            context += (f"\nLatest health analysis ({latest['source']}): {latest['state_label']}, "
                        f"{latest['overall_level']}. {latest['summary']}")
        symptom_ids = [s["id"] for s in symptoms.catalog()]
        is_self = auth.current_astronaut_id() == astro_id
        try:
            out = analyst.chat(context, _sanitize_history(body.get("history")), message, symptom_ids,
                               can_act=is_self, guide_ids=list(load_content().get("measure_guides", {})))
        except analyst.AnalystError as exc:
            print(f"[astra] chat failed: {exc}", flush=True)  # e.g. the free plan's rate limit
            return jsonify({"error": "AI chat failed"}), 502
        if not is_self:
            out["actions"] = []  # belt and braces: never actions on someone else's behalf
        for a in out["actions"]:
            if a["type"] == "start_workout" and a.get("exercise"):
                exercise.remember_choice(astro_id, a["exercise"])
        return jsonify({**out, "model": analyst.model_name()})

    @bp.post("/astronauts/<int:astro_id>/speak")
    def speak(astro_id):
        """The "Microsoft neural voice" engine: Doctor AI's reply as MP3 (edge-tts), in the
        voice chosen on /admin. The page adds the station effects and falls back to the
        browser voice on any failure (502)."""
        body = request.get_json(force=True) or {}
        text = (body.get("text") or "").strip()[:600]
        if not text:
            return jsonify({"error": "text is required"}), 400
        with db.write_conn() as conn:
            _, err = auth.authorize_view(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
        try:
            vs = voice_settings.get()
            audio = voice.synthesize(text, vs["voice"], vs["rate"], vs["pitch"])
        except voice.SpeechError:
            return jsonify({"error": "speech synthesis failed"}), 502
        return Response(audio, mimetype="audio/mpeg")

    @bp.get("/voice-settings")
    def get_voice_settings():
        return jsonify(voice_settings.public())

    @bp.get("/astronauts/<int:astro_id>/simulate_vitals")
    def simulate_vitals(astro_id):
        """Simulated sensors. On a spacewalk the suit's sensors are added too, and
        ?problem=1 (the demo's "Simulate suit problem") makes them show real trouble."""
        out = health_rules.sample_vitals()
        with db.write_conn() as conn:
            on_eva = location.eva_since(conn, astro_id) is not None
        if on_eva or request.args.get("problem"):
            out.update(health_rules.sample_suit(problem=bool(request.args.get("problem"))))
        return jsonify(out)

    # ---- where the astronaut is: inside, or outside on a spacewalk (EVA) ----
    @bp.get("/astronauts/<int:astro_id>/location")
    def get_location(astro_id):
        with db.write_conn() as conn:
            _, err = auth.authorize_view(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
            loc = location.get(conn, astro_id)
        return jsonify({**loc, "mission_min": location.mission_minutes(loc["since"]) if loc["location"] == "eva" else 0,
                        "time_scale": TIME_SCALE})

    @bp.put("/astronauts/<int:astro_id>/location")
    def put_location(astro_id):
        body = request.get_json(force=True) or {}
        loc = body.get("location")
        if loc not in location.LOCATIONS:
            return jsonify({"error": "location must be inside or eva"}), 400
        with db.write_conn() as conn:
            viewer, err = auth.authorize_view(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
            if viewer["id"] != astro_id:
                return jsonify({"error": "only the astronaut can change this"}), 403
            data = location.set(conn, astro_id, loc)
        emit_fn("location_changed", {"astronaut_id": astro_id, **data})
        analysis.request(astro_id, "location")
        return jsonify(data)

    # ---- the live wearable (backend/logic/sensor_feed.py): a real recorded crew session ----
    @bp.get("/sensor/segments")
    def sensor_segments():
        return jsonify({"segments": sensor_feed.segments(), "source": sensor_feed.source()})

    @bp.get("/astronauts/<int:astro_id>/sensor")
    def get_sensor(astro_id):
        with db.write_conn() as conn:
            _, err = auth.authorize_view(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
        return jsonify(sensor_feed.status(astro_id) or {"on": False})

    @bp.put("/astronauts/<int:astro_id>/sensor")
    def put_sensor(astro_id):
        """{"segment": "focus"|"multitask"|"startle"} starts a test, {"on": false} finishes it
        and saves the results as the latest vitals + an assessment ({"on": false, "save":
        false} cancels it instead). Only the astronaut wears it (the doctor watches)."""
        body = request.get_json(force=True) or {}
        with db.write_conn() as conn:
            viewer, err = auth.authorize_view(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
            if viewer["id"] != astro_id:
                return jsonify({"error": "only the astronaut can start or stop their monitor"}), 403
        if body.get("on") is False:
            result = sensor_feed.stop(astro_id, save=body.get("save", True) is not False)
            if result:  # finished and saved: same broadcasts as a test that ran to its end
                sensor_feed.announce_finished(result, emit_fn, lambda a: analysis.request(a, "wearable", delay=0))
                return jsonify({"on": False, "finished": True, "result": result})
            emit_fn("sensor_changed", {"astronaut_id": astro_id, "on": False})
            return jsonify({"on": False, "finished": False})
        try:
            data = sensor_feed.start(astro_id, body.get("segment"))
        except ValueError:
            return jsonify({"error": "segment must be one of: " + ", ".join(s["id"] for s in sensor_feed.segments())}), 400
        emit_fn("sensor_changed", {"astronaut_id": astro_id, "on": True})
        return jsonify(data)

    @bp.post("/astronauts/<int:astro_id>/assess")
    def assess(astro_id):
        body = request.get_json(force=True) or {}
        if "oxygen_saturation" in body:
            try:
                spo2 = float(body["oxygen_saturation"])
            except (TypeError, ValueError):
                spo2 = -1
            if not 0 < spo2 <= 100:
                return jsonify({"error": "oxygen_saturation must be a percentage between 0 and 100"}), 400
        for key, lo, hi in (("suit_co2", 0, 15), ("suit_pressure", 0, 6), ("suit_o2", 0, 100)):
            if key in body:
                v = body[key]
                if not isinstance(v, (int, float)) or isinstance(v, bool) or not lo <= v <= hi:
                    return jsonify({"error": f"{key} must be a number from {lo} to {hi}"}), 400
        now = datetime.now(timezone.utc)
        levels = []
        details = {}
        with db.write_conn() as conn:
            _, err = auth.authorize_view(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
            astro = conn.execute("SELECT * FROM astronauts WHERE id = ?", (astro_id,)).fetchone()
            if not astro:
                return jsonify({"error": "not found"}), 404

            def record(indicator, value, level):
                levels.append(level)
                details[indicator] = {"value": value, "level": level}
                conn.execute(
                    "INSERT INTO readings (astronaut_id, ts, indicator, value_json, level, source) "
                    "VALUES (?, ?, ?, ?, ?, 'manual')",
                    (astro_id, now.isoformat(), indicator, json.dumps(value), level),
                )

            if "heart_rate" in body:
                v = float(body["heart_rate"])
                record("heart_rate", v, health_rules.evaluate("heart_rate", v))
            if "blood_pressure" in body:
                sys_v, dia_v = body["blood_pressure"]["systolic"], body["blood_pressure"]["diastolic"]
                lvl = health_rules.evaluate("blood_pressure", (sys_v, dia_v))
                record("blood_pressure", {"systolic": sys_v, "diastolic": dia_v}, lvl)
            if "blood_sugar" in body:
                v = float(body["blood_sugar"])
                record("blood_sugar", v, health_rules.evaluate("blood_sugar", v))
            if "temperature" in body:
                v = float(body["temperature"])
                record("temperature", v, health_rules.evaluate("temperature", v))
            if "oxygen_saturation" in body:
                v = float(body["oxygen_saturation"])
                record("oxygen_saturation", v, health_rules.evaluate("oxygen_saturation", v))
            for key in ("suit_co2", "suit_pressure", "suit_o2"):  # spacewalk suit sensors
                if key in body:
                    v = float(body[key])
                    record(key, v, health_rules.evaluate(key, v))

            # Fold in whatever the CYD already reported today (sleep, mood, reaction, symptoms).
            # indicator_levels tracks every indicator considered for this assessment (name,
            # level), not just the manual vitals -- so the note below can name ALL of them
            # that are flagged, not just whichever one happened to be recorded first.
            indicator_levels = [(indicator, d["level"]) for indicator, d in details.items()]
            since = (now - timedelta(hours=18)).isoformat()
            for r in conn.execute(
                "SELECT indicator, level FROM readings WHERE astronaut_id = ? AND ts >= ? "
                "AND indicator IN ('sleep','mood','reaction_time','exercise','water')",
                (astro_id, since),
            ):
                levels.append(r["level"])
                indicator_levels.append((r["indicator"], r["level"]))
            sym = conn.execute(
                "SELECT level FROM symptoms WHERE astronaut_id = ? AND ts >= ? ORDER BY ts DESC LIMIT 1",
                (astro_id, since),
            ).fetchone()
            if sym:
                levels.append(sym["level"])
                indicator_levels.append(("symptoms", sym["level"]))

            overall = health_rules.overall_level(levels) if levels else "GREEN"
            flagged = [name.replace("_", " ") for name, lvl in indicator_levels if lvl == overall]
            note = f"{overall}: {', '.join(flagged) or 'overall check'}"[:120]
            conn.execute(
                "INSERT INTO assessments (astronaut_id, ts, overall_level, note, details_json) VALUES (?, ?, ?, ?, ?)",
                (astro_id, now.isoformat(), overall, note, json.dumps(details)),
            )

        # The levels above are the rules' quick first pass. The real verdict -- and any
        # surgeon alert, CYD status screen and LED -- comes from the analysis pipeline
        # (the AI, or the same rules if the AI can't be reached), a moment later.
        analysis.request(astro_id, "assess", delay=0)
        emit_fn("assessment", {"astronaut_id": astro_id, "overall_level": overall, "note": note, "details": details})
        return jsonify({"overall_level": overall, "note": note, "details": details, "analysis_pending": True})

    # ---- symptoms (manual reporting from the web app) ----
    @bp.get("/symptoms/catalog")
    def symptoms_catalog():
        return jsonify(symptoms.catalog())

    @bp.post("/astronauts/<int:astro_id>/symptoms")
    def log_symptoms(astro_id):
        body = request.get_json(force=True) or {}
        items = body.get("items", [])
        with db.write_conn() as conn:
            _, err = auth.authorize_view(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
            astro = conn.execute("SELECT * FROM astronauts WHERE id = ?", (astro_id,)).fetchone()
            if not astro:
                return jsonify({"error": "not found"}), 404
            lvl = symptoms.record(conn, astro_id, items)
            labels = {c["id"]: c["label"] for c in symptoms.catalog()}
            astra_memory.note_symptoms(conn, astro_id, [labels[i] for i in items if i in labels])
        symptoms.alert_if_red(astro_id, items, lvl, emit_fn)
        analysis.request(astro_id, "symptoms")
        emit_fn("cyd_event", {"type": "symptoms", "astronaut_id": astro_id, "items": items, "level": lvl})
        return jsonify({"level": lvl})

    # ---- body-region discomfort (Body tab's digital-twin slider/chat) ----
    @bp.post("/astronauts/<int:astro_id>/discomfort")
    def log_discomfort(astro_id):
        body = request.get_json(force=True) or {}
        region = body.get("region")
        try:
            intensity = int(body.get("intensity"))
        except (TypeError, ValueError):
            return jsonify({"error": "intensity must be an integer 0-10"}), 400
        if region not in load_content()["body_parts"] or not (0 <= intensity <= 10):
            return jsonify({"error": "region must be a known body part and intensity must be 0-10"}), 400
        with db.write_conn() as conn:
            _, err = auth.authorize_view(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
            astro = conn.execute("SELECT * FROM astronauts WHERE id = ?", (astro_id,)).fetchone()
            if not astro:
                return jsonify({"error": "not found"}), 404
            conn.execute(
                "INSERT INTO discomfort (astronaut_id, region, intensity, ts) VALUES (?, ?, ?, ?)",
                (astro_id, region, intensity, datetime.now(timezone.utc).isoformat()),
            )
            astra_memory.note_pain(conn, astro_id, load_content()["body_parts"][region].get("label", region), intensity)
        analysis.request(astro_id, "discomfort")
        emit_fn("cyd_event", {"type": "discomfort", "astronaut_id": astro_id, "region": region, "intensity": intensity})
        return jsonify({"ok": True, "region": region, "intensity": intensity})

    @bp.post("/astronauts/<int:astro_id>/discomfort/report")
    def discomfort_report(astro_id):
        with db.write_conn() as conn:
            _, err = auth.authorize_view(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
            astro = conn.execute("SELECT * FROM astronauts WHERE id = ?", (astro_id,)).fetchone()
            if not astro:
                return jsonify({"error": "not found"}), 404
            vitals = _compute_body_levels(conn, astro_id)
            discomfort = _latest_discomfort(conn, astro_id)

        danger = []
        for region, vlevel in vitals.items():
            vlevel = health_rules.GREEN if vlevel == "GRAY" else vlevel
            blended = health_rules.worse(vlevel, _discomfort_band(discomfort.get(region, 0)))
            if blended == health_rules.RED:
                danger.append(region)
        if not danger:
            return jsonify({"error": "no region is currently at Danger level"}), 400

        note = f"Danger (discomfort): {', '.join(danger)}"[:120]
        deliver_at = comms.queue_report(astro_id, note)
        emit_fn("alert", {"astronaut_id": astro_id, "level": "RED", "text": note})
        return jsonify({"ok": True, "danger_regions": danger, "deliver_at": deliver_at.isoformat()})

    @bp.post("/astronauts/<int:astro_id>/alert")
    def send_alert(astro_id):
        """A free-form, crew-initiated Flight Surgeon alert -- the only
        writer of the alerts table that isn't gated on a server-computed
        severity (contrast assess()'s RED branch and discomfort_report()
        above, both of which recompute their own condition and refuse to
        fire if it isn't actually met). Here the astronaut's own explicit
        request IS the trigger -- the same trust level log_discomfort()
        already gives the intensity slider."""
        body = request.get_json(force=True) or {}
        text = (body.get("text") or "").strip()[:200]
        if not text:
            return jsonify({"error": "text is required"}), 400
        with db.write_conn() as conn:
            _, err = auth.authorize_view(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
            astro = conn.execute("SELECT * FROM astronauts WHERE id = ?", (astro_id,)).fetchone()
            if not astro:
                return jsonify({"error": "not found"}), 404
            conn.execute(
                "INSERT INTO alerts (astronaut_id, ts, level, text, acknowledged) VALUES (?, ?, 'RED', ?, 0)",
                (astro_id, datetime.now(timezone.utc).isoformat(), text),
            )
        deliver_at = comms.queue_report(astro_id, text)
        emit_fn("alert", {"astronaut_id": astro_id, "level": "RED", "text": text})
        return jsonify({"ok": True, "level": "RED", "text": text, "deliver_at": deliver_at.isoformat()})

    # ---- Astra's abilities: things only the astronaut themselves can ask her to do ----
    def _self_only(conn, astro_id):
        """(None, error) unless the signed-in astronaut IS astro_id (not the surgeon on
        their behalf). 401 when nobody is signed in."""
        viewer, err = auth.authorize_view(conn, astro_id)
        if err:
            return err
        if viewer["id"] != astro_id:
            return {"error": "only the astronaut can do this"}, 403
        return None

    @bp.post("/astronauts/<int:astro_id>/message")
    def crew_message(astro_id):
        """A normal (not urgent) message to the flight surgeon -- it travels with the comms
        delay like every other report. Urgent things go through /alert instead."""
        body = request.get_json(force=True) or {}
        text = " ".join(str(body.get("text") or "").split())[:analyst.MAX_MESSAGE]
        if not text:
            return jsonify({"error": "text is required"}), 400
        with db.write_conn() as conn:
            err = _self_only(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
        deliver_at = comms.queue_report(astro_id, text)
        emit_fn("message_sent", {"astronaut_id": astro_id, "deliver_at": deliver_at.isoformat()})
        return jsonify({"ok": True, "deliver_at": deliver_at.isoformat(), "delay_s": round(comms.delay_seconds())})

    @bp.post("/astronauts/<int:astro_id>/summary-report")
    def summary_report(astro_id):
        """Astra writes a short health summary (today / the last 7 days) and sends it to the
        flight surgeon. The AI writes it; without the AI, the latest analysis + the 7-day
        stats are sent instead."""
        body = request.get_json(force=True) or {}
        period = body.get("period") if body.get("period") in analyst.SUMMARY_PERIODS else "today"
        with db.write_conn() as conn:
            err = _self_only(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
            _, profile = comms.current_profile()
            context, _, _ = analysis.build_context(conn, astro_id, profile)
            latest = analysis.latest(conn, astro_id)
        if latest:
            context += f"\nLatest health analysis: {latest['state_label']}, {latest['overall_level']}. {latest['summary']}"
        source = "ai"
        try:
            text = analyst.summary(context, period)
        except analyst.AnalystError as exc:
            print(f"[astra] summary by the AI failed ({exc}), sending the rules summary", flush=True)
            source = "rules"
            text = _summary_fallback(context, latest)
        label = "today" if period == "today" else "last 7 days"
        report = f"Health summary ({label}): {text}"
        deliver_at = comms.queue_report(astro_id, report)
        emit_fn("message_sent", {"astronaut_id": astro_id, "deliver_at": deliver_at.isoformat()})
        return jsonify({"ok": True, "text": report, "source": source, "deliver_at": deliver_at.isoformat(),
                        "delay_s": round(comms.delay_seconds())})

    def _summary_fallback(context, latest):
        parts = []
        if latest:
            parts.append(f"{latest['state_label']} ({latest['overall_level']}). {latest['summary']}")
        lines = context.split("\n")
        if "Last 7 days:" in lines:
            i = lines.index("Last 7 days:")
            stats = [line[2:] for line in lines[i + 1:] if line.startswith("- ")][:6]
            if stats:
                parts.append("Last 7 days: " + "; ".join(stats) + ".")
        return " ".join(parts) or "No readings logged yet."

    @bp.post("/astronauts/<int:astro_id>/activity")
    def voice_activity(astro_id):
        """Sleep / workout tracking without a tag ("I'm going to bed", "I'm awake"). Uses the
        same timers as the NFC tags, so a tag-started sleep can be stopped by voice."""
        body = request.get_json(force=True) or {}
        kind, action = body.get("kind"), body.get("action")
        if kind not in ("sleep", "exercise") or action not in ("start", "stop"):
            return jsonify({"error": "kind must be sleep/exercise and action start/stop"}), 400
        with db.write_conn() as conn:
            err = _self_only(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
            running = sessions.running_toggle(astro_id, kind)
            if action == "start":
                if running:
                    return jsonify({"ok": True, "already": True, "kind": kind})
                label, key = ("Sleep" if kind == "sleep" else "Workout"), f"web:{astro_id}:{kind}"
                ex = exercise.find(body.get("exercise") or exercise.take_choice(astro_id)) if kind == "exercise" else None
                if ex:  # Astra named one ("start my treadmill run") -> logged as that exercise
                    label, key = ex["name"], f"ex:{astro_id}:{ex['id']}"
                sessions.start_toggle(conn, astro_id, kind, key, label, send_fn, emit_fn)
                return jsonify({"ok": True, "kind": kind, "started": True})
            if not running:
                return jsonify({"error": f"no {kind} tracking is running"}), 409
            return jsonify({"ok": True, **sessions.stop_toggle(conn, running, send_fn, emit_fn)})

    # ---- Exercises page: the ISS daily plan against this astronaut's logs (logic/exercise.py,
    # shared with Astra's context). Same timer as the NFC tags and Astra. ----
    @bp.get("/astronauts/<int:astro_id>/exercise")
    def exercise_overview(astro_id):
        with db.write_conn() as conn:
            _, err = auth.authorize_view(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
            return jsonify(exercise.overview(conn, astro_id))

    @bp.post("/astronauts/<int:astro_id>/exercise/start")
    def exercise_start(astro_id):
        body = request.get_json(force=True) or {}
        cfg = load_exercises()
        ex = exercise.find(body.get("exercise"), cfg)
        if not ex:
            return jsonify({"error": "unknown exercise"}), 400
        with db.write_conn() as conn:
            err = _self_only(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
            if sessions.running_toggle(astro_id, "exercise"):
                return jsonify({"error": "a workout is already running", "running": exercise.running(conn, astro_id, cfg)}), 409
            sessions.start_toggle(conn, astro_id, "exercise", f"ex:{astro_id}:{ex['id']}", ex["name"], send_fn, emit_fn)
            return jsonify({"ok": True, "running": exercise.running(conn, astro_id, cfg)})

    @bp.post("/astronauts/<int:astro_id>/exercise/stop")
    def exercise_stop(astro_id):
        with db.write_conn() as conn:
            err = _self_only(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
            key = sessions.running_toggle(astro_id, "exercise")
            if not key:
                return jsonify({"error": "no workout is running"}), 409
            return jsonify({"ok": True, **sessions.stop_toggle(conn, key, send_fn, emit_fn)})

    @bp.post("/astronauts/<int:astro_id>/reaction")
    def web_reaction(astro_id):
        """The reaction test on Astra's voice screen: same reading the CYD's test saves."""
        body = request.get_json(force=True) or {}
        avg_ms, lapses = body.get("avg_ms"), body.get("lapses", 0)
        if not analyst._num(avg_ms, 50, 5000) or not isinstance(lapses, int) or isinstance(lapses, bool) or not 0 <= lapses <= 20:
            return jsonify({"error": "avg_ms must be 50-5000 and lapses 0-20"}), 400
        with db.write_conn() as conn:
            err = _self_only(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
            lvl = _save_reaction(conn, astro_id, round(avg_ms), lapses, "manual")
        analysis.request(astro_id, "reaction")
        return jsonify({"ok": True, "level": lvl, "avg_ms": round(avg_ms), "lapses": lapses})

    @bp.post("/astronauts/<int:astro_id>/breathing")
    def web_breathing(astro_id):
        body = request.get_json(force=True) or {}
        seconds = body.get("seconds", 60)
        if not analyst._num(seconds, 5, 3600):
            return jsonify({"error": "seconds must be 5-3600"}), 400
        with db.write_conn() as conn:
            err = _self_only(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
            _save_breathing(conn, astro_id, round(seconds))
        return jsonify({"ok": True})

    # ---- what Astra remembers (the astronaut's own notes; never the surgeon's view) ----
    @bp.get("/astronauts/<int:astro_id>/memory")
    def get_memory(astro_id):
        with db.write_conn() as conn:
            err = _self_only(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
            data = astra_memory.due_for(conn, astro_id) if request.args.get("due") else astra_memory.list_for(conn, astro_id)
        return jsonify(data)

    @bp.post("/astronauts/<int:astro_id>/memory")
    def add_memory(astro_id):
        body = request.get_json(force=True) or {}
        hours = body.get("follow_up_hours")
        if hours is not None and not analyst._num(hours, 1, 72):
            return jsonify({"error": "follow_up_hours must be 1-72"}), 400
        with db.write_conn() as conn:
            err = _self_only(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
            mem_id = astra_memory.add(conn, astro_id, body.get("text"), hours)
        if mem_id is None:
            return jsonify({"error": "text is required"}), 400
        emit_fn("astra_memory", {"astronaut_id": astro_id})
        return jsonify({"ok": True, "id": mem_id})

    @bp.delete("/astronauts/<int:astro_id>/memory/<int:mem_id>")
    def delete_memory(astro_id, mem_id):
        with db.write_conn() as conn:
            err = _self_only(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
            ok = astra_memory.delete(conn, astro_id, mem_id)
        if not ok:
            return jsonify({"error": "not found"}), 404
        emit_fn("astra_memory", {"astronaut_id": astro_id})
        return jsonify({"ok": True})

    @bp.post("/astronauts/<int:astro_id>/memory/<int:mem_id>/done")
    def memory_followed_up(astro_id, mem_id):
        with db.write_conn() as conn:
            err = _self_only(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
            ok = astra_memory.mark_followed_up(conn, astro_id, mem_id)
        if not ok:
            return jsonify({"error": "not found"}), 404
        emit_fn("astra_memory", {"astronaut_id": astro_id})
        return jsonify({"ok": True})

    # ---- Mental Health tab: mood check-in + journal ----
    MOOD_SCORES = {"rough": 1, "low": 2, "okay": 3, "good": 4, "great": 5}

    # ---- the daily mood check (backend/logic/mood_check.py): 3 questions, judged by the AI ----
    @bp.get("/astronauts/<int:astro_id>/mood-check")
    def get_mood_check(astro_id):
        with db.write_conn() as conn:
            _, err = auth.authorize_view(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
            today = mood_check.today_result(conn, astro_id)
        day = mood_check.mission_day()
        return jsonify({"day": day + 1, "day_index": day, "questions": mood_check.questions_for(astro_id, day),
                        "today": today})

    @bp.post("/astronauts/<int:astro_id>/mood-check")
    def post_mood_check(astro_id):
        """{answers: [3 strings or {text}], day_index?, talk_id?}. The astronaut themself only:
        it's their voice and their words. Judged by the AI (or the fallback), saved as a mood
        reading."""
        if auth.current_astronaut_id() is None:
            return jsonify({"error": "not logged in"}), 401
        if auth.current_astronaut_id() != astro_id:
            return jsonify({"error": "only the astronaut can take their own mood check"}), 403
        body = request.get_json(force=True) or {}
        today = mood_check.mission_day()
        day = body.get("day_index", today)
        if not isinstance(day, int) or isinstance(day, bool) or day not in (today, today - 1):
            day = today  # a check started just before the mission day rolled over keeps its questions
        answers, err_msg = mood_check.clean_answers(body.get("answers"), mood_check.questions_for(astro_id, day))
        if err_msg:
            return jsonify({"error": err_msg}), 400
        talk_id = body.get("talk_id") or None
        tone = None
        if talk_id:
            if not isinstance(talk_id, str) or not _TALK_ID.fullmatch(talk_id):
                return jsonify({"error": "bad talk id"}), 400
            with db.write_conn() as conn:
                talk = voice_talks.get(conn, talk_id)
                if not talk or talk["astronaut_id"] != astro_id:
                    return jsonify({"error": "not your conversation"}), 403
                voice_talks.finish(conn, talk_id, reason="mood check")
                tone = voice_talks.aggregate(conn, talk_id)
        verdict = mood_check.judge(answers, tone)  # the AI call: outside any DB lock
        if verdict["source"] != "ai":
            print(f"[astra] mood check judged by the rules: {verdict.get('error')}", flush=True)
        with db.write_conn() as conn:
            if not conn.execute("SELECT 1 FROM astronauts WHERE id = ?", (astro_id,)).fetchone():
                return jsonify({"error": "not found"}), 404
            result = mood_check.save(conn, astro_id, verdict, answers, tone, talk_id)
        analysis.request(astro_id, "mood", delay=0)
        emit_fn("cyd_event", {"type": "mood", "astronaut_id": astro_id, "mood": result["mood"], "level": result["level"]})
        emit_fn("mood_check", {"astronaut_id": astro_id, "mood": result["mood"]})
        return jsonify(result)

    @bp.post("/astronauts/<int:astro_id>/mood")
    def log_mood(astro_id):
        body = request.get_json(force=True) or {}
        mood = body.get("mood")
        note = (body.get("note") or "").strip()[:500]
        if mood not in MOOD_SCORES:
            return jsonify({"error": "mood must be one of rough/low/okay/good/great"}), 400
        score = MOOD_SCORES[mood]
        # Real rules engine, not a hardcoded score<=2 guess -- stays in sync with
        # config/health_rules.json's mood bands (and with every other mood-aware
        # display, e.g. Trends)
        # if those thresholds are ever retuned.
        lvl = health_rules.evaluate("mood", score)
        now = datetime.now(timezone.utc)
        with db.write_conn() as conn:
            _, err = auth.authorize_view(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
            astro = conn.execute("SELECT * FROM astronauts WHERE id = ?", (astro_id,)).fetchone()
            if not astro:
                return jsonify({"error": "not found"}), 404
            conn.execute(
                "INSERT INTO readings (astronaut_id, ts, indicator, value_json, level, source) "
                "VALUES (?, ?, 'mood', ?, ?, 'manual')",
                (astro_id, now.isoformat(), json.dumps({"mood": mood, "score": score, "note": note}), lvl),
            )
            astra_memory.note_mood(conn, astro_id, mood)
        analysis.request(astro_id, "mood")
        emit_fn("cyd_event", {"type": "mood", "astronaut_id": astro_id, "mood": mood, "level": lvl})
        return jsonify({"mood": mood, "score": score, "level": lvl})

    @bp.get("/astronauts/<int:astro_id>/journal")
    def get_journal(astro_id):
        with db.write_conn() as conn:
            _, err = auth.authorize_view(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
            astro = conn.execute("SELECT * FROM astronauts WHERE id = ?", (astro_id,)).fetchone()
            if not astro:
                return jsonify({"error": "not found"}), 404
            data = rows(conn.execute(
                "SELECT id, title, body, created_at FROM journal_entries WHERE astronaut_id = ? ORDER BY created_at DESC",
                (astro_id,),
            ).fetchall())
        return jsonify(data)

    @bp.post("/astronauts/<int:astro_id>/journal")
    def add_journal_entry(astro_id):
        body = request.get_json(force=True) or {}
        title = (body.get("title") or "").strip()[:200]
        entry_body = (body.get("body") or "").strip()[:4000]
        if not title or not entry_body:
            return jsonify({"error": "title and body are required"}), 400
        now = datetime.now(timezone.utc).isoformat()
        with db.write_conn() as conn:
            _, err = auth.authorize_view(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
            astro = conn.execute("SELECT * FROM astronauts WHERE id = ?", (astro_id,)).fetchone()
            if not astro:
                return jsonify({"error": "not found"}), 404
            cur = conn.execute(
                "INSERT INTO journal_entries (astronaut_id, title, body, created_at) VALUES (?, ?, ?, ?)",
                (astro_id, title, entry_body, now),
            )
            entry_id = cur.lastrowid
        return jsonify({"ok": True, "id": entry_id, "title": title, "body": entry_body, "created_at": now})

    # ---- "Wanna talk?" voice tone estimates (backend/services/emotion.py) ----
    # The browser records one phrase at a time from Astra's shared microphone and POSTs it
    # here as a 16 kHz WAV. It's analysed on this laptop, in memory, and dropped; only the
    # scores are saved, in their own `voice_tone` table (never `readings` / mood).
    @bp.get("/voice-tone/status")
    def voice_tone_status():
        return jsonify(emotion.status())

    @bp.post("/astronauts/<int:astro_id>/voice-tone")
    def add_voice_tone(astro_id):
        # Only the astronaut themself (not the surgeon on their behalf): it's their voice.
        if auth.current_astronaut_id() is None:
            return jsonify({"error": "not logged in"}), 401
        if auth.current_astronaut_id() != astro_id:
            return jsonify({"error": "forbidden"}), 403
        talk_id = request.args.get("talk") or ""
        if not _TALK_ID.fullmatch(talk_id):
            return jsonify({"error": "talk id required"}), 400
        with db.write_conn() as conn:
            ok, status, msg = voice_talks.accepts_phrases(voice_talks.get(conn, talk_id), astro_id)
        if not ok:
            return jsonify({"error": msg}), status
        if (request.content_length or 0) > emotion.MAX_WAV_BYTES:
            return jsonify({"error": "audio too large"}), 413
        try:
            # Outside the DB write lock: inference takes up to ~1 s.
            result = emotion.analyze_wav(request.get_data(cache=False))
        except emotion.Unavailable as e:
            return jsonify({"error": "voice tone analysis unavailable", "reason": str(e)}), 503
        except emotion.ToneError as e:
            return jsonify({"error": str(e)}), 400
        now = datetime.now(timezone.utc).isoformat()
        with db.write_conn() as conn:
            if not conn.execute("SELECT 1 FROM astronauts WHERE id = ?", (astro_id,)).fetchone():
                return jsonify({"error": "not found"}), 404
            # re-checked inside the write: a finish may have landed during the inference
            ok, status, msg = voice_talks.accepts_phrases(voice_talks.get(conn, talk_id), astro_id)
            if not ok:
                return jsonify({"error": msg}), status
            voice_talks.touch(conn, talk_id)
            cur = conn.execute(
                "INSERT INTO voice_tone (astronaut_id, ts, talk_id, label, confidence, scores_json, duration_s, model) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (astro_id, now, talk_id, result["label"], result["confidence"], json.dumps(result["scores"]),
                 result["duration_s"], f"{emotion.MODEL_ID}@{emotion.MODEL_REVISION[:12]}"),
            )
            row_id = cur.lastrowid
        out = {"id": row_id, "ts": now, "talk_id": talk_id, **result}
        emit_fn("voice_tone", {"astronaut_id": astro_id, "id": row_id, "talk_id": talk_id})
        return jsonify(out)

    # ---- "Wanna talk?" conversations (backend/logic/voice_talks.py) ----
    def _own_talk(astro_id, talk_id=None):
        if auth.current_astronaut_id() is None:
            return None, (jsonify({"error": "not logged in"}), 401)
        if auth.current_astronaut_id() != astro_id:
            return None, (jsonify({"error": "forbidden"}), 403)
        if talk_id is not None and not _TALK_ID.fullmatch(talk_id):
            return None, (jsonify({"error": "bad conversation id"}), 400)
        return True, None

    @bp.post("/astronauts/<int:astro_id>/voice-talks")
    def open_voice_talk(astro_id):
        _, err = _own_talk(astro_id)
        if err:
            return err
        if not emotion.is_ready():
            return jsonify({"error": "voice tone analysis unavailable", "reason": emotion.status()["reason"]}), 503
        with db.write_conn() as conn:
            if not conn.execute("SELECT 1 FROM astronauts WHERE id = ?", (astro_id,)).fetchone():
                return jsonify({"error": "not found"}), 404
            kind = (request.get_json(silent=True) or {}).get("kind", "talk")
            talk = voice_talks.create(conn, astro_id, kind)
        return jsonify(voice_talks.public(talk)), 201

    def _talk_body_int(body, key):
        try:
            return max(0, min(10000, int(body.get(key) or 0)))
        except (TypeError, ValueError):
            return 0

    @bp.post("/astronauts/<int:astro_id>/voice-talks/<talk_id>/close")
    def close_voice_talk(astro_id, talk_id):
        _, err = _own_talk(astro_id, talk_id)
        if err:
            return err
        body = request.get_json(silent=True) or {}
        with db.write_conn() as conn:
            talk = voice_talks.get(conn, talk_id)
            if not talk or talk["astronaut_id"] != astro_id:
                return jsonify({"error": "unknown conversation"}), 404
            talk = voice_talks.close(conn, talk_id, _talk_body_int(body, "phrases_sent"))
        emit_fn("voice_talk", {"astronaut_id": astro_id, "talk_id": talk_id, "status": talk["status"]})
        return jsonify(voice_talks.public(talk))

    @bp.post("/astronauts/<int:astro_id>/voice-talks/<talk_id>/finish")
    def finish_voice_talk(astro_id, talk_id):
        _, err = _own_talk(astro_id, talk_id)
        if err:
            return err
        body = request.get_json(silent=True) or {}
        with db.write_conn() as conn:
            talk = voice_talks.get(conn, talk_id)
            if not talk or talk["astronaut_id"] != astro_id:
                return jsonify({"error": "unknown conversation"}), 404
            talk = voice_talks.finish(conn, talk_id, _talk_body_int(body, "phrases_sent"),
                                      _talk_body_int(body, "phrases_skipped"), _talk_body_int(body, "phrases_failed"))
        emit_fn("voice_talk", {"astronaut_id": astro_id, "talk_id": talk_id, "status": talk["status"]})
        return jsonify(voice_talks.public(talk))

    @bp.get("/astronauts/<int:astro_id>/voice-talks/latest")
    def latest_voice_talk(astro_id):
        with db.write_conn() as conn:
            _, err = auth.authorize_view(conn, astro_id)  # the astronaut + the flight surgeon
            if err:
                return jsonify(err[0]), err[1]
            talk = voice_talks.latest(conn, astro_id)
        return jsonify({"talk": talk})

    @bp.get("/astronauts/<int:astro_id>/voice-tone")
    def get_voice_tone(astro_id):
        try:
            days = max(1, min(30, int(request.args.get("days", 7))))
        except ValueError:
            days = 7
        since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        with db.write_conn() as conn:
            _, err = auth.authorize_view(conn, astro_id)  # the astronaut + the flight surgeon, like the journal
            if err:
                return jsonify(err[0]), err[1]
            data = rows(conn.execute(
                "SELECT id, ts, talk_id, label, confidence, scores_json, duration_s FROM voice_tone "
                "WHERE astronaut_id = ? AND ts >= ? ORDER BY ts",
                (astro_id, since),
            ).fetchall())
        for r in data:
            r["scores"] = json.loads(r.pop("scores_json"))
        return jsonify(data)

    # ---- Sleep Lab tab: manual sleep entry (the CYD-reported path already
    # writes indicator='sleep' readings too; this just gives the web app its
    # own way in, same relationship /assess's manual vitals have to the CYD) ----
    @bp.post("/astronauts/<int:astro_id>/sleep")
    def log_sleep(astro_id):
        body = request.get_json(force=True) or {}
        try:
            bed_h, bed_m = (int(x) for x in body.get("bedtime", "").split(":"))
            wake_h, wake_m = (int(x) for x in body.get("wake_time", "").split(":"))
            if not (0 <= bed_h <= 23 and 0 <= bed_m <= 59 and 0 <= wake_h <= 23 and 0 <= wake_m <= 59):
                raise ValueError
        except (AttributeError, ValueError):
            return jsonify({"error": "bedtime and wake_time must be 'HH:MM' strings"}), 400
        bed_minutes, wake_minutes = bed_h * 60 + bed_m, wake_h * 60 + wake_m
        if wake_minutes <= bed_minutes:
            wake_minutes += 24 * 60  # overnight wraparound (bedtime 23:10 -> wake 05:52)
        hours = round((wake_minutes - bed_minutes) / 60, 2)
        lvl = health_rules.evaluate("sleep", hours)
        now = datetime.now(timezone.utc)
        with db.write_conn() as conn:
            _, err = auth.authorize_view(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
            astro = conn.execute("SELECT * FROM astronauts WHERE id = ?", (astro_id,)).fetchone()
            if not astro:
                return jsonify({"error": "not found"}), 404
            conn.execute(
                "INSERT INTO readings (astronaut_id, ts, indicator, value_json, level, source) "
                "VALUES (?, ?, 'sleep', ?, ?, 'manual')",
                (astro_id, now.isoformat(),
                 json.dumps({"hours": hours, "bedtime": body["bedtime"], "wake_time": body["wake_time"]}), lvl),
            )
        analysis.request(astro_id, "sleep")
        emit_fn("cyd_event", {"type": "sleep", "astronaut_id": astro_id, "hours": hours, "level": lvl})
        return jsonify({"hours": hours, "level": lvl})

    # ---- crew ----
    @bp.get("/crew")
    def crew():
        with db.write_conn() as conn:
            _, err = auth.authorize_surgeon(conn)
            if err:
                return jsonify(err[0]), err[1]
            crew_rows = conn.execute("SELECT * FROM astronauts WHERE role != 'Flight surgeon' ORDER BY id").fetchall()
            out = []
            for a in crew_rows:
                last = conn.execute("SELECT * FROM assessments WHERE astronaut_id = ? ORDER BY ts DESC LIMIT 1", (a["id"],)).fetchone()
                active_alerts = conn.execute("SELECT COUNT(*) AS c FROM alerts WHERE astronaut_id = ? AND acknowledged = 0", (a["id"],)).fetchone()["c"]
                open_alert = conn.execute(
                    "SELECT id, ts, text FROM alerts WHERE astronaut_id = ? AND acknowledged = 0 ORDER BY ts DESC LIMIT 1", (a["id"],)
                ).fetchone()
                last_reading = conn.execute("SELECT MAX(ts) AS t FROM readings WHERE astronaut_id = ?", (a["id"],)).fetchone()["t"]
                snap = _today_snapshot(conn, a["id"])
                out.append({
                    **row(a), "overall_level": last["overall_level"] if last else "GRAY",
                    "last_check": last["ts"] if last else None, "active_alerts": active_alerts,
                    "session_active": a["id"] in sessions.active_sessions,
                    # Crew overview cards: today's status, latest vitals, flags.
                    "status": snap["status"], "today": snap["today"], "symptoms_today": snap["symptoms_today"],
                    "analysis": snap["analysis"], "location": snap["location"],
                    "open_alert": row(open_alert), "last_reading": last_reading,
                })
        return jsonify(out)

    # ---- tags (read is open: the Simulator panel needs the tag list to
    # fake a card tap for *anyone*, including the not-yet-logged-in login
    # screen -- that's how the Simulator logs you in with no hardware.
    # Writes (assigning/removing a tag) are superuser-only (/admin) --
    # see docs/CLAUDE.md's "Superuser admin page".) ----
    @bp.get("/tags")
    def list_tags():
        with db.write_conn() as conn:
            data = rows(conn.execute("SELECT * FROM tags ORDER BY uid").fetchall())
        return jsonify([_parse_json_fields(d, "data_json") for d in data])

    TAG_TYPES = {"astronaut", "surgeon", "exercise", "sleep", "meal", "medicine", "bp_guide", "emergency"}

    @bp.post("/tags")
    def upsert_tag():
        body = request.get_json(force=True) or {}
        uid = body.get("uid").strip() if isinstance(body.get("uid"), str) else ""
        if not uid or body.get("type") not in TAG_TYPES:
            return jsonify({"error": "uid and a valid type are required"}), 400
        body["uid"] = uid
        with db.write_conn() as conn:
            _, err = admin_auth.authorize_superuser(conn)
            if err:
                return jsonify(err[0]), err[1]
            if body["type"] in ("astronaut", "surgeon") and not conn.execute(
                "SELECT 1 FROM astronauts WHERE id = ?", (body.get("astronaut_id"),)
            ).fetchone():
                return jsonify({"error": "a person card needs an existing astronaut_id"}), 400
            conn.execute(
                "INSERT OR REPLACE INTO tags (uid, type, label, astronaut_id, data_json) VALUES (?, ?, ?, ?, ?)",
                (body["uid"], body["type"], body.get("label", body["uid"]), body.get("astronaut_id"),
                 json.dumps(body.get("data", {}))),
            )
        sessions.clear_unknown_tag(body["uid"])
        emit_fn("tags_changed", {"uid": body["uid"]})
        return jsonify({"ok": True})

    @bp.delete("/tags/<uid>")
    def delete_tag(uid):
        with db.write_conn() as conn:
            _, err = admin_auth.authorize_superuser(conn)
            if err:
                return jsonify(err[0]), err[1]
            conn.execute("DELETE FROM tags WHERE uid = ?", (uid,))
        emit_fn("tags_changed", {"uid": uid})
        return jsonify({"ok": True})

    # ---- alerts (flight surgeon) ----
    @bp.get("/alerts")
    def list_alerts():
        with db.write_conn() as conn:
            _, err = auth.authorize_surgeon(conn)
            if err:
                return jsonify(err[0]), err[1]
            data = rows(conn.execute("SELECT * FROM alerts ORDER BY ts DESC LIMIT 100").fetchall())
        return jsonify(data)

    @bp.post("/alerts/<int:alert_id>/ack")
    def ack_alert(alert_id):
        with db.write_conn() as conn:
            _, err = auth.authorize_surgeon(conn)
            if err:
                return jsonify(err[0]), err[1]
            conn.execute("UPDATE alerts SET acknowledged = 1 WHERE id = ?", (alert_id,))
            row = conn.execute("SELECT astronaut_id, text FROM alerts WHERE id = ?", (alert_id,)).fetchone()
        # Every open doctor screen (badge, alerts list, crew cards) refreshes at once. The crew
        # member's Astra tells them too -- once the news could have crossed the comms delay.
        deliver_at = datetime.now(timezone.utc) + timedelta(seconds=comms.delay_seconds())
        emit_fn("alert_acknowledged", {
            "id": alert_id, "astronaut_id": row["astronaut_id"] if row else None,
            "text": row["text"] if row else "", "deliver_at": deliver_at.isoformat(),
        })
        return jsonify({"ok": True})

    # ---- messages (flight surgeon) ----
    @bp.get("/messages")
    def list_messages():
        with db.write_conn() as conn:
            _, err = auth.authorize_surgeon(conn)
            if err:
                return jsonify(err[0]), err[1]
            data = rows(conn.execute("SELECT * FROM messages ORDER BY sent_at DESC LIMIT 100").fetchall())
        now = datetime.now(timezone.utc).isoformat()
        for m in data:
            m["delivered"] = bool(m["read"]) or m["deliver_at"] <= now
        return jsonify(data)

    @bp.post("/messages")
    def send_message():
        body = request.get_json(force=True) or {}
        text = (body.get("body") or "").strip()
        astro_id = body.get("astronaut_id")
        if not text or not isinstance(astro_id, int) or isinstance(astro_id, bool):
            return jsonify({"error": "astronaut_id and a non-empty body are required"}), 400
        with db.write_conn() as conn:
            _, err = auth.authorize_surgeon(conn)
            if err:
                return jsonify(err[0]), err[1]
            if not conn.execute("SELECT 1 FROM astronauts WHERE id = ?", (astro_id,)).fetchone():
                return jsonify({"error": "not found"}), 404
        deliver_at = comms.queue_reply(astro_id, text[:2000])
        # Open screens show the reply "in transit" straight away; message_delivered follows later.
        emit_fn("message_sent", {"astronaut_id": astro_id, "deliver_at": deliver_at.isoformat()})
        return jsonify({"ok": True, "deliver_at": deliver_at.isoformat()})

    # ---- one crew member's two-way thread with the Flight Surgeon (profile page,
    # and the crew member's own inbox). Delay-aware, decided here, not in the browser:
    # a crew report still on its way shows the surgeon only that it's coming (not what
    # it says), and a surgeon reply still on its way doesn't exist yet for the crew. ----
    @bp.get("/astronauts/<int:astro_id>/messages")
    def astronaut_messages(astro_id):
        with db.write_conn() as conn:
            viewer, err = auth.authorize_view(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
            data = rows(conn.execute(
                "SELECT * FROM messages WHERE astronaut_id = ? ORDER BY sent_at ASC", (astro_id,)
            ).fetchall())
        now = datetime.now(timezone.utc).isoformat()
        viewer_is_surgeon = auth.is_surgeon(viewer) and viewer["id"] != astro_id
        out = []
        for m in data:
            delivered = bool(m["read"]) or m["deliver_at"] <= now
            own = (m["from_role"] == "surgeon") == viewer_is_surgeon
            item = {k: m[k] for k in ("id", "from_role", "sent_at", "deliver_at", "body")}
            item["delivered"] = delivered
            if not delivered and not own:
                if not viewer_is_surgeon:
                    continue
                item["body"] = None
            out.append(item)
        return jsonify(out)

    # ---- mission ----
    @bp.get("/mission")
    def get_mission():
        profile_id, profile = comms.current_profile()
        return jsonify({
            "profile_id": profile_id, "profile": profile, "all_profiles": load_missions()["profiles"],
            "health": load_mission_health()["profiles"].get(profile_id) if profile_id else None,
            # every mission's plan, so the page can show any mission before it's started
            "all_health": load_mission_health()["profiles"],
        })

    @bp.put("/mission")
    def set_mission():
        # {"profile_id": "<id>"} starts (or switches to) a mission; {"profile_id": null} stops it.
        body = request.get_json(force=True) or {}
        new_id = body.get("profile_id") or ""
        if new_id and new_id not in load_missions()["profiles"]:
            return jsonify({"error": "unknown mission"}), 400
        with db.write_conn() as conn:
            conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('mission_profile', ?)", (new_id,))
        profile_id, profile = comms.current_profile()
        emit_fn("mission_changed", {"profile_id": profile_id, "profile": profile})
        return jsonify({"profile_id": profile_id, "profile": profile})

    # ---- content ----
    @bp.get("/content")
    def content():
        return jsonify(load_content())

    @bp.get("/routine")
    def routine():
        return jsonify(load_routine())

    # ---- Schedule page: today's routine on the mission clock, with each
    # task's real status for this astronaut (backend/jobs/scheduler.py). ----
    @bp.get("/astronauts/<int:astro_id>/schedule")
    def astronaut_schedule(astro_id):
        with db.write_conn() as conn:
            _, err = auth.authorize_view(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
            plan = scheduler.day_plan(conn, astro_id)
        # Is sleep or a workout being tracked right now (tag, voice or the Today page)? The
        # Today page shows Start or Stop from this.
        tracking = {}
        for kind in ("sleep", "exercise"):
            key = sessions.running_toggle(astro_id, kind)
            info = sessions.open_toggles.get(key) if key else None
            tracking[kind] = None if not info else {
                "started_at": info["started_iso"],
                "mission_min": round((time.time() - info["started_at"]) * TIME_SCALE / 60),
            }
        return jsonify({**plan, "tracking": tracking})

    # ---- crew-wide status board: a shared station display, not a personal
    # dashboard (docs/CLAUDE.md "crew-wide status board"). Deliberately
    # unauthenticated, same as /content, /routine, /mission above -- but
    # unlike those, it reads real per-astronaut data, so it aggregates
    # before responding and never returns a name, a role other than the
    # count, or any individual's own reading. That's the one rule this
    # route exists to enforce. ----
    @bp.get("/status-board")
    def status_board():
        with db.write_conn() as conn:
            crew = [a for a in rows(conn.execute("SELECT * FROM astronauts").fetchall())
                    if a["role"] != "Flight surgeon"]
            level_counts = {"GREEN": 0, "YELLOW": 0, "RED": 0, "GRAY": 0}
            task_counts = {}
            for a in crew:
                level_counts[_today_snapshot(conn, a["id"])["status"]] += 1
                for entry in scheduler.day_plan(conn, a["id"])["entries"]:
                    key = (entry["time"], entry["text"], entry["kind"])
                    t = task_counts.setdefault(key, {
                        "time": entry["time"], "text": entry["text"], "kind": entry["kind"],
                        "done": 0, "total": 0,
                    })
                    t["total"] += 1
                    if entry["status"] == "done":
                        t["done"] += 1

        day, day_seconds = scheduler.mission_clock()
        profile_id, profile = comms.current_profile()
        return jsonify({
            "crew_count": len(crew),
            "levels": level_counts,
            "mission": {"profile_id": profile_id, "label": profile.get("label")},
            "day": day + 1,
            "day_seconds": day_seconds,
            "time_scale": scheduler.TIME_SCALE,
            "tasks": sorted(task_counts.values(), key=lambda t: t["time"]),
        })

    @bp.get("/health-rules")
    def health_rules_config():
        from backend.config import health_rules as load_health_rules
        return jsonify(load_health_rules())

    # ---- export ----
    @bp.get("/export/<int:astro_id>.csv")
    def export_csv(astro_id):
        with db.write_conn() as conn:
            _, err = auth.authorize_view(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
            data = conn.execute(
                "SELECT ts, indicator, value_json, level, source FROM readings WHERE astronaut_id = ? ORDER BY ts",
                (astro_id,),
            ).fetchall()
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["timestamp", "indicator", "value", "level", "source"])
        for r in data:
            writer.writerow([r["ts"], r["indicator"], r["value_json"], r["level"], r["source"]])
        return Response(buf.getvalue(), mimetype="text/csv",
                         headers={"Content-Disposition": f"attachment; filename=astronaut_{astro_id}.csv"})

    # ---- the login page's "Also sign in my CYD" / "This browser only"
    # choice (docs/CLAUDE.md "web-only login") -- a global mode, not a
    # per-tap flag, so it also covers a real hardware tap (the Pico), which
    # has no way to carry a browser's preference itself. Deliberately
    # unauthenticated, same as every other pre-login route (nfc_login,
    # tags reads, etc.) -- this is set from the login screen, before
    # anyone's signed in. ----
    @bp.get("/recent-scan")
    def recent_scan():
        """The last card scan if it's under 30 s old ({"uid", "age_s"}, else {}). A browser
        asks right after its live connection comes back, so a tap made while it was
        reconnecting still signs it in. Same exposure as the "scan" broadcast itself
        (unauthenticated, like the login screen that needs it)."""
        return jsonify(sessions.recent_scan())

    @bp.post("/scan-mode")
    def set_scan_mode():
        body = request.get_json(force=True) or {}
        sessions.set_scan_mode(body.get("mode"))
        return jsonify({"ok": True, "mode": sessions.current_scan_mode})

    # ---- simulator ----
    @bp.post("/simulate/scan")
    def simulate_scan():
        body = request.get_json(force=True) or {}
        bridge.inject({"type": "scan", "uid": body.get("uid"), "web_only": bool(body.get("web_only"))})
        return jsonify({"ok": True})

    @bp.post("/simulate/event")
    def simulate_event():
        msg = request.get_json(force=True) or {}
        bridge.inject(msg)
        return jsonify({"ok": True})

    # ---- emergency / reset ----
    @bp.post("/emergency")
    def emergency_control():
        body = request.get_json(force=True) or {}
        if body.get("action") == "cancel":
            sessions.cancel_emergency(send_fn, emit_fn)
        else:
            sessions.start_emergency(body.get("text", "Emergency started from the dashboard"),
                                      body.get("astronaut_id"), send_fn, emit_fn)
        return jsonify({"active": sessions.emergency["active"]})

    @bp.post("/reset-demo")
    def reset_demo():
        with db.write_conn() as conn:
            _, err = auth.authorize_surgeon(conn)
            if err:
                return jsonify(err[0]), err[1]
        seed.seed_all()
        sessions.active_sessions.clear()
        sessions.open_toggles.clear()
        emit_fn("data_reset", {})
        return jsonify({"ok": True})

    app.register_blueprint(bp)

    # ---- socket.io ----
    @socketio.on("connect")
    def on_connect():
        socketio.emit("serial_status", {"status": bridge.status})

    def _is_explicit_done(msg, astro_id):
        """Was this end_session the Done button (sign the browser out too) rather
        than the CYD's own 2-minute idle timeout (must not)? Firmware from
        2026-11-11 on says so directly ("reason"). Older firmware sends both the
        same way, so fall back to timing: the idle timeout only fires ~2 minutes
        after the CYD's last contact for this session (the session message or
        a touchscreen message -- NOT Pico tag scans, which never reset the CYD's
        timer), so a session that's already closed or has been that quiet is
        treated as idle. Erring this way only ever means
        a missed auto-logout (the browser's own Log out still works), never a
        surprise one."""
        reason = msg.get("reason")
        if reason:
            return reason == "done"
        quiet = sessions.seconds_since_cyd_contact(astro_id)
        return quiet is not None and quiet < CYD_IDLE_GUESS_S

    def handle_cyd_message(msg):
        """The single entry point for every CYD -> laptop message, whether
        it arrived over real serial or the Simulator panel (bridge.inject)."""
        mtype = msg.get("type")
        if mtype not in ("scan", "end_session", "hello", "log"):
            touched = _uid_to_astro(msg.get("uid"))
            if touched is not None:
                sessions.note_cyd_contact(touched)
        if mtype == "scan":
            # A real hardware tap never sends "web_only" at all (None here) --
            # handle_scan() falls back to the login page's current global
            # choice (sessions.current_scan_mode) in that case. Only an
            # explicit True/False (the Simulator's own per-call value)
            # overrides it, so don't coerce a missing key to False here.
            sessions.handle_scan(msg.get("uid", ""), send_fn, emit_fn, web_only=msg.get("web_only"))
        elif mtype == "mood":
            _record_cyd_value(msg, "mood", msg.get("value"))
        elif mtype == "symptoms":
            _record_symptoms(msg)
        elif mtype == "reaction":
            _record_reaction(msg)
        elif mtype == "breathing_done":
            _record_breathing(msg)
        elif mtype == "emergency":
            sessions.start_emergency("SOS button on the CYD", _uid_to_astro(msg.get("uid")), send_fn, emit_fn)
        elif mtype == "cancel_emergency":
            sessions.cancel_emergency(send_fn, emit_fn)
        elif mtype == "end_session":
            astro_id = _uid_to_astro(msg.get("uid"))
            if astro_id is not None:
                explicit_done = _is_explicit_done(msg, astro_id)
                sessions.end_session_for(astro_id, send_fn, emit_fn)
                # Pressing "Done" on the CYD is an explicit sign-off, unlike
                # a re-tap toggle or the idle timeout (both of which also end
                # the session but must NOT log the browser out -- see
                # docs/CLAUDE.md's "Login / access control"). The browser
                # that's actually logged in as this astronaut (if any) reacts
                # to this broadcast itself; the server has no reverse lookup
                # from astro_id to a specific session cookie.
                if explicit_done:
                    emit_fn("logout_requested", {"astronaut_id": astro_id})
        elif mtype == "hello":
            emit_fn("serial_status", {"status": bridge.status, "fw": msg.get("fw")})
            # A paired CYD (docs/CLAUDE.md "CYD pairing") announces who it last
            # belonged to on every hello -- cold boot, and again on every new
            # Wi-Fi connection -- so it can keep representing that astronaut
            # with no fresh tap. See sessions.resume_paired_session()'s own
            # docstring for why this can never steal an already-open session.
            paired_uid = msg.get("paired_uid")
            if paired_uid:
                sessions.resume_paired_session(paired_uid, send_fn, emit_fn)
        elif mtype == "log":
            emit_fn("cyd_event", {"type": "log", "msg": msg.get("msg", "")})
        elif mtype == "view_crew":
            _send_crew_detail(msg.get("id"))
        elif mtype == "ack_alert":
            _ack_alert_from_cyd(msg.get("id"))
        elif mtype == "quick_reply":
            _quick_reply_from_cyd(msg.get("astro_id"), msg.get("text"))
        if mtype in ("mood", "symptoms", "reaction", "breathing_done"):
            analysis.request(_uid_to_astro(msg.get("uid")), f"cyd_{mtype}")
        if mtype == "active":
            return  # the CYD's once-a-minute "someone's still using me" ping: no browser refresh
        emit_fn("cyd_event", {"type": mtype, **{k: v for k, v in msg.items() if k != "type"}})

    def _uid_to_astro(uid):
        if not uid:
            return None
        with db.write_conn() as conn:
            t = conn.execute("SELECT astronaut_id FROM tags WHERE uid = ?", (uid,)).fetchone()
        return t["astronaut_id"] if t else None

    # ---- Flight Surgeon on-device screens (phase 2 of the CYD redesign) --
    # these three mirror the existing HTTP routes below (ack_alert ~
    # POST /alerts/<id>/ack, quick_reply ~ POST /messages) exactly, just
    # triggered by a CYD gesture (hold-to-acknowledge, a quick-reply tap)
    # instead of a browser click. Kept as thin wrappers here rather than
    # having the HTTP routes call into these, since the HTTP routes already
    # existed and work; this just reuses their same DB/emit shape. ----
    def _valid_id(v):
        return isinstance(v, int) and not isinstance(v, bool)

    def _send_crew_detail(astro_id):
        if not _valid_id(astro_id):
            return
        with db.write_conn() as conn:
            detail = sessions.crew_detail_for_cyd(conn, astro_id)
        if detail:
            send_fn(protocol.crew_detail(detail))

    def _ack_alert_from_cyd(alert_id):
        if not _valid_id(alert_id):
            return
        with db.write_conn() as conn:
            conn.execute("UPDATE alerts SET acknowledged = 1 WHERE id = ?", (alert_id,))
        emit_fn("alert_acknowledged", {"id": alert_id})
        with db.write_conn() as conn:
            sessions.send_surgeon_payload(conn, send_fn)

    def _quick_reply_from_cyd(astro_id, text):
        text = (text or "").strip()
        if not _valid_id(astro_id) or not text:
            return
        with db.write_conn() as conn:
            if not conn.execute("SELECT 1 FROM astronauts WHERE id = ?", (astro_id,)).fetchone():
                return
        deliver_at = comms.queue_reply(astro_id, text[:500])
        emit_fn("message_sent", {"astronaut_id": astro_id, "deliver_at": deliver_at.isoformat()})

    def _record_cyd_value(msg, indicator, value):
        astro_id = _uid_to_astro(msg.get("uid"))
        if astro_id is None or value is None:
            return
        lvl = health_rules.evaluate(indicator, value)
        with db.write_conn() as conn:
            conn.execute(
                "INSERT INTO readings (astronaut_id, ts, indicator, value_json, level, source) VALUES (?, ?, ?, ?, ?, 'cyd')",
                (astro_id, datetime.now(timezone.utc).isoformat(), indicator, json.dumps(value), lvl),
            )

    def _record_symptoms(msg):
        astro_id = _uid_to_astro(msg.get("uid"))
        if astro_id is None:
            return
        items = msg.get("items", [])
        with db.write_conn() as conn:
            lvl = symptoms.record(conn, astro_id, items)
        symptoms.alert_if_red(astro_id, items, lvl, emit_fn)

    def _record_reaction(msg):
        astro_id = _uid_to_astro(msg.get("uid"))
        if astro_id is None:
            return
        with db.write_conn() as conn:
            _save_reaction(conn, astro_id, msg.get("avg_ms"), msg.get("lapses", 0), "cyd", msg)

    def _record_breathing(msg):
        astro_id = _uid_to_astro(msg.get("uid"))
        if astro_id is None:
            return
        with db.write_conn() as conn:
            _save_breathing(conn, astro_id, msg.get("seconds", 60))

    return handle_cyd_message
