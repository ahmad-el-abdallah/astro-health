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

from backend import protocol

RECONNECT_S = 3
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
        self.port = port or find_port()
        self.baud = baud
        self.on_message = on_message
        self._stop = threading.Event()

    def start(self):
        if not self.port:
            return
        threading.Thread(target=self._read_loop, daemon=True).start()

    def stop(self):
        self._stop.set()

    def _read_loop(self):
        while not self._stop.is_set():
            try:
                ser = serial.Serial(self.port, self.baud, timeout=1)
            except Exception:
                time.sleep(RECONNECT_S)
                continue
            try:
                while not self._stop.is_set():
                    raw = ser.readline()
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
