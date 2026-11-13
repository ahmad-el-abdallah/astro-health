// Sidebar structure (AstroHealth-Redesign DESIGN-SPEC §2): crew = Overview + HEALTH +
// MISSION groups; doctor = MONITOR + the crew list + CREW DATA (the same crew pages, for
// whichever crew member the Flight Surgeon picks -- every old feature stays reachable).
export const CREW_NAV = [
  {
    group: null,
    items: [{ to: "/", label: "Overview", title: "Mission overview", eyebrow: "Crew health · Live", icon: "overview", end: true }],
  },
  {
    group: "Health",
    items: [
      { to: "/body", label: "Astra & body", eyebrow: "Digital twin", icon: "doctor-ai" },
      { to: "/trends", label: "Trends", eyebrow: "Health analytics", icon: "trends" },
      { to: "/mind", label: "Mind & mood", eyebrow: "Crew wellness", icon: "mind" },
      { to: "/sleep", label: "Sleep lab", eyebrow: "Sleep lab", icon: "sleep" },
    ],
  },
  {
    group: "Mission",
    items: [
      { to: "/mission", label: "Missions", eyebrow: "Mission environment", icon: "mission" },
      { to: "/exercise", label: "Exercises", eyebrow: "Daily movement protocol", icon: "exercise" },
      { to: "/schedule", label: "Schedule", eyebrow: "Daily routine", icon: "schedule" },
      { to: "/learn", label: "Learn", eyebrow: "Crew handbook", icon: "learn" },
    ],
  },
];

export const DOCTOR_NAV = [
  {
    group: "Monitor",
    items: [
      { to: "/doctor", label: "Crew overview", icon: "crew", end: true },
      { to: "/doctor/alerts", label: "Alerts", title: "Alerts & notifications", icon: "alert", showsAlerts: true },
    ],
  },
  {
    group: "Crew data",
    items: [
      { to: "/", label: "Live overview", title: "Mission overview", eyebrow: "Crew health · Live", icon: "overview", end: true },
      { to: "/body", label: "Body & Astra", icon: "doctor-ai" },
      { to: "/trends", label: "Trends", icon: "trends" },
      { to: "/mind", label: "Mind & mood", icon: "mind" },
      { to: "/sleep", label: "Sleep lab", icon: "sleep" },
      { to: "/mission", label: "Missions", icon: "mission" },
      { to: "/exercise", label: "Exercises", icon: "exercise" },
      { to: "/schedule", label: "Schedule", icon: "schedule" },
      { to: "/learn", label: "Learn", icon: "learn" },
    ],
  },
];

export function navItemFor(pathname, isSurgeon = false) {
  if (pathname.startsWith("/doctor/crew/")) {
    return { label: "Crew member profile", eyebrow: "Medical console" };
  }
  return (isSurgeon ? [...DOCTOR_NAV, ...CREW_NAV] : [...CREW_NAV, ...DOCTOR_NAV]).flatMap((g) => g.items).find((i) => i.to === pathname) || null;
}
