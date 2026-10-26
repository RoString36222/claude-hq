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
 *   storm  rain at full and lightning: a forked bolt, the sky lit for a moment, thunder after the light (343 m/s), heard
 *          from where it struck
 * Calm and reduced motion: nothing falls and nothing flashes (a lightning flash is a photosensitivity hazard);
 * the sky, the fog and the cloud deck still change, slowly. The map view (top down) draws no weather.
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : globalThis;
var HQV = root.HQV = root.HQV || {};

var SLOT = 15*60*1000, EASE = 90*1000, STRIKE_WIN = 10;
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
// [3.11.1] thunder is heard only for strikes within THUNDER_M of the camera, fading to nothing at that edge (no floor)
var THUNDER_M = 1000;
function thunderVol(dist){ dist = +dist; return isFinite(dist) && dist >= 0 && dist < THUNDER_M ? 0.85*(1 - dist/THUNDER_M) : 0; }
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
function made(world, ms){
  var A = at(world, ms), p = LOOK[A.prev], q = LOOK[A.kind], k = A.e, o = {kind: A.kind, prev: A.prev, e: k};
  ["dim", "fogNear", "fogFar", "tintK", "rain", "snow", "cloud", "wind", "storm"].forEach(function(f){ o[f] = lerp(p[f], q[f], k); });
  o.tint = lerpHex(p.tint, q.tint, k);
  var w = windDir(world, A.slot); o.wx = w.x; o.wz = w.z;
  return o;
}

/* ---------- [3.23] live weather: the Arena's hourly Weather Union reading (Koramangala, Bengaluru) ---------- */
// The Arena fetches one place's reading at the start of every hour (backend/src/weather.rs) and the page asks for it
// through the local server (/api/arena/weather), so everyone in every city sees the same sky. While a reading is
// fresh (LIVE_STALE) it replaces the made-up forecast; without one (no Arena, no key) the forecast carries on.
// Every number Weather Union gives is used:
//   rain_intensity (mm/h)     how much rain falls: drizzle to a downpour (more streaks, faster, longer, louder),
//                             a thunderstorm in a heavy one (STORM_MM, sooner in a strong wind)
//   rain_accumulation (mm)    how wet the ground is, and stays after the rain stops (puddles, the sheen)
//   humidity (%)              the haze and the clouds; a near-saturated dry hour is a mist
//   wind_speed (m/s), wind_direction (degrees, where it blows from)
//                             how hard and which way the rain slants and the clouds drift
//   temperature (°C)          the light: a warmer sky in the heat, a cooler one when it is cold
//   aqi_pm_2_point_5, aqi_pm_10  smog: a browner, closer haze on a bad-air day
// A new reading eases in over EASE. look() carries the numbers (live: {...}) for the phone and the HUD.
var LIVE = null, LIVE_PREV = null, LIVE_T = 0, LIVE_STALE = 3*3600*1000, WIND_FULL = 12, STORM_MM = 25;
function num(v){ if(v === null || v === undefined || v === "") return null; v = +v; return isFinite(v) ? v : null; }
function fromLive(d, place){
  d = d || {};
  var r = Math.max(0, num(d.rain_intensity) || 0), acc = Math.max(0, num(d.rain_accumulation) || 0), hum = num(d.humidity),
      tc = num(d.temperature), ws = Math.max(0, num(d.wind_speed) || 0), wd = num(d.wind_direction),
      pm25 = num(d.aqi_pm_2_point_5), pm10 = num(d.aqi_pm_10);
  // rain on a log scale: 0.5 mm/h about 0.22, 2.5 about 0.42, 7.5 about 0.6, 20 about 0.84, 40 and more 1
  var rain = r > 0.05 ? clamp(0.12 + 0.88*Math.log(1 + r)/Math.log(41), 0, 1) : 0;
  var wind = clamp(ws/WIND_FULL, 0, 1);
  var storm = r >= STORM_MM ? 1 : r >= 10 ? clamp((r - 10)/(STORM_MM - 10) + wind*0.5, 0, 1) : 0;
  var humid = hum == null ? 0.4 : clamp((hum - 55)/40, 0, 1);
  var smog = clamp(Math.max(pm25 == null ? 0 : (pm25 - 35)/115, pm10 == null ? 0 : (pm10 - 60)/190), 0, 1);
  var mist = rain === 0 && hum != null && hum >= 92 ? clamp((hum - 92)/6, 0, 1) : 0;
  var cloud = Math.max(rain > 0 ? 0.85 + 0.15*rain : 0, 0.2 + 0.65*humid, mist*0.6);
  var kind = storm > 0.5 ? "storm" : rain > 0 ? "rain" : mist > 0.5 ? "fog" : cloud > 0.7 ? "cloudy" : "clear";
  var fogFar = Math.max(140, 1600*(1 - 0.62*rain)*(1 - 0.35*humid*(1 - rain))*(1 - 0.55*smog)*(1 - 0.85*mist)*(1 - 0.3*storm));
  var tint = lerpHex(lerpHex(0x9aa6b2, 0x6f7c88, rain), 0x3a434e, storm);
  if(smog > 0) tint = lerpHex(tint, 0xa89a80, 0.65*smog);
  if(tc != null && tc > 30) tint = lerpHex(tint, 0xe2d4ae, clamp((tc - 30)/10, 0, 1)*0.35);
  else if(tc != null && tc < 18) tint = lerpHex(tint, 0xb6c6dc, clamp((18 - tc)/10, 0, 1)*0.35);
  // where the wind blows to (from wind_direction + 180), +z north, +x east
  var b = ((wd == null ? 225 : wd) + 180)*Math.PI/180;
  return {kind: kind, prev: kind, e: 1, live: {place: place || "", rainMm: r, accMm: acc, humidity: hum, temp: tc, windMs: ws,
          windDeg: wd, pm25: pm25, pm10: pm10, smog: smog, mist: mist},
          dim: clamp(0.08 + 0.12*cloud + 0.5*rain + 0.2*storm + 0.15*smog, 0, 0.88), fogNear: fogFar*0.16, fogFar: fogFar,
          tint: tint, tintK: clamp(0.25*cloud + 0.5*rain + 0.15*storm + 0.5*smog + 0.6*mist, 0, 0.95),
          rain: rain, snow: 0, cloud: clamp(cloud, 0, 1), wind: wind, storm: storm, wx: Math.sin(b), wz: Math.cos(b),
          wet: clamp(Math.max(rain > 0 ? 0.5 + 0.5*rain : 0, acc/12), 0, 1)};
}
// A reading from /api/arena/weather ({ok, place, at (unix s), data}); a new one eases in from what was showing.
function setLive(j, now){
  now = now == null ? Date.now() : +now;
  if(!j || !j.ok || !j.data){ if(LIVE && now - LIVE.t > LIVE_STALE) LIVE = null; return false; }
  var at = (+j.at || 0)*1000;
  if(LIVE && LIVE.at === at) return false;
  LIVE_PREV = LIVE ? look("", now) : null;
  LIVE = {at: at, t: now, L: fromLive(j.data, j.place)};
  LIVE_T = now;
  return true;
}
function liveOn(ms){ return !!(LIVE && (+ms || 0) - LIVE.t < LIVE_STALE && (+ms || 0) - LIVE.at < LIVE_STALE + 3600*1000); }
function look(world, ms){
  if(!liveOn(ms)) return made(world, ms);
  var q = LIVE.L, p = LIVE_PREV || made(world, LIVE_T), k = smooth(((+ms || 0) - LIVE_T)/EASE), o = {kind: q.kind, prev: p.kind, e: k, live: q.live};
  ["dim", "fogNear", "fogFar", "tintK", "rain", "snow", "cloud", "wind", "storm"].forEach(function(f){ o[f] = lerp(p[f], q[f], k); });
  o.tint = lerpHex(p.tint, q.tint, k);
  var ax = lerp(p.wx, q.wx, k), az = lerp(p.wz, q.wz, k), al = Math.hypot(ax, az) || 1; o.wx = ax/al; o.wz = az/al;
  o.wet = q.wet;
  return o;
}
function liveName(L){
  var v = L && L.live; if(!v) return null;
  var bits = [NAME[L.kind] + (L.kind === "rain" ? (v.rainMm < 1 ? " (drizzle)" : v.rainMm >= 7.5 ? " (heavy)" : "") : "")];
  if(v.rainMm > 0) bits.push(v.rainMm.toFixed(1) + " mm/h");
  if(v.temp != null) bits.push(Math.round(v.temp) + "°C");
  if(v.humidity != null) bits.push(Math.round(v.humidity) + "% humidity");
  if(v.windMs) bits.push(Math.round(v.windMs*3.6) + " km/h wind");
  if(v.pm25 != null) bits.push("PM2.5 " + Math.round(v.pm25));
  return bits.join(" · ") + (v.place ? " in " + v.place : "");
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
// What the weather has left on the ground at `ms` (games/worldbuild.js settle): snow cover, building over a dozen
// minutes of snowfall to a light dusting (SNOW_MAX) and melting off after (faster in rain), and how wet it is, on at
// once in rain and drying over minutes. Replays the last SETTLE_MIN minutes of the forecast a minute at a time (and
// eases between minutes), so it is the same for everyone and never jumps.
var SNOW_MAX = 0.45, SETTLE_MIN = 40;
function settledAt(world, m0){
  var snow = 0, wet = 0;
  for(var m = SETTLE_MIN; m >= 0; m--){
    var L = look(world, (m0 - m)*60000);
    snow = L.snow > 0.3 ? Math.min(SNOW_MAX, snow + 0.05*L.snow) : Math.max(0, snow - (L.rain > 0.3 ? 0.06 : 0.025));
    wet = L.rain > 0.2 ? Math.min(1, wet + 0.35*L.rain) : Math.max(0, wet - 0.12);
  }
  return {snow: snow, wet: wet};
}
function settled(world, ms){
  if(liveOn(ms)){ var Lv = look(world, ms); return {snow: 0, wet: Math.max(Lv.wet || 0, Lv.rain)}; }   // [3.23] live: no snow in Bengaluru
  var m0 = Math.floor((+ms || 0)/60000), f = (+ms || 0)/60000 - m0, a = settledAt(world, m0), b = settledAt(world, m0 + 1);
  return {snow: lerp(a.snow, b.snow, f), wet: Math.max(lerp(a.wet, b.wet, f), look(world, ms).rain)};
}
function forecast(world, ms, n){
  if(liveOn(ms)){ var Lf = look(world, ms); return [{kind: Lf.kind, name: liveName(Lf), icon: ICON[Lf.kind], at: +ms || 0, live: true}]; }   // [3.23]
  var A = at(world, ms), out = [];
  for(var i = 0; i <= Math.max(0, n | 0); i++){
    var k = kindAt(world, A.slot + i);
    out.push({kind: k, name: NAME[k], icon: ICON[k], at: (A.slot + i)*SLOT});
  }
  return out;
}

// [3.23] asks the local server for the Arena's reading: now, then every POLL_MS and just after each hour starts (the
// Arena fetches on the hour). One poller for the page; only ever local /api.
var POLL_MS = 10*60*1000, polling = false;
function livePoll(){
  // (a real page only: never under node, where a pending timer would keep the process alive)
  if(polling || typeof fetch !== "function" || typeof setTimeout !== "function" || typeof location === "undefined" || !location.origin) return;
  polling = true;
  function ask(){
    try {
      fetch("/api/arena/weather", {cache: "no-store"}).then(function(r){ return r.ok ? r.json() : null; })
        .then(function(j){ setLive(j); }, function(){});
    } catch(e){}
    var now = Date.now(), toHour = 3600000 - now % 3600000 + 90000;   // a minute and a half past the hour
    setTimeout(ask, Math.min(POLL_MS, toHour));
  }
  ask();
}

/* ---------- drawing ---------- */
function create(c, o){
  o = o || {};
  var THREE = c.THREE, E = c.E, S = o.scene, world = String(o.world || "");
  livePoll();
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
  // [Sound PR B] the rumble comes from the strike (at: {x, y, z}): a spatial voice (games/engine.js spatialOut, the
  // ambient bus) pans it there and keeps the three nearest; thunderVol is still its whole level (curve: false) and the
  // pending queue has already waited the d/343 s it takes to arrive (delay: false). An older engine: centred, as before.
  function thunder(dist, seed, at){
    var vol = thunderVol(dist); if(!(vol > 0)) return;
    var A = E.spatialOut ? E.spatialOut("thunder", at || null, {gain: 1, delay: false, dur: 3.4}) : E.ambientOut ? E.ambientOut() : E.audioOut ? E.audioOut() : null; if(!A) return;
    try {
      var ac = A.ctx, dur = 3.4, n = Math.floor(ac.sampleRate*dur), buf = ac.createBuffer(1, n, ac.sampleRate), d = buf.getChannelData(0);
      var r = c.rng((seed % 100000) + 3), last = 0;
      for(var q = 0; q < n; q++){ last = (last + 0.02*(r()*2 - 1))/1.02; d[q] = last*3.4*(1 + 0.6*Math.sin(q/ac.sampleRate*9)); }   // brown noise, rolling
      var src = ac.createBufferSource(), lp = ac.createBiquadFilter(), gn = ac.createGain(), t0 = ac.currentTime + (A.delay || 0);
      src.buffer = buf; lp.type = "lowpass"; lp.frequency.value = 140 + 520*Math.max(0, 1 - dist/1500);
      gn.gain.setValueAtTime(0.0001, t0); gn.gain.exponentialRampToValueAtTime(vol, t0 + 0.06); gn.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(lp); lp.connect(gn); gn.connect(A.out); src.start(t0); src.stop(t0 + dur);
    } catch(e){}
  }

  var saidMm = null, hiss = null, said = null, lastStrike = -1, pending = [], flash = 0, boltLeft = 0, cur = null, night = false, gnd = null, gndAt = -9;
  function amt(v){ return Math.max(0, Math.min(1, v)); }
  var inst = {
    setNight: function(n){ night = !!n; },
    kind: function(){ return cur ? cur.kind : "clear"; },
    name: function(k){ return (!k && cur && liveName(cur)) || NAME[k || (cur && cur.kind) || "clear"]; },
    live: function(){ return cur && cur.live ? cur.live : null; },
    icon: function(k){ return ICON[k || (cur && cur.kind) || "clear"]; },
    forecast: function(n){ return forecast(world, Date.now(), n); },
    update: function(t, dt, cam){
      var nowMs = Date.now(), L = look(world, nowMs), calm = E.calm(), mode = (cam && cam.mode) || "classic";
      cur = L;
      var cx = cam && cam.x != null ? cam.x : 0, cy = cam && cam.y != null ? cam.y : 0, cz = cam && cam.z != null ? cam.z : 0;
      var show = mode !== "map";
      // say it once it has mostly arrived (not on the first frame: you walked into it, nothing changed)
      if(said == null) said = L.kind;
      else if(L.kind !== said && L.e > 0.5){ said = L.kind; if(o.say) o.say(SAY[L.kind]); }
      // [3.23] a new live reading: say how the rain changed (it eased in over EASE)
      if(L.live && saidMm != null && L.e > 0.5 && Math.abs(L.live.rainMm - saidMm) >= 2 && L.kind === said && o.say)
        o.say(L.live.rainMm > saidMm ? "The rain is getting heavier." : L.live.rainMm > 0 ? "The rain is easing off." : "The rain stops.");
      if(L.live && L.e > 0.5) saidMm = L.live.rainMm;
      // rain and snow: nothing falls in Calm
      var rainA = show && !calm ? amt(L.rain) : 0, snowA = show && !calm ? amt(L.snow) : 0;
      rain.visible = rainA > 0.01; snow.visible = snowA > 0.01;
      if(rain.visible){
        RU.uTime.value = t; RU.uCam.value.set(cx, cy, cz); RU.uAmt.value = rainA;
        // ([3.23] a drizzle drifts down in short streaks, a downpour drives down long and fast)
        RU.uVel.value.set(L.wx*L.wind*7, -(16 + 14*rainA), L.wz*L.wind*7); RU.uLen.value = 0.022 + 0.018*rainA;
        RU.uAlpha.value = night ? 0.3 : 0.42;
      }
      if(snow.visible){
        SU.uTime.value = t; SU.uCam.value.set(cx, cy, cz); SU.uAmt.value = snowA;
        SU.uVel.value.set(L.wx*L.wind*2.2, -1.5, L.wz*L.wind*2.2); SU.uBright.value = night ? 0.62 : 1;
      }
      // rain on the ground: a hiss that follows the rain (engine.js noiseLoop needs set() every frame); [Sound PR B] a bed
      // through the Ambient sounds volume, with no place and no pan (it falls all round you)
      if(rainA > 0.05 && !hiss && E.noiseLoop) hiss = (E.ambientLoop || E.noiseLoop)(2600, 0.35);   // [3.11.1] an ambient sound
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
            if(dist < THUNDER_M) pending.push({at: sec + dist/343, dist: dist, seed: st.seed, pos: {x: st.x, y: gy, z: st.z}});
          }
        });
      } else if(boltLeft <= 0) bolt.visible = false;
      pending = pending.filter(function(p){ if(p.at <= sec){ thunder(p.dist, p.seed, p.pos); return false; } return true; });
      L.flash = calm ? 0 : flash;
      // what lies on the ground: worked out about once a second (it changes over minutes)
      if(!gnd || t - gndAt > 1){ gnd = settled(world, nowMs); gndAt = t; }
      L.ground = gnd;
      return L;
    },
    destroy: function(){
      if(hiss){ hiss.stop(); hiss = null; }
      S.remove(g);
      rg.dispose(); rain.material.dispose(); sg.dispose(); snow.material.dispose(); boltG.dispose(); boltM.dispose();
      clouds.forEach(function(cl){ cl.material.dispose(); }); CT.forEach(function(tx){ tx.dispose(); });
    }
  };
  return inst;
}

HQV.hqWeather = {thunderVol: thunderVol, THUNDER_M: THUNDER_M, SLOT: SLOT, EASE: EASE, KINDS: KINDS, WEIGHT: WEIGHT, LOOK: LOOK, NAME: NAME, ICON: ICON, STRIKE_WIN: STRIKE_WIN,
  hash32: hash32, kindAt: kindAt, at: at, look: look, strikes: strikes, forecast: forecast, lerpHex: lerpHex,
  settled: settled, SNOW_MAX: SNOW_MAX, create: create,
  made: made, fromLive: fromLive, setLive: setLive, liveOn: liveOn, liveName: liveName, clearLive: function(){ LIVE = null; LIVE_PREV = null; }, STORM_MM: STORM_MM};
})();
