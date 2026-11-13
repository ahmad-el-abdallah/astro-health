// Exercise coach: NASA's astronaut model (NASA 3D Resources, free to use) demonstrating each
// ISS exercise on a model of the real machine. Plain three.js.
//
//   const coach = mountCoach(canvas, overlay, { onStep });
//   coach.setExercise("ared");  coach.setExercise(null);  // null = floating, waiting for a pick
//   coach.setPlaying(false);  coach.restart();  coach.dispose();
//
// The NASA model is a static mesh, so it is given a skeleton when it loads (buildAstronaut).
// Movement: the treadmill run and the idle float are motion capture (from the X Bot model,
// loaded invisibly and copied onto the astronaut bone by bone). Cycling, squats and stretches
// are posed every frame: hands and feet are placed where they must be (handlebars, pedals,
// bar, platform) with two-bone IK, and the machines are sized from the astronaut's real limb
// lengths so nothing passes through anything else.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

const MOTION_URL = "/models/exercise/xbot.glb";   // motion capture source only (never shown)

// ---------------------------------------------------------------- materials & helpers
const std = (o) => new THREE.MeshStandardMaterial(o);
const M = {
  frame: () => std({ color: "#c8ced6", metalness: 0.85, roughness: 0.3 }),
  dark: () => std({ color: "#232a33", metalness: 0.5, roughness: 0.55 }),
  panel: () => std({ color: "#e9edf2", metalness: 0.2, roughness: 0.5 }),
  foam: () => std({ color: "#3a4553", metalness: 0, roughness: 0.9 }),
  strap: () => std({ color: "#2f6fe0", metalness: 0, roughness: 0.7 }),
  bungee: () => std({ color: "#f2f4f7", metalness: 0, roughness: 0.6 }),
  accent: () => std({ color: "#4fd1c5", emissive: "#4fd1c5", emissiveIntensity: 0.6, roughness: 0.4 }),
  screen: () => std({ color: "#0b1622", emissive: "#2dd4bf", emissiveIntensity: 0.35, roughness: 0.2, metalness: 0.4 }),
};
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
// NASA's "Astronaut" model (NASA 3D Resources) is a single static mesh in a T-pose. We give
// it a skeleton here: joints at measured positions (metres, model scaled to 1.85 m, feet on
// y=0, facing +z, +x = the astronaut's left), then every vertex is weighted to the nearby
// bones. Helmet -> head, backpack -> upper back (rigid), arms/legs blend along their bones.
const JOINTS = {
  Hips: [null, [0, 0.95, 0.08]], Spine: ["Hips", [0, 1.05, 0.08]], Spine1: ["Spine", [0, 1.17, 0.08]], Spine2: ["Spine1", [0, 1.3, 0.07]],
  Neck: ["Spine2", [0, 1.5, 0.07]], Head: ["Neck", [0, 1.58, 0.07]], HeadTop_End: ["Head", [0, 1.85, 0.07]],
};
["Left", "Right"].forEach((side, i) => {
  const s = i ? -1 : 1, P = (x, y, z) => [s * x, y, z];
  Object.assign(JOINTS, {
    [side + "Shoulder"]: ["Spine2", P(0.08, 1.4, 0.07)], [side + "Arm"]: [side + "Shoulder", P(0.27, 1.36, 0.09)],
    [side + "ForeArm"]: [side + "Arm", P(0.55, 1.35, 0.1)], [side + "Hand"]: [side + "ForeArm", P(0.75, 1.31, 0.11)],
    [side + "HandMiddle1"]: [side + "Hand", P(0.86, 1.27, 0.13)],
    [side + "UpLeg"]: ["Hips", P(0.13, 0.9, 0.07)], [side + "Leg"]: [side + "UpLeg", P(0.16, 0.5, 0.08)],
    [side + "Foot"]: [side + "Leg", P(0.17, 0.13, 0.05)], [side + "ToeBase"]: [side + "Foot", P(0.17, 0.03, 0.25)],
    [side + "Toe_End"]: [side + "ToeBase", P(0.17, 0.03, 0.33)],
  });
});
CHAIN.LeftShoulder = "LeftArm"; CHAIN.RightShoulder = "RightArm"; CHAIN.Head = "HeadTop_End"; CHAIN.LeftToeBase = "LeftToe_End"; CHAIN.RightToeBase = "RightToe_End";

function segDist(p, a, b) {
  const ab = b.clone().sub(a), t = clamp(p.clone().sub(a).dot(ab) / Math.max(1e-6, ab.lengthSq()), 0, 1);
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}
function candidates(v) {
  const side = v.x >= 0 ? "Left" : "Right", ax = Math.abs(v.x);
  if (v.z < -0.13 && v.y > 0.6 && v.y < 1.78 && ax < 0.36) return [["Spine2", 1]];                 // backpack: rigid
  if (v.y > 1.52 && ax < 0.26) return [["Head", 1]];                                                // helmet: rigid
  if (v.y > 1.12 && ax > 0.3) return [[side + "Shoulder"], [side + "Arm"], [side + "ForeArm"], [side + "Hand"]];
  if (v.y > 1.12 && ax > 0.22) return [["Spine2"], [side + "Shoulder"], [side + "Arm"]];
  if (v.y < 0.86) return [[side + "UpLeg"], [side + "Leg"], [side + "Foot"], [side + "ToeBase"]].concat(v.y > 0.72 ? [["Hips"]] : []);
  return [["Hips"], ["Spine"], ["Spine1"], ["Spine2"], ["Neck"]].concat(v.y < 1.0 ? [[side + "UpLeg"]] : []);
}
function buildAstronaut(gltf) {
  const src = gltf.scene; src.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(src), k = 1.85 / (box.max.y - box.min.y);
  const norm = new THREE.Matrix4().makeScale(k, k, k).premultiply(new THREE.Matrix4().makeTranslation(0, 0, 0))
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
  const meshes = [];
  src.traverse((o) => {
    if (!o.isMesh) return;
    const geo = o.geometry.clone(); geo.applyMatrix4(o.matrixWorld.clone().premultiply(norm));
    const pos = geo.attributes.position, n = pos.count, si = new Uint16Array(n * 4), sw = new Float32Array(n * 4), v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, i);
      const cands = candidates(v).map(([b, fixed]) => {
        if (fixed) return [b, 1];
        const [a, c] = seg(b); const d = Math.max(0.01, segDist(v, a, c)); return [b, 1 / Math.pow(d, 5)];
      }).sort((x, y) => y[1] - x[1]).slice(0, 4);
      const tot = cands.reduce((s2, c) => s2 + c[1], 0);
      cands.forEach(([b, w], j) => { si[i * 4 + j] = index[b]; sw[i * 4 + j] = w / tot; });
    }
    geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(si, 4));
    geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(sw, 4));
    geo.setAttribute("aFocus", new THREE.BufferAttribute(new Float32Array(n), 1));
    geo.computeVertexNormals();
    const mat = o.material.clone(); mat.roughness = 0.62; mat.metalness = 0.05; mat.envMapIntensity = 1.1;
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
  rig.bones.Hips.position.set(sh.x * 0.9, sh.y * (0.95 / 1.04), sh.z * 0.9 + 0.06);
  rig.bones.Hips.updateMatrixWorld(true);
  FOLLOW.forEach((n) => {
    const sb = src.bones[n], sc = src.bones[CHAIN[n] === "HeadTop_End" ? "HeadTop_End" : CHAIN[n]];
    if (!sb || !sc || n === "LeftShoulder" || n === "RightShoulder") return;
    sb.getWorldPosition(a); sc.getWorldPosition(b);
    const dir = b.sub(a);
    if (/Arm$/.test(n)) {
      const s = n.startsWith("Left") ? 1 : -1, cq = ch.getWorldQuaternion(new THREE.Quaternion());
      const side = V(s, 0, 0).applyQuaternion(cq), fwd = V(0, 0, 1).applyQuaternion(cq);
      dir.normalize();
      if (n.endsWith("ForeArm")) { dir.addScaledVector(side, spread * 0.9); if (dir.dot(fwd) < 0.2) dir.addScaledVector(fwd, 0.25); }
      else dir.addScaledVector(side, spread);
    }
    rig.aim(n, dir);
  });
}

// ---------------------------------------------------------------- exercises
// Each: build(group, rig, ch, motion) -> { update(t, dt), focus: [bones], cleanup() }
// The astronaut faces +z; +x is their left. Metres. The suit is bulky (torso ±0.33 wide,
// backpack to z -0.34), so machines leave room for it.
const outward = (W, s, x, y, z) => W(V(s * x, y, z));

// a waist belt sized for the suit, with side clips (T2 harness, CEVIS strap)
function waistBelt(rig, mat) {
  const g = new THREE.Group();
  const belt = mesh(new THREE.TorusGeometry(1, 0.03, 10, 48), mat); belt.rotation.x = Math.PI / 2; belt.scale.set(0.35, 0.29, 1); g.add(belt);
  const clips = [-1, 1].map((s) => { const c = mesh(new THREE.BoxGeometry(0.04, 0.08, 0.07), M.frame(), s * 0.36, 0, 0.0); g.add(c); return c; });
  g.position.set(0, 0.02, 0.0);
  rig.bones.Hips.add(g);
  return { group: g, clips };
}

const EXERCISES = {
  // T2 / COLBERT treadmill: a harness and bungees hold the runner down onto the belt.
  t2(group, rig, ch, motion) {
    const g = new THREE.Group(); group.add(g);
    const belt = beltTex();
    g.add(mesh(new THREE.BoxGeometry(1.0, 0.16, 2.1), M.panel(), 0, 0.08, 0));
    g.add(mesh(new THREE.BoxGeometry(0.72, 0.02, 1.96), std({ map: belt, roughness: 0.9 }), 0, 0.17, 0));
    [-0.46, 0.46].forEach((x) => g.add(mesh(new THREE.BoxGeometry(0.08, 0.06, 2.12), M.frame(), x, 0.19, 0)));
    [-0.46, 0.46].forEach((x) => g.add(rod(V(x, 0.2, 1.0), V(x, 1.15, 1.0), 0.024, M.frame())));
    g.add(rod(V(-0.46, 1.15, 1.0), V(0.46, 1.15, 1.0), 0.022, M.frame()));
    const disp = mesh(new THREE.BoxGeometry(0.44, 0.26, 0.04), M.dark(), 0, 1.3, 1.02); disp.rotation.x = -0.35; g.add(disp);
    const scr = mesh(new THREE.PlaneGeometry(0.38, 0.2), M.screen(), 0, 1.305, 0.998); scr.rotation.set(0.35 + Math.PI, 0, Math.PI); g.add(scr);
    const harness = waistBelt(rig, M.strap());
    const bungees = [liveRod(0.012, M.bungee()), liveRod(0.012, M.bungee())]; bungees.forEach((b) => g.add(b));
    const anchors = [V(-0.46, 0.22, -0.1), V(0.46, 0.22, -0.1)];
    ch.position.set(0, 0.18, 0);
    motion.actions.run.reset().setEffectiveTimeScale(0.8).play();
    const tmp = new THREE.Vector3();
    return {
      focus: ["LeftUpLeg", "RightUpLeg", "LeftLeg", "RightLeg"],
      update(t, dt) {
        belt.offset.y -= dt * 1.9;
        motion.mixer.update(dt);
        motion.rig.bones.Hips.position.x = 0; motion.rig.bones.Hips.position.z = 0;
        follow(rig, motion.rig, ch, 0.3);
        group.updateMatrixWorld(true);
        bungees.forEach((b, i) => { harness.clips[i].getWorldPosition(tmp); group.worldToLocal(tmp); setRod(b, anchors[i], tmp); });
      },
      cleanup() { motion.mixer.stopAllAction(); rig.bones.Hips.remove(harness.group); },
    };
  },

  // CEVIS: no seat. Shoes clip into the pedals, a waist strap holds the rider, hands on the bars.
  // The crank is placed from the real leg length so the knee never over-bends.
  cevis(group, rig, ch) {
    const g = new THREE.Group(); group.add(g);
    const L = rig.len.thigh + rig.len.shin, crankR = 0.15;
    const hipW = V(0, 1.15, 0.0), crankC = V(0, 0, 0.36);
    const hipJointY = hipW.y - (rig.pos("Hips").y - rig.pos("LeftUpLeg").y), dz = crankC.z - 0.08;
    crankC.y = hipJointY - Math.sqrt(Math.max(0.01, (L * 0.95) ** 2 - dz * dz)) + crankR - 0.09;
    g.add(mesh(new THREE.BoxGeometry(0.56, 0.05, 1.1), M.dark(), 0, 0.025, 0.45));
    const fly = mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.05, 48), M.panel(), 0, crankC.y, crankC.z + 0.12); fly.rotation.z = Math.PI / 2; g.add(fly);
    const rimRing = mesh(new THREE.TorusGeometry(0.22, 0.01, 8, 48), M.accent(), 0.03, crankC.y, crankC.z + 0.12); rimRing.rotation.y = Math.PI / 2; g.add(rimRing);
    g.add(rod(V(0, 0.05, 0.12), V(0, crankC.y, crankC.z), 0.03, M.frame())); g.add(rod(V(0, 0.05, 0.7), V(0, crankC.y, crankC.z + 0.12), 0.03, M.frame()));
    const barH = hipW.y + 0.2, barZ = 0.62;
    g.add(rod(V(0, 0.05, 0.98), V(0, barH + 0.04, 0.98), 0.03, M.frame()));
    g.add(rod(V(0, barH + 0.04, 0.98), V(0, barH, barZ), 0.024, M.frame()));
    g.add(rod(V(-0.34, barH, barZ), V(0.34, barH, barZ), 0.022, M.frame()));
    [-0.34, 0.34].forEach((x) => g.add(mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.12, 16), M.foam(), x, barH, barZ).rotateZ(Math.PI / 2)));
    const disp = mesh(new THREE.BoxGeometry(0.24, 0.15, 0.035), M.dark(), 0, barH + 0.15, 0.96); disp.rotation.x = 0.45; g.add(disp);
    const scr = mesh(new THREE.PlaneGeometry(0.2, 0.12), M.screen(), 0, barH + 0.15, 0.94); scr.rotation.set(0.45 + Math.PI, 0, Math.PI); g.add(scr);
    const crank = new THREE.Group(); crank.position.copy(crankC); g.add(crank);
    const arms = [0, 1].map(() => mesh(new THREE.BoxGeometry(0.02, crankR, 0.03), M.frame()));
    const pedals = [0, 1].map(() => mesh(new THREE.BoxGeometry(0.12, 0.024, 0.09), M.dark()));
    arms.forEach((a) => crank.add(a)); pedals.forEach((p) => crank.add(p));
    const strap = waistBelt(rig, M.strap());
    ch.position.set(0, 0, 0);
    const q = new THREE.Quaternion();
    return {
      focus: ["LeftUpLeg", "RightUpLeg", "LeftLeg", "RightLeg"],
      update(t) {
        const a = t * 4.2;                                   // ~40 rpm, easy to follow
        rig.reset();
        group.getWorldQuaternion(q); const W = (v) => v.clone().applyQuaternion(q);
        const bob = Math.sin(a * 2) * 0.006, sway = Math.sin(a) * 0.02;
        rig.bones.Hips.position.copy(rig.bones.Hips.parent.worldToLocal(group.localToWorld(hipW.clone().add(V(0, bob, 0)))));
        rig.aim("Hips", W(V(0, 1, 0.12)));
        rig.aim("Spine", W(V(sway * 0.5, 0.95, 0.25))); rig.aim("Spine1", W(V(sway, 0.93, 0.32))); rig.aim("Spine2", W(V(sway, 0.93, 0.34)));
        rig.aim("Neck", W(V(0, 0.97, 0.2))); rig.aim("Head", W(V(0, 1, 0.06)));
        [1, -1].forEach((s, i) => {
          const ang = a + i * Math.PI, side = s > 0 ? "Left" : "Right";
          const py = Math.sin(ang) * crankR, pz = Math.cos(ang) * crankR;
          arms[i].position.set(s * 0.045, py / 2, pz / 2); arms[i].rotation.x = -ang + Math.PI / 2;
          pedals[i].position.set(s * 0.17, py, pz);
          const ankle = group.localToWorld(V(s * 0.17, crankC.y + py + 0.09, crankC.z + pz - 0.08));
          reach(rig, side + "UpLeg", side + "Leg", ankle, rig.len.thigh, rig.len.shin, W(V(s * 0.25, 0.35, 1)));
          rig.aim(side + "Foot", W(V(0, -0.45 - 0.2 * Math.max(0, -Math.sin(ang)), 1)));
          const hand = group.localToWorld(V(s * 0.34, barH + 0.0, barZ - 0.02));
          reach(rig, side + "Arm", side + "ForeArm", hand, rig.len.upper, rig.len.fore, W(V(s * 1, -0.6, -0.2)));
          rig.aim(side + "Hand", W(V(s * 0.2, -0.1, 1)));
        });
      },
      cleanup() { rig.bones.Hips.remove(strap.group); },
    };
  },

  // ARED squat (front-loaded so the bar clears the life-support backpack): the bar rests
  // across the front of the shoulders, the vacuum cylinders in front supply the load.
  ared(group, rig, ch) {
    const g = new THREE.Group(); group.add(g);
    g.add(mesh(new THREE.BoxGeometry(1.7, 0.08, 1.7), M.panel(), 0, 0.04, 0.25));
    g.add(mesh(new THREE.BoxGeometry(0.8, 0.012, 0.55), std({ color: "#2b3440", roughness: 0.95 }), 0, 0.086, 0.05));
    const front = 0.42;   // the bar's line in front of the chest
    [-0.78, 0.78].forEach((x) => g.add(rod(V(x, 0.08, -0.3), V(x, 2.15, -0.3), 0.035, M.frame())));
    g.add(rod(V(-0.78, 2.15, -0.3), V(0.78, 2.15, -0.3), 0.035, M.frame()));
    // two vacuum cylinders under the bar ends; their pistons push up on the bar
    const pistonBase = [-0.62, 0.62].map((x) => {
      g.add(mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.5, 32), M.frame(), x, 0.33, front));
      g.add(mesh(new THREE.CylinderGeometry(0.086, 0.086, 0.04, 32), M.accent(), x, 0.6, front));
      return V(x, 0.6, front);
    });
    const levers = [liveRod(0.022, std({ color: "#e8ecf1", metalness: 0.95, roughness: 0.15 })), liveRod(0.022, std({ color: "#e8ecf1", metalness: 0.95, roughness: 0.15 }))]; levers.forEach((l) => g.add(l));
    const bar = mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.35, 16), M.frame()); bar.rotation.z = Math.PI / 2; g.add(bar);
    [-0.62, 0.62].forEach((x) => bar.add(mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.06, 24), M.dark(), 0, x, 0)));
    ch.position.set(0, 0.092, 0.0);
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
        const hipFlex = k * 1.3, kneeBend = k * 0.8, lean = k * 0.32;        // front squat: torso stays upright
        rig.aim("Hips", W(V(0, Math.cos(lean * 0.6), Math.sin(lean * 0.6))));
        rig.aim("Spine", W(V(0, Math.cos(lean), Math.sin(lean))));
        rig.aim("Spine1", W(V(0, Math.cos(lean), Math.sin(lean))));
        rig.aim("Spine2", W(V(0, Math.cos(lean * 0.9), Math.sin(lean * 0.9))));
        rig.aim("Neck", W(V(0, 1, 0.1))); rig.aim("Head", W(V(0, 1, 0.08)));
        ["Left", "Right"].forEach((side, i) => {
          const s = i ? -1 : 1;
          rig.aim(side + "UpLeg", W(V(s * (0.12 + k * 0.22), -Math.cos(hipFlex), Math.sin(hipFlex))));
          rig.aim(side + "Leg", W(V(s * (0.04 + k * 0.08), -Math.cos(kneeBend), -Math.sin(kneeBend) * 0.15 + Math.sin(kneeBend) * 0.6)));
          rig.aim(side + "Foot", W(V(s * 0.16, -0.3, 1)));
        });
        // keep the feet planted: shift the whole body so the ankles stay put
        group.updateMatrixWorld(true);
        const feet = rig.pos("LeftFoot").add(rig.pos("RightFoot")).multiplyScalar(0.5); group.worldToLocal(feet);
        if (!anchor) anchor = feet.clone();
        ch.position.sub(feet.sub(anchor)); ch.updateMatrixWorld(true);
        // bar across the front of the shoulders, hands just outside them, elbows up
        const sp2 = group.worldToLocal(rig.pos("Spine2")), nk = group.worldToLocal(rig.pos("Neck"));
        const up = nk.clone().sub(sp2).normalize(), fwd = V(0, -up.z, up.y).normalize();
        const barC = sp2.clone().lerp(nk, 0.55).addScaledVector(fwd, 0.36); barC.x = 0;
        bar.position.copy(barC);
        ["Left", "Right"].forEach((side, i) => {
          const s = i ? -1 : 1, hand = group.localToWorld(barC.clone().add(V(s * 0.3, 0.0, 0.0)));
          reach(rig, side + "Arm", side + "ForeArm", hand, rig.len.upper, rig.len.fore, W(V(s * 0.9, -0.4, 0.6)));
          rig.aim(side + "Hand", W(V(s * 0.3, 0.1, 1)));
        });
        levers.forEach((l, i) => setRod(l, pistonBase[i], barC.clone().add(V(pistonBase[i].x, 0, 0))));
      },
      cleanup() {},
    };
  },

  // Stretching & mobility: reach up, side bends, forward fold, feet in the floor loops.
  stretch(group, rig, ch) {
    const g = new THREE.Group(); group.add(g);
    g.add(mesh(new THREE.BoxGeometry(1.0, 0.025, 1.8), std({ color: "#1f6f78", roughness: 0.85 }), 0, 0.0125, 0));
    [-0.17, 0.17].forEach((x) => { const loop = mesh(new THREE.TorusGeometry(0.09, 0.014, 8, 24), M.strap(), x, 0.05, 0.12); loop.rotation.x = Math.PI / 2; loop.scale.set(1, 1.6, 1); g.add(loop); });
    ch.position.set(0, 0.03, 0);
    // arm: 0 = down by the sides, 1 = straight forward, 2 = out to the sides
    const P = [
      { lean: 0, side: 0, twist: 0, fwd: 0, out: 0 },
      { lean: 0, side: 0, twist: 0, fwd: 1, out: 0 },      // reach forward
      { lean: 0, side: 0.3, twist: 0, fwd: 0, out: 1 },    // arms out, side bend left
      { lean: 0, side: -0.3, twist: 0, fwd: 0, out: 1 },   // side bend right
      { lean: 0, side: 0, twist: 0.5, fwd: 0, out: 1 },    // trunk twist
      { lean: 0.9, side: 0, twist: 0, fwd: 0.3, out: 0 },  // forward fold
      { lean: 0, side: 0, twist: 0, fwd: 0, out: 0 },
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
        if (p.twist) rig.bones.Spine1.rotateY(p.twist * 0.5), rig.bones.Spine2.rotateY(p.twist * 0.5), rig.bones.Spine2.updateMatrixWorld(true);
        const tq = rig.bones.Spine2.getWorldQuaternion(new THREE.Quaternion());
        const T = (v) => v.clone().applyQuaternion(tq);           // directions in the chest's frame
        ["Left", "Right"].forEach((side, j) => {
          const s = j ? -1 : 1;
          rig.aim(side + "UpLeg", W(V(s * 0.1, -1, -p.lean * 0.1)));
          rig.aim(side + "Leg", W(V(s * 0.03, -1, 0.02)));
          rig.aim(side + "Foot", W(V(s * 0.1, -0.35, 1)));
          const down = T(V(s * 0.42, -1, 0.12)).normalize(), fwd = T(V(s * 0.12, 0.05, 1)).normalize(), out = T(V(s, 0.05, 0.05)).normalize();
          const dir = down.multiplyScalar(Math.max(0, 1 - p.fwd - p.out)).addScaledVector(fwd, p.fwd).addScaledVector(out, p.out).normalize();
          rig.aim(side + "Arm", dir); rig.aim(side + "ForeArm", dir);
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
      follow(rig, motion.rig, ch, 0.42);
    },
    cleanup() { motion.mixer.stopAllAction(); ch.rotation.set(0, 0, 0); },
  };
}

// ---------------------------------------------------------------- mount
const ASTRONAUT_URL = "/models/exercise/astronaut.glb";
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
  scene.environment = env; scene.environmentIntensity = 0.7;
  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
  const key = new THREE.DirectionalLight("#ffffff", 2.4); key.position.set(-2.5, 4.5, 3.5); key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024); Object.assign(key.shadow.camera, { left: -2, right: 2, top: 3, bottom: -1 }); key.shadow.radius = 4; key.shadow.bias = -0.0005;
  scene.add(key);
  const rim = new THREE.DirectionalLight("#7fd8ff", 1.6); rim.position.set(3, 2.5, -3); scene.add(rim);
  scene.add(new THREE.HemisphereLight("#cfe6ff", "#0a0e16", 0.4));

  const floor = new THREE.Mesh(new THREE.CircleGeometry(1.7, 96), new THREE.ShadowMaterial({ opacity: 0.32 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  const ringTex = canvasTex(256, 256, (g) => { const r = g.createRadialGradient(128, 128, 60, 128, 128, 128); r.addColorStop(0, "rgba(79,209,197,0.10)"); r.addColorStop(0.85, "rgba(79,209,197,0.05)"); r.addColorStop(0.97, "rgba(79,209,197,0.55)"); r.addColorStop(1, "rgba(79,209,197,0)"); g.fillStyle = r; g.fillRect(0, 0, 256, 256); });
  const glowDisc = new THREE.Mesh(new THREE.CircleGeometry(1.75, 96), new THREE.MeshBasicMaterial({ map: ringTex, transparent: true, depthWrite: false }));
  glowDisc.rotation.x = -Math.PI / 2; glowDisc.position.y = 0.002; scene.add(glowDisc);

  const YAW = { t2: -1.15, cevis: -1.1, ared: -0.6, stretch: -0.4, idle: -0.25 };
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
    dispose() {
      cancelAnimationFrame(raf); raf = 0; applyToken++; ro.disconnect(); clearExercise(); loader.remove();
      env.dispose(); pmrem.dispose(); renderer.dispose(); draco.dispose();
    },
  };
}
