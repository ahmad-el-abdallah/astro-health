"""Owns the USB connection to the CYD: auto-detects the port, reads JSON
lines in a background thread, retries every 3 s if the port drops, and
hands each parsed message to a callback. Flask (not the browser) owns the
port, so any browser on the network can watch the same dashboard.

If no port is found, or --simulate is passed, the bridge runs in
simulation mode: no real serial I/O, but the same on_message callback path
is used, via inject() (see backend/simulator.py and routes.py).
"""
import threading
import time

import serial
from serial.tools import list_ports

from backend import protocol

RECONNECT_S = 3
PING_INTERVAL_S = 5
MAX_CONSECUTIVE_READ_ERRORS = 40  # ~2s of a flaky adapter before giving up and reopening the port

PORT_DESCRIPTION_HINTS = ("ch340", "cp210", "usb serial", "usb-serial")


def find_port():
    """Returns the device path of the first port that looks like our CYD
    (CH340, CP210x, or a generic "USB Serial" description), or None."""
    for p in list_ports.comports():
        desc = f"{p.description} {p.manufacturer or ''}".lower()
        if any(hint in desc for hint in PORT_DESCRIPTION_HINTS):
            return p.device
    return None


class SerialBridge:
    """status is one of: "simulation", "connecting", "connected", "reconnecting"."""

    def __init__(self, port=None, baud=115200, simulate=False, on_message=None, on_status=None, on_send=None):
        self.requested_port = port
        self.baud = baud
        self.simulate = simulate or (port is None and find_port() is None)
        self.on_message = on_message or (lambda msg: None)
        self.on_status = on_status or (lambda status, detail: None)
        self.on_send = on_send or (lambda line: None)

        self._ser = None
        self._write_lock = threading.Lock()
        self._stop = threading.Event()
        self._status = "simulation" if self.simulate else "connecting"
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
        if self.simulate:
            self.on_status(self._status, "no CYD found" if not self.requested_port else "")
            return
        threading.Thread(target=self._read_loop, daemon=True).start()
        threading.Thread(target=self._ping_loop, daemon=True).start()

    def stop(self):
        self._stop.set()
        if self._ser:
            try:
                self._ser.close()
            except Exception:
                pass

    def inject(self, msg):
        """Simulation mode: feed a fake CYD message through the normal handler."""
        self.on_message(msg)

    def send(self, line):
        """Writes one pre-built protocol line (ending with \\n) to the CYD.
        No-op in simulation mode (the Simulator panel just logs it)."""
        self.on_send(line)
        if self.simulate or not self._ser:
            return
        try:
            with self._write_lock:
                self._ser.write(line.encode("utf-8"))
        except Exception:
            pass  # the read loop will notice the port is gone and reconnect

    def _open(self):
        port = self.requested_port or find_port()
        if not port:
            return False
        try:
            self._ser = serial.Serial(port, self.baud, timeout=1)
            return True
        except Exception:
            self._ser = None
            return False

    def _read_loop(self):
        while not self._stop.is_set():
            self._set_status("connecting")
            if not self._open():
                self._set_status("reconnecting", "no port found")
                time.sleep(RECONNECT_S)
                continue
            self._set_status("connected", self.requested_port or self._ser.port)
            consecutive_errors = 0
            try:
                while not self._stop.is_set():
                    try:
                        raw = self._ser.readline()
                    except serial.SerialException:
                        # Some CH340-style USB-serial adapters spuriously raise
                        # "device reports readiness to read but returned no
                        # data" on Linux even though the device is still
                        # there (confirmed: no USB disconnect in dmesg when
                        # this happens, and the next line often reads clean).
                        # Ride out a short burst of these instead of tearing
                        # down and reopening the port on every one of them.
                        consecutive_errors += 1
                        if consecutive_errors > MAX_CONSECUTIVE_READ_ERRORS:
                            raise
                        time.sleep(0.05)
                        continue
                    consecutive_errors = 0
                    if not raw:
                        continue
                    line = raw.decode("utf-8", errors="ignore")
                    msg = protocol.decode(line)
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
                if self._ser:
                    try:
                        self._ser.close()
                    except Exception:
                        pass
                    self._ser = None
            if not self._stop.is_set():
                self._set_status("reconnecting", "port closed")
                time.sleep(RECONNECT_S)

    def _ping_loop(self):
        while not self._stop.is_set():
            time.sleep(PING_INTERVAL_S)
            if self._status == "connected":
                self.send(protocol.ping())
