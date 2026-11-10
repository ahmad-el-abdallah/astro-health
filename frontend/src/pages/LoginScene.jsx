// The login page's animated space backdrop (AstroHealth-Redesign/screens/login.html):
// nebula glow, three parallax star layers, a shooting star, a floating Earth with an
// orbiting satellite, and a vignette so the sign-in card stays readable.
//
// Built for smoothness -- these rules come from profiling the first version, which
// lagged on scroll:
//   * only transform + opacity animate (GPU-composited, no repaint per frame);
//   * star layers drift by exactly one tile with translateX, never background-position;
//   * the blurred nebulas and the Earth's filtered SVG layers are static -- a moving
//     blurred/filtered element forces the blur to be recomputed every single frame.
import { memo } from "react";
import { motion } from "motion/react";

const STAR_LAYERS = [
  { size: 340, dur: 260, opacity: 0.4, dot: 1, color: "#c9d4ff", spots: ["10% 20%", "70% 60%", "40% 85%", "85% 15%", "25% 50%"] },
  { size: 220, dur: 150, opacity: 0.65, dot: 1.4, color: "#e6ecff", spots: ["15% 30%", "60% 10%", "80% 70%", "35% 65%", "50% 90%"] },
  { size: 160, dur: 90, opacity: 1, dot: 2.2, color: "#ffffff", spots: ["20% 40%", "65% 25%", "45% 75%", "85% 55%"], twinkle: true },
];

function StarLayer({ size, dur, opacity, dot, color, spots, twinkle }) {
  const backgroundImage = spots.map((s) => `radial-gradient(${dot}px ${dot}px at ${s}, ${color} 70%, transparent)`).join(",");
  return (
    <motion.div
      className="absolute -inset-[10%] will-change-transform"
      style={{ backgroundImage, backgroundSize: `${size}px ${size}px`, opacity }}
      animate={twinkle ? { x: [0, -size], opacity: [0.35, 0.9, 0.35] } : { x: [0, -size] }}
      transition={
        twinkle
          ? { x: { duration: dur, ease: "linear", repeat: Infinity }, opacity: { duration: 5, ease: "easeInOut", repeat: Infinity } }
          : { duration: dur, ease: "linear", repeat: Infinity }
      }
    />
  );
}

const LAND = [
  ["M120 260 C180 200 300 210 330 270 C360 330 300 360 320 420 C340 480 280 520 240 500 C200 480 210 420 160 400 C110 380 80 310 120 260Z", "#4d7a4c"],
  ["M300 560 C340 540 400 560 410 610 C420 670 380 760 340 800 C310 830 290 780 300 730 C310 680 270 620 300 560Z", "#5a7f45"],
  ["M520 220 C580 190 660 200 700 240 C740 280 720 320 680 330 C640 340 620 380 580 370 C540 360 500 300 520 220Z", "#567f4b"],
  ["M560 420 C620 400 690 430 700 500 C710 570 670 650 620 690 C590 715 570 660 560 610 C550 560 520 470 560 420Z", "#9a8458"],
  ["M600 460 C640 450 670 480 660 520 C650 560 610 560 595 520 C585 495 585 470 600 460Z", "#3f7a4e"],
  ["M760 300 C840 270 940 300 960 360 C980 420 920 440 880 430 C840 420 800 460 770 420 C740 380 720 320 760 300Z", "#4c8550"],
  ["M820 620 C870 600 930 620 930 660 C930 700 880 710 840 700 C800 690 790 640 820 620Z", "#b39a63"],
];
const CLOUDS = [
  [200, 330, 140, 22, -12], [430, 470, 110, 18, 8], [640, 300, 160, 20, -6],
  [800, 560, 130, 24, 14], [300, 680, 120, 16, -18], [900, 200, 90, 14, 0],
];

function Earth() {
  return (
    <motion.div
      className="absolute h-[1000px] w-[1000px] will-change-transform max-md:h-[700px] max-md:w-[700px]"
      style={{ right: -230, bottom: -470 }}
      animate={{ y: [0, -14, 0] }}
      transition={{ duration: 18, ease: "easeInOut", repeat: Infinity }}
    >
      <div className="absolute -inset-10 rounded-full bg-[radial-gradient(closest-side,rgba(110,160,255,.35),rgba(110,160,255,.08)_80%,transparent)]" />
      <svg viewBox="0 0 1000 1000" className="absolute inset-0 h-full w-full">
        <defs>
          <clipPath id="lg-earth-clip"><circle cx="500" cy="500" r="450" /></clipPath>
          <radialGradient id="lg-ocean" cx="30%" cy="24%" r="85%"><stop offset="0" stopColor="#2f78c9" /><stop offset="0.4" stopColor="#174a91" /><stop offset="1" stopColor="#061537" /></radialGradient>
          <radialGradient id="lg-shade" cx="22%" cy="16%" r="95%"><stop offset="0.3" stopColor="#020611" stopOpacity="0" /><stop offset="0.62" stopColor="#020611" stopOpacity="0.55" /><stop offset="0.85" stopColor="#020611" stopOpacity="0.92" /></radialGradient>
          <radialGradient id="lg-rim" cx="50%" cy="50%" r="50%"><stop offset="0.86" stopColor="#9fd0ff" stopOpacity="0" /><stop offset="0.97" stopColor="#9fd0ff" stopOpacity="0.35" /><stop offset="1" stopColor="#d6ecff" stopOpacity="0.7" /></radialGradient>
          <radialGradient id="lg-spec" cx="32%" cy="26%" r="30%"><stop offset="0" stopColor="#fff" stopOpacity="0.28" /><stop offset="1" stopColor="#fff" stopOpacity="0" /></radialGradient>
          <filter id="lg-soft"><feGaussianBlur stdDeviation="1.2" /></filter>
          <filter id="lg-cloudblur"><feGaussianBlur stdDeviation="6" /></filter>
          <filter id="lg-glow"><feGaussianBlur stdDeviation="8" /></filter>
        </defs>
        <circle cx="500" cy="500" r="456" fill="none" stroke="#8cc0ff" strokeWidth="14" opacity="0.55" filter="url(#lg-glow)" />
        <g clipPath="url(#lg-earth-clip)">
          <rect width="1000" height="1000" fill="url(#lg-ocean)" />
          <g filter="url(#lg-soft)" opacity="0.92">
            {[0, 620].map((tx) => (
              <g key={tx} transform={`translate(${tx} 110) scale(0.62)`}>
                {LAND.map(([d, fill], i) => <path key={i} d={d} fill={fill} />)}
              </g>
            ))}
          </g>
          <ellipse cx="500" cy="62" rx="300" ry="40" fill="#e9f2ff" opacity="0.85" filter="url(#lg-soft)" />
          <g filter="url(#lg-cloudblur)" opacity="0.6">
            {CLOUDS.map(([cx, cy, rx, ry, rot], i) => (
              <ellipse key={i} cx={cx} cy={cy} rx={rx} ry={ry} fill="#fff" transform={`rotate(${rot} ${cx} ${cy})`} />
            ))}
          </g>
          <rect width="1000" height="1000" fill="url(#lg-spec)" />
          <circle cx="500" cy="500" r="450" fill="url(#lg-rim)" />
          <rect width="1000" height="1000" fill="url(#lg-shade)" />
        </g>
      </svg>
      <motion.div
        className="absolute -inset-[70px] will-change-transform"
        animate={{ rotate: 360 }}
        transition={{ duration: 70, ease: "linear", repeat: Infinity }}
      >
        <svg width="56" height="28" viewBox="0 0 56 28" className="absolute top-[-14px] left-1/2 -ml-7">
          <rect x="0" y="9" width="18" height="10" rx="1.5" fill="#3b5bd6" stroke="#9db6ff" strokeWidth="1" />
          <rect x="38" y="9" width="18" height="10" rx="1.5" fill="#3b5bd6" stroke="#9db6ff" strokeWidth="1" />
          <path d="M18 14h20" stroke="#9db6ff" strokeWidth="1.5" />
          <rect x="22" y="7" width="12" height="14" rx="3" fill="#dfe6ff" />
          <motion.circle
            cx="28" cy="4" r="2" fill="#ff8a6b"
            animate={{ opacity: [0.55, 1, 0.55] }}
            transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
          />
        </svg>
      </motion.div>
    </motion.div>
  );
}

function LoginSceneImpl() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      <div className="absolute top-[-20%] left-[-10%] h-[80%] w-[70%] rounded-full bg-[radial-gradient(closest-side,rgba(74,104,236,.35),transparent_70%)] blur-[34px]" />
      <div className="absolute top-[40%] left-[30%] h-[70%] w-[55%] rounded-full bg-[radial-gradient(closest-side,rgba(47,191,168,.16),transparent_70%)] blur-[40px]" />
      <div className="absolute top-[-15%] left-[55%] h-[55%] w-[40%] rounded-full bg-[radial-gradient(closest-side,rgba(150,110,255,.18),transparent_70%)] blur-[36px]" />
      {STAR_LAYERS.map((l, i) => <StarLayer key={i} {...l} />)}
      <motion.div
        className="absolute top-[14%] left-[78%] h-0.5 w-[140px] rounded bg-gradient-to-r from-white/95 to-transparent will-change-transform"
        style={{ rotate: -18 }}
        initial={{ x: 0, y: 0, opacity: 0 }}
        animate={{ x: [0, -140, -700], y: [0, 46, 230], opacity: [0, 1, 0] }}
        transition={{ duration: 1, ease: "easeOut", repeat: Infinity, repeatDelay: 10, delay: 3, times: [0, 0.2, 1] }}
      />
      <Earth />
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(5,8,15,.78)_0%,rgba(5,8,15,.38)_45%,rgba(5,8,15,0)_70%)]" />
    </div>
  );
}

// Memoized: typing in the sign-in fields must never re-render the scene.
export const LoginScene = memo(LoginSceneImpl);
