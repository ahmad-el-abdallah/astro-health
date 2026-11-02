// Tab switching, header status pills, and the emergency overlay. Each tab
// script registers itself on `Tabs` with an init() (build the DOM once)
// and an optional onShow() (refresh when the tab becomes visible).
const Tabs = {};

function registerTab(name, controller) {
  Tabs[name] = controller;
}

function showTab(name) {
  document.querySelectorAll(".tab-panel").forEach((el) => el.classList.remove("active"));
  document.querySelectorAll("#tab-nav button").forEach((el) => el.classList.remove("active"));
  document.getElementById(`tab-${name}`).classList.add("active");
  document.querySelector(`#tab-nav button[data-tab="${name}"]`).classList.add("active");
  if (Tabs[name] && Tabs[name].onShow) Tabs[name].onShow();
}

document.getElementById("tab-nav").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-tab]");
  if (btn) showTab(btn.dataset.tab);
});

function levelBadge(level, label) {
  const word = STRINGS.levelWord[level] || level;
  return `<span class="level-badge ${level}">&#9679; ${label ? label + ": " : ""}${word}</span>`;
}

function fmtTime(iso) {
  if (!iso) return "never";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

async function api(path, options) {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  const ct = res.headers.get("content-type") || "";
  return ct.includes("json") ? res.json() : res.text();
}

// ---- header: serial status pill ----
function setSerialStatus(status) {
  const dot = document.querySelector("#serial-status-pill .pill-dot");
  const text = document.getElementById("serial-status-text");
  dot.className = "pill-dot " + ({ connected: "ok", simulation: "warn", connecting: "warn", reconnecting: "bad" }[status] || "");
  text.textContent = STRINGS.serialStatus[status] || status;
}
Bus.on("serial_status", (d) => setSerialStatus(d.status));

// ---- header: mission pill ----
async function refreshMissionPill() {
  try {
    const mission = await api("/mission");
    document.getElementById("mission-pill").textContent = `Mission: ${mission.profile.label}`;
  } catch (e) { /* no-op: mission tab will show the real error */ }
}
Bus.on("mission_changed", refreshMissionPill);

// ---- emergency overlay ----
function setEmergency(active, text) {
  const overlay = document.getElementById("emergency-overlay");
  overlay.classList.toggle("active", !!active);
  if (text) document.getElementById("emergency-text").textContent = text;
}
Bus.on("emergency", (d) => setEmergency(d.active, d.text));
document.getElementById("emergency-cancel-btn").addEventListener("click", () => {
  api("/emergency", { method: "POST", body: JSON.stringify({ action: "cancel" }) });
});

// A small celebration toast for points/badges (respects prefers-reduced-motion via CSS).
function showToast(msg) {
  const el = document.createElement("div");
  el.className = "star-toast";
  el.textContent = msg;
  el.style.cssText = "position:fixed;top:70px;right:20px;background:var(--accent);color:#06201c;" +
    "padding:10px 16px;border-radius:8px;font-weight:600;z-index:200;box-shadow:0 4px 16px rgba(0,0,0,0.3);";
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

document.addEventListener("DOMContentLoaded", () => {
  Object.values(Tabs).forEach((t) => t.init && t.init());
  refreshMissionPill();
});
