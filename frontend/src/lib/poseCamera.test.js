// lib/poseCamera.js and lib/cameraClaim.js with the camera and network faked: one pose
// observation window (frames paced, report fetched, cancelled on stop or failure) and the
// hand-over of the one webcam between Face Analysis and Pose Analysis.
import { afterEach, describe, expect, it, vi } from "vitest";

const posts = vi.hoisted(() => []);
const failStart = vi.hoisted(() => ({ status: 0 }));
vi.mock("./api.js", () => ({
  post: vi.fn(async (path) => {
    posts.push(path);
    if (path.endsWith("/pose/sessions")) {
      if (failStart.status) throw Object.assign(new Error("x"), { status: failStart.status });
      return { session_id: "pose-abc", window_s: 12, fps: 10 };
    }
    if (path.endsWith("/finish")) return { id: 9, quality: { rating: "good" }, observations: [] };
    return { cancelled: true };
  }),
}));

const { runPoseObservation, stopCamera, openCamera } = await import("./poseCamera.js");
const { claimCamera, releaseCamera, cameraOwner } = await import("./cameraClaim.js");

afterEach(() => { posts.length = 0; failStart.status = 0; releaseCamera(cameraOwner()); vi.unstubAllGlobals(); });

function clock() {
  let t = 0;
  return { now: () => t, wait: async (ms) => { t += ms; } };
}
const okFrame = () => ({ ok: true, json: async () => ({ poses: 1, usable: true, guidance: [], visible: { shoulders: true }, frames: 1 }) });

describe("one pose observation window", () => {
  it("sends frames to the pose endpoints at the given rate, then returns the report", async () => {
    const c = clock();
    const request = vi.fn(async () => okFrame());
    const live = [];
    const progress = [];
    const report = await runPoseObservation({
      astroId: 1, windowS: 2, fps: 10, capture: async () => new Blob(["x"]), now: c.now, wait: c.wait, request,
      onLive: (l) => live.push(l), onProgress: (p) => progress.push(p),
    });
    expect(report.id).toBe(9);
    expect(request).toHaveBeenCalledTimes(20);
    const [url, opts] = request.mock.calls[3];
    expect(url).toBe("/api/astronauts/1/pose/sessions/pose-abc/frames?t=300"); // relative: this laptop only
    expect(opts).toMatchObject({ method: "POST", headers: { "Content-Type": "image/jpeg" } });
    expect(live).toHaveLength(20);
    expect(progress.at(-1)).toBe(1);
    expect(posts).toEqual(["/astronauts/1/pose/sessions", "/astronauts/1/pose/sessions/pose-abc/finish"]);
  });

  it("uses the window and rate the backend gives when none is passed (12 s at 10 fps)", async () => {
    const c = clock();
    const request = vi.fn(async () => okFrame());
    await runPoseObservation({ astroId: 1, capture: async () => new Blob(["x"]), now: c.now, wait: c.wait, request });
    expect(request).toHaveBeenCalledTimes(120);
  });

  it("frames the camera couldn't capture are skipped, not sent", async () => {
    const c = clock();
    const request = vi.fn(async () => okFrame());
    let n = 0;
    await runPoseObservation({ astroId: 1, windowS: 1, fps: 10, capture: async () => (++n % 2 ? null : new Blob(["x"])), now: c.now, wait: c.wait, request });
    expect(request).toHaveBeenCalledTimes(5);
  });

  it("stopping the camera mid-window cancels the session (nothing is kept)", async () => {
    const c = clock();
    const ac = new AbortController();
    let n = 0;
    const p = runPoseObservation({
      astroId: 1, windowS: 12, fps: 10, signal: ac.signal, now: c.now, wait: c.wait,
      capture: async () => { if (++n === 5) ac.abort(); return new Blob(["x"]); },
      request: async () => okFrame(),
    });
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    await new Promise((r) => setTimeout(r, 0));
    expect(posts).toContain("/astronauts/1/pose/sessions/pose-abc/cancel");
    expect(posts).not.toContain("/astronauts/1/pose/sessions/pose-abc/finish");
  });

  it("a frame the backend refuses ends the window, keeps its status, and cancels it", async () => {
    const c = clock();
    const p = runPoseObservation({ astroId: 1, windowS: 12, fps: 10, now: c.now, wait: c.wait, capture: async () => new Blob(["x"]), request: async () => ({ ok: false, status: 400 }) });
    await expect(p).rejects.toMatchObject({ message: "frame 400", status: 400 });
    await new Promise((r) => setTimeout(r, 0));
    expect(posts).toContain("/astronauts/1/pose/sessions/pose-abc/cancel");
  });

  it("an unavailable backend (503) fails before any frame is sent", async () => {
    failStart.status = 503;
    const request = vi.fn();
    await expect(runPoseObservation({ astroId: 1, capture: async () => new Blob(["x"]), request })).rejects.toMatchObject({ status: 503 });
    expect(request).not.toHaveBeenCalled();
  });

  it("reuses the Face Analysis camera helpers: video only, every track stopped", async () => {
    vi.stubGlobal("window", { isSecureContext: true, navigator: { mediaDevices: { getUserMedia() {} } } });
    const tracks = [{ stop: vi.fn() }];
    const getUserMedia = vi.fn(async () => ({ getTracks: () => tracks }));
    const video = { play: vi.fn(async () => {}), srcObject: null };
    const stream = await openCamera(video, { getUserMedia });
    expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: false }));
    stopCamera(stream, video);
    expect(tracks[0].stop).toHaveBeenCalledTimes(1);
    expect(video.srcObject).toBeNull();
  });
});

describe("one camera shared by Face and Pose Analysis", () => {
  it("opening the camera in one section releases it in the other", () => {
    const faceStop = vi.fn(() => releaseCamera("face"));
    const poseStop = vi.fn(() => releaseCamera("pose"));
    claimCamera("face", faceStop);
    expect(cameraOwner()).toBe("face");
    claimCamera("pose", poseStop);
    expect(faceStop).toHaveBeenCalledTimes(1);
    expect(cameraOwner()).toBe("pose");
    claimCamera("face", faceStop);
    expect(poseStop).toHaveBeenCalledTimes(1);
    expect(cameraOwner()).toBe("face");
  });

  it("re-claiming your own camera (Retake) doesn't stop it, and releasing clears the owner", () => {
    const stop = vi.fn();
    claimCamera("pose", stop);
    claimCamera("pose", stop);
    expect(stop).not.toHaveBeenCalled();
    releaseCamera("face"); // someone else's release changes nothing
    expect(cameraOwner()).toBe("pose");
    releaseCamera("pose");
    expect(cameraOwner()).toBe("");
  });

  it("a release callback that throws (an unmounted section) doesn't block the new owner", () => {
    claimCamera("face", () => { throw new Error("gone"); });
    expect(() => claimCamera("pose", () => {})).not.toThrow();
    expect(cameraOwner()).toBe("pose");
  });
});
