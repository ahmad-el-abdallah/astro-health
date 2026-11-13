// What Astra can do for the astronaut (docs/CLAUDE.md "Astra actions"). The AI proposes
// actions in its chat answer (validated on the server, backend/services/analyst.py); this
// file turns them into words for the confirm card / her voice, understands the spoken or
// typed "yes"/"no", and saves through the app's normal routes -- the same ones the forms
// use, so everything downstream (Socket.IO updates, the AI health analysis) just works.
import { del, get, post } from "./api.js";

export const PAGES = {
  overview: { path: "/", label: "Overview" },
  body: { path: "/body", label: "Astra & body" },
  trends: { path: "/trends", label: "Trends" },
  mind: { path: "/mind", label: "Mind & mood" },
  sleep: { path: "/sleep", label: "Sleep lab" },
  mission: { path: "/mission", label: "Mission health" },
  schedule: { path: "/today", label: "Today" },
};

const VITALS = [
  ["heart_rate", "heart rate", "bpm"],
  ["blood_pressure", "blood pressure", "mmHg"],
  ["blood_sugar", "blood sugar", "mg/dL"],
  ["temperature", "temperature", "°C"],
  ["oxygen_saturation", "blood oxygen", "%"],
];

const words = (id) => String(id).replace(/_/g, " ");

function vitalsText(a) {
  return VITALS.filter(([k]) => a[k] != null)
    .map(([k, label, unit]) => `${label} ${k === "blood_pressure" ? `${a[k].systolic}/${a[k].diastolic}` : a[k]} ${unit}`)
    .join(", ");
}

// Kinds of actions (the server checks every one, backend/services/analyst.py):
//  * guided activities start at once on the voice screen (nothing is saved until the end,
//    and there's a Stop button); when Astra offers one in a notice, it waits for a yes
//  * IMMEDIATE ones need no yes: notes Astra keeps for herself
//  * "emergency" never waits for a yes either -- it counts down so you can cancel instead
export const ACTIVITIES = ["breathing", "reaction_test", "measure_guide"];
export const IMMEDIATE = ["remember", "forget"];
const SUMMARY_LABEL = { today: "today's", week: "this week's" };

/** One line for the confirm card, e.g. "Log mood: low · note: stressed". */
export function describeAction(a) {
  switch (a.type) {
    case "message_surgeon": return `Message the flight surgeon: “${a.text}”`;
    case "send_summary": return `Send ${SUMMARY_LABEL[a.period] || "a"} health summary to the flight surgeon`;
    case "start_sleep": return "Start sleep tracking";
    case "stop_sleep": return "Stop sleep tracking and log the night";
    case "start_workout": return "Start workout tracking";
    case "stop_workout": return "Stop workout tracking and log it";
    case "breathing": return "Guided breathing exercise (about 1 minute)";
    case "reaction_test": return "Reaction test (5 taps)";
    case "measure_guide": return `Step-by-step: how to measure ${words(a.indicator)}`;
    case "remember": return `Remember: “${a.text}”`;
    case "forget": return "Forget a note";
    case "emergency": return `Emergency: ${a.text}`;
    case "navigate": return `Open ${PAGES[a.page]?.label || a.page}`;
    case "log_mood": return `Log mood: ${a.mood}${a.note ? ` · note: ${a.note}` : ""}`;
    case "log_sleep": return `Log sleep: ${a.bedtime} → ${a.wake_time}`;
    case "log_symptoms": return `Log symptoms: ${a.items.map(words).join(", ")}`;
    case "log_vitals": return `Log reading${a.simulated ? " (station sensors)" : ""}: ${vitalsText(a)}`;
    case "log_discomfort": return `Log pain: ${words(a.region)} ${a.intensity}/10`;
    case "journal": return `Journal entry: “${a.title}”`;
    case "alert_surgeon": return `Alert the flight surgeon: “${a.text}”`;
    default: return a.type;
  }
}

// How it reads inside "Done, I logged …".
function doneText(a) {
  switch (a.type) {
    case "log_mood": return `your mood as ${a.mood}`;
    case "log_sleep": return `your sleep from ${a.bedtime} to ${a.wake_time}`;
    case "log_symptoms": return `your symptoms: ${a.items.map(words).join(", ")}`;
    case "log_vitals": return `your ${vitalsText(a)}`;
    case "log_discomfort": return `${words(a.region)} pain at ${a.intensity} out of 10`;
    case "journal": return "your journal entry";
    case "alert_surgeon": return "an alert for the flight surgeon";
    default: return words(a.type);
  }
}

const listOf = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

const seconds = (s) => (s < 60 ? `${Math.round(s)} seconds` : `${Math.round(s / 60)} minute${Math.round(s / 60) === 1 ? "" : "s"}`);
const arrives = (d) => (d?.delay_s ? ` It reaches Earth in about ${seconds(d.delay_s)}.` : "");
const LEVEL_WORDS = { GREEN: "all good", YELLOW: "worth keeping an eye on", RED: "out of range" };

// Actions with their own sentence (they send or do something rather than "save" a value).
function specialSentence({ action: a, ok, data }) {
  if (!ok) return null;
  switch (a.type) {
    case "message_surgeon": return `Sent your message to the flight surgeon.${arrives(data)}`;
    case "send_summary": return `I sent ${SUMMARY_LABEL[a.period] || "your"} health summary to the flight surgeon.${arrives(data)}`;
    case "alert_surgeon": return `I alerted the flight surgeon.${arrives(data)}`;
    case "start_sleep": return data?.already ? "Sleep tracking is already running. Good night." : "Sleep tracking started. Good night, sleep well.";
    case "stop_sleep": return `Good morning. I logged ${data?.hours ?? "your"} hours of sleep${data?.level === "RED" ? ", which is short, so take it easy today" : ""}.`;
    case "start_workout": return data?.already ? "Your workout is already being tracked." : "Workout tracking started. Have a good one.";
    case "stop_workout": return `Nice work. I logged a ${data?.minutes ?? ""} minute workout.`;
    case "log_vitals": {
      const lvl = data?.overall_level;
      if (!lvl) return null;
      const note = data.note && lvl !== "GREEN" ? ` ${data.note.replace(/^(RED|YELLOW):\s*/, "Flagged: ")}.` : "";
      return `Saved your ${a.simulated ? "new " : ""}reading: ${LEVEL_WORDS[lvl] || lvl}.${note}${lvl !== "GREEN" ? " I'll have it analyzed right away." : ""}`;
    }
    default: return null;
  }
}

/** What Astra says after saving (results from runActions). */
export function doneSentence(results) {
  const special = results.map(specialSentence);
  const plain = results.filter((r, i) => special[i] == null && !ACTIVITIES.includes(r.action.type));
  const ok = plain.filter((r) => r.ok).map((r) => doneText(r.action));
  const bad = plain.filter((r) => !r.ok).map((r) => doneText(r.action));
  const parts = special.filter(Boolean);
  if (ok.length) parts.unshift(`Done, I saved ${listOf(ok)}.`);
  if (bad.length) parts.push(`I couldn't save ${listOf(bad)}, please try again.`);
  return parts.join(" ") || (results.length ? "" : "Nothing to save.");
}

// Short answers only: "yes, and what's my heart rate?" is a new question, not a yes.
const short = (t) => String(t || "").trim().split(/\s+/).length <= 6;
export const isNo = (t) => short(t) && /^\s*(no|nope|nah|cancel|don'?t|do not|stop|never ?mind|wrong|not now|forget it)\b/i.test(t);
export const isYes = (t) => short(t) && !isNo(t)
  && /^\s*(yes|yeah|yep|yup|sure|ok|okay|do it|save( it)?|go ahead|confirm(ed)?|correct|please( do)?|absolutely|right|that'?s right)\b/i.test(t);

// "Astra, I need help" -- even when the AI can't be reached.
export const isEmergencyPhrase = (t) => /\b(mayday|i need help (right )?now|help me now|this is an emergency|it'?s an emergency|i can'?t breathe|i cannot breathe|call for help|call help now)\b/i.test(String(t || ""));
export const isCancelPhrase = (t) => /\b(cancel|stop|no|don'?t|false alarm|i'?m (ok|okay|fine)|never ?mind|abort)\b/i.test(String(t || ""));

/** Before showing the card: "take my vitals" becomes a real reading from the (simulated)
 *  station sensors, so the card can show the actual numbers before anything is saved. */
export async function prepareActions(actions, { astroId }) {
  const out = [];
  for (const a of actions) {
    if (a.type !== "take_vitals") { out.push(a); continue; }
    try {
      const v = await get(`/astronauts/${astroId}/simulate_vitals`);
      out.push({ type: "log_vitals", simulated: true, ...v });
    } catch { /* sensors unavailable: skip it */ }
  }
  return out;
}

/** Save one confirmed action through the app's normal routes. Returns the route's answer
 *  (or, for a guided activity, { activity } for the voice screen to run). */
export async function runAction(a, { astroId, persistDiscomfort }) {
  const base = `/astronauts/${astroId}`;
  const activity = (kind, action) => post(`${base}/activity`, { kind, action });
  switch (a.type) {
    case "message_surgeon": return post(`${base}/message`, { text: a.text });
    case "send_summary": return post(`${base}/summary-report`, { period: a.period });
    case "start_sleep": return activity("sleep", "start");
    case "stop_sleep": return activity("sleep", "stop");
    case "start_workout": return activity("exercise", "start");
    case "stop_workout": return activity("exercise", "stop");
    case "breathing": case "reaction_test": case "measure_guide": return { activity: a };
    case "remember": return post(`${base}/memory`, { text: a.text, ...(a.follow_up_hours ? { follow_up_hours: a.follow_up_hours } : {}) });
    case "forget": return del(`${base}/memory/${a.id}`);
    case "log_mood": return post(`${base}/mood`, { mood: a.mood, note: a.note || "" });
    case "log_sleep": return post(`${base}/sleep`, { bedtime: a.bedtime, wake_time: a.wake_time });
    case "log_symptoms": return post(`${base}/symptoms`, { items: a.items });
    case "log_vitals": {
      const body = Object.fromEntries(VITALS.filter(([k]) => a[k] != null).map(([k]) => [k, a[k]]));
      return post(`${base}/assess`, body);
    }
    case "log_discomfort":
      if (persistDiscomfort) return persistDiscomfort(a.region, a.intensity);
      return post(`${base}/discomfort`, { region: a.region, intensity: a.intensity });
    case "journal": return post(`${base}/journal`, { title: a.title, body: a.body });
    case "alert_surgeon": return post(`${base}/alert`, { text: a.text });
    default: throw new Error(`unknown action ${a.type}`);
  }
}

/** Save several, one by one; returns [{ action, ok }]. */
export async function runActions(actions, helpers) {
  const results = [];
  for (const action of actions) {
    try {
      const data = await runAction(action, helpers);
      results.push({ action, ok: true, data });
    } catch {
      results.push({ action, ok: false });
    }
  }
  return results;
}
