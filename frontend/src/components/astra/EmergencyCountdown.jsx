// "Calling for help in 5…": Astra's voice SOS waits a few seconds so a misheard word can be
// cancelled (say "cancel", or tap it). Used on the voice screen and in the chat.
import { useEffect, useState } from "react";

export function EmergencyCountdown({ emergency, onCancel }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.ceil((emergency.endsAt - now) / 1000));
  return (
    <div role="alert" className="flex w-full max-w-md flex-col gap-3 rounded-2xl border border-alert-fg/60 bg-alert-bg p-4 text-alert-fg">
      <div className="text-base font-bold">{left > 0 ? `Calling for help in ${left}…` : "Calling for help…"}</div>
      <div className="text-sm">“{emergency.text}”. Say “cancel” if you’re okay.</div>
      <button
        onClick={onCancel}
        className="min-h-11 cursor-pointer rounded-xl border border-alert-fg/60 bg-control px-4 text-sm font-bold text-ink hover:bg-raised"
      >
        Cancel, I’m okay
      </button>
    </div>
  );
}
