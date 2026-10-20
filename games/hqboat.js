/* Claude HQ: boats on the sea round the islands (HQV.hqboat): a rowboat and a jet ski.
 *
 * The physics is pure, so tests/test_hqboat.py runs it under node: no THREE, no DOM, no clock.
 *   VEHICLES        how each one handles, the same shape as games/hq3d.js VEHICLES (top, acc, rev,
 *                   lean, box, motor, gears, eng) plus the hull and the water: len, turn, drag...
 *   newState(kind, x, z, yaw)            a boat at rest
 *   step(st, inp, dt, sea) -> events     one step: thrust, drag, a turn rate that rises with speed,
 *                   bob, pitch and roll on the waves, beaching (the bow stops at the coast) and
 *                   docking (slow near a berth: it is drawn alongside and held there until you let go
 *                   of the throttle and open it again).
 *   model(c, kind, color, accent)        the meshes, from the hq3d ctx `c` (THREE, mat); forward is +z
 *   animate(B, st, inp, dt)              oars and handlebars
 * inp = {thr: -1..1 (W +, S -), steer: -1..1 (A +, turns left)}. sea = {land(x, z) -> bool (the coast
 * polygon test: true on an island), docks: [{id, x, z, yaw}] (berths, metres; yaw faces out to sea),
 * y (sea level, m), wave(x, z, t) -> m (games/ocean.js waveAt)}; games/ocean.js seaOf(doc) builds one.
 * Every smoother is closed form: the speed solves its linear-drag ODE exactly, the turn rate and the
 * hull's heave, pitch and roll are critically damped springs, the berth pull is ease(k, dt). So the
 * same inputs give the same path at 30 Hz and at 120 Hz. Frames as the 3D city's: metres, yaw 0 faces
 * +z, model-local +x is LEFT, pitch positive = nose up, roll positive = right side down.
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};
var PI = Math.PI;

/* ---------- how they handle ---------- */
// m/s and m/s². Water drag is linear, k = acc/top, so full throttle settles at `top` and S at `rev`
// astern. The turn rate (rad/s at full lock) is turn*(base + (1 - base)*(1 - exp(-|v|/turnV))):
// a rowboat pivots on its oars from rest, a jet ski needs way on (no thrust, no steering) and turns
// harder the faster it goes. turnW, heave, tilt: spring omegas. len/beam: the hull (m); draft: how
// deep it sits; plane: nose-up (rad) at top speed; lean: into a turn (rad per rad/s). box as hq3d.
var VEHICLES = {
  rowboat: {top: 3.2, acc: 1.4, rev: 1.6, lean: 0.03, box: [0.7, 1.75], boat: true,
            len: 3.6, beam: 1.4, draft: 0.12, turn: 0.9, base: 0.45, turnV: 1.2, turnW: 5, heave: 4, tilt: 5, plane: 0},
  jetski:  {top: 20, acc: 6.5, rev: 2.5, lean: 0.22, box: [0.6, 1.6], boat: true, motor: true, gears: [7, 13, 20], eng: "four",
            len: 3.2, beam: 1.2, draft: 0.08, turn: 1.6, base: 0.08, turnV: 5, turnW: 7, heave: 6, tilt: 7, plane: 0.07}
};
var KINDS = ["rowboat", "jetski"];
// Docking: slower than v m/s with the hull's centre within r m of a berth; held there by ease(k, dt);
// after leaving a berth you must get rearm*r away before it takes you again. Beaching bisects the
// last move BISECT times to stop the leading end at the shore.
var DOCK = {r: 8, v: 2.5, k: 3, rearm: 1.5};
var BISECT = 12;

/* ---------- helpers ---------- */
function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function wrapPi(a){ a = +a || 0; return Math.atan2(Math.sin(a), Math.cos(a)); }
// The share of the way to a goal to cover this frame at rate k (frame-rate independent).
function ease(k, dt){ return 1 - Math.exp(-Math.max(0, +k || 0)*Math.max(0, +dt || 0)); }
// Critically damped spring, exact closed form (as games/camrig.js). -> [x, v]
function spring(x, v, goal, omega, dt){
  x = +x || 0; v = +v || 0; dt = Math.max(0, +dt || 0);
  var c1 = x - goal, c2 = v + omega*c1, e = Math.exp(-omega*dt);
  return [goal + (c1 + c2*dt)*e, (c2 - omega*(c1 + c2*dt))*e];
}
// the integral of that spring's x over dt (how far a spring-driven rate turns you), exact
function springArea(x, v, goal, omega, dt){
  x = +x || 0; v = +v || 0; dt = Math.max(0, +dt || 0);
  var c1 = x - goal, c2 = v + omega*c1, e = Math.exp(-omega*dt);
  return goal*dt + c1*(1 - e)/omega + c2*(1 - e*(1 + omega*dt))/(omega*omega);
}
// v' = f - k v over dt, exactly: -> [v1, distance covered]
function drag(v0, f, k, dt){
  var vi = f/k, e = Math.exp(-k*dt);
  return [vi + (v0 - vi)*e, vi*dt + (v0 - vi)*(1 - e)/k];
}
// the turn rate a boat can make at full lock at speed v (rad/s)
function turnAt(V, v){ return V.turn*(V.base + (1 - V.base)*(1 - Math.exp(-Math.abs(v)/V.turnV))); }
function noLand(){ return false; }
function flat(){ return 0; }

function newState(kind, x, z, yaw){
  kind = VEHICLES[kind] ? kind : "rowboat";
  return {kind: kind, x: +x || 0, z: +z || 0, yaw: wrapPi(yaw), speed: 0, rate: 0, rateV: 0, steer: 0, t: 0,
          y: 0, yV: 0, pitch: 0, pV: 0, roll: 0, rV: 0, beached: false, dock: null, hold: false, left: null};
}

// the berth nearest (x, z), and how far
function nearestDock(docks, x, z){
  var best = null, bd = Infinity;
  for(var i = 0; i < (docks || []).length; i++){
    var d = docks[i]; if(!d) continue;
    var dd = Math.hypot(x - d.x, z - d.z);
    if(dd < bd){ bd = dd; best = d; }
  }
  return best ? {d: best, dist: bd} : null;
}
function dockById(docks, id){
  for(var i = 0; i < (docks || []).length; i++) if(docks[i] && docks[i].id === id) return docks[i];
  return null;
}
// moored along the berth either way round: whichever is nearer the way the boat points
function berthYaw(d, yaw){
  var a = +d.yaw || 0;
  return Math.abs(wrapPi(a - yaw)) <= PI/2 ? a : wrapPi(a + PI);
}

/* ---------- one step ---------- */
// -> events: [{type: "beach"}, {type: "dock", id}, {type: "undock", id}]
function step(st, inp, dt, sea){
  inp = inp || {}; sea = sea || {}; dt = Math.max(0, Math.min(0.25, +dt || 0));
  var V = VEHICLES[st.kind] || VEHICLES.rowboat, ev = [];
  var land = typeof sea.land === "function" ? sea.land : noLand, wave = typeof sea.wave === "function" ? sea.wave : flat;
  var thr = clamp(+inp.thr || 0, -1, 1), steer = clamp(+inp.steer || 0, -1, 1);
  if(!(dt > 0)) return ev;
  var s0 = st.steer; st.steer += (steer - st.steer)*ease(8, dt);
  var sm = 0.5*(s0 + st.steer);                                                  // the helm over this step
  // moored: held at the berth until you put the throttle on
  if(st.dock != null){
    var bd = dockById(sea.docks, st.dock);
    if(!thr) st.hold = false;
    if(!bd || (thr && !st.hold)){
      ev.push({type: "undock", id: st.dock}); st.left = st.dock; st.dock = null;
    } else {
      var u = ease(DOCK.k, dt), by = berthYaw(bd, st.yaw);
      st.x += (bd.x - st.x)*u; st.z += (bd.z - st.z)*u; st.yaw = wrapPi(st.yaw + wrapPi(by - st.yaw)*u);
      st.speed = 0; st.rate = 0; st.rateV = 0;
      settle(st, V, sea, wave, dt);
      return ev;
    }
  }
  // thrust against water drag: exact over the step
  var k = V.acc/V.top, f = thr > 0 ? V.acc*thr : thr*k*V.rev;
  var v0 = st.speed, dv = drag(v0, f, k, dt), dist = dv[1];
  // the turn rate springs toward what the hull can make at this speed; astern turns the other way
  var vm = 0.5*(v0 + dv[0]), goal = sm*turnAt(V, vm)*(vm < -0.05 ? -1 : 1);
  var turned = springArea(st.rate, st.rateV, goal, V.turnW, dt), rs = spring(st.rate, st.rateV, goal, V.turnW, dt);
  st.rate = rs[0]; st.rateV = rs[1];
  var yaw0 = st.yaw, yaw1 = yaw0 + turned, hm = 0.5*(yaw0 + yaw1);                // move along the mean heading
  st.yaw = wrapPi(yaw1); st.speed = dv[0];
  // beaching: the leading end (the bow going ahead, the stern astern) may not cross the coast
  var half = V.len/2, sg = dist >= 0 ? 1 : -1, sh = Math.sin(hm), ch = Math.cos(hm);
  var lx = st.x + sg*sh*half, lz = st.z + sg*ch*half, mx = sh*dist, mz = ch*dist;
  if(dist && land(lx, lz)){
    st.speed = 0; mx = mz = 0;                                     // already aground that way: back off the other way
    if(!st.beached) ev.push({type: "beach"});
    st.beached = true;
  } else if(dist && land(lx + mx, lz + mz)){
    var lo = 0, hi = 1;
    for(var i = 0; i < BISECT; i++){ var m = 0.5*(lo + hi); if(land(lx + mx*m, lz + mz*m)) hi = m; else lo = m; }
    mx *= lo; mz *= lo; st.speed = 0;
    if(!st.beached) ev.push({type: "beach"});
    st.beached = true;
  } else if(Math.abs(dist) > 1e-4) st.beached = false;
  st.x += mx; st.z += mz;
  // docking: slow, near a berth, and not the one you just left (until you have been clear of it)
  if(st.left != null){
    var ld = dockById(sea.docks, st.left);
    if(!ld || Math.hypot(st.x - ld.x, st.z - ld.z) > DOCK.r*DOCK.rearm) st.left = null;
  }
  var nd = nearestDock(sea.docks, st.x, st.z);
  if(nd && nd.dist < DOCK.r && Math.abs(st.speed) < DOCK.v && nd.d.id !== st.left){
    st.dock = nd.d.id; st.speed = 0; st.beached = false; st.hold = !!thr;      // the throttle you came in on does not take you out again
    ev.push({type: "dock", id: nd.d.id});
  }
  settle(st, V, sea, wave, dt);
  return ev;
}
// The hull on the waves: heave to the mean of the water under it, pitch to the slope bow to stern,
// roll to the slope across (plus a lean into the turn); a planing hull lifts its nose with speed.
function settle(st, V, sea, wave, dt){
  st.t += dt;
  var t = st.t, sy = Math.sin(st.yaw), cy = Math.cos(st.yaw), h = V.len*0.4, b = V.beam*0.45;
  var hc = wave(st.x, st.z, t), hf = wave(st.x + sy*h, st.z + cy*h, t), hb = wave(st.x - sy*h, st.z - cy*h, t);
  var hl = wave(st.x + cy*b, st.z - sy*b, t), hr = wave(st.x - cy*b, st.z + sy*b, t);   // model-local +x is left
  var sl = clamp(Math.abs(st.speed)/V.top, 0, 1);
  var yGoal = (+sea.y || 0) + 0.25*(hc*2 + hf + hb) - V.draft + V.plane*sl*0.8;
  var pGoal = Math.atan2(hf - hb, 2*h) + V.plane*sl*(st.speed > 0 ? 1 : 0);
  var rGoal = Math.atan2(hl - hr, 2*b) - st.rate*V.lean*sl;            // water higher on the left: right side down; lean into a turn
  var a = spring(st.y, st.yV, yGoal, V.heave, dt), p = spring(st.pitch, st.pV, pGoal, V.tilt, dt), r = spring(st.roll, st.rV, rGoal, V.tilt, dt);
  st.y = a[0]; st.yV = a[1]; st.pitch = p[0]; st.pV = p[1]; st.roll = r[0]; st.rV = r[1];
}

/* ---------- the meshes (THREE only from here on, when a model is asked for) ---------- */
// A hull lofted through stations [z, half beam at the gunwale, gunwale y, half beam at the chine,
// chine y, keel y], bow last; both sides and the transom, one double-sided mesh.
function hullGeo(THREE, S){
  var pos = [], idx = [];
  function v(x, y, z){ pos.push(x, y, z); return pos.length/3 - 1; }
  var rows = S.map(function(s){
    return [v(s[1], s[2], s[0]), v(s[3], s[4], s[0]), v(0, s[5], s[0]), v(-s[3], s[4], s[0]), v(-s[1], s[2], s[0])];
  });
  for(var i = 0; i < rows.length - 1; i++){
    var a = rows[i], c = rows[i + 1];
    for(var j = 0; j < 4; j++){ idx.push(a[j], c[j], a[j + 1], a[j + 1], c[j], c[j + 1]); }
  }
  var t = rows[0]; idx.push(t[0], t[1], t[4], t[1], t[2], t[3], t[1], t[3], t[4]);   // the transom
  var g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}
// {g, kind, seat, grips, feet, lean, brake, steer, oars}: g's origin is the waterline at the hull's
// centre; seat/grips/feet are anchors for the rider (as hq3d's vehicles).
function model(c, kind, color, accent){
  var THREE = c.THREE, g = new THREE.Group(), paint = c.mat(color == null ? 0x2f6f9f : color, {roughness: 0.55});
  var acc = c.mat(accent == null ? 0xf2f2f2 : accent, {roughness: 0.5}), dark = c.mat(0x22282e, {roughness: 0.8});
  function mesh(geo, m, x, y, z, p){ var o = new THREE.Mesh(geo, m); o.position.set(x || 0, y || 0, z || 0); o.castShadow = true; (p || g).add(o); return o; }
  function box(w, h, d, m, x, y, z, p){ return mesh(new THREE.BoxGeometry(w, h, d), m, x, y, z, p); }
  function anchor(p, x, y, z){ var o = new THREE.Object3D(); o.position.set(x, y, z); p.add(o); return o; }
  g.name = kind === "jetski" ? "jetski" : "rowboat";
  if(kind === "jetski"){
    var hm = c.mat(0xf4f4f4, {roughness: 0.4});
    var hg = hullGeo(THREE, [[-1.5, 0.52, 0.32, 0.4, -0.05, -0.14], [-0.6, 0.6, 0.36, 0.46, -0.04, -0.16], [0.4, 0.56, 0.38, 0.4, 0.0, -0.12],
                             [1.15, 0.36, 0.36, 0.2, 0.08, 0.0], [1.6, 0.02, 0.32, 0.01, 0.26, 0.24]]);
    var hull = mesh(hg, hm); hull.material = hm.clone(); hull.material.side = THREE.DoubleSide;
    box(0.98, 0.1, 2.0, paint, 0, 0.4, -0.35);                                              // the deck
    var cowl = mesh(new THREE.SphereGeometry(0.42, 12, 8, 0, PI*2, 0, PI/2), paint, 0, 0.42, 0.75); cowl.scale.set(1.1, 0.8, 1.5);
    box(1.0, 0.05, 1.6, acc, 0, 0.36, -0.4);                                                // the accent band
    var seat = box(0.42, 0.2, 1.25, dark, 0, 0.55, -0.45);
    var steer = new THREE.Group(); steer.position.set(0, 0.78, 0.38); g.add(steer);
    mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.3, 8), dark, 0, -0.1, 0, steer).rotation.x = -0.5;
    mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.72, 8), dark, 0, 0.05, -0.04, steer).rotation.z = PI/2;
    box(0.26, 0.08, 0.16, paint, 0, 0.02, 0.05, steer);
    box(0.42, 0.04, 0.08, c.mat(0xff6b5b, {roughness: 0.4}), 0, 0.3, -1.37);               // a reflector at the back
    return {g: g, kind: "jetski", seat: anchor(seat, 0, 0.1, 0.05), grips: [anchor(steer, 0.34, 0.05, -0.04), anchor(steer, -0.34, 0.05, -0.04)],
            feet: [anchor(g, 0.38, 0.47, -0.3), anchor(g, -0.38, 0.47, -0.3)], steer: steer, oars: null, lean: VEHICLES.jetski.lean, brake: function(){}};
  }
  var wood = c.mat(0x9b6a3f, {roughness: 0.8});
  var rg = hullGeo(THREE, [[-1.75, 0.62, 0.42, 0.5, -0.02, -0.14], [-0.9, 0.7, 0.45, 0.56, -0.05, -0.18], [0.2, 0.68, 0.47, 0.52, -0.05, -0.18],
                           [1.1, 0.44, 0.52, 0.28, 0.0, -0.12], [1.8, 0.02, 0.62, 0.01, 0.3, 0.2]]);
  var rh = mesh(rg, paint); rh.material = paint.clone(); rh.material.side = THREE.DoubleSide;
  box(1.1, 0.03, 2.9, wood, 0, -0.02, -0.05);                                               // the floor boards
  [[-1.3, 1.2], [-0.1, 1.38], [0.95, 1.0]].forEach(function(s){ box(s[1], 0.05, 0.28, wood, 0, 0.26, s[0]); });   // the thwarts
  [1, -1].forEach(function(sx){ box(0.05, 0.05, 3.1, acc, sx*0.63, 0.46, -0.1).rotation.y = sx*0.03; });           // the gunwales
  var oars = [1, -1].map(function(sx){
    var lock = new THREE.Group(); lock.position.set(sx*0.7, 0.5, -0.05); g.add(lock);
    var shaft = mesh(new THREE.CylinderGeometry(0.025, 0.025, 2.3, 6), wood, sx*0.85, 0, 0, lock); shaft.rotation.z = PI/2;
    box(0.55, 0.015, 0.16, wood, sx*1.85, 0, 0, lock);
    return lock;
  });
  return {g: g, kind: "rowboat", seat: anchor(g, 0, 0.3, -0.1), grips: [anchor(g, 0.3, 0.55, 0.25), anchor(g, -0.3, 0.55, 0.25)],
          feet: [anchor(g, 0.18, 0.02, 0.55), anchor(g, -0.18, 0.02, 0.55)], steer: null, oars: oars, lean: VEHICLES.rowboat.lean,
          phase: 0, brake: function(){}};
}
// Rows (stroke rate from the throttle or the steering, one oar backing water to turn) or turns the bars.
function animate(B, st, inp, dt){
  if(!B) return;
  inp = inp || {}; dt = Math.max(0, +dt || 0);
  var steer = st ? st.steer : 0;
  if(B.steer) B.steer.rotation.y = steer*0.5;
  if(B.oars){
    var thr = clamp(+inp.thr || 0, -1, 1), work = Math.max(Math.abs(thr), Math.abs(steer));
    B.phase = (B.phase + dt*PI*2*0.8*work) % (PI*2);
    B.oars.forEach(function(o, i){
      var side = i ? -1 : 1, dir = thr < 0 ? -1 : 1, s = Math.sin(B.phase)*dir*(1 + steer*side*0.6);   // the outside oar pulls harder
      o.rotation.y = side*0.55*s*Math.min(1, work*3); o.rotation.z = side*(0.12 + 0.12*Math.cos(B.phase))*Math.min(1, work*3);
    });
  }
}

HQV.hqboat = {VEHICLES: VEHICLES, KINDS: KINDS, DOCK: DOCK, newState: newState, step: step, turnAt: turnAt,
              spring: spring, ease: ease, drag: drag, model: model, animate: animate, hullGeo: hullGeo};
})();
