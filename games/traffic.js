/* Claude HQ: traffic for the 3D cities (HQV.traffic): cars, buses, trams and emergency runs.
 *
 * create(doc, {tier, grow, seed, onFare}) -> sim, a pure function of (world doc, city tier and growth,
 * clock): two clients with the same inputs see the same vehicles with no server traffic. Pure core:
 * no THREE, no DOM, so tests/test_traffic.py runs it under node; view(c) builds the instanced meshes.
 * Frames and units are the 3D city's: metres, +y up, yaw 0 faces +z, model-local +x is LEFT, so the
 * right of travel is (-cos yaw, sin yaw). Everyone drives on the right.
 *
 * Cars live on rings. The arterials (min_tier <= tier) give every edge a lane each way; at every node
 * the incoming lanes are paired with outgoing ones (the cheapest turns, no U-turn unless it is a dead
 * end), and since a node has as many lanes in as out the pairing splits the lanes into closed rings,
 * each lane in exactly one. A ring is a polyline: lanes trimmed back from the nodes, joined by Bezier
 * turns through each junction box.
 * Junctions are taken in turn: every movement through a node (ring turns and transit turns) gets a
 * colour, movements whose swept paths come within a vehicle width of each other get different colours,
 * and each colour owns a window of one global cycle H seconds (its width = the slowest occupant's time
 * to clear the box). A vehicle enters a box only at its window's start, so conflicting movements never
 * share a box.
 * Each ring has one speed profile S(t) (constant-acceleration pieces: cruise, slow, wait at the line,
 * pull away) whose lap time T is a multiple of H and whose box entries land on their windows. The car
 * in slot i drives S(t - i*H): every car crosses every box at its own window, and two cars k slots
 * apart are at least S(t) - S(t - k*H) apart, which create() measures over the whole lap and keeps at
 * least a car length plus GAP (k grows until it does). Slots fill by a seeded hash against a density
 * per tier (and growth), so a growing city adds cars without moving the others.
 * Transit: Layers.transit lines run where line.tier <= tier, on their own lateral lane (trams by the
 * centre line, buses at the kerb; an edge too narrow for cars beside them carries no cars). A line's
 * profile is built the same way with a stop (DWELL s) at each stop site, slack absorbed by holding at
 * the stop, so the timetable is the profile: nextArrival() is exact. Trams are double-ended: at an
 * out-and-back terminus they cross over, stand LAYOVER s and change ends instead of U-turning. A
 * transit movement through a box is tested by its swept body; its window goes where it blocks the
 * fewest car slots (a gap between the car windows, when the cycle has one). Lines of a kind sharing a
 * lane (buses through the hub) take it in turn: one line's vehicle on it at a time, from the measured
 * times each vehicle spends there (laps padded to a common period, lines offset by whole cycles).
 * Emergency runs: every INC_W s window has an incident with probability INC_P (seeded); a fire truck,
 * an ambulance or a police car leaves its station (a fire / hospital or clinic / police site), drives
 * the shortest road path to a node 120..1200 m away with lights on, waits on scene and drives back.
 * It never shares a car lane (it runs on the tram track, in the bus lane, or down the middle where
 * that clears both car lanes), takes each box when nothing that clashes is in it, and starts when
 * its time on tram tracks and bus lanes misses every tram and bus; cars within EV_YIELD m pull over.
 * at(timeMs, center, radius, obstacles): the vehicles within radius, nearest first, as {id, kind, x,
 * y, z, yaw, speed} (the body's centre) plus paint / line / pull / siren (wail: its siren sounding, on the
 * way to the scene), and a tram's two sections as parts [{x, y, z, yaw}]. sirens(timeMs, center, radius):
 * only the emergency runs, as at() lists them. Obstacles (the player's vehicle, {x, z, r}) make cars and transit brake
 * behind them: a local override (a lag per vehicle, eased back to the timetable once clear),
 * deterministic for the same sequence of calls, and never fed back into the shared schedule.
 * Riding: stopsNear(x, z, r), nextArrival(stopId, timeMs), rideTo(line, from, to, timeMs) -> a trip
 * the integrator moves the player along (trip.pose(ms)); trip.pay() calls the onFare hook once (the
 * integrator POSTs /api/arena/city/:owner/fare {kind}). HQ 3.15 rides are free: new code uses service().
 * HQ 3.15 (docs/plans/transport-revamp.md 3.1, 3.2, 5.3), pure:
 *   lanes(W, tier, sim?)      per edge {id, a, b, tram, tramOff, bus: [dir0, dir1], busOff, cars, carOff, half}
 *   tramPaths(W, tier, sim?)  the tram track centre lines as driven: lanes, turn curves through the boxes and
 *                             the terminus crossovers, [{line, lines, kind, key, pts: [x, y, z, ...]}]
 *   tramStops(W, tier, sim?)  where each line's tram stands at each stop
 *   service(sim, "bus"|"tram", {W}) the Service contract (lines, stops, stopsNear, departures, trip, vehicles)
 *   SEATS / STANDS / DOORS / FLOOR: the vehicle-local seat table shared with games/hqcoach.js
 * W may be a doc or a packed world; without a sim a layout-only build (no timetables) is made and memoised.
 * HQ 3.21 city life (games/citylife.js, when loaded; o.W the packed world, o.local(ms) -> local ms or a fixed offset,
 * o.closed(localMs) -> {edge id: kind} to override HQV.cityLife.closed, o.groupAt(x, z, yaw, half) -> a district group
 * to override the world's): a car is out on a lap when its slot hash is
 * under density x demand(local hour, the ring's street kind), and a ring through a street closed during the lap waits
 * the lap out at its start; each car is a car, taxi, van, lorry, scooter or bike by mix(its district, kind, hour).
 * at() gives a car's type as v.type (kind stays "car"); cars(ms) and closed(ms) list the lap states and closures.
 * Demand only thins today's density and a closure only takes cars off: rings, slots and timetables are unchanged.
 * HQ 3.22 traffic lights (city play; when citylife.js is loaded with the packed world and o.signals !== false): at the
 * nodes of HQV.cityLife.signals(W) every movement goes in on its light's green. The plan above changes so:
 *  - a slot carries a platoon of up to r.P cars (PMAX; PRING on a ring with no lights), nose to tail behind the first one
 *    out on the slot's timetable (at(): platoons()); its box passes are held until its last car is out (sClear);
 *  - the window period: the lights' cycle SIG_C at a light (the long cycle HB = SIG_C too, laps multiples of it), the
 *    shortest of SIG_DIVS that holds the windows elsewhere; a ring through any light has a slot a cycle (Hr);
 *  - at a light (sigPlace) each colour is one light axis's; the buses' and trams' windows go first in their green, then
 *    the cars', each where it is clear of the windows it clashes with, early enough for its whole platoon to be in
 *    before the amber, floating on to its deadline (a platoon that comes up on green drives on); a box that does not
 *    fit (overfull) takes a car off the platoons through it and the plan is made again (planCars);
 *  - at a red the platoon stops with its nose on the line and pulls away on its window (profileOf); where its queue
 *    would reach back into the box behind it waits at that box's line instead and rolls on through (relays: don't
 *    block the box); boxes closer than MERGE m along a road (or a light's short link, sig.links) are one box
 *    (clusterOf), so nothing queues between them; a ring no bus or tram lets through at all has a car off its platoons
 *    and the plan is made again;
 *  - a platoon that comes up on one waiting ahead queues nose to tail behind it (softly; at() platoons()), never ahead
 *    of its own timetable, only where that never stands in a box (queueOk), else the slots are spaced wider.
 * Everything stays a pure function of (doc, seed, tier, the clock): every client sees the same lights and queues.
 * Emergency runs ignore the lights (they take each box when it is clear, as before). lightAt(x, z, heading, ms) ->
 * {state, sig, dist} the light ahead (for the police); signals() the lights. Without lights the plan is today's.
 * street(THREE, scene, W): the lights (poles, lit heads, stop lines) and cityLife.parked(W)'s cars, drawn near you.
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : self;
var HQV = root.HQV = root.HQV || {};

/* ---------- constants ---------- */
var ARTERIAL = {arterial: 1, avenue: 1, highway: 1, ring: 1};
// lengths, widths m; vmax m/s; acc m/s^2
var SPEC = {
  car:       {len: 3.8, wid: 1.85, vmax: 12, acc: 2.2, wb: 2.4},
  bus:       {len: 12, wid: 2.55, vmax: 9, acc: 1.2, wb: 6},
  tram:      {len: 27, wid: 2.65, vmax: 10, acc: 1.1, wb: 8, sec: 13},
  fire:      {len: 8, wid: 2.5, vmax: 15, acc: 2.5, wb: 4.5},
  ambulance: {len: 6, wid: 2.2, vmax: 16, acc: 3, wb: 3.6},
  police:    {len: 4.6, wid: 1.9, vmax: 17, acc: 3.5, wb: 2.7},
  // [3.21 city life] what a car's slot carries (TYPES): it drives the ring's car profile (the slot is the timetable),
  // so vmax / acc here are what City Gen v4 may give each its own lane speed by; len / wid are its body (solid,
  // drawn). A van or lorry is nose-aligned with a car (shifted back by (len - car.len)/2): it reaches every box
  // line where a car would and clears the box within CLEAR of a car's time at turning speed
  taxi:      {len: 3.8, wid: 1.85, vmax: 12, acc: 2.2, wb: 2.4},
  van:       {len: 4.6, wid: 1.95, vmax: 11, acc: 1.8, wb: 2.9},
  lorry:     {len: 6.8, wid: 2.4, vmax: 10, acc: 1.2, wb: 4},
  scooter:   {len: 1.8, wid: 0.7, vmax: 12, acc: 2.6, wb: 1.25},
  bike:      {len: 1.75, wid: 0.6, vmax: 7, acc: 1.2, wb: 1.05}
};
// [3.21] the vehicle types of HQV.cityLife.mix(); LONG: the longer ones, which need room in front and behind
var TYPES = ["car", "taxi", "van", "lorry", "scooter", "bike"], LONG = {van: 1, lorry: 1}, TWO = {scooter: 1, bike: 1};
var LMAX = SPEC.lorry.len, CLOSE_STEP = 9e5;     // the longest body; closures are looked up every 15 min over a lap
var TAXI = 0xf2b705, TAXI_SIGN = 0xffe27a, VAN_PAINT = [0xf2f2ee, 0xf2f2ee, 0xd9dde2, 0x2a6fd6, 0xc8323c, 0x2b2f36],
    LORRY_PAINT = [0xf2f2ee, 0xe6e2d6, 0x2a6fd6, 0x2f8f5b, 0xd9772b, 0xc8323c], BIKE_PAINT = [0x2b2f36, 0x2a6fd6, 0xc8323c, 0x2f8f5b, 0xe8b730];
var GAP = 2.6;                          // bumper to bumper, at the closest
var V_STRAIGHT = 9, V_TURN = 6.5, V_UTURN = 3, V_CREEP = 2.5, CLEAR = 0.6, CLASH = 0.3, H_MIN = 6, H_MAX = 16, REPS = 3;
var DWELL = 20, FARE = 2, LAYOVER = 30, XOVER = 30, BLOCK = 15, BAY = 2.9, RAMP = 12, BAY_BLOCK = 3, BAY_YAW = 0.15;
var DENS = [0.3, 0.45, 0.6, 0.72, 0.85];  // share of a ring's slots with a car, per tier
var HEADWAY = {bus: 240, tram: 300};      // target seconds between vehicles on a line
var INC_W = 240, INC_P = 0.3, INC_LOOK = 3, EV_DWELL = 40, EV_YIELD = 45, EV_NEAR = 120, EV_FAR = 1200, EV_HW = 1.25, EV_TRY = 90, EV_HOLD = 90;
var EV_KINDS = ["fire", "ambulance", "police"];
var EV_SITES = {fire: {fire: 1}, ambulance: {hospital: 1, clinic: 1}, police: {police: 1}};
var PULL_TAPER = 10, LOOK = 34, BRAKE = 14, CATCH = 0.6, CATCH_MAX = 4, OBS_R = 2.4;
var CAP = {car: 200, bus: 32, tram: 16, fire: 6, ambulance: 6, police: 6, van: 160, lorry: 100, scooter: 120, bike: 120, taxi: 120};   // [3.22] more of the types: platoons
// [3.22] traffic lights: a wait shorter than SIG_EPS s is rolled through; QSOFT m the softness of a queue's hold, QSTEP s
// its check's step; the lights' cycle (HQV.cityLife.SIG.cycle), a car's start after its green comes on, the window
// periods (each divides the next, and the cycle), the most cars in a platoon (on a ring through lights; elsewhere),
// the share of a platoon's places j that hold a car
var SIG_EPS = 0.05, QSOFT = 1.2, QSTEP = 0.25, SIG_C = 60, SIG_LEAD = 1.2, SIG_DIVS = [7.5, 15, 30, 60], PMAX = 6, PRING = 2, FILL = [1, 0.95, 0.9, 0.85, 0.75, 0.65];
var PAINT = [0xc8323c, 0x2a6fd6, 0xf2f2ee, 0x2b2f36, 0x8a9199, 0xe8b730, 0x2f8f5b, 0x6b4bb8, 0xd9772b, 0x8fb8de, 0x5a1f2b, 0xb7c2a0];

/* ---------- small maths ---------- */
function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function num(v, d){ return typeof v === "number" && isFinite(v) ? v : d; }
function mod(a, m){ a %= m; return a < 0 ? a + m : a; }
function ease(k, dt){ return 1 - Math.exp(-Math.max(0, +k || 0)*Math.max(0, +dt || 0)); }
function smooth(t){ t = clamp(t, 0, 1); return t*t*(3 - 2*t); }
function hash32(str){
  str = String(str == null ? "" : str);
  var h = 0x811c9dc5;
  for(var i = 0; i < str.length; i++){ h ^= str.charCodeAt(i) & 0xff; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
// a deterministic number in [0, 1) from a seed and two integers
function h01(seed, a, b){
  var h = (Math.imul(seed | 0, 0x27d4eb2d) + Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0)/4294967296;
}

/* ---------- polylines: points [[x, y, z], ...] in metres ---------- */
function plOf(pts){
  var n = pts.length, x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n), cum = new Float64Array(n);
  for(var i = 0; i < n; i++){
    x[i] = pts[i][0]; y[i] = pts[i][1]; z[i] = pts[i][2];
    if(i) cum[i] = cum[i-1] + Math.hypot(x[i] - x[i-1], z[i] - z[i-1]);
  }
  return {x: x, y: y, z: z, cum: cum, len: n ? cum[n-1] : 0, n: n};
}
function seg(pl, s){
  var lo = 0, hi = pl.n - 1;
  while(hi - lo > 1){ var m = (lo + hi) >> 1; if(pl.cum[m] <= s) lo = m; else hi = m; }
  return lo;
}
function plAt(pl, s, o){
  o = o || {};
  s = clamp(s, 0, pl.len);
  var i = seg(pl, s), j = Math.min(i + 1, pl.n - 1), d = pl.cum[j] - pl.cum[i], t = d > 1e-9 ? (s - pl.cum[i])/d : 0;
  o.x = pl.x[i] + (pl.x[j] - pl.x[i])*t; o.y = pl.y[i] + (pl.y[j] - pl.y[i])*t; o.z = pl.z[i] + (pl.z[j] - pl.z[i])*t; o.i = i;
  return o;
}
function len2(pts){ var L = 0; for(var i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i-1][0], pts[i][2] - pts[i-1][2]); return L; }
function dirAt(pts, end){
  var n = pts.length, a = end ? pts[Math.max(0, n - 2)] : pts[0], b = end ? pts[n-1] : pts[Math.min(1, n - 1)];
  var dx = b[0] - a[0], dz = b[2] - a[2], l = Math.hypot(dx, dz) || 1;
  return [dx/l, dz/l];
}
// the polyline moved `off` m to the right of travel (mitred joins, the mitre capped at 2x)
function offsetPts(pts, off){
  if(!off) return pts.map(function(p){ return p.slice(); });
  var n = pts.length, out = [];
  for(var i = 0; i < n; i++){
    var a = pts[Math.max(0, i - 1)], b = pts[i], c = pts[Math.min(n - 1, i + 1)];
    var d1x = b[0] - a[0], d1z = b[2] - a[2], d2x = c[0] - b[0], d2z = c[2] - b[2];
    var l1 = Math.hypot(d1x, d1z), l2 = Math.hypot(d2x, d2z);
    if(l1 < 1e-9){ d1x = d2x; d1z = d2z; l1 = l2; }
    if(l2 < 1e-9){ d2x = d1x; d2z = d1z; l2 = l1; }
    l1 = l1 || 1; l2 = l2 || 1;
    var nx = -(d1z/l1 + d2z/l2), nz = d1x/l1 + d2x/l2, nl = Math.hypot(nx, nz);
    if(nl < 1e-6){ nx = -d1z/l1; nz = d1x/l1; nl = 1; }
    nx /= nl; nz /= nl;
    var cs = nx*(-d1z/l1) + nz*(d1x/l1), k = off/Math.max(0.5, cs);
    out.push([b[0] + nx*k, b[1], b[2] + nz*k]);
  }
  return out;
}
// cut r0 m off the start and r1 m off the end (along the line)
function trimPts(pts, r0, r1){
  var L = len2(pts), a = clamp(r0, 0, L), b = clamp(L - r1, a, L), out = [], acc = 0;
  function lerpP(p, q, t){ return [p[0] + (q[0] - p[0])*t, p[1] + (q[1] - p[1])*t, p[2] + (q[2] - p[2])*t]; }
  for(var i = 1; i < pts.length; i++){
    var p = pts[i-1], q = pts[i], d = Math.hypot(q[0] - p[0], q[2] - p[2]), e = acc + d;
    if(d > 1e-9){
      if(!out.length && e >= a) out.push(lerpP(p, q, (a - acc)/d));
      if(out.length && e > a && e < b) out.push(q.slice());
      if(e >= b){ out.push(lerpP(p, q, (b - acc)/d)); break; }
    }
    acc = e;
  }
  if(out.length < 2) out = [pts[0].slice(), pts[pts.length - 1].slice()];
  return out;
}
// a cubic Bezier turn from p0 heading d0 to p1 heading d1, n segments (both ends included)
function turnPts(p0, d0, p1, d1, n){
  var dist = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]), uturn = d0[0]*d1[0] + d0[1]*d1[1] < -0.7;
  var k = uturn ? Math.max(dist*0.9, 2.5) : Math.max(dist*0.42, 0.5);
  var c0 = [p0[0] + d0[0]*k, p0[2] + d0[1]*k], c1 = [p1[0] - d1[0]*k, p1[2] - d1[1]*k], out = [];
  for(var i = 0; i <= n; i++){
    var t = i/n, u = 1 - t, b0 = u*u*u, b1 = 3*u*u*t, b2 = 3*u*t*t, b3 = t*t*t;
    out.push([b0*p0[0] + b1*c0[0] + b2*c1[0] + b3*p1[0], p0[1] + (p1[1] - p0[1])*t, b0*p0[2] + b1*c0[1] + b2*c1[1] + b3*p1[2]]);
  }
  return out;
}
// a D-shaped loop from p0 heading d0 back to p0 heading -d0, R m deep and to the left (the way a
// right-hand-traffic U-turn goes); both ends meet the lane straight
function loopPts(p0, d0, R){
  var out = [], lx = d0[1], lz = -d0[0];
  for(var k = 0; k <= 24; k++){
    var th = k/24*2*Math.PI, u = R*Math.sin(th/2), v = 0.35*R*(1 - Math.cos(th));
    out.push([p0[0] + d0[0]*u + lx*v, p0[1], p0[2] + d0[1]*u + lz*v]);
  }
  return out;
}
function turnAngle(d0, d1){ return Math.atan2(d0[0]*d1[1] - d0[1]*d1[0], d0[0]*d1[0] + d0[1]*d1[1]); }
function segDist(ax, az, bx, bz, cx, cz, dx, dz){
  function pd(px, pz, x0, z0, x1, z1){
    var ux = x1 - x0, uz = z1 - z0, l = ux*ux + uz*uz, t = l > 1e-12 ? clamp(((px - x0)*ux + (pz - z0)*uz)/l, 0, 1) : 0;
    return Math.hypot(px - x0 - ux*t, pz - z0 - uz*t);
  }
  var d1 = (bx - ax)*(cz - az) - (bz - az)*(cx - ax), d2 = (bx - ax)*(dz - az) - (bz - az)*(dx - ax);
  var d3 = (dx - cx)*(az - cz) - (dz - cz)*(ax - cx), d4 = (dx - cx)*(bz - cz) - (dz - cz)*(bx - cx);
  if(((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(pd(ax, az, cx, cz, dx, dz), pd(bx, bz, cx, cz, dx, dz), pd(cx, cz, ax, az, bx, bz), pd(dx, dz, ax, az, bx, bz));
}
function pathDist(A, B){
  var best = 1e9;
  for(var i = 1; i < A.length; i++) for(var j = 1; j < B.length; j++){
    var d = segDist(A[i-1][0], A[i-1][2], A[i][0], A[i][2], B[j-1][0], B[j-1][2], B[j][0], B[j][2]);
    if(d < best) best = d;
  }
  return best;
}

/* ---------- speed profiles: constant-acceleration pieces ---------- */
// {t: start times, s: start positions, v: start speeds, a: accelerations, T: lap seconds, L: lap metres}
function trapTime(Lm, v0, v1, vc, a){
  if(vc <= 1e-6) return Infinity;
  var d1 = Math.abs(vc*vc - v0*v0)/(2*a), d2 = Math.abs(vc*vc - v1*v1)/(2*a);
  if(d1 + d2 > Lm + 1e-9) return Infinity;
  return Math.abs(vc - v0)/a + Math.abs(vc - v1)/a + (Lm - d1 - d2)/vc;
}
// the fastest way over Lm from v0 to v1 (cruise <= vmax): {vc, a, T}
function fastest(Lm, v0, v1, vmax, a){
  if(Lm <= 1e-6) return {vc: Math.max(v0, v1), a: a, T: 0};
  if(trapTime(Lm, v0, v1, vmax, a) < Infinity) return {vc: vmax, a: a, T: trapTime(Lm, v0, v1, vmax, a)};
  var vp = Math.sqrt(a*Lm + (v0*v0 + v1*v1)/2);
  if(vp >= Math.max(v0, v1)) return {vc: vp, a: a, T: Math.abs(vp - v0)/a + Math.abs(vp - v1)/a};
  // too short to change speed at a: one ramp, harder
  return {vc: Math.max(v0, v1), a: Math.abs(v0*v0 - v1*v1)/(2*Lm), T: 2*Lm/(v0 + v1)};
}
function Profile(){ this.t = []; this.s = []; this.v = []; this.a = []; this.T = 0; this.L = 0; this.cur = {t: 0, s: 0, v: 0}; }
Profile.prototype.piece = function(dur, a){
  var c = this.cur;
  if(!(dur > 1e-9)) return;
  this.t.push(c.t); this.s.push(c.s); this.v.push(c.v); this.a.push(a);
  c.s += c.v*dur + 0.5*a*dur*dur; c.v = Math.max(0, c.v + a*dur); c.t += dur;
};
// cover Lm metres in D seconds from the current speed to v1
Profile.prototype.segment = function(Lm, v1, D, spec){
  var c = this.cur, v0 = c.v, a = spec.acc, s1 = c.s + Lm, t1 = c.t + D;
  if(Lm <= 1e-6){ c.v = 0; this.piece(D, 0); c.v = v1; c.s = s1; c.t = t1; return; }
  var f = fastest(Lm, v0, v1, spec.vmax, a);
  if(D <= f.T + 1e-6) this.trap(Lm, v0, v1, f.vc, f.a);
  else {
    var aS = Math.max(a, (v0*v0 + v1*v1)/(1.8*Lm));
    if(v0 > 0 && trapTime(Lm, v0, v1, V_CREEP, aS) >= D) this.trap(Lm, v0, v1, this.solve(Lm, v0, v1, D, aS, V_CREEP, f.vc), aS);
    else if(v0 <= 1e-6){
      var g = fastest(Lm, 0, v1, spec.vmax, a);
      this.piece(D - g.T, 0); this.trap(Lm, 0, v1, g.vc, g.a);
    } else {
      // cruise on, brake to a stop short of the end, wait, pull away
      var d1 = v0*v0/(2*aS), d2 = v1*v1/(2*aS), Lc = Lm - d1 - d2, M = Lc/v0 + v0/aS + v1/aS;
      if(D - M >= 0){ this.piece(Lc/v0, 0); this.piece(v0/aS, -aS); c.v = 0; this.piece(D - M, 0); this.piece(v1/aS, aS); }
      else this.trap(Lm, v0, v1, this.solve(Lm, v0, v1, D, aS, 1e-3, V_CREEP), aS);
    }
  }
  c.s = s1; c.t = t1; c.v = v1;
};
Profile.prototype.solve = function(Lm, v0, v1, D, a, lo, hi){
  for(var i = 0; i < 60; i++){ var m = (lo + hi)/2; if(trapTime(Lm, v0, v1, m, a) > D) lo = m; else hi = m; }
  return hi;
};
Profile.prototype.trap = function(Lm, v0, v1, vc, a){
  var c = this.cur, t1 = Math.abs(vc - v0)/a, t2 = Math.abs(vc - v1)/a;
  var d1 = Math.abs(vc*vc - v0*v0)/(2*a), d2 = Math.abs(vc*vc - v1*v1)/(2*a);
  this.piece(t1, vc >= v0 ? a : -a); c.v = vc;
  this.piece(Math.max(0, Lm - d1 - d2)/vc, 0);
  this.piece(t2, v1 >= vc ? a : -a);
};
// position (from the lap start, not wrapped) and speed at lap time u in [0, T)
Profile.prototype.at = function(u, o){
  var t = this.t, lo = 0, hi = t.length - 1;
  while(hi > lo){ var m = (lo + hi + 1) >> 1; if(t[m] <= u) lo = m; else hi = m - 1; }
  var d = u - t[lo], a = this.a[lo], v = this.v[lo];
  // a piece's speed never goes below 0 (a stop is a hold piece)
  if(a < 0 && v + a*d < 0) d = v/-a;
  o.s = this.s[lo] + v*d + 0.5*a*d*d; o.v = Math.max(0, v + a*d);
  return o;
};
// position at any time, unwrapped (laps add L)
Profile.prototype.S = function(t, o){
  var k = Math.floor(t/this.T), r = this.at(t - k*this.T, o || {});
  r.s += k*this.L; return r;
};

/* ---------- build ---------- */
function create(doc, o){
  o = o || {};
  doc = doc || {};
  var L = doc.layers || doc, R = L.roads || {nodes: doc.nodes, edges: doc.edges};
  var tier = clamp(num(o.tier, 1) | 0, 1, 5), grow = clamp(num(o.grow, 0), 0, 1000);
  var seed = typeof o.seed === "number" ? o.seed | 0 : hash32(o.seed != null ? o.seed : (doc.id || "city"));
  var dens = tier >= 5 ? DENS[4] : DENS[tier - 1] + (DENS[tier] - DENS[tier - 1])*grow/1000;
  var fareHook = typeof o.onFare === "function" ? o.onFare : null;
  var tmpA = {}, tmpB = {}, tmpC = {};

  // nodes and active edges, in metres
  var nodes = {}, nodeIds = [];
  (R.nodes || []).forEach(function(n){ nodes[n.id] = {id: n.id, x: num(n.x, 0)/100, y: num(n.y, 0)/100, z: num(n.z, 0)/100, inc: []}; nodeIds.push(n.id); });
  var edges = [];
  (R.edges || []).forEach(function(e){
    if(e.min_tier != null && (e.min_tier | 0) > tier) return;
    var A = nodes[e.a], B = nodes[e.b];
    if(!A || !B || e.a === e.b) return;
    var pts = e.points && e.points.length >= 2 ? e.points.map(function(p){ return [num(p[0], 0)/100, num(p[1], 0)/100, num(p[2], 0)/100]; })
      : (e.pts ? ptsOfPacked(e.pts) : [[A.x, A.y, A.z], [B.x, B.y, B.z]]);
    var width = num(e.width, 1200), walk = num(e.walk, 200), cls = String(e["class"] || e.cls || "street");
    var E = {i: edges.length, id: e.id, a: e.a, b: e.b, cls: cls, art: !!ARTERIAL[cls], pts: pts, len: len2(pts),
             c: Math.max(1.5, (width - 2*walk)/200), bus: [false, false], tram: false};
    if(E.len < 1) return;
    edges.push(E); A.inc.push(E.i); B.inc.push(E.i);
  });
  function ptsOfPacked(p){ var out = []; for(var i = 0; i + 2 < p.length; i += 3) out.push([p[i]/100, p[i+1]/100, p[i+2]/100]); return out; }
  function edgeBetween(u, v){
    var A = nodes[u], best = null;
    if(!A) return null;
    A.inc.forEach(function(i){
      var E = edges[i];
      if((E.a === u && E.b === v) || (E.b === u && E.a === v)) if(!best || (E.art && !best.art) || (E.art === best.art && E.len < best.len)) best = E;
    });
    return best ? {e: best, dir: best.a === u ? 0 : 1} : null;
  }

  // sites (stops, stations) that exist at this tier
  var sites = {};
  (L.sites || []).forEach(function(s){
    if(s.tier != null && (s.tier | 0) > tier) return;
    sites[s.id] = {id: s.id, kind: String(s.kind || ""), x: num(s.x, 0)/100, y: num(s.y, 0)/100, z: num(s.z, 0)/100};
  });

  // transit lines (tier gated) as lane sequences
  var lineDefs = [], errors = [];
  var TL = (L.transit && L.transit.lines) || [];
  TL.forEach(function(l){
    var kind = l.kind === "tram" ? "tram" : "bus";
    if((l.tier | 0) > tier) return;
    var path = (l.path || []).slice(), outBack = false;
    if(path.length < 2){ errors.push("line " + l.id + ": short path"); return; }
    if(path[0] === path[path.length - 1]) path.pop();
    else if(!edgeBetween(path[path.length - 1], path[0])){ path = path.concat(path.slice(1, -1).reverse()); outBack = true; }   // out and back
    var lanes = [];
    for(var i = 0; i < path.length; i++){
      var eb = edgeBetween(path[i], path[(i + 1) % path.length]);
      if(!eb){ errors.push("line " + l.id + ": no road " + path[i] + "-" + path[(i + 1) % path.length]); return; }
      lanes.push({e: eb.e, dir: eb.dir});
    }
    lanes.forEach(function(ln){ if(kind === "tram") ln.e.tram = true; else ln.e.bus[ln.dir] = true; });
    lineDefs.push({id: String(l.id), kind: kind, tier: l.tier | 0, lanes: lanes, stops: (l.stops || []).map(String), outBack: outBack});
  });

  // lateral plan per edge: m to the right of the centre line, per direction
  edges.forEach(function(E){
    var inner = 0.15, c = E.c, tw = SPEC.tram.wid, cw = SPEC.car.wid, bw = SPEC.bus.wid;
    E.tramOff = E.tram ? inner + tw/2 : null;
    // [3.20.1] in the kerb-side lane of a road with two or three each way (worldgeom.js lanesEach), else mid-carriageway
    var n = Math.max(1, Math.min(3, Math.floor(c/3.3)));
    var in2 = E.tram ? inner + tw + 0.3 : inner, carOff = Math.max(in2 + cw/2 + 0.1, E.tram ? 0 : c*(2*n - 1)/(2*n)), anyBus = E.bus[0] || E.bus[1];
    if(anyBus) carOff = in2 + cw/2 + 0.1;
    var carEdge = carOff + cw/2;
    E.cars = E.art && carEdge <= c + 0.05 && (!anyBus || carEdge + 0.25 + bw <= c);
    E.carOff = E.cars ? carOff : null;
    E.busOff = Math.max(c - bw/2 - 0.1, (E.cars ? carEdge + 0.25 : in2) + bw/2);
    E.room = E.cars ? Math.max(0, c - (anyBus ? bw + 0.35 : 0) - carEdge - 0.15) : 0;   // how far a car can pull over
    // an emergency vehicle never shares a car lane: it runs on the tram track, else in the bus lane,
    // else down the middle when that clears both car lanes (else it does not use the road)
    E.evOff = E.tram ? E.tramOff : anyBus ? E.busOff : 0;
    E.evKind = E.tram ? "tram" : anyBus ? "bus" : null;
    E.ev = !!(E.tram || anyBus || !E.cars || carOff - cw/2 >= EV_HW + 0.1);
  });

  // junction radii: the boxes vehicles turn through. A node where a side street (no traffic of its
  // own, but an emergency run may come down it) meets a through road is a junction too: its box spans
  // the through road, so a vehicle held at its line stays out of the lanes it crosses
  var used = {};
  edges.forEach(function(E){ if(E.cars || E.tram || E.bus[0] || E.bus[1]){ used[E.a] = used[E.a] || []; used[E.b] = used[E.b] || []; used[E.a].push(E); used[E.b].push(E); } });
  var radius = {};
  Object.keys(used).forEach(function(id){
    var list = used[id], deg = nodes[id].inc.filter(function(i){ return edges[i].ev || list.indexOf(edges[i]) >= 0; }).length, maxC = 0, minLen = 1e9;
    list.forEach(function(E){ maxC = Math.max(maxC, E.c); minLen = Math.min(minLen, E.len); });
    radius[id] = Math.min(deg >= 3 ? maxC + 2 : deg === 2 ? 2.5 : 1, 0.4*minLen);
  });

  // [3.22] traffic lights (HQV.cityLife.signals, on the packed world): at a signalised node every lane in stops at
  // its arm's stop line (clear of the zebra), so the box reaches out to it, arm by arm
  var CL = o.life === false ? null : HQV.cityLife, WQ = HQV.world, LW = o.W || (doc.districts && doc.edges && doc.edges.length && doc.edges[0].pts ? doc : null);
  var SIGS = {}, sigAt = {}, sigStop = {};
  if(CL && CL.signals && CL.signalAt && LW && o.signals !== false){ try { SIGS = CL.signals(LW) || {}; } catch(e){ SIGS = {}; } }
  Object.keys(SIGS).forEach(function(id){
    var sg = SIGS[id];
    if(!nodes[id] || !used[id] || !sg || !sg.arms || !sg.green || num(sg.cycle, SIG_C) !== SIG_C) return;
    sigAt[id] = sg; sigStop[id] = {};
    sg.arms.forEach(function(a){ sigStop[id][a.edge] = num(a.stop, 0); });
  });
  var sigOn = Object.keys(sigAt).length > 0, LIGHT = (CL && CL.SIG) || {amber: 3, allRed: 2};
  var localOf = typeof o.local === "function" ? o.local : (function(off){ return function(ms){ return ms + off; }; })(num(o.local, 0));
  // the lights run on the local clock; the timetable on the shared one. Time zones are whole minutes and the cycle
  // divides 15, so the two agree, but whatever the local clock adds is carried over (lo s)
  var lo = 0;
  if(sigOn){ try { lo = mod(num(localOf(0), 0)/1000, SIG_C); } catch(e){ lo = 0; } }
  function trimOf(node, E){
    var r = radius[node] || 0, st = sigStop[node];
    if(st && st[E.id] != null) r = Math.max(r, Math.min(st[E.id], 0.4*E.len));
    return r;
  }

  // [3.22] junction clusters: with lights, two junctions whose boxes are under MERGE m apart along a road with
  // traffic (or a short link the lights treat as one junction: cityLife's sig.links) are one box to the timetable,
  // so nothing ever queues on the link between them: clusterOf[node] -> "k" + the cluster's least node id
  var clusterOf = null, MERGE = 30;
  if(sigOn){
    var boxy = {}, par = {}, links = {};
    Object.keys(used).forEach(function(id){ if(sigAt[id] || used[id].length >= 3){ boxy[id] = 1; par[id] = id; } });
    Object.keys(sigAt).forEach(function(id){ (sigAt[id].links || []).forEach(function(e){ links[e] = 1; }); });
    var root = function(a){ while(par[a] !== a) a = par[a] = par[par[a]]; return a; };
    edges.forEach(function(E){
      var a = String(E.a), b = String(E.b);
      if(!(E.cars || E.tram || E.bus[0] || E.bus[1]) || !boxy[a] || !boxy[b]) return;
      // (two lights a road apart stay two boxes, each car stopping at each, unless the lights make them one: links)
      if(!links[E.id] && (E.len - trimOf(E.a, E) - trimOf(E.b, E) >= MERGE || (sigAt[a] && sigAt[b]))) return;
      var ra = root(a), rb = root(b);
      if(ra === rb) return;
      if((+ra) - (+rb) < 0 || ((+ra) === (+rb) && ra < rb)) par[rb] = ra; else par[ra] = rb;
    });
    var size = {};
    Object.keys(par).forEach(function(id){ var k = root(id); size[k] = (size[k] || 0) + 1; });
    clusterOf = {};
    Object.keys(par).forEach(function(id){ var k = root(id); if(size[k] > 1) clusterOf[id] = "k" + k; });
  }
  // a route's passes as the timetable sees them: consecutive passes through one cluster are one pass (from the first
  // box line to the last box's exit); every pass knows the light it goes by (sn: the first node it crosses with one;
  // h: the heading it comes into that node on) and its box (node: the cluster's id at a cluster)
  function boxes(P, spec){
    var out = [];
    P.forEach(function(p){
      var c = clusterOf ? clusterOf[p.node] : null, last = out[out.length - 1];
      var q = {};
      for(var k in p) q[k] = p[k];
      q.nodes = [p.node]; q.hs = [p.h];
      if(c != null && last && last.box === c && p.sIn >= last.sOut - 1e-6 && last.nodes.indexOf(p.node) < 0 && p.v > V_UTURN && last.v > V_UTURN){
        last.sOut = p.sOut; last.v = Math.min(last.v, p.v); last.curve = last.curve.concat(p.curve.slice(1));
        last.nodes.push(p.node); last.hs.push(p.h); last.turn = last.turn || p.turn;
        last.occ = (last.sOut - last.sIn + spec.len - last.front)/last.v + CLEAR;
        return;
      }
      q.box = c;
      out.push(q);
    });
    out.forEach(function(q){
      q.sn = null;
      for(var i = 0; i < q.nodes.length && q.sn == null; i++) if(sigAt[q.nodes[i]]){ q.sn = String(q.nodes[i]); q.h = q.hs[i]; }
      if(q.box != null) q.node = q.box;
    });
    return out;
  }

  // a lane: the edge's points in travel order, offset to the right, trimmed back from both nodes
  function lanePts(E, dir, off){
    var pts = dir ? E.pts.slice().reverse() : E.pts, from = dir ? E.b : E.a, to = dir ? E.a : E.b;
    return trimPts(offsetPts(pts, off), trimOf(from, E), trimOf(to, E));
  }
  function laneNode(E, dir, end){ return end ? (dir ? E.a : E.b) : (dir ? E.b : E.a); }

  // a route: lanes joined by turns through each node; {pl, passes, cusps, ranges}.
  // ranges[i] = [s0, s1, trim, other]: the stretch of the line lane i covers, how much was cut off the
  // lane's start (so s - s0 + trim is the place along the lane), and for a tram's crossover the other
  // track's length. An open route (an emergency run) has no closing turn back to its first lane
  // A tram is double-ended: where its line runs back down the edge it came up (an out-and-back
  // terminus) it never U-turns through the box. It crosses over to the other track on the way in,
  // stops with its nose short of the box and the driver changes ends: the line doubles back on itself
  // at a cusp (the body's centre), and poses past a cusp fold back across it (bodyAt).
  function route(lanes, spec, open){
    var pts = [], passes = [], cusps = [], ranges = [], acc = 0, n = lanes.length, LP = lanes.map(function(ln){ return lanePts(ln.e, ln.dir, ln.off); });
    function add(p){
      var q = pts[pts.length - 1];
      if(q){ var d = Math.hypot(p[0] - q[0], p[2] - q[2]); if(d < 1e-6) return; acc += d; }
      pts.push(p);
    }
    // the reference point is the body's centre; a pass starts when the front bumper reaches the
    // box, so a vehicle held at the line never waits with its nose inside
    var front = spec.len/2;
    var rev = lanes.map(function(ln, i){ var nx = lanes[(i + 1) % n]; return !!spec.sec && n > 1 && nx.e === ln.e && nx.dir !== ln.dir; });
    var cut0 = [], cut1 = [], ends = LP.slice(), mir = [];
    rev.forEach(function(r, i){
      if(!r) return;
      var j = (i + 1) % n;
      mir[i] = len2(LP[j]);
      ends[i] = crossover(LP[i], LP[j].slice().reverse(), spec.len);
      cut1[i] = front; cut0[j] = front;
    });
    LP = ends.map(function(P, i){ return cut0[i] || cut1[i] ? trimPts(P, cut0[i] || 0, cut1[i] || 0) : P; });
    for(var i = 0; i < n; i++){
      var P = LP[i], Q = LP[(i + 1) % n], s0 = pts.length ? acc : 0, last = i === n - 1, sA = null;
      P.forEach(function(p){ add(p); if(sA == null) sA = acc; });
      ranges.push([sA, acc, cut0[i] || 0, mir[i] != null ? mir[i] : null]);
      if(rev[i]){ cusps.push(acc); continue; }
      if(open && last) break;
      var d0 = dirAt(P, true), d1 = dirAt(Q, false), p0 = P[P.length - 1], ang = turnAngle(d0, d1);
      // an emergency run turning round down the middle of the road comes back to where it went in:
      // it loops round inside the box rather than spinning on the spot
      var node = laneNode(lanes[i].e, lanes[i].dir, true), loop = open && Math.abs(ang) > 2.5 && Math.hypot(Q[0][0] - p0[0], Q[0][2] - p0[2]) < 1;
      var curve = loop ? loopPts(p0, d0, Math.max(radius[node] || 0, spec.len)) : turnPts(p0, d0, Q[0], d1, 10);
      var sIn = Math.max(s0 + 0.1, acc - front);
      // the turn's last point is the next lane's first; the closing turn ends the line (s = len is s = 0)
      for(var k = 1; k < curve.length - (last ? 0 : 1); k++) add(curve[k]);
      var vb = Math.abs(ang) > 2.5 ? V_UTURN : Math.abs(ang) > 0.5 ? V_TURN : Math.min(V_STRAIGHT, spec.vmax);
      var sOut = last ? acc : acc + Math.hypot(Q[0][0] - pts[pts.length - 1][0], Q[0][2] - pts[pts.length - 1][2]);
      passes.push({node: node, sIn: sIn, sOut: sOut, v: vb, curve: curve, wid: spec.wid,
                   occ: (sOut - sIn + spec.len - front)/vb + CLEAR, key: lanes[i].e.i*2 + lanes[i].dir, turn: Math.abs(ang) > 0.5,
                   h: Math.atan2(d0[0], d0[1]), front: front});
    }
    return {pl: plOf(pts), passes: clusterOf ? boxes(passes, spec) : passes, raw: passes, cusps: cusps, lanes: lanes, ranges: ranges, rev: rev, open: !!open};
  }
  // P (the inbound track) eased over onto Q (the other track, same direction) along XOVER m that end
  // a body length (keep) before the end, so the tram stands wholly on Q at the terminus
  function crossover(P, Q, keep){
    var LPl = len2(P), LQ = len2(Q), X = clamp(LPl - keep - 4, 0, XOVER), a = LPl - keep - X, out = [], pp = plOf(P), qq = plOf(Q), o1 = {}, o2 = {};
    for(var s = 0; ; s = Math.min(LPl, s + 2)){
      plAt(pp, s, o1); plAt(qq, s*LQ/(LPl || 1), o2);
      var w = X > 0 ? smooth((s - a)/X) : 1;
      out.push([o1.x + (o2.x - o1.x)*w, o1.y + (o2.y - o1.y)*w, o1.z + (o2.z - o1.z)*w]);
      if(s >= LPl) break;
    }
    return out;
  }

  // ---- car rings: pair lanes in and out at every node ----
  var carEdges = edges.filter(function(E){ return E.cars; }), nextLane = {};
  var byNode = {};
  carEdges.forEach(function(E){
    [0, 1].forEach(function(dir){
      var to = laneNode(E, dir, true), from = laneNode(E, dir, false);
      (byNode[to] = byNode[to] || {inn: [], out: []}).inn.push({e: E, dir: dir});
      (byNode[from] = byNode[from] || {inn: [], out: []}).out.push({e: E, dir: dir});
    });
  });
  Object.keys(byNode).sort(function(a, b){ return (+a) - (+b) || (a < b ? -1 : a > b ? 1 : 0); }).forEach(function(id){
    var J = byNode[id], n = J.inn.length, cost = [];
    J.inn.forEach(function(a, i){
      var d0 = dirAt(a.dir ? a.e.pts.slice().reverse() : a.e.pts, true);
      cost.push(J.out.map(function(b, j){
        var d1 = dirAt(b.dir ? b.e.pts.slice().reverse() : b.e.pts, false);
        var u = b.e === a.e && n > 1 ? 10 : 0;
        return Math.abs(turnAngle(d0, d1)) + u + 0.4*h01(seed, a.e.i*2 + a.dir, b.e.i*2 + b.dir);
      }));
    });
    assign(cost).forEach(function(j, i){ var a = J.inn[i], b = J.out[j]; nextLane[a.e.i*2 + a.dir] = b; });
  });
  // the cheapest pairing: every permutation up to 7 lanes, greedy beyond
  function assign(cost){
    var n = cost.length, best = null, bestC = Infinity, perm = [], usedJ = [];
    if(n > 7){
      var pairs = [], out = [], ti = [], tj = [];
      for(var i = 0; i < n; i++) for(var j = 0; j < n; j++) pairs.push([cost[i][j], i, j]);
      pairs.sort(function(a, b){ return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; });
      pairs.forEach(function(p){ if(!ti[p[1]] && !tj[p[2]]){ ti[p[1]] = 1; tj[p[2]] = 1; out[p[1]] = p[2]; } });
      return out;
    }
    (function rec(i, c){
      if(c >= bestC) return;
      if(i === n){ bestC = c; best = perm.slice(); return; }
      for(var j = 0; j < n; j++) if(!usedJ[j]){ usedJ[j] = 1; perm[i] = j; rec(i + 1, c + cost[i][j]); usedJ[j] = 0; }
    })(0, 0);
    return best;
  }
  var rings = [], seen = {};
  carEdges.forEach(function(E){
    [0, 1].forEach(function(dir){
      var k = E.i*2 + dir;
      if(seen[k]) return;
      var lanes = [], cur = {e: E, dir: dir};
      while(cur && !seen[cur.e.i*2 + cur.dir]){
        seen[cur.e.i*2 + cur.dir] = 1;
        lanes.push({e: cur.e, dir: cur.dir, off: cur.e.carOff, room: cur.e.room});
        cur = nextLane[cur.e.i*2 + cur.dir];
      }
      var r = route(lanes, SPEC.car); r.id = rings.length; r.kind = "car";
      rings.push(r);
    });
  });

  // ---- transit routes and stops ----
  var lines = lineDefs.map(function(d){
    var spec = SPEC[d.kind], lanes = d.lanes.map(function(ln){ return {e: ln.e, dir: ln.dir, off: d.kind === "tram" ? ln.e.tramOff : ln.e.busOff, room: 0}; });
    var r = route(lanes, spec);
    r.id = d.id; r.kind = d.kind; r.tier = d.tier; r.stops = []; r.outBack = d.outBack;
    d.stops.forEach(function(sid){
      var st = sites[sid];
      if(!st){ errors.push("line " + d.id + ": stop " + sid + " missing"); return; }
      stopHits(r.pl, st.x, st.z).forEach(function(s){ r.stops.push({id: sid, s: s}); });
    });
    return r;
  });
  // every place along the line that passes within reach of (x, z): the nearest point of each pass
  function stopHits(pl, x, z){
    var best = 1e9, ds = [], i;
    for(i = 1; i < pl.n; i++){
      var ux = pl.x[i] - pl.x[i-1], uz = pl.z[i] - pl.z[i-1], l = ux*ux + uz*uz;
      var t = l > 1e-12 ? clamp(((x - pl.x[i-1])*ux + (z - pl.z[i-1])*uz)/l, 0, 1) : 0;
      var d = Math.hypot(x - pl.x[i-1] - ux*t, z - pl.z[i-1] - uz*t);
      ds.push([d, pl.cum[i-1] + Math.sqrt(l)*t]); if(d < best) best = d;
    }
    if(best > 60) return [];
    var hits = [];
    ds.forEach(function(p){
      if(p[0] > best + 6) return;
      var h = hits[hits.length - 1];
      if(h && p[1] - h[2] < 30){ if(p[0] < h[0]){ h[0] = p[0]; h[1] = p[1]; } h[2] = p[1]; }
      else hits.push([p[0], p[1], p[1]]);
    });
    if(hits.length > 1 && hits[0][1] + pl.len - hits[hits.length - 1][1] < 30) hits.pop();   // the same pass across the lap seam
    return hits.map(function(h){ return h[1]; });
  }
  // stops never inside a junction box (moved back to its line); lines sharing a stop take berths a
  // body, GAP and (for a bus) a lay-by ramp apart, behind and ahead of the stop in turn, kept on the
  // stop's lane with room for the lay-by
  var berths = {};
  lines.forEach(function(r){
    var spec = SPEC[r.kind], h = spec.len/2 + (r.kind === "bus" ? RAMP : 0) + 1, B = spec.len + GAP + (r.kind === "bus" ? RAMP : 0);
    r.stops.forEach(function(st){
      r.passes.forEach(function(p){ if(st.s > p.sIn - 1 && st.s < p.sOut + 1) st.s = Math.max(0, p.sIn - 1); });
      var b = berths[st.id] = berths[st.id] || [], k = b.indexOf(r.id) < 0 ? b.push(r.id) - 1 : b.indexOf(r.id);
      var rg = null;
      r.ranges.forEach(function(x){ if(!rg && x[0] - 1 <= st.s && st.s <= x[1] + 1) rg = x; });
      st.s += (k % 2 ? -1 : 1)*B*Math.ceil(k/2);
      if(rg) st.s = rg[1] - rg[0] > 2*h ? clamp(st.s, rg[0] + h, rg[1] - h) : (rg[0] + rg[1])/2;
      st.s = clamp(st.s, 0, r.pl.len);
    });
    r.stops.sort(function(a, b){ return a.s - b.s; });
  });
  // a bus stops in a lay-by: it pulls BAY m to the right over RAMP m into its berth and out again, so
  // a bus at a stop leaves the lane free (only where the whole move stays on one lane)
  lines.forEach(function(r){
    r.bays = [];
    if(r.kind !== "bus") return;
    var h = SPEC.bus.len/2 + RAMP;
    r.stops.forEach(function(st){ if(r.ranges.some(function(rg){ return rg[0] <= st.s - h && st.s + h <= rg[1]; })) r.bays.push(st.s); });
  });
  // ---- the street layout (HQ 3.15): lane offsets per edge and the tram track pieces, exactly what the
  // vehicles drive on; create(doc, {layoutOnly: true}) stops here (no rings, slots or timetables) ----
  var layoutMemo = null;
  function layout(){
    if(layoutMemo) return layoutMemo;
    var lanesOut = edges.map(function(E){
      return {id: E.id, i: E.i, a: E.a, b: E.b, cls: E.cls, len: E.len, half: E.c, tram: !!E.tram, tramOff: E.tram ? E.tramOff : null,
              bus: [!!E.bus[0], !!E.bus[1]], busOff: E.bus[0] || E.bus[1] ? E.busOff : null, cars: !!E.cars, carOff: E.cars ? E.carOff : null};
    });
    var pieces = [], byKey = {}, stopsOut = [];
    function flat(P){ var f = []; P.forEach(function(p){ f.push(p[0], p[1], p[2]); }); return f; }
    function addPiece(key, line, kind, extra, P){
      if(byKey[key]){
        if(byKey[key].lines.indexOf(line) < 0) byKey[key].lines.push(line);
        if(kind === "xover" && P.length*3 > byKey[key].pts.length) byKey[key].pts = flat(P);     // the fuller crossover
        return;
      }
      var o = {line: line, lines: [line], kind: kind, key: key, pts: flat(P)};
      for(var k in extra) o[k] = extra[k];
      byKey[key] = o; pieces.push(o);
    }
    lines.forEach(function(r){
      if(r.kind !== "tram") return;
      var n = r.lanes.length, passOf = [], k = 0;
      r.lanes.forEach(function(ln, i){ passOf[i] = r.rev[i] ? null : (r.raw || r.passes)[k++]; });
      // the inbound track back from the end of lane i over `need` m (earlier lanes and their turns)
      function backTrack(i, need){
        var P = lanePts(r.lanes[i].e, r.lanes[i].dir, r.lanes[i].e.tramOff);
        for(var j = (i - 1 + n) % n, g = 0; len2(P) < need && g < n - 1; j = (j - 1 + n) % n, g++){
          if(r.rev[j] || !passOf[j]) break;
          P = lanePts(r.lanes[j].e, r.lanes[j].dir, r.lanes[j].e.tramOff).concat(passOf[j].curve.slice(1, -1), P);
        }
        return P;
      }
      r.lanes.forEach(function(ln, i){
        var E = ln.e, P = lanePts(E, ln.dir, E.tramOff);
        addPiece("L:" + E.i + ":" + ln.dir, r.id, "lane", {edge: E.id, ei: E.i, dir: ln.dir}, P);
        if(r.rev[i]){
          var nx = r.lanes[(i + 1) % n], Q = lanePts(nx.e, nx.dir, nx.e.tramOff).slice().reverse(), keep = SPEC.tram.len, X = crossoverPart(P, Q, keep);
          // a lane too short for the crossover (the sim's tram then changes track within it): lay it back
          // along the inbound track, onto the parallel outbound one
          if(len2(X) < XOVER/2){ var PL = backTrack(i, keep + XOVER + 4); X = crossoverPart(PL, offsetPts(PL, -2*E.tramOff), Math.min(keep, len2(PL)*0.3)); }
          addPiece("X:" + E.i + ":" + ln.dir, r.id, "xover", {edge: E.id, ei: E.i, dir: ln.dir, node: laneNode(E, ln.dir, true)}, X);
          return;
        }
        var p = passOf[i], nl = r.lanes[(i + 1) % n];
        if(!p) return;
        addPiece("T:" + p.node + ":" + (E.i*2 + ln.dir) + ">" + (nl.e.i*2 + nl.dir), r.id, "turn", {node: p.node, from: E.i*2 + ln.dir, to: nl.e.i*2 + nl.dir}, p.curve);
      });
      var o = {};
      r.stops.forEach(function(st){
        ringPose(r, st.s, SPEC.tram.wb, o);
        var rg = null, li = -1;
        r.ranges.forEach(function(x, k){ if(li < 0 && x[0] - 1e-6 <= st.s && st.s <= x[1] + 1e-6){ rg = x; li = k; } });
        var ln = li >= 0 ? r.lanes[li] : null;
        stopsOut.push({line: r.id, id: st.id, s: st.s, x: o.x, y: o.y, z: o.z, yaw: o.yaw, edge: ln ? ln.e.id : null, ei: ln ? ln.e.i : null, dir: ln ? ln.dir : null});
      });
    });
    layoutMemo = {lanes: lanesOut, tramPaths: pieces, tramStops: stopsOut};
    return layoutMemo;
  }
  // the stretch of a terminus crossover where the tram leaves one track for the other (crossover()'s ease)
  function crossoverPart(P, Q, keep){
    var LPl = len2(P), LQ = len2(Q), X = clamp(LPl - keep - 4, 0, XOVER), a = LPl - keep - X, out = [], pp = plOf(P), qq = plOf(Q), o1 = {}, o2 = {};
    for(var s = a; ; s = Math.min(a + X, s + 1)){
      plAt(pp, s, o1); plAt(qq, s*LQ/(LPl || 1), o2);
      var w = X > 0 ? smooth((s - a)/X) : 1;
      out.push([o1.x + (o2.x - o1.x)*w, o1.y + (o2.y - o1.y)*w, o1.z + (o2.z - o1.z)*w]);
      if(s >= a + X) break;
    }
    return out;
  }
  if(o.layoutOnly) return {layout: layout, tier: tier};

  // how far right of its lane a route's vehicle is at s (in the lap)
  function bayLat(r, s){
    for(var i = 0; r.bays && i < r.bays.length; i++){ var d = Math.abs(s - r.bays[i]); if(d < RAMP) return BAY*smooth(1 - d/RAMP); }
    return 0;
  }

  // ---- junctions in turn ----
  // Car movements share a cycle of H s: at every node they are coloured (two whose swept paths come
  // within a vehicle width of each other differ) and each colour owns a window as wide as its slowest
  // car takes to clear the box. Transit is slow and rare, so its windows sit in the long cycle
  // HB = REPS*H instead. Every lap (cars and transit) is a multiple of HB, so the car in slot i meets a
  // node in the same repetition of H on every lap, and the slots whose crossing would meet a transit
  // window on a clashing path stay empty (a ring blocks slot residues i mod REPS).
  lines.forEach(function(r){ r.passes.forEach(function(p){ p.transit = true; }); });
  rings.forEach(function(r){ r.blocked = 0; });
  var atNode = {};
  rings.concat(lines).forEach(function(r){ r.passes.forEach(function(p){ p.route = r; (atNode[p.node] = atNode[p.node] || []).push(p); }); });
  // a long bus or tram swings its body well off its path in a turn, so a transit movement is tested
  // by the tracks of its body's corners (each section's) from nose-at-the-box to tail-out
  function tracks(p){
    if(p.tracks) return p.tracks;
    var r = p.route, spec = SPEC[r.kind], secs = sections(spec);
    var T = [], end = p.sOut + spec.len/2, o = {};
    secs.forEach(function(){ for(var c = 0; c < 5; c++) T.push([]); });
    for(var s = p.sIn; ; s = Math.min(end, s + 1)){
      secs.forEach(function(sc, k){
        partPose(r, s, sc[0], spec.wb, o);
        var fx = Math.sin(o.yaw), fz = Math.cos(o.yaw), hl = sc[1]/2, hw = spec.wid/2;
        [[0, 0], [hl, hw], [hl, -hw], [-hl, hw], [-hl, -hw]].forEach(function(cn, c){
          T[k*5 + c].push([o.x + fx*cn[0] - fz*cn[1], 0, o.z + fz*cn[0] + fx*cn[1]]);
        });
      });
      if(s >= end) break;
    }
    return (p.tracks = T);
  }
  function bodyClash(p, q){
    var lim = q.wid/2 + CLASH, T = tracks(p);
    for(var i = 0; i < T.length; i++) if(pathDist(T[i], q.curve) < lim) return true;
    return false;
  }
  function clash(p, q){
    if(p.transit || q.transit) return (p.transit && bodyClash(p, q)) || (q.transit && bodyClash(q, p));
    return pathDist(p.curve, q.curve) < (p.wid + q.wid)/2 + CLASH;
  }
  // [3.22] at a node with lights, movements coming in on different axes never share a window (each colour is one
  // axis's); sigAxis is the light's own (cityLife.sigAxis)
  function passAxis(p){ var sg = p.sn != null ? sigAt[p.sn] : null; return sg ? (CL.sigAxis ? CL.sigAxis(sg, p.h) : 0) : 0; }
  function colour(P, sig){
    var colours = [], widths = [];
    P.forEach(function(p){
      if(sig){ p.axis = passAxis(p); p.ak = p.sn != null ? p.sn + ":" + p.axis : ""; }
      for(var c = 0; ; c++){
        if((colours[c] || []).some(function(q){ return clash(p, q) || (sig && q.ak !== p.ak); })) continue;
        (colours[c] = colours[c] || []).push(p); p.colour = c; widths[c] = Math.max(widths[c] || 0, p.occ); return;
      }
    });
    return widths;
  }
  // [3.22] platoons. With lights, a car slot carries a platoon of up to r.P cars nose to tail (LP(n) m from the first
  // nose to the last tail at most, whatever they are), and its box passes are held until the last one is out:
  // the pass runs on to sClear (the first car's centre when the last car's tail leaves the box), at the box speed,
  // or, at a light, pulling away from the line to it. A ring keeps a platoon's length (and a stop's run-in) clear
  // between any two boxes, so a platoon queued at one line never stands in the box behind it.
  // (only a platoon's first car may be a lorry: the rest are at most vans)
  function LP(n){ return LMAX + (n - 1)*(SPEC.van.len + GAP); }
  function accTime(D, v, a){ var d = v*v/(2*a); return D <= d ? Math.sqrt(2*Math.max(0, D)/a) : v/a + (D - d)/v; }
  // the boxes cars wait at: nodes with lights, and those where car movements take turns (nodeSlots' carSlots, below);
  // a platoon queued at one never reaches back into the one before. (At a box only buses and trams take turns at, the
  // time a platoon takes to clear it is measured off its timetable, after: occOf.)
  var boxNode = {};
  if(sigOn) Object.keys(atNode).forEach(function(id){
    var P = atNode[id], C = P.filter(function(p){ return !p.transit; });
    if(C.some(function(p){ return p.sn != null; }) || colour(C).length > 1) boxNode[id] = 1;
  });
  // Planned in rounds (with lights): a box whose windows do not all fit in the cycle (overfull) takes a car off the
  // platoons of the rings through it, and the plan is made again, until every box fits (or no platoon can shrink).
  var pcap = {}, need = 0, nodeSlots = {}, slotIds = Object.keys(atNode).sort(), H = 0, HB = 0, overfull = 0, over = {};
  function planCars(){
    for(var round = 0; round < 8; round++){
      over = {};
      planBoxes();
      if(!sigOn || !Object.keys(over).length) break;
      var shrunk = false;
      Object.keys(over).sort().forEach(function(id){
        nodeSlots[id].car.forEach(function(p){ var r = p.route; if(r.P > 1 && (pcap[r.id] == null || pcap[r.id] >= r.P)){ pcap[r.id] = r.P - 1; shrunk = true; } });
      });
      if(!shrunk) break;
    }
  }
  function planBoxes(){
  if(sigOn) rings.forEach(function(r){
    r.sig = r.passes.some(function(p){ return p.sn != null; });
    var box = r.passes.filter(function(p){ return boxNode[p.node]; }), Lr = r.pl.len, gap = Infinity;
    for(var i = 0; i < box.length; i++){
      var a = box[i], b = box[(i + 1) % box.length], g = b.sIn - a.sOut + (i === box.length - 1 ? Lr : 0);
      gap = Math.min(gap, g);
    }
    var n = Math.min(r.sig ? PMAX : PRING, pcap[r.id] != null ? pcap[r.id] : PMAX), fr = SPEC.car.len/2;
    while(n > 1 && LP(n) - fr + 2 > gap) n--;
    r.P = n; r.gapMin = gap;
    r.passes.forEach(function(p){
      var D = p.sOut - p.sIn + LP(n) - fr;
      p.sClear = box.indexOf(p) >= 0 ? p.sOut + LP(n) - fr : null;
      p.sig = p.sn != null;
      p.occ = (p.sig ? accTime(D, p.v, SPEC.car.acc) : D/p.v) + CLEAR;
      p.enter = p.sig ? accTime(Math.max(0, LP(n) - SPEC.bike.len), p.v, SPEC.car.acc) : (LP(n) - SPEC.bike.len)/p.v;
    });
  });
  need = 0; nodeSlots = {};
  slotIds.forEach(function(id){
    var P = atNode[id].sort(function(a, b){ return a.key - b.key || (a.transit ? 1 : 0) - (b.transit ? 1 : 0) || a.sIn - b.sIn; });
    var C = P.filter(function(p){ return !p.transit; }), Tp = P.filter(function(p){ return p.transit; }), sg = sigOn && P.some(function(p){ return p.sn != null; });
    P.forEach(function(p){ p.slot = null; });
    var N = {car: C, tr: Tp, widths: colour(C, sg), twidths: colour(Tp, sg), sig: sg || null};
    N.sum = N.widths.reduce(function(a, b){ return a + b; }, 0);
    N.tsum = N.twidths.reduce(function(a, b){ return a + b; }, 0);
    N.carSlots = sg ? C.length > 0 : N.widths.length > 1;
    N.trSlots = Tp.length > 0 && (!!sg || N.twidths.length > 1 || Tp.some(function(p){ return C.some(function(q){ return clash(p, q); }); }));
    // room in every cycle for the widest transit window too, so a bus fits between the car windows
    if(N.carSlots && !sg) need = Math.max(need, N.sum + (N.trSlots ? Math.max.apply(null, N.twidths) : 0));
    if(N.carSlots || N.trSlots) nodeSlots[id] = N;
  });
  // with lights every window period divides the lights' cycle, which is the long cycle HB (laps are multiples of
  // it): a node without lights takes the shortest period that holds its windows, a node with lights the cycle
  function periodFor(w){ for(var i = 0; i < SIG_DIVS.length; i++) if(SIG_DIVS[i] >= w - 1e-9) return SIG_DIVS[i]; return SIG_C; }
  H = sigOn ? SIG_C : clamp(Math.ceil(need*2)/2, H_MIN, H_MAX); HB = sigOn ? SIG_C : REPS*H; overfull = 0;
  slotIds.forEach(function(id){
    var N = nodeSlots[id];
    if(!N) return;
    if(N.sig){ sigPlace(id, N); return; }
    if(!N.carSlots) return;
    var Hn = sigOn ? periodFor(N.sum + (N.trSlots ? Math.max.apply(null, N.twidths) : 0)) : H;
    var k = N.sum > Hn ? Hn/N.sum : 1, base = h01(seed, hash32(id), 7)*Hn, off = 0;
    if(k < 1){ overfull++; over[id] = 1; }
    N.starts = N.widths.map(function(w){ var s = mod(base + off, Hn); off += w*k; return s; });
    N.car.forEach(function(p){ p.slot = N.starts[p.colour]; p.per = Hn; p.flo = 0; });
  });
  }
  // [3.22] a box with lights (a junction, or a cluster of them): every colour is one light's axis's (or goes by no
  // light: a way into a cluster without one), and each goes in at the first time from SIG_LEAD s into its green
  // where its window is clear of those placed, early enough for its whole platoon to be in before the amber (else
  // overfull); one with no light anywhere it is clear. Then each floats as far as the next window, its deadline and
  // the room its green's buses and trams need (they go in the green too: N.trRange): a platoon that comes up on
  // green drives straight on.
  function greenOf(sg, ax){
    var s = ax ? sg.green[0] + LIGHT.amber + LIGHT.allRed : 0;
    return {start: mod(num(sg.off, 0) - lo + s, SIG_C), len: sg.green[ax]};
  }
  function sigPlace(id, N){
    N.starts = []; N.flo = []; N.trRange = []; N.twinPre = [];
    var cols = N.widths.map(function(w, c){ return {c: c, w: w, ent: 0, g: null, P: []}; }), placed = [];
    N.car.forEach(function(p){
      var o = cols[p.colour];
      o.ent = Math.max(o.ent, p.enter || 0); o.P.push(p);
      if(!o.g && p.sn != null) o.g = greenOf(sigAt[p.sn], p.axis);
    });
    // windows only keep apart from those they clash with (a bus going straight on beside the cars may share their time)
    function against(P){ return placed.filter(function(q){ return P.some(function(p){ return q.P.some(function(x){ return clash(p, x); }); }); }); }
    function clearOf(Q, t, w){ return Q.every(function(q){ return !ov(mod(t, SIG_C), w, q.s, q.w); }); }
    function first(Q, from, to, w){ for(var t = from; t <= to + 1e-9; t += 0.25) if(clearOf(Q, t, w)) return t; return null; }
    function latest(Q, from, to, w){ for(var t = to; t >= from - 1e-9; t -= 0.25) if(clearOf(Q, t, w)) return t; return null; }
    function put(o, P, from, to, late){
      var Q = against(P), at = late ? latest(Q, from, to, o.w) : first(Q, from, to, o.w);
      // (no room in its green: the first clear time after it, late; never over a window it clashes with)
      if(at == null){ overfull++; over[id] = 1; at = first(Q, to, from + SIG_C, o.w); if(at == null) at = from; }
      o.s = mod(at, SIG_C); o.P = P;
      placed.push(o);
      return o;
    }
    // the buses and trams first, each at the first clear time in its green (N.twinPre; one with no light is placed with
    // the others, later, where it blocks the fewest cars); then the cars, each colour free to float to its deadline
    N.tr.forEach(function(p){
      if(N.trRange[p.colour] !== undefined) return;
      if(p.sn == null){ N.trRange[p.colour] = null; return; }
      var g = greenOf(sigAt[p.sn], p.axis), P = N.tr.filter(function(x){ return x.colour === p.colour; });
      N.trRange[p.colour] = [g.start + SIG_LEAD, g.start + g.len - 1];
      var o = put({w: N.twidths[p.colour] || 0}, P, g.start + SIG_LEAD, g.start + g.len - 1);
      N.twinPre[p.colour] = [o.s, o.w];
    });
    cols.filter(function(o){ return o.g; }).sort(function(a, b){ return a.g.start - b.g.start || a.c - b.c; }).forEach(function(o){
      var s0 = o.g.start + SIG_LEAD;
      o.dl = o.g.len - SIG_LEAD - o.ent - 0.3;            // the latest it may go in, s after s0
      put(o, o.P, s0, s0 + o.dl);
    });
    cols.filter(function(o){ return !o.g; }).forEach(function(o){ var b = h01(seed, hash32(id), 7)*SIG_C; put(o, o.P, b, b + SIG_C - 0.25); });
    // a car colour floats on as far as its deadline and the next window it clashes with allow
    cols.forEach(function(o){
      var F = 0;
      if(o.g){
        var into = mod(o.s - o.g.start - SIG_LEAD, SIG_C), nxt = Infinity;
        against(o.P).forEach(function(q){ var d = mod(q.s - o.s, SIG_C); if(q !== o && d > 1e-6 && d < nxt) nxt = d; });
        if(into <= o.dl + 1e-6) F = Math.max(0, Math.min(o.dl - into, nxt - o.w));
      }
      N.starts[o.c] = o.s; N.flo[o.c] = F;
    });
    N.car.forEach(function(p){ p.slot = N.starts[p.colour]; p.per = SIG_C; p.flo = N.flo[p.colour] || 0; });
  }
  // a ring's slots: with lights a cycle apart on a ring through any, else the least common multiple of its windows'
  // periods (every slot meets every window); HB/Hr residues for the transit windows to block
  function ringSlots(){
    rings.forEach(function(r){
      if(!sigOn){ r.Hr = H; r.R = REPS; r.P = 1; return; }
      var q = 0;
      r.passes.forEach(function(p){ if(p.slot != null && p.per){ var k = Math.round(p.per*2); q = q ? q*k/gcdI(q, k) : k; } });
      r.Hr = r.sig ? SIG_C : q ? Math.min(SIG_C, q/2) : 10;
      r.R = Math.max(1, Math.round(HB/r.Hr));
    });
  }
  function gcdI(a, b){ while(b){ var t = a % b; a = b; b = t; } return a; }

  // ---- profiles ----
  // events along the route (turns and stops), from the first slotted turn; slack before a slotted turn
  // is waited out at the stop before it when there is one, else on the road (slower, or at the line)
  function profileOf(r, spec, stops, pad){
    var ev = [], cyc = r.kind === "car" ? H : HB;
    r.passes.forEach(function(p){
      // [3.22] with lights a car pass runs on until its platoon is out (sClear), and at a light it stops on the line
      var car = r.kind === "car" && sigOn;
      ev.push({s: p.sIn, s2: car && p.sClear != null ? p.sClear : p.sOut, v: p.v, slot: p.slot, pass: p, per: car ? p.per : null, flo: car ? p.flo || 0 : 0, sig: car && !!p.sig});
    });
    (stops || []).forEach(function(st, i){ ev.push({s: st.s, s2: st.s, v: 0, stop: st, idx: i}); });
    (r.cusps || []).forEach(function(c){ ev.push({s: c, s2: c, v: 0, stop: {id: null, s: c}}); });
    if(pad && pad.s != null) ev.push({s: pad.s, s2: pad.s, v: 0, stop: pad.stop = {id: null, s: pad.s, pad: true}});
    ev.sort(function(a, b){ return a.s - b.s || (a.stop ? -1 : 1); });
    var k0 = 0, i, Lr = r.pl.len, dbb = r.kind === "car" && sigOn;
    // (with platoons the lap starts at a slotted turn a platoon can wait at clear of the box behind it, when there is one)
    for(i = 0; i < ev.length; i++) if(ev[i].slot != null && (!dbb || clearBehind(ev, i, r, Lr))){ k0 = i; break; }
    if(i === ev.length) for(i = 0; i < ev.length; i++) if(ev[i].slot != null){ k0 = i; break; }
    if(i === ev.length) for(i = 0; i < ev.length; i++) if(ev[i].stop){ k0 = i; break; }
    var s0 = ev[k0].s, order = ev.slice(k0).concat(ev.slice(0, k0).map(function(e){ var c = {}; for(var q in e) c[q] = e[q]; c.s += Lr; c.s2 += Lr; return c; }));
    if(dbb) relays(order, r);
    var base = ev[k0].slot != null ? ev[k0].slot : h01(seed, hash32(String(r.id)), r.kind === "car" ? 3 : 5)*cyc;
    var P = new Profile(), hold = null, stopsT = [];
    // (a lap that starts at a light starts from the line: every lap ends stopped there, waiting for its green)
    P.cur.s = s0; P.cur.v = order[0].sig ? 0 : order[0].v;
    for(i = 0; i <= order.length; i++){
      var e = i < order.length ? order[i] : {s: s0 + Lr, v: order[0].v, close: true, sig: order[0].sig};
      if(i > 0){
        var Lm = Math.max(0, e.s - P.cur.s), D = fastest(Lm, P.cur.v, e.v, spec.vmax, spec.acc).T, m = e.close ? HB : e.per || cyc;
        var target = e.close ? 0 : e.slot != null ? e.slot - base : null;
        var slack = target != null ? waitFor(target, P.cur.t + D, m, e.flo) : 0;
        if(e.close && pad && !pad.stop) slack += pad.t;
        if(hold && slack > 0){ P.cur.t += slack; hold.dep += slack; slack = 0; }
        if(e.relay != null){
          // [3.22] the wait for a window a little way on, taken here: roll straight through to it, or stop on this
          // line and go when that gets there on time
          var tg = order[e.relay], mR = tg.per || cyc, tT = tg.slot - base;
          if(waitFor(tT, P.cur.t + D + rollTo(order, i, e.relay, e.v, spec), mR, tg.flo) > SIG_EPS){
            var D1 = fastest(Lm, P.cur.v, 0, spec.vmax, spec.acc).T;
            P.segment(Lm, 0, D1 + waitFor(tT - rollTo(order, i, e.relay, 0, spec), P.cur.t + D1, mR, tg.flo), spec);
          } else P.segment(Lm, e.v, D, spec);
        } else if(e.sig && (slack > SIG_EPS || e.close)){
          // [3.22] red: brake to a stop with the nose on the line, wait for the window (the green), pull away
          var D0 = fastest(Lm, P.cur.v, 0, spec.vmax, spec.acc).T;
          P.segment(Lm, 0, D0 + waitFor(target, P.cur.t + D0, m, e.flo), spec);
        } else P.segment(Lm, e.v, D + slack, spec);
      }
      hold = null;
      if(e.close) break;
      if(e.stop){
        // a stop (or a layover at a terminus, off the timetable)
        var w = (e.stop.pad ? 0 : e.stop.id == null ? LAYOVER : DWELL) + (pad && pad.stop === e.stop ? pad.t : 0), rec = {id: e.stop.id, s: e.s, arr: P.cur.t, dep: P.cur.t + w};
        if(rec.id != null) stopsT.push(rec);
        P.piece(w, 0); hold = rec;
      } else {
        e.pass.tIn = P.cur.t;
        traverse(P, e, spec);
      }
    }
    P.T = P.cur.t; P.L = Lr; P.s0 = s0; P.base = base;
    P.stops = stopsT;
    return P;
  }
  // through the junction at its speed, from where you are: an earlier pass (or a stop inside it) may already reach
  // past this one's start, and starting again from e.s would set you back (3.15: no backward jumps)
  function traverse(P, e, spec){
    var from = Math.max(P.cur.s, e.s);
    if(e.s2 > from){
      if((e.sig || e.relay != null) && P.cur.v < e.v - 1e-6){
        // [3.22] off the line: up to the box speed at the car's acceleration, then on at it
        var a = spec.acc, v0 = P.cur.v, run = (e.v*e.v - v0*v0)/(2*a), Ls = e.s2 - from;
        if(run >= Ls) P.piece((Math.sqrt(v0*v0 + 2*a*Ls) - v0)/a, a);
        else { P.piece((e.v - v0)/a, a); P.cur.v = e.v; P.piece((Ls - run)/e.v, 0); }
      } else { P.cur.v = e.v; P.piece((e.s2 - from)/e.v, 0); }
    }
    P.cur.s = Math.max(P.cur.s, e.s2);
  }
  // [3.22] Don't block the box. A platoon waiting on event i's line stands back LP(P) m from its nose: where that
  // reaches into the box behind (one a bus or tram takes its turn through), it waits at that box's line instead
  // (order[j].relay = i: the first box back it can wait at clear of the one behind, with no window of its own on the
  // way) and rolls on through to i's window. clearBehind: can a platoon wait at ev[i] clear of the box before it?
  function boxExit(e){ return e.s + (e.pass.sOut - e.pass.sIn); }
  function prevBox(order, i, wrapL){
    for(var k = i - 1; k >= -order.length; k--){
      var q = order[(k + order.length) % order.length];
      if(q.pass && nodeSlots[q.pass.node]) return {e: q, exit: boxExit(q) - (k < 0 ? wrapL : 0), k: k};
    }
    return null;
  }
  function clearBehind(order, i, r, wrapL){
    var e = order[i], b = prevBox(order, i, wrapL);
    return !b || b.e === e || e.s + SPEC.car.len/2 - LP(r.P) >= b.exit + 1;
  }
  function relays(order, r){
    for(var i = 1; i < order.length; i++){
      var e = order[i];
      if(e.stop || e.slot == null || clearBehind(order, i, r, r.pl.len)) continue;
      for(var j = i - 1; j >= 1; j--){
        var q = order[j];
        if(q.stop || q.slot != null) break;
        if(!q.pass || !nodeSlots[q.pass.node]) continue;
        if(clearBehind(order, j, r, r.pl.len)){ if(q.relay == null) q.relay = i; break; }
      }
    }
  }
  // the time from order[j]'s line (at speed v0) to order[i]'s, straight through as the lap would go
  function rollTo(order, j, i, v0, spec){
    var Q = new Profile();
    Q.cur.s = order[j].s; Q.cur.v = v0;
    for(var k = j; k < i; k++){
      traverse(Q, order[k], spec);
      var nx = order[k + 1], Lm = Math.max(0, nx.s - Q.cur.s);
      Q.segment(Lm, nx.v, fastest(Lm, Q.cur.v, nx.v, spec.vmax, spec.acc).T, spec);
    }
    return Q.cur.t;
  }
  // the wait from arriving at arr (lap s) for a window at target, period m; a window that floats flo s takes you
  // as you come within it
  function waitFor(target, arr, m, flo){
    if(flo > 0 && mod(arr - target, m) <= flo + 1e-9) return 0;
    var w = mod(target - arr, m);
    return w > m - 1e-6 ? 0 : w;
  }
  // [3.22] Queues. A platoon a slot behind another may come up on it while it waits (at a light, for most of a cycle):
  // at() holds it back nose to tail behind the one ahead (softly: smin, QSOFT m), never ahead of its own timetable. A
  // ring may space its platoons so (queueOk) only when the held-back platoons never stand in a box: every platoon
  // k slots apart (k*Hr s), as at() places them, each lap's sample QSTEP s apart.
  function smin(a, b){ var m = Math.min(a, b), d = Math.abs(a - b); return m - QSOFT*Math.log(1 + Math.exp(-d/QSOFT)); }
  function queueOk(r, k, Pn){
    var P = r.prof, Lr = r.pl.len, fr = SPEC.car.len/2, ext = LP(Pn), n = Math.floor(Math.round(P.T/r.Hr)/k), o = {}, x = [], y = [];
    if(n < 2) return true;
    var B = r.passes.filter(function(p){ return nodeSlots[p.node]; }).map(function(p){ return [p.sIn + fr, p.sOut]; });
    function inBox(c){
      var a = c + fr - ext, b = c + fr;
      for(var i = 0; i < B.length; i++) for(var w = -1; w <= 1; w++){ var lo = B[i][0] + w*Lr, hi = B[i][1] + w*Lr; if(b > lo && a < hi) return true; }
      return false;
    }
    for(var t = 0; t < P.T; t += QSTEP){
      for(var j = 0; j < n; j++){ x[j] = P.S(t - j*k*r.Hr, o).s; y[j] = x[j]; }
      for(var pass = 0; pass < 2; pass++) for(j = 0; j < n; j++){
        var ahead = j ? y[j - 1] : y[n - 1] + Lr*Math.round((x[0] - y[n - 1])/Lr + 0.5);
        y[j] = smin(x[j], ahead - ext - GAP);
      }
      for(j = 0; j < n; j++) if(y[j] < x[j] - 0.05 && inBox(y[j])) return false;
    }
    return true;
  }
  // min over the lap of S(t) - S(t - shift): the closest two vehicles shift seconds apart come
  function minGap(P, shift){
    var best = Infinity, a = {}, b = {};
    for(var t = 0; t < P.T; t += 0.2){ var d = P.S(t, a).s - P.S(t - shift, b).s; if(d < best) best = d; }
    return best;
  }
  // [3.22] with platoons: how long each car pass really holds its box (the first car's nose in to the last car's tail
  // out, off the timetable), which the buses, trams and emergency runs keep clear of
  function measureOcc(){ if(sigOn) rings.forEach(function(r){
    var o = {}, fr = SPEC.car.len/2, T = r.prof.T;
    r.passes.forEach(function(p){
      if(p.tIn == null) return;
      var end = r.prof.S(p.tIn, o).s + (p.sOut - p.sIn) + LP(r.P) - fr, t = 0;
      while(t < T && r.prof.S(p.tIn + t, o).s < end) t += 0.1;
      p.occ = Math.max(p.occ, t + CLEAR);
    });
  }); }

  // ---- transit windows: per node, each colour placed where it blocks the fewest ring residues ----
  // Colours go widest first, each on a half-second grid of the long cycle, never over a window
  // already placed at the node; a window in a gap between the clashing car windows costs nothing.
  function ov(a, la, b, lb){ return mod(b - a, HB) < la || mod(a - b, HB) < lb; }
  // the residues of ring h[0] (slots Hr apart, R of them in HB) whose car would meet window [s0, s0 + w]
  function resHits(h, s0, w, add){
    var R = rings[h[0]].R, Hr = rings[h[0]].Hr;
    for(var rho = 0; rho < R; rho++) if(ov(mod(h[1] + rho*Hr, HB), h[2], s0, w)) add[h[0]] = (add[h[0]] || 0) | (1 << rho);
  }
  function placeTransit(){
  rings.forEach(function(r){ r.blocked = 0; });
  slotIds.forEach(function(id){
    var N = nodeSlots[id];
    if(!N || !N.trSlots) return;
    var scale = N.tsum > HB ? HB/N.tsum : 1, rot = h01(seed, hash32(id), 9)*H, win = [], placed = [];
    if(scale < 1) overfull++;
    // per colour, the car passes its vehicles clash with: [ring id, arrival in HB, occupancy]
    var hits = N.twidths.map(function(){ return []; });
    N.tr.forEach(function(tp){
      N.car.forEach(function(p){ if(clash(p, tp)) hits[tp.colour].push([p.route.id, mod(p.route.prof.base + p.tIn, HB), p.occ]); });
    });
    var order = N.twidths.map(function(w, c){ return c; }).sort(function(a, b){ return N.twidths[b] - N.twidths[a] || a - b; });
    order.forEach(function(c){
      // [3.22] at a light, only where it goes in on its own axis's green
      var w = N.twidths[c]*scale, best = null, bestC = Infinity, bestAdd = null, rg = N.trRange && N.trRange[c], pre = N.twinPre && N.twinPre[c];
      if(pre){
        bestAdd = {};
        hits[c].forEach(function(h){ resHits(h, pre[0], w, bestAdd); });
        Object.keys(bestAdd).forEach(function(rid){ rings[rid].blocked |= bestAdd[rid]; });
        win[c] = [pre[0], w]; placed.push(win[c]);
        return;
      }
      for(var j = 0, J = Math.ceil(HB*2); j < J; j++){
        var s0 = mod(rot + j/2, HB), cost = 0, add = {};
        if(rg && mod(s0 - rg[0], HB) > rg[1] - rg[0]) continue;
        if(scale >= 1 && placed.some(function(q){ return ov(s0, w, q[0], q[1]); })) continue;
        hits[c].forEach(function(h){ resHits(h, s0, w, add); });
        Object.keys(add).forEach(function(rid){
          var was = rings[rid].blocked, now = was | add[rid];
          if(now !== was) cost += now === (1 << rings[rid].R) - 1 ? 100 : 1;
        });
        if(cost < bestC){ bestC = cost; best = s0; bestAdd = add; }
      }
      if(best == null){
        // no room left in the cycle (overfull): straight after the last window
        var q = placed[placed.length - 1];
        best = rg ? mod(rg[0], HB) : q ? mod(q[0] + q[1], HB) : rot; bestAdd = {};
        hits[c].forEach(function(h){ resHits(h, best, w, bestAdd); });
      }
      Object.keys(bestAdd).forEach(function(rid){ rings[rid].blocked |= bestAdd[rid]; });
      win[c] = [best, w]; placed.push(win[c]);
    });
    N.tr.forEach(function(tp){ tp.slot = win[tp.colour][0]; });
    N.twin = win;
  });
  }
  // The plan; with lights, again with a car off the platoons of a ring the buses and trams would otherwise shut out
  // altogether (a platoon queued back over the box they turn through, every cycle), until none is
  for(var attempt = 0; attempt < 6; attempt++){
    planCars(); ringSlots();
    rings.forEach(function(r){ r.prof = profileOf(r, SPEC.car); });
    measureOcc(); placeTransit();
    if(!sigOn) break;
    var cut = false;
    rings.forEach(function(r){ if(r.blocked === (1 << r.R) - 1 && r.P > 1){ pcap[r.id] = r.P - 1; cut = true; } });
    if(!cut) break;
  }

  // ---- cars in their slots, transit vehicles a headway apart ----
  // [3.22] with lights a slot holds a platoon: place j of slot i holds a car when its own hash is under the density
  // times FILL[j] (place 0 is the slot's car of old); the cars of a platoon close up nose to tail behind the first
  // one out (at()), so a lap's missing cars leave no holes
  var cars = [], totalSlots = 0;
  rings.forEach(function(r){
    var Hr = r.Hr, Pn = r.P || 1, m = Math.round(r.prof.T/Hr), G = sigOn ? LP(Pn) + GAP : SPEC.car.len + GAP, k = 1, cand = [], last = -Infinity;
    while(k < m && minGap(r.prof, k*Hr) < G && !(sigOn && queueOk(r, k, Pn))) k++;
    r.k = k; r.m = m; r.cars = []; r.leads = [];
    if(r.pl.len < 2*G) return;
    for(var i = 0; i < m; i++){
      if((r.blocked >> (i % r.R)) & 1 || i - last < k || (cand.length && m + cand[0] - i < k)) continue;
      cand.push(i); last = i;
    }
    cand.forEach(function(i){
      totalSlots++;
      var lead = null;
      for(var j = 0; j < Pn; j++){
        var fill = sigOn ? FILL[Math.min(j, FILL.length - 1)] : 1, hv = h01(seed, r.id*977 + 11 + 7*j, i);
        if(hv >= dens*fill) continue;
        var c = {id: "c" + r.id + "." + i + (j ? "." + j : ""), ring: r, kind: "car", shift: i*Hr, paint: Math.floor(h01(seed, r.id, i*31 + 5 + 7919*j)*PAINT.length),
                 slot: i, fol: j, fill: fill, hv: hv, ut: h01(seed, r.id*613 + 29 + 7*j, i)};
        r.cars.push(c); cars.push(c);
        if(!lead){ lead = c; r.leads.push(c); }
      }
    });
  });

  // ---- [3.21] city life (games/citylife.js): how many of the slots' cars are out, what they are, closed streets ----
  // A car exists when its slot hash hv < dens (above, unchanged); it is out on a lap when hv < dens*demand(local hour
  // at the lap's start, the ring's street kind): demand only thins today's density (1 at the rush hours), it never
  // changes a ring, a slot or a timetable (City Gen v4 owns capacity). A ring through a street that is closed at any
  // time in the lap (HQV.cityLife.closed: a closed segment's capacity is 0) is off the road for that lap: its cars
  // finish the lap they are on and wait out of sight at its start, the box line of its first slotted turn, so no car
  // is ever on a closed edge and none vanishes at a barrier (re-pairing the rings round it would move every car's
  // window and every bus's timetable). The type is pick(mix(the district group where the car is at the ring's base
  // time, the ring's kind, the hour), ut): fixed per lap, so a car changes only out of sight at the lap start.
  // Everything is per lap, memoised on the car, and a pure function of (doc, tier, seed, o.local, the clock).
  var life = !!(CL && CL.demand && CL.mix && CL.pick);
  var closedFn = typeof o.closed === "function" ? o.closed : life && LW && CL.closed ? function(ms){ return CL.closed(LW, ms); } : null;
  var closedMemo = {}, closedKeys = [];
  // (by the minute, floored: the events start and end on whole minutes, so a time is in one exactly when its minute is)
  function closedAt(ms){
    var key = Math.floor(ms/6e4);
    if(closedMemo.hasOwnProperty(key)) return closedMemo[key];
    var m = null;
    try { m = closedFn ? closedFn(key*6e4) : null; } catch(e){ m = null; }
    closedMemo[key] = m || {}; closedKeys.push(key);
    if(closedKeys.length > 64) delete closedMemo[closedKeys.shift()];
    return closedMemo[key];
  }
  if(life){
    // the district a car is in: the lots' beside the road (right of travel, then left; the road's own district is
    // "street"), 6 m past the carriageway
    var FA = LW && CL.facts ? CL.facts(LW) : null, SKIP = {street: 1, water: 1};
    var groupAt = typeof o.groupAt === "function" ? o.groupAt : function(x, z, yaw, half){
      if(!FA || !WQ || !WQ.districtAt) return "home";
      var d = null, off = half + 6;
      for(var sg = 1; sg >= -1; sg -= 2){
        var q = WQ.districtAt(LW, x - Math.cos(yaw)*off*sg, z + Math.sin(yaw)*off*sg);
        if(q && q.k != null && !SKIP[q.name]){ d = q; break; }
      }
      d = d || WQ.districtAt(LW, x, z);
      return d && d.k != null ? FA.group(d.k) : "home";
    };
    rings.forEach(function(r){
      // its street kind: the commonest by length; its edges (for closures); whether it turns round anywhere
      var byKind = {}, best = null;
      r.edgeIds = {};
      r.lanes.forEach(function(ln){ var k = CL.road(ln.e.cls).kind; byKind[k] = (byKind[k] || 0) + ln.e.len; r.edgeIds[ln.e.id] = 1; });
      Object.keys(byKind).sort().forEach(function(k){ if(best == null || byKind[k] > byKind[best]) best = k; });
      r.kindL = best || "main";
      r.uturn = r.passes.some(function(p){ return p.v === V_UTURN && p.slot != null; });   // in a box it shares
      // each car's room: the closest its neighbours (a slot ahead and behind, of every car the slots hold) come
      var gaps = {}, n = r.cars.length, q = {};
      function gapTo(d){ d = mod(d, r.m) || r.m; if(gaps[d] == null) gaps[d] = d >= r.m ? r.pl.len : minGap(r.prof, d*H); return gaps[d]; }
      var prev = null;
      r.cars.forEach(function(c, j){
        // [3.22] a platoon's cars close up by their own lengths (at()) and its slots keep the longest platoon apart
        if(sigOn){ c.room = Infinity; if(prev && prev.slot === c.slot){ c.grp = prev.grp; return; } prev = c; }
        else {
          var ahead = r.cars[(j + n - 1) % n], behind = r.cars[(j + 1) % n];
          c.room = n < 2 ? r.pl.len : Math.min(gapTo(c.slot - ahead.slot), gapTo(behind.slot - c.slot));
        }
        r.prof.S(-c.shift, q);
        var sm = mod(q.s, r.pl.len), p = ringPose(r, sm, SPEC.car.wb, {}), li = 0;
        while(li < r.ranges.length - 1 && r.ranges[li][1] < sm) li++;
        c.grp = String(groupAt(p.x, p.z, p.yaw, r.lanes[li].e.c) || "home");
      });
    });
  }
  function fitsType(c, type){
    var r = c.ring, L0 = SPEC[type].len;
    if(type === "lorry" && (r.uturn || (r.kindL !== "main" && r.kindL !== "fast"))) return false;
    // nose-aligned, so it reaches back (L0 - car.len)/2 further: room for it and the longest neighbour, both shifted
    return !LONG[type] || c.room >= (L0 + LMAX)/2 + GAP + (LMAX - SPEC.car.len)/2;
  }
  function closedOver(r, t0, t1){
    if(!closedFn) return false;
    for(var t = t0; ; t = Math.min(t1, t + CLOSE_STEP/1000)){
      var m = closedAt(localOf(t*1000));
      for(var id in m) if(r.edgeIds[id]) return true;
      if(t >= t1) return false;
    }
  }
  // a car's lap state at t (s): {k: its lap, show, type}; without citylife.js every car is out, a car
  function carState(c, t){
    var r = c.ring, k = Math.floor((t - r.prof.base - c.shift)/r.prof.T);
    if(c.st && c.st.k === k) return c.st;
    if(!life) return (c.st = {k: k, show: true, type: "car", hour: null});
    var t0 = r.prof.base + c.shift + k*r.prof.T, h = CL.hourOf ? CL.hourOf(localOf(t0*1000)) : mod(localOf(t0*1000)/36e5, 24);
    var show = c.hv < dens*(c.fill || 1)*clamp(num(CL.demand(h, r.kindL), 1), 0, 1) && !closedOver(r, t0, t0 + r.prof.T);
    var type = CL.pick(CL.mix(c.grp || "home", r.kindL, h), c.ut);
    if(!SPEC[type] || TYPES.indexOf(type) < 0) type = "car";
    if(type === "lorry" && (!fitsType(c, "lorry") || (sigOn && c.fol > 0))) type = "van";
    if(type === "van" && !fitsType(c, "van")) type = "car";
    return (c.st = {k: k, show: show, type: type, hour: h});
  }
  // Lines that share a lane (the same kind on the same edge and direction: buses through the hub) are
  // kept apart by taking it in turn, a BLOCK m stretch at a time: no two of their vehicles are ever
  // on one block together, and since one can only reach or pass another by sharing a block with it,
  // they never meet. Every lap is a multiple of HB, so line A's vehicle meets line B's on a block only
  // if their times there differ by a multiple of g = gcd(lap A, lap B); laps in a sharing group are
  // padded (whole cycles held on a lane of their own) to multiples of one base lap so g stays long,
  // and each line is placed, a whole number of HB later, where its times on every shared block miss
  // the lines already placed (fewer vehicles when nothing fits). The times are measured from the
  // profiles, so stops, dwells and waits at the line are all in them.
  // the lanes lane i holds: [{k: "kind:edge:dir", mir: the other track's length for a crossover}]
  function laneKeys(r, i){
    // an emergency run holds the tram track or bus lane it drives in (none down the middle)
    var ln = r.lanes[i], kind = r.ev ? ln.e.evKind : r.kind, k = kind + ":" + ln.e.i + ":";
    if(!kind) return [];
    var out = [{k: k + ln.dir, mir: null}];
    if(r.rev && r.rev[i]) out.push({k: k + (1 - ln.dir), mir: r.ranges[i][3]});   // a crossover holds both tracks
    return out;
  }
  function keyBase(key){ return key.slice(0, key.indexOf("/")); }
  // per lane block ("kind:edge:dir/block", and "/block~" for the lay-by strip beside it), the
  // stretches of profile time [u0, u1] the body (and GAP/2 each way) is on it: one lap (wrapped) for a
  // closed route, u0..u1 for an open one
  function occupancy(r, prof, spec, u0, u1){
    var out = {}, run = {}, Lr = r.pl.len, h = spec.len/2 + GAP/2, o = {}, keys = r.ranges.map(function(rg, i){ return laneKeys(r, i); });
    var DT = 0.1, n = Math.ceil((u1 - u0)/DT), on = {};
    for(var k = 0; k <= n; k++){
      var u = Math.min(u1, u0 + k*DT), sNow = (r.open ? prof.at(u, o) : prof.S(u, o)).s, sm = r.open ? sNow : mod(sNow, Lr), now = {};
      r.ranges.forEach(function(rg, i){
        for(var w = r.open ? 0 : -1; w <= (r.open ? 0 : 1); w++){
          var x = sm - w*Lr;
          if(rg[0] > x + h || rg[1] < x - h) continue;
          var lo = Math.max(rg[0], x - h) - rg[0] + rg[2], hi = Math.min(rg[1], x + h) - rg[0] + rg[2], lat = bayLat(r, sm);
          keys[i].forEach(function(K){
            // on the other track of a crossover the place is mirrored (to within a block)
            var a = K.mir != null ? K.mir - hi : lo, b = K.mir != null ? K.mir - lo : hi, m = K.mir != null ? 1 : 0;
            // in the lane unless wholly in a lay-by; in the strip of lay-bys beside it (finer blocks) once
            // far enough over to reach a bus parked there
            if(lat < BAY - 0.05) for(var bk = Math.floor(a/BLOCK) - m; bk <= Math.floor(b/BLOCK) + m; bk++) now[K.k + "/" + bk] = 1;
            if(lat > BAY - SPEC.bus.wid - 0.15) for(bk = Math.floor(a/BAY_BLOCK); bk <= Math.floor(b/BAY_BLOCK); bk++) now[K.k + "/" + bk + "~"] = 1;
          });
        }
      });
      Object.keys(now).forEach(function(key){ if(run[key] == null) run[key] = u; on[key] = u; });
      Object.keys(run).forEach(function(key){
        if(!now[key] || k === n){ (out[key] = out[key] || []).push([run[key] - DT - 0.1, on[key] + DT + 0.1]); delete run[key]; }
      });
    }
    if(!r.open) Object.keys(out).forEach(function(key){
      // a stretch over the lap seam is one stretch
      var L = out[key];
      if(L.length > 1 && L[0][0] < u0 - 0.15 && L[L.length - 1][1] > u1 + 0.15){ L[L.length - 1][1] = u1 + L[0][1] - u0; L.shift(); }
    });
    return out;
  }
  function gcd(a, b){ while(b){ var t = a % b; a = b; b = t; } return a; }
  // do two periodic stretches (start a, length da, period Ta; b, db, Tb) ever overlap?
  function meets(a, da, Ta, b, db, Tb){
    var g = gcd(Math.round(Ta/HB), Math.round(Tb/HB))*HB;
    return mod(b - a, g) < da || mod(a - b, g) < db;
  }
  var keyLines = {};
  lines.forEach(function(r, li){
    r.keys = {};
    r.ranges.forEach(function(rg, i){ laneKeys(r, i).forEach(function(K){ if(!r.keys[K.k]){ r.keys[K.k] = 1; (keyLines[K.k] = keyLines[K.k] || []).push(li); } }); });
  });
  var grp = lines.map(function(r, i){ return i; });
  function find(i){ while(grp[i] !== i) i = grp[i] = grp[grp[i]]; return i; }
  Object.keys(keyLines).sort().forEach(function(key){ keyLines[key].forEach(function(li){ var a = find(li), b = find(keyLines[key][0]); if(a !== b) grp[Math.max(a, b)] = Math.min(a, b); }); });
  function shared(r, key){ return (keyLines[key] || []).some(function(li){ return lines[li] !== r; }); }
  lines.forEach(function(r){ r.prof = profileOf(r, SPEC[r.kind], r.stops); r.m = Math.round(r.prof.T/HB); });
  var groups = {};
  lines.forEach(function(r, i){ (groups[find(i)] = groups[find(i)] || []).push(r); });
  Object.keys(groups).forEach(function(gi){
    var G = groups[gi];
    if(G.length < 2) return;
    // every lap padded up to a multiple of one base lap b (so any two laps' gcd is at least b): the b
    // whose worst padding (as a share of the lap) is least, then the least in all
    var mMin = Math.min.apply(null, G.map(function(r){ return r.m; })), best = null, bestC = Infinity;
    function lapOf(b, m){ return Math.ceil(m/b)*b; }
    for(var b = mMin; b <= 2*mMin; b++){
      var worst = 0, sum = 0;
      G.forEach(function(r){ var c = (lapOf(b, r.m) - r.m)/r.m; worst = Math.max(worst, c); sum += c; });
      if(worst*100 + sum < bestC - 1e-9){ bestC = worst*100 + sum; best = b; }
    }
    G.forEach(function(r){
      var pad = lapOf(best, r.m) - r.m;
      if(!pad) return;
      // held at the first stop on a lane of its own, else at the line at the end of such a lane, else
      // at the first stop (else on the road)
      function alone(i){ return !laneKeys(r, i).some(function(K){ return shared(r, K.k); }); }
      var st = null, at = null, len = SPEC[r.kind].len;
      r.stops.forEach(function(x){
        var i = 0;
        while(i < r.ranges.length - 1 && r.ranges[i][1] < x.s) i++;
        if(!st && alone(i)) st = x;
      });
      r.ranges.forEach(function(rg, i){ if(at == null && !st && alone(i) && !(r.rev && r.rev[i]) && rg[1] - rg[0] > len + 4) at = rg[1] - len/2 - 1; });
      r.prof = profileOf(r, SPEC[r.kind], r.stops, {stop: st || (at == null ? r.stops[0] : null) || null, s: at, t: pad*HB});
      r.m = Math.round(r.prof.T/HB);
    });
  });
  // Vehicles are placed in rounds, a vehicle per line each round (the first where it fits, the rest as
  // near an even headway as they fit), so lines sharing a busy stop split it rather than the last
  // line getting none.
  var dropped = 0;
  lines.forEach(function(r){
    var spec = SPEC[r.kind], m = r.m;
    r.occ = occupancy(r, r.prof, spec, 0, r.prof.T);
    r.mine = Object.keys(r.occ).filter(function(key){ return shared(r, keyBase(key)); }).sort();
    // two of its own d cycles apart keep a car length and GAP between them, either way round the lap
    r.okd = [];
    for(var d = 1; d < m; d++) r.okd[d] = minGap(r.prof, d*HB) >= spec.len + GAP;
    r.want = clamp(Math.round(r.prof.T/HEADWAY[r.kind]), 1, m); r.q = Math.max(1, Math.floor(m/r.want));
    r.got = []; r.full = false;
  });
  // a vehicle o cycles after r's base: its times on the shared blocks miss every other line's vehicles
  function fits(r, o){
    return lines.every(function(y){
      return y === r || !y.got.length || r.mine.every(function(key){
        if(!y.occ[key]) return true;
        return r.occ[key].every(function(A){
          var t0 = r.prof.base + o*HB + A[0];
          return y.got.every(function(yo){
            return y.occ[key].every(function(B){ return !meets(t0, A[1] - A[0], r.prof.T, y.prof.base + yo*HB + B[0], B[1] - B[0], y.prof.T); });
          });
        });
      });
    });
  }
  function ownOk(r, o){ return r.got.every(function(x){ var d = mod(o - x, r.m); return d > 0 && r.okd[d] && r.okd[r.m - d]; }); }
  for(var round = 0; lines.some(function(r){ return !r.full; }); round++){
    lines.forEach(function(r){
      if(r.full) return;
      var o = null;
      if(!round){ for(var c = 0; c < r.m && o == null; c++) if(fits(r, c)) o = c; }
      else for(var k = 0; k <= r.q && o == null; k++){
        var c2 = mod(r.got[0] + round*r.q + (k % 2 ? (k + 1)/2 : -k/2), r.m);
        if(ownOk(r, c2) && fits(r, c2)) o = c2;
      }
      if(o == null){ r.full = true; return; }
      r.got.push(o);
      if(r.got.length >= r.want) r.full = true;
    });
  }
  lines.forEach(function(r){
    r.vehicles = [];
    if(!r.got.length){ dropped++; r.headway = null; return; }
    r.got.slice().sort(function(a, b){ return a - b; }).forEach(function(o, i){
      r.vehicles.push({id: (r.kind === "tram" ? "t" : "b") + r.id + "." + i, ring: r, kind: r.kind, shift: o*HB, idx: i});
    });
    r.headway = r.prof.T/r.got.length;
  });
  var lineById = {};
  lines.forEach(function(r){ lineById[r.id] = r; });
  [rings, lines].forEach(function(list){ list.forEach(function(r){ r.box = bbox(r.pl); }); });
  function bbox(pl){
    var b = [Infinity, Infinity, -Infinity, -Infinity];
    for(var i = 0; i < pl.n; i++){ b[0] = Math.min(b[0], pl.x[i]); b[1] = Math.min(b[1], pl.z[i]); b[2] = Math.max(b[2], pl.x[i]); b[3] = Math.max(b[3], pl.z[i]); }
    return b;
  }

  // ---- emergency runs ----
  var stations = {fire: [], ambulance: [], police: []};
  Object.keys(sites).sort().forEach(function(id){
    var s = sites[id];
    EV_KINDS.forEach(function(k){ if(EV_SITES[k][s.kind]) stations[k].push(s); });
  });
  function nearestNode(x, z){
    var best = null, bd = Infinity;
    nodeIds.forEach(function(id){ var N = nodes[id]; if(!N.inc.length) return; var d = Math.hypot(N.x - x, N.z - z); if(d < bd){ bd = d; best = id; } });
    return best;
  }
  function dijkstra(src){
    var dist = {}, prev = {}, heap = [[0, src]], done = {};
    dist[src] = 0;
    while(heap.length){
      var top = heap[0], last = heap.pop();
      if(heap.length){ heap[0] = last; siftDown(heap, 0); }
      var u = top[1];
      if(done[u]) continue;
      done[u] = 1;
      nodes[u].inc.forEach(function(i){
        var E = edges[i], v = E.a === u ? E.b : E.a, d = top[0] + E.len;
        if(!E.ev) return;
        if(dist[v] == null || d < dist[v] - 1e-9 || (Math.abs(d - dist[v]) <= 1e-9 && prev[v] && E.i < prev[v].e.i)){
          dist[v] = d; prev[v] = {u: u, e: E}; heap.push([d, v]); siftUp(heap, heap.length - 1);
        }
      });
    }
    return {dist: dist, prev: prev};
  }
  function less(a, b){ return a[0] < b[0] || (a[0] === b[0] && String(a[1]) < String(b[1])); }
  function siftUp(h, i){ while(i > 0){ var p = (i - 1) >> 1; if(!less(h[i], h[p])) break; var t = h[i]; h[i] = h[p]; h[p] = t; i = p; } }
  function siftDown(h, i){
    for(;;){ var l = 2*i + 1, r = l + 1, m = i;
      if(l < h.length && less(h[l], h[m])) m = l;
      if(r < h.length && less(h[r], h[m])) m = r;
      if(m === i) return; var t = h[i]; h[i] = h[m]; h[m] = t; i = m; }
  }
  // A run is planned once, as a pure function of its window: the out route (lanes from the station's
  // node to the scene, joined through the boxes), 40 s parked short of the scene's box, and the way
  // back (a U-turn through that box, then the lanes home). It takes every box when no vehicle whose
  // movement clashes is in it (their times there are known: every car and bus keeps its timetable),
  // holding at the line until then, and it starts when its time on the tram tracks and bus lanes it
  // uses misses every tram and bus (a few seconds later, or no run). One run at a time: a run whose
  // window starts while an earlier window's run is still out is called off.
  var incCache = {}, incKeys = [];
  function rawIncident(w){
    var key = "r" + w;
    if(incCache.hasOwnProperty(key)) return incCache[key];
    var inc = null, u = h01(seed, w, 1);
    if(u < INC_P){
      var kind = EV_KINDS[Math.floor(h01(seed, w, 2)*3)], list = stations[kind];
      if(list.length){
        var st = list[Math.floor(h01(seed, w, 3)*list.length)], src = nearestNode(st.x, st.z);
        if(src != null){
          // the scene is a node with no traffic or a junction whose box holds the turn round
          var D = dijkstra(src), cand = Object.keys(D.dist).filter(function(id){
            return D.dist[id] >= EV_NEAR && D.dist[id] <= EV_FAR && (!used[id] || (radius[id] || 0) >= SPEC[kind].len - 0.5);
          });
          cand.sort(function(a, b){ return D.dist[a] - D.dist[b] || (a < b ? -1 : 1); });
          if(cand.length){
            var tgt = cand[Math.floor(h01(seed, w, 4)*cand.length)], chain = [], v = tgt;
            while(v != src){ var pv = D.prev[v]; chain.unshift({e: pv.e, dir: pv.e.a == pv.u ? 0 : 1}); v = pv.u; }
            inc = planRun(w, kind, st, tgt, chain);
          }
        }
      }
    }
    cache(key, inc);
    return inc;
  }
  function cache(key, v){ incCache[key] = v; incKeys.push(key); if(incKeys.length > 48) delete incCache[incKeys.shift()]; }
  function incident(w){
    var key = "i" + w;
    if(incCache.hasOwnProperty(key)) return incCache[key];
    var I = rawIncident(w);
    for(var k = 1; I && k <= INC_LOOK; k++){ var J = rawIncident(w - k); if(J && J.end > I.start) I = null; }
    cache(key, I);
    return I;
  }
  function evLanes(chain){ return chain.map(function(c){ return {e: c.e, dir: c.dir, off: c.e.evOff}; }); }
  function planRun(w, kind, st, tgt, chain){
    var spec = SPEC[kind], out = route(evLanes(chain), spec, true);
    var back = route(evLanes([chain[chain.length - 1]].concat(chain.slice().reverse().map(function(c){ return {e: c.e, dir: 1 - c.dir}; }))), spec, true);
    [out, back].forEach(function(R){
      R.kind = kind; R.id = "e" + w; R.ev = true;
      R.passes.forEach(function(p){
        p.route = R; p.transit = true;
        p.against = (atNode[p.node] || []).filter(function(q){ return clash(p, q); });
      });
    });
    var sPark = out.pl.len - spec.len/2 - 1, sHome = back.ranges[0][1] - spec.len/2 - 1, t0 = w*INC_W + h01(seed, w, 5)*INC_W*0.5;
    for(var j = 0; j < EV_TRY; j++, t0 += 2){
      var P1 = runProfile(out, spec, t0, spec.len/2 + 0.5, sPark);
      if(!P1) continue;
      var tb = t0 + P1.T + EV_DWELL, P2 = runProfile(back, spec, tb, sHome, back.pl.len - spec.len/2 - 1);
      if(!P2) continue;
      if(transitMeets(occupancy(out, P1, spec, 0, P1.T + EV_DWELL), t0) || transitMeets(occupancy(back, P2, spec, 0, P2.T), tb)) continue;
      return {id: "e" + w, kind: kind, station: st.id, node: tgt, out: out, back: back, P1: P1, P2: P2, start: t0, tb: tb, end: tb + P2.T};
    }
    return null;
  }
  // a run's profile from sFrom to sTo starting at clock t0, holding at the line of a box until it is clear
  function runProfile(R, spec, t0, sFrom, sTo){
    var P = new Profile();
    P.cur.s = sFrom;
    for(var i = 0; i < R.passes.length; i++){
      var p = R.passes[i];
      if(p.sIn < sFrom) continue;
      var Lm = p.sIn - P.cur.s, D = fastest(Lm, P.cur.v, p.v, spec.vmax, spec.acc).T, tA = t0 + P.cur.t + D, tF = boxFree(p, tA);
      if(tF == null) return null;
      P.segment(Lm, p.v, D + tF - tA, spec);
      P.cur.v = p.v; P.piece((p.sOut - p.sIn)/p.v, 0); P.cur.s = p.sOut;
    }
    var f = fastest(Math.max(0, sTo - P.cur.s), P.cur.v, 0, spec.vmax, spec.acc);
    P.segment(Math.max(0, sTo - P.cur.s), 0, f.T, spec);
    if(!P.t.length){ P.cur.v = 0; P.piece(0.1, 0); }
    P.T = P.cur.t; P.L = R.pl.len;
    return P;
  }
  // the first time from t a run's pass p can enter its box: no clashing movement's vehicle in it then
  function boxFree(p, t){
    var M = 0.3, t1 = t + EV_HOLD;
    for(var moved = true; moved && t <= t1; ){
      moved = false;
      p.against.forEach(function(q){
        var r = q.route, vs = r.kind === "car" ? r.leads || r.cars : r.vehicles, T = r.prof.T;   // (a platoon's box time is its slot's)
        vs.forEach(function(veh){
          var a = r.prof.base + veh.shift + q.tIn, k = Math.ceil((t - M - q.occ - a)/T), s0 = a + k*T;
          if(s0 < t + p.occ + M && s0 + q.occ + M > t + 1e-6){ t = s0 + q.occ + M; moved = true; }
        });
      });
    }
    return t <= t1 ? t : null;
  }
  // does a run's time on a tram track or bus lane (occupancy from clock t0) meet a tram or a bus there?
  function transitMeets(occ, t0){
    return Object.keys(occ).some(function(key){
      return (keyLines[keyBase(key)] || []).some(function(li){
        var r = lines[li], R = r.occ[key];
        return R && occ[key].some(function(x){
          var a = t0 + x[0], b = t0 + x[1];
          return r.vehicles.some(function(veh){
            return R.some(function(y){
              var s0 = r.prof.base + veh.shift + y[0], d = y[1] - y[0], k = Math.ceil((a - d - s0)/r.prof.T);
              return s0 + k*r.prof.T < b;
            });
          });
        });
      });
    });
  }
  function activeIncidents(t){
    var w0 = Math.floor(t/INC_W), out = [];
    for(var w = w0 - INC_LOOK; w <= w0; w++){ var I = incident(w); if(I && t >= I.start && t < I.end) out.push(I); }
    return out;
  }
  function evPose(I, t, o){
    var R = I.out, P = I.P1, u = t - I.start;
    if(t >= I.tb){ R = I.back; P = I.P2; u = t - I.tb; }
    P.at(clamp(u, 0, P.T), o);
    var s = o.s, v = o.v;
    ringPose(R, s, SPEC[I.kind].wb, o);
    o.speed = v; o.s = s;
    o.wail = R === I.out && u < P.T;      // [sound] its siren sounds on the way to the scene (lights only on scene and back)
    return o;
  }
  // [sound] the emergency runs within radius of center, nearest first, as at() lists them: a siren carries farther than
  // the traffic is drawn
  function sirens(timeMs, center, radius){
    var t = num(timeMs, 0)/1000, cx = center ? num(center.x, 0) : 0, cz = center ? num(center.z, 0) : 0, rad = num(radius, Infinity), out = [];
    activeIncidents(t).forEach(function(I){
      var e = evPose(I, t, {id: I.id, kind: I.kind}), d = Math.hypot(e.x - cx, e.z - cz);
      if(d <= rad) out.push({id: e.id, kind: e.kind, x: e.x, y: e.y, z: e.z, yaw: e.yaw, speed: e.speed, d: d, siren: true, wail: e.wail});
    });
    return out.sort(function(a, b){ return a.d - b.d || (a.id < b.id ? -1 : 1); });
  }

  // ---- poses ----
  function pose(pl, s, wb, back, o){
    plAt(pl, s, o);
    var a = plAt(pl, s - wb/2, tmpA), b = plAt(pl, s + wb/2, tmpB), dx = b.x - a.x, dz = b.z - a.z;
    o.yaw = Math.atan2(back ? -dx : dx, back ? -dz : dz);
    return o;
  }
  // the point d m along the body from a vehicle at s on route r (s wrapped onto the lap). Past a
  // cusp (a tram changing ends) the body folds back: it carries on straight the way it came in.
  function bodyAt(r, s, d, o, noBay){
    var Lr = r.pl.len, cs = r.cusps, x = s + d;
    for(var i = 0; cs && i < cs.length; i++){
      var c = cs[i] + Lr*Math.round((s - cs[i])/Lr);
      if((d > 0 && c >= s && c < x) || (d < 0 && c < s && c > x)){
        var q = plAt(r.pl, mod(c, Lr) || Lr, o), qx = q.x, qy = q.y, qz = q.z, b = plAt(r.pl, Math.max(0, (mod(c, Lr) || Lr) - 1), tmpB);
        var tx = qx - b.x, tz = qz - b.z, tl = Math.hypot(tx, tz) || 1, k = Math.abs(x - c)/tl;
        o.x = qx + tx*k; o.y = qy; o.z = qz + tz*k;
        return o;
      }
    }
    plAt(r.pl, r.open ? x : mod(x, Lr), o);
    var lat = r.bays && r.bays.length && !noBay ? bayLat(r, mod(x, Lr)) : 0;
    if(lat > 0){
      var pl = r.pl, i = o.i, j = Math.min(i + 1, pl.n - 1), dx = pl.x[j] - pl.x[i], dz = pl.z[j] - pl.z[i], l = Math.hypot(dx, dz) || 1;
      o.x += -dz/l*lat; o.z += dx/l*lat;
    }
    return o;
  }
  // the pose of the body part centred d m from the reference (yaw over its wheelbase). Into and out
  // of a lay-by a bus mostly slides sideways, turning only BAY_YAW of the way: a rigid 12 m body
  // turned along the S of its path would swing its far end back across the lane line.
  function partPose(r, s, d, wb, o){
    var a = bodyAt(r, s, d - wb/2, tmpA, true), ax = a.x, az = a.z, b = bodyAt(r, s, d + wb/2, tmpC, true);
    bodyAt(r, s, d, o);
    o.yaw = Math.atan2(b.x - ax, b.z - az);
    if(r.bays && r.bays.length){
      var Lr = r.pl.len;
      o.yaw -= BAY_YAW*Math.atan((bayLat(r, mod(s + d + wb/2, Lr)) - bayLat(r, mod(s + d - wb/2, Lr)))/wb);
    }
    return o;
  }
  function ringPose(r, s, wb, o){ return partPose(r, s, 0, wb, o); }
  // a vehicle's body sections: [centre offset, length]; a tram is two, coupled
  function sections(spec){ return spec.sec ? [[spec.sec/2 + 0.5, spec.sec], [-spec.sec/2 - 0.5, spec.sec]] : [[0, spec.len]]; }

  // ---- local overrides (obstacles) ----
  var lag = {}, lastT = null;
  function obstacleNeed(r, sDisp, v, wid, len, obs){
    if(!obs || !obs.length) return null;
    var Lr = r.pl.len, p = {}, look = Math.max(LOOK*0.5, v*v/8 + LOOK*0.5);
    for(var d = len/2; d <= look; d += 1.5){
      plAt(r.pl, mod(sDisp + d, Lr), p);
      for(var j = 0; j < obs.length; j++){
        var O = obs[j], rr = num(O.r, OBS_R) + wid/2;
        if(Math.hypot(p.x - num(O.x, 1e9), p.z - num(O.z, 1e9)) < rr) return d - len/2;
      }
    }
    return null;
  }

  /* ---------- at() ---------- */
  function at(timeMs, center, radius, obstacles){
    var t = num(timeMs, 0)/1000, cx = center ? num(center.x, 0) : 0, cz = center ? num(center.z, 0) : 0;
    var rad = num(radius, Infinity), out = [], obs = obstacles && obstacles.length ? obstacles : null, dt = 0;
    if(lastT != null){ dt = t - lastT; if(dt < -1 || dt > 5){ lag = {}; dt = 0; } dt = clamp(dt, 0, 0.5); }
    lastT = t;
    var evs = activeIncidents(t).map(function(I){ return evPose(I, t, {id: I.id, kind: I.kind}); });
    function near(b){ return cx >= b[0] - rad - 30 && cx <= b[2] + rad + 30 && cz >= b[1] - rad - 30 && cz <= b[3] + rad + 30; }
    function run(r, list, spec){
      var anyLag = false, st = [], heads = sigOn && r.kind === "car" ? platoons(r, list) : null;
      if(!near(r.box) && !hasLag(list)) return;
      list.forEach(function(veh){
        // [3.21] a car out on this lap (city life), as its type: a long one sits back (nose where a car's is)
        var cs = veh.kind === "car" ? carState(veh, t) : null, vs = cs ? SPEC[cs.type] : spec, back = cs ? (vs.len - spec.len)/2 : 0;
        if(cs && !cs.show){ delete lag[veh.id]; return; }
        var at = heads ? heads.at[veh.id] : null, q = at ? at.q : r.prof.S(t - r.prof.base - veh.shift, {}), sBase = q.s, l0 = lag[veh.id] || 0, l = l0;
        // [3.22] a platoon: its first car on its slot's timetable (held back behind the platoon ahead), each next one
        // nose to tail behind the one before
        if(at){ sBase = at.c + (at.head ? back : 0); if(!at.head) back = 0; }
        if(obs || l > 0){
          var gapAhead = obs ? obstacleNeed(r, sBase - back - l, q.v, vs.wid, vs.len, obs) : null;
          // brake smoothly to a stop 1.2 m short of it; once clear, ease back onto the timetable
          if(gapAhead != null) l += (q.v - q.v*smooth((gapAhead - 1.2)/BRAKE))*dt;
          else if(l > 0) l = Math.max(0, l - Math.min(CATCH_MAX*dt, l*ease(CATCH, dt)));
          if(l > 0) anyLag = true;
        }
        st.push({veh: veh, s: sBase - l, sBase: sBase, v: q.v, l: l, l0: l0, cs: cs, vs: vs, back: back});
      });
      // nobody drives into the vehicle they follow: slot order is road order (unwrapped s), the
      // first vehicle follows the last one a lap ahead (bodies centre to centre: s - back)
      if(anyLag && st.length > 1){
        var Lr = r.pl.len;
        for(var pass = 0; pass < 2; pass++) for(var i = 0; i < st.length; i++){
          var me = st[i], ld = i ? st[i-1] : st[st.length - 1], lead = ld.s - ld.back + (i ? 0 : Lr), gap = lead - (me.s - me.back), G = (me.vs.len + ld.vs.len)/2 + GAP;
          if(gap < G){ me.s -= G - gap; me.l += G - gap; }
        }
      }
      st.forEach(function(x){
        var id = x.veh.id;
        if(x.l > 1e-4) lag[id] = x.l; else delete lag[id];
        var p = ringPose(r, x.s - x.back, x.vs.wb, {});
        var d = Math.hypot(p.x - cx, p.z - cz);
        if(d > rad) return;
        var v = {id: id, kind: x.veh.kind, x: p.x, y: p.y, z: p.z, yaw: p.yaw, speed: dt > 0 ? Math.max(0, x.v - (x.l - x.l0)/dt) : x.v, d: d};
        if(x.veh.kind === "car"){
          var ty = x.cs.type, pi = x.veh.paint;
          v.type = ty;
          v.paint = ty === "taxi" ? TAXI : ty === "van" ? VAN_PAINT[pi % VAN_PAINT.length] : ty === "lorry" ? LORRY_PAINT[pi % LORRY_PAINT.length] : ty === "bike" ? BIKE_PAINT[pi % BIKE_PAINT.length] : PAINT[pi];
          // a scooter or bike rides the kerb side of the lane (its right edge where a car's is), back in line in a box
          var room = roomAt(r, x.s), pull = 0, kerb = TWO[ty] ? (SPEC.car.wid - x.vs.wid)/2*taperAt(r, x.s) : 0;
          if(room > 0) evs.forEach(function(e){ if(e.speed > 0.5) pull = Math.max(pull, room*smooth((EV_YIELD - Math.hypot(e.x - p.x, e.z - p.z))/15)); });
          var lat = Math.max(pull, kerb);
          if(lat > 0){ v.x += -Math.cos(p.yaw)*lat; v.z += Math.sin(p.yaw)*lat; }
          if(pull > 0) v.pull = pull;
        } else {
          v.line = r.id;
          if(x.veh.kind === "tram") v.parts = sections(spec).map(function(sc){ var tp = partPose(r, x.s, sc[0], spec.wb, {}); return {x: tp.x, y: tp.y, z: tp.z, yaw: tp.yaw}; });
        }
        out.push(v);
      });
    }
    // how far a car may pull over at s: its lane's room, easing to nothing over PULL_TAPER m toward
    // either end of the lane, so a car is back in line before it turns through a box
    function roomAt(r, s){ var i = laneAt(r, s); return i < 0 ? 0 : (r.lanes[i].room || 0)*taperAt(r, s); }
    // the lane (index) a route is on at s, -1 in a box; and 0..1 easing to nothing over PULL_TAPER m to either end
    function laneAt(r, s){
      var Lr = r.pl.len, sm = mod(s, Lr), R = r.ranges, lo = 0, hi = R.length - 1;
      while(lo < hi){ var mid = (lo + hi + 1) >> 1; if(R[mid][0] <= sm) lo = mid; else hi = mid - 1; }
      return sm < R[lo][0] || sm > R[lo][1] ? -1 : lo;
    }
    function taperAt(r, s){
      var i = laneAt(r, s), sm = mod(s, r.pl.len);
      return i < 0 ? 0 : smooth(Math.min(sm - r.ranges[i][0], r.ranges[i][1] - sm)/PULL_TAPER);
    }
    function hasLag(list){ for(var i = 0; i < list.length; i++) if(lag[list[i].id]) return true; return false; }
    // [3.22] a ring's platoons at t: each car out's body centre (c) and its slot's timetable (q), by id. Platoons in
    // road order (slot order; the first follows the last a lap ahead), each held back nose to tail behind the one
    // ahead (queueOk: never in a box)
    function platoons(r, list){
      var G = [], cur = null, out = {};
      list.forEach(function(veh){
        var cs = carState(veh, t);
        if(!cs.show) return;
        var vs = SPEC[cs.type];
        if(!cur || cur.slot !== veh.slot){
          var q = r.prof.S(t - r.prof.base - veh.shift, {});
          cur = {slot: veh.slot, q: q, own: q.s - (vs.len - SPEC.car.len)/2, cars: [], off: 0, tail: 0};
          G.push(cur);
        } else cur.off += (cur.cars[cur.cars.length - 1].len + vs.len)/2 + GAP;
        cur.cars.push({veh: veh, len: vs.len, off: cur.off});
      });
      if(!G.length) return {at: out};
      var Lr = r.pl.len;
      G.forEach(function(g){ var c = g.cars[g.cars.length - 1]; g.tail = c.off + c.len/2; g.hl = g.cars[0].len/2; g.c = g.own; });
      for(var pass = 0; pass < 2 && G.length > 1; pass++) G.forEach(function(g, j){
        var a = j ? G[j - 1] : G[G.length - 1], ac = a.c + (j ? 0 : Lr*Math.round((G[0].own - a.c)/Lr + 0.5));
        g.c = smin(g.own, ac - a.tail - GAP - g.hl);
      });
      G.forEach(function(g){ g.cars.forEach(function(c, j){ out[c.veh.id] = {q: g.q, c: g.c - c.off, head: !j}; }); });
      return {at: out};
    }
    rings.forEach(function(r){ if(r.cars.length) run(r, r.cars, SPEC.car); });
    lines.forEach(function(r){ run(r, r.vehicles, SPEC[r.kind]); });
    evs.forEach(function(e){
      var d = Math.hypot(e.x - cx, e.z - cz);
      if(d <= rad) out.push({id: e.id, kind: e.kind, x: e.x, y: e.y, z: e.z, yaw: e.yaw, speed: e.speed, d: d, siren: true, wail: e.wail});
    });
    out.sort(function(a, b){ return a.d - b.d || (a.id < b.id ? -1 : 1); });
    return out;
  }

  /* ---------- [3.22] the light ahead ---------- */
  // lightAt(x, z, heading, ms) -> {state, sig, dist} for the nearest light ahead of someone at (x, z) going along
  // heading (radians, atan2(dx, dz)): an arm coming in that way (within ~45 degrees) whose stop line is at most LOOK_SIG
  // m in front, or behind but still inside its junction (dist < 0 once past the line), and whose incoming half of the
  // road they are on or beside; state is the light's for that heading at ms (the clock at() takes), else null.
  var LOOK_SIG = 40, sigList = Object.keys(SIGS).map(function(k){ return SIGS[k]; }).filter(function(sg){ return sg && sg.arms && sg.green; });
  function lightAt(x, z, heading, ms){
    x = num(x, NaN); z = num(z, NaN); heading = num(heading, NaN);
    if(!isFinite(x) || !isFinite(z) || !isFinite(heading) || !CL || !CL.signalAt) return null;
    var best = null, bd = Infinity;
    sigList.forEach(function(sg){
      if(Math.abs(sg.x - x) > LOOK_SIG + 40 || Math.abs(sg.z - z) > LOOK_SIG + 40) return;
      sg.arms.forEach(function(a){
        if(Math.cos(a.heading - heading) < 0.7) return;
        var ax = Math.sin(a.heading), az = Math.cos(a.heading), dx = a.stopX - x, dz = a.stopZ - z;
        var along = dx*ax + dz*az, lat = Math.abs(dx*az - dz*ax);
        if(along > LOOK_SIG || along < -2*num(a.stop, sg.r) || lat > num(a.half, 3)/2 + 2.5) return;
        if(along < bd){ bd = along; best = {sig: sg, dist: along}; }
      });
    });
    if(!best) return null;
    var t = ms != null ? num(ms, 0) : lastT != null ? lastT*1000 : 0;
    best.state = CL.signalAt(best.sig, localOf(t), heading);
    return best;
  }

  /* ---------- riding ---------- */
  function lineStops(){
    var map = {};
    lines.forEach(function(r){
      r.prof.stops.forEach(function(st){ var m = map[st.id] = map[st.id] || {lines: []}; if(m.lines.indexOf(r.id) < 0) m.lines.push(r.id); });
    });
    return map;
  }
  var stopIndex = lineStops();
  function stopsNear(x, z, r){
    r = num(r, 60);
    var out = [];
    Object.keys(stopIndex).forEach(function(id){
      var s = sites[id], d = Math.hypot(s.x - num(x, 0), s.z - num(z, 0));
      if(d <= r) out.push({id: id, kind: s.kind, x: s.x, y: s.y, z: s.z, dist: d, lines: stopIndex[id].lines.slice()});
    });
    out.sort(function(a, b){ return a.dist - b.dist || (a.id < b.id ? -1 : 1); });
    return out;
  }
  // the next vehicle of `line` (or any line) at stopId that has not left yet at timeMs
  function arrivals(stopId, t, lineId){
    var best = null;
    lines.forEach(function(r){
      if(lineId != null && r.id !== String(lineId)) return;
      r.prof.stops.forEach(function(st, si){
        if(st.id !== String(stopId)) return;
        r.vehicles.forEach(function(veh){
          var off = r.prof.base + veh.shift, k = Math.ceil((t - (off + st.dep))/r.prof.T - 1e-9), arr = off + st.arr + k*r.prof.T;
          if(!best || arr < best.arr) best = {line: r, veh: veh, si: si, arr: arr, dep: off + st.dep + k*r.prof.T};
        });
      });
    });
    return best;
  }
  function nextArrival(stopId, timeMs, lineId){
    var b = arrivals(stopId, num(timeMs, 0)/1000, lineId);
    return b ? {line: b.line.id, kind: b.line.kind, vehicle: b.veh.id, stop: String(stopId), arrive: Math.round(b.arr*1000), depart: Math.round(b.dep*1000)} : null;
  }
  function rideTo(lineId, fromStop, toStop, timeMs){
    var t = num(timeMs, lastT != null ? lastT*1000 : 0)/1000, b = arrivals(fromStop, t, lineId);
    if(!b || String(fromStop) === String(toStop)) return null;
    var r = b.line, S = r.prof.stops, from = S[b.si], to = null, dt = Infinity, via = [];
    S.forEach(function(st){ if(st.id !== String(toStop)) return; var d = mod(st.arr - from.dep, r.prof.T); if(d < dt){ dt = d; to = st; } });
    if(!to) return null;
    S.forEach(function(st){ var d = mod(st.arr - from.dep, r.prof.T); if(d > 0 && d < dt) via.push([d, st.id]); });
    via.sort(function(a, c){ return a[0] - c[0]; });
    var shift = r.prof.base + b.veh.shift, depart = b.dep, reach = b.dep + dt, paid = false;
    var trip = {line: r.id, kind: r.kind, vehicle: b.veh.id, from: String(fromStop), to: String(toStop),
                arrive: Math.round(b.arr*1000), depart: Math.round(depart*1000), reach: Math.round(reach*1000),
                stops: via.map(function(v){ return v[1]; }), fare: {kind: r.kind, coins: FARE},
                pose: function(ms){
                  var tt = clamp(num(ms, 0)/1000, b.arr, reach), q = r.prof.S(tt - shift, {}), p = ringPose(r, q.s, SPEC[r.kind].wb, {});
                  return {x: p.x, y: p.y, z: p.z, yaw: p.yaw, speed: q.v, done: num(ms, 0) >= trip.reach};
                },
                pay: function(){
                  if(paid) return false;
                  paid = true;
                  if(fareHook) fareHook({kind: r.kind, coins: FARE, line: r.id, from: String(fromStop), to: String(toStop)});
                  return true;
                }};
    return trip;
  }

  return {
    tier: tier, grow: grow, H: H, at: at, lightAt: lightAt, signals: function(){ return sigList.slice(); }, sirens: sirens, stopsNear: stopsNear, nextArrival: nextArrival, rideTo: rideTo,
    onFare: function(fn){ fareHook = typeof fn === "function" ? fn : null; },
    incidents: function(timeMs){ return activeIncidents(num(timeMs, 0)/1000).map(function(I){ return {id: I.id, kind: I.kind, station: I.station, node: I.node, start: Math.round(I.start*1000), end: Math.round(I.end*1000)}; }); },
    lines: function(){ return lines.map(function(r){ return {id: r.id, kind: r.kind, tier: r.tier, lap: r.prof.T, headway: r.headway, vehicles: r.vehicles.length,
                                                              stops: r.prof.stops.map(function(st){ return {id: st.id, arr: st.arr, dep: st.dep}; })}; }); },
    info: function(){ return {H: H, rings: rings.length, cars: cars.length, slots: totalSlots, lines: lines.length, overfull: overfull, errors: errors.slice(), dropped: dropped,
                              slotted: Object.keys(nodeSlots).length, life: life, lights: Object.keys(sigAt).length,
                              platoons: sigOn ? rings.reduce(function(a, r){ return a + (r.leads ? r.leads.length : 0); }, 0) : null}; },
    // [3.21] every car's lap state at timeMs (out or not, its type, the local hour its lap started), and what is closed
    cars: function(timeMs){ var t = num(timeMs, 0)/1000; return cars.map(function(c){ var q = carState(c, t); return {id: c.id, ring: c.ring.id, show: q.show, type: q.type, hour: q.hour, group: c.grp || null}; }); },
    closed: function(timeMs){ return closedFn ? closedAt(localOf(num(timeMs, 0))) : {}; },
    layout: layout, doc: doc, seed: seed,
    _: {rings: rings, lines: lines, nodeSlots: nodeSlots, atNode: atNode, edges: edges, ringPose: ringPose, lag: function(){ return lag; }, sigAt: sigAt,
        sites: sites, stopIndex: stopIndex, partPose: partPose, sections: sections, mod: mod,
        incidentsAt: function(t){ return activeIncidents(num(t, 0)); }}
  };
}

/* ---------- the street layout and the ride Service (HQ 3.15, plan 5.3) ---------- */
// Seats in vehicle-local metres (+x LEFT, +z forward, y above the floor, yaw 0 faces forward), shared by the
// pure trip (Trip.seat) and the 3D models (games/hqcoach.js). Bus: 12 m low floor, 2+2, a wheelchair bay
// opposite the middle door, a rear row of 5 (31). Tram: two 13 m sections centred +-7 m, 2+1 in facing
// bays (48); the rear section is the front one turned round (seat i + 24 is seat i rotated 180 degrees), so
// a tram changing ends at a terminus maps every seat onto a seat. STANDS: standing spots by the poles.
var FLOOR = {bus: 0.36, tram: 0.36}, SEAT_Y = 0.45;
var DOORS = {bus: [5.0, 0.3, -2.75], tram: [10.6, 3.6, -3.6, -10.6]};   // door centres (z), double doors 1.2 / 1.3 m
var SEATS = {bus: [], tram: []}, STANDS = {bus: [], tram: []};
(function(){
  function seat(list, x, z, yaw, win, pri){ list.push({x: x, y: SEAT_Y, z: z, yaw: yaw, window: !!win, priority: !!pri}); }
  [4.3, 3.5, 2.7, 1.9, -1.4, -2.2, -3.0, -3.8, -4.6].forEach(function(z){ seat(SEATS.bus, 0.82, z, 0, true, z > 2.6); seat(SEATS.bus, 0.36, z, 0, false, z > 2.6); });
  [3.5, 2.7, -1.25, -4.25].forEach(function(z){ seat(SEATS.bus, -0.82, z, 0, true, z > 2.6); seat(SEATS.bus, -0.36, z, 0, false, z > 2.6); });
  [0.92, 0.46, 0, -0.46, -0.92].forEach(function(x){ seat(SEATS.bus, x, -5.4, 0, Math.abs(x) > 0.9, false); });
  [[-0.05, 3.9], [-0.05, 3.1], [-0.05, 2.3], [-0.05, 1.5], [0.7, 0.9], [0.7, 0.1], [0.7, -0.7], [-0.05, -1.0], [-0.05, -1.8], [-0.05, -3.4], [-0.05, -4.2]].forEach(function(p){
    STANDS.bus.push({x: p[0], y: 0, z: p[1], yaw: 0, window: false, priority: false});
  });
  var front = [], bays = [0.95, 4.35, 6.18, 8.01];
  bays.forEach(function(a, k){
    [[a + 0.3, 0], [a + 1.45, Math.PI]].forEach(function(row){
      var pri = (k === 0 && row[1]) || (k === 1 && !row[1]);
      seat(front, 0.78, row[0], row[1], true, pri); seat(front, 0.32, row[0], row[1], false, pri); seat(front, -0.8, row[0], row[1], true, pri);
    });
  });
  function turn(p){ return {x: p.x ? -p.x : 0, y: p.y, z: p.z ? -p.z : 0, yaw: p.yaw ? (p.yaw + Math.PI) % (2*Math.PI) : Math.PI, window: p.window, priority: p.priority}; }
  SEATS.tram = front.concat(front.map(turn));
  var st = [[-0.24, 1.8], [0, 3.6], [-0.24, 5.5], [-0.24, 7.4], [-0.24, 9.2], [0, 10.6], [0.5, 10.6]].map(function(p){ return {x: p[0], y: 0, z: p[1], yaw: 0, window: false, priority: false}; });
  STANDS.tram = st.concat(st.map(turn)).concat([{x: 0, y: 0, z: 0, yaw: 0, window: false, priority: false}]);
})();

// lanes / tram paths for a world and tier: from the sim when given (the same object), else a layout-only build
var layoutCache = [];
function layoutOf(W, tier, sim){
  if(sim && typeof sim.layout === "function") return sim.layout();
  tier = clamp(num(tier, 1) | 0, 1, 5);
  for(var i = 0; i < layoutCache.length; i++) if(layoutCache[i].W === W && layoutCache[i].tier === tier) return layoutCache[i].L;
  var L = create(W, {tier: tier, layoutOnly: true}).layout();
  layoutCache.push({W: W, tier: tier, L: L});
  if(layoutCache.length > 4) layoutCache.shift();
  return L;
}
// per active edge {id, a, b, tram, tramOff, bus: [dir0, dir1], busOff, cars, carOff, half}: m right of the centre line
function lanes(W, tier, sim){ return layoutOf(W, tier, sim).lanes; }
// the track centre lines the trams drive: [{line, lines, kind: "lane"|"turn"|"xover", key, pts: [x, y, z, ...]}]
function tramPaths(W, tier, sim){ return layoutOf(W, tier, sim).tramPaths; }
// where trams stand at their stops: [{line, id, s, x, y, z, yaw, edge, dir}]
function tramStops(W, tier, sim){ return layoutOf(W, tier, sim).tramStops; }

var LINE_COL = [0xd23b3b, 0x2c7be5, 0x2fa36b, 0xe0a020, 0x8a55c8, 0x1aa3b8];
function lineColor(id){ return LINE_COL[hash32(id) % LINE_COL.length]; }
function hex6(n){ var s = (n >>> 0).toString(16); while(s.length < 6) s = "0" + s; return "#" + s; }
function shortOf(id, kind){
  id = String(id);
  if(/^[A-Z]{1,2}\d{1,3}$/.test(id)) return id;
  var m = /(\d+)$/.exec(id);
  return (kind === "tram" ? "T" : "B") + (m ? (+m[1]) + 1 : 1);
}
// the share of seats taken by local hour when hqCommute is not loaded (its curve: peaks 08-09:30 and 17-19)
function loadCurve(h){
  h = mod(num(h, 12), 24);
  function bump(c, w){ var d = Math.abs(h - c); return d < w ? 0.5 + 0.5*Math.cos(Math.PI*d/w) : 0; }
  return clamp(0.08 + 0.37*smooth((h - 5.5)/2) - 0.37*smooth((h - 21)/2.5) + 0.7*bump(8.75, 1.6) + 0.7*bump(18, 1.8), 0.08, 1.15);
}

// The Service contract (plan 5.3) for the sim's buses or trams. opts.W: the world handed to station naming
// (HQV.hqRide.stationName, else the nearest road's name); default the sim's doc.
function service(sim, kind, opts){
  opts = opts || {};
  kind = kind === "tram" ? "tram" : "bus";
  var I = sim && sim._, spec = SPEC[kind], W = opts.W || (sim && sim.doc), names = {}, o1 = {};
  var LS = I ? I.lines.filter(function(r){ return r.kind === kind; }) : [];
  var byId = {};
  LS.forEach(function(r){ byId[r.id] = r; });
  function nameOf(id){
    if(names[id] != null) return names[id];
    var s = I.sites[id], nm = null;
    try { if(s && HQV.hqRide && HQV.hqRide.stationName) nm = HQV.hqRide.stationName(W, s.x, s.z, kind); } catch(e){ nm = null; }
    if(!nm && s && HQV.world && HQV.world.nearestRoad && W && W.edges && W.edges[0] && W.edges[0].pts){
      try { var rd = HQV.world.nearestRoad(W, s.x, s.z, 40); if(rd && rd.name) nm = rd.name; } catch(e){ nm = null; }
    }
    if(!nm){ var m = /(\d+)$/.exec(id); nm = (kind === "tram" ? "Tram stop " : "Bus stop ") + (m ? (+m[1]) + 1 : id); }
    nm = String(nm);
    // made unique within the service (hqRide.stationName is unique per world already)
    if(taken[nm]){ for(var k = 0; taken[nm + (k < SUFFIX.length ? " " + SUFFIX[k] : " " + (k + 2))]; k++); nm += k < SUFFIX.length ? " " + SUFFIX[k] : " " + (k + 2); }
    taken[nm] = 1;
    return (names[id] = nm);
  }
  // every stop named once, in id order, so names do not depend on which is asked first
  var taken = {}, SUFFIX = ["Square", "Gate", "Park", "Corner", "Cross", "Market"];
  // where a line turns back (lap positions): a tram's cusps; an out-and-back bus at the end of each half
  function turnsOf(r){
    if(r.turns) return r.turns;
    var t = r.cusps && r.cusps.length ? r.cusps.slice() : r.outBack ? [r.ranges[r.lanes.length/2 - 1][1], r.pl.len] : [];
    return (r.turns = t);
  }
  // the stop a vehicle at lap position s is heading for: the last stop before the next turn back
  function destOf(r, s){
    var T = turnsOf(r), L = r.pl.len, S = r.prof.stops;
    if(!T.length || !S.length) return {id: null, name: (S.length ? nameOf(S[0].id) + " circular" : "Circular")};
    var best = null, bd = Infinity;
    T.forEach(function(c){ var d = mod(c - s - 1e-6, L); if(d < bd){ bd = d; best = c; } });
    var st = null, sd = Infinity;
    S.forEach(function(x){ var d = mod(best - x.s, L); if(d < sd){ sd = d; st = x; } });
    return {id: st.id, name: nameOf(st.id)};
  }
  function lineStops(r){ var out = []; r.prof.stops.forEach(function(st){ if(out.indexOf(st.id) < 0) out.push(st.id); }); return out; }
  (function(){
    var ids = [];
    LS.forEach(function(r){ lineStops(r).forEach(function(id){ if(ids.indexOf(id) < 0) ids.push(id); }); });
    ids.sort(function(a, b){ var x = /(\d+)$/.exec(a), y = /(\d+)$/.exec(b); return (x && y ? (+x[1]) - (+y[1]) : 0) || (a < b ? -1 : a > b ? 1 : 0); }).forEach(nameOf);
  })();
  function lineInfo(r){
    var T = turnsOf(r), ends = T.map(function(c){ return destOf(r, c - 1).name; });
    return {id: r.id, mode: kind, short: shortOf(r.id, kind), color: hex6(lineColor(r.id)),
            name: (kind === "tram" ? "Tram " : "Bus ") + shortOf(r.id, kind) + (ends.length >= 2 ? " " + ends[1] + " - " + ends[0] : " circular"),
            stops: lineStops(r), headway: r.headway, loop: !T.length};
  }
  function offOf(r, veh){ return r.prof.base + veh.shift; }
  // doors 0..1 at a stop: open 0.6 s after it stops, over 1.2 s; shut 1.5 s before it leaves
  function doorsAt(r, veh, t){
    var u = mod(t - offOf(r, veh), r.prof.T), S = r.prof.stops;
    for(var i = 0; i < S.length; i++){
      var a = S[i].arr, d = S[i].dep, x = u;
      if(x < a && x + r.prof.T <= d) x += r.prof.T;
      if(x >= a && x <= d) return clamp(Math.min(x - a - 0.6, d - 1.5 - x)/1.2, 0, 1);
    }
    return 0;
  }
  function poseOf(r, veh, t, o){
    var q = r.prof.S(t - offOf(r, veh), {});
    I.ringPose(r, q.s, spec.wb, o);
    o.s = q.s; o.speed = q.v;
    return o;
  }
  function blockDelay(r, t){
    if(kind !== "tram") return 0;
    var d = 0;
    I.incidentsAt(t).forEach(function(inc){
      var hit = [inc.out, inc.back].some(function(R){ return R.lanes.some(function(ln){ return ln.e.tram && r.lanes.some(function(m){ return m.e === ln.e; }); }); });
      if(hit) d = Math.max(d, 60*clamp(Math.ceil((inc.end - t)/60), 1, 15));
    });
    return d;
  }
  function loadOf(r, veh, ms){
    var H = HQV.hqCommute;
    if(H && H.load){ try { var v = H.load(kind, r.id, veh.id, ms, sim.seed); if(typeof v === "number" && isFinite(v)) return clamp(v, 0, 1.15); } catch(e){} }
    var h = (ms/3600000) % 24;
    return clamp(loadCurve(h)*(0.8 + 0.4*h01(sim.seed, hash32(veh.id), Math.floor(ms/1000/r.prof.T))), 0, 1.15);
  }
  function stops(){
    var out = [], seen = {};
    LS.forEach(function(r){
      lineStops(r).forEach(function(id){
        var s = I.sites[id];
        if(!s) return;
        if(!seen[id]){ seen[id] = {id: id, name: nameOf(id), x: s.x, y: s.y, z: s.z, mode: kind, lines: [], kind: "stop", under: false}; out.push(seen[id]); }
        if(seen[id].lines.indexOf(r.id) < 0) seen[id].lines.push(r.id);
      });
    });
    return out;
  }
  function stopsNear(x, z, rad){
    rad = num(rad, 60);
    var out = [];
    stops().forEach(function(s){ var d = Math.hypot(s.x - num(x, 0), s.z - num(z, 0)); if(d <= rad) out.push({id: s.id, name: s.name, dist: d, mode: kind, lines: s.lines.slice()}); });
    out.sort(function(a, b){ return a.dist - b.dist || (a.id < b.id ? -1 : 1); });
    return out;
  }
  // the next n calls at a stop (every line of this kind, every vehicle), soonest first; one that is standing
  // there with its doors open is "boarding"
  function departures(stopId, ms, n){
    var t = num(ms, 0)/1000, rows = [];
    n = Math.max(1, num(n, 4) | 0);
    LS.forEach(function(r){
      var dl = blockDelay(r, t), info = null;
      r.prof.stops.forEach(function(st){
        if(st.id !== String(stopId)) return;
        r.vehicles.forEach(function(veh){
          var off = offOf(r, veh), k = Math.ceil((t - (off + st.dep))/r.prof.T - 1e-9);
          for(var j = 0; j < n; j++){
            var arr = off + st.arr + (k + j)*r.prof.T, dep = off + st.dep + (k + j)*r.prof.T;
            info = info || lineInfo(r);
            rows.push({line: r.id, short: info.short, to: destOf(r, st.s + 0.5).name, at: Math.round(arr*1000), dep: Math.round(dep*1000),
                       plat: null, boarding: t >= arr && t < dep, delay: dl, vehicle: veh.id});
          }
        });
      });
    });
    rows.sort(function(a, b){ return a.at - b.at || (a.line < b.line ? -1 : a.line > b.line ? 1 : 0) || (a.vehicle < b.vehicle ? -1 : 1); });
    return rows.slice(0, n);
  }
  // how many times a tram has changed ends between unwrapped positions s0 and s1
  function flips(r, s0, s1){
    var n = 0, L = r.pl.len;
    (r.cusps || []).forEach(function(c){ for(var k = Math.ceil((s0 - c)/L); c + k*L < s1; k++) if(c + k*L > s0) n++; });
    return n;
  }
  // a seat (or standing spot past the seats) in world space for a vehicle at s
  function seatAt(r, s, i, flip, o){
    var list = SEATS[kind], p = i < list.length ? list[i] : STANDS[kind][clamp(i - list.length, 0, STANDS[kind].length - 1)];
    var x = p.x, z = p.z, yaw = p.yaw, d = 0;
    if(flip){ x = -x; z = -z; yaw += Math.PI; }
    if(kind === "tram"){ d = z >= 0 ? spec.sec/2 + 0.5 : -spec.sec/2 - 0.5; z -= d; }
    var q = I.partPose(r, s, d, spec.wb, o), c = Math.cos(q.yaw), sn = Math.sin(q.yaw);
    return {x: q.x + x*c + z*sn, y: q.y + FLOOR[kind] + p.y, z: q.z - x*sn + z*c, yaw: q.yaw + yaw};
  }
  // the call at fromStop (any vehicle of the line that has not left yet) that reaches toStop soonest
  function pick(r, from, to, t){
    var best = null, S = r.prof.stops, T = r.prof.T;
    S.forEach(function(a, ai){
      if(a.id !== from) return;
      var dt = Infinity, bi = -1;
      S.forEach(function(b, j){ if(b.id === to){ var d = mod(b.arr - a.dep, T); if(d > 0 && d < dt){ dt = d; bi = j; } } });
      if(bi < 0) return;
      r.vehicles.forEach(function(veh){
        var off = offOf(r, veh), k = Math.ceil((t - (off + a.dep))/T - 1e-9), dep = off + a.dep + k*T;
        if(!best || dep + dt < best.reach) best = {veh: veh, ai: ai, arr: off + a.arr + k*T, dep: dep, reach: dep + dt};
      });
    });
    return best;
  }
  function trip(lineId, fromStop, toStop, ms){
    var r = byId[String(lineId)], from = String(fromStop), to = String(toStop);
    if(!r || from === to) return null;
    var b = pick(r, from, to, num(ms, 0)/1000);
    if(!b) return null;
    var veh = b.veh, info = lineInfo(r), sDep = poseOf(r, veh, b.dep, {}).s, arrS = b.arr, reachS = b.reach, stopsT = [], T = r.prof.T;
    // the calls on the way, in order, to the one at toStop
    r.prof.stops.forEach(function(st){
      var a = offOf(r, veh) + st.arr, k = Math.ceil((b.dep - a)/T - 1e-9), at = a + k*T;
      if(at > b.dep && at <= b.reach + 1e-6 && st.id != null) stopsT.push({id: st.id, name: nameOf(st.id), at: Math.round(at*1000)});
    });
    stopsT.sort(function(x, y){ return x.at - y.at; });
    function tOf(ms2){ return clamp(num(ms2, 0)/1000, arrS, reachS); }
    var reachMs = Math.round(b.reach*1000);
    var out = {mode: kind, line: r.id, short: info.short, color: info.color, vehicle: veh.id, from: from, to: to,
             fromName: nameOf(from), toName: nameOf(to), headsign: destOf(r, r.prof.stops[b.ai].s + 0.5).name,
             arrive: Math.round(b.arr*1000), depart: Math.round(b.dep*1000), reach: reachMs, stops: stopsT, seats: SEATS[kind].length, standing: STANDS[kind].length,
             pose: function(ms2){
               var t = tOf(ms2), p = poseOf(r, veh, t, {});
               return {x: p.x, y: p.y + FLOOR[kind], z: p.z, yaw: p.yaw, pitch: 0, speed: p.speed, doors: doorsAt(r, veh, t), under: false, done: num(ms2, 0) >= reachMs};
             },
             seat: function(i, ms2){
               var t = tOf(ms2), q = r.prof.S(t - offOf(r, veh), {});
               return seatAt(r, q.s, clamp(num(i, 0) | 0, 0, SEATS[kind].length + STANDS[kind].length - 1), flips(r, sDep, q.s) % 2 === 1, {});
             },
             door: function(ms2){
               var t = tOf(ms2), q = r.prof.S(t - offOf(r, veh), {}), dz = DOORS[kind][1], d = 0, flip = flips(r, sDep, q.s) % 2 === 1;
               if(flip) dz = -dz;
               if(kind === "tram"){ d = dz >= 0 ? spec.sec/2 + 0.5 : -spec.sec/2 - 0.5; dz -= d; }
               var p = I.partPose(r, q.s, d, spec.wb, {}), c = Math.cos(p.yaw), sn = Math.sin(p.yaw), x = -spec.wid/2 - 0.3;
               return {x: p.x + x*c + dz*sn, z: p.z - x*sn + dz*c};
             }};
    return out;
  }
  // the stop a vehicle is at (doors side) or comes to next: {id, name, at (ms), here}
  function nextStop(r, veh, t){
    var T = r.prof.T, u = mod(t - offOf(r, veh), T), best = null, bd = Infinity;
    r.prof.stops.forEach(function(st){
      var here = (u >= st.arr && u <= st.dep) || (u + T >= st.arr && u + T <= st.dep), d = here ? -1 : mod(st.arr - u, T);
      if(d < bd){ bd = d; best = {id: st.id, name: nameOf(st.id), at: Math.round((t + Math.max(0, d))*1000), here: here}; }
    });
    return best;
  }
  function vehicles(ms){
    var t = num(ms, 0)/1000, out = [];
    LS.forEach(function(r){
      r.vehicles.forEach(function(veh){
        var p = poseOf(r, veh, t, {}), v = {id: veh.id, line: r.id, mode: kind, x: p.x, y: p.y, z: p.z, yaw: p.yaw, speed: p.speed,
            doors: doorsAt(r, veh, t), load: loadOf(r, veh, num(ms, 0)), under: false,
            to: destOf(r, mod(p.s, r.pl.len)).name, short: shortOf(r.id, kind), trip: Math.floor((t - offOf(r, veh))/r.prof.T), next: nextStop(r, veh, t)};
        if(kind === "tram") v.parts = I.sections(spec).map(function(sc){ var tp = I.partPose(r, p.s, sc[0], spec.wb, {}); return {x: tp.x, y: tp.y, z: tp.z, yaw: tp.yaw}; });
        out.push(v);
      });
    });
    return out;
  }
  return {mode: kind, lines: function(){ return LS.map(lineInfo); }, stops: stops, stopsNear: stopsNear, departures: departures,
          trip: trip, vehicles: vehicles, name: nameOf, seats: SEATS[kind], stands: STANDS[kind], doors: DOORS[kind], floor: FLOOR[kind]};
}

/* ---------- sound (Sound PR B): what a vehicle sounds like, for the City's voice pools (games/hqcity3d.js) ---------- */
// soundOf(v) -> {sk, voice, rpm} for an at() pose: sk its spatial kind in games/engine.js (vehicle, bus, tram), voice its
// engineSound profile (null for a tram: the engine's tram-run loop takes its speed instead; v.voice overrides it) and
// rpm the game's 900..7600 for its speed through a three-speed automatic (an electric one has no gears). A car's engine
// is picked by its id, so the same car always sounds the same.
var VOICE = {bus: "diesel", fire: "diesel", ambulance: "diesel", police: "v8"};
var CAR_VOICES = ["turbo", "turbo", "turbo4", "six", "electric", "diesel"];
var TYPE_VOICE = {van: "diesel", lorry: "diesel", scooter: "electric", bike: "electric"};     // [3.21] by city-life type
function soundOf(v){
  v = v || {};
  var k = Object.prototype.hasOwnProperty.call(SPEC, v.kind) ? v.kind : "car", sk = k === "bus" ? "bus" : k === "tram" ? "tram" : "vehicle";
  var ty = k === "car" && TYPE_VOICE[v.type] ? v.type : null;
  var voice = typeof v.voice === "string" ? v.voice : k === "tram" ? null : ty ? TYPE_VOICE[ty] : k === "car" ? CAR_VOICES[hash32(v.id) % CAR_VOICES.length] : VOICE[k];
  var s = clamp(num(v.speed, 0)/SPEC[ty || k].vmax, 0, 1.2), g = Math.min(2, Math.floor(s*3)), u = s*3 - g;
  var rpm = voice === "electric" ? 900 + 5000*s : g ? 1900 + 2300*u : 950 + 3000*u;
  return {sk: sk, voice: voice, rpm: Math.round(rpm)};
}

/* ---------- drawing: instanced bodies (THREE from c.THREE, only inside view()) ---------- */
function view(c){
  var THREE = c.THREE, group = new THREE.Group(), meshes = {}, mtx = new THREE.Matrix4(), q = new THREE.Quaternion(),
      p = new THREE.Vector3(), sc = new THREE.Vector3(1, 1, 1), e = new THREE.Euler(0, 0, 0, "YXZ"), col = new THREE.Color();
  group.name = "traffic";
  // parts: [geometry, colour hex, x, y, z, rx, ry, rz]; merged, vertex coloured
  function merge(parts){
    var P = [], N = [], C = [];
    parts.forEach(function(pt){
      var g = pt[0].index ? pt[0].toNonIndexed() : pt[0], k = new THREE.Color(pt[1]);
      e.set(pt[5] || 0, pt[6] || 0, pt[7] || 0); q.setFromEuler(e); p.set(pt[2] || 0, pt[3] || 0, pt[4] || 0);
      mtx.compose(p, q, sc); g.applyMatrix4(mtx);
      var a = g.attributes.position.array, n = g.attributes.normal.array;
      for(var i = 0; i < a.length; i++){ P.push(a[i]); N.push(n[i]); }
      for(i = 0; i < a.length/3; i++) C.push(k.r, k.g, k.b);
      if(g !== pt[0]) g.dispose();
      pt[0].dispose();
    });
    var out = new THREE.BufferGeometry();
    out.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
    out.setAttribute("normal", new THREE.Float32BufferAttribute(N, 3));
    out.setAttribute("color", new THREE.Float32BufferAttribute(C, 3));
    out.computeBoundingSphere();
    return out;
  }
  function box(w, h, d){ return new THREE.BoxGeometry(w, h, d); }
  function wheel(r, w){ return new THREE.CylinderGeometry(r, r, w, 12); }
  function side(pts, w){
    var s = new THREE.Shape(); s.moveTo(pts[0][0], pts[0][1]);
    for(var i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
    var g = new THREE.ExtrudeGeometry(s, {depth: w, bevelEnabled: false});
    g.rotateY(-Math.PI/2); g.translate(w/2, 0, 0); return g;
  }
  function wheels(list, r, w, xs, zs){ xs.forEach(function(x){ zs.forEach(function(z){ list.push([wheel(r, w), 0x1c1d21, x, r, z, 0, 0, Math.PI/2]); }); }); }
  // the hatchback of games/hq3d.js, simplified: the side profile, a glass cabin, round wheels, lamps
  function carGeo(){
    var paint = merge([[side([[-1.8, 0.3], [1.8, 0.3], [1.84, 0.6], [1.6, 0.84], [0.8, 0.92], [-1.24, 0.92], [-1.62, 0.89], [-1.84, 0.64]], 1.76), 0xffffff],
                       [box(1.62, 0.06, 1.36), 0xffffff, 0, 1.75, -0.36]]);
    var d = [[side([[-1.5, 0.92], [-1.2, 1.72], [0.26, 1.72], [0.84, 0.92]], 1.56), 0x28323e],
             [box(1.78, 0.18, 0.2), 0x2a2c30, 0, 0.36, 1.86], [box(1.78, 0.18, 0.2), 0x2a2c30, 0, 0.36, -1.86],
             [box(0.34, 0.12, 0.04), 0xfff4d0, 0.58, 0.7, 1.86], [box(0.34, 0.12, 0.04), 0xfff4d0, -0.58, 0.7, 1.86],
             [box(0.32, 0.12, 0.04), 0xc0202a, 0.6, 0.72, -1.86], [box(0.32, 0.12, 0.04), 0xc0202a, -0.6, 0.72, -1.86]];
    wheels(d, 0.34, 0.24, [-0.8, 0.8], [-1.2, 1.2]);
    return {paint: paint, detail: merge(d)};
  }
  function busGeo(){
    var paint = merge([[box(2.55, 1.3, 12), 0xffffff, 0, 1.05, 0]]);
    var d = [[box(2.57, 1.15, 11.4), 0x2a3440, 0, 2.27, 0.1], [box(2.5, 0.25, 11.9), 0xf0f0ea, 0, 2.97, 0],
             [box(1.6, 0.22, 0.05), 0xffb43a, 0, 2.62, 6.01], [box(0.4, 0.15, 0.05), 0xfff4d0, 0.85, 0.75, 6.01], [box(0.4, 0.15, 0.05), 0xfff4d0, -0.85, 0.75, 6.01],
             [box(0.4, 0.2, 0.05), 0xc0202a, 0.9, 0.9, -6.01], [box(0.4, 0.2, 0.05), 0xc0202a, -0.9, 0.9, -6.01]];
    wheels(d, 0.5, 0.32, [-1.1, 1.1], [-3.8, 3.6]);
    return {paint: paint, detail: merge(d)};
  }
  // one tram section (13 m); a tram is two of them
  function tramGeo(){
    var paint = merge([[box(2.65, 1.2, 13), 0xffffff, 0, 0.95, 0], [box(2.5, 0.3, 12.6), 0xffffff, 0, 3.25, 0]]);
    var d = [[box(2.67, 1.45, 12.6), 0x24303c, 0, 2.27, 0], [box(0.9, 0.35, 2.4), 0x30343a, 0, 3.55, 0],
             [box(0.06, 0.9, 0.06), 0x30343a, 0, 4.1, 0.6, 0.6], [box(1.6, 0.05, 0.08), 0x30343a, 0, 4.55, 0.85],
             [box(2.2, 0.35, 2.2), 0x1c1d21, 0, 0.35, 4.4], [box(2.2, 0.35, 2.2), 0x1c1d21, 0, 0.35, -4.4],
             [box(0.4, 0.15, 0.05), 0xfff4d0, 0.85, 0.85, 6.51], [box(0.4, 0.15, 0.05), 0xfff4d0, -0.85, 0.85, 6.51]];
    return {paint: paint, detail: merge(d)};
  }
  function evGeo(kind){
    var d = [];
    if(kind === "fire"){
      d.push([box(2.5, 1.9, 2.4), 0xc8202a, 0, 1.55, 2.6], [box(2.5, 1.6, 5.4), 0xc8202a, 0, 1.4, -1.3], [box(2.52, 0.7, 2.2), 0x28323e, 0, 2.05, 2.75],
             [box(2.52, 0.12, 7.9), 0xf0f0ea, 0, 1.0, 0], [box(0.5, 0.25, 6), 0xb8bec6, 0, 2.4, -1.0], [box(2.3, 0.3, 0.2), 0xb8bec6, 0, 0.5, 3.9]);
      wheels(d, 0.5, 0.36, [-1.05, 1.05], [-2.6, 2.4]);
    } else if(kind === "ambulance"){
      d.push([box(2.2, 1.3, 1.8), 0xf4f4f0, 0, 1.15, 2.0], [box(2.2, 2.2, 4.0), 0xf4f4f0, 0, 1.6, -0.9], [box(2.22, 0.6, 1.2), 0x28323e, 0, 1.55, 2.3],
             [box(2.23, 0.22, 5.9), 0xd02030, 0, 1.25, 0], [box(0.25, 0.8, 0.05), 0xd02030, 0, 1.9, -2.92], [box(0.8, 0.25, 0.05), 0xd02030, 0, 1.9, -2.92]);
      wheels(d, 0.4, 0.3, [-0.95, 0.95], [-1.9, 2.0]);
    } else {
      d.push([side([[-2.3, 0.3], [2.3, 0.3], [2.32, 0.65], [1.3, 0.85], [-2.0, 0.88], [-2.32, 0.7]], 1.86), 0x1d2c4a],
             [side([[-1.4, 0.85], [-1.0, 1.45], [0.5, 1.45], [1.1, 0.85]], 1.7), 0x28323e],
             [box(1.88, 0.3, 2.6), 0xf4f4f0, 0, 0.6, 0.1]);
      wheels(d, 0.34, 0.24, [-0.82, 0.82], [-1.4, 1.4]);
    }
    return merge(d);
  }
  // [3.21] city life's types: one merged, vertex-coloured body each, painted per instance (the paint multiplies the
  // light parts; glass, tyres and riders stay dark). A taxi is the car in taxi yellow with a lit roof sign (a beacon).
  function vanGeo(){
    var d = [[side([[-2.3, 0.32], [2.3, 0.32], [2.3, 0.8], [1.8, 1.25], [1.4, 2.05], [-2.3, 2.05]], 1.94), 0xffffff],
             [side([[1.82, 1.25], [1.42, 1.98], [1.3, 1.98], [1.68, 1.25]], 1.8), 0x28323e],
             [box(1.97, 0.5, 0.75), 0x28323e, 0, 1.55, 1.1], [box(1.9, 0.18, 0.12), 0x2a2c30, 0, 0.4, 2.32], [box(1.9, 0.18, 0.12), 0x2a2c30, 0, 0.4, -2.32],
             [box(0.32, 0.14, 0.04), 0xfff4d0, 0.62, 0.78, 2.31], [box(0.32, 0.14, 0.04), 0xfff4d0, -0.62, 0.78, 2.31],
             [box(0.22, 0.3, 0.04), 0xc0202a, 0.78, 0.9, -2.31], [box(0.22, 0.3, 0.04), 0xc0202a, -0.78, 0.9, -2.31], [box(0.02, 1.4, 0.02), 0x30343a, 0, 1.2, -2.31]];
    wheels(d, 0.36, 0.26, [-0.86, 0.86], [-1.45, 1.5]);
    return merge(d);
  }
  // a rigid lorry: a cab, a box body behind it, the chassis and three axles
  function lorryGeo(){
    var d = [[box(2.3, 1.9, 1.75), 0xffffff, 0, 1.55, 2.5], [box(2.32, 0.75, 0.06), 0x28323e, 0, 1.95, 3.38], [box(2.33, 0.6, 1.0), 0x28323e, 0, 1.95, 2.7],
             [box(2.4, 2.6, 4.7), 0xe9e8e2, 0, 2.05, -0.95], [box(2.0, 0.3, 6.7), 0x2a2c30, 0, 0.62, 0], [box(2.3, 0.3, 0.14), 0x2a2c30, 0, 0.62, 3.38],
             [box(0.36, 0.16, 0.04), 0xfff4d0, 0.8, 0.95, 3.39], [box(0.36, 0.16, 0.04), 0xfff4d0, -0.8, 0.95, 3.39],
             [box(0.3, 0.2, 0.04), 0xc0202a, 0.95, 0.8, -3.32], [box(0.3, 0.2, 0.04), 0xc0202a, -0.95, 0.8, -3.32], [box(0.03, 2.4, 0.03), 0x9aa0a8, 0, 2.05, -3.31]];
    wheels(d, 0.48, 0.34, [-1.0, 1.0], [2.4, -1.7, -2.75]);
    return merge(d);
  }
  // a scooter and its rider
  function scooterGeo(){
    var d = [[box(0.36, 0.14, 0.9), 0xffffff, 0, 0.32, 0], [box(0.42, 0.62, 0.12), 0xffffff, 0, 0.62, 0.5, -0.25], [box(0.44, 0.36, 0.7), 0xffffff, 0, 0.56, -0.38],
             [box(0.62, 0.05, 0.05), 0x2a2c30, 0, 1.0, 0.58], [box(0.06, 0.55, 0.06), 0x2a2c30, 0, 0.75, 0.6, -0.25], [box(0.12, 0.08, 0.04), 0xfff4d0, 0, 0.82, 0.72],
             [box(0.4, 0.58, 0.28), 0x3a4250, 0, 1.12, -0.2, 0.15], [box(0.27, 0.29, 0.3), 0x20242a, 0, 1.58, -0.12], [box(0.36, 0.18, 0.5), 0x2b3340, 0, 0.82, -0.05]];
    wheels(d, 0.24, 0.12, [0], [-0.6, 0.62]);
    return merge(d);
  }
  // a bicycle and its rider, leaning on the bars
  function bikeGeo(){
    var d = [[box(0.05, 0.05, 0.62), 0xffffff, 0, 0.78, 0.02], [box(0.05, 0.05, 0.72), 0xffffff, 0, 0.55, 0.12, -0.75], [box(0.05, 0.5, 0.05), 0xffffff, 0, 0.6, -0.26],
             [box(0.5, 0.04, 0.04), 0x2a2c30, 0, 0.98, 0.42], [box(0.16, 0.05, 0.24), 0x2a2c30, 0, 0.88, -0.28],
             [box(0.36, 0.55, 0.25), 0x3f6fa0, 0, 1.22, -0.08, 0.6], [box(0.24, 0.26, 0.26), 0x2a2420, 0, 1.6, 0.18], [box(0.32, 0.5, 0.18), 0x2b3340, 0, 0.66, -0.12, -0.3]];
    wheels(d, 0.34, 0.05, [0], [-0.52, 0.52]);
    return merge(d);
  }
  function inst(name, geo, cap, mat){
    var m = new THREE.InstancedMesh(geo, mat, cap);
    m.count = 0; m.name = "traffic-" + name; m.frustumCulled = false; m.castShadow = true; m.receiveShadow = true;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(m); meshes[name] = m; return m;
  }
  var vc = new THREE.MeshStandardMaterial({vertexColors: true, roughness: 0.55, metalness: 0.1});
  var paintM = new THREE.MeshStandardMaterial({vertexColors: true, roughness: 0.45, metalness: 0.25});
  var beaconM = new THREE.MeshBasicMaterial({toneMapped: false});
  var CG = carGeo(), BG = busGeo(), TG = tramGeo();
  inst("car", CG.paint, CAP.car, paintM); inst("carDetail", CG.detail, CAP.car, vc);
  inst("bus", BG.paint, CAP.bus, paintM); inst("busDetail", BG.detail, CAP.bus, vc);
  inst("tram", TG.paint, CAP.tram*2, paintM); inst("tramDetail", TG.detail, CAP.tram*2, vc);
  EV_KINDS.forEach(function(k){ inst(k, evGeo(k), CAP[k], vc); });
  inst("van", vanGeo(), CAP.van, paintM); inst("lorry", lorryGeo(), CAP.lorry, paintM); inst("scooter", scooterGeo(), CAP.scooter, paintM); inst("bike", bikeGeo(), CAP.bike, paintM);
  inst("beacon", new THREE.BoxGeometry(0.28, 0.14, 0.2), CAP.fire*2 + CAP.ambulance*2 + CAP.police*2 + CAP.taxi, beaconM);   // (and the taxis' roof signs)
  var BEACON_Y = {fire: 2.6, ambulance: 2.8, police: 1.55}, BEACON_Z = {fire: 3.3, ambulance: 2.6, police: -0.2};

  var sc2 = new THREE.Vector3(1, 1, 1);
  function put(m, i, x, y, z, yaw, hex, sx, sy, sz){
    e.set(0, yaw, 0); q.setFromEuler(e); p.set(x, y, z); mtx.compose(p, q, sx ? sc2.set(sx, sy, sz) : sc); m.setMatrixAt(i, mtx);
    if(hex != null){ col.setHex(hex); m.setColorAt(i, col); }
  }
  // opts.hide: {vehicleId: true} for the vehicles a detailed model draws instead (games/hqcoach.js near())
  function update(vehicles, timeMs, opts){
    var n = {car: 0, bus: 0, tram: 0, fire: 0, ambulance: 0, police: 0, beacon: 0, van: 0, lorry: 0, scooter: 0, bike: 0}, flash = Math.floor(num(timeMs, 0)/250) & 1;
    var hide = opts && opts.hide;
    (vehicles || []).forEach(function(v){
      var k = v.kind;
      if(n[k] == null || (hide && hide[v.id])) return;
      if(k === "tram"){
        if(n.tram + 2 > CAP.tram*2) return;
        // two sections, the rear one turned round (a double-ended tram has a cab at each end)
        var hx = LINE_COL[hash32(v.line) % LINE_COL.length], P = v.parts || [v, v];
        P.forEach(function(pt, j){
          var yw = pt.yaw + (j ? Math.PI : 0);
          put(meshes.tram, n.tram, pt.x, pt.y, pt.z, yw, hx); put(meshes.tramDetail, n.tram, pt.x, pt.y, pt.z, yw); n.tram++;
        });
        return;
      }
      // [3.21] a van, lorry, scooter or bike on its own body
      if(k === "car" && v.type && v.type !== "car" && v.type !== "taxi" && meshes[v.type]){
        if(n[v.type] < CAP[v.type]) put(meshes[v.type], n[v.type]++, v.x, v.y, v.z, v.yaw, v.paint != null ? v.paint : 0xf2f2ee);
        return;
      }
      if(n[k] >= CAP[k]) return;
      if(k === "car"){
        put(meshes.car, n.car, v.x, v.y, v.z, v.yaw, v.paint != null ? v.paint : 0x8a9199); put(meshes.carDetail, n.car, v.x, v.y, v.z, v.yaw);
        if(v.type === "taxi" && n.beacon < meshes.beacon.instanceMatrix.count){
          var ts = Math.sin(v.yaw), tc = Math.cos(v.yaw);
          put(meshes.beacon, n.beacon++, v.x - 0.36*ts, v.y + 1.87, v.z - 0.36*tc, v.yaw, TAXI_SIGN, 2.1, 1.3, 1.2);
        }
      }
      else if(k === "bus"){ put(meshes.bus, n.bus, v.x, v.y, v.z, v.yaw, LINE_COL[hash32(v.line) % LINE_COL.length]); put(meshes.busDetail, n.bus, v.x, v.y, v.z, v.yaw); }
      else {
        put(meshes[k], n[k], v.x, v.y, v.z, v.yaw);
        var s = Math.sin(v.yaw), cs = Math.cos(v.yaw), bz = BEACON_Z[k], by = BEACON_Y[k];
        [-0.45, 0.45].forEach(function(lx, j){
          if(n.beacon >= meshes.beacon.instanceMatrix.count) return;
          put(meshes.beacon, n.beacon++, v.x + lx*cs + bz*s, v.y + by, v.z - lx*s + bz*cs, v.yaw, v.siren && (flash ^ j) ? 0x3a6bff : 0xff2a2a);
        });
      }
      n[k]++;
    });
    Object.keys(n).forEach(function(k){
      [k, k + "Detail"].forEach(function(name){
        var m = meshes[name];
        if(!m) return;
        m.count = n[k]; m.instanceMatrix.needsUpdate = true;
        if(m.instanceColor) m.instanceColor.needsUpdate = true;
      });
    });
    return n;
  }
  function drawCalls(){ var d = 0; for(var k in meshes) if(meshes[k].count > 0) d++; return d; }
  function dispose(){
    for(var k in meshes){ meshes[k].geometry.dispose(); meshes[k].dispose(); }
    vc.dispose(); paintM.dispose(); beaconM.dispose();
    if(group.parent) group.parent.remove(group);
  }
  return {group: group, meshes: meshes, update: update, drawCalls: drawCalls, dispose: dispose};
}

/* ---------- [3.22] the street: traffic lights and parked cars (THREE only inside street()) ---------- */
// street(THREE, scene, W, o) -> {group, update(localMs, cam), blocked(x, z), info(), drawCalls(), dispose()}
// The lights of HQV.cityLife.signals(W): at each arm a pole on the kerb beside the stop line, a three-aspect head on top
// facing the traffic coming in and a walk head facing across the arm, and the stop line across the lane coming in.
// The parked cars of cityLife.parked(W). Four instanced meshes in all, built once: poles and housings, lenses (lit by
// the light's state through their instance colours: near the camera every frame, the rest every LENS_ALL s), stop
// lines, and the parked cars within PARK_NEAR m of the camera (rebuilt as it moves on; none on a street that is closed,
// where the market stands). Poles and parked cars are solid (blocked). Below the street (the metro) none of it.
var LENS_NEAR = 320, LENS_ALL = 2000, PARK_NEAR = 240, PARK_CAP = 900, PARK_MOVE = 24;
var LENS_ON = [0xff2a1a, 0xffb020, 0x2aff6a, 0xff3a24, 0xe8fff0], LENS_OFF = [0x34100c, 0x34260c, 0x0c2e16, 0x2a0e0a, 0x1c2420];
function street(THREE, scene, W, o){
  o = o || {};
  var CL = HQV.cityLife, WQ = HQV.world, group = new THREE.Group();
  group.name = "city-street";
  if(scene && scene.add) scene.add(group);
  var SIGS = {}, PARK = [];
  try { SIGS = CL && CL.signals ? CL.signals(W) || {} : {}; } catch(e){ SIGS = {}; }
  try { PARK = CL && CL.parked ? CL.parked(W) || [] : []; } catch(e){ PARK = []; }
  var UP = WQ && WQ.SIDEWALK_UP != null ? WQ.SIDEWALK_UP : 0.15;
  function roadY(x, z, d){ var n = WQ && WQ.nearestRoad ? WQ.nearestRoad(W, x, z, 30) : null; return n ? n.y : d; }
  // each arm: its pole (on the kerb beside the stop line, a step back), the way its head faces, the ground there
  var arms = [];
  Object.keys(SIGS).sort(function(a, b){ return (+a) - (+b) || (a < b ? -1 : a > b ? 1 : 0); }).forEach(function(id){
    var sg = SIGS[id];
    (sg.arms || []).forEach(function(a){
      var h = a.heading, ax = Math.sin(h), az = Math.cos(h), rx = -Math.cos(h), rz = Math.sin(h), c = num(a.half, 3);
      // (on the pavement: a little further out where the kerb bends away)
      for(var out = 0.75, px, pz; out < 4; out += 0.75){
        px = a.stopX + rx*(c/2 + out) - ax*0.9; pz = a.stopZ + rz*(c/2 + out) - az*0.9;
        if(!WQ || !WQ.surfaceAt || WQ.surfaceAt(W, px, pz) !== "road") break;
      }
      if(WQ && WQ.surfaceAt && WQ.surfaceAt(W, px, pz) === "road") return;     // (no pavement there: in another road)
      var y = roadY(a.stopX, a.stopZ, 0);
      arms.push({sig: sg, a: a, x: px, z: pz, y: y + UP, yaw: h + Math.PI, sx: a.stopX, sz: a.stopZ, sy: y, c: c});
    });
  });
  var m4 = new THREE.Matrix4(), qq = new THREE.Quaternion(), eu = new THREE.Euler(0, 0, 0, "YXZ"), v3 = new THREE.Vector3(), sc = new THREE.Vector3(1, 1, 1), col = new THREE.Color();
  function merge(parts){
    var P = [], N = [], C = [];
    parts.forEach(function(pt){
      var g = pt[0].index ? pt[0].toNonIndexed() : pt[0], k = new THREE.Color(pt[1]);
      eu.set(pt[5] || 0, pt[6] || 0, pt[7] || 0); qq.setFromEuler(eu); v3.set(pt[2] || 0, pt[3] || 0, pt[4] || 0);
      m4.compose(v3, qq, sc); g.applyMatrix4(m4);
      var a = g.attributes.position.array, n = g.attributes.normal.array, i;
      for(i = 0; i < a.length; i++){ P.push(a[i]); N.push(n[i]); }
      for(i = 0; i < a.length/3; i++) C.push(k.r, k.g, k.b);
      if(g !== pt[0]) g.dispose();
      pt[0].dispose();
    });
    var out = new THREE.BufferGeometry();
    out.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
    out.setAttribute("normal", new THREE.Float32BufferAttribute(N, 3));
    out.setAttribute("color", new THREE.Float32BufferAttribute(C, 3));
    out.computeBoundingSphere();
    return out;
  }
  function bx(w, h, d){ return new THREE.BoxGeometry(w, h, d); }
  function cy(r, h){ return new THREE.CylinderGeometry(r, r, h, 8); }
  // the pole, local: +z faces the traffic coming in, +x is the pavement side; the walk head faces across (-x)
  var poleG = merge([[cy(0.07, 3.3), 0x3a3f46, 0, 1.65, 0], [bx(0.36, 1.0, 0.26), 0x22262c, 0, 2.78, 0.05], [bx(0.5, 1.14, 0.03), 0x111316, 0, 2.78, -0.09],
                     [bx(0.24, 0.05, 0.12), 0x22262c, 0, 3.15, 0.2], [bx(0.24, 0.05, 0.12), 0x22262c, 0, 2.83, 0.2], [bx(0.24, 0.05, 0.12), 0x22262c, 0, 2.51, 0.2],
                     [bx(0.24, 0.58, 0.3), 0x22262c, -0.13, 1.95, 0], [bx(0.36, 0.08, 0.36), 0x3a3f46, 0, 0.04, 0]]);
  var lensG = new THREE.BoxGeometry(0.2, 0.2, 0.04);
  var lineG = new THREE.BoxGeometry(1, 0.025, 0.4);
  var mat = new THREE.MeshStandardMaterial({vertexColors: true, roughness: 0.6, metalness: 0.2});
  var lensM = new THREE.MeshBasicMaterial({toneMapped: false});
  var lineM = new THREE.MeshStandardMaterial({color: 0xeeeeea, roughness: 0.8});
  function inst(name, geo, n, m){
    var I = new THREE.InstancedMesh(geo, m, Math.max(1, n));
    I.name = "street-" + name; I.count = 0; I.frustumCulled = false;
    group.add(I); return I;
  }
  function put(I, i, x, y, z, yaw, sx, sy, sz){
    eu.set(0, yaw, 0); qq.setFromEuler(eu); v3.set(x, y, z); m4.compose(v3, qq, sx != null ? new THREE.Vector3(sx, sy, sz) : sc); I.setMatrixAt(i, m4);
  }
  var poles = inst("poles", poleG, arms.length, mat), lenses = inst("lenses", lensG, arms.length*5, lensM), lines = inst("stoplines", lineG, arms.length, lineM);
  poles.castShadow = true;
  // a lens j of an arm (0 red, 1 amber, 2 green; 3 the red man, 4 the green man): its place in the pole's frame
  var LENS = [[0, 3.15, 0.2], [0, 2.83, 0.2], [0, 2.51, 0.2], [-0.26, 2.08, 0], [-0.26, 1.8, 0]];
  arms.forEach(function(A, k){
    put(poles, k, A.x, A.y, A.z, A.yaw);
    var s = Math.sin(A.yaw), c = Math.cos(A.yaw);
    LENS.forEach(function(L, j){
      var lx = L[0], lz = L[2];
      put(lenses, k*5 + j, A.x + lx*c + lz*s, A.y + L[1], A.z - lx*s + lz*c, j < 3 ? A.yaw : A.yaw - Math.PI/2);
      col.setHex(LENS_OFF[j]); lenses.setColorAt(k*5 + j, col);
    });
    put(lines, k, A.sx, A.sy + 0.03, A.sz, A.a.heading, A.c, 1, 1);
  });
  poles.count = arms.length; lenses.count = arms.length*5; lines.count = arms.length;
  [poles, lenses, lines].forEach(function(I){ I.instanceMatrix.needsUpdate = true; if(I.instanceColor) I.instanceColor.needsUpdate = true; });
  var state = [];                     // the lit lenses per arm, as a number (so a colour is set only when it changes)
  function lightArm(A, k, ms){
    var st = CL.signalAt(A.sig, ms, A.a.heading), walk = CL.walkAt(A.sig, ms, A.a.heading + Math.PI/2);
    var key = (st === "red" ? 1 : st === "amber" ? 2 : 4) + (walk ? 16 : 8);
    if(state[k] === key) return false;
    state[k] = key;
    for(var j = 0; j < 5; j++){
      var on = j === 0 ? st === "red" : j === 1 ? st === "amber" : j === 2 ? st === "green" : j === 3 ? !walk : walk;
      col.setHex(on ? LENS_ON[j] : LENS_OFF[j]); lenses.setColorAt(k*5 + j, col);
    }
    return true;
  }
  // the parked cars: one body, painted per instance (a van is the car drawn longer and taller)
  var carG = merge([[bx(1.78, 0.6, 3.86), 0xffffff, 0, 0.56, 0], [bx(1.56, 0.5, 2.0), 0x28323e, 0, 1.1, -0.25], [bx(1.5, 0.06, 1.9), 0xffffff, 0, 1.38, -0.25],
                    [cy(0.33, 0.22), 0x1c1d21, 0.8, 0.33, 1.25, 0, 0, Math.PI/2], [cy(0.33, 0.22), 0x1c1d21, -0.8, 0.33, 1.25, 0, 0, Math.PI/2],
                    [cy(0.33, 0.22), 0x1c1d21, 0.8, 0.33, -1.25, 0, 0, Math.PI/2], [cy(0.33, 0.22), 0x1c1d21, -0.8, 0.33, -1.25, 0, 0, Math.PI/2],
                    [bx(0.3, 0.12, 0.04), 0xfff4d0, 0.58, 0.68, 1.94], [bx(0.3, 0.12, 0.04), 0xfff4d0, -0.58, 0.68, 1.94],
                    [bx(0.3, 0.12, 0.04), 0xc0202a, 0.6, 0.7, -1.94], [bx(0.3, 0.12, 0.04), 0xc0202a, -0.6, 0.7, -1.94]]);
  var parkM = new THREE.MeshStandardMaterial({vertexColors: true, roughness: 0.45, metalness: 0.25});
  var parkI = inst("parked", carG, Math.min(PARK_CAP, PARK.length), parkM);
  parkI.castShadow = true; parkI.receiveShadow = true;
  var SZ = {car: [1, 1, 1], van: [1.08, 1.3, 1.19]}, DIM = {car: [SPEC.car.wid, SPEC.car.len], van: [SPEC.van.wid, SPEC.van.len]};
  // solid things in 16 m cells: [kind, index]
  var cells = {};
  function cellOf(x, z){ return Math.floor(x/16) + ":" + Math.floor(z/16); }
  arms.forEach(function(A, k){ (cells[cellOf(A.x, A.z)] = cells[cellOf(A.x, A.z)] || []).push([0, k]); });
  PARK.forEach(function(P, k){
    var R = 3, x0 = Math.floor((P.x - R)/16), x1 = Math.floor((P.x + R)/16), z0 = Math.floor((P.z - R)/16), z1 = Math.floor((P.z + R)/16);
    for(var i = x0; i <= x1; i++) for(var j = z0; j <= z1; j++) (cells[i + ":" + j] = cells[i + ":" + j] || []).push([1, k]);
  });
  var closedNow = {}, closedKey = null, last = {x: null, z: null, ms: -Infinity}, parkDirty = true, shown = 0;
  function parkBuild(cx, cz){
    var near = [];
    PARK.forEach(function(P, k){
      if(closedNow[P.edge]) return;
      var d = Math.hypot(P.x - cx, P.z - cz);
      if(d <= PARK_NEAR) near.push([d, k]);
    });
    near.sort(function(a, b){ return a[0] - b[0] || a[1] - b[1]; });
    var n = Math.min(near.length, parkI.instanceMatrix.count);
    for(var i = 0; i < n; i++){
      var P = PARK[near[i][1]], S = SZ[P.type] || SZ.car, pal = P.type === "van" ? VAN_PAINT : PAINT;
      put(parkI, i, P.x, P.y, P.z, P.yaw, S[0], S[1], S[2]);
      col.setHex(pal[Math.floor(num(P.paint, 0)*pal.length) % pal.length]); parkI.setColorAt(i, col);
    }
    parkI.count = n; shown = n;
    parkI.instanceMatrix.needsUpdate = true;
    if(parkI.instanceColor) parkI.instanceColor.needsUpdate = true;
  }
  function update(localMs, cam){
    if(!CL || !W) return;
    var U = HQV.hqUnderground, under = !!(U && U.under && U.under());
    if(group.visible === under) group.visible = !under;
    if(under) return;
    var ms = num(+localMs, 0), cx = cam && cam.x != null ? +cam.x : 0, cz = cam && cam.z != null ? +cam.z : 0, key = Math.floor(ms/5000);
    // closed streets: no parked cars on them (looked up every 5 s)
    if(key !== closedKey && CL.closed){
      closedKey = key;
      var cl = {};
      try { cl = CL.closed(W, ms) || {}; } catch(e){ cl = {}; }
      if(JSON.stringify(cl) !== JSON.stringify(closedNow)){ closedNow = cl; parkDirty = true; }
    }
    if(parkDirty || last.x == null || Math.hypot(cx - last.x, cz - last.z) > PARK_MOVE){ parkBuild(cx, cz); parkDirty = false; last.x = cx; last.z = cz; }
    // the lenses: near you every frame, all of them now and then
    var all = ms - last.ms >= LENS_ALL || ms < last.ms, changed = false;
    if(all) last.ms = ms;
    for(var k = 0; k < arms.length; k++){
      var A = arms[k];
      if(!all && (Math.abs(A.x - cx) > LENS_NEAR || Math.abs(A.z - cz) > LENS_NEAR)) continue;
      if(lightArm(A, k, ms)) changed = true;
    }
    if(changed && lenses.instanceColor) lenses.instanceColor.needsUpdate = true;
  }
  function blocked(x, z){
    if(!group.visible) return false;
    var L = cells[cellOf(x, z)];
    if(!L) return false;
    for(var i = 0; i < L.length; i++){
      var it = L[i];
      if(it[0] === 0){ var A = arms[it[1]]; if(Math.hypot(x - A.x, z - A.z) < 0.3) return true; continue; }
      var P = PARK[it[1]];
      if(closedNow[P.edge]) continue;
      var D = DIM[P.type] || DIM.car, dx = x - P.x, dz = z - P.z, s = Math.sin(P.yaw), c = Math.cos(P.yaw);
      if(Math.abs(dx*s + dz*c) <= D[1]/2 + 0.1 && Math.abs(dx*c - dz*s) <= D[0]/2 + 0.1) return true;
    }
    return false;
  }
  function drawCalls(){ var n = 0; group.children.forEach(function(m){ if(m.count > 0) n++; }); return group.visible ? n : 0; }
  function info(){ return {lights: Object.keys(SIGS).length, heads: arms.length, parked: PARK.length, shown: shown, closed: Object.keys(closedNow).length, drawCalls: drawCalls()}; }
  function dispose(){
    group.children.slice().forEach(function(m){ m.geometry.dispose(); if(m.dispose) m.dispose(); });
    mat.dispose(); lensM.dispose(); lineM.dispose(); parkM.dispose();
    if(group.parent) group.parent.remove(group);
  }
  return {group: group, update: update, blocked: blocked, info: info, drawCalls: drawCalls, dispose: dispose, arms: arms};
}

HQV.traffic = {create: create, view: view, street: street, SPEC: SPEC, GAP: GAP, DWELL: DWELL, FARE: FARE, DENS: DENS, CAP: CAP, INC_W: INC_W,
               lanes: lanes, tramPaths: tramPaths, tramStops: tramStops, service: service, SEATS: SEATS, STANDS: STANDS, DOORS: DOORS, FLOOR: FLOOR,
               lineColor: lineColor, shortOf: shortOf, loadCurve: loadCurve, soundOf: soundOf,
               _: {plOf: plOf, plAt: plAt, offsetPts: offsetPts, trimPts: trimPts, Profile: Profile, fastest: fastest, ease: ease}};
})();
