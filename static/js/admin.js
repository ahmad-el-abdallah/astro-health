// Admin tab: tag registry, unknown-tag assign popup, renaming astronauts,
// reset demo data, CSV export (docs/build-prompt.md section 9.11).
const AdminTab = (() => {
  function init() {
    document.getElementById("tab-admin").innerHTML = `
      <h2>Admin</h2>
      <div class="card" id="admin-unknown" style="display:none; border-color:var(--yellow)">
        <h3>New tag scanned</h3>
        <p class="dim">UID: <code id="unknown-uid"></code></p>
        <label>Assign as</label>
        <select id="unknown-kind">
          <option value="astronaut">Astronaut card</option>
          <option value="surgeon">Flight surgeon card</option>
          <option value="exercise">Exercise equipment</option>
          <option value="sleep">Sleep station</option>
          <option value="meal">Food packet</option>
          <option value="medicine">Medicine kit item</option>
          <option value="bp_guide">Blood pressure cuff</option>
          <option value="emergency">Emergency card</option>
        </select>
        <div id="unknown-astro-picker" style="display:none">
          <label>Astronaut</label>
          <select id="unknown-astro-select"></select>
        </div>
        <label>Label</label>
        <input id="unknown-label" placeholder="e.g. Treadmill">
        <button class="btn" id="unknown-save-btn">Assign</button>
        <button class="btn secondary" id="unknown-dismiss-btn">Dismiss</button>
      </div>

      <div class="card">
        <h3>Crew names</h3>
        <div id="admin-crew-names"></div>
      </div>

      <div class="card">
        <h3>Tag registry</h3>
        <table style="width:100%; border-collapse:collapse" id="admin-tags-table"></table>
      </div>

      <div class="card">
        <h3>Data</h3>
        <button class="btn danger" id="reset-demo-btn">Reset demo data</button>
        <div id="export-links" style="margin-top:10px"></div>
      </div>`;

    document.getElementById("unknown-kind").addEventListener("change", (e) => {
      document.getElementById("unknown-astro-picker").style.display = e.target.value === "astronaut" ? "block" : "none";
    });
    document.getElementById("unknown-save-btn").addEventListener("click", assignUnknownTag);
    document.getElementById("unknown-dismiss-btn").addEventListener("click", () => {
      document.getElementById("admin-unknown").style.display = "none";
    });
    document.getElementById("reset-demo-btn").addEventListener("click", resetDemo);
  }

  async function onShow() {
    await refreshTable();
    await refreshCrewNames();
    await refreshExportLinks();
  }

  async function refreshTable() {
    const tags = await api("/tags");
    const table = document.getElementById("admin-tags-table");
    table.innerHTML = `<tr><th style="text-align:left">UID</th><th style="text-align:left">Type</th>
      <th style="text-align:left">Label</th><th></th></tr>` + tags.map((t) => `
      <tr style="border-top:1px solid var(--border)">
        <td><code>${t.uid}</code></td><td>${t.type}</td><td>${t.label}</td>
        <td><button class="btn secondary" data-del="${t.uid}">Delete</button></td>
      </tr>`).join("");
    table.querySelectorAll("[data-del]").forEach((btn) => btn.addEventListener("click", async () => {
      await api(`/tags/${btn.dataset.del}`, { method: "DELETE" });
      refreshTable();
    }));
  }

  async function refreshCrewNames() {
    const crew = await api("/crew");
    document.getElementById("admin-crew-names").innerHTML = crew.map((a) => `
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
    const crew = await api("/crew");
    document.getElementById("export-links").innerHTML = crew.map((a) =>
      `<a class="btn secondary" style="display:inline-block;margin:4px" href="/api/export/${a.id}.csv">Send to Earth: ${a.name}.csv</a>`).join("");
  }

  async function resetDemo() {
    if (!confirm(STRINGS.resetDemoConfirm)) return;
    await api("/reset-demo", { method: "POST" });
    onShow();
  }

  async function assignUnknownTag() {
    const uid = document.getElementById("unknown-uid").textContent;
    const kind = document.getElementById("unknown-kind").value;
    const label = document.getElementById("unknown-label").value || uid;
    const body = { uid, type: kind, label };
    if (kind === "astronaut") body.astronaut_id = Number(document.getElementById("unknown-astro-select").value);
    await api("/tags", { method: "POST", body: JSON.stringify(body) });
    document.getElementById("admin-unknown").style.display = "none";
    refreshTable();
  }

  async function showUnknownPopup(uid) {
    document.getElementById("admin-unknown").style.display = "block";
    document.getElementById("unknown-uid").textContent = uid;
    document.getElementById("unknown-label").value = "";
    const crew = await api("/crew");
    document.getElementById("unknown-astro-select").innerHTML = crew.map((a) => `<option value="${a.id}">${a.name}</option>`).join("");
    showTab("admin");
  }

  Bus.on("unknown_tag", (d) => showUnknownPopup(d.uid));
  Bus.on("data_reset", onShow);

  return { init, onShow };
})();
registerTab("admin", AdminTab);
