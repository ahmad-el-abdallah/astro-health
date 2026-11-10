// Doctor AI consultation, as a drawer that slides in over the Body dashboard (the user's
// layout choice: the skeleton dashboard keeps the full page, the chat comes in on top).
// Chips, message input, Analyze symptoms, Send, and Face to Face -- same features as
// the old Body tab's chat panel, same conversation whether typed or spoken.
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Drawer } from "../../../components/overlays/Drawer.jsx";
import { Icon } from "../../../components/ui/Icon.jsx";
import { StatusChip, cx } from "../../../components/ui/index.jsx";
import { getSharedAudioCtx } from "./FaceToFace.jsx";

const CHIPS = ["Severe headache", "Back pain 6", "My heart is racing", "I have a fever", "Can't sleep"];

function Bubble({ m }) {
  const mine = m.who === "user";
  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 380, damping: 30 }}
      className={cx("flex max-w-[88%] gap-2.5", mine ? "flex-row-reverse self-end" : "self-start")}
    >
      {!mine && (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-bold text-accent-text">AI</span>
      )}
      <div className="flex flex-col gap-1">
        <div
          className={cx(
            "px-3.5 py-3 text-sm leading-relaxed",
            mine ? "rounded-[16px_4px_16px_16px] bg-accent text-accent-on" : "rounded-[4px_16px_16px_16px] border border-line bg-raised text-ink",
            m.pending && "animate-pulse text-muted",
          )}
        >
          {m.text}
          {m.note && <span className="mt-1.5 block text-xs text-muted">{m.note}</span>}
          {(m.extras || []).map((x, i) =>
            x.kind === "result" ? (
              <span key={i} className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <StatusChip level={x.level} label="Result" /> <span className="text-muted">{x.text}</span>
              </span>
            ) : x.kind === "breathing" ? (
              <motion.span
                key={i}
                aria-label="Breathing pacer: breathe in as it grows, out as it shrinks"
                className="mt-3 block h-14 w-14 rounded-full border-2 border-accent-text bg-accent-soft"
                animate={{ scale: [0.8, 1.15, 1.15, 0.8], opacity: [0.7, 1, 1, 0.7] }}
                transition={{ duration: 8, times: [0, 0.4, 0.55, 1], repeat: Infinity, ease: "easeInOut" }}
              />
            ) : (
              <span key={i} className="mt-1.5 block text-xs text-muted">{x.text}</span>
            ),
          )}
          {m.analysis && (
            <span className="mt-2 flex flex-col gap-1.5">
              {m.analysis.map((a) => (
                <span key={a.region} className="flex flex-col gap-0.5 text-[13px]">
                  <span className="flex items-center gap-2"><StatusChip level={a.level} /><strong>{a.label}</strong></span>
                  <span className="text-muted">{a.todo}</span>
                </span>
              ))}
            </span>
          )}
        </div>
        <span className={cx("text-[11px] text-subtle", mine && "text-right")}>{mine ? "You" : "Doctor AI"} · {m.time}</span>
      </div>
    </motion.div>
  );
}

export function ChatDrawer({ open, onClose, consultation, onAnalyze, onFaceToFace, aiAvailable }) {
  const [text, setText] = useState("");
  const logRef = useRef(null);
  const { messages, submit } = consultation;

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, open]);

  const send = (t) => {
    const v = (t ?? text).trim();
    if (!v) return;
    setText("");
    submit(v);
  };

  return (
    <Drawer open={open} onClose={onClose} title="Doctor AI consultation" width={520}>
      <div className="flex items-center gap-3 border-b border-line px-5 py-4">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent-text"><Icon name="doctor-ai" size={20} /></span>
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-base font-semibold">Consultation</h2>
          <span className={cx("flex items-center gap-1.5 text-xs", aiAvailable ? "text-good-fg" : "text-check-fg")}>
            <span className={cx("h-1.5 w-1.5 rounded-full", aiAvailable ? "bg-good-fg" : "bg-check-fg")} />
            {aiAvailable ? "Doctor AI available" : "Offline mode -- keyword matching"}
          </span>
        </div>
        <button
          onClick={() => { getSharedAudioCtx(); onFaceToFace(); }}
          className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-line-strong bg-control px-3.5 text-[13px] font-semibold hover:border-accent-text/60"
        >
          <Icon name="video" size={16} /> Face to face
        </button>
        <button onClick={onClose} aria-label="Close consultation" className="min-h-11 cursor-pointer rounded-xl px-2 text-ink-2 hover:bg-raised">✕</button>
      </div>

      <div ref={logRef} className="flex flex-1 flex-col gap-3.5 overflow-y-auto bg-input px-5 py-5">
        <AnimatePresence initial={false}>
          {messages.map((m) => <Bubble key={m.id} m={m} />)}
        </AnimatePresence>
      </div>

      <div className="flex flex-col gap-3 border-t border-line px-5 py-4">
        <div className="flex flex-wrap gap-2">
          {CHIPS.map((c) => (
            <motion.button
              key={c}
              whileTap={{ scale: 0.95 }}
              onClick={() => send(c)}
              className="min-h-9 cursor-pointer rounded-full border border-line-strong bg-raised px-3.5 text-[13px] text-ink hover:border-accent-text/60"
            >
              {c}
            </motion.button>
          ))}
        </div>
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <input className="ah-input min-h-12 flex-[1_1_220px]" value={text} onChange={(e) => setText(e.target.value)} placeholder="Type your symptoms here…" aria-label="Message to Doctor AI" />
          <button type="button" onClick={onAnalyze} className="min-h-12 cursor-pointer rounded-xl border border-line-strong bg-control px-4 text-sm font-semibold hover:border-accent-text/60">
            Analyze symptoms
          </button>
          <button type="submit" className="flex min-h-12 cursor-pointer items-center gap-2 rounded-xl bg-accent px-5 text-sm font-bold text-accent-on hover:bg-accent-hover">
            Send <Icon name="send" size={16} />
          </button>
        </form>
      </div>
    </Drawer>
  );
}
