"""Creates one row in the `superusers` table -- the login for the /admin
page (backend/admin_routes.py, backend/admin_auth.py). Run once per person
who needs admin access:

    .venv/bin/python -m backend.create_superuser

Prompts for a username and password (password hidden via getpass). Mirrors
backend/seed.py's style: one function tests can call directly
(create_superuser), plus a __main__ guard for interactive use.
"""
import getpass
from datetime import datetime, timezone

from werkzeug.security import generate_password_hash

from backend import db


def create_superuser(username, password):
    """Inserts a new superuser row, hashing `password` with werkzeug's
    generate_password_hash (never stored in plain text). Raises
    sqlite3.IntegrityError if `username` is already taken."""
    db.init_db()  # make sure the superusers table exists even on a brand-new DB
    with db.write_conn() as conn:
        conn.execute(
            "INSERT INTO superusers (username, password_hash, created_at) VALUES (?, ?, ?)",
            (username, generate_password_hash(password), datetime.now(timezone.utc).isoformat()),
        )


if __name__ == "__main__":
    username = input("Superuser username: ").strip()
    password = getpass.getpass("Superuser password: ")
    confirm = getpass.getpass("Confirm password: ")
    if not username or not password:
        print("Username and password are both required, nothing created.")
    elif password != confirm:
        print("Passwords didn't match, nothing created.")
    else:
        create_superuser(username, password)
        print(f"Superuser '{username}' created.")
