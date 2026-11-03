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
tests/                      pytest — rules engine, protocol, sessions, REST API, symptoms, auth (48 tests)
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
  (32% flash / 14% RAM, as of the initial 2026-10-29 build). **Ask before flashing any board** —
  same rule as Lifeline, and doubly so here since nothing's been run on hardware yet.
- **`arduino-cli` is not installed in this dev environment as of 2026-11-03** (checked: not on
  `PATH`, no `~/.arduino15`). `screens.ino`'s `onStatusMsg()`/`drawWrapped()` (see "CYD status
  screen shows every flagged indicator" below) were edited after that last real compile and have
  **not** been compile-checked since — reviewed by hand only. Get `arduino-cli` (or the Arduino
  IDE) working before trusting a compile, and definitely before flashing.

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

## Auto-simulated vitals (2026-11-03)

- Typing heart rate/BP/sugar/temperature by hand for every demo run felt impractical and "not
  professional" for judges, so the Live tab's **"Take a new reading"** button
  (`static/js/live.js`'s `simulateVitals()`) fills the four vitals inputs from
  `GET /astronauts/<id>/simulate_vitals` -> `backend/health_rules.py`'s `sample_vitals()`
  instead of requiring manual typing. Still a human clicks **Assess** to actually log it — this
  button only pre-fills the form, it doesn't write anything by itself.
- `sample_vitals()` is weighted random (`_LEVEL_WEIGHTS`: 80% GREEN / 15% YELLOW / 5% RED per
  indicator, independently) sampled from `health_rules.json`'s own GREEN/YELLOW ranges
  (`_sample_simple()`), so the numbers it generates are always consistent with whatever
  thresholds are currently configured — change the config, the simulated ranges follow, no
  separate "fake data" table to keep in sync. Blood pressure gets its own systolic+diastolic
  pairing (`bp_cfg`) since the two move together.
- This route takes an `astro_id` in its URL for symmetry with every other per-astronaut route,
  but doesn't actually read anything about that astronaut — it's pure random generation, which
  is also why it's deliberately left unauthenticated in "Login / access control" below.

## USB serial reliability (2026-11-03)

- Diagnosed "the app doesn't work over USB, only the CYD's own Wi-Fi AP works" as two separate
  issues layered on top of each other:
  1. **Fixed**: `backend/serial_bridge.py`'s `_read_loop()` treated *any* read exception as
     "the port is gone," closing and reopening it (which resets most ESP32 boards via DTR/RTS)
     every time. But `serial.SerialException: device reports readiness to read but returned no
     data` is a well-known spurious error from CH340-style USB-serial adapters on Linux — real
     disconnects were confirmed absent from `dmesg`/`journalctl -k` during these errors. Added
     `MAX_CONSECUTIVE_READ_ERRORS = 40` (~2s at the 0.05s retry sleep) so the loop rides out a
     short burst of these instead of tearing the connection down on the first one. Verified: a
     25s stability test went from cycling connect/disconnect every 2-5s to staying `"connected"`
     the entire time.
  2. **Not fixed, likely hardware**: even with the loop fix keeping the connection open, raw
     bytes arriving over this particular USB link are sometimes still corrupted (garbled lines
     that fail `protocol.decode()`, confirmed by temporarily logging every raw line before the
     parse step). Since the device-level connection never drops (per `dmesg`), this points at
     cable/port signal integrity or this CH340 clone's clock tolerance at 115200 baud, not a
     software bug. Try a different (shorter, better-shielded) USB cable and a direct port (no
     hub) before suspecting the code again. The Wi-Fi AP path is unaffected (TCP, not raw UART)
     and remains the reliable fallback for a demo while that's sorted out.

## CYD status screen shows every flagged indicator (2026-11-03)

- Bug: after **Assess**, the CYD's status screen (`screens.ino`'s `onStatusMsg()`, the big
  "ALERT"/"CHECK"/"ALL GOOD" banner) and the web app's Result line both only ever named *one*
  flagged indicator (`routes.py`'s `assess()` used to pick just the first `details` entry
  matching the overall level), even when several were RED/YELLOW at once — e.g. heart rate AND
  blood pressure both RED showed only "heart_rate".
- Fixed in `assess()`: `indicator_levels` now collects every indicator considered for the
  assessment — the 4 manual vitals plus whatever the CYD already reported today
  (sleep/mood/reaction/exercise/water/symptoms) — and the note lists *all* of the ones matching
  the overall level, e.g. `"RED: heart rate, blood pressure, temperature"`. This one `note`
  field feeds the CYD status screen, the web Result line, and the Flight Surgeon's queued RED
  report, so all three got fixed at once.
- The CYD side needed a matching fix: `onStatusMsg()` used to `drawString()` the note on one
  fixed-position line, which a multi-indicator list could now overflow off-screen. Added a
  small greedy word-wrap helper, `drawWrapped()` (next to `drawBigButton()` in `screens.ino`),
  and call that instead — wraps across as many centered lines as the note needs, up to the
  screen's width. **This firmware change has not been compile-checked** (see "Firmware
  invariants" above) — review it by eye before flashing.

## Symptom reporting (2026-11-03)

- Live tab's "Report a symptom" widget: a chip per known symptom (`config/symptoms.json`).
  Tapping a chip selects it for the report **and** shows that symptom's `guidance` text (what
  to do about it) — so the astronaut gets self-care guidance the instant they tap, not only
  after logging. "Log symptoms" writes the selection via `backend/symptoms.py`'s `record()` +
  `alert_if_red()`, the same path the CYD/simulator symptom path already used.
- `config/symptoms.json`'s 8 IDs/labels are copied from `firmware/astro_cyd/screens.ino`'s
  `SYMPTOM_KEYS`/`SYMPTOMS` arrays — keep both in sync if either changes; this mirrors a
  duplication that already existed (`seed.py`/`simulator.js` independently hardcode symptom
  strings too), not a new problem. `guidance` is placeholder self-care text, not real
  flight-surgeon guidance — same `PLACEHOLDER` convention as every other `config/*.json` file.
  Severity (which symptoms are RED) stays defined once, in `health_rules.json`'s
  `symptom_levels.red_symptoms` — not duplicated here.
- An earlier version of this feature added NVIDIA-hosted speech-to-text (voice symptom
  reporting) on a `feature/voice-symptom-reporting` branch. That branch was dropped — too much
  added complexity/dependency (gRPC, an external API key, a mic permission flow) for what the
  demo needs. Only the manual chip-based reporting (plus the guidance-on-tap addition above)
  was kept, folded straight into `master`.

## Login / access control (2026-11-03)

- Crew members are now real "users" in the sense that matters: each astronaut can only see
  their *own* data once logged in, enforced server-side (`backend/auth.py`'s `authorize_view`/
  `authorize_surgeon`, called at the top of every per-astronaut route in `backend/routes.py`) —
  not just hidden in the UI. Decided with the user: **the Flight Surgeon is the one exception**
  and keeps full visibility of every crew member (crew roster, alerts, anyone's trends) after
  logging in, since monitoring the whole crew is the entire point of that role.
- **No accounts table, no passwords.** Login is a Flask session cookie holding `astronaut_id`,
  set by `POST /api/auth/nfc_login` after resolving an NFC UID through the same `tags` table
  `sessions.py` already uses for taps -- the Flight Surgeon's card logs you in as them the exact
  same way a crew card does (both tag rows carry a real `astronaut_id`, see `backend/seed.py`).
  `app.secret_key` is regenerated fresh every `app.py` run, so (like `sessions.py`'s in-memory
  `active_sessions`) every login is a live-demo concept that resets on restart -- nothing to
  leak or persist.
- **The web login and the CYD's own physical session are deliberately decoupled**, even though
  one NFC tap drives both: tapping your card both (a) toggles your physical CYD session same as
  always, and (b) -- if some open browser is sitting on the login screen -- logs that browser in
  as you, via the exact same `"scan"` Socket.IO broadcast `sessions.handle_scan()` already emits
  (`static/js/auth.js`'s `onScanForLogin`). Logging out is a separate, explicit action (header
  "Log out" button) and does not end your CYD session, and ending your CYD session (re-tapping,
  or the 120 s idle timeout) does not log the browser out -- conflating the two would silently
  kick someone off their own dashboard just because their CYD screen went idle.
- **The Simulator panel works as a login device too, including from the login screen itself** --
  it's now a sibling of `#app`/`#login-screen` in `templates/index.html`, not nested inside the
  hidden `#app`, specifically so tapping a card there (which already goes through
  `/api/simulate/scan` -> the same `handle_scan` -> the same `"scan"` broadcast) can log you in
  with no real hardware attached. This is also why `GET /tags` stayed unauthenticated when
  everything else per-astronaut got locked down: the Simulator needs the tag list to draw its
  buttons *before* anyone's logged in. Only the write side (`POST`/`DELETE /tags`, i.e. actually
  assigning/removing a card) is Flight-Surgeon-only.
- **Route gating summary**: self-or-surgeon (`authorize_view`) -- `summary`, `history`, `assess`,
  `symptoms`, `export/<id>.csv`, `rewards/<id>`. Surgeon-only (`authorize_surgeon`) -- `crew`,
  bare `astronauts` list/detail/rename, `tags` writes, `alerts`, `messages`, `reset-demo`. Left
  open -- `tags` reads (above), `symptoms/catalog`, `simulate_vitals` (doesn't read anything
  real), `leaderboard` (a shared comparison feature by design), `content`/`routine`/
  `health-rules` (static config), `mission`, `simulate/*`, `emergency` (SOS shouldn't need a
  login), and the new `auth/*` routes themselves.
- **Frontend**: `static/js/auth.js` owns `Auth` (who's logged in) and gates everything -- `#app`
  stays `display:none` until `/api/auth/me` (or a successful tap) succeeds, `[data-surgeon-only]`
  nav buttons (Crew, Flight Surgeon, Admin) are hidden for anyone else, and
  `populateAstroSelect()` replaces every tab's old "fetch `/crew`, fill a `<select>`" snippet
  (`body.js`, `trends.js`, `rewards.js`) with a role-aware version: the surgeon still gets the
  full crew dropdown, a regular astronaut gets a disabled one locked to themselves. A few
  always-on `Bus` listeners that used to call `/crew` unconditionally on every broadcast
  regardless of which tab was showing (`crew.js`, `admin.js`) now guard themselves with
  `isSurgeon()` first, since those two have no sensible "just show me" fallback.
- **The old Flight Surgeon tab PIN ("1234", client-side only, trivially bypassable) is gone** --
  real login *is* the unlock now. `backend/sessions.py`'s `surgeon_unlocked_until`/
  `is_surgeon_unlocked()` and the `"surgeon_unlocked"` Socket.IO event are left in place but are
  now vestigial (nothing listens to the event anymore, and nothing outside `sessions.py` ever
  called `is_surgeon_unlocked()` even before this change) -- not removed here to avoid touching
  `tests/conftest.py`'s fixture for no functional benefit; fine to clean up later.
- **Username & password and Face ID are UI-only placeholders** on the login screen (visibly
  disabled, labeled "Coming soon") -- NFC is the only method that actually logs you in today.
  Wire up a real one the same way: resolve an identity server-side, call `auth.login(astro_id)`.

## Mission Health tab (2026-11-04, branch `3wrf-edits`, by 3wrf -- not merged)

- The old Mission tab (a profile dropdown + three numbers) became **Mission Health**: pick an
  environment, see how it affects each body system (mission risk vs the astronaut's live level
  from `/summary`'s `body_levels`), which systems need attention, and a per-mission monitoring
  checklist (what / how often / why, ticked off from the last 24 h of readings).
- Risk text and monitoring plans are PLACEHOLDER data in `config/mission_health.json`, served as
  `health` inside `GET /api/mission`. Keys must match `content.json` `body_parts` and
  `health_rules.json` `indicators` -- `test_every_mission_profile_has_a_health_plan` checks this.
- `static/js/planet3d.js` draws the animated scene at the top (Earth/Moon/Mars, station, transit
  ship, rover) as shaded spheres on a plain canvas -- no three.js/CDN, runs offline. Textures are
  generated procedurally a few rows per frame (no freeze), the loop only draws while the tab is
  visible, and `prefers-reduced-motion` gets one still frame.
- The astronaut picker uses `auth.js`'s `populateAstroSelect()`, same as the other tabs.

## Testing

- `.venv/bin/python -m pytest` — 48 tests (rules engine, protocol, sessions, REST API, symptoms,
  login/access control).
- `.venv/bin/python app.py --simulate` then exercise the feature at `http://localhost:5000`
  (Simulator panel drives every CYD event through the same code path a real tap would).
- Kill any backgrounded dev server you start for screenshots/recording afterward
  (`pkill -f "app.py --simulate"`), don't leave it running between tasks.
- Ask before flashing firmware to a real board, same as Lifeline.

## Status (2026-11-04)

- `git init` done, **still no commits** — ask before the first commit (what to include/exclude,
  especially the large `docs/*.mp4`/`*.pdf` deliverables vs. the gitignored video build scratch)
  rather than assuming. No remote configured. Everything described in this file past "Where
  this came from (2026-10-28/29)" is uncommitted working-tree changes on `master` — `git status`
  before assuming any of it is saved anywhere but disk.
- Initial 2026-10-29 build (backend, full 10-tab web app, firmware) passed its own checks that
  session (pytest, a headless full-page click-through, `arduino-cli compile`) but was never run
  on real CYD/S3 hardware. Since then (2026-11-03, all uncommitted): auto-simulated vitals,
  a USB serial reliability fix (cable/signal issue still outstanding, see above), the CYD
  status-note fix, symptom reporting + guidance-on-tap (a voice/NVIDIA version of this was
  tried and deliberately dropped), and full login/access control (NFC-card login,
  Flight-Surgeon-sees-everyone / everyone-else-sees-only-themselves). `pytest` is current (48
  tests, all passing) but **`arduino-cli` is not installed in this dev environment** (see
  "Firmware invariants" above), so the firmware changes since 2026-10-29 are reviewed-by-hand
  only, not actually recompiled — get that tool working and compile-check before flashing
  anything.
