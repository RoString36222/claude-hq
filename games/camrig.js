/* Claude HQ: the camera rig for the 3D city (HQV.camrig).
 *
 * Pure, so tests/test_camrig.py runs it under node: no THREE, no DOM, no clock of its own.
 * Every camera mode is data (MODES, VEHICLE); step(state, target, dt, query) advances the
 * springs and returns the pose games/hq3d.js renders: position, look point, up vector, fov,
 * near/far, roll, plus what the HUD needs (hud on/off, vignette, hide the avatar) and `focus`,
 * the far end for see-through (occluders(pose.pos, pose.focus, ...)): the target's head in the
 * chase family, cine and classic; the camera itself in fp, photo and map, so nothing fades there.
 *   map      straight down, span 44..2048 m (altitude derived), pan, wheel zoom, flyMap
 *   far, chase, near   the chase family: the heading follows where you are headed (travelYaw:
 *            S steps back facing forward and the camera swings round to look where you go), its
 *            spring tighter the faster you turn; a pivot that trails your head, a smoothed look-ahead,
 *            speed FOV kick, horizon kept level, vehicle roll, Q/R eased swing and right-drag orbit
 *            offset (eases back after 2 s), Z/C height, wheel distance, eased collision pull-in through
 *            q.hit, never under the ground. Every smoother is a closed-form spring (frame-rate independent).
 *   fp       eye or vehicle seat (car: seat or bonnet), pointer look, head bob
 *   classic  the host's orthographic camera; the rig only reports the mode
 *   photo    detached free camera; cine  deterministic idle orbits and fly-bys
 * Transitions: a 0.5 s blend between modes (0.3 s under reduced motion), and between the map
 * and 3D a dive (dolly-zoom from the map down behind the target, then settle into the
 * preferred mode) or a rise (the reverse).
 * Frames and units are the spec's (docs/plans/3d-city-build-spec.md, "Units and frames"):
 * metres, yaw 0 faces +z, model-local +x is LEFT, pitch positive = nose up.
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};
var PI = Math.PI, DEG = PI/180;

/* ---------- the modes, as data ---------- */
// distances metres, angles degrees; side > 0 = to the right (model-local -x)
var MODES = {
  map:     {fov: 10, lag: 6, collide: 0},
  far:     {back: 15, up: 9, fov: 60, side: 0, lag: 5, collide: 0.4, near: 0.3, chase: true},
  chase:   {back: 7, up: 3.8, fov: 65, side: 0, lag: 6, collide: 0.35, near: 0.3, chase: true},
  near:    {back: 2.8, up: 1.8, fov: 70, side: 0.6, lag: 8, collide: 0.3, near: 0.3, chase: true},
  fp:      {back: 0, up: 1.65, fov: 75, side: 0, lag: 30, collide: 0.15, near: 0.15},
  classic: {ortho: true},
  photo:   {fov: 60, lag: 10, collide: 0.3, near: 0.15},
  cine:    {fov: 50, lag: 1.5, collide: 0.4, near: 0.3}
};
var ORDER = ["far", "chase", "near", "fp", "classic"];
// anchors in the model-local frame (+z forward, +x LEFT), metres
var VEHICLE = {
  car:   {backMul: 1.35, upMul: 0.85, sideMul: 1,   fovSpeedKick: 1,   fpAnchor: {seat: [-0.38, 1.15, 0.1], bonnet: [0, 1.05, 1.6]}, roll: 0},
  moto:  {backMul: 1.0,  upMul: 0.75, sideMul: 1,   fovSpeedKick: 1,   fpAnchor: {seat: [0, 1.35, -0.1]}, roll: 0.4, headLag: 3.5},
  bike:  {backMul: 0.9,  upMul: 0.85, sideMul: 1,   fovSpeedKick: 1,   fpAnchor: {seat: [0, 1.55, -0.2]}, roll: 0.25, headLag: 3},
  skate: {backMul: 1.1,  upMul: 0.55, sideMul: 1.4, fovSpeedKick: 1.6, fpAnchor: {seat: [0, 1.5, 0]}, roll: 0.3},
  // the boats at the docks (games/hqboat.js): low on the water, the jet ski banks into its turns
  rowboat: {backMul: 1.2, upMul: 0.8, sideMul: 1,  fovSpeedKick: 0.5, fpAnchor: {seat: [0, 1.1, -0.1]}, roll: 0},
  jetski:  {backMul: 1.1, upMul: 0.7, sideMul: 1,  fovSpeedKick: 1,   fpAnchor: {seat: [0, 1.25, -0.2]}, roll: 0.3},
  // helicopters (games/hqheli.js): further back and higher, the horizon tilting a little with the bank
  heli:    {backMul: 2.6, upMul: 1.7, sideMul: 1,  fovSpeedKick: 0.6, fpAnchor: {seat: [-0.4, 1.75, 1.0]}, roll: 0.35},
  attack:  {backMul: 2.8, upMul: 1.8, sideMul: 1,  fovSpeedKick: 0.6, fpAnchor: {seat: [0, 1.95, 2.1]}, roll: 0.35}
};
var SPAN_MIN = 44, SPAN_MAX = 2048, HALF = 1024, MAP_TAN = Math.tan(5*DEG);
var LOOK_H = 1.3;          // chase look point above the target's feet (the "head" the camera frames)
var FAR = 6000, BLEND = 0.5, BLEND_RED = 0.3, DIVE = 1.2, DIVE_RED = 0.6, FLY_MAP = 0.8;
// chase family: heading spring omega = clamp(HEAD_MIN + HEAD_K |turnRate|, HEAD_MIN, HEAD_MAX); HEAD_HOLD decays its
// velocity when you stand still; VEH_LAG the vehicle rotation lag (two-wheelers turn sharply, so they use a softer
// VEHICLE[v].headLag and a small horizon roll: the camera swings and tilts gently instead of whipping round); SWING rad/s eased in over SWING_HL s; the pivot
// springs at PIVOT_W within PIVOT_MAX m of the head; look-ahead min(AHEAD_MAX, speed AHEAD_K) at AHEAD_W;
// collision pull-in COL_IN, push-out COL_OUT, COL_HYST m of hysteresis
var HEAD_MIN = 1.6, HEAD_K = 1.1, HEAD_MAX = 6, HEAD_HOLD = 4, VEH_LAG = 7, SWING_HL = 0.08, PIVOT_W = 12, PIVOT_MAX = 1.5;
// HEAD_BIAS/HEAD_BIAS_MAX pick the side of a near-PI goal; HEAD_AGAINST makes the camera wait for a goal turning toward it
var HEAD_BIAS = 0.3, HEAD_BIAS_MAX = 0.7, HEAD_AGAINST = 10;
var AHEAD_W = 4, AHEAD_MAX = 3, AHEAD_K = 0.3, COL_IN = 25, COL_OUT = 3, COL_HYST = 0.3;
var RECENTRE = 2, SWING = 1.9, LIFT = 2, ORBIT_K = 0.006, LOOK_K = 0.0022, ZOOM_K = 0.0015;
var CINE_SHOT = 12;

/* ---------- small maths ---------- */
function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function lerp(a, b, t){ return a + (b - a)*t; }
function wrap(a){ a = (a + PI) % (2*PI); if(a < 0) a += 2*PI; return a - PI; }
function smootherstep(t){ t = clamp(t, 0, 1); return t*t*t*(t*(t*6 - 15) + 10); }
function v3(x, y, z){ return {x: x, y: y, z: z}; }
function vlerp(a, b, t){ return v3(lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t)); }
function vlen(a){ return Math.sqrt(a.x*a.x + a.y*a.y + a.z*a.z); }
function norm(a){ var l = vlen(a) || 1; return v3(a.x/l, a.y/l, a.z/l); }
function num(v, d){ return typeof v === "number" && isFinite(v) ? v : d; }
function smoothFactor(t, linear){ return linear ? clamp(t, 0, 1) : smootherstep(t); }

// Critically damped spring, exact closed form: the same goal reached in any number of steps.
function spring(x, v, goal, omega, dt){
  var c1 = x - goal, c2 = v + omega*c1, e = Math.exp(-omega*dt);
  return [goal + (c1 + c2*dt)*e, (c2 - omega*(c1 + c2*dt))*e];
}
// The same spring after a goal moving at rate r that ends the frame at `goal` (exact for a steady ramp, so a
// turning goal is followed the same at any frame rate; r = 0 is spring()).
function springRamp(x, v, goal, r, omega, dt){
  var lagSS = 2*r/omega, c1 = x - (goal - r*dt) + lagSS, c2 = (v - r) + omega*c1, e = Math.exp(-omega*dt);
  return [goal - lagSS + (c1 + c2*dt)*e, r + (c2 - omega*(c1 + c2*dt))*e];
}
// model-local (lx, lz) rotated by yaw onto world (x, z)
function rotYaw(lx, lz, yaw){
  var c = Math.cos(yaw), sn = Math.sin(yaw);
  return {x: lx*c + lz*sn, z: -lx*sn + lz*c};
}
// model-local anchor -> world: R = Ry(yaw) Rx(-pitch) Rz(roll) (three.js "YXZ"), plus the target
function fpAnchorWorld(tgt, a){
  var yaw = num(tgt.yaw, 0), th = -num(tgt.pitch, 0), r = num(tgt.roll, 0);
  var x = a[0], y = a[1], z = a[2], c, sn, t;
  c = Math.cos(r); sn = Math.sin(r); t = x*c - y*sn; y = x*sn + y*c; x = t;      // Rz(roll)
  c = Math.cos(th); sn = Math.sin(th); t = y*c - z*sn; z = y*sn + z*c; y = t;    // Rx(-pitch)
  c = Math.cos(yaw); sn = Math.sin(yaw); t = x*c + z*sn; z = -x*sn + z*c; x = t; // Ry(yaw)
  return v3(num(tgt.x, 0) + x, num(tgt.y, 0) + y, num(tgt.z, 0) + z);
}
// a deterministic number in [0, 1) from two integers
function hash01(a, b){
  var h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return (h >>> 0)/4294967296;
}

/* ---------- settings and state ---------- */
function normSettings(o, base){
  o = o || {}; base = base || {fov: 65, sens: 1, invertY: false, reduced: false, headBob: true};
  return {fov: clamp(num(o.fov, base.fov), 60, 100), sens: clamp(num(o.sens, base.sens), 0.2, 3),
          invertY: o.invertY == null ? base.invertY : !!o.invertY, reduced: o.reduced == null ? base.reduced : !!o.reduced,
          headBob: o.headBob == null ? base.headBob : !!o.headBob};
}
function spanClamp(v){ return clamp(num(v, 1024), SPAN_MIN, SPAN_MAX); }
// how far the map may pan (m from the origin): the world's half, or more where the City draws past it (setReach:
// the Commons' airfield and its approach piers reach |x|, |z| 1220)
var reach = HALF;
function setReach(r){ reach = Math.max(HALF, +r || HALF); return reach; }
function centreLim(span){ return Math.max(0, reach - span/2); }
function altOf(span){ return span/(2*MAP_TAN); }

function create(o){
  o = o || {};
  var mode = MODES[o.mode] ? o.mode : "map", span = spanClamp(o.span);
  var s = {mode: mode, prev: mode, preferred: ORDER.indexOf(o.preferred) >= 0 ? o.preferred : "chase",
           settings: normSettings(o.settings), seed: num(o.seed, 1) | 0, wake: false,
           lookYaw: 0, lookPitch: 0, fpView: "seat", mapCentre: {x: 0, z: 0}, mapSpan: span};
  s._ = {t: 0, blend: null, path: null, last: null, tgt: null, viewH: 800,
         swing: 0, lift: 0, fly: {x: 0, y: 0, z: 0}, fast: false,
         map: {cx: 0, cz: 0, span: span, vx: 0, vz: 0, vs: 0, fly: null}};
  resetMode(s);
  return s;
}
// per-mode state, cleared on every mode change
function resetMode(s){
  var _ = s._;
  _.head = null; _.headV = 0; _.piv = null; _.ahead = null; _.gnd = null; _.swingV = 0;
  _.orbitYaw = 0; _.orbitPitch = 0; _.oyV = 0; _.opV = 0; _.idle = 0; _.upOff = 0; _.backScale = 1;
  _.colFrac = null; _.colV = 0; _.colG = null; _.fov = null; _.fovV = 0;
  _.fp = null; _.fpOff = 0; _.bobPhase = 0; _.bobAmp = 0; _.bobV = 0;
  _.photo = null; _.cineT = 0; _.cinePivot = null; s.wake = false;
}
function setSettings(s, o){ s.settings = normSettings(o, s.settings); }
// a teleport: the chase family starts over behind the target's new heading (no swing round from the old one)
function snap(s){ if(s && s._){ resetMode(s); s._.blend = null; } }

/* ---------- mode changes ---------- */
function clonePose(p){
  var c = {}; for(var k in p) c[k] = p[k] && typeof p[k] === "object" ? v3(p[k].x, p[k].y, p[k].z) : p[k];
  return c;
}
function enter(s, mode){
  var _ = s._, from = s.mode, last = _.last;
  s.prev = from; s.mode = mode; resetMode(s);
  if(mode !== "fp") s.fpView = "seat";
  if(mode === "fp"){
    s.lookPitch = 0;
    if(!(_.tgt && _.tgt.vehicle)) s.lookYaw = _.tgt ? _.tgt.yaw : s.lookYaw;
  }
  if(mode === "photo"){
    var p = last ? last.pos : v3(0, 2, 0);
    _.photo = {gx: p.x, gy: p.y, gz: p.z, x: p.x, y: p.y, z: p.z, vx: 0, vy: 0, vz: 0,
               yaw: s.lookYaw, pitch: clamp(s.lookPitch, -1.45, 1.45)};
  }
  if(mode === "map" && _.tgt) mapCentreOn(s, _.tgt.x, _.tgt.z);
}
function mapCentreOn(s, x, z){
  var m = s._.map, lim = centreLim(s.mapSpan);
  s.mapCentre = {x: clamp(x, -lim, lim), z: clamp(z, -lim, lim)};
  m.cx = s.mapCentre.x; m.cz = s.mapCentre.z; m.span = s.mapSpan; m.vx = m.vz = m.vs = 0; m.fly = null;
}
function setMode(s, mode, o){
  o = o || {};
  if(!MODES[mode]) return;
  if(o.via === "user" && ORDER.indexOf(mode) >= 0) s.preferred = mode;
  var _ = s._, cur = s.mode;
  if(mode === cur) return;
  if(!o.instant && _.last){
    if(cur === "map" && mode !== "map" && mode !== "classic"){ dive(s, null, mode); return; }
    if(mode === "map" && cur !== "map" && cur !== "classic"){ rise(s); return; }
  }
  _.path = null;
  var snap = _.last && !o.instant && cur !== "classic" && mode !== "classic" && cur !== mode;
  var red = s.settings.reduced;
  _.blend = snap ? {from: clonePose(_.last), fromMode: cur, fromTgt: _.tgt ? v3(_.tgt.x, _.tgt.y, _.tgt.z) : null,
                    t: o.t0 || 0, T: red ? BLEND_RED : BLEND, linear: red} : null;
  if(cur !== mode) enter(s, mode);
}
function cycle(s, dir){
  dir = dir < 0 ? -1 : 1;
  var car = s._.tgt && s._.tgt.vehicle === "car";
  if(s.mode === "fp" && car){
    if(dir > 0 && s.fpView === "seat"){ s.fpView = "bonnet"; return s.mode; }
    if(dir < 0 && s.fpView === "bonnet"){ s.fpView = "seat"; return s.mode; }
  }
  var i = ORDER.indexOf(s.mode), n = ORDER.length;
  var next = i < 0 ? s.preferred : ORDER[(i + dir + n) % n];
  setMode(s, next, {via: "user"});
  // reverse cycling enters a car's fp at the bonnet, so Shift+V runs bonnet -> seat -> previous mode
  if(dir < 0 && next === "fp" && car) s.fpView = "bonnet";
  return next;
}

/* ---------- dive and rise: a camera path over (pivot, angle from straight down, heading, frame, fov) ---------- */
// d = camera -> look = (sin a sin psi, -cos a, sin a cos psi); up = (cos a sin psi, sin a, cos a cos psi)
function paramsOf(p){
  var d = v3(p.look.x - p.pos.x, p.look.y - p.pos.y, p.look.z - p.pos.z), dist = vlen(d) || 1e-6;
  d = v3(d.x/dist, d.y/dist, d.z/dist);
  var a = Math.acos(clamp(-d.y, -1, 1));
  var psi = Math.sin(a) < 1e-4 ? Math.atan2(p.up.x, p.up.z) : Math.atan2(d.x, d.z);
  return {pivot: v3(p.look.x, p.look.y, p.look.z), a: a, psi: psi, fov: p.fov, frameH: 2*dist*Math.tan(p.fov*DEG/2),
          near: num(p.near, dist*0.5), focus: p.focus ? v3(p.focus.x, p.focus.y, p.focus.z) : null};
}
function pathPose(P0, P1, e, ey){
  var pv = v3(lerp(P0.pivot.x, P1.pivot.x, e), lerp(P0.pivot.y, P1.pivot.y, ey), lerp(P0.pivot.z, P1.pivot.z, e));
  var a = lerp(P0.a, P1.a, e), psi = P0.psi + wrap(P1.psi - P0.psi)*e, fov = lerp(P0.fov, P1.fov, e);
  var frameH = Math.exp(lerp(Math.log(P0.frameH), Math.log(P1.frameH), e)), dist = frameH/(2*Math.tan(fov*DEG/2));
  var sa = Math.sin(a), ca = Math.cos(a), sp = Math.sin(psi), cp = Math.cos(psi);
  return {pos: v3(pv.x - sa*sp*dist, pv.y + ca*dist, pv.z - sa*cp*dist), look: pv, up: v3(ca*sp, sa, ca*cp), fov: fov, dist: dist};
}
function mapPoseNow(s){
  var m = s._.map, alt = altOf(m.span), base = m.base || 0;
  return {pos: v3(m.cx, base + alt, m.cz), look: v3(m.cx, base, m.cz), up: v3(0, 0, -1), fov: MODES.map.fov, near: alt*0.5};
}
// map -> 3D. The live target given to step is the destination (the host passes the avatar);
// `target` only seeds it before the first step. Settles into `settle` (default s.preferred).
function dive(s, target, settle){
  var _ = s._, red = s.settings.reduced;
  if(target && !_.tgt) _.tgt = normTgt(target);
  var from = s.mode === "map" || !_.last ? mapPoseNow(s) : _.last;
  _.blend = null;
  enter(s, "near");
  _.path = {kind: "dive", t: 0, T: red ? DIVE_RED : DIVE, from: paramsOf(from),
            settle: MODES[settle] && settle !== "map" ? settle : s.preferred};
}
// 3D -> map, ending centred on the target at the current span
function rise(s){
  var _ = s._, red = s.settings.reduced, from = _.last;
  _.blend = null;
  enter(s, "map");
  if(!_.tgt) mapCentreOn(s, s.mapCentre.x, s.mapCentre.z);
  _.path = from ? {kind: "rise", t: 0, T: red ? DIVE_RED : DIVE, from: paramsOf(from)} : null;
}
function flyMap(s, x, z, span){
  var m = s._.map, sp = spanClamp(span == null ? s.mapSpan*0.5 : span), lim = centreLim(sp);
  m.fly = {t: 0, from: {x: m.cx, z: m.cz, span: m.span}, to: {x: clamp(num(x, 0), -lim, lim), z: clamp(num(z, 0), -lim, lim), span: sp}};
}

/* ---------- input ---------- */
function chaseFamily(mode){ return !!(MODES[mode] && MODES[mode].chase); }
function look(s, dx, dy){
  var k = s.settings.sens*LOOK_K, inv = s.settings.invertY ? -1 : 1, _ = s._;
  if(s.mode === "photo" && _.photo){
    _.photo.yaw = wrap(_.photo.yaw - dx*k); _.photo.pitch = clamp(_.photo.pitch - dy*k*inv, -1.45, 1.45);
    s.lookYaw = _.photo.yaw; s.lookPitch = _.photo.pitch;
  } else if(s.mode === "fp"){
    if(_.tgt && _.tgt.vehicle) _.fpOff = wrap(_.fpOff - dx*k); else s.lookYaw = wrap(s.lookYaw - dx*k);
    s.lookPitch = clamp(s.lookPitch - dy*k*inv, -1.45, 1.45);
  }
}
function input(s, ev){
  ev = ev || {};
  var _ = s._, m = _.map, set = s.settings;
  if(ev.anyInput && s.mode === "cine") s.wake = true;
  if(ev.swing != null){ _.swing = clamp(num(ev.swing, 0), -1, 1); if(_.swing) _.idle = 0; }
  if(ev.lift != null) _.lift = clamp(num(ev.lift, 0), -1, 1);
  if(ev.fly) _.fly = {x: clamp(num(ev.fly.x, 0), -1, 1), y: clamp(num(ev.fly.y, 0), -1, 1), z: clamp(num(ev.fly.z, 0), -1, 1)};
  if(ev.fast != null) _.fast = !!ev.fast;
  if(ev.orbit){
    if(chaseFamily(s.mode)){
      _.orbitYaw = wrap(_.orbitYaw - num(ev.orbit[0], 0)*set.sens*ORBIT_K);
      _.orbitPitch += num(ev.orbit[1], 0)*set.sens*ORBIT_K*(set.invertY ? -1 : 1);
      _.idle = 0;
    } else look(s, num(ev.orbit[0], 0), num(ev.orbit[1], 0));
  }
  if(ev.look) look(s, num(ev.look[0], 0), num(ev.look[1], 0));
  if(ev.zoom){
    var f = Math.exp(num(ev.zoom, 0)*ZOOM_K);
    if(s.mode === "map"){
      m.fly = null; s.mapSpan = clamp(s.mapSpan*f, SPAN_MIN, SPAN_MAX);
      var lim = centreLim(s.mapSpan);
      s.mapCentre = {x: clamp(s.mapCentre.x, -lim, lim), z: clamp(s.mapCentre.z, -lim, lim)};
    } else if(chaseFamily(s.mode)) _.backScale = clamp(_.backScale*f, 0.5, 2.5);
  }
  if(ev.pan && s.mode === "map"){
    m.fly = null;
    var mpp = s.mapSpan/(_.viewH || 800), L = centreLim(s.mapSpan);
    s.mapCentre = {x: clamp(s.mapCentre.x + num(ev.pan[0], 0)*mpp, -L, L), z: clamp(s.mapCentre.z + num(ev.pan[1], 0)*mpp, -L, L)};
  }
}

/* ---------- the solvers, one per mode family ---------- */
function normTgt(t){
  t = t || {};
  return {x: num(t.x, 0), y: num(t.y, 0), z: num(t.z, 0), yaw: num(t.yaw, 0), pitch: num(t.pitch, 0), roll: num(t.roll, 0),
          speed: Math.abs(num(t.speed, 0)), vehicle: VEHICLE[t.vehicle] ? t.vehicle : null, lean: num(t.lean, 0), moving: !!t.moving,
          // where you are headed (null when still); a host without it: the facing while moving
          travelYaw: t.travelYaw === undefined ? (t.moving ? num(t.yaw, 0) : null) : (t.travelYaw == null ? null : num(t.travelYaw, null)),
          turnRate: num(t.turnRate, 0)};
}
function basePose(mode){
  var M = MODES[mode];
  return {mode: mode, pos: null, look: null, focus: null, up: v3(0, 1, 0), fov: M.fov || 65, near: M.near || 0.3, far: FAR, roll: 0,
          ortho: false, blend: 1, hideAvatar: false, hud: mode !== "photo" && mode !== "cine", headBob: 0, vignette: 0};
}
function fovSpring(s, goal, dt){
  var _ = s._;
  if(_.fov == null){ _.fov = goal; _.fovV = 0; return goal; }
  var r = spring(_.fov, _.fovV, goal, 12, dt); _.fov = r[0]; _.fovV = r[1];
  return _.fov;
}
function fovOff(s){ return s.settings.fov - 65; }

// Collision: t = q.hit(from, want); pull in at once to t*len - radius (min 0.6 m from `from`),
// ease back out (omega 3); never below ground + 0.3. Cine's (the chase family eases in too: chaseCollide).
function pullIn(s, from, want, radius, dt, q){
  var _ = s._, vec = v3(want.x - from.x, want.y - from.y, want.z - from.z), len = vlen(vec) || 1e-6;
  var t = clamp(num(q.hit(from, want), 1), 0, 1), frac = 1;
  if(t < 1) frac = Math.min(1, Math.max(0.6, t*len - radius)/len);
  if(_.colFrac == null || frac <= _.colFrac){ _.colFrac = frac; _.colV = 0; }
  else { var cs = spring(_.colFrac, _.colV, frac, 3, dt); _.colFrac = Math.min(1, cs[0]); _.colV = cs[1]; }
  var pos = v3(from.x + vec.x*_.colFrac, from.y + vec.y*_.colFrac, from.z + vec.z*_.colFrac);
  pos.y = Math.max(pos.y, q.ground(pos.x, pos.z) + 0.3);
  return pos;
}
// Chase collision along pivot -> wanted camera, as a fraction of that ray: pull in on a spring (COL_IN), ease
// back out (COL_OUT); while blocked the goal only moves out once the room has grown COL_HYST m.
function chaseCollide(s, from, want, radius, dt, q){
  var _ = s._, vec = v3(want.x - from.x, want.y - from.y, want.z - from.z), len = vlen(vec) || 1e-6;
  var t = clamp(num(q.hit(from, want), 1), 0, 1), goal = 1;
  if(t < 1){
    var d = Math.min(len, Math.max(0.6, t*len - radius));
    if(_.colG == null || d < _.colG || d > _.colG + COL_HYST) _.colG = d;
    goal = Math.min(1, _.colG/len);
  } else _.colG = null;
  if(_.colFrac == null){ _.colFrac = goal; _.colV = 0; }
  else {
    var cs = spring(_.colFrac, _.colV, goal, goal < _.colFrac ? COL_IN : COL_OUT, dt);
    _.colFrac = cs[0]; _.colV = cs[1];
    if(_.colFrac > 1){ _.colFrac = 1; _.colV = Math.min(0, _.colV); }
  }
  var pos = v3(from.x + vec.x*_.colFrac, from.y + vec.y*_.colFrac, from.z + vec.z*_.colFrac);
  pos.y = Math.max(pos.y, q.ground(pos.x, pos.z) + 0.3);
  return pos;
}
function chasePose(s, mode, T, dt, q){
  var _ = s._, M = MODES[mode], V = T.vehicle ? VEHICLE[T.vehicle] : null, red = s.settings.reduced, k;
  var back = M.back*(V ? V.backMul : 1)*_.backScale, baseUp = M.up*(V ? V.upMul : 1), side = M.side*(V ? V.sideMul : 1);
  _.upOff = clamp(_.upOff + _.lift*LIFT*dt, 0.6 - baseUp, 2*baseUp);
  var up = baseUp + _.upOff;
  // The orbit offset on top of the heading: Q/R swing eased in and out (exact exponential), right-drag adds
  // to it directly (input()); after RECENTRE s without either it springs back to 0.
  var sg = _.swing*SWING, sk = Math.LN2/SWING_HL, se = Math.exp(-sk*dt);
  _.orbitYaw = wrap(_.orbitYaw + sg*dt + (_.swingV - sg)*(1 - se)/sk);
  _.swingV = sg + (_.swingV - sg)*se;
  if(_.swing) _.idle = 0; else _.idle += dt;
  var e0 = Math.atan2(up, back);
  _.orbitPitch = clamp(_.orbitPitch, -0.2 - e0, 1.2 - e0);
  if(_.idle > RECENTRE){
    var ry = spring(_.orbitYaw, _.oyV, 0, 2, dt), rp = spring(_.orbitPitch, _.opV, 0, 2, dt);
    _.orbitYaw = ry[0]; _.oyV = ry[1]; _.orbitPitch = rp[0]; _.opV = rp[1];
  } else { _.oyV = 0; _.opV = 0; }
  // The heading: where you are headed. On foot it follows travelYaw (S: facing + PI, so the camera swings
  // round to show where you are going) on a critically damped spring that tightens the faster you turn. Of the
  // goal's two sides (+-2 PI) it takes the one nearer where the heading's momentum is carrying it (head +
  // headV/omega, less HEAD_BIAS turnRate up to HEAD_BIAS_MAX, so a near-PI tie goes to the side the turning goal
  // is coming round from), so a goal near the far side never flips sides mid-swing; the goal turns with you at
  // turnRate through the frame (springRamp), so a held turn is followed alike at any frame rate. Standing still the
  // heading holds (its velocity dies away, never cut). A vehicle's heading is its yaw through a rotation lag.
  if(_.head == null){ _.head = T.yaw; _.headV = 0; }
  var goal = V ? T.yaw : T.travelYaw;
  if(goal != null){
    var tr = V ? 0 : T.turnRate, w = V ? (V.headLag || VEH_LAG) : clamp(HEAD_MIN + HEAD_K*Math.abs(tr), HEAD_MIN, HEAD_MAX);
    var ref = _.headV/w - clamp(HEAD_BIAS*tr, -HEAD_BIAS_MAX, HEAD_BIAS_MAX), err = wrap(goal - _.head - ref) + ref;
    // pull: where the spring heads (the goal less its steady turning lag). With the goal on the far side of the
    // turn (coming round to meet the camera, e.g. A after S) both the pull and the goal's turn are kept only by
    // g = 1/(1 + HEAD_AGAINST |turnRate err|), so the camera waits for the body instead of swinging against
    // the key; g is 1 at turnRate 0 and once the goal is ahead in the turn, so it never switches.
    var pull = err - 2*tr/w, g = err*tr < 0 ? 1/(1 + HEAD_AGAINST*Math.abs(tr*err)) : 1;
    var rr = V ? T.turnRate : tr*g, hh = springRamp(0, _.headV, pull*g + 2*rr/w, rr, w, dt);
    _.head = wrap(_.head + hh[0]); _.headV = hh[1];
  } else {
    var he = Math.exp(-HEAD_HOLD*dt);
    _.head = wrap(_.head + _.headV*(1 - he)/HEAD_HOLD); _.headV *= he;
  }
  var camYaw = wrap(_.head + _.orbitYaw);
  // The pivot trails the head (one spring, kept within PIVOT_MAX m); everything below aims at it.
  var H = v3(T.x, T.y + LOOK_H, T.z);
  if(!_.piv) _.piv = {x: H.x, y: H.y, z: H.z, vx: 0, vy: 0, vz: 0};
  var P = _.piv;
  ["x", "y", "z"].forEach(function(a){ var r = spring(P[a], P["v" + a], H[a], PIVOT_W, dt); P[a] = r[0]; P["v" + a] = r[1]; });
  var dx = P.x - H.x, dy = P.y - H.y, dz = P.z - H.z, dl = Math.sqrt(dx*dx + dy*dy + dz*dz);
  if(dl > PIVOT_MAX){ k = PIVOT_MAX/dl; P.x = H.x + dx*k; P.y = H.y + dy*k; P.z = H.z + dz*k; }
  // the look-ahead: a vector along the heading, min(3, 0.3 speed) long, on its own spring
  var al = Math.min(AHEAD_MAX, T.speed*AHEAD_K), hf = rotYaw(0, 1, _.head);
  if(!_.ahead) _.ahead = {x: hf.x*al, z: hf.z*al, vx: 0, vz: 0};
  var A = _.ahead, ax = spring(A.x, A.vx, hf.x*al, AHEAD_W, dt), az = spring(A.z, A.vz, hf.z*al, AHEAD_W, dt);
  A.x = ax[0]; A.vx = ax[1]; A.z = az[0]; A.vz = az[1];
  // the camera: behind the pivot along camYaw; height over max(pivot feet, ground under the camera (sprung))
  var el = e0 + _.orbitPitch, r = Math.sqrt(back*back + up*up), horiz = r*Math.cos(el), h = r*Math.sin(el);
  var off = rotYaw(-side, -horiz, camYaw), px = P.x + off.x, pz = P.z + off.z, g = q.ground(px, pz);
  if(_.gnd == null) _.gnd = {y: g, v: 0};
  var gs = spring(_.gnd.y, _.gnd.v, g, M.lag, dt); _.gnd.y = gs[0]; _.gnd.v = gs[1];
  var want = v3(px, Math.max(P.y - LOOK_H, _.gnd.y) + h, pz);
  var pv = v3(P.x, P.y, P.z), pos = chaseCollide(s, pv, want, M.collide, dt, q);
  var lk = v3(P.x + A.x, P.y, P.z + A.z);
  var kick = red ? 0 : Math.min(10, T.speed*0.5)*(V ? V.fovSpeedKick : 1);
  var p = basePose(mode);
  p.pos = pos; p.look = lk; p.focus = H;
  p.fov = fovSpring(s, M.fov + fovOff(s) + kick, dt);
  p.roll = red || !V ? 0 : V.roll*T.lean*0.5;
  s.lookYaw = Math.atan2(lk.x - pos.x, lk.z - pos.z);
  s.lookPitch = Math.atan2(lk.y - pos.y, Math.sqrt((lk.x - pos.x)*(lk.x - pos.x) + (lk.z - pos.z)*(lk.z - pos.z)));
  s.moveYaw = camYaw;   // the camera heading (classic and older hosts move by it)
  return p;
}

function fpPose(s, T, dt){
  var _ = s._, M = MODES.fp, V = T.vehicle ? VEHICLE[T.vehicle] : null, set = s.settings;
  var pos;
  if(V){
    var A = V.fpAnchor[s.fpView] || V.fpAnchor.seat;
    pos = fpAnchorWorld(T, A);
    s.lookYaw = wrap(T.yaw + _.fpOff);
  } else pos = v3(T.x, T.y + M.up, T.z);
  var goalPitch = clamp(s.lookPitch + (V ? T.pitch : 0), -1.45, 1.45);
  if(!_.fp) _.fp = {yaw: s.lookYaw, yv: 0, pitch: goalPitch, pv: 0};
  var a = spring(_.fp.yaw, _.fp.yv, _.fp.yaw + wrap(s.lookYaw - _.fp.yaw), M.lag, dt), b = spring(_.fp.pitch, _.fp.pv, goalPitch, M.lag, dt);
  _.fp.yaw = wrap(a[0]); _.fp.yv = a[1]; _.fp.pitch = b[0]; _.fp.pv = b[1];
  // head bob: 0.04 m at 1.8 Hz x speed/4, the rate capped at speed 6 (2.7 Hz) so fast vehicles do not buzz
  var bobOn = set.headBob && !set.reduced && T.moving && T.speed > 0.05;
  if(set.reduced || !set.headBob){ _.bobAmp = 0; _.bobV = 0; }
  else { var ba = spring(_.bobAmp, _.bobV, bobOn ? 0.04 : 0, 10, dt); _.bobAmp = ba[0]; _.bobV = ba[1]; }
  if(bobOn) _.bobPhase = (_.bobPhase + 2*PI*1.8*(Math.min(T.speed, 6)/4)*dt) % (2*PI);
  var bob = _.bobAmp*Math.sin(_.bobPhase);
  pos.y += bob;
  var cp = Math.cos(_.fp.pitch);
  var dir = v3(cp*Math.sin(_.fp.yaw), Math.sin(_.fp.pitch), cp*Math.cos(_.fp.yaw));
  var p = basePose("fp");
  p.pos = pos; p.look = v3(pos.x + dir.x*10, pos.y + dir.y*10, pos.z + dir.z*10); p.focus = v3(pos.x, pos.y, pos.z);
  p.fov = fovSpring(s, Math.min(100, M.fov + fovOff(s)), dt);
  p.roll = set.reduced || !V ? 0 : V.roll*T.lean*0.5;
  p.headBob = bob;
  p.vignette = clamp((T.speed - 4)/10, 0, 0.6);
  p.hideAvatar = true;
  return p;
}

function photoPose(s, dt, q){
  var _ = s._, P = _.photo, M = MODES.photo;
  var spd = 8*(_.fast ? 3 : 1), f = rotYaw(0, 1, P.yaw), right = rotYaw(-1, 0, P.yaw), F = _.fly;
  var vy = F.y || _.lift, g0 = v3(P.gx, P.gy, P.gz);
  var g1 = v3(P.gx + (right.x*F.x + f.x*F.z)*spd*dt, P.gy + vy*spd*dt, P.gz + (right.z*F.x + f.z*F.z)*spd*dt);
  var mv = v3(g1.x - g0.x, g1.y - g0.y, g1.z - g0.z), ml = vlen(mv);
  if(ml > 1e-9){
    // probe the move plus the radius; stop the radius short of a hit (never move backwards)
    var L = ml + M.collide, pr = v3(g0.x + mv.x*L/ml, g0.y + mv.y*L/ml, g0.z + mv.z*L/ml);
    var t = clamp(num(q.hit(g0, pr), 1), 0, 1);
    if(t < 1){ var k = clamp((t*L - M.collide)/ml, 0, 1); g1 = v3(g0.x + mv.x*k, g0.y + mv.y*k, g0.z + mv.z*k); }
  }
  P.gx = g1.x; P.gy = g1.y; P.gz = g1.z;
  P.gy = Math.max(P.gy, q.ground(P.gx, P.gz) + 0.3);
  var a = spring(P.x, P.vx, P.gx, M.lag, dt), b = spring(P.y, P.vy, P.gy, M.lag, dt), c = spring(P.z, P.vz, P.gz, M.lag, dt);
  P.x = a[0]; P.vx = a[1]; P.y = b[0]; P.vy = b[1]; P.z = c[0]; P.vz = c[1];
  P.y = Math.max(P.y, q.ground(P.x, P.z) + 0.3);
  var cp = Math.cos(P.pitch), pos = v3(P.x, P.y, P.z);
  var p = basePose("photo");
  p.pos = pos; p.look = v3(pos.x + cp*Math.sin(P.yaw)*10, pos.y + Math.sin(P.pitch)*10, pos.z + cp*Math.cos(P.yaw)*10);
  p.focus = v3(pos.x, pos.y, pos.z);
  s.lookYaw = P.yaw; s.lookPitch = P.pitch;
  return p;
}

// Deterministic from (time in cine, seed): 12 s slow orbit, then 12 s fly-by along the facing line, repeat.
function cinePose(s, T, dt, q){
  var _ = s._, M = MODES.cine;
  _.cineT += dt;
  if(!_.cinePivot) _.cinePivot = {x: T.x, y: T.y, z: T.z, vx: 0, vy: 0, vz: 0};
  var C = _.cinePivot, a = spring(C.x, C.vx, T.x, M.lag, dt), b = spring(C.y, C.vy, T.y, M.lag, dt), c = spring(C.z, C.vz, T.z, M.lag, dt);
  C.x = a[0]; C.vx = a[1]; C.y = b[0]; C.vy = b[1]; C.z = c[0]; C.vz = c[1];
  var k = Math.floor(_.cineT/(2*CINE_SHOT)), tau = _.cineT - k*2*CINE_SHOT, pos;
  var lk = v3(C.x, C.y + LOOK_H, C.z);
  if(tau < CINE_SHOT){
    var ang = hash01(s.seed, k)*2*PI + 0.05*tau;
    pos = v3(C.x + Math.sin(ang)*18, C.y + 8, C.z + Math.cos(ang)*18);
  } else {
    var u = tau - CINE_SHOT, sd = hash01(s.seed, k + 7919) < 0.5 ? -1 : 1;
    var f = rotYaw(0, 1, T.yaw), left = rotYaw(1, 0, T.yaw), along = -24 + 4*u;
    pos = v3(C.x + f.x*along + left.x*6*sd, C.y + 3, C.z + f.z*along + left.z*6*sd);
  }
  pos = pullIn(s, lk, pos, M.collide, dt, q);
  var p = basePose("cine");
  p.pos = pos; p.look = lk; p.focus = v3(lk.x, lk.y, lk.z);
  s.lookYaw = Math.atan2(lk.x - pos.x, lk.z - pos.z);
  s.lookPitch = Math.atan2(lk.y - pos.y, Math.sqrt((lk.x - pos.x)*(lk.x - pos.x) + (lk.z - pos.z)*(lk.z - pos.z)));
  return p;
}

function mapStep(s, dt, q){
  var _ = s._, m = _.map;
  if(m.fly){
    m.fly.t += dt;
    var u = m.fly.t/FLY_MAP, e = smootherstep(u), F = m.fly;
    if(u >= 1 - 1e-9){ m.cx = F.to.x; m.cz = F.to.z; m.span = F.to.span; m.fly = null; }
    else {
      m.cx = lerp(F.from.x, F.to.x, e); m.cz = lerp(F.from.z, F.to.z, e);
      m.span = Math.exp(lerp(Math.log(F.from.span), Math.log(F.to.span), e));
    }
    m.vx = m.vz = m.vs = 0;
    s.mapCentre = {x: m.cx, z: m.cz}; s.mapSpan = m.span;
  } else {
    var a = spring(m.cx, m.vx, s.mapCentre.x, MODES.map.lag, dt), b = spring(m.cz, m.vz, s.mapCentre.z, MODES.map.lag, dt);
    var c = spring(m.span, m.vs, s.mapSpan, MODES.map.lag, dt);
    m.cx = a[0]; m.vx = a[1]; m.cz = b[0]; m.vz = b[1]; m.span = clamp(c[0], SPAN_MIN, SPAN_MAX); m.vs = c[1];
  }
  // the ground under the centre is the base, so span stays the visible ground width over hills
  var gb = q.ground(m.cx, m.cz);
  if(m.base == null){ m.base = gb; m.vb = 0; }
  else { var g = spring(m.base, m.vb || 0, gb, MODES.map.lag, dt); m.base = g[0]; m.vb = g[1]; }
  var mp = mapPoseNow(s), alt = mp.pos.y - m.base, p = basePose("map");
  p.pos = mp.pos; p.look = mp.look; p.up = mp.up; p.fov = mp.fov; p.near = alt*0.5; p.far = alt*2; p.focus = p.pos;
  return p;
}

function modePose(s, mode, T, dt, q){
  if(mode === "map") return mapStep(s, dt, q);
  if(chaseFamily(mode)) return chasePose(s, mode, T, dt, q);
  if(mode === "fp") return fpPose(s, T, dt);
  if(mode === "photo"){
    if(!s._.photo) enterPhotoFallback(s, T);
    return photoPose(s, dt, q);
  }
  if(mode === "cine") return cinePose(s, T, dt, q);
  // classic: the host renders its own ortho camera. The rig reports a chase-mode pose that tracks the
  // target, so a rise (M) or a blend out of classic starts at the avatar, not where classic was entered.
  var C = MODES.chase, b = rotYaw(0, -C.back, T.yaw), p = basePose("classic");
  p.pos = v3(T.x + b.x, T.y + C.up, T.z + b.z); p.look = v3(T.x, T.y + LOOK_H, T.z); p.focus = p.look;
  p.ortho = true;
  return p;
}
function enterPhotoFallback(s, T){
  s._.photo = {gx: T.x, gy: T.y + 2, gz: T.z, x: T.x, y: T.y + 2, z: T.z, vx: 0, vy: 0, vz: 0, yaw: s.lookYaw, pitch: 0};
}

function mixPose(a, b, e){
  var p = clonePose(b);
  p.pos = vlerp(a.pos, b.pos, e); p.look = vlerp(a.look, b.look, e);
  p.focus = vlerp(a.focus || a.pos, b.focus || b.pos, e); p.up = norm(vlerp(a.up, b.up, e));
  if(vlen(vlerp(a.up, b.up, e)) < 1e-3) p.up = b.up;
  ["fov", "near", "far", "roll", "headBob", "vignette"].forEach(function(k){ p[k] = lerp(a[k], b[k], e); });
  return p;
}

/* ---------- the frame ---------- */
function step(s, tgt, dt, q){
  var _ = s._;
  dt = clamp(num(dt, 0), 0, 0.05);
  q = q || {};
  var T = normTgt(tgt);
  var Q = {ground: typeof q.ground === "function" ? function(x, z){ return num(q.ground(x, z), T.y); } : function(){ return T.y; },
           hit: typeof q.hit === "function" ? q.hit : function(){ return 1; }};
  if(q.viewH) _.viewH = q.viewH;
  _.tgt = T; _.t += dt;
  var pose, settle = null;
  if(_.path){
    var P = _.path;
    P.t += dt;
    var u = Math.min(1, P.t/P.T), e = smootherstep(u);
    var to = modePose(s, s.mode, T, dt, Q);
    if(P.t >= P.T - 1e-9){
      pose = to; _.path = null;
      if(P.kind === "dive" && P.settle !== s.mode) settle = {mode: P.settle, t0: P.t - P.T};
    } else {
      var ey = smootherstep(P.kind === "dive" ? 2*u : 2*u - 1);
      var pp = pathPose(P.from, paramsOf(to), e, ey);
      pose = clonePose(to);
      pose.pos = pp.pos; pose.look = pp.look; pose.up = pp.up; pose.fov = pp.fov; pose.blend = u;
      // near plane: geometric from the source pose's near to the destination's, never past half the distance
      pose.near = Math.min(pp.dist*0.5, Math.exp(lerp(Math.log(P.from.near), Math.log(to.near), e)));
      pose.far = Math.max(FAR, pp.dist*2);
      // see-through focus: the target's head on the way down; on the way up it closes onto the camera
      pose.focus = P.kind === "dive" ? (to.focus || pose.pos) : vlerp(P.from.focus || pose.pos, pose.pos, e);
      pose.roll = to.roll*e; pose.headBob = 0; pose.vignette = 0; pose.hideAvatar = false;
      if(P.kind === "rise") pose.far = Math.max(pose.far, to.far);
    }
  } else pose = modePose(s, s.mode, T, dt, Q);
  if(_.blend){
    var B = _.blend;
    B.t += dt;
    var bu = B.t/B.T;
    if(bu >= 1 - 1e-9) _.blend = null;
    else {
      var from = B.from;
      if(B.fromTgt){
        var dx = T.x - B.fromTgt.x, dy = T.y - B.fromTgt.y, dz = T.z - B.fromTgt.z, fc = from.focus || from.pos;
        from = Object.assign(clonePose(from), {pos: v3(from.pos.x + dx, from.pos.y + dy, from.pos.z + dz),
          look: v3(from.look.x + dx, from.look.y + dy, from.look.z + dz), focus: v3(fc.x + dx, fc.y + dy, fc.z + dz)});
      }
      pose = mixPose(from, pose, smoothFactor(bu, B.linear));
      pose.blend = bu;
      pose.hideAvatar = (s.mode === "fp" && bu > 0.6) || (B.fromMode === "fp" && bu < 0.4);
    }
  }
  _.last = pose;
  if(settle) setMode(s, settle.mode, {t0: settle.t0});
  return pose;
}

/* ---------- see-through: boxes between the camera and the target ---------- */
function occluders(pos, lookAt, items){
  var d = v3(lookAt.x - pos.x, lookAt.y - pos.y, lookAt.z - pos.z), len = vlen(d), out = [];
  if(!(len > 0.5)) return out;
  var segLen = len - 0.5, inv = [d.x/len, d.y/len, d.z/len], o = [pos.x, pos.y, pos.z], ax = ["x", "y", "z"];
  (items || []).forEach(function(it){
    var t0 = 0, t1 = segLen;
    for(var i = 0; i < 3; i++){
      var mn = it.min[ax[i]], mx = it.max[ax[i]];
      if(Math.abs(inv[i]) < 1e-12){ if(o[i] < mn || o[i] > mx){ t0 = 1; t1 = 0; break; } continue; }
      var a = (mn - o[i])/inv[i], b = (mx - o[i])/inv[i];
      if(a > b){ var tmp = a; a = b; b = tmp; }
      t0 = Math.max(t0, a); t1 = Math.min(t1, b);
      if(t0 > t1) break;
    }
    if(t0 <= t1) out.push(it.id);
  });
  return out;
}

HQV.camrig = {snap: snap, setReach: setReach, MODES: MODES, ORDER: ORDER, VEHICLE: VEHICLE, create: create, setSettings: setSettings, setMode: setMode,
  cycle: cycle, dive: dive, rise: rise, flyMap: flyMap, input: input, step: step, occluders: occluders,
  fpAnchorWorld: fpAnchorWorld, spring: spring, smootherstep: smootherstep,
  consts: {SPAN_MIN: SPAN_MIN, SPAN_MAX: SPAN_MAX, HALF: HALF, LOOK_H: LOOK_H, MAP_TAN: MAP_TAN}};
})();
