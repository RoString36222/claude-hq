/* Claude HQ: helicopters (HQV.hqheli): a civilian helicopter and an attack helicopter you can fly.
 *
 * The physics is pure, so tests/test_hqheli.py runs it under node: no THREE, no DOM, no clock.
 *   VEHICLES        how each one flies, the same shape as games/hq3d.js VEHICLES (top, acc, lean, box)
 *                   plus the flight model: climb/sink (m/s), yawR (rad/s), tilt (rad at full stick), the
 *                   springs (tiltW, yawW, vW), side (sideways drag, 1/s), ceil (m).
 *   newState(kind, x, y, z, yaw)      parked on the ground at (x, y, z), rotors still
 *   step(st, inp, dt, env) -> events  fixed 1/120 s sub-steps (the remainder carried to the next call), so the
 *                   same inputs give the same flight at 30 Hz and at 120 Hz.
 *   model(c, kind, color, accent)     the meshes, from the hq3d ctx `c` (THREE, mat, glow); forward is +z
 *   animate(B, st, dt, night)         rotors (a blur disc as they spin up), nav lights, strobe, searchlight
 * inp = {fwd: -1..1 (W +: nose down, fly forward), turn: -1..1 (A +: yaw left), lift: -1..1 (Space +, Shift -),
 *        on: bool (the engine; default true)}.
 * env = {floor(x, z) -> m: the surface under a point (terrain, a roof, the sea), wall(x, z, y) -> bool (optional:
 *        something solid at that height)}.
 * The flight: the rotor spools up (spool s) before it lifts; with no input it holds its height (the climb rate
 * springs to 0); the stick tilts the disc and the tilt drives you along the heading against a linear drag (top
 * speed `top`); sideways speed dies away (side), so a turn carves; near the ground the sink rate is cut (ground
 * effect: a soft landing); below LAND m/s across the ground it settles onto its skids. Hitting anything higher
 * than the step you are at stops you (a "bump"); the ceiling is ceil m. Frames as the 3D city's: metres, yaw 0
 * faces +z, model-local +x is LEFT, pitch positive = nose up, roll positive = right side down.
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};
var PI = Math.PI;

var VEHICLES = {
  heli:   {top: 45, acc: 7.5, rev: 0, lean: 0, box: [1.1, 5], heli: true, eng: "rotor", reach: 4.5,
           climb: 9, sink: 7, yawR: 1.25, tilt: 0.3, tiltW: 4, yawW: 4, vW: 2.4, side: 1.5, ceil: 800, spool: 1.6, rotorR: 5.4},
  attack: {top: 50, acc: 9.5, rev: 0, lean: 0, box: [1.4, 6], heli: true, eng: "rotor", reach: 5,
           climb: 10, sink: 8, yawR: 1.7, tilt: 0.38, tiltW: 6, yawW: 6, vW: 3.2, side: 2.2, ceil: 800, spool: 1.2, rotorR: 6}
};
var KINDS = ["heli", "attack"];
var H = 1/120;           // the sub-step (s)
var STEP = 0.6;          // m: a rise in the surface under you bigger than this (over your skids) is a wall
var LAND = 6;            // m/s: across the ground slower than this, touching down settles you on the skids
var HARD = 4;            // m/s: a touchdown sinking faster than this is a hard landing
var GE = 6;              // m: ground effect below this height

function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function wrapPi(a){ a = +a || 0; return Math.atan2(Math.sin(a), Math.cos(a)); }
function ease(k, dt){ return 1 - Math.exp(-Math.max(0, +k || 0)*Math.max(0, +dt || 0)); }
function spring(x, v, goal, omega, dt){
  var c1 = x - goal, c2 = v + omega*c1, e = Math.exp(-omega*dt);
  return [goal + (c1 + c2*dt)*e, (c2 - omega*(c1 + c2*dt))*e];
}
function drag(v0, f, k, dt){ var vi = f/k, e = Math.exp(-k*dt); return vi + (v0 - vi)*e; }
function zero(){ return 0; }

function newState(kind, x, y, z, yaw){
  kind = VEHICLES[kind] ? kind : "heli";
  return {kind: kind, x: +x || 0, y: +y || 0, z: +z || 0, yaw: wrapPi(yaw), vx: 0, vy: 0, vz: 0, speed: 0,
          pitch: 0, pV: 0, roll: 0, rV: 0, rate: 0, rateV: 0, rpm: 0, ground: true, agl: 0, acc: 0, t: 0, bumpT: 0};
}

// one step of dt: whole sub-steps; -> events [{type: "takeoff"}, {type: "land", hard, v}, {type: "bump"}, {type: "ceiling"}]
function step(st, inp, dt, env){
  var ev = []; dt = Math.max(0, Math.min(0.25, +dt || 0));
  st.acc += dt;
  while(st.acc >= H - 1e-9){ st.acc -= H; sub(st, inp || {}, env || {}, ev); }
  return ev;
}
function sub(st, inp, env, ev){
  var V = VEHICLES[st.kind] || VEHICLES.heli, h = H, floor = typeof env.floor === "function" ? env.floor : zero;
  var fwd = clamp(+inp.fwd || 0, -1, 1), turn = clamp(+inp.turn || 0, -1, 1), lift = clamp(+inp.lift || 0, -1, 1), on = inp.on !== false;
  st.t += h; st.bumpT = Math.max(0, st.bumpT - h);
  st.rpm = clamp(st.rpm + (on ? h/V.spool : -h/(V.spool*2.5)), 0, 1);
  var power = clamp((st.rpm - 0.55)/0.4, 0, 1);
  var f0 = floor(st.x, st.z);
  if(st.ground){
    st.y = f0; st.vx = st.vz = st.vy = 0; st.rate = 0; st.rateV = 0; st.speed = 0; st.agl = 0;
    var p = spring(st.pitch, st.pV, 0, 8, h), r = spring(st.roll, st.rV, 0, 8, h);
    st.pitch = p[0]; st.pV = p[1]; st.roll = r[0]; st.rV = r[1];
    if(lift > 0 && power >= 1){ st.ground = false; st.vy = 0.5; ev.push({type: "takeoff"}); }
    return;
  }
  // the yaw: a spring on the rate; the disc's tilt: springs on pitch and roll
  var rs = spring(st.rate, st.rateV, turn*V.yawR*power, V.yawW, h);
  st.rate = rs[0]; st.rateV = rs[1]; st.yaw = wrapPi(st.yaw + st.rate*h);
  var hs = Math.hypot(st.vx, st.vz), sl = clamp(hs/V.top, 0, 1);
  var pg = spring(st.pitch, st.pV, -fwd*V.tilt*power, V.tiltW, h), rg = spring(st.roll, st.rV, -st.rate*0.35*(0.3 + sl), V.tiltW, h);
  st.pitch = pg[0]; st.pV = pg[1]; st.roll = rg[0]; st.rV = rg[1];
  // along the heading: the disc's tilt pulls (nose down: forward), linear drag caps it at top; sideways speed dies away
  var sy = Math.sin(st.yaw), cy = Math.cos(st.yaw), vF = st.vx*sy + st.vz*cy, vS = st.vx*cy - st.vz*sy;
  var k = V.acc/V.top, aF = -Math.sin(st.pitch)/Math.sin(V.tilt)*V.acc;
  vF = drag(vF, aF, k, h); vS = vS*Math.exp(-V.side*h);
  st.vx = vF*sy + vS*cy; st.vz = vF*cy - vS*sy;
  // up and down: the climb rate springs to what the collective asks (0: hold the height)
  var agl = st.y - f0, goal = lift > 0 ? lift*V.climb : lift*V.sink;
  if(goal < 0 && agl < GE) goal = Math.max(goal, -(0.7 + agl*0.8));          // ground effect: a cushion under you
  if(st.y > V.ceil - 60) goal = Math.min(goal, (V.ceil - st.y)*0.15);
  goal = goal*power - (1 - power)*5;                                         // no lift: down you come
  st.vy += (goal - st.vy)*ease(V.vW, h);
  // the move, and what is in the way
  var nx = st.x + st.vx*h, nz = st.z + st.vz*h, ny = st.y + st.vy*h, fn = floor(nx, nz);
  var wall = fn - ny > STEP || (typeof env.wall === "function" && env.wall(nx, nz, ny + 0.5));
  if(wall){
    nx = st.x; nz = st.z; st.vx *= -0.2; st.vz *= -0.2; fn = f0;
    if(st.bumpT <= 0){ ev.push({type: "bump"}); st.bumpT = 0.5; }
  }
  if(ny > V.ceil){ ny = V.ceil; if(st.vy > 0){ st.vy = 0; ev.push({type: "ceiling"}); } }
  st.x = nx; st.z = nz; st.y = ny;
  if(st.y <= fn){
    var vy = st.vy; st.y = fn; st.vy = Math.max(0, st.vy);
    var hv = Math.hypot(st.vx, st.vz);
    if(lift <= 0 && hv < LAND){
      st.ground = true; st.vx = st.vz = st.vy = 0; st.rate = 0; st.rateV = 0;
      ev.push({type: "land", hard: vy < -HARD, v: vy});
    } else if(lift < 0){ var fr = Math.exp(-2.5*h); st.vx *= fr; st.vz *= fr; }   // set down at speed: the skids drag
    // (else skimming: the rising ground lifts you, it does not stop you)
  }
  st.speed = Math.hypot(st.vx, st.vz); st.agl = st.y - floor(st.x, st.z);
}

/* ---------- the meshes (THREE only from here on) ---------- */
// {g, kind, seat, grips, feet, lean, rotor, blades, disc, tail, tailDisc, lights, beam, setNight}; g's origin is
// the ground under the skids' middle.
function model(c, kind, color, accent){
  var THREE = c.THREE, g = new THREE.Group(), atk = kind === "attack";
  var paint = c.mat(color == null ? (atk ? 0x4a5641 : 0x1f4e8c) : color, {roughness: 0.45, metalness: 0.25});
  var acc = c.mat(accent == null ? (atk ? 0x2d342a : 0xf2f2f2) : accent, {roughness: 0.5, metalness: 0.2});
  var dark = c.mat(0x1d2126, {roughness: 0.7, metalness: 0.4}), steel = c.mat(0x9aa3ad, {roughness: 0.35, metalness: 0.8});
  var glass = new THREE.MeshStandardMaterial({color: 0x9fd2ff, roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.38, depthWrite: false});
  var cabin = new THREE.MeshBasicMaterial({color: 0xffd9a0, toneMapped: false});
  function mesh(geo, m, x, y, z, p){ var o = new THREE.Mesh(geo, m); o.position.set(x || 0, y || 0, z || 0); o.castShadow = true; (p || g).add(o); return o; }
  function box(w, h, d, m, x, y, z, p){ return mesh(new THREE.BoxGeometry(w, h, d), m, x, y, z, p); }
  function cyl(rt, rb, len, m, x, y, z, p, seg){ return mesh(new THREE.CylinderGeometry(rt, rb, len, seg || 12), m, x, y, z, p); }
  function anchor(p, x, y, z){ var o = new THREE.Object3D(); o.position.set(x, y, z); p.add(o); return o; }
  function light(col, x, y, z, s){ var o = c.glow ? c.glow(col, s || 1.2, 0.95) : new THREE.Object3D(); o.position.set(x, y, z); g.add(o); return o; }
  g.name = atk ? "attack-heli" : "heli";
  var bodyY = atk ? 1.75 : 1.65, R = VEHICLES[atk ? "attack" : "heli"].rotorR;
  if(atk){
    // narrow tandem fuselage, stepped canopies, stub wings with pods, a chin gun
    var fb = mesh(new THREE.SphereGeometry(1, 18, 12), paint, 0, bodyY, 0.6); fb.scale.set(0.85, 0.95, 3.1);
    box(1.3, 1.1, 2.4, paint, 0, bodyY + 0.15, -1.2);
    var c1 = mesh(new THREE.SphereGeometry(1, 14, 10, 0, PI*2, 0, PI/2), glass, 0, bodyY + 0.35, 2.2); c1.scale.set(0.62, 0.7, 1.0);
    var c2 = mesh(new THREE.SphereGeometry(1, 14, 10, 0, PI*2, 0, PI/2), glass, 0, bodyY + 0.6, 0.9); c2.scale.set(0.66, 0.8, 1.1);
    box(0.5, 0.25, 0.9, cabin, 0, bodyY + 0.42, 0.9).material = new THREE.MeshBasicMaterial({color: 0x7dd3a0, toneMapped: false});   // the cockpit's displays
    [1, -1].forEach(function(s){
      box(2.2, 0.12, 0.9, paint, s*1.7, bodyY + 0.1, -0.2);
      cyl(0.22, 0.22, 1.5, dark, s*2.3, bodyY - 0.2, -0.2, null, 10).rotation.x = PI/2;
      cyl(0.18, 0.18, 1.2, dark, s*1.45, bodyY - 0.15, -0.2, null, 10).rotation.x = PI/2;
      box(0.55, 0.8, 1.6, acc, s*0.85, bodyY + 0.75, -0.9);                 // the engine nacelles
    });
    var gun = cyl(0.06, 0.06, 1.3, dark, 0, bodyY - 0.85, 2.3, null, 6); gun.rotation.x = PI/2;
    cyl(0.18, 0.2, 0.3, dark, 0, bodyY - 0.75, 1.8, null, 8);
    // wheels, not skids
    [[0.9, 1.2], [-0.9, 1.2], [0, -6.4]].forEach(function(q){ cyl(0.05, 0.05, bodyY - 0.6, steel, q[0], (bodyY - 0.6)/2 + 0.3, q[1], null, 6);
      var w = cyl(0.3, 0.3, 0.18, dark, q[0], 0.3, q[1], null, 12); w.rotation.z = PI/2; });
  } else {
    // a sleek civilian: a rounded cabin, a big glass nose, a slim boom
    var b = mesh(new THREE.SphereGeometry(1, 22, 14), paint, 0, bodyY, 0.3); b.scale.set(1.15, 1.05, 2.45);
    box(1.9, 0.08, 3.6, acc, 0, bodyY - 0.25, 0.2).scale.x = 1.02;                  // the cheat line
    var nose = mesh(new THREE.SphereGeometry(1, 18, 12, 0, PI*2, 0, PI*0.62), glass, 0, bodyY + 0.05, 1.35); nose.scale.set(1.0, 0.95, 1.3); nose.rotation.x = PI/2*0.9;
    var lit = box(1.6, 0.7, 1.9, cabin, 0, bodyY + 0.05, 0.3); lit.castShadow = false; lit.scale.set(0.98, 1, 1);
    [1, -1].forEach(function(s){ var wdw = box(0.04, 0.55, 1.4, glass, s*1.13, bodyY + 0.18, -0.3); wdw.renderOrder = 2; });
    box(0.9, 0.5, 1.6, acc, 0, bodyY + 0.95, -0.6);                                  // the engine fairing
    // skids: two tubes on bent struts
    [1, -1].forEach(function(s){
      var sk = cyl(0.07, 0.07, 3.6, steel, s*1.05, 0.08, 0.3, null, 8); sk.rotation.x = PI/2;
      var tip = cyl(0.07, 0.07, 0.5, steel, s*1.05, 0.2, 2.25, null, 8); tip.rotation.x = PI/2 - 0.6;
      [-0.6, 1.2].forEach(function(z){ var st = cyl(0.06, 0.06, 1.0, steel, s*0.9, 0.55, z, null, 6); st.rotation.z = s*0.35; });
    });
  }
  // the tail boom, the fin, the stabiliser
  var boomL = atk ? 5.4 : 5.2, bz0 = atk ? -2.3 : -1.6, boom = cyl(0.16, atk ? 0.42 : 0.38, boomL, paint, 0, bodyY + 0.35, bz0 - boomL/2, null, 12);
  boom.rotation.x = -PI/2;
  var tz = bz0 - boomL;
  box(0.12, 1.5, 0.9, paint, 0, bodyY + 1.0, tz + 0.2).rotation.x = -0.3;
  box(2.0, 0.08, 0.6, paint, 0, bodyY + 0.4, tz + 1.0);
  // the main rotor: mast, hub, blades, and a blur disc that shows as it spins up
  var rotor = new THREE.Group(); rotor.position.set(0, bodyY + (atk ? 1.55 : 1.45), atk ? -0.4 : -0.1); g.add(rotor);
  cyl(0.12, 0.12, 0.6, dark, 0, -0.3, 0, rotor, 8);
  cyl(0.3, 0.3, 0.18, dark, 0, 0, 0, rotor, 10);
  var blades = new THREE.Group(); rotor.add(blades);
  var nb = atk ? 4 : 5, bm = c.mat(0x2a2f35, {roughness: 0.6});
  for(var i = 0; i < nb; i++){ var bl = box(R, 0.05, 0.32, bm, R/2, 0.04, 0, null); blades.remove(bl); g.remove(bl);
    var arm = new THREE.Group(); arm.rotation.y = i*PI*2/nb; arm.add(bl); blades.add(arm); }
  var discM = new THREE.MeshBasicMaterial({color: 0x30363c, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide});
  var disc = new THREE.Mesh(new THREE.RingGeometry(0.4, R, 40, 1), discM); disc.rotation.x = -PI/2; disc.position.y = 0.05; rotor.add(disc);
  // the tail rotor
  var tail = new THREE.Group(); tail.position.set(atk ? -0.18 : 0.18, bodyY + 1.0, tz + 0.1); g.add(tail);
  var tblades = new THREE.Group(); tail.add(tblades);
  for(var j = 0; j < 2; j++){ var tb = new THREE.Mesh(new THREE.BoxGeometry(0.04, 1.5, 0.16), bm); tb.rotation.x = j*PI/2; tblades.add(tb); }
  var tdisc = new THREE.Mesh(new THREE.CircleGeometry(0.78, 20), discM.clone()); tdisc.rotation.y = PI/2; tail.add(tdisc);
  // nav lights: red on the left (+x), green on the right, white on the tail; a red strobe on top
  var lights = {red: light(0xff3030, 1.2, bodyY, 0.2), green: light(0x30ff60, -1.2, bodyY, 0.2), white: light(0xffffff, 0, bodyY + 0.6, tz - 0.2, 0.9),
                strobe: light(0xff2020, 0, bodyY + 1.25, -1.2, 2.2)};
  if(atk){ lights.red.position.x = 2.8; lights.green.position.x = -2.8; }
  // the searchlight: a lamp under the nose and a faint cone of light ahead and down (no real light: no shader rebuilds)
  var beam = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 9, 60, 20, 1, true),
    new THREE.MeshBasicMaterial({color: 0xfff1d0, transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false}));
  beam.geometry.translate(0, -30, 0); beam.position.set(0, bodyY - 0.7, atk ? 2.0 : 1.6); beam.rotation.x = -0.75; beam.visible = false; g.add(beam);
  var lamp = light(0xfff4dd, 0, bodyY - 0.75, atk ? 2.0 : 1.7, 1.6); lamp.visible = false;
  var B = {g: g, kind: atk ? "attack" : "heli", seat: anchor(g, atk ? 0 : -0.4, bodyY - 0.55, atk ? 2.0 : 0.85),
           grips: [anchor(g, atk ? 0.15 : -0.25, bodyY - 0.2, atk ? 2.45 : 1.25), anchor(g, atk ? -0.15 : -0.55, bodyY - 0.2, atk ? 2.45 : 1.25)],
           feet: [anchor(g, atk ? 0.2 : -0.25, bodyY - 0.85, atk ? 2.75 : 1.65), anchor(g, atk ? -0.2 : -0.55, bodyY - 0.85, atk ? 2.75 : 1.65)],
           lean: 0, riderK: 0.85, hats: false, rotor: rotor, blades: blades, disc: disc, tail: tblades, tailDisc: tdisc, lights: lights, beam: beam, lamp: lamp,
           phase: 0, tphase: 0, night: false, brake: function(){}};
  B.setNight = function(n){ B.night = !!n; };
  return B;
}
// Spins the rotors with the state's rpm (a parked one: rpm 0; st may be null: idle at rpm `idle`), blurs them into a
// disc at speed, blinks the strobe, lights the searchlight at night while flying.
function animate(B, st, dt, night, idle){
  if(!B) return;
  dt = Math.max(0, +dt || 0);
  var rpm = st ? st.rpm : (+idle || 0);
  B.phase = (B.phase + dt*rpm*32) % (PI*2); B.tphase = (B.tphase + dt*rpm*90) % (PI*2);
  B.blades.rotation.y = B.phase; B.tail.rotation.x = B.tphase;
  var blur = clamp((rpm - 0.35)/0.5, 0, 1);
  B.disc.material.opacity = 0.32*blur; B.tailDisc.material.opacity = 0.3*blur;
  B.blades.visible = blur < 0.98 || ((B.phase*7) % 1) < 0.35;          // a flicker of the blades through the blur
  var t = st ? st.t : 0, on = rpm > 0.05;
  B.lights.strobe.visible = on && (t % 1.2) < 0.08;
  B.lights.red.visible = B.lights.green.visible = B.lights.white.visible = on || !!night;
  var sl = !!(night && st && !st.ground && rpm > 0.5);
  B.beam.visible = sl; B.lamp.visible = sl;
}

HQV.hqheli = {VEHICLES: VEHICLES, KINDS: KINDS, H: H, STEP: STEP, LAND: LAND, HARD: HARD,
              newState: newState, step: step, model: model, animate: animate, spring: spring, ease: ease};
})();
