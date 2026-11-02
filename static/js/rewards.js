// Rewards tab: points, streaks, badges, leaderboard, team goal
// (docs/build-prompt.md section 9.8).
const RewardsTab = (() => {
  function init() {
    document.getElementById("tab-rewards").innerHTML = `
      <h2>Rewards</h2>
      <div class="card">
        <label>Astronaut</label>
        <select id="rewards-astro"></select>
      </div>
      <div class="card-grid">
        <div class="card" id="rewards-points"></div>
        <div class="card" id="rewards-badges"></div>
      </div>
      <div class="card" id="rewards-team-goal"></div>
      <h3>Leaderboard</h3>
      <div class="card" id="rewards-leaderboard"></div>`;
    document.getElementById("rewards-astro").addEventListener("change", (e) => loadRewards(Number(e.target.value)));
  }

  async function onShow() {
    const crew = await api("/crew");
    const select = document.getElementById("rewards-astro");
    if (!select.options.length) {
      select.innerHTML = crew.map((a) => `<option value="${a.id}">${a.name}</option>`).join("");
    }
    const id = window.selectedAstronautId || Number(select.value) || crew[0].id;
    select.value = id;
    loadRewards(id);
    loadLeaderboard();
  }

  async function loadRewards(id) {
    const r = await api(`/rewards/${id}`);
    document.getElementById("rewards-points").innerHTML = `<div class="dim">Total points</div><div class="big-number">${r.points}</div>`;
    const earned = new Set(r.badges.map((b) => b.badge_id));
    document.getElementById("rewards-badges").innerHTML = `<div class="dim">Badges</div>` +
      Object.entries(r.badge_catalog).map(([id2, cfg]) => `
        <div style="opacity:${earned.has(id2) ? 1 : 0.35}">&#127942; <strong>${cfg.label}</strong> &mdash; ${cfg.description}</div>`).join("");
    document.getElementById("rewards-team-goal").innerHTML =
      `<div class="dim">${r.team_goal.label}</div><div class="big-number">${r.team_goal.target}</div>`;
  }

  async function loadLeaderboard() {
    const board = await api("/leaderboard");
    document.getElementById("rewards-leaderboard").innerHTML = board.map((row, i) => `
      <div style="display:flex; align-items:center; gap:10px; padding:6px 0; border-bottom:1px solid var(--border)">
        <strong>#${i + 1}</strong>
        <div class="avatar" style="width:32px;height:32px;background:${row.color}">${row.name[0]}</div>
        ${row.name} <span style="margin-left:auto">${row.points} pts</span>
      </div>`).join("");
  }

  Bus.on("points", onShow);
  Bus.on("badge", (d) => {
    onShow();
    showToast(`✨ Badge earned: ${d.label}`);
  });

  return { init, onShow };
})();
registerTab("rewards", RewardsTab);
