"""games/worldgeom.js + games/worldbuild.js for the v2 world (Cities build spec, task cl-mesh).

Node loads games/world.js and games/worldgeom.js against a `window` stub and builds the synthetic island doc
tests/fixtures/cities_island@2.json (concave blocks, lots and sites, a coast, min_tier on edges, blocks, lots and a
site tier) at every city tier. The checks: the inline earcut tiles the concave rings of
tests/fixtures/worldgeom_polys.json and every doc polygon exactly (triangle areas sum to the polygon's area, no
flipped or outside triangle); the ground buffers are sane; lots turn to their Q16 `front` and stay inside their ring,
else keep `facing`; terrain under the sea sinks under the water and a beach runs along the coast; the tier views drop
exactly the items above the tier; tierDiff names every tile that changes between two tiers (checked against full
rebuilds) and few more. claude-hq@1 is unchanged: every tile and product hashes to the digests captured from the code
before this task (tests/fixtures/worldgeom_at1.golden.json), with and without a tier. worldbuild.js runs under node
with the vendored three.js: the island's ground rides in the terrain meshes, the sea plane is there, a tier change
rebuilds only the tiles tierDiff names, the water phase is a function of the clock alone, and the @1 draw calls and
triangles at fixed cameras equal the golden ones. Skipped without node. Stdlib only."""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GEOM = os.path.join(ROOT, "games", "worldgeom.js")
BUILD = os.path.join(ROOT, "games", "worldbuild.js")
WORKER = os.path.join(ROOT, "games", "worldbuild-worker.js")
ISLAND = os.path.join(ROOT, "tests", "fixtures", "cities_island@2.json")
POLYS = os.path.join(ROOT, "tests", "fixtures", "worldgeom_polys.json")
AT1 = os.path.join(ROOT, "tests", "fixtures", "claude-hq@1.json.gz")
GOLDEN = os.path.join(ROOT, "tests", "fixtures", "worldgeom_at1.golden.json")
NODE = shutil.which("node")


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def node(src, module=False, timeout=900):
    args = [NODE, "--input-type=module", "-e", src] if module else [NODE, "-e", src]
    r = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise AssertionError("node harness failed:\n" + r.stderr[-4000:])
    return json.loads(r.stdout)


# Shared by both harnesses: load the pure files, pack a doc. pack() does not carry the v2 fields worldgeom reads
# from W yet (edge min_tier, Layers.island): packV2 adds them the way the integrator's world.js will.
COMMON = r"""
var fs = require("fs"), zlib = require("zlib"), crypto = require("crypto"), root = %(root)s;
global.window = global.window || {HQV: {}};
["world.js", "worldgeom.js"].forEach(function(f){ new Function(fs.readFileSync(root + "/games/" + f, "utf8"))(); });
var Q = window.HQV.world, G = window.HQV.worldgeom, NT = G.NT;
function packV2(doc){
  var W = Q.pack(doc), E = ((doc.layers || {}).roads || {}).edges || [];
  W.edges.forEach(function(e, i){ if(E[i] && E[i].min_tier != null) e.min_tier = E[i].min_tier; });
  if(doc.layers && doc.layers.island) W.island = doc.layers.island;
  return W;
}
function L(v){ var a = []; for(var i = 0; i < 16; i++) a.push(v); return a; }
var MIXED = [0,1,2,0, 1,2,0,1, 2,0,1,2, 0,1,2,0];
function digest(o){
  var h = crypto.createHash("sha1");
  (function walk(v){
    if(v && ArrayBuffer.isView(v)){ h.update(Buffer.from(v.buffer, v.byteOffset, v.byteLength)); return; }
    if(Array.isArray(v)){ v.forEach(walk); return; }
    if(v && typeof v === "object"){ Object.keys(v).sort().forEach(function(k){ h.update(k); walk(v[k]); }); return; }
    h.update(String(JSON.stringify(v)));
  })(o);
  return h.digest("hex");
}
// every tile, every product, every terrain LOD (and a mixed one): the @1 golden digests
function at1Digests(W, tier){
  var tiles = {}, all = crypto.createHash("sha1");
  for(var tz = 0; tz < NT; tz++) for(var tx = 0; tx < NT; tx++){
    var o = [[0, null], [1, ["terrain"]], [2, ["terrain"]], [-1, ["terrain"]]].map(function(v){
      var m = {tx: tx, tz: tz, lods: v[0] < 0 ? MIXED : L(v[0]), want: v[1] || ["terrain", "roads", "buildings0", "buildings1", "props"]};
      if(tier != null) m.tier = tier;
      var r = G.buildTile(W, m);
      delete r.tier;
      return r;
    });
    var d = digest(o);
    tiles[tx + "," + tz] = d; all.update(d);
  }
  return {all: all.digest("hex"), tiles: tiles};
}
"""

GEOM_HARNESS = COMMON + r"""
var doc = JSON.parse(fs.readFileSync(root + "/tests/fixtures/cities_island@2.json", "utf8"));
var W = packV2(doc), out = {}, bad = [];
function area2(P){ var s = 0; for(var k = 0; k < P.length; k++){ var a = P[k], b = P[(k + 1) % P.length]; s += a[0]*b[1] - b[0]*a[1]; } return s/2; }
function inPoly(P, x, z){
  var c = false;
  for(var k = 0, j = P.length - 1; k < P.length; j = k++){
    var a = P[k], b = P[j];
    if((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0])*(z - a[1])/(b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}
// triangulate a ring (cm or m): area sum, flipped and outside triangles
function tiling(ring){
  var flat = []; ring.forEach(function(p){ flat.push(p[0], p[1]); });
  var tri = G.triangulate(flat), sum = 0, signs = {}, outside = 0, A = area2(ring);
  for(var t = 0; t < tri.length; t += 3){
    var a = ring[tri[t]], b = ring[tri[t+1]], c = ring[tri[t+2]], s = area2([a, b, c]);
    sum += Math.abs(s);
    if(Math.abs(s) > 1e-9*Math.abs(A)) signs[s > 0 ? "+" : "-"] = 1;
    if(!inPoly(ring, (a[0] + b[0] + c[0])/3, (a[1] + b[1] + c[1])/3)) outside++;
  }
  return {n: ring.length, tris: tri.length/3, area: Math.abs(A), sum: sum, relErr: Math.abs(sum - Math.abs(A))/Math.abs(A),
          oneWinding: Object.keys(signs).length === 1, outside: outside};
}
var polys = JSON.parse(fs.readFileSync(root + "/tests/fixtures/worldgeom_polys.json", "utf8")).rings;
out.rings = {};
Object.keys(polys).forEach(function(k){ out.rings[k] = tiling(polys[k]); });
out.docPolys = [];
["blocks", "lots", "sites"].forEach(function(kind){
  (doc.layers[kind] || []).forEach(function(o){ if(o.poly){ var r = tiling(o.poly); r.kind = kind; r.id = o.id; out.docPolys.push(r); } });
});
out.degenerate = [G.triangulate([]).length, G.triangulate([0, 0, 1, 1]).length, G.triangulate([0, 0, 1, 0, 2, 0]).length];

// buffer sanity (as tests/test_worldgeom.py): lengths, index range, finite, colours 0..1, faces wound with normals
function check(name, g, terrain){
  var nv = g.pos.length/3;
  if(g.nrm.length !== g.pos.length || g.col.length !== g.pos.length) bad.push(name + ": attribute lengths");
  if(g.idx.length % 3) bad.push(name + ": idx not triangles");
  for(var i = 0; i < g.idx.length; i++) if(g.idx[i] >= nv){ bad.push(name + ": index out of range"); break; }
  for(i = 0; i < g.pos.length; i++){
    if(!isFinite(g.pos[i]) || !isFinite(g.nrm[i]) || !isFinite(g.col[i])){ bad.push(name + ": NaN"); break; }
    if(g.col[i] < 0 || g.col[i] > 1){ bad.push(name + ": colour out of range"); break; }
  }
  var wrong = 0;
  for(var t = 0; t < g.idx.length; t += 3){
    var a = g.idx[t], b = g.idx[t+1], c = g.idx[t+2], P = g.pos;
    var ux = P[3*b] - P[3*a], uy = P[3*b+1] - P[3*a+1], uz = P[3*b+2] - P[3*a+2], vx = P[3*c] - P[3*a], vy = P[3*c+1] - P[3*a+1], vz = P[3*c+2] - P[3*a+2];
    var nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx, l = Math.sqrt(nx*nx + ny*ny + nz*nz);
    if(!(l > 1e-9)) continue;
    if(terrain ? ny/l < -1e-3 : (nx*g.nrm[3*a] + ny*g.nrm[3*a+1] + nz*g.nrm[3*a+2])/l < 0) wrong++;
  }
  if(wrong) bad.push(name + ": " + wrong + " faces wound wrong");
}
function upArea(g){
  var s = 0, P = g.pos;
  for(var t = 0; t < g.idx.length; t += 3){
    var a = g.idx[t], b = g.idx[t+1], c = g.idx[t+2];
    var ny = (P[3*b+2] - P[3*a+2])*(P[3*c] - P[3*a]) - (P[3*b] - P[3*a])*(P[3*c+2] - P[3*a+2]);
    if(ny > 0) s += ny/2;
  }
  return s;
}

// ---- per tier: views, ground areas, buildings, every tile and product digested ----
var sea = G.seaY(W), TIERS = [1, 2, 3, 4, 5], per = {};
out.tiers = {};
TIERS.forEach(function(t){
  var V = G.view(W, t), items = G.groundItems(V), byKind = {};
  // each block / lot / site pad: its triangles' plan area is its ring's area
  var padErr = 0;
  items.forEach(function(it){
    byKind[it.kind] = (byKind[it.kind] || 0) + 1;
    var s = 0;
    for(var k = 0; k < it.tri.length; k += 3) s += Math.abs(area2([it.P[it.tri[k]], it.P[it.tri[k+1]], it.P[it.tri[k+2]]]));
    padErr = Math.max(padErr, Math.abs(s - Math.abs(area2(it.P)))/Math.abs(area2(it.P)));
  });
  var tiles = {}, groundArea = 0, itemArea = 0, bids = {}, b0 = {};
  items.forEach(function(it){ itemArea += Math.abs(area2(it.P)); });
  for(var tz = 0; tz < NT; tz++) for(var tx = 0; tx < NT; tx++){
    var k = tx + "," + tz, m = G.buildTile(W, {tx: tx, tz: tz, tier: t, lods: L(0), want: ["terrain", "roads", "ground", "buildings0", "buildings1", "props"]});
    var t2 = G.buildTile(W, {tx: tx, tz: tz, tier: t, lods: L(2), want: ["terrain"]}).terrain;
    check(t + " " + k + " ground", m.ground); check(t + " " + k + " terrain", m.terrain, true);
    check(t + " " + k + " body0", m.buildings0.body); check(t + " " + k + " body1", m.buildings1.body);
    ["asphalt", "marks", "kerb", "walk"].forEach(function(n){ check(t + " " + k + " " + n, m.roads[n]); });
    groundArea += upArea(m.ground);
    m.buildings1.body.bid.forEach(function(b){ bids[b] = 1; });
    tiles[k] = {terrain: digest([m.terrain, t2]), roads: digest(m.roads), ground: digest(m.ground),
                buildings: digest([m.buildings0, m.buildings1]), props: digest(m.props)};
    if(t === 5) b0[k] = m.buildings0;
  }
  per[t] = tiles;
  var want = function(L, site){ return (L || []).filter(function(o){ var mt = o.min_tier != null ? o.min_tier : (site ? o.tier : 0); return (mt || 0) <= t; }).map(function(o){ return o.id; }); };
  out.tiers[t] = {edges: V.edges.map(function(e){ return e.id; }), blocks: V.blocks.map(function(o){ return o.id; }), lots: V.lots.map(function(o){ return o.id; }),
                  sites: V.sites.map(function(o){ return o.id; }),
                  wantEdges: want(doc.layers.roads.edges), wantBlocks: want(doc.layers.blocks), wantLots: want(doc.layers.lots), wantSites: want(doc.layers.sites, true),
                  built: Object.keys(bids).map(Number).sort(function(a, b){ return a - b; }),
                  wantBuilt: V.lots.filter(function(l){ return l.kind === "building"; }).map(function(l){ return l.id; }).sort(function(a, b){ return a - b; }),
                  kinds: byKind, padErr: padErr, groundArea: groundArea, itemArea: itemArea, isBase: V === W};
  if(t === 5) out.b0 = b0;
});

// ---- tierDiff: sound (every changed tile is named) and cheap ----
out.diff = [];
TIERS.forEach(function(a){ TIERS.forEach(function(b){
  if(b <= a) return;
  var d = G.tierDiff(W, a, b), miss = [], changed = {}, named = 0;
  Object.keys(d).forEach(function(p){ named += d[p].length; });
  Object.keys(per[a]).forEach(function(k){
    Object.keys(per[a][k]).forEach(function(p){
      if(per[a][k][p] === per[b][k][p]) return;
      changed[p] = (changed[p] || 0) + 1;
      if(d[p].indexOf(k) < 0) miss.push(p + "@" + k);
    });
  });
  var rev = G.tierDiff(W, b, a);
  out.diff.push({a: a, b: b, miss: miss, changed: changed, named: named, sizes: Object.keys(d).map(function(p){ return d[p].length; }),
                 symmetric: JSON.stringify(rev) === JSON.stringify(d)});
}); });
out.diffSame = G.tierDiff(W, 3, 3);

// ---- lots: front (Q16) turns the building, else facing; detail-0 bodies inside their ring ----
(function(){
  var res = [];
  doc.layers.lots.forEach(function(l){
    if(l.kind !== "building") return;
    var t = G.tileOf(l.x/100, l.z/100), g = out.b0[t.tx + "," + t.tz].body, r = {id: l.id, front: !!l.front, poly: !!l.poly, verts: 0, outside: 0, offAxis: 0, doorWalls: 0};
    var P = l.poly ? l.poly.map(function(p){ return [p[0]/100, p[1]/100]; }) : null;
    var F = l.front ? [l.front[0]/65536, l.front[1]/65536] : null;
    if(F){ var fl = Math.hypot(F[0], F[1]); F = [F[0]/fl, F[1]/fl]; }
    for(var i = 0; i < g.bid.length; i++){
      if(g.bid[i] !== l.id) continue;
      r.verts++;
      var x = g.pos[3*i], z = g.pos[3*i+2], nx = g.nrm[3*i], ny = g.nrm[3*i+1], nz = g.nrm[3*i+2];
      if(P){
        // inside the ring, or within 0.2 m of it (porticos reach just past the 1 m inset)
        var inside = inPoly(P, x, z), dmin = Infinity;
        for(var k = 0; k < P.length; k++){
          var a = P[k], b = P[(k + 1) % P.length], ex = b[0] - a[0], ez = b[1] - a[1], tt = Math.max(0, Math.min(1, ((x - a[0])*ex + (z - a[1])*ez)/(ex*ex + ez*ez)));
          dmin = Math.min(dmin, Math.hypot(a[0] + ex*tt - x, a[1] + ez*tt - z));
        }
        if(!inside && dmin > 0.2) r.outside++;
      }
      if(Math.abs(ny) > 0.1) continue;   // walls only
      var ax = F || [0, 1], dot = nx*ax[0] + nz*ax[1], crs = nx*ax[1] - nz*ax[0];
      if(Math.min(Math.abs(dot), Math.abs(crs)) > 1e-3) r.offAxis++;
      if(dot > 0.999) r.doorWalls++;
    }
    res.push(r);
  });
  out.lots = res;
})();

// ---- the coast: terrain under the sea sinks under the water; a beach straddles the waterline ----
(function(){
  var under = 0, sunk = 0, worst = -1e9;
  for(var tz = 0; tz < NT; tz++) for(var tx = 0; tx < NT; tx++){
    [0, 2].forEach(function(lod){
      var g = G.terrainTile(W, tx, tz, L(lod)), n = 64/G.LOD_STEP[lod], per = (n + 1)*(n + 1) + 8*n;
      for(var c = 0; c < 16; c++) for(var v = 0; v < (n + 1)*(n + 1); v++){
        var i = c*per + v, x = g.pos[3*i], y = g.pos[3*i+1], z = g.pos[3*i+2];
        if(Q.heightAt(W, x, z) >= sea + 0.1) continue;
        under++;
        if(y <= sea - G.SEA_HIDE + 1e-6) sunk++; else worst = Math.max(worst, y - sea);
      }
    });
  }
  var beach = G.groundItems(W).filter(function(it){ return it.kind === "beach"; }), straddle = 0;
  beach.forEach(function(it){
    var ys = it.V.map(function(v){ return v[1]; });
    if(Math.max.apply(null, ys) > sea && Math.min.apply(null, ys) < sea) straddle++;
  });
  var coastLen = 0, C = doc.layers.island.coast;
  C.forEach(function(p, k){ var q = C[(k + 1) % C.length]; coastLen += Math.hypot(q[0] - p[0], q[1] - p[1])/100; });
  out.coast = {sea: sea, under: under, sunk: sunk, worst: worst, beach: beach.length, straddle: straddle, coastLen: coastLen,
               noCoast: G.seaY(Q.pack({})), at1Ground: null};
})();

// ---- claude-hq@1: byte-identical to the code before this task, with and without a tier ----
(function(){
  var W1 = Q.pack(JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/claude-hq@1.json.gz"))));
  out.at1 = {plain: at1Digests(W1, null), tier1: at1Digests(W1, 1).all, tier5: at1Digests(W1, 5).all,
             view: G.view(W1, 1) === W1, ground: G.hasGround(W1), groundItems: G.groundItems(W1).length,
             diff: G.tierDiff(W1, 1, 5), sea: G.seaY(W1)};
})();
out.bad = bad.slice(0, 20); out.badCount = bad.length;
process.stdout.write(JSON.stringify(out));
"""

# worldbuild under node with the vendored three.js: main-thread jobs (no Worker), no DOM.
BUILD_HARNESS = r"""
import { createRequire } from "module";
const require = createRequire(import.meta.url);
""" + COMMON + r"""
const THREE = await import(root + "/games/vendor/three-module.js");
new Function(fs.readFileSync(root + "/games/worldbuild.js", "utf8"))();
var B = window.HQV.worldbuild, out = {};
var jobs = [], realBuild = G.buildTile;
G.buildTile = function(W, m){ jobs.push({k: m.tx + "," + m.tz, want: (m.want || []).slice(), tier: m.tier}); return realBuild.apply(this, arguments); };
function tick(){ return new Promise(function(r){ setTimeout(r, 2); }); }
async function settle(wb, cam){
  for(var i = 0; i < 400; i++){ wb.update(cam); await tick(); wb.update(cam); if(wb.stats().pending === 0) return true; }
  return false;
}
var c = {THREE: THREE};
// the chunk LODs worldbuild picks for a tile from a settled camera (quality 2: lod scale 1)
function lodsAt(tx, tz, cam){
  var out = [], x0 = G.ORIGIN + tx*G.TILE, z0 = G.ORIGIN + tz*G.TILE;
  for(var cz = 0; cz < 4; cz++) for(var cx = 0; cx < 4; cx++) out.push(B.lodFor(Math.hypot(x0 + cx*64 + 32 - cam.x, z0 + cz*64 + 32 - cam.z), 1, null));
  return out;
}

// ---- the island: ground in the terrain meshes, the sea, tier changes ----
var doc = JSON.parse(fs.readFileSync(root + "/tests/fixtures/cities_island@2.json", "utf8")), W = packV2(doc);
var wb = B.create(c, W, {worker: false, tier: 1});
await wb.ready;
var cam = {x: 0, z: 0, mode: "near", time: 12.5};
out.settled = await settle(wb, cam);
var st1 = wb.stats(), ter = wb.terrainMeshes(), named = {};
wb.root.traverse(function(o){ if(o.name) named[o.name] = (named[o.name] || 0) + 1; });
var T44 = wb.root.children.filter(function(g){ return g.name === "tile 4,4"; })[0];
var tg = T44 && T44.children.filter(function(m){ return m.name === "terrain"; })[0];
out.island = {stats: st1, terrainMeshes: ter.length, groundMeshes: named.ground || 0, sea: !!wb.sea, seaY: wb.sea ? wb.sea.position.y : null,
              seaParent: wb.sea ? wb.sea.parent === wb.root : false, seaSpan: wb.sea ? wb.sea.geometry.parameters.width : 0,
              terrain44Tris: tg ? tg.geometry.index.count/3 : 0,
              terrain44Want: G.terrainTile(G.view(W, 1), 4, 4, lodsAt(4, 4, cam)).idx.length/3 + G.groundTile(G.view(W, 1), 4, 4).idx.length/3,
              ground44: G.groundTile(G.view(W, 1), 4, 4).idx.length/3,
              tier: wb.tier()};
// tier 1 -> 2: only what tierDiff names is rebuilt, each with the products it names
var d12 = G.tierDiff(W, 1, 2), want12 = {};
Object.keys(d12).forEach(function(p){ d12[p].forEach(function(k){ (want12[k] = want12[k] || {})[p] = 1; }); });
jobs = [];
out.setTierCount = wb.setTier(2);
out.setTierSame = wb.setTier(2);
out.settled2 = await settle(wb, cam);
var map = {terrain: "terrain", roads: "roads", ground: "ground", buildings0: "buildings", buildings1: "buildings", props: "props"}, extra = [], missing = [];
var got = {};
jobs.forEach(function(j){
  j.want.forEach(function(w){
    var p = map[w];
    (got[j.k] = got[j.k] || {})[p] = 1;
    if(j.tier !== 2) extra.push("tier " + j.tier + " " + j.k);
    if(!(want12[j.k] && want12[j.k][p]) && w !== "terrain" && w !== "buildings0") extra.push(p + "@" + j.k);
  });
});
Object.keys(want12).forEach(function(k){ Object.keys(want12[k]).forEach(function(p){ if(!(got[k] && got[k][p])) missing.push(p + "@" + k); }); });
out.tier12 = {jobs: jobs.length, tiles: Object.keys(got).length, extra: extra, missing: missing, named: Object.keys(want12).length};
// the rebuilt tile now matches a fresh tier-2 build
T44 = wb.root.children.filter(function(g){ return g.name === "tile 4,4"; })[0];
var b1 = T44 && T44.children.filter(function(m){ return m.name === "body1"; })[0];
var fresh = G.buildingTile(G.view(W, 2), 4, 4, 1).body;
out.tier12.body44 = {got: b1 ? b1.geometry.index.count : 0, want: fresh.idx.length};
// a tier change in the middle of the initial build: every stale job is redone at the new tier
var wb2 = B.create(c, W, {worker: false, tier: 1});
jobs = [];
wb2.setTier(5);
await wb2.ready;
out.midSettled = await settle(wb2, cam);
var T44b = wb2.root.children.filter(function(g){ return g.name === "tile 4,4"; })[0];
var b1b = T44b && T44b.children.filter(function(m){ return m.name === "body1"; })[0];
out.midTier = {got: b1b ? b1b.geometry.index.count : 0, want: G.buildingTile(G.view(W, 5), 4, 4, 1).body.idx.length,
               lastTier: jobs.length ? jobs[jobs.length - 1].tier : null};
// the water: a pure function of the clock; the same phase however the frames fall
var ph = [];
[1/30, 1/60, 1/144].forEach(function(dt){ var t = 0; while(t < 10 - 1e-9){ t += dt; } ph.push(B.waterPhase(t)); });
out.water = {phases: ph, wrap: [B.waterPhase(0), B.waterPhase(600), B.waterPhase(-1) > 0, B.waterPhase(NaN)], uniform: null};
wb.update({x: 0, z: 0, mode: "near", time: 42});
var p42 = B.waterPhase(42);
wb.update({x: 0, z: 0, mode: "near", time: 42});
out.water.repeat = B.waterPhase(42) === p42;
wb.destroy(); wb2.destroy();

// ---- claude-hq@1: draw calls and triangles at fixed cameras, the same as before ----
var W1 = Q.pack(JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/claude-hq@1.json.gz"))));
var wb1 = B.create(c, W1, {worker: false});
await wb1.ready;
out.at1 = {sea: !!wb1.sea, cams: {}};
for(const p of [[0, 0], [320, -706], [-1000, -1000], [600, 600]]){
  var cm = {x: p[0], z: p[1], mode: "near"};
  await settle(wb1, cm);
  wb1.update(cm);
  var s = wb1.stats();
  out.at1.cams[p.join(",")] = {drawCalls: s.drawCalls, triangles: s.triangles};
}
wb1.destroy();
process.stdout.write(JSON.stringify(out));
"""


def golden():
    return json.loads(read(GOLDEN))


@unittest.skipUnless(NODE, "node is not installed")
class WorldGeomPolyTest(unittest.TestCase):
    out = None

    @classmethod
    def setUpClass(cls):
        cls.out = node(GEOM_HARNESS.replace("%(root)s", json.dumps(ROOT)))

    def test_buffers_sane(self):
        self.assertEqual(self.out["badCount"], 0, self.out["bad"])

    def test_earcut_concave_rings(self):
        rings = self.out["rings"]
        self.assertGreaterEqual(len(rings), 8)
        for k, r in rings.items():
            self.assertLess(r["relErr"], 1e-9, (k, r))       # the triangles' areas sum to the ring's area
            self.assertTrue(r["oneWinding"], (k, r))         # no flipped triangle
            self.assertEqual(r["outside"], 0, (k, r))        # none outside the ring
        for k in ("square", "L", "U", "comb", "star", "hook", "L_cw"):
            self.assertEqual(rings[k]["tris"], rings[k]["n"] - 2, (k, rings[k]))
        self.assertEqual(self.out["degenerate"], [0, 0, 0])

    def test_earcut_doc_polygons(self):
        polys = self.out["docPolys"]
        self.assertGreaterEqual(len([p for p in polys if p["kind"] == "blocks"]), 5)
        self.assertGreater(len([p for p in polys if p["n"] > 4]), 5)   # concave rings, not just quads
        for p in polys:
            self.assertLess(p["relErr"], 1e-9, p)
            self.assertEqual(p["outside"], 0, p)

    def test_ground_areas(self):
        for t, r in self.out["tiers"].items():
            self.assertLess(r["padErr"], 1e-9, (t, r))
            # the ground tiles' upward plan area: every pavement, pad and beach quad, nothing twice
            self.assertAlmostEqual(r["groundArea"], r["itemArea"], delta=1e-4*r["itemArea"])
            self.assertGreater(r["kinds"].get("block", 0), 0, t)
            self.assertGreater(r["kinds"].get("beach", 0), 100, t)

    def test_tier_views(self):
        tiers = self.out["tiers"]
        for t, r in tiers.items():
            for k in ("edges", "blocks", "lots", "sites"):
                self.assertEqual(r[k], r["want" + k.capitalize()], (t, k))
            self.assertEqual(r["built"], r["wantBuilt"], t)   # one building per shown building lot, none for hidden ones
        self.assertLess(len(tiers["1"]["edges"]), len(tiers["5"]["edges"]))
        self.assertLess(len(tiers["1"]["lots"]), len(tiers["4"]["lots"]))
        self.assertLess(len(tiers["1"]["sites"]), len(tiers["2"]["sites"]))   # a site's `tier`
        self.assertTrue(tiers["5"]["isBase"])                                  # nothing hidden at 5: W itself
        self.assertFalse(tiers["1"]["isBase"])

    def test_tier_diff_sound_and_cheap(self):
        diffs = self.out["diff"]
        self.assertEqual(len(diffs), 10)
        for d in diffs:
            self.assertEqual(d["miss"], [], d)                 # every tile that changes is named
            self.assertTrue(d["symmetric"], d)
            self.assertGreater(sum(d["changed"].values()), 0, d)
            self.assertLess(max(d["sizes"]), 32, d)            # far from all 64 tiles
        adj = [d for d in diffs if d["b"] == d["a"] + 1]
        # one tier step names under 15% of the 5 x 64 tile products (the ring roads' lamps and trims move along
        # whole edges, so roads and props reach further than the items themselves)
        self.assertLessEqual(max(d["named"] for d in adj), 48, adj)
        self.assertEqual(self.out["diffSame"], {"terrain": [], "roads": [], "ground": [], "buildings": [], "props": []})

    def test_lots_turn_to_front(self):
        lots = {r["id"]: r for r in self.out["lots"]}
        fronted = [r for r in lots.values() if r["front"]]
        self.assertGreaterEqual(len(fronted), 6)
        for r in lots.values():
            self.assertGreater(r["verts"], 0, r)
            self.assertEqual(r["offAxis"], 0, r)               # walls along / across front (or the world axes)
            self.assertEqual(r["outside"], 0, r)               # inside the lot's ring
        for r in fronted:
            self.assertGreater(r["doorWalls"], 0, r)           # a wall faces the way the door does
        self.assertFalse(lots[9]["front"])                     # no front: facing, the @1 path

    def test_coast(self):
        c = self.out["coast"]
        self.assertEqual(c["sea"], 0)
        self.assertGreater(c["under"], 1000, c)
        self.assertEqual(c["sunk"], c["under"], c)             # every vertex below sea + 0.1 m is under the water
        self.assertGreater(c["beach"], 2*c["coastLen"]/8 - 1, c)   # dry + wet quads every <= 8 m of coast
        self.assertEqual(c["straddle"] + c["beach"]//2, c["beach"], c)   # the dry strips run down to the shore
        self.assertIsNone(c["noCoast"])

    def test_at1_unchanged(self):
        g = golden()["digests"]
        a = self.out["at1"]
        bad = [k for k, v in g["tiles"].items() if a["plain"]["tiles"].get(k) != v]
        self.assertEqual(bad, [])
        self.assertEqual(a["plain"]["all"], g["all"])
        self.assertEqual(a["tier1"], g["all"])
        self.assertEqual(a["tier5"], g["all"])
        self.assertTrue(a["view"])
        self.assertFalse(a["ground"])
        self.assertEqual(a["groundItems"], 0)
        self.assertEqual(a["diff"], {"terrain": [], "roads": [], "ground": [], "buildings": [], "props": []})
        self.assertIsNone(a["sea"])


@unittest.skipUnless(NODE, "node is not installed")
@unittest.skipUnless(os.path.exists(os.path.join(ROOT, "games", "vendor", "three-module.js")), "vendored three.js is missing")
class WorldBuildPolyTest(unittest.TestCase):
    out = None

    @classmethod
    def setUpClass(cls):
        cls.out = node(BUILD_HARNESS.replace("%(root)s", json.dumps(ROOT)), module=True)

    def test_island_ground_and_sea(self):
        o = self.out
        self.assertTrue(o["settled"])
        i = o["island"]
        self.assertEqual(i["groundMeshes"], 0)                 # the ground rides in the terrain meshes
        self.assertEqual(i["terrain44Tris"], i["terrain44Want"], i)
        self.assertGreater(i["ground44"], 0, i)
        self.assertTrue(i["sea"])
        self.assertTrue(i["seaParent"])
        self.assertEqual(i["seaY"], 0)
        self.assertEqual(i["seaSpan"], 3*2048)
        self.assertEqual(i["tier"], 1)

    def test_tier_change_rebuilds_only_named_tiles(self):
        o = self.out
        self.assertTrue(o["settled2"])
        self.assertGreater(o["setTierCount"], 0)
        self.assertLess(o["setTierCount"], 16)
        self.assertEqual(o["setTierSame"], 0)
        t = o["tier12"]
        self.assertEqual(t["extra"], [], t)
        self.assertEqual(t["missing"], [], t)
        self.assertEqual(t["tiles"], t["named"], t)
        self.assertEqual(t["body44"]["got"], t["body44"]["want"])
        self.assertTrue(o["midSettled"])
        self.assertEqual(o["midTier"]["got"], o["midTier"]["want"], o["midTier"])

    def test_water_frame_rate_independent(self):
        w = self.out["water"]
        self.assertAlmostEqual(w["phases"][0], w["phases"][1], places=6)
        self.assertAlmostEqual(w["phases"][0], w["phases"][2], places=6)
        self.assertEqual(w["wrap"][0], 0)
        self.assertEqual(w["wrap"][1], 0)                      # loops every 600 s, seamlessly
        self.assertTrue(w["wrap"][2])
        self.assertEqual(w["wrap"][3], 0)
        self.assertTrue(w["repeat"])

    def test_at1_draw_calls_unchanged(self):
        a = self.out["at1"]
        self.assertFalse(a["sea"])
        self.assertEqual(a["cams"], golden()["drawCalls"])


class SourceTest(unittest.TestCase):
    def test_house_rules(self):
        for p in (GEOM, BUILD, WORKER):
            src = read(p)
            self.assertNotRegex(src, r"Math\.random\(", p)
            self.assertNotRegex(src, r"Math\.min\(\s*1\s*,\s*dt\s*\*", p)   # frame-rate independence
            self.assertNotRegex(src, r"\b(let|const)\s", p)
            self.assertNotRegex(src, r"fetch\(|XMLHttpRequest|WebSocket|innerHTML", p)
        g = read(GEOM)
        # earcut is inline: no dependency
        self.assertIn("function triangulate(flat)", g)
        self.assertNotRegex(g, r"require\(|importScripts\(")
        # the earcut port carries its ISC copyright and permission notice, and the notice sits above the ported code
        for s in ("ISC License", "Copyright (c) 2016, Mapbox",
                  "provided that the above copyright notice", "THE SOFTWARE IS PROVIDED \"AS IS\""):
            self.assertIn(s, g)
        self.assertLess(g.index("Copyright (c) 2016, Mapbox"), g.index("function triangulate(flat)"))
        b = read(BUILD)
        for s in ("waterPhase(", "normal_fragment_maps", "wb.setTier = function", "Gm.tierDiff(", "mergeGeo([T.terrain, T.ground])"):
            self.assertIn(s, b)
        self.assertIn("tier: job.tier", b)
        self.assertRegex(read(WORKER), r"tier\?")

    def test_fixtures_shape(self):
        doc = json.loads(read(ISLAND))
        L = doc["layers"]
        self.assertEqual(doc["version"], 2)
        self.assertTrue(re.match(r"^user:[0-9a-f-]{36}@2$", doc["id"]))
        self.assertTrue(any(e.get("min_tier") for e in L["roads"]["edges"]))
        self.assertTrue(any(b.get("min_tier") for b in L["blocks"]))
        self.assertTrue(any(lot.get("min_tier") for lot in L["lots"]))
        self.assertTrue(any(s.get("tier", 0) > 1 for s in L["sites"]))
        self.assertGreaterEqual(len(L["island"]["coast"]), 16)
        self.assertIn("sea_cm", L["island"])
        self.assertTrue(json.loads(read(POLYS))["rings"])


if __name__ == "__main__":
    unittest.main()
