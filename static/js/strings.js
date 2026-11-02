// All UI copy in one place (see docs/build-prompt.md section 13 — "Text in
// one place" — so another language can be added later without touching
// the tab scripts).
const STRINGS = {
  appName: "Astro Health Station",
  footerDisclaimer: "Demo with placeholder data. Not medical advice.",
  tapYourCard: "Tap your card on the CYD",
  levelWord: { GREEN: "Good", YELLOW: "Check", RED: "Alert", GRAY: "No data" },
  tabs: {
    live: "Live", body: "Body", trends: "Trends", crew: "Crew",
    surgeon: "Flight Surgeon", mission: "Mission", learn: "Learn",
    rewards: "Rewards", schedule: "Schedule", admin: "Admin",
  },
  serialStatus: {
    simulation: "Simulation mode (no CYD)",
    connecting: "Looking for the CYD…",
    connected: "CYD connected",
    reconnecting: "CYD disconnected — retrying…",
  },
  assessButton: "Assess",
  howToMeasure: "How do I measure this?",
  tapCardFirst: "Tap your card first",
  resetDemoConfirm: "This replaces all demo data with the fixed seed data again. Continue?",
};
