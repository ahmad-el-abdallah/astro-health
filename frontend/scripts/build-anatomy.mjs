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

  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene("anatomy");
  for (const r of REGIONS) {
    const merged = r.name === "skin" ? skin : mergeRegion(r.files, dir);
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
