// Top bar: eyebrow + page title on the left; mission chip, astronaut picker (Flight
// Surgeon only), alerts bell (doctor), Account and Log out on the right. On phones a ☰
// button opens the sidebar drawer, and Account / Log out live in that drawer instead.
import { Link } from "react-router";
import { motion, AnimatePresence } from "motion/react";
import { useAstronautPicker, useAuth } from "../../auth/AuthProvider.jsx";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useAlerts, useLocationStatus, useMission } from "../../lib/queries.js";
import { put } from "../../lib/api.js";
import { Icon } from "../ui/Icon.jsx";
import { DoctorTools } from "./DoctorTools.jsx";
import { useAstra } from "../AstraProvider.jsx";
import { Button, cx } from "../ui/index.jsx";

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
      className={cx("flex min-h-11 cursor-pointer items-center gap-2 ah-glass rounded-full px-3.5 text-label font-semibold hover:border-accent-text/50", p.tone)}
    >
      <Icon name="waveform" size={15} className="text-accent-text" />
      <span className={cx("h-2 w-2 rounded-full", p.dot)} />
      <span className="max-md:hidden">{p.text}</span>
      {needsClick && <span className="text-caption font-medium text-check-fg max-2xl:hidden">· click once for voice</span>}{/* below 2xl the tooltip says it, so the top bar stays on one row */}
    </button>
  );
}

// Inside the station, or outside on a spacewalk (EVA). Outside, the suit sensors (CO2, suit
// pressure, oxygen supply) join the readings and the AI watches them (backend/logic/
// location.py). The crew member switches it for themselves; the Flight Surgeon sees the
// picked crew member's, read-only.
// "Are you sure?" before switching between inside and outside (same look as the Mission
// page's confirm). Portalled to <body> so the glass top bar can't clip it.
function ConfirmLocation({ goingOut, onCancel, onConfirm, busy }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  const copy = goingOut
    ? {
        title: "Going outside on a spacewalk?",
        body: "Are you sure you're starting an EVA? Your suit’s CO2, pressure and oxygen supply will join your readings, and the AI will watch them and alert the flight surgeon if something is wrong.",
        ok: "Yes, start EVA",
      }
    : {
        title: "Back inside the station?",
        body: "Are you sure the spacewalk is over? Your suit readings will stop counting once you’re inside.",
        ok: "Yes, I’m inside",
      };
  return createPortal(
    <div className="fixed inset-0 z-[160] flex items-center justify-center p-5">
      <motion.div className="absolute inset-0 bg-black/70" initial={{ opacity: 0 }} animate={{ opacity: 1 }} onClick={onCancel} />
      <motion.div
        role="alertdialog" aria-modal="true" aria-label={copy.title}
        initial={{ opacity: 0, y: 16, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 360, damping: 30 }}
        className="relative w-full max-w-md ah-glass-strong rounded-card-l p-6 shadow-[0_30px_75px_rgba(0,0,0,.6)]"
      >
        <span className={cx("mb-3 flex h-11 w-11 items-center justify-center rounded-2xl", goingOut ? "bg-check-bg text-check-fg" : "bg-good-bg text-good-fg")}>
          <Icon name={goingOut ? "env-station" : "overview"} size={22} />
        </span>
        <h3 className="m-0 mb-2 font-display text-heading font-semibold">{copy.title}</h3>
        <p className="m-0 text-sm leading-relaxed text-ink-2">{copy.body}</p>
        <div className="mt-5 flex justify-end gap-2.5">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={onConfirm} busy={busy} autoFocus>{copy.ok}</Button>
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}

function LocationPill({ astroId, canSwitch }) {
  const q = useLocationStatus(astroId);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false); // the "Are you sure?" pop-up is open
  const [now, setNow] = useState(() => Date.now());
  const eva = q.data?.location === "eva";
  useEffect(() => {
    if (!eva) return undefined;
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, [eva]);
  if (!astroId) return null;
  if (!q.data) return <span aria-hidden="true" className="h-11 w-14 animate-pulse rounded-full bg-raised" />; // loading
  const minutes = eva ? Math.round((q.data.mission_min || 0) + ((now - q.dataUpdatedAt) / 60000) * (q.data.time_scale || 1)) : 0;
  const span = minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${Math.max(0, minutes)} min`;
  async function toggle() {
    if (!canSwitch || busy) return;
    setBusy(true);
    try {
      await put(`/astronauts/${astroId}/location`, { location: eva ? "inside" : "eva" });
      ["location", "summary", "crew"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    } finally {
      setBusy(false);
      setAsking(false);
    }
  }
  const title = eva
    ? `Outside on a spacewalk. Suit CO2, pressure and oxygen are being watched.${canSwitch ? " Click when you're back inside." : ""}`
    : `Inside the station.${canSwitch ? " Click when you go outside on a spacewalk (EVA): suit readings are added and the AI watches them." : ""}`;
  return (
    <>
    {asking && <ConfirmLocation goingOut={!eva} busy={busy} onCancel={() => setAsking(false)} onConfirm={toggle} />}
    <button
      onClick={() => canSwitch && setAsking(true)}
      disabled={!canSwitch || busy}
      aria-pressed={eva}
      aria-label={`Location: ${eva ? `outside, EVA ${span}` : "inside"}. ${title}`}
      title={title}
      className={cx(
        "flex min-h-11 items-center gap-2 rounded-full px-3.5 text-label font-semibold disabled:cursor-default",
        canSwitch && "cursor-pointer",
        eva ? "border border-check-fg/60 bg-check-bg text-check-fg" : "ah-glass text-ink hover:border-accent-text/50",
      )}
    >
      <Icon name={eva ? "env-station" : "overview"} size={15} />
      <span className={cx("h-2 w-2 rounded-full", eva ? "bg-check-fg animate-[ah-pulse-dot_2s_ease-in-out_infinite]" : "bg-good-fg")} />
      {eva
        ? <span className="max-md:hidden">EVA · {span}</span>
        : <span className="hidden 2xl:inline">Inside</span>}
    </button>
    </>
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
            className="m-0 font-display text-display font-bold tracking-[-0.02em]"
          >
            {title}
          </motion.h1>
        </AnimatePresence>
      </div>

      <AstraPill />
      <LocationPill astroId={picker.id} canSwitch={!isSurgeon} />

      <Link
        to="/mission"
        className="flex min-h-11 items-center gap-2 ah-glass rounded-full px-3.5 text-label text-ink hover:border-accent-text/50"
      >
        <span className={`h-2.5 w-2.5 rounded-full ${mission.data?.profile_id ? "bg-good-fg shadow-[0_0_8px_currentColor] text-good-fg" : "bg-muted"}`} />
        Mission: <strong className={`font-semibold ${mission.data?.profile_id ? "" : "text-muted"}`}>{mission.data?.profile?.short || mission.data?.profile?.label || "–"}</strong>
      </Link>

      {showPicker && (
        <label className="flex min-h-11 items-center gap-2 ah-glass rounded-full py-0 pr-1.5 pl-3.5 text-label text-muted">
          Astronaut
          {/* Crew members are locked to themselves (the backend enforces it too). */}
          <select
            value={picker.id ?? ""}
            onChange={(e) => picker.setId(Number(e.target.value))}
            disabled={picker.locked}
            className="min-h-[34px] cursor-pointer rounded-2xl border-0 bg-control px-2.5 text-label font-semibold text-ink disabled:cursor-default"
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
        className="min-h-11 cursor-pointer max-md:hidden ah-glass rounded-full px-4 text-label font-semibold text-ink hover:border-accent-text/50"
      >
        Account
      </button>
      <button
        onClick={signOut}
        aria-label="Log out"
        title="Log out"
        className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center gap-2 rounded-full px-3 text-label font-medium text-ink-2 hover:bg-raised hover:text-ink max-md:hidden xl:px-4"
      >
        <Icon name="logout" size={17} />
        <span className="max-xl:hidden">Log out</span>
      </button>
    </header>
  );
}
