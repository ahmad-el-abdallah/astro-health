// Trends tab: Chart.js line/bar charts with threshold-colored bands/bars
// (docs/build-prompt.md section 9.3).
const TrendsTab = (() => {
  const LEVEL_COLOR = { GREEN: "#2ecc71", YELLOW: "#f4c430", RED: "#ff5a4f", GRAY: "#5b6b7a" };
  const BAR_INDICATORS = new Set(["sleep", "exercise", "water", "mood"]);
  let chart = null;
  let rulesCache = null;

  // Paints green/yellow background bands behind a line chart, from
  // chart.options.plugins.levelBands.bands -- see docs/build-prompt.md
  // section 9.3 ("colored background bands taken from the thresholds").
  const levelBandsPlugin = {
    id: "levelBands",
    beforeDatasetsDraw(c) {
      const opts = c.options.plugins && c.options.plugins.levelBands;
      if (!opts || !opts.bands || !opts.bands.length) return;
      const { ctx, chartArea, scales } = c;
      ctx.save();
      opts.bands.forEach((b) => {
        const yTop = scales.y.getPixelForValue(b.hi);
        const yBottom = scales.y.getPixelForValue(b.lo);
        ctx.fillStyle = b.color;
        ctx.fillRect(chartArea.left, yTop, chartArea.right - chartArea.left, yBottom - yTop);
      });
      ctx.restore();
    },
  };
  Chart.register(levelBandsPlugin);

  function init() {
    document.getElementById("tab-trends").innerHTML = `
      <h2>Trends</h2>
      <div class="card" style="display:flex; gap:16px; flex-wrap:wrap;">
        <div><label>Astronaut</label><select id="trends-astro"></select></div>
        <div><label>Indicator</label><select id="trends-indicator">
          <option value="heart_rate">Heart rate</option>
          <option value="blood_pressure">Blood pressure</option>
          <option value="blood_sugar">Blood sugar</option>
          <option value="temperature">Temperature</option>
          <option value="sleep">Sleep</option>
          <option value="mood">Mood</option>
          <option value="exercise">Exercise</option>
          <option value="water">Water</option>
          <option value="reaction_time">Reaction time</option>
        </select></div>
        <div><label>Range</label><select id="trends-days">
          <option value="7">7 days</option>
          <option value="30" selected>30 days</option>
        </select></div>
      </div>
      <div class="card"><canvas id="trends-canvas" height="110"></canvas></div>`;
    ["trends-astro", "trends-indicator", "trends-days"].forEach((id) =>
      document.getElementById(id).addEventListener("change", render));
  }

  async function onShow() {
    const select = document.getElementById("trends-astro");
    const crew = await populateAstroSelect(select);
    select.value = window.selectedAstronautId || select.value || crew[0].id;
    rulesCache = rulesCache || await api("/health-rules");
    render();
  }

  function bandsFor(indicator) {
    const cfg = rulesCache.indicators[indicator];
    if (!cfg || !cfg.green) return [];
    const bands = [{ lo: cfg.green[0], hi: cfg.green[1], color: "rgba(46,204,113,0.12)" }];
    const yellow = cfg.yellow || [];
    yellow.forEach((r) => bands.push({ lo: r[0], hi: r[1], color: "rgba(244,196,48,0.12)" }));
    return bands;
  }

  async function render() {
    const astroId = Number(document.getElementById("trends-astro").value);
    const indicator = document.getElementById("trends-indicator").value;
    const days = Number(document.getElementById("trends-days").value);
    if (!astroId) return;
    const history = await api(`/astronauts/${astroId}/history?indicator=${indicator}&days=${days}`);
    const labels = history.map((h) => new Date(h.ts).toLocaleDateString());
    if (chart) chart.destroy();
    const ctx = document.getElementById("trends-canvas");

    if (indicator === "blood_pressure") {
      chart = new Chart(ctx, {
        type: "line",
        data: {
          labels,
          datasets: [
            { label: "Systolic", data: history.map((h) => h.value.systolic), borderColor: "#ff8c69", tension: 0.3 },
            { label: "Diastolic", data: history.map((h) => h.value.diastolic), borderColor: "#4fd1c5", tension: 0.3 },
          ],
        },
        options: { plugins: { legend: { display: true } } },
      });
    } else if (indicator === "reaction_time") {
      chart = new Chart(ctx, {
        type: "line",
        data: { labels, datasets: [{ label: "Avg reaction (ms)", data: history.map((h) => h.value.avg_ms), borderColor: "#9b8cf2", tension: 0.3 }] },
        options: { plugins: { legend: { display: true } } },
      });
    } else if (BAR_INDICATORS.has(indicator)) {
      chart = new Chart(ctx, {
        type: "bar",
        data: { labels, datasets: [{ label: indicator, data: history.map((h) => h.value), backgroundColor: history.map((h) => LEVEL_COLOR[h.level] || LEVEL_COLOR.GRAY) }] },
        options: { plugins: { legend: { display: false } } },
      });
    } else {
      chart = new Chart(ctx, {
        type: "line",
        data: { labels, datasets: [{ label: indicator, data: history.map((h) => h.value), borderColor: "#4fd1c5", tension: 0.3, pointBackgroundColor: history.map((h) => LEVEL_COLOR[h.level] || LEVEL_COLOR.GRAY) }] },
        options: { plugins: { legend: { display: false }, levelBands: { bands: bandsFor(indicator) } } },
      });
    }
  }

  Bus.on("assessment", onShow);
  Bus.on("cyd_event", onShow);

  return { init, onShow };
})();
registerTab("trends", TrendsTab);
