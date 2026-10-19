/* Claude HQ: geometry of the generated world (Arena City, claude-hq@1), pure.
 *
 * HQV.worldgeom turns the packed WorldDoc W (games/world.js) into plain objects of typed arrays
 * (metres) that games/worldbuild.js wraps in THREE meshes, in a worker or on the main thread.
 *   tileOf/tileKey        the world (2048 m) = 8 x 8 tiles of 256 m = 32 x 32 chunks of 64 m
 *   terrainTile           per chunk LOD 0|1|2 (8, 16, 32 m grid), skirts as deep as the LOD gap (>= 2 m), every
 *                         vertex pushed under every ribbon its cells reach (no triangle covers a road at any LOD)
 *   roadTile              asphalt / marks / kerb / walk ribbons by class, junction patches, zebra crossings
 *   buildingTile          one low-poly building per building lot (detail 0 full, detail 1 a box)
 *   props                 trees, lamps, parked cars, street-name signs, route gantries
 *   routes                graded routes (highway/ring chains) the gantries are placed along
 *   nameAtlasLayout       the cells of the sign/gantry text atlas (drawn by worldbuild)
 *   buildTile             one worker job: {tx, tz, lods, want} -> the tile message
 * Geo = {pos, nrm, col (rgb 0..1), idx: Uint32Array, bid? (lot id per vertex), lit? (0|1 per vertex)}.
 * Every face is wound counter-clockwise seen from the side its normal points to.
 * Frames: +y up, yaw 0 faces +z, facing (sin yaw, cos yaw); the left of a direction (dx, dz) is (dz, -dx).
 * A prop's `yaw` is the way its front (sign plate, lamp arm, car nose) faces.
 * Determinism: no Math.random; jitter from HQV.world.hash32 (FNV-1a 32) seeded by W.hash.
 * Pure: no THREE, no DOM at load time (node, a worker via importScripts and the page all load it).
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : self;
var HQV = root.HQV = root.HQV || {};

var ORIGIN = -1024, TILE = 256, CHUNK = 64, NT = 8, CPT = 4, FLOOR_H = 3.5, SKIRT = 2;
var LOD_STEP = [8, 16, 32];
var LIFT = 0.04, MARK_LIFT = 0.06, KERB = 0.15, FLAT = 0.005, SEAM = 0.02, MINSEG = 3;
var UP = [0, 1, 0];

var COL = {
  asphalt: [0.16, 0.165, 0.18], shoulder: [0.24, 0.24, 0.25], white: [0.92, 0.92, 0.88], yellow: [0.95, 0.74, 0.22],
  kerb: [0.68, 0.68, 0.66], walk: [0.56, 0.55, 0.52], walkAve: [0.62, 0.58, 0.52], verge: [0.33, 0.30, 0.25]
};
// terrain tint per district (legend name); unknown names fall back to "wild"
var TINT = {
  wild: [0.42, 0.55, 0.30], farmland: [0.62, 0.61, 0.36], forest: [0.22, 0.40, 0.22], plaza: [0.62, 0.60, 0.56],
  civic: [0.55, 0.57, 0.52], hq: [0.50, 0.52, 0.50], commercial: [0.48, 0.50, 0.48], residential: [0.42, 0.55, 0.34],
  park: [0.36, 0.58, 0.30], industrial: [0.47, 0.45, 0.40], street: [0.45, 0.47, 0.44]
};
var STYLE = {residential: "res", commercial: "com", industrial: "ind", civic: "civ"};
var WALLS = {
  res: [[0.80, 0.66, 0.52], [0.86, 0.76, 0.60], [0.72, 0.52, 0.42], [0.90, 0.84, 0.72], [0.76, 0.70, 0.62]],
  com: [[0.62, 0.66, 0.72], [0.70, 0.72, 0.74], [0.52, 0.56, 0.62], [0.78, 0.76, 0.70], [0.58, 0.62, 0.60]],
  ind: [[0.55, 0.55, 0.55], [0.50, 0.52, 0.54], [0.60, 0.58, 0.54]],
  civ: [[0.88, 0.86, 0.80], [0.82, 0.80, 0.74], [0.84, 0.82, 0.78]]
};
var ROOFS = {res: [[0.55, 0.28, 0.22], [0.40, 0.30, 0.28], [0.46, 0.36, 0.30]], com: [[0.35, 0.36, 0.38]],
             ind: [[0.42, 0.44, 0.46]], civ: [[0.50, 0.52, 0.50]]};
var GLASS = {res: [0.22, 0.27, 0.34], com: [0.30, 0.42, 0.52], ind: [0.30, 0.34, 0.36], civ: [0.24, 0.28, 0.32]};
var CAR_COLORS = [0xd94b3d, 0x3d6fd1, 0xf4f4f4, 0x2a2d33, 0xb8bcc2, 0x6fd38a, 0xffb347, 0x7b4fd0];

function WQ(){ return HQV.world; }
function clamp(v, a, b){ return v < a ? a : (v > b ? b : v); }
function hypot(x, z){ return Math.sqrt(x*x + z*z); }
function rng(seed){
  var a = seed >>> 0;
  return function(){
    a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0)/4294967296;
  };
}
function jit(c, r, amt){ var k = 1 + (r() - 0.5)*2*amt; return [clamp(c[0]*k, 0, 1), clamp(c[1]*k, 0, 1), clamp(c[2]*k, 0, 1)]; }

/* ---------- tiling ---------- */
function tileOf(x, z){
  return {tx: clamp(Math.floor((x - ORIGIN)/TILE), 0, NT - 1), tz: clamp(Math.floor((z - ORIGIN)/TILE), 0, NT - 1)};
}
function tileKey(tx, tz){ return tx + "," + tz; }
function inTile(x, z, tx, tz){
  var t = tileOf(x, z);
  return t.tx === tx && t.tz === tz;
}

/* ---------- Geo builder ---------- */
function geo(withBid, withLit){ return {p: [], n: [], c: [], i: [], b: withBid ? [] : null, l: withLit ? [] : null}; }
function vert(g, x, y, z, n, c, bid, lit){
  g.p.push(x, y, z); g.n.push(n[0], n[1], n[2]); g.c.push(c[0], c[1], c[2]);
  if(g.b) g.b.push(bid || 0);
  if(g.l) g.l.push(lit || 0);
  return g.p.length/3 - 1;
}
// Newell normal of a polygon given as [[x,y,z],...]
function newell(P){
  var nx = 0, ny = 0, nz = 0;
  for(var i = 0; i < P.length; i++){
    var a = P[i], b = P[(i + 1) % P.length];
    nx += (a[1] - b[1])*(a[2] + b[2]); ny += (a[2] - b[2])*(a[0] + b[0]); nz += (a[0] - b[0])*(a[1] + b[1]);
  }
  return [nx, ny, nz];
}
// a flat convex face (3 or 4 corners, either order); `hint` picks the side it faces
function face(g, P, c, hint, bid, lit){
  var n = newell(P), l = Math.sqrt(n[0]*n[0] + n[1]*n[1] + n[2]*n[2]);
  if(!(l > 1e-9)) return;
  n = [n[0]/l, n[1]/l, n[2]/l];
  if(hint && n[0]*hint[0] + n[1]*hint[1] + n[2]*hint[2] < 0){ P = P.slice().reverse(); n = [-n[0], -n[1], -n[2]]; }
  var base = g.p.length/3;
  for(var i = 0; i < P.length; i++) vert(g, P[i][0], P[i][1], P[i][2], n, c, bid, lit);
  for(var k = 1; k + 1 < P.length; k++) g.i.push(base, base + k, base + k + 1);
}
function fin(g){
  var o = {pos: new Float32Array(g.p), nrm: new Float32Array(g.n), col: new Float32Array(g.c), idx: new Uint32Array(g.i)};
  if(g.b) o.bid = new Float32Array(g.b);
  if(g.l) o.lit = new Float32Array(g.l);
  return o;
}
function emptyGeo(){ return fin(geo()); }

/* ---------- per-W cache: edges in metres, arms per node, trims ---------- */
var cacheW = null, cache = null;
function prep(W){
  if(cacheW === W && cache) return cache;
  var nodes = {}, inc = {}, E = [], byId = {};
  (W.nodes || []).forEach(function(n){ nodes[n.id] = {id: n.id, x: n.x/100, y: n.y/100, z: n.z/100}; });
  (W.edges || []).forEach(function(e, ei){
    var p = e.pts, m = p.length/3, P = [], S = [];
    for(var j = 0; j < m; j++){
      var q = {x: p[3*j]/100, y: p[3*j+1]/100, z: p[3*j+2]/100};
      if(P.length){
        var L = P[P.length - 1], d = hypot(q.x - L.x, q.z - L.z);
        if(d < 1e-6) continue;
        S.push(S[S.length - 1] + d);
      } else S.push(0);
      P.push(q);
    }
    if(P.length < 2) return;
    // interior points on a straight, evenly graded run (within 5 mm) need no ribbon station
    var K = P.map(function(q, j){
      if(j === 0 || j === P.length - 1) return true;
      var a = P[j - 1], c = P[j + 1], l1 = S[j] - S[j - 1], l2 = S[j + 1] - S[j];
      var cross = (q.x - a.x)*(c.z - q.z) - (q.z - a.z)*(c.x - q.x), dot = (q.x - a.x)*(c.x - q.x) + (q.z - a.z)*(c.z - q.z);
      return !(Math.abs(cross) < 1e-6*l1*l2 && dot > 0 && Math.abs(a.y + (c.y - a.y)*l1/(l1 + l2) - q.y) <= FLAT);
    });
    var walk = (e.walk || 0)/100, cls = e.cls === "country" ? "highway" : (e.cls || "street");
    var o = {id: e.id, i: ei, cls: cls, a: e.a, b: e.b, name: e.name || "", ref: e.ref != null ? e.ref : null,
             half: e.width/200, cw: (e.width - 2*(e.walk || 0))/200, walk: walk, P: P, S: S, K: K, len: S[S.length - 1], tA: 0, tB: 0};
    E.push(o); byId[o.id] = o;
    (inc[e.a] = inc[e.a] || []).push({E: o, end: 0});
    (inc[e.b] = inc[e.b] || []).push({E: o, end: 1});
  });
  var nodeIds = (W.nodes || []).map(function(n){ return n.id; });
  nodeIds.forEach(function(id){
    var arms = inc[id] || [];
    arms.forEach(function(a){
      var q = pointAt(a.E, a.end ? a.E.len - Math.min(3, a.E.len) : Math.min(3, a.E.len)), n = nodes[id] || a.E.P[a.end ? a.E.P.length - 1 : 0];
      var dx = q.x - n.x, dz = q.z - n.z, l = hypot(dx, dz) || 1;
      a.dx = dx/l; a.dz = dz/l; a.yaw = Math.atan2(a.dx, a.dz);
      a.t = 0;
    });
    if(arms.length >= 2) arms.forEach(function(a){
      var t = 0;
      arms.forEach(function(b){ if(b !== a) t = Math.max(t, armClear(a.E.half, b.E.half, a.dx*b.dx + a.dz*b.dz) + 0.3); });
      a.t = Math.min(t, TRIM_MAX, a.E.len*0.45);
      if(a.end) a.E.tB = a.t; else a.E.tA = a.t;
    });
    arms.sort(function(p, q){ return p.yaw - q.yaw || p.E.id - q.E.id; });
  });
  cacheW = W;
  cache = {nodes: nodes, inc: inc, E: E, byId: byId, nodeIds: nodeIds, props: null, routes: null, segs: null};
  return cache;
}
function deg(C, id){ return (C.inc[id] || []).length; }
// how far along arm a (half width ha) its edge facing arm b (half width hb) clears b's band, for arms whose unit
// directions have dot product `c`: the edge point (t, ha) sits hb from b's axis at t = (hb + ha cos)/sin; an obtuse
// pair is also clear once that point is behind b's start (t = ha sin/-cos)
var TRIM_MAX = 25;
function armClear(ha, hb, c){
  c = clamp(c, -1, 1);
  var s = Math.sqrt(1 - c*c);
  if(s < 1e-3) return c > 0 ? TRIM_MAX : 0;
  var t = (hb + ha*c)/s;
  if(c < 0) t = Math.min(t, ha*s/-c);
  return Math.max(0, t);
}

// the point at arc length s along an edge (or route) {P, S}: position, unit direction, left (dz, -dx)
function pointAt(E, s){
  var P = E.P, S = E.S, n = P.length;
  s = clamp(s, 0, S[n - 1]);
  var j = 0;
  while(j < n - 2 && S[j + 1] < s) j++;
  var a = P[j], b = P[j + 1], L = S[j + 1] - S[j], t = L > 0 ? (s - S[j])/L : 0;
  var dx = (b.x - a.x)/(L || 1), dz = (b.z - a.z)/(L || 1);
  return {x: a.x + (b.x - a.x)*t, y: a.y + (b.y - a.y)*t, z: a.z + (b.z - a.z)*t, dx: dx, dz: dz, lx: dz, lz: -dx};
}
// stations over [s0, s1]: the ends plus every interior polyline vertex, with mitred left vectors
// (interior points closer than MINSEG to the last kept station, and hairpin points, are skipped: they fold the ribbon)
function stations(E, s0, s1){
  var P = E.P, S = E.S, first = pointAt(E, s0), last = pointAt(E, s1), keep = [], ls = s0, prev = first;
  for(var j = 1; j < P.length - 1; j++){
    if(S[j] <= s0 + 0.01 || S[j] >= s1 - 0.01 || (E.K && !E.K[j])) continue;
    if(S[j] - ls < MINSEG || s1 - S[j] < MINSEG/2) continue;
    // a hairpin (turn > 90 deg) cannot carry a ribbon wider than its pieces: cut the corner
    var q = P[j], n = P[j + 1];
    if((q.x - prev.x)*(n.x - q.x) + (q.z - prev.z)*(n.z - q.z) < 0) continue;
    keep.push(j); ls = S[j]; prev = q;
  }
  var out = [first];
  keep.forEach(function(j, i){
    var a = i ? P[keep[i - 1]] : first, b = P[j], c = i + 1 < keep.length ? P[keep[i + 1]] : last;
    var d1 = hypot(b.x - a.x, b.z - a.z) || 1, d2 = hypot(c.x - b.x, c.z - b.z) || 1;
    var l1x = (b.z - a.z)/d1, l1z = -(b.x - a.x)/d1, l2x = (c.z - b.z)/d2, l2z = -(c.x - b.x)/d2;
    var mx = l1x + l2x, mz = l1z + l2z, ml = hypot(mx, mz) || 1;
    mx /= ml; mz /= ml;
    var k = 1/Math.max(0.5, mx*l1x + mz*l1z);
    out.push({x: b.x, y: b.y, z: b.z, dx: (c.x - a.x)/(d1 + d2), dz: (c.z - a.z)/(d1 + d2), lx: mx*k, lz: mz*k});
  });
  out.push(last);
  return out;
}

/* ---------- surface heights (the ONE road surface: HQV.world.roadY) ---------- */
// HQV.world.roadY at the vertex itself, moved onto the carriageway (walk false) or the sidewalk (walk true):
// roadY adds 0.15 where the point is sidewalk, so only the kerb step is corrected
function ySurf(W, x, z, walk){
  var Q = WQ(), y = Q.roadY(W, x, z);
  if(y == null){ var r = Q.nearestRoad(W, x, z, 12); return r ? r.y + (walk ? KERB : 0) : null; }
  var side = Q.surfaceAt(W, x, z) === "sidewalk";
  return y + (walk && !side ? KERB : (!walk && side ? -KERB : 0));
}
// carriageway y at the station point offset o (m, + = left). Where roadY disagrees with this edge's own
// surface (an inner-bend seam of a graded road, another road's overlap) the edge's own y keeps the ribbon whole.
function yRoad(W, E, st, o){
  var y = ySurf(W, st.x + st.lx*o, st.z + st.lz*o, false);
  return y != null && Math.abs(y - st.y) <= SEAM ? y : st.y;
}
// sidewalk y at offset o
function yWalk(W, E, st, o){
  var y = ySurf(W, st.x + st.lx*o, st.z + st.lz*o, true);
  return y != null && Math.abs(y - st.y - KERB) <= SEAM ? y : st.y + KERB;
}
function at(st, o, y){ return [st.x + st.lx*o, y, st.z + st.lz*o]; }

/* ---------- terrain ---------- */
function tint(name){ return TINT[name] || TINT.wild; }
// The road clamp. A terrain vertex shapes only its star (the six grid triangles around it: the hexagon
// (s,0) (0,s) (-s,s) (-s,0) (0,-s) (s,-s) for the split used below), and a triangle is linear, so the terrain stays
// under a planar ribbon piece wherever they overlap as soon as every vertex whose star overlaps that piece sits under
// the piece's plane (extended). The pieces: every upward asphalt / sidewalk triangle the road tiles draw (exact) and
// every polyline segment's band +-half, flat across and graded along (covers junctions and cut hairpin corners).
// Unlike a minimum over a window this follows a graded road's slope, so it never digs trenches beside one.
var CELL = 32, PIECE_GAP = 0.01;
function clampPieces(W){
  var C = prep(W);
  if(C.pieces) return C.pieces;
  var grid = {}, all = [];
  function add(P, y0, gx, gz){   // P: convex [[x, z], ...]; plane y = y0 + gx*x + gz*z (margin already in y0)
    var x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, A = [];
    P.forEach(function(q){ x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); z0 = Math.min(z0, q[1]); z1 = Math.max(z1, q[1]); });
    for(var k = 0; k < P.length; k++){
      var p = P[k], q = P[(k + 1) % P.length], nx = q[1] - p[1], nz = p[0] - q[0], l = hypot(nx, nz);
      if(l > 1e-9) A.push([nx/l, nz/l]);
    }
    var o = {P: P, A: A, y0: y0, gx: gx, gz: gz, x0: x0, x1: x1, z0: z0, z1: z1, seen: -1};
    all.push(o);
    for(var j = Math.floor(z0/CELL); j <= Math.floor(z1/CELL); j++)
      for(var i = Math.floor(x0/CELL); i <= Math.floor(x1/CELL); i++) (grid[i + "," + j] = grid[i + "," + j] || []).push(o);
  }
  C.E.forEach(function(E){
    for(var j = 0; j + 1 < E.P.length; j++){
      var a = E.P[j], b = E.P[j + 1], d = hypot(b.x - a.x, b.z - a.z), h = E.half;
      if(d < 1e-6) continue;
      var ux = (b.x - a.x)/d, uz = (b.z - a.z)/d, g = (b.y - a.y)/d, gx = g*ux, gz = g*uz;
      add([[a.x + uz*h, a.z - ux*h], [b.x + uz*h, b.z - ux*h], [b.x - uz*h, b.z + ux*h], [a.x - uz*h, a.z + ux*h]],
          a.y - gx*a.x - gz*a.z - 0.05 - SEAM, gx, gz);
    }
  });
  for(var tz = 0; tz < NT; tz++) for(var tx = 0; tx < NT; tx++){
    var r = roadTile(W, tx, tz, true);
    [r.asphalt, r.walk].forEach(function(g){
      var p = g.pos;
      for(var t = 0; t < g.idx.length; t += 3){
        var ia = 3*g.idx[t], ib = 3*g.idx[t+1], ic = 3*g.idx[t+2];
        var ux = p[ib] - p[ia], uy = p[ib+1] - p[ia+1], uz = p[ib+2] - p[ia+2], vx = p[ic] - p[ia], vy = p[ic+1] - p[ia+1], vz = p[ic+2] - p[ia+2];
        var nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx;
        if(!(Math.abs(ny) > 0.5*Math.sqrt(nx*nx + ny*ny + nz*nz))) continue;   // upward pieces only
        var gx = -nx/ny, gz = -nz/ny;
        add([[p[ia], p[ia+2]], [p[ib], p[ib+2]], [p[ic], p[ic+2]]], p[ia+1] - gx*p[ia] - gz*p[ia+2] - LIFT - 0.05, gx, gz);
      }
    });
  }
  C.pieces = {grid: grid, n: 0};
  return C.pieces;
}
var STAR = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]], STAR_AXES = [[1, 0], [0, 1], [Math.SQRT1_2, Math.SQRT1_2]];
// separating-axis test: does convex piece o overlap the star of (x, z) at spacing s (by more than PIECE_GAP)?
function starHits(o, x, z, s){
  function apart(ax){
    var a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity, k;
    for(k = 0; k < 6; k++){ var v = (x + STAR[k][0]*s)*ax[0] + (z + STAR[k][1]*s)*ax[1]; a0 = Math.min(a0, v); a1 = Math.max(a1, v); }
    for(k = 0; k < o.P.length; k++){ var w = o.P[k][0]*ax[0] + o.P[k][1]*ax[1]; b0 = Math.min(b0, w); b1 = Math.max(b1, w); }
    return a1 < b0 + PIECE_GAP || b1 < a0 + PIECE_GAP;
  }
  for(var k = 0; k < 3; k++) if(apart(STAR_AXES[k])) return false;
  for(k = 0; k < o.A.length; k++) if(apart(o.A[k])) return false;
  return true;
}
// the terrain height of a grid vertex with spacing `step`: the ground, pushed under the plane of every road piece
// its star overlaps (memoised per W: tiles, skirts and road verges all read the same vertices)
function terrainY(W, x, z, step){
  var C = prep(W), memo = C.ty || (C.ty = {}), key = step + ":" + x + "," + z;
  if(key in memo) return memo[key];
  var S = clampPieces(W), y = WQ().groundAt(W, x, z), stamp = ++S.n;
  for(var j = Math.floor((z - step)/CELL); j <= Math.floor((z + step)/CELL); j++)
    for(var i = Math.floor((x - step)/CELL); i <= Math.floor((x + step)/CELL); i++){
      var L = S.grid[i + "," + j];
      if(!L) continue;
      for(var k = 0; k < L.length; k++){
        var o = L[k];
        if(o.seen === stamp) continue;
        o.seen = stamp;
        if(o.x1 < x - step || o.x0 > x + step || o.z1 < z - step || o.z0 > z + step || !starHits(o, x, z, step)) continue;
        y = Math.min(y, o.y0 + o.gx*x + o.gz*z);
      }
    }
  return (memo[key] = y);
}
// the terrain mesh height at (x, z) for a uniform lod (the grid's two triangles per cell, as terrainTile splits them)
function meshY(W, x, z, lod){
  var step = LOD_STEP[lod], n = 2*(-ORIGIN)/step;
  var i = clamp(Math.floor((x - ORIGIN)/step), 0, n - 1), j = clamp(Math.floor((z - ORIGIN)/step), 0, n - 1);
  var x0 = ORIGIN + i*step, z0 = ORIGIN + j*step, fx = (x - x0)/step, fz = (z - z0)/step;
  var ya = terrainY(W, x0, z0, step), yb = terrainY(W, x0, z0 + step, step), yc = terrainY(W, x0 + step, z0, step);
  if(fx + fz <= 1) return ya + (yc - ya)*fx + (yb - ya)*fz;
  var yd = terrainY(W, x0 + step, z0 + step, step);
  return yd + (yb - yd)*(1 - fx) + (yc - yd)*(1 - fz);
}
// the lowest terrain mesh (any lod) along the line p -> q, sampled every <= 2 m
function meshMin(W, p, q){
  var n = Math.max(1, Math.ceil(hypot(q[0] - p[0], q[2] - p[2])/2)), lo = Infinity;
  for(var k = 0; k <= n; k++){
    var x = p[0] + (q[0] - p[0])*k/n, z = p[2] + (q[2] - p[2])*k/n;
    for(var l = 0; l < 3; l++) lo = Math.min(lo, meshY(W, x, z, l));
  }
  return lo;
}
// the deepest gap along a chunk edge (from x, z, n8 steps of 8 m in direction dx, dz) between the edge lines of
// any two LODs: a skirt that deep closes the crack to any neighbour
function skirtDepth(W, x, z, dx, dz, memo){
  var lines = LOD_STEP.map(function(step){
    var m = CHUNK/step, ys = [];
    for(var k = 0; k <= m; k++){
      var px = x + dx*k*step, pz = z + dz*k*step, key = step + ":" + px + "," + pz;
      if(!(key in memo)) memo[key] = terrainY(W, px, pz, step);
      ys.push(memo[key]);
    }
    return ys;
  });
  function lineAt(l, d){   // d in metres along the edge
    var step = LOD_STEP[l], k = Math.min(Math.floor(d/step), CHUNK/step - 1), f = (d - k*step)/step;
    return lines[l][k] + (lines[l][k + 1] - lines[l][k])*f;
  }
  var gap = 0;
  for(var d = 0; d <= CHUNK; d += LOD_STEP[0]){
    var a = lineAt(0, d), b = lineAt(1, d), c = lineAt(2, d);
    gap = Math.max(gap, Math.abs(a - b), Math.abs(a - c), Math.abs(b - c));
  }
  return Math.max(SKIRT, Math.ceil((gap + 0.25)*4)/4);
}
function terrainTile(W, tx, tz, lods){
  var Q = WQ(), g = geo(), x0 = ORIGIN + tx*TILE, z0 = ORIGIN + tz*TILE, memo = {};
  for(var cz = 0; cz < CPT; cz++) for(var cx = 0; cx < CPT; cx++){
    var lod = clamp((lods && lods[cz*CPT + cx])|0, 0, 2), step = LOD_STEP[lod], n = CHUNK/step;
    var bx = x0 + cx*CHUNK, bz = z0 + cz*CHUNK, base = g.p.length/3;
    var top = [];
    for(var j = 0; j <= n; j++) for(var i = 0; i <= n; i++){
      var x = bx + i*step, z = bz + j*step, key = step + ":" + x + "," + z;
      var y = key in memo ? memo[key] : (memo[key] = terrainY(W, x, z, step));
      var hl = Q.heightAt(W, x - step, z), hr = Q.heightAt(W, x + step, z), hb = Q.heightAt(W, x, z - step), hf = Q.heightAt(W, x, z + step);
      var gx = (hr - hl)/(2*step), gz = (hf - hb)/(2*step), nl = Math.sqrt(gx*gx + 1 + gz*gz);
      var nrm = [-gx/nl, 1/nl, -gz/nl];
      var c = tint(Q.districtAt(W, x, z).name), ix = Math.round(x/8), iz = Math.round(z/8);
      var hh = (Math.imul(ix, 73856093) ^ Math.imul(iz, 19349663)) >>> 0;
      var k = (1 - Math.min(0.45, (1 - nrm[1])*4)) * (0.96 + (hh % 1000)/1000*0.08);
      vert(g, x, y, z, nrm, [clamp(c[0]*k, 0, 1), clamp(c[1]*k, 0, 1), clamp(c[2]*k, 0, 1)]);
      top.push([x, y, z]);
    }
    var w = n + 1;
    for(j = 0; j < n; j++) for(i = 0; i < n; i++){
      var a = base + j*w + i, b = a + w, c2 = a + 1, d = b + 1;
      g.i.push(a, b, c2, c2, b, d);
    }
    // skirts: one quad per edge step, facing out of the chunk, as deep as the worst LOD gap on that edge (>= 2 m)
    var sides = [[0, 0, 1, 0, [0, 0, -1], bx, bz], [0, n, 1, 0, [0, 0, 1], bx, bz + CHUNK],
                 [0, 0, 0, 1, [-1, 0, 0], bx, bz], [n, 0, 0, 1, [1, 0, 0], bx + CHUNK, bz]];
    sides.forEach(function(sd){
      var depth = skirtDepth(W, sd[5], sd[6], sd[2], sd[3], memo);
      for(var k2 = 0; k2 < n; k2++){
        var i0 = sd[0] + sd[2]*k2, j0 = sd[1] + sd[3]*k2, i1 = i0 + sd[2], j1 = j0 + sd[3];
        var ta = top[j0*w + i0], tb = top[j1*w + i1];
        skirtQuad(g, base + j0*w + i0, base + j1*w + i1, ta, tb, sd[4], depth);
      }
    });
  }
  return fin(g);
}
// a skirt quad below the top edge (ia, ib); reuses the top vertices, adds two bottom ones
function skirtQuad(g, ia, ib, ta, tb, out, depth){
  var na = [g.n[3*ia], g.n[3*ia+1], g.n[3*ia+2]], nb = [g.n[3*ib], g.n[3*ib+1], g.n[3*ib+2]];
  var ca = [g.c[3*ia], g.c[3*ia+1], g.c[3*ia+2]], cb = [g.c[3*ib], g.c[3*ib+1], g.c[3*ib+2]];
  var ua = vert(g, ta[0], ta[1] - depth, ta[2], na, ca), ub = vert(g, tb[0], tb[1] - depth, tb[2], nb, cb);
  // winding (ia, ua, ib): normal = (ua - ia) x (ib - ia) = (0,-d,0) x (e) ; flip when it points inward
  var ex = tb[0] - ta[0], ez = tb[2] - ta[2];
  var nx = -ez, nz = ex;   // (0,-1,0) x (ex,0,ez) = (-ez, 0, ex)
  if(nx*out[0] + nz*out[2] >= 0) g.i.push(ia, ua, ib, ib, ua, ub);
  else g.i.push(ia, ib, ua, ib, ub, ua);
}

/* ---------- roads ---------- */
function markLines(E){
  var cw = E.cw;
  if(E.cls === "street") return [{o: 0, w: 0.12, dash: true, c: COL.white}];
  if(E.cls === "avenue") return [{o: -0.15, w: 0.1, c: COL.yellow}, {o: 0.15, w: 0.1, c: COL.yellow}];
  if(E.cls === "ring") return [{o: 0, w: 0.12, dash: true, c: COL.white}, {o: -(cw - 1), w: 0.15, c: COL.white}, {o: cw - 1, w: 0.15, c: COL.white}];
  return [{o: -0.15, w: 0.1, c: COL.yellow}, {o: 0.15, w: 0.1, c: COL.yellow}, {o: -(cw - 1), w: 0.15, c: COL.white}, {o: cw - 1, w: 0.15, c: COL.white}];
}
function graded(E){ return E.cls === "highway" || E.cls === "ring"; }
function crossed(C, E, end){ return (E.cls === "street" || E.cls === "avenue") && deg(C, end ? E.b : E.a) >= 3; }

// a flat strip between offsets o0..o1 over the stations; only the pieces whose centre is in the tile
function strip(g, W, E, st, o0, o1, lift, c, tx, tz, walkY){
  for(var k = 0; k + 1 < st.length; k++){
    var A = st[k], B = st[k + 1];
    if(tx != null && !inTile((A.x + B.x)/2, (A.z + B.z)/2, tx, tz)) continue;
    var yf = walkY ? yWalk : yRoad;
    face(g, [at(A, o0, yf(W, E, A, o0) + lift), at(B, o0, yf(W, E, B, o0) + lift),
             at(B, o1, yf(W, E, B, o1) + lift), at(A, o1, yf(W, E, A, o1) + lift)], c, UP);
  }
}
// a vertical strip at offset o: a kerb from road up to walk, else a verge from the ribbon edge down 0.5 m, or
// further, to 0.3 m under the lowest terrain mesh (any lod) along that edge, so no gap opens under the ribbon
function wallStrip(g, W, E, st, o, mode, c, tx, tz, outSign){
  for(var k = 0; k + 1 < st.length; k++){
    var A = st[k], B = st[k + 1];
    if(!inTile((A.x + B.x)/2, (A.z + B.z)/2, tx, tz)) continue;
    var ya0, ya1, yb0, yb1;
    if(mode === "kerb"){
      ya0 = yRoad(W, E, A, o) + LIFT - 0.02; yb0 = yRoad(W, E, B, o) + LIFT - 0.02;
      ya1 = yWalk(W, E, A, o) + LIFT; yb1 = yWalk(W, E, B, o) + LIFT;
    } else {
      var yf = mode === "walkout" ? yWalk : yRoad, lo = meshMin(W, at(A, o, 0), at(B, o, 0)) - 0.3;
      ya1 = yf(W, E, A, o) + LIFT; yb1 = yf(W, E, B, o) + LIFT; ya0 = Math.min(ya1 - 0.5, lo); yb0 = Math.min(yb1 - 0.5, lo);
    }
    var hx = (A.lx + B.lx)/2*outSign, hz = (A.lz + B.lz)/2*outSign;
    face(g, [at(A, o, ya0), at(B, o, yb0), at(B, o, yb1), at(A, o, ya1)], c, [hx, 0, hz]);
  }
}

// flat: only the upward asphalt / sidewalk pieces (what the terrain clamp needs; no walls, no marks)
function roadTile(W, tx, tz, flat){
  var C = prep(W), asph = geo(), marks = geo(), kerb = geo(), walk = geo();
  C.E.forEach(function(E){
    var s0 = E.tA, s1 = E.len - E.tB;
    if(s1 - s0 < 0.05) return;
    var st = stations(E, s0, s1), cw = E.cw;
    // quick reject: no station pair in this tile
    var any = false;
    for(var k = 0; k + 1 < st.length && !any; k++) any = inTile((st[k].x + st[k+1].x)/2, (st[k].z + st[k+1].z)/2, tx, tz);
    if(!any) return;
    if(graded(E) && cw > 1.5){
      strip(asph, W, E, st, -(cw - 1), cw - 1, LIFT, COL.asphalt, tx, tz);
      strip(asph, W, E, st, -cw, -(cw - 1), LIFT, COL.shoulder, tx, tz);
      strip(asph, W, E, st, cw - 1, cw, LIFT, COL.shoulder, tx, tz);
    } else strip(asph, W, E, st, -cw, cw, LIFT, COL.asphalt, tx, tz);
    if(E.walk > 0){
      var wc = E.cls === "avenue" ? COL.walkAve : COL.walk;
      [-1, 1].forEach(function(sg){
        strip(walk, W, E, st, sg*cw, sg*E.half, LIFT, wc, tx, tz, true);
        if(flat) return;
        wallStrip(kerb, W, E, st, sg*cw, "kerb", COL.kerb, tx, tz, -sg);
        wallStrip(walk, W, E, st, sg*E.half, "walkout", COL.verge, tx, tz, sg);
      });
      // end caps of the raised sidewalk where it stops at a junction
      if(!flat) [[E.tA, s0, -1], [E.tB, s1, 1]].forEach(function(cp){
        if(!(cp[0] > 0)) return;
        var S = pointAt(E, cp[1]);
        if(!inTile(S.x, S.z, tx, tz)) return;
        [-1, 1].forEach(function(sg){
          var yr = yRoad(W, E, S, sg*cw) + LIFT - 0.02, yw = yWalk(W, E, S, sg*(cw + E.half)/2) + LIFT;
          face(kerb, [at(S, sg*cw, yr), at(S, sg*E.half, yr), at(S, sg*E.half, yw), at(S, sg*cw, yw)], COL.kerb, [S.dx*cp[2], 0, S.dz*cp[2]]);
        });
      });
    } else if(!flat){
      [-1, 1].forEach(function(sg){ wallStrip(walk, W, E, st, sg*cw, "verge", COL.verge, tx, tz, sg); });
    }
    if(flat) return;
    // markings, stopped short of junction patches and crossings
    var m0 = s0 + (crossed(C, E, 0) ? 5.5 : 0.5), m1 = s1 - (crossed(C, E, 1) ? 5.5 : 0.5);
    if(m1 - m0 > 0.5) markLines(E).forEach(function(ln){
      if(!ln.dash){ strip(marks, W, E, stations(E, m0, m1), ln.o - ln.w/2, ln.o + ln.w/2, MARK_LIFT, ln.c, tx, tz); return; }
      for(var d = Math.ceil(m0/9)*9; d < m1; d += 9){
        var a = Math.max(d, m0), b = Math.min(d + 3, m1);
        if(b - a > 0.2) strip(marks, W, E, stations(E, a, b), ln.o - ln.w/2, ln.o + ln.w/2, MARK_LIFT, ln.c, tx, tz);
      }
    });
  });
  // junction patches, corner sidewalks, zebra crossings: by the tile holding the node
  C.nodeIds.forEach(function(id){
    var arms = C.inc[id] || [], n = C.nodes[id];
    if(arms.length < 2 || !n || !inTile(n.x, n.z, tx, tz)) return;
    junction(W, C, n, arms, asph, flat ? geo() : marks, kerb, walk);
  });
  return {asphalt: fin(asph), marks: fin(marks), kerb: fin(kerb), walk: fin(walk)};
}

function armStation(E, end, t){
  var S = pointAt(E, end ? E.len - t : t);
  if(end){ S.dx = -S.dx; S.dz = -S.dz; S.lx = -S.lx; S.lz = -S.lz; }   // arm frame: d points away from the node
  return S;
}
function junction(W, C, n, arms, asph, marks, kerb, walk){
  var Q = WQ(), ring = [];
  arms.forEach(function(a){
    var S = armStation(a.E, a.end, a.t);
    a.S = S;
    ring.push(at(S, -a.E.cw, 0), at(S, a.E.cw, 0));
  });
  function yAt(p, up){
    var y = Q.roadY(W, p[0], p[2]);
    if(y == null){ var r = Q.nearestRoad(W, p[0], p[2], 20); y = r ? r.y : n.y; }
    return y + (up || 0);
  }
  var cy = yAt([n.x, 0, n.z]) + LIFT;
  ring.forEach(function(p){ p[1] = yAt(p) + LIFT; });
  for(var k = 0; k < ring.length; k++){
    var p = ring[k], q = ring[(k + 1) % ring.length];
    face(asph, [[n.x, cy, n.z], p, q], COL.asphalt, UP);
  }
  // corner sidewalks between consecutive arms (a's left faces b, b's right faces a)
  for(k = 0; k < arms.length; k++){
    var a = arms[k], b = arms[(k + 1) % arms.length];
    if(!(a.E.walk > 0 || b.E.walk > 0)) continue;
    var Sa = a.S, Sb = b.S;
    var ain = at(Sa, a.E.cw, 0), aout = at(Sa, a.E.half, 0), bout = at(Sb, -b.E.half, 0), bin = at(Sb, -b.E.cw, 0);
    var wy = function(P){ var r = Q.nearestRoad(W, P[0], P[2], 20); return (r ? r.y : n.y) + KERB + LIFT; };
    var yi = wy(ain), yo = wy(aout), yj = wy(bout), yk = wy(bin);
    face(walk, [[ain[0], yi, ain[2]], [aout[0], yo, aout[2]], [bout[0], yj, bout[2]], [bin[0], yk, bin[2]]], COL.walk, UP);
    face(kerb, [[ain[0], yi, ain[2]], [bin[0], yk, bin[2]], [bin[0], yAt(bin) + LIFT - 0.02, bin[2]], [ain[0], yAt(ain) + LIFT - 0.02, ain[2]]],
         COL.kerb, [n.x - (ain[0] + bin[0])/2, 0, n.z - (ain[2] + bin[2])/2]);
  }
  // zebra crossings on street/avenue arms of real junctions, 2 m back from the patch
  if(arms.length >= 3) arms.forEach(function(a){
    var E = a.E;
    if(E.cls !== "street" && E.cls !== "avenue") return;
    var c0 = a.t + 2, c1 = a.t + 5;
    if(c1 > E.len - 1) return;
    var st = a.end ? stations(E, E.len - c1, E.len - c0) : stations(E, c0, c1);
    var nS = Math.max(1, Math.floor((2*E.cw - 0.6)/1.0)), span = (nS - 1)*1.0;
    for(var i = 0; i < nS; i++){
      var o = -span/2 + i;
      strip(marks, W, E, st, o - 0.25, o + 0.25, MARK_LIFT, COL.white, null, null);
    }
  });
}

/* ---------- buildings ---------- */
function styleOf(W, lot){
  var leg = (W.districts && W.districts.legend) || [];
  return STYLE[leg[lot.district]] || "com";
}
// world point from the building's local frame: u along the long axis, v across it
function framer(R){
  var lx = R.x1 - R.x0, lz = R.z1 - R.z0, alongX = lx >= lz;
  return {
    alongX: alongX, U: alongX ? lx : lz, V: alongX ? lz : lx,
    p: function(u, y, v){ return alongX ? [R.x0 + u, y, R.z0 + v] : [R.x0 + v, y, R.z0 + u]; },
    d: function(du, dy, dv){ return alongX ? [du, dy, dv] : [dv, dy, du]; }
  };
}
function walls(g, R, yb, yt, c, bid){
  face(g, [[R.x0, yb, R.z0], [R.x1, yb, R.z0], [R.x1, yt, R.z0], [R.x0, yt, R.z0]], c, [0, 0, -1], bid);
  face(g, [[R.x0, yb, R.z1], [R.x1, yb, R.z1], [R.x1, yt, R.z1], [R.x0, yt, R.z1]], c, [0, 0, 1], bid);
  face(g, [[R.x0, yb, R.z0], [R.x0, yb, R.z1], [R.x0, yt, R.z1], [R.x0, yt, R.z0]], c, [-1, 0, 0], bid);
  face(g, [[R.x1, yb, R.z0], [R.x1, yb, R.z1], [R.x1, yt, R.z1], [R.x1, yt, R.z0]], c, [1, 0, 0], bid);
}
function flatRoof(g, R, y, c, bid){ face(g, [[R.x0, y, R.z0], [R.x1, y, R.z0], [R.x1, y, R.z1], [R.x0, y, R.z1]], c, UP, bid); }
function boxFaces(g, x0, x1, y0, y1, z0, z1, c, bid, top){
  walls(g, {x0: x0, x1: x1, z0: z0, z1: z1}, y0, y1, c, bid);
  if(top) flatRoof(g, {x0: x0, x1: x1, z0: z0, z1: z1}, y1, c, bid);
}

// the 4 walls as (origin, along-unit, outward, length) for windows
function wallList(R){
  return [
    {o: [R.x0, R.z0], u: [1, 0], out: [0, -1], L: R.x1 - R.x0},
    {o: [R.x1, R.z1], u: [-1, 0], out: [0, 1], L: R.x1 - R.x0},
    {o: [R.x0, R.z1], u: [0, -1], out: [-1, 0], L: R.z1 - R.z0},
    {o: [R.x1, R.z0], u: [0, 1], out: [1, 0], L: R.z1 - R.z0}
  ];
}
function windowQuad(g, wl, u0, u1, y0, y1, c, bid, lit){
  var ox = wl.o[0] + wl.out[0]*0.04, oz = wl.o[1] + wl.out[1]*0.04;
  var ax = ox + wl.u[0]*u0, az = oz + wl.u[1]*u0, bx = ox + wl.u[0]*u1, bz = oz + wl.u[1]*u1;
  face(g, [[ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az]], c, [wl.out[0], 0, wl.out[1]], bid, lit);
}

function building(W, lot, detail, body, win){
  var Q = WQ(), R = Q.buildingRect(lot);
  if(!(R.x1 - R.x0 > 0.5 && R.z1 - R.z0 > 0.5)) return;
  var ys = [Q.groundAt(W, R.x0, R.z0), Q.groundAt(W, R.x1, R.z0), Q.groundAt(W, R.x0, R.z1), Q.groundAt(W, R.x1, R.z1)];
  var gy = Math.max.apply(null, ys), yb = Math.min.apply(null, ys) - 1;
  var floors = Math.max(1, lot.floors|0), yt = gy + floors*FLOOR_H, bid = +lot.id || 0;
  var style = styleOf(W, lot), r = rng(Q.hash32(W.hash + ":lot:" + lot.id));
  var pal = WALLS[style], wc = jit(pal[Math.floor(r()*pal.length)], r, 0.06);
  var rp = ROOFS[style], rc = jit(rp[Math.floor(r()*rp.length)], r, 0.06);
  walls(body, R, yb, yt, wc, bid);
  if(detail){ flatRoof(body, R, yt, rc, bid); return; }
  var F = framer(R), U = F.U, V = F.V;
  if(style === "res"){
    var rh = Math.min(3, 0.35*V), ry = yt + rh;
    face(body, [F.p(0, yt, 0), F.p(U, yt, 0), F.p(U, ry, V/2), F.p(0, ry, V/2)], rc, F.d(0, 1, -1), bid);
    face(body, [F.p(0, yt, V), F.p(U, yt, V), F.p(U, ry, V/2), F.p(0, ry, V/2)], rc, F.d(0, 1, 1), bid);
    face(body, [F.p(0, yt, 0), F.p(0, yt, V), F.p(0, ry, V/2)], wc, F.d(-1, 0, 0), bid);
    face(body, [F.p(U, yt, 0), F.p(U, yt, V), F.p(U, ry, V/2)], wc, F.d(1, 0, 0), bid);
  } else if(style === "ind"){
    var nT = Math.max(2, Math.round(U/7)), tw = U/nT, th = 1.8;
    for(var t = 0; t < nT; t++){
      var ua = t*tw, ub = ua + tw;
      face(body, [F.p(ua, yt, 0), F.p(ua, yt, V), F.p(ub, yt + th, V), F.p(ub, yt + th, 0)], rc, F.d(-1, 2, 0), bid);
      face(win, [F.p(ub, yt, 0), F.p(ub, yt + th, 0), F.p(ub, yt + th, V), F.p(ub, yt, V)], GLASS.ind, F.d(1, 0, 0), bid, r() < 0.5 ? 1 : 0);
      face(body, [F.p(ua, yt, 0), F.p(ub, yt, 0), F.p(ub, yt + th, 0)], wc, F.d(0, 0, -1), bid);
      face(body, [F.p(ua, yt, V), F.p(ub, yt, V), F.p(ub, yt + th, V)], wc, F.d(0, 0, 1), bid);
    }
  } else {
    flatRoof(body, R, yt, rc, bid);
    if(style === "civ"){
      // a portico on the door side: columns and a lintel, inside the lot
      var front = lot.facing === "south" ? -1 : 1, zf = front > 0 ? R.z1 : R.z0, zc = zf + front*0.75;
      var ch = Math.min(floors*FLOOR_H, 7), nC = Math.max(4, Math.floor((R.x1 - R.x0)/3)), dx = (R.x1 - R.x0 - 1)/(nC - 1);
      for(var ci = 0; ci < nC; ci++){
        var cx = R.x0 + 0.5 + ci*dx;
        boxFaces(body, cx - 0.25, cx + 0.25, gy - 0.2, gy + ch, zc - 0.25, zc + 0.25, wc, bid, false);
      }
      var za = Math.min(zf, zc + front*0.4), zb = Math.max(zf, zc + front*0.4);
      boxFaces(body, R.x0 + 0.1, R.x1 - 0.1, gy + ch, gy + ch + 0.5, za, zb, wc, bid, true);
    }
  }
  // windows
  var glass = GLASS[style];
  wallList(R).forEach(function(wl){
    for(var f = 0; f < floors; f++){
      var fy = gy + f*FLOOR_H;
      if(style === "com"){
        if(wl.L > 1.4) windowQuad(win, wl, 0.5, wl.L - 0.5, fy + 0.9, fy + 2.7, glass, bid, r() < 0.6 ? 1 : 0);
        continue;
      }
      var bay = style === "ind" ? 5 : 3, ww = style === "ind" ? 2.2 : (style === "civ" ? 1.4 : 1.3);
      var y0 = fy + (style === "civ" ? 0.8 : 1.0), y1 = fy + (style === "civ" ? 2.8 : 2.4);
      var nb = Math.floor((wl.L - 1)/bay);
      if(nb < 1) continue;
      var bw = (wl.L - 1)/nb;
      for(var k = 0; k < nb; k++){
        var uc = 0.5 + (k + 0.5)*bw;
        windowQuad(win, wl, uc - ww/2, uc + ww/2, y0, y1, glass, bid, r() < 0.45 ? 1 : 0);
      }
    }
  });
}

function buildingTile(W, tx, tz, detail){
  var body = geo(true), win = geo(true, true);
  (W.lots || []).forEach(function(lot){
    if(lot.kind !== "building" || !inTile(lot.x/100, lot.z/100, tx, tz)) return;
    building(W, lot, detail ? 1 : 0, body, win);
  });
  return {body: fin(body), win: fin(win)};
}

/* ---------- graded routes (for gantries) ---------- */
function gateCmp(a, b){
  var ha = a.x < 0 || (a.x === 0 && a.z < 0), hb = b.x < 0 || (b.x === 0 && b.z < 0);
  if(ha !== hb) return ha ? -1 : 1;
  var c = a.x*b.z - a.z*b.x;
  return c < 0 ? -1 : (c > 0 ? 1 : 0);
}
function routes(W){
  var C = prep(W);
  if(C.routes) return C.routes;
  var groups = {}, order = [];
  C.E.forEach(function(E){
    if(!graded(E)) return;
    var key = E.cls + "|" + (E.ref != null ? E.ref : "~" + E.name);
    if(!groups[key]){ groups[key] = []; order.push(key); }
    groups[key].push(E);
  });
  // gates: graded dead ends, numbered in the generator's order (integer comparator, 3.1.2)
  var gates = [];
  C.E.forEach(function(E){
    if(!graded(E)) return;
    [E.a, E.b].forEach(function(id){ if(deg(C, id) === 1 && C.nodes[id] && gates.indexOf(id) < 0) gates.push(id); });
  });
  gates.sort(function(a, b){
    var A = C.nodes[a], B = C.nodes[b];
    return gateCmp({x: Math.round(A.x*100), z: Math.round(A.z*100)}, {x: Math.round(B.x*100), z: Math.round(B.z*100)}) || a - b;
  });
  var out = [];
  order.forEach(function(key){
    var es = groups[key], at = {}, used = {};
    es.forEach(function(E){ (at[E.a] = at[E.a] || []).push(E); (at[E.b] = at[E.b] || []).push(E); });
    function walk(node, E){
      var chain = [], start = node;
      while(E && !used[E.id]){
        used[E.id] = true;
        var fwd = E.a === node;
        chain.push({E: E, fwd: fwd});
        node = fwd ? E.b : E.a;
        E = (at[node] || []).filter(function(f){ return !used[f.id]; })[0] || null;
      }
      return {chain: chain, start: start, end: node};
    }
    var comps = [];
    es.forEach(function(E){ [E.a, E.b].forEach(function(nd){ if(!used[E.id] && at[nd].length === 1) comps.push(walk(nd, E)); }); });
    es.forEach(function(E){ if(!used[E.id]) comps.push(walk(E.a, E)); });
    comps.forEach(function(cp){ out.push(route(C, key, cp, gates)); });
  });
  C.routes = out;
  return out;
}
function route(C, key, cp, gates){
  var first = cp.chain[0].E, cls = first.cls, loop = cp.start === cp.end;
  var ns = C.nodes[cp.start], ne = C.nodes[cp.end];
  // highways run from the outer end toward the city centre
  if(cls !== "ring" && !loop && ns && ne && hypot(ns.x, ns.z) < hypot(ne.x, ne.z)){
    cp = {chain: cp.chain.slice().reverse().map(function(c){ return {E: c.E, fwd: !c.fwd}; }), start: cp.end, end: cp.start};
  }
  var P = [], S = [], nodes = [{id: cp.start, s: 0}], node = cp.start;
  cp.chain.forEach(function(c){
    var pts = c.fwd ? c.E.P : c.E.P.slice().reverse();
    pts.forEach(function(q){
      if(P.length){
        var L = P[P.length - 1], d = hypot(q.x - L.x, q.z - L.z);
        if(d < 1e-6) return;
        S.push(S[S.length - 1] + d);
      } else S.push(0);
      P.push(q);
    });
    node = c.fwd ? c.E.b : c.E.a;
    nodes.push({id: node, s: S[S.length - 1]});
  });
  var ref = first.ref != null ? first.ref : null, label = ref != null ? ref : first.name, gate = 0;
  var m = /^H(\d+)$/.exec(ref || "");
  if(m) gate = +m[1];
  else if(gates.length){
    var gi = gates.indexOf(cp.start);
    if(gi < 0){
      var s0 = C.nodes[cp.start] || P[0], bd = Infinity;
      gates.forEach(function(g, i){ var G = C.nodes[g], d = hypot(G.x - s0.x, G.z - s0.z); if(d < bd){ bd = d; gi = i; } });
    }
    gate = gi + 1;
  }
  return {key: key, cls: cls, ref: ref, label: label, name: first.name, loop: loop, P: P, S: S, len: S[S.length - 1] || 0,
          nodes: nodes, gate: gate, edges: cp.chain.map(function(c){ return c.E.id; })};
}
// where traffic on route Rt going `dir` from s is headed: "City", "Gate k", or the next highway's ref (ring)
function destOf(C, Rt, s, dir){
  if(Rt.cls !== "ring") return dir > 0 ? "City" : "Gate " + Rt.gate;
  var ns = Rt.nodes, n = ns.length, best = null;
  for(var pass = 0; pass < 2 && !best; pass++){
    for(var k = 0; k < n && !best; k++){
      var e = ns[dir > 0 ? k : n - 1 - k], ds = dir > 0 ? e.s - s : s - e.s;
      if(pass === 1 && Rt.loop) ds += Rt.len;
      if(ds <= 1) continue;
      var hw = (C.inc[e.id] || []).filter(function(a){ return a.E.cls === "highway"; })[0];
      if(hw) best = hw.E.ref != null ? hw.E.ref : hw.E.name;
    }
    if(!Rt.loop) break;
  }
  return best || "City";
}
var GANTRY_POST = 6.3, GANTRY_SINK = 3;
function gantryAt(W, C, Rt, s, dir, kind, frame){
  var Q = WQ(), L = Rt.len;
  if(Rt.loop) s = ((s % L) + L) % L;
  var p = pointAt(Rt, s), dest = destOf(C, Rt, s, dir), o = GANTRY_POST;
  var text = Rt.cls === "ring" ? Rt.label + " → " + dest : Rt.label + " " + dest;
  // the ground under the two posts (+-GANTRY_POST along the road's left); the frame's posts reach GANTRY_SINK below y
  var g1 = Q.groundAt(W, p.x + p.lx*o, p.z + p.lz*o), g2 = Q.groundAt(W, p.x - p.lx*o, p.z - p.lz*o);
  return {x: p.x, y: Q.groundAt(W, p.x, p.z), z: p.z, yaw: Math.atan2(-dir*p.dx, -dir*p.dz), ref: Rt.ref, text: text,
          dir: dir, kind: kind, frame: !!frame, route: Rt.key, s: s, postLow: Math.min(g1, g2), postHigh: Math.max(g1, g2)};
}
function gantries(W, C){
  var out = [];
  routes(W).forEach(function(Rt){
    var appr = [];
    Rt.nodes.forEach(function(e, i){
      if(Rt.loop && i === Rt.nodes.length - 1) return;   // a loop's end is its start
      if(deg(C, e.id) < 3) return;
      if(Rt.loop || e.s > 0.5) appr.push(gantryAt(W, C, Rt, Rt.loop || e.s >= 60 ? e.s - 60 : e.s/2, 1, "approach", true));
      if(Rt.loop || e.s < Rt.len - 0.5) appr.push(gantryAt(W, C, Rt, Rt.loop || Rt.len - e.s >= 60 ? e.s + 60 : (e.s + Rt.len)/2, -1, "approach", true));
    });
    // junctions only metres apart (graded edges split at every junction, some 8-11 m long) would stack approach frames:
    // a plate repeating a kept one (same direction and text) within 30 m is dropped; any other plate within 15 m of a
    // kept frame hangs on that frame instead of getting its own
    var kept = [];
    appr.forEach(function(g){
      function near(h, r){ return hypot(h.x - g.x, h.z - g.z) < r; }
      if(kept.some(function(h){ return h.dir === g.dir && h.text === g.text && near(h, 30); })) return;
      var host = kept.filter(function(h){ return h.frame && near(h, 15); })[0];
      if(host){ g.frame = false; g.x = host.x; g.y = host.y; g.z = host.z; g.postLow = host.postLow; g.postHigh = host.postHigh; }
      kept.push(g);
    });
    appr = kept;
    // a periodic pair shares one frame across the road; it slides (up to 90 m) to stay 30 m clear of every approach
    // frame, which it would otherwise overlap, and is dropped only when no such spot exists
    function clear(s){
      return (Rt.loop || (s > 0 && s < Rt.len)) &&
        !appr.some(function(a){ var d = Math.abs(a.s - s); if(Rt.loop) d = Math.min(d, Rt.len - d); return d < 30; });
    }
    for(var k = 1; 400*k < Rt.len; k++){
      var s = [0, 30, -30, 60, -60, 90, -90].map(function(o){ return 400*k + o; }).filter(clear)[0];
      if(s == null) continue;
      out.push(gantryAt(W, C, Rt, s, 1, "period", true));
      out.push(gantryAt(W, C, Rt, s, -1, "period", false));
    }
    out = out.concat(appr);
  });
  return out;
}

/* ---------- props ---------- */
function allProps(W){
  var C = prep(W);
  if(C.props) return C.props;
  var Q = WQ(), B = {}, hash = W.hash;
  function put(kind, o){
    var t = tileOf(o.x, o.z), k = tileKey(t.tx, t.tz);
    var b = B[k] || (B[k] = {trees: [], lamps: [], parked: [], signs: [], gantries: []});
    b[kind].push(o);
  }
  Q.trees(W).forEach(function(t){ put("trees", {x: t.x, y: Q.groundAt(W, t.x, t.z), z: t.z, s: t.s, kind: t.kind}); });
  C.E.forEach(function(E){
    if(E.walk > 0 && (E.cls === "street" || E.cls === "avenue")){
      // lamps every 30 m on both sidewalks, staggered by 15 m
      [1, -1].forEach(function(sg){
        for(var s = E.tA + 6 + (sg < 0 ? 15 : 0); s < E.len - E.tB - 6; s += 30){
          var p = pointAt(E, s), o = sg*(E.half - 0.35), x = p.x + p.lx*o, z = p.z + p.lz*o;
          put("lamps", {x: x, y: Q.groundAt(W, x, z), z: z, yaw: Math.atan2(-sg*p.lx, -sg*p.lz)});
        }
      });
    }
    if(E.walk > 0 && E.cls === "street"){
      // parked cars: 7 m slots, both kerbs, residential/commercial frontage, never near a junction or an HQ lot
      for(var k = 0, s2; (s2 = 12 + 3.5 + 7*k) <= E.len - 12 - 3.5; k++){
        [1, -1].forEach(function(sg){
          var p = pointAt(E, s2), px = p.x + p.lx*sg*(E.half + 4), pz = p.z + p.lz*sg*(E.half + 4);
          var dn = Q.districtAt(W, px, pz).name;
          if(dn !== "residential" && dn !== "commercial") return;
          var lot = Q.lotAt(W, px, pz);
          if(lot && lot.kind === "hq") return;
          var h = Q.hash32(hash + ":park:" + E.id + ":" + k + ":" + sg);
          if(h/4294967296 >= 0.25) return;
          var o = sg*(E.cw - 0.95), x = p.x + p.lx*o, z = p.z + p.lz*o;
          put("parked", {x: x, y: Q.groundAt(W, x, z), z: z, yaw: Math.atan2(sg*p.dx, sg*p.dz), color: CAR_COLORS[(h >>> 8) % CAR_COLORS.length]});
        });
      }
    }
  });
  C.nodeIds.forEach(function(id){
    var arms = C.inc[id] || [];
    if(arms.length < 3) return;
    arms.forEach(function(a, i){
      var E = a.E, o = E.walk > 0 ? E.cw + E.walk/2 : E.cw + 0.8, d = Math.max(4, a.t + 0.5);
      // the plate stands at offset o (beyond the edge a.t was cut for): clear of every other arm at that offset too
      arms.forEach(function(b){ if(b !== a) d = Math.max(d, armClear(o, b.E.half, a.dx*b.dx + a.dz*b.dz) + 0.5); });
      // street-name plate on the approaching driver's right-hand kerb (the arm's left), facing that driver;
      // slid back along the arm while it would still stand on a carriageway
      var S, x, z;
      for(;;){
        if(d > E.len - 0.5) d = E.len/2;
        S = armStation(E, a.end, d); x = S.x + S.lx*o; z = S.z + S.lz*o;
        if(d >= E.len/2 || Q.surfaceAt(W, x, z) !== "road") break;
        d += 0.5;
      }
      put("signs", {x: x, y: Q.groundAt(W, x, z), z: z, yaw: Math.atan2(S.dx, S.dz), name: E.name, ref: E.ref, edge: E.id, node: id});
      // corner lamp between this arm and the next (this arm's left side)
      if(E.walk > 0 && (E.cls === "street" || E.cls === "avenue")){
        var C2 = armStation(E, a.end, Math.min(a.t + 0.8, E.len/2)), lo = E.half - 0.35;
        var lx = C2.x + C2.lx*lo, lz = C2.z + C2.lz*lo;
        put("lamps", {x: lx, y: Q.groundAt(W, lx, lz), z: lz, yaw: Math.atan2(-C2.lx, -C2.lz)});
      }
    });
  });
  gantries(W, C).forEach(function(g){ put("gantries", g); });
  C.props = B;
  return B;
}
function props(W, tx, tz){
  var b = allProps(W)[tileKey(tx, tz)];
  function cp(a){ return a ? a.map(function(o){ var c = {}; for(var k in o) c[k] = o[k]; return c; }) : []; }
  return {trees: cp(b && b.trees), lamps: cp(b && b.lamps), parked: cp(b && b.parked), signs: cp(b && b.signs), gantries: cp(b && b.gantries)};
}

/* ---------- the text atlas (layout only; worldbuild draws it) ---------- */
function nameAtlasLayout(names){
  var index = {}, n = 0;
  (names || []).forEach(function(s){
    if(typeof s !== "string" || Object.prototype.hasOwnProperty.call(index, s)) return;
    index[s] = n++;
  });
  var cols = 8;
  return {cols: cols, rows: Math.max(1, Math.ceil(n/cols)), cell: {w: 256, h: 48}, index: index};
}

/* ---------- one worker job ---------- */
function buildTile(W, m){
  m = m || {};
  var tx = clamp(m.tx|0, 0, NT - 1), tz = clamp(m.tz|0, 0, NT - 1), want = m.want || [], out = {op: "tile", id: m.id, tx: tx, tz: tz};
  if(want.indexOf("terrain") >= 0){ out.terrain = terrainTile(W, tx, tz, m.lods || []); out.lods = (m.lods || []).slice(); }
  if(want.indexOf("roads") >= 0) out.roads = roadTile(W, tx, tz);
  if(want.indexOf("buildings0") >= 0) out.buildings0 = buildingTile(W, tx, tz, 0);
  if(want.indexOf("buildings1") >= 0) out.buildings1 = buildingTile(W, tx, tz, 1);
  if(want.indexOf("props") >= 0) out.props = props(W, tx, tz);
  return out;
}
// every typed-array buffer in a tile message (for postMessage transfer)
function transferables(o, list){
  list = list || [];
  if(!o || typeof o !== "object") return list;
  if(ArrayBuffer.isView(o)){ if(list.indexOf(o.buffer) < 0) list.push(o.buffer); return list; }
  if(Array.isArray(o)) return list;   // props arrays hold plain objects only
  for(var k in o) if(Object.prototype.hasOwnProperty.call(o, k)) transferables(o[k], list);
  return list;
}

HQV.worldgeom = {
  ORIGIN: ORIGIN, TILE: TILE, CHUNK: CHUNK, NT: NT, LOD_STEP: LOD_STEP, FLOOR_H: FLOOR_H, LIFT: LIFT, MARK_LIFT: MARK_LIFT,
  tileOf: tileOf, tileKey: tileKey, terrainTile: terrainTile, roadTile: roadTile, buildingTile: buildingTile,
  props: props, routes: routes, nameAtlasLayout: nameAtlasLayout, buildTile: buildTile, transferables: transferables,
  emptyGeo: emptyGeo, CAR_COLORS: CAR_COLORS, GANTRY_POST: GANTRY_POST, GANTRY_SINK: GANTRY_SINK
};
})();
