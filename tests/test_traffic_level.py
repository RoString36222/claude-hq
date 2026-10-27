"""City Gen v4, phase 5 (HQ 3.28): each road's car limit and the NPC traffic slider.

Under node, on the @3 Commons fixture with games/world.js, games/citylife.js and games/traffic.js:
  - the level (o.traffic, sim.setLevel; Settings' slider) keeps its share of the slots' cars: none at 0, more as it rises,
    today's share at 0.85 (traffic.js LEVEL0), every slot the timetable has at 1;
  - no ring ever holds more than LOS_D cars a km of its lane at the level, nor one per CAR_M of it (the hard cap);
  - setLevel changes it live: the same cars as a sim made at that level, and back again;
  - the same level is the same cars for everyone (a pure function of the doc, the seed and the level);
  - buses and trams keep their timetables whatever the level.
And the Settings slider (index.html setTraffic, ui/app/16-settings.js, localStorage hq_traffic) sets the open City's
level through HQV.cityTrafficLevel (games/hqcity3d.js). Skipped without node. Stdlib only."""
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
var W = WD.pack(JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/claude-hq@3.json.gz")).toString("utf8")));
var D = Date.UTC(2026, 9, 27, 8);
function sim(level){ var o = {tier: 5, seed: W.id, W: W, local: 0}; if(level != null) o.traffic = level; return T.create(WD.docOf(W), o); }
function ids(s){ return s.cars(D).map(function(c){ return c.id + (c.show ? "+" : "-"); }).join(","); }
out.LEVEL0 = T.LEVEL0; out.LOS_D = T.LOS_D; out.CAR_M = T.CAR_M;
out.levels = [0, 0.25, 0.5, 0.85, 1].map(function(L){
  var s = sim(L), over = 0;
  s._.rings.forEach(function(r){
    var cap = Math.floor(Math.min(L*T.LOS_D*r.pl.len/1000, r.pl.len/T.CAR_M));
    if(r.cars.length > cap) over++;
  });
  return {level: L, cars: s.info().cars, out: s.cars(D).filter(function(c){ return c.show; }).length, over: over, onStreet: s.at(D, {x: 0, z: 0}, 1e9).filter(function(v){ return v.kind === "car"; }).length};
});
out.unsetIsLevel0 = sim(null).info().cars === sim(0.85).info().cars && ids(sim(null)) === ids(sim(0.85));
var s = sim(null);
s.setLevel(0.4); out.liveTo40 = ids(s) === ids(sim(0.4));
s.setLevel(1); out.liveTo100 = ids(s) === ids(sim(1));
s.setLevel(0.85); out.liveBack = ids(s) === ids(sim(null));
out.level = s.level();
out.same = ids(sim(0.6)) === ids(sim(0.6));
// the buses' timetable whatever the level
function bus(sv){ var L = sv.lines().filter(function(l){ return l.kind === "bus"; }); return JSON.stringify(L.map(function(l){ return [l.id, l.lap, l.vehicles]; })); }
out.busesSame = bus(sim(0)) === bus(sim(1)) && bus(sim(0)) === bus(sim(null));
out.busesAny = sim(1).lines().length;
console.log(JSON.stringify(out));
"""


def read(*p):
    with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
        return f.read()


@unittest.skipUnless(NODE, "node not installed")
class TrafficLevel(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", SCRIPT % {"root": json.dumps(ROOT)}], capture_output=True, text=True, timeout=600)
        if r.returncode != 0:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_the_constants_are_the_plans(self):
        self.assertEqual((self.o["LEVEL0"], self.o["LOS_D"], self.o["CAR_M"]), (0.85, 22, 7.5))

    def test_none_at_zero_and_more_as_it_rises(self):
        L = self.o["levels"]
        self.assertEqual((L[0]["cars"], L[0]["out"], L[0]["onStreet"]), (0, 0, 0))
        cars = [x["cars"] for x in L]
        self.assertEqual(cars, sorted(cars))
        self.assertGreater(L[-1]["cars"], L[3]["cars"], "100% has more than the usual 85%")
        self.assertGreater(L[3]["cars"], 100)

    def test_no_ring_over_its_cap(self):
        for x in self.o["levels"]:
            self.assertEqual(x["over"], 0, x)

    def test_the_level_changes_live_and_alike_for_everyone(self):
        o = self.o
        self.assertTrue(o["unsetIsLevel0"], "no setting is the usual 85%")
        self.assertTrue(o["liveTo40"] and o["liveTo100"] and o["liveBack"], "setLevel is a sim made at that level")
        self.assertEqual(o["level"], 0.85)
        self.assertTrue(o["same"])

    def test_buses_and_trams_keep_their_timetables(self):
        self.assertGreater(self.o["busesAny"], 0)
        self.assertTrue(self.o["busesSame"])

    def test_the_settings_slider_sets_the_open_citys_level(self):
        html, js, city = read("index.html"), read("ui", "app", "16-settings.js"), read("games", "hqcity3d.js")
        self.assertIn('<input id="setTraffic" type="range" min="0" max="100" step="5" aria-describedby="setTrafficHint">', html)
        self.assertIn('localStorage.setItem("hq_traffic"', js)
        self.assertIn("HQV.cityTrafficLevel(v/100)", js)
        self.assertIn("traffic: trafficLevel()", city)
        self.assertIn("HQV.cityTrafficLevel = function(v){ return tsim && tsim.setLevel ? tsim.setLevel(v) : null; };", city)


if __name__ == "__main__":
    unittest.main()
