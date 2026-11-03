/* Claude HQ: the Island Link's stations (HQV.hqILStation). [island trains]
 *
 * Each world's elevated IL station (HQV.hqRail.linkStation: Commons Central's six tracks and three island platforms, an
 * island's own terminal on its coast) as a place you walk through: a ticket hall at street level under the platforms
 * (doors on its street end, ticket machines, a gate line with lanes before each platform's stairs, a departures board),
 * a stair up to each platform through the hall's roof, the platforms under canopies (their numbers, a board each, the
 * way out), the trains' doors sliding open on the platform side, and the people who use it: residents walk in, through
 * the gates, up to their platform, wait, and walk in through an open door; off an arriving train, they walk out.
 *
 * Pure top half (no THREE, no DOM; tests/test_hqilstation.py runs it under node):
 *   layout(spec) -> L. spec = linkStation(). The station's frame: u along the way out (ax, az), v to its left (az, -ax),
 *     y absolute. L.hall {u0, u1, v0, v1, h}, L.doors [{v0, v1}] (on the u0 wall), L.stairs [{c, hw, u0, u1, y0, y1}],
 *     L.plats [{c, hw, u0, u1, tracks, label}], L.wells, L.gate {u, lanes [{v, hw}]}, L.machines [{u, v, yaw}], L.yp, L.ys;
 *     loc(x, z) -> {u, v}, world(u, v) -> {x, z};
 *     floorAt(x, y, z) -> {y, kind ("hall" | "stairs" | "platform"), plat} | null: the highest floor at most STEP_UP over y;
 *     blocked(x, z, feet, gateOk) -> true | false | null (null: not the station's business, the street decides);
 *     gateAt(x, z, feet) -> {lane (-1: cabinet or glass), v} | null; paidAt(x, z, feet) -> true past the gates (the stairs,
 *     the platforms), false on the street side of the hall, null outside; inside(x, y, z) (in the hall or on a platform);
 *     camHit(a, b) -> 0..1 (the hall's walls and roof, the platforms' slabs and canopies); ceilAt(x, y, z) -> y | null;
 *     machineAt(x, z, feet, r) -> machine | null; doorsOf(R, along, o, side) -> the train's platform-side doors (world);
 *     walkers(lines, ms, o) -> [{id, x, y, z, yaw, anim, speed, lk}] the station's passengers now (below).
 *   Passengers: per departure from here (o.departures(ms) [{line, at (ms), track (v), plat (index into L.plats), doors}]),
 *     3-8 people (hash of the departure) arrive from the street 40 m out in front of the doors, walk in, through a lane,
 *     up the stairs and along to a spot near their door, wait, and walk into it once the doors open; per arrival here
 *     (o.arrivals) 2-7 step out of the doors as they open and walk the other way, out into the street. Where each one is
 *     is a pure function of (station, departure, person, UTC ms): the same on every client, no traffic.
 * Drawing (THREE through hq3d's ctx): view(c, L, o) -> V {g, update(ms, dt, cam, info), drawCalls(), dispose()}: the hall,
 *   gates, machines, stairs, platforms, canopies, track bed and piers merged into one vertex-coloured mesh, the lamps in
 *   one unlit mesh, the signs and boards on canvas textures (one call a board), the gate paddles and the trains' door
 *   leaves instanced. Calm and reduced motion: paddles and doors snap. Never Math.random: everything is hashed.
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : self;
var HQV = root.HQV = root.HQV || {};

var HALL_U0 = -24, HALL_U1 = 2, HALL_H = 4.4, STAIR_U0 = -6, STAIR_HW = 1.0, SLOPE = 0.6;
var GATE_U = -15, GATE_BAND = 0.45, LANE_HW = 0.42, LANES = [-1.65, -0.55, 0.55, 1.65];
var WALL = 0.3, STEP_UP = 0.75, DOOR_HW = 1.6, CANOPY = 3.6, PLAT_TOP = 0.95, EDGE = 0.3;
var CAR_L = 17, CAR_GAP = 1.2, CARS = 4, DOOR_Z = CAR_L*0.22, DOOR_LAT = 1.47;
var WALK_V = 1.3, OUT_U = 40;           // m/s a passenger walks; m out from the doors they come from and go to

function hyp(x, z){ return Math.sqrt(x*x + z*z); }
function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function hash32(s){ s = String(s); var h = 2166136261 >>> 0; for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function u01(s){ var h = hash32(s); h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; return (h >>> 0)/4294967296; }

/* ---------- the layout (pure) ---------- */
function layout(spec){
  if(!spec) return null;
  var ax = +spec.ax || 0, az = +spec.az || 1, al = hyp(ax, az) || 1; ax /= al; az /= al;
  var lx = az, lz = -ax, ox = +spec.x || 0, oz = +spec.z || 0, yr = +spec.yr || 0, yp = yr + PLAT_TOP, ys = +spec.ys || 0;
  var half = (+spec.len || 110)/2;
  var L = {id: spec.id, spec: spec, x: ox, z: oz, ax: ax, az: az, lx: lx, lz: lz, yaw: Math.atan2(ax, az), yr: yr, yp: yp, ys: ys, half: half,
           commons: !!spec.commons, name: spec.name || ""};
  function loc(x, z){ var dx = x - ox, dz = z - oz; return {u: dx*ax + dz*az, v: dx*lx + dz*lz}; }
  function world(u, v){ return {x: ox + ax*u + lx*v, z: oz + az*u + lz*v}; }
  L.loc = loc; L.world = world;
  var rise = Math.max(1, yp - ys), run = rise/SLOPE;
  L.plats = (spec.plats || []).map(function(p, i){
    var tr = (spec.tracks || []).filter(function(t){ return (p.tracks || []).indexOf(t.plat) >= 0; });
    return {i: i, c: +p.c || 0, hw: +p.hw || 2.5, u0: -half, u1: half, tracks: tr.map(function(t){ return {plat: t.plat, v: t.v}; }),
            label: tr.map(function(t){ return String(t.plat); }).join(" | ")};
  });
  var vmin = Infinity, vmax = -Infinity;
  L.plats.forEach(function(p){ vmin = Math.min(vmin, p.c - p.hw); vmax = Math.max(vmax, p.c + p.hw); });
  if(!isFinite(vmin)){ vmin = -3; vmax = 3; }
  L.hall = {u0: HALL_U0, u1: HALL_U1, v0: vmin - 3, v1: vmax + 3, h: HALL_H};
  L.doors = L.plats.map(function(p){ return {v0: p.c - DOOR_HW, v1: p.c + DOOR_HW}; });
  L.stairs = L.plats.map(function(p){ return {plat: p.i, c: p.c, hw: STAIR_HW, u0: STAIR_U0, u1: STAIR_U0 + run, y0: ys, y1: yp}; });
  L.wells = L.stairs.map(function(s){ return {plat: s.plat, u0: HALL_U1, u1: s.u1, v0: s.c - s.hw - 0.15, v1: s.c + s.hw + 0.15}; });
  L.roofHoles = L.stairs.map(function(s){ return {u0: s.u0 + 3, u1: HALL_U1 + 0.5, v0: s.c - s.hw - 0.15, v1: s.c + s.hw + 0.15}; });
  L.gate = {u: GATE_U, lanes: []};
  L.plats.forEach(function(p){ LANES.forEach(function(d){ L.gate.lanes.push({v: p.c + d, hw: LANE_HW, plat: p.i}); }); });
  // the ticket machines: on the side walls of the street side, three a wall (the Commons' both walls, an island's left one)
  L.machines = [];
  [L.hall.v1, L.commons ? L.hall.v0 : null].forEach(function(wv, k){
    if(wv == null) return;
    [-21.6, -19.6, -17.6].forEach(function(u){ L.machines.push({u: u, v: wv + (k ? 0.55 : -0.55), side: k ? 1 : -1}); });
  });
  L.machines.forEach(function(m){ var w = world(m.u, m.v); m.x = w.x; m.z = w.z; m.yaw = Math.atan2(lx*m.side, lz*m.side); });
  L.stairTopU = STAIR_U0 + run;
  var H = L.hall;
  function inRect(p, u0, u1, v0, v1, m){ m = m || 0; return p.u >= u0 - m && p.u <= u1 + m && p.v >= v0 - m && p.v <= v1 + m; }
  function stairY(s, u){ return s.y0 + clamp((u - s.u0)/(s.u1 - s.u0), 0, 1)*(s.y1 - s.y0); }
  function inWell(p){ for(var i = 0; i < L.wells.length; i++){ var w = L.wells[i]; if(inRect(p, w.u0, w.u1, w.v0, w.v1)) return true; } return false; }
  // the floors at (x, z): the highest at most STEP_UP over y (y null: the highest)
  L.floorAt = function(x, y, z){
    var p = loc(x, z), best = null, lim = y == null || !isFinite(y) ? Infinity : y + STEP_UP;
    function take(fy, kind, plat){ if(fy <= lim && (!best || fy > best.y)) best = {y: fy, kind: kind, plat: plat}; }
    L.stairs.forEach(function(s){ if(inRect(p, s.u0, s.u1, s.c - s.hw, s.c + s.hw)) take(stairY(s, p.u), "stairs", s.plat); });
    if(!inWell(p)) L.plats.forEach(function(q){ if(inRect(p, q.u0, q.u1, q.c - q.hw, q.c + q.hw)) take(yp, "platform", q.i); });
    if(inRect(p, H.u0 + WALL, H.u1 - WALL, H.v0 + WALL, H.v1 - WALL)) take(ys, "hall", -1);
    return best;
  };
  L.upper = function(feet){ return feet != null && isFinite(feet) && feet > ys + 1.2; };
  L.inHall = function(x, z, m){ return inRect(loc(x, z), H.u0, H.u1, H.v0, H.v1, m || 0); };
  L.gateAt = function(x, z, feet){
    if(L.upper(feet)) return null;
    var p = loc(x, z);
    if(Math.abs(p.u - GATE_U) > GATE_BAND || p.v < H.v0 || p.v > H.v1) return null;
    for(var i = 0; i < L.gate.lanes.length; i++){ var ln = L.gate.lanes[i]; if(Math.abs(p.v - ln.v) <= ln.hw) return {lane: i, v: ln.v, plat: ln.plat}; }
    return {lane: -1, v: p.v};
  };
  L.paidAt = function(x, z, feet){
    var p = loc(x, z);
    if(L.upper(feet)) return L.floorAt(x, feet, z) ? true : null;
    if(!inRect(p, H.u0, H.u1, H.v0, H.v1)) return null;
    return p.u > GATE_U;
  };
  // may you step to (x, z)? feet: your feet's height; gateOk(): a gate lane opens for you
  L.blocked = function(x, z, feet, gateOk){
    var p = loc(x, z), i;
    if(L.upper(feet)){
      var f = L.floorAt(x, feet, z);
      if(!f || f.y < feet - STEP_UP) return true;
      // a body's width clear of every edge (the tracks, a well, a platform's end)
      var offs = [[EDGE, 0], [-EDGE, 0], [0, EDGE], [0, -EDGE]];
      for(i = 0; i < offs.length; i++){ var f2 = L.floorAt(x + offs[i][0], feet, z + offs[i][1]); if(!f2 || f2.y < feet - 0.6) return true; }
      return false;
    }
    // the stairs: walked on and off at their foot only (never from the side, nor under them)
    for(i = 0; i < L.stairs.length; i++){
      var s = L.stairs[i];
      if(inRect(p, s.u0, s.u1, s.c - s.hw - 0.3, s.c + s.hw + 0.3) && (stairY(s, p.u) > (feet != null ? feet : ys) + STEP_UP || Math.abs(p.v - s.c) > s.hw)
         && p.u > s.u0 + 0.2) return true;
    }
    if(!inRect(p, H.u0, H.u1, H.v0, H.v1, WALL)) return null;
    if(!inRect(p, H.u0, H.u1, H.v0, H.v1, -WALL)){
      // the walls: open only through a door in the street end's
      if(p.u < H.u0 + WALL && p.u > H.u0 - WALL - 0.01){ for(i = 0; i < L.doors.length; i++) if(p.v > L.doors[i].v0 + 0.3 && p.v < L.doors[i].v1 - 0.3) return false; }
      return true;
    }
    var g = L.gateAt(x, z, feet);
    if(g && (g.lane < 0 || !(typeof gateOk === "function" ? gateOk() : true))) return true;
    // the machines stand against the wall
    for(i = 0; i < L.machines.length; i++){ var m = L.machines[i]; if(Math.abs(p.u - m.u) < 0.75 && Math.abs(p.v - m.v) < 0.6) return true; }
    return false;
  };
  L.inside = function(x, y, z){
    var p = loc(x, z);
    if(inRect(p, H.u0, H.u1, H.v0, H.v1) && y >= ys - 0.2 && y <= ys + HALL_H) return true;
    return !!(L.floorAt(x, y, z) && y >= ys + 1.2);
  };
  L.ceilAt = function(x, y, z){
    var p = loc(x, z);
    if(y != null && y < ys + HALL_H && inRect(p, H.u0, H.u1, H.v0, H.v1)){
      for(var i = 0; i < L.roofHoles.length; i++){ var r = L.roofHoles[i]; if(inRect(p, r.u0, r.u1, r.v0, r.v1)) return null; }
      return ys + HALL_H;
    }
    if(y != null && y >= yp - 0.5 && y < yp + CANOPY) for(var k = 0; k < L.plats.length; k++){ var q = L.plats[k]; if(inRect(p, q.u0, q.u1, q.c - q.hw - 0.6, q.c + q.hw + 0.6)) return yp + CANOPY; }
    return null;
  };
  // the boxes the camera may not pass ([u0, u1, y0, y1, v0, v1], local), and the one the camera starts in keeps it in
  var BOX = [];
  L.plats.forEach(function(q){
    BOX.push([q.u0, q.u1, yp - 0.6, yp - 0.02, q.c - q.hw, q.c + q.hw]);                           // the platform's slab
    BOX.push([q.u0, q.u1, yp + CANOPY, yp + CANOPY + 0.35, q.c - q.hw - 0.6, q.c + q.hw + 0.6]);   // its canopy
  });
  function seg(a, b, B){
    var t0 = 0, t1 = 1, A = [a.u, a.y, a.v], D = [b.u - a.u, b.y - a.y, b.v - a.v];
    for(var k = 0; k < 3; k++){
      var lo = B[2*k], hi = B[2*k + 1];
      if(Math.abs(D[k]) < 1e-9){ if(A[k] < lo || A[k] > hi) return null; continue; }
      var ta = (lo - A[k])/D[k], tb = (hi - A[k])/D[k]; if(ta > tb){ var tt = ta; ta = tb; tb = tt; }
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb); if(t0 > t1) return null;
    }
    return [t0, t1];
  }
  L.camHit = function(a, b){
    var A = loc(a.x, a.z), Bq = loc(b.x, b.z), pa = {u: A.u, v: A.v, y: a.y}, pb = {u: Bq.u, v: Bq.v, y: b.y}, t = 1, m = 0.25;
    var len = Math.sqrt((pb.u - pa.u)*(pb.u - pa.u) + (pb.v - pa.v)*(pb.v - pa.v) + (pb.y - pa.y)*(pb.y - pa.y)) || 1, mt = m/len;
    var HB = [H.u0, H.u1, ys, ys + HALL_H, H.v0, H.v1];
    var inHallA = A.u > H.u0 && A.u < H.u1 && A.v > H.v0 && A.v < H.v1 && a.y > ys && a.y < ys + HALL_H;
    if(inHallA){
      // stay inside: where the ray leaves the hall's box (a stair's hole in the roof lets it up)
      var s = seg(pa, pb, HB), ex = s ? s[1] : 0;
      if(ex < 1){
        var q = {u: pa.u + (pb.u - pa.u)*ex, v: pa.v + (pb.v - pa.v)*ex, y: pa.y + (pb.y - pa.y)*ex}, hole = false;
        if(q.y >= ys + HALL_H - 0.05) L.roofHoles.forEach(function(r){ if(q.u >= r.u0 && q.u <= r.u1 && q.v >= r.v0 && q.v <= r.v1) hole = true; });
        if(!hole) t = Math.max(0, ex - mt);
      }
    } else {
      var s2 = seg(pa, pb, HB); if(s2 && s2[0] > 0) t = Math.min(t, Math.max(0, s2[0] - mt));
    }
    BOX.forEach(function(B){ var s3 = seg(pa, pb, B); if(s3 && s3[0] > 1e-4) t = Math.min(t, Math.max(0, s3[0] - mt)); });
    return t;
  };
  L.machineAt = function(x, z, feet, r){
    if(L.upper(feet)) return null;
    var best = null, bd = r || 2.3;
    L.machines.forEach(function(m){ var d = hyp(m.x - x, m.z - z); if(d < bd){ bd = d; best = m; } });
    return best;
  };
  // a train's doors on the platform side (world frame): R its route, along its head's place, o the world's origin, side
  // +1 (the left of the way the train faces) or -1
  L.doorsOf = function(R, along, o, side){
    var RL = HQV.hqRail; if(!RL || !R) return [];
    var cars = RL.parts && RL.parts.carsOf ? RL.parts.carsOf(R, along, o || {x: 0, z: 0}) : [], out = [];
    cars.forEach(function(cp, k){
      [-DOOR_Z, DOOR_Z].forEach(function(dz, j){
        var c = Math.cos(cp.yaw), s = Math.sin(cp.yaw), lat = side*DOOR_LAT;
        out.push({car: k, j: j, x: cp.x + s*dz + c*lat, y: cp.y + PLAT_TOP, z: cp.z + c*dz - s*lat, yaw: cp.yaw, side: side});
      });
    });
    return out;
  };
  return L;
}

/* ---------- the passengers (pure) ---------- */
// a walker's polyline in the station's frame ([u, v, y]) and its timing: through the doors, a lane, up the stairs and
// along the platform to `wait`; reversed for those getting off
function legOf(L, plat, laneV, entryV, wait){
  var s = L.stairs[plat], ys = L.ys, yp = L.yp;
  return [[L.hall.u0 - OUT_U, entryV + (entryV - s.c)*3, ys], [L.hall.u0 - 1.5, entryV, ys], [GATE_U - 1.2, laneV, ys], [GATE_U + 1.2, laneV, ys],
          [s.u0 - 0.6, s.c, ys], [s.u1 + 0.8, s.c, yp], [wait[0], wait[1], yp]];
}
function lenOf(P){ var d = 0; for(var i = 1; i < P.length; i++) d += Math.sqrt(Math.pow(P[i][0] - P[i-1][0], 2) + Math.pow(P[i][1] - P[i-1][1], 2) + Math.pow(P[i][2] - P[i-1][2], 2)); return d; }
function along(P, d){
  for(var i = 1; i < P.length; i++){
    var a = P[i - 1], b = P[i], l = Math.sqrt(Math.pow(b[0] - a[0], 2) + Math.pow(b[1] - a[1], 2) + Math.pow(b[2] - a[2], 2));
    if(d <= l || i === P.length - 1){ var f = l > 1e-9 ? clamp(d/l, 0, 1) : 1; return {u: a[0] + (b[0] - a[0])*f, v: a[1] + (b[1] - a[1])*f, y: a[2] + (b[2] - a[2])*f, du: b[0] - a[0], dv: b[1] - a[1]}; }
    d -= l;
  }
  var e = P[P.length - 1]; return {u: e[0], v: e[1], y: e[2], du: 0, dv: 1};
}
// the people in the station at ms: o.deps [{key, at (doors close), open (doors open), plat, track (v), side, doors [{x, z}]}]
// (trains leaving here) and o.arrs [{key, at (doors open), plat, track, side, doors}] (trains that came in), o.max people
function walkers(L, ms, o){
  o = o || {};
  var out = [], max = o.max || 60;
  function row(id, key, k, p, anim, yawU, yawV, lk){
    var w = L.world(p.u, p.v), yaw = Math.atan2(L.ax*yawU + L.lx*yawV, L.az*yawU + L.lz*yawV);
    out.push({id: id, x: w.x, y: p.y, z: w.z, yaw: yaw, anim: anim, speed: anim === "walk" ? WALK_V : 0, lk: lk, key: key + ":" + k, station: true});
  }
  (o.deps || []).forEach(function(d, di){
    var n = 3 + (hash32("ilb:" + d.key) % 6);
    for(var k = 0; k < n && out.length < max; k++){
      var key = "ilb:" + d.key + ":" + k, plat = d.plat, P0 = L.plats[plat]; if(!P0) continue;
      var lane = L.gate.lanes.filter(function(ln){ return ln.plat === plat; })[Math.floor(u01(key + "l")*4) % 4] || {v: P0.c};
      var door = d.doors && d.doors.length ? d.doors[Math.floor(u01(key + "d")*d.doors.length) % d.doors.length] : null;
      var dl = door ? L.loc(door.x, door.z) : {u: 0, v: d.track};
      var wv = P0.c + (d.track > P0.c ? 1 : -1)*Math.min(P0.hw - 0.5, 0.8 + u01(key + "w")*0.9), wu = clamp(dl.u + (u01(key + "o") - 0.5)*3, L.half*-1 + 3, L.half - 3);
      // (never in a stair's well)
      var well = L.wells[plat]; if(well && wu > well.u0 - 0.6 && wu < well.u1 + 0.6 && Math.abs(wv - P0.c) < STAIR_HW + 0.6) wu = well.u1 + 1.2 + u01(key + "q")*4;
      var P = legOf(L, plat, lane.v, P0.c + (u01(key + "e") - 0.5)*2.4, [wu, wv]), len = lenOf(P), walkS = len/WALK_V;
      var reach = d.open - (8 + u01(key + "t")*120)*1000;                     // on the platform before the doors open, or soon after
      if(u01(key + "late") < 0.3) reach = d.open + (2 + u01(key + "t2")*Math.max(1, (d.at - d.open)/1000 - 14))*1000;
      var t0 = reach - walkS*1000, toDoor = Math.sqrt(Math.pow(dl.u - wu, 2) + Math.pow(dl.v - wv, 2))/WALK_V*1000, goAt = Math.max(reach, d.open + 1500 + u01(key + "g")*4000);
      if(ms < t0 || ms > goAt + toDoor) continue;
      var id = 9e8 + (hash32(key) % 1e7), lk = hash32(key + "lk") % 997;
      if(ms < reach){ var q = along(P, (ms - t0)/1000*WALK_V); row(id, "b", key, q, "walk", q.du, q.dv, lk); }
      else if(ms < goAt){ row(id, "b", key, {u: wu, v: wv, y: L.yp}, "idle", dl.u - wu, dl.v - wv, lk); }
      else { var f = clamp((ms - goAt)/Math.max(1, toDoor), 0, 1); row(id, "b", key, {u: wu + (dl.u - wu)*f, v: wv + (dl.v - wv)*f, y: L.yp}, "walk", dl.u - wu, dl.v - wv, lk); }
    }
  });
  (o.arrs || []).forEach(function(a){
    var n = 2 + (hash32("ila:" + a.key) % 6);
    for(var k = 0; k < n && out.length < max; k++){
      var key = "ila:" + a.key + ":" + k, plat = a.plat, P0 = L.plats[plat]; if(!P0) continue;
      var door = a.doors && a.doors.length ? a.doors[Math.floor(u01(key + "d")*a.doors.length) % a.doors.length] : null;
      var dl = door ? L.loc(door.x, door.z) : {u: 0, v: a.track};
      var lane = L.gate.lanes.filter(function(ln){ return ln.plat === plat; })[Math.floor(u01(key + "l")*4) % 4] || {v: P0.c};
      var step = [dl.u, P0.c + (a.track > P0.c ? 1 : -1)*0.9, L.yp];
      var P = legOf(L, plat, lane.v, P0.c + (u01(key + "e") - 0.5)*2.4, [step[0], step[1]]).reverse();
      P.unshift([dl.u, dl.v, L.yp]);
      var t0 = a.at + (1.5 + k*1.2 + u01(key + "t")*3)*1000, len = lenOf(P);
      if(ms < t0 || ms > t0 + len/WALK_V*1000) continue;
      var id2 = 9e8 + (hash32(key) % 1e7), q2 = along(P, (ms - t0)/1000*WALK_V);
      row(id2, "a", key, q2, "walk", q2.du, q2.dv, hash32(key + "lk") % 997);
    }
  });
  return out;
}

/* ---------- drawing (THREE) ---------- */
var COL = {floor: 0xd9d4ca, wallOut: 0x4b3f66, wallIn: 0xeeeae2, roof: 0x7d7a86, trim: 0x6d4bb3, step: 0xb7b2a8, stepNose: 0xe2b63c,
           plat: 0xb9b4aa, edge: 0xf2c230, slab: 0x8e8a84, bed: 0x6f6a62, rail: 0x7c858e, col: 0x9da1a6, canopy: 0x6b6878, glass: 0x9fc3d6,
           ceil: 0xd6d1c6, canopyUnder: 0x9c99a8, under: 0x6f6c66, cab: 0x3a3f46, cabTop: 0xc7ccd2, mach: 0x2f6f9f, screen: 0xbfe6ff, lamp: 0xfff1d6, rail2: 0x8b8f96, pier: 0xa9adb1};
function view(c, L, o){
  o = o || {};
  var THREE = c.THREE, P = HQV.hqRail && HQV.hqRail.parts, K = P.kit(THREE), parts = [], lamps = [], soft = [];
  var g = new THREE.Group(); g.name = "il:station"; g.position.set(L.x, 0, L.z); g.rotation.y = L.yaw;
  // (local: x = v, z = u, y absolute)
  function bx(u0, u1, y0, y1, v0, v1, hex, list){ (list || parts).push(K.box(Math.max(0.01, v1 - v0), Math.max(0.01, y1 - y0), Math.max(0.01, u1 - u0), (v0 + v1)/2, (y0 + y1)/2, (u0 + u1)/2, hex)); }
  var H = L.hall, ys = L.ys, yp = L.yp, yr = L.yr, half = L.half;
  // the hall: its floor, walls (an outer skin and an inner one), the doors in its street end, the roof with the stairs' holes
  bx(H.u0, H.u1, ys - 0.25, ys + 0.03, H.v0, H.v1, COL.floor);
  function wallU(u, v0, v1, gaps){                                      // a wall across the hall at u (from v0 to v1)
    var cuts = [v0].concat([].concat.apply([], (gaps || []).map(function(d){ return [d.v0, d.v1]; })), [v1]);
    for(var i = 0; i + 1 < cuts.length; i += 2){ if(cuts[i + 1] - cuts[i] < 0.05) continue;
      bx(u - WALL, u - 0.05, ys, ys + H.h, cuts[i], cuts[i + 1], u < 0 ? COL.wallOut : COL.wallIn); bx(u - 0.05, u + 0.05, ys, ys + H.h, cuts[i], cuts[i + 1], COL.wallIn); }
    (gaps || []).forEach(function(d){ bx(u - WALL, u + 0.05, ys + 2.8, ys + H.h, d.v0, d.v1, COL.wallOut); bx(u - WALL - 0.05, u - WALL + 0.02, ys + 2.85, ys + 3.4, d.v0 - 0.2, d.v1 + 0.2, COL.trim); });
  }
  wallU(H.u0 + 0.05, H.v0 - WALL, H.v1 + WALL, L.doors);
  bx(H.u1, H.u1 + WALL, ys, ys + H.h, H.v0 - WALL, H.v1 + WALL, COL.wallOut); bx(H.u1 - 0.08, H.u1, ys, ys + H.h, H.v0, H.v1, COL.wallIn);
  [[H.v0 - WALL, H.v0, H.v0, H.v0 + 0.08], [H.v1, H.v1 + WALL, H.v1 - 0.08, H.v1]].forEach(function(w){
    bx(H.u0, H.u1, ys, ys + H.h, w[0], w[1], COL.wallOut); bx(H.u0, H.u1, ys, ys + H.h, w[2], w[3], COL.wallIn);
  });
  bx(H.u0 - 0.4, H.u1 + 0.4, ys + H.h + 0.25, ys + H.h + 0.45, H.v0 - 0.6, H.v1 + 0.6, COL.trim);           // the roof's purple band
  // the roof, in strips round the holes
  var vs = [H.v0 - WALL, H.v1 + WALL]; L.roofHoles.forEach(function(r){ vs.push(r.v0, r.v1); }); vs.sort(function(a, b){ return a - b; });
  for(var i = 0; i + 1 < vs.length; i++){
    var va = vs[i], vb = vs[i + 1], mid = (va + vb)/2, hole = L.roofHoles.filter(function(r){ return mid > r.v0 && mid < r.v1; })[0];
    if(vb - va < 0.02) continue;
    if(hole){ bx(H.u0 - WALL, hole.u0, ys + H.h, ys + H.h + 0.3, va, vb, COL.roof); if(hole.u1 < H.u1 + WALL) bx(hole.u1, H.u1 + WALL, ys + H.h, ys + H.h + 0.3, va, vb, COL.roof);
      bx(H.u0, hole.u0, ys + H.h - 0.02, ys + H.h, Math.max(va, H.v0), Math.min(vb, H.v1), COL.ceil, soft); if(hole.u1 < H.u1) bx(hole.u1, H.u1, ys + H.h - 0.02, ys + H.h, Math.max(va, H.v0), Math.min(vb, H.v1), COL.ceil, soft); }
    else { bx(H.u0 - WALL, H.u1 + WALL, ys + H.h, ys + H.h + 0.3, va, vb, COL.roof); bx(H.u0, H.u1, ys + H.h - 0.02, ys + H.h, Math.max(va, H.v0), Math.min(vb, H.v1), COL.ceil, soft); }
  }
  // the ceiling's lamps (lines along the hall) and the doors' canopies
  for(var lv = H.v0 + 2; lv < H.v1 - 1; lv += 4) for(var lu = H.u0 + 2; lu < H.u1 - 2; lu += 6){
    var inHole = L.roofHoles.some(function(r){ return lv > r.v0 - 0.5 && lv < r.v1 + 0.5 && lu + 4 > r.u0; });
    if(!inHole) bx(lu, lu + 4, ys + H.h - 0.06, ys + H.h - 0.02, lv - 0.12, lv + 0.12, COL.lamp, lamps);
  }
  L.doors.forEach(function(d){ bx(H.u0 - 2.2, H.u0, ys + 3.2, ys + 3.4, d.v0 - 0.4, d.v1 + 0.4, COL.canopy); bx(H.u0 - 2.1, H.u0 - 0.1, ys + 3.18, ys + 3.2, d.v0 - 0.2, d.v1 + 0.2, COL.lamp, lamps); });
  // the gate line: a cabinet between lanes, glass where there are none
  var lanes = L.gate.lanes.slice().sort(function(a, b){ return a.v - b.v; }), gv = [H.v0];
  lanes.forEach(function(ln){ gv.push(ln.v - ln.hw, ln.v + ln.hw); }); gv.push(H.v1);
  for(var gi = 0; gi + 1 < gv.length; gi += 2){
    var a0 = gv[gi], a1 = gv[gi + 1]; if(a1 - a0 < 0.02) continue;
    if(a1 - a0 < 0.6){ bx(GATE_U - 0.45, GATE_U + 0.45, ys, ys + 1.0, a0, a1, COL.cab); bx(GATE_U - 0.45, GATE_U + 0.45, ys + 1.0, ys + 1.05, a0, a1, COL.cabTop); }
    else { bx(GATE_U - 0.04, GATE_U + 0.04, ys, ys + 1.6, a0, a1, COL.glass); bx(GATE_U - 0.06, GATE_U + 0.06, ys + 1.6, ys + 1.66, a0, a1, COL.cab); }
  }
  // the ticket machines
  L.machines.forEach(function(m){
    var s = m.side; bx(m.u - 0.4, m.u + 0.4, ys, ys + 1.8, m.v - 0.25, m.v + 0.25, COL.mach);
    bx(m.u - 0.3, m.u + 0.3, ys + 1.1, ys + 1.55, m.v + s*0.25 - 0.01, m.v + s*0.25 + 0.01, COL.screen, lamps);
  });
  // the stairs: steps, their side walls (to the hall's roof inside it, up to the platform beyond), handrails
  L.stairs.forEach(function(s){
    var n = Math.ceil((s.u1 - s.u0)/0.3), du = (s.u1 - s.u0)/n, dy = (s.y1 - s.y0)/n;
    for(var k = 0; k < n; k++){
      var u0 = s.u0 + k*du, y1 = s.y0 + (k + 1)*dy;
      bx(u0, u0 + du + 0.01, Math.max(s.y0, y1 - 0.6), y1, s.c - s.hw, s.c + s.hw, COL.step);
      bx(u0 + du - 0.05, u0 + du + 0.01, y1 - 0.02, y1 + 0.005, s.c - s.hw, s.c + s.hw, COL.stepNose);
      [-1, 1].forEach(function(e){
        // in the hall a glass balustrade, then (through the roof and on up under the platform) a closed tube's wall
        var inH = u0 < H.u1, bot = inH ? Math.max(s.y0, y1 - 1.2) : s.y0, top = y1 + 1.05, glass = inH && top <= ys + H.h;
        bx(u0, u0 + du + 0.01, bot, top, s.c + e*(s.hw + 0.02), s.c + e*(s.hw + 0.14), glass ? COL.glass : COL.wallOut);
      });
    }
    [-1, 1].forEach(function(e){ parts.push(K.strut([s.c + e*(s.hw - 0.05), s.y0 + 0.95, s.u0], [s.c + e*(s.hw - 0.05), s.y1 + 0.95, s.u1], 0.05, COL.rail2)); });
  });
  // the platforms: the slab round the wells, the yellow edges, the canopy on columns, its lamps, the wells' railings
  L.plats.forEach(function(q){
    var w = L.wells[q.i], v0 = q.c - q.hw, v1 = q.c + q.hw;
    bx(q.u0, w.u0, yp - 0.6, yp, v0, v1, COL.plat); bx(w.u1, q.u1, yp - 0.6, yp, v0, v1, COL.plat);
    bx(w.u0, w.u1, yp - 0.6, yp, v0, w.v0, COL.plat); bx(w.u0, w.u1, yp - 0.6, yp, w.v1, v1, COL.plat);
    [v0, v1].forEach(function(e, k){ bx(q.u0, q.u1, yp, yp + 0.01, k ? e - 0.45 : e, k ? e : e + 0.45, COL.edge); });
    bx(q.u0, q.u1, yp + CANOPY, yp + CANOPY + 0.25, v0 - 0.6, v1 + 0.6, COL.canopy);
    bx(q.u0, q.u1, yp + CANOPY - 0.02, yp + CANOPY, v0 - 0.6, v1 + 0.6, COL.canopyUnder, soft);
    bx(q.u0, q.u1, yp - 0.62, yp - 0.6, v0, v1, COL.under, soft);
    [v0 - 0.7, v1 + 0.6].forEach(function(e){ bx(q.u0, q.u1, yp + CANOPY - 0.1, yp + CANOPY + 0.32, e, e + 0.1, COL.trim); });   // a purple fascia each side
    for(var cu = q.u0 + 4; cu < q.u1 - 2; cu += 12){
      if(cu > w.u0 - 1.5 && cu < w.u1 + 1.5) continue;
      parts.push(K.cyl(0.14, 0.16, CANOPY, 10, q.c, yp, cu, COL.col));
    }
    bx(q.u0 + 1, q.u1 - 1, yp + CANOPY - 0.06, yp + CANOPY - 0.01, q.c - 0.15, q.c + 0.15, COL.lamp, lamps);
    [w.v0, w.v1].forEach(function(e){ bx(w.u0, w.u1, yp, yp + 1.05, e - 0.03, e + 0.03, COL.glass); bx(w.u0, w.u1, yp + 1.05, yp + 1.1, e - 0.05, e + 0.05, COL.rail2); });
    bx(w.u0 - 0.03, w.u0 + 0.03, yp, yp + 1.1, w.v0, w.v1, COL.glass);
    [q.u0, q.u1].forEach(function(e){ bx(e - 0.03, e + 0.03, yp, yp + 1.1, v0, v1, COL.rail2); });
  });
  // the track bed under every track (between the platforms, so nothing shows through to the street), the rails of the
  // tracks no line uses, and the piers under the deck outside the hall
  var tv = (L.spec.tracks || []).map(function(t){ return t.v; }), bv0 = Math.min.apply(null, tv.concat([H.v0 + 3])) - 2.6, bv1 = Math.max.apply(null, tv.concat([H.v1 - 3])) + 2.6;
  bx(-half, half, yr - 0.9, yr - 0.25, bv0, bv1, COL.slab);
  bx(-half, half, yr - 0.92, yr - 0.9, bv0, bv1, COL.under, soft);
  bx(-half, half, yr - 0.25, yr - 0.2, bv0, bv1, COL.bed);
  [bv0, bv1].forEach(function(e, k){ bx(-half, half, yr - 0.25, yr + 0.9, k ? e - 0.25 : e, k ? e : e + 0.25, COL.slab); });
  (L.spec.tracks || []).forEach(function(t){ if((o.used || []).indexOf(t.plat) >= 0) return; [-0.75, 0.75].forEach(function(r){ bx(-half, half, yr - 0.2, yr, t.v + r - 0.04, t.v + r + 0.04, COL.rail); }); });
  [-half + 4, -half + 18, 16, 30, half - 6].forEach(function(u){
    if(u > H.u0 - 1 && u < H.u1 + 1) return;
    [bv0 + 1.2, (bv0 + bv1)/2, bv1 - 1.2].forEach(function(v){
      if(L.stairs.some(function(s){ return u > s.u0 - 1 && u < s.u1 + 1 && Math.abs(v - s.c) < s.hw + 0.8; })) return;
      var gy = typeof o.ground === "function" ? o.ground(L.world(u, v).x, L.world(u, v).z) : ys; if(!isFinite(gy)) gy = ys;
      parts.push(K.cyl(0.55, 0.65, Math.max(0.5, yr - 0.9 - gy), 12, v, gy, u, COL.pier));
    });
  });
  var mat = P.vcMat(c, {roughness: 0.8}), mesh = new THREE.Mesh(K.merge(parts), mat); mesh.castShadow = true; mesh.receiveShadow = true; mesh.name = "il:station:static"; g.add(mesh);
  // the lamps and the undersides lit by them (the canopies', the hall's ceiling, the decks' soffits): unlit, so a ceiling
  // under the sky-only light is never a black void
  var lmat = new THREE.MeshBasicMaterial({vertexColors: true, toneMapped: false}), lmesh = new THREE.Mesh(K.merge(lamps.concat(soft)), lmat); lmesh.name = "il:station:lamps"; g.add(lmesh);
  // the signs and boards: canvas textures (data strings drawn as text, never markup)
  var boards = [], doc = typeof document !== "undefined" ? document : null;
  function board(name, w, h, px, py, u, y, v, yaw, two){
    if(!doc) return null;
    var cv = doc.createElement("canvas"); cv.width = px; cv.height = py;
    var tex = new THREE.CanvasTexture(cv); if(THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    var m = new THREE.MeshBasicMaterial({map: tex, toneMapped: false, side: two ? THREE.DoubleSide : THREE.FrontSide});
    var pl = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m); pl.position.set(v, y, u); pl.rotation.y = yaw; pl.name = "il:board:" + name; g.add(pl);
    var b = {name: name, cv: cv, ctx: cv.getContext("2d"), tex: tex, m: m, mesh: pl, key: ""}; boards.push(b); return b;
  }
  var mid = (H.v0 + H.v1)/2, bw = Math.min(10, H.v1 - H.v0 - 2);
  var facade = board("facade", Math.min(14, H.v1 - H.v0), 1.3, 1024, 96, H.u0 - WALL - 0.06, ys + H.h - 0.6, mid, Math.PI);
  var hallB = board("hall", bw, bw*0.18, 1024, 184, GATE_U - 0.6, ys + 3.0, mid, Math.PI);
  var platB = L.plats.map(function(q){ return board("plat" + q.i, 3.4, 0.9, 512, 136, -half + 14, yp + 2.7, q.c, Math.PI, true); });
  var platN = L.plats.map(function(q){ return board("num" + q.i, 1.6, 0.8, 256, 128, L.stairTopU + 3, yp + 2.9, q.c, 0, true); });
  var wayout = L.plats.map(function(q){ return board("out" + q.i, 1.8, 0.45, 256, 64, L.stairTopU + 0.6, yp + 2.3, q.c, 0); });
  function paint(b, key, fn){ if(!b || b.key === key) return; b.key = key; var x = b.ctx; x.clearRect(0, 0, b.cv.width, b.cv.height); fn(x, b.cv.width, b.cv.height); b.tex.needsUpdate = true; }
  function txt(x, s, px, py, size, col, align, bold){ x.fillStyle = col; x.font = (bold ? "bold " : "") + size + "px sans-serif"; x.textAlign = align || "left"; x.textBaseline = "middle"; x.fillText(String(s), px, py); }
  paint(facade, "f", function(x, w, h){ x.fillStyle = "#3b2f5c"; x.fillRect(0, 0, w, h); x.fillStyle = "#6d4bb3"; x.fillRect(0, h - 10, w, 10);
    txt(x, "IL", 52, h/2, 52, "#ffffff", "center", true); txt(x, "Island Link · " + (L.name || "Station"), 110, h/2, 46, "#ffffff", "left", true); });
  wayout.forEach(function(b){ paint(b, "w", function(x, w, h){ x.fillStyle = "#1f7a4a"; x.fillRect(0, 0, w, h); txt(x, "Way out ↓", w/2, h/2, 34, "#ffffff", "center", true); }); });
  platN.forEach(function(b, i){ var q = L.plats[i]; paint(b, "n", function(x, w, h){ x.fillStyle = "#3b2f5c"; x.fillRect(0, 0, w, h); txt(x, q.label, w/2, h/2, 64, "#ffffff", "center", true); }); });
  function mins(ms){ var s = Math.max(0, Math.round(ms/1000)); return s < 60 ? (s <= 20 ? "now" : s + " s") : Math.round(s/60) + " min"; }
  function clock(ms){ var d = new Date(ms + 330*60000); var h = d.getUTCHours(), m = d.getUTCMinutes(); return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m; }
  function drawBoards(ms){
    var rows = typeof o.departures === "function" ? (o.departures(ms) || []) : [];
    var hk = rows.slice(0, 4).map(function(r){ return r.to + r.plat + mins(r.at - ms) + clock(r.at); }).join("|");
    paint(hallB, hk, function(x, w, h){
      x.fillStyle = "#101418"; x.fillRect(0, 0, w, h); txt(x, "Island Link · departures", 20, 22, 26, "#f2c230", "left", true);
      if(!rows.length) txt(x, "No trains listed", 20, 80, 28, "#c8d0d8");
      rows.slice(0, 4).forEach(function(r, i){ var y = 60 + i*32;
        txt(x, clock(r.at), 20, y, 28, "#f2c230"); txt(x, "to " + r.to, 130, y, 28, "#ffffff"); txt(x, "platform " + r.plat, w - 230, y, 28, "#ffffff"); txt(x, mins(r.at - ms), w - 20, y, 28, "#9fe39b", "right"); });
    });
    platB.forEach(function(b, i){
      var q = L.plats[i], mine = rows.filter(function(r){ return q.tracks.some(function(t){ return String(t.plat) === String(r.plat); }); }).slice(0, 2);
      var k = mine.map(function(r){ return r.to + r.plat + mins(r.at - ms); }).join("|");
      paint(b, k, function(x, w, h){
        x.fillStyle = "#101418"; x.fillRect(0, 0, w, h); txt(x, "Platform " + q.label, 14, 22, 24, "#f2c230", "left", true);
        if(!mine.length) txt(x, "No train", 14, 80, 26, "#c8d0d8");
        mine.forEach(function(r, j){ txt(x, r.plat + "  to " + r.to, 14, 66 + j*38, 26, "#ffffff"); txt(x, mins(r.at - ms), w - 14, 66 + j*38, 26, "#9fe39b", "right"); });
      });
    });
  }
  // the gate paddles (two a lane) and the trains' door leaves (two a door), instanced
  if(!view.UNIT || view.UNIT.THREE !== THREE) view.UNIT = {THREE: THREE, g: new THREE.BoxGeometry(1, 1, 1)};
  var pmat = c.mat(0xd6dde4, {roughness: 0.3, metalness: 0.2, transparent: true, opacity: 0.85}), pad = new THREE.InstancedMesh(view.UNIT.g, pmat, Math.max(2, L.gate.lanes.length*2));
  pad.frustumCulled = false; g.add(pad);
  var dmat = c.mat(0xffffff, {roughness: 0.45, metalness: 0.2}), leaves = new THREE.InstancedMesh(view.UNIT.g, dmat, 2*8*2*4), dark = new THREE.InstancedMesh(view.UNIT.g, new THREE.MeshBasicMaterial({color: 0xfff1d6, toneMapped: false}), 8*2*4);
  leaves.frustumCulled = dark.frustumCulled = false; leaves.count = 0; dark.count = 0;
  var world = new THREE.Group(); world.name = "il:station:doors"; world.add(leaves); world.add(dark);
  var dummy = new THREE.Object3D(), cc = new THREE.Color(), open = {};
  var padOpen = L.gate.lanes.map(function(){ return 0; });
  var lastBoard = -1e18;
  var V = {g: g, doorsG: world, L: L,
    update: function(ms, dt, cam, info){
      info = info || {};
      if(ms - lastBoard > 4000){ lastBoard = ms; try { drawBoards(ms); } catch(e){} }
      // paddles: a lane opens for whoever comes up to it (you, with a ticket or coming out; a passenger)
      var calm = !!info.calm, me = info.me, ok = info.gateOk !== false, people = info.people || [];
      L.gate.lanes.forEach(function(ln, i){
        var want = 0;
        function near(x, z){ var p = L.loc(x, z); return Math.abs(p.u - GATE_U) < 1.6 && Math.abs(p.v - ln.v) < 0.5; }
        if(me && ok && near(me.x, me.z) && !(me.y > L.ys + 1.2)) want = 1;
        for(var k = 0; k < people.length && !want; k++) if(near(people[k].x, people[k].z)) want = 1;
        padOpen[i] = calm ? want : padOpen[i] + clamp(want - padOpen[i], -dt*4, dt*4);
        [-1, 1].forEach(function(e, j){
          var a = padOpen[i]*Math.PI/2*0.95;
          dummy.position.set(ln.v + e*(ln.hw - 0.02 - 0.18*Math.cos(a)), L.ys + 0.75, GATE_U + 0.18*Math.sin(a)*1);
          dummy.rotation.set(0, e*a, 0); dummy.scale.set(0.36, 0.6, 0.03); dummy.updateMatrix(); pad.setMatrixAt(2*i + j, dummy.matrix);
        });
      });
      pad.instanceMatrix.needsUpdate = true;
      // the doors of the trains standing here (world frame): info.trains [{id, doors [{x, y, z, yaw, side}], open 0..1}]
      var nl = 0, nd = 0;
      (info.trains || []).forEach(function(T){
        var f = calm ? (T.open >= 0.5 ? 1 : 0) : clamp(T.open, 0, 1);
        (T.doors || []).forEach(function(d){
          var c2 = Math.cos(d.yaw), s2 = Math.sin(d.yaw), lat = 0.04*d.side;
          [-1, 1].forEach(function(e){
            var slide = e*(0.33 + 0.64*f);
            dummy.position.set(d.x + s2*slide + c2*lat, d.y + 1.0, d.z + c2*slide - s2*lat); dummy.rotation.set(0, d.yaw, 0); dummy.scale.set(0.06, 2.0, 0.66); dummy.updateMatrix();
            if(nl < leaves.instanceMatrix.count){ leaves.setMatrixAt(nl, dummy.matrix); leaves.setColorAt(nl, cc.setHex(0x5a3d99)); nl++; }
          });
          if(f > 0.05 && nd < dark.instanceMatrix.count){
            dummy.position.set(d.x - c2*0.02*d.side, d.y + 1.0, d.z + s2*0.02*d.side); dummy.rotation.set(0, d.yaw, 0); dummy.scale.set(0.05, 1.98, 1.3*f); dummy.updateMatrix(); dark.setMatrixAt(nd++, dummy.matrix);
          }
        });
      });
      leaves.count = nl; dark.count = nd; leaves.instanceMatrix.needsUpdate = true; dark.instanceMatrix.needsUpdate = true; if(leaves.instanceColor) leaves.instanceColor.needsUpdate = true;
    },
    drawCalls: function(){ return 2 + boards.length + 1 + (leaves.count ? 1 : 0) + (dark.count ? 1 : 0); },
    boards: function(){ return boards.map(function(b){ return {name: b.name, key: b.key}; }); },
    dispose: function(){
      if(g.parent) g.parent.remove(g); if(world.parent) world.parent.remove(world);
      mesh.geometry.dispose(); mat.dispose(); lmesh.geometry.dispose(); lmat.dispose(); pmat.dispose(); dmat.dispose(); dark.material.dispose();
      boards.forEach(function(b){ b.tex.dispose(); b.m.dispose(); b.mesh.geometry.dispose(); });
    }};
  return V;
}

HQV.hqILStation = {layout: layout, view: view, walkers: walkers, GATE_U: GATE_U, HALL_U0: HALL_U0, HALL_U1: HALL_U1, HALL_H: HALL_H,
  STAIR_U0: STAIR_U0, SLOPE: SLOPE, CANOPY: CANOPY, WALK_V: WALK_V, DOOR_LAT: DOOR_LAT};
})();
