// Face ID: a wrapper around the vendored face-api.js (public/vendor/face-api.min.js +
// public/vendor/faceapi-models/). The ~660 KB library and its models are only fetched the
// first time Face ID is used.
//
// The identity DECISION always happens server-side (POST /auth/face_login); this module only
// produces raw 128-number measurements.
//
// v2 (2026-11-14), after "it doesn't take my face / the login doesn't recognise me":
//  * a 640x480 feed (was 320x240) and the SSD MobileNet detector (much better in dim light
//    and at an angle), with the tiny detector as a fallback;
//  * every frame gets a verdict with a REASON (too dark, no face, two faces, too far, not
//    facing the camera, moving), shown live, instead of one silent snapshot;
//  * enrollment keeps several good, varied frames; sign-in sends a few frames and the server
//    votes (backend/routes/routes.py _match_face_frames).
let loading = null;

function loadLibrary() {
  if (window.faceapi?.nets?.ssdMobilenetv1?.isLoaded) return Promise.resolve(window.faceapi);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      if (window.faceapi) { resolve(window.faceapi); return; }
      const s = document.createElement("script");
      s.src = "/vendor/face-api.min.js";
      s.onload = () => resolve(window.faceapi);
      s.onerror = () => { loading = null; reject(new Error("couldn't load face-api.js")); };
      document.head.appendChild(s);
    }).then(async (faceapi) => {
      const base = "/vendor/faceapi-models";
      await Promise.all([
        faceapi.nets.ssdMobilenetv1.loadFromUri(base),
        faceapi.nets.tinyFaceDetector.loadFromUri(base),
        faceapi.nets.faceLandmark68Net.loadFromUri(base),
        faceapi.nets.faceRecognitionNet.loadFromUri(base),
      ]);
      return faceapi;
    }).catch((err) => { loading = null; throw err; });
  }
  return loading;
}
export const preloadFaceModels = () => loadLibrary().catch(() => null);

export async function startCamera(videoEl) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
    audio: false,
  });
  videoEl.srcObject = stream;
  await videoEl.play();
  return stream;
}

export function stopCamera(stream) {
  if (stream) stream.getTracks().forEach((t) => t.stop());
}

// ---- pure helpers (tested in faceId.test.js) ----
export const distance = (a, b) => Math.sqrt(a.reduce((s, x, i) => s + (x - b[i]) ** 2, 0));
export function meanDescriptor(list) {
  return list[0].map((_, i) => list.reduce((s, d) => s + d[i], 0) / list.length);
}
/** Drop samples far from the group's mean (a blink, a half-turned head, a passer-by). */
export function dropOutliers(list, max = 0.45) {
  if (list.length < 3) return list;
  const mean = meanDescriptor(list);
  return list.filter((d) => distance(d, mean) <= max);
}
/** A frame almost identical to one already kept adds nothing (enrollment wants variety). */
export const tooSimilar = (d, kept, min = 0.06) => kept.some((k) => distance(d, k) < min);

export const DARK_BELOW = 50;     // mean brightness (0-255) under which a missing face is "too dark"
export const MIN_FACE_WIDTH = 0.16; // face box width / frame width
export const MAX_YAW = 0.3;       // nose offset from the eyes' midpoint / eye distance
export const MAX_MOVE = 0.25;     // face centre moved this share of its width since last frame
export const MIN_SSD_SCORE = 0.5;  // real faces score 0.8+ even in dim light; lower let a picture of Earth count as a "face"
export const MIN_TINY_SCORE = 0.45;
export const SURE_SMALL_FACE = 0.7; // below this, a small detection counts as "no face"

/** Head turned too far sideways? Uses the 68-point landmarks: nose tip vs the eyes. */
export function yawOf(points) {
  const avg = (from, to) => {
    const ps = points.slice(from, to + 1);
    return { x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + p.y, 0) / ps.length };
  };
  const l = avg(36, 41), r = avg(42, 47), nose = points[30];
  const eyeDist = Math.hypot(r.x - l.x, r.y - l.y) || 1;
  return (nose.x - (l.x + r.x) / 2) / eyeDist;
}

export const GUIDANCE = {
  ok: "Good, hold still…",
  dark: "Too dark: turn on a light or face a bright screen.",
  none: "No face found: look straight at the camera.",
  many: "More than one face: only you in front of the camera.",
  far: "Move a little closer.",
  turned: "Look straight at the camera.",
  moving: "Hold still…",
};

function brightness(video, canvas) {
  const w = 64, h = 48;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return sum / (w * h);
}

/** One frame: {ok, reason, box, score, descriptor, brightness, width, height}. box is in
 *  video pixels. */
export async function analyzeFrame(video, prev = null, scratch = document.createElement("canvas")) {
  const faceapi = await loadLibrary();
  const width = video.videoWidth, height = video.videoHeight;
  const light = brightness(video, scratch);
  let found = await faceapi.detectAllFaces(video, new faceapi.SsdMobilenetv1Options({ minConfidence: MIN_SSD_SCORE }))
    .withFaceLandmarks().withFaceDescriptors();
  if (!found.length) {
    found = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 512, scoreThreshold: MIN_TINY_SCORE }))
      .withFaceLandmarks().withFaceDescriptors();
  }
  const base = { brightness: light, width, height };
  if (!found.length) return { ...base, ok: false, reason: light < DARK_BELOW ? "dark" : "none" };
  if (found.length > 1) {
    const big = found.filter((f) => f.detection.box.width >= width * MIN_FACE_WIDTH * 0.7);
    if (big.length > 1) return { ...base, ok: false, reason: "many", box: found[0].detection.box };
    found = big.length ? big : [found.sort((a, b) => b.detection.box.width - a.detection.box.width)[0]];
  }
  const f = found[0];
  const box = f.detection.box;
  const out = { ...base, box: { x: box.x, y: box.y, width: box.width, height: box.height }, score: f.detection.score };
  if (box.width < width * MIN_FACE_WIDTH) {
    // a small, unsure detection is usually not a face at all (a pattern in the background)
    return { ...out, ok: false, reason: f.detection.score >= SURE_SMALL_FACE ? "far" : "none", box: f.detection.score >= SURE_SMALL_FACE ? out.box : undefined };
  }
  if (Math.abs(yawOf(f.landmarks.positions)) > MAX_YAW) return { ...out, ok: false, reason: "turned" };
  if (prev?.box) {
    const dx = (box.x + box.width / 2) - (prev.box.x + prev.box.width / 2);
    const dy = (box.y + box.height / 2) - (prev.box.y + prev.box.height / 2);
    if (Math.hypot(dx, dy) > box.width * MAX_MOVE) return { ...out, ok: false, reason: "moving" };
  }
  return { ...out, ok: true, reason: "ok", descriptor: Array.from(f.descriptor) };
}

/** Analyse frames back to back (one at a time, ~intervalMs apart) until stop(). Each result
 *  carries `at` (Date.now() when it was analysed). */
export function createScanner(video, onFrame, intervalMs = 200) {
  let running = true, prev = null, timer = 0;
  const scratch = document.createElement("canvas");
  const tick = async () => {
    if (!running) return;
    try {
      if (video.readyState >= 2 && video.videoWidth) {
        const r = await analyzeFrame(video, prev, scratch);
        if (!running) return;
        prev = r.box ? r : null;
        onFrame({ ...r, at: Date.now() });
      }
    } catch (err) {
      if (running) onFrame({ ok: false, reason: "error", error: err?.message || String(err), at: Date.now() });
    }
    if (running) timer = setTimeout(tick, intervalMs);
  };
  tick();
  return { stop() { running = false; clearTimeout(timer); } };
}
