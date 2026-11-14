// The live wearable test (backend/logic/sensor_feed.py): a real recorded crew session --
// NASA's crew-state physiology study, crew 13 -- replayed as if the astronaut wore a chest
// strap and finger sensor right now. Shows a moving ECG trace, heart rate, breathing rate
// and a relative stress level, and flags the recorded startle moments.
// It's a test: it plays once. At the end (or "Finish & save") its results become the
// astronaut's latest vitals plus an assessment -- Today's vitals check is done -- and the
// card shows a "Test complete" summary. "Cancel" throws it away. The astronaut runs it; the
// flight surgeon only watches. Numbers arrive once a second over Socket.IO ("sensor" ->
// lib/socket.js sensorStore); the result arrives as "sensor_changed" (sensorResultStore).
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { get, put } from "../lib/api.js";
import { sensorResultStore, sensorStore, useStore } from "../lib/socket.js";
import { Button, Card, Progress, Segmented, cx } from "./ui/index.jsx";
import { Icon } from "./ui/Icon.jsx";

const TRACE_HZ = 100;
const LEVEL_TEXT = { GREEN: "text-good-fg", YELLOW: "text-check-fg", RED: "text-alert-fg" };
const LEVEL_WORD = { GREEN: "Good", YELLOW: "Check", RED: "Alert" };
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
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
  const result = useStore(sensorResultStore)[astroId];
  const status = summary?.sensor || null;
  const on = !!status?.on;
  const [choice, setChoice] = useState("startle");
  const [busy, setBusy] = useState(false);
  // the store is cleared when the monitor stops (sensor_changed), so any entry is current
  const fresh = !!live && !!status?.on;
  const now = fresh ? live : status;
  const segLabel = segs.data?.segments.find((s) => s.id === (on ? status.segment : choice));

  // body: {segment} starts a test, {on:false} finishes + saves, {on:false, save:false} cancels
  async function send(body, which) {
    setBusy(which);
    try {
      const r = await put(`/astronauts/${astroId}/sensor`, body);
      if (body.segment) sensorResultStore.set((all) => ({ ...all, [astroId]: null }));
      else sensorResultStore.set((all) => ({ ...all, [astroId]: r?.finished ? r.result : null }));
      await qc.invalidateQueries({ queryKey: ["summary"] });
    } finally {
      setBusy(false);
    }
  }

  if (!on && !canControl && !result) return null; // the surgeon sees it while it runs, and its result

  const startle = !!(on && now?.event && status?.segment === "startle"); // a bare 0 would render as "0"
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
          <div className="flex gap-2">
            <Button variant="ghost" className="min-h-10 px-3 text-label" onClick={() => send({ on: false, save: false }, "cancel")} busy={busy === "cancel"} disabled={!!busy}>Cancel</Button>
            <Button variant="primary" className="min-h-10 px-3.5 text-label" onClick={() => send({ on: false }, "finish")} busy={busy === "finish"} disabled={!!busy}>
              {busy !== "finish" && <Icon name="tick" size={16} />} Finish &amp; save
            </Button>
          </div>
        )}
      </div>

      {on ? (
        <>
          <div className="flex items-center gap-3 text-label text-muted">
            <Progress value={(now?.second ?? 0) / (status.seconds || 1)} className="flex-1" />
            <span className="ah-num shrink-0">{mmss(now?.second ?? 0)} / {mmss(status.seconds)}</span>
          </div>
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
            When it ends (or you finish it), the results are saved as your latest vitals and count as today’s vitals check.
            Source: {segs.data?.source || "recorded crew data"} (real signals, replayed). Not medical advice.
          </p>
        </>
      ) : result ? (
        <TestResult result={result} canControl={canControl} onAgain={() => sensorResultStore.set((all) => ({ ...all, [astroId]: null }))} />
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
          <Button variant="primary" onClick={() => send({ segment: choice }, "start")} busy={busy === "start"} disabled={!segs.data || !!busy}>
            {!busy && <Icon name="waveform" size={16} />} Start test
          </Button>
          {segLabel && <p className="m-0 basis-full text-label text-muted">{segLabel.label}: {segLabel.about}.</p>}
        </div>
      )}
    </Card>
  );
}

// "Test complete": what was saved, and that it counts as today's vitals check.
function TestResult({ result, canControl, onAgain }) {
  const r = result.results || {};
  const lvl = result.overall_level;
  return (
    <div className="flex animate-[ah-pop_.4s_ease-out] flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="tick" size={20} className="text-good-fg" />
        <span className="text-title font-semibold">{result.label} test complete</span>
        <span className={cx("text-label font-semibold", LEVEL_TEXT[lvl])}>· {LEVEL_WORD[lvl] || lvl}</span>
        <span className="text-label text-muted">· {mmss(r.seconds || 0)} recorded</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat icon="heart" label="Average heart rate" value={r.heart_rate} unit={`bpm · peak ${r.peak_heart_rate}`} />
        <Stat icon="lungs" label="Average breathing" value={r.respiration_rate} unit="/min" />
        <Stat icon="mind" label="Average stress" value={r.stress} unit={`/100 · peak ${r.peak_stress}`} />
      </div>
      <p className="m-0 text-label text-ink-2">
        Saved as your latest vitals and counted as today’s vitals check{r.startles ? ` · ${r.startles} startle event${r.startles === 1 ? "" : "s"} recorded` : ""}. Astra is looking at the result.
      </p>
      {canControl && (
        <Button className="w-fit" onClick={onAgain}>
          <Icon name="reset" size={16} /> Run another test
        </Button>
      )}
    </div>
  );
}
