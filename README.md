# Astro Health Station

A NASA Space Apps hackathon demo: a tool that helps astronauts check their own health during
a mission and tells them what to do next. Two parts that work together:

- A **web app on a laptop** (Flask + Socket.IO backend, plain HTML/CSS/JS frontend).
- **CYD firmware** (`firmware/astro_cyd/`) -- astronauts tap NFC cards/tags and use the
  touchscreen; the CYD talks to the laptop over USB serial.

**Everything is fake data.** Every threshold, piece of health text and mission number lives
in `config/*.json`, marked `PLACEHOLDER`. Swap in real NASA data later without touching code.
Every screen and export carries: "Demo with placeholder data. Not medical advice."

Full build spec: `docs/build-prompt.md`. This README covers running it.

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python app.py
```

Open **http://localhost:5000** (or this machine's LAN address on the same port, for a phone
checking the Flight Surgeon view).

If `pip` isn't available on your system Python (no `ensurepip`/`python3-pip`), bootstrap it
inside the venv instead of installing anything system-wide:

```bash
python3 -m venv .venv --without-pip
curl -sS https://bootstrap.pypa.io/get-pip.py | .venv/bin/python -
.venv/bin/python -m pip install -r requirements.txt
```

## Running it

```bash
.venv/bin/python app.py                 # auto-detect: USB serial, then the CYD's own
                                         # Wi-Fi AP (if already joined), then simulation
.venv/bin/python app.py --port COM5     # force a specific USB port (or /dev/ttyUSB0, etc.)
.venv/bin/python app.py --simulate      # force simulation -- the Simulator panel drives everything
.venv/bin/python app.py --wifi          # force the Wi-Fi bridge (see "Running the CYD on a
                                         # power bank" below) -- join its AP first
ASTRO_PORT=/dev/ttyUSB0 .venv/bin/python app.py   # port via env var instead of --port
```

With no flags at all, `app.py` tries each transport in order and uses whichever one is
actually there -- so the same command works whether the CYD is on USB, on its own Wi-Fi, or
not connected at all. It only falls back to a later option when an earlier one genuinely
isn't available, so a USB cable is always used if plugged in even if the CYD's Wi-Fi AP also
happens to be reachable.

First run seeds the database (`data/astro.db`, git-ignored) with the real crew (their NFC
card UIDs, assigned via the Admin tab) plus a flight surgeon. The **Simulator** panel
(bottom-right, every tab) has a button per known card/tag and every fake CYD event (mood,
symptoms, a normal or slow reaction test, breathing done, SOS) -- this is the fallback if the
hardware fails during a demo, and it drives the exact same code path as a real card tap.

### Running the CYD on a power bank (no laptop cable)

The CYD can run entirely untethered, powered by any USB power bank, and still reach the
laptop: it broadcasts its own Wi-Fi access point and runs a small TCP server that speaks the
exact same JSON protocol USB serial uses, so nothing else about the app changes.

- **Network**: `AstroHealthCYD`, password `astrohealth123` (both set at the top of
  `firmware/astro_cyd/astro_cyd.ino` if you want to change them -- reflash after editing).
- **On your laptop**: join that Wi-Fi network, then just run `.venv/bin/python app.py` (it'll
  auto-detect the CYD's AP once you're on it) or `--wifi` to force it.
- **Keeping internet at the same time**: once your Wi-Fi joins the CYD's network, that
  adapter can no longer also reach your normal Wi-Fi/internet. Use Ethernet (or a second Wi-Fi
  adapter/phone hotspot) for internet while your built-in Wi-Fi talks to the CYD.
- The ESP-NOW link to the separate ESP32-S3 NFC reader is unaffected by any of this --
  it keeps working exactly as before, no changes needed on that board.

**Tests**: `.venv/bin/python -m pytest` (37 tests: the rules engine, the serial protocol, tag-tap
session logic, and the REST API).

**Firmware**: see `firmware/README.md` for libraries, pin map, touch calibration and upload
steps. Compile-check it with `arduino-cli compile --fqbn esp32:esp32:esp32:PartitionScheme=huge_app firmware/astro_cyd`
(32% flash / 14% RAM here) -- it has not been flashed to real hardware as part of this build.

## Demo script

Works identically with the real CYD or in `--simulate` mode.

1. **Mission** tab: switch to **Mars transit** (20-minute delay, sped up by `TIME_SCALE`, default 60x).
2. Tap Ahmad's card (Simulator panel, or his real card). The Live tab jumps to him.
3. Simulator -> "Reaction: slow" for Ahmad. Reaction time turns YELLOW/RED.
4. On the Live tab, type a heart rate and blood pressure, press **Assess**. The overall result
   reflects today's readings; the CYD (or the Simulator log) shows the `status` + `led` messages.
5. If the result is RED, a report queues to the Flight Surgeon tab with a visible countdown
   (sped up by the mission's comms delay); reply from there, or from a phone on the same
   network.
6. Simulator -> tap "Treadmill", wait a bit, tap it again to stop. Points land on the Rewards
   tab; badge progress (e.g. "Bone Guardian") moves.
7. Simulator -> tap the **Emergency card**. Every open tab shows the red overlay. Cancel it
   (button on the overlay, or hold the CYD's corner SOS button 3s if testing on hardware).
8. **Crew** tab: Ahmad and Sameer at a glance, then **Trends** for whichever indicator has
   history so far.

## Replacing fake data with real data

- Thresholds: edit `config/health_rules.json` (every indicator's GREEN/YELLOW/RED ranges).
- Plain-language text (hazards, body parts, measurement guides, Learn cards): `config/content.json`.
- Mission profiles and comms delays: `config/missions.json`.
- Daily reminder schedule: `config/routine.json`.
- Points and badge rules: `config/gamification.json`.
- Real crew: Admin tab -- tap a new NFC card, it shows up as "New tag", assign it to an
  astronaut (rename them there too) or an object type. No code changes needed either way.
- To regenerate the fake 30-day history (e.g. after changing `backend/seed.py`'s stories),
  use Admin tab's "Reset demo data", or `.venv/bin/python -m backend.seed`.

## Troubleshooting

- **Port busy / "could not open port"**: close the Arduino IDE's Serial Monitor or any other
  program holding the port open, then restart `app.py` (it also retries every 3s on its own).
- **CYD resets when the port opens**: normal for most ESP32 boards (DTR/RTS toggles reset
  it); the firmware re-sends `hello` on boot and the laptop re-detects it within a few seconds.
- **Windows and the CH340 chip**: install the CH340 driver if the port doesn't show up in
  Device Manager; the port will be `COMx`, pass it with `--port COMx`.
- **No CYD at all**: `--simulate` (or just don't plug anything in -- the app falls back to
  simulation automatically if no matching port is found).
- **Nothing shows up on a phone**: make sure the phone is on the same network and use this
  machine's LAN IP (printed on startup), not `localhost`.

## What's built vs. not hardware-verified

Built and tested (`pytest`, manual API calls, and a headless DOM check of the whole page with
every tab clicked through, zero runtime errors): the full backend (sessions, rules engine,
gamification, comms delay, scheduler, serial bridge + simulation mode), the full 10-tab web
app, and the firmware (compiles cleanly).

**Not verified on real hardware** (no CYD/S3 boards attached to this build session):

- The CYD's screen rotation and touch calibration -- see `firmware/README.md`.
- The microSD CS pin (`SD_CS_PIN` in `protocol.ino`) -- SD logging is optional either way.
- A live card tap arriving over the real serial port within 1s (this was validated end-to-end
  through `--simulate`'s identical code path, and the serial protocol itself is unit-tested,
  but not against the physical boards).
- The LED/speaker's physical behavior.

Please check those on the actual boards.
