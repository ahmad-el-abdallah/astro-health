// Pose Analysis: one ~12 s observation window. The camera itself (video only, no microphone),
// the preview and the in-memory JPEG frames come from lib/faceCamera.js, unchanged; this file
// only sends those frames to the pose endpoints (POST .../pose/sessions/<id>/frames) on THIS
// laptop's backend, which runs MediaPipe Pose Landmarker on each and throws the image away.
import { post } from "./api.js";

export { cameraBlocker, cameraErrorMessage, captureFrame, openCamera, stopCamera } from "./faceCamera.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts a backend pose session, sends frames at `fps` for `windowS` seconds (waiting for each
 * answer before the next, so a slow laptop just gets fewer frames), then finishes it and
 * resolves to the report. `onLive({poses, usable, guidance, visible, frames})` after each
 * frame, `onProgress(0..1)`. Aborting (signal) or any failure cancels the session.
 */
export async function runPoseObservation({ astroId, windowS, fps, capture, signal, onLive, onProgress, now = () => performance.now(), wait = sleep, request = fetch }) {
  const start = await post(`/astronauts/${astroId}/pose/sessions`, {});
  const path = `/astronauts/${astroId}/pose/sessions/${encodeURIComponent(start.session_id)}`;
  const total = (windowS ?? start.window_s) * 1000;
  const every = 1000 / (fps ?? start.fps);
  const t0 = now();
  try {
    for (let next = 0; ; next += every) {
      if (signal?.aborted) throw new DOMException("stopped", "AbortError");
      const elapsed = now() - t0;
      if (elapsed >= total) break;
      if (elapsed < next) await wait(next - elapsed);
      if (now() - t0 >= total) break;
      const blob = await capture();
      if (signal?.aborted) throw new DOMException("stopped", "AbortError");
      if (blob) {
        const t = Math.round(now() - t0);
        const res = await request(`/api${path}/frames?t=${t}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "image/jpeg" }, body: blob });
        if (!res.ok) throw Object.assign(new Error(`frame ${res.status}`), { status: res.status });
        onLive?.(await res.json());
      }
      onProgress?.(Math.min(1, (now() - t0) / total));
    }
    onProgress?.(1);
    return await post(`${path}/finish`, {});
  } catch (err) {
    post(`${path}/cancel`, {}).catch(() => {});
    throw err;
  }
}
