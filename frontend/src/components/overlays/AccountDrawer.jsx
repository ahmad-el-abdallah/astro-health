// Account & Security: the signed-in astronaut's own sign-in methods (NFC card on file,
// username/password, Face ID enroll/clear). Port of static/js/core/account.js; a
// superuser can do the same resets from /admin via the same backend routes.
import { useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { del, get, post } from "../../lib/api.js";
import { dropOutliers, GUIDANCE, tooSimilar } from "../../lib/faceId.js";
import { FaceCam } from "../FaceCam.jsx";
import { useAuth } from "../../auth/AuthProvider.jsx";
import { Button, Field, Progress } from "../ui/index.jsx";
import { Drawer } from "./Drawer.jsx";
import { ROOM_ORDER, ROOMS, roomStore } from "../../lib/hearing.js";

// How strict Astra is about background sound (lib/hearing.js), remembered in this browser.
function AstraHearing() {
  const room = useSyncExternalStore(roomStore.subscribe, roomStore.get);
  const hint = {
    quiet: "Catches a soft voice, even from across the room.",
    normal: "Listens to you, ignores quieter sounds around you.",
    noisy: "Only clear speech close to the microphone. Use it when people talk nearby.",
  }[room];
  return (
    <div className="space-y-3">
      <h3 className="m-0 text-body font-semibold">Astra’s hearing</h3>
      <div role="radiogroup" aria-label="Room noise" className="flex flex-wrap gap-1.5">
        {ROOM_ORDER.map((id) => (
          <button
            key={id}
            role="radio"
            aria-checked={room === id}
            onClick={() => roomStore.set(id)}
            className={`min-h-10 cursor-pointer rounded-xl border px-3.5 text-label font-semibold ${room === id ? "border-accent-text/60 bg-accent-soft text-accent-text" : "border-line bg-raised text-ink-2 hover:text-ink"}`}
          >
            {ROOMS[id].label}
          </button>
        ))}
      </div>
      <p className="m-0 text-xs text-muted">{hint}</p>
    </div>
  );
}

// What Astra remembers about you (things you told her, and check-ins she has planned).
// Only you see these -- not the flight surgeon. Delete any of them here.
function AstraMemory({ id }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["memory", id], queryFn: () => get(`/astronauts/${id}/memory`), enabled: !!id });
  const forget = async (m) => {
    await del(`/astronauts/${id}/memory/${m.id}`);
    qc.invalidateQueries({ queryKey: ["memory", id] });
  };
  const items = q.data || [];
  return (
    <div className="space-y-3">
      <h3 className="m-0 text-body font-semibold">What Astra remembers</h3>
      <p className="m-0 text-xs text-muted">Notes she keeps so she can follow up. Only you can see them.</p>
      {q.isSuccess && items.length === 0 && <p className="m-0 text-sm text-muted">Nothing yet. Tell her something like “remember my knee hurts”.</p>}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {items.map((m) => (
          <li key={m.id} className="flex items-start gap-3 rounded-[var(--radius-inner)] bg-raised p-3">
            <div className="flex-1 text-sm">
              <div>{m.text}</div>
              <div className="text-xs text-muted">
                {new Date(m.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                {m.follow_up_at && !m.followed_up ? " · she'll check in on this" : ""}
              </div>
            </div>
            <button onClick={() => forget(m)} aria-label={`Forget: ${m.text}`} className="min-h-9 cursor-pointer rounded-lg border border-line-strong bg-control px-2.5 text-xs font-semibold text-ink-2 hover:text-ink">Forget</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-divider py-2.5 text-sm last:border-0">
      <span className="text-muted">{label}</span>
      <strong className="font-semibold">{value}</strong>
    </div>
  );
}

export function AccountDrawer({ open, onClose }) {
  const { user, isSurgeon } = useAuth();
  const qc = useQueryClient();
  const id = user?.astronaut_id;
  const account = useQuery({ queryKey: ["account", id], queryFn: () => get(`/astronauts/${id}/account`), enabled: open && !!id });
  // null = "not edited yet", so the field shows the saved username until you type.
  const [usernameDraft, setUsername] = useState(null);
  const username = usernameDraft ?? account.data?.username ?? "";
  const [password, setPassword] = useState("");
  const [pwNotice, setPwNotice] = useState("");
  const [faceNotice, setFaceNotice] = useState("");
  const [liteGlass, setLiteGlass] = useState(() => document.documentElement.dataset.glass === "lite");
  function toggleGlass() {
    const next = !liteGlass;
    setLiteGlass(next);
    if (next) document.documentElement.dataset.glass = "lite";
    else delete document.documentElement.dataset.glass;
    try { localStorage.setItem("ah-glass", next ? "lite" : "full"); } catch { /* not remembered */ }
  }
  // Face ID enrollment (lib/faceId.js v2): the camera runs while the drawer is open; "Enroll"
  // keeps ENROLL_SAMPLES good, slightly different frames (live guidance meanwhile), drops any
  // odd one out, then saves them all (the server stores samples + their mean).
  const ENROLL_SAMPLES = 8;
  const ENROLL_MAX_FRAMES = 60; // give up after this many analysed frames (frames, not seconds: same on a slow laptop)
  const [camOn, setCamOn] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [samples, setSamples] = useState(0);
  const enroll = useRef({ kept: [], frames: 0, saving: false });

  function startEnroll() {
    enroll.current = { kept: [], frames: 0, saving: false };
    setSamples(0);
    setFaceNotice("Loading the face model…");
    setEnrolling(true);
  }
  async function onEnrollFrame(r) {
    const e = enroll.current;
    if (e.saving) return;
    e.frames += 1;
    if (e.frames > ENROLL_MAX_FRAMES) {
      setEnrolling(false);
      setFaceNotice("Couldn’t get enough clear pictures. Face a light, come a little closer, and try again.");
      return;
    }
    if (r.reason === "error") { setFaceNotice(`Face model error: ${r.error}`); return; }
    if (!r.ok) { setFaceNotice(GUIDANCE[r.reason] || GUIDANCE.none); return; }
    // Variety helps, but a very still face must never stall enrollment: skip a near-copy at most twice in a row.
    if (tooSimilar(r.descriptor, e.kept) && (e.skipped || 0) < 2) {
      e.skipped = (e.skipped || 0) + 1;
      setFaceNotice("Good, now move your head very slightly…");
      return;
    }
    e.skipped = 0;
    e.kept.push(r.descriptor);
    if (e.kept.length < ENROLL_SAMPLES) {
      setSamples(e.kept.length);
      setFaceNotice(`${GUIDANCE.ok} ${e.kept.length}/${ENROLL_SAMPLES}`);
      return;
    }
    const clean = dropOutliers(e.kept);
    if (clean.length < ENROLL_SAMPLES - 2) { e.kept = clean; setSamples(clean.length); return; } // keep collecting
    e.saving = true;
    setSamples(ENROLL_SAMPLES);
    setFaceNotice("Saving…");
    try {
      await post(`/astronauts/${id}/face_id`, { descriptors: clean });
      setFaceNotice("Face ID is set up. You can now sign in by looking at the camera.");
      refresh();
    } catch (err) {
      setFaceNotice(err?.body?.error ? `Couldn't save: ${err.body.error}` : "Couldn't save Face ID. Try again.");
    } finally {
      setEnrolling(false);
    }
  }

  const refresh = () => qc.invalidateQueries({ queryKey: ["account", id] });

  async function savePassword(e) {
    e.preventDefault();
    setPwNotice("");
    try {
      await post(`/astronauts/${id}/password`, { username, password });
      setPassword("");
      setPwNotice("Saved.");
      refresh();
    } catch {
      setPwNotice("Couldn't save -- check the username isn't taken and the password is long enough.");
    }
  }

  async function clearFace() {
    try {
      await del(`/astronauts/${id}/face_id`);
      setFaceNotice("Face ID cleared.");
      refresh();
    } catch {
      setFaceNotice("Couldn't clear Face ID.");
    }
  }

  const info = account.data || {};
  return (
    <Drawer open={open} onClose={onClose} title="Account and security" width={460}>
      <div className="flex items-center justify-between border-b border-line px-6 py-5">
        <div>
          <div className="ah-eyebrow">Account</div>
          <h2 className="m-0 font-display text-xl font-semibold">Sign-in & security</h2>
        </div>
        <button onClick={onClose} className="min-h-10 cursor-pointer rounded-xl px-3 text-sm text-ink-2 hover:bg-raised">Close</button>
      </div>
      <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
        <p className="m-0 text-sm text-muted">Set a username/password or enroll Face ID so you don't need your NFC card every time.</p>
        <div>
          <Row label="NFC card" value={info.nfc_uid || "Not assigned"} />
          <Row label="Username" value={info.username || "Not set"} />
          <Row label="Face ID" value={info.has_face_id ? "Enrolled" : "Not enrolled"} />
        </div>

        <form onSubmit={savePassword} className="space-y-3">
          <h3 className="m-0 text-body font-semibold">Username & password</h3>
          <Field label="Username"><input className="ah-input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" /></Field>
          <Field label="New password"><input className="ah-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></Field>
          <Button variant="primary" type="submit">Save</Button>
          {pwNotice && <p className="m-0 text-xs text-check-fg" role="status">{pwNotice}</p>}
        </form>

        <div className="flex items-center justify-between gap-4 rounded-[var(--radius-inner)] bg-raised p-3.5">
          <div>
            <div className="text-sm font-semibold">Reduce glass effects</div>
            <div className="text-xs text-muted">Turns off the frosted blur. Try this if scrolling feels slow.</div>
          </div>
          <button
            role="switch"
            aria-checked={liteGlass}
            onClick={toggleGlass}
            className={`relative h-7 w-12 shrink-0 cursor-pointer rounded-full transition-colors ${liteGlass ? "bg-accent" : "bg-line-strong"}`}
          >
            <span className={`absolute top-1 left-0 h-5 w-5 rounded-full bg-white transition-transform ${liteGlass ? "translate-x-6" : "translate-x-1"}`} />
          </button>
        </div>

        {!isSurgeon && <AstraHearing />}

        {!isSurgeon && open && <AstraMemory id={id} />}

        <div className="space-y-3">
          <h3 className="m-0 text-body font-semibold">Face ID</h3>
          <FaceCam
            active={open}
            scanning={enrolling}
            onFrame={onEnrollFrame}
            onCamera={(r) => { setCamOn(r.ok); if (!r.ok) setFaceNotice(`Camera unavailable: ${r.error}`); }}
          />
          {enrolling && <Progress value={samples / ENROLL_SAMPLES} />}
          <div className="flex gap-2">
            <Button variant="primary" className="flex-1" onClick={startEnroll} busy={enrolling} disabled={!camOn}>
              {info.has_face_id ? "Enroll again" : "Enroll Face ID"}
            </Button>
            <Button className="flex-1" onClick={clearFace} disabled={enrolling}>Clear Face ID</Button>
          </div>
          {faceNotice && <p className="m-0 text-xs text-check-fg" role="status">{faceNotice}</p>}
          <p className="m-0 text-caption text-muted">Look straight at the camera with your face well lit; it takes a few seconds.</p>
        </div>
      </div>
    </Drawer>
  );
}
