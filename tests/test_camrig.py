"""3D city camera rig (games/camrig.js, spec 2.5): every mode, transition and input rule.

camrig.js is pure, so node loads it against a stub `window` and runs the scenarios below
(one node process for the whole file); the Python side checks the numbers against the spec
table. Skipped when node is not installed. Stdlib only."""
import json
import math
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

HARNESS = r"""
var fs = require("fs"), root = %(root)s;
global.window = {HQV: {}};
new Function(fs.readFileSync(root + "/games/camrig.js", "utf8"))();
var C = window.HQV.camrig, out = {};
var FLAT = {ground: function(){ return 0; }, hit: function(){ return 1; }, viewH: 800, aspect: 1.6};
function T(o){ var t = {x: 5, y: 0, z: -7, yaw: 0.7, pitch: 0, roll: 0, speed: 0, vehicle: null, lean: 0, moving: false};
  for(var k in o || {}) t[k] = o[k]; return t; }
function run(s, tgt, secs, q, dt){ dt = dt || 1/60; var p, n = Math.round(secs/dt); for(var i = 0; i < n; i++) p = C.step(s, tgt, dt, q || FLAT); return p; }
function settled(mode, tgt, settings, q){ var s = C.create({mode: mode, settings: settings}); return run(s, tgt, 4, q); }
function off(p, t){ return [p.pos.x - t.x, p.pos.y - t.y, p.pos.z - t.z]; }

// spring: frame-rate independence
var a = [0, 0], b = [0, 0], i;
for(i = 0; i < 60; i++) a = C.spring(a[0], a[1], 1, 6, 1/60);
for(i = 0; i < 30; i++) b = C.spring(b[0], b[1], 1, 6, 1/30);
out.spring = {a: a, b: b, smoother: [C.smootherstep(0), C.smootherstep(0.5), C.smootherstep(1)]};
out.modes = C.MODES; out.vehicle = C.VEHICLE; out.order = C.ORDER;

// settled pose per mode at fov 65 and 80
out.settled = {};
["far", "chase", "near", "fp", "map", "photo", "cine"].forEach(function(m){
  var t = T(), p65 = settled(m, t, {fov: 65}), p80 = settled(m, t, {fov: 80});
  out.settled[m] = {off: off(p65, t), fov65: p65.fov, fov80: p80.fov, near: p65.near, far: p65.far, up: p65.up,
                    hud: p65.hud, hide: p65.hideAvatar, look: p65.look, pos: p65.pos};
});
// per-vehicle chase poses and roll, speed kick
out.veh = {};
["car", "moto", "bike", "skate"].forEach(function(v){
  var t = T({vehicle: v}), r = {};
  ["far", "chase", "near"].forEach(function(m){ r[m] = off(settled(m, t), t); });
  r.roll = settled("chase", T({vehicle: v, lean: 0.4})).roll;
  r.rollReduced = settled("chase", T({vehicle: v, lean: 0.4}), {reduced: true}).roll;
  r.kick = settled("chase", T({vehicle: v, speed: 10, moving: true})).fov;
  out.veh[v] = r;
});
out.footRoll = settled("chase", T({lean: 0.4})).roll;
out.footKick = settled("chase", T({speed: 10, moving: true})).fov;
out.footKickBig = settled("chase", T({speed: 40, moving: true})).fov;
out.kickReduced = settled("chase", T({speed: 10, moving: true}), {reduced: true}).fov;

// fpAnchorWorld
out.anchor = C.fpAnchorWorld({x: 1, y: 2, z: 3, yaw: 0.9, pitch: 0.3, roll: -0.25}, [0.4, 1.1, 0.7]);
out.seat = [0, 1.2, 2.5, -2].map(function(yaw){ return {yaw: yaw, p: C.fpAnchorWorld({x: 0, y: 0, z: 0, yaw: yaw}, C.VEHICLE.car.fpAnchor.seat)}; });
out.fpCar = {seat: settled("fp", T({vehicle: "car"})).pos};
(function(){ var s = C.create({mode: "fp"}); var t = T({vehicle: "car"}); run(s, t, 0.1); C.cycle(s, 1); out.fpCar.bonnet = run(s, t, 1).pos; })();

// cycling
(function(){
  var s = C.create({mode: "far"}), t = T(), seq = [];
  run(s, t, 0.1);
  for(var k = 0; k < 6; k++){ C.cycle(s, 1); run(s, t, 0.1); seq.push([s.mode, s.preferred]); }
  var back = []; for(k = 0; k < 5; k++){ C.cycle(s, -1); back.push(s.mode); }
  out.cycle = {fwd: seq, back: back};
  var car = C.create({mode: "fp"}), tc = T({vehicle: "car"}), cs = [];
  run(car, tc, 0.1);
  for(k = 0; k < 3; k++){ C.cycle(car, 1); cs.push([car.mode, car.fpView]); run(car, tc, 0.6); }
  out.cycleCar = cs;
  var moto = C.create({mode: "fp"}), tm = T({vehicle: "moto"});
  run(moto, tm, 0.1); C.cycle(moto, 1); out.cycleMoto = [moto.mode, moto.fpView];
  var foot = C.create({mode: "fp"}); run(foot, T(), 0.1); C.cycle(foot, 1); out.cycleFoot = foot.mode;
  var pin = C.create({mode: "chase", preferred: "far"}); C.setMode(pin, "near"); out.setModeNoVia = pin.preferred;
  C.setMode(pin, "near", {via: "user"}); out.setModeUser = pin.preferred;
})();

// dive and rise
function diveRun(pref, reduced){
  var s = C.create({mode: "map", preferred: pref, span: 2048, settings: {reduced: !!reduced}}), t = T({x: 120, z: -300, yaw: 2.2});
  run(s, t, 0.2);
  C.dive(s, t);
  var r = {alts: [], fovs: [], modes: [], blends: [], ups: []}, dt = 1/60;
  for(var k = 0; k < 150; k++){
    var p = C.step(s, t, dt, FLAT);
    r.alts.push(p.pos.y); r.fovs.push(p.fov); r.modes.push(p.mode); r.blends.push(p.blend); r.ups.push(p.up);
    if(k === Math.round((reduced ? 0.6 : 1.2)/dt) - 1) r.atDive = p;
    if(k === Math.round((reduced ? 0.9 : 1.7)/dt) - 1) r.atSettle = p;
  }
  r.refNear = settled("near", t); r.refPref = settled(pref, t); r.preferred = s.preferred; r.mode = s.mode;
  return r;
}
out.dive = {chase: diveRun("chase"), near: diveRun("near"), far: diveRun("far"), reduced: diveRun("chase", true)};
(function(){
  var s = C.create({mode: "chase", span: 400}), t = T({x: 120, z: -300, yaw: 2.2});
  run(s, t, 1);
  C.rise(s);
  var alts = [], fovs = [], p;
  for(var k = 0; k < 72; k++){ p = C.step(s, t, 1/60, FLAT); alts.push(p.pos.y); fovs.push(p.fov); }
  out.rise = {alts: alts, fovs: fovs, end: p, mode: s.mode, centre: s.mapCentre, span: s.mapSpan};
})();

// map: zoom, pan, flyMap
(function(){
  var s = C.create({mode: "map", span: 400}), t = T(), r = {};
  run(s, t, 0.1);
  C.input(s, {zoom: -100000}); r.minSpan = s.mapSpan; r.minAlt = run(s, t, 5).pos.y;
  C.input(s, {zoom: 100000}); r.maxSpan = s.mapSpan; r.maxAlt = run(s, t, 5).pos.y; r.maxCentre = s.mapCentre;
  C.input(s, {pan: [300, 300]}); r.panAtMax = s.mapCentre;
  C.input(s, {zoom: 1}); r.zoomOne = s.mapSpan;
  var m = C.create({mode: "map", span: 400}); run(m, t, 0.1);
  C.input(m, {pan: [100, -50]}); r.pan = m.mapCentre;
  C.input(m, {pan: [100000, -100000]}); r.panClamp = m.mapCentre;
  var f = C.create({mode: "map", span: 400}); run(f, t, 0.1);
  C.flyMap(f, 300, -200);
  var spans = [], p;
  for(var k = 0; k < 47; k++){ p = C.step(f, t, 1/60, FLAT); spans.push(f.mapSpan); }
  r.flyMid = {centre: f.mapCentre, span: f.mapSpan};
  p = C.step(f, t, 1/60, FLAT); p = C.step(f, t, 1/60, FLAT);
  r.fly = {centre: f.mapCentre, span: f.mapSpan, pos: p.pos};
  C.flyMap(f, 0, 0, 5);
  for(k = 0; k < 60; k++){ C.step(f, t, 1/60, FLAT); spans.push(f.mapSpan); }
  r.flySpans = spans; r.flyMinEnd = f.mapSpan;
  out.map = r;
})();

// collision and ground
(function(){
  var t = T(), wall = {ground: FLAT.ground, hit: function(){ return 0.5; }};
  var s = C.create({mode: "chase"}), free = run(s, t, 2);
  var hitFirst = run(s, t, 1/60, wall), hitP = run(s, t, 0.5, wall);
  var after = run(s, t, 0.1);
  // back out by 3 s of easing, after the COL_HOLD (0.6 s) the camera keeps the pulled-in distance (HQ 3.3.1)
  var s2 = C.create({mode: "chase"}); run(s2, t, 2); run(s2, t, 0.5, wall); var later = run(s2, t, 3 + C.COL_HOLD);
  function d(p){ var dx = p.pos.x - p.look.x, dy = p.pos.y - p.look.y, dz = p.pos.z - p.look.z; return Math.sqrt(dx*dx + dy*dy + dz*dz); }
  out.collide = {free: d(free), hitFirst: d(hitFirst), hit: d(hitP), easing: d(after), later: d(later), radius: C.MODES.chase.collide};
  // riding past buildings: the ray clips a corner every 0.3 s (hit 0.15 s, clear 0.15 s); after the first pull-in the
  // camera must not pump back out between corners (HQ 3.3.1: COL_HOLD)
  var s3 = C.create({mode: "chase"}); run(s3, t, 2); run(s3, t, 0.15, wall);
  var lo = 1e9, hi = -1e9; for(var k = 0; k < 8; k++){ var a1 = d(run(s3, t, 0.15)), a2 = d(run(s3, t, 0.15, wall));
    lo = Math.min(lo, a1, a2); hi = Math.max(hi, a1, a2); }
  out.collide.pump = hi - lo;
  var slope = {ground: function(x, z){ return 0.6*x + 0.3*z; }, hit: function(){ return 1; }}, worst = 1e9;
  ["far", "chase", "near"].forEach(function(m){
    [0, 1.5, 3, 4.5].forEach(function(yaw){
      var tt = T({x: 10, z: 10, yaw: yaw}); tt.y = slope.ground(tt.x, tt.z);
      var sr = C.create({mode: m});
      for(var k = 0; k < 120; k++){ var p = C.step(sr, tt, 1/60, slope); worst = Math.min(worst, p.pos.y - slope.ground(p.pos.x, p.pos.z)); }
    });
  });
  out.slopeClear = worst;
})();

// recentre, swing, lift, wheel
out.recentre = {};
["far", "chase", "near"].forEach(function(m){
  var t = T(), ref = settled(m, t), s = C.create({mode: m});
  run(s, t, 1);
  C.input(s, {orbit: [-200, 0]});
  var p15 = run(s, t, 1.5), p6 = run(s, t, 5);
  function gap(p){ return Math.hypot(p.pos.x - ref.pos.x, p.pos.z - ref.pos.z); }
  out.recentre[m] = {held: gap(p15), back: gap(p6)};
});
(function(){
  var t = T({yaw: 0}), s = C.create({mode: "chase"}), r = {};
  run(s, t, 1);
  C.input(s, {swing: 1}); run(s, t, 1); C.input(s, {swing: 0});
  var p = run(s, t, 1.5); r.swingYaw = Math.atan2(t.x - p.pos.x, t.z - p.pos.z);
  C.input(s, {swing: -1}); run(s, t, 10); r.swingLong = s.lookYaw; C.input(s, {swing: 0});
  var l = C.create({mode: "chase"}); run(l, t, 1);
  C.input(l, {lift: 1}); r.liftUp = run(l, t, 10).pos.y;
  C.input(l, {lift: -1}); r.liftDown = run(l, t, 10).pos.y;
  C.input(l, {lift: 0});
  var w = C.create({mode: "chase"}); run(w, t, 1);
  function hz(p){ return Math.hypot(p.pos.x - t.x, p.pos.z - t.z); }
  C.input(w, {zoom: 100000}); r.wheelOut = hz(run(w, t, 6));
  C.input(w, {zoom: -100000}); r.wheelIn = hz(run(w, t, 6));
  out.bounds = r;
})();

// settings mid-session, reduced motion
(function(){
  var t = T(), s = C.create({mode: "chase"}), r = {};
  run(s, t, 2);
  C.setSettings(s, {fov: 80}); r.fovAfter = run(s, t, 0.5).fov;
  var tm = T({vehicle: "moto", speed: 10, moving: true, lean: 0.5}), k = C.create({mode: "chase"});
  r.kickOn = run(k, tm, 3); C.setSettings(k, {reduced: true}); r.kickOff = run(k, tm, 0.5);
  var b = C.create({mode: "chase"}); run(b, t, 1); C.setMode(b, "far");
  r.blendNormal = [run(b, t, 0.4).blend, run(b, t, 0.1).blend];
  var c = C.create({mode: "chase", settings: {reduced: true}}); run(c, t, 1); C.setMode(c, "far");
  r.blendReduced = [run(c, t, 0.25).blend, run(c, t, 0.05).blend];
  var w = T({speed: 4, moving: true}), bob = C.create({mode: "fp"}), maxBob = 0, p;
  for(var i = 0; i < 180; i++){ p = C.step(bob, w, 1/60, FLAT); maxBob = Math.max(maxBob, Math.abs(p.headBob)); }
  r.bob = maxBob;
  var nb = C.create({mode: "fp", settings: {reduced: true}}), maxNb = 0;
  for(i = 0; i < 180; i++){ p = C.step(nb, w, 1/60, FLAT); maxNb = Math.max(maxNb, Math.abs(p.headBob)); }
  r.bobReduced = maxNb;
  C.setSettings(bob, {reduced: true}); r.bobAfterReduced = run(bob, w, 0.1).headBob;
  out.settings = r;
})();

// vignette
out.vignette = {
  fpStop: settled("fp", T()).vignette, fp8: settled("fp", T({speed: 8, moving: true})).vignette,
  fp30: settled("fp", T({speed: 30, moving: true})).vignette,
  chase30: settled("chase", T({speed: 30, moving: true})).vignette, far30: settled("far", T({speed: 30, moving: true})).vignette,
  map: settled("map", T({speed: 30})).vignette, photo: settled("photo", T({speed: 30})).vignette
};

// occluders
out.occ = C.occluders({x: 0, y: 3, z: -10}, {x: 0, y: 1.3, z: 0}, [
  {id: "between", min: {x: -2, y: 0, z: -6}, max: {x: 2, y: 8, z: -4}},
  {id: "player", min: {x: -0.3, y: 0, z: -0.3}, max: {x: 0.3, y: 1.8, z: 0.3}},
  {id: "aside", min: {x: 5, y: 0, z: -6}, max: {x: 8, y: 8, z: -4}},
  {id: "behind", min: {x: -2, y: 0, z: 3}, max: {x: 2, y: 8, z: 5}}]);

// cine
function cineRun(seed){
  var s = C.create({mode: "chase", seed: seed}), t = T(), ps = [];
  run(s, t, 1); C.setMode(s, "cine");
  for(var k = 0; k < 60*30; k++){ var p = C.step(s, t, 1/60, FLAT); if(k %% 30 === 0) ps.push([p.pos.x, p.pos.y, p.pos.z]); }
  return {ps: ps, s: s, t: t};
}
(function(){
  var a = cineRun(3), b = cineRun(3), c = cineRun(4);
  var p = C.step(a.s, a.t, 1/60, FLAT);
  out.cine = {same: JSON.stringify(a.ps) === JSON.stringify(b.ps), differs: JSON.stringify(a.ps) !== JSON.stringify(c.ps),
              hud: p.hud, n: a.ps.length};
  C.input(a.s, {anyInput: true}); out.cine.wake = a.s.wake; out.cine.prev = a.s.prev;
  C.setMode(a.s, a.s.prev);
  var back = run(a.s, a.t, 0.5), ref = settled("chase", a.t);
  out.cine.back = {mode: a.s.mode, blend: back.blend, gap: Math.hypot(back.pos.x - ref.pos.x, back.pos.y - ref.pos.y, back.pos.z - ref.pos.z), hud: back.hud};
})();

// photo
(function(){
  var t = T(), r = {};
  function photo(q){ var s = C.create({mode: "chase"}); run(s, t, 1, q); C.setMode(s, "photo"); run(s, t, 1, q); return s; }
  var s = photo(), y0 = run(s, t, 0.1).pos.y;
  C.input(s, {fly: {x: 0, y: 1, z: 0}}); run(s, t, 1); C.input(s, {fly: {x: 0, y: 0, z: 0}}); r.up = run(s, t, 2).pos.y - y0;
  var f = photo(), y1 = run(f, t, 0.1).pos.y;
  C.input(f, {fly: {x: 0, y: 1, z: 0}, fast: true}); run(f, t, 1); C.input(f, {fly: {x: 0, y: 0, z: 0}, fast: false}); r.fast = run(f, t, 2).pos.y - y1;
  var g = photo(), p0 = run(g, t, 0.1).pos;
  C.input(g, {fly: {x: 0, y: 0, z: 1}}); run(g, t, 1); C.input(g, {fly: {x: 0, y: 0, z: 0}}); var p1 = run(g, t, 2).pos;
  r.forward = Math.hypot(p1.x - p0.x, p1.z - p0.z); r.forwardY = p1.y - p0.y;
  var slope = {ground: function(x, z){ return 0.4*x - 0.2*z + 3; }, hit: function(){ return 1; }}, d = photo(slope), worst = 1e9, p;
  C.input(d, {fly: {x: 0.5, y: -1, z: 1}});
  for(var k = 0; k < 300; k++){ p = C.step(d, t, 1/60, slope); worst = Math.min(worst, p.pos.y - slope.ground(p.pos.x, p.pos.z)); }
  r.clear = worst; r.hud = p.hud; r.fov = p.fov;
  out.photo = r;
})();

// fp look: pitch clamp and invertY
(function(){
  var t = T(), r = {};
  var s = C.create({mode: "fp"}); run(s, t, 0.1);
  C.input(s, {look: [0, -100]}); r.up = s.lookPitch;
  C.input(s, {look: [0, -1e6]}); r.max = s.lookPitch;
  C.input(s, {look: [0, 1e6]}); r.min = s.lookPitch;
  var i = C.create({mode: "fp", settings: {invertY: true}}); run(i, t, 0.1);
  C.input(i, {look: [0, -100]}); r.inv = i.lookPitch;
  var y = C.create({mode: "fp"}); run(y, t, 0.1); var y0 = y.lookYaw; C.input(y, {look: [100, 0]}); r.yawRight = y.lookYaw - y0;
  r.hide = run(y, t, 1).hideAvatar;
  out.fpLook = r;
})();

// review fixes: collision from the head, see-through focus, cine/photo collision, classic -> rise, near plane, dt clamp
(function(){
  var r = {};
  // a wall filling z >= z0: the fraction along a->b where it is entered (0 when a starts inside)
  function wallZ(z0, calls){ return {ground: FLAT.ground, hit: function(a, b){ if(calls) calls.n++;
    if(a.z >= z0) return 0; if(b.z < z0) return 1; return (z0 - a.z)/(b.z - a.z); }}; }
  var fast = T({x: 0, z: 0, yaw: 0, speed: 20, moving: true}), wall = wallZ(2);
  var cp = settled("chase", fast, null, wall);
  r.wallAhead = {posZ: cp.pos.z, lookZ: cp.look.z};
  var box = {id: "ahead", min: {x: -1, y: 0, z: 1.5}, max: {x: 1, y: 3, z: 2.5}};
  var ch = settled("chase", fast);
  r.occChase = C.occluders(ch.pos, ch.focus, [box]); r.occChaseLook = C.occluders(ch.pos, ch.look, [box]);
  r.occChaseBehind = C.occluders(ch.pos, ch.focus, [{id: "behind", min: {x: -2, y: 0, z: -4}, max: {x: 2, y: 8, z: -3}}]);
  var fp = settled("fp", T({x: 0, z: 0, yaw: 0}));
  r.occFp = C.occluders(fp.pos, fp.focus, [{id: "hq", min: {x: -5, y: 0, z: 5}, max: {x: 5, y: 20, z: 15}}]);
  // cine: a wall at half of every ray pulls the camera in
  var calls = {n: 0}, half = {ground: FLAT.ground, hit: function(){ calls.n++; return 0.5; }}, worst = -1e9;
  var a = C.create({mode: "chase", seed: 5}), b = C.create({mode: "chase", seed: 5}), t = T();
  run(a, t, 1); run(b, t, 1); C.setMode(a, "cine"); C.setMode(b, "cine");
  for(var k = 0; k < 60*30; k++){
    var pa = C.step(a, t, 1/60, half), pb = C.step(b, t, 1/60, FLAT);
    if(k > 60){ var da = Math.hypot(pa.pos.x - pa.look.x, pa.pos.y - pa.look.y, pa.pos.z - pa.look.z),
                    db = Math.hypot(pb.pos.x - pb.look.x, pb.pos.y - pb.look.y, pb.pos.z - pb.look.z);
                worst = Math.max(worst, da - 0.5*db); }
  }
  r.cine = {calls: calls.n, worst: worst};
  // photo: flying forward into a wall at z = 3 stops the radius short of it
  var ph = C.create({mode: "chase"}), tp = T({x: 0, z: 0, yaw: 0}), pw = wallZ(3);
  run(ph, tp, 1, pw); C.setMode(ph, "photo"); run(ph, tp, 1, pw);
  C.input(ph, {fly: {x: 0, y: 0, z: 1}}); r.photoZ = run(ph, tp, 3, pw).pos.z; C.input(ph, {fly: {x: 0, y: 0, z: 0}});
  // classic follows the target, so rise starts at the avatar
  var c = C.create({mode: "chase"}), t0 = T({x: 0, z: 0}), t1 = T({x: 50, z: 50});
  run(c, t0, 1); C.setMode(c, "classic"); run(c, t0, 0.5); run(c, t1, 0.2); C.rise(c);
  var f = C.step(c, t1, 1/60, FLAT);
  r.classicRise = Math.hypot(f.look.x - t1.x, f.look.z - t1.z);
  // near plane continuity through rise and at the end of a dive
  r.riseNear = {};
  ["chase", "near", "fp"].forEach(function(m){
    var s = C.create({mode: m}), tt = T(); var pre = run(s, tt, 2); C.rise(s);
    r.riseNear[m] = [pre.near, C.step(s, tt, 1/60, FLAT).near];
  });
  var d = C.create({mode: "map", span: 2048}), td = T(); run(d, td, 0.2); C.dive(d, td);
  var maxJump = 0, prev = null;
  for(k = 0; k < 120; k++){ var pd = C.step(d, td, 1/60, FLAT); if(prev != null) maxJump = Math.max(maxJump, prev/pd.near); prev = pd.near; }
  r.diveEndNear = prev; r.diveNearJump = maxJump;
  // head bob in a vehicle too (spec 2.5 has no vehicle exception)
  var vb = C.create({mode: "fp"}), tv = T({vehicle: "moto", speed: 4, moving: true}), mb = 0;
  for(k = 0; k < 180; k++) mb = Math.max(mb, Math.abs(C.step(vb, tv, 1/60, FLAT).headBob));
  r.vehicleBob = mb;
  // dt clamp 0.05
  var dc = C.create({mode: "chase"}); C.step(dc, T(), 1, FLAT); r.dtClamp = dc._.t;
  out.review = r;
})();

// second review: map over a hill, cine heading, reverse cycle into a car, capped bob rate
(function(){
  var r = {}, hill = {ground: function(){ return 87; }, hit: function(){ return 1; }, viewH: 800};
  var m = C.create({mode: "map", span: 44}), p = run(m, T(), 0.5, hill);
  r.mapHill = {clear: p.pos.y - 87, lookY: p.look.y};
  var c = C.create({mode: "chase"}), tc = T(); run(c, tc, 1); C.setMode(c, "cine");
  var yaws = [], q;
  for(var k = 0; k < 4; k++){ q = run(c, tc, 2.5);
    yaws.push([c.lookYaw, Math.atan2(q.look.x - q.pos.x, q.look.z - q.pos.z), c.lookPitch]); }
  r.cineYaw = yaws;
  var cl = C.create({mode: "classic"}), car = T({vehicle: "car"}); run(cl, car, 0.1);
  var rev = []; for(k = 0; k < 3; k++){ C.cycle(cl, -1); rev.push([cl.mode, cl.fpView]); run(cl, car, 0.6); }
  r.reverseCar = rev;
  function phaseRate(speed){ var b = C.create({mode: "fp"}), t = T({vehicle: "car", speed: speed, moving: true});
    run(b, t, 1); var a0 = b._.bobPhase; C.step(b, t, 1/60, FLAT); return ((b._.bobPhase - a0 + 2*Math.PI) %% (2*Math.PI))*60/(2*Math.PI); }
  r.bobHz = {slow: phaseRate(4), fast: phaseRate(30)};
  out.review2 = r;
})();
// On foot with the keys, the way hq3d moves the avatar (body-relative): the turn rate springs (omega 18)
// toward +-rate (3.6 rad/s, HQ 3.2), the yaw integrates it, the speed springs (omega 12) toward 4 m/s forward or
// 0.65x back; travelYaw = facing (forward or turning), facing + PI stepping back; standing still it stays the
// facing if that is where you were last headed (so the camera settles behind you), else null (games/hq3d.js
// travelYawOf).
// A script is [[secs, fwd, turn, rate?], ...]; fps 0 = jittery dt (deterministic, 1/144..1/30 s).
function walkRun(mode, script, fps){
  var s = C.create({mode: mode}), PI = Math.PI, seed = 12345;
  var st = {x: 0, z: 0, yaw: 0, rate: 0, rateV: 0, speed: 0, speedV: 0, tr: null};
  function wrap(a){ return Math.atan2(Math.sin(a), Math.cos(a)); }
  function rnd(){ seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed/4294967296; }
  function tgt(fwd, turn){
    var tr = st.speed < -0.05 ? wrap(st.yaw + PI) : (st.speed > 0.05 || Math.abs(st.rate) > 0.05 ? wrap(st.yaw)
             : (st.tr != null && Math.abs(wrap(st.tr - st.yaw)) < PI/2 ? wrap(st.yaw) : null));
    st.tr = tr;
    return {x: st.x, y: 0, z: st.z, yaw: st.yaw, pitch: 0, roll: 0, speed: Math.abs(st.speed), vehicle: null, lean: 0,
            moving: !!(fwd || turn), travelYaw: tr, turnRate: st.rate};
  }
  run(s, tgt(0, 0), 2);
  var t = 0, r = {t: [], aim: [], head: [], body: [], pitch: [], travel: []};
  script.forEach(function(ph){
    var end = t + ph[0];
    while(t < end - 1e-9){
      var dt = fps ? 1/fps : 1/144 + rnd()*(1/30 - 1/144);
      dt = Math.min(dt, end - t);
      var turnGoal = ph[2]*(ph[3] || 3.6);
      var rr = C.spring(st.rate, st.rateV, turnGoal, 18, dt);
      var sp = C.spring(st.speed, st.speedV, ph[1] > 0 ? 4*ph[1] : 4*0.65*ph[1], 12, dt);
      st.yaw = wrap(st.yaw + (st.rate + rr[0])*0.5*dt); st.rate = rr[0]; st.rateV = rr[1]; st.speed = sp[0]; st.speedV = sp[1];
      st.x += Math.sin(st.yaw)*st.speed*dt; st.z += Math.cos(st.yaw)*st.speed*dt;
      var T0 = tgt(ph[1], ph[2]), p = C.step(s, T0, dt, FLAT);
      t += dt;
      r.t.push(t); r.aim.push(Math.atan2(p.look.x - p.pos.x, p.look.z - p.pos.z)); r.head.push(s.moveYaw);
      r.body.push(st.yaw); r.travel.push(T0.travelYaw); r.pitch.push(s.lookPitch);
    }
  });
  return r;
}
var SCRIPTS = {
  W: [[1, 0, 0], [5, 1, 0]],                          // walk straight on
  WS: [[2, 1, 0], [6, -1, 0]],                        // walking, then step back with S
  S: [[1, 0, 0], [6, -1, 0]],                         // from standing, step back
  WD: [[1, 1, 0], [5, 1, -1]],                        // W + D: a circle at 3.6 rad/s
  WDslow: [[1, 1, 0], [5, 1, -1, 1.2]],               // the same at 1.2 rad/s
  Dtap: [[1, 1, 0], [0.6, 1, 1], [4, 1, 0]],          // a short A tap while walking
  Aspot: [[1, 0, 0], [1, 0, 1], [4, 0, 0]],           // turn on the spot, then stand
  SA: [[1, 0, 0], [2, -1, 0], [1.5, 0, 1], [3, 0, 0]],   // step back, let go of S and turn left with A
  SwA: [[1, 0, 0], [2, -1, 0], [1.5, -1, 1], [3, 0, 0]], // step back, then S + A together
  flip: [[1, 1, 0], [0.7, -1, 0], [0.7, 1, 0], [0.7, -1, 0], [3, 0, 0]]   // W/S back and forth, then stop
};
out.walk = {};
["far", "chase", "near"].forEach(function(m){
  out.walk[m] = {};
  Object.keys(SCRIPTS).forEach(function(k){
    out.walk[m][k] = {};
    [30, 60, 120, 0].forEach(function(fps){ out.walk[m][k][fps ? String(fps) : "jitter"] = walkRun(m, SCRIPTS[k], fps); });
  });
});
process.stdout.write(JSON.stringify(out));
"""


def rot(v, yaw):
    """Model-local (x, z) -> world for a yaw (yaw 0 faces +z, local +x is left)."""
    lx, lz = v
    return (lx * math.cos(yaw) + lz * math.sin(yaw), -lx * math.sin(yaw) + lz * math.cos(yaw))


def matmul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)] for i in range(3)]


def mat_yxz(yaw, pitch, roll):
    """three.js Euler "YXZ" with rotation.y = yaw, rotation.x = -pitch, rotation.z = roll."""
    cy, sy = math.cos(yaw), math.sin(yaw)
    cx, sx = math.cos(-pitch), math.sin(-pitch)
    cz, sz = math.cos(roll), math.sin(roll)
    ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]]
    rx = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]]
    rz = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]]
    return matmul(matmul(ry, rx), rz)


@unittest.skipUnless(NODE, "node is not installed")
class CamRig(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        js = HARNESS % {"root": json.dumps(ROOT)}
        res = subprocess.run([NODE, "-e", js], capture_output=True, text=True, timeout=120)
        if res.returncode != 0:
            raise AssertionError(res.stderr)
        cls.o = json.loads(res.stdout)

    def close(self, a, b, tol=1e-3, msg=None):
        self.assertLessEqual(abs(a - b), tol, msg or "%r != %r" % (a, b))

    def vclose(self, a, b, tol=1e-3):
        for x, y in zip(a, b):
            self.close(x, y, tol, "%r != %r" % (a, b))

    def expected(self, mode, veh=None, yaw=0.7):
        m = self.o["modes"][mode]
        v = self.o["vehicle"][veh] if veh else {"backMul": 1, "upMul": 1, "sideMul": 1}
        back, up, side = m["back"] * v["backMul"], m["up"] * v["upMul"], m["side"] * v["sideMul"]
        x, z = rot((-side, -back), yaw)
        return [x, up, z]

    def test_spring_is_frame_rate_independent(self):
        s = self.o["spring"]
        self.close(s["a"][0], s["b"][0], 1e-3)
        self.close(s["a"][1], s["b"][1], 1e-3)
        self.assertEqual(s["smoother"], [0, 0.5, 1])

    def test_mode_table_and_order(self):
        m = self.o["modes"]
        self.assertEqual(self.o["order"], ["far", "chase", "near", "fp", "classic"])
        self.assertEqual((m["far"]["back"], m["far"]["up"], m["far"]["fov"]), (15, 9, 60))
        self.assertEqual((m["chase"]["back"], m["chase"]["up"], m["chase"]["fov"]), (7, 3.8, 65))
        self.assertEqual((m["near"]["back"], m["near"]["up"], m["near"]["fov"], m["near"]["side"]), (2.8, 1.8, 70, 0.6))
        self.assertEqual((m["fp"]["fov"], m["photo"]["fov"], m["cine"]["fov"], m["map"]["fov"]), (75, 60, 50, 10))

    def test_settled_offsets_equal_the_table(self):
        st = self.o["settled"]
        for mode in ("far", "chase", "near"):
            self.vclose(st[mode]["off"], self.expected(mode))
            self.close(st[mode]["fov65"], self.o["modes"][mode]["fov"], 0.01)
            self.close(st[mode]["fov80"], self.o["modes"][mode]["fov"] + 15, 0.01)
            # 3.2: the near plane is a twelfth of the way to the pivot (the head, LOOK_H up), 0.3..2.5 m
            o = st[mode]["off"]
            self.close(st[mode]["near"], max(0.3, min(2.5, math.sqrt(o[0]**2 + (o[1] - 1.3)**2 + o[2]**2) / 12)), 1e-6)
            self.close(st[mode]["far"], 6000, 1e-9)   # planes 3 km off at 600 m, airways higher (games/hqair.js)
        # near sits to the right: model-local -x
        right = rot((-1, 0), 0.7)
        off = st["near"]["off"]
        self.assertGreater(off[0] * right[0] + off[2] * right[1], 0.5)
        self.vclose(st["fp"]["off"], [0, 1.65, 0])
        self.close(st["fp"]["fov65"], 75, 0.01)
        self.close(st["fp"]["fov80"], 90, 0.01)
        self.close(st["fp"]["near"], 0.15, 1e-9)
        self.assertTrue(st["fp"]["hide"])
        for mode, fov in (("map", 10), ("photo", 60), ("cine", 50)):
            self.close(st[mode]["fov65"], fov, 1e-9)
            self.close(st[mode]["fov80"], fov, 1e-9, "%s is not offset by the FOV setting" % mode)
        self.assertEqual(st["map"]["up"], {"x": 0, "y": 0, "z": -1})
        self.assertFalse(st["photo"]["hud"])
        self.assertFalse(st["cine"]["hud"])

    def test_vehicle_tuning(self):
        for v in ("car", "moto", "bike", "skate"):
            for mode in ("far", "chase", "near"):
                self.vclose(self.o["veh"][v][mode], self.expected(mode, v))
        self.close(self.o["veh"]["moto"]["roll"], 0.4 * 0.4 * 0.5, 1e-9)
        self.close(self.o["veh"]["bike"]["roll"], 0.25 * 0.4 * 0.5, 1e-9)
        self.close(self.o["veh"]["car"]["roll"], 0, 1e-9)
        for v in ("moto", "bike", "skate"):
            self.assertEqual(self.o["veh"][v]["rollReduced"], 0)
        self.assertEqual(self.o["footRoll"], 0)

    def test_speed_fov_kick(self):
        base = 65
        self.close(self.o["footKick"] - base, 5, 0.01)
        self.close(self.o["footKickBig"] - base, 10, 0.01)
        self.close(self.o["veh"]["skate"]["kick"] - base, 5 * 1.6, 0.01)
        self.close(self.o["veh"]["car"]["kick"] - base, 5, 0.01)
        self.close(self.o["kickReduced"], base, 0.01)

    def test_fp_anchor_world(self):
        yaw, pitch, roll = 0.9, 0.3, -0.25
        m = mat_yxz(yaw, pitch, roll)
        a = [0.4, 1.1, 0.7]
        want = [sum(m[i][k] * a[k] for k in range(3)) + [1, 2, 3][i] for i in range(3)]
        got = self.o["anchor"]
        self.vclose([got["x"], got["y"], got["z"]], want, 1e-9)
        # sign checks: positive pitch lifts the nose, positive roll lowers model-local -x
        nose = mat_yxz(0, 0.3, 0)
        self.assertGreater(nose[1][2], 0)
        rolled = mat_yxz(0, 0, 0.3)
        self.assertLess(-rolled[1][0], 0)
        # the car seat is on the right-hand side (model-local -x) at every yaw
        for row in self.o["seat"]:
            rx, rz = rot((-1, 0), row["yaw"])
            self.close(row["p"]["x"] * rx + row["p"]["z"] * rz, 0.38, 1e-9)
        seat, bonnet = self.o["fpCar"]["seat"], self.o["fpCar"]["bonnet"]
        sx, sz = rot((-0.38, 0.1), 0.7)
        self.vclose([seat["x"] - 5, seat["y"], seat["z"] + 7], [sx, 1.15, sz])
        bx, bz = rot((0, 1.6), 0.7)
        self.vclose([bonnet["x"] - 5, bonnet["y"], bonnet["z"] + 7], [bx, 1.05, bz])

    def test_cycle(self):
        c = self.o["cycle"]
        self.assertEqual([m for m, _ in c["fwd"]], ["chase", "near", "fp", "classic", "far", "chase"])
        self.assertTrue(all(m == p for m, p in c["fwd"]), "cycle sets preferred")
        self.assertEqual(c["back"], ["far", "classic", "fp", "near", "chase"])
        self.assertEqual(self.o["cycleCar"], [["fp", "bonnet"], ["classic", "seat"], ["far", "seat"]])
        self.assertEqual(self.o["cycleMoto"], ["classic", "seat"])
        self.assertEqual(self.o["cycleFoot"], "classic")
        self.assertEqual(self.o["setModeNoVia"], "far")
        self.assertEqual(self.o["setModeUser"], "near")

    def check_dive(self, r, pref, t_dive):
        n = int(round(t_dive * 60))
        for i in range(1, n):
            self.assertLessEqual(r["alts"][i], r["alts"][i - 1] + 1e-9, "altitude rises at frame %d" % i)
        self.close(r["fovs"][0], 10, 0.5)
        self.assertGreater(r["alts"][0], 5000)
        self.assertTrue(all(r["fovs"][i] <= r["fovs"][i + 1] + 1e-9 for i in range(int(t_dive * 60) - 1)))
        d, ref = r["atDive"], r["refNear"]
        self.assertEqual(d["mode"], "near")
        self.assertEqual(d["blend"], 1)
        self.close(d["fov"], 70, 1e-6)
        for k in "xyz":
            self.close(d["pos"][k], ref["pos"][k], 1e-6)
        s, ref = r["atSettle"], r["refPref"]
        self.assertEqual(s["mode"], pref)
        self.assertEqual(s["blend"], 1)
        for k in "xyz":
            self.close(s["pos"][k], ref["pos"][k], 1e-6)
        self.close(s["fov"], ref["fov"], 1e-6)
        self.assertEqual(r["preferred"], pref)
        for u in r["ups"]:
            self.assertGreater(math.sqrt(u["x"] ** 2 + u["y"] ** 2 + u["z"] ** 2), 0.99)

    def test_dive_settles_into_preferred(self):
        self.check_dive(self.o["dive"]["chase"], "chase", 1.2)
        self.check_dive(self.o["dive"]["near"], "near", 1.2)
        self.check_dive(self.o["dive"]["far"], "far", 1.2)
        self.check_dive(self.o["dive"]["reduced"], "chase", 0.6)

    def test_rise(self):
        r = self.o["rise"]
        for i in range(1, len(r["alts"])):
            self.assertGreaterEqual(r["alts"][i], r["alts"][i - 1] - 1e-9)
        e = r["end"]
        self.assertEqual(r["mode"], "map")
        self.assertEqual(e["blend"], 1)
        self.close(e["fov"], 10, 1e-9)
        self.assertEqual(e["up"], {"x": 0, "y": 0, "z": -1})
        self.close(e["pos"]["x"], 120, 1e-6)
        self.close(e["pos"]["z"], -300, 1e-6)
        self.close(e["pos"]["y"], 400 / (2 * math.tan(math.radians(5))), 1e-6)
        self.assertEqual(r["centre"], {"x": 120, "z": -300})

    def test_map_zoom_pan_fly(self):
        m = self.o["map"]
        alt = lambda span: span / (2 * math.tan(math.radians(5)))
        self.assertEqual(m["minSpan"], 44)
        self.assertEqual(m["maxSpan"], 2048)
        self.close(m["minAlt"], alt(44), 0.5)
        self.close(m["maxAlt"], alt(2048), 0.5)
        self.assertTrue(251 < m["minAlt"] < 252.5 and 11700 < m["maxAlt"] < 11705)
        self.assertEqual(m["maxCentre"], {"x": 0, "z": 0})
        self.assertEqual(m["panAtMax"], {"x": 0, "z": 0})
        self.close(m["zoomOne"], 2048, 1e-9)
        self.close(m["pan"]["x"], 100 * 400 / 800, 1e-9)
        self.close(m["pan"]["z"], -50 * 400 / 800, 1e-9)
        self.assertEqual(m["panClamp"], {"x": 1024 - 200, "z": -(1024 - 200)})
        self.assertNotEqual(m["flyMid"]["centre"], {"x": 300, "z": -200})
        self.assertEqual(m["fly"]["centre"], {"x": 300, "z": -200})
        self.close(m["fly"]["span"], 200, 1e-9)
        self.close(m["fly"]["pos"]["x"], 300, 1e-9)
        self.assertGreaterEqual(min(m["flySpans"]), 44)
        self.assertEqual(m["flyMinEnd"], 44)

    def test_collision(self):
        c = self.o["collide"]
        self.close(c["hit"], 0.5 * c["free"] - c["radius"], 1e-3)
        # pull-in is a fast spring (omega 25), not a one-frame snap
        self.assertGreater(c["hitFirst"], c["hit"] + 0.3, "pull-in snapped in one frame")
        self.assertLess(c["hitFirst"], c["free"] - 1e-3, "pull-in did not start")
        self.assertLess(c["easing"], c["free"] - 0.1, "push-out eases, it does not snap")
        self.close(c["later"], c["free"], 0.01)
        self.assertLess(c["pump"], 0.05, "the camera pumped in and out between corners")
        self.assertGreaterEqual(self.o["slopeClear"], 0.3 - 1e-9)

    def test_recentre_in_chase_family(self):
        for mode, r in self.o["recentre"].items():
            self.assertGreater(r["held"], 1.0, mode)
            self.assertLess(r["back"], 0.05, mode)

    def test_swing_lift_wheel_bounds(self):
        b = self.o["bounds"]
        # Q/R: 1.9 rad/s eased in and out, so a 1 s hold turns 1.9 rad once it has coasted out
        self.close(b["swingYaw"], 1.9, 0.02)
        self.assertLessEqual(abs(b["swingLong"]), math.pi + 1e-9)
        self.close(b["liftUp"], 3 * 3.8, 1e-6)
        self.close(b["liftDown"], 0.6, 1e-6)
        self.close(b["wheelOut"], 2.5 * 7, 1e-3)
        self.close(b["wheelIn"], 0.5 * 7, 1e-3)

    def test_settings_mid_session_and_reduced_motion(self):
        s = self.o["settings"]
        self.close(s["fovAfter"], 80, 0.5)
        self.assertGreater(s["kickOn"]["fov"], 69)
        self.assertGreater(abs(s["kickOn"]["roll"]), 0.05)
        self.close(s["kickOff"]["fov"], 65, 0.5)
        self.assertEqual(s["kickOff"]["roll"], 0)
        self.assertLess(s["blendNormal"][0], 1)
        self.assertEqual(s["blendNormal"][1], 1)
        self.assertLess(s["blendReduced"][0], 1)
        self.assertEqual(s["blendReduced"][1], 1)
        self.assertGreater(s["bob"], 0.03)
        self.assertLessEqual(s["bob"], 0.04 + 1e-9)
        self.assertEqual(s["bobReduced"], 0)
        self.assertEqual(s["bobAfterReduced"], 0)

    def test_vignette(self):
        v = self.o["vignette"]
        self.assertEqual(v["fpStop"], 0)
        self.close(v["fp8"], 0.4, 1e-9)
        self.close(v["fp30"], 0.6, 1e-9)
        for k in ("chase30", "far30", "map", "photo"):
            self.assertEqual(v[k], 0, k)

    def test_occluders(self):
        self.assertEqual(self.o["occ"], ["between"])

    def test_cine(self):
        c = self.o["cine"]
        self.assertTrue(c["same"])
        self.assertTrue(c["differs"])
        self.assertFalse(c["hud"])
        self.assertTrue(c["wake"])
        self.assertEqual(c["prev"], "chase")
        self.assertEqual(c["back"]["mode"], "chase")
        self.assertEqual(c["back"]["blend"], 1)
        self.assertTrue(c["back"]["hud"])
        self.assertLess(c["back"]["gap"], 1e-6)

    def test_photo(self):
        p = self.o["photo"]
        self.close(p["up"], 8, 0.01)
        self.close(p["fast"], 24, 0.01)
        self.close(p["forward"], 8, 0.01)
        self.close(p["forwardY"], 0, 1e-6)
        self.assertGreaterEqual(p["clear"], 0.3 - 1e-9)
        self.assertFalse(p["hud"])
        self.assertEqual(p["fov"], 60)

    def test_fp_look(self):
        f = self.o["fpLook"]
        self.close(f["up"], 100 * 0.0022, 1e-9)
        self.close(f["inv"], -100 * 0.0022, 1e-9)
        self.close(f["max"], 1.45, 1e-9)
        self.close(f["min"], -1.45, 1e-9)
        self.close(f["yawRight"], -100 * 0.0022, 1e-9)
        self.assertTrue(f["hide"])

    def test_collision_ray_starts_at_the_head(self):
        w = self.o["review"]["wallAhead"]
        self.assertLess(w["posZ"], 0, "camera stays behind the target")
        self.assertLess(w["posZ"], 2, "and outside the wall")

    def test_see_through_focus(self):
        r = self.o["review"]
        self.assertEqual(r["occChaseLook"], ["ahead"], "fixture: the look-ahead segment does reach the box")
        self.assertEqual(r["occChase"], [])
        self.assertEqual(r["occChaseBehind"], ["behind"])
        self.assertEqual(r["occFp"], [])

    def test_cine_and_photo_collide(self):
        r = self.o["review"]
        self.assertGreater(r["cine"]["calls"], 0)
        self.assertLessEqual(r["cine"]["worst"], 1e-6)
        self.assertLessEqual(r["photoZ"], 3 - 0.3 + 1e-6)
        self.assertGreater(r["photoZ"], 2)

    def test_rise_from_classic_starts_at_the_target(self):
        self.assertLess(self.o["review"]["classicRise"], 3)

    def test_near_plane_is_continuous(self):
        r = self.o["review"]
        for mode, (pre, first) in r["riseNear"].items():
            self.close(first, pre, 0.1 * pre, mode)
        self.assertTrue(0.3 <= r["diveEndNear"] <= 2.5, r["diveEndNear"])   # (3.2: scaled with the chase distance)
        self.assertLess(r["diveNearJump"], 1.5)

    def test_vehicle_head_bob_and_dt_clamp(self):
        r = self.o["review"]
        self.assertGreater(r["vehicleBob"], 0.03)
        self.close(r["dtClamp"], 0.05, 1e-12)


    def test_map_altitude_is_over_the_ground(self):
        r = self.o["review2"]["mapHill"]
        self.close(r["clear"], 44 / (2 * math.tan(math.radians(5))), 0.5)
        self.close(r["lookY"], 87, 1e-6)

    def test_cine_keeps_look_yaw_current(self):
        for lookYaw, yaw, pitch in self.o["review2"]["cineYaw"]:
            self.close(lookYaw, yaw, 1e-9)
            self.assertLess(pitch, 0)

    def test_reverse_cycle_enters_car_fp_at_bonnet(self):
        self.assertEqual(self.o["review2"]["reverseCar"], [["fp", "bonnet"], ["fp", "seat"], ["near", "seat"]])

    # On foot (contract items 2 and 3): keys are body-relative, the camera heading follows travelYaw.
    def wrap(self, a):
        return math.atan2(math.sin(a), math.cos(a))

    def rates(self, r, key="aim"):
        """Per-frame angular rates (rad/s) and the angular acceleration between frames (rad/s^2)."""
        t = [0.0] + r["t"]
        v = []
        for i in range(1, len(r[key])):
            dt = t[i + 1] - t[i]
            v.append((self.wrap(r[key][i] - r[key][i - 1]) / dt, dt))
        acc = [abs(v[i][0] - v[i - 1][0]) / ((v[i][1] + v[i - 1][1]) / 2) for i in range(1, len(v))]
        return [x for x, _ in v], acc

    def at(self, r, when, key="head"):
        """r[key] at time `when`, linearly interpolated (unwrapped across +-pi)."""
        t, y = r["t"], r[key]
        for i in range(1, len(t)):
            if t[i] >= when:
                u = (when - t[i - 1]) / (t[i] - t[i - 1])
                return y[i - 1] + self.wrap(y[i] - y[i - 1]) * u
        return y[-1]

    def test_w_straight_holds_the_camera(self):
        for m, sc in self.o["walk"].items():
            for f, r in sc["W"].items():
                drift = max(abs(self.wrap(h - r["head"][0])) for h in r["head"])
                self.assertLess(drift, 1e-6, "%s W @%s: heading drifted %.4f" % (m, f, drift))
                # the look-ahead grows as you set off (near's side offset turns that into a little aim), then holds
                late = self.at(r, r["t"][-1] - 2, "aim")
                self.assertLess(abs(self.wrap(r["aim"][-1] - late)), 0.002, "%s W @%s aim still moving" % (m, f))

    def test_s_steps_back_and_the_camera_swings_round(self):
        """S steps back facing forward; travelYaw = facing + PI and the camera heading swings ~PI to look
        where you are going, smoothly, then holds there."""
        for m, sc in self.o["walk"].items():
            for key in ("S", "WS"):
                for f, r in sc[key].items():
                    body, head, trav = r["body"][-1], r["head"][-1], r["travel"][-1]
                    self.assertLess(abs(self.wrap(body)), 1e-9, "%s %s: S turned the body" % (m, key))
                    self.close(abs(self.wrap(trav - body)), math.pi, 1e-9)
                    self.assertLess(abs(self.wrap(head - trav)), 0.02, "%s %s @%s: heading %.3f off travel" % (m, key, f, self.wrap(head - trav)))
                    late = self.at(r, r["t"][-1] - 1)
                    self.assertLess(abs(self.wrap(head - late)), 0.02, "%s %s @%s still turning in the last second" % (m, key, f))
                    # one way round, never back and forth
                    v, _ = self.rates(r, "head")
                    moving = [x for x in v if abs(x) > 1e-3]
                    self.assertTrue(all(x > 0 for x in moving) or all(x < 0 for x in moving), "%s %s @%s reversed" % (m, key, f))

    def test_turning_keeps_the_camera_with_the_body(self):
        """W + D (HQ 3.2): the camera heading is carried with the turning body, so it never trails it (it used to lag
        2 turnRate/omega, ~65 degrees at 2.4 rad/s, and disagreed with the heading-up minimap that whole time)."""
        for m, sc in self.o["walk"].items():
            for f in sc["WD"]:
                for key, rate in (("WD", 3.6), ("WDslow", 1.2)):
                    r = sc[key][f]
                    worst = max(abs(self.wrap(b - h)) for b, h, t in zip(r["body"], r["head"], r["t"]) if t > 1)
                    self.assertLess(worst, 0.01, "%s %s @%s: camera %.3f rad off the body while turning" % (m, key, f, worst))
                    v, _ = self.rates(r, "head")
                    self.close(v[-1], -rate, 0.01, "%s %s @%s camera turn rate %.3f" % (m, key, f, v[-1]))
                # a short A tap while walking: the camera is behind you when it ends
                tap = sc["Dtap"][f]
                self.assertLess(abs(self.wrap(tap["body"][-1] - tap["head"][-1])), 0.02, "%s Dtap @%s" % (m, f))

    def test_turning_after_s_never_swings_against_the_key(self):
        """After an S step the camera looks back; pressing A brings the goal (the facing) round to meet it, so
        the camera waits for the body instead of taking the short way round against the key, then follows it
        and settles behind you."""
        for m, sc in self.o["walk"].items():
            for key in ("SA", "SwA"):
                for f, r in sc[key].items():
                    against = 0
                    for i in range(1, len(r["t"])):
                        if 3 <= r["t"][i] <= 4.5:
                            d = self.wrap(r["head"][i] - r["head"][i - 1])
                            against += max(0, -d)          # A turns left: yaw goes up
                    self.assertLess(against, 0.25, "%s %s @%s: camera turned %.2f rad against A" % (m, key, f, against))
                body, head = r["body"][-1], r["head"][-1]
                if key == "SA":
                    self.assertLess(abs(self.wrap(body - head)), 0.3, "%s SA: camera %.2f off the body" % (m, self.wrap(body - head)))

    def test_turning_on_the_spot_settles_behind_you(self):
        """Letting go of A on the spot (HQ 3.2): the camera stops with the body, directly behind it (it used to park
        ~0.4 rad off once you stood still), and never passes it."""
        for m, sc in self.o["walk"].items():
            for f, r in sc["Aspot"].items():
                self.assertLess(abs(self.wrap(r["body"][-1] - r["head"][-1])), 0.005, "%s Aspot @%s: camera off the body" % (m, f))
                gaps = [self.wrap(b - h) for b, h, t in zip(r["body"], r["head"], r["t"]) if t > 2]
                self.assertTrue(all(g > -1e-3 for g in gaps), "%s Aspot @%s: the camera passed the body" % (m, f))
                self.assertTrue(r["travel"][-1] is not None, "%s Aspot @%s: travelYaw dropped after a turn" % (m, f))

    def test_the_aim_never_jumps(self):
        """Every scenario at 30/60/120 fps and jittery dt: the aim-yaw rate stays within what the contract's
        motion needs (0.03 rad per 60 fps frame; a PI swing on the slowest heading spring peaks at
        PI*1.6/e rad/s, a held turn at the body's 3.6 rad/s), the angular acceleration stays bounded and
        does not grow with the frame rate (a jump would scale with 1/dt; 3.2: the camera turns with the body, whose
        turn rate springs up at omega 18, peaking near 3.6*18/e = 24 rad/s^2, a bit more where S hands over to A), and the pitch is steady."""
        swing_peak = math.pi * 1.6 / math.e / 60 + 1e-3
        limit = {"W": 0.03, "WDslow": 0.03, "Dtap": 3.6 / 60 * 1.06, "S": swing_peak, "WS": swing_peak, "flip": swing_peak,
                 "WD": 3.6 / 60 * 1.06, "Aspot": 3.6 / 60 * 1.06, "SA": 3.6 / 60 * 1.5, "SwA": 3.6 / 60 * 1.5}   # the aim (pivot + look-ahead) may run a hair ahead of the body
        for m, sc in self.o["walk"].items():
            for key, runs in sc.items():
                peak_acc = {}
                for f, r in runs.items():
                    v, acc = self.rates(r)
                    step = max(abs(x) for x in v) / 60
                    self.assertLess(step, limit[key], "%s %s @%s: %.4f rad per 60 fps frame" % (m, key, f, step))
                    peak_acc[f] = max(acc) if acc else 0
                    self.assertLess(peak_acc[f], 40, "%s %s @%s: angular acceleration %.1f rad/s^2" % (m, key, f, peak_acc[f]))
                    pv, _ = self.rates(r, "pitch")
                    self.assertLess(max(abs(x) for x in pv) / 60, 0.003, "%s %s @%s pitch" % (m, key, f))
                self.assertLess(peak_acc["120"], 1.4 * peak_acc["30"] + 0.5, "%s %s: acceleration grows with fps (a jump)" % (m, key))

    def test_walking_is_frame_rate_independent(self):
        """The heading and aim curves at 30, 120 fps and jittery dt match 60 fps after resampling. Where S
        flips travelYaw the host sees the flip on the first frame its speed crosses zero, up to 1/30 s apart
        between runs, so there the curves may differ by the swing's peak rate (1.85 rad/s) times that."""
        for m, sc in self.o["walk"].items():
            for key, runs in sc.items():
                ref = runs["60"]
                end = ref["t"][-1]
                for f in ("30", "120", "jitter"):
                    r = runs[f]
                    worst = 0
                    for i in range(1, int(end * 10)):
                        for k in ("head", "aim"):
                            worst = max(worst, abs(self.wrap(self.at(r, i / 10, k) - self.at(ref, i / 10, k))))
                    # (SA / SwA: where the body's turn takes over from the swing, the carry's hand-over lands on a frame
                    # boundary too: up to a 30 fps frame of the 3.6 rad/s turn's share, ~0.03 rad more)
                    tol = 0.01 + (1.85 / 30 if key in ("S", "WS", "flip", "SA", "SwA") else 0) + (0.03 if key in ("SA", "SwA") else 0)
                    self.assertLess(worst, tol, "%s %s @%s differs from 60 fps by %.4f rad" % (m, key, f, worst))

    def test_bob_rate_capped(self):
        r = self.o["review2"]["bobHz"]
        self.close(r["slow"], 1.8, 1e-6)
        self.close(r["fast"], 1.8 * 6 / 4, 1e-6)


PASSENGER_HARNESS = r"""
var fs = require("fs"), root = %(root)s;
global.window = {HQV: {}};
new Function(fs.readFileSync(root + "/games/camrig.js", "utf8"))();
var C = window.HQV.camrig, out = {};
var FLAT = {ground: function(){ return 0; }, hit: function(){ return 1; }, viewH: 800};
function run(s, tgt, secs, dt){ dt = dt || 1/60; var p, n = Math.round(secs/dt); for(var i = 0; i < n; i++) p = C.step(s, tgt, dt, FLAT); return p; }
var KINDS = ["bus", "tram", "metro", "rail", "gondola", "waterbus", "cab", "heli-cabin"];
out.rows = {}; KINDS.forEach(function(k){ out.rows[k] = C.VEHICLE[k] || null; });
// first person in a bus seat: the eye is the anchor in the vehicle frame; a chase sits behind a bus further than behind a car
var tb = {x: 3, y: 0.3, z: -2, yaw: 0.6, pitch: 0, roll: 0, speed: 8, vehicle: "bus", moving: true};
var fp = run(C.create({mode: "fp", settings: {headBob: false}}), tb, 2);
out.fp = {pos: fp.pos, want: C.fpAnchorWorld(tb, C.VEHICLE.bus.fpAnchor.seat), hide: fp.hideAvatar};
function chaseDist(v){ var t = {x: 0, y: 0, z: 0, yaw: 0, speed: 0, vehicle: v}, p = run(C.create({mode: "chase"}), t, 4); return Math.hypot(p.pos.x, p.pos.z); }
out.chase = {bus: chaseDist("bus"), tram: chaseDist("tram"), car: chaseDist("car")};
// selfie: at arm's length in front of the face, looking at it; level and still with reduced motion or target.calm
function selfie(settings, extra, secs){
  var s = C.create({mode: "chase", settings: settings}), t = {x: 10, y: 0, z: 4, yaw: 1.1, speed: 0};
  for(var k in extra || {}) t[k] = extra[k];
  run(s, t, 1); C.setMode(s, "selfie", {instant: true});
  var a = run(s, t, secs || 1), b = run(s, t, 0.7);
  return {a: a, b: b, mode: s.mode, t: t};
}
var still = selfie({reduced: true}), calm = selfie({}, {calm: true}), live = selfie({});
var seated = selfie({reduced: true}, {face: 1.1});
var sw = C.create({mode: "selfie", settings: {reduced: true}}), tw = {x: 0, y: 0, z: 0, yaw: 0};
run(sw, tw, 0.5); C.input(sw, {look: [-2000, 0]}); var turned = run(sw, tw, 0.5);
C.cycle(sw, 1); out.cycleFrom = sw.mode;
out.selfie = {still: still, calm: calm, live: live, seated: seated, turned: turned, inOrder: C.ORDER.indexOf("selfie"), consts: C.SELFIE, mode: C.MODES.selfie};
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
class PassengerCameraTest(unittest.TestCase):
    """HQ 3.15: passenger rows for every ridden kind, and the phone's selfie camera."""
    @classmethod
    def setUpClass(cls):
        p = subprocess.run([NODE, "-e", PASSENGER_HARNESS % {"root": json.dumps(ROOT)}], capture_output=True, text=True, timeout=60)
        if p.returncode != 0:
            raise AssertionError("node failed:\n" + p.stderr[-4000:])
        cls.o = json.loads(p.stdout)

    def test_passenger_rows(self):
        for k, row in self.o["rows"].items():
            self.assertIsNotNone(row, k)
            seat = row["fpAnchor"]["seat"]
            self.assertEqual(len(seat), 3, k)
            self.assertTrue(1.0 <= seat[1] <= 1.8, (k, seat))         # a seated eye
            for key in ("backMul", "upMul", "sideMul", "fovSpeedKick", "roll"):
                self.assertIn(key, row, (k, key))
        for k in ("bus", "tram", "metro", "rail", "waterbus"):
            self.assertAlmostEqual(self.o["rows"][k]["fpAnchor"]["seat"][1], 0.45 + 1.15, places=6)   # over the floor centre
            self.assertLess(self.o["rows"][k]["fpAnchor"]["seat"][0], 0)                             # the pavement (right) side

    def test_passenger_fp_and_chase(self):
        f = self.o["fp"]
        for a in "xyz":
            self.assertAlmostEqual(f["pos"][a], f["want"][a], places=6)
        self.assertTrue(f["hide"])
        c = self.o["chase"]
        self.assertGreater(c["bus"], c["car"])
        self.assertGreater(c["tram"], c["bus"])

    def face(self, r, h=1.25):
        t = r["t"]
        return {"x": t["x"], "y": t["y"] + h, "z": t["z"]}

    def test_selfie_at_arms_length_facing_the_face(self):
        for key in ("still", "calm", "live"):
            r = self.o["selfie"][key]
            self.assertEqual(r["mode"], "selfie")
            p, f = r["a"], self.face(r)
            d = math.dist([p["pos"][a] for a in "xyz"], [f[a] for a in "xyz"])
            self.assertTrue(1.95 <= d <= 2.1, (key, d))   # the characters have big heads: 0.65 m was inside the cap
            for a in "xyz":
                self.assertAlmostEqual(p["look"][a], f[a], places=6)
            # in front of the avatar: along its facing (sin yaw, cos yaw)
            yaw = r["t"]["yaw"]
            ahead = (p["pos"]["x"] - f["x"]) * math.sin(yaw) + (p["pos"]["z"] - f["z"]) * math.cos(yaw)
            self.assertGreater(ahead, 1.9, key)
            self.assertFalse(p["hideAvatar"])
            self.assertFalse(p["hud"])

    def test_selfie_level_and_still_under_calm(self):
        for key in ("still", "calm"):
            r = self.o["selfie"][key]
            self.assertEqual(r["a"]["roll"], 0)
            self.assertEqual(r["a"]["up"], {"x": 0, "y": 1, "z": 0})
            self.assertEqual(r["a"]["pos"], r["b"]["pos"])
        live = self.o["selfie"]["live"]
        self.assertNotEqual(live["a"]["pos"], live["b"]["pos"])           # a slight hand sway otherwise
        self.assertLess(abs(live["a"]["roll"]), 0.03)
        s = self.o["selfie"]["seated"]
        self.assertAlmostEqual(s["a"]["look"]["y"], s["t"]["y"] + 1.1, places=6)

    def test_selfie_look_swings_round_the_face_and_is_not_in_the_cycle(self):
        t = self.o["selfie"]["turned"]
        self.assertGreater(abs(t["pos"]["x"]), 0.3)                      # swung round (capped at 0.7 rad)
        self.assertLess(abs(math.atan2(t["pos"]["x"], t["pos"]["z"])), 0.7 + 0.2)
        self.assertEqual(self.o["selfie"]["inOrder"], -1)
        self.assertNotEqual(self.o["cycleFrom"], "selfie")


if __name__ == "__main__":
    unittest.main()
