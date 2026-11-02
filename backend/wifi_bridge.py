"""Owns the laptop's connection to the CYD's own Wi-Fi access point:
connects over TCP (instead of opening a USB serial port), reads JSON lines
in a background thread, and retries every 3 s if the connection drops.

Use this when the CYD is running untethered from a power bank -- it
broadcasts its own network and a small TCP server (see
firmware/astro_cyd/wifi_bridge.ino); your laptop's Wi-Fi joins that
network first (see README.md), and this class is the other end of the
same socket.

Deliberately mirrors SerialBridge's public interface (status/start/stop/
send/inject, the on_message/on_status/on_send callbacks) so app.py and
routes.py don't need to know or care which transport is active.
"""
import socket
import threading
import time

from backend import protocol

RECONNECT_S = 3
PING_INTERVAL_S = 5
PROBE_TIMEOUT_S = 1.0
DEFAULT_HOST = "192.168.4.1"  # the CYD access point's gateway IP (ESP32 default)
DEFAULT_PORT = 8765


def is_reachable(host=DEFAULT_HOST, port=DEFAULT_PORT, timeout=PROBE_TIMEOUT_S):
    """A quick one-off check used by app.py's auto-detect: are we currently
    on the CYD's own Wi-Fi network? (i.e. is something listening at
    host:port right now). Not used by WifiBridge itself, which just keeps
    retrying regardless."""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


class WifiBridge:
    """status is one of: "connecting", "connected", "reconnecting"."""

    def __init__(self, host=DEFAULT_HOST, port=DEFAULT_PORT, on_message=None, on_status=None, on_send=None):
        self.host = host
        self.port = port
        self.simulate = False  # app.py checks this on SerialBridge; always real here
        self.on_message = on_message or (lambda msg: None)
        self.on_status = on_status or (lambda status, detail: None)
        self.on_send = on_send or (lambda line: None)

        self._sock = None
        self._write_lock = threading.Lock()
        self._stop = threading.Event()
        self._status = "connecting"
        self._fw_version = None
        self._last_pong = None

    @property
    def status(self):
        return self._status

    def _set_status(self, status, detail=""):
        if status != self._status:
            self._status = status
            self.on_status(status, detail)

    def start(self):
        threading.Thread(target=self._read_loop, daemon=True).start()
        threading.Thread(target=self._ping_loop, daemon=True).start()

    def stop(self):
        self._stop.set()
        if self._sock:
            try:
                self._sock.close()
            except Exception:
                pass

    def inject(self, msg):
        """Simulation mode uses this on SerialBridge; kept here only so
        routes.py's simulate endpoints work unchanged if ever pointed at a
        WifiBridge instance too."""
        self.on_message(msg)

    def send(self, line):
        """Writes one pre-built protocol line (ending with \\n) to the CYD."""
        self.on_send(line)
        if not self._sock:
            return
        try:
            with self._write_lock:
                self._sock.sendall(line.encode("utf-8"))
        except Exception:
            pass  # the read loop will notice the socket is gone and reconnect

    def _open(self):
        try:
            sock = socket.create_connection((self.host, self.port), timeout=3)
            sock.settimeout(1)
            self._sock = sock
            return True
        except Exception:
            self._sock = None
            return False

    def _read_loop(self):
        while not self._stop.is_set():
            self._set_status("connecting")
            if not self._open():
                self._set_status("reconnecting", f"can't reach {self.host}:{self.port}")
                time.sleep(RECONNECT_S)
                continue
            self._set_status("connected", f"{self.host}:{self.port}")
            buf = b""
            try:
                while not self._stop.is_set():
                    try:
                        chunk = self._sock.recv(4096)
                    except socket.timeout:
                        continue
                    if not chunk:
                        break  # the CYD closed the connection
                    buf += chunk
                    while b"\n" in buf:
                        raw, buf = buf.split(b"\n", 1)
                        msg = protocol.decode(raw.decode("utf-8", errors="ignore"))
                        if msg is None:
                            continue
                        if msg["type"] == "hello":
                            self._fw_version = msg.get("fw")
                        if msg["type"] == "pong":
                            self._last_pong = time.time()
                        self.on_message(msg)
            except Exception:
                pass
            finally:
                if self._sock:
                    try:
                        self._sock.close()
                    except Exception:
                        pass
                    self._sock = None
            if not self._stop.is_set():
                self._set_status("reconnecting", "connection closed")
                time.sleep(RECONNECT_S)

    def _ping_loop(self):
        while not self._stop.is_set():
            time.sleep(PING_INTERVAL_S)
            if self._status == "connected":
                self.send(protocol.ping())
