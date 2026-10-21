/* Claude HQ: aircraft you fly (HQV.hqplane, HQ 3.2): a seaplane (the twin on floats of games/hqaircraft.js) and a small
 * prop plane (hqaircraft propPlane), registered into games/hq3d.js VEHICLES as the helicopters are (games/hqheli.js).
 *
 * The physics is pure, so tests/test_hqplane.py runs it under node: no THREE, no DOM, no clock.
 *   VEHICLES        how each one flies, the shape of hq3d's VEHICLES (top, acc, lean, box, reach) plus the flight model
 *   newState(kind, x, y, z, yaw)     at rest on its surface (water for the seaplane), engine idle, throttle 0
 *   step(st, inp, dt, env) -> events fixed 1/120 s sub-steps (the remainder carried), so the same inputs fly the same
 *                   at any frame rate. events: [{type: "takeoff"}, {type: "land", hard, water}, {type: "stall"},
 *                   {type: "crash", why}, {type: "splash"}]
 *   model(c, kind, color, accent)    the meshes (hqaircraft's), with the pilot's seat, yoke and pedals for hq3d's rider
 *   animate(B, st, dt, night)        the propellers (a blur as they spin up), the gear, the lights
 *   autopilot(st, ap) -> {pitch, roll} inputs that hold ap.alt (m) and fly ap.hdg (rad) (or toward ap.to {x, z})
 * inp = {thr: -1..1 (W +: more throttle, S -: less; on the ground at idle S is the brake), pitch: -1..1 (Up +: nose up),
 *        roll: -1..1 (A +: bank / steer left), brake: bool (Space), assist: bool (default true)}.
 * env = {floor(x, z) -> m: what is under a point (terrain, roofs, a deck), water(x, z) -> bool (open water),
 *        waterY(x, z) -> m (the water's surface there: the boats' and ferries' own function, games/ocean.js
 *        surface), runway(x, z) -> bool (a runway or an apron: anything paved and long enough to land on)}.
 * The model, arcade but plausible: a throttle you set (W / S move it), thrust against drag that caps the speed at `top`,
 * lift that grows with the square of the airspeed (full at 1.15 stall, none under 0.85 stall), so below `stall` the
 * nose drops gently and the plane sinks until it has the speed back (never a spin); the flight path follows the
 * nose as lift allows; bank turns it (coordinated: yaw rate g sin(bank) / v); ground effect within GE m cushions the
 * sink. Assisted (default): A / D bank up to rollMax and the wings level themselves when let go (it cannot roll over),
 * Up / Down raise and lower the nose and it settles back to level flight when let go. Manual: A / D roll at rollRate,
 * Up / Down pitch at pitchRate, nothing levels itself. On the ground (or the water) A / D steer, Space brakes (wheels
 * only), and past `vr` Up lifts off (assisted: it rotates by itself 5 m/s later). Touching down slower than `sinkMax`
 * m/s, wings level, on a surface it can use (the seaplane: water; the prop plane: a runway, or flat ground under
 * groundMax m/s with its gear down) lands; anything else is a crash: a bump, and the host puts it back at its berth.
 * Frames as the 3D city's: metres, yaw 0 faces +z and grows to the left, pitch positive = nose up, roll positive =
 * right side down.
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};
var PI = Math.PI, G = 9.81;

// m/s, m/s², rad, rad/s; reach (m: how near you must stand to climb in), box as hq3d
var VEHICLES = {
  seaplane: {plane: true, water: true, top: 72, acc: 6.2, rev: 0, lean: 0, box: [2, 7], eng: "six", reach: 14,
             stall: 26, vr: 30, reachW: 14, rollMax: 0.62, rollRate: 1.3, pitchRate: 0.55, sinkMax: 4.5, groundMax: 8, gear: false,
             waterDrag: 0.9, steer: 0.45, len: 16, span: 20, ceil: 1400, draft: 0.25},
  prop:     {plane: true, water: false, top: 66, acc: 7, rev: 0, lean: 0, box: [1.4, 3.6], eng: "six", reach: 5.5,
             stall: 21, vr: 24, rollMax: 0.7, rollRate: 1.7, pitchRate: 0.65, sinkMax: 4.5, groundMax: 30, gear: true,
             brake: 5, steer: 0.9, len: 7.6, span: 10.4, ceil: 1400}
};
var KINDS = ["seaplane", "prop"];
var H = 1/120;            // the sub-step (s)
var GE = 9;               // m: ground effect below this height
var STEP = 1.2;           // m: a rise in what is under you bigger than this is something solid in the way
var ROT = 0.13;           // rad: the attitude at lift-off

function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function wrapPi(a){ a = +a || 0; return Math.atan2(Math.sin(a), Math.cos(a)); }
function spring(x, v, goal, omega, dt){
  var c1 = x - goal, c2 = v + omega*c1, e = Math.exp(-omega*dt);
  return [goal + (c1 + c2*dt)*e, (c2 - omega*(c1 + c2*dt))*e];
}
function zero(){ return 0; }
function no(){ return false; }

function newState(kind, x, y, z, yaw){
  kind = VEHICLES[kind] ? kind : "prop";
  return {kind: kind, x: +x || 0, y: +y || 0, z: +z || 0, yaw: wrapPi(yaw), speed: 0, vx: 0, vy: 0, vz: 0, gamma: 0, gV: 0,
          pitch: 0, pV: 0, roll: 0, rV: 0, cmd: 0, thr: 0, rpm: 0, ground: true, water: !!VEHICLES[kind].water, agl: 0,
          gear: 1, gearUp: false, flaps: 0, stall: false, crashed: null, acc: 0, t: 0, rate: 0};
}

// one step of dt in whole sub-steps -> events
function step(st, inp, dt, env){
  var ev = []; dt = Math.max(0, Math.min(0.25, +dt || 0));
  st.acc += dt;
  while(st.acc >= H - 1e-9){ st.acc -= H; sub(st, inp || {}, env || {}, ev); if(st.crashed) break; }
  return ev;
}
// lift share at speed s: none under 0.85 stall, all of it from 1.15 stall
function liftShare(s, vs){ return clamp((s - vs*0.85)/(vs*0.3), 0, 1); }
function stallOf(V, st, agl){ return V.stall*(1 - 0.1*st.flaps)*(agl < GE ? 0.92 : 1); }

function sub(st, inp, env, ev){
  var V = VEHICLES[st.kind] || VEHICLES.prop, h = H, floor = typeof env.floor === "function" ? env.floor : zero;
  var water = typeof env.water === "function" ? env.water : no, runway = typeof env.runway === "function" ? env.runway : no;
  var waterY = typeof env.waterY === "function" ? env.waterY : function(){ return 0; };
  var thrIn = clamp(+inp.thr || 0, -1, 1), pIn = clamp(+inp.pitch || 0, -1, 1), rIn = clamp(+inp.roll || 0, -1, 1);
  var assist = inp.assist !== false;
  st.t += h;
  // the throttle you set, the engine spooling after it; the gear travels in 3 s
  st.thr = clamp(st.thr + thrIn*0.8*h, 0, 1);
  st.rpm += (Math.max(0.12, st.thr) - st.rpm)*(1 - Math.exp(-2.2*h));
  st.gear = clamp(st.gear + (st.gearUp && V.gear ? -h/3 : h/3), 0, 1);
  if(!V.gear) st.gear = 1;
  var thrust = V.acc*clamp((st.rpm - 0.12)/0.88, 0, 1), k = V.acc/(V.top*V.top);
  var dragX = 1 + 0.25*st.flaps + (V.gear ? 0.15*st.gear : 0);
  if(st.ground) return groundSub(st, V, env, ev, thrIn, pIn, rIn, assist, thrust, k*dragX, floor, water, runway, waterY, inp);

  // (over open water the surface is the water itself, less the floats' draft: not the floor, which keeps helicopters a
  // little above the waves)
  var dr = V.draft || 0, f0 = floor(st.x, st.z), wet = water(st.x, st.z), surf = wet ? waterY(st.x, st.z) - dr : f0;
  var agl = st.y - surf, vs = stallOf(V, st, agl), s = st.speed, eff = liftShare(s, vs);
  // the stall: below stall speed the nose drops of itself (gently) until the speed comes back
  var stalled = s < vs;
  if(stalled && !st.stall) ev.push({type: "stall"});
  st.stall = stalled;
  // bank: assisted holds what A / D ask (up to rollMax), level when let go; manual rolls at rollRate
  if(assist){
    st.roll = wrapPi(st.roll);                                       // (rolled over in manual: it rights itself)
    var rs = spring(st.roll, st.rV, -rIn*V.rollMax, 3.2, h);
    st.roll = rs[0]; st.rV = rs[1];
  } else { st.roll = wrapPi(st.roll - rIn*V.rollRate*h); st.rV = 0; }
  // pitch: assisted moves an attitude command with Up / Down and eases it back to level flight (the attitude that holds
  // the height at this speed, a touch more in a bank) when let go; manual pitches at pitchRate. The stall overrides.
  // (level: the attitude whose flight path is flat at this much lift, a touch more in a bank; assisted also keeps the
  // nose low enough to hold 1.15 stall speed: stall protection)
  var level = clamp(0.05 + (1 - eff)*0.42/Math.max(eff, 0.25), 0.05, 0.4) + 0.06*Math.abs(Math.sin(st.roll));
  if(assist){
    var top = 0.1 + 0.45*clamp((s - vs*1.15)/(vs*0.7), 0, 1);
    if(pIn) st.cmd = clamp(st.cmd + pIn*V.pitchRate*h, -0.45, Math.max(top, Math.min(st.cmd, 0.55)));
    else st.cmd += (level - st.cmd)*(1 - Math.exp(-0.9*h));
    if(st.cmd > top) st.cmd += (top - st.cmd)*(1 - Math.exp(-1.5*h));
  } else st.cmd = clamp(st.pitch + pIn*V.pitchRate*h*3, -1.3, 1.3);
  var pGoal = stalled ? Math.min(st.cmd, -0.18) : st.cmd;
  var ps = spring(st.pitch, st.pV, pGoal, stalled ? 1.6 : (assist ? 3 : 8), h); st.pitch = ps[0]; st.pV = ps[1];
  // the flight path follows the nose as far as lift allows; without lift it sags; ground effect cushions it
  var gGoal = (st.pitch - 0.05)*eff - (1 - eff)*0.42;
  if(agl < GE && gGoal < 0) gGoal *= 0.35 + 0.65*agl/GE;
  var gs = spring(st.gamma, st.gV, gGoal, 2.6, h); st.gamma = gs[0]; st.gV = gs[1];
  // turning: coordinated with the bank, as lift allows
  st.rate = -G*Math.sin(st.roll)/Math.max(s, 12)*eff;
  st.yaw = wrapPi(st.yaw + st.rate*h);
  // airspeed: thrust, drag, and the slope you fly
  s = Math.max(0, s + (thrust - k*dragX*s*s - G*Math.sin(st.gamma))*h);
  st.speed = s;
  var cg = Math.cos(st.gamma);
  st.vx = s*cg*Math.sin(st.yaw); st.vz = s*cg*Math.cos(st.yaw); st.vy = s*Math.sin(st.gamma);
  var nx = st.x + st.vx*h, nz = st.z + st.vz*h, ny = Math.min(V.ceil, st.y + st.vy*h);
  var fn = floor(nx, nz), wn = water(nx, nz), sn = wn ? waterY(nx, nz) - dr : fn;
  if(fn - Math.max(ny, f0) > STEP && fn > ny){ crash(st, ev, "wall"); return; }        // a building, a hillside
  st.x = nx; st.z = nz; st.y = ny;
  if(st.y <= sn){
    var sink = -st.vy, flat = Math.abs(floor(nx + 6, nz) - floor(nx - 6, nz)) < 1.2 && Math.abs(floor(nx, nz + 6) - floor(nx, nz - 6)) < 1.2;
    var gentle = sink < V.sinkMax && Math.abs(wrapPi(st.roll)) < 0.4 && st.pitch > -0.2;
    var ok = gentle && (V.water ? (wn || s < V.groundMax) : (!wn && st.gear > 0.95 && (runway(nx, nz) || (s < V.groundMax && flat))));
    if(!ok){ crash(st, ev, !gentle ? "hard" : wn ? "water" : st.gear < 0.95 ? "gear" : "rough"); return; }
    st.y = sn; st.ground = true; st.water = wn; st.vy = 0; st.gamma = 0; st.gV = 0; st.stall = false; st.cmd = 0;
    ev.push({type: "land", hard: sink > 2.5, water: wn, v: s});
    if(wn) ev.push({type: "splash"});
  }
  st.agl = st.y - sn;
}
// rolling on wheels or floats: steer, brake, accelerate; past vr Up lifts off
function groundSub(st, V, env, ev, thrIn, pIn, rIn, assist, thrust, kd, floor, water, runway, waterY, inp){
  var h = H, s = st.speed, wet = st.water;
  // what it rolls on: a seaplane runs up onto land only at a crawl (beached: it stops); a wheeled plane in the water sinks
  var steer = rIn*V.steer*clamp(s/4, 0.3, 1)*(1 - clamp((s - 18)/24, 0, 0.75));
  st.rate = steer; st.yaw = wrapPi(st.yaw + steer*h);
  var brake = (inp.brake || (thrIn < 0 && st.thr <= 0)) && !wet && V.brake ? V.brake : 0;
  var roll = wet ? V.waterDrag*(s > 3 ? 1 - clamp((s - 12)/20, 0, 0.7) : 1) + 0.002*s*s : 0.25 + 0.0015*s*s;   // floats get on the step
  s = Math.max(0, s + (thrust - kd*s*s - roll - brake)*h);
  var nx = st.x + Math.sin(st.yaw)*s*h, nz = st.z + Math.cos(st.yaw)*s*h, wn = water(nx, nz), fn = floor(nx, nz);
  var here = wet ? waterY(st.x, st.z) : floor(st.x, st.z);
  if(!wn && fn - here > 0.6){ s = 0; nx = st.x; nz = st.z; wn = wet; if(!st.bumped){ st.bumped = true; ev.push({type: "bump"}); } }   // a kerb, a wall, the quay
  else st.bumped = false;
  // floats onto land: it runs aground (a bump: it stops at the water's edge; you step ashore with E); wheels into the
  // water: a crash (back to the stand)
  if(V.water && !wn && wet){ s = 0; nx = st.x; nz = st.z; wn = true; if(!st.bumped){ st.bumped = true; ev.push({type: "bump"}); } }
  if(!V.water && wn){ crash(st, ev, "water"); return; }
  st.x = nx; st.z = nz; st.speed = s; st.water = wn;
  st.y = wn ? waterY(nx, nz) - (V.draft || 0) : floor(nx, nz);
  st.vx = Math.sin(st.yaw)*s; st.vz = Math.cos(st.yaw)*s; st.vy = 0; st.agl = 0;
  // the nose comes up as you rotate; floats pitch a little on the step
  var rot = s > V.vr*0.85 && pIn > 0 ? ROT*clamp((s - V.vr*0.85)/(V.vr*0.15), 0, 1) : 0;
  var pp = spring(st.pitch, st.pV, rot + (wet ? 0.03*clamp(s/12, 0, 1) : 0), 6, h); st.pitch = pp[0]; st.pV = pp[1];
  var rr = spring(st.roll, st.rV, 0, 6, h); st.roll = rr[0]; st.rV = rr[1];
  var vr = V.vr*(1 - 0.06*st.flaps);
  if(s > vr && (pIn > 0 || (assist && s > vr + 5))){
    st.ground = false; st.water = false; st.gamma = 0.05; st.gV = 0; st.cmd = Math.max(ROT, st.pitch); st.y += 0.05;
    ev.push({type: "takeoff"});
  }
}
function crash(st, ev, why){ st.crashed = why || "crash"; st.speed = 0; st.vx = st.vy = st.vz = 0; ev.push({type: "crash", why: st.crashed}); }

// Autopilot (HQ 3.2): the inputs that hold a height and a heading, or turn toward a point. ap = {alt (m), hdg (rad) or
// to: {x, z}}. Assisted controls fly them; -> {pitch, roll} each -1..1 (thr stays yours).
function autopilot(st, ap){
  if(!st || !ap || st.ground) return {pitch: 0, roll: 0};
  var V = VEHICLES[st.kind] || VEHICLES.prop, hdg = ap.to ? Math.atan2(ap.to.x - st.x, ap.to.z - st.z) : (ap.hdg != null ? +ap.hdg : st.yaw);
  var e = wrapPi(hdg - st.yaw);                                   // + : the goal is to the left
  var roll = clamp(e*2.2 - st.rate*0.8, -1, 1);                    // A (+1) banks left
  var climb = clamp(((+ap.alt || st.y) - st.y)/80, -0.12, 0.15), pitchErr = climb + 0.05 - st.cmd;       // at most ~6 m/s down, ~7 up
  return {pitch: clamp(pitchErr*4, -1, 1), roll: Math.abs(e) < 0.01 ? 0 : roll*(V.rollMax > 0 ? 1 : 0)};
}

/* ---------- the meshes (THREE only from here on) ---------- */
// hqaircraft's model with the pilot's anchors; g's origin is the surface under it (the water at the floats' bottom,
// the ground under the wheels)
function model(c, kind, color, accent){
  var CR = HQV.hqAircraft, THREE = c.THREE;
  var brand = color != null ? color : (kind === "seaplane" ? 0xd0262b : 0x2f6f9f);
  var P = kind === "seaplane" ? CR.seaplane(c, {brand: brand}) : CR.propPlane(c, {brand: brand}), g = P.g;
  function anchor(x, y, z){ var o = new THREE.Object3D(); o.position.set(x, y, z); g.add(o); return o; }
  var sea = kind === "seaplane", yc = sea ? 2.9 : CR.PROP_YC;
  // the pilot: left seat, in the cockpit; the yoke and the pedals in front
  var sx = sea ? 0.35 : 0.28, sz = sea ? 5.3 : 0.75, sy = sea ? yc - 0.75 : yc - 0.42;
  var B = {g: g, kind: kind, P: P, seat: anchor(sx, sy, sz), grips: [anchor(sx + 0.18, sy + 0.42, sz + 0.55), anchor(sx - 0.18, sy + 0.42, sz + 0.55)],
           feet: [anchor(sx + 0.12, sy - 0.1, sz + 0.85), anchor(sx - 0.12, sy - 0.1, sz + 0.85)], lean: 0, riderK: 0.82, hats: false,
           phase: 0, brake: function(){}};
  return B;
}
function animate(B, st, dt, night){
  if(!B || !B.P) return;
  dt = Math.max(0, +dt || 0);
  var rpm = st ? st.rpm : 0, spin = rpm > 0.05;
  B.phase = (B.phase + dt*rpm*90) % (PI*2);
  var blur = clamp((rpm - 0.15)/0.4, 0, 1);
  if(B.P.prop){ B.P.prop.rotation.z = B.phase; B.P.prop.visible = blur < 0.95 || ((B.phase*5) % 1) < 0.4; }
  if(B.P.discM) B.P.discM.opacity = spin ? 0.28*blur : 0;
  B.P.update(dt, st ? st.t : 0, !!night, st ? st.gear : 1, st ? st.speed : 0);
}

HQV.hqplane = {VEHICLES: VEHICLES, KINDS: KINDS, H: H, GE: GE, newState: newState, step: step, liftShare: liftShare,
               autopilot: autopilot, model: model, animate: animate, spring: spring};
})();
