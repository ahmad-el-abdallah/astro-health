// Mission tab: pick the profile, see gravity / comms delay / radiation /
// hazards (docs/build-prompt.md section 9.6).
const MissionTab = (() => {
  function init() {
    document.getElementById("tab-mission").innerHTML = `
      <h2>Mission</h2>
      <div class="card">
        <label>Profile</label>
        <select id="mission-select"></select>
      </div>
      <div class="card" id="mission-details"></div>`;
    document.getElementById("mission-select").addEventListener("change", (e) => setProfile(e.target.value));
  }

  async function onShow() { render(await api("/mission")); }

  function render(mission) {
    const select = document.getElementById("mission-select");
    select.innerHTML = Object.entries(mission.all_profiles).map(([id, p]) =>
      `<option value="${id}" ${id === mission.profile_id ? "selected" : ""}>${p.label}</option>`).join("");
    const p = mission.profile;
    const delay = typeof p.comms_delay_s === "number"
      ? (p.comms_delay_s >= 60 ? `${Math.round(p.comms_delay_s / 60)} min` : `${p.comms_delay_s} s`)
      : String(p.comms_delay_s);
    document.getElementById("mission-details").innerHTML = `
      <div class="card-grid">
        <div><div class="dim">Gravity</div><div class="big-number">${p.gravity_g === "same_as_base" ? "same as base" : p.gravity_g + " g"}</div></div>
        <div><div class="dim">One-way comms delay</div><div class="big-number">${delay}</div></div>
        <div><div class="dim">Daily radiation dose (PLACEHOLDER)</div><div class="big-number">${p.daily_radiation_dose_uGy_PLACEHOLDER} &micro;Gy</div></div>
      </div>
      <h3>Main concerns</h3>
      <p>${p.main_concerns.join(", ").replace(/_/g, " ")}</p>`;
  }

  async function setProfile(profileId) {
    await api("/mission", { method: "PUT", body: JSON.stringify({ profile_id: profileId }) });
    onShow();
  }

  Bus.on("mission_changed", onShow);

  return { init, onShow };
})();
registerTab("mission", MissionTab);
