// The Mind page's Face Analysis report: loading, empty, error and success, rendered to HTML.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BACKEND_OUTDATED, FACE_DISCLAIMER, FACE_PRIVACY, faceReportView, FaceReportView, faceSetupMessage } from "./FaceAnalysis.jsx";

const measured = (id, name, display, reliability = "medium") => ({ id, name, status: "measured", value: 1, display, description: `${name} description`, reliability, reliability_reason: "120 usable frames at 10 fps", limitations: [`${name} limitation`] });
const inconclusive = (id, name, why) => ({ id, name, status: "inconclusive", value: null, display: "Inconclusive", description: "", reliability: "inconclusive", reliability_reason: why, limitations: ["Not enough usable frames to measure."] });
const analysis = {
  id: 3, ts: "2026-11-13T18:00:00+00:00",
  quality: { rating: "fair", issues: ["dim lighting"], frames: 120, usable_frames: 118, fps: 10, duration_s: 12 },
  observations: [
    measured("image_quality", "Image quality and face positioning", "Fair — dim lighting", "high"),
    measured("eye_openness", "Eye openness", "0.31 when open (left/right differ by 2%)"),
    measured("eye_closures", "Eye closures (blinks)", "3 in 12 s (15/min)", "low"),
    measured("head_movement", "Head position and movement", "turned +2°"),
    inconclusive("under_eye", "Under-eye appearance", "light not good enough"),
    inconclusive("skin", "Visible skin appearance", "the light has a strong colour cast (b* -31)"),
  ],
};
const html = (q) => renderToStaticMarkup(<FaceReportView view={faceReportView(q)} onRetry={() => {}} />);
const text = (h) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("Face Analysis report", () => {
  it("success: quality, frame counts and each observation with its reliability", () => {
    const h = html({ data: { analysis } });
    const t = text(h);
    expect(h).toMatch(/data-testid="face-quality">Image quality: <span[^>]*>Fair<\/span> \(dim lighting\)/);
    expect(t).toContain("118 of 120 frames usable · 10 fps · 12 s");
    expect(h).toMatch(/data-testid="val-eye_openness"[^>]*>0.31 when open/);
    expect(h).toMatch(/data-testid="rel-eye_closures"[^>]*>low reliability/);
    expect(h).not.toContain('data-testid="val-image_quality"'); // shown as the quality line instead
  });

  it("inconclusive observations say so and why, never a value", () => {
    const h = html({ data: { analysis } });
    expect(h).toMatch(/data-testid="val-skin"[^>]*>Inconclusive/);
    expect(h).toMatch(/data-testid="rel-skin"[^>]*>Inconclusive/);
    expect(text(h)).toContain("strong colour cast");
  });

  it("every observation carries its limitations, and the report says what it isn't", () => {
    const t = text(html({ data: { analysis } }));
    expect(t).toContain("Eye openness limitation");
    expect(t).toContain(FACE_DISCLAIMER.slice(0, 40));
    expect(FACE_DISCLAIMER).toMatch(/Not a diagnosis/);
    expect(FACE_PRIVACY).toMatch(/no video or images are stored/);
    expect(FACE_PRIVACY).toMatch(/no audio is recorded/);
  });

  it("loading, empty and error states", () => {
    expect(text(html({ isLoading: true }))).toContain("Loading the last face analysis");
    expect(text(html({ data: { analysis: null } }))).toContain("No face analysis yet");
    const e = html({ isError: true });
    expect(e).toContain('role="alert"');
    expect(text(e)).toContain("Try again");
  });

  it("a report from a reload is the same as the one just made (it comes from the database)", () => {
    expect(faceReportView({ data: { analysis } })).toEqual(faceReportView({ data: JSON.parse(JSON.stringify({ analysis })) }));
  });
});

describe("setup status and an out-of-date backend", () => {
  const err404 = Object.assign(new Error("/face/status -> 404"), { status: 404 });
  it("an old backend without the face routes says 'restart the backend', not 'not set up'", () => {
    expect(faceSetupMessage({ isError: true, error: err404 })).toBe(BACKEND_OUTDATED);
    expect(BACKEND_OUTDATED).toMatch(/Restart it/);
    const v = faceReportView({ isError: true, error: Object.assign(new Error("x"), { status: 404 }) });
    expect(v.state).toBe("unavailable");
    expect(renderToStaticMarkup(<FaceReportView view={v} />)).toBe(""); // not a misleading "couldn't load"
  });
  it("names the real reason for each state", () => {
    expect(faceSetupMessage({ data: { state: "ready" } })).toBe("");
    expect(faceSetupMessage({ isLoading: true })).toMatch(/Checking/);
    expect(faceSetupMessage({ data: { state: "missing-deps", reason: "install requirements-face.txt (mediapipe)" } })).toMatch(/MediaPipe isn.t installed/);
    expect(faceSetupMessage({ data: { state: "missing-model" } })).toMatch(/download_model\.py/);
    expect(faceSetupMessage({ data: { state: "disabled" } })).toMatch(/turned off/);
    expect(faceSetupMessage({ isError: true, error: Object.assign(new Error("x"), { status: 0 }) })).toMatch(/Is app\.py running/);
  });
  it("no previous report is a calm empty state, not an error", () => {
    const v = faceReportView({ data: { analysis: null } });
    expect(v.state).toBe("empty");
    expect(renderToStaticMarkup(<FaceReportView view={v} />)).not.toContain('role="alert"');
  });
});
