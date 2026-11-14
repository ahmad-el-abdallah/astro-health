// Face Analysis: the webcam and one observation window. The camera is opened with VIDEO
// ONLY (no microphone), shown as a live preview, and while an observation runs, one small
// JPEG frame at a time is sent to THIS laptop's backend (POST .../face/sessions/<id>/frames),
// which runs MediaPipe Face Landmarker (VIDEO mode) on it and throws the image away. Nothing is
// recorded, stored or sent anywhere else. stopCamera() releases the camera (the light goes off).
import { post } from "./api.js";

export const FRAME_WIDTH = 640;
export const JPEG_QUALITY = 0.8;

/** A clear message for each way the camera can fail to open. */
export function cameraErrorMessage(err) {
  const name = err?.name || "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    return "Camera permission was denied. Allow the camera for this site in the browser's address bar, then try again.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return "No camera was found on this computer.";
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return "The camera is busy or couldn't start. Close other apps or tabs using it, then try again.";
  }
  if (name === "insecure") return "The camera needs the app opened as http://localhost:5000 (or https).";
  if (name === "unsupported") return "This browser can't use a camera here.";
  return "The camera couldn't be opened.";
}

/** Why the camera can't be used at all in this browser/page, or "" if it can. */
export function cameraBlocker(win = typeof window !== "undefined" ? window : undefined) {
  if (!win) return "unsupported";
  if (!win.isSecureContext) return "insecure";
  if (!win.navigator?.mediaDevices?.getUserMedia) return "unsupported";
  return "";
}

/** Open the front camera (video only) into a <video>. Throws an Error with a friendly
 *  `.message` and the browser's `.cause`. */
export async function openCamera(video, md = navigator.mediaDevices) {
  const blocked = cameraBlocker();
  if (blocked) { const e = new Error(cameraErrorMessage({ name: blocked })); e.cause = { name: blocked }; throw e; }
  let stream;
  try {
    stream = await md.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" }, audio: false });
  } catch (err) {
    const e = new Error(cameraErrorMessage(err));
    e.cause = err;
    throw e;
  }
  if (video) {
    video.srcObject = stream;
    video.muted = true;
    try { await video.play(); } catch { /* autoplay of a muted video is allowed; the frames still flow */ }
  }
  return stream;
}

/** Turn the camera off (every track) and detach it from the preview. */
export function stopCamera(stream, video) {
  stream?.getTracks?.().forEach((t) => { try { t.stop(); } catch { /* already stopped */ } });
  if (video && video.srcObject) video.srcObject = null;
}

/** One frame of the preview -> a JPEG Blob at most FRAME_WIDTH wide (in memory only). */
export function captureFrame(video, canvas) {
  const vw = video.videoWidth || 0;
  const vh = video.videoHeight || 0;
  if (!vw || !vh) return Promise.resolve(null);
  const scale = Math.min(1, FRAME_WIDTH / vw);
  canvas.width = Math.round(vw * scale);
  canvas.height = Math.round(vh * scale);
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", JPEG_QUALITY));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One observation window. Starts a backend session, sends frames at `fps` for `windowS`
 * seconds (waiting for each answer before the next, so a slow laptop just gets fewer frames),
 * then finishes it and resolves to the report. `onLive({faces, usable, guidance, frames})`
 * after each frame, `onProgress(0..1)`. Aborting (signal) cancels the session on the backend.
 */
export async function runObservation({ astroId, windowS, fps, capture, signal, onLive, onProgress, now = () => performance.now(), wait = sleep, request = fetch }) {
  const start = await post(`/astronauts/${astroId}/face/sessions`, {});
  const sid = start.session_id;
  const base = `/api/astronauts/${astroId}/face/sessions/${encodeURIComponent(sid)}`;
  const total = (windowS ?? start.window_s) * 1000;
  const every = 1000 / (fps ?? start.fps);
  const t0 = now();
  try {
    for (let next = 0; ; next += every) {
      if (signal?.aborted) throw new DOMException("stopped", "AbortError");
      const elapsed = now() - t0;
      if (elapsed >= total) break;
      if (elapsed < next) await wait(next - elapsed);
      if (now() - t0 >= total) break; // the window ended while waiting
      const blob = await capture();
      if (signal?.aborted) throw new DOMException("stopped", "AbortError");
      if (blob) {
        const t = Math.round(now() - t0);
        const res = await request(`${base}/frames?t=${t}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "image/jpeg" }, body: blob });
        if (!res.ok) throw new Error(`frame ${res.status}`);
        onLive?.(await res.json());
      }
      onProgress?.(Math.min(1, (now() - t0) / total));
    }
    onProgress?.(1);
    return await post(`${base.replace(/^\/api/, "")}/finish`, {});
  } catch (err) {
    post(`${base.replace(/^\/api/, "")}/cancel`, {}).catch(() => {});
    throw err;
  }
}
