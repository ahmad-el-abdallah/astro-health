// The Mind page's "Latest Conversation Analysis" section: what it shows for each state
// (loading, analysing, success, empty, error), rendered to HTML (no browser needed).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { conversationView, ConversationAnalysisView, SEPARATE_FROM_MOOD, TITLE } from "./ConversationAnalysis.jsx";

const talk = (over = {}) => ({
  talk_id: "talk-abc", status: "complete", started_at: "2026-11-13T13:10:00+00:00", ended_at: "2026-11-13T13:14:00+00:00",
  finished_at: "2026-11-13T13:14:02+00:00", phrases_sent: 4, phrases_analysed: 3, phrases_skipped: 1, phrases_failed: 0, finish_reason: "finished",
  result: {
    dominant: "happy", confidence: 0.62, phrases: 3,
    probabilities: { angry: 0.02, calm: 0.21, disgust: 0.01, fearful: 0.03, happy: 0.62, sad: 0.08, surprised: 0.03 },
  },
  ...over,
});
const html = (query) => renderToStaticMarkup(<ConversationAnalysisView view={conversationView(query)} onRetry={() => {}} />);
const text = (h) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("Latest Conversation Analysis", () => {
  it("success: dominant tone, its percentage, all seven bars and the phrase count", () => {
    const h = html({ data: { talk: talk() } });
    const t = text(h);
    expect(t).toContain(TITLE);
    expect(h).toMatch(/data-testid="dominant">Happy</);
    expect(h).toMatch(/data-testid="dominant-pct">62% of this conversation</);
    expect(h).toMatch(/data-testid="phrase-count">3 of 4 phrases analysed</);
    const meters = h.match(/role="meter"/g) || [];
    expect(meters).toHaveLength(7);
    for (const label of ["Angry 2%", "Calm 21%", "Disgust 1%", "Fearful 3%", "Happy 62%", "Sad 8%", "Surprised 3%"]) expect(h).toContain(`aria-label="${label}"`);
    expect(h).toContain('aria-valuenow="62"');
  });

  it("says it's a model estimate for this conversation, separate from self-reported mood", () => {
    const t = text(html({ data: { talk: talk() } }));
    expect(SEPARATE_FROM_MOOD).toMatch(/separate from the mood you log yourself/);
    expect(t).toContain("Estimated by the voice tone model");
    expect(t).toMatch(/doesn.t diagnose/);
  });

  it("loading: first load, then 'analysing' while the conversation's phrases are still being analysed", () => {
    expect(text(html({ isLoading: true }))).toContain("Loading the latest conversation");
    const h = html({ data: { talk: talk({ status: "analysing", result: null, phrases_sent: 5, phrases_analysed: 2 }) } });
    expect(h).toContain('role="status"');
    expect(text(h)).toContain("Analysing your last conversation… 2 of 5 phrases done.");
    expect(h).not.toContain('role="meter"');
  });

  it("empty: no conversation yet, or one where nothing could be analysed", () => {
    expect(text(html({ data: { talk: null } }))).toContain("No conversation analysed yet");
    const t = text(html({ data: { talk: talk({ result: null, phrases_analysed: 0, phrases_sent: 3, phrases_skipped: 3 }) } }));
    expect(t).toContain("None of its 3 phrases could be analysed");
  });

  it("error: the request failed, or every analysis in the conversation failed", () => {
    const h = html({ isError: true });
    expect(h).toContain('role="alert"');
    expect(text(h)).toContain("Couldn’t load the latest conversation analysis.");
    expect(text(h)).toContain("Try again");
    const f = text(html({ data: { talk: talk({ status: "failed", result: null, phrases_analysed: 0, phrases_failed: 2 }) } }));
    expect(f).toContain("The voice tone analysis failed for that conversation (2 phrases)");
  });

  it("a conversation the browser never finished is shown, marked as cut short", () => {
    const t = text(html({ data: { talk: talk({ finish_reason: "timed out" }) } }));
    expect(t).toContain("(the analysis was cut short)");
  });

  it("uses only the given conversation's own result (never an average of history)", () => {
    const v = conversationView({ data: { talk: talk({ result: { dominant: "sad", confidence: 0.5, phrases: 1, probabilities: { angry: 0, calm: 0.1, disgust: 0, fearful: 0.1, happy: 0.2, sad: 0.5, surprised: 0.1 } }, phrases_analysed: 1 }) } });
    expect(v.dominantLabel).toBe("Sad");
    expect(v.bars.find((b) => b.tone === "sad").p).toBe(0.5);
    expect(v.bars.map((b) => b.tone)).toEqual(["calm", "happy", "surprised", "sad", "fearful", "angry", "disgust"]);
  });
});
