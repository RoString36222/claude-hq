/* Claude HQ: the sea round the islands (HQV.ocean): water, the other islands on the horizon, wakes.
 *
 * Pure core (node-tested, tests/test_ocean.py): no THREE and no DOM until mount() is called.
 *   waveAt(x, z, t)              the sea's height (m): three gentle swells, the same sum the water
 *                                shader displaces with (GLSL generated from WAVES), so boats bob on
 *                                the waves you see
 *   setArchipelago(data, current) GET /v1/archipelago's {commons: {world, x, z}, islands: [{owner, name,
 *                                world, x, z, tier}]} (metres; island entries may add docks: [[x, z]],
 *                                metres from their centre, once a doc has been seen) and the world id you
 *                                are on. Everything here is then in that island's frame (it sits at 0, 0).
 *                                -> {dx, dz}: the new island's offset from the old one (subtract it from
 *                                anything you keep, such as the boat, when an island streams in)
 *   nearestIsland(x, z)          the nearest island you are NOT on: {world, owner, name, tier, x, z, dist,
 *                                shore, arrive, dock}; arrive = within ARRIVE.dock m of one of its docks
 *                                (when known), else within ARRIVE.coast m of its coast: time to stream it in
 *   horizon(cx, cz, out)         per-frame impostor placement for a camera at (cx, cz): every other
 *                                island at its bearing, pulled in to HORIZON m (scaled to keep its size
 *                                in view) when further; -> count, out = [x, z, scale, yaw, tier] per island
 *   seaOf(doc, wave)             a WorldDoc v2 (layers.island) as hqboat's sea: {land, docks, y, wave}
 *   wakePush / wakeStrip         a boat's wake as a trail of points, and the strip that draws it
 * mount(c, parent) -> {g, step(t, dt, cam), setTime(night), setSun(dir), wake(boats), dispose, drawCalls}: a polar-grid
 * sea plane that follows the camera (a shader: waves, fresnel sky, sun or moon glint, day/night tint,
 * the scene's fog), island impostors as seven InstancedMeshes (one silhouette, a skyline per tier and one
 * for the Commons: the draw calls stay seven for any number of islands) and a fading foam V behind each boat.
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};
var PI = Math.PI, G = 9.81;

/* ---------- the waves ---------- */
// [direction (rad, 0 = toward +z), wavelength m, amplitude m, phase]; the speed is deep water's sqrt(g L / 2 pi)
var WAVES = [[0.6, 38, 0.16, 0.0], [2.1, 21, 0.08, 1.3], [-0.9, 11, 0.035, 2.6]];
var WK = WAVES.map(function(w){ var k = 2*PI/w[1]; return {dx: Math.sin(w[0])*k, dz: Math.cos(w[0])*k, w: Math.sqrt(G*k), a: w[2], p: w[3]}; });
function waveAt(x, z, t){
  var h = 0; t = +t || 0;
  for(var i = 0; i < WK.length; i++){ var q = WK[i]; h += q.a*Math.sin(q.dx*x + q.dz*z - q.w*t + q.p); }
  return h;
}
// the same sum (and its gradient) in GLSL, from the table above
function f(v){ var s = (+v).toFixed(6); return s.indexOf(".") < 0 ? s + ".0" : s; }
function waveGlsl(){
  var h = [], gx = [], gz = [];
  WK.forEach(function(q){
    var ph = "(" + f(q.dx) + "*p.x + " + f(q.dz) + "*p.y - " + f(q.w) + "*t + " + f(q.p) + ")";
    h.push(f(q.a) + "*sin" + ph); gx.push(f(q.a*q.dx) + "*cos" + ph); gz.push(f(q.a*q.dz) + "*cos" + ph);
  });
  return "float waveH(vec2 p, float t){ return " + h.join(" + ") + "; }\n" +
         "vec2 waveG(vec2 p, float t){ return vec2(" + gx.join(" + ") + ", " + gz.join(" + ") + "); }\n";
}

/* ---------- the archipelago ---------- */
// coast radius (m) of an island and of the Commons; skyline radius per tier; arrival distances;
// impostors further than HORIZON are drawn at HORIZON (inside the camera's 3 km far plane)
var COAST_R = {island: 850, commons: 1000};
var SKY_R = [120, 220, 320, 420, 520];
var ARRIVE = {dock: 400, coast: 300};
var HORIZON = 2400;
var WORLD_RE = /^(claude-hq@[0-9]+|user:[0-9a-f-]{36}@[0-9]+)$/;
var ARCH = {list: [], cur: null, ox: 0, oz: 0, ver: 0};
function num(v){ v = +v; return isFinite(v) ? v : null; }
function hash32(s){ s = String(s); var h = 0x811c9dc5; for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
function setArchipelago(data, current){
  data = data || {};
  var list = [];
  function addOne(o, commons){
    if(!o || typeof o.world !== "string" || !WORLD_RE.test(o.world)) return;
    var x = num(o.x), z = num(o.z); if(x == null || z == null) return;
    var docks = Array.isArray(o.docks) ? o.docks.filter(function(d){ return Array.isArray(d) && num(d[0]) != null && num(d[1]) != null; })
                                                .map(function(d){ return [+d[0], +d[1]]; }) : null;
    list.push({world: o.world, owner: commons ? "commons" : String(o.owner || ""), name: commons ? "The Commons" : String(o.name || ""),
               x: x, z: z, tier: commons ? 5 : Math.max(1, Math.min(5, o.tier | 0 || 1)), commons: !!commons,
               r: commons ? COAST_R.commons : COAST_R.island, docks: docks && docks.length ? docks : null, yaw: (hash32(o.world) % 6283)/1000});
  }
  addOne(data.commons, true);
  (Array.isArray(data.islands) ? data.islands : []).forEach(function(o){ addOne(o, false); });
  var here = null;
  for(var i = 0; i < list.length; i++) if(list[i].world === current){ here = list[i]; break; }
  var ox = here ? here.x : 0, oz = here ? here.z : 0, shift = {dx: ox - ARCH.ox, dz: oz - ARCH.oz};
  ARCH = {list: list, cur: here ? here.world : null, ox: ox, oz: oz, ver: ARCH.ver + 1};
  return shift;
}
// -> the nearest island you are not on (local frame), or null
function nearestIsland(x, z){
  x = +x || 0; z = +z || 0;
  var best = null, bd = Infinity, L = ARCH.list;
  for(var i = 0; i < L.length; i++){
    var o = L[i]; if(o.world === ARCH.cur) continue;
    var ix = o.x - ARCH.ox, iz = o.z - ARCH.oz, d = Math.hypot(x - ix, z - iz);
    if(d < bd){ bd = d; best = o; }
  }
  if(!best) return null;
  var bx = best.x - ARCH.ox, bz = best.z - ARCH.oz, dock = null, dd = Infinity;
  (best.docks || []).forEach(function(p){ var q = Math.hypot(x - bx - p[0], z - bz - p[1]); if(q < dd){ dd = q; dock = {x: bx + p[0], z: bz + p[1]}; } });
  return {world: best.world, owner: best.owner, name: best.name, tier: best.tier, commons: best.commons, x: bx, z: bz,
          dist: bd, shore: bd - best.r, dock: dock, arrive: dock ? dd < ARRIVE.dock : bd - best.r < ARRIVE.coast};
}
// out: Float32Array (5 per island) or null (one is made); -> {n, out}
function horizon(cx, cz, out){
  var L = ARCH.list, n = 0;
  if(!out || out.length < L.length*5) out = new Float32Array(Math.max(5, L.length*5));
  cx = +cx || 0; cz = +cz || 0;
  for(var i = 0; i < L.length; i++){
    var o = L[i]; if(o.world === ARCH.cur) continue;
    var dx = o.x - ARCH.ox - cx, dz = o.z - ARCH.oz - cz, d = Math.sqrt(dx*dx + dz*dz), s = 1;
    if(d > HORIZON){ s = HORIZON/d; dx *= s; dz *= s; }
    var j = n*5;
    out[j] = cx + dx; out[j + 1] = cz + dz; out[j + 2] = s; out[j + 3] = o.yaw; out[j + 4] = o.commons ? 6 : o.tier;
    n++;
  }
  return {n: n, out: out};
}

/* ---------- a WorldDoc's coast and docks as the boats' sea ---------- */
function inPoly(P, x, z){
  var inside = false;
  for(var i = 0, j = P.length - 1; i < P.length; j = i++){
    var xi = P[i][0], zi = P[i][1], xj = P[j][0], zj = P[j][1];
    if((zi > z) !== (zj > z) && x < (xj - xi)*(z - zi)/(zj - zi) + xi) inside = !inside;
  }
  return inside;
}
// land(x, z): inside any of the coast polygons (metres), a bounding box first
function landTest(polys){
  var P = (polys || []).filter(function(p){ return p && p.length >= 3; }).map(function(p){
    var b = [Infinity, Infinity, -Infinity, -Infinity];
    p.forEach(function(q){ b[0] = Math.min(b[0], q[0]); b[1] = Math.min(b[1], q[1]); b[2] = Math.max(b[2], q[0]); b[3] = Math.max(b[3], q[1]); });
    return {p: p, b: b};
  });
  return function(x, z){
    for(var i = 0; i < P.length; i++){ var b = P[i].b; if(x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3] && inPoly(P[i].p, x, z)) return true; }
    return false;
  };
}
// The dock sites' berths: BERTH_OFF m off the head of the pier games/hqcivic.js lays (pierOf), facing out
// along it: a moored hull (3.6 m at most) lies in open water just clear of the deck, in reach from its
// edge. Without hqcivic (no pier is drawn): off the site's edge on whichever side of its front is
// water, 4 m out, facing out.
var BERTH_OFF = 2.4;
function docksOf(doc, land){
  var L = (doc && doc.layers) || {}, I = L.island || {}, ids = {}, out = [];
  (I.docks || []).forEach(function(id){ ids[id] = 1; });
  land = land || landTest([coastOf(doc)]);
  (L.sites || []).forEach(function(s){
    if(!s || !ids[s.id]) return;
    var pier = HQV.hqCivic && HQV.hqCivic.pierOf ? HQV.hqCivic.pierOf(s)[0] : null;
    if(pier){
      out.push({id: s.id, x: pier.head[0] + pier.dir[0]*BERTH_OFF, z: pier.head[1] + pier.dir[1]*BERTH_OFF, yaw: Math.atan2(pier.dir[0], pier.dir[1])});
      return;
    }
    var fr = s.front || [0, 65536], fx = (+fr[0] || 0)/65536, fz = (+fr[1] || 0)/65536, fl = Math.hypot(fx, fz) || 1;
    fx /= fl; fz /= fl;
    var cx = (+s.x || 0)/100, cz = (+s.z || 0)/100, reach = Math.max(+s.w || 0, +s.d || 0)/200 + 4;
    var a = [cx + fx*reach, cz + fz*reach], b = [cx - fx*reach, cz - fz*reach], out1 = !land(a[0], a[1]) || land(b[0], b[1]);
    var p = out1 ? a : b, sg = out1 ? 1 : -1;
    out.push({id: s.id, x: p[0], z: p[1], yaw: Math.atan2(fx*sg, fz*sg)});
  });
  return out;
}
function coastOf(doc){
  var I = ((doc && doc.layers) || {}).island || {};
  return (I.coast || []).map(function(p){ return [(+p[0] || 0)/100, (+p[1] || 0)/100]; });
}
// -> hqboat's sea for this island: {land, docks, y, wave}
function seaOf(doc, wave){
  var I = ((doc && doc.layers) || {}).island || {}, land = landTest([coastOf(doc)]);
  return {land: land, docks: docksOf(doc, land), y: (+I.sea_cm || 0)/100, wave: wave || waveAt};
}

/* ---------- wakes ---------- */
// trail = {pts: [{x, z, yaw, w, t, a}]}: a point every WAKE.step m (or WAKE.dt s while moving), kept for
// WAKE.life s; the V's arms spread with age and fade out. Time-based: frame-rate independent.
var WAKE = {step: 1.5, dt: 0.25, life: 6, max: 48, spread: 0.6, arm: 0.5};
// across the strip, per point: the left arm's outer edge, crest and inner edge, then the right's inner
// edge, crest and outer edge (offsets from the centreline, m, + = left), and each one's share of the alpha:
// foam on the two crests, a little churned water between them, soft outer edges
var WAKE_A = [0, 1, 0.22, 0.22, 1, 0];
function wakePush(trail, x, z, yaw, speed, t, beam){
  trail = trail || {pts: []};
  var P = trail.pts, last = P[P.length - 1], sp = Math.abs(+speed || 0);
  if(sp > 0.4 && (!last || Math.hypot(x - last.x, z - last.z) >= WAKE.step || t - last.t >= WAKE.dt))
    P.push({x: x, z: z, yaw: yaw, w: (+beam || 1)*0.5, t: t, a: Math.min(1, sp/3)});
  while(P.length && (t - P[0].t > WAKE.life || P.length > WAKE.max)) P.shift();
  return trail;
}
// -> {n (points), k (vertices per point, 6), pos: [x, z] per vertex, newest point first, alpha per vertex}
function wakeStrip(trail, t){
  var P = (trail && trail.pts) || [], pos = [], al = [];
  for(var i = P.length - 1; i >= 0; i--){
    var p = P[i], age = Math.max(0, t - p.t), w = p.w + age*WAKE.spread, cx = Math.cos(p.yaw), sx = Math.sin(p.yaw);
    var m = WAKE.arm, off = [w + m, w, Math.max(0, w - m), -Math.max(0, w - m), -w, -w - m];
    var a = p.a*Math.max(0, 1 - age/WAKE.life);
    for(var j = 0; j < 6; j++){ pos.push(p.x + cx*off[j], p.z - sx*off[j]); al.push(a*WAKE_A[j]); }
  }
  return {n: P.length, k: 6, pos: pos, alpha: al};
}

/* ---------- drawing ---------- */
function ease(k, dt){ return 1 - Math.exp(-Math.max(0, +k || 0)*Math.max(0, +dt || 0)); }
var SEA_R = 3000, RINGS = 56, SEGS = 96;
var TINT = {day: {deep: 0x14507a, shallow: 0x2f8fb3, sky: 0xcfe8f7, sun: 0xfff1d0},
            night: {deep: 0x061a2c, shallow: 0x0f3550, sky: 0x1d3a56, sun: 0x9fb8d8}};
// rings spaced finer near the camera: r_i = SEA_R*(i/RINGS)^2
function seaGeo(THREE){
  var pos = [0, 0, 0], idx = [];
  for(var i = 1; i <= RINGS; i++){
    var r = SEA_R*Math.pow(i/RINGS, 2);
    for(var j = 0; j < SEGS; j++){ var a = j/SEGS*PI*2; pos.push(Math.sin(a)*r, 0, Math.cos(a)*r); }
  }
  for(j = 0; j < SEGS; j++) idx.push(0, 1 + j, 1 + (j + 1) % SEGS);
  for(i = 1; i < RINGS; i++){
    var a0 = 1 + (i - 1)*SEGS, a1 = 1 + i*SEGS;
    for(j = 0; j < SEGS; j++){ var j1 = (j + 1) % SEGS; idx.push(a0 + j, a1 + j, a1 + j1, a0 + j, a1 + j1, a0 + j1); }
  }
  var g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
  return g;
}
function seaMaterial(THREE){
  var U = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    uTime: {value: 0}, uNight: {value: 0}, uCam: {value: new THREE.Vector3()},
    uDeep: {value: new THREE.Color()}, uShallow: {value: new THREE.Color()}, uSky: {value: new THREE.Color()}, uSun: {value: new THREE.Color()},
    uSunDir: {value: new THREE.Vector3(0.4, 0.6, 0.3).normalize()}}]);
  return new THREE.ShaderMaterial({uniforms: U, fog: true,
    vertexShader: waveGlsl() +
      "uniform float uTime; uniform vec3 uCam; varying vec3 vW;\n#include <fog_pars_vertex>\n" +
      "void main(){ vec4 w = modelMatrix*vec4(position, 1.0); float fade = 1.0 - smoothstep(150.0, 600.0, distance(w.xz, uCam.xz));\n" +
      "  w.y += waveH(w.xz, uTime)*fade; vW = w.xyz; vec4 mvPosition = viewMatrix*w; gl_Position = projectionMatrix*mvPosition;\n" +
      "  #include <fog_vertex>\n}",
    fragmentShader: waveGlsl() +
      "uniform float uTime; uniform float uNight; uniform vec3 uCam; uniform vec3 uDeep; uniform vec3 uShallow; uniform vec3 uSky; uniform vec3 uSun; uniform vec3 uSunDir;\n" +
      "varying vec3 vW;\n#include <fog_pars_fragment>\n" +
      "void main(){ float d = distance(vW.xz, uCam.xz); vec2 gr = waveG(vW.xz, uTime)*(1.0 - smoothstep(400.0, 2500.0, d));\n" +
      "  vec3 n = normalize(vec3(-gr.x, 1.0, -gr.y)); vec3 v = normalize(uCam - vW);\n" +
      "  float fr = pow(1.0 - max(dot(n, v), 0.0), 4.0); vec3 col = mix(uDeep, uShallow, 0.35 + 0.65*clamp(n.y*8.0 - 7.0, 0.0, 1.0));\n" +
      "  col = mix(col, uSky, 0.15 + 0.6*fr); vec3 h = normalize(uSunDir + v); float sp = pow(max(dot(n, h), 0.0), mix(180.0, 90.0, uNight));\n" +
      "  col += uSun*sp*mix(0.9, 0.35, uNight); gl_FragColor = vec4(col, 1.0);\n" +
      "  #include <fog_fragment>\n}"});
}
// the impostors' shader: vertex colours tinted by day toward a haze, by night dark with lit windows (aGlow)
function impostorMaterial(THREE){
  return new THREE.ShaderMaterial({uniforms: {uNight: {value: 0}, uHaze: {value: new THREE.Color(0xb8cde0)}, uNightHaze: {value: new THREE.Color(0x0d1a28)}},
    vertexColors: true, fog: false,
    vertexShader: "attribute float aGlow; varying vec3 vC; varying float vG;\n" +
      "void main(){ vC = color; vG = aGlow; vec4 p = vec4(position, 1.0);\n#ifdef USE_INSTANCING\n p = instanceMatrix*p;\n#endif\n" +
      " gl_Position = projectionMatrix*modelViewMatrix*p; }",
    fragmentShader: "uniform float uNight; uniform vec3 uHaze; uniform vec3 uNightHaze; varying vec3 vC; varying float vG;\n" +
      "void main(){ vec3 day = mix(vC, uHaze, 0.55); vec3 night = mix(vC*0.15, uNightHaze, 0.5) + vec3(1.0, 0.82, 0.5)*vG*0.9;\n" +
      " gl_FragColor = vec4(mix(day, night, uNight), 1.0); }"});
}
// geometry pieces with a colour and a glow per vertex, merged into one BufferGeometry
function pieces(THREE, list){
  var pos = [], col = [], glow = [], idx = [];
  list.forEach(function(p){
    var g = p.geo, base = pos.length/3, c = new THREE.Color(p.color);
    if(p.m) g.applyMatrix4(p.m);
    var P = g.attributes.position;
    for(var i = 0; i < P.count; i++){ pos.push(P.getX(i), P.getY(i), P.getZ(i)); col.push(c.r, c.g, c.b); glow.push(p.glow ? 1 : 0); }
    if(g.index) for(i = 0; i < g.index.count; i++) idx.push(base + g.index.getX(i));
    else for(i = 0; i < P.count; i++) idx.push(base + i);
  });
  var out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); out.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  out.setAttribute("aGlow", new THREE.Float32BufferAttribute(glow, 1)); out.setIndex(idx);
  return out;
}
// an island's silhouette, radius 1 (scaled by its coast radius): a sand ring and a low green hill, 10 sides
function silhouetteGeo(THREE){
  var M = new THREE.Matrix4();
  return pieces(THREE, [
    {geo: new THREE.CylinderGeometry(0.97, 1.0, 0.012, 10), color: 0xd8c79a, m: M.clone().makeTranslation(0, 0.006, 0)},
    {geo: new THREE.CylinderGeometry(0.45, 0.9, 0.06, 10), color: 0x4f8a4a, m: M.clone().makeTranslation(0, 0.042, 0)}]);
}
// a skyline for tier t (1..5, 6 the Commons): towers on a ring, taller and more of them by tier; a lit window band each
function skylineGeo(THREE, t){
  var n = 2 + t*3, R = SKY_R[Math.min(5, t) - 1], rnd = hash32("sky" + t), list = [];
  for(var i = 0; i < n; i++){
    rnd = Math.imul(rnd ^ (rnd >>> 15), 0x2c1b3c6d) >>> 0;
    var a = i/n*PI*2 + (rnd % 100)/100, r = R*(0.15 + 0.85*((rnd >>> 8) % 1000)/1000), h = 18 + t*14*(0.4 + ((rnd >>> 4) % 600)/1000);
    var w = 16 + (rnd % 18), x = Math.sin(a)*r, z = Math.cos(a)*r, M = new THREE.Matrix4();
    list.push({geo: new THREE.BoxGeometry(w, h, w), color: [0x8c9bab, 0x9aa7b4, 0x7d8b99][i % 3], m: M.clone().makeTranslation(x, 30 + h/2, z)});
    list.push({geo: new THREE.BoxGeometry(w*1.02, h*0.5, w*1.02), color: 0x8c9bab, glow: true, m: M.clone().makeTranslation(x, 30 + h*0.55, z)});
  }
  return pieces(THREE, list);
}

function mount(c, parent){
  var THREE = c.THREE, g = new THREE.Group(); g.name = "ocean"; parent.add(g);
  var seaM = seaMaterial(THREE), sea = new THREE.Mesh(seaGeo(THREE), seaM); sea.frustumCulled = false; sea.renderOrder = -10; g.add(sea);
  var impM = impostorMaterial(THREE), cap = 0, sil = null, sky = [], buf = null, seen = -1;
  var night = 0, nightGoal = 0, tmp = {d: new THREE.Color(), n: new THREE.Color()};
  function tint(){
    var U = seaM.uniforms;
    [["uDeep", "deep"], ["uShallow", "shallow"], ["uSky", "sky"], ["uSun", "sun"]].forEach(function(k){
      U[k[0]].value.copy(tmp.d.setHex(TINT.day[k[1]])).lerp(tmp.n.setHex(TINT.night[k[1]]), night);
    });
    U.uNight.value = night; impM.uniforms.uNight.value = night;
  }
  // (re)build the instanced meshes when the archipelago grows past what they hold
  function build(n){
    if(sil){ g.remove(sil); sil.dispose(); sky.forEach(function(m){ g.remove(m); m.dispose(); }); }
    cap = Math.max(8, n);
    sil = new THREE.InstancedMesh(silhouetteGeo(THREE), impM, cap); sil.frustumCulled = false; sil.count = 0; g.add(sil);
    sky = [1, 2, 3, 4, 5, 6].map(function(t){ var m = new THREE.InstancedMesh(skylineGeo(THREE, t), impM, cap); m.frustumCulled = false; m.count = 0; g.add(m); return m; });
  }
  build(ARCH.list.length);
  // one matrix: yaw about y, uniform scale, at (x, y, z)
  function put(m, i, x, y, z, s, yaw){
    var e = m.instanceMatrix.array, o = i*16, cy = Math.cos(yaw)*s, sy = Math.sin(yaw)*s;
    e[o] = cy; e[o + 1] = 0; e[o + 2] = -sy; e[o + 3] = 0; e[o + 4] = 0; e[o + 5] = s; e[o + 6] = 0; e[o + 7] = 0;
    e[o + 8] = sy; e[o + 9] = 0; e[o + 10] = cy; e[o + 11] = 0; e[o + 12] = x; e[o + 13] = y; e[o + 14] = z; e[o + 15] = 1;
  }
  function impostors(cx, cz){
    if(ARCH.ver !== seen){ seen = ARCH.ver; if(ARCH.list.length > cap) build(ARCH.list.length); }
    var H = horizon(cx, cz, buf); buf = H.out;
    var counts = [0, 0, 0, 0, 0, 0], ns = 0, by = H.out;
    for(var i = 0; i < H.n; i++){
      var j = i*5, x = by[j], z = by[j + 1], s = by[j + 2], yaw = by[j + 3], t = by[j + 4] | 0, R = t === 6 ? COAST_R.commons : COAST_R.island;
      put(sil, ns++, x, 0, z, R*s, yaw);
      var m = sky[t - 1]; put(m, counts[t - 1]++, x, 0, z, s, yaw);
    }
    sil.count = ns; sil.instanceMatrix.needsUpdate = true;
    sky.forEach(function(m, k){ m.count = counts[k]; m.instanceMatrix.needsUpdate = true; });
    return H.n;
  }
  // wakes: one ribbon per boat id, rebuilt from its trail each frame
  var wakeM = new THREE.MeshBasicMaterial({color: 0xf4fbff, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true});
  var wakes = {}, clock = 0;
  function ribbon(){
    var geo = new THREE.BufferGeometry(), n = WAKE.max*6;
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n*3), 3));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n*4), 4));
    var idx = [];
    for(var i = 0; i < WAKE.max - 1; i++) for(var j = 0; j < 5; j++){ var a = i*6 + j, b = a + 6; idx.push(a, b, a + 1, a + 1, b, b + 1); }
    geo.setIndex(idx); geo.setDrawRange(0, 0);
    var m = new THREE.Mesh(geo, wakeM); m.frustumCulled = false; m.renderOrder = -9; g.add(m);
    return {m: m, trail: {pts: []}};
  }
  var o = {g: g, sea: sea, sil: function(){ return sil; }, sky: function(){ return sky; },
    setTime: function(n){ nightGoal = n ? 1 : 0; },
    // the direction toward the sun (or the moon by night) for the glint: {x, y, z}
    setSun: function(d){ if(d && isFinite(d.x) && isFinite(d.y) && isFinite(d.z)) seaM.uniforms.uSunDir.value.set(d.x, d.y, d.z).normalize(); },
    // boats = [{id, x, z, yaw, speed, beam}]: push each trail; a boat no longer listed lets its wake fade then goes
    wake: function(boats){
      var live = {};
      (boats || []).forEach(function(b){ if(!b || b.id == null) return; live[b.id] = 1; var w = wakes[b.id] || (wakes[b.id] = ribbon()); wakePush(w.trail, +b.x || 0, +b.z || 0, +b.yaw || 0, b.speed, clock, b.beam); });
      Object.keys(wakes).forEach(function(id){ if(!live[id]){ var w = wakes[id]; wakePush(w.trail, 0, 0, 0, 0, clock); if(!w.trail.pts.length){ g.remove(w.m); w.m.geometry.dispose(); delete wakes[id]; } } });
    },
    // t: seconds (the scene's clock), dt: this frame, cam: {x, y, z} -> how many impostors drawn
    step: function(t, dt, cam){
      cam = cam || {x: 0, y: 0, z: 0}; clock = +t || 0;
      night += (nightGoal - night)*ease(1.5, dt); tint();
      var calm = c.E && c.E.calm && c.E.calm();
      seaM.uniforms.uTime.value = calm ? 0 : clock; seaM.uniforms.uCam.value.set(cam.x || 0, cam.y || 0, cam.z || 0);
      sea.position.set(Math.round((cam.x || 0)/32)*32, 0, Math.round((cam.z || 0)/32)*32);     // snapped: the grid never swims
      Object.keys(wakes).forEach(function(id){
        var w = wakes[id], S = wakeStrip(w.trail, clock), P = w.m.geometry.attributes.position, C = w.m.geometry.attributes.color;
        for(var i = 0; i < S.n*6; i++){
          var x = S.pos[i*2], z = S.pos[i*2 + 1];
          P.array[i*3] = x; P.array[i*3 + 1] = 0.03 + (calm ? 0 : waveAt(x, z, clock)); P.array[i*3 + 2] = z;
          C.array[i*4] = C.array[i*4 + 1] = C.array[i*4 + 2] = 1; C.array[i*4 + 3] = S.alpha[i]*0.8;
        }
        P.needsUpdate = true; C.needsUpdate = true; w.m.geometry.setDrawRange(0, Math.max(0, S.n - 1)*30);
      });
      return impostors(cam.x || 0, cam.z || 0);
    },
    drawCalls: function(){ return 1 + 1 + sky.length + Object.keys(wakes).length; },
    dispose: function(){
      parent.remove(g);
      g.traverse(function(m){ if(m.geometry) m.geometry.dispose(); });
      seaM.dispose(); impM.dispose(); wakeM.dispose();
    }};
  tint();
  return o;
}

HQV.ocean = {WAVES: WAVES, COAST_R: COAST_R, SKY_R: SKY_R, ARRIVE: ARRIVE, HORIZON: HORIZON, WAKE: WAKE,
  waveAt: waveAt, waveGlsl: waveGlsl, setArchipelago: setArchipelago, nearestIsland: nearestIsland, horizon: horizon,
  inPoly: inPoly, landTest: landTest, coastOf: coastOf, docksOf: docksOf, seaOf: seaOf,
  wakePush: wakePush, wakeStrip: wakeStrip, mount: mount,
  current: function(){ return {world: ARCH.cur, x: ARCH.ox, z: ARCH.oz, count: ARCH.list.length}; }};
})();
