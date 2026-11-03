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
     (same MACs/channel/keys, same two physical boards), and at the time the S3 reader's
     firmware didn't need to change at all -- **superseded 2026-11-04**, see "ESP32-S3 NFC
     reader firmware" below: that board's firmware now lives in this repo too.
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
static/, templates/         the 9-tab web app (vanilla JS, no build step, no CDN at runtime),
                             plus the separate /admin page (templates/admin.html,
                             static/js/admin_page.js) -- not part of that SPA, its own login
firmware/astro_cyd/         the CYD sketch (TFT_eSPI + XPT2046, not LovyanGFX like Lifeline)
firmware/esp32s3_nfc_reader/ the separate ESP32-S3 board's sketch (PN532 -> ESP-NOW), new 2026-11-04
firmware/existing/          reference-only copies of Lifeline's lock sketch + nfc_link.h
tests/                      pytest — rules engine, protocol, sessions, REST API, symptoms, auth (62 tests)
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
  `firmware/esp32s3_nfc_reader/nfc_link.h` (both in this repo as of 2026-11-04) — same two
  physical boards, same MACs/channel/keys. If you change it, copy it over the other one. (It's
  also the same protocol Lifeline's lock sketch uses, kept at `firmware/existing/` for
  reference only — that copy doesn't need to track these two.)
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
  (32% flash / 14% RAM — unchanged from the initial 2026-10-29 build even after everything
  since, including `screens.ino`'s `drawWrapped()`, re-confirmed 2026-11-04). **Ask before
  flashing any board** — same rule as Lifeline, and doubly so here since nothing's been run on
  real `astro_cyd` hardware yet (unlike the ESP32-S3 reader below, which has).
- **`arduino-cli` is now installed on this machine (since 2026-11-04)** — `/usr/local/bin/arduino-cli`,
  with the `esp32:esp32` core (3.3.12) and `TFT_eSPI`/`XPT2046_Touchscreen`/`ArduinoJson`/
  `Adafruit_PN532` all installed via `arduino-cli lib install`. It was missing for the whole
  2026-11-03 session (hence the firmware changes that session went uncompiled); now that it's
  here, both sketches (`astro_cyd/` and `esp32s3_nfc_reader/`) compile clean — don't re-claim
  "arduino-cli isn't installed" without checking again first.

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
  screen's width. **Compile-checked 2026-11-04** (see "Firmware invariants" above) — still not
  flashed to a real board, so verify the actual on-screen wrapping before trusting it.

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
  `app.secret_key` is persisted to `data/secret_key` (git-ignored, created on first run by
  `app.py`'s `_load_or_create_secret_key()`) rather than regenerated every run, specifically so
  a signed-in session survives a page refresh *and* a dev-server restart -- an earlier version
  regenerated it every run, which meant any restart (common during dev/demo iteration) silently
  logged everyone out and forced a re-tap. Delete that file to force everyone to log in again;
  nothing else to leak (still no accounts/passwords, like `sessions.py`'s in-memory
  `active_sessions`).
- **The web login and the CYD's own physical session track each other on explicit sign-off,
  but not on anything passive.** One NFC tap drives both at login time: tapping your card both
  (a) toggles your physical CYD session same as always, and (b) -- if some open browser is
  sitting on the login screen -- logs that browser in as you, via the exact same `"scan"`
  Socket.IO broadcast `sessions.handle_scan()` already emits (`static/js/auth.js`'s
  `onScanForLogin`). From there, the two *explicit* sign-off actions mirror each other:
  - Clicking **"Log out"** in the browser (`routes.py`'s `auth_logout`) now also ends that
    astronaut's CYD session if one's open (`sessions.end_session_for`), so stepping away from
    the laptop also frees up the CYD for the next person -- **2026-11-04**, at the user's
    request; an earlier version left the CYD session alone on web logout.
  - Pressing **"Done"** on the CYD (`screens.ino`'s `endSessionLocally()`, which sends a
    distinct `end_session` protocol message) logs the browser out too --
    `routes.py`'s `handle_cyd_message` emits `"logout_requested"` alongside the normal
    session-end handling, and `auth.js` calls its own `logout()` if that's the astronaut
    currently signed in on this browser.

  What's still deliberately decoupled: **passive/implicit** session endings. Re-tapping your
  card to toggle the CYD session off, or letting the 120 s idle timeout fire, does **not** log
  the browser out -- only "Done" and the header's "Log out" button (explicit "I'm finished"
  signals) are wired together; conflating idle timeout with logout would silently kick someone
  off their own dashboard just because their CYD screen went idle. The Simulator panel's "Done
  (CYD button, logs out)" button exercises the CYD->browser direction without hardware.
- `static/js/live.js`'s Live tab shows whichever astronaut is logged in in *this* browser the
  moment you log in (`LiveTab.viewAstronaut()`, called from `auth.js`'s `applyLogin`), not
  whoever's CYD session happens to be open -- so it no longer needs its own separate card tap,
  and survives a hard refresh since it's driven by the persisted login (see "Status" below),
  not by a one-time `"session_started"` broadcast.
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

## ESP32-S3 NFC reader firmware now lives in this repo (2026-11-04)

- The user connected the real ESP32-S3 reader board and found card detection slow and
  short-range (had to hold the card right on top of it for a while). That board's own firmware
  (the code that actually talks to the PN532 -- distinct from `firmware/astro_cyd/nfc.ino`,
  which is just the CYD's half of the ESP-NOW relay and was never the bottleneck) wasn't present
  anywhere on this dev machine or in any repo here, only on the physical board. A first attempt
  wrote a fresh sketch from scratch, guessing at pins/tuning with no real board to test
  against -- **superseded within the same session** once the user mentioned they'd pushed their
  actual, already-working reader project to GitHub
  (`github.com/ahmad-el-abdallah/ESP32S3-NFC-Reader`, private, PlatformIO): that project had
  already measured and fixed this exact slowness on 2026-10-24, so the sketch here was rewritten
  to port that proven code instead of re-guessing. Placed inside this repo (not a separate
  `~/Desktop/...` project, at the user's request) -- see "Where this came from" above, now
  superseded for this one piece.
- New sketch: `firmware/esp32s3_nfc_reader/` (`esp32s3_nfc_reader.ino` + a byte-for-byte copy of
  `nfc_link.h`). Library: Adafruit_PN532, PN532 wired over UART/HSU. Full rationale is in
  `firmware/README.md`'s "The ESP32-S3 reader sketch" section -- short version: the real,
  *measured* cause (in the user's own GitHub project, not guessed) is Adafruit_PN532's UART
  driver waiting out Arduino's default 1000 ms Serial read timeout on every single poll, because
  it reads a fixed-length reply that's often shorter than what actually comes back. Fixed with
  `pn532Serial.setTimeout(30)` -- measured poll time there dropped from ~1050 ms to ~90 ms. Real
  wiring (also from that project, not a guess): PN532 TXD -> GPIO 4, RXD -> GPIO 5, no reset pin.
- **`arduino-cli` is now installed on this machine** (it wasn't before this session -- see
  "Firmware invariants" below), so both versions of this sketch were actually compiled here
  (69% flash / 14% RAM), not just reviewed by hand. The first (from-scratch, wrong-pins) version
  was also flashed and its serial output confirmed the ESP-NOW link came up correctly (reader's
  MAC matched `READER_MAC` in `nfc_link.h`) but, as expected with the wrong pins, "PN532 didn't
  answer." The ported version (real pins, above) compiles cleanly but **has not yet been
  flashed or confirmed on hardware in this session** -- flash it, watch the serial log
  (`arduino-cli monitor`, or type `status`), and confirm it actually feels fast before calling
  this done.

## Superuser admin page (2026-11-04)

- Tag assignment and setting an astronaut's role are now a genuinely separate, Django-
  `createsuperuser`-style account system, not tied to being logged in as the Flight Surgeon
  astronaut. Decided with the user: the old Admin tab is gone from the main SPA entirely; a
  superuser is the only one who can assign a tag or set/create an astronaut's role.
- **`backend/create_superuser.py`**, run as `.venv/bin/python -m backend.create_superuser`
  (mirrors `backend/seed.py`'s style: one function, `create_superuser(username, password)`,
  plus a `__main__` guard that prompts interactively via `getpass`). Hashes with
  `werkzeug.security.generate_password_hash` -- no new dependency, Werkzeug ships with Flask.
  New `superusers` table (`backend/db.py`).
- **`backend/admin_auth.py`** mirrors `backend/auth.py`'s shape exactly, but uses
  `session["superuser_id"]` -- a different key in the same signed cookie (same
  `app.secret_key`/`data/secret_key`), so a superuser login and an astronaut/Flight-Surgeon
  login coexist independently in one browser; logging either one out doesn't touch the other.
  Every superuser is equally privileged, so `authorize_superuser` only ever 401s, never 403s.
- **`backend/admin_routes.py`** (new blueprint, `/api/admin/*`, registered in `app.py` after
  `routes.create_routes(...)`): serves `GET /admin` (the page itself), login/logout/me, a
  `GET /admin/astronauts` roster (separate from the Flight-Surgeon-gated `GET /astronauts` --
  a superuser session has no `astronaut_id` at all, so reusing that route would 403 every time),
  and the unknown-tag backlog (below).
- **Scope split, decided with the user**: only tag assignment (`POST`/`DELETE /tags`, now
  `admin_auth.authorize_superuser` instead of `auth.authorize_surgeon`) and astronaut
  creation/role (`POST /astronauts`, `PUT /astronauts/<id>/role`, both new, both superuser-only,
  both validating `role` is `"Crew member"` or `"Flight surgeon"`) moved to the superuser side.
  Crew renaming (`PUT /astronauts/<id>`, name-only), reset-demo-data, and CSV export links stay
  exactly as they were -- still Flight-Surgeon-only, just relocated from the deleted Admin tab
  into the Flight Surgeon tab (`static/js/surgeon.js`, "Crew names"/"Data" cards).
- **Unknown-tag backlog**: `backend/sessions.py`'s `handle_scan()` now also calls
  `_remember_unknown_tag(uid)` (in-memory dict, capped at 50, same live-demo-not-history
  philosophy as `active_sessions`/`open_toggles` in the same file) whenever a tapped UID isn't
  in the `tags` table. Before this, an unrecognized tap was gone forever if nobody's browser
  happened to be connected at that exact instant -- now the superuser can see and assign it
  later from `/admin`, which also still gets live via the unchanged `"unknown_tag"` Socket.IO
  broadcast and CYD message if they're watching in real time.
- **The main app no longer reacts to unknown taps at all** -- the old `admin.js`'s
  `Bus.on("unknown_tag", ...)` listener (which force-switched the Flight Surgeon's browser to
  the Admin tab with zero warning) is gone along with the rest of that file. The CYD's own
  message is now unconditionally generic too -- `screens.ino`'s `onUnknownTagMsg` says "Unknown
  card" + the uid, dropping "New tag"/"Assign it on the laptop" entirely, so a kiosk tap never
  hints that assignment is even possible. No protocol change -- the `unknown_tag` message shape
  is untouched, compile-checked clean (`arduino-cli`, now installed -- see "Firmware
  invariants").
- **`backend/db.py`'s `wipe_db()` now excludes `superusers`** from its drop list. It used to
  drop every table, and "Reset demo data" calls it -- without this fix, that button would have
  deleted every superuser account, locking the superuser out until they re-ran the CLI. This is
  a correctness fix, not a design choice: superuser accounts aren't demo data.
- **New standalone page**: `templates/admin.html` + `static/js/admin_page.js` -- not part of the
  main SPA's Tabs/Chart.js/`main.js`, just reuses `static/css/style.css` for visual consistency.
  Login form, then an "Unknown tags" backlog (assign inline -- pick an existing astronaut and
  optionally change their role, or create a brand-new one, for `astronaut`/`surgeon`-kind tags;
  any other kind just needs a label) and the tag registry (ported from the deleted `admin.js`).
  **Does** load `static/js/socket.js` (the same `Bus` the main app uses) -- an earlier version
  didn't, so a card tapped while this page was open never showed up until you refreshed; the
  backlog only ever got (re)fetched on page load or right after an assign/dismiss. Now
  `Bus.on("unknown_tag", ...)` triggers a live re-fetch, same as the broadcast the CYD/main app
  already got. Verified with a real Socket.IO client (`socket.io-client` via Node, scratch-only,
  not a project dependency) that the broadcast actually arrives the instant `handle_scan` sees
  an unrecognized uid.
- Verified end-to-end against a throwaway `--simulate` instance on a separate port (not the
  user's own running server): superuser login/logout, an unknown tap landing in the backlog,
  both the "existing astronaut + role change" and "new astronaut + role" assign paths, the new
  card immediately working for `nfc_login`, a Flight-Surgeon-only session getting 401 on tag
  writes, and the main page's HTML having zero references to the old Admin tab. All test data
  from that verification was deleted afterward, including the throwaway superuser account.
- **`backend/seed.py` no longer seeds `OBJECT_TAGS` as real rows** (removed from `seed_all()`,
  2026-11-04, at the user's request once real crew cards were in use) -- the placeholder
  exercise/sleep/meal/medicine/bp_guide/emergency catalog was demo clutter in the tag registry
  for a deployment with real crew. `OBJECT_TAGS` itself is still defined (only `_seed_history()`,
  dormant since no `ASTRONAUTS` entry has a `"story"`, still references it) -- just not inserted
  into `tags` anymore. The live `data/astro.db` was cleaned up to match (every tag row except
  `type IN ('astronaut', 'surgeon')` deleted) rather than only deleting the specific fake UIDs,
  which also correctly preserved a 4th real crew member ("Aziz") the user had already assigned
  via `/admin` since the last doc pass. Assign real object tags via `/admin` going forward.

## Testing

- `.venv/bin/python -m pytest` — 62 tests (rules engine, protocol, sessions, REST API, symptoms,
  login/access control).
- `.venv/bin/python app.py --simulate` then exercise the feature at `http://localhost:5000`
  (Simulator panel drives every CYD event through the same code path a real tap would).
- Kill any backgrounded dev server you start for screenshots/recording afterward
  (`pkill -f "app.py --simulate"`), don't leave it running between tasks.
- Ask before flashing firmware to a real board, same as Lifeline.

## Status (2026-11-04)

- Git has a remote (`origin`, a GitHub repo under the user's account) and two commits on
  `master` so far: the initial build, then one covering everything since 2026-11-03 (symptom
  reporting + guidance-on-tap, NFC login/access control, the CYD multi-indicator note fix, the
  USB serial reliability fix, auto-simulated vitals, and matching doc updates). `git status`/
  `git log` before assuming anything newer than that is saved anywhere but disk — this file
  gets edited ahead of commits, not after.
- Initial 2026-10-29 build (backend, full 10-tab web app, firmware) passed its own checks that
  session (pytest, a headless full-page click-through, `arduino-cli compile`) but was never run
  on real CYD/S3 hardware. Since then (2026-11-03): auto-simulated vitals, a USB serial
  reliability fix (cable/signal issue still outstanding, see above), the CYD status-note fix,
  symptom reporting + guidance-on-tap (a voice/NVIDIA version of this was tried and deliberately
  dropped), full login/access control (NFC-card login, Flight-Surgeon-sees-everyone /
  everyone-else-sees-only-themselves), and (2026-11-04) persisting the session secret key so
  restarting the dev server doesn't force everyone to re-log in, the Live tab following login
  instead of a one-time CYD-session broadcast, explicit sign-off syncing both ways between the
  web login and the CYD session ("Done" logs the browser out, "Log out" ends the CYD session --
  passive endings like idle timeout or a re-tap still don't), and a brand-new
  `firmware/esp32s3_nfc_reader/` sketch (see above), ported from the user's own real, working
  GitHub project after a first from-scratch attempt guessed wrong, aimed at its slow/short-range
  card detection. `pytest` is current (62 tests, all passing). **`arduino-cli` is now installed
  on this machine** (it wasn't for the whole 2026-11-03 session) and both firmware sketches
  compile clean -- but the corrected ESP32-S3 reader sketch (real pins, ported fixes) hasn't
  been flashed/confirmed on the real board yet, and `astro_cyd` has never been flashed to real
  hardware at all. Compile passing is not the same as hardware-verified -- check both before
  trusting either.
