// Sidebar structure. Crew = Overview, then three groups by purpose:
//   DAILY CHECK-INS -- what the astronaut must do every day: Today (the routine on the mission
//                      clock, with a badge for tasks due now), Mind & mood, Sleep lab, Exercises.
//                      (The face check, every 2 h, will be a Today task too -- see Today.jsx.)
//   HEALTH          -- looking deeper: the body twin with Astra, and Trends.
//   MISSION         -- the mission environment.
// Doctor = MONITOR + CREW DATA (the same crew pages, same order, for whichever crew member
// the Flight Surgeon picks). The page files follow the same folders: pages/crew/daily,
// pages/crew/health, pages/crew/mission.
export const CREW_NAV = [
  {
    group: null,
    items: [{ to: "/", label: "Overview", title: "Mission overview", icon: "overview", end: true }],
  },
  {
    group: "Daily check-ins",
    items: [
      { to: "/today", label: "Today", title: "Today’s check-ins", eyebrow: "Daily check-ins", icon: "schedule", showsDue: true },
      { to: "/mind", label: "Mind & mood", eyebrow: "Daily check-ins", icon: "mind" },
      { to: "/sleep", label: "Sleep lab", eyebrow: "Daily check-ins", icon: "sleep" },
      { to: "/exercise", label: "Exercises", eyebrow: "Daily check-ins", icon: "exercise" },
    ],
  },
  {
    group: "Health",
    items: [
      { to: "/body", label: "Astra & body", eyebrow: "Health", icon: "doctor-ai" },
      { to: "/trends", label: "Trends", eyebrow: "Health", icon: "trends" },
    ],
  },
  {
    group: "Mission",
    items: [
      { to: "/mission", label: "Missions", eyebrow: "Mission", icon: "mission" },
    ],
  },
];

export const DOCTOR_NAV = [
  {
    group: "Monitor",
    items: [
      { to: "/doctor", label: "Crew overview", icon: "crew", end: true },
      { to: "/doctor/alerts", label: "Alerts", title: "Alerts & notifications", icon: "alert", showsAlerts: true },
      { to: "/doctor/records", label: "Records", title: "Crew records", icon: "download" },
    ],
  },
  {
    group: "Crew data",
    items: [
      { to: "/", label: "Live overview", title: "Mission overview", icon: "overview", end: true },
      { to: "/today", label: "Today", title: "Today’s check-ins", icon: "schedule" },
      { to: "/mind", label: "Mind & mood", icon: "mind" },
      { to: "/sleep", label: "Sleep lab", icon: "sleep" },
      { to: "/exercise", label: "Exercises", icon: "exercise" },
      { to: "/body", label: "Body & Astra", icon: "doctor-ai" },
      { to: "/trends", label: "Trends", icon: "trends" },
      { to: "/mission", label: "Missions", icon: "mission" },
    ],
  },
];

export function navItemFor(pathname, isSurgeon = false) {
  if (pathname.startsWith("/doctor/crew/")) {
    return { label: "Crew member profile", eyebrow: "Medical console" };
  }
  return (isSurgeon ? [...DOCTOR_NAV, ...CREW_NAV] : [...CREW_NAV, ...DOCTOR_NAV]).flatMap((g) => g.items).find((i) => i.to === pathname) || null;
}
