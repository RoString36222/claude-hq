"""Big-city roads and solid buildings (HQ 3.20.1).

The @3 worlds pave each street at one of several widths (backend/src/worldgen/organic/widen.rs, its own Rust
test v3_streets_are_paved_by_tier). Here, on the @3 fixture under node: the streets come in several widths,
traffic on a road with two lanes each way drives in the kerb-side lane (never on the lane line), and the lane
lines are drawn where traffic.js says the lanes are. And the driving step (games/hq3d.js rideMove) is swept,
slides along a wall it glances, and lifts a vehicle stuck in a wall back out. Skipped without node."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")


def read(*p):
    with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
        return f.read()


LANES = r"""
var fs = require("fs"), zlib = require("zlib"), root = %(root)s, FIX = root + "/tests/fixtures/";
global.window = {HQV: {}};
for (var f of ["world", "traffic"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
var T = window.HQV.traffic, WD = window.HQV.world;
var doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(FIX + "claude-hq@3.json.gz")).toString("utf8"));
var widths = {};
doc.layers.roads.edges.forEach(function(e){ if(e["class"] === "local" || e["class"] === "arterial") (widths[e["class"]] = widths[e["class"]] || {})[e.width] = 1; });
var L = T.lanes(WD.pack(doc), 5), out = {widths: {local: Object.keys(widths.local).map(Number), arterial: Object.keys(widths.arterial).map(Number)}, two: 0, onLine: 0, cars: 0};
// ([3.29] an expressway, ramp or flyover lays its lanes LANE_W out from its median: tests/test_interchange_traffic.py)
var xway = {};
doc.layers.roads.edges.forEach(function(e){ if(e.v4 === "expressway" || e.v4 === "ramp" || e.v4 === "flyover") xway[e.id] = 1; });
L.forEach(function(e){
  if(!e.cars || e.tram || e.bus[0] || e.bus[1] || xway[e.id]) return;
  out.cars++;
  var n = Math.max(1, Math.min(3, Math.floor(e.half/3.3)));
  if(n >= 2){ out.two++; for(var k = 1; k < n; k++) if(Math.abs(e.carOff - e.half*k/n) < 1.0) out.onLine++; }
});
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class Lanes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", LANES % {"root": json.dumps(ROOT)}], capture_output=True, text=True, timeout=120)
        if r.returncode:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_some_streets_are_wide_and_some_narrow(self):
        self.assertGreaterEqual(len(self.o["widths"]["local"]), 3, self.o["widths"])
        self.assertGreaterEqual(len(self.o["widths"]["arterial"]), 2, self.o["widths"])
        self.assertGreaterEqual(max(self.o["widths"]["arterial"]), 1950)

    def test_traffic_keeps_to_a_lane_on_a_four_lane_avenue(self):
        self.assertGreater(self.o["two"], 10, self.o)
        self.assertEqual(self.o["onLine"], 0, "cars drive on a lane line")


class Source(unittest.TestCase):
    def test_lane_lines_and_traffic_agree(self):
        geom, traffic, npc = read("games", "worldgeom.js"), read("games", "traffic.js"), read("games", "npcsim.js")
        self.assertIn("function lanesEach(cw){ return Math.max(1, Math.min(3, Math.floor(cw/3.3))); }", geom)
        self.assertIn("var n = E.lanesV4 || Math.max(1, Math.min(3, Math.floor(c/3.3))), med = E.tram ? 0 : E.med;", traffic)
        self.assertIn("c - (c - med)/(2*n)", traffic)
        self.assertIn("function npcLane(c){ var n = Math.max(1, Math.min(3, Math.floor(c/3.3)));", npc)
        # [3.25] a v4 road: its own lanes between its median and the kerb, the same in the lines, the traffic and the
        # residents' cars (worldgeom.js v4Lines puts a lane line every (cw - med)/n out from the median)
        self.assertIn("var o = m + (cw - m)*k/n;", geom)
        self.assertIn("return Math.max(0.5, c - (c - med)/(2*n)); }", npc)

    def test_driving_is_swept_slides_and_unsticks(self):
        hq = read("games", "hq3d.js")
        self.assertIn("var RIDE_STEP = 0.35, SLIDE_MAX = 0.8, UNSTICK_S = 0.6;", hq)
        self.assertIn("var steps = Math.max(1, Math.ceil(Math.abs(d)/RIDE_STEP))", hq)   # no jumping a wall in one frame
        self.assertIn("if(bodyHits(sx, sz, avatar.yaw, bx) === 0){ avatar.x = sx; avatar.z = sz; slid = Math.cos(a); }", hq)
        self.assertIn("rideUnstick(dt, now, thr, sx0, sz0, bx);", hq)
        self.assertIn("if(bodyHits(px, pz, yaws[j], bx) === 0) return {x: px, z: pz, yaw: yaws[j]};", hq)


if __name__ == "__main__":
    unittest.main()
