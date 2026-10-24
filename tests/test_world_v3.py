"""HQ 3.15 world client (@3 docs): games/world.js, games/worldgeom.js, games/ocean.js and games/hqminimap.js on the new
layers (docs/plans/transport-revamp.md 5.1, 5.2).

Runs under node (skipped without it) on the hand-made tests/fixtures/world_v3_tiny.json (a 640 m island with a lake and
its island, a canal with quays and a bridge, a marina with a breakwater, piers and berths, metro M1 with two stations,
entrances, a portal and its holes, the City Line and an Island Link portal, a gondola, a tram avenue) and, when part
worldgen has written them, on tests/fixtures/claude-hq@3.json.gz and tests/fixtures/island@3.json.gz.

Checks: the live ids; pack -> structured clone (the worker's copy) -> docOf round trip of the four layers; the metre
views (cm -> m, Q16 fronts -> yaw, memoised, null on @1/@2); waterAt / holeAt / deckAt / groundAt / rayGround /
blockedAt / surfaceAt; ocean.seaOf on bodies, piers, the breakwater and a canal bridge; the terrain, road and ground
tiles leave every hole open (no triangle centroid inside one, at every LOD, and the terrain's plan area is the world's
less the holes'); no lamp or tree in a hole or a body; tram streets carry white tram-lane edge lines and no yellow,
on the edges games/traffic.js lays its trams on; the water geometry (surface at each body's y with islands cut out,
quays, breakwater, plants, foam, deterministic, within the 40k triangle budget); the minimap's water, lines and
underground mode."""
import gzip
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIX = os.path.join(ROOT, "tests", "fixtures")
TINY = os.path.join(FIX, "world_v3_tiny.json")
REAL = [os.path.join(FIX, "claude-hq@3.json.gz"), os.path.join(FIX, "island@3.json.gz")]
NODE = shutil.which("node")

PRELUDE = r"""
var fs = require("fs"), zlib = require("zlib"), v8 = require("v8"), root = %(root)s;
global.window = {HQV: {}};
["world", "worldgeom", "ocean", "traffic"].forEach(function(f){ new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))(); });
var H = window.HQV.world, G = window.HQV.worldgeom, O = window.HQV.ocean, T = window.HQV.traffic;
function load(p){ var b = fs.readFileSync(p); return JSON.parse(p.slice(-3) === ".gz" ? zlib.gunzipSync(b) : b); }
function inP(P, x, z){
  var ins = false;
  for(var i = 0, j = P.length - 1; i < P.length; j = i++){ var a = P[i], c = P[j]; if((a[1] > z) !== (c[1] > z) && x < (c[0] - a[0])*(z - a[1])/(c[1] - a[1]) + a[0]) ins = !ins; }
  return ins;
}
function area(P){ var s = 0; for(var k = 0; k < P.length; k++){ var a = P[k], b = P[(k + 1) % P.length]; s += a[0]*b[1] - b[0]*a[1]; } return Math.abs(s)/2; }
// every triangle of a geo: its plan centroid, its plan area (signed: + faces up), its vertices
function tris(g, fn){
  var p = g.pos, I = g.idx;
  for(var t = 0; t < I.length; t += 3){
    var a = 3*I[t], b = 3*I[t+1], c = 3*I[t+2];
    var A = ((p[b] - p[a])*(p[c+2] - p[a+2]) - (p[b+2] - p[a+2])*(p[c] - p[a]))/2;
    fn((p[a] + p[b] + p[c])/3, (p[a+2] + p[b+2] + p[c+2])/3, -A, [a, b, c], t/3);
  }
}
function done(o){ process.stdout.write(JSON.stringify(o)); }
"""


def run(body, *args):
    src = PRELUDE.replace("%(root)s", json.dumps(ROOT)) + body
    p = subprocess.run([NODE, "-e", src] + list(args), capture_output=True, text=True, timeout=900)
    if p.returncode != 0:
        raise AssertionError("node failed:\n" + p.stderr[-4000:])
    return json.loads(p.stdout)


class LiveIds(unittest.TestCase):
    @unittest.skipUnless(NODE, "node is not installed")
    def test_live_ids(self):
        o = run(r"""
var U = "0b8e4c1a-3f2d-4e5b-9a6c-7d8e9f0a1b2c";
done({c: [H.LIVE_V, H.COMMONS, H.COMMONS_V2, H.ID],
  island: [H.islandId(U), H.islandId(U, 2), H.islandId(U.toUpperCase()), H.islandId("user:" + U + "@2"), H.islandId(U, 1), H.islandId("nope"), H.islandId(null)],
  live: ["claude-hq@1", "claude-hq@2", "claude-hq@3", "claude-hq@4", "user:" + U + "@2", "user:" + U + "@3", "user:" + U + "@1",
         "user:" + U.toUpperCase() + "@3", "user:x@3", "", null, 3].map(function(id){ return H.isLive(id); }),
  owner: ["claude-hq@3", "claude-hq@1", "user:" + U + "@3", "user:" + U + "@2", "bad", null].map(H.ownerOf),
  ver: ["claude-hq@1", "claude-hq@2", "claude-hq@3", "user:" + U + "@2", "user:" + U + "@3", "claude-hq@9", "x", null].map(H.versionOf),
  re: [H.WORLD_RE.test("claude-hq@3"), H.WORLD_RE.test("user:" + U + "@3"), H.WORLD_RE.test("claude-hq@2"), H.WORLD_RE.test("user:" + U + "@4")],
  // load() accepts the live ids (a bad id is refused before any fetch)
  bad: null});
""")
        U = "0b8e4c1a-3f2d-4e5b-9a6c-7d8e9f0a1b2c"
        self.assertEqual(o["c"], [3, "claude-hq@3", "claude-hq@2", "claude-hq@1"])
        self.assertEqual(o["island"], ["user:%s@3" % U, "user:%s@2" % U, "user:%s@3" % U, "user:%s@3" % U, None, None, None])
        self.assertEqual(o["live"], [True, True, True, False, True, True, False, False, False, False, False, False])
        self.assertEqual(o["owner"], ["commons", "commons", U, U, None, None])
        self.assertEqual(o["ver"], [1, 2, 3, 2, 3, 0, 0, 0])
        self.assertEqual(o["re"], [True, True, True, False])


@unittest.skipUnless(NODE, "node is not installed")
class TinyV3(unittest.TestCase):
    out = None

    @classmethod
    def setUpClass(cls):
        cls.out = run(r"""
var doc = load(process.argv[1]), W = H.pack(doc), out = {};
// ---- round trip: pack -> structured clone (IndexedDB, the worker) -> docOf ----
var W2 = v8.deserialize(v8.serialize(H.cacheCopy(W)));
var D = H.docOf(W2);
out.round = ["water", "metro", "rail", "gondola"].map(function(k){
  return [k, JSON.stringify(W[k]) === JSON.stringify(doc.layers[k]), JSON.stringify(W2[k]) === JSON.stringify(doc.layers[k]), JSON.stringify(D.layers[k]) === JSON.stringify(doc.layers[k])];
});
// the worker builds from its clone exactly what the page builds
var job = {tx: 3, tz: 4, lods: [0, 0, 1, 2, 0, 0, 1, 2, 0, 1, 1, 2, 2, 2, 2, 2], want: ["terrain", "roads", "ground", "buildings0", "props"], tier: 5};
var a = G.buildTile(W, job), Wc = v8.deserialize(v8.serialize(Object.assign({}, W, {index: null})));
var b = G.buildTile(Wc, job);
function sig(m){ return JSON.stringify(m, function(k, v){ return ArrayBuffer.isView(v) ? Array.prototype.slice.call(v, 0, 60).concat([v.length]) : v; }); }
out.worker = sig(a) === sig(b);
// ---- metre views ----
var Wv = H.waterOf(W), Mv = H.metroOf(W), Rv = H.railOf(W), Gv = H.gondolaOf(W);
out.memo = [H.waterOf(W) === Wv, H.metroOf(W) === Mv, H.railOf(W) === Rv, H.gondolaOf(W) === Gv, H.waterOf(G.view(W, 3)) === Wv];
out.water = {bodies: Wv.bodies.map(function(b){ return [b.id, b.kind, b.level, b.bed, b.y, b.edge, b.islands.length, b.joins, b.tier, b.poly.length, b.box]; }),
  lakePoly0: Wv.bodies[0].poly.slice(0, 2), piers: Wv.piers.map(function(p){ return [p.id, p.body, p.kind, p.x, p.y, p.z, +p.yaw.toFixed(6), p.len, p.w]; }),
  berths: Wv.berths.map(function(b){ return [b.body, b.x, b.z, +b.yaw.toFixed(6)]; }), breakwater: Wv.breakwater, lighthouse: Wv.lighthouse,
  net: Wv.net, routes: Wv.routes};
out.metro = {lines: Mv.lines.map(function(l){ return [l.id, l.path.length, l.path[0], l.kinds.length, l.depot]; }),
  stations: Mv.stations.map(function(s){ return [s.id, s.x, s.y, s.z, +s.yaw.toFixed(6), s.len, s.hall_y, s.platform]; }),
  entrances: Mv.entrances.map(function(e){ return [e.id, e.station, e.kind, +e.yaw.toFixed(6), e.w, e.d, e.hole.length, e.hole[0]]; }),
  portals: Mv.portals.map(function(p){ return [p.id, p.line, +p.yaw.toFixed(6), p.w, p.len]; }), holes: Mv.holes.length, depots: Mv.depots[0].tracks.length};
out.rail = {lines: Rv.lines.map(function(l){ return [l.id, l.kind, l.path.length]; }), sea: [Rv.sea.x, Rv.sea.z, +Rv.sea.yaw.toFixed(6)],
  stations: Rv.stations.map(function(s){ return [s.id, s.kind, +s.yaw.toFixed(6), s.platforms, s.stairs]; }), holes: Rv.holes.length};
out.gondola = Gv.lines.map(function(l){ return [l.id, l.kind, l.stations.map(function(s){ return +s.yaw.toFixed(6); }), l.towers.map(function(t){ return t.h; })]; });
out.holesOf = H.holesOf(W).length;
// none on @1 / @2
var at1 = H.pack(load(process.argv[2])), at2 = H.pack(load(process.argv[3]));
out.none = [at1, at2].map(function(V){ return [H.waterOf(V), H.metroOf(V), H.railOf(V), H.gondolaOf(V), H.holeAt(V, 0, 0), H.waterAt(V, 0, 0), H.deckAt(V, 0, 0), H.holesOf(V).length]; });
// ---- point queries ----
function id(b){ return b ? b.id : null; }
var P = {lake: [-120, 70], isle: [-120, 100], canal: [120, -60], bridge: [100, -60], marina: [200, -50], pier0: [60, -52], pier2: [200, -30],
         breakwater: [275, -90], land: [-60, 60], sea: [300, 0], ent0: [-81, 10.6], ent1: [80, 25], portal: [-220, 30], il: [-200, -230], street: [-81, 13]};
out.pt = {};
Object.keys(P).forEach(function(k){
  var x = P[k][0], z = P[k][1];
  out.pt[k] = {water: id(H.waterAt(W, x, z)), hole: H.holeAt(W, x, z), deck: H.deckAt(W, x, z), blocked: H.blockedAt(W, x, z), surface: H.surfaceAt(W, x, z),
               ground: H.groundAt(W, x, z), street: H.streetAt(W, x, z), floor: H.holeFloor(W, x, z)};
});
// a ray straight down through an entrance's hole finds no ground at street level; beside it, it does
function ray(x, z){ return H.rayGround(W, {x: x, y: 20, z: z}, {x: x, y: 0, z: z}, 0.5); }
out.ray = {hole: ray(-81, 10.6), beside: ray(-81, 13), portal: ray(-220, 30)};
// slopes and normals stay finite next to a hole
out.finite = [H.normalAt(W, -84.2, 10.6).y, H.slopeAlong(W, -81, 12, 0, 1.5)].every(isFinite);
// trees: none in a body, on a pier or within 2 m of a hole
var tr = H.trees(W);
out.trees = {n: tr.length, wet: tr.filter(function(t){ return H.waterAt(W, t.x, t.z) || H.deckAt(W, t.x, t.z) != null; }).length,
             holed: tr.filter(function(t){ return H.holeAt(W, t.x, t.z); }).length};
// ---- ocean.seaOf ----
var S = O.seaOf(H.docOf(W));
out.sea = {};
Object.keys(P).forEach(function(k){ var x = P[k][0], z = P[k][1]; out.sea[k] = [S.land(x, z), S.boat.land(x, z), +S.level(x, z).toFixed(4), S.swell(x, z, 3.3)]; });
out.sea.piers = S.piers.length;
out.oceanWater = (function(){ var Wd = O.waterOf(doc); return Wd ? [Wd.bodies.map(function(b){ return [b.id, b.y]; }), Wd.piers.length, !!Wd.breakwater] : null; })();
out.oceanNone = O.waterOf(load(process.argv[3]));
done(out);
""", TINY, os.path.join(FIX, "claude-hq@1.json.gz"), os.path.join(FIX, "island@2.json.gz"))

    def test_round_trip(self):
        for k, packed, cloned, doc in self.out["round"]:
            self.assertTrue(packed and cloned and doc, k)
        self.assertTrue(self.out["worker"])

    def test_views(self):
        o = self.out
        self.assertEqual(o["memo"], [True] * 5)
        b = {x[0]: x for x in o["water"]["bodies"]}
        self.assertEqual(b["lake:0"][1:10], ["lake", 3, 2.5, 3, "bank", 1, None, 1, 40])
        self.assertEqual(b["canal:0"][1:9], ["canal", 0, 2.5, 0.3, "quay", 0, "marina:0", 1])     # raised to the river's calm level
        self.assertEqual(b["marina:0"][4], 0.3)
        self.assertEqual(b["canal:0"][10], {"x0": 40, "z0": -71, "x1": 160, "z1": -49})
        piers = {p[0]: p for p in o["water"]["piers"]}
        self.assertEqual(piers["pier:0"], ["pier:0", "canal:0", "waterbus", 60, 1.2, -52, round(3.141593, 6), 6, 3])
        self.assertEqual(o["water"]["berths"][0], ["marina:0", 215, -35, round(1.570796, 6)])
        self.assertEqual(o["water"]["breakwater"], [[275, -115], [275, -65]])
        self.assertEqual(o["water"]["lighthouse"], [275, -115])
        self.assertEqual(o["water"]["net"]["nodes"][0], [60, -60])
        self.assertEqual(o["water"]["net"]["edges"], [[0, 1], [1, 2], [2, 3]])
        self.assertEqual([r["id"] for r in o["water"]["routes"]], ["W1", "L1"])
        m = o["metro"]
        self.assertEqual(m["lines"][0], ["M1", 7, [-260, 3, 30], 6, "depot:0"])
        self.assertEqual(m["stations"][0], ["metro:0", -80, -10, 0, round(1.570796, 6), 90, -5, "side"])
        self.assertEqual(m["entrances"][1][:7], ["ent:1", "metro:1", "escalator", round(3.141593, 6), 3, 5, 4])
        self.assertEqual(m["portals"][0], ["portal:0", "M1", round(1.570796, 6), 9, 30])
        self.assertEqual((m["holes"], m["depots"]), (3, 2))
        r = self.out["rail"]
        self.assertEqual(r["lines"], [["CL", "city", 3], ["IL", "island", 4]])
        self.assertEqual(r["sea"], [-200, -270, round(3.141593, 6)])
        self.assertEqual(r["stations"][0], ["rail:0", "elevated", 0, 2, [[6, 40]]])
        self.assertEqual(r["holes"], 1)
        self.assertEqual(self.out["gondola"], [["G1", "crossing", [round(1.570796, 6), round(-1.570796, 6)], [24, 24]]])
        self.assertEqual(self.out["holesOf"], 4)        # three metro holes (each listed twice, kept once) and the IL portal
        for row in self.out["none"]:
            self.assertEqual(row, [None, None, None, None, False, None, None, 0])

    def test_points(self):
        p = self.out["pt"]
        self.assertEqual(p["lake"]["water"], "lake:0")
        self.assertTrue(p["lake"]["blocked"])
        self.assertEqual(p["lake"]["surface"], "water")
        self.assertIsNone(p["isle"]["water"])                 # the lake's island is land
        self.assertFalse(p["isle"]["blocked"])
        self.assertEqual(p["canal"]["water"], "canal:0")
        self.assertTrue(p["canal"]["blocked"])
        self.assertEqual(p["bridge"]["water"], "canal:0")     # the canal under the bridge...
        self.assertFalse(p["bridge"]["blocked"])              # ...but you walk the deck
        self.assertEqual(p["marina"]["water"], "marina:0")
        for k in ("pier0", "pier2", "breakwater"):
            self.assertIsNone(p[k]["water"], k)
            self.assertFalse(p[k]["blocked"], k)
            self.assertEqual(p[k]["ground"], p[k]["deck"], k)
        self.assertEqual(p["pier0"]["deck"], 1.2)
        self.assertEqual(p["breakwater"]["deck"], 2.5)          # the crown walk over sea level 0
        self.assertIsNone(p["land"]["water"])
        self.assertFalse(p["land"]["blocked"])
        for k in ("ent0", "ent1", "portal", "il"):
            self.assertTrue(p[k]["hole"], k)
            self.assertLess(p[k]["ground"], p[k]["street"] - 0.5, k)   # no ground at street level
            self.assertEqual(p[k]["ground"], p[k]["floor"], k)
        self.assertEqual(p["ent0"]["floor"], -5)                # the ticket hall
        self.assertAlmostEqual(p["portal"]["floor"], -0.5, 6)   # the track in the trench
        self.assertFalse(p["street"]["hole"])
        self.assertIsNone(p["street"]["floor"])
        self.assertEqual(p["street"]["ground"], p["street"]["street"])
        r = self.out["ray"]
        self.assertEqual(r["hole"], 1)                          # straight down the stair well: nothing at street level
        self.assertLess(r["beside"], 1)
        self.assertEqual(r["portal"], 1)
        self.assertTrue(self.out["finite"])
        t = self.out["trees"]
        self.assertGreater(t["n"], 50)
        self.assertEqual((t["wet"], t["holed"]), (0, 0))

    def test_sea_of(self):
        s = self.out["sea"]
        self.assertEqual(s["lake"][:3], [False, False, 3])         # boats float on the lake at its level, people cannot walk on it
        self.assertEqual(s["lake"][3], 0)                          # calm
        self.assertEqual(s["isle"][:2], [True, True])
        self.assertEqual(s["canal"][:3], [False, False, 0.3])
        self.assertEqual(s["bridge"][:2], [True, False])           # a deck for people, open water under it for a hull
        self.assertEqual(s["marina"][:3], [False, False, 0.3])
        for k in ("pier0", "pier2", "breakwater"):
            self.assertEqual(s[k][:2], [True, True], k)            # land for people and for hulls
        self.assertEqual(s["land"][:2], [True, True])
        self.assertEqual(s["sea"][:3], [False, False, 0])
        self.assertEqual(s["piers"], 3)
        self.assertEqual(self.out["oceanWater"], [[["lake:0", 3], ["canal:0", 0.3], ["marina:0", 0.3]], 3, True])
        self.assertIsNone(self.out["oceanNone"])


@unittest.skipUnless(NODE, "node is not installed")
class TinyV3Geometry(unittest.TestCase):
    out = None

    @classmethod
    def setUpClass(cls):
        cls.out = run(r"""
var W = H.pack(load(process.argv[1])), out = {}, holes = H.holesOf(W);
function inHole(x, z){ return holes.some(function(P){ return inP(P, x, z); }); }
// ---- holes: terrain at every lod, roads and ground, every tile ----
var bad = {terrain: 0, roads: 0, ground: 0}, upArea = [0, 0, 0], skirtsIn = 0;
for(var l = 0; l < 3; l++){
  var lods = []; for(var k = 0; k < 16; k++) lods.push(l);
  for(var tz = 0; tz < 8; tz++) for(var tx = 0; tx < 8; tx++){
    var TT = G.terrainTile(W, tx, tz, lods);
    tris(TT, function(x, z, A){ if(A > 1e-9){ upArea[l] += A; if(inHole(x, z)) bad.terrain++; } else if(Math.abs(A) <= 1e-9 && inHole(x, z)) skirtsIn++; });
    if(l) continue;
    var R = G.roadTile(W, tx, tz);
    [R.asphalt, R.marks, R.walk, R.kerb].forEach(function(g){ tris(g, function(x, z){ if(inHole(x, z)) bad.roads++; }); });
    tris(G.groundTile(W, tx, tz), function(x, z){ if(inHole(x, z)) bad.ground++; });
  }
}
out.bad = bad; out.skirtsIn = skirtsIn;
out.area = {up: upArea, want: 2048*2048 - holes.reduce(function(s, P){ return s + area(P); }, 0)};
// the walk ribbon really did run over the entrance on the pavement (cut, not missing): its triangles round the hole
var walkNear = 0;
for(var tz2 = 3; tz2 <= 4; tz2++) for(var tx2 = 3; tx2 <= 4; tx2++) tris(G.roadTile(W, tx2, tz2).walk, function(x, z, A){ if(A > 0 && Math.abs(x + 81) < 4 && Math.abs(z - 10.6) < 2) walkNear++; });
out.walkNear = walkNear;
// a doc without holes builds exactly as before: the same tile from the doc less its metro and rail layers
var doc0 = load(process.argv[1]); delete doc0.layers.metro; delete doc0.layers.rail;
var W0 = H.pack(doc0), t0 = G.terrainTile(W0, 3, 4, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), t1 = G.terrainTile(W, 2, 0, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
out.noHoleTiles = [t0.idx.length > 0, G.holeSet(W0), JSON.stringify(Array.from(t1.pos)) === JSON.stringify(Array.from(G.terrainTile(H.pack(doc0), 2, 0, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).pos))];
// ---- props: no lamp, sign, parked car or tree in a hole ----
var propsIn = 0, nprops = 0;
for(var tz3 = 0; tz3 < 8; tz3++) for(var tx3 = 0; tx3 < 8; tx3++){
  var Pp = G.props(W, tx3, tz3);
  ["trees", "lamps", "parked", "signs"].forEach(function(k){ Pp[k].forEach(function(o){ nprops++; if(inHole(o.x, o.z)) propsIn++; }); });
}
out.props = [nprops, propsIn];
// ---- tram streets: their marks are white tram-lane edge lines, no yellow; traffic.js lays the trams on the same edges ----
var mk = {yellow: 0, white: 0, edgeLines: {}}, te = G.tramEdges(W);
for(var tz4 = 0; tz4 < 8; tz4++) for(var tx4 = 0; tx4 < 8; tx4++){
  var M = G.roadTile(W, tx4, tz4).marks, c = M.col, p = M.pos;
  for(var v = 0; v < c.length; v += 3){
    var yel = Math.abs(c[v] - 0.95) < 1e-6 && Math.abs(c[v+1] - 0.74) < 1e-6;
    if(yel) mk.yellow++; else mk.white++;
    // along the avenue (z = 0) between junctions: the line edges, rounded to cm
    if(!yel && p[v] > -230 && p[v] < -80) mk.edgeLines[Math.round(p[v+2]*100)] = 1;
  }
}
mk.edgeLines = Object.keys(mk.edgeLines).map(Number).sort(function(a, b){ return a - b; });
out.marks = mk;
function num(a, b){ return a - b; }
out.tram = {ours: Object.keys(te).map(Number).sort(num), traffic: T.lanes(W, 5).filter(function(o){ return o.tram; }).map(function(o){ return o.id; }).sort(num),
            off: T.lanes(W, 5).filter(function(o){ return o.tram; })[0].tramOff};
// without the tram line the avenue keeps its double yellow
var doc1 = load(process.argv[1]); doc1.layers.transit.lines = doc1.layers.transit.lines.filter(function(l){ return l.kind !== "tram"; });
var W1 = H.pack(doc1), y1 = 0;
for(var tx5 = 2; tx5 < 6; tx5++){ var c1 = G.roadTile(W1, tx5, 4).marks.col; for(var v1 = 0; v1 < c1.length; v1 += 3) if(Math.abs(c1[v1] - 0.95) < 1e-6 && Math.abs(c1[v1+1] - 0.74) < 1e-6) y1++; }
out.noTramYellow = y1;
// ---- water geometry ----
var wg = G.waterGeo(W), Wv = H.waterOf(W), lake = Wv.bodies[0], isle = [];
for(var i = 0; i < lake.islands[0].length; i += 2) isle.push([lake.islands[0][i], lake.islands[0][i+1]]);
var sIn = 0, sYs = {}, lit = {}, up = 0, n = 0;
tris(wg.surface, function(x, z, A, vs){
  n++; if(A > 0) up++;
  if(inP(isle, x, z)) sIn++;
  var b = H.waterAt(W, x, z) || H.waterOf(W).bodies.filter(function(bb){ var P = []; for(var j = 0; j < bb.poly.length; j += 2) P.push([bb.poly[j], bb.poly[j+1]]); return inP(P, x, z); })[0];
  if(b){ sYs[b.id + ":" + wg.surface.pos[vs[0] + 1].toFixed(3)] = 1; lit[b.id + ":" + wg.surface.lit[vs[0]/3]] = 1; }
});
var memo = G.waterGeo(W) === wg;
out.water = {tris: n, up: up, inIsland: sIn, ys: Object.keys(sYs).sort(), lit: Object.keys(lit).sort(), works: wg.works.idx.length/3, foam: wg.foam.idx.length/3,
             again: JSON.stringify(Array.from(G.waterGeo(H.pack(load(process.argv[1]))).works.pos)) === JSON.stringify(Array.from(wg.works.pos)),
             memo: memo};
// quay walls: vertical faces along the canal's long edges (z = -71 and -49) from under its bed to above the street
var qz = {}, ylo = Infinity, yhi = -Infinity;
tris(wg.works, function(x, z, A, vs){
  if(Math.abs(A) > 1e-6 || x < 45 || x > 155) return;
  [-71, -49].forEach(function(e){ if(Math.abs(z - e) < 0.01){ qz[e] = 1; vs.forEach(function(v){ ylo = Math.min(ylo, wg.works.pos[v+1]); yhi = Math.max(yhi, wg.works.pos[v+1]); }); } });
});
out.quay = {edges: Object.keys(qz).map(Number), ylo: ylo, yhi: yhi};
// bank strips (ground items of kind bank) round the lake and its island, none along the quays
var banks = G.groundItems(W).filter(function(it){ return it.kind === "bank"; });
out.banks = {n: banks.length, onCanal: banks.filter(function(it){ return it.P.some(function(q){ return q[0] > 40 && q[0] < 160 && q[1] > -75 && q[1] < -45; }); }).length};
// @1 / @2: nothing new
// the per-tile draw rule (worldbuild: <= 8 near, <= 4 far): @3 adds no per-tile product (holes and banks ride in the
// terrain, roads and ground a tile already has)
var job = G.buildTile(W, {tx: 3, tz: 3, lods: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], want: ["terrain", "roads", "ground", "buildings0", "buildings1", "props"]});
out.products = {tile: Object.keys(job).sort(), roads: Object.keys(job.roads).sort(), props: Object.keys(job.props).sort()};
out.empty = [load(process.argv[2]), load(process.argv[3])].map(function(d){ var V = H.pack(d), g = G.waterGeo(V); return [g.surface.idx.length, g.works.idx.length, g.foam.idx.length, G.holeSet(V)]; });
done(out);
""", TINY, os.path.join(FIX, "claude-hq@1.json.gz"), os.path.join(FIX, "island@2.json.gz"))

    def test_holes_are_open(self):
        self.assertEqual(self.out["bad"], {"terrain": 0, "roads": 0, "ground": 0})
        self.assertEqual(self.out["skirtsIn"], 0)
        a = self.out["area"]
        for up in a["up"]:
            self.assertAlmostEqual(up, a["want"], delta=0.05)    # the terrain covers the world less exactly the holes
        self.assertGreater(self.out["walkNear"], 0)
        nh = self.out["noHoleTiles"]
        self.assertTrue(nh[0])
        self.assertIsNone(nh[1])
        self.assertTrue(nh[2])

    def test_props_clear_of_holes(self):
        n, inside = self.out["props"]
        self.assertGreater(n, 20)
        self.assertEqual(inside, 0)

    def test_tram_marks(self):
        m = self.out["marks"]
        self.assertEqual(m["yellow"], 0)
        self.assertGreater(m["white"], 0)
        # the two tram-lane edge lines: 1.475 + 2.65/2 + 0.15 = 2.95 m each side of the centre, 12 cm wide
        self.assertEqual(m["edgeLines"], [-301, -289, 289, 301])
        t = self.out["tram"]
        self.assertEqual(t["ours"], t["traffic"])
        self.assertEqual(t["ours"], [0, 1, 2, 3])
        self.assertAlmostEqual(t["off"], 1.475, 9)
        self.assertGreater(self.out["noTramYellow"], 0)

    def test_per_tile_products(self):
        p = self.out["products"]
        self.assertEqual(p["tile"], ["buildings0", "buildings1", "ground", "id", "lods", "op", "props", "roads", "terrain", "tx", "tz"])
        self.assertEqual(p["roads"], ["asphalt", "bridge", "kerb", "marks", "walk"])    # the canal's bridge
        self.assertEqual(p["props"], ["gantries", "lamps", "parked", "signs", "trees"])

    def test_water_geometry(self):
        w = self.out["water"]
        self.assertEqual(w["up"], w["tris"])                   # every surface triangle faces up
        self.assertEqual(w["inIsland"], 0)                     # the island is cut out
        self.assertEqual(w["ys"], ["canal:0:0.300", "lake:0:3.000", "marina:0:0.300"])
        self.assertEqual(w["lit"], ["canal:0:0", "lake:0:1", "marina:0:0"])   # the calm lake variant on the lake only
        self.assertGreater(w["works"], 500)
        self.assertGreater(w["foam"], 10)
        self.assertLess(w["tris"] + w["works"] + w["foam"], 40000)   # the 3.14 budget: 40k triangles
        self.assertTrue(w["again"])
        self.assertTrue(w["memo"])
        q = self.out["quay"]
        self.assertEqual(sorted(q["edges"]), [-71, -49])
        self.assertLess(q["ylo"], 0.3 - 2.5)                    # from under the bed
        self.assertGreater(q["yhi"], 0.3 + 0.7)                  # up past the water to the coping
        self.assertGreater(self.out["banks"]["n"], 20)
        self.assertEqual(self.out["banks"]["onCanal"], 0)
        for row in self.out["empty"]:
            self.assertEqual(row, [0, 0, 0, None])


MINIMAP = r"""
const fs = require('fs'), zlib = require('zlib');
const [ROOT, FIXT] = process.argv.slice(1);
function fakeCtx(cv){
  const ctx = {canvas: cv, fills: [], strokes: [], dashes: [], alpha: [], log: {}, globalAlpha: 1};
  ['save','restore','translate','rotate','scale','beginPath','moveTo','lineTo','arcTo','closePath','arc','rect',
   'quadraticCurveTo','bezierCurveTo','fillRect','clearRect','setTransform','fillText','strokeText','clip','drawImage'].forEach(k => {
    ctx[k] = (...a) => { ctx.log[k] = (ctx.log[k] || 0) + 1; if(k === 'drawImage') ctx.alpha.push(ctx.globalAlpha); if(k === 'fillText') (ctx.texts = ctx.texts || []).push(a[0]); };
  });
  ctx.fill = () => { ctx.fills.push(ctx.fillStyle); };
  ctx.stroke = () => { ctx.strokes.push(ctx.strokeStyle); };
  ctx.setLineDash = d => { ctx.dashes.push(d.length); };
  ctx.measureText = t => ({width: String(t).length*6});
  return ctx;
}
class El {
  constructor(tag){ this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.className = ''; this.attrs = {}; this.listeners = {};
    this.style = {}; this.textContent = ''; this.width = 300; this.height = 150; this.clientWidth = 200; this.clientHeight = 200; }
  appendChild(c){ c.parentNode = this; this.children.push(c); return c; }
  removeChild(c){ this.children = this.children.filter(x => x !== c); return c; }
  setAttribute(k, v){ this.attrs[k] = String(v); }
  getAttribute(k){ return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, f){ (this.listeners[t] = this.listeners[t] || []).push(f); }
  removeEventListener(){}
  getContext(k){ return this.tagName === 'CANVAS' && k === '2d' ? (this._ctx = this._ctx || fakeCtx(this)) : null; }
  getBoundingClientRect(){ return {left: 0, top: 0, width: 200, height: 200}; }
}
const document = {createElement: t => new El(t)};
let clock = 0;
const window = {HQV: {}, document, devicePixelRatio: 1, console, performance: {now: () => clock}, addEventListener(){}, removeEventListener(){},
                getComputedStyle: () => ({getPropertyValue: n => n === '--bg' ? ' #0c0d10' : ''})};
new Function('window', fs.readFileSync(ROOT + '/games/world.js', 'utf8'))(window);
new Function('window', fs.readFileSync(ROOT + '/games/hqminimap.js', 'utf8'))(window);
const M = window.HQV.hqminimap, WD = window.HQV.world;
const W = WD.pack(JSON.parse(fs.readFileSync(FIXT, 'utf8')));
let under = false;
const stage = new El('div');
const mm = M.mount(stage, {under: () => under});
mm.setWorld(W, 5, {});
const st = mm.layers().static._ctx, root = stage.children[0], cv = root.children[0], g = cv._ctx;
const out = {lines: M.transitLines(W).map(L => [L.id, L.kind, L.col, L.segs.map(s => [s.under, s.pts.length]), L.stations.length]),
             layer: mm.layers().lines, water: st.fills.filter(f => f === '#1a4a6b').length, land: st.fills.filter(f => f === '#1d2620').length,
             quay: st.strokes.filter(f => f === '#8a8578').length, piers: st.fills.filter(f => f === '#c8b48a').length};
mm.frame({x: -100, z: 0, yaw: 0, speed: 0, dt: 0.016});
out.surface = {alpha: g.alpha.slice(-1)[0], dashed: g.dashes.filter(n => n > 0).length, attr: root.getAttribute('data-under'), red: g.strokes.filter(s => s === '#d64541').length};
g.dashes = []; g.strokes = [];
under = true; clock += 16;
mm.frame({x: -100, z: 0, yaw: 0, speed: 0, dt: 0.016});
out.under = {alpha: g.alpha.slice(-1)[0], attr: root.getAttribute('data-under'), label: cv.getAttribute('aria-label'), flag: mm.under(),
             metroDashed: g.dashes.filter(n => n > 0).length, red: g.strokes.filter(s => s === '#d64541').length};
under = false; clock += 16;
mm.frame({x: -100, z: 0, yaw: 0, speed: 0, dt: 0.016});
out.back = root.getAttribute('data-under');
// the big map names the lines
mm.expand(true); clock += 16; g.texts = [];
mm.frame({x: -100, z: 0, yaw: 0, speed: 0, dt: 0.016});
out.names = (g.texts || []).filter(t => /^(M1|CL|IL|G1)$/.test(t)).sort();
process.stdout.write(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
class MinimapV3(unittest.TestCase):
    def test_water_lines_and_underground(self):
        p = subprocess.run([NODE, "-e", MINIMAP, ROOT, TINY], capture_output=True, text=True, timeout=120)
        self.assertEqual(p.returncode, 0, p.stderr[-3000:])
        o = json.loads(p.stdout)
        self.assertEqual([l[0] for l in o["lines"]], ["M1", "CL", "IL", "G1"])
        m1 = o["lines"][0]
        self.assertEqual(m1[1:3], ["metro", "#d64541"])
        self.assertEqual(m1[3], [[False, 3], [True, 5]])          # open + portal, then cut-and-cover and bored (dashed)
        self.assertEqual(m1[4], 2)
        self.assertEqual(o["lines"][2][3], [[True, 2], [False, 3]])   # the Island Link: tunnel, then out of its portal
        self.assertEqual(o["lines"][3][3], [[False, 4]])             # the gondola: station, two towers, station
        self.assertEqual(o["layer"], 4)
        self.assertGreaterEqual(o["water"], 3)                    # the lake, canal and marina (and the river: none here)
        self.assertGreaterEqual(o["land"], 2)                     # the coast and the lake's island
        self.assertGreaterEqual(o["quay"], 3)                     # the canal's and marina's edges, the breakwater
        self.assertEqual(o["piers"], 3)
        s, u = o["surface"], o["under"]
        self.assertEqual(s["alpha"], 1)
        self.assertGreater(s["dashed"], 0)                        # underground metro dashed on the surface map
        self.assertEqual(s["attr"], "false")
        self.assertLess(u["alpha"], 0.5)                          # the surface dims underground
        self.assertEqual(u["attr"], "true")
        self.assertTrue(u["flag"])
        self.assertIn("underground", u["label"])
        self.assertGreater(u["red"], 0)
        self.assertEqual(o["back"], "false")
        self.assertEqual(o["names"], ["CL", "G1", "IL", "M1"])


REAL_BODY = r"""
var W = H.pack(load(process.argv[1])), out = {id: W.id, v: W.v}, holes = H.holesOf(W);
function inHole(x, z){ return holes.some(function(P){ return inP(P, x, z); }); }
var Wv = H.waterOf(W), Mv = H.metroOf(W), Rv = H.railOf(W), Gv = H.gondolaOf(W);
out.has = [!!Wv, !!Mv, !!Rv, !!Gv];
out.bodies = Wv ? Wv.bodies.length : 0;
// a point inside each body (its first ear's centroid, off its islands) is water and blocked; each pier's middle is a deck
var wet = 0, blocked = 0, sea = 0, S = O.seaOf(H.docOf(W));
if(Wv) Wv.bodies.forEach(function(b){
  var P = []; for(var i = 0; i < b.poly.length; i += 2) P.push([b.poly[i], b.poly[i+1]]);
  var t = G.triangulate(b.poly), hit = false;
  for(var k = 0; k < t.length && !hit; k += 3){
    var x = (P[t[k]][0] + P[t[k+1]][0] + P[t[k+2]][0])/3, z = (P[t[k]][1] + P[t[k+1]][1] + P[t[k+2]][1])/3;
    if(!H.waterAt(W, x, z) || H.roadY(W, x, z) != null) continue;
    hit = true; wet++; if(H.blockedAt(W, x, z)) blocked++; if(!S.land(x, z)) sea++;
  }
});
out.wet = [wet, blocked, sea];
out.piers = Wv ? Wv.piers.filter(function(p){ var x = p.x + p.fx*p.len/4, z = p.z + p.fz*p.len/4; return H.deckAt(W, x, z) === p.y && !H.blockedAt(W, x, z) && S.land(x, z); }).length + "/" + Wv.piers.length : "0/0";
// holes: open in every tile that reaches one (lod 0 and 2), in the roads and the ground
var bad = 0, tilesHoled = 0;
for(var tz = 0; tz < 8; tz++) for(var tx = 0; tx < 8; tx++){
  var x0 = -1024 + tx*256, z0 = -1024 + tz*256;
  if(!holes.some(function(P){ return P.some(function(q){ return q[0] > x0 - 40 && q[0] < x0 + 296 && q[1] > z0 - 40 && q[1] < z0 + 296; }); })) continue;
  tilesHoled++;
  [0, 2].forEach(function(l){
    var lods = []; for(var k = 0; k < 16; k++) lods.push(l);
    tris(G.terrainTile(W, tx, tz, lods), function(x, z, A){ if(A > 1e-9 && inHole(x, z)) bad++; });
  });
  var R = G.roadTile(W, tx, tz);
  [R.asphalt, R.walk, R.marks].forEach(function(g){ tris(g, function(x, z){ if(inHole(x, z)) bad++; }); });
  tris(G.groundTile(W, tx, tz), function(x, z){ if(inHole(x, z)) bad++; });
}
out.holes = [holes.length, tilesHoled, bad];
var wg = G.waterGeo(W);
out.waterTris = [wg.surface.idx.length/3, wg.works.idx.length/3, wg.foam.idx.length/3];
// tram streets carry no yellow
var te = G.tramEdges(W), yellowOnTram = 0;
out.tramEdges = Object.keys(te).length;
out.tramMatch = JSON.stringify(Object.keys(te).map(Number).sort(function(a, b){ return a - b; })) ===
                JSON.stringify(T.lanes(W, 5).filter(function(o){ return o.tram; }).map(function(o){ return o.id; }).sort(function(a, b){ return a - b; }));
done(out);
"""


@unittest.skipUnless(NODE, "node is not installed")
class RealV3(unittest.TestCase):
    def check(self, path):
        if not os.path.exists(path):
            self.skipTest(os.path.basename(path) + " is missing (part worldgen writes it: python3 tools/world_fixture.py)")
        o = run(REAL_BODY, path)
        self.assertEqual(o["v"], 3, o["id"])
        self.assertTrue(o["has"][0], "no water layer")
        self.assertGreaterEqual(o["bodies"], 1)
        self.assertEqual(o["wet"][0], o["bodies"])
        self.assertEqual(o["wet"][1], o["wet"][0])
        self.assertEqual(o["wet"][2], o["wet"][0])
        a, b = o["piers"].split("/")
        self.assertEqual(a, b)
        self.assertEqual(o["holes"][2], 0, o["holes"])
        self.assertLess(sum(o["waterTris"]), 40000, o["waterTris"])
        self.assertTrue(o["tramMatch"])
        return o

    def test_commons_v3(self):
        self.check(REAL[0])

    def test_island_v3(self):
        self.check(REAL[1])


class SourceV3(unittest.TestCase):
    def test_house_rules(self):
        for f in ("world.js", "worldgeom.js", "worldbuild.js", "ocean.js", "hqminimap.js"):
            with open(os.path.join(ROOT, "games", f), encoding="utf-8") as fh:
                src = fh.read()
            self.assertNotRegex(src, r"Math\.random\(", f)
            self.assertNotRegex(src, r"\b(let|const)\s", f)
            self.assertNotIn("innerHTML", src, f)

    def test_worldbuild_water_draws(self):
        with open(os.path.join(ROOT, "games", "worldbuild.js"), encoding="utf-8") as fh:
            src = fh.read()
        # at most 3 world-wide calls for the water, counted in stats(), in the river's calm material
        self.assertIn("@3 water adds at most 3 world-wide (surface, works, foam)", src)
        self.assertIn("[lakes, works, foam].forEach(function(me){", src)
        self.assertIn('sg.setAttribute("aLake"', src)
        self.assertIn("me.material = om || M.water", src)
        with open(os.path.join(ROOT, "games", "ocean.js"), encoding="utf-8") as fh:
            oc = fh.read()
        self.assertIn("mix(1.0, 0.35, vLake)", oc)

    def test_fixture_is_cm_integers(self):
        with open(TINY, encoding="utf-8") as f:
            doc = json.load(f)
        self.assertEqual(doc["version"], 3)

        def walk(v, path):
            if isinstance(v, float):
                self.fail("a float at " + path)
            if isinstance(v, dict):
                for k, x in v.items():
                    walk(x, path + "." + k)
            elif isinstance(v, list):
                for i, x in enumerate(v):
                    walk(x, path + "[%d]" % i)
        for k in ("water", "metro", "rail", "gondola"):
            walk(doc["layers"][k], k)


if __name__ == "__main__":
    unittest.main()
