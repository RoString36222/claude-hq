/* Claude HQ: flights between cities (HQV.hqAir). Pure: no THREE, no DOM.
 *
 * Two kinds of flight, both in ARCHIPELAGO metres (a city's own frame plus its archipelago position, like
 * games/hqvoyage.js), so one flight serves both cities:
 *   "jet"   airport to airport: taxi from the stand to the runway's threshold, hold, a takeoff roll out toward the
 *           sea (to ~75 m/s), rotate, climb, cruise at ~600 m, a descent onto the destination's extended centreline,
 *           a 3° glideslope, flare, touchdown, rollout back toward the threshold, taxi nose-in to the stand.
 *   "sea"   a seaplane, dock to dock, for a city without an airport: taxi down the river (hqvoyage.inland) and out of
 *           its mouth, a takeoff run on the sea, a low cruise, a glideslope onto the water off the other mouth,
 *           then up its river to the berth. Every island has a dock, so every island is reachable by air.
 * The runway is the airport site's long axis, from its middle out through its back (away from its front, the
 * terminal's side) for RUNWAY m: on the Commons that runs over the beach and out on piles over the water.
 *   airportEnd(site, cx, cz, y)  an airport's end: {taxi: [[x, z] stand .. threshold], dir: [ux, uz] takeoff
 *                                heading (unit), len (runway m), y (runway top), kind: "jet"}
 *   dockEnd(W, cx, cz, toward)   a dock's end for a seaplane (W null: a nominal river facing `toward` [x, z])
 *   nominalAirport(cx, cz, toward) an airport we have no doc for
 *   route(kind, A, B, ends)      ends {a, b} as above (+ world ids on A, B) -> R:
 *        {pts (x, z pairs), y, s, v, t (Float64Arrays), T (s), len, hand (s: when to move into B's city),
 *         sLift, sTD, sFAF, sPeak, tRoll, cruiseY, kind, from, to, A, B}
 *   poseAt(R, t)  -> {x, y, z, yaw, pitch, roll (+ = banked left: left wing down), speed, phase, gear (0 up .. 1 down),
 *                     along, u}; phase: taxi, takeoff, climb, cruise, descent, approach, flare, rollout, parked
 *   flights(a, b, nowMs, back, ahead, every)  departures (ms) a -> b around now, the same on every client
 *   nextFlight(a, b, nowMs, every)
 *   ambient(places, nowMs, cx, cz, radius) scenic traffic high over the archipelago: [{id, x, y, z, yaw, speed, trail}]
 * yaw 0 faces +z, increasing turns left (toward +x), as hqvoyage.
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};

var G = 9.81, STEP = 25, STEP_G = 5, DEG = Math.PI/180, GS = Math.tan(3*DEG);
var RUNWAY = 500;                 // m of runway from the site's middle out through its back
var STAND_BACK = 25;              // the stand: this far from the threshold toward the terminal
var EVERY = 120000;               // ms between departures on a route (each way)
// per kind: speeds (m/s), accelerations (m/s²) by the kind of ground, heights and distances (m)
var K = {
  jet: {taxi: 9, climb: 78, cruise: 115, approach: 68, touch: 64, accTaxi: 1.2, accRoll: 5.5, accAir: 0.9, decTaxi: 1.5, decRoll: 4.6, decAir: 0.7,
        cruiseY: 600, lift: 430, rotR: 320, climbG: 0.12, descG: 0.08, flare: 240, intercept: 120, level: 300, tdIn: 70, out: 600, turnR: 1100, hold: 4, aoa: 0.045},
  sea: {taxi: 10, climb: 50, cruise: 75, approach: 45, touch: 40, accTaxi: 1.0, accRoll: 3.6, accAir: 0.8, decTaxi: 1.2, decRoll: 3.0, decAir: 0.6,
        cruiseY: 320, lift: 340, rotR: 220, climbG: 0.11, descG: 0.08, flare: 160, intercept: 80, level: 200, tdIn: 330, out: 400, turnR: 650, hold: 3, aoa: 0.05}
};
K.sea.len = 700; K.jet.len = RUNWAY;
var NOMINAL_COAST = 900, NOMINAL_RIVER = 600, SEA_OFF = 45;

function hyp(x, z){ return Math.sqrt(x*x + z*z); }
function wrap(a){ while(a > Math.PI) a -= 2*Math.PI; while(a < -Math.PI) a += 2*Math.PI; return a; }
function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function dirOf(h){ return [Math.sin(h), Math.cos(h)]; }
function leftOf(h){ return [Math.cos(h), -Math.sin(h)]; }       // facing +z, left is +x
function unit(x, z){ var l = hyp(x, z) || 1; return [x/l, z/l]; }

/* ---------- the ends ---------- */
function frontOf(s){
  var f = s && s.front ? [(+s.front[0] || 0)/65536, (+s.front[1] || 0)/65536] : [0, 1];
  return unit(f[0], f[1]);
}
function airportEnd(site, cx, cz, y){
  var f = frontOf(site), d = [-f[0], -f[1]], tx = site.x/100 + (cx || 0), tz = site.z/100 + (cz || 0);
  return {kind: "jet", taxi: [[tx - d[0]*STAND_BACK, tz - d[1]*STAND_BACK], [tx, tz]], dir: d, len: RUNWAY, y: +y || 0,
          site: site.id, thr: [tx, tz]};
}
function nominalAirport(cx, cz, toward){
  var u = unit(toward[0] - cx, toward[1] - cz), tx = cx + u[0]*(NOMINAL_COAST - 300), tz = cz + u[1]*(NOMINAL_COAST - 300);
  return {kind: "jet", taxi: [[tx - u[0]*STAND_BACK, tz - u[1]*STAND_BACK], [tx, tz]], dir: u, len: RUNWAY, y: 0.5, site: null, thr: [tx, tz]};
}
function dockEnd(W, cx, cz, toward){
  var V = HQV.hqVoyage, P;
  if(W && V && V.berthOf(W)) P = V.inland(W);
  else {
    var a = Math.atan2(toward[0] - cx, toward[1] - cz); P = [];
    for(var r = NOMINAL_COAST - NOMINAL_RIVER; r <= NOMINAL_COAST; r += 30) P.push([Math.sin(a)*r, Math.cos(a)*r]);
  }
  // the seaplane ties up 45 m down the river from the berth (the ferry's), on the river's line
  var keep = P.filter(function(p, i){ return i === P.length - 1 || hyp(p[0] - P[0][0], p[1] - P[0][1]) >= SEA_OFF; });
  if(keep.length >= 2) P = keep;
  var m = P[P.length - 1], u = unit(m[0], m[1]), thr = [m[0] + u[0]*80, m[1] + u[1]*80];
  var taxi = P.map(function(p){ return [p[0] + cx, p[1] + cz]; });
  taxi.push([thr[0] + cx, thr[1] + cz]);
  var b = W && V ? V.berthOf(W) : null;
  return {kind: "sea", taxi: taxi, dir: u, len: K.sea.len, y: 0, site: b ? b.site : null, thr: [thr[0] + cx, thr[1] + cz]};
}

/* ---------- the ground track ---------- */
function straight(P, q, out, kind){
  var p = P[P.length - 1], d = hyp(q[0] - p[0], q[1] - p[1]), n = Math.max(1, Math.ceil(d/(kind === "air" ? STEP : STEP_G)));
  for(var i = 1; i <= n; i++){ P.push([p[0] + (q[0] - p[0])*i/n, p[1] + (q[1] - p[1])*i/n]); out.push(kind); }
}
// the shortest turn-straight-turn (Dubins CSC) from (p0, heading h0) to (p1, h1) at radius R
function dubins(p0, h0, p1, h1, R){
  var best = null;
  [[1, 1], [-1, -1], [1, -1], [-1, 1]].forEach(function(sg){
    var s0 = sg[0], s1 = sg[1], L0 = leftOf(h0), L1 = leftOf(h1);
    var C0 = [p0[0] + s0*R*L0[0], p0[1] + s0*R*L0[1]], C1 = [p1[0] + s1*R*L1[0], p1[1] + s1*R*L1[1]];
    var dx = C1[0] - C0[0], dz = C1[1] - C0[1], D = hyp(dx, dz), base = Math.atan2(dx, dz), cands = [];
    if(s0 === s1) cands.push(base);
    else { if(D < 2*R) return; var a = Math.asin(2*R/D); cands.push(base + a, base - a); }
    cands.forEach(function(ht){
      var Lt = leftOf(ht), T0 = [C0[0] - s0*R*Lt[0], C0[1] - s0*R*Lt[1]], T1 = [C1[0] - s1*R*Lt[0], C1[1] - s1*R*Lt[1]];
      var vx = T1[0] - T0[0], vz = T1[1] - T0[1], dt = dirOf(ht), along = vx*dt[0] + vz*dt[1], cross = Math.abs(vx*dt[1] - vz*dt[0]);
      if(along < -1e-6 || cross > 1e-3*Math.max(1, along)) return;
      var a0 = ((s0*(ht - h0)) % (2*Math.PI) + 2*Math.PI) % (2*Math.PI), a1 = ((s1*(h1 - ht)) % (2*Math.PI) + 2*Math.PI) % (2*Math.PI);
      var L = R*a0 + along + R*a1;
      if(!best || L < best.L) best = {L: L, s0: s0, s1: s1, C0: C0, C1: C1, h0: h0, ht: ht, h1: h1, a0: a0, a1: a1, T1: T1};
    });
  });
  return best;
}
function arcPts(C, s, R, hFrom, ang, P, K2, kind){
  var n = Math.max(1, Math.ceil(ang*R/STEP));
  for(var i = 1; i <= n; i++){ var h = hFrom + s*ang*i/n, L = leftOf(h); P.push([C[0] - s*R*L[0], C[1] - s*R*L[1]]); K2.push(kind); }
}

/* ---------- the flight ---------- */
function route(kind, A, B, ends){
  var C = K[kind] || K.jet, ea = ends.a, eb = ends.b, P = [], KD = [], i;
  // taxi out to the threshold (and a held copy of it: the hold), the roll and the climb-out straight
  ea.taxi.forEach(function(p, j){ if(!j){ P.push([p[0], p[1]]); KD.push("taxi"); } else straight(P, p, KD, "taxi"); });
  var iHold = P.length - 1;
  P.push([P[iHold][0], P[iHold][1]]); KD.push("roll");
  var thrA = ea.thr || ea.taxi[ea.taxi.length - 1], ua = ea.dir;
  straight(P, [thrA[0] + ua[0]*C.lift, thrA[1] + ua[1]*C.lift], KD, "roll");
  var q0 = [thrA[0] + ua[0]*(ea.len + C.out), thrA[1] + ua[1]*(ea.len + C.out)];
  straight(P, q0, KD, "air");
  // the destination: touchdown tdIn short of the runway's far (seaward) end, landing back toward its threshold
  var thrB = eb.thr || eb.taxi[eb.taxi.length - 1], ub = eb.dir, hLand = Math.atan2(-ub[0], -ub[1]);
  var td = [thrB[0] + ub[0]*(eb.len - C.tdIn), thrB[1] + ub[1]*(eb.len - C.tdIn)];
  var fin = C.flare/2 + C.intercept/GS + C.level + 100;            // the straight final, from its fix to touchdown
  var faf = [td[0] + ub[0]*fin, td[1] + ub[1]*fin];
  var D = dubins(q0, Math.atan2(ua[0], ua[1]), faf, hLand, C.turnR);
  if(D){
    arcPts(D.C0, D.s0, C.turnR, D.h0, D.a0, P, KD, "air");
    straight(P, D.T1, KD, "air");
    arcPts(D.C1, D.s1, C.turnR, D.ht, D.a1, P, KD, "air");
  }
  straight(P, faf, KD, "air");
  straight(P, td, KD, "air");
  var iTD = P.length - 1;
  straight(P, thrB, KD, "land");
  for(i = eb.taxi.length - 2; i >= 0; i--) straight(P, eb.taxi[i], KD, "taxi");
  // distances, heights
  var n = P.length, pts = new Float64Array(2*n), s = new Float64Array(n), y = new Float64Array(n), v = new Float64Array(n), t = new Float64Array(n);
  for(i = 0; i < n; i++){ pts[2*i] = P[i][0]; pts[2*i + 1] = P[i][1]; if(i) s[i] = s[i - 1] + hyp(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]); }
  var sLift = s[iHold] + C.lift, sTD = s[iTD], y0 = ea.y, y1 = eb.y, cruiseY = Math.max(y0, y1) + C.cruiseY;
  var gsTop = C.flare/2 + C.intercept/GS;                          // where the glideslope meets the intercept height
  function dep(x){ var d = x - sLift; return d <= 0 ? y0 : d < C.rotR ? y0 + C.climbG*d*d/(2*C.rotR) : y0 + C.climbG*(d - C.rotR/2); }
  function arr(x){
    var e = sTD - x;
    if(e <= 0) return y1;
    if(e < C.flare) return y1 + GS*e*e/(2*C.flare);
    if(e < gsTop) return y1 + GS*(e - C.flare/2);
    if(e < gsTop + C.level) return y1 + C.intercept;
    return y1 + C.intercept + C.descG*(e - gsTop - C.level);
  }
  var sPeak = sLift, yPeak = y0;
  for(i = 0; i < n; i++){
    if(s[i] <= sLift){ y[i] = y0; continue; }
    if(s[i] >= sTD){ y[i] = y1; continue; }
    y[i] = Math.min(dep(s[i]), arr(s[i]), cruiseY);
    if(y[i] > yPeak){ yPeak = y[i]; sPeak = s[i]; }
  }
  // round the top-of-climb and top-of-descent corners: a short moving average over the air part
  var ys = Float64Array.from(y);
  for(i = 0; i < n; i++){
    if(s[i] <= sLift + C.rotR || s[i] >= sTD - gsTop - C.level - 50) continue;
    var acc = 0, cnt = 0;
    for(var j = Math.max(0, i - 8); j <= Math.min(n - 1, i + 8); j++){ acc += y[j]; cnt++; }
    ys[i] = Math.min(y[i], acc/cnt);
  }
  y = ys;
  var sFAF = sTD - (gsTop + C.level);
  // speeds: caps by the kind of ground and the phase, then what the plane can gain or shed over each step
  for(i = 0; i < n; i++){
    var kd = KD[i];
    v[i] = kd === "taxi" ? C.taxi : kd === "roll" ? C.climb : kd === "land" ? C.touch
         : s[i] >= sFAF ? (i === iTD ? C.touch : C.approach) : y[i] >= cruiseY - 60 ? C.cruise : C.climb;
  }
  v[0] = 0; v[n - 1] = 0; v[iHold] = 0; v[iHold + 1] = 0;
  function accOf(k){ var kd = KD[k]; return kd === "taxi" ? C.accTaxi : kd === "roll" ? C.accRoll : kd === "land" ? C.accTaxi : C.accAir; }
  function decOf(k){ var kd = KD[k]; return kd === "taxi" ? C.decTaxi : kd === "land" ? C.decRoll : kd === "roll" ? C.decRoll : C.decAir; }
  for(i = 1; i < n; i++) v[i] = Math.min(v[i], Math.sqrt(v[i - 1]*v[i - 1] + 2*accOf(i)*(s[i] - s[i - 1])));
  for(i = n - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1]*v[i + 1] + 2*decOf(i + 1)*(s[i + 1] - s[i])));
  for(i = 1; i < n; i++){
    var vm = (v[i] + v[i - 1])/2, ds = s[i] - s[i - 1];
    t[i] = t[i - 1] + (ds > 1e-9 ? ds/Math.max(0.3, vm) : 0) + (i === iHold + 1 ? C.hold : 0);
  }
  // the handover: airborne, where the plane is furthest from both cities (both deepest in the haze)
  var Ax = +A.x || 0, Az = +A.z || 0, Bx = +B.x || 0, Bz = +B.z || 0, kh = iTD, kd = -1;
  for(i = iHold + 1; i < iTD; i++){
    if(s[i] <= sLift) continue;
    var dd = Math.min(hyp(P[i][0] - Bx, P[i][1] - Bz), hyp(P[i][0] - Ax, P[i][1] - Az));
    if(dd > kd + 1){ kd = dd; kh = i; }
  }
  return {kind: kind, pts: pts, y: y, s: s, v: v, t: t, T: t[n - 1], len: s[n - 1], hand: t[kh], nA: iHold + 1,
          iHold: iHold, iTD: iTD, sLift: sLift, sTD: sTD, sFAF: sFAF, sPeak: sPeak, tRoll: t[iHold + 1], cruiseY: cruiseY,
          y0: y0, y1: y1, C: C, from: A.world, to: B.world, A: {x: Ax, z: Az}, B: {x: Bx, z: Bz}, endA: ea, endB: eb};
}
function idxAtS(R, x){
  var S = R.s, lo = 0, hi = S.length - 1;
  if(x <= S[0]) return 0;
  if(x >= S[hi]) return hi - 1;
  while(hi - lo > 1){ var m = (lo + hi) >> 1; if(S[m] <= x) lo = m; else hi = m; }
  return lo;
}
function yAtS(R, x){
  var i = idxAtS(R, x), ds = R.s[i + 1] - R.s[i], u = ds > 1e-9 ? clamp((x - R.s[i])/ds, 0, 1) : 0;
  return R.y[i] + (R.y[i + 1] - R.y[i])*u;
}
function xzAtS(R, x){
  var i = idxAtS(R, x), ds = R.s[i + 1] - R.s[i], u = ds > 1e-9 ? clamp((x - R.s[i])/ds, 0, 1) : 0, P = R.pts;
  return [P[2*i] + (P[2*i + 2] - P[2*i])*u, P[2*i + 1] + (P[2*i + 3] - P[2*i + 1])*u];
}
function headingAtS(R, x){
  var a = xzAtS(R, Math.max(0, x - 12)), b = xzAtS(R, Math.min(R.len, x + 12));
  if(hyp(b[0] - a[0], b[1] - a[1]) < 1e-6){       // standing at the hold: the way it rolls next
    a = xzAtS(R, x); b = xzAtS(R, Math.min(R.len, x + 30));
    if(hyp(b[0] - a[0], b[1] - a[1]) < 1e-6) b = xzAtS(R, x), a = xzAtS(R, Math.max(0, x - 30));
  }
  return Math.atan2(b[0] - a[0], b[1] - a[1]);
}
function poseAt(R, t){
  var T = R.t, n = T.length, P = R.pts, C = R.C;
  if(!(t > 0)) t = 0;
  if(t >= T[n - 1]) t = T[n - 1];
  var lo = 0, hi = n - 1;
  while(hi - lo > 1){ var m = (lo + hi) >> 1; if(T[m] <= t) lo = m; else hi = m; }
  var dt = T[hi] - T[lo], ds = R.s[hi] - R.s[lo], v0 = R.v[lo], v1 = R.v[hi], tau = t - T[lo];
  var a = dt > 1e-9 && ds > 1e-9 ? (v1 - v0)/dt : 0, d = ds > 1e-9 ? Math.min(ds, Math.max(0, v0*tau + a*tau*tau/2)) : 0, u = ds > 1e-9 ? d/ds : 0;
  var x = P[2*lo] + (P[2*hi] - P[2*lo])*u, z = P[2*lo + 1] + (P[2*hi + 1] - P[2*lo + 1])*u, along = R.s[lo] + d;
  var y = R.y[lo] + (R.y[hi] - R.y[lo])*u, speed = ds > 1e-9 ? v0 + a*tau : 0;
  var yaw = headingAtS(R, along);
  // the path's climb angle over ±40 m, the wing's angle of attack on top; the rotation and the derotation on the ground
  var air = along > R.sLift && along < R.sTD, gamma = Math.atan2(yAtS(R, along + 40) - yAtS(R, along - 40), 80), pitch = 0;
  if(air) pitch = gamma + C.aoa + (R.sTD - along < C.flare ? 0.04*(1 - (R.sTD - along)/C.flare) : 0);
  else if(along <= R.sLift && along > R.sLift - 60 && t >= R.tRoll) pitch = (C.aoa + 0.07)*(1 - (R.sLift - along)/60);
  else if(along >= R.sTD && along < R.sTD + 80) pitch = (C.aoa + 0.04)*(1 - (along - R.sTD)/80);
  // the bank for the turn rate: tan(bank) = v² κ / g, κ over ±60 m of track
  var roll = 0;
  if(air && y - Math.max(R.y0, R.y1) > 8){
    var k = wrap(headingAtS(R, along + 60) - headingAtS(R, along - 60))/120;
    roll = clamp(Math.atan(speed*speed*k/G), -0.6, 0.6);
    var hAGL = y - Math.max(R.y0, R.y1); if(hAGL < 40) roll *= hAGL/40;
  }
  var phase;
  if(t < R.tRoll) phase = "taxi";
  else if(along < R.sLift) phase = "takeoff";
  else if(along < R.sTD){
    if(y >= R.cruiseY - 15) phase = "cruise";
    else if(along < R.sPeak) phase = "climb";
    else if(along < R.sFAF) phase = "descent";
    else phase = R.sTD - along < C.flare ? "flare" : "approach";
  }
  else if(t >= T[n - 1]) phase = "parked";
  else phase = speed > C.taxi + 1 ? "rollout" : "taxi";
  // the gear: up 8 s after the wheels leave, down from 300 m out of the final (and always on the water: the floats)
  var gear = 1;
  if(R.kind === "jet" && air){
    var up = clamp((along - R.sLift - 300)/400, 0, 1), down = clamp((R.sTD - along - 3500)/400, 0, 1);
    gear = 1 - Math.min(up, down);
  }
  return {x: x, y: y, z: z, yaw: yaw, pitch: pitch, roll: roll, speed: speed, phase: phase, gear: gear, along: along,
          u: R.T > 0 ? t/R.T : 1, air: air};
}

/* ---------- schedules ---------- */
function hash(s){ var h = 2166136261; for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
// a -> b and b -> a run on their own offsets (directed), so the two don't leave together
function flights(a, b, nowMs, back, ahead, every){
  every = every || EVERY;
  var off = hash("air|" + a + ">" + b) % every, out = [];
  var k0 = Math.floor((nowMs - back - off)/every), k1 = Math.ceil((nowMs + ahead - off)/every);
  for(var k = k0; k <= k1; k++){ var d = k*every + off; if(d >= nowMs - back && d <= nowMs + ahead) out.push(d); }
  return out;
}
function nextFlight(a, b, nowMs, every){ every = every || EVERY; var off = hash("air|" + a + ">" + b) % every; return Math.ceil((nowMs - off)/every)*every + off; }

// scenic traffic: an airliner on the airway over every pair of cities, high (1.6..2.6 km), fast, a departure every
// AMB_EVERY ms each way, drawn while within `radius` of (cx, cz). trail: [[x, y, z] tail, [x, y, z] contrail's end]
var AMB_EVERY = 90000, AMB_V = 190, AMB_EXT = 9000, TRAIL = 1600;
function ambient(places, nowMs, cx, cz, radius){
  var out = [], L = (places || []).filter(function(p){ return p && isFinite(+p.x) && isFinite(+p.z); });
  for(var i = 0; i < L.length; i++) for(var j = 0; j < L.length; j++){
    if(i === j) continue;
    var A = L[i], B = L[j], h = hash("amb|" + A.world + ">" + B.world), u = unit(B.x - A.x, B.z - A.z);
    if(!isFinite(u[0]) || hyp(B.x - A.x, B.z - A.z) < 1) continue;
    // the airway sits off the straight line by a few hundred metres, its own height per direction
    var side = ((h >> 8) % 600) - 300, alt = 1600 + (h % 5)*250, lx = u[1]*side, lz = -u[0]*side;
    var x0 = A.x - u[0]*AMB_EXT + lx, z0 = A.z - u[1]*AMB_EXT + lz, len = hyp(B.x - A.x, B.z - A.z) + 2*AMB_EXT, T = len/AMB_V*1000;
    var every = AMB_EVERY + (h % 30000), off = h % every;
    for(var k = Math.floor((nowMs - T - off)/every); k <= Math.floor((nowMs - off)/every); k++){
      var dep = k*every + off, d = (nowMs - dep)/1000*AMB_V;
      if(d < 0 || d > len) continue;
      var x = x0 + u[0]*d, z = z0 + u[1]*d;
      // the nearest point of its line to (cx, cz): skip the ones that never come near
      if(hyp(x - cx, z - cz) > radius) continue;
      var tl = Math.min(TRAIL, d);
      out.push({id: A.world + ">" + B.world + "@" + dep, x: x, y: alt, z: z, yaw: Math.atan2(u[0], u[1]), speed: AMB_V,
                trail: [[x - u[0]*18, alt, z - u[1]*18], [x - u[0]*tl, alt, z - u[1]*tl]]});
    }
  }
  return out;
}

HQV.hqAir = {route: route, poseAt: poseAt, airportEnd: airportEnd, dockEnd: dockEnd, nominalAirport: nominalAirport,
             flights: flights, nextFlight: nextFlight, ambient: ambient, dubins: dubins, EVERY: EVERY, RUNWAY: RUNWAY,
             STAND_BACK: STAND_BACK, KINDS: K, GS: GS};
})();
