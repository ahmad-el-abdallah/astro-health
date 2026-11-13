// Simulator dock (bottom-right, collapsed by default): fakes every card tap and CYD event
// through the exact same backend path a real tap takes (bridge.inject). Port of
// static/js/tabs/simulator.js. Rendered outside the login gate, so tapping a crew card
// here signs you in with no hardware attached.
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { post } from "../lib/api.js";
import { useTags } from "../lib/queries.js";
import { loginScanModeStore, serialLogStore, useStore } from "../lib/socket.js";
import { Icon } from "./ui/Icon.jsx";
import { cx } from "./ui/index.jsx";

const EVENTS = [
  ["mood", "Mood 4", (uid) => ({ type: "mood", uid, value: 4 })],
  ["symptoms", "Symptoms: headache", (uid) => ({ type: "symptoms", uid, items: ["headache"] })],
  ["reaction_normal", "Reaction: normal", (uid) => ({ type: "reaction", uid, trials_ms: [320, 310, 330, 300, 340, 315, 325, 310, 330, 320], avg_ms: 320, lapses: 0, false_starts: 0 })],
  ["reaction_slow", "Reaction: slow", (uid) => ({ type: "reaction", uid, trials_ms: [470, 490, 460, 510, 480, 500, 470, 520, 490, 505], avg_ms: 490, lapses: 1, false_starts: 0 })],
  ["breathing_done", "Breathing done", (uid) => ({ type: "breathing_done", uid, seconds: 60 })],
  ["emergency", "SOS (CYD button)", (uid) => ({ type: "emergency", uid })],
  ["done", "Done (CYD button, logs out)", (uid) => ({ type: "end_session", uid })],
];

function SimButton({ children, ...rest }) {
  return (
    <motion.button
      whileTap={{ scale: 0.95 }}
      className="min-h-8 cursor-pointer rounded-lg border border-line bg-raised px-2.5 text-xs text-ink hover:border-accent-text/60"
      {...rest}
    >
      {children}
    </motion.button>
  );
}

export function SimulatorDock() {
  const [open, setOpen] = useState(false);
  const tags = useTags();
  const log = useStore(serialLogStore);
  const [astroUid, setAstroUid] = useState("");
  const logRef = useRef(null);

  const all = tags.data || [];
  const cards = all.filter((t) => ["astronaut", "surgeon", "emergency"].includes(t.type));
  const objects = all.filter((t) => !["astronaut", "surgeon", "emergency"].includes(t.type));
  const astronauts = all.filter((t) => t.type === "astronaut");
  const uid = astroUid || astronauts[0]?.uid || "";

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log, open]);

  // The login page's own choice (see socket.js) -- "web" means this tap must only ever
  // sign into the browser, never touch the physical CYD's own session.
  const scan = (u) => post("/simulate/scan", { uid: u, web_only: loginScanModeStore.get() === "web" });
  const send = (build) => uid && post("/simulate/event", build(uid));

  return (
    <div className="fixed right-5 bottom-5 z-[100] flex flex-col items-end gap-2">
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 380, damping: 32 }}
            className="w-[min(380px,calc(100vw-40px))] origin-bottom-right overflow-hidden ah-glass-strong rounded-card shadow-[0_24px_70px_rgba(0,0,0,.55)]"
          >
            <div className="flex max-h-[min(70vh,620px)] flex-col gap-4 overflow-y-auto p-4">
            <section>
              <h4 className="m-0 mb-2 text-caption font-semibold tracking-[0.1em] text-subtle uppercase">Crew & surgeon cards</h4>
              <div className="flex flex-wrap gap-1.5">
                {cards.map((t) => <SimButton key={t.uid} title={t.uid} onClick={() => scan(t.uid)}>{t.label}</SimButton>)}
              </div>
            </section>
            {objects.length > 0 && (
              <section>
                <h4 className="m-0 mb-2 text-caption font-semibold tracking-[0.1em] text-subtle uppercase">Object tags</h4>
                <div className="flex flex-wrap gap-1.5">
                  {objects.map((t) => <SimButton key={t.uid} title={t.uid} onClick={() => scan(t.uid)}>{t.label}</SimButton>)}
                </div>
              </section>
            )}
            <section>
              <h4 className="m-0 mb-2 text-caption font-semibold tracking-[0.1em] text-subtle uppercase">CYD events (for this astronaut)</h4>
              <select className="ah-input mb-2 min-h-10 text-sm" value={uid} onChange={(e) => setAstroUid(e.target.value)}>
                {astronauts.map((t) => <option key={t.uid} value={t.uid}>{t.label}</option>)}
              </select>
              <div className="flex flex-wrap gap-1.5">
                {EVENTS.map(([key, label, build]) => <SimButton key={key} onClick={() => send(build)}>{label}</SimButton>)}
              </div>
            </section>
            <section>
              <h4 className="m-0 mb-2 text-caption font-semibold tracking-[0.1em] text-subtle uppercase">Message log</h4>
              <div ref={logRef} className="max-h-36 overflow-y-auto rounded-lg bg-input p-2 font-mono text-caption leading-relaxed text-muted">
                {log.length === 0 && <span>No messages yet.</span>}
                {log.map((l, i) => (
                  <div key={i} className={l.direction === "out" ? "text-accent-text" : ""}>
                    {l.direction === "out" ? "↑ " : "↓ "}
                    {typeof l.line === "string" ? l.line : JSON.stringify(l.line)}
                  </div>
                ))}
              </div>
            </section>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <motion.button
        whileHover={{ y: -1 }}
        whileTap={{ scale: 0.97 }}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex min-h-12 cursor-pointer items-center gap-3 ah-glass-strong rounded-[14px] px-[18px] text-sm font-semibold text-ink shadow-[0_10px_30px_rgba(0,0,0,.35)]"
      >
        <Icon name="simulator" size={16} className="text-accent-text" />
        Simulator
        <motion.span animate={{ rotate: open ? 180 : 0 }} className={cx("inline-flex")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6" /></svg>
        </motion.span>
      </motion.button>
    </div>
  );
}
