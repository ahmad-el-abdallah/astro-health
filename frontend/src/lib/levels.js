// GREEN / YELLOW / RED / GRAY helpers, ported from the old body.js + trends.js.
export const LEVEL_RANK = { GRAY: -1, GREEN: 0, YELLOW: 1, RED: 2 };
export const LEVEL_WORD = { GREEN: "Good", YELLOW: "Check", RED: "Alert", GRAY: "No data" };

// Raw colors for SVG/WebGL (CSS classes can't reach inside a <canvas>). Status chip
// foregrounds from design-system/tokens.json.
export const LEVEL_HEX = { GREEN: "#5fe0a0", YELLOW: "#f5cd63", RED: "#ff8a8a", GRAY: "#8a94b2" };

export function worse(a, b) {
  return (LEVEL_RANK[a] ?? -1) >= (LEVEL_RANK[b] ?? -1) ? a : b;
}

export function worstOf(levels) {
  return levels.reduce((acc, l) => worse(acc, l), "GRAY");
}

// 0-10 discomfort slider → level band (same thresholds the backend's
// /discomfort/report recomputes server-side).
export function bandFromIntensity(n) {
  return n >= 7 ? "RED" : n >= 4 ? "YELLOW" : "GREEN";
}

// A body region's displayed level = the worse of its vitals level and its discomfort.
// GRAY (no vitals today) counts as GREEN here so discomfort alone can still flag it.
export function blendedLevel(region, bodyLevels = {}, discomfort = {}) {
  const vitals = !bodyLevels[region] || bodyLevels[region] === "GRAY" ? "GREEN" : bodyLevels[region];
  return worse(vitals, bandFromIntensity(discomfort[region] || 0));
}

// Shaded GREEN/YELLOW bands behind a chart, from config/health_rules.json via
// GET /health-rules (port of trends.js's bandsFor()).
//   * range indicators (heart rate, sugar, temp, mood): green [lo,hi] + yellow ranges
//   * blood pressure: charted as systolic, so its systolic_green / systolic_yellow
//   * "higher is better" (sleep, exercise, water): green_min.. and yellow_min..green_min
export function bandsFor(rules, indicator) {
  const cfg = rules?.indicators?.[indicator];
  if (!cfg) return [];
  const green = cfg.green || cfg.systolic_green;
  const yellow = cfg.yellow || cfg.systolic_yellow;
  if (green) {
    const bands = [{ lo: green[0], hi: green[1], kind: "normal" }];
    (yellow || []).forEach((r) => bands.push({ lo: r[0], hi: r[1], kind: "caution" }));
    return bands;
  }
  if (cfg.green_min != null) {
    const bands = [{ lo: cfg.green_min, hi: cfg.max ?? Infinity, kind: "normal" }];
    if (cfg.yellow_min != null) bands.push({ lo: cfg.yellow_min, hi: cfg.green_min, kind: "caution" });
    return bands;
  }
  return [];
}
