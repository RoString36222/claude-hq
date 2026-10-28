"""City Gen v4 phase 11 (HQ 3.34): road paint and planted medians.

Under node, on the @3 Commons fixture (tests/fixtures/claude-hq@3.json.gz) packed by games/world.js and built by
games/worldgeom.js (with games/citylife.js, as the mesh worker loads them):
  - a boulevard's median is planted (trees in the tiles' props, hedge blocks in their kerb geo), an avenue's has
    shrubs, every plant on the raised median (never the junction patch), clear of the median's noses and 1.5 m or more
    from every City Line pier;
  - a minor road meeting one two classes above it at a priority junction has a solid stop line across its way in;
  - an avenue's or boulevard's approach to a junction (2+ lanes each way) has a lane arrow per lane, 15-25 m before the
    line, the kerb lane turning left (traffic keeps left) and the median lane right;
  - where an avenue or a boulevard meets at lights the junction is a yellow box; a ramp's gore has chevrons;
  - avenues have thin white edge lines inside their kerbs;
  - the build is deterministic and the same with games/traffic.js loaded (the page) as without (the worker);
  - the @2 Commons has none of it.
Skipped without node. Stdlib only."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

SCRIPT = r"""
var fs = require("fs"), zlib = require("zlib"), crypto = require("crypto"), root = %(root)s;
global.window = {HQV: {}};
function load(f){ new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))(); }
["world", "worldgeom", "citylife"].forEach(load);
var H = window.HQV, Q = H.world, G = H.worldgeom, P = G.PAINT, out = {};
function raw(n){ return JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/" + n)).toString("utf8")); }
function same(c, k, col){ return Math.abs(c[k] - col[0]) < 1e-5 && Math.abs(c[k + 1] - col[1]) < 1e-5 && Math.abs(c[k + 2] - col[2]) < 1e-5; }
var W = Q.pack(raw("claude-hq@3.json.gz")), tiles = {};
function tile(tx, tz){ var k = tx + "," + tz; return tiles[k] || (tiles[k] = G.roadTile(W, tx, tz)); }
function near(x, z, R){ var L = [], seen = {}; [[0, 0], [R, 0], [-R, 0], [0, R], [0, -R], [R, R], [-R, -R], [R, -R], [-R, R]].forEach(function(d){
  var t = G.tileOf(x + d[0], z + d[1]), k = t.tx + "," + t.tz; if(!seen[k]){ seen[k] = 1; L.push(tile(t.tx, t.tz)); } }); return L; }
// every triangle of geometry `kind` near (x, z) (R m): [{c: centroid [x, z], v: [[x, y, z] x 3], k: first vertex index, g}]
function trisNear(kind, x, z, R){
  var res = [];
  near(x, z, R).forEach(function(T){ var g = T[kind], p = g.pos, ix = g.idx;
    for(var i = 0; i < ix.length; i += 3){
      var V = [0, 1, 2].map(function(j){ var v = ix[i + j]; return [p[3*v], p[3*v + 1], p[3*v + 2]]; });
      var cx = (V[0][0] + V[1][0] + V[2][0])/3, cz = (V[0][2] + V[1][2] + V[2][2])/3;
      if(Math.hypot(cx - x, cz - z) < R) res.push({c: [cx, cz], v: V, k: 3*ix[i], g: g});
    } });
  return res;
}
var nodes = {}, inc = {}, edges = {};
W.nodes.forEach(function(n){ nodes[n.id] = n; });
W.edges.forEach(function(e){ edges[e.id] = e; (inc[e.a] = inc[e.a] || []).push(e); (inc[e.b] = inc[e.b] || []).push(e); });
// an edge's way out of node id: its unit direction over its first few metres
function armDir(e, id){ var p = e.pts, n = p.length/3, i0 = String(e.a) === String(id) ? 0 : n - 1, i1 = i0 ? i0 - 1 : 1;
  var dx = p[3*i1] - p[3*i0], dz = p[3*i1 + 2] - p[3*i0 + 2], l = Math.hypot(dx, dz) || 1; return [dx/l, dz/l]; }
var RP = Q.railPiersOf(W), paint = G.roadPaint(W);
// (x, z) against a packed edge's centre line: the distance d and the arc length s (m) of the nearest point
function proj(e, x, z){
  var p = e.pts, n = p.length/3, best = {d: Infinity, s: 0}, acc = 0;
  for(var i = 0; i + 1 < n; i++){
    var ax = p[3*i]/100, az = p[3*i + 2]/100, ux = p[3*i + 3]/100 - ax, uz = p[3*i + 5]/100 - az, l = Math.hypot(ux, uz);
    if(l < 1e-9) continue;
    var t = Math.max(0, Math.min(1, ((x - ax)*ux + (z - az)*uz)/(l*l))), d = Math.hypot(x - ax - ux*t, z - az - uz*t);
    if(d < best.d) best = {d: d, s: acc + t*l};
    acc += l;
  }
  return best;
}

/* ---------- planted medians ---------- */
var plants = {boulevard: {edges: 0, trees: 0, blocks: 0}, avenue: {edges: 0, trees: 0, blocks: 0}};
paint.plants.forEach(function(p){ var e = edges[p.edge], k = plants[e.v4]; if(!k) return; k.edges++; k.trees += p.trees.length; k.blocks += p.blocks.length; });
plants.centreBeds = paint.plants.filter(function(p){ return edges[p.edge].bed > 0 && !(edges[p.edge].median > 0); }).length;
// the drawn plants: every hedge or shrub vertex in the kerb geo, every median tree in the props
var verts = 0, pierBad = [], tops = 0, offMedian = [], noseBad = [], jn = W.nodes.filter(function(n){ return (inc[n.id] || []).length >= 3; });
for(var tz = 0; tz < 8; tz++) for(var tx = 0; tx < 8; tx++){
  var g = tile(tx, tz).kerb, c = g.col, p = g.pos;
  for(var v = 0; v < c.length; v += 3){
    var top = same(c, v, P.COL.hedgeTop) || same(c, v, P.COL.shrubTop);
    if(!top && !same(c, v, P.COL.hedge) && !same(c, v, P.COL.shrub)) continue;
    verts++;
    var x = p[v], z = p[v + 2];
    RP.forEach(function(q){ if(Math.hypot(x - q.x, z - q.z) < q.r + 1.5 - 1e-3) pierBad.push([x, z]); });
    jn.forEach(function(n){ if(Math.hypot(x - n.x/100, z - n.z/100) < P.PLANT_NOSE) noseBad.push([x, z, n.id]); });
  }
  for(var i = 0; i < g.idx.length; i += 3) if(same(c, 3*g.idx[i], P.COL.hedgeTop) || same(c, 3*g.idx[i], P.COL.shrubTop)) tops++;
}
// each plant stands on its own edge's raised median (inside its half width), between its noses: never in the junction
// patch (the edge's trim at that end) nor the zebra beyond it (world.js surfaceAt reads most of a median as road, so
// this is checked on the plan, the drawing against it below)
var blocks = 0;
paint.plants.forEach(function(pl){
  pl.blocks.forEach(function(k){
    blocks++;
    if(!(Math.max(Math.abs(k.o0), Math.abs(k.o1)) <= pl.med - 0.3 && k.s0 >= pl.tA + P.PLANT_NOSE - 1e-6 && k.s1 <= pl.len - pl.tB - P.PLANT_NOSE + 1e-6)) offMedian.push([pl.edge, k.s0, k.s1, k.o0, k.o1]);
  });
  pl.trees.forEach(function(t){
    var pr = proj(edges[pl.edge], t.x, t.z);
    if(!(pr.d < 0.01 && pr.s >= pl.tA + P.PLANT_NOSE - 1e-6 && pr.s <= pl.len - pl.tB - P.PLANT_NOSE + 1e-6)) offMedian.push([pl.edge, "tree", pr.s, pr.d]);
  });
});
var treeBad = [], treeN = 0, treeAll = 0;
var medTrees = []; paint.plants.forEach(function(p){ medTrees = medTrees.concat(p.trees); });
for(var tz2 = 0; tz2 < 8; tz2++) for(var tx2 = 0; tx2 < 8; tx2++) G.props(W, tx2, tz2).trees.forEach(function(t){
  treeAll++;
  if(!medTrees.some(function(m){ return Math.abs(m.x - t.x) < 1e-9 && Math.abs(m.z - t.z) < 1e-9; })) return;
  treeN++;
  RP.forEach(function(q){ if(Math.hypot(t.x - q.x, t.z - q.z) < q.r + 1.5) treeBad.push([t.x, t.z]); });
  jn.forEach(function(n){ if(Math.hypot(t.x - n.x/100, t.z - n.z/100) < P.PLANT_NOSE) noseBad.push([t.x, t.z, n.id]); });
});
out.plants = {byClass: plants, verts: verts, tops: tops, blocks: blocks, pierBad: pierBad.length, noseBad: noseBad.slice(0, 5), offMedian: offMedian.slice(0, 5), offN: offMedian.length,
              trees: treeN, treeBad: treeBad.slice(0, 5), treesWorld: Q.trees(W).length, treeAll: treeAll};

/* ---------- stop lines on priority junctions' minor arms ---------- */
var RANK = {lane: 0, shared: 0, local: 0, collector: 1, avenue: 2, boulevard: 3, expressway: 4};
var stops = {want: 0, found: 0, missing: []};
W.nodes.forEach(function(n){
  if(n.junction !== "priority") return;
  var es = inc[n.id] || [], top = 0;
  es.forEach(function(e){ top = Math.max(top, RANK[e.v4] || 0); });
  es.forEach(function(e){
    if(top - (RANK[e.v4] || 0) < 2) return;
    stops.want++;
    var d = armDir(e, n.id), x0 = n.x/100, z0 = n.z/100, ok = false;
    trisNear("marks", x0, z0, 30).forEach(function(t){
      if(ok || !same(t.g.col, t.k, P.COL.white)) return;
      var al = t.v.map(function(q){ return (q[0] - x0)*d[0] + (q[2] - z0)*d[1]; }), ac = t.v.map(function(q){ return (q[0] - x0)*d[1] - (q[2] - z0)*d[0]; });
      var aspan = Math.max.apply(null, al) - Math.min.apply(null, al), cspan = Math.max.apply(null, ac) - Math.min.apply(null, ac);
      var am = (al[0] + al[1] + al[2])/3, cm = (ac[0] + ac[1] + ac[2])/3;
      // a solid line across the arm: thin along it, long across it, on the arm itself
      if(aspan <= P.STOP_W + 0.06 && cspan >= 1.2 && am > 0 && am < 28 && Math.abs(cm) < e.width/200) ok = true;
    });
    if(ok) stops.found++; else stops.missing.push([n.id, e.id]);
  });
});
stops.missing = stops.missing.slice(0, 5);
out.stops = stops;

/* ---------- lane arrows ---------- */
var arrows = paint.arrows, groups = {};
arrows.forEach(function(A){ var k = A.node + ":" + A.edge + ":" + A.end; (groups[k] = groups[k] || []).push(A); });
var ar = {n: arrows.length, groups: Object.keys(groups).length, kinds: {}, back: [Infinity, -Infinity], badClass: 0, badLanes: [], painted: 0, lanesOk: 0};
arrows.forEach(function(A){
  ar.kinds[A.kind] = (ar.kinds[A.kind] || 0) + 1;
  ar.back = [Math.min(ar.back[0], A.back), Math.max(ar.back[1], A.back)];
  var e = edges[A.edge];
  if(!(e.v4 === "avenue" || e.v4 === "boulevard") || !(e.lanes >= 2)) ar.badClass++;
  if(trisNear("marks", A.x, A.z, 2.5).some(function(t){ return same(t.g.col, t.k, P.COL.white); })) ar.painted++;
});
Object.keys(groups).forEach(function(k){
  var L = groups[k].slice().sort(function(a, b){ return Math.abs(a.off) - Math.abs(b.off); }), inner = L[0], kerb = L[L.length - 1];
  if(L.length !== edges[L[0].edge].lanes) ar.badLanes.push(k + " count");
  // traffic keeps left: the kerb lane never turns right while the median lane never turns left
  if(kerb.kind.indexOf("R") >= 0 || inner.kind.indexOf("L") >= 0) ar.badLanes.push(k + " " + inner.kind + "/" + kerb.kind);
  else ar.lanesOk++;
});
ar.badLanes = ar.badLanes.slice(0, 5);
out.arrows = ar;

/* ---------- yellow boxes at lights, chevrons in gores ---------- */
var box = {want: 0, painted: 0, low: [], plain: 0, plainYellow: 0};
W.nodes.forEach(function(n){
  if(n.junction !== "signals") return;
  var es = inc[n.id] || [], big = es.some(function(e){ return e.v4 === "avenue" || e.v4 === "boulevard"; });
  var y = trisNear("marks", n.x/100, n.z/100, 10).filter(function(t){ return same(t.g.col, t.k, P.COL.yellow); }).length;
  if(big){ box.want++; if(y >= 20) box.painted++; else box.low.push([n.id, y]); }
  else { box.plain++; box.plainYellow += y; }
});
out.box = box;
function inTri(x, z, T){ function s(a, b){ return (b[0] - a[0])*(z - a[1]) - (b[1] - a[1])*(x - a[0]); }
  var d1 = s(T[0], T[1]), d2 = s(T[1], T[2]), d3 = s(T[2], T[0]); return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0)); }
out.gores = {n: paint.gores.length, nodes: Object.keys(paint.gores.reduce(function(o, g){ o[g.node] = 1; return o; }, {})).length,
  ramps: W.nodes.filter(function(n){ return n.junction === "ramps"; }).length,
  painted: paint.gores.map(function(g){ return trisNear("marks", g.M[0], g.M[1], 40).filter(function(t){ return same(t.g.col, t.k, P.COL.white) && inTri(t.c[0], t.c[1], [g.M, g.pa, g.pb]); }).length; })};

/* ---------- edge lines along an avenue ---------- */
var ave = W.edges.filter(function(e){ return e.v4 === "avenue" && e.median > 0 && !e.tram; }).map(function(e){
  var p = e.pts, L = 0; for(var j = 3; j < p.length; j += 3) L += Math.hypot((p[j] - p[j - 3])/100, (p[j + 2] - p[j - 1])/100); return {e: e, L: L}; })
  .sort(function(a, b){ return b.L - a.L || a.e.id - b.e.id; })[0].e;
var ap = ave.pts, am = Math.floor(ap.length/6), ax = ap[3*am]/100, az = ap[3*am + 2]/100, adx = ap[3*am + 3]/100 - ap[3*am - 3]/100, adz = ap[3*am + 5]/100 - ap[3*am - 1]/100, adl = Math.hypot(adx, adz);
var lat = {};
trisNear("marks", ax, az, 12).forEach(function(t){ t.v.forEach(function(q){ var dx = q[0] - ax, dz = q[2] - az, al = (dx*adx + dz*adz)/adl;
  if(Math.abs(al) < 2) lat[Math.round(Math.abs((dx*adz - dz*adx)/adl)*100)] = 1; }); });
out.edgeLines = {cw: (ave.width - 2*(ave.walk || 0))/200, lat: Object.keys(lat).map(Number).sort(function(a, b){ return a - b; })};

/* ---------- determinism, the worker's build vs the page's (traffic.js loaded), @2 ---------- */
function digest(WW, ours){
  var h = crypto.createHash("sha1");
  for(var tz = 0; tz < 8; tz++) for(var tx = 0; tx < 8; tx++){
    var r = G.roadTile(WW, tx, tz);
    (ours ? ["kerb"] : ["asphalt", "marks", "kerb", "walk"]).forEach(function(k){ h.update(Buffer.from(r[k].pos.buffer)); h.update(Buffer.from(r[k].col.buffer)); h.update(Buffer.from(r[k].idx.buffer)); });
    h.update(JSON.stringify(G.props(WW, tx, tz).trees));
  }
  h.update(JSON.stringify(G.roadPaint(WW)));
  return h.digest("hex");
}
var d0 = digest(W), d1 = digest(Q.pack(raw("claude-hq@3.json.gz"))), o0 = digest(W, true);
load("traffic");
var o2 = digest(Q.pack(raw("claude-hq@3.json.gz")), true);
out.det = {same: d0 === d1, page: o0 === o2, side: H.traffic.SIDE};
var W2 = Q.pack(raw("claude-hq@2.json.gz")), p2 = G.roadPaint(W2), hedge2 = 0;
for(var tz3 = 0; tz3 < 8; tz3++) for(var tx3 = 0; tx3 < 8; tx3++){ var c2 = G.roadTile(W2, tx3, tz3).kerb.col;
  for(var v2 = 0; v2 < c2.length; v2 += 3) if(same(c2, v2, P.COL.hedge) || same(c2, v2, P.COL.hedgeTop) || same(c2, v2, P.COL.shrub) || same(c2, v2, P.COL.shrubTop)) hedge2++; }
var t2 = 0; for(var tz4 = 0; tz4 < 8; tz4++) for(var tx4 = 0; tx4 < 8; tx4++) t2 += G.props(W2, tx4, tz4).trees.length;
out.at2 = {arrows: p2.arrows.length, plants: p2.plants.length, gores: p2.gores.length, hedge: hedge2, trees: t2, treesWorld: Q.trees(W2).length};
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class RoadMarksV4(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", SCRIPT % {"root": json.dumps(ROOT)}], capture_output=True, text=True, timeout=900)
        if r.returncode != 0:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_medians_are_planted(self):
        p = self.o["plants"]
        b, a = p["byClass"]["boulevard"], p["byClass"]["avenue"]
        self.assertGreater(b["edges"], 3, p)
        self.assertGreater(b["blocks"], 20, "hedges along the boulevard")
        self.assertGreater(b["trees"], 5, "trees down the boulevard's median")
        self.assertGreater(a["edges"], 50, p)
        self.assertGreater(a["blocks"], 200, "shrubs on the avenues' medians")
        self.assertEqual(a["trees"], 0, "no trees on an avenue's narrow median")
        self.assertEqual(p["trees"], b["trees"], "every median tree is in the tiles' props")
        self.assertGreater(p["verts"], 1000)
        self.assertEqual(p["tops"], 2 * p["blocks"], "every planned plant drawn (its top a quad)")

    def test_plants_keep_clear(self):
        p = self.o["plants"]
        self.assertEqual(p["pierBad"], 0, "1.5 m or more from every City Line pier")
        self.assertEqual(p["treeBad"], [], "median trees 1.5 m or more off the piers")
        self.assertEqual(p["noseBad"], [], "back from the junctions")
        self.assertEqual(p["offN"], 0, ("every plant on its median, never in the junction patch or the zebra", p["offMedian"]))

    def test_no_plants_on_a_tram_bed(self):
        self.assertEqual(self.o["plants"]["byClass"]["centreBeds"], 0)

    def test_stop_lines_on_priority_minor_arms(self):
        s = self.o["stops"]
        self.assertGreater(s["want"], 20, s)
        self.assertGreaterEqual(s["found"], 0.95 * s["want"], s)

    def test_lane_arrows(self):
        a = self.o["arrows"]
        self.assertGreater(a["n"], 60, a)
        self.assertEqual(a["badClass"], 0, "only on 2+ lane avenues and boulevards")
        self.assertEqual(a["badLanes"], [], "kerb lane left, median lane right (traffic keeps left)")
        self.assertEqual(a["lanesOk"], a["groups"])
        for k in ("S", "SL", "SR"):
            self.assertGreater(a["kinds"].get(k, 0), 5, a["kinds"])
        self.assertGreaterEqual(a["back"][0], 15)
        self.assertLessEqual(a["back"][1], 25)
        self.assertEqual(a["painted"], a["n"], "each arrow is painted where the plan puts it")

    def test_box_junctions_and_gores(self):
        b = self.o["box"]
        self.assertGreater(b["want"], 10, b)
        self.assertEqual(b["painted"], b["want"], b["low"])
        self.assertEqual(b["plainYellow"], 0, "no box where no avenue or boulevard meets")
        g = self.o["gores"]
        self.assertGreaterEqual(g["nodes"], 4, g)
        for n in g["painted"]:
            self.assertGreaterEqual(n, 4, g)

    def test_avenue_edge_lines(self):
        e = self.o["edgeLines"]
        want = round((e["cw"] - 0.3) * 100)
        self.assertTrue(any(abs(l - (want - 6)) <= 1 for l in e["lat"]) and any(abs(l - (want + 6)) <= 1 for l in e["lat"]), e)

    def test_deterministic_and_the_same_in_the_worker(self):
        d = self.o["det"]
        self.assertTrue(d["same"])
        self.assertTrue(d["page"], "traffic.js loaded (the page) builds what the worker builds")
        self.assertEqual(d["side"], -1)

    def test_at2_unchanged(self):
        a = self.o["at2"]
        self.assertEqual((a["arrows"], a["plants"], a["gores"], a["hedge"]), (0, 0, 0, 0))


if __name__ == "__main__":
    unittest.main()
