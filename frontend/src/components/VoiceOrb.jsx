// The voice-mode orb: a glowing sphere whose edge breathes and ripples.
//   listening -> teal/cyan, swells with YOUR voice (microphone level, stationAudio.input)
//   thinking  -> deep blue/violet, slowly swirling
//   speaking  -> bright cyan/white, pulses with the AI's real voice loudness (neural engine)
//                or the word-boundary "mouth" (browser engine)
//   idle/muted -> dim and calm
// Drawn on a <canvas> every animation frame; reads mutable state, so React never re-renders
// per frame. Gentler when the computer asks for reduced motion.
import { useEffect, useRef } from "react";
import { input, levelOf } from "../lib/stationAudio.js";
import { voiceState } from "../lib/useVoice.js";

const PALETTE = {
  listening: { core: [210, 255, 250], mid: [79, 209, 197], edge: [32, 110, 160], glow: [79, 209, 197] },
  thinking: { core: [214, 222, 255], mid: [122, 140, 245], edge: [70, 50, 160], glow: [122, 140, 245] },
  speaking: { core: [255, 255, 255], mid: [140, 230, 255], edge: [40, 120, 210], glow: [120, 210, 255] },
  idle: { core: [170, 185, 210], mid: [80, 100, 140], edge: [30, 40, 70], glow: [80, 100, 140] },
};

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

export function VoiceOrb({ mode = "idle", size = 340, onClick, label }) {
  const canvasRef = useRef(null);
  const modeRef = useRef(mode);
  useEffect(() => { modeRef.current = mode; }, [mode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const g = canvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    g.scale(dpr, dpr);
    const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let raf = 0, level = 0, rot = 0;
    let colors = PALETTE.idle;

    const draw = (t) => {
      const m = modeRef.current;
      const target = m === "listening" ? levelOf(input.analyser)
        : m === "speaking" ? Math.max(voiceState.mouth * 0.9, 0.12) : 0;
      level += (target - level) * (target > level ? 0.35 : 0.08); // fast attack, slow release
      const pal = PALETTE[m] || PALETTE.idle;
      colors = {
        core: mix(colors.core, pal.core, 0.06), mid: mix(colors.mid, pal.mid, 0.06),
        edge: mix(colors.edge, pal.edge, 0.06), glow: mix(colors.glow, pal.glow, 0.06),
      };
      rot += m === "thinking" ? 0.02 : 0.004;
      const s = t / 1000;
      const cx = size / 2, cy = size / 2;
      const base = size * 0.3 * (1 + (calm ? 0.05 : 0.22) * level) * (1 + 0.02 * Math.sin(s * 1.3));
      const wobble = (calm ? 0.01 : 0.035) + (calm ? 0.02 : 0.09) * level + (m === "thinking" ? 0.03 : 0);

      g.clearRect(0, 0, size, size);
      // outer glow
      const halo = g.createRadialGradient(cx, cy, base * 0.6, cx, cy, size * 0.5);
      halo.addColorStop(0, rgba(colors.glow, 0.28 + 0.25 * level));
      halo.addColorStop(1, rgba(colors.glow, 0));
      g.fillStyle = halo;
      g.fillRect(0, 0, size, size);

      // the blob: a circle whose radius is nudged by a few slow sine waves
      g.beginPath();
      const N = 96;
      for (let i = 0; i <= N; i++) {
        const a = (i / N) * Math.PI * 2;
        const r = base * (1
          + wobble * Math.sin(3 * a + s * 1.7 + rot)
          + wobble * 0.6 * Math.sin(5 * a - s * 2.3)
          + wobble * 0.35 * Math.sin(8 * a + s * 3.1 - rot));
        const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.closePath();
      const fill = g.createRadialGradient(cx - base * 0.35, cy - base * 0.4, base * 0.05, cx, cy, base * 1.15);
      fill.addColorStop(0, rgba(colors.core, 0.98));
      fill.addColorStop(0.45, rgba(colors.mid, 0.92));
      fill.addColorStop(1, rgba(colors.edge, 0.95));
      g.fillStyle = fill;
      g.shadowColor = rgba(colors.glow, 0.8);
      g.shadowBlur = 30 + 50 * level;
      g.fill();
      g.shadowBlur = 0;

      // a slow inner swirl (stronger while thinking)
      g.save();
      g.clip();
      g.globalCompositeOperation = "lighter";
      for (let k = 0; k < 3; k++) {
        const a = rot * (k + 1) * 1.3 + k * 2.1;
        const sx = cx + Math.cos(a) * base * 0.45, sy = cy + Math.sin(a) * base * 0.45;
        const sw = g.createRadialGradient(sx, sy, 0, sx, sy, base * 0.8);
        sw.addColorStop(0, rgba(colors.core, m === "thinking" ? 0.22 : 0.1));
        sw.addColorStop(1, rgba(colors.core, 0));
        g.fillStyle = sw;
        g.fillRect(0, 0, size, size);
      }
      g.restore();
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="cursor-pointer rounded-full border-0 bg-transparent p-0 outline-offset-8"
      style={{ width: size, height: size }}
    >
      <canvas ref={canvasRef} data-mode={mode} style={{ width: size, height: size }} />
    </button>
  );
}
