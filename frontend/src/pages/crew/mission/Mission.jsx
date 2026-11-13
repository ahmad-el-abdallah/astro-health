// Crew · Mission health. Pick one of five real NASA missions (config/missions.json):
// see its own animated 3D scene (three/planet3d.js), the mission facts and crew, how hard
// the mission hits each body system ("Mission risk", from what NASA/ESA reported) next to
// this astronaut's latest level ("Now"), the monitoring checklist for the last 24 h, and
// the sources + data.nasa.gov dataset behind it.
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { useAstronautPicker } from "../../../auth/AuthProvider.jsx";
import { put } from "../../../lib/api.js";
import { fmtTime } from "../../../lib/format.js";
import { useContent, useHealthRules, useMission, useSummary } from "../../../lib/queries.js";
import { AnimatedNumber, Button, Card, CardTitle, Progress, StatusChip, cx } from "../../../components/ui/index.jsx";
import { Icon } from "../../../components/ui/Icon.jsx";
import { Planet3D } from "../../../three/planet3d.js";
import { RiskMeter } from "../../../components/RiskMeter.jsx";
import { WebGLBoundary } from "../../../three/webgl.jsx";

// Real three.js models per mission, loaded only when this page opens (three.js is big).
// Browsers without WebGL fall back to the lightweight 2D canvas scene below.
const MissionScene = lazy(() => import("../../../three/mission/MissionScene.jsx"));

const ORDER = ["crew13_iss", "twin_study", "artemis2", "mars520", "spacewalk"];
const ENV_ICON = { crew13_iss: "env-station", twin_study: "crew", artemis2: "env-lunar", mars520: "env-mars", spacewalk: "wrench" };
const HAZARD_ICON = { space_radiation: "hazard-radiation", isolation_confinement: "hazard-isolation", distance_from_earth: "hazard-distance", gravity_fields: "hazard-gravity", hostile_environment: "hazard-environment" };
const RISK_RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 };

// Port of mission.js attentionFor().
function attentionFor(risk, level) {
  if (level === "RED") return { cls: "border-l-alert-fg", text: "Act now: open Astra & body for what to do.", tone: "text-alert-fg" };
  if (level === "YELLOW" && risk !== "LOW") return { cls: "border-l-check-fg", text: "Watch closely: this mission makes it worse.", tone: "text-check-fg" };
  if (level === "GRAY" && risk === "HIGH") return { cls: "border-l-line-strong border-dashed", text: "High risk, but no reading today. Measure it.", tone: "text-muted" };
  return null;
}

// 2D fallback (no WebGL): the canvas planet scenes, with soft edges so there's no box.
function Planet({ profileId }) {
  const ref = useRef(null);
  const scene = useRef(null);
  useEffect(() => {
    scene.current = Planet3D.mount(ref.current);
  }, []);
  useEffect(() => { if (profileId) scene.current?.setProfile(profileId); }, [profileId]);
  return <canvas ref={ref} aria-hidden="true" className="block h-full min-h-[300px] w-full [mask-image:radial-gradient(ellipse_90%_85%_at_50%_50%,#000_60%,transparent_100%)]" />;
}

function Stat({ label, value, suffix }) {
  return (
    <div className="flex flex-col gap-1 rounded-[var(--radius-inner)] bg-raised p-3.5">
      <span className="text-xs text-muted">{label}</span>
      <span className="font-display text-2xl font-bold tracking-tight">
        {typeof value === "number" ? <AnimatedNumber value={value} decimals={value % 1 ? 2 : 0} /> : value}
        {typeof value === "number" && suffix && <span className="ml-1 text-sm font-normal text-muted">{suffix}</span>}
      </span>
    </div>
  );
}

// "Are you sure?" popup for starting, switching and stopping a mission.
function ConfirmMission({ confirm, onCancel, onConfirm, busy }) {
  const c = confirm;
  const copy = !c ? null : c.kind === "start"
    ? { title: "Start this mission?", body: <>Are you sure you want to start the <b className="text-ink">“{c.target}”</b> mission? Every page will use its risks, monitoring plan and delay to Earth.</>, ok: "Start mission", variant: "primary" }
    : c.kind === "switch"
      ? { title: "You're already on a mission", body: <>You're on the <b className="text-ink">“{c.current}”</b> mission right now. Are you sure you want to stop it and start <b className="text-ink">“{c.target}”</b> instead?</>, ok: "Change mission", variant: "primary" }
      : { title: "Stop this mission?", body: <>Are you sure you want to stop the <b className="text-ink">“{c.current}”</b> mission? No mission will be selected until you start one.</>, ok: "Stop mission", variant: "danger" };
  return (
    <AnimatePresence>
      {c && (
        <div className="fixed inset-0 z-[150] flex items-center justify-center p-5">
          <motion.div className="absolute inset-0 bg-black/70" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onCancel} />
          <motion.div
            role="alertdialog" aria-modal="true" aria-label={copy.title}
            initial={{ opacity: 0, y: 16, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 360, damping: 30 }}
            className="relative w-full max-w-md ah-glass-strong rounded-card-l p-6 shadow-[0_30px_75px_rgba(0,0,0,.6)]"
          >
            <span className={cx("mb-3 flex h-11 w-11 items-center justify-center rounded-2xl", c.kind === "stop" ? "bg-alert-bg text-alert-fg" : "bg-accent-soft text-accent-text")}>
              <Icon name={c.kind === "stop" ? "alert" : "mission"} size={22} />
            </span>
            <h3 className="m-0 mb-2 font-display text-heading font-semibold">{copy.title}</h3>
            <p className="m-0 text-sm leading-relaxed text-ink-2">{copy.body}</p>
            <div className="mt-5 flex justify-end gap-2.5">
              <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
              <Button variant={copy.variant} onClick={onConfirm} busy={busy} autoFocus>{copy.ok}</Button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

export default function Mission() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { id } = useAstronautPicker();
  const mission = useMission();
  const content = useContent();
  const rules = useHealthRules();
  const summary = useSummary(id);
  const m = mission.data;
  // activeId = the mission actually running (or null); shownId = the one being looked at.
  const activeId = m?.profile_id || null;
  const [viewId, setViewId] = useState(null);
  const shownId = viewId || activeId || ORDER[0];
  const p = m?.all_profiles?.[shownId];
  const active = activeId ? m?.all_profiles?.[activeId] : null;
  const plan = m?.all_health?.[shownId];
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const levels = summary.data?.body_levels || {};
  const today = summary.data?.today || {};

  const nameOf = (k) => m?.all_profiles?.[k]?.short || m?.all_profiles?.[k]?.label;
  async function applyConfirm() {
    setBusy(true);
    try {
      await put("/mission", { profile_id: confirm.kind === "stop" ? null : confirm.id });
      if (confirm.kind !== "stop") setViewId(confirm.id);
      await qc.invalidateQueries({ queryKey: ["mission"] });
      setConfirm(null);
    } finally { setBusy(false); }
  }
  const ask = (kind) => setConfirm({ kind, id: shownId, target: nameOf(shownId), current: active ? nameOf(activeId) : null });

  const delay = typeof p?.comms_delay_s === "number"
    ? p.comms_delay_s >= 60 ? [Math.round(p.comms_delay_s / 60), "min"] : [p.comms_delay_s, "s"]
    : ["same as base", ""];
  const counts = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  Object.values(plan?.body_risks || {}).forEach((r) => { counts[r.risk] += 1; });
  const parts = Object.entries(plan?.body_risks || {}).sort((a, b) => RISK_RANK[a[1].risk] - RISK_RANK[b[1].risk]);
  const checks = plan?.monitoring || [];
  const done = checks.filter((c) => today[c.indicator]).length;

  return (
    <>
      <p className="m-0 max-w-3xl px-1 text-body text-ink-2">
        Five real NASA missions, five different ways space hurts the body. Look through them, then press <b className="text-ink">Start mission</b> to make one the crew's current mission.
      </p>

      <div className={cx("flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3 text-sm", active ? "border-good-fg/30 bg-good-bg/40" : "border-line-strong ah-glass")}>
        <span className={cx("h-2.5 w-2.5 rounded-full", active ? "bg-good-fg shadow-[0_0_10px_currentColor] text-good-fg" : "bg-muted")} />
        {active
          ? <span className="text-ink-2">Current mission: <b className="text-ink">{active.label}</b></span>
          : <span className="text-ink-2"><b className="text-ink">No mission selected.</b> Pick a mission below and press Start mission.</span>}
        {active && (
          <Button variant="secondary" className="ml-auto min-h-9 px-3.5 text-label" onClick={() => setConfirm({ kind: "stop", current: nameOf(activeId) })}>
            Stop mission
          </Button>
        )}
      </div>

      <div role="radiogroup" aria-label="Mission environment" className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(170px,1fr))]">
        {ORDER.filter((k) => m?.all_profiles?.[k]).map((k) => {
          const on = shownId === k;
          const running = activeId === k;
          return (
            <motion.button
              key={k}
              role="radio"
              aria-checked={on}
              onClick={() => setViewId(k)}
              whileHover={{ y: -2 }}
              whileTap={{ scale: 0.98 }}
              className={cx(
                "relative flex min-h-14 cursor-pointer items-center gap-3 rounded-2xl border px-4 text-left text-sm transition-colors",
                on ? "border-accent text-accent-on" : "ah-glass text-ink-2 hover:border-accent-text/50",
              )}
            >
              {on && <motion.span layoutId="env-pill" className="absolute inset-0 rounded-2xl bg-accent" transition={{ type: "spring", stiffness: 380, damping: 34 }} />}
              <Icon name={ENV_ICON[k]} size={20} className="relative shrink-0" />
              <span className="relative flex flex-col leading-tight">
                <span className="font-semibold">{m.all_profiles[k].short || m.all_profiles[k].label}</span>
                <span className={cx("text-caption", on ? "text-accent-on/80" : "text-muted")}>
                  {m.all_profiles[k].kind === "simulation" ? "Simulation · " : ""}{m.all_profiles[k].status}
                </span>
              </span>
              {running && (
                <span className="absolute -top-2 right-2 flex items-center gap-1 rounded-full bg-good-bg px-2 py-0.5 text-caption font-bold tracking-wide text-good-fg ring-1 ring-good-fg/40">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-good-fg" />ACTIVE
                </span>
              )}
            </motion.button>
          );
        })}
      </div>

      <Card className="grid items-stretch gap-2 overflow-hidden p-0 md:grid-cols-[minmax(320px,1.15fr)_1.3fr]">
        <div className="relative min-h-[340px]">
          <WebGLBoundary fallback={<Planet profileId={m ? shownId : null} />}>
            <Suspense fallback={<div className="flex h-full min-h-[340px] items-center justify-center text-sm text-muted">Loading 3D mission…</div>}>
              <MissionScene missionId={m ? shownId : null} />
            </Suspense>
          </WebGLBoundary>
        </div>
        <motion.div key={shownId} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.45 }} className="flex flex-col gap-4 p-6">
          <div className="flex flex-wrap items-center gap-2">
            <span className="ah-eyebrow">{p?.label}</span>
            <span className={cx("rounded-full px-2.5 py-0.5 text-caption font-bold tracking-wide",
              p?.kind === "simulation" ? "bg-check-bg text-check-fg" : "bg-good-bg text-good-fg")}>
              {p?.kind === "simulation" ? "GROUND SIMULATION" : "REAL MISSION"}
            </span>
          </div>
          <p className="m-0 font-display text-heading leading-snug font-semibold">{plan?.headline}</p>
          <div className="flex flex-wrap items-center gap-2.5">
            {activeId === shownId ? (
              <>
                <span className="flex min-h-10 items-center gap-2 rounded-xl bg-good-bg px-3.5 text-label font-semibold text-good-fg">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-good-fg" />Mission in progress
                </span>
                <Button variant="secondary" className="min-h-10" onClick={() => ask("stop")}>Stop mission</Button>
              </>
            ) : (
              <Button variant="primary" className="min-h-10" onClick={() => ask(activeId ? "switch" : "start")}>
                <Icon name="mission" size={16} />{activeId ? "Switch to this mission" : "Start mission"}
              </Button>
            )}
          </div>
          <p className="m-0 text-sm text-ink-2">{p?.summary}</p>
          <div className="grid grid-cols-3 gap-2.5 max-sm:grid-cols-1">
            <Stat label="Gravity" value={p?.gravity_g} suffix="g" />
            <Stat label="Delay to Earth's doctors" value={delay[0]} suffix={delay[1]} />
            <Stat label="When · how long" value={<span className="text-base leading-snug">{p?.dates}</span>} />
          </div>
          <div className="flex flex-col gap-1.5 text-label">
            <span className="flex gap-2"><Icon name="hazard-radiation" size={16} className="mt-0.5 shrink-0 text-muted" /><span className="text-ink-2">{p?.radiation}</span></span>
            <span className="flex gap-2"><Icon name="crew" size={16} className="mt-0.5 shrink-0 text-muted" /><span className="text-ink-2">{(p?.crew || []).join(" · ")}</span></span>
            <span className="flex gap-2"><Icon name="mission" size={16} className="mt-0.5 shrink-0 text-muted" /><span className="text-ink-2">{p?.where}</span></span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-label">
            <span className="rounded-full bg-alert-bg px-2.5 py-1 font-semibold text-alert-fg">{counts.HIGH} high-risk</span>
            <span className="rounded-full bg-check-bg px-2.5 py-1 font-semibold text-check-fg">{counts.MEDIUM} medium</span>
            <span className="rounded-full bg-good-bg px-2.5 py-1 font-semibold text-good-fg">{counts.LOW} low</span>
            <span className="text-muted">body systems on this mission</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-label">
            <span className="text-muted">Main hazards</span>
            {(p?.main_concerns || []).map((h) => (
              <span key={h} className="flex items-center gap-1.5 rounded-full border border-line-strong px-2.5 py-1 text-ink-2">
                <Icon name={HAZARD_ICON[h]} size={14} />{content.data?.hazards?.[h]?.label || h}
              </span>
            ))}
          </div>
        </motion.div>
      </Card>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-1">
          <h2 className="m-0 font-display text-xl font-semibold">What this mission does to your body</h2>
          <span className="text-label text-muted"><b className="text-ink-2">Mission risk</b> = how hard this mission hit that body system, from what NASA reported. <b className="text-ink-2">Now</b> = this astronaut's latest readings.</span>
        </div>
        {!plan ? (
          <Card><p className="m-0 text-sm text-muted">No health plan for this mission yet. Add one to config/mission_health.json.</p></Card>
        ) : (
          <motion.div key={shownId} initial="initial" animate="animate" variants={{ animate: { transition: { staggerChildren: 0.05 } } }} className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
            {parts.map(([part, r]) => {
              const level = levels[part] || "GRAY";
              const att = attentionFor(r.risk, level);
              return (
                <motion.button
                  key={part}
                  variants={{ initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 } }}
                  whileHover={{ y: -3 }}
                  onClick={() => navigate("/body")}
                  className={cx("flex cursor-pointer flex-col gap-2.5 ah-glass rounded-card-s border-l-4 p-4 text-left", att?.cls)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <strong className="text-body">{content.data?.body_parts?.[part]?.label || part}</strong>
                    <RiskMeter risk={r.risk} />
                  </div>
                  <StatusChip level={level} label="Now" text={level === "GRAY" ? "no data" : undefined} />
                  <p className="m-0 text-label text-muted">{r.why}</p>
                  {att && <span className={cx("text-label font-semibold", att.tone)}>{att.text}</span>}
                </motion.button>
              );
            })}
          </motion.div>
        )}
      </section>

      {plan && (
        <Card className="flex flex-col gap-4">
          <CardTitle title="What to monitor on this mission" right={<span className="text-label text-muted">{done} of {checks.length} checks done in the last 24 h</span>} className="mb-0" />
          <Progress value={checks.length ? done / checks.length : 0} />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="border-b border-divider py-2 pr-3 font-medium">Check</th>
                  <th className="border-b border-divider py-2 pr-3 font-medium">How often</th>
                  <th className="border-b border-divider py-2 pr-3 font-medium">Why on this mission</th>
                  <th className="border-b border-divider py-2 font-medium">Last 24 h</th>
                </tr>
              </thead>
              <tbody>
                {checks.map((c, i) => {
                  const reading = today[c.indicator];
                  return (
                    <motion.tr key={`${shownId}-${c.indicator}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 + i * 0.05 }} className="align-top">
                      <td className="border-b border-divider py-3 pr-3 font-semibold">{rules.data?.indicators?.[c.indicator]?.label || c.indicator}</td>
                      <td className="border-b border-divider py-3 pr-3 text-ink-2">{c.how_often}</td>
                      <td className="border-b border-divider py-3 pr-3 text-muted">{c.why}</td>
                      <td className="border-b border-divider py-3">
                        {reading ? <span className="flex flex-col gap-1"><StatusChip level={reading.level} /><span className="text-xs text-subtle">{fmtTime(reading.ts)}</span></span>
                          : <StatusChip level="GRAY" text="Not measured yet" plain />}
                      </td>
                    </motion.tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {p?.sources?.length > 0 && (
        <Card className="flex flex-col gap-3">
          <CardTitle title="Where this comes from" subtitle="Risk levels are our summary; the facts are from these sources" className="mb-0" />
          <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
            {p.sources.map((s) => (
              <li key={s.url}>
                <a href={s.url} target="_blank" rel="noreferrer" className="text-accent-text hover:underline">{s.title}</a>
              </li>
            ))}
          </ul>
          {p.dataset && (
            <a href={p.dataset.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 self-start rounded-xl bg-accent-soft px-3.5 py-2 text-label font-semibold text-accent-text hover:bg-accent hover:text-accent-on">
              <Icon name="download" size={16} />NASA dataset: {p.dataset.title}
            </a>
          )}
        </Card>
      )}
      <ConfirmMission confirm={confirm} busy={busy} onCancel={() => !busy && setConfirm(null)} onConfirm={applyConfirm} />
    </>
  );
}
