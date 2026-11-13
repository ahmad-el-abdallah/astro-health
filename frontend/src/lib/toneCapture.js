// "Wanna talk?" voice tone capture: records from Astra's SHARED microphone (stationAudio.js's
// micMeter -- this never calls getUserMedia itself) for as long as the "Wanna talk?" call is
// open, keeps only the last BUFFER_MS in memory, and for each phrase Astra accepts from you
// cuts out YOUR speech with lib/toneClip.js's segmentation (by the audio itself, with Astra's
// own sound excluded), turns it into a 16 kHz WAV and sends it to this laptop's backend
// (POST /api/astronauts/<id>/voice-tone), where the local Wav2Vec2 model estimates the tone
// and the audio is thrown away. Nothing here goes to any outside service, and nothing is
// kept: the buffer lives in memory only and is cleared when the call ends.
//
// Only the voice screen in "Wanna talk?" mode uses this (VoiceMode's toneCapture prop):
// normal Astra calls and the wake-word listener never record.
import { astraAudible, audioCtx, input } from "./stationAudio.js";
import { buildClip, encodeWav, normalizeGain, TARGET_RATE } from "./toneClip.js";

// The worklet is a plain static file (frontend/public/worklets/), never inlined by the build.
export const WORKLET_URL = "/worklets/pcm-capture.js";
export const BUFFER_MS = 20000;

let node = null;
let nodeCtx = null;
let connectedSource = null;
let loading = null;
let blocks = [];
let recording = false;
let generation = 0; // stop() during start()'s first await wins
let usedUntil = -Infinity; // speech up to here was already sent for an earlier phrase
let lastStart = "not started"; // why the last start() did or didn't record (diagnostics)

async function ensureNode() {
  const c = audioCtx();
  if (!c) { lastStart = "no AudioContext"; return null; }
  if (!c.audioWorklet) { lastStart = "no AudioWorklet in this browser"; return null; }
  if (!input.source) { lastStart = "shared microphone not open"; return null; }
  if (c.state !== "running") { lastStart = `sound ${c.state}`; return null; }
  if (nodeCtx !== c) {
    if (!loading) loading = c.audioWorklet.addModule(WORKLET_URL).then(() => {
      node = new AudioWorkletNode(c, "pcm-capture", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit" });
      const silent = c.createGain();
      silent.gain.value = 0; // the node must be pulled by the graph to run; it outputs nothing audible
      node.connect(silent).connect(c.destination);
      node.port.onmessage = (e) => {
        if (!recording) return;
        // tagged with whether Astra's sound was actually coming out of the speakers
        blocks.push({ samples: e.data, at: performance.now(), astra: astraAudible() });
        const keepFrom = performance.now() - BUFFER_MS;
        while (blocks.length && blocks[0].at < keepFrom) blocks.shift();
      };
      nodeCtx = c;
    }).finally(() => { loading = null; });
    await loading;
  }
  // The shared microphone may have been closed and reopened since (a new source node).
  if (connectedSource !== input.source) {
    try { connectedSource?.disconnect(node); } catch { /* the old one is gone */ }
    input.source.connect(node);
    connectedSource = input.source;
  }
  return node;
}

export const toneCapture = {
  /** Start recording (the "Wanna talk?" call opened, the shared mic is on). */
  async start() {
    const gen = ++generation;
    try {
      const n = await ensureNode();
      if (gen !== generation) { lastStart = "stopped while starting"; return false; }
      if (!n) return false;
      if (!recording) { blocks = []; usedUntil = -Infinity; }
      recording = true;
      lastStart = "recording";
      n.port.postMessage("on");
      return true;
    } catch (err) {
      lastStart = `worklet failed: ${err?.name || "error"}`;
      console.warn("[astra] voice tone capture unavailable:", err?.message || err);
      return false;
    }
  },

  /** Stop recording and forget everything recorded (the call ended). */
  stop() {
    generation += 1;
    recording = false;
    blocks = [];
    usedUntil = -Infinity;
    node?.port.postMessage("off");
  },

  get recording() { return recording; },
  /** Why the last start() did or didn't start recording (for the diagnostics line). */
  get lastStart() { return lastStart; },

  /**
   * The audio around one accepted phrase: { blocks, rate, from, to, after } (a snapshot --
   * the live buffer keeps going), or null when not recording. from/to: the phrase's
   * listening window (performance.now() clock).
   */
  phrase(from, to = performance.now()) {
    if (!recording) return null;
    return { blocks: blocks.slice(), rate: nodeCtx?.sampleRate || 48000, from, to, after: usedUntil };
  },

  /** That phrase's speech was sent: don't use it again for the next one. */
  markUsed(until) { usedUntil = Math.max(usedUntil, until); },
};

/** A phrase snapshot -> { wav, seconds, gainDb, usedUntil, ...diag } or { skip: reason, ...diag }.
 *  diag (numbers only, never audio): blocks, rate, receivedMs, astraMs, floor, peak, onset,
 *  snrDb, voicedMs, segments, clipMs. */
export async function phraseToWav(rec) {
  if (!rec || !rec.blocks.length) return { skip: "nothing recorded", blocks: 0 };
  const clip = buildClip(rec.blocks, rec.rate, { from: rec.from, to: rec.to, after: rec.after });
  if (clip.skip) return clip;
  const at16k = await resample(clip.samples, rec.rate);
  const { samples, gainDb } = normalizeGain(at16k);
  const diag = { ...clip };
  delete diag.samples;
  return { ...diag, wav: encodeWav(samples), seconds: samples.length / TARGET_RATE, gainDb };
}

/** One diagnostics line for a phrase: numbers and reasons only -- no audio, no words. */
export function describeClip(n, c, http = "") {
  const f = (x) => (typeof x === "number" ? x.toFixed(4) : "-");
  const s = (ms) => (typeof ms === "number" ? (ms / 1000).toFixed(1) : "-");
  const lv = c.floor !== undefined
    ? `background ${f(c.floor)} peak ${f(c.peak)} (${typeof c.snrDb === "number" ? c.snrDb.toFixed(0) : "-"} dB) onset ${f(c.onset)}`
    : "levels -";
  const head = c.skip ? `NO CLIP (${c.skip})` : `clip ${c.seconds.toFixed(1)} s, ${c.wav.length} bytes WAV, gain ${c.gainDb >= 0 ? "+" : ""}${c.gainDb.toFixed(0)} dB`;
  return `[astra] voice tone phrase ${n}: ${head}`
    + ` | window ${s(c.receivedMs)} s @ ${c.rate ?? "-"} Hz (${c.blocks ?? 0} blocks in buffer), Astra audible ${s(c.astraMs)} s`
    + ` | ${lv} | speech ${s(c.voicedMs)} s in ${c.segments ?? 0} run(s)${http ? ` | ${http}` : ""}`;
}

// The browser's own resampler (proper anti-aliasing), in an offline context.
async function resample(samples, rate) {
  if (rate === TARGET_RATE) return samples;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const length = Math.ceil((samples.length * TARGET_RATE) / rate);
  const off = new OAC(1, length, TARGET_RATE);
  const buf = off.createBuffer(1, samples.length, rate);
  buf.copyToChannel(samples, 0);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  const out = await off.startRendering();
  return out.getChannelData(0);
}

/** Send one clip to this laptop's backend. Resolves to the estimate, or { unavailable }. */
export async function sendClip(astroId, talkId, wav) {
  const res = await fetch(`/api/astronauts/${astroId}/voice-tone?talk=${encodeURIComponent(talkId)}`, {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "audio/wav" }, body: wav,
  });
  if (res.status === 503) return { unavailable: true };
  if (!res.ok) throw new Error(`voice tone ${res.status}`);
  return res.json();
}
