"""City Gen v4, phase 3 (HQ 3.26): every junction's control comes from the generator (the node's `junction`: priority,
mini, roundabout or signals, and a roundabout's `island` radius), and the client draws and drives it.

Under node, on the @3 Commons fixture (tests/fixtures/claude-hq@3.json.gz) packed by games/world.js, with
games/worldgeom.js, games/citylife.js, games/traffic.js and games/npcsim.js:
  - a mini roundabout is a white dome painted on the junction, and every turn the traffic takes through one keeps
    off it;
  - one busy main-road junction made a full roundabout (the fixture has none: a 32 m circle rarely fits today's
    layout) is a paved circle with a planted, kerbed island the road surface reads as raised ground, and the traffic
    and the residents' cars all go round its island;
  - the lights stand only where the generator says signals (tests/test_traffic_lights.py checks the rest).
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
for (var f of ["world", "worldgeom", "citylife", "traffic", "npcsim"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
var H = window.HQV, WD = H.world, G = H.worldgeom, CL = H.cityLife, T = H.traffic, NS = H.npcSim, out = {};
function raw(){ return JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/claude-hq@3.json.gz")).toString("utf8")); }
var DAY = Date.UTC(2026, 9, 27, 10);
function near(n, R){ var cx = n.x/100, cz = n.z/100, t = G.tileOf(cx, cz), tiles = [[t.tx, t.tz]];
  [[R, 0], [-R, 0], [0, R], [0, -R], [R, R], [-R, -R], [R, -R], [-R, R]].forEach(function(d){ var u = G.tileOf(cx + d[0], cz + d[1]); if(!tiles.some(function(q){ return q[0] === u.tx && q[1] === u.tz; })) tiles.push([u.tx, u.tz]); });
  return tiles; }
// the triangles of a tile's geometry `kind` whose corners all lie within r m of (x, z), and their colours
function tris(W, n, kind, r, col){
  var cx = n.x/100, cz = n.z/100, k = 0;
  near(n, r + 4).forEach(function(q){ var g = G.roadTile(W, q[0], q[1], false, false)[kind], p = g.pos, c = g.col, ix = g.idx;
    for(var i = 0; i < ix.length; i += 3){ var ok = true;
      for(var j = 0; j < 3; j++){ var v = ix[i + j]; if(Math.hypot(p[3*v] - cx, p[3*v + 2] - cz) > r) ok = false; }
      if(ok && (!col || Math.abs(c[3*ix[i]] - col[0]) + Math.abs(c[3*ix[i] + 1] - col[1]) + Math.abs(c[3*ix[i] + 2] - col[2]) < 0.02)) k++; } });
  return k; }
// the turns the traffic takes through node id: the least distance (m) of any point of them from its middle
function closest(sim, n){ var cx = n.x/100, cz = n.z/100, d = Infinity, k = 0;
  sim._.rings.forEach(function(r){ (r.raw || r.passes || []).forEach(function(p){ if(String(p.node) !== String(n.id) || !p.curve) return; k++;
    p.curve.forEach(function(q){ d = Math.min(d, Math.hypot(q[0] - cx, q[2] - cz)); }); }); });
  return {turns: k, d: d}; }

/* ---------- the Commons as generated: mini roundabouts ---------- */
var W = WD.pack(raw()), sim = T.create(WD.docOf(W), {tier: 5, seed: W.id, W: W, local: 0});
var minis = W.nodes.filter(function(n){ return n.junction === "mini"; });
out.kinds = {}; W.nodes.forEach(function(n){ if(n.junction) out.kinds[n.junction] = (out.kinds[n.junction] || 0) + 1; });
out.minis = minis.map(function(n){ var c = closest(sim, n); return {id: n.id, island: n.island, dome: tris(W, n, "marks", n.island/100 + 0.05, [0.92, 0.92, 0.88]), turns: c.turns, d: c.d}; });
var S = CL.signals(W);
out.lightsOff = Object.keys(S).filter(function(id){ var n = W.nodes.find(function(q){ return String(q.id) === id; }); return !n || n.junction !== "signals"; }).length;

/* ---------- one busy main-road junction made a full roundabout ---------- */
var d = raw(), busy = null, best = -1;
W.nodes.forEach(function(n){ if(n.junction !== "signals" && n.junction !== "mini") return; var c = closest(sim, n); if(c.turns > best){ best = c.turns; busy = n; } });
var rn = d.layers.roads.nodes.find(function(n){ return n.id === busy.id; });
rn.junction = "roundabout"; rn.island = 800;
var W2 = WD.pack(d), sim2 = T.create(WD.docOf(W2), {tier: 5, seed: W2.id, W: W2, local: 0}), n2 = W2.nodes.find(function(n){ return n.id === busy.id; });
var cx = n2.x/100, cz = n2.z/100, c2 = closest(sim2, n2);
out.full = {id: n2.id, turns: c2.turns, d: c2.d, island: 8,
  planted: tris(W2, n2, "walk", 8.05, [0.34, 0.47, 0.27]), circle: tris(W2, n2, "asphalt", 14.6, null),
  middle: WD.surfaceAt(W2, cx + 2, cz + 1), rim: WD.surfaceAt(W2, cx + 11, cz)};
// the residents' cars: a straight route through the middle of a full roundabout goes round its island instead
var line = []; for(var k = -30; k <= 30; k += 3) line.push(k, 0, 0);
var rr = NS.roundRoute(line, [{x: 0, z: 0, r: 8}]), minD = Infinity, ends = [rr[0], rr[rr.length - 3]];
for(var k = 0; k < rr.length; k += 3) minD = Math.min(minD, Math.hypot(rr[k], rr[k + 2]));
out.npc = {minD: minD, from: ends[0], to: ends[1], n: rr.length/3};
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class JunctionsV4(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", SCRIPT % {"root": json.dumps(ROOT)}], capture_output=True, text=True, timeout=600)
        if r.returncode != 0:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_the_commons_has_every_kind_but_a_full_roundabout(self):
        k = self.o["kinds"]
        self.assertGreater(k.get("priority", 0), 100)
        self.assertGreater(k.get("signals", 0), 10)
        self.assertGreater(k.get("mini", 0), 5)

    def test_a_mini_roundabout_is_a_painted_dome_the_traffic_drives_round(self):
        minis = self.o["minis"]
        self.assertTrue(minis)
        for m in minis:
            self.assertGreater(m["dome"], 0, m)
            if m["turns"]:
                self.assertGreaterEqual(m["d"], m["island"] / 100 + 0.5, m)
        self.assertTrue(any(m["turns"] for m in minis), "some traffic goes through a mini roundabout")

    def test_lights_only_where_the_world_says_signals(self):
        self.assertEqual(self.o["lightsOff"], 0)

    def test_a_full_roundabout_is_a_planted_island_everyone_goes_round(self):
        f = self.o["full"]
        self.assertGreater(f["planted"], 10, "the island's planted top")
        self.assertGreater(f["circle"], 10, "the paved circle round it")
        self.assertEqual(f["middle"], "sidewalk", "the island is raised ground, not road")
        self.assertEqual(f["rim"], "road")
        self.assertGreater(f["turns"], 0)
        self.assertGreaterEqual(f["d"], f["island"] + 0.5, "the traffic goes round the island")
        n = self.o["npc"]
        self.assertGreaterEqual(n["minD"], 8 + 2.9, "and so do the residents' cars (an arc 3 m off the island)")
        self.assertEqual((n["from"], n["to"]), (-30, 30), "from where the route came in to where it went on")


if __name__ == "__main__":
    unittest.main()
