// Normalise a downloaded vehicle model for the 3D City (called by tools/vehicle_fetch.py).
//
//   node tools/vehicle_import.mjs IN.glb --bbox                    -> {"bbox": {min, max}, "tris": n}
//   node tools/vehicle_import.mjs IN.glb OUT.glb --plan '<json>' --kind car|bike --budget 15000
//        plan = vehicle_fetch.plan_transform(...) plus "ratio" (vehicle_fetch.decimate_ratio): the maths lives
//        in Python, where tests/test_vehicle_fetch.py checks it; this file only applies it.
//   -> last stdout line: {"tris", "bytes", "wheels": [names], "paintMaterial"}
//
// What OUT gets: one root node "vehicle" (scale, the turn to +z forward, standing on y = 0, centred on x/z),
// wheels renamed wheel_FL / wheel_FR / wheel_RL / wheel_RR (bikes: wheel_F / wheel_R) by where they stand
// (model +x is LEFT, +z forward, as the City's frames), the body's main material renamed "paint" (the
// dealership recolours it), meshes welded and simplified under the triangle budget, textures at most 1024 px,
// vertex data quantised (KHR_mesh_quantization: three's GLTFLoader reads it with no decoder).
//
// The glTF tooling (@gltf-transform, meshoptimizer for the simplifier, sharp for textures) is installed on
// first use into ~/.cache/claude-hq-vehicle-tools (HQ_VEHICLE_TOOLS), never into the repo.
import { createRequire } from "module";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const CACHE = process.env.HQ_VEHICLE_TOOLS || path.join(os.homedir(), ".cache", "claude-hq-vehicle-tools");
const PKGS = ["@gltf-transform/core@4", "@gltf-transform/extensions@4", "@gltf-transform/functions@4", "meshoptimizer@0.22", "sharp"];

function tools() {
  if (!fs.existsSync(path.join(CACHE, "node_modules", "@gltf-transform", "functions"))) {
    fs.mkdirSync(CACHE, { recursive: true });
    if (!fs.existsSync(path.join(CACHE, "package.json"))) fs.writeFileSync(path.join(CACHE, "package.json"), '{"private": true}\n');
    execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund", "--prefix", CACHE, ...PKGS], { stdio: ["ignore", "ignore", "inherit"] });
  }
  return createRequire(path.join(CACHE, "package.json"));
}

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(k);
const IN = args[0];

const req = tools();
const { NodeIO } = req("@gltf-transform/core");
const { ALL_EXTENSIONS } = req("@gltf-transform/extensions");
const F = req("@gltf-transform/functions");
const { MeshoptSimplifier } = req("meshoptimizer");
const sharp = req("sharp");

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(IN);
const root = doc.getRoot();
const scene = root.getDefaultScene() || root.listScenes()[0];

function tris() {
  let n = 0;
  for (const m of root.listMeshes()) for (const p of m.listPrimitives()) {
    const idx = p.getIndices(), pos = p.getAttribute("POSITION");
    if (p.getMode() !== 4) continue;                       // TRIANGLES only
    n += (idx ? idx.getCount() : pos ? pos.getCount() : 0) / 3;
  }
  return Math.round(n);
}

if (flag("--bbox")) {
  const b = F.getBounds(scene);
  console.log(JSON.stringify({ bbox: { min: b.min, max: b.max }, tris: tris() }));
  process.exit(0);
}

const OUT = args[1];
const plan = JSON.parse(opt("--plan"));
const kind = opt("--kind", "car");
const budget = +opt("--budget", 15000);

// 1. one root carrying the plan: p' = rotY(p * scale) + offset
const top = doc.createNode("vehicle")
  .setScale([plan.scale, plan.scale, plan.scale])
  .setRotation([0, Math.sin(plan.rotY / 2), 0, Math.cos(plan.rotY / 2)])
  .setTranslation(plan.offset);
for (const child of scene.listChildren()) { scene.removeChild(child); top.addChild(child); }
scene.addChild(top);

// 2. wheels, by name, then named by where they stand in the vehicle's frame
const WHEEL = /wheel|tire|tyre|rim\b|rims\b|felge|rueda|roue/i;
const wheels = [];
top.traverse((n) => {
  if (n === top || !WHEEL.test(n.getName() || "")) return;
  let p = n.getParentNode(), nested = false;
  while (p && p !== top) { if (WHEEL.test(p.getName() || "")) nested = true; p = p.getParentNode(); }
  if (nested) return;                                     // a wheel's own tyre/rim parts stay inside it
  const b = F.getBounds(n);
  wheels.push({ n, x: (b.min[0] + b.max[0]) / 2, z: (b.min[2] + b.max[2]) / 2 });
});
const named = [];
if (kind === "bike") {
  wheels.sort((a, b) => b.z - a.z);
  if (wheels.length >= 2) { wheels[0].n.setName("wheel_F"); wheels[wheels.length - 1].n.setName("wheel_R"); named.push("wheel_F", "wheel_R"); }
} else if (wheels.length >= 4) {
  for (const w of wheels) {
    const nm = "wheel_" + (w.z > 0 ? "F" : "R") + (w.x > 0 ? "L" : "R");
    if (!named.includes(nm)) { w.n.setName(nm); named.push(nm); }
  }
}

// 3. the paint: the material on the most triangles that is not glass, rubber, chrome, light or interior
const SKIP = /glass|window|tire|tyre|rubber|chrome|light|lamp|interior|seat|black|rim|wheel|mirror|plate|logo|badge/i;
const tri = new Map();
for (const m of root.listMeshes()) for (const p of m.listPrimitives()) {
  const mat = p.getMaterial(); if (!mat || SKIP.test(mat.getName() || "")) continue;
  const idx = p.getIndices(); tri.set(mat, (tri.get(mat) || 0) + (idx ? idx.getCount() : p.getAttribute("POSITION").getCount()) / 3);
}
let paint = null;
for (const [m, n] of tri) if (!paint || n > tri.get(paint)) paint = m;
const paintName = paint ? paint.getName() || "unnamed" : null;
if (paint) paint.setName("paint");

// 4. geometry: weld, simplify under the budget, tidy, textures, quantise
await MeshoptSimplifier.ready;
await doc.transform(F.dedup(), F.weld());
let ratio = plan.ratio ?? 1;
for (let i = 0; i < 4 && tris() > budget; i++) {
  await doc.transform(F.simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.002 * (i + 1) * (i + 1), lockBorder: false }));
  ratio = Math.max(0.01, ratio * 0.7);
}
await doc.transform(
  F.prune(), F.dedup(),
  F.textureCompress({ encoder: sharp, resize: [1024, 1024] }),
  F.quantize(),                                           // adds KHR_mesh_quantization itself
);
await io.write(OUT, doc);
console.log(JSON.stringify({ tris: tris(), bytes: fs.statSync(OUT).size, wheels: named, paintMaterial: paintName }));
