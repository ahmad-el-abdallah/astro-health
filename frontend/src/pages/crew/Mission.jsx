// Crew · Mission health (AstroHealth-Redesign crew-06; port of static/js/tabs/mission.js).
// Pick the environment, see the animated planet scene and mission numbers, how hard the
// mission hits each body system ("Mission risk") next to this astronaut's latest level
// ("Now"), and the monitoring checklist for the last 24 h.
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { useAstronautPicker } from "../../auth/AuthProvider.jsx";
import { put } from "../../lib/api.js";
import { fmtTime } from "../../lib/format.js";
import { useContent, useHealthRules, useMission, useSummary } from "../../lib/queries.js";
import { AnimatedNumber, Card, CardTitle, Progress, StatusChip, cx } from "../../components/ui/index.jsx";
import { Icon } from "../../components/ui/Icon.jsx";
import { Planet3D } from "../../three/planet3d.js";
import { RiskMeter } from "../../components/RiskMeter.jsx";

const ORDER = ["station", "lunar_base", "mars_transit", "mars_base", "rover"];
const ENV_ICON = { station: "env-station", lunar_base: "env-lunar", mars_transit: "env-transit", mars_base: "env-mars", rover: "env-rover" };
const HAZARD_ICON = { space_radiation: "hazard-radiation", isolation_confinement: "hazard-isolation", distance_from_earth: "hazard-distance", gravity_fields: "hazard-gravity", hostile_environment: "hazard-environment" };
const RISK_RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 };

// Port of mission.js attentionFor().
function attentionFor(risk, level) {
  if (level === "RED") return { cls: "border-l-alert-fg", text: "Act now: open Doctor AI & body for what to do.", tone: "text-alert-fg" };
  if (level === "YELLOW" && risk !== "LOW") return { cls: "border-l-check-fg", text: "Watch closely: this mission makes it worse.", tone: "text-check-fg" };
  if (level === "GRAY" && risk === "HIGH") return { cls: "border-l-line-strong border-dashed", text: "High risk, but no reading today. Measure it.", tone: "text-muted" };
  return null;
}

function Planet({ profileId }) {
  const ref = useRef(null);
  const scene = useRef(null);
  useEffect(() => {
    scene.current = Planet3D.mount(ref.current);
  }, []);
  useEffect(() => { if (profileId) scene.current?.setProfile(profileId); }, [profileId]);
  return <canvas ref={ref} aria-hidden="true" className="block h-[300px] w-full [mask-image:linear-gradient(90deg,#000_85%,transparent)] max-md:h-[220px]" />;
}

function Stat({ label, value, suffix }) {
  return (
    <div className="flex flex-col gap-1 rounded-2xl bg-raised p-3.5">
      <span className="text-xs text-muted">{label}</span>
      <span className="font-display text-2xl font-bold tracking-tight">
        {typeof value === "number" ? <AnimatedNumber value={value} decimals={value % 1 ? 2 : 0} /> : value}
        {typeof value === "number" && suffix && <span className="ml-1 text-sm font-normal text-muted">{suffix}</span>}
      </span>
    </div>
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
  const p = m?.profile;
  const plan = m?.health;
  const levels = summary.data?.body_levels || {};
  const today = summary.data?.today || {};

  async function setProfile(profileId) {
    await put("/mission", { profile_id: profileId });
    qc.invalidateQueries({ queryKey: ["mission"] });
  }

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
      <p className="m-0 max-w-3xl px-1 text-[15px] text-ink-2">
        Every environment stresses the body differently. Pick where the crew is to see which body systems are most at risk, how each astronaut is doing right now, and what to check.
      </p>

      <div role="radiogroup" aria-label="Mission environment" className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(170px,1fr))]">
        {ORDER.filter((k) => m?.all_profiles?.[k]).map((k) => {
          const on = m.profile_id === k;
          return (
            <motion.button
              key={k}
              role="radio"
              aria-checked={on}
              onClick={() => !on && setProfile(k)}
              whileHover={{ y: -2 }}
              whileTap={{ scale: 0.98 }}
              className={cx(
                "relative flex min-h-14 cursor-pointer items-center gap-3 rounded-2xl border px-4 text-left text-sm transition-colors",
                on ? "border-accent text-accent-on" : "ah-glass text-ink-2 hover:border-accent-text/50",
              )}
            >
              {on && <motion.span layoutId="env-pill" className="absolute inset-0 rounded-2xl bg-accent" transition={{ type: "spring", stiffness: 380, damping: 34 }} />}
              <Icon name={ENV_ICON[k]} size={20} className="relative shrink-0" />
              <span className="relative font-semibold">{m.all_profiles[k].label}</span>
            </motion.button>
          );
        })}
      </div>

      <Card className="grid items-center gap-2 overflow-hidden p-0 md:grid-cols-[minmax(260px,1fr)_1.4fr]">
        <Planet profileId={m?.profile_id} />
        <motion.div key={m?.profile_id} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.45 }} className="flex flex-col gap-4 p-6">
          <span className="ah-eyebrow">{p?.label}</span>
          <p className="m-0 font-display text-[22px] leading-snug font-semibold">{plan?.headline}</p>
          <div className="grid grid-cols-3 gap-2.5 max-sm:grid-cols-1">
            <Stat label="Gravity" value={p?.gravity_g === "same_as_base" ? "same as base" : p?.gravity_g} suffix="g" />
            <Stat label="Delay to Earth's doctors" value={delay[0]} suffix={delay[1]} />
            <Stat label="Daily radiation (placeholder)" value={p?.daily_radiation_dose_uGy_PLACEHOLDER} suffix="µGy" />
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <span className="rounded-full bg-alert-bg px-2.5 py-1 font-semibold text-alert-fg">{counts.HIGH} high-risk</span>
            <span className="rounded-full bg-check-bg px-2.5 py-1 font-semibold text-check-fg">{counts.MEDIUM} medium</span>
            <span className="rounded-full bg-good-bg px-2.5 py-1 font-semibold text-good-fg">{counts.LOW} low</span>
            <span className="text-muted">body systems on this mission</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
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
          <span className="text-[13px] text-muted"><b className="text-ink-2">Mission risk</b> = how hard this environment hits that body system. <b className="text-ink-2">Now</b> = this astronaut's latest readings.</span>
        </div>
        {!plan ? (
          <Card><p className="m-0 text-sm text-muted">No health plan for this environment yet. Add one to config/mission_health.json.</p></Card>
        ) : (
          <motion.div key={m.profile_id} initial="initial" animate="animate" variants={{ animate: { transition: { staggerChildren: 0.05 } } }} className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
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
                    <strong className="text-[15px]">{content.data?.body_parts?.[part]?.label || part}</strong>
                    <RiskMeter risk={r.risk} />
                  </div>
                  <StatusChip level={level} label="Now" text={level === "GRAY" ? "no data" : undefined} />
                  <p className="m-0 text-[13px] text-muted">{r.why}</p>
                  {att && <span className={cx("text-[13px] font-semibold", att.tone)}>{att.text}</span>}
                </motion.button>
              );
            })}
          </motion.div>
        )}
      </section>

      {plan && (
        <Card className="flex flex-col gap-4">
          <CardTitle title="What to monitor on this mission" right={<span className="text-[13px] text-muted">{done} of {checks.length} checks done in the last 24 h</span>} className="mb-0" />
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
                    <motion.tr key={`${m.profile_id}-${c.indicator}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 + i * 0.05 }} className="align-top">
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
    </>
  );
}
