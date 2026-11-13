// How Astra tells YOUR voice from the room around you.
//
// The browser's speech recognition hears everything: the person at the laptop, someone across
// the room, a fan, a video. Two cheap signals separate them:
//   * loudness -- the person talking to Astra is close to the microphone, so their speech is
//     clearly louder than the room's background. A level tracker keeps the last few seconds of
//     microphone levels; the background ("noise floor") is the quiet end of that, and speech
//     must rise well above it.
//   * confidence -- the recognizer's own 0..1 score for what it heard; noise turned into words
//     usually scores low.
// The "room" setting (per browser, localStorage "ah-astra-hearing") picks how strict:
//   quiet  -- no gates at all: catches a soft voice from across a quiet room
//   normal -- the default: speech must be clearly above the background
//   noisy  -- busy room: louder and clearer speech only, and 3 new words to talk over her
// Every gate fails OPEN: no microphone level (meter not running, sound not unlocked yet) or no
// confidence score means "let it through", so a gate can never make Astra deaf.

export const ROOMS = {
  quiet: { label: "Quiet room", ratio: 0, minLevel: 0, minConfidence: 0, bargeWords: 2 },
  normal: { label: "Normal", ratio: 2.2, minLevel: 0.025, minConfidence: 0.3, bargeWords: 2 },
  noisy: { label: "Noisy room", ratio: 3.2, minLevel: 0.045, minConfidence: 0.5, bargeWords: 3 },
};
export const ROOM_ORDER = ["quiet", "normal", "noisy"];
const KEY = "ah-astra-hearing";
const HISTORY_MS = 8000;

// ---- the room setting (a tiny store, so every screen follows a change at once) ----
let room = (() => {
  try { const v = localStorage.getItem(KEY); return v in ROOMS ? v : "normal"; } catch { return "normal"; }
})();
const listeners = new Set();
export const roomStore = {
  get: () => room,
  set(next) {
    if (!(next in ROOMS) || next === room) return;
    room = next;
    try { localStorage.setItem(KEY, next); } catch { /* just not remembered */ }
    listeners.forEach((l) => l());
  },
  subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
};
export const roomSettings = (r = room) => ROOMS[r] || ROOMS.normal;

// ---- microphone level history ----
export function createLevelTracker({ historyMs = HISTORY_MS } = {}) {
  let samples = []; // { t, level }
  return {
    push(level, t) {
      samples.push({ t, level });
      const cutoff = t - historyMs;
      if (samples.length > 400 || samples[0].t < cutoff) samples = samples.filter((s) => s.t >= cutoff);
    },
    /** The room's background: the quiet end (20th percentile) of recent levels. */
    floor() {
      if (!samples.length) return 0;
      const sorted = samples.map((s) => s.level).sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length * 0.2)];
    },
    peakSince(t) {
      let p = 0;
      for (const s of samples) if (s.t >= t && s.level > p) p = s.level;
      return p;
    },
    count: () => samples.length,
    reset() { samples = []; },
  };
}

/** Was there speech loud enough to be YOU (not the room) since `sinceMs`? */
export function loudEnough(tracker, sinceMs, r = room, now = Date.now()) {
  const cfg = roomSettings(r);
  if (!cfg.ratio || !tracker || tracker.count() < 10) return true; // no gate / no data: let it through
  const peak = tracker.peakSince(now - sinceMs);
  if (peak === 0 && tracker.peakSince(now - HISTORY_MS) === 0) return true; // meter silent (sound locked)
  return peak >= Math.max(cfg.minLevel, tracker.floor() * cfg.ratio);
}

/** The recognizer's own score; 0 or missing means it didn't say, so it passes. */
export function confidentEnough(confidence, r = room) {
  const min = roomSettings(r).minConfidence;
  return !min || !confidence || confidence >= min;
}

/** The one shared tracker, fed by stationAudio's micMeter. */
export const micLevels = createLevelTracker();
