/* Claude HQ: flying an exosuit (HQV.hqExoRide, HQ Exosuit) -- the flight model of the six suit frames.
 *
 * Pure (no THREE, no DOM, no clock), so tests/test_hqexoride.py runs it under node:
 *   STATS[frameId]            {id, n, st: [speed, armour, agility, firepower], top, acc, turn, climb, mass, swim, ceiling}
 *   FRAMES                    the frame ids: sentinel, strider, bulwark, abyss, stratos, flux
 *   newState(frameId, x, y, z, yaw)    standing (landed) at (x, y, z); an unknown frame flies as the sentinel
 *   step(st, dt, inp, env)    fixed 1/120 s sub-steps (the remainder carried in st.acc), so 30 Hz and 120 Hz agree;
 *                             dt is clamped to 0..0.25 s (NaN, negative or missing: 0), so nothing ever goes NaN
 * st = {frame, x, y, z, yaw, pitch, roll, speed, vs, mode: "hover"|"cruise"|"swim"|"landed", boost 0..1, boosting,
 *       agl (m above what is under it), acc}. Forward is (-sin yaw, 0, -cos yaw), as a THREE camera's; + yaw turns left.
 * inp = {fwd, back, left, right, up, down, boost} (bools or 0..1). env = {floor(x, z) -> ground y,
 *       water(x, z) -> the water's surface y or null}.
 * Hover (below CRUISE_V m/s): a VTOL, up / down climb and sink straight, left / right yaw on the spot. Cruise (faster):
 * left / right bank it and the bank turns it, up / down pitch it, the climb is the speed along the pitch. Boost raises
 * the top speed 1.8x while the meter drains (0.35/s) and refills it (0.12/s) when let go. Near the floor and slow, with
 * no climb or thrust held, it lands. Speed, acceleration and turn rate come from the frame's stats; the bulwark is
 * slow and heavy. The abyss swims and dives under the water (slower there); the rest float on the surface and cannot go
 * under. The stratos has no height cap; the rest stop at CEILING m.
 */
(function(){
"use strict";
var G = typeof window !== "undefined" ? window : globalThis;
var HQV = G.HQV = G.HQV || {};
var PI = Math.PI;
var H = 1/120;           // the fixed sub-step
var CEILING = 600;       // m: every frame but the stratos
var CRUISE_V = 15;       // m/s: above this it flies on its wings (banked turns), below it hovers
var LAND_V = 4;          // m/s: slower than this near the floor, it settles
var LAND_H = 0.6;        // m above the floor
var REV = 6;             // m/s backwards in a hover

var FR = [
  {id: "sentinel", n: "Sentinel", st: [65, 60, 65, 60]},
  {id: "strider",  n: "Strider",  st: [95, 35, 85, 45]},
  {id: "bulwark",  n: "Bulwark",  st: [25, 100, 15, 90]},
  {id: "abyss",    n: "Abyss",    st: [50, 70, 50, 40], swim: true},
  {id: "stratos",  n: "Stratos",  st: [90, 45, 60, 40], noCap: true},
  {id: "flux",     n: "Flux",     st: [75, 55, 80, 70]}
];
var STATS = {}, FRAMES = [];
FR.forEach(function(f){
  var sp = f.st[0], ar = f.st[1], ag = f.st[2], mass = 0.6 + ar/100;          // the bulwark: 1.6, the strider 0.95
  STATS[f.id] = {id: f.id, n: f.n, st: f.st.slice(), speed: sp, armour: ar, agility: ag, firepower: f.st[3],
    top: 40 + sp*0.9,                       // m/s, as the preview's flight
    acc: (6 + sp*0.14)/mass,                // m/s^2
    turn: 0.5 + ag/100,                     // the bank -> yaw factor (the preview's)
    hoverTurn: (0.6 + ag/100*1.6)/Math.sqrt(mass),   // rad/s on the spot
    climb: (8 + sp*0.1)/mass,               // m/s straight up in a hover
    mass: mass, swim: !!f.swim, ceiling: f.noCap ? null : CEILING};
  FRAMES.push(f.id);
});

function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function num(v, d){ v = +v; return isFinite(v) ? v : d; }
function key(v){ return clamp(num(v === true ? 1 : v, 0), 0, 1); }
function wrapPi(a){ a = num(a, 0); a = ((a + PI) % (2*PI) + 2*PI) % (2*PI) - PI; return isFinite(a) ? a : 0; }
function ease(k, h){ return Math.min(1, k*h); }
function floorOf(env, x, z){ try { return env && typeof env.floor === "function" ? num(env.floor(x, z), 0) : 0; } catch(e){ return 0; } }
function waterOf(env, x, z){
  try { if(!env || typeof env.water !== "function") return null; var w = env.water(x, z); return w === null || w === undefined ? null : (isFinite(+w) ? +w : null); }
  catch(e){ return null; }
}

function newState(frameId, x, y, z, yaw){
  var f = STATS[frameId] ? frameId : "sentinel";
  return {frame: f, x: num(x, 0), y: num(y, 0), z: num(z, 0), yaw: wrapPi(yaw), pitch: 0, roll: 0, speed: 0, vs: 0,
          mode: "landed", boost: 1, boosting: false, agl: 0, acc: 0};
}

function sane(st){
  ["x", "y", "z", "pitch", "roll", "speed", "vs", "agl", "acc"].forEach(function(k){ st[k] = num(st[k], 0); });
  st.yaw = wrapPi(st.yaw); st.boost = clamp(num(st.boost, 1), 0, 1);
  if(!STATS[st.frame]) st.frame = "sentinel";
  if(["hover", "cruise", "swim", "landed"].indexOf(st.mode) < 0) st.mode = "hover";
}

function step(st, dt, inp, env){
  if(!st) return st;
  sane(st);
  dt = clamp(num(dt, 0), 0, 0.25);
  inp = inp || {};
  var I = {f: key(inp.fwd) - key(inp.back), t: key(inp.left) - key(inp.right), v: key(inp.up) - key(inp.down), b: key(inp.boost) > 0.5,
           thr: key(inp.fwd) > 0, up: key(inp.up) > 0};
  st.acc = clamp(st.acc + dt, 0, 1);
  while(st.acc >= H - 1e-9){ st.acc -= H; sub(st, I, env || {}); }
  return st;
}

function sub(st, I, env){
  var F = STATS[st.frame], h = H;
  var w = waterOf(env, st.x, st.z), fl = floorOf(env, st.x, st.z);
  if(w !== null && w < fl) w = null;                              // a dry bed
  var under = F.swim && w !== null && st.y < w - 0.3;             // the abyss, under the surface
  var slow = under ? 0.45 : 1;
  // boost: drains while held (and there is some), refills when let go
  st.boosting = I.b && st.boost > 0.02 && !under;
  st.boost = clamp(st.boost + (st.boosting ? -0.35 : 0.12)*h, 0, 1);
  var top = F.top*slow*(st.boosting ? 1.8 : 1), acc = F.acc*slow*(st.boosting ? 1.5 : 1);
  // speed: thrust up to the top, brake / reverse, drag when neither
  if(st.boosting && I.f >= 0) st.speed += (top - st.speed)*ease(acc/top*1.5, h);
  else if(I.f > 0){ if(st.speed < top) st.speed = Math.min(top, st.speed + acc*I.f*h); }
  else if(I.f < 0) st.speed = Math.max(st.speed > CRUISE_V ? 0 : -REV*slow, st.speed + acc*1.4*I.f*h);
  else st.speed -= st.speed*ease(st.mode === "cruise" ? 0.06/F.mass : 0.9, h);   // a cruise coasts, a hover stops
  if(st.speed > top && !st.boosting) st.speed -= (st.speed - top)*ease(0.8, h);
  if(Math.abs(st.speed) < 1e-4) st.speed = 0;
  var cruise = st.speed > CRUISE_V && !under;
  var climb = F.climb*slow, vsT, rollT, pitchT;
  if(cruise){
    rollT = clamp(I.t*0.9, -1.1, 1.1);
    pitchT = clamp(I.v*0.45*(0.6 + F.agility/100), -0.6, 0.6);
    st.roll += (rollT - st.roll)*ease(2.5*(0.5 + F.agility/100), h);
    st.pitch += (pitchT - st.pitch)*ease(2/F.mass, h);
    st.yaw = wrapPi(st.yaw + st.roll*0.55*F.turn*h);
    vsT = Math.sin(st.pitch)*st.speed;
    st.vs += (vsT - st.vs)*ease(6, h);
  } else {
    st.roll += (I.t*0.15 - st.roll)*ease(3, h);
    st.pitch += (-I.f*0.08 - st.pitch)*ease(3, h);
    st.yaw = wrapPi(st.yaw + I.t*F.hoverTurn*slow*h);
    vsT = I.v*climb*(I.v < 0 ? 1.2 : 1);
    st.vs += (vsT - st.vs)*ease(4/F.mass, h);
  }
  // move
  var cp = cruise ? Math.cos(st.pitch) : 1;
  st.x += -Math.sin(st.yaw)*cp*st.speed*h;
  st.z += -Math.cos(st.yaw)*cp*st.speed*h;
  st.y += st.vs*h;
  // what it cannot go through: the floor, the water's surface (all but the abyss), the ceiling
  fl = floorOf(env, st.x, st.z); w = waterOf(env, st.x, st.z); if(w !== null && w < fl) w = null;
  var base = fl;
  if(w !== null && !F.swim) base = Math.max(fl, w);
  if(st.y < base){ st.y = base; if(st.vs < 0) st.vs = 0; if(cruise && st.pitch < 0) st.pitch *= 0.5; }
  if(F.ceiling !== null && st.y > F.ceiling){ st.y = F.ceiling; if(st.vs > 0) st.vs = 0; if(st.pitch > 0) st.pitch *= 0.5; }
  if(!isFinite(st.y)) st.y = base;
  var surf = w !== null ? Math.max(fl, w) : fl;
  st.agl = Math.max(0, st.y - surf);
  under = F.swim && w !== null && st.y < w - 0.3;
  // the mode
  if(under) st.mode = "swim";
  else if(st.y - base < LAND_H && Math.abs(st.speed) < LAND_V && !I.up && !I.thr && st.vs <= 0.01){
    st.mode = "landed"; st.y = base; st.vs = 0; st.pitch *= 0.9; st.roll *= 0.9;
  } else st.mode = cruise ? "cruise" : "hover";
}

HQV.hqExoRide = {STATS: STATS, FRAMES: FRAMES, H: H, CEILING: CEILING, CRUISE_V: CRUISE_V, newState: newState, step: step};
})();
