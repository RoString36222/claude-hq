/* Claude HQ: the autopilot (HQV.hqAutopilot): I in anything you drive, ride, sail or fly.
 *
 * It only works the controls: what comes out is the same W / S / A / D (or stick and collective) a player gives, so the
 * vehicle's own physics, gearbox, sound and drive mode do the rest. With a route on (N: Go to) it takes you there and
 * stops; with none, a car keeps to the road it is on (straight on at junctions), a boat or a helicopter holds its
 * heading (and a helicopter its height). Any steering or throttle of yours takes over (games/hq3d.js).
 *
 * Pure (node-tested, tests/test_hqautopilot.py): metres, yaw 0 faces +z, increasing yaw turns LEFT, steer + is left,
 * the right of travel is (-dz, dx) for a direction (dx, dz) (as games/hqcall.js: everyone drives on the right).
 *   plan(pts, lane)            a route's [x0, z0, ...] -> P {pts, cum, len, s}: kept lane m right of the centre line,
 *                              eased in over the first and out over the last EASE m (it starts and stops where you are
 *                              and where you are going)
 *   drive(P, pose, o)          pose {x, z, yaw, speed}; o {vmax, lat (m/s² in a corner), brake (m/s²), yawRate (rad/s at
 *                              full lock), ahead (m to the nearest obstacle in the lane), stop (stop at the end)}
 *                              -> {thr -1..1, steer -1..1, v (the speed it wants), left, along, done}. Pure pursuit on a
 *                              look-ahead point; the speed is the least of vmax, every corner ahead (braking for it in
 *                              time), the end of the route and the obstacle ahead. It never reverses.
 *   cruise(G, x, z, yaw, len)  -> [x, z, ...] about len m along the road under (x, z) the way you face, straight on at
 *                              each junction (the least turn), back the way it came at a dead end; G: HQV.hqnav.graph
 *   boat(pose, to, o)          pose {x, z, yaw, speed}; to {x, z} | null (null: hold o.hdg); o {top, land(x, z), vmax}
 *                              -> {thr, steer, v, done, blocked}: feelers pick the heading nearest the goal that is
 *                              open water for a few seconds ahead; it slows into a stop at the goal
 *   heli(st, to, o)            st: a games/hqheli.js state; to {x, z} | null; o {floor(x, z), alt (m above the highest
 *                              ground ahead), top, acc, hdg (held with no goal)} -> {fwd, turn, lift, done, phase}:
 *                              lifts off, climbs, flies there, slows to a hover over it and lands
 */
(function(){
"use strict";
var HQV = (typeof window !== "undefined" ? window : globalThis).HQV = (typeof window !== "undefined" ? window : globalThis).HQV || {};

var LANE = 1.8;            // m right of the centre line (as games/hqcall.js)
var EASE = 8;              // m over which the lane offset eases in and out
var ARRIVE = 2.5;          // m from the end: there
var MARGIN = 6;            // m: a boat keeps this far off the coast either side of its course
function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function wrap(a){ while(a > Math.PI) a -= 2*Math.PI; while(a < -Math.PI) a += 2*Math.PI; return a; }
function hyp(a, b){ return Math.sqrt(a*a + b*b); }

/* ---------- a route to follow ---------- */
function plan(pts, lane){
  lane = lane == null ? LANE : lane;
  var q = [], i, n = Math.floor((pts ? pts.length : 0)/2);
  for(i = 0; i < n; i++){
    var x = pts[2*i], z = pts[2*i + 1];
    if(q.length && hyp(x - q[q.length - 2], z - q[q.length - 1]) < 0.3) continue;
    q.push(x, z);
  }
  n = q.length/2;
  var cum = new Float64Array(Math.max(1, n));
  for(i = 1; i < n; i++) cum[i] = cum[i - 1] + hyp(q[2*i] - q[2*i - 2], q[2*i + 1] - q[2*i - 1]);
  var len = n ? cum[n - 1] : 0, out = new Float64Array(q.length);
  for(i = 0; i < n; i++){
    var ax = 0, az = 0;
    if(i > 0){ var d1 = hyp(q[2*i] - q[2*i - 2], q[2*i + 1] - q[2*i - 1]) || 1; ax += (q[2*i] - q[2*i - 2])/d1; az += (q[2*i + 1] - q[2*i - 1])/d1; }
    if(i < n - 1){ var d2 = hyp(q[2*i + 2] - q[2*i], q[2*i + 3] - q[2*i + 1]) || 1; ax += (q[2*i + 2] - q[2*i])/d2; az += (q[2*i + 3] - q[2*i + 1])/d2; }
    var an = hyp(ax, az) || 1; ax /= an; az /= an;
    var k = 1;                                                    // the bisector's offset grows at a corner (capped for hairpins)
    if(i > 0 && i < n - 1){ var d3 = hyp(q[2*i] - q[2*i - 2], q[2*i + 1] - q[2*i - 1]) || 1; k = 1/Math.max(0.5, ((q[2*i] - q[2*i - 2])/d3)*ax + ((q[2*i + 1] - q[2*i - 1])/d3)*az); }
    var o = lane*k*clamp(Math.min(cum[i], len - cum[i])/EASE, 0, 1);
    out[2*i] = q[2*i] - az*o; out[2*i + 1] = q[2*i + 1] + ax*o;
  }
  for(i = 1; i < n; i++) cum[i] = cum[i - 1] + hyp(out[2*i] - out[2*i - 2], out[2*i + 1] - out[2*i - 1]);
  return {pts: out, cum: cum, len: n ? cum[n - 1] : 0, s: 0};
}
function segAt(P, s){
  var C = P.cum, lo = 0, hi = C.length - 1;
  if(hi < 1) return 0;
  s = clamp(s, 0, P.len);
  while(hi - lo > 1){ var m = (lo + hi) >> 1; if(C[m] <= s) lo = m; else hi = m; }
  return lo;
}
function pointAt(P, s){
  var i = segAt(P, s), C = P.cum, Q = P.pts;
  if(C.length < 2) return {x: Q[0] || 0, z: Q[1] || 0};
  var L = C[i + 1] - C[i], t = L > 0 ? clamp((s - C[i])/L, 0, 1) : 0;
  return {x: Q[2*i] + (Q[2*i + 2] - Q[2*i])*t, z: Q[2*i + 1] + (Q[2*i + 3] - Q[2*i + 1])*t};
}
function headingAt(P, s){
  var a = pointAt(P, s - 2), b = pointAt(P, s + 2);
  return Math.atan2(b.x - a.x, b.z - a.z);
}
// where along P the point (x, z) is: the nearest point from a little behind the last to some way ahead of it
function locate(P, x, z){
  var C = P.cum, Q = P.pts, best = Infinity, bestS = P.s;
  for(var i = 0; i + 1 < C.length; i++){
    if(C[i + 1] < P.s - 6 || C[i] > P.s + 80) continue;
    var ax = Q[2*i], az = Q[2*i + 1], dx = Q[2*i + 2] - ax, dz = Q[2*i + 3] - az, L2 = dx*dx + dz*dz;
    var t = L2 > 0 ? clamp(((x - ax)*dx + (z - az)*dz)/L2, 0, 1) : 0, d = hyp(x - ax - dx*t, z - az - dz*t);
    if(d < best){ best = d; bestS = C[i] + t*(C[i + 1] - C[i]); }
  }
  P.s = Math.max(P.s - 6, bestS);
  return {s: P.s, off: best};
}

/* ---------- on wheels (and tracks) ---------- */
function drive(P, pose, o){
  o = o || {};
  var vmax = o.vmax || 16, lat = o.lat || 5, brake = o.brake || 4.5, yr = o.yawRate || 1.9;
  var v = Math.max(0, +pose.speed || 0), L = locate(P, pose.x, pose.z), left = Math.max(0, P.len - L.s);
  // steering: the look-ahead point, and the curvature that reaches it (pure pursuit)
  var Ld = clamp(3.5 + v*0.55, 4.5, 22), tg = pointAt(P, Math.min(P.len, L.s + Ld));
  if(L.s + Ld > P.len){ var e = pointAt(P, P.len), h = headingAt(P, P.len); tg = {x: e.x + Math.sin(h)*(L.s + Ld - P.len), z: e.z + Math.cos(h)*(L.s + Ld - P.len)}; }
  var alpha = wrap(Math.atan2(tg.x - pose.x, tg.z - pose.z) - pose.yaw);
  var kap = 2*Math.sin(alpha)/Math.max(Ld, hyp(tg.x - pose.x, tg.z - pose.z));
  var steer = clamp(kap*Math.max(v, 3)/yr*1.15, -1, 1);
  // the speed: vmax, every corner ahead (braked for in time), the end, what is in the lane
  var want = vmax, look = v*v/(2*brake) + 25;
  for(var s = L.s + 2; s < Math.min(P.len - 4, L.s + look); s += 3){
    var c = Math.abs(wrap(headingAt(P, s + 4) - headingAt(P, s - 4)))/8;
    if(c < 1e-3) continue;
    var vk = Math.min(Math.sqrt(lat/c), 0.85*yr/c);
    want = Math.min(want, Math.sqrt(vk*vk + 2*brake*Math.max(0, s - L.s - 3)));
  }
  if(o.stop !== false) want = Math.min(want, Math.sqrt(2*brake*0.7*Math.max(0, left - 1.5)));
  var ahead = o.ahead == null ? Infinity : +o.ahead;
  if(ahead < Infinity) want = Math.min(want, ahead < 4 ? 0 : Math.sqrt(2*brake*(ahead - 4)));
  if(Math.abs(alpha) > 1.2) want = Math.min(want, 4);              // facing the wrong way: round slowly
  var thr = clamp((want - v)*0.8, -1, 1);
  if(thr < 0 && v < 0.4) thr = 0;                                    // stopped: hold, never back up
  return {thr: thr, steer: steer, v: want, left: left, along: L.s, off: L.off,
          done: o.stop !== false && left < ARRIVE && v < 0.6};
}

/* ---------- following the road with no route ---------- */
function edgeHeading(G, k, i, fwd){
  var P = G.XZ[k], m = P.length/2, a = clamp(i, 0, m - 2);
  var dx = P[2*a + 2] - P[2*a], dz = P[2*a + 3] - P[2*a + 1];
  return fwd ? Math.atan2(dx, dz) : Math.atan2(-dx, -dz);
}
function cruise(G, x, z, yaw, len){
  if(!G || !G.M || !HQV.hqnav) return null;
  var sn = HQV.hqnav.snap(G, x, z); if(!sn) return null;
  var k = G.keep.indexOf(sn.ei); if(k < 0) return null;
  var C = G.CUM[k], m = C.length, i = 0;
  while(i < m - 2 && C[i + 1] < sn.s) i++;
  var fwd = Math.abs(wrap(edgeHeading(G, k, i, true) - yaw)) <= Math.PI/2;
  var out = [x, z, sn.x, sn.z], got = 0, guard = 0, lx = sn.x, lz = sn.z;
  function add(px, pz){ var d = hyp(px - lx, pz - lz); if(d < 0.3) return; got += d; out.push(px, pz); lx = px; lz = pz; }
  while(got < len && guard++ < 64){
    var P = G.XZ[k], n = P.length/2, j;
    if(fwd) for(j = i + 1; j < n; j++) add(P[2*j], P[2*j + 1]);
    else for(j = i; j >= 0; j--) add(P[2*j], P[2*j + 1]);
    var node = fwd ? G.EB[k] : G.EA[k], hin = edgeHeading(G, k, fwd ? n - 2 : 0, fwd), best = -1, bt = Infinity, bf = true;
    for(var a = G.off[node]; a < G.off[node + 1]; a++){
      var q = G.adj[a]; if(q === k && G.deg[node] > 1) continue;
      var out0 = G.EA[q] === node, hq = edgeHeading(G, q, out0 ? 0 : G.XZ[q].length/2 - 2, out0), t = Math.abs(wrap(hq - hin));
      if(t < bt){ bt = t; best = q; bf = out0; }
    }
    if(best < 0) break;
    k = best; fwd = bf; i = fwd ? 0 : G.XZ[k].length/2 - 1;
  }
  return out;
}

/* ---------- on the water ---------- */
function boat(pose, to, o){
  o = o || {};
  var top = o.top || 10, vmax = Math.min(o.vmax || top, top), v = +pose.speed || 0;
  var goal = to ? Math.atan2(to.x - pose.x, to.z - pose.z) : (o.hdg != null ? o.hdg : pose.yaw);
  var dist = to ? hyp(to.x - pose.x, to.z - pose.z) : Infinity, reach = clamp(12 + Math.max(0, v)*3, 15, 60);
  var land = typeof o.land === "function" ? o.land : null, head = goal, blocked = false;
  if(land){
    var tries = [0, 0.3, -0.3, 0.6, -0.6, 0.9, -0.9, 1.25, -1.25, 1.6, -1.6, 2.1, -2.1, 2.6, -2.6], ok = false;
    for(var t = 0; t < tries.length && !ok; t++){
      var h = goal + tries[t], clear = true, lim = Math.min(reach, dist + 4);
      for(var d = 4; d <= lim && clear; d += 4){                   // the line ahead and a beam's width either side of it
        var px = pose.x + Math.sin(h)*d, pz = pose.z + Math.cos(h)*d, sx = Math.cos(h)*MARGIN, sz = -Math.sin(h)*MARGIN;
        if(land(px, pz) || land(px + sx, pz + sz) || land(px - sx, pz - sz)) clear = false;
      }
      if(clear){ head = h; ok = true; }
    }
    blocked = !ok;
  }
  var err = wrap(head - pose.yaw), want = blocked ? 0 : vmax;
  if(to) want = Math.min(want, Math.sqrt(2*1.2*Math.max(0, dist - 6)));
  if(Math.abs(err) > 1.2) want = Math.min(want, top*0.35);
  return {thr: clamp(want/top + (want - v)*0.25, -1, 1), steer: clamp(err*1.6, -1, 1), v: want, done: !!to && dist < 10 && Math.abs(v) < 1, blocked: blocked};
}

/* ---------- in the air (helicopters) ---------- */
function heli(st, to, o){
  o = o || {};
  var floor = typeof o.floor === "function" ? o.floor : function(){ return 0; }, top = o.top || 45, acc = o.acc || 7.5, alt = o.alt || 60;
  var dx = to ? to.x - st.x : 0, dz = to ? to.z - st.z : 0, dist = to ? hyp(dx, dz) : Infinity;
  var sy = Math.sin(st.yaw), cy = Math.cos(st.yaw), vF = st.vx*sy + st.vz*cy, hs = hyp(st.vx, st.vz);
  if(st.ground) return to && dist > 25 ? {fwd: 0, turn: 0, lift: 1, done: false, phase: "takeoff"} : {fwd: 0, turn: 0, lift: 0, done: !!to, phase: "landed"};
  var goal = to ? Math.atan2(dx, dz) : (o.hdg != null ? o.hdg : st.yaw), err = wrap(goal - st.yaw);
  // the highest ground under the next stretch: the height to keep over it
  var hi = floor(st.x, st.z), span = Math.min(dist, 30 + hs*6);
  for(var d = 15; d <= span; d += 15) hi = Math.max(hi, floor(st.x + Math.sin(goal)*d, st.z + Math.cos(goal)*d));
  var land = to && dist < 18 && hs < 3, want, y;
  if(to && dist < 18){ want = 0; y = land ? -Infinity : hi + Math.min(alt, 20); }
  else {
    want = Math.min(top*0.9, to ? Math.sqrt(2*acc*0.45*Math.max(0, dist - 12)) : top*0.7);
    if(Math.abs(err) > 0.5) want = Math.min(want, 8);
    y = hi + alt;
  }
  var fwd = clamp(want/top + (want - vF)*0.12, -1, 1);
  var lift = land ? -1 : clamp((y - st.y)*0.12, -1, 1);
  if(to && dist >= 18 && st.y - hi < alt*0.5) fwd = Math.min(fwd, 0.15);   // up first, then away
  return {fwd: fwd, turn: clamp(err*2, -1, 1), lift: lift, done: false, phase: land ? "landing" : to && dist < 18 ? "hover" : "cruise"};
}

HQV.hqAutopilot = {LANE: LANE, EASE: EASE, ARRIVE: ARRIVE, plan: plan, pointAt: pointAt, headingAt: headingAt, drive: drive, cruise: cruise, boat: boat, heli: heli};
})();
