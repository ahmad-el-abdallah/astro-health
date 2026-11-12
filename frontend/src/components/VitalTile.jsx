// Vital tile (DESIGN-SYSTEM §6): icon chip, label, big metric + unit, status chip, and a
// 3px top edge in the status color. Numbers count up and re-tween on live updates.
import { motion } from "motion/react";
import { formatIndicatorValue, INDICATORS } from "../lib/format.js";
import { AnimatedNumber, StatusChip, cx } from "./ui/index.jsx";
import { Icon } from "./ui/Icon.jsx";
import { rise } from "./ui/motion.js";

export const TILE_ICON = {
  heart_rate: "heart", blood_pressure: "blood-pressure", blood_sugar: "blood-sugar", temperature: "temperature",
  oxygen_saturation: "lungs", sleep: "sleep", mood: "mood", reaction_time: "mind", exercise: "sun", water: "blood-sugar",
};

const EDGE = { GREEN: "border-t-good-edge", YELLOW: "border-t-check-edge", RED: "border-t-alert-edge", GRAY: "border-t-line" };

function Metric({ indicator, value }) {
  if (value == null) return <span>–</span>;
  if (indicator === "heart_rate" || indicator === "blood_sugar" || indicator === "oxygen_saturation" || indicator === "exercise" || indicator === "water") {
    return <AnimatedNumber value={Number(value)} />;
  }
  if (indicator === "temperature") return <AnimatedNumber value={Number(value)} decimals={1} />;
  return <span>{formatIndicatorValue(indicator, value)}</span>;
}

export function VitalTile({ indicator, reading, className = "", children }) {
  const meta = INDICATORS[indicator] || { label: indicator.replace(/_/g, " "), unit: "" };
  const level = reading?.level || "GRAY";
  const showUnit = reading && meta.unit && !["sleep", "mood", "reaction_time"].includes(indicator);
  return (
    <motion.div
      variants={rise}
      whileHover={{ y: -3, transition: { duration: 0.2 } }}
      className={cx("flex flex-col gap-2.5 ah-glass rounded-card-s border-t-[3px] p-4 transition-colors duration-500", EDGE[level], className)}
    >
      <div className="flex min-w-0 items-center gap-2 text-sm text-ink-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-raised text-accent-text">
          <Icon name={TILE_ICON[indicator] || "trends"} size={15} />
        </span>
        <span className="truncate" title={meta.label}>{meta.label}</span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="font-display text-[30px] leading-[1.05] font-bold tracking-[-0.02em]">
          <Metric indicator={indicator} value={reading?.value} />
        </span>
        {showUnit && <span className="text-sm text-muted">{meta.unit}</span>}
      </div>
      <div className="flex items-center justify-between gap-2">
        <StatusChip level={level} />
        {children}
      </div>
    </motion.div>
  );
}
