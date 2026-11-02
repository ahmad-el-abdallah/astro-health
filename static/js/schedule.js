// Schedule tab: the daily routine from config/routine.json, with a
// reminder banner and missed tasks turning yellow (docs/build-prompt.md
// section 9.9). Reminders fire on real time compressed by TIME_SCALE.
const ScheduleTab = (() => {
  let dueKinds = new Set();
  let routineCache = null;

  function init() {
    document.getElementById("tab-schedule").innerHTML = `
      <h2>Schedule</h2>
      <div id="reminder-banner" class="card" style="display:none; border-color:var(--yellow)"></div>
      <div class="card-grid" id="schedule-grid"></div>`;
  }

  async function onShow() {
    routineCache = routineCache || await api("/routine");
    render();
  }

  function render() {
    if (!routineCache) return;
    document.getElementById("schedule-grid").innerHTML = routineCache.schedule.map((entry) => `
      <div class="card" style="margin-bottom:0">
        <div class="dim">${entry.time}</div>
        <div>${entry.text}</div>
        ${dueKinds.has(entry.kind) ? levelBadge("YELLOW", "Due") : ""}
      </div>`).join("");
  }

  function markDone(kind) {
    if (dueKinds.delete(kind)) render();
  }

  Bus.on("reminder", (d) => {
    dueKinds.add(d.kind);
    render();
    const banner = document.getElementById("reminder-banner");
    banner.style.display = "block";
    banner.textContent = `⏰ Reminder: ${d.text}`;
    setTimeout(() => { banner.style.display = "none"; }, 6000);
  });
  Bus.on("assessment", () => markDone("vitals"));
  Bus.on("cyd_event", (d) => {
    if (d.type === "exercise_stop") markDone("exercise");
    if (d.type === "mood") markDone("mood");
    if (d.type === "sleep_start") markDone("sleep");
  });

  return { init, onShow };
})();
registerTab("schedule", ScheduleTab);
