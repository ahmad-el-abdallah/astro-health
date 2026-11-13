// Generic right-hand slide-in panel (Account, the Body page's Astra chat) and a
// centered Modal. Spring slide, backdrop fade, Esc / backdrop click to close.
import { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cx } from "../ui/index.jsx";

function useEscape(open, onClose) {
  useEffect(() => {
    if (!open) return;
    const fn = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [open, onClose]);
}

export function Drawer({ open, onClose, title, width = 460, children, className = "" }) {
  useEscape(open, onClose);
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[120]">
          <motion.div
            className="absolute inset-0 bg-black/55"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.aside
            role="dialog"
            aria-modal="true"
            aria-label={title}
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 320, damping: 34 }}
            style={{ width: `min(${width}px, 100vw)` }}
            className={cx("absolute top-0 right-0 ah-glass-strong flex h-full flex-col rounded-l-card-l shadow-[-30px_0_80px_rgba(0,0,0,.45)]", className)}
          >
            {children}
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  );
}

export function Modal({ open, onClose, title, children, size = "md" }) {
  useEscape(open, onClose);
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[150] flex items-center justify-center p-5">
          <motion.div className="absolute inset-0 bg-black/70" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={title}
            initial={{ opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 360, damping: 30 }}
            className={`relative max-h-[calc(100vh-40px)] w-full overflow-y-auto ah-glass-strong rounded-card-l p-6 shadow-[0_30px_75px_rgba(0,0,0,.6)] ${size === "lg" ? "max-w-2xl" : "max-w-md"}`}
          >
            <h3 className="m-0 mb-2.5 font-display text-heading font-semibold">{title}</h3>
            {children}
            <button onClick={onClose} className="mt-4 min-h-10 cursor-pointer rounded-xl border border-line-strong bg-control px-4 text-sm font-semibold hover:border-accent-text/60">
              Close
            </button>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
