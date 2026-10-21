/* Claude HQ 3.2: weather over the 3D City (HQV.hqWeather; games/hqcity3d.js wires it in).
 *
 * The forecast is the same for everyone and sends nothing anywhere: a pure function of the UTC clock and the
 * world id, in SLOT-long slots, so two players in one city see the same storm at the same moment.
 *   kindAt(world, slot)   one of KINDS, weighted by WEIGHT
 *   at(world, ms)         {kind, prev, e (0..1: how far this slot's weather has eased in), slot, next (ms)}
 *   look(world, ms)       the blended look: {kind, prev, e, dim, fogNear, fogFar, tint, tintK, rain, snow, cloud,
 *                         wind, storm, wx, wz (the wind's direction)}
 *   strikes(world, sec)   the lightning strikes in the STRIKE_WIN s window holding `sec`: [{t, x, z, seed}]
 *   forecast(world, ms, n) this slot and the n after it: [{kind, name, icon, at (ms)}]
 * The top half is pure (no THREE, no DOM): tests/test_hqweather.py runs it under node.
 *
 * Drawing (needs THREE through hq3d's ctx): create(c, {scene, world, say}) ->
 *   {update(t, dt, cam) -> look + {flash 0..1}, kind(), forecast(n), destroy()}
 *   rain   streaks in a box anchored to the world around the camera: a shader moves them, nothing is uploaded per frame
 *   snow   soft flakes that sway as they fall
 *   cloud  a deck of soft billboards drifting with the wind, darker under a storm and at night
 *   storm  rain at full and lightning: a forked bolt, the sky lit for a moment, thunder after the light (343 m/s)
 * Calm and reduced motion: nothing falls and nothing flashes (a lightning flash is a photosensitivity hazard);
 * the sky, the fog and the cloud deck still change, slowly. The map view (top down) draws no weather.
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : globalThis;
var HQV = root.HQV = root.HQV || {};

var SLOT = 15*60*1000, EASE = 90*1000, STRIKE_WIN = 10;
var PUDDLE_NEAR = 130, PUDDLE_MAX = 420, PUDDLE_CELL = 64;    // drawn within PUDDLE_NEAR m, at most PUDDLE_MAX
var KINDS = ["clear", "cloudy", "rain", "storm", "snow", "fog"];
var WEIGHT = [34, 20, 18, 9, 8, 11];                      // per 100 slots
// dim: how far the sun and the sky darken; fog in metres; tint: the overcast sky the day sky leans to (tintK);
// rain, snow, cloud, storm: 0..1; wind: how hard it blows (rain slants, clouds drift)
var LOOK = {
  clear:  {dim: 0,    fogNear: 300, fogFar: 1600, tint: 0xcfe8f7, tintK: 0,    rain: 0,    snow: 0, cloud: 0.3,  wind: 0.2, storm: 0},
  cloudy: {dim: 0.35, fogNear: 220, fogFar: 1150, tint: 0x9aa6b2, tintK: 0.6,  rain: 0,    snow: 0, cloud: 0.9,  wind: 0.4, storm: 0},
  rain:   {dim: 0.55, fogNear: 90,  fogFar: 620,  tint: 0x6f7c88, tintK: 0.82, rain: 0.7,  snow: 0, cloud: 1,    wind: 0.6, storm: 0},
  storm:  {dim: 0.78, fogNear: 60,  fogFar: 460,  tint: 0x3a434e, tintK: 0.93, rain: 1,    snow: 0, cloud: 1,    wind: 1,   storm: 1},
  snow:   {dim: 0.4,  fogNear: 80,  fogFar: 540,  tint: 0xd6dde6, tintK: 0.78, rain: 0,    snow: 1, cloud: 0.95, wind: 0.3, storm: 0},
  fog:    {dim: 0.3,  fogNear: 10,  fogFar: 165,  tint: 0xb9c2ca, tintK: 0.88, rain: 0,    snow: 0, cloud: 0.6,  wind: 0.1, storm: 0}
};
var NAME = {clear: "Clear skies", cloudy: "Overcast", rain: "Rain", storm: "Thunderstorm", snow: "Snow", fog: "Fog"};
var ICON = {clear: "☀️", cloudy: "☁️", rain: "🌧️", storm: "⛈️", snow: "🌨️", fog: "🌫️"};
var SAY = {clear: "The clouds part: clear skies over the city.", cloudy: "Clouds roll in over the city.",
           rain: "It starts to rain.", storm: "A thunderstorm breaks over the city.", snow: "Snow begins to fall.",
           fog: "A thick fog settles over the streets."};

function hash32(s){
  var h = 0x811c9dc5; s = String(s);
  for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function clamp(v, a, b){ return v < a ? a : (v > b ? b : v); }
function smooth(t){ t = clamp(t, 0, 1); return t*t*(3 - 2*t); }
function lerp(a, b, k){ return a + (b - a)*k; }
function lerpHex(a, b, k){
  var r = Math.round(lerp((a >> 16) & 255, (b >> 16) & 255, k)), g = Math.round(lerp((a >> 8) & 255, (b >> 8) & 255, k)),
      bl = Math.round(lerp(a & 255, b & 255, k));
  return (r << 16) | (g << 8) | bl;
}

function kindAt(world, slot){
  var h = hash32("wx:" + (world || "") + ":" + (slot | 0)) % 100;
  for(var i = 0; i < WEIGHT.length; i++){ if(h < WEIGHT[i]) return KINDS[i]; h -= WEIGHT[i]; }
  return KINDS[0];
}
function at(world, ms){
  var slot = Math.floor((+ms || 0)/SLOT), into = (+ms || 0) - slot*SLOT;
  return {kind: kindAt(world, slot), prev: kindAt(world, slot - 1), e: smooth(into/EASE), slot: slot, next: (slot + 1)*SLOT};
}
// the wind's heading for a slot (unit vector), so the rain slants and the clouds drift one way all slot long
function windDir(world, slot){ var a = (hash32("wind:" + (world || "") + ":" + slot) % 3600)/3600*Math.PI*2; return {x: Math.cos(a), z: Math.sin(a)}; }
function look(world, ms){
  var A = at(world, ms), p = LOOK[A.prev], q = LOOK[A.kind], k = A.e, o = {kind: A.kind, prev: A.prev, e: k};
  ["dim", "fogNear", "fogFar", "tintK", "rain", "snow", "cloud", "wind", "storm"].forEach(function(f){ o[f] = lerp(p[f], q[f], k); });
  o.tint = lerpHex(p.tint, q.tint, k);
  var w = windDir(world, A.slot); o.wx = w.x; o.wz = w.z;
  return o;
}
// Up to two strikes per window, anywhere over the city (world-anchored, so everyone sees the same bolt).
function strikes(world, sec){
  var win = Math.floor((+sec || 0)/STRIKE_WIN), h = hash32("bolt:" + (world || "") + ":" + win), n = h % 3, out = [];
  for(var i = 0; i < n; i++){
    var h2 = hash32(h + ":" + i);
    out.push({t: win*STRIKE_WIN + (((h2 >>> 8) & 1023)/1023)*STRIKE_WIN,
              x: (((h2 >>> 18) & 1023)/1023 - 0.5)*1800, z: ((hash32(h2 + "z") & 1023)/1023 - 0.5)*1800, seed: h2});
  }
  return out;
}
// How wet the ground is (0..1): the rain now, or what fell in the last minutes drying off, so puddles stay a
// while after a shower. Snow lies; it makes no puddles.
function wetness(world, ms){
  var w = look(world, ms).rain;
  [[2, 0.8], [5, 0.5], [9, 0.25]].forEach(function(b){ w = Math.max(w, look(world, ms - b[0]*60000).rain*b[1]); });
  return clamp(w, 0, 1);
}
// Where puddles lie on a packed world (games/world.js), each {x, z, r (m), yaw, ax (elongation), ph}: in a dirt
// track's ruts every few metres (its potholes), by a paved street's kerbs now and then. Pure and deterministic.
function puddleSpots(W){
  var out = [];
  if(!W || !W.edges) return out;
  var seed = String(W.hash || W.id || "");
  W.edges.forEach(function(e){
    if(e.cls === "highway" || e.cls === "ring" || e.bridge) return;
    var dirt = e.surface === "dirt", P = [];
    if(dirt && e.track){ for(var t = 0; t + 1 < e.track.length; t += 2) P.push([e.track[t]/100, e.track[t+1]/100]); }
    else for(var j = 0; j + 2 < e.pts.length; j += 3) P.push([e.pts[j]/100, e.pts[j+2]/100]);
    var step = dirt ? 7 : 24, carry = 0, n = 0, half = dirt ? 1.75 : Math.max(1, (e.width - 2*(e.walk || 0))/200);
    for(var k = 0; k + 1 < P.length; k++){
      var ax = P[k][0], az = P[k][1], dx = P[k+1][0] - ax, dz = P[k+1][1] - az, L = Math.sqrt(dx*dx + dz*dz);
      if(L < 1e-6) continue;
      var ux = dx/L, uz = dz/L;
      for(var d = step - carry; d < L; d += step){
        var h = hash32("pud:" + seed + ":" + e.id + ":" + (n++));
        if((h % 100) >= (dirt ? 55 : 22)) continue;
        // a rut either side or the crown on a track; by either kerb on a paved street
        var side = (h >>> 8) & 1 ? 1 : -1, off = dirt ? (((h >>> 9) % 3) - 1)*0.8 : side*(half - 0.45);
        var x = ax + ux*d - uz*off, z = az + uz*d + ux*off;
        out.push({x: x, z: z, r: dirt ? 0.7 + ((h >>> 12) % 100)/100*1.3 : 0.45 + ((h >>> 12) % 100)/100*0.6,
                  yaw: Math.atan2(ux, uz), ax: dirt ? 1.4 + ((h >>> 20) % 50)/50 : 1.8, ph: ((h >>> 4) % 628)/100});
      }
      carry = (carry + L) % step;
    }
  });
  return out;
}
function forecast(world, ms, n){
  var A = at(world, ms), out = [];
  for(var i = 0; i <= Math.max(0, n | 0); i++){
    var k = kindAt(world, A.slot + i);
    out.push({kind: k, name: NAME[k], icon: ICON[k], at: (A.slot + i)*SLOT});
  }
  return out;
}

/* ---------- drawing ---------- */
function create(c, o){
  o = o || {};
  var THREE = c.THREE, E = c.E, S = o.scene, world = String(o.world || "");
  var g = new THREE.Group(); g.name = "weather"; S.add(g);
  var R = c.rng((hash32("wx-draw:" + world) % 100000) + 1);
  var V3 = function(x, y, z){ return new THREE.Vector3(x, y, z); };

  // rain: N streaks; each is two vertices (head, tail) on one base point; aK culls them by intensity
  var RAIN_N = 7000, RBOX = V3(110, 60, 110);
  var rp = new Float32Array(RAIN_N*6), re = new Float32Array(RAIN_N*2), rk = new Float32Array(RAIN_N*2);
  for(var i = 0; i < RAIN_N; i++){
    var x = R()*RBOX.x, y = R()*RBOX.y, z = R()*RBOX.z, k = R();
    for(var j = 0; j < 2; j++){ var v = i*2 + j; rp[v*3] = x; rp[v*3 + 1] = y; rp[v*3 + 2] = z; re[v] = j; rk[v] = k; }
  }
  var rg = new THREE.BufferGeometry();
  rg.setAttribute("position", new THREE.BufferAttribute(rp, 3));
  rg.setAttribute("aEnd", new THREE.BufferAttribute(re, 1)); rg.setAttribute("aK", new THREE.BufferAttribute(rk, 1));
  var WRAP = "vec3 rel = mod(w - uCam + uBox*0.5, uBox) - uBox*0.5;\n" +
             "float edge = 1.0 - smoothstep(0.3, 0.5, max(abs(rel.x)/uBox.x, abs(rel.z)/uBox.z));\n";
  var RU = {uTime: {value: 0}, uCam: {value: V3(0, 0, 0)}, uBox: {value: RBOX}, uVel: {value: V3(0, -26, 0)},
            uLen: {value: 0.034}, uAmt: {value: 0}, uCol: {value: new THREE.Color(0xa9b5c3)}, uAlpha: {value: 0.42}};
  var rain = new THREE.LineSegments(rg, new THREE.ShaderMaterial({uniforms: RU, transparent: true, depthWrite: false, fog: false,
    vertexShader: "uniform float uTime; uniform vec3 uCam; uniform vec3 uBox; uniform vec3 uVel; uniform float uLen; uniform float uAmt;\n" +
      "attribute float aEnd; attribute float aK; varying float vA;\n" +
      "void main(){\n vec3 w = position + uVel*uTime;\n" + WRAP +
      " vec3 p = uCam + rel - aEnd*uVel*uLen;\n vA = step(aK, uAmt)*edge;\n" +
      " gl_Position = projectionMatrix*viewMatrix*vec4(p, 1.0);\n}",
    fragmentShader: "uniform vec3 uCol; uniform float uAlpha; varying float vA;\n" +
      "void main(){ if(vA < 0.01) discard; gl_FragColor = vec4(uCol, uAlpha*vA); }"}));
  rain.frustumCulled = false; rain.renderOrder = 50; rain.visible = false; g.add(rain);

  // snow: soft round flakes, each swaying on its own phase
  var SNOW_N = 5000, SBOX = V3(90, 50, 90);
  var sp = new Float32Array(SNOW_N*3), sk = new Float32Array(SNOW_N), sph = new Float32Array(SNOW_N);
  for(i = 0; i < SNOW_N; i++){ sp[i*3] = R()*SBOX.x; sp[i*3 + 1] = R()*SBOX.y; sp[i*3 + 2] = R()*SBOX.z; sk[i] = R(); sph[i] = R()*6.283; }
  var sg = new THREE.BufferGeometry();
  sg.setAttribute("position", new THREE.BufferAttribute(sp, 3));
  sg.setAttribute("aK", new THREE.BufferAttribute(sk, 1)); sg.setAttribute("aPh", new THREE.BufferAttribute(sph, 1));
  var SU = {uTime: {value: 0}, uCam: {value: V3(0, 0, 0)}, uBox: {value: SBOX}, uVel: {value: V3(0, -1.5, 0)}, uAmt: {value: 0}, uBright: {value: 1}};
  var snow = new THREE.Points(sg, new THREE.ShaderMaterial({uniforms: SU, transparent: true, depthWrite: false, fog: false,
    vertexShader: "uniform float uTime; uniform vec3 uCam; uniform vec3 uBox; uniform vec3 uVel; uniform float uAmt;\n" +
      "attribute float aK; attribute float aPh; varying float vA;\n" +
      "void main(){\n vec3 w = position + uVel*uTime;\n" +
      " w.x += sin(uTime*0.9 + aPh)*0.9; w.z += cos(uTime*0.7 + aPh*1.3)*0.9;\n" + WRAP +
      " vec4 mv = viewMatrix*vec4(uCam + rel, 1.0);\n vA = step(aK, uAmt)*edge;\n" +
      " gl_PointSize = min(22.0, (2.2 + fract(aPh)*2.4)*(260.0/max(1.0, -mv.z)));\n" +
      " gl_Position = projectionMatrix*mv;\n}",
    fragmentShader: "uniform float uBright; varying float vA;\n" +
      "void main(){ vec2 d = gl_PointCoord - 0.5; float r = length(d); if(r > 0.5 || vA < 0.01) discard;\n" +
      " gl_FragColor = vec4(vec3(uBright), (1.0 - smoothstep(0.12, 0.5, r))*0.92*vA); }"}));
  snow.frustumCulled = false; snow.renderOrder = 51; snow.visible = false; g.add(snow);

  // the cloud deck: three soft cloud textures, drawn once from overlapping soft blobs (deterministic)
  function cloudTex(seed){
    var r = c.rng(seed);
    return c.canvasTex(256, 128, function(gx){
      gx.clearRect(0, 0, 256, 128);
      for(var b = 0; b < 26; b++){
        var bx = 40 + r()*176, by = 50 + (r() - 0.5)*44, br = 18 + r()*34, gr = gx.createRadialGradient(bx, by, 0, bx, by, br);
        gr.addColorStop(0, "rgba(255,255,255,0.55)"); gr.addColorStop(0.6, "rgba(255,255,255,0.22)"); gr.addColorStop(1, "rgba(255,255,255,0)");
        gx.fillStyle = gr; gx.beginPath(); gx.arc(bx, by, br, 0, Math.PI*2); gx.fill();
      }
    }).t;
  }
  var CT = [cloudTex(11), cloudTex(23), cloudTex(37)], CLOUD_N = 40, CBOX = 2600, clouds = [];
  for(i = 0; i < CLOUD_N; i++){
    var m = new THREE.SpriteMaterial({map: CT[i % 3], transparent: true, depthWrite: false, fog: false, opacity: 0});
    var spr = new THREE.Sprite(m), s = 380 + R()*420;
    spr.scale.set(s, s*0.42, 1); spr.renderOrder = -10;
    spr.userData = {x: R()*CBOX, z: R()*CBOX, y: 250 + R()*120, k: R()};
    g.add(spr); clouds.push(spr);
  }

  // lightning: one forked bolt, rebuilt per strike
  var boltG = new THREE.BufferGeometry(), boltM = new THREE.LineBasicMaterial({color: 0xeef4ff, transparent: true, opacity: 0, fog: false, depthWrite: false});
  var bolt = new THREE.LineSegments(boltG, boltM); bolt.frustumCulled = false; bolt.visible = false; g.add(bolt);
  function makeBolt(st, gy){
    var r = c.rng((st.seed % 100000) + 1), pts = [], x = st.x, z = st.z, y = 300, stack = [];
    function walk(x0, y0, z0, y1, spread, depth){
      var px = x0, py = y0, pz = z0;
      while(py > y1){
        var nx = px + (r() - 0.5)*spread, ny = py - (8 + r()*16), nz = pz + (r() - 0.5)*spread;
        if(ny < y1) ny = y1;
        pts.push(px, py, pz, nx, ny, nz);
        if(depth < 2 && r() < 0.16) stack.push([nx, ny, nz, Math.max(y1, ny - 40 - r()*80), spread*0.8, depth + 1]);
        px = nx; py = ny; pz = nz;
      }
    }
    walk(x, y, z, gy, 18, 0);
    while(stack.length){ var b = stack.pop(); walk(b[0], b[1], b[2], b[3], b[4], b[5]); }
    boltG.dispose(); boltG = new THREE.BufferGeometry(); boltG.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    bolt.geometry = boltG;
  }
  function thunder(dist, seed){
    var A = E.audioOut ? E.audioOut() : null; if(!A) return;
    try {
      var ac = A.ctx, dur = 3.4, n = Math.floor(ac.sampleRate*dur), buf = ac.createBuffer(1, n, ac.sampleRate), d = buf.getChannelData(0);
      var r = c.rng((seed % 100000) + 3), last = 0;
      for(var q = 0; q < n; q++){ last = (last + 0.02*(r()*2 - 1))/1.02; d[q] = last*3.4*(1 + 0.6*Math.sin(q/ac.sampleRate*9)); }   // brown noise, rolling
      var src = ac.createBufferSource(), lp = ac.createBiquadFilter(), gn = ac.createGain(), t0 = ac.currentTime;
      src.buffer = buf; lp.type = "lowpass"; lp.frequency.value = 140 + 520*Math.max(0, 1 - dist/1500);
      var vol = 0.85*Math.max(0.12, 1 - dist/1900);
      gn.gain.setValueAtTime(0.0001, t0); gn.gain.exponentialRampToValueAtTime(vol, t0 + 0.06); gn.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(lp); lp.connect(gn); gn.connect(A.out); src.start(t0); src.stop(t0 + dur);
    } catch(e){}
  }

  // puddles: the world's spots, bucketed; the nearest drawn as one instanced, sky-reflecting mesh
  var spots = o.W ? puddleSpots(o.W) : [], grid = {};
  spots.forEach(function(p, i){ var k = Math.floor(p.x/PUDDLE_CELL) + ":" + Math.floor(p.z/PUDDLE_CELL); (grid[k] = grid[k] || []).push(i); });
  var blobT = c.canvasTex(128, 128, function(gx){
    var r = c.rng(31); gx.clearRect(0, 0, 128, 128);
    for(var b = 0; b < 9; b++){ var bx = 64 + (r() - 0.5)*44, by = 64 + (r() - 0.5)*30, br = 22 + r()*20, gr = gx.createRadialGradient(bx, by, 0, bx, by, br);
      gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.7, "rgba(255,255,255,0.9)"); gr.addColorStop(1, "rgba(255,255,255,0)");
      gx.fillStyle = gr; gx.beginPath(); gx.arc(bx, by, br, 0, Math.PI*2); gx.fill(); }
  }).t;
  var skyT = (c.L && c.L.tex ? c.L.tex : new THREE.TextureLoader()).load("/games/city/sky.jpg");
  skyT.mapping = THREE.EquirectangularReflectionMapping; skyT.colorSpace = THREE.SRGBColorSpace;
  var PU = {uRain: {value: 0}, uT: {value: 0}};
  var pudM = new THREE.MeshStandardMaterial({color: 0x20262d, roughness: 0.04, metalness: 0.6, envMap: skyT, envMapIntensity: 1.1,
    alphaMap: blobT, transparent: true, depthWrite: false, opacity: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2});
  pudM.onBeforeCompile = function(sh){                // rings spreading where drops land, while it rains
    sh.uniforms.uRain = PU.uRain; sh.uniforms.uT = PU.uT;
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec2 vPud;\nvarying float vPh;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvPud = uv;\nvPh = instanceMatrix[3][0]*0.37 + instanceMatrix[3][2]*0.61;");
    sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nuniform float uRain;\nuniform float uT;\nvarying vec2 vPud;\nvarying float vPh;")
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n" +
        "float pr = 0.0;\nfor(int i = 0; i < 3; i++){ float fi = float(i); vec2 c0 = vec2(0.5) + 0.25*vec2(sin(vPh + fi*2.1), cos(vPh*1.3 + fi*1.7));\n" +
        " float t0 = fract(uT*0.9 + fi*0.33 + vPh); float d = length(vPud - c0); pr += (1.0 - t0)*smoothstep(0.02, 0.0, abs(d - t0*0.35)); }\n" +
        "totalEmissiveRadiance += vec3(0.55)*pr*uRain;");
  };
  pudM.customProgramCacheKey = function(){ return "hq-puddle"; };
  var pudG = new THREE.CircleGeometry(1, 20); pudG.rotateX(-Math.PI/2);
  var pud = new THREE.InstancedMesh(pudG, pudM, PUDDLE_MAX); pud.count = 0; pud.frustumCulled = false; pud.renderOrder = 2; pud.receiveShadow = true;
  pud.visible = false; g.add(pud);
  var pudAt = {x: 1e9, z: 1e9, wet: -1, t: 0}, pm4 = new THREE.Matrix4(), pq = new THREE.Quaternion(), pp = new THREE.Vector3(), ps = new THREE.Vector3(), pY = new THREE.Vector3(0, 1, 0);
  function puddles(cx, cz, wet, show, calm, t){
    pud.visible = show && wet > 0.03 && spots.length > 0;
    if(!pud.visible) return;
    PU.uRain.value = calm ? 0 : look(world, Date.now()).rain; PU.uT.value = t % 1000;
    pudM.opacity = 0.9*Math.min(1, wet*1.4);
    // re-pick the nearest only when you have moved or it has got wetter or drier: nothing per frame otherwise
    if(Math.hypot(cx - pudAt.x, cz - pudAt.z) < 8 && Math.abs(wet - pudAt.wet) < 0.04) return;
    pudAt.x = cx; pudAt.z = cz; pudAt.wet = wet;
    var near = [], R = PUDDLE_NEAR, c0x = Math.floor((cx - R)/PUDDLE_CELL), c1x = Math.floor((cx + R)/PUDDLE_CELL), c0z = Math.floor((cz - R)/PUDDLE_CELL), c1z = Math.floor((cz + R)/PUDDLE_CELL);
    for(var ix = c0x; ix <= c1x; ix++) for(var iz = c0z; iz <= c1z; iz++){
      var L2 = grid[ix + ":" + iz]; if(!L2) continue;
      for(var q = 0; q < L2.length; q++){ var sp = spots[L2[q]], d2 = (sp.x - cx)*(sp.x - cx) + (sp.z - cz)*(sp.z - cz); if(d2 < R*R) near.push([d2, L2[q]]); }
    }
    near.sort(function(a2, b2){ return a2[0] - b2[0] || a2[1] - b2[1]; });
    var n = Math.min(near.length, PUDDLE_MAX), grow = 0.35 + 0.65*wet;
    for(var k2 = 0; k2 < n; k2++){
      var p2 = spots[near[k2][1]], y = o.ground ? o.ground(p2.x, p2.z) : 0;
      pp.set(p2.x, y + 0.07, p2.z); pq.setFromAxisAngle(pY, p2.yaw); ps.set(p2.r*grow, 1, p2.r*p2.ax*grow);
      pm4.compose(pp, pq, ps); pud.setMatrixAt(k2, pm4);
    }
    pud.count = n; pud.instanceMatrix.needsUpdate = true;
  }

  var hiss = null, said = null, lastStrike = -1, pending = [], flash = 0, boltLeft = 0, cur = null, night = false;
  function amt(v){ return Math.max(0, Math.min(1, v)); }
  var inst = {
    setNight: function(n){ night = !!n; },
    kind: function(){ return cur ? cur.kind : "clear"; },
    name: function(k){ return NAME[k || (cur && cur.kind) || "clear"]; },
    icon: function(k){ return ICON[k || (cur && cur.kind) || "clear"]; },
    forecast: function(n){ return forecast(world, Date.now(), n); },
    // for tools and tests: what the puddles are drawing
    puddles: function(){ var out = []; for(var i = 0; i < Math.min(pud.count, 8); i++){ pud.getMatrixAt(i, pm4); pm4.decompose(pp, pq, ps); out.push([+pp.x.toFixed(1), +pp.y.toFixed(2), +pp.z.toFixed(1), +ps.x.toFixed(2)]); }
      return {visible: pud.visible, count: pud.count, opacity: +pudM.opacity.toFixed(2), first: out, spots: spots.length}; },
    update: function(t, dt, cam){
      var nowMs = Date.now(), L = look(world, nowMs), calm = E.calm(), mode = (cam && cam.mode) || "classic";
      cur = L;
      var cx = cam && cam.x != null ? cam.x : 0, cy = cam && cam.y != null ? cam.y : 0, cz = cam && cam.z != null ? cam.z : 0;
      var show = mode !== "map";
      // say it once it has mostly arrived (not on the first frame: you walked into it, nothing changed)
      if(said == null) said = L.kind;
      else if(L.kind !== said && L.e > 0.5){ said = L.kind; if(o.say) o.say(SAY[L.kind]); }
      // rain and snow: nothing falls in Calm
      var rainA = show && !calm ? amt(L.rain) : 0, snowA = show && !calm ? amt(L.snow) : 0;
      rain.visible = rainA > 0.01; snow.visible = snowA > 0.01;
      if(rain.visible){
        RU.uTime.value = t; RU.uCam.value.set(cx, cy, cz); RU.uAmt.value = rainA;
        RU.uVel.value.set(L.wx*L.wind*7, -26, L.wz*L.wind*7);
        RU.uAlpha.value = night ? 0.3 : 0.42;
      }
      if(snow.visible){
        SU.uTime.value = t; SU.uCam.value.set(cx, cy, cz); SU.uAmt.value = snowA;
        SU.uVel.value.set(L.wx*L.wind*2.2, -1.5, L.wz*L.wind*2.2); SU.uBright.value = night ? 0.62 : 1;
      }
      // rain on the ground: a hiss that follows the rain (engine.js noiseLoop needs set() every frame)
      if(rainA > 0.05 && !hiss && E.noiseLoop) hiss = E.noiseLoop(2600, 0.35);
      if(hiss){ if(rainA > 0.05) hiss.set(0.04 + rainA*0.11); else { hiss.stop(); hiss = null; } }
      // the cloud deck, drifting with the wind, wrapped around the camera
      var drift = t*(4 + L.wind*14), shade = night ? 0.16 : 1 - L.dim*0.62, cop = show ? L.cloud*(calm ? 0.7 : 0.85) : 0;
      for(var q = 0; q < clouds.length; q++){
        var cl = clouds[q], u = cl.userData, px = u.x + L.wx*drift, pz = u.z + L.wz*drift;
        px = ((px - cx + CBOX/2) % CBOX + CBOX) % CBOX - CBOX/2 + cx;
        pz = ((pz - cz + CBOX/2) % CBOX + CBOX) % CBOX - CBOX/2 + cz;
        cl.position.set(px, u.y, pz);
        cl.material.opacity = cop*(0.55 + 0.45*u.k);
        cl.material.color.setScalar(shade*(0.82 + 0.18*u.k));
        cl.visible = cl.material.opacity > 0.01;
      }
      // lightning: storm only, never in Calm
      flash = Math.max(0, flash - dt*5.5);
      if(boltLeft > 0){ boltLeft -= dt; boltM.opacity = boltLeft > 0 ? Math.min(1, boltLeft*7)*(0.65 + 0.35*Math.sin(boltLeft*90)) : 0; bolt.visible = boltLeft > 0; }
      var sec = nowMs/1000;
      if(show && !calm && L.storm > 0.5){
        strikes(world, sec).concat(strikes(world, sec - STRIKE_WIN)).forEach(function(st){
          if(st.t > lastStrike && st.t <= sec && sec - st.t < 0.5){
            lastStrike = st.t;
            var gy = o.ground ? o.ground(st.x, st.z) : 0, dist = Math.hypot(st.x - cx, st.z - cz);
            makeBolt(st, gy); boltLeft = 0.32; bolt.visible = true;
            flash = Math.max(flash, 1 - Math.min(0.75, dist/2400));
            pending.push({at: sec + dist/343, dist: dist, seed: st.seed});
          }
        });
      } else if(boltLeft <= 0) bolt.visible = false;
      pending = pending.filter(function(p){ if(p.at <= sec){ thunder(p.dist, p.seed); return false; } return true; });
      L.flash = calm ? 0 : flash;
      L.wet = wetness(world, nowMs);
      puddles(cx, cz, L.wet, show, calm, t);
      return L;
    },
    destroy: function(){
      if(hiss){ hiss.stop(); hiss = null; }
      S.remove(g);
      rg.dispose(); rain.material.dispose(); sg.dispose(); snow.material.dispose(); boltG.dispose(); boltM.dispose();
      pudG.dispose(); pudM.dispose(); blobT.dispose();
      clouds.forEach(function(cl){ cl.material.dispose(); }); CT.forEach(function(tx){ tx.dispose(); });
    }
  };
  return inst;
}

HQV.hqWeather = {SLOT: SLOT, EASE: EASE, KINDS: KINDS, WEIGHT: WEIGHT, LOOK: LOOK, NAME: NAME, ICON: ICON, STRIKE_WIN: STRIKE_WIN,
  hash32: hash32, kindAt: kindAt, at: at, look: look, strikes: strikes, forecast: forecast, lerpHex: lerpHex, wetness: wetness,
  puddleSpots: puddleSpots, PUDDLE_NEAR: PUDDLE_NEAR, PUDDLE_MAX: PUDDLE_MAX, create: create};
})();
