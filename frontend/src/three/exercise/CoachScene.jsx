// React wrapper for the 3D exercise coach (coachScene.js). Mounts the scene once,
// switches exercise when the prop changes, and reports the demo clock (and squat reps)
// back so the page can highlight the step being shown.
import { useEffect, useRef } from "react";
import { mountCoach } from "./coachScene.js";

const EDGE_FADE = {
  maskImage: "radial-gradient(ellipse 98% 94% at 50% 50%, #000 72%, transparent 100%)",
  WebkitMaskImage: "radial-gradient(ellipse 98% 94% at 50% 50%, #000 72%, transparent 100%)",
};

export default function CoachScene({ exercise, playing = true, restartKey = 0, onStep }) {
  const canvasRef = useRef(null), overlayRef = useRef(null), coachRef = useRef(null), stepRef = useRef(onStep);
  useEffect(() => { stepRef.current = onStep; }); // latest callback, without remounting the scene

  useEffect(() => {
    const coach = mountCoach(canvasRef.current, overlayRef.current, { onStep: (s) => stepRef.current?.(s) });
    coachRef.current = coach;
    return () => { coach.dispose(); coachRef.current = null; };
  }, []);
  useEffect(() => { coachRef.current?.setExercise(exercise || null); }, [exercise]);
  useEffect(() => { coachRef.current?.setPlaying(playing); }, [playing]);
  useEffect(() => { if (restartKey) coachRef.current?.restart(); }, [restartKey]);

  return (
    <div className="relative h-full min-h-[420px] w-full max-md:min-h-[340px]">
      <canvas ref={canvasRef} aria-label="3D coach demonstrating the selected exercise" className="absolute inset-0 block h-full w-full" style={EDGE_FADE} />
      <div ref={overlayRef} className="pointer-events-none absolute inset-0" />
    </div>
  );
}
