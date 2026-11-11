"""Optional second NFC reader: a Raspberry Pi Pico + PN532, plugged into
this laptop over its own USB port (see docs/CLAUDE.md "Pico NFC reader").
It has no WiFi, so unlike the CYD it can't relay taps over the air -- it
just sends `{"type":"scan","uid":"..."}` lines straight to the laptop over
USB serial, and this module feeds those into the exact same
handle_cyd_message() the CYD's own scans already go through. Entirely
optional: if no Pico is plugged in, this bridge just doesn't start.
"""
import threading
import time

import serial
from serial.tools import list_ports

from backend.hardware import protocol

RECONNECT_S = 3
MAX_CONSECUTIVE_READ_ERRORS = 40  # ~2s of a flaky adapter before giving up and reopening the port
PORT_DESCRIPTION_HINTS = ("pico",)


def find_port():
    """Returns the device path of the first port that looks like a Pico, or None."""
    for p in list_ports.comports():
        desc = f"{p.description} {p.manufacturer or ''}".lower()
        if any(hint in desc for hint in PORT_DESCRIPTION_HINTS):
            return p.device
    return None


class PicoBridge:
    def __init__(self, on_message, port=None, baud=115200):
        # An explicit port (nothing passes one today, but the option stays for
        # parity with SerialBridge/tests) is never re-detected. Otherwise
        # self.port starts unset -- _read_loop() below calls find_port() on
        # every connection attempt, not just once here, specifically so a Pico
        # plugged in *after* the server started (e.g. unplugged to rewire on a
        # breadboard, then replugged) is picked up within RECONNECT_S seconds
        # instead of needing a server restart.
        self._forced_port = port
        self.port = port
        self.baud = baud
        self.on_message = on_message
        self._stop = threading.Event()

    def start(self):
        # Always starts the thread, even with no Pico detected yet -- see the
        # comment above on why detection can't happen just once here.
        threading.Thread(target=self._read_loop, daemon=True).start()

    def stop(self):
        self._stop.set()

    def _read_loop(self):
        while not self._stop.is_set():
            port = self._forced_port or find_port()
            if not port:
                time.sleep(RECONNECT_S)
                continue
            self.port = port
            try:
                ser = serial.Serial(port, self.baud, timeout=1)
            except Exception:
                time.sleep(RECONNECT_S)
                continue
            consecutive_errors = 0
            try:
                while not self._stop.is_set():
                    try:
                        raw = ser.readline()
                    except serial.SerialException:
                        # Same spurious-but-harmless error documented for the
                        # CYD's own CH340 link (see serial_bridge.py / docs/
                        # CLAUDE.md "USB serial reliability") -- the device is
                        # still there, ride out a short burst instead of
                        # tearing down and reopening the port (which can also
                        # reset the board itself) on every single one of them.
                        consecutive_errors += 1
                        if consecutive_errors > MAX_CONSECUTIVE_READ_ERRORS:
                            raise
                        time.sleep(0.05)
                        continue
                    consecutive_errors = 0
                    if not raw:
                        continue
                    msg = protocol.decode(raw.decode("utf-8", errors="ignore"))
                    if msg is not None:
                        self.on_message(msg)
            except Exception:
                pass
            finally:
                try:
                    ser.close()
                except Exception:
                    pass
            if not self._stop.is_set():
                time.sleep(RECONNECT_S)
