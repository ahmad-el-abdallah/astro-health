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
     reader firmware" below: that board's firmware now lives in this repo too -- **and
     superseded again 2026-11-05**, see "Pico NFC reader replaces the dead ESP32-S3" below:
     that physical board failed permanently, and NFC now goes through a Raspberry Pi Pico
     plugged straight into the laptop, bypassing the CYD/ESP-NOW link entirely for this.
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
app.py                      entry point: Flask + Socket.IO, picks a bridge, seeds the DB, serves
                             the React build as an SPA (no Flask static folder, no templates)
backend/                    grouped by concern (see "Backend reorganized into folders" below) —
  config.py, db.py, seed.py   stay at this top level: nearly every other module imports these
  routes/                     the Flask blueprints — routes.py (/api/*), admin_routes.py (/api/admin/*)
  auth/                       web login — auth.py (astronaut/surgeon), admin_auth.py (superuser),
                               create_superuser.py (CLI)
  hardware/                   talks to physical boards — protocol.py (wire format) plus
                               serial_bridge.py/wifi_bridge.py/pico_bridge.py (the 3 bridges)
  services/                   external AI integrations — consult.py (NVIDIA chat), voice.py (edge-tts)
  logic/                      core domain rules — sessions.py, health_rules.py, symptoms.py
  jobs/                       background/time-based work — scheduler.py (mission clock, reminders,
                               Schedule statuses), comms.py (delayed messages)
config/*.json               every PLACEHOLDER value (thresholds, text, missions, schedule, symptoms)
data/astro.db               created at runtime by backend/seed.py, git-ignored
frontend/                   the React app (Vite + React 19 + Tailwind v4 + motion) -- see
                             "React frontend" below. dist/ (the build) IS committed.
  src/pages/crew/              Overview, Body (+ body/), Trends (+ trends/stats.js), Mind, Sleep,
                                Mission, Schedule, Learn
  src/pages/doctor/            CrewOverview, Alerts, CrewProfile, feed.js (the alert feed)
  src/pages/admin/Admin.jsx    /admin (its own superuser login)
  src/components/              shared UI (ui/, charts/, layout/ incl. Sidebar + DoctorTools,
                                overlays/, Thread.jsx, VitalTile, TrendCard, RiskMeter…)
  src/three/                   anatomy/ (3D twin), faceAvatar/ (Face to Face), planet3d.js
  src/lib/                     api.js, socket.js (+ EVENT_INVALIDATIONS), queries.js, format.js,
                                levels.js, reportText.js, faceId.js
  scripts/build-anatomy.mjs    one-off pipeline that produced public/models/anatomy.glb
  public/                      anatomy.glb, the TalkingHead avatar, face-api.js + its models
firmware/astro_cyd/         the CYD sketch (TFT_eSPI + XPT2046, not LovyanGFX like Lifeline)
firmware/esp32s3_nfc_reader/ dead hardware, kept for reference only -- see "Pico NFC reader
                             replaces the dead ESP32-S3" below, do not try to revive this board
firmware/pico_nfc_reader/   the live NFC reader: Pico + PN532, USB-straight-to-laptop
firmware/existing/          reference-only copies of Lifeline's lock sketch + nfc_link.h
tests/                      pytest (196) -- flat, one test_<module>.py per backend module, plus
                             test_spa.py (SPA serving), test_cyd_logout.py, test_scheduler.py
docs/build-prompt.md        the original 16-section spec
docs/CLAUDE.md              these notes (root CLAUDE.md only imports this)
docs/*.mp4, *.pdf           delivered demo video(s) and the guide PDF — see "Deliverables" below
video3-src/, video3b-src/   disposable build scratch for the trailer video — see "Deliverables"
```

**`static/` and `templates/` are gone (2026-11-11).** Older dated entries below describe the
vanilla app that lived there (`static/js/tabs/*.js`, `templates/index.html`…); they're history.
The React files say in their header comment which old file they were ported from.

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
- **Rewards/gamification was removed entirely (2026-11-11, user's request: "remove the rewards
  section from everywhere")** — no points, badges, leaderboard or team goal anywhere: deleted
  `backend/logic/gamification.py` + `config/gamification.json`, the `/rewards` + `/leaderboard`
  routes, every points insert (sessions/symptoms/assess/mood/sleep/CYD paths, seed history),
  the `points`/`badges` table definitions (an older `data/astro.db` may still contain those two
  tables — harmless, nothing reads them), `"points"` from `/summary`, `/crew` and the CYD
  `session` protocol message, Doctor AI's rewards context line, the React nav item/route/
  sidebar badge/Overview + Body mentions, and the CYD session screen's "N pts" header
  (firmware compile-checked, **not flashed** — until it's reflashed, the old firmware just shows
  "0 pts" since the field is gone). Older entries below that mention points/badges/Rewards are
  historical. If a reward system ever comes back, parse any rule strings by hand, never `eval()`.
- **Schedule page = the routine on the mission clock (2026-11-11, React rebuild)**:
  `GET /astronauts/<id>/schedule` (self-or-surgeon) returns `backend/jobs/scheduler.py`'s
  `day_plan()` -- mission day, seconds into it, `time_scale`, and every `config/routine.json`
  entry with a status. **"done" comes from the DB** (an assessment for `vitals`, a
  mood/sleep/exercise reading or activity, or an open sleep-tag toggle) inside the task's
  window: from 1 mission hour before its slot up to the next same-kind slot, so one workout
  never ticks off both exercise blocks. Otherwise `upcoming` → `due` once the clock passes
  the slot → `missed` 3 mission hours later (or once the next same-kind slot starts). The
  clock is `scheduler.clock_started_at` (set by `app.py`'s background loop) × `TIME_SCALE`,
  so it restarts at 00:00 with the server, same as reminders always did. The page ticks the
  clock locally and applies the upcoming→due→missed steps itself (`withLiveStatus` in
  `frontend/src/pages/crew/Schedule.jsx`, same rules) so it never lags the dial. Doctor AI's
  schedule context now includes each task's live status too.
- **CYD session idle time is set by the laptop (2026-11-11)**: `backend/config.py`'s
  `SESSION_IDLE_S` (default 600 s, env `ASTRO_SESSION_IDLE_S`) goes out in every `session`
  message as `idle_s`; the CYD uses it for its own untouched-screen timeout (firmware
  default 10 min if absent), so changing it never needs a reflash. While someone touches the
  CYD it sends `{"type":"active","uid":…}` at most once a minute (no `cyd_event` broadcast
  for it), and every CYD message refreshes the laptop's copy of the session
  (`sessions.note_cyd_contact`). The laptop's own `SESSION_TIMEOUT_S` = idle + 30 s is only a
  safety net. Before this, the laptop ended every CYD session exactly 2 min after the tap
  even mid-use, because CYD touches never reached it.
- **Sidebar (React, 2026-11-11)**: tablet/desktop = sticky column that collapses to a 76px
  icon rail (edge chevron or Ctrl/⌘+B, saved in localStorage `ah-sidebar`, first visit
  collapsed below 1200px); only `AppShell`'s wrapper animates width, and inside
  `Sidebar.jsx` every icon/avatar sits at the same x in both widths (labels fade + clip),
  rail tooltips are portalled to `<body>`. Phones (<768px) = ☰ in the top bar opening the
  same sidebar as a slide-in drawer (Account + Log out live in its user card; the top bar
  hides them there).
- **Mission comms delay**: `config/missions.json` profiles each have their own delay; everything
  is sped up by `TIME_SCALE` (`backend/config.py`, default 60, override with `ASTRO_TIME_SCALE`)
  so e.g. a 20-minute Mars-transit delay becomes a ~20s real wait. Messages carry a `deliver_at`
  and only become visible once it's passed (`backend/comms.py`) — modeling that Earth genuinely
  can't answer instantly. The daily reminder schedule (`backend/scheduler.py`,
  `config/routine.json`) runs on the same scaled clock.

## Firmware invariants

- **`firmware/esp32s3_nfc_reader/` is dead hardware, not dead code to ignore but a specific
  physical board that failed permanently (2026-11-05, see that section below).** Its
  `nfc_link.h`-must-match-`astro_cyd`'s-copy invariant (below) is now vestigial for the same
  reason the surgeon-PIN code is vestigial elsewhere in this file: nothing sends ESP-NOW frames
  to the CYD anymore, so `astro_cyd/nfc.ino`'s receive side just sits idle. Left in place
  (removing it is cleanup, not a fix) — don't spend time debugging it, and don't assume a
  working ESP-NOW link if you ever see `astro_cyd` logs mentioning it.
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
- **Flashed and running since 2026-11-11** (boot + `hello` confirmed; the user uses its Done
  button daily). Still never formally checked one by one: screen rotation
  (set to `1`; Lifeline's LovyanGFX sketch uses `3` if this looks wrong), touch calibration
  (`TS_MINX/MAXX/MINY/MAXY`), the microSD `SD_CS_PIN=5` guess in `protocol.ino`, and LED/speaker
  physical behavior. Check these on the actual boards before relying on them.
- Compile-check: `arduino-cli compile --fqbn esp32:esp32:esp32:PartitionScheme=huge_app firmware/astro_cyd`
  (32% flash / 14% RAM — unchanged from the initial 2026-10-29 build even after everything
  since, including `screens.ino`'s `drawWrapped()`, re-confirmed 2026-11-04). **Ask before
  flashing any board** — same rule as Lifeline. To flash, the laptop's `app.py` must let go of
  the port first (the user stops it with Ctrl+C; never kill their server yourself).
- **`arduino-cli` is now installed on this machine (since 2026-11-04)** — `/usr/local/bin/arduino-cli`,
  with the `esp32:esp32` core (3.3.12) and `TFT_eSPI`/`XPT2046_Touchscreen`/`ArduinoJson`/
  `Adafruit_PN532` all installed via `arduino-cli lib install`. It was missing for the whole
  2026-11-03 session (hence the firmware changes that session went uncompiled); now that it's
  here, both sketches (`astro_cyd/` and `esp32s3_nfc_reader/`) compile clean — don't re-claim
  "arduino-cli isn't installed" without checking again first.
- **`rp2040:rp2040` (earlephilhower) core added 2026-11-05** for `firmware/pico_nfc_reader/` --
  not the official `arduino:mbed_rp2040` core, which doesn't support the per-pin UART remapping
  (`Serial1.setRX()`/`.setTX()`, and `SerialPIO` for non-fixed-UART pin pairs) this sketch needs.
  Added via `arduino-cli config add board_manager.additional_urls
  https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json`
  then `arduino-cli core install rp2040:rp2040`. Board FQBN: `rp2040:rp2040:rpipico`.

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

## Mission Health tab (2026-11-04, from branch `3wrf-edits`, merged into master)

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

## Pico NFC reader replaces the dead ESP32-S3 (2026-11-05)

- **The ESP32-S3 reader board failed permanently this session** — not a pins/firmware bug, the
  physical chip. Diagnosed exhaustively before concluding this: its WiFi radio brownout-resets
  the instant it tries to calibrate (confirmed with the PN532 fully disconnected, on every
  cable/USB port/power source tried including a wall charger, with the brownout detector
  disabled in software and WiFi TX power lowered — none of it mattered), and separately it
  started reporting an eFuse hardware revision ("block rev 3.4") that no toolchain recognizes as
  real — not Arduino's `esp32:esp32` core, not PlatformIO's `espressif32` platform, not a
  freshly-cloned, freshly-built official ESP-IDF `release/v5.4` bootloader compiled same-day.
  Three independent toolchains agreeing it's not a real, currently-shipping chip revision is
  what settled it: the chip's own hardware reporting is corrupted, most likely heat/electrical
  stress from the hundreds of brownout-reset cycles this session's testing put it through.
  Likely already somewhat marginal even before that (the board's own docs/CLAUDE.md note from
  2026-11-04 recorded its ESP-NOW link coming up only once, briefly, never confirmed stable).
  **Treat this specific board as dead. Don't retest its WiFi.**
- **Replacement, decided with the user: a Raspberry Pi Pico (plain RP2040, no WiFi/Bluetooth at
  all) reads the same PN532 module.** Since it has no radio, it can't relay taps to the CYD over
  ESP-NOW the way the ESP32-S3 did — instead it's plugged into the laptop over its own USB port,
  sends `{"type":"scan","uid":"XX:XX:XX:XX"}\n` lines straight there, and a new, tiny bridge
  (`backend/pico_bridge.py`, started from `app.py` alongside the CYD's own bridge) feeds those
  into the *exact same* `handle_cyd_message()` the CYD's own "scan" messages already go through
  — so login/session toggling is 100% reused, unchanged. **No CYD firmware change at all** — the
  CYD still gets the matching `session`/`led` commands from `sessions.handle_scan()`'s existing
  `send_fn`, so its screen stays in sync with a Pico-originated tap. `PicoBridge` auto-detects
  the port the same hint-matching way `serial_bridge.find_port()` does (now matching "pico" in
  the port description) and is a no-op if none is plugged in — entirely optional hardware, same
  philosophy as everything else that degrades to simulation/absence gracefully.
- New sketch: `firmware/pico_nfc_reader/pico_nfc_reader.ino`. Library: Adafruit_PN532 (same one,
  same version, already proven against this exact PN532 module). Board: `rp2040:rp2040:rpipico`
  (see "Firmware invariants" above for the core).
- **Wiring**: PN532 VCC -> Pico `3V3(OUT)`, GND -> GND, the two PN532 data pins -> Pico GP1/GP2
  (either way round — swap in the sketch's `PN532_TX_PIN`/`PN532_RX_PIN` if a fresh board lands
  the wires the other way). GP1/GP2 aren't a fixed hardware-UART TX/RX pair on RP2040 (only
  specific pin groups are — GP0/1, GP4/5, GP8/9, GP12/13, GP16/17, GP20/21, GP24/25, GP28/29),
  so the sketch uses `SerialPIO` (RP2040's PIO-based software serial, part of the earlephilhower
  core) instead of a `HardwareSerial`/`Serial1` instance — this is what let the wiring stay on
  whichever two pins the PN532 actually landed on rather than needing yet another rewire.
- **A real library bug, not a wiring issue, wasted a lot of this session's debugging time**:
  `Adafruit_PN532`'s UART constructor unconditionally runs `pinMode(_reset, OUTPUT)`, and the
  conventional "I'm not using a reset pin" sentinel (`-1`) doesn't behave safely with that on
  this core. Passing a real, otherwise-unused GPIO (`PN532_RESET_PIN = 15` in the sketch, PN532's
  actual RSTPDN pin stays unconnected, same as on the ESP32-S3 build) fixed it. Diagnosed by
  bisecting: a hand-rolled raw byte probe (bypassing the library entirely) got a clean, correctly
  checksummed `GetFirmwareVersion` reply on wiring the library itself failed on with the exact
  same pins seconds apart — proof the connection was fine and the bug was in library usage, not
  hardware. If a from-scratch PN532+RP2040 sketch ever mysteriously can't find the chip again,
  check this first before re-suspecting wiring.
- **Verified end-to-end**: a real crew card (Sameer, `2B:ED:20:54`) tapped on this Pico produced
  `scan` -> `session_started` (and a second tap -> `session_ended`, a third -> `session_started`
  again) over the running `app.py`'s Socket.IO stream, watched live with a throwaway
  `python-socketio` client (scratch-only, not a project dependency, same philosophy as the
  Socket.IO verification during the superuser admin page work on 2026-11-04).
- `firmware/README.md` and the root `README.md` got a matching pass the same day (both now
  describe the Pico as the live reader and the ESP32-S3 as dead/reference-only) — the
  superseded-architecture text earlier in *this* file (the "Where this came from" and "ESP32-S3
  NFC reader firmware now lives in this repo" sections above) was left as-is with inline
  "superseded" pointers rather than rewritten, matching how this file always handles history.
  `firmware/esp32s3_nfc_reader/` itself is left in the repo for reference (same "don't delete,
  mark superseded" convention as `docs/archive/` and the old trailer cut) rather than deleted.
- **Future idea raised by the user, not yet built**: running the whole backend (`app.py`) on a
  Raspberry Pi Zero 2 W instead of a laptop, with both the CYD and this Pico plugged into it over
  USB. Assessed as workable: the app is lightweight enough for the Zero 2 W's CPU, its own WiFi
  replaces the laptop's for LAN access to the dashboard, and none of this session's ESP32 WiFi
  problems apply (completely different WiFi hardware/stack). Two real requirements if this
  happens: a USB OTG hub (the Zero 2 W has only one USB data port, and two boards need plugging
  in), and possibly `dtoverlay=dwc2,dr_mode=host` in `config.txt` if the port doesn't come up in
  host mode by default. Nothing implemented yet — just scoped.

## Body tab: 3D digital-twin viewer, ported from a user-supplied demo (2026-11-05)

- The user supplied a standalone demo zip (`body-full.zip`, "A.S.T.R.A") — its own Flask app
  with a three.js "digital twin" body viewer (procedural capsule/sphere meshes for brain, heart,
  lungs, gut, bones, muscles, colored by severity, click-to-inspect with a camera fly-to,
  skin/muscles/bones/organs layer toggles) plus a free-text symptom chat and its own parallel
  backend (own SQLite schema, own session/login, own readings form). Asked to "apply this
  project on the body page" — read as: bring the 3D viewer onto this app's existing Body tab,
  not merge in its separate backend/session/chat system, which would duplicate (and conflict
  with) the login/session/Live-tab-symptom machinery this app already has, tested, and relies on
  elsewhere. Scope call made without asking: ported the 3D geometry/interaction only; dropped
  the chat panel, readings form, own DB and own NFC/session logic from the zip entirely.
- `static/js/body.js` was rewritten to replace the old flat `static/img/body.svg` (still in the
  repo, unused — left in place, not deleted, same "don't delete, mark superseded" convention as
  the rest of this file) with a three.js scene built from the zip's geometry, but rewired onto
  this app's own data: region colors come from `/summary`'s `body_levels` (unchanged backend,
  `config/health_rules.json` via `content.json`'s `body_parts`) instead of the zip's own severity
  scale, and the side panel + 7-day mini chart are the same `showRegion()`/`drawMiniChart()`
  logic the old SVG version used, calling `/content` and `/history` exactly as before.
- **Region mapping**: the zip's 6 regions (brain, heart, lungs, gut, bones, muscles) don't match
  this app's 7 (brain, eyes, heart, stomach, skeleton, muscles, immune) — mapped lungs->immune,
  gut->stomach, bones->skeleton (same meshes, renamed), and added a new `eyes` hotspot (two small
  spheres on the head, not in the original zip) so all 7 of this app's existing `content.json`
  body parts stay clickable, none dropped.
- **three.js + OrbitControls are now vendored locally** (`static/vendor/three.min.js`,
  `static/vendor/OrbitControls.js`, r147, downloaded from the same CDN URLs the zip's HTML
  loaded at runtime) instead of loaded from a CDN, to keep the project's "no CDN at runtime,
  fully offline" rule (`docs/build-prompt.md` section 4) — the zip's own `body.html` referenced
  `cdn.jsdelivr.net` directly, which wouldn't have worked offline. Worth noting this is a
  different call than `static/js/planet3d.js` (Mission Health tab), which deliberately avoided
  three.js/any library in favor of a hand-rolled canvas scene — here three.js was brought in
  anyway since the user explicitly asked to port this specific zip's 3D viewer, not rebuild an
  equivalent from scratch.
- Verified against the user's own already-running `--simulate` dev server (found already
  listening on :5000 — left it running, didn't kill it, since it wasn't a server this session
  started) using a throwaway Playwright + Chromium install in the scratch dir (not a project
  dependency): canvas renders with a live WebGL context, clicking a region (e.g. a leg) flies the
  camera in and updates the side panel/mini chart, and POSTing a RED heart-rate+blood-pressure
  assessment through the real API repainted the heart mesh red live over the existing
  `"assessment"` Socket.IO event, with the uninvolved immune/lungs region staying green — zero
  console/page errors throughout. The one RED test reading + assessment row this created for
  Ahmad (astronaut_id 1) was deleted again afterward by exact row id so the user's real demo data
  wasn't left polluted by the test.

### Follow-up: full-fidelity rework (same day, 2026-11-05)

The first pass above was judged unfaithful by the user: the 3D view was squeezed into a fixed
`flex:0 0 340px` box next to a wide text panel, and the demo's discomfort slider (NONE/MODERATE/
SEVERE scale), "About this part" accordion, and danger-alert banner were dropped entirely. Asked
to look at every file in the zip and run it to see every feature — confirmed via two research
passes (one reading the zip's full source, one auditing this app's reusable CSS/JS/backend
patterns) that the zip's `.cols{1fr 1fr}` two-column grid (Consultation chat | Digital Twin,
collapsing under 900px) is what makes the twin read as "big," not a magic width — and that the
discomfort slider isn't decorative there, it blends into the region's color via `Math.max` and
persists per-astronaut through the zip's own backend.

User explicitly confirmed, this time (not guessed): **bring over the whole zip UI** (chat panel +
manual readings form too, accepting the overlap with Live tab), and **persist discomfort for
real**, not just as frontend state.

- **New backend**: a `discomfort` table (`backend/db.py`, same append-only shape family as
  `readings`) plus `POST /astronauts/<id>/discomfort` (region+0-10 intensity, same
  `authorize_view` pattern every other per-astronaut route uses) and
  `POST /astronauts/<id>/discomfort/report` (recomputes the blend **server-side**, never trusts
  the client; fires `comms.queue_report()` the same "medium tier" way
  `backend/symptoms.py`'s existing `alert_if_red()` already does for a RED symptom — i.e. it
  shows up in the Flight Surgeon's "Crew reports" but deliberately does **not** insert into the
  `alerts` table, matching that existing precedent rather than the heavier `assess()`-RED path).
  `/summary` now also returns `"discomfort"` alongside `"body_levels"`.
- **`static/js/body.js`** rewritten again: the `.cols` two-column grid (chat left, twin right,
  stacking under 900px — this alone fixes "too small," no magic pixel width needed), the
  three.js scene's `paint()` now colors from a client-side `blendedLevel(region)`
  (`worseClient(vitals, bandFromIntensity(discomfort))`, mirroring the new backend route's own
  blend exactly) instead of raw vitals, a free-text consultation chat (regex keyword → region,
  same table the zip used, adapted to this app's region names) that persists through the same
  `POST /discomfort` the slider uses, and a readings form mapped onto the **real** 4 fields
  `assess()` actually accepts (confirmed by reading it directly — sleep/mood/exercise/water are
  CYD/simulator-only, never POSTed manually anywhere in this app) with deterministic
  "Normal readings"/"Simulate abnormal state" fills derived from `config/health_rules.json`'s
  own bands.
- **A real correctness trap, caught before shipping**: every tab's DOM stays mounted
  simultaneously (`.tab-panel{display:none}`/`.active{display:block}`, never removed), so the
  new readings form had to use distinct ids (`body-in-hr` etc.) from Live tab's identical-looking
  form (`in-hr` etc.) — reusing those would have silently collided.
- **Another real bug caught during verification, not design**: the discomfort slider's `input`
  (continuous drag) handler must never fully re-render `#body-sel`'s `innerHTML` — doing so
  replaces the `<input type="range">` DOM node out from under the user's own pointer mid-drag.
  Fixed by splitting into a full `renderSelected()` (region switches, data reloads) vs. a
  targeted `updateLiveBlend()` (every drag tick: touches only the readout/badge/alert-box
  text, never the slider element itself). Verified directly: dragging fires zero network
  requests, exactly one `POST /discomfort` fires on release, and the value survives a full page
  reload.
- **Vocabulary deviation, deliberate**: the region chip reuses this app's own `levelBadge()`/
  `STRINGS.levelWord` ("Good/Check/Alert"), not the zip's "Normal/Caution/Danger" — consistency
  with the rest of the app's voice won out over literal copy fidelity for that one piece.
- **Verified end-to-end**, this time against an isolated throwaway copy of the whole repo on its
  own port (5057) with its own `data/` dir — not the user's live `data/astro.db`, and not the
  user's own already-running dev server either (its Python routes don't hot-reload the way
  templates/static files do; restarting that specific process was attempted once but denied by
  the sandbox's own safety classifier as "interfering with a workload" it didn't start, which is
  the right call — hence the separate isolated copy instead, reusing the same Playwright+Chromium
  install from the first pass's scratch dir). Confirmed via real interaction, not just code
  review: the two-column layout at both wide and <900px, the chat chip → region-select → reply
  pipeline, the drag-with-no-network / release-with-one-POST / reload-persists sequence above,
  the danger alert + consent-gated "Send report" landing in the Surgeon's reports but not its
  Alerts list (as designed), and a vitals-RED `assess()` landing in Alerts for contrast. Zero
  console/page errors. 6 new backend tests added to `tests/test_api.py` (69/69 total passing).

## Consultation chat: real NVIDIA-hosted AI, Body tab only (2026-11-05)

- The Consultation chat's keyword-matching ("I think you mean X region") is now backed by a real
  NVIDIA-hosted model call when a key is configured — **scoped to this one chat panel only**,
  nothing else in the app calls out to the internet, and the keyword table is kept (not deleted)
  as the automatic fallback. This knowingly breaks the "fully offline" rule
  (`docs/build-prompt.md` section 4) for this one feature only, with the user's explicit sign-off
  — everything else in the app stays offline-capable.
- **User explicitly chose "AI decides everything"**: the model itself reads the free-text message
  and decides which body region + 0-10 intensity to log (not just the reply text) — a bigger ask
  than it sounds, since that decision now writes real data (the same `discomfort` table/route the
  slider uses). Handled by requiring the model to answer in strict JSON
  (`{"region":..,"intensity":..,"reply":..}`) and validating every field server-side
  (`backend/consult.py`'s `parse_model_output()`): an unknown region id, an out-of-range or
  non-integer (or `bool` — `isinstance(True, int)` is `True` in Python, a real trap) intensity,
  or a missing/blank `reply` all get caught, with region+intensity nulled **as a pair** so nothing
  half-valid ever gets persisted. Pure, network-free, directly unit-tested
  (`tests/test_consult.py`).
- **Model choice was verified against the live catalog with the user's real key, not guessed** —
  important, because guessing would have shipped a broken feature: `GET
  https://integrate.api.nvidia.com/v1/models` lists 84 models, but most (including the
  `meta/llama-3.1-70b-instruct`/`meta/llama-3.3-70b-instruct` ids a web search suggested) 404
  ("Function ... Not found for account") when actually called with this account's key — only
  specific models are enabled per-account, not the whole catalog. Settled on
  `nvidia/nemotron-3.5-lightning-30b-a3b` after test-calling several candidates directly.
  **Second real trap caught the same way**: that model defaults to emitting a long chain-of-
  thought into a separate `reasoning_content` field and leaving `content` empty/null if
  `max_tokens` runs out first (`finish_reason: "length"`, zero tokens left for the actual answer)
  — `chat_template_kwargs: {"thinking": false}` turns that off and makes it answer directly;
  confirmed against the exact prompt shape this app sends, including a message with no specific
  symptom correctly returning `region: null, intensity: null`. Overridable via `NVIDIA_CHAT_MODEL`
  env var if NVIDIA's catalog moves again.
- **The key is a real secret, handled like one**: written once to `data/nvidia_api_key` (plain
  text, gitignored — a **new** `.gitignore` line was needed since the file only had
  `data/secret_key`/`data/*.db` as exact-name entries, not a blanket `data/` ignore; confirmed by
  reading it directly before assuming). `backend/config.py`'s new `nvidia_api_key()` checks an
  `NVIDIA_API_KEY` env var first (for anyone who prefers that), else that file, else `None` — no
  key simply means the feature is unavailable, same shape as every other optional-hardware/
  optional-feature fallback in this app. The key only ever lives server-side; the route
  (`POST /astronauts/<id>/consult`) is the only thing that calls NVIDIA, the browser never sees
  it — verified via the Network tab during manual testing. No key configured → `503`; any upstream
  failure → `502`; the frontend's one `catch` block treats both the same way (fall back for that
  one message, not a global "AI is dead" flag — the very next message tries again).
- **This route deliberately does not write to the `discomfort` table itself** — it returns the
  model's decision only, and the frontend calls the already-existing, already-tested
  `POST /astronauts/<id>/discomfort` (the same call the slider makes) to actually persist it. One
  write path for "a region's intensity just got logged," not two that could drift apart.
- **A pre-existing gap got fixed while touching this code, not just avoided**: assistant chat text
  was always trusted/static before this change, so it went into `innerHTML` unescaped; now that it
  can come from an LLM it's untrusted dynamic content. Added a proper `escapeHtml()` (full
  `&<>"'` escape, not the old `<`-only replace) applied to both the user's typed message and the
  AI's reply — the regex-fallback path's own canned HTML (`<b>${info.label}</b>` etc.) stays
  unescaped, that's still trusted/config-sourced text.
- A "Thinking…" placeholder bubble (reuses the existing `pulse-opacity` keyframe already used for
  RED body regions, no new animation) appears immediately and is swapped in place once the real
  reply lands — a real network call has much more latency than the old instant/450ms canned path.
  Needed `addChatMessage`/the render function reworked to support update-in-place by id, not just
  append-only.
- **Verified end-to-end against a real NVIDIA call**, not mocked: "my back hurts a lot, maybe an
  8" correctly logged `skeleton` at intensity 8 (a defensible call — back pain → skeleton, not
  muscles), flew the camera there, and the model's reply was genuinely grounded in the system
  prompt's spaceflight framing ("significant in microgravity -- could relate to fluid shifts or
  muscle deconditioning... alert the flight surgeon"), not generic chatbot filler. Confirmed via
  `/summary`'s `discomfort` field that this was a real persisted write, not just a UI update.
  Separately verified the no-key fallback path (renamed the key file aside, restarted): `/consult`
  returns 503, the chat falls back to the keyword-matching reply with no stuck "Thinking…" bubble
  and no visible breakage. Both passes run against an isolated throwaway copy of the repo on its
  own port, not the user's live `data/astro.db` — the 4 `discomfort` rows already in the live db
  (astronaut 2, timestamps 15:52/16:18 that day) predate this session's testing and are the user's
  own real usage of the feature, left untouched, not test data. 14 new tests (11 pure-logic in
  `tests/test_consult.py`, 2 route-level in `tests/test_api.py` mocking `consult.ask` so CI never
  makes a real network call, both counted — 83/83 total passing).

### Follow-up: making the agent smarter (same day, 2026-11-05)

User asked to make the Consultation AI "as smart as possible" plus wanted a list of further ideas.
Four concrete improvements shipped, one explicitly scoped as a live-verify-don't-guess step:

- **Multi-turn conversation memory** — the single biggest gap: every message used to be classified
  in total isolation, so a follow-up like "it's getting worse, now like a 9" (no body part named)
  got zero context from the symptom described a message earlier. `static/js/body.js` now keeps a
  separate `chatHistory` array (plain `{role,content}` text, never the rendered/escaped HTML
  `chatMessages` holds) and sends it on every `/consult` call; `backend/routes.py`'s new
  `_sanitize_chat_history()` is the real trust boundary (the client's own 10-turn cap is advisory
  only) — it whitelists `role` to exactly `user`/`assistant`, silently dropping anything else,
  specifically so a direct API call can't smuggle a fake `"role":"system"` turn to override the
  real system prompt. **Verified live**: "my back hurts, maybe a 6" → correctly logged skeleton/6;
  "it's getting worse, now like a 9" as the very next message → correctly escalated to 9 and the
  reply tracked the same back-pain context, with zero body-part words in that second message.
- **Richer system-prompt grounding** — the prompt used to only include mission-hazard one-liners;
  now it includes all 7 regions' real `what_it_does`/`space_effects`/`what_to_do` text from
  `content.json` unconditionally (cheap — well under ~1K tokens total), so replies stay consistent
  with the "About this part" accordion the astronaut reads in the same tab instead of the model
  falling back on generic spaceflight trivia. Also now includes **today's already-elevated
  regions** (reusing the exact blending loop `/discomfort/report` already had —
  `_compute_body_levels`/`_latest_discomfort`/`_discomfort_band`, zero new logic, just a new
  `_elevated_today_lines()` wrapper), scoped to YELLOW/RED only and framed as optional context
  ("mention naturally if relevant, don't force it") — GREEN/GRAY regions are never listed, to
  avoid both prompt noise and GRAY ("no data yet") being misread as a flag.
- **Few-shot examples — deliberately skipped.** Evaluated three example categories; the model
  already handled the clear-symptom and greeting/null cases cleanly in the original testing. The
  one real gap (a message spanning two regions, e.g. headache + nausea) got a single instruction
  sentence instead of a hardcoded example — small instruction-tuned models tend to overfit to the
  specific example rather than generalize the rule, and a full few-shot block costs tokens on
  every call forever for a model that's already compliant elsewhere.
- **Retry once on malformed output, scoped narrowly** — new `MalformedOutputError(ConsultError)`
  subclass (still `isinstance`-compatible with every existing `except ConsultError`/
  `pytest.raises` — no breaking change). `backend/consult.py`'s `ask()` retries exactly once,
  appending the bad output + a corrective note as extra turns, **only** for malformed-JSON/
  missing-`reply` failures — never for network/timeout/empty-content failures, where a retry would
  just double the wait before the existing fallback kicks in anyway with little chance of success.
- **Model upgrade, verified live against the real key, not guessed** — tested four more
  candidates someone might assume are "obviously better" (`nemotron-3-super-120b-a12b`,
  `nemotron-4-340b-instruct`, `llama-3.1-nemotron-70b-instruct`, `llama-3.1-nemotron-ultra-253b-v1`):
  **all four 404** for this account, same "not every catalog model is actually enabled" trap as the
  original model search. Two candidates that did work got tested side-by-side against the current
  model with the exact real system-prompt shape and a multi-symptom message:
  `nemotron-3.5-super-vl-120b-a12b` was both slower (7.8s) and lower-quality (shorter, less
  engaged with the secondary symptom) than the incumbent, ruled out. `nemotron-3-ultra-550b-a55b`
  (550B total/55B active, vs. the incumbent's 30B/3B-active) gave noticeably more nuanced,
  clinically-aware replies (e.g. flagging neutral spine positioning and red-flag symptoms like
  fever/radiating pain unprompted) at 4-8s — slower than the incumbent's ~1s but still comfortably
  under the 12s timeout and acceptable behind the existing "Thinking…" indicator built for exactly
  this. **`DEFAULT_MODEL` switched to `nvidia/nemotron-3-ultra-550b-a55b`** — still overridable via
  `NVIDIA_CHAT_MODEL` with zero code change if the catalog moves again.
- A separate, longer menu of further ideas (voice I/O via NVIDIA Riva — a version of this was
  tried once before and dropped, see "Symptom reporting" above, worth reconsidering now that the
  NVIDIA plumbing already exists; streaming replies; a tool/function-calling architecture; a
  safety/content-moderation model pass; AI-nudged-but-still-consent-gated escalation; persisting
  transcripts for the Flight Surgeon to review; feeding in multi-day trend data; moving the system
  prompt into `config/`; a per-session rate limit; gamification points for using the chat) was
  handed to the user as options, not implemented — explicitly out of scope for "make it smarter."
- 12 new tests (9 in `tests/test_consult.py` covering the retry state machine, history forwarding
  order, and the richer prompt's conditional blocks; 4 in `tests/test_api.py` covering history
  truncation, the role-whitelist/prompt-injection defense, and elevated-vs-clean astronauts) — all
  mocked, no real network calls in CI. 95/95 total passing. Verified live end-to-end against an
  isolated throwaway copy again, not the user's live db.

## Face to Face: a voice conversation with an animated avatar (2026-11-05)

User asked for a "face to face" voice mode for the Consultation AI: push a button, talk to it,
hear it answer immediately in its own voice, with an animated avatar — specifically asking for a
"realistic human-like face with lip-sync" and "perfect voice." Three scope questions were asked
and answered directly: realistic-face option (not an orb or cartoon), edge-tts for voice (not the
browser's built-in voice or an unverified NVIDIA voice stack), push-to-talk (not always-listening).

**A hard constraint discovered before any design work, not a choice**: `edge-tts`'s streaming API
was tested directly in this environment and only ever yields `"audio"` and `"SentenceBoundary"`
chunks — no word-level or viseme/phoneme timing data at all. There is no metadata available to
drive frame-accurate lip-sync from this voice engine, full stop. Combined with this project having
no 3D head/avatar asset or rigging pipeline (and no realistic path to build/source true
photorealistic rendering in one pass — that's what dedicated commercial "digital human" products
like NVIDIA ACE/Audio2Face, D-ID, HeyGen exist for), **what actually got built is a
stylized-but-clearly-humanoid 3D head** (`static/js/face_avatar.js`, same procedural-primitives
three.js style as the Body tab's existing digital twin — head, eyes with blinking, eyebrows, a
mouth), **with the mouth driven by the real-time amplitude of the actual playing audio** (Web
Audio API `AnalyserNode` → RMS of the time-domain samples → smoothed, fast-attack/slow-decay →
mouth Y-scale) rather than true phoneme lip-sync. This is the honest, achievable substitute, not
a compromise snuck in quietly — the plan's Context section said this explicitly before any code
was written, and the delivered result matches it.
- **Lighting/material needed a real second pass, not just geometry**: the first render (default
  `HemisphereLight` at 1.3 + a strong `DirectionalLight`) blew out highlights so badly the face
  read as a pale washed-out egg, not a warm skin tone — confirmed visually via screenshots, not
  assumed. Fixed with softer, warmer, more diffuse lighting (lower intensities, a cool fill light
  from the other side) and a more saturated, rougher (less shiny) skin material — re-verified by
  screenshot before calling it done.
- **Backend**: new `backend/voice.py` (`synthesize(text)`/`SpeechError`, mirrors
  `comms.py`/`symptoms.py`/`consult.py`'s one-file-per-concern shape) wraps `edge-tts`'s async
  streaming API via `asyncio.run()`, accumulating audio bytes in memory from the stream generator
  rather than a temp file (no existing temp-file pattern in this app to match, and in-memory
  sidesteps cleanup-on-error entirely for what's a few seconds of short speech). New
  `POST /astronauts/<id>/speak` route, same `authorize_view` pattern as every other per-astronaut
  route, returns raw `audio/mpeg` bytes directly (not JSON) — a real failure here degrades
  gracefully (the AI's text reply already showed independently of this call; the turn just stays
  silent rather than breaking). `edge-tts==7.3.1` added to `requirements.txt` (was already
  installed in `.venv` from this project's own demo-video narration work, now pinned/reproducible).
- **Frontend pipeline reuses the exact same conversation the typed chat already has** — `sendChat`
  (typed) and the new voice path both funnel through one shared `submitMessage()`/`replyTo()`
  pipeline (a small refactor of the existing functions, not a fork), so `chatHistory`/
  `chatMessages`/`persistDiscomfort`/`scene3d.selectRegion` all stay the single source of truth
  either way — you can type one message, then speak the next, same remembered conversation.
  Push-to-talk uses the browser's native `SpeechRecognition` (Chrome-only; other browsers get the
  mic button disabled with a clear inline message instead of silently failing). Captions of both
  what was said and what the AI replied stay visible throughout — not just accessibility, but what
  keeps the amplitude-only (not phoneme-accurate) mouth sync from feeling broken, since the user
  reads along rather than scrutinizing lip shapes.
- A new **"Face to Face"** button in the Consultation panel's header opens a full-screen overlay
  (`#face-overlay`, same fixed/z-index idiom this app already uses for `#emergency-overlay`),
  built dynamically the same way the rest of the Body tab's markup already is, not a template
  change.
- **Verified live, not just unit-tested**: `/speak` called directly against the real edge-tts
  service returned real playable MP3 bytes (confirmed content-type and non-trivial byte count);
  the avatar's idle state (blink, breathing bob) and its talking state were both screenshotted; a
  burst of screenshots taken a few hundred ms apart *during* real playback showed the mouth
  genuinely opening and closing with the audio, not a static pose. Real microphone input can't be
  driven headlessly in this sandbox (no audio hardware) — that part needs the user's own check in
  an actual Chrome tab; everything downstream of "the browser produced some text" (which is most
  of the new surface area) was verified by calling the shared submission pipeline directly with a
  fake transcript, same approach the typed-chat path already gets tested with. 9 new tests (3 in
  `tests/test_voice.py` for `synthesize()`'s success/no-audio/wrapped-exception cases, 4 route-level
  in `tests/test_api.py` for `/speak`'s empty-text/success/failure/privacy cases, both network-free
  via mocking) — 102/102 total passing.
- This is a second, deliberate deepening of the Consultation feature's already-accepted "needs
  real internet" exception to this project's offline-first rule — the NVIDIA call and now also a
  call to Microsoft's edge-tts cloud service, both scoped to this one feature, nothing else in the
  app affected.

## Follow-up: a realistic avatar, Ready Player Me + TalkingHead.js (same day, 2026-11-05)

User saw the procedural primitive avatar above and asked why it looked cartoonish rather than
realistic, then picked the heavier of three offered options: a real 3D avatar model + a proper
lip-sync library, instead of the cheaper 2D-photo or NVIDIA-digital-human alternatives.

- **Stack**: a Ready Player Me-style avatar (`static/avatars/brunette.glb`, pulled directly from
  the TalkingHead.js repo's own bundled examples — `readyplayer.me` itself is unreachable from
  this sandbox, confirmed by DNS failure while GitHub/jsdelivr both worked fine, so the repo's own
  examples were the only reachable source; CC BY-NC 4.0, fine for this non-commercial NASA
  hackathon demo) rendered and lip-synced by `TalkingHead.js` (met4citizen, MIT licensed, confirmed
  directly on GitHub before vendoring anything). New `static/js/face_avatar_rpm.js` is an ES
  module bridging it into the rest of the app (`window.FaceAvatarRPM = {init, speak,
  stopSpeaking}`) — the classic-script `static/js/body.js` calls into it from click handlers only,
  so the fact that module scripts execute after classic ones during page load never matters.
- **A second, newer three.js (r186, `three.module.js`) is vendored separately** from the
  existing `three.min.js` (r147, UMD) the Body tab's own digital-twin viewer already uses —
  TalkingHead.js needs the newer API surface, and deliberately keeping the two versions isolated
  (a new import map just for this ES-module piece, in `templates/index.html`) means upgrading for
  this one avatar carries zero risk of breaking the already-working digital twin. 13 files
  vendored in total (three.module.js + 7 of its `examples/jsm` addon modules TalkingHead imports —
  GLTFLoader, OrbitControls, DRACOLoader, FBXLoader, meshopt decoder, RoomEnvironment, stats —
  plus TalkingHead's own two sibling modules, retargeter.mjs/dynamicbones.mjs, plus the avatar
  itself) — all confirmed reachable and downloaded for real, not assumed.
- **edge-tts still gives no viseme/word-timing data** (confirmed in the pass above) — TalkingHead's
  `speakAudio()` wants `words`/`wtimes`/`wdurations` when you supply your own audio and no real
  viseme data, so `face_avatar_rpm.js` estimates word timings by splitting the known reply text
  proportionally across the real decoded audio's duration (weighted by word length), and lets
  TalkingHead's own English language module convert that into actual mouth shapes. This is
  estimated-timing lip-sync, not frame-accurate — a real step up from pure amplitude-reactivity
  (the primitive avatar's approach) since mouth shapes now vary by phoneme, not just loudness, but
  still not perfect, and said so plainly before building rather than after.
- **Automatic fallback to the original primitive avatar** (`face_avatar.js`, kept, not deleted) if
  `FaceAvatarRPM.init()` throws for any reason — a real risk worth guarding since this is a third
  party "small side project" library (its own words) with no major version/maintenance commitment,
  being integrated into a brand-new (same-session) ES-module/import-map code path this app had
  never used before. `body.js`'s `ensureFaceAvatar()` tries the realistic avatar first, catches
  any failure, and silently drops back to the known-working one rather than leaving a broken
  overlay.
- **A real, non-obvious gotcha caught before it reached the user**: Flask caches compiled Jinja
  templates in memory once rendered, unlike static JS/CSS files (always read fresh from disk per
  request) — every prior same-day change this session was a pure static-file edit and showed up
  live with no restart, which is why this one genuinely surprised by *not* doing that. Confirmed
  directly (curled the live page, the new `<script type="importmap">`/module tag were simply
  absent) before concluding a restart was actually needed, rather than assuming.
- **Two sandbox permission walls hit and respected, not routed around**: the auto-mode safety
  classifier blocked running the freshly-downloaded third-party JS through Playwright
  ("Code from External"), and separately blocked this session from writing its own expanded
  Bash permission into `.claude/settings.local.json` ("Self-Modification") when asked to self-grant
  that access. Both are reasonable guardrails, not bugs — neither was worked around. **As a
  result, this integration is wired up from careful source-level reading (exact function
  signatures/API confirmed by grepping the real downloaded `talkinghead.mjs`, not guessed) and
  every vendored file confirmed individually reachable via the live Flask server, but the actual
  rendered 3D avatar + lip-sync has not been visually confirmed working by either Claude or the
  user yet as of this entry** — unlike every other feature in this file, which got a real
  screenshot-verified pass before being called done. Check this on real hardware before trusting
  it; the automatic fallback above means a failure here should at worst silently downgrade to the
  already-working primitive avatar, not break the feature outright, but that fallback path itself
  hasn't been exercised live either.

### Follow-up: the unverified-ness above was real (same day, 2026-11-05)

The automatic fallback worked exactly as designed — the user saw the known-good primitive cartoon
avatar, not a broken page — but the realistic avatar genuinely was not loading, confirming the
honest "not yet visually verified" note above was correct, not just hedging.

- **Root cause**: an incomplete dependency vendor. `GLTFLoader.js` and `FBXLoader.js` (both
  imported unconditionally by `talkinghead.mjs`) have their own nested relative imports
  (`../utils/BufferGeometryUtils.js`, `../utils/SkeletonUtils.js`, `../libs/fflate.module.js`,
  `../curves/NURBSCurve.js`, which itself imports `../curves/NURBSUtils.js`) that were never
  copied in the first pass — only each file's own *direct* imports were checked, not the full
  transitive closure. ES modules resolve their entire dependency graph before any code in that
  graph executes, so one missing file anywhere in the chain silently kills the whole
  `import { TalkingHead } from ...` at the top of `face_avatar_rpm.js` — `window.FaceAvatarRPM`
  simply never got attached, no exception was ever thrown for the first error-handling pass (added
  the same day, see above) to catch, which is exactly why the user saw the plain default caption
  instead of any error message at all. A separate, smaller miss: `three.module.js` (r186) itself
  imports a sibling `three.core.js` that single-file three.js builds don't need — also missing,
  also now vendored.
- **Fixed properly this time, not just patched for the one failure seen**: wrote a small script
  that walks every vendored `.js`/`.mjs` file, regex-matches every relative `from './...'` /
  `from '../...'` import, and checks the resolved path actually exists on disk — caught the
  `three.core.js` gap too, which hadn't even surfaced as a user-visible symptom yet. Re-ran until
  it reported a fully closed graph (21 files total) rather than fixing one broken import and
  hoping. This is the kind of check that should have been done after the *first* vendoring pass,
  not only after a real failure forced it.
- **Closed the other gap in the error-surfacing fix**: the first pass only caught `init()`
  *throwing* — it had no handling at all for `window.FaceAvatarRPM` not existing in the first
  place (the actual failure mode this time), which is why the user saw no error. `body.js`'s
  `ensureFaceAvatar()` now also polls briefly for `FaceAvatarRPM` to appear (module scripts can
  still be mid-flight on the very first call) before concluding it's genuinely missing, and shows
  a distinct, specific caption + console error for that case too.
- **Separately, same user report**: the Consultation/voice pipeline's latency (the `ultra` model
  picked earlier specifically for "smarter" text replies, ~4-8s) read as broken rather than
  thoughtful once it was a live spoken conversation. Reverted `DEFAULT_MODEL` back to
  `nemotron-3.5-lightning-30b-a3b` (~1s) for both typed and voice chat, per explicit user
  preference (speed over the deeper reasoning) — still one `NVIDIA_CHAT_MODEL` env var away from
  the slower model if that tradeoff is ever worth it again.
- **Still genuinely unverified by either of us as of this entry** — all file-existence/reachability
  checks pass now, and the dependency graph is provably closed, but nobody has yet seen the
  realistic avatar actually render and lip-sync in a real browser. The user needs to hard-refresh
  (the earlier failure may also have involved a stale cached copy of `body.js` from before the
  first error-visibility fix — browsers cache static JS aggressively, unlike this app's own
  always-fresh-from-disk static file serving on the Flask side) and try again.

## Follow-up: voice turns going silent after a long wait (same day, 2026-11-05)

User reported two things about Face to Face mode: replies sometimes took a long time, and
sometimes produced **no audio at all, only the text caption** — even after the model-speed revert
above. Root-caused two separate real bugs, not one, both fixed:

- **Bug 1 -- `edge-tts` itself fails intermittently.** Called `backend/voice.py`'s `synthesize()`
  directly (no mocks) several times in a row with real text and got a genuine, reproducible
  `edge_tts.exceptions.NoAudioReceived: No audio was received` on some calls -- then an identical
  call, moments later, succeeded. `edge-tts` talks to an undocumented, reverse-engineered Microsoft
  Edge "Read Aloud" endpoint, not a stable public API, and this is exactly the kind of transient
  failure that shape of integration produces. Previously `synthesize()` had no retry, so a `/speak`
  call that hit this returned a 502 the frontend's `catch` block absorbed silently -- text showed
  (already independent of this call), no sound, no error visible anywhere. **Fixed**: `synthesize()`
  now retries once (`MAX_ATTEMPTS = 2`), each attempt capped at `TIMEOUT_S = 12` via
  `asyncio.wait_for` (mirrors `consult.py`'s own NVIDIA timeout) -- the same "retry once on a
  known-transient external failure" shape `consult.py` already uses for NVIDIA's malformed-JSON
  case, just applied to this service's own failure signature. Verified directly: re-ran the same
  failing text through the new `synthesize()` several times with no failures surfacing: real base
  latency for a 1-3 sentence reply runs roughly 1.5-8s per call in this environment (Microsoft's
  side, not something this app's code controls) -- occasionally slow, but no longer a silent dead
  end when it's also unlucky.
- **Bug 2 -- a real risk even when synthesis succeeds, found reading `talkinghead.mjs`'s source
  directly (not yet reproduced live, no audio hardware in this sandbox)**: both avatars
  (`face_avatar.js`, `face_avatar_rpm.js`) used to create their own `AudioContext` *lazily inside
  `speak()`* -- which only ever runs several `await`s removed from the actual click that started
  the turn (recognition result -> `/consult` round trip -> `/speak` round trip -> finally `speak()`).
  Some browsers only treat an `AudioContext` as user-gesture-unlocked if it's created/resumed
  synchronously inside the click handler itself; created this late, it can end up permanently
  `"suspended"` with no exception anywhere -- `talkinghead.mjs`'s own `playAudio()` explicitly
  anticipates and logs exactly this failure mode (confirmed by reading it: a 1s `resume()` race
  that gives up silently). **Fixed**: `body.js` now creates one shared `AudioContext` *synchronously*
  inside the "Face to Face" open button's click handler (`getSharedAudioCtx()`, called as literally
  the first line, before even opening the overlay), resumes it again defensively inside the mic
  button's click (`startListening()`), and threads that single pre-unlocked context into both
  avatars: `FaceAvatarRPM.init(container, ctx)` passes it through to `TalkingHead`'s own `opt.audioCtx`
  constructor option (confirmed to exist at `talkinghead.mjs:921`, used instead of TalkingHead
  creating its own internal context), and `FaceAvatar.init(container, ctx)` stores it for its own
  `createMediaElementSource` graph. One context total now, created at the earliest possible real
  gesture, instead of each avatar racing to create its own late.
- Also fixed `speakReply()`'s `catch (e) {}` (a true no-op before this) to `console.error` the
  real failure -- the exact same silent-catch shape that hid the missing-dependency bug in the
  follow-up above hid this one too; left silent on purpose (the text reply must still show even if
  voice fails) but never silent in the console again.
- **Honest limits of this pass**: the retry fix was verified directly against the real failure
  (ran real, unmocked `synthesize()` calls and watched it recover) -- that part is solid. The
  `AudioContext` fix is based on reading `talkinghead.mjs`'s own source for the exact mechanism
  (`opt.audioCtx`, `initAudioGraph()`) and matches the documented browser behavior, but has **not**
  been confirmed live in a real browser (same sandbox limit as the realistic-avatar work above --
  no real audio hardware here, and Playwright against this third-party JS was already blocked once
  this session). Base `/speak` latency itself (1.5-8s, Microsoft's side) is not something this pass
  can reduce further -- flagged plainly rather than overclaiming a fix for it. 102/102 tests still
  passing (no test changes needed -- `tests/test_voice.py`'s mocks don't exercise real retry timing).

### Follow-up: proved the fix works, found where it still doesn't reach (same day, 2026-11-05)

User reported the exact same symptom again after the pass above (restarted server, hard-refreshed
browser confirmed via server log timestamps -- not a caching repeat). Took this as a sign the
*mechanism* needed actual proof, not just source-reading, so went further than before:

- **Built an isolated throwaway copy of the repo on its own port again** (same established
  pattern), and used Playwright **without** the `--autoplay-policy=no-user-gesture-required` flag
  the *original* Face to Face verification (the one that produced `verify_face_idle.png`/
  `verify_face_talking.png` screenshots, see "Face to Face" section above) had used -- that flag
  disables Chromium's autoplay/gesture enforcement entirely, so that earlier "verification" could
  never actually have caught a real gesture-unlock bug even if one existed. This time, instrumented
  `window.Audio`/`window.AudioContext` via `page.addInitScript` to log every state transition, and
  drove the page with a **real, trusted Playwright click** on the "Face to Face" open button
  (trusted clicks count as user gestures for autoplay purposes; `page.evaluate()` calls do not).
- **Result: the primitive avatar's fix is proven correct under the real policy.** The log showed
  `AudioContext created, initial state=running` (not `suspended`) immediately after the real click,
  `audioEl.play()` resolving (not rejecting), and `currentTime` genuinely advancing in step with
  wall-clock time over 2+ seconds of observation. The shared-context-created-in-the-click-handler
  mechanism from the pass above works exactly as intended, confirmed by execution, not just by
  reading `talkinghead.mjs`'s source.
- **This narrows the bug to the realistic (TalkingHead/RPM) avatar path specifically**, which
  couldn't be run through this same test -- the auto-mode safety classifier blocked it again
  ("Code from External"), same as earlier this session, for the same reasonable reason (it's
  third-party vendored code), and was respected rather than routed around. Added a 15s timeout
  (`Promise.race` in `body.js`'s `ensureFaceAvatar()`) around `window.FaceAvatarRPM.init()` as a
  direct defense against the one concrete, verified-real risk found while re-reading
  `talkinghead.mjs` for this: its GLTFLoader/DRACOLoader stack defaults `dracoDecoderPath` to a
  live `www.gstatic.com` CDN URL (a real "no CDN at runtime" rule violation, though the vendored
  avatar's own `extensionsUsed`/`extensionsRequired` are both empty, confirmed by parsing the
  `.glb`'s JSON chunk directly, so Draco decoding should never actually trigger for this specific
  file). Without this timeout, any stall anywhere in that third-party loader stack -- reachable or
  not -- left the caption stuck on "Loading avatar..." forever, with no error, which is exactly the
  "shows text, never talks, no error" shape reported. Now it fails into the already-proven-working
  primitive avatar within 15s instead of hanging indefinitely.
- **Still open**: whether the realistic avatar is actually the one active for the user when this
  happens (vs. already having silently fallen back to the primitive one, which is now proven to
  work) is unknown without the user checking what's on screen -- a cartoon-simple face vs. a more
  photorealistic one -- or the exact caption text, since that's the one signal this session's
  tooling can't observe directly for this specific vendored path. 102/102 tests still passing.

### Follow-up: the actual bug, found from the user's own browser console (same day, 2026-11-05)

Confirmed realistic avatar (not the fallback) -- user pasted the real browser console output, which
named the exact failure precisely, no more guessing needed:

```
:5000/static/vendor/lipsync-en.mjs:1  Failed to load resource: 404 (NOT FOUND)
Uncaught (in promise) TypeError: Failed to fetch dynamically imported module: .../lipsync-en.mjs
body.js:858 speakReply failed -- no voice this turn: TypeError: Cannot read properties of undefined
  (reading 'preProcessText') at TalkingHead.lipsyncPreProcessText (talkinghead.mjs:2834)
  at TalkingHead.speakAudio (talkinghead.mjs:3134) at Object.speak (face_avatar_rpm.js:90) ...
```

- **Root cause**: `talkinghead.mjs`'s `lipsyncGetProcessor(lang, path="./")` (line ~2816) loads its
  per-language lip-sync processor via a **dynamic** `import('./lipsync-' + lang + '.mjs')` --
  resolved relative to `talkinghead.mjs`'s own location, i.e. `static/vendor/lipsync-en.mjs`, which
  was never vendored. The two earlier dependency-closure passes (see "unverified-ness was real"
  above) only regex-matched **static** `import ... from '...'` statements -- a dynamic `import(...)`
  built from a string is invisible to that kind of check, so this gap survived both passes even
  though the graph-closure script reported "fully closed." Compounding it: that `import(...)` is a
  bare `.then(module => {...})` with **no `.catch()`** in the library's own code -- a 404 there
  leaves `this.lipsync` permanently empty with no error surfaced at the failure site itself. The
  *next* `speakAudio()` call's `lipsyncPreProcessText()` does
  `this.lipsync[lang] || Object.values(this.lipsync)[0]` -- with `this.lipsync` empty, that's
  `undefined`, and calling `.preProcessText()` on it throws exactly the reported error. This is why
  the avatar visibly loaded and rendered fine (showAvatar() never touches lipsync modules) but the
  very first spoken reply crashed inside `speakAudio()` -- caught by `speakReply()`'s own
  `console.error` (the exact fix added two passes ago for its previously-silent `catch {}`, which is
  what actually got this real error in front of the user instead of nothing at all).
- **Fixed**: vendored the real `modules/lipsync-en.mjs` from the same upstream
  `met4citizen/TalkingHead` repo everything else here came from (confirmed via its GitHub API
  listing that this file lives alongside `talkinghead.mjs`/`retargeter.mjs`/`dynamicbones.mjs` in
  `modules/`, all already vendored) to `static/vendor/lipsync-en.mjs` -- it's a standalone data/logic
  module (English text-to-viseme rules), no further imports of its own, confirmed by grepping it.
  Re-checked `talkinghead.mjs` for any *other* dynamic `import(...)` calls this bug's category could
  be hiding elsewhere -- found exactly one more, `./playback-worklet.js` (for the streaming/
  AudioWorklet speech path), confirmed unused by this integration (`speakAudio()`, not
  `streamAudio()`, is the only method ever called here) so deliberately left un-vendored rather than
  added speculatively. Verified the fix at the serving level: `GET /static/vendor/lipsync-en.mjs`
  now returns 200 (was 404). 102/102 tests still passing (no test changes -- this is a static-asset
  gap, nothing Python-side to test).
- **Lesson for next time a library is vendored**: a dependency-closure check must also scan for
  dynamic `import(...)` calls (including ones built from string concatenation, like this one's
  `path + 'lipsync-' + lang + '.mjs'`), not just static `import ... from` statements -- the earlier
  "fully closed" result from the graph-closure script was true for what it checked, but incomplete
  as a guarantee, and this is the second time (after the first "unverified-ness was real" pass's
  missing nested-loader imports) that an incomplete-by-construction check gave false confidence.

### Follow-up: voice gender + reply length (same day, 2026-11-05)

Once the lipsync-en.mjs fix above got voice actually working end to end, two more user reports:
still feels slow, and the voice is male while the avatar (`static/avatars/brunette.glb`, loaded
with `body: 'F'`) is female.

- **Voice**: `backend/voice.py`'s default `VOICE` switched from `en-US-AndrewNeural` (male) to
  `en-US-JennyNeural` (female) -- also just a better match for the avatar itself. Verified directly
  (not assumed) that the new voice isn't slower: ran the same test text through both, Jenny came
  back in 1.25-2.02s across 3 calls, comfortably inside the range already seen from Andrew.
  `CONSULT_VOICE` env var still overrides either way.
- **Length, the real lever on "taking a lot of time"**: edge-tts's synthesis time scales with how
  much text it's given, so `consult.py`'s system prompt was tightened from asking for "a short, 1-3
  sentence reply" to "a SHORT 1-2 sentence reply", with an explicit line telling the model *why*
  ("this gets spoken aloud by text-to-speech, so every extra sentence directly adds to how long the
  astronaut waits to hear you") rather than just a bare length cap -- grounding the instruction in
  the actual constraint tends to hold up better across multi-turn conversations than an arbitrary
  number alone. `max_tokens` dropped from 300 to 150 to match (still comfortable headroom for the
  JSON wrapper plus a 2-sentence reply).
- Needed a server restart (both files are Python, unlike the static-JS fixes earlier in this same
  day's work) -- restarted and confirmed the page loads. 102/102 tests still passing (no test
  changes needed -- nothing asserts on exact prompt wording or token counts).

## Backend reorganized into folders (2026-11-05)

`backend/` (15 flat `.py` files) and `static/js/` (18 flat `.js` files) were reorganized into
subfolders by concern, at the user's request, specifically to make the codebase easier for a
first-time-web-app team to navigate -- "where's the login code" used to mean opening files one by
one. See the "Layout" section above for the current tree; this entry records what moved and why,
and is the one place to look if an older dated entry above this one names a path that no longer
exists -- **this file's own convention is to mark things superseded going forward, not rewrite
history**, so every entry above this one keeps the flat path that was correct when it was written
(e.g. `backend/sessions.py`, `backend/auth.py`, `static/js/face_avatar.js`). Read those as
historically accurate, not as current paths.

- **`backend/` moved**: `db.py`, `config.py`, `seed.py` stay at the top level (nearly every other
  module imports `db`/`config`, and `config.py` computes its own `BASE_DIR` as
  `dirname(dirname(__file__))` -- confirmed by reading it -- which only resolves to the repo root
  if it stays exactly two directories deep, so it genuinely can't move without breaking every
  config/data path in the app). Everything else split into `routes/` (routes.py, admin_routes.py),
  `auth/` (auth.py, admin_auth.py, create_superuser.py), `hardware/` (protocol.py,
  serial_bridge.py, wifi_bridge.py, pico_bridge.py), `services/` (consult.py, voice.py), `logic/`
  (sessions.py, health_rules.py, symptoms.py, gamification.py), and `jobs/` (scheduler.py,
  comms.py) -- each a real Python package (`__init__.py` added, empty, matching the existing root
  one). `create_superuser.py`'s CLI invocation changed to
  `python -m backend.auth.create_superuser` -- fixed in its own docstring and in `README.md`.
- **`static/js/` moved**: `core/` (main.js, socket.js, auth.js, strings.js -- loaded by every
  page), `tabs/` (the 10 SPA tab modules, including simulator.js), `3d/` (face_avatar.js,
  face_avatar_rpm.js, planet3d.js -- 3D scene modules a tab invokes directly, not tabs
  themselves). `admin_page.js` stays at `static/js/` root -- it's the whole `/admin` page's own
  entry point, a single file, not part of the main SPA at all. `templates/index.html`'s ~21
  `<script>` tags and `templates/admin.html`'s 3 were updated to the new paths in the same load
  order; `static/js/3d/face_avatar_rpm.js`'s one relative import (`'../vendor/talkinghead.mjs'`)
  became `'../../vendor/talkinghead.mjs'` (one level deeper). Its other path reference,
  `'/static/avatars/brunette.glb'`, and the `<script type="importmap">` block are both
  root-relative/`url_for`-resolved, so neither needed to change.
- **Deliberately left alone**: `tests/` stays flat (10 files, each already `test_<module>.py`
  mirroring the module it tests 1:1 -- a well-known pytest convention; splitting it would add
  indirection for no benefit at this size -- only the *import paths inside* these files changed).
  `config/` (7 flat JSON files), `firmware/` (already organized by board), and `docs/` (deliverable
  names are meaningful as-is) were already fine and untouched. **`static/vendor/` was deliberately
  left untouched too** -- it's 100% third-party code the team will never read or edit, so
  folder-grouping it buys zero comprehension benefit, and it holds the exact TalkingHead.js
  integration that took a long debugging session (see "Follow-up: the actual bug, found from the
  user's own browser console" above) to get working -- touching its relative-import structure here
  would be pure risk for no reward.
- **Verified, not assumed**: every `from backend import ...` across `app.py`/`backend/**/*.py`/
  `tests/*.py` was found via `grep` and updated individually (preserving every existing `as` alias,
  e.g. `backend.config`'s loader functions still alias as `load_health_rules` etc. -- that
  name-collision pattern between `config.health_rules()` and the `health_rules` module was
  pre-existing, not introduced by this move). Also grepped for and fixed every stale path
  mentioned in comments/docstrings across the whole repo (not just functional imports) --
  `README.md`, `firmware/README.md`, and every moved file's own header comment. Confirmed with:
  `node --check` on every moved classic script plus `node --check --input-type=module` on
  `face_avatar_rpm.js`, `python -c "import app"`, the full `pytest` run (102/102 still passing,
  zero test behavior changes), and a live `--simulate` server smoke test -- the page, `/admin`,
  two API routes, and all 18 moved JS files individually curled and confirmed 200 (not 404), with
  the served HTML actually containing the new script paths (not a stale cached render). Server
  killed afterward per this project's own testing convention.

## Consultation AI gains real tool-calling: vitals, surgeon alerts, symptoms, breathing, emergency (2026-11-06)

User wanted the Consultation chat to become a genuinely more capable agent, not just a symptom
classifier -- settled through two rounds of `AskUserQuestion` (alert severity: always treated as
urgent; vitals: write immediately, no confirm click; then a follow-up brainstorm of further
abilities, all of which the user picked, including the highest-stakes one after being shown its
false-alarm risk explicitly). The decision JSON grew from 3 fields (`region`/`intensity`/`reply`)
to 10: `vital`, `alert_surgeon`/`alert_text`, `symptom`, `start_breathing`,
`trigger_emergency`/`emergency_text`.

- **Every paired field reuses the exact "null/false together, never a half-decision" idiom**
  `region`/`intensity` already established -- `parse_model_output()` in `backend/services/
  consult.py` applies it three more times (`vital`'s single-key shape, `alert_surgeon`/
  `alert_text`, `trigger_emergency`/`emergency_text`), not a new validation philosophy per field.
- **Vitals reuse `/assess` with zero new vitals-writing code**: `vital`'s shape is a 1-key subset
  of `/assess`'s own POST body on purpose, so `static/js/tabs/body.js`'s `aiReply()` forwards
  `decision.vital` to `POST /astronauts/<id>/assess` completely unreshaped -- evaluation,
  `readings` persistence, and RED-branch auto-escalation to the surgeon all come free from a route
  that already existed. Loose sanity bounds (heart_rate 30-250 bpm, blood_sugar 20-600 mg/dL,
  temperature 30-43 °C, blood_pressure systolic 50-250/diastolic 30-150 mmHg) were set by actually
  reading `config/health_rules.json`'s real GREEN/YELLOW bands first, not guessed -- and a first
  draft of the system prompt assumed Fahrenheit for temperature before that check caught it; this
  app uses **Celsius** throughout, confirmed directly in the config file.
- **`symptom` and `start_breathing` also reuse existing routes/UI with zero new backend work** --
  a decided symptom id goes straight to the existing `POST /astronauts/<id>/symptoms` (same
  `symptoms.record()`/`alert_if_red()` path the Live tab's chip UI already uses); breathing has no
  backend call at all, just a purely visual inline pulse in the chat (`.breathing-pacer` in
  `style.css`, reusing the existing `pulse-opacity` keyframe at a slower 4s cycle rather than
  inventing a new animation) plus the system prompt letting `reply` run longer than its usual
  1-2 sentence cap for this one case, to actually walk through counted breathing steps.
- **`trigger_emergency` also reuses the existing, deliberately-unauthenticated `POST /api/
  emergency`** -- no new backend code, and the frontend doesn't add a second, different
  confirmation paradigm just for the AI path: a confidently-detected emergency fires immediately
  and shows the real full-screen `#emergency-overlay`, same risk tier as the physical CYD button,
  with the same existing one-click "Cancel emergency" as the safety net. The actual safety
  mechanism is strict, separated system-prompt wording (an unmistakable "I need help right now"
  required; a severe-sounding symptom alone must NOT set this field, only `alert_surgeon` or a
  recommendation in `reply`) -- precision over recall, not UI friction. **Verified live against
  the real NVIDIA model** (not mocked): "I am in a lot of pain and scared" correctly left
  `trigger_emergency: false` (asked a follow-up, offered to alert the surgeon instead); "this is
  an emergency, I need help right now" correctly set it `true` with a grounded `emergency_text`;
  simulating the frontend's follow-up `POST /emergency` actually flipped `sessions.emergency
  ["active"]` to `true` and back to `false` on cancel.
- **One genuinely new route was unavoidable**: `POST /astronauts/<id>/alert`. Confirmed by reading
  every existing writer of the `alerts` table first -- `assess()`'s RED branch and
  `discomfort_report()` both recompute their own severity condition server-side and refuse to fire
  if it isn't actually met; neither accepts a free-form, user-asserted "please alert my surgeon."
  This route trusts the astronaut's own explicit request as the trigger (same trust level
  `log_discomfort()` already gives the intensity slider), and mirrors `assess()`'s RED branch
  exactly: writes `alerts` (level always `'RED'`, the table's only existing convention) AND
  `messages` (via the existing `comms.queue_report()`), so an AI-sent alert lands in the surgeon's
  primary Alerts list, not buried in Crew Reports. Verified directly against the DB, not just the
  response: a real NVIDIA-generated alert_text landed in both tables with matching content.
- **One genuinely new aggregation helper**: `backend/routes/routes.py`'s `_recent_trend_summary()`
  -- confirmed no existing code summarizes "last N days of indicator X" into one line;
  `astronaut_history()` returns a raw time series, nothing aggregates it. Reuses that route's exact
  query, just with min/avg/max computed over the result. Also extracted `backend/logic/
  gamification.py`'s `rewards_summary(conn, astronaut_id)` out of the `/rewards` route's
  previously-inline points/badges query, now shared by both that route and the Consultation
  context-builder -- a real DRY fix this feature enabled, not duplicated logic. **Honest scoping
  note, stated in the prompt itself**: the schedule context is the day's static plan from
  `config/routine.json`, not a live "already done" record -- that state exists only as an
  in-memory, non-queryable dict inside `backend/jobs/scheduler.py`; exposing it was explicitly left
  out of this pass. Verified live: asking "what's on my schedule today" and "how many points do I
  have" both came back grounded in this app's real config/DB, not generic filler; asking about
  heart-rate trends before any reading existed correctly got an honest "I don't have that yet"
  rather than a hallucinated number, and came back grounded once a real reading existed.
- **A real, pre-existing gap surfaced and fixed in the same pass**: `static/js/tabs/surgeon.js`'s
  alert/report rendering interpolated `a.text`/`m.body` straight into `innerHTML`, unescaped --
  safe until now because every writer of those columns was server-computed text. This feature
  makes that text LLM-originated for the first time (`alert_text`), the same category of risk
  `escapeHtml()` was added for in the chat bubbles themselves during the original Consultation work
  (see that section above). Fixed by promoting `escapeHtml()` out of `body.js`'s closure into
  `static/js/core/main.js` (already loaded on every page) so `surgeon.js` can use it too;
  `stripTags()` stayed local to `body.js`, only its own fallback path uses it. Checked
  `crew.js` for the same pattern while in there -- it only triggers a refresh on the `alert` event,
  never renders alert/message text itself, so nothing to fix there.
- `max_tokens` in `consult.py`'s NVIDIA payload bumped 150 -> 230 -- the larger JSON object's own
  structure (keys/punctuation for 7 more fields) eats into the budget independent of reply length;
  live testing afterward showed replies still landing in roughly the same ~1s this model has had
  since the earlier latency pass, so this didn't reintroduce the "feels stuck" problem that pass
  fixed.
- 38 new tests (`tests/test_consult.py`'s pass/null/pairing cases per new field plus prompt
  substring checks, `tests/test_api.py`'s new `/alert` route tests and a `rewards_summary()`
  regression guard). Five pre-existing tests that asserted strict dict equality against the full
  3-field decision shape needed updating to check individual keys instead -- the schema genuinely
  grew, so exact-equality was the one place "no existing test needs to change" didn't hold; every
  other existing test (including four `fake_ask` stubs whose signatures needed the new parameters
  added) kept its original behavior and assertions. 140/140 total passing.
- **Verified end-to-end against a real NVIDIA call** (not mocked), on an isolated throwaway copy
  of the repo on its own port with its own fresh DB -- not the user's live `data/astro.db` -- for
  every new ability: a stated vital correctly extracted and, once the frontend's follow-up
  `/assess` call was simulated, auto-evaluated to the right level; an explicit "tell the flight
  surgeon" request correctly set `alert_surgeon`/`alert_text` while leaving `trigger_emergency`
  false; a named symptom correctly matched the catalog; a breathing request produced an actual
  counted-steps script; the emergency precision/recall behavior above. Server killed afterward.

## Real login system: NFC + username/password + Face ID (2026-11-09)

The login screen used to offer NFC (fully working) plus two `disabled` "Coming soon" buttons for
username/password and Face ID. User supplied a downloaded mockup (`~/Downloads/index.html`, a
polished two-column "crew access" page whose own `<script>` was an explicit non-functional demo
— the password form just set a "Demo only" notice, and the Face ID/NFC buttons opened modals that
said "not connected") and asked for all three methods to actually work, built as this app's own
JS-generated markup, not pasted static HTML.

- **NFC stays the primary method** (the user's explicit instruction) — the mockup's own layout
  had username/password as the main card and NFC/Face ID as secondary "alternative" cards; that
  was flipped here, with NFC in the `.login-main` slot (reusing the existing `#login-nfc-status`
  element id unchanged, so `auth.js`'s status-setting code needed zero changes) and
  username/password + Face ID as the two `.login-alt` cards, expanding inline on click (same
  idiom `sleep_lab.js`'s `toggleLogForm()` already established) rather than a modal.
- **`backend/db.py` gained this app's first migration helper.** `init_db()` only ever ran
  `CREATE TABLE IF NOT EXISTS` — adding `username`/`password_hash`/`face_descriptor_json` to the
  `astronauts` table's schema text would never have reached the real, already-populated
  `data/astro.db`. New `_migrate_schema(conn)` (`PRAGMA table_info` → `ALTER TABLE ADD COLUMN`
  per missing column), called from `init_db()`. **Verified against a real copy of the live db**
  before trusting it on the real one — all 4 existing astronaut rows survived with the new
  columns NULL, and running it twice is a no-op (idempotent). Keep this same shape if another
  column is ever added to an existing table.
- **Username/password** reuses the superuser system's own proven pattern
  (`werkzeug.security.generate_password_hash`/`check_password_hash`) on the `astronauts` table
  instead of a new parallel table. New `POST /api/auth/password_login`, plus self-service
  `POST /api/astronauts/<id>/password` (and the matching Face ID routes below) are gated by a new
  `_authorize_self_or_superuser()` — deliberately NOT self-or-*surgeon*: seeing crew health data
  is the surgeon's privilege, resetting someone's login credentials is a different kind of power
  and doesn't ride along with it. A superuser can reset anyone's password or clear a stuck Face ID
  enrollment (account recovery), mirroring their existing tag-assignment powers — a new "Crew
  accounts" card on `/admin` reuses these exact routes, no new backend needed for that.
- **Face ID — real trust-boundary decision, not just a feature add.** No face-recognition
  capability existed anywhere in this app and the Python venv has zero ML/image libraries
  (`requirements.txt` is just Flask/Socket.IO/pyserial/pytest/edge-tts), so face matching has to
  happen client-side, vendored the same "no CDN at runtime" way three.js/TalkingHead.js already
  are. **face-api.js** (`static/vendor/face-api.min.js` + `static/vendor/faceapi-models/`, ~7.3MB
  of model weights, loaded lazily only once Face ID is actually attempted) was the only real
  option found — MIT-licensed, fully functional, confirmed downloadable — but its upstream (and
  its best-known fork) are both frozen projects with no real commits in years; the actively
  maintained alternative, MediaPipe's Face Landmarker, only outputs landmarks/mesh, not an
  identity descriptor, so it can't do this job at all. Same honesty standard as the TalkingHead.js
  entry: vendored anyway because nothing actively maintained does what's needed here.
  **The identity decision always happens server-side** (`backend/routes/routes.py`'s
  `face_login`/`_face_distance`, field-standard Euclidean threshold `0.6` — the same one
  face-api.js itself defaults to and the Python `face_recognition`/dlib library uses) — the
  browser only ever sends a raw 128-float descriptor measurement, never an identity claim, so a
  client can't just assert "I'm astronaut 3" to log in as someone else. `_valid_descriptor()`
  guards against malformed input (wrong length, non-finite values, and the same
  `isinstance(True, int)` trap `consult.py`'s `parse_model_output()` already had to catch).
- **New "Account & Security" overlay** (`static/js/core/account.js`, `#account-btn` in the
  header next to "Log out") — same fixed/z-index idiom as `#emergency-overlay`/`#face-overlay`.
  Lets the logged-in astronaut see their NFC card UID, set a username/password, and
  enroll/clear their own Face ID with a live camera preview, via `static/js/core/face_id.js`
  (a thin `FaceId` wrapper: lazy model loading, `getUserMedia`, `captureDescriptor()`).
- **The mockup's "Emergency Access" button is wired to the real SOS** (`POST /api/emergency`,
  already deliberately unauthenticated) at the user's explicit choice, not left as the mockup's
  text-only modal — `main.js`'s existing `Bus.on("emergency", ...)` listener already shows the
  real `#emergency-overlay` regardless of login state. "Forgot password"/"Contact mission ops"
  stay informational-only modals (no real backend feature behind either).
- **Verified end-to-end** against an isolated throwaway copy of the whole repo on its own port
  (not the user's live `data/astro.db` or running server): curl-level checks for every new route
  (password login success/failure, face login match/no-match, superuser reset, cross-astronaut
  403 vs. not-logged-in 401), then a real headless-Chromium pass (Playwright, no
  `--autoplay-policy` flags or other policy overrides) clicking through the actual page — the
  password card expands inline, Face ID gracefully reports "Camera unavailable" rather than
  crashing when no camera hardware exists, NFC login via the Simulator panel still works exactly
  as before, and the Account overlay opens and renders real per-astronaut status. Zero
  console/page errors throughout. One real bug caught by the tests themselves, not design review:
  `_authorize_self_or_superuser` originally returned 401 ("not logged in") for an astronaut who
  *was* logged in, just as the wrong person and not a superuser — fixed to return 403
  ("forbidden") in that case, 401 only when nobody's logged in as anything at all. 24 new tests in
  `tests/test_api.py` (164/164 total passing). Server killed afterward, scratch copy deleted.

## Follow-up: sleep/mood readings showed raw JSON on the Live tab (2026-11-10)

User reported the Live tab's "Today's vitals" grid showing a sleep reading as literal
`{"bedtime":"23:00","hours":8,"wake_time":"07:00"}` text next to the level badge, instead of a
formatted "8h 0m".

- **Root cause, bigger than the one visible symptom**: `readings.indicator = 'sleep'` (and
  separately `'mood'`) has **two different writers storing two different `value_json` shapes**
  for the same indicator, and nothing reconciled them when the second writer was added (in the
  earlier Mental Health/Sleep Lab tabs work). A physical object-tag toggle
  (`backend/logic/sessions.py`'s sleep-station tag, and the CYD's own mood tap via
  `_record_cyd_value` in `backend/routes/routes.py`) stores a **bare number** (hours / 1-5 score).
  The web Sleep Lab/Mental Health tabs' own manual POST routes store a **richer object**
  (`{hours,bedtime,wake_time}` / `{mood,score,note}`) — needed for those tabs' own bedtime/wake
  time and note display. `static/js/tabs/live.js`'s `formatIndicatorValue()` (which renders
  *every* indicator generically, not just the 4 manual vitals) only special-cased
  `blood_pressure`/`reaction_time` and fell back to `JSON.stringify(value)` for any other object
  — that fallback is what the user saw.
- **Fixed everywhere this shape ambiguity is read, not just the one spot reported**: added
  explicit `sleep`/`mood` cases to `live.js`'s `formatIndicatorValue()`, a `numericValue()` helper
  in `static/js/tabs/trends.js` (its generic Sleep/Mood dropdown options fed a bare value straight
  into Chart.js, which would have silently broken for any object-shaped reading), and a
  `sleepHours()`/`moodScore()` helper in `sleep_lab.js`/`mental_health.js` respectively (those two
  tabs were written assuming the object shape only — correct for their own POST route, but would
  have shown `NaN` for a CYD-reported mood tap or a sleep-station tag toggle mixed into the same
  history). All four now handle **either** shape rather than assuming one.
- **Deliberately not fixed at the source**: reconciling the two writers onto one shared
  `value_json` shape would mean either dropping bedtime/wake_time/note (regressing the Sleep
  Lab/Mental Health tabs' own displays) or changing the physical tag-toggle/CYD-tap paths
  (hardware-adjacent code, out of scope for a display bug fix). The frontend-tolerant fix is the
  minimal, safe one; revisit the storage shape itself if this keeps needing patches.
- No backend/test changes — this was a static-asset-only fix (`node --check` on all four touched
  files, 164/164 tests still passing, no test covers frontend rendering). Verified against an
  isolated throwaway copy, same pattern as every other pass in this file: POSTed a real sleep
  reading, confirmed via a real headless-Chromium screenshot that the Live tab now reads
  "8h 0m ● Good" instead of the raw JSON blob, zero console errors. Server killed afterward, no
  test data left in the user's real `data/astro.db` (never touched — only the scratch copy ran
  this request).

## React frontend replaces the vanilla app (2026-11-11, branch `ui-redesign`)

Rebuilt from the user's `~/Downloads/AstroHealth-Redesign` mockups (screens/, DESIGN-SPEC.md,
design-system/), then extended at the user's request: "use react.js… smooth motions,
specifically for charts and dashboards… make the body page look like this [x-ray skeleton
dashboard] and realistic". Every old feature was kept (decided with the user); the old
vanilla app was deleted once the last page was ported.

- **Stack**: Vite 8, React 19 (JS, not TS — user's choice), react-router, TanStack Query,
  socket.io-client, `motion`, Tailwind v4 (`@theme inline` tokens from CSS variables), d3
  scales for hand-built SVG charts, three + react-three-fiber/drei for 3D. No CDN at runtime.
- **The build is committed** (`frontend/dist/`, user's choice) so `python app.py` works on a
  laptop with no Node. `app.py`'s catch-all serves real files from dist as-is, everything
  else gets index.html, and `/api/*` stays a JSON 404 (tests/test_spa.py). **Rebuild and
  commit dist after any frontend change**, or the running app won't show it.
- **Live updates, no polling**: `src/lib/socket.js`'s `EVENT_INVALIDATIONS` maps each server
  broadcast to the TanStack Query keys it makes stale; `liveUpdates.js` wires it. New backend
  events added for this: `alert_acknowledged`, `message_sent`, `crew_updated`, `tags_changed`.
- **Roles**: `<html data-role="crew|doctor">` (set by `AuthProvider`) switches the whole
  palette (crew blue / doctor teal). Doctor routes are wrapped in `DoctorOnly`; the backend
  enforces access anyway. `/admin` sits outside the sign-in gate (own superuser login).
- **Performance rules** (the old login screen lagged badly; these fixed it — keep them):
  only the active route is mounted; heavy pages/3D/face-api are lazy chunks; animate only
  transform/opacity; never animate `background-position`, blurred or SVG-filtered elements;
  no `backdrop-filter` over content that animates (the 3D twin's overlays and the login card
  use `.ah-glass-flat`); R3F dpr capped at 1.5.
- **Glass theme** (user chose "full frosted blur everywhere"): `.ah-glass` / `-strong` /
  `-flat` in `src/styles/index.css` — tint + blur + saturate, frost grain (SVG noise data
  URI), a masked 1px specular rim (`::before`), over a **static** `SpaceBackdrop`. Glass is
  never nested in glass (inner tiles use `bg-raised`). Account → "Reduce glass effects"
  (`localStorage ah-glass=lite`) drops the blur; scroll containers that carry a rim scroll an
  inner div so the rim stays put.
- **Body page anatomy**: real meshes from **BodyParts3D 4.0** (© The Database Center for Life
  Science, **CC BY 4.0 — the on-screen attribution is required, keep it**), converted once by
  `scripts/build-anatomy.mjs` (meshoptimizer + gltf-transform; mm Z-up → m Y-up, feet at y=0)
  into `public/models/anatomy.glb` (~2.4 MB: skeleton, wire, muscles, skin, brain, eyes, heart,
  lungs→immune, stomach). Loaded with `useGLTF(url, false, true)` (draco off, meshopt on).
  No WebGL → `three/webgl.jsx`'s fallback instead of a crash.
- **Face to Face**: TalkingHead bundled from `src/vendor/talkinghead/` with
  `lipsyncModules: []` and `head.lipsync.en = new LipsyncEn()` set directly — this avoids the
  dynamic-import 404 trap from 2026-11-05. The AudioContext is still created synchronously in
  the click handler.
- **Sessions**: web login lasts 1 h (`session.permanent`, `LOGIN_LIFETIME` in app.py). CYD
  idle time comes from the laptop (`SESSION_IDLE_S`, default 600 s) and only "Done" signs the
  browser out (see the CYD entries in "How it works").
- **Doctor screens** use only real data: `/crew` carries each member's 24 h snapshot
  (`_today_snapshot()`, shared with `/summary`); the alert feed (`pages/doctor/feed.js`)
  merges open alerts with today's out-of-range readings, symptoms and no-data, worst first.
- **Messages**: `GET /astronauts/<id>/messages` is delay-aware on the server — an incoming
  crew report still in transit shows the surgeon only that it's coming (body `null`), and a
  surgeon reply in transit doesn't exist yet for the crew. Before this, replies were stored
  but never shown to the crew anywhere; now they pop up on arrival and sit on the Overview.
  Report wording is prettified at display time (`lib/reportText.js`).
- **Removed at the user's request**: Rewards/points/badges, everywhere (see "How it works").
- **Testing pattern used for every page**: an isolated `rsync` copy of the repo in the
  scratchpad with its own `data/` on `--web-port 5057` (never the live `data/astro.db`), driven
  by headless Chromium (`playwright-core` + the cached chromium with
  `--use-angle=swiftshader --enable-unsafe-swiftshader`). The sandbox has no GPU, so FPS there
  means nothing — the user judges smoothness on their laptop.

## CYD redesign, phase 1: visual facelift of the crew screens (2026-11-11, branch `cyd-redesign`)

Mirroring the React rebuild's look onto the physical touchscreen. The user supplied (in an
earlier, now-untracked pass) `firmware/tools/cyd_preview.html` -- a browser design reference, one
`<div>` per screen at real 320x240 size, same palette/icons the firmware now uses. **Open that
file directly in a browser before touching any of this** -- it's the spec. It covers 16 screens;
this pass ports the 10 a *crew* member actually sees. The other 6 (a new on-device Flight Surgeon
workflow: crew list, alerts with hold-to-acknowledge, inbox with quick-reply) need their own new
protocol messages and backend wiring, not just a restyle -- deliberately scoped out, confirmed
with the user ("start with 1 [facelift], 2 [surgeon workflow] should be next").

- **New `firmware/astro_cyd/ui_kit.ino`**: the shared chrome every crew screen now uses --
  `drawHeader()`/`drawFooter()` (role dot, title/sub, a level chip, a laptop-online chip, uptime),
  `drawTile()` (the icon+label+sub+badge button every column uses), `drawPanel()`/`drawVital()`,
  and ~14 small icons (heart, bp, mood, sleep, target, wind, alert, nfc, card, logout, tick,
  exercise, symptoms) drawn with TFT_eSPI primitives (`drawArc`/`drawWedgeLine`/`fillTriangle`/
  `drawSmoothCircle`) on a 24-unit grid matching the mockup's own SVG icons -- no bitmaps, no
  custom font, same "TFT_eSPI's built-in fonts only" rule `screens.ino` always had.
- **A real cross-tab gotcha, caught by the compiler not guessed**: `screens.ino`'s own header
  comment already explained that Arduino auto-generates function prototypes near the top of the
  merged sketch, so a function in any tab can call one in another regardless of file order. That
  does **not** extend to `#define`s or `typedef`s -- they're plain textual substitution/aliasing,
  not functions, so they only exist from their own line onward in whatever order the tabs happen
  to concatenate in (alphabetical, after the primary file). The first compile failed with `U_BG`
  etc. "not declared" in `screens.ino` because `ui_kit.ino` (where they were first written) sorts
  after it. Fixed by moving every `#define U_*` color/layout constant and the `IconFn` typedef
  into `astro_cyd.ino` (the primary file, always first) -- same place `screens.ino`'s own comment
  already says shared *variables* have to live, for the identical reason, just a gap that comment
  didn't call out for macros/typedefs specifically. Keep this in mind adding any new shared
  `#define`/`typedef` here later.
- **Crew home now shows real per-indicator vitals, not just the overall level** -- the mockup's
  biggest visual payoff needed one small, additive backend change: `protocol.session()` gained
  two new optional fields, `role` and `today` (a compact
  `{indicator: {"v": "<display string>", "l": "<level>"}}` snapshot for heart_rate/
  blood_pressure/mood/sleep, whichever have a reading in the last 24h). Built by
  `sessions.py`'s new `_today_vitals_for_cyd()` -- not imported from `routes.py`'s own
  `_today_snapshot()` to avoid a circular import, so it's a small, deliberate duplication of that
  same last-24h/first-row-wins query, scoped to just these 4 indicators and pre-formatted into
  display strings (the firmware does zero value-shape parsing itself) -- same dual-shape handling
  (`sleep`/`mood` as a bare number from a physical tag/CYD tap, or a richer object from the web
  tabs' own POST routes) the frontend already had to add for the same reason, see this file's
  "sleep/mood readings showed raw JSON" entry. Both fields are optional/additive -- older firmware
  (or a test that doesn't pass them) still gets a valid message, see
  `test_protocol.py::test_session_role_and_today_are_optional_and_additive`.
- **SOS stays exactly where it's always been, functionally** -- a real safety control doesn't get
  to move around for a facelift. On the two "hub" screens (Idle, crew home) it's now a proper
  column tile (`drawSosTile()`), but on every single-task screen (mood/symptoms/reaction/breathe/
  workout) it's still the exact same small bottom-left corner button at the same rect
  (`drawSosButton()`), just restyled. Both set shared `sosX/Y/W/H` globals so `pointInSos()`/
  `checkSosButton()` -- unchanged logic -- always hit-test wherever it was actually drawn last,
  instead of one hardcoded position. The emergency screen's 3-second cancel-hold also gained a
  real-time filling progress bar (`drawCancelBar()`) -- it had *zero* visual feedback that holding
  was registering before this pass, a genuine pre-existing gap, not a regression.
- **Two real layout bugs caught by re-reading the code, not by running it** (no real board
  attached this session -- see "still unverified" below): the center vitals panel's width
  (`SESS_CW`) only subtracted the *left* column's width, not the right (Done/SOS) column's too --
  its second vitals column would have rendered directly under those tiles. And the Idle screen
  kept its old font-7 giant clock and a 33-character sentence sized for the *old* full-320px-wide
  layout, both of which now massively overflow the narrower content band left by the new NFC/SOS
  column -- shrunk the clock to font 4 and wrapped the sentence (`drawWrapped()`, already existed
  for the status screen's note). Also fixed a real labeling bug while in there: the crew-home
  header hardcoded "Crew" as the role subtitle regardless of who actually tapped in -- now shows
  `curRole` (the astronaut's real `role` column, newly carried by the session message above), so
  if the Flight Surgeon's card is tapped it reads "Flight surgeon", not "Crew" -- she still lands
  on this exact same generic screen in phase 1, a distinct surgeon home is phase 2's job.
- **Honest limit of this pass**: `arduino-cli compile` passes clean (33% flash / 15% RAM,
  unchanged from before this rewrite) and the full pytest suite passes (199/199, 3 new tests) --
  but nothing here has been flashed or seen on the real board yet. Some label widths (e.g. a
  32px-wide "Symptoms" tile label, or a vital tile's value string on a long reading) are sized by
  eye against the mockup's own pixel grid, not measured with `tft.textWidth()` the way the header
  chip already is -- plausible but not proven to fit without clipping on real hardware. Check this
  on the actual board (and ask before flashing it, per this file's own standing rule) before
  trusting the layout pixel-for-pixel.
- **Phase 2, not yet started**: the Flight Surgeon's own on-device screens (crew roster, alerts
  with hold-to-acknowledge, inbox with quick-reply) from the same `cyd_preview.html` reference.
  Needs new protocol messages (crew summaries and alerts/messages pushed to the CYD when a
  surgeon's session is active, an acknowledge-alert message and a send-quick-reply message back),
  new backend wiring in `sessions.py`/`comms.py`, and a real on-device list/scroll UI the current
  touch model doesn't have yet (today's screens are all fixed, non-scrolling layouts). Scoped,
  confirmed with the user, not yet built.

## Follow-up: Pico NFC taps "did nothing" (2026-11-11)

User reported scanning a real crew card on the Pico/PN532 reader produced no visible result.
Diagnosed in stages, each one ruling something real out before finding the actual bug:

- **The Pico/PN532 hardware itself was never the problem.** Listened directly to
  `/dev/ttyACM0`'s raw serial output (bypassing the backend entirely) while the user tapped --
  got a clean `{"type":"scan","uid":"2B:ED:20:54"}` instantly. Confirmed via `udevadm` that this
  port really is the Pico (`idVendor=2e8a`, `product=Pico`), and via `groups`/`ls -la` that file
  permissions (`uucp` group) weren't blocking it either.
- **`app.py` wasn't running at all at first** -- a real, simple cause: nothing was listening on
  either serial port, so of course nothing happened on tap. Started it.
- **The actual bug, found after that**: `app.py`'s `create_app()` wires the CYD's own bridge
  through an `on_message(msg)` closure that does two things -- `socketio.emit("serial_log", ...)`
  (what the Simulator panel's live log in the frontend displays, `SimulatorDock.jsx` via
  `frontend/src/lib/socket.js`'s `serialLogStore`) **and then** calls `handle_cyd_message(msg)` --
  but `PicoBridge` was wired straight to `handle_cyd_message` directly, skipping that wrapper
  entirely: `pico_bridge = PicoBridge(on_message=handle_cyd_message)`. A Pico tap was very likely
  **silently working all along** -- starting a real session, updating the CYD, broadcasting
  `session_started` -- just never echoed to `serial_log`, which is almost certainly the live feed
  the user was actually watching to confirm it did something. **Fixed**: `pico_bridge =
  PicoBridge(on_message=on_message)` -- same wrapper the CYD bridge already uses, so a Pico scan
  now shows up in that log exactly like a CYD-originated one does.
- **Verified live, twice** (before and after the fix) with a real `python-socketio` client
  watching the actual running server's events while the user tapped a real card: before the fix,
  a tap produced zero `serial_log`/`scan`/`session_started` events even though the session really
  was active; after the fix, the same tap produced the full expected sequence --
  `serial_log` (in: scan) -> `scan` -> `serial_log` (out: session, now carrying the phase-1
  `role`/`today` fields above) -> `session_started` -- and a second tap correctly ended it
  (`end_session` -> `session_ended` -> `logout_requested`). 199/199 tests still passing (no test
  covers `app.py`'s own wiring, which is how this shipped unnoticed in the first place).

## Follow-up: Pico stopped working after moving it to a breadboard (2026-11-11)

Same day, same reader, new symptom: after the fix above, the user moved the PN532 wiring onto a
breadboard (unplugging/replugging the Pico to do it) and the reader "stopped working" again.

- **The hardware was fine again** -- confirmed the same way as the first pass, listening to
  `/dev/ttyACM0` directly: a real tap produced a clean scan twice in a row on the new breadboard
  wiring. Not a wiring regression.
- **The actual bug**: `backend/hardware/pico_bridge.py`'s `PicoBridge.__init__` only ever called
  `find_port()` **once**, at construction. `start()` then bailed out immediately (`if not
  self.port: return`) without starting the read thread at all if no Pico was present at that exact
  moment -- so a board that appears *after* the server has already started (exactly what
  unplugging it to rewire on a breadboard does) is never found for that process's entire
  lifetime, no matter how long it keeps running. The already-running server the user was testing
  against had started before the breadboard move, so this was a structurally different bug from
  the wiring-callback one above, not the same bug resurfacing.
- **Fixed**: `start()` now always launches the read thread, and `_read_loop()` calls `find_port()`
  on every reconnect attempt (every `RECONNECT_S`, currently 3s) rather than once -- so plugging a
  Pico in at any point after the server starts is picked up within a few seconds, no restart
  needed. An explicitly-forced `port=` (nothing passes one today, kept for parity with
  `SerialBridge`/tests) still skips auto-detection entirely, same as before.
- 2 new tests in `tests/test_pico_bridge.py`: one proves a port that only becomes available after
  `start()` is still found (mocks `find_port`/`serial.Serial`, no real hardware or sleep-waiting
  needed since `RECONNECT_S` is monkeypatched down); the other proves an explicit `port=` is never
  overridden by `find_port()` (which asserts it's never even called). 201/201 total passing.
  Restarted the user's real server with the fix; confirmed via `/proc/<pid>/fd` that it now holds
  both `/dev/ttyUSB0` (CYD) and `/dev/ttyACM0` (Pico) open, where before the fix it only had the
  CYD's.

## CYD redesign, phase 2: the Flight Surgeon's own on-device screens (2026-11-11)

The deferred half of the facelift above -- confirmed with the user to start right after phase 1
("2 should be next"). Covers `cyd_preview.html`'s remaining 6 screens: surgeon home (crew roster +
Alerts/Inbox tiles), crew detail, alerts with hold-to-acknowledge, and inbox with quick-reply. Her
card still starts a session exactly like any crew member's -- `screens.ino`'s new `homeScreenEnum()`/
`goHome()` are the one place that now decides crew-home vs. surgeon-home (by `curRole`), replacing
every hand-written `curUid.length() ? SCR_SESSION : SCR_IDLE` ternary that used to be scattered
across `onExerciseMsg`/`onEmergencyMsg`/`checkSosButton`'s cancel-hold/etc.

- **New protocol messages** (`backend/hardware/protocol.py` / `firmware/astro_cyd/protocol.ino`):
  laptop -> CYD `crew_list`/`alerts_list`/`inbox_list` (pushed together right after her `session`
  message, and again every background tick -- see `sessions.refresh_surgeon_cyd()`, hooked into
  `app.py`'s existing `background_loop()` right alongside `check_timeouts()`) and `crew_detail`
  (a request/response reply to a new CYD -> laptop `view_crew`); CYD -> laptop `ack_alert` and
  `quick_reply`. All four laptop -> CYD lists/detail are built by new functions in
  `backend/logic/sessions.py` (`crew_list_for_cyd`/`alerts_list_for_cyd`/`inbox_for_cyd`/
  `crew_detail_for_cyd`), each capped (4 crew, 3 alerts, 1 inbox item) so the encoded line can
  never grow past the firmware's 512-byte buffer regardless of how large the crew/alert backlog
  gets -- a hackathon crew is a handful of people, not hundreds, so simple caps beat pagination
  here. `_today_vitals_for_cyd()` (phase 1) gained a fifth indicator, `temperature`, reused by
  `crew_detail_for_cyd` for the Crew Detail screen's 4 vital tiles (HR/BP/Temp/Sleep, vs. crew
  home's own HR/BP/Mood/Sleep -- different sets, same underlying helper).
- **`ack_alert`/`quick_reply` reuse the exact same DB writes and Socket.IO events the existing
  HTTP routes already use** (`POST /alerts/<id>/ack`, `POST /messages`) -- confirmed by reading
  those routes first, not reimplemented: `routes.py`'s new `_ack_alert_from_cyd()`/
  `_quick_reply_from_cyd()` are thin wrappers in the same `handle_cyd_message()` closure, so a
  surgeon's physical gesture and a browser click land in identical rows/broadcasts either way.
  One correctness quirk confirmed by reading `comms.py` directly before assuming: the `messages`
  table's `read` column doesn't mean "surgeon has seen this" at all -- it means "delivered" (the
  background sweep flips it once `deliver_at` has passed), so there's no existing concept of
  marking a crew report "handled." `inbox_for_cyd()` therefore just shows the single latest
  *delivered* crew report regardless of whether it's been replied to, matching the mockup's own
  one-report-at-a-time Inbox screen -- a scrollable history is future scope, not this pass's.
- **A real correctness fix, caught by reasoning about the periodic refresh, not by running it**:
  the Alerts screen's hold-to-acknowledge gesture originally read *which* alert to acknowledge
  from `selectedAlert`'s array index only once the 2-second hold completed -- but
  `refresh_surgeon_cyd()`'s own background tick could land mid-hold and shift the array (e.g. if
  someone else acknowledges a different alert from the web UI in those 2 seconds), making that
  index point at a different alert by the time the hold finishes. Fixed by capturing the alert's
  real id (`holdingAlertId`) the moment the hold *starts*, and looking it back up by id (not by
  index) for the optimistic local removal once it completes.
- **Every new on-device list is a fixed-size C array** (`CREW_MAX=4`, `ALERTS_MAX=3`, one inbox
  item), matching this firmware's existing style (`reactionTimes[REACTION_TRIALS]` etc.) --
  no dynamic allocation, no scrolling touch model needed since everything fits on screen at once.
  The Alerts screen reserves all `ALERTS_MAX` row slots even when fewer are open, so the
  acknowledge-hold bar below them never shifts position between redraws.
- **New icons** (`ui_kit.ino`): `iconCrew` (two small head-and-shoulders), `iconMessage` (a chat
  bubble, used for the Inbox tile and report card), `iconBack` (a chevron, every sub-screen's
  Back tile), `iconSend` (a paper plane, the quick-reply buttons), `iconTemp` (a thermometer, the
  Crew Detail screen's 4th vital tile) -- same 24-unit-grid/TFT-primitive style as phase 1's set,
  no bitmaps. `drawCancelBar()` (the emergency screen's cancel-hold) was generalized into a
  reusable `drawHoldBar(x,y,w,h,frac,label)` so the Alerts screen's acknowledge-hold could reuse
  the exact same fill/flip-text-color logic instead of a second copy.
- **Honest limit of this pass, same as phase 1**: `arduino-cli compile` passes clean (33% flash,
  unchanged from phase 1 / 15% RAM) and the full pytest suite passes (213/213, 20 new backend
  tests across `test_sessions.py`/`test_protocol.py`/`test_api.py`) -- but none of these four new
  screens have been seen on the real board yet, only reasoned through carefully (including the
  race-condition fix above, found by re-reading the periodic-refresh interaction, not by
  reproducing it live). Check this on the actual board (and ask before flashing, per this file's
  own standing rule) before trusting the layout/touch targets pixel-for-pixel -- same caveat
  phase 1 had on its first pass, which did turn up two real layout bugs once reasoned through
  carefully a second time.

## Follow-up: the surgeon home screen was blinking (2026-11-11)

User tapped the Flight Surgeon's card right after phase 2 was flashed and reported the screen
blinking. Confirmed directly by watching the live server's outgoing serial traffic (a real
Socket.IO client, same pattern as every other live-verify pass in this file): `crew_list`/
`alerts_list`/`inbox_list` were going out **every single background tick (2s), with byte-for-byte
identical content each time** -- `refresh_surgeon_cyd()` resent unconditionally by design (a
deliberate "simplicity over diffing" call made when phase 2 was built, see that entry above --
this is the one place that call turned out to be a real, user-visible bug, not just a
micro-optimization skipped).

- **Two compounding causes, both fixed**: (1) the backend resent the same three messages every
  tick regardless of whether anything had changed, and (2) each of those three messages
  independently triggered a *full* `drawSurgeonHomeScreen()` redraw on the firmware side --
  together, the home screen was fully clearing and repainting itself **three times every two
  seconds**, which is exactly what "blinking" looks like.
- **Fixed (1)**: `sessions.py`'s `send_surgeon_payload()` gained a `force` parameter and now
  diffs against a new `_last_surgeon_payload_sent` cache -- `refresh_surgeon_cyd()`'s periodic
  call (`force=False`, the default) is a no-op unless the crew roster, alerts, or inbox actually
  changed since the last send; `_start_session()`'s call (`force=True`) still always sends,
  since the CYD's screen was just wiped to a fresh session and needs the data again even if it's
  identical to whatever was last pushed. New tests prove both halves:
  `test_refresh_surgeon_cyd_skips_unchanged_payload` (unchanged -> nothing sent; a real new alert
  -> sent again) and `test_surgeon_payload_is_resent_on_a_fresh_session_even_if_unchanged`
  (tap out, tap back in with identical data -> still sent).
- **Fixed (2)**: `crew_list`/`alerts_list`/`inbox_list` always arrive together, in that order
  (`send_surgeon_payload()`'s own send sequence) -- `screens.ino`'s `onCrewListMsg()` and
  `onAlertsListMsg()` no longer redraw the home screen at all; only `onInboxListMsg()` (the last
  of the three) does, so one update now means exactly one redraw instead of three. Each message
  still redraws its own standalone sub-screen when she's actually on it (Alerts/Inbox), unaffected
  by this change.
- `reset_sessions_state` (the autouse test fixture in `tests/conftest.py`) now also resets
  `sessions._last_surgeon_payload_sent` between tests, same as every other piece of this module's
  in-memory state -- missing this would have let one test's cached payload silently suppress
  another test's assertions. `arduino-cli compile` still clean (33%/15%, unchanged), 215/215
  tests passing (2 new). Flashed and the server restarted with this fix; not yet re-confirmed
  visually on the real board that the blinking actually stopped -- ask the user to check next.

## Follow-up: the surgeon home screen said "No crew assigned yet" (2026-11-11)

Right after the blinking fix above, the user tapped the Flight Surgeon's real card and the CYD
showed an empty roster, despite the backend clearly having two real crew members. Diagnosed by
simulating her exact tap from the backend (`POST /api/simulate/scan {"uid":"D1000001"}`) and
watching the real outgoing serial traffic -- **nothing went out at all**, not even a `session`
message. So this was never a phase 1/2 bug, crew_list parsing bug, or redraw-timing bug (all of
which were ruled out first, including writing a standalone g++ program against the real
ArduinoJson library to confirm the array-of-objects parsing logic itself was correct).

- **Root cause, pre-existing, just never hit until now**: `backend/seed.py` registers the Flight
  Surgeon's own NFC card as tag **`type="surgeon"`** (`SURGEON = {... "uid": "D1000001" ...}`,
  `_insert_tag(conn, SURGEON["uid"], "surgeon", ...)`) -- a holdover from *before* real login
  existed, when tapping it just unlocked a timed PIN-replacement window
  (`surgeon_unlocked_until`), not a session. `handle_scan()`'s dispatch still special-cases
  `tag["type"] == "surgeon"` into `_handle_surgeon_tag()`, which -- confirmed by reading it --
  sets that legacy timer and emits one vestigial web-only event, **and calls `send_fn` zero
  times**. So tapping her card has *never* been able to start a real CYD session at all, in any
  phase of this redesign or before it -- it just silently did nothing on the board, which is
  also exactly why this went unnoticed until phase 2 made her tap actually matter for the first
  time (nothing on-screen ever depended on her having a session before this).
  `POST /api/auth/nfc_login` (the *web* login) was unaffected the whole time -- it does its own
  separate tag lookup, keyed only on having a linked `astronaut_id`, never branching on tag type.
- **Fixed** in `handle_scan()`: a `surgeon`-type tag that *does* have a real `astronaut_id` now
  also routes to `_handle_astronaut_tag()` (the real session toggle), exactly like an
  `astronaut`-type tag -- only a `surgeon` tag with no linked astronaut (the legacy, account-less
  unlock-only case, which is all `tests/conftest.py`'s `seed_minimal()` fixture ever seeds) still
  falls through to the old vestigial path. No `seed.py`/DB migration needed -- her tag can stay
  exactly as seeded; the dispatch logic is what changed.
- **A real gap in this session's own test coverage, not just the app's**: every phase-2 test's
  own `_seed_surgeon_and_crew()` fixture (`tests/test_sessions.py`) had seeded its test surgeon's
  tag as `type="astronaut"` instead of matching real `seed.py`'s `type="surgeon"` -- which is
  exactly why 20+ passing tests never caught this. Fixed the fixture to use `"surgeon"` (matching
  production exactly), and all those same tests still pass -- proving the dispatch fix, not just
  asserting it.
- **Verified live end-to-end twice**: once showing zero output (reproducing the bug against the
  then-current code), once after the fix and a server restart showing the complete, correct
  sequence over the real serial port to the real board -- `session` (role "Flight surgeon") ->
  `led` -> `crew_list` (Ahmad + Sameer, not empty) -> `alerts_list` -> `inbox_list`. Backend-only
  fix, no firmware changes, no reflash needed -- just the server restart. 215/215 tests passing.

## Follow-up: crew still missing on login, fixed by narrowing what the earlier fixes assumed (2026-11-11)

Even after the previous two follow-ups, the user reported the surgeon home screen still showed
"No crew assigned yet" right after tapping in -- but pressing Alerts, then Back, correctly showed
the real roster. That gap (automatic update wrong, manual redraw right) pointed at the redraw
*trigger*, not the data.

- **Root cause**: the earlier anti-blink fix (see above) made the home screen's redraw fire from
  exactly one message, `inbox_list` (the last of the three `send_surgeon_payload()` sends), on the
  reasoning that crew_list/alerts_list/inbox_list always arrive together. That's true -- but this
  project's USB-serial link is *documented* (see "USB serial reliability" above) to sometimes
  corrupt or drop a line in a fast back-to-back burst, and a burst of three messages sent with no
  delay between them (`send_surgeon_payload()`) is exactly the shape that triggers it. If
  `inbox_list` specifically was the one dropped, `crew_list`'s own data still landed and populated
  `crewCount` correctly -- but nothing was left to trigger the screen to actually show it, so it
  sat there correct-but-invisible until a manual navigation (which redraws directly from whatever
  state is currently in memory, not from a specific message having arrived) finally displayed it.
- **Fixed, firmware side**: `screens.ino`'s `onCrewListMsg()`/`onAlertsListMsg()`/
  `onInboxListMsg()` now *all* call a new `redrawSurgeonHomeThrottled()` when on the surgeon home
  screen -- whichever of the three happens to arrive (and survive the link) triggers the redraw,
  with a 150ms throttle so a clean, undropped batch still only repaints once, not three times
  (preserving the anti-blink fix's actual goal without re-depending on one specific message).
- **Fixed, backend side -- reverting the previous fix, not layering on it**: the diff-cache added
  by the blinking follow-up (skip resending `crew_list`/`alerts_list`/`inbox_list` if identical to
  last time) is now a strictly worse tradeoff than it looked at the time: it tracks what was
  *sent*, not what was actually *received*, so a dropped line during a send that then looked
  "unchanged" to the cache would never get retried -- the CYD could stay stuck on stale/incomplete
  data indefinitely. Now that the firmware throttle above solves the actual blinking
  independently, `send_surgeon_payload()` went back to always sending unconditionally every tick
  (`force` parameter and `_last_surgeon_payload_sent` cache both removed) -- which makes the
  periodic refresh **self-healing**: any single dropped line gets corrected automatically on the
  very next tick, a couple of seconds later, with no cache to invalidate first. Net effect: the
  anti-blink fix now lives entirely on the firmware side (where the actual redraw happens),
  and the backend is simpler than either earlier pass, not just reverted to it.
- **A real gap in the previous follow-up's own tests, caught while fixing this one**: the earlier
  diff-cache tests (`test_refresh_surgeon_cyd_skips_unchanged_payload`,
  `test_surgeon_payload_is_resent_on_a_fresh_session_even_if_unchanged`) asserted the *caching*
  behavior directly, so they had to be replaced, not just left passing accidentally -- updated to
  `test_refresh_surgeon_cyd_resends_every_tick_even_if_unchanged`, which now asserts the opposite
  (and correct) contract. 215/215 total passing. Flashed (firmware changed this time, unlike the
  previous follow-up) and the server restarted; verify on the real board next.

## Follow-up: still blinking, and alert/inbox badge counts stayed stale (2026-11-11)

The previous follow-up's fix (any of the three messages can trigger the redraw, throttled to one
per ~150ms) turned out to be wrong in a different way, caught from the user's own next report:
the screen kept blinking, *and* the Alerts/Inbox tile badge counts on the surgeon-home screen
stayed stale until navigating into Alerts and back -- the exact same symptom shape as the "no
crew" bug, just for a different pair of fields.

- **Why the throttle-based fix was still wrong**: letting *whichever* message arrives *first*
  trigger an immediate redraw means that redraw uses fresh data for the message that triggered it,
  but stale data for whichever of the other two hadn't arrived *yet* (they're still a few
  milliseconds away on the wire) -- e.g. `crew_list` lands, triggers the redraw instantly with the
  correct roster, but `alerts_list`/`inbox_list` haven't been parsed yet, so the badges on that
  same redraw show old counts. The later two messages' own redraws were then suppressed by the
  150ms throttle, so nothing ever corrected it until a manual navigation forced a fresh paint from
  whatever had *since* arrived.
- **Why it was still blinking**: separately, now that `send_surgeon_payload()` always resends
  unconditionally every ~2s (the previous follow-up's fix, for self-healing against a dropped
  line), *some* redraw was firing every single tick regardless of whether the content had actually
  changed -- and any full-screen redraw starts with `clearScreen()` (a full black fill), which
  looks like a blink even when it only happens once per cycle, not three times.
- **Fixed properly this time -- debounce *and* diff, not either alone**: each message
  (`onCrewListMsg`/`onAlertsListMsg`/`onInboxListMsg`) now just calls `markSurgeonHomeDirty()`,
  which sets a dirty flag and (re-)arms an 80ms timer -- it does **not** draw anything itself. A
  new `checkSurgeonHomeRedraw()`, polled every `loop()` alongside `checkSosButton()`/
  `checkAckHold()`, only fires once the burst has gone quiet for those 80ms, guaranteeing whichever
  of the three messages actually arrived by then are *all* reflected in the one resulting redraw --
  fixing the stale-badge bug. It then also skips the redraw entirely unless the content is actually
  different from what's already on screen, via a new `surgeonHomeSignature()` (a compact string of
  crew roster + alert ids + inbox state) compared against `lastDrawnSurgeonHomeSignature` (set at
  the end of `drawSurgeonHomeScreen()` itself, so every real draw -- automatic or a manual
  Back-navigation -- keeps the cache honest) -- fixing the blinking, independent of how often the
  backend resends. The backend keeps resending unconditionally every tick (self-healing against a
  dropped line, per the previous follow-up); the firmware is now what decides whether that's
  actually worth a visible repaint.
- Each message still redraws its own standalone sub-screen immediately when she's actually on it
  (Alerts/Inbox), unaffected by any of this -- only the surgeon*-home* screen's redraw went through
  three different designs this session before landing on the right one. `arduino-cli compile`
  still clean (34%/15%, +1 sketch-size percentage point from the new signature-diff code), 215/215
  backend tests unaffected (this pass is firmware-only). Flashed; verify on the real board next.

## Follow-up: a replied-to inbox report kept reappearing, and the Alerts/Inbox screens themselves still blinked (2026-11-11)

First real end-to-end walkthrough of all three surgeon sub-screens on the real board (Crew Detail,
Alerts hold-to-acknowledge, Inbox quick-reply) turned up two more bugs, both different from every
earlier follow-up in this run -- these two are about the Alerts/Inbox screens *themselves*, not the
home screen.

- **Bug 1 -- a report the surgeon just replied to from the CYD disappeared, then came back.**
  Root cause: `messages.read` doesn't mean "handled" (see the phase-2 entry's own note on this) --
  there's no column anywhere recording "a reply was sent for this report", so `inbox_for_cyd()`
  kept returning the *same* crew report as "the latest crew message" even after a reply went out
  (the reply itself is a separate `from_role='surgeon'` row, filtered out of this function's own
  query). The CYD's optimistic local clear (`inboxTouch()`, phase 2) made it vanish for a moment;
  the very next periodic refresh (`refresh_surgeon_cyd()`, ~2s later) then resent the unchanged
  original report and brought it right back. **Fixed**: `inbox_for_cyd()` now also checks whether
  a surgeon-origin message to the same astronaut exists with a *later* `sent_at` than the crew
  report -- if so, it's considered replied-to and excluded, no schema change needed. This also
  means a web-UI reply (`POST /messages`) now correctly clears the CYD's Inbox too, not just a
  CYD-originated quick-reply -- one consistent "handled" rule regardless of which interface
  replied. New test: `test_inbox_for_cyd_hides_a_report_already_replied_to` (replied -> hidden; a
  *later* new report after the reply -> still shown).
- **Bug 2 -- the Alerts and Inbox screens themselves still blinked.** The debounce-and-diff fix a
  few follow-ups up only ever covered the surgeon-*home* screen's own redraw
  (`checkSurgeonHomeRedraw()`) -- `onAlertsListMsg()`/`onInboxListMsg()` still redrew their own
  sub-screen *unconditionally* every single time a message arrived, i.e. every ~2s the surgeon
  sat on either screen, regardless of whether anything had actually changed. **Fixed**: two new,
  simpler signatures (`alertsSignature()`/`inboxSignature()` -- no debounce needed here, since
  `alerts_list` is the only message affecting the first and `inbox_list` the only one affecting
  the second, unlike the home screen's three-way dependency) gate `onAlertsListMsg()`/
  `onInboxListMsg()`'s redraws the same way `checkSurgeonHomeRedraw()` already gates the home
  screen's -- cached at the end of `drawAlertsScreen()`/`drawInboxScreen()` themselves, same
  pattern, so a manual navigation (selecting a row, the ack-hold's own redraw) keeps the cache
  honest too.
  216/216 tests passing (`arduino-cli compile` 34%/15%, unchanged). Flashed; verify on the real
  board next.

## Testing

- `.venv/bin/python -m pytest` — 216 tests (rules engine, protocol, sessions, REST API, symptoms,
  login/access control, consult, voice, scheduler, SPA serving, CYD logout).
- `cd frontend && npm test` — 29 Vitest tests (format, trends stats, alert feed, report text);
  `npm run lint` must stay clean; `npm run build` then commit `frontend/dist`.
- `.venv/bin/python app.py --simulate` then exercise the feature at `http://localhost:5000`
  (the Simulator drives every CYD event through the same code path a real tap would).
- Kill any backgrounded dev server you start for screenshots/recording afterward, don't leave
  it running between tasks. Never point tests at the user's live `data/astro.db`.
- Ask before flashing firmware to a real board, same as Lifeline.

## Status (2026-11-11)

- Branch `cyd-redesign` (currently checked out, branched from `ui-redesign`'s tip, identical
  history otherwise) holds both CYD redesign phases above -- `firmware/astro_cyd/ui_kit.ino` new,
  `screens.ino`/`astro_cyd.ino`/`protocol.ino` edited, `backend/hardware/protocol.py`,
  `backend/logic/sessions.py`, `backend/routes/routes.py`'s `handle_cyd_message`, `app.py`'s
  background loop, `backend/hardware/pico_bridge.py` (the two Pico-reconnect-detection fixes
  below), plus `tests/test_protocol.py`/`tests/test_sessions.py`/`tests/test_api.py`/
  `tests/test_pico_bridge.py` (new) -- all **uncommitted**. `firmware/tools/cyd_preview.html`
  (the design reference) is untracked. Phase 2's four new screens are compile-checked and
  pytest-covered but **not yet flashed/seen on real hardware** -- see that section's own note.
- Branch `ui-redesign` holds the whole React rebuild (crew pages, Flight Surgeon screens,
  /admin, glass theme, sidebar, Schedule, Trends analytics, rewards removal, session fixes),
  committed but **not pushed** and **not merged into master** yet — check `git log` /
  `git status` before assuming more.
- `firmware/astro_cyd` was flashed twice on 2026-11-11 (end_session reason; then idle_s from
  the laptop + "active" pings + no points header); boot + `hello` confirmed both times.
- `data/nvidia_api_key` holds a real key and is gitignored, not tracked at all.
