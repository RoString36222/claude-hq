"""Sound PR B, transit and rail: buses, trams, the metro, the City Line, the Island Link and the built rail lines
heard where they are (games/hqcoach.js, hqmetro.js, hqcityrail.js, hqrail.js, hqtransit.js).

node runs each view with the vendored three.js against the real games/engine.js and games/hqride.js over a fake
AudioContext (with a StereoPanner), the views' sounds going through hqRide.sfx the way hqtransit.js sends them. It
checks that every sound carries its place and kind: bus and tram doors (silent before: hqRide had no "door" or
"hiss"), air brakes and tram bells at the vehicle, the bell at the tram's leading cab, metro door chimes at the
train, screen doors where they stand, gates at the gate; that a long vehicle sounds from its part nearest the ears;
that each kind's voices stay within its limit; that the metro's motors and tunnel rumble are one pool of held loops
(the nearest two trains, a train in a tunnel heard only below the street) whose nodes all stop by themselves, where
the old timer leaked a loop every half second; that the City Line, Island Link and built lines play the train-run
loop at the nearest moving train (yours too) and take it away on dispose; that nothing is made at sfx volume 0; that
your ride's own door cues (arriving, closing, getting off) play at full level from the seat, window and chase cameras
on a 72 m City Line and Island Link train; and hqtransit.js's wiring (no aliases left, the session's door sounds placed,
the announcer through the master).
Skipped without node. Stdlib only."""
import json
import os
import re
import shutil
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_hqmetro  # noqa: E402  (its metro fixture)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
FIX = os.path.join(ROOT, "tests", "fixtures")

# a fake AudioContext (and a StereoPanner), localStorage, the real engine.js and hqRide; tsfx sends a view's sound the
# way hqtransit.js does (hqRide.sfx into the engine's master) and keeps a copy of every call; E.pool is wrapped so the
# sources each pool is given are kept (POOLS[kind#n])
PRELUDE = r"""
const fs = require('fs'), path = require('path'), url = require('url'), zlib = require('zlib');
const R0 = process.argv[1];
let now = 1000; const store = {hq_sfx: '0.5'}, nodes = [];
function param(v){ const p = {value: v, ev: [],
  setTargetAtTime(x, t, tc){ p.ev.push(['T', x, t, tc]); }, cancelScheduledValues(t){ p.ev = p.ev.filter(e => e[2] < t); },
  setValueAtTime(x, t){ p.ev.push(['V', x, t]); }, exponentialRampToValueAtTime(x, t){ p.ev.push(['E', x, t]); },
  linearRampToValueAtTime(x, t){ p.ev.push(['L', x, t]); }}; return p; }
function node(kind){ const n = {kind, id: nodes.length + 1, out: [], stops: [], connect(d){ n.out.push(d); return d; }, disconnect(){ n.out = []; },
  start(t){ n.started = t == null ? now : t; }, stop(t){ n.stops.push(t == null ? now : t); }, frequency: param(0), detune: param(0), Q: param(0),
  type: '', playbackRate: param(1), setPeriodicWave(){}}; nodes.push(n); return n; }
class AC { constructor(){ this.state = 'running'; this.sampleRate = 8000; this.destination = {kind: 'dest'}; }
  get currentTime(){ return now; } resume(){ return Promise.resolve(); }
  createGain(){ const n = node('gain'); n.gain = param(1); return n; }
  createOscillator(){ return node('osc'); } createBiquadFilter(){ return node('filter'); } createBufferSource(){ return node('src'); }
  createWaveShaper(){ return node('shaper'); } createPeriodicWave(){ return {}; }
  createDynamicsCompressor(){ const n = node('comp'); ['threshold', 'knee', 'ratio', 'attack', 'release'].forEach(k => n[k] = param(0)); return n; }
  createStereoPanner(){ const n = node('pan'); n.pan = param(0); return n; }
  createBuffer(c, n){ const d = new Float32Array(n); return {getChannelData: () => d}; } }
const window = {HQV: {}, matchMedia: () => ({matches: false}), AudioContext: AC};
const document = {documentElement: {classList: {contains: () => false}}};
global.window = window; global.self = window;
global.localStorage = {getItem: k => k in store ? store[k] : null, setItem(k, v){ store[k] = String(v); }, removeItem(k){ delete store[k]; }};
global.performance = {now: () => now*1000};
new Function('window', 'document', fs.readFileSync(path.join(R0, 'games', 'engine.js'), 'utf8'))(window, document);
const load = f => new Function(fs.readFileSync(path.join(R0, 'games', f + '.js'), 'utf8'))();
const H = window.HQV, E = H.engine, S = E.spatial, out = {};
const POOLS = {}, IDS = {}, realPool = E.pool;
let poolN = 0;
E.pool = function(kind, o){ const P = realPool(kind, o), key = kind + '#' + (poolN++), up = P.update;
  P.update = function(list){ POOLS[key] = (list || []).map(s => ({id: s.id, x: s.x, y: s.y, z: s.z, speed: s.speed, under: s.under}));
                             return (IDS[key] = up.call(P, list)); };
  return P; };
const CALLS = [];
function snap(o){ if(!o) return null; const c = {}; Object.keys(o).forEach(k => { const v = o[k]; c[k] = v && typeof v === 'object' ? {x: v.x, y: v.y, z: v.z} : v; }); return c; }
function tsfx(n, o){
  CALLS.push({n, o: snap(o), t: now});
  const A = E.audioOut(); if(!A || !H.hqRide) return null;
  return H.hqRide.sfx(A.ctx, n, Object.assign({dest: A.out}, o || {}));
}
// what each kind has sounding now: its voice count and the farthest one
function liveNow(acc){ const L = S.state().live; Object.keys(L).forEach(k => { const a = acc[k] || (acc[k] = {n: 0, far: 0}); a.n = Math.max(a.n, L[k].length); L[k].forEach(e => { a.far = Math.max(a.far, e.d); }); }); return acc; }
// sources still running long after the last frame: an oscillator or a looping noise with no stop (or one far ahead)
function leaks(end){ return nodes.filter(n => (n.kind === 'osc' || (n.kind === 'src' && n.loop)) && n.started != null && !(n.stops.length && n.stops[n.stops.length - 1] <= end + 3)).length; }
const d2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const g2 = new Proxy({}, {get: (t, k) => k === 'measureText' ? (() => ({width: 10})) : (typeof k === 'string' && /^[a-z]/.test(k) && !['fillStyle', 'font', 'textAlign', 'textBaseline', 'strokeStyle', 'lineWidth', 'lineCap', 'globalAlpha'].includes(k)) ? (() => {}) : t[k], set: (t, k, v) => { t[k] = v; return true; }});
(async function(){
const THREE = await import(url.pathToFileURL(path.join(R0, 'games', 'vendor', 'three-module.js')).href);
const mat = (col, o) => new THREE.MeshStandardMaterial(Object.assign({color: col}, o || {}));
"""

TAIL = r"""
console.log(JSON.stringify(out));
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
"""

COACH = r"""
load('traffic'); load('hqride'); load('hqcoach');
const T = H.traffic, K = H.hqCoach, city = require(path.join(R0, 'tests', 'fixtures', 'traffic_city.js'));
// ---- the pure helpers: a row's centre line and its point nearest the ears ----
const bus = {kind: 'bus', x: 10, y: 2, z: 20, yaw: 0};
const tramA = {kind: 'tram', x: 0, y: 0, z: 0, yaw: Math.PI/2, parts: [{x: 7, y: 0, z: 0, yaw: Math.PI/2}, {x: -7, y: 0.5, z: 0, yaw: Math.PI/2}]};
out.pure = {busLine: K.lineOf(bus), tramLine: K.lineOf(tramA).map(p => [p.x, p.y, p.z]),
  beside: K.nearOn(K.lineOf(bus), {x: 30, z: 23}, 1.2), past: K.nearOn(K.lineOf(bus), {x: 10, z: 90}, 1.2),
  tramMid: K.nearOn(K.lineOf(tramA), {x: -3, z: 9}, 0), tramEnd: K.nearOn(K.lineOf(tramA), {x: -40, z: 0}, 0),
  noParts: K.lineOf({kind: 'tram', x: 1, y: 0, z: 1, yaw: 0}).length, junk: K.nearOn(K.lineOf({}), {x: NaN}, 0)};
// ---- the view: every bus and tram's sounds where they happen ----
const sim = T.create(city(1, 7, true), {tier: 5, seed: 7});
const V = K.view({THREE}, sim, {sfx: tsfx, night: () => false, calm: () => false});
const tram = V.services.tram.vehicles(1e6)[0];
V.focus(tram.id);
const rows = t => ['bus', 'tram'].reduce((a, k) => a.concat(V.services[k].vehicles(t).map(v => Object.assign(v, {kind: k}))), []);
let bad = [], acc = {}, n = 0;
const near = {door: [], bell: [], bus: []};
for (let t = 1e6; t < 1e6 + 900e3; t += 500){
  now = t/1000;
  const me = V.services.tram.vehicles(t).filter(v => v.id === tram.id)[0];
  const cam = {x: me.x + 8, y: 3, z: me.z};
  E.listener({x: cam.x, y: 1.6, z: cam.z, yaw: 0});
  const k0 = CALLS.length;
  V.update(t, 0.5, cam);
  const R = rows(t), ear = E.listenerAt();
  CALLS.slice(k0).forEach(c => {
    n++;
    const o = c.o || {}, p = o.pos;
    if(!p || !isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z)){ bad.push(['no pos', c.n]); return; }
    // on a vehicle's centre line, at the point nearest the ears (the bell: at a tram's leading end)
    if(c.n === 'tram-bell'){
      const f = R.filter(v => v.kind === 'tram').map(v => K.lineOf(v)[0]).sort((a, b) => d2(a, p) - d2(b, p))[0];
      if(!f || d2(f, p) > 1e-6 || Math.abs(p.y - (f.y + 1)) > 1e-6) bad.push(['bell not at a cab', p]);
    } else {
      const best = R.map(v => { const q = K.nearOn(K.lineOf(v), ear, c.n === 'air-brake' ? 0.6 : 1.2); return {q, d: d2(q, p) + Math.abs(q.y - p.y)}; }).sort((a, b) => a.d - b.d)[0];
      if(!best || best.d > 1e-6) bad.push(['not at a vehicle', c.n, p]);
    }
    const want = {door: 'door', hiss: 'door', 'air-brake': 'bus', 'tram-bell': 'bell'}[c.n];
    if(o.kind !== want) bad.push(['kind', c.n, o.kind]);
    const kind = want, dd = Math.hypot(p.x - ear.x, p.y - ear.y, p.z - ear.z);
    if(near[kind]) near[kind].push(dd);
  });
  liveNow(acc);
}
const names = {}; CALLS.forEach(c => { names[c.n] = (names[c.n] || 0) + 1; });
const sb0 = CALLS.length; V.requestStop(tram.id); const sb = CALLS.slice(sb0);
out.view = {n, bad: bad.slice(0, 5), nBad: bad.length, names, live: acc,
  offered: {door: near.door.filter(d => d > 40).length, bell: near.bell.filter(d => d > 40 && d < 250).length},
  stopBell: sb.map(c => [c.n, c.o && c.o.pos ? 'pos' : 'centred']), leaks: leaks(now)};
// ---- volume 0 (Calm's default, mute): nothing is made ----
store.hq_sfx = '0';
const k1 = nodes.length, c1 = CALLS.length;
for (let t = 1e6 + 900e3; t < 1e6 + 1200e3; t += 500){ now = t/1000; const me = V.services.tram.vehicles(t).filter(v => v.id === tram.id)[0]; if(!me) break; E.listener({x: me.x + 8, y: 1.6, z: me.z, yaw: 0}); V.update(t, 0.5, {x: me.x + 8, y: 3, z: me.z}); }
out.muted = {made: nodes.length - k1, calls: CALLS.length - c1};
store.hq_sfx = '0.5';
V.dispose();
"""


METRO = r"""
load('hqride'); load('hqmetro');
const HM = H.hqMetro, doc = __DOC__;
const msim = HM.create(doc, {tier: 5}), scene = new THREE.Scene();
let avatar = null;
const c = {THREE, scene, canvasTex: (w, h, d) => { if(d) d(g2, w, h); return {t: new THREE.Texture(), g: g2}; }, avatar: () => avatar};
const MV = HM.view(c, msim, {calm: () => false, night: () => false, sfx: tsfx});
const Lay = msim.layout(), T0 = Date.UTC(2026, 9, 21, 8, 0, 0);
const poolKey = () => Object.keys(POOLS).filter(k => /^metro#/.test(k))[0];
// a train's centre line as the view should see it: its front end, its cars' middles, its rear end
function lineOf(v){ const P = []; for(let k = 0; k < HM.CARS; k++){ const cp = msim.carPose(v, k); if(cp) P.push(cp); }
  const a = P[0], b = P[P.length - 1], h = HM.CAR_L/2;
  return [{x: a.x + Math.sin(a.yaw)*h, y: a.y, z: a.z + Math.cos(a.yaw)*h}].concat(P, [{x: b.x - Math.sin(b.yaw)*h, y: b.y, z: b.z - Math.cos(b.yaw)*h}]); }
function onTrain(p, ear, vs, dy){ return vs.some(v => { if(v.depot) return false; const q = HM.nearLine(lineOf(v), ear, dy); return Math.hypot(q.x - p.x, q.z - p.z) < 1e-6 && Math.abs(q.y - p.y) < 1e-6; }); }
function check(o, k0, ear, t, acc){
  const vs = msim.vehicles(t);
  CALLS.slice(k0).forEach(c => {
    const p = c.o && c.o.pos, kind = c.o && c.o.kind;
    o.names[c.n] = (o.names[c.n] || 0) + 1;
    if(!p){ o.bad.push(['no pos', c.n]); return; }
    if(c.n === 'validator' && c.o.screenDoors){ o.screen.push([Math.hypot(p.x - ear.x, p.z - ear.z), p.y]); if(kind !== 'door') o.bad.push(['kind', c.n, kind]); return; }
    if(c.n === 'validator'){ o.gate.push(p); return; }
    const want = {'door-chime': 'door', 'door-hiss': 'door', 'rail-joint': 'metro', 'motor': 'metro', 'tunnel-rumble': 'metro'}[c.n];
    if(kind !== want) o.bad.push(['kind', c.n, kind]);
    if(!onTrain(p, ear, vs, 1.5)) o.bad.push(['not at its train', c.n]);
    if(c.n === 'motor' || c.n === 'tunnel-rumble') o.loops.push([c.n, c.o.speed]);
  });
  liveNow(acc);
}
function frame(t, ear, yaw){ now = t/1000; E.listener({x: ear.x, y: ear.y, z: ear.z, yaw: yaw || 0}); const k0 = CALLS.length; MV.update(t, 0.25, ear); return k0; }
function mk(){ return {names: {}, bad: [], screen: [], gate: [], loops: [], ids: 0, played: 0, srcBad: [], under: 0, frames: 0, far: 0, firstFocus: 0, moving: 0, nearFocus: 0}; }
function poolCheck(o, t, ear, wantUnder, focus){
  const ids = S.state().pools.metro || [], src = POOLS[poolKey()] || [], vs = msim.vehicles(t);
  o.frames++; o.ids = Math.max(o.ids, ids.length); if(ids.length) o.played++;
  src.forEach(s => {
    const v = vs.filter(q => q.id === s.id)[0];
    if(!v){ o.srcBad.push(['unknown', s.id]); return; }
    if(!!v.under !== wantUnder && v.id !== focus) o.under++;
    const q = HM.nearLine(lineOf(v), ear, 1.5);
    if(Math.hypot(q.x - s.x, q.z - s.z) > 1e-6 || Math.abs(q.y - s.y) > 1e-6) o.srcBad.push(['not its nearest point', s.id]);
  });
  ids.forEach(id => { const s = src.filter(q => q.id === id)[0]; if(s) o.far = Math.max(o.far, Math.hypot(s.x - ear.x, s.y - ear.y, s.z - ear.z)); });
  if(focus){ const v = vs.filter(q => q.id === focus)[0]; if(v && v.speed > 0.5){ o.moving++; if(ids[0] === focus) o.firstFocus++;
    const s = src.filter(q => q.id === focus)[0]; if(s && Math.hypot(s.x - ear.x, s.z - ear.z) < 3) o.nearFocus++; } }
}
// ---- 1: on a platform below the street for five minutes ----
MV.underground(true);
const st0 = Lay.byId['metro:0'], p0 = st0.plats[0];
avatar = {x: p0.r.cx, z: p0.r.cz, hy: p0.y0};
const ear0 = {x: avatar.x, y: p0.y0 + 1.6, z: avatar.z};
const plat = mk(), accP = {};
for (let t = T0; t < T0 + 300e3; t += 250){ const k0 = frame(t, ear0, p0.r.yaw); check(plat, k0, ear0, t, accP); poolCheck(plat, t, ear0, true, null); }
plat.live = accP; plat.leaks = leaks(now); plat.platY = p0.y0;
out.platform = plat;
// ---- 2: the walker at a gate line: one beep, at the gate ----
const cst = Lay.byId['metro:1'];
const gate = (() => { const h = cst.hall, s = Math.sin(h.yaw), co = Math.cos(h.yaw); return {x: h.cx + s*10 + co*0.55*1 - co*4.4 + co*0.55, z: h.cz + co*10 - s*(-4.4 + 0.55)}; })();
avatar = {x: gate.x, z: gate.z, hy: cst.hallY};
const gk = CALLS.length, gearE = {x: gate.x, y: cst.hallY + 1.6, z: gate.z}, gm = mk();
check(gm, frame(T0 + 301e3, gearE, cst.hall.yaw), gearE, T0 + 301e3, {});
out.gate = {gate: gm.gate.map(p => [Math.hypot(p.x - gate.x, p.z - gate.z), p.y - cst.hallY])};
// ---- 3: riding a train (the one you ride is always heard, from your car) ----
const tr = msim.trip('M1', 'metro:0', 'metro:2', T0 + 350e3); MV.focus(tr.vehicle);
const ride = mk(), accR = {};
for (let t = tr.arrive - 8000; t < tr.depart + 60000; t += 250){ const P = tr.pose(t), ear = {x: P.x, y: P.y + 1.5, z: P.z}; avatar = {x: P.x, z: P.z, hy: P.y};
  const k0 = frame(t, ear, P.yaw); check(ride, k0, ear, t, accR); poolCheck(ride, t, ear, true, tr.vehicle); }
ride.live = accR; out.ride = ride;
MV.focus(null);
// ---- 4: on the street over Central: trains in the tunnel are not heard through the ground ----
MV.underground(false);
const top = mk(), earT = {x: cst.x, y: 3.5, z: cst.z};
const T4 = tr.depart + 70000;
for (let t = T4; t < T4 + 120e3; t += 250){ const k0 = frame(t, earT, 0); check(top, k0, earT, t, {}); poolCheck(top, t, earT, false, null); }
out.street = top;
// ---- 5: volume 0, then gone with the view ----
MV.underground(true); avatar = {x: p0.r.cx, z: p0.r.cz, hy: p0.y0};
store.hq_sfx = '0';
const k5 = nodes.length, mute = mk();
for (let t = T4 + 120e3; t < T4 + 180e3; t += 250){ frame(t, ear0, p0.r.yaw); poolCheck(mute, t, ear0, true, null); }
out.muted = {made: nodes.length - k5, played: mute.played};
store.hq_sfx = '0.5';
for (let t = T4 + 180e3; t < T4 + 200e3; t += 250) frame(t, ear0, p0.r.yaw);
out.before = (S.state().pools.metro || []).length;
MV.dispose();
out.after = S.state().pools.metro || null;
now += 10;
out.leaksEnd = leaks(now);
"""


RAIL = r"""
load('world'); load('hqride'); load('hqcommute'); load('hqrail'); load('hqcityrail');
const WD = H.world, RL = H.hqRail, CR = H.hqCityRail, PT = RL.parts;
const W = WD.pack(JSON.parse(fs.readFileSync(path.join(R0, 'tests', 'fixtures', 'world_v3_tiny.json'))));
const scene = new THREE.Scene(), c = {THREE, scene, mat}, ground = (x, z) => WD.groundAt(W, x, z);
// ---- the pure helper: a train's part nearest the ears ----
const cars = [0, 1, 2, 3].map(k => ({x: 0, y: 10, z: -(k*(RL.CAR_L + RL.CAR_GAP)) - RL.CAR_L/2, yaw: 0}));   // heading +z, its nose at z = 0
out.pure = {side: PT.nearOn(cars, {x: 20, z: -30}, 1.5), ahead: PT.nearOn(cars, {x: 3, z: 50}, 0), behind: PT.nearOn(cars, {x: 0, z: -500}, 0),
            none: PT.nearOn([], {x: 0, z: 0}, 0), tail: -(3*(RL.CAR_L + RL.CAR_GAP)) - RL.CAR_L, ear: PT.earAt({x: 4, y: 1, z: 5})};
E.listener({x: 9, y: 8, z: 7, yaw: 0}); out.pure.earL = PT.earAt({x: 4, y: 1, z: 5}); E.listener(null);
// ---- the City Line and the Island Link in one City ----
const cl = CR.create(W, {seed: 's'}), vc = CR.view(c, cl, {W, ground, night: () => false});
const ISL = 'user:aaaaaaaa-0000-4000-8000-000000000001@3';
const ls = RL.linkService({here: ISL, W, arch: {commons: {x: 0, z: 0}, islands: [{world: ISL, x: 300000, z: -250000}]}});
let under = false;
const vl = RL.linkView(c, ls, {seaY: 0, under: () => under});
const keyOf = n => Object.keys(POOLS).filter(k => /^train#/.test(k))[n];     // the City Line's pool, then the Island Link's
function mk(){ return {frames: 0, ids: 0, bad: [], src: 0, moving: 0, played: 0, nearest: 0, total: 0, tunnel: 0}; }
function trainCheck(o, key, ear, list, carsOf, tunnelOf){
  const src = POOLS[key] || [], ids = IDS[key] || [];
  o.frames++; o.ids = Math.max(o.ids, ids.length); o.total = Math.max(o.total, (S.state().pools.train || []).length);
  src.forEach(s => {
    o.src++;
    const v = list.filter(q => q.id === s.id)[0];
    if(!v){ o.bad.push(['unknown', s.id]); return; }
    if(!(v.speed > 0.5)) o.bad.push(['standing', s.id]);
    if(tunnelOf && tunnelOf(v) !== under) o.tunnel++;
    const q = PT.nearOn(carsOf(v), ear, 1.5, RL.CAR_L);
    if(Math.hypot(q.x - s.x, q.z - s.z) > 1e-6 || Math.abs(q.y - s.y) > 1e-6) o.bad.push(['not its nearest point', s.id]);
  });
  const cand = src.map(s => ({id: s.id, d: Math.hypot(s.x - ear.x, s.y - ear.y, s.z - ear.z)})).filter(e => e.d < 400).sort((a, b) => a.d - b.d);
  if(cand.length){ o.played++; if(ids[0] === cand[0].id) o.nearest++; }
}
const ms = 1.7e12, st = cl.stops()[0], earC = {x: st.x, y: st.y + 1.6, z: st.z};
const cla = mk(), n0 = nodes.length;
for (let t = ms; t < ms + 600e3; t += 250){
  now = t/1000; E.listener({x: earC.x, y: earC.y, z: earC.z, yaw: 0});
  vc.update(t, 0.25, earC); vl.update(t, 0.25, earC);
  const vs = cl.vehicles(t);
  trainCheck(cla, keyOf(0), earC, vs, v => v.cars, null);
  vs.forEach(v => { if(v.speed > 0.5 && Math.hypot(v.x - earC.x, v.z - earC.z) < PT.SND_R){ cla.moving++; if(!(POOLS[keyOf(0)] || []).some(s => s.id === v.id)) cla.bad.push(['not offered', v.id]); } });
}
cla.leaks = leaks(now); cla.made = nodes.length - n0;
out.cityLine = cla;
// the Island Link: beside its viaduct, then below the street in its tunnel
const L0 = ls.lines()[0], R = ls.route(L0.id, 'out'), o = ls.origin(), pa = RL.at(R, 700);
const earI = {x: pa.x - o.x + 15*Math.cos(pa.yaw), y: pa.y + 1.6, z: pa.z - o.z - 15*Math.sin(pa.yaw)};
const ilCars = v => PT.carsOf(ls.route(v.line, v.dir), v.along, o), ilTun = v => RL.underAt(ls.route(v.line, v.dir), v.along - RL.TRAIN_L/2);
const ila = mk();
for (let t = ms + 600e3; t < ms + 1500e3; t += 250){
  now = t/1000; E.listener({x: earI.x, y: earI.y, z: earI.z, yaw: 0});
  vc.update(t, 0.25, earI); vl.update(t, 0.25, earI);
  trainCheck(ila, keyOf(1), earI, ls.vehicles(t), ilCars, ilTun);
}
out.link = ila;
under = true;
const pt = RL.at(R, 150), earU = {x: pt.x - o.x, y: pt.y + 1.6, z: pt.z - o.z}, ilu = mk();
for (let t = ms + 1500e3; t < ms + 2400e3; t += 250){
  now = t/1000; E.listener({x: earU.x, y: earU.y, z: earU.z, yaw: 0});
  vl.update(t, 0.25, earU);
  trainCheck(ilu, keyOf(1), earU, ls.vehicles(t), ilCars, ilTun);
}
out.tunnel = ilu;
// volume 0, then both views gone
store.hq_sfx = '0';
const k5 = nodes.length;
for (let t = ms + 2400e3; t < ms + 2520e3; t += 250){ now = t/1000; E.listener({x: earC.x, y: earC.y, z: earC.z, yaw: 0}); vc.update(t, 0.25, earC); vl.update(t, 0.25, earC); }
out.muted = {made: nodes.length - k5, ids: (IDS[keyOf(0)] || []).length + (IDS[keyOf(1)] || []).length};
store.hq_sfx = '0.5';
vc.dispose(); out.afterCL = S.state().pools.train ? S.state().pools.train.length : null;
vl.dispose(); out.after = S.state().pools.train || null;
now += 10; out.leaksEnd = leaks(now);
"""


# your ride's own door cues (hqRide.session: the arrival chime, the doors closing, getting off) on a 72 m City Line and
# Island Link train, through hqRide.sfx and engine.js's spatialOut as hqtransit.js sends them
SESSION = r"""
load('world'); load('hqride'); load('hqcommute'); load('hqrail'); load('hqcityrail');
const WD = H.world, RL = H.hqRail, CR = H.hqCityRail, RD = H.hqRide;
const W = WD.pack(JSON.parse(fs.readFileSync(path.join(R0, 'tests', 'fixtures', 'world_v3_tiny.json'))));
H.hqCommute.occupied = () => ({seats: [], standing: []});   // an empty train: the first window seat, in the front car
// the voice every placed sound gets: its kind and level (null: not heard)
const VO = [], spatialOut = E.spatialOut;
E.spatialOut = function(kind, pos, opt){ const V = spatialOut(kind, pos, opt); VO.push({kind, g: V ? V.out.gain.value : null}); return V; };
// one ride, boarding to getting off: on the platform the ears are where you stand, then the ride camera cam ("seat",
// "window" or "chase"), which rides with you (the listener's own reach Infinity, as hq3d.js gives it while riding)
function ride(trip, cam){
  const k0 = CALLS.length, v0 = VO.length, door = trip.door(trip.arrive), me = {x: door.x, y: trip.pose(trip.arrive).y, z: door.z};
  const S = RD.session({trip, sfx: tsfx, me: () => me, calm: () => false, announce: () => {}});
  let far = 0;
  [trip.arrive - 5000, trip.arrive, trip.arrive + 1500, trip.depart - 3000, trip.reach, trip.reach + 1300].forEach(ms => {
    now = ms/1000;
    const c = S.camPose(ms, {yaw: 0, pitch: 0}, cam), p = trip.pose(ms), i = S.info(ms);
    if(c) E.listener({x: c.pos.x, y: c.pos.y, z: c.pos.z, yaw: Math.atan2(c.look.x - c.pos.x, c.look.z - c.pos.z)}, null, Infinity);
    else E.listener({x: me.x, y: me.y + 1.6, z: me.z, yaw: p.yaw}, null, Infinity);
    if(i.seat != null){ const s = trip.seat(i.seat, ms); far = Math.max(far, Math.hypot(s.x - p.x, s.z - p.z)); }
    S.step(ms);
  });
  return {phase: S.phase, names: CALLS.slice(k0).map(c => c.n), voices: VO.slice(v0), far};
}
const ISL = 'user:aaaaaaaa-0000-4000-8000-000000000001@3', ms = 1.7e12;
const cl = CR.create(W, {seed: 's'}), CL = cl.lines()[0];
const ls = RL.linkService({here: ISL, W, arch: {commons: {x: 0, z: 0}, islands: [{world: ISL, x: 300000, z: -250000}]}}), IL = ls.lines()[0];
['seat', 'window', 'chase'].forEach(cam => {
  out['cityLine:' + cam] = ride(cl.trip(CL.id, CL.stops[0], CL.stops[CL.stops.length - 1], ms), cam);
  out['islandLink:' + cam] = ride(ls.trip(IL.id, IL.stops[0], IL.stops[1], ms), cam);
});
"""


MOUNT = r"""
load('world'); load('hqnav'); load('hqrail');
const WD = H.world, RL = H.hqRail;
const doc = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(R0, 'tests', 'fixtures', f + '.json.gz'))));
const Wc = WD.pack(doc('claude-hq@2')), Wi = WD.pack(doc('island@2')), ISL = 'user:aaaaaaaa-0000-4000-8000-000000000001@3';
WD.load = () => Promise.resolve(Wi);
let NOW = 1.7e12; Date.now = () => NOW;
const scene = new THREE.Scene(), c = {THREE, mat, active: () => true, held: () => false}, w = {scene};
const arch = {commons: {x: 0, z: 0}, islands: [{world: ISL, x: 240000, z: -320000, tier: 3}]};
const M = RL.mount(c, w, {W: Wc, world: 'claude-hq@3', tier: 5, me: 'aaaaaaaa-0000-4000-8000-000000000001', sea: Wc.island.sea_cm/100, night: false,
  here: () => ({x: 0, z: 0}), arch: () => Promise.resolve(arch), get: () => Promise.resolve({cost: 500, min_tier: 2, lines: [{a: 'claude-hq@3', b: ISL}]}),
  post: () => Promise.resolve({ok: true}), say: () => {}, places: () => [{world: ISL, name: 'Isle', x: 2400, z: -3200}],
  ground: (x, z) => WD.groundAt(Wc, x, z), spawnAt: (wid) => ({world: wid, x: 0, z: 0, yaw: 0})});
for (let i = 0; i < 30; i++) await new Promise(r => setTimeout(r, 0));
out.lines = M.tools.lines().map(l => l.to);
const key = Object.keys(POOLS).filter(k => /^train#/.test(k))[0] || 'train#0';
// the line through the frame, every 2 m: its trains run on it both ways (a train's car-to-car line cuts the tight street
// bends by a few metres)
const L = M.tools.lines()[0], along = [];
for (let s = 0; L && s <= L.len; s += 2) along.push(M.tools.at(ISL, s));
const offLine = p => Math.min(...along.map(q => Math.hypot(q.x - p.x, q.z - p.z)));
function mk(){ return {frames: 0, ids: 0, bad: [], src: 0, played: 0, yours: 0, yoursFirst: 0, yoursNear: 0, threw: null}; }
function step(o, ear){
  now = NOW/1000; E.listener({x: ear.x, y: ear.y, z: ear.z, yaw: 0});
  try { M.update(now, 0.25, ear); } catch(e){ o.threw = String(e && e.stack || e); }
  const src = POOLS[key] || [], ids = IDS[key] || [];
  o.frames++; o.ids = Math.max(o.ids, ids.length); if(ids.length) o.played++;
  src.forEach(s => { o.src++; if(!(s.speed > 0.5)) o.bad.push(['standing', s.id]); if(s.id !== 'yours' && offLine(s) > 6) o.bad.push(['off the line', s.id, offLine(s)]); });
  return {src, ids};
}
// ---- 1: beside the line 300 m out of the station, ten minutes of trains ----
const pa = L ? M.tools.at(ISL, 300) : {x: 0, y: 0, z: 0, yaw: 0}, ear1 = {x: pa.x + 12*Math.cos(pa.yaw), y: pa.y + 1.6, z: pa.z - 12*Math.sin(pa.yaw)};
const side = mk();
for (let k = 0; k < 2400; k++){ NOW += 250; step(side, ear1); }
side.leaks = leaks(now);
out.side = side;
// ---- 2: riding: your train, heard from your seat ----
M.tools.board(ISL);
const ride = mk();
for (let k = 0; k < 1200; k++){
  NOW += 250;
  const seat = M.carry() || ear1, ear = {x: seat.x, y: seat.y + 1.2, z: seat.z};
  const r = step(ride, ear), mine = r.src.filter(s => s.id === 'yours')[0];
  if(mine){ ride.yours++; if(Math.hypot(mine.x - ear.x, mine.z - ear.z) < 3) ride.yoursNear++;
    // yours plays, unless an oncoming train (the line's other way, on the same centre line) passing through it holds the
    // voice: nearer, or not yet 15% further (the pool's hysteresis)
    const dOf = q => Math.hypot(q.x - ear.x, q.y - ear.y, q.z - ear.z), first = r.src.filter(s => s.id === r.ids[0])[0];
    if(r.ids[0] === 'yours' || (first && dOf(first)*0.85 <= dOf(mine) + 1e-9)) ride.yoursFirst++; }
}
out.ride = ride;
M.destroy();
out.after = S.state().pools.train || null;
now += 10; out.leaksEnd = leaks(now);
"""


def run(body, timeout=600):
    src = PRELUDE + body + TAIL
    r = subprocess.run([NODE, "-e", src, ROOT], capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise AssertionError("node failed:\n" + r.stderr[-4000:])
    return json.loads(r.stdout.strip().splitlines()[-1])


@unittest.skipUnless(NODE, "node is not installed")
class CoachSounds(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = run(COACH)

    def test_centre_line_and_nearest_point(self):
        p = self.o["pure"]
        self.assertEqual([[q["x"], q["z"]] for q in p["busLine"]], [[10, 26], [10, 14]], "a 12 m bus from its front end to its rear")
        self.assertEqual(len(p["tramLine"]), 4, "a tram: its front end, both sections' middles, its rear end")
        self.assertAlmostEqual(p["tramLine"][0][0], 13.5); self.assertAlmostEqual(p["tramLine"][3][0], -13.5)
        self.assertAlmostEqual(p["beside"]["z"], 23); self.assertAlmostEqual(p["beside"]["x"], 10)
        self.assertAlmostEqual(p["beside"]["y"], 3.2, msg="dy over the road")
        self.assertAlmostEqual(p["past"]["z"], 26, msg="past the front: its front end")
        self.assertAlmostEqual(p["tramMid"]["x"], -3); self.assertAlmostEqual(p["tramMid"]["y"], 0.5*10/14, msg="between the sections' heights")
        self.assertAlmostEqual(p["tramEnd"]["x"], -13.5)
        self.assertEqual(p["noParts"], 2, "a tram without its sections: one straight body")
        self.assertTrue(all(isinstance(p["junk"][k], (int, float)) for k in "xyz"))

    def test_every_sound_at_its_vehicle_with_its_kind(self):
        v = self.o["view"]
        self.assertGreater(v["n"], 20)
        self.assertEqual(v["nBad"], 0, v["bad"])
        for s in ("door", "hiss", "tram-bell"):
            self.assertIn(s, v["names"], "the doors sound now: hqRide has door and hiss")

    def test_reach_and_voices_by_kind(self):
        v = self.o["view"]
        # every bus and tram offers its sounds, not only the three drawn near you: the engine keeps what carries
        self.assertGreater(v["offered"]["door"], 0, "doors further than 40 m are offered too (the engine drops them)")
        live = v["live"]
        self.assertLessEqual(live["door"]["n"], 4)
        self.assertLessEqual(live["door"]["far"], 40, "a door is not heard past 40 m")
        if "bell" in live:
            self.assertLessEqual(live["bell"]["n"], 3)
            self.assertLessEqual(live["bell"]["far"], 250)
        if v["offered"]["bell"]:
            self.assertGreater(live["bell"]["far"], 40, "a tram bell carries further than a door")
        self.assertEqual(v["stopBell"], [["stop-bell", "centred"]], "your stop request: yours, centred")
        self.assertEqual(v["leaks"], 0)

    def test_silent_at_volume_zero(self):
        self.assertEqual(self.o["muted"]["made"], 0, "sfx volume 0 (Calm's default, mute): no nodes at all")


@unittest.skipUnless(NODE, "node is not installed")
class MetroSounds(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = run(METRO.replace("__DOC__", json.dumps(test_hqmetro.metro_fixture())))

    def test_doors_screens_and_joints_where_they_are(self):
        p = self.o["platform"]
        self.assertEqual(p["bad"], [], "every chime and joint at its train's part nearest the ears, with its kind")
        self.assertGreater(p["names"].get("door-chime", 0), 0)
        self.assertGreater(len(p["screen"]), 0, "the screen doors beep as a train opens")
        for d, y in p["screen"]:
            self.assertLess(d, 60, "a screen door on this platform")
            self.assertAlmostEqual(y, p["platY"] + 2.2, 3, "its beeper, over the opening")
        self.assertLessEqual(p["live"]["door"]["n"], 4)
        self.assertLessEqual(p["live"]["door"]["far"], 40)

    def test_one_pool_of_held_loops_no_leak(self):
        p = self.o["platform"]
        self.assertEqual(p["srcBad"], [], "each train offered at its part nearest the ears")
        self.assertEqual(p["under"], 0, "below the street: only trains in the tunnel")
        self.assertLessEqual(p["ids"], 2, "the metro kind's two voices")
        self.assertGreater(p["played"], 0)
        self.assertLess(p["far"], 250, "none past the metro kind's 250 m")
        self.assertEqual(p["leaks"], 0, "every loop's nodes stop by themselves (one-shots too)")
        # a held loop is made when a train gets a voice (or after it stood silent), not on a timer: the old code made a
        # motor every 0.5 s and a rumble every 2.5 s, none ever stopped (hundreds in five minutes)
        self.assertLess(p["names"]["motor"], 20, p["names"])
        self.assertLess(p["names"]["tunnel-rumble"], 20, p["names"])
        for name, speed in p["loops"]:
            self.assertLessEqual(speed, 22.0001, "speed in m/s (hqRide's unit), not a fraction of VMAX")

    def test_the_gate_beeps_at_the_gate(self):
        g = self.o["gate"]["gate"]
        self.assertEqual(len(g), 1)
        self.assertLess(g[0][0], 1.6)
        self.assertAlmostEqual(g[0][1], 1)

    def test_riding_your_train(self):
        r = self.o["ride"]
        self.assertEqual(r["bad"], [])
        self.assertEqual(r["srcBad"], [])
        self.assertGreater(r["moving"], 50)
        self.assertEqual(r["firstFocus"], r["moving"], "your train, the nearest, plays first all the way")
        self.assertEqual(r["nearFocus"], r["moving"], "from your car, not the train's middle 30 m off")
        self.assertGreater(r["names"].get("rail-joint", 0), 0)
        # a standing train has nothing to play and gives its voice up (a train on the other track can have it): your
        # train's loops are made again as it leaves each station, never on a timer
        self.assertGreater(r["names"].get("motor", 0), 0)
        self.assertLessEqual(r["names"].get("motor", 0), 8, r["names"])
        self.assertGreater(r["names"].get("tunnel-rumble", 0), 0)
        self.assertLessEqual(r["names"].get("tunnel-rumble", 0), 8, r["names"])
        self.assertLessEqual(r["live"].get("metro", {"n": 0})["n"], 2)

    def test_not_through_the_ground(self):
        s = self.o["street"]
        self.assertEqual(s["under"], 0, "on the street: no train in the tunnel below")
        self.assertEqual(s["srcBad"], [])

    def test_silent_at_volume_zero_and_gone_on_dispose(self):
        self.assertEqual(self.o["muted"], {"made": 0, "played": 0})
        self.assertIsNone(self.o["after"], "the pool leaves with the view")
        self.assertEqual(self.o["leaksEnd"], 0)


@unittest.skipUnless(NODE, "node is not installed")
class TrainSounds(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = run(RAIL)

    def test_nearest_point_of_a_train(self):
        p = self.o["pure"]
        self.assertAlmostEqual(p["side"]["x"], 0); self.assertAlmostEqual(p["side"]["z"], -30); self.assertAlmostEqual(p["side"]["y"], 11.5)
        self.assertAlmostEqual(p["ahead"]["z"], 0, msg="ahead of it: its nose")
        self.assertAlmostEqual(p["behind"]["z"], p["tail"], msg="behind it: its tail")
        self.assertIsNone(p["none"])
        self.assertEqual(p["ear"], {"x": 4, "y": 1, "z": 5}, "no listener: the camera")
        self.assertEqual([p["earL"][k] for k in "xyz"], [9, 8, 7], "the engine's listener when there is one")

    def test_city_line(self):
        c = self.o["cityLine"]
        self.assertEqual(c["bad"], [], "every moving train within reach offered, at its part nearest the ears")
        self.assertGreater(c["moving"], 0)
        self.assertGreater(c["played"], 100)
        self.assertLessEqual(c["ids"], 1, "one voice: the City Line and the Island Link share the train kind's two")
        self.assertLessEqual(c["total"], 2)
        self.assertGreaterEqual(c["nearest"], 0.9*c["played"], "the nearest train plays (15% hysteresis aside)")
        self.assertGreater(c["made"], 0, "the train-run loop sounds")
        self.assertEqual(c["leaks"], 0)

    def test_island_link(self):
        a, u = self.o["link"], self.o["tunnel"]
        for x in (a, u):
            self.assertEqual(x["bad"], [])
            self.assertEqual(x["tunnel"], 0, "a train in the tunnel only below the street, one outside only above")
            self.assertLessEqual(x["ids"], 1)
        self.assertGreater(a["played"], 20, "trains pass the viaduct")
        self.assertGreater(u["played"], 20, "and the tunnel")

    def test_silent_at_volume_zero_and_gone_on_dispose(self):
        self.assertEqual(self.o["muted"], {"made": 0, "ids": 0})
        self.assertIsNone(self.o["after"], "both pools leave with their views")
        self.assertEqual(self.o["leaksEnd"], 0)


@unittest.skipUnless(NODE, "node is not installed")
class YourRideCues(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = run(SESSION)

    def test_your_doors_at_full_level_from_every_ride_camera(self):
        # hqcityrail and hqrail have no door sounds of their own: the session's cues are all you hear of these doors.
        # Placed at the train's pose (its middle) as doors, they played at 14% on the platform, 5% from a front-car
        # seat (25 m from the middle) and 10% from the chase camera; yours, where you are, they lose nothing while the
        # camera rides along
        for key in ("cityLine", "islandLink"):
            for cam in ("seat", "window", "chase"):
                r = self.o[key + ":" + cam]
                msg = key + ", " + cam + " camera"
                self.assertEqual(r["phase"], "done", msg)
                self.assertEqual(r["names"], ["door-chime", "validator", "door-chime", "door-hiss", "door-chime"], msg)
                self.assertGreater(r["far"], 20, msg + ": a seat in the front car, far from the train's middle")
                self.assertEqual(r["voices"], [{"kind": "own", "g": 1}] * 4, msg)


@unittest.skipUnless(NODE, "node is not installed")
@unittest.skipUnless(os.path.exists(os.path.join(FIX, "claude-hq@2.json.gz")) and os.path.exists(os.path.join(FIX, "island@2.json.gz")),
                     "the @2 fixtures are missing")
class BuiltLineSounds(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = run(MOUNT)

    def test_trains_on_a_built_line(self):
        s = self.o["side"]
        self.assertEqual(self.o["lines"], ["user:aaaaaaaa-0000-4000-8000-000000000001@3"])
        self.assertIsNone(s["threw"])
        self.assertEqual(s["bad"], [], "moving trains only, each on its line (within a car-to-car chord of a tight bend)")
        self.assertGreater(s["played"], 20, "trains pass every three minutes each way")
        self.assertLessEqual(s["ids"], 1)
        self.assertEqual(s["leaks"], 0)

    def test_your_train(self):
        r = self.o["ride"]
        self.assertIsNone(r["threw"])
        self.assertEqual(r["bad"], [])
        self.assertGreater(r["yours"], 100, "your train runs with its sound once it leaves")
        self.assertEqual(r["yoursFirst"], r["yours"], "and it is the one that plays (but while an oncoming train passes through it)")
        self.assertEqual(r["yoursNear"], r["yours"], "from your car")

    def test_gone_on_destroy(self):
        self.assertIsNone(self.o["after"])
        self.assertEqual(self.o["leaksEnd"], 0)


class Wiring(unittest.TestCase):
    def src(self, name):
        with open(os.path.join(ROOT, "games", name + ".js"), encoding="utf-8") as f:
            return f.read()

    def test_hqtransit(self):
        t = self.src("hqtransit")
        self.assertIn("var SFX_MAP = {};", t, "every aliased name has its own synth now")
        self.assertIn("sfx: function(n, so){ sfxM(n, so); }", t, "the ride session's door sounds keep their place")
        self.assertIn("dest: function(){ var a = audio(); return a ? a.out : null; }", t, "the announcer's chime into the master")
        self.assertIn("Object.assign({dest: a.out}, so || {})", t, "so.pos and so.kind pass through untouched")

    def test_house_rules(self):
        for n in ("hqtransit", "hqcoach", "hqmetro", "hqcityrail", "hqrail"):
            s = self.src(n)
            self.assertNotIn("Math.random(", s, n)
            self.assertNotIn("innerHTML", s, n)
            self.assertIsNone(re.search(r"\blet\b|\bconst\b|=>", s), n + ": var-style JS")

    def test_no_timer_fired_loops(self):
        m = self.src("hqmetro")
        self.assertNotIn('sfx("motor", {speed: v.speed/VMAX})', m, "the motor is a held loop now, not one fired every 0.5 s")
        self.assertNotIn('sfx("tunnel-rumble", {speed: v.speed/VMAX})', m)


if __name__ == "__main__":
    unittest.main()
