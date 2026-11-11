"""Confirms a Pico plugged in *after* the bridge is already running gets
picked up without a restart -- the actual bug: find_port() used to only
ever run once, at construction, so a board that wasn't there yet at
startup (e.g. unplugged to rewire on a breadboard, then replugged) was
never found again for that process's lifetime. See docs/CLAUDE.md's
"Pico NFC taps 'did nothing'" follow-up entries.
"""
import threading
import time

from backend.hardware import pico_bridge


class FakeSerial:
    """One scan line, then silence (readline() returns b"" like a real
    timeout) -- enough to prove a message makes it through on_message."""

    def __init__(self, *a, **kw):
        self._lines = [b'{"type":"scan","uid":"A1000001"}\n']

    def readline(self):
        if self._lines:
            return self._lines.pop(0)
        time.sleep(0.01)
        return b""

    def close(self):
        pass


def test_pico_plugged_in_after_start_is_still_found(monkeypatch):
    monkeypatch.setattr(pico_bridge, "RECONNECT_S", 0.02)
    plugged_in = threading.Event()
    monkeypatch.setattr(pico_bridge, "find_port", lambda: "/dev/ttyFAKE" if plugged_in.is_set() else None)
    monkeypatch.setattr(pico_bridge.serial, "Serial", FakeSerial)

    received = []
    bridge = pico_bridge.PicoBridge(on_message=received.append)
    bridge.start()  # no port available yet -- must not just give up
    time.sleep(0.05)
    assert received == []

    plugged_in.set()  # simulates the board reappearing on the bus
    for _ in range(50):
        if received:
            break
        time.sleep(0.02)
    bridge.stop()

    assert received == [{"type": "scan", "uid": "A1000001"}]


def test_an_explicitly_forced_port_is_never_overridden_by_find_port(monkeypatch):
    monkeypatch.setattr(pico_bridge, "find_port", lambda: (_ for _ in ()).throw(AssertionError("should not be called")))
    monkeypatch.setattr(pico_bridge.serial, "Serial", FakeSerial)

    received = []
    bridge = pico_bridge.PicoBridge(on_message=received.append, port="/dev/ttyForced")
    bridge.start()
    for _ in range(50):
        if received:
            break
        time.sleep(0.02)
    bridge.stop()

    assert bridge.port == "/dev/ttyForced"
    assert received == [{"type": "scan", "uid": "A1000001"}]
