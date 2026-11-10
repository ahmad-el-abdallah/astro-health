// Small dot sparkline (the reference dashboard's lab tiles): a faint line with each
// reading as a dot in its status color, the latest one ringed. Draws itself in.
import { useMemo } from "react";
import { motion } from "motion/react";
import { scaleLinear } from "d3-scale";
import { curveMonotoneX, line } from "d3-shape";
import { LEVEL_HEX } from "../../lib/levels.js";
import { useWidth } from "./useWidth.js";

export function Sparkline({ points, height = 46, seriesKey = "s", ariaLabel, emptyText = "No readings this week" }) {
  const [ref, width] = useWidth(180);
  const w = Math.max(width, 80);
  const model = useMemo(() => {
    if (!points?.length) return null;
    const ys = points.map((p) => p.y);
    let lo = Math.min(...ys), hi = Math.max(...ys);
    if (lo === hi) { lo -= 1; hi += 1; }
    const x = scaleLinear().domain([0, Math.max(1, points.length - 1)]).range([6, w - 8]);
    const y = scaleLinear().domain([lo, hi]).range([height - 7, 7]);
    const path = line().x((_, i) => x(i)).y((p) => y(p.y)).curve(curveMonotoneX)(points);
    return { x, y, path };
  }, [points, w, height]);

  return (
    <div ref={ref} className="w-full" role="img" aria-label={ariaLabel}>
      {!model ? (
        <div className="flex items-center text-xs text-subtle" style={{ height }}>{emptyText}</div>
      ) : (
        <svg width={w} height={height} className="block overflow-visible">
          <line x1="0" x2={w} y1={height - 1} y2={height - 1} stroke="var(--ah-divider)" strokeDasharray="2 4" />
          <motion.path
            key={`${seriesKey}-l`}
            d={model.path}
            fill="none"
            stroke="var(--ah-chart-line)"
            strokeOpacity="0.55"
            strokeWidth="1.5"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.9, ease: [0.2, 0.7, 0.2, 1] }}
          />
          {points.map((p, i) => {
            const last = i === points.length - 1;
            return (
              <motion.circle
                key={`${seriesKey}-${i}`}
                cx={model.x(i)}
                cy={model.y(p.y)}
                r={last ? 4 : 2.3}
                fill={last ? "var(--ah-surface-1)" : LEVEL_HEX[p.level] || LEVEL_HEX.GRAY}
                stroke={last ? LEVEL_HEX[p.level] || LEVEL_HEX.GRAY : "none"}
                strokeWidth={last ? 2 : 0}
                style={{ transformBox: "fill-box", transformOrigin: "center" }}
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ delay: 0.2 + (i / points.length) * 0.6, type: "spring", stiffness: 420, damping: 22 }}
              />
            );
          })}
        </svg>
      )}
    </div>
  );
}
