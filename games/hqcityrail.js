/* Claude HQ 3.15: the City Line (HQV.hqCityRail). docs/plans/transport-revamp.md 3.4, 3.6, 3.14, 5.3, 5.4.
 *
 * The @3 doc carries layers.rail (cm): the City Line (kind "city"), Central - (0-2 neighbourhood stops) - Port -
 * Airport, elevated 9 m over the streets (path y is the rail head), with elevated stations whose stairs and lift
 * come down to the pavement at the doc's stair feet. Read through HQV.hqRail.railView(W) (HQV.world.railOf on a
 * packed world, else converted from cm), so games/hqrail.js loads first.
 *
 * Pure top half (no THREE, no DOM; tests/test_hqcityrail.py runs it under node):
 *   create(W, {tier, seed}) -> sim, a Service (plan 5.3, mode "rail", short "CL"):
 *     lines(), stops(), stopsNear(x, z, r), departures(stopId, ms, n), trip(lineId, from, to, ms), vehicles(ms)
 *     plus track(lineId) (the path every STEP m as an hqRail route: at(), pts, s, len), trackAt(lineId, s),
 *     runs(lineId) ({out, back}: {stops: [i], s: [m], a: [s], d: [s], T}), carsAt(vehicle) (the four cars' rail-head
 *     poses, its own track), clearance(lineId, groundAt) ({min, max, n}: rail head over the ground on viaduct spans).
 *   Timetable: a 4-car regional EMU every HEADWAY s each way from each terminus, DWELL s at every station, VMAX top
 *   speed, ACC either way (along the path, plan metres). Departures are a pure function of (world seed, line, UTC ms).
 *   Twin track: each direction runs TRACK m to the right of the path (the path is the viaduct's middle); side
 *   platforms outside the tracks. A vehicle's (x, y, z) is the train's middle on its track at the rail head; Trip.pose
 *   is the floor centre (PLAT_TOP over the rail). Seats: hqRail's SEATS (2+2 transverse in facing bays, 104 a train,
 *   none in the cabs or behind car 1's luggage stack) then its STAND spots at the doors.
 * Drawing (needs THREE via hq3d's ctx and HQV.hqRail.parts): view(c, sim, opts) -> V (plan 5.4): a steel box-girder
 *   viaduct on round piers (a truss over water), catenary masts every 50 m with wires over both tracks, elevated
 *   station boxes (platforms, canopies, stairs and a lift to the pavement, departure boards), cream-and-green trains,
 *   commuters in their windows, and the focused train's seats, racks and luggage with a faint shell. Five draw calls
 *   (static, boards, two for the trains, commuters) and two more for a focused train. The trains run with
 *   games/engine.js's train-run loop, the nearest moving one at a time, each from its part nearest your ears.
 * No unseeded randomness: everything is seeded by the world id. Nothing here moves under Calm but the trains themselves.
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : self;
var HQV = root.HQV = root.HQV || {};

var HEADWAY = 240, DWELL = 40, VMAX = 25, ACC = 0.9;
var TRACK = 2.0;            // m: each track's centre to the right of the path
var STEP = 4;               // m between track points
var PLAT_IN = 3.45, PLAT_OUT = 6.6;   // m from the path: a side platform's edge and back
var PIER_EVERY = 30, BRIDGE_PIER = 60, MAST_EVERY = 50;
var COLOR = "#2e8b57", NAME = "City Line";
var LIVERY = {body: 0xf1e7cc, accent: 0x2e7d4f, door: 0x23663f, glass: 0x1b2620, glassNight: 0xffdca8};
var KC = {viaduct: 3, bridge: 4, tunnel: 1, portal: 2, grade: 0};

function RL(){ return HQV.hqRail || null; }
function hyp(x, z){ return Math.sqrt(x*x + z*z); }
function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function fin(v, d){ v = +v; return isFinite(v) ? v : d; }
function hash32(s){ var h = 2166136261 >>> 0; s = String(s); for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }

// rest to rest over d m: the time (s) and the distance covered after t s
function legTime(d){ d = Math.max(0, d); var dA = VMAX*VMAX/ACC; return d >= dA ? d/VMAX + VMAX/ACC : 2*Math.sqrt(d/ACC); }
function legAt(d, t){
  d = Math.max(0, d); var T = legTime(d); t = clamp(t, 0, T);
  var vp = Math.min(VMAX, Math.sqrt(d*ACC)), ta = vp/ACC, dc = d - vp*vp/ACC;
  if(t <= ta) return {s: ACC*t*t/2, v: ACC*t};
  if(t <= ta + dc/vp) return {s: vp*ta/2 + vp*(t - ta), v: vp};
  var tb = T - t; return {s: d - ACC*tb*tb/2, v: ACC*tb};
}

// a path [[x, y, z]] (m) every STEP m as an hqRail route (pts, s, n, len) with the segment kind at each point
function trackOf(path, kinds){
  var P = [path[0].slice()], K = [KC[kinds[0]] != null ? KC[kinds[0]] : 3], carry = 0, i;
  for(i = 1; i < path.length; i++){
    var a = path[i - 1], b = path[i], d = hyp(b[0] - a[0], b[2] - a[2]), kk = KC[kinds[i - 1]] != null ? KC[kinds[i - 1]] : 3;
    if(d < 1e-9) continue;
    var u = STEP - carry;
    while(u <= d){ var f = u/d; P.push([a[0] + (b[0] - a[0])*f, a[1] + (b[1] - a[1])*f, a[2] + (b[2] - a[2])*f]); K.push(kk); u += STEP; }
    carry = d - (u - STEP);
  }
  var L = path[path.length - 1], q = P[P.length - 1];
  if(hyp(L[0] - q[0], L[2] - q[2]) > STEP*0.3){ P.push(L.slice()); K.push(K[K.length - 1]); } else P[P.length - 1] = L.slice();
  var n = P.length, pts = new Float64Array(3*n), s = new Float64Array(n), k = new Uint8Array(n);
  for(i = 0; i < n; i++){ pts[3*i] = P[i][0]; pts[3*i + 1] = P[i][1]; pts[3*i + 2] = P[i][2]; k[i] = K[i]; if(i) s[i] = s[i - 1] + hyp(P[i][0] - P[i - 1][0], P[i][2] - P[i - 1][2]); }
  return {pts: pts, s: s, n: n, len: s[n - 1], k: k};
}
// the arc length (m) of the point on the track nearest (x, z)
function project(R, x, z){
  var best = Infinity, bs = 0;
  for(var i = 0; i + 1 < R.n; i++){
    var ax = R.pts[3*i], az = R.pts[3*i + 2], ex = R.pts[3*i + 3] - ax, ez = R.pts[3*i + 5] - az, l2 = ex*ex + ez*ez || 1e-9;
    var t = clamp(((x - ax)*ex + (z - az)*ez)/l2, 0, 1), d = hyp(x - ax - ex*t, z - az - ez*t);
    if(d < best){ best = d; bs = R.s[i] + (R.s[i + 1] - R.s[i])*t; }
  }
  return bs;
}

function create(W, o){
  o = o || {};
  var H = RL(), RV = H && H.railView ? H.railView(W) : null, wid = String((W && (W.id || W.seed)) || ""), seed = o.seed != null ? String(o.seed) : wid;
  var tier = o.tier != null ? o.tier | 0 : 5, at = H ? H.at : null;
  var SEATS = H ? H.SEATS : [], STAND = H ? H.STAND : [], CAR_L = H ? H.CAR_L : 17, CAR_GAP = H ? H.CAR_GAP : 1.2, CARS = H ? H.CARS : 4;
  var TRAIN_L = CARS*CAR_L + (CARS - 1)*CAR_GAP, PLAT_TOP = H ? H.PLAT_TOP : 0.95, DOOR_Z = CAR_L*0.22;
  var LINES = [], STOPS = [], byStop = {};
  var RN = HQV.hqRide;
  function nameAt(x, z, i){ try { if(RN && RN.stationName && W) return RN.stationName(W, x, z, "rail"); } catch(e){} return "Station " + (i + 1); }
  (RV && at ? RV.lines : []).forEach(function(l){
    if(l.kind !== "city" || l.path.length < 2 || (l.tier | 0) > tier) return;
    var R = trackOf(l.path, l.kinds), st = [];
    l.stations.forEach(function(id){
      var s = RV.stations.filter(function(x){ return x.id === id; })[0];
      if(s) st.push({st: s, s: clamp(project(R, s.x, s.z), TRAIN_L/2 + 2, Math.max(TRAIN_L/2 + 2, R.len - TRAIN_L/2 - 2))});
    });
    if(st.length < 2) return;
    st.sort(function(a, b){ return a.s - b.s; });
    var ids = st.map(function(e, i){
      var s = e.st;
      if(!byStop[s.id]){
        var stop = {id: s.id, name: nameAt(s.x, s.z, STOPS.length), x: s.x, y: s.y + PLAT_TOP, z: s.z, mode: "rail", lines: [], kind: "station",
                    under: s.kind === "underground", stairs: s.stairs || [], yaw: s.yaw, len: s.len || 70, s: e.s, line: l.id};
        byStop[s.id] = stop; STOPS.push(stop);
      }
      byStop[s.id].lines.push(l.id);
      return s.id;
    });
    // the runs: out (s rising) and back, each arriving at and leaving every station
    var S = st.map(function(e){ return e.s; });
    function run(order){
      var a = [-DWELL], d = [0];
      for(var i = 1; i < order.length; i++){ a.push(d[i - 1] + legTime(Math.abs(S[order[i]] - S[order[i - 1]]))); d.push(a[i] + DWELL); }
      return {stops: order, s: order.map(function(i){ return S[i]; }), a: a, d: d, T: a[a.length - 1]};
    }
    var fw = S.map(function(_, i){ return i; });
    LINES.push({id: l.id, R: R, stops: ids, S: S, runs: {out: run(fw), back: run(fw.slice().reverse())}, kinds: l.kinds});
  });
  function lineById(id){ return LINES.filter(function(L){ return L.id === id; })[0] || null; }
  function off(L, dir){ return (hash32(seed + ":CL:" + L.id + ":" + dir) % (HEADWAY*1000)); }
  function dep0(L, dir, k){ return k*HEADWAY*1000 + off(L, dir); }
  // the train's middle (m along the path) and speed t s after leaving its first station
  function runPos(run, t){
    var n = run.stops.length;
    if(t <= run.d[0]) return {s: run.s[0], v: 0, at: 0, doors: t >= -DWELL ? 1 : 0};
    for(var i = 1; i < n; i++){
      if(t < run.a[i]){ var dd = run.s[i] - run.s[i - 1], g = legAt(Math.abs(dd), t - run.d[i - 1]); return {s: run.s[i - 1] + (dd >= 0 ? g.s : -g.s), v: g.v, at: -1, doors: 0}; }
      if(t <= run.d[i] || i === n - 1) return {s: run.s[i], v: 0, at: i, doors: t <= run.d[i] + (i === n - 1 ? DWELL : 0) ? 1 : 0};
    }
    return {s: run.s[n - 1], v: 0, at: n - 1, doors: 0};
  }
  // the four cars of a train whose middle is `mid` m along, running dir (+1 rising s): rail-head poses on its track
  function cars(L, mid, sgn){
    var out = [];
    for(var k = 0; k < CARS; k++){
      var sc = mid + sgn*(TRAIN_L/2 - k*(CAR_L + CAR_GAP) - CAR_L/2), p = at(L.R, clamp(sc, 0, L.R.len));
      var yaw = p.yaw + (sgn < 0 ? Math.PI : 0), rx = -Math.cos(yaw), rz = Math.sin(yaw);
      out.push({x: p.x + rx*TRACK, y: p.y, z: p.z + rz*TRACK, yaw: yaw, pitch: sgn < 0 ? -p.pitch : p.pitch, nose: k === 0 ? 1 : k === CARS - 1 ? -1 : 0, s: sc, k: k});
    }
    return out;
  }
  function vehAt(L, dir, k, ms){
    var run = L.runs[dir], D0 = dep0(L, dir, k), t = (ms - D0)/1000;
    if(t < -DWELL || t > run.T + DWELL) return null;
    var rp = runPos(run, t), sgn = dir === "out" ? 1 : -1, C = cars(L, rp.s, sgn), m = at(L.R, clamp(rp.s, 0, L.R.len));
    var yaw = m.yaw + (sgn < 0 ? Math.PI : 0), rx = -Math.cos(yaw), rz = Math.sin(yaw);
    return {id: "CL:" + L.id + ":" + dir + ":" + k, line: L.id, mode: "rail", dir: dir, k: k, dep: D0, s: rp.s, sgn: sgn,
            x: m.x + rx*TRACK, y: m.y, z: m.z + rz*TRACK, yaw: yaw, pitch: sgn < 0 ? -m.pitch : m.pitch, speed: rp.v, doors: rp.doors, at: rp.at, cars: C, under: false};
  }
  function seatPose(C, i){
    var S0 = i < SEATS.length ? SEATS[i] : STAND[clamp(i - SEATS.length, 0, STAND.length - 1)], p = C[S0.car], c = Math.cos(p.yaw), sn = Math.sin(p.yaw);
    return {x: p.x + c*S0.x + sn*S0.z, y: p.y + PLAT_TOP + S0.y, z: p.z - sn*S0.x + c*S0.z, yaw: p.yaw + (S0.back ? Math.PI : 0), car: S0.car, stand: i >= SEATS.length};
  }
  function makeTrip(L, dir, k, i, j){
    var run = L.runs[dir], D0 = dep0(L, dir, k), stops = [];
    for(var q = i; q <= j; q++){ var sid = L.stops[run.stops[q]]; stops.push({id: sid, name: byStop[sid].name, at: Math.round(D0 + (q === i ? run.d[q] : run.a[q])*1000)}); }
    var from = L.stops[run.stops[i]], to = L.stops[run.stops[j]], vid = "CL:" + L.id + ":" + dir + ":" + k;
    function V(ms){ return vehAt(L, dir, k, clamp(ms, D0 - DWELL*1000, D0 + (run.T + DWELL)*1000)); }
    return {mode: "rail", line: L.id, short: "CL", vehicle: vid, from: from, to: to, fromName: byStop[from].name, toName: byStop[to].name,
      arrive: Math.round(D0 + run.a[i]*1000), depart: Math.round(D0 + run.d[i]*1000), reach: Math.round(D0 + run.a[j]*1000), stops: stops,
      seats: SEATS.length, standing: STAND.length, seatMeta: SEATS, dir: dir,
      pose: function(ms){ var v = V(ms); return {x: v.x, y: v.y + PLAT_TOP, z: v.z, yaw: v.yaw, pitch: v.pitch, speed: v.speed, doors: v.doors, under: false, done: ms >= D0 + run.a[j]*1000}; },
      seat: function(n, ms){ return seatPose(V(ms).cars, Math.max(0, n | 0)); },
      // the second car's front door on the platform side (the right of travel)
      door: function(ms){ var p = V(ms).cars[1], f = DOOR_Z; return {x: p.x + Math.sin(p.yaw)*f - Math.cos(p.yaw)*1.5, z: p.z + Math.cos(p.yaw)*f + Math.sin(p.yaw)*1.5}; }};
  }
  var sim = {
    mode: "rail",
    lines: function(){ return LINES.map(function(L){ return {id: L.id, mode: "rail", name: NAME, short: "CL", color: COLOR, stops: L.stops.slice(), headway: HEADWAY, loop: false}; }); },
    stops: function(){ return STOPS.map(function(s){ return {id: s.id, name: s.name, x: s.x, y: s.y, z: s.z, mode: "rail", lines: s.lines.slice(), kind: "station", under: s.under}; }); },
    stopsNear: function(x, z, r){
      return STOPS.map(function(s){ return {id: s.id, name: s.name, dist: hyp(s.x - x, s.z - z), mode: "rail", lines: s.lines.slice()}; })
        .filter(function(s){ return s.dist <= r; }).sort(function(a, b){ return a.dist - b.dist || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
    },
    departures: function(stopId, ms, n){
      n = Math.max(1, (n | 0) || 4); ms = fin(ms, 0);
      var rows = [];
      LINES.forEach(function(L){
        var si = L.stops.indexOf(stopId); if(si < 0) return;
        ["out", "back"].forEach(function(dir){
          var run = L.runs[dir], i = run.stops.indexOf(si);
          if(i < 0 || i === run.stops.length - 1) return;                       // the terminus: trains end here
          var last = L.stops[run.stops[run.stops.length - 1]], k = Math.ceil((ms - off(L, dir) - run.d[i]*1000)/(HEADWAY*1000));
          for(var q = 0; q < n; q++){
            var t = dep0(L, dir, k + q) + run.d[i]*1000;
            rows.push({line: L.id, short: "CL", to: byStop[last].name, at: Math.round(t), plat: dir === "out" ? "1" : "2", boarding: ms >= t - DWELL*1000 && ms < t, delay: 0, dir: dir});
          }
        });
      });
      rows.sort(function(a, b){ return a.at - b.at || (a.plat < b.plat ? -1 : 1); });
      return rows.slice(0, n);
    },
    trip: function(lineId, fromStop, toStop, ms){
      var L = lineById(lineId); if(!L) return null;
      var a = L.stops.indexOf(fromStop), b = L.stops.indexOf(toStop);
      if(a < 0 || b < 0 || a === b) return null;
      var dir = b > a ? "out" : "back", run = L.runs[dir], i = run.stops.indexOf(a), j = run.stops.indexOf(b);
      var k = Math.ceil((fin(ms, 0) - off(L, dir) - run.d[i]*1000)/(HEADWAY*1000));
      return makeTrip(L, dir, k, i, j);
    },
    vehicles: function(ms){
      var out = [], C = HQV.hqCommute;
      LINES.forEach(function(L){
        ["out", "back"].forEach(function(dir){
          var run = L.runs[dir], H0 = HEADWAY*1000, o0 = off(L, dir);
          for(var k = Math.floor((ms - o0 - (run.T + DWELL)*1000)/H0); k <= Math.ceil((ms - o0 + DWELL*1000)/H0); k++){
            var v = vehAt(L, dir, k, ms); if(!v) continue;
            v.load = C && C.load ? C.load("rail", L.id, v.id, ms, seed) : 0.5;
            out.push(v);
          }
        });
      });
      return out;
    },
    track: function(lineId){ var L = lineById(lineId); return L ? L.R : null; },
    trackAt: function(lineId, s){ var L = lineById(lineId); return L ? at(L.R, clamp(fin(s, 0), 0, L.R.len)) : null; },
    runs: function(lineId){ var L = lineById(lineId); return L ? L.runs : null; },
    stations: function(lineId){ var L = lineById(lineId); return L ? L.stops.map(function(id){ return byStop[id]; }) : []; },
    carsAt: function(v){ var L = v && lineById(v.line); return L ? cars(L, v.s, v.sgn) : null; },
    // the rail head over the ground on the elevated spans (viaduct, not over water and not at the stations)
    clearance: function(lineId, groundAt){
      var L = lineById(lineId), lo = Infinity, hi = -Infinity, n = 0;
      if(!L || typeof groundAt !== "function") return null;
      for(var s = 0; s <= L.R.len; s += STEP){
        var i = Math.min(L.R.n - 1, Math.round(s/STEP)); if(L.R.k[i] !== KC.viaduct) continue;
        var p = at(L.R, s), g = groundAt(p.x, p.z); if(!isFinite(g)) continue;
        lo = Math.min(lo, p.y - g); hi = Math.max(hi, p.y - g); n++;
      }
      return {min: lo, max: hi, n: n};
    },
    seed: seed, consts: {HEADWAY: HEADWAY, DWELL: DWELL, VMAX: VMAX, ACC: ACC, TRACK: TRACK, TRAIN_L: TRAIN_L}
  };
  return sim;
}

/* ---------- drawing (THREE) ---------- */
function view(c, sim, opts){
  var THREE = c.THREE, H = RL(), PT = H && H.parts; opts = opts || {};
  if(!PT) return null;
  var K = PT.kit(THREE), at = H.at, PLAT_TOP = H.PLAT_TOP, W = opts.W || null, WD = HQV.world;
  var root2 = new THREE.Group(); root2.name = "cityline";
  var ground = typeof opts.ground === "function" ? opts.ground : function(x, z){ return W && WD && WD.groundAt ? WD.groundAt(W, x, z) : 0; };
  var parts = [], boards = [], O = {x: 0, z: 0};
  var GIRDER = [[-4.3, -0.35], [4.3, -0.35], [4.3, -0.8], [2.7, -2.4], [-2.7, -2.4], [-4.3, -0.8]];
  var lines = sim.lines();
  lines.forEach(function(l){
    var R = sim.track(l.id); if(!R) return;
    var S = PT.samples(R, 0, R.len, STEP, O);
    parts.push(K.extrude(S, GIRDER, true, 0x56676a));
    [-1, 1].forEach(function(sd){ parts.push(K.extrude(S, [[sd*4.3, -0.35], [sd*4.15, -0.35], [sd*4.15, 0.75], [sd*4.3, 0.75]], true, 0x8b979a)); });   // parapets
    [-TRACK, TRACK].forEach(function(tc){
      [-0.75, 0.75].forEach(function(lt){ var x = tc + lt; parts.push(K.extrude(S, [[x - 0.04, 0], [x + 0.04, 0], [x + 0.04, -0.17], [x - 0.04, -0.17]], true, 0x6f7882)); });
      parts.push(K.extrude(S, [[tc - 1.3, -0.2], [tc + 1.3, -0.2], [tc + 1.3, -0.35], [tc - 1.3, -0.35]], true, 0x7c7a74));     // the slab track
      parts.push(K.extrude(S, [[tc - 0.02, 5.6], [tc + 0.02, 5.6], [tc + 0.02, 5.55], [tc - 0.02, 5.55]], true, 0x2b2f33));   // contact wire
    });
    // piers: round, from the ground to the girder's soffit; wider apart (and a truss) where the line bridges water
    var last = -1e9;
    for(var s = 6; s < R.len - 6; s += 2){
      var i = Math.min(R.n - 1, Math.round(s/STEP)), kk = R.k[i], every = kk === KC.bridge ? BRIDGE_PIER : PIER_EVERY;
      if(s - last < every) continue;
      last = s;
      var p = at(R, s), g = ground(p.x, p.z); if(!isFinite(g)) g = p.y - 9;
      if(p.y - 2.4 - g < 0.6) continue;
      parts.push(K.cyl(0.9, 1.1, p.y - 2.4 - g, 12, p.x, g, p.z, 0xa7abae));
      parts.push(K.box(6.2, 0.8, 2.2, p.x, p.y - 2.8, p.z, 0xa7abae, p.yaw));
    }
    for(var b = 0; b < R.n - 1; b++){                                     // the bridge truss: chords and diagonals every 10 m
      if(R.k[b] !== KC.bridge) continue;
      var p0 = at(R, R.s[b]), p1 = at(R, R.s[b + 1]);
      [-1, 1].forEach(function(sd){
        var c0 = Math.cos(p0.yaw)*sd*4.4, s0 = Math.sin(p0.yaw)*sd*4.4, c1 = Math.cos(p1.yaw)*sd*4.4, s1 = Math.sin(p1.yaw)*sd*4.4;
        parts.push(K.strut([p0.x + c0, p0.y + 3.2, p0.z - s0], [p1.x + c1, p1.y + 3.2, p1.z - s1], 0.3, 0x3f5a5e));
        if(b % 3 === 0) parts.push(K.strut([p0.x + c0, p0.y - 0.4, p0.z - s0], [p1.x + c1, p1.y + 3.2, p1.z - s1], 0.2, 0x3f5a5e));
      });
    }
    // catenary masts every MAST_EVERY m both sides, an arm over each track
    for(var m = 12; m < R.len; m += MAST_EVERY){
      var q = at(R, m), cx = Math.cos(q.yaw), sx = Math.sin(q.yaw);
      [-1, 1].forEach(function(sd){
        parts.push(K.cyl(0.13, 0.15, 6.4, 8, q.x + cx*sd*4.0, q.y - 0.35, q.z - sx*sd*4.0, 0x3d5566));
        parts.push(K.box(2.6, 0.1, 0.1, q.x + cx*sd*2.7, q.y + 5.75, q.z - sx*sd*2.7, 0x3d5566, q.yaw));
      });
    }
    // the stations: side platforms outside the tracks, canopies, glass ends, stairs and a lift to the doc's stair feet
    sim.stations(l.id).forEach(function(st){
      var half = Math.max(40, st.len/2), P = PT.samples(R, Math.max(0, st.s - half), Math.min(R.len, st.s + half), STEP, O);
      [-1, 1].forEach(function(sd){
        parts.push(K.extrude(P, [[sd*PLAT_IN, PLAT_TOP], [sd*PLAT_OUT, PLAT_TOP], [sd*PLAT_OUT, -1.0], [sd*PLAT_IN, -1.0]], true, 0xcfc9bd));
        parts.push(K.extrude(P, [[sd*PLAT_IN, PLAT_TOP + 0.01], [sd*(PLAT_IN + 0.4), PLAT_TOP + 0.01]], false, 0xf2c230));     // tactile edge
        parts.push(K.extrude(P, [[sd*3.0, 4.9], [sd*7.0, 4.6], [sd*7.0, 4.45], [sd*3.0, 4.75]], true, 0xe7edf2));             // canopy
        parts.push(K.extrude(P, [[sd*PLAT_OUT, PLAT_TOP], [sd*(PLAT_OUT + 0.15), PLAT_TOP], [sd*(PLAT_OUT + 0.15), PLAT_TOP + 2.2], [sd*PLAT_OUT, PLAT_TOP + 2.2]], true, 0x9fb6bf));
        for(var u = -half + 6; u <= half - 6; u += 12){
          var cp = at(R, clamp(st.s + u, 0, R.len)), cc = Math.cos(cp.yaw), ss = Math.sin(cp.yaw);
          parts.push(K.cyl(0.1, 0.1, 3.9, 8, cp.x + cc*sd*6.2, cp.y + PLAT_TOP, cp.z - ss*sd*6.2, 0x3d5566));
        }
      });
      (st.stairs || []).forEach(function(foot){
        // the flight runs from the platform's back edge nearest the foot down to the foot
        var c0 = at(R, st.s), cc = Math.cos(c0.yaw), ss = Math.sin(c0.yaw), lat = (foot[0] - c0.x)*cc - (foot[1] - c0.z)*ss, sd = lat >= 0 ? 1 : -1;
        var top = {x: c0.x + cc*sd*(PLAT_OUT + 0.6), y: c0.y + PLAT_TOP, z: c0.z - ss*sd*(PLAT_OUT + 0.6)}, g2 = ground(foot[0], foot[1]); if(!isFinite(g2)) g2 = top.y - 10;
        var dx = foot[0] - top.x, dz = foot[1] - top.z, run = hyp(dx, dz) || 1, hgt = Math.max(1, top.y - g2), n = Math.max(2, Math.ceil(hgt/0.19)), yaw = Math.atan2(dx, dz);
        for(var j = 0; j < n; j++){ var f = (j + 0.5)/n; parts.push(K.box(2.0, 0.19, run/n + 0.02, top.x + dx*f, top.y - hgt*f, top.z + dz*f, 0xb9b3a8, yaw)); }
        parts.push(K.strut([top.x - Math.cos(yaw)*1.05, top.y + 0.9, top.z + Math.sin(yaw)*1.05], [foot[0] - Math.cos(yaw)*1.05, g2 + 0.9, foot[1] + Math.sin(yaw)*1.05], 0.06, 0x3d5566));
        parts.push(K.strut([top.x + Math.cos(yaw)*1.05, top.y + 0.9, top.z - Math.sin(yaw)*1.05], [foot[0] + Math.cos(yaw)*1.05, g2 + 0.9, foot[1] - Math.sin(yaw)*1.05], 0.06, 0x3d5566));
        // the lift: a glazed shaft beside the foot, its door to the street
        var lx = foot[0] - Math.cos(yaw)*2.6, lz = foot[1] + Math.sin(yaw)*2.6;
        parts.push(K.box(2.2, hgt + 3.2, 2.2, lx, g2 + (hgt + 3.2)/2, lz, 0x7e9aa6, yaw));
        parts.push(K.box(1.1, 2.1, 0.08, lx + Math.sin(yaw)*1.13, g2 + 1.05, lz + Math.cos(yaw)*1.13, 0x2b3a48, yaw));
      });
      boards.push({st: st, R: R});
    });
  });
  var mat = PT.vcMat(c, {roughness: 0.8, side: THREE.DoubleSide}), stat = null;
  if(parts.length){ stat = new THREE.Mesh(K.merge(parts), mat); stat.castShadow = true; stat.receiveShadow = true; root2.add(stat); }
  // departure boards: one plane a platform side under the canopy, on hqRide's shared atlas (one mesh)
  var RN = HQV.hqRide, B = [], boardMesh = null, bmat = null;
  if(RN && RN.boardTexture && boards.length){
    var geos = [];
    boards.forEach(function(e){
      var tex = RN.boardTexture(THREE, [], {at: null}); if(!tex) return;
      if(B.length && tex.texture !== B[0].tex.texture){ tex.dispose(); return; }   // one atlas only: the rest stay text in the phone
      B.push({st: e.st, tex: tex});
      var p = at(e.R, e.st.s), cc = Math.cos(p.yaw), ss = Math.sin(p.yaw);
      [-1, 1].forEach(function(sd){
        var g = new THREE.PlaneGeometry(2.4, 0.6); tex.applyUv(g); g.rotateY(p.yaw + (sd > 0 ? -Math.PI/2 : Math.PI/2));
        g.translate(p.x + cc*sd*4.6, p.y + PLAT_TOP + 3.2, p.z - ss*sd*4.6); geos.push(g);
      });
    });
    if(geos.length){
      var pos = [], uv = [], nor = [];
      geos.forEach(function(g){ var gg = g.index ? g.toNonIndexed() : g; pos.push.apply(pos, gg.attributes.position.array); uv.push.apply(uv, gg.attributes.uv.array); nor.push.apply(nor, gg.attributes.normal.array); if(gg !== g) gg.dispose(); g.dispose(); });
      var bg = new THREE.BufferGeometry();
      bg.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); bg.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2)); bg.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
      bmat = new THREE.MeshBasicMaterial({map: B[0].tex.texture, side: THREE.DoubleSide});
      boardMesh = new THREE.Mesh(bg, bmat); root2.add(boardMesh);
    }
  }
  var trains = PT.trainKit(c, LIVERY, 4*Math.max(2, lines.length*6)), inside = PT.interiorKit(c, H.SEATS, {luggage: 0, seatHex: 0x2e6b4c, shellHex: 0xf1e7cc});
  var riders = PT.commuterKit(c, 300);
  root2.add(trains.g); root2.add(inside.g); root2.add(riders.g);
  if(c.scene && opts.attach !== false) c.scene.add(root2);
  var focusId = null, lastMs = 0, seed = sim.seed;
  // the trains' running sound (Sound PR B): games/engine.js's train-run loop at the nearest moving train (yours too),
  // from its part nearest your ears (hqRail's trainPool: one voice, as the Island Link's)
  var runP = PT.trainPool ? PT.trainPool() : null;
  var V = {g: root2,
    update: function(ms, dt, cam){
      lastMs = ms;
      var all = [], ride = [], fc = null, snd = [], ear = runP ? PT.earAt(cam) : null;
      trains.night(typeof opts.night === "function" ? opts.night() : false);
      sim.vehicles(ms).forEach(function(v){
        if(runP && +v.speed > 0.5 && hyp(v.x - ear.x, v.z - ear.z) < PT.SND_R){ var q = PT.nearOn(v.cars, ear, 1.5, H.CAR_L); if(q) snd.push({id: v.id, x: q.x, y: q.y, z: q.z, speed: +v.speed}); }
        if(v.id === focusId){ fc = v.cars; ride = ride.concat(PT.ridersOf("rail", v.id, v.cars, H.SEATS, ms, seed, opts.mySeat != null ? opts.mySeat : -1)); return; }
        all = all.concat(v.cars);
        if(cam && hyp(v.x - cam.x, v.z - cam.z) < 250) ride = ride.concat(PT.ridersOf("rail", v.id, v.cars, H.SEATS, ms, seed, -1));
      });
      trains.set(all); inside.set(fc); riders.set(ride);
      if(runP) runP.update(snd);
      if(boardMesh && RN) B.forEach(function(b){ b.tex.draw(RN.boardRows(sim.departures(b.st.id, ms, 4), ms), ms); });
    },
    focus: function(id){ focusId = id || null; if(!focusId) inside.set(null); },
    drawCalls: function(){ return (stat ? 1 : 0) + (boardMesh ? 1 : 0) + trains.drawCalls() + inside.drawCalls() + riders.drawCalls(); },
    tools: {shotCam: function(name){
      var l = lines[0], R = l && sim.track(l.id); if(!R) return null;
      var st = sim.stations(l.id);
      if(name === "cityline-viaduct"){
        var s = st.length > 1 ? (st[0].s + st[1].s)/2 : R.len/2, p = at(R, s), cx = Math.cos(p.yaw), sx = Math.sin(p.yaw);
        return {pos: {x: p.x + cx*55 - Math.sin(p.yaw)*30, y: p.y - 4, z: p.z - sx*55 - Math.cos(p.yaw)*30}, look: {x: p.x, y: p.y - 2, z: p.z}, fov: 55};
      }
      if(name === "cityline-station" && st.length){
        var q = at(R, st[0].s), f = st[0].stairs && st[0].stairs[0], ex = f ? f[0] : q.x + Math.cos(q.yaw)*20, ez = f ? f[1] : q.z - Math.sin(q.yaw)*20, gy = ground(ex, ez);
        var dx = ex - q.x, dz = ez - q.z, dl = hyp(dx, dz) || 1;
        return {pos: {x: ex + dx/dl*18, y: (isFinite(gy) ? gy : q.y - 9) + 1.7, z: ez + dz/dl*18}, look: {x: q.x, y: q.y + 2, z: q.z}, fov: 60};
      }
      if(name === "cityline-interior"){
        var v = sim.vehicles(lastMs)[0]; if(!v) return null;
        var cr = v.cars[1], fy = cr.y + PLAT_TOP + 1.25, fwd = {x: Math.sin(cr.yaw), z: Math.cos(cr.yaw)};
        return {pos: {x: cr.x - fwd.x*7, y: fy, z: cr.z - fwd.z*7}, look: {x: cr.x + fwd.x*6, y: fy - 0.2, z: cr.z + fwd.z*6}, fov: 70, vehicle: v.id};
      }
      return null;
    }},
    dispose: function(){
      if(runP){ runP.stop(); runP = null; }
      if(root2.parent) root2.parent.remove(root2);
      if(stat) stat.geometry.dispose(); mat.dispose();
      if(boardMesh){ boardMesh.geometry.dispose(); bmat.dispose(); }
      B.forEach(function(b){ b.tex.dispose(); });
      trains.dispose(); inside.dispose(); riders.dispose();
    }};
  return V;
}

HQV.hqCityRail = {create: create, view: view, legTime: legTime, legAt: legAt, trackOf: trackOf, project: project,
  HEADWAY: HEADWAY, DWELL: DWELL, VMAX: VMAX, ACC: ACC, TRACK: TRACK, COLOR: COLOR, LIVERY: LIVERY};
})();
