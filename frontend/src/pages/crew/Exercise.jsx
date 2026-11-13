// Crew · Exercises. The ISS daily exercise plan (config/exercises.json: T2 treadmill,
// CEVIS cycle, ARED resistance, stretching) against this astronaut's real workout logs
// (GET /astronauts/<id>/exercise). A 3D coach demonstrates whichever exercise is picked,
// step by step. "Start exercise" runs the same workout timer as the NFC tags and Astra.
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAstronautPicker, useAuth } from "../../auth/AuthProvider.jsx";
import { get, post } from "../../lib/api.js";
import { AnimatedNumber, Button, Card, CardTitle, Progress, cx } from "../../components/ui/index.jsx";
import { Icon } from "../../components/ui/Icon.jsx";
import { RingGauge } from "../../components/charts/RingGauge.jsx";
import { WebGLBoundary, NoWebGL } from "../../three/webgl.jsx";

const CoachScene = lazy(() => import("../../three/exercise/CoachScene.jsx"));
const ICON = { t2: "exercise", cevis: "heart", ared: "exercise", stretch: "mind" };
const STEP_S = 4.5;   // how long the coach spends on each step

const useExercise = (id) =>
  useQuery({ queryKey: ["exercise", id], queryFn: () => get(`/astronauts/${id}/exercise`), enabled: !!id, refetchInterval: 30_000 });

// Live stopwatch for the running workout, in seconds (Exercises-page workouts run in real time).
function useElapsed(running) {
  const [, tick] = useState(0);
  useEffect(() => { if (!running) return undefined; const iv = setInterval(() => tick((n) => n + 1), 250); return () => clearInterval(iv); }, [running]);
  if (!running?.started_at) return 0;
  return Math.max(0, Math.floor((Date.now() / 1000 - running.started_at) * (running.time_scale || 1)));
}
const clock = (sec) => `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;

// 3 · 2 · 1 · GO! shown over the coach and on the card before a workout starts
function Countdown({ value }) {
  return (
    <AnimatePresence>
      {value != null && (
        <motion.div key={value} initial={{ scale: 1.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }} transition={{ duration: 0.35 }}
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <span className="font-display text-[88px] leading-none font-bold text-white drop-shadow-[0_0_30px_rgba(143,166,255,.8)]">{value === 0 ? "GO!" : value}</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Stat({ icon, label, value, unit, tone = "text-accent-text" }) {
  return (
    <Card className="flex flex-col gap-3 p-5">
      <span className={cx("flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft", tone)}><Icon name={icon} size={20} /></span>
      <span className="text-sm text-ink-2">{label}</span>
      <span className="font-display text-[32px] leading-none font-bold tracking-tight">
        <AnimatedNumber value={value} /> <span className="text-base font-normal text-muted">{unit}</span>
      </span>
    </Card>
  );
}

function WeekChart({ week, goal }) {
  const max = Math.max(goal, ...week.map((d) => d.minutes), 1);
  return (
    <div className="relative mt-2 h-44">
      <div className="absolute inset-x-0 border-t border-dashed border-accent-text/40" style={{ bottom: `${(goal / max) * 100 * 0.82 + 14}%` }}>
        <span className="absolute -top-5 right-0 text-[10px] text-accent-text">Goal {goal} min</span>
      </div>
      <div className="absolute inset-0 flex items-end justify-between gap-2 pb-6">
        {week.map((d, i) => (
          <div key={d.date} className="group relative flex h-full flex-1 flex-col items-center justify-end">
            <span className="mb-1 text-[10px] text-muted opacity-0 transition-opacity group-hover:opacity-100">{d.minutes}m</span>
            <motion.div
              initial={{ height: 0 }} animate={{ height: `${(d.minutes / max) * 82}%` }}
              transition={{ delay: 0.05 * i, type: "spring", stiffness: 140, damping: 20 }}
              className={cx("w-full max-w-7 rounded-t-lg", d.today ? "bg-accent-text shadow-[0_0_18px_rgba(143,166,255,.45)]" : "bg-line-strong")}
              style={{ minHeight: d.minutes ? 4 : 2 }}
            />
            <span className={cx("absolute -bottom-0.5 text-[11px] tracking-wide", d.today ? "font-bold text-accent-text" : "text-muted")}>{d.label.toUpperCase()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function recommendation(data) {
  if (!data) return null;
  const left = data.exercises.filter((e) => e.done_min < e.target_min);
  if (data.running) return `Keep going with ${data.running.name}. Press Stop when you're done so it's logged.`;
  if (!left.length) return "All of today's exercise is done. Great work: your bones and muscles thank you. Stretch gently before sleep.";
  const lift = left.find((e) => e.id === "ared");
  const next = lift && data.today_min > 0 ? lift : left[0];
  const done = data.exercises.filter((e) => e.done_min >= e.target_min).map((e) => e.name.toLowerCase());
  return `${done.length ? `Nice: ${done.join(" and ")} done. ` : ""}Next up: ${next.name} (${next.target_min - next.done_min} min left). ${next.why}`;
}

export default function Exercise() {
  const qc = useQueryClient();
  const { id } = useAstronautPicker();
  const { isSurgeon } = useAuth();
  const ex = useExercise(id);
  const data = ex.data;
  const [sel, setSel] = useState(null);
  const [playing, setPlaying] = useState(true);
  const [restartKey, setRestartKey] = useState(0);
  const [demo, setDemo] = useState({ t: 0, reps: undefined });
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const coachRef = useRef(null);
  const elapsed = useElapsed(data?.running);
  const runningMin = Math.floor(elapsed / 60);
  const [count, setCount] = useState(null);       // { id, n }: countdown before a start
  const [confirmReset, setConfirmReset] = useState(null);
  const exercise = data?.exercises.find((e) => e.id === sel);
  const step = exercise ? Math.floor(demo.t / STEP_S) % exercise.steps.length : 0;
  const stepProgress = ((demo.t % STEP_S) / STEP_S) * 100;
  const pct = data ? Math.min(100, Math.round((data.today_min / data.goal_min) * 100)) : null;
  const tip = useMemo(() => recommendation(data), [data]);

  function pick(exId, scroll = false) {
    setSel(exId); setPlaying(true); setRestartKey((k) => k + 1);
    if (scroll) coachRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  async function toggle(exId) {
    if (count) return;
    setBusy(exId); setError(null);
    try {
      if (data?.running?.id === exId) await post(`/astronauts/${id}/exercise/stop`);
      else {
        if (sel !== exId) pick(exId, true);
        for (const n of [3, 2, 1, 0]) { setCount({ id: exId, n }); await new Promise((r) => setTimeout(r, n ? 1000 : 600)); }
        setCount(null);
        await post(`/astronauts/${id}/exercise/start`, { exercise: exId });
      }
      await qc.invalidateQueries({ queryKey: ["exercise"] });
      qc.invalidateQueries({ queryKey: ["summary"] });
    } catch (e) {
      setError(e?.message || "Couldn't update the workout.");
    } finally { setBusy(null); setCount(null); }
  }

  async function resetProgress(exId) {
    if (confirmReset !== exId) { setConfirmReset(exId); setTimeout(() => setConfirmReset((c) => (c === exId ? null : c)), 4000); return; }
    setConfirmReset(null); setBusy(exId); setError(null);
    try {
      await post(`/astronauts/${id}/exercise/reset`, { exercise: exId });
      await qc.invalidateQueries({ queryKey: ["exercise"] });
    } catch (e) {
      setError(e?.message || "Couldn't reset the progress.");
    } finally { setBusy(null); }
  }

  if (!data) {
    return <Card><p className="m-0 text-sm text-muted">{ex.isError ? "Couldn't load the exercise plan." : "Loading today's exercise plan…"}</p></Card>;
  }

  return (
    <>
      <p className="m-0 max-w-3xl px-1 text-[15px] text-ink-2">
        On the ISS, astronauts exercise about two hours a day to fight bone and muscle loss. Pick an exercise to watch the 3D coach demonstrate it, then press <b className="text-ink">Start exercise</b> to log your session.
      </p>

      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
        <Stat icon="schedule" label="Daily exercise goal" value={data.goal_min} unit="min" />
        <Stat icon="exercise" label="Completed today" value={data.today_min} unit="min" tone="text-good-fg" />
        <Stat icon="trends" label="Remaining" value={Math.max(0, data.goal_min - data.today_min)} unit="min" />
        <Card className="flex items-center justify-center gap-4 p-4">
          <RingGauge value={pct} size={118} stroke={11} ariaLabel={`${pct}% of today's exercise goal done`} />
          <span className="max-w-[90px] text-xs leading-snug text-muted">of today's goal completed</span>
        </Card>
      </div>

        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2 px-1">
            <h2 className="m-0 font-display text-xl font-semibold">Choose an exercise</h2>
            <span className="text-xs tracking-wider text-muted">{sel ? "ISS TRAINING PROGRAM" : "PICK ONE TO SEE HOW IT'S DONE"}</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {data.exercises.map((e) => {
              const running = data.running?.id === e.id;
              const done = Math.min(e.done_min + (running ? runningMin : 0), e.target_min);
              const complete = e.done_min >= e.target_min;
              const blocked = data.running && !running;
              return (
                <Card
                  key={e.id}
                  hover
                  onClick={() => pick(e.id, true)}
                  className={cx("flex cursor-pointer flex-col gap-3 p-5 transition-[border-color,box-shadow]",
                    sel === e.id && "border-accent-text/60 shadow-[0_0_0_1px_rgba(143,166,255,.35),0_10px_30px_rgba(0,0,0,.25)]")}
                >
                  <div className="flex items-start justify-between">
                    <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent-text"><Icon name={ICON[e.id]} size={20} /></span>
                    <span className="rounded-lg bg-accent-soft px-2.5 py-1 text-sm font-semibold text-accent-text">{e.target_min} MIN</span>
                  </div>
                  <div>
                    <h3 className="m-0 font-display text-lg font-semibold">{e.name}</h3>
                    <span className="text-[13px] font-medium tracking-wide text-accent-text">{e.machine.toUpperCase()}</span>
                  </div>
                  <p className="m-0 text-[13px] text-ink-2">{e.summary}</p>
                  <div className={cx("relative flex items-center justify-between rounded-xl border px-3 py-2", running ? "border-accent-text/50 bg-accent-soft" : "border-line bg-raised/40")}>
                    <span className="text-[11px] font-semibold tracking-wider text-muted">{count?.id === e.id ? "GET READY" : running ? "TIME" : "TIMER"}</span>
                    <span className={cx("font-mono text-xl font-bold tabular-nums", running ? "text-accent-text" : "text-ink-2")}>
                      {count?.id === e.id ? (count.n ? `0${count.n}` : "GO!") : clock(running ? elapsed : 0)}
                    </span>
                  </div>
                  <div className="mt-auto">
                    <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
                      <span className="text-ink-2">Session progress</span>
                      <span className="flex items-center gap-2">
                        <span className="font-mono text-muted">{done} / {e.target_min} min</span>
                        {!isSurgeon && e.done_min > 0 && !running && (
                          <button
                            onClick={(ev) => { ev.stopPropagation(); resetProgress(e.id); }}
                            disabled={!!busy}
                            title="Reset today's progress for this exercise"
                            className={cx("flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold transition-colors",
                              confirmReset === e.id ? "bg-alert-bg text-alert-fg" : "text-muted hover:bg-raised hover:text-ink")}
                          >
                            <Icon name="reset" size={12} />{confirmReset === e.id ? "Sure? Tap again" : "Reset"}
                          </button>
                        )}
                      </span>
                    </div>
                    <Progress value={done / e.target_min} />
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className={cx("flex items-center gap-1.5 text-xs font-semibold", running ? "text-accent-text" : complete ? "text-good-fg" : "text-muted")}>
                      {running && <span className="h-2 w-2 animate-pulse rounded-full bg-accent-text" />}
                      {running ? "In progress" : complete ? "Complete" : done ? "Started" : "Ready"}
                    </span>
                    {!isSurgeon && (
                      <Button
                        variant={running ? "danger" : "secondary"} className="min-h-9 px-3.5 text-[13px]"
                        disabled={(!!busy && !running) || blocked || !!count}
                        title={blocked ? `Stop ${data.running.name} first` : undefined}
                        onClick={(ev) => { ev.stopPropagation(); toggle(e.id); }}
                      >
                        {count?.id === e.id ? "Get ready…" : busy === e.id && running ? "…" : running ? "Stop" : "Start exercise"}
                      </Button>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        </section>

      {/* 3D coach */}
      <div ref={coachRef} className="scroll-mt-24">
        <Card className="grid items-stretch overflow-hidden p-0 lg:grid-cols-[minmax(340px,1.2fr)_1fr]">
          <div className="relative min-h-[420px]">
            <WebGLBoundary fallback={<NoWebGL title="3D coach unavailable" />}>
              <Suspense fallback={<div className="flex h-full min-h-[420px] items-center justify-center text-sm text-muted">Loading 3D coach…</div>}>
                <CoachScene exercise={sel} playing={playing} restartKey={restartKey} onStep={setDemo} />
              </Suspense>
            </WebGLBoundary>
            <Countdown value={count?.n} />
            <div className="pointer-events-none absolute top-4 left-4 flex flex-wrap gap-2">
              <span className="rounded-full ah-glass px-3 py-1 text-[11px] font-semibold tracking-wide text-ink-2">{exercise ? `3D COACH · ${exercise.machine.toUpperCase()}` : "3D COACH · WAITING FOR YOUR PICK"}</span>
              {data.running && data.running.id === sel && (
                <span className="flex items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1 font-mono text-[12px] font-bold text-accent-text"><span className="h-2 w-2 animate-pulse rounded-full bg-accent-text" />{clock(elapsed)}</span>
              )}
              {sel === "ared" && demo.reps != null && (
                <span className="rounded-full bg-accent-soft px-3 py-1 text-[11px] font-bold text-accent-text">Reps: {demo.reps}</span>
              )}
            </div>
            <div className={cx("pointer-events-none absolute bottom-4 left-4 flex items-center gap-2 text-[11px] text-muted transition-opacity", !exercise && "opacity-0")}>
              <span className="h-2.5 w-2.5 rounded-full bg-[#ff6a3d] shadow-[0_0_8px_#ff6a3d]" /> Glowing = muscles working
            </div>
          </div>

          {!exercise ? (
            <div className="flex flex-col justify-center gap-4 p-8">
              <span className="ah-eyebrow">3D coach</span>
              <h2 className="m-0 font-display text-[28px] leading-tight font-semibold">Your coach is ready.<br />Pick an exercise to start the lesson.</h2>
              <p className="m-0 max-w-md text-sm text-ink-2">The astronaut will show you every step on the real ISS machine: how to strap in, set up and move safely in microgravity, with the muscles you're working glowing as you go.</p>
              <div className="flex flex-wrap gap-2">
                {data.exercises.map((e) => (
                  <button key={e.id} onClick={() => pick(e.id)} className="flex items-center gap-2 rounded-full border border-line bg-raised/50 px-3.5 py-2 text-sm font-semibold text-ink-2 transition-colors hover:border-accent-text/60 hover:text-ink">
                    <Icon name={ICON[e.id]} size={16} className="text-accent-text" />{e.name}
                  </button>
                ))}
              </div>
              <p className="m-0 text-xs text-muted">Tip: you can also ask Astra, e.g. "start my treadmill run" or "which exercise should I do next?"</p>
            </div>
          ) : (
          <div className="flex flex-col gap-4 p-6">
            <div className="flex items-start justify-between gap-3"><div>
              <span className="ah-eyebrow">How to do it in microgravity</span>
              <h2 className="m-0 mt-1 font-display text-[26px] font-semibold">{exercise?.name}</h2>
              <p className="m-0 mt-1 text-sm text-ink-2">{exercise?.summary}</p>
            </div>
            <button onClick={() => setSel(null)} aria-label="Close lesson" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line text-muted transition-colors hover:text-ink">✕</button>
            </div>
            <ol className="m-0 flex list-none flex-col gap-2 p-0">
              {exercise?.steps.map((s, i) => (
                <li key={s.title}>
                  <div
                    className={cx("relative w-full overflow-hidden rounded-2xl border p-3 text-left transition-colors",
                      i === step ? "border-accent-text/60 bg-accent-soft" : "border-line bg-raised/40")}
                  >
                    {i === step && playing && <span className="absolute inset-y-0 left-0 bg-accent-text/10" style={{ width: `${stepProgress}%` }} />}
                    <span className="relative flex items-start gap-3">
                      <span className={cx("flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                        i === step ? "bg-accent text-accent-on" : i < step ? "bg-good-bg text-good-fg" : "bg-control text-muted")}>
                        {i < step ? <Icon name="check" size={14} /> : i + 1}
                      </span>
                      <span>
                        <span className={cx("block text-sm font-semibold", i === step ? "text-ink" : "text-ink-2")}>{s.title}</span>
                        <span className="block text-[13px] leading-snug text-muted">{s.text}</span>
                      </span>
                    </span>
                  </div>
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap gap-1.5">
              {exercise?.muscles.map((mus) => <span key={mus} className="rounded-full border border-[#ff6a3d]/40 bg-[#ff6a3d]/10 px-2.5 py-0.5 text-[11px] font-semibold text-[#ff9a7a]">{mus}</span>)}
            </div>
            <p className="m-0 rounded-2xl bg-raised/60 p-3 text-[13px] text-ink-2"><b className="text-ink">Why in space:</b> {exercise?.why}</p>
            <div className="mt-auto flex flex-wrap gap-2.5">
              <Button variant="secondary" className="min-h-10" onClick={() => setPlaying((p) => !p)}>{playing ? "Pause demo" : "Play demo"}</Button>
              <Button variant="ghost" className="min-h-10" onClick={() => { setRestartKey((k) => k + 1); setPlaying(true); }}><Icon name="reset" size={16} />Restart</Button>
              {!isSurgeon && (
                <Button variant={data.running?.id === sel ? "danger" : "primary"} className="ml-auto min-h-10" disabled={!!count || (!!busy && data.running?.id !== sel) || (data.running && data.running.id !== sel)} onClick={() => toggle(sel)}>
                  {count ? "Get ready…" : data.running?.id === sel ? `Stop · ${clock(elapsed)}` : "Start exercise"}
                </Button>
              )}
            </div>
          </div>
          )}
        </Card>
      </div>

      {error && <p className="m-0 rounded-xl bg-alert-bg px-4 py-2 text-sm text-alert-fg">{error}</p>}

        <div className="grid items-start gap-4 lg:grid-cols-3">
          <Card>
            <CardTitle title="Weekly activity" subtitle="Exercise minutes · last 7 days" className="mb-0" />
            <WeekChart week={data.week} goal={data.goal_min} />
          </Card>

          <Card className="border-[#a78bfa]/40 bg-[linear-gradient(135deg,rgba(167,139,250,.14),rgba(79,104,236,.08))]">
            <div className="mb-2 flex items-center gap-2"><Icon name="doctor-ai" size={18} className="text-[#c4b5fd]" /><h3 className="m-0 font-display text-lg font-semibold">Astra recommends</h3></div>
            <AnimatePresence mode="wait">
              <motion.p key={tip} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="m-0 text-sm leading-relaxed text-ink-2">{tip}</motion.p>
            </AnimatePresence>
          </Card>

          <Card>
            <CardTitle title="Exercise history" subtitle="Your latest sessions" className="mb-1" />
            {data.history.length ? (
              <ul className="m-0 flex list-none flex-col p-0">
                {data.history.map((h, i) => (
                  <li key={h.ended_at + i} className="flex items-center justify-between gap-3 border-b border-divider py-3 last:border-0">
                    <span className="flex items-center gap-3">
                      <span className="h-2 w-2 rounded-full bg-accent-text shadow-[0_0_8px_rgba(143,166,255,.8)]" />
                      <span>
                        <span className="block text-sm font-semibold">{h.name}</span>
                        <span className="block text-xs text-muted">{h.minutes} min · {new Date(h.ended_at).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                      </span>
                    </span>
                    <span className="text-[11px] font-bold tracking-wide text-good-fg">COMPLETED</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 py-3 text-sm text-muted">No sessions yet. Press Start exercise on any card, or tap an exercise NFC tag.</p>
            )}
          </Card>
        </div>

      <p className="m-0 px-1 pb-20 text-xs text-muted">
        Sources: {data.sources.map((s, i) => <span key={s.url}>{i ? " · " : ""}<a href={s.url} target="_blank" rel="noreferrer" className="text-accent-text hover:underline">{s.title}</a></span>)}
      </p>
    </>
  );
}
