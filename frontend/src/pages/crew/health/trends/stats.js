// Pure analytics behind the Trends page: summary stats, period comparison, trend slope,
// weekday pattern, normal-range streaks and plain-language insights. No React, no fetching
// -- unit-tested in stats.test.js. A "point" is { t: Date, y: number, y2?: number, level }
// (y2 = diastolic for blood pressure).
import { formatHours, MOOD_LABELS } from "../../../../lib/format.js";

const DAY_MS = 864e5;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Which way is "better" (for coloring a change). null = neither: for vitals a move in
// either direction can matter, so the change is shown neutrally.
export const BETTER = { oxygen_saturation: "up", sleep: "up", exercise: "up", water: "up", mood: "up", reaction_time: "down" };
export const UNIT = { heart_rate: "bpm", blood_pressure: "mmHg", blood_sugar: "mg/dL", temperature: "°C", oxygen_saturation: "%", exercise: "min", water: "ml", reaction_time: "ms" };

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** A value as the page shows it, e.g. "78 bpm", "36.8 °C", "7h 20m", "120/80 mmHg". */
export function fmtValue(indicator, y, y2, { unit = true, avg = false } = {}) {
  if (y == null || Number.isNaN(y)) return "–";
  const u = unit && UNIT[indicator] ? ` ${UNIT[indicator]}` : "";
  if (indicator === "blood_pressure") return `${Math.round(y)}${y2 != null ? `/${Math.round(y2)}` : ""}${u}`;
  if (indicator === "temperature") return `${y.toFixed(1)}${u}`;
  if (indicator === "sleep") return formatHours(y);
  if (indicator === "mood") return avg ? `${y.toFixed(1)} / 5` : MOOD_LABELS[Math.round(y)] || String(y);
  return `${Math.round(y)}${u}`;
}

/** Splits a 2×days series into this period and the one before it. */
export function splitPeriods(points, days, now = Date.now()) {
  const cut = now - days * DAY_MS;
  return {
    current: points.filter((p) => p.t.getTime() >= cut),
    previous: points.filter((p) => p.t.getTime() < cut && p.t.getTime() >= cut - days * DAY_MS),
  };
}

// Longest run of consecutive calendar days that had readings, all of them GREEN.
function bestNormalStreak(points) {
  const byDay = new Map();
  points.forEach((p) => {
    const k = dayKey(p.t);
    const ok = p.level === "GREEN";
    byDay.set(k, { date: new Date(p.t.getFullYear(), p.t.getMonth(), p.t.getDate()), ok: (byDay.get(k)?.ok ?? true) && ok });
  });
  const days = [...byDay.values()].sort((a, b) => a.date - b.date);
  let best = 0, run = 0, prev = null;
  days.forEach((d) => {
    const consecutive = prev && Math.round((d.date - prev) / DAY_MS) === 1;
    run = d.ok ? (consecutive ? run + 1 : 1) : 0;
    best = Math.max(best, run);
    prev = d.date;
  });
  return best;
}

/** Least-squares slope of y over time, per week (null with too little data). */
export function slopePerWeek(points) {
  if (points.length < 3) return null;
  const t0 = points[0].t.getTime();
  const xs = points.map((p) => (p.t.getTime() - t0) / DAY_MS);
  if (xs.at(-1) - xs[0] < 2) return null;
  const mx = mean(xs), my = mean(points.map((p) => p.y));
  let num = 0, den = 0;
  points.forEach((p, i) => { num += (xs[i] - mx) * (p.y - my); den += (xs[i] - mx) ** 2; });
  return den ? (num / den) * 7 : null;
}

/** "Rising" / "Falling" / "Steady": a move under 2% of the average per week counts as steady. */
export function trendWord(slope, avg) {
  if (slope == null) return null;
  if (Math.abs(slope) < Math.max(Math.abs(avg) * 0.02, 1e-9)) return "Steady";
  return slope > 0 ? "Rising" : "Falling";
}

export function summarize(points, days) {
  if (!points?.length) return null;
  let min = points[0], max = points[0];
  points.forEach((p) => { if (p.y < min.y) min = p; if (p.y > max.y) max = p; });
  const levels = { GREEN: 0, YELLOW: 0, RED: 0 };
  points.forEach((p) => { if (p.level in levels) levels[p.level] += 1; });
  const y2s = points.map((p) => p.y2).filter((v) => Number.isFinite(v));
  const avg = mean(points.map((p) => p.y));
  const slope = slopePerWeek(points);
  return {
    count: points.length,
    avg,
    avg2: y2s.length ? mean(y2s) : null,
    min,
    max,
    latest: points.at(-1),
    levels,
    rated: levels.GREEN + levels.YELLOW + levels.RED,
    normalShare: levels.GREEN + levels.YELLOW + levels.RED ? levels.GREEN / (levels.GREEN + levels.YELLOW + levels.RED) : null,
    // A rolling N-day window can touch N+1 calendar days; never report "31 of 30".
    daysLogged: Math.min(new Set(points.map((p) => dayKey(p.t))).size, days),
    days,
    slope,
    trend: trendWord(slope, avg),
    streak: bestNormalStreak(points),
  };
}

/** Change of the average vs the previous period. */
export function compare(cur, prev) {
  if (!cur || !prev) return null;
  const delta = cur.avg - prev.avg;
  return { delta, pct: prev.avg ? (delta / Math.abs(prev.avg)) * 100 : null, prevAvg: prev.avg, prevAvg2: prev.avg2 };
}

/** Average per weekday, Monday first; days with no readings have avg null. */
export function weekdayAverages(points) {
  const buckets = WEEKDAYS.map((day) => ({ day, ys: [] }));
  points.forEach((p) => buckets[(p.t.getDay() + 6) % 7].ys.push(p.y));
  return buckets.map((b) => ({ day: b.day, avg: b.ys.length ? mean(b.ys) : null, n: b.ys.length }));
}

/** Rates a value against the configured bands (for the weekday bars). */
export function levelFor(y, bands) {
  if (!bands?.length || y == null) return "GRAY";
  const inBand = (b) => y >= b.lo && y <= b.hi;
  if (bands.some((b) => b.kind === "normal" && inBand(b))) return "GREEN";
  if (bands.some((b) => b.kind === "caution" && inBand(b))) return "YELLOW";
  return "RED";
}

const fmtDay = (d) => d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

/**
 * Up to five plain-language observations, each { tone: "good"|"check"|"info", text }.
 * Descriptive only -- what the numbers show, never advice.
 */
export function insights({ indicator, label, stats, change, recentOut = null }) {
  if (!stats) return [];
  const out = [];
  const f = (y, y2, o) => fmtValue(indicator, y, y2, o);

  if (stats.rated) {
    const pct = Math.round(stats.normalShare * 100);
    out.push({
      tone: pct >= 80 ? "good" : "check",
      text: `${stats.levels.GREEN} of ${stats.rated} readings (${pct}%) were in the normal range.`,
    });
    const outside = stats.rated - stats.levels.GREEN;
    if (outside > 0 && stats.days > 7 && recentOut != null) {
      if (recentOut / outside >= 0.6) {
        out.push({ tone: "check", text: `Most out-of-range readings (${recentOut} of ${outside}) happened in the last 7 days.` });
      } else if (recentOut === 0) {
        out.push({ tone: "good", text: `None of the ${outside} out-of-range reading${outside > 1 ? "s" : ""} were in the last 7 days.` });
      }
    }
  }

  if (change && change.pct != null && Number.isFinite(change.pct)) {
    const p = Math.abs(change.pct);
    const better = BETTER[indicator];
    const up = change.delta > 0;
    const word = p < 2 ? "about the same as" : `${p.toFixed(p < 10 ? 1 : 0)}% ${up ? "higher" : "lower"} than`;
    const tone = p < 2 || !better ? "info" : (better === "up") === up ? "good" : "check";
    out.push({
      tone,
      text: `Average ${label.toLowerCase()} is ${word} the previous ${stats.days} days (${f(stats.avg, stats.avg2, { avg: true })} vs ${f(change.prevAvg, change.prevAvg2, { avg: true })}).`,
    });
  }

  if (stats.count > 1 && stats.max.y !== stats.min.y) {
    out.push({
      tone: "info",
      text: `Highest ${f(stats.max.y, stats.max.y2)} on ${fmtDay(stats.max.t)}; lowest ${f(stats.min.y, stats.min.y2)} on ${fmtDay(stats.min.t)}.`,
    });
  }

  if (stats.streak >= 3) {
    out.push({ tone: "good", text: `Longest run in the normal range: ${stats.streak} days in a row.` });
  }

  const share = stats.daysLogged / stats.days;
  out.push({
    tone: share >= 0.7 ? "good" : "info",
    text: `Logged on ${stats.daysLogged} of the last ${stats.days} days${share < 0.5 ? " -- more regular readings make these trends more reliable" : ""}.`,
  });
  return out.slice(0, 5);
}

/** Out-of-range readings within the last 7 days (feeds the "recent" insight). */
export function recentOutOfRange(points, now = Date.now()) {
  const cut = now - 7 * DAY_MS;
  return points.filter((p) => p.t.getTime() >= cut && (p.level === "YELLOW" || p.level === "RED")).length;
}
