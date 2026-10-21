"""The engine note (games/engine.js engineSound, HQ 3.5.7): real-engine profiles (firing frequency
= rpm/60 * cylinders/2), the catalogue's vehicles on the right voice, no AudioNode made per frame,
silence when muted, an upshift's cut, a turbo's blow-off and the overrun crackle. Node with a fake
AudioContext that has the whole API (PeriodicWave, WaveShaper, compressor). Skipped without node."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SCRIPT = r"""
const fs = require('fs');
let now = 0, made = 0, vol = '0.5'; const gains = [], oscs = [], filters = [];
function param(v){ const p = {value: v, ev: [], setTargetAtTime(x, t){ p.ev.push(['T', x, t]); },
  cancelScheduledValues(t){ p.ev = p.ev.filter(e => e[2] < t); }, setValueAtTime(x, t){ p.ev.push(['V', x, t]); },
  exponentialRampToValueAtTime(){}}; return p; }
function node(){ made++; return {connect(){}, start(){}, stop(){ this.stopped = true; }, frequency: param(0), detune: param(0), Q: param(0), type: '',
  setPeriodicWave(w){ this.type = 'custom'; this.wave = w; }}; }
class AC { constructor(){ this.state = 'running'; this.sampleRate = 8000; this.destination = {}; }
  get currentTime(){ return now; } resume(){ return Promise.resolve(); }
  createGain(){ const n = node(); n.gain = param(1); gains.push(n.gain); return n; }
  createOscillator(){ const n = node(); oscs.push(n); return n; }
  createBiquadFilter(){ const n = node(); filters.push(n); return n; } createBufferSource(){ return node(); }
  createWaveShaper(){ return node(); } createPeriodicWave(re, im){ made++; return {re, im}; }
  createDynamicsCompressor(){ const n = node(); ['threshold', 'knee', 'ratio', 'attack', 'release'].forEach(k => n[k] = param(0)); return n; }
  createBuffer(c, n){ made++; const d = new Float32Array(n); return {getChannelData: () => d}; } }
const window = {HQV: {}, matchMedia: () => ({matches: false}), AudioContext: AC};
const document = {documentElement: {classList: {contains: () => false}}};
global.localStorage = {getItem: () => vol, setItem(){}};
global.performance = {now: () => 0};
new Function('window', 'document', fs.readFileSync(process.argv[2], 'utf8'))(window, document);
new Function('window', fs.readFileSync(process.argv[3], 'utf8'))(window);
const E = window.HQV.engine, P = window.HQV.hqVehiclePhys, out = {};
const last = p => p.ev[p.ev.length - 1];
// the firing frequency: a V8 at 6000 rpm fires 400 times a second, a single at 6000 only 50
out.hz = {};
for (const k of E.engines) out.hz[k] = [E.engineHz(k, 900).hz, E.engineHz(k, 7600).hz];
out.v8mid = E.engineHz('v8', 900 + 6700*(6000 - 700)/(6200 - 700));
// an engine at work: no node made per frame, its oscillator on the firing frequency
E.engineSound('v8').stop();                 // the context, its master and the shared bus
const m0 = made, o0 = oscs.length, g0 = gains.length, eng = E.engineSound('turbo4');
out.made = made - m0;
const main = oscs[o0], outG = gains[g0];
out.mainType = main.type;
const m1 = made;
for (let i = 0; i < 300; i++){ now += 1/60; eng.set(900 + i*20, {thr: 1, gear: 1 + (i/100|0), speed: i/10, slip: i > 250 ? 0.8 : 0}); }
out.perFrame = made - m1;
out.mainHz = last(main.frequency)[1]; out.wantHz = E.engineHz('turbo4', 900 + 299*20).hz;
out.loud = outG.ev[outG.ev.length - 2][1];
// an upshift cut: some gain dips to 0.3 and comes back
out.cut = gains.slice(g0).some(p => p.ev.some(e => e[1] === 0.3));
// a lift at revs: the blow-off's burst and, on the overrun, the crackle (setValueAtTime bursts)
const before = gains.slice(g0).map(p => p.ev.filter(e => e[0] === 'V' && e[1] > 0).length);
for (let i = 0; i < 90; i++){ now += 1/60; eng.set(6000, {thr: 0, gear: 4}); }
const bursts = gains.slice(g0).map((p, i) => p.ev.filter(e => e[0] === 'V' && e[1] > 0).length - before[i]);
out.bursts = bursts.reduce((a, b) => a + b, 0);
out.coast = outG.ev[outG.ev.length - 2][1];
eng.stop(); out.stopped = oscs.slice(o0).every(o => o.stopped);
// deterministic: the same frames make the same crackle
function crackles(){ const g1 = gains.length, e2 = E.engineSound('single'); let n = 0;
  for (let i = 0; i < 60; i++){ now += 1/60; e2.set(7000, {thr: 1}); }
  for (let i = 0; i < 90; i++){ now += 1/60; e2.set(6500, {thr: 0}); }
  gains.slice(g1).forEach(p => p.ev.forEach(e => { if (e[0] === 'V' && e[1] > 0) n += Math.round(e[1]*1000); }));
  e2.stop(); return n; }
now = 100; const c1 = crackles(); now = 100; const c2 = crackles(); out.crackle = [c1, c2];
// a far engine is quieter; muted: no engine at all, and a live one goes quiet
vol = '0'; const before0 = made, e4 = E.engineSound('v8'); e4.set(4000, {thr: 1}); out.mutedMade = made - before0;
vol = '0.5'; const gm = gains.length, e5 = E.engineSound('six'); now += 0.1; e5.set(4000, {thr: 1});
const g5 = gains[gm]; out.on = g5.ev[g5.ev.length - 2][1];
vol = '0'; now += 0.1; e5.set(4000, {thr: 1}); out.muted = g5.ev[g5.ev.length - 2][1];
vol = '0.5'; now += 0.1; e5.set(4000, {thr: 1, dist: 0}); const near = g5.ev[g5.ev.length - 2][1];
now += 0.1; e5.set(4000, {thr: 1, dist: 60}); out.far = [near, g5.ev[g5.ev.length - 2][1]];
// an airliner's turbofans (HQ 3.6): one graph; the whine climbs with N1, the roar with the thrust
const mj = made, oj = oscs.length, gj = gains.length, jet = E.engineSound('jet'); out.jetMade = made - mj;
const lastV = p => { const e = p.ev.filter(x => x[0] === 'T'); return e.length ? e[e.length - 1][1] : p.value; };
function jetAt(rpm, thr, n){ for (let i = 0; i < n; i++){ now += 1/60; jet.set(rpm, {thr}); }
  return {fan: Math.max(...oscs.slice(oj).map(o => lastV(o.frequency))), layers: gains.slice(gj + 1).reduce((a, p) => a + lastV(p), 0)}; }
const mj1 = made; out.jetIdle = jetAt(900, 0, 60); out.jetFull = jetAt(7600, 1, 60); out.jetPerFrame = made - mj1;
jet.stop();
// the catalogue's vehicles on their voices
const cat = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
out.cat = {}; cat.vehicles.forEach(v => { out.cat[v.id] = [v.sound, P.voiceFor(v.spec, String(v['class']).split('.')[0] === 'bike' ? 'bike' : 'car')]; });
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(shutil.which("node"), "node not installed")
class EngineSound(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        g = lambda *p: os.path.join(ROOT, "games", *p)
        r = subprocess.run(["node", "-", g("engine.js"), g("hqvehiclephys.js"), g("vehicles", "catalogue.json")],
                           input=SCRIPT, capture_output=True, text=True, timeout=30)
        assert r.returncode == 0, r.stderr
        cls.o = json.loads(r.stdout)

    def test_firing_frequency(self):
        o = self.o
        self.assertAlmostEqual(o["v8mid"]["rpm"], 6000, delta=1)
        self.assertAlmostEqual(o["v8mid"]["hz"], 400, delta=0.5)            # 6000/60 * 8/2
        self.assertAlmostEqual(o["hz"]["single"][0], 1500/120, places=3)   # a 390 thumps at 12.5 Hz at idle
        self.assertAlmostEqual(o["hz"]["four"][1], 14000/30, places=3)     # a superbike four screams at 467 Hz
        self.assertAlmostEqual(o["hz"]["prop"][1], 2700/20, places=3)      # a flat-six at 2700
        for k, (lo, hi) in o["hz"].items():
            self.assertGreater(hi, lo, k)

    def test_no_nodes_per_frame_and_tracks_the_revs(self):
        o = self.o
        self.assertGreater(o["made"], 10)            # one graph, made once...
        self.assertEqual(o["perFrame"], 0)           # ...and 300 frames make nothing new
        self.assertEqual(o["mainType"], "custom")    # a PeriodicWave timbre
        self.assertAlmostEqual(o["mainHz"], o["wantHz"], places=3)
        self.assertTrue(o["stopped"])

    def test_load_shifts_blowoff_and_crackle(self):
        o = self.o
        self.assertTrue(o["cut"])                    # an upshift cuts the note
        self.assertGreater(o["bursts"], 2)           # blow-off and overrun pops
        self.assertLess(o["coast"], o["loud"])       # off the throttle: softer
        self.assertEqual(o["crackle"][0], o["crackle"][1])   # deterministic

    def test_muted_and_distance(self):
        o = self.o
        self.assertEqual(o["mutedMade"], 0)
        self.assertGreater(o["on"], 0)
        self.assertEqual(o["muted"], 0)
        self.assertLess(o["far"][1], o["far"][0]*0.5)

    def test_catalogue_voices(self):
        c = self.o["cat"]
        want = {"ktm-390-duke": "single", "ktm-1390-super-duke-r": "vtwin", "bmw-s-1000-rr": "four",
                "bmw-r-1300-gs": "boxer", "bmw-m3-competition": "turbo6", "bmw-m5": "v8tt",
                "bmw-i4-m50": "electric", "bugatti-chiron-super-sport": "w16", "bugatti-tourbillon": "v16",
                "ktm-990-duke": "twin", "bmw-m135-xdrive": "turbo4",
                "lamborghini-revuelto": "v12", "lamborghini-countach-lp400": "v12", "lamborghini-huracan-sto": "v10",
                "lamborghini-temerario": "v8tt", "lamborghini-urus-performante": "v8tt",
                "ducati-panigale-v4-s": "v4", "kawasaki-ninja-h2": "supercharged", "royal-enfield-classic-350": "longstroke",
                "royal-enfield-interceptor-650": "twin270", "harley-davidson-fat-boy-114": "vtwin45",
                "triumph-street-triple-765-rs": "triple", "yamaha-r1": "crossplane", "suzuki-hayabusa": "four"}
        for vid, voice in want.items():
            self.assertEqual(c[vid][0], voice, vid)
        for vid, (snd, derived) in c.items():
            if not vid.startswith("starter"):
                self.assertEqual(snd, derived, vid)          # the catalogue agrees with voiceFor

    def test_jet(self):
        o = self.o
        self.assertGreater(o["jetMade"], 10)
        self.assertEqual(o["jetPerFrame"], 0)                            # nodes made once
        self.assertGreater(o["jetFull"]["fan"], o["jetIdle"]["fan"]*2.5)   # the spool whine climbs with N1
        self.assertGreater(o["jetFull"]["layers"], o["jetIdle"]["layers"]*1.5)   # the roar grows with the thrust
        with open(os.path.join(ROOT, "games", "hqplane.js"), encoding="utf-8") as f:
            self.assertEqual(f.read().count('eng: "jet"'), 2)            # the narrow-body and the regional jet

    def test_planes_get_a_prop(self):
        with open(os.path.join(ROOT, "games", "hq3d.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('V.eng === "six") ? "prop"', src)
        self.assertIn("ride.eng.set(ride.rpm, {thr:", src)


if __name__ == "__main__":
    unittest.main()
