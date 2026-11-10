// All shared UI copy in one place (ported from static/js/core/strings.js; build-prompt
// section 13 -- "text in one place" so another language can be added later).
export const STRINGS = {
  appName: "Astro Health Station",
  footerDisclaimer: "Demo with placeholder data. Not medical advice.",
  tapYourCard: "Tap your card on the CYD",
  levelWord: { GREEN: "Good", YELLOW: "Check", RED: "Alert", GRAY: "No data" },
  serialStatus: {
    simulation: "Simulation mode",
    connecting: "Looking for the CYD…",
    connected: "CYD connected",
    reconnecting: "CYD disconnected — retrying…",
  },
  assessButton: "Assess",
  howToMeasure: "How do I measure this?",
  resetDemoConfirm: "This replaces all demo data with the fixed seed data again. Continue?",
  bodyPartsAttribution:
    "Anatomy: BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0 International.",
};
