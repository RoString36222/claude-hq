"""City Gen v4 phase 7 (HQ 3.30): the ring road under the airport on the client, games/world.js and games/worldgeom.js under
node on tests/fixtures/claude-hq@3.json.gz (the Commons: ring, a cutting, the tunnel, a cutting, ring).

Checks: pack keeps an edge's `under` and docOf gives it back (PACK_V bumped); tunnelsOf (memoised: two cuttings and the
tunnel, the portals where they meet, a hole ring per cutting); each cutting is a terrain hole (its floor the road, the
street level over it the land) and the tunnel's land is not; groundAt over the tunnel without yNow is the land, with yNow
at its road the road (and a car stepping along the ring from the outer end of one cutting through the tunnel to the
other's, passing yNow each step, stays on the road the whole way, both ways, and is never blocked); in the tunnel at road
level its walls block, on the land over it they do not; a cutting's top edge (its walls, coping railing, a portal's
headwall) blocks at ground level, its walls at road level; the terrain is not pushed down over the tunnel and the
terrain, ground and road tiles are cut open over a cutting; the tiles it crosses carry, in their `tunnel` geo, its road,
walls, ceiling, lights (lit), walkways and portals (with a sign band), and a cutting's tiles its road and retaining
walls; no tree or prop stands in a cutting, no gantry over the tunnel; games/hqcity3d.js keeps the avatar and the camera
down in it; @1 and @2 have no tunnels and build as before. Skipped without node. Stdlib only."""
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
var D3 = doc("claude-hq@3"), W = H.pack(D3), out = {}, K = H.TUN;
var byId = {}; W.edges.forEach(function(e){ byId[e.id] = e; });
function inP(P, x, z){
  var ins = false;
  for(var i = 0, j = P.length - 1; i < P.length; j = i++){ var a = P[i], c = P[j]; if((a[1] > z) !== (c[1] > z) && x < (c[0] - a[0])*(z - a[1])/(c[1] - a[1]) + a[0]) ins = !ins; }
  return ins;
}
// the point s m along a polyline [[x, y, z]]: {x, y, z, dx, dz} (lx = dz, lz = -dx: its left)
function along(P, s){
  for(var i = 0; i + 1 < P.length; i++){
    var a = P[i], b = P[i+1], L = Math.hypot(b[0] - a[0], b[2] - a[2]);
    if(L < 1e-9) continue;
    if(s <= L || i + 2 === P.length){ var t = Math.max(0, Math.min(1, s/L));
      return {x: a[0] + (b[0] - a[0])*t, y: a[1] + (b[1] - a[1])*t, z: a[2] + (b[2] - a[2])*t, dx: (b[0] - a[0])/L, dz: (b[2] - a[2])/L}; }
    s -= L;
  }
}
function dist(P, x, z){
  var best = Infinity;
  for(var i = 0; i + 1 < P.length; i++){
    var a = P[i], b = P[i+1], ux = b[0] - a[0], uz = b[2] - a[2], L2 = ux*ux + uz*uz, t = L2 > 0 ? Math.max(0, Math.min(1, ((x - a[0])*ux + (z - a[2])*uz)/L2)) : 0;
    best = Math.min(best, Math.hypot(x - a[0] - ux*t, z - a[2] - uz*t));
  }
  return best;
}
function plen(P){ var s = 0; for(var i = 0; i + 1 < P.length; i++) s += Math.hypot(P[i+1][0] - P[i][0], P[i+1][2] - P[i][2]); return s; }

// ---- data ----
var dv = H.docOf(W), dvE = {}; dv.layers.roads.edges.forEach(function(e){ dvE[e.id] = e; });
var und = W.edges.filter(function(e){ return e.under; });
out.data = {packV: H.PACK_V, under: und.map(function(e){ return [e.id, e.under, e.cls, e.v4, e.width, dvE[e.id].under]; }),
  roundTrip: JSON.stringify(H.pack(dv).edges.map(function(e){ return [e.id, e.under || null]; })) === JSON.stringify(W.edges.map(function(e){ return [e.id, e.under || null]; })),
  docUnder: D3.layers.roads.edges.filter(function(e){ return e.under; }).length};

// ---- tunnelsOf ----
var T = H.tunnelsOf(W), tun = T.filter(function(t){ return t.kind === "tunnel"; })[0], cuts = T.filter(function(t){ return t.kind === "cutting"; });
out.tunnels = {memo: H.tunnelsOf(W) === T, kinds: T.map(function(t){ return t.kind; }), portals: T.map(function(t){ return t.portal; }),
  holes: T.map(function(t){ return t.hole ? t.hole.length : 0; }), half: T.map(function(t){ return t.half; }),
  len: T.map(function(t){ return Math.round(t.len); }),
  depth: tun ? Math.min.apply(null, tun.pts.map(function(p){ return H.heightAt(W, p[0], p[2]) - p[1]; })) : null,
  same: JSON.stringify(H.tunnelsOf(H.pack(D3))) === JSON.stringify(T)};
var holes = H.holesOf(W);
out.tunnels.inHolesOf = cuts.map(function(c){ return holes.indexOf(c.hole) >= 0; });

// ---- holes: every cutting's road is in its hole, the tunnel's line is not ----
out.holes = {cut: [0, 0, 0, 0], tun: [0, 0]};
cuts.forEach(function(c){
  var L = plen(c.pts);
  for(var s = 2; s < L - 2; s += 5){
    var q = along(c.pts, s), lx = q.dz, lz = -q.dx;
    [0, c.half - 0.5, -(c.half - 0.5)].forEach(function(o){
      var x = q.x + lx*o, z = q.z + lz*o;
      out.holes.cut[0]++;
      if(H.holeAt(W, x, z)) out.holes.cut[1]++;
      if(Math.abs(H.holeFloor(W, x, z) - q.y) < 0.05) out.holes.cut[2]++;
      if(Math.abs(H.streetAt(W, x, z) - H.heightAt(W, x, z)) < 1e-9) out.holes.cut[3]++;
    });
  }
});
// (its line from 1 m in from each portal, where a cutting's hole ends)
for(var s = 1; s < tun.len - 1; s += 2){ var q = along(tun.pts, s); out.holes.tun[0]++; if(H.holeAt(W, q.x, q.z)) out.holes.tun[1]++; }

// ---- surfaces over the tunnel ----
out.over = {n: 0, land: 0, road: 0, landY: 0, roadY: 0, surf: 0, nr: 0, nrIn: 0, street: 0};
var tunE = W.edges.filter(function(e){ return e.id === tun.edge; })[0];
for(var s = 5; s < tun.len - 5; s += 10){
  var q = along(tun.pts, s), lx = q.dz, lz = -q.dx;
  [0, 7, -7].forEach(function(o){
    var x = q.x + lx*o, z = q.z + lz*o, h = H.groundAt(W, x, z, false, H.heightAt(W, x, z));
    out.over.n++;
    // without yNow: the land (the airport); with yNow at the road: the road; with yNow on the land: the land
    if(Math.abs(H.groundAt(W, x, z) - H.heightAt(W, x, z)) < 0.05 || H.groundAt(W, x, z) > q.y + 5) out.over.land++;
    // (the centre line is on the expressway's median, raised paving a kerb over the road, where the median runs)
    var gq = H.groundAt(W, x, z, false, q.y) - q.y;
    if(Math.abs(gq) < 0.05 || (o === 0 && tunE.median > 0 && Math.abs(gq - 0.15) < 0.05)) out.over.road++;
    if(h > q.y + 5) out.over.landY++;
    // (hq3d's "the street" sentinel, -1e9, and anything well under the tunnel: the land)
    if(H.groundAt(W, x, z, false, -1e9) > q.y + 5 && H.groundAt(W, x, z, false, q.y - 4) > q.y + 5 && !H.tunnelAt(W, x, z, -1e9)) out.over.street++;
    if(H.roadY(W, x, z) == null || H.roadY(W, x, z) > q.y + 5) out.over.roadY++;
    if(H.surfaceAt(W, x, z, q.y) === "road" || (o === 0 && tunE.median > 0 && Math.abs(gq - 0.15) < 0.05 && H.surfaceAt(W, x, z, q.y) === "sidewalk")) out.over.surf++;
    var nr = H.nearestRoad(W, x, z, 40), ni = H.nearestRoad(W, x, z, 40, q.y);
    // (without yNow a tunnel is the nearest road only where no other is within 40 m)
    if(!nr || nr.edge !== tun.edge || !W.edges.some(function(e){ if(e.id === tun.edge) return false; var p = e.pts;
      for(var j = 0; j < p.length; j += 3) if(Math.hypot(p[j]/100 - x, p[j+2]/100 - z) < 30) return true; return false; })) out.over.nr++;
    if(ni && ni.edge === tun.edge) out.over.nrIn++;
  });
}

// ---- a car along the ring from the outer end of one cutting, through the tunnel, out of the other ----
function drive(P){
  var L = plen(P), y = null, worst = 0, at = null, n = 0, blocked = 0, lanes = [0, 5, -5, 10, -10];
  for(var s = 0; s <= L; s += 0.5){
    var q = along(P, s), lx = q.dz, lz = -q.dx;
    lanes.forEach(function(o){
      var x = q.x + lx*o, z = q.z + lz*o, g = H.groundAt(W, x, z, false, y == null ? q.y : y), d = Math.abs(g - q.y);
      if(d > worst){ worst = d; at = [+s.toFixed(1), o, +q.y.toFixed(2), +g.toFixed(2)]; }
      if(H.blockedAt(W, x, z, y == null ? q.y : y)) blocked++;
    });
    y = H.groundAt(W, q.x, q.z, false, y == null ? q.y : y);
    n++;
  }
  return {worst: worst, at: at, n: n, blocked: blocked};
}
var chain = [];
[cuts[0], tun, cuts[1]].forEach(function(t, i){
  var P = t.pts;
  // (each piece in the chain's order: the cutting before the tunnel ends at its portal)
  if(i === 0 && !t.portal[1]) P = P.slice().reverse();
  if(i > 0){ var L0 = chain[chain.length - 1], a = P[0], b = P[P.length - 1];
    if(Math.hypot(b[0] - L0[0], b[2] - L0[2]) < Math.hypot(a[0] - L0[0], a[2] - L0[2])) P = P.slice().reverse(); }
  P.forEach(function(p){ chain.push(p); });
});
out.drive = [drive(chain), drive(chain.slice().reverse())];

// ---- walls: in the tunnel at road level ----
out.walls = {n: 0, wall: 0, free: 0, landFree: 0, at: []};
for(var s = 10; s < tun.len - 10; s += 15){
  var q = along(tun.pts, s), lx = q.dz, lz = -q.dx, h = tun.half;
  [-1, 1].forEach(function(sg){
    out.walls.n++;
    var w1 = [q.x + lx*sg*(h + 0.4), q.z + lz*sg*(h + 0.4)], w2 = [q.x + lx*sg*(h + 2), q.z + lz*sg*(h + 2)], f = [q.x + lx*sg*(h - 0.6), q.z + lz*sg*(h - 0.6)];
    // (on the inside of a bend the point beside this segment is still on the road: only where it is h + 0.3 .. h + 0.5 out)
    if(dist(tun.pts, w1[0], w1[1]) < h + 0.3){ out.walls.n--; return; }
    if(H.blockedAt(W, w1[0], w1[1], q.y) && H.blockedAt(W, w2[0], w2[1], q.y) && H.blockedAt(W, w1[0], w1[1], q.y + 3)) out.walls.wall++;
    else out.walls.at.push([+s.toFixed(0), sg]);
    if(!H.blockedAt(W, f[0], f[1], q.y)) out.walls.free++;
    // on the land over it, nothing of the tunnel blocks
    if(!H.blockedAt(W, w1[0], w1[1]) && !H.blockedAt(W, w1[0], w1[1], H.heightAt(W, w1[0], w1[1]))) out.walls.landFree++;
  });
}
var mid = along(tun.pts, tun.len/2);
out.tunnelAt = [H.tunnelAt(W, mid.x, mid.z, mid.y), H.tunnelAt(W, mid.x, mid.z, mid.y + 7), H.tunnelAt(W, mid.x, mid.z)];

// ---- a cutting's top edge: blocked from the land, its walls from the road ----
out.edge = {n: 0, top: 0, topNoY: 0, beyondFree: 0, roadWall: 0, roadFree: 0, drop: 0};
cuts.forEach(function(c){
  var L = plen(c.pts), h = c.half;
  for(var s = 5; s < L - 5; s += 10){
    var q = along(c.pts, s), lx = q.dz, lz = -q.dx;
    [-1, 1].forEach(function(sg){
      var e1 = [q.x + lx*sg*(h + 0.5), q.z + lz*sg*(h + 0.5)], e2 = [q.x + lx*sg*(h + 1.2), q.z + lz*sg*(h + 1.2)], far = [q.x + lx*sg*(h + 6), q.z + lz*sg*(h + 6)];
      var land = H.heightAt(W, e2[0], e2[1]);
      if(land - q.y < 2) return;   // (its shallow ends: a step)
      out.edge.n++;
      if(H.blockedAt(W, e1[0], e1[1], land) && H.blockedAt(W, e2[0], e2[1], land)) out.edge.top++;
      if(H.blockedAt(W, e1[0], e1[1]) && H.blockedAt(W, e2[0], e2[1])) out.edge.topNoY++;
      if(!H.blockedAt(W, far[0], far[1], H.heightAt(W, far[0], far[1]))) out.edge.beyondFree++;
      if(H.blockedAt(W, e1[0], e1[1], q.y)) out.edge.roadWall++;
      var f = [q.x + lx*sg*(h - 0.5), q.z + lz*sg*(h - 0.5)];
      if(!H.blockedAt(W, f[0], f[1], q.y)) out.edge.roadFree++;
      // from the land, the hole itself (its road 2 m+ down) is the drop
      if(H.blockedAt(W, f[0], f[1], land)) out.edge.drop++;
    });
  }
});
// a portal's headwall: over the tunnel's mouth, from the land; not for what drives in
out.portal = cuts.map(function(c){
  var end = c.portal[1] ? 1 : 0, P = end ? c.pts : c.pts.slice().reverse(), q = along(P, plen(P)), x = q.x + q.dx*0.6, z = q.z + q.dz*0.6;
  var land = H.heightAt(W, x, z);
  return [H.blockedAt(W, x, z, land), H.blockedAt(W, x, z), H.blockedAt(W, x, z, q.y), H.blockedAt(W, q.x + q.dx*6, q.z + q.dz*6, land)];
});

// ---- geometry ----
var geoms = {}, tiles = {};
function tileKey(x, z){ var t = G.tileOf(x, z); return t.tx + "," + t.tz; }
function geomAt(k){ if(!geoms[k]){ var t = k.split(","); geoms[k] = G.roadTile(W, +t[0], +t[1], false); } return geoms[k]; }
function tris(g, fn){
  var p = g.pos, I = g.idx, n = g.nrm, c = g.col;
  for(var t = 0; t < I.length; t += 3){
    var a = 3*I[t], b = 3*I[t+1], d = 3*I[t+2];
    var A = ((p[b] - p[a])*(p[d+2] - p[a+2]) - (p[b+2] - p[a+2])*(p[d] - p[a]))/2;   // (plan area: 0 for a wall, a skirt)
    fn((p[a] + p[b] + p[d])/3, (p[a+1] + p[b+1] + p[d+1])/3, (p[a+2] + p[b+2] + p[d+2])/3, [n[a], n[a+1], n[a+2]], [c[a], c[a+1], c[a+2]], Math.abs(A),
       g.lit ? g.lit[I[t]] : 0);
  }
}
// the tunnel: per tile it crosses (its `tunnel` geo), ceiling faces (down, at road + 5.5), wall faces (level normals),
// walkways (up, 0.29 m over the road), the road (asphalt, up, at road + LIFT), lights (lit 1, just under the ceiling)
var tunTiles = {};
tun.pts.forEach(function(p){ tunTiles[tileKey(p[0], p[2])] = 1; });
out.geo = {tiles: Object.keys(tunTiles).map(function(k){
  var g = geomAt(k), r = {k: k, ceil: 0, wall: 0, walk: 0, road: 0, glow: 0, glowOn: 0, inAsphalt: 0};
  if(g.tunnel) tris(g.tunnel, function(x, y, z, n, col, A, lit){
    var c = {d: Infinity}; tun.pts.forEach(function(p, i){ var d = Math.hypot(p[0] - x, p[2] - z); if(d < c.d) c = {d: d, y: p[1]}; });
    if(c.d > 30) return;
    // (lit 2: HQ 3.34's cutting wall lights, night only, not the tunnel's ceiling lights)
    if(lit > 1.5) return;
    if(lit > 0.5){ r.glow++; if(y > c.y + K.CLEAR - 0.2 && y < c.y + K.CLEAR) r.glowOn++; return; }
    if(n[1] < -0.9 && Math.abs(y - (c.y + K.CLEAR)) < 0.05) r.ceil++;
    if(Math.abs(n[1]) < 0.05 && y > c.y && y < c.y + K.CLEAR) r.wall++;
    if(n[1] > 0.9 && Math.abs(y - (c.y + G.LIFT + 0.25)) < 0.05) r.walk++;
    if(n[1] > 0.9 && c.d < 10 && Math.abs(y - (c.y + G.LIFT)) < 0.05) r.road++;
  });
  // (its ribbon is in `tunnel`, none of it in the tile's asphalt)
  tris(g.asphalt, function(x, y, z){ if(y < tun.pts[0][1] + 1 && Math.hypot(x - tun.pts[0][0], z - tun.pts[0][2]) < tun.len) r.inAsphalt++; });
  return r;
})};
// the portals: a headwall face looking out along each cutting over the mouth, and a sign band on it
out.geo.portals = [0, 1].map(function(end){
  var P = end ? tun.pts : tun.pts.slice().reverse(), q = along(P, plen(P)), k = tileKey(q.x, q.z), r = {face: 0, sign: 0, rail: 0};
  [k].concat([[-1, 0], [1, 0], [0, -1], [0, 1]].map(function(d){ var t = k.split(","); return (+t[0] + d[0]) + "," + (+t[1] + d[1]); })).forEach(function(kk){
    var t = kk.split(","); if(+t[0] < 0 || +t[1] < 0 || +t[0] >= G.NT || +t[1] >= G.NT) return;
    var g = geomAt(kk).tunnel;
    if(g) tris(g, function(x, y, z, n, c){
      if(Math.hypot(x - q.x, z - q.z) > tun.half + 3) return;
      var out1 = n[0]*q.dx + n[2]*q.dz;
      if(out1 > 0.95 && y > q.y + K.CLEAR - 0.05) r.face++;
      if(out1 > 0.95 && c[1] > c[0] + 0.2 && c[1] > c[2] + 0.1) r.sign++;
      if(y > H.heightAt(W, q.x, q.z) + 0.5) r.rail++;
    });
  });
  return r;
});
// a cutting's retaining walls: vertical faces 14.5 m out up to the land, per tile
out.geo.cuts = cuts.map(function(c){
  var ks = {}, n = 0, top = 0;
  c.pts.forEach(function(p){ ks[tileKey(p[0], p[2])] = 1; });
  Object.keys(ks).forEach(function(k){
    var g = geomAt(k).tunnel;
    if(g) tris(g, function(x, y, z, nn){
      var best = {d: Infinity}; c.pts.forEach(function(p){ var d = Math.hypot(p[0] - x, p[2] - z); if(d < best.d) best = {d: d, y: p[1]}; });
      if(Math.abs(nn[1]) < 0.05 && Math.abs(best.d - c.half) < 0.6) n++;
      if(nn[1] > 0.9 && best.d > c.half - 0.5 && best.d < c.half + 1.5 && y > best.y + 1) top++;
    });
  });
  return [Object.keys(ks).length, n, top];
});
// the terrain is not pushed down over the tunnel (nor to a cutting's road at its rim): every lod-0 vertex within the
// tunnel's footprint is the land
out.geo.terrain = {n: 0, bad: []};
Object.keys(tunTiles).forEach(function(k){
  var t = k.split(","), L = []; for(var i = 0; i < 16; i++) L.push(0);
  // (the faces with an area in plan: a chunk's skirts hang 2 m and more under its edges)
  tris(G.terrainTile(W, +t[0], +t[1], L), function(x, y, z, n, c, A){
    if(A < 1e-6) return;
    var best = {d: Infinity};
    tun.pts.forEach(function(q){ var d = Math.hypot(q[0] - x, q[2] - z); if(d < best.d) best = {d: d, y: q[1]}; });
    if(best.d > tun.half + 1 || H.holeAt(W, x, z)) return;
    out.geo.terrain.n++;
    if(y < H.streetAt(W, x, z) - 0.3) out.geo.terrain.bad.push([x, y, z, H.streetAt(W, x, z)]);
  });
});
// nothing of the terrain, ground or (other) roads inside a cutting's hole
out.geo.cut = {terrain: 0, ground: 0, roads: 0, road: 0};
var ckeys = {};
cuts.forEach(function(c){ c.pts.forEach(function(p){ ckeys[tileKey(p[0], p[2])] = 1; }); });
Object.keys(ckeys).forEach(function(k){
  var t = k.split(","), L = []; for(var i = 0; i < 16; i++) L.push(0);
  tris(G.terrainTile(W, +t[0], +t[1], L), function(x, y, z, n, c, A){ if(A > 1e-9 && cuts.some(function(c){ return inP(c.hole, x, z); })) out.geo.cut.terrain++; });
  tris(G.groundTile(W, +t[0], +t[1]), function(x, y, z){ if(cuts.some(function(c){ return inP(c.hole, x, z); })) out.geo.cut.ground++; });
  var R = geomAt(k);
  [R.asphalt, R.marks, R.walk].forEach(function(g){ tris(g, function(x, y, z, n, c, A){ if(A > 1e-9 && cuts.some(function(c2){ return inP(c2.hole, x, z); })) out.geo.cut.roads++; }); });
  // (and the cutting's own road in its `tunnel` geo, down in it)
  tris(R.tunnel, function(x, y, z, n){ if(n[1] > 0.9 && cuts.some(function(c2){ return inP(c2.hole, x, z) && Math.abs(y - H.holeFloor(W, x, z) - G.LIFT) < 0.08; })) out.geo.cut.road++; });
});

// ---- props: none in a cutting, no gantry over the tunnel or a cutting ----
out.props = {n: 0, bad: []};
function clear(kind, x, z){
  out.props.n++;
  if(cuts.some(function(c){ return inP(c.hole, x, z); })) out.props.bad.push([kind, x, z, "cutting"]);
  if(kind === "gantries" && H.underOver(W, x, z, 3)) out.props.bad.push([kind, x, z, "over"]);
}
H.trees(W).forEach(function(t){ clear("tree", t.x, t.z); });
for(var tz = 0; tz < G.NT; tz++) for(var tx = 0; tx < G.NT; tx++){
  var PR = G.props(W, tx, tz);
  ["lamps", "parked", "signs", "gantries", "furniture"].forEach(function(k){ (PR[k] || []).forEach(function(o){ clear(k, o.x, o.z); }); });
}

// ---- @1 / @2: no tunnels, nothing changes ----
out.old = ["claude-hq@1", "claude-hq@2"].map(function(n){
  var V = H.pack(doc(n)), diff = 0;
  for(var i = 0; i < 2000; i++){
    var x = ((i*7919) % 1800) - 900 + 0.31, z = ((i*104729) % 1800) - 900 + 0.77, g = H.groundAt(V, x, z);
    if(H.tunnelAt(V, x, z, g) || H.tunnelAt(V, x, z, g - 8) || H.underOver(V, x, z, 3)) diff++;
    if(H.rayGround(V, {x: x, y: g + 5, z: z}, {x: x + 20, y: g + 2, z: z}, 2, g) !== H.rayGround(V, {x: x, y: g + 5, z: z}, {x: x + 20, y: g + 2, z: z})) diff++;
  }
  var R = G.roadTile(V, 3, 3, false);
  return {tunnels: H.tunnelsOf(V).length, under: V.edges.some(function(e){ return "under" in e; }), glow: "tunnel" in R, diff: diff};
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
class RoadTunnels(unittest.TestCase):
    def test_pack_keeps_under(self):
        d = run()["data"]
        self.assertGreaterEqual(d["packV"], 6)
        self.assertEqual(d["docUnder"], 3)
        self.assertEqual(sorted(u[1] for u in d["under"]), ["cutting", "cutting", "tunnel"])
        for eid, under, cls, v4, width, back in d["under"]:
            self.assertEqual((cls, v4, width, back), ("ring", "expressway", 2900, under))
        self.assertTrue(d["roundTrip"])

    def test_tunnels_of(self):
        t = run()["tunnels"]
        self.assertTrue(t["memo"])
        self.assertTrue(t["same"])
        self.assertEqual(sorted(t["kinds"]), ["cutting", "cutting", "tunnel"])
        for kind, portal, hole in zip(t["kinds"], t["portals"], t["holes"]):
            if kind == "tunnel":
                self.assertEqual(portal, [True, True])
                self.assertEqual(hole, 0)
            else:
                self.assertEqual(sorted(portal), [False, True])
                self.assertGreater(hole, 6)
        self.assertEqual(t["half"], [14.5, 14.5, 14.5])
        self.assertAlmostEqual(t["depth"], 7.0, delta=0.05)
        self.assertEqual(t["inHolesOf"], [True, True])

    def test_cuttings_are_holes_and_the_tunnel_is_not(self):
        h = run()["holes"]
        n, inside, floor, street = h["cut"]
        self.assertGreater(n, 150)
        self.assertEqual(inside, n)
        self.assertEqual(floor, n)
        self.assertEqual(street, n)
        self.assertGreater(h["tun"][0], 20)
        self.assertEqual(h["tun"][1], 0)

    def test_surfaces_over_the_tunnel(self):
        o = run()["over"]
        self.assertGreater(o["n"], 50)
        for k in ("land", "road", "landY", "roadY", "surf", "nr", "nrIn", "street"):
            self.assertEqual(o[k], o["n"], k)

    def test_driving_through_stays_on_the_road(self):
        for r in run()["drive"]:
            self.assertGreater(r["n"], 1500)
            self.assertLess(r["worst"], 0.3, r)
            self.assertEqual(r["blocked"], 0, r)

    def test_tunnel_walls_block_at_road_level_only(self):
        w = run()["walls"]
        self.assertGreater(w["n"], 30)
        self.assertEqual(w["wall"], w["n"], w["at"])
        self.assertEqual(w["free"], w["n"])
        self.assertEqual(w["landFree"], w["n"])
        inside, over, none = run()["tunnelAt"]
        self.assertEqual(inside["kind"], "tunnel")
        self.assertAlmostEqual(inside["ceil"] - inside["y"], 5.5, delta=1e-9)
        self.assertIsNone(over)
        self.assertIsNone(none)

    def test_cutting_edges_block(self):
        e = run()["edge"]
        self.assertGreater(e["n"], 50)
        for k in ("top", "topNoY", "roadWall", "roadFree", "drop"):
            self.assertEqual(e[k], e["n"], k)
        self.assertGreater(e["beyondFree"], 0.9*e["n"])
        for land, noY, road, beyond in run()["portal"]:
            self.assertTrue(land, "the headwall from the land")
            self.assertTrue(noY)
            self.assertFalse(road, "driving into the tunnel")
            self.assertFalse(beyond, "the land over the tunnel past the headwall")

    def test_tunnel_geometry(self):
        g = run()["geo"]
        self.assertGreaterEqual(len(g["tiles"]), 1)
        for r in g["tiles"]:
            self.assertGreater(r["ceil"], 0, r)
            self.assertGreater(r["wall"], 0, r)
            self.assertGreater(r["walk"], 0, r)
            self.assertGreater(r["road"], 0, r)
            self.assertGreater(r["glow"], 0, r)
            self.assertEqual(r["glowOn"], r["glow"], r)
            self.assertEqual(r["inAsphalt"], 0, r)
        self.assertEqual(len(g["portals"]), 2)
        for p in g["portals"]:
            self.assertGreater(p["face"], 0, p)
            self.assertGreater(p["sign"], 0, p)
            self.assertGreater(p["rail"], 0, p)
        for tiles, walls, top in g["cuts"]:
            self.assertGreater(tiles, 0)
            self.assertGreater(walls, 20)
            self.assertGreater(top, 10)

    def test_terrain_not_pushed_down_and_cut_open(self):
        g = run()["geo"]
        self.assertGreater(g["terrain"]["n"], 30)
        self.assertEqual(g["terrain"]["bad"], [])
        c = g["cut"]
        self.assertEqual((c["terrain"], c["ground"], c["roads"]), (0, 0, 0), c)
        self.assertGreater(c["road"], 100, c)

    def test_no_props_in_cuttings(self):
        p = run()["props"]
        self.assertGreater(p["n"], 100)
        self.assertEqual(p["bad"], [])

    def test_city_avatar_in_the_tunnel(self):
        # games/hqcity3d.js: in the tunnel (world.js tunnelAt at your height) the ground and what blocks are the tunnel's,
        # never the airport's over it; the camera's floor and its ray stay down there
        with open(os.path.join(ROOT, "games", "hqcity3d.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("function inTunnel(x, z)", src)
        self.assertIn("var tu = inTunnel(x, z); if(tu) return WD.blockedAt(W, x, z, tu.y0)", src)
        self.assertIn("var tu = inTunnel(x, z); if(tu) return WD.groundAt(W, x, z, false, tu.y0)", src)
        self.assertIn("WD.rayGround(W, from, to, undefined, tunnelLevel())", src)
        self.assertIn("if(ty != null && WD.tunnelAt(W, x, z, ty)) return WD.groundAt(W, x, z, false, ty)", src)

    def test_old_worlds_unchanged(self):
        for o in run()["old"]:
            self.assertEqual(o, {"tunnels": 0, "under": False, "glow": False, "diff": 0})


if __name__ == "__main__":
    unittest.main()
