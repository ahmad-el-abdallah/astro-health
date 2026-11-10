// Crew · Sleep lab (AstroHealth-Redesign crew-05; port of static/js/tabs/sleep_lab.js).
// Last night's summary + manual log, the sleep-stage timeline (ILLUSTRATIVE -- no
// hardware here measures stages, and it says so), nightly duration bars, plus the
// circadian (mission context) and sleep-hygiene cards the app already had.
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { useAstronautPicker } from "../../auth/AuthProvider.jsx";
import { post } from "../../lib/api.js";
import { formatHours, sleepHours } from "../../lib/format.js";
import { useHistory, useMission, useSummary } from "../../lib/queries.js";
import { Button, Card, CardTitle, Segmented, StatusChip } from "../../components/ui/index.jsx";
import { EASE_ENTER } from "../../components/ui/motion.js";
import { BarChart } from "../../components/charts/BarChart.jsx";
import { STAGE_COLORS, STAGE_SEGMENTS } from "../../components/charts/StageBar.jsx";
import { useToast } from "../../components/overlays/Toasts.jsx";

const ROWS = [["awake", "Awake"], ["rem", "REM"], ["light", "Light"], ["deep", "Deep"]];

function StageTimeline() {
  const blocks = STAGE_SEGMENTS.map((s, i) => ({ ...s, start: STAGE_SEGMENTS.slice(0, i).reduce((a, x) => a + x.pct, 0) }));
  return (
    <div className="flex flex-col gap-2" role="img" aria-label="Illustrative sleep stages from 23:00 to 07:00 (not measured)">
      {ROWS.map(([stage, label], r) => (
        <div key={stage} className="flex items-center gap-3">
          <span className="w-12 text-xs text-muted">{label}</span>
          <div className="relative h-5 flex-1 rounded-md bg-input">
            {blocks.filter((b) => b.stage === stage).map((b, i) => (
              <motion.span
                key={i}
                className="absolute top-0 h-full origin-left rounded-[4px]"
                style={{ left: `${b.start}%`, width: `${b.pct}%`, background: STAGE_COLORS[stage] }}
                initial={{ scaleX: 0, opacity: 0 }}
                animate={{ scaleX: 1, opacity: 1 }}
                transition={{ delay: 0.15 + r * 0.08 + b.start / 300, duration: 0.5, ease: EASE_ENTER }}
              />
            ))}
          </div>
        </div>
      ))}
      <div className="ml-[60px] flex justify-between text-[11px] text-subtle">
        {["23:00", "01:00", "03:00", "05:00", "07:00"].map((t) => <span key={t}>{t}</span>)}
      </div>
    </div>
  );
}

function Summary({ astroId, summary }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [bed, setBed] = useState("23:00");
  const [wake, setWake] = useState("07:00");
  const r = summary?.today?.sleep;
  const v = r && typeof r.value === "object" ? r.value : {};
  async function save() {
    try {
      await post(`/astronauts/${astroId}/sleep`, { bedtime: bed, wake_time: wake });
      toast("Sleep logged.", "success");
      setOpen(false);
      ["summary", "history"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    } catch {
      toast("Could not log sleep.", "error");
    }
  }
  return (
    <Card className="flex flex-[1_1_320px] flex-col gap-4">
      <CardTitle eyebrow="Last night" title="Summary" className="mb-0" />
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-display text-[52px] leading-none font-bold tracking-[-0.03em]">{r ? formatHours(sleepHours(r.value)) : "No data"}</span>
        {r && <StatusChip level={r.level} />}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-raised p-3"><div className="text-xs text-muted">Bedtime</div><div className="mt-1 text-lg font-semibold">{v.bedtime || "–"}</div></div>
        <div className="rounded-xl bg-raised p-3"><div className="text-xs text-muted">Wake</div><div className="mt-1 text-lg font-semibold">{v.wake_time || "–"}</div></div>
      </div>
      <button onClick={() => setOpen((o) => !o)} className="w-fit cursor-pointer text-sm text-accent-text underline underline-offset-2">
        {open ? "Cancel" : "Log tonight's sleep manually"}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3, ease: EASE_ENTER }} className="overflow-hidden">
            <div className="flex flex-wrap items-end gap-3 border-t border-line pt-4">
              <label className="flex flex-col gap-1 text-xs text-muted">Bedtime<input type="time" className="ah-input w-36" value={bed} onChange={(e) => setBed(e.target.value)} /></label>
              <label className="flex flex-col gap-1 text-xs text-muted">Wake time<input type="time" className="ah-input w-36" value={wake} onChange={(e) => setWake(e.target.value)} /></label>
              <Button variant="primary" onClick={save}>Save</Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}

export default function Sleep() {
  const { id } = useAstronautPicker();
  const summary = useSummary(id);
  const mission = useMission();
  const [days, setDays] = useState(7);
  const history = useHistory(id, "sleep", days);
  const bars = (history.data || []).map((r) => {
    const t = new Date(r.ts);
    return { y: sleepHours(r.value), level: r.level, label: t.toLocaleDateString(), short: t.toLocaleDateString(undefined, { weekday: "short" }) };
  }).filter((b) => Number.isFinite(b.y));
  const brain = mission.data?.health?.body_risks?.brain;
  const monitor = mission.data?.health?.monitoring?.find((m) => m.indicator === "sleep");

  return (
    <>
      <p className="m-0 px-1 text-[15px] text-ink-2">Sleep trends and how microgravity affects your circadian rhythm.</p>
      <div className="flex flex-wrap gap-5">
        <Summary astroId={id} summary={summary.data} />
        <Card className="flex flex-[2_1_520px] flex-col gap-4">
          <CardTitle eyebrow="Illustrative" title="Sleep stages" subtitle="Not measured by any hardware in this demo — for reference only" className="mb-0" />
          <StageTimeline />
        </Card>
      </div>
      <Card className="flex flex-col gap-4">
        <CardTitle
          eyebrow="Trend"
          title="Sleep duration"
          subtitle={`Hours per night · last ${days} nights`}
          right={<Segmented id="sleep-range" size="sm" value={days} onChange={setDays} options={[{ value: 7, label: "7 nights" }, { value: 30, label: "30 nights" }]} />}
          className="mb-0"
        />
        <BarChart bars={bars} height={280} target={7} targetLabel="Target 7 h" seriesKey={`sleep-${id}-${days}`} formatValue={formatHours} maxY={9} ariaLabel={`Hours slept per night, ${bars.length} nights`} />
      </Card>
      <div className="flex flex-wrap gap-5">
        <Card className="flex flex-[1_1_360px] flex-col gap-2">
          <CardTitle eyebrow="Mission context" title="Circadian rhythm" className="mb-0" />
          <p className="m-0 text-sm text-ink-2">
            {brain ? <><strong className="text-ink">{mission.data.profile.label} — {brain.risk.toLowerCase()} risk.</strong> {brain.why}</> : "No mission health plan for this profile yet."}
          </p>
          {monitor && <p className="m-0 text-sm text-muted">Monitoring: {monitor.how_often} — {monitor.why}</p>}
        </Card>
        <Card className="flex flex-[1_1_360px] flex-col gap-2">
          <CardTitle eyebrow="Self-care" title="Sleep hygiene tips" className="mb-0" />
          <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-sm text-ink-2">
            <li>Keep lighting dim for the last hour before sleep.</li>
            <li>Stick to the same sleep and wake time, even on rest days.</li>
            <li>Avoid caffeine after your mission's midday mark.</li>
            <li>Exercise earlier in your day, not right before sleep.</li>
          </ul>
        </Card>
      </div>
    </>
  );
}
