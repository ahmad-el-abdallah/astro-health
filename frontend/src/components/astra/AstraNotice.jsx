// Astra speaking first: a small card, bottom right, with what she noticed. "Talk" opens the
// voice screen (she says it there if she hasn't out loud yet, then any yes/no card shows);
// "Dismiss" just closes it.
import { motion } from "motion/react";
import { Icon } from "../ui/Icon.jsx";

const TITLE = {
  health: "Health check", reminder: "Schedule", missed: "Missed task", message: "Flight surgeon",
  ack: "Flight surgeon", followup: "Checking in", briefing: "Daily briefing",
};

export function AstraNotice({ notice, more, onTalk, onDismiss }) {
  return (
    <motion.div
      key={notice.id}
      role="status"
      aria-label="Astra notice"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="fixed bottom-4 right-4 z-[150] flex w-[min(380px,calc(100vw-32px))] flex-col gap-3 ah-glass-strong rounded-2xl p-4 text-ink"
    >
      <div className="flex items-center gap-2">
        <Icon name="waveform" size={16} className="text-accent-text" />
        <span className="text-label font-semibold">Astra · {TITLE[notice.kind] || "Notice"}</span>
        {more > 0 && <span className="ml-auto text-caption text-muted">+{more} more</span>}
      </div>
      <p className="m-0 text-sm leading-relaxed text-ink-2">{notice.text}</p>
      <div className="flex gap-2">
        <button
          onClick={() => onTalk(notice)}
          className="flex min-h-10 cursor-pointer items-center gap-2 rounded-xl bg-accent px-3.5 text-label font-bold text-accent-on hover:bg-accent-hover"
        >
          <Icon name="mic" size={15} /> {notice.question ? "Yes, brief me" : notice.actions?.length ? "Answer" : "Talk"}
        </button>
        <button
          onClick={() => onDismiss(notice)}
          className="min-h-10 cursor-pointer rounded-xl border border-line-strong bg-control px-3.5 text-label font-semibold text-ink-2 hover:text-ink"
        >
          Dismiss
        </button>
      </div>
    </motion.div>
  );
}
