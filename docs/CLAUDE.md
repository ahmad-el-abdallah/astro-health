# Astro Health Station — notes for Claude

A NASA Space Apps hackathon demo: a Flask + SQLite + Socket.IO web app on a laptop, paired with
CYD firmware so astronauts can tap NFC cards/tags and use a touchscreen. Full spec:
`docs/build-prompt.md`. Day-to-day setup/running/demo script: `README.md` (repo root).

**Everything is fake data.** Every threshold in `config/*.json` is marked `PLACEHOLDER` —
general reference ranges, not real NASA figures. Never treat them as real, and keep the
"Demo with placeholder data. Not medical advice." disclaimer wherever a screen/export shows one.

## Where this came from (2026-10-28/29)

- Built this session from `docs/build-prompt.md` (a 16-section build spec). Two things in that
  spec don't match the real hardware/setup here, both decided with the user:
  1. **Lives in its own repo**, `~/Desktop/astro-health` — not inside Lifeline.
  2. **NFC wiring**: the spec assumes a PN532/MFRC522 wired straight to the CYD. The real
     hardware instead has the PN532 on a separate ESP32-S3 board
     (`~/Desktop/ESP32S3-NFC-Reader`) that relays UIDs to the CYD over ESP-NOW — the same
     link `~/Desktop/Lifeline` (a CYD NFC *lock*, unrelated product) uses. We kept that
     two-board relay: `firmware/astro_cyd/nfc_link.h` is an unmodified copy of Lifeline's
     (same MACs/channel/keys, same two physical boards), and the S3 reader's firmware didn't
     need to change at all.
- `~/Desktop/nasa` is an old, unrelated pre-existing project — don't confuse it with this one,
  and don't touch it.
- Real crew NFC cards (same physical cards as Lifeline, reused here): `9B:25:0F:54` "Ahmad"
  (teal `#4fd1c5`), `2B:ED:20:54` "Sameer" (yellow `#f4c430`). Leave these alone; test with
  fake UIDs (e.g. the Simulator panel's `A1000001`-style tags) instead.

## The user

- Hobby maker, NASA Space Apps hackathon. Writes short, informal messages with typos; work out
  what they mean. Wants practical steps, exact commands, short answers.
- Cares a lot about production polish for anything shown to judges (demo videos, screenshots) —
  has pushed back hard on narration that sounds like disconnected TTS words and on weak/cheap-
  looking animation; wants deliverables to look and sound like a real, professional product ad.

## Layout

```
app.py                      entry point: Flask + Socket.IO, picks a bridge, seeds the DB
backend/                    one file per concern — see "How it works" below
config/*.json               every PLACEHOLDER value (thresholds, text, missions, schedule, points)
data/astro.db               created at runtime by backend/seed.py, git-ignored
static/, templates/         the 10-tab web app (vanilla JS, no build step, no CDN at runtime)
firmware/astro_cyd/         the CYD sketch (TFT_eSPI + XPT2046, not LovyanGFX like Lifeline)
firmware/existing/          reference-only copies of Lifeline's lock sketch + nfc_link.h
tests/                      pytest — rules engine, protocol, sessions, REST API (37 tests)
docs/build-prompt.md        the original 16-section spec
docs/CLAUDE.md              these notes (root CLAUDE.md only imports this)
docs/README.md              not present — the root README.md is the user guide here (unlike
                             Lifeline, which keeps its guide under docs/)
docs/*.mp4, *.pdf           delivered demo video(s) and the guide PDF — see "Deliverables" below
video3-src/, video3b-src/   disposable build scratch for the trailer video — see "Deliverables"
```

## How it works (keep these invariants)

- **Backend push, not poll.** One Python process: init SQLite, seed if empty, pick a bridge
  (`app.py`'s `choose_bridge()`), start it, then a background thread (`BACKGROUND_TICK_S=2`)
  ticks session timeouts / comms delivery / the reminder scheduler. Every state change goes out
  via `socketio.emit()` to every open browser tab — nothing is polled.
- **Bridge auto-detect order** (no flags needed): a real USB serial port (`find_port()`) → the
  CYD's own Wi-Fi AP if this machine is already joined to it (`wifi_is_reachable()`) →
  simulation. `--port`/`--wifi`/`--simulate` each force one transport; `ASTRO_PORT` env var is
  the same as `--port`. Both transports feed the same `on_message`/`handle_cyd_message()` path.
- **Protocol** (`backend/protocol.py` / `firmware/astro_cyd/protocol.ino`): one JSON object per
  line, `decode()` requires a dict with a string `"type"` field or it's rejected (the firmware
  may print plain debug text too — that's just ignored, not an error).
- **Session/tag model** (`backend/sessions.py`): an astronaut card toggles a session — tapping
  it opens one (ending any other open session first), tapping it again ends it. Object tags
  need an open session: toggle-style ones (exercise/sleep) record a start→stop duration,
  one-shot ones (meal/medicine/bp_guide) log immediately. The surgeon card
  (`is_surgeon_unlocked()`) is a timed unlock window, not a session. Emergency
  (`start_emergency()`/`cancel_emergency()`) works with or without a session open. An unknown
  UID becomes "assign it on the laptop" via the Admin tab — adding a new card never touches
  firmware.
- **Health rules** (`config/health_rules.json`, reloaded fresh on every call — no rebuild to
  retune): simple GREEN/YELLOW/RED bands, "higher is better" minimums (sleep/exercise/water),
  and a two-variable rule for blood pressure. Reaction time is the standout: evaluated against
  that astronaut's own `baseline_reaction_ms`, so the same raw ms can be GREEN for one crew
  member and RED for another. Overall level = the single worst indicator present.
- **Gamification rules are parsed by hand, never `eval()`'d** (`backend/gamification.py`'s
  `_rule_met()`) — a badge rule string like `"exercise_days_streak >= 7"` is still config, not
  trusted code. Keep it that way if you add rule kinds.
- **Mission comms delay**: `config/missions.json` profiles each have their own delay; everything
  is sped up by `TIME_SCALE` (`backend/config.py`, default 60, override with `ASTRO_TIME_SCALE`)
  so e.g. a 20-minute Mars-transit delay becomes a ~20s real wait. Messages carry a `deliver_at`
  and only become visible once it's passed (`backend/comms.py`) — modeling that Earth genuinely
  can't answer instantly. The daily reminder schedule (`backend/scheduler.py`,
  `config/routine.json`) runs on the same scaled clock.

## Firmware invariants

- `firmware/astro_cyd/nfc_link.h` must stay byte-for-byte identical to
  `~/Desktop/Lifeline/lifeline-firmware/nfc_link.h` and `~/Desktop/ESP32S3-NFC-Reader`'s copy —
  same two physical boards, same MACs/channel/keys. If you change it, copy to both other repos.
- TFT_eSPI config (`USER_SETUP_LOADED 1` + every pin macro) lives in its own
  `firmware/astro_cyd/tft_setup.h`, not inlined in `astro_cyd.ino` and not in the library's
  `User_Setup.h`. `TFT_eSPI.h` auto-includes a sketch-local `tft_setup.h` if one exists on the
  include path, which Arduino puts the sketch folder on — this is the one placement that
  actually reaches `TFT_eSPI.cpp` (it's compiled as its own translation unit, separate from the
  sketch, so `#define`s written directly in `astro_cyd.ino` never apply to it; that's why an
  earlier inline-in-the-`.ino` version of this left the display black). Don't move it back.
- Pin map (reused from Lifeline's proven CYD pin-out, different graphics library though):
  TFT SCLK/MOSI/MISO/DC/CS = 14/13/12/2/15; backlight 21; touch SCLK/MOSI/MISO/CS/IRQ =
  25/32/39/33/36; RGB LED (active low) R/G/B = 4/16/17; speaker 26.
- **Not yet verified on real hardware** (no boards attached during this build): screen rotation
  (set to `1`; Lifeline's LovyanGFX sketch uses `3` if this looks wrong), touch calibration
  (`TS_MINX/MAXX/MINY/MAXY`), the microSD `SD_CS_PIN=5` guess in `protocol.ino`, and LED/speaker
  physical behavior. Check these on the actual boards before relying on them.
- Compile-check: `arduino-cli compile --fqbn esp32:esp32:esp32:PartitionScheme=huge_app firmware/astro_cyd`
  (32% flash / 14% RAM). **Ask before flashing any board** — same rule as Lifeline, and doubly
  so here since nothing's been run on hardware yet.

## Deliverables in `docs/`

- `Astro-Health-Station-Demo.mp4` — ~6 min feature tour (presentation audience).
- `Astro-Health-Station-Tech-Deep-Dive.mp4` — ~12 min silent, text/diagram-heavy technical
  explainer (for the team, so anyone can answer a judge's technical question).
- `Astro-Health-Station-Trailer.mp4` — ~54s narrated hype trailer; `docs/archive/` holds a
  superseded earlier cut, kept for comparison, not deleted.
- `Astro-Health-Station-Guide.pdf` — the written guide.
- `build-prompt.md` — the original hackathon build spec these were all built from.
- `video3-src/`, `video3b-src/` (repo root, not under `docs/`) are the trailer's build scratch
  (Playwright capture/record scripts, raw `.webm`, intermediate frames, synthesized narration
  WAVs) — disposable, gitignored, not part of the shipped app. Safe to delete entirely; rebuild
  from scratch if another trailer cut is ever needed.
- Narration in these videos uses `edge-tts` (Microsoft Edge's TTS); videos are built with a
  self-contained HTML/CSS/JS "scene" page + Playwright `recordVideo`, muxed with a bootstrapped
  `imageio-ffmpeg` static binary (no sudo available on this machine, no system `ffmpeg`).

## Testing

- `.venv/bin/python -m pytest` — 37 tests (rules engine, protocol, sessions, REST API).
- `.venv/bin/python app.py --simulate` then exercise the feature at `http://localhost:5000`
  (Simulator panel drives every CYD event through the same code path a real tap would).
- Kill any backgrounded dev server you start for screenshots/recording afterward
  (`pkill -f "app.py --simulate"`), don't leave it running between tasks.
- Ask before flashing firmware to a real board, same as Lifeline.

## Status (2026-10-29)

- `git init` done, **no commits yet** — ask before the first commit (what to include/exclude,
  especially the large `docs/*.mp4`/`*.pdf` deliverables vs. the gitignored video build scratch)
  rather than assuming. No remote configured.
- Backend, full 10-tab web app, and firmware all built and passing their own checks this
  session (pytest, a headless full-page click-through, `arduino-cli compile`). Not yet run on
  real CYD/S3 hardware — see "Firmware invariants" above for exactly what that leaves unverified.
