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

### Signing in

Every astronaut can only see their own data -- enforced on the backend, not just hidden in the
UI. The one exception is the Flight Surgeon, who sees everyone (crew roster, alerts, anyone's
trends), since that's the point of the role.

The only working sign-in method right now is tapping your NFC card on the CYD (username/password
and Face ID are shown on the login screen as "Coming soon" placeholders for later). No CYD
plugged in? The **Simulator** panel works from the login screen too -- tap your card button
there instead, it goes through the exact same path a real tap does. On a shared laptop, tapping
a *different* card while you're still signed in doesn't switch who's logged in (a stray tap from
someone else's routine check-in shouldn't silently boot you out of your own dashboard) -- log
out first, then tap the next card.

Signing out and ending your CYD session now track each other for *explicit* sign-off: clicking
the header's "Log out" button also ends your CYD session if one's open, and pressing "Done" on
the CYD logs the browser out too. Passive endings -- re-tapping your card to toggle the CYD
session off, or its 120s idle timeout -- don't log the browser out; only those two explicit
actions are wired together.

### Superuser admin page

Assigning a tag to an astronaut, or setting/creating an astronaut's role, now happens at a
separate page -- **http://localhost:5000/admin** -- with its own login, entirely independent of
the NFC/astronaut login above (log into both at once in the same browser if you want). Create
the first superuser account:

```bash
.venv/bin/python -m backend.create_superuser
```

It prompts for a username and password (hidden) and creates one row in the `superusers` table.
Run it again any time you need another admin account. Tapping an unrecognized card shows
"Unknown card" on the CYD (nothing about assignment -- that's deliberate) and lands in the
admin page's "Unknown tags" list, where it stays until you assign or dismiss it, even if nobody
was watching when it was tapped.

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
card UIDs baked into `backend/seed.py`) plus a flight surgeon. New cards get assigned via the
superuser admin page (`/admin`, see above). The **Simulator** panel
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

**Tests**: `.venv/bin/python -m pytest` (62 tests: the rules engine, the serial protocol, tag-tap
session logic, symptom reporting, login/access control, and the REST API).

**Firmware**: see `firmware/README.md` for libraries, pin map, touch calibration and upload
steps. Compile-check it with `arduino-cli compile --fqbn esp32:esp32:esp32:PartitionScheme=huge_app firmware/astro_cyd`
(32% flash / 14% RAM as of the initial build) -- it has not been flashed to real hardware, and
`screens.ino` has changed since that compile with no `arduino-cli` available to recheck it (see
`firmware/README.md`) -- run that compile-check yourself before flashing.

## Demo script

Works identically with the real CYD or in `--simulate` mode.

1. **Mission** tab: switch to **Mars transit** (20-minute delay, sped up by `TIME_SCALE`, default 60x).
2. Tap Ahmad's card (Simulator panel, or his real card). This signs you in as him (see "Signing
   in" above) and the Live tab jumps to his data.
3. Simulator -> "Reaction: slow" for Ahmad. Reaction time turns YELLOW/RED.
4. On the Live tab, click **Take a new reading** to fill in plausible vitals (or type your own),
   press **Assess**. The overall result reflects today's readings; the CYD (or the Simulator
   log) shows the `status` + `led` messages -- if more than one reading comes back flagged, the
   result names all of them, not just one.
5. If the result is RED, a report queues for the Flight Surgeon with a visible countdown
   (sped up by the mission's comms delay). **Log out** (header button), then tap the surgeon's
   card (Simulator panel, or her real card) to sign in as her -- the **Crew** and **Flight
   Surgeon** tabs only show up for her, since only she can see every crew member's data. Reply
   to the report from there, or from a phone on the same network, logged in the same way.
6. Still as the surgeon: **Crew** tab shows Ahmad and Sameer at a glance. Tap either card to
   jump to their **Live**/**Body**/**Trends** view -- something only the surgeon's login can do;
   a regular astronaut's own login is locked to just themselves there.
7. **Log out**, tap Ahmad's card to sign back in as him. Simulator -> tap "Treadmill", wait a
   bit, tap it again to stop. Points land on the Rewards tab; badge progress moves.
8. Simulator -> tap the **Emergency card**. Every open tab shows the red overlay regardless of
   who's logged in -- SOS doesn't check login. Cancel it (button on the overlay, or hold the
   CYD's corner SOS button 3s if testing on hardware).

## Replacing fake data with real data

- Thresholds: edit `config/health_rules.json` (every indicator's GREEN/YELLOW/RED ranges).
- Plain-language text (hazards, body parts, measurement guides, Learn cards): `config/content.json`.
- Mission profiles and comms delays: `config/missions.json`.
- Daily reminder schedule: `config/routine.json`.
- Points and badge rules: `config/gamification.json`.
- Real crew: tap a new NFC card, then assign it and set its astronaut's role from the
  **superuser admin page** (`/admin` -- see "Superuser admin page" below). No code changes
  needed either way. Renaming an existing astronaut stays on the Flight Surgeon tab.
- To regenerate the fake 30-day history (e.g. after changing `backend/seed.py`'s stories),
  use the Flight Surgeon tab's "Reset demo data", or `.venv/bin/python -m backend.seed`.

## Troubleshooting

- **Port busy / "could not open port"**: close the Arduino IDE's Serial Monitor or any other
  program holding the port open, then restart `app.py` (it also retries every 3s on its own).
- **CYD resets when the port opens**: normal for most ESP32 boards (DTR/RTS toggles reset
  it); the firmware re-sends `hello` on boot and the laptop re-detects it within a few seconds.
- **USB connects but messages come through garbled, or the port looks like it's constantly
  reconnecting**: the app now rides out short bursts of a known spurious CH340 error so it
  won't tear the connection down over it, but if raw data is still corrupted, that's a cable/
  port signal-integrity issue, not software -- try a different (shorter) USB cable and a direct
  port, not a hub. The Wi-Fi AP path ("Running the CYD on a power bank" below) is unaffected and
  a reliable fallback for a demo in the meantime.
- **Windows and the CH340 chip**: install the CH340 driver if the port doesn't show up in
  Device Manager; the port will be `COMx`, pass it with `--port COMx`.
- **No CYD at all**: `--simulate` (or just don't plug anything in -- the app falls back to
  simulation automatically if no matching port is found).
- **Nothing shows up on a phone**: make sure the phone is on the same network and use this
  machine's LAN IP (printed on startup), not `localhost`.

## What's built vs. not hardware-verified

Built and tested (`pytest`, manual API calls, and a headless DOM check of the whole page with
every tab clicked through, zero runtime errors): the full backend (sessions, rules engine,
gamification, comms delay, scheduler, serial bridge + simulation mode, login/access control),
symptom reporting, auto-simulated vitals, and the full 10-tab web app.

**Firmware**: both `astro_cyd/` and the ESP32-S3 reader (`firmware/esp32s3_nfc_reader/`, new
2026-11-04 -- a port of the user's own separate, already-working PN532 reader project, not
written from scratch) compile cleanly (`arduino-cli compile`, confirmed 2026-11-04 now that
`arduino-cli` is installed on this machine).

**Not verified on real hardware yet:**

- `astro_cyd`'s screen rotation and touch calibration -- see `firmware/README.md`. Never flashed
  to a real CYD.
- The microSD CS pin (`SD_CS_PIN` in `protocol.ino`) -- SD logging is optional either way.
- A live card tap arriving over the real serial port within 1s (this was validated end-to-end
  through `--simulate`'s identical code path, and the serial protocol itself is unit-tested,
  but not against the physical `astro_cyd` board). Also: a cable/signal-integrity issue that
  showed up over a real USB link (garbled bytes even after a reconnect-storm bug was fixed) --
  see Troubleshooting above.
- The LED/speaker's physical behavior.
- The ESP32-S3 reader's actual read range/speed on the real board, after switching from
  placeholder pins/tuning to the ported, measured-good ones -- flashed once with the wrong
  (placeholder) pins and confirmed via serial log that it just couldn't reach the PN532, as
  expected; not yet re-flashed with the corrected version.

Please check those on the actual boards.
