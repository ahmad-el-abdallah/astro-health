// Mission-risk meter: three pips plus the word ("High risk"), never color alone.
// Shared by Mission health and the Flight Surgeon's crew profile.
import { motion } from "motion/react";

const RISK_CLR = { HIGH: "var(--color-risk-high)", MEDIUM: "var(--color-risk-medium)", LOW: "var(--color-risk-low)" };

export function RiskMeter({ risk }) {
  const n = { LOW: 1, MEDIUM: 2, HIGH: 3 }[risk] || 0;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-bold" style={{ color: RISK_CLR[risk] }} title={`Mission risk: ${risk}`}>
      <span className="inline-flex gap-[3px]">
        {[1, 2, 3].map((i) => (
          <motion.span
            key={i}
            className="h-[5px] w-3.5 rounded-[3px]"
            initial={{ backgroundColor: "#2c3757" }}
            animate={{ backgroundColor: i <= n ? RISK_CLR[risk] : "#2c3757" }}
            transition={{ delay: 0.2 + i * 0.12 }}
          />
        ))}
      </span>
      {risk ? `${risk[0]}${risk.slice(1).toLowerCase()} risk` : ""}
    </span>
  );
}
