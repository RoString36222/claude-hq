"""City play: collectibles and the photo hunt (games/playfinds.js, HQ 3.22).

Under node, on the @3 fixtures and on a v4-shaped world (as tests/test_citylife.py): about fifty finds per world, the
same every time, never on a carriageway, in a building or in water (rooftop tokens: over their roof); touching,
visiting and tagging collect them and the store keeps it; the photo hunt counts a photo only with its target in
frame, near enough and on now. Skipped without node."""
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
for (var f of ["world", "worldgeom", "citylife", "cityplay", "playfinds"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
var WD = window.HQV.world, P = window.HQV.cityPlay, PF = window.HQV.playFinds, out = {};
function doc(p){ return JSON.parse(zlib.gunzipSync(fs.readFileSync(FIX + p)).toString("utf8")); }
var V4 = {local: ["lane", "local street", "collector", "shared street", "service road", "local street + tram"],
          arterial: ["avenue", "boulevard", "boulevard + tram", "avenue_tram"], highway: ["highway", "expressway"], ring: ["expressway"]};
function v4(d){ d.layers.roads.edges.forEach(function(e, i){ var o = V4[e["class"]]; if(o) e["class"] = o[i %% o.length]; }); return d; }
var docs = {commons: doc("claude-hq@3.json.gz"), island: doc("island@3.json.gz"), v4: v4(doc("claude-hq@3.json.gz"))};
Object.keys(docs).forEach(function(name){
  var W = WD.pack(docs[name]), seed = P.hashStr(W.seed || W.id), F = PF.finds(W, seed), o = out[name] = {};
  o.same = JSON.stringify(F) === JSON.stringify(PF.finds(WD.pack(JSON.parse(JSON.stringify(docs[name]))), seed));
  o.n = F.length; o.kinds = {}; o.bad = []; o.ids = F.length === new Set(F.map(function(f){ return f.id; })).size;
  F.forEach(function(f){
    o.kinds[f.kind] = (o.kinds[f.kind] || 0) + 1;
    if(f.kind === "roof"){
      var lot = W.lots.filter(function(l){ return l.id === f.lot; })[0];
      if(!lot || !WD.blockedAt(W, f.x, f.z) || f.y < WD.groundAt(W, f.x, f.z) + lot.floors*3.5) o.bad.push(f.id + " not over its roof");
      return;
    }
    var pts = [f].concat(f.stand ? [f.stand] : []);
    pts.forEach(function(p){
      var s = WD.surfaceAt(W, p.x, p.z);
      if(s === "road") o.bad.push(f.id + " on a carriageway");
      if(s === "water" || WD.waterAt(W, p.x, p.z)) o.bad.push(f.id + " in water");
      if(WD.blockedAt(W, p.x, p.z)) o.bad.push(f.id + " in a building");
    });
  });
  o.stallNames = new Set(F.filter(function(f){ return f.kind === "stall"; }).map(function(f){ return f.name; })).size;
});

// collecting, on the commons
var W = WD.pack(docs.commons), finds = [];
P.on(function(k, d){ if(k === "find") finds.push(d.kind + ":" + d.n); });
var city = P.create(null, {W: W, worldId: "claude-hq@3"}), Fe = city.feature("finds"), L = Fe.list(), mo = null, me = {x: 0, y: 0, z: 0, yaw: 0};
var LOCAL = Date.UTC(2026, 9, 27, 12);      // a Tuesday, noon
function at(x, z, y, motion){ me = {x: x, y: y || 0, z: z, yaw: me.yaw}; mo = motion || null; city.update(0.1, {ms: 1e12, local: LOCAL, me: me, motion: mo}); }
function first(k){ return L.filter(function(f){ return f.kind === k; })[0]; }
var hid = first("hidden"), st = first("stall"), tag = first("tag"), roof = first("roof");
at(hid.x + 30, hid.z); out.farGot = Fe.progress(LOCAL).finds;
at(hid.x + 1, hid.z); out.hidGot = Fe.progress(LOCAL).finds;
at(st.x + 3, st.z); out.stallGot = Fe.progress(LOCAL).finds;
at(roof.x, roof.z, WD.groundAt(W, roof.x, roof.z), {ride: null, y: WD.groundAt(W, roof.x, roof.z)}); out.roofLow = Fe.progress(LOCAL).finds;
at(roof.x + 1, roof.z, roof.y, {ride: "heli", air: true, y: roof.y}); out.roofGot = Fe.progress(LOCAL).finds;
at(tag.stand.x, tag.stand.z); out.tagPrompt = city.prompt({x: tag.stand.x, z: tag.stand.z}); out.tagUse = city.use({x: tag.stand.x, z: tag.stand.z});
out.tagGot = Fe.progress(LOCAL).finds; out.tagPrompt2 = city.prompt({x: tag.stand.x, z: tag.stand.z});
out.stored = Object.keys(city.ctx.store.get("finds:" + city.ctx.seed, {})).sort();
out.expect = [hid.id, st.id, roof.id, tag.id].sort();
out.events = finds.slice();
out.blockedStall = city.blocked(st.x, st.z);

// the photo hunt
var seed = city.ctx.seed, C = PF.challenges(W, seed, LOCAL);
out.challenges = C.map(function(c){ return c.id; });
var lm = C.filter(function(c){ return c.id.indexOf("landmark:") === 0; })[0], T = PF.targets(W, seed, lm.id, LOCAL)[0];
function poseAt(t, d, look){ var yaw = look != null ? look : 0; return {x: t.x - Math.sin(yaw)*d, y: t.y, z: t.z - Math.cos(yaw)*d, yaw: yaw, pitch: 0, fov: 50, aspect: 1.6}; }
out.judge = [PF.judge(poseAt(T, 30), T), PF.judge(poseAt(T, 80), T), PF.judge(Object.assign(poseAt(T, 30), {yaw: Math.PI}), T),
             PF.judge(Object.assign(poseAt(T, 30), {yaw: 0.9}), T), PF.judge(Object.assign(poseAt(T, 30), {pitch: 1.2}), T), PF.judge(Object.assign(poseAt(T, 30), {yaw: 0.3}), T)];
city.emit("photo", Object.assign(poseAt(T, 30), {yaw: Math.PI})); out.photosWrong = Fe.progress(LOCAL).photos;
city.emit("photo", poseAt(T, 30)); out.photosRight = Fe.progress(LOCAL).photos; out.photosTotal = Fe.progress(LOCAL).photosTotal;
city.emit("photo", poseAt(T, 30)); out.photosAgain = Fe.progress(LOCAL).photos;
out.chDone = Fe.challenges(LOCAL).filter(function(c){ return c.done; }).map(function(c){ return c.id; });
var sun = Date.UTC(2026, 9, 25, 15, 30), mon = Date.UTC(2026, 9, 26, 15, 30), sat = Date.UTC(2026, 9, 24, 16), sat10 = Date.UTC(2026, 9, 24, 10);
out.on = {paradeSun: PF.targets(W, seed, "parade", sun).length, paradeMon: PF.targets(W, seed, "parade", mon).length,
          marketSat: PF.targets(W, seed, "market", sat10).length, marketMon: PF.targets(W, seed, "market", mon).length,
          stadiumSat: PF.targets(W, seed, "stadium", sat).length, stadiumSun: PF.targets(W, seed, "stadium", sun).length,
          buskerNoon: PF.targets(W, seed, "busker", LOCAL).length, buskerNight: PF.targets(W, seed, "busker", Date.UTC(2026, 9, 27, 23)).length};
// the parade, on a Sunday, from the side of its route
var city2 = P.create(null, {W: W, worldId: "claude-hq@3"}), F2 = city2.feature("finds"), pt = PF.targets(W, seed, "parade", sun)[0];
city2.update(0.1, {ms: 1e12, local: sun, me: {x: 0, y: 0, z: 0, yaw: 0}, motion: null});
city2.emit("photo", poseAt(pt, 25, 1.0)); out.parade = F2.challenges(sun).filter(function(c){ return c.done; }).map(function(c){ return c.id; });
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class PlayFinds(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", SCRIPT % {"root": json.dumps(ROOT)}], capture_output=True, text=True, timeout=240)
        if r.returncode:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_finds_are_deterministic_and_well_placed(self):
        for name in ("commons", "island", "v4"):
            w = self.o[name]
            self.assertTrue(w["same"], name)
            self.assertTrue(w["ids"], name + ": ids are unique")
            self.assertGreaterEqual(w["n"], 40, name)
            self.assertLessEqual(w["n"], 60, name)
            for k in ("roof", "tag", "stall", "hidden"):
                self.assertIn(k, w["kinds"], name)
            self.assertEqual(w["bad"], [], name)
            self.assertEqual(w["stallNames"], w["kinds"]["stall"], name + ": every stall has its own name")

    def test_collecting_updates_the_store(self):
        o = self.o
        self.assertEqual(o["farGot"], 0)
        self.assertEqual(o["hidGot"], 1)
        self.assertEqual(o["stallGot"], 2)
        self.assertEqual(o["roofLow"], 2, "a rooftop token is not collected from the street")
        self.assertEqual(o["roofGot"], 3)
        self.assertEqual(o["tagPrompt"], "E  Tag this wall")
        self.assertTrue(o["tagUse"])
        self.assertEqual(o["tagGot"], 4)
        self.assertIsNone(o["tagPrompt2"])
        self.assertEqual(o["stored"], o["expect"])
        self.assertEqual(o["events"], ["hidden:1", "stall:2", "roof:3", "tag:4"])
        self.assertTrue(o["blockedStall"])

    def test_photo_judging(self):
        self.assertEqual(self.o["judge"], [True, False, False, False, False, True])
        self.assertEqual(self.o["photosWrong"], 0)
        self.assertEqual(self.o["photosRight"], 1)
        self.assertEqual(self.o["photosAgain"], 1)
        self.assertEqual(self.o["photosTotal"], 5)
        self.assertEqual(len(self.o["chDone"]), 1)
        self.assertEqual(self.o["parade"], ["parade"])

    def test_the_photo_hunt_follows_the_week(self):
        on = self.o["on"]
        self.assertEqual(self.o["challenges"][0], "parade")
        self.assertIn("busker", self.o["challenges"])
        self.assertGreater(on["paradeSun"], 0)
        self.assertEqual(on["paradeMon"], 0)
        self.assertGreater(on["marketSat"], 0)
        self.assertEqual(on["marketMon"], 0)
        self.assertGreater(on["stadiumSat"], 0)
        self.assertEqual(on["stadiumSun"], 0)
        self.assertGreater(on["buskerNoon"], 0)
        self.assertEqual(on["buskerNight"], 0)


if __name__ == "__main__":
    unittest.main()
