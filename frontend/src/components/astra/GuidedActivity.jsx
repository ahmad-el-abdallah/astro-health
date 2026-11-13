// Guided activities on Astra's voice screen (after you say yes to one):
//   * breathing      -- box breathing 4-4-4-4, 4 rounds; a circle grows and shrinks, a soft
//                       tone marks each phase (she only speaks the intro and the end, because
//                       a neural voice is too slow for counted cues). Logged as a breathing activity.
//   * reaction_test  -- 5 rounds: wait for green, then tap (or press Space). A tap before green
//                       is a lapse. Saved as a reaction-time reading, judged against YOUR baseline.
//   * measure_guide  -- the step-by-step measuring guide (config/content.json measure_guides),
//                       read out one step at a time; Next / Back to move.
// Each calls onDone({ text }) with what Astra should say at the end (or onDone(null) when you stop).
import { useCallback, useEffect, useRef, useState } from "react";
import { post } from "../../lib/api.js";
import { chime } from "../../lib/stationAudio.js";
import { cx } from "../ui/index.jsx";

const btn = "min-h-11 cursor-pointer rounded-xl border border-line-strong bg-control/70 px-4 text-sm font-semibold text-ink hover:bg-raised";

// ---------------------------------------------------------------- breathing
const PHASES = [["Breathe in", 1.0, 523], ["Hold", 1.0, 440], ["Breathe out", 0.55, 392], ["Hold", 0.55, 330]];
export const BREATH_PHASE_MS = 4000;
export const BREATH_ROUNDS = 4;

function Breathing({ astroId, speak, onDone, phaseMs = BREATH_PHASE_MS }) {
  const [step, setStep] = useState(-1); // -1 = intro
  const started = useRef(0);
  useEffect(() => {
    let alive = true;
    (async () => {
      await speak("Let's breathe together. Follow the circle: in for four, hold, out for four, hold.");
      started.current = Date.now();
      if (alive) setStep(0);
    })();
    return () => { alive = false; };
  }, [speak]);
  useEffect(() => {
    if (step < 0) return undefined;
    if (step >= BREATH_ROUNDS * 4) {
      const seconds = Math.round((Date.now() - started.current) / 1000);
      post(`/astronauts/${astroId}/breathing`, { seconds }).catch(() => {});
      onDone({ text: "Well done. That was four rounds of box breathing. Notice how you feel now." });
      return undefined;
    }
    chime(PHASES[step % 4][2]);
    const t = setTimeout(() => setStep((s) => s + 1), phaseMs);
    return () => clearTimeout(t);
  }, [step, astroId, onDone, phaseMs]);
  const [label, scale] = step < 0 ? ["Get comfortable…", 0.55] : PHASES[step % 4];
  const round = Math.min(BREATH_ROUNDS, Math.floor(Math.max(step, 0) / 4) + 1);
  return (
    <div className="flex flex-col items-center gap-6" data-activity="breathing">
      <div className="relative flex h-[300px] w-[300px] items-center justify-center">
        <div
          className="absolute rounded-full bg-[radial-gradient(circle,rgba(94,234,212,.55),rgba(56,189,248,.18)_60%,transparent_72%)]"
          style={{ width: 300, height: 300, transform: `scale(${scale})`, transition: `transform ${phaseMs}ms ease-in-out` }}
        />
        <div className="relative font-display text-2xl font-semibold">{label}</div>
      </div>
      <div className="text-sm text-muted">{step < 0 ? "Starting…" : `Round ${round} of ${BREATH_ROUNDS}`}</div>
    </div>
  );
}

// ---------------------------------------------------------------- reaction test
export const REACTION_ROUNDS = 5;
const LEVEL_TEXT = {
  GREEN: "right in line with your usual",
  YELLOW: "a bit slower than your usual. Some rest might help",
  RED: "much slower than your usual. Take it easy, and tell the flight surgeon if you feel off",
};

function ReactionTest({ astroId, speak, onDone }) {
  const [state, setState] = useState("intro"); // intro | wait | go | early | done
  const [times, setTimes] = useState([]);
  const [lapses, setLapses] = useState(0);
  const goAt = useRef(0);
  const timer = useRef(null);

  const arm = useCallback(() => {
    setState("wait");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { goAt.current = performance.now(); setState("go"); }, 1500 + Math.random() * 2500);
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      await speak("When the circle turns green, tap it as fast as you can. Five rounds.");
      if (alive) arm();
    })();
    return () => { alive = false; clearTimeout(timer.current); };
  }, [speak, arm]);

  const finish = useCallback(async (all, lapsed) => {
    setState("done");
    const avg = Math.round(all.reduce((a, b) => a + b, 0) / all.length);
    let level = null;
    try { level = (await post(`/astronauts/${astroId}/reaction`, { avg_ms: avg, lapses: lapsed })).level; } catch { /* still say it */ }
    onDone({ text: `Your average was ${avg} milliseconds${lapsed ? `, with ${lapsed} early tap${lapsed > 1 ? "s" : ""}` : ""}. That's ${LEVEL_TEXT[level] || "saved"}.` });
  }, [astroId, onDone]);

  const tap = useCallback(() => {
    if (state === "wait") {
      clearTimeout(timer.current);
      setLapses((n) => n + 1);
      setState("early");
      timer.current = setTimeout(arm, 1200);
      return;
    }
    if (state !== "go") return;
    const ms = performance.now() - goAt.current;
    const next = [...times, ms];
    setTimes(next);
    if (next.length >= REACTION_ROUNDS) finish(next, lapses);
    else arm();
  }, [state, times, lapses, arm, finish]);

  useEffect(() => {
    const onKey = (e) => { if (e.code === "Space") { e.preventDefault(); tap(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tap]);

  const color = state === "go" ? "bg-good-fg" : state === "early" ? "bg-alert-fg" : "bg-control";
  const word = { intro: "Get ready…", wait: "Wait for green…", go: "Tap!", early: "Too soon!", done: "Done" }[state];
  return (
    <div className="flex flex-col items-center gap-6" data-activity="reaction_test">
      <button
        type="button"
        onPointerDown={tap}
        aria-label="Reaction test: tap when green"
        className={cx("h-[260px] w-[260px] cursor-pointer rounded-full border border-line-strong text-2xl font-bold text-ink transition-colors duration-75", color)}
      >
        {word}
      </button>
      <div className="text-sm text-muted">
        Round {Math.min(REACTION_ROUNDS, times.length + 1)} of {REACTION_ROUNDS}
        {times.length ? ` · last ${Math.round(times.at(-1))} ms` : ""}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- measuring guide
function MeasureGuide({ guide, speak, onDone }) {
  const [i, setI] = useState(0);
  const steps = guide?.steps || [];
  useEffect(() => {
    if (!steps.length) { onDone({ text: "Sorry, I don't have a guide for that one." }); return; }
    speak(`${i === 0 ? `${guide.title}. ` : ""}Step ${i + 1}. ${steps[i]}`);
  }, [i]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!steps.length) return null;
  const last = i === steps.length - 1;
  return (
    <div className="flex w-full max-w-lg flex-col items-center gap-5 text-center" data-activity="measure_guide">
      <div className="ah-eyebrow">{guide.title}</div>
      <div className="text-sm text-muted">Step {i + 1} of {steps.length}</div>
      <p className="m-0 font-display text-xl font-semibold leading-snug">{steps[i]}</p>
      <div className="flex gap-2">
        <button className={btn} disabled={i === 0} onClick={() => setI((n) => n - 1)}>Back</button>
        <button className={btn} onClick={() => speak(`Step ${i + 1}. ${steps[i]}`)}>Repeat</button>
        {last
          ? <button className={cx(btn, "border-transparent bg-accent text-accent-on hover:bg-accent-hover")} onClick={() => onDone({ text: "That's it. When you have your number, just tell me and I'll log it." })}>Done</button>
          : <button className={cx(btn, "border-transparent bg-accent text-accent-on hover:bg-accent-hover")} onClick={() => setI((n) => n + 1)}>Next</button>}
      </div>
    </div>
  );
}

export function GuidedActivity({ activity, astroId, content, speak, onDone }) {
  if (activity.type === "breathing") return <Breathing astroId={astroId} speak={speak} onDone={onDone} />;
  if (activity.type === "reaction_test") return <ReactionTest astroId={astroId} speak={speak} onDone={onDone} />;
  if (activity.type === "measure_guide") return <MeasureGuide guide={content?.measure_guides?.[activity.indicator]} speak={speak} onDone={onDone} />;
  return null;
}
