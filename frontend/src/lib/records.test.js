import { describe, expect, it } from "vitest";
import { apiQuery, parseQuery, presetRange, toQuery } from "./records.js";

const now = new Date(2026, 10, 14, 12, 0); // 14 Nov 2026, local

describe("records filters", () => {
  it("defaults to all crew, the last 7 days, everything", () => {
    const f = parseQuery(new URLSearchParams(""), now);
    expect(f).toMatchObject({ range: "7", from: "2026-11-08", to: "2026-11-14", astronauts: [], level: "any", q: "" });
    expect(f.categories).toEqual(["vitals", "checkins", "events", "notes"]);
  });
  it("round-trips through the URL", () => {
    const f = { range: "custom", from: "2026-11-01", to: "2026-11-10", astronauts: [1, 3], categories: ["vitals", "events"], level: "RED", q: " headache " };
    const back = parseQuery(toQuery(f), now);
    expect(back).toEqual({ ...f, q: "headache" });
    expect(toQuery(parseQuery(new URLSearchParams(""), now)).toString()).toBe(""); // defaults leave the URL clean
  });
  it("ignores bad values", () => {
    const f = parseQuery(new URLSearchParams("range=99&categories=nope&level=PURPLE&astronauts=a,2"), now);
    expect(f).toMatchObject({ range: "7", level: "any", astronauts: [2] });
    expect(f.categories).toHaveLength(4);
  });
  it("presets count today as day 1", () => {
    expect(presetRange("1", now)).toEqual({ from: "2026-11-14", to: "2026-11-14" });
    expect(presetRange("30", now).from).toBe("2026-10-16");
  });
  it("sends explicit dates and the time zone to the API", () => {
    const q = new URLSearchParams(apiQuery(parseQuery(new URLSearchParams("level=YELLOW"), now), now));
    expect(q.get("from")).toBe("2026-11-08");
    expect(q.get("tz")).toBe(String(-now.getTimezoneOffset()));
    expect(q.get("level")).toBe("YELLOW");
  });
});
