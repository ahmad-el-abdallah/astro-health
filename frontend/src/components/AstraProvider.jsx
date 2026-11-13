// Astra, available from every page (crew only -- the Flight Surgeon has no AI chat, by
// design). Owns:
//  * ONE conversation for the whole app (useConsultation), so the Body page's text chat and
//    the voice screen share it. The Body page links in while it's open (linkBody) so a
//    "my back hurts, maybe a 6" still highlights the region on the 3D twin.
//  * the wake word: a background listener (lib/wakeWord.js) -- say "Astra" (or "Astra, how am
//    I doing?") on any page and the voice screen opens. Paused while the voice screen is
//    open (it listens itself), ignored while Astra is talking (so she can't wake herself).
//  * the voice screen itself (VoiceMode), opened by the name or by useAstra().open().
//  * Astra speaking first (lib/astraNotices.js): a worse health analysis, schedule reminders
//    and missed tasks, a message / "alert seen" from the flight surgeon, follow-ups she
//    promised, the daily briefing. Shown as a small card (AstraNotice) and, when allowed,
//    said out loud; during a call she says it in the call instead.
// The top bar's Astra pill shows the listener's state and switches it on/off (remembered per
// browser, localStorage "ah-astra", default on).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthProvider.jsx";
import { get, post } from "../lib/api.js";
import { useContent, useMission, useSchedule } from "../lib/queries.js";
import { audioCtx, micMeter } from "../lib/stationAudio.js";
import { micLevels, wakeIsYou } from "../lib/hearing.js";
import { useVoice, voiceState } from "../lib/useVoice.js";
import { useSocketEvent } from "../lib/socket.js";
import { missionDaySeconds, withLiveStatus } from "../lib/schedule.js";
import {
  ackNotice, briefingKey, briefingNotice, canSpeakNotice, followUpNotice, healthNotice, messageNotice, missedNotices, reminderNotice,
} from "../lib/astraNotices.js";
import { AstraNotice } from "./astra/AstraNotice.jsx";
import { createWakeListener } from "../lib/wakeWord.js";
import { useConsultation } from "../pages/crew/body/useConsultation.js";
import { VoiceMode } from "../pages/crew/body/VoiceMode.jsx";

const PREF_KEY = "ah-astra";
const NO_ASTRA_ROUTES = ["/admin", "/status-board"];
const AstraContext = createContext({ available: false, open() {}, linkBody() { return () => {}; } });

function readPref() {
  try { return localStorage.getItem(PREF_KEY) !== "off"; } catch { return true; }
}

const getRecognition = () => (typeof window !== "undefined" ? window.SpeechRecognition || window.webkitSpeechRecognition : null);

export function AstraProvider({ children }) {
  const { user, isSurgeon } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const content = useContent();
  const mission = useMission();
  const astroId = user && !isSurgeon ? user.astronaut_id : null;
  const available = !!astroId && !NO_ASTRA_ROUTES.includes(pathname);

  const [enabled, setEnabledState] = useState(readPref);
  const [listenerState, setListenerState] = useState("off");
  const [call, setCall] = useState(null); // { question, key } while the voice screen is open
  const [activated, setActivated] = useState(() => !!navigator.userActivation?.hasBeenActive);
  const [owner, setOwner] = useState(true); // this tab has the microphone (see below)
  const bodyLink = useRef(null);
  const listenerRef = useRef(null);

  // ---- the one shared conversation ----
  const persistDiscomfort = useCallback(async (region, intensity) => {
    bodyLink.current?.onDiscomfort?.(region, intensity);
    try {
      await post(`/astronauts/${astroId}/discomfort`, { region, intensity });
      qc.invalidateQueries({ queryKey: ["summary"] });
    } catch { /* the reply still shows */ }
  }, [astroId, qc]);
  const selectRegion = useCallback((region) => bodyLink.current?.selectRegion?.(region), []);
  // "Take me to …": open the page and close the voice screen (it's called after Astra has
  // finished saying "Opening …").
  const onNavigate = useCallback((path) => { setCall(null); navigate(path); }, [navigate]);
  // A guided activity (breathing, reaction test, measuring guide) runs on the voice screen,
  // even when it was agreed in the text chat.
  const onActivity = useCallback((activity) => {
    audioCtx();
    setCall((c) => (c ? { ...c, activity } : { question: "", key: Date.now(), activity }));
  }, []);
  const consultation = useConsultation({
    astroId, content: content.data, mission: mission.data, persistDiscomfort, selectRegion, onNavigate, onActivity,
  });
  const { ensureConversation } = consultation;
  useEffect(() => { if (astroId && user?.name) ensureConversation(user.name); }, [astroId, user?.name, ensureConversation]);

  // ---- opening the voice screen ----
  const open = useCallback((question = "") => {
    audioCtx(); // inside a click this unlocks sound; from the wake word it's a no-op if never clicked
    setCall({ question, key: Date.now() });
  }, []);

  // ---- the wake word listener ----
  const secure = typeof window === "undefined" || window.isSecureContext;
  const Recognition = getRecognition();
  const listen = available && enabled && secure && !!Recognition && owner;
  useEffect(() => {
    if (!listen) return undefined;
    // The microphone level, so the name has to come from someone close (lib/hearing.js).
    micMeter.start();
    const l = createWakeListener({
      Recognition,
      onState: setListenerState,
      accept: (hit) => wakeIsYou(hit.confidence, micLevels),
      onWake: (hit) => {
        if (voiceState.speaking) return; // her own voice
        l.pause(); // right away: the voice screen starts its own recognition
        open(hit.question);
      },
    });
    listenerRef.current = l;
    l.start();
    return () => { l.stop(); listenerRef.current = null; micMeter.stop(); };
  }, [listen, Recognition, open]);

  // One tab at a time: two tabs listening at once take the microphone from each other over
  // and over, and then neither hears the name. The tab used last (shown or focused) claims
  // it; the others wait ("Astra in another tab") until they're used again.
  useEffect(() => {
    if (!available || typeof BroadcastChannel === "undefined") return undefined;
    const id = Math.random().toString(36).slice(2);
    const ch = new BroadcastChannel("ah-astra-mic");
    const claim = () => {
      if (document.visibilityState !== "visible") return;
      setOwner(true);
      ch.postMessage({ claim: id });
    };
    ch.onmessage = (e) => {
      if (e.data?.claim && e.data.claim !== id) setOwner(false);
      else if (e.data?.release && e.data.release !== id) claim();
    };
    if (document.visibilityState === "visible") ch.postMessage({ claim: id });
    const bye = () => ch.postMessage({ release: id });
    document.addEventListener("visibilitychange", claim);
    window.addEventListener("focus", claim);
    window.addEventListener("pointerdown", claim);
    window.addEventListener("pagehide", bye);
    return () => {
      bye();
      ch.close();
      document.removeEventListener("visibilitychange", claim);
      window.removeEventListener("focus", claim);
      window.removeEventListener("pointerdown", claim);
      window.removeEventListener("pagehide", bye);
    };
  }, [available]);

  // Back on the tab (or the window): start a fresh session -- browsers often stop hearing
  // in a hidden tab without saying so.
  useEffect(() => {
    if (!listen) return undefined;
    const kick = () => { if (document.visibilityState === "visible" && !call) listenerRef.current?.restart(); };
    document.addEventListener("visibilitychange", kick);
    window.addEventListener("focus", kick);
    return () => { document.removeEventListener("visibilitychange", kick); window.removeEventListener("focus", kick); };
  }, [listen, call]);

  // One recognition at a time: the voice screen listens itself, so pause meanwhile.
  useEffect(() => {
    const l = listenerRef.current;
    if (!l) return;
    if (call) l.pause();
    else l.resume();
  }, [call]);

  // Browsers only let a page make sound after one click/keypress on it.
  useEffect(() => {
    if (activated) return undefined;
    const on = () => { audioCtx(); setActivated(true); }; // also lets the microphone meter run
    window.addEventListener("pointerdown", on);
    window.addEventListener("keydown", on);
    return () => { window.removeEventListener("pointerdown", on); window.removeEventListener("keydown", on); };
  }, [activated]);

  const setEnabled = useCallback((on) => {
    try { localStorage.setItem(PREF_KEY, on ? "on" : "off"); } catch { /* not remembered */ }
    setEnabledState(on);
  }, []);

  const linkBody = useCallback((link) => {
    bodyLink.current = link;
    return () => { if (bodyLink.current === link) bodyLink.current = null; };
  }, []);

  // What the top-bar pill shows.
  const state = !available ? "off"
    : !enabled ? "off"
    : !Recognition ? "unsupported"
    : !secure ? "insecure"
    : !owner ? "elsewhere"
    : listenerState === "off" ? "starting" : listenerState;

  // ---- Astra speaking first ----
  const speaker = useVoice({ astroId, alwaysSpeak: true });
  const noticeSettings = speaker.settings.notices || "speak";
  const [notices, setNotices] = useState([]);
  const lastSpokenAt = useRef(0);
  const inCall = !!call;
  const live = useRef({});
  useEffect(() => {
    live.current = { inCall, owner, enabled, activated, noticeSettings, available, consultation, speak: speaker.speak };
  });
  const { cancel: stopSpeaker } = speaker;
  useEffect(() => { if (inCall) stopSpeaker(); }, [inCall, stopSpeaker]); // the call takes over

  const push = useCallback(async (n) => {
    const L = live.current;
    if (!n || !L.available || L.noticeSettings === "off") return;
    if (L.inCall) { // say it inside the call
      await L.consultation.announce(n.text, n.actions || []);
      if (n.memoryId) post(`/astronauts/${astroId}/memory/${n.memoryId}/done`, {}).catch(() => {});
      setCall((c) => (c ? { ...c, announcement: { text: n.text, key: n.id } } : c));
      return;
    }
    const now = Date.now();
    const spoken = canSpeakNotice({
      notices: L.noticeSettings, enabled: L.enabled, activated: L.activated, owner: L.owner, inCall: false,
      hidden: document.visibilityState !== "visible", lastSpokenAt: lastSpokenAt.current, now,
    }) && !voiceState.speaking;
    setNotices((list) => (list.some((x) => x.id === n.id || (n.memoryId && x.memoryId === n.memoryId)) ? list : [...list, { ...n, spoken }]));
    if (spoken) {
      lastSpokenAt.current = now;
      L.speak(n.text);
    }
  }, [astroId]);

  const dropNotice = useCallback((n) => {
    setNotices((list) => list.filter((x) => x.id !== n.id));
    if (n.memoryId) post(`/astronauts/${astroId}/memory/${n.memoryId}/done`, {}).catch(() => {});
  }, [astroId]);

  const talkNotice = useCallback(async (n) => {
    speaker.cancel();
    dropNotice(n);
    audioCtx();
    if (n.question) { setCall({ question: n.question, key: Date.now() }); return; }
    await consultation.announce(n.text, n.actions || []);
    setCall({ question: "", key: Date.now(), opening: { text: n.text, speak: !n.spoken } });
  }, [speaker, dropNotice, consultation]);

  const mine = (d) => available && d && Number(d.astronaut_id) === Number(astroId);
  const healthRef = useRef({});
  useSocketEvent("analysis", (d) => {
    if (!mine(d)) return;
    const n = healthNotice(d, healthRef.current);
    healthRef.current = { level: d.overall_level, noticedAt: n ? Date.now() : healthRef.current.noticedAt };
    push(n);
  });
  useSocketEvent("reminder", (d) => { if (available) push(reminderNotice(d)); });
  useSocketEvent("message_delivered", (d) => { if (mine(d) && d.from_role === "surgeon") push(messageNotice(d)); });
  useSocketEvent("alert_acknowledged", (d) => {
    if (!mine(d)) return;
    const wait = Math.max(0, new Date(d.deliver_at).getTime() - Date.now());
    setTimeout(() => push(ackNotice(d)), Math.min(wait, 10 * 60 * 1000)); // it has to cross the comms delay first
  });
  useSocketEvent("astra_followup", (d) => { if (mine(d)) push(followUpNotice(d)); });

  // On sign-in: follow-ups that came due while nobody was here, and the day's briefing.
  useEffect(() => {
    if (!available || !astroId) return undefined;
    let alive = true;
    get(`/astronauts/${astroId}/memory?due=1`).then((due) => {
      if (alive) (due || []).forEach((m) => push(followUpNotice(m)));
    }).catch(() => {});
    try {
      const key = briefingKey(astroId);
      if (!localStorage.getItem(key)) {
        localStorage.setItem(key, "1");
        push(briefingNotice(user?.name?.split(" ")[0]));
      }
    } catch { /* storage blocked: no briefing offer */ }
    return () => { alive = false; };
  }, [available, astroId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Missed tasks: the schedule on the mission clock, checked every 30 s (no server call).
  const schedule = useSchedule(available ? astroId : null);
  const statusesRef = useRef(null);
  useEffect(() => {
    if (!available || !schedule.data) return undefined;
    const check = () => {
      const entries = withLiveStatus(schedule.data.entries || [], missionDaySeconds(schedule.data, schedule.dataUpdatedAt));
      const { notices: missed, statuses } = missedNotices(statusesRef.current, entries);
      statusesRef.current = statuses;
      missed.forEach(push);
    };
    check();
    const t = setInterval(check, 30000);
    return () => clearInterval(t);
  }, [available, schedule.data, schedule.dataUpdatedAt, push]);

  const value = useMemo(() => ({
    available, astroId, consultation, open, enabled, setEnabled, state, activated, linkBody,
  }), [available, astroId, consultation, open, enabled, setEnabled, state, activated, linkBody]);

  return (
    <AstraContext.Provider value={value}>
      {children}
      {!call && available && notices.length > 0 && (
        <AstraNotice notice={notices[0]} more={notices.length - 1} onTalk={talkNotice} onDismiss={dropNotice} />
      )}
      {call && astroId && (
        <VoiceMode
          key={call.key}
          initialQuestion={call.question}
          opening={call.opening || null}
          announcement={call.announcement || null}
          activity={call.activity || null}
          onActivityDone={(result) => {
            setCall((c) => (c ? { ...c, activity: null } : c));
            if (result?.text) consultation.say({ text: result.text });
          }}
          emergency={consultation.emergency}
          onCancelEmergency={consultation.cancelEmergency}
          content={content.data}
          onClose={() => setCall(null)}
          astroId={astroId}
          submit={consultation.submit}
          thinking={consultation.thinking}
          pending={consultation.pending}
          onConfirm={consultation.confirm}
          onCancelPending={consultation.cancel}
          onNavigate={consultation.goTo}
          onInterrupted={consultation.markInterrupted}
        />
      )}
    </AstraContext.Provider>
  );
}

export const useAstra = () => useContext(AstraContext);
