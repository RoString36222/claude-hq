/* Claude HQ: water transport on the @3 water (HQV.hqFerries): the water bus, the lake launch and the water taxis.
 * HQ 3.15, docs/plans/transport-revamp.md 3.8 (part `water`). Everything is free (D4).
 *
 * The water comes from the doc (layers.water, read through HQV.hqboat.water / HQV.world.waterOf, metres): its piers,
 * its navigable network (net) and its routes (W1, W2: the water bus; L1: the launch round the park lake).
 *
 * Pure top half (no THREE, no DOM; tests/test_hqferries.py runs it under node):
 *   create(W, {tier, seed}) -> sim, the Service contract (plan 5.3), mode "ferry":
 *     sim.lines() / stops() / stopsNear(x, z, r) / departures(stopId, ms, n) / trip(lineId, from, to, ms) / vehicles(ms)
 *     sim.vessel(lineId, k, ms) -> {x, y (the waterline), z, yaw, speed, doors (0..1, the gangway), side (+1 the gangway
 *       is on the left, -1 the right), phase "run"|"dwell", stop (pier id while dwelling) | null, floor (y of the deck)}
 *     sim.route(lineId) -> {legs: [{x, z (Float64Array), s, v, t, yaw, ys, T, len}], stops: [pier ids], C (s, the cycle),
 *       H (s, the headway), n (vessels), off (ms), calls: [{stop, arr, dep, dir}], phases}
 *     sim.water() the metre view; sim.wet(x, z) -> {kind: "lake"|"canal"|"marina"|"river"|"sea", id, y} | null
 *   Timetable: the water bus every HEAD.waterbus (150 s) each way, 6 m/s on the river and canals, 9 m/s in the marina
 *   and at sea, 0.5 m/s² either way (and slower round tight bends), DWELL (30 s) at each pier with the gangway out; at a
 *   terminus it turns round in TURN s before leaving. The launch loops its lake every HEAD.launch (300 s) at LAUNCH_V.
 *   Departures are a pure function of (doc, line, UTC ms, seed): vessel k leaves its first pier at
 *   off + (k*H + m*C)*1000 ms, off = hash(seed:line) % H.
 *   taxi(W, fromPier, toPier, ms, seed) -> Trip | null: A* over the net (14 m/s on open water: the marina, a lake, the
 *     sea; 6 m/s on the river and the canals), only between piers on connected water; a rear-bench seat, a seeded
 *     skipper (trip.skipper). taxiPath(W, a, b) -> [[x, z], ...] | null (a, b: pier ids or {node}).
 *   taxiTargets(W, fromPier) -> [pier ids reachable by water taxi]; piers(W) -> [{id, kind, body, name, x, y, z, yaw}]
 *   SEATS.waterbus / launch / taxi: [{x, y, z, yaw, window}] vessel-local metres (+x is LEFT, +z forward, y over the floor)
 *
 * Drawing half (THREE from the hq3d ctx `c`):
 *   view(c, sim, opts) -> V (plan 5.4): every water bus (a 24 m catamaran: an enclosed cabin of 36 seats 2+2+2 behind
 *     panoramic windows, an open stern deck with benches, a wheelhouse with its skipper, life rings, a gangway that swings
 *     out at each pier: Calm, it is simply there), the electric launch (12 seats under a canopy), the piers (timber decks
 *     on piles, a kiosk, a departure board, lamps, bollards), the marina's pontoons and finger berths, the fuel jetty's
 *     pumps, the harbour office and the lighthouse on the breakwater head (its beam sweeps slowly at night; Calm: it stands
 *     still), and boats moored in the berths (seeded). opts = {calm(), night(), sfx(name, {gain}), parent}.
 *     V.update(ms, dt, cam), V.focus(id), V.drawCalls(), V.wakes() -> [{id, x, z, yaw, speed, beam}] (for ocean's
 *     wake(boats): the existing wake ribbons), V.tools.shotCam("waterbus-pier"|"waterbus-cabin"|"marina"|"lake-launch"),
 *     V.dispose(). Instanced: the draw calls stay 11 at most for any number of vessels and piers.
 *   taxiController(c, w, deps) -> {request(from, to) -> handle, carry(ms), camPose(ms, look), update(ms, dt), drawCalls(),
 *     active(), cancel(), tools: {shotCam}, dispose()}: a 9 m varnished speedboat (one draw) comes to the pier, waits, you
 *     board (handle.board()), it runs you over and lands you (handle.ashore()). handle.state() -> {state:
 *     "coming"|"here"|"riding"|"done"|"cancelled", eta (s), metres}. deps = {W, now(), me() -> {x, z}, announce(text),
 *     sfx(name, o), calm(), seed}.
 * Sounds (opts.sfx / deps.sfx, each with {pos, kind}: heard where it is through games/engine.js's spatial voices):
 * "ferry-horn" from the wheelhouse on departure (kind horn), "gangway-clank" at the gangway's hinge as it lands and at
 * the water taxi when it comes in (door), "water-lap" at the nearest pier head (water), and "engine-hum" as held loops
 * that follow their hulls: a pool (HQV.engine.pool, kind boat) keeps the nearest HUM_VOICES water buses and launches
 * sounding, the water taxi holds its own while it is about; named from HQV.hqRide.SFX when it knows them, else an
 * alias ("motor", "gondola-clunk").
 * Frames as the 3D city's: metres, +y up, yaw 0 faces +z, increasing yaw turns left, the right of travel is (-cos yaw, sin yaw).
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : self;
var HQV = root.HQV = root.HQV || {};
var PI = Math.PI;

/* ---------- numbers ---------- */
var HEAD = {waterbus: 150, launch: 300};          // s between departures (each way)
var DWELL = 30, TURN = 20, SLEW = 5, GANG = 4, GANG_Z = -5.6;     // s: at a pier; turning round at a terminus; easing onto the next heading; the gangway's swing
var SPEED = {river: 6, canal: 6, lake: 6, marina: 9, sea: 9};
var LAUNCH_V = 4, ACC = 0.5, LAT = 0.6;            // m/s; m/s² along; m/s² across (how fast round a bend)
var TAXI = {open: 14, slow: 6, acc: 1.8, lat: 2.5, off: 2.2, reach: 400, wait: 300, linger: 20, base: [250, 600]};
var SPOT_R = 18;                                  // m: two water buses' centres closer than this at a shared pier would clash
var LANE = 4.5, LANE_RAMP = 25;                   // m: water buses keep right of the centre line, so two bound opposite ways pass
var STEP = 2, CUT = 8, LOD = 1600;                 // m: resampling; the most a bend is cut by smoothing; draw range
var CRAFT = {
  waterbus: {len: 24, beam: 8.4, floor: 1.42, seats: 36, standing: 20, off: 5.2},
  launch:   {len: 8, beam: 2.6, floor: 0.45, seats: 12, standing: 0, off: 2.0},
  taxi:     {len: 9, beam: 2.6, floor: 0.5, seats: 3, standing: 0, off: TAXI.off}
};
var COLORS = {W1: "#1e88c8", W2: "#2bb3a3", W3: "#5c6bc0", L1: "#3fa34d", WT: "#b5651d"};
var SKIPPERS = ["Mara Quill", "Tobin Reyes", "Ines Harrow", "Oskar Lindqvist", "Priya Nandakumar", "Cal Brennan", "Wren Okafor",
                "Juno Halloway", "Teodor Varga", "Saoirse Kell", "Ravi Castellanos", "Ada Fennimore", "Kofi Mensah-Lund", "Lena Straub"];

/* ---------- helpers ---------- */
function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function num(v, d){ v = +v; return isFinite(v) ? v : d; }
function wrapPi(a){ a = +a || 0; return Math.atan2(Math.sin(a), Math.cos(a)); }
function hash32(str){
  str = String(str == null ? "" : str);
  var h = 0x811c9dc5;
  for(var i = 0; i < str.length; i++){ h ^= str.charCodeAt(i) & 0xff; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function mulberry32(a){ return function(){ a = (a + 0x6D2B79F5) | 0; var t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0)/4294967296; }; }
function mod(a, m){ a = a % m; return a < 0 ? a + m : a; }
function smooth01(u){ u = clamp(u, 0, 1); return u*u*(3 - 2*u); }
function lerpAng(a, b, u){ return wrapPi(a + wrapPi(b - a)*u); }
function d2(ax, az, bx, bz){ var dx = ax - bx, dz = az - bz; return Math.sqrt(dx*dx + dz*dz); }

/* ---------- the water ---------- */
function inFlat(f, x, z){
  var inside = false, n = f.length >> 1;
  for(var i = 0, j = n - 1; i < n; j = i++){
    var ax = f[2*i], az = f[2*i+1], cx = f[2*j], cz = f[2*j+1];
    if((az > z) !== (cz > z) && x < (cx - ax)*(z - az)/(cz - az) + ax) inside = !inside;
  }
  return inside;
}
function inBody(b, x, z){
  if(HQV.hqboat && HQV.hqboat.inBody) return HQV.hqboat.inBody(b, x, z);
  var B = b.box;
  if(B && (x < B.x0 || x > B.x1 || z < B.z0 || z > B.z1)) return false;
  if(!inFlat(b.poly, x, z)) return false;
  for(var k = 0; k < (b.islands || []).length; k++) if(inFlat(b.islands[k], x, z)) return false;
  return true;
}
function waterView(W){
  if(!W) return null;
  if(HQV.hqboat && typeof HQV.hqboat.water === "function") return HQV.hqboat.water(W);
  return HQV.world && typeof HQV.world.waterOf === "function" ? HQV.world.waterOf(W) : null;
}
function headOf(p){ return {x: p.x + p.fx*p.len/2, z: p.z + p.fz*p.len/2}; }
// per W: the metre view, the coast (for the sea), the river's level, the sea's
var CTX = [];
function ctxOf(W){
  if(!W) return null;
  for(var i = 0; i < CTX.length; i++) if(CTX[i].W === W) return CTX[i];
  var V = waterView(W);
  if(!V) return null;
  var I = (W.tierBase || W).island || (W.layers && W.layers.island) || null, sea = I && isFinite(+I.sea_cm) ? +I.sea_cm/100 : 0;
  var coast = [];
  ((I && I.coast) || []).forEach(function(p){ if(p && p.length >= 2) coast.push(+p[0]/100, +p[1]/100); });
  var C = {W: W, V: V, sea: sea, riverY: sea + (HQV.ocean && HQV.ocean.RIVER_Y || 0.3), coast: coast.length >= 6 ? coast : null,
           id: String(W.id || W.seed || "world"), lines: null, sims: {}};
  C.coastBox = C.coast ? (function(f){ var b = {x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity}; for(var k = 0; k < f.length; k += 2){ b.x0 = Math.min(b.x0, f[k]); b.x1 = Math.max(b.x1, f[k]); b.z0 = Math.min(b.z0, f[k+1]); b.z1 = Math.max(b.z1, f[k+1]); } return b; })(C.coast) : null;
  CTX.push(C); if(CTX.length > 4) CTX.shift();
  return C;
}
// what water (x, z) is on: a body (its outline, off its islands; decks not considered), the river, else the sea
// outside the coast | null (dry land)
function wetAt(C, x, z){
  var B = C.V.bodies;
  for(var i = 0; i < B.length; i++) if(inBody(B[i], x, z)) return {kind: B[i].kind, id: B[i].id, y: B[i].y};
  var WD = HQV.world;
  if(WD && typeof WD.riverAt === "function" && C.W.river && WD.riverAt(C.W, x, z)) return {kind: "river", id: "river", y: C.riverY};
  if(C.coast){
    var b = C.coastBox;
    if(x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1 || !inFlat(C.coast, x, z)) return {kind: "sea", id: "sea", y: C.sea};
  }
  return null;
}
function pierById(C, id){ for(var i = 0; i < C.V.piers.length; i++) if(C.V.piers[i].id === id) return C.V.piers[i]; return null; }
function pierName(C, p){
  var R = HQV.hqRide, n = null;
  if(R && typeof R.stationName === "function"){ try { var h = headOf(p); n = R.stationName(C.W, h.x, h.z, "pier"); } catch(e){ n = null; } }
  return n ? String(n) : "Pier " + (String(p.id).split(":")[1] || p.id);
}
// a pier's water y (its body's, the river's or the sea's)
function pierWaterY(C, p){
  for(var i = 0; i < C.V.bodies.length; i++) if(C.V.bodies[i].id === p.body) return C.V.bodies[i].y;
  return p.body === "river" ? C.riverY : C.sea;
}
// where a craft lies at a pier: off its head along `front` (beam/2 and a little), the first point still on water
// along: how far along the bank (+ to the left of `front`) the craft lies, so two lines sharing a pier lie end to end
// with the head between them (each falls back to the plain berth when that is not on water)
function berthPoint(C, p, off, along){
  var h = headOf(p), a = +along || 0;
  for(var k = 0; k < 4; k++){
    var o = off*(1 - k*0.25), x = h.x + p.fx*o + p.fz*a, z = h.z + p.fz*o - p.fx*a;
    if(wetAt(C, x, z) && (!a || wetAt(C, x + p.fz*a*0.5, z - p.fx*a*0.5))) return {x: x, z: z};
  }
  return a ? berthPoint(C, p, off, 0) : {x: h.x + p.fx*off, z: h.z + p.fz*off};
}

// a net node at a pier's head (the doc puts one there for every pier) is passed off the head, not through it
function offHead(C, x, z, off){
  var P = C.V.piers;
  for(var i = 0; i < P.length; i++){
    var h = headOf(P[i]);
    if(d2(h.x, h.z, x, z) < 1.5){ var b = berthPoint(C, P[i], off); return [b.x, b.z]; }
  }
  return [x, z];
}

/* ---------- paths and the speed profile ---------- */
// corners cut (Chaikin, twice), never by more than CUT m, the two ends kept
function soften(P){
  for(var it = 0; it < 2; it++){
    if(P.length < 3) return P;
    var out = [P[0]];
    for(var i = 1; i < P.length - 1; i++){
      var a = P[i - 1], b = P[i], c = P[i + 1], la = d2(a[0], a[1], b[0], b[1]), lc = d2(c[0], c[1], b[0], b[1]);
      var ua = la > 1e-6 ? Math.min(0.25, CUT/la) : 0, uc = lc > 1e-6 ? Math.min(0.25, CUT/lc) : 0;
      out.push([b[0] + (a[0] - b[0])*ua, b[1] + (a[1] - b[1])*ua], [b[0] + (c[0] - b[0])*uc, b[1] + (c[1] - b[1])*uc]);
    }
    out.push(P[P.length - 1]);
    P = out;
  }
  return P;
}
function dedupe(P){
  var out = [];
  P.forEach(function(p){ var l = out[out.length - 1]; if(!l || d2(l[0], l[1], p[0], p[1]) > 0.05) out.push([p[0], p[1]]); });
  return out;
}
// A leg: the polyline resampled every STEP m, the speed limit at each sample (vmax(wet) and the bend), the fastest
// profile starting and ending at rest under accel `acc` (exact for constant acceleration between samples), and the
// time at each sample. -> {x, z, s, v, t, yaw, ys, T, len}
function buildLeg(C, P, vmax, acc, lat, lane, edge){
  lane = +lane || 0; edge = +edge || 0;
  P = soften(dedupe(P));
  if(P.length < 2) P = [P[0] || [0, 0], P[0] || [0, 0]];
  var xs = [], zs = [], ss = [];
  var total = 0;
  for(var i = 0; i < P.length - 1; i++){
    var a = P[i], b = P[i + 1], L = d2(a[0], a[1], b[0], b[1]), n = Math.max(1, Math.ceil(L/STEP));
    for(var k = 0; k < n; k++){ xs.push(a[0] + (b[0] - a[0])*k/n); zs.push(a[1] + (b[1] - a[1])*k/n); ss.push(total + L*k/n); }
    total += L;
  }
  xs.push(P[P.length - 1][0]); zs.push(P[P.length - 1][1]); ss.push(total);
  var m = xs.length, v = new Float64Array(m), t = new Float64Array(m), yaw = new Float64Array(m), ys = new Float64Array(m), lim = new Float64Array(m);
  var lastY = null;
  for(i = 0; i < m; i++){
    var w = wetAt(C, xs[i], zs[i]);
    lim[i] = vmax(w);
    if(w) lastY = w.y;
    ys[i] = lastY;
  }
  var firstY = null;
  for(i = 0; i < m; i++) if(ys[i] != null){ firstY = ys[i]; break; }
  for(i = 0; i < m; i++){ if(ys[i] == null || isNaN(ys[i])) ys[i] = firstY != null ? firstY : C.sea; }
  // headings, and the bends: radius from the turn over +-3 samples
  for(i = 0; i < m; i++){
    var i0 = Math.max(0, i - 1), i1 = Math.min(m - 1, i + 1);
    yaw[i] = Math.atan2(xs[i1] - xs[i0], zs[i1] - zs[i0]);
  }
  for(i = 0; i < m; i++){
    var j0 = Math.max(0, i - 3), j1 = Math.min(m - 1, i + 3);
    if(j1 - j0 < 2) continue;
    var y0 = Math.atan2(xs[i] - xs[j0], zs[i] - zs[j0]), y1 = Math.atan2(xs[j1] - xs[i], zs[j1] - zs[i]), ang = Math.abs(wrapPi(y1 - y0));
    if(ang > 1e-3) lim[i] = Math.min(lim[i], Math.max(1.2, Math.sqrt(lat*(ss[j1] - ss[j0])/ang)));
  }
  // a limit holds from the sample before it too, so nothing is over it anywhere on slower water
  var lim0 = Float64Array.from(lim);
  for(i = 0; i < m; i++) lim[i] = Math.min(lim0[i], i > 0 ? lim0[i - 1] : Infinity, i + 1 < m ? lim0[i + 1] : Infinity);
  v[0] = 0;
  for(i = 1; i < m; i++) v[i] = Math.min(lim[i], Math.sqrt(v[i - 1]*v[i - 1] + 2*acc*(ss[i] - ss[i - 1])));
  v[m - 1] = 0;
  for(i = m - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1]*v[i + 1] + 2*acc*(ss[i + 1] - ss[i])));
  t[0] = 0;
  for(i = 1; i < m; i++){ var ds = ss[i] - ss[i - 1], vv = v[i] + v[i - 1]; t[i] = t[i - 1] + (ds > 0 ? (vv > 1e-9 ? 2*ds/vv : 0) : 0); }
  var out = {x: Float64Array.from(xs), z: Float64Array.from(zs), s: Float64Array.from(ss), v: v, t: t, yaw: yaw, ys: ys, T: t[m - 1], len: total, lane: null};
  if(lane > 0){
    // keep right: how far each sample may stand off to the right of travel either way (fwd, back) with the hull's
    // edge still on water; eased in and out over LANE_RAMP m from the piers at the ends
    var lf = new Float64Array(m), lb = new Float64Array(m);
    for(i = 0; i < m; i++){
      var rx = -Math.cos(yaw[i]), rz = Math.sin(yaw[i]), ramp = smooth01(Math.min(ss[i], total - ss[i])/LANE_RAMP);
      [[lf, 1], [lb, -1]].forEach(function(q){
        var o = 0;
        for(var f = lane; f > 0.01; f -= lane/3){ var e = f + edge; if(wetAt(C, xs[i] + q[1]*rx*e, zs[i] + q[1]*rz*e) && wetAt(C, xs[i] + q[1]*rx*f, zs[i] + q[1]*rz*f)){ o = f; break; } }
        q[0][i] = o*ramp;
      });
    }
    // no sudden steps: the offset changes by at most 1 m per 8 m along
    [lf, lb].forEach(function(A){
      for(i = 1; i < m; i++) A[i] = Math.min(A[i], A[i - 1] + (ss[i] - ss[i - 1])/8);
      for(i = m - 2; i >= 0; i--) A[i] = Math.min(A[i], A[i + 1] + (ss[i + 1] - ss[i])/8);
    });
    out.lane = {f: lf, b: lb};
  }
  return out;
}
// where a leg is u s after it starts (rev: run backwards, the same water) -> {x, z, y, yaw, speed}
function legPose(L, u, rev){
  var m = L.x.length, T = L.T;
  u = clamp(u, 0, T);
  if(rev) u = T - u;
  var lo = 0, hi = m - 1;
  while(hi - lo > 1){ var md = (lo + hi) >> 1; if(L.t[md] <= u) lo = md; else hi = md; }
  var dt = L.t[hi] - L.t[lo], tau = u - L.t[lo], v0 = L.v[lo], v1 = L.v[hi];
  var ds = L.s[hi] - L.s[lo], d = dt > 1e-9 ? v0*tau + (v1 - v0)*tau*tau/(2*dt) : 0, f = ds > 1e-9 ? clamp(d/ds, 0, 1) : 0;
  var sp = dt > 1e-9 ? v0 + (v1 - v0)*tau/dt : 0, yw = lerpAng(L.yaw[lo], L.yaw[hi], f);
  var x = L.x[lo] + (L.x[hi] - L.x[lo])*f, z = L.z[lo] + (L.z[hi] - L.z[lo])*f;
  if(L.lane){
    var A = rev ? L.lane.b : L.lane.f, o = (A[lo] + (A[hi] - A[lo])*f)*(rev ? -1 : 1);
    x += -Math.cos(yw)*o; z += Math.sin(yw)*o;                     // to the right of travel (forward), the left of the leg's own way (back)
  }
  return {x: x, z: z, y: L.ys[lo] + (L.ys[hi] - L.ys[lo])*f, yaw: rev ? wrapPi(yw + PI) : yw, speed: sp};
}
function legEnd(L, rev, atEnd){ return legPose(L, atEnd ? L.T : 0, rev); }

/* ---------- a route's points: the doc's path through the net, the piers' berths in place of their nodes ---------- */
function routePoints(C, r, piers, craft, slotAt){
  var N = C.V.net.nodes, path = (r.path || []).filter(function(i){ return i >= 0 && i < N.length; });
  var B = piers.map(function(p){ var sl = slotAt ? slotAt(p.id) : 0; return berthPoint(C, p, craft.off, sl ? sl*(craft.len/2 + 1) : 0); });
  var seq = [], stopIdx = [];
  if(path.length >= 2){
    var P = path.map(function(i){ return {x: N[i][0], z: N[i][1], n: i}; }), at = [], prev = 0, k, j;
    var count = piers.length + (r.loop ? 1 : 0);
    for(k = 0; k < count; k++){
      var p = piers[k % piers.length], h = headOf(p), md = Infinity, mj = -1;
      var from = k === piers.length ? Math.max(prev, P.length - 1 - Math.max(2, Math.floor(P.length/4))) : prev;   // the loop's way home: its last stretch
      for(j = from; j < P.length; j++){ var dd = d2(P[j].x, P[j].z, h.x, h.z); if(dd < md - 1e-6){ md = dd; mj = j; } }
      if(mj < 0) return null;
      if(k < piers.length) for(j = from; j < P.length; j++) if(d2(P[j].x, P[j].z, h.x, h.z) <= md + 1){ mj = j; break; }
      at.push({j: mj, exact: md < 1.5, k: k % piers.length});
      prev = mj + 1;
    }
    if(r.loop && at[at.length - 1].j <= at[0].j) return null;
    var first = at[0].j, last = at[at.length - 1].j, drop = {};
    // a pier's own node (the head) sits on a spur off the centre line: (a, pier, a). Lie alongside instead: (a', berth, a'')
    at.forEach(function(q){ if(q.exact && q.j - 1 > first && q.j + 1 < last && P[q.j - 1].n === P[q.j + 1].n){ drop[q.j - 1] = 1; drop[q.j + 1] = 1; } });
    for(j = first; j <= last; j++){
      if(drop[j]) continue;
      var q = null;
      for(k = 0; k < at.length; k++) if(at[k].j === j){ q = at[k]; break; }
      if(!q){ seq.push(offHead(C, P[j].x, P[j].z, craft.off)); continue; }
      var b = B[q.k];
      if(q.exact){ stopIdx.push(seq.length); seq.push([b.x, b.z]); }
      else if(j === first){ stopIdx.push(seq.length); seq.push([b.x, b.z]); seq.push([P[j].x, P[j].z]); }
      else if(j === last){ seq.push([P[j].x, P[j].z]); stopIdx.push(seq.length); seq.push([b.x, b.z]); }
      else { seq.push([P[j].x, P[j].z]); stopIdx.push(seq.length); seq.push([b.x, b.z]); seq.push([P[j].x, P[j].z]); }
    }
    if(r.loop && stopIdx.length === piers.length){ stopIdx.push(seq.length); seq.push([B[0].x, B[0].z]); }
  } else if(!r.loop){
    piers.forEach(function(p, i){ stopIdx.push(seq.length); seq.push([B[i].x, B[i].z]); });
  } else {
    // a loop with no path (a hand-made doc): round its body, part way in from the shore, from the first pier and back
    var body = null;
    C.V.bodies.forEach(function(b){ if(b.id === piers[0].body) body = b; });
    if(!body) return null;
    var cx = 0, cz = 0, n = body.poly.length/2;
    for(var q2 = 0; q2 < n; q2++){ cx += body.poly[2*q2]; cz += body.poly[2*q2 + 1]; }
    cx /= n; cz /= n;
    var ring = null;
    [0.62, 0.7, 0.55, 0.78, 0.48].some(function(f){
      var R = [];
      for(var i = 0; i < n; i++) R.push([cx + (body.poly[2*i] - cx)*f, cz + (body.poly[2*i + 1] - cz)*f]);
      for(i = 0; i < R.length; i++){
        var a = R[i], c = R[(i + 1) % R.length];
        for(var s = 0; s <= 4; s++) if(!inBody(body, a[0] + (c[0] - a[0])*s/4, a[1] + (c[1] - a[1])*s/4)) return false;
      }
      ring = R; return true;
    });
    if(!ring) return null;
    // start at the ring point nearest the first berth, round once, back to it; other piers call where nearest
    var b0 = B[0], i0 = 0, bd = Infinity;
    ring.forEach(function(p, i){ var dd = d2(p[0], p[1], b0.x, b0.z); if(dd < bd){ bd = dd; i0 = i; } });
    stopIdx.push(0); seq.push([b0.x, b0.z]);
    for(var s2 = 0; s2 <= ring.length; s2++) seq.push(ring[(i0 + s2) % ring.length]);
    stopIdx.push(seq.length); seq.push([b0.x, b0.z]);
    if(piers.length > 1) return null;
  }
  if(stopIdx.length < 2) return null;
  return {seq: seq, stopIdx: stopIdx};
}

/* ---------- a line: legs, the cycle, calls ---------- */
// The timetable for far-terminus slack E: the phases of one cycle (tau 0 = leaving the first pier), the calls, the cycle C.
function planLine(legs, piers, loop, H, E, craftLen){
  var phases = [], calls = [], tau = 0, n = piers.length, i, B, Cy, A;
  function run(leg, rev, dir){ phases.push({kind: "run", t0: tau, t1: tau + legs[leg].T, leg: leg, rev: rev, dir: dir}); tau += legs[leg].T; }
  function dwell(stop, len, turn, inPose, outPose, dir){
    var p = piers[stop], h = headOf(p), lx = Math.cos(inPose.yaw), lz = -Math.sin(inPose.yaw);
    var side = (h.x - inPose.x)*lx + (h.z - inPose.z)*lz >= 0 ? 1 : -1;
    // the gangway goes out where the pier's head is along the hull (amidships, or near an end at a shared pier)
    var hz = clamp((h.x - inPose.x)*Math.sin(inPose.yaw) + (h.z - inPose.z)*Math.cos(inPose.yaw), -(craftLen/2 - 3), craftLen/2 - 3.5);
    phases.push({kind: "dwell", t0: tau, t1: tau + len, stop: stop, turn: turn, x: inPose.x, z: inPose.z, y: inPose.y,
                 yawIn: inPose.yaw, yawOut: outPose.yaw, side: side, dir: dir, hz: hz});
    tau += len;
  }
  if(!loop){
    for(i = 0; i < n - 1; i++){
      run(i, false, 0);
      if(i < n - 2){ calls.push({stop: i + 1, arr: tau, dep: tau + DWELL, dir: 0}); dwell(i + 1, DWELL, 0, legEnd(legs[i], false, true), legEnd(legs[i + 1], false, false), 0); }
    }
    A = tau;
    calls.push({stop: n - 1, arr: A, dep: A + DWELL + TURN + E, dir: 1});
    dwell(n - 1, DWELL + TURN + E, TURN, legEnd(legs[n - 2], false, true), legEnd(legs[n - 2], true, false), 1);
    for(i = n - 2; i >= 0; i--){
      run(i, true, 1);
      if(i > 0){ calls.push({stop: i, arr: tau, dep: tau + DWELL, dir: 1}); dwell(i, DWELL, 0, legEnd(legs[i], true, true), legEnd(legs[i - 1], true, false), 1); }
    }
    B = tau;
    Cy = Math.ceil((B + DWELL + TURN)/H - 1e-9)*H;
    dwell(0, Cy - B, TURN, legEnd(legs[0], true, true), legEnd(legs[0], false, false), 0);
  } else {
    for(i = 0; i < legs.length; i++){
      run(i, false, 0);
      if(i < legs.length - 1){ calls.push({stop: i + 1, arr: tau, dep: tau + DWELL, dir: 0}); dwell(i + 1, DWELL, 0, legEnd(legs[i], false, true), legEnd(legs[i + 1], false, false), 0); }
    }
    B = tau;
    Cy = Math.ceil((B + DWELL)/H - 1e-9)*H;
    dwell(0, Cy - B, 0, legEnd(legs[legs.length - 1], false, true), legEnd(legs[0], false, false), 0);
  }
  calls.unshift({stop: 0, arr: B - Cy, dep: 0, dir: 0});
  return {phases: phases, calls: calls, C: Cy};
}
// How well a line's berth times (calls at piers, with its offset in s) fit beside the ones already taken: the least
// clear time (s) between two vessels at one berth, with a vessel every H (negative: they would overlap there)
function berthGap(H, mine, taken){
  var by = {}, worst = Infinity;
  mine.forEach(function(q){ (by[q.pier] = by[q.pier] || []).push({pier: q.pier, arr: q.arr, dep: q.dep, own: true}); });
  taken.forEach(function(q){ if(q.H === H && by[q.pier]) by[q.pier].push({pier: q.pier, arr: q.arr, dep: q.dep, own: false}); });
  Object.keys(by).forEach(function(k){
    var Q = by[k];
    for(var i = 0; i < Q.length; i++){
      var li = Q[i].dep - Q[i].arr;
      if(Q[i].own) worst = Math.min(worst, H - li);
      for(var j = i + 1; j < Q.length; j++){
        if(!Q[i].own && !Q[j].own) continue;
        var lj = Q[j].dep - Q[j].arr, d = mod(Q[j].arr - Q[i].arr, H);
        worst = Math.min(worst, Math.min(d - li, H - d - lj));
      }
    }
  });
  return worst;
}
// where a vessel of a plan is tau s into its cycle (x, z only: for the berth-clearance masks)
function posAtTau(legs, phases, tau){
  var lo = 0, hi = phases.length - 1;
  while(lo < hi){ var m = (lo + hi + 1) >> 1; if(phases[m].t0 <= tau) lo = m; else hi = m - 1; }
  var ph = phases[lo];
  if(ph.kind === "run"){ var q = legPose(legs[ph.leg], tau - ph.t0, ph.rev); return [q.x, q.z]; }
  return [ph.x, ph.z];
}
// for each spot, the phases (s, mod H, before the line's offset) when one of the line's vessels is within SPOT_R m of it
// (count: how many of its vessels at once: the fleet is one vessel's cycle every H)
function presence(legs, pl, spots, H, count){
  var out = spots.map(function(){ return new Uint8Array(H); });
  if(!spots.length) return out;
  for(var t = 0; t < pl.C; t += 1){
    var q = posAtTau(legs, pl.phases, t), ph = mod(Math.round(t), H);
    for(var i = 0; i < spots.length; i++) if(d2(q[0], q[1], spots[i].x, spots[i].z) < SPOT_R) out[i][ph] = count ? out[i][ph] + 1 : 1;
  }
  return out;
}
function intervals(calls, stops, off, H){
  return calls.map(function(c){ return {pier: stops[c.stop], arr: off + c.arr, dep: off + c.dep, H: H}; });
}
function buildLine(C, r, tier, seed, taken, slotAt, spots){
  if((r.tier | 0) > tier) return null;
  var kind = r.kind === "launch" ? "launch" : "waterbus", craft = CRAFT[kind];
  var piers = (r.piers || []).map(function(id){ return pierById(C, id); }).filter(function(p){ return p && (p.tier | 0) <= tier; });
  if(!piers.length || (!r.loop && piers.length < 2)) return null;
  var RP = routePoints(C, r, piers, craft, slotAt);
  if(!RP) return null;
  var vmax = kind === "launch" ? function(){ return LAUNCH_V; } : function(w){ return w ? (SPEED[w.kind] || 6) : 6; };
  var legs = [];
  for(var k = 0; k + 1 < RP.stopIdx.length; k++) legs.push(buildLeg(C, RP.seq.slice(RP.stopIdx[k], RP.stopIdx[k + 1] + 1), vmax, ACC, LAT, kind === "waterbus" && !r.loop ? LANE : 0, craft.beam/2));
  var H = HEAD[kind], id = String(r.id), stops = piers.map(function(p){ return p.id; });
  var berths = stops.map(function(sid){ return sid + "#" + (slotAt ? slotAt(sid) : 0); });
  var base = (hash32(seed + ":ferry:" + id) % (H*1000))/1000;
  // the slack at the far terminus (E) and the shift of the offset: the two directions never share a pier at once,
  // no terminus holds two vessels, and berths shared with the lines already laid are kept clear (best effort; the
  // first best, so it is the same on every client)
  // the spots (berths at piers shared with lines already laid) and when those lines are near them (their masks, at
  // their own offsets): the fewest seconds of clash first, then the clearest berths of its own
  var sp = (spots || []).filter(function(q){ return q.H === H; }), shared = sp.some(function(q){ return q.mask; });
  var ownSpots = piers.map(function(p){ var sl = slotAt ? slotAt(p.id) : 0; return berthPoint(C, p, craft.off, sl ? sl*(craft.len/2 + 1) : 0); });
  var best = null, Es = r.loop ? [0] : [], E, sh;
  if(!r.loop) for(E = 0; E < H; E += 2) Es.push(E);
  Es.forEach(function(e){
    var pl = planLine(legs, piers, !!r.loop, H, e, craft.len), mine = shared ? presence(legs, pl, sp, H) : null;
    var g = berthGap(H, intervals(pl.calls, berths, 0, H), []), own = 0;
    // its own vessels: two near one of its berths at once (coming and going, or both ways at a pier)
    if(kind === "waterbus") presence(legs, pl, ownSpots, H, true).forEach(function(M){ for(var ph = 0; ph < H; ph++) if(M[ph] > 1) own += M[ph] - 1; });
    for(sh = 0; sh < (shared ? H : 1); sh += 2){
      var clash = own, sft = Math.round(base + sh);
      if(shared) for(var i = 0; i < sp.length; i++){
        var T = sp[i].mask, M = mine[i];
        if(!T) continue;
        for(var ph = 0; ph < H; ph++) if(T[ph] && M[mod(ph - sft, H)]) clash++;
      }
      if(!best || clash < best.clash || (clash === best.clash && g > best.g + 1e-9)) best = {g: g, clash: clash, E: e, sh: sh, pl: pl};
    }
  });
  var pl = best.pl, off = Math.round(mod(base + best.sh, H)*1000);
  return {id: id, kind: kind, mode: "ferry", short: id, loop: !!r.loop, craft: craft, piers: piers, stops: stops, berths: berths, names: piers.map(function(p){ return pierName(C, p); }),
          legs: legs, phases: pl.phases, calls: pl.calls, C: pl.C, H: H, n: Math.round(pl.C/H), off: off, slack: best.E, gap: best.g, clash: best.clash,
          name: kind === "launch" ? "Lake launch " + id : "Water bus " + id, color: COLORS[id] || (kind === "launch" ? COLORS.L1 : COLORS.W1)};
}
// the cycle position tau (s) of vessel k at ms
function tauOf(L, k, ms){ return mod((ms - L.off)/1000 - k*L.H, L.C); }
function phaseAt(L, tau){
  var P = L.phases, lo = 0, hi = P.length - 1;
  while(lo < hi){ var m = (lo + hi + 1) >> 1; if(P[m].t0 <= tau) lo = m; else hi = m - 1; }
  return P[lo];
}
function vesselAt(L, k, ms){
  var tau = tauOf(L, k, ms), ph = phaseAt(L, tau), u = tau - ph.t0, o;
  if(ph.kind === "run"){
    var q = legPose(L.legs[ph.leg], u, ph.rev);
    o = {x: q.x, y: q.y, z: q.z, yaw: q.yaw, speed: q.speed, doors: 0, side: 0, hz: GANG_Z, phase: "run", stop: null, dir: ph.dir};
  } else {
    var len = ph.t1 - ph.t0, turnAt = len - (ph.turn || SLEW), yaw = ph.yawIn;
    if(u > turnAt) yaw = lerpAng(ph.yawIn, ph.yawOut, smooth01((u - turnAt)/Math.max(1e-6, ph.turn || SLEW)));
    var open = ph.turn ? turnAt : len;
    var doors = clamp(Math.min(u, open - u)/GANG, 0, 1);
    o = {x: ph.x, y: ph.y, z: ph.z, yaw: yaw, speed: 0, doors: doors, side: ph.side, hz: ph.hz, phase: "dwell", stop: L.stops[ph.stop], dir: ph.dir};
  }
  o.floor = o.y + L.craft.floor;
  o.id = L.id + ":" + k; o.line = L.id; o.k = k;
  return o;
}

/* ---------- seats ---------- */
var SEATS = {waterbus: [], launch: [], taxi: []};
(function(){
  var xs = [[2.95, true], [2.45, false], [0.25, false], [-0.25, false], [-2.45, false], [-2.95, true]];
  for(var r = 0; r < 6; r++) xs.forEach(function(q){ SEATS.waterbus.push({x: q[0], y: 0.45, z: -3.6 + r*1.6, yaw: 0, window: q[1]}); });
  for(var i = 0; i < 6; i++){
    SEATS.launch.push({x: 0.78, y: 0.42, z: -2.4 + i*0.75, yaw: -PI/2, window: true});
    SEATS.launch.push({x: -0.78, y: 0.42, z: -2.4 + i*0.75, yaw: PI/2, window: true});
  }
  [-0.55, 0.55, 0].forEach(function(x){ SEATS.taxi.push({x: x, y: 0.45, z: -2.6, yaw: 0, window: x !== 0}); });
})();
// standing spots on the water bus: the stern deck and the cabin's aisles
var STAND = {waterbus: [], launch: [], taxi: []};
(function(){
  for(var i = 0; i < 12; i++) STAND.waterbus.push({x: -3 + (i % 4)*2, y: 0, z: -10.5 + Math.floor(i/4)*1.6, yaw: 0});
  for(i = 0; i < 8; i++) STAND.waterbus.push({x: i % 2 ? -1.35 : 1.35, y: 0, z: -3.6 + Math.floor(i/2)*2.2, yaw: 0});
})();
function toWorld(P, q){
  var c = Math.cos(P.yaw), s = Math.sin(P.yaw);
  // local +x is LEFT: left = (cos yaw, -sin yaw); forward = (sin yaw, cos yaw)
  return {x: P.x + q.x*c + q.z*s, z: P.z - q.x*s + q.z*c};
}

/* ---------- the Service ---------- */
function create(W, o){
  o = o || {};
  var C = ctxOf(W);
  var tier = o.tier != null ? clamp(num(o.tier, 5), 1, 5) : 5, seed = o.seed != null ? String(o.seed) : (C ? C.id : "world");
  var key = tier + "|" + seed;
  if(C && C.sims[key]) return C.sims[key];
  var lines = [], byId = {}, stops = [], stopById = {};
  if(C){
    // a pier two water-bus lines call at: the first lies on one side of its head, the second on the other
    var users = {}, spots = [];
    C.V.routes.forEach(function(r){ if(r.kind !== "launch" && (r.tier | 0) <= tier) (r.piers || []).forEach(function(pid){ var u = users[pid] = users[pid] || []; if(u.indexOf(r.id) < 0) u.push(String(r.id)); }); });
    // which side of the head (along the bank, + = left of the pier's front) a line comes in from: a line ending there
    // lies on the side it arrives from, so it never sails through the other's berth; the first line gets its wish
    function prefSide(r, pid){
      var p = pierById(C, pid), N = C.V.net.nodes, path = (r.path || []).filter(function(i){ return i >= 0 && i < N.length; });
      var at = (r.piers || []).indexOf(pid);
      if(!p || path.length < 2 || r.loop || (at > 0 && at < r.piers.length - 1)) return 0;
      var h = headOf(p), j = 0, bd = Infinity;
      path.forEach(function(ni, k){ var d = d2(N[ni][0], N[ni][1], h.x, h.z); if(d < bd - 1e-6 || (at > 0 && Math.abs(d - bd) <= 1e-6)){ bd = d; j = k; } });
      var nb = null;
      for(var k = 1; k < path.length && !nb; k++){
        var q = N[path[at === 0 ? Math.min(path.length - 1, j + k) : Math.max(0, j - k)]];
        if(d2(q[0], q[1], h.x, h.z) > 6) nb = q;
      }
      if(!nb) return 0;
      var a = (nb[0] - h.x)*p.fz - (nb[1] - h.z)*p.fx;
      return Math.abs(a) < 1 ? 0 : a > 0 ? 1 : -1;
    }
    var slots = {};
    Object.keys(users).sort().forEach(function(pid){
      var u = users[pid], m = slots[pid] = {}, used = {};
      if(u.length < 2) return;
      u.forEach(function(rid){ var r = C.V.routes.filter(function(q){ return String(q.id) === rid; })[0], w = r ? prefSide(r, pid) : 0; if(w && !used[w]){ m[rid] = w; used[w] = 1; } });
      u.forEach(function(rid){ if(m[rid]) return; var w = !used[-1] ? -1 : !used[1] ? 1 : 0; m[rid] = w; if(w) used[w] = 1; });
    });
    function slotFor(rid){ return function(pid){ var m = slots[pid]; return m && m[String(rid)] ? m[String(rid)] : 0; }; }
    // every berth at a shared pier is a spot the lines there must keep clear for each other
    Object.keys(users).sort().forEach(function(pid){
      var u = users[pid], p = pierById(C, pid);
      if(u.length < 2 || !p) return;
      u.forEach(function(rid){ var sl = slotFor(rid)(pid), b = berthPoint(C, p, CRAFT.waterbus.off, sl ? sl*(CRAFT.waterbus.len/2 + 1) : 0); spots.push({x: b.x, z: b.z, H: HEAD.waterbus, mask: null}); });
    });
    C.V.routes.forEach(function(r){
      var L = null;
      try { L = buildLine(C, r, tier, seed, null, r.kind === "launch" ? null : slotFor(r.id), r.kind === "launch" ? null : spots); } catch(e){ L = null; }
      if(L && !byId[L.id]){
        lines.push(L); byId[L.id] = L;
        // what it now keeps busy, at its own offset, for the lines laid after it
        var sp = spots.filter(function(q){ return q.H === L.H; });
        if(sp.length && L.kind === "waterbus"){
          var pr = presence(L.legs, {phases: L.phases, C: L.C}, sp, L.H), o = Math.round(L.off/1000);
          sp.forEach(function(q, i){ var m = q.mask || new Uint8Array(L.H); for(var ph = 0; ph < L.H; ph++) if(pr[i][ph]) m[mod(ph + o, L.H)] = 1; q.mask = m; });
        }
      }
    });
    lines.forEach(function(L){
      L.piers.forEach(function(p, i){
        var s = stopById[p.id];
        if(!s){
          var h = headOf(p);
          s = stopById[p.id] = {id: p.id, name: L.names[i], x: h.x - p.fx*1.5, y: p.y, z: h.z - p.fz*1.5, mode: "ferry", lines: [], kind: "pier", under: false, pier: p.kind};
          stops.push(s);
        }
        if(s.lines.indexOf(L.id) < 0) s.lines.push(L.id);
      });
    });
  }
  function toName(L, c){
    if(!L.loop) return c.dir === 0 ? L.names[L.names.length - 1] : L.names[0];
    if(L.piers.length === 1) return "Round the lake";
    return L.names[mod(c.stop - 1, L.piers.length)];
  }
  // the calls of line L at stop id, their departures j >= jmin
  function depsOf(L, stopId, ms, n){
    var out = [];
    L.calls.forEach(function(c){
      if(L.stops[c.stop] !== stopId) return;
      var j0 = Math.ceil(((ms - L.off)/1000 - c.dep)/L.H - 1e-9);
      for(var j = j0; j < j0 + n; j++){
        var at = L.off + (c.dep + j*L.H)*1000, arr = at - (c.dep - c.arr)*1000;
        out.push({line: L.id, short: L.short, to: toName(L, c), at: at, plat: null, boarding: ms >= arr, delay: 0, vehicle: L.id + ":" + mod(j, L.n), arr: arr});
      }
    });
    return out;
  }
  var sim = {
    mode: "ferry",
    water: function(){ return C ? C.V : null; },
    wet: function(x, z){ return C ? wetAt(C, +x || 0, +z || 0) : null; },
    lines: function(){
      return lines.map(function(L){ return {id: L.id, mode: "ferry", name: L.name, short: L.short, color: L.color, stops: L.stops.slice(), headway: L.H, loop: L.loop, kind: L.kind}; });
    },
    stops: function(){ return stops.map(function(s){ return {id: s.id, name: s.name, x: s.x, y: s.y, z: s.z, mode: s.mode, lines: s.lines.slice(), kind: s.kind, under: false}; }); },
    stopsNear: function(x, z, r){
      x = num(x, 0); z = num(z, 0); r = num(r, 200);
      return stops.map(function(s){ return {id: s.id, name: s.name, dist: d2(s.x, s.z, x, z), mode: "ferry", lines: s.lines.slice()}; })
        .filter(function(s){ return s.dist <= r; }).sort(function(a, b){ return a.dist - b.dist || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
    },
    departures: function(stopId, ms, n){
      ms = num(ms, 0); n = Math.max(1, Math.min(20, (n | 0) || 4));
      var out = [];
      lines.forEach(function(L){ out = out.concat(depsOf(L, stopId, ms, n)); });
      out.sort(function(a, b){ return a.at - b.at || (a.line < b.line ? -1 : a.line > b.line ? 1 : 0); });
      return out.slice(0, n).map(function(d){ return {line: d.line, short: d.short, to: d.to, at: d.at, plat: null, boarding: d.boarding, delay: 0, vehicle: d.vehicle}; });
    },
    trip: function(lineId, from, to, ms){
      var L = byId[lineId];
      ms = num(ms, 0);
      if(!L || (from === to && !L.loop) || L.stops.indexOf(from) < 0 || L.stops.indexOf(to) < 0) return null;
      var calls = L.calls, best = null;
      calls.forEach(function(cf, ci){
        if(L.stops[cf.stop] !== from) return;
        var j = Math.ceil(((ms - L.off)/1000 - cf.dep)/L.H - 1e-9), via = [];
        for(var m = 1; m <= calls.length; m++){
          var idx = ci + m, cc = calls[idx % calls.length], wrap = idx >= calls.length ? L.C : 0;
          var arr = cc.arr + wrap;
          via.push({c: cc, arr: arr, dep: cc.dep + wrap});
          if(L.stops[cc.stop] === to){
            var reach = L.off + (j*L.H + arr)*1000;
            if(!best || reach < best.reach) best = {cf: cf, j: j, reach: reach, via: via.slice()};
            break;
          }
        }
      });
      if(!best) return null;
      var k = mod(best.j, L.n), depart = L.off + (best.j*L.H + best.cf.dep)*1000, arrive = depart - (best.cf.dep - best.cf.arr)*1000;
      var base = L.off + best.j*L.H*1000;
      var stopsList = [{id: from, name: L.names[best.cf.stop], at: depart}].concat(best.via.map(function(v){ return {id: L.stops[v.c.stop], name: L.names[v.c.stop], at: base + v.arr*1000}; }));
      return makeTrip(L, k, from, to, L.names[best.cf.stop], L.names[L.stops.indexOf(to)], arrive, depart, best.reach, stopsList);
    },
    vehicles: function(ms){
      ms = num(ms, 0);
      var out = [], CM = HQV.hqCommute;
      lines.forEach(function(L){
        for(var k = 0; k < L.n; k++){
          var v = vesselAt(L, k, ms), load = 0.3;
          if(CM && typeof CM.load === "function"){ try { load = num(CM.load("ferry", L.id, v.id, ms, seed), 0.3); } catch(e){ load = 0.3; } }
          out.push({id: v.id, line: L.id, mode: "ferry", kind: L.kind, x: v.x, y: v.y, z: v.z, yaw: v.yaw, speed: v.speed, doors: v.doors, side: v.side, hz: v.hz,
                    stop: v.stop, load: clamp(load, 0, L.kind === "launch" ? 1 : 1.15), under: false});
        }
      });
      return out;
    },
    vessel: function(lineId, k, ms){ var L = byId[lineId]; return L ? vesselAt(L, mod(k | 0, L.n), num(ms, 0)) : null; },
    route: function(lineId){ var L = byId[lineId]; return L ? {legs: L.legs, stops: L.stops.slice(), names: L.names.slice(), C: L.C, H: L.H, n: L.n, off: L.off, slack: L.slack, gap: L.gap, calls: L.calls, phases: L.phases, kind: L.kind, loop: L.loop} : null; },
    seed: seed, tier: tier, _c: C
  };
  if(C) C.sims[key] = sim;
  return sim;
}
function makeTrip(L, k, from, to, fromName, toName, arrive, depart, reach, stopsList){
  var kind = L.kind, seats = SEATS[kind], stand = STAND[kind];
  var T = {mode: "ferry", line: L.id, short: L.short, vehicle: L.id + ":" + k, from: from, to: to, fromName: fromName, toName: toName,
           arrive: arrive, depart: depart, reach: reach, stops: stopsList, seats: seats.length, standing: stand.length, craft: kind};
  T.pose = function(ms){
    var v = vesselAt(L, k, num(ms, 0));
    return {x: v.x, y: v.floor, z: v.z, yaw: v.yaw, pitch: 0, speed: v.speed, doors: v.doors, side: v.side, hz: v.hz, under: false, done: num(ms, 0) >= reach};
  };
  T.seat = function(i, ms){
    var P = T.pose(ms), q = i < seats.length ? seats[Math.max(0, i | 0)] : stand[Math.min(stand.length - 1, Math.max(0, (i | 0) - seats.length))] || seats[0];
    var w = toWorld(P, q);
    return {x: w.x, y: P.y + q.y, z: w.z, yaw: wrapPi(P.yaw + q.yaw)};
  };
  // the gangway's foot: on the deck of the pier it lies at (else the one you board at)
  T.door = function(ms){
    var v = vesselAt(L, k, num(ms, 0)), id = v.stop || from, p = null;
    L.piers.forEach(function(q){ if(q.id === id) p = q; });
    var h = headOf(p);
    return {x: h.x - p.fx*0.8, z: h.z - p.fz*0.8};
  };
  return T;
}

/* ---------- water taxis ---------- */
function adjOf(C){
  if(C.adj) return C.adj;
  var N = C.V.net.nodes, A = N.map(function(){ return []; });
  C.V.net.edges.forEach(function(e){
    var a = e[0], b = e[1];
    if(a < 0 || b < 0 || a >= N.length || b >= N.length || a === b) return;
    var mx = (N[a][0] + N[b][0])/2, mz = (N[a][1] + N[b][1])/2, w = wetAt(C, mx, mz), v = taxiV(w), L = d2(N[a][0], N[a][1], N[b][0], N[b][1]);
    A[a].push({to: b, cost: L/v}); A[b].push({to: a, cost: L/v});
  });
  return (C.adj = A);
}
function taxiV(w){ return w && (w.kind === "river" || w.kind === "canal") ? TAXI.slow : TAXI.open; }
// a straight run stays on water (every 2 m)
function wetLine(C, ax, az, bx, bz){
  var L = d2(ax, az, bx, bz), n = Math.max(1, Math.ceil(L/2));
  for(var i = 0; i <= n; i++) if(!wetAt(C, ax + (bx - ax)*i/n, az + (bz - az)*i/n)) return false;
  return true;
}
// a pier's way onto the net: its own node (at its head), else the nearest node reached over water from its berth
function attach(C, p){
  var N = C.V.net.nodes, h = headOf(p), b = berthPoint(C, p, TAXI.off), order = [];
  for(var i = 0; i < N.length; i++) order.push([d2(N[i][0], N[i][1], h.x, h.z), i]);
  order.sort(function(a, c){ return a[0] - c[0] || a[1] - c[1]; });
  if(order.length && order[0][0] < 1.5) return {node: order[0][1], exact: true, b: b};
  for(i = 0; i < order.length && order[i][0] <= TAXI.reach; i++){
    var n = N[order[i][1]];
    if(wetLine(C, b.x, b.z, n[0], n[1])) return {node: order[i][1], exact: false, b: b};
  }
  return {node: -1, exact: false, b: b};
}
function astar(C, s, g){
  var N = C.V.net.nodes, A = adjOf(C), n = N.length;
  if(s < 0 || g < 0 || s >= n || g >= n) return null;
  if(s === g) return [s];
  var gs = new Float64Array(n), prev = new Int32Array(n), done = new Uint8Array(n), open = [s];
  for(var i = 0; i < n; i++){ gs[i] = Infinity; prev[i] = -1; }
  gs[s] = 0;
  function h(i){ return d2(N[i][0], N[i][1], N[g][0], N[g][1])/TAXI.open; }
  while(open.length){
    var bi = 0, bf = Infinity;
    for(i = 0; i < open.length; i++){ var f = gs[open[i]] + h(open[i]); if(f < bf - 1e-12 || (Math.abs(f - bf) <= 1e-12 && open[i] < open[bi])){ bf = f; bi = i; } }
    var u = open.splice(bi, 1)[0];
    if(u === g) break;
    if(done[u]) continue;
    done[u] = 1;
    A[u].forEach(function(e){
      var c = gs[u] + e.cost;
      if(c < gs[e.to] - 1e-12){ gs[e.to] = c; prev[e.to] = u; if(open.indexOf(e.to) < 0) open.push(e.to); }
    });
  }
  if(!isFinite(gs[g])) return null;
  var out = [], at = g;
  while(at !== -1){ out.push(at); if(at === s) break; at = prev[at]; }
  return out[out.length - 1] === s ? out.reverse() : null;
}
// a, b: pier ids (or pier objects), or {node: i} -> [[x, z], ...] berth to berth | null (not on connected water)
function pathBetween(C, a, b){
  var N = C.V.net.nodes;
  function end(e){
    if(e && e.node != null) return {node: e.node | 0, exact: false, b: N[e.node | 0] ? {x: N[e.node | 0][0], z: N[e.node | 0][1]} : null, pier: null};
    var p = typeof e === "string" ? pierById(C, e) : e;
    if(!p || p.fx == null) return null;
    var q = attach(C, p); q.pier = p; return q;
  }
  var A = end(a), B = end(b);
  if(!A || !B || !A.b || !B.b) return null;
  if(A.pier && B.pier && A.pier.body === B.pier.body && wetLine(C, A.b.x, A.b.z, B.b.x, B.b.z) && (A.node < 0 || B.node < 0 || d2(A.b.x, A.b.z, B.b.x, B.b.z) < 120))
    { var dir = [[A.b.x, A.b.z], [B.b.x, B.b.z]]; dir.nodes = [-1, -1]; return dir; }
  if(A.node < 0 || B.node < 0) return null;
  var path = astar(C, A.node, B.node);
  if(!path) return null;
  var pts = [[A.b.x, A.b.z]], nodes = [-1];
  path.forEach(function(i, k){
    if(k === 0 && A.exact) return;
    if(k === path.length - 1 && B.exact) return;
    pts.push(offHead(C, N[i][0], N[i][1], TAXI.off)); nodes.push(i);
  });
  pts.push([B.b.x, B.b.z]); nodes.push(-1);
  pts.nodes = nodes;                                  // the net node each point stands for (-1: a berth)
  return pts;
}
function taxiPath(W, a, b){ var C = ctxOf(W); return C ? pathBetween(C, a, b) : null; }
function skipperFor(seed, key){ return SKIPPERS[hash32(String(seed) + ":skipper:" + key) % SKIPPERS.length]; }
function taxiTrip(C, pts, from, to, ms, seed, key){
  var L = buildLeg(C, pts, function(w){ return taxiV(w); }, TAXI.acc, TAXI.lat);
  var fp = typeof from === "string" ? pierById(C, from) : null, tp = typeof to === "string" ? pierById(C, to) : null;
  var depart = num(ms, 0), reach = depart + L.T*1000, craft = CRAFT.taxi, seats = SEATS.taxi;
  var T = {mode: "ferry", line: "WT", short: "WT", vehicle: "taxi:" + (hash32(String(seed) + ":" + key) % 100000), from: fp ? fp.id : null, to: tp ? tp.id : null,
           fromName: fp ? pierName(C, fp) : "", toName: tp ? pierName(C, tp) : "", arrive: depart, depart: depart, reach: reach,
           stops: [], seats: seats.length, standing: 0, craft: "taxi", metres: L.len, secs: L.T, leg: L, skipper: skipperFor(seed, key)};
  T.stops = [{id: T.from, name: T.fromName, at: depart}, {id: T.to, name: T.toName, at: reach}];
  T.pose = function(t){
    t = num(t, 0);
    var q = legPose(L, (t - depart)/1000, false);
    return {x: q.x, y: q.y + craft.floor, z: q.z, yaw: q.yaw, pitch: 0, speed: q.speed, doors: 0, under: false, done: t >= reach, water: q.y};
  };
  T.seat = function(i, t){ var P = T.pose(t), q = seats[clamp(i | 0, 0, seats.length - 1)], w = toWorld(P, q); return {x: w.x, y: P.y + q.y, z: w.z, yaw: wrapPi(P.yaw + q.yaw)}; };
  T.door = function(t){ var P = T.pose(t), w = toWorld(P, {x: 0, z: -3.6}); return {x: w.x, z: w.z}; };
  return T;
}
function taxi(W, fromPier, toPier, ms, seed){
  var C = ctxOf(W);
  if(!C || fromPier === toPier) return null;
  var pts = pathBetween(C, fromPier, toPier);
  if(!pts) return null;
  seed = seed != null ? String(seed) : C.id;
  var f = typeof fromPier === "string" ? fromPier : fromPier && fromPier.id, t = typeof toPier === "string" ? toPier : toPier && toPier.id;
  return taxiTrip(C, pts, f, t, ms, seed, f + ">" + t + ":" + Math.floor(num(ms, 0)/60000));
}
function piers(W){
  var C = ctxOf(W);
  if(!C) return [];
  return C.V.piers.map(function(p){ var h = headOf(p); return {id: p.id, kind: p.kind, body: p.body, name: pierName(C, p), x: h.x, y: p.y, z: h.z, yaw: p.yaw}; });
}
function taxiTargets(W, fromPier){
  var C = ctxOf(W);
  if(!C) return [];
  return C.V.piers.filter(function(p){ return p.id !== fromPier && !!pathBetween(C, fromPier, p.id); }).map(function(p){ return p.id; });
}
// where a called taxi starts: a "taxi" pier on the same water, else a node on the same water 250..600 m away (as the
// boat goes), else at the pier itself -> {from: pier id | {node}, here: bool}
function taxiStart(C, fromId, seed){
  var p = pierById(C, fromId);
  if(!p) return null;
  var bases = C.V.piers.filter(function(q){ return q.kind === "taxi" && q.id !== fromId; }), best = null;
  bases.forEach(function(q){ var P = pathBetween(C, q.id, fromId); if(P){ var L = 0; for(var i = 1; i < P.length; i++) L += d2(P[i-1][0], P[i-1][1], P[i][0], P[i][1]); if(!best || L < best.L) best = {from: q.id, L: L}; } });
  if(best) return {from: best.from, here: false};
  var a = attach(C, p);
  if(a.node >= 0){
    var N = C.V.net.nodes, A = adjOf(C), dist = {}, q2 = [a.node];
    dist[a.node] = 0;
    while(q2.length){
      var u = q2.shift();
      A[u].forEach(function(e){ var L = dist[u] + d2(N[u][0], N[u][1], N[e.to][0], N[e.to][1]); if(dist[e.to] == null || L < dist[e.to] - 1e-9){ dist[e.to] = L; q2.push(e.to); } });
    }
    var want = (TAXI.base[0] + TAXI.base[1])/2 + (hash32(seed + ":taxibase:" + fromId) % 100), pick = -1, pd = Infinity;
    Object.keys(dist).forEach(function(k){ var d = dist[k]; if(d >= TAXI.base[0] && d <= TAXI.base[1] && Math.abs(d - want) < pd){ pd = Math.abs(d - want); pick = +k; } });
    if(pick < 0) Object.keys(dist).forEach(function(k){ var d = dist[k]; if(d > 20 && Math.abs(d - want) < pd){ pd = Math.abs(d - want); pick = +k; } });
    if(pick >= 0) return {from: {node: pick}, here: false};
  }
  return {from: fromId, here: true};
}

/* ---------- sounds ---------- */
// Every sound is where it is (Sound PR B: o.pos and o.kind go through hqRide.sfx to games/engine.js's spatial voices):
// the horn at the wheelhouse (kind horn), the gangway landing at its hinge (door), the water lapping at the nearest
// pier head (water: under Ambient sounds), and the engines as held loops that follow their hulls (boat): a pool keeps
// the nearest HUM_VOICES of the water buses and launches sounding, the water taxi has its own
var ALIAS = {"engine-hum": "motor", "gangway-clank": "gondola-clunk", "water-lap": null, "ferry-horn": "ferry-horn"};
var HUM_VOICES = 2;                // this pool's voices (the City's ferries and ships have a pool of their own: games/hqcity3d.js)
function sound(f, name, o){
  if(typeof f !== "function") return null;
  var R = HQV.hqRide, list = R && R.SFX;
  var n = list && list.indexOf(name) < 0 ? ALIAS[name] : name;
  if(!n) return null;
  try { return f(n, o || {}); } catch(e){ return null; }
}
// a held loop's handle (hqRide's set / stop), else null
function loopOf(h){ return h && typeof h.set === "function" && typeof h.stop === "function" ? h : null; }
// the farthest a spatial kind is heard (games/engine.js KINDS), else d
function reach(kind, d){ var E = HQV.engine, K = E && E.spatial && E.spatial.KINDS, k = K && K[kind]; return k && k.max > 0 ? k.max : d; }
// where sounds are heard from: the spatial listener (the camera, or what a Classic view looks at), else p
function earOf(p){
  var E = HQV.engine, L = null;
  try { L = E && typeof E.listenerAt === "function" ? E.listenerAt() : null; } catch(e){ L = null; }
  return L || p || null;
}
// one held loop: started by start(o) when asked to sound, set(o) every frame after, stop() when its source goes; a
// start that fails (sound off, out of range) is tried again at most once a second (t: ms)
function heldLoop(start){
  var h = null, again = -Infinity;
  return {
    set: function(t, o){
      if(h){ try { h.set(o); } catch(e){} return; }
      if(t < again) return;
      again = t + 1000; h = loopOf(start(o));
    },
    stop: function(){ if(h){ try { h.stop(); } catch(e){} h = null; } again = -Infinity; }
  };
}
// where a vessel's sounds come from: its horn (the wheelhouse mast; the launch's stern), its engines (the hulls aft),
// the gangway's hinge (the cabin's after door on the pier's side)
function hornAt(v){
  var bus = v.kind !== "launch", q = toWorld(v, {x: 0, z: bus ? 5.4 : -3});
  return {x: q.x, y: v.y + (bus ? CRAFT.waterbus.floor + 4.6 : CRAFT.launch.floor + 1.2), z: q.z};
}
function hullAt(v){
  var q = toWorld(v, {x: 0, z: v.kind === "launch" ? -3 : -8});
  return {id: v.id, kind: v.kind, x: q.x, y: v.y + 0.8, z: q.z, speed: v.speed};
}
function gangAt(v){
  var q = toWorld(v, {x: (v.side || 1)*4.1, z: v.hz != null ? v.hz : GANG_Z});
  return {x: q.x, y: v.y + CRAFT.waterbus.floor, z: q.z};
}

/* ---------- drawing ---------- */
// one vertex-coloured BufferGeometry from boxes, cylinders and given geometries
function Geo(THREE){
  var pos = [], nor = [], col = [], m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sv = new THREE.Vector3(), pv = new THREE.Vector3(), cc = new THREE.Color();
  function add(g, color, x, y, z, rx, ry, rz, sx, sy, sz){
    var gg = g.index ? g.toNonIndexed() : g;
    if(gg !== g) g.dispose();
    e.set(rx || 0, ry || 0, rz || 0, "YXZ"); q.setFromEuler(e); pv.set(x || 0, y || 0, z || 0); sv.set(sx == null ? 1 : sx, sy == null ? 1 : sy, sz == null ? 1 : sz);
    gg.applyMatrix4(m4.compose(pv, q, sv));
    if(!gg.attributes.normal) gg.computeVertexNormals();
    var a = gg.attributes.position.array, n = gg.attributes.normal.array;
    cc.set(color);
    for(var i = 0; i < a.length; i++){ pos.push(a[i]); nor.push(n[i]); }
    for(i = 0; i < a.length; i += 3) col.push(cc.r, cc.g, cc.b);
    gg.dispose();
  }
  return {
    add: add,
    box: function(color, w, h, d, x, y, z, ry, rx, rz){ add(new THREE.BoxGeometry(w, h, d), color, x, y, z, rx, ry, rz); },
    cyl: function(color, r0, r1, h, x, y, z, rx, rz, seg, ry){ add(new THREE.CylinderGeometry(r0, r1, h, seg || 8), color, x, y, z, rx, ry, rz); },
    ball: function(color, r, x, y, z, sx, sy, sz){ add(new THREE.SphereGeometry(r, 10, 6), color, x, y, z, 0, 0, 0, sx, sy, sz); },
    torus: function(color, r, t, x, y, z, ry){ add(new THREE.TorusGeometry(r, t, 6, 14), color, x, y, z, 0, ry || 0, 0); },
    empty: function(){ return pos.length === 0; },
    geo: function(){
      var g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
      g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
      g.computeBoundingSphere();
      return g;
    }
  };
}
function figure(G, x, y, z, ry, shirt, sit){
  // a seated or standing person (the skipper): legs, body, arms, head, cap
  var c = Math.cos(ry || 0), s = Math.sin(ry || 0);
  function at(lx, lz){ return [x + lx*c + lz*s, z - lx*s + lz*c]; }
  var hip = sit ? 0.45 : 0.9, p;
  p = at(0, sit ? 0.2 : 0); G.box(0x2a3140, 0.34, sit ? 0.16 : 0.85, sit ? 0.45 : 0.22, p[0], y + (sit ? hip : hip/2), p[1], ry);
  p = at(0, 0); G.box(shirt, 0.42, 0.6, 0.24, p[0], y + hip + 0.32, p[1], ry);
  G.ball(0xd9a77f, 0.12, x, y + hip + 0.78, z);
  G.cyl(0x1d2a44, 0.13, 0.13, 0.06, x, y + hip + 0.88, z);
  p = at(0.27, 0.18); G.box(shirt, 0.1, 0.1, 0.42, p[0], y + hip + 0.4, p[1], ry);
  p = at(-0.27, 0.18); G.box(shirt, 0.1, 0.1, 0.42, p[0], y + hip + 0.4, p[1], ry);
}
// the 24 m catamaran: body (vertex colours) and glass (the panoramic windows, the wheelhouse's)
function waterbusGeo(THREE){
  var G = Geo(THREE), GL = Geo(THREE), F = CRAFT.waterbus.floor, hull = 0xf3f3ef, band = 0x1e88c8, dark = 0x2a3036, wood = 0x9a7350, seat = 0x2f5f8f, orange = 0xff6a1a;
  var hullG = HQV.hqboat && HQV.hqboat.hullGeo;
  [1, -1].forEach(function(sx){
    if(hullG) G.add(hullG(THREE, [[-12, 1.15, 1.05, 1.05, -0.4, -0.95], [-6, 1.25, 1.05, 1.15, -0.5, -1.05], [5, 1.25, 1.1, 1.1, -0.5, -1.05],
                                  [9.5, 0.85, 1.2, 0.6, -0.3, -0.85], [12.3, 0.05, 1.35, 0.02, 0.6, 0.5]]), hull, sx*2.95, 0, 0);
    else G.box(hull, 2.4, 2.1, 24, sx*2.95, 0, 0);
    G.box(band, 0.06, 0.32, 21, sx*(2.95 + 1.27), 0.65, -0.8);
  });
  G.box(hull, 8.4, 0.36, 23.4, 0, F - 0.18, -0.2);                     // the bridge deck
  G.box(0xcfd2d4, 8.0, 0.02, 22.8, 0, F + 0.01, -0.2);                 // its floor
  // the cabin: z -5 .. 8: a white lower wall, glass above, pillars, the roof
  [1, -1].forEach(function(sx){
    G.box(hull, 0.12, 0.8, 13, sx*3.85, F + 0.4, 1.5);
    for(var z = -5; z <= 8.01; z += 1.625) G.box(hull, 0.16, 1.3, 0.12, sx*3.87, F + 1.45, z);
    GL.box(0x203040, 0.06, 1.25, 13, sx*3.85, F + 1.45, 1.5);
  });
  G.box(hull, 7.7, 0.8, 0.12, 0, F + 0.4, 8.0); GL.box(0x203040, 7.5, 1.25, 0.06, 0, F + 1.45, 8.0);
  G.box(hull, 2.6, 2.1, 0.12, 2.5, F + 1.05, -5); G.box(hull, 2.6, 2.1, 0.12, -2.5, F + 1.05, -5); GL.box(0x203040, 2.4, 1.6, 0.06, 0, F + 1.1, -5);
  G.box(hull, 8.0, 0.16, 13.6, 0, F + 2.18, 1.5);                       // the roof
  G.box(band, 8.04, 0.12, 13.6, 0, F + 2.04, 1.5);
  // seats: 36 in rows of 2+2+2
  SEATS.waterbus.forEach(function(s){ G.box(seat, 0.44, 0.1, 0.44, s.x, F + s.y, s.z); G.box(seat, 0.44, 0.5, 0.07, s.x, F + s.y + 0.27, s.z - 0.22); G.box(dark, 0.06, 0.4, 0.06, s.x, F + 0.2, s.z); });
  // the wheelhouse on the roof, forward, with its skipper
  G.box(hull, 2.6, 0.9, 2.4, 0, F + 2.71, 6.0); GL.box(0x203040, 2.62, 0.7, 2.2, 0, F + 3.5, 6.1); G.box(hull, 2.9, 0.12, 2.8, 0, F + 3.9, 6.0);
  figure(G, 0, F + 2.26, 6.0, 0, 0x2f5f8f, true);
  G.cyl(dark, 0.04, 0.05, 1.4, 0, F + 4.6, 5.4); G.box(dark, 1.0, 0.06, 0.12, 0, F + 5.1, 5.4);
  // the stern deck: benches along each side and across, a rail round it, life rings
  [1, -1].forEach(function(sx){ G.box(wood, 0.5, 0.08, 5.0, sx*3.5, F + 0.45, -8.6); G.box(wood, 0.08, 0.45, 5.0, sx*3.8, F + 0.7, -8.6); G.box(dark, 0.4, 0.4, 0.08, sx*3.5, F + 0.2, -10.8); G.box(dark, 0.4, 0.4, 0.08, sx*3.5, F + 0.2, -6.4); });
  G.box(wood, 4.6, 0.08, 0.5, 0, F + 0.45, -11.4); G.box(wood, 4.6, 0.45, 0.08, 0, F + 0.7, -11.7);
  [[3.95, -12, 3.95, -5.2], [-3.95, -12, -3.95, -5.2], [3.95, -12, -3.95, -12], [3.95, 8.2, 3.95, 11], [-3.95, 8.2, -3.95, 11]].forEach(function(r){
    var dx = r[2] - r[0], dz = r[3] - r[1], L = Math.hypot(dx, dz), ry = Math.atan2(dx, dz);
    G.box(0xe8e8e8, 0.05, 0.05, L, (r[0] + r[2])/2, F + 1.0, (r[1] + r[3])/2, ry);
    for(var t = 0; t <= L; t += 1.2) G.box(0xe8e8e8, 0.05, 1.0, 0.05, r[0] + dx*t/L, F + 0.5, r[1] + dz*t/L);
  });
  [[3.98, -9.2, PI/2], [-3.98, -9.2, PI/2], [0, -12.05, 0], [3.95, 9.6, PI/2]].forEach(function(r){ G.torus(orange, 0.32, 0.07, r[0], F + 0.75, r[1], r[2]); });
  G.box(0xd8d8d8, 1.4, 0.5, 0.9, 0, F + 0.25, 10.4);                    // the bow's anchor locker
  return {body: G.geo(), glass: GL.geo()};
}
function launchGeo(THREE){
  var G = Geo(THREE), F = CRAFT.launch.floor, hull = 0x1f4f6f, wood = 0xb07a45, cream = 0xf1e6cf, stripe = 0xe9edf0, red = 0xc84b3c;
  var hullG = HQV.hqboat && HQV.hqboat.hullGeo;
  if(hullG) G.add(hullG(THREE, [[-4, 1.1, 0.55, 0.95, -0.15, -0.45], [-2, 1.3, 0.6, 1.15, -0.2, -0.55], [1.5, 1.25, 0.62, 1.05, -0.2, -0.5], [3.4, 0.6, 0.7, 0.35, 0.0, -0.3], [4.2, 0.03, 0.8, 0.01, 0.4, 0.3]]), hull, 0, 0, 0);
  else G.box(hull, 2.5, 1, 8, 0, 0, 0);
  G.box(wood, 2.2, 0.05, 6.8, 0, F, -0.2);
  [1, -1].forEach(function(sx){ G.box(cream, 0.42, 0.08, 4.4, sx*0.8, F + 0.38, -0.55); G.box(cream, 0.06, 0.4, 4.4, sx*1.02, F + 0.6, -0.55); G.box(wood, 0.06, 0.06, 7.2, sx*1.22, 0.62, -0.2); });
  [[0.95, -3.0], [-0.95, -3.0], [0.95, 2.0], [-0.95, 2.0]].forEach(function(p){ G.cyl(0xd8d8d8, 0.03, 0.03, 1.75, p[0], F + 0.88, p[1]); });
  for(var i = 0; i < 6; i++) G.box(i % 2 ? stripe : red, 2.2, 0.05, 0.86, 0, F + 1.78, -2.6 + i*0.86);
  figure(G, 0, F, -3.4, 0, 0x3f7f4f, true);
  G.box(0x8a8f94, 0.06, 0.06, 0.7, -0.35, F + 0.65, -3.0, 0.4);
  return G.geo();
}
function speedboatGeo(THREE){
  var G = Geo(THREE), F = CRAFT.taxi.floor, varnish = 0x8b4a1c, deck = 0xb8743a, cream = 0xf2e8d2, chrome = 0xd9dde0, glass = 0x24323c;
  var hullG = HQV.hqboat && HQV.hqboat.hullGeo;
  if(hullG) G.add(hullG(THREE, [[-4.5, 1.2, 0.75, 1.05, -0.1, -0.45], [-2.5, 1.3, 0.8, 1.15, -0.15, -0.55], [1.5, 1.2, 0.85, 0.95, -0.12, -0.5], [3.6, 0.65, 0.95, 0.35, 0.1, -0.25], [4.6, 0.03, 1.05, 0.01, 0.5, 0.35]]), varnish, 0, 0, 0);
  else G.box(varnish, 2.5, 1.4, 9, 0, 0, 0);
  G.box(deck, 2.3, 0.06, 3.4, 0, 0.84, 2.6);                          // the foredeck, planked
  for(var z = 1.2; z < 4.2; z += 0.5) G.box(cream, 2.2, 0.065, 0.03, 0, 0.845, z);
  G.box(deck, 2.4, 0.06, 1.6, 0, 0.84, -3.8);
  G.box(0x5a3418, 2.2, 0.05, 4.8, 0, F, -1.2);                         // the cockpit floor
  [[0, -2.6], [0, -0.1]].forEach(function(p){ G.box(cream, 2.0, 0.16, 0.55, p[0], F + 0.38, p[1]); G.box(cream, 2.0, 0.5, 0.1, p[0], F + 0.65, p[1] - 0.3); });
  G.box(glass, 2.0, 0.42, 0.05, 0, 1.1, 0.95, 0, -0.35); G.box(chrome, 2.06, 0.04, 0.05, 0, 1.32, 0.88);
  G.box(0x3a2010, 0.5, 0.45, 0.4, -0.5, F + 0.6, 0.6);                 // the helm
  G.cyl(chrome, 0.16, 0.16, 0.03, -0.5, F + 0.95, 0.42, PI/2 - 0.3);
  figure(G, -0.5, F, -0.1, 0, 0xf2f2f2, true);
  [1, -1].forEach(function(sx){ G.box(chrome, 0.04, 0.04, 6.4, sx*1.25, 0.9, -0.6); });
  G.box(0x1d1d1d, 0.5, 0.5, 0.4, 0, 0.3, -4.6);                        // the outdrive
  return G.geo();
}
function cruiserGeo(THREE){
  var G = Geo(THREE);
  var hullG = HQV.hqboat && HQV.hqboat.hullGeo;
  if(hullG) G.add(hullG(THREE, [[-3.4, 1.1, 0.7, 0.95, -0.1, -0.45], [-1, 1.25, 0.75, 1.1, -0.15, -0.5], [2, 1.0, 0.8, 0.8, -0.1, -0.4], [3.6, 0.03, 0.95, 0.01, 0.4, 0.3]]), 0xffffff, 0, 0, 0);
  else G.box(0xffffff, 2.4, 1.4, 7, 0, 0, 0);
  G.box(0xf0f0f0, 1.8, 0.8, 2.6, 0, 1.15, -0.3); G.box(0x2a3440, 1.84, 0.3, 2.2, 0, 1.25, -0.2);
  G.box(0xd9d9d9, 2.1, 0.05, 2.0, 0, 0.78, -2.3);
  return G.geo();
}
function pedaloGeo(THREE){
  var G = Geo(THREE);
  [1, -1].forEach(function(sx){ G.box(0xffffff, 0.6, 0.45, 2.8, sx*0.62, 0.1, 0); });
  G.box(0xf4f4f0, 1.75, 0.08, 2.3, 0, 0.36, -0.1); G.box(0x2f6f9f, 1.3, 0.5, 0.5, 0, 0.62, -0.6);
  G.box(0xffffff, 1.7, 0.05, 1.5, 0, 1.48, -0.3);
  [[0.75, -0.95], [-0.75, -0.95], [0.75, 0.35], [-0.75, 0.35]].forEach(function(q){ G.box(0x333333, 0.05, 1.05, 0.05, q[0], 0.95, q[1]); });
  return G.geo();
}
// the piers, the marina's pontoons, fuel pumps, the office, the lighthouse: one static mesh; the lamps and lit
// windows another (they glow at night)
function worksGeo(THREE, C){
  var G = Geo(THREE), L = Geo(THREE), V = C.V, timber = 0x8a6a4a, pile = 0x5a4632, dark = 0x2c3035, white = 0xf2f0ea, kiosk = 0x2f6f8f, warm = 0xffd9a0;
  V.piers.forEach(function(p){
    var wy = pierWaterY(C, p), yaw = p.yaw, top = p.y, len = Math.max(2, p.len), w = Math.max(1.5, p.w);
    function at(a, c){ return {x: p.x + p.fx*a + p.fz*c, z: p.z + p.fz*a - p.fx*c}; }
    G.box(timber, w, 0.3, len, p.x, top - 0.15, p.z, yaw);
    for(var a = -len/2 + 1; a <= len/2 + 0.01; a += 3) [1, -1].forEach(function(sd){
      var q = at(a, sd*(w/2 - 0.25)), h = Math.max(1, top - 0.3 - (wy - 2.5));
      G.cyl(pile, 0.16, 0.16, h, q.x, top - 0.3 - h/2, q.z, 0, 0, 6);
    });
    // bollards at the head's corners, a lamp each side every 10 m
    [1, -1].forEach(function(sd){ var q = at(len/2 - 0.4, sd*(w/2 - 0.3)); G.cyl(dark, 0.14, 0.17, 0.45, q.x, top + 0.22, q.z, 0, 0, 8); });
    for(var b = -len/2 + 4; b <= len/2 - 1; b += 10){
      var q2 = at(b, (w/2 - 0.2)*((b/10 | 0) % 2 ? 1 : -1));
      G.cyl(dark, 0.05, 0.06, 3.2, q2.x, top + 1.6, q2.z, 0, 0, 6);
      L.ball(warm, 0.18, q2.x, top + 3.25, q2.z);
    }
    if(p.kind !== "fuel"){
      // the kiosk at the landward end, with its board post beside it
      var k = at(-len/2 + 2.2, -(w/2 - 1.1));
      G.box(kiosk, 1.8, 2.3, 1.8, k.x, top + 1.15, k.z, yaw); G.box(white, 2.2, 0.12, 2.2, k.x, top + 2.36, k.z, yaw);
      var kw = at(-len/2 + 2.2 + 0.91, -(w/2 - 1.1)); L.box(warm, 1.2, 0.7, 0.04, kw.x, top + 1.5, kw.z, yaw);
      var bp = at(-len/2 + 4.0, -(w/2 - 0.5)); G.box(dark, 0.08, 2.2, 0.08, bp.x, top + 1.1, bp.z, yaw); G.box(dark, 2.6, 0.75, 0.12, bp.x, top + 2.2, bp.z, yaw);
    } else {
      [-1.5, 1.5].forEach(function(o){ var f = at(len/2 - 3, o*0.8); G.box(0xc8323c, 0.6, 1.3, 0.45, f.x, top + 0.65, f.z, yaw); G.box(white, 0.62, 0.25, 0.47, f.x, top + 1.2, f.z, yaw); });
    }
    if(p.kind === "hire"){ var sg = at(-len/2 + 1.2, w/2 - 0.3); G.box(dark, 0.08, 1.8, 0.08, sg.x, top + 0.9, sg.z, yaw); G.box(0xffb000, 1.4, 0.6, 0.06, sg.x, top + 1.8, sg.z, yaw); }
  });
  // the marina's finger pontoons beside each berth, and a spine joining their roots
  var roots = [];
  V.berths.forEach(function(b){
    var nearHire = V.piers.some(function(p){ var h = headOf(p); return p.kind === "hire" && d2(h.x, h.z, b.x, b.z) < 12; });
    if(nearHire) return;
    var wy = null; V.bodies.forEach(function(B){ if(B.id === b.body) wy = B.y; });
    if(wy == null) wy = C.sea;
    var top = wy + 0.45, lx = b.fz, lz = -b.fx;                    // left of `front`
    var cx = b.x + lx*2.2, cz = b.z + lz*2.2;
    G.box(0xb9b2a4, 0.9, 0.25, 8, cx, top - 0.12, cz, b.yaw);
    roots.push({x: cx - b.fx*4, z: cz - b.fz*4, y: top, body: b.body});
  });
  for(var i = 1; i < roots.length; i++){
    var a = roots[i - 1], c = roots[i], L2 = d2(a.x, a.z, c.x, c.z);
    if(a.body !== c.body || L2 > 14 || L2 < 0.5) continue;
    G.box(0xb9b2a4, 2.0, 0.25, L2 + 2, (a.x + c.x)/2, a.y - 0.12, (a.z + c.z)/2, Math.atan2(c.x - a.x, c.z - a.z));
  }
  // the harbour office (the doc's site), two storeys with a hipped roof
  var site = null;
  if(V.office != null) (C.W.sites || []).forEach(function(s){ if(s && s.id === V.office) site = s; });
  if(site){
    var sx = num(site.x, 0)/100, sz = num(site.z, 0)/100, gw = Math.min(14, num(site.w, 1200)/100*0.7), gd = Math.min(10, num(site.d, 900)/100*0.7);
    var gy = C.W && HQV.world && typeof HQV.world.groundAt === "function" ? num(HQV.world.groundAt(C.W, sx, sz), C.sea + 2) : C.sea + 2;
    G.box(white, gw, 6.2, gd, sx, gy + 3.1, sz); G.box(0x2f5f8f, gw + 0.6, 0.3, gd + 0.6, sx, gy + 6.35, sz);
    G.box(0x2f5f8f, gw*0.7, 1.2, gd*0.7, sx, gy + 7.0, sz);
    [1.6, 4.4].forEach(function(h){ L.box(warm, gw*0.8, 0.9, gd + 0.04, sx, gy + h, sz); L.box(warm, gw + 0.04, 0.9, gd*0.7, sx, gy + h, sz); });
  }
  // the lighthouse on the breakwater head: a white tower with red bands, a gallery, the lantern
  if(V.lighthouse){
    var lx2 = V.lighthouse[0], lz2 = V.lighthouse[1], by = C.sea + (HQV.world && HQV.world.BREAKWATER_UP != null ? HQV.world.BREAKWATER_UP : 1.5);
    G.cyl(white, 1.3, 1.8, 12, lx2, by + 6, lz2, 0, 0, 12);
    [3.5, 8].forEach(function(h){ G.cyl(0xc8323c, 1.25 + (12 - h)/12*0.5 - 0.02, 1.3 + (12 - h)/12*0.5, 1.6, lx2, by + h, lz2, 0, 0, 12); });
    G.cyl(dark, 1.9, 1.9, 0.2, lx2, by + 12.1, lz2, 0, 0, 12);
    L.cyl(0xfff2c4, 0.8, 0.8, 1.6, lx2, by + 13.0, lz2, 0, 0, 10);
    G.cyl(0xc8323c, 0.2, 1.0, 1.0, lx2, by + 14.3, lz2, 0, 0, 10);
  }
  return {works: G.empty() ? null : G.geo(), lamps: L.empty() ? null : L.geo(), top: V.lighthouse ? C.sea + 1.5 + 13.0 : 0};
}
function gangwayGeo(THREE){
  var G = Geo(THREE);
  G.box(0xa8adb2, 2.6, 0.06, 1.1, 1.3, 0, 0);
  [0.52, -0.52].forEach(function(z){ G.box(0xd8dde2, 2.6, 0.04, 0.04, 1.3, 0.95, z); for(var x = 0.1; x <= 2.6; x += 0.85) G.box(0xd8dde2, 0.04, 0.95, 0.04, x, 0.48, z); });
  return G.geo();
}
function bowGeo(THREE){
  // a V of foam ahead of the bows, its tip at the origin, opening backwards (-z); scaled by speed
  var pos = [], i;
  [1, -1].forEach(function(sx){
    var a = [0, 0, 0.2], b = [sx*3.2, 0, -7], c = [sx*4.4, 0, -6.2], d = [sx*0.6, 0, 0.6];
    pos.push.apply(pos, a.concat(b, c, a, c, d));
  });
  var g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals(); g.computeBoundingSphere();
  return g;
}
function view(c, sim, opts){
  opts = opts || {};
  var THREE = c.THREE, group = new THREE.Group(); group.name = "hqferries";
  var W = sim && sim._c ? sim._c : null;          // the world's water context (metres, the coast, levels)
  var calm = typeof opts.calm === "function" ? opts.calm : function(){ return false; };
  var night = typeof opts.night === "function" ? opts.night : function(){ return false; };
  var lines = sim ? sim.lines() : [];
  var nBus = 0, nLaunch = 0;
  lines.forEach(function(l){ var R = sim.route(l.id); if(l.kind === "launch") nLaunch += R.n; else nBus += R.n; });
  var parts = [], meshes = {};
  function inst(name, geo, mat, max){
    var m = new THREE.InstancedMesh(geo, mat, Math.max(1, max));
    m.count = 0; m.frustumCulled = false; m.name = "hqferries-" + name; m.castShadow = name !== "bow" && name !== "glass"; m.receiveShadow = false;
    if(m.instanceMatrix.setUsage) m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(m); meshes[name] = m; parts.push({geo: geo, mat: mat});
    return m;
  }
  var vc = function(r){ return new THREE.MeshStandardMaterial({vertexColors: true, roughness: r != null ? r : 0.6, metalness: 0.05}); };
  var glassM = new THREE.MeshStandardMaterial({color: 0x9fc4d8, roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.38, depthWrite: false,
                                               emissive: new THREE.Color(0xffcf8a), emissiveIntensity: 0});
  if(nBus){
    var WB = waterbusGeo(THREE);
    inst("waterbus", WB.body, vc(0.5), nBus);
    inst("glass", WB.glass, glassM, nBus);
    inst("gangway", gangwayGeo(THREE), vc(0.4), nBus);
  }
  if(nLaunch) inst("launch", launchGeo(THREE), vc(0.6), nLaunch);
  if(nBus + nLaunch){
    var bowM = new THREE.MeshBasicMaterial({color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide});
    inst("bow", bowGeo(THREE), bowM, nBus + nLaunch).renderOrder = 2;
  }
  // the static works, the glow, the moored boats, the hire boats waiting at their jetties
  var works = W ? worksGeo(THREE, W) : {works: null, lamps: null};
  var lampM = new THREE.MeshStandardMaterial({vertexColors: true, roughness: 0.4, emissive: new THREE.Color(0xffd9a0), emissiveIntensity: 0});
  if(works.works){ var wm = new THREE.Mesh(works.works, vc(0.85)); wm.name = "hqferries-works"; wm.castShadow = true; wm.receiveShadow = true; group.add(wm); meshes.works = wm; parts.push({geo: works.works, mat: wm.material}); }
  if(works.lamps){ var lm = new THREE.Mesh(works.lamps, lampM); lm.name = "hqferries-lamps"; group.add(lm); meshes.lamps = lm; parts.push({geo: works.lamps, mat: lampM}); }
  var moored = [], hireIdle = [], seedS = sim ? String(sim.seed) : "x";
  if(W){
    W.V.berths.forEach(function(b, i){
      var h = hash32(seedS + ":berth:" + i), nearHire = W.V.piers.some(function(p){ var hd = headOf(p); return p.kind === "hire" && d2(hd.x, hd.z, b.x, b.z) < 12; });
      var y = null; W.V.bodies.forEach(function(B){ if(B.id === b.body) y = B.y; });
      if(y == null) y = W.sea;
      if(nearHire) hireIdle.push({x: b.x, z: b.z, y: y, yaw: b.yaw + (h % 2 ? 0.05 : -0.05)});
      else if((h % 100) < 78) moored.push({x: b.x, z: b.z, y: y, yaw: b.yaw + ((h >> 8) % 2 ? 0 : PI), col: [0xffffff, 0xe8eef2, 0x1d3f6a, 0xf5efe0, 0x8f2a2a, 0x2a5f4a][(h >> 12) % 6], s: 0.85 + ((h >> 16) % 30)/100});
    });
  }
  var M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(), S = new THREE.Vector3(1, 1, 1), P = new THREE.Vector3(), COL = new THREE.Color();
  function setAt(m, i, x, y, z, yaw, pitch, roll, sx, sy, sz){
    E.set(pitch || 0, yaw || 0, roll || 0, "YXZ"); Q.setFromEuler(E); P.set(x, y, z); S.set(sx == null ? 1 : sx, sy == null ? 1 : sy, sz == null ? 1 : sz);
    m.setMatrixAt(i, M4.compose(P, Q, S));
  }
  if(moored.length){
    var mm = inst("moored", cruiserGeo(THREE), vc(0.5), moored.length);
    moored.forEach(function(b, i){ setAt(mm, i, b.x, b.y - 0.15, b.z, b.yaw, 0, 0, b.s, b.s, b.s); mm.setColorAt(i, COL.set(b.col)); });
    mm.count = moored.length; mm.instanceMatrix.needsUpdate = true; if(mm.instanceColor) mm.instanceColor.needsUpdate = true;
  }
  if(hireIdle.length){
    var hm = inst("hire", pedaloGeo(THREE), vc(0.5), hireIdle.length);
    hireIdle.forEach(function(b, i){ setAt(hm, i, b.x, b.y - 0.12, b.z, b.yaw); hm.setColorAt(i, COL.set([0xf2c230, 0xe2572e, 0x2f8f5b, 0x2f6f9f][i % 4])); });
    hm.count = hireIdle.length; hm.instanceMatrix.needsUpdate = true; if(hm.instanceColor) hm.instanceColor.needsUpdate = true;
  }
  // the lighthouse's beam: two long fans from the lantern, seen at night
  var beam = null;
  if(W && W.V.lighthouse){
    var bp = [], Lb = 70, wdt = 6;
    [1, -1].forEach(function(sd){ bp.push(0, 0, 0, sd*Lb, -wdt, 0, sd*Lb, wdt, 0, 0, 0, 0, sd*Lb, 0, -wdt, sd*Lb, 0, wdt); });
    var bg = new THREE.BufferGeometry(); bg.setAttribute("position", new THREE.Float32BufferAttribute(bp, 3)); bg.computeBoundingSphere();
    var bmat = new THREE.MeshBasicMaterial({color: 0xfff2c4, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending});
    beam = new THREE.Mesh(bg, bmat); beam.name = "hqferries-beam"; beam.position.set(W.V.lighthouse[0], works.top, W.V.lighthouse[1]); beam.visible = false;
    group.add(beam); parts.push({geo: bg, mat: bmat});
    // steady (Calm, reduced motion): pointing out to sea, away from the island's centre
    beam.userData.rest = -Math.atan2(W.V.lighthouse[1], W.V.lighthouse[0]);
  }
  // the live departure board at the nearest pier (one canvas strip of hqRide's shared atlas)
  var board = null, boardMesh = null, boardPier = null;
  var boardStops = sim ? sim.stops() : [];
  function boardFor(stop){
    var R = HQV.hqRide;
    if(!R || typeof R.boardTexture !== "function") return;
    if(!board){
      board = R.boardTexture(THREE, [], {at: {x: stop.x, z: stop.z}});
      if(!board) return;
      var g = new THREE.PlaneGeometry(2.5, 2.5/board.aspect*1.0);
      board.applyUv(g);
      var bm = new THREE.MeshBasicMaterial({map: board.texture, toneMapped: false});
      boardMesh = new THREE.Mesh(g, bm); boardMesh.name = "hqferries-board"; group.add(boardMesh); parts.push({geo: g, mat: bm});
    }
    var p = null;
    if(W) W.V.piers.forEach(function(q){ if(q.id === stop.id) p = q; });
    if(!p) return;
    var a = -p.len/2 + 4.0, cc = -(Math.max(1.5, p.w)/2 - 0.5);
    boardMesh.position.set(p.x + p.fx*a + p.fz*cc, p.y + 2.2, p.z + p.fz*a - p.fx*cc);
    boardMesh.rotation.set(0, p.yaw, 0);
    boardMesh.translateZ(0.07);
    boardPier = stop.id;
  }
  var last = {ms: 0, list: [], cam: null}, focusId = null, prev = {}, lapT = 0, t0 = null;
  // the water laps at every pier's head (the stops, the hire and fuel jetties), at the water's level there
  var lapSpots = [];
  if(W) W.V.piers.forEach(function(p){ var hd = headOf(p); lapSpots.push({x: hd.x, y: pierWaterY(W, p) + 0.2, z: hd.z}); });
  else boardStops.forEach(function(s){ lapSpots.push({x: s.x, y: s.y, z: s.z}); });
  // the engines: the nearest HUM_VOICES vessels within earshot each hold an engine-hum loop that follows the hull
  // (made once a vessel comes near, handed on to the next one of its kind, stopped when idle: none ever leaks)
  var humP = null;
  function hums(){
    var E = HQV.engine;
    if(!humP && E && typeof E.pool === "function" && typeof opts.sfx === "function")
      humP = E.pool("boat", {voices: HUM_VOICES, idle: 2, key: function(s){ return s.kind; },
        make: function(s){ return loopOf(sound(opts.sfx, "engine-hum", {pos: s, kind: "boat", speed: s.speed, gain: s.kind === "launch" ? 0.5 : 1})); },
        play: function(h, s){ h.set({pos: s, speed: s.speed}); }});
    return humP;
  }
  function update(ms, dt, cam){
    ms = num(ms, 0); dt = Math.max(0, num(dt, 0));
    if(t0 == null) t0 = ms;
    var cx = cam ? num(cam.x, 0) : 0, cz = cam ? num(cam.z, 0) : 0, cy = cam ? num(cam.y, 0) : 0, quiet = !!calm(), nt = !!night();
    var list = sim ? sim.vehicles(ms) : [], tt = (ms - t0)/1000, amp = quiet ? 0.3 : 1;
    var jump = Math.abs(ms - last.ms) > 5000;          // a jump in time (the first frame, a skip): no sounds for what changed
    last.ms = ms; last.list = list; last.cam = {x: cx, y: cy, z: cz};
    var ib = 0, il = 0, iw = 0, sfx = jump ? null : opts.sfx;
    var ear = earOf(cam), ex = ear ? num(ear.x, 0) : cx, ez = ear ? num(ear.z, 0) : cz, hornM = reach("horn", 1500), doorM = reach("door", 40);
    list.forEach(function(v){
      var d = d2(v.x, v.z, cx, cz);
      // sounds: the horn on leaving a pier, the gangway landing; each where it is, within its kind's earshot
      var was = prev[v.id];
      if(was && sfx){
        if(was.stop && !v.stop){ var hp = hornAt(v); if(d2(hp.x, hp.z, ex, ez) < hornM) sound(sfx, "ferry-horn", {pos: hp, kind: "horn"}); }
        if(v.kind !== "launch" && was.doors < 1 && v.doors >= 1){ var gp = gangAt(v); if(d2(gp.x, gp.z, ex, ez) < doorM) sound(sfx, "gangway-clank", {pos: gp, kind: "door"}); }
      }
      prev[v.id] = {stop: v.stop, doors: v.doors};
      if(d > LOD) return;
      var h = hash32(v.id), ph = (h % 1000)/1000*PI*2;
      var heave = (0.05*Math.sin(tt*0.9 + ph) + 0.02*Math.sin(tt*1.7 + ph*2))*amp, roll = 0.012*Math.sin(tt*0.7 + ph)*amp, pitch = 0.006*Math.sin(tt*0.8 + ph*3)*amp - (v.speed > 2 ? 0.008 : 0);
      if(v.kind === "launch" && meshes.launch){ setAt(meshes.launch, il++, v.x, v.y + heave - 0.05, v.z, v.yaw, pitch, roll); }
      else if(meshes.waterbus){
        setAt(meshes.waterbus, ib, v.x, v.y + heave, v.z, v.yaw, pitch, roll);
        setAt(meshes.glass, ib, v.x, v.y + heave, v.z, v.yaw, pitch, roll);
        // the gangway: hinged at the cabin's after door on the pier's side; swings from stowed (along the rail) out
        // to the pier; Calm: there or not, no swing
        var side = v.side || 1, out = quiet ? (v.doors > 0 ? 1 : 0) : smooth01(v.doors);
        var hl = toWorld({x: v.x, z: v.z, yaw: v.yaw}, {x: side*4.1, z: v.hz != null ? v.hz : GANG_Z});
        setAt(meshes.gangway, ib, hl.x, v.y + heave + CRAFT.waterbus.floor + 0.02, hl.z, v.yaw + PI/2 - side*(PI/2)*out, 0, out > 0 ? -0.06*out : 0);
        ib++;
      }
      if(meshes.bow){
        var k = clamp(v.speed/9, 0, 1), L = v.kind === "launch" ? CRAFT.launch.len : CRAFT.waterbus.len, bw = toWorld({x: v.x, z: v.z, yaw: v.yaw}, {x: 0, z: L/2 - 0.5});
        var sc = v.speed > 0.6 ? (v.kind === "launch" ? 0.35 : 1)*(0.3 + 0.7*k) : 0;
        setAt(meshes.bow, iw++, bw.x, v.y + 0.06, bw.z, v.yaw, 0, 0, sc || 1e-4, 1, sc || 1e-4);
      }
    });
    ["waterbus", "glass", "gangway"].forEach(function(n){ if(meshes[n]){ meshes[n].count = ib; meshes[n].instanceMatrix.needsUpdate = true; } });
    if(meshes.launch){ meshes.launch.count = il; meshes.launch.instanceMatrix.needsUpdate = true; }
    if(meshes.bow){ meshes.bow.count = iw; meshes.bow.instanceMatrix.needsUpdate = true; }
    // the engines (every water bus, idling at a pier or under way; a launch under way): the pool sounds the nearest
    var HP = hums();
    if(HP){ var hs = []; list.forEach(function(v){ if(v.kind !== "launch" || v.speed > 0.5) hs.push(hullAt(v)); }); HP.update(hs); }
    // the water lapping at the nearest pier head within earshot, a lap every 4-6 s (seeded by the clock)
    if(sfx && lapSpots.length){
      var lp = null, ld = reach("water", 60);
      lapSpots.forEach(function(s){ var dd = d2(s.x, s.z, ex, ez); if(dd < ld){ ld = dd; lp = s; } });
      if(lp){ lapT -= dt; if(lapT <= 0){ lapT = 4 + (hash32(seedS + Math.floor(ms/4000)) % 3); sound(sfx, "water-lap", {pos: lp, kind: "water"}); } }
    }
    // night: lit windows, lamps, the lighthouse's beam (a slow sweep; Calm: still, pointing out to sea)
    var glow = nt ? 1.4 : 0;
    if(glassM.emissiveIntensity !== (nt ? 0.9 : 0)) glassM.emissiveIntensity = nt ? 0.9 : 0;
    if(lampM.emissiveIntensity !== glow) lampM.emissiveIntensity = glow;
    if(beam){ beam.visible = nt; beam.rotation.y = quiet ? beam.userData.rest : beam.userData.rest + (ms/1000*0.5) % (PI*2); }
    // the board: the nearest pier within 150 m
    var bs = null, bsd = 150;
    boardStops.forEach(function(s){ var d = d2(s.x, s.z, cx, cz); if(d < bsd){ bsd = d; bs = s; } });
    if(bs){
      if(boardPier !== bs.id) boardFor(bs);
      if(board && boardMesh){
        boardMesh.visible = true;
        var R = HQV.hqRide, rows = R && R.boardRows ? R.boardRows(sim.departures(bs.id, ms, 4), ms) : [];
        board.draw(rows, ms, boardPier !== bs.id);
      }
    } else if(boardMesh) boardMesh.visible = false;
  }
  function drawCalls(){
    var n = 0;
    Object.keys(meshes).forEach(function(k){ var m = meshes[k]; if(m.visible && (!m.isInstancedMesh || m.count > 0)) n++; });
    if(beam && beam.visible) n++;
    if(boardMesh && boardMesh.visible) n++;
    return n;
  }
  function shotCam(name){
    if(!sim || !W) return null;
    var st = sim.stops(), V = W.V;
    function pierOf(kind){ var out = null; V.piers.forEach(function(p){ if(!out && p.kind === kind && st.some(function(s){ return s.id === p.id; })) out = p; }); return out; }
    if(name === "waterbus-pier"){
      var p = pierOf("waterbus");
      if(!p) return null;
      var h = headOf(p), b = -p.len/2 + 2;
      return {pos: {x: p.x + p.fx*b, y: p.y + 1.7, z: p.z + p.fz*b}, look: {x: h.x + p.fx*14, y: pierWaterY(W, p) + 2, z: h.z + p.fz*14}, fov: 60};
    }
    if(name === "waterbus-cabin"){
      var wl = lines.filter(function(l){ return l.kind !== "launch"; })[0];
      if(!wl) return null;
      var v = sim.vessel(wl.id, focusId && focusId.indexOf(wl.id + ":") === 0 ? +focusId.split(":")[1] : 0, last.ms), s0 = SEATS.waterbus[13];
      var sp = toWorld(v, {x: s0.x, z: s0.z - 0.1}), lk = toWorld(v, {x: s0.x - 0.4, z: s0.z + 12});
      return {pos: {x: sp.x, y: v.floor + s0.y + 1.15, z: sp.z}, look: {x: lk.x, y: v.floor + 1.3, z: lk.z}, fov: 70};
    }
    if(name === "marina"){
      var mb = null; V.bodies.forEach(function(bd){ if(!mb && bd.kind === "marina") mb = bd; });
      if(!mb) return null;
      var mx = (mb.box.x0 + mb.box.x1)/2, mz = (mb.box.z0 + mb.box.z1)/2, from = V.lighthouse ? {x: V.lighthouse[0], z: V.lighthouse[1]} : {x: mb.box.x1 + 30, z: mb.box.z1 + 30};
      var dx = from.x - mx, dz = from.z - mz, dl = Math.hypot(dx, dz) || 1;
      return {pos: {x: from.x + dx/dl*25, y: W.sea + 30, z: from.z + dz/dl*25}, look: {x: mx, y: W.sea, z: mz}, fov: 55};
    }
    if(name === "lake-launch"){
      var lp = pierOf("launch"), ll = lines.filter(function(l){ return l.kind === "launch"; })[0];
      if(!lp) return null;
      var lh = headOf(lp), tgt = ll ? sim.vessel(ll.id, 0, last.ms) : null;
      return {pos: {x: lp.x - lp.fx*lp.len*0.5 + lp.fz*3, y: lp.y + 3.5, z: lp.z - lp.fz*lp.len*0.5 - lp.fx*3},
              look: tgt ? {x: tgt.x, y: tgt.y + 1, z: tgt.z} : {x: lh.x + lp.fx*30, y: lp.y, z: lh.z + lp.fz*30}, fov: 55};
    }
    return null;
  }
  function wakes(){
    var cam = last.cam || {x: 0, z: 0};
    return last.list.filter(function(v){ return v.speed > 0.5; })
      .map(function(v){ return {id: "ferry:" + v.id, x: v.x, z: v.z, yaw: v.yaw, speed: v.speed, beam: v.kind === "launch" ? CRAFT.launch.beam : CRAFT.waterbus.beam, d: d2(v.x, v.z, cam.x, cam.z)}; })
      .sort(function(a, b){ return a.d - b.d; }).slice(0, 4);
  }
  function dispose(){
    if(humP){ humP.stop(); humP = null; }
    parts.forEach(function(p){ p.geo.dispose(); if(p.mat && p.mat.dispose) p.mat.dispose(); });
    Object.keys(meshes).forEach(function(k){ if(meshes[k].dispose) meshes[k].dispose(); });
    if(board) board.dispose();
    if(group.parent) group.parent.remove(group);
  }
  if(opts.parent) opts.parent.add(group);
  else if(c.scene) c.scene.add(group);
  update(0, 0, null);
  return {group: group, update: update, focus: function(id){ focusId = id == null ? null : String(id); }, drawCalls: drawCalls,
          wakes: wakes, vessels: function(){ return last.list.slice(); }, tools: {shotCam: shotCam}, dispose: dispose};
}

/* ---------- the water-taxi controller ---------- */
function taxiController(c, w, deps){
  deps = deps || {};
  var W = deps.W || (w && w.W) || w, C = ctxOf(W);
  var now = typeof deps.now === "function" ? deps.now : function(){ return Date.now(); };
  var calm = typeof deps.calm === "function" ? deps.calm : function(){ return false; };
  var announce = typeof deps.announce === "function" ? deps.announce : function(){};
  var seed = deps.seed != null ? String(deps.seed) : (C ? C.id : "world");
  var cur = null, n = 0, model = null, THREE = c && c.THREE;
  // its engine: one held engine-hum loop at the outdrive while it comes, waits, runs you over and lingers
  var hum = heldLoop(function(o){ return sound(deps.sfx, "engine-hum", o); });
  function say(t){ try { announce(t); } catch(e){} }
  function meNow(){ try { return typeof deps.me === "function" ? deps.me() : null; } catch(e){ return null; } }
  function sternAt(P){ var q = toWorld(P, {x: 0, z: -4.2}); return {x: q.x, y: (P.water != null ? P.water : P.y - CRAFT.taxi.floor) + 0.4, z: q.z}; }
  // P: the taxi's pose this frame, null when there is none to hear (its engine stops)
  function engineAt(ms, P){
    if(!P){ hum.stop(); return; }
    var at = sternAt(P), ear = earOf(meNow()), dd = ear ? d2(at.x, at.z, num(ear.x, 0), num(ear.z, 0)) : 0, M = reach("boat", 400);
    if(dd < M) hum.set(ms, {pos: at, kind: "boat", speed: P.speed});
    else if(dd > M*1.1) hum.stop();
  }
  function nearestPier(x, z, to){
    if(!C) return null;
    var best = null, bd = Infinity;
    C.V.piers.forEach(function(p){ var h = headOf(p), d = d2(h.x, h.z, x, z); if(d < bd && p.id !== to && (!to || pathBetween(C, p.id, to))){ bd = d; best = p.id; } });
    return best;
  }
  function request(from, to){
    if(!C || !to) return null;
    if(cur && (cur.st === "coming" || cur.st === "here" || cur.st === "riding")) cur.cancel();
    if(!from && typeof deps.me === "function"){ var me = deps.me() || {}; from = nearestPier(num(me.x, 0), num(me.z, 0), to); }
    if(!from || from === to) return null;
    var ms = num(now(), 0), ride0 = taxi(W, from, to, ms, seed);
    if(!ride0){ say("No water route between those piers."); return null; }
    var st0 = taxiStart(C, from, seed), app = null;
    if(st0 && !st0.here){ var pts = pathBetween(C, st0.from, from); if(pts) app = taxiTrip(C, pts, null, from, ms, seed, "approach:" + from + ":" + Math.floor(ms/60000)); }
    var h = {id: "wtaxi:" + (++n), from: from, to: to, skipper: ride0.skipper, approach: app, ride: null, st: app ? "coming" : "here",
             hereAt: app ? app.reach : ms, doneAt: 0, said: {}};
    h.fromName = ride0.fromName; h.toName = ride0.toName;
    h.state = function(){
      var t = num(now(), 0);
      if(h.st === "coming") return {state: "coming", eta: Math.max(0, (h.approach.reach - t)/1000), metres: Math.max(0, h.approach.metres*(1 - clamp((t - h.approach.depart)/Math.max(1, h.approach.reach - h.approach.depart), 0, 1)))};
      if(h.st === "riding") return {state: "riding", eta: Math.max(0, (h.ride.reach - t)/1000), metres: Math.max(0, h.ride.metres*(1 - clamp((t - h.ride.depart)/Math.max(1, h.ride.reach - h.ride.depart), 0, 1)))};
      return {state: h.st, eta: 0, metres: 0};
    };
    h.board = function(){
      if(h.st !== "here") return false;
      var t = num(now(), 0), r = taxi(W, h.from, h.to, t, seed);
      if(!r){ h.cancel(); return false; }
      h.ride = r; h.ride.skipper = h.skipper; h.st = "riding";
      say("Water taxi to " + h.toName + ". About " + Math.max(1, Math.round(r.secs/60)) + " min.");
      return true;
    };
    h.cancel = function(){ if(h.st === "done" || h.st === "cancelled") return; h.st = "cancelled"; say("Water taxi cancelled."); };
    h.pose = function(t){
      t = num(t, num(now(), 0));
      if(h.st === "coming" && h.approach) return h.approach.pose(t);
      if(h.st === "riding" || h.st === "done") return h.ride ? h.ride.pose(Math.min(t, h.ride.reach)) : null;
      var p = pierById(C, h.from), b = berthPoint(C, p, TAXI.off);
      return {x: b.x, y: pierWaterY(C, p) + CRAFT.taxi.floor, z: b.z, yaw: wrapPi(p.yaw + PI/2), speed: 0, water: pierWaterY(C, p)};
    };
    h.ashore = function(){
      var p = pierById(C, h.st === "done" ? h.to : h.from);
      if(!p) return null;
      var hd = headOf(p);
      return {x: hd.x - p.fx*1.5, y: p.y, z: hd.z - p.fz*1.5, yaw: wrapPi(p.yaw + PI)};
    };
    cur = h;
    say(app ? "Water taxi on its way. Skipper " + h.skipper + ", about " + Math.max(1, Math.round((app.reach - ms)/60000)) + " min." : "Your water taxi is at " + h.fromName + ".");
    return h;
  }
  function update(ms, dt){
    ms = ms != null ? num(ms, 0) : num(now(), 0);
    var h = cur;
    if(h){
      if(h.st === "coming" && ms >= h.approach.reach){
        h.st = "here"; h.hereAt = ms; say("Your water taxi is here at " + h.fromName + ". Press E to board.");
        var pz = h.pose(ms);
        sound(deps.sfx, "gangway-clank", pz ? {pos: {x: pz.x, y: (pz.water != null ? pz.water : pz.y) + 0.9, z: pz.z}, kind: "door", gain: 0.5} : {gain: 0.5});
      }
      if(h.st === "coming"){ var left = (h.approach.reach - ms)/1000, mark = Math.ceil(left/30); if(left > 5 && mark !== h.said.m && left % 30 < 1.5){ h.said.m = mark; say("Water taxi: " + Math.max(1, Math.round(left/60)) + " min."); } }
      if(h.st === "here" && ms - h.hereAt > TAXI.wait*1000){ h.st = "cancelled"; say("The water taxi could not wait any longer."); }
      if(h.st === "riding" && ms >= h.ride.reach){ h.st = "done"; h.doneAt = ms; say("Arrived at " + h.toName + "."); }
    }
    var show = h && (h.st === "coming" || h.st === "here" || h.st === "riding" || (h.st === "done" && ms - h.doneAt < TAXI.linger*1000));
    engineAt(ms, show ? h.pose(ms) : null);
    if(THREE){
      if(show && !model){
        model = new THREE.Mesh(speedboatGeo(THREE), new THREE.MeshStandardMaterial({vertexColors: true, roughness: 0.35, metalness: 0.1}));
        model.name = "hqferries-taxi"; model.castShadow = true;
        if(deps.parent) deps.parent.add(model); else if(c.scene) c.scene.add(model);
      }
      if(model){
        model.visible = !!show;
        if(show){
          var P = h.pose(ms), amp = calm() ? 0.3 : 1, tt = ms/1000;
          model.position.set(P.x, (P.water != null ? P.water : P.y - CRAFT.taxi.floor) + 0.04*Math.sin(tt*1.1)*amp, P.z);
          model.rotation.set(-(P.speed > 4 ? 0.04 : 0) + 0.01*Math.sin(tt*0.9)*amp, P.yaw, 0.015*Math.sin(tt*0.7)*amp, "YXZ");
        }
      }
    }
  }
  function carry(ms){
    var h = cur;
    if(!h || h.st !== "riding") return null;
    var s = h.ride.seat(0, num(ms, num(now(), 0)));
    return {x: s.x, y: s.y, z: s.z, yaw: s.yaw, anim: "sit"};
  }
  function camPose(ms, look){
    var h = cur;
    if(!h || h.st !== "riding") return null;
    ms = num(ms, num(now(), 0));
    var s = h.ride.seat(0, ms), P = h.ride.pose(ms), R = HQV.hqRide;
    if(R && typeof R.seatCam === "function") return R.seatCam(s, P, look || {yaw: 0, pitch: 0}, "seat", !!calm());
    var ly = s.yaw + num(look && look.yaw, 0);
    return {camera: true, pos: {x: s.x, y: s.y + 1.15, z: s.z}, look: {x: s.x + Math.sin(ly)*10, y: s.y + 1.0, z: s.z + Math.cos(ly)*10}, up: {x: 0, y: 1, z: 0}, fov: 70};
  }
  return {
    request: request, update: update, carry: carry, camPose: camPose,
    active: function(){ return cur && (cur.st === "coming" || cur.st === "here" || cur.st === "riding") ? cur : null; },
    cancel: function(){ if(cur) cur.cancel(); },
    drawCalls: function(){ return model && model.visible ? 1 : 0; },
    tools: {shotCam: function(name){
      if(name !== "water-taxi" || !cur) return null;
      var P = cur.pose(num(now(), 0));
      return {pos: {x: P.x - Math.sin(P.yaw)*12 + Math.cos(P.yaw)*6, y: P.y + 4, z: P.z - Math.cos(P.yaw)*12 - Math.sin(P.yaw)*6}, look: {x: P.x, y: P.y, z: P.z}, fov: 55};
    }},
    dispose: function(){ hum.stop(); if(model){ model.geometry.dispose(); model.material.dispose(); if(model.parent) model.parent.remove(model); model = null; } }
  };
}

HQV.hqFerries = {create: create, view: view, taxi: taxi, taxiPath: taxiPath, taxiTargets: taxiTargets, taxiController: taxiController, piers: piers,
  SEATS: SEATS, STAND: STAND, CRAFT: CRAFT, HEAD: HEAD, SPEED: SPEED, TAXI: TAXI, DWELL: DWELL, TURN: TURN, LAUNCH_V: LAUNCH_V, ACC: ACC,
  legPose: legPose, wetAt: function(W, x, z){ var C = ctxOf(W); return C ? wetAt(C, x, z) : null; }};
})();
