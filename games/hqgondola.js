/* Claude HQ 3.15: the gondola G1 (HQV.hqGondola). docs/plans/transport-revamp.md 3.4, 3.6, 3.14, 5.3, 5.4.
 *
 * The @3 doc carries layers.gondola (cm): one line, a valley station beside a tram or metro stop up to a summit station
 * where the island has a hill ("summit"), else an aerial crossing over the river, a lake or the marina ("crossing");
 * lattice towers at the doc's positions ({x, y (foot), z, h}). Read through HQV.world.gondolaOf(W) when the world
 * client has it, else converted here from W.gondola / a raw doc's layers.gondola.
 *
 * Pure top half (no THREE, no DOM; tests/test_hqgondola.py runs it under node):
 *   create(W, {tier, seed, heightAt(x, z)}) -> sim, a Service (plan 5.3, mode "gondola", short "G1"):
 *     lines(), stops(), stopsNear(x, z, r), departures(stopId, ms, n), trip(lineId, from, to, ms), vehicles(ms)
 *     plus cabins(ms) (every cabin: {id, i, x, y (floor), z, yaw, speed, station (index | -1), doors}), loop() (the
 *     cabin loop: {len, T, n, segs}), ropeY(lane, u) / ropeAt(lane, d) (the haul rope's height), spans() and
 *     clearance(heightAt) (the lowest cabin bottom over the ground along the line).
 *   The rope: two lanes ROPE_GAP m either side of the line (cabins go out on the right of travel), over the towers'
 *   sheave trains (foot y + h) and the stations' bull wheels; each span hangs as a catenary with SAG (2 %) of its
 *   length at the middle (less where a cabin would come nearer the ground than CLEAR m: the rope is tensioned there).
 *   Detachable cabins: LINE_V m/s on the rope, STATION_V m/s through a station (unload on the way in, round the bull
 *   wheel, board on the way out) with an ACC ramp either side; a cabin leaves each station every EVERY s. The station's
 *   slow straight is sized so the loop is a whole number of EVERY s: the timetable is a pure function of UTC ms.
 *   Seats: two facing benches of four (SEATS, cabin-local: +x left, z forward, y over the floor).
 * Drawing: view(c, sim, opts) -> V (plan 5.4): stations (bull-wheel housing, boarding platform, the summit's viewing
 *   deck), lattice towers with sheave trains on their arms, the rope, and the cabins (frame + benches + map placard,
 *   one call; glass all round, one call), swaying gently in the wind from HQV.hqWeather (none under Calm or reduced
 *   motion). Sounds through opts.sfx(name): "gondola-rumble" near a bull wheel, "gondola-clunk" when your cabin passes
 *   a tower, "gondola-wind" high up in a wind. Static stations, towers and rope: one merged mesh. Three calls in all.
 * No unseeded randomness: sway phases are seeded by the world id and the cabin.
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : self;
var HQV = root.HQV = root.HQV || {};

var EVERY = 18, LINE_V = 5, STATION_V = 0.3, ACC = 1.0;
var ROPE_GAP = 3.0;          // m: each rope lane off the line's middle (the bull wheel's radius)
var SAG = 0.02;              // of a span's length, at its middle
var HANG = 3.4;              // m: the rope over a cabin's floor (hanger and grip)
var DECK = 0.4;              // m: a station's platform over its doc y
var CLEAR = 3.0;             // m: a cabin's bottom never nearer the ground than this (between the stations)
var NEAR_ST = 20;            // m: within this of a station's mouth the cabins come down to the platform (no clearance test)
var RAMP = (LINE_V*LINE_V - STATION_V*STATION_V)/(2*ACC);   // m to slow from LINE_V to STATION_V
var STRAIGHT_MIN = 6;        // m: a station's slow straight, each side of the bull wheel, at least
var CAB_W = 2.0, CAB_L = 2.2, CAB_H = 2.3;
var COLOR = "#c0392b";
var SEATS = [];
[-0.75, -0.25, 0.25, 0.75].forEach(function(x){ SEATS.push({x: x, y: 0.45, z: -0.62, back: false}); });
[0.75, 0.25, -0.25, -0.75].forEach(function(x){ SEATS.push({x: x, y: 0.45, z: 0.62, back: true}); });

function hyp(x, z){ return Math.sqrt(x*x + z*z); }
function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function fin(v, d){ v = +v; return isFinite(v) ? v : d; }
function hash32(s){ var h = 2166136261 >>> 0; s = String(s); for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function mod(a, b){ return ((a % b) + b) % b; }

// layers.gondola in metres
function gondolaView(W){
  if(!W || typeof W !== "object") return null;
  var WD = HQV.world;
  if(W.gondola && WD && WD.gondolaOf){ try { var g = WD.gondolaOf(W); if(g) return g; } catch(e){} }
  var L = W.gondola || (W.layers && W.layers.gondola);
  if(!L || !Array.isArray(L.lines)) return null;
  function cm(v){ v = +v; return isFinite(v) ? v/100 : 0; }
  return {lines: L.lines.filter(Boolean).map(function(l){
    return {id: String(l.id), kind: l.kind === "summit" ? "summit" : "crossing", tier: (l.tier | 0) || 1,
            stations: (l.stations || []).filter(Boolean).map(function(s){
              var fx = s.front ? +s.front[0] || 0 : 0, fz = s.front ? +s.front[1] || 0 : 1, fl = hyp(fx, fz) || 1;
              return {id: String(s.id), x: cm(s.x), y: cm(s.y), z: cm(s.z), front: [fx/fl, fz/fl], yaw: Math.atan2(fx/fl, fz/fl)};
            }),
            towers: (l.towers || []).filter(Boolean).map(function(t){ return {x: cm(t.x), y: cm(t.y), z: cm(t.z), h: cm(t.h)}; })};
  })};
}

// time to cover a station's slow section: RAMP down, `slow` m at STATION_V, RAMP up
function rampTime(){ return (LINE_V - STATION_V)/ACC; }

function create(W, o){
  o = o || {};
  var G = gondolaView(W), wid = String((W && (W.id || W.seed)) || ""), seed = o.seed != null ? String(o.seed) : wid, tier = o.tier != null ? o.tier | 0 : 5;
  var heightAt = typeof o.heightAt === "function" ? o.heightAt : (W && HQV.world && HQV.world.groundAt ? function(x, z){ return HQV.world.groundAt(W, x, z); } : null);
  var line = G ? G.lines.filter(function(l){ return l.stations.length >= 2 && l.tier <= tier; })[0] : null;
  var RN = HQV.hqRide;
  if(!line) return emptySim();
  var A = line.stations[0], B = line.stations[line.stations.length - 1];
  var ax = B.x - A.x, az = B.z - A.z, AL = hyp(ax, az) || 1, ux = ax/AL, uz = az/AL;   // the line's way, A -> B
  var rx = -uz, rz = ux;                                                              // the right of A -> B
  // supports along the line (m from A, in plan) and the rope's height there: the stations' bull wheels, the towers
  var sup = [{d: 0, y: A.y + DECK + HANG, kind: "station"}];
  line.towers.map(function(t){ return {d: (t.x - A.x)*ux + (t.z - A.z)*uz, y: t.y + t.h, kind: "tower", t: t}; })
    .filter(function(s){ return s.d > 1 && s.d < AL - 1; }).sort(function(a, b){ return a.d - b.d; }).forEach(function(s){ sup.push(s); });
  sup.push({d: AL, y: B.y + DECK + HANG, kind: "station"});
  // each span's sag: SAG of its length, less where the cabin would come within CLEAR of the ground
  var spans = [];
  for(var i = 0; i + 1 < sup.length; i++){
    var a = sup[i], b = sup[i + 1], len = b.d - a.d, sag = SAG*len;
    if(heightAt){
      for(var tries = 0; tries < 12; tries++){
        var low = Infinity;
        for(var k = 1, ks = Math.max(20, Math.ceil(len)); k < ks; k++){
          var u = k/ks, d = a.d + len*u, y = a.y + (b.y - a.y)*u - 4*sag*u*(1 - u);
          if(d < NEAR_ST || d > AL - NEAR_ST) continue;
          [-1, 1].forEach(function(ln){ var g = heightAt(A.x + ux*d + rx*ln*ROPE_GAP, A.z + uz*d + rz*ln*ROPE_GAP); if(isFinite(g)) low = Math.min(low, y - HANG - g); });
        }
        if(low >= CLEAR || sag <= 0) break;
        sag = Math.max(0, sag - (CLEAR - low) - 0.05);
      }
    }
    spans.push({a: a, b: b, len: len, sag: sag});
  }
  // the rope's height at d m from A (in plan)
  function ropeAt(d){
    d = clamp(d, 0, AL);
    for(var i = 0; i < spans.length; i++){
      var s = spans[i]; if(d > s.b.d && i < spans.length - 1) continue;
      var u = s.len > 0 ? clamp((d - s.a.d)/s.len, 0, 1) : 0;
      return s.a.y + (s.b.y - s.a.y)*u - 4*s.sag*u*(1 - u);
    }
    return sup[0].y;
  }
  // the loop: out on A's right lane to B, round B, back, round A. A station section: RAMP + straight + half a bull
  // wheel + straight + RAMP, its straight sized so the whole loop is n*EVERY s
  var ropeT = AL/LINE_V, wheel = Math.PI*ROPE_GAP, rampT = rampTime();
  var minSt = 2*rampT + (2*STRAIGHT_MIN + wheel)/STATION_V, n = Math.max(2, Math.ceil((2*ropeT + 2*minSt)/EVERY));
  var stT = (n*EVERY - 2*ropeT)/2, slow = (stT - 2*rampT)*STATION_V, straight = (slow - wheel)/2, stLen = 2*RAMP + slow, T = n*EVERY;
  // a station section's position: x along its local axis (m in from the mouth), lane (+1 the arriving lane)
  function inStation(tau){
    var x, v, side, around = 0;
    if(tau < rampT){ v = LINE_V - ACC*tau; x = (LINE_V + v)/2*tau; side = 1; }
    else if(tau < stT - rampT){
      var u = (tau - rampT)*STATION_V; v = STATION_V;
      if(u < straight){ x = RAMP + u; side = 1; }
      else if(u < straight + wheel){ around = (u - straight)/wheel; x = RAMP + straight; side = 0; }
      else { x = RAMP + straight - (u - straight - wheel); side = -1; }
    } else { var tb = stT - tau; v = LINE_V - ACC*tb; x = (LINE_V + v)/2*tb; side = -1; }
    return {x: x, v: v, side: side, around: around};
  }
  // a station's frame: its mouth (where the rope enters), the way in (towards the bull wheel), the lanes
  var ST = [A, B].map(function(s, i){
    var inx = i === 0 ? -ux : ux, inz = i === 0 ? -uz : uz;                    // the way in from the rope
    return {s: s, i: i, inx: inx, inz: inz, mx: s.x, mz: s.z, y: s.y + DECK, rope: s.y + DECK + HANG};
  });
  // a cabin tau s into the loop (from leaving A's mouth on the out rope): {x, y (floor), z, yaw, speed, station, leg}
  function at(tau){
    tau = mod(tau, T);
    var x, y, z, yaw, v, st = -1, leg;
    if(tau < ropeT){                                                   // out: A -> B on the right of A -> B
      var d = tau*LINE_V; x = A.x + ux*d + rx*ROPE_GAP; z = A.z + uz*d + rz*ROPE_GAP; y = ropeAt(d) - HANG; yaw = Math.atan2(ux, uz); v = LINE_V; leg = "out";
      return {x: x, y: y, z: z, yaw: yaw, speed: v, station: -1, leg: leg, d: d, lane: 1};
    }
    tau -= ropeT;
    if(tau < stT){ st = 1; }
    else {
      tau -= stT;
      if(tau < ropeT){                                                 // back: B -> A on the right of B -> A
        var e = AL - tau*LINE_V; x = A.x + ux*e - rx*ROPE_GAP; z = A.z + uz*e - rz*ROPE_GAP; y = ropeAt(e) - HANG; yaw = Math.atan2(-ux, -uz); v = LINE_V;
        return {x: x, y: y, z: z, yaw: yaw, speed: v, station: -1, leg: "back", d: e, lane: -1};
      }
      tau -= ropeT; st = 0;
    }
    var S = ST[st], p = inStation(tau), ix = S.inx, iz = S.inz, lx = iz, lz = -ix;    // lx: the left of the way in
    // arriving on the right of the way in, leaving on its left; round the bull wheel between
    var cx = S.mx + ix*p.x, cz = S.mz + iz*p.x, yw;
    if(p.side === 1){ x = cx - lx*ROPE_GAP; z = cz - lz*ROPE_GAP; yw = Math.atan2(ix, iz); }
    else if(p.side === -1){ x = cx + lx*ROPE_GAP; z = cz + lz*ROPE_GAP; yw = Math.atan2(-ix, -iz); }
    else {
      var ang = Math.PI*p.around, ox = -lx*Math.cos(ang) + ix*Math.sin(ang), oz = -lz*Math.cos(ang) + iz*Math.sin(ang);
      x = cx + ox*ROPE_GAP; z = cz + oz*ROPE_GAP; yw = Math.atan2(ix*Math.cos(ang) + lx*Math.sin(ang), iz*Math.cos(ang) + lz*Math.sin(ang));
    }
    // the floor eases from the rope's height at the mouth to the platform over the ramp
    var f = clamp(p.x/RAMP, 0, 1), ry = ropeAt(st === 0 ? 0 : AL) - HANG;
    y = ry + (S.y - ry)*f;
    return {x: x, y: y, z: z, yaw: yw, speed: p.v, station: st, leg: "station", side: p.side, inX: p.x, lane: p.side};
  }
  var offT = (hash32(seed + ":G1") % (EVERY*1000))/1000;
  // cabin i's loop time at ms; cabin 0 leaves A's mouth at offT + k*T
  function tauOf(i, ms){ return mod(fin(ms, 0)/1000 - offT - i*EVERY, T); }
  // within a station: the time a cabin is at its boarding point (the middle of the out-lane straight) and leaves the mouth
  var boardIn = rampT + (straight + wheel + straight/2)/STATION_V, leaveIn = stT;
  var unloadIn = rampT + (straight/2)/STATION_V;
  var stopStart = [ropeT*2 + stT, ropeT];                              // loop time a cabin enters A's (0) and B's (1) station
  function names(i){ var s = i === 0 ? A : B; try { if(RN && RN.stationName && W) return RN.stationName(W, s.x, s.z, "gondola"); } catch(e){} return i === 0 ? "Valley Station" : line.kind === "summit" ? "Summit" : "Far Station"; }
  var STOPS = [A, B].map(function(s, i){ return {id: s.id, name: names(i), x: s.x, y: s.y + DECK, z: s.z, mode: "gondola", lines: [line.id], kind: "station", under: false,
                                                 summit: line.kind === "summit" && i === 1}; });
  // the next cabin that is at the boarding point of station si at or after ms: its index and the time
  function nextBoard(si, ms){
    var t = fin(ms, 0)/1000, phase = stopStart[si] + boardIn;           // loop time of boarding at si
    // cabin i is at loop time phase when t = offT + i*EVERY + phase + m*T: boardings every EVERY s
    var k = Math.ceil((t - offT - phase)/EVERY - 1e-9), i = mod(k, n);
    return {i: i, at: (offT + k*EVERY + phase)*1000, k: k};
  }
  function cabinAt(i, ms){ var p = at(tauOf(i, ms)); p.id = "G1:" + i; p.i = i; p.doors = p.station >= 0 && p.inX != null && p.inX > RAMP - 0.5 ? 1 : 0; return p; }
  var sim = {
    mode: "gondola", kind: line.kind, line: line,
    lines: function(){ return [{id: line.id, mode: "gondola", name: line.kind === "summit" ? "Gondola to the summit" : "Gondola", short: "G1", color: COLOR, stops: [A.id, B.id], headway: EVERY, loop: true}]; },
    stops: function(){ return STOPS.map(function(s){ var c = {}; for(var k in s) c[k] = s[k]; c.lines = s.lines.slice(); return c; }); },
    stopsNear: function(x, z, r){
      return STOPS.map(function(s){ return {id: s.id, name: s.name, dist: hyp(s.x - x, s.z - z), mode: "gondola", lines: s.lines.slice()}; })
        .filter(function(s){ return s.dist <= r; }).sort(function(a, b){ return a.dist - b.dist || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
    },
    departures: function(stopId, ms, n2){
      var si = stopId === A.id ? 0 : stopId === B.id ? 1 : -1; if(si < 0) return [];
      n2 = Math.max(1, (n2 | 0) || 4);
      var nb = nextBoard(si, fin(ms, 0) - (leaveIn - boardIn)*1000), rows = [];
      for(var q = 0; q < n2; q++){
        var t = nb.at + q*EVERY*1000 + (leaveIn - boardIn)*1000;
        rows.push({line: line.id, short: "G1", to: STOPS[1 - si].name, at: Math.round(t), plat: null, boarding: ms >= t - (leaveIn - boardIn + straight/2/STATION_V)*1000 && ms < t, delay: 0});
      }
      return rows;
    },
    trip: function(lineId, from, to, ms){
      if(lineId !== line.id) return null;
      var si = from === A.id ? 0 : from === B.id ? 1 : -1, sj = to === A.id ? 0 : to === B.id ? 1 : -1;
      if(si < 0 || sj < 0 || si === sj) return null;
      var nb = nextBoard(si, ms), i = nb.i, board = nb.at, base = board - (stopStart[si] + boardIn)*1000;   // the loop's start for this cabin
      var depart = Math.round(base + (stopStart[si] + leaveIn - rampT)*1000), arrive = Math.round(base + (stopStart[si] + rampT + straight/STATION_V + wheel/STATION_V)*1000);
      var tEnter = si === 0 ? ropeT : 2*ropeT + stT;                   // the destination's station, leaving si's mouth at loop time stopStart[si] + stT (mod T)
      var tLeave = stopStart[si] + stT, reach = Math.round(base + (tLeave + (mod(tEnter - tLeave, T)) + unloadIn)*1000);
      var trip = {mode: "gondola", line: line.id, short: "G1", vehicle: "G1:" + i, from: from, to: to, fromName: STOPS[si].name, toName: STOPS[sj].name,
        arrive: arrive, depart: depart, reach: reach, seats: SEATS.length, standing: 0, seatMeta: SEATS.map(function(s){ return {window: true, side: s.x < 0 ? "right" : "left"}; }),
        summit: STOPS[sj].summit, stops: [{id: from, name: STOPS[si].name, at: depart}, {id: to, name: STOPS[sj].name, at: reach, summit: STOPS[sj].summit}],
        pose: function(t){ var p = cabinAt(i, t); return {x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: 0, speed: p.speed, doors: p.doors, under: false, done: t >= reach}; },
        seat: function(k, t){ var p = cabinAt(i, t), s = SEATS[clamp(k | 0, 0, SEATS.length - 1)], c = Math.cos(p.yaw), sn = Math.sin(p.yaw);
          return {x: p.x + c*s.x + sn*s.z, y: p.y + s.y, z: p.z - sn*s.x + c*s.z, yaw: p.yaw + (s.back ? Math.PI : 0)}; },
        door: function(t){ var p = cabinAt(i, t); return {x: p.x - Math.cos(p.yaw)*(CAB_W/2 + 0.3), z: p.z + Math.sin(p.yaw)*(CAB_W/2 + 0.3)}; }};
      return trip;
    },
    cabins: function(ms){ var out = []; for(var i = 0; i < n; i++) out.push(cabinAt(i, ms)); return out; },
    vehicles: function(ms){
      var C = HQV.hqCommute;
      return sim.cabins(ms).map(function(p){ return {id: p.id, line: line.id, mode: "gondola", x: p.x, y: p.y, z: p.z, yaw: p.yaw, speed: p.speed, doors: p.doors,
        load: C && C.load ? C.load("gondola", line.id, p.id, ms, seed) : 0.4, under: false, station: p.station}; });
    },
    loop: function(){ return {len: 2*AL + 2*stLen, T: T, n: n, ropeT: ropeT, stT: stT, straight: straight, wheel: wheel, rampT: rampT, AL: AL}; },
    ropeAt: ropeAt, at: at, spans: function(){ return spans.map(function(s){ return {a: s.a.d, b: s.b.d, ya: s.a.y, yb: s.b.y, len: s.len, sag: s.sag}; }); },
    supports: function(){ return sup.map(function(s){ return {d: s.d, y: s.y, kind: s.kind}; }); },
    frame: function(){ return {A: A, B: B, ux: ux, uz: uz, rx: rx, rz: rz, AL: AL, ST: ST}; },
    // the lowest cabin bottom over the ground between the stations (NEAR_ST m clear of their mouths), on both lanes
    clearance: function(h){
      h = h || heightAt; if(!h) return null;
      var lo = Infinity;
      for(var d = NEAR_ST; d <= AL - NEAR_ST; d += 1) [-1, 1].forEach(function(ln){ var g = h(A.x + ux*d + rx*ln*ROPE_GAP, A.z + uz*d + rz*ln*ROPE_GAP); if(isFinite(g)) lo = Math.min(lo, ropeAt(d) - HANG - g); });
      return lo;
    },
    seed: seed
  };
  return sim;
}
function emptySim(){
  return {mode: "gondola", lines: function(){ return []; }, stops: function(){ return []; }, stopsNear: function(){ return []; }, departures: function(){ return []; },
          trip: function(){ return null; }, vehicles: function(){ return []; }, cabins: function(){ return []; }, loop: function(){ return null; }, empty: true};
}
// the wind's sway (rad) of cabin i at ms: gentle, seeded; none under Calm
function swayAt(i, ms, wind, calm, seed){
  if(calm || !(wind > 0)) return {roll: 0, pitch: 0};
  var ph = (hash32(String(seed) + ":sway:" + i) % 6283)/1000, t = fin(ms, 0)/1000, a = 0.05*clamp(wind, 0, 1);
  return {roll: a*Math.sin(t*0.9 + ph), pitch: a*0.4*Math.sin(t*0.63 + ph*1.7)};
}

/* ---------- drawing (THREE) ---------- */
function view(c, sim, opts){
  var THREE = c.THREE, H = HQV.hqRail, PT = H && H.parts; opts = opts || {};
  if(!PT || !sim || sim.empty) return null;
  var K = PT.kit(THREE), F = sim.frame(), A = F.A, B = F.B, root2 = new THREE.Group(); root2.name = "gondola";
  var ground = typeof opts.ground === "function" ? opts.ground : function(){ return 0; };
  var calm = typeof opts.calm === "function" ? opts.calm : function(){ return false; };
  var sfx = typeof opts.sfx === "function" ? opts.sfx : function(){};
  var parts = [], lp = sim.loop();
  // the rope: both lanes, a catenary every 4 m between the mouths, and the loop round each bull wheel
  [-1, 1].forEach(function(ln){
    var prev = null;
    for(var d = 0; d <= F.AL + 0.01; d += 4){
      var dd = Math.min(d, F.AL), p = [A.x + F.ux*dd + F.rx*ln*ROPE_GAP, sim.ropeAt(dd), A.z + F.uz*dd + F.rz*ln*ROPE_GAP];
      if(prev) parts.push(K.strut(prev, p, 0.07, 0x23262a));
      prev = p;
    }
  });
  F.ST.forEach(function(S){
    var s = S.s, ix = S.inx, iz = S.inz, lx = iz, lz = -ix, depth = RAMP + lp.straight, wx = s.x + ix*depth, wz = s.z + iz*depth, ry = S.rope;
    var prev = null;
    for(var k = 0; k <= 16; k++){ var a = Math.PI*k/16, p = [wx - lx*ROPE_GAP*Math.cos(a) + ix*ROPE_GAP*Math.sin(a), ry, wz - lz*ROPE_GAP*Math.cos(a) + iz*ROPE_GAP*Math.sin(a)]; if(prev) parts.push(K.strut(prev, p, 0.07, 0x23262a)); prev = p; }
    [-1, 1].forEach(function(sd){ parts.push(K.strut([s.x + lx*sd*ROPE_GAP, ry, s.z + lz*sd*ROPE_GAP], [wx + lx*sd*ROPE_GAP, ry, wz + lz*sd*ROPE_GAP], 0.07, 0x23262a)); });
    var yaw = Math.atan2(ix, iz), cx = s.x + ix*depth/2, cz = s.z + iz*depth/2, L = depth + ROPE_GAP + 3;
    // the platform, the bull-wheel housing (a roof on columns over the whole loop), the wheel itself
    parts.push(K.box(2*ROPE_GAP + 5, 0.4, L, cx, S.y - 0.2, cz, 0xcfc9bd, yaw));
    parts.push(K.box(2*ROPE_GAP + 6, 0.5, L + 1, cx, ry + 1.6, cz, 0xb83a2e, yaw));
    parts.push(K.box(2*ROPE_GAP + 6.4, 0.25, L + 1.4, cx, ry + 2.0, cz, 0xe7edf2, yaw));
    parts.push(K.cyl(ROPE_GAP + 0.25, ROPE_GAP + 0.25, 0.35, 24, wx, ry - 0.2, wz, 0x4a4f55));
    [-1, 1].forEach(function(sd){ [-1, 1].forEach(function(e){
      var px = cx + lx*sd*(ROPE_GAP + 2.6) + ix*e*L/2, pz = cz + lz*sd*(ROPE_GAP + 2.6) + iz*e*L/2;
      parts.push(K.cyl(0.18, 0.2, ry + 1.4 - S.y, 8, px, S.y, pz, 0x3d5566));
    }); });
    var gy = ground(cx, cz); if(isFinite(gy) && S.y - gy > 0.6) parts.push(K.box(2*ROPE_GAP + 4.6, S.y - gy, L - 0.4, cx, gy + (S.y - gy)/2, cz, 0xa7abae, yaw));
    // the summit's viewing deck: a terrace out past the bull wheel with a railing
    if(sim.kind === "summit" && S.i === 1){
      var dx = s.x + ix*(depth + 9), dz = s.z + iz*(depth + 9);
      parts.push(K.box(12, 0.3, 8, dx, S.y - 0.15, dz, 0x9c7a55, yaw));
      [[-6, -4, 6, -4], [6, -4, 6, 4], [6, 4, -6, 4], [-6, 4, -6, -4]].forEach(function(r){
        function w(a, b){ return [dx + lx*a + ix*b, S.y + 1.0, dz + lz*a + iz*b]; }
        parts.push(K.strut(w(r[0], r[1]), w(r[2], r[3]), 0.06, 0x3d5566));
      });
    }
  });
  // lattice towers: four tapering legs, braces, a crossarm with sheave trains over each lane
  (sim.line.towers || []).forEach(function(t){
    var top = t.y + t.h, yaw = Math.atan2(F.ux, F.uz), lx = F.rx, lz = F.rz, fx = F.ux, fz = F.uz, b0 = Math.max(1.4, t.h*0.08), b1 = 0.6;
    function corner(sx, sz, y, half){ return [t.x + lx*sx*half + fx*sz*half, y, t.z + lz*sx*half + fz*sz*half]; }
    var C4 = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    C4.forEach(function(q){ parts.push(K.strut(corner(q[0], q[1], t.y, b0), corner(q[0], q[1], top - 0.6, b1), 0.18, 0x7d878f)); });
    for(var yy = t.y + 3; yy < top - 1; yy += 4){
      var u0 = (yy - t.y)/t.h, u1 = Math.min(1, (yy + 4 - t.y)/t.h), h0 = b0 + (b1 - b0)*u0, h1 = b0 + (b1 - b0)*u1;
      for(var q = 0; q < 4; q++){ var a = C4[q], b = C4[(q + 1) % 4]; parts.push(K.strut(corner(a[0], a[1], yy, h0), corner(b[0], b[1], Math.min(top - 0.6, yy + 4), h1), 0.08, 0x7d878f)); }
    }
    parts.push(K.box(2*ROPE_GAP + 1.6, 0.45, 0.6, t.x, top - 0.4, t.z, 0x5f6a72, yaw + Math.PI/2));
    [-1, 1].forEach(function(ln){
      var sx = t.x + lx*ln*ROPE_GAP, sz = t.z + lz*ln*ROPE_GAP;
      parts.push(K.box(0.35, 0.3, 3.2, sx, top - 0.05, sz, 0x2b2f33, yaw));
      for(var k = -1; k <= 1; k++) parts.push(K.cyl(0.28, 0.28, 0.12, 10, sx + fx*k*0.9, top + 0.05, sz + fz*k*0.9, 0x111316));
    });
  });
  var mat = PT.vcMat(c, {roughness: 0.75}), stat = new THREE.Mesh(K.merge(parts), mat);
  stat.castShadow = true; stat.receiveShadow = true; root2.add(stat);
  // a cabin: frame, roof, floor, hanger and grip, two benches and the map placard (vertex colours); glass all round
  var cab = [], hw = CAB_W/2, hl = CAB_L/2;
  cab.push(K.box(CAB_W, 0.12, CAB_L, 0, 0.06, 0, 0x2f3438), K.box(CAB_W + 0.1, 0.18, CAB_L + 0.1, 0, CAB_H, 0, 0xb83a2e));
  [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(function(q){ cab.push(K.box(0.08, CAB_H, 0.08, q[0]*hw, CAB_H/2, q[1]*hl, 0xb83a2e)); });
  cab.push(K.box(CAB_W, 0.5, 0.06, 0, 0.35, -hl, 0xb83a2e), K.box(CAB_W, 0.5, 0.06, 0, 0.35, hl, 0xb83a2e));
  cab.push(K.box(0.12, HANG - CAB_H, 0.12, 0, CAB_H + (HANG - CAB_H)/2, 0, 0x2b2f33), K.box(0.3, 0.25, 0.6, 0, HANG - 0.1, 0, 0x2b2f33));
  [-1, 1].forEach(function(e){
    cab.push(K.box(CAB_W - 0.25, 0.08, 0.42, 0, 0.45, e*0.62, 0x3a5f8a), K.box(CAB_W - 0.25, 0.5, 0.06, 0, 0.75, e*(hl - 0.08), 0x3a5f8a));
  });
  cab.push(K.box(0.5, 0.35, 0.02, 0, 1.55, -hl + 0.06, 0xf4efe0));                       // the map placard
  var cabGeo = K.merge(cab), glassGeo = new THREE.BoxGeometry(CAB_W - 0.04, CAB_H - 0.65, CAB_L - 0.04); glassGeo.translate(0, 0.6 + (CAB_H - 0.65)/2, 0);
  var cmat = PT.vcMat(c, {roughness: 0.5, metalness: 0.2});
  var gmat = c.mat(0x9fc6d8, {transparent: true, opacity: 0.28, depthWrite: false, roughness: 0.1, metalness: 0.4, side: THREE.DoubleSide});
  var N = lp.n, cabs = new THREE.InstancedMesh(cabGeo, cmat, N), glass = new THREE.InstancedMesh(glassGeo, gmat, N);
  cabs.castShadow = true; cabs.frustumCulled = glass.frustumCulled = false;
  root2.add(cabs); root2.add(glass);
  if(c.scene && opts.attach !== false) c.scene.add(root2);
  var dummy = new THREE.Object3D(), focusId = null, lastMs = 0, lastD = null, nextRumble = 0, nextWind = 0;
  var towersD = sim.supports().filter(function(s){ return s.kind === "tower"; }).map(function(s){ return s.d; });
  function windNow(ms){
    var WX = HQV.hqWeather;
    if(!WX || !WX.look) return 0;
    try { return +WX.look(opts.world || sim.seed, ms).wind || 0; } catch(e){ return 0; }
  }
  var V = {g: root2,
    update: function(ms, dt, cam){
      lastMs = ms;
      var wind = windNow(ms), still = !!calm() || !!opts.reduced, list = sim.cabins(ms), mine = null;
      list.forEach(function(p, i){
        var sw = swayAt(i, ms, wind, still, sim.seed);
        // hang from the grip: the sway rotates the cabin about the grip, HANG over its floor
        dummy.position.set(p.x, p.y + HANG, p.z); dummy.rotation.set(sw.pitch, p.yaw, sw.roll, "YXZ"); dummy.updateMatrix();
        dummy.matrix.multiply(new THREE.Matrix4().makeTranslation(0, -HANG, 0));
        cabs.setMatrixAt(i, dummy.matrix); glass.setMatrixAt(i, dummy.matrix);
        if(p.id === focusId) mine = p;
      });
      cabs.instanceMatrix.needsUpdate = true; glass.instanceMatrix.needsUpdate = true;
      // sounds: the bull wheel's rumble near a station, a clunk as your cabin rolls over a tower's sheaves, the wind up high
      if(cam && ms >= nextRumble && [A, B].some(function(s){ return hyp(cam.x - s.x, cam.z - s.z) < 40; })){ nextRumble = ms + 4000; sfx("gondola-rumble"); }
      if(mine){
        if(mine.d != null && lastD != null) towersD.forEach(function(d){ if((lastD - d)*(mine.d - d) < 0) sfx("gondola-clunk"); });
        lastD = mine.d != null ? mine.d : null;
        var g = ground(mine.x, mine.z);
        if(wind > 0.3 && ms >= nextWind && isFinite(g) && mine.y - g > 15){ nextWind = ms + 6000; sfx("gondola-wind"); }
      } else lastD = null;
    },
    focus: function(id){ focusId = id || null; lastD = null; glass.material.opacity = focusId ? 0.16 : 0.28; },
    drawCalls: function(){ return 3; },
    tools: {shotCam: function(name){
      var mid = F.AL/2, mx = A.x + F.ux*mid, mz = A.z + F.uz*mid, my = sim.ropeAt(mid);
      if(name === "gondola-line") return {pos: {x: mx + F.rx*70 - F.ux*40, y: my + 6, z: mz + F.rz*70 - F.uz*40}, look: {x: mx, y: my - 6, z: mz}, fov: 60};
      if(name === "gondola-summit"){ var S = F.ST[1], s = S.s; return {pos: {x: s.x - S.inx*30 + F.rx*18, y: S.y + 9, z: s.z - S.inz*30 + F.rz*18}, look: {x: s.x + S.inx*8, y: S.y + 2, z: s.z + S.inz*8}, fov: 60}; }
      if(name === "gondola-cabin"){
        var best = null; sim.cabins(lastMs).forEach(function(p){ if(p.station < 0 && (!best || Math.abs(p.d - mid) < Math.abs(best.d - mid))) best = p; });
        if(!best) return null;
        var fx = Math.sin(best.yaw), fz = Math.cos(best.yaw);
        return {pos: {x: best.x - fx*0.7, y: best.y + 1.2, z: best.z - fz*0.7}, look: {x: best.x + fx*6, y: best.y + 0.4, z: best.z + fz*6}, fov: 70, vehicle: best.id};
      }
      return null;
    }},
    dispose: function(){
      if(root2.parent) root2.parent.remove(root2);
      stat.geometry.dispose(); mat.dispose(); cabGeo.dispose(); glassGeo.dispose(); cmat.dispose(); gmat.dispose();
    }};
  return V;
}

HQV.hqGondola = {create: create, view: view, swayAt: swayAt, gondolaView: gondolaView, SEATS: SEATS,
  EVERY: EVERY, LINE_V: LINE_V, STATION_V: STATION_V, ACC: ACC, ROPE_GAP: ROPE_GAP, SAG: SAG, HANG: HANG, CLEAR: CLEAR, RAMP: RAMP, DECK: DECK};
})();
