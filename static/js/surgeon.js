// Flight Surgeon tab: unlocked by the surgeon card or PIN 1234. Alert
// inbox, crew reports and a delayed reply box (docs/build-prompt.md
// section 9.5). Built to also work well on a phone.
const SurgeonTab = (() => {
  let unlocked = false;
  let countdownTimer = null;

  function init() {
    document.getElementById("tab-surgeon").innerHTML = `
      <div id="surgeon-lock" class="card">
        <h2>Flight Surgeon</h2>
        <p class="dim">Tap the surgeon card on the CYD, or enter the demo PIN.</p>
        <input type="password" id="surgeon-pin" placeholder="PIN" style="max-width:160px">
        <button class="btn" id="surgeon-unlock-btn">Unlock</button>
      </div>
      <div id="surgeon-view" style="display:none">
        <h2>Flight Surgeon</h2>
        <h3>Alerts</h3>
        <div class="card" id="surgeon-alerts"></div>
        <h3>Crew reports</h3>
        <div class="card" id="surgeon-messages"></div>
        <h3>Reply to crew</h3>
        <div class="card">
          <label>Astronaut</label>
          <select id="surgeon-reply-astro"></select>
          <label>Message</label>
          <textarea id="surgeon-reply-body" rows="3" placeholder="Your reply..."></textarea>
          <button class="btn" id="surgeon-reply-btn">Send (arrives after the comms delay)</button>
          <div id="surgeon-reply-status" class="dim"></div>
        </div>
      </div>`;
    document.getElementById("surgeon-unlock-btn").addEventListener("click", tryPin);
    document.getElementById("surgeon-pin").addEventListener("keydown", (e) => { if (e.key === "Enter") tryPin(); });
    document.getElementById("surgeon-reply-btn").addEventListener("click", sendReply);
  }

  function tryPin() {
    if (document.getElementById("surgeon-pin").value === "1234") unlock();
    else document.getElementById("surgeon-pin").value = "";
  }

  async function unlock() {
    unlocked = true;
    document.getElementById("surgeon-lock").style.display = "none";
    document.getElementById("surgeon-view").style.display = "block";
    const crew = await api("/crew");
    document.getElementById("surgeon-reply-astro").innerHTML = crew.map((a) => `<option value="${a.id}">${a.name}</option>`).join("");
    refresh();
    if (!countdownTimer) countdownTimer = setInterval(refresh, 1000);
  }

  function onShow() { if (unlocked) refresh(); }

  async function refresh() {
    const [alerts, messages] = await Promise.all([api("/alerts"), api("/messages")]);
    document.getElementById("surgeon-alerts").innerHTML = alerts.length ? alerts.map((a) => `
      <div style="padding:6px 0; border-bottom:1px solid var(--border)">
        ${levelBadge(a.level)} ${a.text}
        <span class="dim">(${fmtTime(a.ts)})</span>
        ${a.acknowledged ? '<span class="dim">acknowledged</span>' : `<button class="btn secondary" data-ack="${a.id}">Acknowledge</button>`}
      </div>`).join("") : '<p class="dim">No alerts.</p>';
    document.getElementById("surgeon-alerts").querySelectorAll("[data-ack]").forEach((btn) =>
      btn.addEventListener("click", async () => { await api(`/alerts/${btn.dataset.ack}/ack`, { method: "POST" }); refresh(); }));

    const now = Date.now();
    document.getElementById("surgeon-messages").innerHTML = messages.length ? messages.map((m) => {
      const deliverAt = new Date(m.deliver_at).getTime();
      const remaining = deliverAt - now;
      const status = m.delivered || remaining <= 0
        ? `<span class="dim">delivered ${fmtTime(m.deliver_at)}</span>`
        : `<span class="dim">arrives in ${formatCountdown(remaining)}</span>`;
      return `<div style="padding:6px 0; border-bottom:1px solid var(--border)">
        <strong>${m.from_role}</strong>: ${m.body} ${status}</div>`;
    }).join("") : '<p class="dim">No reports yet.</p>';
  }

  function formatCountdown(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  async function sendReply() {
    const astroId = Number(document.getElementById("surgeon-reply-astro").value);
    const body = document.getElementById("surgeon-reply-body").value.trim();
    if (!body) return;
    const res = await api("/messages", { method: "POST", body: JSON.stringify({ astronaut_id: astroId, body }) });
    document.getElementById("surgeon-reply-status").textContent = `Sent. Arrives at ${fmtTime(res.deliver_at)}.`;
    document.getElementById("surgeon-reply-body").value = "";
    refresh();
  }

  Bus.on("surgeon_unlocked", unlock);
  Bus.on("alert", () => { if (unlocked) refresh(); });
  Bus.on("message_delivered", () => { if (unlocked) refresh(); });

  return { init, onShow };
})();
registerTab("surgeon", SurgeonTab);
