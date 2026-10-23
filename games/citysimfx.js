/* Claude HQ: Living City, what you see and hear at an incident (HQV.citySimFx; games/hqcity3d.js wires it in).
 *
 * create(c, W, D, o) -> {update(ms, dt, cam), setNight(n), drawCalls(), destroy()}
 *   c: the hq3d ctx (c.THREE); W: the packed world (lots in cm); D: the event director (games/citysim.js:
 *   D.events / D.active / D.phase / D.unitsAt / D.at); o: {scene, ground(x, z), say, calm()}.
 *   update takes the UTC epoch ms (the shared clock: everyone sees the same fire at the same moment), the frame's
 *   dt (s) and the camera ({x, y, z}, as hq3d's camInfo()).
 *
 * What it draws (six draw calls, at most MAX_DRAWS; nothing for an incident more than FAR_M from the camera):
 *   smoke   one instanced billboard pool: a rising column per fire, leaning with the weather's wind, black while it
 *           burns and white steam once the engines are winning (phase "clearing")
 *   flame   one additive billboard pool: flames along the roof edge, embers rising at night
 *   glow    one additive billboard pool: the parked units' beacons, the crash cars' hazards, the roadblock's lamps,
 *           and at night the light they throw on the street (sprites: no real lights)
 *   box     one InstancedMesh of unit boxes: cordon tape, the blackened roof (for CHAR_MS after a fire), engines'
 *           ladders and hoses, the stretcher, the roadblock's boards and its stinger
 *   cone    one InstancedMesh: the cordon's cones
 *   car     one InstancedMesh: the units parked at the scene and the two crash cars, askew
 * Per frame: O(incidents in range); the event list is refreshed once a second, each incident's layout (spots on
 * the lot, parking, cones, ground heights) is worked out once and cached.
 *
 * What it plays (games/engine.js): a siren for the VOICES nearest units on a run (police wail/yelp, ambulance
 * hi-lo, the engines' wail and air horn) with the Doppler bend of their approach; a fire's crackle near a burning
 * building; the stadium's roar on a match. Every voice falls silent when update() stops (engine.js dead man's
 * switch). Calm (o.calm() or the engine's): beacons and hazards burn steady, flames do not flicker, smoke stands
 * still, sirens are a soft tone (engine.js).
 *
 * Pure helpers (exported, tests/test_citysimfx.py): fireLevel, phaseSpans, phaseU, flameSpots, smokePuff, beaconK,
 * layout, unitPos, sirenOn, sirenPick. Nothing visible uses Math.random: every jitter is a hash of the event id.
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : globalThis;
var HQV = root.HQV = root.HQV || {};

var FAR_M = 600, CHAR_MS = 3600000, FLOOR_H = 3.5, Q16 = 65536, VOICES = 2, REFRESH_MS = 1000;
var CAP = {smoke: 192, flame: 128, glow: 128, box: 192, cone: 96, car: 24};
var MAX_DRAWS = 12;
var PHASES = ["reported", "responding", "onscene", "clearing", "done"];
var SCENE_KINDS = {fire: 1, medical: 1, crime: 1, crash: 1};
var SIREN_KINDS = {police: 1, ambulance: 1, fire: 1};
var SIREN_PHASES = {responding: 1, transport: 1, chase: 1, pursuit: 1};
var CAR_COL = {fire: 0xc4261c, ambulance: 0xf1f1ec, police: 0x22325e, tow: 0xe0a21c, van: 0xd8d8d0, schoolbus: 0xf2b01e, getaway: 0x2b2b2f};
var BEACON = {police: [0xff2a2a, 0x2a5cff], ambulance: [0xff2a2a, 0xfff4e8], fire: [0xff3a1c, 0xff3a1c], tow: [0xffa020, 0xffa020]};
var CRASH_COL = [0x8a9bb0, 0xb8432f, 0x3d6b4a, 0xd9c9a3, 0x5a4f7a];
var AMBER = 0xffa51e;

function hash32(s){
  var h = 0x811c9dc5; s = String(s);
  for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function h01(seed, a, b){ return hash32(seed + ":" + a + ":" + b)/4294967296; }
function clamp(v, a, b){ return v < a ? a : (v > b ? b : v); }
function num(v, fb){ v = +v; return isFinite(v) ? v : fb; }
function sevOf(ev){ return clamp(num(ev && ev.severity, 1)|0, 1, 3); }

/* ---------- pure helpers ---------- */
// How hard a fire burns in a phase, u (0..1) of the way through it; sev 1..3 scales the whole thing.
//   -> {smoke 0..~1.3, flame 0..~1.3, steam 0..1 (how white the smoke is)}
function fireLevel(phase, u, sev){
  u = clamp(num(u, 0.5), 0, 1); var s = [0, 0.75, 1, 1.3][clamp(num(sev, 1)|0, 1, 3)], L;
  if(phase === "reported") L = {smoke: 0.35 + 0.4*u, flame: 0.3 + 0.5*u, steam: 0};
  else if(phase === "responding") L = {smoke: 0.75 + 0.25*u, flame: 0.8 + 0.2*u, steam: 0};
  else if(phase === "onscene") L = {smoke: 1 - 0.3*u, flame: 1 - 0.6*u, steam: 0.5*u};
  else if(phase === "clearing") L = {smoke: 0.7*(1 - u), flame: 0.4*(1 - u)*(1 - u), steam: 0.5 + 0.5*u};
  else return {smoke: 0, flame: 0, steam: 1};
  L.smoke *= s; L.flame *= s; return L;
}
// The phase boundaries of an event: D.phase is pure and runs forward, so each boundary is found by bisection once.
//   -> {reported: [t0, t1], responding: [...], onscene: [...], clearing: [...]} (ms; an absent phase has t0 == t1)
function phaseSpans(D, ev){
  var a = num(ev.start, 0), b = Math.max(a, num(ev.end, a)), out = {}, edge = [a];
  function idx(ms){ var i = PHASES.indexOf(D.phase(ev, ms)); return i < 0 ? 0 : i; }
  for(var k = 1; k < PHASES.length; k++){
    var lo = edge[k - 1], hi = b + 1;
    if(idx(hi) < k){ edge.push(b); continue; }
    if(idx(lo) >= k){ edge.push(lo); continue; }
    for(var it = 0; it < 40 && hi - lo > 50; it++){ var m = (lo + hi)/2; if(idx(m) >= k) hi = m; else lo = m; }
    edge.push(hi);
  }
  for(k = 0; k < 4; k++) out[PHASES[k]] = [edge[k], edge[k + 1]];
  return out;
}
function phaseU(spans, phase, ms){
  var s = spans && spans[phase]; if(!s || !(s[1] > s[0])) return 0.5;
  return clamp((ms - s[0])/(s[1] - s[0]), 0, 1);
}
// n flames spread round a roof's edge (roof: {x, z, w, d, y} m), 0.6 m in from it, deterministic by seed
function flameSpots(roof, n, seed){
  var w = Math.max(1, roof.w - 1.2), d = Math.max(1, roof.d - 1.2), P = 2*(w + d), out = [];
  for(var i = 0; i < n; i++){
    var s = ((i + 0.25 + 0.5*h01(seed, i, "f"))/n)*P, x, z;
    if(s < w){ x = -w/2 + s; z = -d/2; }
    else if((s -= w) < d){ x = w/2; z = -d/2 + s; }
    else if((s -= d) < w){ x = w/2 - s; z = d/2; }
    else { s -= w; x = -w/2; z = d/2 - s; }
    out.push([roof.x + x, roof.y, roof.z + z]);
  }
  return out;
}
// smoke puff i of n at tSec: rises over LIFE s, grows, leans downwind; wind {x, z, k 0..1}; k: the fire's smoke level.
// Calm: the column stands still (puffs at fixed ages). -> {x, y, z offsets from the roof centre, s size, a alpha}
var LIFE = 9;
function smokePuff(i, n, tSec, wind, k, calmed, seed){
  var age = calmed ? (i + 0.5)/n : ((num(tSec, 0)/LIFE + h01(seed, i, "p")) % 1 + 1) % 1;
  var lean = (wind ? num(wind.k, 0) : 0)*(3 + 16*age*age), wx = wind ? num(wind.x, 0) : 0, wz = wind ? num(wind.z, 0) : 0;
  var sp = 0.6 + 3.2*age;
  return {x: wx*lean + (h01(seed, i, "x") - 0.5)*2*sp, y: 1 + age*(10 + 24*k), z: wz*lean + (h01(seed, i, "z") - 0.5)*2*sp,
          s: (2.2 + 7*age)*(0.6 + 0.5*k), a: clamp(k, 0, 1.3)*0.7*Math.min(1, age*5)*(1 - age)};
}
// a beacon lamp's brightness (0.08..1) at ms: lamp 0/1 of a pair, alternating (police fastest); "hazard": both
// together at 1 Hz. Calm: steady.
function beaconK(kind, ms, lamp, calmed, seed){
  if(calmed) return 0.6;
  var per = kind === "police" ? 500 : kind === "hazard" ? 1000 : 700, t = ((num(ms, 0) + (seed|0)) % per + per) % per;
  if(kind === "hazard") return t < per*0.55 ? 1 : 0.08;
  var first = t < per/2;
  return (lamp ? !first : first) ? 1 : 0.08;
}
// where a unit is now (for its siren): D.unitsAt's {pos} when it gives one, else along its leg by its unit's times
function unitPos(U, ms){
  if(!U) return null;
  if(U.pos && U.pos.x != null) return U.pos;
  var f = U.from, t = U.to, un = U.unit || {};
  if(!f || !t) return f || t || null;
  var a, b;
  if(ms < num(un.arrive, Infinity)){ a = num(un.dispatch, 0); b = num(un.arrive, a); }
  else if(ms < num(un.leave, -Infinity)) return t;
  else { a = num(un.leave, 0); b = num(un.back, a); }
  var k = b > a ? clamp((ms - a)/(b - a), 0, 1) : 1;
  return {x: f.x + (t.x - f.x)*k, z: f.z + (t.z - f.z)*k};
}
// does this unit run with its siren on? an emergency kind, moving, on its way in (or carrying a patient, chasing)
function sirenOn(U){
  var un = U && U.unit; if(!un || !SIREN_KINDS[un.kind]) return false;
  if(U.phase != null && !SIREN_PHASES[U.phase]) return false;
  var f = U.from, t = U.to; return !!(f && t && Math.hypot(t.x - f.x, t.z - f.z) > 1);
}
// the n nearest siren units within the engine's hearing range: [{key, kind, x, z, d}], nearest first
function sirenPick(units, ms, cam, n, range){
  var out = [];
  (units || []).forEach(function(U, i){
    if(!sirenOn(U)) return;
    var p = unitPos(U, ms); if(!p) return;
    var d = Math.hypot(p.x - cam.x, p.z - cam.z); if(!(d < range)) return;
    var key = (U.ev && U.ev.id != null ? U.ev.id : "?") + "/" + (U.unit.id != null ? U.unit.id : U.unit.kind + ":" + (U.ev && U.ev.units ? U.ev.units.indexOf(U.unit) : i));
    out.push({key: key, kind: U.unit.kind, x: p.x, z: p.z, d: d});
  });
  out.sort(function(a, b){ return a.d - b.d || (a.key < b.key ? -1 : 1); });
  return out.slice(0, n);
}

// The scene's layout, once per event: where everything stands (m), ground heights included.
//   lot (a building's): roof {x, z, w, d, y}, flames on its edge, parking in front of its door
//   else: the event's (x, z), parking along a seeded heading
//   -> {x, z, y, roof|null, door {x, z, y}, tan {x, z}, slots [{x, z, y, yaw}], cones [{x, z, y}],
//       flames [[x, y, z]], crash [{x, z, y, yaw, col}], stretcher {..}|null, block {x, z, y, yaw}|null}
function lotIndex(W){
  if(W.__fxLots) return W.__fxLots;
  var m = {}; (W.lots || []).forEach(function(l){ if(l && l.id != null) m[l.id] = l; });
  try { Object.defineProperty(W, "__fxLots", {value: m, enumerable: false, configurable: true}); } catch(e){}
  return m;
}
function layout(W, ev, ground){
  var gy = typeof ground === "function" ? ground : function(){ return 0; }, seed = String(ev.id), sev = sevOf(ev);
  var lot = ev.lot != null && typeof ev.lot === "object" ? ev.lot : ev.lot != null ? lotIndex(W || {})[ev.lot] : null;
  var L = {x: num(ev.x, 0), z: num(ev.z, 0), roof: null, slots: [], cones: [], flames: [], crash: [], stretcher: null, block: null};
  var nx, nz;
  if(lot && isFinite(lot.x) && isFinite(lot.w)){
    L.x = lot.x/100; L.z = lot.z/100;
    var g0 = gy(L.x, L.z);
    L.roof = {x: L.x, z: L.z, w: lot.w/100, d: lot.d/100, y: g0 + Math.max(1, lot.floors|0)*FLOOR_H};
    var fr = lot.front && lot.front.length === 2 ? lot.front : [0, Q16], fl = Math.hypot(fr[0], fr[1]) || 1;
    nx = fr[0]/fl; nz = fr[1]/fl;
    var door = lot.door && lot.door.length === 3 ? {x: lot.door[0]/100, z: lot.door[2]/100}
      : {x: L.x + nx*L.roof.d/2, z: L.z + nz*L.roof.d/2};
    L.door = {x: door.x + nx*4.5, z: door.z + nz*4.5};
    if(ev.kind === "fire") L.flames = flameSpots(L.roof, 3 + 2*sev, seed);
  } else {
    var a = h01(seed, 0, "yaw")*Math.PI*2; nx = Math.cos(a); nz = Math.sin(a);
    L.door = {x: L.x + nx*(ev.kind === "crash" ? 11 : 4), z: L.z + nz*(ev.kind === "crash" ? 11 : 4)};
  }
  L.door.y = gy(L.door.x, L.door.z); L.y = gy(L.x, L.z);
  L.tan = {x: -nz, z: nx};
  // parking: the units in a row along the street, 9 m apart, nose along it
  var n = Math.min(6, (ev.units || []).length), yaw = Math.atan2(L.tan.x, L.tan.z);
  for(var i = 0; i < n; i++){
    var o = (i - (n - 1)/2)*9, px = L.door.x + L.tan.x*o, pz = L.door.z + L.tan.z*o;
    L.slots.push({x: px, z: pz, y: gy(px, pz), yaw: yaw + (h01(seed, i, "sk") - 0.5)*0.25});
  }
  // the cordon: a ring of cones about the scene (the lot and a margin, or 7 m)
  var R = L.roof ? Math.max(L.roof.w, L.roof.d)/2 + 6 : ev.kind === "crash" ? 9 : 6, nc = L.roof ? 12 : 8;
  for(i = 0; i < nc; i++){
    var ca = (i/nc)*Math.PI*2 + h01(seed, 1, "c")*0.5, cx = L.x + Math.cos(ca)*R, cz = L.z + Math.sin(ca)*R;
    L.cones.push({x: cx, z: cz, y: gy(cx, cz)});
  }
  if(ev.kind === "crash"){
    for(i = 0; i < 2; i++){
      var s = i ? 1 : -1, kx = L.x + s*2.6*nx + (h01(seed, i, "cx") - 0.5)*1.5, kz = L.z + s*2.6*nz + (h01(seed, i, "cz") - 0.5)*1.5;
      L.crash.push({x: kx, z: kz, y: gy(kx, kz), yaw: yaw + (i ? 0.55 : -0.9) + (h01(seed, i, "cy") - 0.5)*0.6,
                    col: CRASH_COL[hash32(seed + ":col" + i) % CRASH_COL.length]});
    }
  }
  if(ev.kind === "medical"){ var sx = L.x + L.tan.x*1.8, sz = L.z + L.tan.z*1.8; L.stretcher = {x: sx, z: sz, y: gy(sx, sz), yaw: yaw}; }
  if(ev.kind === "crime"){
    var rb = ev.roadblock || ev.block || null, rt = ev.route, bp = null, bq = null;
    if(rb && rb.x != null) bp = rb;
    else if(rt && rt.length){
      var pt = function(p){ return p ? (p.length ? {x: p[0], z: p[p.length === 3 ? 2 : 1]} : p) : null; };
      bp = pt(rt[rt.length - 1]); bq = pt(rt[rt.length - 2]);
    }
    if(bp && isFinite(bp.x)){
      var by = bq ? Math.atan2(bp.x - bq.x, bp.z - bq.z) + Math.PI/2 : yaw + Math.PI/2;
      L.block = {x: bp.x, z: bp.z, y: gy(bp.x, bp.z), yaw: by};
    }
  }
  return L;
}

/* ---------- drawing ---------- */
var VERT = [
  "attribute vec4 aPos; attribute vec4 aCol; varying vec4 vCol; varying vec2 vUv;",
  "void main(){ vUv = uv; vCol = aCol; vec4 mv = modelViewMatrix*vec4(aPos.xyz, 1.0); mv.xy += position.xy*aPos.w;",
  "  gl_Position = projectionMatrix*mv; }"].join("\n");
var FRAG = {
  smoke: "varying vec4 vCol; varying vec2 vUv; void main(){ vec2 p = vUv*2.0 - 1.0; float r = length(p);" +
         " float n = 0.85 + 0.15*sin(p.x*7.0 + p.y*5.0); float a = (1.0 - smoothstep(0.15, 1.0, r))*n*vCol.a;" +
         " if(a < 0.01) discard; gl_FragColor = vec4(vCol.rgb, a); }",
  flame: "varying vec4 vCol; varying vec2 vUv; void main(){ vec2 p = vUv*2.0 - 1.0; p.x *= 1.0 + 0.9*(p.y + 1.0)*0.5;" +
         " float r = length(vec2(p.x, p.y*0.8 + 0.15)); float a = pow(clamp(1.0 - r, 0.0, 1.0), 1.4)*vCol.a;" +
         " if(a < 0.01) discard; gl_FragColor = vec4(vCol.rgb, a); }",
  glow:  "varying vec4 vCol; varying vec2 vUv; void main(){ float r = length(vUv*2.0 - 1.0);" +
         " float a = pow(clamp(1.0 - r, 0.0, 1.0), 2.0)*vCol.a; if(a < 0.01) discard; gl_FragColor = vec4(vCol.rgb, a); }"
};

function create(c, W, D, o){
  o = o || {};
  var THREE = c.THREE, E = HQV.engine || null, scene = o.scene, ground = typeof o.ground === "function" ? o.ground : function(){ return 0; };
  var group = new THREE.Group(); group.name = "citysimfx";
  var night = false, dead = false, col = new THREE.Color();

  // billboard pools: one InstancedBufferGeometry each, aPos (xyz, size) and aCol (rgb, alpha) per sprite
  function pool(name, cap, frag, additive){
    var base = new THREE.PlaneGeometry(1, 1), geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index; geo.setAttribute("position", base.attributes.position); geo.setAttribute("uv", base.attributes.uv);
    var P = new THREE.InstancedBufferAttribute(new Float32Array(cap*4), 4), C = new THREE.InstancedBufferAttribute(new Float32Array(cap*4), 4);
    P.setUsage(THREE.DynamicDrawUsage); C.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aPos", P); geo.setAttribute("aCol", C); geo.instanceCount = 0;
    var m = new THREE.ShaderMaterial({vertexShader: VERT, fragmentShader: frag, transparent: true, depthWrite: false, fog: false,
                                      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending});
    var mesh = new THREE.Mesh(geo, m); mesh.name = "fx:" + name; mesh.frustumCulled = false; mesh.visible = false;
    mesh.renderOrder = additive ? 3 : 2; group.add(mesh);
    return {mesh: mesh, geo: geo, P: P, C: C, cap: cap, n: 0, base: base,
            push: function(x, y, z, s, hex, a){
              if(this.n >= this.cap || !(a > 0.004)) return; var i = this.n++*4; col.setHex(hex);
              P.array[i] = x; P.array[i+1] = y; P.array[i+2] = z; P.array[i+3] = s;
              C.array[i] = col.r; C.array[i+1] = col.g; C.array[i+2] = col.b; C.array[i+3] = a; },
            flush: function(){ geo.instanceCount = this.n; mesh.visible = this.n > 0; if(this.n){ P.needsUpdate = true; C.needsUpdate = true; } }};
  }
  // solid pools: an InstancedMesh each, instance colours, matrices from (x, y, z, yaw, pitch, sx, sy, sz)
  var M4 = new THREE.Matrix4(), QT = new THREE.Quaternion(), EU = new THREE.Euler(0, 0, 0, "YXZ"), V3 = new THREE.Vector3(), SC = new THREE.Vector3();
  function solid(name, geo, cap, mat){
    var mesh = new THREE.InstancedMesh(geo, mat, cap); mesh.name = "fx:" + name; mesh.count = 0; mesh.visible = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = true;
    mesh.setColorAt(0, col.setHex(0xffffff)); group.add(mesh);
    return {mesh: mesh, cap: cap, n: 0,
            push: function(x, y, z, yaw, pitch, sx, sy, sz, hex){
              if(this.n >= this.cap) return;
              EU.set(pitch || 0, yaw || 0, 0); QT.setFromEuler(EU); V3.set(x, y, z); SC.set(sx, sy, sz);
              M4.compose(V3, QT, SC); mesh.setMatrixAt(this.n, M4); mesh.setColorAt(this.n, col.setHex(hex)); this.n++; },
            flush: function(){ mesh.count = this.n; mesh.visible = this.n > 0;
              if(this.n){ mesh.instanceMatrix.needsUpdate = true; if(mesh.instanceColor) mesh.instanceColor.needsUpdate = true; } }};
  }
  var boxGeo = new THREE.BoxGeometry(1, 1, 1); boxGeo.translate(0, 0.5, 0);                        // standing on its base
  var coneGeo = new THREE.ConeGeometry(0.17, 0.72, 8); coneGeo.translate(0, 0.36, 0);
  var carGeo = carGeometry(THREE);
  var solidMat = new THREE.MeshStandardMaterial({color: 0xffffff, roughness: 0.6, metalness: 0.1});
  var P = {smoke: pool("smoke", CAP.smoke, FRAG.smoke, false), flame: pool("flame", CAP.flame, FRAG.flame, true),
           glow: pool("glow", CAP.glow, FRAG.glow, true),
           box: solid("box", boxGeo, CAP.box, solidMat), cone: solid("cone", coneGeo, CAP.cone, solidMat), car: solid("car", carGeo, CAP.car, solidMat)};
  var ORDER = ["smoke", "flame", "glow", "box", "cone", "car"];
  if(scene) scene.add(group);

  function isCalm(){ try { if(typeof o.calm === "function") return !!o.calm(); return !!(E && E.calm && E.calm()); } catch(e){ return false; } }

  /* the events in play, refreshed once a second; layouts and phase spans cached per event */
  var evs = [], lastRefresh = -Infinity, cache = {}, wind = {x: 1, z: 0, k: 0.2}, windAt = -Infinity, unitsList = [], unitsAt = -Infinity;
  function refresh(ms){
    var seen = {}, out = [];
    function take(L){ (L || []).forEach(function(ev){ if(ev && SCENE_KINDS[ev.kind] && !seen[ev.id]){ seen[ev.id] = 1; out.push(ev); } }); }
    try { take(D.active(ms)); } catch(e){}
    try { if(D.events) take(D.events(ms - CHAR_MS, ms + 1)); } catch(e){}
    evs = out.filter(function(ev){ return ev.kind !== "fire" ? num(ev.end, Infinity) > ms : num(ev.end, Infinity) + CHAR_MS > ms; });
    Object.keys(cache).forEach(function(k){ if(!seen[k]) delete cache[k]; });
    lastRefresh = ms;
  }
  function entry(ev){
    var C = cache[ev.id];
    if(!C){ C = cache[ev.id] = {L: layout(W, ev, ground), spans: null, seed: hash32(String(ev.id)) % 9973}; }
    return C;
  }

  /* drawing one incident */
  function drawFire(ev, C, ph, ms, calm){
    var L = C.L; if(!L.roof) return 0;
    if(!C.spans) C.spans = phaseSpans(D, ev);
    var F = fireLevel(ph, phaseU(C.spans, ph, ms), sevOf(ev)), t = ms/1000, seed = String(ev.id), i;
    // the blackened roof: from the time the engines are on it until CHAR_MS after the fire is out
    if(ph === "onscene" || ph === "clearing" || (ph === "done" && ms < num(ev.end, 0) + CHAR_MS))
      P.box.push(L.roof.x, L.roof.y, L.roof.z, 0, 0, L.roof.w - 0.4, 0.12, L.roof.d - 0.4, 0x141210);
    if(F.smoke > 0){
      var n = 10 + 6*sevOf(ev), dark = Math.round(0x22 + (0xd8 - 0x22)*F.steam), sc = (dark << 16) | (dark << 8) | dark;
      for(i = 0; i < n; i++){
        var s = smokePuff(i, n, t, wind, F.smoke, calm, seed);
        P.smoke.push(L.roof.x + s.x, L.roof.y + s.y, L.roof.z + s.z, s.s, sc, s.a);
      }
    }
    if(F.flame > 0){
      L.flames.forEach(function(f, j){
        var fl = calm ? 1 : 1 + 0.22*Math.sin(t*7.3 + j*2.1) + 0.12*Math.sin(t*13.1 + j*0.7), sz = 2.2*F.flame*fl;
        P.flame.push(f[0], f[1] + sz*0.42, f[2], sz, 0xff7a1e, 0.95);
        P.flame.push(f[0], f[1] + sz*0.25, f[2], sz*0.55, 0xffd24a, 0.9);
      });
      if(night && !calm) for(i = 0; i < 8; i++){                                        // embers on the updraught
        var e = ((t*0.35 + h01(seed, i, "e")) % 1), f2 = L.flames[i % L.flames.length];
        P.flame.push(f2[0] + (h01(seed, i, "ex") - 0.5)*3 + wind.x*wind.k*e*8, f2[1] + 1 + e*14,
                     f2[2] + (h01(seed, i, "ez") - 0.5)*3 + wind.z*wind.k*e*8, 0.35, 0xff9a3a, 0.9*(1 - e)*F.flame);
      }
    }
    return F.flame;
  }
  function drawUnits(ev, C, ms, calm){
    var L = C.L, us = ev.units || [];
    for(var i = 0; i < L.slots.length; i++){
      var u = us[i], sl = L.slots[i]; if(!u) continue;
      if(!(ms >= num(u.arrive, Infinity) && ms < num(u.leave, -Infinity))) continue;     // parked at the scene
      var k = u.kind, len = k === "fire" ? 8 : k === "tow" ? 7 : 5;
      P.car.push(sl.x, sl.y, sl.z, sl.yaw, 0, k === "fire" || k === "tow" ? 1.25 : 1, k === "fire" ? 1.35 : 1, len/4.4, CAR_COL[k] || 0xbbbbbb);
      var bc = BEACON[k]; if(!bc) continue;
      var top = sl.y + (k === "fire" ? 3.1 : 2.0), cs = Math.cos(sl.yaw), sn = Math.sin(sl.yaw), ph = C.seed + i*137;
      for(var lamp = 0; lamp < 2; lamp++){
        var off = lamp ? 0.55 : -0.55, bx = sl.x + cs*off, bz = sl.z - sn*off, b = beaconK(k, ms, lamp, calm, ph);
        P.glow.push(bx, top, bz, night ? 1.4 : 0.9, bc[lamp], b);
        if(night) P.glow.push(bx, sl.y + 0.4, bz, 9, bc[lamp], 0.22*b);                   // the light on the street
      }
      if(k === "fire" && L.roof){
        // the ladder up toward the roof, and a hose to the door
        var dx = L.roof.x - sl.x, dz = L.roof.z - sl.z, hd = Math.hypot(dx, dz) || 1, rise = Math.max(2, L.roof.y - (sl.y + 2.6));
        var reach = Math.min(28, Math.hypot(hd*0.7, rise)), pitch = Math.atan2(rise, hd*0.7);
        P.box.push(sl.x, sl.y + 2.6, sl.z, Math.atan2(dx, dz), Math.PI/2 - pitch, 0.6, reach, 0.18, 0xd8d8d8);
        var hx = (L.door.x + L.roof.x)/2 - sl.x, hz = (L.door.z + L.roof.z)/2 - sl.z, hl = Math.hypot(hx, hz);
        P.box.push(sl.x + hx/2, sl.y + 0.05, sl.z + hz/2, Math.atan2(hx, hz), 0, 0.14, 0.1, hl, 0xc9b23a);
      }
    }
  }
  function drawCordon(C){
    var cs = C.L.cones;
    cs.forEach(function(p, i){
      P.cone.push(p.x, p.y, p.z, 0, 0, 1, 1, 1, 0xff6a14);
      var q = cs[(i + 1) % cs.length], dx = q.x - p.x, dz = q.z - p.z, l = Math.hypot(dx, dz);
      P.box.push((p.x + q.x)/2, (p.y + q.y)/2 + 0.85, (p.z + q.z)/2, Math.atan2(dx, dz), 0, 0.03, 0.07, l, 0xf2d21c);
    });
  }
  function drawScene(ev, ms, calm){
    var C = entry(ev), L = C.L, ph;
    try { ph = D.phase(ev, ms); } catch(e){ ph = "done"; }
    var flame = 0;
    if(ev.kind === "fire") flame = drawFire(ev, C, ph, ms, calm);
    if(ph === "done") return flame;
    drawUnits(ev, C, ms, calm);
    if(ph === "onscene" || ph === "clearing") drawCordon(C);
    if(ev.kind === "crash") L.crash.forEach(function(k, i){
      P.car.push(k.x, k.y, k.z, k.yaw, 0, 1, 1, 1, k.col);
      var cs = Math.cos(k.yaw), sn = Math.sin(k.yaw);
      [[-0.8, 2.1], [0.8, 2.1], [-0.8, -2.1], [0.8, -2.1]].forEach(function(c4){
        P.glow.push(k.x + cs*c4[0] + sn*c4[1], k.y + 0.75, k.z - sn*c4[0] + cs*c4[1], 0.7, AMBER, beaconK("hazard", ms, 0, calm, C.seed + i*71));
      });
    });
    if(ev.kind === "medical" && L.stretcher && ph === "onscene"){
      var s = L.stretcher;
      P.box.push(s.x, s.y + 0.15, s.z, s.yaw, 0, 0.5, 0.55, 1.9, 0x8a8f96);              // the frame
      P.box.push(s.x, s.y + 0.7, s.z, s.yaw, 0, 0.62, 0.1, 2.0, 0xe9e4da);              // the mattress
    }
    if(ev.kind === "crime" && L.block && (ph === "onscene" || ph === "clearing")){
      var B = L.block, cb = Math.cos(B.yaw), sb = Math.sin(B.yaw);
      for(var j = -2; j <= 2; j++){                                                       // striped boards across the road
        var bx = B.x + sb*j*1.6, bz = B.z + cb*j*1.6;
        P.box.push(bx, B.y + 0.6, bz, B.yaw, 0, 0.12, 0.35, 1.5, j & 1 ? 0xf4f4f0 : 0xd6261e);
        P.box.push(bx, B.y, bz, B.yaw, 0, 0.1, 0.6, 0.1, 0x555a60);
      }
      P.box.push(B.x - cb*6, B.y + 0.01, B.z + sb*6, B.yaw + Math.PI/2, 0, 7.5, 0.06, 0.3, 0x26282c);   // the stinger
      for(j = 0; j < 2; j++) P.glow.push(B.x + sb*(j ? 3.4 : -3.4), B.y + 1.2, B.z + cb*(j ? 3.4 : -3.4), 0.6, AMBER, beaconK("hazard", ms, 0, calm, C.seed));
    }
    return flame;
  }

  /* sound */
  var voices = {}, crackle = null, crackleIdle = 0, crowd = null, crowdIdle = 0;
  function sound(ms, dt, cam, fires){
    if(!E || !cam || cam.x == null) return;
    if(E.siren){
      if(ms - unitsAt > 250 || ms < unitsAt){ try { unitsList = D.unitsAt ? D.unitsAt(ms) || [] : []; } catch(e){ unitsList = []; } unitsAt = ms; }
      var pick = sirenPick(unitsList, ms, cam, VOICES, E.SIREN_M || 700), keep = {};
      pick.forEach(function(p){
        keep[p.key] = 1;
        var V = voices[p.key] || (voices[p.key] = {v: E.siren(p.kind), d: p.d, ap: 0});
        var ap = dt > 0 ? (V.d - p.d)/dt : 0; V.ap += (clamp(ap, -80, 80) - V.ap)*Math.min(1, dt*4); V.d = p.d;
        V.v.set(p.d, V.ap);
      });
      Object.keys(voices).forEach(function(k){ if(!keep[k]){ voices[k].v.stop(); delete voices[k]; } });
    }
    // a fire's crackle near the nearest burning building; the stadium's roar on a match
    var best = null;
    fires.forEach(function(f){ var d = Math.hypot(f.x - cam.x, f.z - cam.z); if(!best || d < best.d) best = {d: d, k: f.k}; });
    if(best && E.crackleLoop){ crackle = crackle || E.crackleLoop(); crackle.set(best.d, Math.min(1, best.k)); crackleIdle = 0; }
    else if(crackle && (crackleIdle += dt) > 5){ crackle.stop(); crackle = null; }
    var m = null; try { var A = D.at ? D.at(ms) : null; m = A && A.match; } catch(e){}
    if(m && m.x != null && E.crowdLoop){
      var d2 = Math.hypot(m.x - cam.x, m.z - cam.z), lvl = ms >= num(m.start, 0) && ms < num(m.end, 0) ? 1 : 0.4;
      crowd = crowd || E.crowdLoop(); crowd.set(d2, lvl); crowdIdle = 0;
    } else if(crowd && (crowdIdle += dt) > 5){ crowd.stop(); crowd = null; }
  }

  return {
    group: group,
    update: function(ms, dt, cam){
      if(dead) return;
      ms = num(ms, 0); dt = clamp(num(dt, 0), 0, 0.5);
      if(ms - lastRefresh >= REFRESH_MS || ms < lastRefresh) refresh(ms);
      if(ms - windAt > 1000 || ms < windAt){
        windAt = ms;
        var Wx = HQV.hqWeather; if(Wx && Wx.look) try { var lk = Wx.look(W && W.id, ms); wind = {x: num(lk.wx, 1), z: num(lk.wz, 0), k: clamp(num(lk.wind, 0.2), 0, 1)}; } catch(e){}
      }
      var calm = isCalm(), fires = [];
      ORDER.forEach(function(k){ P[k].n = 0; });
      var cx = cam && cam.x != null ? cam.x : null, cz = cam ? num(cam.z, 0) : 0;
      evs.forEach(function(ev){
        var C = entry(ev);
        if(cx != null && Math.hypot(C.L.x - cx, C.L.z - cz) > FAR_M) return;            // nothing beyond FAR_M
        var fl = drawScene(ev, ms, calm);
        if(fl > 0 && C.L.roof) fires.push({x: C.L.x, z: C.L.z, k: fl});
      });
      ORDER.forEach(function(k){ P[k].flush(); });
      sound(ms, dt, cam, fires);
    },
    setNight: function(n){ night = !!n; },
    drawCalls: function(){ return ORDER.filter(function(k){ return P[k].mesh.visible; }).length; },
    destroy: function(){
      if(dead) return; dead = true;
      Object.keys(voices).forEach(function(k){ voices[k].v.stop(); }); voices = {};
      if(crackle) crackle.stop(); if(crowd) crowd.stop(); crackle = crowd = null;
      if(group.parent) group.parent.remove(group);
      ORDER.forEach(function(k){ var p = P[k]; p.mesh.geometry.dispose(); if(p.base) p.base.dispose(); if(p.mesh.material !== solidMat) p.mesh.material.dispose(); });
      solidMat.dispose();
    }
  };
}
// a car-ish body: a box with a cab on top (4.4 m long, nose to +z), one geometry for every parked unit
function carGeometry(THREE){
  var body = new THREE.BoxGeometry(1.8, 0.95, 4.4).toNonIndexed(), cab = new THREE.BoxGeometry(1.6, 0.75, 2.2).toNonIndexed();
  body.translate(0, 0.3 + 0.475, 0); cab.translate(0, 1.25 + 0.375, -0.3);
  var pa = [], na = [];
  [body, cab].forEach(function(g){ pa.push.apply(pa, g.attributes.position.array); na.push.apply(na, g.attributes.normal.array); g.dispose(); });
  var out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(pa, 3)); out.setAttribute("normal", new THREE.Float32BufferAttribute(na, 3));
  out.computeBoundingSphere();
  return out;
}

HQV.citySimFx = {create: create, fireLevel: fireLevel, phaseSpans: phaseSpans, phaseU: phaseU, flameSpots: flameSpots,
                 smokePuff: smokePuff, beaconK: beaconK, layout: layout, unitPos: unitPos, sirenOn: sirenOn, sirenPick: sirenPick,
                 FAR_M: FAR_M, CHAR_MS: CHAR_MS, CAP: CAP, MAX_DRAWS: MAX_DRAWS};
})();
