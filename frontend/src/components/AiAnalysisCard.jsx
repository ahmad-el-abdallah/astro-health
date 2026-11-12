// The AI health analyst's verdict for one astronaut (backend/logic/analysis.py): what
// state they seem to be in (sleeping, possibly sick...), the overall level, a short
// explanation, why, and what to do. "AI offline · checked by rules" when the AI couldn't
// be reached and the threshold rules decided instead. Updates live via the "analysis"
// Socket.IO event; "Analyze now" runs it on demand.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { post } from "../lib/api.js";
import { fmtTime } from "../lib/format.js";
import { Button, Card, StatusChip, cx } from "./ui/index.jsx";
import { Icon } from "./ui/Icon.jsx";

export const STATE_ICON = {
  well: "check", sleeping: "sleep", resting: "sun", exercising: "exercise", fatigued: "mind",
  stressed: "mood", needs_check: "bell", possibly_sick: "temperature", unwell: "alert",
  emergency: "alert", not_enough_data: "no-data",
};
const TONE = {
  GREEN: "bg-good-bg text-good-fg", YELLOW: "bg-check-bg text-check-fg",
  RED: "bg-alert-bg text-alert-fg", GRAY: "bg-none-bg text-none-fg",
};

export function StateChip({ analysis, className = "" }) {
  if (!analysis) return null;
  const level = analysis.state === "not_enough_data" ? "GRAY" : analysis.overall_level;
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] font-semibold", TONE[level] || TONE.GRAY, className)}>
      <Icon name={STATE_ICON[analysis.state] || "doctor-ai"} size={14} />
      {analysis.state_label}
    </span>
  );
}

function sourceLine(a) {
  if (a.source === "ai") return `Analyzed by AI${a.model ? ` · ${a.model.split("/").pop()}` : ""} · ${fmtTime(a.ts)}`;
  const why = a.error === "no recent data to analyze" ? "no recent data" : "AI offline";
  return `${why} · checked by the rules · ${fmtTime(a.ts)}`;
}

export function AiAnalysisCard({ astroId, summary, className = "" }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const a = summary?.analysis;
  const pending = busy || summary?.analysis_pending || (a && summary?.analysis_current === false);

  async function analyzeNow() {
    setBusy(true);
    try {
      await post(`/astronauts/${astroId}/analyze`);
    } finally {
      setBusy(false);
      ["summary", "crew", "history", "alerts"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    }
  }

  return (
    <Card className={cx("flex flex-col gap-4 p-6", className)}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-text">
          <Icon name="doctor-ai" size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="ah-eyebrow">AI health analysis</div>
          <div className="text-[13px] text-muted">{a ? sourceLine(a) : "Not analyzed yet"}</div>
        </div>
        {a && <StateChip analysis={a} />}
        {a && a.state !== "not_enough_data" && <StatusChip level={a.overall_level} />}
        <Button className="min-h-10 px-3.5 text-[13px]" onClick={analyzeNow} disabled={busy} aria-busy={busy}>
          <Icon name="reset" size={15} className={busy ? "animate-spin" : ""} /> {busy ? "Analyzing…" : "Analyze now"}
        </Button>
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={a ? a.id : "none"}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.3 }}
          className="flex flex-col gap-3"
        >
          <p className="m-0 font-display text-lg leading-snug font-semibold">
            {a ? a.summary : "Take a reading or check in on the CYD, and the AI will look at the whole picture."}
          </p>
          {a && (a.reasons.length > 0 || a.advice.length > 0) && (
            <div className="grid gap-4 sm:grid-cols-2">
              {a.reasons.length > 0 && (
                <div>
                  <div className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Why</div>
                  <ul className="m-0 list-disc space-y-1 pl-5 text-sm text-ink-2">{a.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
                </div>
              )}
              {a.advice.length > 0 && (
                <div>
                  <div className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">What to do</div>
                  <ul className="m-0 list-disc space-y-1 pl-5 text-sm text-ink-2">{a.advice.map((r, i) => <li key={i}>{r}</li>)}</ul>
                </div>
              )}
            </div>
          )}
        </motion.div>
      </AnimatePresence>

      {pending && !busy && (
        <div className="flex items-center gap-2 text-[13px] text-accent-text">
          <span className="h-1.5 w-1.5 animate-[ah-pulse-dot_1.6s_ease-in-out_infinite] rounded-full bg-accent-text" />
          New data · the AI is analyzing…
        </div>
      )}
      <p className="m-0 text-[11px] text-subtle">AI analysis of placeholder data. Not medical advice.</p>
    </Card>
  );
}
