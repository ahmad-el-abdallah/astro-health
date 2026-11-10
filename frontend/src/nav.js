// Sidebar structure (AstroHealth-Redesign DESIGN-SPEC §2): crew = Overview + HEALTH +
// MISSION groups; doctor = MONITOR + the crew list + CREW DATA (the same crew pages, for
// whichever crew member the Flight Surgeon picks -- every old feature stays reachable).
// `legacy` = the old vanilla app's tab name, used by not-yet-ported pages to link to
// /legacy#<tab> during the migration.
export const CREW_NAV = [
  {
    group: null,
    items: [{ to: "/", label: "Overview", title: "Mission overview", eyebrow: "Crew health · Live", icon: "overview", legacy: "live", end: true }],
  },
  {
    group: "Health",
    items: [
      { to: "/body", label: "Doctor AI & body", eyebrow: "Digital twin", icon: "doctor-ai", legacy: "body" },
      { to: "/trends", label: "Trends", eyebrow: "Health analytics", icon: "trends", legacy: "trends" },
      { to: "/mind", label: "Mind & mood", eyebrow: "Crew wellness", icon: "mind", legacy: "mental" },
      { to: "/sleep", label: "Sleep lab", eyebrow: "Sleep lab", icon: "sleep", legacy: "sleep" },
    ],
  },
  {
    group: "Mission",
    items: [
      { to: "/mission", label: "Mission health", eyebrow: "Mission environment", icon: "mission", legacy: "mission" },
      { to: "/schedule", label: "Schedule", eyebrow: "Daily routine", icon: "schedule", legacy: "schedule" },
      { to: "/learn", label: "Learn", eyebrow: "Crew handbook", icon: "learn", legacy: "learn" },
    ],
  },
];

export const DOCTOR_NAV = [
  {
    group: "Monitor",
    items: [
      { to: "/doctor", label: "Crew overview", icon: "crew", legacy: "crew", end: true },
      { to: "/doctor/alerts", label: "Alerts", icon: "alert", legacy: "surgeon", showsAlerts: true },
    ],
  },
  {
    group: "Crew data",
    items: [
      { to: "/", label: "Live overview", title: "Mission overview", eyebrow: "Crew health · Live", icon: "overview", legacy: "live", end: true },
      { to: "/body", label: "Body & Doctor AI", icon: "doctor-ai", legacy: "body" },
      { to: "/trends", label: "Trends", icon: "trends", legacy: "trends" },
      { to: "/mind", label: "Mind & mood", icon: "mind", legacy: "mental" },
      { to: "/sleep", label: "Sleep lab", icon: "sleep", legacy: "sleep" },
      { to: "/mission", label: "Mission health", icon: "mission", legacy: "mission" },
      { to: "/schedule", label: "Schedule", icon: "schedule", legacy: "schedule" },
      { to: "/learn", label: "Learn", icon: "learn", legacy: "learn" },
    ],
  },
];

export function navItemFor(pathname, isSurgeon = false) {
  if (pathname.startsWith("/doctor/crew/")) {
    return { label: "Crew member profile", legacy: "surgeon", eyebrow: "Medical console" };
  }
  return (isSurgeon ? [...DOCTOR_NAV, ...CREW_NAV] : [...CREW_NAV, ...DOCTOR_NAV]).flatMap((g) => g.items).find((i) => i.to === pathname) || null;
}
