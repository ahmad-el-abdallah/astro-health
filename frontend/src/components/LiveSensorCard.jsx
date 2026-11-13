// The live wearable (backend/logic/sensor_feed.py): a real recorded crew session -- NASA's
// crew-state physiology study, crew 13 -- replayed as if the astronaut wore a chest strap
// and finger sensor right now. Shows a moving ECG trace, heart rate, breathing rate and a
// relative stress level, and flags the recorded startle moments. The astronaut starts and
// stops it (and picks which recorded test to replay); the flight surgeon only watches.
// Numbers arrive once a second over Socket.IO ("sensor" -> lib/socket.js sensorStore).
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { get, put } from "../lib/api.js";
import { sensorStore, useStore } from "../lib/socket.js";
import { Button, Card, Progress, Segmented, cx } from "./ui/index.jsx";
import { Icon } from "./ui/Icon.jsx";

const TRACE_HZ = 100;
const WINDOW_S = 5; // seconds of ECG on screen

function useSegments() {
  return useQuery({ queryKey: ["sensor-segments"], queryFn: () => get("/sensor/segments"), staleTime: Infinity });
}

// Draws the trace straight from the store on every animation frame (no React re-render per
// frame). The newest second arrives in one chunk, so the line is drawn one second behind and
// slides forward smoothly through that chunk until the next one lands.
function EcgTrace({ astroId, live }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !live) return undefined;
    const ctx = canvas.getContext("2d");
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const d = sensorStore.get()[astroId];
      const ecg = d?.ecg || [];
      if (ecg.length < TRACE_HZ * 2) return;
      const frac = Math.min(1, (Date.now() - d.at) / 1000);
      const end = ecg.length - TRACE_HZ + Math.floor(frac * TRACE_HZ); // one second behind, sliding
      const n = WINDOW_S * TRACE_HZ;
      const start = Math.max(0, end - n);
      const style = getComputedStyle(canvas);
      ctx.strokeStyle = style.getPropertyValue("--color-good-fg").trim() || "#3ddc97";
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (let i = start; i < end; i++) {
        const x = ((i - (end - n)) / n) * w;
        const y = h / 2 - (ecg[i] / 127) * (h * 0.42);
        if (i === start) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [astroId, live]);
  return <canvas ref={ref} aria-hidden="true" className="block h-24 w-full" />;
}

function Stat({ icon, label, value, unit, pulse }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-[var(--radius-inner)] bg-raised p-3">
      <span className="flex items-center gap-1.5 text-label text-ink-2">
        <Icon name={icon} size={16} className={cx(pulse && "text-alert-fg")} style={pulse ? { animation: `ah-pop ${60 / pulse}s ease-out infinite` } : undefined} />
        {label}
      </span>
      <span className="font-display text-display font-semibold leading-none">
        <span className="ah-num">{value ?? "–"}</span>
        <span className="ml-1 text-label font-normal text-muted">{unit}</span>
      </span>
    </div>
  );
}

export function LiveSensorCard({ astroId, summary, canControl = false, className = "" }) {
  const qc = useQueryClient();
  const segs = useSegments();
  const live = useStore(sensorStore)[astroId];
  const status = summary?.sensor || null;
  const on = !!status?.on;
  const [choice, setChoice] = useState("startle");
  const [busy, setBusy] = useState(false);
  // the store is cleared when the monitor stops (sensor_changed), so any entry is current
  const fresh = !!live && !!status?.on;
  const now = fresh ? live : status;
  const segLabel = segs.data?.segments.find((s) => s.id === (on ? status.segment : choice));

  async function setOn(next) {
    setBusy(true);
    try {
      await put(`/astronauts/${astroId}/sensor`, next ? { segment: choice } : { on: false });
      await qc.invalidateQueries({ queryKey: ["summary"] });
    } finally {
      setBusy(false);
    }
  }

  if (!on && !canControl) return null; // the surgeon sees it only while it's running

  const startle = on && now?.event && status?.segment === "startle";
  const stressLevel = (now?.stress ?? 0) > 85 ? "alert" : (now?.stress ?? 0) > 60 ? "check" : "good";

  return (
    <Card className={cx("flex flex-col gap-4", className)}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-text">
          <Icon name="waveform" size={20} />
        </span>
        <div className="min-w-0 flex-[1_1_220px]">
          <h2 className="m-0 text-title font-semibold">{on ? `Live monitor · ${status.label}` : "Live monitor"}</h2>
          <div className="text-label text-muted">
            {on ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 animate-pulse rounded-full bg-good-fg" aria-hidden="true" /> Streaming · {segLabel?.about}
              </span>
            ) : "Heart, breathing and stress from a wearable, replayed from a real crew recording"}
          </div>
        </div>
        {startle && (
          <span className="inline-flex animate-[ah-flash_.8s_ease-out] items-center gap-1.5 rounded-full bg-alert-bg px-2.5 py-1 text-label font-semibold text-alert-fg">
            <Icon name="alert" size={14} /> Startle event
          </span>
        )}
        {canControl && on && (
          <Button className="min-h-10 px-3.5 text-label" onClick={() => setOn(false)} busy={busy}>Stop</Button>
        )}
      </div>

      {on ? (
        <>
          <div className="overflow-hidden rounded-[var(--radius-inner)] bg-raised px-2">
            <EcgTrace astroId={astroId} live={!!fresh} />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat icon="heart" label="Heart rate" value={now?.hr} unit="bpm" pulse={fresh ? now?.hr : 0} />
            <Stat icon="lungs" label="Breathing" value={now?.br} unit="/min" />
            <div className="flex min-w-0 flex-col gap-2 rounded-[var(--radius-inner)] bg-raised p-3">
              <span className="flex items-center justify-between gap-2 text-label text-ink-2">
                <span className="flex items-center gap-1.5"><Icon name="mind" size={16} /> Stress</span>
                <span className={cx("font-semibold", { good: "text-good-fg", check: "text-check-fg", alert: "text-alert-fg" }[stressLevel])}>
                  <span className="ah-num">{now?.stress ?? "–"}</span>/100
                </span>
              </span>
              <Progress value={(now?.stress ?? 0) / 100} />
              <span className="text-caption text-muted">Skin response, relative to you</span>
            </div>
          </div>
          <p className="m-0 text-caption text-subtle">
            Saved as a reading every minute. Source: {segs.data?.source || "recorded crew data"} (real signals, replayed). Not medical advice.
          </p>
        </>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-label text-ink-2">Recorded test to replay</span>
            <Segmented
              id="sensor-seg"
              size="sm"
              value={choice}
              onChange={setChoice}
              options={(segs.data?.segments || []).map((s) => ({ value: s.id, label: s.label }))}
            />
          </div>
          <Button variant="primary" onClick={() => setOn(true)} busy={busy} disabled={!segs.data}>
            {!busy && <Icon name="waveform" size={16} />} Start live monitor
          </Button>
          {segLabel && <p className="m-0 basis-full text-label text-muted">{segLabel.label}: {segLabel.about}.</p>}
        </div>
      )}
    </Card>
  );
}
