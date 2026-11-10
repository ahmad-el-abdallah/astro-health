// Sleep stage bar (DESIGN-SYSTEM §6 "Stage bar": 2px gaps between segments). ILLUSTRATIVE
// ONLY -- no hardware in this project measures sleep stages; the label always says so.
import { motion } from "motion/react";

export const STAGE_COLORS = {
  awake: "var(--ah-sleep-awake)",
  light: "var(--ah-sleep-light)",
  deep: "var(--ah-sleep-deep)",
  rem: "var(--ah-sleep-rem)",
};

// Same illustrative pattern the old Sleep Lab tab used (static/js/tabs/sleep_lab.js).
export const STAGE_SEGMENTS = [
  { stage: "light", pct: 22 }, { stage: "deep", pct: 18 }, { stage: "rem", pct: 15 },
  { stage: "light", pct: 20 }, { stage: "deep", pct: 12 }, { stage: "awake", pct: 3 }, { stage: "rem", pct: 10 },
];

export function StageBar({ height = 12 }) {
  return (
    <div className="flex gap-0.5 overflow-hidden rounded-md" style={{ height }} role="img" aria-label="Illustrative sleep stages (not measured)">
      {STAGE_SEGMENTS.map((s, i) => (
        <motion.div
          key={i}
          className="h-full origin-left"
          style={{ width: `${s.pct}%`, background: STAGE_COLORS[s.stage] }}
          initial={{ scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ delay: 0.15 + i * 0.07, duration: 0.45, ease: [0.2, 0.7, 0.2, 1] }}
        />
      ))}
    </div>
  );
}

export function StageLegend() {
  return (
    <div className="flex flex-wrap gap-3 text-xs text-ink-2">
      {[["awake", "Awake"], ["light", "Light"], ["deep", "Deep"], ["rem", "REM"]].map(([k, label]) => (
        <span key={k} className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm" style={{ background: STAGE_COLORS[k] }} />{label}
        </span>
      ))}
    </div>
  );
}
