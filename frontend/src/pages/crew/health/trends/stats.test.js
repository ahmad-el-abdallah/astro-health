import { describe, expect, it } from "vitest";
import { compare, fmtValue, insights, levelFor, recentOutOfRange, slopePerWeek, splitPeriods, summarize, trendWord, weekdayAverages } from "./stats.js";

const NOW = new Date(2026, 10, 11, 12).getTime();
const day = (n, y, level = "GREEN", y2) => ({ t: new Date(NOW - n * 864e5), y, level, y2 });

describe("summarize", () => {
  const pts = [day(4, 70), day(3, 80, "YELLOW"), day(2, 90, "RED"), day(1, 60)];
  const s = summarize(pts, 7);
  it("computes average, extremes and level counts", () => {
    expect(s.avg).toBe(75);
    expect(s.min.y).toBe(60);
    expect(s.max.y).toBe(90);
    expect(s.levels).toEqual({ GREEN: 2, YELLOW: 1, RED: 1 });
    expect(s.normalShare).toBe(0.5);
    expect(s.daysLogged).toBe(4);
  });
  it("returns null with no data", () => expect(summarize([], 7)).toBeNull());
  it("averages the diastolic too", () => {
    expect(summarize([day(1, 120, "GREEN", 80), day(0, 110, "GREEN", 70)], 7).avg2).toBe(75);
  });
});

describe("trend", () => {
  it("finds a rising slope per week", () => {
    const pts = [0, 1, 2, 3, 4, 5, 6].map((i) => day(6 - i, 70 + i));
    expect(slopePerWeek(pts)).toBeCloseTo(7, 5);
    expect(trendWord(7, 73)).toBe("Rising");
  });
  it("calls tiny moves steady", () => expect(trendWord(0.5, 75)).toBe("Steady"));
  it("needs enough data", () => expect(slopePerWeek([day(1, 70), day(0, 71)])).toBeNull());
});

describe("streak", () => {
  it("counts consecutive all-normal days", () => {
    const pts = [day(6, 70), day(5, 70), day(4, 70), day(3, 99, "RED"), day(2, 70), day(1, 70)];
    expect(summarize(pts, 7).streak).toBe(3);
  });
});

describe("periods and comparison", () => {
  it("splits a double-length series", () => {
    const pts = [day(12, 60), day(9, 62), day(5, 70), day(1, 72)];
    const { current, previous } = splitPeriods(pts, 7, NOW);
    expect(current.map((p) => p.y)).toEqual([70, 72]);
    expect(previous.map((p) => p.y)).toEqual([60, 62]);
    const c = compare(summarize(current, 7), summarize(previous, 7));
    expect(c.delta).toBe(10);
    expect(c.pct).toBeCloseTo(16.39, 1);
  });
});

describe("weekday + bands", () => {
  it("averages by weekday, Monday first", () => {
    const mon = new Date(2026, 10, 9); // a Monday
    const w = weekdayAverages([{ t: mon, y: 10 }, { t: new Date(2026, 10, 16), y: 20 }]);
    expect(w[0]).toEqual({ day: "Mon", avg: 15, n: 2 });
    expect(w[1].avg).toBeNull();
  });
  it("rates values against the bands", () => {
    const bands = [{ lo: 60, hi: 100, kind: "normal" }, { lo: 101, hi: 120, kind: "caution" }];
    expect(levelFor(80, bands)).toBe("GREEN");
    expect(levelFor(110, bands)).toBe("YELLOW");
    expect(levelFor(140, bands)).toBe("RED");
    expect(levelFor(80, [])).toBe("GRAY");
  });
});

describe("formatting + insights", () => {
  it("formats per indicator", () => {
    expect(fmtValue("blood_pressure", 120.4, 79.6)).toBe("120/80 mmHg");
    expect(fmtValue("temperature", 36.84)).toBe("36.8 °C");
    expect(fmtValue("sleep", 7.5)).toBe("7h 30m");
    expect(fmtValue("mood", 3.62, null, { avg: true })).toBe("3.6 / 5");
  });
  it("writes descriptive observations", () => {
    const pts = [day(20, 70), day(15, 72), day(6, 110, "YELLOW"), day(3, 115, "RED"), day(1, 75)];
    const stats = summarize(pts, 30);
    const list = insights({ indicator: "heart_rate", label: "Heart rate", stats, change: null, recentOut: recentOutOfRange(pts, NOW) });
    const text = list.map((i) => i.text).join(" | ");
    expect(text).toContain("3 of 5 readings (60%) were in the normal range");
    expect(text).toContain("Most out-of-range readings (2 of 2) happened in the last 7 days");
    expect(text).toContain("Logged on 5 of the last 30 days");
    expect(list.length).toBeLessThanOrEqual(5);
  });
});
