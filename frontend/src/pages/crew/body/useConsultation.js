// Doctor AI consultation logic, ported from static/js/tabs/body.js (chat section).
//
// Primary path: the NVIDIA-hosted model (POST /astronauts/<id>/consult, server-side key)
// reads the free text and decides region/intensity plus optional actions -- log a vital,
// log a symptom, alert the flight surgeon, start a breathing exercise, or trigger the
// emergency. Each action reuses the existing route (one write path per kind of data),
// and a failure in one never blanks the reply. If /consult is unavailable (no key,
// offline, bad output) that one message falls back to keyword matching -- the next
// message tries the AI again.
//
// Model text is kept as plain text and rendered as React text nodes, so it can never
// inject HTML (the old app had to escape it by hand).
import { useCallback, useRef, useState } from "react";
import { post } from "../../../lib/api.js";
import { REGION_KEYWORDS } from "../../../three/anatomy/regions.js";

const now = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
let seq = 0;

function extractIntensity(text) {
  const num = (text.match(/\d+/) || [])[0];
  if (num) return Math.min(10, Math.max(1, Number(num)));
  if (/severe|strong|very|extreme/i.test(text)) return 8;
  if (/mild|slight/i.test(text)) return 2;
  return 5;
}

export function useConsultation({ astroId, content, mission, symptomCatalog, persistDiscomfort, selectRegion, toast, refresh }) {
  const [messages, setMessages] = useState([]);
  const [aiAvailable, setAiAvailable] = useState(true); // flips off after a 503 (no key configured)
  const history = useRef([]); // plain {role, content} turns sent back to the model
  const owner = useRef(null);

  // A different astronaut = a fresh conversation (same as the old tab).
  const ensureConversation = useCallback((name) => {
    if (owner.current === astroId) return;
    owner.current = astroId;
    history.current = [];
    setMessages([{
      id: ++seq, who: "assistant", time: now(),
      text: `Hi ${name || "there"}! Tell me what hurts, tap a body part on your twin, or press Analyze symptoms.`,
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

  function fallbackReply(text) {
    const match = REGION_KEYWORDS.find(([, re]) => re.test(text));
    if (!match) {
      const t = 'I could not tell which body part you mean. Try "headache", "back pain 6" or "my heart is racing".';
      return { text: t, raw: t };
    }
    const [region] = match;
    const intensity = extractIntensity(text);
    persistDiscomfort(region, intensity);
    selectRegion(region);
    const info = content.body_parts[region];
    let t = `Logged ${intensity}/10 discomfort for ${info.label} and updated your twin. `;
    t += intensity >= 7 ? "That is high — send a report to the flight surgeon now." : info.what_to_do;
    const hazard = missionHazardLine(region);
    return { text: t, raw: t, note: intensity >= 4 && hazard ? hazard : null };
  }

  async function aiReply(text) {
    const d = await post(`/astronauts/${astroId}/consult`, { message: text, history: history.current });
    const extras = [];
    if (d.region && Number.isInteger(d.intensity)) {
      await persistDiscomfort(d.region, d.intensity);
      selectRegion(d.region);
    }
    if (d.vital) {
      try {
        const r = await post(`/astronauts/${astroId}/assess`, d.vital);
        extras.push({ kind: "result", level: r.overall_level, text: r.note });
        refresh();
      } catch { /* the reply still shows on its own */ }
    }
    if (d.symptom) {
      try {
        const r = await post(`/astronauts/${astroId}/symptoms`, { items: [d.symptom] });
        const label = (symptomCatalog || []).find((s) => s.id === d.symptom)?.label || d.symptom;
        extras.push({ kind: "note", text: `Logged symptom: ${label} (${r.level}).` });
        refresh();
      } catch { /* non-fatal */ }
    }
    if (d.alert_surgeon && d.alert_text) {
      try {
        await post(`/astronauts/${astroId}/alert`, { text: d.alert_text });
        toast("Alert sent to the flight surgeon.", "warn");
        extras.push({ kind: "note", text: "Flight surgeon alerted." });
      } catch { /* non-fatal */ }
    }
    if (d.start_breathing) extras.push({ kind: "breathing" });
    if (d.trigger_emergency && d.emergency_text) {
      // The full-screen emergency overlay takes over the moment this lands.
      try { await post("/emergency", { text: d.emergency_text, astronaut_id: astroId }); } catch { /* non-fatal */ }
    }
    return { text: d.reply, raw: d.reply, extras };
  }

  // One pipeline for typed messages AND Face to Face voice transcripts.
  const submit = useCallback(async (raw, { onReply } = {}) => {
    const text = (raw || "").trim();
    if (!text || !astroId || !content) return null;
    add({ who: "user", text });
    const pending = add({ who: "assistant", text: "Thinking…", pending: true });
    let result;
    try {
      result = await aiReply(text);
      setAiAvailable(true);
    } catch (err) {
      if (err?.status === 503) setAiAvailable(false);
      result = fallbackReply(text);
    }
    update(pending, { text: result.text, pending: false, extras: result.extras, note: result.note });
    history.current.push({ role: "user", content: text }, { role: "assistant", content: result.raw });
    if (onReply) await onReply(result);
    return result;
  }, [astroId, content, mission, symptomCatalog]); // eslint-disable-line react-hooks/exhaustive-deps

  const say = useCallback((msg) => add({ who: "assistant", ...msg }), []);

  return { messages, submit, say, ensureConversation, aiAvailable };
}
