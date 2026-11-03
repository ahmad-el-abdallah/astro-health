"""Flask routes for the superuser admin page (/admin): its own login/
session (backend/admin_auth.py), the unknown-tag backlog (populated by
backend/sessions.py's handle_scan), a roster endpoint for the astronaut
picker, and serving the page itself. Kept out of backend/routes.py's `api`
blueprint because this is an entirely separate access-control domain with
no astronaut/Flight-Surgeon session involved -- see docs/CLAUDE.md's
"Superuser admin page".
"""
from flask import Blueprint, jsonify, request, render_template

from backend import db, admin_auth, sessions


def create_admin_routes(app):
    bp = Blueprint("admin", __name__, url_prefix="/api/admin")

    @app.get("/admin")
    def admin_page():
        return render_template("admin.html")

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
            data = conn.execute("SELECT id, name, role, color FROM astronauts ORDER BY id").fetchall()
        return jsonify([dict(r) for r in data])

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
