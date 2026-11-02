# Astro Health Station — Claude Code Build Prompt

Oct 28, 2026 · @Hassan

## 1. Your role and the goal

You are building a complete, demo-ready hackathon project for the NASA Space Apps Challenge: **Astro Health Station**, a tool that helps astronauts check their own health during a space mission and tells them what to do next.

It has two parts that work together:

- A **web app on a laptop**: Flask backend and plain JavaScript frontend.
- A **CYD (ESP32 "Cheap Yellow Display") with an NFC reader**, connected to the laptop by USB. Astronauts tap NFC cards and tags on it and use its touchscreen.

The official challenge resources are not published yet, so **use fake data everywhere**. Put every threshold, piece of health text and mission number in config files marked `PLACEHOLDER`, so we can swap in real NASA data later without touching the code.

**How to work**

1. Read this whole prompt first, then write a short plan before coding.
2. Build in the phases from section 14. After each phase, run the app and the tests, fix problems, then continue.
3. Keep the code simple and well commented. We are a student team and need to understand and present it.
4. Don't ask questions unless you are truly blocked. Make a sensible choice and note it in the README.
5. If our existing CYD sketch is in `firmware/existing/`, read it first and reuse its NFC and display setup.
6. At the end, give us a short summary of how to run everything and how to do the demo.

## 2. Challenge background

The challenge: create a visual tool that helps astronauts assess their own health during space missions and gives guidance on treatment and health improvement.

- NASA's Human Research Program names **five hazards of spaceflight**: space radiation, isolation and confinement, distance from Earth, gravity fields (including microgravity), and hostile closed environments.
- These can cause immune system changes, bone density loss, heart and blood vessel problems, poor nutrition, sleep problems and behavioral health issues.
- Useful indicators: **blood pressure, heart rate, blood sugar, body temperature, daily sleep hours and mood**.
- For each indicator the tool should answer: Can it be measured in space? Why does it matter? How do the hazards affect it? When should the crew or the flight surgeons on Earth be alerted? What can prevent a problem?
- The judges care about **clear UI**: color coding, charts over time, animations, gamification, a clickable human body figure, and simple explanations, because astronauts are not doctors.
- Environments to support: spacecraft, space station, rover, and a base on the Moon or Mars.

## 3. Hardware we have

- **CYD (ESP32-2432S028R)**: ESP32, 2.8 inch 320x240 ILI9341 display, XPT2046 resistive touch, built-in RGB LED, speaker connector, microSD slot, USB serial through a CH340 chip.
- **NFC reader**, already wired to the CYD and working. Each card or tag has a unique UID. Our current sketch maps UIDs to names.
- **NFC cards and tags**: astronaut cards, plus extra tags we will stick on "habitat" objects.
- **A laptop** (Windows, macOS or Linux) that runs the web app.
- **No other sensors.** Vitals are typed in on the laptop or entered on the CYD touchscreen.

**Firmware notes**

- Don't assume which NFC module we use. Put all NFC code behind one function, `bool readCardUid(String &uid)`, and support **PN532** and **MFRC522** with a `#define NFC_MODULE` switch. If `firmware/existing/` exists, copy our working NFC setup from it.
- Check the CYD pins against our existing sketch and the community CYD docs (the `witnessmenow/ESP32-Cheap-Yellow-Display` repo). Common values: RGB LED on GPIO 4 (red), 16 (green), 17 (blue), active LOW; speaker on GPIO 26; backlight on GPIO 21; touch on its own SPI bus (CS 33, IRQ 36, MOSI 32, MISO 39, CLK 25).
- The speaker and SD card are optional. Everything must still work without them.

## 4. Tech stack (use exactly this)

| Part | Use | Notes |
| --- | --- | --- |
| Backend | Python 3.10+, **Flask** | One app that runs on the laptop |
| Live updates | **Flask-SocketIO** + `simple-websocket` | `async_mode="threading"`, no eventlet or gevent |
| CYD link | **pyserial** | A background thread reads and writes the USB port |
| Database | **SQLite** (`sqlite3` from the standard library) | One file: `data/astro.db` |
| Frontend | Plain **HTML, CSS and JavaScript** | No React, Vue, Tailwind or build step |
| Charts | **Chart.js** | Downloaded into `static/vendor/` |
| Live client | **Socket.IO client** | Downloaded into `static/vendor/`, version compatible with Flask-SocketIO |
| Body figure | Hand-made **SVG** | Each body part is a clickable shape |
| Firmware | **Arduino IDE**, C++ | TFT\_eSPI, XPT2046\_Touchscreen, ArduinoJson v7, plus our NFC library |
| Tests | **pytest** | Rules engine, protocol parser, sessions, API |

**Rules**

- **It must run fully offline.** No CDNs at runtime, no cloud services, no external APIs. A spacecraft can't rely on the internet, and venue WiFi is unreliable.
- Pin versions in `requirements.txt`. Setup must be just `pip install -r requirements.txt`, then `python app.py`.

## 5. Architecture

```text
NFC card or tag --tap--> CYD (ESP32 + touchscreen)
                            |  USB serial, 115200 baud, JSON lines
                            v
                  Flask backend on the laptop
                   +- serial bridge thread (read + write)
                   +- rules engine, scheduler, comms delay, gamification
                   +- SQLite database
                   +- Socket.IO + REST API
                            |
                            v
      Browser dashboards (laptop, plus phones on the same network)
```

- **Flask owns the USB port.** The browser never uses Web Serial, so the dashboard works in any browser and on other devices, for example a phone for the flight surgeon. Run on `0.0.0.0:5000`.
- **The laptop is the source of truth.** The CYD only sends raw events (card UIDs, touch results) and shows what the laptop tells it. The tag registry, meaning which UID is which astronaut or object, lives in the database.
- **Serial port auto-detect**: pick a port whose description matches CH340, CP210x or "USB Serial". Allow an override: `python app.py --port COM5` or the env var `ASTRO_PORT`. If the port drops, retry every 3 seconds and show the status in the UI.
- **Simulation mode is required.** If no CYD is found, or `--simulate` is passed, the app still runs fully. A Simulator panel in the UI fakes every tag tap and CYD event through the same code path as real serial messages. This is our backup if the hardware fails during the demo.
- **Demo speed-up**: one setting, `TIME_SCALE` (for example 60), makes reminders, comms delays and sleep durations run faster for a live demo.

## 6. Serial protocol (CYD and laptop)

One JSON object per line, ending with a newline, at most 512 bytes. Ignore lines that are not valid JSON, because the firmware may print debug text. Use ArduinoJson on the CYD. Example: `{"type":"scan","uid":"A1000002"}`.

**CYD to laptop**

| `type` | Extra fields | When |
| --- | --- | --- |
| `hello` | `fw` | On boot |
| `scan` | `uid` | Any NFC card or tag is tapped |
| `mood` | `uid`, `value` (1 to 5) | Mood screen submitted |
| `symptoms` | `uid`, `items` (list) | Symptom checklist submitted |
| `reaction` | `uid`, `trials_ms` (list), `avg_ms`, `lapses`, `false_starts` | Reaction test finished |
| `breathing_done` | `uid`, `seconds` | Breathing exercise finished |
| `emergency` | `uid` (may be empty) | SOS button held on the CYD |
| `cancel_emergency` | none | Long press to cancel |
| `end_session` | `uid` | Astronaut taps Done, or the session times out |
| `pong` | none | Reply to `ping` |
| `log` | `msg` | Debug text |

**Laptop to CYD**

| `type` | Extra fields | What the CYD does |
| --- | --- | --- |
| `session` | `name`, `uid`, `level`, `points` | Opens the astronaut menu |
| `status` | `name`, `level`, `note` | Shows the result screen |
| `toast` | `text`, `level` | Shows a short message for 3 s, e.g. "Meal logged: 450 kcal" |
| `unknown_tag` | `uid` | "New tag. Assign it on the laptop." |
| `exercise` | `event` (start or stop), `minutes` | Shows or stops the workout timer |
| `sleep` | `event` (start or stop), `hours` | Shows "Good night" or "Slept 6.5 h" |
| `reminder` | `text` | Beeps, blinks the LED, shows the reminder |
| `alert` | `level`, `text` | Yellow or red alert screen with beeps |
| `emergency` | `active` (true or false), `text` | Turns full emergency mode on or off |
| `led` | `color` (GREEN, YELLOW, RED or OFF) | Sets the RGB LED |
| `idle` | none | Back to "Tap your card" |
| `ping` | none | Replies with `pong`; the laptop sends it every 5 s to know the CYD is alive |

`level` is always `GREEN`, `YELLOW` or `RED`. Keep the protocol in one Python module and one firmware file, and unit test the Python parser.

## 7. Fake data to seed

`backend/seed.py` creates all of this, and a "Reset demo data" button in the UI runs it again. All names, UIDs and numbers are invented.

**Crew: 4 astronauts and 1 flight surgeon**

| Name | Role | Card UID | Story in the 30-day history |
| --- | --- | --- | --- |
| Lina Haddad | Commander | `A1000001` | Healthy and steady, most points |
| Omar Saleh | Flight engineer | `A1000002` | Sleep drops to about 5 h in the last week; reaction time gets slower |
| Maya Chen | Mission specialist | `A1000003` | Blood pressure slowly rising, now YELLOW |
| Alex Rivera | Medical officer | `A1000004` | Low mood in week 3, recovers after breathing sessions |
| Dr. Sara Nasser | Flight surgeon on Earth | `D1000001` | Unlocks the surgeon view |

**Object tags**

| Tag | UID | What a tap does |
| --- | --- | --- |
| Treadmill | `T2000001` | Starts or stops exercise (after an astronaut card) |
| Resistance machine | `T2000002` | Starts or stops exercise |
| Exercise bike | `T2000003` | Starts or stops exercise |
| Sleep station | `T3000001` | Starts or stops sleep and logs the hours |
| 6 food packets | `T4000001` to `T4000006` | Logs a meal with invented calories, protein, calcium and water |
| 3 medicine kit items | `T5000001` to `T5000003` | Logs a dose and sets the next reminder; generic names only ("Sleep aid", "Pain relief", "Motion sickness relief"), no real doses |
| Blood pressure cuff | `T6000001` | Opens the step-by-step "How to measure blood pressure" guide |
| Emergency card | `E9000001` | Starts emergency mode |

**History**: 30 days per astronaut, made with a fixed random seed so it is identical every time. Include vitals (twice a day), sleep, exercise minutes, meals and water, mood, symptoms, reaction tests and points. Follow the stories above so the charts show something worth explaining.

**Mission profiles** in `config/missions.json` (all values PLACEHOLDER):

| Profile | Gravity | One-way comms delay | Main concerns |
| --- | --- | --- | --- |
| Space station (low Earth orbit) | 0 g | about 0 s | Bone and muscle loss, sleep |
| Lunar base | 0.17 g | about 1.3 s | Radiation, dust, isolation |
| Mars transit | 0 g | 3 to 22 min (use 20) | Radiation, isolation, acting without help from Earth |
| Mars surface base | 0.38 g | 3 to 22 min (use 20) | Acting alone, radiation, adapting to gravity again |
| Rover excursion | same as its planet | same as its base | Effort, hydration, short check-ins |

Add a placeholder daily radiation dose per profile, clearly marked as fake.

**Config files** (all editable, all marked PLACEHOLDER)

- `config/health_rules.json`: thresholds per indicator
- `config/content.json`: plain-language text per indicator, body part and hazard
- `config/missions.json`: mission profiles
- `config/routine.json`: the daily schedule for reminders
- `config/gamification.json`: points per action and badge rules

## 8. Health rules engine

`backend/health_rules.py` reads `config/health_rules.json` and gives every reading a level: `GREEN` (normal), `YELLOW` (needs attention) or `RED` (act now).

**Starting thresholds** (PLACEHOLDER: general adult ranges, not mission rules)

| Indicator | Unit | GREEN | YELLOW | RED |
| --- | --- | --- | --- | --- |
| Heart rate (resting) | bpm | 60 to 100 | 50 to 59, or 101 to 120 | below 50 or above 120 |
| Blood pressure | mmHg | systolic 90 to 129 and diastolic 60 to 79 | systolic 130 to 139, diastolic 80 to 89, or systolic 85 to 89 | systolic 140+, diastolic 90+, or systolic below 85 |
| Blood sugar (fasting) | mg/dL | 70 to 99 | 100 to 179 | below 70 or 180+ |
| Body temperature | °C | 36.1 to 37.5 | 35.5 to 36.0, or 37.6 to 38.0 | below 35.5 or above 38.0 |
| Sleep | hours per night | 7+ | 6 to 6.9 | below 6 |
| Mood | 1 to 5 scale | 4 to 5 | 3 | 1 to 2 |
| Reaction time | average ms | within 10% of personal baseline | 10% to 25% slower | over 25% slower, or 3+ lapses |
| Exercise | minutes per day | 90+ | 45 to 89 | below 45 |
| Water | ml per day | 2000+ | 1500 to 1999 | below 1500 |

**Rules**

- **Overall level** = the worst level among today's indicators.
- **Trends**: if an indicator gets worse 3 days in a row, raise it one level even if today's value is normal. Show a small trend arrow (up, down, flat).
- **Symptoms**: any symptom = YELLOW. Blurry vision, chest pain or shortness of breath = RED.
- **Escalation**: YELLOW shows crew actions and logs it. RED also alerts every dashboard, shows the alert screen on the CYD, and sends an automatic report to the flight surgeon, delivered after the mission's comms delay.
- **Each result returns**: level, a one-line note for the CYD screen (at most 60 characters), what to do now, how to prevent it, when to call the flight surgeon, and which hazards affect it.
- Show a footer on every page: "Demo with placeholder data. Not medical advice."

**Mappings** (in config, not code)

- **Indicator to body part**: heart rate and blood pressure → heart; sleep, mood and reaction time → brain; bone loss risk (from exercise minutes and calcium intake) → skeleton; exercise → muscles; meals and water → stomach; temperature and symptoms → immune system (whole-body glow); blurry vision → eyes.
- **Hazard to indicators**: radiation → immune system, symptoms, and a long-term risk note; isolation and confinement → mood, sleep, reaction time; distance from Earth → how escalation works (comms delay); gravity fields → bones, muscles, blood pressure, eyes; hostile closed environment → sleep, temperature, immune system.

## 9. Laptop web app

One page with tabs at the top and no page reloads. Everything updates live through Socket.IO.

1. **Live** (default tab). Shows "Tap your card on the CYD" until a card is scanned. Then shows the astronaut's name, colored initials as an avatar, today's status, and a vitals form: heart rate, blood pressure, blood sugar, temperature. Sleep, mood, symptoms and reaction time fill in automatically from the CYD and tags. An **Assess** button shows a color card per indicator with the overall level and advice, saves it, and sends `status` and `led` to the CYD. A "How do I measure this?" link beside each field opens its guide.
2. **Body**. A clickable SVG human figure with regions: brain, eyes, heart, stomach, skeleton, muscles, and a whole-body glow for the immune system. Each region is colored by its current level and gently pulses when RED. Clicking a region opens a side panel: what it does, its current status, how space affects it (with hazard icons), what to do, and a small 7-day chart.
3. **Trends**. Chart.js line charts per indicator over 7 or 30 days, with green, yellow and red background bands taken from the thresholds. Bars for sleep and exercise. Reaction time against the astronaut's baseline. Choose the astronaut from a dropdown.
4. **Crew**. A card per astronaut: overall color, last check time, active alerts, points and streak. Clicking a card opens that astronaut in Live, Body and Trends.
5. **Flight surgeon** (unlocked by tapping the surgeon card, or demo PIN `1234`). Alert inbox, crew reports, and a reply box. Messages to and from Earth wait for the mission's comms delay (sped up by `TIME_SCALE`) with a visible countdown, e.g. "Reply arrives in 12:40". Meanwhile the crew sees "Earth can't answer yet. Follow these steps:" with a self-care checklist. This view must work well on a phone.
6. **Mission**. Choose the profile: station, Moon base, Mars transit, Mars base, rover. Shows gravity, comms delay, the placeholder radiation dose, and which hazards matter most. Changing it updates advice text, comms delay and reminders.
7. **Learn**. Simple step-by-step guides: how to take each measurement in space, what the numbers mean, the five hazards in plain words, and when to call for help. Short sentences, icons, one idea per card.
8. **Rewards**. Points per action, daily streaks, badges ("Bone Guardian": 7 days of full exercise; "Sleep Pro": 5 nights of 7+ h; "Calm Mind": 5 breathing sessions; "Data Hero": 14 days of complete checks), a friendly leaderboard and a team goal progress bar. A small celebration animation when points or a badge are earned.
9. **Schedule and reminders**. A daily routine from `config/routine.json`: morning vitals, exercise blocks, evening mood check, bedtime. The backend scheduler sends `reminder` to the CYD and shows a banner in the UI. Missed tasks turn yellow.
10. **Emergency mode**. Started by the emergency card or the CYD SOS button. Every dashboard shows a full-screen red overlay with a step checklist, the CYD flashes red and beeps, and a report goes to the flight surgeon. Cancel with a confirm button on the laptop or a 3-second press on the CYD.
11. **Admin**. The tag registry lists all tags. When an **unknown UID** is scanned, a popup offers to assign it to an astronaut or an object type; this is how our real NFC cards get connected. Also: edit astronaut names, Reset demo data, and export an astronaut's data as CSV ("Send to Earth").
12. **Simulator** (a collapsible panel on every tab). Buttons for each seeded card and tag, plus fake CYD events: mood, symptoms, reaction test (normal or slow), breathing done, emergency. It also shows the serial status (connected port or "Simulation") and a live log of messages in both directions.

## 10. CYD firmware

Folder `firmware/astro_cyd/`, split into tabs: `astro_cyd.ino` (setup and loop), `nfc.ino`, `protocol.ino`, `screens.ino`, `led_sound.ino`. Use TFT\_eSPI with simple shapes and built-in fonts: no images, no LVGL. Touch targets at least 44 px tall. Draw the mood faces with circles and arcs.

The loop must never block. No `delay()` longer than about 20 ms; use `millis()` timers so NFC, touch and serial all stay responsive.

**Screens**

1. **Idle**: "Tap your card", mission name, uptime clock, and a small "Laptop online / offline" dot. LED off.
2. **Session menu** (after `session` arrives): name, colored status banner, points, and buttons for Mood, Symptoms, Reaction test, Breathe and Done. After 2 minutes without a touch, send `end_session` and go back to Idle.
3. **Mood**: 5 big face buttons from very sad to very happy; sends `mood`.
4. **Symptoms**: 8 toggle buttons in a 2x4 grid (Headache, Nausea, Back pain, Blurry vision, Congestion, Fatigue, Chest pain, Short of breath) plus Send; sends `symptoms`.
5. **Reaction test** (inspired by NASA's reaction self-test, shortened for the demo): 10 trials. Wait a random 2 to 6 s, show a big circle, measure the time until the tap. A tap before the circle is a false start; over 500 ms is a lapse. Show the average, then send `reaction`.
6. **Breathe**: 60 seconds of box breathing (4 s in, 4 s hold, 4 s out, 4 s hold) with a growing and shrinking circle and text; sends `breathing_done`.
7. **Status**: big colored banner (ALL GOOD, CHECK or ALERT), name and note.
8. **Toast**: an overlay message for 3 s on top of any screen.
9. **Exercise timer**: a big mm:ss count-up while a workout is running.
10. **Alert and Emergency**: flashing red screen, "Emergency: help is coming", and "Hold 3 s to cancel".
11. **Unknown tag**: "New tag. Assign it on the laptop."
12. **SOS button**: a small red button in a corner of every screen; holding it for 2 s sends `emergency`.

**LED and sound**

- The LED follows the last status: green, yellow, red, or off when idle. It blinks for reminders and flashes red fast in emergency mode.
- If a speaker is connected: a short beep on each tap, two beeps for reminders, and a repeating alarm in emergency mode. Use a simple tone on the speaker pin.

**Touch and offline behavior**

- Put touch calibration constants at the top of the file, with short instructions for finding our values.
- If the laptop sends no `ping` for 10 s, show "Laptop offline". The astronaut can still do Mood, Symptoms, Reaction test and Breathe; queue those messages in RAM, and on the SD card if present (`/queue.jsonl`), and send them when the laptop is back.
- If an SD card is present, also append every event to `/log.csv`.

## 11. Project structure

```text
astro-health/
├── app.py                  starts Flask + Socket.IO; parses --port and --simulate
├── requirements.txt
├── README.md
├── backend/
│   ├── __init__.py
│   ├── config.py           loads config/*.json and TIME_SCALE
│   ├── db.py               schema and connection helper
│   ├── seed.py             all fake data
│   ├── serial_bridge.py    port detect, read/write thread, reconnect
│   ├── protocol.py         parse and build messages
│   ├── sessions.py         active astronaut and tag tap logic
│   ├── health_rules.py
│   ├── scheduler.py        reminders and delayed messages
│   ├── comms.py            Earth-to-crew delay
│   ├── gamification.py
│   ├── simulator.py
│   └── routes.py           REST API and Socket.IO events
├── config/
│   ├── health_rules.json
│   ├── content.json
│   ├── missions.json
│   ├── routine.json
│   └── gamification.json
├── data/                   astro.db, created on first run, git-ignored
├── templates/
│   └── index.html
├── static/
│   ├── css/style.css
│   ├── js/                 one file per tab, plus socket.js and strings.js
│   ├── img/body.svg
│   └── vendor/             chart.umd.min.js, socket.io.min.js
├── firmware/
│   ├── astro_cyd/          astro_cyd.ino and its tabs
│   ├── existing/           our current sketch, if we add it
│   └── README.md           libraries, TFT_eSPI setup for the CYD, upload steps
└── tests/
    ├── test_health_rules.py
    ├── test_protocol.py
    ├── test_sessions.py
    └── test_api.py
```

## 12. Backend logic, database and API

**Tag tap logic** (`backend/sessions.py`)

- Astronaut card: start a session for that astronaut (replacing any open one) and send `session` to the CYD.
- The same card again: end the session.
- Object tag during a session: apply it to that astronaut (exercise start or stop, sleep start or stop, meal, medicine, blood pressure guide) and send a `toast`.
- Object tag with no session: `toast` "Tap your card first".
- Surgeon card: unlock the surgeon view on all dashboards for 10 minutes.
- Emergency card: start emergency mode, with or without a session.
- Unknown UID: send `unknown_tag` to the CYD and show the assign popup in the UI.
- Sessions end after 2 minutes without activity. Sleep and exercise stay open across sessions until the second tap.

**Tables** (keep it simple; JSON text columns are fine for flexible data)

- `astronauts`: id, name, role, color, baseline\_reaction\_ms, created\_at
- `tags`: uid (primary key), type, label, astronaut\_id (nullable), data\_json
- `readings`: id, astronaut\_id, ts, indicator, value\_json, level, source (manual, cyd, tag or seed)
- `activities`: id, astronaut\_id, kind (exercise, sleep, meal, medicine, breathing), started\_at, ended\_at, data\_json
- `symptoms`: id, astronaut\_id, ts, items\_json, level
- `assessments`: id, astronaut\_id, ts, overall\_level, note, details\_json
- `alerts`: id, astronaut\_id, ts, level, text, acknowledged
- `messages`: id, from\_role, astronaut\_id, body, sent\_at, deliver\_at, read
- `points`: id, astronaut\_id, ts, amount, reason
- `badges`: astronaut\_id, badge\_id, earned\_at
- `settings`: key, value (mission profile, time scale, emergency state)

Open a fresh SQLite connection per request and per background thread, and guard writes with a lock.

**REST API** (JSON)

- `GET /api/astronauts`, `GET /api/astronauts/<id>`, `PUT /api/astronauts/<id>`
- `GET /api/astronauts/<id>/summary`: today's levels, body status, trends, points
- `GET /api/astronauts/<id>/history?indicator=hr&days=30`
- `POST /api/astronauts/<id>/assess`: vitals form in, assessment out
- `GET /api/crew`
- `GET /api/tags`, `POST /api/tags` (assign or edit), `DELETE /api/tags/<uid>`
- `GET /api/alerts`, `POST /api/alerts/<id>/ack`
- `GET /api/messages`, `POST /api/messages`
- `GET /api/mission`, `PUT /api/mission`
- `GET /api/content`: Learn and body-part text
- `GET /api/rewards/<id>`, `GET /api/leaderboard`
- `GET /api/export/<id>.csv`
- `POST /api/simulate/scan`, `POST /api/simulate/event`
- `POST /api/emergency` (start or cancel), `POST /api/reset-demo`

**Socket.IO events from server to browser**: `serial_status`, `scan`, `session_started`, `session_ended`, `cyd_event`, `assessment`, `alert`, `emergency`, `message_delivered`, `reminder`, `points`, `badge`, `unknown_tag`, `data_reset`.

## 13. Design and UI rules

- **Look**: a calm, clean dark "mission control" theme. All colors are CSS variables in one place. Status colors: green `#2ecc71`, yellow `#f4c430`, red `#ff5a4f`, and gray for "no data".
- **Never color alone**: every status also has an icon and a word (Good, Check, Alert) for color-blind users.
- **Readable**: 16 px base font, key numbers large, short sentences, and any medical word explained in plain language.
- **Light animation**: body parts glow on hover, RED parts pulse, cards slide in on new data, a small star burst for points. Respect `prefers-reduced-motion`.
- **Layout**: designed for a 1366x768 laptop first, works on a phone (surgeon view), no horizontal scrolling.
- **Consistency**: the same three levels and colors on the laptop, the CYD screen and the LED.
- **Text in one place**: keep UI strings in `static/js/strings.js` so we can add Arabic later.
- **Empty and error states**: a friendly message when there is no data, no CYD, or the serial port is busy.

## 14. Build order

Run the app and the tests at the end of every phase. Don't move on until the phase works.

1. **Foundation**: folders, `requirements.txt`, Flask and Socket.IO running, SQLite schema, `seed.py` with all fake data, vendor files downloaded into `static/vendor/`, page shell with tabs, theme and footer.
2. **CYD link**: `protocol.py` with tests, `serial_bridge.py` with auto-detect and reconnect, simulation mode, the Simulator panel and the message log.
3. **Core flow**: tag tap logic, the Live tab, the vitals form, the rules engine with tests, and the assessment sent back to the CYD as `status` and `led`.
4. **Visuals**: the Body figure with its side panel, Trends charts with colored bands, the Crew overview.
5. **Tags and daily life**: exercise, sleep, meals, medicine, the blood pressure guide, the Admin tag registry and the unknown-tag popup.
6. **Firmware**: all CYD screens, the protocol, LED, sound and the offline queue. If `arduino-cli` is available, compile the sketch to check it. List library versions in `firmware/README.md`.
7. **Mission realism**: mission profiles, comms delay, the flight surgeon view, reminders and schedule, emergency mode.
8. **Engagement and polish**: Rewards, the Learn tab, CSV export, animations, empty states, and a README with setup, the demo script and troubleshooting (port busy because the Arduino Serial Monitor is open, the CYD restarting when the port opens, the CH340 driver on Windows).

## 15. Demo script

This must work end to end, both with the CYD and in simulation mode.

1. Mission tab: switch to **Mars transit** (20-minute delay, sped up).
2. Omar taps his card. The CYD opens his menu and the laptop jumps to his Live view. The body figure shows the brain in YELLOW after a week of short sleep.
3. Omar does the reaction test on the CYD. It's slow, so reaction time turns YELLOW too.
4. He enters heart rate and blood pressure on the laptop and presses Assess. Overall YELLOW: the CYD shows "CHECK" with sleep advice and the LED turns yellow.
5. A report goes to the flight surgeon with a countdown, and the crew sees the self-care checklist meanwhile. The surgeon view on a phone receives it and replies; the reply arrives after the delay.
6. Omar taps the treadmill tag, the CYD shows the workout timer, and he taps again to stop. He earns points and the "Bone Guardian" progress moves.
7. Someone taps the red emergency card. Every screen turns red and the CYD flashes and beeps. Then cancel it.
8. Crew tab: all four astronauts at a glance, then Trends for Maya's rising blood pressure.

## 16. Definition of done and rules

- [ ] `pip install -r requirements.txt`, then `python app.py`, opens at `http://localhost:5000` with the seeded fake data.
- [ ] It works with no CYD and no internet (simulation mode), and every step of the demo script works.
- [ ] With the CYD plugged in, the port is found automatically and a card tap shows on the laptop within 1 second.
- [ ] Unknown real NFC cards can be assigned in Admin and work right away.
- [ ] Dashboards on a second device on the same network update live.
- [ ] All thresholds, texts and mission numbers live in `config/`, marked PLACEHOLDER; no fake value is presented as real NASA data.
- [ ] `pytest` passes.
- [ ] The firmware compiles in the Arduino IDE with the libraries listed in `firmware/README.md`.
- [ ] The README covers setup, running, the demo script, how to replace fake data with real data, and troubleshooting.

**Rules for you**

- Use only the stack in section 4. No extra frameworks, build tools, cloud services or analytics.
- Write simple, readable, commented code. Prefer clear functions over clever abstractions.
- Never hard-code a threshold or health text in code; read it from `config/`.
- Use only invented names and data. No real personal data.
- Ask before deleting files you didn't create.
- When you finish, list anything you couldn't build or test (for example, tests on the real hardware) so we can check it ourselves.
