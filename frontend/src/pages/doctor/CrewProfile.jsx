// Doctor · Crew member profile (AstroHealth-Redesign doctor-03), reached from any crew
// card, alert row or the sidebar's crew list. One scrolling page with section tabs that
// jump (and follow the scroll): Physical, Mental, Sleep, Mission risk, Messages.
// - header: status ring, today's status, role · mission · last reading, live-on-CYD badge,
//   the most important flag inline, CSV export, and shortcuts into the crew pages
//   (Trends / Body & Astra / Schedule) already pointed at this crew member;
// - Physical: six vital tiles + a trend chart (indicator + range);
// - Mental: wellbeing ring, mood, mission risk for the mind, 7-day mood direction;
// - Sleep: last night with the (illustrative) stage bar;
// - Mission risk: every body system's risk on this mission vs. "Now", with the why, and
//   how many of the mission's checks were done in the last 24 h;
// - Messages: the delayed two-way thread with the reply box (components/Thread.jsx).
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { motion } from "motion/react";
import { useAuth } from "../../auth/AuthProvider.jsx";
import { fmtTime, formatHours, MOOD_LABELS, moodScore, sleepHours } from "../../lib/format.js";
import { useContent, useCrew, useHistory, useMission, useSummary, useThread } from "../../lib/queries.js";
import { Avatar, Card, CardTitle, Progress, Segmented, Shimmer, StatusChip, cx, TrendLabel } from "../../components/ui/index.jsx";
import { Icon } from "../../components/ui/Icon.jsx";
import { VitalTile } from "../../components/VitalTile.jsx";
import { AiAnalysisCard } from "../../components/AiAnalysisCard.jsx";
import { LiveSensorCard } from "../../components/LiveSensorCard.jsx";
import { EvaHistoryCard } from "../../components/EvaHistoryCard.jsx";
import { TrendChart } from "../../components/TrendCard.jsx";
import { RingGauge } from "../../components/charts/RingGauge.jsx";
import { StageBar, StageLegend } from "../../components/charts/StageBar.jsx";
import { Thread } from "../../components/Thread.jsx";
import { RiskMeter } from "../../components/RiskMeter.jsx";
import { cardFlag } from "./feed.js";

const SECTIONS = [["physical", "Physical"], ["mental", "Mental"], ["sleep", "Sleep"], ["mission", "Mission risk"], ["messages", "Messages"]];
const TILES = ["heart_rate", "blood_pressure", "blood_sugar", "temperature", "oxygen_saturation", "sleep", "mood"];
const TREND = [["heart_rate", "Heart rate"], ["blood_pressure", "Blood pressure"], ["blood_sugar", "Blood sugar"], ["temperature", "Temperature"], ["oxygen_saturation", "Blood oxygen"]];
const RING = { GREEN: "border-good-fg", YELLOW: "border-check-fg", RED: "border-alert-fg", GRAY: "border-line-strong" };
const RISK_RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const RISK_TEXT = { HIGH: "text-alert-fg", MEDIUM: "text-check-fg", LOW: "text-good-fg" };
const FLAG = { RED: "border-alert-border bg-alert-bg text-alert-fg", YELLOW: "border-check-edge bg-check-bg text-check-fg", GRAY: "border-line bg-raised text-ink-2" };

// Which section is on screen, for the tab highlight. The last section can never scroll
// up into the "reading band", so at the very bottom of the page it wins outright.
function useActiveSection(ids, ready) {
  const [active, setActive] = useState(ids[0]);
  useEffect(() => {
    if (!ready) return undefined;
    const onScroll = () => {
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 8) setActive(ids.at(-1));
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [ids, ready]);
  useEffect(() => {
    const els = ids.map((id) => document.getElementById(`sec-${id}`)).filter(Boolean);
    if (!els.length) return undefined;
    const io = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 8;
        if (top && !atBottom) setActive(top.target.id.slice(4));
      },
      { rootMargin: "-20% 0px -60% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [ids, ready]);
  return [active, setActive];
}

function Section({ id, title, right, children }) {
  return (
    <section id={`sec-${id}`} className="flex scroll-mt-24 flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-1">
        <h2 className="m-0 font-display text-xl font-semibold">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function Header({ person, summary, mission, onJump }) {
  const navigate = useNavigate();
  const { setViewedId } = useAuth();
  const flag = cardFlag(person);
  const open = (to) => { setViewedId(person.id); navigate(to); };
  return (
    <Card className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-5">
        <div className={cx("rounded-full border-4 p-1.5 transition-colors duration-500", RING[person.status] || RING.GRAY)}>
          <Avatar name={person.name} color={person.color} size={78} />
        </div>
        <div className="flex min-w-[220px] flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="m-0 font-display text-display leading-none font-bold tracking-tight">{person.name}</h2>
            <StatusChip level={person.status} label="Today" text={person.status === "GRAY" ? "No data" : undefined} />
            {person.session_active && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-semibold text-accent-text">
                <span className="h-1.5 w-1.5 animate-[ah-pulse-dot_1.6s_ease-in-out_infinite] rounded-full bg-accent-text" />On the CYD now
              </span>
            )}
          </div>
          <div className="text-sm text-muted">
            {person.role} · {mission?.profile?.label || "–"} · {person.last_reading ? `Last reading ${fmtTime(person.last_reading)}` : "No readings yet"}
            {summary?.last_check ? ` · Last assessment ${fmtTime(summary.last_check)}` : ""}
          </div>
        </div>
        {flag && (
          <button
            onClick={() => onJump(flag.level === "GRAY" ? "physical" : "messages")}
            className={cx("flex min-w-[240px] flex-1 cursor-pointer items-center gap-3 rounded-2xl border p-3.5 text-left", FLAG[flag.level])}
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-black/20">
              <Icon name={flag.level === "GRAY" ? "no-data" : "alert"} size={18} />
            </span>
            <span className="min-w-0">
              <span className="block text-caption font-bold tracking-[0.1em] uppercase opacity-90">{flag.level === "RED" ? "Alert" : flag.level === "YELLOW" ? "Check" : "No data"}</span>
              <span className="block truncate text-body font-semibold text-ink">{flag.text}</span>
            </span>
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-2 border-t border-line pt-4">
        {[["/trends", "trends", "Trends"], ["/body", "doctor-ai", "Body & Astra"], ["/today", "schedule", "Today"]].map(([to, icon, label]) => (
          <button key={to} onClick={() => open(to)} className="flex min-h-10 cursor-pointer items-center gap-2 rounded-[var(--radius-inner)] bg-raised px-3.5 text-label font-semibold text-ink-2 hover:bg-control hover:text-ink">
            <Icon name={icon} size={15} /> {label}
          </button>
        ))}
        <button onClick={() => open(`/doctor/records?astronauts=${person.id}&range=30`)} className="ml-auto flex min-h-10 cursor-pointer items-center gap-2 rounded-[var(--radius-inner)] bg-raised px-3.5 text-label font-semibold text-ink-2 hover:bg-control hover:text-ink">
          <Icon name="download" size={15} /> Records &amp; Excel export
        </button>
      </div>
    </Card>
  );
}

function Physical({ id, summary }) {
  const [indicator, setIndicator] = useState("heart_rate");
  const [days, setDays] = useState(30);
  const today = summary?.today || {};
  return (
    <Section id="physical" title="Physical health">
      <motion.div initial="initial" animate="animate" variants={{ animate: { transition: { staggerChildren: 0.04 } } }} className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(160px,1fr))]">
        {TILES.map((k) => <VitalTile key={k} indicator={k} reading={today[k]} />)}
      </motion.div>
      <Card className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="m-0 mr-auto text-base font-semibold">Trend</h3>
          <Segmented id="prof-ind" size="sm" value={indicator} onChange={setIndicator} options={TREND.map(([v, l]) => ({ value: v, label: l }))} />
          <Segmented id="prof-days" size="sm" value={days} onChange={setDays} options={[{ value: 7, label: "7 days" }, { value: 30, label: "30 days" }]} />
        </div>
        <TrendChart astroId={id} indicator={indicator} days={days} height={300} />
      </Card>
    </Section>
  );
}

function Mental({ id, mission }) {
  const hist = useHistory(id, "mood", 7);
  const rows = hist.data || [];
  const scores = rows.map((r) => moodScore(r.value)).filter((v) => Number.isFinite(v));
  const score = scores.at(-1) ?? null;
  const level = score == null ? "GRAY" : score >= 4 ? "GREEN" : score === 3 ? "YELLOW" : "RED";
  const risk = mission?.health?.body_risks?.brain?.risk;
  const firstHalf = scores.slice(0, Math.ceil(scores.length / 2));
  const secondHalf = scores.slice(Math.ceil(scores.length / 2));
  const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const trend = scores.length < 3 ? null : avg(secondHalf) - avg(firstHalf) > 0.3 ? "up" : avg(secondHalf) - avg(firstHalf) < -0.3 ? "down" : "flat";
  return (
    <Card id="sec-mental" className="flex scroll-mt-24 flex-col gap-4">
      <CardTitle title="Mental health" right={<StatusChip level={level} text={score ? MOOD_LABELS[score] : "No data"} plain />} className="mb-0" />
      <div className="flex flex-wrap items-center gap-6">
        <RingGauge value={score ? Math.round((score / 5) * 100) : null} size={130} ariaLabel="Wellbeing" />
        <dl className="m-0 min-w-[200px] flex-1 text-sm">
          <div className="flex justify-between border-b border-divider py-2.5"><dt className="text-ink-2">Mood</dt><dd className="m-0 font-semibold">{score ? MOOD_LABELS[score] : "–"}</dd></div>
          <div className="flex justify-between border-b border-divider py-2.5"><dt className="text-ink-2">Mission risk (mind)</dt><dd className={cx("m-0 font-semibold", RISK_TEXT[risk])}>{risk ? risk[0] + risk.slice(1).toLowerCase() : "–"}</dd></div>
          <div className="flex justify-between py-2.5"><dt className="text-ink-2">Mood, last 7 days</dt><dd className="m-0"><TrendLabel direction={trend} text={trend ? undefined : "Not enough check-ins"} /></dd></div>
        </dl>
      </div>
    </Card>
  );
}

function SleepCard({ summary }) {
  const r = summary?.today?.sleep;
  const v = r && typeof r.value === "object" ? r.value : {};
  return (
    <Card id="sec-sleep" className="flex scroll-mt-24 flex-col gap-4">
      <CardTitle title="Sleep · last night" right={r ? <StatusChip level={r.level} /> : <StatusChip level="GRAY" text="No data" plain />} className="mb-0" />
      <div className="flex flex-wrap items-baseline gap-3">
        <span className="font-display text-jumbo leading-none font-bold tracking-tight">{r ? formatHours(sleepHours(r.value)) : "–"}</span>
        {(v.bedtime || v.wake_time) && <span className="text-sm text-muted">Bedtime {v.bedtime || "–"} · Wake {v.wake_time || "–"}</span>}
      </div>
      {r ? (
        <>
          <StageBar height={14} />
          <div className="flex flex-wrap items-center justify-between gap-2"><StageLegend /><span className="text-xs text-subtle">Illustrative stages</span></div>
        </>
      ) : (
        <p className="m-0 text-sm text-muted">No sleep logged in the last 24 h.</p>
      )}
    </Card>
  );
}

function MissionRisk({ summary, mission, content }) {
  const plan = mission?.health;
  const levels = summary?.body_levels || {};
  const today = summary?.today || {};
  const parts = Object.entries(plan?.body_risks || {}).sort((a, b) => RISK_RANK[a[1].risk] - RISK_RANK[b[1].risk]);
  const checks = plan?.monitoring || [];
  const done = checks.filter((c) => today[c.indicator]).length;
  return (
    <Section
      id="mission"
      title={`Body systems on ${mission?.profile?.label || "this mission"}`}
      right={checks.length > 0 && <span className="rounded-full bg-raised px-3 py-1 text-label text-ink-2"><b className="text-ink">{done} of {checks.length}</b> checks done in the last 24 h</span>}
    >
      <Card className="flex flex-col gap-3">
        {checks.length > 0 && <Progress value={done / checks.length} />}
        {!plan ? (
          <p className="m-0 text-sm text-muted">No health plan for this environment yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="border-b border-divider py-2 pr-3 font-medium">Body system</th>
                  <th className="border-b border-divider py-2 pr-3 font-medium">Mission risk</th>
                  <th className="border-b border-divider py-2 pr-3 font-medium">Now</th>
                  <th className="border-b border-divider py-2 font-medium">Why</th>
                </tr>
              </thead>
              <tbody>
                {parts.map(([part, r], i) => {
                  const level = levels[part] || "GRAY";
                  return (
                    <motion.tr key={part} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.05 + i * 0.04 }}>
                      <td className="border-b border-divider py-3 pr-3 font-semibold">{content?.body_parts?.[part]?.label || part}</td>
                      <td className="border-b border-divider py-3 pr-3"><RiskMeter risk={r.risk} /></td>
                      <td className="border-b border-divider py-3 pr-3"><StatusChip level={level} text={level === "GRAY" ? "No data" : undefined} /></td>
                      <td className="border-b border-divider py-3 text-muted">{r.why}</td>
                    </motion.tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </Section>
  );
}

export default function CrewProfile() {
  const id = Number(useParams().id);
  const crew = useCrew(true);
  const summary = useSummary(id);
  const mission = useMission();
  const content = useContent();
  const thread = useThread(id);
  const ids = useMemo(() => SECTIONS.map(([s]) => s), []);
  const person = (crew.data || []).find((c) => c.id === id);
  const [active, setActive] = useActiveSection(ids, !!person);
  const inTransit = (thread.data || []).filter((m) => !m.delivered).length;

  function jump(sec) {
    setActive(sec);
    document.getElementById(`sec-${sec}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  if (crew.isLoading) return <div className="flex flex-col gap-4"><Shimmer className="h-40" /><Shimmer className="h-64" /></div>;
  if (!person) {
    return (
      <Card className="flex flex-col items-start gap-3">
        <h2 className="m-0 text-base font-semibold">Crew member not found</h2>
        <Link to="/doctor" className="text-sm font-semibold text-accent-text hover:underline">Back to Crew overview</Link>
      </Card>
    );
  }

  return (
    <>
      <nav aria-label="Breadcrumb" className="-mt-2 flex items-center gap-2 px-1 text-sm">
        <Link to="/doctor" className="text-accent-text hover:underline">Crew overview</Link>
        <span className="text-subtle">/</span>
        <span className="font-semibold">{person.name}</span>
      </nav>

      <Header person={person} summary={summary.data} mission={mission.data} onJump={jump} />

      {/* Section tabs: jump links that also follow the scroll. Sticky so they're always handy. */}
      <div className="sticky top-3 z-20 -my-1 flex">
        <div role="tablist" aria-label="Profile sections" className="inline-flex max-w-full gap-1 overflow-x-auto ah-glass-strong rounded-2xl p-1.5">
          {SECTIONS.map(([sec, label]) => (
            <button
              key={sec}
              role="tab"
              aria-selected={active === sec}
              onClick={() => jump(sec)}
              className={cx("relative min-h-10 shrink-0 cursor-pointer rounded-xl px-4 text-sm transition-colors", active === sec ? "font-semibold text-accent-on" : "text-ink-2 hover:text-ink")}
            >
              {active === sec && <motion.span layoutId="profile-tab" className="absolute inset-0 rounded-xl bg-accent" transition={{ type: "spring", stiffness: 420, damping: 36 }} />}
              <span className="relative inline-flex items-center gap-1.5">
                {label}
                {sec === "messages" && inTransit > 0 && <span className="rounded-full bg-white/25 px-1.5 text-caption font-bold">{inTransit}</span>}
              </span>
            </button>
          ))}
        </div>
      </div>

      <AiAnalysisCard astroId={id} summary={summary.data} />
      <LiveSensorCard astroId={id} summary={summary.data} />
      <EvaHistoryCard astroId={id} summary={summary.data} />

      <Physical id={id} summary={summary.data} />

      <div className="grid grid-cols-1 items-start gap-[18px] lg:grid-cols-2">
        <Mental id={id} mission={mission.data} />
        <SleepCard summary={summary.data} />
      </div>

      <MissionRisk summary={summary.data} mission={mission.data} content={content.data} />

      <Section id="messages" title={`Messages with ${person.name}`} right={<span className="text-label text-muted">Every message waits out the comms delay to {mission.data?.profile?.label || "the crew"}.</span>}>
        <Card><Thread astroId={id} name={person.name} viewer="surgeon" canReply /></Card>
      </Section>
    </>
  );
}
