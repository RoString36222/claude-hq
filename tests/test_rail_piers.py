"""City Gen v4 phase 8 (HQ 3.31): the City Line's piers from the doc on the client (games/world.js, games/hqrail.js,
games/worldgeom.js, games/citylife.js) under node, on tests/fixtures/claude-hq@3.json.gz (the Commons: a boulevard
corridor under the City Line, the generator's piers in its median) and the island / older docs without them.

Checks: railOf and hqRail.railView keep a line's `piers` (in metres) and docOf gives them back; railPiersOf lists them as
2 m columns (memoised); blockedAt is true at every doc pier (at ground level, not over the girder's soffit) and false
3 m to the side of the median ones, and nowhere else does it change against the same doc with the field deleted;
the island fixture and @1 / @2 docs have no piers and blockedAt is unchanged there; no tree, lamp, sign, gantry,
parked car or piece of street furniture stands within 1.5 m of a pier (and an extra pier put on a lamp takes the lamp
away). Skipped without node. Stdlib only."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

HARNESS = r"""
var fs = require("fs"), zlib = require("zlib"), root = process.argv[1];
global.window = {HQV: {}}; global.self = window;
["world", "worldgeom", "citylife", "hqrail"].forEach(function(f){ new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))(); });
var H = window.HQV.world, G = window.HQV.worldgeom, CL = window.HQV.cityLife, RL = window.HQV.hqRail, out = {};
function doc(n){ return JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/" + n + ".json.gz"))); }
function cityLine(D){ return (((D.layers || {}).rail || {}).lines || []).filter(function(l){ return l.kind === "city"; })[0] || null; }
// blockedAt over a grid round the line (every 1.5 m within `r` m of each point), as a string
function grid(W, pts, r){
  var s = [];
  pts.forEach(function(p){ for(var dx = -r; dx <= r; dx += 1.5) for(var dz = -r; dz <= r; dz += 1.5) s.push(H.blockedAt(W, p.x + dx, p.z + dz) ? 1 : 0); });
  return s;
}
var D3 = doc("claude-hq@3"), line = cityLine(D3), W = H.pack(D3);
var docP = line && line.piers ? line.piers.map(function(p){ return {x: p.x/100, y: p.y/100, z: p.z/100, h: p.h/100}; }) : [];
out.has = !!(line && line.piers);
var ro = H.railOf(W), rl = ro.lines.filter(function(l){ return l.kind === "city"; })[0];
out.railOf = rl.piers || null;
out.doc = docP;
var raw = RL.railView({layers: {rail: D3.layers.rail}});
out.railView = (raw.lines.filter(function(l){ return l.kind === "city"; })[0] || {}).piers || null;
out.docOf = (cityLine(H.docOf(W)) || {}).piers || null;
out.docPiers = line ? line.piers : null;
var RP = H.railPiersOf(W);
out.memo = RP === H.railPiersOf(W);
out.cols = RP.map(function(p){ return {x: p.x, z: p.z, r: p.r, y0: p.y0, y1: p.y1}; });
// blocked at each pier (ground level; just under the soffit; over it, on the line)
out.at = RP.map(function(p){ return [H.blockedAt(W, p.x, p.z), H.blockedAt(W, p.x + 0.6, p.z), H.blockedAt(W, p.x, p.z, p.y0), H.blockedAt(W, p.x, p.z, p.y1 - 0.1), H.railPierHit(W, p.x, p.z, p.y1 + 3)]; });
// 3 m to the side, across the line, of every pier in the boulevard's median
var P = rl.path;
function dirAt(x, z){
  var best = Infinity, d = [1, 0];
  for(var i = 0; i + 1 < P.length; i++){
    var a = P[i], b = P[i+1], ux = b[0] - a[0], uz = b[2] - a[2], L2 = ux*ux + uz*uz || 1e-9, t = Math.max(0, Math.min(1, ((x - a[0])*ux + (z - a[2])*uz)/L2));
    var q = Math.hypot(x - a[0] - ux*t, z - a[2] - uz*t); if(q < best){ best = q; var L = Math.sqrt(L2); d = [ux/L, uz/L]; }
  }
  return d;
}
var byId = {}; W.edges.forEach(function(e){ byId[e.id] = e; });
out.side = RP.map(function(p){
  var nr = H.nearestRoad(W, p.x, p.z, 30), e = nr ? byId[nr.edge] : null;
  if(!e || e.v4 !== "boulevard" || !(nr.dist < 0.5)) return null;
  var d = dirAt(p.x, p.z), lx = -d[1], lz = d[0];
  return [H.blockedAt(W, p.x + 3*lx, p.z + 3*lz), H.blockedAt(W, p.x - 3*lx, p.z - 3*lz), (e.median || 0)/200];
});
// the same doc without the field: nothing else changes
var D3s = doc("claude-hq@3"); delete cityLine(D3s).piers;
var Ws = H.pack(D3s), around = P.map(function(q){ return {x: q[0], z: q[2]}; }).concat(RP);
var g1 = grid(W, around, 6), g0 = grid(Ws, around, 6), diff = [];
var k = 0; around.forEach(function(p){ for(var dx = -6; dx <= 6; dx += 1.5) for(var dz = -6; dz <= 6; dz += 1.5){
  if(g1[k] !== g0[k]) diff.push(RP.some(function(q){ return Math.hypot(p.x + dx - q.x, p.z + dz - q.z) < q.r; }) ? 1 : 0); k++; } });
out.diff = {n: diff.length, onPier: diff.filter(function(v){ return v; }).length};
out.stripped = {railOf: "piers" in H.railOf(Ws).lines.filter(function(l){ return l.kind === "city"; })[0], cols: H.railPiersOf(Ws).length,
                hit: RP.map(function(p){ return H.railPierHit(Ws, p.x, p.z); }).some(Boolean)};
// props and trees off the piers
var near = {}, NT = G.NT;
for(var tx = 0; tx < NT; tx++) for(var tz = 0; tz < NT; tz++){
  var Pr = G.props(W, tx, tz);
  Object.keys(Pr).forEach(function(kind){ (Pr[kind] || []).forEach(function(o){ if(RP.some(function(q){ return Math.hypot(q.x - o.x, q.z - o.z) < q.r + 1.5; })) near[kind] = (near[kind] || 0) + 1; }); });
}
out.near = near;
out.trees = H.trees(W).filter(function(t){ return RP.some(function(q){ return Math.hypot(q.x - t.x, q.z - t.z) < q.r + 1.5; }); }).length;
out.furn = CL.furniture(W).filter(function(f){ return RP.some(function(q){ return Math.hypot(q.x - f.x, q.z - f.z) < q.r + 1.5; }); }).length;
// an extra pier on a lamp: the lamp goes, the rest stays
var D3x = doc("claude-hq@3"), Wl = H.pack(doc("claude-hq@3")), lamp = null, nLamps = 0;
for(tx = 0; tx < NT && !lamp; tx++) for(tz = 0; tz < NT && !lamp; tz++){ var L0 = G.props(Wl, tx, tz).lamps; if(L0.length) lamp = L0[0]; }
for(tx = 0; tx < NT; tx++) for(tz = 0; tz < NT; tz++) nLamps += G.props(Wl, tx, tz).lamps.length;
cityLine(D3x).piers = (cityLine(D3x).piers || []).concat([{x: Math.round(lamp.x*100), y: Math.round(lamp.y*100), z: Math.round(lamp.z*100), h: 900}]);
var Wx = H.pack(D3x), nX = 0, still = 0;
for(tx = 0; tx < NT; tx++) for(tz = 0; tz < NT; tz++) G.props(Wx, tx, tz).lamps.forEach(function(o){ nX++; if(Math.hypot(o.x - lamp.x, o.z - lamp.z) < 0.01) still++; });
out.lamp = {before: nLamps, after: nX, still: still, blocked: H.blockedAt(Wx, lamp.x, lamp.z)};
// docs without piers: the island @3, the Commons @1 and @2
out.old = ["island@3", "claude-hq@2", "claude-hq@1", "island@2"].map(function(n){
  var Wo = H.pack(doc(n)), r = H.railOf(Wo);
  return {name: n, rail: !!r, piersKey: r ? r.lines.some(function(l){ return "piers" in l; }) : false, cols: H.railPiersOf(Wo).length,
          hit: H.railPierHit(Wo, 0, 0)};
});
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class RailPiersTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", HARNESS, ROOT], capture_output=True, text=True, timeout=240)
        if r.returncode != 0:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout)
        if not cls.o["has"]:
            raise unittest.SkipTest("the Commons fixture's City Line has no piers yet")

    def test_rail_of_keeps_piers(self):
        o = self.o
        self.assertEqual(len(o["railOf"]), len(o["doc"]))
        for a, b in zip(o["railOf"], o["doc"]):
            for k in "xyzh":
                self.assertAlmostEqual(a[k], b[k], places=6)
        self.assertEqual(o["railView"], o["railOf"], "hqRail.railView on a raw doc agrees with world.js")
        self.assertEqual(o["docOf"], o["docPiers"], "docOf gives the doc's piers back")

    def test_columns(self):
        o = self.o
        self.assertTrue(o["memo"])
        self.assertEqual(len(o["cols"]), len(o["doc"]))
        for c, d in zip(o["cols"], o["doc"]):
            self.assertEqual(c["r"], 1)
            self.assertAlmostEqual(c["y0"], d["y"], places=6)
            self.assertAlmostEqual(c["y1"], d["y"] + d["h"] - 2.4, places=6)

    def test_blocked_at_a_pier(self):
        for i, a in enumerate(self.o["at"]):
            self.assertEqual(a, [True, True, True, True, False], i)

    def test_clear_beside_a_median_pier(self):
        side = [s for s in self.o["side"] if s]
        self.assertGreaterEqual(len(side), 5, "most piers stand in the boulevard's median")
        for s in side:
            self.assertGreaterEqual(s[2], 3.5, "a 7.5 m median")
            self.assertEqual(s[:2], [False, False], s)

    def test_nothing_else_changes(self):
        self.assertGreater(self.o["diff"]["n"], 0)
        self.assertEqual(self.o["diff"]["n"], self.o["diff"]["onPier"], "blockedAt changes only on the piers")
        self.assertEqual(self.o["stripped"], {"railOf": False, "cols": 0, "hit": False})

    def test_props_and_trees_keep_off(self):
        self.assertEqual(self.o["near"], {})
        self.assertEqual(self.o["trees"], 0)
        self.assertEqual(self.o["furn"], 0)
        l = self.o["lamp"]
        self.assertEqual(l["still"], 0, "a lamp where a pier stands is not drawn")
        self.assertEqual(l["after"], l["before"] - 1)
        self.assertTrue(l["blocked"])

    def test_docs_without_piers(self):
        for d in self.o["old"]:
            self.assertFalse(d["piersKey"], d["name"])
            self.assertEqual(d["cols"], 0, d["name"])
            self.assertFalse(d["hit"], d["name"])
        self.assertTrue(self.o["old"][0]["rail"], "the island @3 has rail, no piers")


if __name__ == "__main__":
    unittest.main()
