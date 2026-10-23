/* Claude HQ: the City's residents (Cities spec, task cl-npc), a pure simulation.
 *
 * HQV.npcSim.create(doc, {tier, grow, seed, city?, clockTzMin?}) -> sim. Everything a resident does is a pure function of
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
 *               O(visible): a time/space index (SLOT minutes x CELL m) of the moves under way and the
 *               outdoor stays in each slot, built once per slot; only residents whose slot box reaches
 *               the circle are worked out (the same rows as asking everyone: sim.atScan, for the tests).
 *   where(id, t), speak(id, t), warm(ms), localMs(date): see below.
 * The city (opts.city, a games/citysim.js director D; optional): residents react to its events, all
 * pure in (doc, seed, the event): D.events(around now) in UTC ms, moved onto the local clock by
 * opts.clockTzMin (minutes the local clock is ahead of UTC; default this machine's, as localMs).
 *   gawk      fire / crash / crime / medical: up to 3 + 3 x severity residents whose home or work is
 *             within GAWK_R walk to the scene's sidewalk, watch from 10-28 m off and walk back
 *   patient   medical: one resident near the scene lies on the sidewalk ("lie") until the ambulance
 *             leaves, then is away (in the ambulance, at the hospital) to the event's end
 *   crew      units fire / police / ambulance: firefighters, officers, nurses and doctors at work at
 *             the unit's station stand at its bay when the run starts, at the scene while the unit is
 *             there and at the bay again when it is back
 *   fan       match: ticket holders (FAN_SHARE, hash) go from home to the stadium 10-45 min before
 *             kick-off, cheer outside ("cheer"), are inside for the match and go home after
 *   pupil     school: jobless residents near their nearest school walk in before the bell, are inside
 *             until the end of the day, then walk home
 *   shopper   market: residents nearby browse the stalls for 20-50 min
 *   festival  festival: crowds cheer at the park or plaza through the evening
 * A resident only joins when its own day leaves room (at home, or still at the same place throughout);
 * home-based outings hold the resident at home until its own day has it home again, so nobody jumps.
 * The earliest event wins a resident claimed twice. speak() mentions the events (by street).
 * New at() anims with a city: "lie" (patient), "cheer" (fans, festival); modes stay walk / car.
 *   joined(t, evId?) -> [{id, kind, ev}] the residents events hold at local t; where() reports their kind as
 *   the state. stats.cand / stats.claimed: residents worked out / held by events in the last at().
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
var SLOT = 2*MIN, CELL = 64;        // at()'s index: time slot, grid cell (m)
var SLOTS_KEPT = 4, WIDE = 256;     // slots cached; an entry covering more cells goes on the slot's wide list
// the city's events (opts.city)
var EV_SLOT = 5*MIN, EV_BACK = 12*HOUR, EV_AHEAD = 3*HOUR, EV_KEPT = 400;
var HOLD = 3*HOUR;                  // an incident holds nobody longer than this after its end (crowds: EV_BACK)
var GAWK_R = 120, PATIENT_R = 200, FAN_SHARE = 0.14, FAN_MAX = 240, PUPIL_SHARE = 0.7, PUPIL_MAX = 150, PUPIL_R = 1500;
var SHOP_SHARE = 0.18, SHOP_MAX = 80, SHOP_R = 1000, FEST_SHARE = 0.12, FEST_MAX = 160, OUT_WALK = 1200;
var CREW = {fire: {n: 3, jobs: {firefighter: 1}}, police: {n: 2, jobs: {officer: 1}}, ambulance: {n: 2, jobs: {nurse: 1, doctor: 1}}};
var INCIDENT = {fire: 1, medical: 1, crime: 1, crash: 1};
var CROWD = {match: 1, school: 1, market: 1, festival: 1};   // (patrols, deliveries and rush hour: nobody joins)

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
    var c = city ? claims(+t || 0)[r.id] : null;
    if(c){ var g = c.s.g; return {state: c.R.kind, place: g.k === "stay" || g.k === "lie" || g.k === "slide" ? g.p.key : null, mode: g.k === "go" ? g.mode : "walk"}; }
    var s = stateOf(r, +t || 0);
    return {state: s.state, place: s.place ? s.place.key : null, mode: s.mode};
  };
  // a resident's own (base) row at local ms t into o: -> {anim, mode, speed} | null (not visible)
  function baseRow(r, t, o){
    var s = stateOf(r, t), mode = s.mode || "walk";
    if(s.state === "travel"){
      var m = s.move, P = routeOf(m.mode, m.from, m.to);
      if(!P) return null;
      along(P, s.f*P.len, o);
      return {anim: m.mode === "car" ? "drive" : "walk", mode: mode, speed: P.len/(durOf(r, m)/1000)};
    }
    if(s.place && s.place.outdoor && (s.state === "stop" || s.state === "out")) return idleAt(r, s.place, o) ? {anim: "idle", mode: mode, speed: 0} : null;
    return null;
  }

  /* ---------- at()'s index: per SLOT, the moves under way and the outdoor stays, boxed on a CELL grid ---------- */
  var IGX = Math.max(1, Math.ceil((maxX - minX)/CELL) + 1), IGZ = Math.max(1, Math.ceil((maxZ - minZ)/CELL) + 1);
  function ix(v){ return clamp(Math.floor((v - minX)/CELL), 0, IGX - 1); }
  function iz(v){ return clamp(Math.floor((v - minZ)/CELL), 0, IGZ - 1); }
  // a resident's moves of days day-1..day+1 with absolute starts, by start (sel: day-1 and day, the ones moveAt picks from)
  function seqOf(r, day){
    var L = [];
    for(var dd = -1; dd <= 1; dd++){ var p = planOf(r, day + dd), base = (day + dd)*DAY; for(var i = 0; i < p.length; i++) L.push({m: p[i], s: base + p[i].t0, sel: dd <= 0}); }
    L.sort(function(a, b){ return a.s - b.s; });
    return L;
  }
  var slots = [], tmpO = {x: 0, y: 0, z: 0, yaw: 0};
  function slotOf(k){
    for(var q = 0; q < slots.length; q++) if(slots[q].k === k) return slots[q];
    var T0 = k*SLOT, T1 = T0 + SLOT, day = Math.floor(T0/DAY), id = [], bx = [];
    function box(rid, x0, z0, x1, z1){ id.push(rid); bx.push(x0 - 1, z0 - 1, x1 + 1, z1 + 1); }
    for(var i = 0; i < residents.length; i++){
      var r = residents[i]; if(!r.home) continue;
      var L = seqOf(r, day);
      for(var j = 0; j < L.length; j++){
        var e = L[j]; if(!e.sel || e.s >= T1) continue;
        var m = e.m, s = e.s, next = Infinity;
        for(var j2 = j + 1; j2 < L.length; j2++) if(L[j2].s > s){ next = L[j2].s; break; }
        var stay = m.to.outdoor && next > T0;
        if(s + (m.mode === "walk" ? m.dur*STRETCH : m.dur) <= T0 && !stay) continue;
        var dur = durOf(r, m);
        if(m.mode !== "bus" && s + dur > T0){   // under way in the slot: the part of its route it covers
          var P = routeOf(m.mode, m.from, m.to);
          if(P){
            var a = (Math.max(T0, s) - s)/dur*P.len, b = (Math.min(T1, s + dur) - s)/dur*P.len, x0, z0, x1, z1;
            along(P, a, tmpO); x0 = x1 = tmpO.x; z0 = z1 = tmpO.z;
            along(P, b, tmpO); x0 = Math.min(x0, tmpO.x); x1 = Math.max(x1, tmpO.x); z0 = Math.min(z0, tmpO.z); z1 = Math.max(z1, tmpO.z);
            for(var pi = 1; pi < P.n - 1; pi++){
              var cpi = P.c[pi]; if(cpi <= a) continue; if(cpi >= b) break;
              var px = P.p[3*pi], pz = P.p[3*pi+2];
              if(px < x0) x0 = px; if(px > x1) x1 = px; if(pz < z0) z0 = pz; if(pz > z1) z1 = pz;
            }
            box(r.id, x0, z0, x1, z1);
          }
        }
        if(stay && s + dur < T1){   // standing at an outdoor place (idleAt: within 6 m along, the offset at most doubled)
          var A = att(m.to, "walk");
          if(A){ var h = 7 + 2*Math.abs(E[A.ei].off); box(r.id, A.x - h, A.z - h, A.x + h, A.z + h); }
        }
      }
    }
    var cells = {}, wide = [];
    for(var n = 0; n < id.length; n++){
      var cx0 = ix(bx[4*n]), cz0 = iz(bx[4*n+1]), cx1 = ix(bx[4*n+2]), cz1 = iz(bx[4*n+3]);
      if((cx1 - cx0 + 1)*(cz1 - cz0 + 1) > WIDE){ wide.push(n); continue; }
      for(var cz = cz0; cz <= cz1; cz++) for(var cx = cx0; cx <= cx1; cx++){ var c = cz*IGX + cx; (cells[c] || (cells[c] = [])).push(n); }
    }
    var S = {k: k, id: Int32Array.from(id), bx: Float64Array.from(bx), cells: cells, wide: wide, seen: new Int32Array(id.length), gen: 0};
    slots.push(S); if(slots.length > SLOTS_KEPT) slots.shift();
    return S;
  }
  // calls fn(resident index) once for each resident whose slot box comes within radius of (cx, cz)
  var rstamp = new Int32Array(Math.max(1, N)), rgen = 0;
  function candidates(t, cx, cz, radius, fn){
    var S = slotOf(Math.floor(t/SLOT)), g = ++S.gen, rg = ++rgen, n = 0;
    function test(e){
      if(S.seen[e] === g) return; S.seen[e] = g;
      var B = S.bx, dx = Math.max(B[4*e] - cx, 0, cx - B[4*e+2]), dz = Math.max(B[4*e+1] - cz, 0, cz - B[4*e+3]);
      if(dx*dx + dz*dz > radius*radius) return;
      var rid = S.id[e]; if(rstamp[rid] === rg) return; rstamp[rid] = rg; n++; fn(rid);
    }
    var cx0 = ix(cx - radius), cx1 = ix(cx + radius), cz0 = iz(cz - radius), cz1 = iz(cz + radius), e;
    if((cx1 - cx0 + 1)*(cz1 - cz0 + 1) > S.id.length){ for(e = 0; e < S.id.length; e++) test(e); return n; }
    for(var qz = cz0; qz <= cz1; qz++) for(var qx = cx0; qx <= cx1; qx++){ var L = S.cells[qz*IGX + qx]; if(L) for(var i = 0; i < L.length; i++) test(L[i]); }
    for(e = 0; e < S.wide.length; e++) test(S.wide[e]);
    return n;
  }

  /* ---------- the city's events (opts.city): who joins which, as timelines of segments ---------- */
  var city = opts.city && typeof opts.city === "object" ? opts.city : null;
  var tzMs = (opts.clockTzMin != null ? +opts.clockTzMin || 0 : -new Date().getTimezoneOffset())*MIN;
  function loc(u){ return (+u || 0) + tzMs; }
  var homeOf = places.map(function(){ return []; }), workOf = places.map(function(){ return []; });
  residents.forEach(function(r){ if(r.home) homeOf[r.home.i].push(r); if(r.work) workOf[r.work.i].push(r); });
  var schools = places.filter(function(p){ return p.kind === "school"; });
  function frac(s){ return mix(hash32(s))/4294967296; }
  // the events around UTC u (cached per EV_SLOT), by start then id
  var evCache = {k: NaN, list: []};
  function eventsNear(u){
    var k = Math.floor(u/EV_SLOT);
    if(evCache.k === k) return evCache.list;
    var list = [], seen = {};
    function add(ev){
      if(!ev || ev.id == null || seen[ev.id] || !isFinite(+ev.start) || !isFinite(+ev.end) || !(INCIDENT[ev.kind] || CROWD[ev.kind])) return;
      if(INCIDENT[ev.kind] && +ev.end + HOLD < k*EV_SLOT) return;
      seen[ev.id] = 1; list.push(ev);
    }
    try {
      if(typeof city.events === "function") (city.events(k*EV_SLOT - EV_BACK, (k + 1)*EV_SLOT + EV_AHEAD) || []).forEach(add);
      else {
        var u0 = k*EV_SLOT;
        (typeof city.active === "function" ? city.active(u0) || [] : []).forEach(add);
        var st = typeof city.at === "function" ? city.at(u0) : null;
        if(st) ["match", "market", "school", "festival"].forEach(function(n){ add(st[n]); });
      }
    } catch(err){ list = []; }
    list.sort(function(a, b){ return (+a.start - +b.start) || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0); });
    evCache = {k: k, list: list};
    return list;
  }
  // the place an event happens at: its site, its lot, or a spot at (x, z)
  var dynI = 0;
  function evPlace(ev){
    var k = ev.site != null ? placeIx["site:" + ev.site] : null;
    if(k == null && ev.site != null) k = placeIx[String(ev.site)];
    if(k == null && ev.lot != null) k = placeIx["lot:" + ev.lot];
    if(k != null) return places[k];
    var x = +ev.x || 0, z = +ev.z || 0;
    return {i: places.length + 1000000 + (dynI++), key: "ev:" + ev.id, kind: "event", district: "", x: x, z: z, fx: x, fz: z, att: {}, outdoor: true};
  }
  function placesNear(x, z, R){ return places.filter(function(p){ return (p.x - x)*(p.x - x) + (p.z - z)*(p.z - z) <= R*R; }); }
  // the place a resident stays at from a to b by its own day (no move starts or ends between), or null
  function free(r, a, b, want){
    var A = moveAt(r, a), B = moveAt(r, b);
    if((A && A.m) !== (B && B.m)) return null;
    var s = stateOf(r, a);
    if(!s.place || s.state === "travel" || s.state === "riding" || stateOf(r, b).state !== s.state) return null;
    return want && !want[s.state] ? null : s.place;
  }
  // the first time from t on that the resident's own day has it at home (t when it is; t when it never is)
  function homeBy(r, t){
    if(stateOf(r, t).state === "home") return t;
    var L = seqOf(r, Math.floor(t/DAY));
    for(var i = 0; i < L.length; i++){
      var e = L[i]; if(e.m.to !== r.home) continue;
      var arr = e.s + durOf(r, e.m);
      if(arr >= t && stateOf(r, arr).state === "home") return arr;
    }
    return t;
  }
  function legDur(r, mode, a, b){
    if(mode === "car") return carDur(a, b);
    var w = walkDur(r, a, b), P = routeOf("walk", a, b);
    return P ? clamp(P.len/r.v*1000, w/STRETCH, w*STRETCH) : w;
  }

  // Timelines: rec {r, ev, kind, a (start), segs, ends (lazy)}; segments, each starting where the last ended:
  //   {k: "go", mode, from, to}       a trip on the route (its time from the route, as durOf)
  //   {k: "slide", p, d0, d1}         along the sidewalk from d0 to d1 m off p's spot, at walking pace
  //   {k: "stay", p, d, until, anim}  standing d m off p's spot, facing p, until the time (or at once if past)
  //   {k: "lie", p, d, until}         lying there
  //   {k: "hide", until}              away (inside, riding): not visible
  //   {k: "home"}                     at home until its own day has it home again
  function rec(r, ev, kind, a, segs){ return {r: r, ev: ev, kind: kind, a: a, segs: segs, ends: [], end: NaN}; }
  function segEnd(R, i, t0){
    if(R.ends[i] != null) return R.ends[i];
    var g = R.segs[i], e;
    if(g.k === "go") e = t0 + legDur(R.r, g.mode, g.from, g.to);
    else if(g.k === "slide") e = t0 + Math.abs(g.d1 - g.d0)/R.r.v*1000;
    else if(g.k === "home") e = homeBy(R.r, t0);
    else e = Math.max(t0, g.until);
    R.ends[i] = e;
    if(i === R.segs.length - 1) R.end = e;
    return e;
  }
  // -> {g, t0, t1} the segment at t, or null when t is outside the timeline
  function segAt(R, t){   // (ends worked out lazily up to t; R.end is NaN until the last one is)
    if(t < R.a || t >= R.end) return null;
    var t0 = R.a;
    for(var i = 0; i < R.segs.length; i++){
      var t1 = segEnd(R, i, t0);
      if(t < t1) return {g: R.segs[i], t0: t0, t1: t1};
      t0 = t1;
    }
    return null;
  }
  function outing(r, ev, kind, P, mode, dep, mid, back){   // home -> P (slide out to the spot), mid, slide back, P -> home, home
    var from = r.home;
    return rec(r, ev, kind, dep, [{k: "go", mode: mode, from: from, to: P}].concat(mid, [{k: "go", mode: mode, from: P, to: from}, {k: "home"}]));
  }

  // who joins an event (pure in the event and the seed), cached by event id. Anyone an earlier event of
  // the 12 h before would pick (its own pick, without this rule) is left out, so nobody is in two at once.
  var parts = {}, partKeys = [], raws = {}, rawKeys = [];
  function earlier(a, b){ return +a.start < +b.start || (+a.start === +b.start && String(a.id) < String(b.id)); }
  function rawOf(ev){
    var key = String(ev.id);
    if(!raws[key]){ var ids = {}; build(ev, {}).forEach(function(R){ ids[R.r.id] = 1; }); raws[key] = ids; rawKeys.push(key); if(rawKeys.length > EV_KEPT) delete raws[rawKeys.shift()]; }
    return raws[key];
  }
  function partsOf(ev){
    var key = String(ev.id);
    if(parts[key]) return parts[key];
    var excl = {};
    try {
      if(typeof city.events === "function") (city.events(+ev.start - EV_BACK, +ev.end) || []).forEach(function(o){
        if(!o || o.id == null || String(o.id) === key || !earlier(o, ev) || !(INCIDENT[o.kind] || CROWD[o.kind])) return;
        if(+o.end + (INCIDENT[o.kind] ? HOLD : EV_BACK) <= +ev.start) return;   // over before this one starts
        var ids = rawOf(o); for(var k in ids) excl[k] = 1;
      });
    } catch(err){ excl = {}; }
    var out = build(ev, excl), byId = {};
    out.forEach(function(R){ byId[R.r.id] = R; });
    parts[key] = {list: out, byId: byId};
    partKeys.push(key);
    if(partKeys.length > EV_KEPT) delete parts[partKeys.shift()];
    return parts[key];
  }
  function build(ev, excl){
    var P = evPlace(ev), S = loc(ev.start), En = loc(ev.end), W = En - S, out = [], used = {}, kind = String(ev.kind || "");
    var bells, ex = ev.x != null ? +ev.x : P.x, ez = ev.z != null ? +ev.z : P.z, sev = clamp(ev.severity | 0 || 1, 1, 3), tag = seed + ":ev:" + ev.id;
    if(!(W > 0)) return out;
    function H(r, n){ return frac(tag + ":" + r.id + ":" + n); }
    function sign(r){ return H(r, 9) < 0.5 ? -1 : 1; }
    function byHash(list){ return list.slice().sort(function(a, b){ return (H(a, 0) - H(b, 0)) || (a.id - b.id); }); }
    function nearby(R){ var L = [], seen = {}; placesNear(ex, ez, R).forEach(function(p){ homeOf[p.i].concat(workOf[p.i]).forEach(function(r){ if(!seen[r.id]){ seen[r.id] = 1; L.push(r); } }); }); return byHash(L); }
    function take(R){ used[R.r.id] = 1; if(!excl[R.r.id]) out.push(R); }   // left out, but its place is taken: a subset of the raw pick
    // crews first: the station's people on shift
    (Array.isArray(ev.units) ? ev.units : []).forEach(function(u, ui){
      var C = u && CREW[u.kind], st = u && u.station != null ? (placeIx["site:" + u.station] != null ? places[placeIx["site:" + u.station]] : (placeIx[String(u.station)] != null ? places[placeIx[String(u.station)]] : null)) : null;
      if(!C || !st) return;
      var d0 = loc(u.dispatch), ar = loc(u.arrive), lv = loc(u.leave), bk = loc(u.back);
      if(!(isFinite(d0) && d0 <= ar && ar <= lv && lv <= bk)) return;
      var n = 0;
      byHash(workOf[st.i]).forEach(function(r){
        if(n >= C.n || used[r.id] || !r.job || !C.jobs[r.job.job] || !free(r, d0 - 40000, bk + 60000, {work: 1})) return;
        n++;
        take(rec(r, ev, "crew", d0 - 40000, [
          {k: "stay", p: st, d: (H(r, 1 + ui) - 0.5)*10, until: d0 + 20000, anim: "idle"}, {k: "hide", until: ar + 10000},
          {k: "stay", p: P, d: sign(r)*(4 + 6*H(r, 2)), until: lv - 10000, anim: "idle"}, {k: "hide", until: bk},
          {k: "stay", p: st, d: (H(r, 3) - 0.5)*10, until: bk + 45000, anim: "idle"}]));
      });
    });
    // the patient: someone nearby, away from the street the whole time by its own day
    if(kind === "medical"){
      var amb = (Array.isArray(ev.units) ? ev.units : []).filter(function(u){ return u && u.kind === "ambulance" && isFinite(loc(u.leave)); })[0];
      var pick = amb ? clamp(loc(amb.leave), S, En) : S + 0.6*W, here = ev.lot != null ? placeIx["lot:" + ev.lot] : (ev.site != null ? placeIx["site:" + ev.site] : null);
      var who = String(ev.who != null ? ev.who : ""), pr = here != null ? homeOf[here].concat(workOf[here]).sort(function(a, b){
        return (frac(tag + ":who:" + who + ":" + a.id) - frac(tag + ":who:" + who + ":" + b.id)) || (a.id - b.id); }) : [];
      pr = pr.concat(nearby(PATIENT_R));   // the lot's (or the workplace's) people first, picked by ev.who
      for(var i = 0; i < pr.length; i++){
        var r = pr[i];
        if(used[r.id] || !free(r, S - MIN, En + MIN, {home: 1, work: 1})) continue;
        take(rec(r, ev, "patient", S, [{k: "lie", p: P, d: (H(r, 4) - 0.5)*8, until: pick}, {k: "hide", until: En}]));
        break;
      }
    }
    // onlookers
    if(INCIDENT[kind] && W >= 6*MIN){
      var gn = 3 + 3*sev, gl = nearby(GAWK_R);
      for(var j = 0; j < gl.length && gn > 0; j++){
        var g = gl[j]; if(used[g.id]) continue;
        var dep = S + Math.round((30 + 120*H(g, 5))*1000), leave = En - Math.round((0.05 + 0.25*H(g, 6))*W);
        var s0 = stateOf(g, dep); if(!s0.place || s0.place === P) continue;
        var walk = walkDur(g, s0.place, P), d = sign(g)*(10 + 18*H(g, 7));
        if(leave - dep - walk < 3*MIN || free(g, dep, leave + walk*STRETCH + 60000) !== s0.place) continue;
        gn--;
        take(rec(g, ev, "gawk", dep, [{k: "go", mode: "walk", from: s0.place, to: P}, {k: "slide", p: P, d0: 0, d1: d},
          {k: "stay", p: P, d: d, until: leave, anim: "idle"}, {k: "slide", p: P, d0: d, d1: 0}, {k: "go", mode: "walk", from: P, to: s0.place}]));
      }
    }
    // home-based crowds: from home when at home, back home after
    function crowd(list, share, max, plan){
      var L = list.filter(function(r){ return r.home && H(r, 0) < share; });
      byHash(L).slice(0, max).forEach(function(r){
        if(used[r.id]) return;
        var R = plan(r); if(!R || stateOf(r, R.a).state !== "home") return;
        take(R);
      });
    }
    function modeTo(r){ return dist(r.home, P) <= OUT_WALK ? "walk" : "car"; }
    function planned(r, mode){ return mode === "car" ? carDur(r.home, P) : walkDur(r, r.home, P); }
    if(kind === "match"){   // kick-off at ev.kick (else the start), 2 h (else to the end)
      var kick = ev.kick != null ? loc(ev.kick) : S, final = ev.kick != null ? kick + 2*HOUR : En;
      crowd(residents, FAN_SHARE, FAN_MAX, function(r){
        var mode = modeTo(r), d = (H(r, 1) - 0.5)*140, dep = kick - Math.round((10 + 35*H(r, 2))*MIN) - planned(r, mode), exit = final + Math.round(8*H(r, 3)*MIN);
        return outing(r, ev, "fan", P, mode, dep, [{k: "slide", p: P, d0: 0, d1: d}, {k: "stay", p: P, d: d, until: kick - Math.round((1 + 3*H(r, 4))*MIN), anim: "cheer"},
          {k: "slide", p: P, d0: d, d1: 0}, {k: "hide", until: exit}, {k: "stay", p: P, d: 0, until: exit + Math.round((2 + 4*H(r, 5))*MIN), anim: "cheer"}]);
      });
    } else if(kind === "school" && schools.length && (bells = schoolDay(ev))){
      var bellIn = bells[0], out_ = bells[1];
      crowd(residents.filter(function(r){ return !r.job && r.home && nearest(schools, r.home) === P && dist(r.home, P) <= PUPIL_R; }), PUPIL_SHARE, PUPIL_MAX, function(r){
        var d = (H(r, 1) - 0.5)*30, dep = bellIn - Math.round((3 + 17*H(r, 2))*MIN) - walkDur(r, r.home, P), bye = out_ + Math.round(5*H(r, 3)*MIN);
        return outing(r, ev, "pupil", P, "walk", dep, [{k: "slide", p: P, d0: 0, d1: d}, {k: "stay", p: P, d: d, until: bellIn, anim: "idle"},
          {k: "slide", p: P, d0: d, d1: 0}, {k: "hide", until: bye}, {k: "stay", p: P, d: 0, until: bye + Math.round((2 + 6*H(r, 4))*MIN), anim: "idle"}]);
      });
    } else if(kind === "market"){
      crowd(residents.filter(function(r){ return r.home && dist(r.home, P) <= SHOP_R; }), SHOP_SHARE, SHOP_MAX, function(r){
        var d = (H(r, 1) - 0.5)*60, dep = S + Math.round(H(r, 2)*Math.max(0, W - HOUR));
        return outing(r, ev, "shopper", P, "walk", dep, [{k: "slide", p: P, d0: 0, d1: d},
          {k: "stay", p: P, d: d, until: dep + walkDur(r, r.home, P) + Math.round((20 + 30*H(r, 3))*MIN), anim: "idle"}, {k: "slide", p: P, d0: d, d1: 0}]);
      });
    } else if(kind === "festival"){
      crowd(residents, FEST_SHARE, FEST_MAX, function(r){
        var mode = modeTo(r), d = (H(r, 1) - 0.5)*80, dep = S + Math.round(H(r, 2)*Math.min(30*MIN, W/3)) - planned(r, mode);
        return outing(r, ev, "festival", P, mode, dep, [{k: "slide", p: P, d0: 0, d1: d},
          {k: "stay", p: P, d: d, until: En - Math.round(H(r, 3)*Math.min(20*MIN, W/4)), anim: "cheer"}, {k: "slide", p: P, d0: d, d1: 0}]);
      });
    }
    return out;
  }
  // a school event's day on the local clock: [bell in, out of school], or null for the afternoon run (its
  // morning run, the same school's earlier event within 10 h, has the pupils). Bells from ev.bell (else the start);
  // the day ends at the next run's bell, else at the event's end (a 3-10 h event), else 7 h after the bell.
  function schoolDay(ev){
    var sib = [];
    try { if(typeof city.events === "function") sib = (city.events(+ev.start - 10*HOUR, +ev.end + 10*HOUR) || []).filter(function(o){
      return o && o.kind === "school" && String(o.id) !== String(ev.id) && String(o.site) === String(ev.site); }); } catch(err){ sib = []; }
    if(sib.some(function(o){ return +o.start < +ev.start; })) return null;
    var bell = ev.bell != null ? +ev.bell : +ev.start, W = +ev.end - +ev.start;
    var next = sib.filter(function(o){ return +o.start > +ev.start; }).sort(function(a, b){ return +a.start - +b.start; })[0];
    var out = next ? (next.bell != null ? +next.bell : +next.start) : (W >= 3*HOUR && W <= 10*HOUR ? +ev.end : bell + 7*HOUR);
    return [loc(bell), loc(out)];
  }

  // the timelines that hold residents at local t: {id: {R, s (segAt)}}; the earliest event wins
  function claims(t){
    var out = {}; if(!city) return out;
    eventsNear(t - tzMs).forEach(function(ev){
      partsOf(ev).list.forEach(function(R){
        if(out[R.r.id] || t < R.a || t >= R.end) return;
        var s = segAt(R, t); if(s) out[R.r.id] = {R: R, s: s};
      });
    });
    return out;
  }

  // the walk spot d m along the sidewalk from p's spot into o (on along straight joins; at a corner or a change of
  // road it folds back, so the spot moves smoothly with d), facing
  // (fx, fz); lat moves it across the sidewalk. -> false when p has no sidewalk
  function spotAt(p, d, o, fx, fz, lat){
    var A = att(p, "walk"); if(!A) return false;
    var e = E[A.ei], s = A.s, dir = d >= 0 ? 1 : -1, left = Math.abs(d), side = A.side;
    for(var guard = 0; guard < 12; guard++){
      var room = dir > 0 ? e.len - s : s;
      if(left <= room){ s += dir*left; break; }
      left -= room;
      var n = dir > 0 ? e.b : e.a, G = GR.walk, best = -1, bd = -Infinity;
      var hx = dir > 0 ? e.x[e.m-1] - e.x[e.m-2] : e.x[0] - e.x[1], hz = dir > 0 ? e.z[e.m-1] - e.z[e.m-2] : e.z[0] - e.z[1];
      for(var j = G.start[n]; j < G.start[n + 1]; j++){
        var e2 = E[G.ed[j]]; if(e2 === e) continue;
        var f2 = e2.a === n, qx = f2 ? e2.x[1] - e2.x[0] : e2.x[e2.m-2] - e2.x[e2.m-1], qz = f2 ? e2.z[1] - e2.z[0] : e2.z[e2.m-2] - e2.z[e2.m-1];
        var dot = (hx*qx + hz*qz)/((Math.sqrt(hx*hx + hz*hz)*Math.sqrt(qx*qx + qz*qz)) || 1);
        if(dot > bd + 1e-9){ bd = dot; best = G.ed[j]; }
      }
      var en = best >= 0 ? E[best] : null;
      if(!en || bd < 0.94 || Math.abs(en.off - e.off) > 0.5){ s = dir > 0 ? e.len : 0; dir = -dir; continue; }   // a corner: turn back
      var dir2 = en.a === n ? 1 : -1;
      side = side*dir*dir2; e = en; dir = dir2; s = dir2 > 0 ? 0 : e.len;
    }
    s = clamp(s, 0, e.len);
    var k = 0; while(k < e.m - 2 && e.cum[k + 1] < s) k++;
    var l = e.cum[k + 1] - e.cum[k], t = l > 0 ? (s - e.cum[k])/l : 0, o2 = side*(e.off + (lat || 0));
    var nx = e.nx[k] + (e.nx[k+1] - e.nx[k])*t, nz = e.nz[k] + (e.nz[k+1] - e.nz[k])*t;
    o.x = e.x[k] + (e.x[k+1] - e.x[k])*t + nx*o2; o.y = e.y[k] + (e.y[k+1] - e.y[k])*t + SIDEWALK_UP; o.z = e.z[k] + (e.z[k+1] - e.z[k])*t + nz*o2;
    o.yaw = Math.atan2(fx - o.x, fz - o.z);
    return true;
  }
  // a claimed resident's row at t into o -> {anim, mode, speed} | null (away)
  var o2 = {x: 0, y: 0, z: 0, yaw: 0};
  function claimRow(c, t, o){
    var R = c.R, g = c.s && c.s.g, r = R.r; if(!g) return null;
    var f = c.s.t1 > c.s.t0 ? (t - c.s.t0)/(c.s.t1 - c.s.t0) : 1, tx = R.ev.x != null ? +R.ev.x : 0, tz = R.ev.z != null ? +R.ev.z : 0;
    var lat = 0;
    if(g.k === "go"){
      var P = routeOf(g.mode, g.from, g.to); if(!P) return null;
      along(P, f*P.len, o);
      return {anim: g.mode === "car" ? "drive" : "walk", mode: g.mode, speed: P.len/((c.s.t1 - c.s.t0)/1000)};
    }
    if(g.k === "hide" || g.k === "home") return null;
    var p = g.p, fx = p.kind === "event" ? tx : p.x, fz = p.kind === "event" ? tz : p.z;
    if(g.k === "slide"){
      var d = g.d0 + (g.d1 - g.d0)*f, dn = d + (g.d1 >= g.d0 ? 0.5 : -0.5);
      if(!spotAt(p, dn, o2, 0, 0, 0) || !spotAt(p, d, o, 0, 0, 0)) return null;
      o.yaw = Math.atan2(o2.x - o.x, o2.z - o.z);
      return {anim: "walk", mode: "walk", speed: r.v};
    }
    if(R.kind === "fan" || R.kind === "festival" || R.kind === "shopper"){   // crowds: across the sidewalk too
      var E0 = att(p, "walk"), wk = E0 ? Math.max(0, E[E0.ei].off - SIDE_IN*0.5) : 0;
      lat = (frac(seed + ":lat:" + r.id) - 0.5)*Math.min(2.4, wk);
    }
    if(!spotAt(p, g.d, o, fx, fz, lat)) return null;
    if(g.k === "lie"){ spotAt(p, g.d + 1, o2, 0, 0, 0); o.yaw = Math.atan2(o2.x - o.x, o2.z - o.z); return {anim: "lie", mode: "walk", speed: 0}; }
    return {anim: g.anim || "idle", mode: "walk", speed: 0};
  }

  // the visible residents within radius of c at local ms t, nearest first
  function rows(t, c, radius, scan){
    t = +t || 0; c = c || {}; radius = radius == null ? 150 : +radius;
    var cx = +c.x || 0, cz = +c.z || 0, r2 = radius*radius, out = [], o = {x: 0, y: 0, z: 0, yaw: 0}, cl = claims(t);
    function push(id, row){
      if(!row) return;
      var dx = o.x - cx, dz = o.z - cz, d2 = dx*dx + dz*dz;
      if(d2 <= r2) out.push({id: id, x: o.x, y: o.y, z: o.z, yaw: o.yaw, anim: row.anim, mode: row.mode, speed: row.speed, d2: d2});
    }
    function one(i){ if(!cl[i]) push(i, baseRow(residents[i], t, o)); }
    if(scan){ for(var i = 0; i < residents.length; i++) one(i); stats.cand = residents.length; }
    else stats.cand = candidates(t, cx, cz, radius, one);
    var ids = Object.keys(cl); stats.claimed = ids.length;
    ids.forEach(function(k){ push(+k, claimRow(cl[k], t, o)); });
    out.sort(function(a, b){ return a.d2 - b.d2 || a.id - b.id; });
    return out;
  }
  sim.at = function(t, c, radius){ return rows(t, c, radius, false); };
  sim.atScan = function(t, c, radius){ return rows(t, c, radius, true); };   // everyone asked: at()'s reference, for the tests
  // the residents an event holds right now (local t): [{id, kind}] (kind: gawk, patient, crew, fan, pupil, shopper, festival)
  sim.joined = function(t, evId){
    var cl = claims(+t || 0), out = [];
    Object.keys(cl).forEach(function(k){ if(evId == null || String(cl[k].R.ev.id) === String(evId)) out.push({id: +k, kind: cl[k].R.kind, ev: cl[k].R.ev.id}); });
    return out.sort(function(a, b){ return a.id - b.id; });
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
    var news = city ? cityLine(r, +t || 0) : "";
    if(news) return news;
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
  // a line about the city's events: the resident's own part in one, else (half the time) the news around
  function cityLine(r, t){
    var u = t - tzMs, g = rng(mix(hash32(seed + ":news:" + r.id + ":" + Math.floor(t/(10*MIN)))));
    function pick(a){ return a[Math.floor(g()*a.length)]; }
    var c = claims(t)[r.id];
    if(c) return joinLine(c.R, u, pick);
    if(g() >= 0.5) return "";
    var lines = [];
    eventsNear(u).forEach(function(ev){ var l = newsLine(ev, u, pick); if(l) lines.push(l); });
    return lines.length ? pick(lines) : "";
  }
  return sim;
}
// plain text from an event's street (no markup characters), "" without one
function clean(s){ return typeof s === "string" || typeof s === "number" ? String(s).replace(/[<>&"\u0000-\u001f]/g, "").trim().slice(0, 48) : ""; }
function onStreet(ev){ var s = clean(ev.street); return s ? "on " + s : "nearby"; }
function joinLine(R, u, pick){
  var ev = R.ev, W = onStreet(ev), k = String(ev.kind), before = u < +ev.start, after = u >= +ev.end;
  if(R.kind === "patient") return pick(["Ooh... I'll be alright. The ambulance is on its way.", "Just a dizzy spell. The paramedics are coming."]);
  if(R.kind === "crew"){
    var j = R.r.job ? R.r.job.job : "";
    if(j === "firefighter") return pick(["We've got a call! Mind out!", "Engines rolling! Stand clear."]);
    if(j === "officer") return pick(["Duty calls. Stand clear, please.", "All units responding."]);
    return pick(["Emergency call! Excuse me!", "The ambulance is ready to roll."]);
  }
  if(R.kind === "gawk"){
    if(k === "fire") return pick(["Stand back, there's a fire " + W + "!", "I saw the smoke from my window. Hope everyone's out."]);
    if(k === "crash") return pick(["Two cars collided " + W + ". Nobody hurt, I think.", "What a mess " + W + ". The tow truck's coming."]);
    if(k === "crime") return pick(["The alarm went off " + W + "! The robbers ran for it.", "Police everywhere " + W + "!"]);
    return pick(["Someone collapsed " + W + ". The ambulance is coming.", "Give them some room, the paramedics are on their way."]);
  }
  if(R.kind === "fan") return after ? pick(["What a game!", "Did you see that last goal?"]) : pick(["Big match tonight!", "I've had this ticket for weeks!", "Can you hear the crowd already?"]);
  if(R.kind === "pupil") return before ? pick(["Can't be late for the bell!", "We've got a spelling test today."]) : pick(["School's out!", "So much homework..."]);
  if(R.kind === "shopper") return pick(["Market day! The stalls are packed.", "Fresh bread and flowers, lovely."]);
  return pick(["What a crowd tonight!", "Best night of the week, this."]);
}
// a resident's news line about an event at UTC u, "" when there is nothing to say
function newsLine(ev, u, pick){
  var S = +ev.start, En = +ev.end, W = onStreet(ev), k = String(ev.kind);
  if(INCIDENT[k]){
    if(u < S || u > En + 2*HOUR) return "";
    var on = u <= En;
    if(k === "fire") return on ? "There's smoke " + W + ". The engines are on their way." : "Did you see the fire " + W + "? The engines were quick.";
    if(k === "crime") return on ? "Sirens everywhere! Robbers made a run for it " + W + "." : "They caught the robbers " + W + "!";
    if(k === "crash") return on ? "There's been a crash " + W + ". Traffic's backed up." : "There was a crash " + W + " earlier. Mind how you go.";
    return on ? "An ambulance just went by " + W + ". Hope they're alright." : "Someone was taken to hospital from " + W + " earlier.";
  }
  if(k === "match"){
    if(ev.kick != null) S = +ev.kick;
    if(u < S && S - u < 10*HOUR) return "Big match today! Kick-off in " + Math.max(1, Math.round((S - u)/HOUR)) + (S - u < 1.5*HOUR ? " hour." : " hours.");
    if(u >= S && u < En) return "The match is on! Listen to that crowd.";
    if(u >= En && u - En < 3*HOUR) return "What a game at the stadium tonight!";
    return "";
  }
  if(k === "market") return u >= S && u < En ? "Market day! Fresh bread at the stalls." : (u < S && S - u < 3*HOUR ? "The market's on later. I need some veg." : "");
  if(k === "school") return u >= S - HOUR && u < S + HOUR ? "The kids are off to school." : "";
  if(k === "festival") return u < En && S - u < 3*HOUR ? "Fireworks at the park tonight!" : "";
  return "";
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
