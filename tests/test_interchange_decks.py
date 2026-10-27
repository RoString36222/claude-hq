"""City Gen v4 phase 6 (HQ 3.29): an interchange's flyover and ramps on the client, games/world.js and games/worldgeom.js
under node on tests/fixtures/claude-hq@3.json.gz (the Commons: three trumpets where highways meet the ring road).

Checks: pack keeps a ramp's `oneway` and docOf gives it back (PACK_V bumped); the stacked surfaces (groundAt / roadY /
surfaceAt / nearestRoad with and without yNow: under the flyover where it crosses the ring the ring, at deck height
the deck, 7 m over it; a car climbing every ramp and flyover to its T, and down the loop under the flyover, stays on
its road all the way); decksOf and piersOf (memoised, deterministic; piers 25-30 m apart unless a span had to be
lengthened, none in any road that runs under the deck nor on water, under the deck's underside, 2 m or more of clear
height); blockedAt (a pier blocks at ground level and not on the deck above it, a parapet blocks beside the deck at
deck level and not on the ground); the tiles the decks cross carry the deck (slab underside, parapets, piers, the T on
its own slab), the terrain under a deck is never pushed up to it, no tree or prop stands on or under a deck or in a
pier; the ramps are marked one way, the flyover with a centre line, the expressways get a crash barrier on their
median; @1 and @2 have no decks and the stacked surfaces change nothing there. Skipped without node. Stdlib only."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

HARNESS = r"""
var fs = require("fs"), zlib = require("zlib"), root = %(root)s;
global.window = {HQV: {}};
["world", "worldgeom"].forEach(function(f){ new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))(); });
var H = window.HQV.world, G = window.HQV.worldgeom;
function doc(n){ return JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/" + n + ".json.gz"))); }
var D3 = doc("claude-hq@3"), W = H.pack(D3), out = {};
var byId = {}; W.edges.forEach(function(e){ byId[e.id] = e; });
function pts(e){ var p = e.pts, o = []; for(var i = 0; i < p.length; i += 3) o.push([p[i]/100, p[i+1]/100, p[i+2]/100]); return o; }
// the nearest point of a polyline [[x, y, z]] to (x, z): {d, y, s (m along it), x, z}
function near(P, x, z){
  var best = {d: Infinity}, s = 0;
  for(var i = 0; i + 1 < P.length; i++){
    var a = P[i], b = P[i+1], ux = b[0] - a[0], uz = b[2] - a[2], L = Math.hypot(ux, uz), L2 = L*L;
    var t = L2 > 0 ? Math.max(0, Math.min(1, ((x - a[0])*ux + (z - a[2])*uz)/L2)) : 0, px = a[0] + ux*t, pz = a[2] + uz*t, d = Math.hypot(x - px, z - pz);
    if(d < best.d) best = {d: d, y: a[1] + (b[1] - a[1])*t, s: s + L*t, x: px, z: pz};
    s += L;
  }
  return best;
}
// the point s m along a polyline: {x, y, z, dx, dz}
function along(P, s){
  for(var i = 0; i + 1 < P.length; i++){
    var a = P[i], b = P[i+1], L = Math.hypot(b[0] - a[0], b[2] - a[2]);
    if(s <= L || i + 2 === P.length){ var t = L > 0 ? Math.max(0, Math.min(1, s/L)) : 0;
      return {x: a[0] + (b[0] - a[0])*t, y: a[1] + (b[1] - a[1])*t, z: a[2] + (b[2] - a[2])*t, dx: (b[0] - a[0])/(L || 1), dz: (b[2] - a[2])/(L || 1)}; }
    s -= L;
  }
}
function plen(P){ var s = 0; for(var i = 0; i + 1 < P.length; i++) s += Math.hypot(P[i+1][0] - P[i][0], P[i+1][2] - P[i][2]); return s; }

// ---- data ----
var dv = H.docOf(W), dvE = {}; dv.layers.roads.edges.forEach(function(e){ dvE[e.id] = e; });
out.data = {packV: H.PACK_V, stepUp: H.STEP_UP,
  ramps: W.edges.filter(function(e){ return e.v4 === "ramp"; }).map(function(e){ return [e.oneway === true, dvE[e.id].oneway === true]; }),
  others: W.edges.filter(function(e){ return e.oneway; }).every(function(e){ return e.v4 === "ramp"; }),
  flyovers: W.edges.filter(function(e){ return e.v4 === "flyover"; }).map(function(e){ return [e.oneway === undefined, dvE[e.id].oneway === undefined]; }),
  roundTrip: JSON.stringify(H.pack(dv).edges.map(function(e){ return [e.id, !!e.oneway]; })) === JSON.stringify(W.edges.map(function(e){ return [e.id, !!e.oneway]; }))};

// ---- decks and piers ----
var DK = H.decksOf(W), PI = H.piersOf(W);
out.decks = {n: DK.length, memo: H.decksOf(W) === DK && H.piersOf(W) === PI,
  kinds: DK.map(function(d){ return byId[d.edge].v4; }),
  interior: DK.every(function(d){ return d.pts.slice(1, -1).every(function(p){ return p[1] - H.heightAt(W, p[0], p[2]) > H.DECK.ELEV; }); }),
  same: JSON.stringify(H.piersOf(H.pack(D3))) === JSON.stringify(PI)};
var flyIds = W.edges.filter(function(e){ return e.v4 === "flyover"; }).map(function(e){ return e.id; });
out.piers = {n: PI.length, perFly: flyIds.map(function(id){ return PI.filter(function(p){ return p.edge === id; }).length; }), bad: [], spans: [], long: []};
var nodes = {}; W.nodes.forEach(function(n){ nodes[n.id] = n; });
PI.forEach(function(p){
  var e = byId[p.edge], deckY = p.y1 + H.DECK.DEPTH, ign = {};
  ign[p.edge] = 1;
  if(p.node != null) W.edges.forEach(function(f){ if(f.a === p.node || f.b === p.node) ign[f.id] = 1; });
  if(!(p.r === 1 && p.y1 - p.y0 >= H.DECK.PIER_CLEAR - 1e-9 && Math.abs(p.y0 - H.heightAt(W, p.x, p.z)) < 1e-9)) out.piers.bad.push(["dims", p.edge, p.s]);
  // on the deck's centre line, under its surface
  var c = near(pts(e), p.x, p.z);
  if(c.d > 0.05 || Math.abs(c.y - deckY) > 0.05) out.piers.bad.push(["centre", p.edge, p.s, c.d, c.y, deckY]);
  // in no road that runs under the deck (its full width + 0.5 m from the column), never on water
  W.edges.forEach(function(f){
    if(ign[f.id]) return;
    var q = near(pts(f), p.x, p.z);
    if(q.d < f.width/200 + 0.5 + p.r - 1e-6 && q.y < p.y1) out.piers.bad.push(["road", p.edge, p.s, f.id, q.d]);
  });
  [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function(o){
    var x = p.x + o[0]*p.r, z = p.z + o[1]*p.r;
    if(H.riverAt(W, x, z) || H.waterAt(W, x, z)) out.piers.bad.push(["water", p.edge, p.s]);
  });
});
// spacing along each stretch: 25-30 m between piers, longer only where the spot 27.5 m on had a road under it
DK.forEach(function(d){
  var L = PI.filter(function(p){ return p.edge === d.edge && p.node == null; }).sort(function(a, b){ return a.s - b.s; });
  for(var i = 0; i + 1 < L.length; i++){
    var g = L[i+1].s - L[i].s;
    out.piers.spans.push(+g.toFixed(3));
    if(g > H.DECK.PIER_MAX + 1e-6){
      var q = along(d.pts, L[i].s + 27.5), blocked = W.edges.some(function(f){
        if(f.id === d.edge) return false;
        var n2 = near(pts(f), q.x, q.z);
        return n2.d < f.width/200 + 0.5 + 1 && n2.y < q.y - H.DECK.DEPTH;
      });
      out.piers.long.push([d.edge, +g.toFixed(2), blocked]);
    }
  }
});

// ---- the stacked surfaces where each flyover crosses the ring ----
var ringE = W.edges.filter(function(e){ return e.cls === "ring"; });
out.cross = flyIds.map(function(id){
  var F = pts(byId[id]), best = null;
  F.forEach(function(p){ ringE.forEach(function(r){ var q = near(pts(r), p[0], p[2]); if(!best || q.d < best.q.d) best = {p: p, q: q}; }); });
  var x = best.p[0], z = best.p[2], deck = best.p[1], ring = best.q.y, nr = H.nearestRoad(W, x, z, 20), nrUp = H.nearestRoad(W, x, z, 20, deck), nrDn = H.nearestRoad(W, x, z, 20, ring);
  return {off: best.q.d, deck: deck, ring: ring, g: H.groundAt(W, x, z), gDeck: H.groundAt(W, x, z, false, deck), gRing: H.groundAt(W, x, z, false, ring),
          rY: H.roadY(W, x, z), rYDeck: H.roadY(W, x, z, deck), sDeck: H.surfaceAt(W, x, z, deck), s: H.surfaceAt(W, x, z),
          street: H.streetAt(W, x, z), nrUp: nrUp && nrUp.edge, nrDn: nrDn && byId[nrDn.edge].cls, fly: id,
          // the piers: one blocks at ground level, not on the deck over it
          pier: PI.filter(function(p){ return p.edge === id && p.node == null; }).slice(0, 3).map(function(p){
            var dy = p.y1 + H.DECK.DEPTH;
            return [H.blockedAt(W, p.x + 0.3, p.z), H.blockedAt(W, p.x + 0.3, p.z, p.y0 + 0.5), H.blockedAt(W, p.x + 0.3, p.z, dy), H.blockedAt(W, p.x + 1.5, p.z)];
          })};
});

// ---- a car on every ramp and flyover, step by step with yNow, from the ground up to the T (and the loop down) ----
function drive(P, from, to){
  var L = plen(P), y = null, worst = 0, at = null, n = 0;
  for(var s = from; s <= to; s += 1){
    var q = along(P, s);
    y = H.groundAt(W, q.x, q.z, false, y == null ? q.y : y);   // (it starts on the road)
    var d = Math.abs(y - q.y);
    if(d > worst){ worst = d; at = [+s.toFixed(1), +q.y.toFixed(2), +y.toFixed(2)]; }
    n++;
  }
  return {worst: worst, at: at, n: n, top: y};
}
out.drive = [];
W.edges.forEach(function(e){
  if(e.v4 !== "ramp" && e.v4 !== "flyover") return;
  var P = pts(e), L = plen(P), up = P[P.length - 1][1] > P[0][1];
  // (the first and last 20 m are junctions: their surface blends with the roads meeting there)
  if(up) out.drive.push([e.id, e.v4, "up", drive(P, 20, L - 5)]);
  var R = P.slice().reverse();
  if(!up && P[0][1] - H.heightAt(W, P[0][0], P[0][2]) > 3) out.drive.push([e.id, e.v4, "climb the loop", drive(R, 20, L - 5)]);
});

// ---- parapets: at deck level beside a flyover's high deck you are blocked, on it you are not ----
out.parapet = [];
flyIds.forEach(function(id){
  var e = byId[id], P = pts(e), L = plen(P), h = e.width/200;
  for(var s = 30; s < L - 20; s += 10){
    var q = along(P, s);
    if(q.y - H.heightAt(W, q.x, q.z) < 4) continue;
    var lx = q.dz, lz = -q.dx;
    [-1, 1].forEach(function(sg){
      var on = [q.x + lx*sg*(h - 0.5), q.z + lz*sg*(h - 0.5)], off = [q.x + lx*sg*(h + 1), q.z + lz*sg*(h + 1)];
      // (not where another deck runs beside it)
      if(H.deckOver(W, off[0], off[1], 0) != null) return;
      out.parapet.push([id, +s.toFixed(0), H.blockedAt(W, on[0], on[1], q.y), H.blockedAt(W, off[0], off[1], q.y),
        H.groundAt(W, on[0], on[1], false, q.y) - q.y, H.blockedAt(W, off[0], off[1], H.groundAt(W, off[0], off[1]))]);
    });
  }
});

// ---- geometry ----
var LIFT = G.LIFT, tilesHit = {}, geoms = {};
DK.forEach(function(d){ d.pts.forEach(function(p){ var t = G.tileOf(p[0], p[2]); tilesHit[t.tx + "," + t.tz] = 1; }); });
for(var tz = 0; tz < G.NT; tz++) for(var tx = 0; tx < G.NT; tx++) geoms[tx + "," + tz] = G.roadTile(W, tx, tz, false);
function verts(g, fn){ var p = g.pos; for(var i = 0; i < p.length; i += 3) fn(p[i], p[i+1], p[i+2]); }
// does a triangle of product `key` (in the tile of (x, z) or a neighbour: a piece belongs to the tile of its midpoint)
// cover (x, z) in plan at a height within tol of y?
function covers(key, x, z, y, tol){
  var t = G.tileOf(x, z);
  for(var dz = -1; dz <= 1; dz++) for(var dx = -1; dx <= 1; dx++){
    var g = geoms[(t.tx + dx) + "," + (t.tz + dz)];
    g = g && g[key];
    if(!g) continue;
    var p = g.pos, I = g.idx;
    for(var k = 0; k < I.length; k += 3){
      var a = 3*I[k], b = 3*I[k+1], c = 3*I[k+2];
      var d = (p[b+2] - p[c+2])*(p[a] - p[c]) + (p[c] - p[b])*(p[a+2] - p[c+2]);
      if(Math.abs(d) < 1e-12) continue;
      var l1 = ((p[b+2] - p[c+2])*(x - p[c]) + (p[c] - p[b])*(z - p[c+2]))/d, l2 = ((p[c+2] - p[a+2])*(x - p[c]) + (p[a] - p[c])*(z - p[c+2]))/d, l3 = 1 - l1 - l2;
      if(l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      if(Math.abs(l1*p[a+1] + l2*p[b+1] + l3*p[c+1] - y) <= tol) return true;
    }
  }
  return false;
}
out.geo = {tiles: Object.keys(tilesHit).map(function(k){ return [k, geoms[k].bridge ? geoms[k].bridge.idx.length/3 : 0]; })};
// at each flyover's ring crossing: slab underside 1.5 m under the deck, parapet tops 0.9 m over it
out.geo.cross = out.cross.map(function(c){
  var F = pts(byId[c.fly]), x = null, z = null, best = Infinity, h = byId[c.fly].width/200;
  F.forEach(function(p){ ringE.forEach(function(r){ var n2 = near(pts(r), p[0], p[2]); if(n2.d < best){ best = n2.d; x = p[0]; z = p[2]; } }); });
  var q = near(F, x, z), dir = along(F, q.s), lx = dir.dz, lz = -dir.dx;
  return [covers("bridge", x, z, c.deck - 1.5, 0.05),
          covers("bridge", x + lx*(h + 0.11), z + lz*(h + 0.11), c.deck + LIFT + 0.9, 0.05) && covers("bridge", x - lx*(h + 0.11), z - lz*(h + 0.11), c.deck + LIFT + 0.9, 0.05),
          covers("asphalt", x, z, c.deck + LIFT, 0.05), covers("asphalt", x, z, c.ring + LIFT, 0.3), covers("marks", x, z, c.deck + G.MARK_LIFT, 0.05)];
});
// every pier drawn: a column vertex at its foot (0.5 m in the ground) in its tile's bridge geo
out.geo.piers = PI.map(function(p){
  var t = G.tileOf(p.x, p.z), k = t.tx + "," + t.tz, g = geoms[k] || (geoms[k] = G.roadTile(W, t.tx, t.tz, false)), n = 0;
  verts(g.bridge, function(vx, vy, vz){ if(Math.abs(vy - (p.y0 - 0.5)) < 0.01 && Math.abs(Math.hypot(vx - p.x, vz - p.z) - 1.0824) < 0.01) n++; });
  return n;
});
// the T junctions (elevated ramps nodes): their patch at deck height, a slab under it
out.geo.T = W.nodes.filter(function(n){ return n.junction === "ramps" && n.y/100 - H.heightAt(W, n.x/100, n.z/100) > 3; }).map(function(n){
  var x = n.x/100, y = n.y/100, z = n.z/100, t = G.tileOf(x, z), k = t.tx + "," + t.tz, g = geoms[k] || (geoms[k] = G.roadTile(W, t.tx, t.tz, false));
  var top = 0, slab = 0;
  verts(g.asphalt, function(vx, vy, vz){ if(Math.hypot(vx - x, vz - z) < 0.01 && Math.abs(vy - y - LIFT) < 0.05) top++; });
  verts(g.bridge, function(vx, vy, vz){ if(Math.hypot(vx - x, vz - z) < 0.01 && Math.abs(vy - (y - 1.5)) < 0.05) slab++; });
  return [top, slab];
});
// the terrain under a deck is never pushed up to it
out.geo.terrain = {n: 0, bad: []};
Object.keys(tilesHit).forEach(function(k){
  var t = k.split(","), L = []; for(var i = 0; i < 16; i++) L.push(0);
  var g = G.terrainTile(W, +t[0], +t[1], L);
  verts(g, function(vx, vy, vz){
    var over = H.deckOver(W, vx, vz, 0);
    if(over == null) return;
    out.geo.terrain.n++;
    if(vy > H.heightAt(W, vx, vz) + 0.3) out.geo.terrain.bad.push([vx, vy, vz, over]);
  });
});
// markings: no paint on a ramp's centre line (one way), the flyover's centre line painted
out.geo.marks = W.edges.filter(function(e){ return e.v4 === "ramp" || e.v4 === "flyover"; }).map(function(e){
  var P = pts(e), L = plen(P), hit = 0, edges = 0, tried = 0, cw = e.width/200 - 1;
  for(var s = 30; s < L - 30; s += 7){
    var q = along(P, s), lx = q.dz, lz = -q.dx;
    tried++;
    if(covers("marks", q.x, q.z, q.y + G.MARK_LIFT, 0.1)) hit++;
    // (an edge line is 0.15 m wide: on a 30 m loop the polyline's own offset can miss its middle by a few cm, and a
    // ribbon's stations cut a corner where its points are closer than worldgeom's MINSEG)
    var side = function(sg){ return [0, 0.05, -0.05].some(function(d){ var o = sg*(cw + d); return covers("marks", q.x + lx*o, q.z + lz*o, q.y + G.MARK_LIFT, 0.1); }); };
    if(side(1) && side(-1)) edges++;
  }
  return [e.v4, hit, tried, edges];
});
// an expressway's median barrier: concrete ~0.8 m over the ring at its centre line
out.geo.barrier = (function(){
  var r = ringE[0], P = pts(r), L = plen(P), hit = 0, tried = 0;
  for(var s = 40; s < L - 40; s += 25){
    var q = along(P, s);
    tried++; if(covers("kerb", q.x, q.z, q.y + LIFT + 0.81, 0.15)) hit++;
  }
  return [hit, tried];
})();
// no tree, lamp, sign, parked car, gantry or furniture on or under a deck or in a pier
out.props = {n: 0, bad: []};
function clear(kind, x, z){
  out.props.n++;
  if(H.deckOver(W, x, z, 0) != null) out.props.bad.push([kind, x, z, "deck"]);
  PI.forEach(function(p){ if(Math.hypot(x - p.x, z - p.z) < p.r + 0.5) out.props.bad.push([kind, x, z, "pier"]); });
}
H.trees(W).forEach(function(t){ clear("tree", t.x, t.z); });
for(var tz = 0; tz < G.NT; tz++) for(var tx = 0; tx < G.NT; tx++){
  var P = G.props(W, tx, tz);
  ["lamps", "parked", "signs", "gantries", "furniture"].forEach(function(k){ (P[k] || []).forEach(function(o){ clear(k, o.x, o.z); }); });
}

// ---- @1 / @2: no decks, and yNow changes nothing ----
out.old = ["claude-hq@1", "claude-hq@2"].map(function(n){
  var V = H.pack(doc(n)), diff = 0, k = 0;
  for(var i = 0; i < 4000; i++){
    var x = ((i*7919) % 1800) - 900 + 0.31, z = ((i*104729) % 1800) - 900 + 0.77, g = H.groundAt(V, x, z);
    [g, g + 0.5, g - 3, g + 9].forEach(function(yn){
      k++;
      if(H.groundAt(V, x, z, false, yn) !== g || H.surfaceAt(V, x, z, yn) !== H.surfaceAt(V, x, z) || H.blockedAt(V, x, z, yn) !== H.blockedAt(V, x, z)) diff++;
    });
  }
  return {decks: H.decksOf(V).length, piers: H.piersOf(V).length, oneway: V.edges.some(function(e){ return "oneway" in e; }), diff: diff, k: k};
});
process.stdout.write(JSON.stringify(out));
"""

_CACHE = {}


def run():
    if "o" not in _CACHE:
        src = HARNESS.replace("%(root)s", json.dumps(ROOT))
        p = subprocess.run([NODE, "-e", src], capture_output=True, text=True, timeout=900)
        if p.returncode != 0:
            raise AssertionError("node failed:\n" + p.stderr[-4000:])
        _CACHE["o"] = json.loads(p.stdout)
    return _CACHE["o"]


@unittest.skipUnless(NODE, "node is not installed")
class InterchangeDecks(unittest.TestCase):
    def test_pack_keeps_oneway(self):
        d = run()["data"]
        self.assertGreaterEqual(d["packV"], 5)
        self.assertEqual(d["stepUp"], 1.0)
        self.assertGreaterEqual(len(d["flyovers"]), 2)
        self.assertEqual(len(d["ramps"]), 4*len(d["flyovers"]))
        self.assertTrue(all(r == [True, True] for r in d["ramps"]), d["ramps"])
        self.assertTrue(d["others"])
        self.assertTrue(all(f == [True, True] for f in d["flyovers"]))
        self.assertTrue(d["roundTrip"])

    def test_decks_and_piers_memoised(self):
        o = run()
        self.assertGreaterEqual(o["decks"]["n"], 4)
        self.assertTrue(o["decks"]["memo"])
        self.assertTrue(o["decks"]["same"], "piers differ between two packs of the same doc")
        self.assertTrue(set(o["decks"]["kinds"]) <= {"flyover", "ramp"})
        self.assertTrue(o["decks"]["interior"])
        self.assertGreater(o["piers"]["n"], 5)
        self.assertTrue(all(n >= 3 for n in o["piers"]["perFly"]), o["piers"]["perFly"])

    def test_piers_spacing_and_clear_of_roads_and_water(self):
        p = run()["piers"]
        self.assertEqual(p["bad"], [])
        self.assertTrue(p["spans"])
        for g in p["spans"]:
            self.assertGreaterEqual(g, 25 - 1e-6)
        short = [g for g in p["spans"] if g <= 30 + 1e-6]
        self.assertGreater(len(short), len(p["spans"])//2)
        # every lengthened span is one where the spot 27.5 m on stood in a road under the deck (the flyover over the ring)
        self.assertTrue(p["long"], "a flyover's span over the ring should be lengthened")
        for e, g, blocked in p["long"]:
            self.assertTrue(blocked, (e, g))

    def test_stacked_surfaces_at_the_ring_crossing(self):
        for c in run()["cross"]:
            self.assertLess(c["off"], 2, c)
            self.assertGreaterEqual(c["deck"] - c["ring"], 6.95, c)
            # without yNow: the ring under the flyover, never the deck
            self.assertAlmostEqual(c["g"], c["ring"], delta=0.3)
            self.assertAlmostEqual(c["rY"], c["ring"], delta=0.3)
            self.assertAlmostEqual(c["street"], c["ring"], delta=0.3)
            self.assertEqual(c["s"], "road")
            # with yNow at deck height: the deck; with the ring's height: the ring
            self.assertAlmostEqual(c["gDeck"], c["deck"], delta=0.05)
            self.assertAlmostEqual(c["rYDeck"], c["deck"], delta=0.05)
            self.assertEqual(c["sDeck"], "road")
            self.assertAlmostEqual(c["gRing"], c["ring"], delta=0.3)
            self.assertEqual(c["nrUp"], c["fly"])
            self.assertEqual(c["nrDn"], "ring")

    def test_driving_up_every_ramp_and_flyover_stays_on_it(self):
        d = run()["drive"]
        self.assertGreaterEqual(len(d), 4)
        self.assertTrue(any(r[2] == "climb the loop" for r in d))
        for eid, kind, how, r in d:
            self.assertLess(r["worst"], 0.25, (eid, kind, how, r))
            self.assertGreater(r["n"], 50)

    def test_piers_block_at_ground_level_only(self):
        for c in run()["cross"]:
            self.assertTrue(c["pier"])
            for ground, low, deck, beside in c["pier"]:
                self.assertTrue(ground)
                self.assertTrue(low)
                self.assertFalse(deck)
                self.assertFalse(beside)

    def test_parapets_block_at_deck_level(self):
        P = run()["parapet"]
        self.assertGreater(len(P), 8)
        for eid, s, on, off, dy, offGround in P:
            self.assertFalse(on, (eid, s))
            self.assertTrue(off, (eid, s))
            self.assertAlmostEqual(dy, 0, delta=0.05)
        # on the ground beside the deck nothing changes
        self.assertGreater(sum(1 for r in P if not r[5]), len(P)*0.8)

    def test_deck_geometry(self):
        g = run()["geo"]
        self.assertTrue(g["tiles"])
        self.assertTrue(all(n > 0 for _, n in g["tiles"]), g["tiles"])
        for under, para, top, ring, mark in g["cross"]:
            self.assertTrue(under, "the slab's underside 1.5 m under the deck")
            self.assertTrue(para, "a parapet 0.9 m high on both sides")
            self.assertTrue(top, "the asphalt at deck height")
            self.assertTrue(ring, "and the ring's asphalt under it")
            self.assertTrue(mark, "the flyover's centre line")
        self.assertTrue(all(n >= 2 for n in g["piers"]), g["piers"])
        self.assertEqual(len(g["T"]), len(run()["cross"]))
        for top, slab in g["T"]:
            self.assertGreater(top, 0)
            self.assertGreater(slab, 0)

    def test_terrain_under_decks_not_raised(self):
        t = run()["geo"]["terrain"]
        self.assertGreater(t["n"], 50)
        self.assertEqual(t["bad"], [])

    def test_markings_and_barrier(self):
        g = run()["geo"]
        for kind, hit, tried, edges in g["marks"]:
            self.assertGreater(tried, 3)
            self.assertGreaterEqual(edges, 0.85*tried, "white edge lines both sides")
            if kind == "ramp":
                self.assertEqual(hit, 0, "a ramp is one way: no centre line")
            else:
                self.assertEqual(hit, tried, "the flyover's centre line")
        hit, tried = g["barrier"]
        self.assertGreater(tried, 5)
        self.assertGreaterEqual(hit, tried - 1)

    def test_no_props_on_decks_or_piers(self):
        p = run()["props"]
        self.assertGreater(p["n"], 1000)
        self.assertEqual(p["bad"], [])

    def test_old_worlds_unchanged(self):
        for o in run()["old"]:
            self.assertEqual(o["decks"], 0)
            self.assertEqual(o["piers"], 0)
            self.assertFalse(o["oneway"])
            self.assertEqual(o["diff"], 0)
            self.assertEqual(o["k"], 16000)


if __name__ == "__main__":
    unittest.main()
