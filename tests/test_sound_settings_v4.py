"""City Gen v4, sound and settings (HQ 3.35.0): the plan's checklist for the Ambient sounds slider and proximity sound.

Under node with a fake AudioContext (no real audio), games/engine.js's spatial layer is checked against the plan:
the Ambient sounds slider (localStorage hq_ambient, 0..1) migrates the old on/off switch ("1" on is 100%, "0" off is
0%, unset 100%), its value is the ambient bus's gain, and thunder, rain, fireworks, jets, water and the city's hum
(and fountains, roadworks) go through that bus and stop at 0%; the distance fade is the inverse model (full volume
inside each kind's reference distance, falling, exactly 0 at its maximum and past it); the pan follows the source's
side of the camera; under load (50 cars round you) only the vehicle kind's nearest few get a voice; every source kind
the plan lists is in the kinds table and wired by a module that plays it; nothing plays at master volume 0 (mute,
Calm's default). Then the City's own sound (games/hqcity3d.js citySound): the roadworks near you through the
construction kind's pool, the fountains through the fountain kind's, and a bus or tram at its stop opening its doors
and pulling away with its bell. Skipped without node. Stdlib only."""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

FAKE = r"""
const fs = require('fs'), path = require('path'), R0 = process.argv[1];
let now = 0, pnow = 0, made = 0; const store = {}, nodes = [];
function param(v){ const p = {value: v, ev: [],
  setTargetAtTime(x, t, tc){ p.ev.push(['T', x, t, tc]); }, cancelScheduledValues(t){ p.ev = p.ev.filter(e => e[2] < t); },
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
  createBuffer(c, n){ const d = new Float32Array(n); return {getChannelData: () => d}; } }
const window = {HQV: {}, matchMedia: () => ({matches: false}), AudioContext: AC};
const document = {documentElement: {classList: {contains: () => false}}};
global.window = window; global.self = window;
global.localStorage = {getItem: k => k in store ? store[k] : null, setItem(k, v){ store[k] = String(v); }, removeItem(k){ delete store[k]; }};
global.performance = {now: () => pnow*1000};
new Function('window', 'document', fs.readFileSync(path.join(R0, 'games', 'engine.js'), 'utf8'))(window, document);
const E = window.HQV.engine, S = E.spatial, out = {};
const lastT = p => { const e = p.ev.filter(x => x[0] === 'T'); return e.length ? e[e.length - 1][1] : p.value; };
const r4 = x => Math.round(x*1e4)/1e4;
"""

ENGINE = FAKE + r"""
// ---- the slider: the old switch's values, the bus's gain, applied live ----
const vol = v => { if(v === undefined) delete store.hq_ambient; else store.hq_ambient = v; return E.ambientVolume(); };
out.migrate = {on: vol('1'), off: vol('0'), unset: vol(undefined), empty: vol(''), junk: vol('yes'), half: vol('0.5'), over: vol('7')};
store.hq_sfx = '0.5'; delete store.hq_ambient;
E.listener({x: 0, y: 0, z: 0, yaw: 0});
const t0 = E.spatialOut('thunder', {x: 0, y: 0, z: 50}, {gain: 1});            // makes the context and its buses
const bus = o => { let n = o; for(let i = 0; i < 4 && n && n.out && n.out.length; i++){ n = n.out[0]; if(n.kind === 'gain' && n !== o) return n; } return null; };
const amb = bus(t0.out), master = amb && amb.out[0];
out.ambStart = amb ? amb.gain.value : null;
const setAt = v => { E.ambientSetVolume(v); return [store.hq_ambient, r4(lastT(amb.gain))]; };
out.ambSet = [setAt(0.3), setAt(0), setAt(1)];
out.masterIsSfx = master ? master.gain.value : null;
// each ambient kind reaches the ambient bus; at 0% none of them makes a voice
out.ambKinds = ['thunder', 'rain', 'firework', 'jet', 'water', 'hum', 'fountain', 'construction', 'plane', 'civicbell'].map(k => {
  const V = E.spatialOut(k, {x: 0, y: 0, z: 1}, {gain: 1, hold: true}), into = V ? bus(V.out) : null;
  if(V) V.end(0);
  return [k, S.KINDS[k].bus, into === amb];
});
E.ambientSetVolume(0);
const k0 = nodes.length;
out.atZero = ['thunder', 'rain', 'firework', 'jet', 'water', 'hum', 'construction'].map(k => E.spatialOut(k, {x: 0, y: 0, z: 1}, {hold: true}));
['rain', 'hum', 'water', 'jet-roar', 'works', 'fountain'].forEach(n => E.loop(n).set(1, {pos: {x: 0, y: 0, z: 2}}));
out.atZeroNodes = nodes.length - k0;
out.vehicleAtZero = !!E.spatialOut('vehicle', {x: 0, y: 0, z: 1}, {hold: true});   // engines are not ambient
E.ambientSetVolume(1);
// ---- the inverse-distance curve, every kind ----
const kinds = Object.keys(S.KINDS).filter(k => isFinite(S.KINDS[k].max));
out.curve = kinds.map(k => {
  const K = S.KINDS[k], ds = [0, K.ref*0.5, K.ref], fall = [];
  for(let i = 1; i <= 20; i++) fall.push(K.ref + (K.max - K.ref)*i/21);
  const g = fall.map(d => S.falloff(k, d)), inv = S.falloff(k, K.ref + 0.001*(K.max - K.ref));
  return {k, inside: ds.map(d => S.falloff(k, d)), falling: g.every((x, i) => i === 0 || x < g[i - 1]) && g.every(x => x > 0 && x < 1),
          atMax: S.falloff(k, K.max), past: S.falloff(k, K.max*2), invNearRef: r4(inv), invWant: r4(K.ref/(K.ref + K.roll*0.001*(K.max - K.ref)))};
});
// ---- the pan: the source's side of the camera, for a yaw listener and a turned one ----
const L0 = {x: 0, y: 0, z: 0, yaw: 0}, L1 = {x: 0, y: 0, z: 0, yaw: Math.PI/2};
out.pan = {right0: S.panOf(L0, {x: -20, y: 0, z: 0}, 5), left0: S.panOf(L0, {x: 20, y: 0, z: 0}, 5), ahead0: S.panOf(L0, {x: 0, y: 0, z: 20}, 5),
           right1: S.panOf(L1, {x: 0, y: 0, z: 20}, 5), left1: S.panOf(L1, {x: 0, y: 0, z: -20}, 5)};
E.listener({x: 0, y: 0, z: 0, yaw: 0});
const hr = E.hear('tram', {x: -30, y: 0, z: 0}), hl = E.hear('tram', {x: 30, y: 0, z: 0});
out.hearPan = [hr.pan > 0, hl.pan < 0, r4(hr.g) === r4(hl.g)];
// ---- nearest N under load: 50 cars round you, a few voices ----
let makes = 0; const playing = new Set();
const P = E.pool('vehicle', {make: s => { makes++; return {set(){}, stop(){}}; }, play: (h, s) => playing.add(s.id)});
const cars = []; for(let i = 0; i < 50; i++){ const a = i*2.4, r = 6 + i*2; cars.push({id: 'c' + i, x: Math.cos(a)*r, y: 0, z: Math.sin(a)*r}); }
const ids = P.update(cars); now += 0.05; pnow += 0.05; const ids2 = P.update(cars);
out.load = {ids, again: ids2, makes, cap: S.KINDS.vehicle.voices};
P.stop();
// ---- master mute: nothing at all ----
store.hq_sfx = '0';
const m0 = nodes.length;
const P2 = E.pool('vehicle', {make: () => ({set(){}, stop(){}}), play(){}});
out.mute = {out: E.spatialOut('tram', {x: 0, y: 0, z: 3}), at: E.sfxAt('bell', {x: 0, y: 0, z: 3}), pool: P2.update(cars),
            ambOut: E.ambientOut(), audioOut: E.audioOut()};
E.loop('tram-run').set(1, {pos: {x: 0, y: 0, z: 3}, speed: 5}); E.loop('works').set(1, {pos: {x: 0, y: 0, z: 3}});
E.sfx('ui'); E.engineSound('turbo').set(3000, {pos: {x: 0, y: 0, z: 3}, sk: 'vehicle'}); E.noiseLoop(800, 1, 'water').set(0.5, 800, {x: 0, y: 0, z: 3});
out.mute.nodes = nodes.length - m0;
console.log(JSON.stringify(out));
"""

CITY = FAKE + r"""
for (const f of ['hqride', 'traffic', 'hqcivic', 'hqships', 'hqcity3d']) new Function(fs.readFileSync(path.join(R0, 'games', f + '.js'), 'utf8'))();
const HQV = window.HQV, C3 = HQV.hqCity3d, R = HQV.hqRide;
store.hq_sfx = '0.5';
const loops = [], rides = [], realLoop = E.loop, realRide = R.sfx;
E.loop = function(name){ loops.push(name); return realLoop.apply(E, arguments); };
R.sfx = function(ctx, name, o){ const h = realRide.apply(R, arguments); rides.push([name, o && o.kind, !!h]); return h; };
E.listener({x: 0, y: 1.6, z: 0, yaw: 0});
const snd = C3.citySound();
let ms = 1e12;
function frame(src){ now += 0.1; pnow += 0.1; ms += 100; snd.update(Object.assign({localMs: ms}, src)); }
// roadworks: the nearest two of three sites, through the construction kind's pool; fountains through theirs
const works = [{id: 'works:a', x: 20, y: 1, z: 0}, {id: 'works:b', x: 0, y: 1, z: 60}, {id: 'works:c', x: 0, y: 1, z: -150}, {id: 'works:d', x: 400, y: 1, z: 0}];
const founts = [{id: 'f1', x: 5, y: 1.6, z: 5}, {id: 'f2', x: -10, y: 1.6, z: 0}, {id: 'f3', x: 30, y: 1.6, z: 0}];
frame({works, fountains: founts});
let st = S.state();
out.works = st.pools.construction; out.fount = st.pools.fountain; out.loops = loops.slice().sort();
store.hq_ambient = '0'; frame({works, fountains: founts}); out.worksAtZero = S.state().pools.construction; delete store.hq_ambient;
frame({under: true, works}); out.worksUnder = S.state().pools.construction;
// a bus comes to rest at its stop, waits, and pulls away; a tram the same; a bus stopped away from any stop (a light)
const stops = [{id: 's1', x: 10, y: 0, z: 10}, {id: 's2', x: -12, y: 0, z: 30}];
const veh = (id, kind, x, z, speed) => ({id, kind, x, y: 0, z, speed});
const seq = [];
for(let i = 0; i < 15; i++){
  const go = i >= 12 ? 5 : 0;
  rides.length = 0;
  frame({stops, traffic: [veh('b1', 'bus', 12, 8, go), veh('t1', 'tram', -12, 22, go), veh('b2', 'bus', 60, 0, go)]});
  if(rides.length) seq.push([i].concat(rides.map(r => r.slice(0, 2).join('/'))));
}
out.halts = seq;
// muted: the doors still follow, but nothing is played
store.hq_sfx = '0'; rides.length = 0;
for(let i = 0; i < 15; i++) frame({stops, traffic: [veh('b3', 'bus', 12, 8, i >= 12 ? 5 : 0)]});
out.mutedRides = rides.length; store.hq_sfx = '0.5';
snd.stop();
out.stopped = S.state().pools;
console.log(JSON.stringify(out));
"""


def run(script):
    r = subprocess.run([NODE, "-e", script, ROOT], capture_output=True, text=True, timeout=120, env=dict(os.environ, TZ="UTC"))
    if r.returncode != 0:
        raise AssertionError("node failed:\n" + r.stderr[-4000:])
    return json.loads(r.stdout.strip().splitlines()[-1])


def read(*p):
    with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
        return f.read()


# the plan's source list -> the kinds it plays through (games/engine.js KINDS)
PLAN = {"vehicles": "vehicle", "trams": "tram", "trains": "train", "the metro": "metro", "boats": "boat",
        "helicopters": "heli", "planes": "plane", "jets": "jet", "doors": "door", "bells": "bell",
        "gondola machinery": "gondola", "construction": "construction", "fountains": "fountain"}


@unittest.skipUnless(NODE, "node is not installed")
class Engine(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = run(ENGINE)

    def test_the_old_switch_migrates(self):
        m = self.o["migrate"]
        self.assertEqual((m["on"], m["off"]), (1, 0), "the old switch's On is 100%, its Off 0%")
        self.assertEqual((m["unset"], m["empty"], m["junk"]), (1, 1, 1), "unset or garbage: 100%, today's loudness")
        self.assertEqual((m["half"], m["over"]), (0.5, 1))

    def test_the_slider_is_the_ambient_bus_gain(self):
        self.assertEqual(self.o["ambStart"], 1)
        self.assertEqual(self.o["ambSet"], [["0.3", 0.3], ["0", 0], ["1", 1]], "stored and glided to at once (live)")
        self.assertEqual(self.o["masterIsSfx"], 0.5, "the ambient bus feeds the master (Game sounds) volume")

    def test_the_ambient_sounds_go_through_it(self):
        for k, b, into in self.o["ambKinds"]:
            self.assertEqual(b, "ambient", k)
            self.assertTrue(into, k + " reaches the ambient bus")
        self.assertEqual(self.o["atZero"], [None] * 7, "at 0% no ambient voice is made")
        self.assertEqual(self.o["atZeroNodes"], 0, "and no ambient loop builds a node")
        self.assertTrue(self.o["vehicleAtZero"], "engines are not ambient: Ambient 0% leaves them")

    def test_inverse_distance_curve(self):
        self.assertGreater(len(self.o["curve"]), 15)
        for c in self.o["curve"]:
            self.assertEqual(c["inside"], [1, 1, 1], c["k"] + ": full volume inside ref")
            self.assertTrue(c["falling"], c["k"] + ": falls between ref and max")
            self.assertEqual((c["atMax"], c["past"]), (0, 0), c["k"] + ": silent at max and past it")
            self.assertAlmostEqual(c["invNearRef"], c["invWant"], places=3, msg=c["k"] + ": the inverse model just past ref")

    def test_pan_follows_the_source_side(self):
        p = self.o["pan"]
        self.assertGreater(p["right0"], 0)
        self.assertLess(p["left0"], 0)
        self.assertEqual(p["ahead0"], 0)
        self.assertGreater(p["right1"], 0, "turned a quarter: +z is now on the right")
        self.assertLess(p["left1"], 0)
        self.assertEqual(self.o["hearPan"], [True, True, True])

    def test_nearest_few_under_load(self):
        L = self.o["load"]
        self.assertEqual(len(L["ids"]), L["cap"], "50 cars, only the kind's voices")
        self.assertEqual(L["ids"], ["c%d" % i for i in range(L["cap"])], "the nearest ones")
        self.assertEqual(L["again"], L["ids"])
        self.assertEqual(L["makes"], L["cap"], "a voice made once per slot, reused next frame")

    def test_nothing_at_master_mute(self):
        m = self.o["mute"]
        self.assertIsNone(m["out"])
        self.assertFalse(m["at"])
        self.assertEqual(m["pool"], [])
        self.assertIsNone(m["ambOut"])
        self.assertIsNone(m["audioOut"])
        self.assertEqual(m["nodes"], 0, "not one node made")


@unittest.skipUnless(NODE, "node is not installed")
class CityWiring(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = run(CITY)

    def test_roadworks_and_fountains_through_their_pools(self):
        self.assertEqual(self.o["works"], ["works:a", "works:b"], "the nearest two sites within 200 m")
        self.assertIn("works", self.o["loops"])
        self.assertEqual(self.o["fount"], ["f1", "f2"], "the fountain kind's two voices")
        self.assertEqual(self.o["worksAtZero"], [], "Ambient sounds at 0%: no roadworks")
        self.assertEqual(self.o["worksUnder"], [], "below the street: none")

    def test_doors_and_bells_at_the_stops(self):
        h = self.o["halts"]
        self.assertEqual([e[1:] for e in h], [["door-hiss/door", "door-hiss/door"], ["door-hiss/door", "tram-bell/bell"]],
                         "the doors open at rest at a stop; moving off: the bus's doors, the tram's bell")
        self.assertTrue(all(len(e) == 3 for e in h), "the bus away from a stop (at a light) stays shut")
        self.assertEqual(h[1][0], 12)

    def test_muted_and_stopped(self):
        self.assertEqual(self.o["mutedRides"], 0)
        self.assertEqual(self.o["stopped"], {})


class Registry(unittest.TestCase):
    def test_every_plan_kind_is_in_the_table(self):
        eng = read("games", "engine.js")
        table = eng[eng.index("var KINDS = {"):eng.index("var GENERIC")]
        for name, k in PLAN.items():
            m = re.search(r"^\s*" + k + r":\s*\{ref:\s*([\d.]+),\s*max:\s*([\d.]+),\s*roll:\s*[\d.]+,\s*voices:\s*(\d+)", table, re.M)
            self.assertIsNotNone(m, name)
            ref, mx, voices = float(m.group(1)), float(m.group(2)), int(m.group(3))
            self.assertLess(ref, mx, name)
            self.assertGreater(voices, 0, name + ": a voice cap")

    def test_total_voices_are_capped(self):
        eng = read("games", "engine.js")
        table = eng[eng.index("var KINDS = {"):eng.index("var GENERIC")]
        caps = [int(v) for v in re.findall(r"voices:\s*(\d+)", table)]
        self.assertLessEqual(sum(caps), 72, "every kind's cap together bounds the voices a busy place can cost")

    def test_every_plan_kind_is_wired(self):
        games = os.path.join(ROOT, "games")
        src = ""
        for f in sorted(os.listdir(games)):
            if f.endswith(".js") and f != "engine.js":
                src += read("games", f)
        wire = {
            "vehicle": r'pool\("vehicle"', "tram": r'pool\("tram"', "train": r'pool\("train"', "metro": r'pool\("metro"',
            "boat": r'pool\("boat"', "heli": r'pool\("heli"', "plane": r'pool\("plane"', "jet": r'pool\("jet"',
            "door": r'kind: "door"', "bell": r'"tram-bell"', "gondola": r'pool\("gondola"', "construction": r'pool\("construction"',
            "fountain": r'pool\("fountain"'}
        for name, k in PLAN.items():
            self.assertRegex(src, wire[k], name + " has a module that plays it")

    def test_city_sound_only_while_the_city_is_open(self):
        city = read("games", "hqcity3d.js")
        step = city[city.index("  function soundStep(){"):]
        step = step[:step.index("\n  }\n")]
        self.assertIn("if(!L || (c.active && !c.active(w))) return;", step, "no ears or another world showing: no audio work")

    def test_settings_row(self):
        html = read("index.html")
        self.assertRegex(html, r'<input id="setAmbient" type="range" min="0" max="100" step="5" aria-describedby="setAmbientHint">')
        self.assertNotRegex(html, r'id="setAmbient"[^>]*type="checkbox"', "the old switch is gone")
        js = read("ui", "app", "16-settings.js")
        self.assertIn('r.setAttribute("aria-valuetext", v ? v+"%" : "Off")', js)


if __name__ == "__main__":
    unittest.main()
