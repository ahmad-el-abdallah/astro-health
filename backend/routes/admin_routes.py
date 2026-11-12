"""Flask routes for the superuser admin page (/admin): its own login/
session (backend/auth/admin_auth.py), the unknown-tag backlog (populated by
backend/logic/sessions.py's handle_scan), a roster endpoint for the astronaut
picker. The page itself is the React app's /admin route (frontend/src/pages/admin/),
served by app.py's SPA catch-all like every other page. Kept out of backend/routes/routes.py's `api`
blueprint because this is an entirely separate access-control domain with
no astronaut/Flight-Surgeon session involved -- see docs/CLAUDE.md's
"Superuser admin page".
"""
from flask import Blueprint, Response, jsonify, request

from backend import db, voice_settings
from backend.services import voice
from backend.auth import admin_auth
from backend.logic import sessions


def create_admin_routes(app):
    bp = Blueprint("admin", __name__, url_prefix="/api/admin")

    @bp.post("/login")
    def admin_login():
        body = request.get_json(force=True) or {}
        with db.write_conn() as conn:
            su = admin_auth.verify_login(conn, body.get("username", ""), body.get("password", ""))
        if su is None:
            return jsonify({"error": "invalid username or password"}), 401
        admin_auth.login(su["id"])
        return jsonify({"username": su["username"]})

    @bp.post("/logout")
    def admin_logout():
        admin_auth.logout()
        return jsonify({"ok": True})

    @bp.get("/me")
    def admin_me():
        with db.write_conn() as conn:
            su = admin_auth.current_superuser(conn)
        return jsonify({"username": su["username"] if su else None})

    @bp.get("/astronauts")
    def admin_astronauts():
        with db.write_conn() as conn:
            _, err = admin_auth.authorize_superuser(conn)
            if err:
                return jsonify(err[0]), err[1]
            # Sign-in status for the Crew accounts card (never the secrets themselves).
            data = conn.execute(
                "SELECT a.id, a.name, a.role, a.color, a.username, "
                "a.password_hash IS NOT NULL AS has_password, a.face_descriptor_json IS NOT NULL AS has_face_id, "
                "(SELECT uid FROM tags t WHERE t.astronaut_id = a.id AND t.type IN ('astronaut','surgeon') LIMIT 1) AS card_uid "
                "FROM astronauts a ORDER BY a.id"
            ).fetchall()
        return jsonify([{**dict(r), "has_password": bool(r["has_password"]), "has_face_id": bool(r["has_face_id"])} for r in data])

    # ---- station voice: which engine speaks Doctor AI's replies ----
    @bp.get("/voice-settings")
    def admin_voice_settings():
        with db.write_conn() as conn:
            _, err = admin_auth.authorize_superuser(conn)
        if err:
            return jsonify(err[0]), err[1]
        return jsonify(voice_settings.public())

    @bp.put("/voice-settings")
    def admin_set_voice_settings():
        with db.write_conn() as conn:
            _, err = admin_auth.authorize_superuser(conn)
        if err:
            return jsonify(err[0]), err[1]
        settings, problem = voice_settings.validate(request.get_json(force=True))
        if problem:
            return jsonify({"error": problem}), 400
        voice_settings.save(settings)
        return jsonify(voice_settings.public())

    @bp.post("/voice-test")
    def admin_voice_test():
        """'Test voice' on the admin card: a sample line in the chosen neural voice."""
        with db.write_conn() as conn:
            _, err = admin_auth.authorize_superuser(conn)
        if err:
            return jsonify(err[0]), err[1]
        # The card's UNSAVED form, so "Test voice" plays exactly what you're about to save.
        settings, problem = voice_settings.validate(request.get_json(force=True) or {})
        if problem:
            return jsonify({"error": problem}), 400
        try:
            audio = voice.synthesize("Station health system online. All crew vitals are being monitored.",
                                     settings["voice"], settings["rate"], settings["pitch"])
        except voice.SpeechError:
            return jsonify({"error": "speech synthesis failed"}), 502
        return Response(audio, mimetype="audio/mpeg")

    @bp.get("/unknown-tags")
    def admin_unknown_tags():
        with db.write_conn() as conn:
            _, err = admin_auth.authorize_superuser(conn)
            if err:
                return jsonify(err[0]), err[1]
        return jsonify(sessions.unknown_tags())

    @bp.delete("/unknown-tags/<uid>")
    def admin_dismiss_unknown_tag(uid):
        with db.write_conn() as conn:
            _, err = admin_auth.authorize_superuser(conn)
            if err:
                return jsonify(err[0]), err[1]
        sessions.clear_unknown_tag(uid)
        return jsonify({"ok": True})

    app.register_blueprint(bp)
