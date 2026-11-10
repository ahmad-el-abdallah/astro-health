// Face to Face mode's talking-head avatar -- the realistic-face follow-up
// to static/js/3d/face_avatar.js's procedural primitive head. Uses a real
// Ready Player Me-style 3D avatar (static/avatars/brunette.glb, CC BY-NC
// 4.0 -- fine for this non-commercial NASA hackathon demo; see
// docs/CLAUDE.md) rendered and lip-synced by the open-source TalkingHead.js
// library (MIT licensed).
//
// This is an ES module (needs the import map in templates/index.html) and
// is loaded as a SEPARATE, newer three.js build (three.module.js, r186)
// from the Body tab's own digital-twin viewer, which still uses the older
// vendored three.min.js UMD build via a classic <script> -- the two never
// interact and stay version-isolated on purpose, so upgrading this one
// avatar can't risk breaking the already-working digital twin.
//
// Exposes window.FaceAvatarRPM = {init, speak, stopSpeaking} so the classic
// script static/js/tabs/body.js can call into it without itself becoming a
// module -- module scripts execute after classic scripts during page load,
// but this bridge is only ever called from a click handler (well after
// load), so that ordering never matters in practice.
//
// edge-tts (backend/services/voice.py) gives no word/viseme timing (checked
// directly, see docs/CLAUDE.md), so word start times/durations are
// estimated here by splitting the known reply text proportionally across
// the real decoded audio's duration, weighted by word length -- a rough
// but reasonable approximation. TalkingHead's own English language module
// then converts those estimated words into actual visemes/mouth shapes,
// which is real (if estimated-timing) lip-sync, not just amplitude.
import { TalkingHead } from '../../vendor/talkinghead.mjs';

let head = null;
let readyPromise = null;
let audioCtx = null;

// Must be called synchronously from inside a real click handler, before any
// `await` -- that's what lets the browser treat the resulting AudioContext
// as user-gesture-unlocked. TalkingHead creates its own internal context
// otherwise (talkinghead.mjs's initAudioGraph()), and by the time that runs
// here (after init()'s module-polling await, then showAvatar()'s asset
// load) we're several async ticks removed from the click -- some browsers
// then leave it permanently "suspended," so audio never plays even though
// everything else (text reply, caption) works fine with no error anywhere.
// Passing this pre-unlocked context in via TalkingHead's own `audioCtx`
// constructor option (confirmed at talkinghead.mjs:921) avoids that.
function unlockAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function estimateWordTimes(text, totalMs) {
  const words = (text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length || !(totalMs > 0)) return { words: [], wtimes: [], wdurations: [] };
  const weights = words.map((w) => Math.max(1, w.length));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let t = 0;
  const wtimes = [];
  const wdurations = [];
  for (let i = 0; i < words.length; i++) {
    const dur = (weights[i] / totalWeight) * totalMs;
    wtimes.push(t);
    wdurations.push(dur);
    t += dur;
  }
  return { words, wtimes, wdurations };
}

function init(container, sharedAudioCtx) {
  if (readyPromise) return readyPromise;
  // Store it on the module-level audioCtx (not just a local), so speak()'s
  // own unlockAudio() call later reuses this exact context instead of
  // finding audioCtx still null and creating a second, un-unlocked one.
  if (sharedAudioCtx) audioCtx = sharedAudioCtx;
  const ctx = unlockAudio();
  readyPromise = (async () => {
    head = new TalkingHead(container, { lipsyncModules: ['en'], cameraView: 'head', audioCtx: ctx });
    await head.showAvatar({ url: '/static/avatars/brunette.glb', body: 'F', lipsyncLang: 'en' });
  })();
  return readyPromise;
}

async function speak(audioBlob, text) {
  if (!readyPromise) throw new Error('FaceAvatarRPM.init() was not called');
  await readyPromise;
  const ctx = unlockAudio(); // defensive re-resume; no-op if already running
  const arrBuf = await audioBlob.arrayBuffer();
  const audioBuffer = await ctx.decodeAudioData(arrBuf);
  const { words, wtimes, wdurations } = estimateWordTimes(text, audioBuffer.duration * 1000);
  head.speakAudio({ audio: audioBuffer, words, wtimes, wdurations });
}

function stopSpeaking() {
  if (head) head.stopSpeaking();
}

window.FaceAvatarRPM = { init, speak, stopSpeaking, unlockAudio };
