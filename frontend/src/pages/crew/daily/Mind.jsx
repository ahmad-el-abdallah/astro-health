// Crew · Mind & mood (AstroHealth-Redesign crew-04; port of static/js/tabs/mental_health.js).
// Daily mood check: Astra asks 3 questions and the AI judges the mood (mind/DailyMoodCheck.jsx,
// 2026-11-14 -- it replaced the pick-a-face log), wellbeing ring, 7-day mood chart --
// plus the 4-7-8 breathing exercise and private journal the mockup didn't show but the
// app already had (kept, per "don't drop any feature").
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { useAstronautPicker } from "../../../auth/AuthProvider.jsx";
import { post } from "../../../lib/api.js";
import { fmtTime, MOOD_LABELS, moodScore } from "../../../lib/format.js";
import { useHistory, useJournal, useMission, useVoiceTone, useVoiceToneStatus } from "../../../lib/queries.js";
import { countTones, latestTalk, pct, talkMix, TONE_DISCLAIMER, TONE_LABELS, TONE_ORDER, TONE_PRIVACY } from "../../../lib/toneClip.js";
import { useAstra } from "../../../components/AstraProvider.jsx";
import { LatestConversationAnalysis } from "./mind/ConversationAnalysis.jsx";
import { DailyMoodCheck } from "./mind/DailyMoodCheck.jsx";
import { FaceAnalysis } from "./mind/FaceAnalysis.jsx";
import { PoseAnalysis } from "./mind/PoseAnalysis.jsx";
import { Button, Card, CardTitle, StatusChip, TrendLabel, cx } from "../../../components/ui/index.jsx";
import { Icon } from "../../../components/ui/Icon.jsx";
import { EASE_ENTER } from "../../../components/ui/motion.js";
import { RingGauge } from "../../../components/charts/RingGauge.jsx";
import { LineChart } from "../../../components/charts/LineChart.jsx";
import { useToast } from "../../../components/overlays/Toasts.jsx";

const RISK_TEXT = { HIGH: "text-alert-fg", MEDIUM: "text-check-fg", LOW: "text-good-fg" };

function Wellbeing({ rows, mission }) {
  const latest = rows.at(-1);
  const score = latest ? moodScore(latest.value) : null;
  const level = score == null ? "GRAY" : score >= 4 ? "GREEN" : score === 3 ? "YELLOW" : "RED";
  const risk = mission?.health?.body_risks?.brain?.risk;
  return (
    <Card className="flex flex-[1_1_300px] flex-col gap-4">
      <CardTitle title={score ? `Mood today: ${MOOD_LABELS[score]}` : "Mood today"} right={<StatusChip level={level} text={score ? undefined : "No data"} plain />} className="mb-0" />
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
  const trend = last == null || prev == null ? null : last === prev ? "flat" : last > prev ? "up" : "down";
  return (
    <Card className="flex w-full flex-col gap-3">
      <CardTitle title="Mood · last 7 days" right={<TrendLabel direction={trend} text={trend ? undefined : "Not enough check-ins"} />} className="mb-0" />
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
      <CardTitle title="4-7-8 breathing" subtitle="Slow down and reset your breathing." className="mb-0 w-full text-left" />
      <motion.div
        animate={{ scale }}
        transition={{ duration: running ? STEPS[step][1] : 0.6, ease: "easeInOut" }}
        className="flex h-40 w-40 flex-col items-center justify-center rounded-full border-2 border-accent-text bg-[radial-gradient(circle,rgb(var(--ah-accent-rgb)/.25),transparent_70%)]"
      >
        <span className="text-xs font-semibold text-accent-text">{label}</span>
        <span className="ah-num font-display text-4xl font-bold">{running ? left : step === 3 ? <Icon name="tick" size={36} className="animate-[ah-pop_.4s_ease-out]" /> : "00"}</span>
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
        title="Journal"
        subtitle="Write down what's on your mind. Private to you (and the flight surgeon)."
        right={<Button className="min-h-9 px-3 text-label" onClick={() => setOpen((o) => !o)}>{open ? "Cancel" : <><Icon name="plus" size={14} /> Add entry</>}</Button>}
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
                <div className="min-w-0"><h4 className="m-0 text-sm font-semibold">{e.title}</h4><p className="m-0 mt-1 text-label whitespace-pre-wrap text-muted">{e.body}</p></div>
                <span className="text-caption whitespace-nowrap text-subtle">{fmtTime(e.created_at)}</span>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </Card>
  );
}

// "Wanna talk?": a hands-free chat with Astra (her usual voice screen), during which each
// phrase also gets a voice tone ESTIMATE made on this laptop. Shown only here, afterwards, and
// kept apart from the self-reported mood above (own table, own card, never in the mood chart).
const TONE_STATUS_TEXT = {
  ready: "Voice tone estimates are on for this talk.",
  loading: "The voice tone model is still loading…",
  idle: "The voice tone model is still loading…",
};

function WannaTalk({ astroId }) {
  const astra = useAstra();
  const status = useVoiceToneStatus();
  const st = status.data?.state;
  const Recognition = typeof window !== "undefined" ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
  const own = astra.available && Number(astra.astroId) === Number(astroId);
  const why = !own ? "Only the astronaut can start a talk, from their own sign-in."
    : !Recognition ? "Voice needs Chrome or Edge."
    : typeof window !== "undefined" && !window.isSecureContext ? "Voice needs the app opened as http://localhost:5000 (or https)."
    : "";
  return (
    <Card className="flex flex-[1_1_300px] flex-col gap-4">
      <CardTitle eyebrow="Talk it through" title="Wanna talk?" subtitle="A short, hands-free chat with Astra about how you're doing." className="mb-0" />
      <Button variant="primary" className="w-fit" onClick={() => astra.talk()} disabled={!!why}>
        <Icon name="mic" size={16} /> Talk to Astra
      </Button>
      {why && <p className="m-0 text-[13px] text-muted">{why}</p>}
      <p className="m-0 text-[13px] text-ink-2">
        {TONE_STATUS_TEXT[st] || "Voice tone estimates aren’t set up on this laptop. The talk works the same without them."}
      </p>
      <p className="m-0 text-xs text-subtle">{TONE_PRIVACY}</p>
    </Card>
  );
}

function VoiceTone({ astroId }) {
  const tone = useVoiceTone(astroId, 7);
  const rows = tone.data || [];
  const last = latestTalk(rows);
  const week = countTones(rows);
  const max = Math.max(1, ...Object.values(week));
  return (
    <Card className="flex flex-[2_1_520px] flex-col gap-4">
      <CardTitle eyebrow="Voice tone · estimate" title="How your voice sounded" subtitle={TONE_DISCLAIMER} className="mb-0" />
      {!last ? (
        <p className="m-0 py-4 text-center text-sm text-muted">No voice tone estimates yet. They appear here after a “Wanna talk?” chat.</p>
      ) : (
        <>
          <div>
            <div className="text-[13px] text-ink-2">
              Last talk · {fmtTime(last.ts)} · {last.phrases.length} phrase{last.phrases.length === 1 ? "" : "s"} · mostly <span className="font-semibold text-ink">{TONE_LABELS[last.top].toLowerCase()}</span>
            </div>
          </div>
          <div>
            <div className="ah-eyebrow mb-2">Tone mix · last talk</div>
            <dl aria-label="All seven voice tone probabilities, averaged over the last talk" className="m-0 flex flex-col gap-1.5">
              {talkMix(last.phrases).map(({ tone: t, p }) => (
                <div key={t} className="flex items-center gap-3 text-[13px]">
                  <dt className="w-20 text-ink-2">{TONE_LABELS[t]}</dt>
                  <dd className="m-0 h-2 flex-1 overflow-hidden rounded-full bg-raised">
                    <div className="h-full rounded-full bg-accent-text/50" style={{ width: `${p * 100}%` }} />
                  </dd>
                  <span className="w-10 text-right text-subtle">{pct(p)}</span>
                </div>
              ))}
            </dl>
            <details className="mt-3 text-[13px]">
              <summary className="cursor-pointer text-ink-2">Each phrase ({last.phrases.length})</summary>
              <ol aria-label="Voice tone probabilities of each phrase in the last talk" className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
                {last.phrases.map((ph, i) => (
                  <li key={ph.id} className="rounded-xl border border-line bg-input px-3 py-2">
                    <div className="text-ink-2">
                      Phrase {i + 1} · {fmtTime(ph.ts)} · {ph.duration_s} s · most likely <span className="font-semibold text-ink">{TONE_LABELS[ph.label].toLowerCase()}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-subtle">
                      {talkMix([ph]).map(({ tone: t, p }) => <span key={t}>{TONE_LABELS[t]} {pct(p)}</span>)}
                    </div>
                  </li>
                ))}
              </ol>
            </details>
          </div>
          <div>
            <div className="ah-eyebrow mb-2">Most likely tone per phrase · last 7 days · {rows.length} phrase{rows.length === 1 ? "" : "s"}</div>
            <dl className="m-0 flex flex-col gap-1.5">
              {TONE_ORDER.filter((t) => week[t]).map((t) => (
                <div key={t} className="flex items-center gap-3 text-[13px]">
                  <dt className="w-20 text-ink-2">{TONE_LABELS[t]}</dt>
                  <dd className="m-0 h-2 flex-1 overflow-hidden rounded-full bg-raised">
                    <div className="h-full rounded-full bg-accent-text/50" style={{ width: `${(week[t] / max) * 100}%` }} />
                  </dd>
                  <span className="w-6 text-right text-subtle">{week[t]}</span>
                </div>
              ))}
            </dl>
          </div>
        </>
      )}
    </Card>
  );
}

export default function Mind() {
  const { id, locked } = useAstronautPicker(); // locked = a crew member viewing themself
  const history = useHistory(id, "mood", 7);
  const mission = useMission();
  const rows = history.data || [];
  const tip = mission.data?.health?.body_risks?.brain?.why;
  return (
    <>
      <p className="m-0 px-1 text-body text-ink-2">Take a moment to check in with yourself.</p>
      <div className="flex flex-wrap gap-5">
        <DailyMoodCheck astroId={id} />
        <Wellbeing rows={rows} mission={mission.data} />
      </div>
      <MoodChart rows={rows} astroId={id} />
      <div className="flex flex-wrap gap-5">
        <WannaTalk astroId={id} />
        <VoiceTone astroId={id} />
      </div>
      <LatestConversationAnalysis astroId={id} />
      <FaceAnalysis astroId={id} own={!!locked} />
      <PoseAnalysis astroId={id} own={!!locked} />
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
