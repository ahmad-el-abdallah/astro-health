// Doctor · Crew overview (AstroHealth-Redesign doctor-01) -- the Flight Surgeon's home.
// Summary strip (click a count to filter the cards), crew search, one card per crew
// member sorted by who needs attention first (status from the last 24 h; cards glide to
// their new place when a status changes live), four latest vitals, the card's most
// important flag, and the latest-alerts feed (feed.js -- real alerts + today's flags).
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { fmtTime, formatIndicatorValue } from "../../lib/format.js";
import { useAlerts, useCrew } from "../../lib/queries.js";
import { AnimatedNumber, Avatar, Card, Shimmer, StatusChip, cx } from "../../components/ui/index.jsx";
import { Icon } from "../../components/ui/Icon.jsx";
import { StateChip } from "../../components/AiAnalysisCard.jsx";
import { buildFeed, cardFlag, sortCrew } from "./feed.js";

const STATS = [
  { key: "all", label: "Crew members", icon: "crew", tone: "bg-accent-soft text-accent-text" },
  { key: "RED", label: "Need attention now", icon: "alert", tone: "bg-alert-bg text-alert-fg" },
  { key: "YELLOW", label: "To check", icon: "bell", tone: "bg-check-bg text-check-fg" },
  { key: "GRAY", label: "No reading today", icon: "no-data", tone: "bg-none-bg text-none-fg" },
];
const EDGE = { RED: "border-t-alert-fg", YELLOW: "border-t-check-fg", GREEN: "border-t-good-fg", GRAY: "border-t-line-strong" };
const DOT = { GREEN: "bg-good-fg", YELLOW: "bg-check-fg", RED: "bg-alert-fg" };
const MINI = [["heart_rate", "Heart rate"], ["blood_pressure", "BP"], ["mood", "Mood"], ["sleep", "Sleep"]];
const FLAG = {
  RED: "bg-alert-bg text-alert-fg",
  YELLOW: "bg-check-bg text-check-fg",
  GRAY: "bg-raised text-ink-2",
};
const FEED_ICON = { RED: "alert", YELLOW: "bell", GRAY: "no-data" };
const FEED_TONE = { RED: "bg-alert-bg text-alert-fg", YELLOW: "bg-check-bg text-check-fg", GRAY: "bg-none-bg text-none-fg" };

function StatCard({ stat, value, active, onClick }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        "flex min-w-0 cursor-pointer items-center gap-3.5 ah-glass rounded-card p-4 text-left transition-[border-color] duration-200",
        active ? "border-accent-text/70" : "hover:border-accent-text/40",
      )}
    >
      <span className={cx("flex h-11 w-11 shrink-0 items-center justify-center rounded-xl", stat.tone)}>
        <Icon name={stat.icon} size={20} />
      </span>
      <span className="min-w-0">
        <AnimatedNumber value={value} className="block font-display text-[28px] leading-none font-bold" />
        <span className="mt-1 block text-[13px] leading-tight text-muted">{stat.label}</span>
      </span>
    </button>
  );
}

function MiniVital({ indicator, label, reading }) {
  return (
    <div className="min-w-0 rounded-xl bg-raised px-3 py-2.5">
      <div className="truncate text-[11px] text-muted">{label}</div>
      <div className="mt-1 flex items-center gap-1.5 text-[15px] font-semibold">
        <span className={cx("h-2 w-2 shrink-0 rounded-full", DOT[reading?.level] || "bg-subtle")} />
        <span className="truncate">{reading ? formatIndicatorValue(indicator, reading.value) : "–"}</span>
      </div>
    </div>
  );
}

function CrewCard({ c }) {
  const flag = cardFlag(c);
  return (
    <Card as="article" className={cx("@container flex flex-col gap-4 border-t-[3px]", EDGE[c.status] || EDGE.GRAY)}>
      <div className="flex items-center gap-3">
        <Avatar name={c.name} color={c.color} size={46} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="m-0 truncate text-[17px] font-semibold">{c.name}</h3>
            {c.session_active && (
              <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-px text-[11px] font-semibold text-accent-text">
                <span className="h-1.5 w-1.5 animate-[ah-pulse-dot_1.6s_ease-in-out_infinite] rounded-full bg-accent-text" />on CYD
              </span>
            )}
          </div>
          <div className="truncate text-[13px] text-muted">
            {c.last_reading ? `Last reading ${fmtTime(c.last_reading)}` : "No readings yet"}
          </div>
        </div>
        <StatusChip level={c.status} text={c.status === "GRAY" ? "No data" : undefined} />
      </div>
      {c.analysis && c.status !== "GRAY" && (
        <div className="flex flex-col gap-1.5">
          <StateChip analysis={c.analysis} className="self-start" />
          <p className="m-0 line-clamp-2 text-[13px] text-ink-2" title={c.analysis.summary}>
            {c.analysis.summary}{c.analysis.source === "rules" ? " (rules)" : ""}
          </p>
        </div>
      )}
      {/* 4 across when the card itself is wide enough, otherwise 2×2 -- never truncated. */}
      <div className="grid grid-cols-2 gap-2 @md:grid-cols-4">
        {MINI.map(([ind, label]) => <MiniVital key={ind} indicator={ind} label={label} reading={c.today?.[ind]} />)}
      </div>
      {flag && (
        <div className={cx("flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-sm font-semibold", FLAG[flag.level])}>
          <Icon name={flag.level === "GRAY" ? "no-data" : "alert"} size={16} className="shrink-0" />
          <span className="min-w-0 truncate">{flag.text}</span>
        </div>
      )}
      <Link
        to={`/doctor/crew/${c.id}`}
        className="mt-auto flex min-h-11 items-center justify-center gap-2 rounded-xl bg-accent-soft text-sm font-semibold text-accent-text transition-colors hover:bg-accent hover:text-accent-on"
      >
        Open profile <Icon name="arrow-right" size={16} />
      </Link>
    </Card>
  );
}

export function FeedRow({ item, compact = false, action = null }) {
  return (
    <div className="flex items-start gap-3 rounded-xl p-2.5 transition-colors hover:bg-raised">
      <span className={cx("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", FEED_TONE[item.level])}>
        <Icon name={FEED_ICON[item.level]} size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          {item.astronautId != null ? (
            <Link to={`/doctor/crew/${item.astronautId}`} className="min-w-0 text-[15px] font-semibold text-ink hover:underline">
              <span className={compact ? "line-clamp-2" : ""}>{item.title}</span>
            </Link>
          ) : (
            <span className={cx("min-w-0 text-[15px] font-semibold", compact && "line-clamp-2")}>{item.title}</span>
          )}
          <StatusChip level={item.level} text={item.level === "GRAY" ? "No data" : undefined} plain />
        </div>
        <div className="mt-0.5 text-[13px] text-muted">
          {item.name}{item.ts ? ` · ${fmtTime(item.ts)}` : ""}{!compact && item.detail ? ` · ${item.detail}` : ""}
        </div>
      </div>
      {action}
    </div>
  );
}

export default function CrewOverview() {
  const crewQ = useCrew(true);
  const alertsQ = useAlerts(true);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");

  const crew = useMemo(() => sortCrew(crewQ.data || []), [crewQ.data]);
  const feed = useMemo(() => buildFeed(crewQ.data || [], alertsQ.data || []), [crewQ.data, alertsQ.data]);
  const counts = useMemo(() => ({
    all: crew.length,
    RED: crew.filter((c) => c.status === "RED").length,
    YELLOW: crew.filter((c) => c.status === "YELLOW").length,
    GRAY: crew.filter((c) => c.status === "GRAY").length,
  }), [crew]);
  const shown = crew.filter((c) => (filter === "all" || c.status === filter) && c.name.toLowerCase().includes(query.trim().toLowerCase()));

  if (crewQ.isLoading) {
    return (
      <div className="grid gap-[18px] md:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <Shimmer key={i} className="h-24" />)}
        <Shimmer className="h-80 md:col-span-3" />
        <Shimmer className="h-80" />
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-[18px] lg:grid-cols-4">
        {STATS.map((s) => (
          <StatCard key={s.key} stat={s} value={counts[s.key]} active={filter === s.key && s.key !== "all"} onClick={() => setFilter((f) => (f === s.key ? "all" : s.key))} />
        ))}
      </div>

      <div className="grid grid-cols-1 items-start gap-[18px] xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="flex min-w-0 flex-col gap-3.5">
          <div className="flex flex-wrap items-center gap-3 px-1">
            <h2 className="m-0 mr-auto font-display text-xl font-semibold">
              Crew members
              {filter !== "all" && (
                <button onClick={() => setFilter("all")} className="ml-2 cursor-pointer rounded-full bg-raised px-2.5 py-0.5 align-middle text-xs font-semibold text-ink-2 hover:text-ink">
                  {STATS.find((s) => s.key === filter)?.label} ✕
                </button>
              )}
            </h2>
            <label className="flex min-h-11 w-full items-center gap-2 ah-glass rounded-full px-4 text-sm sm:w-64">
              <Icon name="search" size={16} className="text-muted" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search crew"
                aria-label="Search crew"
                className="min-w-0 flex-1 border-0 bg-transparent text-ink outline-none"
              />
            </label>
          </div>
          <p className="m-0 -mt-1.5 px-1 text-[13px] text-muted">Sorted by who needs attention first · status from the last 24 h.</p>
          {shown.length === 0 ? (
            <Card className="text-sm text-muted">No crew members match.</Card>
          ) : (
            <motion.div layout className="grid gap-[18px] [grid-template-columns:repeat(auto-fill,minmax(min(100%,340px),1fr))]">
              <AnimatePresence initial={false}>
                {shown.map((c) => (
                  <motion.div key={c.id} layout initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }} transition={{ type: "spring", stiffness: 300, damping: 30 }} className="flex">
                    <div className="flex w-full [&>article]:w-full"><CrewCard c={c} /></div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </motion.div>
          )}
        </section>

        <Card className="flex flex-col gap-2 xl:sticky xl:top-5">
          <div className="flex items-center justify-between px-1">
            <h2 className="m-0 text-base font-semibold">Latest alerts</h2>
            <Link to="/doctor/alerts" className="text-sm font-semibold text-accent-text hover:underline">View all ({feed.length})</Link>
          </div>
          {feed.length === 0 ? (
            <p className="m-0 px-1 py-4 text-sm text-muted">All clear: no open alerts and nothing out of range today.</p>
          ) : (
            <div className="flex flex-col">
              {feed.slice(0, 6).map((it) => <FeedRow key={it.key} item={it} compact />)}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
