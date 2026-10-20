/* Claude HQ: voyages between cities over the water (HQV.hqVoyage). Pure: no THREE, no DOM.
 *
 * A ferry leaves its berth at a city's dock, follows the river out to the sea, swings round the coast to face
 * the other city, crosses, swings round that coast to its river mouth and sails up to the berth there. Every
 * point is in ARCHIPELAGO metres (the city's own frame plus its archipelago position: GET /v1/archipelago), so
 * one route serves both cities: a city draws it at (p - its position).
 *   route(A, B)        A, B = {world, x, z (archipelago m), W (a packed world, games/world.js) or null}
 *                      -> R = {pts: Float64Array [x0, z0, ...], s (m along), t (s at each point), v (m/s),
 *                              len, T (s), hand (s: where the trip changes cities, mid-sea), mouthA, mouthB}
 *                      A city without its W (one you are not in) gets a nominal river: 600 m straight in.
 *   poseAt(R, t)       -> {x, z, yaw, speed, along, leg: "river" | "sea", u (0..1)}; yaw 0 faces +z
 *   sailings(a, b, nowMs, every) the departures (ms) of the route a <-> b around now (the same on every client)
 * Speeds: 6.5 m/s in a river, 21 m/s at sea, 0.45 m/s² either way, so it eases off the berth and onto it.
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};

var RIVER_V = 6.5, SEA_V = 21, ACC = 0.45;
var OFFSHORE = 260;             // m: the sea lane round a coast, outside its furthest point
var NOMINAL_COAST = 900, NOMINAL_RIVER = 600;
var STEP = 30;                  // m between points on an arc or a straight
var EVERY = 120000;             // ms between sailings on a route

function hyp(x, z){ return Math.sqrt(x*x + z*z); }
function wrap(a){ while(a > Math.PI) a -= 2*Math.PI; while(a < -Math.PI) a += 2*Math.PI; return a; }

// the coast's furthest point from the city's centre (m)
function coastR(W){
  var c = W && W.island && W.island.coast, m = 0;
  if(!c || !c.length) return NOMINAL_COAST;
  for(var i = 0; i < c.length; i++) m = Math.max(m, hyp(c[i][0], c[i][1])/100);
  return m;
}
// the ferry's berth: off the dock's front (into the water it faces), else off the port
function berthOf(W){
  var sites = (W && W.sites) || [], s = null;
  for(var i = 0; i < sites.length && !s; i++) if(sites[i].kind === "dock") s = sites[i];
  for(var j = 0; j < sites.length && !s; j++) if(sites[j].kind === "port") s = sites[j];
  if(!s) return null;
  var f = s.front ? [s.front[0]/65536, s.front[1]/65536] : [0, 1], l = hyp(f[0], f[1]) || 1;
  f = [f[0]/l, f[1]/l];
  var r = (s.d || 2400)/200 + 9;
  return {x: s.x/100 + f[0]*r, z: s.z/100 + f[1]*r, yaw: Math.atan2(f[0], f[1]), site: s.id};
}
// a city's inland water leg, local metres from its berth out to its river mouth: [[x, z], ...]
function inland(W){
  var b = berthOf(W), R = W && W.river && W.river.center;
  if(!b || !R || R.length < 2){
    var a0 = b ? Math.atan2(b.x, b.z) : 0, r0 = b ? hyp(b.x, b.z) : coastR(W) - NOMINAL_RIVER;
    var out = [];
    for(var r = r0; r < coastR(W); r += STEP) out.push([Math.sin(a0)*r, Math.cos(a0)*r]);
    out.push([Math.sin(a0)*coastR(W), Math.cos(a0)*coastR(W)]);
    return out;
  }
  // the river's centre (mouth first) from the point nearest the berth back to the mouth
  var k = 0, kd = Infinity;
  for(var i = 0; i < R.length; i++){ var d = hyp(R[i][0]/100 - b.x, R[i][1]/100 - b.z); if(d < kd){ kd = d; k = i; } }
  var P = [[b.x, b.z]];
  for(var j = k; j >= 0; j--) P.push([R[j][0]/100, R[j][1]/100]);
  return P;
}
function nominal(cx, cz, toward){
  // a city we have no doc for: a straight river 600 m in from its coast, facing the other city
  var a = Math.atan2(toward[0] - cx, toward[1] - cz), P = [];
  for(var r = NOMINAL_COAST - NOMINAL_RIVER; r <= NOMINAL_COAST; r += STEP) P.push([Math.sin(a)*r, Math.cos(a)*r]);
  return P;
}
// an arc round (cx, cz) at radius r from angle a0 to a1 (the short way), endpoints included
function arc(cx, cz, r, a0, a1, out){
  var da = wrap(a1 - a0), n = Math.max(1, Math.ceil(Math.abs(da)*r/STEP));
  for(var i = 0; i <= n; i++){ var a = a0 + da*i/n; out.push([cx + Math.sin(a)*r, cz + Math.cos(a)*r]); }
}
function straight(p, q, out){
  var d = hyp(q[0] - p[0], q[1] - p[1]), n = Math.max(1, Math.ceil(d/STEP));
  for(var i = 1; i <= n; i++) out.push([p[0] + (q[0] - p[0])*i/n, p[1] + (q[1] - p[1])*i/n]);
}
// Chaikin corner cutting on the sea part only (the river's centre is smooth already)
function chaikin(P, from, to){
  var out = P.slice(0, from + 1);
  for(var i = from; i < to; i++){
    var a = P[i], b = P[i + 1];
    out.push([0.75*a[0] + 0.25*b[0], 0.75*a[1] + 0.25*b[1]], [0.25*a[0] + 0.75*b[0], 0.25*a[1] + 0.75*b[1]]);
  }
  return out.concat(P.slice(to));
}

function route(A, B){
  var Ax = +A.x || 0, Az = +A.z || 0, Bx = +B.x || 0, Bz = +B.z || 0;
  var la = A.W ? inland(A.W) : nominal(0, 0, [Bx - Ax, Bz - Az]);
  var lb = B.W ? inland(B.W) : nominal(0, 0, [Ax - Bx, Az - Bz]);
  var ra = (A.W ? coastR(A.W) : NOMINAL_COAST) + OFFSHORE, rb = (B.W ? coastR(B.W) : NOMINAL_COAST) + OFFSHORE;
  var P = [];
  la.forEach(function(p){ P.push([p[0] + Ax, p[1] + Az]); });
  var nA = P.length;                                              // points [0, nA) are A's river
  var mA = la[la.length - 1], aOut = Math.atan2(mA[0], mA[1]);    // out from the mouth to the sea lane
  var toB = Math.atan2(Bx - Ax, Bz - Az), toA = wrap(toB + Math.PI);
  arc(Ax, Az, ra, aOut, toB, P);
  var mB = lb[lb.length - 1], bOut = Math.atan2(mB[0], mB[1]);
  var q = [Bx + Math.sin(toA)*rb, Bz + Math.cos(toA)*rb];
  straight(P[P.length - 1], q, P);
  arc(Bx, Bz, rb, toA, bOut, P);
  for(var i = lb.length - 1; i >= 0; i--) P.push([lb[i][0] + Bx, lb[i][1] + Bz]);
  var nB = lb.length;
  // smooth the joins at sea (and where the rivers meet it), twice; the river points stay as they are
  for(var pass = 0; pass < 2; pass++) P = chaikin(P, nA - 1, P.length - nB);
  // the river / sea split for speeds: the first nA points and the last nB
  var n = P.length, pts = new Float64Array(2*n), s = new Float64Array(n), v = new Float64Array(n), t = new Float64Array(n);
  for(var k = 0; k < n; k++){ pts[2*k] = P[k][0]; pts[2*k + 1] = P[k][1]; if(k) s[k] = s[k - 1] + hyp(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]); }
  for(var k2 = 0; k2 < n; k2++) v[k2] = k2 < nA || k2 >= n - nB ? RIVER_V : SEA_V;
  // standing at both berths; the speed limited by what the ferry can gain or shed over each step
  v[0] = 0; v[n - 1] = 0;
  for(var f = 1; f < n; f++) v[f] = Math.min(v[f], Math.sqrt(v[f - 1]*v[f - 1] + 2*ACC*(s[f] - s[f - 1])));
  for(var g = n - 2; g >= 0; g--) v[g] = Math.min(v[g], Math.sqrt(v[g + 1]*v[g + 1] + 2*ACC*(s[g + 1] - s[g])));
  for(var h = 1; h < n; h++){ var vm = (v[h] + v[h - 1])/2; t[h] = t[h - 1] + (s[h] - s[h - 1])/Math.max(0.3, vm); }
  // the handover: where the ferry is first nearer B's centre than A's (mid-sea, both cities far behind fog)
  var kh = n - 1;
  for(var e = nA; e < n; e++) if(hyp(P[e][0] - Bx, P[e][1] - Bz) <= hyp(P[e][0] - Ax, P[e][1] - Az)){ kh = e; break; }
  return {pts: pts, s: s, t: t, v: v, len: s[n - 1], T: t[n - 1], hand: t[kh], nA: nA, nB: nB,
          from: A.world, to: B.world, A: {x: Ax, z: Az}, B: {x: Bx, z: Bz}};
}
function timeAt(s, t, along){
  var lo = 0, hi = s.length - 1;
  if(along <= 0) return 0;
  if(along >= s[hi]) return t[hi];
  while(hi - lo > 1){ var m = (lo + hi) >> 1; if(s[m] <= along) lo = m; else hi = m; }
  var u = (along - s[lo])/Math.max(1e-9, s[hi] - s[lo]);
  return t[lo] + (t[hi] - t[lo])*u;
}
// the pose at t seconds after leaving the first berth
function poseAt(R, t){
  var T = R.t, n = T.length, P = R.pts;
  if(!(t > 0)) t = 0;
  if(t >= T[n - 1]) t = T[n - 1];
  var lo = 0, hi = n - 1;
  while(hi - lo > 1){ var m = (lo + hi) >> 1; if(T[m] <= t) lo = m; else hi = m; }
  // within a step the speed changes linearly: solve for the distance covered (v0 t + a t²/2)
  var dt = T[hi] - T[lo], ds = R.s[hi] - R.s[lo], v0 = R.v[lo], v1 = R.v[hi], tau = t - T[lo];
  var a = dt > 1e-9 ? (v1 - v0)/dt : 0, d = Math.min(ds, Math.max(0, v0*tau + a*tau*tau/2)), u = ds > 1e-9 ? d/ds : 0;
  var x = P[2*lo] + (P[2*hi] - P[2*lo])*u, z = P[2*lo + 1] + (P[2*hi + 1] - P[2*lo + 1])*u;
  // the heading looks a few points ahead so the bow leads the turns
  var j = Math.min(n - 1, hi + 1), i0 = Math.max(0, lo - 1);
  var yaw = Math.atan2(P[2*j] - P[2*i0], P[2*j + 1] - P[2*i0 + 1]);
  return {x: x, z: z, yaw: yaw, speed: v0 + a*tau, along: R.s[lo] + d,
          leg: lo < R.nA || lo >= n - R.nB ? "river" : "sea", u: R.T > 0 ? t/R.T : 1};
}
// the route's departures (ms) from nowMs - back to nowMs + ahead, the same for every client and both directions
function hash(a, b){
  var s = a < b ? a + "|" + b : b + "|" + a, h = 2166136261;
  for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}
function sailings(a, b, nowMs, back, ahead, every){
  every = every || EVERY;
  var off = hash(a, b) % every, out = [];
  var k0 = Math.floor((nowMs - back - off)/every), k1 = Math.ceil((nowMs + ahead - off)/every);
  for(var k = k0; k <= k1; k++){ var d = k*every + off; if(d >= nowMs - back && d <= nowMs + ahead) out.push(d); }
  return out;
}
function nextSailing(a, b, nowMs, every){ every = every || EVERY; var off = hash(a, b) % every; return Math.ceil((nowMs - off)/every)*every + off; }

HQV.hqVoyage = {route: route, poseAt: poseAt, sailings: sailings, nextSailing: nextSailing, berthOf: berthOf,
                inland: inland, coastR: coastR, EVERY: EVERY, RIVER_V: RIVER_V, SEA_V: SEA_V};
})();
