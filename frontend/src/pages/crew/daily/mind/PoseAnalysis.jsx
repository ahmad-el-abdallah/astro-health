// Mind page · "Pose Analysis": a 12 s webcam observation of posture and movement, analysed on
// THIS laptop by MediaPipe Pose Landmarker (backend/services/pose.py), and its report.
// Separate from Face Analysis and voice tone: its own camera session, routes and table.
// What it reports are camera-based observations in the picture -- shoulder and hip
// alignment, side-to-side lean, head position, left/right asymmetry, movement, landmark
// visibility -- never a diagnosis of any spinal, neurological, muscular or balance condition.
//
// poseReportView() turns the API answer into loading | empty | error | unavailable | success
// and PoseReportView draws it (both pure, tested in PoseAnalysis.test.jsx). PoseAnalysis holds
// the camera: opened only on request (video only), claimed from Face Analysis if that had it,
// and turned off when the window ends, on Stop, and when the section unmounts.
import { useEffect, useRef, useState } from "react";
import { cameraBlocker, cameraErrorMessage, captureFrame, openCamera, runPoseObservation, stopCamera } from "../../../../lib/poseCamera.js";
import { claimCamera, releaseCamera } from "../../../../lib/cameraClaim.js";
import { useLatestPose, usePoseStatus } from "../../../../lib/queries.js";
import { fmtTime } from "../../../../lib/format.js";
import { Button, Card, CardTitle, cx } from "../../../../components/ui/index.jsx";
import { Icon } from "../../../../components/ui/Icon.jsx";

export const TITLE = "Pose Analysis";
export const POSE_DISCLAIMER = "Camera-based observations of posture and movement, not a medical diagnosis. They can’t detect or rule out any spinal, neurological, muscular or balance condition.";
export const POSE_PRIVACY = "The camera is used only while you analyse. Frames go to this laptop’s own backend, are measured and thrown away; no video or images are stored or sent anywhere, and no audio is recorded.";
export const BACKEND_OUTDATED = "The backend that’s running doesn’t include Pose Analysis yet. Restart it from this version of the app (stop app.py, start it again), then reload this page.";

const RELIABILITY = {
  high: "border-good/40 text-good-fg", medium: "border-accent-text/40 text-accent-text", low: "border-check/40 text-check-fg",
  inconclusive: "border-line text-subtle",
};
const QUALITY_TEXT = { good: "Good", fair: "Fair", poor: "Poor", "no body": "No body found" };
const REGION_TEXT = { head: "Head", shoulders: "Shoulders", arms: "Arms", hips: "Hips", legs: "Legs" };
const isMissingRoute = (err) => err?.status === 404;

/** The Pose Analysis status query -> "" when ready, else why it can't run (plain words). */
export function poseSetupMessage(status) {
  if (status?.isError) return isMissingRoute(status.error) ? BACKEND_OUTDATED : "Couldn’t reach this laptop’s backend to check pose analysis. Is app.py running?";
  const d = status?.data;
  if (!d || status?.isLoading || d.state === "loading" || d.state === "idle") return "Checking the pose analysis model…";
  if (d.state === "ready") return "";
  if (d.state === "missing-deps") return `MediaPipe isn’t installed in this Python environment: ${d.reason}.`;
  if (d.state === "missing-model") return "The Pose Landmarker model is missing: run scripts/pose_analysis/download_model.py.";
  if (d.state === "disabled") return "Pose analysis is turned off on this laptop (ASTRO_NO_POSE=1).";
  return `Pose analysis couldn’t start: ${d.reason || d.state}.`;
}

/** query: { isLoading, isError, error, data: { analysis } } -> what to show. */
export function poseReportView(query) {
  if (query?.isLoading) return { state: "loading" };
  if (query?.isError) {
    return isMissingRoute(query.error) ? { state: "unavailable", message: BACKEND_OUTDATED } : { state: "error", message: "Couldn’t load the last pose analysis." };
  }
  const a = query?.data?.analysis;
  if (!a) return { state: "empty", message: "No pose analysis yet. Open the camera and start one above." };
  const q = a.quality || {};
  const obs = a.observations || [];
  return {
    state: "success",
    when: a.ts,
    quality: { rating: q.rating, label: QUALITY_TEXT[q.rating] || q.rating, issues: q.issues || [], usable: q.usable_frames, frames: q.frames, fps: q.fps, duration: q.duration_s, visibility: q.visibility || {} },
    posture: obs.filter((o) => !["landmark_visibility", "movement"].includes(o.id)),
    movement: obs.filter((o) => o.id === "movement"),
    visibility: obs.filter((o) => o.id === "landmark_visibility"),
    measured: obs.filter((o) => o.status === "measured" && o.id !== "landmark_visibility").length,
    limitations: a.limitations || [],
    disclaimer: a.disclaimer || POSE_DISCLAIMER,
  };
}

function Observation({ o }) {
  return (
    <li className="rounded-xl border border-line bg-input p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold text-ink">{o.name}</span>
        <span data-testid={`pose-rel-${o.id}`} className={cx("rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide", RELIABILITY[o.reliability] || RELIABILITY.inconclusive)}>
          {o.reliability === "inconclusive" ? "Inconclusive" : `${o.reliability} reliability`}
        </span>
      </div>
      <p data-testid={`pose-val-${o.id}`} className={cx("m-0 mt-1 text-sm", o.status === "measured" ? "text-ink-2" : "text-subtle")}>{o.display}</p>
      {o.description && <p className="m-0 mt-1 text-xs text-muted">{o.description}</p>}
      <details className="mt-1 text-xs text-subtle">
        <summary className="cursor-pointer">Why this reliability, and limitations</summary>
        <p className="m-0 mt-1">{o.reliability_reason}</p>
        <ul className="m-0 mt-1 list-disc pl-4">{(o.limitations || []).map((l) => <li key={l}>{l}</li>)}</ul>
      </details>
    </li>
  );
}

function Group({ title, items }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-col gap-2">
      <div className="ah-eyebrow">{title}</div>
      <ul className="m-0 grid list-none gap-2 p-0 md:grid-cols-2">{items.map((o) => <Observation key={o.id} o={o} />)}</ul>
    </div>
  );
}

export function PoseReportView({ view, onRetry }) {
  if (view.state === "loading") return <p role="status" className="m-0 text-sm text-muted">Loading the last pose analysis…</p>;
  if (view.state === "empty") return <p className="m-0 text-sm text-muted">{view.message}</p>;
  if (view.state === "unavailable") return null; // the setup line above already says what to do
  if (view.state === "error") {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-alert-fg">
        <span>{view.message}</span>{onRetry && <Button className="min-h-9 px-3 text-[13px]" onClick={onRetry}>Try again</Button>}
      </div>
    );
  }
  const q = view.quality;
  return (
    <div className="flex flex-col gap-4" aria-label="Last pose analysis report">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-ink-2">
        <span data-testid="pose-when">Session · {fmtTime(view.when)}</span>
        <span data-testid="pose-quality">Detection quality: <span className="font-semibold text-ink">{q.label}</span>{q.issues.length ? ` (${q.issues.join(", ")})` : ""}</span>
        <span data-testid="pose-frames">{q.usable} of {q.frames} frames usable · {q.fps} fps · {q.duration} s</span>
      </div>
      <Group title="Observed posture" items={view.posture} />
      <Group title="Movement" items={view.movement} />
      <Group title="Confidence and visibility" items={view.visibility} />
      <details className="text-xs text-subtle">
        <summary className="cursor-pointer">Limitations of this analysis</summary>
        <ul className="m-0 mt-1 list-disc pl-4">{view.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
      </details>
      <p data-testid="pose-disclaimer" className="m-0 text-xs text-subtle">{view.disclaimer}</p>
    </div>
  );
}

/** The live status line while recording. */
export function liveStatus(live) {
  if (!live) return { text: "Starting…", regions: [] };
  const regions = Object.entries(live.visible || {}).map(([k, v]) => ({ name: REGION_TEXT[k] || k, seen: !!v }));
  if (live.guidance?.length) return { text: live.guidance.join(" · "), regions };
  return { text: live.usable ? "Body found, looking good" : "Looking for your body…", regions };
}

const PHASE_TEXT = {
  preview: "Camera on. Sit or stand facing the camera with your head and shoulders in view (hips too, if you can), then start.",
  recording: "Analysing… sit or stand naturally and keep still.",
  processing: "Putting the report together…",
};
const OWNER = "pose";

export function PoseAnalysis({ astroId, own }) {
  const status = usePoseStatus();
  const latest = useLatestPose(astroId);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const abortRef = useRef(null);
  const [phase, setPhase] = useState("idle"); // idle | opening | preview | recording | processing | done
  const [error, setError] = useState("");
  const [live, setLive] = useState(null);
  const [progress, setProgress] = useState(0);

  const blocked = cameraBlocker();
  const why = !own ? "Only the astronaut can analyse their own posture, from their own sign-in."
    : blocked ? cameraErrorMessage({ name: blocked })
    : poseSetupMessage(status);

  const closeCamera = () => {
    abortRef.current?.abort();
    stopCamera(streamRef.current, videoRef.current);
    streamRef.current = null;
    releaseCamera(OWNER);
  };
  useEffect(() => () => closeCamera(), []); // leaving the page always turns the camera off

  function stop() {
    closeCamera();
    setPhase("idle");
    setLive(null);
  }

  async function open() {
    setError("");
    setLive(null);
    setProgress(0);
    setPhase("opening");
    claimCamera(OWNER, stop); // Face Analysis lets go of the camera first, if it had it
    try {
      streamRef.current = await openCamera(videoRef.current);
      setPhase("preview");
    } catch (err) {
      releaseCamera(OWNER);
      setError(err.message);
      setPhase("idle");
    }
  }

  async function analyse() {
    const ac = new AbortController();
    abortRef.current = ac;
    setError("");
    setLive(null);
    setProgress(0);
    setPhase("recording");
    try {
      await runPoseObservation({
        astroId, windowS: status.data?.window_s, fps: status.data?.fps, signal: ac.signal,
        capture: () => captureFrame(videoRef.current, canvasRef.current),
        onLive: setLive, onProgress: setProgress,
      });
      setPhase("processing");
      await latest.refetch();
      setPhase("done");
    } catch (err) {
      if (err?.name !== "AbortError") setError(err?.status === 503 ? "Pose analysis isn’t available on this laptop." : "The analysis didn’t finish. Try again.");
      setPhase(streamRef.current ? "preview" : "idle");
      return;
    } finally {
      abortRef.current = null;
    }
    closeCamera(); // the window is over: release the camera
  }

  const cameraOn = ["opening", "preview", "recording", "processing"].includes(phase);
  const ls = liveStatus(live);
  return (
    <Card aria-label={TITLE} className="flex w-full flex-col gap-4">
      <CardTitle eyebrow="Camera · analysed on this laptop" title={TITLE} subtitle="A 12-second look at what the camera can measure about posture: shoulder and hip alignment, side-to-side lean, head position, left/right symmetry and how still you stayed." className="mb-0" />
      <div className={cx("grid gap-4", cameraOn && "md:grid-cols-[minmax(0,360px)_1fr]")}>
        <div className={cx("relative overflow-hidden rounded-2xl border border-line bg-black", !cameraOn && "hidden")}>
          <video ref={videoRef} playsInline muted aria-label="Pose camera preview" className="block aspect-[4/3] w-full -scale-x-100 object-cover" />
          {phase === "recording" && (
            <div className="absolute inset-x-0 bottom-0 bg-black/55 p-2">
              <div className="h-1.5 overflow-hidden rounded-full bg-white/20"><div className="h-full bg-accent-text" style={{ width: `${progress * 100}%` }} /></div>
              <div className="mt-1 text-xs text-white" data-testid="pose-live">{ls.text}</div>
              {ls.regions.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1" data-testid="pose-regions">
                  {ls.regions.map((r) => (
                    <span key={r.name} className={cx("rounded-full px-1.5 py-0.5 text-[10px] font-semibold", r.seen ? "bg-white/25 text-white" : "bg-black/40 text-white/60 line-through")}>{r.name}</span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <canvas ref={canvasRef} className="hidden" aria-hidden="true" />
        <div className="flex flex-col gap-3">
          {cameraOn && <p className="m-0 text-sm text-ink-2" role="status">{PHASE_TEXT[phase] || "Opening the camera…"}</p>}
          <div className="flex flex-wrap gap-2">
            {(phase === "idle" || phase === "done") && (
              <Button variant="primary" onClick={open} disabled={!!why}>
                <Icon name="video" size={16} /> {phase === "done" ? "Retake" : "Open camera"}
              </Button>
            )}
            {phase === "preview" && <Button variant="primary" onClick={analyse}>Start analysis (12 s)</Button>}
            {cameraOn && <Button onClick={stop}>Stop camera</Button>}
          </div>
          {why && phase === "idle" && <p className="m-0 text-[13px] text-muted">{why}</p>}
          {error && <p role="alert" className="m-0 text-sm text-alert-fg">{error}</p>}
          <p className="m-0 text-xs text-subtle">{POSE_PRIVACY}</p>
        </div>
      </div>
      <div className="border-t border-divider pt-4">
        <PoseReportView view={poseReportView(latest)} onRetry={() => latest.refetch()} />
      </div>
    </Card>
  );
}
