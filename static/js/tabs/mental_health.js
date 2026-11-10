// Mental Health tab: a daily mood check-in, a wellbeing summary + trend
// chart, a guided breathing exercise, and a private journal. Ported from a
// user-supplied draft (mental.js) -- the mood selector/wellbeing ring/
// breathing timer/journal UI were good, but the draft predated this app's
// real login system (it relied on a since-removed LiveTab.getCurrentId()),
// used a hardcoded mood threshold instead of the real rules engine, and
// used prompt()/alert() for the journal composer -- all rewired here onto
// this app's current conventions (Auth/populateAstroSelect, like
// mission.js; health_rules.evaluate() via the real /mood route; an inline
// composer instead of native dialogs). See docs/CLAUDE.md.
const MentalTab = (() => {
  const MOOD_SCORES = { rough: 1, low: 2, okay: 3, good: 4, great: 5 };
  const MOOD_LABELS = { 1: "Rough", 2: "Low", 3: "Okay", 4: "Good", 5: "Great" };

  // "mood" readings come from two writers with two different value_json
  // shapes: a CYD-reported tap stores a bare 1-5 score number, while this
  // tab's own POST /mood route stores a richer object ({mood,score,note}).
  // Handle both wherever a mood reading's score is read back out.
  function moodScore(value) {
    return Number(typeof value === "object" && value ? value.score : value);
  }

  let currentAstroId = null;
  let selectedMood = null;
  let moodChart = null;
  let missionCache = null;

  function init() {
    document.getElementById("tab-mental").innerHTML = `
      <div class="mental-health-page">
        <div class="mental-hero">
          <div>
            <span class="section-kicker">CREW WELLNESS</span>
            <h2>Mental Health</h2>
            <p>Take a moment to check in with yourself.</p>
          </div>
          <label class="dim" style="display:flex; align-items:center; gap:8px;">
            Astronaut <select id="mental-astro-select"></select>
          </label>
        </div>

        <div class="mental-dashboard">
          <div class="mental-card mood-card">
            <div class="card-heading">
              <div><span class="card-kicker">DAILY CHECK-IN</span><h3>How are you feeling right now?</h3></div>
              <span class="card-number">01</span>
            </div>
            <div class="mood-options" id="mood-options">
              <button class="mood-option" data-mood="rough"><span class="mood-icon">\u{1F61E}</span><span class="mood-name">Rough</span></button>
              <button class="mood-option" data-mood="low"><span class="mood-icon">\u{1F615}</span><span class="mood-name">Low</span></button>
              <button class="mood-option" data-mood="okay"><span class="mood-icon">\u{1F610}</span><span class="mood-name">Okay</span></button>
              <button class="mood-option" data-mood="good"><span class="mood-icon">\u{1F642}</span><span class="mood-name">Good</span></button>
              <button class="mood-option" data-mood="great"><span class="mood-icon">\u{1F604}</span><span class="mood-name">Great</span></button>
            </div>
            <div class="mental-note">
              <label for="mental-note-input">What's on your mind? (optional)</label>
              <textarea id="mental-note-input" rows="3" placeholder="Write a short note about how you're feeling..."></textarea>
            </div>
            <button class="btn mental-primary-btn" id="log-mood-btn">Log mood</button>
          </div>

          <div class="mental-card wellbeing-card">
            <div class="card-heading">
              <div><span class="card-kicker">TODAY</span><h3>Wellbeing</h3></div>
              <span class="wellbeing-badge" id="wellbeing-badge">&ndash;</span>
            </div>
            <div class="wellbeing-score">
              <div class="score-ring"><div><strong id="wellbeing-score">&ndash;</strong><span>%</span></div></div>
            </div>
            <div class="wellbeing-stats">
              <div class="wellbeing-stat"><span>Mood</span><strong id="wellbeing-mood">&ndash;</strong></div>
              <div class="wellbeing-stat"><span>Mission risk (mind)</span><strong id="wellbeing-risk">&ndash;</strong></div>
            </div>
          </div>

          <div class="mental-card chart-card">
            <div class="card-heading">
              <div><span class="card-kicker">TREND</span><h3>Mood over time</h3><p>Last 7 days</p></div>
              <span class="trend-indicator" id="mood-trend">&ndash;</span>
            </div>
            <div class="mental-chart-container"><canvas id="mood-chart"></canvas></div>
          </div>

          <div class="mental-card breathing-card">
            <div class="card-heading"><div><span class="card-kicker">RESET</span><h3>4-7-8 Breathing</h3><p>Slow down and reset your breathing.</p></div></div>
            <div class="breathing-content">
              <div class="breathing-circle" id="breathing-circle">
                <div><span id="breathing-phase">Ready</span><strong id="breathing-timer">00</strong></div>
              </div>
              <button class="btn mental-primary-btn" id="breathing-start-btn">Start breathing</button>
            </div>
          </div>

          <div class="mental-card journal-card">
            <div class="card-heading">
              <div><span class="card-kicker">REFLECTION</span><h3>Journal</h3><p>Write down what's on your mind.</p></div>
              <button class="btn secondary" id="toggle-journal-composer-btn">+ Add entry</button>
            </div>
            <div class="journal-composer" id="journal-composer" style="display:none;">
              <input type="text" id="journal-title-input" placeholder="Title">
              <textarea id="journal-body-input" rows="3" placeholder="What's on your mind?"></textarea>
              <button class="btn mental-primary-btn" id="journal-save-btn">Save entry</button>
            </div>
            <div id="journal-container"><div class="journal-empty"><div class="journal-empty-icon">✎</div><p>Loading journal...</p></div></div>
          </div>

          <div class="self-care-card">
            <div class="tip-icon">✦</div>
            <div><span class="card-kicker">SELF-CARE TIP</span><p id="mental-tip">Take a short break, breathe slowly, and give yourself a moment to reset.</p></div>
          </div>
        </div>
      </div>`;

    document.querySelectorAll("#mood-options .mood-option").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#mood-options .mood-option").forEach((b) => b.classList.remove("selected"));
        btn.classList.add("selected");
        selectedMood = btn.dataset.mood;
      });
    });
    document.getElementById("log-mood-btn").addEventListener("click", logMood);
    document.getElementById("breathing-start-btn").addEventListener("click", startBreathing);
    document.getElementById("toggle-journal-composer-btn").addEventListener("click", toggleJournalComposer);
    document.getElementById("journal-save-btn").addEventListener("click", saveJournalEntry);
    document.getElementById("mental-astro-select").addEventListener("change", (e) => {
      currentAstroId = Number(e.target.value);
      window.selectedAstronautId = currentAstroId;
      onShow();
    });
  }

  async function onShow() {
    const select = document.getElementById("mental-astro-select");
    const crew = await populateAstroSelect(select);
    if (!isSurgeon()) currentAstroId = Auth.astronautId;
    currentAstroId = currentAstroId || window.selectedAstronautId || (crew[0] && crew[0].id);
    if (!currentAstroId) return;
    select.value = currentAstroId;

    if (!missionCache) missionCache = await api("/mission");
    const brainRisk = missionCache.health && missionCache.health.body_risks.brain;
    if (brainRisk) {
      document.getElementById("mental-tip").textContent = brainRisk.why;
    }

    await loadMoodData();
    await loadJournal();
  }

  async function logMood() {
    if (!selectedMood) { showToast("Pick a mood first."); return; }
    if (!currentAstroId) return;
    const note = document.getElementById("mental-note-input").value.trim();
    const btn = document.getElementById("log-mood-btn");
    try {
      btn.disabled = true;
      btn.textContent = "Saving...";
      await api(`/astronauts/${currentAstroId}/mood`, { method: "POST", body: JSON.stringify({ mood: selectedMood, note }) });
      showToast("Mood logged.");
      document.getElementById("mental-note-input").value = "";
      document.querySelectorAll("#mood-options .mood-option").forEach((b) => b.classList.remove("selected"));
      selectedMood = null;
      await loadMoodData();
    } catch (e) {
      showToast("Could not save mood.");
    } finally {
      btn.disabled = false;
      btn.textContent = "Log mood";
    }
  }

  async function loadMoodData() {
    const history = await api(`/astronauts/${currentAstroId}/history?indicator=mood&days=7`);
    updateWellbeing(history);
    updateMoodChart(history);
  }

  function updateWellbeing(history) {
    const scoreEl = document.getElementById("wellbeing-score");
    const moodEl = document.getElementById("wellbeing-mood");
    const badgeEl = document.getElementById("wellbeing-badge");
    const riskEl = document.getElementById("wellbeing-risk");
    const brainRisk = missionCache.health && missionCache.health.body_risks.brain;
    riskEl.textContent = brainRisk ? brainRisk.risk : "–";

    if (!history.length) {
      scoreEl.textContent = "–";
      moodEl.textContent = "No data";
      badgeEl.textContent = "NO DATA";
      document.getElementById("mood-trend").textContent = "–";
      return;
    }
    const latest = history[history.length - 1];
    const score = moodScore(latest.value);
    scoreEl.textContent = Math.round((score / 5) * 100);
    moodEl.textContent = MOOD_LABELS[score] || "–";
    badgeEl.textContent = score >= 4 ? "GOOD" : score === 3 ? "OKAY" : "LOW";

    const trendEl = document.getElementById("mood-trend");
    if (history.length < 2) { trendEl.textContent = "→ Stable"; return; }
    const prev = moodScore(history[history.length - 2].value);
    trendEl.textContent = score > prev ? "↗ Improving" : score < prev ? "↘ Lower" : "→ Stable";
  }

  function updateMoodChart(history) {
    const canvas = document.getElementById("mood-chart");
    if (!canvas || typeof Chart === "undefined") return;
    const labels = history.map((h) => new Date(h.ts).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
    const values = history.map((h) => moodScore(h.value));
    if (moodChart) moodChart.destroy();
    moodChart = new Chart(canvas, {
      type: "line",
      data: { labels, datasets: [{ label: "Mood", data: values, tension: 0.4, borderWidth: 3, borderColor: "#4fd1c5",
        pointRadius: 4, pointBackgroundColor: "#4fd1c5", fill: true, backgroundColor: "rgba(79,209,197,0.08)" }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false } },
          y: { min: 1, max: 5, ticks: { stepSize: 1, callback: (v) => MOOD_LABELS[v] || v } },
        },
      },
    });
  }

  function startBreathing() {
    const phase = document.getElementById("breathing-phase");
    const timer = document.getElementById("breathing-timer");
    const button = document.getElementById("breathing-start-btn");
    const circle = document.getElementById("breathing-circle");
    button.disabled = true;
    const steps = [
      { name: "Breathe in", seconds: 4, animation: "breathing-in" },
      { name: "Hold", seconds: 7, animation: "breathing-hold" },
      { name: "Breathe out", seconds: 8, animation: "breathing-out" },
    ];
    let stepIndex = 0;
    function runStep() {
      const step = steps[stepIndex];
      let remaining = step.seconds;
      phase.textContent = step.name;
      timer.textContent = remaining;
      circle.classList.remove("breathing-in", "breathing-hold", "breathing-out");
      void circle.offsetWidth;
      circle.classList.add(step.animation);
      const interval = setInterval(() => {
        remaining--;
        timer.textContent = remaining;
        if (remaining <= 0) {
          clearInterval(interval);
          stepIndex++;
          if (stepIndex >= steps.length) {
            phase.textContent = "Complete";
            timer.textContent = "✓";
            circle.classList.remove("breathing-in", "breathing-hold", "breathing-out");
            button.disabled = false;
            return;
          }
          runStep();
        }
      }, 1000);
    }
    runStep();
  }

  function toggleJournalComposer() {
    const box = document.getElementById("journal-composer");
    const open = box.style.display !== "none";
    box.style.display = open ? "none" : "block";
    document.getElementById("toggle-journal-composer-btn").textContent = open ? "+ Add entry" : "Cancel";
  }

  async function saveJournalEntry() {
    if (!currentAstroId) return;
    const title = document.getElementById("journal-title-input").value.trim();
    const body = document.getElementById("journal-body-input").value.trim();
    if (!title || !body) { showToast("Title and entry text are both required."); return; }
    const btn = document.getElementById("journal-save-btn");
    try {
      btn.disabled = true;
      await api(`/astronauts/${currentAstroId}/journal`, { method: "POST", body: JSON.stringify({ title, body }) });
      document.getElementById("journal-title-input").value = "";
      document.getElementById("journal-body-input").value = "";
      toggleJournalComposer();
      await loadJournal();
    } catch (e) {
      showToast("Could not save journal entry.");
    } finally {
      btn.disabled = false;
    }
  }

  async function loadJournal() {
    const container = document.getElementById("journal-container");
    try {
      const entries = await api(`/astronauts/${currentAstroId}/journal`);
      renderJournal(entries);
    } catch (e) {
      container.innerHTML = `<div class="journal-empty"><p>Could not load journal.</p></div>`;
    }
  }

  function renderJournal(entries) {
    const container = document.getElementById("journal-container");
    if (!entries.length) {
      container.innerHTML = `<div class="journal-empty"><div class="journal-empty-icon">✎</div><p>No journal entries yet.</p><span>Your private thoughts will appear here.</span></div>`;
      return;
    }
    container.innerHTML = entries.map((entry) => `
      <div class="journal-entry">
        <div><h4>${escapeHtml(entry.title)}</h4><p>${escapeHtml(entry.body)}</p></div>
        <span class="journal-date">${fmtTime(entry.created_at)}</span>
      </div>`).join("");
  }

  function refreshIfVisible() {
    if (document.getElementById("tab-mental").classList.contains("active")) onShow();
  }

  Bus.on("cyd_event", refreshIfVisible);

  return { init, onShow };
})();
registerTab("mental", MentalTab);
