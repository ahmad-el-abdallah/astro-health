// Ring gauge (DESIGN-SYSTEM §6): border-strong track, accent-text value arc that sweeps
// into place, centered number in the display font that counts up.
import { motion } from "motion/react";
import { AnimatedNumber } from "../ui/index.jsx";

export function RingGauge({ value, size = 140, stroke = 12, suffix = "%", ariaLabel }) {
  const r = (size - stroke) / 2;
  const frac = value == null ? 0 : Math.max(0, Math.min(1, value / 100));
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} role="img" aria-label={ariaLabel}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--ah-border-strong)" strokeWidth={stroke} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--ah-accent-text)"
          strokeWidth={stroke}
          strokeLinecap="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: frac }}
          transition={{ type: "spring", stiffness: 60, damping: 18, delay: 0.2 }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="font-display text-[38px] font-bold tracking-tight">
          {value == null ? "–" : <AnimatedNumber value={value} />}
        </span>
        {value != null && <span className="mt-3 text-sm text-muted">{suffix}</span>}
      </div>
    </div>
  );
}
