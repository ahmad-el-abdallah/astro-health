// Crew · Overview (AstroHealth-Redesign crew-01): the home dashboard. Replaces the old
// Live tab (static/js/tabs/live.js) and adds at-a-glance summaries of mood, sleep, trend
// and mission checks, each linking to its full page. Everything here is live: socket
// broadcasts refresh the queries and numbers tween to their new values.
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { useAstronautPicker } from "../../auth/AuthProvider.jsx";
import { get, post } from "../../lib/api.js";
import { fmtTime, formatHours, INDICATORS, MOOD_LABELS, moodScore, sleepHours } from "../../lib/format.js";
import { worstOf } from "../../lib/levels.js";
import { useContent, useHealthRules, useHistory, useMission, useSummary, useSymptomCatalog } from "../../lib/queries.js";
import { useSocketEvent } from "../../lib/socket.js";
import { Avatar, Button, Card, CardTitle, Progress, StatusChip, cx } from "../../components/ui/index.jsx";
import { Icon } from "../../components/ui/Icon.jsx";
import { EASE_ENTER, rise } from "../../components/ui/motion.js";
import { VitalTile } from "../../components/VitalTile.jsx";
import { TrendChart, TREND_INDICATORS } from "../../components/TrendCard.jsx";
import { RingGauge } from "../../components/charts/RingGauge.jsx";
import { StageBar, StageLegend } from "../../components/charts/StageBar.jsx";
import { SymptomReporter } from "../../components/SymptomReporter.jsx";
import { Thread } from "../../components/Thread.jsx";
import { useAuth } from "../../auth/AuthProvider.jsx";
import { STRINGS } from "../../strings.js";
import { AiAnalysisCard } from "../../components/AiAnalysisCard.jsx";

const MAIN_TILES = ["heart_rate", "blood_pressure", "blood_sugar", "temperature", "oxygen_saturation", "sleep", "mood"];
const EXTRA_TILES = ["reaction_time", "exercise", "water"];
const RING = { GREEN: "border-good-fg", YELLOW: "border-check-fg", RED: "border-alert-fg", GRAY: "border-line-strong" };
const RISK_TEXT = { HIGH: "text-alert-fg", MEDIUM: "text-check-fg", LOW: "text-good-fg" };

// "Heart rate and mood need attention. One symptom is flagged for review."
function statusLine(summary) {
  if (summary?.analysis && summary.analysis_current) return summary.analysis.summary; // the AI's own words
  const today = summary?.today || {};
  const flagged = Object.entries(today)
    .filter(([, r]) => r.level === "RED" || r.level === "YELLOW")
    .map(([k]) => (INDICATORS[k]?.label || k).toLowerCase());
  const symptoms = summary?.symptoms_today?.items?.length || 0;
  const parts = [];
  if (flagged.length) {
    const list = flagged.length === 1 ? flagged[0] : `${flagged.slice(0, -1).join(", ")} and ${flagged.at(-1)}`;
    parts.push(`${list.charAt(0).toUpperCase()}${list.slice(1)} ${flagged.length === 1 ? "needs" : "need"} attention.`);
  }
  if (symptoms) parts.push(symptoms === 1 ? "One symptom is flagged for review." : `${symptoms} symptoms are flagged for review.`);
  if (parts.length) return parts.join(" ");
  if (Object.keys(today).length) return "All of today's readings are in the normal range. Keep up your routine.";
  return "No readings yet today. Take a reading below, or tap your card on the CYD.";
}

function Row({ children, className = "" }) {
  return <div className={cx("flex flex-wrap gap-5", className)}>{children}</div>;
}

// ---- status hero ----
// Today's status: the worst of today's readings and any reported symptom. Falls back to
// the last assessment when nothing has been measured today.
function heroLevel(summary) {
  if (summary?.status) return summary.status; // the AI's verdict (or the rules') when it's up to date
  const today = Object.values(summary?.today || {}).map((r) => r.level);
  if (summary?.symptoms_today?.level) today.push(summary.symptoms_today.level);
  return today.length ? worstOf(today) : summary?.overall_level || "GRAY";
}

function Hero({ summary }) {
  const a = summary?.astronaut;
  const level = heroLevel(summary);
  return (
    <Card className="flex flex-[2_1_560px] flex-wrap items-center gap-7 p-7 max-md:gap-5 max-md:p-5">
      <motion.div
        className={cx("rounded-full border-4 p-1.5 transition-colors duration-500", RING[level])}
        animate={level === "RED" ? { scale: [1, 1.03, 1] } : { scale: 1 }}
        transition={level === "RED" ? { duration: 1.6, repeat: Infinity } : undefined}
      >
        <Avatar name={a?.name} color={a?.color} size={96} />
      </motion.div>
      {/* 240px basis: on a phone the text drops under the avatar instead of being squeezed. */}
      <div className="flex min-w-0 flex-[1_1_240px] flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <strong className="text-base">{a?.name}</strong>
          <span className="text-muted">· Overall status</span>
          <StatusChip level={level} />
        </div>
        <AnimatePresence mode="wait">
          <motion.p
            key={statusLine(summary)}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.3 }}
            className="m-0 font-display text-[22px] leading-[1.3] font-semibold tracking-[-0.01em]"
          >
            {statusLine(summary)}
          </motion.p>
        </AnimatePresence>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted">
          <span>Last check <strong className="font-semibold text-ink">{fmtTime(summary?.last_check)}</strong></span>
        </div>
      </div>
    </Card>
  );
}

// ---- reported symptom (or a calm "how are you feeling?" card) ----
function SymptomCard({ summary, onReport }) {
  const catalog = useSymptomCatalog();
  const s = summary?.symptoms_today;
  const labels = (s?.items || []).map((id) => (catalog.data || []).find((c) => c.id === id)?.label || id);

  if (!labels.length) {
    return (
      <Card className="flex flex-[1_1_300px] flex-col gap-3 p-6">
        <div className="flex items-center justify-between">
          <StatusChip level="GREEN" text="Clear" />
          <span className="text-[13px] text-muted">Symptoms</span>
        </div>
        <h2 className="m-0 font-display text-[26px] font-semibold tracking-tight">How are you feeling?</h2>
        <p className="m-0 text-sm text-ink-2">No symptoms reported today. Report anything unusual so Astra and the flight surgeon can help.</p>
        <div className="mt-auto flex flex-wrap gap-2">
          <Button variant="primary" onClick={onReport}>Report a symptom</Button>
          <Link to="/body" className="inline-flex min-h-11 items-center px-2 text-sm font-semibold text-accent-text hover:underline">Talk to Astra</Link>
        </div>
      </Card>
    );
  }

  const red = s.level === "RED";
  return (
    <Card
      className={cx(
        "flex flex-[1_1_300px] flex-col gap-3 p-6",
        red ? "border-alert-border bg-alert-surface" : "border-check-edge/60 bg-[#241f12]",
      )}
    >
      <div className="flex items-center justify-between">
        <StatusChip level={s.level} />
        <span className="text-[13px] text-muted">Reported symptom{labels.length > 1 ? "s" : ""}</span>
      </div>
      <h2 className="m-0 font-display text-[28px] leading-tight font-semibold tracking-tight">{labels[0]}</h2>
      {labels.length > 1 && <p className="m-0 text-sm text-ink-2">Also: {labels.slice(1).join(", ")}</p>}
      <p className="m-0 text-sm text-ink-2">Describe it to Astra or tap your digital twin to get next steps.</p>
      <div className="mt-auto flex flex-wrap items-center gap-2">
        <Link
          to="/body?consult=1"
          className={cx(
            "inline-flex min-h-11 items-center gap-2 rounded-xl px-5 text-sm font-bold text-[#1a0b10] transition hover:brightness-110",
            red ? "bg-alert-action" : "bg-check-fg",
          )}
        >
          Open consultation <Icon name="arrow-right" size={16} />
        </Link>
        <button onClick={onReport} className="min-h-11 cursor-pointer px-2 text-sm font-semibold text-ink-2 hover:text-ink">Report another</button>
      </div>
    </Card>
  );
}

// ---- trend ----
function TrendSection({ astroId }) {
  const [indicator, setIndicator] = useState("heart_rate");
  const [days, setDays] = useState(30);
  return (
    <Card className="flex flex-[2_1_560px] flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="m-0 text-base font-semibold">Trend</h2>
          <p className="m-0 text-[13px] text-muted">Shaded bands show the normal and caution ranges</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Indicator
            <select className="ah-input min-h-10 w-auto bg-control text-sm text-ink" value={indicator} onChange={(e) => setIndicator(e.target.value)}>
              {TREND_INDICATORS.map((k) => <option key={k} value={k}>{INDICATORS[k].label}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Range
            <select className="ah-input min-h-10 w-auto bg-control text-sm text-ink" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
            </select>
          </label>
        </div>
      </div>
      <TrendChart astroId={astroId} indicator={indicator} days={days} height={300} />
    </Card>
  );
}

// ---- wellbeing ----
function Wellbeing({ astroId, mission }) {
  const navigate = useNavigate();
  const history = useHistory(astroId, "mood", 7);
  const rows = history.data || [];
  const latest = rows.at(-1);
  const score = latest ? moodScore(latest.value) : null;
  const prev = rows.length > 1 ? moodScore(rows.at(-2).value) : null;
  const trend = score == null ? "–" : prev == null || score === prev ? "→ Stable" : score > prev ? "↗ Improving" : "↘ Lower";
  const level = score == null ? "GRAY" : score >= 4 ? "GREEN" : score === 3 ? "YELLOW" : "RED";
  const risk = mission?.health?.body_risks?.brain?.risk;
  return (
    <Card className="flex flex-[1_1_300px] flex-col gap-5">
      <CardTitle title="Wellbeing today" right={<StatusChip level={level} text={score ? MOOD_LABELS[score] : "No data"} plain />} className="mb-0" />
      <div className="flex flex-wrap items-center gap-6">
        <RingGauge value={score == null ? null : Math.round((score / 5) * 100)} ariaLabel={`Wellbeing ${score ? Math.round((score / 5) * 100) : "unknown"} percent`} />
        <dl className="m-0 flex min-w-[160px] flex-1 flex-col text-sm">
          <div className="flex justify-between border-b border-divider py-2.5"><dt className="text-ink-2">Mood</dt><dd className="m-0 font-semibold">{score ? MOOD_LABELS[score] : "–"}</dd></div>
          <div className="flex justify-between border-b border-divider py-2.5">
            <dt className="text-ink-2">Mission risk (mind)</dt>
            <dd className={cx("m-0 font-semibold", RISK_TEXT[risk])}>{risk ? risk.charAt(0) + risk.slice(1).toLowerCase() : "–"}</dd>
          </div>
          <div className="flex justify-between py-2.5"><dt className="text-ink-2">7-day trend</dt><dd className="m-0 font-semibold">{trend}</dd></div>
        </dl>
      </div>
      <Button className="mt-auto w-full" onClick={() => navigate("/mind")}>Daily check-in</Button>
    </Card>
  );
}

// ---- take a new reading (port of live.js's vitals form + assess) ----
const FIELDS = [
  { key: "heart_rate", label: "Heart rate", unit: "bpm", placeholder: "e.g. 72" },
  { key: "blood_pressure", label: "Blood pressure", unit: "mmHg" },
  { key: "blood_sugar", label: "Blood sugar, fasting", unit: "mg/dL", placeholder: "e.g. 90" },
  { key: "temperature", label: "Temperature", unit: "°C", placeholder: "e.g. 36.8", step: "0.1" },
  { key: "oxygen_saturation", label: "Blood oxygen (SpO2)", unit: "%", placeholder: "e.g. 98", min: 1, max: 100 },
];

function NewReading({ astroId }) {
  const qc = useQueryClient();
  const content = useContent();
  const [v, setV] = useState({ heart_rate: "", sys: "", dia: "", blood_sugar: "", temperature: "", oxygen_saturation: "" });
  const [guide, setGuide] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setV((s) => ({ ...s, [k]: e.target.value }));

  async function fillSimulated(id = astroId) {
    if (!id) return;
    const s = await get(`/astronauts/${id}/simulate_vitals`);
    setV({
      heart_rate: String(s.heart_rate), sys: String(s.blood_pressure.systolic), dia: String(s.blood_pressure.diastolic),
      blood_sugar: String(s.blood_sugar), temperature: String(s.temperature),
      oxygen_saturation: String(s.oxygen_saturation),
    });
  }

  // Tapping your card on the CYD pre-fills a plausible reading (same as the old Live tab);
  // a human still presses Assess to actually log it.
  useSocketEvent("session_started", (d) => { if (d?.astronaut_id === astroId) fillSimulated(d.astronaut_id); });

  async function assess() {
    if (!astroId) return;
    const body = {};
    if (v.heart_rate) body.heart_rate = Number(v.heart_rate);
    if (v.sys && v.dia) body.blood_pressure = { systolic: Number(v.sys), diastolic: Number(v.dia) };
    if (v.blood_sugar) body.blood_sugar = Number(v.blood_sugar);
    if (v.temperature) body.temperature = Number(v.temperature);
    if (v.oxygen_saturation) body.oxygen_saturation = Number(v.oxygen_saturation);
    if (!Object.keys(body).length) { setResult({ empty: true }); return; }
    setBusy(true);
    try {
      setResult(await post(`/astronauts/${astroId}/assess`, body));
      ["summary", "history", "crew"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    } finally {
      setBusy(false);
    }
  }

  const steps = guide && content.data?.measure_guides?.[guide];
  return (
    <Card className="flex flex-[2_1_560px] flex-col gap-5">
      <CardTitle
        title="Take a new reading"
        subtitle="Enter today's vitals, then assess them against your baseline"
        className="mb-0"
        right={
          <Button variant="ghost" className="min-h-9 px-3 text-[13px]" onClick={() => fillSimulated()}>
            <Icon name="simulator" size={15} /> Use simulated vitals
          </Button>
        }
      />
      <div className="grid gap-x-5 gap-y-4 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]">
        {FIELDS.map((f) => (
          <div key={f.key} className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold">{f.label} <span className="font-normal text-muted">{f.unit}</span></span>
            {f.key === "blood_pressure" ? (
              <div className="flex gap-2">
                <input className="ah-input" type="number" inputMode="numeric" placeholder="Systolic" aria-label="Systolic" value={v.sys} onChange={set("sys")} />
                <input className="ah-input" type="number" inputMode="numeric" placeholder="Diastolic" aria-label="Diastolic" value={v.dia} onChange={set("dia")} />
              </div>
            ) : (
              <input
                className="ah-input"
                type="number"
                step={f.step}
                min={f.min}
                max={f.max}
                inputMode="decimal"
                placeholder={f.placeholder}
                aria-label={f.label}
                value={v[f.key]}
                onChange={set(f.key)}
              />
            )}
            <button
              type="button"
              onClick={() => setGuide((g) => (g === f.key ? null : f.key))}
              aria-expanded={guide === f.key}
              className="w-fit cursor-pointer text-left text-[13px] text-accent-text underline underline-offset-2 hover:text-ink"
            >
              {STRINGS.howToMeasure}
            </button>
          </div>
        ))}
      </div>

      <AnimatePresence initial={false}>
        {steps && (
          <motion.div
            key={guide}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: EASE_ENTER }}
            className="overflow-hidden"
          >
            <div className="rounded-2xl border border-line bg-raised p-4">
              <strong className="text-sm">{steps.title}</strong>
              <ol className="m-0 mt-2 list-decimal space-y-1 pl-5 text-[13px] text-ink-2">
                {steps.steps.map((s, i) => <li key={i}>{s}</li>)}
              </ol>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex flex-wrap items-center gap-4">
        <Button variant="primary" onClick={assess} disabled={busy}>{STRINGS.assessButton}</Button>
        <AnimatePresence mode="wait">
          {result?.overall_level ? (
            <motion.div key="r" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} className="flex flex-wrap items-center gap-2 text-sm">
              <StatusChip level={result.overall_level} label="Quick check" />
              <span className="text-ink-2">{result.note}</span>
              {result.analysis_pending && <span className="text-accent-text">· the AI is analyzing, see the AI card above</span>}
            </motion.div>
          ) : (
            <motion.span key="h" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-[13px] text-muted">
              {result?.empty ? "Enter at least one reading first." : "Results update your status and mission checks"}
            </motion.span>
          )}
        </AnimatePresence>
      </div>
    </Card>
  );
}

// ---- last night's sleep ----
function SleepCard({ summary }) {
  const r = summary?.today?.sleep;
  const v = r && typeof r.value === "object" ? r.value : {};
  return (
    <Card className="flex flex-col gap-3.5">
      <CardTitle title="Last night's sleep" right={<StatusChip level={r?.level || "GRAY"} />} className="mb-0" />
      <div className="flex flex-wrap items-baseline gap-3">
        <span className="font-display text-[34px] leading-none font-bold tracking-tight">{r ? formatHours(sleepHours(r.value)) : "No data"}</span>
        {v.bedtime && <span className="text-sm text-ink-2">{v.bedtime} → {v.wake_time}</span>}
      </div>
      <StageBar />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <StageLegend />
        <span className="text-xs text-muted">Illustrative stages</span>
      </div>
      <Link to="/sleep" className="w-fit text-sm text-accent-text underline underline-offset-2">Log tonight's sleep manually</Link>
    </Card>
  );
}

// ---- mission checks (port of mission.js's monitoring plan, compact) ----
function MissionChecks({ summary, mission, rules }) {
  const plan = mission?.health?.monitoring || [];
  const today = summary?.today || {};
  const done = plan.filter((m) => today[m.indicator]).length;
  const rows = [...plan].sort((a, b) => (today[a.indicator] ? 1 : 0) - (today[b.indicator] ? 1 : 0)).slice(0, 4);
  return (
    <Card className="flex flex-col gap-3.5">
      <CardTitle title="Mission checks" right={<span className="text-[13px] text-muted">{done} of {plan.length} · last 24 h</span>} className="mb-0" />
      <Progress value={plan.length ? done / plan.length : 0} />
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {rows.map((m) => {
          const reading = today[m.indicator];
          return (
            <li key={m.indicator} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold">{rules?.indicators?.[m.indicator]?.label || m.indicator}</div>
                <div className="text-xs text-muted">{m.how_often}{reading ? ` · ${fmtTime(reading.ts)}` : ""}</div>
              </div>
              {reading ? <StatusChip level={reading.level} plain /> : <StatusChip level="GRAY" text="Not measured" plain />}
            </li>
          );
        })}
      </ul>
      <Link to="/mission" className="w-fit text-sm text-accent-text underline underline-offset-2">See all checks in Missions</Link>
    </Card>
  );
}

export default function Overview() {
  const { id } = useAstronautPicker();
  const { isSurgeon } = useAuth();
  const summary = useSummary(id);
  const mission = useMission();
  const rules = useHealthRules();
  const [reporting, setReporting] = useState(false);
  const s = summary.data;
  const today = s?.today || {};
  const extras = EXTRA_TILES.filter((k) => today[k]);

  return (
    <>
      <Row>
        <Hero summary={s} />
        <SymptomCard summary={s} onReport={() => setReporting(true)} />
      </Row>

      <AiAnalysisCard astroId={id} summary={s} />

      <motion.section variants={rise} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-1">
          <h2 className="m-0 text-base font-semibold">Latest readings</h2>
          <span className="text-[13px] text-muted">From CYD sensor and check-ins</span>
        </div>
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(160px,1fr))]">
          {[...MAIN_TILES, ...extras].map((k) => <VitalTile key={k} indicator={k} reading={today[k]} />)}
        </div>
      </motion.section>

      <Row>
        <TrendSection astroId={id} />
        <Wellbeing astroId={id} mission={mission.data} />
      </Row>

      <Row>
        <NewReading astroId={id} />
        <div className="flex flex-[1_1_300px] flex-col gap-5">
          <SleepCard summary={s} />
          <MissionChecks summary={s} mission={mission.data} rules={rules.data} />
        </div>
      </Row>

      {/* Reports to Earth and the Flight Surgeon's replies, on the comms delay. */}
      <Card className="flex flex-col gap-1">
        <CardTitle
          eyebrow="Earth link"
          title={isSurgeon ? `Messages with ${s?.astronaut?.name || "this crew member"}` : "Your Flight Surgeon"}
          subtitle={`Every message waits out the comms delay${mission.data?.profile?.label ? ` (${mission.data.profile.label})` : ""}. Red results and symptom reports are sent automatically.`}
        />
        <Thread astroId={id} name={s?.astronaut?.name || "Crew"} viewer={isSurgeon ? "surgeon" : "crew"} compact />
      </Card>

      <SymptomReporter open={reporting} onClose={() => setReporting(false)} astroId={id} />
    </>
  );
}
