/* games/hqgrenade.js: the grenade launcher in the 3D City (HQ 3.16), HQV.hqGrenade.
 *
 * X takes the launcher out (it rides on your left shoulder), F or a click with the mouse captured (Mouse steering)
 * fires a grenade where the camera looks, lofted a little. It arcs, bounces off the ground, walls and roofs, sinks in
 * water, and goes off after its fuse: a fireball, a smoke ring, a boom. The City has no health: a blast knocks you
 * back (and up), whoever fired it, yourself included; in a car it shoves you and dents it.
 *
 * Multiplayer without a referee: each shot travels in its shooter's presence frames for a moment
 * (`gn`: [s, x, y, z, vx, vy, vz, k, a], cm, cm/s, its kind and age in ms; valley/hq.rs checks every number), and
 * every page flies it itself from that launch, in fixed steps against the same world, so all of them see the same
 * arc and the same blast; each page then knocks back only its own player, who sends where they land as usual.
 * Only numbers about the shot travel; nothing transcript-derived.
 *
 * The flight and the knock-back are pure (tests/test_hqgrenade.py runs them under node); fx() draws them with three.js.
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};

var G = 9.81, DT = 1/60;
// kinds: 0 the launcher's grenade (bounces, a fuse), 1 the tank's shell (HQ 3.17, games/hqtank.js: goes off on whatever
// it touches first, its fuse only a limit). fuse s, blast radius m, the push (m/s, sideways) and lift (m/s, up) at its
// heart, falling to 0 at the edge, the muzzle speed m/s.
var KINDS = [{fuse: 1.8, blast: 6, push: 16, lift: 7.5, muzzle: 20},
             {fuse: 4, blast: 8, push: 20, lift: 9, muzzle: 38, impact: true}];
var LOFT = 0.55;                     // rad above where the camera looks (a chase camera looks down ~0.4): a lob
var PITCH_MIN = -0.35, PITCH_MAX = 1.25;
var BOUNCE = 0.4, ROLL = 0.7, R = 0.09, REST_V = 0.35;
var COOL = 0.75;                     // s between shots
var KEEP = 1.5;                      // s a shot stays in your presence frames (8 a second: none is missed)
// the Arena's bounds (backend/src/valley/hq.rs): a shot outside them would drop your whole frame
var WIRE = {xz: 102400, y: 50000, v: 6000, s: 65535, age: 2000, n: 4, kMax: 1};

function num(v, d){ v = +v; return isFinite(v) ? v : d; }
function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }
function kindOf(k){ return KINDS[k | 0] || KINDS[0]; }

// The launch velocity from where the camera looks (fwd: a direction, any length) for kind k: its yaw, its pitch
// lofted by LOFT and kept within PITCH_MIN..PITCH_MAX, at the kind's muzzle speed. -> {vx, vy, vz}
function aim(fwd, k){
  fwd = fwd || {};
  var fx = num(fwd.x, 0), fy = num(fwd.y, 0), fz = num(fwd.z, 1), h = Math.hypot(fx, fz), l = Math.hypot(h, fy);
  if(!(l > 1e-9)){ fx = 0; fy = 0; fz = 1; h = 1; l = 1; }
  var yaw = h > 1e-9 ? Math.atan2(fx, fz) : 0, p = clamp(Math.asin(clamp(fy/l, -1, 1)) + LOFT, PITCH_MIN, PITCH_MAX), sp = kindOf(k).muzzle;
  return {vx: Math.sin(yaw)*Math.cos(p)*sp, vy: Math.sin(p)*sp, vz: Math.cos(yaw)*Math.cos(p)*sp};
}

// A shot in flight. o: {s, k, x, y, z, vx, vy, vz}
function shot(o){
  o = o || {};
  return {s: (o.s | 0) & 0xffff, k: o.k | 0, x: num(o.x, 0), y: num(o.y, 0), z: num(o.z, 0), vx: num(o.vx, 0), vy: num(o.vy, 0), vz: num(o.vz, 0),
          t: 0, n: 0, done: false, wet: false, rest: false, bounced: 0};
}

// One fixed step. env: {ground(x, z) -> y, hit(a, b) -> 0..1 (1: clear; where a building blocks the segment a-b),
// water(x, z) -> its surface y or null}; each optional. -> the blast {x, y, z, k, wet} on the step it goes off.
function step(g, env){
  env = env || {};
  var K = kindOf(g.k);
  g.n++; g.t = g.n*DT;
  if(g.t >= K.fuse - 1e-9){ g.done = true; return {x: g.x, y: g.y, z: g.z, k: g.k, wet: g.wet}; }
  if(g.wet){ g.y -= 1.2*DT; return null; }                       // sinking
  if(g.rest) return null;
  var nx = g.x + g.vx*DT, nz = g.z + g.vz*DT, ny = g.y + g.vy*DT - 0.5*G*DT*DT;
  g.vy -= G*DT;
  var wy = env.water ? env.water(nx, nz) : null;
  if(wy != null && isFinite(wy) && ny <= wy){
    g.x = nx; g.z = nz; g.y = wy; g.vx = 0; g.vy = 0; g.vz = 0; g.wet = true;
    if(K.impact){ g.done = true; return {x: g.x, y: g.y, z: g.z, k: g.k, wet: true}; }
    return null;
  }
  var gy = env.ground ? num(env.ground(nx, nz), 0) : 0;
  if(ny > gy + R && env.hit){
    var a = {x: g.x, y: g.y, z: g.z};
    if(env.hit(a, {x: nx, y: ny, z: nz}) < 1){
      if(K.impact){ g.done = true; return {x: g.x, y: g.y, z: g.z, k: g.k, wet: false}; }   // a shell: on the wall
      // which face it met: the move along x alone, along z alone (a wall), else from above or below (a roof)
      var hx = env.hit(a, {x: nx, y: g.y, z: g.z}) < 1, hz = env.hit(a, {x: g.x, y: g.y, z: nz}) < 1;
      if(hx) g.vx = -g.vx*BOUNCE;
      if(hz) g.vz = -g.vz*BOUNCE;
      if(!hx && !hz){ g.vy = -g.vy*BOUNCE; g.vx *= ROLL; g.vz *= ROLL; }
      g.bounced++;
      return null;                                               // it stays where it was this step
    }
  }
  if(ny <= gy + R){
    ny = gy + R;
    if(K.impact){ g.x = nx; g.y = ny; g.z = nz; g.done = true; return {x: g.x, y: g.y, z: g.z, k: g.k, wet: false}; }
    if(g.vy < 0) g.vy = Math.abs(g.vy) < 1.5 ? 0 : -g.vy*BOUNCE;
    g.vx *= ROLL; g.vz *= ROLL; g.bounced++;
    if(g.vy === 0 && Math.hypot(g.vx, g.vz) < REST_V){ g.vx = 0; g.vz = 0; g.rest = true; }
  }
  g.x = nx; g.y = ny; g.z = nz;
  return null;
}

// Fly g on to `to` seconds after its launch, in whole steps (so every page lands on the same steps at any frame
// rate). -> the blast, on the call it goes off; null otherwise.
function advance(g, env, to){
  var b = null, guard = 0;
  to = num(to, 0);
  while(!g.done && (g.n + 1)*DT <= to + 1e-9 && guard++ < 600){ var r = step(g, env); if(r) b = r; }
  return b;
}

// What a blast b does to someone whose middle is at (px, py, pz): null outside it; else the way out from its heart
// (dx, dz: a unit vector; 0, 0 straight above it) and the push and lift there, falling linearly to the edge.
function knock(b, px, py, pz){
  if(!b) return null;
  var K = kindOf(b.k), dx = num(px, 0) - b.x, dy = num(py, 0) - b.y, dz = num(pz, 0) - b.z, d = Math.sqrt(dx*dx + dy*dy + dz*dz);
  if(!(d < K.blast)) return null;
  var s = 1 - d/K.blast, h = Math.hypot(dx, dz);
  if(b.wet) s *= 0.4;                                            // under water most of it goes into the splash
  return {dx: h > 0.05 ? dx/h : 0, dz: h > 0.05 ? dz/h : 0, push: K.push*s, lift: K.lift*s, s: s};
}

// The presence form of a shot age ms old, every number inside the Arena's bounds (or null when it cannot be).
function toWire(g, ageMs){
  if(!g) return null;
  var r = function(v, m){ v = Math.round(num(v, 0)); return v >= -m && v <= m ? v : null; };
  var w = [(g.s | 0) & 0xffff, r(g.x*100, WIRE.xz), r(g.y*100, WIRE.y), r(g.z*100, WIRE.xz),
           clamp(Math.round(num(g.vx, 0)*100), -WIRE.v, WIRE.v), clamp(Math.round(num(g.vy, 0)*100), -WIRE.v, WIRE.v),
           clamp(Math.round(num(g.vz, 0)*100), -WIRE.v, WIRE.v), clamp(g.k | 0, 0, WIRE.kMax), clamp(Math.round(num(ageMs, 0)), 0, WIRE.age)];
  return w[1] == null || w[2] == null || w[3] == null ? null : w;
}
// Someone's shot from their frame: {s, k, x, y, z, vx, vy, vz, age (s)}, or null when anything is off.
function fromWire(a){
  if(!Array.isArray(a) || a.length !== 9) return null;
  for(var i = 0; i < 9; i++) if(typeof a[i] !== "number" || !isFinite(a[i]) || Math.round(a[i]) !== a[i]) return null;
  if(a[0] < 0 || a[0] > WIRE.s || Math.abs(a[1]) > WIRE.xz || Math.abs(a[3]) > WIRE.xz || Math.abs(a[2]) > WIRE.y) return null;
  if(Math.abs(a[4]) > WIRE.v || Math.abs(a[5]) > WIRE.v || Math.abs(a[6]) > WIRE.v || a[7] < 0 || a[7] > WIRE.kMax || a[8] < 0 || a[8] > WIRE.age) return null;
  return {s: a[0], x: a[1]/100, y: a[2]/100, z: a[3]/100, vx: a[4]/100, vy: a[5]/100, vz: a[6]/100, k: a[7], age: a[8]/1000};
}

/* ---------- drawing (three.js) ---------- */
function toon(T, c){ return new T.MeshToonMaterial({color: c}); }
function glowTex(T, inner, mid){
  var c = document.createElement("canvas"); c.width = c.height = 128; var x = c.getContext("2d");
  var gr = x.createRadialGradient(64, 64, 4, 64, 64, 62);
  gr.addColorStop(0, inner); gr.addColorStop(0.45, mid); gr.addColorStop(1, "rgba(0,0,0,0)");
  x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
  var t = new T.CanvasTexture(c); if(T.SRGBColorSpace) t.colorSpace = T.SRGBColorSpace; return t;
}
// The launcher: a stubby olive tube with a hazard band, a grip, a sight and an orange muzzle ring, long axis along +z
// (the way you face), in metres. Original geometry.
function launcherModel(T){
  var g = new T.Group(), body = toon(T, 0x5b6b3a), dark = toon(T, 0x22261c), band = toon(T, 0xffc23d), hot = toon(T, 0xff7b29);
  function cyl(r0, r1, h, m, x, y, z){ var o = new T.Mesh(new T.CylinderGeometry(r0, r1, h, 16), m); o.rotation.x = Math.PI/2; o.position.set(x, y, z); g.add(o); return o; }
  function box(w, h, d, m, x, y, z){ var o = new T.Mesh(new T.BoxGeometry(w, h, d), m); o.position.set(x, y, z); g.add(o); return o; }
  cyl(0.075, 0.075, 0.78, body, 0, 0, 0.05);
  cyl(0.088, 0.088, 0.1, band, 0, 0, -0.16);
  cyl(0.095, 0.085, 0.07, hot, 0, 0, 0.45);
  cyl(0.06, 0.06, 0.02, dark, 0, 0, 0.485);
  cyl(0.085, 0.07, 0.08, dark, 0, 0, -0.36);
  box(0.05, 0.14, 0.06, dark, 0, -0.11, 0.08);                  // the grip
  box(0.03, 0.06, 0.12, dark, 0, 0.1, 0.12);                    // the sight
  g.traverse(function(o){ if(o.isMesh) o.castShadow = true; });
  return g;
}
// One page's drawing of every grenade and blast: fx(THREE, scene) -> {ball(), blast(x, y, z, k, wet, calm),
// step(dt), attach(scene)}. ball() is a mesh to place each frame and .free() when done. Calm: a smoke puff only.
function fx(T, scene){
  var K = {shell: toon(T, 0x3f4a2a), band: toon(T, 0xffc23d), fire: glowTex(T, "rgba(255,250,215,1)", "rgba(255,120,30,.9)"),
           smoke: glowTex(T, "rgba(90,86,80,.85)", "rgba(70,66,60,.45)"), water: glowTex(T, "rgba(235,250,255,1)", "rgba(150,210,240,.6)")};
  var root = new T.Group(); root.name = "hqgrenade"; if(scene) scene.add(root);
  var pool = [], booms = [];
  function ball(){
    var m = pool.pop();
    if(!m){
      m = new T.Group();
      var s = new T.Mesh(new T.SphereGeometry(R, 12, 10), K.shell); s.castShadow = true; m.add(s);
      var b = new T.Mesh(new T.CylinderGeometry(R*1.02, R*1.02, R*0.5, 12), K.band); m.add(b);
      m.free = function(){ m.visible = false; pool.push(m); };
    }
    m.visible = true; if(m.parent !== root) root.add(m);
    return m;
  }
  function sprite(tex, add){
    var s = new T.Sprite(new T.SpriteMaterial({map: tex, transparent: true, depthWrite: false, toneMapped: false, blending: add ? T.AdditiveBlending : T.NormalBlending}));
    root.add(s); return s;
  }
  function blast(x, y, z, k, wet, calm){
    var Kd = kindOf(k), b = {t: 0, x: x, y: y, z: z, R: Kd.blast, calm: !!calm, wet: !!wet, parts: []};
    if(!calm && !wet){ var f = sprite(K.fire, true); f.position.set(x, y + 0.4, z); b.parts.push({s: f, kind: "fire"}); }
    var sm = sprite(wet ? K.water : K.smoke, false); sm.position.set(x, y + (wet ? 0.6 : 0.8), z); b.parts.push({s: sm, kind: wet ? "spray" : "smoke"});
    if(!calm){
      var ring = new T.Mesh(new T.RingGeometry(0.8, 1, 40), new T.MeshBasicMaterial({color: wet ? 0xd8f4ff : 0xffe2b0, transparent: true, opacity: 0.6, depthWrite: false, toneMapped: false, side: T.DoubleSide}));
      ring.rotation.x = -Math.PI/2; ring.position.set(x, y + 0.08, z); root.add(ring); b.parts.push({s: ring, kind: "ring"});
    }
    booms.push(b);
    return b;
  }
  function step(dt){
    for(var i = booms.length - 1; i >= 0; i--){
      var b = booms[i]; b.t += dt;
      var life = b.calm ? 1.2 : 1.6, f = b.t/life;
      b.parts.forEach(function(p){
        var s = p.s, m = s.material;
        if(p.kind === "fire"){ var q = Math.min(1, b.t/0.35), sz = 1.2 + (b.R*1.3 - 1.2)*(1 - Math.pow(1 - q, 3)); s.scale.set(sz, sz, 1); m.opacity = Math.max(0, 1 - b.t/0.5); }
        else if(p.kind === "ring"){ var r = 1 + b.R*Math.min(1, b.t/0.3); s.scale.set(r, r, 1); m.opacity = Math.max(0, 0.6*(1 - b.t/0.45)); }
        else { var sm = (b.calm ? 1.5 : 2) + b.t*(p.kind === "spray" ? 3 : 2.2); s.scale.set(sm, sm, 1); s.position.y = b.y + 0.8 + b.t*0.9; m.opacity = Math.max(0, 0.85*(1 - f)); }
      });
      if(f >= 1){ b.parts.forEach(function(p){ root.remove(p.s); if(p.s.geometry && p.kind === "ring") p.s.geometry.dispose(); p.s.material.dispose(); }); booms.splice(i, 1); }
    }
  }
  function attach(s){ if(s && root.parent !== s){ if(root.parent) root.parent.remove(root); s.add(root); } }
  // another floor: every blast gone at once (the balls are freed by their owner)
  function clear(){ booms.forEach(function(b){ b.parts.forEach(function(p){ root.remove(p.s); p.s.material.dispose(); }); }); booms.length = 0; }
  return {ball: ball, blast: blast, step: step, attach: attach, clear: clear, root: root, busy: function(){ return booms.length; }};
}
// The boom: shaped brown noise through a low-pass, heard within BOOM_M (as the fireworks are), late by the distance
// over the speed of sound. out: engine.js audioOut() ({ctx, out}), so the sound volume (and Calm's 0) applies.
var BOOM_M = 400, boomBuf = null;
function boomVol(dist){ dist = +dist; return isFinite(dist) && dist >= 0 && dist < BOOM_M ? 0.7*Math.pow(1 - dist/BOOM_M, 2) : 0; }
function boom(out, dist, wet){
  var vol = boomVol(dist); if(!(vol > 0) || !out || !out.ctx) return;
  try {
    var ac = out.ctx;
    if(!boomBuf || boomBuf.sampleRate !== ac.sampleRate){
      var n = Math.floor(ac.sampleRate*1.4), last = 0, seed = 7; boomBuf = ac.createBuffer(1, n, ac.sampleRate); var d = boomBuf.getChannelData(0);
      var rnd = function(){ seed = (seed*1103515245 + 12345) % 2147483648; return seed/2147483648; };
      for(var q = 0; q < n; q++){ var tq = q/ac.sampleRate; last = (last + 0.07*(rnd()*2 - 1))/1.07; d[q] = (last*6 + (tq < 0.04 ? (rnd()*2 - 1)*0.9 : 0))*Math.exp(-tq*4); }
    }
    var src = ac.createBufferSource(), lp = ac.createBiquadFilter(), gn = ac.createGain();
    src.buffer = boomBuf; src.playbackRate.value = wet ? 0.6 : 0.95;
    lp.type = "lowpass"; lp.frequency.value = wet ? 380 : 500 + 1800*Math.max(0, 1 - dist/BOOM_M);
    gn.gain.value = vol;
    src.connect(lp); lp.connect(gn); gn.connect(out.out); src.start(ac.currentTime + dist/343);
  } catch(e){}
}

HQV.hqGrenade = {G: G, DT: DT, KINDS: KINDS, LOFT: LOFT, COOL: COOL, KEEP: KEEP, WIRE: WIRE, R: R,
                 aim: aim, shot: shot, step: step, advance: advance, knock: knock, toWire: toWire, fromWire: fromWire,
                 launcherModel: launcherModel, fx: fx, boom: boom, boomVol: boomVol};
})();
