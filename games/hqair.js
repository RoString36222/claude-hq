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
 *   normEnd(e)                   any of those (v1) or an airfield's v2 end (HQV.hqAirfield.end, docs/plans/airport-spec.md
 *                                7.3: push, taxi, hold, line, roll; touchdown, rollout to exitAt, exit, taxi in) -> v2
 *   route(kind, A, B, ends)      kind jet|sea|amphib (the Isle Hopper), ends {a, b, holdExtra?} as above (+ world ids
 *                                on A, B) -> R: {pts (x, z pairs), y, s, v, t (Float64Arrays), T (s), len, hand (s: when
 *        to move into B's city), sLift, sTD, sFAF, sPeak, cruiseY, kind, from, to, A, B, and the times (s) tPush1, tHold0,
 *        tHold1, tLine, tRoll, tLift, tTD, tExit, tVacate, sExit, standA, standB, endA, endB, occ {dep, arr} (runway)}.
 *        On v2 ends the ground speeds keep the caps of 7.3 (push 1, line 4, exit 15, curves sqrt(R), lead-in 2.5).
 *   poseAt(R, t)  -> {x, y, z, yaw, pitch, roll (+ = banked left: left wing down), speed, phase, gear (0 up .. 1 down),
 *                     along, u, rev (pushing back: yaw is the track + π)}; phase: pushback, taxi, hold, lineup, takeoff,
 *                     climb, cruise, descent, approach, flare, rollout, exit, taxi, parked
 *   aheadOf(R, along, d)         {x, z, yaw} d m further along R's track (the follow-me car)
 *   traffic(AF, ctx, nowMs, o)   the Commons' timetable as aircraft: {moving, stands, parked} (see below)
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
// half: the origin to the nose (the tail), for the runway occupancy; jet.v1: the roll on a v1 airport's 500 m runway
var K = {
  jet: {taxi: 7, climb: 78, cruise: 115, approach: 68, touch: 64, accTaxi: 1.2, accRoll: 2.7, accAir: 0.9, decTaxi: 1.5, decRoll: 2.6, decAir: 0.7,
        cruiseY: 600, lift: 1050, rotR: 320, climbG: 0.12, descG: 0.08, flare: 240, intercept: 120, level: 300, tdIn: 70, out: 600, turnR: 1100, hold: 4, aoa: 0.045,
        half: 19, v1: {lift: 430, accRoll: 5.5, decRoll: 4.6}},
  sea: {taxi: 10, climb: 50, cruise: 75, approach: 45, touch: 40, accTaxi: 1.0, accRoll: 3.6, accAir: 0.8, decTaxi: 1.2, decRoll: 3.0, decAir: 0.6,
        cruiseY: 320, lift: 340, rotR: 220, climbG: 0.11, descG: 0.08, flare: 160, intercept: 80, level: 200, tdIn: 330, out: 400, turnR: 650, hold: 3, aoa: 0.05, half: 8}
};
K.sea.len = 700; K.jet.len = RUNWAY;
// the Isle Hopper: the seaplane on wheels too (Commons runway <-> an island's river mouth)
K.amphib = Object.assign({}, K.sea, {taxi: 7, climb: 45, cruise: 75, approach: 42, touch: 38, accRoll: 2.4, decRoll: 2.2, cruiseY: 320, lift: 420, turnR: 650, hold: 4, finLine: 900});
K.jet.finLine = 2400;
// on an airfield's taxiways (m/s, m/s², s): push back, line up, exit; v² ≤ lat·R in a curve; the stand's last leadLen m
K.ground = {push: 1.0, pushAcc: 0.3, line: 4, exit: 15, lead: 2.5, leadLen: 40, lat: 1.0, lineup: 2};
// an extra wait at the runway holding point (s) per runway in use and class: the departure pushes that much earlier
// (traffic() may take a jet's back again, down to 0, when pushing later keeps the ground separation: see seqHold)
K.holdExtra = {"36": {jet: 40, commuter: 0}, "18": {jet: 40, commuter: 0}};
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

/* ---------- the ends, v2 ---------- */
// any end -> the v2 format (docs/plans/airport-spec.md 7.3). A v2 end passes through. A v1 end (airportEnd, dockEnd,
// nominalAirport) has no push and no line: the taxi runs to its threshold (the hold, where the roll starts), and an
// arrival lands from its far end back toward the threshold (arr.td null: the route kind's tdIn), rolls out to the
// threshold (exitAt = len) and taxis back down the same path. That is exactly the v1 flight.
function normEnd(e){
  if(!e) return null;
  if(e.v === 2) return e;
  var tx = (e.taxi || []).map(function(p){ return [p[0], p[1]]; }), thr = e.thr || tx[tx.length - 1], d = e.dir, len = +e.len || 0;
  var s0 = tx[0], s1 = tx[1] || thr;
  return {v: 2, v1: true, kind: e.kind, y: +e.y || 0, site: e.site, stand: {x: s0[0], z: s0[1], yaw: Math.atan2(s1[0] - s0[0], s1[1] - s0[1])},
          dep: {push: [], taxi: tx, line: [], dir: d, len: len},
          arr: {thr: [thr[0] + d[0]*len, thr[1] + d[1]*len], dir: [-d[0], -d[1]], td: null, exitAt: len, exit: [], taxi: tx.slice().reverse()}};
}

/* ---------- the flight ---------- */
// append a polyline (skipping a first point that repeats the last), straight pieces cut to the ground step
function addPath(P, KD, pts, kind){
  (pts || []).forEach(function(p){
    var q = P[P.length - 1];
    if(!q){ P.push([p[0], p[1]]); KD.push(kind); return; }
    if(hyp(p[0] - q[0], p[1] - q[1]) < 1e-6) return;
    straight(P, p, KD, kind);
  });
}
function lateral(p, o, d){ return Math.abs((p[0] - o[0])*d[1] - (p[1] - o[1])*d[0]); }
function route(kind, A, B, ends){
  var C = K[kind] || K.jet, ea = normEnd(ends.a), eb = normEnd(ends.b), dp = ea.dep, ar = eb.arr, P = [], KD = [], D = [], i;
  // a v1 airport's runway is short (500 m): its jets keep the v1 roll (the take-off by A's runway, the landing by B's)
  var CA = ea.v1 && C.v1 ? C.v1 : C, CB = eb.v1 && C.v1 ? C.v1 : C, GR = K.ground;
  // pushback (tail first), taxi out to the hold, the hold, the line-up (and a short stop on the centreline), the roll
  var hasPush = !!(dp.push && dp.push.length > 1), hasLine = !!(dp.line && dp.line.length > 1);
  if(hasPush) addPath(P, KD, dp.push, "push");
  var iPush1 = hasPush ? P.length - 1 : 0;
  addPath(P, KD, dp.taxi, "taxi");
  var iHold = P.length - 1;
  P.push([P[iHold][0], P[iHold][1]]); KD.push(hasLine ? "line" : "roll"); D[iHold + 1] = C.hold + (+ends.holdExtra || 0);
  if(hasLine){ addPath(P, KD, dp.line, "line"); var q = P[P.length - 1]; P.push([q[0], q[1]]); KD.push("roll"); D[P.length - 1] = GR.lineup; }
  var iRoll = P.length - 1, r0 = P[iRoll], ua = dp.dir;
  straight(P, [r0[0] + ua[0]*CA.lift, r0[1] + ua[1]*CA.lift], KD, "roll");
  var iLift = P.length - 1;
  var q0 = [r0[0] + ua[0]*(dp.len + C.out), r0[1] + ua[1]*(dp.len + C.out)];
  straight(P, q0, KD, "air");
  // the destination: touchdown td past its threshold on the extended centreline, a straight final from its fix
  var ub = ar.dir, tdIn = ar.td != null ? +ar.td : C.tdIn, hLand = Math.atan2(ub[0], ub[1]);
  var td = [ar.thr[0] + ub[0]*tdIn, ar.thr[1] + ub[1]*tdIn];
  // the straight final, from its fix to touchdown (finLine: a longer one, so the plane is wings level well before it)
  var fin = C.flare/2 + C.intercept/GS + C.level + 100 + (C.finLine || 0);
  var faf = [td[0] - ub[0]*fin, td[1] - ub[1]*fin];
  var Dn = dubins(q0, Math.atan2(ua[0], ua[1]), faf, hLand, C.turnR);
  if(Dn){
    arcPts(Dn.C0, Dn.s0, C.turnR, Dn.h0, Dn.a0, P, KD, "air");
    straight(P, Dn.T1, KD, "air");
    arcPts(Dn.C1, Dn.s1, C.turnR, Dn.ht, Dn.a1, P, KD, "air");
  }
  straight(P, faf, KD, "air");
  straight(P, td, KD, "air");
  var iTD = P.length - 1;
  // rollout on the centreline to the exit, the exit, the taxi in (to the stand, nose in)
  straight(P, [ar.thr[0] + ub[0]*ar.exitAt, ar.thr[1] + ub[1]*ar.exitAt], KD, "land");
  var iExit = P.length - 1;
  addPath(P, KD, ar.exit, "exit");
  var iExit1 = P.length - 1;
  addPath(P, KD, ar.taxi, "taxi");
  // distances, heights
  var n = P.length, pts = new Float64Array(2*n), s = new Float64Array(n), y = new Float64Array(n), v = new Float64Array(n), t = new Float64Array(n);
  for(i = 0; i < n; i++){ pts[2*i] = P[i][0]; pts[2*i + 1] = P[i][1]; if(i) s[i] = s[i - 1] + hyp(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]); }
  var sLift = s[iLift], sTD = s[iTD], y0 = ea.y, y1 = eb.y, cruiseY = Math.max(y0, y1) + C.cruiseY;
  var gsTop = C.flare/2 + C.intercept/GS;                          // where the glideslope meets the intercept height
  function depY(x){ var d = x - sLift; return d <= 0 ? y0 : d < C.rotR ? y0 + C.climbG*d*d/(2*C.rotR) : y0 + C.climbG*(d - C.rotR/2); }
  function arrY(x){
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
    y[i] = Math.min(depY(s[i]), arrY(s[i]), cruiseY);
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
    v[i] = kd === "taxi" ? C.taxi : kd === "roll" ? C.climb : kd === "land" ? C.touch : kd === "push" ? GR.push : kd === "line" ? GR.line : kd === "exit" ? GR.exit
         : s[i] >= sFAF ? (i === iTD ? C.touch : C.approach) : y[i] >= cruiseY - 60 ? C.cruise : C.climb;
  }
  // on an airfield's (v2) taxiways: the curves (v² ≤ a·R), the exit down to taxi speed at its end, the stand's lead-in
  var geo = [];
  if(!ea.v1) for(i = 0; i <= iRoll; i++) geo[i] = true;
  if(!eb.v1){
    for(i = iExit; i < n; i++) geo[i] = true;
    v[iExit] = Math.min(v[iExit], GR.exit);
    if(iExit1 > iExit) v[iExit1] = Math.min(v[iExit1], C.taxi);
    for(i = n - 1; i >= iExit1 && s[Math.min(n - 1, i + 1)] >= s[n - 1] - GR.leadLen; i--) v[i] = Math.min(v[i], GR.lead);
  }
  var kap = new Float64Array(n);
  for(i = 1; i < n - 1; i++){
    if(!geo[i] || !geo[i - 1] || !geo[i + 1]) continue;
    var d0 = s[i] - s[i - 1], d1 = s[i + 1] - s[i];
    if(d0 < 1e-6 || d1 < 1e-6) continue;
    var dh = Math.abs(wrap(Math.atan2(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]) - Math.atan2(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1])));
    if(dh > 2) continue;                                            // the cusp where the push ends
    kap[i] = dh/((d0 + d1)/2);
  }
  for(i = 0; i < n; i++){
    if(!geo[i]) continue;
    var kk = Math.max(kap[i], i ? kap[i - 1] : 0, i < n - 1 ? kap[i + 1] : 0);
    if(kk > 1e-4) v[i] = Math.min(v[i], Math.sqrt(GR.lat/kk));
  }
  v[0] = 0; v[n - 1] = 0; v[iHold] = 0; v[iHold + 1] = 0; v[iRoll] = 0; v[iRoll - 1] = 0;
  if(hasPush) v[iPush1] = 0;
  // a stop where the exit joins the parallel taxiway, clear of the runway (ends.stopIn): traffic() can hold it there
  var stopIn = !!ends.stopIn && !eb.v1 && iExit1 > iExit && iExit1 < n - 1;
  if(stopIn) v[iExit1] = 0;
  function accOf(k){ var kd = KD[k]; return kd === "roll" ? CA.accRoll : kd === "push" ? GR.pushAcc : kd === "taxi" || kd === "land" || kd === "line" || kd === "exit" ? C.accTaxi : C.accAir; }
  function decOf(k){ var kd = KD[k]; return kd === "land" ? CB.decRoll : kd === "roll" ? CA.decRoll : kd === "push" ? GR.pushAcc : kd === "taxi" || kd === "line" || kd === "exit" ? C.decTaxi : C.decAir; }
  for(i = 1; i < n; i++) v[i] = Math.min(v[i], Math.sqrt(v[i - 1]*v[i - 1] + 2*accOf(i)*(s[i] - s[i - 1])));
  for(i = n - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1]*v[i + 1] + 2*decOf(i + 1)*(s[i + 1] - s[i])));
  for(i = 1; i < n; i++){
    var vm = (v[i] + v[i - 1])/2, ds = s[i] - s[i - 1];
    t[i] = t[i - 1] + (ds > 1e-9 ? ds/Math.max(0.3, vm) : 0) + (D[i] || 0);
  }
  function tAtS(x){ var k = idxAtS({s: s}, x), w = s[k + 1] - s[k] > 1e-9 ? clamp((x - s[k])/(s[k + 1] - s[k]), 0, 1) : 0; return t[k] + (t[k + 1] - t[k])*w; }
  // the runway occupancy: a departure from crossing the holding position (its nose) to passing the far end, an
  // arrival from crossing the threshold to clear of the holding position on its exit (its tail)
  var off = STRIP + C.half, k0 = iHold + 1, k1 = iExit;
  if(!ea.v1) while(k0 < iRoll && lateral(P[k0], r0, ua) > off + 1e-6) k0++;
  if(!eb.v1) while(k1 < n - 1 && lateral(P[k1], ar.thr, ub) < off) k1++;
  var occ = {dep: [t[k0], tAtS(s[iRoll] + dp.len)], arr: [tAtS(sTD - tdIn), t[k1]]};
  // the handover: airborne, where the plane is furthest from both cities (both deepest in the haze)
  var Ax = +A.x || 0, Az = +A.z || 0, Bx = +B.x || 0, Bz = +B.z || 0, kh = iTD, kdd = -1;
  for(i = iHold + 1; i < iTD; i++){
    if(s[i] <= sLift) continue;
    var dd = Math.min(hyp(P[i][0] - Bx, P[i][1] - Bz), hyp(P[i][0] - Ax, P[i][1] - Az));
    if(dd > kdd + 1){ kdd = dd; kh = i; }
  }
  return {kind: kind, pts: pts, y: y, s: s, v: v, t: t, T: t[n - 1], len: s[n - 1], hand: t[kh], nA: iRoll,
          iHold: iHold, iTD: iTD, sLift: sLift, sTD: sTD, sFAF: sFAF, sPeak: sPeak, cruiseY: cruiseY,
          tPush1: t[iPush1], tHold0: t[iHold], tHold1: t[iHold + 1], tLine: t[iHold + 1], tRoll: t[iRoll], tLift: t[iLift], tTD: t[iTD],
          tExit: t[iExit], tExit1: t[iExit1], tVacate: t[k1], tStopIn: stopIn ? t[iExit1] : null, sPush1: s[iPush1], sRoll: s[iRoll], sExit: s[iExit], occ: occ,
          standA: ea.stand || null, standB: eb.stand || null,
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
// the path's heading at x, looking only inside [lo, hi] (the push and what follows it run opposite ways)
function headingAtS(R, x, lo, hi){
  lo = lo || 0; hi = hi != null ? hi : R.len;
  // a chord centred on x is parallel to the tangent (on an arc too); at either end of [lo, hi] a short one-sided chord
  var w = Math.min(12, x - lo, hi - x), a, b;
  if(w >= 1.5){ a = xzAtS(R, x - w); b = xzAtS(R, x + w); }
  else if(hi - x >= x - lo){ a = xzAtS(R, x); b = xzAtS(R, Math.min(hi, x + 2)); }
  else { a = xzAtS(R, Math.max(lo, x - 2)); b = xzAtS(R, x); }
  if(hyp(b[0] - a[0], b[1] - a[1]) < 1e-6){       // standing at the hold: the way it rolls next
    a = xzAtS(R, x); b = xzAtS(R, Math.min(hi, x + 30));
    if(hyp(b[0] - a[0], b[1] - a[1]) < 1e-6) b = xzAtS(R, x), a = xzAtS(R, Math.max(lo, x - 30));
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
  var sP = R.sPush1 || 0, rev = sP > 0 && t < R.tPush1;
  var yaw = rev ? wrap(headingAtS(R, along, 0, sP) + Math.PI) : headingAtS(R, along, sP, R.len);
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
  if(rev) phase = "pushback";
  else if(t < R.tHold0) phase = "taxi";
  else if(t < R.tHold1) phase = "hold";
  else if(t < R.tRoll) phase = "lineup";
  else if(along < R.sLift) phase = "takeoff";
  else if(along < R.sTD){
    if(y >= R.cruiseY - 15) phase = "cruise";
    else if(along < R.sPeak) phase = "climb";
    else if(along < R.sFAF) phase = "descent";
    else phase = R.sTD - along < C.flare ? "flare" : "approach";
  }
  else if(t >= T[n - 1]) phase = "parked";
  else if(t < R.tExit) phase = "rollout";
  else if(t < R.tExit1) phase = "exit";
  else phase = "taxi";
  // the gear: up 8 s after the wheels leave, down from 300 m out of the final (and always on the water: the floats)
  var gear = 1;
  if((R.kind === "jet" || R.kind === "amphib") && air){
    var up = clamp((along - R.sLift - 300)/400, 0, 1), down = clamp((R.sTD - along - 3500)/400, 0, 1);
    gear = 1 - Math.min(up, down);
  }
  return {x: x, y: y, z: z, yaw: yaw, pitch: pitch, roll: roll, speed: speed, phase: phase, gear: gear, along: along,
          u: R.T > 0 ? t/R.T : 1, air: air, rev: rev};
}
// a point d m further along R's track from `along` (the follow-me car's lead), heading along the track
function aheadOf(R, along, d){
  if(!R) return null;
  var x = clamp((+along || 0) + (+d || 0), 0, R.len), sP = R.sPush1 || 0, p = xzAtS(R, x);
  return {x: p[0], z: p[1], yaw: headingAtS(R, x, x < sP ? 0 : sP, x < sP ? sP : R.len)};
}

/* ---------- the Commons' airline: the timetable's movements as aircraft and stand states ---------- */
// traffic(AF, ctx, nowMs, o): AF is the hqAirfield API (timetable, end), ctx {L, world, dests, cx, cz, farEnd(movement),
// islandEnd(world)}. A jet arrival flies route("jet", far, here) and touches down at its tRunway; a departure rolls at
// its tRunway; commuters fly "amphib" to/from islandEnd. Routes are cached per (class, type, stand, end, far): at most
// CACHE_MAX, least recently used out first, and a hit never calls route() (o.cache: a Map of your own).
// Ground sequencing (spec 7.3, 45 m between ground aircraft): the Isle Hoppers fly the timetable exactly (one of them may
// be the player's), the jets give way. A jet departure pushes up to SEQ_MAX s early and waits the extra at the runway
// holding point; a jet arrival stops where its exit joins taxiway A (R.tStopIn) and is held there up to SEQ_MAX s. The
// least wait that keeps SEP m from every other ground aircraft is found once per movement from the timetable alone, so
// every client holds the same aircraft for the same time (o.holds: a Map of your own).
// Returns, all in archipelago metres:
//   moving  [{id, cls, kind, type, stand, end, airline, reg, pose, R, t, t0, hold}] from push start (an arrival: SHOW_ARR s
//           before touchdown) to on-block (a departure: to its handover); t is R's time (poseAt(R, t) is the pose), t0 the
//           ms of R's t = 0 had there been no hold, hold the wait (s)
//   stands  {id: {state: empty|arriving|onblock|turnaround|pushback, airline, reg, kind, tIn, tOut, pushT, end}} (empty
//           has times only for AFTER_PUSH s after a push)
//   parked  [{stand, x, z, yaw, airline, reg, kind}] the stands in onblock|turnaround
var CACHE_MAX = 96, SHOW_ARR = 150, ONBLOCK = 120, BACK_MS = 45*60000, AHEAD_MS = 15*60000, STRIP = 50, EXIT_V = 15;
var AFTER_PUSH = 180, SEP = 48, SEQ_MAX = 150, SEQ_STEP = 2, SEQ_WIN = 18*60000, SEQ_OLD = 10*60000, HOLDS_MAX = 160;
var routeCache = new Map(), holdCache = new Map();
function stopDist(C){ return (C.touch*C.touch - EXIT_V*EXIT_V)/(2*C.decRoll); }
function placeOf(e, id){ var n = normEnd(e), p = n.dep.push.length ? n.dep.push[0] : n.dep.taxi[0]; return {world: String(id), x: p[0], z: p[1]}; }
// R's time at ms for a movement entry: a departure's extra wait sits at its hold (before its anchor, the roll), an
// arrival's at its stop on A (after its anchor, the touchdown); the aircraft stands still through either
// (a departure's h may be negative, down to minus its K.holdExtra: it pushes that much later and waits less)
function rtAt(e, ms){
  var tau = (ms - e.t0)/1000, h = e.h || 0;
  if(!h) return tau;
  if(e.dep) return tau + h < e.tH ? tau + h : Math.max(tau, e.tH);
  return tau <= e.tH ? tau : tau <= e.tH + h ? e.tH : tau - h;
}
// a ground sample: {x, z, yaw, ph (phase), kind, dep, end} while the entry is on the ground at ms (pushing back ..
// lift-off, touchdown .. on block), else null
function sampleOf(e, p){ return {x: p.x, z: p.z, yaw: p.yaw, ph: p.phase, kind: e.kind, dep: e.dep, end: e.m.end}; }
function groundAt(e, ms, cx, cz){
  var tau = (ms - e.t0)/1000, R = e.R;
  if(e.dep ? (tau < -(e.h || 0) || tau > R.tLift) : (tau < R.tTD || tau > R.T + (e.h || 0))) return null;
  var p = poseAt(R, rtAt(e, ms));
  return p.air || hyp(p.x - cx, p.z - cz) > 3000 ? null : sampleOf(e, p);
}
// the planform as thick segments in model metres [x0, z0, x1, z1, half-thickness] (games/hqaircraft.js): fuselage, wing,
// tailplane; the clearance between two aircraft is the least gap between their pieces
var PLAN = {jet: [[0, -19, 0, 19, 2], [-15.5, -1, 15.5, -1, 2.5], [-6.3, -17.3, 6.3, -17.3, 2.2]],
            amphib: [[0, -8.2, 0, 7.4, 1], [-9, 0.9, 9, 0.9, 1], [-3.2, -7.5, 3.2, -7.5, 0.8]]};
function segPt(p, a, b){
  var dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx*dx + dz*dz, t = L2 > 0 ? clamp(((p[0] - a[0])*dx + (p[1] - a[1])*dz)/L2, 0, 1) : 0;
  return hyp(p[0] - a[0] - dx*t, p[1] - a[1] - dz*t);
}
function cross2(o, a, b){ return (a[0] - o[0])*(b[1] - o[1]) - (a[1] - o[1])*(b[0] - o[0]); }
function segSeg(a, b, c, d){
  var d1 = cross2(c, d, a), d2 = cross2(c, d, b), d3 = cross2(a, b, c), d4 = cross2(a, b, d);
  if(((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return 0;
  return Math.min(segPt(a, c, d), segPt(b, c, d), segPt(c, a, b), segPt(d, a, b));
}
function pieces(s){
  var f = dirOf(s.yaw), l = leftOf(s.yaw);
  return (PLAN[s.kind] || PLAN.jet).map(function(q){
    return [[s.x + l[0]*q[0] + f[0]*q[1], s.z + l[1]*q[0] + f[1]*q[1]], [s.x + l[0]*q[2] + f[0]*q[3], s.z + l[1]*q[2] + f[1]*q[3]], q[4]];
  });
}
function clearance(a, b){
  var A = pieces(a), B = pieces(b), m = Infinity;
  for(var i = 0; i < A.length; i++) for(var j = 0; j < B.length; j++) m = Math.min(m, segSeg(A[i][0], A[i][1], B[j][0], B[j][1]) - A[i][2] - B[j][2]);
  return Math.max(0, m);
}
// how far a pair falls short of the separation (0: none): SEP m origin to origin on one track; the planforms keep
// PLAN_SEP m instead while one of them pushes back, while two departures queue at their runway's holding point, and
// side by side on separate lanes (A and B are 42 m apart: LANE m or more abeam of each other's heading)
var PLAN_SEP = 6, LANE = 35, QUEUE = {hold: 1, lineup: 1};
function abeam(a, b){ var f = dirOf(a.yaw), g = dirOf(b.yaw), dx = b.x - a.x, dz = b.z - a.z; return Math.min(Math.abs(dx*f[1] - dz*f[0]), Math.abs(dx*g[1] - dz*g[0])); }
function shortOf(a, b){
  var d = hyp(a.x - b.x, a.z - b.z);
  if(d >= SEP) return 0;
  if(a.ph === "pushback" || b.ph === "pushback" || (a.dep && b.dep && a.end === b.end && (QUEUE[a.ph] || QUEUE[b.ph])) || abeam(a, b) >= LANE)
    return Math.max(0, PLAN_SEP - clearance(a, b));
  return SEP - d;
}
// the least hold (s, a multiple of SEQ_STEP up to SEQ_MAX; a departure from minus its slack, the K.holdExtra in its
// route) that keeps jet entry e clear of `others` (their holds known, shortOf) while it is on the ground; with none that
// does, the one that falls short the least
function seqHold(e, others, cx, cz){
  var R = e.R, tH = e.tH, j, k;
  if(tH == null || !(tH > 0)) return 0;
  var HP = sampleOf(e, poseAt(R, tH)), F = [], base, n;
  if(e.dep){
    // τ (s from t0) = -SEQ_MAX .. tH1: before tH - h it is at R time τ + h (an integer: F), from there on at its hold
    base = -SEQ_MAX; n = Math.floor(e.tH1) + SEQ_MAX + 1;
    for(j = 0; j <= Math.floor(tH); j++) F.push(sampleOf(e, poseAt(R, j)));
  } else {
    // τ = tH + k: held while k <= h, then at R time tH + k - h (F[k - h]) until on block
    base = tH; n = Math.ceil(R.T - tH) + SEQ_MAX + 1;
    for(j = 0; tH + j <= R.T; j++) F.push(sampleOf(e, poseAt(R, tH + j)));
  }
  var t0 = e.t0 + base*1000, t1 = e.t0 + (base + n - 1)*1000, O = [];
  others.forEach(function(o){
    if(o === e) return;
    var g0 = o.dep ? o.t0 - (o.h || 0)*1000 : o.t0 + o.R.tTD*1000, g1 = o.dep ? o.t0 + o.R.tLift*1000 : o.t0 + (o.R.T + (o.h || 0))*1000;
    if(g1 < t0 || g0 > t1) return;
    var Q = new Array(n), any = false;
    for(var q = 0; q < n; q++){ var ms = t0 + q*1000; Q[q] = ms < g0 || ms > g1 ? null : groundAt(o, ms, cx, cz); if(Q[q]) any = true; }
    if(any) O.push(Q);
  });
  if(!O.length) return 0;
  var best = 0, bestS = Infinity, hMin = e.dep ? -Math.floor(Math.max(0, e.slack || 0)/SEQ_STEP)*SEQ_STEP : 0;
  for(var h = hMin; h <= SEQ_MAX; h += SEQ_STEP){
    var sc = 0;
    for(k = 0; k < n && sc < bestS; k++){
      var p;
      if(e.dep){ var tau = base + k; if(tau < -h) continue; p = tau + h < tH ? F[tau + h] : HP; }
      else { if(k <= h) p = HP; else { p = F[k - h]; if(!p) break; } }
      if(!p) continue;
      for(var oi = 0; oi < O.length; oi++){ var q2 = O[oi][k]; if(q2){ var sh = shortOf(p, q2); sc += sh*sh; } }
    }
    if(sc === 0) return h;
    if(sc < bestS){ bestS = sc; best = h; }
  }
  return best;
}
function traffic(AF, ctx, nowMs, o){
  o = o || {}; ctx = ctx || {};
  var out = {moving: [], stands: {}, parked: []}, L = ctx.L, cache = o.cache || routeCache, holds = o.holds || holdCache;
  if(!AF || !L || !L.ok) return out;
  var cx = +ctx.cx || 0, cz = +ctx.cz || 0, here = {world: ctx.world, x: cx, z: cz}, ST = {}, dests = ctx.dests || [];
  (L.stands || []).forEach(function(s){ ST[s.id] = s; out.stands[s.id] = {state: "empty"}; });
  function routeOf(m){
    var key = [ctx.world, cx, cz, m.cls, m.type, m.stand, m.end, m.far].join("|");
    if(cache.has(key)){ var hit = cache.get(key); cache.delete(key); cache.set(key, hit); return hit; }
    var kind = m.cls === "jet" ? "jet" : "amphib", C = K[kind], R = null;
    try {
      var hE = AF.end(L, String(m.stand), m.end, cx, cz, {stopDist: stopDist(C)});
      var fE = m.cls === "jet" ? (ctx.farEnd ? ctx.farEnd(m) : null) : (ctx.islandEnd ? ctx.islandEnd(m.far) : null);
      if(hE && hE.ok !== false && fE){
        var fP = placeOf(fE, m.far), E = L.runway.ends[m.end], hx = (K.holdExtra[E && E.id] || {})[m.cls] || 0;
        R = m.type === "dep" ? API.route(kind, here, fP, {a: hE, b: fE, holdExtra: hx})
          : API.route(kind, fP, here, {a: fE, b: hE, stopIn: m.cls === "jet"});
      }
    } catch(e){ R = null; }
    cache.set(key, R);
    while(cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return R;
  }
  // every movement within SEQ_WIN of the shown window (their routes only when a hold needs them)
  var all = AF.timetable(ctx.world, dests, nowMs - BACK_MS - SEQ_WIN, nowMs + AHEAD_MS + SEQ_WIN) || [], ents = {};
  function entOf(m){
    if(ents[m.id] !== undefined) return ents[m.id];
    var R = routeOf(m), e = null;
    if(R){
      var dep = m.type === "dep";
      e = {m: m, R: R, kind: m.cls === "jet" ? "jet" : "amphib", dep: dep, h: 0,
           t0: dep ? m.tRunway - R.tRoll*1000 : m.tRunway - R.tTD*1000, tH: dep ? R.tHold0 : R.tStopIn,
           tH1: dep ? R.tHold1 : null, slack: dep ? R.tHold1 - R.tHold0 - R.C.hold : 0};
    }
    ents[m.id] = e;
    return e;
  }
  function near(m, lo, hi){ return all.filter(function(x){ return x !== m && x.tRunway >= m.tRunway + lo && x.tRunway <= m.tRunway + hi; }); }
  // a jet's hold: departures give way to the hoppers, arrivals to the hoppers and the (sequenced) jet departures
  function holdOf(e){
    if(e.m.cls !== "jet" || e.tH == null) return 0;
    var key = [ctx.world, cx, cz, dests.join(","), e.m.id, e.m.end, e.m.stand, e.m.far].join("|");
    if(holds.has(key)) return holds.get(key);
    var others = [];
    near(e.m, -SEQ_WIN, SEQ_WIN).forEach(function(x){
      if(x.cls === "jet" && (e.dep || x.type !== "dep")) return;
      var oe = entOf(x); if(!oe) return;
      if(x.cls === "jet") oe.h = holdOf(oe);
      others.push(oe);
    });
    var h = seqHold(e, others, cx, cz);
    holds.set(key, h);
    while(holds.size > HOLDS_MAX) holds.delete(holds.keys().next().value);
    return h;
  }
  var by = {};
  all.forEach(function(m){
    if(m.tRunway < nowMs - BACK_MS || m.tRunway > nowMs + AHEAD_MS) return;
    var e = entOf(m); if(!e) return;
    var R = e.R;
    // long past (on block or airborne SEQ_OLD ago): its hold no longer shows
    if(m.cls === "jet" && e.t0 + (e.dep ? R.tLift : R.T + SEQ_MAX)*1000 > nowMs - SEQ_OLD) e.h = holdOf(e);
    if(m.type === "arr"){ e.vis = Math.max(e.t0, m.tRunway - SHOW_ARR*1000); e.fin = e.t0 + (R.T + e.h)*1000; }
    else { e.vis = e.t0 - e.h*1000; e.fin = e.t0 + R.hand*1000; }
    (by[m.airframe] = by[m.airframe] || {})[m.type] = e;
    if(nowMs >= e.vis && nowMs < e.fin){
      var t = rtAt(e, nowMs);
      out.moving.push({id: m.id, cls: m.cls, kind: e.kind, type: m.type, stand: String(m.stand), end: m.end, airline: m.airline, reg: m.reg,
                       pose: poseAt(R, t), R: R, t: t, t0: e.t0, hold: e.h, vis: e.vis});
    }
  });
  out.moving.sort(function(a, b){ return a.vis - b.vis || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
  var rank = {empty: 0, arriving: 1, pushback: 2, onblock: 3, turnaround: 3};
  Object.keys(by).sort().forEach(function(af){
    var a = by[af].arr, d = by[af].dep, m = (a || d).m, sid = String(m.stand);
    var tVis = a ? a.vis : -Infinity, tIn = a ? a.fin : -Infinity, tOut = d ? d.vis : Infinity, tP1 = d ? d.t0 + (d.R.tPush1 - d.h)*1000 : Infinity;
    var st = nowMs < tVis ? null : nowMs < tIn ? "arriving" : nowMs < tOut ? (nowMs < tIn + ONBLOCK*1000 ? "onblock" : "turnaround") : nowMs < tP1 ? "pushback" : null;
    // just pushed: the stand is empty again, but keeps the times a while (the tug drives home after its push)
    if(!st && d && nowMs >= tP1 && nowMs < tP1 + AFTER_PUSH*1000 && out.stands[sid] && out.stands[sid].state === "empty" && out.stands[sid].tOut == null){
      out.stands[sid] = {state: "empty", airline: m.airline, reg: m.reg, kind: d.kind, tIn: tIn, tOut: tOut, pushT: 0, end: d.m.end};
      return;
    }
    if(!st || !out.stands[sid] || rank[st] <= rank[out.stands[sid].state]) return;
    out.stands[sid] = {state: st, airline: m.airline, reg: m.reg, kind: (a || d).kind, tIn: tIn, tOut: tOut, pushT: st === "pushback" ? (nowMs - tOut)/1000 : 0,
                       end: a ? a.m.end : d.m.end};
  });
  Object.keys(out.stands).forEach(function(id){
    var S = out.stands[id], s = ST[id];
    if(S.state === "onblock" || S.state === "turnaround") out.parked.push({stand: id, x: s.x + cx, z: s.z + cz, yaw: s.yaw, airline: S.airline, reg: S.reg, kind: S.kind});
  });
  return out;
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

var API = HQV.hqAir = {route: route, poseAt: poseAt, airportEnd: airportEnd, dockEnd: dockEnd, nominalAirport: nominalAirport, normEnd: normEnd,
             traffic: traffic, aheadOf: aheadOf, stopDist: stopDist, flights: flights, nextFlight: nextFlight, ambient: ambient, dubins: dubins,
             EVERY: EVERY, RUNWAY: RUNWAY, STAND_BACK: STAND_BACK, KINDS: K, K: K, GS: GS, CACHE_MAX: CACHE_MAX, SHOW_ARR: SHOW_ARR, AIR_MAX: 4,
             SEP: SEP, SEQ_MAX: SEQ_MAX};
})();
