/* Claude HQ: road navigation in the 3D City (HQ 3.1, docs/plans/nav-river-spec.md "Client: navigation").
 *
 * HQV.hqnav routes on the road graph of a packed world W (games/world.js pack: W.nodes, W.edges with
 * pts Int32Array cm, a, b, cls, name, min_tier, bridge). Pure: no DOM, no THREE; metres throughout.
 *   graph(W, tier)            -> G  the roads open at this tier (edges with min_tier > tier left out),
 *                                   cached on W per tier; bridges are ordinary edges
 *   snap(G, x, z)             -> {ei, s, x, z, d}: the nearest point on a road (ei: the W.edges index,
 *                                   s: m along it from node a), through a 32 m segment grid
 *   route(G, from, to, mode)  -> R | null  A* over the junctions, "drive" (by class speed) or "walk";
 *                                   R.pts runs from `from` to `to` with the off-road legs to and from the
 *                                   snapped road points included; R.steps are the maneuvers
 *   progress(R, x, z, nowMs)  -> {along, left, off, next, toNext, arrived}; along never slips back more
 *                                   than BACK m, with hysteresis (state kept on R), nowMs (default Date.now()) times how
 *                                   long you have been off the route for needsReroute
 *   needsReroute(P, mode)     -> off by more than OFF[mode] m for over OFF_S s
 *   places(W, tier, o)        -> the "Go to" list, sorted by straight-line distance from (o.x, o.z); its travel
 *                                   entry names the live world (HQ 3.15, D2: HQV.world.COMMONS / islandId(uid), the @3 ids)
 * Turns (bearings as games/hqhud.js: yaw = atan2(dx, dz), increasing yaw turns LEFT): at a junction (a
 * node with 3+ roads) a heading change over 30 deg is a step; under 30 is "straight" and only kept when
 * the road name changes (at any node); 30-60 "slight", 60-135 plain, 135+ "sharp", turning back onto
 * the same road "uturn". A bridge's first edge is a "bridge" step unless a turn is already there.
 * Headings are measured over HEAD m either side of the node, so a kink in a short segment is not a turn.
 * A disconnected scrap of road never strands a route: when the two ends snap to different networks,
 * both are snapped again onto the largest one.
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : self;
var HQV = root.HQV = root.HQV || {};

var SPEED = {walk: 1.6, local: 12, street: 12, arterial: 16, avenue: 16, ring: 16, highway: 22};   // m/s
var VMAX = 22;                                // the fastest road: keeps the A* heuristic admissible
var GRID = 32;                                // the snap grid (m)
var HEAD = 8;                                 // a turn's headings are measured over this far (m)
var BACK = 15;                                // progress never slips back further than this (m)
var BACK_K = 0.75, AHEAD_K = 0.02;            // a point behind / ahead of the last along costs this much per m
                                              // (hysteresis: corner jitter keeps going forward, where the route
                                              // overlaps itself the nearer copy wins, really backing up tracks)
var ARRIVE = {drive: 12, walk: 6}, OFF = {drive: 25, walk: 15}, OFF_S = 2;
var DEG = 180/Math.PI;

function clamp(v, a, b){ return v < a ? a : (v > b ? b : v); }

/* ---------- a binary min-heap on (key, value) typed arrays (as games/npcsim.js) ---------- */
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

/* ---------- the graph ---------- */
// G: per kept edge (k = 0..M-1) its W index, end nodes, class speed, length, xz polyline (m) and the
// cumulative length at each point; CSR adjacency per node; connected components; the segment grid.
function graph(W, tier){
  tier = tier == null ? 5 : tier | 0;
  var cache = W.navGraphs;
  if(!cache){
    cache = {};
    try { Object.defineProperty(W, "navGraphs", {value: cache, enumerable: false, configurable: true, writable: true}); } catch(e){ W.navGraphs = cache; }
  }
  if(cache[tier]) return cache[tier];
  var nodeIx = {}, N = W.nodes.length, i, k;
  W.nodes.forEach(function(n, j){ nodeIx[n.id] = j; });
  var keep = [];
  W.edges.forEach(function(e, ei){
    if(e.min_tier != null && (e.min_tier | 0) > tier) return;
    if(nodeIx[e.a] == null || nodeIx[e.b] == null || e.pts.length < 6) return;
    keep.push(ei);
  });
  var M = keep.length, EA = new Int32Array(M), EB = new Int32Array(M), LEN = new Float64Array(M);
  var XZ = new Array(M), CUM = new Array(M);
  for(k = 0; k < M; k++){
    var e = W.edges[keep[k]], p = e.pts, m = p.length/3, xz = new Float64Array(2*m), cum = new Float64Array(m);
    for(i = 0; i < m; i++){
      xz[2*i] = p[3*i]/100; xz[2*i+1] = p[3*i+2]/100;
      if(i) cum[i] = cum[i-1] + Math.hypot(xz[2*i] - xz[2*i-2], xz[2*i+1] - xz[2*i-1]);
    }
    EA[k] = nodeIx[e.a]; EB[k] = nodeIx[e.b]; LEN[k] = cum[m-1]; XZ[k] = xz; CUM[k] = cum;
  }
  // node positions (the A* heuristic) and degrees (3+ roads: a junction)
  var NX = new Float64Array(N), NZ = new Float64Array(N), deg = new Int32Array(N);
  W.nodes.forEach(function(n, j){ NX[j] = n.x/100; NZ[j] = n.z/100; });
  for(k = 0; k < M; k++){ deg[EA[k]]++; deg[EB[k]]++; }
  var off = new Int32Array(N + 1);
  for(i = 0; i < N; i++) off[i + 1] = off[i] + deg[i];
  var adj = new Int32Array(2*M), fill = off.slice(0, N);
  for(k = 0; k < M; k++){ adj[fill[EA[k]]++] = k; adj[fill[EB[k]]++] = k; }
  // components (by node), and the largest by road length
  var comp = new Int32Array(N).fill(-1), sizes = [], stack = [];
  for(i = 0; i < N; i++){
    if(comp[i] >= 0 || !deg[i]) continue;
    var c = sizes.length, size = 0; comp[i] = c; stack.push(i);
    while(stack.length){
      var n = stack.pop();
      for(var j = off[n]; j < off[n + 1]; j++){
        var q = adj[j], o = EA[q] === n ? EB[q] : EA[q];
        if(EA[q] === n) size += LEN[q];
        if(comp[o] < 0){ comp[o] = c; stack.push(o); }
      }
    }
    sizes.push(size);
  }
  var main = 0;
  for(c = 1; c < sizes.length; c++) if(sizes[c] > sizes[main]) main = c;
  // the segment grid: (k, s) pairs per cell, by each segment's box
  var x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for(k = 0; k < M; k++) for(i = 0; i < XZ[k].length; i += 2){
    x0 = Math.min(x0, XZ[k][i]); x1 = Math.max(x1, XZ[k][i]); z0 = Math.min(z0, XZ[k][i+1]); z1 = Math.max(z1, XZ[k][i+1]);
  }
  if(!M){ x0 = z0 = 0; x1 = z1 = 1; }
  var GX = Math.max(1, Math.ceil((x1 - x0)/GRID) + 1), GZ = Math.max(1, Math.ceil((z1 - z0)/GRID) + 1), cells = new Array(GX*GZ);
  for(i = 0; i < cells.length; i++) cells[i] = [];
  for(k = 0; k < M; k++){
    var P = XZ[k];
    for(i = 0; i + 3 < P.length; i += 2){
      var cx0 = Math.floor((Math.min(P[i], P[i+2]) - x0)/GRID), cx1 = Math.floor((Math.max(P[i], P[i+2]) - x0)/GRID);
      var cz0 = Math.floor((Math.min(P[i+1], P[i+3]) - z0)/GRID), cz1 = Math.floor((Math.max(P[i+1], P[i+3]) - z0)/GRID);
      for(var gz = cz0; gz <= cz1; gz++) for(var gx = cx0; gx <= cx1; gx++) cells[gz*GX + gx].push(k, i >> 1);
    }
  }
  var G = {W: W, tier: tier, N: N, M: M, keep: keep, EA: EA, EB: EB, LEN: LEN, XZ: XZ, CUM: CUM,
           NX: NX, NZ: NZ, deg: deg, off: off, adj: adj, comp: comp, main: main,
           grid: {x0: x0, z0: z0, GX: GX, GZ: GZ, cells: cells},
           g: new Float64Array(N), from: new Int32Array(N), stamp: new Int32Array(N), closed: new Int32Array(N), gen: 0,
           heap: new Heap(64)};
  cache[tier] = G;
  return G;
}

/* ---------- snapping ---------- */
// the nearest point on kept edge k's segment s to (x, z) -> into T (no allocation)
var T = {d: 0, s: 0, x: 0, z: 0};
function projSeg(G, k, s, x, z){
  var P = G.XZ[k], ax = P[2*s], az = P[2*s+1], dx = P[2*s+2] - ax, dz = P[2*s+3] - az;
  var L2 = dx*dx + dz*dz, t = L2 > 0 ? clamp(((x - ax)*dx + (z - az)*dz)/L2, 0, 1) : 0;
  T.x = ax + dx*t; T.z = az + dz*t; T.d = Math.hypot(x - T.x, z - T.z);
  T.s = G.CUM[k][s] + t*(G.CUM[k][s+1] - G.CUM[k][s]);
}
// the nearest road point, ring by ring out from (x, z)'s cell until no closer cell is left;
// comp >= 0 keeps only that component's roads -> {k, ei, s, x, z, d} | null
function snapK(G, x, z, comp){
  if(!G.M) return null;
  var R = G.grid, cx = Math.floor((x - R.x0)/GRID), cz = Math.floor((z - R.z0)/GRID), best = null;
  var maxR = Math.max(R.GX, R.GZ) + Math.max(Math.abs(cx), Math.abs(cz));
  for(var r = 0; r <= maxR; r++){
    if(best && best.d < (r - 1)*GRID) break;
    for(var gz = cz - r; gz <= cz + r; gz++){
      if(gz < 0 || gz >= R.GZ) continue;
      var edge = gz === cz - r || gz === cz + r;
      for(var gx = cx - r; gx <= cx + r; gx += (edge ? 1 : 2*r || 1)){
        if(gx < 0 || gx >= R.GX) continue;
        var L = R.cells[gz*R.GX + gx];
        for(var i = 0; i < L.length; i += 2){
          var k = L[i];
          if(comp >= 0 && G.comp[G.EA[k]] !== comp) continue;
          projSeg(G, k, L[i+1], x, z);
          if(!best || T.d < best.d) best = {k: k, ei: G.keep[k], s: T.s, x: T.x, z: T.z, d: T.d};
        }
      }
    }
  }
  return best;
}
function snap(G, x, z){
  var b = snapK(G, x, z, -1);
  return b ? {ei: b.ei, s: b.s, x: b.x, z: b.z, d: b.d} : null;
}

/* ---------- routing ---------- */
function speedOf(G, k, mode){ return mode === "walk" ? SPEED.walk : (SPEED[G.W.edges[G.keep[k]].cls] || SPEED.local); }
// the point s m along kept edge k -> [x, z]
function pointAt(G, k, s){
  var cum = G.CUM[k], P = G.XZ[k], m = cum.length, lo = 0, hi = m - 1;
  s = clamp(s, 0, cum[m-1]);
  while(hi - lo > 1){ var mid = (lo + hi) >> 1; if(cum[mid] <= s) lo = mid; else hi = mid; }
  var L = cum[hi] - cum[lo], t = L > 0 ? (s - cum[lo])/L : 0;
  return [P[2*lo] + (P[2*hi] - P[2*lo])*t, P[2*lo+1] + (P[2*hi+1] - P[2*lo+1])*t];
}

// A* from snap A to snap B over whole edges -> the legs [{k, s0, s1}] (a leg runs s0 -> s1 along edge k)
function legsOf(G, A, B, mode){
  var vmax = mode === "walk" ? SPEED.walk : VMAX, vA = speedOf(G, A.k, mode), vB = speedOf(G, B.k, mode);
  var best = Infinity, end = -1, direct = A.k === B.k;
  if(direct) best = Math.abs(B.s - A.s)/vA;
  var gen = ++G.gen, H = G.heap, g = G.g, from = G.from, stamp = G.stamp, closed = G.closed, tx = B.x, tz = B.z;
  H.n = 0;
  function hd(n){ return Math.hypot(G.NX[n] - tx, G.NZ[n] - tz)/vmax; }
  function seed(n, c){ if(stamp[n] !== gen || c < g[n]){ stamp[n] = gen; g[n] = c; from[n] = -1; H.push(c + hd(n), n); } }
  seed(G.EA[A.k], A.s/vA);
  seed(G.EB[A.k], (G.LEN[A.k] - A.s)/vA);
  var bA = G.EA[B.k], bB = G.EB[B.k];
  while(H.n){
    var n = H.pop();
    if(H.top >= best) break;
    if(closed[n] === gen) continue;
    closed[n] = gen;
    if(n === bA && g[n] + B.s/vB < best){ best = g[n] + B.s/vB; end = n; }
    if(n === bB && g[n] + (G.LEN[B.k] - B.s)/vB < best){ best = g[n] + (G.LEN[B.k] - B.s)/vB; end = n; }
    for(var j = G.off[n]; j < G.off[n + 1]; j++){
      var k = G.adj[j], o = G.EA[k] === n ? G.EB[k] : G.EA[k], c = g[n] + G.LEN[k]/speedOf(G, k, mode);
      if(closed[o] === gen) continue;
      if(stamp[o] !== gen || c < g[o]){ stamp[o] = gen; g[o] = c; from[o] = k; H.push(c + hd(o), o); }
    }
  }
  if(end < 0) return direct ? [{k: A.k, s0: A.s, s1: B.s}] : null;
  // back from the end node to a seed (from = -1), whole edges in reverse
  var mid = [], n2 = end, guard = G.N + 1;
  while(from[n2] >= 0 && guard-- > 0){
    var k2 = from[n2], a = G.EA[k2] === n2;   // entered n2 at end a (so walked b -> a) when a
    mid.push(a ? {k: k2, s0: G.LEN[k2], s1: 0} : {k: k2, s0: 0, s1: G.LEN[k2]});
    n2 = a ? G.EB[k2] : G.EA[k2];
  }
  mid.reverse();
  var first = {k: A.k, s0: A.s, s1: n2 === G.EA[A.k] && (n2 !== G.EB[A.k] || A.s <= G.LEN[A.k] - A.s) ? 0 : G.LEN[A.k]};
  var last = {k: B.k, s0: end === bA && (end !== bB || B.s <= G.LEN[B.k] - B.s) ? 0 : G.LEN[B.k], s1: B.s};
  return [first].concat(mid, [last]);
}

// the leg's xz points from s0 to s1 (both ends included), pushed onto out
function emitLeg(G, L, out){
  var cum = G.CUM[L.k], P = G.XZ[L.k], m = cum.length, a = pointAt(G, L.k, L.s0), i;
  out.push(a[0], a[1]);
  if(L.s1 >= L.s0){ for(i = 0; i < m; i++) if(cum[i] > L.s0 && cum[i] < L.s1) out.push(P[2*i], P[2*i+1]); }
  else { for(i = m - 1; i >= 0; i--) if(cum[i] < L.s0 && cum[i] > L.s1) out.push(P[2*i], P[2*i+1]); }
  var b = pointAt(G, L.k, L.s1);
  out.push(b[0], b[1]);
}
// the heading (yaw) of leg L near its start (atEnd false) or its end, over up to HEAD m
function legYaw(G, L, atEnd){
  var dir = L.s1 >= L.s0 ? 1 : -1, len = Math.abs(L.s1 - L.s0), h = Math.min(HEAD, len);
  var p, q;
  if(atEnd){ p = pointAt(G, L.k, L.s1 - dir*h); q = pointAt(G, L.k, L.s1); }
  else { p = pointAt(G, L.k, L.s0); q = pointAt(G, L.k, L.s0 + dir*h); }
  return Math.atan2(q[0] - p[0], q[1] - p[1]);
}
function nameOf(e){ return e ? (e.name || e.ref || "") : ""; }
// a signed heading change (deg, + = left) and whether it turns back onto the same road -> a step kind
function turnKind(d, back){
  if(back) return "uturn";
  var a = Math.abs(d), left = d > 0;
  if(a < 30) return "straight";
  if(a < 60) return left ? "slight-left" : "slight-right";
  if(a < 135) return left ? "left" : "right";
  return left ? "sharp-left" : "sharp-right";
}

function route(G, from, to, mode){
  mode = mode === "drive" ? "drive" : "walk";
  if(!G || !from || !to) return null;
  var A = snapK(G, from.x, from.z, -1), B = snapK(G, to.x, to.z, -1);
  if(!A || !B) return null;
  if(G.comp[G.EA[A.k]] !== G.comp[G.EA[B.k]]){
    A = snapK(G, from.x, from.z, G.main); B = snapK(G, to.x, to.z, G.main);
    if(!A || !B) return null;
  }
  var legs = legsOf(G, A, B, mode);
  if(!legs) return null;
  legs = legs.filter(function(L){ return Math.abs(L.s1 - L.s0) > 1e-6; });
  var xs = [from.x, from.z], steps = [], along = 0, eta = 0, vOff = mode === "walk" ? SPEED.walk : SPEED.local, W = G.W;
  function dist(ax, az, bx, bz){ return Math.hypot(bx - ax, bz - az); }
  along = A.d; eta = A.d/vOff;
  var e0 = legs.length ? W.edges[G.keep[legs[0].k]] : null;
  steps.push({at: 0, kind: "start", road: nameOf(e0), x: from.x, z: from.z});
  legs.forEach(function(L, i){
    var e = W.edges[G.keep[L.k]], len = Math.abs(L.s1 - L.s0), p0 = pointAt(G, L.k, L.s0);
    if(i > 0){
      var P = legs[i - 1], pe = W.edges[G.keep[P.k]];
      var node = L.s0 === 0 ? G.EA[L.k] : G.EB[L.k];
      var d = (legYaw(G, L, false) - legYaw(G, P, true))*DEG;
      d = ((d % 360) + 540) % 360 - 180;
      var back = P.k === L.k, kind = turnKind(d, back), renamed = nameOf(pe) !== nameOf(e);
      var turn = back || (kind !== "straight" && G.deg[node] >= 3) || renamed;
      if(turn) steps.push({at: along, kind: kind, road: nameOf(e), x: p0[0], z: p0[1]});
      else if(e.bridge && !pe.bridge) steps.push({at: along, kind: "bridge", road: nameOf(e), x: p0[0], z: p0[1]});
    }
    emitLeg(G, L, xs);
    along += len; eta += len/speedOf(G, L.k, mode);
  });
  if(!legs.length) xs.push(A.x, A.z, B.x, B.z);
  xs.push(to.x, to.z);
  // drop repeated points, then measure the polyline (the steps' `at` were measured the same way)
  var pts = [xs[0], xs[1]];
  for(var i = 2; i < xs.length; i += 2){
    if(dist(pts[pts.length - 2], pts[pts.length - 1], xs[i], xs[i+1]) > 1e-3) pts.push(xs[i], xs[i+1]);
  }
  if(pts.length < 4) pts.push(to.x, to.z);
  var cum = new Float64Array(pts.length/2);
  for(i = 1; i < cum.length; i++) cum[i] = cum[i-1] + dist(pts[2*i-2], pts[2*i-1], pts[2*i], pts[2*i+1]);
  var total = cum[cum.length - 1];
  eta += B.d/vOff;
  var eN = legs.length ? W.edges[G.keep[legs[legs.length - 1].k]] : null;
  steps.push({at: total, kind: "arrive", road: nameOf(eN), x: to.x, z: to.z});
  steps.forEach(function(s){ s.at = Math.min(s.at, total); });
  return {pts: Float64Array.from(pts), cum: cum, len: total, eta_s: eta, steps: steps, mode: mode,
          to: {x: to.x, z: to.z}, st: {along: 0, offSince: {drive: -1, walk: -1}}};
}

/* ---------- following a route ---------- */
function progress(R, x, z, nowMs){
  var P = R.pts, cum = R.cum, n = cum.length, st = R.st, floor = st.along - BACK, now = nowMs != null ? nowMs : Date.now();
  var bestD = Infinity, bestA = st.along, bestS = Infinity;
  for(var i = 0; i + 1 < n; i++){
    if(cum[i + 1] < floor) continue;   // wholly behind where you may slip back to
    var ax = P[2*i], az = P[2*i+1], dx = P[2*i+2] - ax, dz = P[2*i+3] - az, L2 = dx*dx + dz*dz;
    var t = L2 > 0 ? clamp(((x - ax)*dx + (z - az)*dz)/L2, 0, 1) : 0;
    var a = cum[i] + t*(cum[i+1] - cum[i]);
    if(a < floor){ a = floor; t = (a - cum[i])/((cum[i+1] - cum[i]) || 1); }
    var d = Math.hypot(x - (ax + dx*t), z - (az + dz*t)), sc = d + (a < st.along ? BACK_K*(st.along - a) : AHEAD_K*(a - st.along));
    if(sc < bestS){ bestS = sc; bestD = d; bestA = a; }
  }
  st.along = bestA;
  var next = null;
  for(i = 0; i < R.steps.length; i++) if(R.steps[i].at > bestA){ next = R.steps[i]; break; }
  if(!next) next = R.steps[R.steps.length - 1];
  var offFor = {};
  ["drive", "walk"].forEach(function(m){
    if(bestD > OFF[m]){ if(st.offSince[m] < 0) st.offSince[m] = now; }
    else st.offSince[m] = -1;
    offFor[m] = st.offSince[m] < 0 ? 0 : (now - st.offSince[m])/1000;
  });
  var end = Math.hypot(x - P[P.length - 2], z - P[P.length - 1]);
  return {along: bestA, left: Math.max(0, R.len - bestA), off: bestD, next: next, toNext: Math.max(0, next.at - bestA),
          arrived: end <= ARRIVE[R.mode], offFor: offFor};
}
function needsReroute(P, mode){
  mode = mode === "drive" ? "drive" : "walk";
  return !!P && P.off > OFF[mode] && (P.offFor ? P.offFor[mode] : 0) > OFF_S;
}

/* ---------- places ---------- */
var KINDS = {
  dock: ["Ferry Dock", "⚓"], port: ["Port", "🚢"], transit: ["Transit Hub", "🚉"],
  airport: ["Airport", "✈️"], townhall: ["Town Hall", "🏛️"], hospital: ["Hospital", "🏥"],
  clinic: ["Clinic", "⚕️"], police: ["Police", "🚓"], fire: ["Fire Station", "🚒"],
  school: ["School", "🏫"], university: ["University", "🎓"], market: ["Market", "🛒"],
  mall: ["Mall", "🛍️"], bank: ["Bank", "🏦"], library: ["Library", "📚"],
  post: ["Post Office", "📮"], stadium: ["Stadium", "🏟️"], fountain: ["Fountain", "⛲"],
  // games/hqspectacle.js claims these (each carries its own name): the amusement park and the landmark towers
  funpark: ["Amusement park", "🎡"], landmark: ["Landmark", "🏙️"],
  skatepark: ["Skatepark", "🛹"], dealer: ["Dealership", "🚘"], carpark: ["Garage", "🅿️"],
  casino: ["Casino", "🎰"],                    // games/hqcasino.js (its own name: The Lucky Byte)
  tuning: ["Tuning shop", "🔧"],                // [3.13] games/hqtuning.js (its own name: Redline Tuning)
  gp: ["Grand Prix Circuit", "🏁"],             // [3.17] games/hqgpvenue.js: the way into every F1 circuit
  petshop: ["Pet shop", "🐾"],                 // [pets 3.14] games/hqpets.js (its own name: Paws & Claws)
  stunt: ["Stunt", "🚀"]                       // [stunts] games/hqstunts.js (each its own name: Sky Cannon, Mega Loop...)
};
var ICON = {myhq: "🏠", hq: "🏢", travel: "⛴️"};
var DOOR_OUT = 2;   // a door stands this far out past the site's edge (m)

// a site's front as a unit [fx, fz]: its Q16 front, else @1's facing (north = +z)
function frontOf(s){
  if(s.front && s.front.length === 2){
    var fx = s.front[0]/65536, fz = s.front[1]/65536, l = Math.hypot(fx, fz);
    if(l > 1e-6) return [fx/l, fz/l];
  }
  return s.facing === "south" ? [0, -1] : [0, 1];
}
// how far the site reaches along f from its centre (m)
function reach(s, f){
  if(s.poly && s.poly.length){
    var m = 0;
    s.poly.forEach(function(p){ m = Math.max(m, ((p[0] - s.x)*f[0] + (p[1] - s.z)*f[1])/100); });
    return m;
  }
  return Math.abs(f[0])*(s.w || 0)/200 + Math.abs(f[1])*(s.d || 0)/200;
}
// where you walk up to: out in front of the site; a dock's or port's front faces the water (its pier),
// so its door is on the land side behind it
function doorOf(s){
  var f = frontOf(s);
  if(s.kind === "dock" || s.kind === "port") f = [-f[0], -f[1]];
  var h = reach(s, f) + DOOR_OUT;
  return {x: s.x/100 + f[0]*h, z: s.z/100 + f[1]*h};
}
function lotDoor(l){
  if(l.door && l.door.length >= 3) return {x: l.door[0]/100, z: l.door[2]/100};
  return doorOf(l);
}

// the live ids (HQ 3.15, D2): HQV.world's when loaded, else the @3 forms
function liveCommons(){ var A = HQV.world; return A && A.COMMONS ? A.COMMONS : "claude-hq@3"; }
function liveIsland(uid){
  var A = HQV.world, id = A && A.islandId ? A.islandId(uid) : null;
  return id || "user:" + String(uid).replace(/^user:/, "").replace(/@[0-9]+$/, "") + "@3";
}
function places(W, tier, o){
  o = o || {}; tier = tier == null ? 5 : tier | 0;
  var px = +o.x || 0, pz = +o.z || 0, out = [], terminals = [];
  function add(p){ p.dist = Math.hypot(p.door.x - px, p.door.z - pz); out.push(p); }
  (W.sites || []).forEach(function(s){
    var K = KINDS[s.kind];
    if(!K || (s.tier != null && (s.tier | 0) > tier) || (s.min_tier != null && (s.min_tier | 0) > tier)) return;
    var door = doorOf(s), p = {id: s.id, kind: s.kind, label: s.name ? String(s.name) : K[0], icon: K[1], x: s.x/100, z: s.z/100, door: door};
    add(p);
    if(s.kind === "dock" || s.kind === "port") terminals.push(p);
  });
  var lots = {};
  (W.lots || []).forEach(function(l){ lots[l.id] = l; });
  (o.hqs || []).forEach(function(h){
    if(!h || typeof h.userId !== "string") return;
    var l = h.lot != null && typeof h.lot === "object" ? h.lot : lots[h.lot];
    if(!l) return;
    var mine = o.me != null && h.userId === o.me, name = h.name ? String(h.name) : "";
    add({id: "hq:" + h.userId, kind: mine ? "myhq" : "hq", label: mine ? "Your HQ" : (name ? name + "'s HQ" : "HQ"),
         icon: mine ? ICON.myhq : ICON.hq, x: l.x/100, z: l.z/100, door: lotDoor(l), userId: h.userId});
  });
  // travel: to the Commons from an island, to your island from the Commons; its door is the nearest
  // dock or port open at this tier
  if(W.island && terminals.length){
    var t = terminals.slice().sort(function(a, b){ return a.dist - b.dist; })[0];
    var world = o.island ? liveCommons() : (o.me ? liveIsland(o.me) : null);
    if(world) add({id: "travel:" + world, kind: "travel", label: o.island ? "The Commons (ferry)" : "My island (ferry)",
                   icon: ICON.travel, x: t.x, z: t.z, door: {x: t.door.x, z: t.door.z}, world: world, via: t.id});
  }
  out.sort(function(a, b){ return a.dist - b.dist || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
  return out;
}

HQV.hqnav = {
  graph: graph, snap: snap, route: route, progress: progress, needsReroute: needsReroute, places: places,
  SPEED: SPEED, ARRIVE: ARRIVE, OFF: OFF, OFF_S: OFF_S, turnKind: turnKind, doorOf: doorOf
};
})();
