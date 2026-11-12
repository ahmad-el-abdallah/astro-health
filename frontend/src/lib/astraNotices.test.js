import { describe, expect, it } from "vitest";
import {
  ackNotice, briefingNotice, canSpeakNotice, followUpNotice, healthNotice, HEALTH_COOLDOWN_MS,
  messageNotice, missedNotices, reminderNotice,
} from "./astraNotices.js";
import { withLiveStatus } from "./schedule.js";

const evt = (level, extra = {}) => ({ overall_level: level, state_label: "Possibly sick", summary: "Temperature 38.6 °C.", ...extra });

describe("health warnings", () => {
  it("speaks up only when things get worse", () => {
    expect(healthNotice(evt("GREEN"))).toBeNull();
    expect(healthNotice(evt("YELLOW"), { level: "YELLOW" })).toBeNull();
    expect(healthNotice(evt("YELLOW"), { level: "RED" })).toBeNull();
    const n = healthNotice(evt("RED"), { level: "YELLOW" });
    expect(n.text).toMatch(/^Possibly sick\. Temperature 38\.6 °C\. Want me to tell the flight surgeon\?$/);
    expect(n.actions).toEqual([{ type: "alert_surgeon", text: "Possibly sick: Temperature 38.6 °C." }]);
  });
  it("doesn't offer an alert the analysis already sent", () => {
    const n = healthNotice(evt("RED", { alerted: true }));
    expect(n.text).toMatch(/already let the flight surgeon know/);
    expect(n.actions).toBeUndefined();
  });
  it("waits 10 minutes between warnings", () => {
    const now = 1_000_000;
    expect(healthNotice(evt("RED"), { level: "GREEN", noticedAt: now - 1000 }, now)).toBeNull();
    expect(healthNotice(evt("RED"), { level: "GREEN", noticedAt: now - HEALTH_COOLDOWN_MS }, now)).not.toBeNull();
  });
});

describe("schedule", () => {
  it("each reminder comes with the matching offer", () => {
    expect(reminderNotice({ kind: "vitals", time: "07:00", text: "Morning vitals check" }))
      .toMatchObject({ text: "It's 07:00: Morning vitals check. Want me to take a reading now?", actions: [{ type: "take_vitals" }] });
    expect(reminderNotice({ kind: "exercise", text: "Cardio" }).actions).toEqual([{ type: "start_workout" }]);
    expect(reminderNotice({ kind: "sleep", text: "Bedtime" }).actions).toEqual([{ type: "start_sleep" }]);
    expect(reminderNotice({ kind: "mood", text: "Mood check" }).actions).toEqual([]);
  });
  it("only a task that just turned missed is mentioned", () => {
    const entries = [
      { time: "07:00", kind: "vitals", text: "Morning vitals check", seconds: 7 * 3600, status: "upcoming" },
      { time: "08:00", kind: "exercise", text: "Exercise block", seconds: 8 * 3600, status: "upcoming" },
    ];
    const first = missedNotices(null, withLiveStatus(entries, 11 * 3600)); // app just opened
    expect(first.notices).toEqual([]);
    const at9 = missedNotices({ "07:00-vitals": "due", "08:00-exercise": "due" }, withLiveStatus(entries, 10.5 * 3600));
    expect(at9.notices.map((n) => n.text)).toEqual(["You missed morning vitals check. Want me to take a reading now instead?"]);
    expect(missedNotices(at9.statuses, withLiveStatus(entries, 10.6 * 3600)).notices).toEqual([]); // once only
    const mood = [{ time: "19:00", kind: "mood", text: "Evening mood check", seconds: 19 * 3600, status: "due" }];
    expect(missedNotices({ "19:00-mood": "due" }, withLiveStatus(mood, 22.5 * 3600)).notices[0].text)
      .toBe("You missed evening mood check. How are you feeling right now?");
  });
});

describe("messages, follow-ups, briefing", () => {
  it("reads the surgeon's message and confirms an alert was seen", () => {
    expect(messageNotice({ body: "Drink more water today." }).text).toBe("Message from the flight surgeon: Drink more water today. Want to reply? Just tell me what to say.");
    expect(ackNotice({ text: "I feel dizzy" }).text).toBe("The flight surgeon has seen your alert: “I feel dizzy”.");
  });
  it("checks in on what you told her", () => {
    expect(followUpNotice({ id: 3, source: "pain", text: "Back pain 6/10" })).toMatchObject({ text: "Earlier you told me about back pain 6/10. How is it now?", memoryId: 3 });
    expect(followUpNotice({ source: "mood", text: "Felt low (mood check-in)" }).text).toBe("Earlier you felt low. How are you feeling now?");
    expect(followUpNotice({ source: "chat", text: "Left knee hurts" }).text).toBe("Earlier you told me: Left knee hurts. How is that going?");
  });
  it("offers a briefing that asks the AI", () => {
    expect(briefingNotice("Ahmad", 8)).toMatchObject({ text: "Good morning, Ahmad. Want your daily briefing?", question: "Give me my briefing." });
    expect(briefingNotice("Ahmad", 20).text).toMatch(/^Good evening/);
  });
});

describe("when she may say it out loud", () => {
  const ok = { notices: "speak", enabled: true, activated: true, owner: true, inCall: false, hidden: false, lastSpokenAt: 0, now: 100_000 };
  it("all conditions must hold", () => {
    expect(canSpeakNotice(ok)).toBe(true);
    for (const [k, v] of [["notices", "show"], ["enabled", false], ["activated", false], ["owner", false], ["inCall", true], ["hidden", true], ["lastSpokenAt", 90_000]]) {
      expect(canSpeakNotice({ ...ok, [k]: v })).toBe(false);
    }
  });
});
