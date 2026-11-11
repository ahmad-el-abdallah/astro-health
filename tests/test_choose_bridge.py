"""app.py's choose_bridge() auto-detect order (docs/CLAUDE.md "CYD Wi-Fi mode
setup"): USB serial -> the fixed AP gateway -> a CYD in "Join Wi-Fi" mode at
its mDNS hostname -> simulation. No real hardware/network involved --
find_port()/wifi_is_reachable() are monkeypatched.
"""
import argparse

import app as app_module
from backend.hardware import wifi_bridge
from backend.hardware.serial_bridge import SerialBridge
from backend.hardware.wifi_bridge import WifiBridge


def _args(**overrides):
    base = dict(simulate=False, wifi=False, port=None,
                wifi_host=wifi_bridge.DEFAULT_HOST, wifi_port=wifi_bridge.DEFAULT_PORT)
    base.update(overrides)
    return argparse.Namespace(**base)


def _noop(*a, **kw):
    pass


def test_falls_back_to_mdns_host_when_the_ap_gateway_is_unreachable(monkeypatch):
    monkeypatch.setattr(app_module, "find_port", lambda: None)

    def fake_reachable(host, port, timeout=1.0):
        return host == wifi_bridge.MDNS_HOST
    monkeypatch.setattr(app_module, "wifi_is_reachable", fake_reachable)

    bridge = app_module.choose_bridge(_args(), _noop, _noop, _noop)
    assert isinstance(bridge, WifiBridge)
    assert bridge.host == wifi_bridge.MDNS_HOST


def test_falls_back_to_simulation_when_neither_host_is_reachable(monkeypatch):
    monkeypatch.setattr(app_module, "find_port", lambda: None)
    monkeypatch.setattr(app_module, "wifi_is_reachable", lambda host, port, timeout=1.0: False)

    bridge = app_module.choose_bridge(_args(), _noop, _noop, _noop)
    assert isinstance(bridge, SerialBridge)
    assert bridge.simulate is True


def test_an_explicit_wifi_host_is_never_overridden_by_the_mdns_fallback(monkeypatch):
    monkeypatch.setattr(app_module, "find_port", lambda: None)

    calls = []
    def fake_reachable(host, port, timeout=1.0):
        calls.append(host)
        return False
    monkeypatch.setattr(app_module, "wifi_is_reachable", fake_reachable)

    bridge = app_module.choose_bridge(_args(wifi_host="10.0.0.5"), _noop, _noop, _noop)
    assert isinstance(bridge, SerialBridge)
    assert bridge.simulate is True
    assert wifi_bridge.MDNS_HOST not in calls  # an explicit host is respected as-is, not second-guessed
