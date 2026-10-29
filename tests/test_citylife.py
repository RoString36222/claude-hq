"""City life (games/citylife.js, HQ 3.21): built around City Gen v4, never into it.

Under node, on the @3 fixtures and on a v4-shaped world (the same @3 doc with its roads renamed to v4's eleven
classes and their tram versions): every road class is known to the adapter, every building lot gets a use and a
ground floor, footpaths get furniture, people have places to gather, traffic demand follows the hour, and the
weekly events close streets on their days only. Everything is a pure function of the doc and the clock.
Skipped without node."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

SCRIPT = r"""
var fs = require("fs"), zlib = require("zlib"), root = %(root)s, FIX = root + "/tests/fixtures/";
global.window = {HQV: {}};
for (var f of ["world", "citylife"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
var WD = window.HQV.world, L = window.HQV.cityLife, out = {};
function doc(p){ return JSON.parse(zlib.gunzipSync(fs.readFileSync(FIX + p)).toString("utf8")); }
// a v4-shaped world: v4's class names (and their tram versions) on @3's roads
var V4 = {local: ["lane", "local street", "collector", "shared street", "service road", "local street + tram"],
          arterial: ["avenue", "boulevard", "boulevard + tram", "avenue_tram"], highway: ["highway", "expressway"], ring: ["expressway"]};
function v4(d){ d.layers.roads.edges.forEach(function(e, i){ var o = V4[e["class"]]; if(o) e["class"] = o[i %% o.length]; }); return d; }
function count(a, k){ var m = {}; a.forEach(function(x){ m[x[k]] = (m[x[k]] || 0) + 1; }); return m; }
var worlds = {commons: doc("claude-hq@3.json.gz"), island: doc("island@3.json.gz"), v4: v4(doc("claude-hq@3.json.gz"))};
Object.keys(worlds).forEach(function(name){
  var W = WD.pack(worlds[name]), U = L.landUse(W), uses = Object.keys(U).map(function(k){ return U[k]; });
  var Fu = L.furniture(W), S = L.hotspots(W), o = out[name] = {};
  o.unknown = W.edges.filter(function(e){ return !L.road(e.cls).known; }).map(function(e){ return e.cls; });
  o.buildings = W.lots.filter(function(l){ return l.kind === "building"; }).length;
  o.used = uses.length; o.use = count(uses, "use"); o.ground = count(uses, "ground"); o.furn = count(Fu, "kind"); o.spots = count(S, "kind");
  o.same = JSON.stringify(L.landUse(WD.pack(JSON.parse(JSON.stringify(worlds[name]))))) === JSON.stringify(U);
  o.furnOnRoad = Fu.filter(function(f){ return WD.surfaceAt(W, f.x, f.z) === "road"; }).length;
  var sat = Date.UTC(2026, 9, 24, 10), sun = Date.UTC(2026, 9, 25, 15, 30), mon = Date.UTC(2026, 9, 26, 10), tue = Date.UTC(2026, 9, 27, 22);
  o.events = [sat, sun, mon, tue].map(function(ms){ return L.events(W, ms).map(function(e){ return e.kind; }); });
  o.closedMon = Object.keys(L.closed(W, mon)).length;
});
out.demand = [3, 8.25, 13, 17.75, 23].map(function(h){ return +L.demand(h, "main").toFixed(2); });
out.mixNight = L.mix("centre", "main", 23); out.mixIndustry = L.mix("industry", "main", 9);
out.lit = [L.litAt(L.litCode("office", 0.5), 11), L.litAt(L.litCode("office", 0.5), 2), L.litAt(L.litCode("home", 0.5), 20), L.litAt(L.litCode("home", 0.5), 3), L.litAt(1, 3), L.litAt(0, 20)];
var spot = {id: "x", cap: 10, hours: [[8, 9]]};
out.crowd = [7.9, 8.5, 9.1].map(function(h){ return L.crowd(spot, Date.UTC(2026, 9, 26, 0) + h*36e5); });
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class CityLife(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", SCRIPT % {"root": json.dumps(ROOT)}], capture_output=True, text=True, timeout=180)
        if r.returncode:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_the_adapter_knows_every_road_today_and_in_v4(self):
        for name in ("commons", "island", "v4"):
            self.assertEqual(self.o[name]["unknown"], [], name)

    def test_every_building_has_a_use_and_a_ground_floor(self):
        for name in ("commons", "island", "v4"):
            w = self.o[name]
            self.assertEqual(w["used"], w["buildings"], name)
            self.assertTrue(w["same"], name + ": land use is a pure function of the doc")
            self.assertGreater(w["ground"].get("shop", 0), 10, name)
            self.assertGreater(w["ground"].get("cafe", 0), 5, name)
            self.assertGreater(w["ground"].get("door", 0), w["ground"].get("cafe", 0), name + ": most doors are front doors")
        self.assertGreater(self.o["commons"]["use"].get("office", 0), 10)
        self.assertGreater(self.o["commons"]["use"].get("warehouse", 0) + self.o["commons"]["use"].get("workshop", 0), 0)

    def test_footpaths_get_furniture_and_people_places_to_gather(self):
        for name in ("commons", "island", "v4"):
            w = self.o[name]
            self.assertGreater(sum(w["furn"].values()), 100, name)
            self.assertEqual(w["furnOnRoad"], 0, name + ": furniture on a carriageway")
            for k in ("bin", "table"):
                self.assertIn(k, w["furn"], name)
            self.assertNotIn("bench", w["furn"], name + ": no benches at the kerb")
            for k in ("terrace", "wait", "gate", "market"):
                self.assertIn(k, w["spots"], name)

    def test_traffic_follows_the_hour_and_the_place(self):
        d = self.o["demand"]
        self.assertGreater(d[1], 0.9)            # 08:15 rush
        self.assertGreater(d[3], 0.9)            # 17:45 rush
        self.assertLess(d[0], 0.25)              # 03:00
        self.assertLess(d[0], d[2] < d[1] and d[2] or 1)
        self.assertGreater(self.o["mixNight"]["taxi"], 0.25)
        self.assertGreater(self.o["mixIndustry"]["lorry"], 0.25)

    def test_windows_follow_the_use(self):
        self.assertEqual(self.o["lit"], [True, False, True, False, True, False])

    def test_events_close_streets_on_their_days_only(self):
        for name in ("commons", "island", "v4"):
            ev = self.o[name]["events"]
            self.assertEqual(ev[0], ["market"], name)              # Saturday 10:00
            self.assertEqual(ev[1], ["parade"], name)              # Sunday 15:30
            self.assertIn("roadworks", ev[2], name)                # Monday 10:00
            self.assertEqual(ev[3], [], name)                      # Tuesday 22:00
            self.assertGreater(self.o[name]["closedMon"], 0, name)

    def test_crowds_gather_and_leave(self):
        c = self.o["crowd"]
        self.assertEqual(c[0], 0)
        self.assertGreater(c[1], 0)
        self.assertEqual(c[2], 0)


if __name__ == "__main__":
    unittest.main()
