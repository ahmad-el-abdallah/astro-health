// One Socket.IO connection for the whole app (port of static/js/core/socket.js). Pages
// subscribe with useSocketEvent(); the server pushes every state change, nothing polls.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { io } from "socket.io-client";
import { post } from "./api.js";

export const socket = io({ transports: ["websocket", "polling"] });

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
  cyd_event: [["summary"], ["history"], ["crew"], ["journal"], ["schedule"]],
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
};
