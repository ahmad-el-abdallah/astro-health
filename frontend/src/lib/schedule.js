// The day's routine on the mission clock, shared by the Schedule page and Astra (who
// notices when a task is missed).
//
// The server decides "done" (from what was logged); the clock alone moves a task from
// upcoming → due → missed, so apply those steps locally the moment the clock passes them
// instead of waiting for the next refetch. Same rules as backend/jobs/scheduler.py.
export const DAY = 24 * 3600;
export const MISSED_AFTER_S = 3 * 3600;

export function withLiveStatus(entries, daySec) {
  return entries.map((e) => {
    if (e.status === "done") return e;
    const nextSame = entries.find((x) => x.kind === e.kind && x.seconds > e.seconds);
    let status = "upcoming";
    if (daySec >= e.seconds) {
      status = (nextSame && daySec >= nextSame.seconds) || daySec - e.seconds > MISSED_AFTER_S ? "missed" : "due";
    }
    return status === e.status ? e : { ...e, status };
  });
}

/** Seconds into the mission day now: the server's clock at fetch time + the real time since,
 *  sped up by time_scale. */
export function missionDaySeconds(plan, fetchedAt, now = Date.now()) {
  if (!plan) return 0;
  const total = (plan.day - 1) * DAY + plan.day_seconds + (Math.max(0, now - fetchedAt) / 1000) * plan.time_scale;
  return total % DAY;
}

/** Tasks that need doing right now: due or missed (done and upcoming don't count). */
export const dueCount = (entries) => entries.filter((e) => e.status === "due" || e.status === "missed").length;

/** The daily progress in one object: done of total, what's due now, and the next task. */
export function todaySummary(entries) {
  const done = entries.filter((e) => e.status === "done").length;
  const next = entries.find((e) => e.status === "due" || e.status === "missed") || entries.find((e) => e.status === "upcoming") || null;
  return { done, total: entries.length, due: dueCount(entries), next };
}
