// The daily mood check (backend/logic/mood_check.py): Astra asks today's 3 questions on the
// voice screen (AstraProvider.check), then the answers -- plus the conversation id whose voice
// clips the on-laptop tone model analysed -- go to POST /mood-check, where the AI judges the
// mood. This module holds the "analyzing / done / error" state the Mind page card shows, so it
// survives the voice screen closing and the page re-rendering.
import { useSyncExternalStore } from "react";
import { post } from "./api.js";
import { finishTalk } from "./toneTalks.js";

let state = { status: "idle", result: null, error: "" }; // idle | analyzing | done | error
const listeners = new Set();
function set(next) { state = { ...state, ...next }; listeners.forEach((l) => l()); }
export const moodCheckStore = {
  get: () => state,
  subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
  reset() { set({ status: "idle", result: null, error: "" }); },
};
export const useMoodCheckState = () => useSyncExternalStore(moodCheckStore.subscribe, moodCheckStore.get);

/** Send the answers ({answers: [text×3], dayIndex, talkId?}). Waits for the voice clips'
 *  analyses to finish first, so the tone is part of the verdict. */
export async function submitMoodCheck(astroId, { answers, dayIndex, talkId = "" }) {
  set({ status: "analyzing", result: null, error: "" });
  try {
    if (talkId) await finishTalk(talkId); // idempotent: the voice screen may already be finishing it
    const result = await post(`/astronauts/${astroId}/mood-check`, { answers, day_index: dayIndex, talk_id: talkId || undefined });
    set({ status: "done", result });
    return result;
  } catch (err) {
    set({ status: "error", error: err?.message || "Couldn't save the mood check." });
    return null;
  }
}

export const MOOD_CHECK_INTRO = "Time for today's mood check. Three quick questions, just answer in your own words.";
export const MOOD_CHECK_OUTRO = "Thank you. I'll look at how you're doing, your result is on the Mind and mood page.";
