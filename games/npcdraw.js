/* Claude HQ: drawing the City's residents (Cities spec, task cl-npc), on top of games/npcsim.js.
 *
 * HQV.npcDraw.create(THREE, parent, sim, opts) -> draw. Levels of detail by distance from the camera
 * (its height too, when cam.y is given: the map's camera high over the plaza draws nobody skinned):
 *   under NEAR (40 m)   up to MAX_NEAR (30) skinned Kenney characters (the six of hq3d.js, look.char picks
 *                       one, the outfit tints their material) playing walk / idle, nudged around the
 *                       player and each other (avoid: a spring toward a capped push, so the pure sim
 *                       position is never far off). Out at NEAR_OUT (44 m), so the edge does not flicker.
 *   NEAR..FAR (150 m)   up to MAX_FAR (120) instances of one low-poly body (bodyGeometry, 6 boxes) in one
 *                       draw call; a vertex shader swings the legs and arms from a per-instance gait
 *                       (phase, cycles/s, swing), the outfit comes from per-instance colours.
 *   over FAR            not drawn (sim.at is asked for FAR only).
 * Anims from the sim: walk, idle, drive, and with the city (npcsim opts.city) "lie" (a patient: the character's
 * "die" clip held at its end, or the idle pose tipped onto its back; a far body lies flat) and "cheer" (fans:
 * the "emote-yes" clip, or idle; a far body waves both arms overhead: a negative gait swing in the shader).
 * A near resident whose character is still loading is drawn as a body until it is ready. Drivers
 * (anim "drive") are inside their cars, which games/traffic.js draws; riders on a bus are not in sim.at.
 *   draw.update(tMs, cam {x, y?, z}, player {x, z} | null, dt)   once a frame; tMs is the City's local clock
 *   draw.talk(player {x, z}, tMs) -> {id, text, x, y, z} | null   E on a resident: the nearest drawn one
 *                       within TALK_REACH says a line from its job and the time (sim.speak; plain text,
 *                       show it with textContent)
 *   draw.setLoader(fn)  the character hook: fn(look, cb) loads look.char's character and calls
 *                       cb({o, mixer, acts: {idle, walk}}) (hq3d.js's makeCharacter shape). Without one,
 *                       opts.lib (an engine lib) loads them the way hq3d.js does (HQV.engine.loadGlb).
 *   draw.stats          {near, far, loading, ms} of the last update; draw.dispose()
 * split, avoid, packFar, colours, bodyGeometry and pickTalk are pure (node-tested in tests/test_npcdraw.py).
 * Frames as npcsim.js: metres, +y up, yaw 0 faces +z.
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : self;
var HQV = root.HQV = root.HQV || {};

var NEAR = 40, NEAR_OUT = 44, FAR = 150;
var MAX_NEAR = 30, MAX_FAR = 120;
var POOL_SPARE = 6;                 // characters kept loaded beyond MAX_NEAR, for the near set's churn
// the six Kenney Mini Characters, as hq3d.js CHAR_FILES (index = look.char)
var CHAR_FILES = ["character-female-a", "character-male-a", "character-female-c", "character-male-c", "character-female-e", "character-male-e"];
var CH_H = 0.72, BODY_H = 1.7;      // a character's model height (hq3d.js CH_H) and the drawn height (m)
var AV = {player: 1.2, other: 0.7, max: 0.8, w: 7};   // avoidance: radii (m), the push cap (m), spring omega
var TURN_K = 10;                    // the yaw's ease rate (1/s)
var STRIDE = 1.5;                   // metres per walk cycle (both steps)
var WALK_CLIP = 1.4;                // the walk clip's own pace (m/s): its timeScale is speed / this
var TINT = 0.32;                    // how far a near character's material leans toward the shirt colour
var TALK_REACH = 3.2;
var WARM_MS = 0.6;                  // route planning per frame (sim.warm), ms
var CLIPS = {idle: "idle", walk: "walk", lie: "die", cheer: "emote-yes"};   // our anim -> the Kenney clip
var LIE_UP = 0.15;                  // a body tipped onto its back is lifted this much (m), out of the ground
var CHEER = {hz: 1.6, swing: 0.3};  // far bodies cheering: arm waves per second, wave (rad)

/* ---------- pure helpers ---------- */
// Critically damped spring, exact closed form (as hq3d.js): -> [x, v]
function spring(x, v, goal, omega, dt){
  x = +x || 0; v = +v || 0; dt = Math.max(0, +dt || 0);
  var c1 = x - goal, c2 = v + omega*c1, e = Math.exp(-omega*dt);
  return [goal + (c1 + c2*dt)*e, (c2 - omega*(c1 + c2*dt))*e];
}
function ease(k, dt){ return 1 - Math.exp(-Math.max(0, +k || 0)*Math.max(0, +dt || 0)); }
function wrapPi(a){ a = +a || 0; return Math.atan2(Math.sin(a), Math.cos(a)); }
function frac(id){ var h = Math.imul((id | 0) + 0x9e3779b9, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return (h >>> 0)/4294967296; }

// sim.at's list (nearest first) -> {near, far}: near = under NEAR (NEAR_OUT for those near last frame,
// prev = {id: 1}), at most MAX_NEAR, nearest first; far = the rest under FAR, at most MAX_FAR. Drivers skipped.
function split(list, prev, o){
  o = o || {}; prev = prev || {};
  var nearR = o.near != null ? +o.near : NEAR, outR = o.nearOut != null ? +o.nearOut : NEAR_OUT, farR = o.far != null ? +o.far : FAR;
  var nMax = o.maxNear != null ? o.maxNear | 0 : MAX_NEAR, fMax = o.maxFar != null ? o.maxFar | 0 : MAX_FAR;
  var near = [], far = [];
  for(var i = 0; i < (list || []).length; i++){
    var r = list[i]; if(!r || r.anim === "drive") continue;
    var d2 = r.d2 != null ? r.d2 : 0, lim = prev[r.id] ? outR : nearR;
    if(d2 < lim*lim && near.length < nMax) near.push(r);
    else if(d2 < farR*farR && far.length < fMax) far.push(r);
  }
  return {near: near, far: far};
}

// Nudge near residents around the player and each other: each one's offset springs toward a push
// (away from whoever is closer than the radius, capped at AV.max). st = {id: {ox, oz, vx, vz}} carried
// between frames (ids gone from items are dropped). Sets item.ax / item.az, the drawn position.
function avoid(items, player, st, dt){
  items = items || []; st = st || {};
  var n = items.length, tx = new Float64Array(n), tz = new Float64Array(n), i, j;
  for(i = 0; i < n; i++){
    var a = items[i];
    if(player && player.x != null){
      var dx = a.x - player.x, dz = a.z - player.z, d = Math.sqrt(dx*dx + dz*dz);
      if(d < AV.player){
        var ux = dx/d, uz = dz/d;
        if(d < 1e-3){ ux = Math.cos(a.yaw || 0); uz = -Math.sin(a.yaw || 0); }   // dead on: step to its right
        tx[i] += ux*(AV.player - d); tz[i] += uz*(AV.player - d);
      }
    }
    for(j = i + 1; j < n; j++){
      var b = items[j], ex = a.x - b.x, ez = a.z - b.z, e = Math.sqrt(ex*ex + ez*ez);
      if(e >= AV.other) continue;
      var p = (AV.other - e)/2, vx = ex/e, vz = ez/e;
      if(e < 1e-3){ vx = a.id < b.id ? 1 : -1; vz = 0; }                            // one spot: part along x
      tx[i] += vx*p; tz[i] += vz*p; tx[j] -= vx*p; tz[j] -= vz*p;
    }
  }
  var seen = {};
  for(i = 0; i < n; i++){
    var it = items[i], s = st[it.id] || (st[it.id] = {ox: 0, oz: 0, vx: 0, vz: 0});
    var l = Math.sqrt(tx[i]*tx[i] + tz[i]*tz[i]);
    if(l > AV.max){ tx[i] *= AV.max/l; tz[i] *= AV.max/l; }
    var sx = spring(s.ox, s.vx, tx[i], AV.w, dt), sz = spring(s.oz, s.vz, tz[i], AV.w, dt);
    s.ox = sx[0]; s.vx = sx[1]; s.oz = sz[0]; s.vz = sz[1];
    var ol = Math.sqrt(s.ox*s.ox + s.oz*s.oz);   // the spring may overshoot a little: keep the cap
    if(ol > AV.max){ s.ox *= AV.max/ol; s.oz *= AV.max/ol; }
    it.ax = it.x + s.ox; it.az = it.z + s.oz;
    seen[it.id] = 1;
  }
  Object.keys(st).forEach(function(k){ if(!seen[k]) delete st[k]; });
  return st;
}

// sRGB hex -> linear [r, g, b] (the shader works in linear light)
function lin(hex){
  hex = hex | 0;
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map(function(c){
    c /= 255; return c <= 0.04045 ? c/12.92 : Math.pow((c + 0.055)/1.055, 2.4);
  });
}
// Per-resident linear colours, once per sim: Float32Array(9 N) = shirt, pants, skin.
function colours(sim){
  var R = (sim && sim.residents) || [], out = new Float32Array(9*Math.max(1, R.length));
  R.forEach(function(r, i){
    var L = r.look || {}, c = lin(L.shirt).concat(lin(L.pants), lin(L.skin));
    for(var k = 0; k < 9; k++) out[9*i + k] = c[k];
  });
  return out;
}
// Instance buffers for up to `cap` bodies: {cap, mat (16 per), gait (3 per), shirt, pants, skin (3 per)}.
function farBuffers(cap){
  cap = Math.max(1, cap | 0);
  return {cap: cap, mat: new Float32Array(16*cap), gait: new Float32Array(3*cap),
          shirt: new Float32Array(3*cap), pants: new Float32Array(3*cap), skin: new Float32Array(3*cap)};
}
// Writes items (sim.at entries) into the buffers B: column-major matrices (rotate yaw about +y, scale
// 1, translate; "lie": tipped onto its back first, head toward -z, lifted LIE_UP), the gait [phase (rad),
// cycles/s, swing (rad); a negative swing waves the arms overhead: "cheer"] and the outfit. -> the count written.
function packFar(items, B, cols){
  var n = Math.min((items || []).length, B.cap), M = B.mat, G = B.gait;
  for(var i = 0; i < n; i++){
    var r = items[i], c = Math.cos(r.yaw || 0), s = Math.sin(r.yaw || 0), o = 16*i;
    var x = r.ax != null ? r.ax : r.x, z = r.az != null ? r.az : r.z, lie = r.anim === "lie";
    M[o] = c; M[o+1] = 0; M[o+2] = -s; M[o+3] = 0;
    if(lie){   // yaw x (rotate -pi/2 about x): local +y (head) to -z, local +z (face) up
      M[o+4] = -s; M[o+5] = 0; M[o+6] = -c; M[o+7] = 0;
      M[o+8] = 0; M[o+9] = 1; M[o+10] = 0; M[o+11] = 0;
    } else {
      M[o+4] = 0; M[o+5] = 1; M[o+6] = 0; M[o+7] = 0;
      M[o+8] = s; M[o+9] = 0; M[o+10] = c; M[o+11] = 0;
    }
    M[o+12] = x; M[o+13] = (r.y || 0) + (lie ? LIE_UP : 0); M[o+14] = z; M[o+15] = 1;
    var walk = r.anim === "walk", cheer = r.anim === "cheer";
    G[3*i] = frac(r.id)*6.2831853; G[3*i+1] = walk ? (r.speed || 1.3)/STRIDE : (cheer ? CHEER.hz : 0); G[3*i+2] = walk ? 0.55 : (cheer ? -CHEER.swing : 0);
    if(cols){
      var k = 9*(r.id | 0);
      B.shirt[3*i] = cols[k]; B.shirt[3*i+1] = cols[k+1]; B.shirt[3*i+2] = cols[k+2];
      B.pants[3*i] = cols[k+3]; B.pants[3*i+1] = cols[k+4]; B.pants[3*i+2] = cols[k+5];
      B.skin[3*i] = cols[k+6]; B.skin[3*i+1] = cols[k+7]; B.skin[3*i+2] = cols[k+8];
    }
  }
  return n;
}

// The low-poly body, BODY_H tall, facing +z: legs, torso, arms, head as flat-shaded boxes.
// -> {pos, nrm (3 per vertex), part (0 skin, 1 shirt, 2 pants), limb (0 body, +-1 legs, +-2 arms), pivot (y), idx}
function bodyGeometry(){
  var P = [], N = [], part = [], limb = [], piv = [], idx = [];
  // [cx, y0, cz, w, h, d, part, limb, pivot]
  var BOX = [
    [-0.1, 0, 0, 0.15, 0.8, 0.17, 2, 1, 0.8], [0.1, 0, 0, 0.15, 0.8, 0.17, 2, -1, 0.8],
    [0, 0.78, 0, 0.42, 0.6, 0.24, 1, 0, 0],
    [-0.27, 0.86, 0, 0.11, 0.52, 0.13, 1, 2, 1.34], [0.27, 0.86, 0, 0.11, 0.52, 0.13, 1, -2, 1.34],
    [0, 1.4, 0.01, 0.27, 0.3, 0.27, 0, 0, 0]
  ];
  var FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  BOX.forEach(function(b){
    var hx = b[3]/2, hy = b[4]/2, hz = b[5]/2, cy = b[1] + hy;
    FACES.forEach(function(f){
      // two tangents u, v with u x v = f, so the quad (0, 1, 2), (0, 2, 3) winds counter-clockwise from outside
      var u = f[0] ? [0, 1, 0] : f[1] ? [0, 0, 1] : [1, 0, 0];
      var v = [f[1]*u[2] - f[2]*u[1], f[2]*u[0] - f[0]*u[2], f[0]*u[1] - f[1]*u[0]];
      var base = P.length/3;
      [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(function(q){
        var x = f[0]*hx + (u[0]*q[0] + v[0]*q[1])*hx, y = f[1]*hy + (u[1]*q[0] + v[1]*q[1])*hy, z = f[2]*hz + (u[2]*q[0] + v[2]*q[1])*hz;
        P.push(b[0] + x, cy + y, b[2] + z); N.push(f[0], f[1], f[2]); part.push(b[6]); limb.push(b[7]); piv.push(b[8]);
      });
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    });
  });
  var sc = BODY_H/1.7;
  for(var i = 0; i < P.length; i++) P[i] *= sc;
  for(i = 0; i < piv.length; i++) piv[i] *= sc;
  return {pos: new Float32Array(P), nrm: new Float32Array(N), part: new Float32Array(part), limb: new Float32Array(limb),
          pivot: new Float32Array(piv), idx: new Uint16Array(idx)};
}

// The nearest drawn resident within reach of the player: items carry {id, x, z} (or ax, az). -> item | null
function pickTalk(items, player, reach){
  if(!player || player.x == null) return null;
  var best = null, bd = (reach != null ? +reach : TALK_REACH); bd *= bd;
  (items || []).forEach(function(r){
    var x = r.ax != null ? r.ax : r.x, z = r.az != null ? r.az : r.z, d = (x - player.x)*(x - player.x) + (z - player.z)*(z - player.z);
    if(d < bd || (d === bd && best && r.id < best.id)){ bd = d; best = r; }
  });
  return best;
}

/* ---------- the drawing (three.js) ---------- */
function rep(src, chunk, add){ return src.replace("#include <" + chunk + ">", "#include <" + chunk + ">\n" + add); }
function bodyMaterial(THREE, U){
  var m = new THREE.MeshLambertMaterial({color: 0xffffff});
  m.onBeforeCompile = function(sh){
    sh.uniforms.uNpcTime = U.uNpcTime;
    sh.vertexShader = rep(sh.vertexShader, "common", "attribute float aPart;\nattribute float aLimb;\nattribute float aPivot;\n" +
      "attribute vec3 aGait;\nattribute vec3 aShirt;\nattribute vec3 aPants;\nattribute vec3 aSkin;\nuniform float uNpcTime;\nvarying vec3 vNpcCol;");
    // legs swing about the hip, arms about the shoulder against the leg on their side; a negative swing
    // (cheering) raises both arms overhead (-2.7 rad: up and a little forward) and waves them, legs still
    sh.vertexShader = rep(sh.vertexShader, "begin_vertex",
      "float npcSw = sin(uNpcTime * 6.2831853 * aGait.y + aGait.x) * abs(aGait.z);\n" +
      "float npcA = aLimb == 0.0 ? 0.0 : (aGait.z < 0.0 ? (abs(aLimb) > 1.5 ? -2.7 + sign(aLimb) * npcSw : 0.0) : sign(aLimb) * (abs(aLimb) > 1.5 ? -0.8 : 1.0) * npcSw);\n" +
      "float npcC = cos(npcA), npcS = sin(npcA), npcY = transformed.y - aPivot;\n" +
      "transformed.y = aPivot + npcY * npcC - transformed.z * npcS;\n" +
      "transformed.z = npcY * npcS + transformed.z * npcC;\n" +
      "transformed.y += abs(npcSw) * 0.05;\n" +
      "vNpcCol = aPart < 0.5 ? aSkin : (aPart < 1.5 ? aShirt : aPants);");
    sh.fragmentShader = rep(sh.fragmentShader, "common", "varying vec3 vNpcCol;");
    sh.fragmentShader = rep(sh.fragmentShader, "color_fragment", "diffuseColor.rgb *= vNpcCol;");
  };
  m.customProgramCacheKey = function(){ return "hq-npc-body"; };
  return m;
}
// hq3d.js's way to load a character (makeCharacter without the custom avatar): needs an engine lib
function engineLoader(THREE, L){
  return function(look, cb){
    var E = HQV.engine; if(!E || !L) return;
    E.loadGlb(L, "golf", CHAR_FILES[((look && look.char) | 0) % CHAR_FILES.length]).then(function(g){
      var o = L.clone(g.scene), mixer = new THREE.AnimationMixer(o), acts = {};
      Object.keys(CLIPS).forEach(function(n){ var cl = THREE.AnimationClip.findByName(g.animations, CLIPS[n]); if(cl) acts[n] = mixer.clipAction(cl); });
      cb({o: o, mixer: mixer, acts: acts});
    }).catch(function(){});
  };
}

function create(THREE, parent, sim, opts){
  opts = opts || {};
  var draw = {stats: {near: 0, far: 0, loading: 0, ms: 0}};
  var group = new THREE.Group(); group.name = "npcs"; parent.add(group);
  var cols = colours(sim), loader = opts.loader || (opts.lib ? engineLoader(THREE, opts.lib) : null);
  var U = {uNpcTime: {value: 0}}, clock = 0;

  /* far: one instanced body */
  var cap = MAX_FAR + MAX_NEAR, B = farBuffers(cap), G = bodyGeometry(), geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(G.pos, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(G.nrm, 3));
  geo.setAttribute("aPart", new THREE.BufferAttribute(G.part, 1));
  geo.setAttribute("aLimb", new THREE.BufferAttribute(G.limb, 1));
  geo.setAttribute("aPivot", new THREE.BufferAttribute(G.pivot, 1));
  geo.setIndex(new THREE.BufferAttribute(G.idx, 1));
  var inst = {};
  [["aGait", B.gait], ["aShirt", B.shirt], ["aPants", B.pants], ["aSkin", B.skin]].forEach(function(a){
    inst[a[0]] = new THREE.InstancedBufferAttribute(a[1], 3); inst[a[0]].setUsage(THREE.DynamicDrawUsage); geo.setAttribute(a[0], inst[a[0]]);
  });
  var bodies = new THREE.InstancedMesh(geo, bodyMaterial(THREE, U), cap);
  bodies.instanceMatrix = new THREE.InstancedBufferAttribute(B.mat, 16); bodies.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  bodies.count = 0; bodies.frustumCulled = false; bodies.castShadow = false; bodies.name = "npc bodies";
  group.add(bodies);

  /* near: pooled skinned characters, per look.char */
  var free = {}, pend = {}, made = 0, loading = 0, slots = {}, nearIds = {}, avoidSt = {};
  function tint(ch, look){
    var c = new THREE.Color(look && look.shirt != null ? look.shirt : 0xffffff), w = new THREE.Color(0xffffff).lerp(c, TINT);
    ch.mats.forEach(function(m){ m.color.copy(w); });
  }
  function adopt(ch){
    ch.mats = [];
    ch.o.scale.setScalar(BODY_H/CH_H);
    ch.o.rotation.order = "YXZ";   // yaw, then the tip onto its back ("lie" without its clip)
    ch.o.traverse(function(n){
      if(!n.isMesh) return;
      n.castShadow = true; n.frustumCulled = false;
      n.material = Array.isArray(n.material) ? n.material.map(function(m){ return m.clone(); }) : n.material.clone();
      (Array.isArray(n.material) ? n.material : [n.material]).forEach(function(m){ if(m.color) ch.mats.push(m); });
    });
    ch.cur = null;
    return ch;
  }
  // a pooled character for look.char, or null (a load is asked for in need: see fill)
  function take(look, need){
    var k = (look.char | 0) % CHAR_FILES.length, list = free[k];
    if(list && list.length) return list.pop();
    need[k] = (need[k] | 0) + 1;
    return null;
  }
  // start the loads this frame's misses need (minus those under way); at the pool cap, an idle
  // character of another look makes room
  function fill(need){
    if(!loader) return;
    Object.keys(need).forEach(function(k){
      for(var w = need[k] - (pend[k] | 0); w > 0; w--){
        if(made + loading >= MAX_NEAR + POOL_SPARE && !evict(k)) return;
        loading++; pend[k] = (pend[k] | 0) + 1;
        loader({char: +k}, function(ch){
          loading--; pend[k]--;
          if(draw.dead || !ch || !ch.o) return;
          made++; (free[k] || (free[k] = [])).push(adopt(ch));
        });
      }
    });
  }
  function evict(k){
    for(var j in free) if(j !== String(k) && free[j].length){
      var ch = free[j].pop(); ch.mats.forEach(function(m){ m.dispose(); }); made--;
      return true;
    }
    return false;
  }
  function give(slot){
    slot.ch.o.visible = false; group.remove(slot.ch.o);
    (free[slot.k] || (free[slot.k] = [])).push(slot.ch);
  }
  function setAnim(ch, n, speed){
    var a = ch.acts && (ch.acts[n] || ch.acts.idle); if(!a) return;
    if(ch.cur !== n){
      if(n === "lie" && ch.acts.lie){ a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }   // fall, then stay down
      a.reset().fadeIn(0.25).play(); if(ch.cur && ch.acts[ch.cur] && ch.acts[ch.cur] !== a) ch.acts[ch.cur].fadeOut(0.25); ch.cur = n; }
    a.timeScale = speed == null ? 1 : speed;
  }

  var drawn = [];   // this frame's drawn residents (near + far), for talk()
  draw.update = function(tMs, cam, player, dt){
    var t0 = Date.now(); dt = Math.max(0, +dt || 0);
    cam = cam || {}; clock = (clock + dt) % 3600; U.uNpcTime.value = clock;
    sim.warm(tMs, WARM_MS);
    var list = sim.at(tMs, {x: +cam.x || 0, z: +cam.z || 0}, FAR), cy = cam.y != null ? +cam.y : NaN;
    if(isFinite(cy)) list.forEach(function(r){ var dy = cy - (+r.y || 0); r.d2 = (r.d2 || 0) + dy*dy; });   // sim.at's rows are fresh
    var sp = split(list, nearIds);
    avoid(sp.near, player, avoidSt, dt);
    var keep = {}, far = sp.far, lo = [], need = {};
    nearIds = {};
    sp.near.forEach(function(r){
      nearIds[r.id] = 1;
      var slot = slots[r.id], look = (sim.residents[r.id] || {}).look || {};
      if(!slot){
        var ch = take(look, need);
        if(!ch){ lo.push(r); return; }
        slot = slots[r.id] = {ch: ch, k: (look.char | 0) % CHAR_FILES.length, yaw: r.yaw || 0};
        tint(ch, look); ch.o.visible = true; ch.o.userData.npcId = r.id; group.add(ch.o);
      }
      keep[r.id] = 1;
      slot.yaw += wrapPi((r.yaw || 0) - slot.yaw)*ease(TURN_K, dt);
      var tip = r.anim === "lie" && !(slot.ch.acts && slot.ch.acts.lie);   // no fall clip: tip the idle pose over
      slot.ch.o.position.set(r.ax, r.y + (tip ? LIE_UP : 0), r.az); slot.ch.o.rotation.y = slot.yaw; slot.ch.o.rotation.x = tip ? -Math.PI/2 : 0;
      if(r.anim === "walk") setAnim(slot.ch, "walk", Math.max(0.5, (r.speed || WALK_CLIP)/WALK_CLIP));
      else if((r.anim === "lie" || r.anim === "cheer") && slot.ch.acts && slot.ch.acts[r.anim]) setAnim(slot.ch, r.anim, 1);
      else setAnim(slot.ch, "idle", 1);
      if(slot.ch.mixer) slot.ch.mixer.update(dt);
    });
    Object.keys(slots).forEach(function(id){ if(!keep[id]){ give(slots[id]); delete slots[id]; } });
    fill(need);
    // characters still loading are drawn as bodies meanwhile
    var list = lo.length ? lo.concat(far) : far, n = packFar(list, B, cols);
    bodies.count = n;
    bodies.instanceMatrix.needsUpdate = true;
    ["aGait", "aShirt", "aPants", "aSkin"].forEach(function(k){ inst[k].needsUpdate = true; });
    drawn = sp.near.concat(far);
    draw.stats = {near: sp.near.length - lo.length, far: n, loading: loading, ms: Date.now() - t0};
  };
  draw.talk = function(player, tMs){
    var r = pickTalk(drawn, player, TALK_REACH);
    return r ? {id: r.id, text: sim.speak(r.id, tMs), x: r.ax != null ? r.ax : r.x, y: r.y, z: r.az != null ? r.az : r.z} : null;
  };
  draw.setLoader = function(fn){ loader = typeof fn === "function" ? fn : null; };
  draw.dispose = function(){
    draw.dead = true;
    parent.remove(group);
    geo.dispose(); bodies.material.dispose();
    Object.keys(free).forEach(function(k){ free[k].forEach(function(ch){ ch.mats.forEach(function(m){ m.dispose(); }); }); });
    Object.keys(slots).forEach(function(id){ slots[id].ch.mats.forEach(function(m){ m.dispose(); }); });
    slots = {}; free = {};
  };
  draw.group = group;
  return draw;
}

HQV.npcDraw = {create: create, split: split, avoid: avoid, packFar: packFar, farBuffers: farBuffers, colours: colours,
               bodyGeometry: bodyGeometry, bodyMaterial: bodyMaterial, pickTalk: pickTalk, lin: lin, spring: spring, ease: ease,
               NEAR: NEAR, NEAR_OUT: NEAR_OUT, FAR: FAR, MAX_NEAR: MAX_NEAR, MAX_FAR: MAX_FAR, AV: AV,
               TALK_REACH: TALK_REACH, CHAR_FILES: CHAR_FILES, CLIPS: CLIPS, LIE_UP: LIE_UP};
})();
