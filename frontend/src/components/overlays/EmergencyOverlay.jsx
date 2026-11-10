// Full-screen emergency mode. Driven only by the "emergency" broadcast, so it appears on
// every open browser -- signed in or not (SOS never requires a login).
import { AnimatePresence, motion } from "motion/react";
import { post } from "../../lib/api.js";
import { emergencyStore, useStore } from "../../lib/socket.js";
import { Icon } from "../ui/Icon.jsx";

export function EmergencyOverlay() {
  const { active, text } = useStore(emergencyStore);
  return (
    <AnimatePresence>
      {active && (
        <motion.div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="emergency-title"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[300] flex items-center justify-center bg-[#2a0a10]/95 p-5"
        >
          <motion.div
            aria-hidden="true"
            className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(232,90,106,.35),transparent_65%)]"
            animate={{ opacity: [0.35, 1, 0.35] }}
            transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
          />
          <motion.div
            initial={{ scale: 0.92, y: 20 }}
            animate={{ scale: 1, y: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 22 }}
            className="relative w-full max-w-lg rounded-hero border border-alert-border bg-alert-surface p-8 text-center shadow-[0_30px_80px_rgba(0,0,0,.6)]"
          >
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-alert-action text-[#1a0b10]">
              <Icon name="alert" size={30} />
            </div>
            <h1 id="emergency-title" className="m-0 font-display text-4xl font-bold tracking-tight text-alert-fg">Emergency</h1>
            <p className="mt-2 text-lg text-ink">{text || "Help is on the way."}</p>
            <ul className="mx-auto my-6 max-w-sm list-disc space-y-1.5 pl-5 text-left text-ink-2">
              <li>Stay where you are if possible.</li>
              <li>Follow the crew emergency checklist.</li>
              <li>Wait for instructions from the flight surgeon.</li>
            </ul>
            <button
              onClick={() => post("/emergency", { action: "cancel" })}
              className="min-h-12 cursor-pointer rounded-xl bg-alert-action px-6 font-bold text-[#1a0b10] hover:brightness-110"
            >
              Cancel emergency
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
