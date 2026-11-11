// Small spring-animated toast stack (top right). Also listens for the broadcasts that
// used to pop up anywhere in the old app: schedule reminders.
import { createContext, useCallback, useContext, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useSocketEvent } from "../../lib/socket.js";
import { Icon } from "../ui/Icon.jsx";
import { cx } from "../ui/index.jsx";

const ToastContext = createContext(() => {});

const KIND = {
  info: { icon: "check", cls: "border-line-strong" },
  success: { icon: "tick", cls: "border-good-edge" },
  warn: { icon: "bell", cls: "border-check-edge" },
  error: { icon: "alert", cls: "border-alert-border" },
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((text, kind = "info") => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t.slice(-3), { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  useSocketEvent("reminder", (d) => push(`Reminder: ${d?.text || ""}`, "warn"));

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed top-5 right-5 z-[200] flex w-[min(360px,calc(100vw-40px))] flex-col gap-2" aria-live="polite">
        <AnimatePresence initial={false}>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, x: 40, scale: 0.96 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 40, transition: { duration: 0.18 } }}
              transition={{ type: "spring", stiffness: 420, damping: 32 }}
              className={cx("pointer-events-auto flex items-center gap-3 ah-glass-strong rounded-2xl border px-4 py-3 text-sm shadow-[0_18px_50px_rgba(0,0,0,.45)]", KIND[t.kind]?.cls)}
            >
              <Icon name={KIND[t.kind]?.icon || "check"} size={16} className="shrink-0 text-accent-text" />
              {t.text}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
