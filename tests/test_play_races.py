"""City play: street races and checkpoint runs (games/playraces.js, HQ 3.22).

Under node, on the @3 fixtures and on a v4-shaped world (the @3 doc with its roads renamed to v4's classes, as in
tests/test_citylife.py): 8-12 routes per world, the same every time, 1-4 km (trials shorter), checkpoints on road
centrelines and sanely spaced, one highway sprint where the world has fast roads. A simulated drive through the
checkpoints finishes and stores a best time and a ghost; a checkpoint missed by more than 25 m does not count.
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
for (var f of ["world", "worldgeom", "citylife", "cityplay", "playraces"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
var WD = window.HQV.world, P = window.HQV.cityPlay, PR = window.HQV.playRaces, out = {};
function doc(p){ return JSON.parse(zlib.gunzipSync(fs.readFileSync(FIX + p)).toString("utf8")); }
var V4 = {local: ["lane", "local street", "collector", "shared street", "service road", "local street + tram"],
          arterial: ["avenue", "boulevard", "boulevard + tram", "avenue_tram"], highway: ["highway", "expressway"], ring: ["expressway"]};
function v4(d){ d.layers.roads.edges.forEach(function(e, i){ var o = V4[e["class"]]; if(o) e["class"] = o[i %% o.length]; }); return d; }
var docs = {commons: doc("claude-hq@3.json.gz"), island: doc("island@3.json.gz"), v4: v4(doc("claude-hq@3.json.gz"))};
// [3.32] on a tram's centre bed (City Gen v4 phase 9): a route down a tram avenue's middle has its gate or start on the
// raised bed, the line across the carriageways either side
function onBed(W, x, z){
  var n = WD.nearestRoad(W, x, z, 30), e = n ? W.edges.filter(function(f){ return f.id === n.edge && f.bed > 0; })[0] : null;
  return !!(e && n.dist < e.bed/200);
}
Object.keys(docs).forEach(function(name){
  var W = WD.pack(docs[name]), seed = P.hashStr(W.seed || W.id), R = PR.plan(W, seed, null), o = out[name] = {};
  var R2 = PR.plan(WD.pack(JSON.parse(JSON.stringify(docs[name]))), seed, null);
  o.same = JSON.stringify(R) === JSON.stringify(R2);
  o.n = R.length; o.kinds = {}; o.highway = R.filter(function(r){ return r.highway; }).length;
  o.routes = R.map(function(r){
    o.kinds[r.kind] = (o.kinds[r.kind] || 0) + 1;
    var prev = r.start, gaps = [], off = 0, far = 0;
    r.cps.forEach(function(c){
      gaps.push(Math.hypot(c.x - prev.x, c.z - prev.z)); prev = c;
      // (on a road at its own level: a checkpoint on a flyover is on the deck, HQ 3.29's stacked surfaces)
      var lv = WD.nearestRoad(W, c.x, c.z, 30);
      // ([3.32] or down the middle of a tram's centre bed: raised paving, the gate spans the carriageways either side)
      if(WD.surfaceAt(W, c.x, c.z, lv ? lv.y : undefined) !== "road" && !onBed(W, c.x, c.z)) off++;
      var n = WD.nearestRoad(W, c.x, c.z, 30); if(!n || n.dist > 1.5) far++;
    });
    return {id: r.id, kind: r.kind, len: r.len, laps: r.laps, cps: r.cps.length, minGap: Math.min.apply(null, gaps), maxGap: Math.max.apply(null, gaps), off: off, far: far,
            startOn: WD.surfaceAt(W, r.start.x, r.start.z) === "road" || onBed(W, r.start.x, r.start.z)};
  });
});

// a drive through the commons' first non-highway sprint
var W = WD.pack(docs.commons), events = [];
P.on(function(k, d){ if(k === "race") events.push(d.state); });
var city = P.create(null, {W: W, worldId: "claude-hq@3"}), F = city.feature("races"), rs = F.routes();
var r = rs.filter(function(x){ return x.kind === "sprint" && !x.highway; })[0];
var me = {x: r.start.x, y: 0, z: r.start.z, yaw: r.start.yaw}, car = {ride: "car", speed: 0};
function tick(dt){ city.update(dt, {ms: 1e12, local: Date.UTC(2026, 9, 27, 22), me: me, motion: car}); }
function driveTo(x, z, v){
  for(var k = 0; k < 4000; k++){
    var dx = x - me.x, dz = z - me.z, d = Math.hypot(dx, dz);
    if(d < 0.5) return;
    var s = Math.min(d, v*0.1); me.x += dx/d*s; me.z += dz/d*s; me.yaw = Math.atan2(dx, dz); car.speed = v; tick(0.1);
  }
}
function arm(){ car.speed = 0; for(var i = 0; i < 12; i++) tick(0.1); var a = F.state().phase; for(var j = 0; j < 32; j++) tick(0.1); return [a, F.state().phase]; }
out.prompt = F.prompt({x: r.start.x, z: r.start.z});
out.phases = arm();
out.bestBefore = F.best(r.id);
r.cps.forEach(function(c, i){ driveTo(c.x + (i === 1 ? 12 : 0)*Math.cos(c.yaw), c.z - (i === 1 ? 12 : 0)*Math.sin(c.yaw), 25); });
tick(0.1);
out.afterRun = F.state().phase; out.events = events.slice();
out.best = F.best(r.id); out.len = r.len;
var G = F.ghost(r.id);
out.ghostN = G ? G.length : 0; out.ghost0 = G ? Math.hypot(G[0].x - r.start.x, G[0].z - r.start.z) : null;
out.ghostEnd = G ? Math.hypot(G[G.length - 1].x - r.cps[r.cps.length - 1].x, G[G.length - 1].z - r.cps[r.cps.length - 1].z) : null;
out.store = city.ctx.store.get("races:" + city.ctx.seed + ":best:" + r.id, null) != null;
// the second run: checkpoint 2 missed by 60 m, on whichever side keeps the straight lines in and out of the miss
// farthest from it (on the inside of a turn, the line on to checkpoint 3 would cross it)
car.speed = 0; for(var w8 = 0; w8 < 70; w8++) tick(0.1);          // the finish line's banner, then back to the start
events.length = 0; me.x = r.start.x; me.z = r.start.z;
out.phases2 = arm();
function segD(p, a, b){ var dx = b.x - a.x, dz = b.z - a.z, l = dx*dx + dz*dz, t = l ? Math.max(0, Math.min(1, ((p.x - a.x)*dx + (p.z - a.z)*dz)/l)) : 0; return Math.hypot(p.x - a.x - dx*t, p.z - a.z - dz*t); }
var c0 = r.cps[0], c1 = r.cps[1], c2 = r.cps[2] || r.cps[0], miss = null;
for(var q = 0; q < 16; q++){
  var m = {x: c1.x + 60*Math.cos(q*Math.PI/8), z: c1.z + 60*Math.sin(q*Math.PI/8)}, d = Math.min(segD(c1, c0, m), segD(c1, m, c2));
  if(!miss || d > miss.d) miss = {x: m.x, z: m.z, d: d};
}
out.missBy = miss.d;
r.cps.forEach(function(c, i){ if(i === 1) driveTo(miss.x, miss.z, 25); else driveTo(c.x, c.z, 25); });
for(var k = 0; k < 80; k++) tick(0.1);
out.events2 = events.slice(); out.next2 = F.state().next; out.phase2 = F.state().phase;
out.bestAfter = F.best(r.id).t === out.best.t;
// a trial on foot: the E prompt at its start
var tr = rs.filter(function(x){ return x.mode === "foot"; })[0];
out.cancel = F.cancel() || F.state().phase === "idle"; car = null; tick(0.1);
out.footPrompt = tr ? F.prompt({x: tr.start.x, z: tr.start.z}) : null;
// ghosts: compression round trip, and someone else's
var samp = []; for(var i = 0; i < 50; i++) samp.push({x: 100 + i*3.33, z: -50 + i*1.27, yaw: Math.sin(i)*3});
var enc = PR.encodeGhost(samp), dec = PR.decodeGhost(enc);
out.ghostErr = Math.max.apply(null, dec.map(function(s, i){ return Math.max(Math.abs(s.x - samp[i].x), Math.abs(s.z - samp[i].z)); }));
out.encLen = enc.length; out.badDecode = PR.decodeGhost("nope");
out.loaded = [F.loadGhost(r.id, enc, "Rival <b>"), F.loadGhost(r.id, "junk", "x"), F.loadGhost("nope", enc, "x")];
out.fmt = [PR.fmt(0), PR.fmt(65.25), PR.fmt(601.04)];
city.dispose();
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class PlayRaces(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", SCRIPT % {"root": json.dumps(ROOT)}], capture_output=True, text=True, timeout=240)
        if r.returncode:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_routes_are_deterministic_and_on_roads(self):
        for name in ("commons", "island", "v4"):
            w = self.o[name]
            self.assertTrue(w["same"], name)
            self.assertGreaterEqual(w["n"], 8, name)
            self.assertLessEqual(w["n"], 12, name)
            for k in ("sprint", "circuit", "trial"):
                self.assertIn(k, w["kinds"], name)
            for r in w["routes"]:
                self.assertEqual(r["off"], 0, name + " " + r["id"] + ": a checkpoint off the road")
                self.assertEqual(r["far"], 0, name + " " + r["id"] + ": a checkpoint off the centreline")
                self.assertTrue(r["startOn"], r["id"])
                if r["kind"] == "trial":
                    self.assertTrue(300 <= r["len"] <= 1200, r)
                else:
                    self.assertTrue(1000 <= r["len"] <= 4000, r)
                if r["kind"] == "circuit":
                    self.assertIn(r["laps"], (2, 3))

    def test_one_highway_sprint_where_there_are_highways(self):
        self.assertEqual(self.o["commons"]["highway"], 1)
        self.assertEqual(self.o["v4"]["highway"], 1)

    def test_checkpoints_are_spaced_sanely(self):
        for name in ("commons", "island", "v4"):
            for r in self.o[name]["routes"]:
                self.assertGreater(r["minGap"], 15, r)
                self.assertLess(r["maxGap"], 260, r)
                self.assertGreaterEqual(r["cps"], 4, r)

    def test_a_drive_through_finishes_and_keeps_a_best_and_a_ghost(self):
        o = self.o
        self.assertIsNone(o["prompt"], "a drive race has no on-foot prompt")
        self.assertEqual(o["phases"], ["count", "run"])
        self.assertIsNone(o["bestBefore"])
        self.assertEqual(o["afterRun"], "idle")
        self.assertEqual(o["events"][:2], ["countdown", "start"])
        self.assertIn("checkpoint", o["events"])
        self.assertEqual(o["events"][-1], "finish")
        self.assertTrue(o["store"])
        t = o["best"]["t"]
        self.assertGreater(t, o["len"]/25*0.5)          # (straight lines between checkpoints: shorter than the road)
        self.assertLess(t, o["len"]/25*2)
        self.assertGreater(o["ghostN"], t/0.2*0.9)
        self.assertLess(o["ghost0"], 3)
        self.assertLess(o["ghostEnd"], 26)          # (the finish counts from 25 m)

    def test_a_checkpoint_missed_by_more_than_25_m_does_not_count(self):
        o = self.o
        self.assertEqual(o["phases2"], ["count", "run"])
        self.assertGreater(o["missBy"], 25)
        self.assertNotIn("finish", o["events2"])
        self.assertTrue(o["phase2"] == "idle" or o["next2"] == 1, o)
        self.assertTrue(o["bestAfter"])

    def test_a_time_trial_starts_on_foot_with_e(self):
        self.assertTrue(self.o["cancel"])
        self.assertTrue(self.o["footPrompt"].startswith("E  Start "))

    def test_ghosts_compress_and_load(self):
        self.assertLessEqual(self.o["ghostErr"], 0.051)
        self.assertLess(self.o["encLen"], 50*12)
        self.assertIsNone(self.o["badDecode"])
        self.assertEqual(self.o["loaded"], [True, False, False])
        self.assertEqual(self.o["fmt"], ["0:00.0", "1:05.3", "10:01.0"])


if __name__ == "__main__":
    unittest.main()
