/* Claude HQ: geometry of the generated world (Arena City claude-hq@1, organic claude-hq@2 and islands), pure.
 *
 * HQV.worldgeom turns the packed WorldDoc W (games/world.js) into plain objects of typed arrays
 * (metres) that games/worldbuild.js wraps in THREE meshes, in a worker or on the main thread.
 *   tileOf/tileKey        the world (2048 m) = 8 x 8 tiles of 256 m = 32 x 32 chunks of 64 m
 *   terrainTile           per chunk LOD 0|1|2 (8, 16, 32 m grid), skirts as deep as the LOD gap (>= 2 m), every
 *                         vertex pushed under every ribbon, pavement and beach its cells reach (no triangle covers
 *                         a road at any LOD); on an island, terrain below sea_cm + 0.1 m (or on the river's water)
 *                         sinks 0.5 m under the sea, and under a bridge it is the ground, never the deck
 *   roadTile              asphalt / marks / kerb / walk ribbons by class, junction patches, zebra crossings
 *   groundTile            (v2 docs) polygon block pavements with kerbs, lot pads, plaza pads, the beach strip along
 *                         Layers.island.coast (not across the river's mouth) and the shaded banks along Layers.river.poly;
 *                         polygons are triangulated by `triangulate` (earcut, inline)
 *   riverWater            the river's water surface: Layers.river.poly at sea level, one mesh for the world
 *   bridges               a bridge edge (bridge: true) is a deck: roadTile adds `bridge` (slab, fascias, abutments and
 *                         railings) for the tiles it crosses and drops the ribbon's verge walls over the water, so no
 *                         curtain hangs down to the riverbed
 *   buildingTile          one low-poly building per building lot (detail 0 full, detail 1 a box), turned to the
 *                         lot's `front` (Q16, else its `facing`) and fitted inside its `poly` when it has one;
 *                         a lot with neither is axis-aligned in its rect (@1)
 *   props                 trees, lamps, parked cars, street-name signs, route gantries
 *   routes                graded routes (highway/ring chains) the gantries are placed along
 *   nameAtlasLayout       the cells of the sign/gantry text atlas (drawn by worldbuild)
 *   view/tierDiff         min_tier: the world as a city tier shows it, and the tiles (per product) two tiers differ in
 *   buildTile             one worker job: {tx, tz, lods, want, tier?} -> the tile message
 * HQ 3.15 (@3 docs; a doc without these layers builds exactly as before):
 *   holes                 every terrain hole (HQV.world.holesOf: metro entrances and portals, the Island Link portal) is
 *                         cut out of the terrain, road and ground tiles in plan (cutHoles: triangle minus hole, a clean
 *                         edge, the surface unchanged elsewhere; skirts and kerbs in a hole dropped); the stair well and
 *                         trench walls inside are games/hqmetro.js's. The terrain under a hole's rim is the street
 *                         (HQV.world.streetAt), never the hole's floor; no lamp, sign or parked car stands in a hole
 *   waterGeo              lakes, canals and the marina (HQV.world.waterOf): the surface (one geo, islands cut out, `lit`
 *                         1 on a lake for the calm lake shader), quay walls with coping and mooring rings, the breakwater,
 *                         lily pads and reeds (works) and shore foam; a bank body's shore strip is a ground item
 *   tramEdges             the edges a tram runs on (as games/traffic.js picks them): their marks are the tram lanes' two
 *                         white edge lines instead of a centre line
 * HQ 3.21 city life (games/citylife.js, when it is loaded; without it every path builds exactly as before):
 *   buildings             each window's lit attribute is HQV.cityLife.litCode for the lot's use (the shaders light it
 *                         by the hour), a detail-1 body carries the use code (2 + use) for its shader rows; at detail 0
 *                         the ground floor's front shows the lot's ground use (a shopfront with an awning and a sign,
 *                         a cafe's striped awning, a lobby's tall glazed entrance, a loading bay's roller shutter) and a
 *                         flat roof gets its clutter (AC units, a stair housing, an antenna, a homes' water tank)
 *   props.furniture       HQV.cityLife.furniture on the ground: [{kind, x, y, z, yaw, c? (a stall's canopy, a cafe
 *                         table's parasol: rgb 0..1)}]
 * A @1 doc (no poly, front, min_tier or island) takes the original paths and builds byte-identically.
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
// v2 ground: pads sit PAD over their block's pavement; the beach runs BEACH_IN inland and BEACH_OUT out to sea from
// the coast in steps of <= BEACH_STEP; terrain below sea + SEA_SHORE sinks to at least SEA_HIDE under the water
var PAD = 0.04, BEACH_IN = 14, BEACH_OUT = 8, BEACH_STEP = 8, BEACH_WET = 0.4, SEA_SHORE = 0.1, SEA_HIDE = 0.5;
// the river: its banks run BANK_IN up the land and BANK_OUT into the water (inside the 4 m the generator keeps clear of
// streets, lots and sites), and stop BANK_MOUTH m short of the coast, where the beach takes over; the water sits
// RIVER_LIFT over sea level: the river is calm water (games/ocean.js RIVER_Y, the same number), over the sea's highest
// crest, so the waving sea plane under it never shows through; the banks meet it there. A bridge's deck is DECK_T deep
// with a parapet PARA_W wide and PARA_H high outside its walk, a rail on posts every POST_STEP m RAIL_H up, abutments
// ABUT m into each bank from the water's edge; WET_STEP m sampling finds where the edge is over the water
var BANK_IN = 3, BANK_OUT = 3, BANK_MOUTH = BEACH_IN + 2, RIVER_LIFT = 0.3;
var DECK_T = 0.9, PARA_W = 0.25, PARA_H = 0.35, RAIL_H = 1.05, RAIL_T = 0.08, POST_STEP = 3, POST_W = 0.1, ABUT = 1.5, WET_STEP = 0.5;
var UP = [0, 1, 0];

var COL = {
  asphalt: [0.16, 0.165, 0.18], shoulder: [0.24, 0.24, 0.25], white: [0.92, 0.92, 0.88], yellow: [0.95, 0.74, 0.22],
  kerb: [0.68, 0.68, 0.66], walk: [0.56, 0.55, 0.52], walkAve: [0.62, 0.58, 0.52], verge: [0.33, 0.30, 0.25],
  pave: [0.60, 0.59, 0.56], lawn: [0.38, 0.55, 0.30], plaza: [0.70, 0.66, 0.58], concrete: [0.56, 0.56, 0.55],
  sand: [0.86, 0.80, 0.62], wetSand: [0.62, 0.57, 0.45],
  bank: [0.56, 0.52, 0.40], wetBank: [0.40, 0.37, 0.29], water: [0.14, 0.40, 0.50],
  deck: [0.64, 0.63, 0.60], deckUnder: [0.42, 0.42, 0.41], rail: [0.34, 0.37, 0.41]
};
// terrain tint per district (legend name); unknown names fall back to "wild". The second row is @2's district list.
var TINT = {
  wild: [0.42, 0.55, 0.30], farmland: [0.62, 0.61, 0.36], forest: [0.22, 0.40, 0.22], plaza: [0.62, 0.60, 0.56],
  civic: [0.55, 0.57, 0.52], hq: [0.50, 0.52, 0.50], commercial: [0.48, 0.50, 0.48], residential: [0.42, 0.55, 0.34],
  park: [0.36, 0.58, 0.30], industrial: [0.47, 0.45, 0.40], street: [0.45, 0.47, 0.44],
  oldtown: [0.52, 0.52, 0.44], downtown: [0.50, 0.51, 0.50], suburb: [0.42, 0.55, 0.34], office: [0.49, 0.51, 0.49],
  tech: [0.44, 0.54, 0.38], studio: [0.50, 0.49, 0.43], finance: [0.50, 0.51, 0.52], biotech: [0.45, 0.54, 0.42],
  media: [0.49, 0.50, 0.47], logistics: [0.47, 0.45, 0.40], farm: [0.62, 0.61, 0.36], water: [0.30, 0.42, 0.46]
};
var STYLE = {residential: "res", commercial: "com", industrial: "ind", civic: "civ",
             oldtown: "res", downtown: "com", suburb: "res", office: "com", tech: "com", studio: "ind", finance: "com",
             biotech: "civ", media: "com", logistics: "ind", farm: "ind"};
// block pavements in these districts are lawn (gardens, parks, fields); every other block is paved
var GREEN = {residential: 1, suburb: 1, park: 1, forest: 1, wild: 1, farmland: 1, farm: 1, tech: 1};
var WALLS = {
  res: [[0.80, 0.66, 0.52], [0.86, 0.76, 0.60], [0.72, 0.52, 0.42], [0.90, 0.84, 0.72], [0.76, 0.70, 0.62]],
  com: [[0.62, 0.66, 0.72], [0.70, 0.72, 0.74], [0.52, 0.56, 0.62], [0.78, 0.76, 0.70], [0.58, 0.62, 0.60]],
  ind: [[0.55, 0.55, 0.55], [0.50, 0.52, 0.54], [0.60, 0.58, 0.54]],
  civ: [[0.88, 0.86, 0.80], [0.82, 0.80, 0.74], [0.84, 0.82, 0.78]]
};
var ROOFS = {res: [[0.55, 0.28, 0.22], [0.40, 0.30, 0.28], [0.46, 0.36, 0.30]], com: [[0.35, 0.36, 0.38]],
             ind: [[0.42, 0.44, 0.46]], civ: [[0.50, 0.52, 0.50]]};
var GLASS = {res: [0.22, 0.27, 0.34], com: [0.30, 0.42, 0.52], ind: [0.30, 0.34, 0.36], civ: [0.24, 0.28, 0.32]};
// city life: shopfront glass, awnings (and a stall's canopy, a cafe's parasol), rooftop clutter
var SHOP_GLASS = [0.46, 0.56, 0.60], AWNINGS = [[0.72, 0.16, 0.14], [0.14, 0.42, 0.28], [0.16, 0.30, 0.56], [0.86, 0.50, 0.12],
  [0.10, 0.50, 0.52], [0.46, 0.14, 0.22], [0.88, 0.74, 0.20], [0.30, 0.30, 0.32]], CREAM = [0.93, 0.90, 0.82];
var FASCIA = [0.20, 0.21, 0.23], SHUTTER = [[0.60, 0.61, 0.62], [0.50, 0.51, 0.53]], ROOFKIT = {ac: [0.74, 0.75, 0.76], tank: [0.52, 0.47, 0.40], mast: [0.28, 0.29, 0.31]};
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
// one entry per W; the tier views of one world (view below) share the list, so switching tiers keeps both warm.
// A W that is not a view of the same world empties it.
var CACHES = [];
function prep(W){
  for(var ci = CACHES.length - 1; ci >= 0; ci--) if(CACHES[ci].W === W) return CACHES[ci].C;
  var baseW = W.tierBase || W;
  CACHES = CACHES.filter(function(c){ return (c.W.tierBase || c.W) === baseW; }).slice(-3);
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
    if(e.bridge) o.bridge = true;
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
  var cache = {nodes: nodes, inc: inc, E: E, byId: byId, nodeIds: nodeIds, props: null, routes: null, segs: null};
  CACHES.push({W: W, C: cache});
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
  first.s = s0; last.s = s1;
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
    out.push({x: b.x, y: b.y, z: b.z, dx: (c.x - a.x)/(d1 + d2), dz: (c.z - a.z)/(d1 + d2), lx: mx*k, lz: mz*k, s: S[j]});
  });
  out.push(last);
  return out;
}

/* ---------- surface heights (the ONE road surface: HQV.world.roadY) ---------- */
// the ground at street level: HQV.world.groundAt, but over a terrain hole (@3) the street, not the hole's floor
function gY(W, x, z){ var Q = WQ(); return Q.streetAt ? Q.streetAt(W, x, z) : Q.groundAt(W, x, z); }
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
  function add(P, y0, gx, gz, own){   // P: convex [[x, z], ...]; plane y = y0 + gx*x + gz*z (margin already in y0)
    var x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, A = [];
    P.forEach(function(q){ x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); z0 = Math.min(z0, q[1]); z1 = Math.max(z1, q[1]); });
    for(var k = 0; k < P.length; k++){
      var p = P[k], q = P[(k + 1) % P.length], nx = q[1] - p[1], nz = p[0] - q[0], l = hypot(nx, nz);
      if(l > 1e-9) A.push([nx/l, nz/l]);
    }
    var o = {P: P, A: A, y0: y0, gx: gx, gz: gz, x0: x0, x1: x1, z0: z0, z1: z1, seen: -1, own: !!own};
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
  // v2 ground: every pavement, pad and beach triangle as drawn (none in a @1 doc). A river bank's pieces are `own`: at
  // the finest lod they push down only the land vertices inside them (terrainY). A bank is a 3 m strip on a slope
  // steeper than it, and its plane carried out over a land vertex's whole 8 m star dug the land beside the river under
  // the water and left the strip afloat. The coarse lods keep the star test: a 16 or 32 m triangle from the land into
  // the river must stay under the water, and from afar a trench does not show.
  groundItems(W).forEach(function(it){
    for(var t = 0; t < it.tri.length; t += 3){
      var a = it.V[it.tri[t]], b = it.V[it.tri[t+1]], c = it.V[it.tri[t+2]];
      var ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      var nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx;
      if(!(Math.abs(ny) > 0.5*Math.sqrt(nx*nx + ny*ny + nz*nz))) continue;
      var gx = -nx/ny, gz = -nz/ny;
      add([[a[0], a[2]], [b[0], b[2]], [c[0], c[2]]], a[1] - gx*a[0] - gz*a[2] - LIFT - 0.05, gx, gz, it.kind === "bank");
    }
  });
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
// is (x, z) within half the width of a bridge edge (bounding boxes first)? groundAt there is the deck, not the ground
function onBridge(W, x, z){
  var C = prep(W);
  if(!C.bridges){
    C.bridges = C.E.filter(function(E){ return E.bridge; }).map(function(E){
      var b = [Infinity, Infinity, -Infinity, -Infinity];
      E.P.forEach(function(q){ b[0] = Math.min(b[0], q.x); b[1] = Math.min(b[1], q.z); b[2] = Math.max(b[2], q.x); b[3] = Math.max(b[3], q.z); });
      return {E: E, b: [b[0] - E.half, b[1] - E.half, b[2] + E.half, b[3] + E.half]};
    });
  }
  for(var i = 0; i < C.bridges.length; i++){
    var o = C.bridges[i], P = o.E.P, h = o.E.half;
    if(x < o.b[0] || z < o.b[1] || x > o.b[2] || z > o.b[3]) continue;
    for(var j = 0; j + 1 < P.length; j++){
      var a = P[j], c = P[j + 1], dx = c.x - a.x, dz = c.z - a.z, L2 = dx*dx + dz*dz;
      var t = L2 > 0 ? clamp(((x - a.x)*dx + (z - a.z)*dz)/L2, 0, 1) : 0;
      if(hypot(x - a.x - dx*t, z - a.z - dz*t) <= h) return true;
    }
  }
  return false;
}
// the terrain height of a grid vertex with spacing `step`: the ground, pushed under the plane of every road piece
// its star overlaps (memoised per W: tiles, skirts and road verges all read the same vertices). Under a bridge the
// ground is the raw terrain (heightAt), never the deck groundAt reports there: the terrain must not rise to the deck
// over the river (a wedge out of the water) or at its ends (a mound on the low bank).
function terrainY(W, x, z, step){
  var C = prep(W), memo = C.ty || (C.ty = {}), key = step + ":" + x + "," + z;
  if(key in memo) return memo[key];
  var S = clampPieces(W), y = onBridge(W, x, z) ? WQ().heightAt(W, x, z) : gY(W, x, z), stamp = ++S.n;
  var B = W.tierBase || W, wet = !!(B.river && WQ().riverAt(B, x, z)), fine = step === LOD_STEP[0] && !wet;
  for(var j = Math.floor((z - step)/CELL); j <= Math.floor((z + step)/CELL); j++)
    for(var i = Math.floor((x - step)/CELL); i <= Math.floor((x + step)/CELL); i++){
      var L = S.grid[i + "," + j];
      if(!L) continue;
      for(var k = 0; k < L.length; k++){
        var o = L[k];
        if(o.seen === stamp) continue;
        o.seen = stamp;
        if(o.x1 < x - step || o.x0 > x + step || o.z1 < z - step || o.z0 > z + step) continue;
        if(o.own && fine ? !inPoly(o.P, x, z) : !starHits(o, x, z, step)) continue;
        y = Math.min(y, o.y0 + o.gx*x + o.gz*z);
      }
    }
  var sea = seaY(W);
  if(sea != null && (y < sea + SEA_SHORE || wet)) y = Math.min(y, sea - SEA_HIDE);   // the river's water too
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
  // @3: the terrain holes (metro entrances and portals) are cut out of the tile
  var H = holeSet(W);
  if(H) cutHoles(g, H.filter(function(h){ return boxHit(h.b, {x0: x0 - 1, x1: x0 + TILE + 1, z0: z0 - 1, z1: z0 + TILE + 1}); }));
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
// @2's classes: a local road is marked and furnished like a street, an arterial like an avenue
function streetish(cls){ return cls === "street" || cls === "local"; }
function aveish(cls){ return cls === "avenue" || cls === "arterial"; }
// [3.20.1] lanes each way on a carriageway `cw` m from centre to kerb: one per 3.3 m, two or three on @3's avenues
// and boulevards (traffic.js lanesEach drives in them the same way)
function lanesEach(cw){ return Math.max(1, Math.min(3, Math.floor(cw/3.3))); }
function laneLines(cw){ var n = lanesEach(cw), out = [];
  for(var k = 1; k < n; k++) out.push({o: -cw*k/n, w: 0.12, dash: true, c: COL.white}, {o: cw*k/n, w: 0.12, dash: true, c: COL.white});
  return out; }
function markLines(E){
  var cw = E.cw;
  if(streetish(E.cls)) return [{o: 0, w: 0.12, dash: true, c: COL.white}].concat(laneLines(cw));
  if(aveish(E.cls)) return [{o: -0.15, w: 0.1, c: COL.yellow}, {o: 0.15, w: 0.1, c: COL.yellow}].concat(laneLines(cw));
  if(E.cls === "ring") return [{o: 0, w: 0.12, dash: true, c: COL.white}, {o: -(cw - 1), w: 0.15, c: COL.white}, {o: cw - 1, w: 0.15, c: COL.white}];
  return [{o: -0.15, w: 0.1, c: COL.yellow}, {o: 0.15, w: 0.1, c: COL.yellow}, {o: -(cw - 1), w: 0.15, c: COL.white}, {o: cw - 1, w: 0.15, c: COL.white}];
}
// A street a tram runs on (tramEdges) has no centre line: the tram's two lanes take the middle (traffic.js tramOff,
// 1.475 m each side of the centre, a 2.65 m body), so it gets their two edge lines TRAM_EDGE m outside each lane, in
// white, and a ring or highway keeps its outer edge lines; nothing yellow is left under a tram.
var TRAM_INNER = 0.15, TRAM_W = 2.65, TRAM_EDGE = 0.15, TRAM_TIER = 5;
function tramLines(W, E){
  var off = tramOffOf(W, E), o = off + TRAM_W/2 + TRAM_EDGE, cw = E.cw, out = [];
  if(o + 0.06 <= cw - 0.15) out.push({o: -o, w: 0.12, c: COL.white}, {o: o, w: 0.12, c: COL.white});
  if((E.cls === "ring" || E.cls === "highway") && cw - 1 > o + 0.3) out.push({o: -(cw - 1), w: 0.15, c: COL.white}, {o: cw - 1, w: 0.15, c: COL.white});
  return out;
}
// the tram lane's offset on E: games/traffic.js lanes(W, tier) when it is loaded (the page; never in the worker: the
// same number either way), else the one traffic.js drives on (its inner gap + half the body)
function tramOffOf(W, E){
  var C = prep(W), T = HQV.traffic;
  if(C.lanes === undefined){
    C.lanes = null;
    if(T && typeof T.lanes === "function"){
      try {
        var L = T.lanes(W.tierBase || W, W.tier != null ? W.tier : TRAM_TIER), by = {};
        (Array.isArray(L) ? L : []).forEach(function(o){ if(o && o.id != null) by[o.id] = o; });
        C.lanes = by;
      } catch(e){ C.lanes = null; }
    }
  }
  var r = C.lanes ? C.lanes[E.id] : null;
  return r && r.tramOff != null && isFinite(+r.tramOff) && +r.tramOff > 0 ? +r.tramOff : TRAM_INNER + TRAM_W/2;
}
// {edge id: true} for every edge a tram runs on, exactly as games/traffic.js create() picks them: the doc's transit
// lines of kind "tram" open at the tier (every city is tier 5 since HQ 3.15, D1; a tier view keeps its own), each
// consecutive pair of path nodes joined by the open edge between them that is an arterial before a non-arterial, then
// the shorter; a line that misses a link is dropped whole; a path not closed and with no edge back runs out and back
function tramEdges(W){
  var C = prep(W);
  if(C.tram) return C.tram;
  var B = W.tierBase || W, set = {}, lines = (B.transit && B.transit.lines) || [], tier = W.tier != null ? +W.tier : TRAM_TIER;
  if(lines.some(function(l){ return l && l.kind === "tram"; })){
    var nodes = {}, inc = {}, ART = {arterial: 1, avenue: 1, highway: 1, ring: 1};
    (B.nodes || []).forEach(function(n){ nodes[n.id] = n; inc[n.id] = []; });
    (B.edges || []).forEach(function(e){
      if(e.min_tier != null && (e.min_tier|0) > tier) return;
      var A = nodes[e.a], Bn = nodes[e.b];
      if(!A || !Bn || e.a === e.b) return;
      var p = e.pts || [], len = 0;
      if(p.length >= 6) for(var j = 3; j + 2 < p.length; j += 3) len += hypot((p[j] - p[j-3])/100, (p[j+2] - p[j-1])/100);
      else len = hypot((Bn.x - A.x)/100, (Bn.z - A.z)/100);
      if(len < 1) return;
      var o = {id: e.id, a: e.a, b: e.b, art: !!ART[e.cls === "country" ? "highway" : e.cls], len: len};
      inc[e.a].push(o); inc[e.b].push(o);
    });
    var between = function(u, v){
      var best = null;
      (inc[u] || []).forEach(function(E){
        if((E.a === u && E.b === v) || (E.b === u && E.a === v)) if(!best || (E.art && !best.art) || (E.art === best.art && E.len < best.len)) best = E;
      });
      return best;
    };
    lines.forEach(function(l){
      if(!l || l.kind !== "tram" || (l.tier|0) > tier) return;
      var path = (l.path || []).slice();
      if(path.length < 2) return;
      if(path[0] === path[path.length - 1]) path.pop();
      else if(!between(path[path.length - 1], path[0])) path = path.concat(path.slice(1, -1).reverse());
      var got = [];
      for(var i = 0; i < path.length; i++){
        var e = between(path[i], path[(i + 1) % path.length]);
        if(!e) return;
        got.push(e.id);
      }
      got.forEach(function(id){ set[id] = true; });
    });
  }
  return (C.tram = set);
}
function graded(E){ return E.cls === "highway" || E.cls === "ring"; }
function crossed(C, E, end){ return (streetish(E.cls) || aveish(E.cls)) && deg(C, end ? E.b : E.a) >= 3; }

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
  if(E.bridge && mode !== "kerb" && !st.dry){
    // a bridge: the verge walls stand on the banks only (the deck's fascias close it over the water)
    dryRuns(W, E, st[0].s, st[st.length - 1].s).forEach(function(r){
      var sub = stations(E, r[0], r[1]);
      sub.dry = true;
      wallStrip(g, W, E, sub, o, mode, c, tx, tz, outSign);
    });
    return;
  }
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

/* ---------- bridges ---------- */
// the arc runs (m along E) where any of a bridge edge's deck is over the river's water, each grown ABUT into the banks,
// merged (sampled every <= WET_STEP m at its centreline and both outer edges; cached on the edge, per W)
function wetRuns(W, E){
  if(E.wet) return E.wet;
  var Q = WQ(), n = Math.max(1, Math.ceil(E.len/WET_STEP)), raw = [], run = null, out = [], ho = E.half + PARA_W;
  for(var k = 0; k <= n; k++){
    // across the whole deck: an oblique crossing reaches the water at one side first
    var s = E.len*k/n, p = pointAt(E, s);
    if(Q.riverAt(W, p.x, p.z) || Q.riverAt(W, p.x + p.lx*ho, p.z + p.lz*ho) || Q.riverAt(W, p.x - p.lx*ho, p.z - p.lz*ho)){ if(!run) run = [s, s]; run[1] = s; }
    else if(run){ raw.push(run); run = null; }
  }
  if(run) raw.push(run);
  raw.forEach(function(r){
    var a = Math.max(0, r[0] - ABUT), b = Math.min(E.len, r[1] + ABUT), L = out[out.length - 1];
    if(L && a <= L[1]) L[1] = Math.max(L[1], b); else out.push([a, b]);
  });
  return (E.wet = out);
}
// the rest of [a, b]: where the bridge stands on its banks (pieces under 5 cm dropped)
function dryRuns(W, E, a, b){
  var out = [], s = a;
  wetRuns(W, E).forEach(function(r){
    if(r[1] <= s || r[0] >= b) return;
    if(r[0] - s > 0.05) out.push([s, r[0]]);
    s = Math.max(s, r[1]);
  });
  if(b - s > 0.05) out.push([s, b]);
  return out;
}
// a box-section bar along stations A -> B between offsets o0, o1 (m, + = left), bottom y0a/y0b, top y1a/y1b; its four
// long faces, and its end faces where caps[0] / caps[1]
function bar(g, A, B, o0, o1, y0a, y0b, y1a, y1b, c, caps){
  var sg = o1 > o0 ? 1 : -1, lx = (A.lx + B.lx)/2, lz = (A.lz + B.lz)/2;
  face(g, [at(A, o0, y1a), at(B, o0, y1b), at(B, o1, y1b), at(A, o1, y1a)], c, UP);
  face(g, [at(A, o0, y0a), at(B, o0, y0b), at(B, o1, y0b), at(A, o1, y0a)], c, [0, -1, 0]);
  face(g, [at(A, o0, y0a), at(B, o0, y0b), at(B, o0, y1b), at(A, o0, y1a)], c, [-lx*sg, 0, -lz*sg]);
  face(g, [at(A, o1, y0a), at(B, o1, y0b), at(B, o1, y1b), at(A, o1, y1a)], c, [lx*sg, 0, lz*sg]);
  if(caps && caps[0]) face(g, [at(A, o0, y0a), at(A, o1, y0a), at(A, o1, y1a), at(A, o0, y1a)], c, [-A.dx, 0, -A.dz]);
  if(caps && caps[1]) face(g, [at(B, o0, y0b), at(B, o1, y0b), at(B, o1, y1b), at(B, o0, y1b)], c, [B.dx, 0, B.dz]);
}
// A bridge edge's structure in tile (tx, tz): over its whole length a parapet PARA_W wide just outside the walk (the
// carriageway with no walk) with a rail on posts; over the water (wetRuns) a deck slab DECK_T deep under the ribbons,
// fascias down its sides, and at each end an abutment wall facing the water, from the slab down under the bank's
// terrain mesh. Pieces belong to the tile of their midpoint, posts to their own.
function bridgeTile(g, W, E, tx, tz, r0, r1){
  var s0 = r0 != null ? r0 : E.tA, s1 = r1 != null ? r1 : E.len - E.tB;
  if(s1 - s0 < 0.05) return;
  var edge = E.walk > 0 ? E.half : E.cw, ho = edge + PARA_W, mid = edge + PARA_W/2;
  // the deck's top at the outer edge of side sg, as the ribbon there draws it
  function top(st, sg){ return (E.walk > 0 ? yWalk(W, E, st, sg*edge) : yRoad(W, E, st, sg*edge)) + LIFT; }
  function mine(A, B){ return inTile((A.x + B.x)/2, (A.z + B.z)/2, tx, tz); }
  var st = stations(E, s0, s1);
  for(var k = 0; k + 1 < st.length; k++){
    var A = st[k], B = st[k + 1];
    if(!mine(A, B)) continue;
    [-1, 1].forEach(function(sg){
      var ya = top(A, sg), yb = top(B, sg), caps = [k === 0, k + 2 === st.length];
      bar(g, A, B, sg*edge, sg*ho, ya, yb, ya + PARA_H, yb + PARA_H, COL.deck, caps);
      bar(g, A, B, sg*(mid - RAIL_T/2), sg*(mid + RAIL_T/2), ya + RAIL_H - RAIL_T, yb + RAIL_H - RAIL_T, ya + RAIL_H, yb + RAIL_H, COL.rail, caps);
    });
  }
  var np = Math.max(1, Math.round((s1 - s0)/POST_STEP));
  for(var j = 0; j <= np; j++){
    var s = clamp(s0 + (s1 - s0)*j/np, s0 + POST_W, s1 - POST_W), P0 = pointAt(E, s - POST_W/2), P1 = pointAt(E, s + POST_W/2);
    if(!inTile((P0.x + P1.x)/2, (P0.z + P1.z)/2, tx, tz)) continue;
    [-1, 1].forEach(function(sg){
      var y0 = top(P0, sg) + PARA_H, y1 = top(P1, sg) + PARA_H;
      bar(g, P0, P1, sg*(mid - POST_W/2), sg*(mid + POST_W/2), y0, y1, y0 - PARA_H + RAIL_H - RAIL_T, y1 - PARA_H + RAIL_H - RAIL_T, COL.rail, [true, true]);
    });
  }
  wetRuns(W, E).forEach(function(r){
    var a = Math.max(r[0], s0), b = Math.min(r[1], s1);
    if(b - a < 0.05) return;
    var ws = stations(E, a, b);
    function under(S){ return Math.min(top(S, -1), top(S, 1)) - DECK_T; }
    for(var k = 0; k + 1 < ws.length; k++){
      var A = ws[k], B = ws[k + 1];
      if(!mine(A, B)) continue;
      var ua = under(A), ub = under(B);
      face(g, [at(A, -ho, ua), at(B, -ho, ub), at(B, ho, ub), at(A, ho, ua)], COL.deckUnder, [0, -1, 0]);
      [-1, 1].forEach(function(sg){
        var lx = (A.lx + B.lx)/2*sg, lz = (A.lz + B.lz)/2*sg;
        face(g, [at(A, sg*ho, ua), at(B, sg*ho, ub), at(B, sg*ho, top(B, sg)), at(A, sg*ho, top(A, sg))], COL.deck, [lx, 0, lz]);
      });
    }
    // the abutments: the water lies ahead (+d) of the run's start and behind (-d) its end
    [[ws[0], 1], [ws[ws.length - 1], -1]].forEach(function(e){
      var S = e[0], d = e[1];
      if(!inTile(S.x, S.z, tx, tz)) return;
      var u = under(S), lo = Math.min(u - 0.5, meshMin(W, at(S, -ho, 0), at(S, ho, 0)) - 0.3);
      face(g, [at(S, -ho, lo), at(S, ho, lo), at(S, ho, u), at(S, -ho, u)], COL.deck, [S.dx*d, 0, S.dz*d]);
    });
  });
}

// flat: only the upward asphalt / sidewalk pieces (what the terrain clamp needs; no walls, no marks, no bridges)
// gap: leave out every bridge edge's pieces over the water (bridgeGaps: games/hqbridges.js draws its moving spans
// there); the terrain clamp (flat) never gaps, so the terrain is the same either way
function roadTile(W, tx, tz, flat, gap){
  var C = prep(W), asph = geo(), marks = geo(), kerb = geo(), walk = geo(), br = C.E.some(function(E){ return E.bridge; }) ? geo() : null;
  C.E.forEach(function(E){
    var e0 = E.tA, e1 = E.len - E.tB;
    if(e1 - e0 < 0.05) return;
    if(gap && E.bridge && !flat) dryRuns(W, E, e0, e1).forEach(function(r){ ribbon(E, r[0], r[1]); });
    else ribbon(E, e0, e1);
  });
  // one edge's pieces over [s0, s1] (the whole edge, or a dry run of a gapped bridge: its cut ends get no caps)
  function ribbon(E, s0, s1){
    var endA = s0 === E.tA, endB = s1 === E.len - E.tB;
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
      var wc = aveish(E.cls) ? COL.walkAve : COL.walk;
      [-1, 1].forEach(function(sg){
        strip(walk, W, E, st, sg*cw, sg*E.half, LIFT, wc, tx, tz, true);
        if(flat) return;
        wallStrip(kerb, W, E, st, sg*cw, "kerb", COL.kerb, tx, tz, -sg);
        wallStrip(walk, W, E, st, sg*E.half, "walkout", COL.verge, tx, tz, sg);
      });
      // end caps of the raised sidewalk where it stops at a junction
      if(!flat) [[endA ? E.tA : 0, s0, -1], [endB ? E.tB : 0, s1, 1]].forEach(function(cp){
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
    if(E.bridge && br) bridgeTile(br, W, E, tx, tz, s0, s1);
    // markings, stopped short of junction patches and crossings
    var m0 = s0 + (endA && crossed(C, E, 0) ? 5.5 : 0.5), m1 = s1 - (endB && crossed(C, E, 1) ? 5.5 : 0.5);
    if(m1 - m0 > 0.5) (tramEdges(W)[E.id] ? tramLines(W, E) : markLines(E)).forEach(function(ln){
      if(!ln.dash){ strip(marks, W, E, stations(E, m0, m1), ln.o - ln.w/2, ln.o + ln.w/2, MARK_LIFT, ln.c, tx, tz); return; }
      for(var d = Math.ceil(m0/9)*9; d < m1; d += 9){
        var a = Math.max(d, m0), b = Math.min(d + 3, m1);
        if(b - a > 0.2) strip(marks, W, E, stations(E, a, b), ln.o - ln.w/2, ln.o + ln.w/2, MARK_LIFT, ln.c, tx, tz);
      }
    });
  }
  // junction patches, corner sidewalks, zebra crossings: by the tile holding the node
  C.nodeIds.forEach(function(id){
    var arms = C.inc[id] || [], n = C.nodes[id];
    if(arms.length < 2 || !n || !inTile(n.x, n.z, tx, tz)) return;
    junction(W, C, n, arms, asph, flat ? geo() : marks, kerb, walk);
  });
  // @3: a hole on a pavement or a carriageway (a metro entrance) is cut out of the road too
  var H = holeSet(W);
  if(H) [asph, marks, kerb, walk].forEach(function(gg){ cutHoles(gg, H); });
  var out = {asphalt: fin(asph), marks: fin(marks), kerb: fin(kerb), walk: fin(walk)};
  if(br && !flat) out.bridge = fin(br);   // only in a doc with bridges: every other doc builds as before
  return out;
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
    if(!streetish(E.cls) && !aveish(E.cls)) return;
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

/* ---------- polygons: earcut (concave rings, no holes) ---------- */
// An inline port of mapbox/earcut's ear clipping (ISC licence) without holes or the z-order hash (block, lot and site
// rings are small). flat = [x0, z0, x1, z1, ...]; returns vertex indices, 3 per triangle, that tile the ring exactly.
// Rings that defeat plain clipping (repeats, collinear runs, self-touching corners) are filtered, cured, then split,
// as earcut does.
//
// The functions from triangulate to splitRing are adapted from earcut (https://github.com/mapbox/earcut), under its
// licence:
//
//   ISC License
//
//   Copyright (c) 2016, Mapbox
//
//   Permission to use, copy, modify, and/or distribute this software for any purpose
//   with or without fee is hereby granted, provided that the above copyright notice
//   and this permission notice appear in all copies.
//
//   THE SOFTWARE IS PROVIDED "AS IS" AND ISC DISCLAIMS ALL WARRANTIES WITH
//   REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
//   FITNESS. IN NO EVENT SHALL ISC BE LIABLE FOR ANY SPECIAL, DIRECT,
//   INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
//   OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
//   TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
//   THIS SOFTWARE.
function triangulate(flat){
  var tris = [];
  if(!flat || flat.length < 6) return tris;
  var last = ringList(flat);
  if(!last || last.next === last.prev) return tris;
  earLinked(last, tris, 0);
  return tris;
}
function ENode(i, x, y){ this.i = i; this.x = x; this.y = y; this.prev = null; this.next = null; }
function insertNode(i, x, y, last){
  var p = new ENode(i, x, y);
  if(!last){ p.prev = p; p.next = p; }
  else { p.next = last.next; p.prev = last; last.next.prev = p; last.next = p; }
  return p;
}
function removeNode(p){ p.next.prev = p.prev; p.prev.next = p.next; }
function ringArea(d){
  var s = 0;
  for(var i = 0, j = d.length - 2; i < d.length; i += 2){ s += (d[j] - d[i])*(d[i+1] + d[j+1]); j = i; }
  return s;
}
// the ring as a circular list, wound so that an ear has ear-area < 0
function ringList(d){
  var last = null, i;
  if(ringArea(d) > 0) for(i = 0; i < d.length; i += 2) last = insertNode(i/2, d[i], d[i+1], last);
  else for(i = d.length - 2; i >= 0; i -= 2) last = insertNode(i/2, d[i], d[i+1], last);
  if(last && eqPt(last, last.next)){ removeNode(last); last = last.next; }
  return last;
}
function eqPt(p, q){ return p.x === q.x && p.y === q.y; }
function triArea(p, q, r){ return (q.y - p.y)*(r.x - q.x) - (q.x - p.x)*(r.y - q.y); }
function inTri(ax, ay, bx, by, cx, cy, px, py){
  return (cx - px)*(ay - py) >= (ax - px)*(cy - py) && (ax - px)*(by - py) >= (bx - px)*(ay - py) && (bx - px)*(cy - py) >= (cx - px)*(by - py);
}
// drop repeated and collinear points
function filterPts(start, end){
  if(!start) return start;
  if(!end) end = start;
  var p = start, again;
  do {
    again = false;
    if(eqPt(p, p.next) || triArea(p.prev, p, p.next) === 0){
      removeNode(p);
      p = end = p.prev;
      if(p === p.next) break;
      again = true;
    } else p = p.next;
  } while(again || p !== end);
  return end;
}
function earLinked(ear, tris, pass){
  if(!ear) return;
  var stop = ear, prev, next;
  while(ear.prev !== ear.next){
    prev = ear.prev; next = ear.next;
    if(isEar(ear)){
      tris.push(prev.i, ear.i, next.i);
      removeNode(ear);
      ear = next.next; stop = next.next;   // skipping the next vertex gives fewer slivers
      continue;
    }
    ear = next;
    if(ear === stop){
      // no ear left: filter the ring, then cure small self-intersections, then split it in two
      if(!pass) earLinked(filterPts(ear), tris, 1);
      else if(pass === 1) earLinked(cureLocal(filterPts(ear), tris), tris, 2);
      else splitEar(ear, tris);
      break;
    }
  }
}
// a convex corner with no reflex vertex of the ring inside its triangle
function isEar(ear){
  var a = ear.prev, b = ear, c = ear.next;
  if(triArea(a, b, c) >= 0) return false;
  var x0 = Math.min(a.x, b.x, c.x), x1 = Math.max(a.x, b.x, c.x), y0 = Math.min(a.y, b.y, c.y), y1 = Math.max(a.y, b.y, c.y);
  for(var p = c.next; p !== a; p = p.next){
    if(p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && inTri(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y) &&
       triArea(p.prev, p, p.next) >= 0) return false;
  }
  return true;
}
function cureLocal(start, tris){
  var p = start;
  do {
    var a = p.prev, b = p.next.next;
    if(!eqPt(a, b) && segsCross(a, p, p.next, b) && locIn(a, b) && locIn(b, a)){
      tris.push(a.i, p.i, b.i);
      removeNode(p); removeNode(p.next);
      p = start = b;
    }
    p = p.next;
  } while(p !== start);
  return filterPts(p);
}
function splitEar(start, tris){
  var a = start;
  do {
    var b = a.next.next;
    while(b !== a.prev){
      if(a.i !== b.i && validDiag(a, b)){
        var c = splitRing(a, b);
        a = filterPts(a, a.next); c = filterPts(c, c.next);
        earLinked(a, tris, 0); earLinked(c, tris, 0);
        return;
      }
      b = b.next;
    }
    a = a.next;
  } while(a !== start);
}
function validDiag(a, b){
  return a.next.i !== b.i && a.prev.i !== b.i && !crossesRing(a, b) &&
         (locIn(a, b) && locIn(b, a) && midIn(a, b) && !!(triArea(a.prev, a, b.prev) || triArea(a, b.prev, b)) ||
          eqPt(a, b) && triArea(a.prev, a, a.next) > 0 && triArea(b.prev, b, b.next) > 0);
}
function sgn(v){ return v > 0 ? 1 : (v < 0 ? -1 : 0); }
function onSeg(p, q, r){ return q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) && q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y); }
function segsCross(p1, q1, p2, q2){
  var o1 = sgn(triArea(p1, q1, p2)), o2 = sgn(triArea(p1, q1, q2)), o3 = sgn(triArea(p2, q2, p1)), o4 = sgn(triArea(p2, q2, q1));
  if(o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && onSeg(p1, p2, q1)) || (o2 === 0 && onSeg(p1, q2, q1)) || (o3 === 0 && onSeg(p2, p1, q2)) || (o4 === 0 && onSeg(p2, q1, q2));
}
function crossesRing(a, b){
  var p = a;
  do {
    if(p.i !== a.i && p.next.i !== a.i && p.i !== b.i && p.next.i !== b.i && segsCross(p, p.next, a, b)) return true;
    p = p.next;
  } while(p !== a);
  return false;
}
function locIn(a, b){
  return triArea(a.prev, a, a.next) < 0 ? triArea(a, b, a.next) >= 0 && triArea(a, a.prev, b) >= 0
                                        : triArea(a, b, a.prev) < 0 || triArea(a, a.next, b) < 0;
}
function midIn(a, b){
  var p = a, inside = false, px = (a.x + b.x)/2, py = (a.y + b.y)/2;
  do {
    if(((p.y > py) !== (p.next.y > py)) && p.next.y !== p.y && px < (p.next.x - p.x)*(py - p.y)/(p.next.y - p.y) + p.x) inside = !inside;
    p = p.next;
  } while(p !== a);
  return inside;
}
// cut the ring along a-b into two rings (a-b and a copy b2-a2); returns b2
function splitRing(a, b){
  var a2 = new ENode(a.i, a.x, a.y), b2 = new ENode(b.i, b.x, b.y), an = a.next, bp = b.prev;
  a.next = b; b.prev = a;
  a2.next = an; an.prev = a2;
  b2.next = a2; a2.prev = b2;
  bp.next = b2; b2.prev = bp;
  return b2;
}

/* ---------- v2 ground: block pavements, lot and plaza pads, the beach ---------- */
// a doc polygon [[x, z] cm, ...] in metres, repeats and the closing point dropped, wound with positive area (CCW
// with x right and z up: the interior lies on (-dz, dx) of each edge)
function polyM(poly){
  var P = [];
  (poly || []).forEach(function(p){
    if(!p || p.length < 2 || !isFinite(p[0]) || !isFinite(p[1])) return;
    var q = [p[0]/100, p[1]/100], L = P[P.length - 1];
    if(!L || L[0] !== q[0] || L[1] !== q[1]) P.push(q);
  });
  if(P.length > 1 && P[0][0] === P[P.length - 1][0] && P[0][1] === P[P.length - 1][1]) P.pop();
  return polyArea(P) < 0 ? P.reverse() : P;
}
function polyArea(P){
  var s = 0;
  for(var k = 0; k < P.length; k++){ var a = P[k], b = P[(k + 1) % P.length]; s += a[0]*b[1] - b[0]*a[1]; }
  return s/2;
}
function flatOf(P){ var f = []; P.forEach(function(p){ f.push(p[0], p[1]); }); return f; }
function polyCentroid(P){
  var A = 0, x = 0, z = 0, k;
  for(k = 0; k < P.length; k++){
    var a = P[k], b = P[(k + 1) % P.length], cr = a[0]*b[1] - b[0]*a[1];
    A += cr; x += (a[0] + b[0])*cr; z += (a[1] + b[1])*cr;
  }
  if(Math.abs(A) > 1e-9) return [x/(3*A), z/(3*A)];
  x = 0; z = 0;
  for(k = 0; k < P.length; k++){ x += P[k][0]/P.length; z += P[k][1]/P.length; }
  return [x, z];
}
function inPoly(P, x, z){
  var inside = false;
  for(var k = 0, j = P.length - 1; k < P.length; j = k++){
    var a = P[k], b = P[j];
    if((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0])*(z - a[1])/(b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
function coastOf(W){ var I = W && W.island; return I && I.coast && I.coast.length >= 3 && seaY(W) != null ? I : null; }
function seaY(W){ var I = W && W.island; return I && I.sea_cm != null && isFinite(+I.sea_cm) ? +I.sea_cm/100 : null; }
// the river's water outline in metres (CCW), on an island doc only (it is water at sea level), or null
function riverRing(W){
  var B = (W && W.tierBase) || W, R = B && B.river;
  if(!R || !R.poly || seaY(B) == null) return null;
  var P = polyM(R.poly);
  return P.length >= 3 && Math.abs(polyArea(P)) > 1e-6 ? P : null;
}
// distance (m) from (x, z) to the nearest edge of ring P
function ringDist(P, x, z){
  var d = Infinity;
  for(var k = 0; k < P.length; k++){
    var a = P[k], b = P[(k + 1) % P.length], dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx*dx + dz*dz;
    var t = L2 > 0 ? clamp(((x - a[0])*dx + (z - a[1])*dz)/L2, 0, 1) : 0;
    d = Math.min(d, hypot(x - a[0] - dx*t, z - a[1] - dz*t));
  }
  return d;
}
// The river's water surface: its outline at sea level + RIVER_LIFT, triangulated, every face up. One geo for the
// world (games/worldbuild.js draws it as one mesh in the sea's material); empty without a river or a sea.
function riverWater(W){
  var P = riverRing(W), g = geo();
  if(!P) return fin(g);
  var B = W.tierBase || W, y = seaY(B) + RIVER_LIFT, tri = triangulate(flatOf(P));
  P.forEach(function(p){ vert(g, p[0], y, p[1], UP, COL.water); });
  for(var t = 0; t < tri.length; t += 3){
    var a = P[tri[t]], b = P[tri[t+1]], c = P[tri[t+2]];
    if((b[1] - a[1])*(c[0] - a[0]) - (b[0] - a[0])*(c[1] - a[1]) >= 0) g.i.push(tri[t], tri[t+1], tri[t+2]);
    else g.i.push(tri[t], tri[t+2], tri[t+1]);
  }
  return fin(g);
}
// does this doc draw any v2 ground (the same answer at every tier)?
function hasGround(W){
  var B = (W && W.tierBase) || W || {};
  function any(L){ for(var i = 0; i < (L || []).length; i++) if(L[i] && L[i].poly) return true; return false; }
  return any(B.blocks) || any(B.lots) || any(B.sites) || !!coastOf(B);
}
// the least-squares plane y = a + gx (x - cx) + gz (z - cz) through the raw terrain (heightAt: the same at every tier)
// at the corners and the centroid
function fitPlane(W, P){
  var Q = WQ(), c = polyCentroid(P), pts = P.concat([c]), n = pts.length, cx = 0, cz = 0;
  pts.forEach(function(p){ cx += p[0]/n; cz += p[1]/n; });
  var sxx = 0, sxz = 0, szz = 0, sxy = 0, szy = 0, sy = 0;
  pts.forEach(function(p){
    var dx = p[0] - cx, dz = p[1] - cz, y = Q.heightAt(W, p[0], p[1]);
    sxx += dx*dx; sxz += dx*dz; szz += dz*dz; sxy += dx*y; szy += dz*y; sy += y;
  });
  var det = sxx*szz - sxz*sxz, gx = 0, gz = 0;
  if(det > 1e-6*(sxx*szz + 1e-9)){ gx = (sxy*szz - szy*sxz)/det; gz = (szy*sxx - sxy*sxz)/det; }
  return {a: sy/n, gx: gx, gz: gz, cx: cx, cz: cz};
}
function planeY(pl, x, z){ return pl.a + pl.gx*(x - pl.cx) + pl.gz*(z - pl.cz); }
function unit(v){ var l = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]) || 1; return [v[0]/l, v[1]/l, v[2]/l]; }
// Every ground piece of W (a tier view) as {kind, P (xz ring), V (drawn [x, y, z]), tri, col, nrm, walls, tx, tz},
// assigned to the tile of its centroid. Blocks are paved (lawn in green districts) KERB over their fitted plane with a
// kerb round them; lots and sites with a poly are pads PAD over their block's plane (their own plane, with a kerb,
// when the block has none). The terrain clamp pushes the terrain under all of it.
function groundItems(W){
  var C = prep(W);
  if(C.ground) return C.ground;
  var Q = WQ(), out = [], B = W.tierBase || W, planes = {}, polys = {}, leg = (W.districts && W.districts.legend) || [];
  (B.blocks || []).forEach(function(b){ if(b && b.poly) polys[b.id] = b.poly; });
  function blockPlane(id){
    if(!Object.prototype.hasOwnProperty.call(planes, id)){
      var P = Object.prototype.hasOwnProperty.call(polys, id) ? polyM(polys[id]) : null;
      planes[id] = P && P.length >= 3 && Math.abs(polyArea(P)) > 1e-6 ? fitPlane(W, P) : null;
    }
    return planes[id];
  }
  function fill(P, pl, up, col, kind, walls){
    if(P.length < 3) return;
    var tri = triangulate(flatOf(P));
    if(!tri.length) return;
    var c = polyCentroid(P), t = tileOf(c[0], c[1]);
    out.push({kind: kind, P: P, V: P.map(function(p){ return [p[0], planeY(pl, p[0], p[1]) + up, p[1]]; }), tri: tri, col: col,
              nrm: unit([-pl.gx, 1, -pl.gz]), walls: walls, tx: t.tx, tz: t.tz});
  }
  (W.blocks || []).forEach(function(b){
    if(!b || !b.poly) return;
    var P = polyM(b.poly), pl = blockPlane(b.id);
    if(!pl) return;
    var c = polyCentroid(P), dn = Q.districtAt(W, c[0], c[1]).name;
    fill(P, pl, KERB + LIFT, GREEN[dn] ? tint(dn) : COL.pave, "block", true);
  });
  (W.lots || []).forEach(function(l){
    if(!l || !l.poly) return;
    var P = polyM(l.poly), bp = blockPlane(l.block);
    if(P.length < 3) return;
    var st = STYLE[leg[l.district]] || "com";
    var col = l.kind === "park" ? COL.lawn : (l.kind === "building" ? (st === "res" ? COL.lawn : COL.concrete) : COL.plaza);
    fill(P, bp || fitPlane(W, P), KERB + LIFT + PAD, col, "lot", !bp);
  });
  (W.sites || []).forEach(function(s){
    if(!s || !s.poly) return;
    var P = polyM(s.poly), bp = blockPlane(s.block);
    if(P.length < 3) return;
    fill(P, bp || fitPlane(W, P), KERB + LIFT + PAD, COL.plaza, "site", !bp);
  });
  if(coastOf(B)){
    var coast = polyM(B.island.coast), R = riverRing(B);
    if(!R) beach(W, coast, seaY(B), out);
    else {
      // the beach stops where the river runs out to sea; the banks run along the river up to BANK_MOUTH from the coast
      beach(W, coast, seaY(B), out, {keep: function(p){ return !Q.riverAt(B, p[0], p[2]); }});
      beach(W, R, seaY(B) + RIVER_LIFT, out, {kind: "bank", inW: BANK_IN, outW: BANK_OUT, sign: -1, dry: COL.bank, wet: COL.wetBank,
                                 keep: function(p){ return inPoly(coast, p[0], p[2]) && ringDist(coast, p[0], p[2]) > BANK_MOUTH; }});
    }
  }
  // @3: a shaded bank strip (as the river's) along every bank body's shore with land behind it, and round its islands
  var WR = waterRings(W);
  if(WR) WR.bodies.forEach(function(r){
    if(r.b.edge === "quay" || r.b.kind === "marina") return;
    function keep(p){ return !wetElse(W, WR, p[0], p[2], r); }
    var bo = {kind: "bank", inW: BANK_IN, outW: BANK_OUT, dry: COL.bank, wet: COL.wetBank, keep: keep};
    beach(W, r.P, r.b.y, out, Object.assign({sign: -1}, bo));
    r.I.forEach(function(I){ beach(W, I, r.b.y, out, Object.assign({sign: 1}, bo)); });
  });
  C.ground = out;
  return out;
}
// The beach: a dry strip from BEACH_IN inland down to just over the waterline and a wet one on to BEACH_OUT out,
// BEACH_WET under the water, sampled every <= BEACH_STEP m along the coast and mitred at its corners. Heights come
// from the raw terrain, so it is the same at every tier. One item per quad, so each lands in its own tile.
// o (optional): {kind, inW, outW, dry, wet (colours), sign (-1: P's interior is the water, as a river's outline),
// keep(point): a quad is laid only where all four of its dry and shore corners keep}
function beach(W, P, sea, out, o){
  var Q = WQ(), n = P.length, S = [];
  o = o || {};
  var IN = o.inW != null ? o.inW : BEACH_IN, OUT = o.outW != null ? o.outW : BEACH_OUT, sg = o.sign || 1;
  if(n < 3) return;
  function inward(k){
    var a = P[k], b = P[(k + 1) % n], dx = b[0] - a[0], dz = b[1] - a[1], l = hypot(dx, dz) || 1;
    return [-dz/l*sg, dx/l*sg];
  }
  for(var k = 0; k < n; k++){
    var a = P[k], b = P[(k + 1) % n], m = Math.max(1, Math.ceil(hypot(b[0] - a[0], b[1] - a[1])/BEACH_STEP)), n1 = inward(k);
    for(var j = 0; j < m; j++){
      var nv = n1;
      if(j === 0){
        var n0 = inward((k + n - 1) % n), mx = n0[0] + n1[0], mz = n0[1] + n1[1], ml = hypot(mx, mz) || 1;
        mx /= ml; mz /= ml;
        var s = 1/Math.max(0.5, mx*n1[0] + mz*n1[1]);
        nv = [mx*s, mz*s];
      }
      var x = a[0] + (b[0] - a[0])*j/m, z = a[1] + (b[1] - a[1])*j/m, ix = x + nv[0]*IN, iz = z + nv[1]*IN;
      S.push({dry: [ix, Math.max(Q.heightAt(W, ix, iz), sea + 0.1) + LIFT, iz], shore: [x, sea + 0.05, z],
              wet: [x - nv[0]*OUT, sea - BEACH_WET, z - nv[1]*OUT]});
    }
  }
  for(k = 0; k < S.length; k++){
    var A = S[k], B = S[(k + 1) % S.length];
    if(o.keep && !(o.keep(A.dry) && o.keep(B.dry) && o.keep(A.shore) && o.keep(B.shore))) continue;
    [[A.dry, B.dry, B.shore, A.shore, o.dry || COL.sand], [A.shore, B.shore, B.wet, A.wet, o.wet || COL.wetSand]].forEach(function(q){
      var V = [q[0], q[1], q[2], q[3]], cx = (V[0][0] + V[1][0] + V[2][0] + V[3][0])/4, cz = (V[0][2] + V[1][2] + V[2][2] + V[3][2])/4;
      var t = tileOf(cx, cz), nr = newell(V);
      if(nr[1] < 0) nr = [-nr[0], -nr[1], -nr[2]];
      out.push({kind: o.kind || "beach", P: V.map(function(v){ return [v[0], v[2]]; }), V: V, tri: [0, 1, 2, 0, 2, 3], col: q[4],
                nrm: unit(nr), walls: false, tx: t.tx, tz: t.tz});
    });
  }
}
// a kerb round a block: from the pavement's edge straight down to 0.3 m under the lowest terrain mesh along it (any lod)
function kerbWalls(W, g, it){
  var V = it.V, n = V.length;
  for(var k = 0; k < n; k++){
    var a = V[k], b = V[(k + 1) % n], dx = b[0] - a[0], dz = b[2] - a[2];
    if(!(hypot(dx, dz) > 1e-6)) continue;
    var lo = meshMin(W, a, b) - 0.3;
    face(g, [[a[0], Math.min(a[1] - 0.5, lo), a[2]], [b[0], Math.min(b[1] - 0.5, lo), b[2]], b.slice(), a.slice()], COL.kerb, [dz, 0, -dx]);
  }
}
function groundTile(W, tx, tz){
  var g = geo();
  groundItems(W).forEach(function(it){
    if(it.tx !== tx || it.tz !== tz) return;
    var base = g.p.length/3, V = it.V;
    V.forEach(function(v){ vert(g, v[0], v[1], v[2], it.nrm, it.col); });
    // wind every triangle to face up
    for(var t = 0; t < it.tri.length; t += 3){
      var a = it.tri[t], b = it.tri[t+1], c = it.tri[t+2], A = V[a], B = V[b], C2 = V[c];
      if((B[2] - A[2])*(C2[0] - A[0]) - (B[0] - A[0])*(C2[2] - A[2]) >= 0) g.i.push(base + a, base + b, base + c);
      else g.i.push(base + a, base + c, base + b);
    }
    if(it.walls) kerbWalls(W, g, it);
  });
  var H = holeSet(W);
  if(H) cutHoles(g, H);
  return fin(g);
}

/* ---------- @3 terrain holes: metro entrances, portals, the Island Link portal ---------- */
// Every hole of W (HQV.world.holesOf: metres) as convex pieces (its ring triangulated, each CCW) with boxes, once per W.
// A geo is cut by them in plan (cutHoles): each triangle overlapping a hole is replaced by triangle minus hole, the
// pieces from clipping it against each convex piece's edges in turn (Sutherland-Hodgman), every attribute interpolated
// along the clipped edges (exact on a planar triangle), so the edge is clean and the surface unchanged elsewhere. A
// triangle that stands up (a skirt, a kerb, a verge wall: no area in plan) is dropped when its centre is in a hole.
var HOLE_EPS = 1e-6;
function holeSet(W){
  var C = prep(W);
  if(C.holes !== undefined) return C.holes;
  var Q = WQ(), B = W.tierBase || W, rings = Q.holesOf && (B.metro || B.rail) ? Q.holesOf(B) : [], out = [];
  rings.forEach(function(R){
    var P = [];
    (R || []).forEach(function(q){ var L = P[P.length - 1]; if(q && isFinite(q[0]) && isFinite(q[1]) && !(L && L[0] === q[0] && L[1] === q[1])) P.push([q[0], q[1]]); });
    if(P.length > 2 && P[0][0] === P[P.length - 1][0] && P[0][1] === P[P.length - 1][1]) P.pop();
    if(P.length < 3 || !(Math.abs(polyArea(P)) > 1e-4)) return;
    if(polyArea(P) < 0) P.reverse();
    var h = cutterOf(P);
    if(h) out.push(h);
  });
  C.holes = out.length ? out : null;
  return C.holes;
}
function boxOf(P){
  var b = {x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity};
  P.forEach(function(q){ b.x0 = Math.min(b.x0, q[0]); b.x1 = Math.max(b.x1, q[0]); b.z0 = Math.min(b.z0, q[1]); b.z1 = Math.max(b.z1, q[1]); });
  return b;
}
function boxHit(a, b){ return a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0; }
function inHoles(H, x, z){
  for(var i = 0; i < H.length; i++) if(x >= H[i].b.x0 && x <= H[i].b.x1 && z >= H[i].b.z0 && z <= H[i].b.z1 && inPoly(H[i].P, x, z)) return true;
  return false;
}
// clip polygon S (points: [x, y, z, ...attributes]) to the side of the line a -> b where side*cross >= 0
function clipHalf(S, a, b, side){
  var out = [], n = S.length;
  function d(p){ return side*((b[0] - a[0])*(p[2] - a[1]) - (b[1] - a[1])*(p[0] - a[0])); }
  for(var i = 0; i < n; i++){
    var P = S[i], R = S[(i + 1) % n], dp = d(P), dr = d(R);
    if(dp >= 0) out.push(P);
    if((dp >= 0) !== (dr >= 0)){
      var t = dp/(dp - dr), M = new Array(P.length);
      for(var k = 0; k < P.length; k++) M[k] = P[k] + (R[k] - P[k])*t;
      out.push(M);
    }
  }
  return out;
}
function planArea(S){
  var s = 0;
  for(var i = 0; i < S.length; i++){ var a = S[i], b = S[(i + 1) % S.length]; s += a[0]*b[2] - b[0]*a[2]; }
  return s/2;
}
// polygon S minus the convex CCW triangle K: the pieces outside each of K's edges in turn
function subtractConvex(S, K){
  var pieces = [], rem = S;
  for(var e = 0; e < K.length && rem.length >= 3; e++){
    var a = K[e], b = K[(e + 1) % K.length], outP = clipHalf(rem, a, b, -1);
    if(outP.length >= 3 && Math.abs(planArea(outP)) > HOLE_EPS) pieces.push(outP);
    rem = clipHalf(rem, a, b, 1);
  }
  return pieces;
}
// cut the geo builder g (geo()) by the holes H in place
function cutHoles(g, H){
  if(!H || !g.i.length) return g;
  var all = {x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity};
  H.forEach(function(h){ all.x0 = Math.min(all.x0, h.b.x0); all.x1 = Math.max(all.x1, h.b.x1); all.z0 = Math.min(all.z0, h.b.z0); all.z1 = Math.max(all.z1, h.b.z1); });
  var idx = g.i, keep = [], p = g.p, nb = !!g.b, nl = !!g.l, add = [];
  function pt(v){
    var o = [p[3*v], p[3*v+1], p[3*v+2], g.n[3*v], g.n[3*v+1], g.n[3*v+2], g.c[3*v], g.c[3*v+1], g.c[3*v+2]];
    if(nb) o.push(g.b[v]);
    if(nl) o.push(g.l[v]);
    return o;
  }
  for(var t = 0; t < idx.length; t += 3){
    var ia = idx[t], ib = idx[t+1], ic = idx[t+2];
    var ax = p[3*ia], az = p[3*ia+2], bx = p[3*ib], bz = p[3*ib+2], cx = p[3*ic], cz = p[3*ic+2];
    var tb = {x0: Math.min(ax, bx, cx), x1: Math.max(ax, bx, cx), z0: Math.min(az, bz, cz), z1: Math.max(az, bz, cz)};
    if(!boxHit(tb, all) || !H.some(function(h){ return boxHit(tb, h.b); })){ keep.push(ia, ib, ic); continue; }
    var area = ((bx - ax)*(cz - az) - (bz - az)*(cx - ax))/2;
    if(Math.abs(area) < 1e-4){
      // standing up: in or out by its centre
      if(!inHoles(H, (ax + bx + cx)/3, (az + bz + cz)/3)) keep.push(ia, ib, ic);
      continue;
    }
    var polys = [[pt(ia), pt(ib), pt(ic)]], cut = false;
    H.forEach(function(h){
      if(!boxHit(tb, h.b)) return;
      h.parts.forEach(function(k){
        if(!boxHit(tb, k.b)) return;
        var next = [];
        polys.forEach(function(S){
          var sb = boxOf(S.map(function(q){ return [q[0], q[2]]; }));
          if(!boxHit(sb, k.b)){ next.push(S); return; }
          var r = subtractConvex(S, k.K);
          if(r.length !== 1 || r[0].length !== S.length || r[0].some(function(q, i){ return q !== S[i]; })) cut = true;
          next = next.concat(r);
        });
        polys = next;
      });
    });
    if(!cut){ keep.push(ia, ib, ic); continue; }
    polys.forEach(function(S){ add.push(S); });
  }
  g.i = keep;
  add.forEach(function(S){
    var base = g.p.length/3;
    S.forEach(function(q){
      g.p.push(q[0], q[1], q[2]); g.n.push(q[3], q[4], q[5]); g.c.push(q[6], q[7], q[8]);
      if(nb) g.b.push(q[9]);
      if(nl) g.l.push(q[nb ? 10 : 9]);
    });
    // a fan, without the slivers repeated or collinear clip points leave (no area in plan)
    for(var k = 1; k + 1 < S.length; k++){
      var A = S[0], B2 = S[k], C2 = S[k + 1];
      if(Math.abs((B2[0] - A[0])*(C2[2] - A[2]) - (B2[2] - A[2])*(C2[0] - A[0])) > 2e-6) g.i.push(base, base + k, base + k + 1);
    }
  });
  return g;
}

/* ---------- @3 water: lakes, canals, the marina (HQV.world.waterOf; drawn world-wide by games/worldbuild.js) ---------- */
// waterGeo(W) -> {surface, works, foam} (one geo each, for the whole world):
//   surface  every body at its y (the calm level boats float on), its islands cut out; `lit` = 1 on a lake (the shader's
//            calm lake variant: smaller ripples, more of the sky), 0 on a canal or the marina
//   works    the quay walls along every quay body and the marina where land is behind them (from under the bed up to the
//            street, a coping stone on top over-hanging the water, mooring rings every RING_STEP m), the breakwater
//            (rock armour sloping from the sea bed, seeded boulders, a concrete crown walk BREAKWATER_UP over the sea), and
//            on the lakes' banks a few lily pads and reeds (seeded by the world hash and the body id)
//   foam     a FOAM_W strip along every bank shore (lakes and their islands), a thin one at the foot of the quays
// A bank body's shore strip (bank colours, like the river's) is a ground item in the terrain tiles (groundItems).
var FOAM_W = 1.2, QUAY_FOAM = 0.45, COPING_W = 0.6, COPING_T = 0.16, COPING_OUT = 0.12, RING_STEP = 12, RING_R = 0.2, RING_IN = 0.14;
var QUAY_UP = 0.8, BW_BASE = 7, BW_CROWN = 2.6, BW_WALK = 1.8, BW_DEEP = 3, LILY_MAX = 120, REED_MAX = 360;
var WCOL = {quay: [0.55, 0.53, 0.49], coping: [0.74, 0.72, 0.67], iron: [0.16, 0.16, 0.18], rock: [0.47, 0.46, 0.43],
            walk: [0.68, 0.67, 0.64], lily: [0.22, 0.46, 0.20], flower: [0.95, 0.86, 0.92], reed: [0.50, 0.56, 0.28], foam: [0.94, 0.97, 0.99]};
function ringOfFlat(f){
  var P = [];
  for(var i = 0; i + 1 < f.length; i += 2){ var L = P[P.length - 1]; if(!L || L[0] !== f[i] || L[1] !== f[i+1]) P.push([f[i], f[i+1]]); }
  if(P.length > 2 && P[0][0] === P[P.length - 1][0] && P[0][1] === P[P.length - 1][1]) P.pop();
  return polyArea(P) < 0 ? P.reverse() : P;
}
// a ring as a cutter for cutHoles: its convex pieces
function cutterOf(P){
  var tri = triangulate(flatOf(P)), parts = [];
  for(var t = 0; t < tri.length; t += 3){
    var K = [P[tri[t]], P[tri[t+1]], P[tri[t+2]]];
    if(polyArea(K) < 0) K.reverse();
    if(polyArea(K) > 1e-9) parts.push({K: K, b: boxOf(K)});
  }
  return parts.length ? {P: P, parts: parts, b: boxOf(P)} : null;
}
// the bodies of W as rings (m, CCW) with their islands, once per W
function waterRings(W){
  var C = prep(W);
  if(C.water !== undefined) return C.water;
  var Q = WQ(), B = W.tierBase || W, V = B.water && Q.waterOf ? Q.waterOf(B) : null;
  C.water = V ? {V: V, bodies: V.bodies.map(function(b){
    var P = ringOfFlat(b.poly);
    return {b: b, P: P, box: boxOf(P), I: b.islands.map(ringOfFlat).filter(function(R){ return R.length >= 3; })};
  }).filter(function(r){ return r.P.length >= 3; })} : null;
  return C.water;
}
function coastRing(W){
  var C = prep(W), B = W.tierBase || W;
  if(C.coast === undefined) C.coast = coastOf(B) ? polyM(B.island.coast) : null;
  return C.coast;
}
// is (x, z) on water other than body `self`: another body, the river, or the sea past the coast?
function wetElse(W, R, x, z, self){
  var B = W.tierBase || W;
  for(var i = 0; i < R.bodies.length; i++){
    var r = R.bodies[i];
    if(r === self || x < r.box.x0 || x > r.box.x1 || z < r.box.z0 || z > r.box.z1 || !inPoly(r.P, x, z)) continue;
    if(!r.I.some(function(I){ return inPoly(I, x, z); })) return true;
  }
  if(B.river && WQ().riverAt(B, x, z)) return true;
  var c = coastRing(W);
  return !!(c && !inPoly(c, x, z));
}
function waterGeo(W){
  var C = prep(W);
  if(C.waterGeo) return C.waterGeo;
  var R = waterRings(W), surf = geo(false, true), works = geo(), foam = geo();
  if(R){
    var Q = WQ(), B = W.tierBase || W, sea = seaY(B), hash = B.hash || "", RR = riverRing(W), riverCut = RR ? cutterOf(RR) : null;
    R.bodies.forEach(function(r){
      var b = r.b, y = b.y, lake = b.kind === "lake" ? 1 : 0, P = r.P, n = P.length;
      // the surface, islands cut out
      var g = geo(false, true), tri = triangulate(flatOf(P));
      P.forEach(function(p){ vert(g, p[0], y, p[1], UP, COL.water, 0, lake); });
      for(var t = 0; t < tri.length; t += 3){
        var a = P[tri[t]], c1 = P[tri[t+1]], c2 = P[tri[t+2]];
        if((c1[1] - a[1])*(c2[0] - a[0]) - (c1[0] - a[0])*(c2[1] - a[1]) >= 0) g.i.push(tri[t], tri[t+1], tri[t+2]);
        else g.i.push(tri[t], tri[t+2], tri[t+1]);
      }
      // its islands, and where it overlaps the river (a canal starts inside it) the river's own surface: no two
      // coplanar sheets of water
      var cut = r.I.map(cutterOf).filter(Boolean);
      if(riverCut && boxHit(riverCut.b, r.box)) cut.push(riverCut);
      if(cut.length) cutHoles(g, cut);
      append(surf, g);
      var rnd = rng(Q.hash32(hash + ":water:" + b.id));
      function side(k){   // edge k: a, b, unit u, its water side (left of a CCW ring) and its land side
        var a = P[k], c = P[(k + 1) % n], dx = c[0] - a[0], dz = c[1] - a[1], l = hypot(dx, dz) || 1;
        return {a: a, b: c, l: l, ux: dx/l, uz: dz/l, wx: -dz/l, wz: dx/l};
      }
      if(b.edge === "quay" || b.kind === "marina") quays(W, R, r, works, foam);
      else {
        // bank foam along the shore where land is behind it, and round each island
        for(var k = 0; k < n; k++){
          var e = side(k), mx = (e.a[0] + e.b[0])/2, mz = (e.a[1] + e.b[1])/2;
          if(wetElse(W, R, mx - e.wx*1.5, mz - e.wz*1.5, r)) continue;
          strip2(foam, e.a, e.b, e.wx, e.wz, 0, FOAM_W, y + 0.025, WCOL.foam);
        }
        r.I.forEach(function(I){
          for(var k = 0; k < I.length; k++){
            var a = I[k], c = I[(k + 1) % I.length], dx = c[0] - a[0], dz = c[1] - a[1], l = hypot(dx, dz) || 1;
            strip2(foam, a, c, dz/l, -dx/l, 0, FOAM_W, y + 0.025, WCOL.foam);
          }
        });
        if(lake) plants(W, R, r, works, rnd);
      }
    });
    var V = R.V;
    if(V.breakwater) breakwaterGeo(works, V.breakwater, sea != null ? sea : 0, Q, rng(Q.hash32(hash + ":breakwater")));
  }
  C.waterGeo = {surface: fin(surf), works: fin(works), foam: fin(foam)};
  return C.waterGeo;
}
// append geo s to d
function append(d, s){
  var base = d.p.length/3, k;
  for(k = 0; k < s.p.length; k++){ d.p.push(s.p[k]); d.n.push(s.n[k]); d.c.push(s.c[k]); }
  if(d.l) for(k = 0; k < s.p.length/3; k++) d.l.push(s.l ? s.l[k] : 0);
  if(d.b) for(k = 0; k < s.p.length/3; k++) d.b.push(s.b ? s.b[k] : 0);
  for(k = 0; k < s.i.length; k++) d.i.push(s.i[k] + base);
}
// a flat strip along a -> b from offset o0 to o1 (m) toward (wx, wz), at y, facing up
function strip2(g, a, b, wx, wz, o0, o1, y, c){
  face(g, [[a[0] + wx*o0, y, a[1] + wz*o0], [b[0] + wx*o0, y, b[1] + wz*o0], [b[0] + wx*o1, y, b[1] + wz*o1], [a[0] + wx*o1, y, a[1] + wz*o1]], c, UP);
}
// The quay walls of body r: on every edge with land behind it (not another water, the river or the sea), from under the
// bed to the coping. The top at a corner is the street 1.5 m behind it, at least QUAY_UP over the water.
function quays(W, R, r, works, foam){
  var b = r.b, P = r.P, n = P.length, y = b.y, bot = y - Math.max(0.5, b.bed) - 0.3, top = [];
  for(var k = 0; k < n; k++){
    var a = P[(k + n - 1) % n], q = P[k], c = P[(k + 1) % n];
    var d1 = hypot(q[0] - a[0], q[1] - a[1]) || 1, d2 = hypot(c[0] - q[0], c[1] - q[1]) || 1;
    var lx = (q[1] - a[1])/d1 + (c[1] - q[1])/d2, lz = -(q[0] - a[0])/d1 - (c[0] - q[0])/d2, ll = hypot(lx, lz) || 1;
    top.push(Math.max(gY(W, q[0] + lx/ll*1.5, q[1] + lz/ll*1.5), y + QUAY_UP));
  }
  for(k = 0; k < n; k++){
    var A = P[k], Bp = P[(k + 1) % n], dx = Bp[0] - A[0], dz = Bp[1] - A[1], l = hypot(dx, dz);
    if(!(l > 0.05)) continue;
    var ux = dx/l, uz = dz/l, wx = -uz, wz = ux, mx = (A[0] + Bp[0])/2, mz = (A[1] + Bp[1])/2;
    if(wetElse(W, R, mx - wx*2, mz - wz*2, r) || inPoly(P, mx - wx*2, mz - wz*2)) continue;
    var ya = top[k], yb = top[(k + 1) % n];
    // the wall's face, toward the water
    face(works, [[A[0], bot, A[1]], [Bp[0], bot, Bp[1]], [Bp[0], yb, Bp[1]], [A[0], ya, A[1]]], WCOL.quay, [wx, 0, wz]);
    // the coping stone: COPING_OUT over the water, COPING_W onto the land, COPING_T thick
    var o0 = COPING_OUT, o1 = -COPING_W, t = COPING_T;
    face(works, [[A[0] + wx*o0, ya + t, A[1] + wz*o0], [Bp[0] + wx*o0, yb + t, Bp[1] + wz*o0], [Bp[0] + wx*o1, yb + t, Bp[1] + wz*o1], [A[0] + wx*o1, ya + t, A[1] + wz*o1]], WCOL.coping, UP);
    face(works, [[A[0] + wx*o0, ya, A[1] + wz*o0], [Bp[0] + wx*o0, yb, Bp[1] + wz*o0], [Bp[0] + wx*o0, yb + t, Bp[1] + wz*o0], [A[0] + wx*o0, ya + t, A[1] + wz*o0]], WCOL.coping, [wx, 0, wz]);
    face(works, [[A[0] + wx*o0, ya, A[1] + wz*o0], [Bp[0] + wx*o0, yb, Bp[1] + wz*o0], [Bp[0], yb, Bp[1]], [A[0], ya, A[1]]], WCOL.coping, [0, -1, 0]);
    // mooring rings
    for(var s = RING_STEP/2; s < l - 2; s += RING_STEP){
      var cx = A[0] + ux*s + wx*0.04, cz = A[1] + uz*s + wz*0.04, cy = ya + (yb - ya)*s/l - 0.45;
      for(var j = 0; j < 8; j++){
        var a0 = j/8*2*Math.PI, a1 = (j + 1)/8*2*Math.PI, c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
        face(works, [[cx + ux*c0*RING_IN, cy + s0*RING_IN, cz + uz*c0*RING_IN], [cx + ux*c1*RING_IN, cy + s1*RING_IN, cz + uz*c1*RING_IN],
                     [cx + ux*c1*RING_R, cy + s1*RING_R, cz + uz*c1*RING_R], [cx + ux*c0*RING_R, cy + s0*RING_R, cz + uz*c0*RING_R]], WCOL.iron, [wx, 0, wz]);
      }
    }
    strip2(foam, A, Bp, wx, wz, 0, QUAY_FOAM, y + 0.025, WCOL.foam);
  }
}
// The breakwater along polyline L (m): rock armour from BW_DEEP under the sea up to the crown BREAKWATER_UP over it,
// BW_BASE half wide at the foot and BW_CROWN at the top, end caps, seeded boulders on both slopes, and the crown walk
function breakwaterGeo(g, L, sea, Q, rnd){
  var up = Q.BREAKWATER_UP != null ? Q.BREAKWATER_UP : 2.5, yb = sea - BW_DEEP, yc = sea + up;
  for(var k = 0; k + 1 < L.length; k++){
    var a = L[k], c = L[k + 1], dx = c[0] - a[0], dz = c[1] - a[1], l = hypot(dx, dz);
    if(!(l > 0.05)) continue;
    var ux = dx/l, uz = dz/l, lx = uz, lz = -ux;
    function P(p, o, y){ return [p[0] + lx*o, y, p[1] + lz*o]; }
    [-1, 1].forEach(function(sg){
      face(g, [P(a, sg*BW_BASE, yb), P(c, sg*BW_BASE, yb), P(c, sg*BW_CROWN, yc), P(a, sg*BW_CROWN, yc)], jit(WCOL.rock, rnd, 0.05), [lx*sg, 0.6, lz*sg]);
    });
    face(g, [P(a, -BW_CROWN, yc), P(c, -BW_CROWN, yc), P(c, BW_CROWN, yc), P(a, BW_CROWN, yc)], WCOL.rock, UP);
    // the crown walk: a concrete slab
    var ys = yc + 0.08;
    face(g, [P(a, -BW_WALK, ys), P(c, -BW_WALK, ys), P(c, BW_WALK, ys), P(a, BW_WALK, ys)], WCOL.walk, UP);
    [-1, 1].forEach(function(sg){ face(g, [P(a, sg*BW_WALK, yc), P(c, sg*BW_WALK, yc), P(c, sg*BW_WALK, ys), P(a, sg*BW_WALK, ys)], WCOL.walk, [lx*sg, 0, lz*sg]); });
    if(k === 0) face(g, [P(a, -BW_BASE, yb), P(a, BW_BASE, yb), P(a, BW_CROWN, yc), P(a, -BW_CROWN, yc)], WCOL.rock, [-ux, 0.3, -uz]);
    if(k + 2 === L.length) face(g, [P(c, -BW_BASE, yb), P(c, BW_BASE, yb), P(c, BW_CROWN, yc), P(c, -BW_CROWN, yc)], WCOL.rock, [ux, 0.3, uz]);
    // boulders every 2.5 m on each slope, above the water
    for(var s = 1.2; s < l; s += 2.5) [-1, 1].forEach(function(sg){
      var f = 0.25 + rnd()*0.5, o = sg*(BW_CROWN + (BW_BASE - BW_CROWN)*f), y = yc + (yb - yc)*f;
      if(y < sea - 0.6) return;
      var h = 0.5 + rnd()*0.5, yaw = rnd()*Math.PI, cx = a[0] + ux*s + lx*o, cz = a[1] + uz*s + lz*o;
      boulder(g, cx, y, cz, 0.6 + rnd()*0.5, h, yaw, jit(WCOL.rock, rnd, 0.1));
    });
  }
}
function boulder(g, x, y, z, r, h, yaw, c){
  var cs = Math.cos(yaw), sn = Math.sin(yaw), C = [];
  [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(function(q){ C.push([x + (q[0]*cs - q[1]*sn)*r, z + (q[0]*sn + q[1]*cs)*r]); });
  var lo = y - 0.3, hi = y + h;
  face(g, [[C[0][0], hi, C[0][1]], [C[1][0], hi, C[1][1]], [C[2][0], hi, C[2][1]], [C[3][0], hi, C[3][1]]], c, UP);
  for(var k = 0; k < 4; k++){
    var p = C[k], q = C[(k + 1) % 4], ox = (p[0] + q[0])/2 - x, oz = (p[1] + q[1])/2 - z;
    face(g, [[p[0], lo, p[1]], [q[0], lo, q[1]], [q[0], hi, q[1]], [p[0], hi, p[1]]], c, [ox, 0, oz]);
  }
}
// Lily pads (octagons with a notch, in clusters 2-7 m off the shore) and reeds (crossed blades in the shallows) on a
// lake's banks: one try every 10 m of shore with land behind it, seeded; at most LILY_MAX pads and REED_MAX blades a world
function plants(W, R, r, g, rnd){
  var C = prep(W), cnt = C.plantCount || (C.plantCount = {lily: 0, reed: 0}), P = r.P, n = P.length, y = r.b.y;
  for(var k = 0; k < n; k++){
    var a = P[k], c = P[(k + 1) % n], dx = c[0] - a[0], dz = c[1] - a[1], l = hypot(dx, dz);
    if(!(l > 0.5)) continue;
    var ux = dx/l, uz = dz/l, wx = -uz, wz = ux;
    for(var s = rnd()*10; s < l; s += 10){
      var bx = a[0] + ux*s, bz = a[1] + uz*s, pick = rnd();
      if(wetElse(W, R, bx - wx*1.5, bz - wz*1.5, r)) continue;
      if(pick < 0.4 && cnt.lily < LILY_MAX){
        var m = 3 + Math.floor(rnd()*3), d0 = 2 + rnd()*5;
        for(var j = 0; j < m && cnt.lily < LILY_MAX; j++){
          var px = bx + wx*(d0 + rnd()*2) + ux*(rnd() - 0.5)*3, pz = bz + wz*(d0 + rnd()*2) + uz*(rnd() - 0.5)*3;
          if(!inPoly(P, px, pz) || r.I.some(function(I){ return inPoly(I, px, pz); })) continue;
          lily(g, px, y + 0.02, pz, 0.35 + rnd()*0.25, rnd()*2*Math.PI, jit(WCOL.lily, rnd, 0.12), rnd() < 0.2);
          cnt.lily++;
        }
      } else if(pick < 0.85 && cnt.reed < REED_MAX){
        var mb = 6 + Math.floor(rnd()*5);
        for(var q = 0; q < mb && cnt.reed < REED_MAX; q++){
          var rx = bx + wx*rnd()*1.8 + ux*(rnd() - 0.5)*2.5, rz = bz + wz*rnd()*1.8 + uz*(rnd() - 0.5)*2.5, h = 1 + rnd()*0.7, yw = rnd()*Math.PI;
          var ex = Math.cos(yw)*0.06, ez = Math.sin(yw)*0.06, tip = [rx + (rnd() - 0.5)*0.3, y + h, rz + (rnd() - 0.5)*0.3], cr = jit(WCOL.reed, rnd, 0.12);
          face(g, [[rx - ex, y - 0.3, rz - ez], [rx + ex, y - 0.3, rz + ez], tip], cr, [-ez, 0, ex]);
          face(g, [[rx + ez, y - 0.3, rz - ex], [rx - ez, y - 0.3, rz + ex], tip], cr, [ex, 0, ez]);
          cnt.reed++;
        }
      }
    }
  }
}
function lily(g, x, y, z, rad, rot, c, flower){
  var pts = [];
  for(var k = 0; k < 8; k++){ var t = rot + k/8*2*Math.PI; pts.push([x + Math.cos(t)*rad, y, z + Math.sin(t)*rad]); }
  for(k = 0; k < 7; k++) face(g, [[x, y, z], pts[k], pts[k + 1]], c, UP);   // the eighth wedge is the notch
  if(flower) face(g, [[x - 0.08, y + 0.08, z], [x + 0.08, y + 0.08, z], [x, y + 0.08, z + 0.1]], WCOL.flower, UP);
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

// A lot with a `front` (Q16 unit vector its door faces) gets a building turned to it (oriented below), a lot with
// only a `poly` one fitted in its ring facing `facing`; every other lot the axis-aligned building of its rect, its
// portico on the `facing` side (the @1 path).
var FACING = {north: {x: 0, z: 1}, south: {x: 0, z: -1}, east: {x: 1, z: 0}, west: {x: -1, z: 0}};
function building(W, lot, detail, body, win){
  var Q = WQ(), F = frontOf(lot) || (lot.poly ? FACING[lot.facing] || FACING.north : null);
  if(F){ oriented(W, lot, detail, body, win, F); return; }
  var R = Q.buildingRect(lot);
  if(!(R.x1 - R.x0 > 0.5 && R.z1 - R.z0 > 0.5)) return;
  var ys = [gY(W, R.x0, R.z0), gY(W, R.x1, R.z0), gY(W, R.x0, R.z1), gY(W, R.x1, R.z1)];
  shell(W, lot, detail, body, win, R, ys, lot.facing);
}
function frontOf(lot){
  var f = lot && lot.front;
  if(!f || !(f.length >= 2) || !isFinite(f[0]) || !isFinite(f[1])) return null;
  var x = f[0]/65536, z = f[1]/65536, l = hypot(x, z);
  return l > 1e-6 ? {x: x/l, z: z/l} : null;
}
// The lot's frame turned to F: local +z along F (the door's way), local +x to its right (F.z, -F.x), so local
// (u, v) is world (o.x + u F.z + v F.x, o.z - u F.x + v F.z), a pure rotation. The building is the largest centred
// rect (1 m inside the ring, as buildingRect keeps 1 m inside the @1 rect) found by shrinking from the ring's extent
// around its centroid and its biggest triangles' centroids: a concave lot keeps its building out of the notch.
function fitRect(lot, F){
  var P = lot.poly ? polyM(lot.poly) : null;
  if(!P || P.length < 3){
    var R0 = {x0: ((lot.x || 0) - (lot.w || 0)/2)/100, x1: ((lot.x || 0) + (lot.w || 0)/2)/100, z0: ((lot.z || 0) - (lot.d || 0)/2)/100, z1: ((lot.z || 0) + (lot.d || 0)/2)/100};
    P = [[R0.x0, R0.z0], [R0.x1, R0.z0], [R0.x1, R0.z1], [R0.x0, R0.z1]];
  }
  if(!(Math.abs(polyArea(P)) > 1)) return null;
  var tri = triangulate(flatOf(P)), cand = [polyCentroid(P)], ts = [];
  for(var t = 0; t < tri.length; t += 3){
    var a = P[tri[t]], b = P[tri[t+1]], c = P[tri[t+2]];
    ts.push({c: [(a[0] + b[0] + c[0])/3, (a[1] + b[1] + c[1])/3], A: Math.abs(polyArea([a, b, c])), k: t});
  }
  ts.sort(function(p, q){ return q.A - p.A || p.k - q.k; });
  ts.slice(0, 4).forEach(function(s){ cand.push(s.c); });
  var best = null;
  cand.forEach(function(o){
    var L = P.map(function(p){ var dx = p[0] - o[0], dz = p[1] - o[1]; return [dx*F.z - dz*F.x, dx*F.x + dz*F.z]; });
    if(!inPoly(L, 0, 0)) return;
    var u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    L.forEach(function(p){ u0 = Math.min(u0, p[0]); u1 = Math.max(u1, p[0]); v0 = Math.min(v0, p[1]); v1 = Math.max(v1, p[1]); });
    var hu = Math.min(-u0, u1) - 1, hv = Math.min(-v0, v1) - 1;
    for(var k = 0; k < 40 && hu > 0.25 && hv > 0.25 && !rectIn(L, hu + 1, hv + 1); k++){ hu *= 0.94; hv *= 0.94; }
    if(!(hu > 0.25 && hv > 0.25) || !rectIn(L, hu + 1, hv + 1)) return;
    if(!best || hu*hv > best.hu*best.hv) best = {o: {x: o[0], z: o[1]}, hu: hu, hv: hv};
  });
  return best;
}
// is the centred rect [-hu, hu] x [-hv, hv] inside ring L: its corners inside and no edge of L entering it
function rectIn(L, hu, hv){
  var C = [[-hu, -hv], [hu, -hv], [hu, hv], [-hu, hv]];
  for(var k = 0; k < 4; k++) if(!inPoly(L, C[k][0], C[k][1])) return false;
  for(k = 0; k < L.length; k++){
    var a = L[k], b = L[(k + 1) % L.length], t0 = 0, t1 = 1, d = [b[0] - a[0], b[1] - a[1]];
    // Liang-Barsky clip of a-b against the open rect (1 mm inside it)
    var ok = [[-d[0], a[0] + hu - 1e-3], [d[0], hu - 1e-3 - a[0]], [-d[1], a[1] + hv - 1e-3], [d[1], hv - 1e-3 - a[1]]].every(function(pq){
      if(pq[0] === 0) return pq[1] > 0;
      var r = pq[1]/pq[0];
      if(pq[0] < 0){ if(r > t1) return false; if(r > t0) t0 = r; }
      else { if(r < t0) return false; if(r < t1) t1 = r; }
      return true;
    });
    if(ok && t1 - t0 > 1e-9) return false;
  }
  return true;
}
// The building a lot with a `front` or a `poly` stands as (null for an @1 lot, or a lot too small to build on):
// its centre o, door direction F and half extents hu (across F) and hv (along F), in metres, as oriented() draws it.
// world.js blocks movement with exactly this box.
function footprint(lot){
  var F = frontOf(lot) || (lot && lot.poly ? FACING[lot.facing] || FACING.north : null);
  if(!F) return null;
  var f = fitRect(lot, F);
  return f ? {o: f.o, F: F, hu: f.hu, hv: f.hv} : {o: {x: 0, z: 0}, F: F, hu: 0, hv: 0};
}
function oriented(W, lot, detail, body, win, F){
  var Q = WQ(), fit = fitRect(lot, F);
  if(!fit) return;
  var o = fit.o, R = {x0: -fit.hu, x1: fit.hu, z0: -fit.hv, z1: fit.hv};
  function wx(u, v){ return [o.x + u*F.z + v*F.x, o.z - u*F.x + v*F.z]; }
  var ys = [wx(R.x0, R.z0), wx(R.x1, R.z0), wx(R.x0, R.z1), wx(R.x1, R.z1)].map(function(p){ return gY(W, p[0], p[1]); });
  var tb = geo(true), tw = geo(true, true);
  shell(W, lot, detail, tb, tw, R, ys, "north");
  place(tb, body, o, F); place(tw, win, o, F);
}
// append geo s (built in the lot frame) to d, turned and moved into the world
function place(s, d, o, F){
  var base = d.p.length/3, k;
  for(k = 0; k < s.p.length; k += 3){
    var u = s.p[k], v = s.p[k+2], nu = s.n[k], nv = s.n[k+2];
    d.p.push(o.x + u*F.z + v*F.x, s.p[k+1], o.z - u*F.x + v*F.z);
    d.n.push(nu*F.z + nv*F.x, s.n[k+1], -nu*F.x + nv*F.z);
    d.c.push(s.c[k], s.c[k+1], s.c[k+2]);
  }
  if(d.b) for(k = 0; k < s.p.length/3; k++) d.b.push(s.b ? s.b[k] : 0);
  if(d.l) for(k = 0; k < s.p.length/3; k++) d.l.push(s.l ? s.l[k] : 0);
  for(k = 0; k < s.i.length; k++) d.i.push(s.i[k] + base);
}
// one building in the frame of R (world axes for @1, the lot frame for an oriented lot); ys = the ground at R's corners
function shell(W, lot, detail, body, win, R, ys, facing){
  var Q = WQ();
  var gy = Math.max.apply(null, ys), yb = Math.min.apply(null, ys) - 1;
  var floors = Math.max(1, lot.floors|0), yt = gy + floors*FLOOR_H, bid = +lot.id || 0;
  var style = styleOf(W, lot), r = rng(Q.hash32(W.hash + ":lot:" + lot.id));
  var lu = useOf(W, lot), CL = lu ? HQV.cityLife : null;
  // a window's lit attribute: its use's code (lit by the hour) with city life, else the old flag (lit when v < p)
  function lit(v, p){ return CL ? CL.litCode(lu.use, v) : (v < p ? 1 : 0); }
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
      face(win, [F.p(ub, yt, 0), F.p(ub, yt + th, 0), F.p(ub, yt + th, V), F.p(ub, yt, V)], GLASS.ind, F.d(1, 0, 0), bid, lit(r(), 0.5));
      face(body, [F.p(ua, yt, 0), F.p(ub, yt, 0), F.p(ub, yt + th, 0)], wc, F.d(0, 0, -1), bid);
      face(body, [F.p(ua, yt, V), F.p(ub, yt, V), F.p(ub, yt + th, V)], wc, F.d(0, 0, 1), bid);
    }
  } else {
    flatRoof(body, R, yt, rc, bid);
    if(style === "civ"){
      // a portico on the door side: columns and a lintel, inside the lot
      var front = facing === "south" ? -1 : 1, zf = front > 0 ? R.z1 : R.z0, zc = zf + front*0.75;
      var ch = Math.min(floors*FLOOR_H, 7), nC = Math.max(4, Math.floor((R.x1 - R.x0)/3)), dx = (R.x1 - R.x0 - 1)/(nC - 1);
      for(var ci = 0; ci < nC; ci++){
        var cx = R.x0 + 0.5 + ci*dx;
        boxFaces(body, cx - 0.25, cx + 0.25, gy - 0.2, gy + ch, zc - 0.25, zc + 0.25, wc, bid, false);
      }
      var za = Math.min(zf, zc + front*0.4), zb = Math.max(zf, zc + front*0.4);
      boxFaces(body, R.x0 + 0.1, R.x1 - 0.1, gy + ch, gy + ch + 0.5, za, zb, wc, bid, true);
    }
  }
  // windows (with city life: the ground floor's front is its shopfront, lobby or loading bay instead; a civic block
  // keeps its portico)
  var glass = GLASS[style], fd = FACING[facing] || FACING.north, shop = lu && lu.ground !== "door" && style !== "civ";
  if(lu && (style === "com" || style === "civ")) roofKit(W, lot, lu, body, R, yt, floors, wc, bid);
  wallList(R).forEach(function(wl){
    var front = shop && wl.out[0] === fd.x && wl.out[1] === fd.z && wl.L >= 3;
    if(front) groundFloor(W, lot, lu, body, win, wl, gy, bid);
    for(var f = front ? 1 : 0; f < floors; f++){
      var fy = gy + f*FLOOR_H;
      if(style === "com"){
        if(wl.L > 1.4) windowQuad(win, wl, 0.5, wl.L - 0.5, fy + 0.9, fy + 2.7, glass, bid, lit(r(), 0.6));
        continue;
      }
      var bay = style === "ind" ? 5 : 3, ww = style === "ind" ? 2.2 : (style === "civ" ? 1.4 : 1.3);
      var y0 = fy + (style === "civ" ? 0.8 : 1.0), y1 = fy + (style === "civ" ? 2.8 : 2.4);
      var nb = Math.floor((wl.L - 1)/bay);
      if(nb < 1) continue;
      var bw = (wl.L - 1)/nb;
      for(var k = 0; k < nb; k++){
        var uc = 0.5 + (k + 0.5)*bw;
        windowQuad(win, wl, uc - ww/2, uc + ww/2, y0, y1, glass, bid, lit(r(), 0.45));
      }
    }
  });
}
// ---- city life (HQV.cityLife loaded): the lot's use, read from the whole world (the same at every tier) ----
function useOf(W, lot){
  var L = HQV.cityLife;
  if(!L || !L.landUse || !lot) return null;
  return L.landUse(W.tierBase || W)[lot.id] || null;
}
// a point on wall wl: u along it, d out from it, at height y
function onWall(wl, u, y, d){ return [wl.o[0] + wl.u[0]*u + wl.out[0]*d, y, wl.o[1] + wl.u[1]*u + wl.out[1]*d]; }
function wallQuad(g, wl, u0, u1, y0, y1, d, c, bid, lit){
  face(g, [onWall(wl, u0, y0, d), onWall(wl, u1, y0, d), onWall(wl, u1, y1, d), onWall(wl, u0, y1, d)], c, [wl.out[0], 0, wl.out[1]], bid, lit);
}
// a box standing out of wall wl (u0..u1 along it, d0..d1 out, y0..y1): its front, ends, top and underside
function wallBox(g, wl, u0, u1, d0, d1, y0, y1, c, bid){
  var s = [wl.u[0], 0, wl.u[1]];
  wallQuad(g, wl, u0, u1, y0, y1, d1, c, bid);
  face(g, [onWall(wl, u0, y0, d0), onWall(wl, u0, y0, d1), onWall(wl, u0, y1, d1), onWall(wl, u0, y1, d0)], c, [-s[0], 0, -s[2]], bid);
  face(g, [onWall(wl, u1, y0, d0), onWall(wl, u1, y0, d1), onWall(wl, u1, y1, d1), onWall(wl, u1, y1, d0)], c, s, bid);
  face(g, [onWall(wl, u0, y1, d0), onWall(wl, u1, y1, d0), onWall(wl, u1, y1, d1), onWall(wl, u0, y1, d1)], c, UP, bid);
  face(g, [onWall(wl, u0, y0, d0), onWall(wl, u1, y0, d0), onWall(wl, u1, y0, d1), onWall(wl, u0, y0, d1)], c, [0, -1, 0], bid);
}
// The ground floor's front (wall wl, the door's side): "shop" a glazed shopfront under a fascia with a sign plate and an
// awning in a seeded colour, "cafe" the same under a striped awning, "lobby" a tall glazed entrance under a canopy,
// "loading" a roller shutter (two on a long wall). Glass and sign plates are window quads lit by opening hours.
function groundFloor(W, lot, lu, body, win, wl, gy, bid){
  var Q = WQ(), CL = HQV.cityLife, r = rng(Q.hash32(W.hash + ":front:" + lot.id)), L = wl.L, g0 = lu.ground;
  var awn = AWNINGS[Math.floor(r()*AWNINGS.length)];
  if(g0 === "shop" || g0 === "cafe"){
    var u0 = 0.35, u1 = L - 0.35, code = CL.litCode(g0, r()), yg = gy + 2.7, ya = gy + 2.35, out = 1.2;
    wallQuad(win, wl, u0, u1, gy + 0.3, yg, 0.04, SHOP_GLASS, bid, code);                     // the shop window
    wallQuad(body, wl, u0 - 0.1, u1 + 0.1, gy + 0.05, gy + 0.3, 0.06, FASCIA, bid);           // its stall riser
    wallQuad(body, wl, u0 - 0.1, u1 + 0.1, yg + 0.05, gy + 3.35, 0.06, FASCIA, bid);           // the fascia
    var sw = Math.min(3.4, 0.6*(u1 - u0)), sc = (u0 + u1)/2;
    wallQuad(win, wl, sc - sw/2, sc + sw/2, yg + 0.2, gy + 3.2, 0.09, CREAM, bid, code);      // the sign plate
    // the awning: from the wall under the fascia, down and out over the pavement, with a valance (striped at a cafe)
    var n = g0 === "cafe" ? Math.max(2, Math.min(14, Math.round((u1 - u0)/0.9))) : 1, du = (u1 - u0)/n;
    for(var k = 0; k < n; k++){
      var a = u0 + k*du, b = a + du, c = g0 === "cafe" && k % 2 ? CREAM : awn;
      var P = [onWall(wl, a, yg + 0.05, 0.06), onWall(wl, b, yg + 0.05, 0.06), onWall(wl, b, ya, out), onWall(wl, a, ya, out)];
      face(body, P, c, [wl.out[0], 1, wl.out[1]], bid);
      face(body, P, c, [-wl.out[0]*0.3, -1, -wl.out[1]*0.3], bid);
      wallQuad(body, wl, a, b, ya - 0.28, ya, out, c, bid);
    }
  } else if(g0 === "lobby"){
    var we = Math.min(L - 1, 4.6), uc = L/2;
    wallQuad(win, wl, uc - we/2, uc + we/2, gy + 0.1, gy + 3.2, 0.04, SHOP_GLASS, bid, CL.litCode(lu.use === "home" ? "home" : "office", r()));
    wallBox(body, wl, uc - we/2 - 0.4, uc + we/2 + 0.4, 0, 1.6, gy + 3.3, gy + 3.5, FASCIA, bid);
  } else if(g0 === "loading"){
    var ns = L >= 13 ? 2 : 1, sw2 = Math.min(L/ns - 1.2, 4.2);
    for(var j = 0; j < ns; j++){
      var cu = L*(j + 0.5)/ns, a2 = cu - sw2/2, b2 = cu + sw2/2, top = gy + 3.0;
      for(var q = 0; q < 6; q++) wallQuad(body, wl, a2, b2, gy + 0.05 + q*(top - gy - 0.05)/6, gy + 0.05 + (q + 1)*(top - gy - 0.05)/6, 0.05, SHUTTER[q % 2], bid);
      wallBox(body, wl, a2 - 0.15, b2 + 0.15, 0, 0.25, top, top + 0.3, FASCIA, bid);           // the shutter box
    }
  }
}
// A flat roof's clutter, seeded: one to four AC units, a stair housing on taller blocks, an antenna, and a water tank
// on a homes' block in the centre or a home district. Boxes inside the roof, 1.2 m in from its edge.
function roofKit(W, lot, lu, body, R, yt, floors, wc, bid){
  var Q = WQ(), r = rng(Q.hash32(W.hash + ":roof:" + lot.id)), lx = R.x1 - R.x0, lz = R.z1 - R.z0;
  if(!(lx > 5 && lz > 5)) return;
  function spot(w, d){ return {x: R.x0 + 1.2 + w/2 + r()*(lx - 2.4 - w), z: R.z0 + 1.2 + d/2 + r()*(lz - 2.4 - d)}; }
  var nAC = 1 + Math.floor(r()*(lx*lz > 400 ? 4 : 3));
  for(var i = 0; i < nAC; i++){ var p = spot(1.4, 1); boxFaces(body, p.x - 0.7, p.x + 0.7, yt, yt + 0.9, p.z - 0.5, p.z + 0.5, ROOFKIT.ac, bid, true); }
  if(floors >= 4 && lx > 8 && lz > 8 && r() < 0.7){ var h = spot(2.6, 2.4); boxFaces(body, h.x - 1.3, h.x + 1.3, yt, yt + 2.6, h.z - 1.2, h.z + 1.2, wc, bid, true); }
  if(r() < 0.45){ var m = spot(0.2, 0.2); boxFaces(body, m.x - 0.05, m.x + 0.05, yt, yt + 3.6, m.z - 0.05, m.z + 0.05, ROOFKIT.mast, bid, true); }
  if(lu.use === "home" && (lu.group === "centre" || lu.group === "home") && r() < 0.75){
    var t = spot(2.4, 2.4), y0 = yt + 0.5, y1 = y0 + 1.8, ring = [];
    boxFaces(body, t.x - 0.9, t.x + 0.9, yt, y0, t.z - 0.9, t.z + 0.9, ROOFKIT.mast, bid, false);
    for(var k = 0; k < 8; k++){ var a = k/8*2*Math.PI; ring.push([t.x + Math.cos(a)*1.1, t.z + Math.sin(a)*1.1]); }
    for(k = 0; k < 8; k++){
      var A = ring[k], B = ring[(k + 1) % 8], mx = (A[0] + B[0])/2 - t.x, mz = (A[1] + B[1])/2 - t.z;
      face(body, [[A[0], y0, A[1]], [B[0], y0, B[1]], [B[0], y1, B[1]], [A[0], y1, A[1]]], ROOFKIT.tank, [mx, 0, mz], bid);
    }
    face(body, ring.map(function(q){ return [q[0], y1, q[1]]; }), ROOFKIT.tank, UP, bid);
  }
}

function buildingTile(W, tx, tz, detail){
  var CL = HQV.cityLife && HQV.cityLife.landUse ? HQV.cityLife : null, body = geo(true, !!(CL && detail)), win = geo(true, true);
  (W.lots || []).forEach(function(lot){
    if(lot.kind !== "building" || !inTile(lot.x/100, lot.z/100, tx, tz)) return;
    var n0 = body.p.length/3;
    building(W, lot, detail ? 1 : 0, body, win);
    // detail 1 (city life): the body's shader rows light by the lot's use, 2 + its LIT index (the shader adds r)
    var lu = body.l ? useOf(W, lot) : null;
    if(lu) for(var k = n0; k < body.l.length; k++) body.l[k] = 2 + CL.LIT.indexOf(lu.use);
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
  var g1 = gY(W, p.x + p.lx*o, p.z + p.lz*o), g2 = gY(W, p.x - p.lx*o, p.z - p.lz*o);
  return {x: p.x, y: gY(W, p.x, p.z), z: p.z, yaw: Math.atan2(-dir*p.dx, -dir*p.dz), ref: Rt.ref, text: text,
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
  var HS = holeSet(W);
  function put(kind, o){
    if(HS && inHoles(HS, o.x, o.z)) return;   // @3: nothing stands in a terrain hole
    var t = tileOf(o.x, o.z), k = tileKey(t.tx, t.tz);
    var b = B[k] || (B[k] = {trees: [], lamps: [], parked: [], signs: [], gantries: [], furniture: []});
    b[kind].push(o);
  }
  Q.trees(W).forEach(function(t){ put("trees", {x: t.x, y: gY(W, t.x, t.z), z: t.z, s: t.s, kind: t.kind}); });
  C.E.forEach(function(E){
    if(E.walk > 0 && (streetish(E.cls) || aveish(E.cls))){
      // lamps every 30 m on both sidewalks, staggered by 15 m
      [1, -1].forEach(function(sg){
        for(var s = E.tA + 6 + (sg < 0 ? 15 : 0); s < E.len - E.tB - 6; s += 30){
          var p = pointAt(E, s), o = sg*(E.half - 0.35), x = p.x + p.lx*o, z = p.z + p.lz*o;
          put("lamps", {x: x, y: gY(W, x, z), z: z, yaw: Math.atan2(-sg*p.lx, -sg*p.lz)});
        }
      });
    }
    if(E.walk > 0 && streetish(E.cls)){
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
          put("parked", {x: x, y: gY(W, x, z), z: z, yaw: Math.atan2(sg*p.dx, sg*p.dz), color: CAR_COLORS[(h >>> 8) % CAR_COLORS.length]});
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
      put("signs", {x: x, y: gY(W, x, z), z: z, yaw: Math.atan2(S.dx, S.dz), name: E.name, ref: E.ref, edge: E.id, node: id});
      // corner lamp between this arm and the next (this arm's left side)
      if(E.walk > 0 && (streetish(E.cls) || aveish(E.cls))){
        var C2 = armStation(E, a.end, Math.min(a.t + 0.8, E.len/2)), lo = E.half - 0.35;
        var lx = C2.x + C2.lx*lo, lz = C2.z + C2.lz*lo;
        put("lamps", {x: lx, y: gY(W, lx, lz), z: lz, yaw: Math.atan2(-C2.lx, -C2.lz)});
      }
    });
  });
  gantries(W, C).forEach(function(g){ put("gantries", g); });
  // city life: benches, bins, racks, kiosks, stalls and cafe tables on the kerb-side strip, on the ground
  var CL = HQV.cityLife;
  if(CL && CL.furniture) CL.furniture(W).forEach(function(f){
    var o = {kind: f.kind, x: f.x, y: gY(W, f.x, f.z), z: f.z, yaw: f.yaw};
    if(f.kind === "stall" || f.kind === "table"){ o.c = AWNINGS[(Q.hash32(hash + ":furn:" + f.edge + ":" + f.x.toFixed(1) + ":" + f.z.toFixed(1)) >>> 0) % AWNINGS.length]; }
    put("furniture", o);
  });
  C.props = B;
  return B;
}
function props(W, tx, tz){
  var b = allProps(W)[tileKey(tx, tz)];
  function cp(a){ return a ? a.map(function(o){ var c = {}; for(var k in o) c[k] = o[k]; return c; }) : []; }
  var o = {trees: cp(b && b.trees), lamps: cp(b && b.lamps), parked: cp(b && b.parked), signs: cp(b && b.signs), gantries: cp(b && b.gantries)};
  if(HQV.cityLife) o.furniture = cp(b && b.furniture);
  return o;
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

/* ---------- min_tier: the world as a city tier shows it ---------- */
// the first tier an item exists in (0: every tier). Lots, blocks and edges carry min_tier; a site carries tier
// (@1 sites carry neither, and a lot's own `tier` field is not this)
function minTier(o, site){
  var t = o && o.min_tier != null ? o.min_tier : (site && o ? o.tier : null);
  return t != null && isFinite(+t) ? +t : 0;
}
function shown(tier){ return function(o){ return minTier(o) <= tier; }; }
// view(W, tier): W without the edges, blocks, lots and sites whose first tier is above `tier` (W itself when nothing is
// hidden, e.g. any @1 doc, or when tier is null). A view is a shallow copy with its own lazy index (world.js) and keeps
// W as tierBase: block planes, the beach and the per-W caches of the views of one world stay shared and comparable.
var VIEWS = [];
function view(W, tier){
  var B = (W && W.tierBase) || W;
  if(!B || tier == null || !isFinite(+tier)) return B;
  tier = Math.floor(+tier);
  for(var k = 0; k < VIEWS.length; k++) if(VIEWS[k].B === B && VIEWS[k].t === tier) return VIEWS[k].V;
  function keep(L, site){ return (L || []).filter(function(o){ return minTier(o, site) <= tier; }); }
  var edges = (B.edges || []).filter(shown(tier)), blocks = keep(B.blocks), lots = keep(B.lots), sites = keep(B.sites, true), V = B;
  if(edges.length !== (B.edges || []).length || blocks.length !== (B.blocks || []).length ||
     lots.length !== (B.lots || []).length || sites.length !== (B.sites || []).length){
    V = {};
    for(var key in B) if(Object.prototype.hasOwnProperty.call(B, key)) V[key] = B[key];
    V.edges = edges; V.blocks = blocks; V.lots = lots; V.sites = sites; V.index = null; V.tierBase = B; V.tier = tier;
  }
  VIEWS = VIEWS.filter(function(v){ return v.B === B; }).slice(-5);
  VIEWS.push({B: B, t: tier, V: V});
  return V;
}
// Which tiles (per product) differ between tiers a and b: a sound, cheap superset found from the items whose first
// tier lies between them, without building anything. Each changed item is a box (an edge with every edge sharing its
// nodes: their junctions and trims move); a product's tiles are those its pieces can reach from a box:
//   roads     the edge boxes themselves (ribbons and junction patches of those edges)
//   terrain   the boxes + TERRAIN_REACH (a vertex reads every piece its star overlaps, <= 32 m, plus the 4 m pad blend)
//   ground    the centroid tiles of the ground items within TERRAIN_REACH (their kerbs reach down to the terrain)
//   buildings the centre tiles of the building lots within BLEND_REACH (their bases read groundAt)
//   props     the boxes + PROP_REACH (lamps, signs, parked cars, tree clearance); every gantry tile if a graded edge changed
// -> {terrain, roads, ground, buildings, props: ["tx,tz", ...]}, sorted; all empty when a and b show the same world
var TERRAIN_REACH = 40, BLEND_REACH = 5, PROP_REACH = 12;
function tierDiff(W, a, b){
  var B = (W && W.tierBase) || W, out = {terrain: [], roads: [], ground: [], buildings: [], props: []};
  if(!B || a == null || b == null || !isFinite(+a) || !isFinite(+b)) return out;
  var lo = Math.min(Math.floor(+a), Math.floor(+b)), hi = Math.max(Math.floor(+a), Math.floor(+b));
  if(lo === hi) return out;
  function moved(o, site){ var t = minTier(o, site); return t > lo && t <= hi; }
  var boxes = [], graded = false, inc = {};
  function box(x0, x1, z0, z1){ return {x0: x0, x1: x1, z0: z0, z1: z1}; }
  function edgeBox(e){
    var p = e.pts, h = e.width/200, R = box(Infinity, -Infinity, Infinity, -Infinity);
    for(var j = 0; j < p.length; j += 3){
      R.x0 = Math.min(R.x0, p[j]/100 - h); R.x1 = Math.max(R.x1, p[j]/100 + h);
      R.z0 = Math.min(R.z0, p[j+2]/100 - h); R.z1 = Math.max(R.z1, p[j+2]/100 + h);
    }
    return R;
  }
  function polyBox(o){
    var R = box((o.x - o.w/2)/100, (o.x + o.w/2)/100, (o.z - o.d/2)/100, (o.z + o.d/2)/100);
    (o.poly || []).forEach(function(p){
      R.x0 = Math.min(R.x0, p[0]/100); R.x1 = Math.max(R.x1, p[0]/100); R.z0 = Math.min(R.z0, p[1]/100); R.z1 = Math.max(R.z1, p[1]/100);
    });
    return R;
  }
  (B.edges || []).forEach(function(e){ (inc[e.a] = inc[e.a] || []).push(e); (inc[e.b] = inc[e.b] || []).push(e); });
  (B.edges || []).forEach(function(e){
    if(!moved(e)) return;
    if(e.cls === "highway" || e.cls === "ring") graded = true;
    var R = edgeBox(e);
    R.road = true; boxes.push(R);
    (inc[e.a] || []).concat(inc[e.b] || []).forEach(function(f){ if(f !== e){ var F = edgeBox(f); F.road = true; boxes.push(F); } });
  });
  (B.blocks || []).forEach(function(o){ if(moved(o) && o.poly) boxes.push(polyBox(o)); });
  (B.lots || []).forEach(function(o){ if(moved(o)) boxes.push(polyBox(o)); });
  (B.sites || []).forEach(function(o){ if(moved(o, true)) boxes.push(polyBox(o)); });
  if(!boxes.length) return out;
  var sets = {terrain: {}, roads: {}, ground: {}, buildings: {}, props: {}};
  function near(R, x0, x1, z0, z1, m){ return R.x0 - m <= x1 && R.x1 + m >= x0 && R.z0 - m <= z1 && R.z1 + m >= z0; }
  function cover(set, R, m){
    var t0 = tileOf(R.x0 - m, R.z0 - m), t1 = tileOf(R.x1 + m, R.z1 + m);
    for(var tz = t0.tz; tz <= t1.tz; tz++) for(var tx = t0.tx; tx <= t1.tx; tx++) set[tileKey(tx, tz)] = 1;
  }
  boxes.forEach(function(R){ if(R.road) cover(sets.roads, R, 0); cover(sets.terrain, R, TERRAIN_REACH); cover(sets.props, R, PROP_REACH); });
  // ground and buildings land in the tile of their centroid / centre: the union of both tiers' items
  [view(B, lo), view(B, hi)].forEach(function(V){
    groundItems(V).forEach(function(it){
      var x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      it.P.forEach(function(p){ x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); });
      if(boxes.some(function(R){ return near(R, x0, x1, z0, z1, TERRAIN_REACH); })) sets.ground[tileKey(it.tx, it.tz)] = 1;
    });
  });
  (B.lots || []).forEach(function(l){
    if(l.kind !== "building") return;
    var R = polyBox(l);
    if(boxes.some(function(Q){ return near(Q, R.x0, R.x1, R.z0, R.z1, BLEND_REACH); })){ var t = tileOf(l.x/100, l.z/100); sets.buildings[tileKey(t.tx, t.tz)] = 1; }
  });
  if(graded) [view(B, lo), view(B, hi)].forEach(function(V){
    var P = allProps(V);
    Object.keys(P).forEach(function(k){ if(P[k].gantries.length) sets.props[k] = 1; });
  });
  Object.keys(sets).forEach(function(p){
    out[p] = Object.keys(sets[p]).sort(function(x, y){
      var X = x.split(","), Y = y.split(",");
      return (+X[1] - +Y[1]) || (+X[0] - +Y[0]);
    });
  });
  return out;
}

/* ---------- one worker job ---------- */
// m.tier (optional) builds the tile as that city tier shows it (view above); "ground" is the v2 ground (groundTile);
// m.gap leaves the bridges' pieces over the water out of "roads" (roadTile's gap)
function buildTile(W, m){
  m = m || {};
  if(m.tier != null) W = view(W, m.tier);
  var tx = clamp(m.tx|0, 0, NT - 1), tz = clamp(m.tz|0, 0, NT - 1), want = m.want || [], out = {op: "tile", id: m.id, tx: tx, tz: tz};
  if(m.tier != null) out.tier = m.tier;
  if(want.indexOf("terrain") >= 0){ out.terrain = terrainTile(W, tx, tz, m.lods || []); out.lods = (m.lods || []).slice(); }
  if(want.indexOf("roads") >= 0) out.roads = roadTile(W, tx, tz, false, !!m.gap);
  if(want.indexOf("ground") >= 0) out.ground = groundTile(W, tx, tz);
  if(want.indexOf("buildings0") >= 0) out.buildings0 = buildingTile(W, tx, tz, 0);
  if(want.indexOf("buildings1") >= 0) out.buildings1 = buildingTile(W, tx, tz, 1);
  if(want.indexOf("props") >= 0) out.props = props(W, tx, tz);
  return out;
}
// every bridge edge's runs over the water (m along it, each grown ABUT into the banks, trimmed to the edge's ribbon):
// what roadTile(.., gap) leaves out -> [{id (edge id), half, cw, walk, len, runs: [[a, b], ...]}], none without bridges
function bridgeGaps(W){
  var out = [];
  prep(W).E.forEach(function(E){
    if(!E.bridge) return;
    var s0 = E.tA, s1 = E.len - E.tB, runs = [];
    if(s1 - s0 < 0.05) return;
    wetRuns(W, E).forEach(function(r){ var a = Math.max(r[0], s0), b = Math.min(r[1], s1); if(b - a >= 0.05) runs.push([a, b]); });
    if(runs.length) out.push({id: E.id, half: E.half, cw: E.cw, walk: E.walk, len: E.len, runs: runs});
  });
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
  emptyGeo: emptyGeo, CAR_COLORS: CAR_COLORS, AWNINGS: AWNINGS, GANTRY_POST: GANTRY_POST, GANTRY_SINK: GANTRY_SINK,
  groundTile: groundTile, groundItems: groundItems, triangulate: triangulate, hasGround: hasGround, seaY: seaY, view: view,
  tierDiff: tierDiff, footprint: footprint, riverWater: riverWater, riverRing: riverRing, bridgeGaps: bridgeGaps,
  BRIDGE: {DECK_T: DECK_T, PARA_W: PARA_W, PARA_H: PARA_H, RAIL_H: RAIL_H, ABUT: ABUT}, RIVER_LIFT: RIVER_LIFT,
  SEA_HIDE: SEA_HIDE, meshY: meshY,
  waterGeo: waterGeo, tramEdges: tramEdges, cutHoles: cutHoles, holeSet: holeSet, TRAM: {INNER: TRAM_INNER, W: TRAM_W, EDGE: TRAM_EDGE}
};
})();
