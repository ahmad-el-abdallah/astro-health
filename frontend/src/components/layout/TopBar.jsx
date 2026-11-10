// Top bar: eyebrow + page title on the left; mission chip, astronaut picker (Flight
// Surgeon only), alerts bell (doctor), Account and Log out on the right. On phones a ☰
// button opens the sidebar drawer, and Account / Log out live in that drawer instead.
import { Link } from "react-router";
import { motion, AnimatePresence } from "motion/react";
import { useAstronautPicker, useAuth } from "../../auth/AuthProvider.jsx";
import { useAlerts, useMission } from "../../lib/queries.js";
import { Icon } from "../ui/Icon.jsx";

export function TopBar({ eyebrow, title, onAccount, showPicker = true, onMenu = null }) {
  const { isSurgeon, signOut } = useAuth();
  const mission = useMission();
  const alerts = useAlerts(isSurgeon);
  const picker = useAstronautPicker();
  const openAlerts = (alerts.data || []).filter((a) => !a.acknowledged).length;

  return (
    <header className="flex flex-wrap items-center gap-3 px-1 pt-1.5">
      {onMenu && (
        <button
          onClick={onMenu}
          aria-label="Open menu"
          className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center ah-glass rounded-2xl text-ink"
        >
          <Icon name="menu" size={20} />
        </button>
      )}
      <div className="mr-auto min-w-0">
        <div className="ah-eyebrow">{eyebrow}</div>
        <AnimatePresence mode="wait" initial={false}>
          <motion.h1
            key={title}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.22 }}
            className="m-0 font-display text-[28px] font-bold tracking-[-0.02em]"
          >
            {title}
          </motion.h1>
        </AnimatePresence>
      </div>

      <Link
        to="/mission"
        className="flex min-h-11 items-center gap-2 ah-glass rounded-full px-3.5 text-[13px] text-ink hover:border-accent-text/50"
      >
        <span className="h-2.5 w-2.5 rounded-full bg-mars" />
        Mission: <strong className="font-semibold">{mission.data?.profile?.label || "–"}</strong>
      </Link>

      {showPicker && (
        <label className="flex min-h-11 items-center gap-2 ah-glass rounded-full py-0 pr-1.5 pl-3.5 text-[13px] text-muted">
          Astronaut
          {/* Crew members are locked to themselves (the backend enforces it too). */}
          <select
            value={picker.id ?? ""}
            onChange={(e) => picker.setId(Number(e.target.value))}
            disabled={picker.locked}
            className="min-h-[34px] cursor-pointer rounded-2xl border-0 bg-control px-2.5 text-[13px] font-semibold text-ink disabled:cursor-default"
          >
            {picker.options.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </label>
      )}

      {isSurgeon && (
        <Link
          to="/doctor/alerts"
          aria-label={openAlerts ? `Alerts (${openAlerts} open)` : "Alerts"}
          className="relative inline-flex h-11 w-11 items-center justify-center ah-glass rounded-full text-ink-2 hover:text-ink"
        >
          <Icon name="bell" size={18} />
          {openAlerts > 0 && (
            <motion.span
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              className="absolute top-2 right-2.5 h-2.5 w-2.5 rounded-full border-2 border-raised bg-alert-action"
            />
          )}
        </Link>
      )}

      <button
        onClick={onAccount}
        className="min-h-11 cursor-pointer max-md:hidden ah-glass rounded-full px-4 text-[13px] font-semibold text-ink hover:border-accent-text/50"
      >
        Account
      </button>
      <button
        onClick={signOut}
        aria-label="Log out"
        title="Log out"
        className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center gap-2 rounded-full px-3 text-[13px] font-medium text-ink-2 hover:bg-raised hover:text-ink max-md:hidden xl:px-4"
      >
        <Icon name="logout" size={17} />
        <span className="max-xl:hidden">Log out</span>
      </button>
    </header>
  );
}
