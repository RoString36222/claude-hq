"""Sound PR B, the City's street (games/hqcity3d.js, traffic.js, hqcivic.js, hqbridges.js, hqships.js, hqcityparts.js).

Every world sound in the 3D City is placed through games/engine.js's spatial sound: citySound() (hqcity3d.js) runs the
voice pools (NPC cars and the emergency vehicles' engines, buses, trams, sirens, ships, aircraft, the HQs' rooftop
helicopters, the opening bridges' machinery), the city's hum, ship horns, the plaza fountain, the civic bells and the
bridges' bells. These tests check, under node:
  - traffic.js: an emergency run's siren sounds only on its way to the scene (wail), sirens() lists the runs farther
    out than the drawn traffic, and soundOf() gives each vehicle its spatial kind, engine and revs (seeded by its id);
  - hqcivic.js: the town hall's clock strikes the hour and the university's tower rings a seeded peal (strikes, due),
    each strike a bell's partials (ring), the belfries where the towers are;
  - hqbridges.js: sounds() rings the warning bell at the nearer barrier while the lamps flash and runs the machinery
    only while the span moves; hqships.js: each ship's horn on its funnel, F.speed; hqcityparts.js: the fountain's at;
  - citySound() against a fake AudioContext: only the nearest few of each kind play, each where it is, a siren only
    while it wails, nothing below the street, without a listener or at volume 0, and stop() lets everything go; the
    bridges' machinery within the gondola kind's two voices, a still span's stopped once idle;
  - the per-frame gather (soundStep, run on its own with stand-ins): the sources it hands over (a near tower's rooftop
    helicopter from its lot's frame), the horns as ferries sail and big ships weigh anchor, hulls heard along their
    keel, and nothing while the City is not the one you see.
Skipped without node. Stdlib only."""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
FIX = os.path.join(ROOT, "tests", "fixtures")


def read(*p):
    with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
        return f.read()


CITY = read("games", "hqcity3d.js")


def fill(tpl):
    return tpl.replace("%(root)s", json.dumps(ROOT))


def run(src, module=False, timeout=300):
    args = [NODE, "--input-type=module", "-e", src] if module else [NODE, "-e", src]
    r = subprocess.run(args, capture_output=True, text=True, timeout=timeout, env=dict(os.environ, TZ="UTC"))
    if r.returncode != 0:
        raise AssertionError("node failed:\n" + r.stderr[-4000:])
    return json.loads(r.stdout.strip().splitlines()[-1])


TRAFFIC = r"""
const fs = require("fs"), root = %(root)s;
global.window = {HQV: {}};
new Function(fs.readFileSync(root + "/games/traffic.js", "utf8"))();
const T = window.HQV.traffic, city = require(root + "/tests/fixtures/traffic_city.js"), out = {};
const s = T.create(city(1), {tier: 5, seed: 7}), ALL = {x: 0, z: 0};
let I = null;
for (let t = 0; !I && t < 4*3600; t += 30) I = s._.incidentsAt(t)[0] || null;
out.found = !!I;
if (I) {
  const find = (list, id) => list.filter(v => v.id === id)[0] || null;
  const at = t => find(s.at(t*1000, ALL, 1e6), I.id), sir = t => find(s.sirens(t*1000, ALL, 1e6), I.id);
  const tOut = I.start + Math.min(5, I.P1.T/2), tScene = I.start + I.P1.T + Math.min(5, (I.tb - I.start - I.P1.T)/2), tBack = I.tb + Math.min(5, I.P2.T/2);
  out.phases = [tOut, tScene, tBack].map(t => { const a = at(t), b = sir(t);
    return {siren: a && a.siren, wail: a && a.wail, sirWail: b && b.wail, same: !!(a && b && a.x === b.x && a.z === b.z && a.kind === b.kind), speed: a && a.speed}; });
  // sirens() reaches past the drawn traffic: the run 1 km off is listed though at() (320 m) leaves it out
  const e = at(tOut), far = {x: e.x + 1000, z: e.z};
  out.reach = {at: !!find(s.at(tOut*1000, far, 320), I.id), sirens: !!find(s.sirens(tOut*1000, far, 1200), I.id),
               short: s.sirens(tOut*1000, far, 320).length};
  const all = s.sirens(tOut*1000, ALL, 1e6);
  out.sorted = all.every((v, i) => !i || all[i - 1].d <= v.d);
}
// soundOf: the kind, the engine, the revs through an automatic (an electric car has no gears)
const so = v => T.soundOf(v);
out.kinds = ["car", "bus", "tram", "fire", "ambulance", "police", "constructor", undefined].map(k => { const r = so({id: "x", kind: k, speed: 5}); return [r.sk, r.voice]; });
out.idle = so({id: "c1", kind: "car", speed: 0}).rpm;
out.curve = []; for (let v = 0; v <= 14.4; v += 0.2) out.curve.push(so({id: "c1", kind: "car", voice: "turbo", speed: v}).rpm);
out.elec = []; for (let v = 0; v <= 14.4; v += 0.2) out.elec.push(so({id: "c1", kind: "car", voice: "electric", speed: v}).rpm);
out.same = so({id: "car:3:7", kind: "car", speed: 6}).voice === so({id: "car:3:7", kind: "car", speed: 9}).voice;
const vs = {}; for (let i = 0; i < 60; i++) vs[so({id: "car:" + i, kind: "car"}).voice] = 1;
out.voices = Object.keys(vs).sort();
out.override = so({id: "a", kind: "car", voice: "diesel", speed: 1});
out.garbage = so(null);
console.log(JSON.stringify(out));
"""

BUILT = r"""
import fs from "fs";
import zlib from "zlib";
const root = %(root)s;
const THREE = await import(root + "/games/vendor/three-module.js");
globalThis.window = globalThis.self = {HQV: {}};
for (const f of ["hqmerge", "world", "worldgeom", "hqvoyage", "hqbridges", "hqcivic", "hqboat", "hqships", "hqcityparts", "hqride"])
  new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const HQV = window.HQV, C = HQV.hqCivic, out = {};
function hashStr(s){ var h = 2166136261 >>> 0; s = String(s); for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function rng(seed){ var a = seed >>> 0 || 1; return function(){ a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0)/4294967296; }; }
function mat(c, o){ return new THREE.MeshStandardMaterial(Object.assign({color: c, roughness: 0.7, metalness: 0.08}, o || {})); }
function emis(c, e, ei, o){ var m = mat(c, o); m.emissive = new THREE.Color(e); m.emissiveIntensity = ei; return m; }
function add(o, x, y, z, p, ns){ o.position.set(x, y, z); if(!ns){ o.castShadow = true; o.receiveShadow = true; } p.add(o); return o; }
var noop2d = new Proxy({}, {get(t, k){ return k === "measureText" ? function(){ return {width: 10}; } : (k === "createLinearGradient" || k === "createRadialGradient") ? function(){ return {addColorStop(){}}; } : function(){}; }, set(){ return true; }});
var c = {THREE: THREE, PI: Math.PI, COL: {amber: 0xffb347, cyan: 0x5fd3e6, green: 0x6fd38a}, HEX: {green: "#6fd38a", amber: "#ffb347", cyan: "#5fd3e6"},
  E: {calm(){ return false; }}, rng: rng, hashStr: hashStr, mat: mat, emis: emis, add: add,
  box(w, h, d, m, x, y, z, p, ns){ return add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m), x, y, z, p, ns); },
  cyl(rt, rb, h, m, x, y, z, p, seg){ return add(new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg || 20), m), x, y, z, p); },
  sph(r, m, x, y, z, p){ return add(new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), m), x, y, z, p); },
  canvasTex(w, h, draw){ if(draw) draw(noop2d, w, h); return {c: null, g: noop2d, t: new THREE.Texture()}; },
  glow(col, s, o){ return new THREE.Sprite(new THREE.SpriteMaterial({color: col, opacity: o, transparent: true})); },
  label(t){ var s = new THREE.Sprite(new THREE.SpriteMaterial({transparent: true})); s.name = "label:" + t; return s; },
  short(s, n){ s = String(s || ""); return s.length > n ? s.slice(0, n) : s; }};

/* ---------- the civic bells: where the belfries are ---------- */
const Q = 65536;
function site(kind, n, tier){ const K = C.KINDS[kind]; return {id: kind + ":" + n, kind: kind, tier: tier, x: 120000 + n*5000, y: 250, z: -80000, w: K.size[0]*100, d: K.size[1]*100, front: [0, Q]}; }
out.bells = {};
Object.keys(C.KINDS).forEach(function(k){
  out.bells[k] = [1, 5].map(function(tier){
    const B = C.build(c, site(k, 2, tier), {tier: tier});
    return B.bells.map(function(b){
      const tower = B.boxes.filter(x => b.x >= x.min.x && b.x <= x.max.x && b.z >= x.min.z && b.z <= x.max.z && b.y <= x.max.y && b.y >= x.max.y - 3).length;
      return {id: b.id, kind: b.kind, seed: b.seed, y: b.y, tower: tower, top: B.y + B.top};
    });
  });
});
out.bellsAgain = JSON.stringify(C.build(c, site("townhall", 2, 5), {tier: 5}).bells) === JSON.stringify(C.build(c, site("townhall", 2, 5), {tier: 5}).bells);
out.bellsOther = C.build(c, site("townhall", 3, 5), {tier: 5}).bells[0].seed !== C.build(c, site("townhall", 2, 5), {tier: 5}).bells[0].seed;

/* ---------- the ships: the horn on the funnel, the speed it was last moved at ---------- */
const SH = HQV.hqShips, F = SH.ferry(c, {name: "Test"});
F.update(0.016, -7.5, false);
const F2 = F.clone(); F2.update(0.016, 3, true);
const cr = SH.cruise(c, {name: "Test"}), cg = SH.cargo(c, {name: "Test"});
out.ships = {sound: SH.SOUND, sfx: HQV.hqRide.SFX, speed: [F.speed, F2.speed, cr.speed], len: {ferry: SH.LENGTH, cruise: SH.CRUISE.LENGTH, cargo: SH.CARGO.LENGTH},
             tops: {ferry: new THREE.Box3().setFromObject(F.g).max.y, cruise: new THREE.Box3().setFromObject(cr.g).max.y, cargo: new THREE.Box3().setFromObject(cg.g).max.y}};

/* ---------- the fountain: where its water falls ---------- */
const g = new THREE.Group(), fo = HQV.hqCityParts.fountain(c, g, 12, 3, -40);
out.fountain = fo.at;

/* ---------- the opening bridges: the warning bell while the lamps flash, the machinery while the span moves ---------- */
const doc = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/" + f + ".json.gz")));
const W = HQV.world.pack(doc("claude-hq@2")), BR = HQV.hqBridges, scene = new THREE.Scene();
const B = BR.create({THREE: THREE}, W, scene, {}), b = B.list()[0];
if (b) {
  const cx = (b.a.x + b.b.x)/2, cz = (b.a.z + b.b.z)/2, yaw = Math.atan2(b.left[0], b.left[1]), dt = 1/30;
  const ship = {x: cx - b.left[0]*240, z: cz - b.left[1]*240, yaw: yaw, speed: 4};
  const nearA = {x: b.a.x - b.axis[0]*30, z: b.a.z - b.axis[1]*30}, nearB = {x: b.b.x + b.axis[0]*30, z: b.b.z + b.axis[1]*30};
  const rows = [];
  let beats = 0, lastBeat = null, lastU = 0;
  for (let i = 0; i < 160/dt; i++) {
    if (i*dt < 120) { ship.x += b.left[0]*ship.speed*dt; ship.z += b.left[1]*ship.speed*dt; } else ship.speed = 0;
    B.update(dt, [ship]);
    const st = B.state(b.id), sa = B.sounds(nearA.x, nearA.z).filter(s => s.id === b.id)[0], sb = B.sounds(nearB.x, nearB.z).filter(s => s.id === b.id)[0];
    if (sa.bell && lastBeat != null && sa.beat !== lastBeat) beats++;
    lastBeat = sa.bell ? sa.beat : null;
    rows.push({t: i*dt, u: st.u, moved: st.u !== lastU, lights: st.lights, bell: !!sa.bell, motor: !!sa.motor,
               dA: sa.bell ? Math.hypot(sa.bell.x - b.a.x, sa.bell.z - b.a.z) : null, dB: sb.bell ? Math.hypot(sb.bell.x - b.b.x, sb.bell.z - b.b.z) : null,
               yA: sa.bell ? sa.bell.y - b.y : null, mA: sa.motor ? Math.hypot(sa.motor.x - b.a.x, sa.motor.z - b.a.z) : null,
               mB: sb.motor ? Math.hypot(sb.motor.x - b.b.x, sb.motor.z - b.b.z) : null});
    lastU = st.u;
  }
  const lit = rows.filter(r => r.lights);
  out.bridge = {kind: b.kind, n: rows.length, lit: lit.length, opened: rows.some(r => r.u === 1), closed: rows[rows.length - 1].u === 0 && !rows[rows.length - 1].lights,
    bellIffLights: rows.every(r => r.bell === !!r.lights), motorIffMoving: rows.every(r => r.motor === r.moved),
    motorFrames: rows.filter(r => r.motor).length, beats: beats, litS: lit.length*dt,
    dA: lit.map(r => r.dA), dB: lit.map(r => r.dB), yA: lit.map(r => r.yA),
    mA: rows.filter(r => r.mA != null).map(r => r.mA), mB: rows.filter(r => r.mB != null).map(r => r.mB)};
}
B.dispose();
console.log(JSON.stringify(out));
"""

FAKE = r"""
const fs = require("fs"), path = require("path"), R0 = %(root)s;
let now = 0, pnow = 0, made = 0; const store = {hq_sfx: "0.5"}, nodes = [];
function param(v){ const p = {value: v, ev: [],
  setTargetAtTime(x, t, tc){ p.ev.push(["T", x, t, tc]); }, cancelScheduledValues(t){ p.ev = p.ev.filter(e => e[2] < t); },
  setValueAtTime(x, t){ p.ev.push(["V", x, t]); }, exponentialRampToValueAtTime(x, t){ p.ev.push(["E", x, t]); },
  linearRampToValueAtTime(x, t){ p.ev.push(["L", x, t]); }}; return p; }
function node(kind){ made++; const n = {kind, id: made, out: [], stops: [], connect(d){ n.out.push(d); return d; }, disconnect(){ n.out = []; },
  start(t){ n.started = t == null ? now : t; }, stop(t){ n.stops.push(t); }, frequency: param(0), detune: param(0), Q: param(0), type: "",
  playbackRate: param(1), setPeriodicWave(){}}; nodes.push(n); return n; }
class AC { constructor(){ this.state = "running"; this.sampleRate = 8000; this.destination = {kind: "dest"}; }
  get currentTime(){ return now; } resume(){ return Promise.resolve(); }
  createGain(){ const n = node("gain"); n.gain = param(1); return n; }
  createOscillator(){ return node("osc"); } createBiquadFilter(){ return node("filter"); } createBufferSource(){ return node("src"); }
  createWaveShaper(){ return node("shaper"); } createPeriodicWave(){ return {}; }
  createDynamicsCompressor(){ const n = node("comp"); ["threshold", "knee", "ratio", "attack", "release"].forEach(k => n[k] = param(0)); return n; }
  createStereoPanner(){ const n = node("pan"); n.pan = param(0); return n; }
  createBuffer(c, n){ const d = new Float32Array(n); return {getChannelData: () => d}; } }
const window = {HQV: {}, matchMedia: () => ({matches: false}), AudioContext: AC};
const document = {documentElement: {classList: {contains: () => false}}};
global.window = window; global.self = window;
global.localStorage = {getItem: k => k in store ? store[k] : null, setItem(k, v){ store[k] = String(v); }, removeItem(k){ delete store[k]; }};
global.performance = {now: () => pnow*1000};
new Function("window", "document", fs.readFileSync(path.join(R0, "games", "engine.js"), "utf8"))(window, document);
"""

SOUND = FAKE + r"""
for (const f of ["hqride", "traffic", "hqcivic", "hqships", "hqcity3d"]) new Function(fs.readFileSync(path.join(R0, "games", f + ".js"), "utf8"))();
const HQV = window.HQV, E = HQV.engine, S = E.spatial, C3 = HQV.hqCity3d, R = HQV.hqRide, CV = HQV.hqCivic, out = {};
const r4 = x => Math.round(x*1e4)/1e4;
// spies over the engine's makers (the real ones still run): what each pool made, and every set() and stop()
const calls = {eng: [], loop: [], ride: [], sfxAt: [], noise: [], out: [], ring: []};
const wrap = (rec, h) => ({set(){ rec.sets.push([].slice.call(arguments)); if(h && h.set) h.set.apply(h, arguments); }, stop(){ rec.stops++; if(h && h.stop) h.stop(); },
                           alive(){ return !!(h && h.alive && h.alive()); }, loop: h && h.loop});
const real = {eng: E.engineSound, loop: E.loop, noise: E.noiseLoop, out: E.spatialOut, sfxAt: E.sfxAt, ride: R.sfx, ring: CV.ring};
E.engineSound = function(kind){ const rec = {kind, sets: [], stops: 0}; calls.eng.push(rec); return wrap(rec, real.eng.apply(E, arguments)); };
E.loop = function(name){ const rec = {name, sets: [], stops: 0}; calls.loop.push(rec); return wrap(rec, real.loop.apply(E, arguments)); };
E.noiseLoop = function(f, q, sk){ const rec = {f, q, sk, sets: [], stops: 0}; calls.noise.push(rec); return wrap(rec, real.noise.apply(E, arguments)); };
E.sfxAt = function(name, pos, o){ const ok = real.sfxAt.apply(E, arguments); calls.sfxAt.push({name, pos, o, ok}); return ok; };
E.spatialOut = function(kind, pos, o){ const V = real.out.apply(E, arguments), rec = {kind, pos, o, made: !!V, moves: 0, ends: 0}; calls.out.push(rec);
  if(V){ const mv = V.move, en = V.end; V.move = function(){ rec.moves++; return mv.apply(V, arguments); }; V.end = function(){ rec.ends++; return en.apply(V, arguments); }; }
  return V; };
R.sfx = function(ctx, name, opts){ const h = real.ride.apply(R, arguments), rec = {name, opts, made: !!h, sets: [], stops: 0}; calls.ride.push(rec); return h ? wrap(rec, h) : null; };
CV.ring = function(V, f, g, d, at){ calls.ring.push([r4(f), g, d]); return real.ring.apply(CV, arguments); };

const H = 3600000, T15 = 15*H;
E.listener({x: 0, y: 1.6, z: 0, yaw: 0});                                          // faces +z, its right is -x
const L = E.listenerAt();
const cars = []; for (let i = 0; i < 10; i++) cars.push({id: "c" + i, kind: "car", x: 5 + i*10, y: 0, z: 0, yaw: 0, speed: 9});
const tram = {id: "t1", kind: "tram", x: 40, y: 0, z: 40, speed: 8, parts: [{x: 47, y: 0, z: 40}, {x: 33, y: 0, z: 40}]};
const ev = [{id: "e1", kind: "police", x: -20, y: 0, z: 0, speed: 15, siren: true, wail: true},
            {id: "e2", kind: "fire", x: -60, y: 0, z: 0, speed: 0, siren: true, wail: false},
            {id: "e3", kind: "ambulance", x: -300, y: 0, z: 0, speed: 12, siren: true, wail: true},
            {id: "e4", kind: "ambulance", x: -900, y: 0, z: 0, speed: 12, siren: true, wail: true}];
const traffic = cars.concat([{id: "b1", kind: "bus", x: 0, y: 0, z: 30, speed: 6}, {id: "b2", kind: "bus", x: 0, y: 0, z: 250, speed: 6}, tram, ev[0]]);
const ships = [{id: "ferry:0", x: 0, y: 2, z: -60, speed: 5}, {id: "big:cargo0", x: 100, y: 2, z: -200, speed: 8}, {id: "big:cruise0", x: 200, y: 2, z: -300, speed: 8}];
const planes = [{id: "jet:0", x: 0, y: 300, z: 500, voice: "jet", phase: "climb"}, {id: "amphib:0", x: 0, y: 40, z: 250, voice: "prop", phase: "toString"},
                {id: "amb:0", x: 0, y: 1800, z: 0, voice: "jet", phase: "cruise"}];
const bell = {id: "townhall:2:bell", x: 100, y: 30, z: 100, kind: "clock", seed: 3};
const near = {id: "plaza", x: 10, y: 1.6, z: 10}, far = {id: "far", x: 200, y: 1.6, z: 0};
const roof = {id: "heli:u1", x: 30, y: 40, z: 30, rpm: 4000};
function frame(o){ now += 0.05; pnow += 0.05; snd.update(o); }
function src(k, x){ return Object.assign({traffic, sirens: ev, ships, planes, fountains: [near, far], bells: [bell], helis: [roof], localMs: T15 + x}, k || {}); }
const snd = C3.citySound();
out.made = !!snd;
// frame 0: everything; the clock's hour is 50 ms off, the bridge's lamps are on (beat 0) and its span moves
frame(src({horns: [{key: "berth:w", name: "ferry-horn", x: 0, y: 9, z: -70}], bridges: [{id: "br", beat: 0, bell: {x: 20, y: 3, z: -20}, motor: {x: 25, y: 1, z: -20}}]}, -50));
let st = S.state();
out.f0 = {pools: st.pools, live: Object.keys(st.live).reduce((o, k) => (o[k] = st.live[k].length, o), {})};
const eng = calls.eng.slice(), find = k => calls.eng.filter(r => r.kind === k);
out.engines = eng.map(r => r.kind);
out.carSet = (() => { const r = eng.filter(x => x.sets.length && x.sets[0][1].pos && x.sets[0][1].pos.id === "c0")[0]; return r ? {kind: r.kind, rpm: r.sets[0][0], sk: r.sets[0][1].sk, mode: r.sets[0][1].mode, pos: r.sets[0][1].pos === cars[0], want: HQV.traffic.soundOf(cars[0])} : null; })();
out.police = (() => { const r = eng.filter(x => x.sets.length && x.sets[0][1].pos && x.sets[0][1].pos.id === "e1")[0]; return r ? [r.kind, r.sets[0][1].sk] : null; })();
out.bus = find("diesel").filter(r => r.sets.length && r.sets[0][1].sk === "bus").map(r => [r.sets[0][1].pos.id, r.sets[0][0]]);
out.loops = calls.loop.map(r => r.name).sort();
const tr = calls.loop.filter(r => r.name === "tram-run")[0];
out.tram = tr ? {pos: [tr.sets[0][1].pos.x, tr.sets[0][1].pos.z], speed: tr.sets[0][1].speed, level: tr.sets[0][0]} : null;
out.sirens = calls.loop.filter(r => r.name === "siren").map(r => r.sets.map(s => s[1].pos.id)[0]);
const hm = calls.loop.filter(r => r.name === "hum")[0];
out.hum = hm ? {level: r4(hm.sets[0][0]), pos: [r4(hm.sets[0][1].pos.x), r4(hm.sets[0][1].pos.y), r4(hm.sets[0][1].pos.z)]} : null;
out.fountain = calls.loop.filter(r => r.name === "fountain").map(r => r.sets[0][1].pos.id);
out.boats = calls.ride.filter(r => r.name === "engine-hum").map(r => [r.opts.kind, r.opts.pos.id, r.made]);
out.horns = calls.ride.filter(r => /horn/.test(r.name)).map(r => [r.name, r.opts.kind, r.opts.key, r.made]);
out.planes = calls.eng.filter(r => r.sets.length && r.sets[0][1].sk === "plane").map(r => [r.kind, r.sets[0][1].pos.id, r.sets[0][0], r.sets[0][1].thr]);
out.dings = calls.sfxAt.map(c => [c.name, c.o.kind, c.o.key, c.ok]);
out.motor = calls.noise.map(r => [r.f, r.q, r.sk, r.sets.length, r.sets[0][0], r.sets[0][2].x]);
out.roof = calls.eng.filter(r => r.kind === "rotor").map(r => [r.sets[0][0], r.sets[0][1].sk, r.sets[0][1].pos === roof]);
// then 100 ms frames: the bridge's beat 0, 1, dark, lit again (its span still); meanwhile the clock strikes three
// (15:00, :02.4, :04.8) and rings out
const br = (beat, lit, moving) => ({id: "br", beat: beat, bell: lit ? {x: 20, y: 3, z: -20} : null, motor: moving ? {x: 25, y: 1, z: -20} : null});
frame(src({bridges: [br(0, true, true)]}, 10));
frame(src({bridges: [br(1, true, true)]}, 110));
frame(src({bridges: [br(0, false, false)]}, 210));
frame(src({bridges: [br(0, true, false)]}, 310));
for (let x = 410; x <= 9410; x += 100) frame(src({bridges: [br(0, true, false)]}, x));
const tower = calls.out.filter(r => r.kind === "civicbell");
out.bells = {voices: tower.map(r => [r.made, r.o.hold, r.pos === bell, r.moves, r.ends]), ring: calls.ring.slice(),
             want: CV.strikes(bell, 15).map(s => [r4(s.f), s.g, s.d])};
out.dings2 = calls.sfxAt.length;
out.motor2 = calls.noise.map(r => [r.sets.length, r.stops]);
// below the street: nothing up there is heard
frame(src({under: true, horns: [{key: "x", name: "ship-horn", x: 0, y: 9, z: -70}], bridges: [{id: "br", beat: 3, bell: {x: 20, y: 3, z: -20}, motor: {x: 25, y: 1, z: -20}}]}, 9500));
st = S.state();
out.under = {pools: st.pools, horns: calls.ride.filter(r => /horn/.test(r.name)).length, dings: calls.sfxAt.length, motors: calls.noise.length};
// no listener, then volume 0: the pools play nothing
frame(src({}, 9600));
const setsBefore = calls.loop.reduce((n, r) => n + r.sets.length, 0) + calls.noise.length + calls.ride.length + calls.sfxAt.length;
E.listener(null); frame(src({horns: [{key: "z", name: "ship-horn", x: 0, y: 9, z: -70}], bridges: [{id: "br2", beat: 1, bell: {x: 20, y: 3, z: -20}, motor: {x: 25, y: 1, z: -20}}]}, 9700)); out.noEars = S.state().pools;
out.noEarsSets = calls.loop.reduce((n, r) => n + r.sets.length, 0) + calls.noise.length + calls.ride.length + calls.sfxAt.length - setsBefore;
E.listener({x: 0, y: 1.6, z: 0, yaw: 0});
store.hq_sfx = "0"; const k0 = nodes.length; frame(src({horns: [{key: "y", name: "ship-horn", x: 0, y: 9, z: -70}]}, 9800));
out.mute = {pools: S.state().pools, nodes: nodes.length - k0}; store.hq_sfx = "0.5";
// stop(): every pool goes, every loop is stopped
frame(src({}, 9900));
snd.stop();
out.stopped = {pools: S.state().pools, loops: calls.loop.every(r => r.stops > 0 || !r.sets.length)};
const E0 = HQV.engine; HQV.engine = null; out.noEngine = C3.citySound(); HQV.engine = E0;
console.log(JSON.stringify(out));
"""


BRIDGES = FAKE + r"""
for (const f of ["hqride", "traffic", "hqcivic", "hqships", "hqcity3d"]) new Function(fs.readFileSync(path.join(R0, "games", f + ".js"), "utf8"))();
const HQV = window.HQV, E = HQV.engine, S = E.spatial, out = {};
const loops = [], real = E.noiseLoop;
E.noiseLoop = function(f, q, sk){ const h = real.apply(E, arguments), rec = {sk, sets: 0, stops: 0}; loops.push(rec);
  return {set(){ rec.sets++; h.set.apply(h, arguments); }, stop(){ rec.stops++; h.stop(); }}; };
E.listener({x: 0, y: 1.6, z: 0, yaw: 0});
const snd = HQV.hqCity3d.citySound();
const span = (id, z) => ({id, beat: 0, bell: null, motor: {x: 0, y: 1, z}});
function frame(list){ now += 0.05; pnow += 0.05; snd.update({bridges: list}); }
// four spans moving at once: 10, 20 and 30 m off, and one 200 m off (past the gondola kind's 120 m)
for (let i = 0; i < 4; i++) frame([span("a", 10), span("b", 20), span("c", 30), span("d", 200)]);
out.moving = {made: loops.length, sks: loops.map(r => r.sk), ids: S.state().pools.gondola, sets: loops.map(r => r.sets)};
// the nearest stops: the third takes its voice (made again only if no parked one fits: it reuses the stopped span's)
for (let i = 0; i < 4; i++) frame([span("b", 20), span("c", 30), span("d", 200)]);
out.next = {made: loops.length, ids: S.state().pools.gondola};
// every span still: parked, then stopped once idle (2 s), not left running for as long as they stay still
for (let i = 0; i < 60; i++) frame([]);
out.still = {stops: loops.map(r => r.stops), ids: S.state().pools.gondola};
snd.stop();
console.log(JSON.stringify(out));
"""


SUSPENDED = FAKE + r"""
for (const f of ["hqride", "traffic", "hqcivic", "hqships", "hqcity3d"]) new Function(fs.readFileSync(path.join(R0, "games", f + ".js"), "utf8"))();
const HQV = window.HQV, E = HQV.engine, CV = HQV.hqCivic, out = {}, rings = [];
const ring = CV.ring; CV.ring = function(V){ rings.push(V.ctx.state); return ring.apply(CV, arguments); };
const H = 3600000, bell = {id: "townhall:2:bell", x: 100, y: 30, z: 100, kind: "clock", seed: 3};
E.listener({x: 0, y: 1.6, z: 0, yaw: 0});
const ctx = E.audioOut().ctx, snd = HQV.hqCity3d.citySound();
// a frame every 100 ms of the wall clock; the audio clock runs only while the context does
function frame(ms, running){ pnow += 0.1; if(running) now += 0.1; snd.update({bells: [bell], localMs: ms}); }
// 15:00 strikes three, 2.4 s apart (each rings 4.5 s): the first rings, then the audio is suspended (the system's)
frame(15*H - 50, true); frame(15*H + 10, true);
out.first = rings.length;
ctx.state = "suspended";
for (let x = 110; x <= 9010; x += 100) frame(15*H + x, false);
out.whileSuspended = rings.length - out.first;            // its tower's voice still held, but nothing rung into it
ctx.state = "running";
for (let x = 9110; x <= 9510; x += 100) frame(15*H + x, true);
out.afterWaking = rings.length - out.first;               // nothing queued at the frozen clock: no chord on waking
// suspended from the start (before your first click): 16:00's four strikes are dropped, no voice is made
ctx.state = "suspended";
frame(16*H - 50, false); for (let x = 10; x <= 9010; x += 100) frame(16*H + x, false);
out.beforeClick = rings.length - out.first;
ctx.state = "running";
frame(17*H - 50, true); frame(17*H + 10, true);
out.nextHour = rings.length - out.first;                  // awake again: 17:00's first strike rings
out.states = rings;
snd.stop();
console.log(JSON.stringify(out));
"""

GATHER = r"""
const fs = require("fs"), R0 = %(root)s;
global.window = {HQV: {}};
new Function(fs.readFileSync(R0 + "/games/hqships.js", "utf8"))();
var HQV = {engine: {listenerAt: function(){ return LIS; }}, hqShips: window.HQV.hqShips};
var LIS = {x: 0, y: 1.6, z: 0, rx: -1, rz: 0, fx: 0, fz: 1}, ACTIVE = true, UNDER = false, NOW = 0, out = {};
var captured = [], stops = 0, made = 0, sirArgs = [], bridgeArgs = [];
function citySound(){ made++; return {update: function(src){ captured.push(src); }, stop: function(){ stops++; }}; }
var c = {active: function(x){ return ACTIVE && x === w; }}, w = {};
var transit = {under: function(){ return UNDER; }};
var callTraffic = [{id: "c1", kind: "car", x: 5, y: 0, z: 5, speed: 7}];
var tsim = {sirens: function(now, L, r){ sirArgs.push([now, L.x, L.z, r]); return [{id: "e1", kind: "police", siren: true, wail: true}]; },
            stopsNear: function(x, z, r){ stopArgs.push([x, z, r]); return [{id: "s1", kind: "bus", x: 12, y: 0, z: 0, dist: 12}]; }};
var stopArgs = [], WORKS = [{id: "works:w1", x: 40, y: 1, z: 40}], cev = {sounds: function(){ return WORKS; }};
var fount = {at: {x: 3, y: 1.6, z: 4}}, bridges = {sounds: function(x, z){ bridgeArgs.push([x, z]); return [{id: "br"}]; }};
var cars = [{g: {position: {x: 1, y: 0, z: 2}}, turn: 0, v: 6}, {g: {position: {x: 9, y: 0, z: 2}}, turn: 0.4, v: 6}];
var apGround = [{type: "tug", id: "s1|tug|9", phase: "push", x: 50, y: 4, z: 60}, {type: "cart", id: "s1|tractor|1|c1", phase: "drive", x: 51, y: 4, z: 60},
                {type: "tanker", id: "fuel", phase: "park", x: 52, y: 4, z: 60}, {type: "followme", phase: "lead", x: 53, y: 4, z: 60},
                {type: "bus", id: "s2|bus|3", phase: "drive", x: 54, y: 4, z: 60}, {type: "belt", id: "s1|belt|2", phase: "constructor", x: 55, y: 4, z: 60}];
function hull(x, z, yaw, vis, speed){ return {g: {visible: vis !== false, position: {x: x, y: 0.5, z: z}, rotation: {y: yaw || 0}}, speed: speed || 0}; }
var ferryPool = [hull(0, -100, 0, true, 5), hull(300, 0, 0, false)], myFerry = hull(-50, -100, 0, true, 3);
var EVERY = 120000, VOY = {
  sailings: function(a, b, now, back, ahead){ var o = []; for(var d = Math.ceil((now - back)/EVERY)*EVERY; d <= now + ahead; d += EVERY) o.push(d); return o; },
  poseAt: function(R, t){ return {x: R.x0, z: R.z0, yaw: R.yaw}; },
  loopT: function(sh, now, warp){ var T = sh.R.T, t = (now/1000 + sh.off + (warp || 0)) % T; return t < 0 ? t + T : t; }};
var ferryRoutes = [{to: {world: "w2"}, out: {x0: 130, z0: 90, yaw: Math.PI/2}}], worldId = "w1", sea = {y: 0.2};
function hereArch(){ return {x: 100, z: 50}; }
var shC = {kind: "cruise", k: 0, off: 0, R: {T: 1000, stops: [{t0: 100, t1: 240}]}}, shG = {kind: "cargo", k: 0, off: 0, R: {T: 1000, stops: [{t0: 100, t1: 240}]}};
var bigFleet = {cruise: [shC], cargo: [shG]}, bigShips = {cruise0: hull(500, 500, 0, true, 0), cargo0: hull(-500, 500, Math.PI, false, 0)};
var NAV = {cruise: null, flight: null}, myCruise = null;
function bigHalf(k){ return k === "cruise" ? 60 : k === "cargo" ? 47.5 : 19; }
function plane(x, y, z, vis, phase){ var P = {g: {visible: vis !== false, position: {x: x, y: y, z: z}}}; if(phase) P.phase = phase; return P; }
var airPool = {jet: [plane(0, 300, 500, true, "takeoff")], sea: [plane(0, 1, 900, false, "taxi")], amphib: [plane(30, 1, 250, true, "taxi")]};
var airAmbPool = [plane(0, 1800, 0, true)], myPlane = plane(10, 50, 10, true, "climb");
function airMine(F){ return !!(F && F.mine); }
var civics = [{bells: [{id: "townhall:1:bell", x: 1, y: 30, z: 2, kind: "clock", seed: 5}]}, {bells: []}, {}];
var PAD_UP = 0.05;
/*TOWORLD*/
function tower(lod, heli){ return {lod: function(){ return lod; }, sounds: function(){ return {fountain: null, karts: [], heli: heli}; }}; }
var roofHeli = {id: "heli", x: 3, y: 12, z: 1, rpm: 4000};
var hqs = [{h: {userId: "u1"}, x: 100, y: 2, z: 50, rot: Math.PI/2, g: {visible: true}, B: tower(0, roofHeli)},
           {h: {userId: "u2"}, x: 0, y: 0, z: 0, rot: 0, g: {visible: true}, B: tower(1, roofHeli)},        // far: its masses only
           {h: {userId: "u3"}, x: 0, y: 0, z: 0, rot: 0, g: {visible: false}, B: tower(0, roofHeli)},       // not drawn
           {h: {userId: "u4"}, x: 0, y: 0, z: 0, rot: 0, g: {visible: true}, B: tower(0, null)},            // no helicopter (under level 20)
           {h: {userId: "u5"}, x: 0, y: 0, z: 0, rot: 0, g: {visible: true}, B: {}}];                        // an older tower
var dNow = Date.now; Date.now = function(){ return NOW; };
/*BLOCK*/
var B = 120000*1000;
function step(t){ NOW = t; soundStep(); return captured[captured.length - 1]; }
var f0 = step(B + 239500), f1 = step(B + 240500), f2 = step(B + 240516);
out.f1 = f1; out.f0horns = f0.horns.length; out.f2horns = f2.horns.length; out.madeOnce = made;
out.works = f1.works === WORKS; out.stops = [f1.stops, f2.stops === f1.stops, stopArgs.slice()];
out.localMs = f1.localMs - (B + 240500 + 330*60000);   // [3.23] the City's clock: Koramangala (IST)
out.sirArgs = sirArgs[1]; out.bridgeArgs = bridgeArgs[1];
// a hull along its keel: off the beam it is heard from abeam, ahead of the bow from the bow
LIS = {x: 60, y: 1.6, z: -100, rx: -1, rz: 0, fx: 0, fz: 1}; out.abeam = step(B + 240532).ships.filter(s => s.id === "ferry:0")[0];
LIS = {x: 0, y: 1.6, z: 0, rx: -1, rz: 0, fx: 0, fz: 1};
// the big ship goes out of sight and comes back past a stop: no horn on its first frame back
bigShips.cruise0.g.visible = false; var f3 = step(B + 240548); bigShips.cruise0.g.visible = true;
var f4 = step(B + 1240500);                              // the loop has passed the stop again meanwhile (and a ferry has sailed)
out.backQuiet = [f3.horns.length, f4.horns.length, bigShips.cruise0.sndT != null];
// aboard your own cruise ship (at your own pace): its hull and horn from your ship
NAV.cruise = {city: "w1", phase: "aboard", kind: "cruise", k: 0, warp: 0}; myCruise = hull(700, 0, Math.PI/2, true, 6);
var g0 = step(B + 1239500), g1 = step(B + 1240500);
out.own = {ships: g1.ships.map(s => s.id), horns: g1.horns.map(h => [h.key, h.name, Math.round(h.x*10)/10, Math.round(h.z*10)/10])};
NAV.cruise = null; myCruise = null;
// your flight: your plane, by its kind's engine
NAV.flight = {kind: "amphib", mine: true}; out.flight = step(B + 1241016).planes.filter(p => p.id === "plane:mine")[0]; NAV.flight = null;
// below the street, no ears, another world showing, no tsim sirens
UNDER = true; out.under = step(B + 1241032).under; UNDER = false;
var n0 = captured.length; LIS = null; step(B + 1241048); out.noEars = captured.length - n0; LIS = {x: 0, y: 1.6, z: 0};
ACTIVE = false; step(B + 1241064); out.inactive = captured.length - n0; ACTIVE = true;
var ts = tsim; tsim = null; out.sirFallback = step(B + 1241080).sirens === callTraffic; tsim = ts;
soundStop(); step(B + 1241096); out.stop = {stops: stops, made: made};
Date.now = dNow;
console.log(JSON.stringify(out));
"""


def gather_block():
    m = re.search(r"\n  /\* ---------- \[Sound PR B\] this frame's sound sources.*?\n  function soundStop\(\)\{[^\n]*\n", CITY, re.S)
    if not m:
        raise AssertionError("soundStep's block is not where the test looks for it")
    return m.group(0)


@unittest.skipUnless(NODE, "node is not installed")
class TrafficSound(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = run(fill(TRAFFIC))

    def test_siren_wails_only_on_the_way_to_the_scene(self):
        self.assertTrue(self.o["found"], "an emergency run in four hours")
        out, scene, back = self.o["phases"]
        for p in (out, scene, back):
            self.assertTrue(p["siren"], "its lights are on for the whole run")
            self.assertTrue(p["same"], "sirens() lists it exactly as at() does")
        self.assertTrue(out["wail"], "on its way: the siren")
        self.assertTrue(out["sirWail"])
        self.assertFalse(scene["wail"], "on scene: lights only")
        self.assertFalse(back["wail"], "on the way back: lights only")
        self.assertAlmostEqual(scene["speed"], 0, places=6)

    def test_sirens_reach_past_the_drawn_traffic(self):
        r = self.o["reach"]
        self.assertFalse(r["at"], "1 km off: not in the drawn traffic")
        self.assertTrue(r["sirens"], "but heard: a siren carries 600 m and more")
        self.assertEqual(r["short"], 0)
        self.assertTrue(self.o["sorted"])

    def test_sound_of_each_kind(self):
        k = self.o["kinds"]                      # car, bus, tram, fire, ambulance, police, an unknown kind, none
        self.assertEqual([x[0] for x in k], ["vehicle", "bus", "tram", "vehicle", "vehicle", "vehicle", "vehicle", "vehicle"])
        self.assertEqual([x[1] for x in k[1:6]], ["diesel", None, "diesel", "diesel", "v8"])
        for x in (k[0], k[6], k[7]):
            self.assertIn(x[1], self.o["voices"], "an unknown kind sounds as a car")
        self.assertEqual(self.o["garbage"]["sk"], "vehicle")

    def test_revs_through_an_automatic(self):
        c = self.o["curve"]
        self.assertEqual(self.o["idle"], 950)
        self.assertEqual(c[0], 950)
        drops = [i for i in range(1, len(c)) if c[i] < c[i - 1]]
        self.assertEqual(len(drops), 2, "two upshifts")
        self.assertTrue(all(900 <= x <= 6000 for x in c))
        e = self.o["elec"]
        self.assertTrue(all(e[i] >= e[i - 1] for i in range(1, len(e))), "an electric car has no gears")
        self.assertEqual(self.o["override"]["voice"], "diesel")

    def test_a_car_always_sounds_the_same(self):
        self.assertTrue(self.o["same"])
        self.assertGreaterEqual(len(self.o["voices"]), 4, "a mix of engines on the street")
        self.assertNotIn(None, self.o["voices"])


@unittest.skipUnless(NODE, "node is not installed")
class CivicBells(unittest.TestCase):
    PURE = r"""
const fs = require("fs"); global.window = {HQV: {}};
new Function(fs.readFileSync(%(root)s + "/games/hqcivic.js", "utf8"))();
const C = window.HQV.hqCivic, out = {}, clock = {id: "townhall:0:bell", kind: "clock", seed: 12345}, peal = {id: "university:0:bell", kind: "peal", seed: 777};
out.clock = []; for (let h = 0; h < 24; h++) out.clock.push(C.strikes(clock, 480000 + h));
out.neg = C.strikes(clock, -1).length;
out.peal = []; for (let h = 0; h < 24; h++) out.peal.push(C.strikes(peal, 480000 + h));
out.again = JSON.stringify(C.strikes(peal, 480007)) === JSON.stringify(C.strikes(peal, 480007));
out.pitches = [1, 2, 3, 4, 5, 6, 7].map(s => C.strikes({kind: "clock", seed: s}, 0)[0].f);
const H = 3600000, h0 = 480015*H;
out.due = {first: C.due(clock, h0 - 1, h0), ten: C.due(clock, h0 - 1, h0 + 10000).length, late: C.due(clock, h0 + 120001, h0 + 130000).length,
           long: C.due(clock, h0 - 2*H, h0 + 10).length, back: C.due(clock, h0 + 10, h0 - 10).length, bad: C.due(clock, NaN, h0).length,
           split: C.due(peal, h0 - 1, h0 + 3000).length + C.due(peal, h0 + 3000, h0 + 120000).length, whole: C.strikes(peal, 480015).length};
// ring: the partials into the voice, started at its time
let made = []; const P = () => ({value: 0, setValueAtTime(){}, exponentialRampToValueAtTime(){}});
const ctx = {currentTime: 10, createOscillator(){ const o = {kind: "osc", out: [], frequency: {v: null, setValueAtTime(x){ this.v = x; }}, connect(d){ o.out.push(d); }, start(t){ o.t = t; }, stop(t){ o.end = t; }}; made.push(o); return o; },
             createGain(){ const g = {kind: "gain", out: [], gain: P(), connect(d){ g.out.push(d); }}; made.push(g); return g; }};
const V = {ctx: ctx, out: {kind: "voice"}, delay: 0.5};
out.ring = {ok: C.ring(V, 200, 0.9, 4, 1), osc: made.filter(n => n.kind === "osc").map(o => [o.frequency.v, o.t, o.out[0].out[0] === V.out, +(o.end - o.t).toFixed(3)]),
            none: [C.ring(null, 200, 1, 2, 0), C.ring({ctx: ctx}, 200, 1, 2, 0), C.ring(V, 0, 1, 2, 0), C.ring(V, NaN, 1, 2, 0)]};
console.log(JSON.stringify(out));
"""

    @classmethod
    def setUpClass(cls):
        cls.o = run(fill(cls.PURE))

    def test_the_clock_strikes_the_hour(self):
        for h, s in enumerate(self.o["clock"]):
            hour = (480000 + h) % 24
            self.assertEqual(len(s), hour % 12 or 12, "at %d:00" % hour)
            for i, x in enumerate(s):
                self.assertAlmostEqual(x["t"], i * 2.4, places=9)
            self.assertEqual(len({x["f"] for x in s}), 1, "one hour bell")
        self.assertEqual(self.o["neg"], 11, "an hour before the epoch is 23:00")
        p = self.o["pitches"]
        self.assertTrue(all(150 <= f <= 213 for f in p))
        self.assertGreater(len(set(p)), 3, "each town hall's bell its own note")

    def test_the_bell_tower_rings_a_seeded_peal(self):
        lengths = set()
        for s in self.o["peal"]:
            self.assertEqual(len(s) % 6, 0)
            rows = [[x["f"] for x in s[i:i + 6]] for i in range(0, len(s), 6)]
            rounds = sorted(rows[0], reverse=True)
            self.assertEqual(rows[0], rounds, "rounds: the treble down to the tenor")
            self.assertEqual(rows[1], rounds)
            self.assertEqual(rows[-1], rounds, "and rounds to finish")
            self.assertTrue(all(sorted(r, reverse=True) == rounds for r in rows), "every row rings each bell once")
            changes = len(rows) - 3
            self.assertTrue(4 <= changes <= 8)
            self.assertNotEqual(rows[2], rounds, "the changes start")
            t = [x["t"] for x in s]
            self.assertEqual(t, sorted(t))
            self.assertLess(t[-1], 120, "over within two minutes of the hour")
            lengths.add(len(s))
        self.assertGreater(len(lengths), 1, "the peal's length changes with the hour")
        self.assertTrue(self.o["again"])

    def test_due_windows(self):
        d = self.o["due"]
        self.assertEqual(len(d["first"]), 1, "the first strike, on the hour")
        self.assertEqual(d["ten"], 3, "15:00: three strikes, 2.4 s apart, in the first ten seconds")
        self.assertEqual(d["late"], 0)
        self.assertEqual(d["long"], 0, "a window over an hour (a long-hidden tab) rings nothing")
        self.assertEqual(d["back"], 0)
        self.assertEqual(d["bad"], 0)
        self.assertEqual(d["split"], d["whole"], "windows that meet ring every strike once")

    def test_ring_builds_a_bells_partials_into_the_voice(self):
        r = self.o["ring"]
        self.assertTrue(r["ok"])
        self.assertEqual([o[0] for o in r["osc"]], [100, 200, 240, 300, 400, 600], "hum, prime, tierce, quint, nominal, superquint")
        self.assertTrue(all(o[1] == 11.5 for o in r["osc"]), "at the voice's delay and its own")
        self.assertTrue(all(o[2] for o in r["osc"]), "through an envelope into the voice")
        self.assertGreater(r["osc"][0][3], r["osc"][-1][3], "the hum outlasts the higher partials")
        self.assertEqual(r["none"], [False, False, False, False])


@unittest.skipUnless(NODE, "node is not installed")
@unittest.skipUnless(os.path.exists(os.path.join(FIX, "claude-hq@2.json.gz")), "the @2 fixture is missing")
class BuiltParts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = run(fill(BUILT), module=True)

    def test_belfries_are_on_the_towers(self):
        for kind, tiers in self.o["bells"].items():
            for bells in tiers:
                if kind == "townhall":
                    self.assertEqual([b["kind"] for b in bells], ["clock"])
                elif kind == "university":
                    self.assertEqual([b["kind"] for b in bells], ["peal"])
                else:
                    self.assertEqual(bells, [], kind)
                for b in bells:
                    self.assertGreaterEqual(b["tower"], 1, "%s: the bell hangs in its tower's top" % kind)
                    self.assertLess(b["y"], b["top"])
                    self.assertTrue(b["id"].endswith(":bell"))
        self.assertTrue(self.o["bellsAgain"])
        self.assertTrue(self.o["bellsOther"], "each town hall's bell is seeded by its site")

    def test_ship_horns_sit_on_their_funnels(self):
        s = self.o["ships"]
        self.assertEqual(sorted(s["sound"]), ["cargo", "cruise", "ferry"])
        for kind, H in s["sound"].items():
            self.assertIn(H["horn"], s["sfx"], "%s blows a horn hqRide can make" % kind)
            x, y, z = H["at"]
            self.assertEqual(x, 0)
            self.assertLess(abs(z), s["len"][kind] / 2)
            self.assertTrue(0.6 * s["tops"][kind] < y <= s["tops"][kind], "%s: up on the funnel" % kind)
        self.assertEqual(s["sound"]["ferry"]["horn"], "ferry-horn")
        self.assertEqual(s["speed"], [7.5, 3, 0], "F.speed: its last speed (a clone its own)")

    def test_the_fountain_says_where_its_water_falls(self):
        f = self.o["fountain"]
        self.assertEqual((f["x"], f["z"]), (12, -40))
        self.assertAlmostEqual(f["y"], 4.6, places=9)

    def test_bridge_bell_while_lit_machinery_while_moving(self):
        b = self.o.get("bridge")
        self.assertTrue(b, "the Commons has an opening bridge")
        self.assertTrue(b["opened"] and b["closed"], "it opened for the ship and closed after it")
        self.assertTrue(b["bellIffLights"], "the bell rings exactly while the lamps flash")
        self.assertTrue(b["motorIffMoving"], "the machinery runs exactly while the span moves")
        self.assertGreater(b["motorFrames"], 0)
        self.assertAlmostEqual(b["beats"] / b["litS"], 1.6, delta=0.15)
        self.assertTrue(all(abs(d - 9) < 1e-6 for d in b["dA"]), "at the barrier on your side, 9 m short of the span")
        self.assertTrue(all(abs(d - 9) < 1e-6 for d in b["dB"]), "and on the far side when you stand there")
        self.assertTrue(all(abs(y - 2.6) < 1e-6 for y in b["yA"]), "up at the lamps")
        self.assertTrue(b["mA"] and all(d < 1e-6 for d in b["mA"]), "the machinery at your bank")
        self.assertTrue(b["mB"] and all(d < 1e-6 for d in b["mB"]))


@unittest.skipUnless(NODE, "node is not installed")
class CitySound(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = run(fill(SOUND))

    def test_only_the_nearest_few_of_each_kind(self):
        p = self.o["f0"]["pools"]
        self.assertTrue(self.o["made"])
        self.assertEqual(p["vehicle"], ["c0", "c1", "e1", "c2", "c3", "c4"], "six engines: the nearest cars and the police car")
        self.assertEqual(p["bus"], ["b1"], "the bus 250 m off is past a bus's 180 m")
        self.assertEqual(p["tram"], ["t1"])
        self.assertEqual(p["siren"], ["e1", "e3"], "only the runs whose siren wails, within 600 m")
        self.assertEqual(p["boat"], ["ferry:0", "big:cargo0"], "two ship voices")
        self.assertEqual(p["plane"], ["amphib:0", "jet:0"], "two aircraft: the nearest")
        self.assertEqual(p["gondola"], ["bridge:br"], "the bridge's machinery in the gondola kind's pool")
        self.assertEqual(p["heli"], ["heli:u1"])
        self.assertEqual(self.o["roof"], [[4000, "heli", True]], "a rooftop helicopter: its rotor where it is")

    def test_each_engine_where_its_vehicle_is(self):
        c = self.o["carSet"]
        self.assertEqual(c["kind"], c["want"]["voice"])
        self.assertEqual(c["rpm"], c["want"]["rpm"])
        self.assertEqual(c["sk"], "vehicle")
        self.assertEqual(c["mode"], "comfort", "city driving: no overrun crackle")
        self.assertTrue(c["pos"], "the pose itself is the engine's place, every frame")
        self.assertEqual(self.o["police"], ["v8", "vehicle"])
        self.assertEqual([b[0] for b in self.o["bus"]], ["b1"])
        t = self.o["tram"]
        self.assertEqual(t["pos"], [33, 40], "a tram from its nearer section")
        self.assertEqual((t["speed"], t["level"]), (8, 1))
        self.assertEqual(sorted(self.o["sirens"]), ["e1", "e3"])

    def test_the_city_hum_from_the_traffic_all_round(self):
        h = self.o["hum"]
        self.assertAlmostEqual(h["level"], min(1, 14 ** 0.5 / 8), places=4)
        xs = [5 + i * 10 for i in range(10)] + [0, 0, 40, -20]
        zs = [0] * 10 + [30, 250, 40, 0]
        self.assertAlmostEqual(h["pos"][0], round(sum(xs) / 14, 4), places=3)
        self.assertAlmostEqual(h["pos"][2], round(sum(zs) / 14, 4), places=3)
        self.assertEqual(h["pos"][1], 2)

    def test_ships_aircraft_horns_fountains(self):
        self.assertEqual(sorted(self.o["boats"]), [["boat", "big:cargo0", True], ["boat", "ferry:0", True]])
        self.assertEqual(self.o["horns"], [["ferry-horn", "horn", "berth:w", True]])
        pl = {p[1]: p for p in self.o["planes"]}
        self.assertEqual(pl["jet:0"][0], "jet")
        self.assertEqual(pl["jet:0"][2:], [7100, 0.9], "climbing: near full thrust")
        self.assertEqual(pl["amphib:0"][0], "prop")
        self.assertEqual(pl["amphib:0"][2:], [6200, 0.6], "an unknown phase cruises")
        self.assertEqual(self.o["fountain"], ["plaza"], "the fountain 200 m off is not made at all")
        self.assertIn("fountain", self.o["loops"])

    def test_bridge_bell_and_machinery(self):
        self.assertEqual(self.o["dings"], [["bell", "bell", "bridge:br", True]])
        self.assertEqual(self.o["motor"], [[110, 0.8, "gondola", 1, 0.22, 25]])
        self.assertEqual(self.o["dings2"], 3, "a strike on each new beat and when the lamps light again")
        self.assertEqual(self.o["motor2"], [[3, 1]], "stopped as the span stops")

    def test_the_clock_strikes_through_one_held_voice(self):
        b = self.o["bells"]
        self.assertEqual(b["ring"], b["want"], "15:00: three strikes of the hour bell")
        self.assertEqual(len(b["voices"]), 1)
        made, hold, pos, moves, ends = b["voices"][0]
        self.assertTrue(made and hold and pos)
        self.assertGreaterEqual(moves, 2, "moved with the ears while it rings")
        self.assertEqual(ends, 1, "ended once the last strike died away")

    def test_nothing_below_the_street(self):
        u = self.o["under"]
        self.assertEqual(u["pools"], {"vehicle": [], "bus": [], "tram": [], "siren": [], "boat": [], "plane": [], "gondola": [], "heli": [],
                                      "fountain": [], "construction": []})
        self.assertEqual(u["horns"], 1)
        self.assertEqual(u["dings"], 3)
        self.assertEqual(u["motors"], 1)

    def test_nothing_without_ears_or_volume(self):
        empty = {"vehicle": [], "bus": [], "tram": [], "siren": [], "boat": [], "plane": [], "gondola": [], "heli": [],
                 "fountain": [], "construction": []}
        self.assertEqual(self.o["noEars"], empty)
        self.assertEqual(self.o["noEarsSets"], 0, "no listener: no loop set, no horn, no bell (nothing would be placed)")
        self.assertEqual(self.o["mute"]["pools"], empty)
        self.assertEqual(self.o["mute"]["nodes"], 0, "volume 0 (Calm, mute): not one node made")

    def test_stop_lets_everything_go(self):
        self.assertEqual(self.o["stopped"]["pools"], {})
        self.assertTrue(self.o["stopped"]["loops"])
        self.assertIsNone(self.o["noEngine"])



@unittest.skipUnless(NODE, "node is not installed")
class BridgeMachinery(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = run(fill(BRIDGES))

    def test_the_nearest_two_spans_sound_within_the_gondola_kinds_voices(self):
        m = self.o["moving"]
        self.assertEqual(m["made"], 2, "two machinery voices, not one per moving span")
        self.assertEqual(m["sks"], ["gondola", "gondola"])
        self.assertEqual(m["ids"], ["bridge:a", "bridge:b"])
        self.assertTrue(all(n >= 3 for n in m["sets"]))
        n = self.o["next"]
        self.assertEqual(n["ids"], ["bridge:b", "bridge:c"])
        self.assertEqual(n["made"], 2, "the third span takes the stopped one's voice")
        s = self.o["still"]
        self.assertEqual(s["ids"], [])
        self.assertEqual(s["stops"], [1, 1], "parked, then stopped once idle: none left running")


@unittest.skipUnless(NODE, "node is not installed")
class BellsWhileSuspended(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = run(fill(SUSPENDED))

    def test_no_strike_queues_up_at_a_frozen_clock(self):
        o = self.o
        self.assertEqual(o["first"], 1)
        self.assertEqual(o["whileSuspended"], 0, "a strike due while the audio is suspended is dropped")
        self.assertEqual(o["afterWaking"], 0, "so waking it plays no chord of every strike queued")
        self.assertEqual(o["beforeClick"], 0, "before the first click: no held voice, no strike")
        self.assertEqual(o["nextHour"], 1)
        self.assertEqual(set(o["states"]), {"running"}, "every strike rung into a running context")


@unittest.skipUnless(NODE, "node is not installed")
class Gather(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = run(fill(GATHER).replace("/*BLOCK*/", gather_block()).replace("/*TOWORLD*/", re.search(r"^function toWorld\(p, lx, lz\)\{.*$", CITY, re.M).group(0)))

    def test_the_sources_handed_over(self):
        f = self.o["f1"]
        ids = [v["id"] for v in f["traffic"]]
        self.assertEqual(ids, ["c1", "street:0", "street:1", "apron:s1|tug|9", "apron:followme3", "apron:s2|bus|3"],
                         "the drawn traffic, the v1 streets' cars, the apron's working vehicles (not the carts, the parked or odd phases)")
        t = {v["id"]: v for v in f["traffic"]}
        self.assertEqual((t["street:0"]["speed"], t["street:1"]["speed"]), (6, 2), "a car turning round goes slowly")
        self.assertEqual((t["apron:s1|tug|9"]["speed"], t["apron:s1|tug|9"]["voice"], t["apron:s1|tug|9"]["kind"]), (1, "diesel", "car"))
        self.assertEqual((t["apron:followme3"]["speed"], t["apron:followme3"]["voice"]), (8, "turbo"))
        self.assertEqual(t["apron:s2|bus|3"]["kind"], "bus")
        self.assertEqual(self.o["sirArgs"][1:], [0, 0, 650], "the sirens round the ears, 650 m out")
        self.assertEqual(self.o["bridgeArgs"], [0, 0])
        self.assertEqual(f["fountains"], [{"x": 3, "y": 1.6, "z": 4}])
        self.assertEqual([b["id"] for b in f["bells"]], ["townhall:1:bell"])
        self.assertEqual(f["bridges"], [{"id": "br"}])
        self.assertTrue(self.o["works"], "[3.35] the roadworks near you, cityevents3d's own array")
        stops, cached, args = self.o["stops"]
        self.assertEqual([s["id"] for s in stops], ["s1"], "[3.35] the bus and tram stops round the ears")
        self.assertTrue(cached, "looked up once a second, not every frame")
        self.assertEqual(args, [[0, 0, 160], [0, 0, 160]], "160 m round the ears, at most once a second")
        self.assertFalse(f["under"])
        self.assertEqual(self.o["localMs"], 0, "the bells keep the City's wall clock (Koramangala, IST)")
        self.assertEqual(self.o["madeOnce"], 1, "one citySound, kept")
        h = f["helis"]
        self.assertEqual([x["id"] for x in h], ["heli:u1"], "a near, drawn tower's helicopter only")
        self.assertAlmostEqual(h[0]["x"], 101)                    # from its lot's frame (turned 90 degrees) to the street's
        self.assertAlmostEqual(h[0]["z"], 47)
        self.assertAlmostEqual(h[0]["y"], 2 + 0.05 + 12)
        self.assertEqual(h[0]["rpm"], 4000)

    def test_hulls_heard_along_their_keel(self):
        s = {v["id"]: v for v in self.o["f1"]["ships"]}
        self.assertEqual(sorted(s), ["big:cruise0", "ferry:0", "ferry:mine"], "only the hulls in sight")
        self.assertEqual((s["ferry:0"]["x"], s["ferry:0"]["z"]), (0, -81), "ahead of its bow: heard from the bow")
        self.assertEqual(s["ferry:0"]["y"], 2.5)
        self.assertEqual(s["ferry:0"]["speed"], 5)
        a = self.o["abeam"]
        self.assertEqual((a["x"], a["z"]), (0, -100), "abeam: from amidships")
        self.assertEqual((s["big:cruise0"]["x"], s["big:cruise0"]["z"]), (500, 440), "a cruise ship's 60 m half")

    def test_horns_as_ships_sail(self):
        h = self.o["f1"]["horns"]
        self.assertEqual(self.o["f0horns"], 0)
        self.assertEqual(self.o["f2horns"], 0, "once per sailing")
        by = {x["key"]: x for x in h}
        self.assertEqual(sorted(by), ["berth:w1", "big:cruise0"], "the ferry leaving the berth, the cruise ship weighing anchor")
        f = by["berth:w1"]
        self.assertEqual(f["name"], "ferry-horn")
        self.assertAlmostEqual(f["x"], 30 - 13.6, places=6)          # the berth (30, 40) here, facing +x: the funnel 13.6 m aft
        self.assertAlmostEqual(f["z"], 40, places=6)
        self.assertAlmostEqual(f["y"], 0.2 + 5.6 + 3.2, places=6)
        c = by["big:cruise0"]
        self.assertEqual(c["name"], "ship-horn")
        self.assertAlmostEqual(c["x"], 500, places=6)
        self.assertAlmostEqual(c["z"], 470.5, places=6)
        self.assertEqual(self.o["backQuiet"][:2], [0, 0], "out of sight and back, or a long gap: no horn for what went by unheard")
        self.assertTrue(self.o["backQuiet"][2])

    def test_your_own_cruise_ship(self):
        o = self.o["own"]
        self.assertIn("big:mine", o["ships"])
        self.assertNotIn("big:cruise0", o["ships"], "yours is drawn (and heard) on its own")
        self.assertEqual(o["horns"], [["big:cruise0", "ship-horn", 670.5, 0]], "its horn from its funnel, facing +x")

    def test_aircraft_and_their_phases(self):
        p = {x["id"]: x for x in self.o["f1"]["planes"]}
        self.assertEqual(sorted(p), ["amb:0", "amphib:0", "jet:0"], "the hidden seaplane is not heard")
        self.assertEqual((p["jet:0"]["voice"], p["jet:0"]["phase"]), ("jet", "takeoff"))
        self.assertEqual((p["amphib:0"]["voice"], p["amphib:0"]["phase"]), ("prop", "taxi"))
        self.assertEqual((p["amb:0"]["voice"], p["amb:0"]["phase"]), ("jet", "cruise"))
        self.assertEqual((self.o["flight"]["voice"], self.o["flight"]["phase"]), ("prop", "climb"))

    def test_only_the_city_you_see_and_hear(self):
        self.assertTrue(self.o["under"])
        self.assertEqual(self.o["noEars"], 0, "no listener: nothing gathered")
        self.assertEqual(self.o["inactive"], 0, "another world showing: nothing")
        self.assertTrue(self.o["sirFallback"], "an older traffic.js: the drawn traffic's sirens")
        self.assertEqual(self.o["stop"], {"stops": 1, "made": 2}, "soundStop lets it go; the next frame makes a fresh one")


class Source(unittest.TestCase):
    def test_hooks(self):
        upd = CITY[CITY.index("  w.update = function(t, dt, k, cam){"):]
        upd = upd[:upd.index("\n  };\n")]
        self.assertIn("try { soundStep(); } catch(e){}", upd.rstrip().splitlines()[-1], "after everything has moved")
        dst = CITY[CITY.index("  w.destroy = function(){"):]
        self.assertIn("soundStop();", dst[:dst.index("\n  };\n")])
        self.assertIn("w.onLeave = function(){ overlays(false); soundStop(); };", CITY)

    def test_your_own_trip_stays_centred(self):
        self.assertIn("function shipSfx(n){ if(HQV.engine && HQV.engine.sfx) HQV.engine.sfx(n); }", CITY)

    def test_the_core_owns_the_listener(self):
        self.assertNotIn("E.listener(", CITY.replace("E.listenerAt", ""))


if __name__ == "__main__":
    unittest.main()
