// Mind page · "Face Analysis": a 12 s webcam observation, analysed on THIS laptop by MediaPipe
// Face Landmarker (backend/services/face.py), and its report. Separate from voice tone and
// from self-reported mood. What it reports are camera observations -- eye openness and
// closures, head position and movement, under-eye and skin appearance only when the picture
// allows, and image quality -- never a diagnosis or a health condition.
//
// faceReportView() turns the API answer into loading | empty | error | success and
// FaceReportView draws it (both pure, tested in FaceAnalysis.test.jsx). FaceAnalysis holds the
// camera: opened only on request (video only, no microphone), turned off when the window ends,
// on Stop, and when the section unmounts.
import { useEffect, useRef, useState } from "react";
import { cameraBlocker, cameraErrorMessage, captureFrame, openCamera, runObservation, stopCamera } from "../../../../lib/faceCamera.js";
import { claimCamera, releaseCamera } from "../../../../lib/cameraClaim.js";
import { useFaceStatus, useLatestFace } from "../../../../lib/queries.js";
import { fmtTime } from "../../../../lib/format.js";
import { Button, Card, CardTitle, cx } from "../../../../components/ui/index.jsx";
import { Icon } from "../../../../components/ui/Icon.jsx";

export const TITLE = "Face Analysis";
export const FACE_DISCLAIMER = "Camera observations only: how open your eyes were, how often they closed, how your head moved, and what the picture showed. Not a diagnosis, and no health condition is inferred.";
export const FACE_PRIVACY = "The camera is used only while you analyse. Frames go to this laptop's own backend, are measured and thrown away; no video or images are stored or sent anywhere, and no audio is recorded.";

const RELIABILITY = {
  high: "border-good/40 text-good-fg", medium: "border-accent-text/40 text-accent-text", low: "border-check/40 text-check-fg",
  inconclusive: "border-line text-subtle",
};
const QUALITY_TEXT = { good: "Good", fair: "Fair", poor: "Poor", "no face": "No face found" };

// The backend answered 404 for a Face Analysis route: it's running code from before this
// feature existed (seen 2026-11-13: an old app.py process kept running while the new page was
// served by Vite). That's "restart the backend", not "not set up" and not "no results".
export const BACKEND_OUTDATED = "The backend that’s running doesn’t include Face Analysis yet. Restart it from this version of the app (stop app.py, start it again), then reload this page.";
const isMissingRoute = (err) => err?.status === 404;

/** The Face Analysis status query -> "" when ready, else why it can't run (plain words). */
export function faceSetupMessage(status) {
  if (status?.isError) return isMissingRoute(status.error) ? BACKEND_OUTDATED : "Couldn’t reach this laptop’s backend to check face analysis. Is app.py running?";
  const d = status?.data;
  if (!d || status?.isLoading || d.state === "loading" || d.state === "idle") return "Checking the face analysis model…";
  if (d.state === "ready") return "";
  if (d.state === "missing-deps") return `MediaPipe isn’t installed in this Python environment: ${d.reason}.`;
  if (d.state === "missing-model") return "The Face Landmarker model is missing: run scripts/face_analysis/download_model.py.";
  if (d.state === "disabled") return "Face analysis is turned off on this laptop (ASTRO_NO_FACE=1).";
  return `Face analysis couldn’t start: ${d.reason || d.state}.`;
}

/** query: { isLoading, isError, error, data: { analysis } } -> what to show. */
export function faceReportView(query) {
  if (query?.isLoading) return { state: "loading" };
  if (query?.isError) {
    return isMissingRoute(query.error) ? { state: "unavailable", message: BACKEND_OUTDATED } : { state: "error", message: "Couldn’t load the last face analysis." };
  }
  const a = query?.data?.analysis;
  if (!a) return { state: "empty", message: "No face analysis yet. Open the camera and start one above." };
  const q = a.quality || {};
  return {
    state: "success",
    when: a.ts,
    quality: { rating: q.rating, label: QUALITY_TEXT[q.rating] || q.rating, issues: q.issues || [], usable: q.usable_frames, frames: q.frames, fps: q.fps, duration: q.duration_s },
    observations: (a.observations || []).filter((o) => o.id !== "image_quality"),
    measured: (a.observations || []).filter((o) => o.status === "measured" && o.id !== "image_quality").length,
  };
}

function Observation({ o }) {
  return (
    <li className="rounded-xl border border-line bg-input p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold text-ink">{o.name}</span>
        <span data-testid={`rel-${o.id}`} className={cx("rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide", RELIABILITY[o.reliability] || RELIABILITY.inconclusive)}>
          {o.reliability === "inconclusive" ? "Inconclusive" : `${o.reliability} reliability`}
        </span>
      </div>
      <p data-testid={`val-${o.id}`} className={cx("m-0 mt-1 text-sm", o.status === "measured" ? "text-ink-2" : "text-subtle")}>{o.display}</p>
      {o.description && <p className="m-0 mt-1 text-xs text-muted">{o.description}</p>}
      <details className="mt-1 text-xs text-subtle">
        <summary className="cursor-pointer">Why this reliability, and limitations</summary>
        <p className="m-0 mt-1">{o.reliability_reason}</p>
        <ul className="m-0 mt-1 list-disc pl-4">{(o.limitations || []).map((l) => <li key={l}>{l}</li>)}</ul>
      </details>
    </li>
  );
}

export function FaceReportView({ view, onRetry }) {
  if (view.state === "loading") return <p role="status" className="m-0 text-sm text-muted">Loading the last face analysis…</p>;
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
    <div className="flex flex-col gap-3" aria-label="Last face analysis report">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-ink-2">
        <span>Last analysis · {fmtTime(view.when)}</span>
        <span data-testid="face-quality">Image quality: <span className="font-semibold text-ink">{q.label}</span>{q.issues.length ? ` (${q.issues.join(", ")})` : ""}</span>
        <span data-testid="face-frames">{q.usable} of {q.frames} frames usable · {q.fps} fps · {q.duration} s</span>
      </div>
      <ul className="m-0 grid list-none gap-2 p-0 md:grid-cols-2">{view.observations.map((o) => <Observation key={o.id} o={o} />)}</ul>
      <p className="m-0 text-xs text-subtle">{FACE_DISCLAIMER}</p>
    </div>
  );
}

const PHASE_TEXT = { preview: "Camera on. Face the camera in good light, then start.", recording: "Analysing… keep looking at the screen naturally.", processing: "Putting the report together…" };

export function FaceAnalysis({ astroId, own }) {
  const status = useFaceStatus();
  const latest = useLatestFace(astroId);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const abortRef = useRef(null);
  const [phase, setPhase] = useState("idle"); // idle | opening | preview | recording | processing | done
  const [error, setError] = useState("");
  const [live, setLive] = useState(null);
  const [progress, setProgress] = useState(0);

  const blocked = cameraBlocker();
  const why = !own ? "Only the astronaut can analyse their own face, from their own sign-in."
    : blocked ? cameraErrorMessage({ name: blocked })
    : faceSetupMessage(status);

  const closeCamera = () => {
    abortRef.current?.abort();
    stopCamera(streamRef.current, videoRef.current);
    streamRef.current = null;
    releaseCamera("face");
  };
  useEffect(() => () => closeCamera(), []); // leaving the page always turns the camera off

  async function open() {
    setError("");
    setLive(null);
    setProgress(0);
    setPhase("opening");
    claimCamera("face", stop); // Pose Analysis lets go of the camera first, if it had it
    try {
      streamRef.current = await openCamera(videoRef.current);
      setPhase("preview");
    } catch (err) {
      setError(err.message);
      setPhase("idle");
    }
  }

  async function analyse() {
    const ac = new AbortController();
    abortRef.current = ac;
    setError("");
    setPhase("recording");
    try {
      await runObservation({
        astroId, windowS: status.data?.window_s, fps: status.data?.fps, signal: ac.signal,
        capture: () => captureFrame(videoRef.current, canvasRef.current),
        onLive: setLive, onProgress: setProgress,
      });
      setPhase("processing");
      await latest.refetch();
      setPhase("done");
    } catch (err) {
      if (err?.name !== "AbortError") setError(err?.status === 503 ? "Face analysis isn’t available on this laptop." : "The analysis didn’t finish. Try again.");
      setPhase(streamRef.current ? "preview" : "idle");
      return;
    } finally {
      abortRef.current = null;
    }
    closeCamera(); // the window is over: release the camera
  }

  function stop() {
    closeCamera();
    setPhase("idle");
    setLive(null);
  }

  const cameraOn = ["opening", "preview", "recording", "processing"].includes(phase);
  const guidance = live?.guidance || [];
  return (
    <Card aria-label={TITLE} className="flex w-full flex-col gap-4">
      <CardTitle eyebrow="Camera · analysed on this laptop" title={TITLE} subtitle="A 12-second look at what the camera can measure: eye openness and closures, head movement, and how clear the picture is." className="mb-0" />
      <div className={cx("grid gap-4", cameraOn && "md:grid-cols-[minmax(0,360px)_1fr]")}>
        <div className={cx("relative overflow-hidden rounded-2xl border border-line bg-black", !cameraOn && "hidden")}>
          <video ref={videoRef} playsInline muted aria-label="Camera preview" className="block aspect-[4/3] w-full -scale-x-100 object-cover" />
          {phase === "recording" && (
            <div className="absolute inset-x-0 bottom-0 bg-black/55 p-2">
              <div className="h-1.5 overflow-hidden rounded-full bg-white/20"><div className="h-full bg-accent-text" style={{ width: `${progress * 100}%` }} /></div>
              <div className="mt-1 text-xs text-white" data-testid="face-live">
                {guidance.length ? guidance.join(" · ") : live ? "Face found, looking good" : "Starting…"}
              </div>
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
          <p className="m-0 text-xs text-subtle">{FACE_PRIVACY}</p>
        </div>
      </div>
      <div className="border-t border-divider pt-4">
        <FaceReportView view={faceReportView(latest)} onRetry={() => latest.refetch()} />
      </div>
    </Card>
  );
}
