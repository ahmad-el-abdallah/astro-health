// Exercise coach: an astronaut in NASA's orange crew suit (NASA 3D Resources, free to use)
// demonstrating each ISS exercise on a model of the real machine, inside an ISS module.
// Plain three.js.
//
//   const coach = mountCoach(canvas, overlay, { onStep });
//   coach.setExercise("ared");  coach.setExercise(null);  // null = floating, waiting for a pick
//   coach.setPlaying(false);  coach.restart();  coach.dispose();
//
// The NASA suit model is a static mesh, so it is given a skeleton when it loads (buildAstronaut).
// Movement: the treadmill run and the idle float are motion capture (from the X Bot model,
// loaded invisibly and copied onto the astronaut bone by bone). Cycling, squats and stretches
// are posed every frame: hands and feet are placed where they must be (handlebars, pedals,
// bar, platform) with two-bone IK, and the machines are sized from the astronaut's real limb
// lengths so nothing passes through anything else.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

const MOTION_URL = "/models/exercise/xbot.glb";   // motion capture source only (never shown)

// ---------------------------------------------------------------- materials & helpers
const std = (o) => new THREE.MeshStandardMaterial(o);
function mesh(geo, mat, x = 0, y = 0, z = 0) { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; return m; }
function rod(a, b, r, mat) {               // cylinder from point a to point b
  const d = b.clone().sub(a), m = mesh(new THREE.CylinderGeometry(r, r, d.length(), 16), mat);
  m.position.copy(a).addScaledVector(d, 0.5); m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()); return m;
}
function setRod(m, a, b) {
  const d = b.clone().sub(a), len = Math.max(1e-4, d.length());
  m.position.copy(a).addScaledVector(d, 0.5); m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  m.scale.set(1, len / m.userData.len, 1);
}
function liveRod(r, mat) { const m = mesh(new THREE.CylinderGeometry(r, r, 1, 12), mat); m.userData.len = 1; return m; }
const lerp = THREE.MathUtils.lerp, clamp = THREE.MathUtils.clamp;
const ease = (t) => t * t * (3 - 2 * t);
const easeIO = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const V = (x, y, z) => new THREE.Vector3(x, y, z);

function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement("canvas"); c.width = w; c.height = h; draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c); if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
// Belt texture for the treadmill (scrolls while running).
const beltTex = () => {
  const t = canvasTex(64, 256, (g) => { g.fillStyle = "#1b2129"; g.fillRect(0, 0, 64, 256); g.fillStyle = "#2a323d"; for (let y = 0; y < 256; y += 16) g.fillRect(0, y, 64, 6); });
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1, 4); return t;
};
// ---------------------------------------------------------------- the rig
// Turns "point this bone along that direction" into bone rotations.
const CHAIN = {
  Hips: "Spine", Spine: "Spine1", Spine1: "Spine2", Spine2: "Neck", Neck: "Head",
  LeftArm: "LeftForeArm", LeftForeArm: "LeftHand", RightArm: "RightForeArm", RightForeArm: "RightHand",
  LeftUpLeg: "LeftLeg", LeftLeg: "LeftFoot", LeftFoot: "LeftToeBase", RightUpLeg: "RightLeg", RightLeg: "RightFoot", RightFoot: "RightToeBase",
  LeftHand: "LeftHandMiddle1", RightHand: "RightHandMiddle1",
};
const short = (name) => name.replace(/^mixamorig:?/, "");
function makeRig(root) {
  const bones = {};
  root.traverse((o) => { if (o.isBone) bones[short(o.name)] = o; });
  const rest = {};
  Object.entries(bones).forEach(([n, b]) => { rest[n] = { q: b.quaternion.clone(), p: b.position.clone() }; });
  const tq = new THREE.Quaternion(), tq2 = new THREE.Quaternion(), tv = new THREE.Vector3(), tv2 = new THREE.Vector3(), dq = new THREE.Quaternion();
  root.updateMatrixWorld(true);
  const wp = (n) => bones[n].getWorldPosition(new THREE.Vector3());
  const len = {
    thigh: wp("LeftUpLeg").distanceTo(wp("LeftLeg")), shin: wp("LeftLeg").distanceTo(wp("LeftFoot")),
    upper: wp("LeftArm").distanceTo(wp("LeftForeArm")), fore: wp("LeftForeArm").distanceTo(wp("LeftHand")),
  };
  return {
    bones, len,
    reset() { Object.entries(bones).forEach(([n, b]) => { b.quaternion.copy(rest[n].q); b.position.copy(rest[n].p); }); root.updateMatrixWorld(true); },
    // Rotate bone `n` (from its rest pose) so the bone points along world direction `dir`.
    aim(n, dir) {
      const b = bones[n], child = bones[CHAIN[n]];
      if (!b || !child) return;
      b.quaternion.copy(rest[n].q);
      b.parent.getWorldQuaternion(tq);
      tq2.copy(tq).multiply(rest[n].q);
      tv.copy(rest[CHAIN[n]].p).normalize().applyQuaternion(tq2);
      tv2.copy(dir).normalize();
      dq.setFromUnitVectors(tv, tv2);
      tq2.premultiply(dq);
      b.quaternion.copy(tq.invert().multiply(tq2));
      b.updateMatrixWorld(true);
    },
    pos: wp,
  };
}

// Point an arm along `dir`; the shoulder (collarbone) takes a share of the lift so the
// suit's shoulder doesn't crush. elbowDir (optional) bends the forearm.
function aimArm(rig, side, dir, foreDir, share = 0.3) {
  const sh = rig.pos(side + "Arm").sub(rig.pos(side + "Shoulder")).normalize();
  const up = Math.max(0, dir.clone().normalize().y + 0.2);                  // more shrug the higher the arm
  rig.aim(side + "Shoulder", sh.lerp(dir.clone().normalize(), share * up).normalize());
  rig.aim(side + "Arm", dir);
  if (foreDir) rig.aim(side + "ForeArm", foreDir);
}

// IK an arm to a hand target, letting the shoulder share the lift first.
function reachArm(rig, side, hand, pole, share = 0.3) {
  const dir = hand.clone().sub(rig.pos(side + "Arm"));
  const sh = rig.pos(side + "Arm").sub(rig.pos(side + "Shoulder")).normalize();
  rig.aim(side + "Shoulder", sh.lerp(dir.normalize(), share * Math.max(0, dir.y + 0.2)).normalize());
  reach(rig, side + "Arm", side + "ForeArm", hand, rig.len.upper, rig.len.fore, pole);
}

// Two-bone IK: from joint A (hip/shoulder) reach target T with lengths l1, l2; the middle
// joint bends toward `pole`. Returns the middle joint's world position.
function ik(A, T, l1, l2, pole) {
  const d = T.clone().sub(A); let dist = d.length();
  dist = clamp(dist, Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);
  const u = d.normalize();
  const cosA = (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), a = Math.acos(clamp(cosA, -1, 1));
  const side = pole.clone().sub(u.clone().multiplyScalar(pole.dot(u))).normalize();
  return A.clone().add(u.clone().multiplyScalar(Math.cos(a) * l1)).add(side.multiplyScalar(Math.sin(a) * l1));
}
// Place a limb (UpLeg/Leg or Arm/ForeArm) so its end lands on `target`.
function reach(rig, upper, lower, target, l1, l2, pole) {
  const root = rig.pos(upper), mid = ik(root, target, l1, l2, pole);
  rig.aim(upper, mid.clone().sub(root)); rig.aim(lower, target.clone().sub(rig.pos(lower)));
}

// ---------------------------------------------------------------- the astronaut
// NASA's "Advanced Crew Escape Suit" model (NASA 3D Resources) -- the orange suit crews wear
// inside the spacecraft -- is a static mesh. We give it a skeleton here: joints at measured
// positions (metres, model scaled to 1.8 m, feet on y=0, turned to face +z, +x = the
// astronaut's left), then every vertex is weighted to the nearby bones. Helmet -> head
// (rigid), arms and legs blend along their bones.
const JOINTS = {
  Hips: [null, [0, 0.86, -0.08]], Spine: ["Hips", [0, 0.98, -0.08]], Spine1: ["Spine", [0, 1.12, -0.08]], Spine2: ["Spine1", [0, 1.26, -0.09]],
  Neck: ["Spine2", [0, 1.42, -0.08]], Head: ["Neck", [0, 1.5, -0.06]], HeadTop_End: ["Head", [0, 1.8, -0.06]],
};
["Left", "Right"].forEach((side, i) => {
  const s = i ? -1 : 1, P = (x, y, z) => [s * x, y, z];
  Object.assign(JOINTS, {
    [side + "Shoulder"]: ["Spine2", P(0.08, 1.38, -0.09)], [side + "Arm"]: [side + "Shoulder", P(0.27, 1.37, -0.09)],
    [side + "ForeArm"]: [side + "Arm", P(0.33, 1.1, -0.04)], [side + "Hand"]: [side + "ForeArm", P(0.33, 0.98, 0.11)],
    [side + "HandMiddle1"]: [side + "Hand", P(0.33, 0.9, 0.22)],
    [side + "UpLeg"]: ["Hips", P(0.11, 0.8, -0.06)], [side + "Leg"]: [side + "UpLeg", P(0.14, 0.46, -0.04)],
    [side + "Foot"]: [side + "Leg", P(0.15, 0.12, -0.05)], [side + "ToeBase"]: [side + "Foot", P(0.15, 0.03, 0.12)],
    [side + "Toe_End"]: [side + "ToeBase", P(0.15, 0.02, 0.22)],
  });
});
CHAIN.LeftShoulder = "LeftArm"; CHAIN.RightShoulder = "RightArm"; CHAIN.Head = "HeadTop_End"; CHAIN.LeftToeBase = "LeftToe_End"; CHAIN.RightToeBase = "RightToe_End";

function segDist(p, a, b) {
  const ab = b.clone().sub(a), t = clamp(p.clone().sub(a).dot(ab) / Math.max(1e-6, ab.lengthSq()), 0, 1);
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}
// The model's materials are glass-like (transmission), which draws black here: rebuild them.
function suitMaterial(m) {
  const c = m.color.clone(), hex = c.getHexString();
  if (/lambert3S/.test(m.name)) return new THREE.MeshStandardMaterial({ color: "#26324a", roughness: 0.7 });                       // gloves
  if (hex === "000000") return new THREE.MeshPhysicalMaterial({ color: "#05070a", metalness: 0.3, roughness: 0.04, clearcoat: 1, envMapIntensity: 1.6 });   // visor
  const hsl = {}; c.getHSL(hsl);
  if (hsl.s > 0.4 && hsl.h < 0.1 && hsl.l > 0.2) c.set("#e2531a");   // "international orange", like the real suit
  const glossy = /aceshelme/.test(m.name) && hsl.l > 0.6;                             // white helmet shell
  return glossy ? new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.1 })
    : new THREE.MeshStandardMaterial({ color: c, roughness: 0.78, metalness: 0 });
}
function buildAstronaut(gltf) {
  const src = gltf.scene; src.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(src), k = 1.8 / (box.max.y - box.min.y);
  const norm = new THREE.Matrix4().makeRotationY(Math.PI).multiply(new THREE.Matrix4().makeScale(k, k, k))   // turn to face +z
    .multiply(new THREE.Matrix4().makeTranslation(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2));
  const root = new THREE.Group();
  const bones = {}, world = {};
  Object.entries(JOINTS).forEach(([n, [, p]]) => { bones[n] = new THREE.Bone(); bones[n].name = n; world[n] = V(...p); });
  Object.entries(JOINTS).forEach(([n, [parent]]) => {
    const b = bones[n];
    if (parent) { bones[parent].add(b); b.position.copy(world[n]).sub(world[parent]); } else { root.add(b); b.position.copy(world[n]); }
  });
  root.updateMatrixWorld(true);
  const list = Object.keys(JOINTS), index = Object.fromEntries(list.map((n, i) => [n, i]));
  const skeleton = new THREE.Skeleton(list.map((n) => bones[n]));
  const seg = (n) => [world[n], world[CHAIN[n]] || world[n]];
  // Which bones may move each vertex. Arm bones only take vertices that are really on the
  // sleeve (close to the arm's axis), so the back, chest and shoulder blades never tear.
  const armDist = (v, side) => Math.min(...["Arm", "ForeArm", "Hand"].map((b) => segDist(v, ...seg(side + b))));
  function candidates(v, part) {
    const side = v.x >= 0 ? "Left" : "Right", ax = Math.abs(v.x);
    if (part === "hand") return [[side + "ForeArm"], [side + "Hand"]];                           // gloves
    if (v.y > 1.5 && ax < 0.2) return [["Head", 1]];                                                // helmet: rigid
    if (v.y > 1.43 && ax < 0.2) return [["Neck"], ["Head"], ["Spine2"]];                            // collar
    const dArm = armDist(v, side);
    if (ax > 0.2 && v.y > 0.84 && dArm < 0.12) {
      const nearShoulder = v.distanceTo(world[side + "Arm"]) < 0.14;
      return nearShoulder ? (ax > 0.25 ? [[side + "Shoulder"], [side + "Arm"]] : [[side + "Shoulder"], [side + "Arm"], ["Spine2"]]) : [[side + "Arm"], [side + "ForeArm"], [side + "Hand"]];
    }
    if (v.y < 0.76) return [[side + "UpLeg"], [side + "Leg"], [side + "Foot"], [side + "ToeBase"]].concat(v.y > 0.62 ? [["Hips"]] : []);
    return [["Hips"], ["Spine"], ["Spine1"], ["Spine2"], ["Neck"]].concat(v.y < 0.95 ? [[side + "UpLeg"]] : []).concat(v.y > 1.28 && ax > 0.12 ? [[side + "Shoulder"]] : []);
  }
  const meshes = [];
  src.traverse((o) => {
    if (!o.isMesh) return;
    let geo = o.geometry.clone(); geo.applyMatrix4(o.matrixWorld.clone().premultiply(norm));
    if (/lambert4S|shoe_lamb\.005/.test(o.material.name) && geo.index) {
      // loose white cords hang between the hands and the body; skinned to both they would stretch
      const P0 = geo.attributes.position, idx = geo.index.array, keep = [], t = new THREE.Vector3();
      const loose = (i) => { t.fromBufferAttribute(P0, i); const ax = Math.abs(t.x); return ax > 0.17 && ax < 0.42 && t.y > 0.8 && t.y < 1.32 && t.z > -0.02; };
      for (let f = 0; f < idx.length; f += 3) if (!loose(idx[f]) && !loose(idx[f + 1]) && !loose(idx[f + 2])) keep.push(idx[f], idx[f + 1], idx[f + 2]);
      geo.setIndex(keep);
    }
    const part = /lambert3S/.test(o.material.name) ? "hand" : "";
    const pos = geo.attributes.position, n = pos.count, si = new Uint16Array(n * 4), sw = new Float32Array(n * 4), v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, i);
      const cands = candidates(v, part).map(([b, fixed]) => {
        if (fixed) return [b, 1];
        const [a, c] = seg(b); const d = Math.max(0.012, segDist(v, a, c)); return [b, 1 / Math.pow(d, 4)];
      }).sort((x, y) => y[1] - x[1]).slice(0, 4);
      const tot = cands.reduce((s2, c) => s2 + c[1], 0);
      cands.forEach(([b, w], j) => { si[i * 4 + j] = index[b]; sw[i * 4 + j] = w / tot; });
    }
    geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(si, 4));
    geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(sw, 4));
    geo.setAttribute("aFocus", new THREE.BufferAttribute(new Float32Array(n), 1));
    const mat = suitMaterial(o.material);
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, focusUniforms);
      sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nattribute float aFocus;\nvarying float vFocus;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvFocus = aFocus;");
      sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nuniform vec3 uFocusColor;\nuniform float uPulse;\nvarying float vFocus;")
        .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += uFocusColor * vFocus * uPulse;");
    };
    const sm = new THREE.SkinnedMesh(geo, mat);
    sm.castShadow = true; sm.receiveShadow = true; sm.frustumCulled = false;
    root.add(sm); sm.bind(skeleton); meshes.push(sm);
  });
  return {
    root,
    setFocus(names) {
      const want = new Set(names.map((x) => index[x]).filter((x) => x != null));
      meshes.forEach((m) => {
        const si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight, f = m.geometry.attributes.aFocus;
        for (let i = 0; i < si.count; i++) { let w = 0; for (let j = 0; j < 4; j++) if (want.has(si.getComponent(i, j))) w += sw.getComponent(i, j); f.setX(i, w); }
        f.needsUpdate = true;
      });
    },
  };
}
const focusUniforms = { uFocusColor: { value: new THREE.Color("#ff5a1f") }, uPulse: { value: 0 } };

// Motion capture from the X Bot (kept invisible) is copied onto the astronaut bone by bone:
// each astronaut bone is pointed the way the X Bot's bone points this frame. Arms get a
// little extra spread so they clear the bulky suit.
const FOLLOW = ["Hips", "Spine", "Spine1", "Spine2", "Neck", "Head",
  "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand", "RightShoulder", "RightArm", "RightForeArm", "RightHand",
  "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase", "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase"];
function follow(rig, src, ch, spread = 0.32) {
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  const sh = src.bones.Hips.getWorldPosition(new THREE.Vector3()); ch.worldToLocal(sh);
  rig.bones.Hips.position.set(sh.x * 0.85, sh.y * (0.86 / 1.04), sh.z * 0.85 - 0.08);
  rig.bones.Hips.updateMatrixWorld(true);
  FOLLOW.forEach((n) => {
    const sb = src.bones[n], sc = src.bones[CHAIN[n] === "HeadTop_End" ? "HeadTop_End" : CHAIN[n]];
    if (!sb || !sc || n === "LeftShoulder" || n === "RightShoulder") return;
    sb.getWorldPosition(a); sc.getWorldPosition(b);
    const dir = b.sub(a);
    if (/Arm$/.test(n)) {
      // keep the arms in a natural swing beside the body: no forearm across the chest
      const s = n.startsWith("Left") ? 1 : -1, cq = ch.getWorldQuaternion(new THREE.Quaternion());
      const local = dir.normalize().applyQuaternion(cq.clone().invert());
      if (n.endsWith("ForeArm")) {
        local.x = s * Math.max(s * local.x, spread * 0.6);           // never inward past the body
        local.z = Math.max(local.z, 0.15);                           // forearms point forward-ish
        local.y = Math.min(local.y, 0.15);
      } else {
        local.lerp(V(0, -1, 0), 0.35);                               // calmer upper-arm swing
        local.x = s * Math.max(s * local.x, spread);
      }
      dir.copy(local.normalize().applyQuaternion(cq));
    }
    rig.aim(n, dir);
  });
  ["Left", "Right"].forEach((side) => {                              // relaxed hands in line with the forearm
    const f = rig.pos(side + "Hand").sub(rig.pos(side + "ForeArm"));
    rig.aim(side + "Hand", f.add(V(0, -0.3, 0).applyQuaternion(ch.getWorldQuaternion(new THREE.Quaternion()))));
  });
}

// ---------------------------------------------------------------- machine parts
// Machines are modelled after NASA photos of the real ISS hardware (T2, CEVIS, ARED).
const MAT = {
  shell: () => std({ color: "#e6e9ee", metalness: 0.15, roughness: 0.45 }),
  grey: () => std({ color: "#9aa3ae", metalness: 0.55, roughness: 0.35 }),
  dark: () => std({ color: "#2a3038", metalness: 0.45, roughness: 0.55 }),
  black: () => std({ color: "#15181d", metalness: 0.2, roughness: 0.75 }),
  chrome: () => std({ color: "#eef2f6", metalness: 1, roughness: 0.12 }),
  blue: () => std({ color: "#2f5fb3", metalness: 0.3, roughness: 0.45 }),
  strap: () => std({ color: "#2d5bd0", metalness: 0, roughness: 0.75 }),
  cord: () => std({ color: "#f2f4f7", metalness: 0, roughness: 0.55 }),
  foam: () => std({ color: "#30363f", metalness: 0, roughness: 0.92 }),
  rubber: () => std({ color: "#3a414b", metalness: 0, roughness: 0.95 }),
  accent: () => std({ color: "#4fd1c5", emissive: "#4fd1c5", emissiveIntensity: 0.7, roughness: 0.4 }),
};
const rbox = (w, h, d, r, mat, x = 0, y = 0, z = 0) => mesh(new RoundedBoxGeometry(w, h, d, 3, Math.min(r, w / 2, h / 2, d / 2) * 0.999), mat, x, y, z);
const cyl = (r, h, mat, x = 0, y = 0, z = 0, seg = 32) => mesh(new THREE.CylinderGeometry(r, r, h, seg), mat, x, y, z);
// a small device screen with a live-looking readout
function screenTex(title, rows, accent = "#4fd1c5") {
  return canvasTex(512, 300, (g, w, h) => {
    g.fillStyle = "#07121d"; g.fillRect(0, 0, w, h);
    g.fillStyle = accent; g.fillRect(0, 0, w, 46);
    g.fillStyle = "#04121a"; g.font = "bold 28px sans-serif"; g.fillText(title, 18, 33);
    rows.forEach(([k, v], i) => {
      g.fillStyle = "#7f97b3"; g.font = "22px sans-serif"; g.fillText(k, 22, 100 + i * 66);
      g.fillStyle = "#e9f6ff"; g.font = "bold 44px sans-serif"; g.fillText(v, 230, 106 + i * 66);
    });
  });
}
function screen(w, h, title, rows, accent) {
  const g = new THREE.Group();
  g.add(rbox(w + 0.04, h + 0.04, 0.035, 0.012, MAT.dark()));
  const s = mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: screenTex(title, rows, accent), emissive: "#ffffff", emissiveMap: screenTex(title, rows, accent), emissiveIntensity: 0.7, roughness: 0.3 }), 0, 0, 0.019);
  s.castShadow = false; g.add(s); return g;
}
// a printed label plate, like the NASA hardware IDs
function label(text, w = 0.3, h = 0.06, bg = "#e6e9ee", fg = "#1c2430") {
  const t = canvasTex(512, Math.round(512 * h / w), (g, W, H) => { g.fillStyle = bg; g.fillRect(0, 0, W, H); g.fillStyle = fg; g.font = `bold ${Math.round(H * 0.62)}px sans-serif`; g.textBaseline = "middle"; g.fillText(text, H * 0.3, H / 2); });
  const m = mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: t, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2 })); m.castShadow = false; return m;
}
// waist belt sized for the crew suit, with side clips (T2 harness, CEVIS strap)
function waistBelt(rig) {
  const g = new THREE.Group();
  const belt = mesh(new THREE.TorusGeometry(1, 0.028, 10, 48), MAT.strap()); belt.rotation.x = Math.PI / 2; belt.scale.set(0.27, 0.22, 1); g.add(belt);
  const buckle = rbox(0.08, 0.06, 0.03, 0.01, MAT.chrome(), 0, 0, 0.22); g.add(buckle);
  const clips = [-1, 1].map((s) => { const c = rbox(0.04, 0.07, 0.06, 0.01, MAT.grey(), s * 0.275, 0, 0); g.add(c); return c; });
  g.position.set(0, 0.04, 0);
  rig.bones.Hips.add(g);
  return { group: g, clips };
}

// ---------------------------------------------------------------- exercises
// Each: build(group, rig, ch, motion) -> { update(t, dt), focus: [bones], cleanup() }
// The astronaut faces +z; +x is their left. Metres.
const EXERCISES = {
  // T2 / COLBERT treadmill. The runner wears a harness; bungees from the Subject Loading
  // System units on each side pull them down onto the belt so they don't float away.
  t2(group, rig, ch, motion) {
    const g = new THREE.Group(); group.add(g);
    const belt = beltTex();
    g.add(rbox(1.0, 0.14, 2.1, 0.03, MAT.shell(), 0, 0.07, 0));
    g.add(mesh(new THREE.BoxGeometry(0.7, 0.016, 1.92), std({ map: belt, roughness: 0.92 }), 0, 0.148, 0));
    [-0.97, 0.97].forEach((z) => { const r = cyl(0.05, 0.72, MAT.grey(), 0, 0.12, z); r.rotation.z = Math.PI / 2; g.add(r); });
    [-1, 1].forEach((s) => {
      g.add(rbox(0.13, 0.07, 2.12, 0.02, MAT.grey(), s * 0.44, 0.17, 0));                      // side rails
      const sls = rbox(0.18, 0.24, 0.42, 0.04, MAT.blue(), s * 0.62, 0.12, -0.25); g.add(sls);  // subject loading units
      const pl = label("SLS", 0.12, 0.05, "#2f5fb3", "#ffffff"); pl.position.set(s * 0.711, 0.15, -0.25); pl.rotation.y = s * Math.PI / 2; g.add(pl);
    });
    const id = label("T2  COLBERT", 0.42, 0.07); id.position.set(0.501, 0.075, 0.55); id.rotation.y = Math.PI / 2; g.add(id);
    // front mast, handrail and control panel
    g.add(rbox(0.12, 1.1, 0.1, 0.03, MAT.shell(), 0, 0.65, 1.0));
    g.add(rod(V(-0.42, 1.08, 0.92), V(0.42, 1.08, 0.92), 0.022, MAT.grey()));
    [-1, 1].forEach((s) => { g.add(rod(V(s * 0.42, 1.08, 0.92), V(s * 0.42, 1.08, 0.7), 0.022, MAT.grey())); g.add(cyl(0.03, 0.14, MAT.foam(), s * 0.42, 1.08, 0.76).rotateX(Math.PI / 2)); });
    g.add(rod(V(-0.42, 1.08, 0.92), V(0, 1.08, 1.0), 0.02, MAT.grey())); g.add(rod(V(0.42, 1.08, 0.92), V(0, 1.08, 1.0), 0.02, MAT.grey()));
    const panel = screen(0.36, 0.22, "T2 TREADMILL", [["SPEED", "8.0 km/h"], ["LOAD", "70 %"], ["TIME", "12:30"]]);
    panel.position.set(0, 1.3, 1.0); panel.rotation.set(-0.35, Math.PI, 0); g.add(panel);
    const harness = waistBelt(rig);
    const bungees = [liveRod(0.011, MAT.cord()), liveRod(0.011, MAT.cord())]; bungees.forEach((b) => g.add(b));
    const anchors = [V(-0.62, 0.25, -0.12), V(0.62, 0.25, -0.12)];
    ch.position.set(0, 0.155, 0.05);
    const tmp = new THREE.Vector3(), q = new THREE.Quaternion(), deckY = 0.155;
    const ankleRest = rig.pos("LeftFoot").y - ch.position.y;
    return {
      focus: ["LeftUpLeg", "RightUpLeg", "LeftLeg", "RightLeg"],
      // A hand-made running cycle (~150 steps/min, slowed a little to follow): legs stride and
      // fold in the swing, arms swing opposite with bent elbows, body bobs and leans forward.
      update(t, dt) {
        belt.offset.y -= dt * 1.6;
        const w = t * 2 * Math.PI * 1.15;
        rig.reset();
        group.getWorldQuaternion(q); const W = (v) => v.clone().applyQuaternion(q);
        const lean = 0.14, twist = Math.sin(w) * 0.12;
        rig.bones.Hips.rotateY(-twist * 0.6);
        rig.aim("Spine", W(V(0, Math.cos(lean), Math.sin(lean)))); rig.bones.Spine.rotateY(twist * 0.5);
        rig.aim("Spine1", W(V(0, Math.cos(lean), Math.sin(lean)))); rig.aim("Spine2", W(V(0, Math.cos(lean * 0.8), Math.sin(lean * 0.8))));
        rig.bones.Spine2.rotateY(twist * 0.6); rig.bones.Spine2.updateMatrixWorld(true);
        rig.aim("Neck", W(V(0, 1, 0.05))); rig.aim("Head", W(V(0, 1, 0.1)));
        ["Left", "Right"].forEach((side, i) => {
          const s = i ? -1 : 1, ph = w + i * Math.PI;
          const hip = 0.12 + 0.5 * Math.sin(ph);                            // thigh forward (+) / back (-)
          const swing = Math.max(0, Math.cos(ph - 0.5));                    // leg coming forward: knee folds
          const knee = 0.12 + 1.35 * Math.pow(swing, 2.2);
          rig.aim(side + "UpLeg", W(V(s * 0.04, -Math.cos(hip), Math.sin(hip))));
          rig.aim(side + "Leg", W(V(s * 0.02, -Math.cos(hip - knee), Math.sin(hip - knee))));
          const toe = 0.15 + 0.5 * swing;                                    // toes point down in the swing
          rig.aim(side + "Foot", W(V(0, -0.2 - toe, 1)));
          // arms: opposite to the same-side leg, elbows bent ~80 degrees
          const arm = -0.55 * Math.sin(ph);
          const upper = W(V(s * 0.28, -Math.cos(arm), Math.sin(arm)));
          const fore = W(V(s * 0.12, -Math.cos(arm + 1.4), Math.sin(arm + 1.4)));
          aimArm(rig, side, upper, fore, 0.12);
          rig.aim(side + "Hand", fore.clone().add(W(V(-s * 0.1, -0.2, 0))));
        });
        // keep the lower foot on the belt (the body rises and falls naturally with the stride)
        group.updateMatrixWorld(true);
        const lowest = Math.min(group.worldToLocal(rig.pos("LeftFoot")).y, group.worldToLocal(rig.pos("RightFoot")).y);
        ch.position.y += deckY + ankleRest - lowest; ch.updateMatrixWorld(true);
        bungees.forEach((b, i) => { harness.clips[i].getWorldPosition(tmp); group.worldToLocal(tmp); setRod(b, anchors[i], tmp); });
      },
      cleanup() { rig.bones.Hips.remove(harness.group); },
    };
  },

  // CEVIS cycle ergometer: no seat. Shoes clip into the pedals, a belt holds the rider down,
  // hands on the handrail. The crank is placed from the leg length so the knee never over-bends.
  cevis(group, rig, ch) {
    const g = new THREE.Group(); group.add(g);
    const L = rig.len.thigh + rig.len.shin, crankR = 0.13;
    const hipW = V(0, 0.98, -0.08), crankC = V(0, 0, 0.2);
    const hipJointY = hipW.y - (rig.pos("Hips").y - rig.pos("LeftUpLeg").y), dz = crankC.z - hipW.z - 0.06;
    crankC.y = hipJointY - Math.sqrt(Math.max(0.01, (L * 0.95) ** 2 - dz * dz)) + crankR - 0.1;
    g.add(rbox(0.7, 0.04, 1.2, 0.015, MAT.grey(), 0, 0.02, 0.2));                                  // floor plate
    // flywheel housing: the grey box with the crank through it
    const hh = crankC.y + 0.12;
    g.add(rbox(0.16, hh, 0.52, 0.04, MAT.shell(), 0, hh / 2 + 0.04, crankC.z + 0.06));
    [-1, 1].forEach((s) => {
      const disc = cyl(0.17, 0.012, MAT.grey(), s * 0.083, crankC.y, crankC.z + 0.06, 48); disc.rotation.z = Math.PI / 2; g.add(disc);
      const ring = mesh(new THREE.TorusGeometry(0.17, 0.008, 8, 48), MAT.accent(), s * 0.09, crankC.y, crankC.z + 0.06); ring.rotation.y = Math.PI / 2; g.add(ring);
      const lb = label("CEVIS", 0.14, 0.045); lb.position.set(s * 0.0815, crankC.y - 0.2, crankC.z + 0.17); lb.rotation.y = s * Math.PI / 2; g.add(lb);
      // belt straps from the rider's belt clips down to floor anchors behind
      g.add(rbox(0.06, 0.03, 0.06, 0.01, MAT.dark(), s * 0.28, 0.055, -0.55));
    });
    const crank = new THREE.Group(); crank.position.copy(crankC); g.add(crank);
    const arms = [0, 1].map(() => rbox(0.025, crankR + 0.03, 0.035, 0.01, MAT.dark()));
    const pedals = [0, 1].map(() => { const p = new THREE.Group(); p.add(rbox(0.1, 0.025, 0.12, 0.008, MAT.black())); const toe = mesh(new THREE.TorusGeometry(0.05, 0.01, 6, 20, Math.PI), MAT.strap(), 0, 0.01, 0.03); p.add(toe); return p; });
    arms.forEach((a) => crank.add(a)); pedals.forEach((p) => crank.add(p));
    // console stalk + handrail in front of the rider
    const barH = hipW.y + 0.26, barZ = 0.5;
    g.add(rbox(0.06, barH - 0.04, 0.06, 0.02, MAT.grey(), 0, (barH - 0.04) / 2 + 0.04, 0.72));
    g.add(rod(V(0, barH - 0.02, 0.72), V(0, barH, barZ), 0.022, MAT.grey()));
    g.add(rod(V(-0.3, barH, barZ), V(0.3, barH, barZ), 0.02, MAT.grey()));
    [-0.3, 0.3].forEach((x) => g.add(cyl(0.028, 0.12, MAT.foam(), x, barH, barZ).rotateZ(Math.PI / 2)));
    const panel = screen(0.26, 0.16, "CEVIS", [["CADENCE", "60 rpm"], ["POWER", "125 W"], ["HR", "128"]]);
    panel.position.set(0, barH + 0.17, 0.72); panel.rotation.set(-0.3, Math.PI, 0); g.add(panel);
    const strap = waistBelt(rig);
    const straps = [liveRod(0.012, MAT.strap()), liveRod(0.012, MAT.strap())]; straps.forEach((x) => g.add(x));
    ch.position.set(0, 0, 0);
    const q = new THREE.Quaternion(), tmp = new THREE.Vector3();
    return {
      focus: ["LeftUpLeg", "RightUpLeg", "LeftLeg", "RightLeg"],
      update(t) {
        const a = t * 4.2;                                   // ~40 rpm, easy to follow
        rig.reset();
        group.getWorldQuaternion(q); const W = (v) => v.clone().applyQuaternion(q);
        const bob = Math.sin(a * 2) * 0.006, sway = Math.sin(a) * 0.02;
        rig.bones.Hips.position.copy(rig.bones.Hips.parent.worldToLocal(group.localToWorld(hipW.clone().add(V(0, bob, 0)))));
        rig.aim("Hips", W(V(0, 1, 0.1)));
        rig.aim("Spine", W(V(sway * 0.5, 0.95, 0.22))); rig.aim("Spine1", W(V(sway, 0.93, 0.3))); rig.aim("Spine2", W(V(sway, 0.93, 0.32)));
        rig.aim("Neck", W(V(0, 0.97, 0.2))); rig.aim("Head", W(V(0, 1, 0.06)));
        [1, -1].forEach((s, i) => {
          const ang = a + i * Math.PI, side = s > 0 ? "Left" : "Right";
          const py = Math.sin(ang) * crankR, pz = Math.cos(ang) * crankR;
          arms[i].position.set(s * 0.1, py / 2, pz / 2); arms[i].rotation.x = -ang + Math.PI / 2;
          pedals[i].position.set(s * 0.16, py, pz);
          const ankle = group.localToWorld(V(s * 0.16, crankC.y + py + 0.1, crankC.z + pz - 0.06));
          reach(rig, side + "UpLeg", side + "Leg", ankle, rig.len.thigh, rig.len.shin, W(V(s * 0.2, 0.35, 1)));
          rig.aim(side + "Foot", W(V(0, -0.4 - 0.2 * Math.max(0, -Math.sin(ang)), 1)));
          const hand = group.localToWorld(V(s * 0.3, barH, barZ - 0.02));
          reachArm(rig, side, hand, W(V(s * 1, -0.7, -0.2)), 0.25);
          rig.aim(side + "Hand", W(V(s * 0.2, -0.1, 1)));
        });
        group.updateMatrixWorld(true);
        straps.forEach((x, i) => { strap.clips[i].getWorldPosition(tmp); group.worldToLocal(tmp); setRod(x, tmp, V(i ? 0.28 : -0.28, 0.07, -0.55)); });
      },
      cleanup() { rig.bones.Hips.remove(strap.group); },
    };
  },

  // ARED squat: the bar rests across the upper back; a lever arm links it to two vacuum
  // cylinders behind the platform that supply up to ~270 kg of load.
  ared(group, rig, ch) {
    const g = new THREE.Group(); group.add(g);
    g.add(rbox(1.5, 0.1, 1.5, 0.03, MAT.shell(), 0, 0.05, -0.15));
    g.add(rbox(0.8, 0.012, 0.55, 0.005, MAT.rubber(), 0, 0.104, 0.02));
    const back = -0.78, pivot = V(0, 0.42, back);
    // base housing with the two vacuum cylinders and their flywheels
    g.add(rbox(1.0, 0.36, 0.42, 0.05, MAT.shell(), 0, 0.28, back));
    [-0.3, 0.3].forEach((x) => { g.add(cyl(0.13, 0.62, MAT.chrome(), x, 0.48, back - 0.05)); g.add(cyl(0.135, 0.05, MAT.accent(), x, 0.8, back - 0.05)); });
    const wheels = [-1, 1].map((s) => { const w = cyl(0.2, 0.04, MAT.dark(), s * 0.56, pivot.y, pivot.z, 48); w.rotation.z = Math.PI / 2; g.add(w); return w; });
    const axle = cyl(0.03, 1.2, MAT.grey(), 0, pivot.y, pivot.z); axle.rotation.z = Math.PI / 2; g.add(axle);
    const lb = label("ARED", 0.22, 0.07); lb.position.set(0, 0.3, back + 0.211); g.add(lb);
    // two lever arms outside the body, from the axle to the bar ends
    const levers = [0, 1].map(() => { const l = mesh(new THREE.BoxGeometry(0.07, 1, 0.07), MAT.grey()); l.userData.len = 1; g.add(l); return l; });
    const bar = cyl(0.018, 1.3, MAT.chrome()); bar.rotation.z = Math.PI / 2; g.add(bar);
    [-0.58, 0.58].forEach((x) => bar.add(cyl(0.035, 0.06, MAT.dark(), 0, x, 0)));
    const pad = cyl(0.045, 0.36, MAT.foam()); pad.rotation.z = Math.PI / 2; g.add(pad);
    const panel = screen(0.22, 0.14, "ARED", [["LOAD", "120 kg"], ["SET", "2 / 3"], ["REPS", "6"]]);
    panel.position.set(0.62, 0.95, back + 0.05); panel.rotation.y = -0.5; g.add(panel);
    g.add(rbox(0.05, 0.85, 0.05, 0.015, MAT.grey(), 0.62, 0.45, back + 0.02));
    ch.position.set(0, 0.11, 0.02);
    let reps = 0, down = false, anchor = null;
    const q = new THREE.Quaternion();
    return {
      focus: ["LeftUpLeg", "RightUpLeg", "Hips", "LeftLeg", "RightLeg"],
      reps: () => reps,
      update(t) {
        const cyc = (t % 4) / 4;                           // ~1.6 s down, pause, ~1.6 s up, pause
        const k = cyc < 0.4 ? easeIO(cyc / 0.4) : cyc < 0.5 ? 1 : cyc < 0.9 ? 1 - easeIO((cyc - 0.5) / 0.4) : 0;
        if (k > 0.97 && !down) down = true; if (k < 0.03 && down) { down = false; reps++; }
        rig.reset();
        group.getWorldQuaternion(q); const W = (v) => v.clone().applyQuaternion(q);
        const hipFlex = k * 1.4, kneeBend = k * 0.85, lean = k * 0.55;
        rig.aim("Hips", W(V(0, Math.cos(lean * 0.7), Math.sin(lean * 0.7))));
        rig.aim("Spine", W(V(0, Math.cos(lean), Math.sin(lean))));
        rig.aim("Spine1", W(V(0, Math.cos(lean * 0.95), Math.sin(lean * 0.95))));
        rig.aim("Spine2", W(V(0, Math.cos(lean * 0.9), Math.sin(lean * 0.9))));
        rig.aim("Neck", W(V(0, Math.cos(lean * 0.45), Math.sin(lean * 0.45)))); rig.aim("Head", W(V(0, 1, 0.12)));
        ["Left", "Right"].forEach((side, i) => {
          const s = i ? -1 : 1;
          rig.aim(side + "UpLeg", W(V(s * (0.1 + k * 0.18), -Math.cos(hipFlex), Math.sin(hipFlex))));
          rig.aim(side + "Leg", W(V(s * (0.03 + k * 0.06), -Math.cos(kneeBend), Math.sin(kneeBend) * 0.45)));
          rig.aim(side + "Foot", W(V(s * 0.15, -0.3, 1)));
        });
        group.updateMatrixWorld(true);
        const feet = rig.pos("LeftFoot").add(rig.pos("RightFoot")).multiplyScalar(0.5); group.worldToLocal(feet);
        if (!anchor) anchor = feet.clone();
        ch.position.sub(feet.sub(anchor)); ch.updateMatrixWorld(true);
        // bar across the upper back, below the helmet; hands wide on the bar
        const sp2 = group.worldToLocal(rig.pos("Spine2")), nk = group.worldToLocal(rig.pos("Neck"));
        const up = nk.clone().sub(sp2).normalize(), backDir = V(0, up.z, -up.y).normalize();
        const barC = sp2.clone().lerp(nk, 0.95).addScaledVector(backDir, 0.1).addScaledVector(up, 0.02); barC.x = 0;
        bar.position.copy(barC); pad.position.copy(barC);
        ["Left", "Right"].forEach((side, i) => {
          const s = i ? -1 : 1, hand = group.localToWorld(barC.clone().add(V(s * 0.48, 0.02, 0.02)));
          reachArm(rig, side, hand, W(V(s * 0.8, -1, -0.1)), 0.35);
          rig.aim(side + "Hand", W(V(s * 0.2, 0.3, -1)));
        });
        levers.forEach((l, i) => { const s = i ? 1 : -1; setRod(l, V(s * 0.56, pivot.y, pivot.z), V(s * 0.56, barC.y, barC.z)); });
        const ang = Math.atan2(barC.y - pivot.y, barC.z - pivot.z);
        wheels.forEach((w) => { w.rotation.x = ang * 2; });
      },
      cleanup() {},
    };
  },

  // Stretching & mobility on a mat, feet hooked under the foot loops so they don't drift.
  stretch(group, rig, ch) {
    const g = new THREE.Group(); group.add(g);
    g.add(rbox(1.0, 0.03, 1.8, 0.012, std({ color: "#1f6f78", roughness: 0.9 }), 0, 0.015, 0));
    [-1, 1].forEach((s) => { const loop = mesh(new THREE.TorusGeometry(0.075, 0.016, 8, 24, Math.PI), MAT.strap(), s * 0.15, 0.03, 0.08); loop.scale.set(1, 1.3, 1); g.add(loop); });
    ch.position.set(0, 0.03, 0);
    // arm: 0 = down by the sides, fwd = straight forward, out = out to the sides, up = overhead
    const P = [
      { lean: 0, side: 0, twist: 0, fwd: 0, out: 0, up: 0 },
      { lean: 0, side: 0, twist: 0, fwd: 0, out: 0, up: 1 },      // reach up
      { lean: 0, side: 0.32, twist: 0, fwd: 0, out: 0, up: 1 },   // side bend left
      { lean: 0, side: -0.32, twist: 0, fwd: 0, out: 0, up: 1 },  // side bend right
      { lean: 0, side: 0, twist: 0.55, fwd: 1, out: 0, up: 0 },   // trunk twist, arms forward
      { lean: 1.05, side: 0, twist: 0, fwd: 0.4, out: 0, up: 0 }, // forward fold
      { lean: 0, side: 0, twist: 0, fwd: 0, out: 0, up: 0 },
    ];
    const seg = 2.4;
    let anchor = null, pose = 0;
    const q = new THREE.Quaternion();
    return {
      focus: ["Spine", "Spine1", "Spine2", "LeftArm", "RightArm", "LeftShoulder", "RightShoulder"],
      pose: () => pose,
      update(t) {
        const total = seg * (P.length - 1), u = (t % total) / seg, i = Math.floor(u), k = easeIO(Math.min(1, (u - i) * 1.4));
        const A = P[i], B = P[i + 1], p = {};
        Object.keys(A).forEach((key) => { p[key] = lerp(A[key], B[key], k); });
        pose = i;
        rig.reset();
        group.getWorldQuaternion(q); const W = (v) => v.clone().applyQuaternion(q);
        const breathe = Math.sin(t * 1.6) * 0.015;
        const sp = (f) => W(V(Math.sin(p.side * f), Math.cos(p.lean * 0.5 * f) * Math.cos(p.side * f), Math.sin(p.lean * 0.5 * f) + breathe));
        rig.aim("Hips", sp(0.5)); rig.aim("Spine", sp(0.9)); rig.aim("Spine1", sp(1.1)); rig.aim("Spine2", sp(1.25)); rig.aim("Neck", sp(1.1)); rig.aim("Head", sp(1.0));
        if (p.twist) { rig.bones.Spine1.rotateY(p.twist * 0.5); rig.bones.Spine2.rotateY(p.twist * 0.5); rig.bones.Spine1.updateMatrixWorld(true); }
        const tq = rig.bones.Spine2.getWorldQuaternion(new THREE.Quaternion());
        const T = (v) => v.clone().applyQuaternion(tq).normalize();          // directions in the chest's frame
        ["Left", "Right"].forEach((side, j) => {
          const s = j ? -1 : 1;
          rig.aim(side + "UpLeg", W(V(s * 0.1, -1, -p.lean * 0.12)));
          rig.aim(side + "Leg", W(V(s * 0.03, -1, 0.02)));
          rig.aim(side + "Foot", W(V(s * 0.1, -0.35, 1)));
          const rest = 1 - Math.min(1, p.fwd + p.out + p.up);
          const dir = T(V(s * 0.3, -1, 0.15)).multiplyScalar(rest)
            .addScaledVector(T(V(s * 0.1, 0.05, 1)), p.fwd).addScaledVector(T(V(s, 0.08, 0.05)), p.out).addScaledVector(T(V(s * 0.22, 0.5, 0.8)), p.up).normalize();
          aimArm(rig, side, dir, dir, 0.45);
        });
        group.updateMatrixWorld(true);
        const feet = rig.pos("LeftFoot").add(rig.pos("RightFoot")).multiplyScalar(0.5); group.worldToLocal(feet);
        if (!anchor) anchor = feet.clone();
        ch.position.sub(feet.sub(anchor)); ch.updateMatrixWorld(true);
      },
      cleanup() {},
    };
  },
};

// ---------------------------------------------------------------- the ISS module around the stage
// Rack walls, deck, ceiling lights and handrails, like the inside of the US Lab.
function rackTex() {
  return canvasTex(1024, 512, (g, w, h) => {
    g.fillStyle = "#d9dde3"; g.fillRect(0, 0, w, h);
    const racks = 6, rw = w / racks;
    for (let i = 0; i < racks; i++) {
      const x = i * rw;
      g.fillStyle = i % 2 ? "#cfd4db" : "#dde1e7"; g.fillRect(x + 4, 4, rw - 8, h - 8);
      g.strokeStyle = "#9ea7b3"; g.lineWidth = 3; g.strokeRect(x + 4, 4, rw - 8, h - 8);
      // drawers, panels and stowage bags
      const rows = 3 + (i % 3);
      for (let r = 0; r < rows; r++) {
        const y = 20 + r * ((h - 40) / rows), ph = (h - 40) / rows - 14;
        g.fillStyle = ["#c8ced6", "#e8ebef", "#b9c2cc", "#f0e9d8"][(i + r) % 4]; g.fillRect(x + 18, y, rw - 36, ph);
        g.strokeStyle = "#8f99a6"; g.lineWidth = 2; g.strokeRect(x + 18, y, rw - 36, ph);
        g.fillStyle = "#6f7a88"; g.fillRect(x + rw / 2 - 14, y + ph / 2 - 3, 28, 6);
        if ((i + r) % 3 === 0) { g.fillStyle = "#2f5fb3"; g.fillRect(x + 24, y + 8, 22, 22); }     // velcro patches
        if ((i * 7 + r) % 5 === 0) { g.fillStyle = "#e2531a"; g.fillRect(x + rw - 48, y + 8, 22, 10); }
        g.fillStyle = "#3b4553"; g.font = "bold 13px sans-serif"; g.fillText(`${["LAB", "EXPRESS", "ER", "HRF", "MSRR", "WORF"][i]}${r + 1}`, x + 54, y + 22);
      }
    }
  });
}
function buildModule(scene) {
  const room = new THREE.Group();
  const wallMat = new THREE.MeshStandardMaterial({ map: rackTex(), color: "#9aa3b0", roughness: 0.8, metalness: 0.05 });
  const deckTex = canvasTex(512, 512, (g, w, h) => { g.fillStyle = "#b7bec8"; g.fillRect(0, 0, w, h); g.strokeStyle = "#8b94a1"; g.lineWidth = 4; for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(i * w / 4, 0); g.lineTo(i * w / 4, h); g.stroke(); g.beginPath(); g.moveTo(0, i * h / 4); g.lineTo(w, i * h / 4); g.stroke(); } g.fillStyle = "#9aa3ae"; for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { g.beginPath(); g.arc(i * w / 4 + 12, j * h / 4 + 12, 4, 0, 7); g.fill(); } });
  deckTex.wrapS = deckTex.wrapT = THREE.RepeatWrapping; deckTex.repeat.set(4, 3);
  const deck = new THREE.Mesh(new THREE.PlaneGeometry(8, 6), new THREE.MeshStandardMaterial({ map: deckTex, color: "#8e97a4", roughness: 0.85 }));
  deck.rotation.x = -Math.PI / 2; deck.receiveShadow = true; room.add(deck);
  const W = 7, H = 3.0, back = -1.95;
  const backWall = new THREE.Mesh(new THREE.PlaneGeometry(W, H - 0.6), wallMat); backWall.position.set(0, 0.3 + (H - 0.6) / 2, back); backWall.receiveShadow = true; room.add(backWall);
  // angled stand-offs top and bottom (the module is round outside, square inside)
  const off = new THREE.MeshStandardMaterial({ color: "#7d8693", roughness: 0.6, metalness: 0.2 });
  const low = new THREE.Mesh(new THREE.PlaneGeometry(W, 0.42), off); low.position.set(0, 0.15, back + 0.15); low.rotation.x = -Math.PI / 4; room.add(low);
  const high = new THREE.Mesh(new THREE.PlaneGeometry(W, 0.42), off); high.position.set(0, H - 0.15, back + 0.15); high.rotation.x = Math.PI / 4; room.add(high);
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, 4), new THREE.MeshStandardMaterial({ map: rackTex(), roughness: 0.85, color: "#8d96a3" }));
  ceil.position.set(0, H, back + 2); ceil.rotation.x = Math.PI / 2; room.add(ceil);
  // light panels and handrails
  const lightMat = new THREE.MeshStandardMaterial({ color: "#ffffff", emissive: "#eaf6ff", emissiveIntensity: 1.4 });
  [-2, 0, 2].forEach((x) => { const l = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.12), lightMat); l.position.set(x, H - 0.16, back + 0.16); l.rotation.x = Math.PI / 4; l.position.z += 0.005; room.add(l); });
  const rail = std({ color: "#c7cdd5", metalness: 0.6, roughness: 0.35 });
  [1.0, 2.15].forEach((y) => {
    room.add(rod(V(-3.2, y, back + 0.12), V(3.2, y, back + 0.12), 0.018, rail));
    for (let x = -3; x <= 3; x += 1.5) room.add(rod(V(x, y, back + 0.12), V(x, y, back + 0.01), 0.012, rail));
  });
  // side walls (mostly out of frame, close the room at wide aspect ratios)
  [-1, 1].forEach((s) => { const w = new THREE.Mesh(new THREE.PlaneGeometry(4.5, H), wallMat); w.position.set(s * 3.5, H / 2, back + 2.2); w.rotation.y = -s * Math.PI / 2; room.add(w); });
  scene.add(room);
  return room;
}

// Waiting for a pick: floating in microgravity, slowly turning, using the idle mocap.
function floatIdle(group, rig, ch, motion) {
  motion.actions.idle.reset().play();
  return {
    focus: [],
    update(t, dt) {
      motion.mixer.update(dt);
      motion.rig.bones.Hips.position.x = 0; motion.rig.bones.Hips.position.z = 0;
      ch.position.set(0, 0.3 + Math.sin(t * 0.9) * 0.06, 0);
      ch.rotation.set(Math.sin(t * 0.5) * 0.04, Math.sin(t * 0.25) * 0.5, Math.sin(t * 0.7) * 0.03);
      follow(rig, motion.rig, ch, 0.2);
    },
    cleanup() { motion.mixer.stopAllAction(); ch.rotation.set(0, 0, 0); },
  };
}

// ---------------------------------------------------------------- mount
const ASTRONAUT_URL = "/models/exercise/crew_suit.glb";
export function mountCoach(canvas, overlay, { onStep } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setClearColor(0, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  canvas.style.transition = "opacity .35s ease";

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = env; scene.environmentIntensity = 0.5;
  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
  const key = new THREE.DirectionalLight("#ffffff", 2.4); key.position.set(-2.5, 4.5, 3.5); key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024); Object.assign(key.shadow.camera, { left: -2, right: 2, top: 3, bottom: -1 }); key.shadow.radius = 4; key.shadow.bias = -0.0005;
  scene.add(key);
  const rim = new THREE.DirectionalLight("#7fd8ff", 1.6); rim.position.set(3, 2.5, -3); scene.add(rim);
  scene.add(new THREE.HemisphereLight("#cfe6ff", "#0a0e16", 0.4));

  buildModule(scene);
  // a soft cyan ring on the deck marks the coaching spot
  const ringTex = canvasTex(256, 256, (g) => { const r = g.createRadialGradient(128, 128, 70, 128, 128, 128); r.addColorStop(0, "rgba(79,209,197,0)"); r.addColorStop(0.9, "rgba(79,209,197,0.08)"); r.addColorStop(0.97, "rgba(79,209,197,0.6)"); r.addColorStop(1, "rgba(79,209,197,0)"); g.fillStyle = r; g.fillRect(0, 0, 256, 256); });
  const glowDisc = new THREE.Mesh(new THREE.CircleGeometry(1.5, 96), new THREE.MeshBasicMaterial({ map: ringTex, transparent: true, depthWrite: false }));
  glowDisc.rotation.x = -Math.PI / 2; glowDisc.position.y = 0.003; scene.add(glowDisc);

  const YAW = { t2: -1.1, cevis: -1.05, ared: -1.0, stretch: -0.4, idle: -0.25 };
  let yawGoal = YAW.idle;
  const stage = new THREE.Group(); stage.rotation.y = yawGoal; scene.add(stage);
  let ch = null, rig = null, astro = null, motion = null, current = null, exId, playing = true, raf = 0, last = performance.now(), t = 0;

  const loader = document.createElement("div");
  loader.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#9aa8c7;font:12px Inter,system-ui,sans-serif;pointer-events:none";
  loader.textContent = "Loading 3D coach…"; overlay.appendChild(loader);

  const gl = new GLTFLoader(); const draco = new DRACOLoader(); draco.setDecoderPath("/draco/"); gl.setDRACOLoader(draco);
  const timeout = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timed out")), 30000))]);
  const ready = timeout(Promise.all([gl.loadAsync(ASTRONAUT_URL), gl.loadAsync(MOTION_URL)])).then(([astroGltf, botGltf]) => {
    astro = buildAstronaut(astroGltf);
    ch = astro.root;
    rig = makeRig(ch);
    // the X Bot only provides motion capture: it rides along invisibly inside the astronaut's frame
    const bot = botGltf.scene; bot.visible = false; ch.add(bot);
    motion = { rig: makeRig(bot), mixer: new THREE.AnimationMixer(bot) };
    motion.actions = Object.fromEntries(botGltf.animations.map((a) => [a.name, motion.mixer.clipAction(a)]));
    stage.add(ch);
    loader.style.display = "none";
  }).catch((err) => { console.error("Coach model failed to load", err); loader.textContent = "3D coach couldn't load. Try refreshing the page."; });

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return;
    const pr = renderer.getPixelRatio();
    if (canvas.width !== Math.round(w * pr) || canvas.height !== Math.round(h * pr)) { renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
    const vf = THREE.MathUtils.degToRad(camera.fov) / 2, hf = Math.atan(Math.tan(vf) * camera.aspect);
    const dist = Math.max(1.32 / Math.tan(vf), 1.35 / Math.tan(hf)) * 1.05;
    camera.position.set(0, 1.25 + dist * 0.14, dist); camera.lookAt(0, 1.0, 0);
  }
  const ro = new ResizeObserver(resize); ro.observe(canvas);

  function clearExercise() {
    if (!current) return;
    current.cleanup?.(); stage.remove(current.group);
    current.group.traverse((o) => { o.geometry?.dispose(); if (o.material) [].concat(o.material).forEach((m) => { m.map?.dispose(); m.dispose(); }); });
    current = null;
  }

  let applyToken = 0;
  async function apply(id) {
    const my = ++applyToken;
    await ready; if (!rig || my !== applyToken) return;
    canvas.style.opacity = "0";
    await new Promise((r) => setTimeout(r, current ? 220 : 0));
    if (my !== applyToken) return;
    clearExercise();
    motion.mixer.stopAllAction(); rig.reset(); ch.position.set(0, 0, 0); ch.rotation.set(0, 0, 0);
    const group = new THREE.Group(); stage.add(group);
    const ex = (id && EXERCISES[id] ? EXERCISES[id] : floatIdle)(group, rig, ch, motion);
    current = { ...ex, group };
    astro.setFocus(ex.focus || []);
    yawGoal = YAW[id] ?? YAW.idle;
    stage.rotation.y = yawGoal;
    t = 0;
    try { current.update(0, 0.016); } catch (err) { console.error("[coach] first frame", err); }
    canvas.style.opacity = "1";
  }

  function frame(now) {
    raf = 0; if (!canvas.isConnected) return;
    if (document.visibilityState === "visible") {
      resize();
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      const run = playing || !exId;
      if (run) t += dt;
      if (current && rig) {
        try { current.update(t, run ? dt : 0); } catch (err) { console.error("[coach] frame error", err); }
        focusUniforms.uPulse.value = 0.14 + 0.1 * Math.sin(now / 320);
        if (exId) onStep?.({ t, reps: current.reps?.(), pose: current.pose?.() });
      }
      stage.rotation.y += (yawGoal + Math.sin(now / 9000) * 0.08 - stage.rotation.y) * 0.04;
      renderer.render(scene, camera);
    } else last = now;
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);
  apply(null);

  return {
    setExercise(id) { id = id || null; if (id === exId) return; exId = id; apply(id); },
    setPlaying(p) { playing = p; },
    restart() { t = 0; },
    setTime(v) { t = v; },          // jump the demo to a moment (used by tests)
    dispose() {
      cancelAnimationFrame(raf); raf = 0; applyToken++; ro.disconnect(); clearExercise(); loader.remove();
      env.dispose(); pmrem.dispose(); renderer.dispose(); draco.dispose();
    },
  };
}
