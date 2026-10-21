/* Claude HQ: the airport's ground vehicles (HQV.hqAirground). The poses are pure; create() needs THREE.
 *
 *   poses(L, stands, moving, nowMs, ahead, o?) -> [{type, x, y, z, yaw, lift?, beacon, stand?, phase}]
 *     L        the airfield layout (games/hqairfield.js, tests/fixtures/airfield_commons.json)
 *     stands   traffic().stands: {id: {state, airline, reg, kind, tIn, tOut, pushT, end?}} (tIn on-block ms,
 *              tOut push start ms; `end` (0|1|"36"|"18", optional) is the arrival's flow, used by the follow-me
 *              car's drive home after on-block)
 *     moving   traffic().moving: [{id, cls, kind, pose, R, t}] (R.standA / R.standB, R.tPush1, R.tTD, R.endB)
 *     ahead    ahead(movingEntry, d) -> {x, z, yaw} | null, the point d m further along its route (injected:
 *              integration passes hqAir.aheadOf, tests a stub)
 *     o        {cx, cz}: subtracted from moving poses and ahead() points when those are archipelago metres
 *     Every pose is a function of these inputs alone: nothing is integrated over frames.
 *     type: tug, tractor, cart, belt, dispenser, tanker, catering (lift: its box, m), followme, bus, arff.
 *     phase: park (depot, zones), drive, work, push (the tug at the nose), return (the tug's way back along the
 *     lead-in, until it is in the stand box), lead and off (the follow-me car).
 *   Rules: vehicles drive L.serviceRoad (keep right), the depot and straight approaches into only their own
 *   stand's box (8 m/s on the road, 3 m/s in a box); they stay on the platform and off runway and taxiway
 *   pavement, except the tug while pushing (nose + 4 m) and on its way back to the box, and the follow-me car
 *   (70 m ahead of an arriving jet from the end of its exit to its stand's lead-in, then home to the depot).
 *   The fuel tanker and the ARFF trucks stay parked in their zones.
 *   create(c, L) -> G  one InstancedMesh per vehicle type (merged, vertex-coloured, one material each) plus one
 *     Points cloud for the amber beacons and the follow-me sign at night: <= 12 draw calls.
 *     G.g, G.set(poses), G.setNight(n), G.setVisible(b), G.setDetail(level) (vehicles only at level 2),
 *     G.dispose(). set() does nothing while hidden. G.centre [x, z]: the apron's centre; integration calls
 *     setVisible(false) beyond G.HIDE_BEYOND (900 m) from it and runs poses()/set() at <= 30 Hz.
 *   SIZE {type: [length, width, height]} (m), the footprints the rules are checked with.
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};
var PI = Math.PI;

var SIZE = {tug: [6, 3, 1.5], tractor: [3, 1.6, 1.9], cart: [3, 1.6, 1.6], belt: [8, 2.2, 2.6], dispenser: [7, 2.5, 2.5],
            tanker: [12, 2.6, 3.2], catering: [9, 2.5, 4.3], followme: [4.5, 1.8, 1.8], bus: [14, 3, 3.2], arff: [11, 3, 3.5]};
// wheelbases (m): the two axles both follow the path
var WB = {tug: 3.6, tractor: 1.9, cart: 1.8, belt: 4.4, dispenser: 4.8, tanker: 7.2, catering: 6.6, followme: 2.9, bus: 9.6, arff: 6.4};
var TYPES = ["tug", "tractor", "cart", "belt", "dispenser", "tanker", "catering", "followme", "bus", "arff"];
var CAP = {tug: 6, tractor: 8, cart: 24, belt: 8, dispenser: 4, tanker: 1, catering: 8, followme: 4, bus: 4, arff: 2};
var V_ROAD = 8, V_BOX = 3, LANE = 1.3, LEAD = 70, NOSE = 19.05, AMPH_NOSE = 7.4, CART_GAP = 3.3, LIFT = 1.3, R_CORNER = 10;
var STRIP = 2.75;            // the depot bays and the follow-me's way home: this far outside the stand row / depot (frame u)

/* ---------- small geometry ---------- */
function fwd(y){ return [Math.sin(y), Math.cos(y)]; }
function hd(dx, dz){ return Math.atan2(dx, dz); }
function dist(a, b){ return Math.hypot(a[0] - b[0], a[1] - b[1]); }
function wrap(a){ while(a > PI) a -= 2*PI; while(a < -PI) a += 2*PI; return a; }
function lerpA(a, b, k){ return a + wrap(b - a)*k; }
function inPoly(P, x, z){
  var ins = false;
  for(var i = 0, j = P.length - 1; i < P.length; j = i++){
    var a = P[i], b = P[j];
    if((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0])*(z - a[1])/(b[1] - a[1]) + a[0]) ins = !ins;
  }
  return ins;
}
function segDist(p, a, b){
  var dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx*dx + dz*dz, k = L2 ? ((p[0] - a[0])*dx + (p[1] - a[1])*dz)/L2 : 0;
  k = Math.max(0, Math.min(1, k));
  return Math.hypot(p[0] - a[0] - k*dx, p[1] - a[1] - k*dz);
}
function polyDist(P, p){ var d = Infinity; for(var i = 0; i + 1 < P.length; i++) d = Math.min(d, segDist(p, P[i], P[i + 1])); return d; }
function hash(s){ var h = 2166136261 >>> 0; s = String(s); for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }

// round every corner of a polyline with an arc (radius <= r; a corner may take up to half of a shared
// segment, or all of the first / last one), sampled at about 1 m; ok(arc points) false: a tighter one
function fillet(W, r, ok){
  var n = W.length, out = [], i;
  if(n < 3) return W.slice();
  var seg = [];
  for(i = 0; i + 1 < n; i++) seg.push(dist(W[i], W[i + 1]));
  out.push(W[0]);
  for(i = 1; i + 1 < n; i++){
    var a = seg[i - 1], b = seg[i];
    if(a < 1e-6 || b < 1e-6){ out.push(W[i]); continue; }
    var d1 = [(W[i][0] - W[i - 1][0])/a, (W[i][1] - W[i - 1][1])/a], d2 = [(W[i + 1][0] - W[i][0])/b, (W[i + 1][1] - W[i][1])/b];
    var dot = Math.max(-1, Math.min(1, d1[0]*d2[0] + d1[1]*d2[1])), th = Math.acos(dot);
    if(th < 1e-3 || th > PI - 1e-3){ out.push(W[i]); continue; }
    var nx = d2[0] - d1[0]*dot, nz = d2[1] - d1[1]*dot, nl = Math.hypot(nx, nz); nx /= nl; nz /= nl;
    var side = d1[0]*d2[1] - d1[1]*d2[0] > 0 ? -1 : 1, arc = null;
    for(var f = 1; f > 0.2; f *= 0.75){
      var t = Math.min(r*f*Math.tan(th/2), i - 1 === 0 ? a : a/2, i + 1 === n - 1 ? b : b/2), rr = t/Math.tan(th/2);
      var T1 = [W[i][0] - d1[0]*t, W[i][1] - d1[1]*t], C = [T1[0] + nx*rr, T1[1] + nz*rr], a1 = Math.atan2(T1[0] - C[0], T1[1] - C[1]);
      var steps = Math.max(2, Math.ceil(th*rr));
      arc = [];
      for(var k = 0; k <= steps; k++){ var an = a1 + side*th*k/steps; arc.push([C[0] + Math.sin(an)*rr, C[1] + Math.cos(an)*rr]); }
      if(!ok || ok(arc)) break;
    }
    Array.prototype.push.apply(out, arc);
  }
  out.push(W[n - 1]);
  return out.filter(function(p, j){ return j === 0 || dist(p, out[j - 1]) > 1e-4; });
}

/* ---------- the layout, prepared once per L ---------- */
var PREP = typeof WeakMap === "function" ? new WeakMap() : null;
function prep(L){
  var K = PREP && PREP.get(L);
  if(K) return K;
  var F = L.frame || {o: [0, 0], B: [1, 0], T: [0, 1]};
  function toW(u, v){ return [F.o[0] + u*F.B[0] + v*F.T[0], F.o[1] + u*F.B[1] + v*F.T[1]]; }
  function toF(x, z){ var dx = x - F.o[0], dz = z - F.o[1]; return [dx*F.B[0] + dz*F.B[1], dx*F.T[0] + dz*F.T[1]]; }
  function bboxF(P){ var b = {u0: Infinity, u1: -Infinity, v0: Infinity, v1: -Infinity}; (P || []).forEach(function(p){ var q = toF(p[0], p[1]);
    b.u0 = Math.min(b.u0, q[0]); b.u1 = Math.max(b.u1, q[0]); b.v0 = Math.min(b.v0, q[1]); b.v1 = Math.max(b.v1, q[1]); }); return b; }
  var road = (L.serviceRoad || []).map(function(p){ return [p[0], p[1]]; }), rs = [0];
  for(var i = 1; i < road.length; i++) rs.push(rs[i - 1] + dist(road[i - 1], road[i]));
  var stands = {};
  (L.stands || []).forEach(function(s){ stands[String(s.id)] = s; });
  var dep = bboxF(L.service && L.service.depot), yawT = hd(F.T[0], F.T[1]), yawB = hd(F.B[0], F.B[1]);
  K = {L: L, toW: toW, toF: toF, bboxF: bboxF, road: road, rs: rs, len: rs[rs.length - 1] || 0, stands: stands,
       boxes: (L.stands || []).map(function(s){ return s.box; }), y: +L.y || 0, yawT: yawT, yawB: yawB, dep: dep, jobs: {}};
  // the road vertices near the depot (its last point) and the stand row; the strip beside the stand row and depot
  K.uStrip = dep.u1 + STRIP;
  if(PREP) PREP.set(L, K);
  return K;
}
// arc length along the road of the nearest point to p
function roadS(K, p){
  var best = Infinity, s = 0, R = K.road;
  for(var i = 0; i + 1 < R.length; i++){
    var a = R[i], b = R[i + 1], dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx*dx + dz*dz, k = L2 ? ((p[0] - a[0])*dx + (p[1] - a[1])*dz)/L2 : 0;
    k = Math.max(0, Math.min(1, k));
    var d = Math.hypot(p[0] - a[0] - k*dx, p[1] - a[1] - k*dz);
    if(d < best - 1e-9){ best = d; s = K.rs[i] + k*Math.sqrt(L2); }
  }
  return s;
}
function roadAt(K, s){
  var R = K.road, i = 0;
  s = Math.max(0, Math.min(K.len, s));
  while(i + 2 < R.length && K.rs[i + 1] < s) i++;
  var a = R[i], b = R[i + 1], l = K.rs[i + 1] - K.rs[i], k = l ? (s - K.rs[i])/l : 0;
  return [a[0] + (b[0] - a[0])*k, a[1] + (b[1] - a[1])*k];
}
// the road from s0 to s1 in the lane on the right of the way of travel (mitred offset), corners left sharp
function lane(K, s0, s1){
  var pts = [roadAt(K, s0)], up = s1 >= s0, i;
  if(up){ for(i = 0; i < K.road.length; i++) if(K.rs[i] > s0 + 1e-6 && K.rs[i] < s1 - 1e-6) pts.push(K.road[i]); }
  else { for(i = K.road.length - 1; i >= 0; i--) if(K.rs[i] < s0 - 1e-6 && K.rs[i] > s1 + 1e-6) pts.push(K.road[i]); }
  pts.push(roadAt(K, s1));
  pts = pts.filter(function(p, j){ return j === 0 || dist(p, pts[j - 1]) > 1e-6; });
  if(pts.length < 2) return pts;
  function rn(a, b){ var l = dist(a, b) || 1; return [-(b[1] - a[1])/l, (b[0] - a[0])/l]; }   // the right normal
  return pts.map(function(p, j){
    var n0 = j > 0 ? rn(pts[j - 1], p) : null, n1 = j + 1 < pts.length ? rn(p, pts[j + 1]) : null, n;
    if(n0 && n1){ var m = [n0[0] + n1[0], n0[1] + n1[1]], ml = Math.hypot(m[0], m[1]) || 1, c = Math.max(0.3, (m[0]*n0[0] + m[1]*n0[1])/ml); n = [m[0]/ml/c, m[1]/ml/c]; }
    else n = n0 || n1;
    return [p[0] + n[0]*LANE, p[1] + n[1]*LANE];
  });
}

/* ---------- paths: legs of filleted polylines, timed by where they run ---------- */
function inBoxes(K, p){ for(var i = 0; i < K.boxes.length; i++) if(K.boxes[i] && inPoly(K.boxes[i], p[0], p[1])) return true; return false; }
// keep corners this far (m) from any stand box but the vehicle's own
var BOX_CLEAR = 2.8;
function clearOf(K, own){
  return function(arc){
    for(var i = 0; i < K.L.stands.length; i++){
      var st = K.L.stands[i], B = st.box;
      if(!B || String(st.id) === own) continue;
      for(var j = 0; j < arc.length; j++) if(inPoly(B, arc[j][0], arc[j][1]) || polyDist(B.concat([B[0]]), arc[j]) < BOX_CLEAR) return false;
    }
    return true;
  };
}
function leg(K, W, rev, r, own){
  var pts = fillet(W, r == null ? R_CORNER : r, clearOf(K, own == null ? null : String(own))), s = [0], t = [0];
  for(var i = 1; i < pts.length; i++){
    var d = dist(pts[i - 1], pts[i]), mid = [(pts[i - 1][0] + pts[i][0])/2, (pts[i - 1][1] + pts[i][1])/2];
    s.push(s[i - 1] + d); t.push(t[i - 1] + d/(inBoxes(K, mid) ? V_BOX : V_ROAD));
  }
  return {p: pts, s: s, t: t, len: s[s.length - 1], T: t[t.length - 1], rev: !!rev};
}
function path(legs, o){
  o = o || {};
  var P = {legs: legs.filter(function(l){ return l.p.length > 1; }), T: 0, len: 0, yaw0: o.yaw0, yaw1: o.yaw1};
  P.legs.forEach(function(l){ P.T += l.T; P.len += l.len; });
  return P;
}
// the point at distance s along a leg (past either end: straight on along its end heading)
function ptOn(l, s){
  var p = l.p, n = p.length, f;
  if(s <= 0){ f = fwd(hd(p[1][0] - p[0][0], p[1][1] - p[0][1])); return [p[0][0] + f[0]*s, p[0][1] + f[1]*s]; }
  if(s >= l.len){ f = fwd(hd(p[n - 1][0] - p[n - 2][0], p[n - 1][1] - p[n - 2][1])); return [p[n - 1][0] + f[0]*(s - l.len), p[n - 1][1] + f[1]*(s - l.len)]; }
  var lo = 0, hi = n - 1, S = l.s;
  while(hi - lo > 1){ var m = (lo + hi) >> 1; if(S[m] <= s) lo = m; else hi = m; }
  var k = S[lo + 1] > S[lo] ? (s - S[lo])/(S[lo + 1] - S[lo]) : 0;
  return [p[lo][0] + (p[lo + 1][0] - p[lo][0])*k, p[lo][1] + (p[lo + 1][1] - p[lo][1])*k];
}
// the pose at distance S along the whole path: a two-axle vehicle, wheelbase wb, both axles on the leg (so a
// long one cuts the inside of a corner instead of swinging its ends out); before the start, back along it
function atS(P, S, wb){
  var acc = 0, i, l = null, sl = 0;
  for(i = 0; i < P.legs.length; i++){ l = P.legs[i]; if(S <= acc + l.len || i === P.legs.length - 1){ sl = S - acc; break; } acc += l.len; }
  if(!l) return null;
  var h = Math.max(0.05, (wb || 0)/2), a = ptOn(l, Math.min(sl, l.len) + h), b = ptOn(l, Math.min(sl, l.len) - h);
  var out = {x: (a[0] + b[0])/2, z: (a[1] + b[1])/2, yaw: wrap(hd(a[0] - b[0], a[1] - b[1]) + (l.rev ? PI : 0)), S: S};
  if(P.yaw0 != null && S < 4) out.yaw = wrap(lerpA(P.yaw0, out.yaw, Math.max(0, S)/4));
  if(P.yaw1 != null && S > P.len - 4) out.yaw = wrap(lerpA(out.yaw, P.yaw1, Math.min(1, (S - (P.len - 4))/4)));
  return out;
}
// the distance along the path reached after tau s
function sAt(P, tau){
  var acc = 0, accS = 0;
  for(var i = 0; i < P.legs.length; i++){
    var l = P.legs[i];
    if(tau <= acc + l.T || i === P.legs.length - 1){
      var tl = Math.max(0, Math.min(l.T, tau - acc)), t = l.t, lo = 0, hi = t.length - 1;
      while(hi - lo > 1){ var m = (lo + hi) >> 1; if(t[m] <= tl) lo = m; else hi = m; }
      var k = t[lo + 1] > t[lo] ? (tl - t[lo])/(t[lo + 1] - t[lo]) : 0;
      return accS + l.s[lo] + (l.s[lo + 1] - l.s[lo])*k;
    }
    acc += l.T; accS += l.len;
  }
  return 0;
}

/* ---------- stand-local frame: a along the stand's heading (to the nose), l to its left ---------- */
function loc(st, a, l){ var y = st.yaw, f = fwd(y); return [st.x + a*f[0] + l*f[1], st.z + a*f[1] - l*f[0]]; }
function isCommuter(st){ return st && st.kind === "commuter"; }
// the jobs at a stand: spot {a, l, yaw (relative to the stand)}, the box waypoints in (from the lane) and out
// (legs: [{w: [[a, l]...], rev}]), all in the stand's frame; right side = negative l (the jet bridge is on the left)
var JET_JOBS = {
  belt: {spot: [-7, -6.2, PI/2], inw: [[20, -16.5], [-7, -16.5], [-7, -6.2]], out: [{w: [[-7, -6.2], [-7, -16.5], [-11, -16.5]], rev: true}, {w: [[-11, -16.5], [20, -16.5]]}]},
  catering: {spot: [-12.5, -6.8, PI/2], inw: [[20, -16.5], [-12.5, -16.5], [-12.5, -6.8]], out: [{w: [[-12.5, -6.8], [-12.5, -16.5], [-16.5, -16.5]], rev: true}, {w: [[-16.5, -16.5], [20, -16.5]]}]},
  dispenser: {spot: [4.5, -9.5, 0], inw: [[20, -16.5], [-4, -16.5], [-4, -9.5], [4.5, -9.5]], out: [{w: [[4.5, -9.5], [20, -9.5]]}]},
  tractor: {spot: [-15, -20.5, PI], inw: [[20, -20.5], [-15, -20.5]], out: [{w: [[-15, -20.5], [-19, -20.5], [-19, -12.6], [20, -12.6]]}]},
  tug: {spot: [NOSE + 4, 0, PI], inw: [[NOSE + 4, 0]], out: []}
};
// commuter stands are served from the road behind their tails: `join` is the stand-frame point whose road
// projection the vehicle turns off at
var COMMUTER_JOBS = {
  bus: {spot: [-1, 8, 0], join: [-14.5, 8], inw: [[-1, 8]], out: [{w: [[-1, 8], [-15.2, 8], [-15.2, 13]], rev: true}, {w: [[-15.2, 13]]}]},
  tug: {spot: [AMPH_NOSE + 4, 0, PI], join: [-14.5, -9], inw: [[AMPH_NOSE + 4, -9], [AMPH_NOSE + 4, 0]], out: [], yaw1: true}
};
function depotS(K){ return K.len; }
function toWorld(st, W){ return W.map(function(al){ return loc(st, al[0], al[1]); }); }
// the bus stop at the concourse's south end, facing the way it leaves (along the road's south crossing)
function busStop(K){
  var C = K.bboxF(K.L.concourse), u = C.u1 + 16, v = C.v0 + 4.5;
  return {p: K.toW(u, v), yaw: wrap(K.yawB), u: u, v: v, C: C};
}
// a job's paths: in (depot or stop -> spot) and out (spot -> depot or stop), cached per stand and type
function jobPaths(K, st, type){
  var key = st.id + "|" + type;
  if(K.jobs[key]) return K.jobs[key];
  var J = (isCommuter(st) ? COMMUTER_JOBS : JET_JOBS)[type];
  if(!J) return null;
  var spot = loc(st, J.spot[0], J.spot[1]), syaw = wrap(st.yaw + J.spot[2]), inW = toWorld(st, J.inw), D = depotS(K), res;
  var sIn = roadS(K, J.join ? loc(st, J.join[0], J.join[1]) : inW[0]);
  var outs = J.out.map(function(o){ return {w: toWorld(st, o.w), rev: o.rev}; });
  var lw = outs.length ? outs[outs.length - 1].w : null, sX = lw ? roadS(K, lw[lw.length - 1]) : 0;
  if(type === "bus"){
    // from the stop: out along the south crossing's lane and down the road behind the commuter tails; home: up
    // that road, east past the stop, round the concourse's corner and into the stop facing out again
    var B = busStop(K), f = fwd(B.yaw), sStop = roadS(K, [B.p[0] + f[0]*12, B.p[1] + f[1]*12]);
    var inLeg = leg(K, [B.p, [B.p[0] + f[0]*6, B.p[1] + f[1]*6]].concat(lane(K, sStop, sIn), inW), false, null, st.id);
    var back = lane(K, sX, roadS(K, K.toW(B.C.u1 + 5, B.v))), e = back[back.length - 1], eF = K.toF(e[0], e[1]);
    outs[outs.length - 1].w = lw.concat(back, [K.toW(B.C.u1 + 2.5, eF[1]), K.toW(B.C.u1 + 2.5, B.v), B.p]);
    res = {inP: path([inLeg]), outP: path(outs.map(function(o){ return leg(K, o.w, o.rev, o.rev ? 5 : R_CORNER, st.id); }), {yaw1: B.yaw}), spot: spot, yaw: syaw};
    K.jobs[key] = res;
    return res;
  }
  var inLeg2 = leg(K, lane(K, D, sIn).concat(inW), false, null, st.id);
  if(outs.length) outs[outs.length - 1].w = lw.concat(lane(K, sX, D));
  res = {inP: path([inLeg2], {yaw1: J.yaw1 ? syaw : null}), outP: path(outs.map(function(o){ return leg(K, o.w, o.rev, o.rev ? 4 : R_CORNER, st.id); })), spot: spot, yaw: syaw};
  K.jobs[key] = res;
  return res;
}
// the tug's way home after a push: from the nose of the pushed aircraft back along the stand's lead-in into the
// box (phase "return"), through the empty box to the road, then the road to the depot
function tugHome(K, st, curveId, nose){
  var key = "home|" + st.id + "|" + curveId;
  if(K.jobs[key]) return K.jobs[key];
  var C = K.L.curves && K.L.curves[curveId];
  if(!C || C.length < 3) return null;
  var y0 = hd(C[1][0] - C[0][0], C[1][1] - C[0][1]), f0 = fwd(y0), Kp = [C[0][0] + f0[0]*(nose + 4), C[0][1] + f0[1]*(nose + 4)];
  var j = 0, best = Infinity;
  C.forEach(function(p, i){ var d = dist(p, Kp); if(d < best){ best = d; j = i; } });
  var W = [Kp].concat(C.slice(Math.min(C.length - 1, j + 3)));
  if(isCommuter(st)) W = W.concat(toWorld(st, [[6, 0], [6, 9], [-9, 9]]));
  else W = W.concat(toWorld(st, [[20, 0]]));
  var sX = roadS(K, W[W.length - 1]);
  W = W.concat(lane(K, sX, depotS(K)));
  var P = path([leg(K, W, false, null, st.id)], {yaw0: wrap(y0 + PI)});
  // where it is back in the box: the end of the "return" phase
  var acc = 0, sBox = P.len, l0 = P.legs[0];
  for(var i = 1; i < l0.p.length; i++){ acc = l0.s[i]; if(inPoly(st.box, l0.p[i][0], l0.p[i][1])){ sBox = acc; break; } }
  K.jobs[key] = {P: P, sBox: sBox, start: Kp};
  return K.jobs[key];
}

/* ---------- the follow-me car ---------- */
// the flow ("36" | "18") of a movement: its R's end at this airfield (endB for an arrival, endA for a
// departure: an index into L.runway.ends, a designator, or an end object), else inferred from its pose
function flowOf(m, st, K, dep){
  var e = m && m.R ? (dep ? (m.R.endA != null ? m.R.endA : m.R.flowA) : (m.R.endB != null ? m.R.endB : m.R.flowB)) : null;
  if(e && typeof e === "object") e = e.id;
  if(typeof e === "number" || /^[0-9]$/.test(String(e))){ var E = K.L.runway && K.L.runway.ends && K.L.runway.ends[+e]; if(E) e = String(E.id); }
  if(e === 0 || e === "0" || e === "36") return "36";
  if(e === 1 || e === "1" || e === "18") return "18";
  // inferred from where the arrival is: the flows are one-way (spec 3.5)
  if(!m || !m.pose) return null;
  var p = m.pose, f = fwd(p.yaw || 0), Bl = K.L.lines && K.L.lines.B, Al = K.L.lines && K.L.lines.A;
  if(!Bl || !Al) return null;
  var dB = segDist([p.x, p.z], Bl[0], Bl[1]), dA = segDist([p.x, p.z], Al[0], Al[1]), dir = [Bl[1][0] - Bl[0][0], Bl[1][1] - Bl[0][1]];
  var along = f[0]*dir[0] + f[1]*dir[1];         // > 0: heading toward B's second end (+z on the Commons, the 36 way)
  if(dA < 6 && dA < dB) return along > 0 ? "36" : "18";
  if(dB < 6) return along > 0 ? "18" : "36";
  return null;
}
// the follow-me's way home: on from Q along B, aside into the strip beside the stands, along it to the road's
// end ahead, the road to the depot
function followHome(K, Q, dirB){
  var key = "fm|" + Q[0] + "," + Q[1] + "|" + dirB[0].toFixed(3) + "," + dirB[1].toFixed(3);
  if(K.jobs[key]) return K.jobs[key];
  var qF = K.toF(Q[0], Q[1]), dF = K.toF(Q[0] + dirB[0], Q[1] + dirB[1]), dv = dF[1] - qF[1] >= 0 ? 1 : -1;
  var R = K.road, ends = [K.toF(R[1][0], R[1][1]), K.toF(R[R.length - 2][0], R[R.length - 2][1])];
  var end = dv < 0 ? (ends[0][1] < ends[1][1] ? ends[0] : ends[1]) : (ends[0][1] > ends[1][1] ? ends[0] : ends[1]);
  var uS = K.uStrip, W = [Q, K.toW(qF[0], qF[1] + dv*10), K.toW(uS, qF[1] + dv*22), K.toW(uS, end[1] - dv*(LANE + 3))];
  var sE = roadS(K, K.toW(end[0], end[1]));
  // into the road's lane toward the depot, a little way in from its corner
  var tail = lane(K, Math.min(K.len, sE + 5), depotS(K));
  W = W.concat(tail);
  var P = path([leg(K, W)]);
  K.jobs[key] = {P: P};
  return K.jobs[key];
}

/* ---------- poses ---------- */
var BAYS = ["tug", "tug", "belt", "belt", "catering", "dispenser", "tractor", "followme", "followme"];
function beaconOn(nowMs, id){ return ((nowMs + (hash(id) % 997)) % 800) < 140; }
function poses(L, stands, moving, nowMs, ahead, o){
  var out = [];
  if(!L || !L.ok || !L.stands) return out;
  o = o || {}; stands = stands || {}; moving = moving || []; nowMs = +nowMs || 0;
  var K = prep(L), Y = K.y, cx = +o.cx || 0, cz = +o.cz || 0, active = {};
  function add(type, p, extra){
    var q = {type: type, x: p.x, y: Y, z: p.z, yaw: wrap(p.yaw), beacon: false, phase: "drive"};
    Object.keys(extra || {}).forEach(function(k){ q[k] = extra[k]; });
    out.push(q); active[type] = (active[type] || 0) + 1;
    return q;
  }
  function mpose(m){ var p = m && m.pose; return p ? {x: p.x - cx, z: p.z - cz, yaw: p.yaw || 0, phase: p.phase, rev: p.rev} : null; }
  function aheadOf(m, d){ var a = null; try { a = ahead ? ahead(m, d) : null; } catch(e){ a = null; } return a ? {x: a.x - cx, z: a.z - cz, yaw: a.yaw} : null; }
  function bid(id, type){ return id + "|" + type; }
  // a job: drive in, work at the spot from tA to tL, drive out (ms); the train's carts trail its tractor
  function job(st, type, tA, tL, extra){
    if(!(tL > tA + 5000)) return;
    var J = jobPaths(K, st, type); if(!J) return;
    var t0 = tA - J.inP.T*1000, t1 = tL + J.outP.T*1000, b = beaconOn(nowMs, bid(st.id, type)), S, P, ph;
    if(nowMs < t0 || nowMs >= t1) return;
    var combo = null;
    if(nowMs < tA){ S = sAt(J.inP, (nowMs - t0)/1000); P = J.inP; ph = "drive"; }
    else if(nowMs < tL){ S = J.inP.len; P = J.inP; ph = "work"; }
    else { S = sAt(J.outP, (nowMs - tL)/1000); P = J.outP; ph = "drive"; combo = true; }
    var p = ph === "work" ? {x: J.spot[0], z: J.spot[1], yaw: J.yaw} : atS(P, S, WB[type]);
    var jid = st.id + "|" + type + "|" + tA, ex = {id: jid, stand: String(st.id), phase: ph, beacon: b};
    Object.keys(extra || {}).forEach(function(k){ ex[k] = extra[k]; });
    if(type === "catering"){
      var k = ph === "work" ? Math.max(0, Math.min(1, (nowMs - tA)/12000, (tL - nowMs)/12000)) : 0;
      ex.lift = LIFT*k*k*(3 - 2*k);
    }
    add(type, p, ex);
    if(type === "tractor") for(var i = 1; i <= 3; i++){
      // the carts on the tractor's track: behind it on the way in and at work, on the way out over the join
      var d = S - CART_GAP*i, cp;
      if(!combo){ if(d < 0) continue; cp = atS(J.inP, d, WB.cart); }      // still in the shed
      else cp = d >= 0 ? atS(J.outP, d, WB.cart) : atS(J.inP, J.inP.len + d, WB.cart);
      add("cart", cp, {id: jid + "|c" + i, stand: String(st.id), phase: ph});
    }
  }
  var ids = Object.keys(stands).filter(function(id){ return K.stands[String(id)]; }).sort(function(a, b){ return (+a - +b) || (a < b ? -1 : a > b ? 1 : 0); });
  var deps = {}, arrs = [];
  moving.forEach(function(m){
    if(!m || !m.R) return;
    if(m.R.standA != null && K.stands[String(m.R.standA)]) deps[String(m.R.standA)] = m;
    if(m.R.standB != null && K.stands[String(m.R.standB)]) arrs.push(m);
  });
  ids.forEach(function(id){
    var S = stands[id] || {}, st = K.stands[String(id)], tIn = S.tIn != null ? +S.tIn : null;
    var tOut = S.tOut != null ? +S.tOut : (tIn != null ? tIn + 16*60000 : null);
    if(tIn == null || !isFinite(tIn)) return;
    if(isCommuter(st)){
      job(st, "bus", tIn + 15000, tIn + 90000);
      job(st, "bus", tOut - 200000, tOut - 120000);
    } else {
      job(st, "belt", tIn + 20000, tOut - 200000);
      job(st, "tractor", tIn + 40000, tOut - 240000);
      job(st, "dispenser", tIn + 60000, Math.min(tIn + 360000, tOut - 150000));
      job(st, "catering", tIn + 90000, tOut - 300000);
    }
    // the tug: at the nose from tOut - 120 s, then on the pushed aircraft, then home
    if(tOut == null || !isFinite(tOut)) return;
    var J = jobPaths(K, st, "tug"), b = beaconOn(nowMs, bid(id, "tug")), tid = id + "|tug|" + tOut, nose = isCommuter(st) ? AMPH_NOSE : NOSE;
    if(!J) return;
    var tA = tOut - 120000, t0 = tA - J.inP.T*1000;
    if(nowMs >= t0 && nowMs < tA){ add("tug", atS(J.inP, sAt(J.inP, (nowMs - t0)/1000), WB.tug), {id: tid, stand: String(id), beacon: b}); return; }
    if(nowMs >= tA && nowMs < tOut){ add("tug", {x: J.spot[0], z: J.spot[1], yaw: J.yaw}, {id: tid, stand: String(id), phase: "work", beacon: b}); return; }
    if(nowMs < tOut) return;
    var m = deps[String(id)], mp = mpose(m);
    if(m && mp && (mp.phase === "pushback" || mp.rev)){
      var f = fwd(mp.yaw);
      add("tug", {x: mp.x + f[0]*(nose + 4), z: mp.z + f[1]*(nose + 4), yaw: mp.yaw + PI}, {id: tid, stand: String(id), phase: "push", beacon: b});
      return;
    }
    if(m && m.R && m.R.tPush1 != null && m.t != null && m.t >= m.R.tPush1){
      var fl = flowOf(m, st, K, true);
      var cid = st.lead && fl ? st.lead[fl] : null, H = cid ? tugHome(K, st, cid, nose) : null;
      if(!H){
        // no flow known: the nearer lead-in start to where the push ended
        var c36 = st.lead && st.lead["36"], c18 = st.lead && st.lead["18"], C36 = c36 && L.curves[c36], C18 = c18 && L.curves[c18];
        if(C36 && C18 && mp) cid = dist([mp.x, mp.z], C36[0]) <= dist([mp.x, mp.z], C18[0]) ? c36 : c18;
        H = cid ? tugHome(K, st, cid, nose) : null;
      }
      if(H){
        var tt = m.t - m.R.tPush1, sh = sAt(H.P, tt);
        if(sh < H.P.len) add("tug", atS(H.P, sh, WB.tug), {id: tid, stand: String(id), phase: sh < H.sBox ? "return" : "drive", beacon: b});
      }
      return;
    }
    if(!m && S.state === "pushback") add("tug", {x: J.spot[0], z: J.spot[1], yaw: J.yaw}, {id: tid, stand: String(id), phase: "work", beacon: b});
  });

  // the follow-me car: one per arriving jet, from the end of its exit to its lead-in, then home
  var fmDone = {};
  arrs.forEach(function(m){
    if(!(m.cls === "jet" || m.kind === "jet")) return;
    var st = K.stands[String(m.R.standB)], mp = mpose(m);
    if(!st || isCommuter(st) || !mp) return;
    var landed = m.R.tTD == null || (m.t != null && m.t >= m.R.tTD);
    if(!landed || mp.phase === "parked") return;
    var fl = flowOf(m, st, K), cid = fl && st.lead ? st.lead[fl] : null, C = cid && L.curves ? L.curves[cid] : null;
    if(!C) return;
    var r = fmState(K, st, C, mp), SB = stands[String(m.R.standB)];
    var fid = "fm|" + (SB && SB.tIn != null ? m.R.standB + "|" + SB.tIn : m.id), b = beaconOn(nowMs, fid);
    if(r.lead){
      if(mp.phase !== "taxi") return;           // not before the end of the exit
      var a = aheadOf(m, LEAD);
      if(a) add("followme", {x: a.x, z: a.z, yaw: a.yaw != null ? a.yaw : mp.yaw}, {id: fid, phase: "lead", beacon: b, of: String(m.id)});
      fmDone[String(m.R.standB)] = 1;
      return;
    }
    var H = followHome(K, C[0], r.dirB);
    if(r.s < H.P.len) add("followme", atS(H.P, r.s, WB.followme), {id: fid, phase: "off", beacon: b, of: String(m.id)});
    fmDone[String(m.R.standB)] = 1;
  });
  // after on-block: home at road speed (needs the arrival's flow, stands[id].end)
  ids.forEach(function(id){
    var S = stands[id] || {}, st = K.stands[String(id)];
    if(fmDone[String(id)] || isCommuter(st) || S.tIn == null || nowMs < +S.tIn || S.end == null) return;
    var fl = flowOf({R: {endB: S.end}}, st, K), C = fl && st.lead && L.curves ? L.curves[st.lead[fl]] : null;
    if(!C) return;
    var dirB = unit([C[1][0] - C[0][0], C[1][1] - C[0][1]]), H = followHome(K, C[0], dirB);
    var sQ = LEAD + dist(C[0], C[C.length - 1]) + V_ROAD*(nowMs - +S.tIn)/1000;
    if(sQ < H.P.len) add("followme", atS(H.P, sQ, WB.followme), {id: "fm|" + id + "|" + S.tIn, phase: "off", beacon: beaconOn(nowMs, "fm|" + id + "|" + S.tIn)});
  });

  // the buses waiting at the stop, the parked tanker and fire trucks, the depot's idle vehicles
  var busy = {};
  Object.keys(active).forEach(function(k){ busy[k] = active[k]; });
  if(!busy.bus){ var B = busStop(K); add("bus", {x: B.p[0], z: B.p[1], yaw: B.yaw}, {id: "bus|stop", phase: "park"}); }
  var fuel = K.bboxF(L.service && L.service.fuel), fire = K.bboxF(L.service && L.service.fire);
  if(isFinite(fuel.u1)){ var tp = K.toW(fuel.u1 - 3, fuel.v1 - 8); add("tanker", {x: tp[0], z: tp[1], yaw: K.yawT}, {id: "tanker", phase: "park"}); }
  if(isFinite(fire.u1)){ var vm = (fire.v0 + fire.v1)/2; [-7, 7].forEach(function(dv){ var ap = K.toW(fire.u1 - 6, vm + dv); add("arff", {x: ap[0], z: ap[1], yaw: K.yawB}, {id: "arff|" + dv, phase: "park"}); }); }
  // the depot's bays (in a row beside it, facing -T): as many of each type as are not out at work
  if(isFinite(K.dep.u1)){
    var used = {}, v = K.dep.v0 + 1.5, yawBay = wrap(K.yawT + PI), fb = fwd(yawBay);
    BAYS.forEach(function(type, bi){
      var Ln = type === "tractor" ? 3 + 3*CART_GAP : SIZE[type][0], v0 = v, n = used[type] = (used[type] || 0) + 1;
      var bays = BAYS.filter(function(t){ return t === type; }).length;
      v += Ln + 1.5;
      if(n > bays - (busy[type] || 0)) return;
      var bp = K.toW(K.uStrip, v0 + (type === "tractor" ? 1.5 : Ln/2));
      add(type, {x: bp[0], z: bp[1], yaw: yawBay}, {id: "bay|" + bi, phase: "park"});
      // a train: the tractor leads, its carts behind it
      if(type === "tractor") for(var i = 1; i <= 3; i++) add("cart", {x: bp[0] - fb[0]*CART_GAP*i, z: bp[1] - fb[1]*CART_GAP*i, yaw: yawBay}, {id: "bay|" + bi + "|c" + i, phase: "park"});
    });
  }
  return out;
}
function unit(v){ var l = Math.hypot(v[0], v[1]) || 1; return [v[0]/l, v[1]/l]; }
// where an arrival is relative to its lead-in: still leading (r.lead), or the car's distance along its way home
function fmState(K, st, C, p){
  var Q = C[0], S = C[C.length - 1], dirB = unit([C[1][0] - Q[0], C[1][1] - Q[1]]), P = [p.x, p.z];
  var aB = (Q[0] - P[0])*dirB[0] + (Q[1] - P[1])*dirB[1], Bl = K.L.lines && K.L.lines.B;
  var onB = Bl ? segDist(P, Bl[0], Bl[1]) < 3 : false, inLead = polyDist(C, P) < 3 && aB <= 1;
  if(inLead) return {lead: false, s: LEAD + dist(Q, S) - dist(P, S), dirB: dirB};
  if(onB && aB >= 0 && aB <= LEAD) return {lead: false, s: LEAD - aB, dirB: dirB};
  return {lead: true, dirB: dirB};
}

/* ---------- the models: merged boxes and cylinders with vertex colours, one per type ---------- */
function Model(THREE){
  var parts = [], m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
  function put(geo, col, x, y, z, rx, ry, rz){ e.set(rx || 0, ry || 0, rz || 0); q.setFromEuler(e); p.set(x, y, z); parts.push([geo, m4.clone().compose(p, q, s), col]); }
  var M = {
    box: function(w, h, d, x, y, z, col, rx, ry){ put(new THREE.BoxGeometry(w, h, d), col, x, y, z, rx, ry); },
    cylX: function(r, w, x, y, z, col){ put(new THREE.CylinderGeometry(r, r, w, 10), col, x, y, z, 0, 0, PI/2); },
    cylZ: function(r, len, x, y, z, col){ put(new THREE.CylinderGeometry(r, r, len, 14), col, x, y, z, PI/2); },
    cylY: function(r, h, x, y, z, col){ put(new THREE.CylinderGeometry(r, r, h, 10), col, x, y, z); },
    wheels: function(xs, zs, r, w){ xs.forEach(function(x){ zs.forEach(function(z){ M.cylX(r, w, x, r, z, 0x1d1f22); }); }); },
    build: function(){
      var pos = [], nor = [], col = [], c = new THREE.Color();
      parts.forEach(function(pt){
        var g = pt[0].index ? pt[0].toNonIndexed() : pt[0];
        g.applyMatrix4(pt[1]);
        var a = g.attributes.position.array, n = g.attributes.normal.array;
        c.setHex(pt[2]);
        for(var i = 0; i < a.length; i += 3){ pos.push(a[i], a[i + 1], a[i + 2]); nor.push(n[i], n[i + 1], n[i + 2]); col.push(c.r, c.g, c.b); }
        if(g !== pt[0]) g.dispose();
        pt[0].dispose();
      });
      var out = new THREE.BufferGeometry();
      out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      out.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
      out.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
      out.computeBoundingSphere();
      return out;
    }
  };
  return M;
}
var YEL = 0xf2c230, BLK = 0x1d1f22, WHT = 0xf2f3f1, GLS = 0x26313d, RED = 0xc8302a, ORG = 0xe8742a, BLU = 0x2a5db0, GRY = 0x6b7077;
// each model: local +z forward, origin on the ground at its middle; beacon: the roof light [x, y, z] (null: none)
var MODELS = {
  tug: function(M){ M.box(3, 0.9, 6, 0, 0.75, 0, YEL); M.box(3.05, 0.35, 0.3, 0, 0.5, 3.0, BLK); M.box(3.05, 0.35, 0.3, 0, 0.5, -3.0, BLK);
    M.box(1.1, 0.55, 1.2, -0.85, 1.48, -1.7, GLS); M.box(1.2, 0.08, 1.3, -0.85, 1.78, -1.7, YEL); M.box(0.25, 0.1, 0.8, 0, 0.9, 3.3, BLK);
    M.wheels([-1.3, 1.3], [-1.9, 1.9], 0.48, 0.38); return [-0.85, 1.95, -1.7]; },
  tractor: function(M){ M.box(1.5, 0.55, 3, 0, 0.62, 0, WHT); M.box(1.4, 0.45, 1.1, 0, 1.1, 0.85, ORG); M.box(0.6, 0.5, 0.5, 0, 1.15, -0.4, BLK);
    M.box(1.55, 0.08, 1.5, 0, 1.86, -0.45, ORG); [-0.7, 0.7].forEach(function(x){ [-1.15, 0.25].forEach(function(z){ M.box(0.07, 1.0, 0.07, x, 1.35, z, BLK); }); });
    M.wheels([-0.68, 0.68], [-1.0, 1.0], 0.36, 0.3); return [0, 1.95, -0.45]; },
  cart: function(M){ M.box(1.5, 0.25, 2.7, 0, 0.45, 0, GRY); M.box(1.48, 0.95, 2.6, 0, 1.05, 0, BLU); M.box(1.5, 0.08, 2.7, 0, 1.55, 0, 0x234f96);
    M.box(0.1, 0.1, 0.5, 0, 0.45, 1.55, BLK); M.wheels([-0.6, 0.6], [-0.9, 0.9], 0.25, 0.2); return null; },
  belt: function(M){ M.box(2.0, 0.5, 6.4, 0, 0.6, -0.4, WHT); M.box(0.9, 1.0, 1.3, -0.5, 1.3, -2.8, WHT); M.box(0.92, 0.5, 1.0, -0.5, 1.55, -2.8, GLS);
    var a = Math.atan2(1.7, 8.0); M.box(1.0, 0.16, 8.15, 0.35, 1.75, 0.15, BLK, -a); M.box(0.08, 0.3, 8.15, -0.2, 1.85, 0.15, WHT, -a); M.box(0.08, 0.3, 8.15, 0.9, 1.85, 0.15, WHT, -a);
    M.wheels([-0.85, 0.85], [-2.6, 1.8], 0.38, 0.3); return [-0.5, 1.9, -2.8]; },
  dispenser: function(M){ M.box(2.4, 0.45, 7, 0, 0.62, 0, GRY); M.box(2.4, 1.55, 1.7, 0, 1.55, 2.6, WHT); M.box(2.42, 0.6, 0.1, 0, 1.85, 3.45, GLS);
    M.box(2.4, 1.15, 4.8, 0, 1.45, -0.95, WHT); M.box(2.42, 0.25, 4.82, 0, 1.25, -0.95, RED); M.box(2.2, 0.08, 4.4, 0, 2.08, -0.95, GRY);
    [-1.05, 1.05].forEach(function(x){ M.box(0.06, 0.45, 4.4, x, 2.3, -0.95, YEL); });
    M.wheels([-1.05, 1.05], [-2.4, 2.4], 0.45, 0.35); return [0, 2.4, 2.4]; },
  tanker: function(M){ M.box(2.5, 0.5, 12, 0, 0.7, 0, GRY); M.box(2.5, 2.1, 2.3, 0, 1.75, 4.75, WHT); M.box(2.52, 0.75, 0.1, 0, 2.2, 5.92, GLS);
    M.cylZ(1.25, 8.6, 0, 2.0, -1.3, WHT); M.cylZ(1.27, 0.7, 0, 2.0, -1.3, RED); M.cylZ(1.27, 0.35, 0, 2.0, 2.6, RED); M.cylZ(1.27, 0.35, 0, 2.0, -5.2, RED);
    M.wheels([-1.1, 1.1], [-4.6, -3.2, 4.4], 0.5, 0.4); return [0, 2.9, 4.75]; },
  catering: function(M){ M.box(2.4, 0.55, 9, 0, 0.62, 0, GRY); M.box(2.4, 0.75, 1.7, 0, 1.25, 3.6, WHT); M.box(2.42, 0.4, 0.1, 0, 1.3, 4.46, GLS);
    M.box(1.8, 0.35, 5.6, 0, 1.07, -1.2, BLK); M.wheels([-1.05, 1.05], [-3.2, 3.4], 0.45, 0.35); return [0, 1.75, 3.6]; },
  cateringBox: function(M){ M.box(2.5, 2.5, 7.0, 0, 1.75 + 1.25, -0.5, WHT); M.box(2.52, 0.3, 7.02, 0, 2.2, -0.5, 0x2a5db0);
    M.box(2.3, 0.1, 1.3, 0, 1.8, 3.65, GRY); M.box(1.6, 2.2, 4.0, 0, 1.7 - 1.1, -0.8, BLK); return null; },
  followme: function(M){ M.box(1.8, 0.7, 4.5, 0, 0.62, 0, YEL); M.box(1.7, 0.55, 2.3, 0, 1.22, -0.3, YEL); M.box(1.72, 0.4, 2.0, 0, 1.25, -0.3, GLS);
    M.box(1.3, 0.4, 0.24, 0, 1.72, -0.2, BLK);
    for(var i = 0; i < 4; i++) for(var j = 0; j < 2; j++){ if((i + j) % 2) M.box(0.3, 0.19, 0.26, -0.45 + i*0.3, 1.62 + j*0.2, -0.2, YEL); }
    M.wheels([-0.82, 0.82], [-1.45, 1.45], 0.33, 0.25); return [0, 2.0, -0.2]; },
  bus: function(M){ M.box(3, 2.55, 14, 0, 1.6, 0, WHT); M.box(3.02, 0.5, 14.02, 0, 0.85, 0, BLU); M.box(3.04, 0.95, 12.6, 0, 2.15, -0.3, GLS);
    M.box(3.04, 1.4, 0.1, 0, 2.0, 7.0, GLS); M.box(2.9, 0.12, 13.6, 0, 2.95, 0, BLU); M.wheels([-1.3, 1.3], [-4.8, 4.8], 0.5, 0.4); return [0, 3.1, 6.2]; },
  arff: function(M){ M.box(3, 2.4, 11, 0, 1.65, 0, 0xc8e000); M.box(3.02, 0.85, 1.7, 0, 2.3, 4.6, GLS); M.box(3.02, 0.3, 11.02, 0, 0.95, 0, RED);
    M.cylY(0.35, 0.4, 0, 3.05, 3.6, GRY); M.box(0.18, 0.18, 1.7, 0, 3.3, 4.3, GRY); M.box(2.4, 0.15, 0.4, 0, 2.95, 5.0, RED);
    M.wheels([-1.3, 1.3], [-3.8, -2.4, 3.6], 0.6, 0.45); return [0, 3.1, 5.0]; }
};

function create(c, L){
  var THREE = c.THREE, g = new THREE.Group(); g.name = "airground";
  var mats = [], geos = [], IM = {}, roof = {}, m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pv = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
  TYPES.concat(["cateringBox"]).forEach(function(type){
    var M = Model(THREE); roof[type] = MODELS[type](M);
    var geo = M.build(), mat = c.mat(0xffffff, {vertexColors: true, roughness: 0.62, metalness: 0.12});
    var cap = type === "cateringBox" ? CAP.catering : CAP[type];
    var im = new THREE.InstancedMesh(geo, mat, cap);
    im.name = "airground-" + type; im.count = 0; im.visible = false; im.frustumCulled = false; im.castShadow = false; im.receiveShadow = true;
    g.add(im); IM[type] = {m: im, cap: cap}; mats.push(mat); geos.push(geo);
  });
  var NB = 0; TYPES.forEach(function(t){ NB += CAP[t]; }); NB += CAP.followme;
  var bg = new THREE.BufferGeometry(), bpos = new Float32Array(NB*3), bcol = new Float32Array(NB*3);
  bg.setAttribute("position", new THREE.BufferAttribute(bpos, 3)); bg.setAttribute("color", new THREE.BufferAttribute(bcol, 3)); bg.setDrawRange(0, 0);
  var bm = new THREE.PointsMaterial({size: 5, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false, toneMapped: false});
  var bp = new THREE.Points(bg, bm); bp.name = "airground-beacons"; bp.frustumCulled = false; g.add(bp);
  var night = false, vis = true, detail = 2;
  function shown(){ g.visible = vis && detail >= 2; }
  // the apron's centre: integration hides the vehicles when the camera is more than 900 m from it
  var ab = {x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity};
  ((L && L.apron) || []).forEach(function(P){ P.forEach(function(p){ ab.x0 = Math.min(ab.x0, p[0]); ab.x1 = Math.max(ab.x1, p[0]); ab.z0 = Math.min(ab.z0, p[1]); ab.z1 = Math.max(ab.z1, p[1]); }); });
  var G = {g: g, L: L, centre: isFinite(ab.x0) ? [(ab.x0 + ab.x1)/2, (ab.z0 + ab.z1)/2] : [0, 0], HIDE_BEYOND: 900};
  G.set = function(list){
    if(!g.visible) return G;
    var cnt = {}, nb = 0;
    function beacon(p, off, rgb){
      if(nb >= NB || !off) return;
      var s = Math.sin(p.yaw), co = Math.cos(p.yaw);
      bpos[3*nb] = p.x + off[0]*co + off[2]*s; bpos[3*nb + 1] = p.y + off[1] + (p.lift || 0)*0; bpos[3*nb + 2] = p.z - off[0]*s + off[2]*co;
      bcol[3*nb] = rgb[0]; bcol[3*nb + 1] = rgb[1]; bcol[3*nb + 2] = rgb[2]; nb++;
    }
    function put(type, p, dy){
      var I = IM[type]; if(!I) return false;
      var i = cnt[type] || 0; if(i >= I.cap) return false;
      pv.set(p.x, (p.y || 0) + (dy || 0), p.z); q.setFromAxisAngle(up, p.yaw || 0); m4.compose(pv, q, one);
      I.m.setMatrixAt(i, m4); cnt[type] = i + 1;
      return true;
    }
    (list || []).forEach(function(p){
      if(!p || !IM[p.type] || !isFinite(p.x) || !isFinite(p.z)) return;
      if(!put(p.type, p)) return;
      if(p.type === "catering") put("cateringBox", p, p.lift || 0);
      if(p.beacon) beacon(p, roof[p.type], [1, 0.62, 0.1]);
      if(night && p.type === "followme") beacon(p, [0, 1.75, 0.2], [1, 0.9, 0.45]);
    });
    Object.keys(IM).forEach(function(t){ var I = IM[t], n = cnt[t] || 0; I.m.count = n; I.m.visible = n > 0; if(n) I.m.instanceMatrix.needsUpdate = true; });
    bg.setDrawRange(0, nb); bg.attributes.position.needsUpdate = true; bg.attributes.color.needsUpdate = true; bp.visible = nb > 0;
    return G;
  };
  G.setNight = function(n){ night = !!n; bm.size = night ? 6 : 4; return G; };
  G.setVisible = function(b){ vis = !!b; shown(); return G; };
  G.setDetail = function(level){ detail = level | 0; shown(); return G; };
  G.dispose = function(){
    Object.keys(IM).forEach(function(t){ IM[t].m.dispose(); });
    geos.forEach(function(x){ x.dispose(); }); mats.forEach(function(m){ m.dispose(); }); bg.dispose(); bm.dispose();
    if(g.parent) g.parent.remove(g);
  };
  G.setNight(false);
  return G;
}

HQV.hqAirground = {poses: poses, create: create, SIZE: SIZE, TYPES: TYPES, CAP: CAP, LEAD: LEAD};
})();
