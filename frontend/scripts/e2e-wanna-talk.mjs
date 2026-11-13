// End-to-end browser check of "Wanna talk?" (voice tone estimates), run by hand -- never
// against your live app/database. Dev-only: needs `npm install` (playwright-core) and an
// installed Microsoft Edge or Google Chrome (no browser download).
//
// What's REAL here: the browser, getUserMedia (Chromium's fake microphone playing real
// speech from tests/fixtures/voice_phrase.wav), Astra's shared micMeter, the AudioWorklet
// capture, the browser's resampler, the upload, the backend, the LOCAL Wav2Vec2 model, the
// database and the Mind page. What's FAKE: speech-to-text and Astra's browser voice (a headless
// browser has no usable recognizer or speakers) -- the same pattern as every Astra test so far.
//
// 1. Make an isolated copy with its own empty data/ (your data/astro.db is never touched), e.g.
//      python -c "import shutil; [shutil.copytree(d, f'../astro-iso/{d}') for d in ('backend', 'config', 'frontend/dist')]; shutil.copy('app.py', '../astro-iso/')"
//    and create ../astro-iso/data/, then start it on its own port, with the model:
//      cd ../astro-iso && ASTRO_EMOTION_MODEL_DIR=<repo>/models/wav2vec2-emotion python app.py --simulate --web-port 5057
//    (no data/ai_api_key there, so Astra answers with her offline replies -- that's fine.)
// 2. Add a fake test card for astronaut 1 to THAT copy's database (seed.py no longer makes one):
//      python -c "import sqlite3; c=sqlite3.connect('../astro-iso/data/astro.db'); c.execute(\"INSERT OR IGNORE INTO tags (uid,type,label,astronaut_id,data_json) VALUES ('A1000001','astronaut','Test card',1,'{}')\"); c.commit()"
// 3. cd frontend && node scripts/e2e-wanna-talk.mjs --base http://localhost:5057
//
// Options: --base URL (default http://localhost:5057; port 5000 is refused unless --allow-live)
//          --uid A1000001 (crew card)  --surgeon-uid D1000001  --channel msedge|chrome
//          --level 0.0021 (play the speech at this peak frame RMS: 0.0021 = the user's laptop mic,
//                          measured 2026-11-13; default: the fixture's own level)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const base = arg("base", "http://localhost:5057").replace(/\/$/, "");
const uid = arg("uid", "A1000001");
const surgeonUid = arg("surgeon-uid", "D1000001");
const channel = arg("channel", "msedge");
const level = arg("level", null);
if (new URL(base).port === "5000" && !process.argv.includes("--allow-live")) {
  console.error("Refusing to run against port 5000 (your live app and database). Use an isolated copy (see the top of this file).");
  process.exit(2);
}

// ---- the fake microphone: the fixture phrase three times, with silences between ----
const here = path.dirname(fileURLToPath(import.meta.url));
function pcmOf(file) {
  const b = fs.readFileSync(file);
  let o = 12, fmt = null, data = null;
  while (o + 8 <= b.length) {
    const id = b.toString("ascii", o, o + 4), size = b.readUInt32LE(o + 4);
    if (id === "fmt ") fmt = { ch: b.readUInt16LE(o + 10), rate: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) };
    if (id === "data") data = b.subarray(o + 8, o + 8 + size);
    o += 8 + size + (size % 2);
  }
  if (!fmt || fmt.ch !== 1 || fmt.rate !== 16000 || fmt.bits !== 16 || !data) throw new Error(`${file}: need 16 kHz mono 16-bit`);
  return data;
}
function wavOf(pcm) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
let phrase = pcmOf(path.join(here, "..", "..", "tests", "fixtures", "voice_phrase.wav"));
if (level) { // bring the speech down to a measured mic level (16-bit, so it keeps what a quiet mic would give)
  const n = phrase.length / 2;
  let peak = 0;
  for (let i = 0; i + 320 <= n; i += 320) {
    let sum = 0;
    for (let j = i; j < i + 320; j++) { const x = phrase.readInt16LE(j * 2) / 32768; sum += x * x; }
    peak = Math.max(peak, Math.sqrt(sum / 320));
  }
  const k = Number(level) / peak;
  const out = Buffer.alloc(phrase.length);
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.round(phrase.readInt16LE(i * 2) * k), i * 2);
  phrase = out;
  console.log(`fake mic: speech scaled to peak frame RMS ${level} (x${k.toFixed(4)})`);
}
const silence = Buffer.alloc(16000 * 2 * 3);
const fakeMic = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "astro-e2e-")), "fake_mic.wav");
fs.writeFileSync(fakeMic, wavOf(Buffer.concat([silence, phrase, silence, phrase, silence, phrase, silence])));

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TONE_WORD = /\b(calm|happy|sad|angry|fearful|disgust|surprised)\b/i;

// Fake speech-to-text and browser voice, installed before the app loads.
const FAKES = () => {
  window.__rec = { phrases: ["I had a long day but the experiment went well", "I am a bit tired and I miss my family", "the view of Earth this morning was amazing"], i: 0, wake: false };
  const synth = {
    speaking: false, paused: false, pending: false, _u: null, _t: 0,
    getVoices: () => [{ name: "Fake US English", lang: "en-US", default: true }],
    speak(u) { this._u = u; this.speaking = true; setTimeout(() => u.onstart?.({}), 20); this._t = setTimeout(() => { this.speaking = false; this._u = null; u.onend?.({}); }, 1500 + u.text.length * 30); },
    cancel() { if (this._u) { clearTimeout(this._t); const u = this._u; this._u = null; this.speaking = false; u.onend?.({}); } },
    resume() {}, pause() {}, addEventListener() {}, removeEventListener() {}, onvoiceschanged: null,
  };
  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
  Object.defineProperty(window, "SpeechSynthesisUtterance", { value: class { constructor(t) { this.text = t; } }, configurable: true });
  class FakeRec {
    constructor() { this.lang = "en-US"; this.interimResults = false; this.continuous = false; this.maxAlternatives = 1; this._timers = []; this._ended = false; }
    _emit(text, fin) { const res = [{ transcript: text, confidence: fin ? 0.92 : 0 }]; res.isFinal = fin; this.onresult?.({ resultIndex: 0, results: [res] }); }
    _end() { if (this._ended) return; this._ended = true; this._timers.forEach(clearTimeout); this.onend?.(); }
    start() {
      setTimeout(() => this.onstart?.(), 0);
      if (this.continuous) { // the wake-word listener: says "hey astra" when the test asks
        const poll = () => { if (this._ended) return; if (window.__rec.wake) { window.__rec.wake = false; this._emit("hey astra", true); } this._timers.push(setTimeout(poll, 300)); };
        poll();
        return;
      }
      // one phrase: waits until Astra has finished talking, then "speaks" word by word
      const words = window.__rec.phrases[window.__rec.i++ % window.__rec.phrases.length].split(" ");
      const go = () => {
        if (this._ended) return;
        if (window.speechSynthesis.speaking) { this._timers.push(setTimeout(go, 200)); return; }
        words.forEach((_, k) => this._timers.push(setTimeout(() => this._emit(words.slice(0, k + 1).join(" "), false), 700 + k * 450)));
        this._timers.push(setTimeout(() => { this._emit(words.join(" "), true); this._end(); }, 700 + words.length * 450 + 400));
      };
      this._timers.push(setTimeout(go, 400));
    }
    stop() { setTimeout(() => this._end(), 10); }
    abort() { this._ended = true; this._timers.forEach(clearTimeout); setTimeout(() => this.onend?.(), 0); }
    addEventListener() {}
  }
  Object.defineProperty(window, "SpeechRecognition", { value: FakeRec, configurable: true });
  Object.defineProperty(window, "webkitSpeechRecognition", { value: FakeRec, configurable: true });
};

const browser = await chromium.launch({
  channel, headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${fakeMic}`],
});

async function newPage(cardUid) {
  const ctx = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(FAKES);
  const page = await ctx.newPage();
  const logs = [], posts = [], others = [];
  page.on("console", (m) => { if (m.text().includes("[astra]")) logs.push(m.text()); });
  page.on("pageerror", (e) => logs.push("PAGEERROR " + e.message));
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/voice-tone")) posts.push(r.url());
    const u = new URL(r.url());
    if (u.host !== new URL(base).host && !u.protocol.startsWith("data")) others.push(r.url());
  });
  await page.goto(base + "/");
  const res = await page.evaluate(async (u) => (await fetch("/api/auth/nfc_login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uid: u }) })).status, cardUid);
  if (res !== 200) throw new Error(`login with card ${cardUid} failed (${res}) -- see step 2 at the top of this file`);
  return { page, logs, posts, others };
}

// Existing behaviour (not this feature): while one of Astra's notice cards (daily briefing,
// schedule...) is showing, the first click on "Talk to Astra" doesn't open the call. So:
// dismiss any card, click, and retry if needed.
async function dismissNotices(p) {
  const until = Date.now() + 3500;
  while (Date.now() < until) {
    const d = p.getByRole("button", { name: "Dismiss" });
    if ((await d.count()) && (await d.first().isVisible())) { await d.first().click(); await sleep(400); continue; }
    await sleep(250);
  }
}
async function openCall(p, button) {
  for (let i = 0; i < 3; i++) {
    await dismissNotices(p);
    await button.click();
    if (await p.getByRole("dialog", { name: "Voice conversation with Astra" }).waitFor({ timeout: 3000 }).then(() => true).catch(() => false)) return true;
  }
  return false;
}
const api = (page, p, o) => page.evaluate(async ([pp, oo]) => { const r = await fetch("/api" + pp, oo); return { status: r.status, body: await r.json().catch(() => null) }; }, [p, o]);

// ---------------------------------------------------------------- crew: Wanna talk
const crew = await newPage(uid);
const { page } = crew;
const status = (await api(page, "/voice-tone/status")).body;
const ready = status?.state === "ready";
console.log(`model status: ${status?.state}${status?.reason ? " (" + status.reason + ")" : ""}`);
const me = (await api(page, "/auth/me")).body;
const aid = me.astronaut_id;
check("self-reported mood logged before the talk",
  (await api(page, `/astronauts/${aid}/mood`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mood: "good", note: "e2e self-report" }) })).status === 200);
const moodBefore = (await api(page, `/astronauts/${aid}/history?indicator=mood&days=7`)).body;

await page.goto(base + "/mind");
const talkButton = page.getByRole("button", { name: "Talk to Astra" }).first();
await talkButton.waitFor({ timeout: 15000 });
check("Mind page shows the Wanna talk card", await page.getByText("Wanna talk?", { exact: true }).isVisible());
check("Mind page shows the separate voice tone card", await page.getByRole("heading", { name: "How your voice sounded" }).isVisible());
check("status text matches the model", ready
  ? await page.getByText("Voice tone estimates are on for this talk.").isVisible()
  : await page.getByText(/aren.t set up on this laptop/).first().isVisible());
check("privacy text separates the local tone path from browser speech-to-text", await page.getByText(/analysed on this laptop.*Google.*Microsoft/).isVisible());

check("voice screen opens", await openCall(page, talkButton));
check("it's the Wanna talk call", await page.getByText("Wanna talk? · Astra").isVisible());
check("its header says where tone is estimated", await page.getByRole("dialog").getByText(ready ? "Voice tone is estimated on this laptop" : /estimates aren.t set up/).isVisible());
check("no tone shown during the call", !TONE_WORD.test(await page.getByRole("dialog").innerText()));

const t0 = Date.now();
while (Date.now() - t0 < (ready ? 45000 : 20000) && crew.posts.length < 3) await sleep(500);
await sleep(2500);
const est = crew.logs.filter((l) => l.includes("voice tone phrase") && l.includes("HTTP 200"));
if (ready) {
  check("phrases were sent to the local backend", crew.posts.length >= 2, `${crew.posts.length} clips`);
  check("each clip got a real model estimate", est.length === crew.posts.length, est.join(" | "));
} else {
  check("model not ready: nothing recorded or sent", crew.posts.length === 0);
}
check("still no tone shown during the call", !TONE_WORD.test(await page.getByRole("dialog").innerText()));
await page.keyboard.press("Escape");
await sleep(800);

const tone = (await api(page, `/astronauts/${aid}/voice-tone?days=7`)).body;
const talkId = tone.at(-1)?.talk_id;
const thisTalk = tone.filter((r) => r.talk_id === talkId);
if (ready) {
  check("estimates saved under one talk id", thisTalk.length === est.length, `${thisTalk.length} rows for ${talkId}`);
  check("each has all seven probabilities, summing to 1", thisTalk.every((r) => Object.keys(r.scores).length === 7 && Math.abs(Object.values(r.scores).reduce((a, b) => a + b, 0) - 1) < 0.002));
}
const moodAfter = (await api(page, `/astronauts/${aid}/history?indicator=mood&days=7`)).body;
check("self-reported mood history unchanged", JSON.stringify(moodAfter) === JSON.stringify(moodBefore), `${moodAfter.length} mood row(s)`);
if (ready) {
  await page.getByText(/Last talk/).waitFor({ timeout: 5000 }).catch(() => {});
  check("Mind page shows the last talk", await page.getByText(/Last talk/).isVisible());
  const mix = page.getByLabel("All seven voice tone probabilities, averaged over the last talk");
  check("Mind page shows all seven probabilities (tone mix)", (await mix.locator("dt").count()) === 7, (await mix.innerText()).replace(/\s+/g, " "));
  await page.getByText(/Each phrase \(/).click();
  const each = page.getByLabel("Voice tone probabilities of each phrase in the last talk");
  check("per-phrase breakdown lists every phrase", (await each.locator("li").count()) === thisTalk.length);
  // ---- Latest Conversation Analysis: THIS conversation only, finished after its analyses ----
  let latestTalk = null;
  for (let i = 0; i < 20; i++) { latestTalk = (await api(page, `/astronauts/${aid}/voice-talks/latest`)).body?.talk; if (latestTalk?.status === "complete") break; await sleep(500); }
  check("the conversation finished on the server", latestTalk?.status === "complete", JSON.stringify({ status: latestTalk?.status, sent: latestTalk?.phrases_sent, analysed: latestTalk?.phrases_analysed }));
  check("its phrases are exactly this call's phrases", latestTalk?.talk_id === talkId && latestTalk?.result?.phrases === thisTalk.length);
  const section = page.getByRole("region", { name: "Latest Conversation Analysis" });
  await section.getByTestId("dominant").waitFor({ timeout: 8000 }).catch(() => {});
  check("Latest Conversation Analysis shows the dominant tone and its %", (await section.getByTestId("dominant").isVisible()) && /\d+% of this conversation/.test(await section.getByTestId("dominant-pct").innerText()),
    `${await section.getByTestId("dominant").innerText().catch(() => "-")} ${await section.getByTestId("dominant-pct").innerText().catch(() => "-")}`);
  check("... all seven probability bars", (await section.getByRole("meter").count()) === 7);
  check("... and how many phrases were analysed", new RegExp(`^${thisTalk.length} of `).test(await section.getByTestId("phrase-count").innerText()), await section.getByTestId("phrase-count").innerText());
  await page.reload();
  await page.getByRole("region", { name: "Latest Conversation Analysis" }).getByTestId("dominant").waitFor({ timeout: 10000 }).catch(() => {});
  check("... still there after a page refresh", await page.getByRole("region", { name: "Latest Conversation Analysis" }).getByTestId("dominant").isVisible());
}
check("mood check-in and mood chart still there", (await page.getByText("How are you feeling right now?").isVisible()) && (await page.getByText("Mood · last 7 days").isVisible()));

// ---------------------------------------------------------------- normal Astra never records
const postsBefore = crew.posts.length;
await page.goto(base + "/body");
const bodyButton = page.getByRole("button", { name: "Talk to Astra" }).first();
await bodyButton.waitFor();
check("normal Astra call opens", await openCall(page, bodyButton));
check("it's a normal call", await page.getByText("Astra · voice").isVisible());
await sleep(14000);
check("normal call: nothing recorded or sent", crew.posts.length === postsBefore);
await page.keyboard.press("Escape");
await sleep(1000);

await page.goto(base + "/");
await dismissNotices(page);
await sleep(1500);
await page.evaluate(() => { window.__rec.wake = true; });
const woke = await page.getByRole("dialog", { name: "Voice conversation with Astra" }).waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
check("the wake word still opens Astra", woke);
if (woke) check("wake-word call is a normal call", await page.getByText("Astra · voice").isVisible());
await sleep(8000);
check("wake-word call: nothing recorded or sent", crew.posts.length === postsBefore);
await page.keyboard.press("Escape");
check("no request left this server", crew.others.length === 0, crew.others.slice(0, 3).join(", "));
check("no page errors", !crew.logs.some((l) => l.startsWith("PAGEERROR")), crew.logs.filter((l) => l.startsWith("PAGEERROR")).join(" | "));

// ---------------------------------------------------------------- the flight surgeon: view only
const doc = await newPage(surgeonUid);
await doc.page.goto(base + "/mind");
await doc.page.getByRole("heading", { name: "How your voice sounded" }).waitFor({ timeout: 15000 });
if (ready) check("surgeon sees the voice tone card", await doc.page.getByText(/Last talk/).isVisible());
check("surgeon can't start a talk", await doc.page.getByRole("button", { name: "Talk to Astra" }).isDisabled());
const forged = await doc.page.evaluate(async (a) => (await fetch(`/api/astronauts/${a}/voice-tone?talk=x`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: new Uint8Array(100) })).status, aid);
check("surgeon can't post a clip for a crew member", forged === 403);

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
console.log("\n--- [astra] console (crew) ---\n" + crew.logs.join("\n"));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
