/* Claude HQ 3.15: the metro in real tunnels (HQV.hqMetro). docs/plans/transport-revamp.md 3.3, 3.6, 3.14, 5.3, 5.4, 5.7.
 *
 * The @3 doc carries layers.metro (cm): two lines (M1 red, M2 blue) crossing at Central, laid under the streets,
 * surfacing at one end through a cut-and-cover portal into an open-air depot; the other end is a tunnel terminus
 * with a headshunt. Read through HQV.world.metroOf(W) (metres) when the world client has it, else layers.metro is
 * converted here (W.metro, W.layers.metro or a raw doc's layers.metro, all cm).
 *
 * The top half is pure (no THREE, no DOM; tests/test_hqmetro.py runs it under node):
 *   create(W, {tier, seed}) -> sim, a Service (plan 5.3, mode "metro"):
 *     lines(), stops(), stopsNear(x, z, r), departures(stopId, ms, n), trip(lineId, from, to, ms), vehicles(ms)
 *     plus layout() (the underground's walkable floors, see below), lineData(id), runs(id), trackAt(lineId, s, dir),
 *     depotTrains() (trains standing in the depots) and segmentsNear(x, z, r) (the tunnel chunks within r m).
 *   Timetable: a train every HEADWAY s each way, DWELL s at every station, VMAX top speed and ACC either way along
 *   the path (horizontal metres). The "out" run leaves the depot (the open end), calls at every station and runs on
 *   into the headshunt past the tunnel terminus, stands REV s there and comes back as the "back" run, which calls at
 *   every station and runs into the depot. Every departure is a pure function of (world seed, line, UTC ms).
 *   Tracks: each direction on the right of travel, TRACK m off the path (the path is the twin track's centre).
 *   Platforms: side platforms are outside the tracks (on the right of travel), an island platform between them.
 *   A vehicle's (x, y, z) is the train's middle on its track at rail level; Trip.pose is the floor centre
 *   (FLOOR m above the rail). under: the train's middle is on a bored or cut-and-cover segment.
 *   Seats: SEATS (car-local: +x left, +z forward, y above the car floor): 16 longitudinal seats a car (8 a side,
 *   facing in), 4 cars; then STAND standing spots a car at the poles. Trip.seat(i, ms) -> {x, y, z, yaw, floor,
 *   stand, car}: y is the seat top (seated) or the floor (standing).
 *   layout(sim) / sim.layout(): halls, platforms, stairs, entrance stairs, passages as oriented floor rects:
 *     walkable(x, y, z) -> {y, kind, station} | null (the highest floor at most STEP_UP over y; null on the track,
 *     in a wall, or out of every station), isUnder(x, y, z), entranceAt(x, z, r), rampAt(x, z), stationAt(x, y, z),
 *     exitTo(stationId, x?, z?) -> {x, y, z, yaw} (the street side of the nearest entrance).
 *     [transit pass] each station's gate lines across the hall (S.gates [{u, e}]: past every entrance's foot and every
 *     entrance stair hanging below the ceiling, 3 m short of every stair head; S.paid per end the paid stretch), its 8
 *     lanes, a bank of 4 ticket machines by each way in, and a short line across any stair head left on the street side
 *     (S.heads); gateAt(x, y, z) -> {station, e, lane (-1: cabinet or glass), u, v} | null; paidAt(x, y, z) -> true
 *     beyond the gates (and on the stairs and platforms), false on the street side, null outside.
 *     [stations] the rooms below the street (S.rooms: the hall, passages, platform rooms, the stairs' closed tubes, the
 *     entrance stairs): roomAt / camInside(x, y, z, m) (inside one, m clear of its walls), camHit(from, to) (how far a
 *     camera may go: inside the rooms, never through a stair's walls, floor or ceiling), ceilAt(x, y, z); stepBlocked(ax,
 *     az, bx, bz, y) (a stair is walked on and off at its ends only, never under its low end); the hall's floor is open
 *     over each stair's well (overWell).
 *   sim.doorsOf(v) (a standing train's open doors), sim.runOf(v) ({key, last, lastName}), sim.platNo(stop, line, run)
 *   and sim.streetNear(x, z); station names: "Central" for the most-lined, else the nearest road ("Birch Street"), a
 *   landmark's word ("Airport") when one is beside it (stationNames(W) shares them with the City Line).
 *
 * The bottom half draws it (needs THREE through hq3d's ctx): view(c, sim, opts) -> V (plan 5.4 + 5.7).
 * Never Math.random: everything seeded from the world id. Calm and reduced motion: doors, gates and screen doors
 * snap instead of sliding; nothing in the underground flickers or sways, ever.
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : self;
var HQV = root.HQV = root.HQV || {};

var PI = Math.PI;
var HEADWAY = 120, DWELL = 25, VMAX = 22, ACC = 1.1, REV = 40;
var CARS = 4, CAR_L = 19, CAR_GAP = 0.8, PITCH = CAR_L + CAR_GAP, TRAIN_L = CARS*CAR_L + (CARS - 1)*CAR_GAP;
var TRACK = 3.5;          // m: each track's centre off the path (7 m between the two tracks)
var FLOOR = 1.1;          // m: a car's floor and a platform's top over the rail head
var CAR_W = 2.8, CAR_HW = 1.4;
var END_GAP = 3;          // m: a train's end stops this short of the path's end
var STEP_UP = 0.75;       // m: walkable() finds floors up to this much above your feet
var HALL_HL = 20;         // m: a ticket hall's half length along the station
var GATE_U = 10;          // m: the gate lines across the hall, either side of the middle
var STAIR_U = 17;         // m: where the platform stairs leave the hall floor (along the station axis)
var GATE_N = 8, GATE_BAND = 0.45, LANE_HW = 0.4;   // [transit pass] lanes a gate line, the barrier's half depth, a lane's half width ([stations] 0.4: easy to walk through)
var STAIR_SLOPE = 0.6;    // rise per metre of the stairs (about 31 degrees)
var HALL_H = 3.6, PASS_H = 3.0, PLAT_H = 4.5;   // [stations] ceiling heights over the hall, a passage and a platform's floor
var TUBE_H = 3.2;         // m: a stair's closed tube, floor to ceiling, below the hall
var WELL_L = TUBE_H/STAIR_SLOPE;   // m: the open well at a stair's head (where its tube's ceiling meets the hall's floor)
var CAM_M = 0.3;          // m: the camera keeps this far inside a station's walls, floors and ceilings
var CHUNK = 50;           // m: tunnel LOD chunks
var LOD_R = 400;          // m: tunnel within this of the camera is built
var UNDER_KINDS = {bored: 1, cutcover: 1};
var LINE_STYLE = {M1: {color: "#d23a32", name: "Red line"}, M2: {color: "#2f6fd6", name: "Blue line"}, M3: {color: "#2fa36b", name: "Green line"},
                  M4: {color: "#e0a020", name: "Yellow line"}};
var SUFFIX = ["Street", "Square", "Gate", "Park"];

// car-local seats: 8 a side, in two benches of four between the doors (doors at z = -6.3, 0, 6.3)
var DOORS_Z = [-6.3, 0, 6.3], DOOR_W = 1.4;
var SEATS = [], STAND = [];
(function(){
  [1, -1].forEach(function(side){
    [-4.05, -3.45, -2.85, -2.25, 2.25, 2.85, 3.45, 4.05].forEach(function(z){
      SEATS.push({x: side*1.12, y: 0.45, z: z, yaw: side > 0 ? -PI/2 : PI/2});
    });
  });
  [[0.45, -6.3], [-0.45, -6.3], [0.45, 0], [-0.45, 0], [0.45, 6.3], [-0.45, 6.3], [0.3, -8.4], [-0.3, 8.4]].forEach(function(p, i){
    STAND.push({x: p[0], y: 0, z: p[1], yaw: i % 2 ? -PI/2 : PI/2});
  });
})();
var SEATS_CAR = SEATS.length, STAND_CAR = STAND.length;

/* ------------------------------------------------------------------------------------------- helpers */
function hash32(s){ var h = 2166136261 >>> 0; s = String(s); for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function mulberry32(a){ a = a >>> 0 || 1; return function(){ a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0)/4294967296; }; }
function fin(v, d){ v = +v; return isFinite(v) ? v : d; }
function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function hyp(x, z){ return Math.sqrt(x*x + z*z); }
function wrapA(a){ while(a > PI) a -= 2*PI; while(a < -PI) a += 2*PI; return a; }
function own(o, k){ return o != null && Object.prototype.hasOwnProperty.call(o, k); }

// a point [x, y, z] | {x, y, z} -> {x, y, z} (scaled)
function pt3(a, k){
  if(!a) return null;
  if(Array.isArray(a)) return a.length >= 3 ? {x: fin(a[0], 0)*k, y: fin(a[1], 0)*k, z: fin(a[2], 0)*k} : {x: fin(a[0], 0)*k, y: 0, z: fin(a[1], 0)*k};
  return {x: fin(a.x, 0)*k, y: fin(a.y, 0)*k, z: fin(a.z, 0)*k};
}
// a polygon [[x, z], ...] | [x, z, x, z, ...] | [{x, z}] -> [[x, z], ...] (scaled)
function poly2(a, k){
  var out = [], i;
  if(!Array.isArray(a) || !a.length) return out;
  if(typeof a[0] === "number"){ for(i = 0; i + 1 < a.length; i += 2) out.push([fin(a[i], 0)*k, fin(a[i + 1], 0)*k]); return out; }
  for(i = 0; i < a.length; i++){ var p = a[i]; if(Array.isArray(p)) out.push([fin(p[0], 0)*k, fin(p[p.length >= 3 ? 2 : 1], 0)*k]); else if(p) out.push([fin(p.x, 0)*k, fin(p.z, 0)*k]); }
  return out;
}
// a heading from {yaw} or a [fx, fz] vector (Q16 or unit): yaw 0 faces +z
function yawOf(o, key){
  if(!o) return 0;
  if(isFinite(+o.yaw) && o.yaw !== null) return +o.yaw;
  var f = o[key || "front"];
  if(Array.isArray(f) && f.length >= 2 && (f[0] || f[1])) return Math.atan2(+f[0] || 0, +f[1] || 0);
  if(f && typeof f === "object" && (f.x || f.z)) return Math.atan2(+f.x || 0, +f.z || 0);
  return 0;
}
function linesText(ls){
  ls = (ls || []).slice();
  if(ls.length <= 1) return ls.join("");
  return ls.slice(0, -1).join(", ") + " and " + ls[ls.length - 1];
}
function srgbLin(c){ return c <= 0.04045 ? c/12.92 : Math.pow((c + 0.055)/1.055, 2.4); }
function rgb(hex){ return [srgbLin(((hex >> 16) & 255)/255), srgbLin(((hex >> 8) & 255)/255), srgbLin((hex & 255)/255)]; }
function hexNum(s, d){ return typeof s === "string" && /^#[0-9a-fA-F]{6}$/.test(s) ? parseInt(s.slice(1), 16) : d; }

/* --------------------------------------------------------------------------------- reading the layer */
function rawOf(W){
  if(!W) return null;
  var WD = HQV.world;
  if(WD && typeof WD.metroOf === "function"){ try { var m = WD.metroOf(W); if(m && m.lines) return {m: m, k: 1}; } catch(e){} }
  var L = W.metro || (W.layers && W.layers.metro) || null;
  return L && L.lines ? {m: L, k: 0.01} : null;
}
function railRawOf(W){
  if(!W) return null;
  var WD = HQV.world;
  if(WD && typeof WD.railOf === "function"){ try { var m = WD.railOf(W); if(m && m.stations) return {m: m, k: 1}; } catch(e){} }
  var L = W.rail || (W.layers && W.layers.rail) || null;
  return L && L.stations ? {m: L, k: 0.01} : null;
}

// One line's path: pts, cumulative horizontal s, kinds per segment.
function pathOf(raw, k){
  var pts = [], S = [0], i;
  (raw.path || []).forEach(function(a){ var p = pt3(a, k); if(!p) return; var q = pts[pts.length - 1]; if(q && hyp(p.x - q.x, p.z - q.z) < 1e-3) return; pts.push(p); });
  for(i = 1; i < pts.length; i++) S.push(S[i - 1] + hyp(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  var kinds = [], src = Array.isArray(raw.kinds) ? raw.kinds : [];
  for(i = 0; i < Math.max(0, pts.length - 1); i++){ var kd = String(src[Math.min(i, src.length - 1)] || "bored"); kinds.push(kd); }
  return {pts: pts, S: S, len: S[S.length - 1] || 0, kinds: kinds};
}
function segIdx(P, s){
  var lo = 0, hi = P.pts.length - 2;
  if(hi <= 0) return 0;
  if(s <= 0) return 0; if(s >= P.len) return hi;
  while(lo < hi){ var mid = (lo + hi + 1) >> 1; if(P.S[mid] <= s) lo = mid; else hi = mid - 1; }
  return lo;
}
// the path at s: centre point, heading (yaw of increasing s), pitch (rise per metre), segment and its kind
function pathAt(P, s){
  if(!P.pts.length) return {x: 0, y: 0, z: 0, yaw: 0, grade: 0, seg: 0, kind: "open"};
  if(P.pts.length === 1){ var p0 = P.pts[0]; return {x: p0.x, y: p0.y, z: p0.z, yaw: 0, grade: 0, seg: 0, kind: P.kinds[0] || "open"}; }
  var i = segIdx(P, s), a = P.pts[i], b = P.pts[i + 1], L = P.S[i + 1] - P.S[i] || 1, u = clamp((s - P.S[i])/L, s < 0 && i === 0 ? -1e9 : 0, s > P.len && i === P.pts.length - 2 ? 1e9 : 1);
  return {x: a.x + (b.x - a.x)*u, y: a.y + (b.y - a.y)*u, z: a.z + (b.z - a.z)*u, yaw: Math.atan2(b.x - a.x, b.z - a.z), grade: (b.y - a.y)/L, seg: i, kind: P.kinds[i]};
}
// the nearest point of the path to (x, z): {s, d, seg}
function nearestOn(P, x, z){
  var best = {s: 0, d: Infinity, seg: 0};
  for(var i = 0; i + 1 < P.pts.length; i++){
    var a = P.pts[i], b = P.pts[i + 1], dx = b.x - a.x, dz = b.z - a.z, L2 = dx*dx + dz*dz || 1;
    var u = clamp(((x - a.x)*dx + (z - a.z)*dz)/L2, 0, 1), px = a.x + dx*u, pz = a.z + dz*u, d = hyp(x - px, z - pz);
    if(d < best.d) best = {s: P.S[i] + u*(P.S[i + 1] - P.S[i]), d: d, seg: i};
  }
  return best;
}
// the point of a polyline [{x, y, z}] nearest p ({x, z}), dy m up: where a 78 m train sounds from (its part beside you)
function nearLine(line, p, dy){
  var px = +(p && p.x) || 0, pz = +(p && p.z) || 0, bd = Infinity, best = line && line[0] ? {x: line[0].x, y: line[0].y, z: line[0].z} : {x: px, y: 0, z: pz};
  for(var i = 0; line && i + 1 < line.length; i++){
    var a = line[i], b = line[i + 1], ex = b.x - a.x, ez = b.z - a.z, l2 = ex*ex + ez*ez;
    var u = l2 > 1e-9 ? clamp(((px - a.x)*ex + (pz - a.z)*ez)/l2, 0, 1) : 0, x = a.x + ex*u, z = a.z + ez*u, d = (px - x)*(px - x) + (pz - z)*(pz - z);
    if(d < bd){ bd = d; best = {x: x, y: a.y + (b.y - a.y)*u, z: z}; }
  }
  best.y += +dy || 0;
  return best;
}

function normalize(W, tier){
  var R = rawOf(W);
  if(!R) return null;
  var m = R.m, k = R.k, T = tier == null ? 5 : tier;
  var st = {}, stList = [], ents = [], ent = {}, portals = [], depots = [], dep = {}, holes = [];
  (m.stations || []).forEach(function(s, i){
    if(!s || s.id == null) return;
    var o = {id: String(s.id), x: fin(s.x, 0)*k, y: fin(s.y, 0)*k, z: fin(s.z, 0)*k, yaw: yawOf(s, "along"),
             len: fin(s.len, 9000)*k, platform: s.platform === "island" ? "island" : "side",
             lines: (s.lines || []).map(String), hallY: fin(s.hall_y != null ? s.hall_y : s.hallY, NaN)*k,
             entrances: (s.entrances || []).map(String), idx: i};
    if(!(o.len > 10)) o.len = 90;
    st[o.id] = o; stList.push(o);
  });
  (m.entrances || []).forEach(function(e){
    if(!e || e.id == null) return;
    var o = {id: String(e.id), station: String(e.station), x: fin(e.x, 0)*k, z: fin(e.z, 0)*k, y: fin(e.y, 0)*k, yaw: yawOf(e, "front"),
             w: Math.max(1.6, fin(e.w, 400)*k), d: Math.max(2, fin(e.d, 1000)*k), kind: e.kind === "lift" ? "lift" : e.kind === "escalator" ? "escalator" : "stairs",
             hole: poly2(e.hole, k)};
    // the record's point is the middle of its well (the hole is centred on it); the stairs start at the hole's back
    // edge, so the way down begins there (else half the hole shows the sea below and half the stairs are under grass)
    if(o.hole.length >= 3){
      var fx = Math.sin(o.yaw), fz = Math.cos(o.yaw), u0 = Infinity;
      o.hole.forEach(function(q){ u0 = Math.min(u0, (q[0] - o.x)*fx + (q[1] - o.z)*fz); });
      if(isFinite(u0) && u0 < 0){ o.x += fx*u0; o.z += fz*u0; }
    }
    ents.push(o); ent[o.id] = o;
  });
  (m.portals || []).forEach(function(p){
    if(!p) return;
    portals.push({id: String(p.id), line: String(p.line), x: fin(p.x, 0)*k, z: fin(p.z, 0)*k, y: fin(p.y, 0)*k, yaw: yawOf(p, "front"),
                  w: Math.max(8, fin(p.w, 1600)*k), len: Math.max(10, fin(p.len, 12000)*k), hole: poly2(p.hole, k)});
  });
  (m.depots || []).forEach(function(d){
    if(!d) return;
    var o = {id: String(d.id), line: String(d.line), poly: poly2(d.poly, k),
             tracks: (d.tracks || []).map(function(t){ return (t || []).map(function(a){ return pt3(a, k); }).filter(Boolean); }).filter(function(t){ return t.length >= 2; })};
    depots.push(o); dep[o.id] = o;
  });
  (m.holes || []).forEach(function(h){ var p = poly2(h, k); if(p.length >= 3) holes.push(p); });
  var lines = [];
  (m.lines || []).forEach(function(l){
    if(!l || l.id == null) return;
    if((l.tier | 0) > T) return;
    var P = pathOf(l, k);
    if(P.pts.length < 2 || P.len < 50) return;
    var id = String(l.id), sty = LINE_STYLE[id] || {color: ["#d23a32", "#2f6fd6", "#2fa36b", "#e0a020"][lines.length % 4], name: "Line " + id};
    var stops = [];
    (l.stations || []).forEach(function(sid){
      var s = st[String(sid)]; if(!s) return;
      var n = nearestOn(P, s.x, s.z), a = pathAt(P, n.s);
      stops.push({id: s.id, s: n.s, y: a.y, yaw: a.yaw});
    });
    stops.sort(function(a, b){ return a.s - b.s; });
    var openA = P.kinds[0] === "open" || P.kinds[0] === "portal", openB = P.kinds[P.kinds.length - 1] === "open" || P.kinds[P.kinds.length - 1] === "portal";
    var depotAtStart = openA || !openB;
    lines.push({id: id, short: id, name: sty.name, color: typeof l.color === "string" ? l.color : sty.color, P: P, stops: stops,
                depot: l.depot != null ? dep[String(l.depot)] || null : null, depotAtStart: depotAtStart, tier: l.tier | 0});
  });
  // per-line platform levels at every station (Central: M1 above M2)
  stList.forEach(function(s){
    s.at = {};
    lines.forEach(function(L){ L.stops.forEach(function(q){ if(q.id === s.id) s.at[L.id] = {s: q.s, rail: q.y, yaw: q.yaw}; }); });
    var ls = Object.keys(s.at);
    if(!s.lines.length) s.lines = ls.slice();
    s.lines = s.lines.filter(function(id){ return own(s.at, id); });
    var es = ents.filter(function(e){ return e.station === s.id; });
    s.street = es.length ? es.reduce(function(a, e){ return a + e.y; }, 0)/es.length : NaN;
    var top = -Infinity; ls.forEach(function(id){ top = Math.max(top, s.at[id].rail + FLOOR); });
    if(!isFinite(top)) top = s.y;
    if(!isFinite(s.hallY)) s.hallY = top + 5.5;
    if(!isFinite(s.street)) s.street = s.hallY + 6;
    s.hallY = Math.min(s.hallY, s.street - 3);
    s.entrances = es.map(function(e){ return e.id; });
    s.ents = es;
  });
  return {lines: lines, stations: stList, st: st, entrances: ents, ent: ent, portals: portals, depots: depots, holes: holes};
}

/* ------------------------------------------------------------------------------------- the timetable */
// a stop-to-stop run of d m from rest to rest: time, and position/speed t s in
function legTime(d){
  if(d <= 0) return 0;
  var dA = VMAX*VMAX/(2*ACC);
  return d >= 2*dA ? 2*VMAX/ACC + (d - 2*dA)/VMAX : 2*Math.sqrt(d/ACC);
}
function legAt(d, t){
  if(d <= 0) return {x: 0, v: 0};
  var T = legTime(d), dA = VMAX*VMAX/(2*ACC);
  t = clamp(t, 0, T);
  if(d >= 2*dA){
    var tA = VMAX/ACC;
    if(t < tA) return {x: 0.5*ACC*t*t, v: ACC*t};
    if(t < T - tA) return {x: dA + VMAX*(t - tA), v: VMAX};
    var r = T - t; return {x: d - 0.5*ACC*r*r, v: ACC*r};
  }
  var h = T/2;
  if(t < h) return {x: 0.5*ACC*t*t, v: ACC*t};
  var r2 = T - t; return {x: d - 0.5*ACC*r2*r2, v: ACC*r2};
}
// The two runs of a line: out (depot -> headshunt) and back (headshunt -> depot). Each is a list of segments
// {t0, t1, s0, s1, type: "move"|"dwell"|"hold", stop} in s (centre of the train along the path) from its start.
function makeRuns(L, seed){
  var P = L.P, half = TRAIN_L/2 + END_GAP;
  var a = Math.min(half, P.len/2), b = Math.max(P.len - half, P.len/2);
  var first = L.stops[0], last = L.stops[L.stops.length - 1];
  var depotS = L.depotAtStart ? a : b, headS = L.depotAtStart ? b : a;
  if(first && L.depotAtStart) headS = Math.max(headS, last.s); else if(first) headS = Math.min(headS, first.s);
  var ordered = L.depotAtStart ? L.stops.slice() : L.stops.slice().reverse();
  function build(from, list, to, hold, dir){
    var segs = [], t = 0, s = from;
    function moveTo(x){ var d = Math.abs(x - s); if(d < 1e-6) return; var T = legTime(d); segs.push({t0: t, t1: t + T, s0: s, s1: x, type: "move", stop: null}); t += T; s = x; }
    list.forEach(function(q){ moveTo(q.s); segs.push({t0: t, t1: t + DWELL, s0: s, s1: s, type: "dwell", stop: q.id}); t += DWELL; });
    moveTo(to);
    if(hold) { segs.push({t0: t, t1: t + hold, s0: s, s1: s, type: "hold", stop: null}); t += hold; }
    var ev = {};
    segs.forEach(function(g, i){ if(g.type === "dwell") ev[g.stop] = {arr: g.t0, dep: g.t1, i: i}; });
    var lastStop = list.length ? list[list.length - 1].id : null;
    return {segs: segs, T: t, dir: dir, ev: ev, order: list.map(function(q){ return q.id; }), last: lastStop, first: list.length ? list[0].id : null};
  }
  var outDir = L.depotAtStart ? 1 : -1;
  var out = build(depotS, ordered, headS, REV, outDir);
  var back = build(headS, ordered.slice().reverse(), depotS, 0, -outDir);
  var off = hash32(String(seed) + ":metro:" + L.id) % HEADWAY;
  out.off = off; back.off = (off + out.T) % HEADWAY;
  out.key = "o"; back.key = "b";
  out.line = back.line = L.id;
  return {out: out, back: back, depotS: depotS, headS: headS};
}
// where a run is tau s after it started: {s, v, seg, doors, stop, type}
function runAt(run, tau){
  var g = null, i;
  if(tau < 0) tau = 0;
  for(i = 0; i < run.segs.length; i++){ g = run.segs[i]; if(tau < g.t1) break; }
  if(!g) return {s: 0, v: 0, doors: 0, stop: null, type: "hold", seg: -1};
  if(tau >= g.t1){ return {s: g.s1, v: 0, doors: 0, stop: null, type: "end", seg: i}; }
  if(g.type === "move"){
    var d = Math.abs(g.s1 - g.s0), p = legAt(d, tau - g.t0), sg = g.s1 > g.s0 ? 1 : -1;
    return {s: g.s0 + sg*p.x, v: p.v, doors: 0, stop: null, type: "move", seg: i};
  }
  var a = tau - g.t0, b = g.t1 - tau, dr = g.type === "dwell" ? clamp(Math.min((a - 1.5)/1.5, (b - 3)/1.5), 0, 1) : 0;
  return {s: g.s0, v: 0, doors: dr, stop: g.stop, type: g.type, seg: i};
}

/* ------------------------------------------------------------------------------------- the service */
// [transit pass] Station names a rider can use: the station with the most lines (the nearest the middle on a tie) is
// "Central"; every other one is the bare name of the nearest named road ("Birch Street"), and where two stations would
// share it, the road and its nearest cross street ("Oak Street & Elm Road"), then a number. No seeded suffixes ("Birch
// Street Park 6" told you nothing). Pure and independent of the order asked; the City Line takes these for its stops
// beside a metro station (stationNames below).
function roadsNear(W, x, z, r){
  var by = {}, edges = (W && W.edges) || (W && W.layers && W.layers.roads && W.layers.roads.edges) || [];
  for(var i = 0; i < edges.length; i++){
    var e = edges[i], nm = e && e.name; if(!nm) continue;
    var p = e.pts || null, q = e.points || null, j, d;
    if(p) for(j = 0; j + 2 < p.length; j += 3){ d = hyp(p[j]/100 - x, p[j + 2]/100 - z); if(d < r && (by[nm] == null || d < by[nm])) by[nm] = d; }
    else if(q) for(j = 0; j < q.length; j++){ d = hyp(q[j][0]/100 - x, q[j][q[j].length >= 3 ? 2 : 1]/100 - z); if(d < r && (by[nm] == null || d < by[nm])) by[nm] = d; }
  }
  return Object.keys(by).map(function(n){ return {name: String(n), d: by[n]}; }).sort(function(a, b){ return a.d - b.d || (a.name < b.name ? -1 : 1); });
}
var SITE_WORD = {airport: "Airport", port: "Harbour", harbour: "Harbour", stadium: "Stadium", university: "University", hospital: "Hospital"}, SITE_R = 220;
function nameStations(W, D, seed){
  var used = {}, names = {}, list = D.stations.slice(), hub = null;
  list.forEach(function(s){ if(s.lines.length >= 2 && (!hub || s.lines.length > hub.lines.length || s.lines.length === hub.lines.length && hyp(s.x, s.z) < hyp(hub.x, hub.z))) hub = s; });
  if(hub){ names[hub.id] = "Central"; used.Central = 1; }
  // the most-lined first, then by id: an interchange gets the plain road name before a quiet stop does
  list.sort(function(a, b){ return b.lines.length - a.lines.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
  // a station at a landmark is named for it ("Airport", "Harbour"): the nearest such station within SITE_R m of it
  var sites = ((W && W.sites) || []).filter(function(q){ return q && SITE_WORD[q.kind]; });
  sites.slice().sort(function(a, b){ return String(a.id) < String(b.id) ? -1 : 1; }).forEach(function(q){
    var w = SITE_WORD[q.kind], qx = fin(q.x, 0)/100, qz = fin(q.z, 0)/100, b = null, bd = SITE_R;
    if(used[w]) return;
    list.forEach(function(s){ var d = hyp(s.x - qx, s.z - qz); if(!names[s.id] && s.lines.length && d < bd){ bd = d; b = s; } });
    if(b){ names[b.id] = w; used[w] = 1; }
  });
  list.forEach(function(s, i){
    if(names[s.id]) return;
    var near = roadsNear(W, s.x, s.z, 260), nm = null, k;
    for(k = 0; k < near.length && !nm; k++) if(!used[near[k].name] && near[k].name !== "Central") nm = near[k].name;
    if(!nm && near.length >= 2) for(k = 1; k < near.length && !nm; k++){ var two = near[0].name + " & " + near[k].name; if(!used[two]) nm = two; }
    if(!nm && HQV.hqRide && typeof HQV.hqRide.stationName === "function") try { nm = HQV.hqRide.stationName(W, s.x, s.z, "metro"); } catch(e){ nm = null; }
    if(!nm) nm = "Station " + (D.stations.indexOf(s) + 1);
    nm = String(nm);
    if(used[nm]){ var base = nm, n = 2; while(used[base + " " + n]) n++; nm = base + " " + n; }
    used[nm] = 1; names[s.id] = nm;
  });
  return names;
}
// the metro's station names for a world (memoised per world object): {stationId: name} and near(x, z, r) -> name | null
var NAMES_MEMO = typeof WeakMap === "function" ? new WeakMap() : null;
function stationNames(W){
  if(!W) return null;
  var m = NAMES_MEMO && NAMES_MEMO.get(W);
  if(m) return m;
  var D = normalize(W, 5); if(!D) return null;
  var names = nameStations(W, D, ""), pts = D.stations.filter(function(s){ return s.lines.length; }).map(function(s){ return {id: s.id, x: s.x, z: s.z, name: names[s.id]}; });
  m = {names: names, near: function(x, z, r){ var b = null, bd = r == null ? 150 : +r; pts.forEach(function(p){ var d = hyp(p.x - x, p.z - z); if(d < bd){ bd = d; b = p; } }); return b ? b.name : null; }};
  if(NAMES_MEMO) NAMES_MEMO.set(W, m);
  return m;
}

function create(W, o){
  o = o || {};
  var seed = String(o.seed != null ? o.seed : (W && (W.seed || W.id)) || "metro");
  var D = normalize(W, o.tier) || {lines: [], stations: [], st: {}, entrances: [], ent: {}, portals: [], depots: [], holes: []};
  var names = nameStations(W, D, seed);
  var RUNS = {}, LBY = {};
  D.lines.forEach(function(L){ RUNS[L.id] = makeRuns(L, seed); LBY[L.id] = L; });
  var stopList = D.stations.filter(function(s){ return s.lines.length; }).map(function(s){
    var top = -Infinity; s.lines.forEach(function(id){ top = Math.max(top, s.at[id].rail + FLOOR); });
    return {id: s.id, name: names[s.id], x: s.x, y: isFinite(top) ? top : s.y, z: s.z, mode: "metro", lines: s.lines.slice(), kind: "station", under: true};
  });
  var STOP = {}; stopList.forEach(function(s){ STOP[s.id] = s; });
  var platNo = {};
  D.stations.forEach(function(s){ s.lines.slice().sort().forEach(function(id, li){ platNo[s.id + "|" + id + "|o"] = String(2*li + 1); platNo[s.id + "|" + id + "|b"] = String(2*li + 2); }); });

  function trackAt(lineId, s, dir){
    var L = LBY[lineId]; if(!L) return null;
    var a = pathAt(L.P, s), d = dir < 0 ? -1 : 1, off = -d*TRACK;
    return {x: a.x + off*Math.cos(a.yaw), y: a.y, z: a.z - off*Math.sin(a.yaw), yaw: d > 0 ? a.yaw : wrapA(a.yaw + PI), pitch: Math.atan(a.grade*d),
            kind: a.kind, under: !!UNDER_KINDS[a.kind], s: s};
  }
  function loadOf(lineId, vid, ms){
    if(HQV.hqCommute && typeof HQV.hqCommute.load === "function") try { var v = +HQV.hqCommute.load("metro", lineId, vid, ms, seed); if(isFinite(v)) return clamp(v, 0, 1.15); } catch(e){}
    var h = ((ms/3600000) % 24 + 24) % 24, base = h >= 7.5 && h < 9.5 || h >= 17 && h < 19 ? 1.1 : h >= 6 && h < 22 ? 0.45 : 0.08;
    return clamp(base*(0.85 + 0.3*mulberry32(hash32(seed + vid))()), 0, 1.15);
  }
  function runsOf(lineId){ var R = RUNS[lineId]; return R ? [R.out, R.back] : []; }
  function poseOf(L, run, k, ms){
    var t0 = k*HEADWAY + run.off, tau = ms/1000 - t0, p = runAt(run, tau), tr = trackAt(L.id, p.s, run.dir);
    return {id: L.id + ":" + run.key + ":" + k, line: L.id, mode: "metro", x: tr.x, y: tr.y, z: tr.z, yaw: tr.yaw, pitch: tr.pitch,
            speed: p.v, doors: p.doors, under: tr.under, s: p.s, dir: run.dir, run: run.key, k: k, stop: p.stop, kind: tr.kind,
            load: loadOf(L.id, L.id + ":" + run.key + ":" + k, ms)};
  }
  function vehicles(ms){
    var out = [], t = ms/1000;
    D.lines.forEach(function(L){
      runsOf(L.id).forEach(function(run){
        var k1 = Math.floor((t - run.off)/HEADWAY), k0 = Math.ceil((t - run.off - run.T)/HEADWAY);
        for(var k = k0; k <= k1; k++){ var st = k*HEADWAY + run.off; if(t >= st && t < st + run.T) out.push(poseOf(L, run, k, ms)); }
      });
    });
    return out;
  }
  function vehicle(id, ms){
    var m = /^(.+):(o|b):(-?\d+)$/.exec(String(id || "")); if(!m) return null;
    var L = LBY[m[1]], R = RUNS[m[1]]; if(!L) return null;
    return poseOf(L, m[2] === "o" ? R.out : R.back, +m[3], ms);
  }
  function dueText(at, ms){ var s = (at - ms)/1000; return s <= 30 ? "due" : s < 600 ? Math.ceil(s/60) + " min" : null; }
  function departures(stopId, ms, n){
    n = Math.max(1, Math.min(20, n == null ? 4 : n | 0));
    var rows = [], t = ms/1000;
    D.lines.forEach(function(L){
      runsOf(L.id).forEach(function(run){
        var e = run.ev[stopId]; if(!e || run.last === stopId) return;
        var k0 = Math.ceil((t - run.off - e.dep)/HEADWAY);
        for(var k = k0; k < k0 + n; k++){
          var arr = (k*HEADWAY + run.off + e.arr)*1000, dep = (k*HEADWAY + run.off + e.dep)*1000;
          rows.push({line: L.id, short: L.short, color: L.color, to: names[run.last] || "", toId: run.last, at: Math.round(arr), dep: Math.round(dep),
                     plat: platNo[stopId + "|" + L.id + "|" + run.key] || null, boarding: ms >= arr && ms < dep, delay: 0,
                     vehicle: L.id + ":" + run.key + ":" + k, due: dueText(arr, ms)});
        }
      });
    });
    rows.sort(function(a, b){ return a.at - b.at || (a.line < b.line ? -1 : a.line > b.line ? 1 : 0) || (a.plat < b.plat ? -1 : 1); });
    return rows.slice(0, n);
  }
  function platformSide(stopId){ var s = D.st[stopId]; return s && s.platform === "island" ? 1 : -1; }   // +1: left of travel
  function carPose(lineId, run, sMid, k){
    var L = LBY[lineId]; if(!L) return null;
    return trackAt(lineId, sMid + run.dir*(1.5 - k)*PITCH, run.dir);
  }
  function toWorld(cp, lx, ly, lz){
    var c = Math.cos(cp.yaw), s = Math.sin(cp.yaw);
    return {x: cp.x + lx*c + lz*s, y: cp.y + FLOOR + ly, z: cp.z - lx*s + lz*c};
  }
  function trip(lineId, from, to, ms){
    var L = LBY[lineId]; if(!L || from === to) return null;
    var run = null;
    runsOf(lineId).forEach(function(r){ var a = r.ev[from], b = r.ev[to]; if(a && b && a.i < b.i && r.last !== from) run = run || r; });
    if(!run) return null;
    var ea = run.ev[from], eb = run.ev[to], t = ms/1000;
    var k = Math.ceil((t - run.off - ea.dep)/HEADWAY);
    var base = k*HEADWAY + run.off, vid = L.id + ":" + run.key + ":" + k;
    var stops = [];
    var ia = run.order.indexOf(from), ib = run.order.indexOf(to);
    for(var i = ia; i <= ib; i++){ var sid = run.order[i]; stops.push({id: sid, name: names[sid], at: Math.round((base + run.ev[sid].arr)*1000), dep: Math.round((base + run.ev[sid].dep)*1000)}); }
    var side = platformSide(to) > 0 ? 1 : -1, sideFrom = platformSide(from) > 0 ? 1 : -1;
    var load = loadOf(L.id, vid, ms);
    var T = {mode: "metro", line: L.id, short: L.short, vehicle: vid, from: from, to: to, fromName: names[from], toName: names[to],
      arrive: Math.round((base + ea.arr)*1000), depart: Math.round((base + ea.dep)*1000), reach: Math.round((base + eb.arr)*1000),
      leave: Math.round((base + eb.dep)*1000), stops: stops, seats: CARS*SEATS_CAR, standing: CARS*STAND_CAR, cars: CARS, load: load,
      under: true, side: sideFrom, sideTo: side};
    T.pose = function(ms2){
      var p = runAt(run, ms2/1000 - base), tr = trackAt(L.id, p.s, run.dir);
      return {x: tr.x, y: tr.y + FLOOR, z: tr.z, yaw: tr.yaw, pitch: tr.pitch, speed: p.v, doors: p.doors, under: tr.under, done: ms2 >= T.leave, s: p.s};
    };
    T.seat = function(i, ms2){
      i = Math.max(0, i | 0);
      var nS = CARS*SEATS_CAR, stand = i >= nS, j = stand ? (i - nS) % (CARS*STAND_CAR) : i % nS;
      var car = stand ? Math.floor(j/STAND_CAR) : Math.floor(j/SEATS_CAR), q = stand ? STAND[j % STAND_CAR] : SEATS[j % SEATS_CAR];
      var p = runAt(run, (ms2 == null ? T.depart : ms2)/1000 - base), cp = carPose(L.id, run, p.s, car), w = toWorld(cp, q.x, q.y, q.z);
      return {x: w.x, y: w.y, z: w.z, yaw: wrapA(cp.yaw + q.yaw), floor: cp.y + FLOOR, stand: stand, car: car, pitch: cp.pitch};
    };
    T.door = function(ms2){
      var p = runAt(run, (ms2 == null ? T.depart : ms2)/1000 - base), atTo = ms2 != null && ms2 >= T.reach - 1000;
      var sd = p.stop ? (platformSide(p.stop) > 0 ? 1 : -1) : (atTo ? side : sideFrom);      // standing at a stop: its platform's side
      var cp = carPose(L.id, run, p.s, 1), w = toWorld(cp, sd*(CAR_HW + 0.05), 0, 0);
      return {x: w.x, z: w.z, y: w.y};
    };
    return T;
  }
  function stopsNear(x, z, r){
    r = r == null ? 400 : +r;
    return stopList.map(function(s){ return {id: s.id, name: s.name, dist: hyp(s.x - x, s.z - z), mode: "metro", lines: s.lines.slice()}; })
      .filter(function(s){ return s.dist <= r; }).sort(function(a, b){ return a.dist - b.dist || (a.id < b.id ? -1 : 1); });
  }
  // trains standing on the depot's sidings (seeded: one siding stays free)
  var depotTrainsC = null;
  function depotTrains(){
    if(depotTrainsC) return depotTrainsC;
    var out = [];
    D.depots.forEach(function(d){
      var r = mulberry32(hash32(seed + ":depot:" + d.id)), n = Math.max(0, d.tracks.length - 1);
      d.tracks.forEach(function(t, i){
        if(i >= n && d.tracks.length > 1) return;
        var P = pathOf({path: t.map(function(p){ return [p.x, p.y, p.z]; })}, 1); if(P.len < TRAIN_L*0.6) return;
        var mid = P.len/2 + (r() - 0.5)*Math.max(0, P.len - TRAIN_L - 4)*0.5, a = pathAt(P, mid);
        var L = LBY[d.line];
        out.push({id: "depot:" + d.id + ":" + i, line: d.line, color: L ? L.color : "#888888", P: P, s: mid, x: a.x, y: a.y, z: a.z, yaw: a.yaw});
      });
    });
    return (depotTrainsC = out);
  }
  // tunnel chunks within r m (horizontal) of (x, z): {key, line, i, s0, s1, under, near (the closest metres)}
  function segmentsNear(x, z, r){
    r = r == null ? LOD_R : +r;
    var out = [];
    D.lines.forEach(function(L){
      var P = L.P, n = Math.ceil(P.len/CHUNK);
      for(var i = 0; i < n; i++){
        var s0 = i*CHUNK, s1 = Math.min(P.len, s0 + CHUNK), under = false, best = Infinity;
        for(var s = s0; s <= s1 + 1e-6; s += 5){
          var a = pathAt(P, Math.min(s, s1));
          if(UNDER_KINDS[a.kind]) under = true;
          best = Math.min(best, hyp(a.x - x, a.z - z));
        }
        // the segment kinds inside the chunk (a chunk can start on a portal and end bored)
        for(var g = segIdx(P, s0); g < P.kinds.length && P.S[g] < s1; g++) if(UNDER_KINDS[P.kinds[g]]) under = true;
        if(under && best <= r) out.push({key: L.id + "#" + i, line: L.id, i: i, s0: s0, s1: s1, under: true, near: best});
      }
    });
    return out;
  }
  var LAY = null;
  var sim = {
    mode: "metro", seed: seed, data: D, names: names,
    lines: function(){
      return D.lines.map(function(L){ return {id: L.id, mode: "metro", name: L.name, short: L.short, color: L.color, stops: L.stops.map(function(q){ return q.id; }),
        headway: HEADWAY, loop: false}; });
    },
    stops: function(){ return stopList.map(function(s){ return Object.assign({}, s, {lines: s.lines.slice()}); }); },
    stopsNear: stopsNear, departures: departures, trip: trip, vehicles: vehicles, vehicle: vehicle,
    trackAt: trackAt, carPose: function(v, k){ var R = RUNS[v.line]; return R ? carPose(v.line, v.dir === (R.out.dir) ? R.out : R.back, v.s, k) : null; },
    runs: function(id){ return RUNS[id] || null; }, lineData: function(id){ return LBY[id] || null; },
    depotTrains: depotTrains, segmentsNear: segmentsNear, platformSide: platformSide,
    // [transit pass] the platform number a run calls at ("1".."6"), and where a train standing at a station opens its
    // doors: [{x, y (the car floor), z, car, dz}] on the platform's side (one per door, CARS x 3)
    platNo: function(stopId, lineId, runKey){ return platNo[stopId + "|" + lineId + "|" + (runKey === "b" ? "b" : "o")] || null; },
    doorsOf: function(v){
      var R = v && RUNS[v.line]; if(!R || !v.stop) return [];
      var run = v.dir === R.out.dir ? R.out : R.back, sd = platformSide(v.stop) > 0 ? 1 : -1, out = [];
      for(var k = 0; k < CARS; k++){ var cp = carPose(v.line, run, v.s, k); if(!cp) continue;
        DOORS_Z.forEach(function(dz){ var w = toWorld(cp, sd*(CAR_HW + 0.05), 0, dz); out.push({x: w.x, y: w.y, z: w.z, car: k, dz: dz, yaw: cp.yaw}); }); }
      return out;
    },
    // the named road nearest (x, z) within 90 m (an exit's street), else null
    streetNear: function(x, z){ var r = roadsNear(W, x, z, 90); return r.length ? r[0].name : null; },
    // the run a vehicle is on: {key "o" | "b", last (its terminus' stop id), lastName}
    runOf: function(v){ var R = v && RUNS[v.line]; if(!R) return null; var run = v.dir === R.out.dir ? R.out : R.back; return {key: run.key, last: run.last, lastName: names[run.last] || ""}; },
    layout: function(){ return LAY || (LAY = layout(sim, W)); }
  };
  return sim;
}

/* ------------------------------------------------------------------------------ the underground layout */
function rect(cx, cz, yaw, hw, hl){ return {cx: cx, cz: cz, yaw: yaw, hw: hw, hl: hl, s: Math.sin(yaw), c: Math.cos(yaw)}; }
function rLocal(r, x, z){ var dx = x - r.cx, dz = z - r.cz; return {u: dx*r.s + dz*r.c, v: dx*r.c - dz*r.s}; }
function inRect(r, x, z, pad){ pad = pad || 0; var l = rLocal(r, x, z); return Math.abs(l.u) <= r.hl + pad && Math.abs(l.v) <= r.hw + pad ? l : null; }
function rPoint(r, u, v){ return {x: r.cx + u*r.s + v*r.c, z: r.cz + u*r.c - v*r.s}; }
// a rect from (ax, az) to (bx, bz), hw wide each side
function rectAB(ax, az, bx, bz, hw){ var L = hyp(bx - ax, bz - az) || 0.01; return rect((ax + bx)/2, (az + bz)/2, Math.atan2(bx - ax, bz - az), hw, L/2); }
// the part of the segment a -> b inside rect r (pad m beyond its edges): [t0, t1] (0..1 along it) | null (Liang-Barsky)
function segRect(ax, az, bx, bz, r, pad){
  pad = pad || 0;
  var A = rLocal(r, ax, az), B = rLocal(r, bx, bz), du = B.u - A.u, dv = B.v - A.v, t0 = 0, t1 = 1;
  var P = [-du, du, -dv, dv], Q = [A.u + r.hl + pad, r.hl + pad - A.u, A.v + r.hw + pad, r.hw + pad - A.v];
  for(var i = 0; i < 4; i++){
    if(Math.abs(P[i]) < 1e-12){ if(Q[i] < 0) return null; continue; }
    var t = Q[i]/P[i];
    if(P[i] < 0){ if(t > t1) return null; if(t > t0) t0 = t; } else { if(t < t0) return null; if(t < t1) t1 = t; }
  }
  return t1 - t0 > 1e-9 ? [t0, t1] : null;
}
// [stations] convex polygons ([[x, z], ...]) less a rect: the half-plane clip (Sutherland-Hodgman) in the rect's frame
function clipHalf(poly, r, ax, k, keepOut){
  // the side of the line u = k (ax "u") or v = k (ax "v") in rect r's frame: keepOut keeps coord > k, else coord <= k
  var out = [], n = poly.length;
  function c(p){ var l = rLocal(r, p[0], p[1]); var w = ax === "u" ? l.u : l.v; return keepOut ? w - k : k - w; }
  for(var i = 0; i < n; i++){
    var P = poly[i], Q = poly[(i + 1) % n], a = c(P), b = c(Q);
    if(a >= 0) out.push(P);
    if((a >= 0) !== (b >= 0)){ var t = a/(a - b); out.push([P[0] + (Q[0] - P[0])*t, P[1] + (Q[1] - P[1])*t]); }
  }
  return out;
}
function polyArea(p){ var a = 0; for(var i = 0; i < p.length; i++){ var q = p[(i + 1) % p.length]; a += p[i][0]*q[1] - q[0]*p[i][1]; } return Math.abs(a)/2; }
function minusRect(poly, r){
  var pieces = [], rem = poly;
  [["u", r.hl, true], ["u", -r.hl, false], ["v", r.hw, true], ["v", -r.hw, false]].forEach(function(h){
    if(rem.length < 3) return;
    var o = clipHalf(rem, r, h[0], h[1], h[2]); if(o.length >= 3 && polyArea(o) > 1e-4) pieces.push(o);
    rem = clipHalf(rem, r, h[0], h[1], !h[2]);
  });
  return pieces;
}
// [stations] a polygon less a convex one (both [[a, b], ...], counter-clockwise or not): the pieces outside it
function minusConvex(poly, cv){
  var n = cv.length, area = 0, i;
  for(i = 0; i < n; i++){ var q = cv[(i + 1) % n]; area += cv[i][0]*q[1] - q[0]*cv[i][1]; }
  var sg = area >= 0 ? 1 : -1, pieces = [], rem = poly;
  function clip(P, a, b, keepOut){
    var out = [], m = P.length;
    function side(p){ var v = ((b[0] - a[0])*(p[1] - a[1]) - (b[1] - a[1])*(p[0] - a[0]))*sg; return keepOut ? -v : v; }   // >= 0: kept
    for(var k = 0; k < m; k++){
      var A = P[k], B = P[(k + 1) % m], sa = side(A), sb = side(B);
      if(sa >= 0) out.push(A);
      if((sa >= 0) !== (sb >= 0)){ var t = sa/(sa - sb); out.push([A[0] + (B[0] - A[0])*t, A[1] + (B[1] - A[1])*t]); }
    }
    return out;
  }
  for(i = 0; i < n && rem.length >= 3; i++){
    var a = cv[i], b = cv[(i + 1) % n], o = clip(rem, a, b, true);
    if(o.length >= 3 && polyArea(o) > 1e-5) pieces.push(o);
    rem = clip(rem, a, b, false);
  }
  return pieces;
}
function minusRects(polys, rs){ rs.forEach(function(r){ var nx = []; polys.forEach(function(p){ nx = nx.concat(minusRect(p, r)); }); polys = nx; }); return polys; }
function rectPoly(r, u0, u1, v0, v1){ return [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(function(k){ var P = rPoint(r, k[0], k[1]); return [P.x, P.z]; }); }

// Every station's floors. A floor: {r (rect), y0, y1 (heights at u = -hl and +hl), kind, station, line?}.
function layout(sim, W){
  var D = sim.data, ST = [], ENTS = [];
  var railD = null, R = railRawOf(W);
  if(R){
    railD = [];
    (R.m.stations || []).forEach(function(s){
      if(!s || s.kind !== "underground") return;
      railD.push({id: String(s.id), x: fin(s.x, 0)*R.k, y: fin(s.y, 0)*R.k, z: fin(s.z, 0)*R.k, yaw: yawOf(s, "along"), len: fin(s.len, 9000)*R.k || 90,
                  platforms: Math.max(1, Math.min(6, s.platforms | 0 || 2)), lines: (s.lines || []).map(String)});
    });
  }
  D.stations.forEach(function(s){
    if(!s.lines.length) return;
    // [stations] the station's own frame (u along its first line, v across), then in order: the entrance stairs (fixed by
    // the doc), the gate lines (past every foot and every entrance stair that hangs below the hall's ceiling, so no gate
    // stands under one), the platform stairs (their heads 4.5 m past the gates), and the hall round all of it (the open
    // wells at the stair heads inside it); passages from the feet outside it run straight on into it
    var yaw0 = s.at[s.lines[0]].yaw, floors = [], plats = [], stairs = [], extra = [], rooms = [];
    var multi = s.lines.length > 1, hw = multi ? 20 : 12, SF = rect(s.x, s.z, yaw0, 0, 0), hy = s.hallY;
    var ents = s.ents.map(function(e){
      var drop = e.y - hy, run = e.kind === "lift" ? 2.4 : Math.max(e.d, drop/0.7), sy = Math.sin(e.yaw), cy = Math.cos(e.yaw);
      var foot = {x: e.x + sy*run, z: e.z + cy*run};
      var ramp = e.kind === "lift" ? rect(e.x + sy*1.2, e.z + cy*1.2, e.yaw, 1.3, 1.2) : rectAB(e.x, e.z, foot.x, foot.z, e.w/2);
      return {e: e, drop: drop, run: run, sy: sy, cy: cy, foot: foot, ramp: ramp};
    });
    // what must stay on the street side, per end of the hall (|u| intervals): every foot (with room either side), every
    // passage's way in, every entrance stair that hangs below the hall's ceiling
    var blocks = {"-1": [], "1": []}, feet = {"-1": [], "1": []};
    function block(u, a0, b0, foot){ var e = u >= 0 ? 1 : -1, au = Math.abs(u); blocks[e].push([au - a0, au + b0]); if(foot) feet[e].push(au); if(au < a0){ blocks[-e].push([0, a0 - au]); } }
    ents.forEach(function(q){
      var fl = rLocal(SF, q.foot.x, q.foot.z);
      if(Math.abs(fl.v) > hw + 0.5){
        // a foot beside the hall: its passage runs straight on and comes in through the side wall there
        var dv = q.sy*SF.c - q.cy*SF.s, du = q.sy*SF.s + q.cy*SF.c, tv = dv*fl.v < 0 ? (Math.abs(fl.v) - hw)/Math.abs(dv) : -1;
        block(tv > 0 && tv < 200 ? fl.u + du*tv : fl.u, 3.5, 3.5, true);
      } else block(fl.u, 3.5, 3.5, true);
      if(q.e.kind === "lift" || q.drop <= 0) return;
      var up = Math.min(q.run, (HALL_H + 0.3)/(q.drop/q.run));
      for(var k = 1; k <= 8; k++){ var d = up*k/8, P = {x: q.foot.x - q.sy*d, z: q.foot.z - q.cy*d}, l = rLocal(SF, P.x, P.z); if(Math.abs(l.v) <= hw + q.e.w/2) block(l.u, 2.5, 2.5, false); }
    });
    // per end: the stair head (su) and the paid stretch round its well, [su - 3, su + well + 3]: clear of every foot,
    // then of everything else, nearest STAIR_U; a gate line at each end of it that has the street side beyond it
    var half0 = s.len/2, run0 = Math.max(2, (hy - (s.at[s.lines[0]].rail + FLOOR))/STAIR_SLOPE), suMax = Math.max(9, half0 - run0 - 3), well0 = Math.min(run0, WELL_L);
    var SUe = {}, paid = {}, lines = [];
    [-1, 1].forEach(function(e){
      var best = null, bc = Infinity;
      for(var su0 = 9; su0 <= suMax + 1e-6; su0 += 0.25){
        var lo = su0 - 3, hi = su0 + well0 + 3, cost = Math.abs(su0 - STAIR_U)*0.01;
        feet[e].forEach(function(f){ if(f > lo - 0.5 && f < hi + 0.5) cost += 1e5; else cost += 1000*Math.max(0, 3 - Math.max(lo - f, f - hi)); });
        blocks[e].forEach(function(bk){ cost += 10*Math.max(0, Math.min(hi, bk[1]) - Math.max(lo, bk[0])); });
        if(cost < bc - 1e-9){ bc = cost; best = su0; }
      }
      var su1 = best == null ? Math.min(STAIR_U, suMax) : best, lo1 = su1 - 3, hi1 = su1 + well0 + 3;
      var outer = blocks[e].some(function(bk){ return (bk[0] + bk[1])/2 > hi1; });
      SUe[e] = su1; paid[e] = [lo1, outer ? hi1 : Infinity];
      lines.push({u: e*lo1, e: e});
      if(outer) lines.push({u: e*hi1, e: -e});
    });
    var gu = Math.max(paid[-1][0], paid[1][0]), su = Math.max(SUe[-1], SUe[1]);
    var ub = HALL_HL, vb = hw;   // the hall's half extents, grown round the wells
    s.lines.forEach(function(lid, li){
      var a = s.at[lid], plat = a.rail + FLOOR, half = s.len/2;
      var lats = s.platform === "island" ? [0] : [-(TRACK + CAR_HW + 0.1 + 2.3), TRACK + CAR_HW + 0.1 + 2.3];
      var phw = s.platform === "island" ? TRACK - CAR_HW - 0.1 : 2.3;
      var L = sim.lineData(lid), cp = pathAt(L.P, a.s);
      lats.forEach(function(v, pi){
        var c = rPoint(rect(cp.x, cp.z, a.yaw, 0, 0), 0, v), pr = rect(c.x, c.z, a.yaw, phw, half);
        var P = {r: pr, y0: plat, y1: plat, kind: "platform", station: s.id, line: lid, lat: v, side: s.platform === "island" ? 0 : (v < 0 ? -1 : 1)};
        floors.push(P); plats.push(P);
        // two stairs (stairs and an escalator side by side), leaving the hall past the gates and running outwards
        // ([stations] on an island 4 m wide the stairs are 2.2 m wide: 0.9 m of platform either side, to the doors beside them)
        var drop = hy - plat, run = Math.max(2, drop/STAIR_SLOPE), shw = s.platform === "island" ? Math.min(phw - 0.9, 1.1) : Math.min(phw - 0.15, 1.5), off = rLocal(SF, pr.cx, pr.cz).u;
        [1, -1].forEach(function(e){
          var u0 = li === 0 ? e*SUe[e] - off : e*Math.min(STAIR_U, half - run - 3), u1 = u0 + e*run, A = rPoint(pr, u0, 0), B = rPoint(pr, u1, 0);
          var sr = rectAB(A.x, A.z, B.x, B.z, shw);
          var S = {r: sr, y0: hy, y1: plat, kind: "stairs", station: s.id, line: lid, plat: pi, well: Math.min(2*sr.hl, WELL_L)};
          floors.push(S); stairs.push(S);
          // the hall reaches past the well (its open part) by 0.6 m
          [[-sr.hl, -1], [-sr.hl, 1], [-sr.hl + S.well, -1], [-sr.hl + S.well, 1]].forEach(function(k){ var W = rPoint(sr, k[0], k[1]*(shw + 0.6)), l = rLocal(SF, W.x, W.z); ub = Math.max(ub, Math.abs(l.u) + (k[0] > -sr.hl ? 0.6 : 0)); vb = Math.max(vb, Math.abs(l.v)); });
        });
      });
    });
    [-1, 1].forEach(function(e){ if(paid[e][1] < Infinity) ub = Math.max(ub, paid[e][1] + 11.5); feet[e].forEach(function(f){ if(f < ub + 6) ub = Math.max(ub, f + 0.5); }); });
    var hall = rect(s.x, s.z, yaw0, vb, ub);
    hw = vb;
    var hallF = {r: hall, y0: hy, y1: hy, kind: "hall", station: s.id, wells: stairs};
    floors.unshift(hallF);
    rooms.push({kind: "box", r: hall, y0: hy, y1: hy + HALL_H, what: "hall"});
    // entrances: the stair (or lift) down from the street, then (a foot outside the hall) a passage on into it
    ents.forEach(function(q){
      var e = q.e, sy = q.sy, cy = q.cy, foot = q.foot, run = q.run;
      var F = {r: q.ramp, y0: e.kind === "lift" ? hy : e.y, y1: hy, kind: e.kind === "lift" ? "lift" : "entrance", station: s.id, ent: e.id};
      floors.push(F);
      if(e.kind !== "lift") rooms.push({kind: "tube", r: q.ramp, f: F, top: e.y - 0.25, street: e.y, what: "entrance"});
      var pass = null;
      if(!inRect(hall, foot.x, foot.z, -0.5)){
        // straight on from the foot to where that meets the hall (else toward the hall's middle)
        // (far enough that both its walls reach into the hall: an oblique way in leaves no wedge open at its end)
        var phw0 = Math.min(2.2, Math.max(1.6, e.w/2)), T = null, tin = -1;
        [-phw0, 0, phw0].forEach(function(o){ var ox = cy*o, oz = -sy*o, ht = segRect(foot.x + ox, foot.z + oz, foot.x + ox + sy*200, foot.z + oz + cy*200, hall); tin = ht && tin > -2 ? Math.max(tin, ht[0]*200) : -2; });
        if(tin >= 0){ var t1 = Math.min(tin + 0.6, 200); T = {x: foot.x + sy*t1, z: foot.z + cy*t1}; }
        else { var hl = rLocal(hall, foot.x, foot.z), tu = clamp(hl.u, -hall.hl + 3, hall.hl - 3)*0.4, tv = clamp(hl.v, -hw + 2, hw - 2)*0.4; T = rPoint(hall, tu, tv); }
        pass = {r: rectAB(foot.x - sy*0.3, foot.z - cy*0.3, T.x, T.z, Math.min(2.2, Math.max(1.6, e.w/2))), y0: hy, y1: hy, kind: "passage", station: s.id, ent: e.id, wells: stairs};
        floors.push(pass);
        rooms.push({kind: "box", r: pass.r, y0: hy, y1: hy + PASS_H, what: "passage"});
      }
      if(e.kind === "lift") rooms.push({kind: "box", r: q.ramp, y0: hy, y1: hy + PASS_H, what: "lift"});
      // where E at the entrance lands you: 1.2 m past the foot of the stairs, on the hall's (or the passage's) floor; when
      // the hall's edge is nearer than that, the last step of the stairs (always a floor at the hall's level)
      var fx = foot.x + sy*1.2, fz = foot.z + cy*1.2;
      if(!inRect(hall, fx, fz, 0) && !(pass && inRect(pass.r, fx, fz, 0))){ fx = foot.x - sy*0.6; fz = foot.z - cy*0.6; }
      var E = {id: e.id, station: s.id, kind: e.kind, x: e.x, y: e.y, z: e.z, yaw: e.yaw, w: e.w, d: e.d, run: run, ramp: F, pass: pass,
               foot: {x: fx, y: hy, z: fz, yaw: e.yaw}, hole: e.hole};
      ENTS.push(E);
    });
    // the platform rooms (the track bed to the ceiling, wall to wall) and the stairs' closed tubes
    s.lines.forEach(function(lid){
      var a = s.at[lid], L = sim.lineData(lid), cp = pathAt(L.P, a.s), W = s.platform === "island" ? TRACK + 2.1 : TRACK + 1.5 + 4.6;
      rooms.push({kind: "box", r: rect(cp.x, cp.z, a.yaw, W, s.len/2 + 6), y0: a.rail - 0.5, y1: a.rail + FLOOR + PLAT_H, what: "platform", line: lid});
    });
    stairs.forEach(function(f){ rooms.push({kind: "tube", r: f.r, f: f, well: f.well, what: "stairs"}); });
    // the Island Link's underground platforms near the hall (part rail's trains): a passage, a stair and its platform
    (railD || []).forEach(function(r){
      if(hyp(r.x - s.x, r.z - s.z) > 300) return;
      // each railway platform joins the one metro station nearest it (not every hall within 300 m)
      var nearer = D.stations.some(function(o2){ return o2 !== s && o2.lines.length && hyp(r.x - o2.x, r.z - o2.z) < hyp(r.x - s.x, r.z - s.z); });
      if(nearer) return;
      // a railway platform at the hall's own level or above it would put its box through the hall (and be out of
      // reach up a wall): only one below the hall is joined to it
      if(r.y > hy - 3 && hyp(r.x - s.x, r.z - s.z) < hall.hl + r.len/2) return;
      var plat = r.y, n = r.platforms, phw = 2.6, half = r.len/2, rr = rect(r.x, r.z, r.yaw, n*4.4, half);
      var pr = rect(r.x, r.z, r.yaw, phw, half);
      floors.push({r: pr, y0: plat, y1: plat, kind: "platform", station: s.id, rail: r.id});
      rooms.push({kind: "box", r: rect(r.x, r.z, r.yaw, 4.2 + 2.1, half + 6), y0: plat - FLOOR - 0.5, y1: plat + PLAT_H, what: "platform", rail: r.id});
      var drop = hy - plat;
      if(drop > 0.5){
        var run = drop/STAIR_SLOPE, A = rPoint(pr, -half + 6, 0), B = rPoint(pr, -half + 6 + run, 0);
        var ILs = {r: rectAB(A.x, A.z, B.x, B.z, 1.5), y0: hy, y1: plat, kind: "stairs", station: s.id, rail: r.id, well: 0};
        floors.push(ILs); rooms.push({kind: "tube", r: ILs.r, f: ILs, well: 0, what: "stairs"});
        if(!inRect(hall, A.x, A.z, -1)){ var pA = {r: rectAB(s.x, s.z, A.x, A.z, 2.2), y0: hy, y1: hy, kind: "passage", station: s.id, rail: r.id, wells: stairs}; floors.push(pA); rooms.push({kind: "box", r: pA.r, y0: hy, y1: hy + PASS_H, what: "passage"}); }
      } else { var pB = {r: rectAB(s.x, s.z, r.x, r.z, 2.2), y0: hy, y1: hy, kind: "passage", station: s.id, rail: r.id, wells: stairs}; floors.push(pB); rooms.push({kind: "box", r: pB.r, y0: hy, y1: hy + PASS_H, what: "passage"}); }
      extra.push({id: r.id, x: r.x, y: plat, z: r.z, yaw: r.yaw, len: r.len, platforms: n, box: rr, lines: r.lines});
    });
    // [transit pass] the gate lines across the hall at +-gu: every entrance's foot inside the hall lands on the street
    // (unpaid) side of them, between them; the stairs to the platforms leave beyond them (the paid side). Eight lanes a
    // line between nine cabinets; the ticket machines on the hall's -v wall, in the unpaid middle.
    var lanes = []; for(var g = 0; g < GATE_N; g++) lanes.push(-GATE_N*0.55 + 0.55 + g*1.1);
    // [stations] a stair whose head is on the street side of those lines (another line's, crossing the hall) has its own
    // short gate line across its head: two lanes between three cabinets
    var heads = [];
    function paidU(u){ var e = u >= 0 ? 1 : -1, au = Math.abs(u); return au > paid[e][0] && au < paid[e][1]; }
    stairs.forEach(function(f){
      var A = rPoint(f.r, -f.r.hl, 0), l = rLocal(SF, A.x, A.z);
      if(!paidU(l.u)) heads.push({f: f, r: rect(A.x, A.z, f.r.yaw, f.r.hw + 0.05, GATE_BAND), lanes: [-0.6, 0.6]});
    });
    // the ticket machines on the hall's -v wall, in the middle of the street side's widest stretch
    // (on the street side, near a way in and with no gate between them)
    var fu = []; [-1, 1].forEach(function(e){ feet[e].forEach(function(f){ fu.push(e*f); }); }); if(!fu.length) fu.push(0);
    // one bank of four for every stretch of the street side a way in comes into (at most two)
    var groups = [];
    fu.forEach(function(f){
      var best = null, bs = -Infinity;
      for(var mu0 = -hall.hl + 5.5; mu0 <= hall.hl - 5.5; mu0 += 0.5){
        var okM = true; for(var dm = -5.2; dm <= 5.2; dm += 0.4) if(paidU(mu0 + dm)) okM = false;
        for(var dm2 = -5.2; dm2 <= 5.2 && okM; dm2 += 0.8) [-hw + 0.4, -hw + 2.4].forEach(function(vm){ var Q = rPoint(hall, mu0 + dm2, vm); if(stairs.some(function(f2){ return inRect(f2.r, Q.x, Q.z, 0.8); })) okM = false; });
        if(!okM) continue;
        var free = true; for(var w = Math.min(f, mu0); w <= Math.max(f, mu0); w += 0.5) if(paidU(w)) free = false;
        var sc = (free ? 0 : -1e4) - Math.abs(mu0 - f) - 0.01*Math.abs(mu0);
        if(sc > bs){ bs = sc; best = mu0; }
      }
      var same = function(g){ for(var w2 = Math.min(g, best); w2 <= Math.max(g, best); w2 += 0.5) if(paidU(w2)) return false; return true; };   // the same stretch
      if(best != null && bs > -1e4 && !groups.some(same) && groups.length < 2) groups.push(best);
    });
    if(!groups.length) groups.push(0);
    var machines = [];
    groups.forEach(function(mcU){ for(var mi = 0; mi < 4; mi++){ var mu = mcU - 4.2 + mi*2.8, MP = rPoint(hall, mu, -hw + 1.2); machines.push({x: MP.x, z: MP.z, u: mu, yaw: wrapA(yaw0 - PI/2)}); } });
    var ext = 0;
    floors.forEach(function(f){ ext = Math.max(ext, hyp(f.r.cx - s.x, f.r.cz - s.z) + f.r.hl + f.r.hw); });
    rooms.forEach(function(R0){ ext = Math.max(ext, hyp(R0.r.cx - s.x, R0.r.cz - s.z) + R0.r.hl + R0.r.hw); });
    var low = Infinity; floors.forEach(function(f){ low = Math.min(low, f.y0, f.y1); });
    ST.push({id: s.id, name: sim.names[s.id], x: s.x, z: s.z, yaw: yaw0, street: s.street, hallY: hy, hall: hall, hw: hw, len: s.len,
             platform: s.platform, lines: s.lines.slice(), at: s.at, floors: floors, plats: plats, stairs: stairs, il: extra, ext: ext, low: low,
             gu: gu, su: su, paid: paid, gates: lines, lanes: lanes, heads: heads, machines: machines, rooms: rooms});
  });
  var BY = {}; ST.forEach(function(s){ BY[s.id] = s; });
  function fy(f, l){ return f.y0 + (f.y1 - f.y0)*clamp((l.u + f.r.hl)/(2*f.r.hl || 1), 0, 1); }
  // [stations] the hall's floor is open over a stair's well (past its first step)
  function overWell(f, x, z){
    for(var k = 0; k < f.wells.length; k++){ var w = f.wells[k], l = inRect(w.r, x, z); if(l && l.u + w.r.hl <= w.well && fy(w, l) < f.y0 - 0.25) return true; }
    return false;
  }
  // [stations] the rooms below the street (the hall, passages, platform rooms, the stairs' tubes and the entrance stairs)
  // a camera may be in: the lowest and highest y in room R over (x, z) (l: its local), or null outside its footprint
  function roomSpan(R, l){
    if(R.kind === "box") return [R.y0, R.y1];
    var fl = fy(R.f, l);
    return [fl, R.top != null ? R.top : fl + TUBE_H];
  }
  // is (x, y, z) inside a room, m (default CAM_M) clear of its walls, floor and ceiling? -> the room | null
  function roomAt(x, y, z, m){
    m = m == null ? CAM_M : m;
    for(var i = 0; i < ST.length; i++){
      var s = ST[i]; if(hyp(x - s.x, z - s.z) > s.ext + 1) continue;
      for(var j = 0; j < s.rooms.length; j++){
        var R = s.rooms[j], l = inRect(R.r, x, z, -m); if(!l) continue;
        var sp = roomSpan(R, l);
        if(y >= sp[0] + m && y <= sp[1] - m) return R;
      }
    }
    return null;
  }
  // a tube's walls (its sides, its floor, its ceiling past the open well) between two points: does a -> b go through one?
  function tubeWall(s, a, b){
    for(var j = 0; j < s.rooms.length; j++){
      var R = s.rooms[j]; if(R.kind !== "tube") continue;
      var la = rLocal(R.r, a.x, a.z), lb = rLocal(R.r, b.x, b.z);
      var ina = Math.abs(la.u) <= R.r.hl && Math.abs(la.v) <= R.r.hw, inb = Math.abs(lb.u) <= R.r.hl && Math.abs(lb.v) <= R.r.hw;
      if(!ina && !inb) continue;
      if(ina !== inb){
        // through a side (not an open end): below its top (the hall's floor along the well, else the tube's ceiling)
        var o = ina ? lb : la, at = ina ? la : lb, y = ina ? b.y : a.y;
        if(Math.abs(o.u) > R.r.hl) continue;
        var spS = roomSpan(R, at), wellS = R.well && at.u + R.r.hl <= R.well;
        if(y < (wellS ? R.f.y0 : spS[1]) && y > spS[0] - 0.3) return true;
        continue;
      }
      var sa = roomSpan(R, la), sb = roomSpan(R, lb), wa = R.well && la.u + R.r.hl <= R.well;
      if((a.y >= sa[0]) !== (b.y >= sb[0])) return true;                       // the steps
      if(!wa && (a.y <= sa[1]) !== (b.y <= sb[1])) return true;                 // the tube's ceiling
    }
    return false;
  }
  // how far along from -> to (0..1) a camera may go below the street: inside the rooms, CAM_M clear, never through a wall
  function camHit(from, to){
    var dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z, len = Math.sqrt(dx*dx + dy*dy + dz*dz);
    if(!(len > 1e-6)) return 1;
    var st = null;
    for(var i = 0; i < ST.length; i++){ var s0 = ST[i]; if(hyp(from.x - s0.x, from.z - s0.z) <= s0.ext + 1){ st = s0; break; } }
    if(!st) return 1;
    var n = Math.max(4, Math.ceil(len/0.12)), prev = {x: from.x, y: from.y, z: from.z};
    for(var k = 1; k <= n; k++){
      var t = k/n, p = {x: from.x + dx*t, y: from.y + dy*t, z: from.z + dz*t};
      if(!roomAt(p.x, p.y, p.z) || tubeWall(st, prev, p)) return Math.max(0, (k - 1)/n);
      prev = p;
    }
    return 1;
  }
  // the ceiling over (x, z) of the room holding (x, y, z) (y: your head), else null
  function ceilAt(x, y, z){
    var best = null;
    for(var i = 0; i < ST.length; i++){
      var s = ST[i]; if(hyp(x - s.x, z - s.z) > s.ext + 1) continue;
      for(var j = 0; j < s.rooms.length; j++){
        var R = s.rooms[j], l = inRect(R.r, x, z); if(!l) continue;
        var sp = roomSpan(R, l); if(y < sp[0] - 0.2 || y > sp[1]) continue;
        var top = R.kind === "tube" && R.well && l.u + R.r.hl <= R.well ? R.f.y0 + HALL_H : sp[1];
        if(best == null || top > best) best = top;
      }
    }
    return best;
  }
  // [stations] a step from (ax, az) to (bx, bz) by someone whose feet are at y: through the side of a stair (its walls, its
  // balustrade: only its ends are ways on and off) within reach of it, or under one with too little headroom?
  function stepBlocked(ax, az, bx, bz, y){
    for(var i = 0; i < ST.length; i++){
      var s = ST[i]; if(hyp(bx - s.x, bz - s.z) > s.ext + 1) continue;
      for(var j = 0; j < s.floors.length; j++){
        var f = s.floors[j]; if(f.kind !== "entrance" && f.kind !== "stairs") continue;
        var la = rLocal(f.r, ax, az), lb = rLocal(f.r, bx, bz);
        if(Math.abs(lb.u) > f.r.hl + 0.05 && Math.abs(la.u) > f.r.hl + 0.05) continue;
        var ia = Math.abs(la.v) <= f.r.hw, ib = Math.abs(lb.v) <= f.r.hw, fb = fy(f, Math.abs(lb.u) <= f.r.hl ? lb : la);
        if(ia !== ib && Math.abs(lb.u) <= f.r.hl && Math.abs(la.u) <= f.r.hl && fb > y - 3.0 && fb < y + 2.2) return true;
        if(ib && Math.abs(lb.u) <= f.r.hl && fb - 0.3 > y + STEP_UP && fb - 0.3 < y + 2.0) return true;   // its underside at your head
      }
    }
    return false;
  }
  function walkable(x, y, z){
    var best = null;
    for(var i = 0; i < ST.length; i++){
      var s = ST[i]; if(hyp(x - s.x, z - s.z) > s.ext + 1) continue;
      for(var j = 0; j < s.floors.length; j++){
        var f = s.floors[j], l = inRect(f.r, x, z); if(!l) continue;
        if(f.wells && overWell(f, x, z)) continue;
        var h = fy(f, l);
        if(h <= y + STEP_UP && (!best || h > best.y)) best = {y: h, kind: f.kind, station: s.id};
      }
    }
    return best;
  }
  function tunnelAt(x, y, z){
    var Ls = D.lines;
    for(var i = 0; i < Ls.length; i++){
      var P = Ls[i].P, n = nearestOn(P, x, z);
      if(n.d > TRACK + 4.2) continue;
      var a = pathAt(P, n.s);
      if(UNDER_KINDS[a.kind] && y >= a.y - 1.5 && y <= a.y + 7) return {line: Ls[i].id, s: n.s, rail: a.y};
    }
    return null;
  }
  function isUnder(x, y, z){
    for(var i = 0; i < ST.length; i++){
      var s = ST[i]; if(hyp(x - s.x, z - s.z) > s.ext + 1) continue;
      if(y > s.street - 1) continue;
      for(var j = 0; j < s.floors.length; j++){ var f = s.floors[j], l = inRect(f.r, x, z, 0.3); if(l && y >= Math.min(f.y0, f.y1) - 2 && y <= Math.max(f.y0, f.y1) + 6) return true; }
    }
    return !!tunnelAt(x, y, z);
  }
  // [transit pass] the gate line under (x, z) at the hall's level: {station, e (+-1, which end), lane (index, -1 on a
  // cabinet or the glass), u, v} | null. GATE_BAND m either side of the line is the barrier's depth.
  function gateAt(x, y, z){
    for(var i = 0; i < ST.length; i++){
      var s = ST[i]; if(hyp(x - s.x, z - s.z) > s.ext + 1) continue;
      if(y != null && isFinite(y) && Math.abs(y - s.hallY) > 0.6) continue;     // on the hall's floor (not up an entrance's stairs over it)
      var l = inRect(s.hall, x, z, 0); if(!l) continue;
      for(var gi = 0; gi < s.gates.length; gi++){
        if(s.heads.some(function(H){ return inRect(H.f.r, x, z, 0.2); })) break;   // a stair's well: not this line
        var GL = s.gates[gi]; if(Math.abs(l.u - GL.u) > GATE_BAND) continue;
        var lane = -1;
        for(var k = 0; k < s.lanes.length; k++) if(Math.abs(l.v - s.lanes[k]) <= LANE_HW){ lane = k; break; }
        return {station: s.id, e: GL.e, lane: lane, u: l.u, v: l.v};
      }
      for(var hd = 0; hd < s.heads.length; hd++){
        var H = s.heads[hd], lh = inRect(H.r, x, z); if(!lh) continue;
        var ln = -1;
        for(var q = 0; q < H.lanes.length; q++) if(Math.abs(lh.v - H.lanes[q]) <= LANE_HW){ ln = q; break; }
        return {station: s.id, e: 0, lane: ln, u: lh.u, v: lh.v, head: true};
      }
    }
    return null;
  }
  // is (x, y, z) on the paid side of a station's gates (the hall beyond them, the stairs down and the metro's
  // platforms)? null: not in a metro station at all. The street side, the passages and the City Line's platforms
  // (their own passage from the hall's middle) are not.
  function paidAt(x, y, z){
    var best = null, by = -Infinity;
    for(var i = 0; i < ST.length; i++){
      var s = ST[i]; if(hyp(x - s.x, z - s.z) > s.ext + 1) continue;
      for(var j = 0; j < s.floors.length; j++){
        var f = s.floors[j], l = inRect(f.r, x, z); if(!l) continue;
        if(f.wells && overWell(f, x, z)) continue;
        var h = fy(f, l);
        if(y != null && isFinite(y) && h > y + STEP_UP) continue;
        if(h > by){ by = h; best = f.kind === "hall" ? (function(){ var e = l.u >= 0 ? 1 : -1, au = Math.abs(l.u); return au > s.paid[e][0] && au < s.paid[e][1]; })() : (f.kind === "platform" || f.kind === "stairs") && !f.rail; }
      }
    }
    return best;
  }
  function entOut(E, d){ return {id: E.id, station: E.station, kind: E.kind, dist: d, x: E.x, y: E.y, z: E.z, yaw: E.yaw, foot: Object.assign({}, E.foot)}; }
  function entranceAt(x, z, r){
    r = r == null ? 3 : +r; var best = null, bd = Infinity;
    ENTS.forEach(function(E){
      var d = hyp(E.x - x, E.z - z), l = inRect(E.ramp.r, x, z);
      if(l && E.kind !== "lift") d = Math.min(d, 0);
      if(d <= r && (d < bd || d === bd && best && E.id < best.id)){ bd = d; best = E; }
    });
    return best ? entOut(best, bd) : null;
  }
  function rampAt(x, z){
    for(var i = 0; i < ENTS.length; i++){
      var E = ENTS[i], l = inRect(E.ramp.r, x, z); if(!l || E.kind === "lift") continue;
      return {id: E.id, station: E.station, kind: E.kind, street: E.y, y: fy(E.ramp, l), u: l.u + E.ramp.r.hl, run: E.run};
    }
    return null;
  }
  function stationAt(x, y, z){
    var best = null, bd = Infinity;
    ST.forEach(function(s){
      var d = hyp(x - s.x, z - s.z), inside = false;
      if(d <= s.ext + 1) s.floors.forEach(function(f){ if(inRect(f.r, x, z, 0.5)) inside = true; });
      var score = inside ? d - 1e6 : d;
      if(score < bd){ bd = score; best = s; }
    });
    return best && (bd < 0 || bd < 400) ? {id: best.id, name: best.name, lines: best.lines.slice()} : null;
  }
  function exitTo(stationId, x, z){
    var s = BY[stationId]; if(!s) return null;
    var es = ENTS.filter(function(E){ return E.station === stationId; });
    if(!es.length) return {x: s.x, y: s.street, z: s.z, yaw: s.yaw, id: null};
    var px = x != null && isFinite(x) ? +x : null, pz = z != null && isFinite(z) ? +z : null;
    es.sort(function(a, b){ return (px == null ? 0 : hyp(a.x - px, a.z - pz) - hyp(b.x - px, b.z - pz)) || (a.kind === "lift") - (b.kind === "lift") || (a.id < b.id ? -1 : 1); });
    var E = es[0], back = E.kind === "lift" ? -2.4 : -1.6;
    return {x: E.x + Math.sin(E.yaw)*back, y: E.y, z: E.z + Math.cos(E.yaw)*back, yaw: wrapA(E.yaw + PI), id: E.id};
  }
  return {stations: ST, byId: BY, entrances: ENTS, walkable: walkable, isUnder: isUnder, tunnelAt: tunnelAt, entranceAt: entranceAt,
          rampAt: rampAt, stationAt: stationAt, exitTo: exitTo, floorY: fy, gateAt: gateAt, paidAt: paidAt,
          roomAt: roomAt, stepBlocked: stepBlocked, camInside: function(x, y, z, m){ var R = roomAt(x, y, z, m); return R ? R.what : null; }, camHit: camHit, ceilAt: ceilAt, overWell: overWell};
}

HQV.hqMetro = {
  create: create, layout: function(sim){ return sim && sim.layout ? sim.layout() : null; },
  normalize: normalize, legTime: legTime, legAt: legAt, pathAt: pathAt, nearestOn: nearestOn, nearLine: nearLine, runAt: runAt, linesText: linesText,
  rect: rect, inRect: inRect, rLocal: rLocal, hash32: hash32, segRect: segRect, minusRects: minusRects, rectPoly: rectPoly, stationNames: stationNames, roadsNear: roadsNear,
  SEATS: SEATS, STAND: STAND, DOORS_Z: DOORS_Z,
  HEADWAY: HEADWAY, DWELL: DWELL, VMAX: VMAX, ACC: ACC, REV: REV, CARS: CARS, CAR_L: CAR_L, CAR_GAP: CAR_GAP, PITCH: PITCH, TRAIN_L: TRAIN_L,
  TRACK: TRACK, FLOOR: FLOOR, CHUNK: CHUNK, LOD_R: LOD_R, LINE_STYLE: LINE_STYLE
};

/* ===================================================================================== drawing (THREE) ===
 * view(c, sim, opts) -> V. c: hq3d's ctx (THREE, scene or root, canvasTex, avatar); opts: {calm(), night(), sfx(name, o),
 * under() (the integrator's underground flag), me() -> {x, y, z} (the walker, else c.avatar())}. Sounds through
 * opts.sfx with o.pos and o.kind (where they are: door chimes at each train, screen doors and gates where they stand,
 * each train's motor and tunnel rumble as held loops in one pool, rail joints): see sounds() below.
 * Everything static is merged into vertex-coloured buffers, one draw per material class:
 *   surface (always on, <= 8 draws): opaque, atlas (signs and every lit strip, vertex colour on the atlas's white
 *   cell), glass; the trains (body, line band, windows, door leaves, end caps) are 5 instanced meshes shared with
 *   the underground.
 *   underground (around the camera): tunnel opaque + lit (LOD chunks within LOD_R), signal aspects, then per built
 *   station (at most 3): opaque, tiles, atlas, glass, departure board; gate flaps, screen-door leaves, commuters.
 */
var WHITE_UV = [0.008, 0.992, 0.024, 0.976];   // the atlas's white cell [u0, v0, u1, v1] (v flipped: canvas top = 1)
function GB(){ return {p: [], n: [], c: [], uv: []}; }
function gbTri(B, a, b, d, col, ta, tb, td){
  var ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
  var nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx, l = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
  nx /= l; ny /= l; nz /= l;
  B.p.push(a[0], a[1], a[2], b[0], b[1], b[2], d[0], d[1], d[2]);
  B.n.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
  B.c.push(col[0], col[1], col[2], col[0], col[1], col[2], col[0], col[1], col[2]);
  ta = ta || [WHITE_UV[0], WHITE_UV[1]]; tb = tb || ta; td = td || ta;
  B.uv.push(ta[0], ta[1], tb[0], tb[1], td[0], td[1]);
}
// a quad a-b-c-d; uvq [u0, v0, u1, v1]: a (u0, v0), b (u1, v0), c (u1, v1), d (u0, v1)
function gbQuad(B, a, b, cc, d, col, uvq){
  var q = uvq || WHITE_UV;
  var ta = [q[0], q[1]], tb = [q[2], q[1]], tc = [q[2], q[3]], td = [q[0], q[3]];
  gbTri(B, a, b, cc, col, ta, tb, tc); gbTri(B, a, cc, d, col, ta, tc, td);
}
function frame(x, y, z, yaw){ return {x: x, y: y, z: z, s: Math.sin(yaw), c: Math.cos(yaw), yaw: yaw}; }
// frame-local (lx left, ly up, lz forward) -> world [x, y, z]
function tf(F, lx, ly, lz){ return [F.x + lx*F.c + lz*F.s, F.y + ly, F.z - lx*F.s + lz*F.c]; }
function gbBox(B, F, lx, ly, lz, hx, hy, hz, col, top){
  var P = [];
  for(var i = 0; i < 8; i++) P.push(tf(F, lx + (i & 1 ? hx : -hx), ly + (i & 2 ? hy : -hy), lz + (i & 4 ? hz : -hz)));
  gbQuad(B, P[2], P[3], P[7], P[6], top || col);    // top
  gbQuad(B, P[0], P[4], P[5], P[1], col);           // bottom
  gbQuad(B, P[0], P[1], P[3], P[2], col);           // -z
  gbQuad(B, P[4], P[6], P[7], P[5], col);           // +z
  gbQuad(B, P[0], P[2], P[6], P[4], col);           // -x
  gbQuad(B, P[1], P[5], P[7], P[3], col);           // +x
}
// a vertical quad in frame F from (lx0, lz0) to (lx1, lz1), heights y0..y1 (frame-relative), uv by metres/scale or uvq
function gbWall(B, F, lx0, lz0, lx1, lz1, y0, y1, col, uvScale, uvq){
  var a = tf(F, lx0, y0, lz0), b = tf(F, lx1, y0, lz1), cc = tf(F, lx1, y1, lz1), d = tf(F, lx0, y1, lz0);
  if(uvScale){ var L = hyp(lx1 - lx0, lz1 - lz0); uvq = [0, y0/uvScale, L/uvScale, y1/uvScale]; }
  gbQuad(B, a, b, cc, d, col, uvq);
}
// a horizontal quad in frame F: lateral lx0..lx1, along lz0..lz1, at height y (frame-relative)
function gbFlat(B, F, lx0, lx1, lz0, lz1, y, col, uvScale){
  var uvq = uvScale ? [lx0/uvScale, lz0/uvScale, lx1/uvScale, lz1/uvScale] : null;
  gbQuad(B, tf(F, lx0, y, lz0), tf(F, lx1, y, lz0), tf(F, lx1, y, lz1), tf(F, lx0, y, lz1), col, uvq);
}
// a sign facing world yaw nYaw (its readable side), centred at world (x, y, z)
function gbSign(B, x, y, z, nYaw, w, h, uvq, col){
  var rx = Math.cos(nYaw), rz = -Math.sin(nYaw), hw = w/2, hh = h/2;
  gbQuad(B, [x - rx*hw, y - hh, z - rz*hw], [x + rx*hw, y - hh, z + rz*hw], [x + rx*hw, y + hh, z + rz*hw], [x - rx*hw, y + hh, z - rz*hw], col || [1, 1, 1], uvq);
}
// extrude a profile ([[lat, up], ...]) along path samples ({x, y, z, s (sin yaw), c (cos yaw)}); col(i) per sample gap
// a two-faced sign: each face 0.015 m out along its own normal, so neither shows through mirrored
function gbSign2(B, x, y, z, nYaw, w, h, uvq, col){
  var nx = Math.sin(nYaw)*0.015, nz = Math.cos(nYaw)*0.015;
  gbSign(B, x + nx, y, z + nz, nYaw, w, h, uvq, col); gbSign(B, x - nx, y, z - nz, nYaw + PI, w, h, uvq, col);
}
function gbExtrude(B, S, prof, col, closed){
  var E = closed ? prof.length : prof.length - 1;
  for(var i = 0; i + 1 < S.length; i++){
    var A = S[i], Bq = S[i + 1], cl = typeof col === "function" ? col(i, A, Bq) : col;
    for(var k = 0; k < E; k++){
      var q0 = prof[k], q1 = prof[(k + 1) % prof.length];
      gbQuad(B, [A.x + q0[0]*A.c, A.y + q0[1], A.z - q0[0]*A.s], [Bq.x + q0[0]*Bq.c, Bq.y + q0[1], Bq.z - q0[0]*Bq.s],
                [Bq.x + q1[0]*Bq.c, Bq.y + q1[1], Bq.z - q1[0]*Bq.s], [A.x + q1[0]*A.c, A.y + q1[1], A.z - q1[0]*A.s], cl);
    }
  }
}
// a slab seen from above and the sides along lz: top + the two faces across lz (steps, sleepers): 6 triangles
function gbSlab(B, F, lx, ly, lz, hx, hy, hz, col, top){
  var a = tf(F, lx - hx, ly + hy, lz - hz), b = tf(F, lx + hx, ly + hy, lz - hz), cc = tf(F, lx + hx, ly + hy, lz + hz), d = tf(F, lx - hx, ly + hy, lz + hz);
  gbQuad(B, a, b, cc, d, top || col);
  gbQuad(B, tf(F, lx - hx, ly - hy, lz - hz), tf(F, lx + hx, ly - hy, lz - hz), b, a, col);
  gbQuad(B, d, cc, tf(F, lx + hx, ly - hy, lz + hz), tf(F, lx - hx, ly - hy, lz + hz), col);
}
function gbTris(B){ return B.p.length/9; }
function gbAppend(D, S){ for(var k in D) if(own(D, k) && S[k]) Array.prototype.push.apply(D[k], S[k]); return D; }
function gbConcat(list){
  var n = 0, nu = 0, i, o = {p: null, n: null, c: null, uv: null};
  list.forEach(function(B){ n += B.p.length; nu += B.uv.length; });
  o.p = new Float32Array(n); o.n = new Float32Array(n); o.c = new Float32Array(n); o.uv = new Float32Array(nu);
  var at = 0, au = 0;
  list.forEach(function(B){ for(i = 0; i < B.p.length; i++){ o.p[at + i] = B.p[i]; o.n[at + i] = B.n[i]; o.c[at + i] = B.c[i]; } for(i = 0; i < B.uv.length; i++) o.uv[au + i] = B.uv[i]; at += B.p.length; au += B.uv.length; });
  return o;
}
// samples of a line's path from s0 to s1 (its corners kept), at most `step` m apart, plus `extra` cut points
function pathSamples(P, s0, s1, step, extra){
  var cuts = [s0, s1], i;
  for(i = 1; i < P.S.length - 1; i++) if(P.S[i] > s0 && P.S[i] < s1) cuts.push(P.S[i]);
  (extra || []).forEach(function(s){ if(s > s0 && s < s1) cuts.push(s); });
  cuts.sort(function(a, b){ return a - b; });
  var ss = [];
  for(i = 0; i + 1 < cuts.length; i++){
    var a = cuts[i], b = cuts[i + 1], n = Math.max(1, Math.ceil((b - a)/step));
    for(var k = 0; k < n; k++) ss.push(a + (b - a)*k/n);
  }
  ss.push(s1);
  var out = [];
  ss.forEach(function(s){
    if(out.length && s - out[out.length - 1].sv < 0.02) return;
    var a2 = pathAt(P, s), i2 = segIdx(P, s), yaw = a2.yaw;
    // at a corner use the mean heading so the extrusion mitres
    if(i2 > 0 && Math.abs(s - P.S[i2]) < 0.02){ var b0 = P.pts[i2 - 1], b1 = P.pts[i2]; var y0 = Math.atan2(b1.x - b0.x, b1.z - b0.z); yaw = y0 + wrapA(yaw - y0)/2; }
    out.push({x: a2.x, y: a2.y, z: a2.z, s: Math.sin(yaw), c: Math.cos(yaw), sv: s, kind: a2.kind});
  });
  return out;
}
// the colour bank (linear rgb)
var C = {
  concrete: rgb(0xb5b2ac), concreteD: rgb(0x8f8c86), joint: rgb(0x6b6964), bed: rgb(0x77736c), sleeper: rgb(0x9c978e),
  rail: rgb(0x8a8f96), railTop: rgb(0xc9ced4), third: rgb(0x55595e), insul: rgb(0xe8e4d8), tray: rgb(0x5a5e63),
  walk: rgb(0x9a958c), handrail: rgb(0xe0b422), signal: rgb(0x2a2d31), lamp: rgb(0xf4f8ff), strip: rgb(0xdfeeff),
  floorHall: rgb(0xcfc8bb), platform: rgb(0xd8d3c8), tactile: rgb(0xf2c230), ceiling: rgb(0x9aa0a6), tileW: rgb(0xf1eee6),
  frame: rgb(0x2f3438), canopy: rgb(0x3c4248), step: rgb(0xb9b4aa), nosing: rgb(0xf2c230), esc: rgb(0x3a3e43),
  well: rgb(0xd9d4ca), veil: rgb(0x2a2724), glow: rgb(0xfff1d6), ballast: rgb(0x8b857a), shed: rgb(0x7e8b96), shedRoof: rgb(0x58646e),
  bench: rgb(0x6b4a33), machine: rgb(0x2c5d8a), screen: rgb(0xbfe3ff), gate: rgb(0x4a4f55), seat: rgb(0x2f4a7a),
  pole: rgb(0xe0b422), body: rgb(0xf3f4f5), under: rgb(0x2a2d31), interior: rgb(0xe9ebee), floorCar: rgb(0x5c6066),
  black: rgb(0x111316), bogie: rgb(0x1f2226), gangway: rgb(0x26292d), head: rgb(0xfff6d8), doorWin: rgb(0x3a4a58), tail: rgb(0xd83a2a), white: [1, 1, 1]
};

// The sign atlas (1024 x 1024): [x, y, w, h] in px, and uv quads.
var AT = 1024;
function atUv(r, inset){ inset = inset == null ? 1 : inset; return [(r[0] + inset)/AT, 1 - (r[1] + r[3] - inset)/AT, (r[0] + r[2] - inset)/AT, 1 - (r[1] + inset)/AT]; }
function atlasPlan(lines, stations){
  var P = {white: [0, 0, 32, 32], logo: [64, 0, 64, 64], badge: {}, wayout: [448, 0, 256, 64], il: [704, 0, 320, 64], lineName: {}, station: {}, map: [0, 768, 1024, 256]};
  lines.forEach(function(L, i){ if(i < 4) P.badge[L.id] = [128 + 64*i, 0, 64, 64]; P.lineName[L.id] = [(i % 2)*512, 64 + 64*Math.floor(i/2), 512, 64]; });
  var y0 = 64 + 64*Math.ceil(Math.max(1, lines.length)/2);
  stations.forEach(function(s, i){ var row = Math.floor(i/2); if(y0 + 64*row + 64 <= 768) P.station[s.id] = [(i % 2)*512, y0 + 64*row, 512, 64]; });
  return P;
}

function view(c, sim, opts){
  opts = opts || {};
  var THREE = c.THREE, Lay = sim.layout(), D = sim.data, seed = sim.seed;
  var root3 = new THREE.Group(); root3.name = "metro";
  var surf = new THREE.Group(); surf.name = "metro:surface"; root3.add(surf);
  var veil = null, veilFrom = 0;
  function veilShow(){ if(veil) veil.geometry.setDrawRange(0, isUnderOn ? veilFrom : Infinity); }
  var under = new THREE.Group(); under.name = "metro:underground"; under.visible = false; root3.add(under);
  var trainsG = new THREE.Group(); trainsG.name = "metro:trains"; root3.add(trainsG);
  var parent = c.scene || c.root || c.S || null;
  if(parent && parent.add) parent.add(root3);
  var disp = [];   // geometries, materials and textures to dispose
  function keep(x){ disp.push(x); return x; }
  function calm(){
    try { if(opts.calm && opts.calm()) return true; } catch(e){}
    try { if(c.E && c.E.calm && c.E.calm()) return true; } catch(e){}
    try { return !!(root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch(e){ return false; }
  }
  function night(){ try { return !!(opts.night && opts.night()); } catch(e){ return false; } }
  function sfx(name, o){ try { if(opts.sfx) return opts.sfx(name, o || {}); } catch(e){} return null; }
  function me(){
    try { if(opts.me){ var m = opts.me(); if(m) return m; } } catch(e){}
    try { var a = c.avatar && c.avatar(); if(a) return {x: a.x, y: a.hy != null ? a.hy : null, z: a.z}; } catch(e){}
    return null;
  }
  function canvasTex(w, h, draw){
    try { if(c.canvasTex){ var t = c.canvasTex(w, h, draw); if(t && t.t){ keep(t.t); return t; } } } catch(e){}
    var tx = keep(new THREE.Texture()); return {t: tx, g: null, c: null};
  }
  function toGeo(B){
    var g = new THREE.BufferGeometry(), o = B.p && B.p.BYTES_PER_ELEMENT ? B : gbConcat([B]);
    g.setAttribute("position", new THREE.BufferAttribute(o.p, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(o.n, 3));
    g.setAttribute("color", new THREE.BufferAttribute(o.c, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(o.uv, 2));
    g.computeBoundingSphere();
    return keep(g);
  }
  function mesh(B, m, name){ var x = new THREE.Mesh(toGeo(B), m); x.name = name || ""; x.matrixAutoUpdate = false; x.updateMatrix(); return x; }
  var DS = THREE.DoubleSide;

  /* ---- textures */
  var stopName = {}; sim.stops().forEach(function(s){ stopName[s.id] = s.name; });
  var lineList = D.lines.slice();
  var AP = atlasPlan(lineList, D.stations);
  function badgeCol(L){ return L ? L.color : "#888888"; }
  var atlas = canvasTex(AT, AT, function(g){
    if(!g || !g.fillRect) return;
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, 32, 32);
    function panel(r, bg){ g.fillStyle = bg; g.fillRect(r[0], r[1], r[2], r[3]); }
    function text(t, x, y, size, color, align, weight){ g.fillStyle = color; g.font = (weight || "700") + " " + size + "px system-ui, -apple-system, sans-serif"; g.textAlign = align || "center"; g.textBaseline = "middle"; g.fillText(t, x, y); }
    // the "M": red and blue halves, white letter
    var r = AP.logo; panel(r, "#d23a32"); g.fillStyle = "#2f6fd6"; g.fillRect(r[0] + r[2]/2, r[1], r[2]/2, r[3]); text("M", r[0] + r[2]/2, r[1] + r[3]/2 + 2, 48, "#ffffff");
    lineList.forEach(function(L){
      var b = AP.badge[L.id]; if(b){ panel(b, "#ffffff"); g.fillStyle = badgeCol(L); g.beginPath(); if(g.arc){ g.arc(b[0] + 32, b[1] + 32, 29, 0, 7); g.fill(); } else g.fillRect(b[0] + 4, b[1] + 4, 56, 56); text(L.short, b[0] + 32, b[1] + 34, 26, "#ffffff"); }
      var n = AP.lineName[L.id]; if(n){ panel(n, "#20262c"); g.fillStyle = badgeCol(L); g.fillRect(n[0], n[1] + n[3] - 8, n[2], 8); text(L.short + " · " + L.name, n[0] + n[2]/2, n[1] + 28, 34, "#ffffff"); }
    });
    panel(AP.wayout, "#f2c230"); text("Way out →", AP.wayout[0] + AP.wayout[2]/2, AP.wayout[1] + 33, 36, "#111316");
    // the railway platforms under a metro hall: the City Line's in City Gen v5 (an Island Link one only where it is)
    var ilCL = Lay.stations.some(function(s){ return s.il.some(function(r){ return (r.lines || []).indexOf("IL") < 0; }); });
    panel(AP.il, ilCL ? "#1f4a33" : "#1f3b2e"); text(ilCL ? "CL · City Line" : "IL · Island Link", AP.il[0] + AP.il[2]/2, AP.il[1] + 33, 32, "#ffffff");
    D.stations.forEach(function(s){
      var q = AP.station[s.id]; if(!q) return;
      panel(q, "#16324f"); g.fillStyle = "#ffffff"; g.fillRect(q[0], q[1] + q[3] - 6, q[2], 3);
      text(stopName[s.id] || s.id, q[0] + 20, q[1] + 30, 34, "#ffffff", "left");
      s.lines.forEach(function(id, i){ var L = sim.lineData(id); g.fillStyle = badgeCol(L); g.fillRect(q[0] + q[2] - 70 - 64*i, q[1] + 12, 56, 36); text(id, q[0] + q[2] - 42 - 64*i, q[1] + 31, 24, "#ffffff"); });
    });
    // the line map: every line as a straight strip of its stations, interchanges ringed
    var m = AP.map; panel(m, "#f6f4ee");
    text("Metro", m[0] + 24, m[1] + 26, 26, "#111316", "left");
    lineList.forEach(function(L, i){
      var y = m[1] + 80 + i*80, x0 = m[0] + 60, x1 = m[0] + m[2] - 60, n = Math.max(2, L.stops.length);
      g.fillStyle = badgeCol(L); g.fillRect(x0, y - 6, x1 - x0, 12);
      text(L.short, x0 - 30, y, 22, badgeCol(L));
      L.stops.forEach(function(q, k){ var x = x0 + (x1 - x0)*k/(n - 1); g.fillStyle = "#ffffff"; g.fillRect(x - 8, y - 8, 16, 16); text(String(stopName[q.id] || "").slice(0, 16), x, y + 26, 15, "#111316", "center", "600"); });
    });
  });
  var tiles = canvasTex(128, 128, function(g){
    if(!g || !g.fillRect) return;
    g.fillStyle = "#c9c4ba"; g.fillRect(0, 0, 128, 128); g.fillStyle = "#ffffff";
    for(var i = 0; i < 4; i++) for(var j = 0; j < 4; j++) g.fillRect(i*32 + 1, j*32 + 1, 30, 30);
  });
  try { tiles.t.wrapS = tiles.t.wrapT = THREE.RepeatWrapping; } catch(e){}

  /* ---- materials (shared) */
  var M = {
    op: keep(new THREE.MeshStandardMaterial({vertexColors: true, roughness: 0.85, metalness: 0.05, side: DS})),
    atlas: keep(new THREE.MeshBasicMaterial({map: atlas.t, vertexColors: true, toneMapped: false, side: DS})),
    glass: keep(new THREE.MeshStandardMaterial({color: 0xa9cfdf, transparent: true, opacity: 0.26, roughness: 0.05, metalness: 0.3, depthWrite: false, side: DS})),
    tile: keep(new THREE.MeshStandardMaterial({map: tiles.t, vertexColors: true, roughness: 0.32, metalness: 0.02, side: DS})),
    body: keep(new THREE.MeshStandardMaterial({vertexColors: true, roughness: 0.35, metalness: 0.25, side: DS})),
    band: keep(new THREE.MeshStandardMaterial({color: 0xffffff, roughness: 0.4, metalness: 0.2, side: DS})),
    win: keep(new THREE.MeshStandardMaterial({color: 0x0d1116, transparent: true, opacity: 0.55, roughness: 0.05, metalness: 0.6, depthWrite: false, side: DS,
      emissive: new THREE.Color(0xfff4dc), emissiveIntensity: 0})),
    leaf: keep(new THREE.MeshStandardMaterial({vertexColors: true, roughness: 0.35, metalness: 0.25, side: DS})),
    cap: keep(new THREE.MeshBasicMaterial({vertexColors: true, toneMapped: false, side: DS})),
    aspect: keep(new THREE.MeshBasicMaterial({color: 0xffffff, toneMapped: false})),
    flap: keep(new THREE.MeshStandardMaterial({color: 0xffffff, roughness: 0.3, transparent: true, opacity: 0.85, side: DS})),
    people: keep(new THREE.MeshStandardMaterial({color: 0xffffff, roughness: 0.8}))
  };

  /* ---- the surface: entrances, portals, depot and the open track */
  function trackStrip(Bop, S, lat, near){
    // a ballasted (or slab) track centred `lat` off the samples: bed, sleepers, two rails
    gbExtrude(Bop, S, [[lat - 1.6, -0.45], [lat - 1.2, -0.2], [lat + 1.2, -0.2], [lat + 1.6, -0.45]], C.bed);
    [-0.7175, 0.7175].forEach(function(g){ gbExtrude(Bop, S, [[lat + g - 0.035, -0.12], [lat + g - 0.035, 0], [lat + g + 0.035, 0], [lat + g + 0.035, -0.12]], C.rail); });
    if(near){
      for(var i = 0; i + 1 < S.length; i++){
        var A = S[i], Bq = S[i + 1], L = hyp(Bq.x - A.x, Bq.z - A.z), n = Math.floor(L/1.2);
        for(var k = 0; k < n; k++){ var u = (k + 0.5)/Math.max(1, L/1.2), x = A.x + (Bq.x - A.x)*u, y = A.y + (Bq.y - A.y)*u, z = A.z + (Bq.z - A.z)*u;
          gbSlab(Bop, frame(x, y, z, Math.atan2(Bq.x - A.x, Bq.z - A.z)), lat, -0.17, 0, 1.25, 0.05, 0.12, C.sleeper); }
      }
    }
  }
  var shotInfo = {};
  // the street works' material: as M.op, and it marks the stencil (1) wherever it draws, so the sea skips those pixels
  function stencilMark(m){ var o = keep(m.clone()); o.stencilWrite = true; o.stencilRef = 1; o.stencilFunc = THREE.AlwaysStencilFunc; o.stencilZPass = THREE.ReplaceStencilOp; return o; }
  function buildSurface(){
    var Bop = GB(), Bat = GB(), Bgl = GB(), Bveil = GB();
    Lay.entrances.forEach(function(E){
      var st = Lay.byId[E.station], drop = E.y - st.hallY, F = frame(E.x, E.y, E.z, E.yaw), hw = E.w/2, run = E.run, hole = Math.min(E.d, run);
      if(E.kind === "lift"){
        // a glass lift kiosk over the shaft
        [[-1.2, -0.0], [1.2, 0], [-1.2, 2.4], [1.2, 2.4]].forEach(function(p){ gbBox(Bop, F, p[0], 1.4, p[1], 0.06, 1.4, 0.06, C.frame); });
        gbBox(Bop, F, 0, 2.86, 1.2, 1.3, 0.08, 1.3, C.canopy);
        gbWall(Bgl, F, -1.2, 0, -1.2, 2.4, 0, 2.8, C.white); gbWall(Bgl, F, 1.2, 0, 1.2, 2.4, 0, 2.8, C.white); gbWall(Bgl, F, -1.2, 2.4, 1.2, 2.4, 0, 2.8, C.white);
        gbWall(Bgl, F, -1.2, 0, -0.5, 0, 0, 2.8, C.white); gbWall(Bgl, F, 0.5, 0, 1.2, 0, 0, 2.8, C.white);
        // the shaft lines the terrain hole (a little wider than the kiosk), so nothing shows past it
        var sx = 1.2, sz = 2.4;
        (E.hole || []).forEach(function(q){ var dx = q[0] - E.x, dz = q[1] - E.z; sx = Math.max(sx, Math.abs(dx*F.c - dz*F.s) + 0.02); sz = Math.max(sz, dx*F.s + dz*F.c + 0.02); });
        sx = Math.min(sx, 2.5); sz = Math.min(sz, 4);
        [[-sx, 0, -sx, sz], [sx, 0, sx, sz], [-sx, sz, sx, sz], [-sx, 0, sx, 0]].forEach(function(w){ gbWall(Bop, F, w[0], w[1], w[2], w[3], -drop, -0.05, C.well); });
        gbFlat(Bat, F, -sx + 0.1, sx - 0.1, 0.1, sz - 0.1, -drop + 0.02, C.glow);
        var lp = tf(F, 0, 3.25, 0); gbSign(Bat, lp[0], lp[1], lp[2], E.yaw + PI, 0.7, 0.7, atUv(AP.logo)); gbSign(Bat, lp[0], lp[1], lp[2], E.yaw, 0.7, 0.7, atUv(AP.logo));
      } else {
        // steps (or an escalator and steps) down the well, the well's walls inside the terrain hole, a glazed canopy
        var n = Math.max(4, Math.ceil(drop/0.18)), escW = E.kind === "escalator" ? Math.min(1.2, hw) : 0;
        for(var i = 0; i < n; i++){
          var z0 = run*i/n, z1 = run*(i + 1)/n, yT = -drop*(i + 1)/n;
          var x0 = -hw + (escW ? escW + 0.15 : 0), cx = (x0 + hw)/2, w2 = (hw - x0)/2;
          gbSlab(Bop, F, cx, yT - 0.12, (z0 + z1)/2, w2, 0.12, (z1 - z0)/2 + 0.01, C.step);
          gbFlat(Bop, F, cx - w2, cx + w2, z0, z0 + 0.1, yT + 0.004, C.nosing);
        }
        if(escW){
          // the band as a sloped quad strip, a balustrade and a black handrail each side
          gbQuad(Bop, tf(F, -hw, 0, 0), tf(F, -hw + escW, 0, 0), tf(F, -hw + escW, -drop, run), tf(F, -hw, -drop, run), C.esc);
          [-hw + 0.04, -hw + escW - 0.04].forEach(function(x){
            gbQuad(Bgl, tf(F, x, 0, 0), tf(F, x, 0, run), tf(F, x, -drop + 1.0, run), tf(F, x, 1.0, 0), C.white);
            gbQuad(Bop, tf(F, x - 0.04, 1.0, 0), tf(F, x + 0.04, 1.0, 0), tf(F, x + 0.04, -drop + 1.0, run), tf(F, x - 0.04, -drop + 1.0, run), C.black);
          });
        }
        [-hw, hw].forEach(function(x){ gbQuad(Bop, tf(F, x, 0, 0), tf(F, x, 0, run), tf(F, x, -drop - 0.3, run), tf(F, x, -0.3, 0), C.well); });
        gbWall(Bop, F, -hw, run, hw, run, -drop + 2.8, 0, C.well);
        // from the street the passage below is not drawn (the underground is off): a short dim box closes the view
        // past the foot of the stairs, so the sea under the island does not show through; hidden below the street
        gbFlat(Bveil, F, -hw, hw, run - 0.1, run + 6, -drop - 0.01, C.veil); gbFlat(Bveil, F, hw, -hw, run - 0.1, run + 6, -drop + 2.8, C.veil);
        gbWall(Bveil, F, -hw, run, -hw, run + 6, -drop, -drop + 2.8, C.veil); gbWall(Bveil, F, hw, run + 6, hw, run, -drop, -drop + 2.8, C.veil);
        gbWall(Bveil, F, hw, run + 6, -hw, run + 6, -drop, -drop + 2.8, C.veil);
        if(run > hole + 0.5) gbFlat(Bop, F, -hw, hw, hole, run, -0.25, C.well);
        gbFlat(Bat, F, -hw, hw, run - 0.2, run + 2.2, -drop + 0.02, C.glow);
        gbFlat(Bat, F, -hw + 0.2, hw - 0.2, Math.max(0.5, hole - 1), hole - 0.3, -0.3, C.strip);
        // the canopy: four posts, a glass roof on a frame, glass sides and end; open on the street side (lz < 0)
        var cz0 = -0.8, cz1 = hole + 0.2;
        [[-hw - 0.15, cz0], [hw + 0.15, cz0], [-hw - 0.15, cz1], [hw + 0.15, cz1]].forEach(function(p){ gbBox(Bop, F, p[0], 1.5, p[1], 0.07, 1.5, 0.07, C.frame); });
        gbBox(Bop, F, 0, 3.02, cz0, hw + 0.35, 0.09, 0.09, C.frame); gbBox(Bop, F, 0, 3.02, cz1, hw + 0.35, 0.09, 0.09, C.frame);
        gbBox(Bop, F, -hw - 0.3, 3.02, (cz0 + cz1)/2, 0.06, 0.06, (cz1 - cz0)/2, C.frame); gbBox(Bop, F, hw + 0.3, 3.02, (cz0 + cz1)/2, 0.06, 0.06, (cz1 - cz0)/2, C.frame);
        gbQuad(Bgl, tf(F, -hw - 0.35, 3.12, cz0 - 0.2), tf(F, hw + 0.35, 3.12, cz0 - 0.2), tf(F, hw + 0.35, 3.0, cz1 + 0.2), tf(F, -hw - 0.35, 3.0, cz1 + 0.2), C.white);
        gbWall(Bgl, F, -hw - 0.15, 0, -hw - 0.15, cz1, 0, 2.9, C.white); gbWall(Bgl, F, hw + 0.15, 0, hw + 0.15, cz1, 0, 2.9, C.white);
        gbWall(Bgl, F, -hw - 0.15, cz1, hw + 0.15, cz1, 0, 2.9, C.white);
        // the lit name sign on the street-side fascia (both faces)
        var sp = tf(F, 0, 3.42, cz0 - 0.05), q = AP.station[E.station], sw = Math.min(2*hw + 0.7, 4.6);
        if(q){ gbSign(Bat, sp[0], sp[1], sp[2], E.yaw + PI, sw, sw/8, atUv(q)); var sp2 = tf(F, 0, 3.42, cz0 + 0.05); gbSign(Bat, sp2[0], sp2[1], sp2[2], E.yaw, sw, sw/8, atUv(q)); }
      }
      // the totem: a post with the "M" and the line badges, lit, beside the way in
      var tx = hw + 1.0;
      gbBox(Bop, F, tx, 1.9, -0.9, 0.11, 1.9, 0.11, C.frame);
      [E.yaw + PI, E.yaw].forEach(function(ny, k){ var o = k ? 0.12 : -0.12, P = tf(F, tx, 3.85, -0.9 + o);
        gbSign(Bat, P[0], P[1], P[2], ny, 0.75, 0.75, atUv(AP.logo));
        st.lines.forEach(function(id, j){ var b = AP.badge[id]; if(!b) return; var Q = tf(F, tx + (j - (st.lines.length - 1)/2)*0.5*(k ? -1 : 1), 3.22, -0.9 + o); gbSign(Bat, Q[0], Q[1], Q[2], ny, 0.42, 0.42, atUv(b)); });
      });
      if(!shotInfo.entrance || (shotInfo.entrance.kind === "lift" && E.kind !== "lift")) shotInfo.entrance = E;      // the tour's: a stair, not a lift
    });
    // portals: a U-trench with retaining walls and parapets, a headwall with the line's name, a short box mouth
    D.portals.forEach(function(Pt){
      var L = sim.lineData(Pt.line); if(!L) return;
      // the trench follows the line (a portal on a curve curves with it, as its terrain hole does): sections from the
      // open end (s0) to the mouth (s1), each in its own frame across the track
      // which way along the line: toward its terrain hole (else the way it faces); the open end is the higher one
      var hw = Pt.w/2, P = L.P, q0 = nearestOn(P, Pt.x, Pt.z), hx = 0, hz = 0, H = Pt.hole || [];
      H.forEach(function(q){ hx += q[0]/H.length; hz += q[1]/H.length; });
      if(!H.length){ hx = Pt.x + Math.sin(Pt.yaw)*Pt.len/2; hz = Pt.z + Math.cos(Pt.yaw)*Pt.len/2; }
      var ap = pathAt(P, q0.s + Pt.len/2), am = pathAt(P, q0.s - Pt.len/2), dir = hyp(ap.x - hx, ap.z - hz) <= hyp(am.x - hx, am.z - hz) ? 1 : -1;
      var s0 = q0.s, s1 = clamp(q0.s + dir*Pt.len, 0, P.len);
      if(pathAt(P, s1).y > pathAt(P, s0).y){ var sw = s0; s0 = s1; s1 = sw; dir = -dir; }
      var n = Math.max(2, Math.ceil(Math.abs(s1 - s0)/4)), prev = null, Fs = [];
      for(var i = 0; i <= n; i++){
        var pa = pathAt(P, s0 + (s1 - s0)*i/n), Fk = frame(pa.x, 0, pa.z, dir > 0 ? pa.yaw : pa.yaw + PI), cur = {F: Fk, f: pa.y - 0.5, top: Pt.y + 1.1, ry: pa.y};
        Fs.push(Fk);
        if(prev){
          gbQuad(Bop, tf(prev.F, -hw, prev.f, 0), tf(prev.F, hw, prev.f, 0), tf(cur.F, hw, cur.f, 0), tf(cur.F, -hw, cur.f, 0), C.concreteD);
          [-1, 1].forEach(function(e){
            var x = e*hw, x2 = e*(hw + 0.45);
            gbQuad(Bop, tf(prev.F, x, prev.f, 0), tf(cur.F, x, cur.f, 0), tf(cur.F, x, cur.top, 0), tf(prev.F, x, prev.top, 0), (i & 1) ? C.concrete : C.concreteD);
            gbQuad(Bop, tf(prev.F, x, prev.top, 0), tf(prev.F, x2, prev.top, 0), tf(cur.F, x2, cur.top, 0), tf(cur.F, x, cur.top, 0), C.concreteD);
            gbQuad(Bop, tf(prev.F, x2, prev.top, 0), tf(prev.F, x2, Pt.y - 0.6, 0), tf(cur.F, x2, Pt.y - 0.6, 0), tf(cur.F, x2, cur.top, 0), C.concrete);
          });
        }
        prev = cur;
      }
      var Fe = prev.F, ryM = prev.ry, top = Pt.y + 1.1, roof = ryM + 5.6;
      if(roof < top){
        gbWall(Bop, Fe, -hw - 2, 0, hw + 2, 0, roof, top + 0.3, C.concrete);
        gbBox(Bop, Fe, 0, top + 0.3, -0.3, hw + 2, 0.15, 0.4, C.concreteD);
        var nm = AP.lineName[Pt.line], sp = tf(Fe, 0, (roof + top)/2, -0.08);
        if(nm) gbSign(Bat, sp[0], sp[1], sp[2], Fe.yaw + PI, Math.min(2*hw, 8), Math.min(2*hw, 8)/8, atUv(nm));
      }
      // the mouth: 12 m of box tunnel into the hillside, dark inside
      gbFlat(Bop, Fe, -hw, hw, 0, 12, roof, C.concreteD); gbFlat(Bop, Fe, -hw, hw, 0, 12, ryM - 0.5, C.concreteD);      // its roof and floor
      gbWall(Bop, Fe, -hw, 0, -hw, 12, ryM - 0.5, roof, C.joint); gbWall(Bop, Fe, hw, 0, hw, 12, ryM - 0.5, roof, C.joint);
      if(!shotInfo.portal) shotInfo.portal = {x: Pt.x, y: Pt.y, z: Pt.z, w: Pt.w, F0: Fs[0], Fe: Fe, ry: ryM};
    });
    // the open track (portal ramps, the approach), both tracks
    D.lines.forEach(function(L){
      var P = L.P;
      for(var i = 0; i < P.kinds.length; i++){
        if(UNDER_KINDS[P.kinds[i]]) continue;
        var S = pathSamples(P, P.S[i], P.S[i + 1], 6);
        trackStrip(Bop, S, -TRACK, true); trackStrip(Bop, S, TRACK, true);
      }
    });
    // depots: the yard, its sidings, a shed over the far half
    D.depots.forEach(function(d){
      if(d.poly.length >= 3){
        var cx = 0, cz = 0, yy = Infinity; d.poly.forEach(function(p){ cx += p[0]; cz += p[1]; }); cx /= d.poly.length; cz /= d.poly.length;
        d.tracks.forEach(function(t){ t.forEach(function(p){ yy = Math.min(yy, p.y); }); }); if(!isFinite(yy)) yy = 0;
        for(var i = 0; i < d.poly.length; i++){ var a = d.poly[i], b = d.poly[(i + 1) % d.poly.length]; gbTri(Bop, [cx, yy - 0.42, cz], [b[0], yy - 0.42, b[1]], [a[0], yy - 0.42, a[1]], C.ballast); }
      }
      d.tracks.forEach(function(t){ var P = pathOf({path: t.map(function(p){ return [p.x, p.y, p.z]; })}, 1); trackStrip(Bop, pathSamples(P, 0, P.len, 8), 0, true); });
      if(d.tracks.length){
        var t0 = d.tracks[0], yaw = Math.atan2(t0[t0.length - 1].x - t0[0].x, t0[t0.length - 1].z - t0[0].z), F = frame(t0[0].x, t0[0].y, t0[0].z, yaw);
        var u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
        d.tracks.forEach(function(t){ t.forEach(function(p){ var dx = p.x - F.x, dz = p.z - F.z, u = dx*F.s + dz*F.c, v = dx*F.c - dz*F.s; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }); });
        var su0 = (u0 + u1)/2, su1 = u1 - 4, sv0 = v0 - 3.5, sv1 = v1 + 3.5, H = 7.5;
        if(su1 - su0 > 20){
          gbFlat(Bop, F, sv0, sv1, su0, su1, H, C.shedRoof);
          gbWall(Bop, F, sv0, su0, sv0, su1, -0.4, H, C.shed); gbWall(Bop, F, sv1, su0, sv1, su1, -0.4, H, C.shed);
          gbWall(Bop, F, sv0, su0, sv1, su0, H - 1.6, H, C.shed);
          for(var u = su0; u <= su1 + 0.01; u += 10){ gbBox(Bop, F, sv0 + 0.2, H/2, u, 0.2, H/2, 0.2, C.frame); gbBox(Bop, F, sv1 - 0.2, H/2, u, 0.2, H/2, 0.2, C.frame); }
          for(var v = sv0 + 3; v < sv1 - 2; v += 6) gbFlat(Bat, F, v - 0.2, v + 0.2, su0 + 2, su1 - 2, H - 0.05, C.strip);
        }
        if(!shotInfo.depot) shotInfo.depot = {F: F, u0: u0, u1: u1, v0: v0, v1: v1};
      }
    });
    // the veil goes last in the opaque mesh: below the street its vertices are left out of the draw range (one draw call)
    veilFrom = Bop.p.length/3; gbAppend(Bop, Bveil);
    var gOp = mesh(Bop, M.opS || (M.opS = stencilMark(M.op)), "metro:surface:op"), gAt = mesh(Bat, M.atlas, "metro:surface:signs"), gGl = mesh(Bgl, M.glass, "metro:surface:glass");
    gOp.receiveShadow = true; gGl.renderOrder = 2; gOp.renderOrder = -20;     // before the sea (games/ocean.js), marking the stencil
    surf.add(gOp); surf.add(gAt); surf.add(gGl);
    veil = gOp; veilShow();
    return gbTris(Bop) + gbTris(Bat) + gbTris(Bgl);
  }

  /* ---- the trains: one car shape (body, band, windows), door leaves and end caps, all instanced */
  var gapsZ = [];   // the body's side panels run between the doors
  (function(){ var z = -CAR_L/2; DOORS_Z.forEach(function(dz){ gapsZ.push([z, dz - DOOR_W/2]); z = dz + DOOR_W/2; }); gapsZ.push([z, CAR_L/2]); })();
  function carGeos(){
    var Bb = GB(), Bn = GB(), Bw = GB(), Bl = GB(), Bc = GB(), F = frame(0, 0, 0, 0), hw = CAR_HW, fl = FLOOR;
    // the shell: side panels below and above the windows (between the doors), roof, floor, underframe, bogies
    gapsZ.forEach(function(g){
      var zc = (g[0] + g[1])/2, zh = (g[1] - g[0])/2;
      [-1, 1].forEach(function(e){
        gbBox(Bb, F, e*hw, fl + 0.48, zc, 0.04, 0.53, zh, C.body);            // lower panel (sill at fl + 1.0)
        gbBox(Bb, F, e*hw, fl + 2.33, zc, 0.04, 0.27, zh, C.body);            // above the windows
        gbBox(Bn, F, e*(hw + 0.045), fl + 0.78, zc, 0.01, 0.07, zh, C.white); // the line band
        gbWall(Bw, F, e*hw, g[0] + 0.15, e*hw, g[1] - 0.15, fl + 1.0, fl + 2.06, C.white);   // the black window band
      });
    });
    DOORS_Z.forEach(function(dz){ [-1, 1].forEach(function(e){ gbBox(Bb, F, e*hw, fl + 2.38, dz, 0.04, 0.22, DOOR_W/2, C.body); }); });
    gbBox(Bb, F, 0, fl + 2.68, 0, hw + 0.02, 0.08, CAR_L/2, C.body);              // roof
    gbBox(Bb, F, 0, fl + 2.8, 0, 0.9, 0.06, CAR_L/2 - 2, C.under);                // roof equipment line
    gbBox(Bb, F, 0, fl - 0.04, 0, hw - 0.04, 0.04, CAR_L/2, C.floorCar);          // floor
    gbBox(Bb, F, 0, fl - 0.4, 0, hw - 0.1, 0.32, CAR_L/2 - 0.4, C.under);         // underframe
    [-1, 1].forEach(function(e){ gbBox(Bb, F, 0, 0.42, e*(CAR_L/2 - 3), 1.2, 0.36, 1.4, C.bogie); });
    // the interior: a white ceiling with light strips, longitudinal seats, centre poles, ceiling rails
    gbBox(Bb, F, 0, fl + 2.52, 0, hw - 0.05, 0.02, CAR_L/2 - 0.2, C.interior);
    [-0.45, 0.45].forEach(function(x){ gbBox(Bb, F, x, fl + 2.49, 0, 0.09, 0.012, CAR_L/2 - 0.8, C.lamp); });
    [[-4.35, -1.95], [1.95, 4.35]].forEach(function(r){ [-1, 1].forEach(function(e){
      gbBox(Bb, F, e*(hw - 0.3), fl + 0.42, (r[0] + r[1])/2, 0.25, 0.05, (r[1] - r[0])/2, C.seat);
      gbBox(Bb, F, e*(hw - 0.07), fl + 0.72, (r[0] + r[1])/2, 0.04, 0.28, (r[1] - r[0])/2, C.seat);
      gbBox(Bb, F, e*(hw - 0.3), fl + 0.2, (r[0] + r[1])/2, 0.22, 0.2, (r[1] - r[0])/2 - 0.05, C.under);
    }); });
    DOORS_Z.concat([-3.15, 3.15]).forEach(function(z){ gbBox(Bb, F, 0, fl + 1.25, z, 0.025, 1.25, 0.025, C.pole); });
    [-0.55, 0.55].forEach(function(x){ gbBox(Bb, F, x, fl + 2.1, 0, 0.02, 0.02, CAR_L/2 - 1, C.pole); });
    // open gangways: a frame at each end, a dark bellows to the next car
    [-1, 1].forEach(function(e){
      var z = e*(CAR_L/2 - 0.05);
      gbBox(Bb, F, -1.05, fl + 1.25, z, 0.33, 1.25, 0.05, C.interior); gbBox(Bb, F, 1.05, fl + 1.25, z, 0.33, 1.25, 0.05, C.interior);
      gbBox(Bb, F, 0, fl + 2.35, z, 0.75, 0.17, 0.05, C.interior);
      gbBox(Bb, F, 0, fl + 1.2, e*(CAR_L/2 + CAR_GAP/4), 0.8, 1.25, CAR_GAP/4, C.gangway);
    });
    // a door leaf (0.7 m wide, white with a window), closed at local 0
    gbBox(Bl, F, 0, fl + 1.08, 0, 0.03, 1.08, 0.35, C.body);
    gbWall(Bl, F, 0.035, -0.27, 0.035, 0.27, fl + 1.05, fl + 2.0, C.doorWin); gbWall(Bl, F, -0.035, -0.27, -0.035, 0.27, fl + 1.05, fl + 2.0, C.doorWin);
    // an end cap (the train's face): white with a black windscreen and two headlights, at local z = 0 facing +z
    gbBox(Bc, F, 0, fl + 1.2, 0.05, hw, 1.45, 0.06, C.body);
    gbWall(Bc, F, -1.15, 0.12, 1.15, 0.12, fl + 1.0, fl + 2.3, C.black);
    gbBox(Bc, F, -0.95, fl + 0.45, 0.13, 0.22, 0.08, 0.02, C.head); gbBox(Bc, F, 0.95, fl + 0.45, 0.13, 0.22, 0.08, 0.02, C.head);
    gbBox(Bc, F, -0.95, fl + 0.25, 0.13, 0.1, 0.05, 0.02, C.tail); gbBox(Bc, F, 0.95, fl + 0.25, 0.13, 0.1, 0.05, 0.02, C.tail);
    return {body: toGeo(Bb), band: toGeo(Bn), win: toGeo(Bw), leaf: toGeo(Bl), cap: toGeo(Bc), tris: gbTris(Bb) + gbTris(Bn) + gbTris(Bw) + 24*gbTris(Bl)/CARS + gbTris(Bc)/2};
  }
  var CG = carGeos(), MAXT = 28, MAXC = MAXT*CARS;
  function inst(geo, m, n, name){ var x = new THREE.InstancedMesh(geo, m, n); x.count = 0; x.name = name; x.frustumCulled = false; x.visible = false; trainsG.add(x); return x; }
  var IB = inst(CG.body, M.body, MAXC, "metro:train:body"), IN = inst(CG.band, M.band, MAXC, "metro:train:band"), IW = inst(CG.win, M.win, MAXC, "metro:train:win");
  var IL = inst(CG.leaf, M.leaf, MAXC*24, "metro:train:doors"), IC = inst(CG.cap, M.cap, MAXT*2, "metro:train:ends");
  IW.renderOrder = 2;

  // commuters: hqCommute's figures when present, else a plain body + head
  var FIG = null;
  try { if(HQV.hqCommute && HQV.hqCommute.figures) FIG = HQV.hqCommute.figures(THREE); } catch(e){ FIG = null; }
  if(!FIG || !FIG.seated || !FIG.standing){
    var fs = GB(), fst = GB(), F0 = frame(0, 0, 0, 0);
    gbBox(fs, F0, 0, 0.75, 0, 0.2, 0.32, 0.14, C.white); gbBox(fs, F0, 0, 1.22, 0, 0.11, 0.12, 0.11, C.white); gbBox(fs, F0, 0, 0.35, 0.18, 0.18, 0.08, 0.22, C.white);
    gbBox(fst, F0, 0, 0.45, 0, 0.16, 0.45, 0.12, C.white); gbBox(fst, F0, 0, 1.2, 0, 0.21, 0.32, 0.14, C.white); gbBox(fst, F0, 0, 1.66, 0, 0.11, 0.12, 0.11, C.white);
    FIG = {seated: toGeo(fs), standing: toGeo(fst), material: M.people};
  }
  var MAXP = 600;
  var PS = new THREE.InstancedMesh(FIG.seated, FIG.material || M.people, MAXP), PT = new THREE.InstancedMesh(FIG.standing, FIG.material || M.people, MAXP);
  [PS, PT].forEach(function(x, i){ x.count = 0; x.visible = false; x.frustumCulled = false; x.name = i ? "metro:people:standing" : "metro:people:seated"; trainsG.add(x); });
  function paint(key){
    try { if(HQV.hqCommute && HQV.hqCommute.paint){ var p = HQV.hqCommute.paint(key); if(p && p.shirt) return p.shirt; } } catch(e){}
    var r = mulberry32(hash32(key)); return [0.25 + r()*0.7, 0.2 + r()*0.6, 0.2 + r()*0.7];
  }

  /* ---- the underground: tunnels by LOD chunk */
  var chunkCache = {}, chunkKey = "", tunnelMeshes = [], signals = [], chunkGen = 0;
  var AS = new THREE.InstancedMesh(keep(new THREE.BoxGeometry(0.16, 0.16, 0.06)), M.aspect, 400);
  AS.count = 0; AS.visible = false; AS.frustumCulled = false; AS.name = "metro:signals"; under.add(AS);
  function chunkGeo(L, ch, near){
    var Bop = GB(), Bem = GB(), sig = [], P = L.P, i, parts = [];
    // the underground stretches of the chunk, less the station boxes (they draw their own walls and track)
    for(var g = segIdx(P, ch.s0); g < P.kinds.length && P.S[g] < ch.s1; g++){
      if(!UNDER_KINDS[P.kinds[g]]) continue;
      var cut = [[Math.max(ch.s0, P.S[g]), Math.min(ch.s1, P.S[g + 1])]];
      L.stops.forEach(function(q){ var hl = (D.st[q.id] ? D.st[q.id].len : 90)/2 + 6, nx = [];
        cut.forEach(function(r){ if(q.s + hl <= r[0] || q.s - hl >= r[1]){ nx.push(r); return; } if(q.s - hl > r[0]) nx.push([r[0], q.s - hl]); if(q.s + hl < r[1]) nx.push([q.s + hl, r[1]]); });
        cut = nx; });
      cut.forEach(function(r){ parts.push({a: r[0], b: r[1], kind: P.kinds[g]}); });
    }
    parts.forEach(function(pt){
      var kind = pt.kind, a = pt.a, b = pt.b; if(b - a < 0.05) return;
      var bored = kind === "bored", ring = bored ? 1.5 : 5, jw = bored ? 0.15 : 0.12, extra = [];
      for(var r0 = Math.ceil(a/ring)*ring; r0 < b; r0 += ring){ extra.push(r0, r0 - jw); }
      var S = pathSamples(P, a, b, bored ? 1.5 : 5, extra);
      var col = function(k, A, Bq){ var m = ((A.sv + Bq.sv)/2) % ring; return m > ring - jw ? C.joint : C.concrete; };
      if(bored){
        [-TRACK, TRACK].forEach(function(lt){
          var prof = []; for(i = 0; i < 12; i++){ var t = i/12*2*PI; prof.push([lt + Math.cos(t)*2.85, 1.7 + Math.sin(t)*2.85]); }
          gbExtrude(Bop, S, prof, col, true);
        });
      } else {
        gbExtrude(Bop, S, [[-7.4, -0.5], [7.4, -0.5], [7.4, 5.6], [-7.4, 5.6]], col, true);
        for(var cs = Math.ceil(a/6)*6; cs < b; cs += 6){ var q = pathAt(P, cs); gbBox(Bop, frame(q.x, q.y, q.z, q.yaw), 0, 2.55, 0, 0.22, 3.05, 0.22, C.concreteD); }
      }
      var Sc = pathSamples(P, a, b, 8);
      [-TRACK, TRACK].forEach(function(lt){
        var e = lt < 0 ? -1 : 1;
        trackStrip(Bop, Sc, lt, near);
        // the third rail on insulators (outer side), the walkway with its handrail, the cable tray and its lit strip
        gbExtrude(Bop, Sc, [[lt + e*1.25, 0.12], [lt + e*1.35, 0.12], [lt + e*1.35, 0.22], [lt + e*1.25, 0.22]], C.third, true);
        var ww = bored ? 2.15 : 2.6, wy = 0.9;
        gbExtrude(Bop, Sc, [[lt + e*(ww - 0.4), wy], [lt + e*(ww + 0.4), wy], [lt + e*(ww + 0.4), wy - 0.12]], C.walk);
        gbExtrude(Bop, Sc, [[lt + e*(ww + 0.35), wy + 1.0], [lt + e*(ww + 0.35), wy + 1.05]], C.handrail);
        var tl = bored ? 2.45 : 3.6, ty = bored ? 2.9 : 3.3;
        gbExtrude(Bop, Sc, [[lt + e*(tl - 0.25), ty], [lt + e*(tl + 0.15), ty], [lt + e*(tl + 0.15), ty + 0.1]], C.tray);
        gbExtrude(Bem, Sc, [[lt + e*(tl - 0.2), ty - 0.03], [lt + e*(tl + 0.1), ty - 0.03]], C.strip);
        if(near) for(var si = Math.ceil(a/5)*5; si < b; si += 5){ var q2 = pathAt(P, si); gbBox(Bop, frame(q2.x, q2.y, q2.z, q2.yaw), lt + e*1.3, 0.07, 0, 0.05, 0.06, 0.05, C.insul); }
      });
      // lights every 25 m at the crown, signals every 200 m (and their aspects, dynamic)
      for(var ls = Math.ceil(a/25)*25; ls < b; ls += 25){
        var q3 = pathAt(P, ls), F3 = frame(q3.x, q3.y, q3.z, q3.yaw);
        if(bored){ gbBox(Bem, F3, -TRACK, 4.42, 0, 0.14, 0.04, 0.6, C.lamp); gbBox(Bem, F3, TRACK, 4.42, 0, 0.14, 0.04, 0.6, C.lamp); }
        else { gbBox(Bem, F3, -TRACK, 5.5, 0, 0.16, 0.05, 0.9, C.lamp); gbBox(Bem, F3, TRACK, 5.5, 0, 0.16, 0.05, 0.9, C.lamp); }
      }
      for(var gs = Math.ceil(a/200)*200; gs < b; gs += 200){
        var q4 = pathAt(P, gs), F4 = frame(q4.x, q4.y, q4.z, q4.yaw);
        [1, -1].forEach(function(dir){
          var lx = -dir*TRACK - dir*1.75;   // on the right of travel, beside its track
          gbBox(Bop, F4, lx, 1.1, 0, 0.06, 1.1, 0.06, C.signal);
          gbBox(Bop, F4, lx, 2.35, dir*0.05, 0.16, 0.32, 0.08, C.signal);
          var w0 = tf(F4, lx, 2.5, dir*0.14), w1 = tf(F4, lx, 2.2, dir*0.14);
          sig.push({line: L.id, dir: dir, s: gs, top: w0, low: w1, yaw: dir > 0 ? q4.yaw : q4.yaw + PI});
        });
      }
    });
    return {op: Bop, em: Bem, sig: sig, tris: gbTris(Bop) + gbTris(Bem)};
  }
  function updateTunnels(cam){
    var list = sim.segmentsNear(cam.x, cam.z, LOD_R), keys = [];
    list.forEach(function(ch){ keys.push(ch.key + (ch.near <= 150 ? "n" : "f")); });
    var key = keys.join(",");
    if(key === chunkKey) return;
    chunkKey = key; chunkGen++;
    var ops = [], ems = []; signals = [];
    list.forEach(function(ch, i){
      var k = keys[i], E = chunkCache[k];
      if(!E){ E = chunkCache[k] = chunkGeo(sim.lineData(ch.line), ch, ch.near <= 150); }
      E.gen = chunkGen; ops.push(E.op); ems.push(E.em); signals = signals.concat(E.sig);
    });
    Object.keys(chunkCache).forEach(function(k){ if(chunkGen - chunkCache[k].gen > 4) delete chunkCache[k]; });
    tunnelMeshes.forEach(function(m){ under.remove(m); m.geometry.dispose(); var i = disp.indexOf(m.geometry); if(i >= 0) disp.splice(i, 1); });
    tunnelMeshes = [];
    if(ops.length){
      var a = mesh(gbConcat(ops), M.op, "metro:tunnel:op"), b = mesh(gbConcat(ems), M.atlas, "metro:tunnel:lit");
      under.add(a); under.add(b); tunnelMeshes.push(a, b);
    }
  }

  /* ---- station interiors (the nearest three, built on demand and cached) */
  var stCache = {}, boardTex = {};
  function disposeBoards(id){ var bs = boardTex[id]; if(!bs) return; Object.keys(bs).forEach(function(k){ try { bs[k].dispose(); } catch(e){} }); delete boardTex[id]; }
  // [transit pass] a station's own signs (one 1024 px canvas, one draw a built station): the ticket machines, the gates,
  // each line's way down ("[M1] Red line · 1 Airport · 2 Laurel Street"), each platform edge ("1 · M1 to Airport"),
  // each exit by its street, "Mind the gap" and the line map with "You are here". Slots in px [x, y, w, h].
  function dirsOf(st, lid){
    var R0 = sim.runs(lid), out = [];
    if(!R0) return out;
    [R0.out, R0.back].forEach(function(run){
      if(!run.ev[st.id] || run.last === st.id) return;
      out.push({key: run.key, dir: run.dir, plat: sim.platNo(st.id, lid, run.key) || "", to: stopName[run.last] || ""});
    });
    out.sort(function(a, b){ return a.plat < b.plat ? -1 : 1; });
    return out;
  }
  function signTex(st){
    var P = {tickets: [0, 0, 512, 64], gates: [512, 0, 512, 64], gap: [0, 672, 512, 64], here: [512, 672, 512, 64], map: [0, 736, 1024, 288], line: {}, edge: {}, exit: {}};
    st.lines.forEach(function(lid, i){ if(i < 3) P.line[lid] = [0, 64 + 96*i, 1024, 96]; });
    var ek = 0; st.lines.forEach(function(lid){ dirsOf(st, lid).forEach(function(d){ if(ek < 6){ P.edge[lid + "|" + d.key] = [(ek % 2)*512, 352 + 64*Math.floor(ek/2), 512, 64]; ek++; } }); });
    var ents = Lay.entrances.filter(function(E){ return E.station === st.id; }), exitName = {};
    ents.forEach(function(E, i){ if(i < 4){ P.exit[E.id] = [(i % 2)*512, 544 + 64*Math.floor(i/2), 512, 64]; exitName[E.id] = (sim.streetNear && sim.streetNear(E.x, E.z)) || ""; } });
    var T0 = canvasTex(1024, 1024, function(g){
      if(!g || !g.fillRect) return;
      function panel(r, bg){ g.fillStyle = bg; g.fillRect(r[0], r[1], r[2], r[3]); }
      function text(t, x, y, size, color, align, weight, maxW){ g.fillStyle = color; g.font = (weight || "700") + " " + size + "px system-ui, -apple-system, sans-serif"; g.textAlign = align || "center"; g.textBaseline = "middle";
        if(maxW && g.measureText){ var sz = size; while(sz > 12 && g.measureText(t).width > maxW){ sz -= 2; g.font = (weight || "700") + " " + sz + "px system-ui, -apple-system, sans-serif"; } } g.fillText(t, x, y); }
      function badge(x, y, r, L){ g.fillStyle = badgeCol(L); g.beginPath(); if(g.arc){ g.arc(x, y, r, 0, 7); g.fill(); } else g.fillRect(x - r, y - r, 2*r, 2*r); text(L ? L.short : "?", x, y + 1, Math.round(r*0.9), "#ffffff"); }
      function arrow(x, y, sz, col){ g.fillStyle = col; g.beginPath(); if(g.moveTo){ g.moveTo(x - sz*0.5, y - sz*0.18); g.lineTo(x + sz*0.1, y - sz*0.18); g.lineTo(x + sz*0.1, y - sz*0.45); g.lineTo(x + sz*0.55, y); g.lineTo(x + sz*0.1, y + sz*0.45); g.lineTo(x + sz*0.1, y + sz*0.18); g.lineTo(x - sz*0.5, y + sz*0.18); g.closePath(); g.fill(); } }
      var r = P.tickets; panel(r, "#1d2b3a"); text("🎫  Tickets · single · day pass · card", r[0] + r[2]/2, r[1] + 33, 30, "#ffffff", "center", "700", r[2] - 24);
      r = P.gates; panel(r, "#f2c230"); text("Way in · tap your ticket at the gate", r[0] + r[2]/2, r[1] + 33, 28, "#111316", "center", "700", r[2] - 24);
      st.lines.forEach(function(lid){
        var q = P.line[lid]; if(!q) return; var L = sim.lineData(lid), ds = dirsOf(st, lid);
        panel(q, "#16324f"); g.fillStyle = badgeCol(L); g.fillRect(q[0], q[1] + q[3] - 8, q[2], 8);
        arrow(q[0] + 40, q[1] + 44, 54, "#ffffff"); badge(q[0] + 112, q[1] + 44, 34, L);
        text(L ? L.name : lid, q[0] + 160, q[1] + 44, 34, "#ffffff", "left", "700", 220);
        var x = q[0] + 400, wEach = (q[2] - 410)/Math.max(1, ds.length);
        ds.forEach(function(d, i){ var x0 = x + i*wEach; g.fillStyle = "#ffffff"; g.fillRect(x0, q[1] + 22, 44, 44); text(d.plat, x0 + 22, q[1] + 45, 30, "#16324f");
          text("to " + d.to, x0 + 56, q[1] + 45, 30, "#ffffff", "left", "600", wEach - 64); });
        if(!ds.length) text("trains end here", x, q[1] + 45, 30, "#ffffff", "left", "600");
      });
      st.lines.forEach(function(lid){ dirsOf(st, lid).forEach(function(d){
        var q = P.edge[lid + "|" + d.key]; if(!q) return; var L = sim.lineData(lid);
        panel(q, "#16324f"); g.fillStyle = "#ffffff"; g.fillRect(q[0] + 8, q[1] + 8, 48, 48); text(d.plat, q[0] + 32, q[1] + 33, 32, "#16324f");
        badge(q[0] + 92, q[1] + 32, 24, L); text("to " + d.to, q[0] + 128, q[1] + 33, 30, "#ffffff", "left", "700", q[2] - 140);
      }); });
      ents.forEach(function(E){
        var q = P.exit[E.id]; if(!q) return;
        panel(q, "#f2c230"); arrow(q[0] + 34, q[1] + 32, 40, "#111316");
        text("Way out" + (exitName[E.id] ? " · " + exitName[E.id] : ""), q[0] + 66, q[1] + 33, 30, "#111316", "left", "700", q[2] - 76);
      });
      r = P.gap; panel(r, "#111316"); g.fillStyle = "#f2c230"; g.fillRect(r[0], r[1], r[2], 6); g.fillRect(r[0], r[1] + r[3] - 6, r[2], 6); text("MIND THE GAP", r[0] + r[2]/2, r[1] + 33, 36, "#f2c230");
      r = P.here; panel(r, "#16324f"); text(stopName[st.id] || st.id, r[0] + r[2]/2, r[1] + 33, 32, "#ffffff", "center", "700", r[2] - 24);
      // the line map: every line as a strip of its stations; this one ringed red, "You are here"
      var m = P.map; panel(m, "#f6f4ee"); text("Metro lines · You are at " + (stopName[st.id] || ""), m[0] + 24, m[1] + 24, 24, "#111316", "left", "700", m[2] - 48);
      var rows = lineList.length, rowH = Math.min(64, (m[3] - 50)/Math.max(1, rows));
      lineList.forEach(function(L, i){
        var y = m[1] + 60 + i*rowH + rowH*0.3, x0 = m[0] + 90, x1 = m[0] + m[2] - 70, n = Math.max(2, L.stops.length);
        g.fillStyle = badgeCol(L); g.fillRect(x0, y - 5, x1 - x0, 10); badge(m[0] + 40, y, 18, L);
        L.stops.forEach(function(q2, k){ var x = x0 + (x1 - x0)*k/(n - 1), me2 = q2.id === st.id;
          g.fillStyle = me2 ? "#d23a32" : "#ffffff"; g.fillRect(x - (me2 ? 10 : 7), y - (me2 ? 10 : 7), me2 ? 20 : 14, me2 ? 20 : 14);
          if(g.strokeRect){ g.strokeStyle = "#111316"; g.lineWidth = 2; g.strokeRect(x - 7, y - 7, 14, 14); }
          text(String(stopName[q2.id] || "").slice(0, 18), x, y + 20, 14, me2 ? "#d23a32" : "#111316", "center", me2 ? "800" : "600"); });
      });
    });
    var uv = {tickets: atUv(P.tickets), gates: atUv(P.gates), gap: atUv(P.gap), here: atUv(P.here), map: atUv(P.map), line: {}, edge: {}, exit: {}};
    Object.keys(P.line).forEach(function(k){ uv.line[k] = atUv(P.line[k]); });
    Object.keys(P.edge).forEach(function(k){ uv.edge[k] = atUv(P.edge[k]); });
    Object.keys(P.exit).forEach(function(k){ uv.exit[k] = atUv(P.exit[k]); });
    return {t: T0.t, uv: uv, dirs: function(lid){ return dirsOf(st, lid); }};
  }
  function makeBoard(sid){
    var B = null;
    var st = Lay.byId[sid];
    try { if(HQV.hqRide && HQV.hqRide.boardTexture) B = HQV.hqRide.boardTexture(THREE, [], {at: st ? {x: st.x, z: st.z} : null}); } catch(e){ B = null; }
    if(B && B.texture){
      var u = B.uv || {u0: 0, v0: 0, u1: 1, v1: 1};
      return {t: B.texture, uv: [u.u0, u.v0, u.u1, u.v1], draw: function(rows, ms){ try { B.draw(rows, ms, true); } catch(e){} }, dispose: function(){ try { if(B.dispose) B.dispose(); } catch(e){} }};
    }
    var T = canvasTex(512, 160);
    return {t: T.t, uv: [0, 0, 1, 1], dispose: function(){}, draw: function(rows){
      var g = T.g; if(!g || !g.fillRect) return;
      g.fillStyle = "#0b0b0b"; g.fillRect(0, 0, 512, 160); g.font = "600 26px ui-monospace, monospace"; g.textBaseline = "middle";
      rows.slice(0, 4).forEach(function(r, i){ var y = 22 + i*38; g.fillStyle = "#ffb000"; g.textAlign = "left"; g.fillText(r.badge + "  " + String(r.dest).slice(0, 18), 14, y); g.textAlign = "right"; g.fillText(r.due, 498, y); });
      T.t.needsUpdate = true;
    }};
  }
  function clockText(ms){ var d = new Date(ms); var h = d.getUTCHours(), m = d.getUTCMinutes(); try { if(opts.clock){ var k = opts.clock(ms); if(k){ h = k.h; m = k.m; } } } catch(e){} return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m; }
  // a board's rows: the hall's (every train, with its platform) or one platform edge's (key "M1|o": that line and way)
  function boardRows(sid, ms, key){
    var rows = sim.departures(sid, ms, key ? 20 : 4);
    if(key){ var kk = key.split("|"); rows = rows.filter(function(r){ return r.line === kk[0] && String(r.vehicle).split(":")[1] === kk[1]; }).slice(0, 4); }
    return rows.map(function(r){
      var due = r.boarding ? "boarding" : r.due || clockText(r.at);
      var dest = key || !r.plat ? r.to : String(r.to).slice(0, 15) + " P" + r.plat;
      return {badge: r.short, short: r.short, line: r.line, color: r.color, dest: dest, to: r.to, due: due, plat: r.plat, at: r.at, boarding: r.boarding};
    });
  }
  // a platform box along frame F (rail level `rail`): trackbed, tracks, platforms, tiled walls, ceiling, light strips,
  // screen doors, benches, the frieze, boards and way-out signs. kind "side" | "island"; trackOff: each track's offset.
  function platformBox(G, F, rail, half, kind, trackOff, o){
    // (an island's outer walls stand 2.55 m out from each track: past the headwall's tunnel opening (2.45), which would
    // otherwise show a sliver of nothing beside the wall to a rider looking out of the tunnel at it)
    var plat = rail + FLOOR, ry = rail - F.y, py = plat - F.y, W = kind === "island" ? trackOff + 2.55 : trackOff + 1.5 + 4.6, top = py + 4.5, ext = half + 6;
    var platLat = kind === "island" ? [[-(trackOff - 1.5), trackOff - 1.5]] : [[-W, -(trackOff + 1.5)], [trackOff + 1.5, W]];
    gbFlat(G.op, F, -W, W, -ext, ext, ry - 0.5, C.bed);
    [-trackOff, trackOff].forEach(function(lt){
      [-0.7175, 0.7175].forEach(function(gg){ gbBox(G.op, F, lt + gg, ry - 0.06, 0, 0.035, 0.06, ext, C.rail); });
      gbBox(G.op, F, lt, ry - 0.3, 0, 1.25, 0.15, ext, C.bed);
      for(var z = -ext + 0.6; z < ext; z += 1.2) gbSlab(G.op, F, lt, ry - 0.17, z, 1.25, 0.05, 0.12, C.sleeper);
      var e = kind === "island" ? (lt < 0 ? -1 : 1) : (lt < 0 ? 1 : -1);   // the third rail away from the platform
      gbBox(G.op, F, lt + e*1.3, ry + 0.17, 0, 0.05, 0.05, ext, C.third);
    });
    platLat.forEach(function(pl, pi){
      var cx = (pl[0] + pl[1])/2, hw = (pl[1] - pl[0])/2;
      gbBox(G.op, F, cx, (ry - 0.5 + py)/2, 0, hw, (py - ry + 0.5)/2, half, C.platform);
      var edges = kind === "island" ? [pl[0] + 0.3, pl[1] - 0.3] : [pl[0] < 0 ? pl[1] - 0.3 : pl[0] + 0.3];
      edges.forEach(function(ex){ gbBox(G.op, F, ex, py + 0.004, 0, 0.25, 0.004, half, C.tactile); });
      // light strips over the platform, broken where the stairs come down
      for(var z2 = -half + 2; z2 < half - 2; z2 += 10){ var Ls = tf(F, cx, top, z2 + 4); if((o.holes || []).some(function(r){ return inRect(r, Ls[0], Ls[2], 4); })) continue; gbBox(G.at, F, cx, top - 0.06, z2 + 4, 0.12, 0.03, 3.8, C.strip); }
      // benches every 15 m, clear of the stairs
      for(var bz = -half + 7; bz < half - 4; bz += 15){ if(o.clear && !o.clear(bz)) continue; gbBox(G.op, F, cx + (kind === "island" ? 0 : (pl[0] < 0 ? 0.9 : -0.9)), py + 0.42, bz, 0.22, 0.04, 0.9, C.bench); gbBox(G.op, F, cx + (kind === "island" ? 0 : (pl[0] < 0 ? 0.9 : -0.9)), py + 0.2, bz, 0.05, 0.2, 0.75, C.frame); }
      // platform boards (two-faced) at +-6 m and way-out signs at the stair feet
      if(o.board) [-6, 6].forEach(function(bz){ var P = tf(F, cx, py + 3.3, bz); o.board.push({x: P[0], y: P[1], z: P[2], yaw: F.yaw, w: 2.4, h: 0.6, two: true}); });
      (o.wayout || []).forEach(function(wz){ var P = tf(F, cx, py + 3.1, wz); gbSign2(G.at, P[0], P[1], P[2], F.yaw + (wz > 0 ? PI : 0), 1.6, 0.4, atUv(AP.wayout)); });
    });
    // walls (tiled; a band of the line's colour), the ceiling, end walls with the tunnel openings
    [-W, W].forEach(function(x){ gbWall(G.tile, F, x, -ext, x, ext, ry - 0.5, top, o.tile || C.tileW, 1.2); gbWall(G.op, F, x*0.999, -ext, x*0.999, ext, py + 2.25, py + 2.45, o.band || C.tactile); });
    // [stations] the ceiling, open where a stair's tube comes down through it
    if(o.holes && o.holes.length){
      var Rc = rect(F.x, F.z, F.yaw, W, ext);
      minusRects([rectPoly(Rc, -ext, ext, -W, W)], o.holes).forEach(function(P){ for(var k = 1; k + 1 < P.length; k++) gbTri(G.op, [P[0][0], top + F.y, P[0][1]], [P[k][0], top + F.y, P[k][1]], [P[k + 1][0], top + F.y, P[k + 1][1]], C.ceiling); });
    } else gbFlat(G.op, F, -W, W, -ext, ext, top, C.ceiling);
    [-ext, ext].forEach(function(z){
      gbWall(G.tile, F, -W, z, W, z, ry + 4.8, top, o.tile || C.tileW, 1.2);
      if(o.bores){
        // [stations] the headwall closes round each track's bored tube exactly (its 12-sided ring), so no corner of the
        // opening shows past the tunnel
        var pcs = [[[-W, ry - 0.5], [W, ry - 0.5], [W, ry + 4.8], [-W, ry + 4.8]]];
        var ryE = o.endRail ? o.endRail(z) - F.y : ry;
        // (a terminus: no tunnel goes on past this end, the headwall is whole)
        if(o.tunnelOn && !o.tunnelOn(z)){ /* whole */ }
        else [-trackOff, trackOff].forEach(function(lt){ var ring = []; for(var i2 = 0; i2 < 12; i2++){ var t2 = i2/12*2*PI; ring.push([lt + Math.cos(t2)*2.45, ryE + 1.7 + Math.sin(t2)*2.45]); }   // (inside the bore's 2.85: it may turn where it starts)
          var nx = []; pcs.forEach(function(P){ nx = nx.concat(minusConvex(P, ring)); }); pcs = nx; });
        // (rings at the track's height at this end, where the tunnel starts)
        var tc = o.tile || C.tileW;
        pcs.forEach(function(P){ for(var k = 1; k + 1 < P.length; k++){ var A = P[0], B2 = P[k], C2 = P[k + 1];
          gbTri(G.tile, tf(F, A[0], A[1], z), tf(F, B2[0], B2[1], z), tf(F, C2[0], C2[1], z), tc, [A[0]/1.2, A[1]/1.2], [B2[0]/1.2, B2[1]/1.2], [C2[0]/1.2, C2[1]/1.2]); } });
        return;
      }
      gbWall(G.tile, F, -W, z, -trackOff - 2.5, z, ry - 0.5, ry + 4.8, o.tile || C.tileW, 1.2);
      gbWall(G.tile, F, trackOff + 2.5, z, W, z, ry - 0.5, ry + 4.8, o.tile || C.tileW, 1.2);
      if(trackOff > 2.6) gbWall(G.tile, F, -trackOff + 2.5, z, trackOff - 2.5, z, ry - 0.5, ry + 4.8, o.tile || C.tileW, 1.2);
    });
    // the frieze: the station's name along the walls facing the platforms
    if(o.frieze) [-W + 0.03, W - 0.03].forEach(function(x){ for(var z3 = -half + 6; z3 < half - 3; z3 += 12){ var P = tf(F, x, py + 2.85, z3); gbSign(G.at, P[0], P[1], P[2], F.yaw + (x < 0 ? PI/2 : -PI/2), 3.6, 0.45, o.frieze); } });
    // platform screen doors: glass between the train's door openings, a header over them; leaves are dynamic
    if(o.psd){
      var opens = []; for(var k = 0; k < CARS; k++) DOORS_Z.forEach(function(dz){ opens.push((1.5 - k)*PITCH + dz); });
      opens.sort(function(a, b){ return a - b; });
      var edgesL = kind === "island" ? [-(trackOff - CAR_HW - 0.1), trackOff - CAR_HW - 0.1] : [-(trackOff + CAR_HW + 0.1), trackOff + CAR_HW + 0.1];
      edgesL.forEach(function(ex){
        var z0 = -half + 0.5;
        opens.forEach(function(oz){ if(oz - 0.85 > z0) gbWall(G.gl, F, ex, z0, ex, oz - 0.85, py, py + 2.15, C.white); z0 = oz + 0.85; });
        if(half - 0.5 > z0) gbWall(G.gl, F, ex, z0, ex, half - 0.5, py, py + 2.15, C.white);
        gbBox(G.op, F, ex, py + 2.32, 0, 0.12, 0.17, half - 0.5, C.frame);
        gbBox(G.at, F, ex + (ex < 0 ? 0.13 : -0.13), py + 2.32, 0, 0.005, 0.03, half - 0.6, C.strip);
        // which direction stops at this edge: the track on this side
        var dir = ex < 0 ? 1 : -1;
        opens.forEach(function(oz){ o.psd.push({F: F, lat: ex, z: oz, y: py, dir: dir}); });
        if(o.edge) o.edge(F, ex, py, half, dir, opens);
      });
    }
  }
  // [stations] where each stair's tube goes through a ceiling at height top: the stretch of it whose underside is below
  // the ceiling and whose own ceiling is above it
  function tubeHoles(list, top){
    var out = [];
    list.forEach(function(f){
      var r = f.r, dy = f.y1 - f.y0; if(Math.abs(dy) < 1e-6) return;
      var ua = -r.hl + 2*r.hl*clamp((top + 0.3 - f.y0)/dy, 0, 1), ub = -r.hl + 2*r.hl*clamp((top - TUBE_H - f.y0)/dy, 0, 1);
      var u0 = Math.min(ua, ub), u1 = Math.max(ua, ub); if(u1 - u0 < 0.05) return;
      var A = rPoint(r, u0, 0), B = rPoint(r, u1, 0); out.push(rectAB(A.x, A.z, B.x, B.z, r.hw + 0.05));
    });
    return out;
  }
  function buildStation(st){
    var G = {op: GB(), tile: GB(), at: GB(), gl: GB(), wf: GB()}, boards = [], psd = [], gates = [], tris = 0;
    var s = D.st[st.id], q = AP.station[st.id], frz = q ? atUv(q) : null;
    var SG = signTex(st), SU = SG.uv;
    // platforms per line; at each edge (a direction): "1 · M1 to Airport" over it, its own departures board, "Mind the
    // gap" on the floor at every door of the train
    st.lines.forEach(function(lid){
      var a = s.at[lid], L = sim.lineData(lid), cp = pathAt(L.P, a.s), F = frame(cp.x, 0, cp.z, a.yaw);
      var myStairs = st.stairs.filter(function(f){ return f.line === lid; }), spans = [];
      // each stair's span along the platform (the frame's z), its foot's way-out sign 1.2 m past it
      var PF = rect(F.x, F.z, F.yaw, 0, 0), wz = [];
      myStairs.forEach(function(f){ var a0 = rLocal(PF, rPoint(f.r, -f.r.hl, 0).x, rPoint(f.r, -f.r.hl, 0).z).u, b0 = rLocal(PF, rPoint(f.r, f.r.hl, 0).x, rPoint(f.r, f.r.hl, 0).z).u;
        spans.push([Math.min(a0, b0), Math.max(a0, b0)]); if(f.plat === 0) wz.push(b0 + (b0 > a0 ? 1.2 : -1.2)); });
      var stairClear = function(z){ return !spans.some(function(q){ return z > q[0] - 1 && z < q[1] + 1; }); };
      platformBox(G, F, a.rail, s.len/2, s.platform, TRACK, {frieze: frz, psd: psd, board: null, wayout: wz, band: rgb(hexNum(L.color, 0x888888)), clear: stairClear, holes: tubeHoles(myStairs, a.rail + FLOOR + PLAT_H), bores: true, endRail: function(z){ return pathAt(L.P, clamp(a.s + z, 0, L.P.len)).y; },
        tunnelOn: function(z){ var s2 = a.s + z + (z > 0 ? 3 : -3); if(s2 < 0 || s2 > L.P.len) return false; var g = segIdx(L.P, s2); return !!UNDER_KINDS[L.P.kinds[Math.min(g, L.P.kinds.length - 1)]]; },
        edge: function(Fe, ex, py, half, dir, opens){
          var R0 = sim.runs(lid), run = R0 ? (R0.out.dir === dir ? R0.out : R0.back) : null; if(!run) return;
          var key = lid + "|" + run.key, inward = ex < 0 ? 1 : -1, o2 = -inward, uvE = SU.edge[key];
          if(uvE) [-(half - 9), 0, half - 9].forEach(function(z){ var P = tf(Fe, ex + inward*1.0, py + 3.05, z); gbSign2(G.wf, P[0], P[1], P[2], Fe.yaw + PI/2, 2.7, 0.34, uvE); });
          if(run.last !== st.id) [-12, 12].forEach(function(z){ var P = tf(Fe, ex + inward*1.0, py + 2.55, z); boards.push({x: P[0], y: P[1], z: P[2], yaw: Fe.yaw + PI/2, w: 2.4, h: 0.6, two: true, key: key}); });
          (opens || []).forEach(function(oz){
            var ln = ex + inward*1.25, lf = ex + inward*0.62, zl = oz + o2*1.1, zr = oz - o2*1.1;
            gbQuad(G.wf, tf(Fe, ln, py + 0.012, zl), tf(Fe, ln, py + 0.012, zr), tf(Fe, lf, py + 0.012, zr), tf(Fe, lf, py + 0.012, zl), [1, 1, 1], SU.gap);
          });
        }});
    });
    // [stations] stairs + escalators from the hall to the platforms: an open well at the head (tiled walls down from the
    // hall's floor, glass balustrades round it), then a closed tube (walls, a sloped ceiling with its light, the soffit
    // under the steps) down to the platform, where it comes in through the platform's ceiling
    st.stairs.concat(st.floors.filter(function(f){ return f.rail && f.kind === "stairs"; })).forEach(function(f){
      var r = f.r, Fs = frame(r.cx, 0, r.cz, r.yaw), n = Math.max(6, Math.ceil((f.y0 - f.y1)/0.18)), escW = f.rail ? 0 : 1.0, hw = r.hw, ww = hw + 0.05;
      var yAt = function(u){ return f.y0 + (f.y1 - f.y0)*clamp((u + r.hl)/(2*r.hl || 1), 0, 1); }, uw = -r.hl + (f.well || 0);
      for(var i = 0; i < n; i++){
        var u0 = -r.hl + 2*r.hl*i/n, u1 = -r.hl + 2*r.hl*(i + 1)/n, y = f.y0 + (f.y1 - f.y0)*(i + 1)/n;
        gbSlab(G.op, Fs, (-hw + escW + (escW ? 0.15 : 0) + hw)/2, y - 0.1, (u0 + u1)/2, (hw - escW - (escW ? 0.15 : 0))/2, 0.1, (u1 - u0)/2 + 0.01, C.step);
        gbFlat(G.op, Fs, -hw + escW + (escW ? 0.15 : 0), hw, u0, u0 + 0.08, y + 0.004, C.nosing);
      }
      if(escW){
        gbQuad(G.op, tf(Fs, -hw, f.y0, -r.hl), tf(Fs, -hw + escW, f.y0, -r.hl), tf(Fs, -hw + escW, f.y1, r.hl), tf(Fs, -hw, f.y1, r.hl), C.esc);
        [-hw + 0.03, -hw + escW].forEach(function(x){ gbQuad(G.gl, tf(Fs, x, f.y0, -r.hl), tf(Fs, x, f.y1, r.hl), tf(Fs, x, f.y1 + 1.0, r.hl), tf(Fs, x, f.y0 + 1.0, -r.hl), C.white);
          gbQuad(G.op, tf(Fs, x - 0.04, f.y0 + 1.0, -r.hl), tf(Fs, x + 0.04, f.y0 + 1.0, -r.hl), tf(Fs, x + 0.04, f.y1 + 1.0, r.hl), tf(Fs, x - 0.04, f.y1 + 1.0, r.hl), C.black); });
      }
      // the riser under the head (the first step is a step down from the hall's floor); a stair with no well (the Island
      // Link's, at the end of its passage) closes its head over the passage's ceiling
      gbWall(G.op, Fs, -ww, -r.hl, ww, -r.hl, f.y0 - 0.4, f.y0 + 0.002, C.step);
      if(!(f.well > 0)) gbWall(G.tile, Fs, -ww, -r.hl, ww, -r.hl, f.y0 + PASS_H - 0.02, f.y0 + TUBE_H + 0.02, C.tileW, 1.2);
      // the soffit under the whole flight
      gbQuad(G.op, tf(Fs, -ww, f.y0 - 0.3, -r.hl), tf(Fs, ww, f.y0 - 0.3, -r.hl), tf(Fs, ww, f.y1 - 0.3, r.hl), tf(Fs, -ww, f.y1 - 0.3, r.hl), C.concreteD);
      [-ww, ww].forEach(function(x){
        // the well's walls: from under the steps up to the hall's floor
        if(uw > -r.hl) gbQuad(G.tile, tf(Fs, x, f.y0 - 0.3, -r.hl), tf(Fs, x, yAt(uw) - 0.3, uw), tf(Fs, x, f.y0, uw), tf(Fs, x, f.y0, -r.hl), C.tileW, [0, 0, (uw + r.hl)/1.2, 2]);
        // the tube's walls: from under the steps to its ceiling
        gbQuad(G.tile, tf(Fs, x, yAt(uw) - 0.3, uw), tf(Fs, x, f.y1 - 0.3, r.hl), tf(Fs, x, f.y1 + TUBE_H, r.hl), tf(Fs, x, yAt(uw) + TUBE_H, uw), C.tileW, [0, 0, (r.hl - uw)/1.2, (TUBE_H + 0.3)/1.2]);
        // glass balustrades along the well, at the hall's floor
        if(uw > -r.hl){ gbWall(G.gl, Fs, x, -r.hl, x, uw, f.y0, f.y0 + 1.1, C.white); gbBox(G.op, Fs, x, f.y0 + 1.12, (uw - r.hl)/2, 0.04, 0.03, (uw + r.hl)/2, C.handrail); }
      });
      if(uw > -r.hl){ gbWall(G.gl, Fs, -ww, uw, ww, uw, f.y0, f.y0 + 1.1, C.white); gbBox(G.op, Fs, 0, f.y0 + 1.12, uw, ww, 0.03, 0.04, C.handrail); }
      // the tube's ceiling and its light
      gbQuad(G.op, tf(Fs, -ww, yAt(uw) + TUBE_H, uw), tf(Fs, ww, yAt(uw) + TUBE_H, uw), tf(Fs, ww, f.y1 + TUBE_H, r.hl), tf(Fs, -ww, f.y1 + TUBE_H, r.hl), C.ceiling);
      gbQuad(G.at, tf(Fs, -0.15, yAt(uw) + TUBE_H - 0.03, uw + 0.5), tf(Fs, 0.15, yAt(uw) + TUBE_H - 0.03, uw + 0.5), tf(Fs, 0.15, f.y1 + TUBE_H - 0.03, r.hl - 0.5), tf(Fs, -0.15, f.y1 + TUBE_H - 0.03, r.hl - 0.5), C.strip);
    });
    // over every stair head in the hall: the line it goes down to and both ways from its platform
    st.stairs.forEach(function(f){
      var uvL = SU.line[f.line]; if(!uvL) return;
      var A = rPoint(f.r, -f.r.hl - 0.4, 0); gbSign(G.wf, A.x, f.y0 + 2.95, A.z, f.r.yaw + PI, 4.4, 0.41, uvL);
    });
    // [stations] the ticket hall: a stone floor open only over the wells, a lit ceiling open only where an entrance's stairs
    // come down through it, tiled walls open exactly where a passage (or an entrance's stairs) comes in
    var h = st.hall, Fh = frame(h.cx, 0, h.cz, h.yaw), hy = st.hallY, cy = hy + HALL_H;
    var wells = st.stairs.filter(function(f){ return f.well > 0; }).map(function(f){ var r = f.r, A = rPoint(r, -r.hl, 0), B = rPoint(r, -r.hl + f.well, 0); return rectAB(A.x, A.z, B.x, B.z, r.hw + 0.05); });
    var myEnts = Lay.entrances.filter(function(E){ return E.station === st.id && E.kind !== "lift"; });
    var cHoles = [];
    myEnts.forEach(function(E){
      // the stretch of the entrance's stairs whose underside is below the hall's ceiling, up from its foot
      var R = E.ramp.r, slope = (E.y - hy)/(2*R.hl || 1), up = clamp((HALL_H + 0.3)/(slope || 1e-6), 0, 2*R.hl);
      var B = rPoint(R, R.hl, 0), A = rPoint(R, R.hl - up, 0);
      if(up > 0.05 && segRect(A.x, A.z, B.x, B.z, h, R.hw)) cHoles.push(rectAB(A.x, A.z, B.x, B.z, R.hw));
    });
    function polys(B, list, y, col){ list.forEach(function(P){ for(var k = 1; k + 1 < P.length; k++) gbTri(B, [P[0][0], y, P[0][1]], [P[k][0], y, P[k][1]], [P[k + 1][0], y, P[k + 1][1]], col); }); }
    for(var gu = -h.hl; gu < h.hl - 0.01; gu += 2) for(var gv = -h.hw; gv < h.hw - 0.01; gv += 2){
      var u2 = Math.min(h.hl, gu + 2), v2 = Math.min(h.hw, gv + 2), cell = [rectPoly(h, gu, u2, gv, v2)];
      polys(G.op, minusRects(cell, wells), hy, (Math.round((gu + h.hl)/2) + Math.round((gv + h.hw)/2)) % 2 ? C.floorHall : C.platform);
      polys(G.op, minusRects(cell, cHoles), cy, C.ceiling);
    }
    for(var lv = -h.hw + 3; lv < h.hw - 1; lv += 6) for(var lu = -h.hl + 1.5; lu < h.hl - 1.5; lu += 2){
      var Lm = rPoint(h, lu + 1, lv); if(cHoles.some(function(r){ return inRect(r, Lm.x, Lm.z, 0.6); }) || wells.some(function(r){ return inRect(r, Lm.x, Lm.z, 0.3); })) continue;
      gbFlat(G.at, Fh, lv - 0.15, lv + 0.15, lu, Math.min(lu + 2, h.hl - 1.5), cy - 0.02, C.strip);
    }
    // what comes in through the walls: passages (to their ceiling) and entrance stairs (from their steps up)
    var opens = [];
    st.floors.forEach(function(f){ if(f.kind === "passage") opens.push({r: f.r, lo: function(){ return hy; }, hi: function(){ return hy + PASS_H; }}); });
    myEnts.forEach(function(E){ var R = E.ramp.r; opens.push({r: R, lo: function(P){ var l = rLocal(R, P.x, P.z); return Lay.floorY(E.ramp, l) - 0.3; }, hi: function(){ return E.y - 0.25; }}); });
    function hallWall(u0, v0, u1, v1){
      var A = rPoint(h, u0, v0), B = rPoint(h, u1, v1), L = hyp(B.x - A.x, B.z - A.z), cut = [];
      opens.forEach(function(o){ var t = segRect(A.x, A.z, B.x, B.z, o.r); if(t) cut.push({t0: t[0], t1: t[1], o: o}); });
      cut.sort(function(a2, b2){ return a2.t0 - b2.t0; });
      function at(t){ return {x: A.x + (B.x - A.x)*t, z: A.z + (B.z - A.z)*t}; }
      function quad(t0, t1, ya0, ya1, yb0, yb1){   // from t0 to t1: bottom ya0 -> ya1, top yb0 -> yb1
        if(t1 - t0 < 1e-4 || (yb0 - ya0 < 0.005 && yb1 - ya1 < 0.005)) return;
        var P0 = at(t0), P1 = at(t1);
        gbQuad(G.tile, [P0.x, ya0, P0.z], [P1.x, ya1, P1.z], [P1.x, yb1, P1.z], [P0.x, yb0, P0.z], C.tileW, [t0*L/1.2, (ya0 - hy)/1.2, t1*L/1.2, (yb0 - hy)/1.2]);
      }
      var t = 0;
      cut.forEach(function(c2){
        if(c2.t0 > t) quad(t, c2.t0, hy, hy, cy, cy);
        var s0 = Math.max(t, c2.t0), s1 = c2.t1; if(s1 <= s0){ t = Math.max(t, s1); return; }
        var lo0 = clamp(c2.o.lo(at(s0)), hy, cy), lo1 = clamp(c2.o.lo(at(s1)), hy, cy), hi0 = clamp(c2.o.hi(at(s0)), hy, cy), hi1 = clamp(c2.o.hi(at(s1)), hy, cy);
        quad(s0, s1, hy, hy, lo0, lo1);              // under the opening (an entrance's steps still above the floor)
        quad(s0, s1, hi0, hi1, cy, cy);              // over it
        t = s1;
      });
      if(t < 1) quad(t, 1, hy, hy, cy, cy);
    }
    hallWall(-h.hl, -h.hw, h.hl, -h.hw); hallWall(-h.hl, h.hw, h.hl, h.hw); hallWall(-h.hl, -h.hw, -h.hl, h.hw); hallWall(h.hl, -h.hw, h.hl, h.hw);
    // [stations] a stair's own gate line across its head (another line's stairs on the street side of the hall's)
    (st.heads || []).forEach(function(H){
      var Fg = frame(H.r.cx, 0, H.r.cz, H.r.yaw);
      [-1.2, 0, 1.2].forEach(function(v){ gbBox(G.op, Fg, v, hy + 0.5, -0.2, 0.13, 0.5, 0.55, C.gate); gbBox(G.at, Fg, v, hy + 1.01, -0.6, 0.1, 0.01, 0.12, C.screen); });
      H.lanes.forEach(function(v){ var P = tf(Fg, v, hy, -0.2); gates.push({x: P[0], y: hy, z: P[2], yaw: H.r.yaw, e: 0, open: 0, beep: false}); });
      var Wg = tf(Fg, 0, hy + 2.4, -0.4); gbSign(G.wf, Wg[0], Wg[1], Wg[2], H.r.yaw + PI, 3.0, 0.38, SU.gates);
    });
    // [transit pass] the gate lines (past every entrance's foot, short of every stair head): nine cabinets, eight lanes,
    // glass out to the walls; e: the way to the paid side
    st.gates.forEach(function(GL){
      var e = GL.e, u = GL.u, ng = st.lanes.length;
      for(var g = 0; g <= ng; g++){ var v = -ng*0.55 + g*1.1; gbBox(G.op, Fh, v, hy + 0.5, u, 0.13, 0.5, 0.7, C.gate); gbBox(G.at, Fh, v, hy + 1.01, u - e*0.45, 0.1, 0.01, 0.12, C.screen); }
      st.lanes.forEach(function(gvv){ var P = tf(Fh, gvv, hy, u); gates.push({x: P[0], y: hy, z: P[2], yaw: h.yaw, e: e, open: 0, beep: false}); });
      gbWall(G.gl, Fh, -h.hw, u, -ng*0.55 - 0.15, u, hy, hy + 1.1, C.white); gbWall(G.gl, Fh, ng*0.55 + 0.15, u, h.hw, u, hy, hy + 1.1, C.white);
      var B = tf(Fh, 0, hy + 2.32, u); boards.push({x: B[0], y: B[1], z: B[2], yaw: h.yaw + (e > 0 ? PI : 0), w: 3.2, h: 0.75, two: true});
      // over the gates: "Way out" towards the paid side; towards the street side "Way in · tap your ticket" and the
      // lines beyond (their stair heads are past the gates)
      var W1 = tf(Fh, 2.4, hy + 2.85, u + e*0.115);
      gbSign(G.at, W1[0], W1[1], W1[2], h.yaw + (e > 0 ? 0 : PI), 1.6, 0.4, atUv(AP.wayout));
      var Wg = tf(Fh, 0, hy + 2.98, u - e*0.12); gbSign(G.wf, Wg[0], Wg[1], Wg[2], h.yaw + (e > 0 ? PI : 0), 3.6, 0.45, SU.gates);
      st.lines.forEach(function(lid, li){ var uvL = SU.line[lid]; if(!uvL) return; var n = Math.min(3, st.lines.length), vv = (li - (n - 1)/2)*4.6*(e > 0 ? -1 : 1);
        var Wl = tf(Fh, vv, hy + 3.36, u - e*0.14); gbSign(G.wf, Wl[0], Wl[1], Wl[2], h.yaw + (e > 0 ? PI : 0), 4.4, 0.41, uvL); });
    });
    // ticket machines (screens lit) under a "Tickets" sign, the line map with "You are here", the name over the machines
    // ([stations] where the layout put them: a bank of four on the street side by each way in)
    st.machines.forEach(function(Mc, m){ var mu = Mc.u; gbBox(G.op, Fh, -h.hw + 0.35, hy + 0.9, mu, 0.3, 0.9, 0.45, C.machine);
      var S2 = tf(Fh, -h.hw + 0.66, hy + 1.3, mu); gbSign(G.at, S2[0], S2[1], S2[2], h.yaw + PI/2, 0.5, 0.4, null, C.screen);
      if(m % 4 === 1){ var Tk = tf(Fh, -h.hw + 0.05, hy + 2.2, mu + 1.4); gbSign(G.wf, Tk[0], Tk[1], Tk[2], h.yaw + PI/2, 3.6, 0.45, SU.tickets); } });
    var Mp = tf(Fh, h.hw - 0.04, hy + 1.75, 0); gbSign(G.wf, Mp[0], Mp[1], Mp[2], h.yaw - PI/2, 5.6, 1.57, SU.map);
    if(frz){ var Nm = tf(Fh, -h.hw + 0.04, hy + 2.95, 0); gbSign(G.at, Nm[0], Nm[1], Nm[2], h.yaw + PI/2, 4, 0.5, frz); }
    // every exit, by its street, over the foot of its stairs (read on the way out); the station's name on the back
    // (read on the way in)
    Lay.entrances.forEach(function(E){
      if(E.station !== st.id || !SU.exit[E.id]) return;
      var sy = Math.sin(E.yaw), cy2 = Math.cos(E.yaw), X = E.foot.x - sy*0.9, Z = E.foot.z - cy2*0.9;
      gbSign(G.wf, X + sy*0.02, hy + 2.6, Z + cy2*0.02, E.yaw, 3.4, 0.43, SU.exit[E.id]);
      gbSign(G.wf, X - sy*0.02, hy + 2.6, Z - cy2*0.02, E.yaw + PI, 3.4, 0.43, SU.here);
    });
    // passages from the entrance stairs (and the Island Link) to the hall: floor, tiled walls, ceiling, a lit strip, each
    // only up to the hall's wall (its opening there is cut to the passage exactly)
    st.floors.forEach(function(f){
      if(f.kind !== "passage" && f.kind !== "lift") return;
      var r = f.r, Fp = frame(r.cx, 0, r.cz, r.yaw), y = f.y0;
      if(f.kind === "lift"){
        gbFlat(G.op, Fp, -r.hw, r.hw, -r.hl, r.hl, y, C.floorHall); gbFlat(G.op, Fp, -r.hw, r.hw, -r.hl, r.hl, y + PASS_H, C.ceiling);
        [-r.hw, r.hw].forEach(function(x){ gbWall(G.tile, Fp, x, -r.hl, x, r.hl, y, y + PASS_H, C.tileW, 1.2); });
        gbWall(G.op, Fp, -r.hw, -r.hl, r.hw, -r.hl, y, y + PASS_H, C.frame);
        return;
      }
      var out = minusRects([rectPoly(r, -r.hl, r.hl, -r.hw, r.hw)], [h]);
      polys(G.op, out, y, C.floorHall); polys(G.op, out, y + PASS_H, C.ceiling);
      [-r.hw, r.hw].forEach(function(x){
        var A = rPoint(r, -r.hl, x), B = rPoint(r, r.hl, x), t = segRect(A.x, A.z, B.x, B.z, h), lz0 = -r.hl, lz1 = r.hl;
        if(t){ if(t[0] <= 1e-6) lz0 = -r.hl + 2*r.hl*t[1]; else lz1 = -r.hl + 2*r.hl*t[0]; }
        if(lz1 - lz0 > 0.01) gbWall(G.tile, Fp, x, lz0, x, lz1, y, y + PASS_H, C.tileW, 1.2);
      });
      // (the Island Link's passage ends at its stair: closed round the stair's tube)
      if(f.rail){ [[-r.hw, -1.55], [1.55, r.hw]].forEach(function(q2){ gbWall(G.tile, Fp, q2[0], r.hl, q2[1], r.hl, y, y + PASS_H, C.tileW, 1.2); }); }
      var ls = segRect(rPoint(r, -r.hl, 0).x, rPoint(r, -r.hl, 0).z, rPoint(r, r.hl, 0).x, rPoint(r, r.hl, 0).z, h), le = ls && ls[0] > 1e-6 ? -r.hl + 2*r.hl*ls[0] : r.hl;
      if(le + r.hl > 1.2) gbFlat(G.at, Fp, -0.15, 0.15, -r.hl + 0.5, le - 0.5, y + PASS_H - 0.02, C.strip);
    });
    // [stations] below the street the open top of every entrance's stairs shows the daylight (the street is not drawn then)
    myEnts.forEach(function(E){ var Fe = frame(E.x, E.y, E.z, E.yaw), hwE = E.w/2; gbFlat(G.at, Fe, -hwE - 0.4, hwE + 0.4, -1.2, E.run + 1.0, -0.06, C.glow); });
    // a lift from the hall to every platform (a glass shaft)
    st.plats.forEach(function(p, i){
      if(i % 2 && st.platform === "side") return;
      var Fl = frame(p.r.cx, 0, p.r.cz, p.r.yaw), y0 = p.y0, y1 = hy + 3;
      [[-0.9, -0.9], [0.9, -0.9], [-0.9, 0.9], [0.9, 0.9]].forEach(function(c2){ gbBox(G.op, Fl, c2[0], (y0 + y1)/2, c2[1], 0.05, (y1 - y0)/2, 0.05, C.frame); });
      [[-0.9, -0.9, 0.9, -0.9], [0.9, -0.9, 0.9, 0.9], [0.9, 0.9, -0.9, 0.9], [-0.9, 0.9, -0.9, -0.9]].forEach(function(w){ gbWall(G.gl, Fl, w[0], w[1], w[2], w[3], y0, y1, C.white); });
    });
    // the Island Link platforms (at railway depth; part rail draws its trains)
    st.il.forEach(function(r){
      var Fi = frame(r.x, 0, r.z, r.yaw);
      var stairsIL = st.floors.filter(function(f){ return f.rail === r.id && f.kind === "stairs"; });
      platformBox(G, Fi, r.y - FLOOR, r.len/2, "island", 4.2, {frieze: atUv(AP.il), band: rgb(0x1f7a4a), wayout: [-(r.len/2 - 6)], holes: tubeHoles(stairsIL, r.y + PLAT_H)});
    });
    var grp = new THREE.Group(); grp.name = "metro:station:" + st.id;
    var mOp = mesh(G.op, M.op, "op"), mTi = mesh(G.tile, M.tile, "tiles"), mAt = mesh(G.at, M.atlas, "signs"), mGl = mesh(G.gl, M.glass, "glass");
    mGl.renderOrder = 2; grp.add(mOp); grp.add(mTi); grp.add(mAt); grp.add(mGl);
    var wfm = keep(new THREE.MeshBasicMaterial({map: SG.t, vertexColors: true, toneMapped: false, side: DS})); grp.add(mesh(G.wf, wfm, "wayfinding"));
    // the boards: the hall's (every train) and one a platform edge, all strips of the shared board atlas; one mesh a texture
    var bset = boardTex[st.id] || (boardTex[st.id] = {}), byTex = [], tb = 0;
    boards.forEach(function(b){
      var k = b.key || "hall", bd = bset[k] || (bset[k] = makeBoard(st.id)), grpT = byTex.filter(function(x){ return x.t === bd.t; })[0];
      if(!grpT){ grpT = {t: bd.t, B: GB()}; byTex.push(grpT); }
      (b.two ? gbSign2 : gbSign)(grpT.B, b.x, b.y, b.z, b.yaw, b.w, b.h, bd.uv);
    });
    byTex.forEach(function(x){ var bm = keep(new THREE.MeshBasicMaterial({map: x.t, toneMapped: false, side: DS})); grp.add(mesh(x.B, bm, "boards")); tb += gbTris(x.B); });
    tris = gbTris(G.op) + gbTris(G.tile) + gbTris(G.at) + gbTris(G.gl) + gbTris(G.wf) + tb;
    under.add(grp);
    return {g: grp, psd: psd, gates: gates, boards: bset, boardAt: -1e18, tris: tris, id: st.id, sign: SG};
  }
  var MAXF = 2400, PSDM = new THREE.InstancedMesh(keep(new THREE.BoxGeometry(0.04, 2.1, 0.8)), M.glass, MAXF);
  PSDM.count = 0; PSDM.visible = false; PSDM.frustumCulled = false; PSDM.name = "metro:screendoors"; PSDM.renderOrder = 3; under.add(PSDM);
  var GATEM = new THREE.InstancedMesh(keep(new THREE.BoxGeometry(0.03, 0.7, 0.42)), M.flap, 400);
  GATEM.count = 0; GATEM.visible = false; GATEM.frustumCulled = false; GATEM.name = "metro:gates"; under.add(GATEM);
  var hemi = new THREE.HemisphereLight(0xe6eef6, 0x9a9488, 1.5); hemi.name = "metro:fill"; under.add(hemi);

  /* ---- per frame */
  var isUnderOn = false, focusId = null, focusTrip = null, lastMs = 0, lastCam = {x: 0, y: 0, z: 0}, built = [], tunAcc = 1e9, sndAcc = 0, sndState = {}, stripRef = null;
  var m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), e4 = new THREE.Euler(0, 0, 0, "YXZ"), v4 = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), col4 = new THREE.Color();
  var surfaceTris = buildSurface();
  function carMatrix(cp){ e4.set(-cp.pitch, cp.yaw, 0, "YXZ"); q4.setFromEuler(e4); v4.set(cp.x, cp.y, cp.z); return m4.compose(v4, q4, one); }
  function localM(base, lx, ly, lz, yaw){ var Mx = new THREE.Matrix4().makeRotationY(yaw || 0); Mx.setPosition(lx, ly, lz); return new THREE.Matrix4().multiplyMatrices(base, Mx); }
  function stationSideAt(v){ var st = v.stop && D.st[v.stop]; return st ? (st.platform === "island" ? 1 : -1) : 0; }   // +1: doors open on the left (+x)
  function trainsToDraw(ms, cam){
    var list = [];
    sim.vehicles(ms).forEach(function(v){
      var d = hyp(v.x - cam.x, v.z - cam.z);
      if(v.id === focusId || (isUnderOn ? d < 450 : d < 1600)) list.push({v: v, d: d});
    });
    list.sort(function(a, b){ return (a.v.id === focusId ? -1 : 0) - (b.v.id === focusId ? -1 : 0) || a.d - b.d; });
    return list.slice(0, MAXT);
  }
  function placeTrains(ms, cam){
    var nb = 0, nl = 0, nc = 0, ns = 0, np = 0, cars = [], snap = calm();
    var list = trainsToDraw(ms, cam);
    if(!isUnderOn) sim.depotTrains().forEach(function(t){ if(list.length < MAXT) list.push({v: {id: t.id, line: t.line, depot: t, doors: 0, speed: 0, load: 0}, d: 0}); });
    list.forEach(function(it){
      var v = it.v, L = sim.lineData(v.line), col = hexNum(L ? L.color : "#888888", 0x888888), side = stationSideAt(v), want = [];
      var dOpen = snap ? (v.doors > 0 ? 1 : 0) : v.doors;
      for(var k = 0; k < CARS; k++){
        var cp = v.depot ? (function(){ var a = pathAt(v.depot.P, v.depot.s + (1.5 - k)*PITCH); return {x: a.x, y: a.y, z: a.z, yaw: a.yaw, pitch: 0, under: false}; })() : sim.carPose(v, k);
        if(!cp) continue;
        if(!isUnderOn && cp.under && v.id !== focusId) continue;
        want.push({k: k, cp: cp});
      }
      want.forEach(function(w){
        if(nb >= MAXC) return;
        var base = carMatrix(w.cp).clone();
        IB.setMatrixAt(nb, base); IN.setMatrixAt(nb, base); IW.setMatrixAt(nb, base); IN.setColorAt(nb, col4.setHex(col)); nb++;
        cars.push({v: v, k: w.k, M: base, cp: w.cp});
        // door leaves: slide apart on the platform's side when open
        DOORS_Z.forEach(function(dz){ [-1, 1].forEach(function(e){ [-1, 1].forEach(function(lr){
          var open = side && e === side ? dOpen : 0;
          if(nl < MAXC*24){ IL.setMatrixAt(nl++, localM(base, e*(CAR_HW + (open > 0 ? 0.06 : 0)), 0, dz + lr*(0.35 + 0.72*open), 0)); }
        }); }); });
        if(w.k === 0 && nc < MAXT*2) IC.setMatrixAt(nc++, localM(base, 0, 0, CAR_L/2, 0));
        if(w.k === CARS - 1 && nc < MAXT*2) IC.setMatrixAt(nc++, localM(base, 0, 0, -CAR_L/2, PI));
      });
    });
    // commuters in the trains near the camera (and the one you ride), from hqCommute
    cars.forEach(function(cr){
      var v = cr.v; if(v.depot) return;
      if(!(v.id === focusId || hyp(cr.cp.x - cam.x, cr.cp.z - cam.z) < (isUnderOn ? 140 : 60))) return;
      var R0 = sim.runs(v.line), run0 = R0 && (v.run === "o" ? R0.out : R0.back), t0 = run0 ? Math.round((v.k*HEADWAY + run0.off)*1000) : 0;
      var ft = v.id === focusId && focusTrip && focusTrip.vehicle === v.id ? focusTrip : null, at0 = ft ? +ft.depart || t0 : t0, tk = v.id + ":" + at0, occ = null;
      try { if(HQV.hqCommute && HQV.hqCommute.occupied) occ = HQV.hqCommute.occupied("metro", v.id, tk, CARS*SEATS_CAR, CARS*STAND_CAR, at0, ft && ft.seed != null ? ft.seed : seed); } catch(e){ occ = null; }
      if(!occ){ var r = mulberry32(hash32(seed + tk)), ld = v.load || 0, seats = [], stand = [];
        for(var i = 0; i < CARS*SEATS_CAR; i++) if(r() < Math.min(1, ld)) seats.push(i);
        for(var j = 0; j < CARS*STAND_CAR; j++) if(r() < Math.max(0, ld - 0.85)*3) stand.push(j);
        occ = {seats: seats, standing: stand}; }
      (occ.seats || []).forEach(function(i){ if(Math.floor(i/SEATS_CAR) !== cr.k || ns >= MAXP) return; var q = SEATS[i % SEATS_CAR];
        PS.setMatrixAt(ns, localM(cr.M, q.x, FLOOR + 0.02, q.z, q.yaw)); var p = paint(tk + ":" + i); PS.setColorAt(ns, col4.setRGB(p[0], p[1], p[2], THREE.SRGBColorSpace)); ns++; });
      (occ.standing || []).forEach(function(j){ if(Math.floor(j/STAND_CAR) !== cr.k || np >= MAXP) return; var q = STAND[j % STAND_CAR];
        PT.setMatrixAt(np, localM(cr.M, q.x, FLOOR, q.z, q.yaw)); var p = paint(tk + ":s" + j); PT.setColorAt(np, col4.setRGB(p[0], p[1], p[2], THREE.SRGBColorSpace)); np++; });
    });
    // waiting crowds on the platforms of the built stations
    if(isUnderOn) built.forEach(function(B){
      var st = Lay.byId[B.id]; if(!st) return;
      var n = 0; try { if(HQV.hqCommute && HQV.hqCommute.crowd) n = HQV.hqCommute.crowd(st.id, "metro", ms, seed) | 0; } catch(e){ n = 0; }
      if(!n) n = 3 + (hash32(seed + st.id + Math.floor(ms/300000)) % 10);
      st.plats.forEach(function(p, pi){
        var r = mulberry32(hash32(seed + ":crowd:" + st.id + ":" + pi + ":" + Math.floor(ms/120000)));
        for(var i = 0; i < n && np < MAXP; i++){
          var u = (r() - 0.5)*(2*p.r.hl - 8), vv = (r() - 0.5)*(2*p.r.hw - 1.2), P = rPoint(p.r, u, vv);
          m4.compose(v4.set(P.x, p.y0, P.z), q4.setFromAxisAngle(v4.clone().set(0, 1, 0), r()*2*PI), one); PT.setMatrixAt(np, m4);
          var pp = paint(st.id + ":" + pi + ":" + i); PT.setColorAt(np, col4.setRGB(pp[0], pp[1], pp[2], THREE.SRGBColorSpace)); np++;
        }
      });
    });
    [[IB, nb], [IN, nb], [IW, nb], [IL, nl], [IC, nc], [PS, ns], [PT, np]].forEach(function(a){
      a[0].count = a[1]; a[0].visible = a[1] > 0; a[0].instanceMatrix.needsUpdate = true; if(a[0].instanceColor) a[0].instanceColor.needsUpdate = true;
    });
    M.win.emissiveIntensity = isUnderOn || night() ? 0.35 : 0;
    return list;
  }
  function updateStations(ms, cam, dt){
    var want = Lay.stations.map(function(s){ return {s: s, d: hyp(s.x - cam.x, s.z - cam.z)}; }).filter(function(o){ return o.d < 450; })
      .sort(function(a, b){ return a.d - b.d || (a.s.id < b.s.id ? -1 : 1); }).slice(0, 3);
    var ids = {}; want.forEach(function(o){ ids[o.s.id] = 1; });
    Object.keys(stCache).forEach(function(id){ var B = stCache[id]; B.g.visible = !!ids[id]; if(!ids[id] && hyp(Lay.byId[id].x - cam.x, Lay.byId[id].z - cam.z) > 800){ under.remove(B.g); disposeBoards(id);
      if(B.sign && B.sign.t){ try { B.sign.t.dispose(); } catch(e){} }
      B.g.traverse(function(x){ if(x.geometry){ x.geometry.dispose(); var i = disp.indexOf(x.geometry); if(i >= 0) disp.splice(i, 1); } }); delete stCache[id]; } });
    built = want.map(function(o){ return stCache[o.s.id] || (stCache[o.s.id] = buildStation(o.s)); });
    built.forEach(function(B){ B.g.visible = true; if(ms - B.boardAt > 5000){ B.boardAt = ms; Object.keys(B.boards).forEach(function(k){ B.boards[k].draw(boardRows(B.id, ms, k === "hall" ? null : k), ms); }); } });
  }
  function updateDoorsAndGates(ms, dt, vs){
    var snap = calm(), at = {}, nf = 0, ng = 0;
    vs.forEach(function(it){ var v = it.v; if(v.stop) at[v.stop + "|" + v.dir] = Math.max(at[v.stop + "|" + v.dir] || 0, v.doors); });
    var w = me(), nearest = null, nd = 1.6;   // one gate opens for the walker: the nearest within 1.6 m
    if(w) built.forEach(function(B){ B.gates.forEach(function(g){ var d = hyp(w.x - g.x, w.z - g.z); if(d < nd && (w.y == null || Math.abs(w.y - g.y) < 2)){ nd = d; nearest = g; } }); });
    built.forEach(function(B){
      // the screen doors' double beep: once a train's doors start to open, heard within 60 m of the station, from the
      // screen door on that side nearest the walker
      B.open = B.open || {};
      [1, -1].forEach(function(dir){
        var o2 = at[B.id + "|" + dir] || 0, st = Lay.byId[B.id];
        if(o2 > 0 && !B.open[dir] && w && st && hyp(w.x - st.x, w.z - st.z) < 60){
          var sp = screenDoorAt(B, dir, w);
          sfx("validator", {screenDoors: true, pos: sp, kind: "door"}); sfx("validator", {screenDoors: true, delay: 0.18, pos: sp, kind: "door"});
        }
        B.open[dir] = o2 > 0;
      });
      B.psd.forEach(function(p){
        var open = at[B.id + "|" + p.dir] || 0;
        if(snap) open = open > 0 ? 1 : 0;
        [-1, 1].forEach(function(lr){
          if(nf >= MAXF) return;
          var P = tf(p.F, p.lat, p.y + 1.07, p.z + lr*(0.42 + 0.78*open));
          m4.compose(v4.set(P[0], P[1], P[2]), q4.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.F.yaw), one); PSDM.setMatrixAt(nf++, m4);
        });
      });
      var ok = true; try { if(opts.gateOk) ok = !!opts.gateOk(); } catch(e){ ok = true; }
      B.gates.forEach(function(g){
        var near = g === nearest;
        var target = near && ok ? 1 : 0;
        g.open = snap ? target : g.open + clamp(target - g.open, -dt*3, dt*3);
        if(near && ok && !g.beep){ g.beep = true; sfx("validator", {pos: {x: g.x, y: g.y + 1, z: g.z}, kind: "door"}); }   // at the gate
        if(!near) g.beep = false;
        // the flaps: green open, bright red when shut on you (no ticket), else the line's red
        var gc = g.open > 0.3 ? 0x2fb36b : near && !ok ? 0xff2a1a : 0xb8342d;
        [-1, 1].forEach(function(lr){
          if(ng >= 400) return;
          var a = g.yaw + lr*g.open*PI/2*0.95, ox = Math.cos(g.yaw)*lr*0.28, oz = -Math.sin(g.yaw)*lr*0.28;
          m4.compose(v4.set(g.x + ox, g.y + 0.85, g.z + oz), q4.setFromAxisAngle(new THREE.Vector3(0, 1, 0), a + PI/2), one); GATEM.setColorAt(ng, col4.setHex(gc)); GATEM.setMatrixAt(ng++, m4);
        });
      });
    });
    PSDM.count = nf; PSDM.visible = isUnderOn && nf > 0; PSDM.instanceMatrix.needsUpdate = true;
    GATEM.count = ng; GATEM.visible = isUnderOn && ng > 0; GATEM.instanceMatrix.needsUpdate = true; if(GATEM.instanceColor) GATEM.instanceColor.needsUpdate = true;
  }
  function updateSignals(ms, vs){
    var n = 0;
    signals.forEach(function(sg){
      if(n >= 400) return;
      var occ = Infinity;
      vs.forEach(function(it){ var v = it.v; if(v.line !== sg.line || v.dir !== sg.dir) return; var ahead = (v.s - sg.s)*sg.dir + TRAIN_L/2; if(ahead > 0) occ = Math.min(occ, ahead); });
      var red = occ < 300, yellow = !red && occ < 600;
      m4.compose(v4.set(sg.top[0], sg.top[1], sg.top[2]), q4.setFromAxisAngle(new THREE.Vector3(0, 1, 0), sg.yaw), one); AS.setMatrixAt(n, m4);
      AS.setColorAt(n++, col4.setHex(red ? 0xff2a1a : yellow ? 0xffb21a : 0x2aff6a));
    });
    AS.count = n; AS.visible = isUnderOn && n > 0; AS.instanceMatrix.needsUpdate = true; if(AS.instanceColor) AS.instanceColor.needsUpdate = true;
  }
  // the route strip in the train you ride: the line's stations, the next one lit, and a "Next" screen
  var strip = null;
  function updateStrip(ms){
    if(!focusId){ if(strip) strip.mesh.visible = false; return; }
    var v = sim.vehicle(focusId, ms); if(!v){ if(strip) strip.mesh.visible = false; return; }
    var R = sim.runs(v.line), run = v.run === "o" ? R.out : R.back, next = null, here = false, tau = ms/1000 - (v.k*HEADWAY + run.off);
    run.segs.forEach(function(g){ if(!next && g.type === "dwell" && g.t1 > tau){ next = g.stop; here = g.t0 <= tau; } });
    if(!strip){
      var T = canvasTex(1024, 64), Bq = GB(), F0 = frame(0, 0, 0, 0);
      [-1, 1].forEach(function(e){ [-4.6, 4.6].forEach(function(z){ var P = tf(F0, e*(CAR_HW - 0.12), FLOOR + 2.22, z); gbSign(Bq, P[0], P[1], P[2], e > 0 ? -PI/2 : PI/2, 3.2, 0.2, [0, 0, 1, 1]); }); });
      var geo = toGeo(Bq), mt = keep(new THREE.MeshBasicMaterial({map: T.t, toneMapped: false, side: DS}));
      strip = {T: T, mesh: new THREE.InstancedMesh(geo, mt, CARS), key: ""}; strip.mesh.frustumCulled = false; strip.mesh.name = "metro:train:route"; trainsG.add(strip.mesh);
    }
    var key = focusId + "|" + next + "|" + here;
    if(key !== strip.key){
      strip.key = key; var g = strip.T.g;
      if(g && g.fillRect){
        var L = sim.lineData(v.line), order = run.order, n = Math.max(2, order.length);
        g.fillStyle = "#0e1114"; g.fillRect(0, 0, 1024, 64); g.fillStyle = L.color; g.fillRect(20, 30, 700, 6);
        order.forEach(function(id, i){ var x = 20 + 700*i/(n - 1); g.fillStyle = id === next ? "#ffd84a" : "#ffffff"; g.fillRect(x - 6, 27, 12, 12); });
        g.fillStyle = "#ffd84a"; g.font = "700 26px system-ui, sans-serif"; g.textAlign = "left"; g.textBaseline = "middle";
        g.fillText(next ? (here ? "This is " : "Next: ") + (stopName[next] || "") : "Terminates here", 740, 32);
        if(strip.T.t) strip.T.t.needsUpdate = true;
      }
    }
    for(var k = 0; k < CARS; k++){ var cp = sim.carPose(v, k); strip.mesh.setMatrixAt(k, carMatrix(cp)); }
    strip.mesh.count = CARS; strip.mesh.instanceMatrix.needsUpdate = true; strip.mesh.visible = true;
  }
  // the screen door on side dir of a built station nearest p ({x, y?, z}): its beeper, over the opening
  function screenDoorAt(B, dir, p){
    var best = null, bd = Infinity;
    B.psd.forEach(function(q){
      if(q.dir !== dir) return;
      var P = tf(q.F, q.lat, q.y + 2.2, q.z), dy = p.y != null ? P[1] - p.y : 0, d = (P[0] - p.x)*(P[0] - p.x) + (P[2] - p.z)*(P[2] - p.z) + dy*dy;
      if(d < bd){ bd = d; best = {x: P[0], y: P[1], z: P[2]}; }
    });
    var st = Lay.byId[B.id];
    return best || (st ? {x: st.x, y: st.y, z: st.z} : null);
  }
  /* ---- sound (Sound PR B): every train where it is, from the part of it nearest your ears (a train is 78 m long):
     door chimes and hiss as its doors open and close (the door kind: 40 m); its motor while it moves and its rumble in
     a tunnel as one pool of hqRide's held loops (games/engine.js pool, the metro kind: the two nearest trains within
     250 m; each loop is set every frame and falls silent by itself when it is not, so none can pile up); the rail
     joints under the trains that play. A train in a tunnel is heard below the street, one in the open above it, the
     one you ride always. With no pool (an older engine): one set of loops, for your train else the nearest in 60 m. */
  var E = HQV.engine, runP = null, run1 = null;
  function earAt(){ var L = null; try { L = E && E.listenerAt ? E.listenerAt() : null; } catch(e){ L = null; } return L || lastCam; }
  // a train's centre line at rail level: its front end, its cars' middles, its rear end
  function trainLine(v){
    var P = [];
    for(var k = 0; k < CARS; k++){ var cp = sim.carPose(v, k); if(cp) P.push(cp); }
    if(!P.length) return [{x: v.x, y: v.y, z: v.z}];
    var a = P[0], b = P[P.length - 1], h = CAR_L/2;
    return [{x: a.x + Math.sin(a.yaw)*h, y: a.y, z: a.z + Math.cos(a.yaw)*h}].concat(P, [{x: b.x - Math.sin(b.yaw)*h, y: b.y, z: b.z - Math.cos(b.yaw)*h}]);
  }
  // one train's running sound: hqRide's motor (above 0.5 m/s) and tunnel rumble (in a tunnel, above 3 m/s), each a
  // held loop made once and set every frame with the train's place and speed (m/s)
  function runner(){
    var H = {"motor": null, "tunnel-rumble": null};
    function keep(name, s, on){
      if(!on) return;                                                // not set: its dead man's switch fades it out
      var h = H[name];
      if(!h || typeof h.set !== "function") h = H[name] = sfx(name, {pos: s, speed: s.speed, kind: "metro"});
      if(h && typeof h.set === "function") h.set({pos: s, speed: s.speed});
    }
    return {
      play: function(s){ keep("motor", s, s.speed > 0.5); keep("tunnel-rumble", s, s.under && s.speed > 3); },
      stop: function(){ Object.keys(H).forEach(function(k){ var h = H[k]; H[k] = null; if(h && typeof h.stop === "function"){ try { h.stop(); } catch(e){} } }); }
    };
  }
  if(E && typeof E.pool === "function"){
    try { runP = E.pool("metro", {key: function(){ return "train"; }, make: function(){ return runner(); }, play: function(h, s){ h.play(s); }}); } catch(e){ runP = null; }
  }
  function sounds(ms, dt, vs, cam){
    if(!opts.sfx) return;
    var ear = earAt(), next = {}, src = [], byId = {}, playing = [];
    vs.forEach(function(o){
      var v = o.v; if(v.depot) return;
      var S = sndState[v.id] || {doors: v.doors, joint: v.s}, p = null;
      next[v.id] = S;
      if(v.id !== focusId && !!v.under !== isUnderOn){ S.doors = v.doors; S.joint = v.s; return; }   // through the ground: not heard
      function at(){ return p || (p = nearLine(trainLine(v), ear, 1.5)); }
      if(v.doors > 0 && S.doors <= 0){ sfx("door-chime", {pos: at(), kind: "door"}); sfx("door-hiss", {pos: at(), kind: "door"}); }
      if(v.doors < 1 && S.doors >= 1) sfx("door-chime", {closing: true, pos: at(), kind: "door"});
      S.doors = v.doors;
      if(+v.speed > 0.5 && (v.id === focusId || hyp(v.x - ear.x, v.z - ear.z) < LOD_R)){   // a standing train has nothing to play
        var q = at(), s = {id: v.id, x: q.x, y: q.y, z: q.z, speed: +v.speed || 0, under: !!v.under, d: hyp(q.x - ear.x, q.z - ear.z), v: v};
        src.push(s); byId[v.id] = s;
      }
    });
    sndState = next;
    if(runP) playing = runP.update(src) || [];
    else {
      var one = focusId && byId[focusId] ? byId[focusId] : null;
      if(!one) src.forEach(function(s){ if(s.d < 60 && (!one || s.d < one.d)) one = s; });
      if(one){ (run1 || (run1 = runner())).play(one); playing = [one.id]; }
    }
    // rail joints every 18 m above 2 m/s under the trains that play; the others start counting when they do
    var on = {};
    playing.forEach(function(id){
      var s = byId[id], S = next[id]; if(!s || !S) return;
      on[id] = 1;
      if(Math.abs(s.v.s - S.joint) > 18 && s.speed > 2){ S.joint = s.v.s; sfx("rail-joint", {pos: s, speed: s.speed, kind: "metro"}); }
    });
    src.forEach(function(s){ if(!on[s.id]) next[s.id].joint = s.v.s; });
  }
  function update(ms, dt, cam){
    cam = cam || lastCam; dt = Math.min(0.25, Math.max(0, +dt || 0)); lastMs = ms; lastCam = {x: +cam.x || 0, y: +cam.y || 0, z: +cam.z || 0};
    try { if(opts.under){ var u = !!opts.under(); if(u !== isUnderOn) underground(u); } } catch(e){}
    var vs = placeTrains(ms, lastCam);
    if(isUnderOn){
      tunAcc += dt; if(tunAcc > 0.4){ tunAcc = 0; updateTunnels(lastCam); }
      updateStations(ms, lastCam, dt);
      updateDoorsAndGates(ms, dt, vs);
      updateSignals(ms, vs);
    }
    updateStrip(ms);
    sounds(ms, dt, vs, lastCam);
  }
  function underground(on){
    isUnderOn = !!on; under.visible = isUnderOn; veilShow();
    if(isUnderOn){ tunAcc = 1e9; chunkKey = chunkKey ? chunkKey + "!" : ""; }
    return isUnderOn;
  }
  function countDraws(g){
    var n = 0;
    g.traverseVisible(function(o){ if(o.isMesh && (!o.isInstancedMesh || o.count > 0)) n++; });
    return n;
  }
  function countTris(g){
    var n = 0;
    g.traverseVisible(function(o){
      if(!o.isMesh || o.isInstancedMesh && o.count <= 0) return;
      var G = o.geometry, t = G.index ? G.index.count/3 : G.attributes.position.count/3;
      n += t*(o.isInstancedMesh ? o.count : 1);
    });
    return Math.round(n);
  }
  // fixed cameras for the screenshot tour: {pos, look, fov, under}
  function shotCam(name){
    var E = shotInfo.entrance, st0 = Lay.stations[0], central = Lay.stations.filter(function(s){ return s.lines.length > 1; })[0] || st0;
    function cam(p, l, fov, u){ return {pos: {x: p[0], y: p[1], z: p[2]}, look: {x: l[0], y: l[1], z: l[2]}, fov: fov || 55, under: !!u}; }
    if(name === "entrance" && E){ var F = frame(E.x, E.y, E.z, E.yaw); return cam(tf(F, 2.2, 2.7, -4.2), tf(F, 0, -2.6, 4.5), 60); }      // over the kerb, down the stairs
    if(name === "portal" && shotInfo.portal){ var Pt = shotInfo.portal; return cam(tf(Pt.F0, Pt.w*0.6, Pt.y + 9, -22), tf(Pt.Fe, 0, Pt.ry + 2, 0), 60); }   // above the open end, down the trench to the mouth
    if(name === "portal-daylight" && shotInfo.portal){ var Pd = shotInfo.portal, Fd = Pd.Fe; return cam(tf(Fd, 1.2, Pd.ry + 1.7, 8), tf(Pd.F0, 0, Pd.ry + 2.5, 0), 70); }   // from inside the mouth, out to the light
    if(name === "depot" && shotInfo.depot){ var d = shotInfo.depot; return cam(tf(d.F, d.v1 + 30, 26, d.u0 - 25), tf(d.F, (d.v0 + d.v1)/2, 0, (d.u0 + d.u1)/2), 55); }
    if(!st0) return null;
    if(name === "hall"){ var h = st0.hall, Fh = frame(h.cx, st0.hallY, h.cz, h.yaw); return cam(tf(Fh, 1.5, 1.7, -4), tf(Fh, 0, 1.2, GATE_U + 6), 70, true); }
    if(name === "platform" && st0.plats[0]){ var p = st0.plats[0], Fq = frame(p.r.cx, p.y0, p.r.cz, p.r.yaw); return cam(tf(Fq, 0, 1.65, -p.r.hl + 6), tf(Fq, p.lat < 0 ? 2 : -2, 1.2, 10), 70, true); }
    if(name === "central-interchange" && central){ var hc = central.hall, Fc = frame(hc.cx, central.hallY, hc.cz, hc.yaw); return cam(tf(Fc, 0, 2.6, -GATE_U + 2), tf(Fc, 0, 0.6, hc.hl), 78, true); }
    if(name === "tunnel-ride"){
      var L = D.lines[0]; if(!L) return null;
      var a = L.stops[0], b = L.stops[1], s = a && b ? (a.s + b.s)/2 : L.P.len/2, tr = sim.trackAt(L.id, s, 1), f = sim.trackAt(L.id, s + 30, 1);
      return cam([tr.x, tr.y + FLOOR + 1.5, tr.z], [f.x, f.y + FLOOR + 1.2, f.z], 70, true);
    }
    if(name === "train-interior"){
      var vs = sim.vehicles(lastMs || Date.now()).filter(function(v){ return v.under; }); if(!vs.length) return null;
      var v = focusId ? sim.vehicle(focusId, lastMs || Date.now()) || vs[0] : vs[0], cp = sim.carPose(v, 1), Fv = frame(cp.x, cp.y, cp.z, cp.yaw);
      return cam(tf(Fv, 0.3, FLOOR + 1.55, -8), tf(Fv, 0, FLOOR + 1.2, CAR_L*1.5), 72, true);
    }
    return null;
  }
  var V = {
    group: root3, surfaceGroup: surf, undergroundGroup: under, trainsGroup: trainsG,
    update: update,
    focus: function(id, trip){ focusId = id || null; focusTrip = focusId && trip ? trip : null; return focusId; },
    surface: function(){ return surf; },
    underground: underground,
    isOn: function(){ return isUnderOn; },
    isUnder: function(x, y, z){ return Lay.isUnder(x, y, z); },
    entranceAt: function(x, z, r){ return Lay.entranceAt(x, z, r); },
    rampAt: function(x, z){ return Lay.rampAt(x, z); },
    stationAt: function(x, y, z){ return Lay.stationAt(x, y, z); },
    exitTo: function(id, x, z){ return Lay.exitTo(id, x, z); },
    walkable: function(x, y, z){ return Lay.walkable(x, y, z); },
    holes: function(){ return D.holes.slice(); },
    drawCalls: function(){ return countDraws(root3); },
    triangles: function(){ return countTris(root3); },
    stats: function(){ return {draws: countDraws(root3), tris: countTris(root3), surfaceDraws: countDraws(surf) + (isUnderOn ? 0 : countDraws(trainsG)), surfaceTris: surfaceTris,
      chunks: chunkKey ? chunkKey.split(",").length : 0, stations: built.length, under: isUnderOn}; },
    tools: {shotCam: shotCam, chunks: function(){ return chunkKey ? chunkKey.split(",") : []; }},
    dispose: function(){
      if(runP){ try { runP.stop(); } catch(e){} runP = null; }
      if(run1){ run1.stop(); run1 = null; }
      if(root3.parent) root3.parent.remove(root3);
      disp.forEach(function(x){ try { x.dispose(); } catch(e){} }); disp = []; chunkCache = {}; stCache = {};
      Object.keys(boardTex).forEach(function(k){ disposeBoards(k); }); boardTex = {};
    }
  };
  return V;
}
HQV.hqMetro.view = view;
HQV.hqMetro.atlasPlan = atlasPlan;

})();
