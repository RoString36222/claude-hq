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
var STAIR_SLOPE = 0.6;    // rise per metre of the stairs (about 31 degrees)
var CHUNK = 50;           // m: tunnel LOD chunks
var LOD_R = 400;          // m: tunnel within this of the camera is built
var UNDER_KINDS = {bored: 1, cutcover: 1};
var LINE_STYLE = {M1: {color: "#d23a32", name: "Red line"}, M2: {color: "#2f6fd6", name: "Blue line"}};
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
function nameStations(W, D, seed){
  var used = {}, names = {};
  function roadName(x, z){
    var best = null, bd = 260;
    var edges = (W && W.edges) || (W && W.layers && W.layers.roads && W.layers.roads.edges) || [];
    for(var i = 0; i < edges.length; i++){
      var e = edges[i], nm = e && e.name; if(!nm) continue;
      var p = e.pts || null, q = e.points || null, j;
      if(p) for(j = 0; j + 2 < p.length; j += 3){ var d = hyp(p[j]/100 - x, p[j + 2]/100 - z); if(d < bd){ bd = d; best = nm; } }
      else if(q) for(j = 0; j < q.length; j++){ var d2 = hyp(q[j][0]/100 - x, q[j][q[j].length >= 3 ? 2 : 1]/100 - z); if(d2 < bd){ bd = d2; best = nm; } }
    }
    return best;
  }
  D.stations.forEach(function(s, i){
    var nm = null;
    if(s.lines.length >= 2) nm = "Central";
    if(!nm && HQV.hqRide && typeof HQV.hqRide.stationName === "function") try { nm = HQV.hqRide.stationName(W, s.x, s.z, "metro"); } catch(e){ nm = null; }
    if(!nm) nm = roadName(s.x, s.z);
    if(!nm) nm = "Station " + (i + 1);
    nm = String(nm);
    if(used[nm]){
      var r = mulberry32(hash32(seed + ":name:" + s.id)), base = nm, n = 0;
      while(used[nm] && n < 12){ nm = base + " " + SUFFIX[(Math.floor(r()*4) + n) % 4]; n++; }
      if(used[nm]) nm = base + " " + (i + 1);
    }
    used[nm] = 1; names[s.id] = nm;
  });
  return names;
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
    for(var i = ia; i <= ib; i++){ var sid = run.order[i]; stops.push({id: sid, name: names[sid], at: Math.round((base + run.ev[sid].arr)*1000)}); }
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
      var cp = carPose(L.id, run, p.s, 1), w = toWorld(cp, (atTo ? side : sideFrom)*(CAR_HW + 0.05), 0, 0);
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
    var yaw0 = s.at[s.lines[0]].yaw, floors = [], plats = [], stairs = [], extra = [];
    var multi = s.lines.length > 1, hw = multi ? 20 : 12;
    var hall = rect(s.x, s.z, yaw0, hw, HALL_HL);
    floors.push({r: hall, y0: s.hallY, y1: s.hallY, kind: "hall", station: s.id});
    s.lines.forEach(function(lid){
      var a = s.at[lid], plat = a.rail + FLOOR, half = s.len/2;
      var lats = s.platform === "island" ? [0] : [-(TRACK + CAR_HW + 0.1 + 2.3), TRACK + CAR_HW + 0.1 + 2.3];
      var phw = s.platform === "island" ? TRACK - CAR_HW - 0.1 : 2.3;
      var L = sim.lineData(lid), cp = pathAt(L.P, a.s);
      lats.forEach(function(v, pi){
        var c = rPoint(rect(cp.x, cp.z, a.yaw, 0, 0), 0, v), pr = rect(c.x, c.z, a.yaw, phw, half);
        var P = {r: pr, y0: plat, y1: plat, kind: "platform", station: s.id, line: lid, lat: v, side: s.platform === "island" ? 0 : (v < 0 ? -1 : 1)};
        floors.push(P); plats.push(P);
        // two stairs (stairs and an escalator side by side), leaving the hall at +-STAIR_U and running outwards
        var drop = s.hallY - plat, run = Math.max(2, drop/STAIR_SLOPE), shw = Math.min(phw - 0.15, 1.5);
        [1, -1].forEach(function(e){
          var u0 = e*STAIR_U, u1 = e*(STAIR_U + run), A = rPoint(pr, u0, 0), B = rPoint(pr, u1, 0);
          var sr = rectAB(A.x, A.z, B.x, B.z, shw);
          var S = {r: sr, y0: s.hallY, y1: plat, kind: "stairs", station: s.id, line: lid, plat: pi};
          floors.push(S); stairs.push(S);
        });
      });
    });
    // entrances: the stair (or lift) down from the street, then a passage to the hall
    s.ents.forEach(function(e){
      var drop = e.y - s.hallY, run = e.kind === "lift" ? 2.4 : Math.max(e.d, drop/0.7), sy = Math.sin(e.yaw), cy = Math.cos(e.yaw);
      var foot = {x: e.x + sy*run, z: e.z + cy*run};
      var ramp = e.kind === "lift" ? rect(e.x + sy*1.2, e.z + cy*1.2, e.yaw, 1.3, 1.2) : rectAB(e.x, e.z, foot.x, foot.z, e.w/2);
      var F = {r: ramp, y0: e.kind === "lift" ? s.hallY : e.y, y1: s.hallY, kind: e.kind === "lift" ? "lift" : "entrance", station: s.id, ent: e.id};
      floors.push(F);
      var pass = null;
      if(!inRect(hall, foot.x, foot.z, -0.5)){
        var hl = rLocal(hall, foot.x, foot.z), tu = clamp(hl.u, -HALL_HL + 3, HALL_HL - 3)*0.4, tv = clamp(hl.v, -hw + 2, hw - 2)*0.4, T = rPoint(hall, tu, tv);
        pass = {r: rectAB(foot.x - sy*0.3, foot.z - cy*0.3, T.x, T.z, Math.min(2.2, Math.max(1.6, e.w/2))), y0: s.hallY, y1: s.hallY, kind: "passage", station: s.id, ent: e.id};
        floors.push(pass);
      }
      // where E at the entrance lands you: 1.2 m past the foot of the stairs, on the hall's (or the passage's) floor; when
      // the hall's edge is nearer than that, the last step of the stairs (always a floor at the hall's level)
      var fx = foot.x + sy*1.2, fz = foot.z + cy*1.2;
      if(!inRect(hall, fx, fz, 0) && !(pass && inRect(pass.r, fx, fz, 0))){ fx = foot.x - sy*0.6; fz = foot.z - cy*0.6; }
      var E = {id: e.id, station: s.id, kind: e.kind, x: e.x, y: e.y, z: e.z, yaw: e.yaw, w: e.w, d: e.d, run: run, ramp: F, pass: pass,
               foot: {x: fx, y: s.hallY, z: fz, yaw: e.yaw}, hole: e.hole};
      ENTS.push(E);
    });
    // the Island Link's underground platforms near the hall (part rail's trains): a passage, a stair and its platform
    (railD || []).forEach(function(r){
      if(hyp(r.x - s.x, r.z - s.z) > 300) return;
      var plat = r.y, n = r.platforms, phw = 2.6, half = r.len/2, rr = rect(r.x, r.z, r.yaw, n*4.4, half);
      var pr = rect(r.x, r.z, r.yaw, phw, half);
      floors.push({r: pr, y0: plat, y1: plat, kind: "platform", station: s.id, rail: r.id});
      var drop = s.hallY - plat;
      if(drop > 0.5){
        var run = drop/STAIR_SLOPE, A = rPoint(pr, -half + 6, 0), B = rPoint(pr, -half + 6 + run, 0);
        floors.push({r: rectAB(A.x, A.z, B.x, B.z, 1.5), y0: s.hallY, y1: plat, kind: "stairs", station: s.id, rail: r.id});
        if(!inRect(hall, A.x, A.z, -1)) floors.push({r: rectAB(s.x, s.z, A.x, A.z, 2.2), y0: s.hallY, y1: s.hallY, kind: "passage", station: s.id, rail: r.id});
      } else floors.push({r: rectAB(s.x, s.z, r.x, r.z, 2.2), y0: s.hallY, y1: s.hallY, kind: "passage", station: s.id, rail: r.id});
      extra.push({id: r.id, x: r.x, y: plat, z: r.z, yaw: r.yaw, len: r.len, platforms: n, box: rr, lines: r.lines});
    });
    var ext = 0;
    floors.forEach(function(f){ ext = Math.max(ext, hyp(f.r.cx - s.x, f.r.cz - s.z) + f.r.hl + f.r.hw); });
    var low = Infinity; floors.forEach(function(f){ low = Math.min(low, f.y0, f.y1); });
    ST.push({id: s.id, name: sim.names[s.id], x: s.x, z: s.z, yaw: yaw0, street: s.street, hallY: s.hallY, hall: hall, hw: hw, len: s.len,
             platform: s.platform, lines: s.lines.slice(), at: s.at, floors: floors, plats: plats, stairs: stairs, il: extra, ext: ext, low: low});
  });
  var BY = {}; ST.forEach(function(s){ BY[s.id] = s; });
  function fy(f, l){ return f.y0 + (f.y1 - f.y0)*clamp((l.u + f.r.hl)/(2*f.r.hl || 1), 0, 1); }
  function walkable(x, y, z){
    var best = null;
    for(var i = 0; i < ST.length; i++){
      var s = ST[i]; if(hyp(x - s.x, z - s.z) > s.ext + 1) continue;
      for(var j = 0; j < s.floors.length; j++){
        var f = s.floors[j], l = inRect(f.r, x, z); if(!l) continue;
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
          rampAt: rampAt, stationAt: stationAt, exitTo: exitTo, floorY: fy};
}

HQV.hqMetro = {
  create: create, layout: function(sim){ return sim && sim.layout ? sim.layout() : null; },
  normalize: normalize, legTime: legTime, legAt: legAt, pathAt: pathAt, nearestOn: nearestOn, nearLine: nearLine, runAt: runAt, linesText: linesText,
  rect: rect, inRect: inRect, rLocal: rLocal, hash32: hash32,
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
    panel(AP.il, "#1f3b2e"); text("IL · Island Link", AP.il[0] + AP.il[2]/2, AP.il[1] + 33, 32, "#ffffff");
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
    flap: keep(new THREE.MeshStandardMaterial({color: 0xd23a32, roughness: 0.3, transparent: true, opacity: 0.85, side: DS})),
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
  function boardRows(sid, ms){
    return sim.departures(sid, ms, 4).map(function(r){
      var due = r.boarding ? "boarding" : r.due || clockText(r.at);
      return {badge: r.short, short: r.short, line: r.line, color: r.color, dest: r.to, to: r.to, due: due, plat: r.plat, at: r.at, boarding: r.boarding};
    });
  }
  // a platform box along frame F (rail level `rail`): trackbed, tracks, platforms, tiled walls, ceiling, light strips,
  // screen doors, benches, the frieze, boards and way-out signs. kind "side" | "island"; trackOff: each track's offset.
  function platformBox(G, F, rail, half, kind, trackOff, o){
    var plat = rail + FLOOR, ry = rail - F.y, py = plat - F.y, W = kind === "island" ? trackOff + 2.1 : trackOff + 1.5 + 4.6, top = py + 4.5, ext = half + 6;
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
      for(var z2 = -half + 2; z2 < half - 2; z2 += 10) gbBox(G.at, F, cx, top - 0.06, z2 + 4, 0.12, 0.03, 3.8, C.strip);
      // benches every 15 m, clear of the stairs
      for(var bz = -half + 7; bz < half - 4; bz += 15){ if(o.clear && !o.clear(bz)) continue; gbBox(G.op, F, cx + (kind === "island" ? 0 : (pl[0] < 0 ? 0.9 : -0.9)), py + 0.42, bz, 0.22, 0.04, 0.9, C.bench); gbBox(G.op, F, cx + (kind === "island" ? 0 : (pl[0] < 0 ? 0.9 : -0.9)), py + 0.2, bz, 0.05, 0.2, 0.75, C.frame); }
      // platform boards (two-faced) at +-6 m and way-out signs at the stair feet
      if(o.board) [-6, 6].forEach(function(bz){ var P = tf(F, cx, py + 3.3, bz); o.board.push({x: P[0], y: P[1], z: P[2], yaw: F.yaw, w: 2.4, h: 0.6, two: true}); });
      (o.wayout || []).forEach(function(wz){ var P = tf(F, cx, py + 3.1, wz); gbSign2(G.at, P[0], P[1], P[2], F.yaw + (wz > 0 ? PI : 0), 1.6, 0.4, atUv(AP.wayout)); });
    });
    // walls (tiled; a band of the line's colour), the ceiling, end walls with the tunnel openings
    [-W, W].forEach(function(x){ gbWall(G.tile, F, x, -ext, x, ext, ry - 0.5, top, o.tile || C.tileW, 1.2); gbWall(G.op, F, x*0.999, -ext, x*0.999, ext, py + 2.25, py + 2.45, o.band || C.tactile); });
    gbFlat(G.op, F, -W, W, -ext, ext, top, C.ceiling);
    [-ext, ext].forEach(function(z){
      gbWall(G.tile, F, -W, z, W, z, ry + 4.8, top, o.tile || C.tileW, 1.2);
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
      });
    }
  }
  function buildStation(st){
    var G = {op: GB(), tile: GB(), at: GB(), gl: GB()}, boards = [], psd = [], gates = [], tris = 0;
    var s = D.st[st.id], q = AP.station[st.id], frz = q ? atUv(q) : null;
    // platforms per line
    st.lines.forEach(function(lid){
      var a = s.at[lid], L = sim.lineData(lid), cp = pathAt(L.P, a.s), F = frame(cp.x, 0, cp.z, a.yaw);
      var myStairs = st.stairs.filter(function(f){ return f.line === lid; }), runU = 0;
      myStairs.forEach(function(f){ runU = Math.max(runU, 2*f.r.hl); });
      var wz = [STAIR_U + runU + 1.2, -(STAIR_U + runU + 1.2)];
      platformBox(G, F, a.rail, s.len/2, s.platform, TRACK, {frieze: frz, psd: psd, board: boards, wayout: wz, band: rgb(hexNum(L.color, 0x888888)),
        clear: function(z){ return Math.abs(z) < STAIR_U - 1 || Math.abs(z) > STAIR_U + runU + 1; }});
    });
    // stairs + escalators from the hall to the platforms, with their shaft walls and balustrades round the opening
    st.stairs.forEach(function(f){
      var r = f.r, Fs = frame(r.cx, 0, r.cz, r.yaw), n = Math.max(6, Math.ceil((f.y0 - f.y1)/0.18)), escW = 1.0, hw = r.hw;
      for(var i = 0; i < n; i++){
        var u0 = -r.hl + 2*r.hl*i/n, u1 = -r.hl + 2*r.hl*(i + 1)/n, y = f.y0 + (f.y1 - f.y0)*(i + 1)/n;
        gbSlab(G.op, Fs, (-hw + escW + 0.15 + hw)/2, y - 0.1, (u0 + u1)/2, (hw - escW - 0.15)/2, 0.1, (u1 - u0)/2 + 0.01, C.step);
      }
      gbQuad(G.op, tf(Fs, -hw, f.y0, -r.hl), tf(Fs, -hw + escW, f.y0, -r.hl), tf(Fs, -hw + escW, f.y1, r.hl), tf(Fs, -hw, f.y1, r.hl), C.esc);
      [-hw + 0.03, -hw + escW].forEach(function(x){ gbQuad(G.gl, tf(Fs, x, f.y0, -r.hl), tf(Fs, x, f.y1, r.hl), tf(Fs, x, f.y1 + 1.0, r.hl), tf(Fs, x, f.y0 + 1.0, -r.hl), C.white);
        gbQuad(G.op, tf(Fs, x - 0.04, f.y0 + 1.0, -r.hl), tf(Fs, x + 0.04, f.y0 + 1.0, -r.hl), tf(Fs, x + 0.04, f.y1 + 1.0, r.hl), tf(Fs, x - 0.04, f.y1 + 1.0, r.hl), C.black); });
      [-hw - 0.05, hw + 0.05].forEach(function(x){
        gbQuad(G.tile, tf(Fs, x, f.y0 - 0.3, -r.hl), tf(Fs, x, f.y1 - 0.3, r.hl), tf(Fs, x, f.y1 + 3.2, r.hl), tf(Fs, x, f.y0 - 0.05, -r.hl), C.tileW, [0, 0, 2*r.hl/1.2, 3]);
        gbWall(G.gl, Fs, x, -r.hl, x, -r.hl + 3, f.y0, f.y0 + 1.1, C.white);
      });
      gbFlat(G.at, Fs, -0.15, 0.15, -r.hl + 1, r.hl - 1, Math.max(f.y0, f.y1) + 3.3, C.strip);
    });
    // the ticket hall: stone floor (open over the stairs), tiled walls (open where passages come in), lit ceiling
    var h = st.hall, Fh = frame(h.cx, 0, h.cz, h.yaw), hy = st.hallY, cy = hy + 3.6;
    var lows = st.floors.filter(function(f){ return f.kind === "stairs"; });
    for(var gu = -h.hl; gu < h.hl - 0.01; gu += 2) for(var gv = -h.hw; gv < h.hw - 0.01; gv += 2){
      var mid = rPoint(h, gu + 1, gv + 1), hole = false;
      lows.forEach(function(f){ var l = inRect(f.r, mid.x, mid.z, 0.6); if(l && Lay.floorY(f, l) < hy - 0.3) hole = true; });
      if(!hole) gbFlat(G.op, Fh, gv, gv + 2, gu, gu + 2, hy, ((gu + gv)/2) % 2 ? C.floorHall : C.platform);
    }
    gbFlat(G.op, Fh, -h.hw, h.hw, -h.hl, h.hl, cy, C.ceiling);
    for(var lv = -h.hw + 3; lv < h.hw - 1; lv += 6) gbFlat(G.at, Fh, lv - 0.15, lv + 0.15, -h.hl + 1.5, h.hl - 1.5, cy - 0.02, C.strip);
    var passes = st.floors.filter(function(f){ return f.kind === "passage" || f.kind === "entrance" && inRect(h, f.r.cx, f.r.cz, f.r.hl + 2); });
    function openAt(u, v){ var P = rPoint(h, u, v), o2 = false; passes.forEach(function(f){ if(inRect(f.r, P.x, P.z, 0.8)) o2 = true; }); return o2; }
    [[-1, "v"], [1, "v"], [-1, "u"], [1, "u"]].forEach(function(w){
      var fixedV = w[1] === "v", span = fixedV ? h.hl : h.hw, at = fixedV ? w[0]*h.hw : w[0]*h.hl;
      for(var t = -span; t < span - 0.01; t += 4){
        var t1 = Math.min(span, t + 4), tm = (t + t1)/2;
        if(fixedV ? openAt(tm, at) : openAt(at, tm)) continue;
        if(fixedV) gbWall(G.tile, Fh, at, t, at, t1, hy, cy, C.tileW, 1.2); else gbWall(G.tile, Fh, t, at, t1, at, hy, cy, C.tileW, 1.2);
      }
    });
    // gate lines across the hall at +-GATE_U: cabinets, glass barriers out to the walls; the flaps are dynamic
    [-1, 1].forEach(function(e){
      var u = e*GATE_U, ng = 8;
      for(var g = 0; g <= ng; g++){ var v = -ng*0.55 + g*1.1; gbBox(G.op, Fh, v, hy + 0.5, u, 0.13, 0.5, 0.7, C.gate); gbBox(G.at, Fh, v, hy + 1.01, u + e*0.45, 0.1, 0.01, 0.12, C.screen); }
      for(var g2 = 0; g2 < ng; g2++){ var gvv = -ng*0.55 + 0.55 + g2*1.1, P = tf(Fh, gvv, hy, u); gates.push({x: P[0], y: hy, z: P[2], yaw: h.yaw, e: e, open: 0, beep: false}); }
      gbWall(G.gl, Fh, -h.hw, u, -ng*0.55 - 0.15, u, hy, hy + 1.1, C.white); gbWall(G.gl, Fh, ng*0.55 + 0.15, u, h.hw, u, hy, hy + 1.1, C.white);
      var B = tf(Fh, 0, hy + 2.85, u); boards.push({x: B[0], y: B[1], z: B[2], yaw: h.yaw + (e > 0 ? PI : 0), w: 3.2, h: 0.8, two: true});
      // over the gates: "Way out" towards the paid side, the station's name towards the street side
      var W1 = tf(Fh, 2.4, hy + 2.85, u + e*0.115), W2 = tf(Fh, 2.4, hy + 2.85, u + e*0.085);
      gbSign(G.at, W1[0], W1[1], W1[2], h.yaw + (e > 0 ? 0 : PI), 1.6, 0.4, atUv(AP.wayout));
      gbSign(G.at, W2[0], W2[1], W2[2], h.yaw + (e > 0 ? PI : 0), frz ? 3.2 : 0.4, 0.4, frz || atUv(AP.logo));
    });
    // ticket machines (screens lit), the line map, the name over the machines
    for(var m = 0; m < 4; m++){ var mu = -4.2 + m*2.8; gbBox(G.op, Fh, -h.hw + 0.35, hy + 0.9, mu, 0.3, 0.9, 0.45, C.machine);
      var S2 = tf(Fh, -h.hw + 0.66, hy + 1.3, mu); gbSign(G.at, S2[0], S2[1], S2[2], h.yaw + PI/2, 0.5, 0.4, null, C.screen); }
    var Mp = tf(Fh, h.hw - 0.04, hy + 1.9, 0); gbSign(G.at, Mp[0], Mp[1], Mp[2], h.yaw - PI/2, 5, 1.25, atUv(AP.map));
    if(frz){ var Nm = tf(Fh, -h.hw + 0.04, hy + 2.85, 0); gbSign(G.at, Nm[0], Nm[1], Nm[2], h.yaw + PI/2, 4, 0.5, frz); }
    // passages from the entrance stairs (and the Island Link) to the hall: floor, tiled walls, ceiling, a lit strip
    st.floors.forEach(function(f){
      if(f.kind !== "passage" && f.kind !== "lift") return;
      var r = f.r, Fp = frame(r.cx, 0, r.cz, r.yaw), y = f.y0;
      gbFlat(G.op, Fp, -r.hw, r.hw, -r.hl, r.hl, y, C.floorHall);
      gbFlat(G.op, Fp, -r.hw, r.hw, -r.hl, r.hl, y + 3, C.ceiling);
      gbFlat(G.at, Fp, -0.15, 0.15, -r.hl + 0.5, r.hl - 0.5, y + 2.98, C.strip);
      [-r.hw, r.hw].forEach(function(x){ gbWall(G.tile, Fp, x, -r.hl, x, r.hl, y, y + 3, C.tileW, 1.2); });
      if(f.kind === "lift") gbWall(G.op, Fp, -r.hw, -r.hl, r.hw, -r.hl, y, y + 3, C.frame);
    });
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
      platformBox(G, Fi, r.y - FLOOR, r.len/2, "island", 4.2, {frieze: atUv(AP.il), band: rgb(0x1f7a4a), wayout: [-(r.len/2 - 6)]});
      var stairsIL = st.floors.filter(function(f){ return f.rail === r.id && f.kind === "stairs"; });
      stairsIL.forEach(function(f){ var rr = f.r, Fs = frame(rr.cx, 0, rr.cz, rr.yaw), n = Math.max(6, Math.ceil((f.y0 - f.y1)/0.18));
        for(var i = 0; i < n; i++){ var u0 = -rr.hl + 2*rr.hl*i/n, u1 = -rr.hl + 2*rr.hl*(i + 1)/n; gbSlab(G.op, Fs, 0, f.y0 + (f.y1 - f.y0)*(i + 1)/n - 0.1, (u0 + u1)/2, rr.hw, 0.1, (u1 - u0)/2 + 0.01, C.step); }
        [-rr.hw - 0.05, rr.hw + 0.05].forEach(function(x){ gbQuad(G.tile, tf(Fs, x, f.y0 - 0.3, -rr.hl), tf(Fs, x, f.y1 - 0.3, rr.hl), tf(Fs, x, f.y1 + 3.2, rr.hl), tf(Fs, x, f.y0 + 3, -rr.hl), C.tileW, [0, 0, 2*rr.hl/1.2, 3]); });
      });
    });
    var grp = new THREE.Group(); grp.name = "metro:station:" + st.id;
    var mOp = mesh(G.op, M.op, "op"), mTi = mesh(G.tile, M.tile, "tiles"), mAt = mesh(G.at, M.atlas, "signs"), mGl = mesh(G.gl, M.glass, "glass");
    mGl.renderOrder = 2; grp.add(mOp); grp.add(mTi); grp.add(mAt); grp.add(mGl);
    var bd = boardTex[st.id] || (boardTex[st.id] = makeBoard(st.id)), BB = GB();
    boards.forEach(function(b){ (b.two ? gbSign2 : gbSign)(BB, b.x, b.y, b.z, b.yaw, b.w, b.h, bd.uv); });
    if(boards.length){ var bm = keep(new THREE.MeshBasicMaterial({map: bd.t, toneMapped: false, side: DS})); grp.add(mesh(BB, bm, "boards")); }
    tris = gbTris(G.op) + gbTris(G.tile) + gbTris(G.at) + gbTris(G.gl) + gbTris(BB);
    under.add(grp);
    return {g: grp, psd: psd, gates: gates, board: bd, boardAt: -1e18, tris: tris, id: st.id};
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
    Object.keys(stCache).forEach(function(id){ var B = stCache[id]; B.g.visible = !!ids[id]; if(!ids[id] && hyp(Lay.byId[id].x - cam.x, Lay.byId[id].z - cam.z) > 800){ under.remove(B.g); if(boardTex[id]){ boardTex[id].dispose(); delete boardTex[id]; } B.g.traverse(function(x){ if(x.geometry){ x.geometry.dispose(); var i = disp.indexOf(x.geometry); if(i >= 0) disp.splice(i, 1); } }); delete stCache[id]; } });
    built = want.map(function(o){ return stCache[o.s.id] || (stCache[o.s.id] = buildStation(o.s)); });
    built.forEach(function(B){ B.g.visible = true; if(ms - B.boardAt > 5000){ B.boardAt = ms; B.board.draw(boardRows(B.id, ms), ms); } });
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
      B.gates.forEach(function(g){
        var near = g === nearest;
        var target = near ? 1 : 0;
        g.open = snap ? target : g.open + clamp(target - g.open, -dt*3, dt*3);
        if(near && !g.beep){ g.beep = true; sfx("validator", {pos: {x: g.x, y: g.y + 1, z: g.z}, kind: "door"}); }   // at the gate
        if(!near) g.beep = false;
        [-1, 1].forEach(function(lr){
          if(ng >= 400) return;
          var a = g.yaw + lr*g.open*PI/2*0.95, ox = Math.cos(g.yaw)*lr*0.28, oz = -Math.sin(g.yaw)*lr*0.28;
          m4.compose(v4.set(g.x + ox, g.y + 0.85, g.z + oz), q4.setFromAxisAngle(new THREE.Vector3(0, 1, 0), a + PI/2), one); GATEM.setMatrixAt(ng++, m4);
        });
      });
    });
    PSDM.count = nf; PSDM.visible = isUnderOn && nf > 0; PSDM.instanceMatrix.needsUpdate = true;
    GATEM.count = ng; GATEM.visible = isUnderOn && ng > 0; GATEM.instanceMatrix.needsUpdate = true;
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
    var R = sim.runs(v.line), run = v.run === "o" ? R.out : R.back, next = null, tau = ms/1000 - (v.k*HEADWAY + run.off);
    run.segs.forEach(function(g){ if(!next && g.type === "dwell" && g.t1 > tau) next = g.stop; });
    if(!strip){
      var T = canvasTex(1024, 64), Bq = GB(), F0 = frame(0, 0, 0, 0);
      [-1, 1].forEach(function(e){ [-4.6, 4.6].forEach(function(z){ var P = tf(F0, e*(CAR_HW - 0.12), FLOOR + 2.22, z); gbSign(Bq, P[0], P[1], P[2], e > 0 ? -PI/2 : PI/2, 3.2, 0.2, [0, 0, 1, 1]); }); });
      var geo = toGeo(Bq), mt = keep(new THREE.MeshBasicMaterial({map: T.t, toneMapped: false, side: DS}));
      strip = {T: T, mesh: new THREE.InstancedMesh(geo, mt, CARS), key: ""}; strip.mesh.frustumCulled = false; strip.mesh.name = "metro:train:route"; trainsG.add(strip.mesh);
    }
    var key = focusId + "|" + next;
    if(key !== strip.key){
      strip.key = key; var g = strip.T.g;
      if(g && g.fillRect){
        var L = sim.lineData(v.line), order = run.order, n = Math.max(2, order.length);
        g.fillStyle = "#0e1114"; g.fillRect(0, 0, 1024, 64); g.fillStyle = L.color; g.fillRect(20, 30, 700, 6);
        order.forEach(function(id, i){ var x = 20 + 700*i/(n - 1); g.fillStyle = id === next ? "#ffd84a" : "#ffffff"; g.fillRect(x - 6, 27, 12, 12); });
        g.fillStyle = "#ffd84a"; g.font = "700 26px system-ui, sans-serif"; g.textAlign = "left"; g.textBaseline = "middle";
        g.fillText(next ? "Next: " + (stopName[next] || "") : "Terminates here", 740, 32);
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
      Object.keys(boardTex).forEach(function(k){ boardTex[k].dispose(); }); boardTex = {};
    }
  };
  return V;
}
HQV.hqMetro.view = view;
HQV.hqMetro.atlasPlan = atlasPlan;

})();
