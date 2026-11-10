// Thin wrapper around the Socket.IO client: a tiny pub/sub so each tab
// script can subscribe to just the events it cares about, without every
// tab needing to know about the raw `io()` connection.
const Bus = (() => {
  const listeners = {};
  return {
    on(event, fn) {
      (listeners[event] = listeners[event] || []).push(fn);
    },
    emit(event, data) {
      (listeners[event] || []).forEach((fn) => {
        try { fn(data); } catch (e) { console.error(`[bus] ${event} handler failed`, e); }
      });
    },
  };
})();

const socket = io();

const FORWARDED_EVENTS = [
  "serial_status", "serial_log", "scan", "session_started", "session_ended",
  "cyd_event", "assessment", "alert", "emergency", "message_delivered",
  "reminder", "points", "badge", "unknown_tag", "data_reset",
  "surgeon_unlocked", "mission_changed", "logout_requested",
];
FORWARDED_EVENTS.forEach((ev) => socket.on(ev, (data) => Bus.emit(ev, data)));
