// React wrapper for the Mission Health 3D scene (missionScene.js): mounts the three.js
// scene once and switches mission when the prop changes. The scene draws its own
// hotspots and tooltip into the overlay div, so hovering never re-renders React.
// The canvas is transparent with softly faded edges: the models float on the card.
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { mountMissionScene } from "./missionScene.js";

const EDGE_FADE = {
  maskImage: "radial-gradient(ellipse 96% 92% at 50% 50%, #000 70%, transparent 100%)",
  WebkitMaskImage: "radial-gradient(ellipse 96% 92% at 50% 50%, #000 70%, transparent 100%)",
};

export default function MissionScene({ missionId }) {
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const sceneRef = useRef(null);
  const [explored, setExplored] = useState(false);

  useEffect(() => {
    const scene = mountMissionScene(canvasRef.current, overlayRef.current, { onExplore: () => setExplored(true) });
    sceneRef.current = scene;
    return () => { scene.dispose(); sceneRef.current = null; };
  }, []);

  useEffect(() => {
    if (missionId) sceneRef.current?.setMission(missionId);
  }, [missionId]);

  return (
    <div className="relative h-full min-h-[360px] w-full max-md:min-h-[320px]">
      <canvas ref={canvasRef} aria-label="3D view of the selected mission. Hover the glowing dots to learn more." className="absolute inset-0 block h-full w-full touch-pan-y" style={EDGE_FADE} />
      <div ref={overlayRef} className="pointer-events-none absolute inset-0 overflow-hidden" />
      <AnimatePresence>
        {!explored && (
          <motion.span
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full ah-glass px-3 py-1 text-[11px] text-muted"
          >
            Hover the glowing dots or the models · click to zoom
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}
