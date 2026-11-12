// The Flight Surgeon's alert feed, built from real data only:
// - every open (unacknowledged) alert from the alerts table -- RED by design (a RED
//   assessment, a RED discomfort report, or one the crew member asked Astra to send);
// - today's out-of-range readings and symptom reports from each crew card's snapshot;
// - crew members with no reading in the last 24 h.
// Pure (unit-tested in feed.test.js); the Crew overview shows the top few, the Alerts
// page all of them with filters.
import { fmtTime, formatIndicatorValue, INDICATORS, numericValue } from "../../lib/format.js";
import { bandsFor } from "../../lib/levels.js";

const RANK = { RED: 0, YELLOW: 1, GRAY: 2 };
const UNIT = { heart_rate: "bpm", blood_pressure: "mmHg", blood_sugar: "mg/dL", temperature: "°C", oxygen_saturation: "%", exercise: "min", water: "ml" };

function alertTitle(text = "") {
  // Assessment alerts read "RED: heart rate, temperature".
  if (/^RED:\s*/i.test(text)) return `Flagged: ${text.replace(/^RED:\s*/i, "")}`;
  return text.length > 80 ? `${text.slice(0, 77)}…` : text || "Alert";
}

// "Above the normal range of 60–100 bpm" -- from config/health_rules.json via bandsFor().
function rangeDetail(indicator, value, rules) {
  const normal = bandsFor(rules, indicator).find((b) => b.kind === "normal");
  const n = numericValue(indicator, value);
  if (!normal || !Number.isFinite(n)) return "Outside the normal range";
  const unit = UNIT[indicator] ? ` ${UNIT[indicator]}` : "";
  const range = Number.isFinite(normal.hi) ? `${normal.lo}–${normal.hi}${unit}` : `${normal.lo}${unit} or more`;
  if (n > normal.hi) return `Above the normal range of ${range}`;
  if (n < normal.lo) return `Below the normal range of ${range}`;
  return `Outside the normal range of ${range}`;
}

export function buildFeed(crew = [], alerts = [], rules = null) {
  const byId = new Map(crew.map((c) => [c.id, c]));
  const items = [];
  alerts.filter((a) => !a.acknowledged).forEach((a) => {
    items.push({
      key: `alert-${a.id}`, kind: "alert", alertId: a.id, level: a.level === "YELLOW" ? "YELLOW" : "RED",
      title: alertTitle(a.text),
      detail: a.astronaut_id == null ? "Emergency raised on the station" : /^RED:/i.test(a.text || "") ? "Red result in an assessment" : "Sent to the Flight Surgeon",
      // An SOS from the station (CYD button / emergency tag with nobody signed in) has no crew member.
      astronautId: a.astronaut_id ?? null,
      name: a.astronaut_id == null ? "Station SOS" : byId.get(a.astronaut_id)?.name || "Crew member",
      ts: a.ts,
    });
  });
  crew.forEach((c) => {
    Object.entries(c.today || {}).forEach(([ind, r]) => {
      if (r.level !== "YELLOW" && r.level !== "RED") return;
      const unit = UNIT[ind] ? ` ${UNIT[ind]}` : "";
      items.push({
        key: `reading-${c.id}-${ind}`, kind: "reading", level: r.level,
        title: `${INDICATORS[ind]?.label || ind} ${formatIndicatorValue(ind, r.value)}${unit}`,
        detail: rangeDetail(ind, r.value, rules), astronautId: c.id, name: c.name, ts: r.ts,
      });
    });
    const s = c.symptoms_today;
    if (s && (s.level === "YELLOW" || s.level === "RED") && s.items?.length) {
      items.push({
        key: `symptom-${c.id}`, kind: "symptom", level: s.level,
        title: `Symptom: ${s.items.map((i) => i.replace(/_/g, " ")).join(", ")}`,
        detail: "Symptom reported by the crew member", astronautId: c.id, name: c.name, ts: s.ts,
      });
    }
    if (c.status === "GRAY") {
      items.push({
        key: `nodata-${c.id}`, kind: "nodata", level: "GRAY", title: "No reading in 24 h",
        detail: c.last_reading ? `Last reading ${fmtTime(c.last_reading)}` : "No readings yet", astronautId: c.id, name: c.name, ts: c.last_reading || null,
      });
    }
  });
  return items.sort((a, b) => (RANK[a.level] - RANK[b.level]) || String(b.ts || "").localeCompare(String(a.ts || "")));
}

/** Crew cards: who needs attention first (RED, YELLOW, no data, then GREEN), then by name. */
const CARD_RANK = { RED: 0, YELLOW: 1, GRAY: 2, GREEN: 3 };
export function sortCrew(crew = []) {
  return [...crew].sort((a, b) => (CARD_RANK[a.status] ?? 4) - (CARD_RANK[b.status] ?? 4) || a.name.localeCompare(b.name));
}

/** The one line a crew card highlights, most important first. */
export function cardFlag(c) {
  const s = c.symptoms_today;
  if (s && s.level === "RED" && s.items?.length) return { level: "RED", text: `Symptom reported: ${s.items.map((i) => i.replace(/_/g, " ")).join(", ")}` };
  if (c.open_alert) return { level: "RED", text: alertTitle(c.open_alert.text) };
  if (s && s.level === "YELLOW" && s.items?.length) return { level: "YELLOW", text: `Symptom reported: ${s.items.map((i) => i.replace(/_/g, " ")).join(", ")}` };
  if (c.status === "GRAY") return { level: "GRAY", text: "No reading in the last 24 h" };
  return null;
}
