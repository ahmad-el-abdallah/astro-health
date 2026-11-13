// lib/toneClip.js's speech-based segmentation, on signals built to the levels actually measured
// on the user's laptop mic (2026-11-13, noise suppression on, no auto-gain): speech peaking at
// about 0.0021 frame RMS (-54 dBFS) over a quiet background. Plus the real speech fixture
// (tests/fixtures/voice_phrase.wav) brought down to that same level.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ABS_FLOOR, ASTRA_GUARD_MS, buildClip, frameLevelsOf, MAX_GAIN, normalizeGain, PREROLL_MS } from "./toneClip.js";

const RATE = 16000;
const T0 = 10000; // ms: when the recording starts (performance.now() clock)

// deterministic noise
function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) / 4294967296) * 2 - 1; };
}
/** White-ish noise at this frame RMS. */
function noise(seconds, rms, seed = 7) {
  const r = rng(seed);
  return Float32Array.from({ length: Math.round(seconds * RATE) }, () => r() * rms * Math.sqrt(3));
}
/** Speech-like: a voiced buzz (150 Hz + harmonics) in ~4 syllables/s with short pauses between
 *  words. `rms` is roughly the loudest frames' RMS. */
function speech(seconds, rms, seed = 3) {
  const r = rng(seed);
  const n = Math.round(seconds * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const syll = Math.max(0, Math.sin(2 * Math.PI * 4 * t)) ** 1.5; // syllables rise and fall
    const word = Math.floor(t / 0.75) % 3 === 2 && t % 0.75 > 0.55 ? 0 : 1; // a short pause every few words
    const buzz = Math.sin(2 * Math.PI * 150 * t) + 0.5 * Math.sin(2 * Math.PI * 300 * t) + 0.25 * Math.sin(2 * Math.PI * 450 * t) + 0.15 * r();
    out[i] = 1.25 * rms * syll * word * buzz;
  }
  return out;
}
const silence = (s) => new Float32Array(Math.round(s * RATE));
function concat(...parts) {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
/** a + b, b placed at `at` seconds. */
function mixAt(a, b, at) {
  const out = Float32Array.from(a);
  const o = Math.round(at * RATE);
  for (let i = 0; i < b.length && o + i < out.length; i++) out[o + i] += b[i];
  return out;
}
/** 50 ms blocks as the worklet delivers them; astra = her sound was playing when it arrived. */
function toBlocks(samples, astraRanges = []) {
  const size = RATE / 20;
  const out = [];
  for (let i = 0; i < samples.length; i += size) {
    const end = Math.min(samples.length, i + size) / RATE;
    out.push({ samples: samples.subarray(i, i + size), at: T0 + end * 1000, astra: astraRanges.some(([a, b]) => end > a && end <= b + 0.05) });
  }
  return out;
}
const win = (from, to) => ({ from: T0 + from * 1000, to: T0 + to * 1000 });
const peakFrame = (samples) => Math.max(...frameLevelsOf(samples, RATE));

const USER_RMS = 0.0021; // measured peak of the user's speech
const ROOM_RMS = 0.0002; // a quiet room through noise suppression

describe("segmentation: user speaking while Astra is silent", () => {
  it("finds the speech at the user's real mic level and keeps just that", () => {
    const rec = concat(noise(1.5, ROOM_RMS), mixAt(noise(2.5, ROOM_RMS, 9), speech(2.5, USER_RMS), 0), noise(1.5, ROOM_RMS, 11));
    const clip = buildClip(toBlocks(rec), RATE, win(1.4, 5.5));
    expect(clip.skip).toBeUndefined();
    expect(clip.peak).toBeLessThan(0.008); // the old fixed cutoff would have found nothing
    expect(clip.snrDb).toBeGreaterThan(15);
    expect(clip.voicedMs).toBeGreaterThan(800); // this synthetic speech is ~40% voiced (syllable valleys)
    expect(clip.clipMs).toBeGreaterThan(2000);
    expect(clip.clipMs).toBeLessThan(3000); // the 1.5 s of room on each side is left out
  });

  it("keeps words said before the listening window opened (pre-roll)", () => {
    const rec = concat(noise(1, ROOM_RMS), mixAt(noise(3, ROOM_RMS, 5), speech(3, USER_RMS), 0), noise(1, ROOM_RMS, 6));
    // the recognizer only started listening 0.6 s into the speech
    const clip = buildClip(toBlocks(rec), RATE, win(1.6, 4.5));
    expect(PREROLL_MS).toBeGreaterThanOrEqual(600);
    expect(clip.clipMs).toBeGreaterThan(2700);
  });
});

describe("segmentation: user speaking right after Astra finishes", () => {
  it("keeps the reply that starts 150 ms after her sound stops, and none of her", () => {
    const astra = speech(3, 0.01, 21); // louder: her voice through the speakers
    const rec = concat(noise(0.5, ROOM_RMS), mixAt(noise(3, ROOM_RMS, 2), astra, 0), noise(0.15, ROOM_RMS, 3), mixAt(noise(2, ROOM_RMS, 4), speech(2, USER_RMS), 0), noise(1, ROOM_RMS, 8));
    const blocks = toBlocks(rec, [[0.5, 3.5]]);
    const clip = buildClip(blocks, RATE, win(0.8, 6.6)); // listening began while she was talking
    expect(clip.skip).toBeUndefined();
    expect(clip.astraMs).toBeGreaterThan(2500);
    // most of the 2 s reply survives (only her ASTRA_GUARD_MS after she stops is skipped)
    expect(ASTRA_GUARD_MS).toBeLessThanOrEqual(200);
    expect(clip.clipMs).toBeGreaterThan(1700);
    expect(peakFrame(clip.samples)).toBeLessThan(0.004); // nothing at her level got in
  });
});

describe("segmentation: Astra speaking without the user", () => {
  it("makes no clip from her voice, its echo tail or the room after it", () => {
    const astra = speech(3, 0.01, 21);
    const tail = Float32Array.from(noise(0.6, 0.003, 4), (x, i) => x * Math.exp(-i / RATE / 0.08)); // echo dying away
    const rec = concat(noise(0.5, ROOM_RMS), mixAt(noise(3, ROOM_RMS, 2), astra, 0), mixAt(noise(1.5, ROOM_RMS, 3), tail, 0));
    const clip = buildClip(toBlocks(rec, [[0.5, 3.5]]), RATE, win(0.6, 5));
    expect(clip.skip).toBeDefined();
    expect(clip.samples).toBeUndefined();
  });

  it("says so when the whole window was her", () => {
    const rec = mixAt(noise(3, ROOM_RMS), speech(3, 0.01, 21), 0);
    const clip = buildClip(toBlocks(rec, [[0, 3]]), RATE, win(0.2, 2.9));
    expect(clip.skip).toBe("only Astra's voice");
  });
});

describe("segmentation: background noise and quiet speech", () => {
  it("ignores steady background noise (a fan) with no one speaking", () => {
    const fan = noise(6, 0.001, 12);
    const clip = buildClip(toBlocks(fan), RATE, win(0, 6));
    expect(clip.skip).toBeDefined();
  });

  it("ignores a slow swell of noise (no syllables)", () => {
    const swell = Float32Array.from(noise(6, 0.0015, 13), (x, i) => x * (0.6 + 0.4 * Math.sin((2 * Math.PI * 0.3 * i) / RATE)));
    expect(buildClip(toBlocks(swell), RATE, win(0, 6)).skip).toBeDefined();
  });

  it("finds quiet speech over a louder background (about 12 dB above it)", () => {
    const room = 0.0005;
    const rec = concat(noise(1.5, room), mixAt(noise(2.5, room, 9), speech(2.5, USER_RMS), 0), noise(1.5, room, 10));
    const clip = buildClip(toBlocks(rec), RATE, win(1.4, 5.5));
    expect(clip.skip).toBeUndefined();
    expect(clip.voicedMs).toBeGreaterThan(500);
  });

  it("gives up on speech barely above the background (no fair estimate possible)", () => {
    const room = 0.0015;
    const rec = concat(noise(1.5, room), mixAt(noise(2.5, room, 9), speech(2.5, USER_RMS), 0), noise(1.5, room, 10));
    expect(buildClip(toBlocks(rec), RATE, win(1.4, 5.5)).skip).toBeDefined();
  });

  it("never assumes a background quieter than ABS_FLOOR (digital silence)", () => {
    const rec = concat(silence(1.5), speech(2, USER_RMS), silence(1.5));
    const clip = buildClip(toBlocks(rec), RATE, win(1.4, 3.6));
    expect(clip.floor).toBe(ABS_FLOOR);
    expect(clip.skip).toBeUndefined();
  });
});

describe("segmentation: mixed user and Astra audio", () => {
  it("drops the part where you talk over her, keeps what you say after", () => {
    const astra = speech(3, 0.01, 21);
    // she talks 0.5-3.5 s; you start at 2.5 s (1 s over her) and go on to 5 s
    const base = concat(noise(0.5, ROOM_RMS), mixAt(noise(3, ROOM_RMS, 2), astra, 0), noise(2.5, ROOM_RMS, 3));
    const rec = mixAt(base, speech(2.5, USER_RMS, 5), 2.5);
    const clip = buildClip(toBlocks(rec, [[0.5, 3.5]]), RATE, win(0.6, 5.8));
    expect(clip.skip).toBeUndefined();
    expect(clip.clipMs).toBeGreaterThan(1000);
    expect(clip.clipMs).toBeLessThan(1700); // ~3.7-5 s only: nothing from the overlap
    expect(peakFrame(clip.samples)).toBeLessThan(0.004);
  });

  it("never sends the same speech twice for two phrases in a row", () => {
    const rec = concat(noise(1, ROOM_RMS), speech(2, USER_RMS, 1), noise(1.5, ROOM_RMS, 2), speech(2, USER_RMS, 3), noise(1, ROOM_RMS, 4));
    const blocks = toBlocks(rec);
    const first = buildClip(blocks, RATE, win(0.9, 3.6));
    expect(first.skip).toBeUndefined();
    const second = buildClip(blocks, RATE, { ...win(3.6, 7.5), after: first.usedUntil });
    expect(second.skip).toBeUndefined();
    expect(second.segments).toBe(1);
    const again = buildClip(blocks, RATE, { ...win(0.9, 3.6), after: second.usedUntil });
    expect(again.skip).toBeDefined(); // both phrases' speech already used
  });
});

describe("segmentation: the real speech fixture at the user's level", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const buf = fs.readFileSync(path.join(here, "..", "..", "..", "tests", "fixtures", "voice_phrase.wav"));
  let o = 12;
  let pcm = null;
  while (o + 8 <= buf.length) {
    const id = buf.toString("ascii", o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    if (id === "data") pcm = buf.subarray(o + 8, o + 8 + size);
    o += 8 + size + (size % 2);
  }
  const real = Float32Array.from({ length: pcm.length / 2 }, (_, i) => pcm.readInt16LE(i * 2) / 32768);

  it("finds 4.3 s of real speech brought down to -54 dBFS", () => {
    const scale = USER_RMS / peakFrame(real);
    const quiet = Float32Array.from(real, (x) => x * scale);
    const rec = concat(noise(1, ROOM_RMS), mixAt(noise(real.length / RATE, ROOM_RMS, 3), quiet, 0), noise(1, ROOM_RMS, 4));
    const clip = buildClip(toBlocks(rec), RATE, win(0.9, 1 + real.length / RATE + 0.9));
    expect(clip.skip).toBeUndefined();
    expect(clip.peak).toBeLessThan(0.008);
    expect(clip.voicedMs).toBeGreaterThan(2000);
    expect(clip.clipMs).toBeGreaterThan(3000);
  });
});

describe("normalizeGain", () => {
  it("raises a quiet clip to a normal level without clipping", () => {
    const quiet = speech(2, USER_RMS);
    const { samples, gainDb } = normalizeGain(quiet);
    expect(gainDb).toBeGreaterThan(25);
    expect(gainDb).toBeLessThanOrEqual(20 * Math.log10(MAX_GAIN));
    expect(Math.max(...samples.map(Math.abs))).toBeLessThanOrEqual(0.98 + 1e-6);
    // same waveform, only louder
    const k = samples[1234] / quiet[1234];
    expect(samples[4321]).toBeCloseTo(quiet[4321] * k, 6);
  });

  it("leaves digital silence alone", () => {
    expect(normalizeGain(silence(1)).gainDb).toBe(0);
  });
});

describe("phrases: short, long, natural pauses, consecutive with Astra between", () => {
  it("a very short reply (a quick 'yes') gives no clip rather than a guess from too little speech", () => {
    const rec = concat(noise(1.5, ROOM_RMS), mixAt(noise(0.25, ROOM_RMS, 2), speech(0.25, USER_RMS), 0), noise(1.5, ROOM_RMS, 3));
    expect(buildClip(toBlocks(rec), RATE, win(1.4, 3.2)).skip).toBe("too little speech");
  });

  it("a long phrase with pauses stays ONE clip (capped at the backend's 15 s)", () => {
    const long = concat(speech(4, USER_RMS, 1), silence(0.6), speech(4, USER_RMS, 2), silence(0.9), speech(4, USER_RMS, 3), silence(0.5), speech(5, USER_RMS, 4));
    const rec = concat(noise(1, ROOM_RMS), mixAt(noise(long.length / RATE, ROOM_RMS, 9), long, 0), noise(1, ROOM_RMS, 10));
    const clip = buildClip(toBlocks(rec), RATE, win(0.9, 1 + long.length / RATE + 0.9));
    expect(clip.skip).toBeUndefined();
    expect(clip.segments).toBeGreaterThan(1); // the pauses are in there...
    expect(clip.clipMs).toBe(15000); // ...but it's one clip, at the cap
  });

  it("a natural pause inside a phrase doesn't split it", () => {
    const words = concat(speech(1.5, USER_RMS, 1), noise(0.9, ROOM_RMS, 5), speech(1.5, USER_RMS, 2));
    const rec = concat(noise(1, ROOM_RMS), mixAt(noise(words.length / RATE, ROOM_RMS, 9), words, 0), noise(1, ROOM_RMS, 10));
    const clip = buildClip(toBlocks(rec), RATE, win(0.9, 1 + words.length / RATE + 0.9));
    expect(clip.skip).toBeUndefined();
    expect(clip.clipMs).toBeGreaterThan(2800); // both halves, the long silence between trimmed
    expect(clip.clipMs).toBeLessThan(3800);
  });

  it("you, then Astra answering, then you again: two clips, neither with her voice, none reused", () => {
    const you1 = speech(2, USER_RMS, 1);
    const her = speech(3, 0.012, 21);
    const you2 = speech(2, USER_RMS, 2);
    const rec = concat(noise(1, ROOM_RMS), mixAt(noise(2, ROOM_RMS, 2), you1, 0), noise(0.8, ROOM_RMS, 3),
      mixAt(noise(3, ROOM_RMS, 4), her, 0), noise(0.3, ROOM_RMS, 5), mixAt(noise(2, ROOM_RMS, 6), you2, 0), noise(1, ROOM_RMS, 7));
    const blocks = toBlocks(rec, [[3.8, 6.8]]);
    const first = buildClip(blocks, RATE, win(0.9, 3.8));
    const second = buildClip(blocks, RATE, { ...win(3.9, 10.1), after: first.usedUntil }); // listening began while she spoke
    for (const c of [first, second]) {
      expect(c.skip).toBeUndefined();
      expect(c.clipMs).toBeGreaterThan(1500);
      expect(peakFrame(c.samples)).toBeLessThan(0.004); // her level never in a clip
    }
    expect(second.usedUntil).toBeGreaterThan(first.usedUntil);
  });

  it("Astra's voice is never analysed as yours, even if the recognizer's window is all her", () => {
    const rec = concat(noise(1, ROOM_RMS), mixAt(noise(4, ROOM_RMS, 2), speech(4, 0.012, 21), 0), noise(1, ROOM_RMS, 3));
    const clip = buildClip(toBlocks(rec, [[1, 5]]), RATE, win(1.2, 5));
    expect(clip.samples).toBeUndefined();
  });
});
