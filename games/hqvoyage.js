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

/* ---------- big ships: the cruise ship and the cargo ships, sea only (too big for the rivers) ----------
 * arch: archipelago METRES {commons: {x, z}, islands: [{world, name, x, z, W?}]} (hqcity3d's archMetres). A city's
 * coast radius is coastR(W) when its W is given, else 950 m; every client passes none, so every client builds the
 * same loops. The cruise loop visits every city once (a nearest-neighbour tour, untangled), standing off each one on
 * its outer side; each cargo ship loops through 2-4 cities' anchorages (off the coast + ~420 m, beside the cruise
 * stop). The paths are centripetal Catmull-Rom splines through those points, with detour points added round any
 * island they cut too close to (planned at coast + 350 m, never under coast + 200 m), so they turn smoothly.
 *   seaLoop(arch, "cruise")      -> R (as route: pts, s, t, v, T; plus stops [{world, name, t0, t1 (s on the loop)}])
 *   seaLoop(arch, "cargo", k)    -> the k-th cargo ship's loop
 *   fleet(arch)                  -> {cruise: [ship], cargo: [ship], anchor: {world: {x, z}}}; ship = {kind, k, name, R, off (s), boxes}
 *   shipAt(ship, nowMs, warp)    -> poseAt at the ship's place on its loop now (the same on every client)
 *   calls(ship, world, nowMs, aheadMs) -> its stops at world from now on: [{arrive, leave (ms), here (at anchor now)}]
 *   nextStop(ship, tLoop)        -> {stop, inS (s to its arrival, 0 at anchor), at (bool)}
 */
var PI2 = 2*Math.PI, RELAX = 400, BIG_NOMINAL = 950, BIG_PLAN = 350, BIG_DETOUR = 520;
var CRUISE_V = 11, CARGO_V = 9.5, BIG_ACC = 0.08, CRUISE_DWELL = 150, CARGO_DWELL = 210;
var CRUISE_STAND = 560, CARGO_STAND = 420, ANCHOR_TURN = 0.75;      // m off the coast; the anchorage's angle from the cruise stop
var CRUISE_NAMES = ["Claude Serenade", "Aurora of the Isles"];
var CARGO_NAMES = ["Context Carrier", "Token Trader", "Gradient Express", "Ever Attentive", "Maru Inference", "Northern Embedding"];

function bigCities(arch){
  arch = arch || {}; var out = [];
  function add(o, world, name){
    if(!o || !isFinite(+o.x) || !isFinite(+o.z)) return;
    out.push({world: world, name: name, x: +o.x, z: +o.z, r: o.W ? coastR(o.W) : (+o.r || BIG_NOMINAL)});
  }
  if(arch.commons) add(arch.commons, arch.commons.world || "claude-hq@2", "The Commons");
  var isl = (Array.isArray(arch.islands) ? arch.islands : []).slice().sort(function(a, b){ return String(a.world) < String(b.world) ? -1 : 1; });
  isl.forEach(function(o){ if(o && o.world) add(o, o.world, String(o.name || "An island").slice(0, 40)); });
  return out;
}
function tourOf(C){
  var n = C.length, left = C.map(function(_, i){ return i; }).slice(1), T = [0];
  while(left.length){
    var a = C[T[T.length - 1]], bi = 0, bd = Infinity;
    left.forEach(function(j, i){ var d = hyp(C[j].x - a.x, C[j].z - a.z); if(d < bd){ bd = d; bi = i; } });
    T.push(left.splice(bi, 1)[0]);
  }
  function D(i, j){ return hyp(C[T[i % n]].x - C[T[j % n]].x, C[T[i % n]].z - C[T[j % n]].z); }
  for(var pass = 0, better = true; better && pass < 50; pass++){          // 2-opt: no crossing legs
    better = false;
    for(var i = 0; i < n - 1; i++) for(var j = i + 2; j < n; j++){
      if(i === 0 && j === n - 1) continue;
      if(D(i, i + 1) + D(j, j + 1) > D(i, j) + D(i + 1, j + 1) + 1e-6){ T = T.slice(0, i + 1).concat(T.slice(i + 1, j + 1).reverse(), T.slice(j + 1)); better = true; }
    }
  }
  return T;
}
function unit(x, z){ var l = hyp(x, z); return l > 1e-9 ? [x/l, z/l] : [0, 1]; }
// each city's outward direction on the tour (away from both its neighbours), by world
function outwards(C, T){
  var n = T.length, cx = 0, cz = 0, out = {};
  C.forEach(function(c){ cx += c.x/C.length; cz += c.z/C.length; });
  T.forEach(function(ci, i){
    var c = C[ci], d;
    if(n === 1) d = [0, 1];
    else {
      var p = C[T[(i + n - 1) % n]], q = C[T[(i + 1) % n]], u1 = unit(p.x - c.x, p.z - c.z), u2 = unit(q.x - c.x, q.z - c.z);
      var bx = -(u1[0] + u2[0]), bz = -(u1[1] + u2[1]);
      if(hyp(bx, bz) < 0.25){ bx = u2[1]; bz = -u2[0]; if(bx*(c.x - cx) + bz*(c.z - cz) < 0){ bx = -bx; bz = -bz; } }
      d = unit(bx, bz);
    }
    out[c.world] = d;
  });
  return out;
}
function anchorOf(c, d, side){
  var a = Math.atan2(d[0], d[1]) + (((hash(c.world, "anchor") ^ (side | 0)) & 1) ? ANCHOR_TURN : -ANCHOR_TURN), r = c.r + CARGO_STAND;
  return {x: c.x + Math.sin(a)*r, z: c.z + Math.cos(a)*r};
}
// the leg a -> b round the islands in its way: where it cuts within coast + BIG_PLAN of a city, a detour point off
// that city on the side the leg passes (coast + BIG_DETOUR), and the two halves again (a few levels deep)
function legAround(a, b, C, depth, out){
  var dx = b.x - a.x, dz = b.z - a.z, L2 = dx*dx + dz*dz, hit = null, hd = Infinity;
  C.forEach(function(c){
    var u = L2 > 1e-9 ? Math.max(0, Math.min(1, ((c.x - a.x)*dx + (c.z - a.z)*dz)/L2)) : 0;
    var px = a.x + dx*u, pz = a.z + dz*u, d = hyp(px - c.x, pz - c.z);
    if(d < c.r + BIG_PLAN && u > 0 && u < 1 && u*Math.sqrt(L2) < hd){ hd = u*Math.sqrt(L2); hit = {c: c, px: px, pz: pz, d: d}; }
  });
  if(!hit || depth > 6){ out.push(b); return; }
  var c = hit.c, n = hit.d > 1 ? unit(hit.px - c.x, hit.pz - c.z) : unit(dz, -dx), r = c.r + BIG_DETOUR;
  var w = {x: c.x + n[0]*r, z: c.z + n[1]*r, stop: null};
  legAround(a, w, C, depth + 1, out); legAround(w, b, C, depth + 1, out);
}
// a closed polyline through K (detouring round islands), sampled every STEP m: [{x, z}]
function clearPath(K, C){
  var W = [];
  K.forEach(function(k, i){ var q = K[(i + 1) % K.length]; W.push(k); legAround(k, q, C, 0, W); W.pop(); });
  var P = [];
  W.forEach(function(p, i){
    var q = W[(i + 1) % W.length], d = hyp(q.x - p.x, q.z - p.z), m = Math.max(1, Math.ceil(d/STEP));
    for(var j = 0; j < m; j++) P.push({x: p.x + (q.x - p.x)*j/m, z: p.z + (q.z - p.z)*j/m});
  });
  return P;
}
// irons out what the detours bent: neighbours averaged, then pushed back out of every island's plan radius, and
// every few rounds laid out again at STEP spacing (so a hairpin opens into a turn rather than bunching up)
function resample(X, Z){
  var n = X.length, S = [0], L = 0, i;
  for(i = 1; i <= n; i++){ L += hyp(X[i % n] - X[i - 1], Z[i % n] - Z[i - 1]); S.push(L); }
  var m = Math.max(8, Math.round(L/STEP)), X2 = [], Z2 = [], k = 0;
  for(i = 0; i < m; i++){
    var at = L*i/m;
    while(k < n - 1 && S[k + 1] < at) k++;
    var u = (at - S[k])/Math.max(1e-9, S[k + 1] - S[k]), q = (k + 1) % n;
    X2.push(X[k] + (X[q] - X[k])*u); Z2.push(Z[k] + (Z[q] - Z[k])*u);
  }
  return [X2, Z2];
}
function relax(P, C, iters){
  var X = P.map(function(p){ return p.x; }), Z = P.map(function(p){ return p.z; });
  for(var it = 0; it < iters; it++){
    if(it % 8 === 0){ var rs = resample(X, Z); X = rs[0]; Z = rs[1]; }
    var n = X.length, X2 = X.slice(), Z2 = Z.slice();
    for(var i = 0; i < n; i++){ var a = (i + n - 1) % n, b = (i + 1) % n; X2[i] = 0.5*X[i] + 0.25*(X[a] + X[b]); Z2[i] = 0.5*Z[i] + 0.25*(Z[a] + Z[b]); }
    X = X2; Z = Z2;
    for(var j = 0; j < n; j++) C.forEach(function(c){
      var d = hyp(X[j] - c.x, Z[j] - c.z), r = c.r + BIG_PLAN;
      if(d < r){ var u = unit(X[j] - c.x, Z[j] - c.z); X[j] = c.x + u[0]*r; Z[j] = c.z + u[1]*r; }
    });
  }
  return X.map(function(x, i){ return {x: x, z: Z[i]}; });
}
function loopRoute(K, C, vmax, dwell){
  var P = relax(clearPath(K, C), C, RELAX), stopAt = {};
  // each stop at the sample nearest it (the smoothing may have moved the line a little)
  K.forEach(function(k, ki){
    if(!k.stop) return;
    var bi = 0, bd = Infinity;
    P.forEach(function(p, i){ var d = hyp(p.x - k.x, p.z - k.z); if(d < bd){ bd = d; bi = i; } });
    stopAt[ki] = bi;
  });
  var Q = [], isStop = [], stopOf = [];
  P.forEach(function(p, i){
    var st = null;
    Object.keys(stopAt).forEach(function(ki){ if(stopAt[ki] === i) st = K[ki].stop; });
    Q.push([p.x, p.z]); isStop.push(false); stopOf.push(null);
    if(st){ isStop[Q.length - 1] = true; Q.push([p.x, p.z]); isStop.push(true); stopOf.push(st); }   // arrive, then leave after the dwell
  });
  Q.push([P[0].x, P[0].z]); isStop.push(isStop[0]); stopOf.push(null);              // closed: back to the start
  var n = Q.length, pts = new Float64Array(2*n), s = new Float64Array(n), v = new Float64Array(n), t = new Float64Array(n);
  for(var k = 0; k < n; k++){ pts[2*k] = Q[k][0]; pts[2*k + 1] = Q[k][1]; if(k) s[k] = s[k - 1] + hyp(Q[k][0] - Q[k - 1][0], Q[k][1] - Q[k - 1][1]); v[k] = isStop[k] ? 0 : vmax; }
  var any = isStop.some(Boolean);
  for(var rep = 0; any && rep < 2; rep++){                                           // twice round: the wrap is eased too
    for(var f = 1; f < n; f++) v[f] = Math.min(v[f], Math.sqrt(v[f - 1]*v[f - 1] + 2*BIG_ACC*(s[f] - s[f - 1])));
    v[0] = Math.min(v[0], v[n - 1]);
    for(var g = n - 2; g >= 0; g--) v[g] = Math.min(v[g], Math.sqrt(v[g + 1]*v[g + 1] + 2*BIG_ACC*(s[g + 1] - s[g])));
    v[n - 1] = Math.min(v[n - 1], v[0]);
  }
  var stops = [];
  for(var h = 1; h < n; h++){
    var ds = s[h] - s[h - 1];
    if(ds < 1e-9 && stopOf[h]){ t[h] = t[h - 1] + dwell; stops.push({world: stopOf[h].world, name: stopOf[h].name, t0: t[h - 1], t1: t[h], x: Q[h][0], z: Q[h][1]}); }
    else t[h] = t[h - 1] + ds/Math.max(0.3, (v[h] + v[h - 1])/2);
  }
  return {pts: pts, s: s, t: t, v: v, len: s[n - 1], T: t[n - 1], hand: 0, nA: 0, nB: 0, loop: true, stops: stops};
}
// the cities, the cruise tour and each city's outward side on it
function bigPlan(arch){
  var C = bigCities(arch), T = tourOf(C);
  return {C: C, T: T, O: outwards(C, T)};
}
function seaLoop(arch, kind, k){
  var B = bigPlan(arch), C = B.C, K = [];
  if(!C.length) return null;
  if(kind === "cruise"){
    if(C.length === 1){
      var c = C[0], r = c.r + CRUISE_STAND;
      for(var i = 0; i < 8; i++){ var a = i*PI2/8; K.push({x: c.x + Math.sin(a)*r, z: c.z + Math.cos(a)*r, stop: i ? null : c}); }
    } else B.T.forEach(function(ci){ var c = C[ci], d = B.O[c.world], r = c.r + CRUISE_STAND; K.push({x: c.x + d[0]*r, z: c.z + d[1]*r, stop: c}); });
    return loopRoute(C.length === 2 ? bulge(K) : K, C, CRUISE_V, CRUISE_DWELL);
  }
  // cargo k: 2-4 cities, picked by hash, called at in tour order
  k = k | 0;
  var pick = B.T.slice();
  if(pick.length > 3){
    var size = Math.min(pick.length, 3 + (k % 2));
    var ranked = pick.slice().sort(function(a, b){ return hash(C[a].world, "cargo" + k) - hash(C[b].world, "cargo" + k); }).slice(0, size);
    pick = pick.filter(function(ci){ return ranked.indexOf(ci) >= 0; });
  }
  if(k % 2) pick.reverse();
  if(pick.length === 1){                                  // one city: round it, calling at its anchorage
    var c1 = C[pick[0]], a1 = anchorOf(c1, [0, 1], k), a0 = Math.atan2(a1.x - c1.x, a1.z - c1.z), r1 = c1.r + CARGO_STAND;
    for(var j = 0; j < 8; j++){ var aj = a0 + j*PI2/8; K.push({x: c1.x + Math.sin(aj)*r1, z: c1.z + Math.cos(aj)*r1, stop: j ? null : c1}); }
  } else {
    // its anchorages on the outer side of its own loop, beside the cruise stop (no hairpins into a far side)
    var O2 = outwards(C, pick);
    pick.forEach(function(ci){ var a = anchorOf(C[ci], O2[C[ci].world], k); K.push({x: a.x, z: a.z, stop: C[ci]}); });
  }
  return loopRoute(pick.length > 1 ? bulge(K) : K, C, CARGO_V, CARGO_DWELL);
}
// a loop through few points can fold flat (out and back on one line, a hairpin at each end): every leg bows out
// from the loop's middle by a fifth of its length (at most 900 m), the same side for all of them
function bulge(K){
  if(K.length < 2) return K;
  var cx = 0, cz = 0, n = K.length, out = [], side = 1, best = -1;
  K.forEach(function(k){ cx += k.x/n; cz += k.z/n; });
  K.forEach(function(p, i){
    var q = K[(i + 1) % n], L = hyp(q.x - p.x, q.z - p.z);
    if(L > best){ best = L; var mx = (p.x + q.x)/2 + (q.z - p.z)*0.01, mz = (p.z + q.z)/2 - (q.x - p.x)*0.01;
                  side = hyp(mx - cx, mz - cz) >= hyp((p.x + q.x)/2 - cx, (p.z + q.z)/2 - cz) ? 1 : -1; }
  });
  K.forEach(function(p, i){
    var q = K[(i + 1) % n], ex = q.x - p.x, ez = q.z - p.z, L = hyp(ex, ez), f = side*Math.min(0.2, 900/Math.max(1, L));
    out.push(p, {x: (p.x + q.x)/2 + ez*f, z: (p.z + q.z)/2 - ex*f, stop: null});
  });
  return out;
}
var fleetMemo = {key: null, out: null};          // every City built in a session asks for the same archipelago's
function fleet(arch){
  var B = bigPlan(arch), n = B.C.length, out = {cruise: [], cargo: []};
  var key = JSON.stringify(B.C.map(function(c){ return [c.world, Math.round(c.x), Math.round(c.z), Math.round(c.r)]; }));
  if(fleetMemo.key === key) return fleetMemo.out;
  fleetMemo.key = key; fleetMemo.out = out;
  if(!n) return out;
  var R = seaLoop(arch, "cruise"), nc = n > 4 ? 2 : 1;
  for(var i = 0; i < nc; i++) out.cruise.push({kind: "cruise", k: i, name: CRUISE_NAMES[i], R: R, off: (hash("cruise", "loop") % 100000)/100000*R.T + i*R.T/nc});
  var ng = Math.min(CARGO_NAMES.length, Math.max(1, Math.floor(n*0.75)));
  for(var j = 0; j < ng; j++){
    var Rg = seaLoop(arch, "cargo", j);
    out.cargo.push({kind: "cargo", k: j, name: CARGO_NAMES[j], R: Rg, off: (hash("cargo", String(j)) % 100000)/100000*Rg.T, boxes: 60 + hash("boxes", String(j)) % 140});
  }
  return out;
}
function loopT(ship, nowMs, warp){ var T = ship.R.T, t = (nowMs/1000 + ship.off + (warp || 0)) % T; return t < 0 ? t + T : t; }
function shipAt(ship, nowMs, warp){ return poseAt(ship.R, loopT(ship, nowMs, warp)); }
function nextStop(ship, tl){
  var S = ship.R.stops, T = ship.R.T, best = null;
  S.forEach(function(st){
    if(tl >= st.t0 && tl < st.t1){ best = {stop: st, inS: 0, at: true, leaveS: st.t1 - tl}; return; }
    var d = st.t0 - tl; if(d < 0) d += T;
    if(!best || (!best.at && d < best.inS)) best = {stop: st, inS: d, at: false, leaveS: d + st.t1 - st.t0};
  });
  return best;
}
function calls(ship, world, nowMs, aheadMs){
  var tl = loopT(ship, nowMs, 0), T = ship.R.T, out = [];
  ship.R.stops.forEach(function(st){
    if(st.world !== world) return;
    if(tl >= st.t0 && tl < st.t1){ out.push({arrive: nowMs - (tl - st.t0)*1000, leave: nowMs + (st.t1 - tl)*1000, here: true}); }
    for(var d = st.t0 - tl; d*1000 <= aheadMs; d += T) if(d > 0) out.push({arrive: nowMs + d*1000, leave: nowMs + (d + st.t1 - st.t0)*1000, here: false});
  });
  return out.sort(function(a, b){ return a.arrive - b.arrive; });
}

HQV.hqVoyage = {route: route, poseAt: poseAt, sailings: sailings, nextSailing: nextSailing, berthOf: berthOf,
                inland: inland, coastR: coastR, EVERY: EVERY, RIVER_V: RIVER_V, SEA_V: SEA_V,
                seaLoop: seaLoop, fleet: fleet, shipAt: shipAt, loopT: loopT, nextStop: nextStop, calls: calls, bigCities: bigCities,
                BIG_NOMINAL: BIG_NOMINAL, CRUISE_V: CRUISE_V, CARGO_V: CARGO_V};
})();
