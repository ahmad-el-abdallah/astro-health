// Mind & mood · "Today's mood check" (replaces the old pick-a-face mood log). Astra asks 3
// questions out loud each mission day (a new set every day, backend/logic/mood_check.py); you
// answer in your own words and the AI judges your mood from what you said AND how you sounded
// (the on-laptop voice-tone model, when it's set up). The result is a normal mood reading, so
// the chart, the Wellbeing ring and Today's mood task follow it.
// No voice (Firefox, mic blocked, not on localhost) -> the same 3 questions with text boxes.
// The surgeon sees the result, read-only.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get } from "../../../../lib/api.js";
import { fmtTime } from "../../../../lib/format.js";
import { submitMoodCheck, moodCheckStore, useMoodCheckState } from "../../../../lib/moodCheck.js";
import { TONE_LABELS } from "../../../../lib/toneClip.js";
import { useAstra } from "../../../../components/AstraProvider.jsx";
import { Button, Card, CardTitle, Shimmer, Spinner, cx } from "../../../../components/ui/index.jsx";
import { Icon } from "../../../../components/ui/Icon.jsx";
import Rough from "../../../../assets/icons/mood-rough.svg?react";
import Low from "../../../../assets/icons/mood-low.svg?react";
import Okay from "../../../../assets/icons/mood-okay.svg?react";
import Good from "../../../../assets/icons/mood-good.svg?react";
import Great from "../../../../assets/icons/mood-great.svg?react";

export const FACES = { rough: Rough, low: Low, okay: Okay, good: Good, great: Great };
const MOOD_WORD = { rough: "Rough", low: "Low", okay: "Okay", good: "Good", great: "Great" };
const LEVEL_TEXT = { GREEN: "text-good-fg", YELLOW: "text-check-fg", RED: "text-alert-fg" };

export function useMoodCheck(astroId) {
  return useQuery({ queryKey: ["mood-check", astroId], queryFn: () => get(`/astronauts/${astroId}/mood-check`), enabled: !!astroId });
}

/** What the card should show. Pure, so it can be tested without rendering.
 *  redo: "Do it again" was pressed -- back to the questions even though today's is done. */
export function moodCheckView({ loading, data, local, canTake, voiceOk, redo = false }) {
  if (local?.status === "analyzing") return "analyzing";
  if (local?.status === "error") return "error";
  if (local?.status === "done" && local.result) return "done"; // just finished (the query may still be refetching)
  if (loading || !data) return "loading";
  if (data.today && !redo) return "done";
  if (!canTake) return "waiting";
  return voiceOk ? "ready" : "typed";
}

function Result({ today }) {
  const Face = FACES[today.mood] || Okay;
  const tone = today.tone;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-4">
        <Face width={56} height={56} aria-hidden="true" className="shrink-0" />
        <div className="min-w-0">
          <div className={cx("font-display text-display font-semibold leading-none", LEVEL_TEXT[today.level])}>{MOOD_WORD[today.mood]}</div>
          {today.emotions?.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {today.emotions.map((e) => <span key={e} className="rounded-full bg-raised px-2 py-0.5 text-caption text-ink-2">{e}</span>)}
            </div>
          )}
        </div>
      </div>
      <p className="m-0 text-body text-ink-2">{today.note}</p>
      {tone && (
        <p className="m-0 text-label text-muted">
          Voice: mostly {(TONE_LABELS[tone.dominant] || tone.dominant).toLowerCase()} ({Math.round(tone.confidence * 100)}%) over {tone.phrases} phrase{tone.phrases === 1 ? "" : "s"}
        </p>
      )}
      <p className="m-0 text-caption text-subtle">
        {today.checked_by === "ai" ? `Judged by AI${today.model ? ` · ${today.model.split("/").pop()}` : ""}` : "AI offline · judged from your voice and words by simple rules"} · {fmtTime(today.ts)}
      </p>
    </div>
  );
}

function TypedAnswers({ questions, onSubmit, busy }) {
  const [answers, setAnswers] = useState(["", "", ""]);
  const ready = answers.every((a) => a.trim());
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (ready) onSubmit(answers); }}>
      {questions.map((q, i) => (
        <label key={q} className="flex flex-col gap-1.5">
          <span className="text-label font-medium">{i + 1}. {q}</span>
          <textarea className="ah-input min-h-16" value={answers[i]} onChange={(e) => setAnswers((a) => a.map((x, j) => (j === i ? e.target.value : x)))} />
        </label>
      ))}
      <Button variant="primary" type="submit" className="w-fit" disabled={!ready} busy={busy}>Send to Astra</Button>
    </form>
  );
}

export function DailyMoodCheck({ astroId }) {
  const astra = useAstra();
  const q = useMoodCheck(astroId);
  const local = useMoodCheckState();
  const [typing, setTyping] = useState(false);
  const [redo, setRedo] = useState(false);
  const own = astra.available && Number(astra.astroId) === Number(astroId);
  const Recognition = typeof window !== "undefined" ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
  const secure = typeof window === "undefined" || window.isSecureContext;
  const voiceOk = own && !!Recognition && secure && !typing;
  const view = moodCheckView({ loading: q.isLoading, data: q.data, local, canTake: own, voiceOk, redo });
  const today = (local.status === "done" && local.result) || q.data?.today;
  const questions = q.data?.questions || [];

  function start() {
    moodCheckStore.reset();
    astra.check({ questions, dayIndex: q.data.day_index });
  }
  // "Do it again": back to today's questions (voice or typed, whichever this browser can do)
  function again() {
    moodCheckStore.reset();
    setTyping(false);
    setRedo(true);
  }
  const sendTyped = (answers) => submitMoodCheck(astroId, { answers, dayIndex: q.data.day_index });

  return (
    <Card className="flex min-w-0 flex-[2_1_520px] flex-col gap-4">
      <CardTitle
        title="Today’s mood check"
        subtitle={q.data ? `Mission day ${q.data.day} · 3 new questions every day, answered out loud` : "3 new questions every day, answered out loud"}
        right={view === "done" && own ? <Button className="min-h-10 px-3.5 text-label" onClick={again}><Icon name="reset" size={16} /> Do it again</Button> : null}
        className="mb-0"
      />

      {view === "loading" && <Shimmer className="h-40" />}

      {view === "analyzing" && (
        <div className="flex items-center gap-3 rounded-[var(--radius-inner)] bg-raised p-4 text-body text-ink-2" role="status">
          <Spinner size={18} /> Astra is looking at your answers and how you sounded…
        </div>
      )}

      {view === "error" && (
        <div className="flex flex-col gap-3 rounded-[var(--radius-inner)] bg-alert-bg p-4 text-body text-alert-fg">
          Couldn’t save today’s mood check: {local.error}
          <Button className="w-fit" onClick={again}>Try again</Button>
        </div>
      )}

      {view === "done" && <Result today={today} />}

      {view === "waiting" && <p className="m-0 text-body text-muted">No mood check yet today. The astronaut takes it from their own sign-in.</p>}

      {(view === "ready" || view === "typed") && (
        <>
          <p className="m-0 text-body text-ink-2">
            Astra asks you three questions and judges your mood from what you say and how you sound. There’s no right answer, just say how it is.
          </p>
          {view === "ready" ? (
            <>
              <ol className="m-0 flex list-decimal flex-col gap-1.5 pl-5 text-body text-ink">
                {questions.map((x) => <li key={x}>{x}</li>)}
              </ol>
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="primary" onClick={start}><Icon name="mic" size={16} /> Start mood check</Button>
                <button type="button" className="cursor-pointer text-label text-accent-text underline underline-offset-2" onClick={() => setTyping(true)}>Type my answers instead</button>
              </div>
            </>
          ) : (
            <>
              {!typing && <p className="m-0 text-label text-muted">{own ? "Voice needs Chrome or Edge on http://localhost:5000, so type your answers here." : ""}</p>}
              <TypedAnswers questions={questions} onSubmit={sendTyped} busy={local.status === "analyzing"} />
            </>
          )}
        </>
      )}
    </Card>
  );
}
