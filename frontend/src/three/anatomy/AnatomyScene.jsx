// The Body page's realistic digital twin: real BodyParts3D anatomy (bones, organs, skin,
// muscles -- see scripts/build-anatomy.mjs) rendered as a glowing x-ray, like the user's
// reference dashboard. Regions tint yellow/red by their combined level (vitals +
// discomfort), red ones pulse, the heart beats at the latest heart rate, the lungs
// breathe, and clicking a region flies the camera to it.
//
// Performance: one draw call per region, BVH-accelerated picking, dpr capped at 1.5, and
// PerformanceMonitor drops bloom/resolution if the frame rate dips. The whole canvas is
// unmounted when you leave the page, so nothing renders in the background.
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame } from "@react-three/fiber";
import { Bvh, CameraControls, Html, PerformanceMonitor, useGLTF, useProgress } from "@react-three/drei";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import { NODE_LAYER, PICK_PRIORITY, REGION_NODES, REGIONS, WHOLE_BODY } from "./regions.js";
import { xrayMaterial } from "./xray.js";

export const MODEL_URL = "/models/anatomy.glb";

const BASE_COLOR = { skeleton: "#e4ecff", organ: "#9fb8ff", skin: "#6f9cff", muscles: "#ff9b9b" };
const LEVEL_COLOR = { YELLOW: "#ffd25e", RED: "#ff5a5a" };
const NODE_REGION = Object.fromEntries(Object.entries(REGION_NODES).flatMap(([r, ns]) => ns.map((n) => [n, r])));

function materialFor(name) {
  if (name === "skin") return xrayMaterial({ color: BASE_COLOR.skin, opacity: 0.22, power: 3.2, core: 0.0 });
  if (name === "muscles") return xrayMaterial({ color: BASE_COLOR.muscles, opacity: 0.16, power: 2.4, core: 0.02 });
  if (name === "skeleton") return xrayMaterial({ color: BASE_COLOR.skeleton, opacity: 0.55, power: 1.9, core: 0.1 });
  return xrayMaterial({ color: BASE_COLOR.organ, opacity: 0.4, power: 1.6, core: 0.16 });
}

// Materials + the low-poly wireframe overlay. useGLTF caches the loaded scene across
// visits, so this setup is done exactly once per scene (remembered on scene.userData) --
// redoing it on every visit would stack duplicate wireframes and re-read the heart's
// "base" size mid-beat.
function prepareScene(scene) {
  if (scene.userData.parts) return scene.userData.parts;
  const out = {};
  scene.traverse((o) => {
    if (!o.isMesh) return;
    if (o.name === "skeleton_wire") {
      const lines = new THREE.LineSegments(
        new THREE.WireframeGeometry(o.geometry),
        new THREE.LineBasicMaterial({ color: "#cfe0ff", transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      lines.raycast = () => {}; // decoration only -- never hit-test 40k line segments
      o.material = new THREE.MeshBasicMaterial({ visible: false });
      o.add(lines);
      o.raycast = () => {};
      out.wire = lines;
    } else {
      o.material = materialFor(o.name);
      if (o.name === "skin") o.raycast = () => {};
      o.userData.baseScale = o.scale.clone();
      out[o.name] = o;
    }
  });
  scene.userData.parts = out;
  return out;
}

function regionFromHits(intersections) {
  const found = new Set();
  for (const hit of intersections) {
    let o = hit.object;
    let visible = true;
    while (o) { if (!o.visible) visible = false; o = o.parent; }
    const r = NODE_REGION[hit.object.name];
    if (visible && r) found.add(r);
  }
  return PICK_PRIORITY.find((r) => found.has(r)) || null;
}

function Model({ levels, selected, hovered, setHovered, onPick, layers, heartRate, calloutsFor, controls }) {
  const { scene, nodes } = useGLTF(MODEL_URL, false, true);
  // Latest props for the per-frame loop (read in useFrame, so changing them never
  // rebuilds the 3D scene graph).
  const live = useRef({ levels, selected, hovered, heartRate });
  useLayoutEffect(() => { live.current = { levels, selected, hovered, heartRate }; });

  const parts = useMemo(() => prepareScene(scene), [scene]);

  // Bounding boxes for camera fly-to and callout anchors.
  const boxes = useMemo(() => {
    scene.updateMatrixWorld(true);
    const b = {};
    for (const r of [...REGIONS, "skin"]) {
      const names = r === "skin" ? ["skin"] : REGION_NODES[r];
      const box = new THREE.Box3();
      names.forEach((n) => nodes[n] && box.expandByObject(nodes[n]));
      b[r] = box;
    }
    return b;
  }, [scene, nodes]);

  // Layer toggles.
  useLayoutEffect(() => {
    Object.entries(NODE_LAYER).forEach(([name, layer]) => {
      if (nodes[name]) nodes[name].visible = layers[layer] !== false;
    });
  }, [layers, nodes]);

  // Fly to the selected region (or back to the whole body).
  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const key = selected && !WHOLE_BODY.has(selected) ? selected : "skin";
    const box = boxes[key];
    if (!box || box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const dist = key === "skin" ? 3.6 : Math.max(0.95, Math.max(size.x, size.y, size.z) * 5);
    c.setTarget(center.x, center.y, center.z, true);
    c.dollyTo(dist, true);
  }, [selected, boxes, controls]);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const { levels: lv, selected: sel, hovered: hov, heartRate: hr } = live.current;
    for (const [name, mesh] of Object.entries(parts)) {
      if (name === "wire") continue;
      const u = mesh.material.uniforms;
      if (!u) continue;
      const region = NODE_REGION[name];
      const level = region ? lv[region] : null;
      const flagged = level === "YELLOW" || level === "RED";
      const base = name === "skin" ? BASE_COLOR.skin : name === "muscles" ? BASE_COLOR.muscles : name === "skeleton" ? BASE_COLOR.skeleton : BASE_COLOR.organ;
      u.uColor.value.set(flagged ? LEVEL_COLOR[level] : base);
      const pulse = level === "RED" ? 0.75 + 0.25 * Math.sin(t * 4.2) : 1;
      const emphasis = region && region === sel ? 1.7 : region && region === hov ? 1.35 : 1;
      const baseOpacity = name === "skin" ? 0.22 : name === "muscles" ? 0.16 : name === "skeleton" ? 0.55 : 0.4;
      u.uOpacity.value = (flagged ? Math.max(baseOpacity, 0.85) : baseOpacity) * pulse;
      u.uGlow.value = emphasis * (flagged ? 1.25 : 1);
    }
    // heartbeat at the latest heart rate, lungs on a slow breath
    const heart = parts.heart;
    if (heart) {
      const bpm = hr > 0 ? hr : 62;
      const beat = 1 + 0.045 * Math.max(0, Math.sin(t * (bpm / 60) * Math.PI * 2)) ** 3;
      heart.scale.copy(heart.userData.baseScale).multiplyScalar(beat);
    }
    const lungs = parts.immune;
    if (lungs) {
      const breath = 0.018 * Math.sin(t * 1.6);
      const b = lungs.userData.baseScale;
      lungs.scale.set(b.x * (1 + breath), b.y * (1 + breath * 0.6), b.z * (1 + breath));
    }
  });

  const callouts = calloutsFor(boxes);

  return (
    <>
      <primitive
        object={scene}
        dispose={null}
        onClick={(e) => {
          if (e.delta > 6) return; // it was a drag-to-rotate, not a click
          e.stopPropagation();
          const r = regionFromHits(e.intersections);
          if (r) onPick(r);
        }}
        onPointerMove={(e) => {
          const r = regionFromHits(e.intersections);
          if (r !== live.current.hovered) setHovered(r);
          document.body.style.cursor = r ? "pointer" : "grab";
        }}
        onPointerOut={() => { setHovered(null); document.body.style.cursor = ""; }}
      />
      {callouts.map((c) => (
        <Html key={c.region} position={c.anchor} zIndexRange={[30, 0]} style={{ pointerEvents: "none" }}>
          <div className={`ah-callout ah-callout--${c.side}`} data-level={c.level}>
            <span className="ah-callout__dot" />
            <span className="ah-callout__line" />
            <span className="ah-callout__box">
              <strong>{c.title}</strong>
              {c.detail && <small>{c.detail}</small>}
            </span>
          </div>
        </Html>
      ))}
    </>
  );
}

function Loading() {
  const { progress } = useProgress();
  return (
    <Html center>
      <div className="flex w-48 flex-col items-center gap-2 text-xs text-muted">
        <span>Loading anatomy… {Math.round(progress)}%</span>
        <span className="h-1 w-full overflow-hidden rounded bg-line-strong">
          <span className="block h-full bg-accent-text transition-[width]" style={{ width: `${progress}%` }} />
        </span>
      </div>
    </Html>
  );
}

function IdleSpin({ controls, paused }) {
  const lastInput = useRef(0);
  useEffect(() => {
    const c = controls.current;
    if (!c) return undefined;
    const mark = () => { lastInput.current = performance.now(); };
    c.addEventListener("controlstart", mark);
    c.addEventListener("control", mark);
    return () => { c.removeEventListener("controlstart", mark); c.removeEventListener("control", mark); };
  }, [controls]);
  useFrame((_, dt) => {
    if (paused || !controls.current) return;
    if (performance.now() - lastInput.current < 5000) return;
    controls.current.rotate(dt * 0.12, 0, false);
  });
  return null;
}

export function AnatomyScene({ levels, selected, onSelect, layers, heartRate, calloutsFor, resetSignal }) {
  const controls = useRef(null);
  const [hovered, setHovered] = useState(null);
  const [dpr, setDpr] = useState(1.5);
  const [bloom, setBloom] = useState(true);

  useEffect(() => {
    if (resetSignal && controls.current) controls.current.rotateTo(0, Math.PI / 2, true);
  }, [resetSignal]);
  useEffect(() => () => { document.body.style.cursor = ""; }, []);

  return (
    <Canvas
      dpr={[1, dpr]}
      camera={{ position: [0, 0.95, 3.6], fov: 32, near: 0.05, far: 50 }}
      gl={{ antialias: true, powerPreference: "high-performance", alpha: true }}
      onPointerMissed={() => setHovered(null)}
      aria-label="Interactive 3D anatomy model"
    >
      <PerformanceMonitor onDecline={() => { setDpr(1); setBloom(false); }} />
      <CameraControls ref={controls} minDistance={0.35} maxDistance={6} smoothTime={0.45} draggingSmoothTime={0.12} />
      <IdleSpin controls={controls} paused={!!hovered} />
      <Suspense fallback={<Loading />}>
        <Bvh>
          <Model
            levels={levels}
            selected={selected}
            hovered={hovered}
            setHovered={setHovered}
            onPick={onSelect}
            layers={layers}
            heartRate={heartRate}
            calloutsFor={calloutsFor}
            controls={controls}
          />
        </Bvh>
      </Suspense>
      {bloom && (
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={0.85} luminanceThreshold={0.12} luminanceSmoothing={0.35} radius={0.72} resolutionScale={0.5} />
        </EffectComposer>
      )}
    </Canvas>
  );
}

useGLTF.preload(MODEL_URL, false, true);
