// The login screen's own DOM, built here in JS (not pasted static HTML) --
// matches the convention every tab module already uses
// (document.getElementById(...).innerHTML = `...`). Ported from a
// downloaded mockup's visual design (two-column hero + access panel), with
// one deliberate change from that mockup: NFC keeps the primary card slot
// (it's the main login method, already fully working), while
// username/password and Face ID are the two secondary "alternative" cards
// -- the mockup had password as the main card and NFC as an alternative.
//
// Runs immediately at script-load time (NOT inside a DOMContentLoaded
// listener): classic <script> tags execute synchronously in document
// order, and by the time this tag is reached the #login-screen mount
// point already exists earlier in the parsed HTML. This guarantees
// #login-nfc-status exists before auth.js's own DOMContentLoaded handler
// runs (DOMContentLoaded only fires after every synchronous script has
// finished), without needing to coordinate script order between the two
// files.
(function buildLoginScreen() {
  const mount = document.getElementById("login-screen");
  if (!mount) return;

  mount.innerHTML = `
    <div class="login-shell">
      <section class="login-scene">
        <div class="login-stars"></div>
        <div class="login-orbit"></div>
        <div class="login-brand"><span class="login-brand-icon"></span>Astro Health Station</div>
        <div class="login-intro">
          <div class="login-eyebrow">CREW WELLNESS PLATFORM</div>
          <h1>Your health,<br>mission-ready.</h1>
          <p>Monitor vitals, log symptoms, and stay mission-ready &mdash; on the ground or 140 million miles from it.</p>
          <div class="login-vitals">
            <div class="login-vital"><small>&#9829; HEART RATE</small><strong>72<em> BPM</em></strong></div>
            <div class="login-vital"><small>&#9673; OXYGEN LEVEL</small><strong>98<em> % SpO&#8322;</em></strong></div>
            <div class="login-vital"><small>&#10022; CREW STATUS</small><strong style="font-size:13px">&#9679; STABLE</strong></div>
          </div>
        </div>
        <div class="login-scene-foot">NASA Space Apps Challenge concept &middot; Simulated health data only &middot; Not a medical device.</div>
      </section>

      <section class="login-access">
        <div class="login-content">
          <div class="login-topline">
            <span class="login-label">SECURE CREW ACCESS</span>
            <span class="login-status"><span class="login-dot"></span>DEMO MODE</span>
          </div>
          <h2>Sign in</h2>
          <p class="login-subtitle">Tap your crew card, or use one of the options below.</p>

          <div class="login-main">
            <div class="login-method">
              <span class="login-circle">&#9641;</span>
              <div>
                <strong>NFC crew card</strong>
                <small>Tap your card on the CYD reader, or the Simulator panel</small>
              </div>
            </div>
            <div id="login-nfc-status" class="dim"></div>
          </div>

          <div class="login-alt" id="login-password-card">
            <div class="login-alt-row">
              <span class="login-circle">&#9793;</span>
              <div class="login-alt-desc">
                <strong>Username &amp; password</strong>
                <small>For laptop or admin sign-in</small>
              </div>
              <button class="login-alt-btn" id="login-password-toggle">Use password</button>
            </div>
            <div class="login-alt-body">
              <form class="login-form-fields" id="login-password-form">
                <label class="login-field" for="login-username">Username</label>
                <input class="login-text-field" id="login-username" autocomplete="username" placeholder="e.g. ahmad.almansoori">
                <label class="login-field" for="login-password">Password</label>
                <input class="login-text-field" id="login-password" type="password" autocomplete="current-password" placeholder="&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;">
                <button class="btn" type="submit" style="width:100%;">Sign in &rarr;</button>
                <div class="login-notice" id="login-password-notice" role="status"></div>
              </form>
            </div>
          </div>

          <div class="login-alt" id="login-face-card">
            <div class="login-alt-row">
              <span class="login-circle">&#9673;</span>
              <div class="login-alt-desc">
                <strong>Face ID</strong>
                <small>Look at the camera to sign in</small>
              </div>
              <button class="login-alt-btn" id="login-face-toggle">Use Face ID</button>
            </div>
            <div class="login-alt-body">
              <div class="login-video-wrap"><video id="login-face-video" muted playsinline></video></div>
              <button class="btn" id="login-face-capture" style="width:100%;">Capture &amp; sign in</button>
              <div class="login-notice" id="login-face-notice" role="status"></div>
            </div>
          </div>

          <button class="login-emergency" id="login-emergency-btn">&#9888; Emergency Access &middot; Alert now</button>

          <p class="login-foot-text">New crew member? <button type="button" data-login-dialog="contact">Contact mission ops</button> to get set up.</p>
          <div class="login-copyright">Demo with placeholder data. Not medical advice.</div>
        </div>
      </section>
    </div>

    <div class="login-modal-backdrop" id="login-modal-backdrop">
      <div class="login-modal">
        <h3 id="login-modal-title"></h3>
        <div id="login-modal-body"></div>
        <button class="btn secondary" id="login-modal-close">Close</button>
      </div>
    </div>`;

  // ---- informational-only modals (no real backend feature behind these) ----
  const DIALOGS = {
    contact: {
      title: "Mission operations",
      body: "<p>New crew members are enrolled by a superuser via the /admin page (NFC card, then they can set up their own password and Face ID from the Account &amp; Security panel once logged in).</p>",
    },
  };

  function openLoginDialog(type) {
    const d = DIALOGS[type];
    if (!d) return;
    document.getElementById("login-modal-title").textContent = d.title;
    document.getElementById("login-modal-body").innerHTML = d.body;
    document.getElementById("login-modal-backdrop").classList.add("active");
  }
  function closeLoginDialog() { document.getElementById("login-modal-backdrop").classList.remove("active"); }

  mount.querySelectorAll("[data-login-dialog]").forEach((el) => {
    el.addEventListener("click", () => openLoginDialog(el.dataset.loginDialog));
  });
  document.getElementById("login-modal-close").addEventListener("click", closeLoginDialog);
  document.getElementById("login-modal-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "login-modal-backdrop") closeLoginDialog();
  });

  // ---- alternative-card expand/collapse (same inline-toggle idiom sleep_lab.js uses) ----
  function toggleAltCard(card, onOpen, onClose) {
    const opening = !card.classList.contains("open");
    card.classList.toggle("open");
    if (opening && onOpen) onOpen();
    if (!opening && onClose) onClose();
  }

  // ---- username & password ----
  const passwordCard = document.getElementById("login-password-card");
  document.getElementById("login-password-toggle").addEventListener("click", () => toggleAltCard(passwordCard));
  document.getElementById("login-password-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const notice = document.getElementById("login-password-notice");
    const username = document.getElementById("login-username").value;
    const password = document.getElementById("login-password").value;
    notice.textContent = "";
    try {
      const me = await api("/auth/password_login", { method: "POST", body: JSON.stringify({ username, password }) });
      applyLogin(me);
    } catch (err) {
      notice.textContent = "Invalid username or password.";
    }
  });

  // ---- Face ID ----
  const faceCard = document.getElementById("login-face-card");
  let faceStream = null;
  document.getElementById("login-face-toggle").addEventListener("click", async () => {
    const opening = !faceCard.classList.contains("open");
    toggleAltCard(faceCard);
    const notice = document.getElementById("login-face-notice");
    if (opening) {
      notice.textContent = "Starting camera…";
      try {
        faceStream = await FaceId.startCamera(document.getElementById("login-face-video"));
        notice.textContent = "Center your face, then capture.";
      } catch (err) {
        notice.textContent = "Camera unavailable: " + err.message;
      }
    } else if (faceStream) {
      FaceId.stopCamera(faceStream);
      faceStream = null;
    }
  });
  document.getElementById("login-face-capture").addEventListener("click", async () => {
    const notice = document.getElementById("login-face-notice");
    const btn = document.getElementById("login-face-capture");
    btn.disabled = true;
    notice.textContent = "Loading face model…";
    try {
      const descriptor = await FaceId.captureDescriptor(document.getElementById("login-face-video"));
      if (!descriptor) {
        notice.textContent = "No clear face found. Try again.";
        return;
      }
      notice.textContent = "Checking…";
      const me = await api("/auth/face_login", { method: "POST", body: JSON.stringify({ descriptor }) });
      if (faceStream) { FaceId.stopCamera(faceStream); faceStream = null; }
      applyLogin(me);
    } catch (err) {
      notice.textContent = "Face not recognized. Try again or use another method.";
    } finally {
      btn.disabled = false;
    }
  });

  // ---- Emergency: wired to the real SOS (POST /api/emergency is
  // deliberately unauthenticated, see docs/CLAUDE.md's route-gating
  // summary) -- main.js's existing Bus.on("emergency", ...) listener
  // shows the real #emergency-overlay regardless of login state. ----
  document.getElementById("login-emergency-btn").addEventListener("click", async () => {
    try {
      await api("/emergency", { method: "POST", body: JSON.stringify({ text: "Emergency Access triggered from the login screen" }) });
    } catch (err) {
      // the overlay is driven by the Socket.IO broadcast, not this
      // response -- nothing else to do here if the request itself failed.
    }
  });
})();
