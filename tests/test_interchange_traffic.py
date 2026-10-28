"""City Gen v4, phase 6 (HQ 3.29): traffic through the interchanges (games/traffic.js).

Under node, on the @3 Commons fixture with games/world.js, games/citylife.js and games/traffic.js:
  - the sim builds with no errors: every node has as many lanes in as out (traffic.js simLanes, the generator's
    interchange.rs sim_lanes);
  - a ramp (oneway) is driven a to b only, and the cars use the ramps and the flyovers;
  - an expressway's lanes are LANE_W apart out from its median, its shoulder beyond the kerb lane;
  - cars drive up on the decks, over 5 m above the land, and through the tunnel under the airport (3.30), 5 m under it;
  - an older doc without the oneway field still builds (an older dashboard sees two-way roads).
Skipped without node. Stdlib only."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

SCRIPT = r"""
var fs = require("fs"), zlib = require("zlib"), root = %(root)s;
global.window = {HQV: {}};
for (var f of ["world", "citylife", "traffic"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
var H = window.HQV, WD = H.world, T = H.traffic, out = {};
var raw = function(){ return JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/claude-hq@3.json.gz")).toString("utf8")); };
var doc = raw(), W = WD.pack(doc);
var s = T.create(WD.docOf(W), {tier: 5, seed: W.id, W: W, local: 0});
out.errors = s.info().errors; out.cars = s.info().cars;
var R = doc.layers.roads, byId = {};
R.edges.forEach(function(e){ byId[e.id] = e; });
out.ramps = R.edges.filter(function(e){ return e.v4 === "ramp"; }).length;
out.flyovers = R.edges.filter(function(e){ return e.v4 === "flyover"; }).length;
// lanes the rings drive
var used = {}, wrong = 0;
s._.rings.forEach(function(r){ r.lanes.forEach(function(l){
  var e = byId[l.e.id]; used[e.v4 || e["class"]] = (used[e.v4 || e["class"]] || 0) + 1;
  if(e.oneway && l.dir !== 0) wrong++;
}); });
out.used = used; out.wrongWay = wrong;
// an expressway's lanes from the median out
var ex = s._.edges.filter(function(E){ return E.lanesV4 && byId[E.id].v4 === "expressway" && E.cars; })[0];
out.offs = ex ? ex.carOffs : null; out.med = ex ? ex.med : null; out.k = ex ? ex.k : null; out.lanes = ex ? byId[ex.id].lanes : null;
// cars up on the decks: over the land by more than 5 m (the flyovers' spans, the top of the loops)
var D = Date.UTC(2026, 9, 27, 8), high = 0;
for (var t = 0; t < 900; t += 3) {
  s.at(D + t*1000, {x: 0, z: 0}, 1e9).forEach(function(c){ if(c.kind === "car" && c.y - WD.heightAt(W, c.x, c.z) > 5) high++; });
}
out.stacked = high;
// [3.30] and through the tunnel under the airport: more than 5 m under the land
var low = 0;
for (var t2 = 0; t2 < 900; t2 += 3) {
  s.at(D + t2*1000, {x: 0, z: 0}, 1e9).forEach(function(c){ if(c.kind === "car" && WD.heightAt(W, c.x, c.z) - c.y > 5) low++; });
}
out.under = low; out.tunnels = R.edges.filter(function(e){ return e.under === "tunnel"; }).length;
// an older doc: no oneway field
var old = raw(); old.layers.roads.edges.forEach(function(e){ delete e.oneway; });
var Wo = WD.pack(old), so = T.create(WD.docOf(Wo), {tier: 5, seed: Wo.id, W: Wo, local: 0});
out.oldErrors = so.info().errors; out.oldCars = so.info().cars;
out.simLanes = [T.simLanes({v4: "expressway", lanes: 3}), T.simLanes({v4: "expressway", lanes: 2}), T.simLanes({v4: "ramp", lanes: 1}), T.simLanes({v4: "flyover", lanes: 1}), T.simLanes({v4: "avenue", lanes: 2}), T.simLanes({})];
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class InterchangeTraffic(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", SCRIPT % {"root": json.dumps(ROOT)}], capture_output=True, text=True, timeout=900)
        if r.returncode != 0:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_every_node_balances_and_the_sim_builds(self):
        self.assertEqual(self.o["errors"], [])
        self.assertGreater(self.o["cars"], 150)
        self.assertEqual(self.o["simLanes"], [2, 1, 1, 1, 1, 1])

    def test_ramps_one_way_and_driven(self):
        self.assertGreaterEqual(self.o["flyovers"], 2)
        self.assertEqual(self.o["ramps"], 4 * self.o["flyovers"])
        self.assertEqual(self.o["wrongWay"], 0)
        self.assertGreaterEqual(self.o["used"].get("ramp", 0), self.o["ramps"])
        self.assertGreaterEqual(self.o["used"].get("flyover", 0), 2 * self.o["flyovers"])

    def test_expressway_lanes_from_the_median_out(self):
        offs, med = self.o["offs"], self.o["med"]
        self.assertEqual(self.o["k"], self.o["lanes"] - 1)
        # the kerb lane is the outermost of its three 3.5 m lanes, the next 3.5 m in (the one by the median kept free)
        self.assertAlmostEqual(offs[0], med + 3 * 3.5 - 1.75, places=3)
        self.assertAlmostEqual(offs[0] - offs[1], 3.5, places=3)

    def test_cars_drive_up_on_the_decks(self):
        self.assertGreater(self.o["stacked"], 0)

    def test_cars_drive_through_the_tunnel(self):
        self.assertEqual(self.o["tunnels"], 1)
        self.assertGreater(self.o["under"], 0)

    def test_an_older_doc_still_builds(self):
        self.assertEqual(self.o["oldErrors"], [])
        self.assertGreater(self.o["oldCars"], 100)


if __name__ == "__main__":
    unittest.main()
