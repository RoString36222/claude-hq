"""Sound PR B, the water, air and cab sounds: games/hqferries.js, hqgondola.js, hqhelicall.js and hqcabs.js placed in
the world through the real chain (each module's sfx -> games/hqride.js sfx -> games/engine.js spatialOut / pool) on a
fake AudioContext with a StereoPanner, the listener set as games/hq3d.js sets it.

The water buses: the horn at the wheelhouse (horn), the gangway's clank at its hinge (door), the water lapping at a
pier head (water, on the Ambient sounds bus), and the engines as held loops from a pool that keeps at most two of them
sounding, each following its hull: a few loops made in ten minutes instead of a new one every 2 s (the old leak), and the
live oscillators stay bounded. The water taxi: one held engine loop from its approach to its last moments at the pier,
then stopped; its arrival clank at the taxi. The gondola: one held rumble at the bull wheel beside you, your cabin's
clunks at its grip, the wind round your cabin as an ambient bed (silent at Ambient sounds 0%); dispose stops them. The
called helicopter: ONE rotor loop for the whole flight (no {stop: true} restarts), Doppler-shifted up as it comes and
down as it goes, stopped once it has flown out of earshot. The Claude Cab: one engine from a pool of one while it is
within earshot (none beyond 120 m), its revs from its speed, kept through the ride and stopped soon after it has gone;
its indicator and doors at the cab. At sfx volume 0 (Calm's default, mute) none of it makes a node. Skipped without
node."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
NODE = shutil.which("node")
sys.path.insert(0, HERE)
from water_fixture import synthetic_doc  # noqa: E402

HARNESS = r"""
import fs from "fs";
import path from "path";
const R0 = process.argv[1], ARGS = JSON.parse(process.argv[2]);
/* ---------- a fake AudioContext (with a StereoPanner), its clock and the page's storage ---------- */
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
const ls = {getItem: k => k in store ? store[k] : null, setItem(k, v){ store[k] = String(v); }, removeItem(k){ delete store[k]; }};
const doc = {documentElement: {classList: {contains: () => false}}, createElement: () => ({getContext: () => null, style: {}})};
globalThis.window = {HQV: {}, matchMedia: () => ({matches: false}), AudioContext: AC, localStorage: ls, document: doc};
globalThis.self = globalThis.window;
globalThis.document = doc;
new Function("window", "document", "localStorage", "performance", fs.readFileSync(path.join(R0, "games", "engine.js"), "utf8"))(window, doc, ls, {now: () => pnow*1000});
const THREE = await import(path.join(R0, "games/vendor/three-module.js"));
for (const f of ["world", "ocean", "hqboat", "hqride", "hqferries", "hqweather", "hqrail", "hqgondola", "hqnav", "hqheli", "hqhelicall", "hqcall", "hqcabs"])
  new Function(fs.readFileSync(path.join(R0, "games", f + ".js"), "utf8"))();
const H = window.HQV, WD = H.world, R = H.hqRide, E = H.engine, S = E.spatial, out = {};
const step = dt => { now += dt; pnow += dt; };
// sources (oscillators, noise) still sounding now: started and not stopped yet
const live = () => nodes.filter(n => (n.kind === "osc" || n.kind === "src") && n.started != null && !(n.stops.length && Math.max.apply(null, n.stops) <= now + 1e-9)).length;
// the bus a voice ends in: "amb" (Ambient sounds), "master", "engine" (the engines' compressor)
function busOf(v){ let n = v; for (let i = 0; i < 4 && n && n.out && n.out[0]; i++) { n = n.out[0]; if (n === ambBus) return "amb"; if (n === E.audioOut().out) return "master"; if (n.kind === "comp") return "engine"; } return null; }
const ambBus = E.ambientOut().out;
// each module's sfx, as hqtransit's: hqRide.sfx into the master with the module's {pos, kind}; every call recorded, and a
// loop's handle wrapped to record its set() and stop() calls
const calls = []; let tag = null, curMs = 0;
function sfxM(n, so){
  so = so || {};
  const A = E.audioOut(), k = nodes.length, h = A ? R.sfx(A.ctx, n, Object.assign({dest: A.out}, so)) : null;
  const c = {n, o: so, ok: !!h, tag, ms: curMs, sets: [], stops: 0, voice: so.pos && h ? nodes[k] : null};
  calls.push(c);
  if (h && h.loop) {
    const set0 = h.set, stop0 = h.stop;
    h.set = o2 => { c.sets.push({o: o2, tag, ms: curMs}); return set0(o2); };
    h.stop = () => { c.stops++; return stop0(); };
  }
  return h;
}
const near = (p, q, r) => !!p && Math.hypot(p.x - q.x, p.z - q.z) <= r;

/* ---------- the water buses (the view) ---------- */
{
  const F = H.hqFerries, W = WD.pack(JSON.parse(fs.readFileSync(ARGS.water, "utf8"))), sim = F.create(W, {tier: 5});
  const scene = new THREE.Scene(), c = {THREE, scene, mat: (col, o) => new THREE.MeshStandardMaterial(Object.assign({color: col}, o || {}))};
  const pier2 = sim.stops().filter(s => s.id === "pier:2")[0], cam = {x: pier2.x, y: 5, z: pier2.z};
  E.listener({x: cam.x, y: cam.y, z: cam.z, yaw: 0});
  calls.length = 0;
  const V = F.view(c, sim, {calm: () => false, night: () => false, sfx: sfxM});
  const T0 = 1700000000000, k0 = nodes.length;
  let maxBoat = 0, liveMax = 0;
  for (let t = 0; t < 600; t++) {
    step(1); curMs = T0 + t*1000; V.update(curMs, 1, cam);
    maxBoat = Math.max(maxBoat, (S.state().pools.boat || []).length); liveMax = Math.max(liveMax, live());
  }
  const by = n => calls.filter(q => q.n === n), vesselsAt = ms => sim.vehicles(ms);
  const nearVessel = (q, r) => vesselsAt(q.ms).some(v => near(q.o.pos, v, r));
  const horns = by("ferry-horn"), clanks = by("gangway-clank"), laps = by("water-lap"), hums = by("engine-hum");
  const P = sim.water().piers.map(p => ({x: p.x + p.fx*p.len/2, z: p.z + p.fz*p.len/2}));
  const humSets = hums.flatMap(q => q.sets);
  out.ferries = {
    horns: horns.length, hornKinds: [...new Set(horns.map(q => q.o.kind))], hornAtBoat: horns.every(q => nearVessel(q, 8)), hornHeard: horns.filter(q => q.ok).length,
    hornBus: [...new Set(horns.filter(q => q.voice).map(q => busOf(q.voice)))],
    clanks: clanks.length, clankKinds: [...new Set(clanks.map(q => q.o.kind))], clankAtBoat: clanks.every(q => nearVessel(q, 12)), clankHeard: clanks.filter(q => q.ok).length,
    clankNear: clanks.every(q => near(q.o.pos, cam, 40)),
    laps: laps.length, lapKinds: [...new Set(laps.map(q => q.o.kind))], lapAtHead: laps.every(q => P.some(h => near(q.o.pos, h, 0.01))), lapHeard: laps.filter(q => q.ok).length,
    lapBus: [...new Set(laps.filter(q => q.voice).map(q => busOf(q.voice)))],
    hums: hums.length, humHeard: hums.filter(q => q.ok).length, humKinds: [...new Set(hums.map(q => q.o.kind))], humSets: humSets.length,
    humFollows: humSets.every(s => vesselsAt(s.ms).some(v => near(s.o.pos, v, 13))), humMoves: new Set(humSets.filter(s => s.o.pos).map(s => s.o.pos.x.toFixed(2) + "," + s.o.pos.z.toFixed(2))).size,
    humBus: [...new Set(hums.filter(q => q.voice).map(q => busOf(q.voice)))],
    maxBoat, liveMax, unplaced: calls.filter(q => !q.o.pos).length};
  // the sfx volume at 0 (Calm's default, mute): nothing is made, no engine sounds
  store.hq_sfx = "0"; const k1 = nodes.length;
  for (let t = 600; t < 660; t++) { step(1); curMs = T0 + t*1000; V.update(curMs, 1, cam); }
  out.ferries.mute = {made: nodes.length - k1, pool: (S.state().pools.boat || []).length};
  store.hq_sfx = "0.5";
  V.dispose();
  out.ferries.poolAfterDispose = S.state().pools.boat || null;
}

/* ---------- the water taxi ---------- */
{
  const F = H.hqFerries, W = WD.pack(JSON.parse(fs.readFileSync(ARGS.water, "utf8"))), p0 = F.piers(W).filter(p => p.id === "pier:0")[0];
  let nowMs = 1700000000000, ear = {x: p0.x, y: p0.y + 1.6, z: p0.z};
  calls.length = 0;
  const ctl = F.taxiController(null, W, {now: () => nowMs, me: () => ({x: ear.x, z: ear.z}), sfx: sfxM, seed: "s"});
  const h = ctl.request("pier:0", "pier:3"), states = [];
  const tick = () => { nowMs += 250; curMs = nowMs; step(0.25); E.listener({x: ear.x, y: ear.y, z: ear.z, yaw: 0}); ctl.update(nowMs, 0.25); };
  let n = 0;
  tag = "coming"; while (h.state().state === "coming" && n++ < 20000) tick();
  states.push(h.state().state);
  tag = "here"; for (let i = 0; i < 20; i++) tick();
  states.push(h.board() ? h.state().state : "no");
  tag = "riding"; n = 0;
  while (h.state().state === "riding" && n++ < 40000) { const q = h.pose(nowMs); ear = {x: q.x, y: q.y + 1.2, z: q.z}; tick(); }
  states.push(h.state().state);
  tag = "after"; for (let i = 0; i < (F.TAXI.linger + 4)*4; i++) tick();
  const hums = calls.filter(q => q.n === "engine-hum"), clanks = calls.filter(q => q.n === "gangway-clank");
  const sets = hums.flatMap(q => q.sets);
  out.taxi = {states, hums: hums.length, heard: hums.filter(q => q.ok).length, kinds: [...new Set(hums.map(q => q.o.kind))], stops: hums.reduce((a, q) => a + q.stops, 0),
    setsBy: ["coming", "here", "riding", "after"].map(t => sets.filter(s => s.tag === t).length),
    clanks: clanks.map(q => ({kind: q.o.kind, ok: q.ok, d: q.o.pos ? Math.hypot(q.o.pos.x - p0.x, q.o.pos.z - p0.z) : null})), unplaced: calls.filter(q => !q.o.pos).length};
  ctl.dispose(); tag = null;
}

/* ---------- the gondola ---------- */
{
  const W = WD.pack(JSON.parse(fs.readFileSync(path.join(R0, "tests/fixtures/world_v3_tiny.json"), "utf8")));
  H.hqWeather.look = () => ({wind: 1});                                  // a gale: the wind up high
  const G = H.hqGondola, sim = G.create(W, {seed: "v"}), L = sim.loop(), Fr = sim.frame();
  const scene = new THREE.Scene(), c = {THREE, scene, mat: (col, o) => new THREE.MeshStandardMaterial(Object.assign({color: col}, o || {}))};
  calls.length = 0;
  const V = G.view(c, sim, {ground: (x, z) => WD.groundAt(W, x, z), calm: () => false, sfx: sfxM});
  V.focus("G1:0");
  const cam = {x: -180, y: 6, z: 100}; E.listener({x: cam.x, y: cam.y, z: cam.z, yaw: 0});
  const ms0 = 1.7e12;
  let liveMax = 0;
  for (let t = 0; t < L.T; t += 0.5) { step(0.5); curMs = ms0 + t*1000; V.update(curMs, 0.5, cam); liveMax = Math.max(liveMax, live()); }
  const rum = calls.filter(q => q.n === "gondola-rumble"), wind = calls.filter(q => q.n === "gondola-wind"), clunk = calls.filter(q => q.n === "gondola-clunk");
  const mine = clunk.filter(q => { const p = sim.cabins(q.ms)[0]; return near(q.o.pos, p, 1e-6); });
  out.gondola = {rumble: rum.length, rumbleOk: rum.filter(q => q.ok).length, rumbleSets: rum.reduce((a, q) => a + q.sets.length, 0), frames: L.T*2,
    rumbleBus: rum.filter(q => q.voice).map(q => busOf(q.voice)), rumbleFromA: rum.length && rum[0].o.pos ? Math.hypot(rum[0].o.pos.x - Fr.A.x, rum[0].o.pos.z - Fr.A.z) : null,
    wind: wind.length, windOk: wind.filter(q => q.ok).length, windBus: wind.filter(q => q.voice).map(q => busOf(q.voice)),
    windAtCab: wind.every(q => near(q.o.pos, sim.cabins(q.ms)[0], 1e-6)),
    clunks: clunk.length, mine: mine.length, clunkOk: clunk.filter(q => q.ok).length, clunkKinds: [...new Set(clunk.map(q => q.o.kind))], liveMax};
  // Ambient sounds at 0%: the wind's bus is silent and a fresh wind is not started; the rumble (machinery) goes on
  E.ambientSetVolume(0);
  out.gondola.amb0 = {bus: ambBus.gain.value, fresh: !!sfxM("gondola-wind", {pos: {x: cam.x, y: 20, z: cam.z}, kind: "rain"}),
                      rumble: !!sfxM("gondola-rumble", {pos: {x: cam.x, y: 6, z: cam.z}, kind: "gondola"})};
  E.ambientSetVolume(1);
  V.dispose();
  out.gondola.stopped = {rumble: rum.reduce((a, q) => a + q.stops, 0), wind: wind.reduce((a, q) => a + q.stops, 0)};
}

/* ---------- the helicopter you call ---------- */
{
  const HC = H.hqHeliCall;
  let nowMs = Date.UTC(2026, 9, 24, 12); const me = {x: 0, y: 0, z: 0};
  E.listener({x: 0, y: 1.6, z: 0, yaw: 0});
  calls.length = 0;
  const C = HC.mount(null, {W: null, me: () => me, ground: () => 0, now: () => nowMs}, {sfx: sfxM, announce: () => {}});
  const hh = C.call({id: "open:0:0", x: 0, y: 0, z: 0, kind: "open", name: "Open"}, {own: null}), phases = [];
  const tick = () => { nowMs += 100; curMs = nowMs; step(0.1); tag = C.current() ? C.current().state().phase : null; C.update(nowMs, 0.1); };
  let n = 0;
  while (hh.state().phase === "coming" && n++ < 6000) tick();
  phases.push(hh.state().phase);
  for (let i = 0; i < 50; i++) tick();                                   // five seconds on the ground, the rotor turning
  C.fly({id: "open:600:0", x: 600, y: 0, z: 0, kind: "open", name: "Harbour"}); phases.push(C.use() ? hh.state().phase : "no");
  n = 0; while (hh.state().phase === "riding" && n++ < 20000) tick();
  phases.push(hh.state().phase);
  n = 0; while (C.current() && n++ < 20000) tick();                     // it lifts off again and flies away
  const rot = calls.filter(q => q.n === "rotor"), sets = rot.flatMap(q => q.sets);
  const rates = t => sets.filter(s => s.tag === t).map(s => s.o.rate);
  out.heli = {phases, gone: C.current() === null, rotors: rot.length, ok: rot.filter(q => q.ok).length, kinds: [...new Set(rot.map(q => q.o.kind))],
    stops: rot.reduce((a, q) => a + q.stops, 0), sets: sets.length, stopOpt: calls.filter(q => q.o.stop).length,
    comingMax: Math.max.apply(null, rates("coming")), comingMin: Math.min.apply(null, rates("coming")), leaving: rates("leaving").slice(-50), here: rates("here").slice(0, 5),
    follows: sets.every(s => !!s.o.pos && isFinite(s.o.pos.x) && isFinite(s.o.pos.y) && isFinite(s.o.pos.z)), bus: rot.filter(q => q.voice).map(q => busOf(q.voice))};
  C.dispose(); tag = null;
}

/* ---------- the Claude Cab ---------- */
function fakeCall(){
  return {
    kerb(road){ return {x: road.x, z: road.z, yaw: 0}; }, arrival(){ return [0, 1]; },
    pathFor(pts, spot){ return Float64Array.from([pts[0], pts[1], spot.x, spot.z]); },
    run(P){ const len = Math.hypot(P[2] - P[0], P[3] - P[1]); return {P, len, s: 0, v: 0, x: P[0], z: P[1], yaw: Math.atan2(P[2] - P[0], P[3] - P[1]), done: len < 0.01}; },
    step(R, dt){ if(R.done) return R; R.v = 12; R.s = Math.min(R.len, R.s + 12*dt); const f = R.len ? R.s/R.len : 1; R.x = R.P[0] + (R.P[2] - R.P[0])*f; R.z = R.P[1] + (R.P[3] - R.P[1])*f; if(R.s >= R.len){ R.done = true; R.v = 0; } return R; },
    pointAt(R, s){ const f = R.len ? s/R.len : 1; return {x: R.P[0] + (R.P[2] - R.P[0])*f, z: R.P[1] + (R.P[3] - R.P[1])*f}; },
    etaOf(R){ return Math.max(1, Math.round((R.len - R.s)/12)); }
  };
}
{
  const CB = H.hqCabs, me = {x: 0, y: 0, z: 0, speed: 0, driving: false};
  let engines = 0, engStops = 0, voices = [];
  const es0 = E.engineSound;
  E.engineSound = function(k, ex, real){ engines++; voices.push(k); const h = es0(k, ex, real), st = h.stop; h.stop = () => { engStops++; return st(); }; return h; };
  let ear = {x: 0, y: 1.6, z: 0};
  calls.length = 0;
  const C = CB.mount(null, {W: null, me: () => me, seed: "claude-hq@3"}, {call: fakeCall(), announce: () => {}, sfx: sfxM});
  let t = Date.UTC(2026, 9, 24, 12), track = [];
  const tick = dt => { t += dt*1000; curMs = t; step(dt); E.listener({x: ear.x, y: ear.y, z: ear.z, yaw: 0}); C.update(t, dt); };
  const hd = C.request({x: 3000, z: 0, name: "Harbour Street"}, "cab", t);
  let n = 0;
  while (hd.state().phase === "matching" && n++ < 200) tick(0.1);
  while (hd.state().phase === "coming" && n++ < 20000) { tick(0.1); track.push([hd.state().metres, (S.state().pools.vehicle || []).slice()]); }
  for (let i = 0; i < 30; i++) tick(0.1);                                // it waits at the kerb, idling
  const idle = (S.state().pools.vehicle || []).slice();
  const boarded = C.use(); hd.skip();
  while (hd.state().phase === "riding" && n++ < 40000) { const q = C.carry(t); if (q) ear = {x: q.x, y: q.y + 1.2, z: q.z}; tick(0.1); }
  const riding = (S.state().pools.vehicle || []).slice();
  for (let i = 0; i < 130; i++) tick(0.1);                               // 8 s at the kerb, then gone; idle 2 s
  const far = track.filter(r => r[0] > 125), close = track.filter(r => r[0] < 110);
  out.cab = {boarded, engines, voices, engStops, idle, riding, after: S.state().pools.vehicle || [],
    farSilent: far.length > 0 && far.every(r => r[1].length === 0), closeOne: close.length > 0 && close.every(r => r[1].length === 1 && /^cab:/.test(r[1][0])),
    sounds: calls.map(q => [q.n, q.o.kind || null, q.ok]),
    revs: CB.revs ? [0, 2, 4.4, 4.6, 8, 12, 20, 30].map(v => Math.round(CB.revs(v))) : [], revsEv: CB.revs ? [0, 10, 20, 40, 60].map(v => Math.round(CB.revs(v, true))) : [],
    classVoices: CB.voices || {}};
  // sfx volume 0: a cab coming to you makes no engine
  store.hq_sfx = "0"; const e0 = engines, k = nodes.length;
  const h2 = C.request({x: -500, z: 0, name: "Market"}, "go", t); n = 0;
  while (h2.state().phase !== "here" && n++ < 6000) tick(0.1);
  out.cab.mute = {engines: engines - e0, made: nodes.length - k, phase: h2.state().phase};
  store.hq_sfx = "0.5";
  C.dispose(); E.engineSound = es0;
}
console.log(JSON.stringify(out));
"""


def _run():
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(synthetic_doc(), fh)
        water = fh.name
    try:
        r = subprocess.run([NODE, "--input-type=module", "-e", HARNESS, ROOT, json.dumps({"water": water})],
                           capture_output=True, text=True, timeout=600)
    finally:
        os.unlink(water)
    if r.returncode != 0:
        raise AssertionError(r.stderr[-4000:])
    return json.loads(r.stdout.strip().splitlines()[-1])


@unittest.skipUnless(NODE, "node not installed")
class TransitWaterAirCabsSound(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = _run()

    def test_water_buses(self):
        f = self.o["ferries"]
        self.assertEqual(f["unplaced"], 0, "every water sound is where it is")
        self.assertGreater(f["horns"], 0)
        self.assertEqual(f["hornKinds"], ["horn"])
        self.assertTrue(f["hornAtBoat"], "the horn sounds from its boat")
        self.assertGreater(f["hornHeard"], 0)
        self.assertEqual(f["hornBus"], ["master"])
        self.assertGreater(f["clanks"], 0)
        self.assertEqual(f["clankKinds"], ["door"])
        self.assertTrue(f["clankAtBoat"])
        self.assertTrue(f["clankNear"], "a gangway is heard like a door: within 40 m")
        self.assertGreater(f["clankHeard"], 0)
        self.assertGreater(f["laps"], 0, "the water laps at the pier (silent before Sound PR B)")
        self.assertEqual(f["lapKinds"], ["water"])
        self.assertTrue(f["lapAtHead"], "at a pier's head")
        self.assertGreater(f["lapHeard"], 0)
        self.assertEqual(f["lapBus"], ["amb"], "water is an ambient sound")

    def test_water_bus_engines_are_pooled_held_loops(self):
        f = self.o["ferries"]
        self.assertGreater(f["humHeard"], 0)
        self.assertEqual(f["humKinds"], ["boat"])
        # ten minutes beside a pier: a handful of loops (made as boats come near, handed on), not one every 2 s
        self.assertLessEqual(f["hums"], 8)
        self.assertLessEqual(f["maxBoat"], 2, "only the nearest two engines sound at once")
        self.assertGreater(f["humSets"], 100, "moved every frame")
        self.assertTrue(f["humFollows"], "each engine at its hull")
        self.assertGreater(f["humMoves"], 20)
        self.assertEqual(f["humBus"], ["master"])
        self.assertLessEqual(f["liveMax"], 16, "the oscillators and noise sources stay bounded (no leak)")
        self.assertEqual(f["mute"], {"made": 0, "pool": 0}, "sfx volume 0: nothing at all")
        self.assertIsNone(f["poolAfterDispose"], "dispose stops the pool")

    def test_water_taxi(self):
        x = self.o["taxi"]
        self.assertEqual(x["states"], ["here", "riding", "done"])
        self.assertEqual(x["hums"], 1, "one engine loop for the whole trip")
        self.assertEqual(x["heard"], 1)
        self.assertEqual(x["kinds"], ["boat"])
        coming, here, riding, after = x["setsBy"]
        self.assertGreater(coming, 0); self.assertGreater(here, 0); self.assertGreater(riding, 100)
        self.assertEqual(x["stops"], 1, "stopped once it has gone")
        self.assertEqual(len(x["clanks"]), 1)
        c = x["clanks"][0]
        self.assertEqual(c["kind"], "door"); self.assertTrue(c["ok"]); self.assertLess(c["d"], 15)
        self.assertEqual(x["unplaced"], 0)

    def test_gondola(self):
        g = self.o["gondola"]
        self.assertEqual(g["rumble"], 1, "one held rumble at the bull wheel beside you (it was a new loop every 4 s)")
        self.assertEqual(g["rumbleOk"], 1)
        self.assertGreaterEqual(g["rumbleSets"], g["frames"] - 2)
        self.assertLess(g["rumbleFromA"], 25)
        self.assertEqual(g["rumbleBus"], ["master"])
        self.assertLessEqual(g["wind"], 2, "a held wind loop (it was a new one every 6 s)")
        self.assertGreater(g["windOk"], 0)
        self.assertTrue(g["windAtCab"])
        self.assertTrue(g["windBus"] and all(b == "amb" for b in g["windBus"]), "the wind is weather: Ambient sounds")
        self.assertEqual(g["mine"], 4, "your cabin: each of the two towers, both ways")
        self.assertGreater(g["clunks"], g["mine"], "the other cabins' grips within earshot too")
        self.assertGreater(g["clunkOk"], 0)
        self.assertEqual(g["clunkKinds"], ["gondola"])
        self.assertLessEqual(g["liveMax"], 16)
        a = g["amb0"]
        self.assertEqual(a["bus"], 0)
        self.assertFalse(a["fresh"], "Ambient sounds 0%: no wind")
        self.assertTrue(a["rumble"], "the machinery is not ambient")
        self.assertGreaterEqual(g["stopped"]["rumble"], 1, "dispose stops the loops")
        self.assertGreaterEqual(g["stopped"]["wind"], 1)

    def test_called_helicopter(self):
        h = self.o["heli"]
        self.assertEqual(h["phases"], ["here", "riding", "done"])
        self.assertTrue(h["gone"])
        self.assertEqual(h["rotors"], 1, "ONE rotor loop for the whole flight (it was a new one every 400 ms)")
        self.assertEqual(h["ok"], 1)
        self.assertEqual(h["kinds"], ["heli"])
        self.assertEqual(h["stopOpt"], 0, "no {stop: true}: the handle is stopped")
        self.assertEqual(h["stops"], 1, "stopped once out of earshot")
        self.assertGreater(h["sets"], 500)
        self.assertTrue(h["follows"])
        # it sets off from a hover 1.4 km out and comes at you at up to 45 m/s: 343/(343 - 45) ~ 1.15 at its fastest
        self.assertGreater(h["comingMax"], 1.1, "coming at you: pitched up")
        self.assertGreater(h["comingMin"], 0.99, "never pitched down on the way in")
        self.assertTrue(h["leaving"] and all(r < 0.97 for r in h["leaving"]), "flying away: pitched down")
        self.assertTrue(h["here"] and all(abs(r - 1) < 1e-6 for r in h["here"]), "on the ground, rotor turning: no shift")
        self.assertEqual(h["bus"], ["engine"])

    def test_cab_engine(self):
        c = self.o["cab"]
        self.assertTrue(c["boarded"])
        self.assertEqual(c["engines"], 1, "one engine for the whole ride")
        self.assertEqual(c["voices"], ["turbo"], "a saloon's turbo four (no catalogue here)")
        self.assertTrue(c["farSilent"], "beyond earshot (120 m): no voice")
        self.assertTrue(c["closeOne"], "within earshot: the cab's own voice")
        self.assertEqual(len(c["idle"]), 1, "idling at the kerb")
        self.assertEqual(len(c["riding"]), 1, "driving you")
        self.assertEqual(c["after"], [], "gone with the cab")
        self.assertGreaterEqual(c["engStops"], 1, "and stopped")
        names = [s[0] for s in c["sounds"]]
        self.assertEqual(names, ["chime", "indicator", "door-chime", "door-chime"])
        kinds = {s[0]: s[1] for s in c["sounds"]}
        self.assertIsNone(kinds["chime"])
        self.assertEqual(kinds["indicator"], "vehicle")
        self.assertEqual(kinds["door-chime"], "door")
        self.assertTrue(all(s[2] for s in c["sounds"]), "each heard")
        r = c["revs"]
        self.assertEqual(r[0], 900, "idle")
        self.assertTrue(all(900 <= x <= 3500 for x in r))
        self.assertLess(r[1], r[2]); self.assertGreater(r[2], r[3], "changing up into second")
        e = c["revsEv"]
        self.assertEqual(e, sorted(e)); self.assertEqual(e[0], 900)
        self.assertEqual(set(c["classVoices"]), {"bike", "go", "cab", "xl", "lux"})
        self.assertEqual(c["classVoices"]["lux"], "electric")
        self.assertEqual(c["mute"]["engines"], 0)
        self.assertEqual(c["mute"]["made"], 0, "sfx volume 0: nothing at all")
        self.assertEqual(c["mute"]["phase"], "here")

    def test_house_rules(self):
        for f in ("hqferries.js", "hqgondola.js", "hqhelicall.js", "hqcabs.js", "hqphonecabs.js"):
            with open(os.path.join(ROOT, "games", f), encoding="utf-8") as fh:
                src = fh.read()
            self.assertFalse("Math.random" in src, f)
            self.assertFalse("innerHTML" in src, f)
            self.assertFalse("{stop: true}" in src, f + ": a loop is stopped through its handle")


if __name__ == "__main__":
    unittest.main()
