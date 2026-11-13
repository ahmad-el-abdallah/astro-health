// Report a symptom (port of the old Live tab's chip reporter): tapping a chip selects it
// AND immediately shows what to do about it (config/symptoms.json guidance); "Log
// symptoms" records them via the same path the CYD uses, which can alert the surgeon.
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { post } from "../lib/api.js";
import { useSymptomCatalog } from "../lib/queries.js";
import { Button, StatusChip, cx } from "./ui/index.jsx";
import { Modal } from "./overlays/Drawer.jsx";

export function SymptomReporter({ open, onClose, astroId }) {
  const catalog = useSymptomCatalog();
  const qc = useQueryClient();
  const [selected, setSelected] = useState([]);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  async function log() {
    if (!selected.length || !astroId) return;
    setBusy(true);
    try {
      const r = await post(`/astronauts/${astroId}/symptoms`, { items: selected });
      setResult(r.level);
      setSelected([]);
      qc.invalidateQueries({ queryKey: ["summary", astroId] });
    } finally {
      setBusy(false);
    }
  }

  const close = () => { setResult(null); setSelected([]); onClose(); };
  const items = catalog.data || [];

  return (
    <Modal open={open} onClose={close} title="Report a symptom">
      <p className="m-0 mb-4 text-sm text-muted">Tap a symptom to see what to do about it, and to include it in your report.</p>
      <div className="flex flex-wrap gap-2">
        {items.map((s) => {
          const on = selected.includes(s.id);
          return (
            <motion.button
              key={s.id}
              whileTap={{ scale: 0.95 }}
              onClick={() => toggle(s.id)}
              aria-pressed={on}
              className={cx(
                "min-h-9 cursor-pointer rounded-full border px-3.5 text-label transition-colors duration-200",
                on ? "border-accent bg-accent font-semibold text-accent-on" : "border-line-strong bg-raised text-ink hover:border-accent-text/60",
              )}
            >
              {s.label}
            </motion.button>
          );
        })}
      </div>
      <div className="mt-4 flex max-h-56 flex-col gap-2 overflow-y-auto">
        <AnimatePresence initial={false}>
          {selected.map((id) => {
            const s = items.find((x) => x.id === id);
            return s ? (
              <motion.div
                key={id}
                layout
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, height: 0 }}
                className="rounded-xl border border-line bg-raised p-3"
              >
                <strong className="text-sm">{s.label}</strong>
                <p className="m-0 mt-1 text-label text-muted">{s.guidance}</p>
              </motion.div>
            ) : null;
          })}
        </AnimatePresence>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Button variant="primary" onClick={log} disabled={!selected.length || busy}>Log symptoms</Button>
        {result && <StatusChip level={result} label="Logged" />}
      </div>
    </Modal>
  );
}
