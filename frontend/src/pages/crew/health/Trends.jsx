// Crew · Trends (AstroHealth-Redesign crew-03; port of static/js/tabs/trends.js), grown into
// a full analytics page:
// 1. all 9 indicators at a glance (latest value, status, mini chart) -- click one to explore;
// 2. the big banded chart for that indicator (7 / 30 / 90 days);
// 3. a summary: average + change vs the previous period, latest, trend direction per week,
//    lowest/highest with dates, readings by status, and how regularly it was logged;
// 4. plain-language insights, the weekday pattern, and the full readings log with sources.
// The numbers come from trends/stats.js (pure, unit-tested). Descriptive only, not advice.
import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useAstronautPicker } from "../../../auth/AuthProvider.jsx";
import { fmtTime, formatIndicatorValue, INDICATORS, MOOD_LABELS, numericValue } from "../../../lib/format.js";
import { bandsFor, LEVEL_HEX } from "../../../lib/levels.js";
import { useHealthRules, useHistory } from "../../../lib/queries.js";
import { Card, CardTitle, Progress, Segmented, StatusChip, cx } from "../../../components/ui/index.jsx";
import { Icon } from "../../../components/ui/Icon.jsx";
import { BandLegend, LineChart } from "../../../components/charts/LineChart.jsx";
import { BarChart } from "../../../components/charts/BarChart.jsx";
import { Sparkline } from "../../../components/charts/Sparkline.jsx";
import { TREND_INDICATORS, useTrendSeries } from "../../../components/TrendCard.jsx";
import { BETTER, UNIT, compare, fmtValue, insights, levelFor, recentOutOfRange, splitPeriods, summarize, weekdayAverages } from "./trends/stats.js";

const BAR = new Set(["sleep", "exercise", "water"]);
const TARGET = { sleep: [7, "Target 7 h"], exercise: [90, "Target 90 min"], water: [2000, "Target 2000 ml"] };
const TILE_ICON = { heart_rate: "heart", blood_pressure: "blood-pressure", blood_sugar: "blood-sugar", temperature: "temperature", oxygen_saturation: "lungs", respiration_rate: "lungs", stress: "mind", sleep: "sleep", mood: "mood", exercise: "exercise", water: "blood-sugar", reaction_time: "mind" };
const SOURCE = { cyd: "CYD", manual: "Manual entry", tag: "NFC tag", seed: "Mission history" };
const RANGES = [{ value: 7, label: "7 days" }, { value: 30, label: "30 days" }, { value: 90, label: "90 days" }];

// ---------- 1. all indicators ----------
function IndicatorTile({ astroId, indicator, days, active, onSelect }) {
  const { points, rows } = useTrendSeries(astroId, indicator, days);
  const latest = rows.at(-1);
  const unit = latest && UNIT[indicator] && !["reaction_time"].includes(indicator) ? UNIT[indicator] : "";
  return (
    <button
      onClick={() => onSelect(indicator)}
      aria-pressed={active}
      className={cx("group relative flex min-w-0 cursor-pointer flex-col gap-2 rounded-2xl p-3.5 text-left transition-colors", active ? "" : "bg-raised hover:bg-control")}
    >
      {active && (
        <motion.span
          layoutId="trend-tile"
          className="absolute inset-0 rounded-2xl border border-accent-text/60 bg-[rgb(var(--ah-accent-rgb)/.16)] shadow-[0_0_24px_rgb(var(--ah-accent-rgb)/.2)]"
          transition={{ type: "spring", stiffness: 420, damping: 38 }}
        />
      )}
      <span className="relative flex items-center gap-2 text-xs font-medium text-muted">
        <Icon name={TILE_ICON[indicator] || "trends"} size={14} className={active ? "text-accent-text" : ""} />
        <span className="truncate">{INDICATORS[indicator].label}</span>
        <span className={cx("ml-auto h-2 w-2 shrink-0 rounded-full", DOT[latest?.level] || "bg-subtle")} />
      </span>
      <span className="relative truncate font-display text-xl leading-none font-bold">
        {latest ? formatIndicatorValue(indicator, latest.value) : "–"}
        {unit && <span className="ml-1 text-xs font-normal text-muted">{unit}</span>}
      </span>
      <span className="relative">
        <Sparkline points={points} height={30} emptyText="No readings in this range" seriesKey={`tile-${astroId}-${indicator}-${days}`} ariaLabel={`${INDICATORS[indicator].label}, last ${days} days`} />
      </span>
    </button>
  );
}

// ---------- 2. main chart ----------
function MainChart({ astroId, indicator, days }) {
  const { points, secondary, bands } = useTrendSeries(astroId, indicator, days);
  const label = INDICATORS[indicator].label;
  const key = `${astroId}-${indicator}-${days}`;
  if (BAR.has(indicator)) {
    const [target, targetLabel] = TARGET[indicator] || [];
    return (
      <BarChart
        height={360}
        seriesKey={key}
        target={target}
        targetLabel={targetLabel}
        formatValue={(v) => fmtValue(indicator, v)}
        ariaLabel={`${label}, ${points.length} readings over ${days} days`}
        bars={points.map((p) => ({
          y: p.y, level: p.level, label: p.t.toLocaleDateString(),
          short: p.t.toLocaleDateString(undefined, { weekday: "short" }),
        }))}
      />
    );
  }
  return (
    <>
      <LineChart
        points={points}
        secondary={secondary}
        bands={bands}
        height={360}
        unit={UNIT[indicator] || ""}
        seriesKey={key}
        startLabel={`${days} days ago`}
        ariaLabel={`${label} over the last ${days} days, ${points.length} readings`}
        formatValue={(v) => (indicator === "temperature" ? v.toFixed(1) : indicator === "mood" ? MOOD_LABELS[Math.round(v)] || v : Math.round(v))}
        {...(indicator === "mood" ? { yDomain: [0.5, 5.5], yTicks: [1, 2, 3, 4, 5], formatTick: (t) => MOOD_LABELS[t] || "" } : {})}
      />
      <div className="flex justify-center"><BandLegend bands={bands} /></div>
    </>
  );
}

// ---------- 3. summary ----------
function slopeText(indicator, slope) {
  if (slope == null) return "";
  const sign = slope > 0 ? "+" : "−";
  const v = Math.abs(slope);
  if (indicator === "sleep") return `${sign}${(v * 60).toFixed(0)} min / week`;
  if (indicator === "mood") return `${sign}${v.toFixed(2)} pts / week`;
  if (indicator === "temperature") return `${sign}${v.toFixed(2)} °C / week`;
  return `${sign}${v.toFixed(1)}${UNIT[indicator] ? ` ${UNIT[indicator]}` : ""} / week`;
}

function ChangeChip({ indicator, change, days }) {
  if (!change || change.pct == null || !Number.isFinite(change.pct)) {
    return <span className="rounded-full bg-raised px-2.5 py-1 text-xs text-muted">No earlier {days} days to compare</span>;
  }
  const up = change.delta > 0;
  const flat = Math.abs(change.pct) < 2;
  const better = BETTER[indicator];
  const tone = flat || !better ? "bg-raised text-ink-2" : (better === "up") === up ? "bg-good-bg text-good-fg" : "bg-check-bg text-check-fg";
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold", tone)}>
      {!flat && <Icon name="arrow-right" size={13} className={up ? "-rotate-45" : "rotate-45"} />}
      {flat ? "≈ same" : `${up ? "+" : "−"}${Math.abs(change.pct).toFixed(Math.abs(change.pct) < 10 ? 1 : 0)}%`} vs previous {days} days
    </span>
  );
}

function Stat({ label, children, sub }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-[var(--radius-inner)] bg-raised p-3">
      <span className="text-xs text-muted">{label}</span>
      <span className="truncate text-body font-semibold">{children}</span>
      {sub && <span className="truncate text-caption text-subtle">{sub}</span>}
    </div>
  );
}

const DOT = { GREEN: "bg-good-fg", YELLOW: "bg-check-fg", RED: "bg-alert-fg" };
const SEG = [["GREEN", "Good", "bg-good-fg"], ["YELLOW", "Check", "bg-check-fg"], ["RED", "Alert", "bg-alert-fg"]];

function SummaryCard({ indicator, days, stats, change }) {
  const day = (t) => t.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return (
    <Card className="flex flex-col gap-4">
      <CardTitle title={`${INDICATORS[indicator].label} · last ${days} days`} />
      {!stats ? (
        <p className="m-0 text-sm text-muted">No {INDICATORS[indicator].label.toLowerCase()} readings in this range yet.</p>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <span className="text-xs text-muted">Average</span>
            <AnimatePresence mode="wait">
              <motion.span
                key={`${indicator}-${days}-${stats.avg}`}
                initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.22 }}
                className="font-display text-hero leading-none font-bold tracking-tight"
              >
                {fmtValue(indicator, stats.avg, stats.avg2, { avg: true })}
              </motion.span>
            </AnimatePresence>
            <div><ChangeChip indicator={indicator} change={change} days={days} /></div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Stat label="Latest" sub={fmtTime(stats.latest.t.toISOString())}>
              <span className="flex items-center gap-2">
                {fmtValue(indicator, stats.latest.y, stats.latest.y2)}
                <span className={cx("h-2 w-2 shrink-0 rounded-full", DOT[stats.latest.level] || "bg-subtle")} title={stats.latest.level} />
              </span>
            </Stat>
            <Stat label="Trend" sub={slopeText(indicator, stats.slope)}>
              {stats.trend ? (
                <span className="flex items-center gap-1.5">
                  <Icon name="arrow-right" size={15} className={cx("text-accent-text", stats.trend === "Rising" ? "-rotate-45" : stats.trend === "Falling" ? "rotate-45" : "")} />
                  {stats.trend}
                </span>
              ) : "Not enough data"}
            </Stat>
            <Stat label="Lowest" sub={day(stats.min.t)}>{fmtValue(indicator, stats.min.y, stats.min.y2)}</Stat>
            <Stat label="Highest" sub={day(stats.max.t)}>{fmtValue(indicator, stats.max.y, stats.max.y2)}</Stat>
          </div>

          {stats.rated > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-xs text-muted">Readings by status</span>
              <div className="flex h-2.5 overflow-hidden rounded-full bg-line-strong">
                {SEG.map(([lvl, , cls]) => (
                  <motion.span
                    key={lvl}
                    className={cx("h-full", cls)}
                    initial={{ width: 0 }}
                    animate={{ width: `${(stats.levels[lvl] / stats.rated) * 100}%` }}
                    transition={{ type: "spring", stiffness: 90, damping: 20 }}
                  />
                ))}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                {SEG.map(([lvl, word, cls]) => (
                  <span key={lvl} className="inline-flex items-center gap-1.5">
                    <span className={cx("h-2 w-2 rounded-full", cls)} />{word} <strong className="font-semibold text-ink">{stats.levels[lvl]}</strong>
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <div className="flex justify-between text-xs">
              <span className="text-muted">Days with a reading</span>
              <span className="font-semibold">{stats.daysLogged} of {days}</span>
            </div>
            <Progress value={stats.daysLogged / days} />
          </div>
        </>
      )}
    </Card>
  );
}

// ---------- 4. insights, weekday pattern, log ----------
const TONE = {
  good: { icon: "tick", cls: "bg-good-bg text-good-fg" },
  check: { icon: "alert", cls: "bg-check-bg text-check-fg" },
  info: { icon: "trends", cls: "bg-accent-soft text-accent-text" },
};

function InsightsCard({ list }) {
  return (
    <Card className="flex min-w-0 flex-col">
      <CardTitle title="What the numbers show" subtitle="Worked out from your own readings. Descriptive only, not medical advice." />
      {list.length === 0 ? (
        <p className="m-0 text-sm text-muted">Insights appear once there are a few readings in this range.</p>
      ) : (
        <motion.ul className="m-0 flex list-none flex-col gap-2 p-0" initial="initial" animate="animate" variants={{ animate: { transition: { staggerChildren: 0.06 } } }}>
          {list.map((it) => (
            <motion.li
              key={it.text}
              variants={{ initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 } }}
              className="flex items-start gap-3 rounded-[var(--radius-inner)] bg-raised p-3 text-sm leading-snug text-ink-2"
            >
              <span className={cx("mt-px flex h-7 w-7 shrink-0 items-center justify-center rounded-lg", TONE[it.tone].cls)}>
                <Icon name={TONE[it.tone].icon} size={15} />
              </span>
              {it.text}
            </motion.li>
          ))}
        </motion.ul>
      )}
    </Card>
  );
}

// Weekday averages on a zoomed scale (lowest..highest average, not 0..max), so a real
// 85-vs-92 difference is visible instead of seven identical full-height bars. The dashed
// line is the overall average; each dot is colored by how that average rates.
const DAY_NAME = { Mon: "Mondays", Tue: "Tuesdays", Wed: "Wednesdays", Thu: "Thursdays", Fri: "Fridays", Sat: "Saturdays", Sun: "Sundays" };
function WeekdayCard({ indicator, days, points, bands }) {
  const week = weekdayAverages(points);
  const known = week.filter((d) => d.avg != null);
  // Blood pressure is compared on its systolic (top) number.
  const label = indicator === "blood_pressure" ? "systolic blood pressure" : INDICATORS[indicator].label.toLowerCase();
  let body = <p className="m-0 text-sm text-muted">Not enough readings in this range yet.</p>;
  if (known.length) {
    const vals = known.map((d) => d.avg);
    const overall = points.reduce((s, p) => s + p.y, 0) / points.length;
    let lo = Math.min(...vals, overall), hi = Math.max(...vals, overall);
    const pad = (hi - lo) * 0.18 || Math.abs(hi) * 0.05 || 1;
    lo -= pad; hi += pad;
    const pos = (v) => ((v - lo) / (hi - lo)) * 100;
    const top = known.reduce((a, b) => (b.avg > a.avg ? b : a));
    const low = known.reduce((a, b) => (b.avg < a.avg ? b : a));
    const f = (v) => fmtValue(indicator, v, null, { avg: true });
    body = (
      <>
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
          {week.map((d, i) => (
            <li key={d.day} className="grid grid-cols-[36px_minmax(0,1fr)_92px] items-center gap-3 text-sm">
              <span className={cx("font-semibold", d === top || d === low ? "text-ink" : "text-muted")}>{d.day}</span>
              <span className="relative h-7">
                <span className="absolute top-1/2 right-0 left-0 h-1.5 -translate-y-1/2 rounded-full bg-line-strong/70" />
                <span className="absolute top-0 bottom-0 w-px border-l border-dashed border-accent-text/60" style={{ left: `${pos(overall)}%` }} />
                {d.avg != null && (
                  <motion.span
                    className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-[var(--ah-surface-1)] shadow-[0_0_0_1px_rgba(255,255,255,.15)]"
                    style={{ left: `${pos(d.avg)}%`, background: LEVEL_HEX[levelFor(d.avg, bands)] || "var(--ah-accent-text)" }}
                    initial={{ scale: 0, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ delay: 0.1 + i * 0.05, type: "spring", stiffness: 380, damping: 20 }}
                  />
                )}
              </span>
              <span className="text-right">
                <span className="font-semibold">{d.avg != null ? f(d.avg) : "–"}</span>
                <span className="block text-caption text-subtle">{d.n} reading{d.n === 1 ? "" : "s"}</span>
              </span>
            </li>
          ))}
        </ul>
        {known.length > 1 && top !== low && (
          <p className="m-0 mt-4 rounded-[var(--radius-inner)] bg-raised p-3 text-label text-ink-2">
            Highest on {DAY_NAME[top.day]} ({f(top.avg)}), lowest on {DAY_NAME[low.day]} ({f(low.avg)}). Dashed line: overall average {f(overall)}.
          </p>
        )}
      </>
    );
  }
  return (
    <Card className="flex min-w-0 flex-col">
      <CardTitle title="By day of the week" subtitle={`Average ${label} for each weekday, last ${days} days.`} />
      {body}
    </Card>
  );
}

function ReadingsLog({ indicator, rows }) {
  const [all, setAll] = useState(false);
  const list = [...rows].reverse();
  const shown = all ? list : list.slice(0, 8);
  const unit = UNIT[indicator] && !["reaction_time"].includes(indicator) ? ` ${UNIT[indicator]}` : "";
  return (
    <Card>
      <CardTitle
        title={`${list.length} ${INDICATORS[indicator].label.toLowerCase()} reading${list.length === 1 ? "" : "s"}`}
        subtitle="Newest first, with where each one came from."
      />
      {list.length === 0 ? (
        <p className="m-0 text-sm text-muted">Nothing logged in this range.</p>
      ) : (
        <>
          <div className="hidden grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_110px_130px] gap-3 px-3 pb-2 text-caption font-semibold tracking-[0.1em] text-subtle uppercase md:grid">
            <span>When</span><span>Value</span><span>Status</span><span>Source</span>
          </div>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            <AnimatePresence initial={false}>
              {shown.map((r, i) => (
                <motion.li
                  key={r.ts + i}
                  layout="position"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0, transition: { delay: Math.min(i, 8) * 0.03 } }}
                  exit={{ opacity: 0 }}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-[var(--radius-inner)] bg-raised px-3 py-2.5 text-sm md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_110px_130px]"
                >
                  <span className="truncate text-ink-2">{fmtTime(r.ts)}</span>
                  <span className="font-semibold md:order-none">{formatIndicatorValue(indicator, r.value)}{unit}</span>
                  <span><StatusChip level={r.level || "GRAY"} /></span>
                  <span className="truncate text-xs text-muted max-md:text-right">{SOURCE[r.source] || r.source || "–"}</span>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
          {list.length > 8 && (
            <div className="mt-3 flex justify-center">
              <button onClick={() => setAll((a) => !a)} className="min-h-10 cursor-pointer rounded-xl px-4 text-sm font-semibold text-accent-text hover:bg-raised">
                {all ? "Show fewer" : `Show all ${list.length}`}
              </button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

export default function Trends() {
  const { id } = useAstronautPicker();
  const [indicator, setIndicator] = useState("heart_rate");
  const [days, setDays] = useState(30);
  const rules = useHealthRules();
  // Twice the range in one request: the current period plus the one before it to compare.
  const hist = useHistory(id, indicator, days * 2);
  const bands = useMemo(() => bandsFor(rules.data, indicator), [rules.data, indicator]);

  const model = useMemo(() => {
    const rowsAll = hist.data || [];
    const points = rowsAll
      .map((r) => ({
        t: new Date(r.ts), y: numericValue(indicator, r.value), level: r.level,
        y2: indicator === "blood_pressure" ? r.value?.diastolic : undefined,
      }))
      .filter((p) => Number.isFinite(p.y));
    const now = hist.dataUpdatedAt; // when this data was fetched = the period's end
    const { current, previous } = splitPeriods(points, days, now);
    const cutIso = new Date(now - days * 864e5).toISOString();
    const rows = rowsAll.filter((r) => new Date(r.ts).toISOString() >= cutIso);
    const stats = summarize(current, days);
    const change = compare(stats, summarize(previous, days));
    const label = INDICATORS[indicator].label;
    return { current, rows, stats, change, list: insights({ indicator, label, stats, change, recentOut: recentOutOfRange(current, now) }) };
  }, [hist.data, hist.dataUpdatedAt, indicator, days]);

  return (
    <>
      <Card className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="m-0 text-title font-semibold">All indicators</h2>
            <p className="m-0 mt-0.5 text-label text-muted">Latest reading and its trend over the selected range.</p>
          </div>
          <Segmented id="trend-range" size="sm" value={days} onChange={setDays} options={RANGES} />
        </div>
        <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(158px,1fr))]">
          {TREND_INDICATORS.map((k) => (
            <IndicatorTile key={k} astroId={id} indicator={k} days={days} active={k === indicator} onSelect={setIndicator} />
          ))}
        </div>
      </Card>

      <div className="grid grid-cols-1 items-start gap-[18px] xl:grid-cols-[minmax(0,1fr)_350px]">
        <Card className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 className="m-0 text-title font-semibold">{INDICATORS[indicator].label} · last {days} days{BAR.has(indicator) ? " · daily totals" : ""}</h2>
            </div>
            <span className="text-xs text-muted">Each point is colored by how that reading was rated.</span>
          </div>
          <MainChart astroId={id} indicator={indicator} days={days} />
        </Card>
        <SummaryCard indicator={indicator} days={days} stats={model.stats} change={model.change} />
      </div>

      <div className="grid grid-cols-1 items-start gap-[18px] lg:grid-cols-2">
        <InsightsCard list={model.list} />
        <WeekdayCard indicator={indicator} days={days} points={model.current} bands={bands} />
      </div>

      <ReadingsLog key={`${indicator}-${days}`} indicator={indicator} rows={model.rows} />
    </>
  );
}
