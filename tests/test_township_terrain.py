"""The land round the townships (HQ 3.37): no cliffs, no roads raised on wedges or buried, the ride on what is drawn.

A township (an HQ lot with gates) and its two neighbouring plots are graded level at its door's height
(backend/src/worldgen/v5/doc.rs grade_townships). The grading once reached over the streets round it: they were seated on
the graded land, so a street rose onto the township's level and dropped off it again in a few metres (grades to 90 %),
the junction plates fitted over that left the drawn road a metre and more over the ride's ground, and the terrain clamp
under a township's pad dug the land beside a higher street down to the pad (a road on dark wedges over a sunken verge).

The fixture tests/fixtures/commons_v5_towns.json.gz is the Commons as City Gen v5 builds it (`worldgen claude-hq@4
--json`, only the terrain, districts, roads, blocks, lots, sites, island and river layers). Under node with
games/world.js, citylife.js and worldgeom.js every tile within 40 m of a township is built at the finest lod, and round
each township's ground (outside it, within 40 m):
  - the drawn terrain has no cliff: no triangle off the roads steeper than 0.75 (rise over run);
  - every street keeps a street's grade (at most 12 % from point to point);
  - on the streets the ride's ground (HQV.world.groundAt) is the drawn road within 0.6 m everywhere, and something is drawn;
  - no road stands on a wedge: the drawn ribbon's edge at most 2.5 m over the drawn land under it, never under it, and
    the land a metre past the kerb at most 3 m under the road's edge.
Skipped without node or the fixture. Stdlib only."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
FIXTURE = os.path.join(ROOT, "tests", "fixtures", "commons_v5_towns.json.gz")

HARNESS = r"""
var fs = require("fs"), zlib = require("zlib"), root = %(root)s;
global.window = {HQV: {}}; global.self = global.window;
["world", "citylife", "worldgeom"].forEach(function(f){ new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))(); });
var WD = window.HQV.world, WG = window.HQV.worldgeom;
var W = WD.pack(JSON.parse(zlib.gunzipSync(fs.readFileSync(%(doc)s))));
WG.meshY(W, 0, 0, 0);
var REACH = 40, TILE = 256, O = WG.ORIGIN;
function inPoly(P, x, z){ var c = false; for(var i = 0, j = P.length - 1; i < P.length; j = i++){ var a = P[i], b = P[j];
  if((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0])*(z - a[1])/(b[1] - a[1]) + a[0]) c = !c; } return c; }
function pdist(P, x, z){ if(inPoly(P, x, z)) return 0; var best = Infinity;
  for(var i = 0, j = P.length - 1; i < P.length; j = i++){ var a = P[j], c = P[i], ex = c[0] - a[0], ez = c[1] - a[1], l = ex*ex + ez*ez;
    var t = l > 0 ? Math.max(0, Math.min(1, ((x - a[0])*ex + (z - a[1])*ez)/l)) : 0; best = Math.min(best, Math.hypot(a[0] + t*ex - x, a[1] + t*ez - z)); }
  return best; }
// every township's ground (its lot and plots, m) and its box grown by REACH
var towns = [];
W.lots.forEach(function(l){ if(l.kind !== "hq" || !Array.isArray(l.gates)) return;
  var P = [l.poly].concat((l.annex || []).map(function(a){ return a.poly; })).map(function(Q){ return Q.map(function(q){ return [q[0]/100, q[1]/100]; }); });
  var B = [Infinity, -Infinity, Infinity, -Infinity];
  P.forEach(function(Q){ Q.forEach(function(q){ B[0] = Math.min(B[0], q[0]); B[1] = Math.max(B[1], q[0]); B[2] = Math.min(B[2], q[1]); B[3] = Math.max(B[3], q[1]); }); });
  towns.push({id: l.id, P: P, box: [B[0] - REACH, B[1] + REACH, B[2] - REACH, B[3] + REACH]});
});
// (the township whose ground is within REACH of (x, z) and how far, 0 on it; null off them all)
function townNear(x, z){
  for(var i = 0; i < towns.length; i++){ var t = towns[i], b = t.box;
    if(x < b[0] || x > b[1] || z < b[2] || z > b[3]) continue;
    var d = Math.min.apply(null, t.P.map(function(P){ return pdist(P, x, z); }));
    if(d <= REACH) return {id: t.id, d: d}; }
  return null;
}
var want = {};
towns.forEach(function(t){ for(var x = t.box[0]; x <= t.box[1] + TILE; x += TILE) for(var z = t.box[2]; z <= t.box[3] + TILE; z += TILE){
  var tx = Math.floor((Math.min(x, t.box[1]) - O)/TILE), tz = Math.floor((Math.min(z, t.box[3]) - O)/TILE); want[tx + "," + tz] = [tx, tz]; } });
// the up-facing drawn triangles, bucketed on a 2 m grid
var CELL = 2, grid = new Map(), T = [], LODS = [];
for(var k = 0; k < 16; k++) LODS.push(0);
function addGeo(G, kind){ if(!G || !G.pos) return; var p = G.pos, I = G.idx;
  for(var t = 0; t < I.length; t += 3){ var a = I[t]*3, b = I[t+1]*3, c = I[t+2]*3;
    var ux = p[b] - p[a], uy = p[b+1] - p[a+1], uz = p[b+2] - p[a+2], vx = p[c] - p[a], vy = p[c+1] - p[a+1], vz = p[c+2] - p[a+2];
    var nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx, l = Math.hypot(nx, ny, nz);
    if(!(l > 1e-9) || ny/l < 0.25) continue;
    if(kind === "kerb" && G.col[a+1] > 1.3*G.col[a] && G.col[a+1] > 1.5*G.col[a+2]) continue;   // a median's planting
    var id = T.length; T.push([p[a], p[a+1], p[a+2], p[b], p[b+1], p[b+2], p[c], p[c+1], p[c+2], kind]);
    for(var i = Math.floor(Math.min(p[a], p[b], p[c])/CELL); i <= Math.floor(Math.max(p[a], p[b], p[c])/CELL); i++)
      for(var j = Math.floor(Math.min(p[a+2], p[b+2], p[c+2])/CELL); j <= Math.floor(Math.max(p[a+2], p[b+2], p[c+2])/CELL); j++){
        var key = i*65536 + j, L = grid.get(key); if(!L) grid.set(key, L = []); L.push(id); } } }
var out = {towns: towns.length, tiles: 0, slope: {n: 0, max: 0, at: null}};
Object.keys(want).forEach(function(key){ var tt = want[key];
  var m = WG.buildTile(W, {tx: tt[0], tz: tt[1], lods: LODS, want: ["terrain", "roads", "ground"]}); out.tiles++;
  addGeo(m.terrain, "terrain"); addGeo(m.ground, "ground");
  ["asphalt", "walk", "kerb", "marks", "bridge", "tunnel"].forEach(function(r){ addGeo(m.roads[r], r); });
  // cliffs: the drawn terrain's steepest triangles off the roads round a township (outside its ground)
  var p = m.terrain.pos, I = m.terrain.idx;
  for(var t = 0; t < I.length; t += 3){ var a = I[t]*3, b = I[t+1]*3, c = I[t+2]*3;
    var ux = p[b] - p[a], uy = p[b+1] - p[a+1], uz = p[b+2] - p[a+2], vx = p[c] - p[a], vy = p[c+1] - p[a+1], vz = p[c+2] - p[a+2];
    var nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx;
    if(!(Math.abs(ny) > 1e-6)) continue;   // (a skirt)
    var s = Math.hypot(nx, nz)/Math.abs(ny), cx = (p[a] + p[b] + p[c])/3, cz = (p[a+2] + p[b+2] + p[c+2])/3;
    if(s <= out.slope.max) continue;
    var tn = townNear(cx, cz); if(!tn || tn.d === 0 || WD.roadY(W, cx, cz) != null) continue;
    out.slope.n++; out.slope.max = s; out.slope.at = [+cx.toFixed(1), +cz.toFixed(1), tn.id];
  }
});
function drawnAll(x, z){ var L = grid.get(Math.floor(x/CELL)*65536 + Math.floor(z/CELL)), A = []; if(!L) return A;
  for(var n = 0; n < L.length; n++){ var r = T[L[n]], ax = r[0], az = r[2], bx = r[3], bz = r[5], cx = r[6], cz = r[8];
    var d = (bz - cz)*(ax - cx) + (cx - bx)*(az - cz); if(Math.abs(d) < 1e-12) continue;
    var l1 = ((bz - cz)*(x - cx) + (cx - bx)*(z - cz))/d, l2 = ((cz - az)*(x - cx) + (ax - cx)*(z - cz))/d, l3 = 1 - l1 - l2;
    if(l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue; A.push({y: l1*r[1] + l2*r[4] + l3*r[7], kind: r[9]}); }
  return A; }
function worst(o, v, at){ if(Math.abs(v) > Math.abs(o.max)){ o.max = v; o.at = at; } }
var ride = {n: 0, max: 0, at: null, none: 0}, grade = {n: 0, max: 0, at: null}, edge = {n: 0, max: 0, at: null, under: 0}, kerb = {n: 0, max: 0, at: null};
W.edges.forEach(function(e){ if(e.bridge || e.under || e.v4 === "flyover" || e.v4 === "ramp") return;
  var p = e.pts, m = p.length/3, half = e.width/200, cw = (e.width - 2*e.walk)/200;
  for(var j = 0; j + 1 < m; j++){ var ax = p[3*j]/100, ay = p[3*j+1]/100, az = p[3*j+2]/100, bx = p[3*j+3]/100, by = p[3*j+4]/100, bz = p[3*j+5]/100;
    var L = Math.hypot(bx - ax, bz - az); if(!(L > 0.5)) continue;
    var ux = (bx - ax)/L, uz = (bz - az)/L, lx = uz, lz = -ux;
    for(var s = 0.5; s < L; s += 1){ var cx = ax + ux*s, cz = az + uz*s, cy = ay + (by - ay)*s/L, tn = townNear(cx, cz); if(!tn) continue;
      var at = [+cx.toFixed(1), +cz.toFixed(1), tn.id, e.id];
      if(s < 1 && L >= 1){ grade.n++; worst(grade, Math.abs(by - ay)/L, at); }
      // the ride's ground against the drawn road (the topmost drawn surface up to 3 m over it)
      [0, cw*0.5, -cw*0.5, cw - 0.3, -(cw - 0.3), (cw + half)/2, -(cw + half)/2].forEach(function(o){
        var x = cx + lx*o, z = cz + lz*o; if(WD.holeAt && WD.holeAt(W, x, z)) return;
        var g = WD.groundAt(W, x, z, false, cy), D = null;
        drawnAll(x, z).forEach(function(d){ if(d.y <= g + 3 && (!D || d.y > D.y)) D = d; });
        ride.n++; if(!D){ ride.none++; return; } worst(ride, D.y - g, [+x.toFixed(1), +z.toFixed(1), tn.id, e.id]); });
      [1, -1].forEach(function(sg){
        // under the ribbon's own edge: the drawn road over the drawn land
        var ix = cx + lx*sg*(half - 0.3), iz = cz + lz*sg*(half - 0.3), top = null, land = null;
        drawnAll(ix, iz).forEach(function(d){ if(d.kind === "terrain"){ if(land == null || d.y > land) land = d.y; } else if(d.kind === "walk" || d.kind === "asphalt"){ if(top == null || d.y > top) top = d.y; } });
        if(top != null && land != null){ edge.n++; if(top - land < -0.05) edge.under++; worst(edge, top - land, [+ix.toFixed(1), +iz.toFixed(1), tn.id, e.id]); }
        // a metre past the kerb: the drawn land under the road's edge
        var x = cx + lx*sg*(half + 1), z = cz + lz*sg*(half + 1); if(WD.roadY(W, x, z) != null) return;
        var ey = WD.roadY(W, cx + lx*sg*(half - 0.2), cz + lz*sg*(half - 0.2)), ty = null; if(ey == null) return;
        drawnAll(x, z).forEach(function(d){ if(d.kind === "terrain" && (ty == null || d.y > ty)) ty = d.y; });
        if(ty != null){ kerb.n++; worst(kerb, ey - ty, [+x.toFixed(1), +z.toFixed(1), tn.id, e.id]); }
      });
    } } });
out.ride = ride; out.grade = grade; out.edge = edge; out.kerb = kerb;
console.log(JSON.stringify(out));
"""


def scan(doc):
    r = subprocess.run([NODE, "-e", HARNESS % {"root": json.dumps(ROOT), "doc": json.dumps(doc)}], capture_output=True, text=True, timeout=900)
    if r.returncode:
        raise AssertionError(r.stderr[-4000:])
    return json.loads(r.stdout.strip().splitlines()[-1])


@unittest.skipUnless(NODE and os.path.exists(FIXTURE), "node or the v5 townships fixture missing")
class TownshipTerrain(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = scan(FIXTURE)

    def test_scanned_every_township(self):
        self.assertEqual(self.o["towns"], 64)
        self.assertGreater(self.o["tiles"], 40)
        self.assertGreater(self.o["ride"]["n"], 100000)
        self.assertGreater(self.o["edge"]["n"], 20000)

    def test_no_terrain_cliff_beside_a_township(self):
        s = self.o["slope"]
        self.assertLessEqual(s["max"], 0.75, "a drawn terrain triangle beside a township at (x, z, township) %s" % s["at"])

    def test_streets_keep_a_streets_grade(self):
        g = self.o["grade"]
        self.assertGreater(g["n"], 5000)
        self.assertLessEqual(g["max"], 0.12, "a street by a township at (x, z, township, edge) %s" % g["at"])

    def test_the_ride_is_on_the_drawn_road(self):
        r = self.o["ride"]
        self.assertEqual(r["none"], 0, "nothing drawn under a point of a road")
        self.assertLessEqual(abs(r["max"]), 0.6, "drawn road - the ride's ground (m) at (x, z, township, edge) %s" % r["at"])

    def test_no_road_on_a_wedge_or_buried(self):
        e, k = self.o["edge"], self.o["kerb"]
        self.assertEqual(e["under"], 0, "the land drawn over a road's edge")
        self.assertLessEqual(e["max"], 2.5, "a road's edge over the land under it at (x, z, township, edge) %s" % e["at"])
        self.assertLessEqual(k["max"], 3.0, "the land a metre past a kerb under it at (x, z, township, edge) %s" % k["at"])


if __name__ == "__main__":
    unittest.main()
