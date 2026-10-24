"""Spatial sound (Sound PR B, games/engine.js + games/hqride.js): every world sound where it is.

The pure helpers (falloff, panOf, pick) run under node with no AudioContext: full volume within each kind's reference
distance, an inverse fade that reaches exactly 0 at its maximum (no floor), a pan from the source's side of the camera
(a source on the camera's right pans right, for a yaw listener and for a THREE camera's matrixWorld), and the nearest-N
choice with its 15% hysteresis and ties by id. Then a fake AudioContext (with createStereoPanner) checks the graph:
engines and loops fade with the distance and pan, a one-shot over its kind's voice limit steals the farthest voice
(a 50 ms fade) or is dropped, a repeat with the same key replaces itself, sos kinds start d/343 s late, pools keep the
nearest voices, reuse their handles and stop idle ones, named loops fall silent and stop by themselves, nothing plays
at sfx volume 0 (Calm, mute) and ambient kinds are silent at Ambient sounds 0%. hq_ambient migrates with no step:
"0" (the old Off) is 0%, "1" (On), unset and garbage are 100%, and the slider's value scales the ambient bus. hqRide's
transit sounds take opts.pos through the same graph, its loops can no longer leak, the rotor honours opts.rate and
the announcer's chime goes through the master volume. A kind's voices are shared by all its pools (the nearest of
every pool's sources, each pool to its own count), every pool lets its voices go when the ears do (listener(null): a
paused view, a hidden tab), an ambient kind's pool plays nothing at Ambient sounds 0%, a suspended context is woken
at most once a second (a gesture always) and no held voice is made on one. Your own vehicle (own) fades with the
distance unless the listener says the camera rides with it (its own reach); a pool nothing updates for 2 s lets its
voices go (you left the City: the airport stands' APUs); a steady voice posts its level and little else, one barely
heard only its level and pan; noise buffers are made once per length and band; the slider glides its bus; and the
pools' fixed slots choose exactly as the old full sort did. Skipped without node. Stdlib only."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

FAKE = r"""
const fs = require('fs'), path = require('path'), R0 = process.argv[1];
let now = 0, pnow = 0, made = 0, calmOn = false, posts = 0, bufs = 0; const store = {}, nodes = [];
function param(v){ const p = {value: v, ev: [],
  setTargetAtTime(x, t, tc){ posts++; p.ev.push(['T', x, t, tc]); }, cancelScheduledValues(t){ p.ev = p.ev.filter(e => e[2] < t); },
  setValueAtTime(x, t){ p.ev.push(['V', x, t]); }, exponentialRampToValueAtTime(x, t){ p.ev.push(['E', x, t]); },
  linearRampToValueAtTime(x, t){ p.ev.push(['L', x, t]); }}; return p; }
function node(kind){ made++; const n = {kind, id: made, out: [], stops: [], connect(d){ n.out.push(d); return d; }, disconnect(){ n.out = []; },
  start(t){ n.started = t == null ? now : t; }, stop(t){ n.stops.push(t); }, frequency: param(0), detune: param(0), Q: param(0), type: '',
  playbackRate: param(1), setPeriodicWave(){}}; nodes.push(n); return n; }
class AC { constructor(){ this.state = 'running'; this.sampleRate = 8000; this.destination = {kind: 'dest'}; }
  get currentTime(){ return now; } resume(){ return Promise.resolve(); }
  createGain(){ const n = node('gain'); n.gain = param(1); return n; }
  createOscillator(){ return node('osc'); } createBiquadFilter(){ return node('filter'); } createBufferSource(){ return node('src'); }
  createWaveShaper(){ return node('shaper'); } createPeriodicWave(){ return {}; }
  createDynamicsCompressor(){ const n = node('comp'); ['threshold', 'knee', 'ratio', 'attack', 'release'].forEach(k => n[k] = param(0)); return n; }
  createStereoPanner(){ const n = node('pan'); n.pan = param(0); return n; }
  createBuffer(c, n){ bufs++; const d = new Float32Array(n); return {getChannelData: () => d}; } }
const window = {HQV: {}, matchMedia: () => ({matches: false}), AudioContext: AC};
const document = {documentElement: {classList: {contains: k => k === 'hq-calm' && calmOn}}};
global.window = window;
global.localStorage = {getItem: k => k in store ? store[k] : null, setItem(k, v){ store[k] = String(v); }, removeItem(k){ delete store[k]; }};
global.performance = {now: () => pnow*1000};
new Function('window', 'document', fs.readFileSync(path.join(R0, 'games', 'engine.js'), 'utf8'))(window, document);
const E = window.HQV.engine, S = E.spatial, out = {};
const lastT = p => { const e = p.ev.filter(x => x[0] === 'T'); return e.length ? e[e.length - 1][1] : p.value; };
const beforeFade = p => p.ev.length >= 2 ? p.ev[p.ev.length - 2][1] : p.value;   // the level a dead man's switch fades from
const since = k => nodes.slice(k);
const r4 = x => Math.round(x*1e4)/1e4;
"""

PURE = FAKE + r"""
// ---- falloff: 1 within ref, falling, exactly 0 at max and past it, no floor ----
const K = S.KINDS, fo = {};
Object.keys(K).forEach(k => {
  const s = K[k], fin = isFinite(s.max);
  const grid = []; const top = fin ? s.max : 3000;
  for (let i = 0; i <= 60; i++) grid.push(s.ref + (top - s.ref)*i/60);
  const v = grid.map(d => S.falloff(s, d));
  fo[k] = {fin, atRef: S.falloff(s, s.ref), inside: S.falloff(s, s.ref*0.5), atZero: S.falloff(s, 0),
           mono: v.every((x, i) => i === 0 || x <= v[i - 1] + 1e-12),
           atMax: fin ? S.falloff(s, s.max) : null, past: fin ? S.falloff(s, s.max + 50) : null,
           nearMax: fin ? S.falloff(s, s.max - 0.01) : null, nan: S.falloff(s, NaN), far: S.falloff(s, 1e6)};
});
out.falloff = fo;
out.door10 = S.falloff('door', 10);
out.vehicle60 = S.falloff(K.vehicle, 60);
// your own vehicle (own) fades too now; a source's own reference distance (hear's opt.ref) holds it at full volume
// further, its max moved out by as much; Infinity: the camera rides with it, no distance loss at all
E.listener({x: 0, y: 0, z: 0, yaw: 0});
const hg = (kind, d, o) => { const h = S.hear(kind, {x: 0, y: 0, z: d}, o); return h ? r4(h.g) : null; };
out.own = {at: [10, 50, 200, 1000].map(d => hg('own', d)), vehicle: [10, 50, 200].map(d => hg('vehicle', d)),
           ride: [10, 50, 1000, 1e5].map(d => hg('own', d, {ref: Infinity})),
           plane: [100, 109, 300, 496, 498].map(d => hg('own', d, {ref: 109})), want300: r4(S.falloff({ref: 109, max: 497, roll: 1}, 300)),
           small: hg('own', 50, {ref: 3}), nan: hg('own', 50, {ref: NaN}),
           pan: r4(S.hear('own', {x: -30, y: 0, z: 0}, {ref: Infinity}).pan), panKind: r4(S.hear('own', {x: -30, y: 0, z: 0}).pan)};
// the listener carries how far your own things reach this frame (hq3d.js ownRef): every "own" source follows it
E.listener({x: 0, y: 0, z: 0, yaw: 0}, null, Infinity);
out.own.riding = {own: E.listenerAt().own === Infinity ? 'inf' : E.listenerAt().own, at: [50, 1000].map(d => hg('own', d)), door: hg('door', 30)};
E.listener({x: 0, y: 0, z: 0, yaw: 0}, null, 109); out.own.detached = [100, 300, 498].map(d => hg('own', d));
E.listener({x: 0, y: 0, z: 0, yaw: 0}, null, 'x'); out.own.garbage = [E.listenerAt().own, hg('own', 50)];
E.listener(null);
// ---- pan: a yaw listener (yaw 0 faces +z, its right is -x) and THREE cameras' matrixWorld ----
const Ly = {x: 0, y: 0, z: 0, yaw: 0};
out.panYaw = {right: S.panOf(Ly, {x: -10, z: 0}, 5), left: S.panOf(Ly, {x: 10, z: 0}, 5), ahead: S.panOf(Ly, {x: 0, z: 10}, 5),
              behind: S.panOf(Ly, {x: 0, z: -10}, 5), near: S.panOf(Ly, {x: -1, z: 0}, 5), at: S.panOf(Ly, {x: 0, z: 0}, 5),
              overhead: S.panOf(Ly, {x: -2, y: 60, z: 0}, 5), arr: S.panOf(Ly, [-10, 0, 0], 5)};
const cam = th => { const c = Math.cos(th), s = Math.sin(th);   // a camera at (0, 5, 20) turned th about +y (th 0 looks down -z)
  return {matrixWorld: {elements: [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 5, 20, 1]}}; };
E.listener(cam(0));
const L0 = E.listenerAt();
out.cam0 = {L: [L0.x, L0.y, L0.z, r4(L0.rx), r4(L0.rz), r4(L0.fx), r4(L0.fz)],
            right: S.panOf(L0, {x: 30, y: 5, z: 20}, 5), left: S.panOf(L0, {x: -30, y: 5, z: 20}, 5)};
E.listener(cam(Math.PI/2));                                          // turned to look down -x: its right is -z
const L1 = E.listenerAt();
out.cam90 = {L: [r4(L1.rx), r4(L1.rz)], right: S.panOf(L1, {x: 0, y: 5, z: -10}, 5), left: S.panOf(L1, {x: 0, y: 5, z: 50}, 5)};
E.listener({x: 0, y: 0, z: 0, yaw: 0.7});                            // a yawed listener: its right is (-cos 0.7, sin 0.7)
const L2 = E.listenerAt(), rr = [L2.rx, L2.rz];
out.yawed = {right: S.panOf(L2, {x: rr[0]*20, z: rr[1]*20}, 5), left: S.panOf(L2, {x: -rr[0]*20, z: -rr[1]*20}, 5),
             ahead: S.panOf(L2, {x: L2.fx*20, z: L2.fz*20}, 5)};
E.listener({x: 0, y: 0, z: 0, yaw: 0}, {x: 100, y: 2, z: 100});      // ears at the view's target, the camera's facing
out.at = E.listenerAt();
E.listener(null); out.none = E.listenerAt(); out.noneHear = S.hear('door', {x: 500, z: 0}, {gain: 0.4});
out.garbage = E.listener({x: NaN, z: 0});
// ---- pick: the nearest n within max, hysteresis 15%, ties by id ----
const P = (o) => Object.keys(o).map(id => ({id, d: o[id]}));
out.pick = {
  nearest: S.pick(P({a: 50, b: 10, c: 30, d: 20, e: 200}), 3, 100).map(e => e.id),
  within: S.pick(P({a: 50, b: 150}), 3, 100).map(e => e.id),
  keep: S.pick(P({a: 10, b: 20, c: 30, d: 27}), 3, 100, ['c']).map(e => e.id),          // d is 10% nearer than c: c keeps it
  steal: S.pick(P({a: 10, b: 20, c: 30, d: 24}), 3, 100, ['c']).map(e => e.id),         // d is 20% nearer: d takes it
  map: S.pick(P({a: 10, b: 20, c: 30, d: 27}), 3, 100, {c: 1}).map(e => e.id),
  ties: S.pick(P({b: 10, a: 10, c: 10}), 2, 100).map(e => e.id),
  nan: S.pick([{id: 'x', d: NaN}, {id: 'y', d: 5}, {d: 1}, null], 5, 100).map(e => e.id),
  zero: S.pick(P({a: 1}), 0, 100).length};
console.log(JSON.stringify(out));
"""

GRAPH = FAKE + r"""
store.hq_sfx = '0.5';
E.listener({x: 0, y: 0, z: 0, yaw: Math.PI/2});           // faces +x; its right is (-cos yaw, sin yaw) = +z
const at = (d, side) => ({x: d*Math.cos(side || 0), y: 0, z: d*Math.sin(side || 0)});    // d m away; side pi/2: on the right
// ---- an engine: falloff from its position, the pan, silent past max; "own" loses nothing with distance ----
E.engineSound('v8').stop();                                // the context, its master, ambient bus and the engines' bus
const k0 = nodes.length, eng = E.engineSound('v8'), g = nodes[k0], pan = since(k0).find(n => n.kind === 'pan');
const lv = (o) => { now += 0.1; eng.set(3000, Object.assign({thr: 0.5}, o)); return beforeFade(g.gain); };
const aShort = lv({pos: at(3, 0), sk: 'vehicle'}), aMid = lv({pos: at(30, 0), sk: 'vehicle'}), aFar = lv({pos: at(60, 0), sk: 'vehicle'});
const aOut = lv({pos: at(130, 0), sk: 'vehicle'});
now += 0.1; eng.set(3000, {thr: 0.5, pos: at(20, Math.PI/2), sk: 'vehicle'}); const panR = lastT(pan.pan);
now += 0.1; eng.set(3000, {thr: 0.5, pos: at(20, -Math.PI/2), sk: 'vehicle'}); const panL = lastT(pan.pan);
const own0 = lv({pos: at(0.5, 0)}), own30 = lv({pos: at(30, 0)}), ownLegacy = lv({});
E.listener({x: 0, y: 0, z: 0, yaw: Math.PI/2}, null, Infinity);   // the camera rides with you: your own engine carries
const ownRide = lv({pos: at(30, 0)}), ownChime = r4(E.spatialOut('own', at(50, 0)).out.gain.value);
E.listener({x: 0, y: 0, z: 0, yaw: Math.PI/2});
now += 0.1; eng.set(3000, {thr: 0.5, pos: at(30, Math.PI/2)}); const ownPan = lastT(pan.pan);
eng.stop();
out.engine = {short: aShort, mid: aMid, far: aFar, outside: aOut, panR, panL, own0, own30, ownRide, ownChime, ownLegacy, ownPan,
              panTo: pan.out[0] && pan.out[0].kind, gTo: g.out[0] && g.out[0].kind};
// ---- one-shots: the voice limit (door: 4), the steal, the key, the sos delay ----
const V = [5, 10, 15, 20].map(d => E.spatialOut('door', at(d, 0.3)));
const st1 = S.state().live.door.map(e => e.d);
const drop = E.spatialOut('door', at(30, 0.3));
const n0 = V[3].out.gain.ev.length, steal = E.spatialOut('door', at(3, 0.3));
const st2 = S.state().live.door.map(e => Math.round(e.d));
out.oneshot = {made: V.every(v => !!v), live1: st1.map(Math.round), drop: drop, steal: !!steal, live2: st2,
               faded: V[3].out.gain.ev.slice(n0), gain5: r4(V[0].out.gain.value), want5: r4(S.falloff('door', 5)),
               pan: r4(V[0].pan || since(0).find(n => n.kind === 'pan' && n.id > V[0].out.id).pan.value),
               to: V[0].out.out[0].kind, bus: V[0].out.out[0].out[0] === E.audioOut().out};
now += 5;                                                                       // they have all ended
const k1 = E.spatialOut('bell', at(10, 0), {key: 'tram:7'}), k2 = E.spatialOut('bell', at(12, 0), {key: 'tram:7'});
out.key = {live: S.state().live.bell.length, firstFaded: k1.out.gain.ev.some(e => e[0] === 'T' && e[1] === 0)};
const sos = E.spatialOut('firework', at(343, 0), {gain: 0.4}), nos = E.spatialOut('firework', at(343, 0), {gain: 0.4, delay: false});
const num = E.spatialOut('door', at(5, 0), {delay: 0.25}), yes = E.spatialOut('door', at(34.3, 0), {delay: true});
out.sos = {fw: r4(sos.delay), off: nos.delay, num: num.delay, yes: r4(yes.delay), own: r4(sos.out.gain.value), noDoor: E.spatialOut('door', at(5, 0)).delay};
const mv = E.spatialOut('heli', at(20, 0), {hold: true});
mv.move(at(200, Math.PI/2)); const mvG = lastT(mv.out.gain), mvPan = mv.out.out[0].pan ? lastT(mv.out.out[0].pan) : null;
const gone = mv.move(at(5000, 0)); mv.end(0.5);
out.held = {g: r4(mvG), want: r4(S.falloff('heli', 200)), pan: mvPan, gone: gone, ended: mv.out.gain.ev.some(e => e[0] === 'T' && e[1] === 0 && Math.abs(e[2] - (now + 0.5)) < 1e-9)};
// sfxAt: a named sfx through a voice; past the kind's max nothing is made
now += 5;
const ks = nodes.length, okAt = E.sfxAt('door', at(6, Math.PI/2)), made1 = since(ks);
const vg = made1[0], noiseG = made1.filter(n => n.kind === 'gain').slice(1);
const ks2 = nodes.length, farAt = E.sfxAt('door', at(41, 0)), made2 = nodes.length - ks2;
const boomAt = E.sfxAt('boom', at(100, 0)), centred = E.sfxAt('coin');
out.sfxAt = {ok: okAt, voice: vg.kind, level: r4(vg.gain.value), want: r4(S.falloff('door', 6)), into: noiseG.every(n => n.out[0] === vg),
             pan: made1.find(n => n.kind === 'pan').pan.value, far: farAt, farMade: made2, boom: boomAt, coin: centred,
             boomLate: since(ks2).filter(n => n.kind === 'src').every(n => n.started >= now + 100/343 - 1e-9)};
// ---- noiseLoop / ambientLoop with a kind: the distance fade and the pan; the ambient bus ----
const kn = nodes.length, nl = E.noiseLoop(900, 1, 'water'), nlg = since(kn).filter(n => n.kind === 'gain').pop(), nlp = since(kn).find(n => n.kind === 'pan');
now += 0.1; nl.set(0.2, 0, at(2, 0)); const nNear = beforeFade(nlg.gain);
now += 0.1; nl.set(0.2, 0, at(30, Math.PI/2)); const nMid = beforeFade(nlg.gain), nPan = lastT(nlp.pan);
now += 0.1; nl.set(0.2, 0, at(80, 0)); const nOut = beforeFade(nlg.gain);
nl.stop();
const ka = nodes.length, al = E.ambientLoop(2600, 0.35), alg = since(ka).filter(n => n.kind === 'gain').pop();
out.loops = {near: nNear, mid: r4(nMid), want: r4(0.2*S.falloff('water', 30)), pan: nPan, outside: nOut,
             waterBus: nlp.out[0] === E.ambientOut().out, ambBus: alg.out[0] === E.ambientOut().out,
             plain: (() => { const kp = nodes.length, p = E.noiseLoop(1400, 2), pg = since(kp).filter(n => n.kind === 'gain').pop();
                             return {pan: since(kp).some(n => n.kind === 'pan'), master: pg.out[0] === E.audioOut().out}; })()};
// ---- named loops: made once, the dead man's switch, a rolling stop, started again after it stopped ----
now = 100;
const kl = nodes.length, tr = E.loop('tram-run');
tr.set(1, {pos: at(10, Math.PI/2), speed: 8}); const madeL = nodes.length - kl, lg = nodes[kl];
const ev1 = lg.gain.ev.slice(), src = since(kl).find(n => n.kind === 'src'), stop1 = src.stops.slice();
now += 0.2; tr.set(1, {pos: at(10, Math.PI/2), speed: 9}); const madeL2 = nodes.length - kl - madeL;
const lpan = since(kl).find(n => n.kind === 'pan');
now += 5; const alive5 = tr.alive();
tr.set(1, {pos: at(10, 0), speed: 9}); const madeL3 = nodes.length - kl - madeL;
tr.stop(); const aliveStop = tr.alive();
out.loop = {made: madeL, again: madeL2, ev: ev1.map(e => [e[0], r4(e[1]), r4(e[2])]), want: r4(0.08*S.falloff('tram', 10)),
            stop: stop1.map(r4), pan: lastT(lpan.pan), alive5, rebuilt: madeL3 > 0, aliveStop, names: E.loops,
            unknown: typeof E.loop('nope').set};
// ---- pools: the nearest voices, hysteresis, handles reused, idle ones stopped ----
let makes = 0, stops = 0, plays = {};
const pl = E.pool('vehicle', {voices: 3, idle: 2, make: s => { makes++; return {id: makes, stop(){ stops++; }}; },
                              play: (h, s, h2) => { plays[s.id] = h2 ? r4(h2.g) : null; }});
const src10 = []; for (let i = 0; i < 10; i++) src10.push(Object.assign({id: 'c' + i}, at(10 + i*10, 0.2)));
const ids1 = pl.update(src10), makes1 = makes;
const moved = src10.slice(); moved[3] = Object.assign({id: 'c3'}, at(27, 0.2));            // 10% nearer than c2 (30 m): c2 keeps it
const ids2 = pl.update(moved);
moved[3] = Object.assign({id: 'c3'}, at(24, 0.2));                                         // 20% nearer: c3 takes it
const ids3 = pl.update(moved), makes3 = makes;
const statePools = S.state().pools.vehicle;
const ids4 = pl.update([]); pnow += 1; pl.update([]); const stopsAt1 = stops;
pnow += 1.5; pl.update([]); const stopsAt25 = stops;
const back = pl.update(src10), makesBack = makes;
E.listener(null); const noEars = pl.update(src10); E.listener({x: 0, y: 0, z: 0, yaw: Math.PI/2});
store.hq_sfx = '0'; const muted = pl.update(src10); store.hq_sfx = '0.5';
pl.stop();
out.pool = {ids1, makes1, ids2, ids3, makes3, statePools, ids4, stopsAt1, stopsAt25, back, makesBack, noEars, muted,
            heard: plays.c0, want: r4(S.falloff('vehicle', 10)), gone: S.state().pools.vehicle || null};
const tie = E.pool('peer', {voices: 1, make: () => ({}), play: () => {}});
out.poolTies = tie.update([Object.assign({id: 'b'}, at(10, 0)), Object.assign({id: 'a'}, at(10, 1))]);
tie.stop();
// ---- silence: sfx volume 0 (Calm's default, mute) and Ambient sounds 0% ----
store.hq_sfx = '0';
const km = nodes.length;
out.mute = {out: E.spatialOut('door', at(5, 0)), sfxAt: E.sfxAt('door', at(5, 0)), audio: E.audioOut(), ambient: E.ambientOut(),
            loop: (E.loop('siren').set(1, {pos: at(5, 0)}), nodes.length - km), engine: (E.engineSound('v8').set(3000, {}), nodes.length - km)};
store.hq_sfx = '0.5';
E.ambientSetVolume(0);
out.amb0 = {thunder: E.spatialOut('thunder', at(100, 0), {gain: 0.5, delay: false}), door: !!E.spatialOut('door', at(5, 0)),
            out: E.ambientOut(), fountain: (() => { const kf = nodes.length; E.loop('fountain').set(1, {pos: at(3, 0)}); return nodes.length - kf; })()};
E.ambientSetVolume(1);
// Calm: without a stored volume the sfx volume is 0 (unchanged), so nothing is placed either
delete store.hq_sfx; calmOn = true; out.calm = {vol: E.sfxVolume(), out: E.spatialOut('door', at(5, 0))}; calmOn = false; store.hq_sfx = '0.5';
console.log(JSON.stringify(out));
"""

AMBIENT = FAKE + r"""
// hq_ambient: "0" (the 3.11.1 Off) is 0%, "1" (On), unset and garbage are 100%; the slider stores 0..1
const vals = {}; [['0', null], ['1', null], [null, null], ['', null], ['garbage', null], ['0.35', null], ['7', null], ['-1', null]].forEach(([v]) => {
  if (v === null) delete store.hq_ambient; else store.hq_ambient = v;
  vals[String(v)] = [E.ambientVolume(), E.ambientOn()];
});
out.read = vals;
delete store.hq_ambient; store.hq_sfx = '0.5';
const A = E.ambientOut(), bus = A.out;
out.bus = {start: bus.gain.value, master: bus.out[0] === E.audioOut().out, notMaster: bus !== E.audioOut().out};
const v0 = bus.gain.value;
E.ambientSetVolume(0.35); out.set = {stored: store.hq_ambient, bus: lastT(bus.gain), vol: E.ambientVolume(), on: E.ambientOn()};
out.glide = {value: bus.gain.value === v0, ev: bus.gain.ev.filter(e => e[0] === 'T').slice(-1).map(e => [e[1], e[3]])[0]};
const M = E.audioOut().out; E.sfxSetVolume(0.3); out.sfxGlide = {value: M.gain.value, ev: M.gain.ev.filter(e => e[0] === 'T').slice(-1).map(e => [r4(e[1]), e[3]])[0]};
E.sfxSetVolume(0.5);
E.ambientSetVolume(0.333333); out.round = store.hq_ambient;
E.ambientSetVolume(5); out.clampHi = store.hq_ambient;
E.ambientSetVolume(-2); out.clampLo = [store.hq_ambient, lastT(bus.gain), E.ambientOut()];
E.ambientSet(true); out.on = [store.hq_ambient, lastT(bus.gain)];
E.ambientSet(false); out.off = [store.hq_ambient, lastT(bus.gain), E.ambientOn(), E.ambientOut()];
// a fresh context reads the stored volume into its ambient bus
store.hq_ambient = '0.6';
const w2 = {HQV: {}, matchMedia: () => ({matches: false}), AudioContext: AC};
new Function('window', 'document', fs.readFileSync(path.join(R0, 'games', 'engine.js'), 'utf8'))(w2, document);
out.fresh = w2.HQV.engine.ambientOut().out.gain.value;
out.preview = (() => { store.hq_ambient = '0.5'; const k = nodes.length; const ok = E.ambientPreview(); return [ok, since(k).filter(n => n.kind === 'gain').every(n => n.out[0] === bus)]; })();
console.log(JSON.stringify(out));
"""

RIDE = FAKE + r"""
store.hq_sfx = '0.5';
new Function(fs.readFileSync(path.join(R0, 'games', 'hqride.js'), 'utf8'))();
const R = window.HQV.hqRide, A = E.audioOut(), ctx = A.ctx;
E.listener({x: 0, y: 0, z: 0, yaw: 0});                    // faces +z; its right is -x
// a transit sound at a place: through the engine's spatial voice (its kind by name), not the given dest
now = 10;
const k0 = nodes.length, h = R.sfx(ctx, 'door-chime', {pos: {x: -5, y: 0, z: 0}, dest: A.out}), o0 = since(k0);
const voice = o0[0], rideOut = o0.find(n => n.kind === 'gain' && n.out[0] === voice);
out.placed = {h: !!h, voice: voice.kind, level: r4(voice.gain.value), want: r4(S.falloff('door', 5)), via: !!rideOut,
              notDest: o0.filter(n => n.out.indexOf(A.out) >= 0 && n.kind === 'gain' && n !== voice).length,
              pan: o0.find(n => n.kind === 'pan').pan.value, live: (S.state().live.door || []).length};
out.far = R.sfx(ctx, 'door-chime', {pos: {x: 0, y: 0, z: 100}});
out.kinded = (R.sfx(ctx, 'tram-bell', {pos: {x: 0, y: 0, z: 100}}) !== null);              // a bell carries 250 m
out.uiCentred = (() => { const k = nodes.length; R.sfx(ctx, 'chime', {pos: {x: -500, z: 0}, dest: A.out}); return since(k)[0].out[0] === A.out; })();
out.noPos = (() => { const k = nodes.length; R.sfx(ctx, 'air-brake', {dest: A.out}); return since(k)[0].out[0] === A.out; })();
// the new synths make sound
out.newNames = ['door', 'hiss', 'engine-hum', 'gangway-clank', 'water-lap', 'gondola-rumble', 'gondola-wind', 'ship-horn'].map(n => {
  const k = nodes.length, hh = R.sfx(ctx, n, {dest: A.out}); const m = nodes.length - k; if (hh) hh.stop(); return [n, !!hh, m > 2]; });
// a loop: the dead man's switch and a rolling stop, so a dropped handle stops by itself; set() starts a stopped one again
now = 50;
const kl = nodes.length, m = R.sfx(ctx, 'motor', {dest: A.out, speed: 5}), lo = nodes[kl], osc = since(kl).find(n => n.kind === 'osc');
out.motor = {loop: m.loop, ev: lo.gain.ev.map(e => [e[0], r4(e[1]), r4(e[2])]), stops: osc.stops.map(r4), alive: m.alive()};
now = 50.3; m.set({speed: 6}); out.motor.ev2 = lo.gain.ev.map(e => [e[0], r4(e[1]), r4(e[2])]); out.motor.stops2 = osc.stops.map(r4);
now = 51.0; m.set({speed: 6}); out.motor.stops3 = osc.stops.map(r4);
now = 60; out.motor.dead = m.alive();
const kb = nodes.length; m.set({speed: 6}); out.motor.rebuilt = nodes.length - kb; out.motor.alive2 = m.alive();
m.stop(); out.motor.stopped = m.alive();
// the rotor: Doppler (opts.rate) on its slap and its turbine's noise
now = 70;
const kr = nodes.length, rot = R.sfx(ctx, 'rotor', {dest: A.out, rate: 1.2}), lfo = since(kr).filter(n => n.kind === 'osc').pop();
const nf = since(kr).find(n => n.kind === 'filter');
out.rotor = {start: r4(lfo.frequency.ev[0][1]), filt: r4(nf.frequency.ev[0][1])};
rot.set({rate: 0.8}); out.rotor.set = r4(lastT(lfo.frequency)); out.rotor.filt2 = r4(lastT(nf.frequency));
rot.stop();
// a positional loop moves with set({pos}); past max it is not started
const kp = nodes.length, hl = R.sfx(ctx, 'engine-hum', {pos: {x: 0, z: 30}}), hv = nodes[kp];
hl.set({pos: {x: -50, z: 0}}); out.humMove = {g: r4(lastT(hv.gain)), want: r4(S.falloff('boat', 50)), far: R.sfx(ctx, 'engine-hum', {pos: {x: 0, z: 900}})};
hl.stop();
// the announcer's chime: through the master (the Game sounds volume), not straight to the speakers
const ka = nodes.length, an = R.announcer({announce: () => {}, calm: () => false, audio: () => ctx, voiceOn: () => false});
an.say('Next stop: Harbour Street.'); out.chime = since(ka)[0].out[0] === A.out;
console.log(JSON.stringify(out));
"""


SHARED = FAKE + r"""
store.hq_sfx = '0.5';
E.listener({x: 0, y: 0, z: 0, yaw: Math.PI/2});
const at = d => ({x: d, y: 0, z: 0});
let mades = 0, stopped = 0;
const mk = (kind, n) => E.pool(kind, {voices: n, make: () => { mades++; return {stop(){ stopped++; }}; }, play: () => {}});
// ---- the kind's voices across its pools: the City's traffic (6) and the cab coming to you (1) share the vehicle's 6 ----
const city = mk('vehicle', 6), cab = mk('vehicle', 1);
const cars = [10, 20, 30, 40, 50, 60, 70, 80].map((d, i) => Object.assign({id: 'c' + i}, at(d)));
const cabAt = [Object.assign({id: 'cab'}, at(25))];
const f1 = [city.update(cars), cab.update(cabAt)];
pnow += 1/60;
const f2 = [city.update(cars), cab.update(cabAt)];
out.share = {f1, f2, total: f2[0].length + f2[1].length, state: S.state().pools.vehicle.length};
pnow += 0.6;                                                    // the cab's pool not updated for 0.6 s: it holds no voice
out.stale = city.update(cars);
cab.stop(); city.stop();
// three rail lines, a voice a pool: the train kind's two go to the nearest two trains
const lines = [mk('train', 1), mk('train', 1), mk('train', 1)], far = [50, 100, 150];
let rows = [];
for (let k = 0; k < 3; k++){ pnow += 1/60; rows = lines.map((P, i) => P.update([Object.assign({id: 't' + i}, at(far[i]))])); }
out.trains = rows;
const nearer = [Object.assign({id: 't2'}, at(20))];             // the third line's train comes nearest of all
for (let k = 0; k < 2; k++){ pnow += 1/60; rows = lines.map((P, i) => P.update(i === 2 ? nearer : [Object.assign({id: 't' + i}, at(far[i]))])); }
out.trainsNearer = rows;
lines.forEach(P => P.stop());
// ---- no ears (a paused view): every pool's voices go at once, made again under the next listener ----
mades = 0; stopped = 0;
const bp = mk('bus', 3), buses = [10, 20, 30].map((d, i) => Object.assign({id: 'b' + i}, at(d)));
bp.update(buses); const made1 = mades;
E.listener(null); const stoppedNoEars = stopped, paused = S.state().pools.bus;
E.listener({x: 0, y: 0, z: 0, yaw: Math.PI/2}); pnow += 0.1;
out.rest = {made1, stoppedNoEars, paused, again: bp.update(buses), made2: mades};
E.listener({x: NaN, z: 0}); out.rest.garbage = stopped - stoppedNoEars;       // a broken camera: no ears either
E.listener({x: 0, y: 0, z: 0, yaw: Math.PI/2});
bp.stop();
// ---- an ambient kind's pool at Ambient sounds 0%: nothing plays and its voices are let go; another player's plane
// (peerplane, the engines' bus) still sounds ----
mades = 0; stopped = 0;
const pl = mk('plane', 2), pp = mk('peerplane', 1), jets = [Object.assign({id: 'j'}, at(300))];
const a1 = [pl.update(jets), pp.update(jets)];
E.ambientSetVolume(0); pnow += 0.1;
const a0 = [pl.update(jets), pp.update(jets)];
pnow += 2.5; pl.update(jets); pp.update(jets); const stoppedAmb = stopped;
E.ambientSetVolume(1); pnow += 0.1;
out.amb = {a1, a0, stoppedAmb, back: [pl.update(jets), pp.update(jets)], made: mades, kinds: [S.KINDS.plane.bus, S.KINDS.peerplane.bus]};
pl.stop(); pp.stop();
console.log(JSON.stringify(out));
"""

WAKE = FAKE + r"""
// a page of its own, whose document and window keep their listeners (the hidden tab, the first gesture)
const on = {}, doc = {documentElement: document.documentElement, hidden: false, addEventListener(k, f){ on['d:' + k] = f; }};
const win = {HQV: {}, matchMedia: () => ({matches: false}), AudioContext: AC, addEventListener(k, f){ on['w:' + k] = f; }};
new Function('window', 'document', fs.readFileSync(path.join(R0, 'games', 'engine.js'), 'utf8'))(win, doc);
const E2 = win.HQV.engine;
store.hq_sfx = '0.5';
out.listens = Object.keys(on).sort();
// ---- a hidden tab draws no frames: no ears, every pool's voices go ----
E2.listener({x: 0, y: 0, z: 0, yaw: 0});
let stops = 0; const P = E2.pool('vehicle', {make: () => ({stop(){ stops++; }}), play: () => {}});
P.update([{id: 'a', x: 0, y: 0, z: 10}, {id: 'b', x: 0, y: 0, z: 20}]);
on['d:visibilitychange'](); out.shown = {ears: !!E2.listenerAt(), stops};
doc.hidden = true; on['d:visibilitychange'](); out.hidden = {ears: E2.listenerAt(), stops};
P.stop();
// ---- a suspended context (before your first click): woken at most once a second, by a gesture always ----
const ctx = E2.audioOut().ctx; let resumes = 0; ctx.resume = () => { resumes++; return Promise.resolve(); };
ctx.state = 'suspended';
E2.listener({x: 0, y: 0, z: 0, yaw: 0});
const hum = E2.loop('hum');
for (let i = 0; i < 120; i++){ pnow += 1/60; hum.set(1, {pos: {x: 0, y: 0, z: 30}}); E2.audioOut(); E2.spatialOut('door', {x: 0, y: 0, z: 2}); }
out.frames = resumes;
const r0 = resumes; on['w:pointerdown'](); on['w:keydown'](); out.gesture = resumes - r0;
// ---- a held voice on a suspended context: none (the belfries' strikes would queue at its frozen clock) ----
out.held = {suspended: E2.spatialOut('civicbell', {x: 0, y: 0, z: 50}, {hold: true}), oneShot: E2.spatialOut('door', {x: 0, y: 0, z: 2})};
ctx.state = 'running';
out.held.running = !!E2.spatialOut('civicbell', {x: 0, y: 0, z: 50}, {hold: true});
console.log(JSON.stringify(out));
"""


STALE = FAKE + r"""
store.hq_sfx = '0.5';
const ears = () => E.listener({x: 0, y: 0, z: 0, yaw: 0});
const frame = dt => { pnow += dt; now += dt; ears(); };
ears();
// the City's airport stands (a plane pool of engineSound("jet")) heard for a moment; then you leave the City: nothing
// updates that pool again, while the next floor keeps setting the ears every frame
const k0 = nodes.length;
const stands = E.pool('plane', {voices: 1, make: () => E.engineSound('jet'), play: (h, s) => h.set(900, {thr: 0, pos: s, sk: 'plane'})});
const jets = [{id: 'stand:1', x: 0, y: 3, z: 200}];
for (let i = 0; i < 10; i++){ frame(1/60); stands.update(jets); }
const srcs = since(k0).filter(n => n.kind === 'osc' || n.kind === 'src'), running = () => srcs.filter(n => !n.stops.length).length;
out.stale = {made: srcs.length, before: running()};
for (let i = 0; i < 114; i++) frame(1/60);                       // 1.9 s on: still held (a late frame is not a floor left)
out.stale.at19 = running();
for (let i = 0; i < 600; i++) frame(1);                          // 600 s away
out.stale.after = running(); out.stale.pools = S.state().pools.plane || [];
// a pool its owner keeps updating is left alone; the stale one makes its voice again on its next update
let keptStops = 0;
const kept = E.pool('vehicle', {make: () => ({stop(){ keptStops++; }}), play: () => {}});
for (let i = 0; i < 300; i++){ frame(1/60); kept.update([{id: 'c', x: 0, y: 0, z: 10}]); }
out.stale.keptStops = keptStops;
const k1 = nodes.length; stands.update(jets); out.stale.again = nodes.length - k1 > 0; out.stale.ids = S.state().pools.plane;
stands.stop(); kept.stop();
console.log(JSON.stringify(out));
"""

POSTS = FAKE + r"""
store.hq_sfx = '0.5';
E.listener({x: 0, y: 0, z: 0, yaw: 0});
const step = f => { pnow += 1/60; now += 1/60; const p0 = posts; f(); return posts - p0; };
// a steady pooled engine (same revs, same place) for 3 s, then the average posts a frame over one more second
function steady(kind, sk, o){
  const h = E.engineSound(kind), opt = Object.assign({thr: 0.4, speed: 9, pos: {x: 8, y: 0, z: 25}, sk: sk}, o || {});
  for (let i = 0; i < 180; i++) step(() => h.set(3000, opt));
  let n = 0; for (let i = 0; i < 60; i++) n += step(() => h.set(3000, opt));
  h.stop(); return Math.round(n/60*100)/100;
}
out.engines = {turbo: steady('turbo', 'vehicle'), diesel: steady('diesel', 'bus'), jet: steady('jet', 'plane'), v8: steady('v8', 'vehicle')};
// one still moving: its revs climbing post the pitch, its place moving the pan
{
  const k = nodes.length, h = E.engineSound('turbo'), o1 = since(k).find(x => x.kind === 'osc'); let n = 0, rpm = 2000;   // its main note
  for (let i = 0; i < 60; i++) step(() => h.set(2000, {thr: 0.4, pos: {x: 8, y: 0, z: 25}, sk: 'vehicle'}));
  for (let i = 0; i < 30; i++){ rpm += 60; n += step(() => h.set(rpm, {thr: 0.4, pos: {x: 8 - i*0.4, y: 0, z: 25}, sk: 'vehicle'})); }
  out.moving = Math.round(n/30*100)/100; out.pitch = [o1.kind, r4(lastT(o1.frequency)), r4(E.engineHz('turbo', rpm).hz)]; h.stop();
}
// one barely heard (a car 110 m off: far < 0.02): its level and pan alone, whatever its revs do
{
  const h = E.engineSound('turbo'); let n = 0;
  for (let i = 0; i < 5; i++) step(() => h.set(2000 + i*400, {thr: 0.4, pos: {x: 0, y: 0, z: 110}, sk: 'vehicle'}));
  for (let i = 0; i < 30; i++) n += step(() => h.set(2000 + (i % 7)*700, {thr: (i % 3)/2, pos: {x: 0, y: 0, z: 110}, sk: 'vehicle'}));
  out.quiet = Math.round(n/30*100)/100; out.quietFar = r4(S.falloff('vehicle', 110)); h.stop();
}
// the named loops at rest: the dead man's switch only (its level and its fade), no pan or timbre reposted
out.loops = {};
['tram-run', 'train-run', 'hum', 'siren', 'jet-roar', 'fountain'].forEach(name => {
  const L = E.loop(name); for (let i = 0; i < 30; i++) step(() => L.set(1, {pos: {x: -20, y: 0, z: 40}, speed: 8}));
  let n = 0; for (let i = 0; i < 30; i++) n += step(() => L.set(1, {pos: {x: -20, y: 0, z: 40}, speed: 8}));
  out.loops[name] = n/30; L.stop();
});
// a band loop at rest: its level and fade only; its pan once it moves past 0.01
{
  const L = E.noiseLoop(900, 1, 'water'); for (let i = 0; i < 10; i++) step(() => L.set(0.2, 900, {x: -10, y: 0, z: 10}));
  out.band = step(() => L.set(0.2, 900, {x: -10, y: 0, z: 10})); out.bandMoved = step(() => L.set(0.2, 900, {x: 10, y: 0, z: 10})); L.stop();
}
console.log(JSON.stringify(out));
"""

BUFFERS = FAKE + r"""
store.hq_sfx = '0.5';
E.audioOut();
const b0 = bufs; E.sfx('boom'); const b1 = bufs; E.sfx('boom'); E.sfx('boom'); const b2 = bufs;
E.listener({x: 0, y: 0, z: 0, yaw: 0}); E.sfxAt('boom', {x: 0, y: 0, z: 50}); E.sfxAt('door', {x: 0, y: 0, z: 5}); const b3 = bufs; E.sfxAt('door', {x: 1, y: 0, z: 5});
out.oneShots = {first: b1 - b0, again: b2 - b1, door: bufs - b3};
const l0 = bufs; const A = E.noiseLoop(110, 0.8, 'gondola'), B = E.noiseLoop(110, 0.8, 'gondola'), C = E.noiseLoop(900, 1);
out.bands = {made: bufs - l0, same: (() => { const s = nodes.filter(n => n.kind === 'src').slice(-3); return s[0].buffer === s[1].buffer && s[1].buffer !== s[2].buffer; })()};
A.stop(); B.stop(); C.stop();
console.log(JSON.stringify(out));
"""

# the pools' slots (games/engine.js slot) against the old choice, kept here as the reference: every candidate sorted
# (pick), then the kind's voices shared by sorting every fresh pool's nearest (share)
EQUIV = FAKE + r"""
store.hq_sfx = '0.5';
const L0 = {x: 3, y: 1.6, z: -2, yaw: 0.3};
E.listener(L0);
const K = S.KINDS, FRESH = 0.5, ref = [];
function oldPick(list, n, max, keep){
  const c = [];
  list.forEach(e => { const d = +e.d, id = String(e.id); if(d < max) c.push({e, id, s: keep[id] ? d*0.85 : d}); });
  c.sort((a, b) => a.s - b.s || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return c.slice(0, n).map(x => x.e);
}
function refPool(kind, N){
  const me = {kind, mine: [], at: -Infinity, bound: {}}, MAX = K[kind].max; ref.push(me);
  return function(sources, t){
    const cand = [];
    sources.forEach(s => {
      if(!s || s.id == null) return;
      const x = +s.x, y = s.y != null ? +s.y : L0.y, z = +s.z; if(!(isFinite(x) && isFinite(y) && isFinite(z))) return;
      const dx = x - L0.x, dy = y - L0.y, dz = z - L0.z, d = Math.sqrt(dx*dx + dy*dy + dz*dz);
      if(d < MAX) cand.push({id: String(s.id), d});
    });
    const mine = oldPick(cand, N, MAX, me.bound);
    me.mine = mine.map(c => ({id: c.id, s: me.bound[c.id] ? c.d*0.85 : c.d})); me.at = t;
    const cap = K[kind].voices; let keep = mine;
    if(cap > 0){
      const all = [];
      ref.forEach((P, n) => { if(P.kind !== me.kind || (P !== me && !(t - P.at <= FRESH))) return; P.mine.forEach((e, i) => all.push({s: e.s, id: e.id, n, i: P === me ? i : -1})); });
      if(all.length > cap){
        all.sort((a, b) => a.s - b.s || (a.id < b.id ? -1 : a.id > b.id ? 1 : a.n - b.n));
        const ok = {}; all.slice(0, cap).forEach(e => { if(e.i >= 0) ok[e.i] = 1; });
        keep = mine.filter((c, i) => !!ok[i]);
      }
    }
    me.bound = {}; keep.forEach(c => { me.bound[c.id] = 1; });
    return keep.map(c => c.id);
  };
}
// five pools (three of the vehicle kind sharing its 6, a bus pool, an own pool with no limit), moving sources: ties at
// equal distances, number and string ids, broken positions, sources past max; a pool now and then not updated
const specs = [['vehicle', 6, 400], ['vehicle', 1, 5], ['vehicle', 3, 60], ['bus', 3, 40], ['own', 2, 30]];
const real = specs.map(([k, n]) => E.pool(k, {voices: n, make: () => ({stop(){}}), play: () => {}}));
const refs = specs.map(([k, n]) => refPool(k, n));
let seed = 12345; const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0)/4294967296;
const srcs = specs.map(([k, n, m], pi) => Array.from({length: m}, (_, i) => ({id: i % 4 ? pi + ':' + i : pi*1000 + i, r: 5 + rnd()*150, a: rnd()*6.283, w: (rnd() - 0.5)*0.04, y: rnd()*4})));
let bad = 0, frames = 0, played = 0;
const first = [];
for (let f = 0; f < 400; f++){
  pnow += 1/60;
  specs.forEach((sp, pi) => {
    if((f*7 + pi*3) % 11 === 0) return;                              // not updated this frame
    const list = srcs[pi].map((s, i) => {
      if(i === 3 && f % 5 === 0) return {id: s.id, x: NaN, y: 0, z: 0};
      if(i === 4) return {id: s.id + 'tie', x: L0.x + 20, y: L0.y, z: L0.z};       // two at exactly 20 m, ids apart
      if(i === 5) return {id: s.id + 'tia', x: L0.x - 20, y: L0.y, z: L0.z};
      const a = s.a + s.w*f; return {id: s.id, x: L0.x + 40 + Math.cos(a)*s.r, y: s.y, z: L0.z - 25 + Math.sin(a)*s.r};   // circles off the ears: nearer, farther
    });
    if(f % 13 === 0) list.push(null, {x: 1, y: 1, z: 1});
    const got = real[pi].update(list), want = refs[pi](list, pnow);
    frames++; played += got.length;
    if(JSON.stringify(got) !== JSON.stringify(want)){ bad++; if(first.length < 3) first.push({f, pi, got, want}); }
  });
}
real.forEach(P => P.stop());
out.equiv = {frames, bad, first, played};
console.log(JSON.stringify(out));
"""


def run(script):
    r = subprocess.run([NODE, "-e", script, ROOT], capture_output=True, text=True, timeout=120)
    if r.returncode:
        raise AssertionError(r.stderr[-4000:])
    return json.loads(r.stdout.strip().splitlines()[-1])


@unittest.skipUnless(NODE, "node is not installed")
class SpatialPure(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = run(PURE)

    def test_falloff_shape_per_kind(self):
        for k, f in self.o["falloff"].items():
            self.assertEqual(f["atRef"], 1, k)                 # full volume within the reference distance
            self.assertEqual(f["inside"], 1, k)
            self.assertEqual(f["atZero"], 1, k)
            self.assertTrue(f["mono"], k)                     # never louder farther away
            self.assertEqual(f["nan"], 0, k)                  # a broken distance is silent
            if f["fin"]:
                self.assertEqual(f["atMax"], 0, k)            # exactly 0 at max: no floor
                self.assertEqual(f["past"], 0, k)
                self.assertGreater(f["nearMax"], 0, k)        # and only there
                self.assertEqual(f["far"], 0, k)
        self.assertAlmostEqual(self.o["door10"], 2 / (2 + 8) * (1 - (8 / 38) ** 2))
        self.assertAlmostEqual(self.o["vehicle60"], 5 / (5 + 55) * (1 - (55 / 115) ** 2))
        self.assertEqual(self.o["falloff"]["own"]["far"], 0)  # your own vehicle fades too (a detached camera)

    def test_own_fades_unless_the_camera_rides_with_it(self):
        o = self.o["own"]
        self.assertEqual(o["at"][0], 1)                       # 10 m: the chase camera, full volume
        self.assertTrue(0 < o["at"][1] < 0.3)                 # 50 m off: fading (a photo camera, a panned Map)...
        self.assertTrue(0 < o["at"][2] < o["at"][1])
        self.assertIsNone(o["at"][3])                         # ...silent past 400 m
        self.assertTrue(all(a > b for a, b in zip(o["at"][:3], o["vehicle"]) if b is not None))   # louder than an NPC's
        self.assertEqual(o["ride"], [1, 1, 1, 1])             # ref Infinity: riding along, no distance loss
        self.assertEqual(o["plane"][:2], [1, 1])              # an airliner's reach (109 m): full within it
        self.assertAlmostEqual(o["plane"][2], o["want300"])   # then the kind's fade, its max moved out by as much
        self.assertGreater(o["plane"][3], 0)
        self.assertIsNone(o["plane"][4])
        self.assertEqual(o["small"], o["at"][1])              # a ref under the kind's changes nothing
        self.assertEqual(o["nan"], o["at"][1])
        self.assertEqual(o["pan"], o["panKind"])              # the pan keeps the kind's own reference
        self.assertGreater(o["pan"], 0.2)
        self.assertEqual(o["riding"], {"own": "inf", "at": [1, 1], "door": o["riding"]["door"]})   # the listener's own
        self.assertLess(o["riding"]["door"], 1)               # (only "own" follows it: a door still fades)
        self.assertEqual(o["detached"][:1], [1])
        self.assertAlmostEqual(o["detached"][1], o["want300"])
        self.assertIsNone(o["detached"][2])
        self.assertEqual(o["garbage"], [None, o["at"][1]])    # no reach given: the kind's

    def test_pan_sign(self):
        p = self.o["panYaw"]
        self.assertAlmostEqual(p["right"], 0.85)              # on the right: right, never one ear only
        self.assertAlmostEqual(p["left"], -0.85)
        self.assertAlmostEqual(p["ahead"], 0)
        self.assertAlmostEqual(p["behind"], 0)
        self.assertAlmostEqual(p["near"], 0.85 / 5)           # near sources are centred
        self.assertEqual(p["at"], 0)
        self.assertLess(abs(p["overhead"]), 0.05)            # straight overhead: centred too
        self.assertAlmostEqual(p["arr"], 0.85)                # [x, y, z] positions
        c = self.o["cam0"]
        self.assertEqual(c["L"], [0, 5, 20, 1, 0, 0, -1])     # matrixWorld: right = column 0, forward = -column 2
        self.assertGreater(c["right"], 0.8)
        self.assertLess(c["left"], -0.8)
        c = self.o["cam90"]
        self.assertEqual(c["L"], [0, -1])
        self.assertGreater(c["right"], 0.8)
        self.assertLess(c["left"], -0.8)
        y = self.o["yawed"]
        self.assertAlmostEqual(y["right"], 0.85)
        self.assertAlmostEqual(y["left"], -0.85)
        self.assertAlmostEqual(y["ahead"], 0)

    def test_listener_forms(self):
        o = self.o
        self.assertEqual([o["at"]["x"], o["at"]["y"], o["at"]["z"]], [100, 2, 100])   # ears at the view's target
        self.assertIsNone(o["none"])
        self.assertEqual(o["noneHear"], {"g": 0.4, "pan": 0, "d": 0})    # no listener: centred at the raw level
        self.assertIsNone(o["garbage"])

    def test_pick(self):
        p = self.o["pick"]
        self.assertEqual(p["nearest"], ["b", "d", "c"])
        self.assertEqual(p["within"], ["a"])
        self.assertEqual(p["keep"], ["a", "b", "c"])          # 10% nearer is not enough...
        self.assertEqual(p["steal"], ["a", "b", "d"])         # ...20% is
        self.assertEqual(p["map"], ["a", "b", "c"])
        self.assertEqual(p["ties"], ["a", "b"])               # ties by id
        self.assertEqual(p["nan"], ["y"])
        self.assertEqual(p["zero"], 0)


@unittest.skipUnless(NODE, "node is not installed")
class SpatialGraph(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = run(GRAPH)

    def test_engine_fades_and_pans(self):
        e = self.o["engine"]
        self.assertGreater(e["short"], e["mid"])
        self.assertGreater(e["mid"], e["far"])
        self.assertLess(e["far"], e["short"] * 0.1)
        self.assertEqual(e["outside"], 0)                     # past the kind's max: silent
        self.assertGreater(e["panR"], 0.5)                    # on the camera's right: right
        self.assertLess(e["panL"], -0.5)
        self.assertLess(e["own30"], e["own0"] * 0.6)                              # your own engine fades 30 m off...
        self.assertAlmostEqual(e["ownRide"], e["own0"], delta=e["own0"] * 0.001)  # ...unless the camera rides with it
        self.assertEqual(e["ownChime"], 1)                                        # (your cab's chime too: kind own)
        self.assertAlmostEqual(e["ownLegacy"], e["own0"], delta=e["own0"] * 0.001)
        self.assertGreater(e["ownPan"], 0)                    # only a hint of pan (x0.25)
        self.assertLess(e["ownPan"], 0.25)
        self.assertEqual(e["gTo"], "pan")                     # out -> pan -> the engines' bus
        self.assertEqual(e["panTo"], "comp")

    def test_one_shot_voice_limit_and_steal(self):
        s = self.o["oneshot"]
        self.assertTrue(s["made"])
        self.assertEqual(s["live1"], [5, 10, 15, 20])
        self.assertIsNone(s["drop"])                          # the kind's 4 voices are all nearer: not heard
        self.assertTrue(s["steal"])                           # nearer than the farthest: it takes its voice...
        self.assertEqual(sorted(s["live2"]), [3, 5, 10, 15])
        fade = [e for e in s["faded"] if e[0] == "T"]
        self.assertTrue(fade and fade[-1][1] == 0 and fade[-1][3] <= 0.0125 + 1e-9)   # ...which fades out in ~50 ms
        self.assertAlmostEqual(s["gain5"], s["want5"])
        self.assertEqual(s["to"], "pan")
        self.assertTrue(s["bus"])                             # a door is on the master

    def test_key_sos_and_held_voices(self):
        self.assertEqual(self.o["key"]["live"], 1)            # a repeat from the same source replaces, never stacks
        self.assertTrue(self.o["key"]["firstFaded"])
        s = self.o["sos"]
        self.assertAlmostEqual(s["fw"], 1, places=3)          # 343 m: a second late
        self.assertEqual(s["off"], 0)
        self.assertEqual(s["num"], 0.25)
        self.assertAlmostEqual(s["yes"], 0.1, places=3)
        self.assertEqual(s["noDoor"], 0)
        self.assertEqual(s["own"], 0.4)                       # fireworks keep their own curve: pan only
        h = self.o["held"]
        self.assertAlmostEqual(h["g"], h["want"])
        self.assertGreater(h["pan"], 0.5)
        self.assertFalse(h["gone"])
        self.assertTrue(h["ended"])

    def test_sfx_at(self):
        s = self.o["sfxAt"]
        self.assertTrue(s["ok"])
        self.assertEqual(s["voice"], "gain")
        self.assertAlmostEqual(s["level"], s["want"])
        self.assertTrue(s["into"])                            # the synth's nodes go into the voice
        self.assertGreater(s["pan"], 0.5)
        self.assertFalse(s["far"])
        self.assertEqual(s["farMade"], 0)
        self.assertTrue(s["boom"])
        self.assertTrue(s["boomLate"])                        # a blast 100 m off is heard 0.29 s later
        self.assertTrue(s["coin"])

    def test_noise_and_ambient_loops(self):
        l = self.o["loops"]
        self.assertAlmostEqual(l["near"], 0.2)
        self.assertAlmostEqual(l["mid"], l["want"])
        self.assertGreater(l["pan"], 0.5)
        self.assertEqual(l["outside"], 0)
        self.assertTrue(l["waterBus"])                        # water is ambient: through the ambient volume
        self.assertTrue(l["ambBus"])
        self.assertEqual(l["plain"], {"pan": False, "master": True})   # no kind: today's graph exactly

    def test_named_loops(self):
        l = self.o["loop"]
        self.assertGreater(l["made"], 3)
        self.assertEqual(l["again"], 0)                       # made once, moved by set()
        ev = l["ev"]
        self.assertEqual(ev[-2][:2], ["T", l["want"]])        # the level from the distance...
        self.assertEqual(ev[-1], ["T", 0, 100.6])             # ...and the dead man's switch 0.6 s on
        self.assertEqual(l["stop"], [101.8])                  # a rolling stop: it can never leak
        self.assertGreater(l["pan"], 0.5)
        self.assertFalse(l["alive5"])
        self.assertTrue(l["rebuilt"])                         # set() after it stopped: a fresh voice
        self.assertFalse(l["aliveStop"])
        for n in ("siren", "rain", "hum", "fountain", "water", "tram-run", "train-run", "jet-roar"):
            self.assertIn(n, l["names"])
        self.assertEqual(l["unknown"], "function")

    def test_pool(self):
        p = self.o["pool"]
        self.assertEqual(p["ids1"], ["c0", "c1", "c2"])
        self.assertEqual(p["makes1"], 3)
        self.assertEqual(p["ids2"], ["c0", "c1", "c2"])       # 10% nearer: no flapping
        self.assertEqual(p["ids3"], ["c0", "c1", "c3"])       # 20% nearer: c3 takes the voice
        self.assertEqual(p["makes3"], 3)                      # c2's handle reused
        self.assertEqual(p["statePools"], ["c0", "c1", "c3"])
        self.assertEqual(p["ids4"], [])
        self.assertEqual(p["stopsAt1"], 0)                    # parked: falling silent by their own switches
        self.assertEqual(p["stopsAt25"], 3)                   # idle longer than 2 s: stopped
        self.assertEqual(p["back"], ["c0", "c1", "c2"])
        self.assertEqual(p["makesBack"], 6)
        self.assertEqual(p["noEars"], [])                     # no listener: nothing placed
        self.assertEqual(p["muted"], [])
        self.assertAlmostEqual(p["heard"], p["want"])
        self.assertIsNone(p["gone"])                          # stop() leaves no pool behind
        self.assertEqual(self.o["poolTies"], ["a"])

    def test_silent_at_volume_zero_and_ambient_zero(self):
        m = self.o["mute"]
        self.assertIsNone(m["out"])
        self.assertFalse(m["sfxAt"])
        self.assertIsNone(m["audio"])
        self.assertIsNone(m["ambient"])
        self.assertEqual(m["loop"], 0)                        # nothing built at all
        self.assertEqual(m["engine"], 0)
        a = self.o["amb0"]
        self.assertIsNone(a["thunder"])                       # an ambient kind at 0%: silent
        self.assertTrue(a["door"])                            # the rest still plays
        self.assertIsNone(a["out"])
        self.assertEqual(a["fountain"], 0)
        self.assertEqual(self.o["calm"], {"vol": 0, "out": None})


@unittest.skipUnless(NODE, "node is not installed")
class AmbientVolume(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = run(AMBIENT)

    def test_migration_without_a_step(self):
        r = self.o["read"]
        self.assertEqual(r["0"], [0, False])                  # the 3.11.1 Off
        self.assertEqual(r["1"], [1, True])                   # its On: 100%, today's loudness
        self.assertEqual(r["null"], [1, True])                # unset
        self.assertEqual(r[""], [1, True])
        self.assertEqual(r["garbage"], [1, True])
        self.assertEqual(r["0.35"], [0.35, True])
        self.assertEqual(r["7"], [1, True])
        self.assertEqual(r["-1"], [0, False])

    def test_slider_scales_the_ambient_bus(self):
        o = self.o
        self.assertEqual(o["bus"], {"start": 1, "master": True, "notMaster": True})
        self.assertEqual(o["set"], {"stored": "0.35", "bus": 0.35, "vol": 0.35, "on": True})
        self.assertEqual(o["glide"], {"value": True, "ev": [0.35, 0.03]})     # a 30 ms glide, never a bare .value (a click)
        self.assertEqual(o["sfxGlide"], {"value": 0.5, "ev": [0.3, 0.03]})   # the Game sounds volume too
        self.assertEqual(o["round"], "0.33")
        self.assertEqual(o["clampHi"], "1")
        self.assertEqual(o["clampLo"], ["0", 0, None])
        self.assertEqual(o["on"], ["1", 1])
        self.assertEqual(o["off"], ["0", 0, False, None])
        self.assertEqual(o["fresh"], 0.6)
        self.assertEqual(o["preview"], [True, True])          # Settings' preview goes through the ambient bus


@unittest.skipUnless(NODE, "node is not installed")
class TransitSounds(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = run(RIDE)

    def test_transit_sound_at_a_place(self):
        p = self.o["placed"]
        self.assertTrue(p["h"])
        self.assertEqual(p["voice"], "gain")
        self.assertAlmostEqual(p["level"], p["want"])         # door-chime is a door: 2 m reference, 40 m max
        self.assertTrue(p["via"])
        self.assertGreater(p["pan"], 0.5)                     # x -5 is on the right of a listener facing +z
        self.assertEqual(p["live"], 1)
        self.assertIsNone(self.o["far"])                      # 100 m: a door chime is not heard
        self.assertTrue(self.o["kinded"])
        self.assertTrue(self.o["uiCentred"])                  # the chime is UI: never placed
        self.assertTrue(self.o["noPos"])

    def test_new_synths(self):
        for name, ok, nodes in self.o["newNames"]:
            self.assertTrue(ok, name)
            self.assertTrue(nodes, name)

    def test_loops_cannot_leak(self):
        m = self.o["motor"]
        self.assertTrue(m["loop"])
        self.assertTrue(m["alive"])
        self.assertEqual(m["ev"][-1], ["T", 0.0001, 50.6])    # silent 0.6 s after it was made unless set() comes
        self.assertEqual(m["stops"], [51.8])                  # and its nodes stop by themselves
        self.assertEqual(m["ev2"][-1], ["T", 0.0001, 50.9])   # set() pushes the fade on...
        self.assertEqual(m["stops2"], [51.8])                 # ...and the stop only when the fade nears it
        self.assertEqual(m["stops3"], [51.8, 52.8])
        self.assertFalse(m["dead"])
        self.assertGreater(m["rebuilt"], 0)                   # set() on a stopped loop starts a fresh one
        self.assertTrue(m["alive2"])
        self.assertFalse(m["stopped"])

    def test_rotor_doppler(self):
        r = self.o["rotor"]
        self.assertAlmostEqual(r["start"], 14 * 1.2)
        self.assertAlmostEqual(r["filt"], 400 * 1.2)
        self.assertAlmostEqual(r["set"], 14 * 0.8)
        self.assertAlmostEqual(r["filt2"], 400 * 0.8)

    def test_positional_loop_moves(self):
        h = self.o["humMove"]
        self.assertAlmostEqual(h["g"], h["want"])
        self.assertIsNone(h["far"])

    def test_announcer_chime_under_the_master(self):
        self.assertTrue(self.o["chime"])



@unittest.skipUnless(NODE, "node is not installed")
class SharedVoices(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = run(SHARED)

    def test_a_kinds_voices_are_shared_by_its_pools(self):
        s = self.o["share"]
        self.assertEqual(s["f1"], [["c0", "c1", "c2", "c3", "c4", "c5"], ["cab"]])   # the first frame: the cab's pool new
        self.assertEqual(s["f2"], [["c0", "c1", "c2", "c3", "c4"], ["cab"]])         # then the cab (25 m) takes the 60 m car's
        self.assertEqual(s["total"], 6)                                              # the vehicle kind's 6, no more
        self.assertEqual(s["state"], 6)
        self.assertEqual(self.o["stale"], ["c0", "c1", "c2", "c3", "c4", "c5"])      # a pool nothing updates holds none

    def test_one_voice_a_line_two_for_the_kind(self):
        self.assertEqual(self.o["trains"], [["t0"], ["t1"], []])                    # the nearest two of three lines' trains
        self.assertEqual(self.o["trainsNearer"], [["t0"], [], ["t2"]])              # a nearer one takes the farther's

    def test_no_ears_lets_every_voice_go(self):
        r = self.o["rest"]
        self.assertEqual(r["made1"], 3)
        self.assertEqual(r["stoppedNoEars"], 3)                # stopped at once: no engine runs on, silent, while paused
        self.assertEqual(r["paused"], [])
        self.assertEqual(r["again"], ["b0", "b1", "b2"])      # under the next listener: made again
        self.assertEqual(r["made2"], 6)
        self.assertEqual(r["garbage"], 3)

    def test_ambient_pools_at_zero(self):
        a = self.o["amb"]
        self.assertEqual(a["a1"], [["j"], ["j"]])
        self.assertEqual(a["a0"], [[], ["j"]])                # the City's aircraft go quiet; another player's plane does not
        self.assertEqual(a["stoppedAmb"], 1)                  # and the silent one is let go, not left running
        self.assertEqual(a["back"], [["j"], ["j"]])
        self.assertEqual(a["kinds"], ["ambient", "engine"])


@unittest.skipUnless(NODE, "node is not installed")
class WakeAndHide(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = run(WAKE)

    def test_a_hidden_tab_has_no_ears(self):
        self.assertEqual(self.o["listens"], ["d:visibilitychange", "w:keydown", "w:pointerdown"])
        self.assertEqual(self.o["shown"], {"ears": True, "stops": 0})   # shown again: nothing happens
        self.assertEqual(self.o["hidden"], {"ears": None, "stops": 2})  # hidden: the pool's engines stop

    def test_a_suspended_context_is_woken_at_most_once_a_second(self):
        self.assertGreaterEqual(self.o["frames"], 1)
        self.assertLessEqual(self.o["frames"], 3)             # 2 s of frames (a loop, audioOut, a one-shot each): not 360
        self.assertEqual(self.o["gesture"], 2)                # a click or a key: at once, every time

    def test_held_voices_wait_for_a_running_context(self):
        h = self.o["held"]
        self.assertIsNone(h["suspended"])                     # nothing queued at a frozen clock
        self.assertIsNone(h["oneShot"])
        self.assertTrue(h["running"])


@unittest.skipUnless(NODE, "node is not installed")
class StalePools(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = run(STALE)

    def test_a_pool_nothing_updates_lets_its_voices_go(self):
        s = self.o["stale"]
        self.assertGreater(s["made"], 5)
        self.assertEqual(s["before"], s["made"])               # the APU's oscillators and noise running
        self.assertEqual(s["at19"], s["made"])                 # a frame or two late: still held
        self.assertEqual(s["after"], 0)                        # you left the City: every one of them stopped
        self.assertEqual(s["pools"], [])
        self.assertEqual(s["keptStops"], 0)                    # a pool still updated is left alone
        self.assertTrue(s["again"])                            # and the stale one plays again when it is updated
        self.assertEqual(s["ids"], ["stand:1"])


@unittest.skipUnless(NODE, "node is not installed")
class Posting(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = run(POSTS)

    def test_a_steady_engine_posts_its_level_and_little_else(self):
        # before: 14-20 params a frame each (turbo 16, diesel 15, jet 20, v8 14); now the dead man's switch (2) and the
        # rough idle's wobble now and then
        for k, n in self.o["engines"].items():
            self.assertLessEqual(n, 3, k)
        self.assertLess(self.o["moving"], 12)                  # revving and passing: what moves (the pitch, the pan)...
        osc, got, want = self.o["pitch"]
        self.assertEqual(osc, "osc")
        self.assertAlmostEqual(got, want, delta=want * 0.003)  # ...and the note follows the revs

    def test_a_voice_barely_heard_moves_only_its_level_and_pan(self):
        self.assertLess(self.o["quietFar"], 0.02)
        self.assertLessEqual(self.o["quiet"], 3)

    def test_loops_at_rest_post_only_their_level(self):
        for k, n in self.o["loops"].items():
            self.assertEqual(n, 2, k)                          # its level and the fade HOLD s on
        self.assertEqual(self.o["band"], 2)
        self.assertEqual(self.o["bandMoved"], 3)               # the pan, once it moved


@unittest.skipUnless(NODE, "node is not installed")
class Buffers(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = run(BUFFERS)

    def test_noise_is_made_once_per_length_and_band(self):
        o = self.o["oneShots"]
        self.assertEqual(o["first"], 3)                        # a blast: three bursts of three lengths
        self.assertEqual(o["again"], 0)                        # the next blasts reuse them
        self.assertEqual(o["door"], 0)
        self.assertEqual(self.o["bands"], {"made": 2, "same": True})   # one per band: two loops of one band share it


@unittest.skipUnless(NODE, "node is not installed")
class SlotsMatchTheSort(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = run(EQUIV)

    def test_the_pools_choose_as_the_full_sort_did(self):
        e = self.o["equiv"]
        self.assertGreater(e["frames"], 1500)
        self.assertGreater(e["played"], 1000)
        self.assertEqual(e["bad"], 0, e["first"])


class Wiring(unittest.TestCase):
    def read(self, *p):
        with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
            return f.read()

    def test_listener_hooks(self):
        hq = self.read("games", "hq3d.js")
        i, j = hq.index("    resize(); placeCam();\n"), hq.index("    if(cur !== worlds.mission){")
        self.assertIn("if(E.listener) E.listener(curCam(), earAt(curCam()), ownRef());", hq[i:j])   # and how far you carry
        ear = hq[hq.index("  function earAt(c){"):hq.index("  function steerOn(){")]
        self.assertIn("if(c === cam) return view.target;", ear)              # Classic: from what it looks at
        self.assertIn('rig.mode === "map"', ear)                             # the Map: the ground at its centre,
        self.assertIn("return {x: x, y: groundAt(x, z) + 1.6, z: z};", ear)   # not its camera hundreds of metres up
        pause = hq[hq.index("  inst.pause = function(){"):hq.index("  inst.resume = function(){")]
        self.assertIn("E.listener(null)", pause)
        self.assertIn("if(cur && cur.soundPause){ try { cur.soundPause(); } catch(e){} }", pause)   # the floor's own voices too
        self.assertIn("w.soundPause = function(){ soundStop(); };", self.read("games", "hqcity3d.js"))
        for game, cam in (("kart", "camera"), ("strike", "camera"), ("rally", "R3.camera")):
            src = self.read("games", game + ".js")
            self.assertIn("if(E.listener) E.listener(%s);" % cam, src, game)
            self.assertIn("if(E.listener) E.listener(null);", src, game)

    def test_house_rules(self):
        eng, ride = self.read("games", "engine.js"), self.read("games", "hqride.js")
        self.assertNotIn("Math.random", eng)                  # seeded noise: the same sound every time
        self.assertNotIn("Math.random", ride)
        self.assertIn("  boom: function(a", eng)              # strike.js's E.sfx("boom") is heard at last
        for name in ("listener", "listenerAt", "hear", "spatialOut", "sfxAt", "loop", "pool", "ambientVolume", "ambientSetVolume"):
            self.assertIn("%s: %s" % (name, name), eng, name)
        self.assertIn("spatial: {KINDS: KINDS, falloff: falloff, panOf: panOf, pick: pick, hear: hear, state: spatialState}", eng)
        self.assertNotIn("createPanner", eng)                 # StereoPanner + gain, never PannerNode


if __name__ == "__main__":
    unittest.main()
