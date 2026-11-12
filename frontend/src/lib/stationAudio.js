// The station's sound (Web Audio, no libraries, no audio files):
//  * quindar()   the Apollo-era "Quindar" tones NASA played at the start (2525 Hz) and end
//                (2475 Hz) of every capcom transmission -- 250 ms each, kept quiet.
//  * ambience()  a soft cabin hum (filtered brown noise + a low 60 Hz tone) under voice mode.
//  * playNeural() plays the Microsoft neural voice's MP3 through a light radio band-pass, a
//                metal-cabin reverb (impulse response generated in code) and a soft feedback
//                echo. This only works for audio the page receives -- the browser's own
//                speechSynthesis voice can't be processed (the page never gets its sound).
//  * micMeter    reads the microphone level for the voice-mode orb while listening.
// One shared AudioContext, created/resumed inside a click (browsers block sound otherwise).

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
  return new Promise((resolve) => setTimeout(resolve, 320));
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
export const output = { analyser: null };
let current = null; // { src, resolve }
let impulse = null;

function makeImpulse(c) {
  // ~1.4 s of decaying noise (the reverb tail) plus a few strong early reflections:
  // the "hard metal walls of a small module" sound.
  const seconds = 1.4, rate = c.sampleRate, len = Math.floor(rate * seconds);
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
  try { src.onended = null; src.stop(); } catch { /* not started yet */ }
  resolve();
}

/** Plays MP3/encoded audio; resolves when it has finished (or was stopped). */
export async function playNeural(arrayBuffer, { fx = true } = {}) {
  const c = audioCtx();
  if (!c) throw new Error("Web Audio unavailable");
  const audio = await c.decodeAudioData(arrayBuffer.slice(0));
  stopNeural();
  const src = c.createBufferSource();
  src.buffer = audio;
  const comp = c.createDynamicsCompressor();
  const analyser = c.createAnalyser();
  analyser.fftSize = 1024;
  if (fx) {
    const hp = c.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 160;
    const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 6800;
    const dry = c.createGain(); dry.gain.value = 0.9;
    impulse = impulse || makeImpulse(c);
    const verb = c.createConvolver(); verb.buffer = impulse;
    const wet = c.createGain(); wet.gain.value = 0.3;
    const delay = c.createDelay(1); delay.delayTime.value = 0.17;
    const tone = c.createBiquadFilter(); tone.type = "lowpass"; tone.frequency.value = 3200;
    const feedback = c.createGain(); feedback.gain.value = 0.26;
    const echo = c.createGain(); echo.gain.value = 0.2;
    src.connect(hp).connect(lp);
    lp.connect(dry).connect(comp);
    lp.connect(verb).connect(wet).connect(comp);
    lp.connect(delay);
    delay.connect(tone);
    tone.connect(feedback).connect(delay); // each repeat a little darker and quieter
    tone.connect(echo).connect(comp);
  } else {
    src.connect(comp);
  }
  comp.connect(analyser);
  analyser.connect(c.destination);
  output.analyser = analyser;
  return new Promise((resolve) => {
    current = { src, resolve };
    src.onended = () => {
      if (current?.src !== src) return;
      current = null;
      setTimeout(() => { if (output.analyser === analyser) output.analyser = null; resolve(); }, fx ? 450 : 0); // let the echo ring out
    };
    src.start();
  });
}

// ---- microphone level (voice-mode orb while listening) ----
export const input = { analyser: null };
let micStream = null;

export const micMeter = {
  async start() {
    const c = audioCtx();
    if (!c || micStream || !navigator.mediaDevices?.getUserMedia) return false;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      return false; // no meter, the orb just breathes; recognition reports its own errors
    }
    const analyser = c.createAnalyser();
    analyser.fftSize = 1024;
    c.createMediaStreamSource(micStream).connect(analyser); // measured only, never played back
    input.analyser = analyser;
    return true;
  },
  stop() {
    micStream?.getTracks().forEach((t) => t.stop());
    micStream = null;
    input.analyser = null;
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
