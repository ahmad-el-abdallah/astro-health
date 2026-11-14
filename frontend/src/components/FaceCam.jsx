// The Face ID camera (login and Account): a mirrored camera view with the detected face
// drawn on top -- green when the frame is good enough to use, amber otherwise -- and, while
// `scanning`, every analysed frame passed to onFrame (lib/faceId.js analyzeFrame).
import { useEffect, useRef } from "react";
import { createScanner, startCamera, stopCamera } from "../lib/faceId.js";
import { cx } from "./ui/index.jsx";

export function FaceCam({ active, scanning, onFrame, onCamera, className = "" }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const onFrameRef = useRef(onFrame);
  const onCameraRef = useRef(onCamera);
  useEffect(() => { onFrameRef.current = onFrame; onCameraRef.current = onCamera; });
  const readyRef = useRef(false);

  // Camera on while active.
  useEffect(() => {
    if (!active) return undefined;
    let stream = null, cancelled = false;
    readyRef.current = false;
    startCamera(videoRef.current)
      .then((s) => {
        if (cancelled) { stopCamera(s); return; }
        stream = s;
        readyRef.current = true;
        onCameraRef.current?.({ ok: true });
      })
      .catch((err) => { if (!cancelled) onCameraRef.current?.({ ok: false, error: err?.message || String(err) }); });
    return () => { cancelled = true; stopCamera(stream); readyRef.current = false; };
  }, [active]);

  // Analyse frames while scanning; draw the box.
  useEffect(() => {
    if (!active || !scanning) {
      const c = canvasRef.current;
      c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
      return undefined;
    }
    const video = videoRef.current;
    const scanner = createScanner(video, (r) => {
      const c = canvasRef.current;
      if (c && r.width) {
        if (c.width !== r.width) { c.width = r.width; c.height = r.height; }
        const ctx = c.getContext("2d");
        ctx.clearRect(0, 0, c.width, c.height);
        if (r.box) {
          ctx.lineWidth = Math.max(3, r.width / 160);
          ctx.strokeStyle = r.ok ? "#3ddc97" : "#f5b942";
          const { x, y, width, height } = r.box;
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(x, y, width, height, width * 0.08);
          else ctx.rect(x, y, width, height);
          ctx.stroke();
        }
      }
      onFrameRef.current?.(r);
    });
    return () => scanner.stop();
  }, [active, scanning]);

  return (
    <div className={cx("relative overflow-hidden rounded-xl bg-space", className)}>
      <video ref={videoRef} muted playsInline className="block aspect-[4/3] w-full -scale-x-100 object-contain" />
      <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full -scale-x-100" />
    </div>
  );
}
