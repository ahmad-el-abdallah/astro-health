// Login gate: nobody sees the app until they're signed in. NFC card is
// the only working method today -- tap a card on the CYD while this
// screen is showing (the same "scan" broadcast that opens a session on
// the CYD itself) and the browser signs itself in as that astronaut.
// Username/password and Face ID are shown as placeholders for later
// (README / docs/CLAUDE.md).
const Auth = { astronautId: null, name: null, role: null };

function isSurgeon() { return Auth.role === "Flight surgeon"; }

// Shared by every tab that lets you pick "which astronaut": the Flight
// Surgeon still gets the full crew dropdown, but a regular astronaut is
// locked to themselves -- the backend would reject anyone else's data
// anyway (backend/auth.py), this just keeps the UI from offering a
// choice that would only come back as a 403.
async function populateAstroSelect(select) {
  if (isSurgeon()) {
    const crew = await api("/crew");
    if (!select.options.length) select.innerHTML = crew.map((a) => `<option value="${a.id}">${a.name}</option>`).join("");
    select.disabled = false;
    return crew;
  }
  if (!select.options.length) select.innerHTML = `<option value="${Auth.astronautId}">${Auth.name}</option>`;
  select.value = Auth.astronautId;
  select.disabled = true;
  return [{ id: Auth.astronautId, name: Auth.name }];
}

function applyRoleVisibility() {
  document.querySelectorAll("[data-surgeon-only]").forEach((el) => {
    el.style.display = isSurgeon() ? "" : "none";
  });
  document.getElementById("user-pill").textContent = Auth.name + (isSurgeon() ? " (Flight Surgeon)" : "");
}

function showApp() {
  document.getElementById("login-screen").style.display = "none";
  document.getElementById("app").style.display = "";
}

function applyLogin(me) {
  Auth.astronautId = me.astronaut_id;
  Auth.name = me.name;
  Auth.role = me.role;
  if (!isSurgeon()) window.selectedAstronautId = me.astronaut_id;
  showApp();
  applyRoleVisibility();
}

async function checkAlreadyLoggedIn() {
  const me = await api("/auth/me");
  if (me.astronaut_id) { applyLogin(me); return true; }
  return false;
}

async function onScanForLogin(d) {
  if (Auth.astronautId) return;  // already signed in
  try {
    const me = await api("/auth/nfc_login", { method: "POST", body: JSON.stringify({ uid: d.uid }) });
    applyLogin(me);
  } catch (e) {
    // Not every card tap is a login attempt (exercise/meal/emergency tags
    // all broadcast "scan" too) -- just ignore ones that aren't a crew card.
  }
}

async function logout() {
  await api("/auth/logout", { method: "POST" });
  location.reload();  // simplest clean reset of every tab's in-memory state
}

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("logout-btn").addEventListener("click", logout);
  const loggedIn = await checkAlreadyLoggedIn();
  if (!loggedIn) {
    document.getElementById("login-nfc-status").textContent = "Waiting for a card tap…";
    document.getElementById("login-nfc-status").classList.add("pulse-dot");
    Bus.on("scan", onScanForLogin);
  }
});
