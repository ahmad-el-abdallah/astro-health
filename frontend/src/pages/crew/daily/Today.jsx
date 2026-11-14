// Crew · Today -- the hub of the "Daily check-ins" section (it was the Schedule page; /schedule
// still redirects here). Port of static/js/tabs/schedule.js, grown into a real daily planner:
// - a live 24-hour mission clock (the app runs on a sped-up clock, TIME_SCALE -- by default
//   one real minute is one mission hour) with every task marked on the dial;
// - "Up next" with a countdown in mission time AND real time;
// - today's timeline, where each task's status (done / due now / missed / upcoming) comes
//   from what this astronaut actually logged (backend/jobs/scheduler.py), with a shortcut
//   to wherever that task gets done.
// - one-tap actions: workouts and sleep tracking start/stop right here (POST /activity, the
//   same timers as the NFC tags and Astra), the rest link to where they're done;
// - a "Face check · coming soon" card: the next daily check-in (every 2 hours, interval set
//   on /admin), not built yet.
// Reminders (the "reminder" broadcast) flash the matching task and refresh the statuses.
import { withLiveStatus } from "../../../lib/schedule.js";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { post } from "../../../lib/api.js";
import { useToast } from "../../../components/overlays/Toasts.jsx";
import { AnimatePresence, motion } from "motion/react";
import { useAuth, useAstronautPicker } from "../../../auth/AuthProvider.jsx";
import { useSchedule } from "../../../lib/queries.js";
import { useSocketEvent } from "../../../lib/socket.js";
import { LEVEL_HEX } from "../../../lib/levels.js";
import { AnimatedNumber, Button, Card, CardTitle, Progress, Shimmer, StatusChip, cx } from "../../../components/ui/index.jsx";
import { Icon } from "../../../components/ui/Icon.jsx";
import { EASE_ENTER } from "../../../components/ui/motion.js";

const DAY = 86400;
const KIND_ICON = { vitals: "heart", exercise: "exercise", mood: "mood", sleep: "sleep" };
const HOWTO = {
  vitals: { hint: "Take a new reading on Overview, or log one on your digital twin.", to: "/", cta: "Take reading" },
  exercise: { hint: "Start it here, tap the exercise tag on the CYD, or tell Astra “start my workout”." },
  mood: { hint: "Check in on Mind & mood, or use Mood on the CYD.", to: "/mind", cta: "Check in" },
  sleep: { hint: "Start sleep tracking here at bedtime, tap the sleep tag, or log the night in the Sleep lab.", to: "/sleep", cta: "Log sleep" },
};
const STATUS = {
  done: { level: "GREEN", text: (e) => `Done ${e.done_at}`, color: LEVEL_HEX.GREEN },
  due: { level: "YELLOW", text: () => "Due now", color: LEVEL_HEX.YELLOW },
  missed: { level: "RED", text: () => "Missed", color: LEVEL_HEX.RED },
  upcoming: { level: "GRAY", text: () => "Upcoming", color: "var(--ah-accent-text)" },
};

const hhmm = (s) => {
  const t = ((Math.floor(s / 60) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};
function missionSpan(seconds) {
  const m = Math.max(0, Math.round(seconds / 60));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}
function realSpan(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
}

// The mission clock, ticking locally between fetches: server time at fetch + elapsed real
// time × TIME_SCALE. `total` never wraps, so the dial's hand only ever turns forward.
function useMissionClock(plan, fetchedAt) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!plan) return null;
  const total = (plan.day - 1) * DAY + plan.day_seconds + (Math.max(0, now - fetchedAt) / 1000) * plan.time_scale;
  return { total, daySec: total % DAY, day: Math.floor(total / DAY) + 1, scale: plan.time_scale };
}

// ---- 24-hour dial ----
const SIZE = 280, C = SIZE / 2, R = 112;
const polar = (deg, r) => [C + r * Math.sin((deg * Math.PI) / 180), C - r * Math.cos((deg * Math.PI) / 180)];

function Dial({ clock, entries }) {
  const [settled, setSettled] = useState(false);
  const deg = (clock.total / DAY) * 360;
  const frac = clock.daySec / DAY;
  return (
    <div className="relative mx-auto aspect-square w-full max-w-[300px]">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="h-full w-full" role="img" aria-label={`Mission clock ${hhmm(clock.daySec)}, day ${clock.day}`}>
        <circle cx={C} cy={C} r={R + 18} fill="rgba(255,255,255,.025)" stroke="var(--ah-glass-edge)" />
        <circle cx={C} cy={C} r={R} fill="none" stroke="var(--color-line-strong)" strokeWidth="6" opacity=".55" />
        {/* elapsed part of the day */}
        <motion.circle
          cx={C} cy={C} r={R} fill="none" stroke="var(--ah-accent-text)" strokeWidth="6" strokeLinecap="round"
          transform={`rotate(-90 ${C} ${C})`} opacity=".85"
          initial={{ pathLength: 0 }} animate={{ pathLength: frac }}
          transition={settled ? { duration: 1, ease: "linear" } : { duration: 1.2, ease: EASE_ENTER }}
        />
        {Array.from({ length: 24 }, (_, h) => {
          const major = h % 6 === 0;
          const [x1, y1] = polar(h * 15, R + 9);
          const [x2, y2] = polar(h * 15, R + (major ? 17 : 13));
          return <line key={h} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--ah-text-subtle)" strokeWidth={major ? 2 : 1} opacity={major ? 0.9 : 0.45} />;
        })}
        {[0, 6, 12, 18].map((h) => {
          const [x, y] = polar(h * 15, R - 20);
          return <text key={h} x={x} y={y + 4} textAnchor="middle" fontSize="11" fontWeight="600" fill="var(--ah-text-subtle)">{String(h).padStart(2, "0")}</text>;
        })}
        {/* task markers */}
        {entries.map((e, i) => {
          const [x, y] = polar((e.seconds / DAY) * 360, R);
          const color = STATUS[e.status]?.color;
          return (
            <g key={e.time + e.kind}>
              {e.status === "due" && (
                <motion.circle
                  cx={x} cy={y} r="13" fill="none" stroke={color} strokeWidth="2"
                  animate={{ scale: [1, 1.5], opacity: [0.8, 0] }}
                  transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
                />
              )}
              <motion.circle
                cx={x} cy={y} r="7" fill="var(--ah-surface-1)" stroke={color} strokeWidth="3"
                initial={{ scale: 0 }} animate={{ scale: 1 }}
                transition={{ delay: 0.3 + i * 0.07, type: "spring", stiffness: 420, damping: 20 }}
              >
                <title>{`${e.time} ${e.text}`}</title>
              </motion.circle>
            </g>
          );
        })}
        {/* hand: the transparent disc makes the group's box the whole dial, so it turns around the center */}
        <motion.g
          initial={{ rotate: 0 }}
          animate={{ rotate: deg }}
          transition={settled ? { duration: 1, ease: "linear" } : { duration: 1.2, ease: EASE_ENTER }}
          onAnimationComplete={() => setSettled(true)}
        >
          <circle cx={C} cy={C} r={C} fill="transparent" />
          {/* outer segment only, so the time readout in the middle stays clear */}
          <line x1={C} y1={C - 64} x2={C} y2={C - R + 6} stroke="var(--ah-text)" strokeWidth="2.5" strokeLinecap="round" />
          <circle cx={C} cy={C - R} r="5.5" fill="var(--ah-text)" stroke="var(--ah-accent)" strokeWidth="2.5" />
        </motion.g>
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-display text-hero leading-none font-bold tabular-nums tracking-tight">{hhmm(clock.daySec)}</span>
        <span className="mt-1 text-xs text-muted">Mission day {clock.day}</span>
      </div>
    </div>
  );
}

function ClockCard({ clock, entries }) {
  return (
    <Card className="flex flex-col gap-3">
      <CardTitle title="Station time" />
      <Dial clock={clock} entries={entries} />
      <div className="flex flex-wrap justify-center gap-x-4 gap-y-1.5 text-xs text-muted">
        {["done", "due", "missed", "upcoming"].map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full border-2" style={{ borderColor: STATUS[s].color }} />
            {s === "due" ? "Due now" : s[0].toUpperCase() + s.slice(1)}
          </span>
        ))}
      </div>
      <p className="m-0 text-center text-xs text-muted">
        Sped up for the demo: 1 real minute = {missionSpan(60 * clock.scale)} on the mission clock.
      </p>
    </Card>
  );
}

function UpNext({ clock, entries, canAct }) {
  const navigate = useNavigate();
  // the next task still to do (one done early -- e.g. a finished wearable test -- is skipped)
  const next = entries.find((e) => e.seconds > clock.daySec && e.status !== "done") || entries[0];
  const delta = next.seconds > clock.daySec ? next.seconds - clock.daySec : DAY - clock.daySec + next.seconds;
  const tomorrow = next.seconds <= clock.daySec;
  const howto = HOWTO[next.kind] || {};
  return (
    <Card className="relative overflow-hidden">
      <div className="relative flex flex-wrap items-center gap-5">
        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-accent-text">
          <Icon name={KIND_ICON[next.kind] || "schedule"} size={26} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="ah-eyebrow mb-1">Up next{tomorrow ? " · tomorrow" : ""} · {next.time}</div>
          <AnimatePresence mode="wait">
            <motion.h2
              key={next.time + next.kind}
              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.3 }}
              className="m-0 font-display text-heading leading-tight font-semibold"
            >
              {next.text}
            </motion.h2>
          </AnimatePresence>
          <p className="m-0 mt-1 text-sm text-muted">{howto.hint}</p>
        </div>
        <div className="flex flex-col items-end">
          <span className="font-display text-display leading-none font-bold tabular-nums">in {missionSpan(delta)}</span>
          <span className="mt-1 text-xs text-muted">≈ {realSpan(delta / clock.scale)} real time</span>
        </div>
      </div>
      {canAct && howto.to && (
        <div className="relative mt-4 flex justify-end">
          <Button onClick={() => navigate(howto.to)}>
            Do it early <Icon name="arrow-right" size={16} />
          </Button>
        </div>
      )}
    </Card>
  );
}

function ProgressCard({ entries }) {
  const done = entries.filter((e) => e.status === "done").length;
  const due = entries.filter((e) => e.status === "due").length;
  const missed = entries.filter((e) => e.status === "missed").length;
  return (
    <Card className="flex flex-col gap-4">
      {/* The headline is the fact itself: how much of today is done. */}
      <h2 className="m-0 flex items-baseline gap-2 font-display">
        <AnimatedNumber value={done} className="text-hero leading-none font-bold" />
        <span className="text-title font-semibold text-ink-2">of {entries.length} done today</span>
      </h2>
      <Progress value={entries.length ? done / entries.length : 0} />
      <div className="grid grid-cols-3 gap-2 text-xs">
        {[["Done", done, "text-good-fg"], ["Due now", due, "text-check-fg"], ["Missed", missed, "text-alert-fg"]].map(([label, n, cls]) => (
          <div key={label} className="rounded-[var(--radius-inner)] bg-raised p-2.5">
            <div className="text-muted">{label}</div>
            <div className={cx("mt-1 text-lg font-semibold", cls)}><AnimatedNumber value={n} /></div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function NowMarker({ clock }) {
  return (
    <motion.li layout="position" transition={{ type: "spring", stiffness: 260, damping: 30 }} className="flex items-center gap-3 py-1" aria-label={`Now, ${hhmm(clock.daySec)}`}>
      <span className="w-14 text-right text-xs font-bold text-accent-text tabular-nums">{hhmm(clock.daySec)}</span>
      <span className="relative flex w-5 justify-center">
        <span className="h-3 w-3 rounded-full bg-accent shadow-[0_0_0_4px_rgb(var(--ah-accent-rgb)/.25)]" />
      </span>
      <span className="h-px flex-1 bg-gradient-to-r from-accent-text/70 to-transparent" />
      <span className="text-caption font-semibold tracking-[0.1em] text-accent-text uppercase">Now</span>
    </motion.li>
  );
}

// Start / stop a workout or sleep tracking right here (the same timers as the NFC tags).
function TrackButton({ kind, running, astroId }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const label = kind === "exercise"
    ? (running ? `Stop workout · ${running.mission_min} min` : "Start workout")
    : (running ? "I’m awake" : "Start sleep tracking");
  async function go() {
    setBusy(true);
    try {
      const r = await post(`/astronauts/${astroId}/activity`, { kind, action: running ? "stop" : "start" });
      if (running) toast(kind === "exercise" ? `Workout logged: ${r.minutes} min.` : `Sleep logged: ${r.hours} h.`, "success");
      else toast(kind === "exercise" ? "Workout started." : "Sleep tracking started. Good night.", "success");
      qc.invalidateQueries({ queryKey: ["schedule"] });
    } catch {
      toast("That didn’t work, please try again.", "warn");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button variant={running ? "secondary" : "primary"} className="min-h-10 px-3.5 text-label" onClick={go} busy={busy}>
      {!busy && <Icon name={kind === "exercise" ? "exercise" : "sleep"} size={16} />} {label}
    </Button>
  );
}

// Which row of each kind gets the running workout/sleep: the one due or missed now, else
// the next one coming up -- never every row of that kind.
export function trackingRows(entries) {
  const rows = {};
  for (const kind of ["exercise", "sleep"]) {
    const pick = entries.find((e) => e.kind === kind && (e.status === "due" || e.status === "missed"))
      || entries.find((e) => e.kind === kind && e.status === "upcoming");
    if (pick) rows[kind] = pick.time;
  }
  return rows;
}

function TaskRow({ entry, last, flash, canAct, tracking = {}, astroId, trackRow }) {
  const navigate = useNavigate();
  const st = STATUS[entry.status] || STATUS.upcoming;
  const howto = HOWTO[entry.kind] || {};
  const open = entry.status === "due" || entry.status === "missed";
  const trackable = entry.kind === "exercise" || entry.kind === "sleep";
  const running = trackable && trackRow === entry.time ? tracking[entry.kind] : null;
  return (
    <motion.li layout="position" transition={{ type: "spring", stiffness: 260, damping: 30 }} className="relative flex gap-3">
      <span className={cx("w-14 pt-3.5 text-right text-sm font-semibold tabular-nums", entry.status === "done" ? "text-muted" : "text-ink")}>{entry.time}</span>
      <span className="relative flex w-5 flex-col items-center">
        <span className="mt-4 h-3.5 w-3.5 shrink-0 rounded-full border-[3px] bg-surface transition-colors duration-500" style={{ borderColor: st.color }} />
        {!last && <span className="mt-1 w-px flex-1 bg-line-strong" />}
      </span>
      <div className="relative mb-2.5 flex min-w-0 flex-1 flex-wrap items-center gap-3 rounded-[var(--radius-inner)] bg-raised p-3.5">
        <AnimatePresence>
          {flash && (
            <motion.span
              className="pointer-events-none absolute inset-0 rounded-2xl border-2 border-accent-text"
              initial={{ opacity: 0 }} animate={{ opacity: [0, 1, 0.3, 1, 0] }} exit={{ opacity: 0 }}
              transition={{ duration: 2.4 }}
            />
          )}
        </AnimatePresence>
        <span className={cx("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", entry.status === "done" ? "bg-good-bg text-good-fg" : "bg-accent-soft text-accent-text")}>
          <Icon name={entry.status === "done" ? "tick" : KIND_ICON[entry.kind] || "schedule"} size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className={cx("text-body font-semibold", entry.status === "done" && "text-ink-2")}>{entry.text}</div>
          <div className="text-xs text-muted">{howto.hint}</div>
        </div>
        <StatusChip level={st.level} text={st.text(entry)} plain={entry.status === "upcoming"} />
        {canAct && trackable && (open || running) && <TrackButton kind={entry.kind} running={running} astroId={astroId} />}
        {canAct && open && howto.to && !running && (
          <Button variant={trackable ? "secondary" : "primary"} className="min-h-10 px-3.5 text-label" onClick={() => navigate(howto.to)}>
            {howto.cta}
          </Button>
        )}
      </div>
    </motion.li>
  );
}

function Timeline({ clock, entries, flash, canAct, tracking, astroId }) {
  const nowIndex = entries.findIndex((e) => e.seconds > clock.daySec);
  const at = nowIndex === -1 ? entries.length : nowIndex;
  const rows = trackingRows(entries);
  return (
    <Card>
      <CardTitle title="Today’s tasks" subtitle="Each task is checked off from what was actually logged in its time window." />
      {/* One flat, keyed list, so the "Now" line glides into its new slot as tasks pass. */}
      <ol className="m-0 list-none p-0">
        {entries.flatMap((e, i) => [
          ...(i === at ? [<NowMarker key="now" clock={clock} />] : []),
          <TaskRow key={e.time + e.kind} entry={e} last={i === entries.length - 1 && at !== entries.length} flash={flash === e.time} canAct={canAct} tracking={tracking} astroId={astroId} trackRow={rows[e.kind]} />,
        ])}
        {at === entries.length && <NowMarker key="now" clock={clock} />}
      </ol>
    </Card>
  );
}

// The next daily check-in, not built yet: a face-expression check every 2 hours (interval set
// on /admin) that tells tiredness or stress. It will become a task in the list above.
function FaceCheckSoon() {
  return (
    <Card className="flex items-start gap-4 opacity-75" aria-label="Face check, coming soon">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-inner)] bg-raised text-muted">
        <Icon name="user" size={20} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-body font-semibold">Face check</span>
          <span className="rounded-full border border-line-strong px-2 py-0.5 text-caption font-semibold tracking-[0.06em] text-muted uppercase">Coming soon</span>
        </div>
        <p className="m-0 text-sm text-muted">Every 2 hours, a quick look at your expression to spot tiredness or stress.</p>
      </div>
    </Card>
  );
}

export default function Today() {
  const { isSurgeon } = useAuth();
  const { id } = useAstronautPicker();
  const q = useSchedule(id);
  const clock = useMissionClock(q.data, q.dataUpdatedAt);
  const [flash, setFlash] = useState(null);

  useSocketEvent("reminder", (d) => {
    setFlash(d?.time || null);
    setTimeout(() => setFlash(null), 3000);
  });

  const daySec = clock?.daySec ?? 0;
  const entries = useMemo(() => withLiveStatus(q.data?.entries || [], daySec), [q.data, daySec]);

  if (!clock || !entries.length) {
    return (
      <div className="grid gap-[18px] xl:grid-cols-[minmax(320px,400px)_minmax(0,1fr)]">
        <Shimmer className="h-[440px]" />
        <Shimmer className="h-[440px]" />
      </div>
    );
  }
  return (
    <div className="grid items-start gap-[18px] xl:grid-cols-[minmax(320px,400px)_minmax(0,1fr)]">
      <div className="flex flex-col gap-[18px]">
        <ClockCard clock={clock} entries={entries} />
        <ProgressCard entries={entries} />
        <FaceCheckSoon />
      </div>
      <div className="flex min-w-0 flex-col gap-[18px]">
        <UpNext clock={clock} entries={entries} canAct={!isSurgeon} />
        <Timeline clock={clock} entries={entries} flash={flash} canAct={!isSurgeon} tracking={q.data?.tracking || {}} astroId={id} />
      </div>
    </div>
  );
}
