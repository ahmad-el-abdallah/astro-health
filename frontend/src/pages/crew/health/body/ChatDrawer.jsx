// Astra consultation, as a drawer that slides in over the Body dashboard (the user's
// layout choice: the skeleton dashboard keeps the full page, the chat comes in on top).
// Quick chips, message input, Analyze symptoms, Send. This drawer is the TEXT chat: every
// voice button here (Voice mode, the mic) closes it and opens the full-screen voice screen
// instead (VoiceMode, owned by Body.jsx) -- the user doesn't want to see the chat while
// talking. Typed replies can still be read aloud (Voice on / Muted).
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Drawer } from "../../../../components/overlays/Drawer.jsx";
import { Icon } from "../../../../components/ui/Icon.jsx";
import { Spinner, StatusChip, cx } from "../../../../components/ui/index.jsx";
import { VoiceFace } from "../../../../components/VoiceFace.jsx";
import { useVoice } from "../../../../lib/useVoice.js";
import { describeAction } from "../../../../lib/astraActions.js";
import { audioCtx } from "../../../../lib/stationAudio.js";
import { EmergencyCountdown } from "../../../../components/astra/EmergencyCountdown.jsx";

const CHIPS = ["How am I doing?", "Severe headache", "Back pain 6", "I have a fever", "Can't sleep"];

const MODE_CHIP = {
  ready: { label: "Ready", cls: "bg-none-bg text-none-fg", dot: "bg-none-fg" },
  listening: { label: "Listening", cls: "bg-alert-bg text-alert-fg", dot: "bg-alert-fg animate-[ah-pulse-dot_1s_ease-in-out_infinite]" },
  thinking: { label: "Thinking", cls: "bg-accent-soft text-accent-text", dot: "bg-accent-text animate-[ah-pulse-dot_1s_ease-in-out_infinite]" },
};

function sourceLine(source) {
  if (source?.kind === "quick") return "Quick replies (AI offline)";
  if (source?.kind === "ai" && source.model) return `Astra · ${source.model.split("/").pop()}`;
  return "Astra";
}

const CARD_STATUS = {
  saving: ["Saving…", "text-muted"],
  saved: ["Saved", "text-good-fg"],
  partly: ["Some of it couldn't be saved", "text-check-fg"],
  cancelled: ["Not saved", "text-muted"],
  dismissed: ["Skipped", "text-muted"],
};

// What Astra proposes to save: nothing is saved until "Yes" (or a spoken "yes").
function ConfirmCard({ confirm, onAnswer }) {
  const [label, tone] = CARD_STATUS[confirm.status] || [];
  return (
    <span className="mt-2.5 flex flex-col gap-2 rounded-xl border border-line-strong bg-input p-3">
      {confirm.actions.map((a, i) => <span key={i} className="block text-label text-ink">{describeAction(a)}</span>)}
      {confirm.status === "pending" ? (
        <span className="flex gap-2">
          <button onClick={() => onAnswer(true)} className="min-h-9 cursor-pointer rounded-lg bg-accent px-3 text-label font-bold text-accent-on hover:bg-accent-hover">Yes</button>
          <button onClick={() => onAnswer(false)} className="min-h-9 cursor-pointer rounded-lg border border-line-strong bg-control px-3 text-label font-semibold">No</button>
        </span>
      ) : (
        <span className={cx("inline-flex items-center gap-1.5 text-xs font-semibold", tone)}>
          {confirm.status === "saving" && <Spinner size={12} />}
          {confirm.status === "saved" && <Icon name="tick" size={14} className="animate-[ah-pop_.4s_ease-out]" />}
          {label}
        </span>
      )}
    </span>
  );
}

function Bubble({ m, onAnswer }) {
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
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-caption font-bold text-accent-text">AI</span>
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
          {m.confirm && <ConfirmCard confirm={m.confirm} onAnswer={onAnswer} />}
          {m.analysis && (
            <span className="mt-2 flex flex-col gap-1.5">
              {m.analysis.map((a) => (
                <span key={a.region} className="flex flex-col gap-0.5 text-label">
                  <span className="flex items-center gap-2"><StatusChip level={a.level} /><strong>{a.label}</strong></span>
                  <span className="text-muted">{a.todo}</span>
                </span>
              ))}
            </span>
          )}
        </div>
        <span className={cx("text-caption text-subtle", mine && "text-right")}>{mine ? "You" : "Astra"} · {m.time}</span>
      </div>
    </motion.div>
  );
}

export function ChatDrawer({ open, onClose, consultation, onAnalyze, astroId, onVoiceMode }) {
  const [text, setText] = useState("");
  const logRef = useRef(null);
  const { messages, submit, thinking, source } = consultation;
  const speakRef = useRef(() => {});

  const ask = useCallback(async (v) => {
    const reply = await submit(v);
    if (reply?.text && !reply.activity) speakRef.current(reply.text); // only speaks when voice is on
    if (reply?.navigate) consultation.goTo(reply.navigate); // "take me to …"
  }, [submit, consultation]);

  const answerCard = useCallback(async (yes) => {
    const r = yes ? await consultation.confirm() : consultation.cancel();
    if (r?.text && !r.activity) speakRef.current(r.text); // an activity opens the voice screen
  }, [consultation]);

  const voice = useVoice({ astroId });
  const { cancel, abortListening, speak } = voice;
  useEffect(() => { speakRef.current = speak; }, [speak]);

  // Closing the drawer stops talking and listening.
  useEffect(() => {
    if (!open) { cancel(); abortListening(); }
  }, [open, cancel, abortListening]);
  const closeDrawer = () => onClose();
  const openVoiceMode = () => { audioCtx(); cancel(); abortListening(); onVoiceMode(); };

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, open]);

  const send = (t) => {
    const v = (t ?? text).trim();
    if (!v) return;
    setText("");
    ask(v);
  };

  const mode = thinking ? "thinking" : "ready";
  const chip = MODE_CHIP[mode];

  return (
    <Drawer open={open} onClose={closeDrawer} title="Astra consultation" width={520}>
      <div className="flex items-center gap-3 border-b border-line px-5 py-4">
        <VoiceFace mode={mode} />
        <div className="min-w-0 flex-1">
          <h2 className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-base font-semibold">
            Consultation
            <span role="status" aria-live="polite" className={cx("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-caption font-semibold", chip.cls)}>
              <span className={cx("h-1.5 w-1.5 rounded-full", chip.dot)} />{chip.label}
            </span>
          </h2>
          <span className={cx("block truncate text-xs", source?.kind === "quick" ? "text-check-fg" : "text-muted")}>{sourceLine(source)}</span>
        </div>
        {onVoiceMode && (
          <button
            onClick={openVoiceMode}
            title="Voice mode: a hands-free conversation"
            aria-label="Voice mode"
            className="flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-accent px-3 text-label font-semibold text-accent-on hover:bg-accent-hover"
          >
            <Icon name="waveform" size={16} /><span className="max-sm:hidden">Voice mode</span>
          </button>
        )}
        {voice.support.tts && (
          <button
            onClick={() => { audioCtx(); voice.toggleVoice(); }}
            aria-pressed={voice.voiceOn}
            aria-label={voice.voiceOn ? "Voice on: replies are read aloud. Click to mute." : "Muted: click to hear replies."}
            title={voice.voiceOn ? "Voice on: replies are read aloud. Click to mute." : "Muted: click to hear replies."}
            className={cx("flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl border",
              voice.voiceOn ? "border-accent-text/50 bg-accent-soft text-accent-text" : "border-line-strong bg-control text-ink-2")}
          >
            <Icon name={voice.voiceOn ? "volume" : "volume-off"} size={18} />
          </button>
        )}
        <button onClick={closeDrawer} aria-label="Close consultation" className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-xl text-ink-2 hover:bg-raised"><Icon name="close" size={20} /></button>
      </div>

      <div ref={logRef} className="flex flex-1 flex-col gap-3.5 overflow-y-auto bg-input px-5 py-5">
        <AnimatePresence initial={false}>
          {messages.map((m) => <Bubble key={m.id} m={m} onAnswer={answerCard} />)}
        </AnimatePresence>
      </div>

      <div className="flex flex-col gap-3 border-t border-line px-5 py-4">
        {consultation.emergency && (
          <EmergencyCountdown
            emergency={consultation.emergency}
            onCancel={() => { const r = consultation.cancelEmergency?.(); if (r?.text) speakRef.current(r.text); }}
          />
        )}
        <div className="flex flex-wrap gap-2">
          {CHIPS.map((c) => (
            <motion.button
              key={c}
              whileTap={{ scale: 0.95 }}
              onClick={() => send(c)}
              className="min-h-9 cursor-pointer rounded-full border border-line-strong bg-raised px-3.5 text-label text-ink hover:border-accent-text/60"
            >
              {c}
            </motion.button>
          ))}
        </div>
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <input
            className="ah-input min-h-12 flex-[1_1_200px]"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Ask anything, or describe how you feel…"
            aria-label="Message to Astra"
          />
          {onVoiceMode && (
            <button
              type="button"
              onClick={openVoiceMode}
              aria-label="Talk to Astra"
              title="Talk instead: opens the voice screen"
              className="flex min-h-12 min-w-12 cursor-pointer items-center justify-center rounded-xl border border-line-strong bg-control text-sm font-semibold hover:border-accent-text/60"
            >
              <Icon name="mic" size={18} />
            </button>
          )}
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
