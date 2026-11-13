// Animated SVG line chart in the redesign's style (DESIGN-SYSTEM §8): shaded normal /
// caution bands (not lines), divider gridlines, one line in the role's accent, points
// ringed in the status color of their value, and a "Latest" callout.
//
// Motion: the line draws itself in (pathLength) and the points pop in one after
// another whenever the series changes (new indicator or range); the area fades up
// under it. Everything animated is transform/opacity or an SVG stroke offset.
import { useId, useMemo } from "react";
import { motion } from "motion/react";
import { scaleLinear, scaleTime } from "d3-scale";
import { area, curveMonotoneX, line } from "d3-shape";
import { LEVEL_HEX } from "../../lib/levels.js";
import { useWidth } from "./useWidth.js";

const PAD = { top: 18, right: 24, bottom: 30, left: 52 };

export function LineChart({
  points, // [{ t: Date, y: number, level }]
  secondary, // optional second series (e.g. diastolic): [{ t, y, level }]
  bands = [], // [{ lo, hi, kind: "normal" | "caution" }]
  height = 300,
  unit = "",
  seriesKey = "series", // changes → replay the draw-in animation
  startLabel,
  endLabel = "Today",
  formatValue = (v) => `${Math.round(v * 10) / 10}`,
  ariaLabel,
  showLatest = true,
  yDomain, // fixed [min, max] (e.g. mood 1-5) instead of fitting the data
  yTicks, // explicit tick values
  formatTick = (t) => t,
}) {
  const [ref, width] = useWidth();
  const gradId = useId();
  const w = Math.max(width, 240);
  const innerH = height - PAD.top - PAD.bottom;

  const model = useMemo(() => {
    if (!points?.length) return null;
    const all = [...points, ...(secondary || [])];
    const ys = all.map((p) => p.y).concat(bands.flatMap((b) => [b.lo, b.hi]).filter(Number.isFinite));
    let lo = Math.min(...ys);
    let hi = Math.max(...ys);
    if (lo === hi) { lo -= 1; hi += 1; }
    const span = hi - lo;
    const y = yDomain
      ? scaleLinear().domain(yDomain).range([PAD.top + innerH, PAD.top])
      : scaleLinear().domain([lo - span * 0.08, hi + span * 0.08]).nice(5).range([PAD.top + innerH, PAD.top]);
    const ts = all.map((p) => +p.t);
    const tMin = Math.min(...ts);
    const tMax = Math.max(...ts) === tMin ? tMin + 1 : Math.max(...ts);
    const x = scaleTime().domain([tMin, tMax]).range([PAD.left, w - PAD.right]);
    const mk = line().x((p) => x(p.t)).y((p) => y(p.y)).curve(curveMonotoneX);
    const fill = area().x((p) => x(p.t)).y0(PAD.top + innerH).y1((p) => y(p.y)).curve(curveMonotoneX);
    return {
      x, y,
      path: mk(points),
      area: fill(points),
      path2: secondary?.length ? mk(secondary) : null,
      ticks: yTicks || y.ticks(5),
    };
  }, [points, secondary, bands, w, innerH, yDomain, yTicks]);

  const latest = points?.[points.length - 1];
  const dense = (points?.length || 0) > 24;

  return (
    <div ref={ref} className="w-full">
      {!model ? (
        <div style={{ height }} className="flex items-center justify-center rounded-2xl border border-dashed border-line-strong text-sm text-muted">
          No readings in this range yet.
        </div>
      ) : (
        <svg width={w} height={height} role="img" aria-label={ariaLabel} className="block overflow-visible">
          <defs>
            <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="var(--ah-chart-line)" stopOpacity="0.22" />
              <stop offset="1" stopColor="var(--ah-chart-line)" stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {bands.map((b, i) => {
            const top = model.y(Math.min(b.hi, model.y.domain()[1]));
            const bot = model.y(Math.max(b.lo, model.y.domain()[0]));
            if (bot <= top) return null;
            return (
              <motion.rect
                key={`${seriesKey}-band-${i}`}
                x={PAD.left}
                width={w - PAD.left - PAD.right}
                y={top}
                height={bot - top}
                fill={b.kind === "normal" ? "#15302e" : "#2e2a1c"}
                initial={{ opacity: 0 }}
                animate={{ opacity: 0.85 }}
                transition={{ duration: 0.6 }}
              />
            );
          })}

          {model.ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={w - PAD.right} y1={model.y(t)} y2={model.y(t)} stroke="var(--ah-divider)" strokeWidth="1" />
              <text x={PAD.left - 10} y={model.y(t)} dy="0.32em" textAnchor="end" fontSize="12" fill="var(--ah-text-subtle)">{formatTick(t)}</text>
            </g>
          ))}

          <motion.path
            key={`${seriesKey}-area`}
            d={model.area}
            fill={`url(#${gradId})`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.8, delay: 0.35 }}
          />
          {model.path2 && (
            <motion.path
              key={`${seriesKey}-line2`}
              d={model.path2}
              fill="none"
              stroke="#9db6ff"
              strokeOpacity="0.55"
              strokeWidth="2"
              strokeDasharray="5 5"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 1, ease: [0.2, 0.7, 0.2, 1] }}
            />
          )}
          <motion.path
            key={`${seriesKey}-line`}
            d={model.path}
            fill="none"
            stroke="var(--ah-chart-line)"
            strokeWidth="2.5"
            strokeLinecap="round"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 1, ease: [0.2, 0.7, 0.2, 1] }}
          />

          {points.map((p, i) => (
            <motion.circle
              key={`${seriesKey}-pt-${i}`}
              cx={model.x(p.t)}
              cy={model.y(p.y)}
              r={dense ? 3.2 : 5.5}
              fill="var(--ah-surface-1)"
              stroke={LEVEL_HEX[p.level] || LEVEL_HEX.GRAY}
              strokeWidth={dense ? 1.8 : 2.4}
              initial={{ opacity: 0, scale: 0 }}
              animate={{ opacity: 1, scale: 1 }}
              style={{ transformBox: "fill-box", transformOrigin: "center" }}
              transition={{ delay: 0.25 + (i / points.length) * 0.75, type: "spring", stiffness: 420, damping: 22 }}
            />
          ))}

          {showLatest && latest && (
            <Callout x={model.x(latest.t)} y={model.y(latest.y)} width={w} text={`${formatValue(latest.y)}${unit ? ` ${unit}` : ""}`} seriesKey={seriesKey} />
          )}

          {startLabel && (
            <text x={PAD.left} y={height - 6} fontSize="13" fill="var(--ah-text-muted)">{startLabel}</text>
          )}
          <text x={w - PAD.right} y={height - 6} textAnchor="end" fontSize="13" fill="var(--ah-text-muted)">{endLabel}</text>
        </svg>
      )}
    </div>
  );
}

function Callout({ x, y, width, text, seriesKey }) {
  const boxW = Math.max(74, 18 + text.length * 8);
  const left = Math.min(Math.max(x - boxW - 12, 44), width - boxW - 8);
  const top = Math.max(y - 58, 4);
  return (
    <motion.g
      key={`${seriesKey}-callout`}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 1, duration: 0.35 }}
    >
      <rect x={left} y={top} width={boxW} height={44} rx="8" fill="var(--ah-accent)" />
      <text x={left + 12} y={top + 17} fontSize="11" fill="var(--ah-accent-on)" opacity="0.8">Latest</text>
      <text x={left + 12} y={top + 35} fontSize="14" fontWeight="700" fill="var(--ah-accent-on)">{text}</text>
    </motion.g>
  );
}

// Legend under the chart: shaded swatches for the bands.
export function BandLegend({ bands, unit }) {
  const normal = bands.find((b) => b.kind === "normal");
  const hasCaution = bands.some((b) => b.kind === "caution");
  if (!normal && !hasCaution) return null;
  return (
    <div className="flex flex-wrap items-center gap-4 text-label text-ink-2">
      {normal && (
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-[#1f4a45]" />
          Normal {Number.isFinite(normal.hi) ? `${normal.lo}–${normal.hi}` : `${normal.lo}+`}{unit ? ` ${unit}` : ""}
        </span>
      )}
      {hasCaution && (
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-[#4a4226]" />Caution</span>
      )}
    </div>
  );
}
