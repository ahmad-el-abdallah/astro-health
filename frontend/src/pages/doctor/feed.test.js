import { describe, expect, it } from "vitest";
import { buildFeed, cardFlag, sortCrew } from "./feed.js";

const crew = [
  { id: 1, name: "Ahmad", status: "RED", today: { heart_rate: { value: 110, level: "YELLOW", ts: "2026-11-11T08:00:00+00:00" }, sleep: { value: 8, level: "GREEN", ts: "2026-11-11T07:00:00+00:00" } },
    symptoms_today: { items: ["short_of_breath"], level: "RED", ts: "2026-11-11T09:00:00+00:00" }, open_alert: null },
  { id: 2, name: "Sameer", status: "GREEN", today: { heart_rate: { value: 72, level: "GREEN", ts: "x" } } },
  { id: 3, name: "Aziz", status: "GRAY", today: {}, last_reading: "2026-11-09T19:45:00+00:00" },
];
const alerts = [
  { id: 9, astronaut_id: 1, level: "RED", text: "RED: heart rate, temperature", ts: "2026-11-11T09:30:00+00:00", acknowledged: 0 },
  { id: 8, astronaut_id: 2, level: "RED", text: "old", ts: "2026-11-10T09:30:00+00:00", acknowledged: 1 },
];

describe("buildFeed", () => {
  const feed = buildFeed(crew, alerts);
  it("includes open alerts, out-of-range readings, symptoms and no-data, worst first", () => {
    expect(feed.map((i) => i.kind)).toEqual(["alert", "symptom", "reading", "nodata"]);
    expect(feed[0].title).toBe("Flagged: heart rate, temperature");
    expect(feed[1].title).toBe("Symptom: short of breath");
    expect(feed[2].title).toBe("Heart rate 110 bpm");
    expect(feed[3]).toMatchObject({ name: "Aziz", level: "GRAY" });
  });
  it("names a station-wide SOS instead of a crew member", () => {
    const sos = buildFeed([], [{ id: 1, astronaut_id: null, level: "RED", text: "SOS", ts: "t", acknowledged: 0 }]);
    expect(sos[0]).toMatchObject({ name: "Station SOS", astronautId: null });
  });
  it("leaves out acknowledged alerts and normal readings", () => {
    expect(feed.some((i) => i.alertId === 8)).toBe(false);
    expect(feed.some((i) => i.name === "Sameer")).toBe(false);
  });
});

describe("detail lines", () => {
  it("says which side of the normal range a reading is on", () => {
    const rules = { indicators: { heart_rate: { green: [60, 100], yellow: [[50, 59], [101, 120]] } } };
    const feed = buildFeed(crew, [], rules);
    expect(feed.find((i) => i.kind === "reading").detail).toBe("Above the normal range of 60–100 bpm");
  });
});

describe("crew cards", () => {
  it("sorts by who needs attention first", () => {
    expect(sortCrew(crew).map((c) => c.name)).toEqual(["Ahmad", "Aziz", "Sameer"]);
  });
  it("picks the most important flag", () => {
    expect(cardFlag(crew[0])).toEqual({ level: "RED", text: "Symptom reported: short of breath" });
    expect(cardFlag(crew[2]).text).toBe("No reading in the last 24 h");
    expect(cardFlag(crew[1])).toBeNull();
  });
});
