// Mission Health 3D: one real-time three.js scene per real mission (config/missions.json),
// built from NASA's own free assets (all in frontend/public, so it works offline):
//
//   models/missions/iss.glb      NASA 3D Resources: International Space Station (A)
//   models/missions/emu.glb      NASA 3D Resources: Extravehicular Mobility Unit (spacesuit)
//   models/missions/habitat.glb  NASA 3D Resources: Habitat Demonstration Unit
//   models/missions/earth.jpg    NASA Blue Marble Next Generation (via NASA WorldWind)
//   models/missions/moon.jpg     NASA full-Moon photograph, mars.jpg NASA Mars map
//   earth_rough.jpg / earth_clouds.png are made from the Blue Marble (ocean shine, clouds)
//   draco/                       three.js Draco decoder (the NASA models are compressed)
//
//   const s = mountMissionScene(canvas, overlayDiv, { onExplore });
//   s.setMission("artemis2");  s.dispose();
//
// - Transparent canvas: the scene floats on the card, no box.
// - The camera fits each scene to the canvas width, so nothing is cut off on narrow cards.
// - Hotspots: glowing dots pinned to the interesting parts. Hovering a dot or the model
//   shows a tooltip pinned to it (title, key numbers, fact); clicking flies the camera in.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

const ASSETS = "/models/missions/";

// ---------------------------------------------------------------- loading (cached, never stuck)
// Every asset load has a time limit and a fallback: if a NASA file is missing, blocked or
// slow on someone's network, the scene still builds (planets keep their colour, models get
// a simple stand-in) instead of the spinner hanging forever. Failures aren't cached, so the
// next visit tries the real file again.
const LOAD_TIMEOUT_MS = 20000;
let gltfLoader = null;
const modelCache = {}, texCache = {};
export const loadIssues = [];
function withTimeout(promise, what) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out loading ${what}`)), LOAD_TIMEOUT_MS))]);
}
function loadModel(name) {
  if (!gltfLoader) {
    const draco = new DRACOLoader(); draco.setDecoderPath("/draco/");
    gltfLoader = new GLTFLoader(); gltfLoader.setDRACOLoader(draco);
  }
  modelCache[name] ||= withTimeout(gltfLoader.loadAsync(ASSETS + name + ".glb"), name + ".glb").then((g) => g.scene).catch((err) => {
    console.warn(`[missions 3D] ${name}.glb failed, using a simple stand-in:`, err);
    loadIssues.push(name + ".glb"); delete modelCache[name];
    return fallbackModel(name);
  });
  return modelCache[name].then((scene) => scene.clone(true));
}
function loadTex(name, srgb = true) {
  texCache[name] ||= withTimeout(new THREE.TextureLoader().loadAsync(ASSETS + name), name).then((t) => {
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }).catch((err) => {
    console.warn(`[missions 3D] ${name} failed, using a plain colour:`, err);
    loadIssues.push(name); delete texCache[name];
    return null;
  });
  return texCache[name];
}
// Simple stand-ins built from shapes, only used when a .glb can't be fetched.
function fallbackModel(name) {
  const g = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: "#eef1f5", metalness: 0.2, roughness: 0.45, name: "White" });
  const metal = new THREE.MeshStandardMaterial({ color: "#b4bcc6", metalness: 0.8, roughness: 0.3, name: "Gray" });
  const panel = new THREE.MeshStandardMaterial({ color: "#1b3d8f", metalness: 0.5, roughness: 0.3, name: "Solar", side: THREE.DoubleSide });
  const add = (geo, mat, x, y, z, rx = 0, rz = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, 0, rz); g.add(m); return m; };
  if (name === "iss") {
    add(new THREE.BoxGeometry(4, 0.12, 0.12), metal, 0, 0, 0);
    for (const x of [-1.7, -1.1, 1.1, 1.7]) for (const z of [-0.75, 0.75]) add(new THREE.BoxGeometry(0.42, 0.02, 1.2), panel, x, 0, z);
    add(new THREE.CylinderGeometry(0.16, 0.16, 1.4, 24), white, 0, 0, 0, Math.PI / 2);
    add(new THREE.CylinderGeometry(0.15, 0.15, 0.9, 24), white, 0.35, 0, -0.2, 0, Math.PI / 2);
  } else if (name === "habitat") {
    add(new THREE.CylinderGeometry(1, 1, 0.9, 48), white, 0, 0, 0);
    add(new THREE.SphereGeometry(1, 48, 16, 0, Math.PI * 2, 0, Math.PI / 2), white, 0, 0.45, 0);
    add(new THREE.CylinderGeometry(0.28, 0.28, 0.9, 24), metal, 1.25, -0.1, 0, 0, Math.PI / 2);
  } else {
    const suit = new THREE.Group(); g.add(suit);
    const part = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); suit.add(m); };
    part(new THREE.CapsuleGeometry(0.28, 0.5, 8, 24), white, 0, 0.1, 0);
    part(new THREE.SphereGeometry(0.2, 32, 16), new THREE.MeshStandardMaterial({ color: "#c9a14a", metalness: 1, roughness: 0.15 }), 0, 0.72, 0.02);
    part(new THREE.BoxGeometry(0.5, 0.55, 0.22), white, 0, 0.2, -0.3);
    for (const x of [-0.4, 0.4]) part(new THREE.CapsuleGeometry(0.1, 0.5, 6, 16), white, x, 0.1, 0);
    for (const x of [-0.14, 0.14]) part(new THREE.CapsuleGeometry(0.12, 0.55, 6, 16), white, x, -0.55, 0);
  }
  return g;
}

// Scale a loaded model so its largest side is `size`, centred on the origin.
function normalize(obj, size) {
  const box = new THREE.Box3().setFromObject(obj), s = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const k = size / Math.max(s.x, s.y, s.z);
  obj.position.sub(c.multiplyScalar(k)); obj.scale.multiplyScalar(k);
  const wrap = new THREE.Group(); wrap.add(obj); return wrap;
}

// ---------------------------------------------------------------- small helpers
function canvasTex(w, h, draw) {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}
let _solar = null, _glow = null;
const solarTex = () => (_solar ||= canvasTex(256, 512, (g, w, h) => {
  g.fillStyle = "#0a1a3d"; g.fillRect(0, 0, w, h);
  for (let y = 0; y < h; y += 12) for (let x = 0; x < w; x += 12) {
    const k = g.createLinearGradient(x, y, x + 11, y + 11); k.addColorStop(0, "#2b5aa8"); k.addColorStop(1, "#102a5e");
    g.fillStyle = k; g.fillRect(x + 1, y + 1, 10, 10);
  }
  g.fillStyle = "rgba(230,190,120,.7)"; for (let y = 0; y < h; y += 96) g.fillRect(0, y, w, 3);
}));
const glowTex = () => (_glow ||= canvasTex(128, 128, (g, w) => {
  const r = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
  r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(0.2, "rgba(255,255,255,.5)"); r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r; g.fillRect(0, 0, w, w);
}));
const tileTex = () => canvasTex(512, 256, (g, w, h) => {
  g.fillStyle = "#c9cfd6"; g.fillRect(0, 0, w, h);
  g.strokeStyle = "rgba(60,70,82,.35)"; g.lineWidth = 2;
  for (let x = 0; x < w; x += 32) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
  for (let y = 0; y < h; y += 32) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
});
const std = (o) => new THREE.MeshStandardMaterial(o);
const MAT = {
  white: () => std({ color: "#eef1f5", metalness: 0.2, roughness: 0.45 }),
  metal: () => std({ color: "#b4bcc6", metalness: 0.9, roughness: 0.3 }),
  dark: () => std({ color: "#272e38", metalness: 0.6, roughness: 0.45 }),
  foil: () => std({ color: "#d8ad45", metalness: 1, roughness: 0.35 }),
  solar: () => std({ map: solarTex(), metalness: 0.5, roughness: 0.3, emissive: "#081838", emissiveIntensity: 0.5, side: THREE.DoubleSide }),
};
function mesh(geo, mat, x = 0, y = 0, z = 0) { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); return m; }
function glowSprite(color, size, opacity = 1) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex(), color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity }));
  s.scale.setScalar(size); return s;
}
function pathLine(points, color, dashed = true, opacity = 0.6) {
  const geo = new THREE.BufferGeometry().setFromPoints(points);
  const mat = dashed
    ? new THREE.LineDashedMaterial({ color, dashSize: 0.05, gapSize: 0.04, transparent: true, opacity, depthWrite: false })
    : new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
  const line = new THREE.Line(geo, mat); if (dashed) line.computeLineDistances(); return line;
}
const ring = (R, n = 200) => Array.from({ length: n + 1 }, (_, i) => { const a = i / n * Math.PI * 2; return new THREE.Vector3(Math.cos(a) * R, 0, Math.sin(a) * R); });

// ---------------------------------------------------------------- planets
const SUN_DIR = new THREE.Vector3(-0.8, 0.32, 0.5).normalize();

function atmosphere(radius, color, power, strength) {
  return new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 64), new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.BackSide, blending: THREE.AdditiveBlending,
    uniforms: { color: { value: new THREE.Color(color) }, power: { value: power }, strength: { value: strength }, sun: { value: SUN_DIR } },
    vertexShader: `varying vec3 vN; varying vec3 vW; void main(){ vN = normalize(normalMatrix * normal); vW = normalize((modelMatrix * vec4(normal,0.)).xyz); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
    fragmentShader: `uniform vec3 color; uniform float power; uniform float strength; uniform vec3 sun; varying vec3 vN; varying vec3 vW;
      void main(){ float rim = pow(clamp(1.0 - abs(dot(vN, vec3(0.,0.,1.))), 0., 1.), power);
      float lit = 0.15 + 0.85 * smoothstep(-0.35, 0.55, dot(vW, sun)); gl_FragColor = vec4(color * rim * strength * lit, rim * lit); }`,
  }));
}

// Point on a SphereGeometry (default UVs) for an equirectangular texture's lat/lon.
function latLon(lat, lon, r) {
  const u = (lon + 180) / 360, th = (90 - lat) / 180 * Math.PI;
  return new THREE.Vector3(-r * Math.cos(u * Math.PI * 2) * Math.sin(th), r * Math.cos(th), r * Math.sin(u * Math.PI * 2) * Math.sin(th));
}

async function earth(radius, seg = 128) {
  const [map, rough, clouds] = await Promise.all([loadTex("earth.jpg"), loadTex("earth_rough.jpg", false), loadTex("earth_clouds.png", false)]);
  const g = new THREE.Group();
  const body = mesh(new THREE.SphereGeometry(radius, seg, seg / 2), std({ map, color: map ? "#ffffff" : "#2f6fb5", roughnessMap: rough, roughness: rough ? 1 : 0.7, metalness: 0 }));
  const cloud = mesh(new THREE.SphereGeometry(radius * 1.01, seg, seg / 2), std({ color: "#ffffff", alphaMap: clouds, transparent: true, opacity: clouds ? 1 : 0, depthWrite: false, roughness: 1 }));
  g.add(body, cloud, atmosphere(radius * 1.075, "#4d9cff", 3.0, 1.5));
  const tilt = new THREE.Group(); tilt.rotation.z = 0.41; tilt.add(g);
  const wrap = new THREE.Group(); wrap.add(tilt);
  wrap.userData = { body, spin: (dt, s = 0.04) => { body.rotation.y += dt * s; cloud.rotation.y += dt * s * 1.18; }, noHighlight: true };
  return wrap;
}

async function moon(radius) {
  const map = await loadTex("moon.jpg");
  const geo = new THREE.SphereGeometry(radius, 96, 64);
  // the texture is NASA's photo of the full Moon, so project it straight onto the side facing us
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, 0.5 + 0.5 * pos.getX(i) / radius * 0.985, 0.5 + 0.5 * pos.getY(i) / radius * 0.985);
  const body = mesh(geo, std({ map, color: map ? "#ffffff" : "#9a9a9a", roughness: 0.95, metalness: 0 }));
  const wrap = new THREE.Group(); wrap.add(body, atmosphere(radius * 1.04, "#c8d0dc", 5, 0.35));
  wrap.userData = { body, spin: () => {}, noHighlight: true, facesCamera: true };
  return wrap;
}

async function mars(radius) {
  const map = await loadTex("mars.jpg");
  const body = mesh(new THREE.SphereGeometry(radius, 96, 64), std({ map, color: map ? "#ffffff" : "#c1440e", roughness: 0.95 }));
  const wrap = new THREE.Group(); wrap.add(body, atmosphere(radius * 1.06, "#ff9a66", 4, 0.9));
  wrap.userData = { body, spin: (dt, s = 0.1) => { body.rotation.y += dt * s; }, noHighlight: true };
  return wrap;
}

// ---------------------------------------------------------------- spacecraft
async function iss(size) {
  const m = await loadModel("iss");
  m.traverse((o) => {
    if (!o.isMesh) return;
    const n = o.material.name || "";
    if (/Solar/i.test(n)) o.material = std({ color: "#ffffff", map: solarTex(), metalness: 0.55, roughness: 0.28, emissive: "#0b1f4a", emissiveIntensity: 0.55, side: THREE.DoubleSide });
    else if (/White/i.test(n)) o.material = std({ color: "#f2f4f7", metalness: 0.25, roughness: 0.4 });
    else if (/Gray|Metal1/i.test(n)) o.material = std({ color: "#c4cad2", metalness: 0.7, roughness: 0.35 });
    else if (/Brown/i.test(n)) o.material = std({ color: "#c9a14a", metalness: 0.9, roughness: 0.35 });
  });
  return normalize(m, size);
}

function dragon(size) {
  const g = new THREE.Group(), white = MAT.white();
  g.add(mesh(new THREE.CylinderGeometry(0.52, 0.52, 0.55, 48), MAT.dark(), 0, -0.55, 0));
  const ring = mesh(new THREE.CylinderGeometry(0.525, 0.525, 0.3, 48, 1, true), MAT.solar(), 0, -0.6, 0); g.add(ring);
  g.add(mesh(new THREE.CylinderGeometry(0.3, 0.52, 0.55, 48), white, 0, 0, 0));
  g.add(mesh(new THREE.CylinderGeometry(0.31, 0.32, 0.08, 48), MAT.dark(), 0, 0.22, 0));
  g.add(mesh(new THREE.SphereGeometry(0.3, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2), white, 0, 0.27, 0));
  [0, 1, 2, 3].forEach((i) => { const w = mesh(new THREE.CircleGeometry(0.05, 20), MAT.dark()); const a = i * Math.PI / 2 + 0.4; w.position.set(Math.cos(a) * 0.43, -0.05, Math.sin(a) * 0.43); w.lookAt(w.position.clone().multiplyScalar(2)); g.add(w); });
  g.scale.setScalar(size / 1.4);
  return g;
}

// Orion: no free NASA model of it exists, so it is built here to match the real ship:
// a silver crew module on the European Service Module with four 3-panel solar wings.
function orion(size) {
  const g = new THREE.Group(), tiles = tileTex();
  const cm = mesh(new THREE.CylinderGeometry(0.22, 0.5, 0.48, 64), std({ map: tiles, metalness: 0.75, roughness: 0.35, color: "#e6e9ee" }), 0, 0.42, 0); g.add(cm);
  g.add(mesh(new THREE.CylinderGeometry(0.2, 0.22, 0.1, 48), MAT.metal(), 0, 0.71, 0));                 // docking tunnel
  [0, 1, 2, 3].forEach((i) => { const w = mesh(new THREE.PlaneGeometry(0.07, 0.05), std({ color: "#0b0f15", metalness: 1, roughness: 0.1 })); const a = i * Math.PI / 2 + 0.6; w.position.set(Math.cos(a) * 0.33, 0.5, Math.sin(a) * 0.33); w.lookAt(w.position.clone().multiplyScalar(3).setY(0.9)); g.add(w); });
  g.add(mesh(new THREE.CylinderGeometry(0.505, 0.505, 0.05, 64), std({ color: "#3a2a1e", roughness: 0.8 }), 0, 0.16, 0)); // heat shield
  g.add(mesh(new THREE.CylinderGeometry(0.46, 0.46, 0.62, 64), std({ color: "#dfe3e8", metalness: 0.6, roughness: 0.4 }), 0, -0.2, 0)); // ESM
  g.add(mesh(new THREE.CylinderGeometry(0.465, 0.465, 0.12, 64, 1, true), MAT.foil(), 0, -0.02, 0));
  g.add(mesh(new THREE.CylinderGeometry(0.47, 0.47, 0.18, 64, 1, true), std({ color: "#1b222b", metalness: 0.5, roughness: 0.5 }), 0, -0.36, 0)); // radiators
  g.add(mesh(new THREE.ConeGeometry(0.16, 0.28, 32, 1, true), std({ color: "#6b737d", metalness: 1, roughness: 0.25, side: THREE.DoubleSide }), 0, -0.64, 0)); // main engine
  const wings = [];
  for (let i = 0; i < 4; i++) {
    const p = new THREE.Group(); p.rotation.y = i * Math.PI / 2 + Math.PI / 4; p.position.y = -0.22;
    p.add(mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.35, 8), MAT.metal(), 0.62, 0, 0)).children.at(-1).rotation.z = Math.PI / 2;
    for (let k = 0; k < 3; k++) p.add(mesh(new THREE.BoxGeometry(0.62, 0.012, 0.38), MAT.solar(), 1.1 + k * 0.66, 0, 0));
    g.add(p); wings.push(p);
  }
  const plume = glowSprite("#8ff5e9", 0.7, 0.75); plume.position.y = -0.85; g.add(plume);
  g.userData.animate = (t) => { plume.material.opacity = 0.5 + 0.25 * Math.sin(t * 11); wings.forEach((w, i) => { w.rotation.x = 0.06 * Math.sin(t * 0.6 + i); }); };
  g.scale.setScalar(size / 4.6);
  return g;
}

// A real truss segment: four rails braced with diagonals, plus a yellow EVA handrail.
function truss(len) {
  const g = new THREE.Group(), m = MAT.metal(), s = 0.16;
  const rail = (y, z) => { const r = mesh(new THREE.CylinderGeometry(0.012, 0.012, len, 8), m, 0, y, z); r.rotation.z = Math.PI / 2; g.add(r); };
  rail(s, s); rail(-s, s); rail(s, -s); rail(-s, -s);
  for (let x = -len / 2; x < len / 2; x += 0.32) {
    [[s, s, -s, s], [s, -s, -s, -s], [s, s, s, -s], [-s, s, -s, -s]].forEach(([y1, z1, y2, z2]) => {
      const a = new THREE.Vector3(x, y1, z1), b = new THREE.Vector3(x + 0.32, y2, z2), d = b.clone().sub(a);
      const c = mesh(new THREE.CylinderGeometry(0.007, 0.007, d.length(), 6), m); c.position.copy(a).add(d.multiplyScalar(0.5));
      c.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()); g.add(c);
    });
  }
  const hr = mesh(new THREE.CylinderGeometry(0.016, 0.016, len * 0.8, 10), std({ color: "#f3c244", roughness: 0.5 }), 0, -s - 0.06, s); hr.rotation.z = Math.PI / 2; g.add(hr);
  g.userData.handrail = hr;
  return g;
}

function helix() {
  const g = new THREE.Group(), n = 30, R = 0.32, step = 0.095;
  const bead = new THREE.SphereGeometry(0.05, 24, 16), rod = new THREE.CylinderGeometry(0.011, 0.011, 1, 8);
  const mA = std({ color: "#4fd1c5", emissive: "#4fd1c5", emissiveIntensity: 0.45, roughness: 0.25, metalness: 0.3 });
  const mB = std({ color: "#a78bfa", emissive: "#a78bfa", emissiveIntensity: 0.45, roughness: 0.25, metalness: 0.3 });
  const rungs = ["#f6c177", "#7dd3fc", "#f0abfc", "#86efac"].map((c) => std({ color: c, emissive: c, emissiveIntensity: 0.3, roughness: 0.4 }));
  const strandA = [], strandB = [];
  for (let i = 0; i < n; i++) {
    const a = i * 0.44, y = (i - n / 2) * step;
    const p1 = new THREE.Vector3(Math.cos(a) * R, y, Math.sin(a) * R), p2 = new THREE.Vector3(-p1.x, y, -p1.z);
    g.add(mesh(bead, mA, p1.x, p1.y, p1.z), mesh(bead, mB, p2.x, p2.y, p2.z)); strandA.push(p1); strandB.push(p2);
    const r = mesh(rod, rungs[i % 4], 0, y, 0); r.scale.y = R * 1.7; r.rotation.z = Math.PI / 2; r.rotation.y = -a; g.add(r);
  }
  [strandA, strandB].forEach((pts, k) => g.add(mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 200, 0.014, 8), k ? mB : mA)));
  return g;
}

// ---------------------------------------------------------------- missions
// Each builder returns { group, hoverables, hotspots, update(t, dt), view: { dir, center, radius } }.
// hoverables: objects with userData.hover = { title, stats: [..], text }.
// hotspots: { obj, offset: Vector3, hover } (a glowing dot pinned to obj).
const H = (title, stats, text) => ({ title, stats, text });

const MISSIONS = {
  async crew13_iss({ sunView }) {
    const group = new THREE.Group();
    const E = await earth(1.0); E.position.set(0, -0.15, 0); group.add(E);
    E.userData.hover = H("Earth · low Earth orbit", ["~400 km up", "16 orbits a day"], "The ISS circles Earth every 90 minutes, so the crew sees 16 sunrises a day. That's why sleep and the body clock suffer.");
    const orbit = new THREE.Group(); orbit.position.copy(E.position); orbit.rotation.set(0.28, 0, 0.4); group.add(orbit);
    orbit.add(pathLine(ring(1.42), "#8fb3ff", true, 0.35));
    const carrier = new THREE.Group(); orbit.add(carrier);
    const station = await iss(0.85); carrier.add(station);
    station.userData.hover = H("International Space Station", ["Crew-13 · ~6 months", "Bone −1 to 1.5%/month"], "Home of Expedition 75. In 0 g bones and muscles weaken, so the crew exercises about 2 hours a day.");
    const capsule = dragon(0.17); capsule.position.set(0.02, 0.0, 0.23); capsule.rotation.x = Math.PI / 2; carrier.add(capsule);
    capsule.userData.hover = H("Crew Dragon 'Grace'", ["Launched Oct 1, 2026", "4 crew"], "Flew Crew-13 up from Cape Canaveral and stays docked as their lifeboat and ride home.");
    return {
      group, hoverables: [station, capsule, E], view: { dir: [0, 0.22, 1], center: [0, -0.05, 0], radius: 1.65 },
      hotspots: [
        { obj: station, offset: new THREE.Vector3(0, 0.12, 0), hover: station.userData.hover },
        { obj: E.userData.body, offset: latLon(28.5, -80.6, 1.02), hover: H("Kennedy / Cape Canaveral", ["Launch site"], "Crew-13 launched from Space Launch Complex 40 at Cape Canaveral, Florida.") },
      ],
      update(t, dt) {
        E.userData.spin(dt, 0.035);
        const a = t * 0.12 + 1.2; carrier.position.set(Math.cos(a) * 1.42, 0, Math.sin(a) * 1.42); carrier.rotation.y = -a + Math.PI / 2;
      },
    };
  },

  async twin_study() {
    const group = new THREE.Group();
    const E = await earth(0.9); E.position.set(-0.7, -0.05, 0); group.add(E);
    E.userData.hover = H("Earth · Mark Kelly", ["The control twin", "Same genes"], "Mark stayed on the ground for the year, so scientists could tell spaceflight's effects apart from normal changes.");
    const houston = latLon(29.7, -95.4, 0.92);
    const mark = glowSprite("#a78bfa", 0.2); mark.position.copy(houston); E.userData.body.add(mark);
    const orbit = new THREE.Group(); orbit.position.copy(E.position); orbit.rotation.set(0.32, 0, 0.5); group.add(orbit);
    orbit.add(pathLine(ring(1.25), "#8fb3ff", true, 0.3));
    const carrier = new THREE.Group(); orbit.add(carrier);
    const station = await iss(0.48); carrier.add(station);
    station.userData.hover = H("ISS · Scott Kelly", ["340 days", "Mar 2015 – Mar 2016"], "Almost a year in space: his retina and carotid artery wall thickened and his gut bacteria shifted.");
    const link = pathLine([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)], "#c4b5fd", true, 0.8); group.add(link);
    const dna = helix(); dna.position.set(1.3, 0.0, 0); dna.scale.setScalar(0.8); dna.rotation.z = 0.15; group.add(dna);
    dna.userData.hover = H("What changed in his genes", ["1,000+ genes changed", "Telomeres grew, then shrank"], "Many changes were tied to DNA repair and immunity. Most went back to normal after landing; a few did not.");
    const A = new THREE.Vector3(), B = new THREE.Vector3();
    return {
      group, hoverables: [station, dna, E], view: { dir: [0.05, 0.12, 1], center: [0.25, 0, 0], radius: 1.9 },
      hotspots: [
        { obj: mark, offset: new THREE.Vector3(), hover: H("Houston · Mark Kelly", ["On Earth"], "The twin on the ground. His samples were taken at the same times as Scott's for 27 months.") },
        { obj: dna, offset: new THREE.Vector3(0, 1.45, 0), hover: dna.userData.hover },
      ],
      update(t, dt) {
        E.userData.spin(dt, 0.04);
        const a = t * 0.17; carrier.position.set(Math.cos(a) * 1.25, 0, Math.sin(a) * 1.25); carrier.rotation.y = -a + Math.PI / 2;
        dna.rotation.y += dt * 0.45;
        mark.getWorldPosition(A); station.getWorldPosition(B); group.worldToLocal(A); group.worldToLocal(B);
        link.geometry.setFromPoints([A, B]); link.computeLineDistances();
        mark.material.opacity = 0.65 + 0.35 * Math.sin(t * 3);
      },
    };
  },

  async artemis2({ camera }) {
    const group = new THREE.Group();
    const E = await earth(0.5); E.position.set(-1.45, 0, 0); group.add(E);
    E.userData.hover = H("Earth", ["Launch: April 2026", "Kennedy, pad 39B"], "The first crew to leave Earth orbit since Apollo 17 in 1972.");
    const M = await moon(0.24); M.position.set(1.6, 0.12, -0.15); group.add(M);
    M.userData.hover = H("The Moon", ["~10-day trip", "Free-return path"], "At closest approach the Moon looked like a basketball held at arm's length.");
    const belts = new THREE.Group(); belts.position.copy(E.position); belts.rotation.set(1.0, 0.2, 0.3); group.add(belts);
    [[0.74, "#5fb4ff", 0.05], [1.08, "#ff9f5a", 0.08]].forEach(([r, c, tube]) => belts.add(mesh(new THREE.TorusGeometry(r, tube, 32, 160), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { color: { value: new THREE.Color(c) } },
      vertexShader: "varying vec3 vN; void main(){ vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }",
      fragmentShader: "uniform vec3 color; varying vec3 vN; void main(){ float f = 1.0 - abs(vN.z); gl_FragColor = vec4(color, 0.06 + 0.42 * f * f); }",
    }))));
    belts.userData.hover = H("Van Allen radiation belts", ["Trapped radiation", "AVATAR organ chips"], "Orion flew through these zones. Chips grown from the crew's own bone-marrow cells rode along to measure the damage.");
    const curve = new THREE.CatmullRomCurve3([
      [-0.85, 0.05, 0.3], [-0.2, 0.2, 0.48], [0.75, 0.26, 0.36], [1.55, 0.36, 0.25], [2.0, 0.2, -0.18], [1.72, 0.0, -0.5],
      [1.0, 0.0, -0.38], [0.1, 0.04, -0.12], [-0.8, -0.04, -0.42], [-1.5, -0.08, -0.7], [-2.08, -0.04, -0.1], [-1.8, 0.0, 0.42],
    ].map((p) => new THREE.Vector3(...p)), true, "catmullrom", 0.5);
    group.add(pathLine(curve.getPoints(400), "#9fb4d6", true, 0.45));
    const trail = pathLine(curve.getPoints(60), "#4fd1c5", false, 0.95); group.add(trail);
    const ship = orion(0.3); group.add(ship);
    ship.userData.hover = H("Orion · 4 crew", ["Campervan-sized", "6 radiation sensors"], "ARCHeR wristbands tracked sleep and stress, and each astronaut carried a dosimeter in a pocket.");
    const up = new THREE.Vector3(0, 1, 0), tan = new THREE.Vector3(), q = new THREE.Quaternion();
    const wrap = (u) => ((u % 1) + 1) % 1;
    return {
      group, hoverables: [ship, M, belts, E], view: { dir: [0, 0.3, 1], center: [0.1, 0.05, 0], radius: 2.25 },
      hotspots: [
        { obj: ship, offset: new THREE.Vector3(0, 0.25, 0), hover: ship.userData.hover },
        { obj: belts, offset: new THREE.Vector3(0, 1.08, 0), hover: belts.userData.hover },
        { obj: M, offset: new THREE.Vector3(0, 0.3, 0), hover: M.userData.hover },
      ],
      update(t, dt) {
        E.userData.spin(dt, 0.06); belts.rotation.z += dt * 0.04;
        M.lookAt(camera.position);
        const u = wrap(t * 0.03);
        ship.position.copy(curve.getPointAt(u));
        curve.getTangentAt(u, tan); q.setFromUnitVectors(up, tan.normalize()); ship.quaternion.slerp(q, 0.12);
        const tp = []; for (let i = 0; i <= 60; i++) tp.push(curve.getPointAt(wrap(u - 0.1 + i * 0.1 / 60)));
        trail.geometry.setFromPoints(tp);
        ship.userData.animate(t);
      },
    };
  },

  async mars520() {
    const group = new THREE.Group();
    const hab = await loadModel("habitat"); const habitat = normalize(hab, 1.9); habitat.position.set(0, -0.45, 0); group.add(habitat);
    habitat.userData.hover = H("Sealed habitat", ["520 days", "6 crew · 550 m³"], "Six people lived in linked modules like this, acting out a full Mars trip without ever leaving Moscow.");
    const deck = mesh(new THREE.CylinderGeometry(1.45, 1.55, 0.06, 96), std({ color: "#18212e", metalness: 0.6, roughness: 0.5 }), 0, -0.98, 0); group.add(deck);
    const edge = mesh(new THREE.TorusGeometry(1.47, 0.01, 8, 200), new THREE.MeshBasicMaterial({ color: "#4fd1c5", transparent: true, opacity: 0.7 }), 0, -0.95, 0); edge.rotation.x = Math.PI / 2; group.add(edge);
    const holo = new THREE.Group(); holo.position.set(0.05, 0.95, -0.2); group.add(holo);
    const red = await mars(0.3); holo.add(red);
    red.userData.hover = H("The Mars they never reached", ["250 out · 30 · 240 back", "Up to 20-min delay"], "The whole trip was acted out, including a 'landing' and 'Marswalks', with messages to mission control delayed.");
    const wire = mesh(new THREE.SphereGeometry(0.34, 28, 18), new THREE.MeshBasicMaterial({ color: "#4fd1c5", wireframe: true, transparent: true, opacity: 0.1 })); holo.add(wire);
    const loopPts = Array.from({ length: 201 }, (_, i) => { const a = i / 200 * Math.PI * 2; return new THREE.Vector3(Math.cos(a) * 0.7, Math.sin(a * 2) * 0.05, Math.sin(a) * 0.3); });
    holo.add(pathLine(loopPts, "#4fd1c5", true, 0.55));
    const dot = glowSprite("#c8fff8", 0.14); holo.add(dot);
    holo.add(mesh(new THREE.CylinderGeometry(0.02, 0.45, 0.9, 40, 1, true), new THREE.MeshBasicMaterial({ color: "#4fd1c5", transparent: true, opacity: 0.05, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }), 0, -0.6, 0));
    return {
      group, hoverables: [habitat, red], view: { dir: [0.15, 0.38, 1], center: [0, 0.0, 0], radius: 1.6 },
      hotspots: [
        { obj: habitat, offset: new THREE.Vector3(-0.35, 0.55, 0.2), hover: H("Living & medical module", ["Daily blood + urine tests"], "Crews slept more but worse as the months went by, and moved less and less while awake.") },
        { obj: habitat, offset: new THREE.Vector3(0.6, 0.05, 0.25), hover: H("Storage & greenhouse", ["All food packed at the start"], "No resupply, just like a real Mars mission: an ISS-style diet for 520 days.") },
        { obj: red, offset: new THREE.Vector3(0, 0.36, 0), hover: red.userData.hover },
      ],
      update(t, dt) {
        red.userData.spin(dt, 0.12); wire.rotation.y -= dt * 0.06;
        const a = t * 0.35; dot.position.set(Math.cos(a) * 0.7, Math.sin(a * 2) * 0.05, Math.sin(a) * 0.3);
        holo.position.y = 0.95 + Math.sin(t * 0.8) * 0.035;
        group.rotation.y = Math.sin(t * 0.1) * 0.25 - 0.15;
      },
    };
  },

  async spacewalk() {
    const group = new THREE.Group();
    const E = await earth(7, 192); E.position.set(0.3, -7.85, -2.2); E.rotation.set(-0.55, 0, 0.1); E.userData.body.rotation.y = 2.6; group.add(E);
    E.userData.hover = H("Earth, 400 km below", ["~28,000 km/h", "Suit = only shield"], "Outside the station only the suit protects the astronaut from radiation and the vacuum of space.");
    const T = truss(3.2); T.position.set(-1.0, 0.75, -0.5); T.rotation.set(0.15, 0.5, -0.18); group.add(T);
    const wing = mesh(new THREE.BoxGeometry(0.7, 2.0, 0.015), MAT.solar(), -0.95, 1.2, -0.05); T.add(wing);
    T.userData.hover = H("ISS truss & handrails", ["Hand over hand", "Gloves = top injury cause"], "Spacewalkers pull themselves along yellow handrails. Gripping in stiff, pressurised gloves hurts fingers and shoulders.");
    const suitModel = await loadModel("emu");
    const suit = normalize(suitModel, 1.35); suit.children[0].rotation.y = Math.PI; group.add(suit);
    suit.userData.hover = H("Astronaut in an EMU spacesuit", ["6–8 hours", "~0.26 injuries per EVA"], "NASA's real spacesuit. Crews breathe pure oxygen beforehand to avoid the bends, and the suit's cooling fights body heat.");
    const tetherMat = std({ color: "#f5f7fa", roughness: 0.55 });
    const tether = mesh(new THREE.BufferGeometry(), tetherMat); group.add(tether);
    tether.userData.hover = H("Safety tether", ["Always clipped on"], "If a spacewalker let go without a tether there would be no way back, so they stay clipped to the station.");
    const anchor = new THREE.Vector3(), waist = new THREE.Vector3();
    return {
      group, hoverables: [suit, tether, T, E], view: { dir: [0, 0.12, 1], center: [-0.05, 0.28, 0], radius: 1.6 },
      hotspots: [
        { obj: suit, offset: new THREE.Vector3(0, 0.38, -0.05), hover: H("Helmet & gold visor", ["Gold blocks glare + UV"], "The thin gold layer on the visor protects the eyes from direct sunlight, which is far harsher in space.") },
        { obj: suit, offset: new THREE.Vector3(0.0, 0.05, 0.25), hover: H("Life-support backpack", ["Oxygen · cooling · CO₂ removal"], "Keeps the astronaut alive for up to about 8 hours; poor airflow can let CO₂ build up and cloud thinking.") },
        { obj: T, offset: new THREE.Vector3(0.4, -0.25, 0.2), hover: T.userData.hover },
      ],
      update(t, dt) {
        E.userData.spin(dt, 0.008);
        suit.position.set(0.3 + Math.sin(t * 0.3) * 0.06, 0.3 + Math.sin(t * 0.5) * 0.05, 0.35);
        suit.rotation.set(0.1 * Math.sin(t * 0.35), 0.35 + 0.25 * Math.sin(t * 0.2), 0.15 * Math.sin(t * 0.4));
        T.userData.handrail.getWorldPosition(anchor); group.worldToLocal(anchor);
        waist.set(0.0, -0.05, 0.05); suit.localToWorld(waist); group.worldToLocal(waist);
        const mid = anchor.clone().lerp(waist, 0.5); mid.y -= 0.32 + 0.04 * Math.sin(t * 0.7);
        tether.geometry.dispose(); tether.geometry = new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(anchor, mid, waist), 48, 0.007, 6, false);
      },
    };
  },
};

// ---------------------------------------------------------------- overlay (hotspots + tooltip)
const CSS = `
.ms-hot{position:absolute;left:0;top:0;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;cursor:pointer;pointer-events:auto}
.ms-hot::before{content:"";position:absolute;inset:6px;border-radius:50%;background:#e6ecff;box-shadow:0 0 10px 2px rgba(143,166,255,.9)}
.ms-hot::after{content:"";position:absolute;inset:0;border-radius:50%;border:1.5px solid rgba(143,166,255,.85);animation:msPulse 2.2s ease-out infinite}
.ms-hot.on::before{background:#fff;box-shadow:0 0 16px 4px rgba(143,166,255,1)}
@keyframes msPulse{0%{transform:scale(.6);opacity:1}100%{transform:scale(1.9);opacity:0}}
.ms-tip{position:absolute;left:0;top:0;width:270px;pointer-events:none;visibility:hidden;
  background:rgba(12,18,36,.82);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border:1px solid rgba(143,166,255,.35);
  border-radius:16px;padding:12px 14px;box-shadow:0 12px 40px rgba(0,0,0,.45);color:#e8eefc;font:12px/1.5 Inter,system-ui,sans-serif;z-index:5}
.ms-tip.show{visibility:visible;animation:msIn .16s ease-out}
@keyframes msIn{from{opacity:0}to{opacity:1}}
.ms-tip b{display:flex;align-items:center;gap:8px;font-size:13.5px;margin-bottom:6px;color:#fff}
.ms-tip b::before{content:"";width:8px;height:8px;border-radius:50%;background:#8fa6ff;box-shadow:0 0 10px #8fa6ff;flex:none}
.ms-tip .st{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:7px}
.ms-tip .st span{background:rgba(143,166,255,.16);border:1px solid rgba(143,166,255,.3);color:#c9d6ff;border-radius:999px;padding:1px 8px;font-size:11px;font-weight:600}
.ms-tip p{margin:0;color:#b8c3da}
.ms-tip .hint{margin-top:7px;font-size:10.5px;color:#7f8db0}
.ms-load{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#9aa8c7;font:12px Inter,system-ui,sans-serif;pointer-events:none}
.ms-load[hidden]{display:none}
.ms-load i{width:26px;height:26px;border-radius:50%;border:2px solid rgba(143,166,255,.25);border-top-color:#8fa6ff;animation:msSpin 1s linear infinite;margin-right:10px}
@keyframes msSpin{to{transform:rotate(360deg)}}`;

// ---------------------------------------------------------------- mount
export function mountMissionScene(canvas, overlay, { onExplore } = {}) {
  if (!document.getElementById("ms-css")) { const st = document.createElement("style"); st.id = "ms-css"; st.textContent = CSS; document.head.appendChild(st); }

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = env; scene.environmentIntensity = 0.4;
  const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 300);
  const sun = new THREE.DirectionalLight("#fff6e6", 3.4); sun.position.copy(SUN_DIR).multiplyScalar(30); scene.add(sun);
  scene.add(new THREE.HemisphereLight("#a9c8ff", "#05070c", 0.22));
  const rimLight = new THREE.DirectionalLight("#7fb4ff", 0.9); rimLight.position.set(5, -1, -6); scene.add(rimLight);

  // overlay DOM
  const tip = document.createElement("div"); tip.className = "ms-tip"; overlay.appendChild(tip);
  const loader = document.createElement("div"); loader.className = "ms-load"; overlay.appendChild(loader);
  let loading = false;
  const showLoader = (html) => { loading = true; loader.innerHTML = html; loader.hidden = false; loader.style.display = "flex"; };
  const hideLoader = () => { loading = false; loader.hidden = true; loader.style.display = "none"; };
  showLoader("<i></i>Loading NASA models…");
  let hotEls = [];

  const sunView = { value: new THREE.Vector3() };
  let current = null, missionId = null, token = 0, raf = 0, last = performance.now();
  const t0 = performance.now();
  const camGoal = new THREE.Vector3(), lookGoal = new THREE.Vector3(), look = new THREE.Vector3();
  const pointer = new THREE.Vector2(), parallax = new THREE.Vector2(), smoothPar = new THREE.Vector2(), raycaster = new THREE.Raycaster();
  let hovered = null, hoverSource = null, focus = null, explored = false;
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const tmp = new THREE.Vector3();

  // Distance so a sphere of `radius` fits the canvas width and height.
  function frameView() {
    if (!current) return;
    const v = current.view, dir = new THREE.Vector3(...v.dir).normalize(), c = new THREE.Vector3(...v.center);
    const vf = THREE.MathUtils.degToRad(camera.fov) / 2, hf = Math.atan(Math.tan(vf) * camera.aspect);
    const dist = v.radius / Math.sin(Math.min(vf, hf)) * 0.92;
    if (focus) {
      focus.obj.getWorldPosition(tmp);
      const d = Math.max(0.9, v.radius * 0.55) / Math.sin(Math.min(vf, hf));
      camGoal.copy(tmp).add(dir.multiplyScalar(d)); lookGoal.copy(tmp);
    } else { camGoal.copy(c).add(dir.multiplyScalar(dist)); lookGoal.copy(c); }
  }

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    const pr = renderer.getPixelRatio();
    if (canvas.width !== Math.round(w * pr) || canvas.height !== Math.round(h * pr)) {
      renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    }
  }
  const ro = new ResizeObserver(resize); ro.observe(canvas);

  function disposeGroup(g) {
    g.traverse((o) => {
      o.geometry?.dispose();
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      mats.forEach((m) => m.dispose());   // textures are cached and shared, so they stay
    });
  }

  function setHighlight(obj, on) {
    if (!obj || obj.userData.noHighlight) return;
    obj.traverse((o) => {
      if (!o.isMesh || !o.material || !("emissive" in o.material)) return;
      if (on) {
        if (!o.userData._own) { o.material = o.material.clone(); o.userData._own = true; o.userData._em = [o.material.emissive.clone(), o.material.emissiveIntensity]; }
        o.material.emissive.set("#5b7cff"); o.material.emissiveIntensity = o.userData._em[1] + 0.32;
      } else if (o.userData._em) { o.material.emissive.copy(o.userData._em[0]); o.material.emissiveIntensity = o.userData._em[1]; }
    });
  }
  const rootWithHover = (o) => { for (; o; o = o.parent) if (o.userData.hover) return o; return null; };

  function showTip(h, anchorObj, offset) {
    tip.innerHTML = `<b>${h.title}</b>${h.stats?.length ? `<div class="st">${h.stats.map((s) => `<span>${s}</span>`).join("")}</div>` : ""}<p>${h.text}</p><div class="hint">${focus ? "Click empty space to zoom out" : "Click to zoom in"}</div>`;
    tip.classList.add("show");
    hoverSource = { obj: anchorObj, offset: offset || new THREE.Vector3() };
    if (!explored) { explored = true; onExplore?.(); }
  }
  function hideTip() { tip.classList.remove("show"); hoverSource = null; }

  // place tooltip next to its anchor, kept inside the overlay
  function placeTip() {
    if (!hoverSource) return;
    const p = hoverSource.offset.clone(); hoverSource.obj.localToWorld(p); p.project(camera);
    const W = overlay.clientWidth, Hh = overlay.clientHeight;
    const x = (p.x * 0.5 + 0.5) * W, y = (-p.y * 0.5 + 0.5) * Hh;
    const left = x + 290 > W ? x - 286 : x + 18, top = Math.min(Math.max(8, y - 40), Hh - tip.offsetHeight - 8);
    tip.style.transform = `translate(${Math.max(8, left)}px, ${top}px)`;
  }

  function buildHotspots() {
    hotEls.forEach((e) => e.remove());
    hotEls = (current?.hotspots || []).map((hs) => {
      const el = document.createElement("div"); el.className = "ms-hot"; el.title = hs.hover.title;
      el.addEventListener("pointerenter", () => { el.classList.add("on"); setHighlight(hovered, false); hovered = null; showTip(hs.hover, hs.obj, hs.offset); });
      el.addEventListener("pointerleave", () => { el.classList.remove("on"); hideTip(); });
      el.addEventListener("click", (e) => { e.stopPropagation(); focus = { obj: hs.obj }; frameView(); showTip(hs.hover, hs.obj, hs.offset); });
      overlay.appendChild(el); return { el, hs };
    });
  }
  function placeHotspots() {
    const W = overlay.clientWidth, Hh = overlay.clientHeight, camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    hotEls.forEach(({ el, hs }) => {
      const p = hs.offset.clone(); hs.obj.localToWorld(p);
      const toP = p.clone().sub(camera.position);
      // hide dots on the far side of a planet / behind the camera
      let hidden = toP.dot(camDir) < 0;
      if (!hidden) {
        raycaster.set(camera.position, toP.clone().normalize()); raycaster.camera = camera;
        const hit = raycaster.intersectObjects(current.hoverables, true)[0];
        hidden = hit && hit.distance < toP.length() - 0.08 && rootWithHover(hit.object) !== hs.obj && !hs.obj.getObjectById?.(hit.object.id) && rootWithHover(hit.object)?.userData.noHighlight;
      }
      p.project(camera);
      el.style.transform = `translate(${(p.x * 0.5 + 0.5) * W}px, ${(-p.y * 0.5 + 0.5) * Hh}px)`;
      el.style.opacity = hidden ? "0" : "1"; el.style.pointerEvents = hidden ? "none" : "auto";
    });
  }

  function pick(clientX, clientY) {
    if (!current) return null;
    const r = canvas.getBoundingClientRect();
    pointer.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(current.hoverables, true)[0];
    return hit ? rootWithHover(hit.object) : null;
  }
  const onMove = (e) => {
    const r = canvas.getBoundingClientRect();
    parallax.set((e.clientX - r.left) / r.width - 0.5, (e.clientY - r.top) / r.height - 0.5);
    const root = pick(e.clientX, e.clientY);
    if (root !== hovered) {
      setHighlight(hovered, false); hovered = root; setHighlight(hovered, true);
      canvas.style.cursor = hovered ? "pointer" : "";
      if (hovered) showTip(hovered.userData.hover, hovered, new THREE.Vector3()); else hideTip();
    }
  };
  const onLeave = () => { parallax.set(0, 0); setHighlight(hovered, false); hovered = null; canvas.style.cursor = ""; hideTip(); };
  const onClick = (e) => {
    const root = pick(e.clientX, e.clientY);
    focus = root && !root.userData.noHighlight ? { obj: root } : null;
    frameView();
    if (root) showTip(root.userData.hover, root, new THREE.Vector3()); else hideTip();
  };
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("click", onClick);

  let frameErr = false;
  function frame(now) {
    raf = 0;
    if (!canvas.isConnected) return;
    if (document.visibilityState === "visible") {
      resize();
      const dt = Math.min(0.05, (now - last) / 1000) * (reduceMotion ? 0.25 : 1); last = now;
      const t = Math.max(0, now - t0) / 1000 * (reduceMotion ? 0.25 : 1);
      if (current && !loading && loader.style.display !== "none") hideLoader();
      if (current) try {
        current.update(t, dt);
        frameView();
        smoothPar.lerp(parallax, 0.05);
        const right = new THREE.Vector3().crossVectors(camera.up, tmp.copy(camGoal).sub(lookGoal)).normalize();
        const goal = camGoal.clone().addScaledVector(right, -smoothPar.x * 0.35 + Math.sin(t * 0.08) * 0.06).addScaledVector(camera.up, smoothPar.y * 0.22);
        camera.position.lerp(goal, focus ? 0.06 : 0.04);
        look.lerp(lookGoal, 0.07); camera.lookAt(look);
        sunView.value.copy(SUN_DIR).transformDirection(camera.matrixWorldInverse);
        placeHotspots(); placeTip();
      } catch (err) { if (!frameErr) console.error("[missions 3D] frame error", err); frameErr = true; }
      renderer.render(scene, camera);
    } else last = now;
    raf = requestAnimationFrame(frame);
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };
  document.addEventListener("visibilitychange", kick);
  kick();

  return {
    async setMission(id) {
      if (id === missionId) return;
      missionId = id; const my = ++token;
      showLoader("<i></i>Loading NASA models…"); hideTip(); focus = null;
      let built;
      try { built = await (MISSIONS[id] || MISSIONS.crew13_iss)({ sunView, camera }); }
      catch (err) {
        console.error("[missions 3D] mission failed to build", err);
        if (my === token) { showLoader("3D view couldn't load. Check the console (F12) and try refreshing."); missionId = null; }
        return;
      }
      if (my !== token) { disposeGroup(built.group); return; }
      try {
        if (current) { scene.remove(current.group); disposeGroup(current.group); }
        hovered = null;
        current = built; scene.add(current.group);
        buildHotspots();
        frameView();
        // start further out and swing in, so each switch feels like an arrival
        camera.position.copy(camGoal).sub(lookGoal).multiplyScalar(1.45).add(lookGoal).add(new THREE.Vector3(0.8, 0.35, 0));
        look.copy(lookGoal);
      } catch (err) {
        console.error("[missions 3D] scene setup error (models still shown)", err);
      } finally {
        if (my === token) hideLoader();   // never leave the spinner over a built scene
        kick();
      }
    },
    dispose() {
      cancelAnimationFrame(raf); raf = 0; token++;
      ro.disconnect();
      canvas.removeEventListener("pointermove", onMove); canvas.removeEventListener("pointerleave", onLeave); canvas.removeEventListener("click", onClick);
      document.removeEventListener("visibilitychange", kick);
      hotEls.forEach((e) => e.el.remove()); tip.remove(); loader.remove();
      if (current) disposeGroup(current.group);
      env.dispose(); pmrem.dispose(); renderer.dispose();
    },
  };
}
