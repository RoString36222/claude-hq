/* Claude HQ: the City's residents (Cities spec, task cl-npc), a pure simulation.
 *
 * HQV.npcSim.create(doc, {tier, grow, seed}) -> sim. Everything a resident does is a pure function of
 * (world doc, tier, grow, seed, local clock ms): two clients with the same inputs see the same people in
 * the same places, with no server traffic and no day replay.
 *   residents   population by tier (POP: 50/200/600/1200/2000 at grow 0, rising to the next tier's number
 *               as grow, per-mille through the tier as CityState.grow, nears 1000). Resident i is
 *               hash(seed, i): a home lot, a look (Kenney character index 0..5 + outfit tints), a walking
 *               speed; a job (a civic site, a shop or a zone building, with its role from the job table)
 *               handed out so every job place gets workers before any gets a second round; and a mode by
 *               distance: walk under WALK_MAX, else the bus when a stop is near both ends, else a car.
 *   schedule    plan(day) per resident (hash(seed, i, day) jitter): commute to arrive 5-60 min before the
 *               shift (07:00-09:00 for 9-17 jobs), lunch at 12:00 at the nearest food place, home after the
 *               shift (17:00-19:00), some via the market or a park; nights home; police, fire and nurses
 *               on rotating shifts, overnight ones crossing midnight. Zone jobs follow their job table
 *               (office 9-17, tech in flexible waves, studio crew and cast on set). Without a job: an
 *               outing to a park or the market.
 *   at(t, c, r) visible residents near c ({x, z} m) within r m at local ms t, nearest first:
 *               {id, x, y, z, yaw, anim: "walk"|"idle"|"drive", mode: "walk"|"car"|"bus", speed}.
 *               Inside a building or on the bus means not visible. A trip's route is planned once (A* on
 *               the road graph, cached per place pair and mode) and walked along its sidewalk (drivers on
 *               their lane). Plans never depend on routes (no A* for the whole town up front); a walk
 *               then takes its route at the walker's own pace (rides take their planned time), and the
 *               route is a pure function of the doc, so a position is a pure function of (resident, time).
 *   where(id, t), speak(id, t), warm(ms), localMs(date): see below.
 * Sidewalks: the walk runs SIDE_IN in from the road's outer line (half the sidewalk when the edge has one)
 * on the left of the direction of travel (as hqcity3d's traffic), crossing straight over at junctions.
 * Clock: local wall-clock ms (localMs(new Date()), the same clock the City's day and night use).
 * Layers.zones (optional, from the generator) overrides the built-in JOBS per kind:
 *   {jobs: {<kind>: [[job, from, to, n], ...]}}, {<kind>: [...]} or [{kind, jobs: [...]}]; entries may
 *   also be {job, from, to, n}. Hours are local, fractional allowed; to < from is an overnight shift.
 * Frames: metres, +y up, yaw 0 faces +z, facing (sin yaw, cos yaw); the left of (dx, dz) is (dz, -dx).
 * Pure core: no THREE, no DOM, so node and the page both load it.
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : self;
var HQV = root.HQV = root.HQV || {};

var MIN = 60000, HOUR = 3600000, DAY = 86400000;
var POP = [50, 200, 600, 1200, 2000];
var CHARS = 6;                      // the six Kenney Mini Characters (hq3d.js CHAR_FILES)
var WALK_V = [1.15, 1.55];          // walking speed range (m/s)
var CAR_V = 9, BUS_V = 7;           // planning speeds (m/s)
var DETOUR = {walk: 1.3, car: 1.4, bus: 1.5};   // road distance per straight-line metre, for planning
var WALK_MAX = 900;                 // straight-line commute (m) walked; longer ones ride
var STOP_MAX = 450;                 // a bus stop further than this from home or work: drive instead
var LUNCH_MAX = 700, VIA_MAX = 800; // food within this of work for lunch; a market or park on the way home
var EMPLOYED = 0.88;                // share of residents with a job
var BUS_EVERY = 8*MIN;              // a bus at every stop this often
var SIDEWALK_UP = 0.15, ROAD_UP = 0.04;
var SIDE_IN = 1.5;                  // the walk line's distance in from the road's outer line, no sidewalk (m)
var CAR_FAST = {arterial: 1.25, avenue: 1.25, highway: 1.6, ring: 1.4}, FAST_MAX = 1.6;
var GRID = 32;                      // edge-segment index cell (m)
var STRETCH = 2.5;                  // a walk's real length may differ from its plan by this factor at most

/* ---------- job tables: [job, from h, to h, weight] ---------- */
var JOBS = {
  townhall: [["clerk", 9, 17, 6], ["mayor's aide", 8, 18, 1]],
  clinic: [["doctor", 8, 18, 2], ["nurse", 7, 15, 2], ["nurse", 15, 23, 1]],
  hospital: [["doctor", 7, 19, 4], ["doctor", 19, 7, 2], ["nurse", 7, 15, 4], ["nurse", 15, 23, 3], ["nurse", 23, 7, 3]],
  fire: [["firefighter", 7, 19, 4], ["firefighter", 19, 7, 4]],
  police: [["officer", 6, 14, 3], ["officer", 14, 22, 3], ["officer", 22, 6, 2]],
  school: [["teacher", 8, 16, 6], ["caretaker", 7, 15, 1]],
  university: [["lecturer", 9, 17, 5], ["researcher", 10, 19, 4]],
  market: [["vendor", 6, 14, 4], ["vendor", 11, 19, 3]],
  mall: [["shop assistant", 10, 18, 5], ["shop assistant", 13, 21, 4]],
  bank: [["teller", 9, 17, 4], ["banker", 8.5, 17.5, 2]],
  library: [["librarian", 9, 18, 3]],
  post: [["postal worker", 6, 14, 3]],
  transit: [["dispatcher", 6, 14, 2], ["dispatcher", 14, 22, 2], ["driver", 5, 13, 2], ["driver", 13, 21, 2]],
  port: [["dockhand", 6, 14, 4], ["dockhand", 14, 22, 3]],
  dock: [["ferry hand", 7, 15, 2]],
  airport: [["ground crew", 5, 13, 4], ["ground crew", 13, 21, 4]],
  power: [["engineer", 7, 15, 2], ["engineer", 15, 23, 2], ["engineer", 23, 7, 1]],
  water: [["technician", 7, 15, 2], ["technician", 15, 23, 1]],
  stadium: [["groundskeeper", 7, 15, 2], ["steward", 14, 22, 3]],
  // zone buildings
  office: [["analyst", 9, 17, 8], ["manager", 9, 17, 2]],
  campus: [["engineer", 8, 16, 3], ["engineer", 10, 18, 4], ["engineer", 12, 20, 3], ["designer", 10, 18, 2]],
  studio: [["crew", 6, 18, 4], ["cast", 9, 17, 2]],
  finance: [["trader", 7, 16, 4], ["analyst", 8, 17, 3]],
  biotech: [["scientist", 8, 17, 4], ["lab tech", 7, 15, 2]],
  media: [["editor", 10, 19, 3], ["reporter", 9, 18, 3]],
  warehouse: [["loader", 6, 14, 4], ["loader", 14, 22, 3]],
  farm: [["farmer", 5, 13, 3], ["farmhand", 6, 14, 2]],
  // ordinary lots
  shop: [["shopkeeper", 9, 18, 2]],
  civic: [["clerk", 9, 17, 2]]
};
// zone district (legend name) -> the job table its building lots use
var ZONE_LOT = {office: "office", tech: "campus", studio: "studio", finance: "finance", biotech: "biotech",
                media: "media", logistics: "warehouse", farm: "farm", industrial: "warehouse",
                commercial: "shop", downtown: "shop", oldtown: "shop", civic: "civic"};
var HOME_D = {residential: 1, suburb: 1, oldtown: 1, downtown: 1};
var FOOD_SITE = {market: 1, mall: 1};
var FOOD_D = {commercial: 1, downtown: 1, oldtown: 1};
var PARK_SITE = {fountain: 1, skatepark: 1, bikepark: 1, park: 1, funpark: 1};   // funpark: games/hqspectacle.js
var STOP_SITE = {busstop: 1};
var SHIRTS = [0x3d6fd1, 0xe0559b, 0x6fd38a, 0xffb347, 0x9b8cf0, 0xf4f4f4, 0xff6b5b, 0x5fd3e6, 0x2f3b4c, 0xc2a36b, 0x8a3d3d, 0x4c8c6c];
var PANTS = [0x2a3442, 0x3b4f7a, 0x5a4a3a, 0x1f1f24, 0x6b6f76, 0x7a5c3c, 0x2f4a3a, 0x8a8f99];
var SKIN = [0xf1d0b5, 0xe0b48f, 0xc68c62, 0xa86b45, 0x7d4b2c, 0x5a3520];

/* ---------- hashing (FNV-1a 32 as HQV.world.hash32, murmur3 mix) ---------- */
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
function rng(seed){ var a = seed >>> 0 || 1; return function(){ a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0)/4294967296; }; }
function clamp(v, a, b){ return v < a ? a : (v > b ? b : v); }

// Population for a tier (1..5) and grow (per-mille through the tier, 0..1000).
function population(tier, grow){
  var t = clamp(tier | 0 || 1, 1, 5), g = clamp(+grow || 0, 0, 1000)/1000;
  var a = POP[t - 1], b = POP[Math.min(t, 4)];
  return Math.round(a + (b - a)*g);
}
// The local wall clock (ms) of a Date: what at() and where() take.
function localMs(d){ d = d || new Date(); return d.getTime() - d.getTimezoneOffset()*MIN; }
// "9:00", "21:30" from fractional hours
function hhmm(h){ h = ((h % 24) + 24) % 24; var m = Math.round(h*60); return Math.floor(m/60) % 24 + ":" + (m % 60 < 10 ? "0" : "") + (m % 60); }

// Layers.zones -> {kind: [[job, from, to, n]]} (see the header for the accepted shapes)
function zoneJobs(z){
  var out = {};
  function entry(e){
    if(Array.isArray(e)) return e.length >= 3 ? [String(e[0]), +e[1] || 0, +e[2] || 0, e[3] != null ? Math.max(0, +e[3] || 0) : 1] : null;
    if(e && typeof e === "object" && e.job != null){
      var f = e.from != null ? e.from : e.start, t = e.to != null ? e.to : e.end, n = e.n != null ? e.n : e.share;
      return [String(e.job), +f || 0, +t || 0, n != null ? Math.max(0, +n || 0) : 1];
    }
    return null;
  }
  function put(kind, list){
    if(!kind || !Array.isArray(list)) return;
    var rows = list.map(entry).filter(function(r){ return r && r[3] > 0; });
    if(rows.length) out[String(kind)] = rows;
  }
  if(Array.isArray(z)) z.forEach(function(k){ if(k) put(k.kind, k.jobs); });
  else if(z && typeof z === "object"){
    var src = z.jobs && typeof z.jobs === "object" && !Array.isArray(z.jobs) ? z.jobs : z;
    Object.keys(src).forEach(function(k){ put(k, src[k]); });
  }
  return out;
}

/* ---------- geometry ---------- */
function inPoly(poly, x, z){   // poly [[x, z], ...] (any units, same as x, z)
  var c = false;
  for(var i = 0, j = poly.length - 1; i < poly.length; j = i++){
    var a = poly[i], b = poly[j];
    if((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0])*(z - a[1])/(b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}

/* ---------- a binary min-heap on (key, value) typed arrays ---------- */
function Heap(n){ this.k = new Float64Array(n + 1); this.v = new Int32Array(n + 1); this.n = 0; }
Heap.prototype.push = function(key, val){
  if(this.n + 1 >= this.k.length){
    var k = new Float64Array(this.k.length*2), v = new Int32Array(this.k.length*2);
    k.set(this.k); v.set(this.v); this.k = k; this.v = v;
  }
  var i = ++this.n, K = this.k, V = this.v;
  while(i > 1){ var p = i >> 1; if(K[p] <= key) break; K[i] = K[p]; V[i] = V[p]; i = p; }
  K[i] = key; V[i] = val;
};
Heap.prototype.pop = function(){   // -> the value; its key in this.top
  var K = this.k, V = this.v, out = V[1]; this.top = K[1];
  var key = K[this.n], val = V[this.n], n = --this.n, i = 1;
  while(true){
    var c = i*2; if(c > n) break;
    if(c + 1 <= n && K[c + 1] < K[c]) c++;
    if(K[c] >= key) break;
    K[i] = K[c]; V[i] = V[c]; i = c;
  }
  K[i] = key; V[i] = val;
  return out;
};

/* ---------- the sim ---------- */
function create(doc, opts){
  doc = doc || {}; opts = opts || {};
  var L = doc.layers || {}, R = L.roads || {};
  var tier = clamp(opts.tier | 0 || 1, 1, 5), grow = clamp(+opts.grow || 0, 0, 1000);
  var seed = String(opts.seed != null ? opts.seed : (doc.seed || doc.id || "city"));
  var legend = ((L.districts || {}).legend || []).map(String);
  var jobs = {}, zj = zoneJobs(L.zones);
  Object.keys(JOBS).forEach(function(k){ jobs[k] = JOBS[k]; });
  Object.keys(zj).forEach(function(k){ jobs[k] = zj[k]; });
  function shown(o, key){ return (o[key] | 0) <= tier; }   // min_tier / tier gates (absent = 1)
  function dname(o){ return o && o.district != null ? (legend[o.district | 0] || "") : ""; }

  /* roads: nodes and the tier's edges, in metres */
  var nodeIx = {}, NX = [], NZ = [];
  (R.nodes || []).forEach(function(n, i){ nodeIx[n.id] = i; NX.push((n.x | 0)/100); NZ.push((n.z | 0)/100); });
  var NN = NX.length, E = [];
  (R.edges || []).forEach(function(e){
    if(!shown(e, "min_tier")) return;
    var a = nodeIx[e.a], b = nodeIx[e.b], P = e.points || [];
    if(a == null || b == null || P.length < 2) return;
    var m = P.length, x = new Float64Array(m), y = new Float64Array(m), z = new Float64Array(m), cum = new Float64Array(m);
    for(var i = 0; i < m; i++){ x[i] = (P[i][0] | 0)/100; y[i] = (P[i][1] | 0)/100; z[i] = (P[i][2] | 0)/100; }
    for(i = 1; i < m; i++) cum[i] = cum[i - 1] + Math.sqrt((x[i] - x[i-1])*(x[i] - x[i-1]) + (z[i] - z[i-1])*(z[i] - z[i-1]));
    // vertex normals (left of a->b), averaged at interior vertices and stretched to keep the offset (mitre, capped)
    var nx = new Float64Array(m), nz = new Float64Array(m);
    for(i = 0; i < m; i++){
      var sx = 0, sz = 0, k;
      for(k = Math.max(0, i - 1); k < Math.min(m - 1, i + 1); k++){
        var dx = x[k+1] - x[k], dz = z[k+1] - z[k], l = Math.sqrt(dx*dx + dz*dz) || 1;
        sx += dz/l; sz += -dx/l;
      }
      var sl = Math.sqrt(sx*sx + sz*sz) || 1, ux = sx/sl, uz = sz/sl;
      var dx0 = x[Math.min(i, m - 2) + 1] - x[Math.min(i, m - 2)], dz0 = z[Math.min(i, m - 2) + 1] - z[Math.min(i, m - 2)];
      var l0 = Math.sqrt(dx0*dx0 + dz0*dz0) || 1, cos = ux*(dz0/l0) + uz*(-dx0/l0);
      var st = 1/Math.max(0.5, cos);
      nx[i] = ux*st; nz[i] = uz*st;
    }
    var width = (e.width | 0)/100, walk = (e.walk | 0)/100, cls = String(e.class || "street");
    var half = width/2;
    E.push({id: e.id, a: a, b: b, m: m, x: x, y: y, z: z, cum: cum, len: cum[m - 1], nx: nx, nz: nz, cls: cls,
            walkable: cls !== "highway" && cls !== "ring" || walk > 0,
            off: walk > 0 ? half - walk/2 : Math.max(0.5, half - SIDE_IN),
            lane: Math.max(0.5, (width - 2*walk)/4), fast: CAR_FAST[cls] || 1});
  });

  /* graphs (CSR) for walking and driving */
  function graph(keep){
    var deg = new Int32Array(NN + 1), cnt = 0;
    E.forEach(function(e){ if(keep(e)){ deg[e.a]++; deg[e.b]++; cnt += 2; } });
    var start = new Int32Array(NN + 1);
    for(var i = 0; i < NN; i++) start[i + 1] = start[i] + deg[i];
    var fill = start.slice(0, NN), to = new Int32Array(cnt), ed = new Int32Array(cnt);
    E.forEach(function(e, ei){
      if(!keep(e)) return;
      to[fill[e.a]] = e.b; ed[fill[e.a]++] = ei;
      to[fill[e.b]] = e.a; ed[fill[e.b]++] = ei;
    });
    return {start: start, to: to, ed: ed, keep: keep, g: new Float64Array(NN), from: new Int32Array(NN), par: new Int32Array(NN), stamp: new Int32Array(NN), gen: 0,
            heap: new Heap(64), goal: new Float64Array(NN), goalStamp: new Int32Array(NN), closed: new Int32Array(NN)};
  }
  var GR = {walk: graph(function(e){ return e.walkable; }), car: graph(function(){ return true; })};
  GR.walk.mode = "walk"; GR.car.mode = "car";

  /* segment grid: nearest edge to a point */
  var minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  E.forEach(function(e){ for(var i = 0; i < e.m; i++){ minX = Math.min(minX, e.x[i]); maxX = Math.max(maxX, e.x[i]); minZ = Math.min(minZ, e.z[i]); maxZ = Math.max(maxZ, e.z[i]); } });
  if(!E.length){ minX = minZ = 0; maxX = maxZ = 1; }
  var GX = Math.max(1, Math.ceil((maxX - minX)/GRID) + 1), GZ = Math.max(1, Math.ceil((maxZ - minZ)/GRID) + 1), cells = new Array(GX*GZ);
  function gx(v){ return clamp(Math.floor((v - minX)/GRID), 0, GX - 1); }
  function gz(v){ return clamp(Math.floor((v - minZ)/GRID), 0, GZ - 1); }
  E.forEach(function(e, ei){
    for(var s = 0; s + 1 < e.m; s++){
      var x0 = gx(Math.min(e.x[s], e.x[s+1])), x1 = gx(Math.max(e.x[s], e.x[s+1]));
      var z0 = gz(Math.min(e.z[s], e.z[s+1])), z1 = gz(Math.max(e.z[s], e.z[s+1]));
      for(var cz = z0; cz <= z1; cz++) for(var cx = x0; cx <= x1; cx++){ var c = cz*GX + cx; (cells[c] || (cells[c] = [])).push(ei, s); }
    }
  });
  // the nearest point on an edge the graph keeps: {e, s (station m), side (+1 left of a->b, -1 right), x, z, d}
  function attach(G, px, pz){
    var best = null, bd = Infinity;
    function look(r){
      var cx0 = gx(px - r), cx1 = gx(px + r), cz0 = gz(pz - r), cz1 = gz(pz + r);
      for(var cz = cz0; cz <= cz1; cz++) for(var cx = cx0; cx <= cx1; cx++){
        var list = cells[cz*GX + cx]; if(!list) continue;
        for(var i = 0; i < list.length; i += 2){
          var e = E[list[i]], s = list[i+1]; if(!G.keep(e)) continue;
          var ax = e.x[s], az = e.z[s], dx = e.x[s+1] - ax, dz = e.z[s+1] - az, L2 = dx*dx + dz*dz;
          var t = L2 > 0 ? clamp(((px - ax)*dx + (pz - az)*dz)/L2, 0, 1) : 0, qx = ax + dx*t, qz = az + dz*t;
          var d = (px - qx)*(px - qx) + (pz - qz)*(pz - qz);
          if(d < bd - 1e-9 || (Math.abs(d - bd) <= 1e-9 && best && (list[i] < best.ei || (list[i] === best.ei && s < best.seg)))){
            var cr = dx*(pz - az) - dz*(px - ax);   // > 0: the point is on the right of a->b ((dz, -dx) is the left)
            bd = d; best = {ei: list[i], seg: s, s: e.cum[s] + Math.sqrt(L2)*t, side: cr > 0 ? -1 : 1, x: qx, z: qz};
          }
        }
      }
    }
    var r = GRID;
    while(!best && r < 4*Math.max(maxX - minX, maxZ - minZ) + 2*GRID){ look(r); r *= 2; }
    if(!best) return null;
    best.d = Math.sqrt(bd);
    return best;
  }

  /* places: lots and sites the residents use */
  var places = [], placeIx = {};
  function place(key, kind, src, district){
    var cx = (src.x | 0)/100, cz = (src.z | 0)/100, fx = cx, fz = cz;
    if(src.front && src.front.length === 2){
      var ux = (src.front[0] | 0)/65536, uz = (src.front[1] | 0)/65536;
      var ext = Math.abs(ux)*(src.w | 0)/200 + Math.abs(uz)*(src.d | 0)/200;
      fx = cx + ux*ext; fz = cz + uz*ext;
    } else if(src.door && src.door.length === 3){ fx = (src.door[0] | 0)/100; fz = (src.door[2] | 0)/100; }
    else if(src.facing === "north" || src.facing === "south"){ fz = cz + (src.facing === "north" ? 1 : -1)*(src.d | 0)/200; }
    var p = {i: places.length, key: key, kind: kind, district: district, x: cx, z: cz, fx: fx, fz: fz, att: {},
             outdoor: !!(PARK_SITE[kind] || STOP_SITE[kind]), roles: null, food: false, park: false, stop: false, home: false};
    places.push(p); placeIx[key] = p.i;
    return p;
  }
  (L.lots || []).forEach(function(l){
    if(!l || l.kind !== "building" || !shown(l, "min_tier")) return;
    var dn = dname(l), p = place("lot:" + l.id, dn === "park" ? "park" : "lot", l, dn);
    if(dn === "park"){ p.park = true; p.outdoor = true; return; }
    p.home = !!HOME_D[dn];
    var tbl = ZONE_LOT[dn]; if(tbl && jobs[tbl]){ p.roles = jobs[tbl]; p.table = tbl; }
    p.food = !!FOOD_D[dn];
  });
  (L.sites || []).forEach(function(s){
    if(!s || !shown(s, "tier")) return;
    var k = String(s.kind || ""), p = place("site:" + s.id, k, s, "");
    if(jobs[k]){ p.roles = jobs[k]; p.table = k; }
    p.food = !!FOOD_SITE[k]; p.park = !!PARK_SITE[k] || k === "stadium"; p.stop = !!STOP_SITE[k];
  });
  var homes = places.filter(function(p){ return p.home; });
  if(!homes.length) homes = places.filter(function(p){ return p.kind === "lot"; });
  var foods = places.filter(function(p){ return p.food; }), parks = places.filter(function(p){ return p.park; });
  var stops = places.filter(function(p){ return p.stop; }), jobPlaces = places.filter(function(p){ return p.roles; });
  var hasBus = tier >= 2 && stops.length >= 2 && !!(((L.transit || {}).lines) || []).some(function(l){ return l && (l.tier | 0) <= tier; });
  function dist(a, b){ return Math.sqrt((a.x - b.x)*(a.x - b.x) + (a.z - b.z)*(a.z - b.z)); }
  function nearest(list, p, max){
    var best = null, bd = max == null ? Infinity : max;
    for(var i = 0; i < list.length; i++){ if(list[i] === p) continue; var d = dist(list[i], p); if(d < bd){ bd = d; best = list[i]; } }
    return best;
  }
  function att(p, mode){
    if(!(mode in p.att)) p.att[mode] = attach(GR[mode], p.fx, p.fz);
    return p.att[mode];
  }

  /* residents */
  var N = population(tier, grow), residents = [];
  // job slots, water-filled: round r gives every place its r-th slot while it has one, so each place
  // gets a worker before any gets a second; a place's roles interleave (A B C A B ...)
  var slotsOf = jobPlaces.map(function(p){
    var left = p.roles.map(function(r){ return Math.max(1, Math.round(r[3])); }), seq = [], any = true;
    while(any){ any = false; for(var k = 0; k < left.length; k++) if(left[k] > 0){ seq.push(k); left[k]--; any = true; } }
    return seq;
  });
  var order = jobPlaces.map(function(p, i){ return i; }).sort(function(a, b){
    return (hash32(seed + ":jp:" + jobPlaces[a].key) - hash32(seed + ":jp:" + jobPlaces[b].key)) || (a - b);
  });
  var nJobs = Math.round(N*EMPLOYED), seq = [], round = 0, cap = 0;
  slotsOf.forEach(function(s){ cap = Math.max(cap, s.length); });
  while(seq.length < nJobs && jobPlaces.length){
    for(var oi = 0; oi < order.length && seq.length < nJobs; oi++){
      var pi = order[oi], sl = slotsOf[pi];
      if(round < sl.length || round >= cap) seq.push([pi, sl[round % sl.length]]);   // full: every place again
    }
    round++;
  }
  var jobOrder = []; for(var ri = 0; ri < N; ri++) jobOrder.push(ri);
  jobOrder.sort(function(a, b){ return (hash32(seed + ":job:" + a) - hash32(seed + ":job:" + b)) || (a - b); });
  var jobOf = new Array(N);
  for(var k = 0; k < seq.length; k++) jobOf[jobOrder[k]] = seq[k];

  for(var id = 0; id < N; id++){
    var h = mix(hash32(seed + ":r:" + id)), g = rng(h);
    var home = homes.length ? homes[Math.floor(g()*homes.length)] : null;
    var look = {char: Math.floor(g()*CHARS), shirt: SHIRTS[Math.floor(g()*SHIRTS.length)], pants: PANTS[Math.floor(g()*PANTS.length)], skin: SKIN[Math.floor(g()*SKIN.length)]};
    var r = {id: id, home: home, look: look, v: WALK_V[0] + (WALK_V[1] - WALK_V[0])*g(), job: null, work: null, mode: "walk",
             phase: g(), stopH: null, stopW: null, food: null, via: null, out: [], days: [null, null, null], dayK: [NaN, NaN, NaN]};
    var J = jobOf[id];
    if(J && home){
      var wp = jobPlaces[J[0]], role = wp.roles[J[1]];
      r.work = wp; r.job = {job: role[0], from: role[1], to: role[2], kind: wp.kind === "lot" ? wp.table : wp.kind, place: wp.key};
      var d = dist(home, wp);
      if(d > WALK_MAX){
        var sh = hasBus ? nearest(stops, home, STOP_MAX) : null, sw = hasBus ? nearest(stops, wp, STOP_MAX) : null;
        r.mode = sh && sw && sh !== sw && g() < 0.55 ? "bus" : "car";
        if(r.mode === "bus"){ r.stopH = sh; r.stopW = sw; }
      }
      r.food = nearest(foods, wp, LUNCH_MAX);
      r.via = g() < 0.5 ? nearest(foods, wp, VIA_MAX) : nearest(parks, wp, VIA_MAX);
    }
    if(home){ r.out = [nearest(parks, home), nearest(foods, home)].filter(Boolean); }
    residents.push(r);
  }

  /* plans: a day's moves {t0 (ms from the day's start, may pass 24 h), dur, from, to, mode} */
  function walkDur(r, a, b){ return Math.round(dist(a, b)*DETOUR.walk/r.v*1000) + 1000; }
  function carDur(a, b){ return Math.round(dist(a, b)*DETOUR.car/CAR_V*1000) + 30000; }
  function nextBus(stop, t){
    var off = hash32(seed + ":bus:" + stop.key) % BUS_EVERY;
    return Math.ceil((t - off)/BUS_EVERY)*BUS_EVERY + off;
  }
  // a trip from a to b leaving at t: pushes its moves, returns the arrival time
  function trip(r, out, a, b, t, mode){
    if(!a || !b || a === b) return t;
    if(mode === "car"){ var d = carDur(a, b); out.push({t0: t, dur: d, from: a, to: b, mode: "car"}); return t + d; }
    if(mode === "bus" && r.stopH && r.stopW){
      var s1 = a === r.home ? r.stopH : r.stopW, s2 = s1 === r.stopH ? r.stopW : r.stopH;
      var t1 = trip(r, out, a, s1, t, "walk"), dep = nextBus(s1, t1 + 30000);
      var ride = Math.round(dist(s1, s2)*DETOUR.bus/BUS_V*1000);
      out.push({t0: dep, dur: ride, from: s1, to: s2, mode: "bus"});
      return trip(r, out, s2, b, dep + ride, "walk");
    }
    var w = walkDur(r, a, b); out.push({t0: t, dur: w, from: a, to: b, mode: "walk"}); return t + w;
  }
  function tripDur(r, a, b, mode){   // a trip's planned duration (worst-case bus wait), to leave in time
    if(mode === "car") return carDur(a, b);
    if(mode === "bus" && r.stopH && r.stopW){ var s1 = a === r.home ? r.stopH : r.stopW, s2 = s1 === r.stopH ? r.stopW : r.stopH;
      return walkDur(r, a, s1) + 30000 + BUS_EVERY + Math.round(dist(s1, s2)*DETOUR.bus/BUS_V*1000) + walkDur(r, s2, b); }
    return walkDur(r, a, b);
  }
  function plan(r, day){
    var out = [], g = rng(mix(hash32(seed + ":d:" + r.id + ":" + day))), home = -1;
    if(!r.home) return out;
    function outing(p, t, stay){   // home -> p at t, back after stay (ms); -> the time home
      var m = dist(r.home, p) <= WALK_MAX ? "walk" : "car", arr = trip(r, out, r.home, p, t, m);
      return trip(r, out, p, r.home, arr + stay, m);
    }
    if(r.job){
      var J = r.job, from = J.from*HOUR, to = J.to*HOUR, night = J.to <= J.from;
      if(night) to += DAY;
      // arrive 5-60 min early: 07:00-09:00 for a 9:00 start
      var t = from - tripDur(r, r.home, r.work, r.mode) - Math.round((5 + 55*g())*MIN);
      trip(r, out, r.home, r.work, t, r.mode);
      // lunch: shifts that cover 11:00-14:00 walk to the nearest food place at 12:00
      if(!night && J.from <= 11 && J.to >= 14 && r.food && g() < 0.7){
        trip(r, out, r.work, r.food, 12*HOUR + Math.round(15*g()*MIN), "walk");
        trip(r, out, r.food, r.work, 12*HOUR + Math.round((40 + 10*g())*MIN), "walk");
      }
      // home within the hour after the shift (17:00-19:00 for 9-17), some via the market or a park
      var back = to + Math.round((night ? 15 : 60)*g()*MIN);
      if(!night && r.via && r.mode !== "bus" && g() < 0.35){
        var at = trip(r, out, r.work, r.via, back, dist(r.work, r.via) <= WALK_MAX ? "walk" : r.mode);
        home = trip(r, out, r.via, r.home, at + Math.round((20 + 40*g())*MIN), r.mode);
      } else home = trip(r, out, r.work, r.home, back, r.mode);
      // an evening in the park
      if(!night && r.out[0] && home < 20*HOUR && g() < 0.3)
        outing(r.out[0], Math.max(home + 30*MIN, 19*HOUR + Math.round(60*g()*MIN)), Math.round((30 + 45*g())*MIN));
    } else if(r.out.length){
      // no job: a morning outing (a park or the market), maybe an afternoon one in the park
      home = outing(r.out[Math.floor(g()*r.out.length)], 10*HOUR + Math.round(90*g()*MIN), Math.round((45 + 75*g())*MIN));
      if(r.out[0] && g() < 0.6) outing(r.out[0], Math.max(home + 30*MIN, 15*HOUR + Math.round(90*g()*MIN)), Math.round((30 + 60*g())*MIN));
    }
    return out;
  }
  function planOf(r, day){
    var k = day % 3; if(k < 0) k += 3;
    if(r.dayK[k] !== day){ r.dayK[k] = day; r.days[k] = plan(r, day); }
    return r.days[k];
  }
  // the latest move started by t (absolute local ms): {m, start} or null (home)
  function moveAt(r, t){
    var day = Math.floor(t/DAY), best = null, bs = -Infinity;
    for(var dd = -1; dd <= 0; dd++){
      var p = planOf(r, day + dd), base = (day + dd)*DAY;
      for(var i = 0; i < p.length; i++){ var s = base + p[i].t0; if(s <= t && s >= bs){ bs = s; best = p[i]; } }
    }
    return best ? {m: best, start: bs} : null;
  }

  /* routes: A* on the graph between two attachments, then the offset polyline */
  var paths = {}, stats = {astar: 0, ms: 0, paths: 0};
  function astar(G, A, B){
    var ea = E[A.ei], eb = E[B.ei], gen = ++G.gen, H = G.heap, tx = B.x, tz = B.z, fm = G.mode === "car" ? FAST_MAX : 1;
    H.n = 0;
    function cost(e, l){ return G.mode === "car" ? l/e.fast : l; }
    function seed0(n, c){ if(G.stamp[n] !== gen || c < G.g[n]){ G.stamp[n] = gen; G.g[n] = c; G.from[n] = -1; H.push(c + hd(n), n); } }
    function hd(n){ var dx = NX[n] - tx, dz = NZ[n] - tz; return Math.sqrt(dx*dx + dz*dz)/fm; }
    G.goalStamp[eb.a] = gen; G.goal[eb.a] = cost(eb, B.s);
    if(G.goalStamp[eb.b] !== gen || cost(eb, eb.len - B.s) < G.goal[eb.b]){ G.goalStamp[eb.b] = gen; G.goal[eb.b] = cost(eb, eb.len - B.s); }
    if(eb.a === eb.b) G.goal[eb.a] = Math.min(cost(eb, B.s), cost(eb, eb.len - B.s));
    seed0(ea.a, cost(ea, A.s)); seed0(ea.b, cost(ea, ea.len - A.s));
    var best = Infinity, bestN = -1;
    while(H.n){
      var u = H.pop(), f = H.top;
      if(f >= best) break;
      if(G.closed[u] === gen) continue;
      G.closed[u] = gen;
      if(G.goalStamp[u] === gen && G.g[u] + G.goal[u] < best){ best = G.g[u] + G.goal[u]; bestN = u; }
      for(var j = G.start[u]; j < G.start[u + 1]; j++){
        var v = G.to[j], e = E[G.ed[j]], c = G.g[u] + cost(e, e.len);
        if(G.stamp[v] !== gen || c < G.g[v] - 1e-9){ G.stamp[v] = gen; G.g[v] = c; G.from[v] = j; G.par[v] = u; G.closed[v] = 0; H.push(c + hd(v), v); }
      }
    }
    if(bestN < 0) return null;
    var hops = [], n = bestN;   // [edge index, the node it enters], from the start side to bestN
    while(G.from[n] >= 0){ hops.push([G.ed[G.from[n]], n]); n = G.par[n]; }
    hops.reverse();
    return {first: n, hops: hops, last: bestN};
  }
  // append edge e's line from station s0 to s1 at lateral offset o (signed: + left of a->b), y + up
  function run(out, e, s0, s1, o, up){
    var dir = s1 >= s0 ? 1 : -1, i, cum = e.cum;
    function at(s){
      var k = 0; while(k < e.m - 2 && cum[k + 1] < s) k++;
      var l = cum[k + 1] - cum[k], t = l > 0 ? clamp((s - cum[k])/l, 0, 1) : 0;
      var nx = e.nx[k] + (e.nx[k + 1] - e.nx[k])*t, nz = e.nz[k] + (e.nz[k + 1] - e.nz[k])*t;
      out.push(e.x[k] + (e.x[k+1] - e.x[k])*t + nx*o, e.y[k] + (e.y[k+1] - e.y[k])*t + up, e.z[k] + (e.z[k+1] - e.z[k])*t + nz*o);
    }
    at(s0);
    if(dir > 0){ for(i = 0; i < e.m; i++) if(cum[i] > s0 + 1e-6 && cum[i] < s1 - 1e-6) out.push(e.x[i] + e.nx[i]*o, e.y[i] + up, e.z[i] + e.nz[i]*o); }
    else { for(i = e.m - 1; i >= 0; i--) if(cum[i] < s0 - 1e-6 && cum[i] > s1 + 1e-6) out.push(e.x[i] + e.nx[i]*o, e.y[i] + up, e.z[i] + e.nz[i]*o); }
    at(s1);
  }
  function routeOf(mode, a, b){
    var key = mode + ":" + a.i + ">" + b.i;
    if(paths[key] !== undefined) return paths[key];
    var t0 = Date.now(), G = GR[mode], A = att(a, mode), B = att(b, mode), pts = [], walk = mode === "walk";
    var up = walk ? SIDEWALK_UP : ROAD_UP;
    // walkers keep to the lot's side on the first and last edge; on the way, both keep left of travel
    function off(e, side){ return side*(walk ? e.off : e.lane); }
    if(A && B){
      if(A.ei === B.ei){
        var e = E[A.ei], sd = B.s >= A.s ? 1 : -1;
        run(pts, e, A.s, B.s, walk ? off(e, A.side) : off(e, sd), up);
        if(walk && A.side !== B.side) run(pts, e, B.s, B.s, off(e, B.side), up);
      } else {
        var r = astar(G, A, B);
        stats.astar++;
        if(r){
          var ea = E[A.ei], toA = r.first === ea.a ? 0 : ea.len;
          run(pts, ea, A.s, toA, walk ? off(ea, A.side) : off(ea, toA >= A.s ? 1 : -1), up);
          var n = r.first;
          r.hops.forEach(function(hp){
            var e = E[hp[0]], fwd = e.a === n && !(e.a === e.b);
            run(pts, e, fwd ? 0 : e.len, fwd ? e.len : 0, off(e, fwd ? 1 : -1), up);
            n = hp[1];
          });
          var eb = E[B.ei], fromB = r.last === eb.a ? 0 : eb.len;
          run(pts, eb, fromB, B.s, walk ? off(eb, B.side) : off(eb, B.s >= fromB ? 1 : -1), up);
        }
      }
    }
    var res = null;
    if(pts.length >= 6){
      var m = pts.length/3, P = new Float32Array(pts), C = new Float32Array(m);
      for(var i = 1; i < m; i++){ var dx = P[3*i] - P[3*i-3], dz = P[3*i+2] - P[3*i-1]; C[i] = C[i-1] + Math.sqrt(dx*dx + dz*dz); }
      res = {p: P, c: C, len: C[m - 1], n: m};
    }
    paths[key] = res; stats.paths++; stats.ms += Date.now() - t0;
    return res;
  }
  // a point s metres along a route -> into o {x, y, z, yaw}
  function along(P, s, o){
    var C = P.c, lo = 0, hi = P.n - 1;
    s = clamp(s, 0, P.len);
    while(hi - lo > 1){ var mid = (lo + hi) >> 1; if(C[mid] <= s) lo = mid; else hi = mid; }
    var l = C[hi] - C[lo], t = l > 0 ? (s - C[lo])/l : 0, p = P.p;
    o.x = p[3*lo] + (p[3*hi] - p[3*lo])*t; o.y = p[3*lo+1] + (p[3*hi+1] - p[3*lo+1])*t; o.z = p[3*lo+2] + (p[3*hi+2] - p[3*lo+2])*t;
    // heading: the first segment with length at or after this point (zero-length joins have none)
    var k = lo; while(k < P.n - 2 && !(C[k + 1] - C[k] > 1e-4)) k++;
    var dx = p[3*k+3] - p[3*k], dz = p[3*k+5] - p[3*k+2];
    o.yaw = Math.atan2(dx, dz);
  }
  // standing at an outdoor place: spread along its sidewalk, facing it
  function idleAt(r, p, o){
    var A = att(p, "walk"); if(!A) return false;
    var e = E[A.ei], spread = p.stop ? 3 : 12, s = clamp(A.s + (((r.id*0.6180339887 + r.phase) % 1) - 0.5)*spread, 0, e.len);
    var k = 0; while(k < e.m - 2 && e.cum[k + 1] < s) k++;
    var l = e.cum[k + 1] - e.cum[k], t = l > 0 ? (s - e.cum[k])/l : 0, o2 = A.side*e.off;
    var nx = e.nx[k] + (e.nx[k+1] - e.nx[k])*t, nz = e.nz[k] + (e.nz[k+1] - e.nz[k])*t;
    o.x = e.x[k] + (e.x[k+1] - e.x[k])*t + nx*o2; o.y = e.y[k] + (e.y[k+1] - e.y[k])*t + SIDEWALK_UP; o.z = e.z[k] + (e.z[k+1] - e.z[k])*t + nz*o2;
    o.yaw = Math.atan2(nx*A.side, nz*A.side);   // the left normal x side points at the place
    return true;
  }

  // a resident's state at local ms t: {state, place, mode, f, move, start}
  // how long a move really takes (ms): a walk lasts its route at the walker's own pace (the route is a
  // pure function of the doc, so this stays pure), within [plan/STRETCH, plan*STRETCH]; rides as planned
  function durOf(r, m){
    if(m.mode !== "walk") return m.dur;
    var P = routeOf("walk", m.from, m.to);
    return P ? clamp(P.len/r.v*1000, m.dur/STRETCH, m.dur*STRETCH) : m.dur;
  }
  function stateOf(r, t){
    var mv = moveAt(r, t);
    if(!mv) return {state: r.home ? "home" : "none", place: r.home, mode: null};
    var m = mv.m, f = t - mv.start < m.dur*STRETCH ? (t - mv.start)/durOf(r, m) : 1;
    if(f < 1) return {state: m.mode === "bus" ? "riding" : "travel", place: null, mode: m.mode, f: f, move: m, start: mv.start};
    var p = m.to, st = "out";
    if(p === r.home) st = "home";
    else if(p === r.work) st = "work";
    else if(p.stop) st = "stop";
    else if(r.job && p === r.food){ var tod = ((t % DAY) + DAY) % DAY; st = tod >= 11*HOUR && tod < 14*HOUR ? "lunch" : "out"; }
    return {state: st, place: p, mode: st === "stop" ? "bus" : m.mode, move: m, start: mv.start};
  }

  var sim = {residents: [], tier: tier, grow: grow, seed: seed, population: N, stats: stats};
  residents.forEach(function(r){
    sim.residents.push({id: r.id, home: r.home ? r.home.key : null, mode: r.mode, look: r.look, speed: r.v,
                        job: r.job ? {job: r.job.job, from: r.job.from, to: r.job.to, kind: r.job.kind, place: r.job.place} : null});
  });
  sim.places = places.map(function(p){ return {key: p.key, kind: p.kind, x: p.x, z: p.z, table: p.table || null, outdoor: p.outdoor}; });
  sim.plan = function(id, day){ var r = residents[id | 0]; return r ? planOf(r, day | 0).map(function(m){ return {t0: m.t0, dur: m.dur, from: m.from.key, to: m.to.key, mode: m.mode}; }) : []; };
  sim.where = function(id, t){
    var r = residents[id | 0]; if(!r) return null;
    var s = stateOf(r, +t || 0);
    return {state: s.state, place: s.place ? s.place.key : null, mode: s.mode};
  };
  // the visible residents within radius of c at local ms t, nearest first
  sim.at = function(t, c, radius){
    t = +t || 0; c = c || {}; radius = radius == null ? 150 : +radius;
    var cx = +c.x || 0, cz = +c.z || 0, r2 = radius*radius, out = [], o = {x: 0, y: 0, z: 0, yaw: 0};
    for(var i = 0; i < residents.length; i++){
      var r = residents[i], s = stateOf(r, t), anim, mode = s.mode || "walk", speed = 0;
      if(s.state === "travel"){
        var m = s.move, P = routeOf(m.mode, m.from, m.to);
        if(!P) continue;
        along(P, s.f*P.len, o);
        speed = P.len/(durOf(r, m)/1000);
        anim = m.mode === "car" ? "drive" : "walk";
      } else if(s.place && s.place.outdoor && (s.state === "stop" || s.state === "out")){
        if(!idleAt(r, s.place, o)) continue;
        anim = "idle";
      } else continue;
      var dx = o.x - cx, dz = o.z - cz, d2 = dx*dx + dz*dz;
      if(d2 > r2) continue;
      out.push({id: r.id, x: o.x, y: o.y, z: o.z, yaw: o.yaw, anim: anim, mode: mode, speed: speed, d2: d2});
    }
    out.sort(function(a, b){ return a.d2 - b.d2 || a.id - b.id; });
    return out;
  };
  // plan routes ahead (trips in progress or starting within the next hour) for up to `ms` of wall time
  var warmAt = 0;
  sim.warm = function(t, ms){
    var t0 = Date.now(), lim = ms == null ? 4 : +ms, n = residents.length, done = 0;
    t = +t || 0;
    for(var k = 0; k < n && Date.now() - t0 < lim; k++){
      var r = residents[(warmAt + k) % n], day = Math.floor(t/DAY);
      for(var dd = -1; dd <= 0; dd++){
        var p = planOf(r, day + dd), base = (day + dd)*DAY;
        for(var i = 0; i < p.length; i++){
          var s = base + p[i].t0;
          if(p[i].mode !== "bus" && s <= t + HOUR && s + p[i].dur >= t) routeOf(p[i].mode, p[i].from, p[i].to);
        }
      }
      done++;
    }
    warmAt = (warmAt + done) % Math.max(1, n);
    return done;
  };
  // a speech line for resident id at local ms t (fixed templates: no user data)
  sim.speak = function(id, t){
    var r = residents[id | 0]; if(!r) return "";
    var s = stateOf(r, +t || 0), tod = ((((+t || 0) % DAY) + DAY) % DAY)/HOUR, g = rng(mix(hash32(seed + ":say:" + id + ":" + Math.floor((+t || 0)/(10*MIN)))));
    function pick(a){ return a[Math.floor(g()*a.length)]; }
    var J = r.job, where = J ? (PLACE_WORD[J.kind] || "work") : "", line;
    var dayPart = tod < 5 ? "night" : tod < 12 ? "morning" : tod < 17 ? "afternoon" : tod < 22 ? "evening" : "night";
    if(s.state === "travel" && J && s.move.to === r.work) line = pick(["Off to the " + where + ". My shift starts at " + hhmm(J.from) + ".",
      "Can't be late: " + hhmm(J.from) + " at the " + where + ".", "Another " + dayPart + " heading to the " + where + "."]);
    else if(s.state === "travel" && s.move.to === r.home) line = pick(["Heading home. Long " + (dayPart === "night" ? "night" : "day") + ".",
      "Home time. " + (J ? "The " + where + " can manage without me now." : "Nice to be out, though."), "Off home, the kettle's calling."]);
    else if(s.state === "travel" && J && s.move.to === r.food) line = pick(["Lunch break! I know a good place round the corner.", "Twelve o'clock: food first."]);
    else if(s.state === "travel") line = pick(["Just passing through.", "Lovely " + dayPart + " for a walk.", "Running a few errands."]);
    else if(s.state === "home" || s.state === "work" || s.state === "lunch") line = pick(["Hello there!", "Nice " + dayPart + ", isn't it?"]);
    else if(s.state === "stop") line = pick(["The next bus should be along in a few minutes.", "Buses every eight minutes, they say."]);
    else line = pick(["Lovely " + dayPart + " in the park.", "Just enjoying the city today.", "Nothing beats a bit of fresh air."]);
    var extra = J && FLAVOUR[J.job] && g() < 0.6 ? " " + pick(FLAVOUR[J.job]) : "";
    return line + extra;
  };
  return sim;
}
var PLACE_WORD = {townhall: "town hall", clinic: "clinic", hospital: "hospital", fire: "fire station", police: "police station",
  school: "school", university: "university", market: "market", mall: "mall", bank: "bank", library: "library", post: "post office",
  transit: "transit hub", port: "port", dock: "dock", airport: "airport", power: "power station", water: "waterworks",
  stadium: "stadium", office: "office", campus: "campus", studio: "studio", finance: "trading floor", biotech: "lab",
  media: "newsroom", warehouse: "warehouse", farm: "farm", shop: "shop", civic: "office"};
var FLAVOUR = {
  officer: ["Keeping the streets safe.", "Quiet beat so far, touch wood."], firefighter: ["All quiet at the station, touch wood.", "We drill every morning."],
  doctor: ["Remember to drink some water today.", "Busy ward this week."], nurse: ["Double shift, but the team's great.", "Wash your hands!"],
  engineer: ["Our build finally went green.", "Shipping a big release this week."], designer: ["I've been pushing pixels all day."],
  crew: ["We've been rigging the lights since dawn."], cast: ["Got my lines memorised for the next take."],
  trader: ["Markets were wild today."], analyst: ["The spreadsheets never end."], scientist: ["The samples look promising."],
  farmer: ["The harvest's looking good."], loader: ["Forty pallets before lunch."], teacher: ["The kids were brilliant today."],
  vendor: ["Fresh fruit this morning, come by!"], clerk: ["Paperwork, paperwork."], reporter: ["Chasing a story."],
  editor: ["Deadline's at six."], librarian: ["We've got new books in."], teller: ["The vault's balanced to the coin."]
};

HQV.npcSim = {create: create, population: population, localMs: localMs, zoneJobs: zoneJobs, inPoly: inPoly, hash32: hash32,
              JOBS: JOBS, POP: POP, CHARS: CHARS, DAY: DAY, HOUR: HOUR};
})();
