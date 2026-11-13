// Astra's conversation logic (one instance for the whole app lives in AstraProvider; the
// Flight Surgeon viewing a crew member's Body page gets a local text-only one).
//
// Every message -- typed, a quick chip, or spoken -- goes to the AI (POST
// /astronauts/<id>/chat, the same Groq key as the health analysis), which answers from this
// astronaut's data and latest analysis and may propose ACTIONS (lib/astraActions.js):
//   * navigate  -> returned as `navigate` (a path); the caller opens it (voice screen: after
//                  Astra finishes speaking, then the screen closes)
//   * anything that saves (mood, sleep, symptoms, vitals, pain, journal, alert) -> kept as
//                  `pending` and shown as a confirm card; nothing is saved until the
//                  astronaut says/clicks yes. The yes/no is understood HERE (isYes/isNo),
//                  never sent back to the AI, so it's instant and can't be misread.
//
// If the AI can't answer (no key, offline, rate limit, bad answer), that one message gets
// the instant keyword reply instead -- text chat always works.
//
// Reply text is rendered as React text nodes, so it can never inject HTML.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, post } from "../../../../lib/api.js";
import {
  ACTIVITIES, doneSentence, IMMEDIATE, isCancelPhrase, isEmergencyPhrase, isNo, isYes, PAGES, prepareActions, runActions,
} from "../../../../lib/astraActions.js";
import { REGION_KEYWORDS } from "../../../../three/anatomy/regions.js";

const now = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const HISTORY_TURNS = 8;
const CHAT_TIMEOUT_MS = 25000; // the server gives up at ~22 s; never sit on "Thinking…" longer
export const EMERGENCY_COUNTDOWN_MS = 5000;
let seq = 0;

function extractIntensity(text) {
  const num = (text.match(/\d+/) || [])[0];
  if (num) return Math.min(10, Math.max(1, Number(num)));
  if (/severe|strong|very|extreme/i.test(text)) return 8;
  if (/mild|slight/i.test(text)) return 2;
  return 5;
}

export function useConsultation({ astroId, content, mission, persistDiscomfort, selectRegion, onNavigate, onActivity }) {
  const [messages, setMessages] = useState([]);
  const [thinking, setThinking] = useState(false);
  const [source, setSource] = useState(null); // { kind: "ai", model } | { kind: "quick" } after the last reply
  const [pending, setPendingState] = useState(null); // { actions, msgId } waiting for a yes
  const pendingRef = useRef(null);
  const history = useRef([]); // plain {role, content} turns sent back to the AI
  const owner = useRef(null);

  const setPending = (p) => { pendingRef.current = p; setPendingState(p); };

  // "I need help now": a 5-second countdown you can cancel, then the real emergency.
  const [emergency, setEmergencyState] = useState(null); // { text, endsAt }
  const emergencyRef = useRef(null);
  const emergencyTimer = useRef(null);
  const setEmergency = (e) => { emergencyRef.current = e; setEmergencyState(e); };
  useEffect(() => () => clearTimeout(emergencyTimer.current), []);

  // A different astronaut = a fresh conversation (same as the old tab).
  const ensureConversation = useCallback((name) => {
    if (owner.current === astroId) return;
    owner.current = astroId;
    history.current = [];
    setPending(null);
    setMessages([{
      id: ++seq, who: "assistant", time: now(),
      text: `Hi ${name || "there"}, I'm Astra! Ask me how you're doing, tell me what hurts, or ask me to log something or open a page. You can also just say "Astra" on any page.`,
    }]);
  }, [astroId]);

  const add = (msg) => {
    const id = ++seq;
    setMessages((m) => [...m, { id, time: now(), ...msg }]);
    return id;
  };
  const update = (id, patch) => setMessages((m) => m.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const remember = (user, assistant) => {
    history.current = [...history.current, { role: "user", content: user }, { role: "assistant", content: assistant }]
      .slice(-HISTORY_TURNS);
  };
  const setCard = (msgId, status) => setMessages((m) => m.map((x) => (x.id === msgId && x.confirm ? { ...x, confirm: { ...x.confirm, status } } : x)));

  function missionHazardLine(region) {
    const info = content?.body_parts?.[region];
    const concerns = mission?.profile?.main_concerns || [];
    const match = (info?.hazards || []).find((h) => concerns.includes(h));
    const hazard = match && content?.hazards?.[match];
    return hazard ? `${mission.profile.label}: ${hazard.summary}` : "";
  }

  // Only reached when the AI couldn't answer (offline, busy, free limit). It never saves
  // anything -- saving always goes through Astra's "Should I…?" + yes -- it just says so
  // plainly and, if a body part was mentioned, adds that part's own advice.
  function quickReply(text) {
    const sorry = "Sorry, I couldn't reach my AI just now. It may be busy, please ask me again in a moment.";
    const match = REGION_KEYWORDS.find(([, re]) => re.test(text));
    const info = match && content?.body_parts?.[match[0]];
    if (!info) return { text: sorry };
    selectRegion(match[0]);
    const urgent = extractIntensity(text) >= 7 ? " If it's severe, contact the flight surgeon now." : "";
    return { text: `${sorry} About your ${info.label.toLowerCase()}: ${info.what_to_do}${urgent}`, note: missionHazardLine(match[0]) || null };
  }

  async function aiReply(text) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CHAT_TIMEOUT_MS);
    try {
      const d = await api(`/astronauts/${astroId}/chat`, {
        method: "POST", body: JSON.stringify({ message: text, history: history.current }), signal: ctrl.signal,
      });
      return { text: d.reply, source: { kind: "ai", model: d.model }, actions: d.actions || [] };
    } finally {
      clearTimeout(timer);
    }
  }

  const startEmergency = useCallback((why) => {
    if (emergencyRef.current) return emergencyRef.current;
    clearTimeout(emergencyTimer.current);
    const e = { text: why || "Emergency called by voice", endsAt: Date.now() + EMERGENCY_COUNTDOWN_MS };
    setEmergency(e);
    emergencyTimer.current = setTimeout(async () => {
      if (emergencyRef.current !== e) return;
      setEmergency(null);
      try {
        await post("/emergency", { text: `${e.text} (called through Astra)`, astronaut_id: astroId });
      } catch (err) {
        console.error("[astra] couldn't start the emergency:", err);
      }
    }, EMERGENCY_COUNTDOWN_MS);
    return e;
  }, [astroId]);

  const cancelEmergency = useCallback(() => {
    if (!emergencyRef.current) return null;
    clearTimeout(emergencyTimer.current);
    setEmergency(null);
    const text = "Okay, cancelled. I didn't call for help.";
    add({ who: "assistant", text });
    remember("(cancelled the emergency)", text);
    return { text };
  }, []);

  // Save what's pending (the astronaut said / clicked yes). Returns { text, activity? } to speak.
  const confirm = useCallback(async () => {
    const p = pendingRef.current;
    if (!p) return null;
    setPending(null);
    setCard(p.msgId, "saving");
    const results = await runActions(p.actions, { astroId, persistDiscomfort });
    const disc = p.actions.find((a) => a.type === "log_discomfort");
    if (disc && results.some((r) => r.ok && r.action === disc)) selectRegion(disc.region);
    setCard(p.msgId, results.every((r) => r.ok) ? "saved" : "partly");
    const activity = results.find((r) => r.ok && r.data?.activity)?.data.activity || null;
    const text = doneSentence(results) || (activity ? "Okay, let's start." : "Done.");
    add({ who: "assistant", text });
    remember("(confirmed)", text);
    if (activity) onActivity?.(activity);
    return { text, activity };
  }, [astroId, persistDiscomfort, selectRegion, onActivity]);

  const cancel = useCallback(() => {
    const p = pendingRef.current;
    if (!p) return null;
    setPending(null);
    setCard(p.msgId, "cancelled");
    const text = "Okay, I won't save that.";
    add({ who: "assistant", text });
    remember("(cancelled)", text);
    return { text };
  }, []);

  // One pipeline for typed messages, quick chips AND voice. Returns { text, navigate? } so
  // the caller can speak the reply and then open the page.
  const submit = useCallback(async (raw) => {
    const text = (raw || "").trim();
    if (!text || !astroId || !content) return null;
    add({ who: "user", text });

    if (emergencyRef.current && isCancelPhrase(text)) return cancelEmergency();
    if (!emergencyRef.current && isEmergencyPhrase(text)) {
      // Never wait for the AI for this one.
      const reply = "Calling for help in 5 seconds. Say cancel if you're okay.";
      add({ who: "assistant", text: reply });
      remember(text, reply);
      startEmergency(text);
      return { text: reply };
    }

    if (pendingRef.current) {
      if (isYes(text)) return confirm();
      if (isNo(text)) return cancel();
      setCard(pendingRef.current.msgId, "dismissed"); // they moved on: drop it, answer the new question
      setPending(null);
    }

    const pendingBubble = add({ who: "assistant", text: "Thinking…", pending: true });
    setThinking(true);
    let result;
    try {
      result = await aiReply(text);
    } catch (err) {
      console.warn("[astra] AI chat failed, using quick replies:", err?.status || err?.name || err);
      result = { ...quickReply(text), source: { kind: "quick" }, actions: [] };
    }
    const nav = result.actions.find((a) => a.type === "navigate");
    const sos = result.actions.find((a) => a.type === "emergency");
    const now_ = result.actions.filter((a) => IMMEDIATE.includes(a.type)); // notes: no yes needed
    if (now_.length) runActions(now_, { astroId });
    // A guided activity starts at once (it saves nothing until the end, and has a Stop).
    const activity = sos ? null : result.actions.find((a) => ACTIVITIES.includes(a.type)) || null;
    const saves = sos ? [] : await prepareActions(result.actions.filter((a) => a.type !== "navigate" && a.type !== "emergency"
      && !IMMEDIATE.includes(a.type) && !ACTIVITIES.includes(a.type)), { astroId });
    if (sos) startEmergency(sos.text);
    update(pendingBubble, {
      text: result.text, note: result.note, pending: false,
      confirm: saves.length ? { actions: saves, status: "pending" } : undefined,
    });
    if (saves.length) setPending({ actions: saves, msgId: pendingBubble });
    setThinking(false);
    setSource(result.source);
    remember(text, result.text);
    if (activity) onActivity?.(activity);
    return { text: result.text, navigate: nav ? PAGES[nav.page]?.path : null, activity };
  }, [astroId, content, mission, confirm, cancel, cancelEmergency, startEmergency, onActivity]); // eslint-disable-line react-hooks/exhaustive-deps

  const say = useCallback((msg) => add({ who: "assistant", ...msg }), []);

  // Astra speaks first (a notice, a guided activity's result): her words join the
  // conversation, and anything she offers gets the usual yes/no card.
  const announce = useCallback(async (text, actions = []) => {
    if (!text) return null;
    const saves = await prepareActions(actions, { astroId });
    if (pendingRef.current) { setCard(pendingRef.current.msgId, "dismissed"); setPending(null); }
    const msgId = add({ who: "assistant", text, confirm: saves.length ? { actions: saves, status: "pending" } : undefined });
    if (saves.length) setPending({ actions: saves, msgId });
    history.current = [...history.current, { role: "assistant", content: text }].slice(-HISTORY_TURNS);
    return { text, pending: saves.length > 0 };
  }, [astroId]);

  // The astronaut talked over Astra. Keep the whole conversation, but let the AI know they
  // only heard part of her last answer, so the next reply picks up naturally from there.
  const markInterrupted = useCallback((heard) => {
    const h = history.current;
    const i = h.map((t) => t.role).lastIndexOf("assistant");
    if (i === -1 || h[i].content.includes("[interrupted")) return;
    const said = (heard || "").trim();
    h[i] = {
      ...h[i],
      content: `${h[i].content} [interrupted: the astronaut cut me off ${said ? `after "${said}…"` : "before hearing my answer"} and did not hear the rest]`,
    };
    setMessages((m) => {
      const last = m.map((x) => x.who).lastIndexOf("assistant");
      return last === -1 ? m : m.map((x, k) => (k === last ? { ...x, interrupted: true } : x));
    });
  }, []);
  const goTo = useCallback((path) => { if (path) onNavigate?.(path); }, [onNavigate]);

  return {
    messages, submit, say, announce, ensureConversation, thinking, source, pending, confirm, cancel, goTo, markInterrupted,
    emergency, cancelEmergency,
  };
}
