// The station's sound (Web Audio, no libraries, no audio files):
//  * quindar()   the Apollo-era "Quindar" tones NASA played at the start (2525 Hz) and end
//                (2475 Hz) of every capcom transmission -- 250 ms each, kept quiet.
//  * ambience()  a soft cabin hum (filtered brown noise + a low 60 Hz tone) under voice mode.
//  * playNeural() plays the Microsoft neural voice's MP3 through a light radio band-pass, a
//                metal-cabin reverb (impulse response generated in code) and a soft feedback
//                echo. This only works for audio the page receives -- the browser's own
//                speechSynthesis voice can't be processed (the page never gets its sound).
//  * micMeter    reads the microphone level: the voice-mode orb, and lib/hearing.js's
//                "is that you or the room?" check.
// One shared AudioContext, created/resumed inside a click (browsers block sound otherwise).

import { micLevels } from "./hearing.js";

let ctx = null;

export function audioCtx() {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

// ---- Quindar tones ----
export const QUINDAR_HZ = { start: 2525, end: 2475 };
export const quindarFrequency = (kind) => (kind === "end" ? QUINDAR_HZ.end : QUINDAR_HZ.start);

export function quindar(kind = "start") {
  const c = audioCtx();
  if (!c) return Promise.resolve();
  const t = c.currentTime + 0.02;
  const osc = c.createOscillator();
  osc.type = "sine";
  osc.frequency.value = quindarFrequency(kind);
  const g = c.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.06, t + 0.008);
  g.gain.setValueAtTime(0.06, t + 0.242);
  g.gain.linearRampToValueAtTime(0, t + 0.25);
  osc.connect(g).connect(c.destination);
  osc.start(t);
  osc.stop(t + 0.26);
  markAstraSound(290);
  return new Promise((resolve) => setTimeout(resolve, 320));
}

/** A soft tone (the breathing exercise's phase changes). */
export function chime(freq = 440, ms = 260, volume = 0.05) {
  const c = audioCtx();
  if (!c) return;
  const t = c.currentTime + 0.01;
  const osc = c.createOscillator();
  osc.type = "sine";
  osc.frequency.value = freq;
  const g = c.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(volume, t + 0.03);
  g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
  osc.connect(g).connect(c.destination);
  osc.start(t);
  osc.stop(t + ms / 1000 + 0.05);
  markAstraSound(ms + 60);
}

// ---- cabin hum ----
let amb = null;

export function ambience(on) {
  const c = audioCtx();
  if (!c) return;
  const now = c.currentTime;
  if (on && !amb) {
    const len = c.sampleRate * 3;
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { // brown noise: a deep, soft rumble
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3.5;
    }
    const noise = c.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 220;
    const hum = c.createOscillator();
    hum.frequency.value = 60;
    const humGain = c.createGain();
    humGain.gain.value = 0.18;
    const g = c.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.045, now + 1.5);
    noise.connect(lp).connect(g);
    hum.connect(humGain).connect(g);
    g.connect(c.destination);
    noise.start();
    hum.start();
    amb = { noise, hum, g };
  } else if (!on && amb) {
    const { noise, hum, g } = amb;
    amb = null;
    g.gain.setValueAtTime(g.gain.value, now);
    g.gain.linearRampToValueAtTime(0, now + 0.5);
    setTimeout(() => { try { noise.stop(); hum.stop(); } catch { /* already stopped */ } }, 600);
  }
}

// ---- the neural voice, with station reverb + echo ----
// analyser: live loudness of the neural voice; startedAtMs/durationMs: how far into the clip
// she is (for "what had she said when you interrupted").
export const output = { analyser: null, startedAtMs: null, durationMs: null };

// ---- is Astra's sound coming out of the speakers RIGHT NOW? ----
// For "Wanna talk?" (lib/toneCapture.js): audio recorded while this is true is hers, not the
// astronaut's. Deliberately NOT useVoice's voiceState.speaking, which covers her whole turn
// (before the start beep, the echo wait, the end beep, and a late or missing browser onend)
// and so also covered the astronaut's reply right after she stopped. This follows the sound:
//   * beeps/chimes: their real length (markAstraSound);
//   * the neural voice: its real output level, echo tail included (output.analyser);
//   * the browser voice (no level available to the page): speechSynthesis.speaking.
let soundUntil = 0;
export function markAstraSound(ms) { soundUntil = Math.max(soundUntil, performance.now() + ms); }
export const AUDIBLE_LEVEL = 0.01; // levelOf() of her output above this = audible
export function astraAudible() {
  if (performance.now() < soundUntil) return true;
  if (output.analyser && levelOf(output.analyser) > AUDIBLE_LEVEL) return true;
  const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
  return !!(synth && synth.speaking && !synth.paused);
}
let current = null; // { src, resolve }
const impulses = {};

// How much "station" is on the voice, chosen on /admin. off = clean voice.
const ECHO = {
  off: null,
  light: { tail: 0.9, wet: 0.14, delay: 0.14, feedback: 0.12, echo: 0.08 },
  medium: { tail: 1.4, wet: 0.3, delay: 0.17, feedback: 0.26, echo: 0.2 },
  strong: { tail: 2.4, wet: 0.45, delay: 0.22, feedback: 0.4, echo: 0.32 },
};
/** The reverb/echo numbers for an echo level (null = no echo). Unknown -> medium. */
export const echoParams = (level) => (level in ECHO ? ECHO[level] : ECHO.medium);

function makeImpulse(c, seconds) {
  // Decaying noise (the reverb tail) plus a few strong early reflections:
  // the "hard metal walls of a small module" sound.
  const rate = c.sampleRate, len = Math.floor(rate * seconds);
  const buf = c.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
    [0.009, 0.019, 0.031, 0.047, 0.066].forEach((s, k) => {
      const idx = Math.floor((s + ch * 0.0027) * rate);
      if (idx < len) d[idx] += 0.7 / (k + 1);
    });
  }
  return buf;
}

export function stopNeural() {
  if (!current) return;
  const { src, resolve } = current;
  current = null;
  output.analyser = null;
  output.startedAtMs = null;
  try { src.onended = null; src.stop(); } catch { /* not started yet */ }
  resolve();
}

/** Can the page make sound right now? (false until the first click after a page load) */
export const audioUnlocked = () => !ctx || ctx.state === "running";

// "Space radio": a narrow telephone-like band and a little crackle.
function radioChain(c, input) {
  const band = c.createBiquadFilter(); band.type = "bandpass"; band.frequency.value = 1500; band.Q.value = 0.9;
  const hp = c.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 300;
  const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 3400;
  const crackle = c.createWaveShaper();
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) { const x = (i / (curve.length - 1)) * 2 - 1; curve[i] = Math.tanh(2.2 * x); }
  crackle.curve = curve;
  const gain = c.createGain(); gain.gain.value = 1.4;
  input.connect(hp).connect(lp).connect(band).connect(crackle).connect(gain);
  return gain;
}

/** Plays MP3/encoded audio; resolves when it has finished (or was stopped). Throws
 *  "audio-locked" if the browser won't let the page make sound yet (no click since the page
 *  loaded) -- a suspended AudioContext never plays, so it would otherwise wait forever. */
export async function playNeural(arrayBuffer, { echo = "medium", radio = false } = {}) {
  const c = audioCtx();
  if (!c) throw new Error("Web Audio unavailable");
  if (c.state !== "running") {
    await Promise.race([c.resume().catch(() => {}), new Promise((r) => setTimeout(r, 400))]);
    if (c.state !== "running") throw new Error("audio-locked");
  }
  const audio = await c.decodeAudioData(arrayBuffer.slice(0));
  stopNeural();
  const src = c.createBufferSource();
  src.buffer = audio;
  const comp = c.createDynamicsCompressor();
  const analyser = c.createAnalyser();
  analyser.fftSize = 1024;
  const fx = echoParams(echo);
  const voice = radio ? radioChain(c, src) : src;
  if (fx) {
    const hp = c.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 160;
    const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 6800;
    const dry = c.createGain(); dry.gain.value = 0.9;
    impulses[fx.tail] = impulses[fx.tail] || makeImpulse(c, fx.tail);
    const verb = c.createConvolver(); verb.buffer = impulses[fx.tail];
    const wet = c.createGain(); wet.gain.value = fx.wet;
    const delay = c.createDelay(1); delay.delayTime.value = fx.delay;
    const tone = c.createBiquadFilter(); tone.type = "lowpass"; tone.frequency.value = 3200;
    const feedback = c.createGain(); feedback.gain.value = fx.feedback;
    const echoGain = c.createGain(); echoGain.gain.value = fx.echo;
    voice.connect(hp).connect(lp);
    lp.connect(dry).connect(comp);
    lp.connect(verb).connect(wet).connect(comp);
    lp.connect(delay);
    delay.connect(tone);
    tone.connect(feedback).connect(delay); // each repeat a little darker and quieter
    tone.connect(echoGain).connect(comp);
  } else {
    voice.connect(comp);
  }
  comp.connect(analyser);
  analyser.connect(c.destination);
  output.analyser = analyser;
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (current?.src === src) current = null;
      output.startedAtMs = null;
      setTimeout(() => { if (output.analyser === analyser) output.analyser = null; resolve(); }, fx ? fx.tail * 320 : 0); // let the echo ring out
    };
    current = { src, resolve: finish };
    src.onended = finish;
    // Safety net: never wait longer than the clip itself (if "ended" is ever lost, e.g. the
    // context gets suspended mid-play), so the voice screen can't freeze on "Speaking…".
    setTimeout(finish, (audio.duration + 3) * 1000);
    output.startedAtMs = performance.now();
    output.durationMs = audio.duration * 1000;
    src.start();
  });
}

// ---- microphone level (voice-mode orb while listening) ----
// source: the microphone's MediaStreamSource, so the "Wanna talk?" voice tone capture
// (lib/toneCapture.js) records from this SAME microphone instead of opening its own.
export const input = { analyser: null, source: null };
let micStream = null;
let micUsers = 0;
let micTimer = null;
let micStarting = null;

// Shared by the voice screen (the orb) and the wake-word listener (telling your voice from the
// room, lib/hearing.js): each start() needs its own stop(); the microphone closes after the last.
export const micMeter = {
  async start() {
    micUsers += 1;
    if (micStream) return true;
    if (!micStarting) micStarting = this._open();
    return micStarting;
  },
  async _open() {
    const c = audioCtx();
    if (!c || !navigator.mediaDevices?.getUserMedia) { micStarting = null; return false; }
    let stream;
    try {
      // Noise suppression lowers steady sounds (fans, hum); no auto-gain, so a voice close to the
      // microphone really is louder than the room.
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
    } catch {
      micStarting = null;
      return false; // no meter: the orb just breathes, and the hearing gates let everything through
    }
    micStarting = null;
    if (micUsers <= 0) { stream.getTracks().forEach((t) => t.stop()); return false; } // stopped meanwhile
    micStream = stream;
    const analyser = c.createAnalyser();
    analyser.fftSize = 1024;
    const source = c.createMediaStreamSource(micStream);
    source.connect(analyser); // measured only, never played back
    input.analyser = analyser;
    input.source = source;
    micLevels.reset();
    micTimer = setInterval(() => { if (c.state === "running") micLevels.push(levelOf(analyser), Date.now()); }, 60);
    return true;
  },
  stop() {
    micUsers = Math.max(0, micUsers - 1);
    if (micUsers > 0) return;
    clearInterval(micTimer);
    micTimer = null;
    micStream?.getTracks().forEach((t) => t.stop());
    micStream = null;
    input.analyser = null;
    input.source = null;
  },
};

const scratch = new Float32Array(1024);

/** 0..1 loudness of an analyser right now. */
export function levelOf(analyser) {
  if (!analyser) return 0;
  analyser.getFloatTimeDomainData(scratch);
  let sum = 0;
  for (let i = 0; i < scratch.length; i++) sum += scratch[i] * scratch[i];
  return Math.min(1, Math.sqrt(sum / scratch.length) * 4.5);
}
