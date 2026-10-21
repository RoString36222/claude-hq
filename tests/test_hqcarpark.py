"""The multi-storey vehicle garage (games/hqcarpark.js, docs/plans/dealership-spec.md "The vehicle garage").

node lays out the Commons' and an island's garage (the generator's civic "carpark" site, from the fixtures) and
drives every path the calling part uses: a bay's exit (out to the aisle, along to the cross aisle, down the helix,
out of the front door) and its entry. The Python side checks the bays (inside the building, apart, the same every
time), the paths (no wall on the way, on a floor or the ramp all along, only ever down on the way out, ramps no
steeper than a real one, ending at a kerb on a road), the surfaces at a height, and the building's draw calls
with the vendored three.js. Skipped when node is not installed. Stdlib only."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

HARNESS = r"""
import fs from "fs";
import zlib from "zlib";
const root = %(root)s;
const THREE = await import(root + "/games/vendor/three-module.js");
globalThis.window = {HQV: {}};
for(const f of ["world.js", "hqnav.js", "hqmerge.js", "hqcarpark.js"]) new Function(fs.readFileSync(root + "/games/" + f, "utf8"))();
const WD = window.HQV.world, N = window.HQV.hqnav, C = window.HQV.hqCarpark;
const doc = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/" + f + ".json.gz")));
const out = {};
for(const [name, file, tier] of [["commons", "claude-hq@2", 5], ["island", "island@2", 5]]){
  const W = WD.pack(doc(file)), s = C.find(W), L = C.layout(s), B = C.bays(s), o = out[name] = {};
  o.levels = L.levels; o.W = L.W; o.D = L.D; o.n = B.length; o.perLevel = B.filter(b => b.level === 0).length;
  // bays: inside the walls, apart from one another on a level, the same on a second layout
  o.outside = 0; o.overlap = 0;
  for(const b of B){
    const p = C.toLocal(s, b.x, b.z);
    if(Math.abs(p.x) > L.W/2 - 1 || Math.abs(p.z) > L.D/2 - 1) o.outside++;
    if(C.blockedAt(s, b.x, b.z, b.y)) o.outside++;
  }
  for(let i = 0; i < B.length; i++) for(let j = i + 1; j < B.length; j++){
    const a = B[i], b = B[j];
    if(a.level === b.level && Math.hypot(a.x - b.x, a.z - b.z) < C.BAY_W - 0.01) o.overlap++;
  }
  o.same = JSON.stringify(B) === JSON.stringify(C.bays(Object.assign({}, s)));
  // assign: one bay each, the same whatever order the keys come in
  const keys = []; for(let i = 0; i < Math.min(40, B.length); i++) keys.push("user-" + (i %% 7) + ":veh-" + i);
  const A1 = C.assign(s, keys), A2 = C.assign(s, keys.slice().reverse());
  o.assignSame = keys.every(k => A1[k] != null && A1[k] === A2[k]);
  o.assignUnique = new Set(Object.values(A1)).size === keys.length;
  // bayFor: the bay assign() gives that one key; with its bay taken, another
  const bf = C.bayFor(s, "user-3", "veh-9"), a1 = C.assign(s, ["user-3:veh-9"])["user-3:veh-9"];
  o.bayForSame = bf.i === a1 && bf === B[a1];
  o.bayForTaken = C.bayFor(s, "user-3", "veh-9", [a1]).i !== a1;
  // the paths, from a bay on every level (both ends of each)
  const G = N.graph(W, tier), ent = C.entrance(s, G), raw = C.entrance(s);
  o.entranceToRoad = Math.hypot(ent.x - raw.door.x, ent.z - raw.door.z);
  o.paths = [];
  for(let l = 0; l < L.levels; l++){
    const lb = B.filter(b => b.level === l), pick = [lb[0], lb[lb.length - 1]];
    for(const b of pick){
      const P = C.exitPath(b), E = C.entryPath(b), r = {level: l, blocked: 0, offFloor: 0, up: 0, maxGrade: 0, maxGap: 0};
      r.startAtBay = Math.hypot(P[0].x - b.x, P[0].y - b.y, P[0].z - b.z);
      r.endAtDoor = Math.hypot(P[P.length - 1].x - raw.door.x, P[P.length - 1].z - raw.door.z);
      r.reversed = JSON.stringify(E) === JSON.stringify(P.slice().reverse());
      let y = P[0].y;
      for(let i = 1; i < P.length; i++){
        const a = P[i - 1], q = P[i], run = Math.hypot(q.x - a.x, q.z - a.z);
        r.maxGap = Math.max(r.maxGap, Math.hypot(run, q.y - a.y));
        if(q.y > a.y + 1e-9) r.up++;
        if(run > 0.5) r.maxGrade = Math.max(r.maxGrade, Math.abs(q.y - a.y)/run);
        const n = Math.max(1, Math.ceil(run/0.2));
        for(let k = 1; k <= n; k++){
          const x = a.x + (q.x - a.x)*k/n, z = a.z + (q.z - a.z)*k/n, py = a.y + (q.y - a.y)*k/n;
          const g = C.groundAt(s, x, z, y);
          if(g != null){ if(Math.abs(g - py) > 0.12) r.offFloor++; y = g; }
          if(C.blockedAt(s, x, z, py)) r.blocked++;
        }
      }
      o.paths.push(r);
    }
  }
  // the surfaces: a deck point at level 2 is level 2's floor from up there and the ground from below; the core and
  // the walls are solid; the street door is open on the ground floor only
  const lv = Math.min(2, L.levels - 1), deck = B.filter(b => b.level === lv)[0], H = L.H;
  o.floorHere = C.groundAt(s, deck.x, deck.z, deck.y + 0.3) - deck.y;
  o.floorBelow = C.groundAt(s, deck.x, deck.z, L.base) - L.base;
  const w = (lx, lz) => { const ux = L.ux, uz = L.uz; return {x: L.cx + lx*ux[0] + lz*uz[0], z: L.cz + lx*ux[1] + lz*uz[1]}; };
  const core = w(L.hx, L.hz), door = w(L.crossX, L.D/2 - 0.15), wall = w(L.crossX + L.crossW/2 + 2, L.D/2 - 0.15);
  o.coreBlocked = C.blockedAt(s, core.x, core.z, L.base);
  o.doorGround = C.blockedAt(s, door.x, door.z, L.base);
  o.doorUpstairs = C.blockedAt(s, door.x, door.z, L.base + H);
  o.wallGround = C.blockedAt(s, wall.x, wall.z, L.base);
  // the helix: half a turn up from level 1's landing is level 1.5
  const half = w(L.hx - L.rc, L.hz);
  o.helixHalf = (C.groundAt(s, half.x, half.z, L.base + 1.5*H) - L.base)/H;
  o.outsideNull = C.groundAt(s, L.cx + 500, L.cz + 500, 0) === null;
  // the building, with three.js: draw calls (the fleet: two instanced meshes, one vehicle in full near the camera)
  const catalogue = {vehicles: []};
  const Bd = C.build({THREE}, s, {night: true, catalogue: () => catalogue});
  o.drawBuilding = Bd.drawCalls();
  let tris = 0; Bd.g.traverse(m => { if(m.isMesh){ const g = m.geometry; tris += (g.index ? g.index.count : g.attributes.position.count)/3; } });
  o.tris = tris;
  const entry = {id: "x", class: "car.sedan.3000", dims: {lengthM: 4.8, widthM: 1.9, heightM: 1.45}, paints: [{name: "Blue", hex: "#1f4fbf"}]};
  const bike = {id: "y", class: "bike.naked.400", dims: {lengthM: 2.0, widthM: 0.8, heightM: 1.1}, paints: [{name: "Orange", hex: "#ff6a00"}]};
  const list = []; for(let i = 0; i < 30; i++) list.push({key: "p:" + i, entry: i %% 3 ? entry : bike, paint: 0});
  catalogue.vehicles.push(entry, bike);
  const rows = Bd.fleet(list);
  o.fleetRows = rows.length; o.drawFleet = Bd.drawCalls() - o.drawBuilding;
  // stored(): the calling part puts a vehicle back in a given bay; an unknown vehicle or garage is refused
  let free = B.findIndex((b, i) => !rows.some(r => r.bay === i)); const full = free < 0; if(full) free = rows[0].bay;
  const back = C.stored(s, B[free], {key: "me:car-7", vehicleId: "x", color: "#ff0000"});
  const R2 = Bd.rows(), st = R2.find(r => r.key === "me:car-7");
  o.stored = back && !!st && st.bay === free && R2.length === rows.length + (full ? 0 : 1) && new Set(R2.map(r => r.bay)).size === R2.length; o.storedUnknown = C.stored(s, B[free], {key: "me:z", vehicleId: "nope"});
  o.storedElsewhere = C.stored(Object.assign({}, s, {id: "carpark:9"}), B[free], {key: "me:z", vehicleId: "x"});
}
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class CarparkTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        src = HARNESS % {"root": json.dumps(ROOT)}
        r = subprocess.run([NODE, "--input-type=module", "-e", src], capture_output=True, text=True, timeout=180)
        if r.returncode != 0:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout)

    def each(self):
        return [(name, self.o[name]) for name in ("commons", "island")]

    def test_the_commons_has_the_biggest(self):
        c, i = self.o["commons"], self.o["island"]
        self.assertEqual(c["levels"], 6)
        self.assertEqual(i["levels"], 3)
        self.assertGreater(c["n"], 150)
        self.assertGreaterEqual(i["n"], 12, "an island's garage holds a fleet")

    def test_bays_inside_apart_and_deterministic(self):
        for _, o in self.each():
            self.assertEqual(o["outside"], 0)
            self.assertEqual(o["overlap"], 0)
            self.assertTrue(o["same"])

    def test_assign_is_one_bay_each_in_any_order(self):
        for _, o in self.each():
            self.assertTrue(o["assignSame"])
            self.assertTrue(o["assignUnique"])

    def test_exit_paths_drive(self):
        for _, o in self.each():
            self.assertEqual(len(o["paths"]), 2*o["levels"])
            for p in o["paths"]:
                self.assertEqual(p["blocked"], 0, p)
                self.assertEqual(p["offFloor"], 0, p)
                self.assertEqual(p["up"], 0, "only ever down on the way out: %s" % p)
                self.assertLessEqual(p["maxGrade"], 0.15, p)
                self.assertLess(p["startAtBay"], 1e-6)
                self.assertLess(p["endAtDoor"], 1e-6)
                self.assertTrue(p["reversed"], "the entry path is the exit path backwards")

    def test_the_entrance_is_on_a_road(self):
        for _, o in self.each():
            self.assertLess(o["entranceToRoad"], 15, "the door's kerb is by a road")

    def test_surfaces_at_a_height(self):
        for _, o in self.each():
            self.assertAlmostEqual(o["floorHere"], 0, places=6)
            self.assertAlmostEqual(o["floorBelow"], 0, places=6)
            self.assertTrue(o["coreBlocked"])
            self.assertFalse(o["doorGround"], "the street door is open on the ground floor")
            self.assertTrue(o["doorUpstairs"], "and a parapet upstairs")
            self.assertTrue(o["wallGround"])
            self.assertAlmostEqual(o["helixHalf"], 1.5, delta=0.02)
            self.assertTrue(o["outsideNull"])

    def test_bay_for_and_stored(self):
        for _, o in self.each():
            self.assertTrue(o["bayForSame"], "bayFor is assign() for one key")
            self.assertTrue(o["bayForTaken"])
            self.assertTrue(o["stored"], "a vehicle put back is parked in that bay")
            self.assertFalse(o["storedUnknown"])
            self.assertFalse(o["storedElsewhere"], "a garage that is not drawn")

    def test_draw_calls(self):
        for _, o in self.each():
            self.assertLessEqual(o["drawBuilding"], 12, "the building merged per material")
            self.assertLess(o["tris"], 120000)
            self.assertEqual(o["fleetRows"], min(30, o["n"]))
            self.assertLessEqual(o["drawFleet"], 2, "the parked fleet: one car and one bike InstancedMesh")


if __name__ == "__main__":
    unittest.main()
