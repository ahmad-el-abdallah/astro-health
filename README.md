# Astro Health Station

A NASA Space Apps hackathon demo: a tool that helps astronauts check their own health during
a mission and tells them what to do next. Three parts that work together:

- A **web app on a laptop**: a Flask + Socket.IO backend (`app.py`, `backend/`) and a React
  frontend (`frontend/`). Everything updates live; nothing polls.
- **CYD firmware** (`firmware/astro_cyd/`): a touchscreen for check-ins (mood, symptoms,
  reaction test, breathing, SOS). It talks to the laptop over USB serial or its own Wi-Fi.
- An **NFC reader** (`firmware/pico_nfc_reader/`, a Raspberry Pi Pico + PN532) plugged into
  the laptop: tap a crew card to sign in, or an object tag (treadmill, food packet…) to log it.

**Everything is fake data.** Every threshold, piece of health text and mission number lives
in `config/*.json`, marked `PLACEHOLDER`. Swap in real NASA data later without touching code.
Every screen and export carries: "Demo with placeholder data. Not medical advice."

Full build spec: `docs/build-prompt.md`. Notes for whoever works on the code next:
`docs/CLAUDE.md`. This README covers setting it up and running it.

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python app.py
```

Open **http://localhost:5000** (or this machine's LAN address on the same port, e.g. for a
phone showing the Flight Surgeon view).

**No Node.js needed to run it.** The built frontend (`frontend/dist/`) is committed, and
Flask serves it. You only need Node.js (20.19+ or 22+) if you change the UI:

```bash
cd frontend
npm install
npm run dev     # http://localhost:5173 with hot reload; forwards /api and Socket.IO to :5000
npm run build   # rebuild frontend/dist -- commit it so `python app.py` picks it up
npm test        # unit tests (Vitest)
npm run lint
```

If `pip` isn't available on your system Python, bootstrap it inside the venv instead:

```bash
python3 -m venv .venv --without-pip
curl -sS https://bootstrap.pypa.io/get-pip.py | .venv/bin/python -
.venv/bin/python -m pip install -r requirements.txt
```

### Signing in

Each crew member only ever sees their own data (enforced by the backend, not just hidden).
The Flight Surgeon sees the whole crew, since that's the point of the role, and gets the
teal medical console instead of the blue crew view.

- **NFC card (main way):** tap your card on the reader. No hardware? The **Simulator**
  button (bottom-right, on every screen including the login page) taps cards for you through
  the exact same code path.
- **Username & password**, and **Face ID**: set them up yourself under **Account** once
  you're signed in (or a superuser sets the password for you in `/admin`).
- **Emergency Access** on the login page raises the SOS without signing in.

A web sign-in lasts an hour. **Log out** in the browser also ends your CYD session, and
pressing **Done** on the CYD signs the browser out. The CYD drops back to its idle screen on
its own after 10 minutes without a touch (change it with `ASTRO_SESSION_IDLE_S=1800` etc.;
no reflash needed). That idle timeout never signs the browser out.

### What's in the app

- **Crew**, in four sections:
  - **Overview**: the home dashboard, with today's check-ins at a glance and the thread with
    the Flight Surgeon.
  - **Daily check-ins**, what the astronaut must do every day:
    - **Today**: the routine on the mission clock. The sidebar badge counts tasks due now.
      Workouts and sleep tracking start and stop right there, and the other tasks link to
      where they're done.
    - **Mind & mood**
    - **Sleep lab**

    A **Face check** card (every 2 hours, reading your expression for tiredness or stress)
    is shown as *Coming soon*.
  - **Health**: Astra & body (3D anatomy twin plus the Astra chat), Trends.
  - **Mission**: Mission health.
- **Flight Surgeon:** Crew overview, Alerts (acknowledge), each crew member's profile (with
  delayed replies), plus every crew page for whichever crew member is picked. The **tools**
  button (wrench) renames crew members, exports CSVs and resets the demo data.
- **Look:** frosted glass over a space backdrop. If scrolling feels heavy on a weak laptop,
  **Account → Reduce glass effects**. The sidebar collapses to an icon rail (edge button or
  Ctrl/⌘+B); on a phone it's a ☰ menu.

### AI health analysis

An AI looks at each astronaut's data as a whole and decides what's going on: a state
(doing well, sleeping, exercising, fatigued, stressed, possibly sick, unwell, emergency…),
the level of each reading, an overall level, a short explanation and advice, and whether
the Flight Surgeon should be alerted. It runs a few seconds after any new data (a reading,
a CYD check-in, a symptom, a sleep or workout tag), and there's an **Analyze now** button.
The result is on the crew Overview, each crew profile, and the Flight Surgeon's crew cards.

It uses **Groq's free plan** (no credit card):

1. Sign up at **console.groq.com** → **API Keys** → create a key.
2. Save it on the laptop, in the prompt or a terminal (the file is gitignored):
   `printf '%s' 'gsk_your_key_here' > data/ai_api_key` (or set the `AI_API_KEY` env var).
3. Restart `app.py`.

- **Free limits**: about 30 requests/minute and 1,000/day, but also about 200K tokens/day.
  One analysis is roughly 2K tokens, so that's around 100 analyses a day. Each astronaut is
  analyzed at most once every 20 s.
- **No key, no internet, or the limit is used up?** The app falls back to the threshold
  rules in `config/health_rules.json`, and the card says **"AI offline · checked by
  the rules"**. Alerts, the CYD screen and the LED keep working.
- **Change the AI's behaviour** in `config/ai_analyst.json` (its states and instructions).
  No code change or restart needed.
- **Use another provider** (any OpenAI-compatible API) with `AI_BASE_URL`, `AI_MODEL` and
  `AI_API_KEY`. For example, Hugging Face is `AI_BASE_URL=https://router.huggingface.co/v1`
  with an `hf_` token, but it isn't free.
- The AI only sees what's logged. "Sleeping" comes from an open sleep-station tag, and
  "sick" from temperature, SpO₂, symptoms and discomfort. There's no continuous body sensor.

### "Astra": call the AI by name, from any page

The AI is called **Astra**. Signed in as a crew member, just say **"Astra"** on any page and
the voice screen opens. Say **"Astra, how am I doing?"** in one breath and she answers that
straight away. Say only "Astra" and she beeps and listens for your question.

- The **Astra pill** in the top bar shows whether she's listening ("Say 'Astra'"). Click it
  to switch her off or on; your choice is remembered in this browser.
- **Allow the microphone** the first time. After opening or refreshing the page, **click
  anywhere once** so the browser lets her talk back. If you call her before clicking, she
  shows her answer as text with a **"Tap so Astra can talk"** button, which plays it aloud.
- **Noise around you:** Astra listens for *your* voice and ignores unclear sounds in the room
  (people talking nearby, a video, a fan). She answers about a second after you stop talking,
  even if the room stays noisy. If she ignores something, the voice screen tells you. She also accepts her name
  with one letter misheard, like "Asta" or "Ostra". Pick the **Room** setting on the voice
  screen, or under Account → Astra's hearing:
  - **Quiet room:** catches a soft voice, even from across the room.
  - **Normal** (the default).
  - **Noisy room:** only clear speech close to the mic, and talking over her takes a few
    words.
- **One tab at a time:** only the tab you used last listens, because two tabs can't share
  the microphone. Any other tab's pill says "Astra in another tab"; click in that tab to
  move her there.
- If she ever misses your call, open DevTools → Console (level "Verbose"). Every phrase she
  heard is logged as `[astra] …`, so you can see what the browser actually understood.
- **Chrome or Edge only**, and only with the app opened as **`http://localhost:5000`** (or
  https). Browsers block the microphone on a plain `http://<ip>` address.
- **Privacy:** while Astra is on, the microphone stays open, and Chrome sends what it hears
  to Google (Edge: Microsoft) to turn it into text, not only after her name. Switch her off
  with the pill when you don't want that.
- The Flight Surgeon doesn't get Astra.

### Talking to Astra (text or voice)

On **Astra & body**, open the chat. The same Groq AI answers from your own data and
latest health analysis ("How am I doing?", "why is my temperature flagged?"). If you
describe pain ("my back hurts, maybe a 6"), it also logs it on the 3D model. With no AI
available, it falls back to instant keyword replies, and the header says "Quick replies
(AI offline)".

Voice uses only the browser's built-in Web Speech API: no extra service, key or install.

- **Voice mode** (the button in the chat header): a full-screen, hands-free conversation
  like ChatGPT's voice mode. A glowing orb listens (it reacts to your voice), thinks and
  answers out loud, then listens again on its own. Tap the orb to interrupt, use the mic
  button to pause listening, and the red button (or Esc) to end. Captions are off unless
  you press **CC**, and every turn is also saved in the text chat.
- **Talk over her:** while Astra is answering, just start talking. She stops and waits for
  you to finish, then answers your new question. She keeps the whole conversation and knows
  where you cut her off. Saying just "stop" or "wait" makes her stop and listen. Headphones
  help, so the mic doesn't hear her own voice.
- **Mic button** (push-to-talk): press, speak, press again (or just stop talking). Your
  words appear live in the text box, then go to the AI like a typed message.
- **Voice on / Muted** in the chat header: when on, every AI reply is read aloud (a small
  face moves its mouth while it talks). Muting also stops the current reply.
- The chip shows **Ready**, **Listening** (red) or **Thinking** (blue).
- **Typing always works**, voice is only an extra. A blocked microphone shows
  "Microphone permission denied - text input still works".
- **The station voice is chosen on `/admin` → Station voice:**
  - **Presets** fill everything in one click:
    - **Station comms** (the default): Aria, medium echo, beeps and hum.
    - **Clean**: no echo, no beeps, no hum.
    - **Ship computer**: Jenny, light echo, a little slower.
    - **Mission control radio**: Guy, a crackly space-radio sound, and beeps.
    - **Captain**: Andrew, deep voice, light echo.
  - **Engine**:
    - **Browser voice**: works offline, using the computer's own voice. Choose
      **Female** or **Male**, and the best matching voice on that computer is used.
    - **Microsoft neural voice** (free, no key, **needs internet**): a much more natural
      voice. There are 7 female and 7 male voices, American, British or Australian. Each
      reply takes about 2–4 s longer. If it fails, the browser voice is used instead.
  - **Echo**: Off, Light, Medium or Strong. It works with the neural voice only, because the
    browser voice plays directly and can't be changed.
  - **Space radio**: a narrow, crackly radio sound. Neural voice only.
  - **NASA beeps**: Apollo **Quindar tones**, 2525 Hz before each reply and 2475 Hz after.
  - **Cabin hum**: a soft background hum in voice mode.
  - **Speed** (80–130%) and **Pitch** (Low / Normal / High) work with both engines.
  - **Test voice** plays exactly what's on the card before you save.
- **Browsers:** use Chrome or Edge. Firefox has no voice input (the mic button is disabled
  and typing works). Which voices you hear depends on the computer.
- **Privacy note:** the AI's voice is made on this computer, but **speech recognition isn't
  fully local**. Chrome sends the microphone audio to Google's servers, and Edge to
  Microsoft's, to turn it into text.

### Astra can open pages and fill things in for you

Talk or type to Astra (crew only):

- **Open a page:** "take me to the sleep page", "open trends", "go to the overview". On the
  voice screen she says "Opening …", then the screen closes on that page.
- **Fill something in:** she shows a card with exactly what she understood, and **saves
  nothing until you say "yes"** (or press **Yes**). "No" cancels, and saying
  something else drops it.
  - Mood: "my mood is low, I'm stressed" (saved with the note "stressed")
  - Sleep: "I slept from 11pm to 6am"
  - Symptoms and pain: "I have a headache", "my back hurts, about a 6"
  - Vitals: "my heart rate is 72 and my temperature is 37.4" (then analyzed)
  - Journal: "write in my journal: the treadmill felt easy"
  - Alert the flight surgeon (urgent): "tell the flight surgeon I feel dizzy"
  - Message the flight surgeon (normal): "tell the doctor I slept well". It arrives after
    the mission's comms delay.
  - Health summary: "send my weekly summary to the doctor". The AI writes it from your data.
  - Sleep and workouts: "I'm going to bed" / "I'm awake", "start my workout" / "workout
    done". Times run on the mission clock.
  - New vitals reading: "take my vitals". The card shows the station sensors' numbers first.
- **Guided activities** start right away on the voice screen, with a Stop button:
  - "guide me through a breathing exercise": box breathing, 4 rounds
  - "let's do a reaction test": 5 taps on green, judged against your own baseline
  - "how do I measure my blood pressure?": the steps one by one, then tell her the number
- **Voice SOS:** "I need help now" (or "this is an emergency", "I can't breathe") starts a
  5-second countdown. Say "cancel" or tap it if you're okay; otherwise the real emergency
  starts.
- **She remembers:** "remember my left knee has hurt since Tuesday". She uses it later and
  checks in on it. Account → **What Astra remembers** lists every note, with **Forget**.
  She also checks in by herself after a low mood, pain of 6/10 or more, or new symptoms.
- Groq's free plan allows about 8K AI tokens a minute. Firing many requests in a row can
  hit that for a minute; Astra then falls back to the keyword replies.
- The Flight Surgeon can still ask about a crew member, but Astra never saves anything on
  their behalf.

### Inside or outside: spacewalk (EVA) mode

Next to the Astra pill in the top bar, the **Location** pill shows **Inside**, or **EVA · 12
min** while you're outside. Click it when you go out on a spacewalk and again when you're
back. It asks **"Are you sure?"** first (Cancel or Esc changes nothing). You can also tell
Astra "I'm heading out for my spacewalk".

**While outside:**
- Three suit readings join your readings and come first on Overview: **Suit CO2** (mmHg),
  **Suit pressure** (psi) and **Oxygen supply** (%). Their ranges are PLACEHOLDER figures.
- "Use simulated vitals" fills them from the suit sensors.
- **Simulate suit problem** fills high CO2 and low pressure, for the demo.
- The AI health analyst treats the suit readings as life-critical. A red one makes it say
  you're unwell, tell you to head back to the airlock, and alert the flight surgeon. Astra's
  health warning speaks up too.
- The Flight Surgeon sees **On EVA** on your crew card and your Location pill (read-only).

**Back inside**, suit readings stop counting, so an old red CO2 reading can't keep you red.

### Astra speaks first

Without being asked, Astra says (or shows in a small card at the bottom right):

- **Health warnings**: when your health analysis gets worse (yellow or red), at most once
  every 10 minutes. She offers to alert the flight surgeon, or says she already did.
- **Today's routine**: "It's 08:00: exercise block. Should I start tracking your workout?", and
  "You missed the morning vitals check…" when a task is missed.
- **The flight surgeon**: she reads their messages to you (and you can answer by voice),
  and tells you when they've seen your alert, after the comms delay.
- **Check-ins**: things she said she'd ask about again.
- **Daily briefing**: the first time you open the app each day, she offers one: last sleep,
  how you're doing, what's left today, new messages.

**Answer** / **Talk** on the card opens the voice screen, with a yes/no card for anything she
offered. She speaks out loud only when all of these are true:
- the Astra pill is on
- the page has been clicked
- no call is open
- this is the tab she's listening in

She speaks out loud at most once a minute. A superuser sets **Astra speaks first** on
`/admin` → Station voice: **Out loud**, **Card only** or **Off**.

### "Wanna talk?" and voice tone estimates (optional)

On **Mind & mood**, **Wanna talk?** → **Talk to Astra** opens her usual voice screen for a
short, hands-free chat. During that chat only, each phrase you say also gets a **voice tone
estimate** (angry, calm, disgust, fearful, happy, sad or surprised), from a Wav2Vec2 model
running on this laptop. The estimates appear afterwards in the **Voice tone · estimate** card on
the same page. Nothing is shown during the call, and Astra's AI is never told.

- **An estimate, not a diagnosis.** It guesses from how the voice *sounds*, and the model was
  trained on acted speech. It doesn't detect stress, fatigue or any condition, and it never
  feeds the health analysis, alerts, levels or your mood.
- **Kept apart from your mood.** Self-reported mood stays exactly as it was (`readings`).
  Estimates have their own table (`voice_tone`) and their own card.
- **Two different audio paths:**
  - *Voice tone (local):* each phrase is recorded from Astra's shared microphone, sent as a
    16 kHz WAV to this laptop's own backend, analysed in memory and thrown away. Only the
    scores are saved, and nothing goes to an outside service.
  - *Speech-to-text (not local):* the words themselves still go through the browser's speech
    recognition, as for every Astra call. Chrome sends that audio to Google, Edge to Microsoft.
- **Who sees it:** the astronaut and the flight surgeon (like the journal). Only the astronaut
  can record.
- **Optional install** (about 1.5 GB on disk; the app works without it):

  ```bash
  .venv/bin/python -m pip install -r requirements-emotion.txt   # torch (CPU-only) + transformers
  .venv/bin/python -m backend.services.emotion download          # the model, ~378 MB, SHA-256 checked
  ```

  The model is `Dpngtm/wav2vec2-emotion-recognition` (MIT), pinned to one revision and stored
  in `models/wav2vec2-emotion/` (gitignored). It loads in the background when `app.py` starts
  (about 3 s and about 500 MB of RAM) and never goes online at runtime. Without it, the talk
  works the same and the card says estimates aren't set up. `ASTRO_NO_EMOTION=1` turns it off.
- **Speed:** on an Intel Core 7 240H with 4 threads, about 0.25 s for a 5 s phrase and 0.8 s
  for 15 s. `python -m backend.services.emotion bench` measures your machine, and
  `... predict file.wav` checks one recording.
- **Browser test** (dev only, never against your live app): `cd frontend && node scripts/e2e-wanna-talk.mjs --base http://localhost:5057`
  against an isolated copy. The steps are at the top of that file.
- **Latest Conversation Analysis** (Mind page, below the voice tone card): the result of your
  last finished talk only. It shows the dominant tone and its share, all seven probabilities
  (the average over that talk's analysed phrases) and how many phrases were analysed. It says
  "Analysing…" while the last phrases are still being processed, and survives a reload.
- **How your speech is found:** from the audio itself, measured against your mic's own
  background level, with Astra's actual playback (and anything said over it) left out. The
  speech recognizer's timing is only used to know which seconds belong to a phrase. Very
  short replies ("yes") are skipped rather than guessed at. Open DevTools → Console and filter
  `voice tone` to see, per phrase and in numbers only, what was kept and why.

### Superuser admin page

Assigning NFC cards and managing crew accounts happens at **http://localhost:5000/admin**,
with its own login, separate from the crew/surgeon sign-in. Create the first superuser:

```bash
.venv/bin/python -m backend.auth.create_superuser
```

It prompts for a username and password. On `/admin`:

- **Unknown cards:** any card the reader doesn't recognise shows up here live (the CYD just
  says "Unknown card"). Assign it as a crew member's card (existing or new person, with a
  role) or as an object tag with a label, or dismiss it.
- **Card registry:** every assigned card, with delete.
- **Crew accounts:** change roles, set a username/password, clear a stuck Face ID, add a
  crew member.

## Running it

```bash
.venv/bin/python app.py                 # auto-detect: USB serial, then the CYD's own
                                         # Wi-Fi AP (if already joined), then simulation
.venv/bin/python app.py --port COM5     # force a specific USB port (or /dev/ttyUSB0, etc.)
.venv/bin/python app.py --simulate      # force simulation -- the Simulator drives everything
.venv/bin/python app.py --wifi          # force the Wi-Fi bridge (see below) -- join its AP first
ASTRO_PORT=/dev/ttyUSB0 .venv/bin/python app.py   # port via env var instead of --port
```

With no flags, `app.py` tries each transport in order and uses whichever is actually there,
so the same command works with the CYD on USB, on its own Wi-Fi, or not connected at all.
The Pico NFC reader is picked up automatically too, if plugged in.

First run creates the database (`data/astro.db`, git-ignored) with the real crew (their card
UIDs are in `backend/seed.py`) plus a Flight Surgeon. New cards are assigned in `/admin`.

The app runs on a sped-up **mission clock** (`ASTRO_TIME_SCALE`, default 60: one real minute
is one mission hour). Comms delays, reminders and the Today page all use it, and it starts
at 00:00 each time the server starts.

### Running the CYD on a power bank (no laptop cable)

The CYD can run untethered from any USB power bank and still reach the laptop: it broadcasts
its own Wi-Fi network and speaks the same JSON protocol USB serial uses.

- **Network**: `AstroHealthCYD`, password `astrohealth123` (set at the top of
  `firmware/astro_cyd/astro_cyd.ino`; reflash after editing).
- **On your laptop**: join that network, then run `.venv/bin/python app.py` (auto-detects it)
  or `--wifi` to force it.
- **Keeping internet at the same time**: that Wi-Fi adapter can't also reach your normal
  network. Use Ethernet or a second adapter/hotspot for internet.
- The NFC reader plugs into the laptop, not the CYD, so none of this affects it.

## Demo script

Works the same with the real hardware or in `--simulate` mode.

1. Tap **Ahmad's** card (Simulator, or his real card): you land on his **Overview**.
2. Simulator → "Reaction: slow". The reaction-time tile turns yellow/red, live.
3. Overview → **Take a new reading** → **Assess**. A few seconds later the **AI health
   analysis** card updates with Ahmad's state and what to do. If it's red, a report heads to
   Earth on the comms delay and an alert is raised.
4. **Astra & body**: tap a body part on the 3D twin, or open the chat and ask "How am I
   doing?". Press **Voice mode** to just talk to it, hands-free; it answers out loud. Say "my
   back hurts, maybe a 6" and it logs that on the twin.
5. **Log out**, then tap the **Flight Surgeon's** card. **Crew overview** shows who needs
   attention first. Open **Alerts**, acknowledge one, then **Open profile** for Ahmad.
6. In the profile's **Messages**, reply. Switch the mission to **Mars transit** first (top bar
   → Mission chip → Mars transit) to watch the reply count down before it reaches Ahmad, then log back in as
   Ahmad to see it arrive.
7. **Today** (Daily check-ins): the mission clock, with tasks ticked off from what was
   actually logged. Press **Start workout**, then **Stop workout**.
8. Simulator → **Emergency card**. Every open screen shows the red overlay, signed in or not.
   Cancel it on the overlay (or hold the CYD's corner SOS button 3 s on hardware).

## Replacing fake data with real data

- Thresholds: `config/health_rules.json` (every indicator's GREEN/YELLOW/RED ranges).
  Vitals: heart rate, blood pressure, blood sugar, temperature and blood oxygen (SpO2,
  placeholder bands: 95%+ good, 90-94% check, below 90% alert).
- Plain-language text (hazards, body parts, measurement guides): `config/content.json`.
- Mission profiles and comms delays: `config/missions.json`; per-mission body risks and
  checks: `config/mission_health.json`.
- Daily schedule: `config/routine.json`.
- Symptoms and their self-care guidance: `config/symptoms.json`.
- Real crew: tap a new NFC card, then assign it in `/admin`. Rename crew from the Flight
  Surgeon's tools menu.
- To start over with fresh demo data: Flight Surgeon tools → **Reset demo data** (asks you to
  type RESET; superuser accounts are kept), or `.venv/bin/python -m backend.seed`.
- **Live monitor (Overview → "Start live monitor")** replays a *real* recorded crew session: a
  moving ECG, heart rate, breathing rate and a relative stress level (skin response), with the
  recorded startle moments flagged. Source: NASA's crew-state physiology study (Kaggle
  "Reducing Commercial Aviation Fatalities"), crew 13. Only a small per-second summary is in
  the repo (`backend/sensor/crew13.json`). To rebuild it from the original zip:
  `.venv/bin/python -m backend.sensor.build ~/Downloads/13.zip`

## Testing

```bash
.venv/bin/python -m pytest       # 243 backend tests
cd frontend && npm test          # 58 frontend tests
```

## Troubleshooting

- **"Frontend not built yet"**: `frontend/dist` is missing. `cd frontend && npm install && npm run build`.
- **Port busy / "could not open port"**: close the Arduino IDE's Serial Monitor (or anything
  else holding the port) and restart `app.py` (it also retries every 3 s on its own).
- **CYD resets when the port opens**: normal for most ESP32 boards; it re-sends `hello` on
  boot and the laptop re-detects it within a few seconds.
- **Astra didn't answer**: she now recovers by herself (no refresh). If it happens often,
  open the browser's DevTools console and look for lines starting with `[astra]`. They say
  what went wrong (AI busy / free limit, audio locked until you click, mic restarted).
- **A card tap did nothing**: the login screen says "Reconnecting to the station…" while
  the page can't reach the laptop; a tap made then is still picked up when it reconnects.
  If taps never register, check the `app.py` terminal for a scan line (if none, it's the
  reader/USB, not the page).
- **USB messages come through garbled**: a cable/port signal-integrity issue, not software.
  Try a shorter cable and a direct port (no hub). The Wi-Fi path above is a reliable fallback.
- **Windows and the CH340 chip**: install the CH340 driver; pass the port as `--port COMx`.
- **3D views say WebGL is unavailable**: turn on hardware acceleration in the browser
  settings (Chrome: Settings → System), then reload.
- **Nothing shows up on a phone**: use this machine's LAN IP, on the same network.

## What's built vs. not hardware-verified

Built and tested (243 backend + 58 frontend unit tests, and every page clicked through in a
headless browser at desktop and phone width): the backend (sessions, rules engine, comms
delay, mission clock, serial/Wi-Fi bridges, simulation, login/access control, AI analysis with
its rules fallback),
and the whole React app for crew, Flight Surgeon and `/admin`.

**Hardware:**

- `firmware/astro_cyd/` is **flashed and running** on the real CYD (boot and serial handshake
  confirmed, 2026-11-11). Screen rotation, touch calibration, the LED/speaker and the optional
  microSD logging were never formally checked; see `firmware/README.md` if anything looks off.
- `firmware/pico_nfc_reader/` is **flashed and verified end-to-end**: a real crew card tap
  signs in over `app.py`.
- `firmware/esp32s3_nfc_reader/` is dead hardware (its chip failed), kept for reference only.
  Don't flash it.
