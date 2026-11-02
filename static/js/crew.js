// Crew tab: every astronaut at a glance (docs/build-prompt.md section 9.4).
const CrewTab = (() => {
  function init() {
    document.getElementById("tab-crew").innerHTML = `<h2>Crew</h2><div class="card-grid" id="crew-grid"></div>`;
    document.getElementById("crew-grid").addEventListener("click", (e) => {
      const card = e.target.closest("[data-astro-id]");
      if (!card) return;
      window.selectedAstronautId = Number(card.dataset.astroId);
      showTab("live");
      LiveTab.viewAstronaut(window.selectedAstronautId);
    });
  }

  async function onShow() { render(await api("/crew")); }

  function render(crew) {
    document.getElementById("crew-grid").innerHTML = crew.map((a) => `
      <div class="card" data-astro-id="${a.id}" style="cursor:pointer">
        <div style="display:flex; align-items:center; gap:10px;">
          <div class="avatar" style="background:${a.color}">${a.name.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase()}</div>
          <div><strong>${a.name}</strong><div class="dim">${a.role}</div></div>
          ${a.session_active ? '<span class="pill" style="margin-left:auto">live now</span>' : ""}
        </div>
        <div style="margin:10px 0">${levelBadge(a.overall_level, "Status")}</div>
        <div class="dim">Last check: ${fmtTime(a.last_check)}</div>
        <div class="dim">${a.active_alerts} active alert${a.active_alerts === 1 ? "" : "s"}</div>
        <div class="dim">${a.points} pts</div>
      </div>`).join("");
  }

  Bus.on("session_started", onShow);
  Bus.on("session_ended", onShow);
  Bus.on("assessment", onShow);
  Bus.on("alert", onShow);
  Bus.on("points", onShow);

  return { init, onShow };
})();
registerTab("crew", CrewTab);
