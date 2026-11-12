// Voice mode: a full-screen, hands-free conversation with Doctor AI (like a phone call):
// it listens, thinks, answers out loud, then listens again on its own. The orb shows what's
// happening; text stays out of the way (captions are off until you press CC). Every turn also
// lands in the normal chat, so the conversation is still there in text afterwards.
//   * tap the orb while it talks -> interrupt and talk back
//   * mic button -> pause/resume listening;  red button / Esc -> end
// The station sound (Quindar beeps, cabin hum, and -- with the neural voice -- reverb/echo)
// follows the settings chosen on /admin (lib/useVoice.js, lib/stationAudio.js).
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { Icon } from "../../../components/ui/Icon.jsx";
import { cx } from "../../../components/ui/index.jsx";
import { SpaceBackdrop } from "../../../components/layout/SpaceBackdrop.jsx";
import { VoiceOrb } from "../../../components/VoiceOrb.jsx";
import { STT_UNAVAILABLE, useVoice } from "../../../lib/useVoice.js";
import { ambience, micMeter } from "../../../lib/stationAudio.js";

const WORD = { listening: "Listening…", thinking: "Thinking…", speaking: "Speaking…" };

// Mounted only while open (ChatDrawer), so every call starts fresh.
export function VoiceMode({ onClose, astroId, submit, thinking }) {
  const [micOn, setMicOn] = useState(true);
  const [captions, setCaptions] = useState(false);
  const [heard, setHeard] = useState("");
  const [said, setSaid] = useState("");
  const live = useRef({ open: true, micOn });
  useEffect(() => { live.current.micOn = micOn; }, [micOn]);
  const voiceRef = useRef(null);

  const listenAgain = useCallback((delay = 250) => {
    setTimeout(() => {
      if (live.current.open && live.current.micOn) voiceRef.current?.startListening();
    }, delay);
  }, []);

  const onFinal = useCallback(async (text) => {
    setHeard(text);
    const reply = await submit(text);
    if (!live.current.open) return;
    if (reply?.text) {
      setSaid(reply.text);
      await voiceRef.current?.speak(reply.text);
    }
    listenAgain(150);
  }, [submit, listenAgain]);

  const voice = useVoice({
    astroId, alwaysSpeak: true, handsFree: true,
    onInterim: setHeard, onFinal, onNoSpeech: () => listenAgain(200),
  });
  useEffect(() => { voiceRef.current = voice; });
  const { startListening, abortListening, cancel, settings } = voice;

  // Open: cabin hum (if effects are on), mic meter for the orb, start listening.
  // Close: stop everything.
  useEffect(() => {
    const state = live.current; // the same object for the whole life of this component
    state.open = true;
    ambience(settings.fx);
    micMeter.start();
    const t = setTimeout(() => startListening(), 450);
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => {
      state.open = false;
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
      abortListening();
      cancel();
      ambience(false);
      micMeter.stop();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const busy = thinking || voice.preparing;
  const mode = voice.listening ? "listening" : busy ? "thinking" : voice.speaking ? "speaking" : "idle";
  const status = WORD[mode] || (!voice.support.stt ? "Voice input unavailable" : micOn ? "Tap the orb to talk" : "Mic is off");

  function tapOrb() {
    if (voice.speaking || voice.preparing) { cancel(); if (micOn) listenAgain(80); return; } // interrupt
    if (!voice.listening && micOn && !busy) startListening();
  }

  function toggleMic() {
    if (micOn) { abortListening(); setMicOn(false); }
    else { setMicOn(true); if (!voice.speaking && !busy) startListening(); }
  }

  if (typeof document === "undefined") return null;
  return createPortal(
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label="Voice conversation with Doctor AI"
          initial={{ opacity: 0, scale: 1.02 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.35 }}
          className="fixed inset-0 z-[200] flex flex-col items-center justify-between overflow-hidden px-5 py-8 text-ink"
        >
          <SpaceBackdrop />
          <div className="flex w-full max-w-3xl items-center justify-between">
            <div>
              <div className="ah-eyebrow">Doctor AI · voice</div>
              <div className="text-[13px] text-muted">
                {settings.engine === "neural" ? "Neural voice" : "Browser voice"}{settings.fx ? " · station comms" : ""}
              </div>
            </div>
            <button
              onClick={() => setCaptions((c) => !c)}
              aria-pressed={captions}
              title="Captions"
              className={cx("flex min-h-11 cursor-pointer items-center gap-2 rounded-full border px-4 text-[13px] font-semibold",
                captions ? "border-accent-text/60 bg-accent-soft text-accent-text" : "border-line-strong bg-control/60 text-ink-2")}
            >
              <Icon name="captions" size={16} /> CC
            </button>
          </div>

          <div className="flex flex-col items-center gap-6">
            <VoiceOrb
              mode={mode}
              size={Math.min(360, typeof window !== "undefined" ? Math.round(window.innerWidth * 0.8) : 360)}
              onClick={tapOrb}
              label={voice.speaking ? "Interrupt and talk" : "Talk to Doctor AI"}
            />
            {/* Swaps at once (no exit wait) so a quick Listening -> Thinking is never skipped. */}
            <motion.div
              key={status}
              role="status"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25 }}
              className="font-display text-2xl font-semibold tracking-tight"
            >
              {status}
            </motion.div>
            {captions && (heard || said) && (
              <div className="flex max-w-xl flex-col gap-2 text-center">
                {heard && <p className="m-0 text-sm text-muted">“{heard}”</p>}
                {said && <p className="m-0 text-base text-ink-2">{said}</p>}
              </div>
            )}
            {voice.error && <p role="alert" className="m-0 max-w-md text-center text-sm text-check-fg">{voice.error}</p>}
            {!voice.support.stt && !voice.error && <p className="m-0 text-sm text-check-fg">{STT_UNAVAILABLE}</p>}
          </div>

          <div className="flex items-center gap-6">
            <button
              onClick={toggleMic}
              disabled={!voice.support.stt}
              aria-pressed={!micOn}
              aria-label={micOn ? "Mute microphone" : "Unmute microphone"}
              className={cx("flex h-16 w-16 cursor-pointer items-center justify-center rounded-full border text-ink disabled:cursor-not-allowed disabled:opacity-40",
                micOn ? "border-line-strong bg-control/70 hover:bg-raised" : "border-alert-fg/60 bg-alert-bg text-alert-fg")}
            >
              <Icon name={micOn ? "mic" : "mic-off"} size={26} />
            </button>
            <button
              onClick={onClose}
              aria-label="End voice conversation"
              className="flex h-16 w-16 cursor-pointer items-center justify-center rounded-full bg-[#e5484d] text-white shadow-[0_8px_30px_rgba(229,72,77,.45)] hover:bg-[#f05257]"
            >
              <Icon name="close" size={26} />
            </button>
          </div>
        </motion.div>,
    document.body,
  );
}
