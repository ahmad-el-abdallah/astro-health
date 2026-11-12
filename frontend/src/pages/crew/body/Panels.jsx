// The Body dashboard's side panels, laid out like the user's reference image: patient
// card + selected-region card on the left, lab-style tiles with dot sparklines on the
// right, a 7-day timeline along the bottom.
import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { post } from "../../../lib/api.js";
import { fmtTime, formatIndicatorValue, INDICATORS, numericValue } from "../../../lib/format.js";
import { LEVEL_HEX, LEVEL_WORD, worstOf } from "../../../lib/levels.js";
import { Avatar, Button, Card, StatusChip, cx } from "../../../components/ui/index.jsx";
import { Icon } from "../../../components/ui/Icon.jsx";
import { EASE_ENTER } from "../../../components/ui/motion.js";
import { Sparkline } from "../../../components/charts/Sparkline.jsx";
import { TILE_ICON } from "../../../components/VitalTile.jsx";
import { STRINGS } from "../../../strings.js";

export const LAB_INDICATORS = ["heart_rate", "blood_pressure", "blood_sugar", "temperature", "oxygen_saturation", "sleep", "mood"];

export function toPoints(indicator, rows = []) {
  return rows
    .map((r) => ({ t: new Date(r.ts), y: numericValue(indicator, r.value), level: r.level }))
    .filter((p) => Number.isFinite(p.y));
}

// ---- left: who this is ----
export function ProfileCard({ summary, mission, level }) {
  const a = summary?.astronaut;
  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-center gap-3.5">
        <div className={cx("rounded-full border-[3px] p-1", { GREEN: "border-good-fg", YELLOW: "border-check-fg", RED: "border-alert-fg" }[level] || "border-line-strong")}>
          <Avatar name={a?.name} color={a?.color} size={52} />
        </div>
        <div className="min-w-0">
          <div className="truncate font-display text-xl font-semibold">{a?.name || "–"}</div>
          <div className="text-xs text-muted">{a?.role}</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-xl bg-raised p-2.5"><div className="text-muted">Status</div><div className="mt-1"><StatusChip level={level} /></div></div>
        <div className="rounded-xl bg-raised p-2.5"><div className="text-muted">Mission</div><div className="mt-1 truncate text-sm font-semibold">{mission?.profile?.label || "–"}</div></div>
        <div className="col-span-2 rounded-xl bg-raised p-2.5"><div className="text-muted">Last check</div><div className="mt-1 text-sm font-semibold">{fmtTime(summary?.last_check)}</div></div>
      </div>
    </Card>
  );
}

// ---- left: the selected region (port of body.js renderSelected) ----
export function RegionCard({ region, info, level, discomfort, onDraft, onCommit, today, history, anyRed, astroId, onAnalyze, toast }) {
  const [aboutOpen, setAboutOpen] = useState(true);
  const [sending, setSending] = useState(false);
  if (!region || !info) {
    return (
      <Card className="flex flex-col gap-2">
        <div className="ah-eyebrow">Digital twin</div>
        <h2 className="m-0 font-display text-lg font-semibold">Tap a body part</h2>
        <p className="m-0 text-sm text-muted">Select a region on the twin or from the chips above to see its status, rate any discomfort and learn how space affects it.</p>
        <Button className="mt-2" onClick={onAnalyze}>Analyze symptoms</Button>
      </Card>
    );
  }
  const readings = (info.indicators || []).map((ind) => today?.[ind] && `${INDICATORS[ind]?.label || ind}: ${formatIndicatorValue(ind, today[ind].value)}`).filter(Boolean);
  const firstInd = info.indicators?.[0];

  async function sendReport() {
    setSending(true);
    try {
      const r = await post(`/astronauts/${astroId}/discomfort/report`);
      toast(`Report sent to the flight surgeon (${(r.danger_regions || []).join(", ")}).`, "success");
    } catch {
      toast("Could not send the report.", "error");
    } finally {
      setSending(false);
    }
  }

  return (
    <Card className="flex flex-col gap-4">
      <AnimatePresence mode="wait">
        <motion.div key={region} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 8 }} transition={{ duration: 0.22 }} className="flex flex-col gap-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="ah-eyebrow">Selected region</div>
              <h2 className="m-0 font-display text-xl font-semibold">{info.label}</h2>
            </div>
            <StatusChip level={level} />
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between text-[13px]">
              <span className="text-ink-2">Discomfort</span>
              <motion.span key={discomfort} initial={{ scale: 1.25 }} animate={{ scale: 1 }} className="min-w-10 rounded-lg border border-line-strong bg-input px-2 py-0.5 text-center font-display text-base font-bold text-accent-text">
                {discomfort}
              </motion.span>
            </div>
            <input
              type="range"
              min="0"
              max="10"
              value={discomfort}
              aria-label={`Discomfort in ${info.label}, 0 to 10`}
              onChange={(e) => onDraft(Number(e.target.value))}
              onPointerUp={(e) => onCommit(Number(e.currentTarget.value))}
              onKeyUp={(e) => onCommit(Number(e.currentTarget.value))}
              className="w-full accent-[var(--ah-accent)]"
            />
            <div className="flex justify-between text-[10px] tracking-[0.08em] text-subtle"><span>NONE</span><span>MODERATE</span><span>SEVERE</span></div>
          </div>

          {firstInd && (
            <div className="rounded-xl bg-raised p-3">
              <div className="mb-1 flex justify-between text-xs text-muted"><span>{INDICATORS[firstInd]?.label} · 7 days</span></div>
              <Sparkline points={toPoints(firstInd, history?.[firstInd])} seriesKey={`${region}-${firstInd}`} ariaLabel={`${INDICATORS[firstInd]?.label} over 7 days`} />
            </div>
          )}

          <div className="rounded-xl border border-line">
            <button onClick={() => setAboutOpen((o) => !o)} aria-expanded={aboutOpen} className="flex w-full cursor-pointer items-center justify-between px-3.5 py-3 text-sm font-semibold text-accent-text">
              About this part
              <motion.span animate={{ rotate: aboutOpen ? 180 : 0 }}>⌄</motion.span>
            </button>
            <AnimatePresence initial={false}>
              {aboutOpen && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.28, ease: EASE_ENTER }} className="overflow-hidden">
                  <div className="flex flex-col gap-2 px-3.5 pb-3.5 text-[13px] text-ink-2">
                    <p className="m-0 font-medium text-ink">{readings.length ? readings.join(" · ") : "No readings logged yet today."}</p>
                    <p className="m-0"><strong className="text-ink">Function:</strong> {info.what_it_does}</p>
                    <p className="m-0"><strong className="text-ink">Effect of spaceflight:</strong> {info.space_effects}</p>
                    <p className="m-0"><strong className="text-ink">What to do:</strong> {info.what_to_do}</p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      </AnimatePresence>

      <AnimatePresence>
        {anyRed && (
          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="flex flex-col gap-2 rounded-xl border border-alert-border bg-alert-surface p-3.5 text-sm">
            <span><strong className="text-alert-fg">Alert.</strong> Re-measure, then notify the flight surgeon.</span>
            <Button variant="danger" onClick={sendReport} disabled={sending}>Send report with my consent</Button>
          </motion.div>
        )}
      </AnimatePresence>

      <Button variant="primary" onClick={onAnalyze}>Analyze symptoms <Icon name="arrow-right" size={16} /></Button>
    </Card>
  );
}

// ---- left: log a reading (port of body.js's readings form) ----
const mid = (r) => (r[0] + r[1]) / 2;
function outer(cfg) {
  const ranges = [cfg.green, ...(cfg.yellow || [])];
  return { lo: Math.min(...ranges.map((r) => r[0])), hi: Math.max(...ranges.map((r) => r[1])) };
}

export function LogReadingCard({ astroId, rules }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ hr: "", sys: "", dia: "", sugar: "", temp: "", spo2: "" });
  const [result, setResult] = useState(null);
  const set = (k) => (e) => setV((s) => ({ ...s, [k]: e.target.value }));
  const ind = rules?.indicators;

  const fillNormal = () => ind && setV({
    hr: String(Math.round(mid(ind.heart_rate.green))),
    sys: String(Math.round(mid(ind.blood_pressure.systolic_green))),
    dia: String(Math.round(mid(ind.blood_pressure.diastolic_green))),
    sugar: String(Math.round(mid(ind.blood_sugar.green))),
    temp: mid(ind.temperature.green).toFixed(1),
    spo2: String(Math.round(((ind.oxygen_saturation.max ?? 100) + ind.oxygen_saturation.green_min) / 2)),
  });
  const fillAbnormal = () => ind && setV({
    hr: String(Math.round(outer(ind.heart_rate).hi + 15)),
    sys: String(ind.blood_pressure.systolic_red_high + 10),
    dia: String(ind.blood_pressure.diastolic_red_high + 8),
    sugar: String(Math.round(outer(ind.blood_sugar).hi + 30)),
    temp: (outer(ind.temperature).hi + 1).toFixed(1),
    spo2: String(ind.oxygen_saturation.yellow_min - 4),
  });

  async function assess() {
    const body = {};
    if (v.hr) body.heart_rate = Number(v.hr);
    if (v.sys && v.dia) body.blood_pressure = { systolic: Number(v.sys), diastolic: Number(v.dia) };
    if (v.sugar) body.blood_sugar = Number(v.sugar);
    if (v.temp) body.temperature = Number(v.temp);
    if (v.spo2) body.oxygen_saturation = Number(v.spo2);
    if (!Object.keys(body).length) return;
    setResult(await post(`/astronauts/${astroId}/assess`, body));
    ["summary", "history", "crew"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  }

  const field = (k, label, extra = {}) => (
    <label className="flex flex-col gap-1 text-xs text-muted">{label}
      <input className="ah-input min-h-10 text-sm" type="number" value={v[k]} onChange={set(k)} {...extra} />
    </label>
  );

  return (
    <Card className="flex flex-col gap-3 p-4">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex cursor-pointer items-center justify-between text-left">
        <span><span className="block text-sm font-semibold">Log a reading</span><span className="text-xs text-muted">Vitals for this twin</span></span>
        <motion.span animate={{ rotate: open ? 45 : 0 }} className="text-accent-text"><Icon name="plus" size={18} /></motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3, ease: EASE_ENTER }} className="overflow-hidden">
            <div className="flex flex-col gap-3 pt-1">
              <div className="flex gap-2">
                <Button className="min-h-9 flex-1 px-2 text-xs" onClick={fillNormal}>Normal readings</Button>
                <Button className="min-h-9 flex-1 px-2 text-xs" onClick={fillAbnormal}>Simulate abnormal</Button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {field("hr", "Heart rate (bpm)", { placeholder: "e.g. 72" })}
                {field("sugar", "Blood sugar (mg/dL)", { placeholder: "e.g. 90" })}
                {field("sys", "Systolic", { placeholder: "mmHg" })}
                {field("dia", "Diastolic", { placeholder: "mmHg" })}
                {field("temp", "Temperature (°C)", { placeholder: "e.g. 36.8", step: "0.1" })}
                {field("spo2", "Blood oxygen (%)", { placeholder: "e.g. 98", min: 1, max: 100 })}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" className="min-h-10" onClick={assess}>{STRINGS.assessButton}</Button>
                {result && <StatusChip level={result.overall_level} label="Result" />}
              </div>
              {result?.note && <p className="m-0 text-xs text-muted">{result.note}</p>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}

// ---- right: lab-style tiles with dot sparklines ----
export function LabTile({ indicator, reading, rows }) {
  const meta = INDICATORS[indicator];
  const points = toPoints(indicator, rows);
  const prev = points.length > 1 ? points[points.length - 2].y : null;
  const cur = points.length ? points[points.length - 1].y : null;
  const arrow = cur == null || prev == null ? "" : cur > prev ? "↗" : cur < prev ? "↘" : "→";
  const level = reading?.level || "GRAY";
  return (
    <motion.div
      variants={{ initial: { opacity: 0, x: 16 }, animate: { opacity: 1, x: 0, transition: { duration: 0.45, ease: EASE_ENTER } } }}
      whileHover={{ y: -2 }}
      className="flex flex-col gap-1.5 ah-glass rounded-card-s p-3.5"
    >
      <div className="flex items-center justify-between text-xs text-muted">
        <span className="flex items-center gap-1.5 border-l-2 pl-2" style={{ borderColor: LEVEL_HEX[level] }}>
          <Icon name={TILE_ICON[indicator]} size={13} />{meta.label}
        </span>
        <StatusChip level={level} plain className="px-2 py-[1px] text-[10px]" />
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="font-display text-[26px] leading-none font-bold tracking-tight">{reading ? formatIndicatorValue(indicator, reading.value) : "–"}</span>
        {reading && meta.unit && !["sleep", "mood"].includes(indicator) && <span className="text-xs text-muted">{meta.unit}</span>}
        {arrow && <span className="ml-auto text-sm text-ink-2">{arrow}</span>}
      </div>
      <Sparkline points={points} height={38} seriesKey={indicator} ariaLabel={`${meta.label}, last 7 days`} />
    </motion.div>
  );
}

// ---- bottom: 7-day timeline (each day's worst level across the vitals above) ----
export function Timeline({ histories }) {
  const [hover, setHover] = useState(null);
  const days = useMemo(() => {
    const out = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      out.push({ date: d, key: d.toDateString(), readings: [] });
    }
    const byKey = Object.fromEntries(out.map((d) => [d.key, d]));
    Object.entries(histories).forEach(([ind, rows]) => (rows || []).forEach((r) => {
      const k = new Date(r.ts).toDateString();
      if (byKey[k]) byKey[k].readings.push({ ind, level: r.level, value: r.value });
    }));
    return out.map((d) => ({ ...d, level: d.readings.length ? worstOf(d.readings.map((r) => r.level)) : "GRAY" }));
  }, [histories]);

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <h2 className="m-0 text-sm font-semibold">Last 7 days</h2>
        <span className="text-xs text-muted">Worst reading each day</span>
      </div>
      <div className="relative flex items-center justify-between gap-1 px-2">
        <div className="absolute top-1/2 right-4 left-4 h-px -translate-y-[10px] bg-line-strong" />
        {days.map((d, i) => (
          <button
            key={d.key}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
            className="relative flex cursor-default flex-col items-center gap-2"
            aria-label={`${d.date.toLocaleDateString(undefined, { weekday: "long" })}: ${LEVEL_WORD[d.level]}, ${d.readings.length} readings`}
          >
            <motion.span
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: 0.1 + i * 0.06, type: "spring", stiffness: 400, damping: 20 }}
              className="relative z-[1] h-4 w-4 rounded-full border-[3px] border-surface"
              style={{ background: LEVEL_HEX[d.level] }}
            />
            <span className={cx("text-[11px]", i === 6 ? "font-semibold text-ink" : "text-muted")}>
              {i === 6 ? "Today" : d.date.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}
            </span>
            <AnimatePresence>
              {hover === i && (
                <motion.span
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="absolute bottom-full z-10 mb-2 w-max max-w-[220px] rounded-xl border border-line-strong bg-raised px-3 py-2 text-left text-xs shadow-xl"
                >
                  <span className="mb-1 block font-semibold">{d.date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}</span>
                  {d.readings.length ? (
                    <span className="text-muted">
                      {d.readings.length} readings · {d.readings.filter((r) => r.level === "RED").length} alert,{" "}
                      {d.readings.filter((r) => r.level === "YELLOW").length} check
                    </span>
                  ) : <span className="text-muted">No readings</span>}
                </motion.span>
              )}
            </AnimatePresence>
          </button>
        ))}
      </div>
    </Card>
  );
}
