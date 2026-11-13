// Mind page · "Latest Conversation Analysis": the voice tone of the LAST finished "Wanna talk?"
// conversation, computed on the server from that conversation's phrases only
// (backend/logic/voice_talks.py: the average of its phrases' seven probabilities). Kept
// apart from the self-reported mood on the same page and from the voice tone history card.
//
// conversationView() turns the API answer into one of: loading | analysing | success | empty
// | error, and ConversationAnalysisView draws it -- both pure, tested in
// ConversationAnalysis.test.jsx.
import { useLatestVoiceTalk } from "../../../../lib/queries.js";
import { fmtTime } from "../../../../lib/format.js";
import { pct, TONE_DISCLAIMER, TONE_LABELS, TONE_ORDER } from "../../../../lib/toneClip.js";
import { Button, Card, CardTitle } from "../../../../components/ui/index.jsx";

export const TITLE = "Latest Conversation Analysis";
export const SEPARATE_FROM_MOOD = "Estimated by the voice tone model from how your voice sounded in this one conversation. It's separate from the mood you log yourself, and it isn't a diagnosis.";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** query: { isLoading, isError, data: { talk } } -> what to show. */
export function conversationView(query) {
  if (query?.isLoading) return { state: "loading" };
  if (query?.isError) return { state: "error", message: "Couldn’t load the latest conversation analysis." };
  const talk = query?.data?.talk;
  if (!talk) return { state: "empty", message: "No conversation analysed yet. Start one with “Wanna talk?” above." };
  const base = { talk, when: talk.ended_at || talk.started_at };
  if (talk.status === "analysing" || talk.status === "active") {
    return { ...base, state: "analysing", message: `Analysing your last conversation… ${talk.phrases_analysed} of ${plural(talk.phrases_sent, "phrase")} done.` };
  }
  if (talk.status === "failed") {
    return { ...base, state: "error", message: `The voice tone analysis failed for that conversation (${plural(talk.phrases_failed, "phrase")}). Try another talk.` };
  }
  const result = talk.result;
  if (!result || !talk.phrases_analysed) {
    const tried = talk.phrases_sent ? ` None of its ${plural(talk.phrases_sent, "phrase")} could be analysed: too short, too quiet, or said over Astra.` : "";
    return { ...base, state: "empty", message: `Nothing to show for that conversation.${tried}` };
  }
  const bars = TONE_ORDER.map((tone) => ({ tone, label: TONE_LABELS[tone], p: Number(result.probabilities?.[tone]) || 0 }));
  return {
    ...base,
    state: "success",
    dominant: result.dominant,
    dominantLabel: TONE_LABELS[result.dominant] || result.dominant,
    confidence: result.confidence,
    bars,
    analysed: talk.phrases_analysed,
    sent: Math.max(talk.phrases_sent, talk.phrases_analysed),
    partial: talk.finish_reason === "timed out",
  };
}

export function ConversationAnalysisView({ view, onRetry }) {
  return (
    <Card aria-label={TITLE} className="flex w-full flex-col gap-4 border-l-[3px] border-l-accent-text">
      <CardTitle
        eyebrow="Voice tone · this conversation"
        title={TITLE}
        subtitle={SEPARATE_FROM_MOOD}
        right={view.when ? <span className="text-xs text-subtle">{fmtTime(view.when)}</span> : null}
        className="mb-0"
      />
      {view.state === "loading" && <p role="status" className="m-0 py-4 text-sm text-muted">Loading the latest conversation…</p>}
      {view.state === "analysing" && (
        <p role="status" aria-live="polite" className="m-0 flex items-center gap-2 py-4 text-sm text-ink-2">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent-text" aria-hidden="true" /> {view.message}
        </p>
      )}
      {view.state === "empty" && <p className="m-0 py-4 text-sm text-muted">{view.message}</p>}
      {view.state === "error" && (
        <div role="alert" className="flex flex-wrap items-center gap-3 py-2 text-sm text-alert-fg">
          <span>{view.message}</span>
          {onRetry && <Button className="min-h-9 px-3 text-[13px]" onClick={onRetry}>Try again</Button>}
        </div>
      )}
      {view.state === "success" && (
        <div className="grid gap-5 md:grid-cols-[minmax(180px,240px)_1fr]">
          <div className="flex flex-col justify-center gap-1 rounded-2xl border border-line bg-input p-4">
            <span className="ah-eyebrow">Dominant tone (estimate)</span>
            <span className="font-display text-3xl font-bold" data-testid="dominant">{view.dominantLabel}</span>
            <span className="text-sm text-ink-2" data-testid="dominant-pct">{pct(view.confidence)} of this conversation</span>
            <span className="mt-2 text-xs text-subtle" data-testid="phrase-count">
              {view.analysed} of {plural(view.sent, "phrase")} analysed{view.partial ? " (the analysis was cut short)" : ""}
            </span>
          </div>
          <dl aria-label="All seven voice tone probabilities for this conversation" className="m-0 flex flex-col gap-2">
            {view.bars.map(({ tone, label, p }) => (
              <div key={tone} className="flex items-center gap-3 text-[13px]">
                <dt className={tone === view.dominant ? "w-20 font-semibold text-ink" : "w-20 text-ink-2"}>{label}</dt>
                <dd className="m-0 h-2.5 flex-1 overflow-hidden rounded-full bg-raised" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p * 100)} aria-label={`${label} ${pct(p)}`}>
                  <div className={tone === view.dominant ? "h-full rounded-full bg-accent-text" : "h-full rounded-full bg-accent-text/45"} style={{ width: `${Math.max(0, Math.min(1, p)) * 100}%` }} />
                </dd>
                <span className="w-10 text-right text-subtle">{pct(p)}</span>
              </div>
            ))}
          </dl>
        </div>
      )}
      <p className="m-0 text-xs text-subtle">{TONE_DISCLAIMER}</p>
    </Card>
  );
}

export function LatestConversationAnalysis({ astroId }) {
  const q = useLatestVoiceTalk(astroId);
  return <ConversationAnalysisView view={conversationView(q)} onRetry={() => q.refetch()} />;
}
