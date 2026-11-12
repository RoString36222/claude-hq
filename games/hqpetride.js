/* Claude HQ: riding your pets (HQV.hqPetRide, HQ 3.14) -- fly your grown dragon, swim on your sea serpent, ride your
 * big dinosaur.
 *
 * A pet that is out with you (games/hqpets.js) and grown (a dragon or the sea serpent at its grown stage; one of the
 * big dinosaurs, which do not grow, once its affection reaches the grown mark, STAGE_AT[1]) can be ridden in the 3D
 * City: walk up to it, E. games/hq3d.js mounts you on a big copy of it (mountModel: the pet's own model scaled up,
 * a saddle on its back) and drives it with step(); the dragon's state has the helicopter's shape (x, y, z, yaw, vx,
 * vy, vz, speed, pitch, roll, ground, agl), so the City's floors, roof pads (games/hqroof.js's landing assist), flying
 * on to another island and Go to all work as they do for a helicopter.
 *
 * Pure from here to the meshes (no THREE, no DOM, no clock), so tests/test_hqpetride.py runs it under node:
 *   rideKind(sp)              "dragon" (the seven dragons), "serpent" (the sea serpent), "dino" (RIDE_DINO), else null
 *   grown(sp, affection)      big enough to ride
 *   canMount(o) -> {ok, why}  o = {sp, affection, d (m from you), water (is the pet on water), world (rideable here)}
 *   newState(kind, x, y, z, yaw, sp)   standing at (x, y, z)
 *   step(st, inp, dt, env) -> events   fixed 1/120 s sub-steps (the remainder carried), so 30 Hz and 120 Hz agree;
 *                             events [{type: "takeoff"}, {type: "land", hard, v}, {type: "bump"}, {type: "ceiling"}]
 *   canDismount(st) -> {ok, why}       a dragon: landed or within DISMOUNT_H m of what is under it; a serpent: beside land
 *   breathOf(sp, calm)        the particle kind the breath key throws (null in Calm: no effect at all)
 * inp = {fwd: -1..1 (W +), turn: -1..1 (A + = left), lift: -1..1 (Space +, Shift -), run: bool (dinos: Shift)}.
 * env = {floor(x, z) (a dragon: what it lands on, as hq3d's heliFloor), wall(x, z, y) (optional), blocked(x, z)
 *        (on the ground: a wall), ground(x, z) (the height you walk on), water(x, z) (open water), waterY(x, z)}.
 * The dragon's flight: W / S set the speed it holds (S down to 0: a hover); A / D turn (it banks into the turn); Space
 * climbs (big beats), Shift descends (from a hover straight down, at speed a dive that trades height for speed);
 * with neither it glides (wings spread, sinking GLIDE m/s) or, slow, hovers in place (fast short beats). On the
 * ground it walks (W / S, A / D) and Space leaps into the air. A touchdown slower than V.land settles it.
 *   mountModel(c, pet) -> B  the mount (THREE, from hq3d's ctx c): {g, M (the pet model), seat, grips, feet, lean,
 *                             riderK, mouth()} -- hq3d seats your character on B like on any vehicle
 *   animate(B, st, t, dt, calm)        the pet's gait / wings from the ride's state
 *   peerState(B, v, vy, agl)  someone else's mount: a state from what their presence shows (speed, climb, height)
 *   breathe(F, B, st, dt, kind)        the breath, forward from the mouth (F: an HQV.hqPets.Fx particle pool)
 * Presence (the "petride" capability, backend/src/protocol.rs): a = A_CODE (13) while riding, `pt`'s first pet the
 * mount, `h` the height. Original procedural art only (the pets' own models; the dinosaurs' CC0 Quaternius models).
 */
(function(){
"use strict";
var G = typeof window !== "undefined" ? window : globalThis;
var HQV = G.HQV = G.HQV || {};
var PI = Math.PI;
var A_CODE = 13;
var REACH = 3.2;          // m from the pet's middle to get on
var SERPENT_REACH = 5;    // m: it lies off the shore
var DISMOUNT_H = 3;       // m: higher than this over what is under you, nobody gets off a dragon
var STAGE_GROWN = 400;    // affection: HQV.hqPets.STAGE_AT[1] (the grown stage); the dinosaurs ride from there too
var RIDE_DINO = {triceratops: 1, brachio: 1, stego: 1, trex: 1};
var H = 1/120;            // the sub-step (s)
var STEP = 0.8;           // m: a rise in the floor bigger than this is a wall
var GE = 5;               // m: the ground cushion (the last beats before a landing) below this
// How each one rides (m/s, m/s², rad/s). scale: the mount over the pet's own size (a grown dragon ~3.5 m long).
var VEHICLES = {
  dragon:  {top: 45, cruise: 32, hover: 7, acc: 7, dec: 9, climb: 8, sink: 6, dive: 16, diveGain: 12, glide: 1.1, leap: 6.5,
            yawR: 1.0, yawHover: 1.8, bank: 0.6, ceil: 800, walk: 4.5, land: 12, scale: 4.2,
            lean: 0, box: [1.2, 3], petride: true, air: true, reach: REACH, size: 1.5},
  serpent: {top: 14, swimSlow: 9, rev: 2, acc: 5, dec: 7, yawR: 1.1, scale: 2.6, lean: 0, box: [0.8, 3], petride: true, swim: true, size: 1.4},
  dino:    {top: 10, rev: 1.6, acc: 4, dec: 8, yawR: 1.2, scale: 3.6, lean: 0, box: [0.9, 2], petride: true, size: 1.2},
  // someone else riding (presence a = 13): what hq3d's peers draw
  petride: {top: 45, lean: 0, box: [1, 2], petride: true, peer: true}
};
var DINO = {triceratops: {walk: 3.2, run: 9}, brachio: {walk: 2.6, run: 6.5, scale: 3.8}, stego: {walk: 3, run: 8}, trex: {walk: 3.6, run: 10.5, scale: 3.8}};
var BREATH = {fire: "fire", ice: "ice", storm: "sparkle", sparkle: "prism", wisp: "wisp", glitter: "glitter", bubbles: "bubbles", venom: "venom", smoke: "smoke"};

function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function wrapPi(a){ a = +a || 0; return Math.atan2(Math.sin(a), Math.cos(a)); }
function ease(k, dt){ return 1 - Math.exp(-Math.max(0, +k || 0)*Math.max(0, +dt || 0)); }
function zero(){ return 0; }
function no(){ return false; }

function rideKind(sp){
  if(!sp) return null;
  if(sp.kind === "dragon") return "dragon";
  if(sp.kind === "serpent") return "serpent";
  if(sp.kind === "dino" && RIDE_DINO[sp.id]) return "dino";
  return null;
}
function grown(sp, aff){ return !!rideKind(sp); }   // 3.14: every dragon, the serpent and the big dinosaurs ride from adoption
function canMount(o){
  o = o || {}; var sp = o.sp, k = rideKind(sp);
  if(!k) return {ok: false, why: "kind"};
  if(o.world === false) return {ok: false, why: "world"};
  if(!grown(sp, o.affection)) return {ok: false, why: "young"};
  if(!((+o.d || 0) <= (k === "serpent" ? SERPENT_REACH : REACH))) return {ok: false, why: "far"};
  if(k === "serpent" && !o.water) return {ok: false, why: "water"};
  return {ok: true, why: null};
}
function scaleOf(sp){ var k = rideKind(sp), d = sp && DINO[sp.id]; return d && d.scale ? d.scale : (VEHICLES[k] || VEHICLES.dragon).scale; }
function breathOf(sp, calm){ return calm || !sp ? null : BREATH[sp.fx] || (rideKind(sp) === "dragon" ? "smoke" : null); }

function newState(kind, x, y, z, yaw, sp){
  kind = VEHICLES[kind] && kind !== "petride" ? kind : "dragon";
  var d = sp && DINO[sp.id];
  return {kind: kind, x: +x || 0, y: +y || 0, z: +z || 0, yaw: wrapPi(yaw), vx: 0, vy: 0, vz: 0, speed: 0, tgt: 0, gs: 0,
          pitch: 0, pV: 0, roll: 0, rate: 0, ground: true, agl: 0, acc: 0, t: 0, bumpT: 0, leapT: 0, rpm: 1, wing: "fold",
          walk: d ? d.walk : 3, run: d ? d.run : 8};
}
function step(st, inp, dt, env){
  var ev = []; dt = Math.max(0, Math.min(0.25, +dt || 0));
  st.acc += dt;
  while(st.acc >= H - 1e-9){ st.acc -= H; (st.kind === "dragon" ? subFly : subGround)(st, inp || {}, env || {}, ev); }
  return ev;
}
function input(inp){ return {fwd: clamp(+inp.fwd || 0, -1, 1), turn: clamp(+inp.turn || 0, -1, 1), lift: clamp(+inp.lift || 0, -1, 1), run: !!inp.run}; }
function springTo(x, goal, k, h){ return x + (goal - x)*ease(k, h); }

// a dragon, flying (or walking on the ground, or leaping off it)
function subFly(st, inp, env, ev){
  var V = VEHICLES.dragon, h = H, floor = typeof env.floor === "function" ? env.floor : zero, wallF = typeof env.wall === "function" ? env.wall : no;
  var I = input(inp), fwd = I.fwd, turn = I.turn, lift = I.lift;
  st.t += h; st.bumpT = Math.max(0, st.bumpT - h);
  var f0 = floor(st.x, st.z), sy, cy, nx, nz, fn;
  if(st.ground){
    // on its feet: W / S walk it, A / D turn it, Space leaps up with big beats
    st.y = f0; st.vy = 0;
    var want = fwd > 0 ? V.walk*(I.run ? 1.6 : 1)*fwd : fwd < 0 ? V.walk*0.4*fwd : 0;
    st.gs = springTo(st.gs, want, 4, h);
    st.rate = springTo(st.rate, turn*V.yawHover*0.7, 6, h); st.yaw = wrapPi(st.yaw + st.rate*h);
    sy = Math.sin(st.yaw); cy = Math.cos(st.yaw); nx = st.x + sy*st.gs*h; nz = st.z + cy*st.gs*h; fn = floor(nx, nz);
    if(fn - st.y > STEP || wallF(nx, nz, st.y + 0.5)){ st.gs = 0; if(st.bumpT <= 0){ ev.push({type: "bump"}); st.bumpT = 0.5; } }
    else { st.x = nx; st.z = nz; st.y = fn; }
    st.vx = sy*st.gs; st.vz = cy*st.gs; st.speed = Math.abs(st.gs); st.tgt = 0;
    st.pitch = springTo(st.pitch, 0, 6, h); st.roll = springTo(st.roll, 0, 6, h);
    st.wing = "fold"; st.agl = 0;
    if(lift > 0){ st.ground = false; st.vy = V.leap; st.leapT = 0.9; st.tgt = Math.max(0, st.gs); ev.push({type: "takeoff"}); }
    return;
  }
  // the speed it holds: W raises it, S lowers it (to 0: a hover)
  if(fwd > 0) st.tgt = Math.min(V.top, st.tgt + V.acc*fwd*h);
  else if(fwd < 0) st.tgt = Math.max(0, st.tgt + V.dec*fwd*h);
  sy = Math.sin(st.yaw); cy = Math.cos(st.yaw);
  var vF = st.vx*sy + st.vz*cy, vS = st.vx*cy - st.vz*sy;
  var hover = vF < V.hover && st.tgt < V.hover, diving = lift < 0 && !hover, climbing = lift > 0 || st.leapT > 0;
  // a dive gains speed past the one held; a climb at speed bleeds some
  var goalF = st.tgt + (diving ? V.diveGain*(-lift) : 0) - (lift > 0 && st.tgt > V.cruise ? (st.tgt - V.cruise)*0.5*lift : 0);
  vF = springTo(vF, goalF, vF < goalF ? (diving ? 1.0 : 1.2) : 0.9, h);
  vS *= Math.exp(-2.5*h);                                                   // sideways speed dies away: a turn carves
  // the turn: quick in a hover, wider at speed; the body banks into it
  var sl = clamp(vF/V.top, 0, 1), yR = V.yawHover + (V.yawR - V.yawHover)*sl;
  st.rate = springTo(st.rate, turn*yR, 5, h); st.yaw = wrapPi(st.yaw + st.rate*h);
  sy = Math.sin(st.yaw); cy = Math.cos(st.yaw);
  st.vx = vF*sy + vS*cy; st.vz = vF*cy - vS*sy;
  // up and down
  var agl = st.y - f0;
  var goal = lift > 0 ? lift*V.climb*(hover ? 0.8 : 1) : lift < 0 ? (hover ? lift*V.sink : lift*V.dive) : hover ? 0 : -V.glide;
  if(st.leapT > 0){ st.leapT -= h; goal = Math.max(goal, V.climb*0.7); }
  if(goal < 0 && agl < GE && !diving) goal = Math.max(goal, -(0.8 + agl*0.9));   // the last beats: a soft touchdown
  if(goal < 0 && agl < GE && diving) goal = Math.max(goal, -(2 + agl*1.6));       // pulling out of a dive near the ground
  if(st.y > V.ceil - 60) goal = Math.min(goal, (V.ceil - st.y)*0.15);
  st.vy = springTo(st.vy, goal, 3, h);
  // how it hangs in the air: nose up climbing and hovering, down in a dive; banked into a turn
  var pGoal = climbing ? 0.22 + 0.08*Math.max(0, lift) : diving ? -0.45*(-lift) : hover ? 0.1 : -0.04;
  st.pitch = springTo(st.pitch, pGoal, 4, h);
  st.roll = springTo(st.roll, clamp(-st.rate*0.5*(0.3 + sl), -V.bank, V.bank), 4, h);
  // the move, and what is in the way
  nx = st.x + st.vx*h; nz = st.z + st.vz*h; var ny = st.y + st.vy*h; fn = floor(nx, nz);
  if(fn - ny > STEP || wallF(nx, nz, ny + 0.5)){
    nx = st.x; nz = st.z; st.vx *= -0.2; st.vz *= -0.2; st.tgt *= 0.5; fn = f0;
    if(st.bumpT <= 0){ ev.push({type: "bump"}); st.bumpT = 0.5; }
  }
  if(ny > V.ceil){ ny = V.ceil; if(st.vy > 0){ st.vy = 0; ev.push({type: "ceiling"}); } }
  st.x = nx; st.z = nz; st.y = ny;
  if(st.y <= fn){
    var vy = st.vy; st.y = fn; st.vy = Math.max(0, st.vy);
    var hv = Math.hypot(st.vx, st.vz);
    if(lift <= 0 && st.leapT <= 0 && hv < V.land){
      st.ground = true; st.gs = Math.min(hv, V.walk); st.vy = 0; st.tgt = 0; st.rate = 0; st.leapT = 0;
      ev.push({type: "land", hard: vy < -6, v: vy});
    } else if(lift <= 0){ var fr = Math.exp(-1.8*h); st.vx *= fr; st.vz *= fr; st.tgt *= fr; }   // running in: it slows on its feet
  }
  st.speed = Math.hypot(st.vx, st.vz); st.agl = st.ground ? 0 : st.y - floor(st.x, st.z);
  // level flight is powered (wingbeats); it only glides, wings still, coming down gently
  st.wing = st.ground ? "fold" : climbing ? "climb" : diving ? "dive" : hover ? "hover" : (+st.vy || 0) < -1.5 ? "glide" : "flap";
}
// a dinosaur on the ground, a serpent on the water: W / S, A / D, Shift (a dinosaur) runs
function subGround(st, inp, env, ev){
  var V = VEHICLES[st.kind] || VEHICLES.dino, h = H, I = input(inp), swim = st.kind === "serpent";
  var blocked = typeof env.blocked === "function" ? env.blocked : no, water = typeof env.water === "function" ? env.water : no;
  var ground = typeof env.ground === "function" ? env.ground : typeof env.floor === "function" ? env.floor : zero;
  st.t += h; st.bumpT = Math.max(0, st.bumpT - h);
  var top = swim ? (I.run ? V.top : V.swimSlow) : (I.run ? st.run : st.walk);
  var want = I.fwd > 0 ? top*I.fwd : I.fwd < 0 ? V.rev*I.fwd : 0;
  st.gs = springTo(st.gs, want, Math.abs(want) > Math.abs(st.gs) ? V.acc*0.4 : V.dec*0.35, h);   // gathering pace, pulling up
  var sl = clamp(Math.abs(st.gs)/Math.max(1, V.top), 0, 1);
  st.rate = springTo(st.rate, I.turn*V.yawR*(1 - 0.35*sl)*(Math.abs(st.gs) > 0.2 || !swim ? 1 : 0.6), 6, h);
  st.yaw = wrapPi(st.yaw + st.rate*h);
  var sy = Math.sin(st.yaw), cy = Math.cos(st.yaw), nx = st.x + sy*st.gs*h, nz = st.z + cy*st.gs*h;
  // a serpent keeps to open water; a dinosaur to where you can walk
  var stop = swim ? !water(nx, nz) : blocked(nx, nz);
  if(stop){ st.gs *= -0.15; if(st.bumpT <= 0){ ev.push({type: "bump"}); st.bumpT = 0.5; } }
  else { st.x = nx; st.z = nz; }
  st.y = swim ? (typeof env.waterY === "function" ? +env.waterY(st.x, st.z) || 0 : ground(st.x, st.z)) : ground(st.x, st.z);
  st.vx = sy*st.gs; st.vz = cy*st.gs; st.vy = 0; st.speed = Math.abs(st.gs); st.ground = true; st.agl = 0;
  st.roll = springTo(st.roll, swim ? clamp(-st.rate*0.3*sl, -0.3, 0.3) : 0, 4, h); st.pitch = springTo(st.pitch, 0, 4, h);
  st.wing = "fold";
}
// who may get off, where: a dragon landed or near the ground; a serpent beside land (its rider steps ashore); a dinosaur anywhere
function canDismount(st, env){
  if(!st) return {ok: true, why: null};
  env = env || {};
  if(st.kind === "dragon") return st.ground || st.agl <= DISMOUNT_H ? {ok: true, why: null} : {ok: false, why: "high"};
  if(st.kind === "serpent"){
    var water = typeof env.water === "function" ? env.water : no;
    for(var i = 0; i < 8; i++){ var a = i*PI/4, x = st.x + Math.sin(a)*3, z = st.z + Math.cos(a)*3; if(!water(x, z)) return {ok: true, why: null, x: x, z: z}; }
    return {ok: false, why: "water"};
  }
  return {ok: true, why: null};
}

/* ---------- the mount: the pet's own model, big, with a saddle (THREE only from here on) ---------- */
// one geometry from parts (meshes placed in the same parent)
function bake(T, parts){
  var pos = [], nor = [];
  parts.forEach(function(m){
    m.updateMatrix(); var q = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone(); q.applyMatrix4(m.matrix);
    pos.push.apply(pos, q.attributes.position.array); nor.push.apply(nor, q.attributes.normal.array); q.dispose(); m.geometry.dispose();
  });
  var out = new T.BufferGeometry();
  out.setAttribute("position", new T.Float32BufferAttribute(pos, 3)); out.setAttribute("normal", new T.Float32BufferAttribute(nor, 3));
  out.computeBoundingSphere(); return out;
}
function mountModel(c, pet){
  var T = c.THREE, P = HQV.hqPets; if(!T || !P) return null;
  pet = pet || {};
  var sp = P.speciesOf(pet.species != null ? pet.species : pet.sp && pet.sp.id); if(!sp || !rideKind(sp)) return null;
  var acc = (pet.acc | 0) & ~P.ACC.saddle;                                 // ours instead: the pet's is pet-sized
  var stage = sp.grows ? 2 : 0, M = P.model(T, {species: sp.id, variant: pet.variant | 0, acc: acc, stage: stage, name: pet.name || ""});
  var RS = scaleOf(sp), s = M.scale*RS, d = M.dims, rk = rideKind(sp);
  M.g.scale.setScalar(RS); M.seed = P.hashStr("ride:" + sp.id + ":" + (pet.name || ""));
  P.upgrade(c, M);
  var g = new T.Group(); g.name = "petride"; g.add(M.g);
  // where you sit: on the back, just behind the shoulders (a serpent: its first coils, a long neck: further back)
  var top = rk === "serpent" ? (d.H*0.5 + 0.12)*s : (d.cy + d.H*0.48)*s, zs = rk === "serpent" ? d.L*0.1*s : (sp.neck ? -0.05 : 0.08)*d.L*s;
  if(M.seat){ top = M.seat[0]*s + 0.02; zs = M.seat[1]*s; }               // [3.18.1] the wyvern: between its wing-shoulders, held there in every gait
  function anchor(x, y, z){ var o = new T.Object3D(); o.position.set(x, y, z); g.add(o); return o; }
  var leather = c.mat ? c.mat(0x6a3a1e, {roughness: 0.75}) : new T.MeshStandardMaterial({color: 0x6a3a1e, roughness: 0.75});
  var cloth = c.mat ? c.mat(0xb8323a, {roughness: 0.85}) : new T.MeshStandardMaterial({color: 0xb8323a, roughness: 0.85});
  var bw = Math.max(0.55, d.W*s*1.05);
  var blanket = new T.Mesh(new T.BoxGeometry(bw, 0.06, 0.95), cloth); blanket.position.set(0, top - 0.02, zs); blanket.name = "petride-blanket"; g.add(blanket);
  var seatM = new T.Mesh(new T.CylinderGeometry(0.26, 0.3, 0.16, 12, 1), leather); seatM.scale.set(1, 1, 1.5); seatM.position.set(0, top + 0.08, zs); seatM.name = "petride-saddle"; g.add(seatM);
  // the reins: a pommel on the saddle's front, a short leather handle held over it in both hands (where hq3d's rider,
  // games/people3d.js, reaches comfortably), straps from its ends down to the neck; stirrups by the flanks
  var tack = [], part = function(geo, x, y, z){ var m = new T.Mesh(geo); m.position.set(x, y, z); tack.push(m); return m; };
  part(new T.CylinderGeometry(0.035, 0.045, 0.14, 8), 0, top + 0.22, zs + 0.3);
  var gy = top + 0.4, gz = zs + 0.54, nk = new T.Vector3(0, top + 0.12, zs + Math.max(0.75, 0.42*d.L*s));
  var rod = function(a, b2, r){ var v = b2.clone().sub(a), m = part(new T.CylinderGeometry(r, r, v.length(), 6), 0, 0, 0);
    m.position.copy(a).add(b2).multiplyScalar(0.5); m.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), v.normalize()); };
  rod(new T.Vector3(0.15, gy, gz), new T.Vector3(-0.15, gy, gz), 0.016);
  [1, -1].forEach(function(sx){ rod(new T.Vector3(sx*0.14, gy, gz), nk.clone().setX(sx*0.08), 0.008); });
  var fx = bw*0.5 + 0.03;
  [1, -1].forEach(function(sx){ part(new T.BoxGeometry(0.05, 0.03, 0.14), sx*fx, top - 0.34, zs + 0.12);
    rod(new T.Vector3(sx*(bw*0.5 - 0.02), top + 0.02, zs), new T.Vector3(sx*fx, top - 0.33, zs + 0.1), 0.01); });
  var tackM = new T.Mesh(bake(T, tack), leather); tackM.name = "petride-tack"; tackM.castShadow = true; g.add(tackM);   // one draw
  var B = {g: g, M: M, sp: sp, rk: rk, s: s, RS: RS, kind: rk, lean: 0.15, riderK: 1, hats: true, knees: 0.0, brake: function(){},
           seat: anchor(0, top + 0.16, zs - 0.05),
           grips: [anchor(0.12, gy, gz), anchor(-0.12, gy, gz)],
           feet: [anchor(fx, top - 0.34, zs + 0.12), anchor(-fx, top - 0.34, zs + 0.12)],
           pst: P.newState(M.seed, 0, 0, 0), saddle: [blanket, seatM], tack: tackM};
  B.pst.anim = "stand";
  var mw = null;
  // the mouth in the world (the breath comes from it); the head's front when the pose has not said where yet
  B.mouth = function(out){
    g.updateMatrixWorld(true);
    if(M.mouthP){ mw = mw || M.mouthP.clone(); return M.P.localToWorld((out || mw).copy(M.mouthP)); }
    var v = out || new T.Vector3(); v.set(0, (d.cy + d.H*0.7)*s, (d.L*0.75 + d.hr*2)*s); return g.localToWorld(v);
  };
  B.dispose = function(){ M.dead = true; if(M.rig){ M.rig.mixer.stopAllAction(); M.rig.mixer.uncacheRoot(M.rig.root); }
    g.traverse(function(o){ if((o.isMesh || o.isInstancedMesh) && o.geometry && !o.geometry.userData.shared) o.geometry.dispose(); }); };
  return B;
}
// the pet's pose from the ride: a dragon's wings (st.wing), a walker's gait at its speed (in its own size)
function animate(B, st, t, dt, calm, breath, vol){
  if(!B || !B.M || !HQV.hqPets) return;
  var ps = B.pst, sp = B.sp, v = Math.abs(+st.speed || 0), pv = v/(B.RS || 1);
  ps.yaw = +st.yaw || 0; ps.speed = pv; ps.wing = null;
  ps.agl = +st.agl || 0; ps.vy = +st.vy || 0; ps.leap = (+st.leapT || 0) > 0;   // the wyvern: its takeoff leap and its landing flare
  ps.breath = false;
  if(B.rk === "dragon" && !st.ground){ ps.anim = "fly"; ps.wing = st.wing || "glide"; ps.ph += dt*3.2; ps.breath = !!breath; }   // breathing on the wing: jaw open, wings still working
  else if(B.rk === "serpent"){ ps.anim = v > 0.3 ? "swim" : "float"; ps.wet = true; ps.ph += Math.max(0.6, pv)*dt*2.2; }
  else { ps.anim = breath ? "breath" : v > 0.25 ? (v > (st.walk || 4)*1.15 ? "run" : "walk") : "stand"; ps.ph += pv*dt*(sp.kind === "dino" ? 2.2 : 2.2); }
  HQV.hqPets.pose(B.M, ps, t, !!calm, null);
  // its wingbeats (hqPets counts them, Mo.beats): yours at full, someone else's by how far (vol); none in Calm
  if(B.M.beats !== B.lb){ B.lb = B.M.beats; var v2 = vol == null ? 1 : +vol || 0; if(!calm && v2 > 0.02 && HQV.hqPets.sfx) HQV.hqPets.sfx("wing", {vol: v2, size: 2}); }
}
// someone else's mount, from their presence: v (m/s across the ground), vy (m/s up), agl (m over the ground)
function peerState(B, v, vy, agl){
  var st = B.peer || (B.peer = {speed: 0, ground: true, wing: "fold", yaw: 0, walk: 3});
  st.speed = v; st.ground = !(B.rk === "dragon" && agl > 1.2);
  st.wing = st.ground ? "fold" : vy > 1.2 ? "climb" : vy < -5 ? "dive" : v < VEHICLES.dragon.hover ? "hover" : vy < -1.5 ? "glide" : "flap";
  return st;
}
// the breath: a stream forward from the mouth, carried along at the dragon's speed (none at all in Calm: breathOf)
function breathe(F, B, st, dt, kind){
  if(!F || !B || !kind) return;
  if(B.M && B.M.fx) kind = BREATH[B.M.fx] || B.M.fx;                        // the wyvern breathes by its colour (fire, smoke, venom, ice)
  // a dragon you ride pours a real stream: a long, flared core on the jaw (seen from the chase camera behind, a short one
  // read as a glow at the head) and puffs fed in at stations down it, by the ticks the frame covered (a slow frame pours
  // as much as three fast ones); the wyvern and the others keep their short breath
  var big = B.rk === "dragon", m = B.mouth(), yaw = +st.yaw || 0, fx = Math.sin(yaw), fz = Math.cos(yaw);
  // (a dragon pours it down ahead onto the street, under the chase camera's line of sight: straight down the lens it read as a dot)
  var dy = (big ? -0.42 : -0.12) - (+st.pitch || 0)*0.6, n = 1/Math.sqrt(1 + dy*dy), L = big ? 9 : 0, sp = Math.abs(+st.speed || 0) + (big ? 22 : 16);
  if(F.jet){ if(big) F.jet(B, kind, m.x, m.y, m.z, fx*n, dy*n, fz*n, L, 1.4, 1.7); else F.jet(B, kind, m.x, m.y, m.z, fx, -0.1 - (+st.pitch || 0)*0.6, fz); }   // the core on the jaw, every frame (hqPets Fx)
  B.acc = (B.acc || 0) + dt; if(B.acc < 1/45) return;
  var tk = Math.min(4, Math.floor(B.acc*45)); B.acc = Math.min(1/45, B.acc - tk/45);
  var lift = (+st.vy || 0) + (big ? dy*n*sp : -(st.pitch || 0)*6);
  if(!big) F.emit(kind, m.x + fx*0.4, m.y, m.z + fz*0.4, 4*tk, fx, fz, sp, 2.6, 0.7, lift);
  else {
    var sub = kind === "fire" ? "ember" : kind === "ice" ? "snow" : kind, S = [[0.1, 9, 1, 3], [0.45, 7, 0.8, 4.4], [0.8, 5, 0.6, 5.6]];
    for(var i = 0; i < S.length; i++){ var d = L*S[i][0], px = m.x + fx*n*d, py = m.y + dy*n*d, pz = m.z + fz*n*d;
      F.emit(kind, px, py, pz, S[i][1]*tk, fx, fz, sp*n*S[i][2], S[i][3], 1 + i*0.1, lift*S[i][2]);
      if(i === 1) F.emit(sub, px, py - 0.1, pz, 5*tk, fx, fz, sp*n*0.85, 5, 1.2, lift*0.7); }
    if(kind === "fire") F.emit("smoke", m.x + fx*n*L, m.y + dy*n*L + 0.6, m.z + fz*n*L, 3*tk, fx, fz, sp*0.3, 4, 1.6, 1.6);   // the smoke rolling off its end
  }
  if(B.sp.fx === "storm" && F.zap && (Math.floor((st.t || 0)*9) % 3) === 0) F.zap(m.x + fx*(big ? 5 : 3), m.y - 0.6, m.z + fz*(big ? 5 : 3));
}

HQV.hqPetRide = {VEHICLES: VEHICLES, DINO: DINO, RIDE_DINO: RIDE_DINO, A_CODE: A_CODE, REACH: REACH, SERPENT_REACH: SERPENT_REACH,
  DISMOUNT_H: DISMOUNT_H, STAGE_GROWN: STAGE_GROWN, H: H, rideKind: rideKind, grown: grown, canMount: canMount, scaleOf: scaleOf,
  breathOf: breathOf, newState: newState, step: step, canDismount: canDismount, mountModel: mountModel, animate: animate,
  peerState: peerState, breathe: breathe};
})();
