// Voice for the Doctor AI chat and voice mode. Listening always uses the browser's Web
// Speech API (SpeechRecognition). Speaking uses the engine chosen on /admin
// (GET /api/voice-settings):
//   * "browser" -- speechSynthesis on this computer: offline, but no echo is possible
//     (the page never receives that sound). Station FX = Quindar beeps around it.
//   * "neural"  -- POST /astronauts/<id>/speak returns Microsoft's neural voice as MP3 and
//     lib/stationAudio.js plays it with the station reverb/echo + Quindar beeps. Falls back
//     to the browser voice if that fails (no internet...).
// Voice is an enhancement -- typing always works, with or without any of this.
//
// Note: in Chrome the *recognition* audio goes to Google's servers (Edge: Microsoft's), so
// it isn't fully local. Firefox has no SpeechRecognition at all.
import { useCallback, useEffect, useRef, useState } from "react";
import { useVoiceSettings } from "./queries.js";
import { levelOf, output, playNeural, quindar, stopNeural } from "./stationAudio.js";

// Shared, mutable on purpose: the face/orb read `mouth` every animation frame without
// making React re-render 60 times a second.
export const voiceState = { speaking: false, listening: false, mouth: 0 };

export const MAX_SPOKEN_CHARS = 600;
export const MIC_DENIED = "Microphone permission denied - text input still works";
export const STT_UNAVAILABLE = "Voice input unavailable in this browser - use text";
const STORE_KEY = "ah-voice";
const DEFAULT_SETTINGS = { engine: "browser", fx: true };

/** A calm female voice first (Edge's "Aria"/"Jenny" Natural voices), then the spec's order:
 *  1. en-US/en-GB named female/Samantha/Zira/Google, 2. any "en*", 3. null (= default). */
export function pickVoice(voices = []) {
  const usGb = (v) => /^en[-_](us|gb)$/i.test(v.lang || "");
  return (
    voices.find((v) => usGb(v) && /aria|jenny/i.test(v.name || "")) ||
    voices.find((v) => usGb(v) && /female|samantha|zira|google/i.test(v.name || "")) ||
    voices.find((v) => /^en/i.test(v.lang || "")) ||
    null
  );
}

export function voiceErrorMessage(error) {
  return error === "not-allowed" ? MIC_DENIED : `Voice error: ${error}`;
}

function getSynth() {
  return typeof window !== "undefined" && window.speechSynthesis && window.SpeechSynthesisUtterance ? window.speechSynthesis : null;
}

function getRecognition() {
  return typeof window !== "undefined" ? window.SpeechRecognition || window.webkitSpeechRecognition || null : null;
}

/**
 * useVoice({ astroId, onInterim, onFinal, onNoSpeech, alwaysSpeak, handsFree })
 *   onInterim(text): live transcript while listening. onFinal(text): what was said.
 *   onNoSpeech(): listening ended with nothing heard (voice mode just listens again).
 *   alwaysSpeak: ignore the Voice on/Muted toggle (voice mode always talks).
 *   handsFree: don't show "no-speech" as an error (silence is normal in voice mode).
 * speak(text) returns a promise that resolves when it has finished talking.
 */
export function useVoice({ astroId, onInterim, onFinal, onNoSpeech, alwaysSpeak = false, handsFree = false } = {}) {
  const synth = getSynth();
  const Recognition = getRecognition();
  const support = { tts: !!synth, stt: !!Recognition };
  const settings = { ...DEFAULT_SETTINGS, ...(useVoiceSettings().data || {}) };

  const [voiceOn, setVoiceOn] = useState(() => {
    try {
      return localStorage.getItem(STORE_KEY) !== "off";
    } catch {
      return true;
    }
  });
  const [speaking, setSpeaking] = useState(false);
  const [preparing, setPreparing] = useState(false); // fetching the neural audio
  const [listening, setListening] = useState(false);
  const [error, setError] = useState(Recognition ? null : STT_UNAVAILABLE);

  const voiceRef = useRef(null);
  const recRef = useRef(null);
  const heardRef = useRef({ final: "", interim: "", failed: false, aborted: false });
  const rafRef = useRef(0);
  const tokenRef = useRef(0);
  const live = useRef({});
  useEffect(() => {
    live.current = { onInterim, onFinal, onNoSpeech, voiceOn, settings, astroId, alwaysSpeak, handsFree };
  });

  // Chrome fills getVoices() asynchronously: choose now, and again when the list arrives.
  useEffect(() => {
    const s = getSynth();
    if (!s) return undefined;
    const choose = () => { voiceRef.current = pickVoice(s.getVoices()); };
    choose();
    if (s.addEventListener) {
      s.addEventListener("voiceschanged", choose);
      return () => s.removeEventListener("voiceschanged", choose);
    }
    s.onvoiceschanged = choose;
    return () => { s.onvoiceschanged = null; };
  }, []);

  // Mouth: from the real loudness when the neural voice plays; otherwise jumps to 1 on each
  // word boundary and decays every frame, with a small oscillation while speaking.
  const runMouth = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    const tick = (t) => {
      if (voiceState.speaking && output.analyser) {
        voiceState.mouth = Math.max(voiceState.mouth * 0.7, levelOf(output.analyser));
      } else if (voiceState.speaking) {
        voiceState.mouth = Math.max(voiceState.mouth * 0.86, 0.16 + 0.12 * Math.sin(t / 65));
      } else {
        voiceState.mouth *= 0.8;
      }
      if (voiceState.speaking || voiceState.mouth > 0.01) rafRef.current = requestAnimationFrame(tick);
      else voiceState.mouth = 0;
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const setTalking = useCallback((on) => {
    voiceState.speaking = on;
    setSpeaking(on);
    if (on) runMouth();
  }, [runMouth]);

  const cancel = useCallback(() => {
    tokenRef.current += 1; // anything still in flight for an older reply is dropped
    getSynth()?.cancel();
    stopNeural();
    setPreparing(false);
    voiceState.speaking = false;
    setSpeaking(false);
  }, []);

  const speakBrowser = useCallback((text, token) => new Promise((resolve) => {
    const s = getSynth();
    if (!s) { resolve(); return; }
    const u = new window.SpeechSynthesisUtterance(text);
    u.rate = 1.02;
    u.pitch = 1;
    if (voiceRef.current) {
      u.voice = voiceRef.current;
      u.lang = voiceRef.current.lang;
    }
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    u.onstart = () => { if (token === tokenRef.current) setTalking(true); };
    u.onend = finish;
    u.onerror = finish;
    u.onboundary = () => { voiceState.mouth = 1; };
    setTimeout(finish, 6000 + text.length * 110); // Chrome sometimes never fires onend
    s.speak(u);
  }), [setTalking]);

  const speak = useCallback(async (text) => {
    const cfg = live.current;
    if (!text || (!cfg.alwaysSpeak && !cfg.voiceOn)) return;
    const spoken = String(text).slice(0, MAX_SPOKEN_CHARS);
    cancel();
    const token = tokenRef.current;
    const mine = () => token === tokenRef.current;
    const { engine, fx } = cfg.settings;
    try {
      let audio = null;
      if (engine === "neural" && cfg.astroId) {
        setPreparing(true);
        try {
          const res = await fetch(`/api/astronauts/${cfg.astroId}/speak`, {
            method: "POST", credentials: "same-origin",
            headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: spoken }),
          });
          if (res.ok) audio = await res.arrayBuffer();
        } catch { /* no internet: the browser voice below */ }
        if (!mine()) return;
        setPreparing(false);
      }
      setTalking(true);
      if (fx) await quindar("start");
      if (!mine()) return;
      let played = false;
      if (audio) {
        try {
          await playNeural(audio, { fx });
          played = true;
        } catch { /* undecodable audio: the browser voice below */ }
      }
      if (!played && mine()) await speakBrowser(spoken, token);
      if (!mine()) return;
      if (fx) await quindar("end");
    } finally {
      if (mine()) {
        setPreparing(false);
        setTalking(false);
      }
    }
  }, [cancel, setTalking, speakBrowser]);

  const startListening = useCallback(() => {
    if (!Recognition) { setError(STT_UNAVAILABLE); return; }
    if (recRef.current) return;
    cancel(); // don't talk over the astronaut
    setError(null);
    const rec = new Recognition();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    heardRef.current = { final: "", interim: "", failed: false, aborted: false };
    rec.onresult = (e) => {
      let fin = "", interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) fin += r[0].transcript;
        else interim += r[0].transcript;
      }
      heardRef.current.final = fin;
      heardRef.current.interim = interim;
      live.current.onInterim?.(`${fin}${interim}`.trim());
    };
    rec.onerror = (e) => {
      if (e.error === "aborted") return;
      if (e.error === "no-speech" && live.current.handsFree) return; // silence: just listen again
      heardRef.current.failed = true;
      setError(voiceErrorMessage(e.error));
    };
    rec.onend = () => {
      recRef.current = null;
      voiceState.listening = false;
      setListening(false);
      const heard = heardRef.current;
      if (heard.aborted || heard.failed) return;
      const text = (heard.final || heard.interim).trim();
      if (text) live.current.onFinal?.(text);
      else live.current.onNoSpeech?.();
    };
    try {
      rec.start();
    } catch (err) {
      setError(voiceErrorMessage(err?.name || "start-failed"));
      return;
    }
    recRef.current = rec;
    voiceState.listening = true;
    setListening(true);
  }, [Recognition, cancel]);

  const stopListening = useCallback(() => { recRef.current?.stop(); }, []);

  const abortListening = useCallback(() => {
    if (!recRef.current) return;
    heardRef.current.aborted = true;
    recRef.current.abort();
    recRef.current = null;
    voiceState.listening = false;
    setListening(false);
  }, []);

  const toggleVoice = useCallback(() => {
    setVoiceOn((on) => {
      const next = !on;
      try { localStorage.setItem(STORE_KEY, next ? "on" : "off"); } catch { /* private mode: just not remembered */ }
      if (!next) cancel();
      return next;
    });
  }, [cancel]);

  // Unmount: stop talking, stop listening, stop the mouth loop.
  useEffect(() => () => {
    tokenRef.current += 1;
    getSynth()?.cancel();
    stopNeural();
    if (recRef.current) { heardRef.current.aborted = true; recRef.current.abort(); }
    cancelAnimationFrame(rafRef.current);
    voiceState.speaking = false;
    voiceState.listening = false;
    voiceState.mouth = 0;
  }, []);

  return {
    speak, cancel, startListening, stopListening, abortListening, voiceOn, toggleVoice,
    speaking, preparing, listening, error, setError, support, settings, state: voiceState,
  };
}
