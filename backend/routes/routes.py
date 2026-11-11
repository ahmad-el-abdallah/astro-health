"""REST API and Socket.IO event wiring (see docs/build-prompt.md sections
9 and 12). create_routes(app, socketio, bridge) is called once from app.py.
"""
import csv
import io
import json
import math
from datetime import datetime, timedelta, timezone

from flask import Blueprint, jsonify, request, Response
from werkzeug.security import check_password_hash, generate_password_hash

from backend import db, seed
from backend.logic import sessions, health_rules, symptoms
from backend.jobs import comms, scheduler
from backend.hardware import protocol
from backend.auth import auth, admin_auth
from backend.services import consult, voice
from backend.config import (
    content as load_content, missions as load_missions,
    mission_health as load_mission_health,
    routine as load_routine,
    MAX_CONSULT_HISTORY_TURNS, MAX_CONSULT_HISTORY_MSG_CHARS,
)


def row(r):
    return dict(r) if r else None


def rows(rs):
    return [dict(r) for r in rs]


# ---- login: shared by the NFC/password/Face ID auth routes below ----

FACE_MATCH_THRESHOLD = 0.6  # field-standard Euclidean threshold -- face-api.js's own default,
                            # also what the Python face_recognition/dlib library uses.


def _valid_descriptor(d):
    return (
        isinstance(d, list) and len(d) == 128
        and all(isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) for x in d)
        # isinstance(x, bool) check: isinstance(True, int) is True in Python, the same trap
        # backend/services/consult.py's parse_model_output() already had to guard against.
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
    for ind_row in conn.execute(
        "SELECT indicator, level FROM readings WHERE astronaut_id = ? AND ts >= ? ORDER BY ts DESC",
        (astro_id, (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()),
    ):
        if ind_row["indicator"] not in today_levels:
            today_levels[ind_row["indicator"]] = ind_row["level"]
    body_cfg = load_content()["body_parts"]
    body_levels = {}
    for part in body_cfg:
        part_levels = [lvl for ind, lvl in today_levels.items() if health_rules.body_part_for(ind) == part]
        body_levels[part] = health_rules.overall_level(part_levels) if part_levels else "GRAY"
    return body_levels


def _today_snapshot(conn, astro_id):
    """The last 24 h for one astronaut, shared by /summary (Overview) and /crew (the
    Flight Surgeon's crew cards): latest reading per indicator, latest symptom report,
    and a single status -- the worst of those, or GRAY ("no data") when there's nothing."""
    since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
    today = {}
    for r in conn.execute(
        "SELECT indicator, value_json, level, ts FROM readings WHERE astronaut_id = ? AND ts >= ? ORDER BY ts DESC",
        (astro_id, since),
    ):
        if r["indicator"] not in today:
            today[r["indicator"]] = {"value": json.loads(r["value_json"]), "level": r["level"], "ts": r["ts"]}
    sym = conn.execute(
        "SELECT items_json, level, ts FROM symptoms WHERE astronaut_id = ? AND ts >= ? ORDER BY ts DESC LIMIT 1",
        (astro_id, since),
    ).fetchone()
    symptoms_today = {"items": json.loads(sym["items_json"]), "level": sym["level"], "ts": sym["ts"]} if sym else None
    levels = [v["level"] for v in today.values()] + ([symptoms_today["level"]] if symptoms_today else [])
    return {
        "today": today,
        "symptoms_today": symptoms_today,
        "status": health_rules.overall_level(levels) if levels else "GRAY",
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


def _elevated_today_lines(conn, astro_id, content_cfg):
    """Region labels + level for whatever's currently YELLOW/RED (blending
    vitals with discomfort, same as /discomfort/report), formatted for the
    Consultation AI's system prompt -- GREEN/GRAY are never included, so the
    model isn't handed a wall of "all clear" noise to work around."""
    vitals = _compute_body_levels(conn, astro_id)
    discomfort = _latest_discomfort(conn, astro_id)
    labels = content_cfg["body_parts"]
    lines = []
    for region, vlevel in vitals.items():
        vlevel = health_rules.GREEN if vlevel == "GRAY" else vlevel
        blended = health_rules.worse(vlevel, _discomfort_band(discomfort.get(region, 0)))
        if blended != health_rules.GREEN:
            lines.append(f"{labels[region]['label']}: {blended} today")
    return lines


# Indicator -> (unit, decimal places), for formatting a trend line -- units/precision match
# config/health_rules.json's own (heart_rate bpm, temperature is Celsius not Fahrenheit,
# blood_sugar mg/dL). blood_pressure is deliberately excluded here to keep this simple (it's a
# pair, not a single number to average).
_TREND_INDICATORS = {
    "heart_rate": ("bpm", 0),
    "temperature": ("°C", 1),
    "blood_sugar": ("mg/dL", 0),
}


def _recent_trend_summary(conn, astro_id, indicator, days=7):
    """One formatted line like "Heart rate, last 7 days: avg 78 bpm (range
    65-95)." for the Consultation AI's context, or None if there's no data
    in the window -- confirmed no existing summarizer does this; reuses the
    exact same query astronaut_history() already runs, just aggregated."""
    unit, decimals = _TREND_INDICATORS[indicator]
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    data = conn.execute(
        "SELECT value_json FROM readings WHERE astronaut_id = ? AND indicator = ? AND ts >= ? ORDER BY ts ASC",
        (astro_id, indicator, since),
    ).fetchall()
    values = [v for v in (json.loads(r["value_json"]) for r in data) if isinstance(v, (int, float))]
    if not values:
        return None
    avg = sum(values) / len(values)
    label = indicator.replace("_", " ").capitalize()
    return (
        f"{label}, last {days} days: avg {avg:.{decimals}f} {unit} "
        f"(range {min(values):.{decimals}f}-{max(values):.{decimals}f})"
    )


def _sanitize_chat_history(raw):
    """The client's own cap (MAX_CONSULT_HISTORY_TURNS) is advisory only --
    this is the real trust boundary. Drops anything malformed rather than
    400ing (matches this app's degrade-gracefully posture), and critically
    whitelists role to user/assistant only: a direct API call could try to
    smuggle a fake {"role": "system", ...} turn to override the real system
    prompt, which this silently strips."""
    if not isinstance(raw, list):
        return []
    out = []
    for item in raw[-MAX_CONSULT_HISTORY_TURNS:]:
        if not isinstance(item, dict):
            continue
        role, content = item.get("role"), item.get("content")
        if role not in ("user", "assistant") or not isinstance(content, str) or not content.strip():
            continue
        out.append({"role": role, "content": content.strip()[:MAX_CONSULT_HISTORY_MSG_CHARS]})
    return out


# Older CYD firmware's idle timeout is 2 minutes; anything this quiet is that timeout.
CYD_IDLE_GUESS_S = 100


def create_routes(app, socketio, bridge):
    bp = Blueprint("api", __name__, url_prefix="/api")

    def send_fn(line):
        bridge.send(line)

    def emit_fn(event, data):
        socketio.emit(event, data)

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
            if "name" in body:
                conn.execute("UPDATE astronauts SET name = ? WHERE id = ?", (body["name"], astro_id))
            r = conn.execute("SELECT * FROM astronauts WHERE id = ?", (astro_id,)).fetchone()
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
        return jsonify({
            "astronaut": row(astro),
            "today": snap["today"],
            "overall_level": last_assessment["overall_level"] if last_assessment else "GRAY",
            "last_check": last_assessment["ts"] if last_assessment else None,
            "body_levels": body_levels,
            "discomfort": discomfort,
            "session_active": astro_id in sessions.active_sessions,
            "symptoms_today": snap["symptoms_today"],
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

    @bp.get("/astronauts/<int:astro_id>/simulate_vitals")
    def simulate_vitals(astro_id):
        return jsonify(health_rules.sample_vitals())

    @bp.post("/astronauts/<int:astro_id>/assess")
    def assess(astro_id):
        body = request.get_json(force=True) or {}
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

            # Fold in whatever the CYD already reported today (sleep, mood, reaction, symptoms).
            # indicator_levels tracks every indicator considered for this assessment (name,
            # level), not just the 4 manual vitals -- so the note below can name ALL of them
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
            if overall == "RED":
                conn.execute("INSERT INTO alerts (astronaut_id, ts, level, text, acknowledged) VALUES (?, ?, 'RED', ?, 0)",
                             (astro_id, now.isoformat(), note))

        if overall == "RED":
            comms.queue_report(astro_id, f"RED assessment: {note}")
            emit_fn("alert", {"astronaut_id": astro_id, "level": "RED", "text": note})
        bridge.send(protocol.status(astro["name"], overall, note))
        bridge.send(protocol.led(overall))
        emit_fn("assessment", {"astronaut_id": astro_id, "overall_level": overall, "note": note, "details": details})
        return jsonify({"overall_level": overall, "note": note, "details": details})

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
        symptoms.alert_if_red(astro_id, items, lvl, emit_fn)
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
        already gives the intensity slider. Reached from the Consultation
        AI's alert_surgeon/alert_text decision, but is a normal REST route
        like any other, usable directly too."""
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

    # ---- Mental Health tab: mood check-in + journal ----
    MOOD_SCORES = {"rough": 1, "low": 2, "okay": 3, "good": 4, "great": 5}

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
        # display: elevated-today lines, Trends, the Consultation AI's context)
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
        emit_fn("cyd_event", {"type": "sleep", "astronaut_id": astro_id, "hours": hours, "level": lvl})
        return jsonify({"hours": hours, "level": lvl})

    # ---- Body tab's Consultation chat: an NVIDIA-hosted AI agent, optional
    # (falls back client-side to keyword matching with no key configured).
    # Gives the AI more than a reply to work with: elevated_today/
    # trend_lines/schedule_lines (with each task's live status) are read
    # fresh from the DB every call -- but consult_chat() itself still
    # performs zero writes. Every action the AI decides on (vital, symptom,
    # alert, breathing, emergency) is persisted by the FRONTEND calling an
    # already-existing route (or the one new /alert route above) after the
    # fact, the same "AI decides, a separate call persists it" pattern this
    # chat has used since it only logged discomfort. ----
    @bp.post("/astronauts/<int:astro_id>/consult")
    def consult_chat(astro_id):
        body = request.get_json(force=True) or {}
        message = (body.get("message") or "").strip()
        if not message:
            return jsonify({"error": "message is required"}), 400
        if not consult.available():
            return jsonify({"error": "AI consultation is not configured"}), 503
        history = _sanitize_chat_history(body.get("history"))
        content_cfg = load_content()
        with db.write_conn() as conn:
            _, err = auth.authorize_view(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
            astro = conn.execute("SELECT * FROM astronauts WHERE id = ?", (astro_id,)).fetchone()
            if not astro:
                return jsonify({"error": "not found"}), 404
            elevated_today = _elevated_today_lines(conn, astro_id, content_cfg)
            plan = scheduler.day_plan(conn, astro_id)
            schedule_lines = [f"{e['time']} - {e['text']} ({e['status']})" for e in plan["entries"]]
            trend_lines = [
                line for line in (
                    _recent_trend_summary(conn, astro_id, ind)
                    for ind in ("heart_rate", "temperature", "blood_sugar")
                ) if line
            ]
        profile_id, profile = comms.current_profile()
        hazard_lines = []
        for region, info in content_cfg["body_parts"].items():
            match = next((h for h in info.get("hazards", []) if h in profile.get("main_concerns", [])), None)
            if match:
                hazard_lines.append(f"{info['label']}: {content_cfg['hazards'][match]['summary']}")
        try:
            decision = consult.ask(
                message, astro["name"], profile["label"], hazard_lines, content_cfg["body_parts"],
                symptoms.catalog(), history=history, elevated_today=elevated_today,
                schedule_lines=schedule_lines, trend_lines=trend_lines,
            )
        except consult.ConsultError:
            return jsonify({"error": "AI consultation failed"}), 502
        return jsonify(decision)

    # ---- Face to Face mode: speaks the Consultation AI's reply out loud
    # (edge-tts, optional -- a failure here degrades gracefully, the text
    # reply already showed independently of this call) ----
    @bp.post("/astronauts/<int:astro_id>/speak")
    def speak(astro_id):
        body = request.get_json(force=True) or {}
        text = (body.get("text") or "").strip()[:1000]
        if not text:
            return jsonify({"error": "text is required"}), 400
        with db.write_conn() as conn:
            _, err = auth.authorize_view(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
        try:
            audio = voice.synthesize(text)
        except voice.SpeechError:
            return jsonify({"error": "speech synthesis failed"}), 502
        return Response(audio, mimetype="audio/mpeg")

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

    @bp.post("/tags")
    def upsert_tag():
        body = request.get_json(force=True) or {}
        with db.write_conn() as conn:
            _, err = admin_auth.authorize_superuser(conn)
            if err:
                return jsonify(err[0]), err[1]
            conn.execute(
                "INSERT OR REPLACE INTO tags (uid, type, label, astronaut_id, data_json) VALUES (?, ?, ?, ?, ?)",
                (body["uid"], body["type"], body.get("label", body["uid"]), body.get("astronaut_id"),
                 json.dumps(body.get("data", {}))),
            )
        sessions.clear_unknown_tag(body["uid"])
        return jsonify({"ok": True})

    @bp.delete("/tags/<uid>")
    def delete_tag(uid):
        with db.write_conn() as conn:
            _, err = admin_auth.authorize_superuser(conn)
            if err:
                return jsonify(err[0]), err[1]
            conn.execute("DELETE FROM tags WHERE uid = ?", (uid,))
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
        # Every open doctor screen (badge, alerts list, crew cards) refreshes at once.
        emit_fn("alert_acknowledged", {"id": alert_id})
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
            "health": load_mission_health()["profiles"].get(profile_id),
        })

    @bp.put("/mission")
    def set_mission():
        body = request.get_json(force=True) or {}
        with db.write_conn() as conn:
            conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('mission_profile', ?)", (body["profile_id"],))
        profile_id, profile = comms.current_profile()
        emit_fn("mission_changed", {"profile_id": profile_id, "profile": profile})
        return jsonify({"profile_id": profile_id, "profile": profile})

    # ---- content / learn ----
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
            return jsonify(scheduler.day_plan(conn, astro_id))

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

    # ---- simulator ----
    @bp.post("/simulate/scan")
    def simulate_scan():
        uid = (request.get_json(force=True) or {}).get("uid")
        bridge.inject({"type": "scan", "uid": uid})
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
            sessions.handle_scan(msg.get("uid", ""), send_fn, emit_fn)
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
        elif mtype == "log":
            emit_fn("cyd_event", {"type": "log", "msg": msg.get("msg", "")})
        if mtype == "active":
            return  # the CYD's once-a-minute "someone's still using me" ping: no browser refresh
        emit_fn("cyd_event", {"type": mtype, **{k: v for k, v in msg.items() if k != "type"}})

    def _uid_to_astro(uid):
        if not uid:
            return None
        with db.write_conn() as conn:
            t = conn.execute("SELECT astronaut_id FROM tags WHERE uid = ?", (uid,)).fetchone()
        return t["astronaut_id"] if t else None

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
            baseline = conn.execute("SELECT baseline_reaction_ms FROM astronauts WHERE id = ?", (astro_id,)).fetchone()[0]
            avg_ms, lapses = msg.get("avg_ms"), msg.get("lapses", 0)
            lvl = health_rules.evaluate("reaction_time", (avg_ms, lapses), baseline_reaction_ms=baseline)
            conn.execute(
                "INSERT INTO readings (astronaut_id, ts, indicator, value_json, level, source) VALUES (?, ?, 'reaction_time', ?, ?, 'cyd')",
                (astro_id, datetime.now(timezone.utc).isoformat(), json.dumps({"avg_ms": avg_ms, "lapses": lapses}), lvl),
            )
            conn.execute(
                "INSERT INTO activities (astronaut_id, kind, started_at, ended_at, data_json) VALUES (?, 'reaction', ?, ?, ?)",
                (astro_id, datetime.now(timezone.utc).isoformat(), datetime.now(timezone.utc).isoformat(), json.dumps(msg)),
            )

    def _record_breathing(msg):
        astro_id = _uid_to_astro(msg.get("uid"))
        if astro_id is None:
            return
        with db.write_conn() as conn:
            now = datetime.now(timezone.utc).isoformat()
            conn.execute(
                "INSERT INTO activities (astronaut_id, kind, started_at, ended_at, data_json) VALUES (?, 'breathing', ?, ?, ?)",
                (astro_id, now, now, json.dumps({"seconds": msg.get("seconds", 60)})),
            )

    return handle_cyd_message
