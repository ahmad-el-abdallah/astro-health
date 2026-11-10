// Animated bar chart (sleep duration, Trends' "higher is better" indicators): bars grow
// from the baseline with a spring, colored by each value's status, with an optional
// target line (e.g. "7 h") and the shaded normal band behind.
import { useMemo } from "react";
import { motion } from "motion/react";
import { scaleBand, scaleLinear } from "d3-scale";
import { LEVEL_HEX } from "../../lib/levels.js";
import { useWidth } from "./useWidth.js";

const PAD = { top: 16, right: 16, bottom: 30, left: 44 };

export function BarChart({ bars, height = 260, target, targetLabel, seriesKey = "bars", formatValue = (v) => v, ariaLabel, maxY }) {
  const [ref, width] = useWidth();
  const w = Math.max(width, 240);
  const model = useMemo(() => {
    if (!bars?.length) return null;
    const hi = Math.max(maxY || 0, target || 0, ...bars.map((b) => b.y)) * 1.12;
    const x = scaleBand().domain(bars.map((_, i) => i)).range([PAD.left, w - PAD.right]).padding(0.32);
    const y = scaleLinear().domain([0, hi]).nice(4).range([height - PAD.bottom, PAD.top]);
    return { x, y, ticks: y.ticks(4) };
  }, [bars, w, height, target, maxY]);

  return (
    <div ref={ref} className="w-full">
      {!model ? (
        <div style={{ height }} className="flex items-center justify-center rounded-2xl border border-dashed border-line-strong text-sm text-muted">No readings in this range yet.</div>
      ) : (
        <svg width={w} height={height} role="img" aria-label={ariaLabel} className="block overflow-visible">
          {model.ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={w - PAD.right} y1={model.y(t)} y2={model.y(t)} stroke="var(--ah-divider)" />
              <text x={PAD.left - 8} y={model.y(t)} dy="0.32em" textAnchor="end" fontSize="12" fill="var(--ah-text-subtle)">{t}</text>
            </g>
          ))}
          {bars.map((b, i) => {
            const base = model.y(0);
            const top = model.y(b.y);
            return (
              <g key={`${seriesKey}-${i}`}>
                <motion.rect
                  x={model.x(i)}
                  width={model.x.bandwidth()}
                  y={top}
                  height={Math.max(0, base - top)}
                  rx={Math.min(6, model.x.bandwidth() / 3)}
                  fill={LEVEL_HEX[b.level] || "var(--ah-chart-line)"}
                  fillOpacity="0.85"
                  style={{ transformBox: "fill-box", transformOrigin: "bottom" }}
                  initial={{ scaleY: 0 }}
                  animate={{ scaleY: 1 }}
                  transition={{ delay: 0.1 + i * 0.05, type: "spring", stiffness: 160, damping: 18 }}
                >
                  <title>{`${b.label}: ${formatValue(b.y)}`}</title>
                </motion.rect>
                {bars.length <= 14 && (
                  <text x={model.x(i) + model.x.bandwidth() / 2} y={height - 10} textAnchor="middle" fontSize="11" fill="var(--ah-text-muted)">{b.short}</text>
                )}
              </g>
            );
          })}
          {target != null && (
            <g pointerEvents="none">
              <line x1={PAD.left} x2={w - PAD.right} y1={model.y(target)} y2={model.y(target)} stroke="var(--ah-accent-text)" strokeDasharray="5 5" strokeOpacity="0.8" />
              {targetLabel && <text x={PAD.left + 4} y={model.y(target) - 6} fontSize="11" fill="var(--ah-accent-text)">{targetLabel}</text>}
            </g>
          )}
        </svg>
      )}
    </div>
  );
}
