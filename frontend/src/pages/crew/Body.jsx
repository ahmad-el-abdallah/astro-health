// Crew · Astra & body. Laid out like the user's reference dashboard: a realistic
// x-ray anatomy model in the centre (src/three/anatomy), the patient and the selected
// region on the left, lab-style vitals with sparklines on the right, the last 7 days
// along the bottom, and the Astra consultation in a slide-in drawer.
// Ports every feature of the old Body tab (static/js/tabs/body.js): region selection +
// camera fly-to, 0-10 discomfort per region blended into the region's color, About this
// part, danger alert + consent-gated report, Analyze symptoms, the readings form, the
// AI chat with all its actions, and Face to Face.
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { useAstronautPicker } from "../../auth/AuthProvider.jsx";
import { post } from "../../lib/api.js";
import { formatIndicatorValue, INDICATORS } from "../../lib/format.js";
import { blendedLevel, LEVEL_WORD, worstOf } from "../../lib/levels.js";
import { useContent, useHealthRules, useHistory, useMission, useSummary } from "../../lib/queries.js";
import { useToast } from "../../components/overlays/Toasts.jsx";
import { Button, cx } from "../../components/ui/index.jsx";
import { Icon } from "../../components/ui/Icon.jsx";
import { REGIONS } from "../../three/anatomy/regions.js";
import { STRINGS } from "../../strings.js";
import { WebGLBoundary } from "../../three/webgl.jsx";
import { ChatDrawer } from "./body/ChatDrawer.jsx";
import { useAstra } from "../../components/AstraProvider.jsx";
import { useConsultation } from "./body/useConsultation.js";
import { LAB_INDICATORS, LabTile, LogReadingCard, ProfileCard, RegionCard, Timeline } from "./body/Panels.jsx";

// three.js + the anatomy model are their own chunk, fetched only when this page opens.
const AnatomyScene = lazy(() => import("../../three/anatomy/AnatomyScene.jsx").then((m) => ({ default: m.AnatomyScene })));

const SIDE = { brain: "right", eyes: "left", heart: "right", immune: "left", stomach: "right", skeleton: "left", muscles: "right" };
const LEVEL_DOT = { GREEN: "bg-good-fg", YELLOW: "bg-check-fg", RED: "bg-alert-fg", GRAY: "bg-subtle" };

function useLabHistories(id) {
  const h = {
    heart_rate: useHistory(id, "heart_rate", 7),
    blood_pressure: useHistory(id, "blood_pressure", 7),
    blood_sugar: useHistory(id, "blood_sugar", 7),
    temperature: useHistory(id, "temperature", 7),
    oxygen_saturation: useHistory(id, "oxygen_saturation", 7),
    sleep: useHistory(id, "sleep", 7),
    mood: useHistory(id, "mood", 7),
  };
  return Object.fromEntries(Object.entries(h).map(([k, q]) => [k, q.data]));
}

function TwinToolbar({ layers, setLayers, onReset }) {
  const items = [["skin", "Skin"], ["muscles", "Muscles"], ["bones", "Bones"], ["organs", "Organs"]];
  return (
    <div className="flex flex-wrap items-center gap-1.5 ah-glass-flat rounded-2xl p-1.5">
      {items.map(([k, label]) => (
        <button
          key={k}
          aria-pressed={layers[k]}
          onClick={() => setLayers((l) => ({ ...l, [k]: !l[k] }))}
          className={cx(
            "min-h-8 cursor-pointer rounded-xl px-3 text-xs font-semibold transition-colors",
            layers[k] ? "bg-accent-soft text-accent-text" : "text-muted hover:text-ink",
          )}
        >
          {label}
        </button>
      ))}
      <button onClick={onReset} className="min-h-8 cursor-pointer rounded-xl px-3 text-xs text-ink-2 hover:text-ink">Reset view</button>
    </div>
  );
}

export default function Body() {
  const { id } = useAstronautPicker();
  return <BodyFor key={id ?? "none"} astroId={id} />;
}

function BodyFor({ astroId }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const summary = useSummary(astroId);
  const content = useContent();
  const mission = useMission();
  const rules = useHealthRules();
  const histories = useLabHistories(astroId);

  const [selected, setSelected] = useState(null);
  const [draft, setDraft] = useState({}); // discomfort while dragging, before it's saved
  const [layers, setLayers] = useState({ skin: true, muscles: false, bones: true, organs: true });
  const [resetSignal, setResetSignal] = useState(0);
  const [chatOpen, setChatOpen] = useState(params.get("consult") === "1");
  // Astra (components/AstraProvider.jsx) owns the voice screen and -- for a crew member
  // looking at their own body -- the one shared conversation. The Flight Surgeon viewing a
  // crew member gets a local text chat only (no AI voice for the surgeon, by design).
  const navigate = useNavigate();
  const astra = useAstra();
  const shared = astra.available && astra.astroId === astroId;
  const openVoice = shared ? () => { setChatOpen(false); astra.open(); } : null;

  const s = summary.data;
  const today = useMemo(() => s?.today || {}, [s?.today]);
  const discomfort = useMemo(() => ({ ...(s?.discomfort || {}), ...draft }), [s?.discomfort, draft]);
  const levels = useMemo(
    () => Object.fromEntries(REGIONS.map((r) => [r, blendedLevel(r, s?.body_levels, discomfort)])),
    [s?.body_levels, discomfort],
  );
  const overall = useMemo(() => {
    const l = Object.values(today).map((r) => r.level);
    if (s?.symptoms_today?.level) l.push(s.symptoms_today.level);
    return l.length ? worstOf([...l, ...Object.values(levels)]) : s?.overall_level || "GRAY";
  }, [today, levels, s]);

  const persistDiscomfort = useCallback(async (region, intensity) => {
    setDraft((d) => ({ ...d, [region]: intensity }));
    try {
      await post(`/astronauts/${astroId}/discomfort`, { region, intensity });
      qc.invalidateQueries({ queryKey: ["summary", astroId] });
    } catch {
      toast("Couldn't save that discomfort level.", "error");
    }
  }, [astroId, qc, toast]);

  const local = useConsultation({
    astroId,
    content: content.data,
    mission: mission.data,
    persistDiscomfort,
    selectRegion: setSelected,
    onNavigate: navigate,
  });
  const consultation = shared ? astra.consultation : local;
  const { ensureConversation } = local;
  useEffect(() => { if (!shared && s?.astronaut) ensureConversation(s.astronaut.name); }, [shared, s?.astronaut, ensureConversation]);
  // While this page is open, Astra's replies drive the twin too (select + draft the region).
  const { linkBody } = astra;
  useEffect(() => linkBody({
    selectRegion: setSelected,
    onDiscomfort: (region, intensity) => setDraft((d) => ({ ...d, [region]: intensity })),
  }), [linkBody]);

  useEffect(() => {
    if (chatOpen || params.get("consult") !== "1") return;
    params.delete("consult");
    setParams(params, { replace: true });
  }, [chatOpen, params, setParams]);

  // Port of renderAnalysis(): every non-green region with what to do, posted as a Doctor
  // AI message so it sits in the same conversation.
  const analyze = useCallback(() => {
    const parts = content.data?.body_parts || {};
    const flagged = REGIONS.filter((r) => levels[r] !== "GREEN").map((r) => ({ region: r, level: levels[r], label: parts[r]?.label || r, todo: parts[r]?.what_to_do }));
    const top = worstOf(Object.values(levels));
    consultation.say({
      text: flagged.length
        ? `Overall: ${LEVEL_WORD[top]}. ${top === "RED" ? "Escalate: contact the flight surgeon and send a report." : "Here's what needs attention:"}`
        : "All body systems look normal. Keep up your routine.",
      analysis: flagged,
    });
    setChatOpen(true);
  }, [content.data, levels, consultation]);

  // Floating labels on flagged (yellow/red) regions and the selected one.
  const calloutsFor = useCallback((boxes) => {
    const parts = content.data?.body_parts || {};
    return REGIONS.filter((r) => levels[r] !== "GREEN" || r === selected).map((r) => {
      const box = boxes[r];
      if (!box || box.isEmpty()) return null;
      const c = box.getCenter(box.min.clone());
      const size = box.getSize(box.min.clone());
      // Fixed sides so labels never pile on top of each other.
      const side = SIDE[r];
      const dx = side === "right" ? size.x * 0.35 : -size.x * 0.35;
      const anchor = r === "skeleton" ? [c.x - size.x * 0.3, c.y - size.y * 0.12, c.z]
        : r === "muscles" ? [c.x + size.x * 0.3, c.y - size.y * 0.3, c.z]
        : [c.x + dx, c.y, c.z + size.z * 0.3];
      const ind = (parts[r]?.indicators || []).find((k) => today[k] && today[k].level !== "GREEN");
      const detail = discomfort[r] ? `Discomfort ${discomfort[r]}/10`
        : ind ? `${INDICATORS[ind]?.label} ${formatIndicatorValue(ind, today[ind].value)}` : null;
      return {
        region: r,
        anchor,
        side,
        level: levels[r],
        title: `${parts[r]?.label || r} · ${LEVEL_WORD[levels[r]]}`,
        detail,
      };
    }).filter(Boolean);
  }, [content.data, levels, selected, today, discomfort]);

  const info = selected ? content.data?.body_parts?.[selected] : null;
  const regionChips = [{ id: null, label: "All body" }, ...REGIONS.map((r) => ({ id: r, label: content.data?.body_parts?.[r]?.label || r }))];

  return (
    <>
      <motion.div variants={{ initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 } }} className="flex flex-wrap items-center gap-3">
        <p className="m-0 mr-auto max-w-2xl text-[15px] text-ink-2">
          Describe how you feel or tap your twin — Astra compares it with your own baseline and tells you what to do next.
        </p>
        <Button onClick={() => setChatOpen(true)}>
          <Icon name="doctor-ai" size={17} /> Chat
        </Button>
        {openVoice && (
          <Button variant="primary" onClick={openVoice}>
            <Icon name="waveform" size={17} /> Talk to Astra
          </Button>
        )}
      </motion.div>

      <div role="radiogroup" aria-label="Body region" className="flex flex-wrap gap-2">
        {regionChips.map((c) => {
          const on = selected === c.id;
          return (
            <button
              key={c.label}
              role="radio"
              aria-checked={on}
              onClick={() => setSelected(c.id)}
              className={cx(
                "relative flex min-h-9 cursor-pointer items-center gap-2 rounded-full border px-3.5 text-[13px] transition-colors",
                on ? "border-accent text-accent-on" : "border-line-strong bg-raised text-ink-2 hover:text-ink",
              )}
            >
              {on && <motion.span layoutId="region-chip" className="absolute inset-0 rounded-full bg-accent" transition={{ type: "spring", stiffness: 420, damping: 36 }} />}
              {c.id && <span className={cx("relative h-2 w-2 rounded-full", LEVEL_DOT[levels[c.id]])} />}
              <span className="relative">{c.label}</span>
            </button>
          );
        })}
      </div>

      <div className="grid gap-[18px] xl:grid-cols-[300px_minmax(0,1fr)_280px]">
        <div className="order-2 flex flex-col gap-[18px] xl:order-1">
          <ProfileCard summary={s} mission={mission.data} level={overall} />
          <RegionCard
            region={selected}
            info={info}
            level={selected ? levels[selected] : "GRAY"}
            discomfort={selected ? discomfort[selected] || 0 : 0}
            onDraft={(v) => setDraft((d) => ({ ...d, [selected]: v }))}
            onCommit={(v) => persistDiscomfort(selected, v)}
            today={today}
            history={histories}
            anyRed={REGIONS.some((r) => levels[r] === "RED")}
            astroId={astroId}
            onAnalyze={analyze}
            toast={toast}
          />
          <LogReadingCard astroId={astroId} rules={rules.data} />
        </div>

        <motion.section
          variants={{ initial: { opacity: 0, scale: 0.98 }, animate: { opacity: 1, scale: 1, transition: { duration: 0.6 } } }}
          aria-label="Digital twin"
          className="relative order-1 min-h-[560px] overflow-hidden rounded-card-l border border-line bg-[radial-gradient(ellipse_at_50%_35%,rgba(30,48,105,.55)_0%,rgba(8,12,28,.75)_60%,rgba(4,7,14,.9)_100%)] shadow-[inset_0_1px_0_rgba(255,255,255,.07)] xl:order-2 xl:min-h-[720px]"
        >
          <div className="absolute inset-0">
            <WebGLBoundary>
            <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted">Loading 3D twin…</div>}>
              <AnatomyScene
                levels={levels}
                selected={selected}
                onSelect={setSelected}
                layers={layers}
                heartRate={typeof today.heart_rate?.value === "number" ? today.heart_rate.value : null}
                calloutsFor={calloutsFor}
                resetSignal={resetSignal}
              />
            </Suspense>
            </WebGLBoundary>
          </div>
          <div className="pointer-events-none absolute top-4 left-4 flex flex-col gap-1">
            <span className="w-fit rounded-full border border-accent-text/40 bg-accent-soft px-2.5 py-0.5 text-[11px] font-bold tracking-[0.12em] text-accent-text">3D · DIGITAL TWIN</span>
            <span className="text-xs text-muted">Drag to rotate · scroll to zoom · tap a part</span>
          </div>
          <span className="pointer-events-none absolute top-4 right-4 hidden max-w-[260px] sm:block text-right text-[10px] leading-snug text-subtle">{STRINGS.bodyPartsAttribution}</span>
          <div className="absolute right-4 bottom-4 left-4 flex flex-wrap items-end justify-between gap-3">
            <TwinToolbar layers={layers} setLayers={setLayers} onReset={() => { setSelected(null); setResetSignal((n) => n + 1); }} />
          </div>
        </motion.section>
        <p className="order-1 -mt-3 text-[10px] text-subtle sm:hidden">{STRINGS.bodyPartsAttribution}</p>

        <motion.div variants={{ initial: {}, animate: { transition: { staggerChildren: 0.06 } } }} className="order-3 grid content-start gap-3 sm:grid-cols-2 xl:grid-cols-1">
          {LAB_INDICATORS.map((k) => <LabTile key={k} indicator={k} reading={today[k]} rows={histories[k]} />)}
        </motion.div>
      </div>

      <Timeline histories={histories} />

      <ChatDrawer
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        consultation={consultation}
        onAnalyze={analyze}
        astroId={astroId}
        onVoiceMode={openVoice}
      />
    </>
  );
}
