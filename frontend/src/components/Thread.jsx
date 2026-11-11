// One crew member's conversation with the Flight Surgeon, on the mission's comms delay
// (backend/jobs/comms.py). The server decides what each side may see yet
// (GET /astronauts/<id>/messages); here every message still in transit shows a live
// countdown, so the delay to Earth is something you watch happen:
// - doctor view: crew reports arriving ("Incoming report · arrives in 0:42"), and their
//   own replies on the way ("On its way to Ahmad · 0:18"), plus the reply box;
// - crew view: their reports heading to Earth, and replies once they've arrived.
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { post } from "../lib/api.js";
import { fmtTime, formatCountdown } from "../lib/format.js";
import { useThread } from "../lib/queries.js";
import { reportText } from "../lib/reportText.js";
import { Button, cx } from "./ui/index.jsx";
import { Icon } from "./ui/Icon.jsx";
import { useToast } from "./overlays/Toasts.jsx";

function useTick(active) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function Bubble({ m, mine, name, now }) {
  const transit = !m.delivered && new Date(m.deliver_at).getTime() > now;
  const left = new Date(m.deliver_at).getTime() - now;
  const who = m.from_role === "surgeon" ? "Flight Surgeon" : name;
  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 320, damping: 30 }}
      className={cx("flex max-w-[85%] flex-col gap-1", mine ? "items-end self-end" : "items-start self-start")}
    >
      <span className="px-1 text-[11px] font-semibold tracking-[0.06em] text-subtle uppercase">{who}</span>
      <div
        className={cx(
          "rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed",
          mine ? "rounded-br-md bg-accent text-accent-on" : "rounded-bl-md bg-raised text-ink",
          transit && "border border-dashed border-accent-text/50 bg-transparent text-ink-2",
        )}
      >
        {m.body != null ? (m.from_role === "crew" ? reportText(m.body) : m.body) : <span className="italic text-muted">Report on its way from {name}. Contents arrive with it.</span>}
      </div>
      <span className="flex items-center gap-1.5 px-1 text-[11px] text-muted">
        {transit ? (
          <>
            <span className="h-1.5 w-1.5 animate-[ah-pulse-dot_1.2s_ease-in-out_infinite] rounded-full bg-accent-text" />
            {m.body == null ? "Arrives" : mine ? (m.from_role === "surgeon" ? `Reaches ${name}` : "Reaches Earth") : "Arrives"} in {formatCountdown(left)}
          </>
        ) : (
          <>
            <Icon name="tick" size={12} />
            {m.from_role === "surgeon" ? "Delivered" : "Received on Earth"} {fmtTime(m.deliver_at)}
          </>
        )}
      </span>
    </motion.li>
  );
}

export function Thread({ astroId, name, viewer = "crew", canReply = false, compact = false }) {
  const q = useThread(astroId);
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const list = useMemo(() => q.data || [], [q.data]);
  const inTransit = list.some((m) => !m.delivered);
  const now = useTick(inTransit);
  const listRef = useRef(null);
  const shown = compact ? list.slice(-4) : list;

  // A countdown hitting zero means "arrived": refetch so the server confirms it.
  useEffect(() => {
    const next = list.filter((m) => !m.delivered).map((m) => new Date(m.deliver_at).getTime()).sort()[0];
    if (!next) return undefined;
    const t = setTimeout(() => qc.invalidateQueries({ queryKey: ["thread", astroId] }), Math.max(500, next - Date.now() + 600));
    return () => clearTimeout(t);
  }, [list, qc, astroId]);

  // Keep the newest message in view -- scrolling only the list, never the page.
  useEffect(() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; }, [list.length]);

  async function send(e) {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    setSending(true);
    try {
      const r = await post("/messages", { astronaut_id: astroId, body });
      setText("");
      const secs = Math.max(0, Math.round((new Date(r.deliver_at) - Date.now()) / 1000));
      toast(secs ? `Sent. Reaches ${name} in ${formatCountdown(secs * 1000)} (comms delay).` : "Sent.", "success");
      qc.invalidateQueries({ queryKey: ["thread", astroId] });
    } catch {
      toast("Couldn't send the reply.", "error");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {list.length === 0 ? (
        <p className="m-0 rounded-xl bg-raised p-4 text-sm text-muted">
          {viewer === "surgeon" ? `No reports from ${name} yet. Red results and symptom reports arrive here automatically.` : "No messages with your Flight Surgeon yet."}
        </p>
      ) : (
        <ul ref={listRef} className={cx("m-0 flex list-none flex-col gap-3 overflow-y-auto p-0 pr-1", compact ? "max-h-72" : "max-h-[460px]")}>
          <AnimatePresence initial={false}>
            {shown.map((m) => (
              <Bubble key={m.id} m={m} name={name} now={now} mine={(m.from_role === "surgeon") === (viewer === "surgeon")} />
            ))}
          </AnimatePresence>
        </ul>
      )}
      {canReply && (
        <form onSubmit={send} className="flex items-end gap-2 border-t border-line pt-3">
          <textarea
            className="ah-input min-h-[48px] flex-1 resize-none py-3"
            rows={1}
            placeholder={`Reply to ${name}…`}
            value={text}
            maxLength={2000}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) send(e); }}
            aria-label={`Reply to ${name}`}
          />
          <Button variant="primary" type="submit" disabled={sending || !text.trim()} className="min-h-12">
            <Icon name="send" size={16} /> Send
          </Button>
        </form>
      )}
    </div>
  );
}
