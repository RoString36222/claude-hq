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
var SND = {ctx: null, master: null, amb: null, woke: -Infinity, bctx: null, nbuf: {}, nn: 0, lbuf: {}, ln: 0};
function sfxVolume(){
  var v = null; try { v = localStorage.getItem("hq_sfx"); } catch(e){}
  if(v === null || v === "") return calm() ? 0 : 0.5;
  v = parseFloat(v); return isFinite(v) ? clamp(v, 0, 1) : 0.5;
}
// a bus's gain to v in a short glide: a slider dragged step by step would click on every step of a bare .value write
// (browsers no longer smooth one)
function glide(G, v){
  if(!G || !SND.ctx) return;
  try { var t = SND.ctx.currentTime; G.gain.cancelScheduledValues(t); G.gain.setTargetAtTime(v, t, 0.03); } catch(e){ G.gain.value = v; }
}
function sfxSetVolume(v){ try { localStorage.setItem("hq_sfx", String(clamp(+v || 0, 0, 1))); } catch(e){} glide(SND.master, sfxVolume()); }
// Ambient sounds (thunder, rain, fireworks, jets, planes, water, fountains, the city's hum, civic bells, roadworks): their own
// volume, localStorage hq_ambient as a number 0..1 (Sound PR B; 3.11.1 stored "0" for off and "1" for on, so the old
// Off reads as 0% and On as 100% with no migration step; unset or garbage is 100%, today's loudness). It feeds
// SND.amb, a gain into the master: every ambient sound is ambient x sfx volume, so Calm and mute silence it too.
function ambientVolume(){
  var v = null; try { v = localStorage.getItem("hq_ambient"); } catch(e){}
  if(v === null || v === "") return 1;
  v = parseFloat(v); return isFinite(v) ? clamp(v, 0, 1) : 1;
}
function ambientSetVolume(v){
  try { localStorage.setItem("hq_ambient", String(Math.round(clamp(+v || 0, 0, 1)*100)/100)); } catch(e){}
  glide(SND.amb, ambientVolume());
}
function ambientOn(){ return ambientVolume() > 0; }
function ambientSet(on){ ambientSetVolume(on ? 1 : 0); }
// The shared context. A suspended one is woken at most once a second: loops, pools and one-shots reach this every
// frame, and before your first click Chrome refuses each try and logs it. force (a gesture's, below): always.
function audio(force){
  if(SND.ctx){
    if(SND.ctx.state === "suspended" && (force || now() - SND.woke >= 1)){ SND.woke = now(); try { SND.ctx.resume().catch(function(){}); } catch(e){} }
    return SND.ctx;
  }
  var C = window.AudioContext || window.webkitAudioContext; if(!C) return null;
  try { SND.ctx = new C(); SND.master = SND.ctx.createGain(); SND.master.gain.value = sfxVolume(); SND.master.connect(SND.ctx.destination); } catch(e){ return null; }
  try { SND.amb = SND.ctx.createGain(); SND.amb.gain.value = ambientVolume(); SND.amb.connect(SND.master); } catch(e){ SND.amb = null; }
  return SND.ctx;
}
// tone() and noise() build the named sfx; sfxAt() points them at a spatial voice (DEST) and its sound-travel delay (OFF)
var DEST = null, OFF = 0;
function tone(ac, type, f0, f1, dur, vol, at){
  var t = ac.currentTime + OFF + (at || 0), o = ac.createOscillator(), g = ac.createGain();
  o.type = type; o.frequency.setValueAtTime(f0, t); if(f1) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(DEST || SND.master); o.start(t); o.stop(t + dur + 0.02);
}
// the noise buffers made once and shared (an AudioBuffer serves any number of sources): the one-shots' bursts by
// length (SND.nbuf) and the band loops' by band (SND.lbuf), a few dozen of each, for the context they were made on
function bufs(ac){ if(SND.bctx !== ac){ SND.bctx = ac; SND.nbuf = {}; SND.nn = 0; SND.lbuf = {}; SND.ln = 0; } }
// a fading burst of white noise, seeded by its length: the same burst every time (nothing heard is left to chance), so
// one buffer per length
function noiseBuf(ac, n){
  bufs(ac);
  var b = SND.nbuf[n]; if(b) return b;
  if(SND.nn >= 48){ SND.nbuf = {}; SND.nn = 0; }
  b = ac.createBuffer(1, n, ac.sampleRate); var d = b.getChannelData(0);
  for(var i = 0, s = (Math.imul(n, 0x9e3779b1) + 977) >>> 0; i < n; i++){ s = (Math.imul(s, 1664525) + 1013904223) >>> 0; d[i] = (s/2147483648 - 1)*(1 - i/n); }
  SND.nn++; return (SND.nbuf[n] = b);
}
function noise(ac, dur, vol, freq, at){
  var t = ac.currentTime + OFF + (at || 0), b = noiseBuf(ac, Math.floor(ac.sampleRate*dur));
  var src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
  src.buffer = b; f.type = "bandpass"; f.frequency.value = freq || 1200; g.gain.value = vol;
  src.connect(f); f.connect(g); g.connect(DEST || SND.master); src.start(t);
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
  // a car's two-tone horn, a motorbike's single higher one (opt.bike)
  horn: function(a, opt){
    if(opt && opt.bike){ tone(a, "square", 520, 0, 0.32, 0.07); tone(a, "square", 525, 0, 0.32, 0.04); return; }
    tone(a, "sawtooth", 415, 0, 0.42, 0.06); tone(a, "sawtooth", 523, 0, 0.42, 0.05);
  },
  // the starter turning the engine over (a gritty whirr), then the catch
  crank: function(a){
    for(var i = 0; i < 4; i++) tone(a, "sawtooth", 95 + i*6, 80, 0.11, 0.035, i*0.12);
    noise(a, 0.5, 0.025, 380);
  },
  bell: function(a){ tone(a, "sine", 2093, 2050, 0.35, 0.1); tone(a, "sine", 2637, 2600, 0.3, 0.06); tone(a, "sine", 2093, 2050, 0.35, 0.1, 0.14); },   // a bike bell
  // a blast (a missile's detonation, games/strike.js): the crack, the deep thump and its long rumble
  boom: function(a){ noise(a, 0.22, 0.3, 1100); tone(a, "sine", 95, 32, 0.55, 0.3); noise(a, 1.4, 0.38, 170); noise(a, 0.9, 0.12, 420, 0.08); }
};
// how long each named sfx sounds (s), for the one-shot voice limit of sfxAt
var SFX_DUR = {sink: 0.45, finish: 0.5, levelup: 0.6, crank: 0.55, horn: 0.45, bell: 0.5, boom: 1.45};
// the spatial kind sfxAt gives a named sfx unless opt.kind says otherwise (game feedback: your own)
var SFX_KIND = {door: "door", bell: "bell", horn: "vehicle", crank: "vehicle", shot: "blast", boom: "blast"};
function sfx(name, opt){
  if(sfxVolume() <= 0 || !SFX[name]) return;
  var a = audio(); if(!a || a.state !== "running") return;
  try { SFX[name](a, opt); } catch(e){}
}
// A continuous engine note (HQ 3.5.7: modelled on a real engine): engineSound(kind, ex) (ex: a tuned exhaust, 3.13) ->
// {set(rpm 900..7600, opt), stop()} (engineSound(kind, ex, real): set() takes the engine's real rpm, opt.limiter
// stutters it on its rev limiter, opt.qs makes an upshift a quickshifter's hard cut and bark). The game's rpm (900 idle .. 7600 limiter) maps onto the
// profile's own idle..redline, and the note's fundamental is the firing frequency of a four-stroke,
// rpm/60 * cylinders/2: a 390 single thumps at 12-90 Hz, a superbike four screams up to ~480 Hz.
// Its timbre is a harmonic recipe (a PeriodicWave), a detuned twin for body, a half-order sub for
// the lumpy ones (V-twin, boxer, cross-plane V8), a waveshaper for grit and a low-pass that opens
// with the revs and the load. opt (all optional): thr (0..1 throttle; without it the load is read
// from the revs' climb), gear (an upshift cuts, a downshift blips), speed (m/s: road rumble),
// slip (0..1: tyre squeal), dist (m: a farther engine is quieter and duller), pos + sk (where it is and its spatial
// kind, below: the listener's distance fade and pan replace dist; sk defaults to "own", your own vehicle).
// Layers on the same output: intake / exhaust roar (filtered noise), a turbo's whistle and its
// blow-off on a lift, crackle on the overrun for the sporty ones (deterministic, not under Calm),
// a diesel's clatter, a prop's blade-pass buzz, a rotor's slap. Every node is made once per engine;
// set() only moves AudioParams, and only those that moved (post); one barely heard (QUIET) moves its level and pan
// alone. All engines share one compressor so a stack of layers never clips.
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
  bike:   {cyl: 2, idle: 1400, red: 11500, h: [1, .7, .6, .45, .35, .25, .18, .12], sub: .35, det: 8, grit: 2, cut: [700, 4200], q: 1.2, gain: 0.04,  lope: [16, 0.15], rough: .4, pops: .6, air: .6},
  // Valley Rally: a turbo four with its whistle, a straight six, a high-revving four (also the superbikes' inline-4)
  turbo4: {cyl: 4, idle: 900, red: 7200,  h: [1, .38, .5, .2, .32, .12, .18, .08], sub: .12, det: 8, grit: 1.9, cut: [560, 3800], q: 1.3, gain: 0.05,  lope: [11, 0.08], rough: .2, pops: .7, turbo: 2300, air: .6},
  six:    {cyl: 6, idle: 750, red: 7400,  h: [1, .45, .3, .38, .15, .22, .1, .12, .06], sub: 0, det: 6, grit: 1.6, cut: [500, 3600], q: 1.2, gain: 0.055, lope: [8, 0.06], rough: .15, pops: .45, air: .5},
  four:   {cyl: 4, idle: 1200, red: 14000, h: [1, .5, .75, .35, .5, .22, .32, .14, .18, .08], sub: 0, det: 10, grit: 1.7, cut: [800, 5600], q: 1.4, gain: 0.045, lope: [16, 0.1], rough: .2, pops: .8, air: .7},
  // the real vehicles (games/hqvehiclephys.js voiceFor): a thumping single, a 270-degree parallel twin, a loping V-twin,
  // a flat boxer, turbo sixes and V8s with their whistle, a W16's deep smooth roar, a V16's higher shriek, and an
  // electric motor's whine (no firing, no lope, no gears: it climbs with the speed)
  single:   {cyl: 1, idle: 1500, red: 10500, h: [1, .9, .75, .55, .45, .35, .28, .22, .17, .13, .1, .08], sub: 0, det: 5, grit: 2.6, cut: [420, 2600], q: 1.6, gain: 0.05, lope: [3, 0.25], rough: .7, pops: .7, air: .55},
  twin:     {cyl: 2, idle: 1300, red: 10200, h: [1, .72, .6, .45, .35, .25, .18, .12], sub: .5, det: 7, grit: 2.2, cut: [600, 3800], q: 1.3, gain: 0.045, lope: [5, 0.3], rough: .55, pops: .7, air: .6},
  vtwin:    {cyl: 2, idle: 1250, red: 10000, h: [1, .7, .5, .35, .25, .18, .12, .08], sub: .8, det: 6, grit: 2.4, cut: [520, 3200], q: 1.5, gain: 0.055, lope: [4, 0.45], rough: .8, pops: .8, air: .6},
  boxer:    {cyl: 2, idle: 1050, red: 9000,  h: [1, .5, .6, .25, .3, .12, .15, .06], sub: .45, det: 5, grit: 2, cut: [500, 3000], q: 1.2, gain: 0.05, lope: [4.5, 0.3], rough: .5, pops: .3, air: .5},
  turbo6:   {cyl: 6, idle: 720, red: 7200,  h: [1, .42, .3, .36, .15, .2, .1, .1, .06], sub: 0, det: 6, grit: 1.7, cut: [460, 3200], q: 1.2, gain: 0.055, lope: [8, 0.05], rough: .12, pops: .6, turbo: 2000, air: .5},
  v8tt:     {cyl: 8, idle: 650, red: 7000,  h: [1, .7, .5, .45, .28, .22, .14, .1, .07], sub: .35, det: 6, grit: 2, cut: [420, 3000], q: 1.4, gain: 0.06, lope: [5.5, 0.15], rough: .3, pops: .55, turbo: 1600, air: .5},
  // [3.9] the naturally aspirated Italians: a V10's hard-edged wail (the Huracán's 8,500 rpm, its odd orders rasping) and
  // a V12's smooth shriek to 9,500 (the Revuelto); both open the low-pass far up and crackle on the overrun
  v10:      {cyl: 10, idle: 1000, red: 8700, h: [1, .45, .6, .3, .38, .18, .24, .12, .1, .06], sub: .12, det: 8, grit: 2.2, cut: [700, 6600], q: 1.8, gain: 0.055, lope: [10, 0.06], rough: .15, pops: .8, air: .7},
  v12:      {cyl: 12, idle: 950, red: 9500, h: [1, .3, .42, .18, .28, .1, .16, .06, .08], sub: 0, det: 10, grit: 1.8, cut: [900, 7400], q: 1.9, gain: 0.05, lope: [12, 0.04], rough: .08, pops: .6, air: .7},
  // [3.17] the F1 turbo-hybrid V6 (docs/plans/grand-prix-spec.md): 12,500 rpm, a high hard whine from the even firing
  // and the turbo's scream, very little low rumble; the MGU-H keeps the blow-off quiet
  v6:       {cyl: 6, idle: 4000, red: 12500, h: [1, .35, .55, .2, .4, .15, .25, .1, .12, .06], sub: 0, det: 9, grit: 1.6, cut: [1100, 8200], q: 2, gain: 0.05, lope: [16, 0.03], rough: .06, pops: .25, turbo: 3600, air: .7},
  w16:      {cyl: 16, idle: 900, red: 6700, h: [1, .5, .3, .25, .15, .1, .06], sub: .15, det: 5, grit: 1.5, cut: [600, 3600], q: 1, gain: 0.065, lope: [7, 0.06], rough: .1, pops: .3, turbo: 1500, air: .6},
  v16:      {cyl: 16, idle: 1000, red: 9000, h: [1, .35, .45, .2, .28, .12, .16, .08], sub: 0, det: 9, grit: 1.9, cut: [800, 6000], q: 1.6, gain: 0.055, lope: [9, 0.05], rough: .1, pops: .6, air: .65},
  // [3.9] the new bikes: a counter-rotating V4's twin-pulse bark (the Panigale), an inline triple's howl, a crossplane
  // four's uneven growl (the R1), a supercharged four with the blower's whine and a chirp on a lift (the H2), a
  // long-stroke single's slow thump (the Classic 350), a low-revving 270-degree twin (the Interceptor) and a 45-degree
  // V-twin's lumpy potato-potato (the Fat Boy)
  v4:           {cyl: 4, idle: 1250, red: 14500, h: [1, .75, .5, .55, .35, .35, .2, .2, .1], sub: .45, det: 9, grit: 2.3, cut: [650, 5200], q: 1.6, gain: 0.05, lope: [7, 0.18], rough: .35, pops: .9, air: .7},
  triple:       {cyl: 3, idle: 1150, red: 12650, h: [1, .65, .7, .45, .5, .28, .32, .16, .12], sub: .3, det: 7, grit: 2, cut: [600, 4800], q: 1.5, gain: 0.05, lope: [9, 0.1], rough: .2, pops: .75, air: .65},
  crossplane:   {cyl: 4, idle: 1350, red: 13800, h: [1, .75, .5, .45, .3, .25, .15, .1], sub: .55, det: 8, grit: 2.4, cut: [600, 5000], q: 1.6, gain: 0.05, lope: [6, 0.22], rough: .45, pops: .85, air: .7},
  supercharged: {cyl: 4, idle: 1100, red: 12500, h: [1, .3, .5, .18, .3, .1, .18, .07, .1], sub: .05, det: 8, grit: 1.8, cut: [700, 5400], q: 1.4, gain: 0.048, lope: [14, 0.08], rough: .15, pops: .5, turbo: 3200, air: .65},
  longstroke:   {cyl: 1, idle: 800, red: 6100, h: [1, .95, .8, .6, .5, .38, .3, .22, .16, .12], sub: 0, det: 4, grit: 2.8, cut: [300, 1700], q: 1.6, gain: 0.055, lope: [2.4, 0.35], rough: .85, pops: .4, air: .45},
  twin270:      {cyl: 2, idle: 1050, red: 7250, h: [1, .65, .45, .32, .22, .14, .1], sub: .55, det: 6, grit: 2.2, cut: [450, 2600], q: 1.3, gain: 0.05, lope: [4.2, 0.35], rough: .55, pops: .5, air: .55},
  vtwin45:      {cyl: 2, idle: 850, red: 5500, h: [1, .85, .6, .45, .3, .2, .12], sub: 1, det: 5, grit: 2.8, cut: [300, 1800], q: 1.8, gain: 0.06, lope: [2.2, 0.6], rough: 1, pops: .5, air: .5},
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
// [3.13] the Tuning shop's exhausts (games/hqtuning.js): a small change on top of the engine's own profile. Louder
// (gain), raspier (grit, a low-pass that opens further at the top: cut), deeper (sub) or more crackle on the overrun
// (pops). Cars: sport, quad, titanium (blue-burnt tips: the most crackle); bikes: slip-on, under-seat, end can.
var EXHAUST = {
  sport:     {gain: 1.18, grit: 1.22, cut: 1.12, pops: 0.1},
  quad:      {gain: 1.22, grit: 1.1, cut: 1.05, sub: 0.15},
  titanium:  {gain: 1.15, grit: 1.15, cut: 1.2, pops: 0.35},
  slipon:    {gain: 1.16, grit: 1.2, cut: 1.12, pops: 0.1},
  underseat: {gain: 1.2, grit: 1.12, cut: 0.95, sub: 0.12},
  endcan:    {gain: 1.12, grit: 1.2, cut: 1.15, pops: 0.3}
};
// engineProfile(kind, ex, real) -> the profile engineSound plays: ENGINES[kind] as it is (stock, an unknown exhaust, an
// electric motor or a rotor), or a copy with the exhaust's changes. real (a vehicle's own engine, games/hqvehiclephys.js
// engineFor: {idle, red, limit, cyl, motorMax, tone}): set() then takes that engine's REAL rpm, the voice plays at its
// own idle and redline, and its exhaust character shades the voice (tone 0..1: depth a deeper, fuller note; rasp a
// harder edge; crackle pops on the overrun and at the limiter; induction the intake's roar; whistle a turbo's or a
// supercharger's whine)
function engineProfile(kind, ex, real){
  var P = ENGINES[kind] || ENGINES.v8, M = EXHAUST[ex];
  if((!M || !P.cyl) && !real) return P;
  var Q = {}; Object.keys(P).forEach(function(k){ Q[k] = P[k]; });
  if(real){
    Q.real = true;
    if(P.cyl){ Q.idle = real.idle > 0 ? real.idle : P.idle; Q.red = real.red > Q.idle ? real.red : P.red; Q.limit = real.limit > Q.red ? real.limit : Q.red + 300;
               if(real.cyl > 0) Q.cyl = real.cyl; }
    else Q.max = real.motorMax > 0 ? real.motorMax : 16000;
    var T = real.tone;
    if(T && P.cyl){
      var d = clamp(+T.depth || 0.5, 0, 1), r = clamp(+T.rasp || 0.5, 0, 1);
      Q.sub = Math.min(1.2, (P.sub || 0)*(0.5 + d) + Math.max(0, d - 0.6)*0.4);
      Q.cut = [Math.round(P.cut[0]*(1.25 - 0.5*d)), Math.round(P.cut[1]*(0.85 + 0.35*r))];
      Q.grit = (P.grit || 1)*(0.75 + 0.6*r); Q.q = P.q*(0.9 + 0.4*r);
      if(T.crackle != null) Q.pops = clamp(+T.crackle, 0, 1);
      if(T.induction != null) Q.air = 0.25 + 0.75*clamp(+T.induction, 0, 1);
      Q.whistle = T.whistle != null ? clamp(+T.whistle, 0, 1) : null;
      if(Q.whistle > 0.35 && !Q.turbo) Q.turbo = 2600;
    }
  }
  if(M && Q.cyl){
    Q.gain = Q.gain*M.gain; Q.grit = (Q.grit || 1)*M.grit; Q.cut = [Q.cut[0], Math.round(Q.cut[1]*M.cut)];
    Q.pops = Math.min(1, (Q.pops || 0) + (M.pops || 0)); Q.sub = Math.min(1.2, (Q.sub || 0) + (M.sub || 0));
  }
  return Q;
}
// The profile's real revs and fundamental (Hz) for an rpm; firing = rpm/60*cyl/2. A game rpm (900..7600) maps onto the
// voice's idle..redline; a real profile (engineProfile(.., real)) takes the engine's own rpm.
function engineHz(kind, rpm, P){
  P = P || ENGINES[kind] || ENGINES.v8;
  if(P.real){
    if(!P.cyl){ var ue = clamp(rpm/(P.max || 16000), 0, 1); return {u: ue, rpm: rpm, hz: P.lo + (P.hi - P.lo)*ue}; }
    return {u: clamp((rpm - P.idle)/(P.red - P.idle), 0, 1.15), rpm: rpm, hz: Math.max(P.idle*0.6, rpm)/60*P.cyl/2};
  }
  var u = clamp((rpm - 900)/6700, 0, 1);
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
// the firing pulses over one engine cycle (two crank turns): one bang per cylinder, at its place in the firing
// order (an even four or a single; a 270-degree twin or a V-twin's uneven pair; a crossplane four's 270-180-90-180),
// each its own height (no two cylinders burn alike: deterministic per voice); a PeriodicWave played at the cycle rate
var UNEVEN = {twin: [0, .375], twin270: [0, .375], vtwin: [0, .396], vtwin45: [0, .4375], boxer: [0, .5], crossplane: [0, .375, .625, .75], v4: [0, .25, .5, .875]};
function pulseWave(a, B, kind, cyl){
  var key = kind + ":" + cyl; B.pulses = B.pulses || {};
  if(B.pulses[key] || !a.createPeriodicWave) return B.pulses[key] || null;
  var pos = UNEVEN[kind] && UNEVEN[kind].length === cyl ? UNEVEN[kind] : null, N = 512, x = new Float32Array(N), sd = 99;
  for(var i = 0; i < kind.length; i++) sd = (sd*31 + kind.charCodeAt(i)) & 0x7fffffff;
  for(var c = 0; c < cyl; c++){
    sd = (sd*1103515245 + 12345) & 0x7fffffff;
    var at = pos ? pos[c] : c/cyl, h = 0.6 + 0.8*sd/0x7fffffff, w = 0.16/cyl;
    for(var j = 0; j < N; j++){ var d = j/N - at; d -= Math.round(d); x[j] += h*Math.exp(-d*d/(2*w*w)); }
  }
  var H = Math.min(48, 8*cyl), re = new Float32Array(H + 1), im = new Float32Array(H + 1);
  for(var k = 1; k <= H; k++){ var r = 0, m = 0; for(j = 0; j < N; j++){ r += x[j]*Math.cos(2*Math.PI*k*j/N); m += x[j]*Math.sin(2*Math.PI*k*j/N); } re[k] = r/N; im[k] = m/N; }
  return (B.pulses[key] = a.createPeriodicWave(re, im));
}
function engineCurve(B, k){
  var key = Math.round(k*10); if(B.curves[key]) return B.curves[key];
  var c = new Float32Array(1024), th = Math.tanh(k);
  for(var i = 0; i < 1024; i++){ var x = i/511.5 - 1; c[i] = Math.tanh(k*x)/th; }
  return (B.curves[key] = c);
}
// Every pooled voice sets its params each frame, and most of them hold still: post(p, v, t, tc, rel, abs) moves p's
// target only when v differs from the last one posted by more than rel of it (default 1%) plus abs (default 1e-4). The
// last target of each param is kept in a WeakMap (gone with its node). Returns whether it posted.
var POSTED = typeof WeakMap === "function" ? new WeakMap() : null;
function post(p, v, t, tc, rel, abs){
  if(POSTED){
    var w = POSTED.get(p);
    if(w !== undefined && Math.abs(v - w) <= (rel != null ? rel : 0.01)*Math.abs(w) + (abs != null ? abs : 1e-4)) return false;
    POSTED.set(p, v);
  }
  p.setTargetAtTime(v, t, tc); return true;
}
var QUIET = 0.02;                 // an engine fading below this (its distance's share) moves only its level and pan
// engineSound(kind, ex, real) -> {set(rpm, opt), stop()}: the voice below behind a watchdog. A voice that
// has not had set() for WATCH_S seconds (a dismount, a world change, a replaced ride, a hidden tab, a game that
// forgot stop(), a pool's parked handle) is stopped outright: every node, not just faded; the next set() builds it
// afresh (and a voice made while muted is built once the sound is back on).
var WATCH_S = 0.5, VOICES = [], watchId = null;
function watchdog(){
  for(var i = VOICES.length - 1; i >= 0; i--){ var w = VOICES[i]; if(w.idle() > WATCH_S) w.halt(); }
  if(!VOICES.length && watchId != null){ clearInterval(watchId); watchId = null; }
}
function arm(w){
  if(VOICES.indexOf(w) < 0) VOICES.push(w);
  if(watchId == null && typeof setInterval === "function"){ watchId = setInterval(watchdog, 200); if(watchId && watchId.unref) watchId.unref(); }
}
function engineSound(kind, ex, real){
  var v = engineVoice(kind, ex, real), last = 0, W = {
    idle: function(){ return v && v.ac ? v.ac.currentTime - last : 0; },
    halt: function(){ if(v){ v.stop(); v = null; } var i = VOICES.indexOf(W); if(i >= 0) VOICES.splice(i, 1); },
    set: function(rpm, opt){
      if(!v || (!v.ac && sfxVolume() > 0)) v = engineVoice(kind, ex, real);
      if(!v.ac) return;
      last = v.ac.currentTime;
      arm(W); v.set(rpm, opt);
    },
    stop: function(){ W.halt(); }
  };
  if(v.ac){ last = v.ac.currentTime; arm(W); }
  return {set: W.set, stop: W.stop};
}
function engineVoice(kind, ex, real){
  var P = engineProfile(kind, ex, real);
  var a = sfxVolume() > 0 ? audio() : null; if(!a) return {set: function(){}, stop: function(){}, ac: null};
  var B = engineBus(a), t0 = a.currentTime, nodes = [];
  // the output first (the dead man's switch lives here), then the chain into it:
  // [main + twin + sub] -> drive -> grit -> low-pass -> amp (lope, shift cut) -> out -> pan -> bus
  var g = a.createGain(), amp = a.createGain(), cut = a.createGain(), drv = a.createGain(), f = a.createBiquadFilter();
  var pn = a.createStereoPanner ? a.createStereoPanner() : null;     // left/right from where it is (set(.., {pos}))
  g.gain.value = 0; amp.gain.value = 1; cut.gain.value = 1; drv.gain.value = P.grit || 1;
  f.type = "lowpass"; f.frequency.value = P.cut[0]; f.Q.value = Math.min(P.q, P.cyl && P.cyl <= 4 ? 0.9 : 1.4);   // no resonant peak to ring as a buzz
  var o = a.createOscillator(), o2 = a.createOscillator(), os = a.createOscillator(), sg = a.createGain();
  var wave = engineWave(a, B, kind, P);
  if(wave){ o.setPeriodicWave(wave); o2.setPeriodicWave(wave); } else { o.type = P.h ? "sawtooth" : "sine"; o2.type = P.h ? "sawtooth" : "triangle"; }
  os.type = "triangle"; sg.gain.value = P.sub || 0;
  if(o2.detune) o2.detune.value = P.det || 0;
  var o2g = a.createGain(); o2g.gain.value = P.r2 ? 0.25 : 0.7;
  o.connect(drv); o2.connect(o2g); o2g.connect(drv); os.connect(sg); sg.connect(drv);
  var sh = a.createWaveShaper ? a.createWaveShaper() : null;
  if(sh){ sh.curve = engineCurve(B, P.grit || 1); drv.connect(sh); sh.connect(f); } else drv.connect(f);
  f.connect(amp); amp.connect(cut); cut.connect(g); if(pn){ g.connect(pn); pn.connect(B.out); } else g.connect(B.out);
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
  // a piston engine is a train of bangs, not a held note: the firing pulses (amp's gain beats at the firing
  // frequency, deepest for a single, smoothing with the cylinder count and the revs; their depth and timing jitter
  // cycle to cycle) and the exhaust's own roar (low-passed noise through the same pulses, with the throttle and revs)
  var TRIM = P.cyl === 1 ? 0.72 : P.cyl === 2 ? 0.85 : 1, JIT = 2000, FIRE = P.cyl ? clamp(0.8 - 0.06*P.cyl, 0.15, 0.7) : 0, fp = null, fpd = null, exf = null, exg = null, jf = null, jg = null;
  if(FIRE){
    fp = a.createOscillator(); fpd = a.createGain(); var pw = pulseWave(a, B, kind, P.cyl);
    if(pw) fp.setPeriodicWave(pw); else fp.type = "sawtooth";
    fpd.gain.value = FIRE; fp.connect(fpd); fpd.connect(amp.gain); fp.start(); nodes.push(fp);
    exf = a.createBiquadFilter(); exg = a.createGain(); exf.type = "lowpass"; exf.frequency.value = 400; exf.Q.value = 0.5; exg.gain.value = 0;
    src.connect(exf); exf.connect(exg); exg.connect(amp);
    // and no two cycles last quite the same: slow random FM (low-passed noise into the detune, in cents) smears every
    // partial into a band instead of a held sine
    jf = a.createBiquadFilter(); jg = a.createGain(); jf.type = "lowpass"; jf.frequency.value = 35; jf.Q.value = 0.5; jg.gain.value = 0;
    src.connect(jf); jf.connect(jg);
    [o, o2, os, fp].forEach(function(n){ if(n.detune) jg.connect(n.detune); });
  }
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
  var S = {t: t0, jw: 0, rpm: null, load: 0.3, boost: 0, lift: 9, pop: 0, wob: 0, gear: null, blip: 0, thr: 0, lim: 0, pan: 0, slip: 0};
  // a param's target, posted only when it moved (post, below): e its tolerance (default 1%; the pitches 0.3%)
  function tgt(p, v, tc, e){ post(p, v, a.currentTime, tc, e); }
  return {
    ac: a,
    set: function(rpm, opt){
      opt = opt || {};
      var t = a.currentTime, on = sfxVolume() > 0, dt = clamp(t - S.t, 0, 0.1), F = engineHz(kind, rpm, P), u = Math.min(1, F.u), hz = F.hz;
      S.t = t;
      // where it is (Sound PR B): opt.pos and opt.sk (its spatial kind, default "own": your own vehicle, as far as the
      // listener's own reach) give the distance fade (far, which also dulls it), the pan and, for an ambient kind, the
      // Ambient sounds volume. With no position (or no listener) the legacy opt.dist (m) still quietens and dulls it. A
      // voice barely heard (far under QUIET: a pooled engine at the edge of earshot) moves only its level and pan; its
      // timbre catches up once it is heard
      var sk = opt.sk != null ? String(opt.sk) : "own", sp = opt.pos ? hear(sk, opt.pos) : null, far, amb = 1;
      if(opt.pos && SP.L){ far = sp ? sp.g : 0; if(kindOf(sk).bus === "ambient") amb = ambientVolume(); }
      else { var dist = opt.dist != null ? clamp(+opt.dist || 0, 0, 1e4) : 0; far = 1/(1 + dist/12); }
      var hush = far < QUIET, np = sp ? sp.pan : 0;
      if(pn && Math.abs(np - S.pan) > 0.01){ S.pan = np; pn.pan.setTargetAtTime(np, t, 0.05); }
      // the load: the throttle if the game gives it, else how hard the revs are climbing
      var rise = S.rpm != null && dt > 0 ? (rpm - S.rpm)/dt : 0; S.rpm = rpm;
      var thr = opt.thr != null ? clamp(+opt.thr || 0, 0, 1) : clamp(0.3 + 0.5*u + rise/3000, 0, 1);
      // gears: an upshift cuts the ignition for a moment, a downshift blips the throttle (and pops)
      if(opt.gear != null && S.gear != null && opt.gear > 0 && S.gear > 0 && opt.gear !== S.gear){
        if(opt.gear > S.gear && opt.qs){                  // a quickshift: a hard 50 ms cut, its bark and a pop
          cut.gain.setTargetAtTime(0.04, t, 0.004); cut.gain.setTargetAtTime(1, t + 0.05, 0.012);
          if(P.pops && on && !calm()) crackle(t + 0.02);
          if(bov && S.boost > 0.3) blowOff(t);
        } else if(opt.gear > S.gear){
          cut.gain.setTargetAtTime(0.3, t, 0.012); cut.gain.setTargetAtTime(1, t + 0.09, 0.04);
          if(bov && S.boost > 0.3) blowOff(t);
        } else { S.blip = 0.16; if(P.pops && on) crackle(t + 0.12); }
      }
      if(opt.gear != null) S.gear = opt.gear;
      // on the rev limiter: the ignition cuts in a fast stutter, and a sporty one pops through it
      if(opt.limiter && t >= S.lim){
        S.lim = t + 0.055 + rnd()*0.02;
        cut.gain.setTargetAtTime(0.18, t, 0.006); cut.gain.setTargetAtTime(1, t + 0.025, 0.008);
        if(P.pops && on && !calm() && rnd() < P.pops*0.6) crackle(t + 0.02);
      }
      if(S.blip > 0){ S.blip -= dt; thr = 1; }
      var k = dt > 0 ? 1 - Math.exp(-dt*10) : 1;
      S.load += (thr - S.load)*k;
      // a lift: the turbo blows off, and a sporty engine crackles on the overrun for a second or so
      if(S.thr > 0.5 && thr < 0.15){ S.lift = 0; if(bov && S.boost > 0.35) blowOff(t); }
      S.thr = thr; S.lift += dt;
      var L = S.load;
      // the turbo: boost builds on throttle with the revs, falls fast off it; its whistle rides on the boost
      if(wh){
        var want = P.rotor ? u : L > 0.5 ? u : 0;
        S.boost += (want - S.boost)*(dt > 0 ? 1 - Math.exp(-dt*(want > S.boost ? 2.2 : 7)) : 1);
      }
      // the overrun crackle's odds: the drive mode's exhaust (opt.mode: games/hqvehiclephys.js MODES): Comfort quiet and
      // smooth, Track loud and crackling; opt.crackle: the game's own overrun window (a lift, a downshift's blip), so the
      // pops and the flames agree
      var MD = opt.mode === "comfort" ? {gain: 0.82, pops: 0.15} : opt.mode === "track" ? {gain: 1.15, pops: 1.6} : {gain: 1, pops: 1};
      if(!hush){
        // the notes: firing frequency, its detuned twin, the half-order sub; a lumpy, irregular idle
        // never a dead-steady rpm: a wobble of 0.6..1.8 % (the road's load, the idle's hunt) every 60-150 ms
        if((P.rough || FIRE) && t >= S.wob){
          S.wob = t + 0.06 + rnd()*0.09;
          var idle = (1 - u)*(1 - u);
          if(FIRE) S.jw = (rnd() - 0.5)*2*(0.006 + 0.012*idle);
          if(o.detune && P.rough) tgt(o.detune, (rnd() - 0.5)*2*P.rough*45*idle, 0.03);
          if(P.rough) tgt(sg.gain, (P.sub || 0)*(0.7 + 0.6*rnd()*idle), 0.04);
          if(fpd) tgt(fpd.gain, FIRE*(1 - 0.45*u)*(0.7 + 0.6*rnd()), 0.02);
        }
        var hzw = hz*(1 + (S.jw || 0));
        tgt(o.frequency, hzw, 0.03, 0.003); tgt(o2.frequency, hzw*(P.r2 || 1), 0.03, 0.003); tgt(os.frequency, hzw*0.5, 0.03, 0.003);
        if(fp) tgt(fp.frequency, hzw/P.cyl, 0.03, 0.003);           // the cycle: every cylinder fires once
        if(l){
          if(P.blades) tgt(l.frequency, (F.rpm/60)*P.blades, 0.05);           // the prop's blade-pass buzz
          else if(P.rotor) tgt(l.frequency, 9 + 9*u, 0.1);                     // rotor slap with the revs
          else tgt(ld.gain, P.lope[1]*(1 - 0.85*u), 0.1);                      // the lope smooths out with revs
        }
        tgt(drv.gain, (P.grit || 1)*(0.45 + 0.9*L), 0.05);
        if(jg) tgt(jg.gain, JIT*(1.4 - 0.6*u), 0.1);
        if(exg){ tgt(exf.frequency, clamp(hz*5 + 250 + 1800*L*u, 150, 5000), 0.06); tgt(exg.gain, 2.4*(0.35 + 0.65*L)*(0.5 + 0.5*u)*(0.6 + 0.6*(P.air || 0.5)), 0.06); }
        var fc = (P.cut[0] + (P.cut[1] - P.cut[0])*u)*(0.45 + 0.75*L)*(0.4 + 0.6*far);
        tgt(f.frequency, clamp(Math.max(fc, hz*2.5), 60, 16000), 0.06);
        // intake / exhaust roar, road rumble, a squeal in a slide (its pitch only while it squeals)
        // nitrous (opt.boost): a hard hiss over the intake and the whistle up
        var nit = opt.boost ? 1 : 0;
        tgt(air.f.frequency, clamp(hz*6 + nit*2500, 250, 8000), 0.06); tgt(air.g.gain, (P.air || 0)*0.035*(0.15 + 0.85*L)*(0.25 + 0.75*u) + nit*0.05, 0.06);
        var spd = Math.abs(+opt.speed || 0), slip = clamp(+opt.slip || 0, 0, 1), sqf = 1150 + 400*slip + 120*rnd();
        tgt(rum.f.frequency, 70 + Math.min(spd, 60)*3, 0.1); tgt(rum.g.gain, Math.min(0.05, spd/30*0.05), 0.08);
        if(slip > 0 || S.slip > 0) tgt(sq.f.frequency, sqf, 0.05);
        tgt(sq.g.gain, 0.06*slip, 0.05); S.slip = slip;
        if(wh){ tgt(wh.frequency, P.turbo*(0.4 + 0.8*S.boost), 0.08, 0.003); tgt(whg.gain, 0.014*S.boost*S.boost*(P.whistle != null ? 0.4 + 1.6*P.whistle : 1), 0.08); }
        if(rat) tgt(rat.g.gain, P.rattle*(1 - u*0.5), 0.1);
        // the turbofan: the whine follows N1 (u), the roar the thrust (the load)
        if(fan){
          var fq = P.fan[0] + (P.fan[1] - P.fan[0])*u, th = Math.pow(L, 1.5);
          tgt(fan.frequency, fq, 0.08, 0.003); tgt(fan2.frequency, fq*1.62, 0.08, 0.003); tgt(fg.gain, P.whine*(0.3 + 0.7*u), 0.08);
          tgt(roar.f.frequency, 250 + 1800*L, 0.1); tgt(roar.g.gain, P.roar*(0.05 + 0.95*th), 0.1);
          tgt(hiss.f.frequency, 1800 + 2600*u, 0.1); tgt(hiss.g.gain, P.roar*0.25*th, 0.1);
        }
        // the overrun crackle: off the throttle at speed, a burst every 40-260 ms for the first ~1.2 s
        var popsP = Math.min(1, (P.pops || 0)*MD.pops*(opt.crackle ? 1.4 : 1));
        if(popsP > 0 && on && L < 0.2 && u > 0.2 && (S.lift < 1.2 || opt.crackle) && t >= S.pop && !calm()){
          S.pop = t + 0.03 + rnd()*0.2/Math.max(0.2, popsP);
          if(rnd() < popsP) crackle(t);
          if(opt.crackle && rnd() < popsP*0.5) crackle(t + 0.025 + rnd()*0.03);   // a double bang
        }
      }
      // a dead man's switch: each set() fades the note out 0.25 s from now and the next frame's
      // set() cancels that, so the engine falls silent whenever the game stops calling (a hidden
      // tab, another view, a stalled loop) instead of droning on at its last revs
      var lvl = on ? TRIM*P.gain*MD.gain*(0.6 + 0.45*u)*(0.55 + 0.45*L)*far*amb : 0;
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
// A looping band of noise (tyre scrub, gravel under the car): noiseLoop(freq, q, sk) ->
// {set(gain, freq, pos), stop()}. Silent until set() is called with a gain. sk (a spatial kind, below) makes it
// positional: set()'s pos then fades it with the distance and pans it (an ambient kind also follows Ambient sounds).
function noiseLoop(freq, q, sk){ return bandLoop(freq, q, sk, false); }
// an ambient noiseLoop: through the ambient volume (SND.amb) and silent at 0% (checked every set(), so the slider
// acts at once); sk + set()'s pos make it positional, as noiseLoop's
function ambientLoop(freq, q, sk){
  var L = bandLoop(freq, q, sk, true);
  return {set: function(gain, fq, pos){ L.set(ambientOn() ? gain : 0, fq, pos); }, stop: L.stop};
}
// a band loop's 0.6 s of noise, seeded by its band: one buffer per band (SND.lbuf), made the first time
function bandBuf(a, freq, q){
  bufs(a);
  var fr = Math.round(+freq || 1000), qq = Math.round((+q || 1)*1000), key = fr + ":" + qq, b = SND.lbuf[key];
  if(b) return b;
  if(SND.ln >= 32){ SND.lbuf = {}; SND.ln = 0; }
  var n = Math.floor(a.sampleRate*0.6), d;
  b = a.createBuffer(1, n, a.sampleRate); d = b.getChannelData(0);
  for(var i = 0, s = (Math.imul(fr, 0x9e3779b1) + qq) >>> 0; i < n; i++){ s = (Math.imul(s, 1664525) + 1013904223) >>> 0; d[i] = s/2147483648 - 1; }
  SND.ln++; return (SND.lbuf[key] = b);
}
function bandLoop(freq, q, sk, ambient){
  var a = sfxVolume() > 0 ? audio() : null; if(!a) return {set: function(){}, stop: function(){}};
  var b = bandBuf(a, freq, q);
  var spec = sk != null ? kindOf(sk) : null, bus = (ambient || (spec && spec.bus === "ambient")) && SND.amb ? SND.amb : SND.master;
  var src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain(), pn = spec && a.createStereoPanner ? a.createStereoPanner() : null, was = 0;
  src.buffer = b; src.loop = true; f.type = "bandpass"; f.frequency.value = freq || 1000; f.Q.value = q || 1; g.gain.value = 0;
  src.connect(f); f.connect(g); if(pn){ g.connect(pn); pn.connect(bus); } else g.connect(bus); src.start();
  return {
    set: function(gain, fq, pos){
      var t = a.currentTime, on = sfxVolume() > 0, k = 1, pan = 0;
      if(spec && pos && SP.L){ var h = hear(sk, pos); k = h ? h.g : 0; pan = h ? h.pan : 0; }
      g.gain.cancelScheduledValues(t); g.gain.setTargetAtTime(on ? clamp(+gain || 0, 0, 0.3)*k : 0, t, 0.06);
      g.gain.setTargetAtTime(0, t + 0.25, 0.05);                       // silent when set() stops coming (engineSound)
      if(fq) post(f.frequency, clamp(fq, 60, 8000), t, 0.1);
      if(pn && Math.abs(pan - was) > 0.01){ was = pan; pn.pan.setTargetAtTime(pan, t, 0.05); }
    },
    stop: function(){ try { g.gain.cancelScheduledValues(a.currentTime); g.gain.setTargetAtTime(0, a.currentTime, 0.05); src.stop(a.currentTime + 0.3); } catch(e){} }
  };
}
/* ---------- spatial sound (Sound PR B): every world sound where it is ----------
 * Positions are metres in the active 3D scene's frame (what games/hq3d.js camInfo() reports), y up; a position is
 * {x, y, z} (a THREE.Vector3 too) or [x, y, z], and a missing y is level with the ears. The listener is the camera,
 * set once a frame by whatever renders the view (hq3d.js frame(), each 3D game's own loop):
 *   listener(cam, at, own)  cam: a THREE camera (its matrixWorld: position, right = column 0, forward = -column 2), or
 *                      {x, y, z, yaw} (yaw 0 faces +z, right = (-cos yaw, sin yaw)), or null for no listener: then
 *                      every positional call plays centred at its raw level (2D games, tests) and every pool lets its
 *                      voices go at once (a paused view, a hidden tab: their engines would run on, silent), to make
 *                      them again under the next listener. at: optional {x, y, z} to hear from there with the camera's
 *                      facing (a top-down view hears from what it looks at). own: optional, how far your own things
 *                      carry at full volume this frame (m; the "own" kind's reference distance, below): Infinity while
 *                      the camera rides with you, the vehicle's chase reach from a detached one (photo, cine, a map).
 *                      Each call also lets go the voices of every pool nothing has updated for STALE s (a floor you
 *                      left, a module that stopped drawing)
 *   listenerAt()       a copy {x, y, z, rx, rz, fx, fz, own} (right and forward on the ground, unit), or null
 * Kinds (spatial.KINDS, tuned in this one table): ref (m: full volume within), max (m: silent at and past it),
 * roll (how fast it fades between), voices (how many of the kind sound at once), bus ("engine": the engines'
 * compressor, "master", "ambient": the Ambient sounds volume too), sos (a one-shot starts d/343 s late, the sound
 * travelling), curve: false (its callers bring their own distance curve: thunderVol, boomVol, hqGrenade.boomVol),
 * pan (a multiplier: "own" 0.25, beds 0). Nothing plays while the sfx volume is 0 (Calm's default, mute).
 * A source may bring its own reference distance past its kind's (hear's opt.ref; for "own" the listener's own): full
 * volume within it, then the kind's fade, its max moved out by as much.
 *   falloff(spec, d)   1 within ref, 0 at max and past it, else ref/(ref + roll*(d - ref)) * (1 - ((d - ref)/(max - ref))^2):
 *                      the Web Audio PannerNode "inverse" model (refDistance ref, rolloffFactor roll) with a taper that
 *                      takes it to silence at maxDistance, which "inverse" alone never reaches
 *   panOf(L, pos, ref) -1 (left) .. 1 (right): the source's share along the listener's right, * min(1, d/ref) * 0.85
 *                      (never one ear only; a source at the ears is centred; one overhead is centred too)
 * Nodes per voice: [its sources] -> gain (falloff x level) -> StereoPannerNode -> the kind's bus, values pushed with
 * setTargetAtTime. No StereoPanner (old browsers, the tests' fake contexts): gain only. No PannerNode: its distance
 * models never reach 0 at maxDistance, its listener orientation differs across browsers, HRTF costs a lot per voice.
 * Calls:
 *   hear(kind, pos, opt)        -> {g, pan, d} | null (past max): what a source there gets now. opt: {gain, curve, ref}
 *   spatialOut(kind, pos, opt)  -> {ctx, out, d, delay, move(pos, gain), end(sec)} | null: a voice for a module that
 *                                  makes its own sound: connect into out, start at ctx.currentTime + delay. null at
 *                                  volume 0 (or ambient 0 for an ambient kind), past max, while the context is not
 *                                  running (before your first click: a held voice too, so nothing queues up at its
 *                                  frozen clock to sound all at once), or when the kind's one-shot limit keeps nearer
 *                                  ones. opt: gain (level, default 1), curve (false: gain is the
 *                                  whole level, pan only), delay (true: d/343 s, false: none, a number: s; default the
 *                                  kind's sos), dur (s it sounds, default 2), key (a repeat from the same key replaces
 *                                  the last one), hold (true: a held voice, no limit, lives until end())
 *   sfxAt(name, pos, opt)       a named sfx at a place (opt.kind, default by name; opt.gain); sfx(name) stays centred
 *   engineSound(..).set(rpm, {pos, sk})   sk: the engine's kind (default "own": your own vehicle, the listener's own reach)
 *   noiseLoop(freq, q, sk) / ambientLoop(freq, q, sk) -> {set(gain, fq, pos), stop()}
 *   loop(name, sk) -> {set(level 0..1, {pos, speed, rate, fq}), stop(), alive()}: a named loop (LOOPS: siren, rain,
 *                                  hum, fountain, water, tram-run, train-run, works, jet-roar), silent HOLD s after its last
 *                                  set() and stopped soon after (it can never leak); the next set() starts it again
 *   pool(kind, o) -> {update(sources), stop()}: the nearest o.voices (default the kind's) of sources [{id, x, y, z}]
 *                                  within max play; a playing one keeps its voice unless another is 15% nearer, ties
 *                                  by id. The kind's voices are shared by every pool of it (the City's traffic and
 *                                  the cab coming to you, each rail line's trains): the nearest of all their sources
 *                                  win, each pool's own o.voices at most (share, below). o.make(src) -> a handle
 *                                  (made once, reused: same id, else same o.key(src), default src.kind);
 *                                  o.play(handle, src, hear(kind, src)) each update; a dropped handle falls silent by
 *                                  its own dead man's switch and is stopped after o.idle s (default 2), and a pool
 *                                  nothing updates for STALE s lets all its handles go (listener()). No listener,
 *                                  volume 0 or (an ambient kind) Ambient sounds at 0%: nothing plays. update() keeps
 *                                  the nearest in a few fixed slots (slot()): nothing is sorted or made per source.
 * One-shot limit per kind: under it a one-shot plays; at it, only if nearer than the farthest live one, which fades
 * out in 50 ms. Test seam: spatial.{KINDS, falloff, panOf, pick, hear, state()}; the pure ones need no AudioContext.
 */
var KINDS = {
  own:          {ref: 12,  max: 400,  roll: 1,   voices: 0, bus: "master", pan: 0.25},   // your vehicle, your avatar
  vehicle:      {ref: 5,   max: 120,  roll: 1,   voices: 6, bus: "engine"},                // NPC cars, the cab coming to you
  peer:         {ref: 5,   max: 150,  roll: 1,   voices: 3, bus: "engine"},                // other players' vehicles
  bus:          {ref: 6,   max: 180,  roll: 1,   voices: 3, bus: "engine"},
  tram:         {ref: 6,   max: 200,  roll: 1,   voices: 3, bus: "engine"},
  siren:        {ref: 10,  max: 600,  roll: 0.7, voices: 2, bus: "master"},
  train:        {ref: 12,  max: 400,  roll: 1,   voices: 2, bus: "master"},                // City Line, Island Link
  metro:        {ref: 10,  max: 250,  roll: 1,   voices: 2, bus: "master"},
  boat:         {ref: 12,  max: 400,  roll: 1,   voices: 3, bus: "master"},                // water bus, taxi, ferries, ships
  horn:         {ref: 30,  max: 1500, roll: 0.6, voices: 2, bus: "master"},                // ship and ferry horns
  heli:         {ref: 15,  max: 1500, roll: 0.8, voices: 2, bus: "engine"},
  plane:        {ref: 40,  max: 2500, roll: 0.7, voices: 2, bus: "ambient"},               // scenic airliners, airport stands
  peerplane:    {ref: 40,  max: 2500, roll: 0.7, voices: 1, bus: "engine"},                // other players' planes: people, not ambience
  jet:          {ref: 60,  max: 1500, roll: 0.8, voices: 2, bus: "ambient", sos: true},    // the air base's jets
  door:         {ref: 2,   max: 40,   roll: 1,   voices: 4, bus: "master"},                // doors, gangways, validators, lifts
  bell:         {ref: 5,   max: 250,  roll: 1,   voices: 3, bus: "master"},                // tram, lift and bike bells
  civicbell:    {ref: 30,  max: 900,  roll: 0.6, voices: 2, bus: "ambient"},               // clock and bell towers
  gondola:      {ref: 6,   max: 120,  roll: 1,   voices: 2, bus: "master"},
  construction: {ref: 10,  max: 200,  roll: 1,   voices: 2, bus: "ambient"},               // roadworks (3.35: an ambient bed)
  fountain:     {ref: 4,   max: 70,   roll: 1,   voices: 2, bus: "ambient"},
  water:        {ref: 4,   max: 60,   roll: 1,   voices: 2, bus: "ambient"},               // lapping at piers, surf
  rain:         {ref: 1,   max: Infinity, roll: 0, voices: 2, bus: "ambient", pan: 0},      // a bed round the camera
  hum:          {ref: 40,  max: 800,  roll: 0.5, voices: 2, bus: "ambient"},               // the city's hum, lobby ambience
  thunder:      {ref: 100, max: 1000, roll: 0.7, voices: 3, bus: "ambient", sos: true, curve: false},
  firework:     {ref: 40,  max: 1000, roll: 0.8, voices: 6, bus: "ambient", sos: true, curve: false},
  blast:        {ref: 10,  max: 400,  roll: 1,   voices: 4, bus: "master", sos: true, curve: false},
  ui:           {ref: 1,   max: Infinity, roll: 0, voices: 0, bus: "master", pan: 0}       // never positional
};
var GENERIC = {ref: 5, max: 150, roll: 1, voices: 3, bus: "master"};   // a kind the table does not know
var HOLD = 0.6;                   // s: a named loop falls silent this long after its last set()
var SP = {L: null, live: {}, pools: [], n: 0};
function kindOf(k){ return typeof k === "string" && Object.prototype.hasOwnProperty.call(KINDS, k) ? KINDS[k] : GENERIC; }
// the source relative to the ears, into REL (a scratch: read it at once); false when pos is not a position
var REL = {dx: 0, dy: 0, dz: 0, d: 0};
function rel(L, p){
  if(!L || !p) return false;
  var x, y, z;
  if(Array.isArray(p)){ x = +p[0]; y = p[1]; z = +p[2]; } else { x = +p.x; y = p.y; z = +p.z; }
  y = y != null ? +y : L.y;
  if(!(isFinite(x) && isFinite(y) && isFinite(z))) return false;
  REL.dx = x - L.x; REL.dy = y - L.y; REL.dz = z - L.z; REL.d = Math.sqrt(REL.dx*REL.dx + REL.dy*REL.dy + REL.dz*REL.dz);
  return true;
}
// no ears: every pool lets its voices go now (no update would park them while nothing draws), made again on its next
// update under a listener
function poolsRest(){ SP.pools.forEach(function(P){ try { P.rest(); } catch(e){} }); }
// A pool its owner no longer updates (a floor you left: the City's airport stands, its ferries and trains; a module that
// stopped drawing) still holds its handles: silent by their own dead man's switches, but running. Each listener() lets
// them go once nothing has updated the pool for STALE s (its next update makes them again).
var STALE = 2;
function poolsStale(t){
  for(var i = 0; i < SP.pools.length; i++){ var P = SP.pools[i]; if(P.held && !(t - P.seen <= STALE)){ try { P.rest(); } catch(e){} } }
}
function listener(cam, at, own){
  if(!cam){ SP.L = null; poolsRest(); return null; }
  var x, y, z, rx, rz, m = cam.matrixWorld && cam.matrixWorld.elements;
  if(m && m.length >= 16){
    if(typeof cam.updateMatrixWorld === "function"){ try { cam.updateMatrixWorld(); } catch(e){} m = cam.matrixWorld.elements; }
    x = m[12]; y = m[13]; z = m[14]; rx = m[0]; rz = m[2];
    if(!(rx*rx + rz*rz > 1e-8)){ rx = m[10]; rz = -m[8]; }           // rolled on its side: right from the forward
  } else {
    var yaw = +cam.yaw || 0;
    x = +cam.x; y = cam.y != null ? +cam.y : 0; z = +cam.z; rx = -Math.cos(yaw); rz = Math.sin(yaw);
  }
  if(at){ x = +at.x; z = +at.z; if(at.y != null) y = +at.y; }
  if(!(isFinite(x) && isFinite(z))){ SP.L = null; poolsRest(); return null; }
  if(!isFinite(y)) y = 0;
  var rl = Math.sqrt(rx*rx + rz*rz); if(rl > 1e-6){ rx /= rl; rz /= rl; } else { rx = 1; rz = 0; }
  var L = SP.L || (SP.L = {});
  L.x = x; L.y = y; L.z = z; L.rx = rx; L.rz = rz; L.fx = rz; L.fz = -rx;   // forward = up x right, on the ground
  L.own = +own > 0 ? +own : null;                                            // how far your own things carry (null: the kind's)
  poolsStale(now());
  return L;
}
function listenerAt(){ var L = SP.L; return L ? {x: L.x, y: L.y, z: L.z, rx: L.rx, rz: L.rz, fx: L.fx, fz: L.fz, own: L.own} : null; }
// pure: the distance fade of a kind (spec: a KINDS entry or a kind's name)
function falloff(spec, d){
  if(typeof spec === "string") spec = kindOf(spec);
  spec = spec || GENERIC; d = +d;
  if(d !== d) return 0;
  var ref = Math.max(0, +spec.ref || 0), max = spec.max != null ? +spec.max : Infinity, roll = Math.max(0, +spec.roll || 0);
  if(d <= ref) return 1;
  if(!(d < max)) return 0;
  var u = (d - ref)/(max - ref);
  return (roll > 0 ? ref/(ref + roll*(d - ref)) : 1)*(1 - u*u);
}
// pure: the pan of a source at pos for listener L (listenerAt()'s shape, or {x, y, z, yaw})
function panOf(L, pos, ref){
  if(L && L.rx == null && L.yaw != null){ var yw = +L.yaw || 0; L = {x: +L.x, y: L.y != null ? +L.y : 0, z: +L.z, rx: -Math.cos(yw), rz: Math.sin(yw)}; }
  if(!L || !rel(L, pos) || !(REL.d > 1e-6)) return 0;
  var r = +ref > 0 ? +ref : 1, s = clamp((REL.dx*L.rx + REL.dz*L.rz)/REL.d, -1, 1);
  return s*Math.min(1, REL.d/r)*0.85;
}
// The nearest few without a sort: slots(cap) holds up to cap entries, best first (B.n of them), each a score s, an id and
// a tie-break k with payloads a and b; slot() puts one in its place (lowest score first, ties by id, then by k), the
// worst one dropping out when all cap are taken, or drops it when every slot holds a better one. O(cap) an entry.
function slots(cap){ return {n: 0, cap: cap, s: [], id: [], k: [], a: [], b: []}; }
function worse(B, j, s, id, k){ var q = B.s[j]; return q > s || (q === s && (B.id[j] > id || (B.id[j] === id && B.k[j] > k))); }
function slot(B, s, id, k, a, b){
  var i = B.n;
  if(i >= B.cap){ if(!(i > 0 && worse(B, i - 1, s, id, k))) return; i--; }
  else B.n = i + 1;
  for(; i > 0 && worse(B, i - 1, s, id, k); i--){ B.s[i] = B.s[i - 1]; B.id[i] = B.id[i - 1]; B.k[i] = B.k[i - 1]; B.a[i] = B.a[i - 1]; B.b[i] = B.b[i - 1]; }
  B.s[i] = s; B.id[i] = id; B.k[i] = k; B.a[i] = a; B.b[i] = b;
}
// pure: the nearest n of list [{id, d}] within max; an id in keep (an array or a map of playing ids) keeps its place
// unless another is 15% nearer; ties by id. Returns the chosen entries, nearest first.
function pick(list, n, max, keep){
  n = n == null ? Infinity : Math.max(0, Math.floor(+n) || 0);
  max = max != null ? +max : Infinity;
  var K = Object.create(null), arr = Array.isArray(list) ? list : [], B = slots(Math.min(n, arr.length));
  if(Array.isArray(keep)) keep.forEach(function(id){ K[String(id)] = 1; });
  else if(keep) for(var k in keep) if(Object.prototype.hasOwnProperty.call(keep, k)) K[k] = 1;
  arr.forEach(function(e){
    if(!e || e.id == null) return;
    var d = +e.d, id = String(e.id);
    if(d < max) slot(B, K[id] ? d*0.85 : d, id, 0, e, null);
  });
  return B.a.slice(0, B.n);
}
// a source's own reference distance past its kind's (opt.ref, m; your own things: the listener's own): full volume within
// it, then the kind's fade, its max moved out by as much
function reach(spec, ref){ ref = +ref; return ref > spec.ref ? {ref: ref, max: spec.max + (ref - spec.ref), roll: spec.roll} : spec; }
function hear(kind, pos, opt){
  opt = opt || {};
  var spec = kindOf(kind), lvl = opt.gain != null ? clamp(+opt.gain || 0, 0, 4) : 1, L = SP.L;
  if(kind === "ui" || !pos || !L) return {g: lvl, pan: 0, d: 0};
  if(!rel(L, pos)) return null;
  var d = REL.d, F = opt.ref != null ? reach(spec, opt.ref) : kind === "own" && L.own ? reach(spec, L.own) : spec;
  if(!(d < F.max)) return null;
  var own = opt.curve === false || (opt.curve == null && spec.curve === false);
  return {g: own ? lvl : lvl*falloff(F, d), pan: panOf(L, pos, spec.ref)*(spec.pan != null ? spec.pan : 1), d: d};
}
function busOf(a, spec){ return spec.bus === "ambient" ? (SND.amb || SND.master) : spec.bus === "engine" ? engineBus(a).out : SND.master; }
function prune(kind, t){ var L = SP.live[kind] || (SP.live[kind] = []); for(var i = L.length - 1; i >= 0; i--) if(L[i].until <= t) L.splice(i, 1); return L; }
function quiet(e, t){        // a voice out in 50 ms (a stolen one-shot, a replaced repeat)
  try { if(e.g.gain.cancelScheduledValues) e.g.gain.cancelScheduledValues(t); e.g.gain.setTargetAtTime(0, t, 0.0125); } catch(err){}
  e.until = t;
}
function spatialOut(kind, pos, opt){
  opt = opt || {};
  var spec = kindOf(kind), hold = !!opt.hold;
  if(sfxVolume() <= 0 || (spec.bus === "ambient" && ambientVolume() <= 0)) return null;
  var a = audio(); if(!a || a.state !== "running") return null;           // (held ones too: their callers try again)
  var h = hear(kind, pos, opt); if(!h) return null;
  var t = a.currentTime, lvl = opt.gain != null ? clamp(+opt.gain || 0, 0, 4) : 1;
  var delay = hold ? 0 : opt.delay === true ? h.d/343 : typeof opt.delay === "number" ? Math.max(0, opt.delay) || 0 : opt.delay == null && spec.sos ? h.d/343 : 0;
  var key = opt.key != null ? String(opt.key) : null, live = null;
  if(!hold){
    live = prune(kind, t);
    if(key !== null) for(var i = 0; i < live.length; i++) if(live[i].key === key){ quiet(live[i], t); live.splice(i, 1); break; }
    var N = opt.voices != null ? Math.max(0, opt.voices | 0) : spec.voices;
    if(N > 0 && live.length >= N){
      var far = 0; for(var j = 1; j < live.length; j++) if(live[j].d > live[far].d || (live[j].d === live[far].d && live[j].n < live[far].n)) far = j;
      if(!(h.d < live[far].d)) return null;                // every voice of the kind is nearer: not heard
      quiet(live[far], t); live.splice(far, 1);            // the farthest gives its voice up
    }
  }
  var g = a.createGain(), p = a.createStereoPanner ? a.createStereoPanner() : null;
  g.gain.value = h.g; if(p) p.pan.value = h.pan;
  var bus = busOf(a, spec); if(p){ g.connect(p); p.connect(bus); } else g.connect(bus);
  var dur = opt.dur != null ? Math.max(0, +opt.dur || 0) : 2;
  var e = {n: ++SP.n, key: key, d: h.d, until: hold ? Infinity : t + delay + dur, g: g};
  if(!hold) live.push(e);
  var V = {ctx: a, out: g, d: h.d, delay: delay,
    move: function(np, ng){                                // a moving source (or a new level for your own curve)
      if(ng != null) lvl = clamp(+ng || 0, 0, 4);
      var h2 = hear(kind, np, {gain: lvl, curve: opt.curve}), n = a.currentTime;
      if(!h2){ g.gain.setTargetAtTime(0, n, 0.05); e.d = V.d = Infinity; return false; }
      g.gain.setTargetAtTime(h2.g, n, 0.05); if(p) p.pan.setTargetAtTime(h2.pan, n, 0.05);
      e.d = V.d = h2.d; return true;
    },
    end: function(sec){                                    // it ends sec s from now (a 50 ms fade); frees its voice
      var n = a.currentTime + Math.max(0, +sec || 0);
      try { g.gain.setTargetAtTime(0, n, 0.0125); } catch(err){}
      e.until = Math.min(e.until, n + 0.06);
    }};
  return V;
}
function sfxAt(name, pos, opt){
  opt = opt || {};
  var kind = opt.kind || SFX_KIND[name] || "own";
  if(!pos || kind === "ui"){ sfx(name, opt); return sfxVolume() > 0 && !!SFX[name]; }
  if(sfxVolume() <= 0 || !SFX[name]) return false;
  var V = spatialOut(kind, pos, {gain: opt.gain, curve: opt.curve, delay: opt.delay, key: opt.key, dur: SFX_DUR[name] || 0.4});
  if(!V) return false;
  DEST = V.out; OFF = V.delay;
  try { SFX[name](V.ctx, opt); } catch(e){}
  DEST = null; OFF = 0;
  return true;
}
// the named loops: make(ctx, out) wires its sources into out (the voice's level gain) and returns {nodes, set(opt, t, hear)}
function noiseSrc(a){ var s = a.createBufferSource(); s.buffer = engineBus(a).noise; s.loop = true; s.start(); return s; }
function lband(a, src, type, hz, q, gain, into){
  var f = a.createBiquadFilter(), g = a.createGain();
  f.type = type; f.frequency.value = hz; f.Q.value = q; g.gain.value = gain;
  src.connect(f); f.connect(g); g.connect(into); return {f: f, g: g};
}
function losc(a, type, hz, gain, into){
  var o = a.createOscillator(), g = a.createGain(); o.type = type; o.frequency.value = hz; g.gain.value = gain;
  o.connect(g); g.connect(into); o.start(); return {o: o, g: g};
}
function lwob(a, hz, depth, g){        // a slow wobble on a gain: waves, a fountain's splash, the wheels' rhythm
  var o = a.createOscillator(), d = a.createGain(); o.type = "sine"; o.frequency.value = hz; d.gain.value = depth;
  o.connect(d); d.connect(g.gain); o.start(); return o;
}
function rateOf(opt){ var r = +opt.rate; return r > 0 ? clamp(r, 0.5, 2) : 1; }    // Doppler: every pitch times rate
var LOOPS = {
  // an emergency run's two-tone siren (hi-lo, ~0.55 s a tone)
  siren: {sk: "siren", gain: 0.06, make: function(a, out){
    var o = a.createOscillator(), f = a.createBiquadFilter(), lf = a.createOscillator(), ld = a.createGain();
    o.type = "square"; o.frequency.value = 860; f.type = "lowpass"; f.frequency.value = 2200; f.Q.value = 0.7;
    lf.type = "square"; lf.frequency.value = 0.9; ld.gain.value = 95;
    lf.connect(ld); ld.connect(o.frequency); o.connect(f); f.connect(out); o.start(); lf.start();
    return {nodes: [o, lf], set: function(opt, t){ var r = rateOf(opt); post(o.frequency, 860*r, t, 0.05, 0.003); post(ld.gain, 95*r, t, 0.05); }};
  }},
  // rain on the ground round you: a hiss and its sparkle
  rain: {sk: "rain", gain: 0.12, make: function(a, out){
    var s = noiseSrc(a); lband(a, s, "bandpass", 2600, 0.35, 1, out); lband(a, s, "highpass", 5200, 0.5, 0.25, out);
    return {nodes: [s]};
  }},
  // a busy district's hum: traffic far off, a mains drone
  hum: {sk: "hum", gain: 0.08, make: function(a, out){
    var s = noiseSrc(a), m = losc(a, "sine", 100, 0.1, out); lband(a, s, "lowpass", 210, 0.7, 1, out); lband(a, s, "bandpass", 900, 0.5, 0.12, out);
    return {nodes: [s, m.o]};
  }},
  // a fountain: falling water, splashing in a slow rhythm
  fountain: {sk: "fountain", gain: 0.1, make: function(a, out){
    var s = noiseSrc(a), b = lband(a, s, "bandpass", 1700, 0.6, 0.8, out), w = lwob(a, 0.55, 0.25, b.g); lband(a, s, "highpass", 4200, 0.4, 0.3, out);
    return {nodes: [s, w]};
  }},
  // water lapping at a pier or a shore, wave by wave
  water: {sk: "water", gain: 0.12, make: function(a, out){
    var s = noiseSrc(a), b = lband(a, s, "lowpass", 420, 0.5, 0.7, out), w = lwob(a, 0.22, 0.45, b.g);
    return {nodes: [s, w]};
  }},
  // a tram running: the traction motor's whine with the speed (m/s), the wheels' rumble
  "tram-run": {sk: "tram", gain: 0.08, make: function(a, out){
    var s = noiseSrc(a), r = lband(a, s, "lowpass", 150, 0.7, 0.4, out), m = losc(a, "triangle", 220, 0.25, out);
    return {nodes: [s, m.o], set: function(opt, t){
      var v = clamp(+opt.speed || 0, 0, 30);
      post(m.o.frequency, (180 + v*24)*rateOf(opt), t, 0.2, 0.003); post(m.g.gain, 0.05 + 0.25*Math.min(1, v/12), t, 0.2);
      post(r.g.gain, 0.15 + 0.6*Math.min(1, v/15), t, 0.2);
    }};
  }},
  // a train running: the rumble, the wheels over the joints quickening with the speed (m/s), the motors' drone
  "train-run": {sk: "train", gain: 0.12, make: function(a, out){
    var s = noiseSrc(a), r = lband(a, s, "lowpass", 120, 0.8, 0.6, out), c = lband(a, s, "bandpass", 700, 1.2, 0.12, out);
    var w = lwob(a, 2, 0.1, c.g), m = losc(a, "sawtooth", 55, 0.08, out);
    return {nodes: [s, w, m.o], set: function(opt, t){
      var v = clamp(+opt.speed || 0, 0, 60);
      post(r.g.gain, 0.2 + 0.8*Math.min(1, v/25), t, 0.3); post(w.frequency, 0.5 + v*0.12, t, 0.3);
      post(m.o.frequency, (45 + v*0.8)*rateOf(opt), t, 0.3, 0.003);
    }};
  }},
  // [3.35] roadworks: the compressor's diesel thrum and a breaker's hammering (a burst ~11 times a second, in spells
  // a few seconds long: a slow wobble on its level), all fixed: the same site sounds the same every time
  works: {sk: "construction", gain: 0.1, make: function(a, out){
    var s = noiseSrc(a), m = losc(a, "sawtooth", 46, 0.12, out), h = lband(a, s, "bandpass", 1300, 0.9, 0.35, out);
    lband(a, s, "lowpass", 160, 0.7, 0.5, out);
    var o = a.createOscillator(), d = a.createGain(); o.type = "square"; o.frequency.value = 11; d.gain.value = 0.3;
    o.connect(d); d.connect(h.g.gain); o.start();
    var w = lwob(a, 0.13, 0.2, h.g);
    return {nodes: [s, m.o, o, w]};
  }},
  // a jet's roar: brighter the nearer it is (or opt.fq), its hiss on top
  "jet-roar": {sk: "jet", gain: 0.3, make: function(a, out){
    var s = noiseSrc(a), r = lband(a, s, "bandpass", 320, 0.8, 1, out); lband(a, s, "highpass", 2400, 0.6, 0.15, out);
    return {nodes: [s], set: function(opt, t, h){
      var fq = opt.fq ? +opt.fq : h && h.d ? 220 + 900/(1 + h.d/200) : 0;
      if(fq > 0) post(r.f.frequency, clamp(fq, 60, 4000)*rateOf(opt), t, 0.1);
    }};
  }}
};
function loop(name, sk){
  var D = Object.prototype.hasOwnProperty.call(LOOPS, name) ? LOOPS[name] : null;
  if(!D) return {set: function(){}, stop: function(){}, alive: function(){ return false; }};
  var kind = typeof sk === "string" && Object.prototype.hasOwnProperty.call(KINDS, sk) ? sk : D.sk, spec = KINDS[kind], V = null;
  function build(a){
    var lg = a.createGain(), pn = a.createStereoPanner ? a.createStereoPanner() : null, bus = busOf(a, spec);
    lg.gain.value = 0;
    if(pn){ lg.connect(pn); pn.connect(bus); } else lg.connect(bus);
    var M = D.make(a, lg) || {};
    return {a: a, lg: lg, pn: pn, M: M, nodes: M.nodes || [], stopAt: 0, pan: 0};
  }
  return {
    set: function(level, opt){
      opt = opt || {};
      var on = sfxVolume() > 0 && (spec.bus !== "ambient" || ambientVolume() > 0);
      if(!on && !V) return;
      var a = audio(); if(!a) return;
      var t = a.currentTime;
      if(!V || t >= V.stopAt - 0.02) V = build(a);           // the first set(), or it fell silent and stopped: a fresh voice
      var h = opt.pos ? hear(kind, opt.pos) : null, k = opt.pos && SP.L ? (h ? h.g : 0) : 1, pan = h ? h.pan : 0;
      var g = V.lg.gain, lvl = on ? clamp(+level || 0, 0, 1)*D.gain*k : 0;
      g.cancelScheduledValues(t); g.setTargetAtTime(lvl, t, 0.05); g.setTargetAtTime(0, t + HOLD, 0.08);   // the dead man's switch
      if(V.pn && Math.abs(pan - V.pan) > 0.01){ V.pan = pan; V.pn.pan.setTargetAtTime(pan, t, 0.05); }
      if(V.M.set){ try { V.M.set(opt, t, h); } catch(e){} }
      if(t + HOLD + 0.4 > V.stopAt){                         // a rolling stop: without set() its nodes stop ~1-2 s on
        V.stopAt = t + HOLD + 1.2;
        V.nodes.forEach(function(nd){ try { nd.stop(V.stopAt); } catch(e){} });
      }
    },
    stop: function(){
      if(!V) return;
      var t = V.a.currentTime;
      try { V.lg.gain.cancelScheduledValues(t); V.lg.gain.setTargetAtTime(0, t, 0.05); } catch(e){}
      V.nodes.forEach(function(nd){ try { nd.stop(t + 0.3); } catch(e){} });
      V = null;
    },
    alive: function(){ return !!V && V.a.currentTime < V.stopAt; }
  };
}
// The voices of a kind across all its pools: this pool's own nearest (B, its slots: its own voices at most) and those
// of every other pool of the kind as of its last update (if within FRESH s: a pool nothing updates holds none), nearest
// first with a playing voice's 15% hold, ties by id, then by pool; at most the kind's voices in all -> how many of B's
// sound (B kept to those, in order). The others give up theirs on their own next update, the same frame. With no other
// fresh pool of the kind, B's nearest the kind's count: no pass over the others' entries.
var FRESH = 0.5, SH = slots(0);
function share(me, B, t){
  var n = B.n, i, j, k, P, all = n, cap = kindOf(me.kind).voices;
  me.mn = n; for(i = 0; i < n; i++){ me.ms[i] = B.s[i]; me.mi[i] = B.id[i]; }
  me.at = t;
  if(!(cap > 0)) return n;                                               // ("own", "ui": no limit)
  for(k = 0; k < SP.pools.length; k++){ P = SP.pools[k]; if(P !== me && P.kind === me.kind && t - P.at <= FRESH) all += P.mn; }
  if(all === n) return (B.n = Math.min(n, cap));                         // only mine
  if(all <= cap) return n;
  SH.n = 0; SH.cap = cap;
  for(k = 0; k < SP.pools.length; k++){
    P = SP.pools[k];
    if(P.kind !== me.kind || (P !== me && !(t - P.at <= FRESH))) continue;
    for(i = 0; i < P.mn; i++) slot(SH, P.ms[i], P.mi[i], k, P === me ? i : -1, null);
  }
  for(i = 0, j = 0; i < n; i++){
    var ok = false;
    for(k = 0; k < SH.n && !ok; k++) ok = SH.a[k] === i;
    if(!ok) continue;
    if(j !== i){ B.s[j] = B.s[i]; B.id[j] = B.id[i]; B.k[j] = B.k[i]; B.a[j] = B.a[i]; B.b[j] = B.b[i]; }
    j++;
  }
  return (B.n = j);
}
function pool(kind, o){
  o = o || {};
  var spec = kindOf(kind), N = o.voices != null ? Math.max(0, o.voices | 0) : spec.voices;
  var MAX = o.max != null ? +o.max : spec.max, IDLE = o.idle != null ? Math.max(0, +o.idle || 0) : 2;
  var keyOf = typeof o.key === "function" ? o.key : function(s){ return s.kind != null ? s.kind : ""; };
  var bound = Object.create(null), parked = [], B = slots(N);
  // ms, mi, mn: its nearest as of its last update (share); seen: when update last ran; held: it holds a handle
  var me = {kind: kind, ids: [], mn: 0, ms: [], mi: [], at: -Infinity, seen: -Infinity, held: false, rest: rest};
  SP.pools.push(me);
  function quit(h){ try { if(h && typeof h.stop === "function") h.stop(); } catch(e){} }
  function sweep(t){ for(var i = parked.length - 1; i >= 0; i--) if(t - parked[i].at > IDLE){ quit(parked[i].h); parked.splice(i, 1); } }
  function park(id){ var b = bound[id]; b.id = id; parked.push(b); delete bound[id]; }
  function kept(id, n){ for(var i = 0; i < n; i++) if(B.id[i] === id) return true; return false; }
  // every handle stopped now (listener(null): poolsRest; nothing updating it: poolsStale); the pool stays and makes them
  // again on a later update
  function rest(){
    for(var id in bound) quit(bound[id].h);
    for(var i = 0; i < parked.length; i++) quit(parked[i].h);
    bound = Object.create(null); parked = []; me.ids = []; me.mn = 0; me.at = -Infinity; me.held = false;
  }
  return {
    update: function(sources){
      var t = now(), L = SP.L, list = Array.isArray(sources) ? sources : [], i, id, e;
      me.seen = t;
      if(sfxVolume() <= 0 || !L || (spec.bus === "ambient" && ambientVolume() <= 0)){
        for(id in bound) park(id);
        sweep(t); me.ids = []; me.mn = 0; me.held = parked.length > 0; return [];
      }
      B.n = 0; B.cap = N;
      for(i = 0; i < list.length; i++){
        e = list[i];
        if(!e || e.id == null || !rel(L, e) || !(REL.d < MAX)) continue;
        id = typeof e.id === "string" ? e.id : String(e.id);
        slot(B, bound[id] ? REL.d*0.85 : REL.d, id, 0, e, null);
      }
      var n = share(me, B, t), ids = [];
      for(id in bound) if(!kept(id, n)) park(id);
      for(i = 0; i < n; i++){
        id = B.id[i]; e = B.a[i];
        var b = bound[id];
        if(!b){
          var k = "", j = -1, q;
          try { k = String(keyOf(e)); } catch(err){}
          for(q = 0; q < parked.length && j < 0; q++) if(parked[q].id === id) j = q;
          for(q = 0; q < parked.length && j < 0; q++) if(parked[q].key === k) j = q;
          b = j >= 0 ? parked.splice(j, 1)[0] : {h: null};
          b.key = k; bound[id] = b;
        }
        if(!b.h && typeof o.make === "function"){ try { b.h = o.make(e) || null; } catch(err){ b.h = null; } }   // made once (again if it failed)
        b.at = t;
        if(b.h && typeof o.play === "function"){ try { o.play(b.h, e, hear(kind, e)); } catch(err){} }
        ids.push(id);
      }
      sweep(t);
      me.ids = ids; me.held = n > 0 || parked.length > 0;
      return ids;
    },
    stop: function(){
      rest();
      var i = SP.pools.indexOf(me); if(i >= 0) SP.pools.splice(i, 1);
    }
  };
}
function spatialState(){
  var t = SND.ctx ? SND.ctx.currentTime : 0, live = {}, pools = {};
  Object.keys(SP.live).forEach(function(k){ var L = prune(k, t); if(L.length) live[k] = L.map(function(e){ return {d: e.d, until: e.until, key: e.key}; }); });
  SP.pools.forEach(function(P){ pools[P.kind] = (pools[P.kind] || []).concat(P.ids); });
  return {listener: listenerAt(), live: live, pools: pools};
}
// Settings' Ambient sounds slider: a soft far-off rumble through the ambient volume, to hear the level just set
function ambientPreview(){
  var a = sfxVolume() > 0 && ambientVolume() > 0 ? audio() : null;
  if(!a || a.state !== "running" || !SND.amb) return false;
  DEST = SND.amb; try { noise(a, 1.2, 0.3, 140); noise(a, 0.7, 0.1, 380, 0.06); } catch(e){} DEST = null;
  return true;
}
// Browsers allow audio only after a user gesture: wake it on the first one.
if(typeof window.addEventListener === "function"){
  window.addEventListener("pointerdown", function(){ if(sfxVolume() > 0) audio(true); }, {once: true, capture: true});
  window.addEventListener("keydown", function(){ if(sfxVolume() > 0) audio(true); }, {once: true, capture: true});
}
// A hidden tab draws no frames, so no pool is updated to let its engines go: no ears (every pool's voices stop) until a
// frame sets the listener again
if(typeof document !== "undefined" && document && typeof document.addEventListener === "function"){
  document.addEventListener("visibilitychange", function(){ if(document.hidden) listener(null); });
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
              sfx: sfx, sfxVolume: sfxVolume, sfxSetVolume: sfxSetVolume, engineSound: engineSound, engines: Object.keys(ENGINES), engineProfile: engineProfile, exhausts: Object.keys(EXHAUST), engineHz: engineHz, watchBar: watchBar,
              noiseLoop: noiseLoop, ambientLoop: ambientLoop, ambientOn: ambientOn, ambientSet: ambientSet,
              ambientVolume: ambientVolume, ambientSetVolume: ambientSetVolume, ambientPreview: ambientPreview,
              // spatial sound (above): the listener, positional one-shots, loops and pools, and the test seam
              listener: listener, listenerAt: listenerAt, hear: hear, spatialOut: spatialOut, sfxAt: sfxAt,
              loop: loop, loops: Object.keys(LOOPS), pool: pool,
              spatial: {KINDS: KINDS, falloff: falloff, panOf: panOf, pick: pick, hear: hear, state: spatialState},
              // the shared AudioContext and its master gain (the SFX volume), or null when sound is off:
              // for a game that shapes its own sound (the City's thunder) instead of a named sfx
              audioOut: function(){ var a = sfxVolume() > 0 ? audio() : null; return a && SND.master ? {ctx: a, out: SND.master} : null; },
              liveEngines: function(){ return VOICES.length; }, engineWatch: watchdog,   // the watchdog (tests run it by hand)
              // the same into the ambient volume (SND.amb), or null while Ambient sounds is at 0% or sound is off
              ambientOut: function(){ var a = ambientOn() && sfxVolume() > 0 ? audio() : null; var o = SND.amb || SND.master; return a && o ? {ctx: a, out: o} : null; }};
})();
