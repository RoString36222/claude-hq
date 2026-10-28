"""City Gen v4 phase 11 (HQ 3.34), the graphics pass on structures and lighting: games/worldgeom.js's decks, piers,
tunnels and cuttings and games/hqcityrail.js's City Line viaduct, under node on tests/fixtures/claude-hq@3.json.gz.

Checks: a steel expansion joint across every flyover's and ramp's deck at each of its pier lines (and on the City Line
over each of the doc's piers); two bearings between every pier's cap and the slab (and under every City Line cap); the
parapets' coping (proud of the parapet's outer face, its top still 0.9 m over the deck), a drip lip under the fascia;
lamp columns along the decks (lit heads, no more than 16 m apart along each flyover); downlights (lit, facing down)
under each flyover where it crosses the ring, low walls beside the ring there; the tunnel's luminaires (lit 1) and the
cuttings' wall lights (lit 2, night only) with the walls' panels and the drain at their foot; the City Line's lamps and
downlights in its one static mesh (aLit, on at night), still at most 5 draw calls and under 120k triangles; the road tiles
deterministic and their products unchanged (no new mesh key); @1 and @2 carry none of it. Skipped without node.
Stdlib only."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

HARNESS = r"""
var fs = require("fs"), zlib = require("zlib"), root = %(root)s;
global.window = {HQV: {}}; global.self = window;
["world", "citylife", "worldgeom"].forEach(function(f){ new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))(); });
var H = window.HQV.world, G = window.HQV.worldgeom, S = G.STRUCT, K = S.COL, out = {};
function doc(n){ return JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/" + n + ".json.gz"))); }
var W = H.pack(doc("claude-hq@3")), LIFT = G.LIFT;
var byId = {}; W.edges.forEach(function(e){ byId[e.id] = e; });
function pts(e){ var p = e.pts, o = []; for(var i = 0; i < p.length; i += 3) o.push([p[i]/100, p[i+1]/100, p[i+2]/100]); return o; }
function near(P, x, z){
  var best = {d: Infinity}, s = 0;
  for(var i = 0; i + 1 < P.length; i++){
    var a = P[i], b = P[i+1], ux = b[0] - a[0], uz = b[2] - a[2], L = Math.hypot(ux, uz), L2 = L*L;
    var t = L2 > 0 ? Math.max(0, Math.min(1, ((x - a[0])*ux + (z - a[2])*uz)/L2)) : 0, px = a[0] + ux*t, pz = a[2] + uz*t, d = Math.hypot(x - px, z - pz);
    if(d < best.d) best = {d: d, y: a[1] + (b[1] - a[1])*t, s: s + L*t, x: px, z: pz, dx: ux/(L || 1), dz: uz/(L || 1)};
    s += L;
  }
  return best;
}
function same(c, k){ return Math.abs(c[0] - k[0]) < 1e-4 && Math.abs(c[1] - k[1]) < 1e-4 && Math.abs(c[2] - k[2]) < 1e-4; }
var geoms = {};
function geomAt(tx, tz){ var k = tx + "," + tz; return geoms[k] || (geoms[k] = G.roadTile(W, tx, tz, false)); }
// every triangle of product `key` in the tile of (x, z) and its neighbours: fn(centroid, normal, colour, lit, plan-cover test)
function tris(key, x, z, fn){
  var t = G.tileOf(x, z);
  for(var dz = -1; dz <= 1; dz++) for(var dx = -1; dx <= 1; dx++){
    if(t.tx + dx < 0 || t.tz + dz < 0 || t.tx + dx >= G.NT || t.tz + dz >= G.NT) continue;
    var g = geomAt(t.tx + dx, t.tz + dz)[key];
    if(!g) continue;
    var p = g.pos, I = g.idx, n = g.nrm, c = g.col;
    for(var k = 0; k < I.length; k += 3){
      var a = 3*I[k], b = 3*I[k+1], d = 3*I[k+2];
      fn({x: (p[a] + p[b] + p[d])/3, y: (p[a+1] + p[b+1] + p[d+1])/3, z: (p[a+2] + p[b+2] + p[d+2])/3}, [n[a], n[a+1], n[a+2]], [c[a], c[a+1], c[a+2]],
         g.lit ? g.lit[I[k]] : 0, function(qx, qz){
           var D = (p[b+2] - p[d+2])*(p[a] - p[d]) + (p[d] - p[b])*(p[a+2] - p[d+2]);
           if(Math.abs(D) < 1e-12) return null;
           var l1 = ((p[b+2] - p[d+2])*(qx - p[d]) + (p[d] - p[b])*(qz - p[d+2]))/D, l2 = ((p[d+2] - p[a+2])*(qx - p[d]) + (p[a] - p[d])*(qz - p[d+2]))/D, l3 = 1 - l1 - l2;
           if(l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) return null;
           return l1*p[a+1] + l2*p[b+1] + l3*p[d+1];
         });
    }
  }
}
// is (x, z) covered by a triangle of `key` in colour col at y within tol (optionally lit / facing down)?
function covers(key, x, z, y, tol, col, want){
  var hit = false;
  tris(key, x, z, function(cn, n, c, lit, cov){
    if(hit || (col && !same(c, col)) || (want && !want(n, lit))) return;
    var yy = cov(x, z);
    if(yy != null && Math.abs(yy - y) <= tol) hit = true;
  });
  return hit;
}

// ---- expansion joints at the pier lines, bearings under the caps ----
var PI = H.piersOf(W);
out.joints = PI.filter(function(p){ return p.node == null; }).map(function(p){
  var deck = p.y1 + H.DECK.DEPTH;
  return [byId[p.edge].v4, covers("bridge", p.x, p.z, deck + LIFT + S.JOINT_UP, 0.06, K.joint)];
});
out.bearings = PI.map(function(p){
  var n = 0, lo = p.y1 - S.BEAR_H;
  tris("bridge", p.x, p.z, function(c, nn, col){
    if(same(col, K.bearing) && Math.hypot(c.x - p.x, c.z - p.z) < 4 && c.y > lo - 0.01 && c.y < p.y1 + 0.01) n++;
  });
  return n;
});

// ---- parapets: the coping proud of the body, its top 0.9 m over the deck; the drip lip under the fascia ----
var flyIds = W.edges.filter(function(e){ return e.v4 === "flyover"; }).map(function(e){ return e.id; });
out.coping = {n: 0, top: 0, proud: 0, drip: 0};
flyIds.forEach(function(id){
  var e = byId[id], P = pts(e), h = e.width/200, L = near(P, P[P.length - 1][0], P[P.length - 1][2]).s;
  for(var s = 30; s < L - 20; s += 10){
    var q = null, acc = 0;
    for(var i = 0; i + 1 < P.length; i++){ var seg = Math.hypot(P[i+1][0] - P[i][0], P[i+1][2] - P[i][2]); if(acc + seg >= s){ var t = (s - acc)/seg; q = {x: P[i][0] + (P[i+1][0] - P[i][0])*t, y: P[i][1] + (P[i+1][1] - P[i][1])*t, z: P[i][2] + (P[i+1][2] - P[i][2])*t, dx: (P[i+1][0] - P[i][0])/seg, dz: (P[i+1][2] - P[i][2])/seg}; break; } acc += seg; }
    if(!q || q.y - H.heightAt(W, q.x, q.z) < 4) continue;
    var lx = q.dz, lz = -q.dx;
    [-1, 1].forEach(function(sg){
      if(H.deckOver(W, q.x + lx*sg*(h + 1), q.z + lz*sg*(h + 1), 0) != null) return;
      out.coping.n++;
      var top = q.y + LIFT + S.FLY_PARA_H, o1 = h + 0.11, o2 = h + S.FLY_PARA_W + S.COPE_OVER/2;
      if(covers("bridge", q.x + lx*sg*o1, q.z + lz*sg*o1, top, 0.05, K.coping)) out.coping.top++;
      if(covers("bridge", q.x + lx*sg*o2, q.z + lz*sg*o2, top, 0.05, K.coping)) out.coping.proud++;
      var od = h + S.FLY_PARA_W - 0.05;
      if(covers("bridge", q.x + lx*sg*od, q.z + lz*sg*od, q.y - S.FLY_D - 0.12, 0.1, K.drip)) out.coping.drip++;
    });
  }
});

// ---- lamp columns along the decks: lit heads LAMP_H over the parapet, over the carriageway, at most 16 m apart ----
out.lamps = flyIds.map(function(id){
  var e = byId[id], P = pts(e), h = e.width/200, heads = [], bad = 0;
  var keys = {};
  P.forEach(function(p){ var t = G.tileOf(p[0], p[2]); keys[t.tx + "," + t.tz] = t; });
  Object.keys(keys).forEach(function(k){
    var g = geomAt(keys[k].tx, keys[k].tz).bridge;
    if(!g || !g.lit) return;
    for(var i = 0; i < g.lit.length; i++){
      if(g.lit[i] < 0.5) continue;
      var x = g.pos[3*i], y = g.pos[3*i+1], z = g.pos[3*i+2], c = near(P, x, z);
      if(c.d > h + 1 || y < c.y + 5) continue;    // (a head over this flyover)
      heads.push(c.s);
      if(Math.abs(y - (c.y + LIFT + S.FLY_PARA_H + S.LAMP_H - 0.15)) > 0.5 || c.d > h + 0.1 - S.LAMP_ARM + 0.5) bad++;
    }
  });
  heads.sort(function(a, b){ return a - b; });
  var u = [];
  heads.forEach(function(s){ if(!u.length || s - u[u.length - 1] > 2) u.push(s); });
  var gap = 0; for(var i = 0; i + 1 < u.length; i++) gap = Math.max(gap, u[i+1] - u[i]);
  return {n: u.length, gap: gap, bad: bad};
});

// ---- under each flyover where it crosses the ring: downlights (lit, facing down) and walls beside the ring ----
var ringE = W.edges.filter(function(e){ return e.cls === "ring"; });
out.under = flyIds.map(function(id){
  var F = pts(byId[id]), best = null;
  F.forEach(function(p){ ringE.forEach(function(r){ var q = near(pts(r), p[0], p[2]); if(!best || q.d < best.q.d) best = {p: p, q: q, r: r}; }); });
  var x = best.p[0], z = best.p[2], deck = best.p[1], lights = 0, walls = 0, ringY = best.q.y, rh = best.r.width/200;
  tris("bridge", x, z, function(c, n, col, lit){
    if(lit > 0.5 && n[1] < -0.9 && Math.hypot(c.x - x, c.z - z) < 12 && Math.abs(c.y - (deck - S.FLY_D - 0.02)) < 0.3) lights++;
    if(same(col, K.coping) && n[1] > 0.9 && Math.hypot(c.x - x, c.z - z) < 30 && Math.abs(c.y - (ringY + LIFT + S.UP_WALL)) < 0.4) {
      var q = near(pts(best.r), c.x, c.z);
      if(q.d > rh && q.d < rh + 1) walls++;
    }
  });
  return {lights: lights, walls: walls};
});

// ---- the tunnel's luminaires and the cuttings' wall lights, panels and drains ----
var T = H.tunnelsOf(W);
out.tun = T.map(function(t){
  var r = {kind: t.kind, lit1: 0, lit2: 0, lit2bad: 0, panel: 0, drain: 0}, ks = {};
  t.pts.forEach(function(p){ var q = G.tileOf(p[0], p[2]); ks[q.tx + "," + q.tz] = q; });
  Object.keys(ks).forEach(function(k){
    var g = geomAt(ks[k].tx, ks[k].tz).tunnel;
    if(!g) return;
    var I = g.idx, p = g.pos, n = g.nrm, c = g.col;
    for(var j = 0; j < I.length; j += 3){
      var a = 3*I[j], b = 3*I[j+1], d = 3*I[j+2], x = (p[a] + p[b] + p[d])/3, y = (p[a+1] + p[b+1] + p[d+1])/3, z = (p[a+2] + p[b+2] + p[d+2])/3;
      var q = near(t.pts, x, z);
      if(q.d > t.half + 0.5) continue;
      var lit = g.lit[I[j]], col = [c[a], c[a+1], c[a+2]];
      if(lit > 1.5){ r.lit2++; if(q.d < t.half - 0.6 || y < q.y + 2 || y > q.y + 5) r.lit2bad++; }
      else if(lit > 0.5) r.lit1++;
      if((same(col, K.panel) || same(col, K.panel2)) && Math.abs(n[a+1]) < 0.05 && q.d > t.half - 0.2) r.panel++;
      if(same(col, K.drain) && n[a+1] > 0.9 && Math.abs(y - q.y - LIFT) < 0.05) r.drain++;
    }
  });
  return r;
});

// ---- determinism, products, lit attribute ----
(function(){
  var lods = []; for(var i = 0; i < 16; i++) lods.push(i % 3);
  function digest(m){ var h = 2166136261 >>> 0; G.transferables(m).forEach(function(buf){ var u = new Uint8Array(buf); for(var i = 0; i < u.length; i++){ h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; } }); return h; }
  var W2 = H.pack(doc("claude-hq@3")), tiles = [];
  PI.slice(0, 2).forEach(function(p){ tiles.push(G.tileOf(p.x, p.z)); });
  T.forEach(function(t){ tiles.push(G.tileOf(t.pts[0][0], t.pts[0][2])); });
  out.det = tiles.map(function(t){
    var job = {id: 1, tx: t.tx, tz: t.tz, lods: lods, want: ["roads"]};
    return digest(G.buildTile(W, job)) === digest(G.buildTile(W, job)) && digest(G.buildTile(W, job)) === digest(G.buildTile(W2, job));
  });
  var keys = {}, litOk = true;
  for(var tz = 0; tz < G.NT; tz++) for(var tx = 0; tx < G.NT; tx++){
    var r = geomAt(tx, tz);
    keys[Object.keys(r).sort().join(",")] = 1;
    if(!r.bridge.lit || r.bridge.lit.length !== r.bridge.pos.length/3) litOk = false;
  }
  out.products = {keys: Object.keys(keys), litOk: litOk};
})();

// ---- @1 / @2: none of it ----
var PH11 = [K.coping, K.joint, K.bearing, K.drip, K.pole, K.panel, K.panel2, K.plinth, K.drain, K.fitting];
out.old = ["claude-hq@1", "claude-hq@2"].map(function(n){
  var V = H.pack(doc(n)), lit = 0, ph = 0, keys = {};
  for(var tz = 0; tz < G.NT; tz++) for(var tx = 0; tx < G.NT; tx++){
    var r = G.roadTile(V, tx, tz, false);
    Object.keys(r).forEach(function(k){
      keys[k] = 1;
      if(r[k].lit) lit++;
      var c = r[k].col;
      for(var i = 0; i < c.length; i += 3) if(PH11.some(function(q){ return same([c[i], c[i+1], c[i+2]], q); })) ph++;
    });
  }
  return {lit: lit, ph: ph, keys: Object.keys(keys).sort()};
});
process.stdout.write(JSON.stringify(out));
"""

# the City Line on the Commons, at night: joints and bearings over the doc's piers, its lights in the one static mesh
VIEW = r"""
import fs from 'fs'; import path from 'path'; import url from 'url'; import zlib from 'zlib';
const R0 = process.argv[2];
const THREE = await import(url.pathToFileURL(R0 + '/games/vendor/three-module.js').href);
globalThis.window = {HQV: {}}; globalThis.self = globalThis.window;
for (const f of ['world.js', 'hqride.js', 'hqcommute.js', 'hqrail.js', 'hqcityrail.js']) (new Function(fs.readFileSync(path.join(R0, 'games', f), 'utf8')))();
const H = window.HQV, WD = H.world, out = {};
const doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(R0, 'tests/fixtures/claude-hq@3.json.gz'))));
function one(night, strip){
  const d = JSON.parse(JSON.stringify(doc));
  if (strip) (d.layers.rail.lines || []).forEach(l => { delete l.piers; });
  const W = WD.pack(d), scene = new THREE.Scene(), c = {THREE, scene, mat: (col, o) => new THREE.MeshStandardMaterial(Object.assign({color: col}, o || {}))};
  const cl = H.hqCityRail.create(W, {seed: 's'}), vc = H.hqCityRail.view(c, cl, {W, ground: (x, z) => WD.groundAt(W, x, z), night: () => night});
  const calls = [];
  for (let t = 0; t < 600; t += 23) { vc.update(1.7e12 + t*1000, 0.016, {x: -300, z: -80}); calls.push(vc.drawCalls()); }
  let tris = 0, stat = null;
  scene.traverse(o => { if (o.isMesh && o.visible && o.geometry) { const g = o.geometry; tris += (g.index ? g.index.count : g.attributes.position.count)/3*(o.isInstancedMesh ? o.count : 1); if (o.name !== 'x' && g.attributes.color && !o.isInstancedMesh && !stat) stat = o; } });
  const P = vc.tools.piers(), g = stat.geometry, pos = g.attributes.position.array, col = g.attributes.color.array;
  const J = new THREE.Color(0x34373c), B = new THREE.Color(0x7b7f84);
  const same = (i, k) => Math.abs(col[3*i] - k.r) < 1e-4 && Math.abs(col[3*i+1] - k.g) < 1e-4 && Math.abs(col[3*i+2] - k.b) < 1e-4;
  const per = P.map(p => {
    let joint = 0, bear = 0;
    const ry = p.y1 + 2.4;
    for (let i = 0; i < pos.length/3; i++) {
      const d = Math.hypot(pos[3*i] - p.x, pos[3*i+2] - p.z), y = pos[3*i+1];
      if (d < 4.5 && same(i, J) && y > ry - 0.36 && y < ry - 0.30) joint++;
      if (d < 2.5 && same(i, B) && y > p.y1 - 0.26 && y < p.y1 + 0.01) bear++;
    }
    return [joint, bear];
  });
  const r = {calls: Math.max(...calls), tris, piers: P.length, per, lit: vc.tools.lit(), hasLitAttr: !!g.attributes.aLit};
  vc.dispose();
  return r;
}
out.night = one(true, false); out.day = one(false, false); out.fallback = one(true, true);
console.log(JSON.stringify(out));
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


def view():
    if "v" not in _CACHE:
        p = subprocess.run([NODE, "--input-type=module", "-e", VIEW, "x", ROOT], capture_output=True, text=True, timeout=300)
        if p.returncode != 0:
            raise AssertionError("node failed:\n" + p.stderr[-4000:])
        _CACHE["v"] = json.loads(p.stdout)
    return _CACHE["v"]


@unittest.skipUnless(NODE, "node is not installed")
class DeckStructures(unittest.TestCase):
    def test_expansion_joints_at_every_pier_line(self):
        J = run()["joints"]
        self.assertGreater(len(J), 15)
        self.assertEqual(sorted(set(k for k, _ in J)), ["flyover", "ramp"])
        self.assertEqual([j for j in J if not j[1]], [], "a joint across the deck over every pier")

    def test_bearings_under_every_cap(self):
        B = run()["bearings"]
        self.assertGreater(len(B), 15)
        for n in B:
            self.assertEqual(n, 16, "two pads, four sides each, between the cap and the slab")

    def test_parapet_coping_and_drip(self):
        c = run()["coping"]
        self.assertGreater(c["n"], 8)
        self.assertEqual(c["top"], c["n"], "the coping is the parapet's top, 0.9 m over the deck")
        self.assertEqual(c["proud"], c["n"], "and stands proud of its outer face")
        self.assertEqual(c["drip"], c["n"], "a drip lip under the fascia")

    def test_lamps_along_the_decks(self):
        for L in run()["lamps"]:
            self.assertGreaterEqual(L["n"], 4, L)
            self.assertLessEqual(L["gap"], 16.5, L)
            self.assertEqual(L["bad"], 0, L)

    def test_under_the_flyovers(self):
        U = run()["under"]
        self.assertGreaterEqual(len(U), 2)
        for u in U:
            self.assertGreaterEqual(u["lights"], 4, "downlights under the slab over the ring")
            self.assertGreater(u["walls"], 0, "low walls beside the ring under the deck")


@unittest.skipUnless(NODE, "node is not installed")
class TunnelFinish(unittest.TestCase):
    def test_lights_panels_and_drains(self):
        T = run()["tun"]
        self.assertEqual(sorted(t["kind"] for t in T), ["cutting", "cutting", "tunnel"])
        for t in T:
            self.assertGreater(t["panel"], 20, t)
            self.assertGreater(t["drain"], 20, t)
            if t["kind"] == "tunnel":
                self.assertGreater(t["lit1"], 100, "the ceiling luminaires")
                self.assertEqual(t["lit2"], 0)
            else:
                self.assertGreater(t["lit2"], 50, "the cutting's wall lights, night only")
                self.assertEqual(t["lit2bad"], 0, t)


@unittest.skipUnless(NODE, "node is not installed")
class Invariants(unittest.TestCase):
    def test_deterministic(self):
        d = run()["det"]
        self.assertGreaterEqual(len(d), 4)
        self.assertTrue(all(d), d)

    def test_no_new_products(self):
        p = run()["products"]
        self.assertEqual(p["keys"], ["asphalt,bridge,kerb,marks,tunnel,walk"])
        self.assertTrue(p["litOk"], "the @3 bridge geo carries one lit value per vertex")

    def test_old_worlds_untouched(self):
        for o in run()["old"]:
            self.assertEqual(o["lit"], 0)
            self.assertEqual(o["ph"], 0)
            self.assertNotIn("tunnel", o["keys"])


@unittest.skipUnless(NODE, "node is not installed")
class CityLineStructures(unittest.TestCase):
    def test_joints_and_bearings_over_the_doc_piers(self):
        n = view()["night"]
        self.assertGreater(n["piers"], 5)
        for joint, bear in n["per"]:
            self.assertGreaterEqual(joint, 8, "the plate across the deck")
            self.assertGreaterEqual(bear, 48, "two bearings under the soffit")

    def test_lights_in_the_static_mesh(self):
        v = view()
        self.assertTrue(v["night"]["hasLitAttr"])
        self.assertGreater(v["night"]["lit"]["verts"], 100)
        self.assertEqual(v["night"]["lit"]["on"], 1)
        self.assertEqual(v["day"]["lit"]["on"], 0)

    def test_fallback_without_the_doc_piers_unchanged(self):
        f = view()["fallback"]
        self.assertFalse(f["hasLitAttr"])
        self.assertEqual(f["lit"]["verts"], 0)
        for joint, bear in f["per"]:
            self.assertEqual((joint, bear), (0, 0))

    def test_budget(self):
        for k in ("night", "day", "fallback"):
            self.assertLessEqual(view()[k]["calls"], 5, k)
            self.assertLess(view()[k]["tris"], 120000, k)


if __name__ == "__main__":
    unittest.main()
