// Voice for the Astra chat and voice mode. Listening always uses the browser's Web
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
import { spokenPart } from "./bargeIn.js";

// Shared, mutable on purpose: the face/orb read `mouth` every animation frame without
// making React re-render 60 times a second.
export const voiceState = { speaking: false, listening: false, mouth: 0 };
export const ENDPOINT_MS = 1200; // your words stopped changing this long = you've finished
export const MAX_PHRASE_MS = 12000; // never listen to one phrase longer than this

export const MAX_SPOKEN_CHARS = 600;
export const MIC_DENIED = "Microphone permission denied - text input still works";
export const STT_UNAVAILABLE = "Voice input unavailable in this browser - use text";
const STORE_KEY = "ah-voice";
const DEFAULT_SETTINGS = {
  engine: "browser", browser_gender: "female", echo: "medium", radio: false, beeps: true, hum: true, rate: 1, pitch: "normal", notices: "speak",
};
const BROWSER_PITCH = { low: 0.85, normal: 1, high: 1.15 };

// Browser voices have no "gender" field, only names -- these are the common ones.
const MALE_NAMES = /\b(male|guy|andrew|brian|christopher|eric|roger|steffan|david|mark|james|daniel|alex|fred|tom|oliver|arthur|aaron|ryan|thomas|william)\b/i;
const FEMALE_NAMES = /\b(female|aria|jenny|ava|emma|michelle|samantha|zira|hazel|susan|karen|moira|tessa|victoria|sonia|libby|natasha|serena|kate)\b/i;

/** The browser voice to use. female (default): Edge's "Aria"/"Jenny" first, then the spec's
 *  order (en-US/en-GB named female/Samantha/Zira/Google, any "en*", null = default).
 *  male: Edge's Guy/Andrew, Chrome's "Google UK English Male", Windows David/Mark, Mac
 *  Daniel/Alex…, then any English voice that isn't clearly female. */
export function pickVoice(voices = [], gender = "female") {
  const usGb = (v) => /^en[-_](us|gb)$/i.test(v.lang || "");
  const en = (v) => /^en/i.test(v.lang || "");
  if (gender === "male") {
    return (
      voices.find((v) => usGb(v) && /guy|andrew/i.test(v.name || "")) ||
      voices.find((v) => usGb(v) && MALE_NAMES.test(v.name || "")) ||
      voices.find((v) => en(v) && MALE_NAMES.test(v.name || "")) ||
      voices.find((v) => en(v) && !FEMALE_NAMES.test(v.name || "")) ||
      voices.find(en) ||
      null
    );
  }
  return (
    voices.find((v) => usGb(v) && /aria|jenny/i.test(v.name || "")) ||
    voices.find((v) => usGb(v) && /female|samantha|zira|google/i.test(v.name || "") && !/\bmale\b/i.test(v.name || "")) ||
    voices.find((v) => en(v) && !MALE_NAMES.test(v.name || "")) ||
    voices.find(en) ||
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
  const progress = useRef(null); // { text, chars } of what she's saying now
  const live = useRef({});
  useEffect(() => {
    live.current = { onInterim, onFinal, onNoSpeech, voiceOn, settings, astroId, alwaysSpeak, handsFree };
  });

  // Chrome fills getVoices() asynchronously: choose now, and again when the list arrives
  // (and whenever the admin switches the browser voice between female and male).
  const gender = settings.browser_gender;
  useEffect(() => {
    const s = getSynth();
    if (!s) return undefined;
    const choose = () => { voiceRef.current = pickVoice(s.getVoices(), gender); };
    choose();
    if (s.addEventListener) {
      s.addEventListener("voiceschanged", choose);
      return () => s.removeEventListener("voiceschanged", choose);
    }
    s.onvoiceschanged = choose;
    return () => { s.onvoiceschanged = null; };
  }, [gender]);

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
    const { rate = 1, pitch = "normal" } = live.current.settings || {};
    u.rate = 1.02 * rate;
    u.pitch = BROWSER_PITCH[pitch] ?? 1;
    if (voiceRef.current) {
      u.voice = voiceRef.current;
      u.lang = voiceRef.current.lang;
    }
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    u.onstart = () => { if (token === tokenRef.current) setTalking(true); };
    u.onend = finish;
    u.onerror = finish;
    u.onboundary = (e) => {
      voiceState.mouth = 1;
      if (progress.current && typeof e.charIndex === "number") progress.current.chars = e.charIndex + (e.charLength || 0);
    };
    setTimeout(finish, 6000 + text.length * 110); // Chrome sometimes never fires onend
    // Chrome's speech queue can get stuck "paused" (e.g. after the tab was hidden): clear it.
    s.cancel();
    if (s.paused) s.resume();
    s.speak(u);
  }), [setTalking]);

  const speak = useCallback(async (text) => {
    const cfg = live.current;
    if (!text || (!cfg.alwaysSpeak && !cfg.voiceOn)) return;
    const spoken = String(text).slice(0, MAX_SPOKEN_CHARS);
    cancel();
    progress.current = { text: spoken, chars: 0 };
    const token = tokenRef.current;
    const mine = () => token === tokenRef.current;
    const { engine, beeps, echo, radio } = cfg.settings;
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
      if (beeps) await quindar("start");
      if (!mine()) return;
      let played = false;
      if (audio) {
        try {
          await playNeural(audio, { echo, radio });
          played = true;
        } catch (err) {
          console.warn("[astra] neural voice couldn't play, using the browser voice:", err?.message || err);
        }
      }
      if (!played && mine()) await speakBrowser(spoken, token);
      if (!mine()) return;
      if (beeps) await quindar("end");
    } finally {
      if (mine()) {
        setPreparing(false);
        setTalking(false);
      }
    }
  }, [cancel, setTalking, speakBrowser]);

  // What she's saying right now, and how much of it she'd actually said (whole words) --
  // read this BEFORE cancel() when the astronaut interrupts.
  const currentText = useCallback(() => progress.current?.text || "", []);
  const spokenSoFar = useCallback(() => {
    const p = progress.current;
    if (!p) return "";
    let chars = p.chars;
    if (output.startedAtMs && output.durationMs) {
      chars = Math.round(Math.min(1, (performance.now() - output.startedAtMs) / output.durationMs) * p.text.length);
    }
    return spokenPart(p.text, chars);
  }, []);

  // keepSpeaking: listen WHILE she talks (so you can talk over her) instead of stopping her.
  const startListening = useCallback(({ keepSpeaking = false } = {}) => {
    if (!Recognition) { setError(STT_UNAVAILABLE); return; }
    if (recRef.current) return;
    if (!keepSpeaking) cancel(); // don't talk over the astronaut
    setError(null);
    const rec = new Recognition();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    heardRef.current = { final: "", interim: "", failed: false, aborted: false, confidence: 0, startedAt: Date.now() };
    // End of speech, decided here too: in a noisy room the browser keeps "hearing" the
    // background and can wait a long time before it finishes a phrase. Once your words stop
    // changing for ENDPOINT_MS (or you've talked for MAX_PHRASE_MS), stop and use them.
    let lastText = "", quietTimer = null, capTimer = null;
    const finishNow = () => { clearTimeout(quietTimer); clearTimeout(capTimer); try { rec.stop(); } catch { /* already ended */ } };
    rec.onresult = (e) => {
      let fin = "", interim = "", confidence = 0;
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) { fin += r[0].transcript; confidence = Math.max(confidence, r[0].confidence || 0); }
        else interim += r[0].transcript;
      }
      heardRef.current.final = fin;
      heardRef.current.interim = interim;
      heardRef.current.confidence = confidence;
      const text = `${fin}${interim}`.trim();
      if (text && text !== lastText) {
        lastText = text;
        clearTimeout(quietTimer);
        quietTimer = setTimeout(finishNow, ENDPOINT_MS);
        if (!capTimer) capTimer = setTimeout(finishNow, MAX_PHRASE_MS);
      }
      live.current.onInterim?.(text);
    };
    rec.onerror = (e) => {
      if (e.error === "aborted") return;
      if (e.error === "no-speech" && live.current.handsFree) return; // silence: just listen again
      heardRef.current.failed = true;
      setError(voiceErrorMessage(e.error));
    };
    rec.onend = () => {
      clearTimeout(quietTimer);
      clearTimeout(capTimer);
      recRef.current = null;
      voiceState.listening = false;
      setListening(false);
      const heard = heardRef.current;
      if (heard.aborted || heard.failed) return;
      const text = (heard.final || heard.interim).trim();
      // with how sure the recognizer was, and when listening began (lib/hearing.js's checks)
      if (text) live.current.onFinal?.(text, { confidence: heard.final ? heard.confidence : 0, startedAt: heard.startedAt });
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
    speak, cancel, startListening, stopListening, abortListening, voiceOn, toggleVoice, currentText, spokenSoFar,
    speaking, preparing, listening, error, setError, support, settings, state: voiceState,
  };
}
