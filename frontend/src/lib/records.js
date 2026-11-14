// Crew records filters (backend/logic/records.py parse_filters): kept in the page's URL so a
// filtered view can be reloaded or shared, and sent unchanged to GET /records and to the Excel
// export. Pure helpers (tested in records.test.js) + the download.
export const CATEGORIES = [
  ["vitals", "Vitals & wearable"],
  ["checkins", "Daily check-ins"],
  ["events", "Health events"],
  ["notes", "Private notes"],
];
export const LEVELS = [["any", "All levels"], ["YELLOW", "Check or worse"], ["RED", "Alerts only"]];
export const PRESETS = [["1", "Today"], ["7", "7 days"], ["30", "30 days"], ["custom", "Custom"]];

const pad = (n) => String(n).padStart(2, "0");
export const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The from/to dates of a preset ("1" = today, "7" = the last 7 days…), in local time. */
export function presetRange(preset, now = new Date()) {
  const days = Number(preset) || 7;
  const from = new Date(now);
  from.setDate(now.getDate() - (days - 1));
  return { from: isoDay(from), to: isoDay(now) };
}

/** URL search params -> filters (missing values -> defaults: all crew, 7 days, everything). */
export function parseQuery(params, now = new Date()) {
  const get = (k) => params.get(k) || "";
  const preset = PRESETS.some(([p]) => p === get("range")) ? get("range") : "7";
  const range = preset === "custom" && get("from") && get("to") ? { from: get("from"), to: get("to") } : presetRange(preset, now);
  const cats = get("categories").split(",").filter((c) => CATEGORIES.some(([id]) => id === c));
  return {
    range: preset,
    ...range,
    astronauts: get("astronauts").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0),
    categories: cats.length ? cats : CATEGORIES.map(([id]) => id),
    level: LEVELS.some(([l]) => l === get("level")) ? get("level") : "any",
    q: get("q"),
  };
}

/** Filters -> the URL's search params (only what differs from the defaults). */
export function toQuery(f) {
  const p = new URLSearchParams();
  if (f.range !== "7") p.set("range", f.range);
  if (f.range === "custom") { p.set("from", f.from); p.set("to", f.to); }
  if (f.astronauts.length) p.set("astronauts", f.astronauts.join(","));
  if (f.categories.length !== CATEGORIES.length) p.set("categories", f.categories.join(","));
  if (f.level !== "any") p.set("level", f.level);
  if (f.q.trim()) p.set("q", f.q.trim());
  return p;
}

/** What the API gets: explicit dates + this browser's time zone (minutes east of UTC). */
export function apiQuery(f, now = new Date()) {
  const p = new URLSearchParams({ from: f.from, to: f.to, tz: String(-now.getTimezoneOffset()) });
  if (f.astronauts.length) p.set("astronauts", f.astronauts.join(","));
  p.set("categories", f.categories.join(","));
  if (f.level !== "any") p.set("level", f.level);
  if (f.q.trim()) p.set("q", f.q.trim());
  return p.toString();
}

/** Download the Excel file for these filters. Resolves to the file name. */
export async function downloadExcel(f) {
  const res = await fetch(`/api/records/export.xlsx?${apiQuery(f)}`, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`export failed (${res.status})`);
  const name = /filename=([^;]+)/.exec(res.headers.get("Content-Disposition") || "")?.[1] || "crew-records.xlsx";
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return name;
}
