// Voice mode: a full-screen, hands-free conversation with Astra (like a phone call):
// it listens, thinks, answers out loud, then listens again on its own. The orb shows what's
// happening; text stays out of the way (captions are off until you press CC). Every turn also
// lands in the normal chat, so the conversation is still there in text afterwards.
//   * tap the orb while it talks -> interrupt and talk back
//   * mic button -> pause/resume listening;  red button / Esc -> end
// The station sound (Quindar beeps, cabin hum, and -- with the neural voice -- reverb/echo)
// follows the settings chosen on /admin (lib/useVoice.js, lib/stationAudio.js).
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { Icon } from "../../../components/ui/Icon.jsx";
import { cx } from "../../../components/ui/index.jsx";
import { SpaceBackdrop } from "../../../components/layout/SpaceBackdrop.jsx";
import { VoiceOrb } from "../../../components/VoiceOrb.jsx";
import { STT_UNAVAILABLE, useVoice, voiceState } from "../../../lib/useVoice.js";
import { isBargeIn, isEcho, isStopCommand } from "../../../lib/bargeIn.js";
import { ambience, audioCtx, micMeter, quindar } from "../../../lib/stationAudio.js";
import { describeAction, isCancelPhrase } from "../../../lib/astraActions.js";
import { isYou, loudEnough, micLevels, ROOM_ORDER, roomSettings, roomStore } from "../../../lib/hearing.js";
import { EmergencyCountdown } from "../../../components/astra/EmergencyCountdown.jsx";
import { GuidedActivity } from "../../../components/astra/GuidedActivity.jsx";

const WORD = { listening: "Listening…", thinking: "Thinking…", speaking: "Speaking…" };

// Mounted only while open (by AstraProvider), so every call starts fresh.
// initialQuestion: what was said right after "Astra" ("Astra, how am I doing?") -- answered
// straight away. Without it (the name alone, or a button) it beeps once and listens.
// pending: actions Astra proposed to save, waiting for "yes" (shown as a card; the yes/no
// itself is understood by useConsultation). onNavigate: open a page after she's spoken.
// onInterrupted(heardSoFar): you talked over her -- the conversation notes how far she got.
// Talking over her: while she speaks the screen keeps listening (lib/bargeIn.js decides if
// it's you or her own voice leaking into the mic); you stop her, she waits for your words.
// Astra's newer abilities (AstraProvider passes these):
//   opening {text, speak}  -- she speaks first (a notice you answered); speak=false if she
//                             already said it out loud before the screen opened
//   announcement {text, key} -- something new to say while the call is open (waits until idle)
//   activity / onActivityDone -- a guided activity (breathing, reaction test, measuring guide)
//   emergency / onCancelEmergency -- the "calling for help in 5…" countdown
export function VoiceMode({
  onClose, astroId, submit, thinking, initialQuestion = "", pending, onConfirm, onCancelPending, onNavigate, onInterrupted,
  opening = null, announcement = null, activity = null, onActivityDone, emergency = null, onCancelEmergency, content,
}) {
  const [micOn, setMicOn] = useState(true);
  const [captions, setCaptions] = useState(false);
  const room = useSyncExternalStore(roomStore.subscribe, roomStore.get);
  const [heard, setHeard] = useState("");
  const [said, setSaid] = useState("");
  // Opened by her name on a page nobody has clicked yet (after a reload or an NFC login): the
  // browser won't let her make a sound until a click, so she'd answer in silence. Show her
  // words and a "Tap so Astra can talk" button until then.
  const [soundLocked, setSoundLocked] = useState(() => !!navigator.userActivation && !navigator.userActivation.hasBeenActive);
  useEffect(() => {
    if (!soundLocked) return undefined;
    // Any other tap unlocks sound too. Not the button itself: hiding it on pointerdown would
    // remove it before its click (the replay) ever fires.
    const on = (e) => { if (!e.target?.closest?.("[data-unlock-sound]")) setSoundLocked(false); };
    window.addEventListener("pointerdown", on);
    window.addEventListener("keydown", on);
    return () => { window.removeEventListener("pointerdown", on); window.removeEventListener("keydown", on); };
  }, [soundLocked]);
  const live = useRef({ open: true, micOn, activity });
  useEffect(() => { live.current.micOn = micOn; }, [micOn]);
  useEffect(() => { live.current.activity = activity; }, [activity]);
  useEffect(() => { live.current.emergency = emergency; }, [emergency]);
  const voiceRef = useRef(null);

  const turnRef = useRef(0); // bumps on every new turn or interruption; stale turns stop
  const cutInRef = useRef(false); // you just talked over her (the words may finish after she stopped)
  const cancelSosRef = useRef(null);

  const listenAgain = useCallback((delay = 250) => {
    setTimeout(() => {
      // While she's still talking, listen WITHOUT stopping her (so you can talk over her).
      if (live.current.open && live.current.micOn && !live.current.activity) voiceRef.current?.startListening({ keepSpeaking: voiceState.speaking });
    }, delay);
  }, []);

  // You talked over her: note how far she got, stop the VOICE (not the microphone -- it keeps
  // hearing your sentence), and end the turn she was speaking so it doesn't carry on after.
  const interrupt = useCallback(() => {
    const v = voiceRef.current;
    if (!v) return;
    const soFar = v.spokenSoFar();
    turnRef.current += 1;
    cutInRef.current = true;
    v.cancel();
    onInterrupted?.(soFar);
  }, [onInterrupted]);

  const [stuckNote, setStuckNote] = useState("");
  const onFinal = useCallback(async (text, meta = {}) => {
    // "Cancel" during the help countdown wins over everything -- even while she's talking
    // (her own words say "say cancel", so the echo check below would throw it away).
    if (live.current.emergency && isCancelPhrase(text)) {
      turnRef.current += 1;
      voiceRef.current?.cancel();
      setHeard(text);
      cancelSosRef.current?.();
      return;
    }
    // Browsers deliver your words as they come, so she's usually already stopped (cutInRef)
    // by the time the finished sentence arrives here.
    if (voiceState.speaking && isEcho(text, voiceRef.current?.currentText())) { listenAgain(100); return; } // her own voice
    // Too quiet or too unclear to be the astronaut (someone across the room, a video, noise
    // turned into words): ignore it and keep listening (lib/hearing.js, the "Room" setting).
    const since = meta.startedAt ? Date.now() - meta.startedAt + 400 : 6000;
    // While she's talking, only someone close to the mic may cut in (same rule as onInterim).
    if (voiceState.speaking && !loudEnough(micLevels, since)) { listenAgain(100); return; }
    if (!isYou({ confidence: meta.confidence, sinceMs: since }, micLevels)) {
      console.info(`[astra] ignored "${text}" (too quiet or unclear: probably the room)`);
      cutInRef.current = false;
      setHeard(text);
      setStuckNote("I didn’t catch that clearly. Say it again a little closer, or set Room to “Quiet room”.");
      listenAgain(100);
      return;
    }
    const cutIn = voiceState.speaking || cutInRef.current;
    cutInRef.current = false;
    if (voiceState.speaking) interrupt();
    if (cutIn && isStopCommand(text)) { cutInRef.current = false; setHeard(""); listenAgain(100); return; } // just "stop": wait for you
    const turn = ++turnRef.current;
    setHeard(text);
    setStuckNote("");
    const reply = await submit(text);
    if (!live.current.open || turn !== turnRef.current) return;
    if (reply?.text && !reply.activity) { // an activity speaks for itself
      setSaid(reply.text);
      await voiceRef.current?.speak(reply.text);
    }
    if (!live.current.open || turn !== turnRef.current) return; // you interrupted her
    if (reply?.navigate) { onNavigate?.(reply.navigate); return; } // closes this screen
    listenAgain(150);
  }, [submit, listenAgain, onNavigate, interrupt]);

  const onInterim = useCallback((text) => {
    setHeard(text);
    // Talking over her: new words AND loud enough to be you, so a voice across the room doesn't cut her off.
    if (voiceState.speaking && isBargeIn(text, voiceRef.current?.currentText(), roomSettings().bargeWords)
      && loudEnough(micLevels, 1500)) interrupt();
  }, [interrupt]);

  // The card's own buttons (same as saying yes/no).
  const answerCard = useCallback(async (yes) => {
    voiceRef.current?.abortListening();
    const r = yes ? await onConfirm?.() : onCancelPending?.();
    if (r?.text && !r.activity && live.current.open) {
      setSaid(r.text);
      await voiceRef.current?.speak(r.text);
    }
    listenAgain(150);
  }, [onConfirm, onCancelPending, listenAgain]);

  const voice = useVoice({
    astroId, alwaysSpeak: true, handsFree: true,
    onInterim, onFinal, onNoSpeech: () => listenAgain(200),
  });
  useEffect(() => { voiceRef.current = voice; });
  const { startListening, abortListening, cancel, settings } = voice;
  // Said by a guided activity (each step); also shown as a caption.
  const sayLine = useCallback(async (text) => {
    setSaid(text);
    await voiceRef.current?.speak(text);
  }, []);

  // A guided activity: no listening while it runs; at the end she says how it went.
  useEffect(() => {
    if (activity) voiceRef.current?.abortListening();
  }, [activity]);
  const finishActivity = useCallback(async (result) => {
    live.current.activity = null;
    onActivityDone?.(result);
    if (result?.text && live.current.open) await sayLine(result.text);
    listenAgain(150);
  }, [onActivityDone, sayLine, listenAgain]);

  const cancelSos = useCallback(async () => {
    voiceRef.current?.abortListening();
    const r = onCancelEmergency?.();
    if (r?.text) await sayLine(r.text);
    listenAgain(150);
  }, [onCancelEmergency, sayLine, listenAgain]);
  useEffect(() => { cancelSosRef.current = cancelSos; }, [cancelSos]);

  const unlockSound = () => {
    audioCtx();
    setSoundLocked(false);
    if (said) voice.speak(said); // say again, with sound, the answer she gave in silence
  };

  // Open: cabin hum (if effects are on), mic meter for the orb, start listening.
  // Close: stop everything.
  useEffect(() => {
    const state = live.current; // the same object for the whole life of this component
    state.open = true;
    ambience(settings.hum);
    micMeter.start();
    const t = setTimeout(async () => {
      if (state.activity) return; // the activity speaks for itself
      if (initialQuestion) { onFinal(initialQuestion); return; }
      if (opening?.text) {
        setSaid(opening.text);
        if (opening.speak) await voiceRef.current?.speak(opening.text);
        if (state.open) listenAgain(100);
        return;
      }
      if (settings.beeps) await quindar("start"); // "I'm listening"
      if (state.open) startListening();
    }, initialQuestion ? 250 : 400);
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
  // She may be listening while she talks (so you can cut in) -- show "Speaking" then.
  const mode = voice.speaking ? "speaking" : voice.listening ? "listening" : busy ? "thinking" : "idle";

  // Something new to say while the call is open (a notice): wait until she's free.
  const announcedKey = useRef(null);
  useEffect(() => {
    if (!announcement || announcedKey.current === announcement.key) return;
    if (activity || busy || voice.speaking || voice.preparing) return;
    announcedKey.current = announcement.key;
    voiceRef.current?.abortListening();
    (async () => {
      await sayLine(announcement.text);
      listenAgain(150);
    })();
  }, [announcement, activity, busy, voice.speaking, voice.preparing, sayLine, listenAgain]);

  // As soon as she starts talking, start listening too, so you can talk over her.
  useEffect(() => {
    if (!voice.speaking || !micOn || activity) return undefined;
    const t = setTimeout(() => voiceRef.current?.startListening({ keepSpeaking: true }), 350);
    return () => clearTimeout(t);
  }, [voice.speaking, micOn, activity]);
  const status = WORD[mode] || (!voice.support.stt ? "Voice input unavailable" : micOn ? "Tap the orb to talk" : "Mic is off");

  // Safety nets so the screen can never freeze until a refresh:
  //  * stuck on Thinking/Speaking for 40 s -> stop, say so, listen again;
  //  * idle (not listening, nothing happening) with the mic on -> start listening again.
  useEffect(() => {
    if (mode === "thinking" || mode === "speaking") {
      const t = setTimeout(() => {
        console.warn(`[astra] voice screen stuck on "${mode}" for 40 s, resetting`);
        voiceRef.current?.cancel();
        setStuckNote("That took too long, so I stopped. Please ask again.");
        listenAgain(100);
      }, 40000);
      return () => clearTimeout(t);
    }
    if (mode === "idle" && micOn && voice.support.stt && !activity) {
      const t = setTimeout(() => listenAgain(0), 2500);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [mode, micOn, voice.support.stt, listenAgain, activity]);

  function tapOrb() {
    if (voice.speaking || voice.preparing) { interrupt(); if (micOn) listenAgain(80); return; } // interrupt
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
          aria-label="Voice conversation with Astra"
          initial={{ opacity: 0, scale: 1.02 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.35 }}
          className="fixed inset-0 z-[200] flex flex-col items-center justify-between overflow-hidden px-5 py-8 text-ink"
        >
          <SpaceBackdrop />
          <div className="flex w-full max-w-3xl items-center justify-between">
            <div>
              <div className="ah-eyebrow">Astra · voice</div>
              <div className="text-[13px] text-muted">
                {settings.engine === "neural" ? "Neural voice" : "Browser voice"}{settings.engine === "neural" && settings.echo !== "off" ? ` · ${settings.echo} echo` : ""}{settings.beeps ? " · comms beeps" : ""}
              </div>
            </div>
            <div className="flex items-center gap-2">
            <button
              onClick={() => roomStore.set(ROOM_ORDER[(ROOM_ORDER.indexOf(room) + 1) % ROOM_ORDER.length])}
              title="How much background noise is around you. Noisy room: Astra only listens to clear, close speech. Quiet room: she catches a soft voice."
              aria-label={`Room: ${roomSettings(room).label}. Click to change.`}
              className="flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-line-strong bg-control/60 px-4 text-[13px] font-semibold text-ink-2"
            >
              <Icon name="mic" size={16} /><span className="max-sm:hidden">Room:</span> {roomSettings(room).label}
            </button>
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
          </div>

          <div className="flex flex-col items-center gap-6">
            {activity ? (
              <>
                <GuidedActivity activity={activity} astroId={astroId} content={content} speak={sayLine} onDone={finishActivity} />
                <button onClick={() => { voiceRef.current?.cancel(); finishActivity({ text: "Okay, we'll stop there." }); }} className="min-h-10 cursor-pointer rounded-xl border border-line-strong bg-control/60 px-4 text-[13px] font-semibold text-ink-2 hover:text-ink">
                  Stop
                </button>
              </>
            ) : (<>
            <VoiceOrb
              mode={mode}
              size={Math.min(360, typeof window !== "undefined" ? Math.round(window.innerWidth * 0.8) : 360)}
              onClick={tapOrb}
              label={voice.speaking ? "Interrupt and talk" : "Talk to Astra"}
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
            </>)}
            {emergency && <EmergencyCountdown emergency={emergency} onCancel={cancelSos} />}
            {soundLocked && (
              <button
                type="button"
                onClick={unlockSound}
                data-unlock-sound
                className="flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-check-fg/60 bg-control/70 px-4 text-sm font-semibold text-check-fg"
              >
                <Icon name="volume" size={16} /> Tap so Astra can talk
              </button>
            )}
            {(captions || soundLocked) && (heard || said) && (
              <div className="flex max-w-xl flex-col gap-2 text-center">
                {heard && <p className="m-0 text-sm text-muted">“{heard}”</p>}
                {said && <p className="m-0 text-base text-ink-2">{said}</p>}
              </div>
            )}
            {pending && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                role="group"
                aria-label="Waiting for your yes"
                className="flex w-full max-w-md flex-col gap-3 ah-glass-flat rounded-2xl p-4"
              >
                <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm text-ink">
                  {pending.actions.map((a, i) => <li key={i}>{describeAction(a)}</li>)}
                </ul>
                <div className="flex items-center gap-2">
                  <span className="mr-auto text-xs text-muted">Say “yes” or “no”</span>
                  <button onClick={() => answerCard(false)} className="min-h-10 cursor-pointer rounded-xl border border-line-strong bg-control px-3.5 text-[13px] font-semibold">No</button>
                  <button onClick={() => answerCard(true)} className="min-h-10 cursor-pointer rounded-xl bg-accent px-3.5 text-[13px] font-bold text-accent-on hover:bg-accent-hover">Yes</button>
                </div>
              </motion.div>
            )}
            {stuckNote && !voice.error && <p className="m-0 max-w-md text-center text-sm text-check-fg">{stuckNote}</p>}
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
