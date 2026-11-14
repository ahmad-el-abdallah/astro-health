// Real spacewalk history while on EVA (backend/logic/eva_history.py): NASA's EVA log, 375 US
// and Russian/Soviet spacewalks from 1965 to 2013. Shows how this spacewalk's length compares
// with the 368 completed ones (a bar with the typical length, the 90% mark and the record),
// and -- when a suit reading isn't green -- real past spacewalks that had that same problem.
// The suit readings themselves stay simulated; this card is the real-data context.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get } from "../lib/api.js";
import { useLocationStatus } from "../lib/queries.js";
import { Card, CardTitle, cx } from "./ui/index.jsx";

const SUIT_PROBLEMS = ["suit_co2", "suit_pressure", "suit_o2"]; // keys of the server's incidents
const h1 = (h) => (Math.round(h * 10) / 10).toFixed(1); // 7.35 -> "7.4" (toFixed alone gives "7.3")
const hm = (h) => `${Math.floor(h)} h ${String(Math.round((h % 1) * 60)).padStart(2, "0")} min`;

/** Where `hours` sits on a bar that ends at `max` hours, in percent (0..100). */
export function barPosition(hours, max) {
  return Math.max(0, Math.min(100, (hours / max) * 100));
}

export function EvaHistoryCard({ astroId, summary }) {
  const loc = useLocationStatus(astroId);
  const hist = useQuery({ queryKey: ["eva-history"], queryFn: () => get("/eva-history"), staleTime: Infinity });
  const [now, setNow] = useState(() => Date.now());
  const eva = loc.data?.location === "eva";
  useEffect(() => {
    if (!eva) return undefined;
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, [eva]);
  if (!eva || !hist.data) return null;
  const { stats, incidents, labels, source } = hist.data;
  const minutes = Math.max(0, (loc.data.mission_min || 0) + ((now - loc.dataUpdatedAt) / 60000) * (loc.data.time_scale || 1));
  const hours = minutes / 60;
  const scale = Math.max(stats.record.hours * 1.1, hours * 1.05);
  const shorter = Math.round(100 * (stats.done_hours || []).filter((h) => h < hours).length / Math.max(1, (stats.done_hours || []).length));
  const phrase = hours > stats.record.hours ? "Longer than every spacewalk in the NASA log"
    : hours >= stats.p90_h ? `Longer than ${shorter}% of real spacewalks: most had ended by ${h1(stats.p90_h)} h`
    : shorter < 5 ? `Just getting started: a typical spacewalk lasts ${h1(stats.median_h)} h`
    : `Longer than ${shorter}% of real spacewalks`;
  const tone = hours > stats.record.hours ? "text-alert-fg" : hours >= stats.p90_h ? "text-check-fg" : "text-ink";
  const today = summary?.today || {};
  const bad = SUIT_PROBLEMS.filter((k) => ["YELLOW", "RED"].includes(today[k]?.level));
  const marks = [
    { h: stats.median_h, label: `Typical ${h1(stats.median_h)} h` },
    { h: stats.p90_h, label: `90% had ended by ${h1(stats.p90_h)} h` },
    { h: stats.record.hours, label: `Record ${h1(stats.record.hours)} h` },
  ];

  return (
    <Card className="flex flex-col gap-4">
      <CardTitle
        eyebrow="Spacewalk history"
        title={`This spacewalk: ${hm(hours)}`}
        subtitle={`Compared with ${stats.completed} real spacewalks, ${stats.first_year}–${stats.last_year} (USA ${stats.by_country.USA ?? 0}, Russia ${stats.by_country.Russia ?? 0}).`}
        className="mb-0"
      />
      <div className="flex flex-col gap-2">
        <p className={cx("m-0 text-body font-semibold", tone)}>{phrase}</p>
        <div className="relative h-3 rounded-full bg-raised" role="img" aria-label={`${hm(hours)} so far; typical ${stats.median_h} h, record ${stats.record.hours} h`}>
          <div className={cx("absolute inset-y-0 left-0 rounded-full", hours >= stats.p90_h ? "bg-check-fg" : "bg-accent")} style={{ width: `${barPosition(hours, scale)}%` }} />
          {marks.map((m) => <span key={m.label} className="absolute -top-1 h-5 w-0.5 bg-ink-2/70" style={{ left: `${barPosition(m.h, scale)}%` }} />)}
        </div>
        <div className="relative h-4 text-caption text-muted" aria-hidden="true">
          {marks.map((m, i) => (
            <span key={m.label} className={cx("ah-num absolute top-0 whitespace-nowrap", i === marks.length - 1 ? "-translate-x-full" : "-translate-x-1/2")}
              style={{ left: `${barPosition(m.h, scale)}%` }}>{h1(m.h)} h</span>
          ))}
        </div>
        <p className="m-0 text-caption text-muted">Marks: typical length · 90% had ended · record</p>
        <p className="m-0 text-caption text-muted">
          Record: {stats.record.crew}, {stats.record.vehicle}, {stats.record.date}.
        </p>
      </div>
      {bad.length > 0 && (
        <div className="flex flex-col gap-2 rounded-[var(--radius-inner)] bg-raised p-3">
          <div className="text-label font-semibold text-check-fg">Real spacewalks that had this problem</div>
          {bad.map((k) => (incidents[k] || []).slice(0, 2).map((i) => (
            <div key={k + i.what} className="text-label text-ink-2">
              <span className="font-semibold text-ink">{labels[k]}</span>
              {" · "}{i.vehicle}{i.date ? `, ${i.date}` : ""}{i.crew ? ` (${i.crew})` : ""}: {i.what}
            </div>
          )))}
        </div>
      )}
      <p className="m-0 text-caption text-subtle">Source: {source}. Suit readings in this app are simulated.</p>
    </Card>
  );
}
