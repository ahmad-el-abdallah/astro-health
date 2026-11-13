// "Astra" wake word: say the AI's name from any page and the voice screen opens.
// Uses the browser's own continuous SpeechRecognition (Chrome/Edge) -- while it's on, the
// microphone stays open and (in Chrome) the audio goes to Google to be turned into text, all
// the time, not only after the name. Only FINAL phrases are checked, so it never fires on a
// half-heard word. See docs/CLAUDE.md "Astra wake word".

// The name, as speech recognition writes it. Exact list first, then anything ONE letter away
// from "astra" (Astro, Austra, Ostra, Asta, Astral, Astra's…), so a noisy room's mishearing
// still wakes her. "Extra", "pasta", "Austria" and "astronaut" are 2+ letters away and never
// match, and "Astro Health" (the app's own name) is skipped.
const LEADS = new Set(["hey", "hi", "ok", "okay"]);
const EXTRA_NAMES = new Set(["astrid", "astrah", "asstra", "aastra"]);

function oneEditAway(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

const clean = (w) => w.toLowerCase().replace(/[^a-z]/g, "");
export function isName(word, next = "") {
  const w = clean(word);
  if (w.length < 4 || w.length > 7) return false;
  if (w === "astro" && clean(next) === "health") return false;
  return EXTRA_NAMES.has(w) || oneEditAway(w, "astra");
}

/** null if the phrase doesn't call Astra, else { question } -- the words after the name
 *  ("" when the name was said on its own). */
export function findWakeCommand(text) {
  if (!text) return null;
  const words = String(text).trim().split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    if (!isName(words[i], words[i + 1])) continue;
    const question = words.slice(i + 1).join(" ").replace(/^[\s,.!?:;'-]+/, "").trim();
    return { question };
  }
  return null;
}

/**
 * A background listener that keeps itself running:
 *   createWakeListener({ Recognition, onWake, onState, accept })
 *   -> { start, stop, pause, resume }
 * onWake({ question }) when a final phrase calls Astra and accept({ question, confidence })
 * agrees it was the astronaut (loud and clear enough, lib/hearing.js). onState(state) with
 * "listening" | "paused" | "blocked" | "off". Restarts on every `end` (browsers end
 * continuous recognition on their own every so often), backing off 0.3 s -> 5 s after
 * errors; a denied microphone ("not-allowed") stops it for good (state "blocked").
 * Watchdog: browsers sometimes stop hearing WITHOUT firing "end" (a network hiccup, the
 * mic switching, the tab sleeping) -- if a session goes WATCHDOG_MS with no event at all,
 * it's thrown away and a fresh one started. restart() does the same on demand (the app
 * calls it when the tab becomes visible again).
 */
export const WATCHDOG_MS = 45000;

export function createWakeListener({
  Recognition, onWake, onState, accept = () => true, schedule = setTimeout, unschedule = clearTimeout,
  every = setInterval, unevery = clearInterval, now = () => Date.now(), watchdogMs = WATCHDOG_MS,
  interimMs = 1000,
}) {
  let rec = null;
  let running = false;
  let paused = false;
  let failures = 0;
  let timer = null;
  let lastEvent = now();
  let watchdog = null;
  let disarmSession = null; // drops a half-heard wake when the session is thrown away
  const set = (s) => onState?.(s);
  const alive = () => { lastEvent = now(); };

  function teardown() {
    unschedule(timer);
    timer = null;
    disarmSession?.();
    if (rec) {
      rec.onend = null;
      rec.onerror = null;
      rec.onresult = null;
      try { rec.abort(); } catch { /* already stopped */ }
      rec = null;
    }
  }

  function boot() {
    timer = null;
    if (!running || paused || rec) return;
    const r = new Recognition();
    r.lang = "en-US";
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 3; // the name is sometimes only in the 2nd/3rd guess
    r.onstart = alive;
    r.onaudiostart = alive;
    r.onsoundstart = alive;
    r.onspeechstart = alive;
    // Each phrase (result index) can wake her once. A FINAL phrase wakes her at once. A
    // phrase still "in progress" that already contains the name wakes her too if the browser
    // doesn't finish it soon (Chrome sometimes never does, or ends the session first) --
    // that used to be lost.
    const fired = new Set();
    let armed = null; // { i, hit, timer }
    const disarm = () => { if (armed) { unschedule(armed.timer); armed = null; } };
    disarmSession = disarm;
    const fire = (i, hit, how) => {
      disarm();
      if (fired.has(i) || !running || paused) return;
      fired.add(i);
      // Last check (lib/hearing.js): loud and clear enough to be the astronaut, not the room?
      if (!accept(hit)) { console.debug(`[astra] ignored "${hit.heard}" (too quiet or unclear: probably the room)`); return; }
      console.info(`[astra] wake word (${how}): "${hit.question}"`);
      onWake?.({ question: hit.question });
    };
    const hitIn = (res) => {
      for (let a = 0; a < (res.length || 1); a++) {
        const hit = findWakeCommand(res[a]?.transcript);
        if (hit) return { ...hit, confidence: res[a]?.confidence, heard: res[a]?.transcript };
      }
      return null;
    };
    r.onresult = (e) => {
      alive();
      failures = 0;
      for (let i = e.resultIndex ?? 0; i < e.results.length; i++) {
        const res = e.results[i];
        if (fired.has(i)) continue;
        const hit = hitIn(res);
        if (res.isFinal) {
          if (hit) fire(i, hit, "final");
          else if (armed?.i === i) disarm();
          else console.debug(`[astra] heard (no name): "${res[0]?.transcript || ""}"`);
        } else if (hit) {
          disarm();
          const t = schedule(() => { if (armed?.i === i) fire(i, armed.hit, "unfinished"); }, hit.question ? interimMs * 1.5 : interimMs);
          armed = { i, hit, timer: t };
        }
      }
    };
    r.onerror = (e) => {
      alive();
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        running = false;
        set("blocked");
      } else if (e.error !== "no-speech" && e.error !== "aborted") {
        failures += 1;
      }
    };
    r.onend = () => {
      if (armed) fire(armed.i, armed.hit, "session ended");
      rec = null;
      if (!running || paused) return;
      // Back on quickly: anything said in the gap is lost.
      const delay = failures ? Math.min(5000, 300 * 2 ** (failures - 1)) : 100;
      timer = schedule(boot, delay);
    };
    rec = r;
    alive();
    try {
      r.start();
      set("listening");
    } catch {
      rec = null;
      failures += 1;
      timer = schedule(boot, 1000);
    }
  }

  function restart(why) {
    if (!running || paused) return;
    if (why) console.warn(`[astra] restarting the wake-word listener (${why})`);
    teardown();
    boot();
  }

  function check() {
    if (running && !paused && rec && now() - lastEvent > watchdogMs) restart("no sound events for a while");
  }

  return {
    start() {
      running = true; paused = false; failures = 0;
      unevery(watchdog);
      watchdog = every(check, Math.min(10000, watchdogMs));
      boot();
    },
    stop() { running = false; unevery(watchdog); watchdog = null; teardown(); set("off"); },
    pause() { if (!running) return; paused = true; teardown(); set("paused"); },
    resume() { if (!running || !paused) return; paused = false; boot(); },
    restart: () => restart("asked to"),
  };
}
