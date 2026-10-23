/* Claude HQ: traffic for the 3D cities (HQV.traffic): cars, buses, trams and emergency runs.
 *
 * create(doc, {tier, grow, seed, onFare, city}) -> sim, a pure function of (world doc, city tier and growth,
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
 * With a city (o.city: D, games/citysim.js's director) the seeded windows are off and every emergency and
 * service unit of D's events drives instead (see "the city's runs" below): fire engines to the fire, the
 * ambulance to the scene and on to ev.dest, police and tow trucks to crashes, school buses and market vans,
 * and robberies as chases (the getaway car along ev.route, police behind it). Patrol cars and delivery vans
 * ride free car-ring slots, as many as D has out; the cars a ring shows follow D.at(ms).rush (a slot's car
 * is in or out for a whole lap, decided where the lap starts). Without a city nothing changes.
 * at(timeMs, center, radius, obstacles): the vehicles within radius, nearest first, as {id, kind, x,
 * y, z, yaw, speed} (the body's centre) plus paint / line / pull / siren, and a tram's two sections
 * as parts [{x, y, z, yaw}]. A city unit also has ev (its event id), phase ("responding", "onscene",
 * "transport", "drop", "returning", "chase", "caught") and lights (beacons on, no siren); a patrol car has
 * patrol: true. Kinds: car, bus, tram, fire, ambulance, police, tow, van, schoolbus, getaway.
 * view(c).update(vehicles, timeMs, {calm}) draws them; with calm the beacons are lit steady, never flashing.
 * Obstacles (the player's vehicle, {x, z, r}) make cars and transit brake
 * behind them: a local override (a lag per vehicle, eased back to the timetable once clear),
 * deterministic for the same sequence of calls, and never fed back into the shared schedule.
 * Riding: stopsNear(x, z, r), nextArrival(stopId, timeMs), rideTo(line, from, to, timeMs) -> a trip
 * the integrator moves the player along (trip.pose(ms)); trip.pay() calls the onFare hook once (the
 * integrator POSTs /api/arena/city/:owner/fare {kind}).
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
  tow:       {len: 6.2, wid: 2.3, vmax: 13, acc: 2.2, wb: 3.6},
  van:       {len: 4.6, wid: 1.95, vmax: 12, acc: 2.2, wb: 2.9},
  schoolbus: {len: 9, wid: 2.4, vmax: 10, acc: 1.4, wb: 5},
  getaway:   {len: 4.4, wid: 1.85, vmax: 18, acc: 3.8, wb: 2.6}
};
var GAP = 2.6;                          // bumper to bumper, at the closest
var V_STRAIGHT = 9, V_TURN = 6.5, V_UTURN = 3, V_CREEP = 2.5, CLEAR = 0.6, CLASH = 0.3, H_MIN = 6, H_MAX = 16, REPS = 3;
var DWELL = 20, FARE = 2, LAYOVER = 30, XOVER = 30, BLOCK = 15, BAY = 2.9, RAMP = 12, BAY_BLOCK = 3, BAY_YAW = 0.15;
var DENS = [0.3, 0.45, 0.6, 0.72, 0.85];  // share of a ring's slots with a car, per tier
var HEADWAY = {bus: 240, tram: 300};      // target seconds between vehicles on a line
var INC_W = 240, INC_P = 0.3, INC_LOOK = 3, EV_DWELL = 40, EV_YIELD = 45, EV_NEAR = 120, EV_FAR = 1200, EV_HW = 1.25, EV_TRY = 90, EV_HOLD = 90;
var EV_KINDS = ["fire", "ambulance", "police"];
var EV_SITES = {fire: {fire: 1}, ambulance: {hospital: 1, clinic: 1}, police: {police: 1}};
var PULL_TAPER = 10, LOOK = 34, BRAKE = 14, CATCH = 0.6, CATCH_MAX = 4, OBS_R = 2.4;
var CAP = {car: 200, bus: 32, tram: 16, fire: 8, ambulance: 6, police: 10, tow: 4, van: 12, schoolbus: 6, getaway: 2};
// with a city (o.city): its units drive the emergency lanes; patrols and delivery vans ride the car rings
var SIREN = {fire: 1, ambulance: 1, police: 1};
// s: events listed per bucket, looked back over and planned ahead of; least time at a stop; police leave a
// roadblock this far apart; m: units park this far short of a box; plans per trip; reroutes round stuck boxes
var CITY_BUCKET = 2, CITY_TAIL = 600, CITY_AHEAD = 240, CLOCK_BUCKET = 60, SCENE_MIN = 20, ARREST_MIN = 60, LEAVE_STEP = 3;
var PARK_BACK = 6, CITY_TRY = 40, AVOID_MAX = 3;
var TRANSIT_PEN = 6;   // the cost factor on tram-track and bus-lane roads for a run that never fits their timetable
// s: a chase starts CHASE_STEP later at a time (CHASE_TRY times) until every chaser keeps its lag within CHASE_SLACK
var CHASE_STEP = 2, CHASE_SLACK = 3, CHASE_TRY = 15;
var RING_SVC = {police: 4, van: 8};        // ring slots kept for patrol cars and vans (shown while the city has them out)
var RUSH_K = [0.8, 1.25], DENS_TOP = 0.95; // a ring slot's car shows while its hash < density x (0.8 .. 1.25 with the rush)
var VAN_PAINT = [0xf2f2ee, 0xe8b730, 0xc8323c, 0x2a6fd6];
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
  for(var i = 1; i < A.length; i++){
    var p = A[i-1], q = A[i], ax0 = Math.min(p[0], q[0]), ax1 = Math.max(p[0], q[0]), az0 = Math.min(p[2], q[2]), az1 = Math.max(p[2], q[2]);
    for(var j = 1; j < B.length; j++){
      var r = B[j-1], t = B[j];
      // (a pair whose boxes are already further apart than the best so far cannot be nearer)
      var gx = Math.max(0, Math.min(r[0], t[0]) - ax1, ax0 - Math.max(r[0], t[0])), gz = Math.max(0, Math.min(r[2], t[2]) - az1, az0 - Math.max(r[2], t[2]));
      if(gx*gx + gz*gz >= best*best) continue;
      var d = segDist(p[0], p[2], q[0], q[2], r[0], r[2], t[0], t[2]);
      if(d < best) best = d;
    }
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
  var city = o.city && typeof o.city === "object" ? o.city : null;
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
    var path = (l.path || []).slice();
    if(path.length < 2){ errors.push("line " + l.id + ": short path"); return; }
    if(path[0] === path[path.length - 1]) path.pop();
    else if(!edgeBetween(path[path.length - 1], path[0])) path = path.concat(path.slice(1, -1).reverse());   // out and back
    var lanes = [];
    for(var i = 0; i < path.length; i++){
      var eb = edgeBetween(path[i], path[(i + 1) % path.length]);
      if(!eb){ errors.push("line " + l.id + ": no road " + path[i] + "-" + path[(i + 1) % path.length]); return; }
      lanes.push({e: eb.e, dir: eb.dir});
    }
    lanes.forEach(function(ln){ if(kind === "tram") ln.e.tram = true; else ln.e.bus[ln.dir] = true; });
    lineDefs.push({id: String(l.id), kind: kind, tier: l.tier | 0, lanes: lanes, stops: (l.stops || []).map(String)});
  });

  // lateral plan per edge: m to the right of the centre line, per direction
  edges.forEach(function(E){
    var inner = 0.15, c = E.c, tw = SPEC.tram.wid, cw = SPEC.car.wid, bw = SPEC.bus.wid;
    E.tramOff = E.tram ? inner + tw/2 : null;
    var in2 = E.tram ? inner + tw + 0.3 : inner, carOff = Math.max(in2 + cw/2 + 0.1, E.tram ? 0 : c/2), anyBus = E.bus[0] || E.bus[1];
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

  // a lane: the edge's points in travel order, offset to the right, trimmed back from both nodes
  function lanePts(E, dir, off){
    var pts = dir ? E.pts.slice().reverse() : E.pts, from = dir ? E.b : E.a, to = dir ? E.a : E.b;
    return trimPts(offsetPts(pts, off), radius[from] || 0, radius[to] || 0);
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
                   occ: (sOut - sIn + spec.len - front)/vb + CLEAR, key: lanes[i].e.i*2 + lanes[i].dir, turn: Math.abs(ang) > 0.5});
    }
    return {pl: plOf(pts), passes: passes, cusps: cusps, lanes: lanes, ranges: ranges, rev: rev, open: !!open};
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
    r.id = d.id; r.kind = d.kind; r.tier = d.tier; r.stops = [];
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
  function colour(P){
    var colours = [], widths = [];
    P.forEach(function(p){
      for(var c = 0; ; c++){
        if((colours[c] || []).some(function(q){ return clash(p, q); })) continue;
        (colours[c] = colours[c] || []).push(p); p.colour = c; widths[c] = Math.max(widths[c] || 0, p.occ); return;
      }
    });
    return widths;
  }
  var need = 0, nodeSlots = {}, slotIds = Object.keys(atNode).sort();
  slotIds.forEach(function(id){
    var P = atNode[id].sort(function(a, b){ return a.key - b.key || (a.transit ? 1 : 0) - (b.transit ? 1 : 0) || a.sIn - b.sIn; });
    var C = P.filter(function(p){ return !p.transit; }), Tp = P.filter(function(p){ return p.transit; });
    P.forEach(function(p){ p.slot = null; });
    var N = {car: C, tr: Tp, widths: colour(C), twidths: colour(Tp)};
    N.sum = N.widths.reduce(function(a, b){ return a + b; }, 0);
    N.tsum = N.twidths.reduce(function(a, b){ return a + b; }, 0);
    N.carSlots = N.widths.length > 1;
    N.trSlots = Tp.length > 0 && (N.twidths.length > 1 || Tp.some(function(p){ return C.some(function(q){ return clash(p, q); }); }));
    // room in every cycle for the widest transit window too, so a bus fits between the car windows
    if(N.carSlots) need = Math.max(need, N.sum + (N.trSlots ? Math.max.apply(null, N.twidths) : 0));
    if(N.carSlots || N.trSlots) nodeSlots[id] = N;
  });
  var H = clamp(Math.ceil(need*2)/2, H_MIN, H_MAX), HB = REPS*H, overfull = 0;
  slotIds.forEach(function(id){
    var N = nodeSlots[id];
    if(!N || !N.carSlots) return;
    var k = N.sum > H ? H/N.sum : 1, base = h01(seed, hash32(id), 7)*H, off = 0;
    if(k < 1) overfull++;
    N.starts = N.widths.map(function(w){ var s = mod(base + off, H); off += w*k; return s; });
    N.car.forEach(function(p){ p.slot = N.starts[p.colour]; });
  });

  // ---- profiles ----
  // events along the route (turns and stops), from the first slotted turn; slack before a slotted turn
  // is waited out at the stop before it when there is one, else on the road (slower, or at the line)
  function profileOf(r, spec, stops, pad){
    var ev = [], cyc = r.kind === "car" ? H : HB;
    r.passes.forEach(function(p){ ev.push({s: p.sIn, s2: p.sOut, v: p.v, slot: p.slot, pass: p}); });
    (stops || []).forEach(function(st, i){ ev.push({s: st.s, s2: st.s, v: 0, stop: st, idx: i}); });
    (r.cusps || []).forEach(function(c){ ev.push({s: c, s2: c, v: 0, stop: {id: null, s: c}}); });
    if(pad && pad.s != null) ev.push({s: pad.s, s2: pad.s, v: 0, stop: pad.stop = {id: null, s: pad.s, pad: true}});
    ev.sort(function(a, b){ return a.s - b.s || (a.stop ? -1 : 1); });
    var k0 = 0, i;
    for(i = 0; i < ev.length; i++) if(ev[i].slot != null){ k0 = i; break; }
    if(i === ev.length) for(i = 0; i < ev.length; i++) if(ev[i].stop){ k0 = i; break; }
    var Lr = r.pl.len, s0 = ev[k0].s, order = ev.slice(k0).concat(ev.slice(0, k0).map(function(e){ var c = {}; for(var q in e) c[q] = e[q]; c.s += Lr; c.s2 += Lr; return c; }));
    var base = ev[k0].slot != null ? ev[k0].slot : h01(seed, hash32(String(r.id)), r.kind === "car" ? 3 : 5)*cyc;
    var P = new Profile(), hold = null, stopsT = [];
    P.cur.s = s0; P.cur.v = order[0].v;
    for(i = 0; i <= order.length; i++){
      var e = i < order.length ? order[i] : {s: s0 + Lr, v: order[0].v, close: true};
      if(i > 0){
        var Lm = Math.max(0, e.s - P.cur.s), D = fastest(Lm, P.cur.v, e.v, spec.vmax, spec.acc).T, m = e.close ? HB : cyc;
        var target = e.close ? 0 : e.slot != null ? e.slot - base : null;
        var slack = target != null ? mod(target - (P.cur.t + D), m) : 0;
        if(slack > m - 1e-6) slack = 0;
        if(e.close && pad && !pad.stop) slack += pad.t;
        if(hold && slack > 0){ P.cur.t += slack; hold.dep += slack; slack = 0; }
        P.segment(Lm, e.v, D + slack, spec);
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
        if(e.s2 > e.s){ P.cur.v = e.v; P.piece((e.s2 - e.s)/e.v, 0); P.cur.s = e.s2; }
      }
    }
    P.T = P.cur.t; P.L = Lr; P.s0 = s0; P.base = base;
    P.stops = stopsT;
    return P;
  }
  // min over the lap of S(t) - S(t - shift): the closest two vehicles shift seconds apart come
  function minGap(P, shift){
    var best = Infinity, a = {}, b = {};
    for(var t = 0; t < P.T; t += 0.2){ var d = P.S(t, a).s - P.S(t - shift, b).s; if(d < best) best = d; }
    return best;
  }
  rings.forEach(function(r){ r.prof = profileOf(r, SPEC.car); });

  // ---- transit windows: per node, each colour placed where it blocks the fewest ring residues ----
  // Colours go widest first, each on a half-second grid of the long cycle, never over a window
  // already placed at the node; a window in a gap between the clashing car windows costs nothing.
  function ov(a, la, b, lb){ return mod(b - a, HB) < la || mod(a - b, HB) < lb; }
  var FULL = (1 << REPS) - 1;
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
      var w = N.twidths[c]*scale, best = null, bestC = Infinity, bestAdd = null;
      for(var j = 0, J = Math.ceil(HB*2); j < J; j++){
        var s0 = mod(rot + j/2, HB), cost = 0, add = {};
        if(scale >= 1 && placed.some(function(q){ return ov(s0, w, q[0], q[1]); })) continue;
        hits[c].forEach(function(h){
          for(var rho = 0; rho < REPS; rho++) if(ov(mod(h[1] + rho*H, HB), h[2], s0, w)) add[h[0]] = (add[h[0]] || 0) | (1 << rho);
        });
        Object.keys(add).forEach(function(rid){
          var was = rings[rid].blocked, now = was | add[rid];
          if(now !== was) cost += now === FULL ? 100 : 1;
        });
        if(cost < bestC){ bestC = cost; best = s0; bestAdd = add; }
      }
      if(best == null){
        // no room left in the cycle (overfull): straight after the last window
        var q = placed[placed.length - 1];
        best = q ? mod(q[0] + q[1], HB) : rot; bestAdd = {};
        hits[c].forEach(function(h){
          for(var rho = 0; rho < REPS; rho++) if(ov(mod(h[1] + rho*H, HB), h[2], best, w)) bestAdd[h[0]] = (bestAdd[h[0]] || 0) | (1 << rho);
        });
      }
      Object.keys(bestAdd).forEach(function(rid){ rings[rid].blocked |= bestAdd[rid]; });
      win[c] = [best, w]; placed.push(win[c]);
    });
    N.tr.forEach(function(tp){ tp.slot = win[tp.colour][0]; });
    N.twin = win;
  });

  // ---- cars in their slots, transit vehicles a headway apart ----
  var cars = [], totalSlots = 0;
  rings.forEach(function(r){
    var m = Math.round(r.prof.T/H), G = SPEC.car.len + GAP, k = 1, cand = [], last = -Infinity;
    while(k < m && minGap(r.prof, k*H) < G) k++;
    r.k = k; r.m = m; r.cars = [];
    if(r.pl.len < 2*G) return;
    for(var i = 0; i < m; i++){
      if((r.blocked >> (i % REPS)) & 1 || i - last < k || (cand.length && m + cand[0] - i < k)) continue;
      cand.push(i); last = i;
    }
    r.cand = cand;
    cand.forEach(function(i){
      totalSlots++;
      // with a city, every slot the rush could fill has its car (shown or not, lap by lap: see present())
      var u = h01(seed, r.id*977 + 11, i);
      if(u >= (city ? Math.min(DENS_TOP, dens*RUSH_K[1]) : dens)) return;
      var c = {id: "c" + r.id + "." + i, ring: r, kind: "car", shift: i*H, paint: Math.floor(h01(seed, r.id, i*31 + 5)*PAINT.length), slot: i};
      if(city) c.u = u;
      r.cars.push(c); cars.push(c);
    });
  });
  // Patrol cars and vans ride the rings too (the longest first, one vehicle a ring in turn), each in a free
  // slot, so they keep the rings' guarantees; the j-th of a kind shows while the city has more than j out
  if(city){
    var svcRings = rings.filter(function(r){ return r.cand && r.cand.length; }).sort(function(a, b){ return b.pl.len - a.pl.len || a.id - b.id; }), svcN = 0;
    ["police", "van"].forEach(function(kind){
      for(var j = 0; j < RING_SVC[kind] && svcRings.length; j++, svcN++){
        // a free slot (seeded), else the slot of the car the rush shows least (the car leaves the ring)
        var r = svcRings[svcN % svcRings.length], free = r.cand.filter(function(i){ return !r.cars.some(function(c){ return c.slot === i; }); });
        var i = free.length ? free[Math.floor(h01(seed, r.id*31 + 7, svcN)*free.length)] : null;
        if(i == null){
          var top = null;
          r.cars.forEach(function(c){ if(c.u != null && (!top || c.u > top.u)) top = c; });
          if(!top) continue;
          i = top.slot; r.cars.splice(r.cars.indexOf(top), 1); cars.splice(cars.indexOf(top), 1);
        }
        var v = {id: (kind === "police" ? "p" : "v") + r.id + "." + i, ring: r, kind: kind, shift: i*H, slot: i, svc: j};
        if(kind === "van") v.paint = Math.floor(h01(seed, r.id, i*31 + 9)*VAN_PAINT.length);
        r.cars.push(v);
        r.cars.sort(function(a, b){ return a.slot - b.slot; });
      }
    });
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
    var DT = 0.1, n = Math.ceil((u1 - u0)/DT), on = {}, first = 0;
    // (per step: the keys the body is on are stamped with the step, not gathered in a new object; the block
    // keys' strings are made once each; the running stretches are kept in the order they began)
    var stamp = {}, hit = [], runKeys = [], names = {};
    function name(K, bk, bay){ var c = names[K.k] || (names[K.k] = {}), j = bay ? "~" + bk : bk; return c[j] || (c[j] = K.k + "/" + bk + (bay ? "~" : "")); }
    function mark(key, k){ if(stamp[key] !== k){ stamp[key] = k; hit.push(key); } }
    // an open route is only looked at from a step before it nears its first lane that holds anything (the
    // first time it reaches that, as timeAt) until it is past the last one with nothing running
    var k0 = 0, sEnd = Infinity;
    if(r.open){
      var sA = Infinity; sEnd = -Infinity;
      r.ranges.forEach(function(rg, i){ if(keys[i].length){ sA = Math.min(sA, rg[0] - h); sEnd = Math.max(sEnd, rg[1] + h); } });
      if(!(sA < Infinity)) return out;
      if(prof.at(u1, o).s < sA) return out;
      var lo = u0, hi = u1;
      if(prof.at(u0, o).s < sA){ for(var it = 0; it < 40; it++){ var mid = (lo + hi)/2; if(prof.at(mid, o).s >= sA) hi = mid; else lo = mid; } k0 = Math.max(0, Math.floor((lo - u0)/DT) - 1); }
    }
    for(var k = k0; k <= n; k++){
      var u = Math.min(u1, u0 + k*DT), sNow = (r.open ? prof.at(u, o) : prof.S(u, o)).s, sm = r.open ? sNow : mod(sNow, Lr), lat = -1;
      hit.length = 0;
      // an open route only goes forward: the ranges wholly behind the body are passed for good
      // (and the ranges run in order along s: the look stops at the first one wholly ahead of it)
      if(r.open) while(first < r.ranges.length - 1 && r.ranges[first][1] < sm - h) first++;
      for(var i = r.open ? first : 0; i < r.ranges.length; i++){
        var rg = r.ranges[i];
        if(r.open && rg[0] > sm + h) break;
        if(!keys[i].length) continue;
        for(var w = r.open ? 0 : -1; w <= (r.open ? 0 : 1); w++){
          var x = sm - w*Lr;
          if(rg[0] > x + h || rg[1] < x - h) continue;
          var lo = Math.max(rg[0], x - h) - rg[0] + rg[2], hi = Math.min(rg[1], x + h) - rg[0] + rg[2];
          if(lat < 0) lat = bayLat(r, sm);
          for(var q = 0; q < keys[i].length; q++){
            var K = keys[i][q];
            // on the other track of a crossover the place is mirrored (to within a block)
            var a = K.mir != null ? K.mir - hi : lo, b = K.mir != null ? K.mir - lo : hi, m = K.mir != null ? 1 : 0, bk;
            // in the lane unless wholly in a lay-by; in the strip of lay-bys beside it (finer blocks) once
            // far enough over to reach a bus parked there
            if(lat < BAY - 0.05) for(bk = Math.floor(a/BLOCK) - m; bk <= Math.floor(b/BLOCK) + m; bk++) mark(name(K, bk, false), k);
            if(lat > BAY - SPEC.bus.wid - 0.15) for(bk = Math.floor(a/BAY_BLOCK); bk <= Math.floor(b/BAY_BLOCK); bk++) mark(name(K, bk, true), k);
          }
        }
      }
      for(q = 0; q < hit.length; q++){ var hk = hit[q]; if(run[hk] == null){ run[hk] = u; runKeys.push(hk); } on[hk] = u; }
      var keep = 0;
      for(q = 0; q < runKeys.length; q++){
        var rk = runKeys[q];
        if(stamp[rk] !== k || k === n){ (out[rk] = out[rk] || []).push([run[rk] - DT - 0.1, on[rk] + DT + 0.1]); delete run[rk]; }
        else runKeys[keep++] = rk;
      }
      runKeys.length = keep;
      if(!keep && sm > sEnd) break;
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
  // (pen: the cost factor on a road whose emergency lane is the tram track or the bus lane, for a way round them)
  function dijkstra(src, avoid, pen){
    var dist = {}, prev = {}, heap = [[0, src]], done = {};
    dist[src] = 0;
    while(heap.length){
      var top = heap[0], last = heap.pop();
      if(heap.length){ heap[0] = last; siftDown(heap, 0); }
      var u = top[1];
      if(done[u]) continue;
      done[u] = 1;
      nodes[u].inc.forEach(function(i){
        var E = edges[i], v = E.a === u ? E.b : E.a, d = top[0] + E.len*(pen && E.evKind ? pen : 1);
        if(!E.ev || (avoid != null && (typeof avoid === "object" ? avoid[v] : v == avoid))) return;
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
  // an emergency-lane route's passes, with the movements each must not share its box with
  // (a movement's clashes kept by its swept path: the same turn on another run clashes the same)
  var againstCache = {}, againstKeys = [];
  function prepRun(R, kind, id){
    R.kind = kind; R.id = id; R.ev = true;
    R.passes.forEach(function(p){
      p.route = R; p.transit = true;
      var c = p.curve, a = c[0], b = c[c.length - 1], key = [p.node, kind, c.length, a[0].toFixed(3), a[2].toFixed(3), b[0].toFixed(3), b[2].toFixed(3),
                                                           c[c.length >> 1][0].toFixed(3), c[c.length >> 1][2].toFixed(3), (p.sOut - p.sIn).toFixed(3)].join(",");
      if(!againstCache.hasOwnProperty(key)){
        againstCache[key] = (atNode[p.node] || []).filter(function(q){ return clash(p, q); }); againstKeys.push(key);
        if(againstKeys.length > 2000) delete againstCache[againstKeys.shift()];
      }
      p.against = againstCache[key];
    });
    return R;
  }
  function evLanes(chain){ return chain.map(function(c){ return {e: c.e, dir: c.dir, off: c.e.evOff}; }); }
  function planRun(w, kind, st, tgt, chain){
    var spec = SPEC[kind], out = route(evLanes(chain), spec, true);
    var back = route(evLanes([chain[chain.length - 1]].concat(chain.slice().reverse().map(function(c){ return {e: c.e, dir: 1 - c.dir}; }))), spec, true);
    [out, back].forEach(function(R){ prepRun(R, kind, "e" + w); });
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
  // lead (a chaser): {t: [the clock its leader reaches each pass's line, or null], q: [how far short of that
  // line it waits: behind where the leader waits], r: [the clock the leader leaves where it waits], len: the
  // leader's length}: the chaser comes no nearer than q before r, and enters the box only once the leader is
  // a body and GAP into it
  function runProfile(R, spec, t0, sFrom, sTo, lead){
    var P = new Profile();
    P.cur.s = sFrom;
    for(var i = 0; i < R.passes.length; i++){
      var p = R.passes[i];
      if(p.sIn < sFrom) continue;
      var Lm = p.sIn - P.cur.s, Lt = lead ? lead.t[i] : null, q = Lt != null ? lead.q[i] : 0;
      if(Lt != null && Lm > q + 0.5){
        var L1 = Lm - q, D1 = fastest(L1, P.cur.v, p.v, spec.vmax, spec.acc).T;
        P.segment(L1, p.v, Math.max(D1, lead.r[i] - t0 - P.cur.t), spec);
        Lm = q;
      }
      var D = fastest(Lm, P.cur.v, p.v, spec.vmax, spec.acc).T, tA = t0 + P.cur.t + D;
      var tF = boxFree(p, Lt != null ? Math.max(tA, Lt + (lead.len + GAP + 1)/p.v) : tA);
      if(tF == null){ R.stuck = p.node; return null; }
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
        var r = q.route, vs = r.kind === "car" ? r.cars : r.vehicles, T = r.prof.T;
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
    return o;
  }

  // ---- the city's runs (o.city: games/citysim.js's event director) ----
  // With a city the seeded windows above are off: every unit of the city's events (fire engines, ambulances,
  // police, tow trucks, market vans, school buses, the getaway car) drives its own trip on the emergency
  // lanes, from its home node (unit.home) to where it goes (unit.node), parks short of that box until the
  // event's time to leave (unit.leave; an ambulance then takes its patient to ev.dest and stands there until
  // unit.drop + 120 s) and drives home. A trip is planned once per event, as a pure function of the event,
  // the same way as a seeded run: each box when nothing that clashes is in it, each leg when it misses every
  // tram and bus (2 s later at a time), and never into an earlier unit of the same event (units waiting at
  // one place park in a line, a body and GAP apart). A unit that never misses the trams and buses on the
  // shortest way goes the way that keeps off their lanes (TRANSIT_PEN); one that still cannot fit is left out. Units of different
  // events are not checked against each other (they rarely meet; they would pass through).
  // A robbery is a chase: the getaway car flees along ev.route (its emergency-lane part; the shortest way on
  // where the route takes a road too narrow) to the roadblock, the road carried on until its last stretch
  // holds the car and its chasers off the tram track and bus lane; each police car comes from its station
  // timed to pass the scene unit.lag s behind it, with lights and siren, and stops in line behind it; after
  // the arrest (unit.leave, at least ARREST_MIN s) the getaway car is gone and the police drive home.
  // Patrols and delivery rounds are on the rings (above), as many as the city has out.
  var dijCache = {}, dijKeys = [];
  function dij(src){
    var k = "n" + src;
    if(dijCache.hasOwnProperty(k)) return dijCache[k];
    dijCache[k] = dijkstra(src); dijKeys.push(k);
    if(dijKeys.length > 24) delete dijCache[dijKeys.shift()];
    return dijCache[k];
  }
  // the tree the trip being planned uses: around the boxes it got stuck at (avoid), if any, and off the tram
  // track and bus lanes where it can (penal: TRANSIT_PEN, when no plan on the shortest way fits the trams and buses)
  var avoid = null, penal = 0;
  function tree(src){ return avoid || penal ? dijkstra(src, avoid, penal) : dij(src); }
  // the lanes from src to tgt on a Dijkstra tree from src (null when tgt is not reached)
  function chainOf(Dj, src, tgt){
    var chain = [], v = tgt;
    if(Dj.dist[tgt] == null) return null;
    while(v != src){ var pv = Dj.prev[v]; if(!pv) return null; chain.unshift({e: pv.e, dir: pv.e.a == pv.u ? 0 : 1}); v = pv.u; }
    return chain;
  }
  function sec(ms, d){ return num(ms, num(d, 0))/1000; }
  function laneKey(ln){ return ln.e.i*2 + ln.dir; }
  function laneLen(ln){ return len2(lanePts(ln.e, ln.dir, ln.e.evOff)); }
  // a node on the emergency lanes: n itself, else the nearest one that is (a station on a road whose car
  // lanes fill it sends its units out from there)
  function evNode(n){
    if(n == null || !nodes[n]) return null;
    if(nodes[n].inc.some(function(i){ return edges[i].ev; })) return n;
    var N = nodes[n], best = null, bd = Infinity;
    nodeIds.forEach(function(id){
      var M = nodes[id];
      if(!M.inc.some(function(i){ return edges[i].ev; })) return;
      var d = Math.hypot(M.x - N.x, M.z - N.z);
      if(d < bd){ bd = d; best = id; }
    });
    return best;
  }
  function homeOf(u){
    var s = u.station != null ? sites[u.station] : null;
    if(u.home != null && nodes[u.home] && nodes[u.home].inc.length) return evNode(u.home);
    return s ? evNode(nearestNode(s.x, s.z)) : null;
  }
  // where a unit can get to from `from` for node n: n, else the reachable node nearest it
  function reach(from, n){
    var Dj = dij(from), N = nodes[n], best = null, bd = Infinity;
    if(!N || Dj.dist[n] != null) return N ? n : null;
    Object.keys(Dj.dist).forEach(function(id){
      var M = nodes[id], d = Math.hypot(M.x - N.x, M.z - N.z);
      if(d < bd - 1e-9 || (Math.abs(d - bd) <= 1e-9 && String(id) < String(best))){ bd = d; best = id; }
    });
    return best != null ? nodes[best].id : null;
  }
  // the way from `from` to `to`; a unit that will wait there arrives on a lane off the tram track and
  // bus lane when one meets the node (by the far end of that lane, never through `to` itself)
  function approach(from, to, wait){
    var Dj = tree(from), chain = chainOf(Dj, from, to);
    if(!chain || !chain.length || !wait || !chain[chain.length - 1].e.evKind) return chain;
    var best = null, bc = Infinity, skip = {}, k;
    for(k in avoid || {}) skip[k] = 1;
    skip[to] = 1;
    var Da = dijkstra(from, skip, penal);
    nodes[to].inc.forEach(function(i){
      var E = edges[i], far = E.a == to ? E.b : E.a;
      if(!E.ev || E.evKind || Da.dist[far] == null) return;
      var c = chainOf(Da, from, far);
      if(!c) return;
      var cost = Da.dist[far] + E.len;
      if(cost < bc - 1e-9){ bc = cost; best = c.concat([{e: E, dir: E.a == far ? 0 : 1}]); }
    });
    return best || chain;
  }
  // the way on from node `at` (arrived by lane `prev`) to `to`: out by each other road, then the shortest way,
  // the cheapest first; turning round through the box (prev's way back) last, as a busy box may never have
  // room for it. [[lanes], ...] (each after prev)
  function waysOn(prev, at, to){
    var opts = [];
    nodes[at].inc.forEach(function(i){
      var F = edges[i], far = F.a == at ? F.b : F.a;
      if(F === prev.e || !F.ev) return;
      var rest = far == to ? [] : chainOf(tree(far), far, to);
      if(rest && rest.some(function(x){ return x.e.a == at || x.e.b == at; })) rest = null;   // not back through `at`
      if(rest) opts.push({c: F.len + (far == to ? 0 : tree(far).dist[to]), lanes: [{e: F, dir: F.a == at ? 0 : 1}].concat(rest)});
    });
    opts.sort(function(x, y){ return x.c - y.c || x.lanes[0].e.i - y.lanes[0].e.i; });
    var back = chainOf(tree(at), at, to);
    if(back && back.length) opts.push({c: Infinity, lanes: back});
    return opts.map(function(x){ return x.lanes; });
  }
  // the first lap time a profile reaches s (its end when it never does)
  function timeAt(P, s){
    var lo = 0, hi = P.T, o = {};
    if(P.at(hi, o).s < s) return hi;
    for(var i = 0; i < 40; i++){ var m = (lo + hi)/2; if(P.at(m, o).s >= s) hi = m; else lo = m; }
    return hi;
  }
  // do two bodies (poses {x, z, yaw}) come within 0.3 m end on, 0.15 m side on?
  function bodiesMeet(a, sa, b, sb){
    var dx = b.x - a.x, dz = b.z - a.z;
    if(Math.hypot(dx, dz) > (sa.len + sb.len)/2 + 2) return false;
    var ax = Math.sin(a.yaw), az = Math.cos(a.yaw), bx = Math.sin(b.yaw), bz = Math.cos(b.yaw);
    var axes = [[ax, az], [az, -ax], [bx, bz], [bz, -bx]];
    for(var i = 0; i < 4; i++){
      var u = axes[i], d = Math.abs(dx*u[0] + dz*u[1]);
      var ra = Math.abs(ax*u[0] + az*u[1])*(sa.len/2 + 0.3) + Math.abs(az*u[0] - ax*u[1])*(sa.wid/2 + 0.15);
      var rb = Math.abs(bx*u[0] + bz*u[1])*(sb.len/2 + 0.3) + Math.abs(bz*u[0] - bx*u[1])*(sb.wid/2 + 0.15);
      if(d > ra + rb) return false;
    }
    return true;
  }
  // occupancy (to lap time T) carried on for `stand` s more where the body stands at the end
  function standing(occ, T, stand){
    if(!(stand > 0)) return occ;
    var out = {};
    Object.keys(occ).forEach(function(key){
      var L = occ[key].slice(), x = L[L.length - 1];
      if(x[1] >= T - 1e-6) L[L.length - 1] = [x[0], x[1] + stand];
      out[key] = L;
    });
    return out;
  }
  // a trip's pose at t: driving a leg, or parked at its end (phase `after`) until the next leg (until)
  function tripPose(pl, t, o){
    var L = pl.legs, i = L.length - 1;
    while(i > 0 && L[i].t0 > t) i--;
    var g = L[i], u = t - g.t0, moving = u >= 0 && u < g.P.T;
    o.phase = moving ? g.phase : g.after;
    o.until = moving ? null : i + 1 < L.length ? L[i+1].t0 : pl.gone;
    g.P.at(clamp(u, 0, g.P.T), o);
    var s = o.s, v = moving ? o.v : 0;
    ringPose(g.R, s, SPEC[pl.kind].wb, o);
    o.speed = v; o.s = s;
    return o;
  }
  // the first time trip pl's body meets one of others' (null: never); while both stand still it jumps
  function meetsAny(pl, others){
    var a = {}, b = {}, sa = SPEC[pl.kind];
    for(var t = pl.appear; t < pl.gone; ){
      tripPose(pl, t, a);
      // the next look: when everything stands still, when the next one sets off or appears; else as soon
      // as any two could have closed the gap between them at full speed (at least 0.25 s on)
      var jump = a.until, safe = Infinity;
      for(var j = 0; j < others.length; j++){
        var q = others[j], sq = SPEC[q.kind];
        if(t < q.appear || t >= q.gone){ if(t < q.appear) safe = Math.min(safe, q.appear - t); continue; }
        tripPose(q, t, b);
        if(bodiesMeet(a, sa, b, sq)) return t;
        jump = jump != null && b.until != null ? Math.min(jump, b.until) : null;
        safe = Math.min(safe, (Math.hypot(b.x - a.x, b.z - a.z) - (sa.len + sq.len)/2 - 1)/(sa.vmax + sq.vmax));
      }
      if(a.until != null) safe = Math.min(safe, a.until - t);
      t = jump != null && jump > t + 0.25 ? jump : t + Math.max(0.25, Math.min(safe, 30));
    }
    return null;
  }
  // plan a trip: L = [{lanes, phase, after, t (earliest start, s), off (m short of the usual stop)}], each
  // leg's lanes starting on the one the last leg stopped on; endAt: when it vanishes after its last leg
  // (tries, step: how many plans, how far each later; CITY_TRY, 2 s)
  function tripOf(id, ev, unit, kind, L, done, endAt, tries, step){
    var spec = SPEC[kind], delay = L.map(function(){ return 0; }), nTry = num(tries, CITY_TRY), dStep = num(step, 2);
    L.forEach(function(g, i){
      g.R = g.R || prepRun(route(evLanes(g.lanes), spec, true), kind, id);
      var rg = g.R.ranges, last = rg[rg.length - 1];
      g.sTo = Math.max(last[0] + spec.len/2 + 0.1, g.R.pl.len - spec.len/2 - PARK_BACK - (g.off || 0));
      g.sFrom = i ? Math.max(rg[0][0], rg[0][1] - (L[i-1].R.pl.len - L[i-1].sTo)) : num(g.from, spec.len/2 + 0.5);
      g.lastEv = !!g.lanes[g.lanes.length - 1].e.evKind;
      g.anyEv = g.lanes.some(function(ln){ return !!ln.e.evKind; });
    });
    for(var n = 0; n < nTry; n++){
      var legs = [], bad = -1, i;
      for(i = 0; i < L.length && bad < 0; i++){
        var g = L[i], t0 = Math.max(g.t, i ? legs[i-1].t0 + legs[i-1].P.T + SCENE_MIN : -Infinity) + delay[i];
        // a leg that starts when it did last try drives the same (its profile and occupancy kept)
        if(!g.memo || g.memo.t0 !== t0) g.memo = {t0: t0, P: runProfile(g.R, spec, t0, g.sFrom, Math.max(g.sFrom, g.sTo), g.lead), occ: null};
        var P = g.memo.P;
        if(!P){ bad = i; L.stuck = g.R.stuck; }
        else legs.push({R: g.R, P: P, t0: t0, phase: g.phase, after: g.after});
      }
      var gone = bad < 0 ? Math.max(legs[legs.length - 1].t0 + legs[legs.length - 1].P.T, num(endAt, 0)) : 0;
      // its time on tram tracks and bus lanes, standing at the end too when that is on one
      for(i = 0; bad < 0 && i < legs.length; i++){
        var lg = legs[i], stand = lg.t0 + lg.P.T, until = i + 1 < legs.length ? legs[i+1].t0 : gone;
        var mo = L[i].memo;
        if(!L[i].anyEv) continue;   // never on a tram track or bus lane
        if(!mo.occ) mo.occ = occupancy(lg.R, lg.P, spec, 0, lg.P.T);
        if(transitMeets(standing(mo.occ, lg.P.T, L[i].lastEv ? Math.min(until - stand, 600) : 0), lg.t0)) bad = i;
      }
      if(bad < 0){
        var pl = {id: id, ev: ev.id, unit: unit, kind: kind, legs: legs, appear: legs[0].t0, gone: gone};
        var hit = meetsAny(pl, done);
        if(hit == null) return pl;
        for(bad = legs.length - 1; bad > 0 && legs[bad].t0 > hit; bad--);
      }
      // later and later by the default step (2 s, then 4 s from the 10th try...: up to ~3 min late in all), so a
      // run that keeps catching a tram or bus can wait for the next gap in the timetable
      delay[bad] += step == null ? dStep*(1 + Math.floor(n/10)) : dStep;
      L.fail = bad;
    }
    return null;
  }
  // an event's trips, in order: the chase first, then each other unit. Planned a step at a time (planStep: the
  // chase, or one unit), so warm() can spread an event over frames; the steps run in the same order whenever
  // they run, so the trips are the same.
  function planStart(ev){
    var U = ev.units || [], P = {ev: ev, done: [], fill: {}, gi: -1, k: -1, fin: ev.kind === "patrol" || ev.kind === "delivery"};
    U.forEach(function(u, k){ if(u && u.kind === "getaway" && P.gi < 0) P.gi = k; });
    if(P.gi < 0) P.k = 0;
    return P;
  }
  function planStep(P){
    if(P.fin) return;
    var ev = P.ev, U = ev.units || [];
    if(P.k < 0){ planChase(ev, P.gi, P.done); P.k = 0; }
    else { planUnit(ev, U[P.k], P.k, P.done, P.fill, P.gi); P.k++; }
    if(P.k >= U.length) P.fin = true;
  }
  function planUnit(ev, u, k, done, fill, gi){
    (function(){
      if(!u || !SPEC[u.kind] || u.kind === "car" || u.kind === "bus" || u.kind === "tram" || k === gi || (gi >= 0 && u.kind === "police" && u.lag != null)) return;
      var home = homeOf(u), scene = u.node != null && nodes[u.node] ? u.node : ev.node, kind = u.kind, spec = SPEC[kind];
      if(home == null || scene == null || !nodes[scene]) return;
      scene = reach(home, scene);
      var dest = u.drop != null && ev.dest != null && sites[ev.dest] ? reach(home, nearestNode(sites[ev.dest].x, sites[ev.dest].z)) : null;
      if(scene == null) return;
      if(dest == scene) dest = null;
      var stops = [{node: scene, phase: "responding", after: "onscene", t: sec(u.dispatch, ev.start)}];
      if(dest != null) stops.push({node: dest, phase: "transport", after: "drop", t: sec(u.leave)});
      stops.push({node: home, phase: "returning", after: "home", t: dest != null ? sec(u.drop) + 120 : sec(u.leave)});
      // the legs, leaving each stop by its m-th way on (the next when a plan does not fit)
      function legsOf(m){
        var L = [], cur = home, prev = null, ok = true, more = false;
        L.endAt = null;
        stops.forEach(function(st, i){
          if(!ok) return;
          var last = i === stops.length - 1;
          if(st.node == cur){ if(last && L.length) L.endAt = Math.max(st.t, 0); return; }
          var chain;
          if(prev){ var ways = waysOn(prev, cur, st.node); chain = ways[Math.min(m, ways.length - 1)]; if(ways.length > m + 1) more = true; }
          else chain = approach(cur, st.node, !last);
          if(!chain || !chain.length){ ok = false; return; }
          // to wait, it stops short: at the end of the last lane on the way that is off the tram track and bus lane
          if(!last && chain[chain.length - 1].e.evKind){
            for(var j = chain.length - 1; j >= 0 && chain[j].e.evKind; j--);
            if(j >= 0) chain = chain.slice(0, j + 1);
          }
          var lanes = (prev ? [prev] : []).concat(chain), key = laneKey(chain[chain.length - 1]);
          L.push({lanes: lanes, phase: st.phase, after: st.after, t: st.t, off: last ? 0 : fill[key] || 0, key: last ? null : key});
          prev = chain[chain.length - 1]; cur = prev.dir ? prev.e.a : prev.e.b;
        });
        L.more = more;
        return ok ? L : [];
      }
      // a trip stuck at a box (no room ever for its movement) goes round that node, up to AVOID_MAX times; one
      // that never misses the trams and buses on the shortest way goes the way that keeps off their lanes
      var pl = null, L = [], L0 = null;
      for(var pass = 0; pass < 2 && !pl; pass++){
        var av = {};
        penal = pass ? TRANSIT_PEN : 0;
        for(var r = 0; r <= AVOID_MAX && !pl; r++){
          avoid = r ? av : null;
          for(var m = 0; m < 3 && !pl; m++){
            L = legsOf(m);
            if(!L.length) break;
            pl = tripOf(ev.id + "/" + k, ev, k, kind, L, done, L.endAt);
            if(!L.more || L.fail === 0) break;   // another way on changes nothing before the first stop
          }
          if(pl || L.stuck == null || av[L.stuck] || L.stuck == home || L.stuck == scene) break;
          av[L.stuck] = 1;
        }
        if(!pass) L0 = L;
      }
      avoid = null; penal = 0;
      if(!pl && L0 && L0.length && !(L.length && L.fail > 0)) L = L0;
      // a stop it can never leave (a box with no room for its way out): it ends there at its time to go
      while(!pl && L.fail > 0){
        var cut = L.slice(0, L.fail);
        pl = tripOf(ev.id + "/" + k, ev, k, kind, cut, done, Math.max(L[L.fail].t, 0));
        L.fail = cut.fail; L = cut;
      }
      if(!pl) return;
      L.forEach(function(g){ if(g.key != null) fill[g.key] = g.off + spec.len + GAP; });
      done.push(pl);
    })();
  }
  // the chase: the getaway car's lanes from the scene along ev.route to its roadblock
  function chaseChain(ev, scene, block){
    var path = (ev.route || []).slice(), chain = [], cur = scene;
    if(path.length && path[0] != scene) path.unshift(scene);
    for(var i = 1; i < path.length; i++){
      var eb = edgeBetween(path[i-1], path[i]);
      if(!eb || !eb.e.ev || !nodes[path[i]]) break;
      chain.push({e: eb.e, dir: eb.dir}); cur = path[i];
    }
    var end = block != null && nodes[block] ? block : path.length ? path[path.length - 1] : scene;
    if(cur != end){ var rest = chainOf(dij(cur), cur, end); if(rest) chain = chain.concat(rest); }
    return chain;
  }
  // carried on (the longest road on each time) until its last lane holds `need` m off the tram track and bus lane
  function extendChase(chain, need){
    for(var k = 0; k < 4 && chain.length; k++){
      var ln = chain[chain.length - 1], E = ln.e, at = ln.dir ? E.a : E.b, best = null;
      if(!E.evKind && laneLen(ln) >= need) break;
      nodes[at].inc.forEach(function(i){
        var F = edges[i];
        if(F === E || !F.ev) return;
        if(!best || F.len > best.len + 1e-9 || (Math.abs(F.len - best.len) <= 1e-9 && F.i < best.i)) best = F;
      });
      if(!best) break;
      chain = chain.concat([{e: best, dir: best.a == at ? 0 : 1}]);
    }
    return chain;
  }
  // a chaser's lead: when the car ahead (trip a.pl, its chase from a.cs m) reaches each box line of the chase,
  // matched in order to the chaser's way W (its chase from W.cs m)
  function leadOf(a, W){
    var g = a.pl.legs[0], mine = [], theirs = [], t = [], q = [], r = [], len = SPEC[a.pl.kind].len;
    g.R.passes.forEach(function(p, i){
      if(p.sIn < a.cs - 1e-6) return;
      var aq = (a.lead && a.lead.q[i]) || 0;
      theirs.push([g.t0 + timeAt(g.P, p.sIn), aq, g.t0 + timeAt(g.P, p.sIn - aq + 0.5)]);
    });
    W.R.passes.forEach(function(p, i){ if(p.sIn >= W.cs - 1e-6) mine.push(i); });
    if(mine.length !== theirs.length) return null;
    mine.forEach(function(i, j){ t[i] = theirs[j][0]; q[i] = theirs[j][1] + len + GAP; r[i] = theirs[j][2]; });
    return {t: t, q: q, r: r, len: len};
  }
  // the chase along the director's route; when that never fits the trams and buses (the getaway car or a
  // chaser left out), along the way to the same roadblock that keeps off their lanes, if that fits more
  function planChase(ev, gi, done){
    var base = done.length, want = 1;
    ev.units.forEach(function(u){ if(u && u.kind === "police" && u.lag != null) want++; });
    chaseOn(ev, gi, done, 0);
    var n = done.length - base;
    if(n >= want) return;
    var keep = done.splice(base);
    penal = TRANSIT_PEN;
    try { chaseOn(ev, gi, done, TRANSIT_PEN); } finally { penal = 0; }
    if(done.length - base > n) return;
    done.splice(base);
    keep.forEach(function(pl){ done.push(pl); });
  }
  function chaseOn(ev, gi, done, pen){
    var U = ev.units, g = U[gi], gs = SPEC.getaway, ps = SPEC.police, scene = evNode(ev.node), cops = [];
    if(scene == null) return;
    U.forEach(function(u, k){ if(u && u.kind === "police" && u.lag != null) cops.push(k); });
    var chain = chaseChain(ev, scene, g.node);
    if(pen && chain.length){
      var endN = chain[chain.length - 1].dir ? chain[chain.length - 1].e.a : chain[chain.length - 1].e.b;
      chain = chainOf(dijkstra(scene, null, pen), scene, endN) || [];
    }
    if(!chain.length) return;
    chain = extendChase(chain, gs.len + 2 + cops.length*(ps.len + GAP) + GAP);
    var block = chain[chain.length - 1].dir ? chain[chain.length - 1].e.a : chain[chain.length - 1].e.b;
    // each chaser comes in from its station along the getaway's path
    // each chaser comes in from its station along the getaway's path, or (when that never fits the
    // trams and buses at its lag) joins at the scene, where the director has it start
    var cps = [];
    cops.forEach(function(k, j){
      var u = U[k], home = homeOf(u), appr = home == null ? null : home == scene ? [] : chainOf(tree(home), home, scene);
      var off = gs.len + GAP + cps.length*(ps.len + GAP), ways = (appr && appr.length ? [appr] : []).concat([[]]);
      cps.push({k: k, u: u, home: home != null ? home : scene, off: off, j: cps.length, lag: num(u.lag, 3 + 1.5*j), ways: ways.map(function(a){
        var lanes = a.concat(chain), R = prepRun(route(evLanes(lanes), ps, true), "police", ev.id + "/" + k);
        return {lanes: lanes, R: R, cs: R.ranges[a.length][0], sT: R.ranges[a.length][0] + ps.len/2 + 0.5, from: a.length ? ps.len/2 + 0.5 : R.ranges[0][0] + ps.len/2 + 0.5,
                sTo: Math.max(R.ranges[R.ranges.length - 1][0] + ps.len/2 + 0.1, R.pl.len - ps.len/2 - PARK_BACK - off)};
      })});
    });
    // The getaway car flees CHASE_STEP s later at a time until every chaser fits within CHASE_SLACK s of its
    // lag (its start found by a few rounds of drive, look, shift); the last try takes what fits
    var base = done.length, t1 = sec(g.dispatch, ev.start), G = null, got = [];
    for(var d = 0; d <= CHASE_TRY; d++){
      var strict = d < CHASE_TRY;
      done.splice(base); got = [];
      G = tripOf(ev.id + "/" + gi, ev, gi, "getaway", [{lanes: chain, phase: "chase", after: "caught", t: t1 + (strict ? d*CHASE_STEP : 0)}], done, 1e12, strict ? 1 : CITY_TRY);
      if(!G){ if(strict) continue; return; }
      done.push(G);
      var tf = G.legs[0].t0, ok = true, ahead = {pl: G, cs: 0};
      cps.forEach(function(c){
        var pl = null, L0 = null, want = tf + c.lag;
        for(var wi = 0; ok && !pl && wi < c.ways.length; wi++){
          var W = c.ways[wi], t0 = want - (W.sT - W.from)/ps.vmax, lead = leadOf(ahead, W);
          for(var it = 0; it < 4; it++){ var P = runProfile(W.R, ps, t0, W.from, W.sTo, lead); if(!P) break; t0 += want - (t0 + timeAt(P, W.sT)); }
          L0 = {lanes: W.lanes, R: W.R, phase: "chase", after: "onscene", t: t0, off: c.off, from: W.from, lead: lead, cs: W.cs};
          pl = tripOf(ev.id + "/" + c.k, ev, c.k, "police", [L0], done, 1e12, strict ? CHASE_SLACK/0.5 : CITY_TRY, 0.5);
        }
        if(!pl){ if(strict) ok = false; return; }
        got.push({c: c, L0: L0, t0: pl.legs[0].t0, end: pl.legs[0].t0 + pl.legs[0].P.T});
        done.push(pl);
        ahead = {pl: pl, cs: L0.cs, lead: L0.lead};
      });
      if(ok) break;
    }
    // the arrest: the getaway car is gone when the first police car leaves; then they drive home in turn
    var arrive = G.legs[0].t0 + G.legs[0].P.T;
    got.forEach(function(x){ arrive = Math.max(arrive, x.end); });
    var leave = Math.max(arrive + ARREST_MIN, sec(g.leave, 0));
    done.splice(base + 1);
    G.gone = leave;
    got.forEach(function(x, j){
      var ways = x.c.home == block ? [] : waysOn(chain[chain.length - 1], block, x.c.home), pl = null;
      for(var m = 0; !pl && m < Math.max(1, Math.min(3, ways.length)); m++){
        var L = [{lanes: x.L0.lanes, R: x.L0.R, phase: "chase", after: "onscene", t: x.t0, off: x.c.off, from: x.L0.from, lead: x.L0.lead}];
        if(ways[m]) L.push({lanes: [chain[chain.length - 1]].concat(ways[m]), phase: "returning", after: "home", t: leave + LEAVE_STEP*j});
        pl = tripOf(ev.id + "/" + x.c.k, ev, x.c.k, "police", L, done, L.length > 1 ? 0 : leave + LEAVE_STEP*j);
      }
      // no way home that fits: it ends at the roadblock when it would leave
      if(!pl && ways.length) pl = tripOf(ev.id + "/" + x.c.k, ev, x.c.k, "police", L.slice(0, 1), done, leave + LEAVE_STEP*j);
      if(pl) done.push(pl);
    });
  }
  // the events with units out around t: every one overlapping the last CITY_TAIL s (a trip can run on a
  // little past its event), listed once per CITY_BUCKET s
  var cityList = {b: null, list: []}, planCache = {}, planKeys = [];
  function cityEvents(t){
    var b = Math.floor(t/CITY_BUCKET);
    if(cityList.b === b) return cityList.list;
    var t0 = b*CITY_BUCKET, t1 = t0 + CITY_BUCKET, seen = {}, list = [];
    function add(ev){
      if(!ev || ev.id == null || seen[ev.id] || !ev.units || !ev.units.length || ev.kind === "patrol" || ev.kind === "delivery") return;
      seen[ev.id] = 1; list.push(ev);
    }
    if(typeof city.events === "function") (city.events((t0 - CITY_TAIL)*1000, (t1 + CITY_AHEAD)*1000) || []).forEach(add);
    if(typeof city.unitsAt === "function") (city.unitsAt(t0*1000) || []).forEach(function(x){ add(x && x.ev); });
    list.sort(function(a, c){ return String(a.id) < String(c.id) ? -1 : String(a.id) > String(c.id) ? 1 : 0; });
    cityList = {b: b, list: list};
    return list;
  }
  // an event's plan (planStart), kept for the last 96 events
  function planOf(ev){
    var key = "v" + ev.id;
    if(planCache.hasOwnProperty(key)) return planCache[key];
    planCache[key] = planStart(ev); planKeys.push(key);
    if(planKeys.length > 96) delete planCache[planKeys.shift()];
    return planCache[key];
  }
  function eventTrips(ev){
    var P = planOf(ev);
    while(!P.fin) planStep(P);
    return P.done;
  }
  function needed(ev, t){ return num(ev.start, 0)/1000 - CITY_AHEAD/2 <= t; }
  // an event is planned (whatever is left of it) when its units could be out (a chaser sets off before the
  // start); before that warm() plans it a step at a time while it is coming up
  function cityTrips(t){
    var out = [];
    cityEvents(t).forEach(function(ev){
      if(!needed(ev, t)) return;
      eventTrips(ev).forEach(function(pl){ if(t >= pl.appear && t < pl.gone) out.push(pl); });
    });
    return out;
  }
  // Plan steps of the events around timeMs (those needed now first, then those coming up within CITY_AHEAD s,
  // each by its start) until budgetMs of wall time is spent (a step is never cut: one may run over it): called
  // once a frame, it keeps at() from planning a whole event on the frame it is first needed. now: only those
  // needed now (before the first frame). -> true when nothing is left. Only when (not what) is planned depends
  // on the clock.
  function nowMs(){ return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now(); }
  function warm(timeMs, budgetMs, now){
    if(!city) return true;
    var t = num(timeMs, 0)/1000, t0 = nowMs(), lim = budgetMs === Infinity ? Infinity : num(budgetMs, 2);
    var list = cityEvents(t).filter(function(ev){ var key = "v" + ev.id; return (!now || needed(ev, t)) && (!planCache.hasOwnProperty(key) || !planCache[key].fin); });
    list.sort(function(a, b){ return (needed(b, t) - needed(a, t)) || num(a.start, 0) - num(b.start, 0) || (String(a.id) < String(b.id) ? -1 : 1); });
    for(var i = 0; i < list.length; i++){
      var P = planOf(list[i]);
      while(!P.fin){ if(nowMs() - t0 >= lim) return false; planStep(P); }
    }
    return true;
  }
  // the city's units at t as at() lists them: lights and siren on the way in, lights on scene, neither home
  function cityAt(t){
    return cityTrips(t).map(function(pl){
      var o = tripPose(pl, t, {id: pl.id, kind: pl.kind}), moving = o.until == null;
      o.ev = pl.ev;
      o.siren = !!(SIREN[pl.kind] && moving && o.phase !== "returning");
      o.lights = !!((SIREN[pl.kind] || pl.kind === "tow") && !o.siren && o.phase !== "returning" && o.phase !== "home");
      o.yield = o.siren || (pl.kind === "getaway" && moving);
      return o;
    });
  }
  // the city's clock per CLOCK_BUCKET s: the rush, and how many patrol cars and delivery vans are out
  var clockCache = {}, clockKeys = [];
  function cityClock(ts){
    var b = Math.floor(ts/CLOCK_BUCKET), key = "k" + b;
    if(clockCache.hasOwnProperty(key)) return clockCache[key];
    var ms = b*CLOCK_BUCKET*1000, st = typeof city.at === "function" ? city.at(ms) || {} : {}, c = {rush: clamp(num(st.rush, 0), 0, 1), police: 0, van: 0};
    if(typeof city.active === "function") (city.active(ms) || []).forEach(function(ev){
      var kind = ev && ev.kind === "patrol" ? "police" : ev && ev.kind === "delivery" ? "van" : null;
      if(kind) (ev.units || []).forEach(function(u){ if(u && u.kind === kind && ms >= num(u.dispatch, 0) && ms < num(u.back, 0)) c[kind]++; });
    });
    clockCache[key] = c; clockKeys.push(key);
    if(clockKeys.length > 64) delete clockCache[clockKeys.shift()];
    return c;
  }
  // is a ring vehicle out on its current lap? (decided at the lap's start, at its first slotted box)
  function present(r, veh, t){
    var k = Math.floor((t - r.prof.base - veh.shift)/r.prof.T), c = cityClock(r.prof.base + veh.shift + k*r.prof.T);
    if(veh.svc != null) return veh.svc < c[veh.kind];
    return veh.u < Math.min(DENS_TOP, dens*(RUSH_K[0] + (RUSH_K[1] - RUSH_K[0])*c.rush));
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
    var evs = city ? cityAt(t) : activeIncidents(t).map(function(I){ return evPose(I, t, {id: I.id, kind: I.kind}); });
    function near(b){ return cx >= b[0] - rad - 30 && cx <= b[2] + rad + 30 && cz >= b[1] - rad - 30 && cz <= b[3] + rad + 30; }
    function run(r, list, spec){
      var anyLag = false, st = [];
      if(!near(r.box) && !hasLag(list)) return;
      list.forEach(function(veh){
        if(city && (veh.u != null || veh.svc != null) && !present(r, veh, t)){ delete lag[veh.id]; return; }
        var q = r.prof.S(t - r.prof.base - veh.shift, {}), sBase = q.s, l0 = lag[veh.id] || 0, l = l0;
        if(obs || l > 0){
          var gapAhead = obs ? obstacleNeed(r, sBase - l, q.v, spec.wid, spec.len, obs) : null;
          // brake smoothly to a stop 1.2 m short of it; once clear, ease back onto the timetable
          if(gapAhead != null) l += (q.v - q.v*smooth((gapAhead - 1.2)/BRAKE))*dt;
          else if(l > 0) l = Math.max(0, l - Math.min(CATCH_MAX*dt, l*ease(CATCH, dt)));
          if(l > 0) anyLag = true;
        }
        st.push({veh: veh, s: sBase - l, sBase: sBase, v: q.v, l: l, l0: l0});
      });
      // nobody drives into the vehicle they follow: slot order is road order (unwrapped s), the
      // first vehicle follows the last one a lap ahead
      if(anyLag && st.length > 1){
        var G = spec.len + GAP, Lr = r.pl.len;
        for(var pass = 0; pass < 2; pass++) for(var i = 0; i < st.length; i++){
          var me = st[i], lead = i ? st[i-1].s : st[st.length - 1].s + Lr, gap = lead - me.s;
          if(gap < G){ me.s -= G - gap; me.l += G - gap; }
        }
      }
      st.forEach(function(x){
        var id = x.veh.id;
        if(x.l > 1e-4) lag[id] = x.l; else delete lag[id];
        var p = ringPose(r, x.s, spec.wb, {});
        var d = Math.hypot(p.x - cx, p.z - cz);
        if(d > rad) return;
        var v = {id: id, kind: x.veh.kind, x: p.x, y: p.y, z: p.z, yaw: p.yaw, speed: dt > 0 ? Math.max(0, x.v - (x.l - x.l0)/dt) : x.v, d: d};
        if(r.kind === "car"){
          if(x.veh.kind === "car") v.paint = PAINT[x.veh.paint];
          else if(x.veh.kind === "van") v.paint = VAN_PAINT[x.veh.paint];
          else { v.patrol = true; v.siren = false; }
          var room = roomAt(r, x.s), pull = 0;
          if(room > 0) evs.forEach(function(e){ if(e.speed > 0.5 && e.yield !== false) pull = Math.max(pull, room*smooth((EV_YIELD - Math.hypot(e.x - p.x, e.z - p.z))/15)); });
          if(pull > 0){ v.x += -Math.cos(p.yaw)*pull; v.z += Math.sin(p.yaw)*pull; v.pull = pull; }
        } else {
          v.line = r.id;
          if(x.veh.kind === "tram") v.parts = sections(spec).map(function(sc){ var tp = partPose(r, x.s, sc[0], spec.wb, {}); return {x: tp.x, y: tp.y, z: tp.z, yaw: tp.yaw}; });
        }
        out.push(v);
      });
    }
    // how far a car may pull over at s: its lane's room, easing to nothing over PULL_TAPER m toward
    // either end of the lane, so a car is back in line before it turns through a box
    function roomAt(r, s){
      var Lr = r.pl.len, sm = mod(s, Lr), R = r.ranges, lo = 0, hi = R.length - 1;
      while(lo < hi){ var mid = (lo + hi + 1) >> 1; if(R[mid][0] <= sm) lo = mid; else hi = mid - 1; }
      var rg = R[lo];
      if(sm < rg[0] || sm > rg[1]) return 0;
      return (r.lanes[lo].room || 0)*smooth(Math.min(sm - rg[0], rg[1] - sm)/PULL_TAPER);
    }
    function hasLag(list){ for(var i = 0; i < list.length; i++) if(lag[list[i].id]) return true; return false; }
    rings.forEach(function(r){ if(r.cars.length) run(r, r.cars, SPEC.car); });
    lines.forEach(function(r){ run(r, r.vehicles, SPEC[r.kind]); });
    evs.forEach(function(e){
      var d = Math.hypot(e.x - cx, e.z - cz);
      if(d > rad) return;
      if(!city) out.push({id: e.id, kind: e.kind, x: e.x, y: e.y, z: e.z, yaw: e.yaw, speed: e.speed, d: d, siren: true});
      else out.push({id: e.id, kind: e.kind, x: e.x, y: e.y, z: e.z, yaw: e.yaw, speed: e.speed, d: d, siren: e.siren, lights: e.lights, ev: e.ev, phase: e.phase});
    });
    out.sort(function(a, b){ return a.d - b.d || (a.id < b.id ? -1 : 1); });
    return out;
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
    tier: tier, grow: grow, H: H, at: at, warm: warm, stopsNear: stopsNear, nextArrival: nextArrival, rideTo: rideTo,
    onFare: function(fn){ fareHook = typeof fn === "function" ? fn : null; },
    // the city's runs as planned so far, each {id, ev, unit (the director's objects), kind, start, end (ms: when its
    // vehicle appears on the road and is gone)}: those of every event around timeMs that has been planned (none is
    // planned here); a unit traffic could not fit has none
    cityRuns: function(timeMs){
      var out = [];
      if(!city) return out;
      cityEvents(num(timeMs, 0)/1000).forEach(function(ev){
        var key = "v" + ev.id; if(!planCache.hasOwnProperty(key)) return;
        planCache[key].done.forEach(function(pl){
          out.push({id: pl.id, ev: ev, unit: (ev.units || [])[pl.unit] || null, kind: pl.kind, start: Math.round(pl.appear*1000), end: Math.round(pl.gone*1000)});
        });
      });
      return out;
    },
    incidents: function(timeMs){
      if(city) return cityTrips(num(timeMs, 0)/1000).map(function(pl){ return {id: pl.id, kind: pl.kind, ev: pl.ev, unit: pl.unit, start: Math.round(pl.appear*1000), end: Math.round(pl.gone*1000)}; });
      return activeIncidents(num(timeMs, 0)/1000).map(function(I){ return {id: I.id, kind: I.kind, station: I.station, node: I.node, start: Math.round(I.start*1000), end: Math.round(I.end*1000)}; }); },
    lines: function(){ return lines.map(function(r){ return {id: r.id, kind: r.kind, tier: r.tier, lap: r.prof.T, headway: r.headway, vehicles: r.vehicles.length,
                                                              stops: r.prof.stops.map(function(st){ return {id: st.id, arr: st.arr, dep: st.dep}; })}; }); },
    info: function(){ return {H: H, rings: rings.length, cars: cars.length, slots: totalSlots, lines: lines.length, overfull: overfull, errors: errors.slice(), dropped: dropped,
                              slotted: Object.keys(nodeSlots).length}; },
    _: {rings: rings, lines: lines, nodeSlots: nodeSlots, atNode: atNode, edges: edges, ringPose: ringPose, lag: function(){ return lag; }}
  };
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
    } else if(kind === "tow"){
      d.push([box(2.3, 1.7, 2.2), 0xe8a020, 0, 1.45, 1.9], [box(2.32, 0.6, 1.2), 0x28323e, 0, 1.75, 2.35],
             [box(2.3, 0.35, 3.8), 0x3a3d42, 0, 0.85, -1.1], [box(0.3, 1.6, 0.3), 0x3a3d42, 0, 1.7, -0.6, 0.5],
             [box(0.25, 0.25, 2.2), 0x3a3d42, 0, 2.3, -1.6, -0.35], [box(2.1, 0.3, 0.2), 0xb8bec6, 0, 0.5, 3.0]);
      wheels(d, 0.45, 0.32, [-1.0, 1.0], [-2.0, 1.9]);
    } else if(kind === "van"){
      // white: the instance colour paints it (delivery white, post yellow or red, blue)
      d.push([box(1.95, 1.9, 3.3), 0xffffff, 0, 1.3, -0.6], [box(1.95, 1.1, 1.3), 0xffffff, 0, 0.9, 1.6], [box(1.97, 0.55, 0.9), 0x28323e, 0, 1.55, 1.45],
             [box(1.8, 0.18, 0.15), 0x2a2c30, 0, 0.4, 2.25], [box(1.8, 0.18, 0.15), 0x2a2c30, 0, 0.4, -2.25]);
      wheels(d, 0.36, 0.26, [-0.85, 0.85], [-1.5, 1.45]);
    } else if(kind === "schoolbus"){
      d.push([box(2.4, 1.3, 9), 0xf2c12e, 0, 1.1, 0], [box(2.42, 0.85, 7.6), 0x28323e, 0, 2.15, -0.4], [box(2.4, 0.35, 8.6), 0xf2c12e, 0, 2.75, -0.2],
             [box(2.42, 0.1, 9.02), 0x1c1d21, 0, 1.25, 0], [box(0.4, 0.15, 0.05), 0xfff4d0, 0.8, 0.8, 4.51], [box(0.4, 0.15, 0.05), 0xfff4d0, -0.8, 0.8, 4.51]);
      wheels(d, 0.48, 0.3, [-1.05, 1.05], [-2.8, 2.9]);
    } else {
      d.push([side([[-2.3, 0.3], [2.3, 0.3], [2.32, 0.65], [1.3, 0.85], [-2.0, 0.88], [-2.32, 0.7]], 1.86), 0x1d2c4a],
             [side([[-1.4, 0.85], [-1.0, 1.45], [0.5, 1.45], [1.1, 0.85]], 1.7), 0x28323e],
             [box(1.88, 0.3, 2.6), 0xf4f4f0, 0, 0.6, 0.1]);
      wheels(d, 0.34, 0.24, [-0.82, 0.82], [-1.4, 1.4]);
    }
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
  // a getaway car is a car (black) in the car meshes
  inst("car", CG.paint, CAP.car + CAP.getaway, paintM); inst("carDetail", CG.detail, CAP.car + CAP.getaway, vc);
  inst("bus", BG.paint, CAP.bus, paintM); inst("busDetail", BG.detail, CAP.bus, vc);
  inst("tram", TG.paint, CAP.tram*2, paintM); inst("tramDetail", TG.detail, CAP.tram*2, vc);
  EV_KINDS.concat(["tow", "van", "schoolbus"]).forEach(function(k){ inst(k, evGeo(k), CAP[k], vc); });
  inst("beacon", new THREE.BoxGeometry(0.28, 0.14, 0.2), (CAP.fire + CAP.ambulance + CAP.police + CAP.tow)*2, beaconM);
  var BEACON_Y = {fire: 2.6, ambulance: 2.8, police: 1.55, tow: 2.35}, BEACON_Z = {fire: 3.3, ambulance: 2.6, police: -0.2, tow: 2.0};
  var LINE_COL = [0xd23b3b, 0x2c7be5, 0x2fa36b, 0xe0a020, 0x8a55c8, 0x1aa3b8];

  function put(m, i, x, y, z, yaw, hex){
    e.set(0, yaw, 0); q.setFromEuler(e); p.set(x, y, z); mtx.compose(p, q, sc); m.setMatrixAt(i, mtx);
    if(hex != null){ col.setHex(hex); m.setColorAt(i, col); }
  }
  // opt.calm: beacons lit steady, never flashing
  function update(vehicles, timeMs, opt){
    var n = {car: 0, bus: 0, tram: 0, fire: 0, ambulance: 0, police: 0, beacon: 0, tow: 0, van: 0, schoolbus: 0, getaway: 0};
    var flash = opt && opt.calm ? 0 : Math.floor(num(timeMs, 0)/250) & 1, cm = 0;
    (vehicles || []).forEach(function(v){
      var k = v.kind;
      if(n[k] == null) return;
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
      if(n[k] >= CAP[k]) return;
      if(k === "car" || k === "getaway"){
        put(meshes.car, cm, v.x, v.y, v.z, v.yaw, k === "getaway" ? 0x17181c : v.paint != null ? v.paint : 0x8a9199); put(meshes.carDetail, cm, v.x, v.y, v.z, v.yaw); cm++;
      }
      else if(k === "van") put(meshes.van, n.van, v.x, v.y, v.z, v.yaw, v.paint != null ? v.paint : 0xf2f2ee);
      else if(k === "schoolbus") put(meshes.schoolbus, n.schoolbus, v.x, v.y, v.z, v.yaw);
      else if(k === "bus"){ put(meshes.bus, n.bus, v.x, v.y, v.z, v.yaw, LINE_COL[hash32(v.line) % LINE_COL.length]); put(meshes.busDetail, n.bus, v.x, v.y, v.z, v.yaw); }
      else {
        put(meshes[k], n[k], v.x, v.y, v.z, v.yaw);
        var s = Math.sin(v.yaw), cs = Math.cos(v.yaw), bz = BEACON_Z[k], by = BEACON_Y[k];
        [-0.45, 0.45].forEach(function(lx, j){
          if(n.beacon >= meshes.beacon.instanceMatrix.count) return;
          // lit (flashing unless Calm) with a siren or lights on, dark otherwise; a tow truck's are amber
          var lit = v.siren || v.lights, hex = k === "tow" ? (lit ? ((flash ^ j) ? 0xffb020 : 0x7a4a00) : 0x3a2a10) : lit ? ((flash ^ j) ? 0x3a6bff : 0xff2a2a) : 0x401818;
          if(!v.siren && !v.lights && v.siren !== false) hex = 0xff2a2a;
          put(meshes.beacon, n.beacon++, v.x + lx*cs + bz*s, v.y + by, v.z - lx*s + bz*cs, v.yaw, hex);
        });
      }
      n[k]++;
    });
    Object.keys(n).forEach(function(k){
      [k, k + "Detail"].forEach(function(name){
        var m = meshes[name];
        if(!m) return;
        m.count = k === "car" ? cm : n[k]; m.instanceMatrix.needsUpdate = true;
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

HQV.traffic = {create: create, view: view, SPEC: SPEC, GAP: GAP, DWELL: DWELL, FARE: FARE, DENS: DENS, CAP: CAP, INC_W: INC_W,
               _: {plOf: plOf, plAt: plAt, offsetPts: offsetPts, trimPts: trimPts, Profile: Profile, fastest: fastest, ease: ease}};
})();
