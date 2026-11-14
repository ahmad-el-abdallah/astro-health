import { describe, expect, it } from "vitest";
import { moodCheckView } from "./DailyMoodCheck.jsx";

const data = { day: 1, day_index: 0, questions: ["a?", "b?", "c?"], today: null };

describe("daily mood check card", () => {
  it("shows loading, then the start button or the typed form", () => {
    expect(moodCheckView({ loading: true, data: null, local: {}, canTake: true, voiceOk: true })).toBe("loading");
    expect(moodCheckView({ loading: false, data, local: {}, canTake: true, voiceOk: true })).toBe("ready");
    expect(moodCheckView({ loading: false, data, local: {}, canTake: true, voiceOk: false })).toBe("typed");
  });
  it("shows analyzing and errors over everything else", () => {
    expect(moodCheckView({ loading: false, data, local: { status: "analyzing" }, canTake: true, voiceOk: true })).toBe("analyzing");
    expect(moodCheckView({ loading: false, data, local: { status: "error" }, canTake: true, voiceOk: true })).toBe("error");
  });
  it("shows today's result once done, and the surgeon only ever sees results", () => {
    const done = { ...data, today: { mood: "good" } };
    expect(moodCheckView({ loading: false, data: done, local: {}, canTake: true, voiceOk: true })).toBe("done");
    expect(moodCheckView({ loading: false, data: done, local: {}, canTake: false, voiceOk: false })).toBe("done");
    expect(moodCheckView({ loading: false, data, local: {}, canTake: false, voiceOk: false })).toBe("waiting");
  });
  it("goes back to the questions on Do it again, and shows a just-finished result at once", () => {
    const done = { ...data, today: { mood: "good" } };
    expect(moodCheckView({ loading: false, data: done, local: {}, canTake: true, voiceOk: false, redo: true })).toBe("typed");
    expect(moodCheckView({ loading: false, data: done, local: {}, canTake: true, voiceOk: true, redo: true })).toBe("ready");
    expect(moodCheckView({ loading: true, data: null, local: { status: "done", result: { mood: "low" } }, canTake: true, voiceOk: true, redo: true })).toBe("done");
  });
});
