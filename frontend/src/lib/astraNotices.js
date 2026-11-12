// Astra speaking first (docs/CLAUDE.md "Astra's abilities"). Pure rules: what she says, and
// what she offers to do, when something happens -- a worse health analysis, a schedule
// reminder or a missed task, a message or an "alert seen" from the flight surgeon, a
// follow-up she promised, the morning briefing. No AI call is made for any of these.
//
// A notice: { id, kind, text, actions?, question?, memoryId? }
//   actions  -> offered with the usual yes/no card when you answer her
//   question -> "Talk" sends this to the AI instead (the briefing)

const RANK = { GRAY: 0, GREEN: 0, YELLOW: 1, RED: 2 };
export const HEALTH_COOLDOWN_MS = 10 * 60 * 1000;
export const SPEAK_GAP_MS = 60 * 1000;

let seq = 0;
const notice = (kind, text, extra = {}) => ({ id: `${kind}-${Date.now()}-${++seq}`, kind, text, ...extra });
const lower = (t) => String(t || "").replace(/^./, (c) => c.toLowerCase());
const clip = (t, n) => (String(t || "").length > n ? `${String(t).slice(0, n - 1).trimEnd()}…` : String(t || ""));

/** A new health analysis for me. `last` = { level, noticedAt } (from earlier events).
 *  Speaks only when things got WORSE (yellow or red) and not more than once per 10 min. */
export function healthNotice(evt, last = {}, now = Date.now()) {
  const level = evt?.overall_level;
  if (level !== "YELLOW" && level !== "RED") return null;
  if (RANK[level] <= RANK[last.level || "GREEN"]) return null;
  if (last.noticedAt && now - last.noticedAt < HEALTH_COOLDOWN_MS) return null;
  const head = `${evt.state_label || "Health check"}. ${clip(evt.summary, 220)}`.trim();
  if (evt.alerted) return notice("health", `${head} I've already let the flight surgeon know.`);
  return notice("health", `${head} Want me to tell the flight surgeon?`, {
    actions: [{ type: "alert_surgeon", text: clip(`${evt.state_label || "Health check"}: ${evt.summary || ""}`, 200) }],
  });
}

// What she offers for each kind of routine task.
const TASK_OFFER = {
  vitals: { ask: "Want me to take a reading now?", actions: [{ type: "take_vitals" }] },
  exercise: { ask: "Should I start tracking your workout?", actions: [{ type: "start_workout" }] },
  sleep: { ask: "Should I start your sleep tracking?", actions: [{ type: "start_sleep" }] },
  mood: { ask: "How are you feeling right now?", actions: [] },
};

export function reminderNotice(r) {
  const offer = TASK_OFFER[r?.kind] || { ask: "", actions: [] };
  return notice("reminder", `It's ${r?.time || "time"}: ${r?.text || "a task"}. ${offer.ask}`.trim(), { actions: offer.actions });
}

/** Tasks that just turned "missed" since the last check (prev: { key: status }). The first
 *  check only records statuses, so opening the app never fires a burst of old misses. */
export function missedNotices(prev, entries) {
  const out = [];
  const next = {};
  for (const e of entries) {
    const key = `${e.time}-${e.kind}`;
    next[key] = e.status;
    if (e.status === "missed" && prev && prev[key] && prev[key] !== "missed") {
      const offer = TASK_OFFER[e.kind] || { ask: "", actions: [] };
      const ask = offer.actions.length ? offer.ask.replace(/ now\?$/, " now instead?") : offer.ask; // "instead" only with an offer
      out.push(notice("missed", `You missed ${lower(e.text)}. ${ask}`.trim(), { actions: offer.actions }));
    }
  }
  return { notices: out, statuses: next };
}

export const messageNotice = (m) => notice("message", `Message from the flight surgeon: ${clip(m?.body, 400)} Want to reply? Just tell me what to say.`);
export const ackNotice = (e) => notice("ack", `The flight surgeon has seen your alert: “${clip(e?.text, 120)}”.`);

export function followUpNotice(mem) {
  const t = String(mem?.text || "");
  let text;
  if (mem?.source === "pain") text = `Earlier you told me about ${lower(t)}. How is it now?`;
  else if (mem?.source === "mood") text = `Earlier you ${lower(t.replace(/\s*\(mood check-in\)$/, ""))}. How are you feeling now?`;
  else if (mem?.source === "symptoms") text = `Earlier you ${lower(t)}. Are you feeling any better?`;
  else text = `Earlier you told me: ${t}. How is that going?`;
  return notice("followup", text, { memoryId: mem?.id });
}

export function briefingNotice(name, hour = new Date().getHours()) {
  const part = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  return notice("briefing", `Good ${part}${name ? `, ${name}` : ""}. Want your daily briefing?`, { question: "Give me my briefing." });
}
export const briefingKey = (astroId, date = new Date()) => `ah-briefing-${astroId}-${date.toISOString().slice(0, 10)}`;

/** Say a notice out loud only when it won't surprise anyone or talk over something. */
export function canSpeakNotice({ notices, enabled, activated, owner, inCall, hidden, lastSpokenAt = 0, now = Date.now() }) {
  return notices === "speak" && enabled && activated && owner && !inCall && !hidden && now - lastSpokenAt >= SPEAK_GAP_MS;
}
