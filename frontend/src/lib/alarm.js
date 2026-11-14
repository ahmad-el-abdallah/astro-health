// Emergency alarm: the "station klaxon" (frontend/public/sounds/emergency-alarm.wav, made
// for ASTRA: a two-tone horn, 4 cycles that loop seamlessly) plays while the emergency
// screen is up. WAV, not MP3, so the loop has no gap.
//
//   startAlarm() / stopAlarm()   play / stop the loop
//   setAlarmMuted(bool)          mute button on the emergency screen
//   unlockAlarm()                a click that lets the browser play sound (autoplay rules)
//   alarmStore                   { muted, blocked }
const SOUND_URL = "/sounds/emergency-alarm.wav";

// a tiny store, same shape as socket.js's (works with its useStore hook)
function createStore(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    get: () => value,
    set(next) { value = typeof next === "function" ? next(value) : next; listeners.forEach((l) => l()); },
    subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
  };
}
export const alarmStore = createStore({ muted: false, blocked: false });

let el = null;
function audio() {
  if (!el) { el = new Audio(SOUND_URL); el.loop = true; el.volume = 0.85; el.preload = "auto"; }
  return el;
}

export function startAlarm() {
  const a = audio();
  a.muted = alarmStore.get().muted;
  a.currentTime = 0;
  a.play()
    .then(() => alarmStore.set({ ...alarmStore.get(), blocked: false }))
    .catch(() => alarmStore.set({ ...alarmStore.get(), blocked: true }));   // browser wants a click first
}
export function stopAlarm() {
  if (!el) return;
  el.pause();
  el.currentTime = 0;
}
export function setAlarmMuted(muted) {
  alarmStore.set({ ...alarmStore.get(), muted });
  if (el) el.muted = muted;
}
export function unlockAlarm() {
  audio().play()
    .then(() => alarmStore.set({ ...alarmStore.get(), blocked: false }))
    .catch(() => {});
}
