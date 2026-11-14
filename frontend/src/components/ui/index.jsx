// Shared building blocks from design-system/DESIGN-SYSTEM.md §6 (cards, tiles, status
// chips, buttons, segmented control, progress, animated numbers), styled with the
// role-aware Tailwind tokens from src/styles/index.css.
import { useEffect } from "react";
import { motion, useMotionValue, useSpring, useTransform } from "motion/react";
import { LEVEL_WORD } from "../../lib/levels.js";
import { initials } from "../../lib/format.js";
import { rise } from "./motion.js";
import { Icon } from "./Icon.jsx";

export function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

export function Card({ as = "section", className = "", hover = false, children, ...rest }) {
  const Comp = motion[as] || motion.section;
  return (
    <Comp
      variants={rise}
      whileHover={hover ? { y: -2, transition: { duration: 0.2 } } : undefined}
      className={cx("ah-glass rounded-card-l p-5", className)}
      {...rest}
    >
      {children}
    </Comp>
  );
}

export function CardTitle({ eyebrow, title, subtitle, right, className = "" }) {
  return (
    <div className={cx("mb-4 flex flex-wrap items-start justify-between gap-3", className)}>
      <div className="min-w-0 flex-[1_1_14rem]">
        {eyebrow && <div className="ah-eyebrow mb-1">{eyebrow}</div>}
        {title && <h2 className="m-0 text-title font-semibold text-ink">{title}</h2>}
        {subtitle && <p className="m-0 mt-1 text-label text-muted">{subtitle}</p>}
      </div>
      {right && <div className="max-w-full shrink-0 self-center">{right}</div>}
    </div>
  );
}

const CHIP = {
  GREEN: "bg-good-bg text-good-fg",
  YELLOW: "bg-check-bg text-check-fg",
  RED: "bg-alert-bg text-alert-fg",
  GRAY: "bg-none-bg text-none-fg",
};

// Never color alone: every status chip has a dot + a word (Good / Check / Alert / No data).
export function StatusChip({ level = "GRAY", label, text, className = "", plain = false }) {
  const lvl = CHIP[level] ? level : "GRAY";
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-[3px] text-xs font-bold transition-colors duration-300",
        CHIP[lvl],
        className,
      )}
    >
      {!plain && (
        <span
          className="h-1.5 w-1.5 rounded-full bg-current"
        />
      )}
      {label ? `${label}: ` : ""}
      {text ?? LEVEL_WORD[lvl]}
    </span>
  );
}

const BTN = {
  // The one call to action on a card/page: solid accent, bold, a little wider. No glow.
  primary: "bg-accent text-accent-on font-bold px-5 hover:bg-accent-hover",
  secondary: "bg-control text-ink border border-line-strong hover:border-accent-text/60",
  ghost: "bg-transparent text-ink-2 hover:bg-raised",
  danger: "bg-alert-action text-bg font-bold hover:brightness-110",
  pill: "rounded-full bg-raised border border-line text-ink text-label hover:border-accent-text/50",
};

// busy: shows a spinner and blocks clicks while the action runs (the label can say what's
// happening, e.g. "Saving…"). The press scale is the only motion: it's feedback.
export function Button({ variant = "secondary", className = "", busy = false, disabled, children, ...rest }) {
  return (
    <motion.button
      whileTap={{ scale: 0.97 }}
      transition={{ duration: 0.12 }}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        "inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition-[background-color,border-color,opacity] duration-200 disabled:cursor-not-allowed disabled:opacity-50",
        BTN[variant],
        className,
      )}
      {...rest}
    >
      {busy && <Spinner />}
      {children}
    </motion.button>
  );
}

export function Spinner({ size = 14, className = "" }) {
  return (
    <span
      aria-hidden="true"
      className={cx("inline-block shrink-0 animate-[ah-spin_.7s_linear_infinite] rounded-full border-2 border-current border-r-transparent", className)}
      style={{ width: size, height: size }}
    />
  );
}

export function IconButton({ label, className = "", children, ...rest }) {
  return (
    <motion.button
      whileTap={{ scale: 0.95 }}
      aria-label={label}
      title={label}
      className={cx(
        "relative inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full border border-line bg-raised text-ink-2 hover:text-ink",
        className,
      )}
      {...rest}
    >
      {children}
    </motion.button>
  );
}

// Radio-group style switcher with a sliding selected pill (shared layoutId).
export function Segmented({ options, value, onChange, id = "seg", className = "", size = "md" }) {
  return (
    <div role="radiogroup" className={cx("inline-flex flex-wrap gap-1 rounded-[14px] border border-line bg-input p-1", className)}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(o.value)}
            className={cx(
              "relative cursor-pointer rounded-[10px] px-3.5 text-label transition-colors duration-200",
              size === "sm" ? "min-h-8" : "min-h-9",
              selected ? "font-semibold text-accent-on" : "text-ink-2 hover:text-ink",
            )}
          >
            {selected && (
              <motion.span
                layoutId={`${id}-pill`}
                className="absolute inset-0 rounded-[10px] bg-accent"
                transition={{ type: "spring", stiffness: 420, damping: 36 }}
              />
            )}
            <span className="relative">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function Progress({ value = 0, className = "" }) {
  return (
    <div className={cx("h-2 overflow-hidden rounded bg-line-strong", className)}>
      <motion.div
        className="h-full origin-left rounded bg-chart-line"
        initial={{ scaleX: 0 }}
        animate={{ scaleX: Math.max(0, Math.min(1, value)) }}
        transition={{ type: "spring", stiffness: 90, damping: 20 }}
      />
    </div>
  );
}

// Counts smoothly to its value; re-tweens whenever the value changes (live updates).
export function AnimatedNumber({ value, decimals = 0, className = "" }) {
  const target = Number(value);
  const mv = useMotionValue(0);
  const smooth = useSpring(mv, { stiffness: 90, damping: 20, mass: 0.6 });
  const text = useTransform(smooth, (v) => v.toFixed(decimals));
  useEffect(() => { if (!Number.isNaN(target)) mv.set(target); }, [target, mv]);
  if (value == null || Number.isNaN(target)) return <span className={cx("ah-num", className)}>–</span>;
  return <motion.span className={cx("ah-num", className)}>{text}</motion.span>;
}

const RING = { GREEN: "ring-good-fg", YELLOW: "ring-check-fg", RED: "ring-alert-fg", GRAY: "ring-line-strong" };

export function Avatar({ name, color, level, size = 42, className = "" }) {
  return (
    <div
      className={cx(
        "flex shrink-0 items-center justify-center rounded-full font-display font-bold",
        color ? "text-[#0b1020]" : "bg-accent-soft text-accent-text",
        level && "ring-2 ring-offset-2 ring-offset-surface",
        level && RING[level],
        className,
      )}
      style={{ width: size, height: size, background: color || undefined, fontSize: size * 0.4 }}
    >
      {initials(name)}
    </div>
  );
}

export function Shimmer({ className = "" }) {
  return (
    <div aria-hidden="true" className={cx("relative overflow-hidden rounded-card-l bg-raised", className)}>
      <div className="absolute inset-0 animate-[ah-shimmer_1.4s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-white/5 to-transparent" />
    </div>
  );
}

export function Field({ label, hint, children, className = "" }) {
  return (
    <label className={cx("flex flex-col gap-1.5", className)}>
      <span className="text-label font-medium text-ink">{label}</span>
      {children}
      {hint}
    </label>
  );
}

// A trend in words with a matching icon -- one look everywhere (Mind, Overview, profile).
// direction: "up" | "down" | "flat" | null (no trend yet).
const TREND = { up: ["trend-up", "Improving"], down: ["trend-down", "Lower"], flat: ["trend-flat", "Stable"] };
export function TrendLabel({ direction, text, className = "" }) {
  const [icon, word] = TREND[direction] || [null, text || "–"];
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-xs font-semibold text-accent-text", className)}>
      {icon && <Icon name={icon} size={14} />}
      {text || word}
    </span>
  );
}
