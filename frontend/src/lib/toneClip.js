// Finding the astronaut's own speech in the "Wanna talk?" recording, for the voice tone
// estimate (backend/services/emotion.py). Pure functions, tested in toneClip.test.js; the
// browser side (microphone, resampling, upload) is lib/toneCapture.js.
//
// Speech-based segmentation (a small VAD), NOT the speech recognizer's timing: the recognizer
// says WHAT was said and roughly when a phrase ended, never when the speech itself started or
// stopped. So the recording around an accepted phrase is cut by the AUDIO:
//   * Astra's frames are excluded: blocks recorded while her sound was actually playing
//     (stationAudio.astraAudible(): the neural voice's real output level incl. its echo tail,
//     the beeps' real timing, speechSynthesis.speaking), plus a short ASTRA_GUARD_MS after.
//     Frames where you talk over her are mixed and can't be separated, so they're dropped too.
//   * The background level is MEASURED from the rest of the recording (10th percentile of
//     the non-Astra frames, never below ABS_FLOOR): every mic and room has its own. Real
//     measurement that drove this (2026-11-13, the user's laptop mic, noise suppression on, no
//     auto-gain): speech peaked at 0.0021 RMS (-54 dBFS) -- below the old fixed 0.008 cutoff.
//   * Speech starts when 3 frames in a row are ONSET_DB above that background, continues while
//     frames stay OFFSET_DB above it, and ends after HANGOVER_MS below (hysteresis).
//   * A run must contain MIN_VOICED_MS of speech and rise and fall (MIN_MODULATION, p90/p10
//     inside the run): steady noise (a fan, a hum) doesn't, speech does.
//   * The runs are joined (silence between them dropped beyond a short pad) into the clip.
// Then lib/toneCapture.js resamples it to 16 kHz and normalizeGain() raises a quiet voice to a
// normal level before it becomes 16-bit WAV (at -54 dBFS it would keep only ~6 bits). The
// model normalises every input to zero mean / unit variance itself, so gain doesn't change
// what it hears -- only how much detail survives the 16-bit step.

export const TARGET_RATE = 16000;
export const MIN_CLIP_S = 1.0; // the backend's minimum
export const MAX_CLIP_S = 15.0; // ... and maximum
export const FRAME_MS = 20;
export const ASTRA_GUARD_MS = 200; // output latency + the last bit of her echo after her sound stops
export const PREROLL_MS = 1000; // audio kept from before the listening window (your first words)
export const ABS_FLOOR = 0.0002; // -74 dBFS: never assume a quieter background than this
export const ONSET_DB = 10;
export const OFFSET_DB = 6;
export const MIN_ONSET_FRAMES = 3; // 60 ms above the onset level starts a run
export const HANGOVER_MS = 400; // a run ends after this long below the offset level
export const MIN_VOICED_MS = 300;
export const MIN_MODULATION = 2.5;
export const PAD_MS = 100;
export const TARGET_RMS = 0.1;
export const MAX_GAIN = 1000; // +60 dB at most
const db = (x) => 10 ** (x / 20);

const pctl = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);

/**
 * The recorded blocks joined, with per-frame levels, an Astra mask (1 = her sound, 2 = the
 * guard after it) and each frame's start time. blocks: [{ samples: Float32Array, at: ms it
 * arrived = its end (performance.now() clock), astra: was her sound playing then }].
 */
export function framesFromBlocks(blocks, rate) {
  const n = blocks.reduce((a, b) => a + b.samples.length, 0);
  const samples = new Float32Array(n);
  const sampleAstra = new Uint8Array(n);
  const blockAt = []; // [first sample, its time]
  let o = 0;
  for (const b of blocks) {
    samples.set(b.samples, o);
    if (b.astra) sampleAstra.fill(1, o, o + b.samples.length);
    blockAt.push([o, b.at - (b.samples.length / rate) * 1000]);
    o += b.samples.length;
  }
  const size = Math.max(1, Math.round((rate * FRAME_MS) / 1000));
  const count = Math.floor(n / size);
  const levels = new Float64Array(count);
  const astra = new Uint8Array(count);
  const times = new Float64Array(count);
  let bi = 0;
  for (let f = 0; f < count; f++) {
    const first = f * size;
    while (bi + 1 < blockAt.length && blockAt[bi + 1][0] <= first) bi++;
    times[f] = blockAt[bi][1] + ((first - blockAt[bi][0]) / rate) * 1000;
    let sum = 0;
    let her = 0;
    for (let j = f * size; j < (f + 1) * size; j++) { sum += samples[j] * samples[j]; her |= sampleAstra[j]; }
    levels[f] = Math.sqrt(sum / size);
    astra[f] = her;
  }
  // guard after each stretch of her sound
  const guard = Math.round(ASTRA_GUARD_MS / FRAME_MS);
  let last = -Infinity;
  for (let f = 0; f < count; f++) {
    if (astra[f] === 1) last = f;
    else if (f - last <= guard) astra[f] = 2; // 2 = guard (not her, but too close to trust)
  }
  return { samples, levels, astra, times, frameSize: size, rate };
}

/** Frame (20 ms) RMS levels of a plain sample array. */
export function frameLevelsOf(samples, rate) {
  const size = Math.max(1, Math.round((rate * FRAME_MS) / 1000));
  const out = [];
  for (let i = 0; i + size <= samples.length; i += size) {
    let sum = 0;
    for (let j = i; j < i + size; j++) sum += samples[j] * samples[j];
    out.push(Math.sqrt(sum / size));
  }
  return out;
}

/** The speech runs (frame indices, end exclusive) and the measured levels behind them. */
export function segmentSpeech(levels, astra) {
  const usable = [];
  for (let f = 0; f < levels.length; f++) if (!astra[f]) usable.push(levels[f]);
  usable.sort((a, b) => a - b);
  const floor = Math.max(pctl(usable, 0.1), ABS_FLOOR);
  const peak = pctl(usable, 0.95);
  const on = floor * db(ONSET_DB);
  const off = floor * db(OFFSET_DB);
  const hang = Math.round(HANGOVER_MS / FRAME_MS);
  const runs = [];
  let start = -1;
  let lastLoud = -1;
  let loudInRow = 0;
  const close = (end) => { runs.push({ start, end }); start = -1; loudInRow = 0; };
  for (let f = 0; f < levels.length; f++) {
    const her = astra[f] !== 0;
    if (start < 0) {
      loudInRow = !her && levels[f] > on ? loudInRow + 1 : 0;
      if (loudInRow >= MIN_ONSET_FRAMES) { start = f - MIN_ONSET_FRAMES + 1; lastLoud = f; }
      continue;
    }
    if (her) { close(f); continue; } // she started (or you were talking over her): cut here
    if (levels[f] > off) lastLoud = f;
    else if (f - lastLoud > hang) close(lastLoud + 1);
  }
  if (start >= 0) close(Math.min(levels.length, lastLoud + 1));
  const kept = [];
  let steady = 0;
  let short = 0;
  for (const r of runs) {
    const inRun = Array.from(levels.subarray(r.start, r.end)).sort((a, b) => a - b);
    const voiced = inRun.filter((l) => l > off).length * FRAME_MS;
    const modulation = pctl(inRun, 0.9) / Math.max(pctl(inRun, 0.1), 1e-9);
    if (voiced < MIN_VOICED_MS) { short++; continue; }
    if (modulation < MIN_MODULATION) { steady++; continue; }
    kept.push({ ...r, voicedMs: voiced });
  }
  return {
    segments: kept, floor, peak, on, off,
    snrDb: peak > 0 ? 20 * Math.log10(peak / floor) : 0,
    voicedMs: kept.reduce((a, r) => a + r.voicedMs, 0),
    rejected: { short, steady },
  };
}

/**
 * The astronaut's speech for one accepted phrase, at the recording's own rate.
 * blocks: the whole recent recording (the background level is measured over all of it);
 * window { from, to }: the phrase's listening window, ms (performance.now() clock) -- only
 * speech runs overlapping it, from PREROLL_MS before, are used. after: runs that started
 * before this time were already used for the previous phrase (never analysed twice).
 * The result's usedUntil is when the last run used here ended.
 * Returns { samples, ...diag } or { skip: reason, ...diag }. diag is numbers only.
 */
export function buildClip(blocks, rate, { from = -Infinity, to = Infinity, after = -Infinity } = {}) {
  if (!blocks?.length) return { skip: "nothing recorded", blocks: 0 };
  const fr = framesFromBlocks(blocks, rate);
  const total = fr.levels.length;
  const lo = from - PREROLL_MS;
  const inWindow = (f) => fr.times[f] + FRAME_MS > lo && fr.times[f] < to;
  let windowFrames = 0;
  let herFrames = 0;
  let free = 0;
  for (let f = 0; f < total; f++) {
    if (!inWindow(f)) continue;
    windowFrames++;
    if (fr.astra[f] === 1) herFrames++;
    if (!fr.astra[f]) free++;
  }
  const diag = { blocks: blocks.length, rate, receivedMs: windowFrames * FRAME_MS, astraMs: herFrames * FRAME_MS };
  if (!windowFrames) return { skip: "nothing recorded", ...diag };
  if (!free) return { skip: "only Astra's voice", ...diag };
  const all = segmentSpeech(fr.levels, fr.astra);
  const segments = all.segments.filter((r) => (inWindow(r.start) || inWindow(r.end - 1)) && fr.times[r.start] >= after);
  const voicedMs = segments.reduce((a, r) => a + r.voicedMs, 0);
  Object.assign(diag, { floor: all.floor, peak: all.peak, onset: all.on, snrDb: all.snrDb, voicedMs, segments: segments.length });
  if (!segments.length) {
    const why = all.rejected.steady ? "steady noise, not speech" : all.rejected.short ? "too little speech" : "no speech above the background";
    return { skip: why, ...diag };
  }
  const seg = { segments };
  // join the runs, each padded a little (never into Astra's frames)
  const pad = Math.round(PAD_MS / FRAME_MS);
  const parts = [];
  for (const r of seg.segments) {
    let a = r.start;
    let b = r.end;
    for (let k = 0; k < pad && a > 0 && !fr.astra[a - 1]; k++) a--;
    for (let k = 0; k < pad && b < total && !fr.astra[b]; k++) b++;
    parts.push([a * fr.frameSize, b * fr.frameSize]);
  }
  const len = parts.reduce((s, [a, b]) => s + (b - a), 0);
  const max = Math.round(rate * MAX_CLIP_S);
  const min = Math.round(rate * MIN_CLIP_S);
  let out = new Float32Array(Math.min(len, max));
  let o = 0;
  for (const [a, b] of parts) {
    const take = Math.min(b - a, out.length - o);
    if (take <= 0) break;
    out.set(fr.samples.subarray(a, a + take), o);
    o += take;
  }
  if (out.length < min) { // the backend needs 1 s: pad with quiet (the model normalises anyway)
    const padded = new Float32Array(min);
    padded.set(out, Math.floor((min - out.length) / 2));
    out = padded;
  }
  const lastEnd = segments.at(-1).end;
  const usedUntil = (lastEnd < total ? fr.times[lastEnd] : fr.times[total - 1] + FRAME_MS);
  return { samples: out, ...diag, clipMs: Math.round((out.length / rate) * 1000), usedUntil };
}

/** Raise (or lower) a clip to a normal speaking level before 16-bit WAV. -> { samples, gainDb } */
export function normalizeGain(samples) {
  let sum = 0;
  let peak = 0;
  for (const x of samples) { sum += x * x; peak = Math.max(peak, Math.abs(x)); }
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  if (!rms || !peak) return { samples, gainDb: 0 };
  const gain = Math.min(MAX_GAIN, TARGET_RMS / rms, 0.98 / peak);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
  return { samples: out, gainDb: 20 * Math.log10(gain) };
}

/** Float samples -> 16-bit PCM mono WAV bytes. */
export function encodeWav(samples, rate = TARGET_RATE) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const text = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  text(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

// ---- showing the results (Mind page) ----

export const TONE_LABELS = {
  angry: "Angry", calm: "Calm", disgust: "Disgust", fearful: "Fearful", happy: "Happy", sad: "Sad", surprised: "Surprised",
};
export const TONE_ORDER = ["calm", "happy", "surprised", "sad", "fearful", "angry", "disgust"];
export const TONE_DISCLAIMER =
  "An automatic guess from how your voice sounds, made on this laptop. It doesn’t diagnose stress, fatigue or any condition.";
export const TONE_PRIVACY =
  "Tone is analysed on this laptop and the recording is thrown away; only the estimate is saved. The words you say still go through your browser’s speech recognition (Chrome sends them to Google, Edge to Microsoft).";

/** rows (oldest first) -> the latest talk: { talkId, ts, phrases, top, topCount } or null. */
export function latestTalk(rows = []) {
  if (!rows.length) return null;
  const talkId = rows.at(-1).talk_id;
  const phrases = rows.filter((r) => r.talk_id === talkId);
  const counts = countTones(phrases);
  const top = TONE_ORDER.reduce((best, t) => ((counts[t] || 0) > (counts[best] || 0) ? t : best), TONE_ORDER[0]);
  return { talkId, ts: phrases[0].ts, phrases, top, topCount: counts[top] || 0 };
}

/** The seven probabilities averaged over a talk's phrases: [{ tone, p }] in TONE_ORDER.
 *  Rows without scores are skipped; no rows -> every p is 0. */
export function talkMix(phrases = []) {
  const withScores = phrases.filter((r) => r.scores && typeof r.scores === "object");
  return TONE_ORDER.map((tone) => ({
    tone,
    p: withScores.length ? withScores.reduce((a, r) => a + (Number(r.scores[tone]) || 0), 0) / withScores.length : 0,
  }));
}

/** 0.4567 -> "46%", tiny values -> "<1%". */
export const pct = (p) => (p > 0 && p < 0.005 ? "<1%" : `${Math.round(p * 100)}%`);

export function countTones(rows = []) {
  const out = {};
  for (const r of rows) out[r.label] = (out[r.label] || 0) + 1;
  return out;
}
