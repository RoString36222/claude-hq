/* games/hqtank.js: the tank in the 3D City (HQ 3.16), HQV.hqTank.
 *
 * K (on foot) rolls your tank up beside you, K again sends it away; E beside it gets you in, as its driver. It is
 * slow, heavy and turns on the spot (pivot steering: A / D with no throttle). It seats four: you drive (seat 0), and
 * while you drive three others climb in with E beside it, through carpooling (HQ 3.15, games/hqdrive.js poolSeats:
 * a tank seats four; presence pb / ps). Seat 1 is the gunner's: the turret goes where their camera looks and F or a
 * captured click fires a shell (games/hqgrenade.js kind 1); seats 2 and 3 ride on the back deck.
 *
 * Over presence the gunner adds their aim (`ta`: [turret yaw from the hull, barrel pitch], whole degrees) beside their
 * carpool seat, and every page draws the turret at it; the Arena (backend/src/valley/hq.rs) checks the numbers. Only
 * numbers travel; nothing transcript-derived.
 *
 * The driving step and the aim's forms are pure (tests/test_hqtank.py runs them under node); model() builds an
 * original stand-in tank with three.js, its passenger seats named a-seat-1..3 for carpool's poolSpot.
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};

var TOP = 11, REV = 5, ACC = 3.5, BRAKE = 8;   // m/s, m/s backwards, m/s² pulling away, braking (or no throttle)
var TURN = 0.9, TURN_FAST = 0.5;               // rad/s: on the spot, at full speed
var HALF_L = 3.3, HALF_W = 1.7;                // the hull's footprint (m): what bumps into walls
var REACH = 4.6;                               // m from its middle: close enough to climb in
var SHELL_COOL = 2.5;                          // s between shells
// the barrel's range (degrees above the hull's level; the Arena takes -15..60) and how far the turret turns (all round)
var AIM = {pitchMin: -8, pitchMax: 40};

function num(v, d){ v = +v; return isFinite(v) ? v : d; }
function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }
function wrap(a){ a = num(a, 0); return Math.atan2(Math.sin(a), Math.cos(a)); }

function newState(x, z, yaw){ return {x: num(x, 0), z: num(z, 0), yaw: wrap(yaw), speed: 0, rate: 0, trk: [0, 0]}; }

// A point of the hull's footprint in the world: lx to its left (+), lz forward (+).
function toWorld(x, z, yaw, lx, lz){ var s = Math.sin(yaw), c = Math.cos(yaw); return {x: x + lx*c + lz*s, z: z - lx*s + lz*c}; }
// Does the footprint at (x, z, yaw) touch anything blocked? Its corners and the middle of each side.
function hits(env, x, z, yaw){
  if(!env || !env.blocked) return false;
  var P = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
  for(var i = 0; i < P.length; i++){ var p = toWorld(x, z, yaw, P[i][0]*HALF_W, P[i][1]*HALF_L); if(env.blocked(p.x, p.z)) return true; }
  return false;
}
// One step of driving. inp: {fwd: -1..1 (W +), turn: -1..1 (A +, left)}; env: {blocked(x, z)}. The speed springs
// toward the throttle's (pulling away gently, braking hard); the turn rate toward A / D's, fastest standing still.
// A footprint that would touch something stops it (it may still turn there if that is clear). Already stuck: any
// move is allowed, so you can always drive out. -> events: [{type: "bump"}]
function step(st, inp, dt, env){
  inp = inp || {}; dt = Math.max(0, num(dt, 0));
  var fwd = clamp(num(inp.fwd, 0), -1, 1), turn = clamp(num(inp.turn, 0), -1, 1), ev = [];
  var goal = fwd > 0 ? fwd*TOP : fwd*REV, a = goal === 0 || goal*st.speed < 0 ? BRAKE : ACC;
  st.speed += clamp(goal - st.speed, -a*dt, a*dt);
  var rgoal = turn*(TURN + (TURN_FAST - TURN)*Math.min(1, Math.abs(st.speed)/TOP));
  st.rate += (rgoal - st.rate)*(1 - Math.exp(-6*dt));
  var ny = wrap(st.yaw + st.rate*dt), nx = st.x + Math.sin(ny)*st.speed*dt, nz = st.z + Math.cos(ny)*st.speed*dt;
  var stuck = hits(env, st.x, st.z, st.yaw);
  if(!stuck && hits(env, nx, nz, ny)){
    if(!hits(env, st.x, st.z, ny)) st.yaw = ny; else st.rate = 0;
    if(Math.abs(st.speed) > 1) ev.push({type: "bump"});
    st.speed = 0;
  } else { st.x = nx; st.z = nz; st.yaw = ny; }
  // how far each tread has run (left, right): its wheels turn by it; a turn on the spot runs them opposite ways
  st.trk[0] += (st.speed - st.rate*HALF_W)*dt; st.trk[1] += (st.speed + st.rate*HALF_W)*dt;
  return ev;
}
// Somewhere it fits, beside (x, z, yaw): 6 m to your right, your left, ahead, behind. -> {x, z, yaw} or null
function spot(x, z, yaw, env){
  var C = [[-6, 0], [6, 0], [0, 7], [0, -7], [-9, 0], [9, 0]];
  for(var i = 0; i < C.length; i++){ var p = toWorld(x, z, yaw, C[i][0], C[i][1]); if(!hits(env, p.x, p.z, yaw)) return {x: p.x, z: p.z, yaw: wrap(yaw)}; }
  return null;
}

/* ---------- presence forms ---------- */
// the turret's aim (rad: yaw from the hull, pitch) as whole degrees inside the Arena's bounds, and back
function taWire(yaw, pitch){
  return [clamp(Math.round(wrap(yaw)*180/Math.PI), -180, 180), clamp(Math.round(num(pitch, 0)*180/Math.PI), AIM.pitchMin, AIM.pitchMax)];
}
function taFrom(a){
  if(!Array.isArray(a) || a.length !== 2 || a[0] !== (a[0] | 0) || a[1] !== (a[1] | 0) || Math.abs(a[0]) > 180 || a[1] < -15 || a[1] > 60) return null;
  return {yaw: a[0]*Math.PI/180, pitch: clamp(a[1], AIM.pitchMin, AIM.pitchMax)*Math.PI/180};
}
// The gunner's aim from where their camera looks (fwd, a direction) and the hull's yaw: the turret's yaw from the hull
// and the barrel's pitch, lifted a little (a chase camera looks down at the tank), within AIM.
function aimFrom(fwd, hullYaw){
  fwd = fwd || {};
  var fx = num(fwd.x, 0), fy = num(fwd.y, 0), fz = num(fwd.z, 1), h = Math.hypot(fx, fz), l = Math.hypot(h, fy) || 1;
  return {yaw: wrap((h > 1e-9 ? Math.atan2(fx, fz) : 0) - num(hullYaw, 0)),
          pitch: clamp(Math.asin(clamp(fy/l, -1, 1)) + 0.3, AIM.pitchMin*Math.PI/180, AIM.pitchMax*Math.PI/180)};
}

/* ---------- the model (three.js) ---------- */
// An original stand-in: a long hull between two treads on six road wheels a side, a sloped glacis, a faceted turret
// a little behind the middle with a long barrel and a muzzle brake, hatches, stowage, and four seat anchors (the
// driver's hatch front left, the commander's hatch on top of the turret's pivot, two on the back deck). In metres,
// +z forward. color: the hull's paint. -> {g, turret, barrel, muzzle, seats[4], seat, wheels: [left[], right[]], dispose}
function model(T, color){
  var mats = [], geos = [];
  function toon(c){ var m = new T.MeshToonMaterial({color: c}); mats.push(m); return m; }
  var paint = toon(color != null ? color : 0x6b7a3c), dark = toon(0x2a2d24), steel = toon(0x8a8f86), trim = toon(0xc9b37a);
  var g = new T.Group(), hull = new T.Group(); g.add(hull);
  function mesh(geo, m, x, y, z, par){ geos.push(geo); var o = new T.Mesh(geo, m); o.position.set(x, y, z); o.castShadow = true; (par || hull).add(o); return o; }
  function box(w, h, d, m, x, y, z, par){ return mesh(new T.BoxGeometry(w, h, d), m, x, y, z, par); }
  function cylZ(r, l, m, x, y, z, par, seg){ var o = mesh(new T.CylinderGeometry(r, r, l, seg || 14), m, x, y, z, par); o.rotation.x = Math.PI/2; return o; }
  function cylX(r, l, m, x, y, z, par){ var o = mesh(new T.CylinderGeometry(r, r, l, 14), m, x, y, z, par); o.rotation.z = Math.PI/2; return o; }
  // the treads and their wheels
  var wheels = [[], []];
  [1, -1].forEach(function(sd, k){
    var x = sd*1.35;
    box(0.72, 0.95, 6.9, dark, x, 0.55, 0);
    box(0.8, 0.12, 6.4, paint, x, 1.06, 0.1);                     // the side skirt over it
    for(var i = 0; i < 6; i++){ var wv = cylX(0.36, 0.2, steel, x + sd*0.37, 0.48, -2.6 + i*1.04); wheels[k].push(wv); }
    cylX(0.3, 0.2, steel, x + sd*0.37, 0.72, 3.15); cylX(0.3, 0.2, steel, x + sd*0.37, 0.72, -3.15);   // drive and idler
  });
  // the hull: a body between the treads, its glacis sloping up at the front, the engine deck at the back
  box(2.0, 0.85, 6.2, paint, 0, 0.95, -0.1);
  box(3.3, 0.35, 5.4, paint, 0, 1.4, -0.3);
  var gl = box(3.3, 0.35, 1.5, paint, 0, 1.22, 2.95); gl.rotation.x = 0.42;
  box(2.6, 0.1, 1.6, dark, 0, 1.61, -2.4);                          // the engine grille
  box(0.5, 0.35, 0.9, trim, 1.45, 1.75, -2.9); box(0.5, 0.35, 0.9, trim, -1.45, 1.75, -2.9);   // stowage boxes
  cylZ(0.18, 0.12, dark, 0.75, 1.62, 2.05, hull, 12);               // the driver's hatch ring
  // the turret: its own group (it turns), the barrel its own (it lifts)
  var turret = new T.Group(); turret.position.set(0, 1.58, -0.35); hull.add(turret);
  var tb = mesh(new T.CylinderGeometry(1.15, 1.35, 0.72, 8), paint, 0, 0.36, 0, turret);
  tb.rotation.y = Math.PI/8;
  box(1.5, 0.55, 0.7, paint, 0, 0.38, 1.25, turret);                // the mantlet
  cylZ(0.42, 0.14, dark, 0, 0.78, 0, turret, 16);                   // the commander's hatch on the pivot
  box(0.9, 0.3, 0.6, trim, 0, 0.5, -1.2, turret);                   // the bustle rack
  var barrel = new T.Group(); barrel.position.set(0, 0.4, 1.55); turret.add(barrel);
  cylZ(0.13, 3.6, steel, 0, 0, 1.8, barrel);
  cylZ(0.2, 0.45, dark, 0, 0, 3.55, barrel);                        // the muzzle brake
  var muzzle = new T.Object3D(); muzzle.position.set(0, 0, 3.85); barrel.add(muzzle);
  // the seats: where each sits (hips), in g's frame: the hatches are at the hull's / the pivot's height, so the
  // driver and the gunner stand in them (their legs inside), the riders sit on the deck
  var seats = [[0.75, 1.55, 2.05], [0, 2.2, -0.35], [0.85, 1.95, -2.45], [-0.85, 1.95, -2.45]].map(function(p, i){
    var o = new T.Object3D(); o.position.set(p[0], p[1], p[2]); if(i) o.name = "a-seat-" + i; g.add(o); return o;   // carpool's poolSpot finds 1-3 by name
  });
  return {g: g, hull: hull, turret: turret, barrel: barrel, muzzle: muzzle, seats: seats, seat: seats[0], wheels: wheels, hats: true,
          dispose: function(){ geos.forEach(function(x){ x.dispose(); }); mats.forEach(function(x){ x.dispose(); }); }};
}
// Each frame: the wheels by how far each tread ran, the turret and the barrel at the aim ({yaw, pitch}, rad).
function animate(B, st, aim){
  if(!B) return;
  if(st && st.trk) B.wheels.forEach(function(side, k){ var a = -num(st.trk[k], 0)/0.36; side.forEach(function(w){ w.rotation.x = a; }); });
  aim = aim || {yaw: 0, pitch: 0};
  B.turret.rotation.y = num(aim.yaw, 0);
  B.barrel.rotation.x = -num(aim.pitch, 0);       // the barrel lies along +z: a negative turn about x lifts its end
}

HQV.hqTank = {TOP: TOP, REV: REV, TURN: TURN, HALF_L: HALF_L, HALF_W: HALF_W, REACH: REACH, SHELL_COOL: SHELL_COOL, AIM: AIM,
              newState: newState, step: step, hits: hits, spot: spot, toWorld: toWorld,
              taWire: taWire, taFrom: taFrom, aimFrom: aimFrom, model: model, animate: animate};
})();
