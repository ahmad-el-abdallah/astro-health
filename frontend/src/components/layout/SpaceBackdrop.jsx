// The deep-space backdrop behind every signed-in page -- what the frosted glass panels
// blur. Glass only looks like glass when there's real light and color behind it, so this
// has depth: nebula glows in the role color (crew blue / doctor teal, via --ah-glow-*),
// a faint Milky Way band, three star layers at different densities, and a planet's
// night-side horizon with a glowing atmosphere along the bottom right.
//
// Deliberately STATIC: a glass panel only has to re-blur when what's behind it changes,
// so a still backdrop keeps the frosted look as cheap as it can be. It's its own fixed,
// GPU-promoted layer (never `background-attachment: fixed`, which makes Chrome repaint
// the whole page on every scroll). Nothing here animates.
function stars(list, color) {
  return list.map((p) => `radial-gradient(${p}, ${color} 55%, transparent)`).join(",");
}

// Three tile sizes that don't divide each other, so the repeat pattern never lines up.
const STARS_FAINT = stars(
  ["1px 1px at 12% 18%", "1px 1px at 68% 8%", "1px 1px at 33% 64%", "1px 1px at 7% 76%", "1px 1px at 46% 31%",
   "1px 1px at 81% 59%", "1px 1px at 57% 94%", "1px 1px at 24% 45%", "1px 1px at 93% 22%", "1px 1px at 39% 83%"],
  "rgba(205,218,255,.5)",
);
const STARS_MID = stars(
  ["1.3px 1.3px at 85% 42%", "1.2px 1.2px at 52% 88%", "1.4px 1.4px at 92% 81%", "1.3px 1.3px at 18% 9%",
   "1.2px 1.2px at 63% 27%", "1.4px 1.4px at 4% 52%"],
  "rgba(230,236,255,.75)",
);
const STARS_BRIGHT = stars(
  ["1.8px 1.8px at 22% 30%", "2px 2px at 74% 66%", "1.7px 1.7px at 48% 12%"],
  "rgba(255,255,255,.95)",
);
const STAR_HALOS = ["7px 7px at 22% 30%", "8px 8px at 74% 66%", "6px 6px at 48% 12%"]
  .map((p) => `radial-gradient(${p}, rgba(170,195,255,.22), transparent)`).join(",");

export function SpaceBackdrop() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-[#03050c] [transform:translateZ(0)]">
      <div className="absolute inset-0 bg-[linear-gradient(175deg,#081026_0%,#050913_48%,#03050b_100%)]" />

      {/* Milky Way: a long, soft, tilted band of light. */}
      <div className="absolute top-[8%] -left-[20%] h-[34%] w-[140%] -rotate-[16deg] bg-[radial-gradient(closest-side,rgba(150,165,230,.10),rgba(120,130,210,.04)_60%,transparent)]" />
      <div className="absolute top-[18%] left-[10%] h-[10%] w-[80%] -rotate-[16deg] bg-[radial-gradient(closest-side,rgba(200,205,255,.07),transparent)]" />

      {/* Nebula glows in the role colors. */}
      <div className="absolute -top-[25%] -left-[15%] h-[85%] w-[70%] rounded-full bg-[radial-gradient(closest-side,var(--ah-glow-1),transparent_72%)]" />
      <div className="absolute top-[30%] -right-[18%] h-[80%] w-[60%] rounded-full bg-[radial-gradient(closest-side,var(--ah-glow-2),transparent_70%)]" />
      <div className="absolute -top-[10%] left-[42%] h-[55%] w-[40%] rounded-full bg-[radial-gradient(closest-side,rgba(150,110,255,.13),transparent_70%)]" />
      <div className="absolute top-[52%] left-[6%] h-[45%] w-[38%] rounded-full bg-[radial-gradient(closest-side,rgba(230,120,200,.06),transparent_70%)]" />

      {/* Stars. */}
      <div className="absolute inset-0" style={{ backgroundImage: STARS_FAINT, backgroundSize: "330px 330px" }} />
      <div className="absolute inset-0" style={{ backgroundImage: STARS_MID, backgroundSize: "530px 530px" }} />
      <div className="absolute inset-0" style={{ backgroundImage: `${STARS_BRIGHT},${STAR_HALOS}`, backgroundSize: "870px 870px" }} />

      {/* A planet's night-side horizon: a huge dark sphere just rising into the bottom-right
          corner, lit along its upper limb by a thin bright atmosphere. */}
      <div
        className="absolute rounded-full"
        style={{
          width: "190vmax",
          height: "190vmax",
          left: "28vw",
          top: "calc(100vh - 34vmin)",
          background:
            "radial-gradient(circle at 30% 2%, #17306a 0%, #0b1736 7%, #060c1d 22%, #03060e 48%)",
          boxShadow:
            "inset 0 2px 1px rgba(200,225,255,.55), inset 0 10px 24px var(--ah-planet-air), inset 0 46px 110px rgba(60,110,230,.22), 0 -6px 26px var(--ah-planet-air), 0 -30px 120px rgba(70,120,255,.22)",
        }}
      />

      {/* Gentle vignette so the edges fall off into deep space. */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_40%,transparent_55%,rgba(0,0,0,.45)_100%)]" />
    </div>
  );
}
