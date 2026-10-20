"""The river on the client (HQ 3.1, docs/plans/nav-river-spec.md "Client: the river").

Node loads games/world.js, worldgeom.js, ocean.js, hqcivic.js and hqboat.js against a stub `window` and runs
them on two river fixtures cut from generated docs (tests/fixtures/river_island.json, river_commons.json: each
names its window in `_cut`). The checks: the river's water is not land (walking and driving stop at the bank),
a bridge deck is land at deck height (groundAt there is the deck) and only from the tier it opens in, a hull
passes under a bridge, the dock and port berths sit on the river, a jet ski leaves the river dock and sails
down the river under the bridges to the sea, no tree stands in the water; the water mesh covers river.poly at
sea level, face up; bridges are decks with railings over the water and no ribbon or verge wall hangs down to
the riverbed; the beach does not cross the river's mouth and the banks run along it. worldbuild.js then builds
the island fixture with the vendored three.js: no tile fails, a river adds at most 3 draw calls per tile, and the
river wears the mounted ocean's material. Skipped without node. Stdlib only."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
FIXTURES = ("river_island", "river_commons")


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def node(src, module=False, timeout=600):
    args = [NODE, "--input-type=module", "-e", src] if module else [NODE, "-e", src]
    r = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise AssertionError("node harness failed:\n" + r.stderr[-4000:])
    return json.loads(r.stdout.strip().splitlines()[-1])


COMMON = r"""
var fs = require("fs"), root = %(root)s;
globalThis.window = globalThis.window || {HQV: {}};
["world.js", "worldgeom.js", "ocean.js", "hqcivic.js", "hqboat.js"].forEach(function(f){ new Function(fs.readFileSync(root + "/games/" + f, "utf8"))(); });
var H = window.HQV, Q = H.world, G = H.worldgeom, O = H.ocean, BT = H.hqboat;
function load(name){ return JSON.parse(fs.readFileSync(root + "/tests/fixtures/" + name + ".json", "utf8")); }
function inPoly(P, x, z){
  var c = false;
  for(var k = 0, j = P.length - 1; k < P.length; j = k++){
    var a = P[k], b = P[j];
    if((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0])*(z - a[1])/(b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}
function wrapPi(a){ return Math.atan2(Math.sin(a), Math.cos(a)); }
"""

PURE = COMMON + r"""
var out = {};
%(fixtures)s.forEach(function(name){
  var doc = load(name), W = Q.pack(doc), D = Q.docOf(W), sea = O.seaOf(D), R = O.riverOf(D), r = {};
  var Rv = doc.layers.river, seaY = doc.layers.island.sea_cm/100, poly = Rv.poly.map(function(p){ return [p[0]/100, p[1]/100]; });
  var coast = doc.layers.island.coast.map(function(p){ return [p[0]/100, p[1]/100]; });
  var bridges = W.edges.filter(function(e){ return e.bridge; });
  r.packed = {river: W.river === doc.layers.river, bridges: bridges.length,
              docOf: D.layers.river === doc.layers.river && D.layers.roads.edges.filter(function(e){ return e.bridge; }).length};
  // the water: every centreline point and a grid over the poly, away from the bridge decks
  var water = 0, waterLand = 0, waterBoat = 0, riverAtMiss = 0;
  function onDeck(x, z){ return R.onDeck(x, z, null); }
  var bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
  poly.forEach(function(p){ bx0 = Math.min(bx0, p[0]); bx1 = Math.max(bx1, p[0]); bz0 = Math.min(bz0, p[1]); bz1 = Math.max(bz1, p[1]); });
  var pts = Rv.center.map(function(p){ return [p[0]/100, p[1]/100]; });
  for(var x = bx0; x <= bx1; x += 3) for(var z = bz0; z <= bz1; z += 3) pts.push([x, z]);
  pts.forEach(function(p){
    if(!inPoly(poly, p[0], p[1]) || !inPoly(coast, p[0], p[1]) || onDeck(p[0], p[1])) return;
    water++;
    if(sea.land(p[0], p[1])) waterLand++;
    if(sea.boat.land(p[0], p[1])) waterBoat++;
    if(!Q.riverAt(W, p[0], p[1])) riverAtMiss++;
  });
  // the banks: 2 m outside the water, on the island and off the roads' decks, is land
  var bank = 0, bankLand = 0;
  for(var k = 0; k < poly.length; k++){
    var a = poly[k], b = poly[(k + 1) %% poly.length], dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz);
    if(l < 1e-6) continue;
    var mx = (a[0] + b[0])/2, mz = (a[1] + b[1])/2;
    [[mx + dz/l*2, mz - dx/l*2], [mx - dz/l*2, mz + dx/l*2]].forEach(function(q){
      if(inPoly(poly, q[0], q[1]) || !inPoly(coast, q[0], q[1])) return;
      bank++; if(sea.land(q[0], q[1])) bankLand++;
    });
  }
  r.water = {n: water, land: waterLand, boatLand: waterBoat, riverAtMiss: riverAtMiss, bank: bank, bankLand: bankLand};
  // the bridges: over the water the deck is land at its height, for a hull it is open water; only at its tier
  r.bridges = bridges.map(function(e){
    var p = e.pts, m = p.length/3, best = null;
    for(var j = 0; j < m; j++){ var x = p[3*j]/100, z = p[3*j+2]/100; if(Q.riverAt(W, x, z)){ best = j; if(j >= m/2) break; } }
    var x = p[3*best]/100, z = p[3*best+2]/100, deck = p[3*best+1]/100, j1 = Math.min(best + 1, m - 1), j0 = j1 - 1;
    var ux = (p[3*j1] - p[3*j0])/100, uz = (p[3*j1+2] - p[3*j0+2])/100, ul = Math.hypot(ux, uz), lx = uz/ul, lz = -ux/ul;
    var half = e.width/200, side = half - 0.3, off = half + 1.5, t = e.min_tier != null ? e.min_tier : 0;
    return {id: e.id, deck: deck, level: Array.prototype.every.call(p, function(v, i){ return i %% 3 !== 1 || v === p[1]; }),
            inRiver: Q.riverAt(W, x, z), land: sea.land(x, z), boatLand: sea.boat.land(x, z), ground: Q.groundAt(W, x, z),
            roadY: Q.roadY(W, x, z), sideGround: Q.groundAt(W, x + lx*side, z + lz*side), walk: e.walk,
            offLand: Q.riverAt(W, x + lx*off, z + lz*off) ? sea.land(x + lx*off, z + lz*off) : null,
            tier: t, landBelowTier: O.seaOf(D, null, t - 1).land(x, z), landAtTier: O.seaOf(D, null, t).land(x, z)};
  });
  // the berths: on the river (the port's on its basin), off the land, a hull's length clear of the bank
  var basin = Rv.basin;
  r.docks = doc.layers.island.docks.slice();
  r.berths = sea.docks.map(function(d){
    var site = W.sites.filter(function(s){ return s.id === d.id; })[0], P = H.hqCivic.pierOf(site)[0], clear = Infinity;
    for(var a = 0; a < 16; a++){ var ang = a/16*Math.PI*2; if(sea.land(d.x + Math.sin(ang)*1.8, d.z + Math.cos(ang)*1.8)) clear = 0; }
    return {id: d.id, kind: site.kind, river: Q.riverAt(W, d.x, d.z), land: sea.land(d.x, d.z), clear: clear > 0,
            basin: Math.hypot(d.x - basin.x/100, d.z - basin.z/100) - basin.r/100,
            head: Q.riverAt(W, P.head[0], P.head[1]), siteOnLand: sea.land(site.x/100, site.z/100)};
  });
  // a jet ski from the river dock down the river (under the bridges) to the sea; the walker's sea would stop it
  function sail(s){
    var start = s.docks.filter(function(d){ return d.id === "dock:0"; })[0] || s.docks[0], st = BT.newState("jetski", start.x, start.z, start.yaw);
    var C = Rv.center.map(function(p){ return [p[0]/100, p[1]/100]; }), i = 0, bd = Infinity;
    C.forEach(function(p, k){ var d = Math.hypot(p[0] - start.x, p[1] - start.z); if(d < bd){ bd = d; i = k; } });
    var dt = 1/60, t = 0, ev = [], beached = false, under = 0;   // moored first: off the throttle, then away
    while(t < 240){
      t += dt;
      while(i > 0 && Math.hypot(C[i][0] - st.x, C[i][1] - st.z) < 14) i--;
      var tx = C[i][0], tz = C[i][1], err = wrapPi(Math.atan2(tx - st.x, tz - st.z) - st.yaw);
      BT.step(st, {thr: t < 0.2 ? 0 : 0.45, steer: Math.max(-1, Math.min(1, err*2))}, dt, s).forEach(function(e){ ev.push(e.type); if(e.type === "beach") beached = true; });
      if(R.onDeck(st.x, st.z, null) && Q.riverAt(W, st.x, st.z)) under++;
      if(i === 0 && Math.hypot(C[0][0] - st.x, C[0][1] - st.z) < 20) break;
    }
    return {t: t, beached: beached, under: under, reached: i === 0 && Math.hypot(C[0][0] - st.x, C[0][1] - st.z) < 20, offshore: !inPoly(coast, st.x, st.z),
            ev: ev.slice(0, 8), at: [st.x, st.z], i: i, dock: st.dock};
  }
  r.boat = sail(sea.boat);
  r.walkerSea = sail(sea);
  // no tree in the water
  r.treesInWater = Q.trees(W).filter(function(t){ return Q.riverAt(W, t.x, t.z); }).length;
  // the water mesh: the poly's area, face up, at sea level (+ RIVER_LIFT)
  var g = G.riverWater(W), area = 0, down = 0, ys = {};
  for(var t = 0; t < g.idx.length; t += 3){
    var A = g.idx[t]*3, B = g.idx[t+1]*3, C2 = g.idx[t+2]*3, P = g.pos;
    var ux = P[B] - P[A], uz = P[B+2] - P[A+2], vx = P[C2] - P[A], vz = P[C2+2] - P[A+2], ny = uz*vx - ux*vz;
    area += Math.abs(ny)/2; if(ny < -1e-5*Math.hypot(ux, uz)*Math.hypot(vx, vz)) down++;   // float32 slivers aside
  }
  for(var v = 1; v < g.pos.length; v += 3) ys[g.pos[v].toFixed(3)] = 1;
  var pa = 0; for(k = 0; k < poly.length; k++){ var q0 = poly[k], q1 = poly[(k + 1) %% poly.length]; pa += q0[0]*q1[1] - q1[0]*q0[1]; }
  r.waterMesh = {tris: g.idx.length/3, verts: g.pos.length/3, polyN: poly.length, area: area, polyArea: Math.abs(pa)/2, down: down,
                 ys: Object.keys(ys), seaY: seaY, lift: G.RIVER_LIFT, none: G.riverWater(Q.pack({layers: {}})).idx.length,
                 riverY: O.RIVER_Y, crest: O.WAVES.reduce(function(a, w){ return a + w[2]; }, 0)};
  // the calm river: a hull floats level on it at RIVER_Y, at sea it rides the waves
  var c0 = Rv.center[Math.floor(Rv.center.length/2)], cx = c0[0]/100, cz = c0[1]/100;
  r.calm = {river: [sea.wave(cx, cz, 0), sea.wave(cx, cz, 7.3)], boat: sea.boat.wave(cx, cz, 3.1), atSea: sea.wave(5000, 5000, 1.7) === O.waveAt(5000, 5000, 1.7),
            own: O.seaOf(D, function(){ return 9; }).wave(cx, cz, 0)};
  // the roads over the water: every asphalt / walk / kerb vertex on the water stands at the deck, not on the riverbed;
  // the bridge structure: a slab under the deck, railings over it, abutments into the banks
  var low = 0, onWater = 0, br = {tiles: 0, tris: 0, under: 0, rail: 0, abut: 0, bad: 0}, NT = G.NT;
  var deckY = bridges.length ? bridges[0].pts[1]/100 : 0, B0 = G.BRIDGE;
  for(var tz = 0; tz < NT; tz++) for(var tx = 0; tx < NT; tx++){
    var rt = G.roadTile(W, tx, tz);
    ["asphalt", "walk", "kerb", "marks"].forEach(function(k){
      var p = rt[k].pos;
      for(var i = 0; i < p.length; i += 3){
        if(!Q.riverAt(W, p[i], p[i+2])) continue;
        onWater++; if(p[i+1] < seaY + 1) low++;
      }
    });
    if(!rt.bridge || !rt.bridge.idx.length) continue;
    br.tiles++; br.tris += rt.bridge.idx.length/3;
    var bp = rt.bridge.pos, bn = rt.bridge.nrm;
    for(i = 0; i < bp.length; i += 3){
      if(!isFinite(bp[i]) || !isFinite(bp[i+1]) || !isFinite(bp[i+2]) || !isFinite(bn[i+1])){ br.bad++; continue; }
      if(Math.abs(bp[i+1] - (deckY + G.LIFT + 0.15 - B0.DECK_T)) < 0.05 && bn[i+1] < -0.99 && Q.riverAt(W, bp[i], bp[i+2])) br.under++;
      if(bp[i+1] > deckY + B0.RAIL_H - 0.1) br.rail++;
      if(bp[i+1] < seaY && !Q.riverAt(W, bp[i], bp[i+2])) br.abut++;
    }
    for(var t2 = 0; t2 < rt.bridge.idx.length; t2 += 3){
      var a3 = rt.bridge.idx[t2]*3, b3 = rt.bridge.idx[t2+1]*3, c3 = rt.bridge.idx[t2+2]*3;
      var e1 = [bp[b3] - bp[a3], bp[b3+1] - bp[a3+1], bp[b3+2] - bp[a3+2]], e2 = [bp[c3] - bp[a3], bp[c3+1] - bp[a3+1], bp[c3+2] - bp[a3+2]];
      var n = [e1[1]*e2[2] - e1[2]*e2[1], e1[2]*e2[0] - e1[0]*e2[2], e1[0]*e2[1] - e1[1]*e2[0]], nl = Math.hypot(n[0], n[1], n[2]);
      if(nl > 1e-9 && (n[0]*bn[a3] + n[1]*bn[a3+1] + n[2]*bn[a3+2])/nl < 0) br.bad++;
    }
  }
  r.roadsOverWater = {n: onWater, low: low};
  r.bridge = br;
  // the ground: banks along the river, no beach across its mouth
  var items = G.groundItems(W), kinds = {}, mouthBeach = 0, bankFar = 0;
  items.forEach(function(it){
    kinds[it.kind] = (kinds[it.kind] || 0) + 1;
    if(it.kind === "beach" && it.V.some(function(v){ return v[1] > seaY && Q.riverAt(W, v[0], v[2]); })) mouthBeach++;
    if(it.kind === "bank"){
      var near = Infinity;
      it.P.forEach(function(q){ for(var k = 0; k < poly.length; k++){ var a = poly[k], b = poly[(k + 1) %% poly.length], dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx*dx + dz*dz, u = L2 > 0 ? Math.max(0, Math.min(1, ((q[0] - a[0])*dx + (q[1] - a[1])*dz)/L2)) : 0; near = Math.min(near, Math.hypot(q[0] - a[0] - dx*u, q[1] - a[1] - dz*u)); } });
      if(near > 4) bankFar++;
    }
  });
  r.ground = {kinds: kinds, mouthBeach: mouthBeach, bankFar: bankFar};
  // the terrain under and beside the bridges: never up out of the water (groundAt there is the deck, the terrain is
  // the riverbed), and at the decks' ends never raised over the raw ground (a mound on the low bank)
  var wedge = 0, mound = 0, wet = 0, dry = 0;
  bridges.forEach(function(e){
    var p = e.pts, m = p.length/3, half = e.width/200;
    for(var j = 0; j + 1 < m; j++){
      var ax = p[3*j]/100, az = p[3*j+2]/100, dx = p[3*j+3]/100 - ax, dz = p[3*j+5]/100 - az, l = Math.hypot(dx, dz);
      if(l < 1e-6) continue;
      for(var t = 0; t <= l; t += 1) for(var o = -half - 6; o <= half + 6; o += 1){
        var x = ax + dx*t/l + dz/l*o, z = az + dz*t/l - dx/l*o;
        if(Q.riverAt(W, x, z)){ wet++; if(Math.max(G.meshY(W, x, z, 0), G.meshY(W, x, z, 1), G.meshY(W, x, z, 2)) > seaY + G.RIVER_LIFT + 0.1) wedge++; }
        // the 8 m grid vertex nearest: the terrain there is the raw ground at most (pushed under the roads)
        var vx = Math.round(x/8)*8, vz = Math.round(z/8)*8;
        if(Math.abs(o) <= half){ dry++; if(G.meshY(W, vx, vz, 0) > Q.heightAt(W, vx, vz) + 1e-6 && Q.groundAt(W, vx, vz) > Q.heightAt(W, vx, vz) + 0.5) mound++; }
      }
    }
  });
  r.terrain = {wet: wet, wedge: wedge, dry: dry, mound: mound};
  out[name] = r;
});
// the whole Commons and island (their fixtures): the terrain beside every bridge stays under the water (a cut window
// missed the wedge that rose 3.8 m out of the river at one of them); no lod but the finest reaches over the water at
// all, and that one only a bank's width (the 8 m grid cannot follow a steep bank exactly); and the land along the
// river is not dug under the water (the banks' planes, carried over a whole 8 m star, once sank it into trenches the
// sea showed through, with the bank strip left afloat over them)
var zlib = require("zlib");
out.full = {};
["claude-hq@2", "island@2"].forEach(function(name){
  var doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/" + name + ".json.gz"))), W = Q.pack(doc);
  var top = doc.layers.island.sea_cm/100 + G.RIVER_LIFT, P = G.riverRing(W), b = [Infinity, Infinity, -Infinity, -Infinity];
  P.forEach(function(p){ b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]); });
  function edge(x, z){
    var d = Infinity;
    for(var k = 0; k < P.length; k++){ var a = P[k], c = P[(k + 1) %% P.length], dx = c[0] - a[0], dz = c[1] - a[1], L2 = dx*dx + dz*dz,
      t = L2 > 0 ? Math.max(0, Math.min(1, ((x - a[0])*dx + (z - a[1])*dz)/L2)) : 0; d = Math.min(d, Math.hypot(x - a[0] - dx*t, z - a[1] - dz*t)); }
    return d;
  }
  var reach = [0, 0, 0], x, z;
  for(x = b[0]; x <= b[2]; x += 2) for(z = b[1]; z <= b[3]; z += 2){
    if(!Q.riverAt(W, x, z)) continue;
    for(var l = 0; l < 3; l++) if(G.meshY(W, x, z, l) > top) reach[l] = Math.max(reach[l], edge(x, z));
  }
  var near = 0, dug = 0;
  for(x = Math.floor((b[0] - 16)/8)*8; x <= b[2] + 16; x += 8) for(z = Math.floor((b[1] - 16)/8)*8; z <= b[3] + 16; z += 8){
    if(Q.riverAt(W, x, z)) continue;
    var by = false; for(var a2 = 0; a2 < 16 && !by; a2++) by = Q.riverAt(W, x + Math.sin(a2/16*2*Math.PI)*12, z + Math.cos(a2/16*2*Math.PI)*12);
    if(!by) continue;
    near++;
    if(Q.heightAt(W, x, z) > top + 0.5 && G.meshY(W, x, z, 0) < top) dug++;
  }
  out.full[name] = {reach: reach, near: near, dug: dug, top: top};
});
(function(){
  var doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/claude-hq@2.json.gz")));
  var W = Q.pack(doc), seaY = doc.layers.island.sea_cm/100 + G.RIVER_LIFT, wet = 0, wedge = 0, top = -Infinity;
  W.edges.filter(function(e){ return e.bridge; }).forEach(function(e){
    var p = e.pts, m = p.length/3, half = e.width/200;
    for(var j = 0; j + 1 < m; j++){
      var ax = p[3*j]/100, az = p[3*j+2]/100, dx = p[3*j+3]/100 - ax, dz = p[3*j+5]/100 - az, l = Math.hypot(dx, dz);
      if(l < 1e-6) continue;
      for(var t = 0; t <= l; t += 1) for(var o = -half - 6; o <= half + 6; o += 1){
        var x = ax + dx*t/l + dz/l*o, z = az + dz*t/l - dx/l*o;
        if(!Q.riverAt(W, x, z)) continue;
        var y = Math.max(G.meshY(W, x, z, 0), G.meshY(W, x, z, 1), G.meshY(W, x, z, 2));
        wet++; top = Math.max(top, y); if(y > seaY + 0.1) wedge++;
      }
    }
  });
  out.commonsBridges = {wet: wet, wedge: wedge, top: top, seaY: seaY};
})();
// a doc without a river: the sea and the ground as before
var plain = JSON.parse(fs.readFileSync(root + "/tests/fixtures/cities_island@2.json", "utf8")), Wp = Q.pack(plain), Dp = Q.docOf(Wp), sp = O.seaOf(Dp);
var coastOnly = O.landTest([O.coastOf(Dp)]), same = 0, n = 0;
for(var x = -900; x <= 900; x += 37) for(var z = -900; z <= 900; z += 41){ n++; if(sp.land(x, z) === coastOnly(x, z) && sp.boat.land(x, z) === coastOnly(x, z)) same++; }
out.plain = {riverOf: O.riverOf(Dp), same: same, n: n, water: G.riverWater(Wp).idx.length, banks: G.groundItems(Wp).filter(function(it){ return it.kind === "bank"; }).length,
             bridgeKey: Object.prototype.hasOwnProperty.call(G.roadTile(Wp, 4, 4), "bridge"), riverAt: Q.riverAt(Wp, 0, 0)};
process.stdout.write(JSON.stringify(out));
"""

BUILD = r"""
import { createRequire } from "module";
const require = createRequire(import.meta.url);
""" + COMMON + r"""
const THREE = await import(root + "/games/vendor/three-module.js");
new Function(fs.readFileSync(root + "/games/worldbuild.js", "utf8"))();
var WB = H.worldbuild, out = {}, warns = [];
var warn0 = console.warn; console.warn = function(m){ warns.push(String(m)); };
function tick(){ return new Promise(function(r){ setTimeout(r, 2); }); }
async function settle(wb, cam){
  for(var i = 0; i < 600; i++){ wb.update(cam); await tick(); wb.update(cam); if(wb.stats().pending === 0) return true; }
  return false;
}
var c = {THREE: THREE};
var doc = load("river_island"), W = Q.pack(doc);
// the same world without its river: no water layer, no bridge flags
var docP = JSON.parse(JSON.stringify(doc)); delete docP.layers.river; docP.layers.roads.edges.forEach(function(e){ delete e.bridge; });
var WP = Q.pack(docP);
var br = W.edges.filter(function(e){ return e.bridge; })[0], m = br.pts.length/3 >> 1, cam = {x: br.pts[3*m]/100, z: br.pts[3*m+2]/100, mode: "near", time: 3};
async function build(Wx){
  var wb = WB.create(c, Wx, {worker: false, tier: 5});
  await wb.ready;
  var ok = await settle(wb, cam);
  wb.update(cam);
  var tiles = {};
  wb.root.children.forEach(function(g){ if(g.name && g.name.indexOf("tile ") === 0) tiles[g.name] = g.children.filter(function(me){ return me.visible; }).map(function(me){ return me.name; }); });
  return {wb: wb, ok: ok, stats: wb.stats(), tiles: tiles};
}
var a = await build(W), b = await build(WP), per = {}, maxExtra = 0;
Object.keys(a.tiles).forEach(function(k){ var d = a.tiles[k].length - (b.tiles[k] || []).length; per[k] = d; maxExtra = Math.max(maxExtra, d); });
var bridgeTiles = Object.keys(a.tiles).filter(function(k){ return a.tiles[k].indexOf("bridge") >= 0; });
out.build = {settled: a.ok && b.ok, dc: a.stats.drawCalls, dcPlain: b.stats.drawCalls, maxExtra: maxExtra, bridgeTiles: bridgeTiles,
             river: !!a.wb.river, riverPlain: !!b.wb.river, riverVisible: a.wb.river ? a.wb.river.visible : null,
             riverY: a.wb.river ? a.wb.river.geometry.boundingBox.max.y : null, riverMat: a.wb.river ? a.wb.river.material === a.wb.sea.material : null};
// with the ocean mounted the river wears its material; after it goes, the sea plane's again
var scene = new THREE.Scene(), oc = O.mount(c, scene);
a.wb.update(cam);
var rm = a.wb.river.material;
out.ocean = {mounted: rm === O.riverMaterial() && !!rm, isShader: !!rm.isShaderMaterial, shared: rm.uniforms === O.material().uniforms,
             flat: rm.vertexShader.indexOf("w.y +=") < 0 && O.material().vertexShader.indexOf("w.y +=") >= 0};
oc.dispose();
a.wb.update(cam);
out.ocean.after = a.wb.river.material === a.wb.sea.material && O.material() === null && O.riverMaterial() === null;
a.wb.destroy(); b.wb.destroy();
out.warns = warns;
console.warn = warn0;
process.stdout.write(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
class RiverPureTest(unittest.TestCase):
    out = None

    @classmethod
    def setUpClass(cls):
        src = PURE.replace("%(root)s", json.dumps(ROOT)).replace("%(fixtures)s", json.dumps(list(FIXTURES))).replace("%%", "%")
        cls.out = node(src)

    def each(self):
        return [(name, self.out[name]) for name in FIXTURES]

    def test_packed(self):
        for name, r in self.each():
            self.assertTrue(r["packed"]["river"])
            self.assertGreater(r["packed"]["bridges"], 0)
            self.assertEqual(r["packed"]["docOf"], r["packed"]["bridges"])   # docOf carries them on to ocean, npcsim...

    def test_water_is_not_land(self):
        for name, r in self.each():
            w = r["water"]
            self.assertGreater(w["n"], 200, w)
            self.assertEqual(w["land"], 0, w)                 # walking and driving stop at the bank
            self.assertEqual(w["boatLand"], 0, w)             # a boat sails it
            self.assertEqual(w["riverAtMiss"], 0, w)          # HQV.world.riverAt agrees with the sea
            self.assertGreater(w["bank"], 50, w)
            self.assertEqual(w["bankLand"], w["bank"], w)     # 2 m up the bank is land again

    def test_bridge_deck_is_land_at_deck_height(self):
        for name, r in self.each():
            self.assertTrue(r["bridges"])
            for b in r["bridges"]:
                self.assertTrue(b["level"], b)
                self.assertTrue(b["inRiver"], b)
                self.assertTrue(b["land"], b)                 # you cross on the deck
                self.assertFalse(b["boatLand"], b)            # a hull passes under it
                self.assertEqual(b["ground"], b["deck"], b)   # groundAt on a bridge is the deck
                self.assertEqual(b["roadY"], b["deck"], b)
                if b["walk"] > 0:
                    self.assertAlmostEqual(b["sideGround"], b["deck"] + 0.15, places=6)   # its sidewalk, a kerb up
                self.assertFalse(b["offLand"], b)             # off its side is the water again
                self.assertTrue(b["landAtTier"], b)
                self.assertFalse(b["landBelowTier"], b)       # a bridge not open yet is no deck

    def test_berths_on_the_river(self):
        for name, r in self.each():
            self.assertEqual(sorted(x["id"] for x in r["berths"]), sorted(r["docks"]))
            kinds = {x["kind"] for x in r["berths"]}
            self.assertEqual(kinds, {"dock", "port"})
            for b in r["berths"]:
                self.assertTrue(b["river"], b)                # moored on the river, not the coast
                self.assertFalse(b["land"], b)
                self.assertTrue(b["clear"], b)                # a hull's length of water round it
                self.assertTrue(b["head"], b)                 # the pier runs out over the water
                self.assertTrue(b["siteOnLand"], b)
                if b["kind"] == "port":
                    self.assertLess(b["basin"], 0, b)         # the port's berth is on the harbour basin

    def test_a_boat_sails_down_the_river_under_the_bridges(self):
        for name, r in self.each():
            bt = r["boat"]
            self.assertTrue(bt["reached"], bt)
            self.assertFalse(bt["beached"], bt)
            self.assertLess(bt["t"], 200, bt)
        # the island's dock lies upstream of a bridge: the hull passes under it; the walker's sea has a deck there
        isl = self.out["river_island"]
        self.assertGreater(isl["boat"]["under"], 0, isl["boat"])
        self.assertTrue(isl["walkerSea"]["beached"] or not isl["walkerSea"]["reached"], isl["walkerSea"])

    def test_no_tree_in_the_water(self):
        for name, r in self.each():
            self.assertEqual(r["treesInWater"], 0)

    def test_water_mesh(self):
        for name, r in self.each():
            m = r["waterMesh"]
            self.assertEqual(m["verts"], m["polyN"])
            self.assertEqual(m["tris"], m["polyN"] - 2)       # one fan of the outline: earcut, no holes
            self.assertAlmostEqual(m["area"], m["polyArea"], delta=1e-6*m["polyArea"])
            self.assertEqual(m["down"], 0)                    # every face up
            self.assertEqual(m["ys"], ["%.3f" % (m["seaY"] + m["lift"])])
            # calm water over the sea's highest crest, so the waving sea plane under it never pokes through in stripes
            self.assertGreater(m["lift"], m["crest"])
            self.assertLess(m["lift"], 0.5)
            self.assertEqual(m["lift"], m["riverY"])          # worldgeom and ocean agree on the river's surface
            c = r["calm"]
            self.assertEqual(c["river"], [m["riverY"], m["riverY"]])
            self.assertEqual(c["boat"], m["riverY"])
            self.assertTrue(c["atSea"])
            self.assertEqual(c["own"], 9)                     # a wave the caller passes still wins
            self.assertEqual(m["none"], 0)

    def test_bridges_are_decks_not_ribbons_on_the_riverbed(self):
        for name, r in self.each():
            o = r["roadsOverWater"]
            self.assertGreater(o["n"], 50, o)
            self.assertEqual(o["low"], 0, o)                  # no ribbon, kerb or verge wall down to the riverbed
            b = r["bridge"]
            self.assertGreater(b["tiles"], 0, b)
            self.assertEqual(b["bad"], 0, b)                  # finite, faces wound with their normals
            self.assertGreater(b["under"], 0, b)              # the slab's underside over the water
            self.assertGreater(b["rail"], 0, b)               # railings
            self.assertGreater(b["abut"], 0, b)               # abutments down into the banks

    def test_terrain_stays_under_the_water_at_bridges(self):
        for name, r in self.each():
            t = r["terrain"]
            self.assertGreater(t["wet"], 100, t)
            self.assertEqual(t["wedge"], 0, t)                # no grey wedge out of the river beside a deck
            self.assertEqual(t["mound"], 0, t)                # no grass mound under a deck's end
        c = self.out["commonsBridges"]
        self.assertGreater(c["wet"], 500, c)
        self.assertEqual(c["wedge"], 0, c)

    def test_terrain_along_the_river(self):
        for name, f in self.out["full"].items():
            self.assertEqual(f["reach"][1:], [0, 0], (name, f))        # the coarse lods never over the water
            self.assertLessEqual(f["reach"][0], 4.5, (name, f))        # the finest only within a bank's width
            self.assertGreater(f["near"], 200, (name, f))
            self.assertLess(f["dug"], 0.05*f["near"], (name, f))     # was 21% of the Commons' (98 of 459)

    def test_banks_and_mouth(self):
        for name, r in self.each():
            g = r["ground"]
            self.assertGreater(g["kinds"].get("bank", 0), 100, g)
            self.assertGreater(g["kinds"].get("beach", 0), 100, g)
            self.assertEqual(g["mouthBeach"], 0, g)           # no sand bar across the river's mouth
            self.assertEqual(g["bankFar"], 0, g)              # the banks hug the water's edge

    def test_no_river_no_change(self):
        p = self.out["plain"]
        self.assertIsNone(p["riverOf"])
        self.assertEqual(p["same"], p["n"])                   # land is the coast polygon, as before
        self.assertEqual(p["water"], 0)
        self.assertEqual(p["banks"], 0)
        self.assertFalse(p["bridgeKey"])                      # roadTile's output keeps its old shape
        self.assertFalse(p["riverAt"])


@unittest.skipUnless(NODE, "node is not installed")
@unittest.skipUnless(os.path.exists(os.path.join(ROOT, "games", "vendor", "three-module.js")), "vendored three.js is missing")
class RiverBuildTest(unittest.TestCase):
    out = None

    @classmethod
    def setUpClass(cls):
        cls.out = node(BUILD.replace("%(root)s", json.dumps(ROOT)), module=True)

    def test_builds_without_errors(self):
        o = self.out
        self.assertTrue(o["build"]["settled"], o)
        self.assertEqual(o["warns"], [])

    def test_draw_calls(self):
        b = self.out["build"]
        self.assertLessEqual(b["maxExtra"], 3, b)             # at most 3 more per tile (one: its bridges)
        self.assertGreater(len(b["bridgeTiles"]), 0, b)
        self.assertEqual(b["dc"] - b["dcPlain"], len(b["bridgeTiles"]) + 1, b)   # + the river, one mesh
        self.assertTrue(b["river"])
        self.assertFalse(b["riverPlain"])
        self.assertTrue(b["riverVisible"])

    def test_river_wears_the_sea(self):
        b, o = self.out["build"], self.out["ocean"]
        self.assertTrue(b["riverMat"])                        # the sea plane's material without an ocean
        self.assertTrue(o["mounted"])                         # the mounted ocean's calm material
        self.assertTrue(o["shared"])                          # the sea's uniforms: its tint, glint and clock
        self.assertTrue(o["flat"])                            # no waves in its vertices
        self.assertTrue(o["isShader"])
        self.assertTrue(o["after"])


class RiverSourceTest(unittest.TestCase):
    def test_fixtures_small_and_shaped(self):
        for name in FIXTURES:
            p = os.path.join(ROOT, "tests", "fixtures", name + ".json")
            self.assertLess(os.path.getsize(p), 100*1024)
            d = json.loads(read(p))
            self.assertIn("_cut", d)
            L = d["layers"]
            for k in ("center", "width_cm", "basin", "poly"):
                self.assertIn(k, L["river"])
            self.assertTrue(any(e.get("bridge") for e in L["roads"]["edges"]))
            self.assertEqual(sorted(L["island"]["docks"]), ["dock:0", "port:0"])

    def test_house_rules(self):
        for f in ("world.js", "worldgeom.js", "worldbuild.js", "ocean.js"):
            src = read(os.path.join(ROOT, "games", f))
            self.assertNotRegex(src, r"Math\.random\(", f)
            self.assertNotRegex(src, r"Math\.min\(\s*1\s*,\s*dt\s*\*", f)
            self.assertNotRegex(src, r"\b(let|const)\s", f)
            self.assertNotRegex(src, r"XMLHttpRequest|WebSocket|innerHTML", f)


if __name__ == "__main__":
    unittest.main()
