// The Flight Surgeon's tools menu (top bar): the old Flight Surgeon tab's "Crew names"
// and "Data" cards, now a small glass menu.
// - Manage crew: rename each crew member, and download any one's data as CSV
//   ("Send to Earth" -- also on each crew profile).
// - Reset demo data: wipes and re-seeds the database. Destructive, so it says exactly
//   what is erased and asks you to type RESET first. Superuser accounts are kept.
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { post, put } from "../../lib/api.js";
import { useCrew } from "../../lib/queries.js";
import { Avatar, Button, cx } from "../ui/index.jsx";
import { Icon } from "../ui/Icon.jsx";
import { Modal } from "../overlays/Drawer.jsx";
import { useToast } from "../overlays/Toasts.jsx";

function CrewRow({ person }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState(null); // null = untouched, shows the saved name
  const name = draft ?? person.name;
  const changed = draft != null && draft.trim() && draft.trim() !== person.name;
  async function save(e) {
    e.preventDefault();
    if (!changed) return;
    try {
      await put(`/astronauts/${person.id}`, { name: draft.trim() });
      toast(`Renamed to ${draft.trim()}.`, "success");
      setDraft(null);
      ["crew", "summary", "tags"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    } catch {
      toast("Couldn't rename.", "error");
    }
  }
  return (
    <form onSubmit={save} className="flex flex-wrap items-center gap-2.5 rounded-2xl bg-raised p-2.5">
      <Avatar name={name} color={person.color} size={38} />
      <input className="ah-input min-h-10 min-w-0 flex-1" value={name} onChange={(e) => setDraft(e.target.value)} aria-label={`Name for ${person.name}`} maxLength={60} />
      <Button type="submit" variant={changed ? "primary" : "secondary"} disabled={!changed} className="min-h-10 px-3.5 text-[13px]">Save</Button>
      <a
        href={`/api/export/${person.id}.csv`}
        className="flex min-h-10 items-center gap-1.5 rounded-xl px-3 text-[13px] font-semibold text-accent-text hover:bg-control"
        title={`Download ${person.name}'s readings as CSV`}
      >
        <Icon name="download" size={15} /> CSV
      </a>
    </form>
  );
}

function ResetDialog({ open, onClose }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  async function reset() {
    setBusy(true);
    try {
      await post("/reset-demo");
      qc.invalidateQueries();
      toast("Demo data reset.", "success");
      setTyped("");
      onClose();
    } catch {
      toast("Reset failed.", "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={open} onClose={() => { setTyped(""); onClose(); }} title="Reset demo data?">
      <p className="m-0 text-sm text-ink-2">This wipes the database and starts it fresh with the demo crew. It can't be undone. It erases:</p>
      <ul className="my-3 flex list-none flex-col gap-1.5 p-0 text-sm text-ink-2">
        {[
          "All readings, assessments, symptoms, alerts and messages",
          "Mood journals, sleep logs and discomfort reports",
          "Crew members and cards added in /admin (only the demo crew and Flight Surgeon come back)",
          "Crew usernames, passwords and Face ID",
        ].map((t) => (
          <li key={t} className="flex gap-2"><Icon name="alert" size={15} className="mt-0.5 shrink-0 text-alert-fg" />{t}</li>
        ))}
      </ul>
      <p className="m-0 text-[13px] text-muted">Superuser (/admin) accounts are kept.</p>
      <label className="mt-4 flex flex-col gap-1.5 text-[13px] text-ink-2">
        Type <b className="font-mono text-ink">RESET</b> to confirm
        <input className="ah-input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
      </label>
      <button
        onClick={reset}
        disabled={typed !== "RESET" || busy}
        className="mt-3 flex min-h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-alert-action font-bold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Icon name="reset" size={16} /> {busy ? "Resetting…" : "Reset demo data"}
      </button>
    </Modal>
  );
}

export function DoctorTools() {
  const crew = useCrew(true);
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState(null); // "crew" | "reset"
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const item = (key, icon, label, sub, danger = false) => (
    <button
      role="menuitem"
      onClick={() => { setOpen(false); setDialog(key); }}
      className={cx("flex w-full cursor-pointer items-start gap-3 rounded-xl p-2.5 text-left transition-colors hover:bg-raised", danger && "text-alert-fg")}
    >
      <span className={cx("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", danger ? "bg-alert-bg" : "bg-accent-soft text-accent-text")}>
        <Icon name={icon} size={17} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold">{label}</span>
        <span className="block text-xs text-muted">{sub}</span>
      </span>
    </button>
  );

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Doctor tools"
        title="Doctor tools"
        className="relative inline-flex h-11 w-11 cursor-pointer items-center justify-center ah-glass rounded-full text-ink-2 hover:text-ink"
      >
        <Icon name="wrench" size={18} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 420, damping: 32 }}
            className="absolute top-full right-0 z-[90] mt-2 w-72 origin-top-right ah-glass-strong rounded-2xl p-1.5 shadow-[0_20px_50px_rgba(0,0,0,.5)]"
          >
            {item("crew", "crew", "Manage crew", "Rename crew members, export their data")}
            <div className="my-1 h-px bg-line" />
            {item("reset", "reset", "Reset demo data", "Wipe everything and start fresh", true)}
          </motion.div>
        )}
      </AnimatePresence>

      <Modal open={dialog === "crew"} onClose={() => setDialog(null)} title="Manage crew" size="lg">
        <p className="m-0 mb-3 text-sm text-muted">Rename a crew member, or download their readings as a CSV file to send to Earth. Cards and roles are managed in /admin.</p>
        <div className="flex flex-col gap-2">
          {(crew.data || []).map((p) => <CrewRow key={p.id} person={p} />)}
        </div>
      </Modal>
      <ResetDialog open={dialog === "reset"} onClose={() => setDialog(null)} />
    </div>
  );
}
