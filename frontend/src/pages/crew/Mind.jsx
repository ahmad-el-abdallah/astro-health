// Crew · Mind & mood (AstroHealth-Redesign crew-04; port of static/js/tabs/mental_health.js).
// Daily check-in with drawn mood faces (no emoji), wellbeing ring, 7-day mood chart --
// plus the 4-7-8 breathing exercise and private journal the mockup didn't show but the
// app already had (kept, per "don't drop any feature").
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { useAstronautPicker } from "../../auth/AuthProvider.jsx";
import { post } from "../../lib/api.js";
import { fmtTime, MOOD_LABELS, moodScore } from "../../lib/format.js";
import { useHistory, useJournal, useMission } from "../../lib/queries.js";
import { Button, Card, CardTitle, StatusChip, cx } from "../../components/ui/index.jsx";
import { Icon } from "../../components/ui/Icon.jsx";
import { EASE_ENTER } from "../../components/ui/motion.js";
import { RingGauge } from "../../components/charts/RingGauge.jsx";
import { LineChart } from "../../components/charts/LineChart.jsx";
import { useToast } from "../../components/overlays/Toasts.jsx";
import Rough from "../../assets/icons/mood-rough.svg?react";
import Low from "../../assets/icons/mood-low.svg?react";
import Okay from "../../assets/icons/mood-okay.svg?react";
import Good from "../../assets/icons/mood-good.svg?react";
import Great from "../../assets/icons/mood-great.svg?react";

const MOODS = [["rough", "Rough", Rough], ["low", "Low", Low], ["okay", "Okay", Okay], ["good", "Good", Good], ["great", "Great", Great]];
const RISK_TEXT = { HIGH: "text-alert-fg", MEDIUM: "text-check-fg", LOW: "text-good-fg" };

function CheckIn({ astroId }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [mood, setMood] = useState(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  async function log() {
    if (!mood) { toast("Pick a mood first.", "warn"); return; }
    setBusy(true);
    try {
      await post(`/astronauts/${astroId}/mood`, { mood, note: note.trim() });
      toast("Mood logged.", "success");
      setMood(null);
      setNote("");
      ["history", "summary"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    } catch {
      toast("Could not save mood.", "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="flex flex-[2_1_520px] flex-col gap-5">
      <CardTitle eyebrow="Daily check-in" title="How are you feeling right now?" right={<span className="font-mono text-xs text-subtle">01</span>} className="mb-0" />
      <div role="radiogroup" aria-label="Mood" className="grid grid-cols-5 gap-2 max-sm:grid-cols-3">
        {MOODS.map(([id, label, Face]) => {
          const on = mood === id;
          return (
            <motion.button
              key={id}
              role="radio"
              aria-checked={on}
              onClick={() => setMood(id)}
              whileHover={{ y: -3 }}
              whileTap={{ scale: 0.96 }}
              className={cx(
                "flex min-h-24 cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border p-3 transition-colors",
                on ? "border-accent bg-accent-soft" : "border-line bg-input hover:border-accent-text/50",
              )}
            >
              <motion.span animate={{ scale: on ? 1.15 : 1 }} transition={{ type: "spring", stiffness: 400, damping: 15 }}>
                <Face width={36} height={36} aria-hidden="true" />
              </motion.span>
              <span className={cx("text-xs", on ? "font-semibold text-accent-text" : "text-muted")}>{label}</span>
            </motion.button>
          );
        })}
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">What's on your mind? <span className="text-muted">Optional</span></span>
        <textarea className="ah-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Write a short note about how you're feeling…" />
      </label>
      <Button variant="primary" className="w-fit" onClick={log} disabled={busy}>Log mood</Button>
    </Card>
  );
}

function Wellbeing({ rows, mission }) {
  const latest = rows.at(-1);
  const score = latest ? moodScore(latest.value) : null;
  const level = score == null ? "GRAY" : score >= 4 ? "GREEN" : score === 3 ? "YELLOW" : "RED";
  const risk = mission?.health?.body_risks?.brain?.risk;
  return (
    <Card className="flex flex-[1_1_300px] flex-col gap-4">
      <CardTitle eyebrow="Today" title="Wellbeing" right={<StatusChip level={level} text={score ? MOOD_LABELS[score].toUpperCase() : "NO DATA"} plain />} className="mb-0" />
      <div className="flex justify-center"><RingGauge value={score ? Math.round((score / 5) * 100) : null} size={150} ariaLabel="Wellbeing score" /></div>
      <dl className="m-0 text-sm">
        <div className="flex justify-between border-b border-divider py-2.5"><dt className="text-ink-2">Mood</dt><dd className="m-0 font-semibold">{score ? MOOD_LABELS[score] : "–"}</dd></div>
        <div className="flex justify-between py-2.5"><dt className="text-ink-2">Mission risk (mind)</dt><dd className={cx("m-0 font-semibold", RISK_TEXT[risk])}>{risk ? risk[0] + risk.slice(1).toLowerCase() : "–"}</dd></div>
      </dl>
    </Card>
  );
}

function MoodChart({ rows, astroId }) {
  const points = rows.map((r) => ({ t: new Date(r.ts), y: moodScore(r.value), level: r.level })).filter((p) => Number.isFinite(p.y));
  const last = points.at(-1)?.y;
  const prev = points.at(-2)?.y;
  const trend = last == null || prev == null || last === prev ? "→ Stable" : last > prev ? "↗ Improving" : "↘ Lower";
  return (
    <Card className="flex w-full flex-col gap-3">
      <CardTitle eyebrow="Trend" title="Mood over time" subtitle="Last 7 days" right={<span className="rounded-full bg-accent-soft px-2.5 py-1 text-xs text-accent-text">{trend}</span>} className="mb-0" />
      <LineChart
        points={points}
        height={280}
        seriesKey={`mood-${astroId}-${points.length}`}
        startLabel="7 days ago"
        yDomain={[0.5, 5.5]}
        yTicks={[1, 2, 3, 4, 5]}
        formatTick={(t) => MOOD_LABELS[t] || ""}
        formatValue={(v) => MOOD_LABELS[Math.round(v)] || v}
        ariaLabel={`Mood over the last 7 days: ${points.length} check-ins, trend ${trend}`}
      />
    </Card>
  );
}

// 4-7-8 breathing: in 4 s, hold 7 s, out 8 s. The circle grows/holds/shrinks with it.
const STEPS = [["Breathe in", 4, 1.18], ["Hold", 7, 1.18], ["Breathe out", 8, 0.82]];

function Breathing() {
  const [step, setStep] = useState(-1); // -1 ready, 3 done
  const [left, setLeft] = useState(0);
  const timer = useRef(null);
  useEffect(() => () => clearInterval(timer.current), []);
  function start() {
    let i = 0;
    let remaining = STEPS[0][1];
    setStep(0);
    setLeft(remaining);
    clearInterval(timer.current);
    timer.current = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        i += 1;
        if (i >= STEPS.length) { clearInterval(timer.current); setStep(3); return; }
        remaining = STEPS[i][1];
        setStep(i);
      }
      setLeft(remaining);
    }, 1000);
  }
  const running = step >= 0 && step < 3;
  const [label, , scale] = running ? STEPS[step] : [step === 3 ? "Complete" : "Ready", 0, 0.9];
  return (
    <Card className="flex flex-[1_1_300px] flex-col items-center gap-5 text-center">
      <CardTitle eyebrow="Reset" title="4-7-8 breathing" subtitle="Slow down and reset your breathing." className="mb-0 w-full text-left" />
      <motion.div
        animate={{ scale }}
        transition={{ duration: running ? STEPS[step][1] : 0.6, ease: "easeInOut" }}
        className="flex h-40 w-40 flex-col items-center justify-center rounded-full border-2 border-accent-text bg-[radial-gradient(circle,rgb(var(--ah-accent-rgb)/.25),transparent_70%)]"
      >
        <span className="text-xs font-semibold text-accent-text">{label}</span>
        <span className="font-display text-4xl font-bold">{running ? left : step === 3 ? "✓" : "00"}</span>
      </motion.div>
      <Button variant="primary" onClick={start} disabled={running}>{step === 3 ? "Again" : "Start breathing"}</Button>
    </Card>
  );
}

function Journal({ astroId }) {
  const qc = useQueryClient();
  const toast = useToast();
  const journal = useJournal(astroId);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  async function save() {
    if (!title.trim() || !body.trim()) { toast("Title and entry text are both required.", "warn"); return; }
    try {
      await post(`/astronauts/${astroId}/journal`, { title: title.trim(), body: body.trim() });
      setTitle(""); setBody(""); setOpen(false);
      qc.invalidateQueries({ queryKey: ["journal", astroId] });
    } catch {
      toast("Could not save journal entry.", "error");
    }
  }
  const entries = journal.data || [];
  return (
    <Card className="flex flex-[2_1_520px] flex-col gap-4">
      <CardTitle
        eyebrow="Reflection"
        title="Journal"
        subtitle="Write down what's on your mind. Private to you (and the flight surgeon)."
        right={<Button className="min-h-9 px-3 text-[13px]" onClick={() => setOpen((o) => !o)}>{open ? "Cancel" : <><Icon name="plus" size={14} /> Add entry</>}</Button>}
        className="mb-0"
      />
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3, ease: EASE_ENTER }} className="overflow-hidden">
            <div className="flex flex-col gap-2 border-b border-line pb-4">
              <input className="ah-input" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
              <textarea className="ah-input" placeholder="What's on your mind?" value={body} onChange={(e) => setBody(e.target.value)} />
              <Button variant="primary" className="w-fit" onClick={save}>Save entry</Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {entries.length === 0 ? (
        <p className="m-0 py-6 text-center text-sm text-muted">No journal entries yet. Your private thoughts will appear here.</p>
      ) : (
        <ul className="m-0 flex max-h-80 list-none flex-col gap-2 overflow-y-auto p-0">
          <AnimatePresence initial={false}>
            {entries.map((e) => (
              <motion.li key={e.id ?? e.created_at} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex justify-between gap-4 rounded-xl border border-line bg-input p-3">
                <div className="min-w-0"><h4 className="m-0 text-sm font-semibold">{e.title}</h4><p className="m-0 mt-1 text-[13px] whitespace-pre-wrap text-muted">{e.body}</p></div>
                <span className="text-[11px] whitespace-nowrap text-subtle">{fmtTime(e.created_at)}</span>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </Card>
  );
}

export default function Mind() {
  const { id } = useAstronautPicker();
  const history = useHistory(id, "mood", 7);
  const mission = useMission();
  const rows = history.data || [];
  const tip = mission.data?.health?.body_risks?.brain?.why;
  return (
    <>
      <p className="m-0 px-1 text-[15px] text-ink-2">Take a moment to check in with yourself.</p>
      <div className="flex flex-wrap gap-5">
        <CheckIn astroId={id} />
        <Wellbeing rows={rows} mission={mission.data} />
      </div>
      <MoodChart rows={rows} astroId={id} />
      <div className="flex flex-wrap gap-5">
        <Breathing />
        <Journal astroId={id} />
      </div>
      <Card className="flex items-center gap-4 border-l-[3px] border-l-accent-text">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-accent-text/40 text-accent-text"><Icon name="mind" size={17} /></span>
        <div><div className="ah-eyebrow">Self-care tip · this mission</div><p className="m-0 mt-1 text-sm text-ink-2">{tip || "Take a short break, breathe slowly, and give yourself a moment to reset."}</p></div>
      </Card>
    </>
  );
}
