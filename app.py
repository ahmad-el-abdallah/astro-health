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

from flask import Flask, render_template
from flask_socketio import SocketIO

from backend import db, seed, sessions, comms, routes, scheduler
from backend.serial_bridge import SerialBridge, find_port
from backend.wifi_bridge import (
    WifiBridge, is_reachable as wifi_is_reachable,
    DEFAULT_HOST as WIFI_DEFAULT_HOST, DEFAULT_PORT as WIFI_DEFAULT_PORT,
)

BACKGROUND_TICK_S = 2


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
    return SerialBridge(simulate=True, **kwargs)


def create_app(args):
    app = Flask(__name__)
    # Regenerated fresh every run -- every login session cookie it signs
    # becomes invalid on the next restart, so (like backend/sessions.py's
    # in-memory active_sessions) everyone's logged out when the demo app
    # restarts. No secret to persist or leak.
    app.secret_key = os.urandom(24)
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
    bridge.start()

    @app.get("/")
    def index():
        return render_template("index.html")

    start_time = time.time()

    def background_loop():
        while True:
            time.sleep(BACKGROUND_TICK_S)
            try:
                sessions.check_timeouts(bridge.send, socketio.emit)
                comms.deliver_due_messages(socketio.emit)
                scheduler.check_and_fire(start_time, bridge.send, socketio.emit)
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
