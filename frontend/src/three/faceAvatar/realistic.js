// Face to Face's realistic talking head: a Ready Player Me-style avatar
// (public/avatars/brunette.glb, CC BY-NC 4.0 -- fine for this non-commercial demo)
// lip-synced by TalkingHead.js (MIT, src/vendor/talkinghead/). Port of
// static/js/3d/face_avatar_rpm.js.
//
// Now bundled by Vite against the app's own three.js, so there's no second copy of
// three.js and no import map. TalkingHead normally loads its English lip-sync module
// with a runtime import() that a bundler can't follow (a silent 404 crashed speakAudio()
// once before -- docs/CLAUDE.md), so we pass `lipsyncModules: []` and plug the
// statically imported LipsyncEn in ourselves.
//
// edge-tts gives no word timings, so they're estimated by splitting the reply text
// across the audio's real duration, weighted by word length; TalkingHead turns those
// into mouth shapes.
import { TalkingHead } from "../../vendor/talkinghead/talkinghead.mjs";
import { LipsyncEn } from "../../vendor/talkinghead/lipsync-en.mjs";

function estimateWordTimes(text, totalMs) {
  const words = (text || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length || !(totalMs > 0)) return { words: [], wtimes: [], wdurations: [] };
  const weights = words.map((w) => Math.max(1, w.length));
  const total = weights.reduce((a, b) => a + b, 0);
  let t = 0;
  const wtimes = [];
  const wdurations = [];
  weights.forEach((w) => {
    const dur = (w / total) * totalMs;
    wtimes.push(t);
    wdurations.push(dur);
    t += dur;
  });
  return { words, wtimes, wdurations };
}

export async function createRealisticAvatar(container, audioCtx) {
  const head = new TalkingHead(container, {
    lipsyncModules: [],
    cameraView: "head",
    audioCtx,
    // The avatar isn't Draco-compressed, so this is never fetched -- but never point it
    // at the library's default Google CDN either (the app must work offline).
    dracoDecoderPath: "/vendor/draco/",
  });
  head.lipsync.en = new LipsyncEn();
  await head.showAvatar({ url: "/avatars/brunette.glb", body: "F", lipsyncLang: "en" });
  return {
    kind: "realistic",
    async speak(blob, text) {
      if (audioCtx.state === "suspended") await audioCtx.resume();
      const buffer = await audioCtx.decodeAudioData(await blob.arrayBuffer());
      const { words, wtimes, wdurations } = estimateWordTimes(text, buffer.duration * 1000);
      head.speakAudio({ audio: buffer, words, wtimes, wdurations });
    },
    stop() { head.stopSpeaking(); },
    dispose() {
      try { head.stop(); } catch { /* already stopped */ }
      container.innerHTML = "";
    },
  };
}
