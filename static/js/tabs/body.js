// Body tab: an interactive 3D "digital twin" of the astronaut (region
// geometry/camera-fly/raycasting adapted from a standalone three.js demo the
// user provided), a free-text symptom consultation chat, a 0-10 discomfort
// slider per region that blends live into that region's displayed level,
// and a manual readings form -- all wired onto this app's own data instead
// of the demo's own throwaway backend: region colors/content come from
// /summary + /content exactly as the old flat-SVG Body tab used, discomfort
// is persisted via POST /astronauts/<id>/discomfort (see docs/CLAUDE.md).
const BodyTab = (() => {
  const REGIONS = ["brain", "eyes", "heart", "stomach", "skeleton", "muscles", "immune"];
  const REGION_HEX = { GREEN: 0x2ecc71, YELLOW: 0xf4c430, RED: 0xff5a4f, GRAY: 0x5b6b7a };
  const LEVEL_RANK = { GREEN: 0, YELLOW: 1, RED: 2 };
  // camera look-at target + distance per region, for the fly-to-selection effect
  const FOCUS = {
    brain: { at: [0, 1.78, 0], d: 2.2 },
    eyes: { at: [0, 1.8, 0.08], d: 1.6 },
    heart: { at: [0.05, 1.36, 0], d: 2.2 },
    immune: { at: [0, 1.38, 0], d: 2.4 },
    stomach: { at: [0, 1.04, 0], d: 2.4 },
    skeleton: { at: [0, 0.8, 0], d: 4 },
    muscles: { at: [0.14, 0.55, 0], d: 3.6 },
  };
  // free-text keyword -> region, for the consultation chat (eyes has no
  // keyword, same as the reference demo -- reachable only via the mesh or
  // the legend grid)
  const REGION_KEYWORDS = [
    ["brain", /head|migraine|dizz|sleep|insomnia|stress|anxi|mood|focus/i],
    ["heart", /heart|chest|pulse|palpit|pressure/i],
    ["immune", /fever|temperature|cough|breath|cold|chill/i],
    ["stomach", /stomach|nausea|hungry|thirst|sugar|glucose|abdomen/i],
    ["skeleton", /back|bone|joint|knee|spine/i],
    ["muscles", /muscle|leg|arm|shoulder|cramp|sore/i],
  ];

  let currentId = null;
  let contentCache = null;
  let symptomCatalogCache = null; // lazy-fetched, mirrors live.js's own cache for the same route
  let missionCache = null;
  let rulesCache = null;
  let sideChart = null;
  let bodyLevels = {};
  let discomfort = {};
  let todayData = {};
  let selectedRegion = "heart";
  let scene3d = null;
  let chatMessages = [];
  let chatHistory = [];  // plain-text {role,content} turns sent to the AI -- see "consultation chat" below
  let chatAstroId = null;

  function worseClient(a, b) { return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b; }
  function bandFromIntensity(n) { return n >= 7 ? "RED" : n >= 4 ? "YELLOW" : "GREEN"; }
  function blendedLevel(region) {
    const vitals = bodyLevels[region] === "GRAY" ? "GREEN" : (bodyLevels[region] || "GREEN");
    return worseClient(vitals, bandFromIntensity(discomfort[region] || 0));
  }

  function init() {
    document.getElementById("tab-body").innerHTML = `
      <h2>Body</h2>
      <div class="card">
        <label>Astronaut</label>
        <select id="body-astro-select"></select>
      </div>
      <div class="card body-hero">
        <div>
          <h3 style="margin:0">Digital Twin</h3>
          <p class="dim" style="margin:4px 0 0">Describe how you feel or tap your twin below &mdash;
            we compare it with your own baseline and tell you what to do next.</p>
        </div>
      </div>
      <div class="body-cols">
        <div class="card body-chat">
          <div class="body-chat-head"><h3 style="margin:0">Consultation</h3>
            <button class="btn secondary" id="body-face2face-open">Face to Face</button></div>
          <div class="body-chat-msgs" id="body-chat-msgs"></div>
          <div class="body-chips">
            <button class="body-chip" data-text="Severe headache">Severe headache</button>
            <button class="body-chip" data-text="Back pain 6">Back pain 6</button>
            <button class="body-chip" data-text="My heart is racing">My heart is racing</button>
            <button class="body-chip" data-text="I have a fever">I have a fever</button>
            <button class="body-chip" data-text="Can't sleep">Can't sleep</button>
          </div>
          <div class="body-chat-compose">
            <input id="body-chat-input" placeholder="Type your symptoms here...">
            <button class="btn" id="body-chat-send">Send</button>
          </div>
        </div>
        <div class="card body-twin">
          <div class="body-twin-head"><h3 style="margin:0">Digital Twin</h3><span class="pill">3D</span></div>
          <div id="body-3d-view"></div>
          <div class="body-3d-tools">
            <label><input type="checkbox" id="body-layer-skin" checked> Skin</label>
            <label><input type="checkbox" id="body-layer-muscles" checked> Muscles</label>
            <label><input type="checkbox" id="body-layer-bones" checked> Bones</label>
            <label><input type="checkbox" id="body-layer-organs" checked> Organs</label>
            <button class="btn secondary" id="body-reset-view">Reset view</button>
          </div>
          <div id="body-sel" class="body-sel"></div>
        </div>
      </div>
      <div class="card body-readings">
        <h3>My readings</h3>
        <div class="body-readings-row">
          <button class="btn secondary" id="body-fill-normal">Normal readings</button>
          <button class="btn secondary" id="body-fill-abnormal">Simulate abnormal state</button>
        </div>
        <div class="card-grid">
          <div class="vital-field"><label>Heart rate (bpm)</label><input type="number" id="body-in-hr" placeholder="e.g. 72"></div>
          <div class="vital-field"><label>Blood pressure (mmHg)</label>
            <div style="display:flex; gap:8px;">
              <input type="number" id="body-in-sys" placeholder="systolic">
              <input type="number" id="body-in-dia" placeholder="diastolic">
            </div></div>
          <div class="vital-field"><label>Blood sugar, fasting (mg/dL)</label><input type="number" id="body-in-sugar" placeholder="e.g. 90"></div>
          <div class="vital-field"><label>Temperature (&deg;C)</label><input type="number" step="0.1" id="body-in-temp" placeholder="e.g. 36.8"></div>
        </div>
        <button class="btn" id="body-assess-btn">${STRINGS.assessButton}</button>
        <div id="body-assess-result" style="margin-top:10px;"></div>
        <h3 style="margin-top:20px;">At a glance</h3>
        <div class="card-grid" id="body-legend-grid"></div>
      </div>
      <div id="face-overlay">
        <div class="face-panel">
          <button class="btn secondary" id="body-face2face-close" style="position:absolute; top:16px; right:16px;">Close</button>
          <div id="face-avatar-view"></div>
          <div id="face-caption" class="face-caption dim">Press the mic and tell me what hurts.</div>
          <button class="face-mic" id="body-mic-btn" aria-label="Push to talk">&#127908;</button>
        </div>
      </div>`;

    document.getElementById("body-astro-select").addEventListener("change", (e) => loadFor(Number(e.target.value)));
    document.getElementById("body-chat-send").addEventListener("click", () => sendChat(document.getElementById("body-chat-input").value));
    document.getElementById("body-chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(e.target.value); });
    document.querySelectorAll(".body-chip").forEach((b) => b.addEventListener("click", () => sendChat(b.dataset.text)));
    document.getElementById("body-fill-normal").addEventListener("click", fillNormalReadings);
    document.getElementById("body-fill-abnormal").addEventListener("click", fillAbnormalReadings);
    document.getElementById("body-assess-btn").addEventListener("click", submitBodyAssess);
    document.getElementById("body-legend-grid").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-region]");
      if (btn && scene3d) scene3d.selectRegion(btn.dataset.region, true);
    });
    document.getElementById("body-face2face-open").addEventListener("click", () => {
      // Create/resume the shared AudioContext synchronously, right here,
      // before anything else in this handler -- this is the one place in
      // the whole voice pipeline guaranteed to still be inside the actual
      // click's call stack. Doing it any later (inside ensureFaceAvatar()'s
      // async init, or down in speakReply() after a /consult + /speak round
      // trip) risks the browser never treating the context as user-gesture-
      // unlocked, which plays no audio at all with no error anywhere (see
      // docs/CLAUDE.md).
      getSharedAudioCtx();
      document.getElementById("face-overlay").classList.add("active");
      ensureFaceAvatar();
      if (!recognition) initSpeechRecognition();
    });
    document.getElementById("body-face2face-close").addEventListener("click", () => {
      document.getElementById("face-overlay").classList.remove("active");
      if (recognition && listening) recognition.stop();
      if (faceInitState === "rpm" && window.FaceAvatarRPM) window.FaceAvatarRPM.stopSpeaking();
      else if (typeof FaceAvatar !== "undefined") FaceAvatar.stopSpeaking();
      listening = false;
      document.getElementById("body-mic-btn").disabled = false;
      setMicState(null);
    });
    document.getElementById("body-mic-btn").addEventListener("click", startListening);
    const sel = document.getElementById("body-sel");
    sel.addEventListener("input", (e) => {
      if (e.target.id !== "body-discomfort-slider") return;
      discomfort[selectedRegion] = Number(e.target.value);
      updateLiveBlend();
    });
    sel.addEventListener("change", (e) => {
      if (e.target.id !== "body-discomfort-slider") return;
      persistDiscomfort(selectedRegion, Number(e.target.value));
    });
    sel.addEventListener("click", (e) => {
      if (e.target.id === "body-send-report") sendReport();
      if (e.target.id === "body-analyze") renderAnalysis();
    });

    Promise.all([api("/content"), api("/mission"), api("/health-rules")]).then(([content, mission, rules]) => {
      contentCache = content;
      missionCache = mission;
      rulesCache = rules;
      renderLegend();
    });
    buildScene();
  }

  function buildScene() {
    const container = document.getElementById("body-3d-view");
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 50);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    Object.assign(controls, { enableDamping: true, enablePan: false, minDistance: 1.2, maxDistance: 7 });
    function home() { camera.position.set(0, 1, 3.9); controls.target.set(0, 0.95, 0); }
    home();

    scene.add(new THREE.HemisphereLight(0xffffff, 0x335566, 1.2));
    const dl = new THREE.DirectionalLight(0xffffff, 1.3);
    dl.position.set(2, 4, 3);
    scene.add(dl);

    const groups = { skin: new THREE.Group(), muscles: new THREE.Group(), bones: new THREE.Group(), organs: new THREE.Group() };
    Object.values(groups).forEach((g) => scene.add(g));

    const skinMat = new THREE.MeshPhysicalMaterial({ color: 0x8cc3cf, transparent: true, opacity: 0.14, roughness: 0.3, depthWrite: false });
    const meshes = { brain: [], eyes: [], heart: [], immune: [], stomach: [], skeleton: [], muscles: [] };
    const pick = [];
    const cap = (r, l) => new THREE.CapsuleGeometry(r, l, 6, 14);
    const sph = (r) => new THREE.SphereGeometry(r, 24, 18);

    function skinPart(geo, x, y, z, sx = 1, sy = 1, sz = 1, rz = 0) {
      const m = new THREE.Mesh(geo, skinMat);
      m.position.set(x, y, z); m.scale.set(sx, sy, sz); m.rotation.z = rz;
      groups.skin.add(m);
    }
    function part(region, groupName, geo, x, y, z, sx = 1, sy = 1, sz = 1, rz = 0, op = 1) {
      const mat = new THREE.MeshStandardMaterial({
        color: 0x5b6b7a, roughness: 0.5, transparent: op < 1, opacity: op, depthWrite: op === 1,
        emissive: 0x5b6b7a, emissiveIntensity: 0.1,
      });
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z); m.scale.set(sx, sy, sz); m.rotation.z = rz;
      m.userData.region = region;
      groups[groupName].add(m); meshes[region].push(m); pick.push(m);
      return m;
    }

    skinPart(sph(0.17), 0, 1.76, 0);
    skinPart(new THREE.CylinderGeometry(0.06, 0.07, 0.14, 16), 0, 1.58, 0);
    skinPart(cap(0.25, 0.55), 0, 1.2, 0, 1.15, 1, 0.7);
    skinPart(sph(0.2), 0, 0.85, 0, 1.3, 0.8, 0.8);
    [-1, 1].forEach((s) => {
      skinPart(cap(0.065, 0.5), s * 0.42, 1.3, 0, 1, 1, 1, s * 0.12);
      skinPart(cap(0.055, 0.45), s * 0.5, 0.78, 0, 1, 1, 1, s * 0.08);
      skinPart(cap(0.1, 0.5), s * 0.14, 0.5, 0, 1, 1, 1);
      skinPart(cap(0.08, 0.5), s * 0.14, -0.2, 0, 1, 1, 1);
      part("muscles", "muscles", cap(0.08, 0.5), s * 0.42, 1.3, 0, 1, 1, 1, s * 0.12, 0.5);
      part("muscles", "muscles", cap(0.07, 0.45), s * 0.5, 0.78, 0, 1, 1, 1, s * 0.08, 0.5);
      part("muscles", "muscles", cap(0.115, 0.5), s * 0.14, 0.5, 0, 1, 1, 1, 0, 0.5);
      part("muscles", "muscles", cap(0.095, 0.5), s * 0.14, -0.2, 0, 1, 1, 1, 0, 0.5);
      part("skeleton", "bones", cap(0.028, 0.5), s * 0.14, 0.5, 0, 1, 1, 1);
      part("skeleton", "bones", cap(0.025, 0.5), s * 0.14, -0.2, 0, 1, 1, 1);
      part("skeleton", "bones", cap(0.025, 0.45), s * 0.42, 1.3, 0, 1, 1, 1, s * 0.12);
      part("skeleton", "bones", cap(0.02, 0.4), s * 0.5, 0.78, 0, 1, 1, 1, s * 0.08);
      part("immune", "organs", cap(0.075, 0.2), s * 0.13, 1.38, 0, 1, 1, 0.8);
    });
    for (let i = 0; i < 9; i++) {
      part("skeleton", "bones", new THREE.CylinderGeometry(0.032, 0.032, 0.045, 12), 0, 1.05 + i * 0.063, -0.06);
    }
    part("brain", "organs", sph(0.12), 0, 1.78, 0, 1.05, 0.85, 1.1);
    [-1, 1].forEach((s) => part("eyes", "organs", sph(0.025), s * 0.06, 1.8, 0.1));
    const heart = part("heart", "organs", sph(0.07), 0.055, 1.36, 0.06, 1, 1.15, 0.9);
    part("stomach", "organs", sph(0.12), 0, 1.04, 0.02, 1.2, 1.1, 0.8);

    let hovered = null;

    function paint() {
      for (const region in meshes) {
        const hex = REGION_HEX[blendedLevel(region)] ?? REGION_HEX.GRAY;
        meshes[region].forEach((m) => {
          m.material.color.setHex(hex);
          m.material.emissive.setHex(hex);
          m.material.emissiveIntensity = region === selectedRegion ? 0.6 : region === hovered ? 0.35 : 0.1;
        });
      }
    }

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    function hit(e) {
      const b = renderer.domElement.getBoundingClientRect();
      pointer.set(((e.clientX - b.left) / b.width) * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(pick.filter((m) => m.visible && m.parent.visible), false);
      const preferred = hits.find((h) => h.object.userData.region !== "muscles") || hits[0];
      return preferred && preferred.object.userData.region;
    }

    let down = null;
    let follow = false;
    const goalTarget = new THREE.Vector3();
    let goalDistance = 5;

    renderer.domElement.addEventListener("pointerdown", (e) => { down = [e.clientX, e.clientY]; });
    renderer.domElement.addEventListener("pointerup", (e) => {
      if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 5) {
        const region = hit(e);
        if (region) selectRegion(region, true);
      }
      down = null;
    });
    renderer.domElement.addEventListener("pointermove", (e) => {
      const region = hit(e) || null;
      if (region !== hovered) {
        hovered = region;
        renderer.domElement.style.cursor = region ? "pointer" : "grab";
        paint();
      }
    });
    controls.addEventListener("start", () => { follow = false; });

    function resize() {
      const w = container.clientWidth, h = container.clientHeight;
      if (!w || !h) return;  // tab is hidden (display:none); ResizeObserver fires again once shown
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    new ResizeObserver(resize).observe(container);
    resize();

    let heartRateBpm = 62;
    (function tick(t) {
      requestAnimationFrame(tick);
      const s = 1 + 0.08 * Math.sin((t / 1000) * (heartRateBpm / 60) * 6.283);
      heart.scale.set(s, 1.15 * s, 0.9 * s);
      if (follow) {
        controls.target.lerp(goalTarget, 0.07);
        const v = camera.position.clone().sub(controls.target);
        const d = v.length();
        camera.position.copy(controls.target).add(v.setLength(d + (goalDistance - d) * 0.06));
      }
      controls.update();
      renderer.render(scene, camera);
    })(0);

    function selectRegion(region, fly) {
      selectedRegion = region;
      if (fly && FOCUS[region]) {
        goalTarget.set(...FOCUS[region].at);
        goalDistance = FOCUS[region].d;
        follow = true;
      }
      paint();
      renderSelected(region);
      renderLegend();
    }

    document.getElementById("body-reset-view").addEventListener("click", () => { home(); follow = false; });
    ["skin", "muscles", "bones", "organs"].forEach((g) => {
      document.getElementById(`body-layer-${g}`).addEventListener("change", (e) => { groups[g].visible = e.target.checked; });
    });

    scene3d = {
      paint,
      selectRegion,
      setHeartRate: (bpm) => { heartRateBpm = typeof bpm === "number" && bpm > 0 ? bpm : 62; },
    };
    selectRegion("heart", false);
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
    bodyLevels = summary.body_levels || {};
    discomfort = summary.discomfort || {};
    todayData = summary.today || {};
    if (scene3d) {
      const hr = todayData.heart_rate;
      scene3d.setHeartRate(hr && typeof hr.value === "number" ? hr.value : null);
      scene3d.paint();
      renderSelected(selectedRegion);
      renderLegend();
    }
    if (chatAstroId !== id) {
      chatAstroId = id;
      chatMessages = [];
      chatHistory = [];
      addChatMessage(
        `Hi ${summary.astronaut.name}! Tell me what hurts, tap a body part on your twin, or press Analyze Symptoms.`,
        "assistant",
      );
    }
  }

  // ---- selected-region panel (chip, discomfort slider, About this part, danger alert) ----

  function dangerAlertHtml() {
    const danger = REGIONS.filter((r) => blendedLevel(r) === "RED");
    if (!danger.length) return "";
    return `<div class="body-alert">
      <b>Alert.</b> Re-measure, then notify the flight surgeon.
      <div><button class="btn danger" id="body-send-report">Send report with my consent</button></div>
    </div>`;
  }

  function readingsLine(info) {
    const parts = (info.indicators || []).map((ind) => {
      const r = todayData[ind];
      if (!r) return null;
      const label = ind.replace(/_/g, " ");
      const value = typeof r.value === "object"
        ? `${r.value.systolic}/${r.value.diastolic}`
        : r.value;
      return `${label}: <b>${value}</b>`;
    }).filter(Boolean);
    return parts.length ? parts.join(" &middot; ") : "No readings logged yet today.";
  }

  function renderSelected(region) {
    if (!contentCache) return;
    const info = contentCache.body_parts[region];
    const panel = document.getElementById("body-sel");
    if (!info) { panel.innerHTML = `<p class="dim">No info for "${region}" yet.</p>`; return; }
    const value = discomfort[region] || 0;
    panel.innerHTML = `
      <div class="body-sel-top">
        <div><h4 style="margin:0">${info.label}</h4><span id="body-region-badge">${levelBadge(blendedLevel(region))}</span></div>
        <div class="body-discomfort-num" id="body-discomfort-readout">${value}</div>
      </div>
      <input type="range" id="body-discomfort-slider" min="0" max="10" value="${value}">
      <div class="body-scale"><span>NONE</span><span>MODERATE</span><span>SEVERE</span></div>
      <details open>
        <summary>About this part</summary>
        <p>${readingsLine(info)}</p>
        <p><strong>Function:</strong> ${info.what_it_does}</p>
        <p><strong>Effect of spaceflight:</strong> ${info.space_effects}</p>
        <p><strong>What to do:</strong> ${info.what_to_do}</p>
        <canvas id="body-mini-chart" height="120"></canvas>
      </details>
      <div id="body-alert-box">${dangerAlertHtml()}</div>
      <button class="btn" id="body-analyze" style="width:100%; margin-top:10px;">Analyze Symptoms &rarr;</button>
      <div id="body-analysis-result" style="margin-top:10px;"></div>`;
    if (info.indicators && info.indicators.length && currentId) {
      drawMiniChart(info.indicators[0]);
    }
  }

  // Only the small bits that don't contain the slider itself -- called on
  // every drag tick (an `input` event), so it must never replace #body-sel's
  // innerHTML (that would yank the range input out from under the user's
  // pointer mid-drag).
  function updateLiveBlend() {
    const region = selectedRegion;
    document.getElementById("body-discomfort-readout").textContent = discomfort[region] || 0;
    const badge = document.getElementById("body-region-badge");
    if (badge) badge.outerHTML = `<span id="body-region-badge">${levelBadge(blendedLevel(region))}</span>`;
    const alertBox = document.getElementById("body-alert-box");
    if (alertBox) alertBox.innerHTML = dangerAlertHtml();
    renderLegend();
    if (scene3d) scene3d.paint();
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

  function renderLegend() {
    const grid = document.getElementById("body-legend-grid");
    if (!grid || !contentCache) return;
    grid.innerHTML = REGIONS.map((region) => {
      const info = contentCache.body_parts[region];
      return `<button class="body-legend-btn" data-region="${region}"><span>${info.label}</span>${levelBadge(blendedLevel(region))}</button>`;
    }).join("");
  }

  function renderAnalysis() {
    const levels = REGIONS.map((r) => [r, blendedLevel(r)]);
    const top = levels.reduce((worst, [, lvl]) => worseClient(worst, lvl), "GREEN");
    const flagged = levels.filter(([, lvl]) => lvl !== "GREEN");
    let html = `<b>Overall: ${levelBadge(top)}</b>`;
    if (flagged.length) {
      html += "<ul style='margin:8px 0 0; padding-left:18px;'>" + flagged.map(([r, lvl]) => {
        const info = contentCache.body_parts[r];
        return `<li>${levelBadge(lvl)} <b>${info.label}:</b> ${info.what_to_do}</li>`;
      }).join("") + "</ul>";
    } else {
      html += "<br>All body systems look normal. Keep up your routine.";
    }
    if (top === "RED") html += "<br><b>Escalate:</b> contact the flight surgeon and send a report.";
    const out = document.getElementById("body-analysis-result");
    if (out) out.innerHTML = html;
  }

  async function sendReport() {
    if (!currentId) return;
    try {
      const result = await api(`/astronauts/${currentId}/discomfort/report`, { method: "POST" });
      showToast(`Report sent to the flight surgeon (${result.danger_regions.join(", ")}).`);
    } catch (e) {
      showToast("Could not send the report.");
    }
  }

  async function persistDiscomfort(region, intensity) {
    discomfort[region] = intensity;
    await api(`/astronauts/${currentId}/discomfort`, { method: "POST", body: JSON.stringify({ region, intensity }) });
  }

  // ---- consultation chat ----
  // Primary path: a real NVIDIA-hosted AI agent (POST /astronauts/<id>/consult,
  // server-side only -- the key never reaches the browser) reads the free
  // text and decides the region/intensity itself. Falls back, per-message
  // (not a global "AI is down" switch), to the original keyword-matching
  // logic below whenever that call isn't configured or fails for any reason
  // -- same "degrades gracefully with zero setup" posture as the rest of
  // this app (simulation mode, the offline serial queue, etc.).

  // escapeHtml() itself now lives in static/js/core/main.js (shared with
  // surgeon.js/crew.js, which also render LLM-originated text now that the
  // Consultation AI can write alert/report text -- see docs/CLAUDE.md).

  // Turns the fallback path's trusted canned HTML (<b>, <br>, <small>) into
  // plain text -- only for what gets sent back to the model as history,
  // never for what's rendered (rendering stays untouched).
  function stripTags(html) {
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }

  let msgSeq = 0;
  function addChatMessage(text, who, pending) {
    const id = ++msgSeq;
    chatMessages.push({ id, text, who, pending: !!pending, time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) });
    renderChatMessages();
    return id;
  }

  function updateChatMessage(id, text, pending) {
    const m = chatMessages.find((m) => m.id === id);
    if (!m) return;
    m.text = text;
    m.pending = !!pending;
    renderChatMessages();
  }

  function renderChatMessages() {
    const box = document.getElementById("body-chat-msgs");
    box.innerHTML = chatMessages.map((m) =>
      `<div class="body-msg ${m.who}${m.pending ? " pending" : ""}">${m.text}<time>${m.time}</time></div>`
    ).join("");
    box.scrollTop = box.scrollHeight;
  }

  function extractIntensity(text) {
    const num = (text.match(/\d+/) || [])[0];
    if (num) return Math.min(10, Math.max(1, Number(num)));
    if (/severe|strong|very|extreme/i.test(text)) return 8;
    if (/mild|slight/i.test(text)) return 2;
    return 5;
  }

  function missionHazardLine(region) {
    if (!missionCache || !contentCache) return "";
    const info = contentCache.body_parts[region];
    const concerns = (missionCache.profile && missionCache.profile.main_concerns) || [];
    const match = (info.hazards || []).find((h) => concerns.includes(h));
    if (!match) return "";
    const hazard = contentCache.hazards[match];
    return hazard ? `${missionCache.profile.label}: ${hazard.summary}` : "";
  }

  function sendChat(rawText) {
    if (!currentId) return;
    const text = (rawText || "").trim();
    if (!text) return;
    document.getElementById("body-chat-input").value = "";
    submitMessage(text, { delay: 450 });
  }

  // Shared by the typed Consultation box AND the Face to Face voice
  // transcript (handleVoiceTranscript below) -- one pipeline, two entry
  // points, so neither can drift from the other.
  async function submitMessage(text, opts) {
    opts = opts || {};
    addChatMessage(escapeHtml(text), "user");
    const pendingId = addChatMessage("Thinking&hellip;", "assistant", true);
    if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
    const result = await replyTo(text, pendingId);
    if (result && opts.onReply) await opts.onReply(result);
    return result;
  }

  async function replyTo(text, pendingId) {
    if (!contentCache) return null;
    let result;
    try {
      result = await aiReply(text);
    } catch (e) {
      // No key configured, offline, rate-limited, or a malformed model
      // response -- fall back for this one message only, try the AI again
      // next message.
      result = fallbackReply(text);
    }
    updateChatMessage(pendingId, result.html, false);
    // Recorded only after the reply resolves, and only as plain text (never
    // the rendered/escaped HTML) -- this is what the next message's AI call
    // sends back as conversation history.
    chatHistory.push({ role: "user", content: text });
    chatHistory.push({ role: "assistant", content: result.raw });
    return result;
  }

  async function aiReply(text) {
    const decision = await api(`/astronauts/${currentId}/consult`, {
      method: "POST",
      body: JSON.stringify({ message: text, history: chatHistory }),
    });
    if (decision.region && Number.isInteger(decision.intensity)) {
      await persistDiscomfort(decision.region, decision.intensity);
      if (scene3d) scene3d.selectRegion(decision.region, true);
    }
    // Everything below is additive, one independent try/catch per action --
    // a failure in any one of these never blanks the primary chat reply,
    // which already arrived successfully by this point. Only a /consult
    // failure itself routes through fallbackReply(), in replyTo().
    let extra = "";
    if (decision.vital) {
      try {
        const result = await api(`/astronauts/${currentId}/assess`, {
          method: "POST",
          body: JSON.stringify(decision.vital),
        });
        extra += `<br>${levelBadge(result.overall_level, "Result")} <span class="dim">${escapeHtml(result.note)}</span>`;
        loadFor(currentId);
      } catch (e) { /* non-fatal -- the AI's reply text still shows on its own */ }
    }
    if (decision.symptom) {
      try {
        if (!symptomCatalogCache) symptomCatalogCache = await api("/symptoms/catalog");
        const result = await api(`/astronauts/${currentId}/symptoms`, {
          method: "POST",
          body: JSON.stringify({ items: [decision.symptom] }),
        });
        const label = (symptomCatalogCache.find((s) => s.id === decision.symptom) || { label: decision.symptom }).label;
        extra += `<br><span class="dim">Logged symptom: ${escapeHtml(label)} (${result.level}).</span>`;
      } catch (e) { /* non-fatal */ }
    }
    if (decision.alert_surgeon && decision.alert_text) {
      try {
        await api(`/astronauts/${currentId}/alert`, {
          method: "POST",
          body: JSON.stringify({ text: decision.alert_text }),
        });
        showToast("Alert sent to the flight surgeon.");
        extra += `<br><span class="dim">Flight surgeon alerted.</span>`;
      } catch (e) { /* non-fatal */ }
    }
    if (decision.start_breathing) {
      // Purely visual, no network call -- a slow, calm pulse (the same
      // pulse-opacity keyframe style.css already uses for RED regions,
      // just a much longer cycle here) rather than a new animation.
      extra += `<br><div class="breathing-pacer" aria-hidden="true"></div>`;
    }
    if (decision.trigger_emergency && decision.emergency_text) {
      try {
        await api("/emergency", {
          method: "POST",
          body: JSON.stringify({ text: decision.emergency_text, astronaut_id: currentId }),
        });
        // No separate confirmation line here -- the existing full-screen
        // #emergency-overlay (driven by main.js's Bus.on("emergency", ...))
        // takes over the whole page the instant this call lands.
      } catch (e) { /* non-fatal */ }
    }
    return { html: escapeHtml(decision.reply) + extra, raw: decision.reply };
  }

  function fallbackReply(text) {
    const match = REGION_KEYWORDS.find(([, re]) => re.test(text));
    if (!match) {
      const html = 'I could not tell which body part you mean. Try "headache", "back pain 6" or "my heart is racing".';
      return { html, raw: html };
    }
    const [region] = match;
    const intensity = extractIntensity(text);
    persistDiscomfort(region, intensity);
    if (scene3d) scene3d.selectRegion(region, true);
    const info = contentCache.body_parts[region];
    let reply = `Logged <b>${intensity}/10</b> discomfort for <b>${info.label}</b> and updated your twin. `;
    reply += intensity >= 7 ? "That is high &mdash; send a report to the flight surgeon now." : info.what_to_do;
    const hazardLine = missionHazardLine(region);
    if (intensity >= 4 && hazardLine) reply += `<br><small>${hazardLine}</small>`;
    return { html: reply, raw: stripTags(reply) };
  }

  // ---- Face to Face: push-to-talk voice + the talking-head avatar ----
  // Reuses the exact same submitMessage()/replyTo() pipeline the typed
  // chat uses -- a voice turn is just a transcript fed into the same
  // place, so chatHistory/persistDiscomfort/scene3d.selectRegion all stay
  // the single source of truth either way.

  let recognition = null;
  let listening = false;
  // Realistic avatar (static/js/3d/face_avatar_rpm.js, a Ready Player Me model
  // lip-synced by TalkingHead.js) is the primary one; if it fails to load
  // for any reason (a real risk -- this is a third-party "small side
  // project" library never dry-run in this exact environment before
  // shipping), automatically fall back to the simpler, already-proven
  // procedural avatar (face_avatar.js) rather than leaving a broken overlay.
  let faceInitPromise = null;
  let faceInitState = null; // "rpm" | "primitive"
  let sharedAudioCtx = null;

  // Created/resumed synchronously inside a real click handler (the "Face to
  // Face" open button, and again defensively in startListening()) -- never
  // lazily inside async code, see the comment on that click handler above.
  function getSharedAudioCtx() {
    if (!sharedAudioCtx) {
      sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (sharedAudioCtx.state === "suspended") sharedAudioCtx.resume();
    return sharedAudioCtx;
  }

  function ensureFaceAvatar() {
    if (faceInitPromise) return faceInitPromise;
    const container = document.getElementById("face-avatar-view");
    const ctx = getSharedAudioCtx();
    faceInitPromise = (async () => {
      // window.FaceAvatarRPM is attached by a <script type="module">, which
      // can still be mid-flight the very first time this runs (module
      // scripts defer until after the rest of the page parses) -- give it
      // a moment rather than immediately assuming it's missing.
      for (let i = 0; i < 20 && !window.FaceAvatarRPM; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (window.FaceAvatarRPM) {
        try {
          setFaceCaption("Loading avatar…");
          // Capped, not just awaited directly -- showAvatar() loads a GLB
          // through TalkingHead's own loader stack (GLTFLoader/DRACOLoader/
          // MeshoptDecoder), which includes a DRACO decoder path that
          // defaults to a live Google CDN URL (talkinghead.mjs's own
          // dracoDecoderPath option) -- this project's avatar doesn't
          // actually use Draco-compressed geometry (confirmed: the vendored
          // .glb's extensionsUsed/extensionsRequired are both empty), so
          // that fetch should never trigger, but if it or anything else in
          // this third-party loader stack ever stalls, this used to hang
          // forever with the caption stuck on "Loading avatar..." and no
          // error anywhere -- exactly the "shows text, never talks, no
          // error" shape reported live. A timeout turns a silent hang into
          // a caught failure that falls back to the simple avatar instead.
          const timeout = new Promise((_, reject) => {
            setTimeout(() => reject(new Error("timed out loading the realistic avatar (15s)")), 15000);
          });
          await Promise.race([window.FaceAvatarRPM.init(container, ctx), timeout]);
          faceInitState = "rpm";
          setFaceCaption("Press the mic and tell me what hurts.");
          return;
        } catch (e) {
          // Surfaced in the UI too, not just the console -- so whoever is
          // looking at the page (not necessarily the one with devtools
          // open) can actually read and report the real reason the
          // realistic avatar didn't load, instead of just seeing it
          // silently fall back to the simple one.
          console.error("FaceAvatarRPM.init() failed, falling back to the simple avatar:", e);
          setFaceCaption(`Realistic avatar failed to load (${e && e.message ? e.message : e}) -- using the simple one instead.`);
          container.innerHTML = "";
        }
      } else {
        // The module script itself never attached FaceAvatarRPM at all --
        // a different failure than init() throwing (e.g. a missing nested
        // import, a 404, or a browser that doesn't support import maps).
        console.error("FaceAvatarRPM never attached to window -- the module script itself failed to load or execute. Check the browser console/Network tab for the real error.");
        setFaceCaption("Realistic avatar's script didn't load -- using the simple one instead. Check the browser console for details.");
      }
      FaceAvatar.init(container, ctx);
      faceInitState = "primitive";
    })();
    return faceInitPromise;
  }

  function setMicState(state) {
    const btn = document.getElementById("body-mic-btn");
    if (btn) btn.className = "face-mic" + (state ? ` ${state}` : "");
  }

  function setFaceCaption(text) {
    const el = document.getElementById("face-caption");
    if (el) el.textContent = text;
  }

  // True one-click push-to-talk: a click only ever starts a recording --
  // the button disables itself immediately so a second click can't do
  // anything confusing -- and the browser's own end-of-speech detection
  // (continuous=false, plus an explicit stop() on onspeechend to finalize
  // as soon as it notices silence rather than waiting out its own longer
  // internal timeout) ends it and submits automatically. No second tap to
  // "stop" required.
  function initSpeechRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const micBtn = document.getElementById("body-mic-btn");
    if (!SR) {
      micBtn.disabled = true;
      micBtn.title = "Voice input isn't supported in this browser -- try Chrome";
      setFaceCaption("Voice input isn't supported in this browser. Try Chrome.");
      return;
    }
    recognition = new SR();
    recognition.lang = "en-US";
    recognition.continuous = false;
    recognition.interimResults = true;
    let gotFinal = false;
    recognition.onresult = (e) => {
      let finalText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
        else setFaceCaption(`You: ${e.results[i][0].transcript}`);
      }
      if (finalText.trim()) {
        gotFinal = true;
        recognition.stop();
        handleVoiceTranscript(finalText.trim());
      }
    };
    recognition.onspeechend = () => recognition.stop();
    recognition.onerror = (e) => {
      listening = false;
      micBtn.disabled = false;
      setMicState(null);
      // Surface the real reason instead of one generic message -- "not
      // caught anything" was masking permission/HTTPS/network failures
      // that all need a different fix from the user.
      const reasons = {
        "not-allowed": "Microphone access is blocked for this page. Check your browser's site permissions (the padlock/icon in the address bar) and allow the microphone, then press the mic again.",
        "service-not-allowed": "Microphone access is blocked for this page. Check your browser's site permissions and allow the microphone, then press the mic again.",
        network: "Voice recognition needs an internet connection (it's a cloud service even though typing to the AI also needs one) -- check your connection and try again.",
        "no-speech": "I didn't hear anything. Press the mic and try again.",
        "audio-capture": "No microphone was found. Check one is connected and try again.",
        aborted: null,
      };
      const msg = reasons[e.error] !== undefined ? reasons[e.error] : `Voice input error (${e.error}). Press the mic to try again.`;
      if (msg) setFaceCaption(msg);
      console.warn("SpeechRecognition error:", e.error);
    };
    recognition.onend = () => {
      listening = false;
      if (!gotFinal) { micBtn.disabled = false; setMicState(null); }
      gotFinal = false;
    };
  }

  function startListening() {
    if (!recognition || !currentId || listening) return;
    // Defensive second resume, synchronously inside this click too -- cheap
    // no-op if the context from the "Face to Face" open click is already
    // running; a real fix if a browser suspended it again in the meantime
    // (e.g. after the tab lost focus).
    getSharedAudioCtx();
    listening = true;
    document.getElementById("body-mic-btn").disabled = true;
    setMicState("listening");
    setFaceCaption("Listening&hellip;");
    recognition.start();
  }

  async function handleVoiceTranscript(text) {
    setMicState("thinking");
    setFaceCaption(`You: ${text}`);
    await submitMessage(text, {
      onReply: async (result) => {
        setFaceCaption(result.raw);
        await speakReply(result.raw);
      },
    });
    setMicState(null);
    document.getElementById("body-mic-btn").disabled = false;
  }

  // POSTs the reply text to /speak and plays it through the avatar. A
  // failure here (network hiccup reaching the TTS service) is silent --
  // the text reply is already shown/captioned, so the turn still succeeds,
  // just without a voice -- same degrade-gracefully posture as the AI
  // reply's own keyword-matching fallback.
  async function speakReply(text) {
    if (!currentId) return;
    try {
      const res = await fetch(`/api/astronauts/${currentId}/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`tts failed (${res.status})`);
      const blob = await res.blob();
      await faceInitPromise; // make sure we know which avatar actually loaded
      if (faceInitState === "rpm" && window.FaceAvatarRPM) {
        await window.FaceAvatarRPM.speak(blob, text);
      } else {
        const url = URL.createObjectURL(blob);
        FaceAvatar.speak(url);
      }
    } catch (e) {
      // The text reply already showed independently of this call, so a
      // voice failure doesn't break the turn -- but it must never be
      // silent. A bare `catch {}` here is exactly what hid the real avatar-
      // loading bug earlier this session (see docs/CLAUDE.md), so this one
      // logs instead of swallowing, even though the UI stays on the text.
      console.error("speakReply failed -- no voice this turn:", e);
    }
  }

  // ---- readings form ----

  function midOf(range) { return (range[0] + range[1]) / 2; }
  function outerBound(cfg) {
    const ranges = [cfg.green, ...cfg.yellow];
    return { lo: Math.min(...ranges.map((r) => r[0])), hi: Math.max(...ranges.map((r) => r[1])) };
  }

  function fillNormalReadings() {
    if (!rulesCache) return;
    const ind = rulesCache.indicators;
    document.getElementById("body-in-hr").value = Math.round(midOf(ind.heart_rate.green));
    document.getElementById("body-in-sys").value = Math.round(midOf(ind.blood_pressure.systolic_green));
    document.getElementById("body-in-dia").value = Math.round(midOf(ind.blood_pressure.diastolic_green));
    document.getElementById("body-in-sugar").value = Math.round(midOf(ind.blood_sugar.green));
    document.getElementById("body-in-temp").value = midOf(ind.temperature.green).toFixed(1);
  }

  function fillAbnormalReadings() {
    if (!rulesCache) return;
    const ind = rulesCache.indicators;
    const hr = outerBound(ind.heart_rate);
    const sugar = outerBound(ind.blood_sugar);
    const temp = outerBound(ind.temperature);
    document.getElementById("body-in-hr").value = Math.round(hr.hi + 15);
    document.getElementById("body-in-sys").value = ind.blood_pressure.systolic_red_high + 10;
    document.getElementById("body-in-dia").value = ind.blood_pressure.diastolic_red_high + 8;
    document.getElementById("body-in-sugar").value = Math.round(sugar.hi + 30);
    document.getElementById("body-in-temp").value = (temp.hi + 1).toFixed(1);
  }

  async function submitBodyAssess() {
    if (!currentId) return;
    const body = {};
    const hr = document.getElementById("body-in-hr").value;
    const sys = document.getElementById("body-in-sys").value;
    const dia = document.getElementById("body-in-dia").value;
    const sugar = document.getElementById("body-in-sugar").value;
    const temp = document.getElementById("body-in-temp").value;
    if (hr) body.heart_rate = Number(hr);
    if (sys && dia) body.blood_pressure = { systolic: Number(sys), diastolic: Number(dia) };
    if (sugar) body.blood_sugar = Number(sugar);
    if (temp) body.temperature = Number(temp);
    const result = await api(`/astronauts/${currentId}/assess`, { method: "POST", body: JSON.stringify(body) });
    document.getElementById("body-assess-result").innerHTML =
      `${levelBadge(result.overall_level, "Result")} <span class="dim">${result.note}</span>`;
    loadFor(currentId);
  }

  Bus.on("assessment", (d) => { if (d.astronaut_id === currentId) loadFor(currentId); });
  Bus.on("cyd_event", () => { if (currentId) loadFor(currentId); });
  Bus.on("mission_changed", (d) => { missionCache = { profile_id: d.profile_id, profile: d.profile }; });

  return { init, onShow };
})();
registerTab("body", BodyTab);
