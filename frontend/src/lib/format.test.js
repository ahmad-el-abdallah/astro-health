import { describe, expect, it } from "vitest";
import { formatIndicatorValue, moodScore, numericValue, sleepHours } from "./format.js";
import { bandFromIntensity, bandsFor, blendedLevel, worse, worstOf } from "./levels.js";

describe("sleep/mood readings come in two shapes", () => {
  it("reads hours from a bare number or an object", () => {
    expect(sleepHours(7.5)).toBe(7.5);
    expect(sleepHours({ hours: 6, bedtime: "23:00", wake_time: "05:00" })).toBe(6);
  });
  it("reads a mood score from a bare number or an object", () => {
    expect(moodScore(4)).toBe(4);
    expect(moodScore({ mood: "low", score: 2, note: "" })).toBe(2);
  });
  it("never shows raw JSON for sleep or mood", () => {
    expect(formatIndicatorValue("sleep", { hours: 8, bedtime: "23:00", wake_time: "07:00" })).toBe("8h 0m");
    expect(formatIndicatorValue("sleep", 6.5)).toBe("6h 30m");
    expect(formatIndicatorValue("mood", { mood: "great", score: 5 })).toBe("Great");
    expect(formatIndicatorValue("mood", 3)).toBe("Okay");
  });
  it("charts get one number per reading", () => {
    expect(numericValue("blood_pressure", { systolic: 120, diastolic: 80 })).toBe(120);
    expect(numericValue("sleep", { hours: 7 })).toBe(7);
    expect(numericValue("heart_rate", 72)).toBe(72);
  });
});

describe("levels", () => {
  it("picks the worse level", () => {
    expect(worse("GREEN", "RED")).toBe("RED");
    expect(worstOf(["GREEN", "YELLOW", "GREEN"])).toBe("YELLOW");
    expect(worstOf([])).toBe("GRAY");
  });
  it("bands discomfort like the backend does", () => {
    expect(bandFromIntensity(0)).toBe("GREEN");
    expect(bandFromIntensity(4)).toBe("YELLOW");
    expect(bandFromIntensity(7)).toBe("RED");
  });
  it("blends vitals with discomfort, treating no-data as green", () => {
    expect(blendedLevel("heart", { heart: "GRAY" }, { heart: 8 })).toBe("RED");
    expect(blendedLevel("heart", { heart: "YELLOW" }, {})).toBe("YELLOW");
    expect(blendedLevel("heart", {}, {})).toBe("GREEN");
  });
  it("builds chart bands from health rules", () => {
    const rules = { indicators: { heart_rate: { green: [60, 100], yellow: [[50, 59], [101, 120]] } } };
    expect(bandsFor(rules, "heart_rate")).toEqual([
      { lo: 60, hi: 100, kind: "normal" },
      { lo: 50, hi: 59, kind: "caution" },
      { lo: 101, hi: 120, kind: "caution" },
    ]);
    expect(bandsFor(rules, "mood")).toEqual([]);
  });
  it("handles blood pressure (systolic) and higher-is-better indicators", () => {
    const rules = { indicators: {
      blood_pressure: { systolic_green: [90, 129], systolic_yellow: [[130, 139], [85, 89]] },
      sleep: { green_min: 7, yellow_min: 6 },
    } };
    expect(bandsFor(rules, "blood_pressure")[0]).toEqual({ lo: 90, hi: 129, kind: "normal" });
    expect(bandsFor(rules, "sleep")).toEqual([
      { lo: 7, hi: Infinity, kind: "normal" },
      { lo: 6, hi: 7, kind: "caution" },
    ]);
  });
});
