// Body tab: a clickable SVG human figure, colored by each region's current
// level, with a side panel (docs/build-prompt.md section 9.2).
const BodyTab = (() => {
  const REGION_COLOR = { GREEN: "#2ecc71", YELLOW: "#f4c430", RED: "#ff5a4f", GRAY: "#5b6b7a" };
  let currentId = null;
  let sideChart = null;
  let contentCache = null;

  function init() {
    document.getElementById("tab-body").innerHTML = `
      <h2>Body</h2>
      <div class="card">
        <label>Astronaut</label>
        <select id="body-astro-select"></select>
      </div>
      <div style="display:flex; gap:20px; flex-wrap:wrap;">
        <div id="body-svg-wrap" style="flex:0 0 260px"></div>
        <div class="card" id="body-side-panel" style="flex:1; min-width:280px">
          <p class="dim">Tap a region of the body to see what it does and how space affects it.</p>
        </div>
      </div>`;
    document.getElementById("body-astro-select").addEventListener("change", (e) => loadFor(Number(e.target.value)));
    loadSvg();
  }

  async function loadSvg() {
    const svgText = await fetch("/static/img/body.svg").then((r) => r.text());
    document.getElementById("body-svg-wrap").innerHTML = svgText;
    document.querySelectorAll(".body-region").forEach((el) => {
      el.style.cursor = "pointer";
      el.addEventListener("click", () => showRegion(el.dataset.region));
      el.addEventListener("mouseenter", () => el.style.filter = (el.style.filter || "") + " brightness(1.25)");
      el.addEventListener("mouseleave", () => el.style.filter = el.style.filter.replace(" brightness(1.25)", ""));
    });
  }

  async function onShow() {
    const select = document.getElementById("body-astro-select");
    const crew = await populateAstroSelect(select);
    if (!crew.length) return;  // not logged in yet -- nothing to show
    const id = window.selectedAstronautId || Number(select.value) || crew[0].id;
    select.value = id;
    loadFor(id);
  }

  async function loadFor(id) {
    currentId = id;
    const summary = await api(`/astronauts/${id}/summary`);
    Object.entries(summary.body_levels).forEach(([region, level]) => {
      const el = document.getElementById(`region-${region}`) || document.querySelector(`[data-region="${region}"]`);
      if (el) {
        el.setAttribute("fill", REGION_COLOR[level] || REGION_COLOR.GRAY);
        el.classList.toggle("pulse-red", level === "RED");
      }
    });
  }

  async function showRegion(region) {
    if (!contentCache) contentCache = await api("/content");
    const info = contentCache.body_parts[region];
    const panel = document.getElementById("body-side-panel");
    if (!info) { panel.innerHTML = `<p class="dim">No info for "${region}" yet.</p>`; return; }
    panel.innerHTML = `
      <h3>${info.label}</h3>
      <p>${info.what_it_does}</p>
      <p><strong>In space:</strong> ${info.space_effects}</p>
      <p><strong>What to do:</strong> ${info.what_to_do}</p>
      <canvas id="body-mini-chart" height="120"></canvas>`;
    if (info.indicators && info.indicators.length && currentId) {
      await drawMiniChart(info.indicators[0]);
    }
  }

  async function drawMiniChart(indicator) {
    const history = await api(`/astronauts/${currentId}/history?indicator=${indicator}&days=7`);
    const ctx = document.getElementById("body-mini-chart");
    if (!ctx) return;
    if (sideChart) sideChart.destroy();
    const values = history.map((h) => (typeof h.value === "object" ? h.value.systolic ?? Object.values(h.value)[0] : h.value));
    sideChart = new Chart(ctx, {
      type: "line",
      data: { labels: history.map((h) => new Date(h.ts).toLocaleDateString()), datasets: [{ label: indicator, data: values, borderColor: "#4fd1c5", tension: 0.3 }] },
      options: { plugins: { legend: { display: false } }, scales: { x: { display: false } } },
    });
  }

  Bus.on("assessment", (d) => { if (d.astronaut_id === currentId) loadFor(currentId); });
  Bus.on("cyd_event", () => { if (currentId) loadFor(currentId); });

  return { init, onShow };
})();
registerTab("body", BodyTab);
