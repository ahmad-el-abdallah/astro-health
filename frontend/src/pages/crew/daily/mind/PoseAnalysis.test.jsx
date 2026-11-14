// The Mind page's Pose Analysis report: loading, empty, error, unavailable and success,
// rendered to HTML; the setup messages; and the live detection status line.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BACKEND_OUTDATED, liveStatus, POSE_DISCLAIMER, POSE_PRIVACY, poseReportView, PoseReportView, poseSetupMessage } from "./PoseAnalysis.jsx";

const measured = (id, name, display, reliability = "medium") => ({ id, name, status: "measured", value: 1, display, description: `${name} description`, reliability, reliability_reason: "118 usable frames", limitations: [`${name} limitation`] });
const inconclusive = (id, name, why) => ({ id, name, status: "inconclusive", value: null, display: "Inconclusive", description: "", reliability: "inconclusive", reliability_reason: why, limitations: ["Not enough usable frames to measure."] });
const analysis = {
  id: 4, ts: "2026-11-14T09:30:00+00:00",
  quality: { rating: "good", issues: ["hips not in view"], frames: 120, usable_frames: 118, fps: 10, duration_s: 12, visibility: { head: 0.98, shoulders: 0.99, arms: 0.6, hips: 0.3, legs: 0.05 } },
  observations: [
    measured("landmark_visibility", "Landmark visibility and confidence", "head 0.98, shoulders 0.99, arms 0.60, hips 0.30, legs 0.05", "high"),
    measured("shoulder_alignment", "Shoulder alignment", "2.4° — left side lower; varied ±0.6°", "high"),
    inconclusive("hip_alignment", "Hip alignment", "hips clearly in view in only 0% of usable frames: step back so your hips are in the picture"),
    inconclusive("torso_inclination", "Visible torso inclination", "the hips weren't in view often enough to measure lean"),
    measured("head_position", "Head and upper-body position", "head centred over the shoulders"),
    measured("asymmetry", "Left/right landmark asymmetry", "0.06 shoulder widths on average (0 = mirrored)", "low"),
    measured("movement", "Movement and stability", "very still: swayed 0.01 shoulder widths (SD)", "high"),
  ],
  limitations: ["A single front-facing camera sees the body in 2D: forward/backward lean and rotation are not measured."],
  disclaimer: "Camera-based observations of posture and movement in the picture, not a medical assessment.",
};
const html = (q) => renderToStaticMarkup(<PoseReportView view={poseReportView(q)} onRetry={() => {}} />);
const text = (h) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("Pose Analysis report", () => {
  it("success: session time, detection quality, frame counts and grouped observations", () => {
    const h = html({ data: { analysis } });
    const t = text(h);
    expect(h).toContain('data-testid="pose-when"');
    expect(h).toMatch(/data-testid="pose-quality">Detection quality: <span[^>]*>Good<\/span> \(hips not in view\)/);
    expect(t).toContain("118 of 120 frames usable · 10 fps · 12 s");
    expect(t).toContain("Observed posture");
    expect(t).toContain("Movement");
    expect(t).toContain("Confidence and visibility");
    expect(h).toMatch(/data-testid="pose-val-shoulder_alignment"[^>]*>2.4° — left side lower/);
    expect(h).toMatch(/data-testid="pose-rel-asymmetry"[^>]*>low reliability/);
    expect(h).toMatch(/data-testid="pose-val-movement"[^>]*>very still/);
  });

  it("inconclusive observations say so and why, never a value", () => {
    const h = html({ data: { analysis } });
    expect(h).toMatch(/data-testid="pose-val-hip_alignment"[^>]*>Inconclusive/);
    expect(h).toMatch(/data-testid="pose-rel-torso_inclination"[^>]*>Inconclusive/);
    expect(text(h)).toContain("step back so your hips are in the picture");
  });

  it("limitations and the disclaimer are always shown", () => {
    const t = text(html({ data: { analysis } }));
    expect(t).toContain("Shoulder alignment limitation");
    expect(t).toContain("Limitations of this analysis");
    expect(t).toContain("forward/backward lean and rotation are not measured");
    expect(t).toContain("not a medical assessment");
    expect(POSE_DISCLAIMER).toMatch(/not a medical diagnosis/);
    expect(POSE_DISCLAIMER).toMatch(/spinal, neurological, muscular or balance/);
    expect(POSE_PRIVACY).toMatch(/no video or images are stored/);
    // an older report without its own disclaimer still gets the page's
    const noDisc = { ...analysis, disclaimer: undefined };
    expect(text(html({ data: { analysis: noDisc } }))).toContain(POSE_DISCLAIMER.slice(0, 40));
  });

  it("loading, empty and error states", () => {
    expect(text(html({ isLoading: true }))).toContain("Loading the last pose analysis");
    const empty = html({ data: { analysis: null } });
    expect(text(empty)).toContain("No pose analysis yet");
    expect(empty).not.toContain('role="alert"'); // no previous report is calm, not an error
    const e = html({ isError: true, error: Object.assign(new Error("x"), { status: 500 }) });
    expect(e).toContain('role="alert"');
    expect(text(e)).toContain("Try again");
  });

  it("an old backend without the pose routes shows nothing misleading", () => {
    const v = poseReportView({ isError: true, error: Object.assign(new Error("x"), { status: 404 }) });
    expect(v.state).toBe("unavailable");
    expect(renderToStaticMarkup(<PoseReportView view={v} />)).toBe("");
  });

  it("a report from a reload is the same as the one just made (it comes from the database)", () => {
    expect(poseReportView({ data: { analysis } })).toEqual(poseReportView({ data: JSON.parse(JSON.stringify({ analysis })) }));
  });
});

describe("setup status", () => {
  it("names the real reason for each state", () => {
    expect(poseSetupMessage({ data: { state: "ready" } })).toBe("");
    expect(poseSetupMessage({ isLoading: true })).toMatch(/Checking/);
    expect(poseSetupMessage({ data: { state: "missing-deps", reason: "install requirements-face.txt (mediapipe)" } })).toMatch(/MediaPipe isn.t installed/);
    expect(poseSetupMessage({ data: { state: "missing-model" } })).toMatch(/pose_analysis\/download_model\.py/);
    expect(poseSetupMessage({ data: { state: "disabled" } })).toMatch(/ASTRO_NO_POSE/);
    expect(poseSetupMessage({ isError: true, error: Object.assign(new Error("x"), { status: 404 }) })).toBe(BACKEND_OUTDATED);
    expect(poseSetupMessage({ isError: true, error: Object.assign(new Error("x"), { status: 0 }) })).toMatch(/Is app\.py running/);
  });
});

describe("live detection status", () => {
  it("shows hints when the body isn't fully visible, and which regions are seen", () => {
    expect(liveStatus(null).text).toBe("Starting…");
    const s = liveStatus({ poses: 1, usable: true, guidance: ["Step back to show your hips (for hip and lean measures)"], visible: { head: true, shoulders: true, hips: false } });
    expect(s.text).toMatch(/Step back/);
    expect(s.regions).toEqual([{ name: "Head", seen: true }, { name: "Shoulders", seen: true }, { name: "Hips", seen: false }]);
    expect(liveStatus({ poses: 1, usable: true, guidance: [], visible: { shoulders: true } }).text).toBe("Body found, looking good");
    expect(liveStatus({ poses: 0, usable: false, guidance: ["No body found: sit or stand back so your head and shoulders are in view"], visible: {} }).text).toMatch(/No body found/);
  });
});
