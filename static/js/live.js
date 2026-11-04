// Live tab: "Tap your card" until a card is scanned, then that astronaut's
// vitals form + today's status (docs/build-prompt.md section 9.1).
const LiveTab = (() => {
  let currentId = null;
  let contentCache = null;

  function formatIndicatorValue(indicator, value) {
    if (indicator === "blood_pressure") return `${value.systolic}/${value.diastolic}`;
    if (indicator === "reaction_time") return `${value.avg_ms} ms`;
    if (typeof value === "object") return JSON.stringify(value);
    return value;
  }

  function init() {
    document.getElementById("tab-live").innerHTML = `
      <div id="live-empty" class="card"></div>
      <div id="live-active" class="card" style="display:none">
        <div style="display:flex; align-items:center; gap:14px; margin-bottom:10px;">
          <div class="avatar" id="live-avatar">?</div>
          <div>
            <h2 id="live-name" style="margin:0">&ndash;</h2>
            <div class="dim" id="live-role">&ndash;</div>
          </div>
          <div style="margin-left:auto; text-align:right;">
            <div id="live-overall"></div>
            <div class="dim" id="live-points"></div>
          </div>
        </div>
        <div class="card-grid" id="live-indicator-grid"></div>
        <h3>Today's vitals
          <button class="btn secondary" id="simulate-btn" style="margin-left:10px; font-size:0.8em; padding:4px 10px;">Take a new reading</button>
        </h3>
        <div class="card-grid">
          <div class="vital-field"><label>Heart rate (bpm)</label>
            <span class="guide-link" data-guide="heart_rate">${STRINGS.howToMeasure}</span>
            <input type="number" id="in-hr" placeholder="e.g. 72"></div>
          <div class="vital-field"><label>Blood pressure (mmHg)</label>
            <span class="guide-link" data-guide="blood_pressure">${STRINGS.howToMeasure}</span>
            <div style="display:flex; gap:8px;">
              <input type="number" id="in-sys" placeholder="systolic">
              <input type="number" id="in-dia" placeholder="diastolic">
            </div></div>
          <div class="vital-field"><label>Blood sugar, fasting (mg/dL)</label>
            <span class="guide-link" data-guide="blood_sugar">${STRINGS.howToMeasure}</span>
            <input type="number" id="in-sugar" placeholder="e.g. 90"></div>
          <div class="vital-field"><label>Temperature (&deg;C)</label>
            <span class="guide-link" data-guide="temperature">${STRINGS.howToMeasure}</span>
            <input type="number" step="0.1" id="in-temp" placeholder="e.g. 36.8"></div>
        </div>
        <div id="guide-box" class="dim" style="display:none; margin-bottom:10px;"></div>
        <button class="btn" id="assess-btn">${STRINGS.assessButton}</button>
        <div id="assess-result" style="margin-top:10px;"></div>

        <h3>Report a symptom</h3>
        <p class="dim">Tap a symptom to see what to do about it, and to include it in your report.</p>
        <div class="card-grid" id="symptom-chips"></div>
        <div id="symptom-guidance" style="display:none; margin-top:10px;"></div>
        <button class="btn" id="symptom-confirm-btn" style="margin-top:10px;">Log symptoms</button>
        <div id="symptom-result" style="margin-top:8px;"></div>
      </div>`;

    document.getElementById("assess-btn").addEventListener("click", submitAssess);
    document.getElementById("simulate-btn").addEventListener("click", () => simulateVitals(currentId));
    document.getElementById("tab-live").addEventListener("click", (e) => {
      const g = e.target.closest(".guide-link");
      if (g) showGuide(g.dataset.guide);
      const chip = e.target.closest(".symptom-chip");
      if (chip) { chip.classList.toggle("active"); renderSymptomGuidance(); }
    });
    document.getElementById("symptom-confirm-btn").addEventListener("click", confirmSymptoms);

    renderSymptomChips();
    showEmpty();
  }

  let symptomCatalogCache = null;

  async function renderSymptomChips() {
    if (!symptomCatalogCache) symptomCatalogCache = await api("/symptoms/catalog");
    document.getElementById("symptom-chips").innerHTML = symptomCatalogCache
      .map((s) => `<button type="button" class="symptom-chip" data-id="${s.id}">${s.label}</button>`).join("");
  }

  function getSelectedSymptoms() {
    return [...document.querySelectorAll(".symptom-chip.active")].map((el) => el.dataset.id);
  }

  function renderSymptomGuidance() {
    const box = document.getElementById("symptom-guidance");
    const selected = getSelectedSymptoms();
    if (!selected.length || !symptomCatalogCache) { box.style.display = "none"; return; }
    box.style.display = "block";
    box.innerHTML = selected.map((id) => {
      const s = symptomCatalogCache.find((s) => s.id === id);
      return s ? `<div class="card" style="margin-bottom:8px;"><strong>${s.label}</strong><p class="dim" style="margin:4px 0 0">${s.guidance}</p></div>` : "";
    }).join("");
  }

  async function confirmSymptoms() {
    if (!currentId) return;
    const items = getSelectedSymptoms();
    const resultBox = document.getElementById("symptom-result");
    if (!items.length) {
      resultBox.innerHTML = `<span class="dim">Pick at least one symptom first.</span>`;
      return;
    }
    const result = await api(`/astronauts/${currentId}/symptoms`, { method: "POST", body: JSON.stringify({ items }) });
    resultBox.innerHTML = `${levelBadge(result.level, "Logged")}`;
    document.querySelectorAll(".symptom-chip.active").forEach((el) => el.classList.remove("active"));
    renderSymptomGuidance();
    loadSummary(currentId);
  }

  function onShow() { if (currentId) loadSummary(currentId); }

  async function showGuide(indicator) {
    if (!contentCache) contentCache = await api("/content");
    const guide = contentCache.measure_guides[indicator];
    const box = document.getElementById("guide-box");
    if (!guide) { box.style.display = "none"; return; }
    box.innerHTML = `<strong>${guide.title}</strong><ol>${guide.steps.map((s) => `<li>${s}</li>`).join("")}</ol>`;
    box.style.display = "block";
  }

  // "Tap your card" is instructions for an astronaut logging in with their
  // own card -- meaningless for the Flight Surgeon, who's never meant to
  // view her own Live data here, only a crew member's (via the Crew tab).
  // Show her the actual next step instead.
  function showEmpty() {
    currentId = null;
    document.getElementById("live-empty").innerHTML = isSurgeon()
      ? `<h2>Pick a crew member</h2><p class="dim">Go to the Crew tab and tap a card to view their Live data.</p>`
      : `<h2>${STRINGS.tapYourCard}</h2><p class="dim">Or use the Simulator panel (bottom right) to tap a card without the hardware.</p>`;
    document.getElementById("live-empty").style.display = "block";
    document.getElementById("live-active").style.display = "none";
  }

  async function loadSummary(id) {
    currentId = id;
    const summary = await api(`/astronauts/${id}/summary`);
    document.getElementById("live-empty").style.display = "none";
    document.getElementById("live-active").style.display = "block";
    const a = summary.astronaut;
    const avatar = document.getElementById("live-avatar");
    avatar.style.background = a.color;
    avatar.textContent = a.name.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();
    document.getElementById("live-name").textContent = a.name;
    document.getElementById("live-role").textContent = a.role;
    document.getElementById("live-overall").innerHTML = levelBadge(summary.overall_level, "Overall");
    document.getElementById("live-points").textContent = `${summary.points} pts · last check ${fmtTime(summary.last_check)}`;

    const grid = document.getElementById("live-indicator-grid");
    const entries = Object.entries(summary.today);
    let cards = entries.map(([ind, v]) => `<div class="card" style="margin-bottom:0">
            <div class="dim">${ind.replace("_", " ")}</div>
            <div class="big-number">${formatIndicatorValue(ind, v.value)}</div>
            ${levelBadge(v.level)}
          </div>`).join("");
    if (summary.symptoms_today) {
      if (!symptomCatalogCache) symptomCatalogCache = await api("/symptoms/catalog");
      const labels = summary.symptoms_today.items
        .map((id) => (symptomCatalogCache.find((s) => s.id === id) || { label: id }).label);
      cards += `<div class="card" style="margin-bottom:0">
            <div class="dim">symptoms</div>
            <div class="big-number" style="font-size:1.1em">${labels.join(", ")}</div>
            ${levelBadge(summary.symptoms_today.level)}
          </div>`;
    }
    grid.innerHTML = cards || `<p class="dim">No readings yet today &mdash; sleep, mood, symptoms and reaction time fill in from the CYD.</p>`;
  }

  async function simulateVitals(id) {
    if (!id) return;
    const v = await api(`/astronauts/${id}/simulate_vitals`);
    document.getElementById("in-hr").value = v.heart_rate;
    document.getElementById("in-sys").value = v.blood_pressure.systolic;
    document.getElementById("in-dia").value = v.blood_pressure.diastolic;
    document.getElementById("in-sugar").value = v.blood_sugar;
    document.getElementById("in-temp").value = v.temperature;
  }

  async function submitAssess() {
    if (!currentId) return;
    const body = {};
    const hr = document.getElementById("in-hr").value;
    const sys = document.getElementById("in-sys").value;
    const dia = document.getElementById("in-dia").value;
    const sugar = document.getElementById("in-sugar").value;
    const temp = document.getElementById("in-temp").value;
    if (hr) body.heart_rate = Number(hr);
    if (sys && dia) body.blood_pressure = { systolic: Number(sys), diastolic: Number(dia) };
    if (sugar) body.blood_sugar = Number(sugar);
    if (temp) body.temperature = Number(temp);
    const result = await api(`/astronauts/${currentId}/assess`, { method: "POST", body: JSON.stringify(body) });
    document.getElementById("assess-result").innerHTML =
      `${levelBadge(result.overall_level, "Result")} <span class="dim">${result.note}</span>`;
    loadSummary(currentId);
  }

  Bus.on("session_started", (d) => { loadSummary(d.astronaut_id); simulateVitals(d.astronaut_id); });
  Bus.on("session_ended", (d) => {
    if (d.astronaut_id !== currentId) return;
    // A CYD session ending (idle timeout, or re-tapping to toggle it off)
    // must not blank the Live tab for someone who's still signed in as
    // themselves in this browser -- the web login and the CYD's physical
    // session are deliberately separate (docs/CLAUDE.md). Only blank it
    // when nobody's own view this is, e.g. the surgeon was watching
    // someone else's session and it just ended.
    if (Auth.astronautId === currentId) return;
    showEmpty();
  });
  Bus.on("scan", (d) => { if (d.type === "astronaut") { /* session_started follows right after */ } });
  Bus.on("cyd_event", () => { if (currentId) loadSummary(currentId); });

  return { init, onShow, viewAstronaut: loadSummary, showEmpty };
})();
registerTab("live", LiveTab);
