/* Claude HQ: the shared 3D game engine (HQ 2.0, Wave 0).
 *
 * Kart Racing, Platformer Rush and Blaster Arena each carried their own copy of
 * these parts; the 3D HQ uses them too. Loaded once, after core.js and before
 * the games (VALLEY_FILES in ui/app/10-views.js), as HQV.engine.
 *
 *   util    now, clamp, hex, angLerp, calm, say, tokens, myClock, fmtTime, dist3
 *   three   lib()           three.js + GLTFLoader + SkeletonUtils, loaded once
 *           loadGlb(lib, kit, name)   a Kenney model from /games/<kit>/, cached
 *           hasWebGL2()
 *   net     senderTime(P, q, t, jitMax)   a remote frame's time on our clock
 *           jitter(P, late)               the running jitter estimate
 *           pushSnap(sn, s, cap)          append to a snapshot buffer, bounded
 *           bracket(sn, rt)               the two snapshots around render time
 *
 * Same house rules as core.js: no build step, nothing leaves the machine.
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};

/* ---------- util ---------- */
function now(){ return performance.now()/1000; }
function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function hex(s, fb){ return typeof s === "string" && /^#[0-9a-f]{6}$/i.test(s) ? parseInt(s.slice(1), 16) : fb; }
function angLerp(a, b, u){ return a + Math.atan2(Math.sin(b - a), Math.cos(b - a))*u; }
function calm(){ return document.documentElement.classList.contains("hq-calm") ||
  (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); }
function say(t){ if(typeof window.announce === "function"){ try { window.announce(t); } catch(e){} } }
// Theme colours for 2D canvases (gauges, minimaps, map views) from the page's tokens.
function tokens(){
  var cs = getComputedStyle(document.documentElement);
  function g(n, fb){ var v = (cs.getPropertyValue(n) || "").trim(); return v || fb; }
  return {ink: g("--ink", "currentColor"), muted: g("--muted", "gray"), line: g("--line", "gray"), panel: g("--panel", "canvas"),
          panel2: g("--panel2", "canvas"), brand: g("--brand", "royalblue"), need: g("--need", "crimson"), good: g("--good", "seagreen"),
          gold: g("--gold", "goldenrod"), bg2: g("--bg2", "canvas"), mono: g("--mono", "monospace")};
}
// My clock for the server, centiseconds (never goes backwards; a reload starts over).
function myClock(){ return Math.floor(performance.now()/10) % 1073741824; }
// m:ss.cc for race and run times.
function fmtTime(ms){
  if(ms == null || !isFinite(ms)) return "–";
  ms = Math.max(0, Math.round(ms)); var m = Math.floor(ms/60000), s = (ms % 60000)/1000;
  return m+":"+(s < 10 ? "0" : "")+s.toFixed(2);
}
function dist3(a, b){ var dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2]; return Math.sqrt(dx*dx + dy*dy + dz*dz); }

/* ---------- three.js and models ---------- */
var KITS = ["golf", "kart", "platformer", "fps", "hq"];
var LIB = null, GLB = {};
// three.js, its GLTF loader and SkeletonUtils, imported once for every game.
// Each Kenney kit's GLBs point at their own "Textures/colormap.png"; one copy sits
// next to them in /games/<kit>/.
function lib(){
  return LIB || (LIB = Promise.all([import("/games/vendor/three-module.js"), import("/games/vendor/three-gltf-loader.js"),
                                    import("/games/vendor/three-skeleton-utils.js")])
    .then(function(m){
      var THREE = m[0], manager = new THREE.LoadingManager();
      manager.setURLModifier(function(u){
        var k = /\/games\/([a-z]+)\/Textures\/colormap\.png$/.exec(u);
        return k && KITS.indexOf(k[1]) >= 0 ? "/games/"+k[1]+"/colormap.png" : u;
      });
      return {THREE: THREE, loader: new m[1].GLTFLoader(manager), clone: m[2].clone, tex: new THREE.TextureLoader()};
    }, function(e){ LIB = null; throw e; }));
}
// A model from /games/<kit>/<name>.glb, loaded once and shared (clone it with lib.clone).
function loadGlb(L, kit, name){
  if(!/^[a-z][a-z0-9-]{0,40}$/.test(name) || KITS.indexOf(kit) < 0) return Promise.reject(new Error("bad model name"));
  var key = kit+"/"+name;
  return GLB[key] || (GLB[key] = new Promise(function(res, rej){
    L.loader.load("/games/"+key+".glb", res, null, function(e){ delete GLB[key]; rej(e); });
  }));
}
function hasWebGL2(){ try { return !!document.createElement("canvas").getContext("webgl2"); } catch(e){ return false; } }

/* ---------- snapshot interpolation ---------- */
// A remote player's frame carries its sender's clock q (centiseconds). Map it onto
// our clock: keep the smallest offset seen (the least-delayed frame), drift slowly
// toward newer ones, and track how late frames run (jitter) so the render delay can
// cover it. Returns the frame's time on our clock, or null for a stale frame.
// P holds lastQ (-1 at first), off (null at first) and jit (0 at first).
function senderTime(P, q, t, jitMax){
  q = q|0;
  if(P.lastQ >= 0 && q <= P.lastQ && P.lastQ - q < 6000) return null;   // older than what we have
  if(P.lastQ >= 0 && q <= P.lastQ) P.off = null;                          // the sender reloaded: start over
  P.lastQ = q;
  var off = t - q/100;
  if(P.off === null || off < P.off) P.off = off; else P.off += (off - P.off)*0.01;
  var st = q/100 + P.off;
  jitter(P, clamp(t - st, 0, jitMax));
  return st;
}
// Rise fast, fall slowly: one late frame widens the buffer, a calm spell narrows it.
function jitter(P, late){ P.jit += (late - P.jit)*(late > P.jit ? 0.3 : 0.02); }
// Append s (with s.t) keeping times strictly increasing and at most cap entries.
function pushSnap(sn, s, cap){
  var last = sn[sn.length - 1];
  if(last && s.t <= last.t) s.t = last.t + 0.001;
  sn.push(s);
  if(sn.length > cap) sn.shift();
  return s;
}
// The snapshots around render time rt: {A, B, u} between two, {A: first} before
// the buffer, {A: last, after: rt - last.t} past it, or null when it is empty.
function bracket(sn, rt){
  var n = sn.length; if(!n) return null;
  if(rt <= sn[0].t) return {A: sn[0], B: null, u: 0};
  if(rt >= sn[n-1].t) return {A: sn[n-1], B: null, u: 0, after: rt - sn[n-1].t};
  for(var i = n - 1; i > 0 && sn[i-1].t > rt; i--){}
  var A = sn[i-1], B = sn[i];
  return {A: A, B: B, u: (rt - A.t)/((B.t - A.t) || 1)};
}

/* ---------- sound (HQ 2.1 sound pack): every sound is synthesised, no files ---------- */
// One volume for every game and the HQ: localStorage hq_sfx (0..1). Off by default under Calm
// mode or reduced motion (until you set a volume yourself). Audio starts after your first click.
var SND = {ctx: null, master: null};
function sfxVolume(){
  var v = null; try { v = localStorage.getItem("hq_sfx"); } catch(e){}
  if(v === null || v === "") return calm() ? 0 : 0.5;
  v = parseFloat(v); return isFinite(v) ? clamp(v, 0, 1) : 0.5;
}
function sfxSetVolume(v){ try { localStorage.setItem("hq_sfx", String(clamp(+v || 0, 0, 1))); } catch(e){} if(SND.master) SND.master.gain.value = sfxVolume(); }
function audio(){
  if(SND.ctx) { if(SND.ctx.state === "suspended") SND.ctx.resume().catch(function(){}); return SND.ctx; }
  var C = window.AudioContext || window.webkitAudioContext; if(!C) return null;
  try { SND.ctx = new C(); SND.master = SND.ctx.createGain(); SND.master.gain.value = sfxVolume(); SND.master.connect(SND.ctx.destination); } catch(e){ return null; }
  return SND.ctx;
}
function tone(ac, type, f0, f1, dur, vol, at){
  var t = ac.currentTime + (at || 0), o = ac.createOscillator(), g = ac.createGain();
  o.type = type; o.frequency.setValueAtTime(f0, t); if(f1) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(SND.master); o.start(t); o.stop(t + dur + 0.02);
}
function noise(ac, dur, vol, freq, at){
  var t = ac.currentTime + (at || 0), n = Math.floor(ac.sampleRate*dur), b = ac.createBuffer(1, n, ac.sampleRate), d = b.getChannelData(0);
  for(var i = 0; i < n; i++) d[i] = (Math.random()*2 - 1)*(1 - i/n);
  var src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
  src.buffer = b; f.type = "bandpass"; f.frequency.value = freq || 1200; g.gain.value = vol;
  src.connect(f); f.connect(g); g.connect(SND.master); src.start(t);
}
var SFX = {
  ui: function(a){ tone(a, "sine", 660, 0, 0.06, 0.08); },
  count: function(a){ tone(a, "square", 440, 0, 0.16, 0.12); },
  go: function(a){ tone(a, "square", 880, 0, 0.35, 0.14); },
  jump: function(a){ tone(a, "sine", 320, 760, 0.14, 0.16); },
  djump: function(a){ tone(a, "sine", 520, 1100, 0.14, 0.14); },
  coin: function(a){ tone(a, "square", 988, 0, 0.07, 0.08); tone(a, "square", 1319, 0, 0.12, 0.08, 0.07); },
  shot: function(a, o){ noise(a, 0.09, 0.35, (o && o.w) ? 1800 : 900); tone(a, "sawtooth", (o && o.w) ? 240 : 170, 60, 0.1, 0.1); },
  hit: function(a){ tone(a, "triangle", 1400, 900, 0.06, 0.1); },
  putt: function(a, o){ var p = clamp((o && o.power) || 40, 5, 100)/100; noise(a, 0.05, 0.25 + p*0.3, 2400); tone(a, "triangle", 900, 300, 0.06, 0.1); },
  sink: function(a){ tone(a, "sine", 784, 0, 0.18, 0.12); tone(a, "sine", 1175, 0, 0.3, 0.12, 0.12); },
  finish: function(a){ [523, 659, 784, 1047].forEach(function(f, i){ tone(a, "square", f, 0, 0.16, 0.1, i*0.1); }); },
  levelup: function(a){ [392, 523, 659, 784, 1047].forEach(function(f, i){ tone(a, "triangle", f, 0, 0.22, 0.12, i*0.08); }); },
  door: function(a){ noise(a, 0.35, 0.18, 600); },
  bell: function(a){ tone(a, "sine", 2093, 2050, 0.35, 0.1); tone(a, "sine", 2637, 2600, 0.3, 0.06); tone(a, "sine", 2093, 2050, 0.35, 0.1, 0.14); }   // a bike bell
};
function sfx(name, opt){
  if(sfxVolume() <= 0 || !SFX[name]) return;
  var a = audio(); if(!a || a.state !== "running") return;
  try { SFX[name](a, opt); } catch(e){}
}
// A continuous engine note (HQ 3.5.7: modelled on a real engine): engineSound(kind) ->
// {set(rpm 900..7600, opt), stop()}. The game's rpm (900 idle .. 7600 limiter) maps onto the
// profile's own idle..redline, and the note's fundamental is the firing frequency of a four-stroke,
// rpm/60 * cylinders/2: a 390 single thumps at 12-90 Hz, a superbike four screams up to ~480 Hz.
// Its timbre is a harmonic recipe (a PeriodicWave), a detuned twin for body, a half-order sub for
// the lumpy ones (V-twin, boxer, cross-plane V8), a waveshaper for grit and a low-pass that opens
// with the revs and the load. opt (all optional): thr (0..1 throttle; without it the load is read
// from the revs' climb), gear (an upshift cuts, a downshift blips), speed (m/s: road rumble),
// slip (0..1: tyre squeal), dist (m: a farther engine is quieter and duller).
// Layers on the same output: intake / exhaust roar (filtered noise), a turbo's whistle and its
// blow-off on a lift, crackle on the overrun for the sporty ones (deterministic, not under Calm),
// a diesel's clatter, a prop's blade-pass buzz, a rotor's slap. Every node is made once per engine;
// set() only moves AudioParams. All engines share one compressor so a stack of layers never clips.
//   cyl, idle, red: real engine (firing = rpm/60*cyl/2); lo, hi: Hz instead (a motor, a rotor)
//   h: harmonic amplitudes (1st = firing frequency); sub: half-order level; det: cents between the
//   two main oscillators; grit: waveshaper drive; cut: [lo, hi] Hz low-pass at idle / redline; q;
//   gain: output level (as before); lope: [Hz, depth] idle wobble; rough: idle irregularity 0..1;
//   pops: overrun crackle 0..1; turbo: whistle Hz (and a blow-off); air: intake / exhaust noise;
//   rattle: diesel clatter; blades: prop blades (buzz at blade-pass); rotor: blade slap at 9-18 Hz
//   fan: [idle, full] Hz of a turbofan's whine on N1, whine its level; roar: broadband jet roar with the thrust
var ENGINES = {
  v8:     {cyl: 8, idle: 700, red: 6200,  h: [1, .8, .55, .5, .3, .25, .15, .12, .08], sub: .6, det: 7, grit: 2.2, cut: [380, 2400], q: 1.5, gain: 0.06,  lope: [5, 0.3], rough: .5, pops: .5, air: .5},
  diesel: {cyl: 6, idle: 650, red: 3400,  h: [1, .3, .7, .2, .5, .15, .35, .1, .2, .08], sub: .2, det: 4, grit: 3.2, cut: [320, 1500], q: 1, gain: 0.055, lope: [6, 0.2], rough: .4, air: .35, rattle: 0.035},
  turbo:  {cyl: 4, idle: 850, red: 6800,  h: [1, .4, .5, .22, .3, .12, .16, .08], sub: .1, det: 9, grit: 1.8, cut: [520, 3400], q: 1.2, gain: 0.05,  lope: [9, 0.12], rough: .25, pops: .35, turbo: 1800, air: .55},
  hotrod: {cyl: 8, idle: 780, red: 6600,  h: [1, .85, .6, .55, .35, .3, .2, .14, .1], sub: .9, det: 11, grit: 2.8, cut: [420, 2800], q: 2, gain: 0.06,  lope: [3.5, 0.5], rough: .9, pops: .8, air: .6},
  bike:   {cyl: 2, idle: 1400, red: 11500, h: [1, .55, .45, .3, .22, .15, .1, .08], sub: .35, det: 8, grit: 2, cut: [700, 4200], q: 1.2, gain: 0.04,  lope: [16, 0.15], rough: .4, pops: .6, air: .6},
  // Valley Rally: a turbo four with its whistle, a straight six, a high-revving four (also the superbikes' inline-4)
  turbo4: {cyl: 4, idle: 900, red: 7200,  h: [1, .38, .5, .2, .32, .12, .18, .08], sub: .12, det: 8, grit: 1.9, cut: [560, 3800], q: 1.3, gain: 0.05,  lope: [11, 0.08], rough: .2, pops: .7, turbo: 2300, air: .6},
  six:    {cyl: 6, idle: 750, red: 7400,  h: [1, .45, .3, .38, .15, .22, .1, .12, .06], sub: 0, det: 6, grit: 1.6, cut: [500, 3600], q: 1.2, gain: 0.055, lope: [8, 0.06], rough: .15, pops: .45, air: .5},
  four:   {cyl: 4, idle: 1200, red: 14000, h: [1, .3, .55, .18, .32, .1, .2, .07, .12, .05], sub: 0, det: 10, grit: 1.7, cut: [800, 5600], q: 1.4, gain: 0.045, lope: [16, 0.1], rough: .2, pops: .8, air: .7},
  // the real vehicles (games/hqvehiclephys.js voiceFor): a thumping single, a 270-degree parallel twin, a loping V-twin,
  // a flat boxer, turbo sixes and V8s with their whistle, a W16's deep smooth roar, a V16's higher shriek, and an
  // electric motor's whine (no firing, no lope, no gears: it climbs with the speed)
  single:   {cyl: 1, idle: 1500, red: 10500, h: [1, .9, .75, .55, .45, .35, .28, .22, .17, .13, .1, .08], sub: 0, det: 5, grit: 2.6, cut: [420, 2600], q: 1.6, gain: 0.05, lope: [3, 0.25], rough: .7, pops: .7, air: .55},
  twin:     {cyl: 2, idle: 1300, red: 10200, h: [1, .6, .45, .3, .2, .15, .1, .08], sub: .5, det: 7, grit: 2.2, cut: [600, 3800], q: 1.3, gain: 0.045, lope: [5, 0.3], rough: .55, pops: .7, air: .6},
  vtwin:    {cyl: 2, idle: 1250, red: 10000, h: [1, .7, .5, .35, .25, .18, .12, .08], sub: .8, det: 6, grit: 2.4, cut: [520, 3200], q: 1.5, gain: 0.055, lope: [4, 0.45], rough: .8, pops: .8, air: .6},
  boxer:    {cyl: 2, idle: 1050, red: 9000,  h: [1, .5, .6, .25, .3, .12, .15, .06], sub: .45, det: 5, grit: 2, cut: [500, 3000], q: 1.2, gain: 0.05, lope: [4.5, 0.3], rough: .5, pops: .3, air: .5},
  turbo6:   {cyl: 6, idle: 720, red: 7200,  h: [1, .42, .3, .36, .15, .2, .1, .1, .06], sub: 0, det: 6, grit: 1.7, cut: [460, 3200], q: 1.2, gain: 0.055, lope: [8, 0.05], rough: .12, pops: .6, turbo: 2000, air: .5},
  v8tt:     {cyl: 8, idle: 650, red: 7000,  h: [1, .7, .5, .45, .28, .22, .14, .1, .07], sub: .35, det: 6, grit: 2, cut: [420, 3000], q: 1.4, gain: 0.06, lope: [5.5, 0.15], rough: .3, pops: .55, turbo: 1600, air: .5},
  // [3.9] the naturally aspirated Italians: a V10's hard-edged wail (the Huracán's 8,500 rpm, its odd orders rasping) and
  // a V12's smooth shriek to 9,500 (the Revuelto); both open the low-pass far up and crackle on the overrun
  v10:      {cyl: 10, idle: 1000, red: 8700, h: [1, .45, .6, .3, .38, .18, .24, .12, .1, .06], sub: .12, det: 8, grit: 2.2, cut: [700, 6600], q: 1.8, gain: 0.055, lope: [10, 0.06], rough: .15, pops: .8, air: .7},
  v12:      {cyl: 12, idle: 950, red: 9500, h: [1, .3, .42, .18, .28, .1, .16, .06, .08], sub: 0, det: 10, grit: 1.8, cut: [900, 7400], q: 1.9, gain: 0.05, lope: [12, 0.04], rough: .08, pops: .6, air: .7},
  w16:      {cyl: 16, idle: 900, red: 6700, h: [1, .5, .3, .25, .15, .1, .06], sub: .15, det: 5, grit: 1.5, cut: [600, 3600], q: 1, gain: 0.065, lope: [7, 0.06], rough: .1, pops: .3, turbo: 1500, air: .6},
  v16:      {cyl: 16, idle: 1000, red: 9000, h: [1, .35, .45, .2, .28, .12, .16, .08], sub: 0, det: 9, grit: 1.9, cut: [800, 6000], q: 1.6, gain: 0.055, lope: [9, 0.05], rough: .1, pops: .6, air: .65},
  electric: {lo: 600, hi: 3600, h: null, r2: 2.5, sub: 0, det: 0, grit: 1, cut: [2400, 7000], q: 2, gain: 0.03, air: .15},
  // a helicopter (games/hqheli.js): a low turbine note under the blades' slap
  rotor:  {lo: 22, hi: 44, h: [1, .6, .45, .3, .2, .15], r2: 3, sub: 0, det: 0, grit: 1.4, cut: [300, 520], q: 1, gain: 0.08, rotor: true, turbo: 3200, air: .35},
  // a light aircraft's flat-six (games/hqplane.js seaplane / prop) and its two-blade propeller's buzz
  prop:   {cyl: 6, idle: 700, red: 2700,  h: [1, .55, .5, .3, .28, .15, .12, .08], sub: .3, det: 6, grit: 2, cut: [380, 1900], q: 1, gain: 0.06, blades: 2, rough: .3, air: .45},
  // an airliner's turbofans (games/hqplane.js airliner / regional, HQ 3.6): a low core rumble (Hz, not firing), the fan's
  // spool whine riding on N1 (the game's rpm: it lags the thrust levers as the jets spool) and the exhaust's broadband
  // roar growing with the thrust (opt.thr)
  jet:    {lo: 34, hi: 96, h: [1, .5, .3, .2, .12, .08], r2: 2, sub: .2, det: 14, grit: 1.2, cut: [200, 800], q: .8, gain: 0.06, fan: [900, 3300], whine: .45, roar: 1.1, air: .2}
};
// The profile's real revs and fundamental (Hz) for a game rpm (900..7600); firing = rpm/60*cyl/2.
function engineHz(kind, rpm){
  var P = ENGINES[kind] || ENGINES.v8, u = clamp((rpm - 900)/6700, 0, 1);
  if(!P.cyl) return {u: u, rpm: null, hz: P.lo + (P.hi - P.lo)*u};
  var r = P.idle + (P.red - P.idle)*u;
  return {u: u, rpm: r, hz: r/60*P.cyl/2};
}
// once per AudioContext: a looped noise buffer (a fixed seed: the same hiss every time), each voice's
// PeriodicWave and grit curve, and the compressor every engine shares on its way to the master
function engineBus(a){
  if(SND.bus) return SND.bus;
  var B = {waves: {}, curves: {}, out: SND.master}, n = Math.floor(a.sampleRate), s = 12345;
  B.noise = a.createBuffer(1, n, a.sampleRate);
  var d = B.noise.getChannelData(0);
  for(var i = 0; i < n; i++){ s = (s*1103515245 + 12345) & 0x7fffffff; d[i] = s/0x3fffffff - 1; }
  if(a.createDynamicsCompressor){
    var c = a.createDynamicsCompressor();
    c.threshold.value = -14; c.knee.value = 8; c.ratio.value = 6; c.attack.value = 0.003; c.release.value = 0.2;
    c.connect(SND.master); B.out = c;
  }
  return (SND.bus = B);
}
function engineWave(a, B, kind, P){
  if(!P.h || !a.createPeriodicWave) return null;
  if(B.waves[kind]) return B.waves[kind];
  var re = new Float32Array(P.h.length + 1), im = new Float32Array(P.h.length + 1);
  for(var i = 0; i < P.h.length; i++) im[i + 1] = P.h[i]*(i % 2 ? 0.9 : 1);    // sine terms: a buzzy, pulse-ish wave
  return (B.waves[kind] = a.createPeriodicWave(re, im));
}
function engineCurve(B, k){
  var key = Math.round(k*10); if(B.curves[key]) return B.curves[key];
  var c = new Float32Array(1024), th = Math.tanh(k);
  for(var i = 0; i < 1024; i++){ var x = i/511.5 - 1; c[i] = Math.tanh(k*x)/th; }
  return (B.curves[key] = c);
}
function engineSound(kind){
  var P = ENGINES[kind] || ENGINES.v8;
  var a = sfxVolume() > 0 ? audio() : null; if(!a) return {set: function(){}, stop: function(){}};
  var B = engineBus(a), t0 = a.currentTime, nodes = [];
  // the output first (the dead man's switch lives here), then the chain into it:
  // [main + twin + sub] -> drive -> grit -> low-pass -> amp (lope, shift cut) -> out -> bus
  var g = a.createGain(), amp = a.createGain(), cut = a.createGain(), drv = a.createGain(), f = a.createBiquadFilter();
  g.gain.value = 0; amp.gain.value = 1; cut.gain.value = 1; drv.gain.value = P.grit || 1;
  f.type = "lowpass"; f.frequency.value = P.cut[0]; f.Q.value = P.q;
  var o = a.createOscillator(), o2 = a.createOscillator(), os = a.createOscillator(), sg = a.createGain();
  var wave = engineWave(a, B, kind, P);
  if(wave){ o.setPeriodicWave(wave); o2.setPeriodicWave(wave); } else { o.type = P.h ? "sawtooth" : "sine"; o2.type = P.h ? "sawtooth" : "triangle"; }
  os.type = "triangle"; sg.gain.value = P.sub || 0;
  if(o2.detune) o2.detune.value = P.det || 0;
  var o2g = a.createGain(); o2g.gain.value = P.r2 ? 0.25 : 0.7;
  o.connect(drv); o2.connect(o2g); o2g.connect(drv); os.connect(sg); sg.connect(drv);
  var sh = a.createWaveShaper ? a.createWaveShaper() : null;
  if(sh){ sh.curve = engineCurve(B, P.grit || 1); drv.connect(sh); sh.connect(f); } else drv.connect(f);
  f.connect(amp); amp.connect(cut); cut.connect(g); g.connect(B.out);
  o.start(); o2.start(); os.start(); nodes.push(o, o2, os);
  // lope: the gain wobbles (a cam's lope, a bike's idle), or a prop's blade-pass buzz, or a rotor's slap
  var l = null, ld = null;
  if(P.lope || P.blades || P.rotor){
    l = a.createOscillator(); ld = a.createGain();
    l.frequency.value = P.lope ? P.lope[0] : 10; ld.gain.value = P.lope ? P.lope[1] : P.rotor ? 0.75 : 0.4;
    l.connect(ld); ld.connect(amp.gain); l.start(); nodes.push(l);
  }
  // one noise source fans out to every noisy layer
  var src = a.createBufferSource(); src.buffer = B.noise; src.loop = true; src.start(); nodes.push(src);
  function band(type, fq, q){
    var bf = a.createBiquadFilter(), bg = a.createGain(); bf.type = type; bf.frequency.value = fq; bf.Q.value = q; bg.gain.value = 0;
    src.connect(bf); bf.connect(bg); bg.connect(g); return {f: bf, g: bg};
  }
  var air = band("bandpass", 600, 0.9), rum = band("lowpass", 110, 0.7), sq = band("bandpass", 1400, 6), pop = band("bandpass", 900, 1.5);
  var bov = P.turbo ? band("bandpass", 2600, 1.2) : null, rat = P.rattle ? band("bandpass", 900, 1) : null;
  // a turbofan: the fan's blade-pass whine and the core's tone above it (one gain), the exhaust roar and its hiss
  var fan = null, fan2 = null, fg = null, roar = null, hiss = null;
  if(P.fan){
    fan = a.createOscillator(); fan2 = a.createOscillator(); fg = a.createGain(); var f2g = a.createGain();
    fan.type = "sine"; fan2.type = "triangle"; fg.gain.value = 0; f2g.gain.value = 0.35;
    fan.frequency.value = P.fan[0]; fan2.frequency.value = P.fan[0]*1.62;
    fan.connect(fg); fan2.connect(f2g); f2g.connect(fg); fg.connect(g); fan.start(); fan2.start(); nodes.push(fan, fan2);
    roar = band("lowpass", 400, 0.6); hiss = band("bandpass", 2400, 0.8);
  }
  var wh = null, whg = null;
  if(P.turbo){                      // a turbo spooling up with the boost (a rotor's turbine with the revs)
    wh = a.createOscillator(); whg = a.createGain(); wh.type = "sine"; whg.gain.value = 0; wh.frequency.value = P.turbo*0.4;
    wh.connect(whg); whg.connect(g); wh.start(); nodes.push(wh);
  }
  // state: deterministic randomness (a seed from the kind), the load, the boost, the overrun and the gear
  var seed = 7; for(var i = 0; i < kind.length; i++) seed = (seed*31 + kind.charCodeAt(i)) & 0x7fffffff;
  function rnd(){ seed = (seed*1103515245 + 12345) & 0x7fffffff; return seed/0x7fffffff; }
  var S = {t: t0, rpm: null, load: 0.3, boost: 0, lift: 9, pop: 0, wob: 0, gear: null, blip: 0, thr: 0};
  function tgt(p, v, tc){ p.setTargetAtTime(v, a.currentTime, tc); }
  return {
    set: function(rpm, opt){
      opt = opt || {};
      var t = a.currentTime, on = sfxVolume() > 0, dt = clamp(t - S.t, 0, 0.1), F = engineHz(kind, rpm), u = F.u, hz = F.hz;
      S.t = t;
      // the load: the throttle if the game gives it, else how hard the revs are climbing
      var rise = S.rpm != null && dt > 0 ? (rpm - S.rpm)/dt : 0; S.rpm = rpm;
      var thr = opt.thr != null ? clamp(+opt.thr || 0, 0, 1) : clamp(0.3 + 0.5*u + rise/3000, 0, 1);
      // gears: an upshift cuts the ignition for a moment, a downshift blips the throttle (and pops)
      if(opt.gear != null && S.gear != null && opt.gear > 0 && S.gear > 0 && opt.gear !== S.gear){
        if(opt.gear > S.gear){
          cut.gain.setTargetAtTime(0.3, t, 0.012); cut.gain.setTargetAtTime(1, t + 0.09, 0.04);
          if(bov && S.boost > 0.3) blowOff(t);
        } else { S.blip = 0.16; if(P.pops && on) crackle(t + 0.12); }
      }
      if(opt.gear != null) S.gear = opt.gear;
      if(S.blip > 0){ S.blip -= dt; thr = 1; }
      var k = dt > 0 ? 1 - Math.exp(-dt*10) : 1;
      S.load += (thr - S.load)*k;
      // a lift: the turbo blows off, and a sporty engine crackles on the overrun for a second or so
      if(S.thr > 0.5 && thr < 0.15){ S.lift = 0; if(bov && S.boost > 0.35) blowOff(t); }
      S.thr = thr; S.lift += dt;
      // the notes: firing frequency, its detuned twin, the half-order sub; a lumpy, irregular idle
      tgt(o.frequency, hz, 0.03); tgt(o2.frequency, hz*(P.r2 || 1), 0.03); tgt(os.frequency, hz*0.5, 0.03);
      if(P.rough && t >= S.wob){
        S.wob = t + 0.06 + rnd()*0.09;
        var idle = (1 - u)*(1 - u);
        if(o.detune) tgt(o.detune, (rnd() - 0.5)*2*P.rough*45*idle, 0.03);
        tgt(sg.gain, (P.sub || 0)*(0.7 + 0.6*rnd()*idle), 0.04);
      }
      if(l){
        if(P.blades) tgt(l.frequency, (F.rpm/60)*P.blades, 0.05);           // the prop's blade-pass buzz
        else if(P.rotor) tgt(l.frequency, 9 + 9*u, 0.1);                     // rotor slap with the revs
        else tgt(ld.gain, P.lope[1]*(1 - 0.85*u), 0.1);                      // the lope smooths out with revs
      }
      var L = S.load, dist = opt.dist != null ? clamp(+opt.dist || 0, 0, 1e4) : 0, far = 1/(1 + dist/12);
      tgt(drv.gain, (P.grit || 1)*(0.45 + 0.9*L), 0.05);
      var fc = (P.cut[0] + (P.cut[1] - P.cut[0])*u)*(0.45 + 0.75*L)*(0.4 + 0.6*far);
      tgt(f.frequency, clamp(Math.max(fc, hz*2.5), 60, 16000), 0.06);
      // intake / exhaust roar, road rumble, a squeal in a slide
      tgt(air.f.frequency, clamp(hz*6, 250, 6000), 0.06); tgt(air.g.gain, (P.air || 0)*0.035*(0.15 + 0.85*L)*(0.25 + 0.75*u), 0.06);
      var spd = Math.abs(+opt.speed || 0), slip = clamp(+opt.slip || 0, 0, 1);
      tgt(rum.f.frequency, 70 + Math.min(spd, 60)*3, 0.1); tgt(rum.g.gain, Math.min(0.05, spd/30*0.05), 0.08);
      tgt(sq.f.frequency, 1150 + 400*slip + 120*rnd(), 0.05); tgt(sq.g.gain, 0.06*slip, 0.05);
      // the turbo: boost builds on throttle with the revs, falls fast off it; its whistle rides on the boost
      if(wh){
        var want = P.rotor ? u : L > 0.5 ? u : 0;
        S.boost += (want - S.boost)*(dt > 0 ? 1 - Math.exp(-dt*(want > S.boost ? 2.2 : 7)) : 1);
        tgt(wh.frequency, P.turbo*(0.4 + 0.8*S.boost), 0.08); tgt(whg.gain, 0.014*S.boost*S.boost, 0.08);
      }
      if(rat) tgt(rat.g.gain, P.rattle*(1 - u*0.5), 0.1);
      // the turbofan: the whine follows N1 (u), the roar the thrust (the load)
      if(fan){
        var fq = P.fan[0] + (P.fan[1] - P.fan[0])*u, th = Math.pow(L, 1.5);
        tgt(fan.frequency, fq, 0.08); tgt(fan2.frequency, fq*1.62, 0.08); tgt(fg.gain, P.whine*(0.3 + 0.7*u), 0.08);
        tgt(roar.f.frequency, 250 + 1800*L, 0.1); tgt(roar.g.gain, P.roar*(0.05 + 0.95*th), 0.1);
        tgt(hiss.f.frequency, 1800 + 2600*u, 0.1); tgt(hiss.g.gain, P.roar*0.25*th, 0.1);
      }
      // the overrun crackle: off the throttle at speed, a burst every 40-260 ms for the first ~1.2 s
      if(P.pops && on && !calm() && L < 0.2 && u > 0.3 && S.lift < 1.2 && t >= S.pop){
        S.pop = t + 0.04 + rnd()*0.22/P.pops;
        if(rnd() < P.pops) crackle(t);
      }
      // a dead man's switch: each set() fades the note out 0.25 s from now and the next frame's
      // set() cancels that, so the engine falls silent whenever the game stops calling (a hidden
      // tab, another view, a stalled loop) instead of droning on at its last revs
      var lvl = on ? P.gain*(0.6 + 0.45*u)*(0.55 + 0.45*L)*far : 0;
      g.gain.cancelScheduledValues(t); g.gain.setTargetAtTime(lvl, t, 0.1); g.gain.setTargetAtTime(0, t + 0.25, 0.05);
    },
    stop: function(){
      try { g.gain.cancelScheduledValues(a.currentTime); g.gain.setTargetAtTime(0, a.currentTime, 0.05);
            nodes.forEach(function(nd){ nd.stop(a.currentTime + 0.3); }); } catch(e){}
    }
  };
  function crackle(t){        // one exhaust pop: a short, band-limited noise burst at a random pitch
    var at = t + 0.005;
    pop.f.frequency.setValueAtTime(380 + rnd()*1100, at);
    pop.g.gain.setValueAtTime(0.05 + 0.07*rnd(), at); pop.g.gain.setTargetAtTime(0, at + 0.004, 0.016);
  }
  function blowOff(t){        // the blow-off valve: a falling "pssh"
    bov.f.frequency.setValueAtTime(3400, t); bov.f.frequency.setTargetAtTime(1500, t, 0.18);
    bov.g.gain.setValueAtTime(0, t); bov.g.gain.setTargetAtTime(0.05, t, 0.012); bov.g.gain.setTargetAtTime(0, t + 0.07, 0.11);
  }
}
// A looping band of noise (tyre scrub, gravel under the car): noiseLoop(freq, q) ->
// {set(gain, freq), stop()}. Silent until set() is called with a gain.
function noiseLoop(freq, q){
  var a = sfxVolume() > 0 ? audio() : null; if(!a) return {set: function(){}, stop: function(){}};
  var n = Math.floor(a.sampleRate*0.6), b = a.createBuffer(1, n, a.sampleRate), d = b.getChannelData(0);
  for(var i = 0; i < n; i++) d[i] = Math.random()*2 - 1;
  var src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
  src.buffer = b; src.loop = true; f.type = "bandpass"; f.frequency.value = freq || 1000; f.Q.value = q || 1; g.gain.value = 0;
  src.connect(f); f.connect(g); g.connect(SND.master); src.start();
  return {
    set: function(gain, fq){
      var t = a.currentTime, on = sfxVolume() > 0;
      g.gain.cancelScheduledValues(t); g.gain.setTargetAtTime(on ? clamp(+gain || 0, 0, 0.3) : 0, t, 0.06);
      g.gain.setTargetAtTime(0, t + 0.25, 0.05);                       // silent when set() stops coming (engineSound)
      if(fq) f.frequency.setTargetAtTime(clamp(fq, 60, 8000), t, 0.1);
    },
    stop: function(){ try { g.gain.cancelScheduledValues(a.currentTime); g.gain.setTargetAtTime(0, a.currentTime, 0.05); src.stop(a.currentTime + 0.3); } catch(e){} }
  };
}
// Browsers allow audio only after a user gesture: wake it on the first one.
if(typeof window.addEventListener === "function"){
  window.addEventListener("pointerdown", function(){ if(sfxVolume() > 0) audio(); }, {once: true, capture: true});
  window.addEventListener("keydown", function(){ if(sfxVolume() > 0) audio(); }, {once: true, capture: true});
}

/* ---------- spectating (HQ 2.1): "Watching X  ◀ ▶" with [ and ] ---------- */
// watchBar(stage, opts) -> {update(), destroy()}; opts.list() -> [{id, name}], opts.get() -> id,
// opts.set(id), opts.stop() (optional: a "Stop watching" button). Shows only while opts.get() is set.
function watchBar(stage, opts){
  var bar = document.createElement("div"); bar.className = "vg-watch"; bar.setAttribute("role", "group"); bar.setAttribute("aria-label", "Spectating");
  var prev = document.createElement("button"), label = document.createElement("span"), next = document.createElement("button");
  prev.type = next.type = "button"; prev.className = next.className = "hbtn ghost"; prev.textContent = "◀"; next.textContent = "▶";
  prev.setAttribute("aria-label", "Watch the previous player"); next.setAttribute("aria-label", "Watch the next player");
  label.setAttribute("aria-live", "polite");
  bar.appendChild(prev); bar.appendChild(label); bar.appendChild(next);
  var stop = null;
  if(opts.stop){ stop = document.createElement("button"); stop.type = "button"; stop.className = "hbtn ghost"; stop.textContent = "Stop watching"; stop.addEventListener("click", opts.stop); bar.appendChild(stop); }
  stage.appendChild(bar);
  function step(d){ var L = opts.list(); if(!L.length) return; var i = 0; L.forEach(function(p, k){ if(p.id === opts.get()) i = k; });
    var n = L[(i + d + L.length) % L.length]; opts.set(n.id); upd(); say("Watching " + n.name); }
  prev.addEventListener("click", function(){ step(-1); }); next.addEventListener("click", function(){ step(1); });
  function key(e){ if(!opts.get() || bar.hidden) return; if(e.key === "[" ){ e.preventDefault(); step(-1); } else if(e.key === "]"){ e.preventDefault(); step(1); } }
  window.addEventListener("keydown", key);
  function upd(){ var id = opts.get(); bar.hidden = !id; if(!id) return;
    var p = opts.list().filter(function(x){ return x.id === id; })[0]; label.textContent = "Watching " + (p ? p.name : "…") + "  ·  [ ] to switch"; }
  return {update: upd, destroy: function(){ window.removeEventListener("keydown", key); if(bar.parentNode) bar.parentNode.removeChild(bar); }};
}

HQV.engine = {now: now, clamp: clamp, hex: hex, angLerp: angLerp, calm: calm, say: say, tokens: tokens, myClock: myClock,
              fmtTime: fmtTime, dist3: dist3, lib: lib, loadGlb: loadGlb, hasWebGL2: hasWebGL2,
              senderTime: senderTime, jitter: jitter, pushSnap: pushSnap, bracket: bracket,
              sfx: sfx, sfxVolume: sfxVolume, sfxSetVolume: sfxSetVolume, engineSound: engineSound, engines: Object.keys(ENGINES), engineHz: engineHz, watchBar: watchBar,
              noiseLoop: noiseLoop,
              // the shared AudioContext and its master gain (the SFX volume), or null when sound is off:
              // for a game that shapes its own sound (the City's thunder) instead of a named sfx
              audioOut: function(){ var a = sfxVolume() > 0 ? audio() : null; return a && SND.master ? {ctx: a, out: SND.master} : null; }};
})();
