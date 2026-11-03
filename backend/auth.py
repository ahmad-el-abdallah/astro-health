"""Who's allowed to see which astronaut's data.

Login is a plain Flask session cookie holding astronaut_id -- set by
tapping an NFC card (resolved through the same tags table sessions.py
already uses for scans), not a separate accounts table or password
store. The Flight Surgeon is just an astronaut row too (role == "Flight
surgeon"), so logging in as them works the same way, and they're the one
role allowed to view every other astronaut's data -- that's the point of
the role (docs/CLAUDE.md's "Flight Surgeon sees everyone" decision).

Like backend/sessions.py's active_sessions, this is a live-demo concept,
not a real account system -- but unlike that in-memory table, the signing
key behind this cookie is persisted to disk (data/secret_key, see app.py's
_load_or_create_secret_key) specifically so a session survives both a
plain page refresh and an app.py restart. Delete that file to force
everyone to log in again.
"""
from flask import session

SURGEON_ROLE = "Flight surgeon"


def login(astro_id):
    session["astronaut_id"] = astro_id


def logout():
    session.pop("astronaut_id", None)


def current_astronaut_id():
    return session.get("astronaut_id")


def current_astronaut(conn):
    """The logged-in astronaut's full row, or None if nobody's logged in
    (or their session points at an astronaut that no longer exists)."""
    aid = current_astronaut_id()
    if aid is None:
        return None
    return conn.execute("SELECT * FROM astronauts WHERE id = ?", (aid,)).fetchone()


def is_surgeon(astro_row):
    return bool(astro_row) and astro_row["role"] == SURGEON_ROLE


def can_view(viewer_row, astro_id):
    """Whether the logged-in `viewer_row` may see astronaut `astro_id`'s data."""
    if viewer_row is None:
        return False
    return viewer_row["id"] == astro_id or is_surgeon(viewer_row)


def authorize_view(conn, astro_id):
    """For a route about one specific astronaut's data. Returns
    (viewer_row, None) if allowed, else (None, (body, status)) ready to
    return as `jsonify(body), status`."""
    viewer = current_astronaut(conn)
    if viewer is None:
        return None, ({"error": "not logged in"}, 401)
    if not can_view(viewer, astro_id):
        return None, ({"error": "forbidden"}, 403)
    return viewer, None


def authorize_surgeon(conn):
    """For a route that only the Flight Surgeon may use (the crew roster,
    crew-wide alerts/messages)."""
    viewer = current_astronaut(conn)
    if viewer is None:
        return None, ({"error": "not logged in"}, 401)
    if not is_surgeon(viewer):
        return None, ({"error": "forbidden"}, 403)
    return viewer, None
