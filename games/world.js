/* Claude HQ: the generated worlds on the client: Arena City (claude-hq@1), the Commons
 * (claude-hq@2, live: claude-hq@3) and the personal islands (user:<id>@2, live: user:<id>@3).
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
 * Live ids (HQ 3.15, D2): the live worlds are @3 (LIVE_V); COMMONS is the live Commons, COMMONS_V2 its @2 fallback.
 *   islandId(uid, v?) "user:<uid>@3" (v 2 or 3) | null; isLive(id) any id the client may load (@1, @2, @3 forms);
 *   ownerOf(id) the island's uid | "commons" | null; versionOf(id) 1|2|3, 0 for anything else.
 * @3 docs add four layers (cm, integers; docs/plans/transport-revamp.md 5.1), packed as they come (W.water, W.metro,
 * W.rail, W.gondola: plain objects, so they ride the worker's structured clone untouched) with memoised metre views
 * (null when the doc has none, so @1/@2 behave exactly as before):
 *   waterOf(W)   {bodies: [{id, kind, poly: [x, z, ...] (m, flat), level, bed, y, edge, islands: [[x, z, ...]], joins,
 *                tier, box: {x0, z0, x1, z1}}], piers: [{id, body, kind, x, y, z, fx, fz, yaw, len, w, tier}], berths:
 *                [{body, x, z, yaw}], breakwater: [[x, z]] | null, lighthouse: [x, z] | null, office, net: {nodes: [[x, z]],
 *                edges}, routes}. `level` is body.level; `y` is the surface boats float on and the water is drawn at: level,
 *                raised to sea + RIVER_LIFT (0.3 m, the river's calm level) when it is lower, so the sea's crests never
 *                show through. A pier is a deck centred on (x, z), `len` m along its front (from 3 m inland to its head
 *                over the water: water.rs), `w` wide; the breakwater a
 *                polyline you walk along within BREAKWATER_HALF m, its crown walk BREAKWATER_UP m over the sea.
 *   deckAt(W, x, z)   the y of the pier deck or breakwater crown at (x, z) | null; groundAt is that deck there
 *   metroOf(W), railOf(W), gondolaOf(W): the layers in metres, every Q16 front/along also as a unit [fx, fz] and a
 *                yaw (yaw 0 faces +z, increasing yaw turns left: yaw = atan2(fx, fz))
 *   waterAt(W, x, z)  the body (from waterOf) whose water (x, z) is on: inside its outline, not on one of its
 *                islands, a pier or the breakwater (a bounding box first) | null
 *   holeAt(W, x, z)   inside a terrain hole (metro entrances and portals, the Island Link portal): every ring of
 *                metro.holes, the entrances' and portals' own holes and rail.holes; holesOf(W) lists them (m)
 *   holeFloor(W, x, z) the floor under a hole (m): an entrance's ticket-hall floor, a portal's track, else 6 m down
 * groundAt in a hole is its floor (no ground at street level, so the avatar can go down; groundAt(W, x, z, true) and
 * streetAt(W, x, z) give the street level over it); rayGround passes through a hole the same way. blockedAt is true on a
 * water body (not on a bridge's deck, a pier or the breakwater); surfaceAt says "water" there; no tree stands in a body or
 * a hole.
 * Pure core: no THREE, no DOM at load time, so node, a worker (importScripts) and the page all load it.
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : self;
var HQV = root.HQV = root.HQV || {};

var ID = "claude-hq@1", URL = "/api/arena/world/claude-hq@1", IDB = {db: "hq-world", store: "docs"};
// the live worlds are @3 (HQ 3.15, D2); @2 (and @1) stay served for older Arenas and clients
var LIVE_V = 3, COMMONS = "claude-hq@3", COMMONS_V2 = "claude-hq@2";
var UID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// the worlds the client may ask for: the fixed ones and a personal island (the dashboard checks again)
var WORLD_RE = /^(claude-hq@[123]|user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@[23])$/;
var PACK_V = 4;   // bump whenever pack()'s output changes; cached records with another v are refetched
                  // (4: v3 records could hold the 3D City's client-side claims, see cacheCopy)
var ONE = 65536, BUCKET = 64, TRUNK = 0.45, CLEAR = 2, BLEND = 4, SIDEWALK_UP = 0.15;
var TREE_P = {forest: 0.55, park: 0.18, residential: 0.04};
var WALK_OLD = {street: 150, avenue: 200};   // sidewalk (cm, each side) for docs older than the walk field
// @3 water: the calm surface over sea level (games/ocean.js RIVER_Y, games/worldgeom.js RIVER_LIFT), the breakwater's
// walkable half width, how far down a hole with nothing under it goes
var RIVER_LIFT = 0.3, BREAKWATER_HALF = 4, BREAKWATER_UP = 2.5, HOLE_DEPTH = 6;

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
  var nodes = (r.nodes || []).map(function(n){
    var o = {id: n.id, x: n.x|0, y: n.y|0, z: n.z|0};
    // City Gen v4 (HQ 3.26): the junction's control ("priority" | "mini" | "roundabout" | "signals") and a roundabout's
    // island radius (cm)
    if(n.junction != null) o.junction = String(n.junction);
    if(n.island > 0) o.island = n.island|0;
    return o;
  });
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
    // City Gen v4 (@3, HQ 3.25): the road's class (lanes then counts each way) and its median (cm), raised paving
    if(e.v4 != null) o.v4 = String(e.v4);
    if(e.median > 0) o.median = e.median|0;
    if(e.oneway === true) o.oneway = true;                  // [3.29] an interchange's ramp: traffic a -> b only
    return o;
  });
  var W = {
    id: doc.id || ID, etag: null, hash: String((doc.hashes && doc.hashes.world) || ""), sizeCm: sizeCm, half: sizeCm/2/100,
    terrain: {cell: t.cell_cm || 800, origin: t.origin_cm != null ? t.origin_cm : -sizeCm/2, n: t.n|0, h: Int32Array.from(t.heights || [])},
    districts: {cell: d.cell_cm || 800, origin: d.origin_cm != null ? d.origin_cm : -sizeCm/2, n: d.n|0,
                k: Uint8Array.from(d.kinds || []), legend: (d.legend || []).slice()},
    nodes: nodes, edges: edges,
    // [3.26] full roundabouts' islands (m): raised, planted ground in the road (roadUnder)
    rbs: nodes.filter(function(n){ return n.junction === "roundabout" && n.island > 0; }).map(function(n){ return {x: n.x/100, z: n.z/100, r: n.island/100}; }),
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
  // @3: the water, metro, rail and gondola layers, as they come (cm); metre views below
  if(L.water) W.water = L.water;
  if(L.metro) W.metro = L.metro;
  if(L.rail) W.rail = L.rail;
  if(L.gondola) W.gondola = L.gondola;
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
    if(e.v4 != null) o.v4 = e.v4;
    if(e.median) o.median = e.median;
    if(e.oneway) o.oneway = true;
    return o;
  });
  var D = W.districts, layers = {roads: {nodes: W.nodes, edges: edges},
    districts: {cell_cm: D.cell, origin_cm: D.origin, n: D.n, legend: D.legend},
    blocks: W.blocks, lots: W.lots, sites: W.sites};
  if(W.zones) layers.zones = W.zones;
  if(W.transit) layers.transit = W.transit;
  if(W.island) layers.island = W.island;
  if(W.river) layers.river = W.river;
  if(W.water) layers.water = W.water;
  if(W.metro) layers.metro = W.metro;
  if(W.rail) layers.rail = W.rail;
  if(W.gondola) layers.gondola = W.gondola;
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
    // every carriageway counts (a highway beside a sidewalk too); a median (v4) is raised paving, no carriageway
    var med = e.median ? e.median/200 : 0;
    gap = Math.min(gap, S.d < med ? med - S.d : S.d - (e.width - 2*e.walk)/200);
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
  for(i = 0; W.rbs && i < W.rbs.length; i++){ var rb = W.rbs[i]; if((x - rb.x)*(x - rb.x) + (z - rb.z)*(z - rb.z) < rb.r*rb.r){ gap = 1; break; } }
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
  if(W.water && waterAt(W, x, z)) return "water";
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

// street: true gives the street level over a terrain hole too (@3); without it a hole's ground is its floor (holeFloor)
function groundAt(W, x, z, street){
  if(!street && (W.metro || W.rail)){ var f = holeFloor(W, x, z); if(f != null) return f; }
  if(W.water){ var dk = deckAt(W, x, z); if(dk != null) return dk; }   // @3: a pier's deck, the breakwater's crown
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

function streetAt(W, x, z){ return groundAt(W, x, z, true); }

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

/* ---------- @3 layers: metre views, memoised per world (null when the doc has none) ---------- */
// one memo per world; a tier view (games/worldgeom.js view) shares its world's (tierBase): the layers are the same
var MEMO = typeof WeakMap === "function" ? new WeakMap() : null;
function memoOf(W){
  var B = W.tierBase || W, m;
  if(MEMO){ m = MEMO.get(B); if(!m){ m = {}; MEMO.set(B, m); } return m; }
  if(!B.layerViews){ try { Object.defineProperty(B, "layerViews", {value: {}, enumerable: false, configurable: true, writable: true}); } catch(e){ return {}; } }
  return B.layerViews;
}
function cm(v){ v = +v; return isFinite(v) ? v/100 : 0; }
// a Q16 unit vector [fx, fz] (doc) as a unit [x, z] (+z when there is none)
function q16(f){
  var x = f && isFinite(+f[0]) ? +f[0]/ONE : 0, z = f && isFinite(+f[1]) ? +f[1]/ONE : 1, l = Math.sqrt(x*x + z*z);
  return l > 1e-9 ? [x/l, z/l] : [0, 1];
}
function yawOf(u){ return Math.atan2(u[0], u[1]); }
function ringM(P){
  var out = [];
  (P || []).forEach(function(p){ if(p && isFinite(+p[0]) && isFinite(+p[1])) out.push([+p[0]/100, +p[1]/100]); });
  return out;
}
function flatM(P){ var o = []; ringM(P).forEach(function(q){ o.push(q[0], q[1]); }); return o; }
function pathM(P){ return (P || []).filter(function(p){ return p && p.length >= 3; }).map(function(p){ return [cm(p[0]), cm(p[1]), cm(p[2])]; }); }
function strs(L){ return (L || []).map(String); }
function boxFlat(f){
  var b = {x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity};
  for(var i = 0; i + 1 < f.length; i += 2){ b.x0 = Math.min(b.x0, f[i]); b.x1 = Math.max(b.x1, f[i]); b.z0 = Math.min(b.z0, f[i+1]); b.z1 = Math.max(b.z1, f[i+1]); }
  return b;
}
function inBox(b, x, z){ return x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1; }
// even-odd point in a flat ring [x0, z0, x1, z1, ...]
function inFlat(f, x, z){
  var inside = false, n = f.length >> 1;
  for(var i = 0, j = n - 1; i < n; j = i++){
    var ax = f[2*i], az = f[2*i+1], cx = f[2*j], cz = f[2*j+1];
    if((az > z) !== (cz > z) && x < (cx - ax)*(z - az)/(cz - az) + ax) inside = !inside;
  }
  return inside;
}
function seaLevel(W){ var B = W.tierBase || W, I = B && B.island; return I && I.sea_cm != null && isFinite(+I.sea_cm) ? +I.sea_cm/100 : null; }
function waterOf(W){
  if(!W || !W.water) return null;
  var M = memoOf(W);
  if(M.water !== undefined) return M.water;
  var L = W.water, sea = seaLevel(W);
  var bodies = [];
  (L.bodies || []).forEach(function(b){
    if(!b) return;
    var poly = flatM(b.poly);
    if(poly.length < 6) return;
    var level = cm(b.level), y = sea != null && level < sea + RIVER_LIFT ? sea + RIVER_LIFT : level;
    bodies.push({id: String(b.id), kind: String(b.kind || "lake"), poly: poly, level: level, bed: cm(b.bed), y: y,
                 edge: b.edge === "quay" ? "quay" : "bank", islands: (b.islands || []).map(flatM).filter(function(f){ return f.length >= 6; }),
                 joins: b.joins != null ? String(b.joins) : null, tier: (b.tier|0) || 1, box: boxFlat(poly)});
  });
  var piers = (L.piers || []).filter(Boolean).map(function(p){
    var u = q16(p.front);
    return {id: String(p.id), body: String(p.body || ""), kind: String(p.kind || "waterbus"), x: cm(p.x), y: cm(p.y), z: cm(p.z),
            fx: u[0], fz: u[1], yaw: yawOf(u), len: Math.max(0, cm(p.len)), w: Math.max(0, cm(p.w)), tier: (p.tier|0) || 1};
  });
  var berths = (L.berths || []).filter(Boolean).map(function(b){
    var u = q16(b.front);
    return {body: String(b.body || ""), x: cm(b.x), z: cm(b.z), fx: u[0], fz: u[1], yaw: yawOf(u)};
  });
  var bw = ringM(L.breakwater), lh = L.lighthouse && L.lighthouse.length >= 2 ? [cm(L.lighthouse[0]), cm(L.lighthouse[1])] : null;
  var net = L.net || {};
  M.water = {bodies: bodies, piers: piers, berths: berths, breakwater: bw.length >= 2 ? bw : null, lighthouse: lh,
             office: L.office != null ? L.office : null,
             net: {nodes: ringM(net.nodes), edges: (net.edges || []).filter(function(e){ return e && e.length >= 2; }).map(function(e){ return [e[0]|0, e[1]|0]; })},
             routes: (L.routes || []).filter(Boolean).map(function(r){
               return {id: String(r.id), kind: String(r.kind || "waterbus"), piers: strs(r.piers), path: (r.path || []).map(function(i){ return i|0; }),
                       loop: !!r.loop, tier: (r.tier|0) || 1};
             })};
  return M.water;
}

// the deck you stand on at (x, z): a pier's (its y) or the breakwater's crown walk (BREAKWATER_UP over the sea) | null
function deckAt(W, x, z){
  var V = W && W.water ? waterOf(W) : null;
  if(!V) return null;
  var P = V.piers, i;
  for(i = 0; i < P.length; i++){
    var p = P[i], dx = x - p.x, dz = z - p.z, a = dx*p.fx + dz*p.fz, c = dx*p.fz - dz*p.fx;
    if(Math.abs(a) <= p.len/2 && Math.abs(c) <= p.w/2) return p.y;
  }
  var B = V.breakwater;
  if(B) for(i = 0; i + 1 < B.length; i++){
    var ax = B[i][0], az = B[i][1], ux = B[i+1][0] - ax, uz = B[i+1][1] - az, L2 = ux*ux + uz*uz;
    var t = L2 > 0 ? clamp(((x - ax)*ux + (z - az)*uz)/L2, 0, 1) : 0, qx = x - ax - ux*t, qz = z - az - uz*t;
    if(qx*qx + qz*qz <= BREAKWATER_HALF*BREAKWATER_HALF){ var sl = seaLevel(W); return (sl != null ? sl : 0) + BREAKWATER_UP; }
  }
  return null;
}
// the body whose outline holds (x, z), off its islands (decks not considered) | null
function bodyAt(W, x, z){
  var V = waterOf(W);
  if(!V) return null;
  for(var i = 0; i < V.bodies.length; i++){
    var b = V.bodies[i];
    if(!inBox(b.box, x, z) || !inFlat(b.poly, x, z)) continue;
    for(var k = 0; k < b.islands.length; k++) if(inFlat(b.islands[k], x, z)) return null;
    return b;
  }
  return null;
}
function waterAt(W, x, z){
  var b = bodyAt(W, x, z);
  return b && deckAt(W, x, z) == null ? b : null;
}
function metroOf(W){
  if(!W || !W.metro) return null;
  var M = memoOf(W);
  if(M.metro !== undefined) return M.metro;
  var L = W.metro;
  M.metro = {
    lines: (L.lines || []).filter(Boolean).map(function(l){
      return {id: String(l.id), stations: strs(l.stations), path: pathM(l.path), kinds: strs(l.kinds), depot: l.depot != null ? String(l.depot) : null, tier: (l.tier|0) || 1};
    }),
    stations: (L.stations || []).filter(Boolean).map(function(s){
      var u = q16(s.along);
      return {id: String(s.id), x: cm(s.x), y: cm(s.y), z: cm(s.z), along: u, yaw: yawOf(u), len: cm(s.len), platform: s.platform === "island" ? "island" : "side",
              lines: strs(s.lines), hall_y: cm(s.hall_y), entrances: strs(s.entrances)};
    }),
    entrances: (L.entrances || []).filter(Boolean).map(function(e){
      var u = q16(e.front);
      return {id: String(e.id), station: String(e.station || ""), x: cm(e.x), y: cm(e.y), z: cm(e.z), front: u, yaw: yawOf(u), w: cm(e.w), d: cm(e.d),
              kind: String(e.kind || "stairs"), hole: ringM(e.hole)};
    }),
    portals: (L.portals || []).filter(Boolean).map(function(p){
      var u = q16(p.front);
      return {id: String(p.id), line: String(p.line || ""), x: cm(p.x), y: cm(p.y), z: cm(p.z), front: u, yaw: yawOf(u), w: cm(p.w), len: cm(p.len), hole: ringM(p.hole)};
    }),
    depots: (L.depots || []).filter(Boolean).map(function(d){
      return {id: String(d.id), line: String(d.line || ""), poly: ringM(d.poly), tracks: (d.tracks || []).map(pathM)};
    }),
    holes: (L.holes || []).map(ringM).filter(function(P){ return P.length >= 3; })
  };
  return M.metro;
}
function railOf(W){
  if(!W || !W.rail) return null;
  var M = memoOf(W);
  if(M.rail !== undefined) return M.rail;
  var L = W.rail, sea = L.sea, su = sea ? q16(sea.front) : null;
  M.rail = {
    lines: (L.lines || []).filter(Boolean).map(function(l){
      return {id: String(l.id), kind: l.kind === "island" ? "island" : "city", stations: strs(l.stations), path: pathM(l.path), kinds: strs(l.kinds), tier: (l.tier|0) || 1};
    }),
    stations: (L.stations || []).filter(Boolean).map(function(s){
      var u = q16(s.along);
      return {id: String(s.id), kind: String(s.kind || "elevated"), x: cm(s.x), y: cm(s.y), z: cm(s.z), along: u, yaw: yawOf(u), len: cm(s.len),
              platforms: Math.max(1, s.platforms|0), lines: strs(s.lines), stairs: ringM(s.stairs)};
    }),
    sea: sea ? {x: cm(sea.x), y: cm(sea.y), z: cm(sea.z), front: su, yaw: yawOf(su)} : null,
    holes: (L.holes || []).map(ringM).filter(function(P){ return P.length >= 3; })
  };
  return M.rail;
}
function gondolaOf(W){
  if(!W || !W.gondola) return null;
  var M = memoOf(W);
  if(M.gondola !== undefined) return M.gondola;
  M.gondola = {lines: (W.gondola.lines || []).filter(Boolean).map(function(l){
    return {id: String(l.id), kind: l.kind === "summit" ? "summit" : "crossing", tier: (l.tier|0) || 1,
            stations: (l.stations || []).filter(Boolean).map(function(s){
              var u = q16(s.front);
              return {id: String(s.id), x: cm(s.x), y: cm(s.y), z: cm(s.z), front: u, yaw: yawOf(u)};
            }),
            towers: (l.towers || []).filter(Boolean).map(function(t){ return {x: cm(t.x), y: cm(t.y), z: cm(t.z), h: cm(t.h)}; })};
  })};
  return M.gondola;
}
// every terrain hole once, {P: [[x, z], ...] (m), b (box), kind: "entrance"|"portal"|"hole"|"rail", ref}, in a 32 m grid
var HOLE_CELL = 32;
function holeIndex(W){
  if(!W || !(W.metro || W.rail)) return null;
  var M = memoOf(W);
  if(M.holes !== undefined) return M.holes;
  var list = [], seen = {}, grid = {}, mo = metroOf(W), ro = railOf(W);
  function add(P, kind, ref){
    if(!P || P.length < 3) return;
    var key = P.map(function(q){ return Math.round(q[0]*100) + "," + Math.round(q[1]*100); }).join(";");
    if(seen[key]) return;
    seen[key] = 1;
    var f = [];
    P.forEach(function(q){ f.push(q[0], q[1]); });
    var h = {P: P, f: f, b: boxFlat(f), kind: kind, ref: ref || null};
    list.push(h);
    for(var j = Math.floor(h.b.z0/HOLE_CELL); j <= Math.floor(h.b.z1/HOLE_CELL); j++)
      for(var i = Math.floor(h.b.x0/HOLE_CELL); i <= Math.floor(h.b.x1/HOLE_CELL); i++) (grid[i + "," + j] = grid[i + "," + j] || []).push(h);
  }
  if(mo){
    mo.entrances.forEach(function(e){ add(e.hole, "entrance", e); });
    mo.portals.forEach(function(p){ add(p.hole, "portal", p); });
    mo.holes.forEach(function(P){ add(P, "hole", null); });
  }
  if(ro) ro.holes.forEach(function(P){ add(P, "rail", null); });
  M.holes = list.length ? {list: list, grid: grid} : null;
  return M.holes;
}
function holeRec(W, x, z){
  var H = holeIndex(W);
  if(!H) return null;
  var L = H.grid[Math.floor(x/HOLE_CELL) + "," + Math.floor(z/HOLE_CELL)];
  if(L) for(var i = 0; i < L.length; i++) if(inBox(L[i].b, x, z) && inFlat(L[i].f, x, z)) return L[i];
  return null;
}
function holeAt(W, x, z){ return !!holeRec(W, x, z); }
function holesOf(W){ var H = holeIndex(W); return H ? H.list.map(function(h){ return h.P; }) : []; }
// the y of the nearest point (in plan) of a set of [x, y, z] paths (m), or null
function nearestPathY(paths, x, z){
  var bd = Infinity, by = null;
  paths.forEach(function(P){
    for(var i = 0; i + 1 < P.length; i++){
      var a = P[i], b = P[i+1], ux = b[0] - a[0], uz = b[2] - a[2], L2 = ux*ux + uz*uz;
      var t = L2 > 0 ? clamp(((x - a[0])*ux + (z - a[2])*uz)/L2, 0, 1) : 0, qx = x - a[0] - ux*t, qz = z - a[2] - uz*t, d = qx*qx + qz*qz;
      if(d < bd){ bd = d; by = a[1] + (b[1] - a[1])*t; }
    }
  });
  return by;
}
// the floor under a hole at (x, z) (m), or null off every hole
function holeFloor(W, x, z){
  var h = holeRec(W, x, z);
  if(!h) return null;
  var street = groundAt(W, x, z, true), y = null, mo = metroOf(W), ro = railOf(W);
  if(h.kind === "entrance" && mo){
    var st = mo.stations.filter(function(s){ return s.id === h.ref.station; })[0];
    if(st && st.hall_y < street - 1) y = st.hall_y;
  } else if(h.kind === "portal" && mo){
    y = nearestPathY(mo.lines.filter(function(l){ return l.id === h.ref.line; }).map(function(l){ return l.path; }), x, z);
  } else if(h.kind === "rail" && ro){
    y = nearestPathY(ro.lines.map(function(l){ return l.path; }), x, z);
  }
  return y != null && isFinite(y) && y < street - 0.5 ? y : street - HOLE_DEPTH;
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
    // @3: none in a lake, canal or the marina, on a pier, or in a terrain hole
    if(W.water && (bodyAt(W, x, z) || bodyAt(W, x + CLEAR, z) || bodyAt(W, x - CLEAR, z) || bodyAt(W, x, z + CLEAR) || bodyAt(W, x, z - CLEAR) || deckAt(W, x, z) != null)) continue;
    if((W.metro || W.rail) && (holeRec(W, x, z) || holeRec(W, x + CLEAR, z) || holeRec(W, x - CLEAR, z) || holeRec(W, x, z + CLEAR) || holeRec(W, x, z - CLEAR))) continue;
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
  // @3: a lake, canal or the marina is water (a bridge's deck, a pier and the breakwater are not)
  if(W.water && waterAt(W, x, z) && !roadUnder(W, x, z)) return true;
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
  var p;
  try { p = idb.get(id); } catch(e){ return Promise.resolve(null); }
  return deadline(p, {left: ms}, null).then(function(v){ return v || null; }, function(){ return null; });   // only guards a hung IDB
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
// The deadlines count the page's own time, not the wall clock: B.left (ms) is spent in TICK steps and a step costs at
// most what it asked for, so one that comes back late because the main thread was busy (three.js loading, a first frame
// compiling its shaders under software GL, a slow machine's startup) costs only its TICK. A world's bytes are in within
// milliseconds and our own startup work only delays their turn on the main thread: it must not time them out (the City
// would fall back to an older world and cache nothing). A hung Arena or IndexedDB still runs out after B.left ms of a
// responsive page.
var TICK = 250;
function deadline(p, B, ctl){
  // settles with p, or rejects "world unavailable: timeout" (and aborts the request) once B.left runs out
  return new Promise(function(res, rej){
    var t = null, at = 0, d = 0;
    function spent(){ B.left -= Math.min(d, Math.max(0, now() - at)); d = 0; }   // the step under way, at most its TICK
    (function step(){
      d = Math.min(Math.max(0, B.left), TICK); at = now();
      t = setTimeout(function(){
        B.left -= d; d = 0;
        if(B.left > 0){ step(); return; }
        try { if(ctl) ctl.abort(); } catch(e){}
        rej(new Error("world unavailable: timeout"));
      }, d);
    })();
    Promise.resolve(p).then(function(v){ clearTimeout(t); spent(); res(v); }, function(e){ clearTimeout(t); spent(); rej(e); });
  });
}
function revalidate(f, idb, cached, timeoutMs, id){
  // the whole request, body read included, spends one timeoutMs budget (deadline)
  var state = stateOf(id), url = id === ID ? URL : "/api/arena/world/" + id;
  var B = {left: timeoutMs}, ctl = null, opts = {cache: "no-cache", headers: cached && cached.etag ? {"If-None-Match": cached.etag} : {}}, p;
  try { if(root.AbortController){ ctl = new root.AbortController(); opts.signal = ctl.signal; } } catch(e){ ctl = null; }
  try { p = f(url, opts); } catch(e){ p = Promise.reject(e); }
  p = Promise.resolve(p).then(null, function(){ throw new Error("world unavailable: network"); });
  return deadline(p, B, ctl).then(function(r){
    var status = r && r.status;
    if(status === 304 && cached){ log("hq-world 304"); return cached; }
    if(status !== 200) throw new Error("world unavailable: " + status);
    var body;
    try { body = Promise.resolve(r.json()).then(null, function(){ throw new Error("world unavailable: bad json"); }); }
    catch(e){ body = Promise.reject(new Error("world unavailable: bad json")); }
    return deadline(body, B, ctl).then(function(json){
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
// (the live Commons, the world the City opens on, its @2 and claude-hq@1, where an older Arena sends it)
var PRE = {idb: null, recs: {}};
try {
  if(root.document && root.indexedDB){ PRE.idb = defaultIdb(); if(PRE.idb) [COMMONS, COMMONS_V2, ID].forEach(function(id){ PRE.recs[id] = idbGet(PRE.idb, 6000, id); }); }
} catch(e){ PRE.idb = null; PRE.recs = {}; }
/* ---------- live ids (HQ 3.15, D2) ---------- */
// an island's live id (v: 2 or 3, default LIVE_V) for a uid (a lowercase uuid; a "user:" prefix or "@n" suffix is
// dropped), or null
function islandId(uid, v){
  var u = String(uid == null ? "" : uid).toLowerCase().replace(/^user:/, "").replace(/@[0-9]+$/, "");
  v = v == null ? LIVE_V : +v;
  return UID_RE.test(u) && (v === 2 || v === 3) ? "user:" + u + "@" + v : null;
}
function isLive(id){ return typeof id === "string" && WORLD_RE.test(id); }
function ownerOf(id){
  if(!isLive(id)) return null;
  return id.indexOf("claude-hq@") === 0 ? "commons" : id.slice(5, id.lastIndexOf("@"));
}
function versionOf(id){ return isLive(id) ? +id.slice(id.lastIndexOf("@") + 1) : 0; }

function onChange(cb, id){ if(typeof cb === "function") stateOf(id || ID).listeners.push(cb); }
function current(id){ return stateOf(id || ID).cur; }
function cacheMs(id){ return stateOf(id || ID).cacheMs; }

var api = HQV.world = {
  ID: ID, URL: URL, IDB: IDB, PACK_V: PACK_V, SIDEWALK_UP: SIDEWALK_UP, COMMONS: COMMONS, WORLD_RE: WORLD_RE,
  LIVE_V: LIVE_V, COMMONS_V2: COMMONS_V2, islandId: islandId, isLive: isLive, ownerOf: ownerOf, versionOf: versionOf,
  waterOf: waterOf, metroOf: metroOf, railOf: railOf, gondolaOf: gondolaOf, waterAt: waterAt, holeAt: holeAt, holesOf: holesOf,
  holeFloor: holeFloor, streetAt: streetAt, deckAt: deckAt, RIVER_LIFT: RIVER_LIFT, BREAKWATER_HALF: BREAKWATER_HALF, BREAKWATER_UP: BREAKWATER_UP,
  pack: pack, docOf: docOf, hash32: hash32, cacheCopy: cacheCopy,
  heightCm: heightCm, heightAt: heightAt, districtAt: districtAt, lotAt: lotAt, siteAt: siteAt,
  nearestRoad: nearestRoad, roadY: roadY, surfaceAt: surfaceAt, padOf: padOf, groundAt: groundAt,
  normalAt: normalAt, slopeAlong: slopeAlong, slopeFactor: slopeFactor, buildingRect: buildingRect,
  blockedAt: blockedAt, trees: trees, riverAt: riverAt, rayGround: rayGround, roadLabels: roadLabels, junctions: junctions,
  load: load, onChange: onChange, current: current, cacheMs: cacheMs
};
})();
