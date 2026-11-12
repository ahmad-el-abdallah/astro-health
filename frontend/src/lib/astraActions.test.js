import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api.js", () => ({
  post: vi.fn(async () => ({ ok: true })),
  get: vi.fn(async () => ({ heart_rate: 71, blood_pressure: { systolic: 117, diastolic: 75 }, temperature: 36.8 })),
  del: vi.fn(async () => ({ ok: true })),
}));
import { del, post } from "./api.js";
import {
  describeAction, doneSentence, isCancelPhrase, isEmergencyPhrase, isNo, isYes, PAGES, prepareActions, runActions,
} from "./astraActions.js";

const ALL = [
  { type: "navigate", page: "sleep" },
  { type: "log_mood", mood: "low", note: "stressed" },
  { type: "log_sleep", bedtime: "23:00", wake_time: "06:30" },
  { type: "log_symptoms", items: ["headache", "back_pain"] },
  { type: "log_vitals", heart_rate: 72, blood_pressure: { systolic: 118, diastolic: 76 }, oxygen_saturation: 97 },
  { type: "log_discomfort", region: "skeleton", intensity: 6 },
  { type: "journal", title: "Day 3", body: "Felt tired." },
  { type: "alert_surgeon", text: "I feel dizzy" },
];

describe("isYes / isNo", () => {
  it("understands short yes answers", () => {
    for (const t of ["yes", "Yeah", "yep please", "sure", "okay", "do it", "save it", "go ahead", "that's right"]) expect(isYes(t)).toBe(true);
  });
  it("understands short no answers", () => {
    for (const t of ["no", "Nope", "cancel", "don't", "never mind", "not now", "no thanks"]) {
      expect(isNo(t)).toBe(true);
      expect(isYes(t)).toBe(false);
    }
  });
  it("a longer sentence is a new question, not an answer", () => {
    expect(isYes("yes and also what is my heart rate today please")).toBe(false);
    expect(isYes("how am I doing")).toBe(false);
    expect(isNo("how am I doing")).toBe(false);
  });
});

describe("describeAction", () => {
  it("has a plain line for every action type", () => {
    expect(ALL.map(describeAction)).toEqual([
      "Open Sleep lab",
      "Log mood: low · note: stressed",
      "Log sleep: 23:00 → 06:30",
      "Log symptoms: headache, back pain",
      "Log reading: heart rate 72 bpm, blood pressure 118/76 mmHg, blood oxygen 97 %",
      "Log pain: skeleton 6/10",
      "Journal entry: “Day 3”",
      "Alert the flight surgeon: “I feel dizzy”",
    ]);
  });
  it("every page id has a path", () => {
    for (const p of ["overview", "body", "trends", "mind", "sleep", "mission", "schedule", "learn"]) expect(PAGES[p].path).toMatch(/^\//);
  });
});

describe("runActions", () => {
  beforeEach(() => post.mockClear());
  it("saves each action through its normal route", async () => {
    await runActions(ALL.slice(1), { astroId: 1 });
    expect(post.mock.calls).toEqual([
      ["/astronauts/1/mood", { mood: "low", note: "stressed" }],
      ["/astronauts/1/sleep", { bedtime: "23:00", wake_time: "06:30" }],
      ["/astronauts/1/symptoms", { items: ["headache", "back_pain"] }],
      ["/astronauts/1/assess", { heart_rate: 72, blood_pressure: { systolic: 118, diastolic: 76 }, oxygen_saturation: 97 }],
      ["/astronauts/1/discomfort", { region: "skeleton", intensity: 6 }],
      ["/astronauts/1/journal", { title: "Day 3", body: "Felt tired." }],
      ["/astronauts/1/alert", { text: "I feel dizzy" }],
    ]);
  });
  it("pain goes through the shared discomfort helper when there is one (the 3D model follows)", async () => {
    const persistDiscomfort = vi.fn(async () => {});
    await runActions([ALL[5]], { astroId: 1, persistDiscomfort });
    expect(persistDiscomfort).toHaveBeenCalledWith("skeleton", 6);
    expect(post).not.toHaveBeenCalled();
  });
  it("reports what saved and what didn't", async () => {
    post.mockRejectedValueOnce(new Error("500"));
    const results = await runActions([ALL[1], ALL[2]], { astroId: 1 });
    expect(doneSentence(results)).toBe("Done, I saved your sleep from 23:00 to 06:30. I couldn't save your mood as low, please try again.");
  });
});

describe("Astra's newer abilities", () => {
  beforeEach(() => { post.mockClear(); del.mockClear(); });
  it("describes them on the card", () => {
    expect([
      { type: "message_surgeon", text: "Slept well" }, { type: "send_summary", period: "week" }, { type: "start_sleep" },
      { type: "stop_workout" }, { type: "breathing" }, { type: "reaction_test" }, { type: "measure_guide", indicator: "blood_pressure" },
    ].map(describeAction)).toEqual([
      "Message the flight surgeon: “Slept well”", "Send this week's health summary to the flight surgeon", "Start sleep tracking",
      "Stop workout tracking and log it", "Guided breathing exercise (about 1 minute)", "Reaction test (5 taps)",
      "Step-by-step: how to measure blood pressure",
    ]);
  });
  it("'take my vitals' becomes a real reading before the card is shown", async () => {
    const out = await prepareActions([{ type: "take_vitals" }, { type: "start_sleep" }], { astroId: 1 });
    expect(out[0]).toEqual({ type: "log_vitals", simulated: true, heart_rate: 71, blood_pressure: { systolic: 117, diastolic: 75 }, temperature: 36.8 });
    expect(describeAction(out[0])).toBe("Log reading (station sensors): heart rate 71 bpm, blood pressure 117/75 mmHg, temperature 36.8 °C");
    expect(out[1]).toEqual({ type: "start_sleep" });
  });
  it("runs them through the right routes", async () => {
    const r = await runActions([
      { type: "message_surgeon", text: "Hi" }, { type: "send_summary", period: "today" }, { type: "stop_sleep" },
      { type: "remember", text: "Knee hurts", follow_up_hours: 6 }, { type: "forget", id: 4 }, { type: "breathing" },
    ], { astroId: 1 });
    expect(post.mock.calls).toEqual([
      ["/astronauts/1/message", { text: "Hi" }], ["/astronauts/1/summary-report", { period: "today" }],
      ["/astronauts/1/activity", { kind: "sleep", action: "stop" }], ["/astronauts/1/memory", { text: "Knee hurts", follow_up_hours: 6 }],
    ]);
    expect(del).toHaveBeenCalledWith("/astronauts/1/memory/4");
    expect(r.at(-1).data).toEqual({ activity: { type: "breathing" } });
  });
  it("says what happened, including the comms delay", () => {
    expect(doneSentence([{ action: { type: "message_surgeon", text: "x" }, ok: true, data: { delay_s: 20 } }]))
      .toBe("Sent your message to the flight surgeon. It reaches Earth in about 20 seconds.");
    expect(doneSentence([{ action: { type: "stop_sleep" }, ok: true, data: { hours: 7.5, level: "GREEN" } }]))
      .toBe("Good morning. I logged 7.5 hours of sleep.");
    expect(doneSentence([{ action: { type: "log_vitals", simulated: true, temperature: 38.6 }, ok: true, data: { overall_level: "RED", note: "RED: temperature" } }]))
      .toBe("Saved your new reading: out of range. Flagged: temperature. I'll have it analyzed right away.");
    expect(doneSentence([{ action: { type: "breathing" }, ok: true, data: { activity: { type: "breathing" } } }])).toBe("");
  });
  it("hears a real call for help, not a question about emergencies", () => {
    for (const t of ["I need help now", "mayday mayday", "I can't breathe", "this is an emergency"]) expect(isEmergencyPhrase(t)).toBe(true);
    for (const t of ["what do I do in an emergency?", "can you help me log my mood", "help"]) expect(isEmergencyPhrase(t)).toBe(false);
    for (const t of ["cancel", "no I'm okay", "false alarm", "stop"]) expect(isCancelPhrase(t)).toBe(true);
  });
});
