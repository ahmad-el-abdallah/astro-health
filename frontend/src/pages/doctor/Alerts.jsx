// Doctor · Alerts & notifications (AstroHealth-Redesign doctor-02; replaces the old Flight
// Surgeon tab's alert inbox). The same feed as the Crew overview (feed.js: open alerts +
// today's out-of-range readings, symptoms and no-data), here in full:
// - severity tabs with live counts, and a crew-member filter;
// - grouped by day, each row with a plain-language detail line and the crew member;
// - Acknowledge per alert (optimistic: the row slides away at once) and Acknowledge all;
//   other open doctor screens update too (the server broadcasts "alert_acknowledged");
// - "Show acknowledged" brings back the history of handled alerts.
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { post } from "../../lib/api.js";
import { useAlerts, useCrew, useHealthRules } from "../../lib/queries.js";
import { Avatar, Button, Card, Segmented, Shimmer, StatusChip, cx } from "../../components/ui/index.jsx";
import { Icon } from "../../components/ui/Icon.jsx";
import { useToast } from "../../components/overlays/Toasts.jsx";
import { buildFeed } from "./feed.js";

const ICON = { RED: "alert", YELLOW: "bell", GRAY: "no-data" };
const TONE = { RED: "bg-alert-bg text-alert-fg", YELLOW: "bg-check-bg text-check-fg", GRAY: "bg-none-bg text-none-fg" };
const LEVEL_TAB = [["all", "All"], ["RED", "Alert"], ["YELLOW", "Check"], ["GRAY", "No data"]];

const time = (iso) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "");

function dayLabel(date, now) {
  const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
  const d = new Date(date); d.setHours(0, 0, 0, 0);
  const diff = Math.round((d0 - d) / 864e5);
  const md = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (diff === 0) return `Today · ${md}`;
  if (diff === 1) return `Yesterday · ${md}`;
  return date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

function AlertRow({ item, crewById, onAck, busy }) {
  const person = item.astronautId != null ? crewById.get(item.astronautId) : null;
  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: item.acked ? 0.6 : 1, y: 0 }}
      exit={{ opacity: 0, x: 40, transition: { duration: 0.25 } }}
      transition={{ type: "spring", stiffness: 320, damping: 32 }}
      className="flex flex-wrap items-center gap-4 ah-glass rounded-card p-4"
    >
      <span className={cx("flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl", TONE[item.level])}>
        <Icon name={item.acked ? "tick" : ICON[item.level]} size={20} />
      </span>
      <div className="min-w-[200px] flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[16px] font-semibold">{item.title}</span>
          {item.acked
            ? <StatusChip level="GRAY" plain text="Acknowledged" />
            : <StatusChip level={item.level} text={item.level === "GRAY" ? "No data" : undefined} />}
        </div>
        <div className="mt-0.5 text-sm text-muted">{item.detail}</div>
      </div>
      <div className="flex w-[150px] items-center gap-2.5">
        {person ? <Avatar name={person.name} color={person.color} size={36} /> : (
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-alert-bg text-alert-fg"><Icon name="alert" size={16} /></span>
        )}
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{item.name}</div>
          <div className="text-xs text-muted">{item.kind === "nodata" ? (item.ts ? `Since ${new Date(item.ts).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : "No readings") : time(item.ts)}</div>
        </div>
      </div>
      <div className="flex gap-2 max-sm:w-full">
        {item.kind === "alert" && !item.acked && (
          <Button className="min-h-11 max-sm:flex-1" onClick={() => onAck(item.alertId)} disabled={busy}>
            <Icon name="tick" size={16} /> Acknowledge
          </Button>
        )}
        {item.astronautId != null && (
          <Link
            to={`/doctor/crew/${item.astronautId}`}
            className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-accent-soft px-4 text-sm font-semibold text-accent-text transition-colors hover:bg-accent hover:text-accent-on max-sm:flex-1"
          >
            Open profile <Icon name="arrow-right" size={16} />
          </Link>
        )}
      </div>
    </motion.li>
  );
}

export default function Alerts() {
  const qc = useQueryClient();
  const toast = useToast();
  const crewQ = useCrew(true);
  const alertsQ = useAlerts(true);
  const rules = useHealthRules();
  const [level, setLevel] = useState("all");
  const [who, setWho] = useState("all");
  const [showAcked, setShowAcked] = useState(false);
  const [busy, setBusy] = useState(false);

  const crew = useMemo(() => crewQ.data || [], [crewQ.data]);
  const crewById = useMemo(() => new Map(crew.map((c) => [c.id, c])), [crew]);
  const feed = useMemo(() => buildFeed(crew, alertsQ.data || [], rules.data), [crew, alertsQ.data, rules.data]);
  const acked = useMemo(() => {
    if (!showAcked) return [];
    return (alertsQ.data || []).filter((a) => a.acknowledged).map((a) => ({
      // Only the alert's own item (the feed would also list that person's readings first).
      ...buildFeed(crew, [{ ...a, acknowledged: 0 }], rules.data).find((i) => i.kind === "alert"), key: `acked-${a.id}`, acked: true,
    }));
  }, [showAcked, alertsQ.data, crew, rules.data]);

  const byWho = (i) => who === "all" || (who === "sos" ? i.astronautId == null : i.astronautId === Number(who));
  const scoped = feed.filter(byWho);
  const counts = { all: scoped.length, RED: 0, YELLOW: 0, GRAY: 0 };
  scoped.forEach((i) => { counts[i.level] += 1; });
  const shown = [...scoped.filter((i) => level === "all" || i.level === level), ...acked.filter(byWho).filter(() => level === "all" || level === "RED")];
  const openAlertIds = shown.filter((i) => i.kind === "alert" && !i.acked).map((i) => i.alertId);

  // Group by day; "no reading" is about now, so it sits under today.
  const now = alertsQ.dataUpdatedAt || crewQ.dataUpdatedAt;
  const groups = [];
  shown.forEach((i) => {
    const date = i.kind === "nodata" || !i.ts ? new Date(now) : new Date(i.ts);
    const label = i.acked ? "Acknowledged" : dayLabel(date, now);
    let g = groups.find((x) => x.label === label);
    if (!g) groups.push((g = { label, items: [] }));
    g.items.push(i);
  });

  async function ack(ids) {
    const set = new Set(ids);
    setBusy(true);
    // Optimistic: mark them handled right away so the rows slide out.
    qc.setQueryData(["alerts"], (list) => (list || []).map((a) => (set.has(a.id) ? { ...a, acknowledged: 1 } : a)));
    try {
      await Promise.all(ids.map((id) => post(`/alerts/${id}/ack`)));
      toast(ids.length > 1 ? `${ids.length} alerts acknowledged` : "Alert acknowledged", "success");
    } catch {
      toast("Couldn't acknowledge -- try again", "error");
    } finally {
      qc.invalidateQueries({ queryKey: ["alerts"] });
      qc.invalidateQueries({ queryKey: ["crew"] });
      setBusy(false);
    }
  }

  if (crewQ.isLoading || alertsQ.isLoading) {
    return <div className="flex flex-col gap-3">{[0, 1, 2, 3].map((i) => <Shimmer key={i} className="h-20" />)}</div>;
  }

  const hasSos = feed.some((i) => i.astronautId == null);
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          id="alert-level"
          value={level}
          onChange={setLevel}
          className="ah-glass"
          options={LEVEL_TAB.map(([v, label]) => ({
            value: v,
            label: (
              <span className="inline-flex items-center gap-2">
                {label}
                <span className={cx("rounded-full px-1.5 text-[11px] font-bold", v === level ? "bg-white/25" : "bg-raised")}>{counts[v]}</span>
              </span>
            ),
          }))}
        />
        <label className="ml-auto flex items-center gap-2 text-[13px] text-muted">
          <span className="max-sm:hidden">Crew member</span>
          <select value={who} onChange={(e) => setWho(e.target.value)} className="ah-input min-h-11 w-44 text-sm" aria-label="Crew member">
            <option value="all">All crew</option>
            {crew.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            {hasSos && <option value="sos">Station SOS</option>}
          </select>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3 px-1">
        <button
          role="switch"
          aria-checked={showAcked}
          onClick={() => setShowAcked((v) => !v)}
          className="flex cursor-pointer items-center gap-2.5 text-[13px] text-ink-2"
        >
          <span className={cx("relative block h-6 w-10 shrink-0 rounded-full transition-colors", showAcked ? "bg-accent" : "bg-line-strong")}>
            <span className={cx("absolute top-1 left-0 h-4 w-4 rounded-full bg-white transition-transform", showAcked ? "translate-x-5" : "translate-x-1")} />
          </span>
          Show acknowledged
        </button>
        {openAlertIds.length > 1 && (
          <Button className="ml-auto min-h-10 text-[13px]" onClick={() => ack(openAlertIds)} disabled={busy}>
            <Icon name="tick" size={15} /> Acknowledge all {openAlertIds.length}
          </Button>
        )}
      </div>

      {groups.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 py-12 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-good-bg text-good-fg"><Icon name="tick" size={22} /></span>
          <h2 className="m-0 text-base font-semibold">All clear</h2>
          <p className="m-0 text-sm text-muted">Nothing {level === "all" ? "needs attention" : "in this view"} right now.</p>
        </Card>
      ) : (
        groups.map((g) => (
          <section key={g.label} className="flex flex-col gap-2.5">
            <h2 className="ah-eyebrow m-0 px-1 text-subtle">{g.label}</h2>
            <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
              <AnimatePresence initial={false}>
                {g.items.map((i) => <AlertRow key={i.key} item={i} crewById={crewById} onAck={(id) => ack([id])} busy={busy} />)}
              </AnimatePresence>
            </ul>
          </section>
        ))
      )}
    </>
  );
}
