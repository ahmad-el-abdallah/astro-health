// One Socket.IO connection for the whole app (port of static/js/core/socket.js). Pages
// subscribe with useSocketEvent(); the server pushes every state change, nothing polls.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { io } from "socket.io-client";
import { post } from "./api.js";

// Reconnect quickly (the default backoff grows to 5 s, and any card tap made while the
// connection is down is never seen by this page -- see onReconnect below).
export const socket = io({ transports: ["websocket", "polling"], reconnectionDelay: 400, reconnectionDelayMax: 2000 });

// ---- connection health (docs/CLAUDE.md "Lost NFC scans") ----
// "online" | "offline" | "connecting", shown on the login screen. After a drop, every
// onReconnect() listener gets how long we were away (seconds) so it can catch up on what it
// missed -- e.g. AuthProvider replays a card tap made during that gap.
let downSince = null;
const reconnectListeners = new Set();
export function onReconnect(fn) {
  reconnectListeners.add(fn);
  return () => reconnectListeners.delete(fn);
}
socket.on("connect", () => {
  connectionStore.set("online");
  const gap = downSince === null ? null : (Date.now() - downSince) / 1000;
  downSince = null;
  if (gap !== null) reconnectListeners.forEach((fn) => fn(gap));
});
socket.on("disconnect", (reason) => {
  connectionStore.set("offline");
  if (downSince === null) downSince = Date.now();
  if (reason === "io server disconnect") socket.connect(); // the only case socket.io won't retry by itself
});
socket.on("connect_error", () => {
  connectionStore.set("offline");
  if (downSince === null) downSince = Date.now();
});
// Coming back to the tab / the network: don't wait for the next backoff step.
const nudge = () => { if (!socket.connected) socket.connect(); };
if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") nudge(); });
if (typeof window !== "undefined") window.addEventListener("online", nudge);

export function useSocketEvent(event, handler) {
  const ref = useRef(handler);
  useEffect(() => { ref.current = handler; });
  useEffect(() => {
    const fn = (data) => ref.current(data);
    socket.on(event, fn);
    return () => socket.off(event, fn);
  }, [event]);
}

// A few broadcasts must be remembered even if no component is mounted when they
// arrive -- e.g. the server sends serial_status once, right as the socket connects,
// which is before React has rendered anything. Tiny module-level stores fix that.
function createStore(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    get: () => value,
    set(next) { value = typeof next === "function" ? next(value) : next; listeners.forEach((l) => l()); },
    subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
  };
}

export const connectionStore = createStore(socket.connected ? "online" : "connecting");
export const serialStatusStore = createStore("connecting");
export const serialLogStore = createStore([]);
export const emergencyStore = createStore({ active: false, text: "" });

// The login page's own choice (docs/CLAUDE.md "web-only login"): does tapping a card
// also sign in the physical CYD, or just this browser? Persisted per-browser so it
// doesn't reset on every reload (defaults to "cyd", the long-standing behavior nobody's
// opted out of yet), and also pushed to the backend as its one current global mode
// (sessions.current_scan_mode) -- a REAL tap (the Pico, the only NFC reader this whole
// system has) sends a bare {"type":"scan","uid":...} with no way to carry a browser's
// preference itself, so the backend has to already know which mode is current rather
// than being told per-tap. Pushed again once here at module load (not just on change)
// so a page load after a server restart reconciles the two -- the backend's own copy is
// in-memory only and resets to "cyd" on every restart, this browser's doesn't.
const LOGIN_SCAN_MODE_KEY = "ah-login-scan-mode";
function loadScanMode() {
  try { return localStorage.getItem(LOGIN_SCAN_MODE_KEY) === "web" ? "web" : "cyd"; } catch { return "cyd"; }
}
export const loginScanModeStore = createStore(loadScanMode());
export function setLoginScanMode(mode) {
  loginScanModeStore.set(mode);
  try { localStorage.setItem(LOGIN_SCAN_MODE_KEY, mode); } catch { /* private window etc. -- in-memory store still works */ }
  post("/scan-mode", { mode }).catch(() => {});
}
setLoginScanMode(loginScanModeStore.get());
// The backend keeps this choice in memory only: a server restart resets it to "cyd", so
// re-send this browser's choice whenever the connection comes back.
onReconnect(() => post("/scan-mode", { mode: loginScanModeStore.get() }).catch(() => {}));

socket.on("serial_status", (d) => serialStatusStore.set(d?.status || "connecting"));
socket.on("serial_log", (d) => serialLogStore.set((log) => [...log.slice(-79), { ...d, at: Date.now() }]));
socket.on("emergency", (d) => emergencyStore.set({ active: !!d?.active, text: d?.text || "" }));

export const useStore = (store) => useSyncExternalStore(store.subscribe, store.get);

// Which cached server data each broadcast makes stale. The matching queries refetch in
// the background and the UI tweens to the new values -- no full-page re-render.
export const EVENT_INVALIDATIONS = {
  assessment: [["summary"], ["history"], ["crew"], ["alerts"], ["schedule"]],
  analysis: [["summary"], ["history"], ["crew"], ["alerts"]],
  analysis_pending: [["summary"], ["crew"]],
  cyd_event: [["summary"], ["history"], ["crew"], ["journal"], ["schedule"], ["exercise"]],
  reminder: [["schedule"]],
  session_started: [["summary"], ["crew"]],
  session_ended: [["summary"], ["crew"]],
  alert: [["alerts"], ["crew"], ["messages"], ["thread"]],
  alert_acknowledged: [["alerts"], ["crew"]],
  crew_updated: [["crew"], ["summary"], ["tags"], ["admin-astronauts"]],
  tags_changed: [["tags"], ["admin-astronauts"], ["crew"]],
  message_delivered: [["messages"], ["thread"]],
  message_sent: [["messages"], ["thread"]],
  mission_changed: [["mission"]],
  unknown_tag: [["admin-unknown"]],
  astra_memory: [["memory"]],
  astra_followup: [["memory"]],
};
