// Sign-in (AstroHealth-Redesign/screens/login.html), ported from static/js/core/login.js.
// One deliberate change from the mockup, carried over from the previous login screen at
// the user's request: NFC stays the primary method (this app's main, already-working way
// in), with username/password and Face ID as secondary expandable options below it --
// the mockup only ever showed a password form. The actual NFC login happens in
// AuthProvider (any "scan" broadcast while signed out is tried as a login).
import { useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { post } from "../lib/api.js";
import { GUIDANCE } from "../lib/faceId.js";
import { FaceCam } from "../components/FaceCam.jsx";
import { useMission } from "../lib/queries.js";
import { useAuth } from "../auth/AuthProvider.jsx";
import { connectionStore, loginScanModeStore, setLoginScanMode, useStore } from "../lib/socket.js";
import { Icon } from "../components/ui/Icon.jsx";
import { cx } from "../components/ui/index.jsx";
import { EASE_ENTER } from "../components/ui/motion.js";
import { Modal } from "../components/overlays/Drawer.jsx";
import { STRINGS } from "../strings.js";
import { LoginScene } from "./LoginScene.jsx";
import LogoCrew from "../assets/brand/logo-mark-crew.svg?react";

const NfcIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M6 10a6 6 0 0 1 12 0" /><path d="M9 10a3 3 0 0 1 6 0" /><circle cx="12" cy="15" r="1.4" fill="currentColor" stroke="none" />
  </svg>
);
const FaceIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="5" /><path d="M8 9h.01M16 9h.01M8 15c1.2 1 2.6 1.5 4 1.5s2.8-.5 4-1.5" />
  </svg>
);

function Expandable({ open, children }) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.3, ease: EASE_ENTER }}
          className="overflow-hidden"
        >
          <div className="mt-3.5 border-t border-line pt-3.5">{children}</div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function AltMethod({ icon, title, subtitle, action, open, onToggle, children }) {
  return (
    <div className="rounded-[14px] border border-line bg-[rgba(13,19,38,.55)] px-4 py-3.5">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-raised text-accent-text">{icon}</span>
        <div className="min-w-0 flex-1">
          <strong className="block text-sm">{title}</strong>
          <small className="block text-xs text-muted">{subtitle}</small>
        </div>
        <button
          onClick={onToggle}
          aria-expanded={open}
          className="min-h-10 shrink-0 cursor-pointer rounded-[10px] border border-line-strong bg-raised px-3.5 text-xs font-semibold whitespace-nowrap hover:border-accent-text"
        >
          {open ? "Cancel" : action}
        </button>
      </div>
      <Expandable open={open}>{children}</Expandable>
    </div>
  );
}

const fieldCls =
  "w-full min-h-[46px] rounded-xl border border-line-strong bg-[rgba(9,13,28,.7)] pl-11 pr-3.5 text-sm text-ink transition-[border-color,box-shadow] duration-200 hover:border-[#46578a] focus:border-accent-text focus:shadow-[0_0_0_4px_rgba(143,166,255,.18)] focus:outline-none";

const submitCls =
  "flex w-full min-h-[46px] cursor-pointer items-center justify-center gap-2.5 rounded-[14px] bg-accent font-bold text-white shadow-[0_6px_20px_rgba(74,104,236,.25)] transition-[background-color,box-shadow] duration-200 hover:bg-accent-hover hover:shadow-[0_12px_34px_rgba(74,104,236,.5)] disabled:opacity-60";

export function Login() {
  const { signIn } = useAuth();
  const mission = useMission();
  const scanMode = useStore(loginScanModeStore); // "cyd" | "web" -- see socket.js
  const connection = useStore(connectionStore); // a tap can't reach this page while offline
  const [method, setMethod] = useState(null); // null | "password" | "face"
  const [contactOpen, setContactOpen] = useState(false);

  // password
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [pwNotice, setPwNotice] = useState("");
  const [pwBusy, setPwBusy] = useState(false);

  // face id: scans by itself -- every good frame is kept, and each 3 new ones go to the server,
  // which votes (2 of 3 must match the same person). Gives up after FACE_MAX_FRAMES frames.
  const FACE_MAX_FRAMES = 40; // give up after this many analysed frames (frames, not seconds: same on a slow laptop)
  const [faceNotice, setFaceNotice] = useState("");
  const [faceScanning, setFaceScanning] = useState(false);
  const [faceGaveUp, setFaceGaveUp] = useState(false);
  const face = useRef({ frames: [], sent: 0, inflight: false, seen: 0, done: false });

  function startFaceScan() {
    face.current = { frames: [], sent: 0, inflight: false, seen: 0, done: false };
    setFaceGaveUp(false);
    setFaceNotice("Loading the face model…");
    setFaceScanning(true);
  }
  function onFaceCamera(r) {
    if (r.ok) startFaceScan();
    else setFaceNotice(`Camera unavailable: ${r.error}`);
  }
  async function onFaceFrame(r) {
    const f = face.current;
    if (f.done) return;
    f.seen += 1;
    if (f.seen > FACE_MAX_FRAMES && !f.inflight) {
      f.done = true;
      setFaceScanning(false);
      setFaceGaveUp(true);
      setFaceNotice("Couldn’t recognise you. Try again facing a light, or use your NFC card.");
      return;
    }
    if (r.reason === "error") { setFaceNotice(`Face model error: ${r.error}`); return; }
    if (!r.ok) { setFaceNotice(GUIDANCE[r.reason] || GUIDANCE.none); return; }
    f.frames.push(r.descriptor);
    if (f.inflight || f.frames.length - f.sent < 3) { setFaceNotice(GUIDANCE.ok); return; }
    f.sent = f.frames.length;
    f.inflight = true;
    setFaceNotice("Checking…");
    try {
      const me = await post("/auth/face_login", { descriptors: f.frames.slice(-3) });
      f.done = true;
      setFaceScanning(false);
      signIn(me);
    } catch (err) {
      if (err?.status === 404) {
        f.done = true;
        setFaceScanning(false);
        setFaceGaveUp(true);
        setFaceNotice("No Face ID is set up yet. Sign in with your card, then enroll it in Account.");
      } else {
        setFaceNotice("Not recognised yet: keep looking at the camera…");
      }
    } finally {
      f.inflight = false;
    }
  }

  async function submitPassword(e) {
    e.preventDefault();
    setPwNotice("");
    setPwBusy(true);
    try {
      signIn(await post("/auth/password_login", { username, password }));
    } catch {
      setPwNotice("Invalid username or password.");
    } finally {
      setPwBusy(false);
    }
  }

  const toggle = (m) => {
    if (m === "face" && method !== "face") { setFaceNotice("Starting camera…"); setFaceGaveUp(false); }
    if (m !== "face" || method === "face") setFaceScanning(false);
    setMethod((cur) => (cur === m ? null : m));
  };

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-space text-ink" data-role="crew">
      <LoginScene />

      <header className="relative z-[1] flex flex-wrap items-center justify-between gap-4 px-[clamp(16px,5vw,72px)] py-7">
        <div className="flex items-center gap-3">
          <LogoCrew width={40} height={40} className="rounded-xl" aria-hidden="true" />
          <div>
            <span className="block font-display text-lg font-bold tracking-tight">{STRINGS.appName}</span>
            <span className="text-caption tracking-[0.12em] text-muted">CREW HEALTH · MISSION MEDICINE</span>
          </div>
        </div>
        <span className="flex items-center gap-2 rounded-full border border-[rgba(143,166,255,.18)] bg-[rgba(19,26,48,.6)] px-3.5 py-2 text-label text-[#cfd9ff]">
          <span className="h-2 w-2 rounded-full bg-mars" />
          {mission.data?.profile?.short || mission.data?.profile?.label || "Mission"}
        </span>
      </header>

      <main className="relative z-[1] flex flex-1 items-center px-[clamp(16px,5vw,72px)] pt-3 pb-12">
        <motion.section
          aria-labelledby="login-title"
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, ease: EASE_ENTER }}
          className="flex w-full max-w-[440px] flex-col gap-[18px] rounded-hero ah-glass-flat p-[clamp(22px,4vw,36px)] shadow-[0_30px_80px_rgba(0,0,0,.45)]"
        >
          <div>
            <h1 id="login-title" className="m-0 font-display text-[clamp(28px,4vw,38px)] leading-[1.1] font-bold tracking-[-0.025em]">
              Welcome aboard
            </h1>
            <p className="mt-1.5 mb-0 text-sm text-ink-2">Sign in to monitor crew health and stay connected with mission medicine.</p>
          </div>

          {/* NFC: the primary method -- a highlighted, always-open block. */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.25, duration: 0.5, ease: EASE_ENTER }}
            className="flex flex-col gap-2 rounded-[15px] border-[1.5px] border-accent bg-[rgba(74,104,236,.08)] px-[18px] py-4"
          >
            <div className="flex items-center gap-3">
              <span className="relative flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-full bg-accent text-white">
                <motion.span
                  className="absolute inset-0 rounded-full border-2 border-accent"
                  animate={{ scale: [1, 1.45], opacity: [0.6, 0] }}
                  transition={{ duration: 1.8, repeat: Infinity, ease: "easeOut" }}
                />
                <NfcIcon />
              </span>
              <div>
                <strong className="block text-sm">NFC crew card</strong>
                <small className="block text-xs text-muted">Tap your card on the CYD reader, or use the Simulator</small>
              </div>
            </div>
            {connection === "offline" ? (
              <p className="m-0 flex items-center gap-2 text-label text-check-fg" role="status">
                <span className="h-2 w-2 rounded-full bg-check-fg animate-[ah-pulse-dot_0.8s_ease-in-out_infinite]" />
                Reconnecting to the station… a card tapped now will still sign you in.
              </p>
            ) : (
              <p className="m-0 flex items-center gap-2 text-label text-accent-text" role="status">
                <span className="h-2 w-2 rounded-full bg-accent-text animate-[ah-pulse-dot_1.2s_ease-in-out_infinite]" />
                Waiting for a card tap…
              </p>
            )}
            {/* Only affects a tap made from the web (the Simulator's NFC buttons) -- a
                real physical tap on actual hardware always signs in its own CYD too,
                since there's no way for real hardware to know this browser's choice. */}
            <div className="mt-1 flex flex-col gap-1.5 border-t border-[rgba(74,104,236,.18)] pt-2.5 text-xs text-ink-2">
              <label className="flex cursor-pointer items-center gap-2">
                <input type="radio" name="scan-mode" checked={scanMode === "cyd"} onChange={() => setLoginScanMode("cyd")} />
                Also sign in my CYD
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input type="radio" name="scan-mode" checked={scanMode === "web"} onChange={() => setLoginScanMode("web")} />
                This browser only
              </label>
            </div>
          </motion.div>

          <AltMethod
            icon={<Icon name="lock" size={16} />}
            title="Username & password"
            subtitle="For laptop or admin sign-in"
            action="Use password"
            open={method === "password"}
            onToggle={() => toggle("password")}
          >
            <form onSubmit={submitPassword} className="flex flex-col gap-3.5">
              <label className="flex flex-col gap-1.5">
                <span className="text-label font-medium text-[#dbe2f5]">Username</span>
                <span className="relative">
                  <Icon name="user" size={18} className="pointer-events-none absolute top-3.5 left-3.5 text-subtle" />
                  <input className={fieldCls} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" placeholder="ahmad@station.crew" />
                </span>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-label font-medium text-[#dbe2f5]">Password</span>
                <span className="relative">
                  <Icon name="lock" size={18} className="pointer-events-none absolute top-3.5 left-3.5 text-subtle" />
                  <input
                    className={cx(fieldCls, "pr-16")}
                    type={showPw ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    placeholder="••••••••"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw((s) => !s)}
                    aria-pressed={showPw}
                    aria-label={showPw ? "Hide password" : "Show password"}
                    className="absolute top-1 right-1 h-[38px] min-w-11 cursor-pointer rounded-[9px] px-2.5 text-xs font-semibold text-accent-text hover:bg-raised"
                  >
                    {showPw ? "Hide" : "Show"}
                  </button>
                </span>
              </label>
              <button type="submit" disabled={pwBusy} className={submitCls}>
                Sign in <Icon name="arrow-right" size={16} />
              </button>
              <AnimatePresence>
                {pwNotice && (
                  <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="m-0 text-xs text-check-fg" role="status">
                    {pwNotice}
                  </motion.p>
                )}
              </AnimatePresence>
            </form>
          </AltMethod>

          <AltMethod
            icon={<FaceIcon />}
            title="Face ID"
            subtitle="Look at the camera to sign in"
            action="Use Face ID"
            open={method === "face"}
            onToggle={() => toggle("face")}
          >
            <FaceCam active={method === "face"} scanning={faceScanning} onFrame={onFaceFrame} onCamera={onFaceCamera} className="mb-2.5" />
            {faceNotice && <p className="m-0 text-xs text-check-fg" role="status">{faceNotice}</p>}
            {faceGaveUp && <button onClick={startFaceScan} className={cx(submitCls, "mt-2.5")}>Try again</button>}
          </AltMethod>

          <div className="flex items-center gap-3 border-t border-[rgba(143,166,255,.14)] pt-4">
            <span className="flex shrink-0">
              <span className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-[#0f1528] bg-[#24336b] text-[#b8c6ff]"><Icon name="user" size={13} /></span>
              <span className="-ml-2 flex h-7 w-7 items-center justify-center rounded-full border-2 border-[#0f1528] bg-[#16303a] text-[#8fe8d6]"><Icon name="plus" size={13} /></span>
            </span>
            <p className="m-0 text-xs leading-[1.45] text-muted">One sign-in for crew members and flight doctors — you'll land in the right console.</p>
          </div>

          <motion.button
            whileHover={{ y: -1 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => post("/emergency", { text: "Emergency Access triggered from the login screen" }).catch(() => {})}
            className="flex min-h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-[10px] border border-[rgba(255,90,79,.45)] bg-[rgba(255,90,79,.1)] text-xs font-bold text-[#ffb0a8]"
          >
            <Icon name="alert" size={15} /> Emergency Access · Alert now
          </motion.button>

          <p className="m-0 text-center text-xs text-muted">
            New crew member?{" "}
            <button onClick={() => setContactOpen(true)} className="cursor-pointer text-accent-text hover:underline">Contact mission ops</button>{" "}
            to get set up.
          </p>
          <p className="m-0 text-center text-caption text-placeholder">{STRINGS.footerDisclaimer}</p>
        </motion.section>
      </main>

      <Modal open={contactOpen} onClose={() => setContactOpen(false)} title="Mission operations">
        <p className="m-0 text-sm leading-relaxed text-ink-2">
          New crew members are enrolled by a superuser on the /admin page (NFC card first). Once signed in, they can set up their own
          password and Face ID from Account.
        </p>
      </Modal>
    </div>
  );
}
