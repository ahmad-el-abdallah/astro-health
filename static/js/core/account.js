// Account & Security overlay: self-service login-method management for the
// currently logged-in astronaut (NFC card status, set username/password,
// enroll/clear Face ID). Same fixed/z-index overlay idiom as
// #emergency-overlay/#face-overlay. A superuser can do the same
// password-reset/clear-Face-ID actions from /admin, reusing the identical
// backend routes (backend/routes/routes.py's set_password/set_face_id/
// clear_face_id, via _authorize_self_or_superuser).
const AccountPanel = (() => {
  let faceStream = null;

  function mount() {
    if (document.getElementById("account-overlay")) return;
    const div = document.createElement("div");
    div.id = "account-overlay";
    div.innerHTML = `
      <div class="card account-panel">
        <h2 style="margin-top:0;">Account &amp; Security</h2>
        <p class="dim">Manage how you sign in. Set a username/password or enroll Face ID so you
          don't need your NFC card every time.</p>

        <div class="account-row"><span>NFC card</span><strong id="account-nfc-uid">&ndash;</strong></div>
        <div class="account-row"><span>Username</span><strong id="account-username">&ndash;</strong></div>
        <div class="account-row"><span>Face ID</span><strong id="account-face-status">&ndash;</strong></div>

        <div class="account-section">
          <h4>Username &amp; password</h4>
          <form id="account-password-form">
            <label class="login-field" for="account-username-input">Username</label>
            <input class="login-text-field" id="account-username-input" autocomplete="username">
            <label class="login-field" for="account-password-input">New password</label>
            <input class="login-text-field" id="account-password-input" type="password" autocomplete="new-password">
            <button class="btn" type="submit">Save</button>
            <div class="login-notice" id="account-password-notice"></div>
          </form>
        </div>

        <div class="account-section">
          <h4>Face ID</h4>
          <div class="login-video-wrap"><video id="account-face-video" muted playsinline></video></div>
          <div style="display:flex; gap:8px;">
            <button class="btn" id="account-face-enroll" style="flex:1;">Enroll Face ID</button>
            <button class="btn secondary" id="account-face-clear" style="flex:1;">Clear Face ID</button>
          </div>
          <div class="login-notice" id="account-face-notice"></div>
        </div>

        <button class="btn secondary" id="account-close-btn" style="width:100%; margin-top:16px;">Close</button>
      </div>`;
    document.body.appendChild(div);

    document.getElementById("account-close-btn").addEventListener("click", close);
    div.addEventListener("click", (e) => { if (e.target === div) close(); });
    document.getElementById("account-password-form").addEventListener("submit", savePassword);
    document.getElementById("account-face-enroll").addEventListener("click", enrollFace);
    document.getElementById("account-face-clear").addEventListener("click", clearFace);
  }

  async function open() {
    mount();
    document.getElementById("account-overlay").classList.add("active");
    await refresh();
    try {
      faceStream = await FaceId.startCamera(document.getElementById("account-face-video"));
    } catch (err) {
      document.getElementById("account-face-notice").textContent = "Camera unavailable: " + err.message;
    }
  }

  function close() {
    const overlay = document.getElementById("account-overlay");
    if (overlay) overlay.classList.remove("active");
    if (faceStream) { FaceId.stopCamera(faceStream); faceStream = null; }
  }

  async function refresh() {
    const info = await api(`/astronauts/${Auth.astronautId}/account`);
    document.getElementById("account-nfc-uid").textContent = info.nfc_uid || "Not assigned";
    document.getElementById("account-username").textContent = info.username || "Not set";
    document.getElementById("account-face-status").textContent = info.has_face_id ? "Enrolled" : "Not enrolled";
    document.getElementById("account-username-input").value = info.username || "";
  }

  async function savePassword(e) {
    e.preventDefault();
    const notice = document.getElementById("account-password-notice");
    const username = document.getElementById("account-username-input").value;
    const password = document.getElementById("account-password-input").value;
    notice.textContent = "";
    try {
      await api(`/astronauts/${Auth.astronautId}/password`, {
        method: "POST", body: JSON.stringify({ username, password }),
      });
      document.getElementById("account-password-input").value = "";
      notice.textContent = "Saved.";
      await refresh();
    } catch (err) {
      notice.textContent = "Couldn't save -- check the username isn't taken and the password is long enough.";
    }
  }

  async function enrollFace() {
    const notice = document.getElementById("account-face-notice");
    const btn = document.getElementById("account-face-enroll");
    btn.disabled = true;
    notice.textContent = "Loading face model…";
    try {
      const descriptor = await FaceId.captureDescriptor(document.getElementById("account-face-video"));
      if (!descriptor) {
        notice.textContent = "No clear face found -- center your face and try again.";
        return;
      }
      await api(`/astronauts/${Auth.astronautId}/face_id`, { method: "POST", body: JSON.stringify({ descriptor }) });
      notice.textContent = "Face ID enrolled.";
      await refresh();
    } catch (err) {
      notice.textContent = "Couldn't enroll -- try again.";
    } finally {
      btn.disabled = false;
    }
  }

  async function clearFace() {
    const notice = document.getElementById("account-face-notice");
    try {
      await api(`/astronauts/${Auth.astronautId}/face_id`, { method: "DELETE" });
      notice.textContent = "Face ID cleared.";
      await refresh();
    } catch (err) {
      notice.textContent = "Couldn't clear Face ID.";
    }
  }

  return { open, close };
})();
window.AccountPanel = AccountPanel;

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("account-btn");
  if (btn) btn.addEventListener("click", AccountPanel.open);
});
