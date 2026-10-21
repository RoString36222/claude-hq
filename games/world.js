/* Claude HQ: the generated worlds on the client: Arena City (claude-hq@1), the Commons
 * (claude-hq@2) and the personal islands (user:<id>@2).
 *
 * HQV.world turns the Arena's WorldDoc (integer cm, +y up, +z north) into a packed,
 * structured-clone-friendly object W and answers every ground question the 3D City asks
 * (in metres): terrain height, road surface, pads, what is blocked, trees, slopes, labels.
 *   pack(doc)            -> W (typed arrays; old "country" docs still pack)
 *   heightCm/heightAt    bit-exact port of backend/src/worldgen/terrain.rs Terrain::height_at
 *   roadY/groundAt       the ONE road surface ribbons, terrain clamping and the avatar share
 *   blockedAt, trees     through a 64 m bucket index (never a linear scan)
 *   load({id})           IndexedDB copy by ETag first, then GET /api/arena/world/<id> (default claude-hq@1);
 *                        one memo, cache and onChange per world id
 *   docOf(W)             a WorldDoc-shaped view of a packed W (layers.roads with points, zones,
 *                        transit, island) for the modules that read docs: npcsim, traffic, ocean, hqtravel
 * v2 docs (@2) also pack each edge's min_tier and bridge flag (only when present, so @1 packs as it always did)
 * and the island, transit, zones and river layers, plus the doc's version, profile and seed.
 * The river (layers.river, cm): riverAt(W, x, z) is true on its water (river.poly, metres in, a bounding box
 * first). A bridge edge's points carry its deck height, so roadY/groundAt on a bridge are the deck; no tree
 * stands in the water.
 * Widths: `half` and `carriage` from nearestRoad are HALF widths (m from the centreline):
 * half = width/200, carriage = (width - 2*walk)/200. A point is "road" within `carriage`,
 * "sidewalk" within `half`.
 * Trees: one candidate per 8 m district cell; h = hash32(W.hash + ":" + ix + ":" + iz)
 * (FNV-1a 32 over the UTF-8 bytes), h2 = mix(h) (a murmur3 finaliser step). Placed when
 * (h & 0xffff)/65536 < p (forest 0.55, park 0.18, residential 0.04); x jitter from h bits
 * 16..23, z jitter from h2 bits 0..7 (1..7 m into the cell), s = 0.8 + 0.6 * (h2 bits 8..15)/255,
 * kind "pine" when h2 bits 16..17 are 0 ("round" otherwise; forest flips it: mostly pine).
 * Pure core: no THREE, no DOM at load time, so node, a worker (importScripts) and the page all load it.
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : self;
var HQV = root.HQV = root.HQV || {};

var ID = "claude-hq@1", URL = "/api/arena/world/claude-hq@1", IDB = {db: "hq-world", store: "docs"};
var COMMONS = "claude-hq@2";
// the worlds the client may ask for: the fixed ones and a personal island (the dashboard checks again)
var WORLD_RE = /^(claude-hq@[12]|user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@2)$/;
var PACK_V = 4;   // bump whenever pack()'s output changes; cached records with another v are refetched
                  // (4: v3 records could hold the 3D City's client-side claims, see cacheCopy)
var ONE = 65536, BUCKET = 64, TRUNK = 0.45, CLEAR = 2, BLEND = 4, SIDEWALK_UP = 0.15;
var TREE_P = {forest: 0.55, park: 0.18, residential: 0.04};
var WALK_OLD = {street: 150, avenue: 200};   // sidewalk (cm, each side) for docs older than the walk field

function clamp(v, a, b){ return v < a ? a : (v > b ? b : v); }
function smoothstep(t){ t = clamp(t, 0, 1); return t*t*(3 - 2*t); }

/* ---------- hashing ---------- */
function hash32(str){
  str = String(str == null ? "" : str);
  if(/[^\x00-\x7f]/.test(str)) str = unescape(encodeURIComponent(str));
  var h = 0x811c9dc5;
  for(var i = 0; i < str.length; i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function mix(h){
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}

/* ---------- pack ---------- */
function pack(doc){
  doc = doc || {};
  var L = doc.layers || {}, t = L.terrain || {}, d = L.districts || {}, r = L.roads || {};
  var sizeCm = doc.size_cm || 204800;
  var nodes = (r.nodes || []).map(function(n){ return {id: n.id, x: n.x|0, y: n.y|0, z: n.z|0}; });
  var edges = (r.edges || []).map(function(e){
    var cls = e.class === "country" ? "highway" : String(e.class || "street");
    var old = e.class === "country";
    var pts = new Int32Array(3*((e.points || []).length));
    (e.points || []).forEach(function(p, i){ pts[3*i] = p[0]|0; pts[3*i+1] = p[1]|0; pts[3*i+2] = p[2]|0; });
    var o = {id: e.id, a: e.a, b: e.b, cls: cls, width: e.width|0,
            walk: old ? 0 : (e.walk != null ? e.walk|0 : (WALK_OLD[cls] || 0)),
            lanes: old ? 1 : (e.lanes != null ? e.lanes|0 : 1),
            ref: old ? null : (e.ref != null ? String(e.ref) : null),
            name: e.name != null ? String(e.name) : "", pts: pts};
    if(e.min_tier != null) o.min_tier = e.min_tier|0;      // v2 islands: the tier the road opens in
    if(e.bridge) o.bridge = true;                           // it crosses the river on a deck at its points' y
    return o;
  });
  var W = {
    id: doc.id || ID, etag: null, hash: String((doc.hashes && doc.hashes.world) || ""), sizeCm: sizeCm, half: sizeCm/2/100,
    terrain: {cell: t.cell_cm || 800, origin: t.origin_cm != null ? t.origin_cm : -sizeCm/2, n: t.n|0, h: Int32Array.from(t.heights || [])},
    districts: {cell: d.cell_cm || 800, origin: d.origin_cm != null ? d.origin_cm : -sizeCm/2, n: d.n|0,
                k: Uint8Array.from(d.kinds || []), legend: (d.legend || []).slice()},
    nodes: nodes, edges: edges,
    blocks: L.blocks || [], lots: L.lots || [], sites: L.sites || [],
    index: null
  };
  // v2: the layers the Cities modules read, and what the doc is
  if(doc.version != null) W.v = doc.version|0;
  if(doc.profile != null) W.profile = String(doc.profile);
  if(doc.seed != null) W.seed = String(doc.seed);
  if(L.island) W.island = L.island;
  if(L.transit) W.transit = L.transit;
  if(L.zones) W.zones = L.zones;
  if(L.river) W.river = L.river;
  return W;
}

// A WorldDoc-shaped view of W (cm, the generator's field names), built once per W and never stored:
// npcsim, traffic, ocean and hqtravel read docs, the 3D City keeps the packed W.
function docOf(W){
  if(!W) return null;
  if(W.docView) return W.docView;
  var edges = W.edges.map(function(e){
    var pts = [], p = e.pts;
    for(var i = 0; i + 2 < p.length; i += 3) pts.push([p[i], p[i+1], p[i+2]]);
    var o = {id: e.id, a: e.a, b: e.b, "class": e.cls, width: e.width, walk: e.walk, lanes: e.lanes, name: e.name, points: pts};
    if(e.ref != null) o.ref = e.ref;
    if(e.min_tier != null) o.min_tier = e.min_tier;
    if(e.bridge) o.bridge = true;
    return o;
  });
  var D = W.districts, layers = {roads: {nodes: W.nodes, edges: edges},
    districts: {cell_cm: D.cell, origin_cm: D.origin, n: D.n, legend: D.legend},
    blocks: W.blocks, lots: W.lots, sites: W.sites};
  if(W.zones) layers.zones = W.zones;
  if(W.transit) layers.transit = W.transit;
  if(W.island) layers.island = W.island;
  if(W.river) layers.river = W.river;
  var doc = {id: W.id, seed: W.seed || W.id, version: W.v || 1, profile: W.profile || "city", size_cm: W.sizeCm, layers: layers};
  try { Object.defineProperty(W, "docView", {value: doc, enumerable: false, configurable: true, writable: true}); } catch(e){}
  return doc;
}

/* ---------- the 64 m bucket index (built on first use) ---------- */
function bucketsOf(W){ return Math.max(1, Math.ceil(W.sizeCm/100/BUCKET)); }
function bOf(W, v, nb){ return clamp(Math.floor((v + W.half)/BUCKET), 0, nb - 1); }
// call fn(bucket) for every bucket overlapping [x0,x1] x [z0,z1] (m)
function eachBucket(W, nb, x0, x1, z0, z1, fn){
  var bx0 = bOf(W, x0, nb), bx1 = bOf(W, x1, nb), bz0 = bOf(W, z0, nb), bz1 = bOf(W, z1, nb);
  for(var bz = bz0; bz <= bz1; bz++) for(var bx = bx0; bx <= bx1; bx++) fn(bz*nb + bx);
}
function lists(n){ var a = new Array(n); for(var i = 0; i < n; i++) a[i] = []; return a; }
function rectM(o){ return {x0: (o.x - o.w/2)/100, x1: (o.x + o.w/2)/100, z0: (o.z - o.d/2)/100, z1: (o.z + o.d/2)/100}; }

function index(W){
  if(W.index) return W.index;
  var nb = bucketsOf(W), n = nb*nb;
  var I = {nb: nb, lots: lists(n), sites: lists(n), bld: lists(n), pads: lists(n), segs: lists(n), trees: null, treeList: null,
           bldRect: new Float64Array(4*W.lots.length), bldBox: [], padList: []};
  W.lots.forEach(function(l, i){
    var R = rectM(l);
    eachBucket(W, nb, R.x0, R.x1, R.z0, R.z1, function(b){ I.lots[b].push(i); });
    if(l.kind === "building"){
      // a v2 lot's building is a box turned to its door, fitted inside the lot's polygon (worldgeom
      // footprint): block that box, not the lot's axis-aligned bounds, which reach over the road
      var fp = (l.poly || l.front) && HQV.worldgeom ? HQV.worldgeom.footprint(l) : null, B;
      if(fp){
        var ex = Math.abs(fp.F.z)*fp.hu + Math.abs(fp.F.x)*fp.hv, ez = Math.abs(fp.F.x)*fp.hu + Math.abs(fp.F.z)*fp.hv;
        B = {x0: fp.o.x - ex, x1: fp.o.x + ex, z0: fp.o.z - ez, z1: fp.o.z + ez};
        I.bldBox[i] = fp;
      } else B = buildingRect(l);
      I.bldRect[4*i] = B.x0; I.bldRect[4*i+1] = B.x1; I.bldRect[4*i+2] = B.z0; I.bldRect[4*i+3] = B.z1;
      eachBucket(W, nb, B.x0, B.x1, B.z0, B.z1, function(b){ I.bld[b].push(i); });
    }
    if(l.kind === "hq") I.padList.push({y: ((l.door && l.door[1]) || 0)/100, rect: R});
  });
  W.sites.forEach(function(s, i){
    var R = rectM(s);
    eachBucket(W, nb, R.x0, R.x1, R.z0, R.z1, function(b){ I.sites[b].push(i); });
    // a site is a level pad you walk on at its y, unless it says otherwise (games/hqspectacle.js's park and
    // landmarks only name ground and keep trees off it: you walk the terrain there)
    if(s.pad !== false) I.padList.push({y: (s.y || 0)/100, rect: R});
  });
  I.padList.forEach(function(p, i){
    var R = p.rect;
    eachBucket(W, nb, R.x0 - BLEND, R.x1 + BLEND, R.z0 - BLEND, R.z1 + BLEND, function(b){ I.pads[b].push(i); });
  });
  // segments as flat (edge, seg) pairs, bucketed by their box grown by half + CLEAR, so the
  // point's own bucket holds every segment whose road (or tree clearance) can cover it
  W.edges.forEach(function(e, ei){
    var p = e.pts, m = p.length/3, g = e.width/200 + CLEAR;
    for(var s = 0; s + 1 < m; s++){
      var ax = p[3*s]/100, az = p[3*s+2]/100, bx = p[3*s+3]/100, bz = p[3*s+5]/100;
      eachBucket(W, nb, Math.min(ax, bx) - g, Math.max(ax, bx) + g, Math.min(az, bz) - g, Math.max(az, bz) + g,
                 function(b){ I.segs[b].push(ei, s); });
    }
  });
  W.index = I;
  return I;
}

// project (x, z) on segment s of edge e; results in the scratch S (no allocation in hot loops)
var S = {d: 0, t: 0, x: 0, y: 0, z: 0};
function proj(e, s, x, z){
  var p = e.pts, ax = p[3*s]/100, ay = p[3*s+1]/100, az = p[3*s+2]/100;
  var dx = p[3*s+3]/100 - ax, dy = p[3*s+4]/100 - ay, dz = p[3*s+5]/100 - az;
  var L2 = dx*dx + dz*dz, t = L2 > 0 ? clamp(((x - ax)*dx + (z - az)*dz)/L2, 0, 1) : 0;
  S.t = t; S.x = ax + dx*t; S.y = ay + dy*t; S.z = az + dz*t;
  var qx = x - S.x, qz = z - S.z;
  S.d = Math.sqrt(qx*qx + qz*qz);
}

// the road under (x, z): 0 none, 1 carriageway, 2 sidewalk; the surface y (m) lands in ROAD.y.
// Each edge within its half contributes its nearest segment's y (bendY, so bends inside an edge are already
// blended by arc position); where edges overlap (junctions) their ys are blended with weights that fall to 0 at
// each edge's outer line, so the surface no longer jumps where the nearest edge switches. Off every carriageway the
// sidewalk sits SIDEWALK_UP higher with a real kerb step, matching the drawn walk ribbon (the camera pivot spring
// smooths the step for the view).
var ROAD = {y: 0}, CE = [], CS = [], CD = [], CT = [], CY = [];
function roadUnder(W, x, z){
  var I = index(W), nb = I.nb, L = I.segs[bOf(W, z, nb)*nb + bOf(W, x, nb)], n = 0, gap = Infinity, i, k;
  for(i = 0; i < L.length; i += 2){
    var e = W.edges[L[i]];
    proj(e, L[i+1], x, z);
    gap = Math.min(gap, S.d - (e.width - 2*e.walk)/200);   // every carriageway counts (a highway beside a sidewalk too)
    if(S.d > e.width/200) continue;
    for(k = 0; k < n && CE[k] !== L[i]; k++);
    if(k === n){ n++; CE[k] = L[i]; CD[k] = Infinity; }
    if(S.d < CD[k]){ CD[k] = S.d; CS[k] = L[i+1]; CT[k] = S.t; CY[k] = S.y; }
  }
  if(!n) return 0;
  var sw = 0, sy = 0, best = 0;
  for(k = 0; k < n; k++){
    var ek = W.edges[CE[k]], hk = ek.width/200, y = bendY(ek, CS[k], x, z, CT[k], CY[k]);
    var w = hk > 0 ? smoothstep(1 - CD[k]/hk) : 0;
    sw += w; sy += w*y; CY[k] = y;
    if(CD[k] < CD[best]) best = k;
  }
  ROAD.y = sw > 0 ? sy/sw : CY[best];
  if(gap <= 0) return 1;
  ROAD.y += SIDEWALK_UP;
  return 2;
}
// raw (unclamped) projection parameter of (x, z) on segment s, and its horizontal length (m)
function rawT(p, s, x, z){
  var ax = p[3*s]/100, az = p[3*s+2]/100, dx = p[3*s+3]/100 - ax, dz = p[3*s+5]/100 - az, L2 = dx*dx + dz*dz;
  return L2 > 0 ? ((x - ax)*dx + (z - az)*dz)/L2 : 0;
}
function segLen(p, s){ var dx = (p[3*s+3] - p[3*s])/100, dz = (p[3*s+5] - p[3*s+2])/100; return Math.sqrt(dx*dx + dz*dz); }
// road height by arc position along the edge: u = the projection's distance from the segment start, plus how
// far the point also reaches into the next segment, minus how far it reaches back into the previous one.
// Both extra terms are 0 outside the inner corner of a (< 90 degree) bend and equal on either side of the line where the
// nearest segment switches, so y no longer jumps there. Elsewhere it is the segment's own y.
// the vertex between segments s and s+1 turns by less than 90 degrees (hairpin zigzags keep per-segment y)
function gentle(p, s){
  return (p[3*s+3] - p[3*s])*(p[3*s+6] - p[3*s+3]) + (p[3*s+5] - p[3*s+2])*(p[3*s+8] - p[3*s+5]) > 0;
}
function bendY(e, s, x, z, t, y){
  var p = e.pts, nseg = p.length/3 - 1, Ls = segLen(p, s), ts = rawT(p, s, x, z);
  var LN = s + 1 < nseg && gentle(p, s) ? segLen(p, s + 1) : 0, LP = s > 0 && gentle(p, s - 1) ? segLen(p, s - 1) : 0;
  var q = LN > 0 ? clamp(rawT(p, s + 1, x, z), 0, 1)*LN : 0, r = LP > 0 ? clamp(1 - rawT(p, s - 1, x, z), 0, 1)*LP : 0;
  if(!(q > 0 || r > 0) || !(Ls > 0)) return y;
  var u = clamp(clamp(ts, 0, 1)*Ls + q - r, -LP, Ls + LN), y0 = p[3*s+1]/100, y1 = p[3*s+4]/100;
  if(u < 0) return y0 + (y0 - p[3*s-2]/100)*u/LP;
  if(u > Ls) return y1 + (p[3*s+7]/100 - y1)*(u - Ls)/LN;
  return y0 + (y1 - y0)*u/Ls;
}

// is any road within its half + margin of (x, z)? (margin <= CLEAR)
function roadNear(W, x, z, margin){
  var I = index(W), nb = I.nb, L = I.segs[bOf(W, z, nb)*nb + bOf(W, x, nb)];
  for(var i = 0; i < L.length; i += 2){
    var e = W.edges[L[i]];
    proj(e, L[i+1], x, z);
    if(S.d <= e.width/200 + margin) return true;
  }
  return false;
}

/* ---------- queries ---------- */
function heightCm(W, xCm, zCm){
  var T = W.terrain, c = T.cell, n = T.n, h = T.h, max = (n - 1)*c;
  var lx = clamp(Math.round(xCm) - T.origin, 0, max), lz = clamp(Math.round(zCm) - T.origin, 0, max);
  var ix = Math.trunc(lx/c), iz = Math.trunc(lz/c), ix1 = Math.min(ix + 1, n - 1), iz1 = Math.min(iz + 1, n - 1);
  var fx = Math.trunc((lx % c)*ONE/c), fz = Math.trunc((lz % c)*ONE/c);
  var h00 = h[iz*n + ix], h10 = h[iz*n + ix1], h01 = h[iz1*n + ix], h11 = h[iz1*n + ix1];
  var a = h00 + Math.trunc((h10 - h00)*fx/ONE);
  var b = h01 + Math.trunc((h11 - h01)*fx/ONE);
  return a + Math.trunc((b - a)*fz/ONE);
}
function heightAt(W, x, z){ return heightCm(W, Math.round(x*100), Math.round(z*100))/100; }

function districtAt(W, x, z){
  var D = W.districts, n = D.n;
  var ix = clamp(Math.floor((Math.round(x*100) - D.origin)/D.cell), 0, n - 1);
  var iz = clamp(Math.floor((Math.round(z*100) - D.origin)/D.cell), 0, n - 1);
  var k = D.k[iz*n + ix] || 0;
  return {k: k, name: D.legend[k] != null ? D.legend[k] : ""};
}

function inRectCm(o, xc, zc){ return Math.abs(xc - o.x) <= o.w/2 && Math.abs(zc - o.z) <= o.d/2; }
function lotAt(W, x, z){
  var I = index(W), nb = I.nb, L = I.lots[bOf(W, z, nb)*nb + bOf(W, x, nb)], xc = Math.round(x*100), zc = Math.round(z*100);
  for(var i = 0; i < L.length; i++) if(inRectCm(W.lots[L[i]], xc, zc)) return W.lots[L[i]];
  return null;
}
function siteAt(W, x, z){
  var I = index(W), nb = I.nb, L = I.sites[bOf(W, z, nb)*nb + bOf(W, x, nb)], xc = Math.round(x*100), zc = Math.round(z*100);
  for(var i = 0; i < L.length; i++) if(inRectCm(W.sites[L[i]], xc, zc)) return W.sites[L[i]];
  return null;
}

function nearestRoad(W, x, z, maxM){
  maxM = maxM != null ? +maxM : 40;
  var I = index(W), nb = I.nb, best = null, bd = Infinity;
  eachBucket(W, nb, x - maxM, x + maxM, z - maxM, z + maxM, function(b){
    var L = I.segs[b];
    for(var i = 0; i < L.length; i += 2){
      var e = W.edges[L[i]], s = L[i+1];
      proj(e, s, x, z);
      if(S.d < bd || (S.d === bd && best && e.id < best.edge)){
        bd = S.d;
        var p = e.pts;
        best = {edge: e.id, seg: s, t: S.t, dist: S.d, x: S.x, y: S.y, z: S.z,
                yaw: Math.atan2((p[3*s+3] - p[3*s])/100, (p[3*s+5] - p[3*s+2])/100),
                cls: e.cls, name: e.name, half: e.width/200, carriage: (e.width - 2*e.walk)/200};
      }
    }
  });
  return best && best.dist <= maxM ? best : null;
}

function roadY(W, x, z){ return roadUnder(W, x, z) ? ROAD.y : null; }

function surfaceAt(W, x, z){
  if(Math.abs(x) > W.half || Math.abs(z) > W.half) return "edge";
  var r = roadUnder(W, x, z);
  if(r === 1) return "road";
  if(r === 2) return "sidewalk";
  if(siteAt(W, x, z)) return "site";
  if(lotAt(W, x, z)) return "lot";
  var n = districtAt(W, x, z).name;
  return n === "park" || n === "forest" ? n : "grass";
}

function inRect(R, x, z){ return x >= R.x0 && x <= R.x1 && z >= R.z0 && z <= R.z1; }
function padOf(W, x, z){
  var I = index(W), nb = I.nb, L = I.pads[bOf(W, z, nb)*nb + bOf(W, x, nb)];
  for(var i = 0; i < L.length; i++){
    var p = I.padList[L[i]];
    if(inRect(p.rect, x, z)) return {y: p.y, rect: {x0: p.rect.x0, x1: p.rect.x1, z0: p.rect.z0, z1: p.rect.z1}};
  }
  return null;
}

function groundAt(W, x, z){
  if(roadUnder(W, x, z)) return ROAD.y;
  var I = index(W), nb = I.nb, L = I.pads[bOf(W, z, nb)*nb + bOf(W, x, nb)], bd = Infinity, py = 0;
  for(var i = 0; i < L.length; i++){
    var p = I.padList[L[i]], R = p.rect;
    var dx = Math.max(R.x0 - x, 0, x - R.x1), dz = Math.max(R.z0 - z, 0, z - R.z1);
    var d = Math.sqrt(dx*dx + dz*dz);
    if(d === 0) return p.y;
    if(d < bd){ bd = d; py = p.y; }
  }
  var h = heightAt(W, x, z);
  if(bd < BLEND) return py + (h - py)*smoothstep(bd/BLEND);
  return h;
}

function normalAt(W, x, z){
  var e = 0.5;
  var gx = (groundAt(W, x + e, z) - groundAt(W, x - e, z))/(2*e);
  var gz = (groundAt(W, x, z + e) - groundAt(W, x, z - e))/(2*e);
  var l = Math.sqrt(gx*gx + 1 + gz*gz);
  return {x: -gx/l, y: 1/l, z: -gz/l};
}

function slopeAlong(W, x, z, yaw, len){
  len = len != null ? +len : 1.5;
  if(!(len > 0)) return 0;
  var sx = Math.sin(yaw || 0)*len, sz = Math.cos(yaw || 0)*len;
  return (groundAt(W, x + sx, z + sz) - groundAt(W, x - sx, z - sz))/(2*len);
}

function slopeFactor(grade, kind){
  var g = +grade || 0, up = Math.max(0, g), down = Math.max(0, -g);
  if(kind === "bike" || kind === "skate") return clamp(1 - up*2.5 + down*0.8, 0.35, 1.3);
  if(kind === "car" || kind === "moto") return clamp(1 - up*0.8, 0.7, 1.1);
  return clamp(1 - up*1.6 + down*0.3, 0.45, 1.15);
}

function buildingRect(lot){
  lot = lot || {};
  var R = rectM({x: lot.x || 0, z: lot.z || 0, w: lot.w || 0, d: lot.d || 0});
  return {x0: R.x0 + 1, x1: R.x1 - 1, z0: R.z0 + 1, z1: R.z1 - 1};
}

// the river's water outline in metres with its bounding box (built once per W, on the index), or null
function riverOf(W){
  var I = index(W);
  if(I.river !== undefined) return I.river;
  var R = W.river, P = [];
  (R && R.poly || []).forEach(function(p){ if(p && isFinite(p[0]) && isFinite(p[1])) P.push([p[0]/100, p[1]/100]); });
  var b = [Infinity, Infinity, -Infinity, -Infinity];
  P.forEach(function(q){ b[0] = Math.min(b[0], q[0]); b[1] = Math.min(b[1], q[1]); b[2] = Math.max(b[2], q[0]); b[3] = Math.max(b[3], q[1]); });
  return (I.river = P.length >= 3 ? {P: P, b: b} : null);
}
// is (x, z) on the river's water (inside river.poly)? false in a doc without a river
function riverAt(W, x, z){
  var R = riverOf(W);
  if(!R || x < R.b[0] || x > R.b[2] || z < R.b[1] || z > R.b[3]) return false;
  var P = R.P, inside = false;
  for(var i = 0, j = P.length - 1; i < P.length; j = i++){
    var a = P[i], c = P[j];
    if((a[1] > z) !== (c[1] > z) && x < (c[0] - a[0])*(z - a[1])/(c[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function trees(W){
  var I = index(W);
  if(I.treeList) return I.treeList;
  var D = W.districts, n = D.n, out = [], seed = W.hash + ":";
  for(var iz = 0; iz < n; iz++) for(var ix = 0; ix < n; ix++){
    var name = D.legend[D.k[iz*n + ix]], p = TREE_P[name];
    if(!p) continue;
    var h = hash32(seed + ix + ":" + iz);
    if((h & 0xffff)/65536 >= p) continue;
    var h2 = mix(h);
    var x = (D.origin + ix*D.cell)/100 + 1 + ((h >>> 16) & 0xff)/255*(D.cell/100 - 2);
    var z = (D.origin + iz*D.cell)/100 + 1 + (h2 & 0xff)/255*(D.cell/100 - 2);
    if(Math.abs(x) > W.half - CLEAR || Math.abs(z) > W.half - CLEAR) continue;
    if(roadNear(W, x, z, CLEAR) || lotAt(W, x, z) || siteAt(W, x, z)) continue;
    if(W.river && (riverAt(W, x, z) || riverAt(W, x + CLEAR, z) || riverAt(W, x - CLEAR, z) || riverAt(W, x, z + CLEAR) || riverAt(W, x, z - CLEAR))) continue;
    var pine = ((h2 >>> 16) & 3) === 0;
    out.push({x: x, z: z, s: 0.8 + ((h2 >>> 8) & 0xff)/255*0.6, kind: (name === "forest" ? !pine : pine) ? "pine" : "round"});
  }
  var nb = I.nb, T = lists(nb*nb), xz = new Float64Array(2*out.length);
  out.forEach(function(t, i){
    xz[2*i] = t.x; xz[2*i+1] = t.z;
    eachBucket(W, nb, t.x - TRUNK, t.x + TRUNK, t.z - TRUNK, t.z + TRUNK, function(b){ T[b].push(i); });
  });
  I.trees = T; I.treeXZ = xz; I.treeList = out;
  return out;
}

function blockedAt(W, x, z){
  var hm = W.half - 2;
  if(!(x >= -hm && x <= hm && z >= -hm && z <= hm)) return true;
  var I = index(W), nb = I.nb, b = bOf(W, z, nb)*nb + bOf(W, x, nb), L = I.bld[b], R = I.bldRect, i, k;
  for(i = 0; i < L.length; i++){
    k = 4*L[i];
    if(!(x >= R[k] && x <= R[k+1] && z >= R[k+2] && z <= R[k+3])) continue;
    var fp = I.bldBox[L[i]];
    if(!fp) return true;
    var dx = x - fp.o.x, dz = z - fp.o.z;
    if(Math.abs(dx*fp.F.z - dz*fp.F.x) <= fp.hu && Math.abs(dx*fp.F.x + dz*fp.F.z) <= fp.hv) return true;
  }
  if(!I.treeList) trees(W);
  var T = I.trees[b], xz = I.treeXZ;
  for(i = 0; i < T.length; i++){
    var dx = x - xz[2*T[i]], dz = z - xz[2*T[i]+1];
    if(dx*dx + dz*dz < TRUNK*TRUNK) return true;
  }
  return false;
}

function rayGround(W, from, to, step){
  step = step > 0 ? +step : 2;
  var dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  var n = Math.max(1, Math.ceil(Math.sqrt(dx*dx + dy*dy + dz*dz)/step));
  function under(t){ return from.y + dy*t < groundAt(W, from.x + dx*t, from.z + dz*t) + 0.25; }
  for(var i = 0; i <= n; i++){
    if(!under(i/n)) continue;
    if(i === 0) return 0;
    // bisect between the last clear sample and this one, so the hit is not quantised to `step`
    var lo = (i - 1)/n, hi = i/n;
    for(var k = 0; k < 6; k++){ var m = (lo + hi)/2; if(under(m)) hi = m; else lo = m; }
    return hi;
  }
  return 1;
}

function degrees(W){
  var deg = {};
  W.edges.forEach(function(e){
    (deg[e.a] = deg[e.a] || []).push(e);
    (deg[e.b] = deg[e.b] || []).push(e);
  });
  return deg;
}

function roadLabels(W){
  var groups = {}, order = [];
  W.edges.forEach(function(e){
    if(!groups[e.name]){ groups[e.name] = []; order.push(e.name); }
    groups[e.name].push(e);
  });
  var out = [];
  order.forEach(function(name){
    var es = groups[name], at = {}, used = {};
    es.forEach(function(e){ (at[e.a] = at[e.a] || []).push(e); (at[e.b] = at[e.b] || []).push(e); });
    function walk(node, e){
      var pts = [], cls = e.cls, ref = null, len = 0;
      while(e && !used[e.id]){
        used[e.id] = true;
        if(ref == null && e.ref != null) ref = e.ref;
        var p = e.pts, m = p.length/3, fwd = e.a === node;
        for(var j = 0; j < m; j++){
          var q = fwd ? j : m - 1 - j, x = p[3*q]/100, z = p[3*q+2]/100;
          if(pts.length){
            var last = pts[pts.length - 1];
            if(last[0] === x && last[1] === z) continue;
            len += Math.sqrt((x - last[0])*(x - last[0]) + (z - last[1])*(z - last[1]));
          }
          pts.push([x, z]);
        }
        node = fwd ? e.b : e.a;
        var nx = at[node].length === 2 ? at[node].filter(function(f){ return !used[f.id]; })[0] : null;
        e = nx || null;
      }
      out.push({name: name, cls: cls, ref: ref, pts: pts, len: len});
    }
    es.forEach(function(e){
      [e.a, e.b].forEach(function(nd){ if(!used[e.id] && at[nd].length !== 2) walk(nd, e); });
    });
    es.forEach(function(e){ if(!used[e.id]) walk(e.a, e); });   // loops
  });
  return out;
}

function junctions(W){
  var deg = degrees(W), out = [];
  W.nodes.forEach(function(n){
    var es = deg[n.id] || [];
    if(es.length < 3) return;
    var names = [];
    es.forEach(function(e){ if(names.indexOf(e.name) < 0) names.push(e.name); });
    out.push({node: n.id, x: n.x/100, y: n.y/100, z: n.z/100, deg: es.length,
              edges: es.map(function(e){ return e.id; }), names: names});
  });
  return out;
}

/* ---------- load (browser): IndexedDB copy by ETag, then the Arena via the dashboard ---------- */
// one per world id: the newest packed W, onChange listeners, the memoised load, the cache read time
var STATES = {};
function stateOf(id){ return STATES[id] || (STATES[id] = {cur: null, listeners: [], pending: null, cacheMs: null}); }
function now(){ return root.performance && root.performance.now ? root.performance.now() : Date.now(); }
function log(msg){ try { if(typeof console !== "undefined" && console.log) console.log(msg); } catch(e){} }
function defaultIdb(){
  var factory;
  try { factory = root.indexedDB; } catch(e){ return null; }
  if(!factory) return null;
  var dbp = null;
  function open(){
    if(!dbp) dbp = new Promise(function(res, rej){
      var r = factory.open(IDB.db, 1);
      r.onupgradeneeded = function(){ try { r.result.createObjectStore(IDB.store); } catch(e){} };
      r.onsuccess = function(){ res(r.result); };
      r.onerror = function(){ rej(r.error || new Error("idb")); };
      r.onblocked = function(){ rej(new Error("idb blocked")); };
    });
    return dbp;
  }
  function run(mode, fn){
    return open().then(function(db){
      return new Promise(function(res, rej){
        var tx = db.transaction(IDB.store, mode), r = fn(tx.objectStore(IDB.store));
        tx.oncomplete = function(){ res(r.result); };
        tx.onerror = tx.onabort = function(){ rej(tx.error || new Error("idb")); };
      });
    });
  }
  return {get: function(k){ return run("readonly", function(s){ return s.get(k); }); },
          put: function(k, v){ return run("readwrite", function(s){ return s.put(v, k); }); }};
}
function idbGet(idb, ms, id){
  if(!idb) return Promise.resolve(null);
  if(idb === PRE.idb && PRE.recs[id]) return PRE.recs[id];   // read already started at script load
  return new Promise(function(res){
    var done = false, t = setTimeout(function(){ done = true; res(null); }, ms);   // only guards a hung IDB
    try {
      Promise.resolve(idb.get(id)).then(function(v){ if(!done){ clearTimeout(t); res(v || null); } },
                                        function(){ if(!done){ clearTimeout(t); res(null); } });
    } catch(e){ clearTimeout(t); res(null); }
  });
}
// What the cache keeps: W as pack() made it. The client claims ground on a packed W after it is loaded
// (games/hqspectacle.js: a site marked `claimed`, a lot's kind with its own in `was`, W.spectacle), and the
// IndexedDB write clones later, asynchronously: so the record gets its own copies of the lots and sites now,
// and a cached W is cleaned of claims on the way out, else a claim made by older code would be read back and
// trusted forever.
function cacheCopy(W){
  var o = Object.assign({}, W, {index: null, docView: null});
  delete o.spectacle;
  o.lots = (W.lots || []).map(function(l){ var c = Object.assign({}, l); if(c.was != null){ c.kind = c.was; delete c.was; } return c; });
  o.sites = (W.sites || []).filter(function(s){ return s && !s.claimed; }).map(function(s){ return Object.assign({}, s); });
  return o;
}
// a cached W read back: cleaned of claims in place (it is the record's own object, handed out as is)
function unclaim(W){
  delete W.spectacle; W.index = null; W.docView = null;
  (W.lots || []).forEach(function(l){ if(l && l.was != null){ l.kind = l.was; delete l.was; } });
  if(W.sites) W.sites = W.sites.filter(function(s){ return s && !s.claimed; });
  return W;
}
function idbPut(idb, rec, id){
  if(!idb) return;
  try { Promise.resolve(idb.put(id, rec)).catch(function(){}); } catch(e){}
}
function deadline(p, ms, ctl){
  // settles with p, or rejects "world unavailable: timeout" (and aborts the request) once ms run out
  return new Promise(function(res, rej){
    var t = setTimeout(function(){ try { if(ctl) ctl.abort(); } catch(e){} rej(new Error("world unavailable: timeout")); }, Math.max(0, ms));
    Promise.resolve(p).then(function(v){ clearTimeout(t); res(v); }, function(e){ clearTimeout(t); rej(e); });
  });
}
function revalidate(f, idb, cached, timeoutMs, id){
  // the whole request, body read included, runs under one timeoutMs deadline
  var state = stateOf(id), url = id === ID ? URL : "/api/arena/world/" + id;
  var t0 = now(), ctl = null, opts = {cache: "no-cache", headers: cached && cached.etag ? {"If-None-Match": cached.etag} : {}}, p;
  try { if(root.AbortController){ ctl = new root.AbortController(); opts.signal = ctl.signal; } } catch(e){ ctl = null; }
  try { p = f(url, opts); } catch(e){ p = Promise.reject(e); }
  p = Promise.resolve(p).then(null, function(){ throw new Error("world unavailable: network"); });
  return deadline(p, timeoutMs, ctl).then(function(r){
    var status = r && r.status;
    if(status === 304 && cached){ log("hq-world 304"); return cached; }
    if(status !== 200) throw new Error("world unavailable: " + status);
    var body;
    try { body = Promise.resolve(r.json()).then(null, function(){ throw new Error("world unavailable: bad json"); }); }
    catch(e){ body = Promise.reject(new Error("world unavailable: bad json")); }
    return deadline(body, timeoutMs - (now() - t0), ctl).then(function(json){
      var W = api.pack(json);
      W.etag = (r.headers && r.headers.get && r.headers.get("ETag")) || null;
      idbPut(idb, {v: PACK_V, etag: W.etag, packed: cacheCopy(W)}, id);   // the index is rebuilt on use
      state.cur = W;
      if(cached && cached.hash !== W.hash) state.listeners.slice().forEach(function(cb){ try { cb(W); } catch(e){} });
      return W;
    });
  }).catch(function(err){
    if(cached) return cached;
    throw err instanceof Error ? err : new Error("world unavailable: " + err);
  });
}
function load(opts){
  opts = opts || {};
  var id = opts.id != null ? String(opts.id) : ID;
  if(!WORLD_RE.test(id)) return Promise.reject(new Error("world unavailable: bad id"));
  var state = stateOf(id);
  // memoised, but always hands out the newest world (a background 200 replaces state.cur)
  if(state.pending) return state.pending.then(function(W){ return state.cur || W; });
  var f = opts.fetch || (root.fetch ? root.fetch.bind(root) : null);
  var idb = opts.idb !== undefined ? opts.idb : (PRE.idb || defaultIdb());
  var timeoutMs = opts.timeoutMs > 0 ? opts.timeoutMs : 6000, t0 = now();
  // IndexedDB first, always: the network is only asked once the cache read has settled
  var p = idbGet(idb, timeoutMs, id).then(function(rec){
    if(!f) f = function(){ return Promise.reject(new Error("no fetch")); };
    if(rec && rec.v === PACK_V && rec.packed && rec.packed.terrain){   // other v: packed by older code, refetch
      var W = unclaim(rec.packed);
      W.etag = rec.etag || W.etag || null;
      state.cur = W;
      state.cacheMs = Math.round(now() - t0);
      log("hq-world cache " + state.cacheMs);
      revalidate(f, idb, W, timeoutMs, id);
      return W;
    }
    return revalidate(f, idb, null, timeoutMs, id);
  });
  state.pending = p;
  p.catch(function(){ if(state.pending === p) state.pending = null; });
  return p;
}
// on a page (not the build worker), start the IndexedDB read as soon as this script runs, so a late
// load() finds the record already in memory instead of racing the (HTTP-cached) world fetch
// (the Commons, the world the City opens on, and claude-hq@1, where an Arena without @2 sends it)
var PRE = {idb: null, recs: {}};
try {
  if(root.document && root.indexedDB){ PRE.idb = defaultIdb(); if(PRE.idb) [COMMONS, ID].forEach(function(id){ PRE.recs[id] = idbGet(PRE.idb, 6000, id); }); }
} catch(e){ PRE.idb = null; PRE.recs = {}; }
function onChange(cb, id){ if(typeof cb === "function") stateOf(id || ID).listeners.push(cb); }
function current(id){ return stateOf(id || ID).cur; }
function cacheMs(id){ return stateOf(id || ID).cacheMs; }

var api = HQV.world = {
  ID: ID, URL: URL, IDB: IDB, PACK_V: PACK_V, SIDEWALK_UP: SIDEWALK_UP, COMMONS: COMMONS, WORLD_RE: WORLD_RE,
  pack: pack, docOf: docOf, hash32: hash32, cacheCopy: cacheCopy,
  heightCm: heightCm, heightAt: heightAt, districtAt: districtAt, lotAt: lotAt, siteAt: siteAt,
  nearestRoad: nearestRoad, roadY: roadY, surfaceAt: surfaceAt, padOf: padOf, groundAt: groundAt,
  normalAt: normalAt, slopeAlong: slopeAlong, slopeFactor: slopeFactor, buildingRect: buildingRect,
  blockedAt: blockedAt, trees: trees, riverAt: riverAt, rayGround: rayGround, roadLabels: roadLabels, junctions: junctions,
  load: load, onChange: onChange, current: current, cacheMs: cacheMs
};
})();
