// A small drawn face for the Astra chat: blinking eyes, and a mouth that opens with
// the AI's voice (voiceState.mouth from lib/useVoice.js -- jumps on each spoken word,
// decays between words). The mouth is moved by a requestAnimationFrame loop that sets the
// SVG attribute directly, so speaking never re-renders React 60 times a second.
// A red ring pulses while listening, a blue one while the AI is thinking.
import { useEffect, useRef } from "react";
import { voiceState } from "../lib/useVoice.js";
import { cx } from "./ui/index.jsx";

export function VoiceFace({ mode = "ready", size = 44, className = "" }) {
  const mouthRef = useRef(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const m = Math.min(1, Math.max(0, voiceState.mouth));
      mouthRef.current?.setAttribute("ry", (0.8 + m * 4.2).toFixed(2));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const ring = {
    listening: "ring-2 ring-alert-fg animate-pulse",
    thinking: "ring-2 ring-accent-text animate-pulse",
    ready: "ring-1 ring-line-strong",
  }[mode] || "";

  return (
    <span className={cx("inline-flex shrink-0 items-center justify-center rounded-full transition-shadow", ring, className)} style={{ width: size, height: size }}>
      <svg viewBox="0 0 40 40" width={size - 4} height={size - 4} aria-hidden="true">
        <circle cx="20" cy="20" r="18" className="fill-accent-soft stroke-accent-text" strokeWidth="1.5" />
        <g className="origin-center animate-[ah-blink_4.5s_ease-in-out_infinite]" style={{ transformBox: "fill-box" }}>
          <circle cx="14" cy="17" r="2.2" className="fill-accent-text" />
          <circle cx="26" cy="17" r="2.2" className="fill-accent-text" />
        </g>
        <ellipse ref={mouthRef} cx="20" cy="27" rx="5" ry="0.8" className="fill-accent-text" />
      </svg>
    </span>
  );
}
