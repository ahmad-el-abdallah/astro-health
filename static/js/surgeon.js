// Flight Surgeon tab: alert inbox, crew reports and a delayed reply box
// (docs/build-prompt.md section 9.5). Built to also work well on a phone.
// No separate unlock step anymore -- signing in as the Flight Surgeon
// (backend/auth.py) is the unlock; this tab is simply hidden from anyone
// else's nav (templates/index.html's [data-surgeon-only]), and every
// fetch here is guarded by isSurgeon() too in case a Bus event fires
// while some other tab is showing.
const SurgeonTab = (() => {
  let countdownTimer = null;

  function init() {
    document.getElementById("tab-surgeon").innerHTML = `
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
      <h3>Crew names</h3>
      <div class="card" id="surgeon-crew-names"></div>
      <h3>Data</h3>
      <div class="card">
        <button class="btn danger" id="surgeon-reset-demo-btn">Reset demo data</button>
        <div id="surgeon-export-links" style="margin-top:10px"></div>
      </div>`;
    document.getElementById("surgeon-reply-btn").addEventListener("click", sendReply);
    document.getElementById("surgeon-reset-demo-btn").addEventListener("click", resetDemo);
    if (!countdownTimer) countdownTimer = setInterval(refresh, 1000);
  }

  async function onShow() {
    if (!isSurgeon()) return;
    const select = document.getElementById("surgeon-reply-astro");
    if (!select.options.length) {
      const crew = await api("/crew");
      select.innerHTML = crew.map((a) => `<option value="${a.id}">${a.name}</option>`).join("");
    }
    refresh();
    refreshCrewNames();
    refreshExportLinks();
  }

  // ---- crew names + data (moved here from the old Admin tab, which is now
  // the superuser-only /admin page -- see docs/CLAUDE.md's "Superuser admin
  // page". Renaming/reset-demo/exports stay Flight-Surgeon tools, unlike
  // tag assignment and role-setting, which moved to the new page.) ----
  async function refreshCrewNames() {
    if (!isSurgeon()) return;
    const crew = await api("/crew");
    document.getElementById("surgeon-crew-names").innerHTML = crew.map((a) => `
      <div style="display:flex; gap:8px; margin-bottom:8px;">
        <input value="${a.name}" data-rename="${a.id}">
        <button class="btn secondary" data-save-name="${a.id}">Save</button>
      </div>`).join("");
    document.querySelectorAll("[data-save-name]").forEach((btn) => btn.addEventListener("click", async () => {
      const id = btn.dataset.saveName;
      const name = document.querySelector(`[data-rename="${id}"]`).value;
      await api(`/astronauts/${id}`, { method: "PUT", body: JSON.stringify({ name }) });
      CrewTab.onShow && CrewTab.onShow();
    }));
  }

  async function refreshExportLinks() {
    if (!isSurgeon()) return;
    const crew = await api("/crew");
    document.getElementById("surgeon-export-links").innerHTML = crew.map((a) =>
      `<a class="btn secondary" style="display:inline-block;margin:4px" href="/api/export/${a.id}.csv">Send to Earth: ${a.name}.csv</a>`).join("");
  }

  async function resetDemo() {
    if (!confirm(STRINGS.resetDemoConfirm)) return;
    await api("/reset-demo", { method: "POST" });
    onShow();
  }

  async function refresh() {
    if (!isSurgeon()) return;
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

  Bus.on("alert", refresh);
  Bus.on("message_delivered", refresh);
  Bus.on("data_reset", onShow);

  return { init, onShow };
})();
registerTab("surgeon", SurgeonTab);
