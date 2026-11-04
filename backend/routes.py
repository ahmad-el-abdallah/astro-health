"""REST API and Socket.IO event wiring (see docs/build-prompt.md sections
9 and 12). create_routes(app, socketio, bridge) is called once from app.py.
"""
import csv
import io
import json
from datetime import datetime, timedelta, timezone

from flask import Blueprint, jsonify, request, Response

from backend import db, sessions, health_rules, comms, seed, protocol, symptoms, auth, admin_auth
from backend.config import (
    content as load_content, missions as load_missions,
    mission_health as load_mission_health,
    gamification as load_gamification, routine as load_routine,
)
from backend.gamification import recompute_badges, leaderboard_rows


def row(r):
    return dict(r) if r else None


def rows(rs):
    return [dict(r) for r in rs]


def _parse_json_fields(d, *fields):
    for f in fields:
        if f in d and isinstance(d[f], str):
            try:
                d[f] = json.loads(d[f])
            except ValueError:
                pass
    return d


def create_routes(app, socketio, bridge):
    bp = Blueprint("api", __name__, url_prefix="/api")

    def send_fn(line):
        bridge.send(line)

    def emit_fn(event, data):
        socketio.emit(event, data)

    # ---- auth: NFC-card login is the only working method today; the
    # username/password and Face ID options shown on the login screen are
    # placeholders for later (README/docs/CLAUDE.md) ----
    @bp.post("/auth/nfc_login")
    def nfc_login():
        uid = (request.get_json(force=True) or {}).get("uid")
        with db.write_conn() as conn:
            tag = conn.execute("SELECT * FROM tags WHERE uid = ?", (uid,)).fetchone()
            if not tag or tag["astronaut_id"] is None:
                return jsonify({"error": "that card isn't assigned to a crew member yet"}), 404
            astro = conn.execute("SELECT * FROM astronauts WHERE id = ?", (tag["astronaut_id"],)).fetchone()
        auth.login(astro["id"])
        return jsonify({"astronaut_id": astro["id"], "name": astro["name"], "role": astro["role"]})

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
        return jsonify({"astronaut_id": astro["id"], "name": astro["name"], "role": astro["role"]})

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
            today_levels = {}
            for ind_row in conn.execute(
                "SELECT indicator, value_json, level, ts FROM readings WHERE astronaut_id = ? "
                "AND ts >= ? ORDER BY ts DESC",
                (astro_id, (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()),
            ):
                if ind_row["indicator"] not in today_levels:
                    today_levels[ind_row["indicator"]] = {
                        "value": json.loads(ind_row["value_json"]), "level": ind_row["level"], "ts": ind_row["ts"],
                    }
            last_assessment = conn.execute(
                "SELECT * FROM assessments WHERE astronaut_id = ? ORDER BY ts DESC LIMIT 1", (astro_id,)
            ).fetchone()
            points_total = conn.execute(
                "SELECT COALESCE(SUM(amount),0) AS t FROM points WHERE astronaut_id = ?", (astro_id,)
            ).fetchone()["t"]
            symptom_row = conn.execute(
                "SELECT items_json, level, ts FROM symptoms WHERE astronaut_id = ? AND ts >= ? "
                "ORDER BY ts DESC LIMIT 1",
                (astro_id, (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()),
            ).fetchone()
            symptoms_today = (
                {"items": json.loads(symptom_row["items_json"]), "level": symptom_row["level"], "ts": symptom_row["ts"]}
                if symptom_row else None
            )
            body_levels = {}
        body_cfg = load_content()["body_parts"]
        for part in body_cfg:
            part_levels = [v["level"] for ind, v in today_levels.items()
                           if health_rules.body_part_for(ind) == part]
            body_levels[part] = health_rules.overall_level(part_levels) if part_levels else "GRAY"
        return jsonify({
            "astronaut": row(astro),
            "today": today_levels,
            "overall_level": last_assessment["overall_level"] if last_assessment else "GRAY",
            "last_check": last_assessment["ts"] if last_assessment else None,
            "points": points_total,
            "body_levels": body_levels,
            "session_active": astro_id in sessions.active_sessions,
            "symptoms_today": symptoms_today,
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
                "SELECT ts, value_json, level FROM readings WHERE astronaut_id = ? AND indicator = ? "
                "AND ts >= ? ORDER BY ts ASC",
                (astro_id, indicator, since),
            ).fetchall()
        return jsonify([{"ts": r["ts"], "value": json.loads(r["value_json"]), "level": r["level"]} for r in data])

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
            points_cfg = load_gamification()["points"]
            amount = points_cfg.get("assess_complete", 0)
            if amount:
                conn.execute("INSERT INTO points (astronaut_id, ts, amount, reason) VALUES (?, ?, ?, 'assess_complete')",
                             (astro_id, now.isoformat(), amount))
            if overall == "RED":
                conn.execute("INSERT INTO alerts (astronaut_id, ts, level, text, acknowledged) VALUES (?, ?, 'RED', ?, 0)",
                             (astro_id, now.isoformat(), note))

        if overall == "RED":
            comms.queue_report(astro_id, f"RED assessment: {note}")
            emit_fn("alert", {"astronaut_id": astro_id, "level": "RED", "text": note})
        bridge.send(protocol.status(astro["name"], overall, note))
        bridge.send(protocol.led(overall))
        emit_fn("assessment", {"astronaut_id": astro_id, "overall_level": overall, "note": note, "details": details})
        recompute_badges(astro_id, emit_fn)
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
                pts = conn.execute("SELECT COALESCE(SUM(amount),0) AS t FROM points WHERE astronaut_id = ?", (a["id"],)).fetchone()["t"]
                active_alerts = conn.execute("SELECT COUNT(*) AS c FROM alerts WHERE astronaut_id = ? AND acknowledged = 0", (a["id"],)).fetchone()["c"]
                out.append({
                    **row(a), "overall_level": last["overall_level"] if last else "GRAY",
                    "last_check": last["ts"] if last else None, "points": pts, "active_alerts": active_alerts,
                    "session_active": a["id"] in sessions.active_sessions,
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
        with db.write_conn() as conn:
            _, err = auth.authorize_surgeon(conn)
            if err:
                return jsonify(err[0]), err[1]
        deliver_at = comms.queue_reply(body.get("astronaut_id"), body["body"])
        return jsonify({"ok": True, "deliver_at": deliver_at.isoformat()})

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

    @bp.get("/health-rules")
    def health_rules_config():
        from backend.config import health_rules as load_health_rules
        return jsonify(load_health_rules())

    # ---- rewards ----
    @bp.get("/rewards/<int:astro_id>")
    def rewards(astro_id):
        with db.write_conn() as conn:
            _, err = auth.authorize_view(conn, astro_id)
            if err:
                return jsonify(err[0]), err[1]
            pts = conn.execute("SELECT COALESCE(SUM(amount),0) AS t FROM points WHERE astronaut_id = ?", (astro_id,)).fetchone()["t"]
            badges = rows(conn.execute("SELECT * FROM badges WHERE astronaut_id = ?", (astro_id,)).fetchall())
        gam = load_gamification()
        return jsonify({"points": pts, "badges": badges, "badge_catalog": gam["badges"], "team_goal": gam["team_goal"]})

    @bp.get("/leaderboard")
    def leaderboard():
        return jsonify(leaderboard_rows())

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

    def handle_cyd_message(msg):
        """The single entry point for every CYD -> laptop message, whether
        it arrived over real serial or the Simulator panel (bridge.inject)."""
        mtype = msg.get("type")
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
                sessions.end_session_for(astro_id, send_fn, emit_fn)
                # Pressing "Done" on the CYD is an explicit sign-off, unlike
                # a re-tap toggle or the idle timeout (both of which also end
                # the session but must NOT log the browser out -- see
                # docs/CLAUDE.md's "Login / access control"). The browser
                # that's actually logged in as this astronaut (if any) reacts
                # to this broadcast itself; the server has no reverse lookup
                # from astro_id to a specific session cookie.
                emit_fn("logout_requested", {"astronaut_id": astro_id})
        elif mtype == "hello":
            emit_fn("serial_status", {"status": bridge.status, "fw": msg.get("fw")})
        elif mtype == "log":
            emit_fn("cyd_event", {"type": "log", "msg": msg.get("msg", "")})
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
            points_cfg = load_gamification()["points"]
            reason = {"mood": "mood_logged"}.get(indicator)
            if reason and points_cfg.get(reason):
                conn.execute("INSERT INTO points (astronaut_id, ts, amount, reason) VALUES (?, ?, ?, ?)",
                             (astro_id, datetime.now(timezone.utc).isoformat(), points_cfg[reason], reason))

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
            points_cfg = load_gamification()["points"]
            if points_cfg.get("reaction_test"):
                conn.execute("INSERT INTO points (astronaut_id, ts, amount, reason) VALUES (?, ?, ?, 'reaction_test')",
                             (astro_id, datetime.now(timezone.utc).isoformat(), points_cfg["reaction_test"]))

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
            points_cfg = load_gamification()["points"]
            if points_cfg.get("breathing_session"):
                conn.execute("INSERT INTO points (astronaut_id, ts, amount, reason) VALUES (?, ?, ?, 'breathing_session')",
                             (astro_id, now, points_cfg["breathing_session"]))

    return handle_cyd_message
