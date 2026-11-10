// Face to Face: push-to-talk voice conversation with a talking avatar (port of the
// voice half of static/js/tabs/body.js). The transcript goes through the exact same
// consultation pipeline as typed messages; the reply is spoken with edge-tts
// (POST /speak) and lip-synced.
//
// Audio rule that matters (docs/CLAUDE.md): the AudioContext must be created inside the
// real click that opens this overlay -- getSharedAudioCtx() is called synchronously from
// that click handler (ChatDrawer) -- or some browsers leave it silently "suspended".
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cx } from "../../../components/ui/index.jsx";

let sharedCtx = null;
export function getSharedAudioCtx() {
  if (!sharedCtx) sharedCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (sharedCtx.state === "suspended") sharedCtx.resume();
  return sharedCtx;
}

const REASONS = {
  "not-allowed": "Microphone access is blocked for this page. Allow the microphone in your browser's site settings, then press the mic again.",
  "service-not-allowed": "Microphone access is blocked for this page. Allow the microphone in your browser's site settings, then press the mic again.",
  network: "Voice recognition needs an internet connection. Check it and try again.",
  "no-speech": "I didn't hear anything. Press the mic and try again.",
  "audio-capture": "No microphone was found. Check one is connected and try again.",
  aborted: null,
};

const MicIcon = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 17v5" />
  </svg>
);

export function FaceToFace({ open, onClose, astroId, submit }) {
  const viewRef = useRef(null);
  const avatarRef = useRef(null);
  const recognitionRef = useRef(null);
  const [caption, setCaption] = useState("Press the mic and tell me what hurts.");
  const [state, setState] = useState(null); // null | "listening" | "thinking"
  const [supported] = useState(() => !!(window.SpeechRecognition || window.webkitSpeechRecognition));

  // Load the realistic avatar (15 s cap -- a stalled third-party loader must not leave
  // the overlay stuck), falling back to the simple procedural head.
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    const ctx = getSharedAudioCtx();
    (async () => {
      setCaption("Loading avatar…");
      try {
        const { createRealisticAvatar } = await import("../../../three/faceAvatar/realistic.js");
        const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("timed out after 15 s")), 15000));
        const avatar = await Promise.race([createRealisticAvatar(viewRef.current, ctx), timeout]);
        if (cancelled) { avatar.dispose(); return; }
        avatarRef.current = avatar;
        setCaption(supported ? "Press the mic and tell me what hurts." : "Voice input needs Chrome. You can still type in the chat.");
      } catch (err) {
        console.error("Realistic avatar failed, using the simple one:", err);
        if (cancelled || !viewRef.current) return;
        viewRef.current.innerHTML = "";
        try {
          const { createSimpleAvatar } = await import("../../../three/faceAvatar/simple.js");
          avatarRef.current = createSimpleAvatar(viewRef.current, ctx);
          setCaption(`Realistic avatar unavailable (${err.message}) -- using the simple one.`);
        } catch {
          // No WebGL at all: voice still works, just without a face.
          setCaption("3D graphics are off in this browser, so there's no avatar -- voice still works. Press the mic.");
        }
      }
    })();
    return () => {
      cancelled = true;
      recognitionRef.current?.abort?.();
      avatarRef.current?.stop?.();
      avatarRef.current?.dispose?.();
      avatarRef.current = null;
      setState(null);
    };
  }, [open, supported]);

  async function speak(text) {
    try {
      const res = await fetch(`/api/astronauts/${astroId}/speak`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`speech failed (${res.status})`);
      await avatarRef.current?.speak(await res.blob(), text);
    } catch (err) {
      // The text reply already showed -- voice failing must not break the turn, but log it.
      console.error("Face to Face: no voice this turn:", err);
    }
  }

  function listen() {
    if (!supported || state) return;
    getSharedAudioCtx(); // re-resume inside this click too
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    recognitionRef.current = rec;
    rec.lang = "en-US";
    rec.continuous = false;
    rec.interimResults = true;
    let gotFinal = false;
    rec.onresult = async (e) => {
      let final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) final += e.results[i][0].transcript;
        else setCaption(`You: ${e.results[i][0].transcript}`);
      }
      if (final.trim()) {
        gotFinal = true;
        rec.stop();
        setState("thinking");
        setCaption(`You: ${final.trim()}`);
        await submit(final.trim(), {
          onReply: async (result) => { setCaption(result.raw); await speak(result.raw); },
        });
        setState(null);
      }
    };
    rec.onspeechend = () => rec.stop();
    rec.onerror = (e) => {
      setState(null);
      const msg = REASONS[e.error] !== undefined ? REASONS[e.error] : `Voice input error (${e.error}). Press the mic to try again.`;
      if (msg) setCaption(msg);
    };
    rec.onend = () => { if (!gotFinal) setState(null); };
    setState("listening");
    setCaption("Listening…");
    rec.start();
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label="Face to face with Doctor AI"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[160] flex items-center justify-center bg-bg/95"
        >
          <motion.div
            initial={{ scale: 0.96, y: 16 }}
            animate={{ scale: 1, y: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 28 }}
            className="relative flex w-[min(92vw,560px)] flex-col items-center gap-5 px-6 py-8"
          >
            <button onClick={onClose} className="absolute top-2 right-2 min-h-10 cursor-pointer rounded-xl border border-line-strong bg-control px-4 text-sm font-semibold">Close</button>
            <div ref={viewRef} className="h-[360px] w-full [&_canvas]:block [&_canvas]:h-full [&_canvas]:w-full" />
            <AnimatePresence mode="wait">
              <motion.p key={caption} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="m-0 min-h-[1.6em] max-w-md text-center text-[17px] text-ink-2">
                {caption}
              </motion.p>
            </AnimatePresence>
            <motion.button
              onClick={listen}
              disabled={!supported || !!state}
              aria-label="Push to talk"
              whileTap={{ scale: 0.94 }}
              animate={state ? { scale: [1, 1.06, 1] } : { scale: 1 }}
              transition={state ? { duration: state === "listening" ? 1 : 1.4, repeat: Infinity } : undefined}
              className={cx(
                "flex h-[76px] w-[76px] cursor-pointer items-center justify-center rounded-full shadow-[0_10px_40px_rgb(var(--ah-accent-rgb)/.35)] disabled:cursor-not-allowed",
                state === "listening" ? "bg-alert-action text-[#1a0b10]" : state === "thinking" ? "bg-control text-ink" : "bg-accent text-accent-on",
                !supported && "opacity-50",
              )}
            >
              <MicIcon />
            </motion.button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
