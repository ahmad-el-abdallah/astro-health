// "Wanna talk?" conversations in the browser: each call gets a server-made conversation id
// (POST /astronauts/<id>/voice-talks), every phrase analysis is tracked against THAT id, and
// when the call ends the conversation is closed, its still-running analyses are awaited, and
// only then is it finished (the server computes the conversation-level result from that
// conversation's phrases only -- backend/logic/voice_talks.py).
//
// The registry lives in this module, not in a React component, so analyses still in flight
// when the voice screen closes (or you navigate away) aren't lost: they complete and are
// counted, then the conversation is finished. A closed tab is covered by the server, which
// finishes stale conversations itself.
import { post } from "./api.js";

const talks = new Map(); // talkId -> { astroId, pending: Set<Promise>, sent, analysed, skipped, failed, closing }

/** Open a conversation on the server. Resolves to its id, or null (analysis unavailable). */
export async function openTalk(astroId, kind = "talk") {
  try {
    const t = await post(`/astronauts/${astroId}/voice-talks`, { kind });
    talks.set(t.talk_id, { astroId, pending: new Set(), sent: 0, analysed: 0, skipped: 0, failed: 0, closing: null });
    return t.talk_id;
  } catch (err) {
    console.info(`[astra] voice tone: conversation not started (${err?.status || err?.message || "error"})`);
    return null;
  }
}

/**
 * Track one phrase's analysis. work() resolves to "analysed" | "skipped" | "failed" (or
 * throws = failed). Returns the tracked promise.
 */
export function trackPhrase(talkId, work) {
  const t = talks.get(talkId);
  if (!t) return work();
  t.sent += 1;
  const p = Promise.resolve()
    .then(work)
    .then((outcome) => { t[outcome === "analysed" ? "analysed" : outcome === "skipped" ? "skipped" : "failed"] += 1; return outcome; })
    .catch(() => { t.failed += 1; return "failed"; })
    .finally(() => t.pending.delete(p));
  t.pending.add(p);
  return p;
}

/** Counts so far (for diagnostics / tests). */
export function talkCounts(talkId) {
  const t = talks.get(talkId);
  return t ? { sent: t.sent, analysed: t.analysed, skipped: t.skipped, failed: t.failed, pending: t.pending.size } : null;
}

/**
 * The call ended: close it now (the Mind page shows "analysing"), wait for every phrase still
 * being analysed, then finish it. Safe to call more than once. Resolves to the server's final
 * conversation, or null.
 */
export function finishTalk(talkId) {
  const t = talks.get(talkId);
  if (!t) return Promise.resolve(null);
  if (t.closing) return t.closing;
  t.closing = (async () => {
    const base = `/astronauts/${t.astroId}/voice-talks/${encodeURIComponent(talkId)}`;
    try { await post(`${base}/close`, { phrases_sent: t.sent }); } catch { /* finish below still runs */ }
    while (t.pending.size) await Promise.allSettled([...t.pending]); // analyses still running
    let done = null;
    try {
      done = await post(`${base}/finish`, { phrases_sent: t.sent, phrases_skipped: t.skipped, phrases_failed: t.failed });
    } catch (err) {
      console.warn(`[astra] voice tone: couldn't finish the conversation (${err?.status || err?.message || "error"})`);
    }
    console.info(`[astra] voice tone conversation finished: ${t.sent} phrase(s), ${t.analysed} analysed, ${t.skipped} without a clip, ${t.failed} failed`);
    talks.delete(talkId);
    return done;
  })();
  return t.closing;
}
