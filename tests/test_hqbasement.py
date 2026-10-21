"""The Basement Garage, B1 (games/hqbasement.js, HQ 3.4).

node builds HQV.hqWorlds.basement against the vendored three.js and a stub hq3d ctx, alone (no car lift, garage
manager or effects) and with stub peers: the world registers and builds; the layout is the same for a uid every
time, with bays inside the bounds and not blocked; the starters keep their lot ids and stay, homed on their
plinths; only basement-homed, unparked owned vehicles are drawn (paint index -> the catalogue's hex); bays past
max are locked; the static draw calls stay under budget. Skipped when node is not installed. Stdlib only."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

HARNESS = r"""
import fs from "fs";
const root = %(root)s;
const THREE = await import(root + "/games/vendor/three-module.js");
const g2d = new Proxy({}, {get: (o, k) => k in o ? o[k] : () => ({addColorStop(){}, width: 10}), set: (o, k, v) => { o[k] = v; return true; }});
function makeCtx(uid, level){
  let tgt = null;
  const mat = (c, o) => new THREE.MeshStandardMaterial(Object.assign({color: c, roughness: 0.7, metalness: 0.08}, o || {}));
  const add = (o, x, y, z, p) => { o.position.set(x, y, z); (p || tgt).add(o); return o; };
  const mkModel = () => { const g = new THREE.Group(); g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 2), mat(0xff0000))); return {g}; };
  const c = {THREE, PI: Math.PI, E: {}, COL: {amber: 0xffb347, cyan: 0x4fe3ff}, HEX: {amber: "#ffb347", cyan: "#4fe3ff", ink: "#fff", muted: "#888"},
    mat, emis: (c0, e, ei, o) => mat(c0, o), add,
    box: (w, h, d, m, x, y, z, p) => add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m), x, y, z, p),
    cyl: (rt, rb, h, m, x, y, z, p, s) => add(new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, s || 20), m), x, y, z, p),
    sph: (r, m, x, y, z, p) => add(new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), m), x, y, z, p),
    canvasTex: (w, h, d) => { const t = new THREE.Texture(); if(d) d(g2d, w); return {t, g: g2d}; },
    screen: (w, h, t, tr) => new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({map: t, transparent: !!tr})),
    glow: (col, sz, op) => new THREE.Sprite(new THREE.SpriteMaterial({color: col, transparent: true, opacity: op})),
    label: () => new THREE.Sprite(new THREE.SpriteMaterial({transparent: true})),
    plant: () => null, rng: s => { let a = s >>> 0 || 1; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0)/4294967296; }; },
    hashStr: s => { let h = 2166136261 >>> 0; s = String(s); for(let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; },
    short: (s, n) => String(s).slice(0, n), rr(){}, car: mkModel, moto: mkModel, bike: mkModel,
    catalogue: () => ({vehicles: [{id: "bmw-m2", kind: "car", paints: [{hex: "#111111"}, {hex: "#22aa33"}, {hex: "#3355ff"}]}]}),
    level: () => level, look: () => ({sign: "Test HQ"}), api: {me: () => uid}, avatar: () => null, motion: () => ({ride: null})};
  return {c, setTgt: s => { tgt = s; }};
}
globalThis.window = {HQV: {}};
globalThis.document = undefined;
for(const f of ["hqmerge.js", "hqbasement.js"]) new Function(fs.readFileSync(root + "/games/" + f, "utf8"))();
const H = window.HQV, B = H.hqBasement, out = {};
function build(uid, level){ const {c, setTgt} = makeCtx(uid, level), w = {scene: new THREE.Scene(), name: "basement"}; setTgt(w.scene); return H.hqWorlds.basement(c, w) || w; }
// 1. alone
const w1 = build("user-a", 12);
out.registered = typeof H.hqWorlds.basement === "function";
out.camModes = w1.camModes; out.startMode = w1.startMode; out.ground = w1.groundY(3, 4);
out.camHit = w1.camHit({x: 0, y: 2, z: 0}, {x: 0, y: 6.2, z: 0});
out.doors = w1.doors.map(d => ({view: d.view, kind: d.kind || null, from: d.from || null}));
out.spawnFrom = Object.keys(w1.spawnFrom).sort();
out.starters = w1.bikes.map(b => ({id: b.id, stay: b.stay, kind: b.kind || null, atHome: b.home && Math.hypot(b.home.x - b.x, b.home.z - b.z) < 1e-9, plinth: b.plinth}));
// 2. deterministic layout, bays inside bounds and free
const L1 = B.layout(12), L2 = B.layout(12);
out.layoutSame = JSON.stringify(L1) === JSON.stringify(L2);
out.baysBad = L1.bays.filter(b => b.x < -32 || b.x > 32 || b.z < -20 || b.z > 20 || B.blockedAt(L1, b.x, b.z, true) || B.blockedAt(L1, b.x, b.z, false)).length;
out.spawnBlocked = ["city", "lobby"].filter(k => w1.blocked(w1.spawnFrom[k].x, w1.spawnFrom[k].z));
out.doorFrontsBlocked = w1.doors.filter(d => d.front && w1.blocked(d.front.x, d.front.z)).length;
out.plinthBlockedWalk = B.blockedAt(L1, L1.plinths[0].x, L1.plinths[0].z, false);
out.plinthBlockedRide = B.blockedAt(L1, L1.plinths[0].x, L1.plinths[0].z, true);
// 5. locked bays
out.max0 = B.basementMax(0); out.max20 = B.basementMax(20); out.max99 = B.basementMax(99);
out.lit3 = B.layout(3).bays.filter(b => b.lit).length; out.unlock = B.layout(3).bays.map(b => b.unlock);
out.litObj = B.layout({max: 6}).bays.filter(b => b.lit).length;
// 4. only basement-homed, unparked vehicles
const list = [{id: "v1", vehicle_id: "bmw-m2", paint: 1, parked: null}, {id: "v2", vehicle_id: "bmw-m2", paint: 2, parked: {world: "c", x: 1, z: 2, yaw: 0}},
              {id: "v3", vehicle_id: "bmw-m2", paint: 0, parked: null}, {id: "v4", vehicle_id: "bmw-m2", paint: 0, parked: null}];
const homes = {available: true, homes: {v1: {home: "basement", bay: 3}, v2: {home: "basement", bay: 4}, v3: {home: "carpark", bay: null}, v4: {home: "basement", bay: 3}}, basement: {max: 8, used: 3}};
out.rows = B.basementRows(list, homes, 8);
out.paint1 = B.paintHex({paints: [{hex: "#111111"}, {hex: "#22aa33"}]}, 1); out.paintStr = B.paintHex(null, "#0a0b0c"); out.paintBad = B.paintHex(null, 3);
// with stub peers: the manager and the garage feed the world
let mgrSubs = [], adoptCalls = [];
H.hqGarage = {mine: () => Promise.resolve(list), onChange: f => () => {}};
H.hqGarageMgr = {homes: () => Promise.resolve(homes), onChange: f => { mgrSubs.push(f); return () => {}; }, homeOf: id => (homes.homes[id] || {}).home || "carpark", bayOf: id => (homes.homes[id] || {}).bay ?? null,
                 transfer: (id, to) => { adoptCalls.push([id, to]); return Promise.reject({code: 409, msg: "basement full"}); }};
H.hqVehicleModels = {build: (c, e, hex) => { const g = new THREE.Group(); g.userData.hex = hex; return {g}; }};
const w2 = build("user-a", 12);
await new Promise(r => setTimeout(r, 20));
out.ownProps = w2.bikes.filter(b => /^own:/.test(b.id)).map(b => ({id: b.id, bay: b.bay, hex: b.rig.g.userData.hex, ownId: b.own.ownId, stay: b.stay}));
// the manager moves v1 to the carpark: its prop goes
mgrSubs.forEach(f => f({available: true, homes: {v4: {home: "basement", bay: 3}}, basement: {max: 8, used: 1}}));
out.afterMove = w2.bikes.filter(b => /^own:/.test(b.id)).map(b => b.id);
// adopt: a carried own:v3 lands on the pad and is homed (here the basement is full: it stays as visitor)
const carried = {g: new THREE.Group(), id: "own:v3", x: 0, z: 0, yaw: 0};
const res = B.adopt(w2, {id: "own:v3", B: carried});
out.adopt = {placed: res.placed, ownId: res.ownId, x: carried.x, z: carried.z, inBikes: w2.bikes.indexOf(carried) >= 0, calls: adoptCalls};
out.adoptFull = res.pending ? await res.pending : null;
out.adoptStarter = B.adopt(w2, {id: "lot:user-a:car", B: {g: new THREE.Group(), id: "lot:user-a:car"}}).ownId;
// 6. draw calls of the static group after the merge
out.drawCalls = w1.drawCalls();
// 3b. a second uid: the same ids pattern; update runs with Calm and normal k
for(const k of [0, 1]) for(let i = 0; i < 5; i++) w1.update(i*0.1, 0.1, k);
const yaws0 = w1.bikes.map(b => b.yaw);
for(let i = 0; i < 5; i++) w1.update(i*0.1, 0.1, 0);
out.calmStatic = JSON.stringify(yaws0) === JSON.stringify(w1.bikes.map(b => b.yaw));
out.nameFor = B.nameFor({look: {sign: "Neon Dreams"}});
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
class BasementTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        src = HARNESS % {"root": json.dumps(ROOT)}
        r = subprocess.run([NODE, "--input-type=module", "-e", src], capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_registers_alone(self):
        o = self.o
        self.assertTrue(o["registered"])
        self.assertEqual(o["camModes"], ["chase", "near", "fp", "classic", "photo"])
        self.assertEqual(o["startMode"], "chase")
        self.assertEqual(o["ground"], 0)
        self.assertLess(o["camHit"], 0.6)
        views = {(d["view"], d["kind"]) for d in o["doors"]}
        self.assertIn(("@base", "carlift"), views)
        self.assertIn(("@lobby", "lift"), views)
        self.assertIn("garage:open", {d["view"] for d in o["doors"]})
        self.assertEqual(o["spawnFrom"][:2], ["base", "city"])
        self.assertIn("lobby", o["spawnFrom"])

    def test_layout_deterministic_and_free(self):
        o = self.o
        self.assertTrue(o["layoutSame"])
        self.assertEqual(o["baysBad"], 0)
        self.assertEqual(o["spawnBlocked"], [])
        self.assertEqual(o["doorFrontsBlocked"], 0)
        self.assertTrue(o["plinthBlockedWalk"])
        self.assertFalse(o["plinthBlockedRide"])

    def test_starters(self):
        s = self.o["starters"]
        self.assertEqual([x["id"] for x in s], ["lot:user-a:car", "lot:user-a:moto", "lot:user-a:bike"])
        self.assertTrue(all(x["stay"] and x["atHome"] for x in s))
        self.assertEqual([x["kind"] for x in s], ["car", "moto", None])
        self.assertEqual([x["plinth"] for x in s], [0, 1, 2])

    def test_only_basement_unparked(self):
        o = self.o
        self.assertEqual([(r["id"], r["bay"]) for r in o["rows"]], [("v1", 3), ("v4", 0)])
        self.assertEqual(o["paint1"], 0x22AA33)
        self.assertEqual(o["paintStr"], 0x0A0B0C)
        self.assertEqual(o["paintBad"], 0x8A96A3)
        props = {p["id"]: p for p in o["ownProps"]}
        self.assertEqual(sorted(props), ["own:v1", "own:v4"])
        self.assertEqual(props["own:v1"]["hex"], 0x22AA33)
        self.assertEqual(props["own:v1"]["ownId"], "v1")
        self.assertEqual(o["afterMove"], ["own:v4"])

    def test_locked_bays(self):
        o = self.o
        self.assertEqual((o["max0"], o["max20"], o["max99"]), (4, 8, 12))
        self.assertEqual(o["lit3"], 4)
        self.assertEqual(o["litObj"], 6)
        self.assertEqual(o["unlock"][4], 5)
        self.assertEqual(o["unlock"][11], 40)

    def test_adopt(self):
        a = self.o["adopt"]
        self.assertTrue(a["placed"])
        self.assertEqual(a["ownId"], "v3")
        # 3.5.1: off the car lift it lands just off the pad (2.6 m clear of its edge), facing into B1, not on the
        # pad's trigger, so the first W drives you into the basement instead of back up the lift
        self.assertEqual((round(a["x"], 6), round(a["z"], 6)), (18.8, 6.5))
        self.assertTrue(a["inBikes"])
        self.assertEqual(a["calls"], [["v3", "basement"]])
        self.assertEqual(self.o["adoptFull"], {"ok": False, "full": True})
        self.assertIsNone(self.o["adoptStarter"])

    def test_draw_calls_and_calm(self):
        self.assertIsNotNone(self.o["drawCalls"])
        self.assertLess(self.o["drawCalls"], 40)
        self.assertTrue(self.o["calmStatic"])
        self.assertEqual(self.o["nameFor"], "Neon Dreams")


if __name__ == "__main__":
    unittest.main()
