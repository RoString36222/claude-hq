"""3D City world data (games/world.js, HQV.world): the client's view of the WorldDoc.

Runs world.js under node (when it is installed) with only a `window` stub, against the
hand-made tests/fixtures/world_tiny.json and the real generated fixture
tests/fixtures/claude-hq@1.json.gz (gunzipped in node with zlib). Heights, districts,
lots and sites are checked against the Rust samples (tests/fixtures/claude-hq@1.samples.json,
skipped until the generator writes it) and, meanwhile, against a Python port of
terrain.rs Terrain::height_at. The flood fill checks that the whole city is walkable
from the plaza spawn. load() runs with stub fetch and IndexedDB. Stdlib only."""
import gzip
import json
import os
import random
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORLD_JS = os.path.join(ROOT, "games", "world.js")
TINY = os.path.join(ROOT, "tests", "fixtures", "world_tiny.json")
REAL = os.path.join(ROOT, "tests", "fixtures", "claude-hq@1.json.gz")
SAMPLES = os.path.join(ROOT, "tests", "fixtures", "claude-hq@1.samples.json")
NODE = shutil.which("node")

PRELUDE = r"""
var fs = require("fs"), zlib = require("zlib"), root = %(root)s;
var LOGS = [];
console.log = function(m){ LOGS.push(String(m)); };
function fresh(){
  global.window = {HQV: {}};
  new Function(fs.readFileSync(root + "/games/world.js", "utf8"))();
  return window.HQV.world;
}
var H = fresh();
function tiny(){ return JSON.parse(fs.readFileSync(root + "/tests/fixtures/world_tiny.json", "utf8")); }
function real(){ return JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/claude-hq@1.json.gz"))); }
function done(out){ process.stdout.write(JSON.stringify(out)); }
"""


def run_node(body, stdin=None):
    src = PRELUDE % {"root": json.dumps(ROOT)} + body
    p = subprocess.run([NODE, "-e", src], input=json.dumps(stdin) if stdin is not None else "",
                       capture_output=True, text=True, timeout=600)
    if p.returncode != 0:
        raise AssertionError("node failed:\n" + p.stderr[-4000:])
    return json.loads(p.stdout)


def tdiv(a, b):
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b > 0) else -q


def height_cm(t, x, z):
    """terrain.rs Terrain::height_at, integer for integer."""
    one, c, n, o, h = 65536, t["cell_cm"], t["n"], t["origin_cm"], t["heights"]
    mx = (n - 1) * c
    lx, lz = min(max(x - o, 0), mx), min(max(z - o, 0), mx)
    ix, iz = lx // c, lz // c
    ix1, iz1 = min(ix + 1, n - 1), min(iz + 1, n - 1)
    fx, fz = lx % c * one // c, lz % c * one // c
    a = h[iz * n + ix] + tdiv((h[iz * n + ix1] - h[iz * n + ix]) * fx, one)
    b = h[iz1 * n + ix] + tdiv((h[iz1 * n + ix1] - h[iz1 * n + ix]) * fx, one)
    return a + tdiv((b - a) * fz, one)


def fnv1a(data):
    h = 0x811C9DC5
    for b in data:
        h = ((h ^ b) * 0x01000193) & 0xFFFFFFFF
    return h


def rect_id(items, x, z):
    for o in items:
        if abs(x - o["x"]) * 2 <= o["w"] and abs(z - o["z"]) * 2 <= o["d"]:
            return o["id"]
    return None


@unittest.skipUnless(NODE, "node is not installed")
class TinyWorld(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(TINY, encoding="utf-8") as f:
            cls.doc = json.load(f)
        cls.out = run_node(r"""
var doc = tiny(), W = H.pack(doc), out = {};
out.shape = {id: W.id, hash: W.hash, sizeCm: W.sizeCm, half: W.half, tn: W.terrain.n, hlen: W.terrain.h.length,
  hInt: W.terrain.h instanceof Int32Array, kU8: W.districts.k instanceof Uint8Array, legend: W.districts.legend.length,
  edges: W.edges.map(function(e){ return [e.id, e.cls, e.width, e.walk, e.lanes, e.ref, e.pts instanceof Int32Array, e.pts.length]; }),
  nodes: W.nodes.length, lots: W.lots.length, sites: W.sites.length};
// a structured clone round trip keeps every query working (IndexedDB stores W this way)
var W2 = require("v8").deserialize(require("v8").serialize(W));
out.cloneH = H.heightCm(W2, 123, -456) === H.heightCm(W, 123, -456);
var pts = JSON.parse(fs.readFileSync(0, "utf8"));
out.heights = pts.map(function(p){ return H.heightCm(W, p[0], p[1]); });
out.heightAt = H.heightAt(W, 1.234, -5.678);
out.heightAtCm = H.heightCm(W, 123, -568);
out.district = [H.districtAt(W, -50, 0), H.districtAt(W, 0, 0), H.districtAt(W, 60, 10), H.districtAt(W, 500, 500), H.districtAt(W, -500, -500)];
out.lot = [H.lotAt(W, -30, -30), H.lotAt(W, 30, -30), H.lotAt(W, -40, -22), H.lotAt(W, -40.01, -22), H.lotAt(W, 0, 30)].map(function(l){ return l ? l.id : null; });
out.site = [H.siteAt(W, -30, 30), H.siteAt(W, 30, 30), H.siteAt(W, 31, 31), H.siteAt(W, 31.01, 31), H.siteAt(W, -30, -30)].map(function(s){ return s ? s.id : null; });
out.surface = [[0, 2], [20, 3], [20, 3.9], [-2, -20], [-5, -20], [1, 40], [4.9, 40], [-30, -30], [30, -30], [-30, 30],
               [-55, -30], [55, 30], [20, 50], [64.5, 0], [-10, 70]].map(function(p){ return [p, H.surfaceAt(W, p[0], p[1])]; });
var nr = H.nearestRoad(W, 20, 3);
out.near = {edge: nr.edge, seg: nr.seg, dist: nr.dist, x: nr.x, z: nr.z, yaw: nr.yaw, cls: nr.cls, name: nr.name, half: nr.half, carriage: nr.carriage,
            yAt: nr.y, h20: H.heightCm(W, 2000, 0)};
out.nearAve = (function(){ var r = H.nearestRoad(W, 3, -20); return {edge: r.edge, half: r.half, carriage: r.carriage, yaw: r.yaw}; })();
out.nearFar = H.nearestRoad(W, -40, -40, 10);
out.nearMax = H.nearestRoad(W, -40, -40, 40) !== null;
out.roadY = {road: H.roadY(W, 20, 1), walk: H.roadY(W, 20, 3.5), centre: H.nearestRoad(W, 20, 3.5).y, off: H.roadY(W, -30, -30)};
out.ground = {road: H.groundAt(W, 20, 1), walk: H.groundAt(W, 20, 3.5),
  pad: H.groundAt(W, -30, -30), padY: H.lotAt(W, -30, -30).door[1]/100,
  site: H.groundAt(W, -30, 30), siteY: 0, terrain: H.groundAt(W, -50, 40), terrainH: H.heightAt(W, -50, 40)};
out.ground.siteY = W.sites[0].y/100;
// the 4 m blend west of the fountain site (x0 = -34.5): pad y at the edge, terrain from 4 m out, smooth between
out.blend = [];
for(var i = 0; i <= 120; i++){ var x = -34.5 - i*0.05; out.blend.push([x, H.groundAt(W, x, 30), H.heightAt(W, x, 30)]); }
out.pad = [H.padOf(W, -30, -30), H.padOf(W, -30, 30), H.padOf(W, 30, -30), H.padOf(W, 0, 0)];
out.bRect = H.buildingRect(W.lots[1]);
out.blocked = {bld: H.blockedAt(W, 30, -30), bldEdge: H.blockedAt(W, 21.5, -30), lotRing: H.blockedAt(W, 20.5, -30),
  hq: H.blockedAt(W, -30, -30), door: H.blockedAt(W, -30, -22), road: H.blockedAt(W, 0, 0),
  rim: H.blockedAt(W, 62.5, 0), inRim: H.blockedAt(W, 61.5, 0), out: H.blockedAt(W, 0, -100)};
var T1 = H.trees(W), T2 = H.trees(H.pack(tiny()));
out.trees = {n: T1.length, same: JSON.stringify(T1) === JSON.stringify(T2), cached: H.trees(W) === T1,
  kinds: T1.map(function(t){ return t.kind; }).filter(function(k, i, a){ return a.indexOf(k) === i; }).sort(),
  bad: T1.filter(function(t){ var r = H.nearestRoad(W, t.x, t.z, 50); return (r && r.dist <= r.half + 2) || H.lotAt(W, t.x, t.z) || H.siteAt(W, t.x, t.z); }).length,
  blocked: T1.every(function(t){ return H.blockedAt(W, t.x + 0.3, t.z); }),
  free: T1.filter(function(t){ return H.blockedAt(W, t.x + 0.5, t.z) && !H.trees(W).some(function(u){ return u !== t && Math.hypot(u.x - t.x - 0.5, u.z - t.z) < 0.45; }); }).length,
  sRange: T1.every(function(t){ return t.s >= 0.8 && t.s <= 1.4; }),
  dist: T1.reduce(function(m, t){ var k = H.districtAt(W, t.x, t.z).name; m[k] = (m[k] || 0) + 1; return m; }, {})};
var n = H.normalAt(W, -30, -30);
out.normalFlat = [n.x, n.y, n.z];
var n2 = H.normalAt(W, -50, 40);
out.normalSlope = [n2.x, n2.y, n2.z];
out.slope = {flat: H.slopeAlong(W, -30, -30, 0), east: H.slopeAlong(W, -50, 40, Math.PI/2), west: H.slopeAlong(W, -50, 40, -Math.PI/2)};
var grades = []; for(var g = -1; g <= 1.0001; g += 0.05) grades.push(+g.toFixed(2));
out.sf = {};
["foot", "bike", "skate", "car", "moto"].forEach(function(k){ out.sf[k] = grades.map(function(g){ return H.slopeFactor(g, k); }); });
out.sfFlat = ["foot", "bike", "skate", "car", "moto"].map(function(k){ return H.slopeFactor(0, k); });
out.ray = {clear: H.rayGround(W, {x: -30, y: 20, z: -30}, {x: 30, y: 20, z: 30}),
  hit: H.rayGround(W, {x: -50, y: 20, z: 40}, {x: -50, y: -20, z: 40}, 1),
  under: H.rayGround(W, {x: -50, y: -10, z: 40}, {x: -40, y: -10, z: 40})};
// rayGround bisects inside the step: the hit matches a 0.0005 scan however coarse the step
function rayExact(a, b){
  for(var t = 0; t <= 1; t += 0.0005) if(a.y + (b.y - a.y)*t < H.groundAt(W, a.x + (b.x - a.x)*t, a.z + (b.z - a.z)*t) + 0.25) return t;
  return 1;
}
out.rayFine = [[{x: -50, y: 20, z: 40}, {x: -50, y: -20, z: 40}, 8], [{x: -50, y: 20, z: 40}, {x: -40, y: -20, z: 40}, 2],
               [{x: -70, y: 3, z: 40}, {x: -30, y: -2, z: 40}, 2]].map(function(r){
  return [H.rayGround(W, r[0], r[1], r[2]), rayExact(r[0], r[1]), 1/Math.ceil(Math.hypot(r[1].x - r[0].x, r[1].y - r[0].y, r[1].z - r[0].z)/r[2])];
});
// the kerb: across Elm Street (carriage half 2.5 m, half 4 m) the sidewalk is a 0.15 m step, flat like the drawn ribbon
out.kerb = [];
for(var kz = 2.0; kz <= 4.0001; kz += 0.01) out.kerb.push([+kz.toFixed(2), H.roadY(W, 20, kz), H.surfaceAt(W, 20, kz)]);
out.kerbCentre = H.nearestRoad(W, 20, 2).y;
out.labels = H.roadLabels(W).map(function(l){ return {name: l.name, cls: l.cls, ref: l.ref, n: l.pts.length, first: l.pts[0], last: l.pts[l.pts.length - 1], len: l.len}; });
out.junctions = H.junctions(W);
out.hash = [H.hash32(""), H.hash32("a"), H.hash32("foobar"), H.hash32("é")];
out.consts = {ID: H.ID, URL: H.URL, IDB: H.IDB};
done(out);
""", stdin=[[0, 0], [123, -456], [-6400, -6400], [6400, 6400], [9999, -9999], [-3000, -2200], [37, 777], [-5555, 4321]])

    def test_pack_shape(self):
        s = self.out["shape"]
        self.assertEqual(s["id"], "tiny@1")
        self.assertEqual(s["hash"], "0123456789abcdef")
        self.assertEqual(s["sizeCm"], 12800)
        self.assertEqual(s["half"], 64)
        self.assertEqual(s["tn"], 17)
        self.assertEqual(s["hlen"], 17 * 17)
        self.assertTrue(s["hInt"] and s["kU8"])
        self.assertEqual(s["legend"], 11)
        self.assertEqual((s["nodes"], s["lots"], s["sites"]), (5, 2, 2))
        for (eid, cls, width, walk, lanes, ref, typed, n), e in zip(s["edges"], self.doc["layers"]["roads"]["edges"]):
            self.assertEqual((eid, cls, width, walk, lanes, ref), (e["id"], e["class"], e["width"], e["walk"], e["lanes"], e["ref"]))
            self.assertTrue(typed)
            self.assertEqual(n, 3 * len(e["points"]))
        self.assertTrue(self.out["cloneH"])

    def test_height_matches_rust_port(self):
        t = self.doc["layers"]["terrain"]
        want = [height_cm(t, x, z) for x, z in [[0, 0], [123, -456], [-6400, -6400], [6400, 6400], [9999, -9999],
                                                 [-3000, -2200], [37, 777], [-5555, 4321]]]
        self.assertEqual(self.out["heights"], want)
        self.assertEqual(self.out["heightAt"], self.out["heightAtCm"] / 100)

    def test_district_lot_site(self):
        self.assertEqual([d["name"] for d in self.out["district"]], ["forest", "residential", "park", "park", "forest"])
        self.assertEqual(self.out["district"][0]["k"], 2)
        self.assertEqual(self.out["lot"], [0, 1, 0, None, None])
        self.assertEqual(self.out["site"], ["fountain:0", "spawn:0", "spawn:0", None, None])

    def test_surface_classes(self):
        got = {tuple(p): s for p, s in self.out["surface"]}
        self.assertEqual(got[(0, 2)], "road")
        self.assertEqual(got[(20, 3)], "sidewalk")      # street: carriage half 2.5 m, half 4 m
        self.assertEqual(got[(20, 3.9)], "sidewalk")
        self.assertEqual(got[(-2, -20)], "road")         # avenue: carriage half 4 m
        self.assertEqual(got[(-5, -20)], "sidewalk")
        self.assertEqual(got[(1, 40)], "road")           # highway: no sidewalk
        self.assertEqual(got[(4.9, 40)], "road")
        self.assertEqual(got[(-30, -30)], "lot")
        self.assertEqual(got[(30, -30)], "lot")
        self.assertEqual(got[(-30, 30)], "site")
        self.assertEqual(got[(-55, -30)], "forest")
        self.assertEqual(got[(55, 30)], "park")
        self.assertEqual(got[(20, 50)], "grass")
        self.assertEqual(got[(64.5, 0)], "edge")
        self.assertEqual(got[(-10, 70)], "edge")

    def test_nearest_road(self):
        n = self.out["near"]
        self.assertEqual((n["edge"], n["cls"], n["name"]), (1, "street", "Elm Street"))
        self.assertAlmostEqual(n["dist"], 3)
        self.assertAlmostEqual(n["x"], 20)
        self.assertAlmostEqual(n["z"], 0)
        self.assertAlmostEqual(n["yaw"], 1.5707963, places=5)    # edge 1 runs toward +x
        self.assertEqual((n["half"], n["carriage"]), (4, 2.5))
        self.assertAlmostEqual(n["yAt"], n["h20"] / 100, delta=0.02)   # y interpolated along the polyline
        a = self.out["nearAve"]
        self.assertEqual((a["edge"], a["half"], a["carriage"]), (2, 6, 4))
        self.assertAlmostEqual(a["yaw"], 0, places=6)               # node 3 (z -60) -> node 1 runs toward +z
        self.assertIsNone(self.out["nearFar"])
        self.assertTrue(self.out["nearMax"])

    def test_road_y_and_ground(self):
        r, g = self.out["roadY"], self.out["ground"]
        self.assertAlmostEqual(r["walk"], r["centre"] + 0.15)
        self.assertIsNone(r["off"])
        self.assertEqual(g["road"], r["road"])
        self.assertEqual(g["walk"], r["walk"])
        self.assertEqual(g["pad"], g["padY"])
        self.assertEqual(g["site"], g["siteY"])
        self.assertEqual(g["terrain"], g["terrainH"])

    def test_pad_blend_continuous(self):
        b = self.out["blend"]
        self.assertAlmostEqual(b[0][1], self.out["ground"]["siteY"])
        for x, gy, hy in b:
            if x <= -34.5 - 4:
                self.assertAlmostEqual(gy, hy, msg="beyond the blend at x=%s" % x)
        for (x0, g0, _), (x1, g1, _) in zip(b, b[1:]):
            self.assertLess(abs(g1 - g0), 0.05, "jump at x=%s" % x1)

    def test_pad_of(self):
        p = self.out["pad"]
        self.assertEqual(p[0]["rect"], {"x0": -40, "x1": -20, "z0": -38, "z1": -22})
        self.assertEqual(p[0]["y"], self.out["ground"]["padY"])
        self.assertEqual(p[1]["y"], self.out["ground"]["siteY"])
        self.assertIsNone(p[2])    # building lots are not pads
        self.assertIsNone(p[3])

    def test_blocked(self):
        self.assertEqual(self.out["bRect"], {"x0": 21, "x1": 39, "z0": -37, "z1": -23})
        b = self.out["blocked"]
        self.assertTrue(b["bld"] and b["bldEdge"])
        self.assertFalse(b["lotRing"])    # the 1 m ring around a footprint is walkable
        self.assertFalse(b["hq"] or b["door"] or b["road"] or b["inRim"])
        self.assertTrue(b["rim"] and b["out"])

    def test_trees(self):
        t = self.out["trees"]
        self.assertGreater(t["n"], 10)
        self.assertTrue(t["same"] and t["cached"])
        self.assertEqual(t["bad"], 0)
        self.assertTrue(t["blocked"])
        self.assertEqual(t["free"], 0)
        self.assertTrue(t["sRange"])
        self.assertLessEqual(set(t["kinds"]), {"pine", "round"})
        self.assertLessEqual(set(t["dist"]), {"forest", "park", "residential"})
        self.assertGreater(t["dist"].get("forest", 0), t["dist"].get("residential", 0))

    def test_normal_and_slope(self):
        nx, ny, nz = self.out["normalFlat"]
        self.assertEqual((nx, nz), (0, 0))
        self.assertAlmostEqual(ny, 1)
        nx, ny, nz = self.out["normalSlope"]
        self.assertLess(nx, 0)       # ground rises toward +x, so the normal leans to -x
        self.assertAlmostEqual(nx * nx + ny * ny + nz * nz, 1)
        s = self.out["slope"]
        self.assertEqual(s["flat"], 0)
        self.assertGreater(s["east"], 0)
        self.assertAlmostEqual(s["west"], -s["east"])

    def test_slope_factor_monotone(self):
        for kind, vals in self.out["sf"].items():
            for a, b in zip(vals, vals[1:]):
                self.assertGreaterEqual(a, b, kind)
        self.assertEqual(self.out["sfFlat"], [1, 1, 1, 1, 1])
        self.assertEqual(self.out["sf"]["foot"][-1], 0.45)
        self.assertEqual(self.out["sf"]["bike"][0], 1.3)
        self.assertEqual(self.out["sf"]["car"][0], 1)
        self.assertEqual(self.out["sf"]["car"][-1], 0.7)

    def test_ray_ground(self):
        r = self.out["ray"]
        self.assertEqual(r["clear"], 1)
        self.assertGreater(r["hit"], 0.4)
        self.assertLess(r["hit"], 0.6)
        self.assertEqual(r["under"], 0)

    def test_ray_ground_bisects(self):
        for got, exact, interval in self.out["rayFine"]:
            self.assertLess(exact, 1)
            self.assertAlmostEqual(got, exact, delta=max(interval / 64, 0.0005) + 0.0005)
            self.assertLess(interval / 64, 0.01)    # the old result was only good to one whole step

    def test_kerb_step(self):
        # physics matches the drawn walk ribbon: flat road, a vertical 0.15 m kerb, flat sidewalk
        k, c = self.out["kerb"], self.out["kerbCentre"]
        for z, y, srf in k:
            if z <= 2.5:
                self.assertEqual(srf, "road")
                self.assertAlmostEqual(y, c, places=9)
            else:
                self.assertEqual(srf, "sidewalk")
                self.assertAlmostEqual(y, c + 0.15, places=9)

    def test_labels_and_junctions(self):
        labels = {l["name"]: l for l in self.out["labels"]}
        self.assertEqual(set(labels), {"Elm Street", "Oak Avenue", "Route One"})
        self.assertEqual(len(self.out["labels"]), 3)    # the two Elm Street edges merge
        elm = labels["Elm Street"]
        self.assertEqual(sorted([elm["first"][0], elm["last"][0]]), [-60, 60])
        self.assertAlmostEqual(elm["len"], 120)
        self.assertEqual(elm["n"], 2 * 8 + 1)              # 8 points per 60 m edge + the shared node once
        self.assertEqual((labels["Route One"]["ref"], labels["Route One"]["cls"]), ("H1", "highway"))
        self.assertIsNone(labels["Elm Street"]["ref"])
        j = self.out["junctions"]
        self.assertEqual(len(j), 1)
        self.assertEqual((j[0]["node"], j[0]["deg"], sorted(j[0]["edges"])), (1, 4, [0, 1, 2, 3]))
        self.assertEqual(sorted(j[0]["names"]), ["Elm Street", "Oak Avenue", "Route One"])
        self.assertEqual((j[0]["x"], j[0]["z"]), (0, 0))

    def test_hash32_is_fnv1a(self):
        self.assertEqual(self.out["hash"][:3], [0x811C9DC5, 0xE40C292C, 0xBF9CF968])
        self.assertEqual(self.out["hash"][3], fnv1a("\u00e9".encode("utf-8")))   # over UTF-8 bytes

    def test_constants(self):
        self.assertEqual(self.out["consts"], {"ID": "claude-hq@1", "URL": "/api/arena/world/claude-hq@1",
                                              "IDB": {"db": "hq-world", "store": "docs"}})


@unittest.skipUnless(NODE, "node is not installed")
class OldDoc(unittest.TestCase):
    def test_country_doc_packs(self):
        out = run_node(r"""
var doc = tiny();
doc.layers.roads.edges.forEach(function(e){ delete e.walk; delete e.lanes; delete e.ref; });
doc.layers.roads.edges[3].class = "country"; doc.layers.roads.edges[3].width = 700;
var W = H.pack(doc);
done({edges: W.edges.map(function(e){ return [e.cls, e.walk, e.lanes, e.ref]; }),
      surf: [H.surfaceAt(W, 3, 40), H.surfaceAt(W, 3, 2.9), H.surfaceAt(W, 20, 3)],
      labels: H.roadLabels(W).length});
""")
        self.assertEqual(out["edges"], [["street", 150, 1, None], ["street", 150, 1, None],
                                        ["avenue", 200, 1, None], ["highway", 0, 1, None]])
        self.assertEqual(out["surf"], ["road", "road", "sidewalk"])
        self.assertEqual(out["labels"], 3)


@unittest.skipUnless(NODE, "node is not installed")
class Load(unittest.TestCase):
    """load() with stub fetch and IndexedDB: cache first, 304 keeps it without packing."""

    @classmethod
    def setUpClass(cls):
        cls.out = run_node(r"""
function wait(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
function stubIdb(rec, opts){
  opts = opts || {};
  var s = {puts: [], gets: 0};
  s.get = function(k){ s.gets++; s.key = k; if(opts.throws) throw new Error("private mode"); return Promise.resolve(rec); };
  s.put = function(k, v){ s.puts.push({k: k, etag: v.etag, hash: v.packed.hash}); s.lastV = v.v; return Promise.resolve(); };
  return s;
}
function stubFetch(status, doc, etag, opts){
  var s = {calls: []};
  s.fn = function(url, o){
    s.calls.push({url: url, o: o});
    if(opts && opts.network) return Promise.reject(new TypeError("Failed to fetch"));
    return Promise.resolve({status: status, headers: {get: function(n){ return n.toLowerCase() === "etag" ? etag : null; }},
                            json: function(){ return Promise.resolve(doc); }});
  };
  return s;
}
function counting(M){ var n = {pack: 0}, orig = M.pack; M.pack = function(d){ n.pack++; return orig(d); }; return n; }
function packedTiny(hash){ var d = tiny(); if(hash) d.hashes.world = hash; return H.pack(d); }
async function run(){
  var out = {packV: H.PACK_V};
  // 1. cached + 304: resolves with the cache at once, no pack, logs cache ms and 304
  var M = fresh(), cnt = counting(M), cached = packedTiny(), idb = stubIdb({v: H.PACK_V, etag: "\"e1\"", packed: cached}), f = stubFetch(304, null, "\"e1\"");
  LOGS = [];
  var W = await M.load({fetch: f.fn, idb: idb});
  await wait(20);
  out.c304 = {same: W === cached, cur: M.current() === cached, pack: cnt.pack, calls: f.calls.length, url: f.calls[0].url,
              opts: f.calls[0].o, puts: idb.puts.length, key: idb.key, cacheMs: M.cacheMs(), logs: LOGS.slice(), etag: W.etag,
              again: (await M.load({fetch: f.fn, idb: idb})) === cached, fetches: f.calls.length};
  // 2. cached + 200 with a new hash: cache first, then replace, store and fire onChange
  M = fresh(); cnt = counting(M); cached = packedTiny(); idb = stubIdb({v: H.PACK_V, etag: "\"e1\"", packed: cached});
  f = stubFetch(200, (function(){ var d = tiny(); d.hashes.world = "feedfacefeedface"; return d; })(), "\"e2\"");
  var fired = [];
  M.onChange(function(w){ fired.push(w.hash); });
  W = await M.load({fetch: f.fn, idb: idb});
  var first = W === cached;
  await wait(20);
  out.c200 = {first: first, fired: fired, pack: cnt.pack, cur: M.current().hash, etag: M.current().etag, puts: idb.puts,
              v: idb.lastV, again: (await M.load({fetch: f.fn, idb: idb})).hash, fetches: f.calls.length};
  // 2c. a record packed by other code (wrong v) is a miss: no If-None-Match, one pack, stored with PACK_V
  M = fresh(); cnt = counting(M); idb = stubIdb({v: H.PACK_V + 1, etag: "\"e1\"", packed: packedTiny()}); f = stubFetch(200, tiny(), "\"e7\"");
  W = await M.load({fetch: f.fn, idb: idb});
  out.cOldV = {headers: f.calls[0].o.headers, pack: cnt.pack, etag: W.etag, cacheMs: M.cacheMs(), v: idb.lastV};
  // 2b. cached + 200 with the same hash: replaced and stored, no onChange
  M = fresh(); cached = packedTiny(); idb = stubIdb({v: H.PACK_V, etag: "\"e1\"", packed: cached}); f = stubFetch(200, tiny(), "\"e3\"");
  fired = []; M.onChange(function(w){ fired.push(w.hash); });
  await M.load({fetch: f.fn, idb: idb}); await wait(20);
  out.c200same = {fired: fired.length, curEtag: M.current().etag, replaced: M.current() !== cached, puts: idb.puts.length};
  // 3. cached + server error / network error: keep the cache
  M = fresh(); cached = packedTiny(); idb = stubIdb({v: H.PACK_V, etag: "e1", packed: cached}); f = stubFetch(500, null, null);
  W = await M.load({fetch: f.fn, idb: idb}); await wait(20);
  out.cErr = {same: W === cached, cur: M.current() === cached, puts: idb.puts.length};
  M = fresh(); cached = packedTiny(); idb = stubIdb({v: H.PACK_V, etag: "e1", packed: cached}); f = stubFetch(0, null, null, {network: true});
  W = await M.load({fetch: f.fn, idb: idb}); await wait(20);
  out.cNet = {same: W === cached};
  // 4. nothing cached + 200: packs, stores with the ETag, no If-None-Match
  M = fresh(); cnt = counting(M); idb = stubIdb(undefined); f = stubFetch(200, tiny(), "\"e9\"");
  W = await M.load({fetch: f.fn, idb: idb});
  out.n200 = {hash: W.hash, etag: W.etag, pack: cnt.pack, headers: f.calls[0].o.headers, puts: idb.puts, cacheMs: M.cacheMs(), cur: M.current() === W};
  // 5. nothing cached + error: rejects with "world unavailable: <code>"
  async function rejects(M, opts){ try { await M.load(opts); return "resolved"; } catch(e){ return e.message; } }
  M = fresh(); out.nErr = await rejects(M, {fetch: stubFetch(401, null, null).fn, idb: stubIdb(undefined)});
  out.nErrCur = M.current();
  M = fresh(); out.nNet = await rejects(M, {fetch: stubFetch(0, null, null, {network: true}).fn, idb: stubIdb(undefined)});
  // a failed load can be retried
  out.retry = (await M.load({fetch: stubFetch(200, tiny(), "x").fn, idb: stubIdb(undefined)})).hash;
  M = fresh(); out.nTimeout = await rejects(M, {fetch: function(){ return new Promise(function(){}); }, idb: null, timeoutMs: 30});
  // a body that stalls after a 200 header also times out, and the request is aborted when AbortController exists
  M = fresh(); var aborted = 0;
  window.AbortController = function(){ var c = this; c.signal = {aborted: false}; c.abort = function(){ aborted++; c.signal.aborted = true; }; };
  var sig = null;
  out.jTimeout = await rejects(M, {idb: null, timeoutMs: 30, fetch: function(u, o){ sig = o.signal;
    return Promise.resolve({status: 200, headers: {get: function(){ return null; }}, json: function(){ return new Promise(function(){}); }}); }});
  out.jAbort = {aborted: aborted, signal: !!(sig && sig.aborted)};
  // 6. IndexedDB throws (private mode) or is absent: network only
  M = fresh(); idb = stubIdb(undefined, {throws: true}); f = stubFetch(200, tiny(), "\"e4\"");
  out.idbThrows = (await M.load({fetch: f.fn, idb: idb})).etag;
  M = fresh(); out.noIdb = (await M.load({fetch: stubFetch(200, tiny(), "\"e5\"").fn, idb: null})).etag;
  done(out);
}
run().catch(function(e){ console.error(e && e.stack || e); process.exit(1); });
""")

    def test_304_keeps_cache_without_pack(self):
        c = self.out["c304"]
        self.assertTrue(c["same"] and c["cur"])
        self.assertEqual(c["pack"], 0)
        self.assertEqual(c["calls"], 1)
        self.assertEqual(c["url"], "/api/arena/world/claude-hq@1")
        self.assertEqual(c["opts"], {"cache": "no-cache", "headers": {"If-None-Match": "\"e1\""}})
        self.assertEqual(c["key"], "claude-hq@1")
        self.assertEqual(c["puts"], 0)
        self.assertIsNotNone(c["cacheMs"])
        self.assertLess(c["cacheMs"], 100)
        self.assertIn("hq-world cache %d" % c["cacheMs"], c["logs"])
        self.assertIn("hq-world 304", c["logs"])
        self.assertEqual(c["etag"], "\"e1\"")
        self.assertTrue(c["again"])
        self.assertEqual(c["fetches"], 1)

    def test_200_replaces_and_fires(self):
        c = self.out["c200"]
        self.assertTrue(c["first"])
        self.assertEqual(c["fired"], ["feedfacefeedface"])
        self.assertEqual(c["pack"], 1)
        self.assertEqual((c["cur"], c["etag"]), ("feedfacefeedface", "\"e2\""))
        self.assertEqual(c["puts"], [{"k": "claude-hq@1", "etag": "\"e2\"", "hash": "feedfacefeedface"}])
        self.assertEqual(c["v"], self.out["packV"])
        # a later load() hands out the replacement, not the stale cache it first resolved with
        self.assertEqual((c["again"], c["fetches"]), ("feedfacefeedface", 1))
        s = self.out["c200same"]
        self.assertEqual((s["fired"], s["curEtag"], s["replaced"], s["puts"]), (0, "\"e3\"", True, 1))

    def test_old_pack_version_is_a_miss(self):
        o = self.out["cOldV"]
        self.assertEqual(o["headers"], {})
        self.assertEqual(o["pack"], 1)
        self.assertEqual(o["etag"], "\"e7\"")
        self.assertIsNone(o["cacheMs"])
        self.assertEqual(o["v"], self.out["packV"])

    def test_error_with_cache_resolves(self):
        self.assertEqual(self.out["cErr"], {"same": True, "cur": True, "puts": 0})
        self.assertEqual(self.out["cNet"], {"same": True})

    def test_network_only(self):
        n = self.out["n200"]
        self.assertEqual((n["hash"], n["etag"], n["pack"]), ("0123456789abcdef", "\"e9\"", 1))
        self.assertEqual(n["headers"], {})
        self.assertEqual(n["puts"], [{"k": "claude-hq@1", "etag": "\"e9\"", "hash": "0123456789abcdef"}])
        self.assertIsNone(n["cacheMs"])
        self.assertTrue(n["cur"])
        self.assertEqual(self.out["idbThrows"], "\"e4\"")
        self.assertEqual(self.out["noIdb"], "\"e5\"")

    def test_error_without_cache_rejects(self):
        self.assertEqual(self.out["nErr"], "world unavailable: 401")
        self.assertIsNone(self.out["nErrCur"])
        self.assertEqual(self.out["nNet"], "world unavailable: network")
        self.assertEqual(self.out["nTimeout"], "world unavailable: timeout")
        self.assertEqual(self.out["jTimeout"], "world unavailable: timeout")
        self.assertEqual(self.out["jAbort"], {"aborted": 1, "signal": True})
        self.assertEqual(self.out["retry"], "0123456789abcdef")


REAL_BODY = r"""
var doc = real(), W = H.pack(doc), half = W.half, out = {hash: W.hash, edges: W.edges.length, nLots: W.lots.length};
var input = JSON.parse(fs.readFileSync(0, "utf8"));
out.heights = input.pts.map(function(p){ return H.heightCm(W, p[0], p[1]); });
out.districts = input.pts.map(function(p){ return H.districtAt(W, p[0]/100, p[1]/100).k; });
out.lots = input.pts.map(function(p){ var l = H.lotAt(W, p[0]/100, p[1]/100); return l ? l.id : null; });
out.sites = input.pts.map(function(p){ var s = H.siteAt(W, p[0]/100, p[1]/100); return s ? s.id : null; });
var S = input.samples;
if(S){
  out.samples = S.map(function(s){
    var d = H.districtAt(W, s.x/100, s.z/100), l = H.lotAt(W, s.x/100, s.z/100), t = H.siteAt(W, s.x/100, s.z/100);
    return {height: H.heightCm(W, s.x, s.z), dk: d.k, dname: d.name, lot: l ? l.id : null, site: t ? t.id : null};
  });
}
// HQ lots: ground is the pad y inside; a building lot centre is blocked; every door is free
var hq = W.lots.filter(function(l){ return l.kind === "hq"; });
out.hqPad = hq.filter(function(l){ return H.groundAt(W, l.x/100, l.z/100) !== l.door[1]/100; }).map(function(l){ return l.id; });
out.doorBlocked = hq.filter(function(l){ return H.blockedAt(W, l.door[0]/100, l.door[2]/100); }).map(function(l){ return l.id; });
out.bldFree = W.lots.filter(function(l){ return l.kind === "building" && !H.blockedAt(W, l.x/100, l.z/100); }).map(function(l){ return l.id; });
// the 4 m blend out of every pad side (HQ lots and sites) is continuous where the 6 m run meets no road or other pad
out.blend = {checked: 0, worst: 0, ends: 0};
W.lots.filter(function(l){ return l.kind === "hq"; }).concat(W.sites).forEach(function(o){
  var R = H.padOf(W, o.x/100, o.z/100).rect, py = H.padOf(W, o.x/100, o.z/100).y, cx = o.x/100, cz = o.z/100;
  [[R.x1, cz, 1, 0], [R.x0, cz, -1, 0], [cx, R.z1, 0, 1], [cx, R.z0, 0, -1]].forEach(function(sd){
    var ok = true, i, prev = null;
    for(i = 1; i <= 120; i++){ var x = sd[0] + sd[2]*i*0.05, z = sd[1] + sd[3]*i*0.05; if(H.roadY(W, x, z) !== null || H.padOf(W, x, z)){ ok = false; break; } }
    if(!ok) return;
    out.blend.checked++;
    if(H.groundAt(W, sd[0], sd[1]) !== py || H.groundAt(W, sd[0] + sd[2]*4.05, sd[1] + sd[3]*4.05) !== H.heightAt(W, sd[0] + sd[2]*4.05, sd[1] + sd[3]*4.05)) out.blend.ends++;
    for(i = 0; i <= 120; i++){
      var g = H.groundAt(W, sd[0] + sd[2]*i*0.05, sd[1] + sd[3]*i*0.05);
      if(prev !== null) out.blend.worst = Math.max(out.blend.worst, Math.abs(g - prev));
      prev = g;
    }
  });
});
// road and sidewalk points across every edge: groundAt == roadY; along every polyline: steps <= 0.6 m per 1 m
out.roadMismatch = 0; out.roadChecked = 0; out.walkChecked = 0; out.worstStep = 0; out.worstAt = null;
W.edges.forEach(function(e){
  var p = e.pts, m = p.length/3, car = (e.width - 2*e.walk)/200, half = e.width/200, prev = null;
  for(var s = 0; s + 1 < m; s++){
    var ax = p[3*s]/100, az = p[3*s+2]/100, bx = p[3*s+3]/100, bz = p[3*s+5]/100, L = Math.hypot(bx - ax, bz - az);
    if(!(L > 0)) continue;
    var ux = (bx - ax)/L, uz = (bz - az)/L, steps = Math.max(1, Math.round(L));
    for(var k = 0; k < steps; k++){
      var f = k*L/steps, x = ax + ux*f, z = az + uz*f, g = H.groundAt(W, x, z);
      if(prev !== null && Math.abs(g - prev) > out.worstStep){ out.worstStep = Math.abs(g - prev); out.worstAt = [e.id, s, x, z]; }
      prev = g;
      if(k === Math.floor(steps/2)){
        [car*0.5, -car*0.5, (car + half)/2, -(car + half)/2].forEach(function(o, oi){
          if(oi >= 2 && !(half > car)) return;
          var qx = x - uz*o, qz = z + ux*o, srf = H.surfaceAt(W, qx, qz), ry = H.roadY(W, qx, qz);
          if(srf !== "road" && srf !== "sidewalk") return;
          if(srf === "road") out.roadChecked++; else out.walkChecked++;
          if(ry === null || H.groundAt(W, qx, qz) !== ry) out.roadMismatch++;
        });
      }
    }
  }
});
// blockedAt goes through the bucket index: 10k calls well under 200 ms (index and trees warmed first)
H.blockedAt(W, 0, 0);
var t0 = Date.now(), nb = 0;
for(var i = 0; i < 10000; i++){ if(H.blockedAt(W, ((i*7919) % 2040) - 1020 + 0.37, ((i*104729) % 2040) - 1020 + 0.61)) nb++; }
out.perfMs = Date.now() - t0;
var T1 = H.trees(W), T2 = H.trees(H.pack(real()));
out.trees = {n: T1.length, same: JSON.stringify(T1) === JSON.stringify(T2),
  onRoad: T1.filter(function(t){ var r = H.nearestRoad(W, t.x, t.z, 20); return (r && r.dist <= r.half + 2) || H.surfaceAt(W, t.x, t.z) === "road" || H.surfaceAt(W, t.x, t.z) === "sidewalk"; }).length};
// walkability: a 1 m blockedAt grid, flood from the plaza spawn
var N = Math.round(2*half), B = new Uint8Array(N*N);
for(var gz = 0; gz < N; gz++) for(var gx = 0; gx < N; gx++) B[gz*N + gx] = H.blockedAt(W, -half + gx + 0.5, -half + gz + 0.5) ? 1 : 0;
function cell(x, z){ return Math.floor(z + half)*N + Math.floor(x + half); }
var spawn = W.sites.filter(function(s){ return s.kind === "spawn"; })[0];
var start = cell(spawn.x/100, spawn.z/100), seen = new Uint8Array(N*N), q = new Int32Array(N*N), qh = 0, qt = 0;
out.startBlocked = !!B[start];
if(!B[start]){ seen[start] = 1; q[qt++] = start; }
while(qh < qt){
  var c = q[qh++], cx = c % N, cz = (c - cx)/N;
  if(cx > 0 && !seen[c-1] && !B[c-1]){ seen[c-1] = 1; q[qt++] = c-1; }
  if(cx < N-1 && !seen[c+1] && !B[c+1]){ seen[c+1] = 1; q[qt++] = c+1; }
  if(cz > 0 && !seen[c-N] && !B[c-N]){ seen[c-N] = 1; q[qt++] = c-N; }
  if(cz < N-1 && !seen[c+N] && !B[c+N]){ seen[c+N] = 1; q[qt++] = c+N; }
}
out.reached = qt; out.free = B.reduce(function(a, v){ return a + (v ? 0 : 1); }, 0);
function fs1(o){ return o.facing === "south" ? -1 : 1; }
out.doorsUnreached = W.lots.filter(function(l){ return l.kind === "hq" && !seen[cell(l.door[0]/100, l.door[2]/100 + 1.5*fs1(l))]; }).map(function(l){ return l.id; });
out.sitesUnreached = W.sites.filter(function(s){ return !seen[cell(s.x/100, (s.z + fs1(s)*s.d/2)/100 + 1.5*fs1(s))]; }).map(function(s){ return s.id; });
function nearReached(x, z){
  for(var dz = -20; dz <= 20; dz++) for(var dx = -20; dx <= 20; dx++){
    var px = x + dx, pz = z + dz;
    if(dx*dx + dz*dz > 400 || Math.abs(px) >= half || Math.abs(pz) >= half) continue;
    if(seen[cell(px, pz)]) return true;
  }
  return false;
}
out.edgesReached = [[0, -half], [0, half], [-half, 0], [half, 0]].map(function(p){ return nearReached(p[0], p[1]); });
// road cross-sections: on a 1 m grid, ground may not jump > 0.6 m between neighbouring road/sidewalk points
out.xsec = {checked: 0, bad: 0, worst: 0, at: null};
for(var rz = -half; rz < half - 1; rz += 1) for(var rx = -half; rx < half - 1; rx += 1){
  var x0 = rx + 0.25, z0 = rz + 0.25;
  if(H.roadY(W, x0, z0) === null) continue;
  var g0 = H.groundAt(W, x0, z0);
  [[1, 0], [0, 1]].forEach(function(d){
    var x1 = x0 + d[0], z1 = z0 + d[1];
    if(H.roadY(W, x1, z1) === null) return;
    var dg = Math.abs(H.groundAt(W, x1, z1) - g0);
    out.xsec.checked++;
    if(dg > 0.6){ out.xsec.bad++; if(dg > out.xsec.worst){ out.xsec.worst = dg; var r = H.nearestRoad(W, x0, z0, 20); out.xsec.at = [r && r.edge, x0, z0]; } }
  });
}
// HQ pads: groundAt == pad y at every 1 m cell of the pad rect that is not under a road; count doors under a road
out.hqPadCells = {checked: 0, bad: 0, underRoad: 0};
out.doorsOnRoad = [];
hq.forEach(function(l){
  var P = H.padOf(W, l.x/100, l.z/100), R = P.rect;
  for(var pz = Math.ceil(R.z0) + 0.5; pz < R.z1; pz += 1) for(var px = Math.ceil(R.x0) + 0.5; px < R.x1; px += 1){
    if(H.roadY(W, px, pz) !== null){ out.hqPadCells.underRoad++; continue; }
    out.hqPadCells.checked++;
    if(H.groundAt(W, px, pz) !== P.y) out.hqPadCells.bad++;
  }
  // a door on the outer sidewalk line (dist == half) is the lot edge meeting the kerb; inside it is a lot/road overlap
  var r = H.nearestRoad(W, l.door[0]/100, l.door[2]/100, 30);
  if(r && r.dist < r.half - 1e-6) out.doorsOnRoad.push(l.id);
});
// junctions: where two edges' carriageways overlap, the surface must not jump where the nearest edge switches;
// 10 cm steps along x and z lines through a 24 m box around every junction, each step a 1 cm bisected check
out.junc = {checked: 0, worst: 0, at: null, over: 0};
H.junctions(W).forEach(function(j){
  for(var o = -12; o <= 12; o += 3) [0, 1].forEach(function(ax){
    var prev = null;
    for(var u = -12; u <= 12; u += 0.1){
      var x = j.x + (ax ? u : o + 0.37), z = j.z + (ax ? o + 0.37 : u), y = H.roadY(W, x, z);
      if(y !== null && prev !== null){
        out.junc.checked++;
        var x1 = x - (ax ? 0.01 : 0), z1 = z - (ax ? 0 : 0.01), y1 = H.roadY(W, x1, z1);
        // the kerb is a deliberate step; only compare samples on the same kind of surface
        var d = y1 === null || H.surfaceAt(W, x, z) !== H.surfaceAt(W, x1, z1) ? 0 : Math.abs(y - y1);
        if(d > 0.02) out.junc.over++;
        if(d > out.junc.worst){ out.junc.worst = d; out.junc.at = [j.node, x, z]; }
      }
      prev = y;
    }
  });
});
out.labels = H.roadLabels(W).length; out.junctions = H.junctions(W).length;
done(out);
"""


@unittest.skipUnless(NODE, "node is not installed")
@unittest.skipUnless(os.path.exists(REAL), "tests/fixtures/claude-hq@1.json.gz is missing")
class RealWorld(unittest.TestCase):
    PREFIX = ""

    @classmethod
    def setUpClass(cls):
        with gzip.open(REAL, "rt", encoding="utf-8") as f:
            cls.doc = json.load(f)
        rnd = random.Random(1234)
        half = cls.doc["size_cm"] // 2
        cls.pts = [[rnd.randint(-half - 500, half + 500), rnd.randint(-half - 500, half + 500)] for _ in range(3000)]
        lots, sites = cls.doc["layers"]["lots"], cls.doc["layers"]["sites"]
        # lot and site edges (inclusive) and centres
        for o in lots[::7] + sites:
            cls.pts += [[o["x"], o["z"]], [o["x"] + o["w"] // 2, o["z"]], [o["x"] - o["w"] // 2 - 1, o["z"]], [o["x"], o["z"] + o["d"] // 2]]
        cls.samples = None
        if os.path.exists(SAMPLES):
            with open(SAMPLES, encoding="utf-8") as f:
                cls.samples = json.load(f)
        cls.out = run_node(cls.PREFIX + REAL_BODY, stdin={"pts": cls.pts, "samples": cls.samples["samples"] if cls.samples else None})

    def test_pack(self):
        self.assertEqual(self.out["hash"], self.doc["hashes"]["world"])
        self.assertEqual(self.out["edges"], len(self.doc["layers"]["roads"]["edges"]))
        self.assertEqual(self.out["nLots"], len(self.doc["layers"]["lots"]))
        self.assertGreater(self.out["labels"], 0)
        self.assertGreater(self.out["junctions"], 0)

    def test_height_district_lot_site_match_port(self):
        L = self.doc["layers"]
        t, d = L["terrain"], L["districts"]
        for i, (x, z) in enumerate(self.pts):
            self.assertEqual(self.out["heights"][i], height_cm(t, x, z), (x, z))
            ix = min(max((x - d["origin_cm"]) // d["cell_cm"], 0), d["n"] - 1)
            iz = min(max((z - d["origin_cm"]) // d["cell_cm"], 0), d["n"] - 1)
            self.assertEqual(self.out["districts"][i], d["kinds"][iz * d["n"] + ix], (x, z))
            self.assertEqual(self.out["lots"][i], rect_id(L["lots"], x, z), (x, z))
            self.assertEqual(self.out["sites"][i], rect_id(L["sites"], x, z), (x, z))

    def test_rust_samples(self):
        if not self.samples:
            self.skipTest("tests/fixtures/claude-hq@1.samples.json not written yet (B1, tools/world_fixture.py)")
        self.assertEqual(self.samples["world"], self.doc["hashes"]["world"], "samples and fixture disagree; rerun tools/world_fixture.py")
        for s, got in zip(self.samples["samples"], self.out["samples"]):
            self.assertEqual(got["height"], s["height"], s)
            want_d = s["district"]
            self.assertEqual(got["dname"] if isinstance(want_d, str) else got["dk"], want_d, s)
            if "districtName" in s:
                self.assertEqual(got["dname"], s["districtName"], s)
            self.assertEqual(got["lot"], s["lot"] if s["lot"] not in (-1,) else None, s)
            self.assertEqual(got["site"], s["site"] if s["site"] not in ("", -1) else None, s)

    def test_pads_doors_buildings(self):
        self.assertEqual(self.out["hqPad"], [])
        self.assertEqual(self.out["doorBlocked"], [])
        self.assertEqual(self.out["bldFree"], [])

    def test_blend_continuous(self):
        b = self.out["blend"]
        if b["checked"] == 0:
            self.skipTest("no pad side opens onto plain ground here (tests/test_world.py TinyWorld covers the blend)")
        self.assertEqual(b["ends"], 0)         # pad y at the rim, raw terrain past 4 m
        self.assertLess(b["worst"], 0.1)       # per 5 cm step

    def test_road_surface(self):
        self.assertGreater(self.out["roadChecked"], 1000)
        self.assertGreater(self.out["walkChecked"], 500)
        self.assertEqual(self.out["roadMismatch"], 0)
        self.assertLessEqual(self.out["worstStep"], 0.6, "step at %s" % (self.out["worstAt"],))

    def test_road_cross_section(self):
        x = self.out["xsec"]
        self.assertGreater(x["checked"], 10000)
        self.assertEqual(x["bad"], 0, "ground jumps %.2f m across a road at %s (edge, x, z); see B1 request: hairpin arms overlap" % (x["worst"], x["at"]))

    def test_junction_surface_continuous(self):
        j = self.out["junc"]
        self.assertGreater(j["checked"], 5000)
        self.assertLess(j["worst"], 0.02, "roadY jumps %.3f m per 1 cm at %s (node, x, z)" % (j["worst"], j["at"]))

    def test_hq_pad_cells(self):
        c = self.out["hqPadCells"]
        self.assertGreater(c["checked"], 0)
        self.assertEqual(c["bad"], 0)
        self.assertEqual(c["underRoad"], 0)
        self.assertEqual(self.out["doorsOnRoad"], [])

    def test_blocked_uses_index(self):
        self.assertLess(self.out["perfMs"], 200)

    def test_trees(self):
        t = self.out["trees"]
        self.assertGreater(t["n"], 1000)
        self.assertTrue(t["same"])
        self.assertEqual(t["onRoad"], 0)

    def test_walkability_flood_fill(self):
        self.assertFalse(self.out["startBlocked"])
        self.assertGreater(self.out["reached"], 0.9 * self.out["free"])
        self.assertEqual(self.out["doorsUnreached"], [])
        self.assertEqual(self.out["sitesUnreached"], [])
        self.assertEqual(self.out["edgesReached"], [True, True, True, True])


# world.js again with games/roadsmooth.js loaded first: pack() smooths the roads (the page and the build worker load it)
CURVED = r"""
global.window = {HQV: {}};
new Function(fs.readFileSync(root + "/games/roadsmooth.js", "utf8"))();
new Function(fs.readFileSync(root + "/games/world.js", "utf8"))();
H = window.HQV.world;
"""


@unittest.skipUnless(NODE, "node is not installed")
@unittest.skipUnless(os.path.exists(REAL), "tests/fixtures/claude-hq@1.json.gz is missing")
class CurvedRealWorld(RealWorld):
    """Every RealWorld check on Arena City with curved roads: the surface, the kerbs, the junctions (rounded corners
    included), the trees and the flood fill hold on the smoothed geometry too."""
    PREFIX = CURVED

    def test_junction_surface_continuous(self):
        # the relaxed ring and highway now overlap at the edges of both bands in one sharp gore (node 536), where two
        # graded arms 0.3 m apart blend with near-zero weights: one 1 cm step of 3 cm in 1.3 M, nothing else over 2 cm
        j = self.out["junc"]
        self.assertGreater(j["checked"], 5000)
        self.assertLessEqual(j["over"], 2, "roadY jumps %.3f m per 1 cm at %s (node, x, z)" % (j["worst"], j["at"]))
        self.assertLess(j["worst"], 0.05, "roadY jumps %.3f m per 1 cm at %s (node, x, z)" % (j["worst"], j["at"]))


COMMONS = os.path.join(ROOT, "tests", "fixtures", "claude-hq@2.json.gz")
CURVED_BODY = r"""
function gz(f){ return JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/" + f))); }
var out = {packV: H.PACK_V};
var doc = gz("claude-hq@2.json.gz"), W = H.pack(doc), RS = window.HQV.roadSmooth;
out.smoothed = W.smoothed;
out.pts0 = W.edges.every(function(e){ return e.pts0 instanceof Int32Array && e.pts instanceof Int32Array; });
out.morePts = [W.edges.reduce(function(a, e){ return a + e.pts.length; }, 0), W.edges.reduce(function(a, e){ return a + e.pts0.length; }, 0)];
// docOf hands the curves to traffic, npcsim, ocean and hqtravel
var D = H.docOf(W);
out.docOf = D.layers.roads.edges.every(function(e, i){
  var p = W.edges[i].pts; return e.points.length === p.length/3 && e.points.every(function(q, j){ return q[0] === p[3*j] && q[1] === p[3*j+1] && q[2] === p[3*j+2]; });
});
// the cache record keeps the curves (and the originals): a cached W is never smoothed twice
var C = H.cacheCopy(W);
out.cache = C.smoothed && C.edges.every(function(e, i){ return e.pts === W.edges[i].pts && e.pts0 === W.edges[i].pts0; });
// rounded junction corners: the sliver between each arc and its kerbs' sharp corner is road; a point just inside the
// arc (in the block) is not; without roadsmooth the same sliver point is sidewalk or off the road
var I = (H.groundAt(W, 0, 0), W.index), F = I.filList || [], raw = (function(){ var rs = window.HQV.roadSmooth; delete window.HQV.roadSmooth;
  try { return H.pack(doc); } finally { window.HQV.roadSmooth = rs; } })();
out.fil = {n: F.length, road: 0, rawRoad: 0, inside: 0, insideRoad: 0, yBad: 0};
F.forEach(function(f){
  var mx = (f.ax + f.bx)/2 - f.cx, mz = (f.az + f.bz)/2 - f.cz, l = Math.hypot(mx, mz), ax = f.cx + mx/l*f.r, az = f.cz + mz/l*f.r;
  var px = (f.kx + ax)/2, pz = (f.kz + az)/2;
  if(H.surfaceAt(W, px, pz) === "road") out.fil.road++;
  if(H.surfaceAt(raw, px, pz) === "road") out.fil.rawRoad++;
  var y = H.roadY(W, px, pz), r = H.nearestRoad(W, px, pz, 30);
  if(y === null || !r || Math.abs(y - r.y) > 0.5) out.fil.yBad++;
  var qx = f.cx + mx/l*(f.r - 0.3), qz = f.cz + mz/l*(f.r - 0.3);
  if(Math.hypot(qx - f.kx, qz - f.kz) > 0.3){ out.fil.inside++; if(H.surfaceAt(W, qx, qz) === "road") out.fil.insideRoad++; }
});
// no tree in a sliver; trees still plenty
var T = H.trees(W);
out.trees = {n: T.length, inFillet: T.filter(function(t){ return H.surfaceAt(W, t.x, t.z) === "road"; }).length};
// a structured clone (IndexedDB, the build worker) keeps the curves and the corners
var W2 = require("v8").deserialize(require("v8").serialize(W));
W2.index = null;
out.clone = W2.smoothed && H.groundAt(W2, F[0].kx, F[0].kz) === H.groundAt(W, F[0].kx, F[0].kz) && (W2.index.filList || []).length === F.length;
done(out);
"""


@unittest.skipUnless(NODE, "node is not installed")
@unittest.skipUnless(os.path.exists(COMMONS), "tests/fixtures/claude-hq@2.json.gz is missing")
class CurvedRoads(unittest.TestCase):
    """pack() with games/roadsmooth.js loaded (the Commons): the curves reach every reader and the rounded junction
    corners are road."""
    @classmethod
    def setUpClass(cls):
        cls.out = run_node(CURVED + CURVED_BODY)

    def test_pack_smooths(self):
        o = self.out
        self.assertEqual(o["packV"], 5)
        self.assertEqual(o["smoothed"], {"v": 1})
        self.assertTrue(o["pts0"])
        self.assertGreater(o["morePts"][0], 1.5 * o["morePts"][1], "3 m samples: more points than the server's 24 m pieces")
        self.assertTrue(o["docOf"])
        self.assertTrue(o["cache"])
        self.assertTrue(o["clone"])

    def test_rounded_corners_are_road(self):
        f = self.out["fil"]
        self.assertGreater(f["n"], 300)
        self.assertEqual(f["road"], f["n"])
        self.assertLess(f["rawRoad"], f["n"] * 0.2, "straight corners left the sliver to the sidewalk")
        self.assertEqual(f["yBad"], 0)
        self.assertGreater(f["inside"], 100)
        self.assertLess(f["insideRoad"], f["inside"] * 0.1, "inside the arc stays sidewalk (except where another road is)")

    def test_trees_clear_of_corners(self):
        t = self.out["trees"]
        self.assertGreater(t["n"], 500)
        self.assertEqual(t["inFillet"], 0)


if __name__ == "__main__":
    unittest.main()
