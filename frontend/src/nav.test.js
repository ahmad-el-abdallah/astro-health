import { describe, expect, it } from "vitest";
import { CREW_NAV, DOCTOR_NAV, navItemFor } from "./nav.js";
import { PAGES } from "./lib/astraActions.js";
import { dueCount, todaySummary } from "./lib/schedule.js";

const paths = (nav) => nav.flatMap((g) => g.items.map((i) => i.to));

describe("the app's sections", () => {
  it("crew: Overview, then Daily check-ins, Health, Mission", () => {
    expect(CREW_NAV.map((g) => g.group)).toEqual([null, "Daily check-ins", "Health", "Mission"]);
    expect(CREW_NAV[1].items.map((i) => i.to)).toEqual(["/today", "/mind", "/sleep", "/exercise"]);
  });
  it("every crew page appears exactly once, and the doctor sees the same pages", () => {
    const crew = paths(CREW_NAV);
    expect(new Set(crew).size).toBe(crew.length);
    expect(crew).not.toContain("/schedule");
    const doctorCrewData = DOCTOR_NAV.find((g) => g.group === "Crew data").items.map((i) => i.to);
    expect([...doctorCrewData].sort()).toEqual([...crew].sort());
  });
  it("titles resolve for the new page, and Astra's “schedule” opens Today", () => {
    expect(navItemFor("/today").label).toBe("Today");
    expect(PAGES.schedule).toEqual({ path: "/today", label: "Today" });
  });
});

describe("today's progress", () => {
  const e = (status, time = "07:00") => ({ status, time, kind: "vitals", text: "Vitals" });
  it("counts what needs doing now", () => {
    expect(dueCount([e("done"), e("due"), e("missed"), e("upcoming")])).toBe(2);
  });
  it("summary: done of total, and the next task (due before upcoming)", () => {
    const s = todaySummary([e("done", "07:00"), e("upcoming", "13:00"), e("missed", "08:00")]);
    expect(s).toMatchObject({ done: 1, total: 3, due: 1 });
    expect(s.next.time).toBe("08:00");
    expect(todaySummary([]).next).toBeNull();
  });
});

describe("a running workout shows on one row only", async () => {
  const { trackingRows } = await import("./pages/crew/daily/Today.jsx");
  it("the due one, else the next one coming", () => {
    const rows = trackingRows([
      { kind: "exercise", time: "08:00", status: "due" }, { kind: "exercise", time: "13:00", status: "upcoming" },
      { kind: "sleep", time: "22:30", status: "upcoming" },
    ]);
    expect(rows).toEqual({ exercise: "08:00", sleep: "22:30" });
    expect(trackingRows([{ kind: "exercise", time: "08:00", status: "done" }, { kind: "exercise", time: "13:00", status: "upcoming" }]).exercise).toBe("13:00");
  });
});
