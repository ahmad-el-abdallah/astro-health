// Simulator panel (collapsible, on every tab): fakes every tag tap and CYD
// event through the exact same code path as real serial messages
// (docs/build-prompt.md section 9.12). bridge.inject() on the backend is
// what makes that true -- this file just builds the buttons.
const SimulatorPanel = (() => {
  let astroUidByValue = {};

  function init() {
    document.getElementById("sim-toggle").addEventListener("click", () => {
      document.getElementById("simulator-panel").classList.toggle("collapsed");
    });
    document.querySelectorAll("[data-sim-event]").forEach((btn) => {
      btn.addEventListener("click", () => sendEvent(btn.dataset.simEvent));
    });
    loadTags();
    Bus.on("serial_log", logLine);
    Bus.on("data_reset", loadTags);
  }

  async function loadTags() {
    const tags = await api("/tags");
    const cardButtons = document.getElementById("sim-crew-cards");
    const objectButtons = document.getElementById("sim-object-tags");
    const select = document.getElementById("sim-event-astro");
    cardButtons.innerHTML = "";
    objectButtons.innerHTML = "";
    select.innerHTML = "";
    astroUidByValue = {};

    tags.forEach((t) => {
      const btn = document.createElement("button");
      btn.textContent = t.label;
      btn.title = t.uid;
      btn.addEventListener("click", () => scan(t.uid));
      if (t.type === "astronaut" || t.type === "surgeon" || t.type === "emergency") {
        cardButtons.appendChild(btn);
      } else {
        objectButtons.appendChild(btn);
      }
      if (t.type === "astronaut") {
        const opt = document.createElement("option");
        opt.value = t.uid;
        opt.textContent = t.label;
        select.appendChild(opt);
      }
    });
  }

  function scan(uid) {
    api("/simulate/scan", { method: "POST", body: JSON.stringify({ uid }) });
  }

  function sendEvent(kind) {
    const uid = document.getElementById("sim-event-astro").value;
    if (!uid) return;
    const byKind = {
      mood: { type: "mood", uid, value: 4 },
      symptoms: { type: "symptoms", uid, items: ["headache"] },
      reaction_normal: { type: "reaction", uid, trials_ms: [320, 310, 330, 300, 340, 315, 325, 310, 330, 320], avg_ms: 320, lapses: 0, false_starts: 0 },
      reaction_slow: { type: "reaction", uid, trials_ms: [470, 490, 460, 510, 480, 500, 470, 520, 490, 505], avg_ms: 490, lapses: 1, false_starts: 0 },
      breathing_done: { type: "breathing_done", uid, seconds: 60 },
      emergency: { type: "emergency", uid },
      done: { type: "end_session", uid },
    };
    const msg = byKind[kind];
    if (msg) api("/simulate/event", { method: "POST", body: JSON.stringify(msg) });
  }

  function logLine({ direction, line }) {
    const log = document.getElementById("sim-log");
    const div = document.createElement("div");
    div.className = direction === "out" ? "out" : "";
    div.textContent = (direction === "out" ? "↑ " : "↓ ") + (typeof line === "string" ? line : JSON.stringify(line));
    log.appendChild(div);
    while (log.children.length > 80) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }

  return { init };
})();
registerTab("simulator", SimulatorPanel);
