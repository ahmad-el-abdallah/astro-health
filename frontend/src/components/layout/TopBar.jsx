// Top bar: eyebrow + page title on the left; mission chip, astronaut picker (Flight
// Surgeon only), alerts bell (doctor), Account and Log out on the right. On phones a ☰
// button opens the sidebar drawer, and Account / Log out live in that drawer instead.
import { Link } from "react-router";
import { motion, AnimatePresence } from "motion/react";
import { useAstronautPicker, useAuth } from "../../auth/AuthProvider.jsx";
import { useAlerts, useMission } from "../../lib/queries.js";
import { Icon } from "../ui/Icon.jsx";
import { DoctorTools } from "./DoctorTools.jsx";
import { useAstra } from "../AstraProvider.jsx";
import { cx } from "../ui/index.jsx";

// The Astra pill (crew only): is she listening for her name? Click to switch her on/off.
const PILL = {
  listening: { dot: "bg-good-fg animate-[ah-pulse-dot_2s_ease-in-out_infinite]", text: "Say \u201cAstra\u201d", tone: "text-ink" },
  paused: { dot: "bg-accent-text", text: "Astra is talking", tone: "text-ink" },
  starting: { dot: "bg-subtle", text: "Astra starting…", tone: "text-ink-2" },
  off: { dot: "bg-subtle", text: "Astra off", tone: "text-ink-2" },
  elsewhere: { dot: "bg-subtle", text: "Astra in another tab", tone: "text-ink-2", hint: "Astra listens in the tab you used last (two tabs can't share the microphone). Click anywhere in this tab to bring her here." },
  blocked: { dot: "bg-check-fg", text: "Mic blocked", tone: "text-check-fg", hint: "The browser blocked the microphone. Allow it in the site settings (the icon left of the address), then click here twice." },
  insecure: { dot: "bg-check-fg", text: "Astra needs localhost", tone: "text-check-fg", hint: "Browsers only allow the microphone on localhost or https. Open the app as http://localhost:5000 on the computer running it." },
  unsupported: { dot: "bg-check-fg", text: "No voice here", tone: "text-check-fg", hint: "This browser can't recognise speech. Use Chrome or Edge." },
};

function AstraPill() {
  const astra = useAstra();
  if (!astra.available) return null;
  const p = PILL[astra.state] || PILL.off;
  const needsClick = astra.enabled && astra.state === "listening" && !astra.activated;
  const title = p.hint
    || (astra.enabled ? "Astra is listening for her name on every page. Click to switch her off." : "Click to let Astra listen for her name.")
    + (needsClick ? " Click anywhere once so she can talk back." : "");
  return (
    <button
      onClick={() => astra.setEnabled(!astra.enabled)}
      aria-pressed={astra.enabled}
      aria-label={`Astra: ${p.text}. ${title}`}
      title={title}
      className={cx("flex min-h-11 cursor-pointer items-center gap-2 ah-glass rounded-full px-3.5 text-[13px] font-semibold hover:border-accent-text/50", p.tone)}
    >
      <Icon name="waveform" size={15} className="text-accent-text" />
      <span className={cx("h-2 w-2 rounded-full", p.dot)} />
      <span className="max-md:hidden">{p.text}</span>
      {needsClick && <span className="text-[11px] font-medium text-check-fg max-lg:hidden">· click once for voice</span>}
    </button>
  );
}

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

      <AstraPill />

      <Link
        to="/mission"
        className="flex min-h-11 items-center gap-2 ah-glass rounded-full px-3.5 text-[13px] text-ink hover:border-accent-text/50"
      >
        <span className={`h-2.5 w-2.5 rounded-full ${mission.data?.profile_id ? "bg-good-fg shadow-[0_0_8px_currentColor] text-good-fg" : "bg-muted"}`} />
        Mission: <strong className={`font-semibold ${mission.data?.profile_id ? "" : "text-muted"}`}>{mission.data?.profile?.short || mission.data?.profile?.label || "–"}</strong>
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

      {isSurgeon && <DoctorTools />}

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
