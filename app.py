"""Starts the Astro Health Station: Flask + Socket.IO + the CYD bridge.
See docs/build-prompt.md for the full spec, and README.md for setup.

    python app.py                 # auto-detect: USB serial, then the CYD's
                                   # own Wi-Fi AP (if this machine is already
                                   # joined to it), then simulation
    python app.py --port COM5     # force a specific USB serial port
    python app.py --simulate      # force simulation, skip hardware entirely
    python app.py --wifi          # force the Wi-Fi bridge (join the CYD's
                                   # access point on this machine first)
"""
import argparse
import os
import threading
import time
from datetime import timedelta

from flask import Flask, jsonify, send_from_directory
from flask_socketio import SocketIO

from backend import db, seed
from backend.logic import analysis, astra_memory, sessions
from backend.jobs import comms, scheduler
from backend.routes import routes, admin_routes
from backend import config
from backend.config import DATA_DIR
from backend.hardware.pico_bridge import PicoBridge
from backend.hardware.serial_bridge import SerialBridge, find_port
from backend.hardware.wifi_bridge import (
    WifiBridge, is_reachable as wifi_is_reachable,
    DEFAULT_HOST as WIFI_DEFAULT_HOST, DEFAULT_PORT as WIFI_DEFAULT_PORT,
    MDNS_HOST as WIFI_MDNS_HOST,
)

BACKGROUND_TICK_S = 2
LOGIN_LIFETIME = timedelta(hours=1)
SECRET_KEY_PATH = os.path.join(DATA_DIR, "secret_key")


def _load_or_create_secret_key():
    """Persisted on disk (data/secret_key, git-ignored) instead of a fresh
    os.urandom() every run, so restarting app.py during dev/testing doesn't
    invalidate every signed-in session cookie -- otherwise a page refresh
    that happens to land after a restart would force everyone to re-tap
    their NFC card. Still nothing to leak: it's demo-local, not a real
    account system, and deleting the file just logs everyone out."""
    if os.path.exists(SECRET_KEY_PATH):
        with open(SECRET_KEY_PATH, "rb") as f:
            return f.read()
    os.makedirs(DATA_DIR, exist_ok=True)
    key = os.urandom(24)
    with open(SECRET_KEY_PATH, "wb") as f:
        f.write(key)
    return key


def parse_args():
    p = argparse.ArgumentParser(description="Astro Health Station backend")
    p.add_argument("--port", default=os.environ.get("ASTRO_PORT"), help="CYD serial port, e.g. /dev/ttyUSB0 or COM5")
    p.add_argument("--simulate", action="store_true", help="skip the serial port entirely; use the Simulator panel")
    p.add_argument("--wifi", action="store_true",
                    help="connect to the CYD's own Wi-Fi access point over TCP instead of USB serial "
                         "(join that network on this machine first)")
    p.add_argument("--wifi-host", default=WIFI_DEFAULT_HOST, help=f"CYD access point IP (default {WIFI_DEFAULT_HOST})")
    p.add_argument("--wifi-port", type=int, default=WIFI_DEFAULT_PORT, help=f"CYD TCP port (default {WIFI_DEFAULT_PORT})")
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--web-port", type=int, default=5000, dest="web_port")
    return p.parse_args()


def choose_bridge(args, on_message, on_status, on_send):
    """--simulate / --wifi / --port each force that transport. With none of
    them given, auto-detect in priority order: a real USB serial port (if
    the CYD happens to be plugged in), then the CYD's own Wi-Fi access
    point (if this machine is already joined to it), then simulation --
    so `python app.py` alone just works regardless of which way the CYD is
    actually connected today, with no flag to remember."""
    kwargs = dict(on_message=on_message, on_status=on_status, on_send=on_send)

    if args.simulate:
        return SerialBridge(port=args.port, simulate=True, **kwargs)
    if args.wifi:
        return WifiBridge(host=args.wifi_host, port=args.wifi_port, **kwargs)
    if args.port:
        return SerialBridge(port=args.port, **kwargs)

    usb_port = find_port()
    if usb_port:
        return SerialBridge(port=usb_port, **kwargs)
    if wifi_is_reachable(args.wifi_host, args.wifi_port):
        return WifiBridge(host=args.wifi_host, port=args.wifi_port, **kwargs)
    # A CYD in "Join Wi-Fi" mode (docs/CLAUDE.md "CYD Wi-Fi mode setup") isn't
    # at the fixed AP gateway above -- only tried when --wifi-host wasn't
    # explicitly overridden, so an explicit value is always respected as-is.
    if args.wifi_host == WIFI_DEFAULT_HOST and wifi_is_reachable(WIFI_MDNS_HOST, args.wifi_port):
        return WifiBridge(host=WIFI_MDNS_HOST, port=args.wifi_port, **kwargs)
    return SerialBridge(simulate=True, **kwargs)


def create_app(args):
    # No Flask static folder: everything the browser loads comes from the React build.
    app = Flask(__name__, static_folder=None)
    # Persisted across restarts (see _load_or_create_secret_key) so signed-in
    # sessions survive both an ordinary page refresh and a dev-server restart.
    app.secret_key = _load_or_create_secret_key()
    # Signed-in browsers stay signed in for an hour after their last request (the
    # cookie is renewed on every request, so active use never logs you out).
    app.permanent_session_lifetime = LOGIN_LIFETIME
    socketio = SocketIO(app, async_mode="threading", cors_allowed_origins="*")

    db.init_db()
    with db.write_conn() as conn:
        has_data = conn.execute("SELECT COUNT(*) AS c FROM astronauts").fetchone()["c"] > 0
    if not has_data:
        seed.seed_all()

    def on_status(status, detail):
        socketio.emit("serial_status", {"status": status, "detail": detail})

    def on_send(line):
        socketio.emit("serial_log", {"direction": "out", "line": line.strip()})

    def on_message(msg):
        # handle_cyd_message is assigned below, but on_message is only ever
        # called after bridge.start() -- by then it exists (closures look
        # up names at call time, not definition time).
        socketio.emit("serial_log", {"direction": "in", "line": msg})
        handle_cyd_message(msg)

    bridge = choose_bridge(args, on_message, on_status, on_send)
    handle_cyd_message = routes.create_routes(app, socketio, bridge)
    analysis.start_worker()  # runs queued AI health analyses one at a time
    admin_routes.create_admin_routes(app)
    bridge.start()

    # Optional second NFC reader (Pico + PN532, no WiFi -- see
    # backend/hardware/pico_bridge.py). Wired to the same on_message the CYD's own
    # bridge uses (not handle_cyd_message directly) so a Pico scan also gets echoed
    # to the serial_log Socket.IO stream the Simulator panel's live log shows --
    # without this, a Pico tap silently started a real session but never appeared
    # there, which read as "nothing happening" even though it was actually working.
    pico_bridge = PicoBridge(on_message=on_message)
    # Tests set ASTRO_NO_PICO=1 (tests/conftest.py): each test app would otherwise leave a
    # reader thread running that can open the real Pico on a dev machine, or a fake port
    # meant for test_pico_bridge.py.
    if os.environ.get("ASTRO_NO_PICO") != "1":
        pico_bridge.start()

    # The React app (frontend/dist, built by `npm run build`). Real files (JS/CSS
    # bundles, fonts, 3D models) are served as-is; any other path gets index.html so
    # a deep link like /body or /doctor/alerts loads the app and React Router takes
    # over. /api/* is never handed to the SPA -- an unknown API path stays a JSON 404.
    # (/socket.io never reaches Flask's router at all; Flask-SocketIO intercepts it.)
    @app.get("/", defaults={"path": ""})
    @app.get("/<path:path>")
    def spa(path):
        if path == "api" or path.startswith("api/"):
            return jsonify({"error": "not found"}), 404
        dist = config.FRONTEND_DIST
        if path and os.path.isfile(os.path.join(dist, path)):
            return send_from_directory(dist, path)
        if not os.path.isfile(os.path.join(dist, "index.html")):
            return ("Frontend not built yet -- run: cd frontend && npm install && npm run build", 503)
        return send_from_directory(dist, "index.html")

    start_time = time.time()
    scheduler.clock_started_at = start_time  # the Schedule page's mission clock

    def background_loop():
        while True:
            time.sleep(BACKGROUND_TICK_S)
            try:
                sessions.check_timeouts(bridge.send, socketio.emit)
                comms.deliver_due_messages(socketio.emit)
                astra_memory.emit_due(socketio.emit)
                scheduler.check_and_fire(start_time, bridge.send, socketio.emit)
                sessions.refresh_surgeon_cyd(bridge.send)
            except Exception as exc:  # the loop must never die mid-demo
                socketio.emit("serial_log", {"direction": "in", "line": {"type": "log", "msg": f"background loop error: {exc}"}})

    threading.Thread(target=background_loop, daemon=True).start()

    return app, socketio, bridge


def main():
    args = parse_args()
    app, socketio, bridge = create_app(args)
    if isinstance(bridge, WifiBridge):
        print(f"[astro-health] wifi: connecting to the CYD at {bridge.host}:{bridge.port}")
    else:
        print(f"[astro-health] serial: {'simulation' if bridge.simulate else bridge.requested_port}")
    print(f"[astro-health] open http://localhost:{args.web_port} (or this machine's LAN address, same port)")
    socketio.run(app, host=args.host, port=args.web_port, allow_unsafe_werkzeug=True)


if __name__ == "__main__":
    main()
