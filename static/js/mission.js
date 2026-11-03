// Mission Health tab: how the chosen environment affects each body system,
// compared with the selected astronaut's live levels, plus what to monitor
// on this mission and why. Risk text and plans live in
// config/mission_health.json (PLACEHOLDER); live levels come from the same
// /summary endpoint the Body tab uses.
const MissionTab = (() => {
  const RISK_ORDER = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  // Flask sorts JSON keys alphabetically, so keep the journey order here.
  const PROFILE_ORDER = ["station", "lunar_base", "mars_transit", "mars_base", "rover"];
  const PROFILE_ICON = { station: "🛰️", lunar_base: "🌕", mars_transit: "🚀", mars_base: "🔴", rover: "🚙" };
  let contentCache = null;
  let rulesCache = null;
  let currentAstroId = null;

  function init() {
    document.getElementById("tab-mission").innerHTML = `
      <h2>Mission Health</h2>
      <p class="dim">Every environment stresses the body differently. Pick where the crew is to see
        which body systems are most at risk, how each astronaut is doing right now, and what to check.</p>
      <div class="mh-env-picker" id="mh-env-picker"></div>
      <div class="card mh-headline" id="mh-headline"></div>
      <div class="mh-section-head">
        <h3>What this mission does to your body</h3>
        <label class="mh-astro">Astronaut <select id="mh-astro-select"></select></label>
      </div>
      <div class="mh-legend dim">
        <span><b>Mission risk</b> = how hard this environment hits that body system.</span>
        <span><b>Now</b> = this astronaut's latest readings.</span>
      </div>
      <div class="card-grid" id="mh-body-grid"></div>
      <div class="mh-section-head">
        <h3>What to monitor on this mission</h3>
        <span class="pill" id="mh-progress">&ndash;</span>
      </div>
      <div class="card" id="mh-plan"></div>`;

    document.getElementById("mh-env-picker").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-profile]");
      if (btn && !btn.classList.contains("active")) setProfile(btn.dataset.profile);
    });
    document.getElementById("mh-astro-select").addEventListener("change", (e) => {
      currentAstroId = Number(e.target.value);
      window.selectedAstronautId = currentAstroId;
      onShow();
    });
    document.getElementById("mh-body-grid").addEventListener("click", (e) => {
      const card = e.target.closest("[data-part]");
      if (!card) return;
      if (currentAstroId) window.selectedAstronautId = currentAstroId;
      showTab("body");
    });
  }

  async function onShow() {
    if (!contentCache) contentCache = await api("/content");
    if (!rulesCache) rulesCache = await api("/health-rules");
    const [mission, crew] = await Promise.all([api("/mission"), api("/crew")]);

    const select = document.getElementById("mh-astro-select");
    if (!select.options.length && crew.length) {
      select.innerHTML = crew.map((a) => `<option value="${a.id}">${a.name}</option>`).join("");
    }
    currentAstroId = currentAstroId || window.selectedAstronautId || (crew[0] && crew[0].id);
    if (currentAstroId) select.value = currentAstroId;

    const summary = currentAstroId ? await api(`/astronauts/${currentAstroId}/summary`) : null;
    render(mission, summary);
  }

  function render(mission, summary) {
    renderPicker(mission);
    renderHeadline(mission);
    const plan = mission.health;
    if (!plan) {
      document.getElementById("mh-body-grid").innerHTML =
        `<p class="dim">No health plan for "${mission.profile_id}" yet. Add one to config/mission_health.json.</p>`;
      document.getElementById("mh-plan").innerHTML = "";
      return;
    }
    renderBody(plan, summary);
    renderPlan(plan, summary);
  }

  function renderPicker(mission) {
    const rank = (id) => (PROFILE_ORDER.indexOf(id) + 1) || 99;
    const entries = Object.entries(mission.all_profiles).sort((a, b) => rank(a[0]) - rank(b[0]));
    document.getElementById("mh-env-picker").innerHTML = entries.map(([id, p]) => `
      <button data-profile="${id}" class="${id === mission.profile_id ? "active" : ""}">
        <span class="mh-env-icon">${PROFILE_ICON[id] || "🌍"}</span>${p.label}
      </button>`).join("");
  }

  function renderHeadline(mission) {
    const p = mission.profile;
    const delay = typeof p.comms_delay_s === "number"
      ? (p.comms_delay_s >= 60 ? `${Math.round(p.comms_delay_s / 60)} min` : `${p.comms_delay_s} s`)
      : "same as base";
    const gravity = p.gravity_g === "same_as_base" ? "same as base" : `${p.gravity_g} g`;
    const hazards = (p.main_concerns || []).map((h) =>
      `<span class="mh-hazard">${(contentCache.hazards[h] || {}).label || h.replace(/_/g, " ")}</span>`).join("");
    document.getElementById("mh-headline").innerHTML = `
      <p class="mh-headline-text">${mission.health ? mission.health.headline : ""}</p>
      <div class="mh-stats">
        <div><div class="dim">Gravity</div><strong>${gravity}</strong></div>
        <div><div class="dim">Delay to Earth's doctors</div><strong>${delay}</strong></div>
        <div><div class="dim">Daily radiation (PLACEHOLDER)</div><strong>${p.daily_radiation_dose_uGy_PLACEHOLDER} &micro;Gy</strong></div>
      </div>
      <div class="mh-hazards"><span class="dim">Main hazards:</span> ${hazards}</div>`;
  }

  // A body system needs attention when the mission puts it at high/medium
  // risk AND the astronaut's current level for it isn't green.
  function attentionFor(risk, level) {
    if (level === "RED") return { cls: "mh-alert", text: "Act now: check the Body tab for what to do." };
    if (level === "YELLOW" && risk !== "LOW") return { cls: "mh-watch", text: "Watch closely: this mission makes it worse." };
    if (level === "GRAY" && risk === "HIGH") return { cls: "mh-nodata", text: "High risk, but no reading today. Measure it." };
    return null;
  }

  function renderBody(plan, summary) {
    const levels = (summary && summary.body_levels) || {};
    const parts = Object.entries(plan.body_risks)
      .sort((a, b) => RISK_ORDER[a[1].risk] - RISK_ORDER[b[1].risk]);
    document.getElementById("mh-body-grid").innerHTML = parts.map(([part, r]) => {
      const info = contentCache.body_parts[part] || { label: part };
      const level = levels[part] || "GRAY";
      const nowBadge = level === "GRAY"
        ? `<span class="level-badge GRAY">&#9679; Now: no data</span>`
        : levelBadge(level, "Now");
      const att = attentionFor(r.risk, level);
      return `
        <div class="card mh-part ${att ? att.cls : ""}" data-part="${part}">
          <div class="mh-part-head">
            <strong>${info.label}</strong>
            <span class="mh-risk ${r.risk}">Mission risk: ${r.risk}</span>
          </div>
          <div>${nowBadge}</div>
          <p class="mh-why">${r.why}</p>
          ${att ? `<div class="mh-att">${att.text}</div>` : ""}
        </div>`;
    }).join("");
  }

  function renderPlan(plan, summary) {
    const today = (summary && summary.today) || {};
    let done = 0;
    const rowsHtml = plan.monitoring.map((m) => {
      const label = (rulesCache.indicators[m.indicator] || {}).label || m.indicator;
      const reading = today[m.indicator];
      if (reading) done += 1;
      const status = reading
        ? `${levelBadge(reading.level)} <span class="dim">${fmtTime(reading.ts)}</span>`
        : `<span class="level-badge GRAY">&#9675; Not measured yet</span>`;
      return `
        <tr>
          <td><strong>${label}</strong></td>
          <td>${m.how_often}</td>
          <td class="mh-why">${m.why}</td>
          <td>${status}</td>
        </tr>`;
    }).join("");
    document.getElementById("mh-plan").innerHTML = `
      <table class="mh-table">
        <thead><tr><th>Check</th><th>How often</th><th>Why on this mission</th><th>Last 24 h</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>`;
    const total = plan.monitoring.length;
    const pill = document.getElementById("mh-progress");
    pill.textContent = `${done} of ${total} checks done in the last 24 h`;
    pill.classList.toggle("mh-progress-done", done === total);
  }

  async function setProfile(profileId) {
    await api("/mission", { method: "PUT", body: JSON.stringify({ profile_id: profileId }) });
    onShow();
  }

  function refreshIfVisible() {
    if (document.getElementById("tab-mission").classList.contains("active")) onShow();
  }

  Bus.on("mission_changed", refreshIfVisible);
  Bus.on("assessment", refreshIfVisible);
  Bus.on("cyd_event", refreshIfVisible);

  return { init, onShow };
})();
registerTab("mission", MissionTab);
