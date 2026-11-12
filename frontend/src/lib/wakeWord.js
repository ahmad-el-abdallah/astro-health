// "Astra" wake word: say the AI's name from any page and the voice screen opens.
// Uses the browser's own continuous SpeechRecognition (Chrome/Edge) -- while it's on, the
// microphone stays open and (in Chrome) the audio goes to Google to be turned into text, all
// the time, not only after the name. Only FINAL phrases are checked, so it never fires on a
// half-heard word. See docs/CLAUDE.md "Astra wake word".

// "astra", optionally after "hey/hi/ok/okay", plus the ways speech recognition commonly
// mishears it ("Astro", "Austra", "Ostra", "Astrid"). Word boundaries keep "astronaut" and
// "extra" from matching, and "Astro Health" (the app's name) is excluded.
const WAKE = /\b(?:(?:hey|hi|ok|okay)[\s,]+)?(?:astra|astrah|asstra|aastra|austra|ostra|astrid|astro(?![\s,]+health))\b[\s,.!?:;-]*(.*)$/i;

/** null if the phrase doesn't call Astra, else { question } -- the words after the name
 *  ("" when the name was said on its own). */
export function findWakeCommand(text) {
  if (!text) return null;
  const m = String(text).match(WAKE);
  if (!m) return null;
  const question = m[1].replace(/^[\s,.!?:;'-]+/, "").replace(/\s+/g, " ").trim();
  return { question };
}

/**
 * A background listener that keeps itself running:
 *   createWakeListener({ Recognition, onWake, onState })
 *   -> { start, stop, pause, resume }
 * onWake({ question }) when a final phrase calls Astra. onState(state) with
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
  Recognition, onWake, onState, schedule = setTimeout, unschedule = clearTimeout,
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
      console.info(`[astra] wake word (${how}): "${hit.question}"`);
      onWake?.(hit);
    };
    const hitIn = (res) => {
      for (let a = 0; a < (res.length || 1); a++) {
        const hit = findWakeCommand(res[a]?.transcript);
        if (hit) return hit;
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
