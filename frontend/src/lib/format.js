// Pure display helpers, ported from the old tabs. Kept framework-free so they can be
// unit tested (format.test.js).

// "sleep" and "mood" readings have two writers storing two different value shapes for
// the same indicator: a physical object tag / CYD tap stores a bare number, while the
// web Sleep lab / Mind & mood pages store a richer object ({hours,bedtime,wake_time} /
// {mood,score,note}). Every reader must accept both (docs/CLAUDE.md, 2026-11-10).
export function sleepHours(value) {
  return Number(typeof value === "object" && value ? value.hours : value);
}

export function moodScore(value) {
  return Number(typeof value === "object" && value ? value.score : value);
}

export const MOOD_LABELS = { 1: "Rough", 2: "Low", 3: "Okay", 4: "Good", 5: "Great" };

export function formatHours(hours) {
  if (hours == null || Number.isNaN(hours)) return "–";
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${h}h ${m}m`;
}

// One number per reading, for charts (blood pressure → systolic).
export function numericValue(indicator, value) {
  if (value == null) return null;
  if (indicator === "sleep") return sleepHours(value);
  if (indicator === "mood") return moodScore(value);
  if (indicator === "blood_pressure") return typeof value === "object" ? value.systolic : value;
  if (indicator === "reaction_time") return typeof value === "object" ? value.avg_ms : value;
  return typeof value === "object" ? Number(Object.values(value)[0]) : Number(value);
}

export function formatIndicatorValue(indicator, value) {
  if (value == null) return "–";
  if (indicator === "blood_pressure") return `${value.systolic}/${value.diastolic}`;
  if (indicator === "reaction_time") return `${typeof value === "object" ? value.avg_ms : value} ms`;
  if (indicator === "sleep") return formatHours(sleepHours(value));
  if (indicator === "mood") {
    if (typeof value === "object" && value.mood) return value.mood.charAt(0).toUpperCase() + value.mood.slice(1);
    return MOOD_LABELS[Number(value)] || String(value);
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export const INDICATORS = {
  heart_rate: { label: "Heart rate", unit: "bpm" },
  blood_pressure: { label: "Blood pressure", unit: "mmHg" },
  blood_sugar: { label: "Blood sugar", unit: "mg/dL" },
  temperature: { label: "Temperature", unit: "°C" },
  oxygen_saturation: { label: "Blood oxygen", unit: "%" },
  // From the live wearable (a replayed real crew recording -- backend/logic/sensor_feed.py).
  respiration_rate: { label: "Breathing rate", unit: "/min" },
  stress: { label: "Stress", unit: "/100" },
  sleep: { label: "Sleep", unit: "" },
  mood: { label: "Mood", unit: "" },
  exercise: { label: "Exercise", unit: "min" },
  water: { label: "Water", unit: "ml" },
  reaction_time: { label: "Reaction time", unit: "" },
  // Spacewalk suit sensors -- only shown and counted while the astronaut is outside (EVA).
  suit_co2: { label: "Suit CO2", unit: "mmHg" },
  suit_pressure: { label: "Suit pressure", unit: "psi" },
  suit_o2: { label: "Oxygen supply", unit: "%" },
};
export const SUIT_INDICATORS = ["suit_co2", "suit_pressure", "suit_o2"];

export function fmtTime(iso) {
  if (!iso) return "never";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function fmtClock(iso) {
  if (!iso) return "–";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function initials(name = "") {
  return name.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();
}

export function formatCountdown(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
