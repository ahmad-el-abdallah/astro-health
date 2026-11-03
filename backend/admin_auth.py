"""Who's allowed to use the superuser admin page (/admin) -- a completely
separate login from the astronaut/Flight-Surgeon one in backend/auth.py.
Uses session["superuser_id"], never "astronaut_id", so a superuser session
here and an astronaut (or Flight Surgeon) session in the main app coexist
independently in the same browser: they're just two different keys inside
the one signed session cookie app.py already sets up (same app.secret_key,
same data/secret_key persistence -- see app.py's
_load_or_create_secret_key()).

Like backend/auth.py's astronaut sessions, every superuser is equally
privileged -- there's no "which superuser" distinction to enforce, so
authorize_superuser only ever needs a 401, never a 403.
"""
from flask import session
from werkzeug.security import check_password_hash


def login(superuser_id):
    session["superuser_id"] = superuser_id


def logout():
    session.pop("superuser_id", None)


def current_superuser_id():
    return session.get("superuser_id")


def current_superuser(conn):
    sid = current_superuser_id()
    if sid is None:
        return None
    return conn.execute("SELECT * FROM superusers WHERE id = ?", (sid,)).fetchone()


def verify_login(conn, username, password):
    """Returns the matching superuser row, or None if the username doesn't
    exist or the password is wrong."""
    row = conn.execute("SELECT * FROM superusers WHERE username = ?", (username,)).fetchone()
    if row is None or not check_password_hash(row["password_hash"], password):
        return None
    return row


def authorize_superuser(conn):
    """For any /api/admin/* route, and for the tag-write/astronaut-admin
    routes in routes.py. Returns (superuser_row, None) if logged in, else
    (None, (body, status)) ready to return as `jsonify(body), status`."""
    su = current_superuser(conn)
    if su is None:
        return None, ({"error": "not logged in"}, 401)
    return su, None
