// Shared motion presets so every page moves the same way. Durations/easing are the
// design tokens (design-system/tokens.json → motion): fast 200ms, base 300ms, enter
// 900ms on cubic-bezier(.2,.7,.2,1). Only transform + opacity are ever animated.
export const EASE_ENTER = [0.2, 0.7, 0.2, 1];

export const page = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.32, ease: EASE_ENTER, staggerChildren: 0.04, delayChildren: 0.02 } },
  exit: { opacity: 0, y: -4, transition: { duration: 0.15, ease: "easeIn" } },
};

// Children of a stagger container fade up one after another.
export const stagger = {
  initial: {},
  animate: { transition: { staggerChildren: 0.04 } },
};

export const rise = {
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE_ENTER } },
};

export const spring = { type: "spring", stiffness: 380, damping: 34, mass: 0.9 };
export const softSpring = { type: "spring", stiffness: 120, damping: 20 };
