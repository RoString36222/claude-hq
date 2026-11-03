"""HQ townships (City Gen v5 HQ lots, 88 x 56 m: backend/src/worldgen/v5/doc.rs HQ_LOT_W x HQ_LOT_D and lot.gates), the client.

Under node with the real modules (games/hqcityparts.js townPlan, townBuild via lotMarks, dressPlan's township finish,
gateText, boomStep; games/hqcity3d.js townOf / garagePlace / garageFits; games/hqnav.js Go to) on a township lot placed as
hqcity3d places it, straight and turned 30 degrees, its gates as the generator writes them:
  - only a township-sized lot is one (an older 36 x 34 m lot keeps its kerb and plaque);
  - the wall closes the lot all round but for its two gateways (the way in at -x, the doc's spots), and the drive runs
    from gate to gate round the HQ: walking or driving, the street reaches the HQ's door only through a gate;
  - the finish (trees, lit lamps, fountains, parked cars, more the posher) and the garage stay off the drive;
  - the arch reads the HQ's name as it is (no "HQ's HQ"), drawn on a canvas: control characters gone, long names cut;
  - the booms lift for a vehicle near the gate (at once under Calm) and nothing in the township code writes HTML;
  - Go to an HQ ends on the street at its way in, and nothing parks or stands in a gateway's way (world.js gateNear);
  - a built township costs a bounded number of draws once merged.
Stdlib only; skipped without node."""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

HARNESS = r"""
import fs from "fs";
const root = %(root)s;
globalThis.window = {HQV: {}};
const HQV = window.HQV;
for (const f of ["hqstyle", "hqtower", "hqbase", "world", "hqcityparts", "hqcity", "hqmerge", "hqnav", "hqcarlift", "hqcity3d"])
  new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const C3 = HQV.hqCity3d, P = HQV.hqCityParts, T = P.TOWN;
function hashStr(s){ var h = 2166136261 >>> 0; s = String(s); for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function rng(seed){ var a = seed >>> 0 || 1; return function(){ a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0)/4294967296; }; }
const rngOf = k => rng(hashStr(k));
// a township as the generator writes it (cm): 88 m along its street, 56 m deep, centred at (100, 200) m, turned th, its gates
// GATE_IN_CM (6.5 m) in from each side on its front edge, the way in at its -x side
function township(th, id){
  const fx = Math.sin(th), fz = Math.cos(th), ax = fz, az = -fx;
  const at = (a, b) => [Math.round(10000 + a*ax + b*fx), Math.round(20000 + a*az + b*fz)];
  const front = [Math.round(fx*65536), Math.round(fz*65536)];
  return {id: id, kind: "hq", rank: id, x: 10000, z: 20000, w: 8800, d: 5600, front: front, door: [at(0, 2800)[0], 0, at(0, 2800)[1]],
    poly: [at(-4400, 2800), at(4400, 2800), at(4400, -2800), at(-4400, -2800)].reverse(),
    gates: [{x: at(-3750, 2800)[0], z: at(-3750, 2800)[1], dir: front, kind: "in", w: 700}, {x: at(3750, 2800)[0], z: at(3750, 2800)[1], dir: front, kind: "out", w: 700}]};
}
function inBox(K, x, z, m){ return Math.abs(x - K[0]) < K[2] + (m || 0) && Math.abs(z - K[1]) < K[3] + (m || 0); }
function inRing(R, x, z){ var c = false; for(var i = 0, j = R.length - 1; i < R.length; j = i++){ var a = R[i], b = R[j]; if((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0])*(z - a[1])/(b[1] - a[1]) + a[0]) c = !c; } return c; }
const out = {};
// 1. which lots are townships
const small = {id: 1, kind: "hq", rank: 0, x: 10000, z: 20000, w: 3600, d: 3400, front: [0, 65536], door: [10000, 0, 21700],
  poly: [[8200, 18300], [11800, 18300], [11800, 21700], [8200, 21700]]};
const sp = C3.placeLot(small);
out.small = P.townPlan(C3.lotRing(small, sp), null, 2) === null;
// 2. the plan, straight and turned
function plan(th){
  const l = township(th, 3), p = C3.placeLot(l), R = C3.lotRing(l, p), G = P.townGates(l, p), TP = P.townPlan(R, G, 3);
  // the walk: a 0.5 m grid flood from the street (2 m past the front edge) over what the plan blocks, inside the lot or on its street
  const b = {x0: Math.min(...R.map(q => q[0])), x1: Math.max(...R.map(q => q[0])), z0: Math.min(...R.map(q => q[1])), z1: Math.max(...R.map(q => q[1]))};
  const S = 0.5, blocked = (x, z) => P.dressBlocked({blocks: TP.blocks}, x, z);
  const ok = (x, z) => x > b.x0 - 3 && x < b.x1 + 3 && z > b.z0 - 3 && z < b.z1 + 4 && !blocked(x, z) && (inRing(R, x, z) || z >= b.z1 - 1e-9);
  const key = (i, j) => i + "," + j, seen = {}, q = [];
  const start = [Math.round(0/S), Math.round((b.z1 + 2)/S)]; seen[key(...start)] = 1; q.push(start);
  while(q.length){ const [i, j] = q.pop(); [[1,0],[-1,0],[0,1],[0,-1]].forEach(([di, dj]) => { const a = i + di, c = j + dj, k = key(a, c);
    if(seen[k] || !ok(a*S, c*S)) return; seen[k] = 1; q.push([a, c]); }); }
  // the HQ's door (in front of its middle) reached, and every step into the lot taken through a gateway
  const door = seen[key(0, Math.round((C3.HQ_DOOR + 1)/S))];
  let through = 0, wallGaps = 0;
  for(let x = b.x0 + 0.5; x < b.x1 - 0.5; x += 0.25){ const z = b.z1 - T.wallIn - T.wallT/2;
    if(!blocked(x, z)){ wallGaps++; if(!TP.gates.some(g => Math.abs(x - g.x) <= T.gateW/2 + 0.01)) through++; } }
  let sides = 0;
  for(let z = b.z0 + 0.5; z < b.z1 - 0.5; z += 0.25) [b.x0 + T.wallIn + T.wallT/2, b.x1 - T.wallIn - T.wallT/2].forEach(x => { if(!blocked(x, z)) sides++; });
  for(let x = b.x0 + 0.5; x < b.x1 - 0.5; x += 0.25) if(!blocked(x, b.z0 + T.wallIn + T.wallT/2)) sides++;
  // the drive joins the gates: every lane's box overlaps the next round the loop
  const lanes = TP.lanes, touch = (A, B) => Math.abs(A[0] - B[0]) <= A[2] + B[2] + 1e-6 && Math.abs(A[1] - B[1]) <= A[3] + B[3] + 1e-6;
  const linked = lanes.every(A => lanes.some(B => B !== A && touch(A, B)));
  const gateLanes = TP.gates.map(g => lanes.some(L => Math.abs(L[0] - g.x) < 0.01 && L[1] + L[3] >= b.z1 - 1e-6));
  // the garage and the finish off the drive
  const grand = C3.grandOf(l, p), gar = C3.garagePlace(l, p, 2, grand), GW = HQV.hqLotExtras.garage;
  const garOnDrive = !!gar && TP.keep.some(K => inBox(K, gar.x, gar.z, Math.min(GW.w, GW.d)/2));
  const fitsOnDrive = C3.garageFits(l, p, {x: TP.gates[0].x, z: (TP.zb + TP.zf)/2, r: 0}, grand);
  const keep = C3.lotKeep(grand, gar).concat(TP.keep), dress = {};
  [1, 10, 25, 40].forEach(L => {
    const tier = P.dressTier(L), TPt = P.townPlan(R, G, tier), pl = P.dressPlan(R, L, "user-a", C3.lotKeep(grand, gar).concat(TPt.keep), rngOf, TPt), k = {};
    let onDrive = 0, outside = 0;
    pl.forEach(o => { k[o.kind] = (k[o.kind] || 0) + 1; if(o.kind === "lawn" || o.kind === "forecourt") return;
      if(!inRing(R, o.x, o.z)) outside++;
      if(TPt.lanes.some(L2 => inBox(L2, o.x, o.z, o.kind === "car" ? -0.01 : 0)) ) onDrive++; });
    dress[L] = {tier, kinds: k, onDrive, outside, booth: !!TPt.booth, same: JSON.stringify(pl) === JSON.stringify(P.dressPlan(R, L, "user-a", C3.lotKeep(grand, gar).concat(TPt.keep), rngOf, TPt))};
  });
  return {rot: p.rot, gates: TP.gates.map(g => ({kind: g.kind, x: +g.x.toFixed(2), z: +g.z.toFixed(2)})), bounds: b, door: !!door, through, wallGaps, sides,
    linked, gateLanes, garage: !!gar, garOnDrive, fitsOnDrive: fitsOnDrive.why, dress, grand,
    nav: HQV.hqnav.places({sites: [], lots: [l]}, 5, {hqs: [{userId: "u1", name: "Lena HQ", lot: l}]})[0]};
}
out.straight = plan(0);
out.turned = plan(Math.PI/6);
const tl = township(Math.PI/6, 4);
out.turnedGateWorld = tl.gates.map(g => [g.x/100, g.z/100]);
out.free = P.townPlan(C3.lotRing(tl, C3.placeLot(tl)), null, -1);
// the street keeps out of a gateway's way (games/world.js gateNear: parked cars, lamps, benches)
const tw = township(Math.PI/4, 9), g0 = tw.gates[0];
out.gateNear = [HQV.world.gateNear({lots: [tw]}, g0.x/100 + 3, g0.z/100 - 4, 12), HQV.world.gateNear({lots: [tw]}, g0.x/100 + 30, g0.z/100, 12),
  HQV.world.gateNear({lots: [small]}, small.x/100, small.z/100, 50)];
// 3. the words
out.words = {
  name: P.gateText("Lena HQ", 12, false), sign: P.gateText("Bob's HQ", 3, false), mine: P.gateText("Ada HQ", 2, true), free: P.gateText("", 7, false),
  out: P.gateText("Lena HQ", 12, false, "out"), freeOut: P.gateText("", 7, false, "out"),
  ctrl: P.gateText("Eve\n\u0007<b>HQ</b> x", 1, false).title,
  long: P.gateText("A very long HQ name that goes on and on and on forever", 1, false).title,
  odd: [P.gateText(null, 0, false), P.gateText(42, -3, false)]};
// 4. the booms
const bm = [{g: {rotation: {z: 0}}, x: 0, z: 0, a: 0}];
P.boomStep(bm, [{x: 2, z: 3}], 0.2, false); out.boomHalf = bm[0].a;
P.boomStep(bm, [{x: 2, z: 3}], 5, false); out.boomOpen = [bm[0].a, +bm[0].g.rotation.z.toFixed(3)];
P.boomStep(bm, [{x: 40, z: 3}], 0.1, true); out.boomCalm = bm[0].a;
P.boomStep(bm, [], 0.1, false); out.boomIdle = bm[0].a;
// 5. built: three.js, a stub ctx; the meshes it adds, and the draws once merged
const THREE = await import(root + "/games/vendor/three-module.js");
const texts = [];
var noop2d = new Proxy({}, {get(t, k){ return k === "measureText" ? function(s){ return {width: String(s).length*20}; } : k === "fillText" ? function(s){ texts.push(String(s)); } : function(){ return {addColorStop(){}}; }; }, set(){ return true; }});
const MC = {};
function mat(c, o){ const k = JSON.stringify([c, o || {}]); return MC[k] || (MC[k] = new THREE.MeshStandardMaterial(Object.assign({color: c}, o || {}))); }
function add(o, x, y, z, p){ o.position.set(x, y, z); p.add(o); return o; }
var c = {THREE: THREE, PI: Math.PI, mat: mat, COL: {cyan: 0x5fd3e6}, rng: s => rng(s), hashStr: hashStr,
  box(w, h, d, m, x, y, z, p){ return add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m), x, y, z, p); },
  cyl(r0, r1, h, m, x, y, z, p, n){ return add(new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, h, n || 8), m), x, y, z, p); },
  sph(r, m, x, y, z, p){ return add(new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), m), x, y, z, p); },
  add: add,
  canvasTex(w, h, draw){ if(draw) draw(noop2d, w, h); return {c: null, g: noop2d, t: new THREE.Texture()}; },
  glow(col){ return new THREE.Sprite(new THREE.SpriteMaterial({color: col})); }};
function draws(g){ let n = 0; g.traverse(o => { if(o.visible && (o.isMesh || o.isSprite)) n += Array.isArray(o.material) ? o.material.length : 1; }); return n; }
function built(lvl, owner, mine){
  const l = township(0, 5), p = C3.placeLot(l), R = C3.lotRing(l, p), tier = owner ? P.dressTier(lvl) : -1, TP = P.townPlan(R, P.townGates(l, p), tier);
  const g = new THREE.Group(); texts.length = 0;
  const M = P.lotMarks(c, g, R, {n: 6, owner: owner, mine: mine, keep: [], night: false, town: TP, name: owner});
  const before = draws(g), roots = {}; M.booms.forEach(b => { roots[b.g.uuid] = 1; });
  HQV.hqMerge.mergeStatic(THREE, g, {keep: o => { for(let q = o; q && q !== g; q = q.parent) if(roots[q.uuid]) return true; return false; }});
  return {before, after: draws(g), booms: M.booms.length, blocks: M.blocks.length, panel: !!M.panel, texts: texts.slice(), kerb: M.plan.kerb, near: M.near.length};
}
out.built = {free: built(0, "", false), theirs: built(40, "Lena HQ", false), mine: built(10, "Ada HQ", true)};
console.log(JSON.stringify(out));
"""


def node(src):
    r = subprocess.run([NODE, "--input-type=module", "-e", src], capture_output=True, text=True, timeout=300, cwd=ROOT)
    if r.returncode != 0:
        raise AssertionError(r.stderr[-4000:])
    return json.loads(r.stdout.strip().splitlines()[-1])


@unittest.skipUnless(NODE, "node missing")
class Townships(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = node(HARNESS % {"root": json.dumps(ROOT)})

    def test_only_a_township_sized_lot_is_one(self):
        self.assertTrue(self.o["small"])
        self.assertIsNotNone(self.o["free"])
        self.assertIsNone(self.o["free"]["booth"])

    def test_gates_where_the_doc_puts_them(self):
        for k in ("straight", "turned"):
            g = self.o[k]["gates"]
            self.assertEqual([x["kind"] for x in g], ["in", "out"])
            # 6.5 m in from each side of the 88 m front (the lot frame: the HQ's middle 2 m in front of the lot's)
            self.assertAlmostEqual(g[0]["x"], -37.5, places=1, msg=k)
            self.assertAlmostEqual(g[1]["x"], 37.5, places=1, msg=k)
            self.assertAlmostEqual(g[0]["z"], 26, places=1, msg=k)

    def test_the_wall_closes_the_lot_but_for_its_gates(self):
        for k in ("straight", "turned"):
            o = self.o[k]
            self.assertEqual(o["through"], 0, k)            # no gap in the front wall outside a gateway
            self.assertGreater(o["wallGaps"], 40, k)        # the two 7 m gateways are open
            self.assertEqual(o["sides"], 0, k)              # the sides and back are closed

    def test_the_street_reaches_the_door_through_a_gate(self):
        for k in ("straight", "turned"):
            self.assertTrue(self.o[k]["door"], k)

    def test_the_drive_runs_gate_to_gate(self):
        for k in ("straight", "turned"):
            self.assertTrue(self.o[k]["linked"], k)
            self.assertEqual(self.o[k]["gateLanes"], [True, True], k)

    def test_garage_and_finish_keep_off_the_drive(self):
        for k in ("straight", "turned"):
            o = self.o[k]
            self.assertTrue(o["garage"], k)
            self.assertFalse(o["garOnDrive"], k)
            self.assertEqual(o["fitsOnDrive"], "on the drive", k)
            self.assertEqual(o["grand"], 1, k)              # the biggest HQ fits
            for lvl, d in o["dress"].items():
                self.assertEqual(d["onDrive"], 0, (k, lvl, d))
                self.assertEqual(d["outside"], 0, (k, lvl, d))
                self.assertTrue(d["same"], (k, lvl))

    def test_posher_by_tier(self):
        d = self.o["straight"]["dress"]
        cars = [d[str(L)]["kinds"].get("car", 0) for L in (1, 10, 25, 40)]
        self.assertEqual(cars, [2, 4, 6, 8])
        self.assertEqual([d[str(L)]["kinds"].get("fountain", 0) >= n for L, n in ((1, 0), (10, 0), (25, 1), (40, 2))], [True] * 4)
        self.assertEqual(d["1"]["kinds"].get("fountain", 0), 0)
        self.assertGreater(d["10"]["kinds"].get("lamp", 0), d["1"]["kinds"].get("lamp", 0))
        self.assertGreater(d["10"]["kinds"].get("tree", 0), d["1"]["kinds"].get("tree", 0))
        self.assertEqual([d[str(L)]["booth"] for L in (1, 10, 25, 40)], [False, False, True, True])

    def test_the_arch_reads_the_hq_name(self):
        w = self.o["words"]
        self.assertEqual(w["name"], {"title": "Lena HQ", "sub": "LOT 12", "kind": "in"})
        self.assertEqual(w["sign"]["title"], "Bob's HQ")    # never "Bob's HQ's HQ"
        self.assertEqual(w["mine"], {"title": "Ada HQ", "sub": "LOT 2 · YOUR HQ", "kind": "in"})
        self.assertEqual(w["free"], {"title": "Lot 7", "sub": "AVAILABLE", "kind": "in"})
        self.assertEqual(w["out"]["title"], "WAY OUT")
        self.assertEqual(w["freeOut"]["sub"], "LOT 7")
        # control characters and line breaks gone; markup kept as plain text (it is drawn on a canvas, never parsed)
        self.assertEqual(w["ctrl"], "Eve <b>HQ</b> x")
        self.assertLessEqual(len(w["long"]), 32)
        self.assertTrue(w["long"].endswith("…"))
        self.assertEqual(w["odd"][0]["title"], "Lot 1")
        self.assertEqual(w["odd"][1]["sub"], "AVAILABLE")

    def test_the_sign_is_drawn_from_the_name(self):
        b = self.o["built"]
        self.assertIn("Lena HQ", b["theirs"]["texts"])
        self.assertIn("WAY OUT", b["theirs"]["texts"])
        self.assertIn("Ada HQ", b["mine"]["texts"])
        self.assertIn("Lot 6", b["free"]["texts"])

    def test_booms_lift_for_a_vehicle(self):
        o = self.o
        self.assertGreater(o["boomHalf"], 0)
        self.assertLess(o["boomHalf"], 1)
        self.assertEqual(o["boomOpen"][0], 1)
        self.assertGreater(o["boomOpen"][1], 1.3)
        self.assertEqual(o["boomCalm"], 0)                  # Calm: down at once once nothing is near
        self.assertEqual(o["boomIdle"], 0)

    def test_built_township_draws_merge(self):
        for k, b in self.o["built"].items():
            self.assertIsNone(b["kerb"], k)
            self.assertEqual(b["booms"], 2, k)
            self.assertTrue(b["panel"], k)
            self.assertGreaterEqual(b["blocks"], 9, k)      # 7+ wall pieces, 4 pylons
            self.assertLess(b["after"], b["before"], k)
            self.assertLessEqual(b["after"], 40, (k, b))

    def test_go_to_ends_at_the_way_in(self):
        for k in ("straight", "turned"):
            n = self.o[k]["nav"]
            self.assertEqual(n["label"], "Lena HQ")
        n = self.o["turned"]["nav"]
        g = self.o["turnedGateWorld"][0]
        import math
        th = math.pi / 6
        self.assertAlmostEqual(n["door"]["x"], g[0] + 3 * math.sin(th), places=1)
        self.assertAlmostEqual(n["door"]["z"], g[1] + 3 * math.cos(th), places=1)

    def test_the_street_keeps_clear_of_gateways(self):
        self.assertEqual(self.o["gateNear"], [True, False, False])

    def test_no_html_from_the_township_code(self):
        with open(os.path.join(ROOT, "games", "hqcityparts.js"), encoding="utf-8") as f:
            src = f.read()
        start = src.index("/* ---------- a township:")
        body = src[start:src.index("HQV.hqCityParts =")]
        self.assertIsNone(re.search(r"innerHTML|outerHTML|insertAdjacentHTML|document\.write", body))


if __name__ == "__main__":
    unittest.main()
