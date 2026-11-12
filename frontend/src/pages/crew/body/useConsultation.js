// Doctor AI consultation logic, ported from static/js/tabs/body.js (chat section).
//
// Every message -- typed, a quick chip, or spoken (ChatDrawer + lib/useVoice.js) -- goes
// to the AI (POST /astronauts/<id>/chat, the same Groq key as the health analysis), which
// answers from this astronaut's data and latest analysis. If its reply names a body region
// + intensity, that's logged through the same POST /discomfort the slider uses (which also
// triggers a fresh health analysis) and the region is selected on the twin.
//
// If the AI can't answer (no key, offline, rate limit, bad answer), that one message gets
// the instant keyword reply instead -- text chat always works.
//
// Reply text is rendered as React text nodes, so it can never inject HTML.
import { useCallback, useRef, useState } from "react";
import { post } from "../../../lib/api.js";
import { REGION_KEYWORDS } from "../../../three/anatomy/regions.js";

const now = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const HISTORY_TURNS = 8;
let seq = 0;

function extractIntensity(text) {
  const num = (text.match(/\d+/) || [])[0];
  if (num) return Math.min(10, Math.max(1, Number(num)));
  if (/severe|strong|very|extreme/i.test(text)) return 8;
  if (/mild|slight/i.test(text)) return 2;
  return 5;
}

export function useConsultation({ astroId, content, mission, persistDiscomfort, selectRegion }) {
  const [messages, setMessages] = useState([]);
  const [thinking, setThinking] = useState(false);
  const [source, setSource] = useState(null); // { kind: "ai", model } | { kind: "quick" } after the last reply
  const history = useRef([]); // plain {role, content} turns sent back to the AI
  const owner = useRef(null);

  // A different astronaut = a fresh conversation (same as the old tab).
  const ensureConversation = useCallback((name) => {
    if (owner.current === astroId) return;
    owner.current = astroId;
    history.current = [];
    setMessages([{
      id: ++seq, who: "assistant", time: now(),
      text: `Hi ${name || "there"}! Ask me how you're doing, tell me what hurts, or press the mic and just talk.`,
    }]);
  }, [astroId]);

  const add = (msg) => {
    const id = ++seq;
    setMessages((m) => [...m, { id, time: now(), ...msg }]);
    return id;
  };
  const update = (id, patch) => setMessages((m) => m.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  function missionHazardLine(region) {
    const info = content?.body_parts?.[region];
    const concerns = mission?.profile?.main_concerns || [];
    const match = (info?.hazards || []).find((h) => concerns.includes(h));
    const hazard = match && content?.hazards?.[match];
    return hazard ? `${mission.profile.label}: ${hazard.summary}` : "";
  }

  function quickReply(text) {
    const match = REGION_KEYWORDS.find(([, re]) => re.test(text));
    if (!match) {
      return { text: 'I could not tell which body part you mean. Try "headache", "back pain 6" or "my heart is racing".' };
    }
    const [region] = match;
    const intensity = extractIntensity(text);
    persistDiscomfort(region, intensity);
    selectRegion(region);
    const info = content.body_parts[region];
    let t = `Logged ${intensity}/10 discomfort for ${info.label} and updated your twin. `;
    t += intensity >= 7 ? "That is high — send a report to the flight surgeon now." : info.what_to_do;
    const hazard = missionHazardLine(region);
    return { text: t, note: intensity >= 4 && hazard ? hazard : null };
  }

  async function aiReply(text) {
    const d = await post(`/astronauts/${astroId}/chat`, { message: text, history: history.current });
    if (d.region && Number.isInteger(d.intensity)) {
      persistDiscomfort(d.region, d.intensity);
      selectRegion(d.region);
    }
    return { text: d.reply, source: { kind: "ai", model: d.model } };
  }

  // One pipeline for typed messages, quick chips AND voice transcripts. Returns the reply
  // ({ text, ... }) so the drawer can speak it.
  const submit = useCallback(async (raw) => {
    const text = (raw || "").trim();
    if (!text || !astroId || !content) return null;
    add({ who: "user", text });
    const pending = add({ who: "assistant", text: "Thinking…", pending: true });
    setThinking(true);
    let result;
    try {
      result = await aiReply(text);
    } catch {
      result = { ...quickReply(text), source: { kind: "quick" } };
    }
    update(pending, { text: result.text, note: result.note, pending: false });
    setThinking(false);
    setSource(result.source);
    history.current = [...history.current, { role: "user", content: text }, { role: "assistant", content: result.text }]
      .slice(-HISTORY_TURNS);
    return result;
  }, [astroId, content, mission]); // eslint-disable-line react-hooks/exhaustive-deps

  const say = useCallback((msg) => add({ who: "assistant", ...msg }), []);

  return { messages, submit, say, ensureConversation, thinking, source };
}
