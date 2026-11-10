// Sleep Lab tab: last night's sleep summary, an illustrative sleep-stages
// visual, a real 7/30-day trend chart, a manual "log tonight's sleep"
// fallback, and a circadian-rhythm note grounded in the active mission's
// real config (config/mission_health.json), not invented copy. No hardware
// in this project measures sleep stages, so that one visual is explicitly
// presented as illustrative -- everything else here is real data through
// the existing /summary + /history routes and the new POST .../sleep route.
// Visual language (card-kicker/card-heading) matches the Mental Health tab
// so the two read as a pair. See docs/CLAUDE.md.
const SleepLabTab = (() => {
  let currentAstroId = null;
  let missionCache = null;
  let rulesCache = null;
  let sleepChart = null;
  let trendDays = 7;

  // "sleep" readings come from two writers with two different value_json
  // shapes: a physical sleep-station object-tag toggle
  // (backend/logic/sessions.py) stores a bare hours number, while this
  // tab's own POST /sleep route stores a richer object
  // ({hours,bedtime,wake_time}). Handle both wherever hours is read back.
  function sleepHours(value) {
    return Number(typeof value === "object" && value ? value.hours : value);
  }

  // Illustrative only -- no hardware here measures actual sleep stages.
  const STAGE_SEGMENTS = [
    { cls: "stage-light", pct: 22 }, { cls: "stage-deep", pct: 18 }, { cls: "stage-rem", pct: 15 },
    { cls: "stage-light", pct: 20 }, { cls: "stage-deep", pct: 12 }, { cls: "stage-awake", pct: 3 },
    { cls: "stage-rem", pct: 10 },
  ];

  function init() {
    document.getElementById("tab-sleep").innerHTML = `
      <div class="sleep-health-page">
        <div class="sleep-hero">
          <div>
            <span class="section-kicker">SLEEP LAB</span>
            <h2>Sleep Lab</h2>
            <p>Sleep trends and how microgravity affects your circadian rhythm.</p>
          </div>
          <label class="dim" style="display:flex; align-items:center; gap:8px;">
            Astronaut <select id="sleep-astro-select"></select>
          </label>
        </div>

        <div class="sleep-dashboard">
          <div class="sleep-card sleep-summary-card">
            <div class="card-heading"><div><span class="card-kicker">LAST NIGHT</span><h3 id="sleep-summary-badge-wrap">Summary</h3></div></div>
            <div class="sleep-summary">
              <span class="sleep-summary-num" id="sleep-summary-hours">&ndash;</span>
              <span id="sleep-summary-badge"></span>
            </div>
            <div class="sleep-stats-row">
              <div><div class="sleep-stat-label">Bedtime</div><div class="sleep-stat-val" id="sleep-stat-bedtime">&ndash;</div></div>
              <div><div class="sleep-stat-label">Wake</div><div class="sleep-stat-val" id="sleep-stat-wake">&ndash;</div></div>
            </div>
            <button class="sleep-log-link" id="sleep-log-toggle">Log tonight's sleep manually</button>
            <div class="sleep-log-form" id="sleep-log-form" style="display:none;">
              <div class="field"><label for="sleep-bedtime-input">Bedtime</label><input id="sleep-bedtime-input" type="time" value="23:00"></div>
              <div class="field"><label for="sleep-wake-input">Wake time</label><input id="sleep-wake-input" type="time" value="07:00"></div>
              <button class="btn mental-primary-btn" id="sleep-log-save-btn">Save</button>
            </div>
          </div>

          <div class="sleep-card sleep-stages-card">
            <div class="card-heading"><div><span class="card-kicker">ILLUSTRATIVE</span><h3>Sleep stages</h3><p>Not measured by any hardware in this demo &mdash; for reference only.</p></div></div>
            <div class="sleep-stages-bar" id="sleep-stages-bar"></div>
            <div class="sleep-legend">
              <span class="sleep-legend-item"><span class="sleep-legend-dot" style="background:var(--red)"></span>Awake</span>
              <span class="sleep-legend-item"><span class="sleep-legend-dot" style="background:color-mix(in srgb, var(--accent) 45%, var(--gray))"></span>Light</span>
              <span class="sleep-legend-item"><span class="sleep-legend-dot" style="background:var(--accent)"></span>Deep</span>
              <span class="sleep-legend-item"><span class="sleep-legend-dot" style="background:color-mix(in srgb, var(--accent) 70%, var(--green) 30%)"></span>REM</span>
            </div>
          </div>

          <div class="sleep-card sleep-trend-card">
            <div class="card-heading">
              <div><span class="card-kicker">TREND</span><h3>Sleep over time</h3><p>Target: 7+ hours/night</p></div>
              <div class="sleep-trend-toggle" id="sleep-trend-toggle">
                <button data-days="7" class="active">7 days</button>
                <button data-days="30">30 days</button>
              </div>
            </div>
            <div class="sleep-chart-container"><canvas id="sleep-chart"></canvas></div>
          </div>

          <div class="sleep-card circadian-card">
            <div class="card-heading"><div><span class="card-kicker">MISSION CONTEXT</span><h3>Circadian rhythm</h3></div></div>
            <p class="dim" id="circadian-why">&ndash;</p>
            <p class="dim" id="circadian-monitor"></p>
          </div>

          <div class="sleep-card sleep-tips-card">
            <div class="card-heading"><div><span class="card-kicker">SELF-CARE</span><h3>Sleep hygiene tips</h3></div></div>
            <ul class="sleep-tips">
              <li>Keep lighting dim for the last hour before sleep.</li>
              <li>Stick to the same sleep and wake time, even on rest days.</li>
              <li>Avoid caffeine after your mission's midday mark.</li>
              <li>Exercise earlier in your day, not right before sleep.</li>
            </ul>
          </div>
        </div>
      </div>`;

    renderStages();
    document.getElementById("sleep-astro-select").addEventListener("change", (e) => {
      currentAstroId = Number(e.target.value);
      window.selectedAstronautId = currentAstroId;
      onShow();
    });
    document.getElementById("sleep-log-toggle").addEventListener("click", toggleLogForm);
    document.getElementById("sleep-log-save-btn").addEventListener("click", saveSleep);
    document.getElementById("sleep-trend-toggle").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-days]");
      if (!btn) return;
      document.querySelectorAll("#sleep-trend-toggle button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      trendDays = Number(btn.dataset.days);
      loadTrend();
    });
  }

  function renderStages() {
    document.getElementById("sleep-stages-bar").innerHTML = STAGE_SEGMENTS
      .map((s) => `<div class="${s.cls}" style="width:${s.pct}%"></div>`).join("");
  }

  async function onShow() {
    const select = document.getElementById("sleep-astro-select");
    const crew = await populateAstroSelect(select);
    if (!isSurgeon()) currentAstroId = Auth.astronautId;
    currentAstroId = currentAstroId || window.selectedAstronautId || (crew[0] && crew[0].id);
    if (!currentAstroId) return;
    select.value = currentAstroId;

    if (!missionCache) missionCache = await api("/mission");
    if (!rulesCache) rulesCache = await api("/health-rules");
    renderCircadian();

    const summary = await api(`/astronauts/${currentAstroId}/summary`);
    renderSummary(summary);
    await loadTrend();
  }

  function renderCircadian() {
    const brainRisk = missionCache.health && missionCache.health.body_risks.brain;
    document.getElementById("circadian-why").innerHTML = brainRisk
      ? `<strong>${missionCache.profile.label} &mdash; ${brainRisk.risk} risk.</strong> ${brainRisk.why}`
      : "No mission health plan configured for this profile yet.";
    const sleepMonitor = missionCache.health && missionCache.health.monitoring &&
      missionCache.health.monitoring.find((m) => m.indicator === "sleep");
    document.getElementById("circadian-monitor").textContent = sleepMonitor
      ? `Monitoring: ${sleepMonitor.how_often} — ${sleepMonitor.why}` : "";
  }

  function renderSummary(summary) {
    const reading = summary.today && summary.today.sleep;
    const hoursEl = document.getElementById("sleep-summary-hours");
    const badgeEl = document.getElementById("sleep-summary-badge");
    const bedtimeEl = document.getElementById("sleep-stat-bedtime");
    const wakeEl = document.getElementById("sleep-stat-wake");
    if (!reading) {
      hoursEl.textContent = "No data";
      badgeEl.innerHTML = "";
      bedtimeEl.textContent = "–";
      wakeEl.textContent = "–";
      return;
    }
    const v = typeof reading.value === "object" && reading.value ? reading.value : {};
    const hours = sleepHours(reading.value);
    const h = Math.floor(hours), m = Math.round((hours - h) * 60);
    hoursEl.textContent = `${h}h ${m}m`;
    badgeEl.innerHTML = levelBadge(reading.level);
    bedtimeEl.textContent = v.bedtime || "–";
    wakeEl.textContent = v.wake_time || "–";
  }

  async function loadTrend() {
    const history = await api(`/astronauts/${currentAstroId}/history?indicator=sleep&days=${trendDays}`);
    const canvas = document.getElementById("sleep-chart");
    if (!canvas || typeof Chart === "undefined") return;
    const labels = history.map((h) => new Date(h.ts).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
    const values = history.map((h) => sleepHours(h.value));
    const colors = history.map((h) => ({ GREEN: "#2ecc71", YELLOW: "#f4c430", RED: "#ff5a4f", GRAY: "#5b6b7a" }[h.level] || "#5b6b7a"));
    if (sleepChart) sleepChart.destroy();
    sleepChart = new Chart(canvas, {
      type: "bar",
      data: { labels, datasets: [{ label: "Hours slept", data: values, backgroundColor: colors, borderRadius: 4 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, suggestedMax: 10 } },
      },
    });
  }

  function toggleLogForm() {
    const form = document.getElementById("sleep-log-form");
    const open = form.style.display !== "none";
    form.style.display = open ? "none" : "flex";
    document.getElementById("sleep-log-toggle").textContent = open ? "Log tonight's sleep manually" : "Cancel";
  }

  async function saveSleep() {
    if (!currentAstroId) return;
    const bedtime = document.getElementById("sleep-bedtime-input").value;
    const wake_time = document.getElementById("sleep-wake-input").value;
    const btn = document.getElementById("sleep-log-save-btn");
    try {
      btn.disabled = true;
      await api(`/astronauts/${currentAstroId}/sleep`, { method: "POST", body: JSON.stringify({ bedtime, wake_time }) });
      showToast("Sleep logged.");
      toggleLogForm();
      const summary = await api(`/astronauts/${currentAstroId}/summary`);
      renderSummary(summary);
      await loadTrend();
    } catch (e) {
      showToast("Could not log sleep.");
    } finally {
      btn.disabled = false;
    }
  }

  function refreshIfVisible() {
    if (document.getElementById("tab-sleep").classList.contains("active")) onShow();
  }

  Bus.on("cyd_event", refreshIfVisible);

  return { init, onShow };
})();
registerTab("sleep", SleepLabTab);
