// One-off build step: turns the real BodyParts3D 4.0 anatomy meshes into the single
// compressed model the Body page renders (public/models/anatomy.glb, committed to git,
// so nobody else needs to run this).
//
//   cd frontend && node scripts/build-anatomy.mjs
//
// Source: BodyParts3D, © The Database Center for Life Science, licensed under CC
// Attribution 4.0 International (https://dbarchive.biosciencedbc.jp/en/bodyparts3d/lic.html).
// The OBJ file headers still mention the older CC BY-SA 2.1 JP terms; the database's
// current license page supersedes them.
//
// What it does:
//   1. downloads the IS-A mesh archive + parts tables into .anatomy-cache/ (gitignored)
//   2. picks the meshes for each app body region using the anatomy tables (e.g. every
//      mesh classified as "bone organ" → skeleton)
//   3. merges each region, simplifies it with meshoptimizer to a triangle budget,
//      converts millimetres/Z-up to metres/Y-up with the feet on the floor
//   4. writes one GLB with a named node per region, quantized + meshopt-compressed.
//   The source body is unclothed; removeGroin() replaces the external genitals on the skin
//   with a smooth mannequin-like surface (it's a health demo, not an anatomy atlas).
// Needs the `unzip` command (Linux/macOS).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Document, NodeIO } from "@gltf-transform/core";
import { EXTMeshoptCompression, KHRMeshQuantization } from "@gltf-transform/extensions";
import { meshopt } from "@gltf-transform/functions";
import { MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CACHE = path.join(ROOT, ".anatomy-cache");
const OUT = path.join(ROOT, "public", "models", "anatomy.glb");
const BASE = "https://dbarchive.biosciencedbc.jp/data/bodyparts3d/LATEST";
const ZIP = "isa_BP3D_4.0_obj_99.zip";

// App region → anatomy concepts (FMA ids) and a triangle budget. `immune` is drawn as
// the lungs -- the same stand-in the old procedural twin used (temperature/symptoms map
// to the immune system in config/content.json).
const REGIONS = [
  { name: "skeleton", table: "isa", concepts: ["FMA5018"], tris: 170_000 }, // bone organ
  { name: "skeleton_wire", table: "isa", concepts: ["FMA5018"], tris: 26_000 }, // low-poly copy for the wireframe overlay
  { name: "muscles", table: "isa", concepts: ["FMA5022"], tris: 70_000 }, // muscle organ
  { name: "skin", table: "partof", concepts: ["FMA7163"], tris: 16_000 },
  { name: "brain", table: "partof", concepts: ["FMA50801"], tris: 20_000 },
  { name: "eyes", table: "partof", concepts: ["FMA12514", "FMA12515"], tris: 3_000 },
  { name: "heart", table: "partof", concepts: ["FMA7088"], tris: 12_000 },
  { name: "immune", table: "partof", concepts: ["FMA7309", "FMA7310"], tris: 20_000 }, // lungs
  { name: "stomach", table: "partof", concepts: ["FMA7148"], tris: 3_000 },
];

// The external genital organs (corpus cavernosum, corpus spongiosum, glans, both testes).
// They're never drawn; their bounding box marks the part of the skin removeGroin() replaces.
const GROIN_FILES = ["FJ3132", "FJ3133", "FJ3134", "FJ3138", "FJ3142"];

// Cut the external genitals out of the skin and close the hole with a smooth new patch,
// so the body reads like a plain mannequin. Raw source units: millimetres, Z-up, the body
// faces -Y (smaller y = further forward). Runs on the merged skin before simplify().
//   1. the cut: every skin vertex near the centre line, between just below the organs and
//      just above them, and in front of the perineum (the skin between the legs)
//   2. each hole left behind is filled with rings from its edge to its middle, relaxed
//      (each new vertex moved to the average of its neighbours, edge held still), then
//      faired so it carries on the curve of the skin around it -- a gentle mound
//   3. the patch gets its own normals, facing the same way as the skin around it
function removeGroin(skin, organs) {
  let xMax = 0, zMin = Infinity, zMax = -Infinity;
  for (let i = 0; i < organs.pos.length; i += 3) {
    xMax = Math.max(xMax, Math.abs(organs.pos[i]));
    zMin = Math.min(zMin, organs.pos[i + 2]);
    zMax = Math.max(zMax, organs.pos[i + 2]);
  }
  const { pos, nor, idx } = skin;
  const X = xMax + 6, zLo = zMin - 18, zHi = zMax + 11;
  // the perineum: how far forward the skin comes on the centre line just below the cut
  let perineum = Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    if (Math.abs(pos[i]) < 15 && pos[i + 2] > zLo - 20 && pos[i + 2] < zLo) perineum = Math.min(perineum, pos[i + 1]);
  }
  const Y = perineum - 15;
  const nV = pos.length / 3;
  const cut = new Uint8Array(nV);
  for (let v = 0; v < nV; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    if (Math.abs(x) < X && z > zLo && z < zHi && y < Y) cut[v] = 1;
  }
  const kept = [];
  for (let t = 0; t < idx.length; t += 3) {
    if (!cut[idx[t]] && !cut[idx[t + 1]] && !cut[idx[t + 2]]) kept.push(idx[t], idx[t + 1], idx[t + 2]);
  }
  // hole edges: directed edges of kept triangles whose reverse edge isn't in a kept triangle
  const key = (a, b) => a * nV + b;
  const edges = new Set();
  for (let t = 0; t < kept.length; t += 3) for (let k = 0; k < 3; k++) edges.add(key(kept[t + k], kept[t + (k + 1) % 3]));
  const next = new Map(); // hole loops walk the reverse direction: b -> a
  const seen = new Set();
  for (let t = 0; t < kept.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = kept[t + k], b = kept[t + (k + 1) % 3];
    if (!edges.has(key(b, a)) && touchesCut(a, b)) next.set(b, a);
  }
  function touchesCut(a, b) { // only holes the cut made, never the mesh's own open edges
    for (const v of [a, b]) {
      const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      if (Math.abs(x) < X + 12 && z > zLo - 12 && z < zHi + 12 && y < Y + 12) return true;
    }
    return false;
  }
  const loops = [];
  for (const startV of next.keys()) {
    if (seen.has(startV)) continue;
    const loop = [];
    let v = startV;
    while (v !== undefined && !seen.has(v)) { seen.add(v); loop.push(v); v = next.get(v); }
    if (v === startV && loop.length >= 3) loops.push(loop);
  }
  // fill each loop with RINGS rings of new vertices, then relax them
  const RINGS = 8, ITER = 200;
  const P = Array.from(pos), N = Array.from(nor), tris = kept.slice();
  let added = 0;
  for (const loop of loops) {
    const n = loop.length;
    const c = [0, 0, 0];
    for (const v of loop) for (let k = 0; k < 3; k++) c[k] += pos[v * 3 + k] / n;
    const ring = [loop]; // ring[0] = the hole's edge (fixed)
    for (let r = 1; r < RINGS; r++) {
      const t = r / RINGS, row = [];
      for (const v of loop) {
        row.push(P.length / 3);
        for (let k = 0; k < 3; k++) P.push(pos[v * 3 + k] * (1 - t) + c[k] * t);
        N.push(0, 0, 0);
      }
      ring.push(row);
    }
    const centre = P.length / 3;
    P.push(...c); N.push(0, 0, 0);
    const patch = [];
    for (let r = 0; r < RINGS - 1; r++) for (let i = 0; i < n; i++) {
      const a = ring[r][i], b = ring[r][(i + 1) % n], c2 = ring[r + 1][i], d = ring[r + 1][(i + 1) % n];
      patch.push(a, b, d, a, d, c2); // same winding as the loop (which runs opposite the kept edge)
    }
    for (let i = 0; i < n; i++) patch.push(ring[RINGS - 1][i], ring[RINGS - 1][(i + 1) % n], centre);
    // neighbours of every new vertex, then Laplacian relaxation with the edge held still
    const nb = new Map();
    for (let t = 0; t < patch.length; t += 3) for (let k = 0; k < 3; k++) {
      const a = patch[t + k], b = patch[t + (k + 1) % 3];
      for (const [u, w] of [[a, b], [b, a]]) { if (!nb.has(u)) nb.set(u, new Set()); nb.get(u).add(w); }
    }
    const free = [...nb.keys()].filter((v) => v >= nV);
    for (let it = 0; it < ITER; it++) for (const v of free) {
      const s3 = [0, 0, 0], ns = nb.get(v);
      for (const w of ns) for (let k = 0; k < 3; k++) s3[k] += P[w * 3 + k];
      for (let k = 0; k < 3; k++) P[v * 3 + k] = s3[k] / ns.size;
    }
    // That is a "soap film" (it sags). Bi-Laplacian fairing then bends it to carry on the
    // curvature of the skin around the hole, giving a gentle mound instead of a dip. The
    // edge vertices need their outside neighbours too, from the kept skin.
    for (let t = 0; t < kept.length; t += 3) for (let k = 0; k < 3; k++) {
      const a2 = kept[t + k], b2 = kept[t + (k + 1) % 3];
      if (nb.has(a2)) nb.get(a2).add(b2);
      if (nb.has(b2)) nb.get(b2).add(a2);
    }
    const lap = new Map();
    const lapOf = (v) => {
      const ns = nb.get(v), m = [0, 0, 0];
      for (const w of ns) for (let k = 0; k < 3; k++) m[k] += P[w * 3 + k] / ns.size;
      return [m[0] - P[v * 3], m[1] - P[v * 3 + 1], m[2] - P[v * 3 + 2]];
    };
    for (let it = 0; it < 400; it++) {
      for (const v of nb.keys()) lap.set(v, lapOf(v));
      for (const v of free) {
        const ns = nb.get(v), m = [0, 0, 0];
        for (const w of ns) { const lw = lap.get(w) || [0, 0, 0]; for (let k = 0; k < 3; k++) m[k] += lw[k] / ns.size; }
        const lv = lap.get(v);
        for (let k = 0; k < 3; k++) P[v * 3 + k] -= 0.2 * (m[k] - lv[k]);
      }
    }
    // patch normals: area-weighted face normals; flip the whole patch if it faces inwards
    let flip = 0;
    for (let t = 0; t < patch.length; t += 3) {
      const [a, b, c3] = [patch[t], patch[t + 1], patch[t + 2]];
      const e1 = [0, 1, 2].map((k) => P[b * 3 + k] - P[a * 3 + k]), e2 = [0, 1, 2].map((k) => P[c3 * 3 + k] - P[a * 3 + k]);
      const fn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      for (const v of [a, b, c3]) {
        if (v >= nV) for (let k = 0; k < 3; k++) N[v * 3 + k] += fn[k];
        else flip += fn[0] * nor[v * 3] + fn[1] * nor[v * 3 + 1] + fn[2] * nor[v * 3 + 2];
      }
    }
    if (flip < 0) {
      for (let t = 0; t < patch.length; t += 3) [patch[t + 1], patch[t + 2]] = [patch[t + 2], patch[t + 1]];
      for (const v of free) for (let k = 0; k < 3; k++) N[v * 3 + k] *= -1;
    }
    for (const v of free) {
      const len = Math.hypot(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]) || 1;
      for (let k = 0; k < 3; k++) N[v * 3 + k] /= len;
    }
    tris.push(...patch);
    added += free.length;
  }
  console.log(`groin         cut ${cut.reduce((a, b) => a + b, 0)} skin vertices, filled ${loops.length} hole(s) (${loops.map((l) => l.length).join(", ")} edge vertices) with ${added} new ones`);
  return { pos: new Float32Array(P), nor: new Float32Array(N), idx: new Uint32Array(tris) };
}

async function download(file) {
  const dest = path.join(CACHE, file);
  if (fs.existsSync(dest)) return dest;
  console.log(`downloading ${file}…`);
  const res = await fetch(`${BASE}/${file}`);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

function readTable(file) {
  const byConcept = new Map();
  for (const line of fs.readFileSync(path.join(CACHE, file), "utf8").split("\n").slice(1)) {
    const [concept, , fj] = line.trim().split("\t");
    if (!fj) continue;
    if (!byConcept.has(concept)) byConcept.set(concept, new Set());
    byConcept.get(concept).add(fj);
  }
  return byConcept;
}

// OBJ from BodyParts3D: "v x y z", "vn x y z", "f a//a b//b c//c" (1-based, v and vn share
// indices). Returns flat arrays.
function parseObj(text) {
  const pos = [];
  const nor = [];
  const idx = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("v ")) {
      const p = line.split(/\s+/);
      pos.push(+p[1], +p[2], +p[3]);
    } else if (line.startsWith("vn ")) {
      const p = line.split(/\s+/);
      nor.push(+p[1], +p[2], +p[3]);
    } else if (line.startsWith("f ")) {
      const verts = line.trim().split(/\s+/).slice(1).map((t) => parseInt(t, 10) - 1);
      for (let i = 1; i + 1 < verts.length; i++) idx.push(verts[0], verts[i], verts[i + 1]);
    }
  }
  return { pos, nor: nor.length === pos.length ? nor : null, idx };
}

function mergeRegion(files, dir) {
  const pos = [];
  const nor = [];
  const idx = [];
  for (const fj of files) {
    const f = path.join(dir, `${fj}.obj`);
    if (!fs.existsSync(f)) continue;
    const m = parseObj(fs.readFileSync(f, "latin1"));
    const base = pos.length / 3;
    // plain loops, not push(...big) -- spreading 300k numbers blows the call stack
    for (let i = 0; i < m.pos.length; i++) { pos.push(m.pos[i]); nor.push(m.nor ? m.nor[i] : 0); }
    for (const i of m.idx) idx.push(i + base);
  }
  return { pos: new Float32Array(pos), nor: new Float32Array(nor), idx: new Uint32Array(idx) };
}

function simplify(mesh, tris) {
  const target = Math.min(mesh.idx.length, tris * 3);
  let idx = mesh.idx;
  if (target < mesh.idx.length) {
    [idx] = MeshoptSimplifier.simplify(mesh.idx, mesh.pos, 3, target, 0.02, ["Prune"]);
    if (idx.length > target * 1.25) {
      // couldn't reach the budget while keeping topology -- fall back to a sloppier pass
      [idx] = MeshoptSimplifier.simplifySloppy(mesh.idx, mesh.pos, 3, null, target, 0.05);
    }
  }
  idx = new Uint32Array(idx);
  const [remap, unique] = MeshoptSimplifier.compactMesh(idx);
  const pos = new Float32Array(unique * 3);
  const nor = new Float32Array(unique * 3);
  for (let v = 0; v < remap.length; v++) {
    const n = remap[v];
    if (n === 0xffffffff || n >= unique) continue;
    pos.set(mesh.pos.subarray(v * 3, v * 3 + 3), n * 3);
    nor.set(mesh.nor.subarray(v * 3, v * 3 + 3), n * 3);
  }
  return { pos, nor, idx };
}

// mm, Z-up, facing -Y  →  metres, Y-up, facing +Z (towards a default three.js camera).
function toWorld(mesh, center) {
  const { pos, nor } = mesh;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    pos[i] = (x - center.x) / 1000;
    pos[i + 1] = (z - center.zMin) / 1000;
    pos[i + 2] = -(y - center.y) / 1000;
    const nx = nor[i], ny = nor[i + 1], nz = nor[i + 2];
    const len = Math.hypot(nx, ny, nz) || 1;
    nor[i] = nx / len;
    nor[i + 1] = nz / len;
    nor[i + 2] = -ny / len;
  }
  return mesh;
}

async function main() {
  fs.mkdirSync(CACHE, { recursive: true });
  for (const f of ["isa_element_parts.txt", "partof_element_parts.txt", ZIP]) await download(f);
  const tables = { isa: readTable("isa_element_parts.txt"), partof: readTable("partof_element_parts.txt") };

  const wanted = new Set();
  for (const r of REGIONS) {
    r.files = new Set(r.concepts.flatMap((c) => [...(tables[r.table].get(c) || [])]));
    r.files.forEach((f) => wanted.add(f));
  }
  GROIN_FILES.forEach((f) => wanted.add(f));

  const dir = path.join(CACHE, "obj");
  fs.mkdirSync(dir, { recursive: true });
  const missing = [...wanted].filter((f) => !fs.existsSync(path.join(dir, `${f}.obj`)));
  if (missing.length) {
    console.log(`extracting ${missing.length} meshes…`);
    const zipPath = path.join(CACHE, ZIP);
    const folder = ZIP.replace(".zip", "");
    for (let i = 0; i < missing.length; i += 200) {
      const names = missing.slice(i, i + 200).map((f) => `${folder}/${f}.obj`);
      execFileSync("unzip", ["-j", "-o", "-q", zipPath, ...names, "-d", dir], { stdio: "inherit" });
    }
  }

  await MeshoptSimplifier.ready;
  await MeshoptEncoder.ready;

  // Centre on the skin's footprint, feet at y = 0.
  const skin = mergeRegion(REGIONS.find((r) => r.name === "skin").files, dir);
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity, zMin = Infinity;
  for (let i = 0; i < skin.pos.length; i += 3) {
    xMin = Math.min(xMin, skin.pos[i]); xMax = Math.max(xMax, skin.pos[i]);
    yMin = Math.min(yMin, skin.pos[i + 1]); yMax = Math.max(yMax, skin.pos[i + 1]);
    zMin = Math.min(zMin, skin.pos[i + 2]);
  }
  const center = { x: (xMin + xMax) / 2, y: (yMin + yMax) / 2, zMin };
  const skinClean = removeGroin(skin, mergeRegion(GROIN_FILES, dir)); // after centring, so the model doesn't move

  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene("anatomy");
  for (const r of REGIONS) {
    const merged = r.name === "skin" ? skinClean : mergeRegion(r.files, dir);
    if (!merged.idx.length) throw new Error(`${r.name}: no meshes found`);
    const m = toWorld(simplify(merged, r.tris), center);
    console.log(`${r.name.padEnd(14)} ${String(r.files.size).padStart(4)} meshes  ${String(merged.idx.length / 3).padStart(8)} → ${String(m.idx.length / 3).padStart(7)} triangles`);
    const prim = doc.createPrimitive()
      .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(m.pos).setBuffer(buffer))
      .setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(m.nor).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType("SCALAR").setArray(m.idx).setBuffer(buffer));
    scene.addChild(doc.createNode(r.name).setMesh(doc.createMesh(r.name).addPrimitive(prim)));
  }
  doc.getRoot().getAsset().copyright =
    "BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0 International";

  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: "medium" }));
  const io = new NodeIO()
    .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
    .registerDependencies({ "meshopt.encoder": MeshoptEncoder });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await io.write(OUT, doc);
  console.log(`wrote ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1e6).toFixed(2)} MB)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
