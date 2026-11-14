// lib/faceCamera.js with the camera and network faked: permission and missing-camera
// messages, video-only capture, the camera released on stop, and one observation window
// (frames paced, report fetched, cancelled on stop or failure).
import { afterEach, describe, expect, it, vi } from "vitest";

const posts = vi.hoisted(() => []);
vi.mock("./api.js", () => ({
  post: vi.fn(async (path) => {
    posts.push(path);
    if (path.endsWith("/face/sessions")) return { session_id: "face-abc", window_s: 12, fps: 10 };
    if (path.endsWith("/finish")) return { id: 7, quality: { rating: "good" }, observations: [] };
    return { cancelled: true };
  }),
}));

const { cameraBlocker, cameraErrorMessage, openCamera, runObservation, stopCamera } = await import("./faceCamera.js");

afterEach(() => { posts.length = 0; vi.unstubAllGlobals(); });

describe("camera access", () => {
  it("explains each way the camera can fail", () => {
    expect(cameraErrorMessage({ name: "NotAllowedError" })).toMatch(/permission was denied/);
    expect(cameraErrorMessage({ name: "NotFoundError" })).toMatch(/No camera was found/);
    expect(cameraErrorMessage({ name: "NotReadableError" })).toMatch(/busy/);
    expect(cameraErrorMessage({ name: "insecure" })).toMatch(/localhost/);
    expect(cameraErrorMessage({})).toMatch(/couldn.t be opened/);
  });

  it("knows when the page can't use a camera at all", () => {
    expect(cameraBlocker({ isSecureContext: false, navigator: {} })).toBe("insecure");
    expect(cameraBlocker({ isSecureContext: true, navigator: {} })).toBe("unsupported");
    expect(cameraBlocker({ isSecureContext: true, navigator: { mediaDevices: { getUserMedia() {} } } })).toBe("");
  });

  it("asks for video only -- never the microphone", async () => {
    vi.stubGlobal("window", { isSecureContext: true, navigator: { mediaDevices: { getUserMedia() {} } } });
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [] }));
    const video = { play: vi.fn(async () => {}) };
    await openCamera(video, { getUserMedia });
    expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: false, video: expect.any(Object) }));
    expect(video.muted).toBe(true);
  });

  it("turns a denied permission or a missing camera into a clear error", async () => {
    vi.stubGlobal("window", { isSecureContext: true, navigator: { mediaDevices: { getUserMedia() {} } } });
    for (const name of ["NotAllowedError", "NotFoundError"]) {
      const getUserMedia = vi.fn(async () => { const e = new Error("x"); e.name = name; throw e; });
      await expect(openCamera(null, { getUserMedia })).rejects.toMatchObject({ message: cameraErrorMessage({ name }), cause: { name } });
    }
  });

  it("stopCamera stops every track and detaches the preview", () => {
    const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
    const video = { srcObject: {} };
    stopCamera({ getTracks: () => tracks }, video);
    expect(tracks.every((t) => t.stop.mock.calls.length === 1)).toBe(true);
    expect(video.srcObject).toBeNull();
    expect(() => stopCamera(null, null)).not.toThrow();
  });
});

describe("one observation window", () => {
  function clock() {
    let t = 0;
    return { now: () => t, wait: async (ms) => { t += ms; } };
  }
  const okFrame = () => ({ ok: true, json: async () => ({ faces: 1, usable: true, guidance: [], frames: 1 }) });

  it("sends frames at the given rate for the window, then returns the report", async () => {
    const c = clock();
    const request = vi.fn(async () => okFrame());
    const live = [];
    const progress = [];
    const report = await runObservation({
      astroId: 1, windowS: 2, fps: 10, capture: async () => new Blob(["x"]), now: c.now, wait: c.wait, request,
      onLive: (l) => live.push(l), onProgress: (p) => progress.push(p),
    });
    expect(report.id).toBe(7);
    expect(request).toHaveBeenCalledTimes(20); // 2 s x 10 fps
    const [url, opts] = request.mock.calls[3];
    expect(url).toBe("/api/astronauts/1/face/sessions/face-abc/frames?t=300"); // relative: this laptop only
    expect(opts).toMatchObject({ method: "POST", headers: { "Content-Type": "image/jpeg" } });
    expect(live).toHaveLength(20);
    expect(progress.at(-1)).toBe(1);
    expect(posts).toEqual(["/astronauts/1/face/sessions", "/astronauts/1/face/sessions/face-abc/finish"]);
  });

  it("stopping the camera mid-window cancels the session (nothing is kept)", async () => {
    const c = clock();
    const ac = new AbortController();
    let n = 0;
    const p = runObservation({
      astroId: 1, windowS: 12, fps: 10, signal: ac.signal, now: c.now, wait: c.wait,
      capture: async () => { if (++n === 5) ac.abort(); return new Blob(["x"]); },
      request: async () => okFrame(),
    });
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    await new Promise((r) => setTimeout(r, 0));
    expect(posts).toContain("/astronauts/1/face/sessions/face-abc/cancel");
    expect(posts).not.toContain("/astronauts/1/face/sessions/face-abc/finish");
  });

  it("a frame the backend refuses ends the window and cancels it", async () => {
    const c = clock();
    const p = runObservation({ astroId: 1, windowS: 12, fps: 10, now: c.now, wait: c.wait, capture: async () => new Blob(["x"]), request: async () => ({ ok: false, status: 500 }) });
    await expect(p).rejects.toThrow("frame 500");
    await new Promise((r) => setTimeout(r, 0));
    expect(posts).toContain("/astronauts/1/face/sessions/face-abc/cancel");
  });
});
