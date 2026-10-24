/* Claude HQ: commuters on the city's transit (HQ 3.15 transport revamp, plan 3.5 / 5.6, part `ride`).
 *
 * HQV.hqCommute: how full every bus, tram, train, cabin and boat is, who sits where, and how many wait
 * at a stop. Everything is a pure function of (mode, line, vehicle, trip, UTC ms, world seed), so every
 * client sees the same people in the same seats with no traffic.
 *   curve(hourLocal) -> 0.08..1.15     the day's demand: peaks 08:00-09:30 and 17:00-19:00 (1.15: people
 *                                      standing), midday 0.45, night 0.08; smooth (eased between keyframes)
 *   load(mode, lineId, vehicleId, ms, seed) -> 0..1.15
 *                                      base(mode) x curve(local hour) x line weight x seeded per-trip jitter,
 *                                      plus the city's residents riding that line when npcsim says so
 *                                      (HQV.npcSim.ridersOn(lineId, localMs), when present)
 *   occupied(mode, vehicleId, tripKey, seats, standing, ms, seed) -> {seats: [i...], standing: [j...]}
 *                                      which seat indices (0..seats-1) and standing spots (0..standing-1)
 *                                      are taken, in a seeded order: the same for everyone. Pass the
 *                                      trip's departure ms so the figures do not change mid-ride.
 *   crowd(stopId, mode, ms, seed) -> 0..24   people waiting at a stop or on a platform
 *   figureGeometry(kind) -> {pos, nrm, col, tint, idx}   pure low-poly passenger ("seated" | "standing")
 *   figures(THREE) -> {seated, standing: BufferGeometry, material}   one InstancedMesh each; instanceColor
 *                                      tints only the shirt (the aTint attribute), the rest keeps its colours
 *   paint(seedKey) -> {shirt: [r, g, b], hair, skin}   0..1 sRGB colours for one passenger
 * Clock: the city's day is the local wall clock (as npcsim.localMs and the City's day and night).
 * Frames: metres, +y up, yaw 0 faces +z. Seated figures: origin on the seat surface; standing: on the floor.
 * Pure top half: no THREE, no DOM, so node loads it (tests/test_hqcommute.py).
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : self;
var HQV = root.HQV = root.HQV || {};

var MIN = 60000, HOUR = 3600000, DAY = 86400000;
// [hour, value]: eased (smoothstep) between neighbours, so the curve is smooth with flat peaks
var KEYS = [[0, 0.08], [5, 0.08], [6.5, 0.4], [8, 1.15], [9.5, 1.15], [11, 0.45], [15.5, 0.45], [17, 1.15], [19, 1.15],
            [20.5, 0.5], [22.5, 0.2], [24, 0.08]];
var BASE = {bus: 0.85, tram: 0.95, metro: 1, rail: 0.8, link: 0.6, ferry: 0.6, waterbus: 0.6, launch: 0.5, gondola: 0.5, cab: 0};
var CAP = {bus: 31, tram: 48, metro: 64, rail: 72, link: 72, ferry: 36, waterbus: 36, launch: 12, gondola: 8};
var TRIP_BUCKET = 30*MIN;          // a vehicle's jitter holds for this long (one trip, roughly)
var CROWD_MAX = 24, CROWD_BUCKET = 5*MIN;
var SHIRTS = [0x3d6fd1, 0xe0559b, 0x6fd38a, 0xffb347, 0x9b8cf0, 0xf4f4f4, 0xff6b5b, 0x5fd3e6, 0x2f3b4c, 0xc2a36b, 0x8a3d3d, 0x4c8c6c];
var HAIR = [0x1d1510, 0x3b2615, 0x6b4423, 0xa8753c, 0xd9b26f, 0x8c8c8c, 0x2b2b2b];
var SKIN = [0xf1d0b5, 0xe0b48f, 0xc68c62, 0xa86b45, 0x7d4b2c, 0x5a3520];

/* ---------- hashing (FNV-1a 32, murmur3 finaliser) ---------- */
function hash32(str){
  str = String(str == null ? "" : str);
  if(/[^\x00-\x7f]/.test(str)) str = unescape(encodeURIComponent(str));
  var h = 0x811c9dc5;
  for(var i = 0; i < str.length; i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function mix(h){ h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h >>> 0; }
function u01(key){ return mix(hash32(key))/4294967296; }
function rng(seed){ var a = seed >>> 0 || 1; return function(){ a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0)/4294967296; }; }
function clamp(v, a, b){ return v < a ? a : (v > b ? b : v); }
function ease(t){ t = clamp(t, 0, 1); return t*t*(3 - 2*t); }

/* ---------- the day ---------- */
function curve(h){
  h = +h; if(!isFinite(h)) h = 0;
  h = ((h % 24) + 24) % 24;
  for(var i = 0; i + 1 < KEYS.length; i++){
    var a = KEYS[i], b = KEYS[i + 1];
    if(h >= a[0] && h <= b[0]) return a[1] + (b[1] - a[1])*ease((h - a[0])/(b[0] - a[0]));
  }
  return KEYS[0][1];
}
// local wall-clock ms of a UTC ms (the City's day), and its hour
function localMs(ms){ ms = +ms || 0; var off = 0; try { off = new Date(ms).getTimezoneOffset(); } catch(e){ off = 0; } return ms - (off || 0)*MIN; }
function localHour(ms){ var l = localMs(ms); return (((l % DAY) + DAY) % DAY)/HOUR; }

function lineWeight(lineId, seed){ return 0.85 + 0.25*u01(String(seed) + ":lw:" + lineId); }
function jitter(vehicleId, ms, seed){ return 0.85 + 0.3*u01(String(seed) + ":vj:" + vehicleId + ":" + Math.floor((+ms || 0)/TRIP_BUCKET)); }

// residents riding this line (npcsim), spread over its vehicles: at most +0.3
function ridersExtra(mode, lineId, ms){
  var S = HQV.npcSim;
  if(!S || typeof S.ridersOn !== "function" || lineId == null) return 0;
  var n = 0;
  try { n = +S.ridersOn(String(lineId), localMs(ms)) || 0; } catch(e){ n = 0; }
  return n > 0 ? Math.min(0.3, n/((CAP[mode] || 40)*3)) : 0;
}

function load(mode, lineId, vehicleId, ms, seed){
  mode = String(mode || "bus");
  var b = BASE[mode] != null ? BASE[mode] : 0.8;
  if(b <= 0) return 0;
  var key = lineId != null ? lineId : vehicleId;
  var v = b*curve(localHour(ms))*lineWeight(key, seed)*jitter(vehicleId, ms, seed) + ridersExtra(mode, lineId, ms);
  return clamp(Math.round(v*1000)/1000, 0, 1.15);
}

// a seeded permutation of 0..n-1
function perm(n, g){
  var a = []; for(var i = 0; i < n; i++) a.push(i);
  for(i = n - 1; i > 0; i--){ var j = Math.floor(g()*(i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}
function occupied(mode, vehicleId, tripKey, seats, standing, ms, seed){
  seats = Math.max(0, seats | 0); standing = Math.max(0, standing | 0);
  var L = load(mode, null, vehicleId, ms, seed);
  var g = rng(mix(hash32(String(seed) + ":occ:" + vehicleId + ":" + tripKey)));
  var nSeat = Math.min(seats, Math.round(L*seats));
  var nStand = L > 1 ? Math.min(standing, Math.round(clamp((L - 1)/0.15, 0, 1)*standing)) : 0;
  var ps = perm(seats, g), pt = perm(standing, g);
  return {seats: ps.slice(0, nSeat).sort(function(a, b){ return a - b; }),
          standing: pt.slice(0, nStand).sort(function(a, b){ return a - b; })};
}

function crowd(stopId, mode, ms, seed){
  var b = BASE[String(mode || "bus")]; if(b == null) b = 0.8;
  var j = 0.7 + 0.6*u01(String(seed) + ":cr:" + stopId + ":" + Math.floor((+ms || 0)/CROWD_BUCKET));
  return clamp(Math.round(CROWD_MAX*curve(localHour(ms))*b*j*0.85), 0, CROWD_MAX);
}

function rgb(hex){ return [((hex >> 16) & 255)/255, ((hex >> 8) & 255)/255, (hex & 255)/255]; }
function paint(seedKey){
  var g = rng(mix(hash32("paint:" + seedKey)));
  return {shirt: rgb(SHIRTS[Math.floor(g()*SHIRTS.length)]), hair: rgb(HAIR[Math.floor(g()*HAIR.length)]), skin: rgb(SKIN[Math.floor(g()*SKIN.length)])};
}

/* ---------- low-poly passengers ---------- */
// boxes [cx, cy, cz, w, h, d, part]; part 0 skin, 1 shirt (tinted per instance), 2 trousers, 3 hair, 4 shoes
var PART_COL = [[0.88, 0.70, 0.56], [1, 1, 1], [0.22, 0.24, 0.30], [0.20, 0.14, 0.09], [0.10, 0.10, 0.11]];
var FIG = {
  // sitting on a seat whose surface is y = 0, facing +z: thighs forward, shins down, feet on the floor (-0.45)
  seated: [
    [-0.1, 0.07, 0.2, 0.15, 0.14, 0.42, 2], [0.1, 0.07, 0.2, 0.15, 0.14, 0.42, 2],
    [-0.1, -0.2, 0.38, 0.13, 0.4, 0.14, 2], [0.1, -0.2, 0.38, 0.13, 0.4, 0.14, 2],
    [-0.1, -0.42, 0.44, 0.12, 0.06, 0.22, 4], [0.1, -0.42, 0.44, 0.12, 0.06, 0.22, 4],
    [0, 0.42, -0.02, 0.4, 0.56, 0.24, 1],
    [-0.26, 0.42, 0.06, 0.1, 0.46, 0.12, 1], [0.26, 0.42, 0.06, 0.1, 0.46, 0.12, 1],
    [-0.2, 0.2, 0.2, 0.09, 0.09, 0.3, 0], [0.2, 0.2, 0.2, 0.09, 0.09, 0.3, 0],
    [0, 0.84, 0, 0.24, 0.27, 0.25, 0], [0, 0.99, -0.02, 0.26, 0.07, 0.27, 3]
  ],
  // standing on the floor (y = 0), facing +z, the right hand up on the rail (1.85 m)
  standing: [
    [-0.1, 0.42, 0, 0.15, 0.8, 0.17, 2], [0.1, 0.42, 0, 0.15, 0.8, 0.17, 2],
    [-0.1, 0.03, 0.04, 0.13, 0.06, 0.24, 4], [0.1, 0.03, 0.04, 0.13, 0.06, 0.24, 4],
    [0, 1.1, 0, 0.42, 0.6, 0.24, 1],
    [0.27, 1.12, 0, 0.11, 0.52, 0.13, 1], [-0.25, 1.62, 0, 0.1, 0.5, 0.12, 1], [-0.25, 1.9, 0, 0.09, 0.1, 0.09, 0],
    [0, 1.56, 0.01, 0.26, 0.28, 0.26, 0], [0, 1.72, -0.01, 0.28, 0.07, 0.28, 3]
  ]
};
function figureGeometry(kind){
  var B = FIG[kind] || FIG.seated, P = [], N = [], C = [], T = [], idx = [];
  var FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  B.forEach(function(b){
    var hx = b[3]/2, hy = b[4]/2, hz = b[5]/2, col = PART_COL[b[6]], tint = b[6] === 1 ? 1 : 0;
    FACES.forEach(function(f){
      if(kind === "seated" && f[1] === -1 && b[6] !== 4) return;     // undersides never show: save triangles
      var u = f[0] ? [0, 1, 0] : f[1] ? [0, 0, 1] : [1, 0, 0];
      var v = [f[1]*u[2] - f[2]*u[1], f[2]*u[0] - f[0]*u[2], f[0]*u[1] - f[1]*u[0]];
      var base = P.length/3;
      [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(function(q){
        P.push(b[0] + (f[0] + u[0]*q[0] + v[0]*q[1])*hx, b[1] + (f[1] + u[1]*q[0] + v[1]*q[1])*hy, b[2] + (f[2] + u[2]*q[0] + v[2]*q[1])*hz);
        N.push(f[0], f[1], f[2]); C.push(col[0], col[1], col[2]); T.push(tint);
      });
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    });
  });
  return {pos: new Float32Array(P), nrm: new Float32Array(N), col: new Float32Array(C), tint: new Float32Array(T), idx: new Uint16Array(idx)};
}

/* ---------- drawing (THREE) ---------- */
var FIGS = null;
function figures(THREE){
  if(FIGS && FIGS.THREE === THREE) return FIGS.out;
  function geo(kind){
    var G = figureGeometry(kind), g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(G.pos, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(G.nrm, 3));
    g.setAttribute("color", new THREE.BufferAttribute(G.col, 3));
    g.setAttribute("aTint", new THREE.BufferAttribute(G.tint, 1));
    g.setIndex(new THREE.BufferAttribute(G.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
  var mat = new THREE.MeshLambertMaterial({vertexColors: true});
  // the instance colour tints the shirt only
  mat.onBeforeCompile = function(sh){
    var chunk = String((THREE.ShaderChunk || {}).color_vertex || "");
    if(chunk.indexOf("vColor.rgb *= instanceColor.rgb;") < 0) return;     // another three.js: tint the whole figure
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nattribute float aTint;")
      .replace("#include <color_vertex>", chunk.replace("vColor.rgb *= instanceColor.rgb;", "vColor.rgb *= mix(vec3(1.0), instanceColor.rgb, aTint);"));
  };
  mat.customProgramCacheKey = function(){ return "hqcommute-fig"; };
  var out = {seated: geo("seated"), standing: geo("standing"), material: mat};
  FIGS = {THREE: THREE, out: out};
  return out;
}

HQV.hqCommute = {curve: curve, load: load, occupied: occupied, crowd: crowd, figures: figures, figureGeometry: figureGeometry,
                 paint: paint, localHour: localHour, localMs: localMs, BASE: BASE, CAP: CAP, KEYS: KEYS, CROWD_MAX: CROWD_MAX, hash32: hash32};
})();
