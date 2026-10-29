/* Claude HQ: the rail network between cities (HQV.hqRail). The top half is pure (no THREE, no DOM; node-tested in
 * tests/test_hqrail.py), the bottom half draws it (HQV.hqRail.view) and runs it in a City (HQV.hqRail.mount).
 *
 * A line joins two cities' stations (the "transit" site, tier 2+). It is built by a player from their island
 * (POST /api/arena/rail/build, paid from their island's treasury) and listed by GET /api/arena/rail. Every point is
 * in ARCHIPELAGO metres (a city's own frame plus its position, as games/hqvoyage.js), so one alignment serves both
 * cities: a city draws it at (p - its position).
 *   alignment(A, B)   A, B = {world, x, z (archipelago m), W (a packed world) or null, tier, lane ({off, until}: lanes())}
 *                     From A's station the line runs ELEVATED over A's streets (games/hqnav.js's shortest route,
 *                     DECK_UP over the road) to A's coast facing B, straight across the sea on a viaduct, then over
 *                     B's streets to B's station. The corners are rounded by an elastic band held within CUT m of the
 *                     street's middle (closer where it would pass over a building standing at that city's tier),
 *                     grades eased to GRADE, the platforms level.
 *                     -> R {pts Float64Array [x, y, z, ...] every STEP m, s, r (curve radius at each point), v, t,
 *                           len, T, hand (s: the mid-sea handover), seaA, seaB (s where the sea viaduct starts/ends),
 *                           s0, s1 (where the head stands at the two platforms), from, to, A, B}
 *   poseAt(R, t)      the train's head t s after leaving A: {x, y, z, yaw, pitch, speed, along, leg, u}
 *   at(R, s)          the track at s m along: {x, y, z, yaw, pitch}
 *   departures(a, b, nowMs, back, ahead)  a -> b departures (ms), the same on every client
 *   nextDeparture(a, b, nowMs)
 *   lanes(W, tier, here, others)  {world: {off, until}}: lines leaving one station along the same streets run side
 *                     by side, LANE m apart, until they part
 *   lineKey(a, b)     "a|b" with the two world ids ordered (as the Arena's rail_line)
 *   menuRows(rail, here, places, mine, myTier, nowMs)  the station menu's rail rows: ride / build / build-from / note
 * Speeds: 22 m/s over the streets, 45 m/s over the sea, sqrt(A_LAT r) (not under CURVE_MIN) on a curve, 1 m/s² either way.
 * A train is 4 cars (CAR_L m each); it stands DWELL s at each platform; departures every EVERY ms each way.
 *
 * Drawing and running (needs THREE through hq3d's ctx; see "running it in a City" below):
 *   mount(c, w, o)    the lines touching a City: viaduct, track, piers, masts, platforms, stairs, waiting people, the
 *                     timetable's trains with passengers in their windows, your ride (HQV.hqRail.ride) and its panel.
 * Seeding: no line exists until a player builds one (backend/src/rail.rs).
 *
 * HQ 3.15 (docs/plans/transport-revamp.md 3.4, 4.2, D2, D7):
 *   Live ids are @3 (HQV.world.COMMONS / islandId, else "claude-hq@3"); @2 ids are accepted wherever ids are checked
 *   (WORLD_RE), compared by place (canon) so an older Arena's @2 lines still show in an @3 world.
 *   The Island Link (pure, see "the Island Link" below): linkService(o) / link(islandWorld, o) (a Service, mode "link",
 *   Trip.world = the destination), linkRoute, linkSpawn, linkDepartures / linkNext (every 300 s each way per island),
 *   linkPlatform (Commons Central's platform). Drawn by linkView(c, sim, opts) (plan 5.4).
 *   parts: the few-draw-call kit (merged vertex-coloured statics, instanced trains, a focused train's inside) shared
 *   with games/hqcityrail.js and games/hqgondola.js.
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : self;
var HQV = root.HQV = root.HQV || {};

var STEP = 4;              // m between alignment points
var DECK_UP = 9;           // m: the rail head over the street
var SEA_UP = 13;           // m: the rail head over the sea
var GRADE = 0.035;         // the steepest grade
var CUT = 11;              // m: the smoothed line strays at most this far from the street's middle
var CITY_V = 22, SEA_V = 45, ACC = 1.0, A_LAT = 2.0, CURVE_MIN = 8;
var CAR_L = 17, CAR_GAP = 1.2, CARS = 4;
var TRAIN_L = CARS*CAR_L + (CARS - 1)*CAR_GAP;
var PLAT = 92;             // m: a platform's length along the line, from the station end
var PLAT_TOP = 0.95;         // m over the rail head: a platform's top and a car's floor
var STOP_END = 8;          // m: the head stops this short of the line's end
var EVERY = 180000;        // ms between departures, each way
var DWELL = 40;            // s a train stands at a platform before leaving and after arriving
var COST = 500;            // coins: a line, from the builder's island treasury
var NOMINAL_COAST = 880;
var COMMONS_FALLBACK = "claude-hq@3";   // the live Commons when HQV.world does not say (HQ 3.15, D2: the live worlds are @3)
var LANE = 7.7;            // m between the tracks of lines leaving one station side by side: one double viaduct, a shared
                           // island platform between them
var TAPER = 90;            // m: a lane eases back to the street's middle over this once its lines part
var PART = 3*LANE;         // m: lines this far apart have parted; their lanes hold until then (past the smoothed corner)
var SHARE_MIN = 24;        // m: lines running beside each other no further than this part at once (keep the middle)

function hyp(x, z){ return Math.sqrt(x*x + z*z); }
function wrap(a){ while(a > Math.PI) a -= 2*Math.PI; while(a < -Math.PI) a += 2*Math.PI; return a; }
function WDo(){ return HQV.world || null; }
// live ids: HQV.world's (COMMONS, islandId) when it has them; @2 and @3 ids are both accepted everywhere (older Arenas)
function commonsId(){ var W = WDo(); return (W && W.COMMONS) || COMMONS_FALLBACK; }
function isCommonsId(w){ return /^claude-hq@[0-9]+$/.test(String(w)); }
function canon(w){ return String(w).replace(/@[0-9]+$/, ""); }                       // the place, whatever the version
function verOf(w){ var m = /@([0-9]+)$/.exec(String(w)); return m ? +m[1] : 0; }
function sameWorld(a, b){ return a != null && b != null && canon(a) === canon(b); }
function asVersion(w, v){ return v ? canon(w) + "@" + v : String(w); }
function islandIdOf(uid, v){
  var W = WDo(), u = String(uid == null ? "" : uid).toLowerCase().replace(/^user:/, "").replace(/@[0-9]+$/, "");
  v = v === 2 ? 2 : 3;
  if(W && W.islandId){ var r = W.islandId(u, v); if(r) return r; }
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(u) ? "user:" + u + "@" + v : null;
}

// a city's station: its transit site (any tier: a line needs one, the Arena checks the tier)
function stationOf(W){
  var sites = (W && (W.sites || (W.layers && W.layers.sites))) || [];
  for(var i = 0; i < sites.length; i++) if(sites[i] && sites[i].kind === "transit") return sites[i];
  return null;
}
function frontOf(s){
  var f = s && s.front;
  if(f && f.length === 2){ var fx = (+f[0] || 0)/65536, fz = (+f[1] || 0)/65536, l = hyp(fx, fz); if(l > 1e-6) return [fx/l, fz/l]; }
  return s && s.facing === "south" ? [0, -1] : [0, 1];
}
// the station's door (m, the city's frame): where you climb the stairs
function doorOf(s){ var f = frontOf(s), r = (s.d || 0)/200 + 1; return {x: s.x/100 + f[0]*r, z: s.z/100 + f[1]*r, yaw: Math.atan2(f[0], f[1])}; }
// where a ray from the centre along (dx, dz) leaves the coast (m), the furthest crossing; no coast: nominal
function coastExit(W, dx, dz){
  var C = W && W.island && W.island.coast, best = -1;
  if(!C || C.length < 3) return [dx*NOMINAL_COAST, dz*NOMINAL_COAST];
  for(var i = 0; i < C.length; i++){
    var a = C[i], b = C[(i + 1) % C.length], ax = a[0]/100, az = a[1]/100, bx = b[0]/100, bz = b[1]/100;
    // ray t*(dx, dz) against segment a + u*(b - a)
    var ex = bx - ax, ez = bz - az, den = dx*ez - dz*ex;
    if(Math.abs(den) < 1e-9) continue;
    var t = (ax*ez - az*ex)/den, u = (ax*dz - az*dx)/den;
    if(u >= 0 && u <= 1 && t > best) best = t;
  }
  if(best < 0) best = NOMINAL_COAST;
  return [dx*best, dz*best];
}
// Ramer-Douglas-Peucker on [[x, z], ...]
function simplify(P, tol){
  if(P.length < 3) return P.slice();
  var keep = new Uint8Array(P.length); keep[0] = keep[P.length - 1] = 1;
  var stack = [[0, P.length - 1]];
  while(stack.length){
    var se = stack.pop(), a = P[se[0]], b = P[se[1]], dx = b[0] - a[0], dz = b[1] - a[1], L = hyp(dx, dz) || 1e-9, md = -1, mi = -1;
    for(var i = se[0] + 1; i < se[1]; i++){
      var d = Math.abs((P[i][0] - a[0])*dz - (P[i][1] - a[1])*dx)/L;
      if(d > md){ md = d; mi = i; }
    }
    if(md > tol){ keep[mi] = 1; stack.push([se[0], mi], [mi, se[1]]); }
  }
  return P.filter(function(p, i){ return keep[i]; });
}
// drop points closer than min m to the previous kept one (the route doubles up at its snapped ends)
function dedupe(P, min){
  var out = [P[0]];
  for(var i = 1; i < P.length; i++){ var q = out[out.length - 1]; if(hyp(P[i][0] - q[0], P[i][1] - q[1]) >= min || i === P.length - 1) out.push(P[i]); }
  if(out.length > 2 && hyp(out[out.length - 1][0] - out[out.length - 2][0], out[out.length - 1][1] - out[out.length - 2][1]) < min) out.splice(out.length - 2, 1);
  return out;
}

// The lanes at a station: lines that leave it along the same streets run side by side (LANE m apart about the
// street's middle) until they part, then ease back to the street's middle over TAPER m; ordered so the one that
// turns off to a side runs on that side (no crossing). Lines that part at once keep the middle. The same on every
// client (a pure function of the station's city and the lines' far ends).
// here {x, z}, others [{world, x, z}] (archipelago m) -> {world: {off (m, + to the left of the way out), until (m along
// the leg where the taper starts)}}
function lanes(W, tier, here, others){
  var L = (others || []).map(function(o){
    var dx = o.x - here.x, dz = o.z - here.z, P = cityLeg(W, tier, dx, dz);
    P.push([dx, dz]);                                                         // on to the far end: they part at sea too
    var Q = resample(P, STEP), S = [0];
    for(var i = 1; i < Q.length; i++) S.push(S[i - 1] + hyp(Q[i][0] - Q[i - 1][0], Q[i][1] - Q[i - 1][1]));
    return {world: String(o.world), Q: Q, S: S, g: -1, shared: 0};
  }).sort(function(a, b){ return a.world < b.world ? -1 : a.world > b.world ? 1 : 0; }), out = {};
  function ptAt(l, s){ var i = 0; while(i < l.S.length - 1 && l.S[i + 1] < s) i++; return l.Q[Math.min(i, l.Q.length - 1)]; }
  function dist(l, x, z){ var m = 1e18; for(var i = 0; i < l.Q.length; i++) m = Math.min(m, hyp(l.Q[i][0] - x, l.Q[i][1] - z)); return m; }
  // how far a runs beside b, and which side of a b goes when they part (+1: left)
  function pair(a, b){
    var k = 0; while(k < a.Q.length && dist(b, a.Q[k][0], a.Q[k][1]) < LANE*0.75) k++;
    var sh = a.S[Math.min(k, a.S.length - 1)], p0 = ptAt(a, Math.max(0, sh - 24)), p1 = ptAt(a, sh), q = ptAt(b, sh + 40);
    var dx = p1[0] - p0[0], dz = p1[1] - p0[1], side = -dz*(q[0] - p1[0]) + dx*(q[1] - p1[1]);
    var k2 = k; while(k2 < a.Q.length && dist(b, a.Q[k2][0], a.Q[k2][1]) < PART) k2++;
    return {sh: sh, hold: a.S[Math.min(k2, a.S.length - 1)], side: side > 0 ? 1 : -1};
  }
  var G = [];
  for(var i = 0; i < L.length; i++) for(var j = i + 1; j < L.length; j++){
    var pr = pair(L[i], L[j]);
    if(pr.sh < SHARE_MIN) continue;
    L[i].shared = Math.max(L[i].shared, pr.hold); L[j].shared = Math.max(L[j].shared, pr.hold);
    L[i]["s" + j] = pr.side; L[j]["s" + i] = -pr.side;                     // j is on side (+1 left) of i
    L[i]["h" + j] = L[j]["h" + i] = pr.sh;
    var gi = L[i].g, gj = L[j].g;
    if(gi < 0 && gj < 0){ L[i].g = L[j].g = G.length; G.push([i, j]); }
    else if(gi < 0){ L[i].g = gj; G[gj].push(i); }
    else if(gj < 0){ L[j].g = gi; G[gi].push(j); }
    else if(gi !== gj){ G[gj].forEach(function(x){ L[x].g = gi; G[gi].push(x); }); G[gj] = []; }
  }
  L.forEach(function(l){ out[l.world] = {off: 0, until: 0, left: false, right: false}; });
  G.forEach(function(g){
    // rank by how many of the group run to each one's right
    var rk = g.map(function(x){ var r = 0; g.forEach(function(y){ if(y !== x && L[x]["s" + y] === -1) r++; }); return {x: x, r: r}; })
              .sort(function(a, b){ return a.r - b.r || a.x - b.x; });
    // left / right: a neighbour beside its whole platform (they share the island platform between them)
    function by(a, b){ return !!b && (L[a.x]["h" + b.x] || 0) >= PLAT + 8; }
    rk.forEach(function(e, n){ out[L[e.x].world] = {off: (n - (rk.length - 1)/2)*LANE, until: L[e.x].shared, left: by(e, rk[n + 1]), right: by(e, rk[n - 1])}; });
  });
  return out;
}
// A polyline moved sideways (+ to the left of its way) by lane.off m up to lane.until m along it, easing back to the
// middle over TAPER m; mitred at the corners
function offsetLeg(P, lane){
  var n = P.length, off = lane && +lane.off || 0; if(!off || n < 2) return P;
  var N = [], s = 0, out = [], until = +lane.until || 0;
  for(var i = 0; i < n - 1; i++){ var dx = P[i + 1][0] - P[i][0], dz = P[i + 1][1] - P[i][1], l = hyp(dx, dz) || 1; N.push([-dz/l, dx/l]); }
  for(var j = 0; j < n; j++){
    if(j) s += hyp(P[j][0] - P[j - 1][0], P[j][1] - P[j - 1][1]);
    var a = N[Math.max(0, j - 1)], b = N[Math.min(n - 2, j)], mx = a[0] + b[0], mz = a[1] + b[1], ml = hyp(mx, mz);
    if(ml < 1e-6){ mx = b[0]; mz = b[1]; ml = 1; }
    mx /= ml; mz /= ml;
    var u = s <= until ? 1 : Math.max(0, 1 - (s - until)/TAPER), o = off*(u*u*(3 - 2*u))*Math.min(2, 1/Math.max(0.5, mx*b[0] + mz*b[1]));
    out.push([P[j][0] + mx*o, P[j][1] + mz*o, Math.abs(off*(u*u*(3 - 2*u)))]);
  }
  // inside a corner tighter than the lane the offset folds back on itself: drop what comes nearer the middle than the lane
  return out.filter(function(q, j){
    for(var i = Math.max(0, j - 12); i < Math.min(n - 1, j + 12); i++){
      var ax = P[i][0], az = P[i][1], ex = P[i + 1][0] - ax, ez = P[i + 1][1] - az, l2 = ex*ex + ez*ez || 1;
      var t = Math.max(0, Math.min(1, ((q[0] - ax)*ex + (q[1] - az)*ez)/l2));
      if(hyp(q[0] - ax - ex*t, q[1] - az - ez*t) < q[2]*0.97) return false;
    }
    return true;
  }).map(function(q){ return [q[0], q[1]]; });
}
// One city's leg in its own frame: [[x, z], ...] from the street in front of its station to its coast facing
// (dx, dz) and a little out over the water. No W (or no station, no road): a straight nominal leg from the centre.
function cityLeg(W, tier, dx, dz){
  var l = hyp(dx, dz) || 1; dx /= l; dz /= l;
  var C = coastExit(W, dx, dz), st = stationOf(W), NAVo = HQV.hqnav, P = null;
  if(W && st && NAVo && W.edges && W.nodes){
    var d = doorOf(st), G = null, R = null;
    try { G = NAVo.graph(W, tier || 5); var sn = NAVo.snap(G, C[0] - dx*30, C[1] - dz*30);   // the road nearest the coast exit: no leg across lots to it
      R = NAVo.route(G, {x: d.x, z: d.z}, sn ? {x: sn.x, z: sn.z} : {x: C[0] - dx*90, z: C[1] - dz*90}, "walk"); } catch(e){ R = null; }
    if(R && R.pts && R.pts.length >= 6){
      P = [];
      for(var i = 2; i < R.pts.length; i += 2) P.push([R.pts[i], R.pts[i + 1]]);     // from the snapped road point
    }
  }
  if(!P){
    var r0 = st ? hyp(st.x/100, st.z/100) : 0, a = Math.atan2(dx, dz);
    var sx = st ? st.x/100 : Math.sin(a)*r0, sz = st ? st.z/100 : Math.cos(a)*r0;
    P = [[sx, sz]];
  }
  P.push([C[0], C[1]]);
  return dedupe(P, 3);
}

// Points every STEP m along a polyline
function resample(V, step){
  var out = [V[0].slice()], carry = 0;
  for(var i = 1; i < V.length; i++){
    var a = V[i - 1], b = V[i], d = hyp(b[0] - a[0], b[1] - a[1]);
    if(d < 1e-9) continue;
    var u = step - carry;
    while(u <= d){ out.push([a[0] + (b[0] - a[0])*u/d, a[1] + (b[1] - a[1])*u/d]); u += step; }
    carry = d - (u - step);
  }
  var L = V[V.length - 1], q = out[out.length - 1];
  if(hyp(L[0] - q[0], L[1] - q[1]) > step*0.3) out.push(L.slice()); else out[out.length - 1] = L.slice();
  return out;
}
// An elastic band in a corridor: the polyline resampled, blurred again and again, every point held within its
// corridor (CUT m of where it was over land, wider over the sea), so the corners round off as widely as the
// street allows. -> points every STEP m
function corridor(V, landAt, overBuilding){
  var O = resample(V, STEP), n = O.length, P = null, lim = new Float64Array(n), K = 9;
  for(var i = 0; i < n; i++) lim[i] = landAt(O[i][0], O[i][1]) ? CUT : 70;
  // the platforms stay on the street in front of the stations
  for(var e = 0; e < n; e++){ var se = Math.min(e, n - 1 - e)*STEP; if(se < PLAT) lim[e] = Math.min(lim[e], 1 + se*0.02); }
  var Q = new Float64Array(2*n), X = new Float64Array(n + 1), Z = new Float64Array(n + 1);
  // a band that ends up over a building is held closer to the street there, and pulled again
  for(var round = 0; round < 6; round++){
    P = O.map(function(p){ return p.slice(); });
    for(var pass = 0; pass < 60; pass++){
      X[0] = 0; Z[0] = 0;
      for(var a = 0; a < n; a++){ X[a + 1] = X[a] + P[a][0]; Z[a + 1] = Z[a] + P[a][1]; }
      for(var b = 1; b < n - 1; b++){
        var k = Math.min(K, b, n - 1 - b), lo = b - k, hi = b + k + 1;
        Q[2*b] = (X[hi] - X[lo])/(hi - lo); Q[2*b + 1] = (Z[hi] - Z[lo])/(hi - lo);
      }
      for(var c = 1; c < n - 1; c++){
        var dx = Q[2*c] - O[c][0], dz = Q[2*c + 1] - O[c][1], d = hyp(dx, dz), m = d > lim[c] ? lim[c]/d : 1;
        P[c][0] = O[c][0] + dx*m; P[c][1] = O[c][1] + dz*m;
      }
    }
    if(!overBuilding) break;
    var hit = 0;
    for(var h = 1; h < n - 1; h++){
      if(lim[h] <= 0.6 || !overBuilding(P[h][0], P[h][1]) || overBuilding(O[h][0], O[h][1])) continue;
      hit++;
      for(var g = Math.max(1, h - 4); g <= Math.min(n - 2, h + 4); g++) lim[g] = Math.max(0.5, lim[g]*0.5);
    }
    if(!hit) break;
  }
  return resample(dedupe(P, 0.5), STEP);
}
// the curve radius at each point of a polyline every STEP m (m, Infinity on a straight)
function radii(P){
  var n = P.length, r = new Float64Array(n), r0 = new Float64Array(n), w = 4;
  for(var j = 0; j < n; j++){
    var i0 = Math.max(0, j - w), i1 = Math.min(n - 1, j + w);
    if(i1 - i0 < 2){ r0[j] = Infinity; continue; }
    var ax = P[i0][0], az = P[i0][1], bx = P[j][0], bz = P[j][1], cx = P[i1][0], cz = P[i1][1];
    var cr = Math.abs((bx - ax)*(cz - az) - (bz - az)*(cx - ax));
    r0[j] = cr < 1e-6 ? Infinity : hyp(bx - ax, bz - az)*hyp(cx - bx, cz - bz)*hyp(cx - ax, cz - az)/(2*cr);
    if(r0[j] > 2000) r0[j] = Infinity;
  }
  for(var q = 0; q < n; q++){ var mr = Infinity; for(var t = Math.max(0, q - 2); t <= Math.min(n - 1, q + 2); t++) mr = Math.min(mr, r0[t]); r[q] = mr; }
  return r;
}

// the alignment from A's station to B's (both in archipelago metres)
function alignment(A, B){
  var Ax = +A.x || 0, Az = +A.z || 0, Bx = +B.x || 0, Bz = +B.z || 0, dx = Bx - Ax, dz = Bz - Az, l = hyp(dx, dz) || 1;
  dx /= l; dz /= l;
  var la = cityLeg(A.W, A.tier, dx, dz), lb = cityLeg(B.W, B.tier, -dx, -dz);
  var V = [];
  la.forEach(function(p){ V.push([p[0] + Ax, p[1] + Az]); });
  for(var i = lb.length - 1; i >= 0; i--) V.push([lb[i][0] + Bx, lb[i][1] + Bz]);
  // the street legs' small wiggles are not corners: simplify within a road's half width, keeping the ends
  V = simplify(dedupe(V, 3), 2.5);
  var landAt = function(x, z){
    var inA = hyp(x - Ax, z - Az) <= hyp(x - Bx, z - Bz), Wc = inA ? A.W : B.W, lx = inA ? x - Ax : x - Bx, lz = inA ? z - Az : z - Bz;
    return Wc && Wc.island ? inside(Wc.island.coast, lx*100, lz*100) : hyp(lx, lz) < NOMINAL_COAST - 10;
  };
  var WDb = WDo(), overBuilding = WDb && WDb.blockedAt && WDb.surfaceAt ? function(x, z){
    var inA = hyp(x - Ax, z - Az) <= hyp(x - Bx, z - Bz), Wc = inA ? A.W : B.W, lx = inA ? x - Ax : x - Bx, lz = inA ? z - Az : z - Bz;
    if(!Wc || !Wc.lots) return false;
    var lot = WDb.lotAt(Wc, lx, lz), tier = (inA ? A.tier : B.tier) || 5;     // a building of a later tier is not there yet
    if(lot && lot.min_tier != null && (lot.min_tier | 0) > tier) return false;
    var k = WDb.surfaceAt(Wc, lx, lz);
    return (k === "lot" || k === "site") && WDb.blockedAt(Wc, lx, lz);
  } : null;
  var P = corridor(V, landAt, overBuilding);
  // the lanes: moved sideways off the street's middle at each end (once smooth: parallel, never closer than LANE)
  if(A.lane && A.lane.off) P = offsetLeg(P, A.lane);
  if(B.lane && B.lane.off) P = offsetLeg(P.slice().reverse(), B.lane).reverse();
  if((A.lane && A.lane.off) || (B.lane && B.lane.off)) P = resample(dedupe(P, 0.5), STEP);
  var Fr = radii(P), n = P.length;
  var pts = new Float64Array(3*n), s = new Float64Array(n), r = new Float64Array(n);
  for(var k = 0; k < n; k++){ pts[3*k] = P[k][0]; pts[3*k + 2] = P[k][1]; r[k] = Fr[k]; if(k) s[k] = s[k - 1] + hyp(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]); }
  var len = s[n - 1];
  // heights: DECK_UP over the ground of the city below, SEA_UP over the sea, eased to GRADE without dipping
  var WD = WDo(), ya = A.sea != null ? +A.sea : 0, yb = B.sea != null ? +B.sea : 0, base = new Float64Array(n), land = new Uint8Array(n);
  var ra = (A.W && A.W.island) ? coastR(A.W) : NOMINAL_COAST, rb = (B.W && B.W.island) ? coastR(B.W) : NOMINAL_COAST;
  for(var j = 0; j < n; j++){
    var x = P[j][0], z = P[j][1], da = hyp(x - Ax, z - Az), db = hyp(x - Bx, z - Bz), inA = da <= db;
    var Wc = inA ? A.W : B.W, lx = inA ? x - Ax : x - Bx, lz = inA ? z - Az : z - Bz, sy = inA ? ya : yb;
    var onLand = Wc && Wc.island ? inside(Wc.island.coast, lx*100, lz*100) : (inA ? da : db) < (inA ? ra : rb) - 10;
    land[j] = onLand ? 1 : 0;
    var g = sy;
    if(onLand && Wc && WD && WD.groundAt){
      g = -1e9;
      for(var o = -4; o <= 4; o += 4){ var gy = WD.groundAt(Wc, lx + o*0.7, lz + o*0.7); if(isFinite(gy)) g = Math.max(g, gy); }
      if(g < -1e8) g = sy;
    }
    base[j] = onLand ? Math.max(g, sy) + DECK_UP : sy + SEA_UP;
  }
  var y = new Float64Array(n);
  // the lowest profile over base that keeps to GRADE: max over j of base[j] - GRADE |s_i - s_j| (two passes)
  for(var a1 = 0; a1 < n; a1++) y[a1] = base[a1];
  for(var f1 = 1; f1 < n; f1++) y[f1] = Math.max(y[f1], y[f1 - 1] - GRADE*(s[f1] - s[f1 - 1]));
  for(var b1 = n - 2; b1 >= 0; b1--) y[b1] = Math.max(y[b1], y[b1 + 1] - GRADE*(s[b1 + 1] - s[b1]));
  // smoothed (the vertical curves), never below the clearance less half a metre
  for(var pass = 0; pass < 3; pass++){
    var y2 = new Float64Array(n);
    for(var q = 0; q < n; q++){ var acc = 0, cnt = 0; for(var w = -5; w <= 5; w++){ var qq = Math.max(0, Math.min(n - 1, q + w)); acc += y[qq]; cnt++; } y2[q] = Math.max(base[q] - 0.5, acc/cnt); }
    y = y2;
  }
  // the platforms are level
  var pa = Math.min(n - 1, Math.ceil(PLAT/STEP)), pb = Math.max(0, n - 1 - Math.ceil(PLAT/STEP));
  var ha = 0, hb = 0; for(var u1 = 0; u1 <= pa; u1++) ha = Math.max(ha, y[u1]); for(var u2 = pb; u2 < n; u2++) hb = Math.max(hb, y[u2]);
  for(var u3 = 0; u3 <= pa; u3++) y[u3] = ha; for(var u4 = pb; u4 < n; u4++) y[u4] = hb;
  for(var e1 = pa + 1; e1 < n; e1++) y[e1] = Math.max(y[e1], y[e1 - 1] - GRADE*(s[e1] - s[e1 - 1]));
  for(var e2 = pb - 1; e2 >= 0; e2--) y[e2] = Math.max(y[e2], y[e2 + 1] - GRADE*(s[e2 + 1] - s[e2]));
  for(var m = 0; m < n; m++) pts[3*m + 1] = y[m];
  // the sea viaduct: from where the line last leaves A's land to where it first reaches B's
  var seaA = 0, seaB = len;
  for(var h1 = 0; h1 < n; h1++) if(land[h1] && hyp(P[h1][0] - Ax, P[h1][1] - Az) < hyp(P[h1][0] - Bx, P[h1][1] - Bz)) seaA = s[h1];
  for(var h2 = n - 1; h2 >= 0; h2--) if(land[h2] && hyp(P[h2][0] - Bx, P[h2][1] - Bz) < hyp(P[h2][0] - Ax, P[h2][1] - Az)) seaB = s[h2];
  var R = {pts: pts, s: s, r: r, len: len, seaA: seaA, seaB: seaB, from: A.world, to: B.world, A: {x: Ax, z: Az}, B: {x: Bx, z: Bz}, n: n};
  return timing(R);
}
// the same line the other way (B's station to A's): the same track, so both cities and both ways agree
function reverse(R0){
  var n = R0.n, pts = new Float64Array(3*n), s = new Float64Array(n), r = new Float64Array(n);
  for(var i = 0; i < n; i++){ var j = n - 1 - i; pts[3*i] = R0.pts[3*j]; pts[3*i + 1] = R0.pts[3*j + 1]; pts[3*i + 2] = R0.pts[3*j + 2]; r[i] = R0.r[j]; s[i] = R0.len - R0.s[j]; }
  var R = {pts: pts, s: s, r: r, len: R0.len, seaA: R0.len - R0.seaB, seaB: R0.len - R0.seaA, from: R0.to, to: R0.from, A: R0.B, B: R0.A, n: n};
  // the Island Link's segment kinds: the segment starting at reversed i is the original one ending at n - 1 - i
  if(R0.k){ R.k = new Uint8Array(n); for(var q = 0; q < n; q++) R.k[q] = R0.k[Math.max(0, n - 2 - q)]; R.plat = R0.plat; }
  return timing(R);
}
// the speed (the leg's limit, the curve's, standing at both platforms), the time at each point, T and the handover
function timing(R){
  var n = R.n, s = R.s, r = R.r, len = R.len, seaA = R.seaA, seaB = R.seaB, v = new Float64Array(n), t = new Float64Array(n), P = R.pts;
  var s0 = Math.min(len, TRAIN_L + STOP_END), s1 = Math.max(s0, len - STOP_END);
  for(var z0 = 0; z0 < n; z0++) if(s[z0] >= s0){ s0 = s[z0]; break; }          // both stops on a point: no part-step
  for(var z1 = n - 1; z1 >= 0; z1--) if(s[z1] <= s1){ s1 = Math.max(s0, s[z1]); break; }
  for(var c1 = 0; c1 < n; c1++){
    var lim = s[c1] > seaA && s[c1] < seaB ? SEA_V : CITY_V;
    if(isFinite(r[c1])) lim = Math.min(lim, Math.max(CURVE_MIN, Math.sqrt(A_LAT*r[c1])));
    v[c1] = s[c1] <= s0 || s[c1] >= s1 ? 0 : lim;
  }
  // a curve limits the whole train while any of it is on the curve: the limit holds TRAIN_L behind it too
  var vl = Float64Array.from(v);
  for(var c2 = 0; c2 < n; c2++) if(isFinite(r[c2])){ for(var c3 = c2; c3 < n && s[c3] - s[c2] <= TRAIN_L; c3++) vl[c3] = Math.min(vl[c3], v[c2] || vl[c3]); }
  v = vl;
  for(var g1 = 1; g1 < n; g1++) v[g1] = Math.min(v[g1], Math.sqrt(v[g1 - 1]*v[g1 - 1] + 2*ACC*(s[g1] - s[g1 - 1])));
  for(var g2 = n - 2; g2 >= 0; g2--) v[g2] = Math.min(v[g2], Math.sqrt(v[g2 + 1]*v[g2 + 1] + 2*ACC*(s[g2 + 1] - s[g2])));
  // time from s0 (the head at A's platform) to s1; t is measured from s0
  var i0 = 0; while(i0 < n - 1 && s[i0 + 1] <= s0) i0++;
  for(var h = 0; h < n; h++){
    if(h <= i0){ t[h] = 0; continue; }
    var vm = (v[h] + v[h - 1])/2, ds = s[h] - Math.max(s[h - 1], s0);
    t[h] = t[h - 1] + Math.max(0, ds)/Math.max(0.6, vm);
  }
  R.v = v; R.t = t; R.s0 = s0; R.s1 = s1;
  R.T = timeAtS(R, s1);
  // the handover: where the head is first nearer B's centre than A's (mid-sea)
  var kh = n - 1;
  for(var e = 0; e < n; e++) if(hyp(P[3*e] - R.B.x, P[3*e + 2] - R.B.z) <= hyp(P[3*e] - R.A.x, P[3*e + 2] - R.A.z)){ kh = e; break; }
  R.hand = timeAtS(R, s[kh]);
  return R;
}
function coastR(W){
  var c = W && W.island && W.island.coast, m = 0;
  if(!c || !c.length) return NOMINAL_COAST;
  for(var i = 0; i < c.length; i++) m = Math.max(m, hyp(c[i][0], c[i][1])/100);
  return m;
}
// [3.36] the waypoints [[x, z], ...] that take a sea viaduct from abutment e (archipelago m) round its island (centre
// cx, cz; coast radius r m) offshore until it faces (tx, tz): first SWING_OUT m straight out along its front f, then an
// arc at that radius; none when the abutment already faces within 60 degrees
var SWING_OUT = 300;
function swingRound(cx, cz, e, f, tx, tz, r){
  var e0 = [e[0] + f[0]*SWING_OUT, e[2] + f[1]*SWING_OUT], ox = e0[0] - cx, oz = e0[1] - cz, a0 = Math.atan2(oz, ox), d = Math.atan2(tz, tx) - a0;
  while(d > Math.PI) d -= 2*Math.PI;
  while(d < -Math.PI) d += 2*Math.PI;
  if(Math.abs(d) < Math.PI/3) return [];
  var rr = Math.max((r || 0) + 150, hyp(ox, oz)), n = Math.ceil(Math.abs(d)/(Math.PI/8)), out = [e0];
  for(var i = 1; i <= n; i++){ var a = a0 + d*i/n; out.push([cx + Math.cos(a)*rr, cz + Math.sin(a)*rr]); }
  return out;
}
function inside(P, x, z){
  if(!P || P.length < 3) return false;
  var ins = false;
  for(var i = 0, j = P.length - 1; i < P.length; j = i++){
    var xi = P[i][0], zi = P[i][1], xj = P[j][0], zj = P[j][1];
    if((zi > z) !== (zj > z) && x < (xj - xi)*(z - zi)/(zj - zi) + xi) ins = !ins;
  }
  return ins;
}
// the index of the last point at or before s
function idxAt(R, along){
  var S = R.s, lo = 0, hi = S.length - 1;
  if(along <= S[0]) return 0;
  if(along >= S[hi]) return hi - 1;
  while(hi - lo > 1){ var m = (lo + hi) >> 1; if(S[m] <= along) lo = m; else hi = m; }
  return lo;
}
function timeAtS(R, along){
  var i = idxAt(R, along), j = Math.min(R.n - 1, i + 1), ds = R.s[j] - R.s[i], u = ds > 1e-9 ? Math.max(0, Math.min(1, (along - R.s[i])/ds)) : 0;
  return R.t[i] + (R.t[j] - R.t[i])*u;
}
// the track at s m along
function at(R, along){
  along = Math.max(0, Math.min(R.len, along));
  var i = idxAt(R, along), j = Math.min(R.n - 1, i + 1), P = R.pts, ds = R.s[j] - R.s[i], u = ds > 1e-9 ? (along - R.s[i])/ds : 0;
  var x = P[3*i] + (P[3*j] - P[3*i])*u, y = P[3*i + 1] + (P[3*j + 1] - P[3*i + 1])*u, z = P[3*i + 2] + (P[3*j + 2] - P[3*i + 2])*u;
  // the heading over a short chord (smooth over the 4 m steps)
  var a = Math.max(0, i - 1), b = Math.min(R.n - 1, j + 1);
  var hx = P[3*b] - P[3*a], hz = P[3*b + 2] - P[3*a + 2], hy = P[3*b + 1] - P[3*a + 1];
  return {x: x, y: y, z: z, yaw: Math.atan2(hx, hz), pitch: Math.atan2(hy, hyp(hx, hz) || 1)};
}
// the head t s after leaving A's platform (t < 0: standing at it; t > T: standing at B's)
function poseAt(R, t){
  var T = R.t, n = R.n;
  var along, sp = 0;
  if(!(t > 0)) along = R.s0;
  else if(t >= R.T) along = R.s1;
  else {
    var lo = 0, hi = n - 1;
    while(hi - lo > 1){ var m = (lo + hi) >> 1; if(T[m] <= t) lo = m; else hi = m; }
    var dt = T[hi] - T[lo], sl = Math.max(R.s[lo], R.s0), ds = R.s[hi] - sl, v0 = lo === 0 || R.s[lo] < R.s0 ? 0 : R.v[lo], v1 = R.v[hi], tau = t - T[lo];
    var a = dt > 1e-9 ? (v1 - v0)/dt : 0, d = Math.min(ds, Math.max(0, v0*tau + a*tau*tau/2));
    along = Math.min(R.s1, sl + d); sp = Math.max(0, v0 + a*tau);
  }
  var p = at(R, along);
  p.speed = sp; p.along = along; p.u = R.T > 0 ? Math.max(0, Math.min(1, t/R.T)) : 1;
  p.leg = along > R.seaA && along < R.seaB ? "sea" : "city";
  return p;
}

// departures: a -> b every EVERY ms; b -> a half a period later; the same on every client
function lineKey(a, b){ a = String(a); b = String(b); return a < b ? a + "|" + b : b + "|" + a; }
function hash(s){ var h = 2166136261; for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
function offsetOf(a, b){ var o = hash("rail:" + lineKey(a, b)) % EVERY; return String(a) < String(b) ? o : (o + EVERY/2) % EVERY; }
function departures(a, b, nowMs, back, ahead){
  var off = offsetOf(a, b), out = [];
  var k0 = Math.floor((nowMs - back - off)/EVERY), k1 = Math.ceil((nowMs + ahead - off)/EVERY);
  for(var k = k0; k <= k1; k++){ var d = k*EVERY + off; if(d >= nowMs - back && d <= nowMs + ahead) out.push(d); }
  return out;
}
function nextDeparture(a, b, nowMs){ var off = offsetOf(a, b); return Math.ceil((nowMs - off)/EVERY)*EVERY + off; }
// GET /api/arena/rail's lines touching `world`: [{other, a, b}] (rows with both ends shaped as world ids)
// @2 or @3 ids (an older Arena lists @2 lines); `other` comes back in `world`'s version so it matches that world's places
var WORLD_RE = /^(claude-hq@[23]|user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@[23])$/;
function linesAt(rail, world){
  var L = rail && Array.isArray(rail.lines) ? rail.lines : [], v = verOf(world);
  return L.filter(function(l){ return l && WORLD_RE.test(String(l.a)) && WORLD_RE.test(String(l.b)) && !sameWorld(l.a, l.b) && (sameWorld(l.a, world) || sameWorld(l.b, world)); })
          .map(function(l){ return {other: asVersion(sameWorld(l.a, world) ? l.b : l.a, v), a: l.a, b: l.b}; });
}
function built(rail, a, b){ return linesAt(rail, a).some(function(l){ return sameWorld(l.other, b); }); }
// The station menu's rail rows: a ride on each built line from here; for your own island (tier 2+) a line to every
// place it is not yet linked to that has a station; elsewhere a note that lines are built from an island's station.
// places: travelPlaces (metres, with tier), me: your island's world id (or null), myTier: its tier.
function menuRows(rail, here, places, mine, myTier, nowMs){
  var out = [], cost = rail && rail.cost > 0 ? rail.cost | 0 : COST, minT = rail && rail.min_tier > 0 ? rail.min_tier | 0 : 2;
  (places || []).forEach(function(p){
    if(!p || sameWorld(p.world, here)) return;
    if(built(rail, here, p.world)){
      var dep = nextDeparture(here, p.world, nowMs); if(dep - nowMs < 8000) dep += EVERY;
      out.push({kind: "ride", to: p, departs: dep});
    }
  });
  (places || []).forEach(function(p){
    if(!p || sameWorld(p.world, here) || built(rail, here, p.world)) return;
    var stationThere = isCommonsId(p.world) || (p.tier | 0) >= minT;
    if(sameWorld(here, mine) && stationThere && myTier >= minT) out.push({kind: "build", to: p, cost: cost});
    else if(!sameWorld(here, mine) && sameWorld(p.world, mine) && myTier >= minT) out.push({kind: "build-from", to: p, cost: cost});
  });
  // elsewhere: one note for the islands with a station and no line here yet (their owners build them)
  if(!sameWorld(here, mine)){
    var un = (places || []).filter(function(p){ return p && !sameWorld(p.world, here) && !sameWorld(p.world, mine) && !isCommonsId(p.world) && (p.tier | 0) >= minT && !built(rail, here, p.world); });
    if(un.length) out.push({kind: "note", to: un[0], more: un.length - 1});
  }
  return out;
}

/* ---------- the Island Link (HQ 3.15, D7): every island <-> the Commons, pre-built by the @3 generator ----------
   Each island's doc carries an IL line (layers.rail, kind "island") from Central's underground IL platforms through a
   tunnel and a coastal portal to layers.rail.sea, the sea viaduct's abutment; the Commons' doc carries Commons Central
   (a terminal of LINK_PLATS platforms) and its sea junction. The sea crossing between an abutment and the junction is
   laid here from the archipelago positions (leaving the abutment along its front, arriving along the junction's,
   SEA_UP m over the water), so one route serves both worlds. A doc without the layer (an @2 world) gets a nominal leg
   from its station to its coast. Departures: every LINK_EVERY ms each way per island, a pure function of the island's
   id (the version is ignored, so @2 and @3 clients agree); the Commons' platform for an island is linkPlatform().
     linkRoute(I, C, o)  I, C = {world, x, z (archipelago m), W (packed world or raw doc) | null, sea?} -> R (island ->
                         Commons; reverse(R) the other way), as alignment()'s R plus k (the kind of each point's
                         segment: K_TUNNEL, ...) and plat
     linkService(o)      a Service (plan 5.3, mode "link") for the world you are in; link(islandWorld, o) one island's
     linkSpawn(W, world, island?, list?)  where you step off at a world's IL platform {world, site, x, y, z, yaw, under}
     linkDepartures(island, dir ("out": island -> Commons | "in"), nowMs, back, ahead) / linkNext(island, dir, ms)
   Seats: SEATS / STAND (car-local: +x left, z forward, y over the floor), 2+2 transverse in facing bays, the cab
   ends and car 1's luggage stack without seats; shared by the City Line (games/hqcityrail.js). */
var LINK_EVERY = 300000, LINK_PLATS = 6, LINK_PLAT_GAP = 5.5, LINK_COLOR = "#6d4bb3";
var K_GRADE = 0, K_TUNNEL = 1, K_PORTAL = 2, K_VIADUCT = 3, K_BRIDGE = 4, K_SEA = 5;
var KCODE = {grade: K_GRADE, tunnel: K_TUNNEL, portal: K_PORTAL, viaduct: K_VIADUCT, bridge: K_BRIDGE, sea: K_SEA};
var SEAT_UP = 0.45;          // m: a seat's top over the car floor
var DOOR_Z = CAR_L*0.22;     // m: the doors either side of a car's middle (carModel's)

// the seats of one train: [{car, x, y, z, back (faces the rear), window, side ("left"|"right")}] and standing spots
var SEATS = [], STAND = [];
(function(){
  var X = [1.05, 0.5, -0.5, -1.05];
  var ROWS = [{z: -6.6, b: 0, end: -1}, {z: -5.0, b: 1, end: -1}, {z: -2.2, b: 0}, {z: -0.75, b: 1}, {z: 0.75, b: 0}, {z: 2.2, b: 1},
              {z: 5.0, b: 0, end: 1}, {z: 6.6, b: 1, end: 1}];
  for(var c = 0; c < CARS; c++){
    ROWS.forEach(function(r){
      if(c === 0 && r.end) return;                    // car 1: its cab at the front, the luggage stack at the back
      if(c === CARS - 1 && r.end === -1) return;      // the last car: its cab at the back
      X.forEach(function(x){ SEATS.push({car: c, x: x, y: SEAT_UP, z: r.z, back: !!r.b, window: Math.abs(x) > 0.8, side: x < 0 ? "right" : "left"}); });
    });
    [-DOOR_Z, DOOR_Z].forEach(function(dz){ [[0.75, -0.35], [-0.75, -0.35], [0.75, 0.35], [-0.75, 0.35]].forEach(function(q){ STAND.push({car: c, x: q[0], y: 0, z: dz + q[1]}); }); });
  }
})();

// layers.rail in metres: HQV.world.railOf on a packed world, else converted here (W.rail, or a raw doc's layers.rail; cm)
var RAIL_MEMO = typeof WeakMap === "function" ? new WeakMap() : null;
function railView(W){
  if(!W || typeof W !== "object") return null;
  var WD = WDo();
  if(W.rail && WD && WD.railOf){ try { var rv = WD.railOf(W); if(rv) return rv; } catch(e){} }
  var L = W.rail || (W.layers && W.layers.rail);
  if(!L || typeof L !== "object") return null;
  if(RAIL_MEMO && RAIL_MEMO.has(L)) return RAIL_MEMO.get(L);
  function cm(v){ v = +v; return isFinite(v) ? v/100 : 0; }
  function unit(f){ var fx = f ? +f[0] || 0 : 0, fz = f ? +f[1] || 0 : 1, l = hyp(fx, fz); return l > 1e-9 ? [fx/l, fz/l] : [0, 1]; }
  var sea = L.sea, su = sea ? unit(sea.front) : null;
  var out = {
    lines: (L.lines || []).filter(Boolean).map(function(l){
      var o = {id: String(l.id), kind: l.kind === "island" ? "island" : "city", stations: (l.stations || []).map(String),
              path: (l.path || []).filter(function(p){ return p && p.length >= 3; }).map(function(p){ return [cm(p[0]), cm(p[1]), cm(p[2])]; }),
              kinds: (l.kinds || []).map(String), tier: (l.tier | 0) || 1};
      // City Gen v4 phase 8: the generator's viaduct piers [{x, y, z, h}] (m), only when the doc has them (world.js railOf)
      if(Array.isArray(l.piers)) o.piers = l.piers.filter(function(p){ return p && isFinite(+p.x) && isFinite(+p.z); })
        .map(function(p){ return {x: cm(p.x), y: cm(p.y), z: cm(p.z), h: Math.max(0, cm(p.h))}; });
      return o;
    }),
    stations: (L.stations || []).filter(Boolean).map(function(s){
      var u = unit(s.along);
      return {id: String(s.id), kind: String(s.kind || "elevated"), x: cm(s.x), y: cm(s.y), z: cm(s.z), along: u, yaw: Math.atan2(u[0], u[1]),
              len: cm(s.len), platforms: Math.max(1, s.platforms | 0), lines: (s.lines || []).map(String),
              stairs: (s.stairs || []).filter(function(p){ return p && p.length >= 2; }).map(function(p){ return [cm(p[0]), cm(p[1])]; })};
    }),
    sea: sea ? {x: cm(sea.x), y: cm(sea.y), z: cm(sea.z), front: su, yaw: Math.atan2(su[0], su[1])} : null,
    holes: []
  };
  if(RAIL_MEMO) RAIL_MEMO.set(L, out);
  return out;
}
function seaLevelOf(W){
  var I = W && (W.island || (W.layers && W.layers.island));
  return I && I.sea_cm != null ? (+I.sea_cm || 0)/100 : 0;
}
// a world's IL in its own frame: {station, sea, P: [[x, y, z]] from behind the platform out to the sea point, K: segment kinds}
function ilOf(W){
  var R = railView(W);
  if(!R) return null;
  var line = R.lines.filter(function(l){ return l.kind === "island" && l.path.length >= 2; })[0];
  if(!line) return null;
  var st = null;
  R.stations.forEach(function(s){ if(!st && line.stations.indexOf(s.id) >= 0) st = s; });
  var P = line.path.map(function(p){ return p.slice(); }), K = line.kinds.map(function(k){ return KCODE[k] != null ? KCODE[k] : K_GRADE; });
  while(K.length < P.length - 1) K.push(K.length ? K[K.length - 1] : K_GRADE);
  K = K.slice(0, P.length - 1);
  var n = P.length;
  if(st && hyp(P[n - 1][0] - st.x, P[n - 1][2] - st.z) < hyp(P[0][0] - st.x, P[0][2] - st.z)){ P.reverse(); K.reverse(); }
  // the path starts at the platform's middle: run it back so a train's middle stands there (head TRAIN_L/2 + STOP_END on)
  var ref = st || {x: P[0][0], z: P[0][2]};
  if(hyp(P[0][0] - ref.x, P[0][2] - ref.z) < 5){
    var bx = P[0][0] - P[1][0], bz = P[0][2] - P[1][2], bl = hyp(bx, bz) || 1, h = TRAIN_L/2 + STOP_END;
    P.unshift([P[0][0] + bx/bl*h, P[0][1], P[0][2] + bz/bl*h]); K.unshift(K[0]);
  }
  var sea = R.sea;
  if(sea && hyp(P[P.length - 1][0] - sea.x, P[P.length - 1][2] - sea.z) > 3){ P.push([sea.x, sea.y, sea.z]); K.push(K_VIADUCT); }
  return {station: st, sea: sea, P: P, K: K, platforms: st ? st.platforms : 1};
}
// no IL in the doc (an @2 world, or no doc yet): a nominal leg from the station (else the centre) to the coast facing (dx, dz)
function fallbackLeg(W, dx, dz, seaY){
  var st = W ? stationOf(W) : null, C = coastExit(W && (W.island || (W.layers && W.layers.island)) ? {island: W.island || W.layers.island} : null, dx, dz);
  var sx = st ? st.x/100 : 0, sz = st ? st.z/100 : 0, y0 = seaY + DECK_UP, h = TRAIN_L/2 + STOP_END;
  var P = [[sx - dx*h, y0, sz - dz*h], [sx, y0, sz], [C[0], seaY + SEA_UP, C[1]]];
  return {station: null, sea: {x: C[0], y: seaY + SEA_UP, z: C[1], front: [dx, dz]}, P: P, K: [K_VIADUCT, K_VIADUCT], platforms: 1};
}
// points every `step` m (in plan) along V [[x, y, z]] with the kind of the segment each lies on
function resample3(V, K, step){
  var P = [V[0].slice()], KO = [K[0]], carry = 0;
  for(var i = 1; i < V.length; i++){
    var a = V[i - 1], b = V[i], d = hyp(b[0] - a[0], b[2] - a[2]);
    if(d < 1e-9) continue;
    var u = step - carry;
    while(u <= d){ var f = u/d; P.push([a[0] + (b[0] - a[0])*f, a[1] + (b[1] - a[1])*f, a[2] + (b[2] - a[2])*f]); KO.push(K[i - 1]); u += step; }
    carry = d - (u - step);
  }
  var L = V[V.length - 1], q = P[P.length - 1];
  if(hyp(L[0] - q[0], L[2] - q[2]) > step*0.3){ P.push(L.slice()); KO.push(K[V.length - 2]); } else P[P.length - 1] = L.slice();
  return {P: P, K: KO};
}
function linkRoute(I, C, o){
  o = o || {};
  var Ix = +I.x || 0, Iz = +I.z || 0, Cx = +C.x || 0, Cz = +C.z || 0, dx = Cx - Ix, dz = Cz - Iz, l = hyp(dx, dz) || 1;
  dx /= l; dz /= l;
  var seaI = I.sea != null ? +I.sea || 0 : seaLevelOf(I.W), seaC = C.sea != null ? +C.sea || 0 : seaLevelOf(C.W);
  var a = ilOf(I.W) || fallbackLeg(I.W, dx, dz, seaI), b = ilOf(C.W) || fallbackLeg(C.W, -dx, -dz, seaC);
  var V = [], KK = [], i;
  a.P.forEach(function(p, j){ V.push([p[0] + Ix, p[1], p[2] + Iz]); KK.push(a.K[Math.min(j, a.K.length - 1)]); });
  var iA = V.length - 1, ea = V[iA], bl = b.P[b.P.length - 1], eb = [bl[0] + Cx, bl[1], bl[2] + Cz];
  KK[iA] = K_SEA;
  // the sea crossing: a cubic leaving the abutment along its front and arriving along the junction's
  var fa = a.sea && a.sea.front ? a.sea.front : [dx, dz], fb = b.sea && b.sea.front ? b.sea.front : [-dx, -dz];
  var D = hyp(eb[0] - ea[0], eb[2] - ea[2]), kk = Math.min(600, D/3), n = Math.max(2, Math.ceil(D/STEP));
  // [3.36] an abutment facing away from the other end: the viaduct swings round its island offshore (past the coast's
  // furthest point) instead of curving back over the land and what stands on it (the airport)
  var wA = swingRound(Ix, Iz, ea, fa, Cx - Ix, Cz - Iz, coastR(I.W)), wB = swingRound(Cx, Cz, eb, fb, Ix - Cx, Iz - Cz, coastR(C.W)).reverse();
  if(wA.length || wB.length){
    var CP = [[ea[0] - fa[0]*kk, ea[2] - fa[1]*kk], [ea[0], ea[2]]].concat(wA, wB, [[eb[0], eb[2]], [eb[0] - fb[0]*kk, eb[2] - fb[1]*kk]]);
    for(var sg = 1; sg + 2 < CP.length; sg++){
      var q0 = CP[sg - 1], q1 = CP[sg], q2 = CP[sg + 1], q3 = CP[sg + 2], ns = Math.max(1, Math.ceil(hyp(q2[0] - q1[0], q2[1] - q1[1])/STEP));
      for(var si = (sg === 1 ? 1 : 0); si < ns; si++){
        var tt = si/ns, t2 = tt*tt, t3 = t2*tt;   // Catmull-Rom through the waypoints
        V.push([0.5*(2*q1[0] + (q2[0] - q0[0])*tt + (2*q0[0] - 5*q1[0] + 4*q2[0] - q3[0])*t2 + (3*q1[0] - q0[0] - 3*q2[0] + q3[0])*t3), NaN,
                0.5*(2*q1[1] + (q2[1] - q0[1])*tt + (2*q0[1] - 5*q1[1] + 4*q2[1] - q3[1])*t2 + (3*q1[1] - q0[1] - 3*q2[1] + q3[1])*t3)]); KK.push(K_SEA);
      }
    }
  } else {
    var p1 = [ea[0] + fa[0]*kk, ea[2] + fa[1]*kk], p2 = [eb[0] + fb[0]*kk, eb[2] + fb[1]*kk];
    for(i = 1; i < n; i++){
      var t = i/n, u = 1 - t, w0 = u*u*u, w1 = 3*u*u*t, w2 = 3*u*t*t, w3 = t*t*t;
      V.push([w0*ea[0] + w1*p1[0] + w2*p2[0] + w3*eb[0], NaN, w0*ea[2] + w1*p1[1] + w2*p2[1] + w3*eb[2]]); KK.push(K_SEA);
    }
  }
  var iB = V.length;
  for(var j = b.P.length - 1; j >= 0; j--){ var q = b.P[j]; V.push([q[0] + Cx, q[1], q[2] + Cz]); KK.push(j > 0 ? b.K[Math.min(j - 1, b.K.length - 1)] : K_GRADE); }
  // the sea viaduct's height: SEA_UP over the water, eased from and to the abutments at GRADE
  var S = [0];
  for(i = 1; i < V.length; i++) S.push(S[i - 1] + hyp(V[i][0] - V[i - 1][0], V[i][2] - V[i - 1][2]));
  var sA = S[iA], sB = S[iB], Ls = Math.max(1, sB - sA), ya = ea[1], yb = eb[1];
  var rA = Math.min(Ls/2, Math.abs(ya - (seaI + SEA_UP))/GRADE), rB = Math.min(Ls/2, Math.abs(yb - (seaC + SEA_UP))/GRADE);
  for(i = iA + 1; i < iB; i++){
    var ss = S[i] - sA, tg = seaI + (seaC - seaI)*ss/Ls + SEA_UP;
    var ea1 = rA > 0 ? Math.max(0, 1 - ss/rA) : 0, eb1 = rB > 0 ? Math.max(0, 1 - (Ls - ss)/rB) : 0;
    V[i][1] = tg + (ya - (seaI + SEA_UP))*ea1 + (yb - (seaC + SEA_UP))*eb1;
  }
  var RS = resample3(V, KK, STEP), P = RS.P, KO = RS.K, m = P.length;
  var s = new Float64Array(m);
  for(i = 1; i < m; i++) s[i] = s[i - 1] + hyp(P[i][0] - P[i - 1][0], P[i][2] - P[i - 1][2]);
  var len = s[m - 1];
  // the Commons' platform: the last stretch moved sideways onto its track (+ to the left of the way in), eased in over TAPER
  var plat = Math.max(1, Math.min(LINK_PLATS, (o.plat | 0) || 1)), off = o.plat ? (plat - (LINK_PLATS + 1)/2)*LINK_PLAT_GAP : 0;
  if(off){
    var hold = TRAIN_L + STOP_END + 20, Q = P.map(function(p){ return p.slice(); });
    for(i = 0; i < m; i++){
      var e = len - s[i], f = e <= hold ? 1 : Math.max(0, 1 - (e - hold)/TAPER);
      if(f <= 0) continue;
      var i0 = Math.max(0, i - 2), i1 = Math.min(m - 1, i + 2), tx = P[i1][0] - P[i0][0], tz = P[i1][2] - P[i0][2], tl = hyp(tx, tz) || 1;
      var g = off*f*f*(3 - 2*f);
      Q[i][0] = P[i][0] + tz/tl*g; Q[i][2] = P[i][2] - tx/tl*g;
    }
    P = Q;
    for(i = 1; i < m; i++) s[i] = s[i - 1] + hyp(P[i][0] - P[i - 1][0], P[i][2] - P[i - 1][2]);
    len = s[m - 1];
  }
  var pts = new Float64Array(3*m), k = new Uint8Array(m), seaA = 0, seaB = len;
  for(i = 0; i < m; i++){ pts[3*i] = P[i][0]; pts[3*i + 1] = P[i][1]; pts[3*i + 2] = P[i][2]; k[i] = KO[i]; }
  for(i = 0; i < m; i++) if(k[i] === K_SEA){ seaA = s[i]; break; }
  for(i = m - 1; i >= 0; i--) if(k[i] === K_SEA){ seaB = s[Math.min(m - 1, i + 1)]; break; }
  var R = {pts: pts, s: s, r: radii(P.map(function(p){ return [p[0], p[2]]; })), len: len, seaA: seaA, seaB: seaB, from: I.world, to: C.world,
           A: {x: Ix, z: Iz}, B: {x: Cx, z: Cz}, n: m, k: k, plat: plat};
  return timing(R);
}
function kAt(R, along){ return R.k ? R.k[idxAt(R, Math.max(0, Math.min(R.len, along)))] : K_GRADE; }
function underAt(R, along){ return !!R.k && R.k[idxAt(R, Math.max(0, Math.min(R.len, along)))] === K_TUNNEL; }

// the timetable: the same for both versions of an island's id
function linkOff(island, dir){ var o = hash("il:" + canon(island)) % LINK_EVERY; return dir === "in" ? (o + LINK_EVERY/2) % LINK_EVERY : o; }
function linkDepartures(island, dir, nowMs, back, ahead){
  var off = linkOff(island, dir), out = [], k0 = Math.floor((nowMs - (back || 0) - off)/LINK_EVERY), k1 = Math.ceil((nowMs + (ahead || 0) - off)/LINK_EVERY);
  for(var k = k0; k <= k1; k++){ var d = k*LINK_EVERY + off; if(d >= nowMs - (back || 0) && d <= nowMs + (ahead || 0)) out.push(d); }
  return out;
}
function linkNext(island, dir, ms){ var off = linkOff(island, dir); return Math.ceil((ms - off)/LINK_EVERY)*LINK_EVERY + off; }
// the Commons' platform (1..LINK_PLATS) for an island: its rank among `list` (the islands in view) by a hash of their ids,
// so each has its own until there are more than LINK_PLATS, then they share; no list: the hash alone
function linkPlatform(island, list){
  var c = canon(island), seen = {}, L = [];
  (list || []).forEach(function(w){ if(w == null || isCommonsId(w)) return; var k = canon(w); if(!seen[k]){ seen[k] = 1; L.push(k); } });
  L.sort(function(a, b){ var ha = hash("ilp:" + a), hb = hash("ilp:" + b); return ha - hb || (a < b ? -1 : a > b ? 1 : 0); });
  var i = L.indexOf(c);
  return (i < 0 ? hash("ilp:" + c) : i) % LINK_PLATS + 1;
}
// where you step off at a world's IL platform (its own frame): on the platform beside the train, facing it
function linkSpawn(W, world, island, list){
  var a = ilOf(W);
  if(!a || !a.station){
    var st0 = W ? stationOf(W) : null;
    if(!st0) return null;
    var d = doorOf(st0);
    return {world: world, site: st0.id, x: d.x, y: (st0.y || 0)/100, z: d.z, yaw: d.yaw, under: false};
  }
  var st = a.station, P = a.P, fx = P[1][0] - P[0][0], fz = P[1][2] - P[0][2], fl = hyp(fx, fz) || 1;
  fx /= fl; fz /= fl;                                                       // the way out of the station
  var off = 0;
  if(isCommonsId(world) && island) off = -(linkPlatform(island, list) - (LINK_PLATS + 1)/2)*LINK_PLAT_GAP;   // linkRoute's (+ left of the way in)
  var lx = fz, lz = -fx, side = 2.7;                                        // left of the way out; the platform on its right
  var x = st.x + lx*off - lx*side, z = st.z + lz*off - lz*side;
  return {world: world, site: st.id, x: x, y: st.y + PLAT_TOP, z: z, yaw: Math.atan2(lx, lz), under: st.kind === "underground"};
}

// the Service for the world you are in. o = {here (world id), W (its packed world), arch (GET /v1/archipelago: {commons:
// {x, z}, islands: [{world, x, z, name?}]}, cm), docs ({worldId: packed world or raw doc}: the far ends, when loaded),
// islands (ids: on the Commons the lines to run; default every island in arch), names ({worldId: name}), seed}
function linkService(o){
  o = o || {};
  var here = String(o.here || o.world || ""), W = o.W || null, arch = o.arch || {}, docs = o.docs || {}, isC = isCommonsId(here);
  var v = verOf(here) || 3, commons = isC ? here : asVersion(commonsId(), v), names = o.names || {};
  var archIs = (Array.isArray(arch.islands) ? arch.islands : []).filter(function(x){ return x && WORLD_RE.test(String(asVersion(x.world, v))); });
  var platList = archIs.map(function(x){ return x.world; });
  var want = isC ? (o.islands || platList) : [here], seen = {}, islands = [];
  want.forEach(function(w){ w = asVersion(w, v); if(!WORLD_RE.test(w) || isCommonsId(w) || seen[canon(w)]) return; seen[canon(w)] = 1; islands.push(w); });
  islands.sort();
  if(!platList.length) platList = islands.slice();
  function docOf(w){
    if(sameWorld(w, here)) return W;
    for(var k in docs) if(Object.prototype.hasOwnProperty.call(docs, k) && sameWorld(k, w)) return docs[k];
    return null;
  }
  function pos(w){
    var h = isCommonsId(w) ? arch.commons : archIs.filter(function(x){ return sameWorld(x.world, w); })[0];
    if(h && isFinite(+h.x) && isFinite(+h.z)) return {x: (+h.x || 0)/100, z: (+h.z || 0)/100};
    return isCommonsId(w) ? {x: 0, z: 0} : null;
  }
  function nameOf(w){
    if(isCommonsId(w)) return "The Commons";
    for(var k in names) if(Object.prototype.hasOwnProperty.call(names, k) && sameWorld(k, w)) return String(names[k]);
    var h = archIs.filter(function(x){ return sameWorld(x.world, w); })[0];
    return h && h.name ? String(h.name) : "the island";
  }
  var hp = pos(here) || {x: 0, z: 0}, routes = {};
  function route(iw){
    var key = canon(iw);
    if(routes[key] !== undefined) return routes[key];
    var ip = pos(iw), cp = pos(commons);
    if(!ip || !cp){ routes[key] = null; return null; }
    var plat = linkPlatform(iw, platList);
    var R = linkRoute({world: iw, x: ip.x, z: ip.z, W: docOf(iw)}, {world: commons, x: cp.x, z: cp.z, W: docOf(commons)}, {plat: plat});
    routes[key] = {out: R, "in": reverse(R), plat: plat};
    return routes[key];
  }
  var localId = "il:" + here, mine = ilOf(W), RN = HQV.hqRide;
  var localName = isC ? "Commons Central" : (RN && RN.stationName && W && mine && mine.station ? RN.stationName(W, mine.station.x, mine.station.z, "rail") : "Central");
  var LINES = [], FAR = {};
  islands.forEach(function(iw){
    var rt = route(iw);
    if(!rt) return;
    var far = isC ? iw : commons, id = "IL:" + canon(iw), R = isC ? rt["in"] : rt.out, e = at(R, R.len - TRAIN_L/2 - STOP_END);
    FAR[id] = {id: "il:" + far, name: isC ? nameOf(iw) : "Commons Central", world: far, x: e.x - hp.x, y: e.y + PLAT_TOP, z: e.z - hp.z,
               under: !isC ? false : true, mode: "link", lines: [id], kind: "station"};
    LINES.push({id: id, mode: "link", name: "Island Link to " + (isC ? nameOf(iw) : "the Commons"), short: "IL", color: LINK_COLOR,
                stops: [localId, FAR[id].id], headway: LINK_EVERY/1000, loop: false, world: far, island: iw, plat: isC ? rt.plat : 1});
  });
  var L0 = LINES[0], st0 = mine && mine.station;
  var local = {id: localId, name: localName, mode: "link", lines: LINES.map(function(l){ return l.id; }), kind: "station",
               x: st0 ? st0.x : 0, y: st0 ? st0.y + PLAT_TOP : 0, z: st0 ? st0.z : 0, under: st0 ? st0.kind === "underground" : false};
  if(!st0 && L0){ var rt0 = route(L0.island), R0 = isC ? rt0["in"] : rt0.out, p0 = at(R0, TRAIN_L/2 + STOP_END); local.x = p0.x - hp.x; local.y = p0.y + PLAT_TOP; local.z = p0.z - hp.z; }
  var dir = isC ? "in" : "out";
  function lineById(id){ return LINES.filter(function(l){ return l.id === id; })[0] || null; }
  function routeOf(l, d){ var rt = route(l.island); return rt ? rt[d] : null; }
  function stopsAll(){ var out = [local]; LINES.forEach(function(l){ out.push(FAR[l.id]); }); return out; }
  // a train on a route t s after leaving: its middle (local frame, or minus `frame` {x, z}), the floor's height
  function mid(R, t, fr){
    var hd = poseAt(R, t), p = at(R, hd.along - TRAIN_L/2), f = fr || hp;
    return {x: p.x - f.x, y: p.y + PLAT_TOP, z: p.z - f.z, yaw: p.yaw, pitch: p.pitch, speed: hd.speed, along: hd.along, head: hd, under: underAt(R, hd.along - TRAIN_L/2)};
  }
  function doorsAt(R, t){ return t <= -2 && t >= -DWELL ? 1 : t < 0 && t > -2 ? -t/2 : t >= R.T && t <= R.T + DWELL ? 1 : 0; }
  function makeTrip(l, dep){
    var R = routeOf(l, dir); if(!R) return null;
    var far = FAR[l.id], fp = pos(far.world) || hp, T = R.T, shift = {x: fp.x - hp.x, z: fp.z - hp.z};
    var trip = {mode: "link", line: l.id, short: "IL", vehicle: l.id + ":" + dir + ":" + dep, from: localId, to: far.id,
      fromName: local.name, toName: far.name, arrive: dep - DWELL*1000, depart: dep, reach: Math.round(dep + T*1000), hand: Math.round(dep + R.hand*1000),
      stops: [{id: localId, name: local.name, at: dep}, {id: far.id, name: far.name, at: Math.round(dep + T*1000)}],
      seats: SEATS.length, standing: STAND.length, seatMeta: SEATS, world: far.world, from_world: here, shift: shift, plat: l.plat, R: R,
      // the floor's centre (the middle car's floor); frame "to": in the destination's frame
      pose: function(ms, frame){
        var t = ((+ms || 0) - dep)/1000, p = mid(R, t, frame === "to" ? fp : hp);
        return {x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, speed: p.speed, doors: doorsAt(R, t), under: p.under, done: t >= T,
                leg: p.head.leg, u: p.head.u};
      },
      seat: function(i, ms, frame){
        i = Math.max(0, i | 0);
        var S0 = i < SEATS.length ? SEATS[i] : STAND[Math.min(STAND.length - 1, i - SEATS.length)], t = ((+ms || 0) - dep)/1000, hd = poseAt(R, t);
        var p = at(R, hd.along - S0.car*(CAR_L + CAR_GAP) - CAR_L/2), f = frame === "to" ? fp : hp, c = Math.cos(p.yaw), sn = Math.sin(p.yaw);
        return {x: p.x - f.x + c*S0.x + sn*S0.z, y: p.y + PLAT_TOP + S0.y, z: p.z - f.z - sn*S0.x + c*S0.z, yaw: p.yaw + (S0.back ? Math.PI : 0),
                car: S0.car, stand: i >= SEATS.length};
      },
      // the right-hand front door of the second car (the platform side)
      door: function(ms, frame){
        var t = ((+ms || 0) - dep)/1000, hd = poseAt(R, t), p = at(R, hd.along - (CAR_L + CAR_GAP) - CAR_L/2 + DOOR_Z), f = frame === "to" ? fp : hp;
        return {x: p.x - f.x - Math.cos(p.yaw)*1.5, z: p.z - f.z + Math.sin(p.yaw)*1.5};
      }};
    return trip;
  }
  var sim = {
    mode: "link", here: here, commons: commons,
    lines: function(){ return LINES.map(function(l){ var c = {}; for(var k in l) c[k] = l[k]; c.stops = l.stops.slice(); return c; }); },
    stops: function(){ return stopsAll().map(function(s){ var c = {}; for(var k in s) c[k] = s[k]; c.lines = s.lines.slice(); return c; }); },
    stopsNear: function(x, z, r){
      return stopsAll().map(function(s){ return {id: s.id, name: s.name, dist: hyp(s.x - x, s.z - z), mode: "link", lines: s.lines.slice()}; })
        .filter(function(s){ return s.dist <= r; }).sort(function(a, b){ return a.dist - b.dist || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
    },
    departures: function(stopId, ms, n){
      if(stopId !== localId) return [];
      n = Math.max(1, (n | 0) || 4);
      var rows = [];
      LINES.forEach(function(l){
        linkDepartures(l.island, dir, ms, 0, LINK_EVERY*n).forEach(function(d){
          rows.push({line: l.id, short: "IL", to: FAR[l.id].name, at: d, plat: String(l.plat), boarding: ms >= d - DWELL*1000 && ms < d, delay: 0});
        });
      });
      rows.sort(function(a, b){ return a.at - b.at || (a.line < b.line ? -1 : 1); });
      return rows.slice(0, n);
    },
    trip: function(lineId, fromStop, toStop, ms){
      var l = lineById(lineId);
      if(!l || fromStop !== localId || toStop !== FAR[l.id].id) return null;
      return makeTrip(l, linkNext(l.island, dir, +ms || 0));
    },
    // every train on the lines here, both ways, standing at a platform DWELL s either side of the run
    vehicles: function(ms){
      var out = [], C = HQV.hqCommute;
      LINES.forEach(function(l){
        ["out", "in"].forEach(function(d){
          var R = routeOf(l, d); if(!R) return;
          linkDepartures(l.island, d, ms, (R.T + DWELL)*1000, DWELL*1000).forEach(function(dep){
            var t = (ms - dep)/1000; if(t < -DWELL || t > R.T + DWELL) return;
            var p = mid(R, t), id = l.id + ":" + d + ":" + dep;
            out.push({id: id, line: l.id, mode: "link", x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, speed: p.speed, doors: doorsAt(R, t),
                      load: C && C.load ? C.load("link", l.id, id, ms, o.seed != null ? o.seed : here) : 0.5, under: p.under, along: p.head.along, dir: d, dep: dep});
          });
        });
      });
      return out;
    },
    route: function(lineId, d){ var l = lineById(lineId); return l ? routeOf(l, d || dir) : null; },
    origin: function(){ return {x: hp.x, z: hp.z}; },
    spawn: function(){ return linkSpawn(W, here, isC ? null : here, platList); }
  };
  return sim;
}
function link(islandWorld, o){ o = o || {}; var c = {}; for(var k in o) c[k] = o[k]; if(isCommonsId(c.here || c.world)) c.islands = [islandWorld]; else c.here = c.here || islandWorld; return linkService(c); }

HQV.hqRail = {alignment: alignment, reverse: reverse, poseAt: poseAt, at: at, departures: departures, nextDeparture: nextDeparture, lineKey: lineKey,
  linesAt: linesAt, built: built, menuRows: menuRows, lanes: lanes, LANE: LANE, stationOf: stationOf, doorOf: doorOf, cityLeg: cityLeg, coastExit: coastExit,
  simplify: simplify, EVERY: EVERY, DWELL: DWELL, DECK_UP: DECK_UP, SEA_UP: SEA_UP, GRADE: GRADE, CAR_L: CAR_L,
  CAR_GAP: CAR_GAP, CARS: CARS, TRAIN_L: TRAIN_L, PLAT: PLAT, COST: COST, CITY_V: CITY_V, SEA_V: SEA_V, ACC: ACC, CUT: CUT,
  PLAT_TOP: 0.95, STEP: STEP, STOP_END: STOP_END,
  // live ids
  commonsId: commonsId, isCommonsId: isCommonsId, canon: canon, sameWorld: sameWorld, islandIdOf: islandIdOf, WORLD_RE: WORLD_RE,
  // the Island Link
  link: link, linkService: linkService, linkRoute: linkRoute, linkSpawn: linkSpawn, linkDepartures: linkDepartures, linkNext: linkNext,
  linkPlatform: linkPlatform, linkOff: linkOff, railView: railView, ilOf: ilOf, underAt: underAt, kAt: kAt, timing: timing, radii: radii,
  SEATS: SEATS, STAND: STAND, SEAT_UP: SEAT_UP, DOOR_Z: DOOR_Z, LINK_EVERY: LINK_EVERY, LINK_PLATS: LINK_PLATS, LINK_COLOR: LINK_COLOR,
  K: {GRADE: K_GRADE, TUNNEL: K_TUNNEL, PORTAL: K_PORTAL, VIADUCT: K_VIADUCT, BRIDGE: K_BRIDGE, SEA: K_SEA}};
/* ---------- drawing (THREE): the viaduct, the track, the stations' platforms, the trains, their passengers ----------
   Everything repetitive is instanced or merged: per line the deck, rails, wire, platforms and canopies are one
   extruded mesh each, the piers, caps, sleepers, masts, arms, posts, steps and people one InstancedMesh each; a
   train is four cars of five merged meshes. */
var DRAW_R = 2600;           // m: a city draws the track this near its centre (the rest is far behind the haze)
var PIER_EVERY = 25, SLEEPER_EVERY = 0.65, MAST_EVERY = 50;
var DECK = [[-3.85, 0.55], [-3.6, 0.55], [-3.6, -0.35], [3.6, -0.35], [3.6, 0.55], [3.85, 0.55], [3.85, -0.9], [2.3, -1.9], [-2.3, -1.9], [-3.85, -0.9]];

function merge(THREE, parts){
  var pos = [], nor = [];
  parts.forEach(function(p){
    var g = p[0].index ? p[0].toNonIndexed() : p[0].clone();
    g.applyMatrix4(p[1]);
    if(!g.attributes.normal) g.computeVertexNormals();
    var a = g.attributes.position.array, n = g.attributes.normal.array;
    for(var i = 0; i < a.length; i++){ pos.push(a[i]); nor.push(n[i]); }
    g.dispose();
  });
  var out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  out.computeBoundingSphere();
  return out;
}
// a standing (or seated) resident: body and head in one geometry, feet at 0
function figureGeo(THREE, seated){
  var m = new THREE.Matrix4(), parts = [];
  var body = new THREE.CylinderGeometry(0.2, 0.24, seated ? 0.8 : 1.3, 8);
  parts.push([body, m.clone().makeTranslation(0, seated ? 0.85 : 0.65, 0)]);
  parts.push([new THREE.SphereGeometry(0.17, 10, 8), m.clone().makeTranslation(0, seated ? 1.4 : 1.48, 0)]);
  if(seated){ var lap = new THREE.BoxGeometry(0.42, 0.18, 0.5); parts.push([lap, m.clone().makeTranslation(0, 0.5, 0.2)]); }
  return merge(THREE, parts);
}
// [x, y, z, yaw] samples of R from s = a to b every `step` m (local frame: minus o), and their pitch
function samples(R, a, b, step, o){
  var out = [];
  for(var s = Math.max(0, a); s <= Math.min(R.len, b) + 1e-6; s += step){ var p = at(R, s); out.push({s: s, x: p.x - o.x, y: p.y, z: p.z - o.z, yaw: p.yaw, pitch: p.pitch}); }
  return out;
}
// extrude a closed profile ([[lateral (+ left), up], ...], relative to the rail head) along samples: flat normals
function extrude(THREE, S, prof, closed){
  var pos = [], E = closed ? prof.length : prof.length - 1;
  function v(p, q){ var c = Math.cos(p.yaw), s = Math.sin(p.yaw); return [p.x + c*q[0], p.y + q[1], p.z - s*q[0]]; }
  for(var i = 0; i < S.length - 1; i++){
    var A = S[i], B = S[i + 1];
    for(var k = 0; k < E; k++){
      var q0 = prof[k], q1 = prof[(k + 1) % prof.length];
      var a0 = v(A, q0), a1 = v(A, q1), b0 = v(B, q0), b1 = v(B, q1);
      pos.push(a0[0], a0[1], a0[2], b0[0], b0[1], b0[2], b1[0], b1[1], b1[2], a0[0], a0[1], a0[2], b1[0], b1[1], b1[2], a1[0], a1[1], a1[2]);
    }
  }
  var g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}
function materials(c){
  var THREE = c.THREE;
  return {
    concrete: c.mat(0xb9bcbf, {roughness: 0.92, side: THREE.DoubleSide}),
    steel: c.mat(0x6f7882, {roughness: 0.35, metalness: 0.8, side: THREE.DoubleSide}),
    sleeper: c.mat(0x8d8a84, {roughness: 0.95}),
    wire: c.mat(0x2b2f33, {roughness: 0.5, metalness: 0.6, side: THREE.DoubleSide}),
    pier: c.mat(0xa9adb1, {roughness: 0.9}),
    platform: c.mat(0xcfc9bd, {roughness: 0.85, side: THREE.DoubleSide}),
    edge: c.mat(0xf2c230, {roughness: 0.6, side: THREE.DoubleSide}),
    canopy: c.mat(0xe7edf2, {roughness: 0.4, metalness: 0.2, side: THREE.DoubleSide, emissive: new THREE.Color(0xfff2d0), emissiveIntensity: 0}),
    post: c.mat(0x3d5566, {roughness: 0.4, metalness: 0.6}),
    people: c.mat(0xffffff, {roughness: 0.8}),
    body: c.mat(0xeef1f4, {roughness: 0.3, metalness: 0.35}),
    accent: c.mat(0x0e8fb0, {roughness: 0.4, metalness: 0.3}),
    dark: c.mat(0x22282e, {roughness: 0.6, metalness: 0.4}),
    glass: c.mat(0x18222c, {roughness: 0.1, metalness: 0.5, transparent: true, opacity: 0.62, emissive: new THREE.Color(0xffd9a0), emissiveIntensity: 0}),
    lamp: c.mat(0xffffff, {emissive: new THREE.Color(0xfff6dd), emissiveIntensity: 1.6})
  };
}
var PEOPLE = [0xd9534f, 0x4a7bd1, 0x3fa66a, 0xe8b730, 0x8a4ad1, 0x2b3a48, 0xf28c28, 0x6bb6c9, 0xc06c84, 0x7d6b5a];

// One car: {g, glass} at the rail head (origin), forward +z; nose: the front end is a cab (+1) or the back is (-1)
function carModel(c, M, nose, pant, seed){
  var THREE = c.THREE, m4 = new THREE.Matrix4(), by = {body: [], accent: [], dark: [], glass: [], lamp: []}, L = CAR_L, H0 = PLAT_TOP - 0.1, H = 3.0;
  function box(k, w, h, d, x, y, z){ by[k].push([new THREE.BoxGeometry(w, h, d), m4.clone().makeTranslation(x, y, z)]); }
  var bodyL = nose ? L - 2.6 : L, bz = nose ? -nose*1.3 : 0;
  box("body", 2.9, H, bodyL, 0, H0 + H/2, bz);
  if(nose){
    // the cab's nose: a box whose top front edge is swept back and down
    var g = new THREE.BoxGeometry(2.9, H, 2.6), P = g.attributes.position;
    for(var i = 0; i < P.count; i++){
      var zz = P.getZ(i)*nose, yy = P.getY(i);
      if(zz > 0 && yy > 0){ P.setZ(i, P.getZ(i) - nose*2.1); P.setY(i, yy - 0.45); }
      if(zz > 0 && yy < 0) P.setX(i, P.getX(i)*0.86);
    }
    g.computeVertexNormals();
    by.body.push([g, m4.clone().makeTranslation(0, H0 + H/2, nose*(L/2 - 1.3))]);
    box("glass", 2.5, 1.0, 0.1, 0, H0 + 2.35, nose*(L/2 - 1.55));
    box("lamp", 0.4, 0.16, 0.08, 0.95, H0 + 0.75, nose*(L/2 - 0.02));
    box("lamp", 0.4, 0.16, 0.08, -0.95, H0 + 0.75, nose*(L/2 - 0.02));
  }
  box("glass", 2.96, 0.95, bodyL - 1.6, 0, H0 + 2.15, bz);                    // the window band, both sides
  box("accent", 2.94, 0.28, L - 0.6, 0, H0 + 1.15, 0);                         // the line's stripe
  [-1, 1].forEach(function(e){ box("accent", 2.98, 2.15, 1.3, 0, H0 + 1.15, e*L*0.22); });   // the doors
  box("dark", 2.5, 0.25, L - 1.2, 0, H0 + H + 0.12, 0);                         // the roof's equipment line
  [-1, 1].forEach(function(e){ box("dark", 2.3, 0.75, 2.6, 0, 0.45, e*(L/2 - 3.2)); });      // the bogies
  box("dark", 2.7, 0.35, L - 7.5, 0, H0 - 0.15, 0);                             // the underframe
  if(pant){ box("dark", 0.08, 1.3, 0.08, 0, H0 + H + 0.8, -1); box("dark", 1.6, 0.06, 0.25, 0, H0 + H + 1.45, -0.4); }
  var g2 = new THREE.Group();
  Object.keys(by).forEach(function(k){ if(!by[k].length) return; var mesh = new THREE.Mesh(merge(THREE, by[k]), M[k]); mesh.castShadow = k === "body"; g2.add(mesh); });
  // the passengers: seated by the windows, a few a car
  var n = 4 + (seed % 3), F = new THREE.InstancedMesh(M.seatedGeo, M.people, n), q = new THREE.Quaternion(), col = new THREE.Color();
  for(var j = 0; j < n; j++){
    var side = j % 2 ? 1 : -1, z = -L/2 + 2.6 + (j >> 1)*(L - 5.2)/Math.max(1, (n >> 1) - 0.5) + (seed*7 % 3)*0.3;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (j + seed) % 3 === 0 ? Math.PI : 0);
    F.setMatrixAt(j, m4.compose(new THREE.Vector3(side*0.95, H0 + 0.05, z), q, new THREE.Vector3(1, 1, 1)));
    F.setColorAt(j, col.setHex(PEOPLE[(seed*3 + j*5) % PEOPLE.length]));
  }
  g2.add(F);
  return g2;
}
// a train: four cars, a cab at each end, the pantograph on the second
function trainModel(c, M, seed){
  var THREE = c.THREE, g = new THREE.Group(), cars = [];
  for(var k = 0; k < CARS; k++){ var car = carModel(c, M, k === 0 ? 1 : k === CARS - 1 ? -1 : 0, k === 1, seed + k); g.add(car); cars.push(car); }
  return {g: g, cars: cars};
}
// the cars along R with the head at `head` (m along), in the frame minus o
function placeTrain(T, R, head, o){
  for(var k = 0; k < T.cars.length; k++){
    var p = at(R, head - k*(CAR_L + CAR_GAP) - CAR_L/2), car = T.cars[k];
    car.position.set(p.x - o.x, p.y, p.z - o.z);
    car.rotation.set(-p.pitch, p.yaw, 0, "YXZ");
  }
  T.g.visible = true;
}

// One built line drawn in a city: R runs from this city (or to it); o: the city's archipelago position (m);
// ends: which of R's ends are this city's stations ([0] and/or [R.len]); ground(x, z), seaY, door (its station's
// door, local m): where its stairs come down
function lineView(c, M, R, o, ends, ground, seaY, door, lane){
  var THREE = c.THREE, g = new THREE.Group(); g.name = "rail:line";
  // the stretch within DRAW_R of this city's centre
  var a = 0, b = R.len, first = true;
  for(var s = 0; s <= R.len; s += 20){ var p = at(R, s), near = hyp(p.x - o.x, p.z - o.z) < DRAW_R; if(near && first){ a = s; first = false; } if(near) b = s; }
  b = Math.min(R.len, b + 20);
  var S = samples(R, a, b, 4, o);
  function add(geo, m, shadow){ var mesh = new THREE.Mesh(geo, m); mesh.receiveShadow = true; mesh.castShadow = !!shadow; g.add(mesh); return mesh; }
  add(extrude(THREE, S, DECK, true), M.concrete, true);
  var rails = [];
  [-0.75, 0.75].forEach(function(l){ rails.push([l - 0.04, 0], [l + 0.04, 0], [l + 0.04, -0.17], [l - 0.04, -0.17]); });
  add(merge(THREE, [[extrude(THREE, S, rails.slice(0, 4), true), new THREE.Matrix4()], [extrude(THREE, S, rails.slice(4), true), new THREE.Matrix4()]]), M.steel);
  add(extrude(THREE, S, [[-0.02, 5.6], [0.02, 5.6], [0.02, 5.55], [-0.02, 5.55]], true), M.wire);
  var m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), v = new THREE.Vector3(), sc = new THREE.Vector3();
  function inst(geo, m, list, fn){
    if(!list.length) return null;
    var I = new THREE.InstancedMesh(geo, m, list.length);
    list.forEach(function(x, i){ fn(x); I.setMatrixAt(i, m4.compose(v, q, sc)); });
    I.castShadow = false; I.receiveShadow = true; g.add(I); return I;
  }
  function lat(p, l){ return {x: p.x + Math.cos(p.yaw)*l, z: p.z - Math.sin(p.yaw)*l}; }
  // piers every PIER_EVERY m down to the ground (or into the sea), their caps under the deck
  var piers = samples(R, Math.ceil(a/PIER_EVERY)*PIER_EVERY, b, PIER_EVERY, o).filter(function(p){ return p.s > 3 && p.s < R.len - 3; });
  var pg = new THREE.CylinderGeometry(0.85, 1.05, 1, 12); pg.translate(0, 0.5, 0);
  inst(pg, M.pier, piers, function(p){
    var gy = ground(p.x, p.z); if(!isFinite(gy) || gy < seaY - 0.2) gy = seaY - 6;
    v.set(p.x, gy, p.z); q.setFromAxisAngle(up, p.yaw); sc.set(1, Math.max(0.5, p.y - 1.9 - gy), 1);
  });
  inst(new THREE.BoxGeometry(5.4, 0.9, 2.4), M.pier, piers, function(p){ v.set(p.x, p.y - 2.3, p.z); q.setFromAxisAngle(up, p.yaw); sc.set(1, 1, 1); });
  // sleepers
  inst(new THREE.BoxGeometry(2.5, 0.15, 0.24), M.sleeper, samples(R, a, b, SLEEPER_EVERY, o), function(p){
    v.set(p.x, p.y - 0.26, p.z); q.setFromAxisAngle(up, p.yaw); sc.set(1, 1, 1);
  });
  // catenary masts on the left, their arms over the track
  var masts = samples(R, Math.ceil(a/MAST_EVERY)*MAST_EVERY + 12, b, MAST_EVERY, o);
  var mg = new THREE.CylinderGeometry(0.12, 0.14, 6.4, 8); mg.translate(0, 3.2, 0);
  inst(mg, M.post, masts, function(p){ var w2 = lat(p, 3.35); v.set(w2.x, p.y + 0.5, w2.z); q.setFromAxisAngle(up, p.yaw); sc.set(1, 1, 1); });
  inst(new THREE.BoxGeometry(3.6, 0.1, 0.1), M.post, masts, function(p){ var w2 = lat(p, 1.6); v.set(w2.x, p.y + 5.75, w2.z); q.setFromAxisAngle(up, p.yaw); sc.set(1, 1, 1); });
  // the platforms at this city's ends: a slab each side, canopies, posts, stairs down by the station's door, people
  var steps = [], posts = [], folk = [];
  ends.forEach(function(e){
    var s0 = e === 0 ? 0 : R.len - PLAT, s1 = s0 + PLAT, P = samples(R, s0, s1, 4, o);
    if(P.length < 2) return;
    var slab = [], edge = [], roof = [];
    // a side (sd: + is the right of increasing s) with a line beside it: the island platform between them is the
    // neighbour's when it is on our left (drawn once), and no stairs land on it
    function nb(sd){ var left = e === 0 ? sd < 0 : sd > 0; return !!lane && (left ? lane.left : lane.right); }
    function mineSide(sd){ var left = e === 0 ? sd < 0 : sd > 0; return !(left && lane && lane.left); }
    [-1, 1].forEach(function(sd){
      edge.push([extrude(THREE, P, [[sd*2.05, PLAT_TOP + 0.01], [sd*2.4, PLAT_TOP + 0.01]], false), new THREE.Matrix4()]);
      if(!mineSide(sd)) return;
      var w0 = sd*2.05, w1 = sd*5.6;
      slab.push([extrude(THREE, P, [[w0, PLAT_TOP], [w1, PLAT_TOP], [w1, -1.4], [w0, -1.4]], true), new THREE.Matrix4()]);
      roof.push([extrude(THREE, P, [[sd*2.3, 4.7], [sd*6.1, 4.45], [sd*6.1, 4.3], [sd*2.3, 4.55]], true), new THREE.Matrix4()]);
    });
    add(merge(THREE, slab), M.platform, true); add(merge(THREE, edge), M.edge); add(merge(THREE, roof), M.canopy, true);
    P.forEach(function(p, i){ if(i % 3 === 1) [-1, 1].forEach(function(sd){ if(mineSide(sd)) posts.push({p: p, l: sd*5.2}); }); });
    // people waiting, the same on every client
    var h = hash(R.from + R.to + e) >>> 0;
    for(var k = 0; k < 9; k++){
      h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
      var sp = s0 + 6 + (h % 1000)/1000*(PLAT - 12), side = (h >> 11) & 1 ? 1 : -1, pp = at(R, sp), off = side*(2.9 + ((h >> 13) % 100)/100*2.2);
      folk.push({x: pp.x - o.x + Math.cos(pp.yaw)*off, y: pp.y + PLAT_TOP, z: pp.z - o.z - Math.sin(pp.yaw)*off, yaw: pp.yaw + (side > 0 ? -Math.PI/2 : Math.PI/2) + ((h >> 5) % 60 - 30)/60, c: PEOPLE[(h >> 7) % PEOPLE.length]});
    }
    // the stairs: a straight flight beside the platform on the door's side, landing at its middle
    var pm = at(R, (s0 + s1)/2), dl = door ? (door.x - (pm.x - o.x))*Math.cos(pm.yaw) - (door.z - (pm.z - o.z))*Math.sin(pm.yaw) : 1;
    var sd2 = dl >= 0 ? 1 : -1;
    if(nb(sd2)) sd2 = -sd2;
    if(nb(sd2)) return;                                           // between two lines: reached across the island platforms
    var mid = lat({x: pm.x - o.x, z: pm.z - o.z, yaw: pm.yaw}, sd2*7.0);
    var gy = ground(mid.x, mid.z); if(!isFinite(gy)) gy = 0;
    var top = pm.y + PLAT_TOP, hgt = Math.max(1, top - gy), n = Math.ceil(hgt/0.19), run = n*0.29, fx = Math.sin(pm.yaw), fz = Math.cos(pm.yaw);
    var dir = e === 0 ? -1 : 1;                                   // down toward the station end of the platform
    for(var j = 0; j < n; j++){
      var u = (j + 0.5)/n;
      steps.push({x: mid.x + fx*dir*run*u, y: top - hgt*u, z: mid.z + fz*dir*run*u, yaw: pm.yaw});
    }
    // the landing joining the flight to the platform, and the flight's side walls as one tilted slab
    var land = lat({x: pm.x - o.x, z: pm.z - o.z, yaw: pm.yaw}, sd2*6.3);
    var lg = new THREE.BoxGeometry(1.6, 0.3, 2.6), lm = new THREE.Mesh(lg, M.platform);
    lm.position.set(land.x, top - 0.15, land.z); lm.rotation.y = pm.yaw; g.add(lm);
    var sl = Math.hypot(run, hgt), wall = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.4, sl), M.concrete);
    wall.position.set(mid.x + fx*dir*run/2, top - hgt/2 - 0.25, mid.z + fz*dir*run/2);
    wall.rotation.set(dir*Math.atan2(hgt, run), pm.yaw, 0, "YXZ"); g.add(wall);
  });
  inst(new THREE.BoxGeometry(2.4, 0.19, 0.31), M.platform, steps, function(p){ v.set(p.x, p.y, p.z); q.setFromAxisAngle(up, p.yaw); sc.set(1, 1, 1); });
  var cg = new THREE.CylinderGeometry(0.09, 0.09, 3.6, 8); cg.translate(0, 1.8, 0);
  inst(cg, M.post, posts, function(x){ var w2 = lat(x.p, x.l); v.set(w2.x, x.p.y + PLAT_TOP, w2.z); q.setFromAxisAngle(up, x.p.yaw); sc.set(1, 1, 1); });
  var FI = inst(M.standGeo, M.people, folk, function(f){ v.set(f.x, f.y, f.z); q.setFromAxisAngle(up, f.yaw); sc.set(1, 1, 1); });
  if(FI){ var col = new THREE.Color(); folk.forEach(function(f, i){ FI.setColorAt(i, col.setHex(f.c)); }); }
  return {g: g, a: a, b: b, dispose: function(){
    g.traverse(function(x){ if(x.geometry && x.geometry !== M.standGeo && x.geometry !== M.seatedGeo) x.geometry.dispose(); });
  }};
}

/* ---------- a kit for few draw calls (Island Link, City Line, gondola): merged vertex-coloured statics, instanced
   trains (two calls for every train in view: cab cars and middle cars, windows in the vertex colours, warm at
   night), one call for a focused train's interior (unit boxes with instance colours) and one for its faint shell,
   one for seated commuters (HQV.hqCommute's figures) ---------- */
function kit(THREE){
  function col(hex){ return new THREE.Color(hex); }
  // a non-indexed geometry with a colour attribute, uv dropped (so every part merges)
  function paint(geo, hex){
    var g = geo.index ? geo.toNonIndexed() : geo;
    if(g !== geo) geo.dispose();
    if(!g.attributes.normal) g.computeVertexNormals();
    var c = col(hex), n = g.attributes.position.count, a = new Float32Array(3*n);
    for(var i = 0; i < n; i++){ a[3*i] = c.r; a[3*i + 1] = c.g; a[3*i + 2] = c.b; }
    g.setAttribute("color", new THREE.BufferAttribute(a, 3));
    return g;
  }
  function box(w, h, d, x, y, z, hex, ry, rx){
    var g = new THREE.BoxGeometry(w, h, d);
    if(rx) g.rotateX(rx);
    if(ry) g.rotateY(ry);
    g.translate(x, y, z);
    return paint(g, hex);
  }
  function cyl(rt, rb, h, seg, x, y, z, hex){ var g = new THREE.CylinderGeometry(rt, rb, h, seg || 10); g.translate(x, y + h/2, z); return paint(g, hex); }
  // a segment between two points as a thin box (wires, ropes, braces)
  function strut(a, b, w, hex){
    var dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], L = Math.sqrt(dx*dx + dy*dy + dz*dz) || 0.01;
    var g = new THREE.BoxGeometry(w, w, L), m = new THREE.Matrix4(), q = new THREE.Quaternion();
    q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(dx/L, dy/L, dz/L));
    m.compose(new THREE.Vector3((a[0] + b[0])/2, (a[1] + b[1])/2, (a[2] + b[2])/2), q, new THREE.Vector3(1, 1, 1));
    g.applyMatrix4(m);
    return paint(g, hex);
  }
  function xform(g, m){ g.applyMatrix4(m); return g; }
  function mergeC(list){
    var n = 0; list.forEach(function(g){ if(g) n += g.attributes.position.count; });
    var P = new Float32Array(3*n), N = new Float32Array(3*n), C = new Float32Array(3*n), o = 0;
    list.forEach(function(g){
      if(!g) return;
      P.set(g.attributes.position.array, o); N.set(g.attributes.normal.array, o); C.set(g.attributes.color.array, o);
      o += g.attributes.position.count*3; g.dispose();
    });
    var out = new THREE.BufferGeometry();
    out.setAttribute("position", new THREE.BufferAttribute(P, 3));
    out.setAttribute("normal", new THREE.BufferAttribute(N, 3));
    out.setAttribute("color", new THREE.BufferAttribute(C, 3));
    out.computeBoundingSphere();
    return out;
  }
  function extrudeC(S, prof, closed, hex){ return paint(extrude(THREE, S, prof, closed), hex); }
  return {paint: paint, box: box, cyl: cyl, strut: strut, xform: xform, merge: mergeC, extrude: extrudeC, col: col};
}
function vcMat(c, o){ return c.mat(0xffffff, Object.assign({vertexColors: true, roughness: 0.75, metalness: 0.1}, o || {})); }

// one car's geometry at the rail head, forward +z (carModel's shapes); nose +1: a cab at the front. Windows are kept
// apart (glassAt: their first and last vertex) so the night can warm them
function carGeo(THREE, K, L, nose, pant, liv){
  var parts = [], H0 = PLAT_TOP - 0.1, H = 3.0, bodyL = nose ? L - 2.6 : L, bz = nose ? -nose*1.3 : 0;
  parts.push(K.box(2.9, H, bodyL, 0, H0 + H/2, bz, liv.body));
  if(nose){
    var g = new THREE.BoxGeometry(2.9, H, 2.6), P = g.attributes.position;
    for(var i = 0; i < P.count; i++){
      var zz = P.getZ(i)*nose, yy = P.getY(i);
      if(zz > 0 && yy > 0){ P.setZ(i, P.getZ(i) - nose*2.1); P.setY(i, yy - 0.45); }
      if(zz > 0 && yy < 0) P.setX(i, P.getX(i)*0.86);
    }
    g.computeVertexNormals(); g.translate(0, H0 + H/2, nose*(L/2 - 1.3));
    parts.push(K.paint(g, liv.body));
    parts.push(K.box(0.4, 0.16, 0.08, 0.95, H0 + 0.75, nose*(L/2 - 0.02), 0xfff6dd), K.box(0.4, 0.16, 0.08, -0.95, H0 + 0.75, nose*(L/2 - 0.02), 0xfff6dd));
  }
  parts.push(K.box(2.94, 0.28, L - 0.6, 0, H0 + 1.15, 0, liv.accent));                       // the stripe
  [-1, 1].forEach(function(e){ parts.push(K.box(2.98, 2.15, 1.3, 0, H0 + 1.15, e*L*0.22, liv.door || liv.accent)); });
  parts.push(K.box(2.5, 0.25, L - 1.2, 0, H0 + H + 0.12, 0, 0x22282e));                        // the roof's equipment
  [-1, 1].forEach(function(e){ parts.push(K.box(2.3, 0.75, 2.6, 0, 0.45, e*(L/2 - 3.2), 0x22282e)); });   // bogies
  parts.push(K.box(2.7, 0.35, L - 7.5, 0, H0 - 0.15, 0, 0x22282e));
  if(pant){ parts.push(K.box(0.08, 1.3, 0.08, 0, H0 + H + 0.8, -1, 0x22282e), K.box(1.6, 0.06, 0.25, 0, H0 + H + 1.45, -0.4, 0x22282e)); }
  var before = 0; parts.forEach(function(p){ before += p.attributes.position.count; });
  parts.push(K.box(2.96, 0.95, L - 5.2, 0, H0 + 2.15, 0, liv.glass));                          // the window band
  if(nose) parts.push(K.box(2.5, 1.0, 0.1, 0, H0 + 2.35, nose*(L/2 - 1.55), liv.glass));
  var g2 = K.merge(parts);
  g2.userData.glass = [before, g2.attributes.position.count];
  return g2;
}
// every train of a line in view: cab cars and middle cars as two InstancedMeshes
function trainKit(c, liv, cap){
  var THREE = c.THREE, K = kit(THREE), mat = vcMat(c, {roughness: 0.4, metalness: 0.25});
  cap = Math.max(4, cap | 0);
  var gc = carGeo(THREE, K, CAR_L, 1, false, liv), gm = carGeo(THREE, K, CAR_L, 0, true, liv);
  var cab = new THREE.InstancedMesh(gc, mat, cap), mid = new THREE.InstancedMesh(gm, mat, cap), grp = new THREE.Group();
  cab.count = 0; mid.count = 0; cab.castShadow = mid.castShadow = true; cab.frustumCulled = mid.frustumCulled = false;
  grp.add(cab); grp.add(mid);
  var dummy = new THREE.Object3D(), night = null;
  return {g: grp,
    // cars [{x, y, z, yaw, pitch, nose: 1 (a cab at the front) | -1 (a cab at the back) | 0}] (the rail head, local m)
    set: function(cars){
      var nc = 0, nm = 0;
      cars.forEach(function(p){
        var flip = p.nose < 0, M = p.nose ? cab : mid, i = p.nose ? nc : nm;
        if(i >= cap) return;
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(flip ? p.pitch : -p.pitch, p.yaw + (flip ? Math.PI : 0), 0, "YXZ");
        dummy.updateMatrix(); M.setMatrixAt(i, dummy.matrix);
        if(p.nose) nc++; else nm++;
      });
      cab.count = nc; mid.count = nm;
      cab.instanceMatrix.needsUpdate = true; mid.instanceMatrix.needsUpdate = true;
    },
    night: function(on){
      on = !!on; if(on === night) return; night = on;
      var cc = K.col(on ? liv.glassNight || 0xffd9a0 : liv.glass);
      [gc, gm].forEach(function(g){
        var r = g.userData.glass, a = g.attributes.color;
        for(var i = r[0]; i < r[1]; i++) a.setXYZ(i, cc.r, cc.g, cc.b);
        a.needsUpdate = true;
      });
    },
    drawCalls: function(){ return (grp.visible ? (cab.count ? 1 : 0) + (mid.count ? 1 : 0) : 0); },
    dispose: function(){ gc.dispose(); gm.dispose(); mat.dispose(); }
  };
}
// the cars of a train whose head is `head` m along R: [{x, y, z, yaw, pitch, nose, s}] in the frame minus o
function carsOf(R, head, o, cars){
  var out = [];
  cars = cars || CARS;
  for(var k = 0; k < cars; k++){
    var sc = head - k*(CAR_L + CAR_GAP) - CAR_L/2, p = at(R, sc);
    out.push({x: p.x - o.x, y: p.y, z: p.z - o.z, yaw: p.yaw, pitch: p.pitch, nose: k === 0 ? 1 : k === cars - 1 ? -1 : 0, s: sc, k: k});
  }
  return out;
}
/* ---------- the trains' sound (Sound PR B), shared with games/hqcityrail.js ----------
   nearOn(cars, p, dy, carL): where a train sounds from, the point of its centre line (carsOf()-shaped poses, front car
   first, from its nose to its tail) nearest p ({x, z}), dy m over the rails: a 72 m train sounds from its part beside
   you. earAt(cam): the ears games/engine.js hears from this frame (its listener), else cam. trainPool(): a pool of
   the engine's train-run loops (null without one): update([{id, x, y, z, speed}]) each frame plays the nearest moving
   train; one voice per pool, as the City Line, the Island Link and the built lines share the train kind's two. */
function nearOn(cars, p, dy, carL){
  var n = cars ? cars.length : 0; if(!n) return null;
  var px = +(p && p.x) || 0, pz = +(p && p.z) || 0, h = (carL || CAR_L)/2, a = cars[0], b = cars[n - 1];
  var line = [{x: a.x + Math.sin(a.yaw)*h, y: a.y, z: a.z + Math.cos(a.yaw)*h}].concat(cars, [{x: b.x - Math.sin(b.yaw)*h, y: b.y, z: b.z - Math.cos(b.yaw)*h}]);
  var best = {x: line[0].x, y: line[0].y, z: line[0].z}, bd = Infinity;
  for(var i = 0; i + 1 < line.length; i++){
    var A = line[i], B = line[i + 1], ex = B.x - A.x, ez = B.z - A.z, l2 = ex*ex + ez*ez;
    var u = l2 > 1e-9 ? Math.max(0, Math.min(1, ((px - A.x)*ex + (pz - A.z)*ez)/l2)) : 0, x = A.x + ex*u, z = A.z + ez*u, d = (px - x)*(px - x) + (pz - z)*(pz - z);
    if(d < bd){ bd = d; best = {x: x, y: A.y + (B.y - A.y)*u, z: z}; }
  }
  best.y += +dy || 0;
  return best;
}
function earAt(cam){
  var E = HQV.engine, L = null;
  try { L = E && E.listenerAt ? E.listenerAt() : null; } catch(e){ L = null; }
  return L || (cam && cam.x != null ? cam : {x: 0, y: 0, z: 0});
}
var SND_R = 600;             // m: a train's head this near the ears is worth placing (the train kind fades out by 400 m)
function trainPool(){
  var E = HQV.engine;
  if(!E || typeof E.pool !== "function" || typeof E.loop !== "function") return null;
  try {
    return E.pool("train", {voices: 1, key: function(){ return "run"; }, make: function(){ return E.loop("train-run", "train"); },
                            play: function(h, s){ h.set(1, {pos: s, speed: s.speed}); }});
  } catch(e){ return null; }
}
// a focused train's inside: unit boxes (floor, seats, racks, a light strip, car 1's luggage stack) with instance colours,
// one call; and a faint shell per car, one call. seats: SEATS-shaped [{car, x, y, z, back}]
var UNIT = null;
function interiorKit(c, seats, o){
  var THREE = c.THREE; o = o || {};
  seats = seats || SEATS;
  var cars = o.cars || CARS, L = o.carL || CAR_L, F = o.floor != null ? o.floor : PLAT_TOP;
  var B = [];                                          // [car, x, y, z, sx, sy, sz, hex]
  for(var k = 0; k < cars; k++){
    B.push([k, 0, F - 0.03, 0, 2.7, 0.06, L - 0.5, o.floorHex || 0x8f9294]);
    [-1, 1].forEach(function(sd){ B.push([k, sd*1.2, F + 1.95, 0, 0.36, 0.04, L - 6.5, 0x9aa3ab]); });   // luggage racks
    B.push([k, 0, F + 2.4, 0, 0.22, 0.03, L - 2, 0xfff3d6]);                                            // the light strip
    B.push([k, 0, F + 2.46, 0, 2.8, 0.04, L - 0.5, o.ceilHex || 0xeeebe3]);                              // the ceiling, over the strip
    [-1, 1].forEach(function(sd){ B.push([k, sd*1.42, F + 0.45, 0, 0.05, 0.9, L - 0.5, o.wallHex || 0xd8d3c7]); });   // the walls under the windows
    [-1, 1].forEach(function(sd){ B.push([k, sd*1.42, F + 2.3, 0, 0.05, 0.3, L - 0.5, o.wallHex || 0xd8d3c7]); });    // and over them
  }
  seats.forEach(function(s){
    if(s.car >= cars) return;
    var d = s.back ? -1 : 1;
    B.push([s.car, s.x, F + s.y - 0.05, s.z, 0.46, 0.1, 0.45, o.seatHex || 0x2f6b4f]);
    B.push([s.car, s.x, F + s.y + 0.3, s.z - d*0.24, 0.46, 0.62, 0.08, o.seatHex || 0x2f6b4f]);
  });
  if(o.luggage != null){
    var lc = [0x7a4a2a, 0x2b4a7a, 0x8a1f2e, 0x3d3d3d, 0xb08a3c, 0x4f6b3a];
    for(var q = 0; q < 6; q++) B.push([o.luggage, (q % 2 ? 0.75 : -0.75), F + 0.3 + Math.floor(q/2)*0.55, -L/2 + 2.6 + (q % 3)*0.12, 0.7, 0.5, 0.45, lc[q]]);
  }
  if(!UNIT || UNIT.THREE !== THREE) UNIT = {THREE: THREE, g: new THREE.BoxGeometry(1, 1, 1)};
  var mat = c.mat(0xffffff, {roughness: 0.8});
  var inside = new THREE.InstancedMesh(UNIT.g, mat, B.length), cc = new THREE.Color();
  B.forEach(function(b, i){ inside.setColorAt(i, cc.setHex(b[7])); });
  var smat = c.mat(o.shellHex || 0xf2ead2, {transparent: true, opacity: 0.16, depthWrite: false, roughness: 0.4});
  var shell = new THREE.InstancedMesh(UNIT.g, smat, cars), grp = new THREE.Group();
  inside.frustumCulled = shell.frustumCulled = false;
  grp.add(inside); grp.add(shell); grp.visible = false;
  var m = new THREE.Matrix4(), mc = new THREE.Matrix4(), dummy = new THREE.Object3D();
  return {g: grp,
    // carPoses: carsOf() of the focused train (null: hide)
    set: function(carPoses){
      if(!carPoses){ grp.visible = false; return; }
      grp.visible = true;
      var M = [];
      carPoses.forEach(function(p, k){
        dummy.position.set(p.x, p.y, p.z); dummy.rotation.set(-p.pitch, p.yaw, 0, "YXZ");
        dummy.scale.set(1, 1, 1); dummy.updateMatrix(); M[k] = dummy.matrix.clone();
        shell.setMatrixAt(k, mc.copy(M[k]).multiply(m.compose(new THREE.Vector3(0, PLAT_TOP - 0.1 + 1.5, 0), new THREE.Quaternion(), new THREE.Vector3(2.92, 3.0, L))));
      });
      B.forEach(function(b, i){
        var base = M[b[0]] || M[0];
        inside.setMatrixAt(i, mc.copy(base).multiply(m.compose(new THREE.Vector3(b[1], b[2], b[3]), new THREE.Quaternion(), new THREE.Vector3(b[4], b[5], b[6]))));
      });
      inside.instanceMatrix.needsUpdate = true; shell.instanceMatrix.needsUpdate = true;
    },
    drawCalls: function(){ return grp.visible ? 2 : 0; },
    dispose: function(){ mat.dispose(); smat.dispose(); }
  };
}
// seated commuters: HQV.hqCommute's figures (one InstancedMesh, the shirt tinted per instance)
function commuterKit(c, cap){
  var THREE = c.THREE, F = HQV.hqCommute && HQV.hqCommute.figures ? HQV.hqCommute.figures(THREE) : null, own = null;
  if(!F){ own = {g: figureGeo(THREE, true), m: c.mat(0xffffff, {roughness: 0.8})}; }
  var I = new THREE.InstancedMesh(F ? F.seated : own.g, F ? F.material : own.m, Math.max(1, cap | 0)), dummy = new THREE.Object3D(), cc = new THREE.Color();
  I.count = 0; I.frustumCulled = false;
  return {g: I,
    // list [{x, y (the seat top), z, yaw, key}]: painted by hqCommute.paint(key) (else the PEOPLE colours)
    set: function(list){
      var n = Math.min(list.length, I.instanceMatrix.count);
      for(var i = 0; i < n; i++){
        var p = list[i]; dummy.position.set(p.x, p.y - (F ? 0 : 0.45), p.z); dummy.rotation.set(0, p.yaw, 0); dummy.updateMatrix();
        I.setMatrixAt(i, dummy.matrix);
        var pt = HQV.hqCommute && HQV.hqCommute.paint ? HQV.hqCommute.paint(p.key) : null;
        if(pt && pt.shirt) cc.setRGB(pt.shirt[0], pt.shirt[1], pt.shirt[2]); else cc.setHex(PEOPLE[hash(String(p.key)) % PEOPLE.length]);
        I.setColorAt(i, cc);
      }
      I.count = n; I.instanceMatrix.needsUpdate = true; if(I.instanceColor) I.instanceColor.needsUpdate = true;
    },
    drawCalls: function(){ return I.visible && I.count ? 1 : 0; },
    dispose: function(){ if(own){ own.g.dispose(); own.m.dispose(); } }
  };
}
// the seated commuters of one train (a vehicle id, its trip key and its cars): world-space seat poses
function ridersOf(mode, vid, cars, seats, ms, seed, skipSeat){
  var C = HQV.hqCommute, out = [];
  if(!C || !C.occupied) return out;
  var occ = C.occupied(mode, vid, vid, seats.length, 0, ms, seed);
  (occ && occ.seats || []).forEach(function(i){
    if(i === skipSeat) return;
    var s = seats[i], p = s && cars[s.car]; if(!p) return;
    var cy = Math.cos(p.yaw), sy = Math.sin(p.yaw);
    out.push({x: p.x + cy*s.x + sy*s.z, y: p.y + PLAT_TOP + s.y, z: p.z - sy*s.x + cy*s.z, yaw: p.yaw + (s.back ? Math.PI : 0), key: vid + ":" + i});
  });
  return out;
}

/* ---------- the Island Link drawn in a world: HQV.hqRail.linkView(c, sim, opts) -> V (plan 5.4) ----------
   sim: linkService(). Above ground: the IL from its coastal portal (the trench, the track at grade) out over the sea
   viaduct (the player-built lines' style: a concrete deck SEA_UP m over the water on piers, masts every MAST_EVERY m)
   within DRAW_R of this world, merged into one mesh; the trains in two calls; seated commuters in one. Below ground
   (opts.under() true, the integrator's underground view): the tunnel as a lit box section and only the trains in it.
   focus(vehicleId): that train's inside and faint shell (the camera rides in it). The trains you see (and yours) run
   with games/engine.js's train-run loop, the nearest moving one at a time (trainPool above). */
var IL_LIVERY = {body: 0xf3f1f6, accent: 0x6d4bb3, door: 0x5a3d99, glass: 0x1d2530, glassNight: 0xffd9a0};
// the portal's open U trench, as wide as its terrain hole (railway.rs TRENCH_W_CM): a floor under the ballast and a
// retaining wall each side from the floor up to just over the ground beside it, so the hole shows no void
var TRENCH_HW = 6;
function trenchGeo(THREE, K, S, ground){
  var pos = [];
  function v(p, lat, y){ var c = Math.cos(p.yaw), s = Math.sin(p.yaw); return [p.x + c*lat, y, p.z - s*lat]; }
  function quad(a, b, cc, d){ pos.push(a[0], a[1], a[2], b[0], b[1], b[2], cc[0], cc[1], cc[2], a[0], a[1], a[2], cc[0], cc[1], cc[2], d[0], d[1], d[2]); }
  function top(p, lat){ var q = v(p, lat, 0), g = ground(q[0], q[2]); return Math.max(p.y + 0.4, (isFinite(g) ? g : p.y) + 0.3); }
  for(var i = 0; i + 1 < S.length; i++){
    var A = S[i], B = S[i + 1], fa = A.y - 0.6, fb = B.y - 0.6;
    quad(v(A, -TRENCH_HW, fa), v(B, -TRENCH_HW, fb), v(B, TRENCH_HW, fb), v(A, TRENCH_HW, fa));
    [-1, 1].forEach(function(sd){
      var x = sd*TRENCH_HW, ta = top(A, x + sd*0.4), tb = top(B, x + sd*0.4);
      quad(v(A, x, fa), v(B, x, fb), v(B, x, tb), v(A, x, ta));
      quad(v(A, x, ta), v(B, x, tb), v(B, x + sd*0.4, tb), v(A, x + sd*0.4, ta));      // the coping
    });
  }
  var n = pos.length;                                  // both faces (the surface material is one-sided)
  for(var t = 0; t < n; t += 9) pos.push(pos[t], pos[t + 1], pos[t + 2], pos[t + 6], pos[t + 7], pos[t + 8], pos[t + 3], pos[t + 4], pos[t + 5]);
  var g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals();
  return K.paint(g, 0xb9bcbf);
}
function mouthGeo(THREE, K, S, M, ground){
  var pos = [], col = [], dark = new THREE.Color(0x3a3d40), wall = new THREE.Color(0xb9bcbf), ROOF = 5.6;
  function v(p, lat, y){ var c = Math.cos(p.yaw), s = Math.sin(p.yaw); return [p.x + c*lat, y, p.z - s*lat]; }
  function quad(a, b, cc, d, k){ [a, b, cc, a, cc, d, a, cc, b, a, d, cc].forEach(function(q){ pos.push(q[0], q[1], q[2]); col.push(k.r, k.g, k.b); }); }
  // the roof is at least the ground over it, so the terrain hole past the mouth is closed by its lid
  function roofY(p){ var g = ground(p.x, p.z); return Math.max(p.y + ROOF, (isFinite(g) ? g : p.y) + 0.05); }
  var lid = new THREE.Color(0x8e918f);
  for(var i = 0; i + 1 < S.length; i++){
    var A = S[i], B = S[i + 1], ra = roofY(A), rb = roofY(B);
    quad(v(A, -TRENCH_HW, A.y - 0.6), v(B, -TRENCH_HW, B.y - 0.6), v(B, TRENCH_HW, B.y - 0.6), v(A, TRENCH_HW, A.y - 0.6), dark);
    quad(v(A, -TRENCH_HW, A.y + ROOF), v(B, -TRENCH_HW, B.y + ROOF), v(B, TRENCH_HW, B.y + ROOF), v(A, TRENCH_HW, A.y + ROOF), dark);
    quad(v(A, -TRENCH_HW - 0.4, ra), v(B, -TRENCH_HW - 0.4, rb), v(B, TRENCH_HW + 0.4, rb), v(A, TRENCH_HW + 0.4, ra), lid);
    [-1, 1].forEach(function(sd){ quad(v(A, sd*TRENCH_HW, A.y - 0.6), v(B, sd*TRENCH_HW, B.y - 0.6), v(B, sd*TRENCH_HW, rb), v(A, sd*TRENCH_HW, ra), dark); });
  }
  // the far end, dark: the tunnel beyond is drawn only below ground
  var Fe = S[0] === M ? S[S.length - 1] : S[0];
  quad(v(Fe, -TRENCH_HW, Fe.y - 0.6), v(Fe, TRENCH_HW, Fe.y - 0.6), v(Fe, TRENCH_HW, Fe.y + ROOF), v(Fe, -TRENCH_HW, Fe.y + ROOF), new THREE.Color(0x1c1e20));
  // the headwall over the mouth, up to just over the ground
  var g0 = ground(M.x, M.z), top = Math.max(M.y + ROOF + 0.6, (isFinite(g0) ? g0 : M.y) + 0.6);
  quad(v(M, -TRENCH_HW - 0.4, M.y + ROOF), v(M, TRENCH_HW + 0.4, M.y + ROOF), v(M, TRENCH_HW + 0.4, top), v(M, -TRENCH_HW - 0.4, top), wall);
  var g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals();
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  return g;
}
function linkView(c, sim, opts){
  var THREE = c.THREE, K = kit(THREE); opts = opts || {};
  var root2 = new THREE.Group(); root2.name = "rail:island-link";
  var o = sim && sim.origin ? sim.origin() : {x: 0, z: 0}, lines = sim ? sim.lines() : [];
  var underF = typeof opts.under === "function" ? opts.under : function(){ return false; };
  var parts = [], tube = [], seaY = typeof opts.seaY === "number" ? opts.seaY : 0;
  var ground = typeof opts.ground === "function" ? opts.ground : function(){ return seaY - 6; };
  function near(p){ return hyp(p.x - o.x, p.z - o.z) < DRAW_R; }
  lines.forEach(function(l){
    var R = sim.route(l.id, "out"); if(!R) return;
    // runs of one kind of structure within DRAW_R: tunnel (below ground only), portal/grade (on the ground), viaduct/sea
    var runs = [], cur = null;
    for(var s = 0; s <= R.len; s += 4){
      var p = at(R, s), kk = kAt(R, s), cls = kk === K_TUNNEL ? "tunnel" : kk === K_PORTAL ? "portal" : kk === K_GRADE ? "ground" : "deck";
      if(!near(p)){ cur = null; continue; }
      if(!cur || cur.cls !== cls){ cur = {cls: cls, a: Math.max(0, s - 4), b: s}; runs.push(cur); } else cur.b = s;
    }
    runs.forEach(function(r){
      var S = samples(R, r.a, Math.min(R.len, r.b + 4), 4, o);
      if(S.length < 2) return;
      var rails = [];
      [-0.75, 0.75].forEach(function(lt){ rails.push([[lt - 0.04, 0], [lt + 0.04, 0], [lt + 0.04, -0.17], [lt - 0.04, -0.17]]); });
      if(r.cls === "tunnel"){
        tube.push(K.extrude(S, [[-3.6, -0.6], [3.6, -0.6], [3.6, 5.6], [-3.6, 5.6]], true, 0x9a9890));
        tube.push(K.extrude(S, [[-2.4, -0.3], [2.4, -0.3]], false, 0x55524c));
        rails.forEach(function(pr){ tube.push(K.extrude(S, pr, true, 0x8a9096)); });
        tube.push(K.extrude(S, [[3.2, 4.9], [3.5, 4.9], [3.5, 5.0], [3.2, 5.0]], true, 0xfff2d0));   // the lit cable tray
        return;
      }
      rails.forEach(function(pr){ parts.push(K.extrude(S, pr, true, 0x6f7882)); });
      parts.push(K.extrude(S, [[-0.02, 5.6], [0.02, 5.6], [0.02, 5.55], [-0.02, 5.55]], true, 0x2b2f33));
      if(r.cls === "ground" || r.cls === "portal"){
        parts.push(K.extrude(S, [[-2.6, -0.25], [2.6, -0.25], [2.1, -0.45], [-2.1, -0.45]], true, 0x77736c));          // ballast
        if(r.cls === "portal"){
          parts.push(trenchGeo(THREE, K, S, ground));                                                                    // the U trench
          // the tunnel mouth: 14 m of dark box tunnel under a headwall (the tunnel itself is drawn only below ground)
          var atA = kAt(R, Math.max(0, r.a - 4)) === K_TUNNEL, ms = atA ? r.a : Math.min(R.len, r.b + 4);
          var SM = atA ? samples(R, Math.max(0, ms - 14), ms, 2, o) : samples(R, ms, Math.min(R.len, ms + 14), 2, o);
          if(SM.length >= 2) parts.push(mouthGeo(THREE, K, SM, atA ? SM[SM.length - 1] : SM[0], ground));
        }
      } else {
        parts.push(K.extrude(S, DECK, true, 0xb9bcbf));
        var piers = samples(R, Math.ceil(r.a/PIER_EVERY)*PIER_EVERY, r.b, PIER_EVERY, o);
        piers.forEach(function(p){
          var gy = ground(p.x, p.z); if(!isFinite(gy) || gy < seaY - 0.2) gy = seaY - 6;
          var h = Math.max(0.5, p.y - 1.9 - gy);
          parts.push(K.cyl(0.85, 1.05, h, 10, p.x, gy, p.z, 0xa9adb1));
          parts.push(K.box(5.4, 0.9, 2.4, p.x, p.y - 2.3, p.z, 0xa9adb1, p.yaw));
        });
      }
      samples(R, Math.ceil(r.a/MAST_EVERY)*MAST_EVERY + 12, r.b, MAST_EVERY, o).forEach(function(p){
        var cx = Math.cos(p.yaw), sx = Math.sin(p.yaw);
        parts.push(K.cyl(0.12, 0.14, 6.4, 8, p.x + cx*3.35, p.y + 0.5 - 0.0, p.z - sx*3.35, 0x3d5566));
        parts.push(K.box(3.6, 0.1, 0.1, p.x + cx*1.6, p.y + 5.75, p.z - sx*1.6, 0x3d5566, p.yaw));
      });
    });
  });
  var mat = vcMat(c, {roughness: 0.85}), surf = null, tun = null;
  if(parts.length){ surf = new THREE.Mesh(K.merge(parts), mat); surf.receiveShadow = true; surf.castShadow = true; root2.add(surf); }
  if(tube.length){ var tm = vcMat(c, {roughness: 0.9, side: THREE.DoubleSide}); tun = new THREE.Mesh(K.merge(tube), tm); tun.userData.mat = tm; tun.visible = false; root2.add(tun); }
  var trains = trainKit(c, IL_LIVERY, 4*Math.max(2, lines.length*2)), inside = interiorKit(c, SEATS, {luggage: 0, seatHex: 0x4b3d7a, shellHex: 0xf3f1f6});
  var riders = commuterKit(c, 260);
  root2.add(trains.g); root2.add(inside.g); root2.add(riders.g);
  if(c.scene && opts.attach !== false) c.scene.add(root2);
  var focusId = null, mySeat = opts.mySeat != null ? opts.mySeat : -1, seed = opts.seed != null ? opts.seed : (sim && sim.here) || "";
  var runP = trainPool();      // the trains' running sound: heard as they are drawn (in the tunnel only below ground), yours too
  var V = {g: root2,
    update: function(ms, dt, cam){
      var under = !!underF(), cars = [], ride = [], fc = null, snd = [], ear = earAt(cam);
      if(surf) surf.visible = !under;
      if(tun) tun.visible = under;
      trains.night(typeof opts.night === "function" ? opts.night() : false);
      function heard(v, cs){
        if(!runP || !(+v.speed > 0.5) || hyp(cs[0].x - ear.x, cs[0].z - ear.z) > SND_R) return;
        var q = nearOn(cs, ear, 1.5); snd.push({id: v.id, x: q.x, y: q.y, z: q.z, speed: +v.speed});
      }
      (sim ? sim.vehicles(ms) : []).forEach(function(v){
        var R = sim.route(v.line, v.dir); if(!R) return;
        var cs = carsOf(R, v.along, o), inTunnel = underAt(R, v.along - TRAIN_L/2);
        if(v.id === focusId){ fc = cs; ride = ride.concat(ridersOf("link", v.id, cs, SEATS, ms, seed, mySeat)); heard(v, cs); return; }
        if(inTunnel !== under) return;
        if(cam && hyp(cs[0].x - cam.x, cs[0].z - cam.z) > TRAIN_FAR) return;
        cars = cars.concat(cs);
        heard(v, cs);
        if(cam && hyp(cs[1].x - cam.x, cs[1].z - cam.z) < 250) ride = ride.concat(ridersOf("link", v.id, cs, SEATS, ms, seed, -1));
      });
      trains.set(cars); inside.set(fc); riders.set(ride);
      if(runP) runP.update(snd);
    },
    focus: function(id){ focusId = id || null; if(!focusId) inside.set(null); },
    focused: function(){ return focusId; },
    drawCalls: function(){ return (surf && surf.visible ? 1 : 0) + (tun && tun.visible ? 1 : 0) + trains.drawCalls() + inside.drawCalls() + riders.drawCalls(); },
    tools: {shotCam: function(name){
      var l = lines[0], R = l && sim.route(l.id, "out"); if(!R) return null;
      if(name === "link-viaduct"){ var s1 = (R.seaA + Math.min(R.seaB, R.seaA + 400))/2, p = at(R, s1); var cx = Math.cos(p.yaw), sx = Math.sin(p.yaw);
        return {pos: {x: p.x - o.x + cx*60, y: p.y + 14, z: p.z - o.z - sx*60}, look: {x: p.x - o.x, y: p.y, z: p.z - o.z}, fov: 55}; }
      if(name === "link-portal"){
        // from over the trench's open end, looking down it into the tunnel mouth
        var s0 = -1, s1 = -1;
        for(var s = 0; s < R.len; s += 2) if(kAt(R, s) === K_PORTAL){ if(s0 < 0) s0 = s; s1 = s; }
        if(s0 < 0) return null;
        var mouthS = kAt(R, Math.max(0, s0 - 4)) === K_TUNNEL ? s0 : s1, openS = mouthS === s0 ? s1 : s0;
        var m = at(R, mouthS), op = at(R, openS), dx = op.x - m.x, dz = op.z - m.z, dl = hyp(dx, dz) || 1; dx /= dl; dz /= dl;
        return {pos: {x: op.x - o.x + dx*18 + dz*5, y: op.y + 9, z: op.z - o.z + dz*18 - dx*5}, look: {x: m.x - o.x, y: m.y + 1, z: m.z - o.z}, fov: 55};
      }
      return null;
    }},
    dispose: function(){
      if(runP){ runP.stop(); runP = null; }
      if(root2.parent) root2.parent.remove(root2);
      if(surf) surf.geometry.dispose(); if(tun){ tun.geometry.dispose(); tun.userData.mat.dispose(); }
      mat.dispose(); trains.dispose(); inside.dispose(); riders.dispose();
    }};
  return V;
}

/* ---------- running it in a City (games/hqcity3d.js's rail block) ----------
   mount(c, w, o) -> {update(t, dt), carry(), use(), rows(arch) (the station menu's rail rows), has(world), setNight(n),
   destroy(), tools}. o: {W, world, me (user id), sea (m), here() (archipelago m), arch() (a promise), get(path),
   post(path, body), say(text), places(arch), site(id), ground(x, z), night (bool), spawnAt(world, site)}.
   The ride is HQV.hqRail.ride (one for the page): the city you board in and the one you arrive in both draw your
   train and seat you in it (w.carry); mid-sea the next city, built while you ride (c.prebuildCity), takes over
   (c.swapCity), as the ferry does. */
var RIDE = {trip: null, hud: null, hudKey: ""};
var TRAIN_FAR = 2200;        // m: trains further than this from the camera are not drawn
var STATION_R = 8;           // m from a station's door: E opens the station's menu (its bus bay's stop is further out)
function mmss(ms){ var s = Math.max(0, Math.round(ms/1000)); return Math.floor(s/60) + ":" + (s % 60 < 10 ? "0" : "") + (s % 60); }
function mount(c, w, o){
  var THREE = c.THREE, S = w.scene, root = new THREE.Group(); root.name = "rail"; S.add(root);
  var M = materials(c); M.standGeo = figureGeo(THREE, false); M.seatedGeo = figureGeo(THREE, true);
  var world = o.world, rail = null, arch = null, lines = [], views = [], pool = [], mine = null, dead = false, night = !!o.night;
  var hp = o.here ? o.here() : {x: 0, z: 0}, myTier = 0, fetchedAt = 0, seed = 1, loading = {};
  function tierOf(a, wid){
    if(isCommonsId(wid)) return 5;
    var i = (a && Array.isArray(a.islands) ? a.islands : []).filter(function(x){ return x && sameWorld(x.world, wid); })[0];
    return i ? Math.max(1, Math.min(5, i.tier | 0)) : 1;
  }
  function myIsland(){ return o.me ? islandIdOf(o.me, verOf(world)) : null; }
  function posOf(a, wid){
    var h = isCommonsId(wid) ? a && a.commons : (a && a.islands || []).filter(function(i){ return i && sameWorld(i.world, wid); })[0];
    return h && isFinite(+h.x) && isFinite(+h.z) ? {x: (+h.x || 0)/100, z: (+h.z || 0)/100} : null;
  }
  // a line's lanes at a station: from every line there (the same on every client); memoised per station and lines
  var laneMemo = {};
  function laneOf(W, wid, other){
    var others = linesAt(rail, wid).map(function(l){ var p = posOf(arch, l.other); return p ? {world: l.other, x: p.x, z: p.z} : null; }).filter(Boolean);
    var here = posOf(arch, wid); if(!here || !W) return null;
    var key = wid + ">" + others.map(function(x){ return x.world; }).sort().join(",");
    if(!laneMemo[key]) laneMemo[key] = lanes(W, tierOf(arch, wid), here, others);
    return laneMemo[key][other] || null;
  }
  function laneKey(a, b){ return JSON.stringify([a, b]); }
  function placesOf(a){ return (o.places(a) || []).map(function(p){ return Object.assign({}, p, {tier: tierOf(a, p.world)}); }); }
  function setNight(n){
    night = !!n; M.glass.emissiveIntensity = night ? 1.25 : 0; M.glass.opacity = night ? 0.85 : 0.62;
    M.canopy.emissiveIntensity = night ? 0.55 : 0; M.lamp.emissiveIntensity = night ? 2.4 : 0.6;
  }
  setNight(night);
  // the lines touching this city: both docs loaded, the alignment in the ordered direction (the same everywhere)
  function refresh(){
    fetchedAt = Date.now();
    return Promise.all([o.get("/api/arena/rail"), o.arch()]).then(function(r){
      if(dead) return;
      rail = r[0] && typeof r[0] === "object" ? r[0] : {lines: []}; arch = r[1];
      var h = isCommonsId(world) ? arch && arch.commons : (arch && arch.islands || []).filter(function(i){ return i && sameWorld(i.world, world); })[0];
      hp = {x: h ? (+h.x || 0)/100 : 0, z: h ? (+h.z || 0)/100 : 0}; myTier = tierOf(arch, myIsland());
      var want = linesAt(rail, world), have = {};
      // a line built since: the lines beside it move into their lanes (not the one you are riding)
      lines.slice().forEach(function(L){
        var V = RIDE.trip, riding = V && (V.from === L.other || V.to === L.other);
        if(riding || laneKey(laneOf(o.W, world, L.other), laneOf(L.W2, L.other, world)) === L.lk) return;
        L.view.dispose(); root.remove(L.view.g); views.splice(views.indexOf(L.view), 1); lines.splice(lines.indexOf(L), 1);
        try { addLine(L.to, L.W2); } catch(e){ if(typeof console !== "undefined") console.warn("rail: the line to " + L.other + " was not redrawn", e); }
      });
      lines.forEach(function(L){ have[L.other] = L; });
      var places = placesOf(arch), jobs = [];
      want.forEach(function(L){
        if(have[L.other] || loading[L.other]) return;
        var to = places.filter(function(p){ return p.world === L.other; })[0];
        if(!to) return;
        loading[L.other] = 1;
        jobs.push(loadDoc(L.other).then(function(W2){
          delete loading[L.other];
          if(dead) return;
          try { addLine(to, W2); } catch(e){ if(typeof console !== "undefined") console.warn("rail: the line to " + to.world + " was not drawn", e); }
        }, function(){ delete loading[L.other]; }));
      });
      return Promise.all(jobs);
    }, function(){});
  }
  function addLine(to, W2){
    var la = laneOf(o.W, world, to.world), lb = laneOf(W2, to.world, world);
    var mineSide = {world: world, x: hp.x, z: hp.z, W: o.W, tier: tierOf(arch, world), sea: seaOf(o.W, o.sea), lane: la};
    var them = {world: to.world, x: to.x, z: to.z, W: W2, tier: to.tier, sea: seaOf(W2, 0), lane: lb};
    var ab = world < to.world ? alignment(mineSide, them) : alignment(them, mineSide), ba = reverse(ab);
    var out = ab.from === world ? ab : ba, inb = ab.from === world ? ba : ab;
    var st = stationOf(o.W), door = st ? doorOf(st) : null;
    var V = lineView(c, M, ab, hp, ab.from === world ? [0] : [ab.len], o.ground, o.sea, door, la);
    root.add(V.g); views.push(V);
    lines.push({other: to.world, to: to, out: out, inb: inb, W2: W2, view: V, lk: laneKey(la, lb)});
  }
  function seaOf(W, dflt){ return W && W.island && W.island.sea_cm != null ? (+W.island.sea_cm || 0)/100 : dflt || 0; }
  function loadDoc(id){
    var WD = HQV.world;
    if(!WD || !WD.load) return Promise.resolve(null);
    return WD.load({id: id}).then(function(W2){ return W2 && (W2.v | 0) >= 2 ? W2 : null; }, function(){ return null; });
  }
  refresh();
  function lineTo(world2){ return lines.filter(function(L){ return L.other === world2; })[0] || null; }
  function trainOf(i){
    while(pool.length <= i){ var T = trainModel(c, M, seed++ * 13); root.add(T.g); pool.push(T); }
    return pool[i];
  }
  // the timetable's trains near the camera; yours on its own. They run with the train-run loop (Sound PR B): the
  // nearest moving one, yours included, from its part nearest your ears
  var runP = trainPool();
  function update(t, dt, cam){
    if(!arch && o.here) hp = o.here();                                                    // until the lines load
    var now = Date.now(), n = 0, V = RIDE.trip, cx = cam && cam.x != null ? cam.x : 0, cz = cam && cam.z != null ? cam.z : 0;
    var snd = [], ear = earAt(cam);
    function heard(id, R, p){
      if(!runP || !(p.speed > 0.5) || hyp(p.x - hp.x - ear.x, p.z - hp.z - ear.z) > SND_R) return;
      var q = nearOn(carsOf(R, p.along, hp), ear, 1.5); snd.push({id: id, x: q.x, y: q.y, z: q.z, speed: p.speed});
    }
    if(now - fetchedAt > 60000) refresh();
    lines.forEach(function(L){
      [[L.out, world, L.other], [L.inb, L.other, world]].forEach(function(d){
        var R = d[0];
        departures(d[1], d[2], now, (R.T + DWELL)*1000, DWELL*1000).forEach(function(dep){
          if(V && V.dep === dep && V.from === d[1] && V.to === d[2]) return;           // yours: drawn on its own
          var tt = (now - dep)/1000; if(tt < -DWELL || tt > R.T + DWELL) return;
          var p = poseAt(R, tt);
          if(hyp(p.x - hp.x - cx, p.z - hp.z - cz) > TRAIN_FAR) return;
          placeTrain(trainOf(n++), R, p.along, hp);
          heard(d[1] + ">" + d[2] + ":" + dep, R, p);
        });
      });
    });
    for(var i = n; i < pool.length; i++) pool[i].g.visible = false;
    if(ours(V)) heard("yours", V.R, poseAt(V.R, Math.max(-1, rideT(V))));
    if(runP) runP.update(snd);
    rideStep(dt);
    if(c.active && c.active(w)) HQV.hqRail.tools = tools;                                // tools reach the City you are in
  }
  // your ride
  function ours(V){ return !!V && (V.from === world || V.to === world); }
  function rideT(V){ return Math.min(V.R.T, (Date.now() - V.dep)/1000 + V.warp); }
  function sfx(n){ if(HQV.engine && HQV.engine.sfx) HQV.engine.sfx(n); }        // your ride's own (board, depart, arrive): centred
  function board(L){
    var now = Date.now(), dep = nextDeparture(world, L.other, now);
    if(dep - now < 8000) dep += EVERY;                                                      // too late for this one
    RIDE.trip = {R: L.out, dep: dep, warp: 0, from: world, to: L.other, name: L.to.name, swapped: false, built: false, W2: L.W2};
    sfx("door");
    o.say("Aboard the train to " + L.to.name + ". It leaves in " + mmss(dep - now) + ". E gets you off before it leaves.");
  }
  function leave(){ RIDE.trip = null; hud(null); if(mine) mine.g.visible = false; }
  // your car's shell, faint: the camera rides inside it, you and the passengers by the windows stay in sight
  var faint = [];
  function seeThrough(car){
    car.traverse(function(x){
      if(!x.isMesh || x.isInstancedMesh) return;
      var m = x.material.clone(); m.transparent = true; m.opacity = 0.16; m.depthWrite = false; x.material = m; faint.push(m);
    });
  }
  function stationSpawn(W2, wid){
    var st = stationOf(W2); if(!st) return null;
    return o.spawnAt ? o.spawnAt(wid, st) : {world: wid, x: doorOf(st).x, z: doorOf(st).z, yaw: doorOf(st).yaw};
  }
  function rideStep(dt){
    var V = RIDE.trip;
    if(!ours(V)){ if(mine) mine.g.visible = false; if(!V) hud(null); return; }
    if(!mine){ mine = trainModel(c, M, 977); seeThrough(mine.cars[1]); root.add(mine.g); }
    var tt = (Date.now() - V.dep)/1000 + V.warp;
    if(tt > 0 && c.held && c.held("Space")) V.warp += dt*7;                                // eight times as fast
    tt = rideT(V);
    var p = poseAt(V.R, tt);
    placeTrain(mine, V.R, p.along, hp);
    if(tt >= 0 && !V.built && V.from === world){ V.built = true; if(c.prebuildCity) c.prebuildCity(V.to); sfx("go"); o.say("Doors closing. Next stop: " + V.name + "."); }
    if(V.from === world && tt >= V.R.hand && !V.swapped && c.cityBuilt && c.cityBuilt(V.to)){ V.swapped = true; if(!(c.swapCity && c.swapCity(V.to))) V.swapped = false; }
    if(tt >= V.R.T && (V.to === world || (!V.swapped && V.from === world))){
      var W2 = V.to === world ? o.W : V.W2, sp = stationSpawn(W2, V.to), name = V.name, arrived = V.to === world;
      leave();
      if(HQV.hqTravel && HQV.hqTravel.markVisited) HQV.hqTravel.markVisited(V.to);
      if(arrived){ if(sp && c.teleport) c.teleport(sp.x, sp.z, sp.yaw); }
      else if(c.goCity) c.goCity(V.to, sp);                                                // the next city never built: go now
      sfx("levelup");
      o.say("Welcome to " + (name || "the city") + ".");
      return;
    }
    hud(V, tt, p);
  }
  // the panel, shared by the city you left and the one you ride into (RIDE.hud)
  function hud(V, tt, p){
    if(!c.el || typeof document === "undefined") return;
    var el = RIDE.hud;
    if(!V){ if(el){ if(el.parentNode) el.parentNode.removeChild(el); RIDE.hud = null; RIDE.hudKey = ""; } return; }
    if(el && el.parentNode !== c.el) c.el.appendChild(el);
    if(!el){
      el = document.createElement("div"); el.className = "hq3d-voyage hq3d-rail"; el.setAttribute("role", "status");
      ["icon", "main", "bar", "hint"].forEach(function(k){ var d = document.createElement("div"); d.className = "hq3d-voyage-" + k; el.appendChild(d); });
      el.children[0].textContent = "🚆"; el.children[0].setAttribute("aria-hidden", "true");
      el.children[2].appendChild(document.createElement("span"));
      c.el.appendChild(el); RIDE.hud = el; RIDE.hudKey = "";
    }
    var fast = !!(c.held && c.held("Space")), left = Math.max(0, V.R.T - tt);
    var main = tt < 0 ? "Train to " + V.name + " · leaves in " + mmss(-tt*1000)
             : "Train to " + V.name + " · " + (p.leg === "sea" ? "Over the sea" : p.u < 0.5 ? "Leaving the city" : "Coming into " + V.name) + " · " + Math.max(1, Math.round(left/(fast ? 8 : 1)/60)) + " min";
    var key = main + "|" + Math.round(Math.max(0, tt)/Math.max(1, V.R.T)*200) + "|" + fast;
    if(key === RIDE.hudKey) return;
    RIDE.hudKey = key;
    el.children[1].textContent = main;
    el.children[2].firstChild.style.width = (Math.max(0, Math.min(1, tt/V.R.T))*100).toFixed(1) + "%";
    el.children[3].textContent = tt < 0 ? "E: step off before it leaves" : fast ? "Express!" : "Hold Space: express · drag to look around";
  }
  // your seat in the second car, by the window
  function carry(){
    var V = RIDE.trip; if(!ours(V)) return null;
    var p0 = poseAt(V.R, Math.max(-1, rideT(V))), p = at(V.R, p0.along - (CAR_L + CAR_GAP) - CAR_L/2 + 3);
    return {x: p.x - hp.x + Math.cos(p.yaw)*0.6, y: p.y + PLAT_TOP, z: p.z - hp.z - Math.sin(p.yaw)*0.6, yaw: p.yaw};
  }
  // E while aboard: off before it leaves, else a reminder
  function use(){
    var V = RIDE.trip; if(!ours(V)) return false;
    if(Date.now() < V.dep && V.from === world){
      var sp = stationSpawn(o.W, world); leave();
      if(sp && c.teleport) c.teleport(sp.x, sp.z, sp.yaw);
      o.say("You stepped off onto the platform.");
    } else o.say("You're on the train. Sit back, or hold Space for the express.");
    return true;
  }
  function build(to){
    o.say("Building the line to " + to.name + "…");
    return o.post("/api/arena/rail/build", {to: to.world}).then(function(r){
      if(r && r.ok === false){ o.say(String((r.j && (r.j.detail || r.j.error)) || "The line couldn't be built.").slice(0, 140)); return false; }
      sfx("levelup"); o.say("The line to " + to.name + " is built. Trains run every 3 minutes.");
      return refresh().then(function(){ return true; });
    }, function(){ o.say("The Arena didn't answer: no line built."); return false; });
  }
  // the station menu's rail rows (openMenu items: {text, fn, off})
  function rows(a){
    var now = Date.now(), out = [];
    menuRows(rail || {lines: []}, world, placesOf(a || arch), myIsland(), myTier, now).forEach(function(r){
      if(r.kind === "ride"){
        var L = lineTo(r.to.world);
        out.push(L ? {text: "🚆 Ride the train to " + r.to.name + " · departs in " + mmss(r.departs - now), fn: function(){ board(L); }}
                   : {text: "🚆 Train to " + r.to.name + " · the line is loading…", off: true, fn: function(){}});
      } else if(r.kind === "build"){
        out.push({text: "🛤 Build a rail line to " + r.to.name + " · " + r.cost + " coins from your treasury", fn: function(){ build(r.to); }});
      } else if(r.kind === "build-from"){
        var hereP = {world: world, name: isCommonsId(world) ? "The Commons" : "this island"};
        out.push({text: "🛤 Build a rail line from your island to " + hereP.name + " · " + r.cost + " coins from its treasury", fn: function(){ build(hereP); }});
      } else if(r.kind === "note"){
        out.push({text: "No line to " + r.to.name + (r.more ? " and " + r.more + " more" : "") + " yet · lines can be built from an island's station", off: true, fn: function(){}});
      }
    });
    return out;
  }
  function destroy(){
    dead = true;
    if(runP){ runP.stop(); runP = null; }
    S.remove(root);
    views.forEach(function(V){ V.dispose(); });
    pool.forEach(function(T){ T.g.traverse(function(x){ if(x.geometry && x.geometry !== M.seatedGeo) x.geometry.dispose(); }); });
    if(mine) mine.g.traverse(function(x){ if(x.geometry && x.geometry !== M.seatedGeo) x.geometry.dispose(); });
    faint.forEach(function(m){ m.dispose(); });
    M.standGeo.dispose(); M.seatedGeo.dispose();
    Object.keys(M).forEach(function(k){ if(M[k] && M[k].isMaterial) M[k].dispose(); });
  }
  var shotCam = null, camPose0 = w.camPose;
  w.camPose = function(){ return shotCam || (camPose0 ? camPose0() : null); };
  var tools = {
    lines: function(){ return lines.map(function(L){ return {to: L.other, len: L.out.len, T: L.out.T}; }); },
    board: function(wid){ var L = lineTo(wid) || lines[0]; if(L) board(L); return L ? L.other : null; },
    state: function(){ var V = RIDE.trip; return V ? {t: rideT(V), warp: V.warp, held: !!(c.held && c.held("Space")), T: V.R.T, hand: V.R.hand, from: V.from, to: V.to, swapped: V.swapped, here: world, trains: pool.filter(function(T){ return T.g.visible; }).length}
                                                   : {here: world, trains: pool.filter(function(T){ return T.g.visible; }).length}; },
    skip: function(s){ var V = RIDE.trip; if(V){ var tt = (Date.now() - V.dep)/1000 + V.warp; if(tt < 0) V.warp -= tt; V.warp += +s || 0; } },
    at: function(wid, s){ var L = lineTo(wid) || lines[0]; if(!L) return null; var p = at(L.out, s); return {x: p.x - hp.x, y: p.y, z: p.z - hp.z, yaw: p.yaw}; },
    // a fixed camera for headless shots (null: back to normal): through the City's w.camPose
    look: function(pos, look, fov){ shotCam = pos && look ? {camera: true, pos: pos, look: look, fov: fov || 55} : null; },
    refresh: refresh, build: function(wid){ var p = placesOf(arch).filter(function(x){ return x.world === wid; })[0]; return p ? build(p) : Promise.resolve(false); }
  };
  // the station whose door you stand at (STATION_R m), else null: E there opens the station's menu
  function station(x, z){ var st = stationOf(o.W), d = st && !(st.tier > (o.tier || 5)) && doorOf(st); return d && hyp(x - d.x, z - d.z) <= STATION_R ? st : null; }
  return {update: update, carry: carry, use: use, rows: rows, station: station, has: function(wid){ return !!lineTo(wid); }, setNight: setNight, destroy: destroy, tools: tools,
          riding: function(){ return ours(RIDE.trip); }};
}
HQV.hqRail.mount = mount;
HQV.hqRail.view = lineView;
HQV.hqRail.linkView = linkView;
// the few-draw-call drawing kit, shared by games/hqcityrail.js and games/hqgondola.js
HQV.hqRail.parts = {kit: kit, vcMat: vcMat, trainKit: trainKit, carsOf: carsOf, interiorKit: interiorKit, commuterKit: commuterKit, ridersOf: ridersOf,
  carGeo: carGeo, samples: samples, extrude: extrude, DECK: DECK, PIER_EVERY: PIER_EVERY, MAST_EVERY: MAST_EVERY, DRAW_R: DRAW_R,
  nearOn: nearOn, earAt: earAt, trainPool: trainPool, SND_R: SND_R};
HQV.hqRail.ride = RIDE;
})();
