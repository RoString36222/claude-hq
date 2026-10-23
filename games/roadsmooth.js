/* Claude HQ: curved roads for the 3D City (HQV.roadSmooth; world.js pack() calls smooth(W) when it is loaded).
 *
 * The server's cities are drawn as straight 24 m pieces between graph nodes, with kinks at the nodes where a road
 * bends. This pure module turns them into smooth curves on the client, once per packed W, so every consumer
 * (physics, rendering, traffic, residents, navigation, the minimap) reads the same curved geometry. Node ids and
 * node positions never change, nor do lots, sites or the server's hashes.
 *
 * smooth(W, opts) -> W   in place; each edge keeps its original points as e.pts0 (bridges: e.pts0 === e.pts).
 *   Chains: edges meeting at a degree-2 node with the same class and width (neither a bridge) are smoothed as one
 *     curve, then split back at the original nodes. A chain end (a junction, a dead end, a class change, a bridge)
 *     keeps its node's exact original point; an interior split is the curve's nearest point to the node (both
 *     edges share it exactly; it lies within the cap of the node). A closed loop of degree-2 nodes opens at its
 *     first edge's `a` node, which keeps its corner.
 *   Fillets: every corner of the chain's polyline (a turn over MIN_TURN) becomes a circular arc whose tangent
 *     length is the largest that keeps the arc within the cap of the polyline (R (1 - cos(θ/2)) <= cap) and fits
 *     in FILLET (45%) of either arm. A corner within LOCK m of a bridge end stays as it is, and no arc reaches into
 *     those LOCK m, so bridge decks and their approaches stay straight.
 *   Highways and the ring (A* staircases of +-45 deg every 8-11 m) then relax a few Laplacian steps inside the cap.
 *   Curve: centripetal Catmull-Rom through the filleted polyline (lines and arcs sampled <= 1.5 m), each edge then
 *     resampled at equal arc steps of at most `step` (3 m; about 2.4x the server's point count).
 *   Deviation cap: no point is farther than CAP x half-width (arterial 2.7 m, local 1.8 m) from the original
 *     polyline; a point over it is pulled back onto the cap. Lot clearance: lots are inset only half the width +
 *     25 cm from the original centreline, so a point whose road edges (half the width either side) would reach
 *     into a lot or a site is pulled back toward the original polyline until they are as clear as the original's
 *     (at most half the width): neither the paving nor roadUnder ever reaches a lot.
 *   Heights: y is the original polyline's y at the point's nearest point on it (the server's grade).
 *   opts: {cap: CAP, step: 3, lock: LOCK}. Idempotent: a second call starts again from e.pts0.
 *   Marks W.smoothed = {v: VERSION, tight: {nodeId: radius m}} (tight: the degree-2 nodes whose fillet a lot held
 *   tighter, below).
 *   Lots and fillets: a fillet whose arc would bring the road's edges nearer a lot or a site than the original's
 *   are (at most half the width) is drawn tighter, its tangent length cut 30% a time (ROOM_TRIES), or the corner
 *   kept sharp; what remains (Catmull-Rom's swing) is pulled back point by point, as below.
 *
 * junctionCorners(W, nodeId) -> [{a, b, r, c: [x, z], pts: [[x, z], ...]}]   (metres; for rendering only)
 *   At a 3+ way junction, a kerb fillet between each pair of neighbouring arms (a: the edge id on one side, b: the
 *   next arm counter-clockwise): an arc of radius r (by the smaller class: ring/highway 14 m, arterial/avenue 9 m,
 *   local/street 6 m; less where the arms are short) tangent to both arms' carriage edges, from arm a's kerb to
 *   arm b's, with its centre c. No corner where neighbouring arms are nearly opposite (a straight kerb) or overlap.
 *
 * Pure: no THREE, no DOM; node, a worker and the page all load it (tests/test_roadsmooth.py).
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : self;
var HQV = root.HQV = root.HQV || {};

var VERSION = 2;           // 2: the road's edges kept clear of lots and sites
var CAP = 0.45;            // max deviation from the original polyline, as a fraction of the half-width
var CAP_USE = 0.95;        // fillets aim inside the cap, so cm rounding never crosses it
var STEP = 3;              // m between output samples (at most)
var LOCK = 30;             // m kept straight at each end of a bridge
var FILLET = 0.45;         // an arc's tangent length is at most this share of either arm
var MIN_TURN = 0.2*Math.PI/180;   // corners below this are left as they are (straight resamples)
var ARC_CHORD = 1.5, LINE_STEP = 2, DENSE = 0.5;
var STAIRS = {highway: 20, ring: 20};   // these classes relax inside the cap's tube for this many steps
var RELAX_STEP = 2;
var CORNER_R = {ring: 14, highway: 14, arterial: 9, avenue: 9, local: 6, street: 6};

function clamp(v, a, b){ return v < a ? a : (v > b ? b : v); }

/* ---------- graph ---------- */
// incident edge indices per node id (an edge with a === b appears twice)
function incidence(W){
  var inc = {};
  (W.edges || []).forEach(function(e, i){
    (inc[e.a] = inc[e.a] || []).push(i);
    (inc[e.b] = inc[e.b] || []).push(i);
  });
  return inc;
}
function chainable(W, inc, id){
  var L = inc[id];
  if(!L || L.length !== 2 || L[0] === L[1]) return false;
  var e = W.edges[L[0]], f = W.edges[L[1]];
  return !e.bridge && !f.bridge && e.cls === f.cls && e.width === f.width;
}
function hasBridge(W, inc, id){
  var L = inc[id] || [];
  for(var i = 0; i < L.length; i++) if(W.edges[L[i]].bridge) return true;
  return false;
}
// walk from node `start` along edge i through chainable nodes: [{i, fwd}]
function walk(W, inc, seen, start, i){
  var out = [], node = start;
  for(;;){
    var e = W.edges[i], fwd = e.a === node;
    seen[i] = 1;
    out.push({i: i, fwd: fwd});
    node = fwd ? e.b : e.a;
    if(!chainable(W, inc, node)) break;
    var L = inc[node], j = L[0] === i ? L[1] : L[0];
    if(seen[j]) break;                  // a closed loop: stop where it began
    i = j;
  }
  return {items: out, a: start, b: node};
}
function chains(W, inc){
  var seen = {}, out = [], E = W.edges;
  E.forEach(function(e, i){
    if(e.bridge || seen[i]) return;
    if(!chainable(W, inc, e.a)) out.push(walk(W, inc, seen, e.a, i));
    else if(!chainable(W, inc, e.b)) out.push(walk(W, inc, seen, e.b, i));
  });
  E.forEach(function(e, i){ if(!e.bridge && !seen[i]) out.push(walk(W, inc, seen, e.a, i)); });   // loops
  return out;
}

/* ---------- geometry helpers (metres) ---------- */
function ptsOf(src, fwd){
  var n = src.length/3, out = [];
  for(var k = 0; k < n; k++){
    var j = fwd ? k : n - 1 - k;
    out.push([src[3*j]/100, src[3*j+1]/100, src[3*j+2]/100]);
  }
  return out;
}
function turnAt(p, q, r){
  var ax = q[0] - p[0], az = q[2] - p[2], bx = r[0] - q[0], bz = r[2] - q[2];
  var la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
  if(la < 1e-6 || lb < 1e-6) return 0;
  return Math.acos(clamp((ax*bx + az*bz)/(la*lb), -1, 1));
}
// centripetal Catmull-Rom between p1 and p2 ([x, z]), u in [0, 1]
function knot(t, a, b){ var d = Math.hypot(b[0] - a[0], b[1] - a[1]); return t + Math.max(1e-4, Math.sqrt(d)); }
function crAt(p0, p1, p2, p3, u){
  var t0 = 0, t1 = knot(t0, p0, p1), t2 = knot(t1, p1, p2), t3 = knot(t2, p2, p3);
  var t = t1 + (t2 - t1)*u, o = [0, 0];
  for(var k = 0; k < 2; k++){
    var A1 = ((t1 - t)*p0[k] + (t - t0)*p1[k])/(t1 - t0);
    var A2 = ((t2 - t)*p1[k] + (t - t1)*p2[k])/(t2 - t1);
    var A3 = ((t3 - t)*p2[k] + (t - t2)*p3[k])/(t3 - t2);
    var B1 = ((t2 - t)*A1 + (t - t0)*A2)/(t2 - t0);
    var B2 = ((t3 - t)*A2 + (t - t1)*A3)/(t3 - t1);
    o[k] = ((t2 - t)*B1 + (t - t1)*B2)/(t2 - t1);
  }
  return o;
}

/* ---------- one chain ---------- */
// V: the chain's original vertices [x, y, z] (m); caps: the deviation cap; lockA/lockB: a bridge at that end.
// -> the dense curve [[x, z]] with its cumulative arc length
// Highways and the ring are A* staircases (+-45 deg every 8-11 m), too tight for fillets alone: their filleted curve,
// resampled at RELAX_STEP m, takes `iters` Jacobi Laplacian steps, each point then held within 90% of the cap of the
// original polyline V (the rest is Catmull-Rom's room). The ends (and `lock` m at a bridge end) stay put. A few
// steps damp the 8-11 m wiggles; many would pull the curve taut onto the tube and kink it at the contacts.
function relax(D, V, cap, fixA, fixB, iters, lock){
  var C = {pts: D, s: [0]}, i;
  for(i = 1; i < D.length; i++) C.s.push(C.s[i-1] + Math.hypot(D[i][0] - D[i-1][0], D[i][1] - D[i-1][1]));
  var total = C.s[C.s.length-1], m = Math.max(2, Math.ceil(total/RELAX_STEP)), P = [], h = 0, hint = [], g = 0;
  for(i = 0; i <= m; i++){ var q = along(C, total*i/m, h); h = q.i; P.push([q.x, q.z]); }
  function near(x, z, k){   // nearest point on V around segment hint k: [px, pz, d, seg]
    var best = Infinity, o = null, a = Math.max(0, k - 3), b = Math.min(V.length - 2, k + 3);
    for(var j = a; j <= b; j++){
      var A = V[j], B = V[j+1], dx = B[0] - A[0], dz = B[2] - A[2], l2 = dx*dx + dz*dz;
      var f = l2 > 0 ? clamp(((x - A[0])*dx + (z - A[2])*dz)/l2, 0, 1) : 0;
      var px = A[0] + dx*f, pz = A[2] + dz*f, d = Math.hypot(x - px, z - pz);
      if(d < best){ best = d; o = [px, pz, d, j]; }
    }
    return o;
  }
  // hints: walk the original segments forward with the curve
  for(i = 0; i <= m; i++){
    var bd = Infinity, bj = g;
    for(var j = g; j < V.length - 1 && j < g + 12; j++){ var r = near(P[i][0], P[i][1], j); if(r[2] < bd - 1e-9){ bd = r[2]; bj = r[3]; } }
    g = bj; hint.push(bj);
  }
  var lo = fixA ? Math.ceil(lock/RELAX_STEP) : 1, hi = fixB ? m - Math.ceil(lock/RELAX_STEP) : m - 1, tube = cap*0.9;
  for(var it = 0; it < iters; it++){
    var Q = P.map(function(p){ return p.slice(); });
    for(i = Math.max(1, lo); i <= hi; i++){
      var x = 0.5*P[i][0] + 0.25*(P[i-1][0] + P[i+1][0]), z = 0.5*P[i][1] + 0.25*(P[i-1][1] + P[i+1][1]);
      var n = near(x, z, hint[i]);
      hint[i] = n[3];
      if(n[2] > tube){ x = n[0] + (x - n[0])*tube/n[2]; z = n[1] + (z - n[1])*tube/n[2]; }
      Q[i] = [x, z];
    }
    P = Q;
  }
  return P;
}
// room(x, z, px, pz): is (x, z) (a curve point near the original's point (px, pz)) clear enough of the lots? A
// fillet that is not is drawn tighter (its tangent length cut by 30% a time, up to ROOM_TRIES times, then the
// corner is left sharp); its vertex index goes in `tight` with the radius it got (0: sharp).
var ROOM_TRIES = 8;
function curve(V, cap, stairs, lockA, lockB, lock, room, tight){
  var n = V.length, s = [0], i;
  for(i = 1; i < n; i++) s.push(s[i-1] + Math.hypot(V[i][0] - V[i-1][0], V[i][2] - V[i-1][2]));
  var total = s[n-1];
  // key vertices: the ends and every real corner
  var K = [0];
  for(i = 1; i < n - 1; i++) if(turnAt(V[K[K.length-1]], V[i], V[i+1]) > MIN_TURN) K.push(i);
  K.push(n - 1);
  var ctrl = [[V[0][0], V[0][2]]], capUse = cap*CAP_USE;
  function line(to){
    var a = ctrl[ctrl.length-1], d = Math.hypot(to[0] - a[0], to[1] - a[1]), m = Math.ceil(d/LINE_STEP);
    for(var j = 1; j <= m; j++) ctrl.push(j === m ? to : [a[0] + (to[0] - a[0])*j/m, a[1] + (to[1] - a[1])*j/m]);
  }
  for(var k = 1; k < K.length - 1; k++){
    var P = V[K[k-1]], Q = V[K[k]], R = V[K[k+1]];
    var th = Math.min(turnAt(P, Q, R), 179*Math.PI/180);
    var lin = Math.hypot(Q[0] - P[0], Q[2] - P[2]), lout = Math.hypot(R[0] - Q[0], R[2] - Q[2]);
    var half = th/2, tn = Math.tan(half);
    var t = Math.min(FILLET*lin, FILLET*lout, capUse*tn/Math.max(1e-9, 1 - Math.cos(half)));
    var sq = s[K[k]];
    if(lockA) t = Math.min(t, Math.max(0, sq - lock));
    if(lockB) t = Math.min(t, Math.max(0, total - sq - lock));
    if(!(t > 0.05) || !(tn > 1e-6)){ line([Q[0], Q[2]]); continue; }
    var ui = [(Q[0] - P[0])/lin, (Q[2] - P[2])/lin], uo = [(R[0] - Q[0])/lout, (R[2] - Q[2])/lout];
    var sg = ui[0]*uo[1] - ui[1]*uo[0] > 0 ? 1 : -1, arc = null, t0 = t;
    for(var tr = 0; tr <= ROOM_TRIES && t > 0.05; tr++, t *= 0.7){
      var T1 = [Q[0] - ui[0]*t, Q[2] - ui[1]*t], rad = t/tn;
      var C = [T1[0] + sg*rad*(-ui[1]), T1[1] + sg*rad*ui[0]], vx = T1[0] - C[0], vz = T1[1] - C[1];
      var m = Math.max(2, Math.ceil(rad*th/ARC_CHORD)), pts = [], ok = true;
      for(var j = 1; j <= m; j++){
        var al = sg*th*j/m, ca = Math.cos(al), sa = Math.sin(al), ax = C[0] + vx*ca - vz*sa, az = C[1] + vx*sa + vz*ca;
        // (its nearest original point: on the arm in or the arm out, whichever is nearer)
        if(room && ok){
          var fi = clamp((ax - P[0])*ui[0] + (az - P[2])*ui[1], 0, lin), fo = clamp((ax - Q[0])*uo[0] + (az - Q[2])*uo[1], 0, lout);
          var ix = P[0] + ui[0]*fi, iz = P[2] + ui[1]*fi, ox = Q[0] + uo[0]*fo, oz = Q[2] + uo[1]*fo;
          var near = Math.hypot(ax - ix, az - iz) <= Math.hypot(ax - ox, az - oz);
          ok = room(ax, az, near ? ix : ox, near ? iz : oz);
        }
        pts.push([ax, az]);
      }
      if(ok){ arc = {T1: T1, pts: pts, rad: rad}; break; }
    }
    if(tight && (!arc || t < t0 - 1e-9)) tight.push([K[k], arc ? arc.rad : 0]);
    if(!arc){ line([Q[0], Q[2]]); continue; }
    line(arc.T1);
    arc.pts.forEach(function(p){ ctrl.push(p); });
  }
  line([V[n-1][0], V[n-1][2]]);
  if(stairs && ctrl.length > 2) ctrl = relax(ctrl, V, cap, lockA, lockB, stairs, lock);
  // centripetal Catmull-Rom through the control points, sampled every DENSE m
  var c = ctrl, N = c.length, D = [c[0]];
  if(N === 1) return {pts: D, s: [0]};
  for(i = 0; i < N - 1; i++){
    var p0 = i > 0 ? c[i-1] : [2*c[0][0] - c[1][0], 2*c[0][1] - c[1][1]];
    var p3 = i + 2 < N ? c[i+2] : [2*c[N-1][0] - c[N-2][0], 2*c[N-1][1] - c[N-2][1]];
    var d = Math.hypot(c[i+1][0] - c[i][0], c[i+1][1] - c[i][1]);
    if(d < 1e-6) continue;
    var mm = Math.max(1, Math.ceil(d/DENSE));
    for(j = 1; j < mm; j++) D.push(crAt(p0, c[i], c[i+1], p3, j/mm));
    D.push(c[i+1]);
  }
  var ds = [0];
  for(i = 1; i < D.length; i++) ds.push(ds[i-1] + Math.hypot(D[i][0] - D[i-1][0], D[i][1] - D[i-1][1]));
  return {pts: D, s: ds};
}
// the point at arc length a on the dense curve (hint: a starting index)
function along(C, a, h){
  var s = C.s, P = C.pts, i = clamp(h|0, 0, s.length - 2);
  while(i > 0 && s[i] > a) i--;
  while(i < s.length - 2 && s[i+1] < a) i++;
  var l = s[i+1] - s[i], f = l > 0 ? clamp((a - s[i])/l, 0, 1) : 0;
  return {x: P[i][0] + (P[i+1][0] - P[i][0])*f, z: P[i][1] + (P[i+1][1] - P[i][1])*f, i: i};
}
// nearest point on the dense curve to (x, z), searching forward from arc length a0: arc length and distance
function nearestOn(C, x, z, a0){
  var s = C.s, P = C.pts, best = Infinity, ba = a0, i = 0;
  while(i < s.length - 2 && s[i+1] < a0) i++;
  for(; i < s.length - 1; i++){
    if(best < Infinity && s[i] > ba + 60) break;
    var ax = P[i][0], az = P[i][1], dx = P[i+1][0] - ax, dz = P[i+1][1] - az, l2 = dx*dx + dz*dz;
    var f = l2 > 0 ? clamp(((x - ax)*dx + (z - az)*dz)/l2, 0, 1) : 0;
    var d = Math.hypot(x - ax - dx*f, z - az - dz*f);
    if(d < best){ best = d; ba = s[i] + (s[i+1] - s[i])*f; }
  }
  return {a: ba, d: best};
}
// nearest point on the original polyline V: [x, y, z] (y graded along its segment) and the distance
function onPoly(V, x, z){
  var best = Infinity, o = null;
  for(var i = 0; i < V.length - 1; i++){
    var A = V[i], B = V[i+1], dx = B[0] - A[0], dz = B[2] - A[2], l2 = dx*dx + dz*dz;
    var f = l2 > 0 ? clamp(((x - A[0])*dx + (z - A[2])*dz)/l2, 0, 1) : 0;
    var px = A[0] + dx*f, pz = A[2] + dz*f, d = Math.hypot(x - px, z - pz);
    if(d < best){ best = d; o = [px, A[1] + (B[1] - A[1])*f, pz]; }
  }
  return {p: o, d: best};
}

/* ---------- lot clearance ---------- */
// The lots and sites as rings (m) in a grid of AREA_CELL m cells, each listed in every cell within `reach` m of it:
// {cells: {"i,j": [ring, ...]}} (a lot's poly, else its rect)
var AREA_CELL = 32;
function areaIndex(W, reach){
  var cells = {};
  (W.lots || []).concat(W.sites || []).forEach(function(o){
    if(!o) return;
    var ring;
    if(o.poly && o.poly.length >= 3) ring = o.poly.map(function(p){ return [p[0]/100, p[1]/100]; });
    else if(o.w > 0 && o.d > 0){
      var x0 = (o.x - o.w/2)/100, x1 = (o.x + o.w/2)/100, z0 = (o.z - o.d/2)/100, z1 = (o.z + o.d/2)/100;
      ring = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
    }
    if(!ring) return;
    var bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
    ring.forEach(function(p){ bx0 = Math.min(bx0, p[0]); bx1 = Math.max(bx1, p[0]); bz0 = Math.min(bz0, p[1]); bz1 = Math.max(bz1, p[1]); });
    for(var i = Math.floor((bx0 - reach)/AREA_CELL); i <= Math.floor((bx1 + reach)/AREA_CELL); i++)
      for(var j = Math.floor((bz0 - reach)/AREA_CELL); j <= Math.floor((bz1 + reach)/AREA_CELL); j++)
        (cells[i + "," + j] = cells[i + "," + j] || []).push(ring);
  });
  return {cells: cells};
}
// how far (x, z) is from the nearest lot or site (0 inside one), looking no further than the index's reach
function clearance(I, x, z){
  var L = I.cells[Math.floor(x/AREA_CELL) + "," + Math.floor(z/AREA_CELL)], best = Infinity;
  if(!L) return best;
  for(var q = 0; q < L.length; q++){
    var R = L[q], inside = false;
    for(var i = 0, j = R.length - 1; i < R.length; j = i++){
      var A = R[j], B = R[i];
      if((B[1] > z) !== (A[1] > z) && x < (A[0] - B[0])*(z - B[1])/(A[1] - B[1]) + B[0]) inside = !inside;
      var dx = B[0] - A[0], dz = B[1] - A[1], l2 = dx*dx + dz*dz, f = l2 > 0 ? clamp(((x - A[0])*dx + (z - A[1])*dz)/l2, 0, 1) : 0;
      best = Math.min(best, Math.hypot(x - A[0] - dx*f, z - A[1] - dz*f));
    }
    if(inside) return 0;
  }
  return best;
}

function smoothChain(W, inc, ch, o){
  var E = W.edges, V = [], breaks = [0], i, k;
  ch.items.forEach(function(it, j){
    var P = ptsOf(E[it.i].pts0, it.fwd);
    for(k = j === 0 ? 0 : 1; k < P.length; k++){
      var last = V[V.length-1];
      if(last && k > 0 && Math.abs(last[0] - P[k][0]) < 1e-9 && Math.abs(last[2] - P[k][2]) < 1e-9) continue;
      V.push(P[k]);
    }
    breaks.push(V.length - 1);
  });
  var e0 = E[ch.items[0].i], cap = o.cap*Math.max(0, e0.width)/200, hw = Math.max(0, e0.width)/200;
  if(V.length < 2 || !(cap > 0)) return;
  // a curve point's road edges must be as clear of the lots and sites as the original's (at most half the width)
  function room(x, z, px, pz){ return !o.areas || clearance(o.areas, x, z) >= Math.min(hw, clearance(o.areas, px, pz)) - 0.01; }
  var tight = [], C = curve(V, cap, STAIRS[e0.cls] || 0, hasBridge(W, inc, ch.a), hasBridge(W, inc, ch.b), o.lock, room, tight);
  // the interior nodes whose fillet the lots held tighter, with the radius it got (m; 0: left sharp)
  tight.forEach(function(q){ var b = breaks.indexOf(q[0]); if(b > 0 && b < breaks.length - 1) o.tight[ch.items[b].fwd ? E[ch.items[b].i].a : E[ch.items[b].i].b] = Math.round(q[1]*100)/100; });
  var total = C.s[C.s.length-1];
  // split arc lengths at the interior nodes
  var cut = [0], a0 = 0;
  for(k = 1; k < breaks.length - 1; k++){
    var nv = V[breaks[k]], hit = nearestOn(C, nv[0], nv[2], a0);
    cut.push(hit.a); a0 = hit.a;
  }
  cut.push(total);
  ch.items.forEach(function(it, j){
    var e = E[it.i], src = e.pts0, nsrc = src.length/3;
    var A = cut[j], B = Math.max(A, cut[j+1]), L = B - A, m = Math.max(1, Math.ceil(L/(o.step*0.98)));
    var out = [], h = 0;
    for(k = 0; k <= m; k++){
      var q = along(C, A + L*k/m, h); h = q.i;
      var hit = onPoly(V, q.x, q.z), x = q.x, z = q.z;
      if(hit.d > cap){ x = hit.p[0] + (x - hit.p[0])*cap/hit.d; z = hit.p[2] + (z - hit.p[2])*cap/hit.d; }
      // the paved road's edges (half the width each side) as clear of every lot and site as the original's
      // were: pulled back toward the original polyline (by bisection) until they are
      if(o.areas && hit.d > 1e-6){
        var want = Math.min(hw, clearance(o.areas, hit.p[0], hit.p[2])) - 0.01;
        if(clearance(o.areas, x, z) < want){
          var lo = 0, hi = 1, px = hit.p[0], pz = hit.p[2], qx = x - px, qz = z - pz;
          for(var bi = 0; bi < 14; bi++){ var mid = (lo + hi)/2; if(clearance(o.areas, px + qx*mid, pz + qz*mid) >= want) lo = mid; else hi = mid; }
          x = px + qx*lo; z = pz + qz*lo;
        }
      }
      out.push([Math.round(x*100), Math.round(hit.p[1]*100), Math.round(z*100)]);
    }
    if(!it.fwd) out.reverse();
    // chain ends keep their node's exact original point
    function pin(idx, si){ out[idx] = [src[3*si], src[3*si+1], src[3*si+2]]; }
    var first = j === 0, lastIt = j === ch.items.length - 1;
    if(first) pin(it.fwd ? 0 : out.length - 1, it.fwd ? 0 : nsrc - 1);
    if(lastIt) pin(it.fwd ? out.length - 1 : 0, it.fwd ? nsrc - 1 : 0);
    var pts = new Int32Array(3*out.length);
    out.forEach(function(p, n){ pts[3*n] = p[0]; pts[3*n+1] = p[1]; pts[3*n+2] = p[2]; });
    e.pts = pts;
  });
}

/* ---------- public ---------- */
function smooth(W, opts){
  if(!W || !W.edges) return W;
  opts = opts || {};
  var o = {cap: opts.cap != null ? +opts.cap : CAP, step: opts.step > 0 ? +opts.step : STEP,
           lock: opts.lock != null ? Math.max(0, +opts.lock) : LOCK};
  W.edges.forEach(function(e){
    if(!e.pts0) e.pts0 = e.pts;
    e.pts = e.pts0;                    // a second call starts again from the server's points
  });
  var inc = incidence(W), reach = 0;
  W.edges.forEach(function(e){ reach = Math.max(reach, Math.max(0, e.width)/200); });
  o.areas = areaIndex(W, reach + 1); o.tight = {};
  chains(W, inc).forEach(function(ch){ smoothChain(W, inc, ch, o); });
  W.smoothed = {v: VERSION, tight: o.tight};
  if(W.index) W.index = null;         // world.js rebuilds its buckets from the new points
  if(W.docView) W.docView = null;
  return W;
}

// the arm's direction away from node id (m), along its straight first stretch: {x, z, dx, dz, len, run}
// (run: how far the edge stays on that line, within 2 cm; len: the edge's length)
function armDir(e, atA){
  var p = e.pts, n = p.length/3, step = atA ? 1 : -1, s = atA ? 0 : n - 1, j, len = 0;
  var x0 = p[3*s]/100, z0 = p[3*s+2]/100;
  for(j = 1; j < n; j++) len += Math.hypot((p[3*j] - p[3*j-3])/100, (p[3*j+2] - p[3*j-1])/100);
  var far = -1;
  for(j = s + step; j >= 0 && j < n; j += step){
    var dx = p[3*j]/100 - x0, dz = p[3*j+2]/100 - z0, l = Math.hypot(dx, dz);
    if(l < 1e-6) continue;
    if(far < 0){ far = j; continue; }
    // does every point up to j stay within 2 cm of the line node -> j?
    var ok = true;
    for(var k = s + step; k !== j; k += step){
      var qx = p[3*k]/100 - x0, qz = p[3*k+2]/100 - z0;
      if(Math.abs(qx*dz - qz*dx)/l > 0.02){ ok = false; break; }
    }
    if(!ok) break;
    far = j;
  }
  if(far < 0) return null;
  var fx = p[3*far]/100 - x0, fz = p[3*far+2]/100 - z0, fl = Math.hypot(fx, fz);
  return {x: x0, z: z0, dx: fx/fl, dz: fz/fl, len: len, run: fl};
}
function junctionCorners(W, nodeId){
  if(!W || !W.edges) return [];
  var inc = W._rsInc;
  if(!inc){
    inc = incidence(W);
    try { Object.defineProperty(W, "_rsInc", {value: inc, enumerable: false, configurable: true, writable: true}); } catch(err){}
  }
  var L = inc[nodeId] || [];
  if(L.length < 3) return [];
  var arms = [], seenA = {};
  L.forEach(function(i){
    var e = W.edges[i], atA = e.a === nodeId && !seenA[i];
    if(e.a === nodeId) seenA[i] = 1;
    var d = armDir(e, atA);
    if(!d) return;
    arms.push({e: e, d: d, ang: Math.atan2(d.dz, d.dx), hw: Math.max(0, (e.width - 2*(e.walk || 0))/200),
               r: CORNER_R[e.cls] || 6});
  });
  arms.sort(function(p, q){ return p.ang - q.ang || p.e.id - q.e.id; });
  var out = [];
  for(var k = 0; k < arms.length; k++){
    var A = arms[k], B = arms[(k + 1) % arms.length];
    var phi = B.ang - A.ang;
    if(k === arms.length - 1) phi += 2*Math.PI;
    if(!(phi > 5*Math.PI/180) || phi > 175*Math.PI/180) continue;
    // A's kerb on B's side (+90 deg from A) and B's kerb on A's side (-90 deg from B), as lines; K: where they meet
    var ax = A.d.x - A.d.dz*A.hw, az = A.d.z + A.d.dx*A.hw, bx = B.d.x + B.d.dz*B.hw, bz = B.d.z - B.d.dx*B.hw;
    var den = A.d.dx*B.d.dz - A.d.dz*B.d.dx;
    if(Math.abs(den) < 1e-9) continue;
    var u = ((bx - ax)*B.d.dz - (bz - az)*B.d.dx)/den, K = [ax + A.d.dx*u, az + A.d.dz*u];
    var tn = Math.tan(phi/2), r = Math.min(A.r, B.r);
    // the tangent points stay on each arm's straight stretch (and its first FILLET share)
    var kA = (K[0] - A.d.x)*A.d.dx + (K[1] - A.d.z)*A.d.dz, kB = (K[0] - B.d.x)*B.d.dx + (K[1] - B.d.z)*B.d.dz;
    r = Math.min(r, (Math.min(A.d.run, FILLET*A.d.len) - kA)*tn, (Math.min(B.d.run, FILLET*B.d.len) - kB)*tn);
    if(!(r > 0.1) || kA + r/tn < 0 || kB + r/tn < 0) continue;   // the kerbs meet behind the node: no corner
    var t = r/tn, bis = [A.d.dx + B.d.dx, A.d.dz + B.d.dz], bl = Math.hypot(bis[0], bis[1]);
    var c = [K[0] + bis[0]/bl*r/Math.sin(phi/2), K[1] + bis[1]/bl*r/Math.sin(phi/2)];
    var T1 = [K[0] + A.d.dx*t, K[1] + A.d.dz*t], T2 = [K[0] + B.d.dx*t, K[1] + B.d.dz*t];
    var a1 = Math.atan2(T1[1] - c[1], T1[0] - c[0]), a2 = Math.atan2(T2[1] - c[1], T2[0] - c[0]);
    var sw = a2 - a1;
    while(sw > Math.PI) sw -= 2*Math.PI;
    while(sw < -Math.PI) sw += 2*Math.PI;
    var m = Math.max(2, Math.ceil(Math.abs(sw)*r)), pts = [];
    for(var j = 0; j <= m; j++){
      var al = a1 + sw*j/m;
      pts.push(j === 0 ? T1 : (j === m ? T2 : [c[0] + r*Math.cos(al), c[1] + r*Math.sin(al)]));
    }
    out.push({a: A.e.id, b: B.e.id, r: r, c: c, pts: pts});
  }
  return out;
}

HQV.roadSmooth = {smooth: smooth, junctionCorners: junctionCorners, CAP: CAP, STEP: STEP, LOCK: LOCK,
                  CORNER_R: CORNER_R, VERSION: VERSION};
})();
