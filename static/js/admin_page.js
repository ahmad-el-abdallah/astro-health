// Superuser admin page (/admin): its own login (backend/auth/admin_auth.py,
// session["superuser_id"] -- independent of the main app's astronaut
// session), the unknown-tag backlog, and the tag registry. Not part of
// the main SPA's Tabs/Chart.js/core/main.js, but does load the same
// static/js/core/socket.js Bus the main app uses -- without it, a card tapped
// while this page is open would never show up until you refreshed it;
// the backlog was only ever (re)fetched on page load or after you
// assign/dismiss something. See docs/CLAUDE.md's "Superuser admin page".
let adminLoggedIn = false;
const TAG_KINDS = [
  { value: "astronaut", label: "Astronaut card" },
  { value: "surgeon", label: "Flight surgeon card" },
  { value: "exercise", label: "Exercise equipment" },
  { value: "sleep", label: "Sleep station" },
  { value: "meal", label: "Food packet" },
  { value: "medicine", label: "Medicine kit item" },
  { value: "bp_guide", label: "Blood pressure cuff" },
  { value: "emergency", label: "Emergency card" },
];
const ROLES = ["Crew member", "Flight surgeon"];

async function api(path, options) {
  const res = await fetch(`/api${path}`, { headers: { "Content-Type": "application/json" }, ...options });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  const ct = res.headers.get("content-type") || "";
  return ct.includes("json") ? res.json() : res.text();
}

function showApp() {
  document.getElementById("admin-login-screen").style.display = "none";
  document.getElementById("admin-app").style.display = "block";
}

async function checkAlreadyLoggedIn() {
  const me = await api("/admin/me");
  if (me.username) {
    document.getElementById("admin-user-pill").textContent = me.username;
    adminLoggedIn = true;
    showApp();
    refreshAll();
    return true;
  }
  return false;
}

async function login() {
  const username = document.getElementById("admin-username").value;
  const password = document.getElementById("admin-password").value;
  const errBox = document.getElementById("admin-login-error");
  try {
    const me = await api("/admin/login", { method: "POST", body: JSON.stringify({ username, password }) });
    document.getElementById("admin-user-pill").textContent = me.username;
    errBox.textContent = "";
    adminLoggedIn = true;
    showApp();
    refreshAll();
  } catch (e) {
    errBox.textContent = "Invalid username or password.";
  }
}

async function logout() {
  await api("/admin/logout", { method: "POST" });
  location.reload();
}

function refreshAll() {
  refreshUnknownTags();
  refreshTagRegistry();
  refreshAccounts();
}

function tagKindSelectHtml(idAttr, selected) {
  return `<select id="${idAttr}">${TAG_KINDS.map((k) =>
    `<option value="${k.value}" ${k.value === selected ? "selected" : ""}>${k.label}</option>`).join("")}</select>`;
}

function roleSelectHtml(idAttr, selected) {
  return `<select id="${idAttr}">${ROLES.map((r) =>
    `<option value="${r}" ${r === selected ? "selected" : ""}>${r}</option>`).join("")}</select>`;
}

// ---- unknown-tag backlog ----

let astronautCache = null;

async function refreshUnknownTags() {
  const tags = await api("/admin/unknown-tags");
  astronautCache = await api("/admin/astronauts");
  const list = document.getElementById("admin-unknown-list");
  if (!tags.length) {
    list.innerHTML = '<p class="dim">No unassigned taps right now.</p>';
    return;
  }
  list.innerHTML = tags.map((t) => `
    <div class="card" data-unknown-row="${t.uid}">
      <div style="display:flex; justify-content:space-between; align-items:baseline;">
        <code>${t.uid}</code>
        <span class="dim">seen ${t.count}&times;, last ${new Date(t.last_seen).toLocaleTimeString()}</span>
      </div>
      <label>Assign as</label>
      ${tagKindSelectHtml(`kind-${t.uid}`, "astronaut")}
      <div id="astro-sub-${t.uid}"></div>
      <label>Label</label>
      <input id="label-${t.uid}" placeholder="e.g. Treadmill">
      <button class="btn" data-assign="${t.uid}">Assign</button>
      <button class="btn secondary" data-dismiss="${t.uid}">Dismiss</button>
    </div>`).join("");

  tags.forEach((t) => renderAstroSub(t.uid, "astronaut"));
  list.querySelectorAll("select[id^='kind-']").forEach((sel) => {
    const uid = sel.id.slice("kind-".length);
    sel.addEventListener("change", () => renderAstroSub(uid, sel.value));
  });
  list.querySelectorAll("[data-assign]").forEach((btn) =>
    btn.addEventListener("click", () => assignUnknownTag(btn.dataset.assign)));
  list.querySelectorAll("[data-dismiss]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await api(`/admin/unknown-tags/${btn.dataset.dismiss}`, { method: "DELETE" });
      refreshUnknownTags();
    }));
}

// Only "astronaut"/"surgeon" kinds need an astronaut behind the tag --
// either pick one from the roster (and optionally change their role), or
// create a brand-new one right here (name + role). A "surgeon" card
// defaults the role picker to Flight surgeon, since that's almost always
// the point of assigning one, but it's still just a default, not forced.
function renderAstroSub(uid, kind) {
  const box = document.getElementById(`astro-sub-${uid}`);
  if (kind !== "astronaut" && kind !== "surgeon") { box.innerHTML = ""; return; }
  const defaultRole = kind === "surgeon" ? "Flight surgeon" : "Crew member";
  box.innerHTML = `
    <label>Astronaut</label>
    <select id="astro-mode-${uid}">
      <option value="existing">Existing astronaut</option>
      <option value="new">New astronaut</option>
    </select>
    <div id="astro-existing-${uid}">
      <select id="astro-pick-${uid}">${astronautCache.map((a) => `<option value="${a.id}">${a.name} (${a.role})</option>`).join("")}</select>
      <label>Role</label>
      ${roleSelectHtml(`astro-pick-role-${uid}`, defaultRole)}
    </div>
    <div id="astro-new-${uid}" style="display:none">
      <label>Name</label>
      <input id="astro-new-name-${uid}" placeholder="e.g. Priya">
      <label>Role</label>
      ${roleSelectHtml(`astro-new-role-${uid}`, defaultRole)}
    </div>`;
  document.getElementById(`astro-mode-${uid}`).addEventListener("change", (e) => {
    document.getElementById(`astro-existing-${uid}`).style.display = e.target.value === "existing" ? "block" : "none";
    document.getElementById(`astro-new-${uid}`).style.display = e.target.value === "new" ? "block" : "none";
  });
}

async function resolveAstronautId(uid) {
  const mode = document.getElementById(`astro-mode-${uid}`).value;
  if (mode === "new") {
    const name = document.getElementById(`astro-new-name-${uid}`).value.trim();
    const role = document.getElementById(`astro-new-role-${uid}`).value;
    if (!name) throw new Error("Name is required for a new astronaut.");
    const created = await api("/astronauts", { method: "POST", body: JSON.stringify({ name, role }) });
    return created.id;
  }
  const id = Number(document.getElementById(`astro-pick-${uid}`).value);
  const role = document.getElementById(`astro-pick-role-${uid}`).value;
  const current = astronautCache.find((a) => a.id === id);
  if (current && current.role !== role) {
    await api(`/astronauts/${id}/role`, { method: "PUT", body: JSON.stringify({ role }) });
  }
  return id;
}

async function assignUnknownTag(uid) {
  const kind = document.getElementById(`kind-${uid}`).value;
  const label = document.getElementById(`label-${uid}`).value || uid;
  const body = { uid, type: kind, label };
  if (kind === "astronaut" || kind === "surgeon") {
    body.astronaut_id = await resolveAstronautId(uid);
  }
  await api("/tags", { method: "POST", body: JSON.stringify(body) });
  refreshAll();
}

// ---- tag registry ----

async function refreshTagRegistry() {
  const tags = await api("/tags");
  const table = document.getElementById("admin-tags-table");
  table.innerHTML = `<tr><th style="text-align:left">UID</th><th style="text-align:left">Type</th>
    <th style="text-align:left">Label</th><th></th></tr>` + tags.map((t) => `
    <tr style="border-top:1px solid var(--border)">
      <td><code>${t.uid}</code></td><td>${t.type}</td><td>${t.label}</td>
      <td><button class="btn secondary" data-del="${t.uid}">Delete</button></td>
    </tr>`).join("");
  table.querySelectorAll("[data-del]").forEach((btn) => btn.addEventListener("click", async () => {
    await api(`/tags/${btn.dataset.del}`, { method: "DELETE" });
    refreshTagRegistry();
  }));
}

// ---- crew accounts: password reset / Face ID clear (account recovery) ----
// Reuses the exact same backend/routes/routes.py routes an astronaut uses
// to manage their own credentials (set_password/clear_face_id) -- those
// routes already accept a logged-in superuser as an alternative to "you
// are this astronaut" (_authorize_self_or_superuser), so no new backend
// route was needed for this.

async function refreshAccounts() {
  const astronauts = astronautCache || await api("/admin/astronauts");
  const list = document.getElementById("admin-accounts-list");
  list.innerHTML = astronauts.map((a) => `
    <div style="border-top:1px solid var(--border); padding:10px 0;">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
        <strong>${a.name}</strong>
        <div style="display:flex; gap:8px;">
          <button class="btn secondary" data-reset-pw="${a.id}">Reset password</button>
          <button class="btn secondary" data-clear-face="${a.id}">Clear Face ID</button>
        </div>
      </div>
      <div id="account-reset-form-${a.id}" style="display:none; margin-top:10px; gap:8px; align-items:flex-end;">
        <div style="flex:1;"><label>Username</label><input id="account-reset-username-${a.id}"></div>
        <div style="flex:1;"><label>New password</label><input id="account-reset-password-${a.id}" type="password"></div>
        <button class="btn" data-save-pw="${a.id}">Save</button>
      </div>
      <div id="account-reset-notice-${a.id}" class="dim" style="min-height:1.2em; margin-top:4px;"></div>
    </div>`).join("");

  list.querySelectorAll("[data-reset-pw]").forEach((btn) => btn.addEventListener("click", () => {
    const form = document.getElementById(`account-reset-form-${btn.dataset.resetPw}`);
    form.style.display = form.style.display === "none" ? "flex" : "none";
  }));
  list.querySelectorAll("[data-save-pw]").forEach((btn) => btn.addEventListener("click", async () => {
    const id = btn.dataset.savePw;
    const username = document.getElementById(`account-reset-username-${id}`).value;
    const password = document.getElementById(`account-reset-password-${id}`).value;
    const notice = document.getElementById(`account-reset-notice-${id}`);
    try {
      await api(`/astronauts/${id}/password`, { method: "POST", body: JSON.stringify({ username, password }) });
      notice.textContent = "Password set.";
    } catch (e) {
      notice.textContent = "Couldn't set password -- check the username isn't taken and the password is long enough.";
    }
  }));
  list.querySelectorAll("[data-clear-face]").forEach((btn) => btn.addEventListener("click", async () => {
    const id = btn.dataset.clearFace;
    const notice = document.getElementById(`account-reset-notice-${id}`);
    try {
      await api(`/astronauts/${id}/face_id`, { method: "DELETE" });
      notice.textContent = "Face ID cleared.";
    } catch (e) {
      notice.textContent = "Couldn't clear Face ID.";
    }
  }));
}

// Live push for a card tapped while this page is open -- the same "scan"
// pipeline that already broadcasts "unknown_tag" to the main app
// (backend/logic/sessions.py's handle_scan). Without this, the backlog only
// ever updated on page load or right after an assign/dismiss here.
Bus.on("unknown_tag", () => { if (adminLoggedIn) refreshUnknownTags(); });

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("admin-login-btn").addEventListener("click", login);
  document.getElementById("admin-logout-btn").addEventListener("click", logout);
  await checkAlreadyLoggedIn();
});
