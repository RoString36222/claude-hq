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
// a motorbike is a train of bangs, not a held note: for every bike voice a firing-pulse oscillator on the
// engine cycle (rpm/120) with a cosine (pulse) PeriodicWave whose cylinders differ, the rpm never dead steady at a
// steady throttle, the jitter (FM) and exhaust layers on, no resonant low-pass
out.bikes = {};
for (const k of ['bike', 'single', 'twin', 'vtwin', 'boxer', 'four', 'v4', 'triple', 'crossplane', 'supercharged', 'longstroke', 'twin270', 'vtwin45']){
  const P0 = E.engineProfile(k), o1 = oscs.length, f1 = filters.length, g1 = gains.length;
  const ek = E.engineSound(k, null, {idle: P0.idle, red: P0.red, limit: P0.red + 400, cyl: P0.cyl});
  const hs = [];
  for (let i = 0; i < 240; i++){ now += 1/60; ek.set(7000, {thr: 0.3, gear: 4, speed: 20}); hs.push(lastV(oscs[o1].frequency)); }
  const pulse = oscs.slice(o1).find(o => o.wave && o.wave.re.some(x => x !== 0));
  let off = 0, all = 0;
  if (pulse) pulse.wave.re.forEach((r, i) => { const e = r*r + pulse.wave.im[i]*pulse.wave.im[i]; all += e; if (P0.cyl > 1 && i % P0.cyl) off += e; });
  const fq = filters.slice(f1), lp = fq.find(f => f.type === 'lowpass');
  out.bikes[k] = {cyl: P0.cyl, hz: 7000/60*P0.cyl/2, pulseHz: pulse ? lastV(pulse.frequency) : 0, uneven: all ? off/all : 0,
    spread: Math.max(...hs.slice(60))/Math.min(...hs.slice(60)), q: lp.Q.value,
    layers: fq.filter(f => f.type === 'lowpass' && f.Q.value === 0.5).length};
  ek.stop();
}
// the watchdog: a voice nobody set() for half a second is stopped outright (a dismount, a world change, a
// forgotten stop()); the next set() builds it again
{
  const o1 = oscs.length, m1 = made, ew = E.engineSound('four', null, {idle: 1200, red: 15100, limit: 15100, cyl: 4});
  for (let i = 0; i < 30; i++){ now += 1/60; ew.set(7000, {thr: 0.3}); }
  const mine = oscs.slice(o1), live0 = E.liveEngines();
  now += 0.3; E.engineWatch(); const keptAt03 = mine.every(o => !o.stopped);
  now += 0.4; E.engineWatch();
  out.watch = {live0, keptAt03, stopped: mine.every(o => o.stopped), liveAfter: E.liveEngines()};
  const m2 = made; ew.set(7000, {thr: 0.3}); out.watch.rebuilt = made > m2; out.watch.liveAgain = E.liveEngines();
  ew.stop(); out.watch.liveStopped = E.liveEngines();
}
// the catalogue's vehicles on their voices
const cat = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
out.cat = {}; cat.vehicles.forEach(v => { out.cat[v.id] = [v.sound, P.voiceFor(v.spec, String(v['class']).split('.')[0] === 'bike' ? 'bike' : 'car')]; });
// [3.36] every car on every exhaust drives the shaper no harder than its plain engine; the extra sub goes round it
out.drive = [];
cat.vehicles.filter(v => String(v['class']).split('.')[0] !== 'bike').forEach(v => {
  const kind = v.sound || 'v8', real = P.engineFor ? P.engineFor(v.spec, 'car', kind) : null;
  [null, 'sport', 'quad', 'titanium'].forEach(ex => { const d = E.shaperDrive(kind, E.engineProfile(kind, ex, real)); out.drive.push([v.id, ex, d.peak, d.peak0, d.subIn, d.subClean]); });
});
// [3.38] the Koenigseggs' own notes: the tone's new fields
{
  const ko = id => P.engineFor(cat.vehicles.find(v => v.id === id).spec, 'car', 'v8tt');
  const prof = {}; ['koenigsegg-jesko-absolut', 'koenigsegg-agera-rs', 'koenigsegg-one-1', 'koenigsegg-regera'].forEach(id => {
    const Q = E.engineProfile('v8tt', null, ko(id)); prof[id] = {sub: Q.sub, cut: Q.cut, gain: Q.gain, hKey: Q.hKey || null, h: Q.h,
      spool: Q.spool, flutter: Q.flutter, bang: Q.bang, hybrid: Q.hybrid || 0, red: Q.red, shiftS: Q.shiftS || null}; });
  out.ko = prof;
  const posV = g1 => gains.slice(g1).reduce((n, p) => n + p.ev.filter(e => e[0] === 'V' && e[1] > 0).length, 0);
  const base = {idle: 950, red: 8250, limit: 8250, cyl: 8};
  // a lift off boost: a wastegate's flutter is a train of bursts, a blow-off valve one falling pssh (no crackle here)
  function lift(tone){ const g1 = gains.length, e = E.engineSound('v8tt', null, Object.assign({}, base, {tone}));
    for (let i = 0; i < 120; i++){ now += 1/60; e.set(6500, {thr: 1, gear: 5}); } const n0 = posV(g1);
    for (let i = 0; i < 6; i++){ now += 1/60; e.set(6400, {thr: 0, gear: 5}); } const n = posV(g1) - n0; e.stop(); return n; }
  out.flutter = [lift({whistle: 0.6, crackle: 0, flutter: 1}), lift({whistle: 0.6, crackle: 0, flutter: 0})];
  // an upshift: the cannon bang (a positive burst) and the cut's depth by the box (a seamless LST barely dips)
  function upshift(tone, shift){ const g1 = gains.length, e = E.engineSound('v8tt', null, Object.assign({}, base, {tone, shift}));
    for (let i = 0; i < 30; i++){ now += 1/60; e.set(6000, {thr: 1, gear: 3}); } const n0 = posV(g1);
    now += 1/60; e.set(4700, {thr: 1, gear: 4}); const bursts = posV(g1) - n0;
    const dip = [0.04, 0.3, 0.7].filter(c => gains.slice(g1).some(p => p.ev.some(x => x[0] === 'T' && x[2] >= now - 1e-9 && x[1] === c)));
    e.stop(); return {bursts, dip}; }
  out.bang = [upshift({crackle: 0, bang: 1}, 0.1), upshift({crackle: 0, bang: 0}, 0.1), upshift({crackle: 0, bang: 0}, 0.025)];
  // a hybrid: the motors' whine rides the road speed, and the engine is hushed while it creeps
  { const o1 = oscs.length, g1 = gains.length, e = E.engineSound('v8tt', null, Object.assign({}, base, {tone: {hybrid: 1}}));
    const n = oscs.length - o1, outG = gains[g1];
    for (let i = 0; i < 60; i++){ now += 1/60; e.set(2250, {thr: 0.2, speed: 4}); } const slow = outG.ev[outG.ev.length - 2][1];
    const whine = Math.max(...oscs.slice(o1).map(o => lastV(o.frequency)).filter(f => f > 150 && f < 200));
    for (let i = 0; i < 60; i++){ now += 1/60; e.set(2250, {thr: 0.2, speed: 30}); } const fast = outG.ev[outG.ev.length - 2][1];
    e.stop(); const o2 = oscs.length; E.engineSound('v8tt', null, Object.assign({}, base, {tone: {}})).stop();
    out.hybrid = {extra: n - (oscs.length - o2), slow, fast, whine}; }
}
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

    def test_tone_and_exhaust_never_drive_the_shaper_harder_than_the_engine(self):
        self.assertGreater(len(self.o["drive"]), 30)
        for vid, ex, peak, peak0, sub_in, sub_clean in self.o["drive"]:
            self.assertLessEqual(peak, peak0 + 1e-9, (vid, ex))
            self.assertGreaterEqual(sub_clean, 0, (vid, ex))
        ko = [d for d in self.o["drive"] if d[0] == "koenigsegg-jesko-absolut"]
        self.assertEqual(len(ko), 4)

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
        # with its wobble (up to +-1.8 %; +-0.6 % this near the redline), posted once it moved 0.3 % (5 cents)
        self.assertAlmostEqual(o["mainHz"], o["wantHz"], delta=o["wantHz"]*0.02)
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

    def test_bikes_fire_pulses_not_a_held_note(self):
        # the "buzz" on a motorbike: every bike voice beats with its firing pulses on the engine cycle,
        # its cylinders not identical, its rpm wandering a little at a steady throttle, noise layers on, no resonance
        for k, b in self.o["bikes"].items():
            self.assertAlmostEqual(b["pulseHz"], b["hz"]/b["cyl"], delta=b["hz"]/b["cyl"]*0.03, msg=k)
            if b["cyl"] > 1:
                self.assertGreater(b["uneven"], 0.01, k)          # energy between the firing orders: uneven cylinders
            self.assertGreater(b["spread"], 1.003, k)             # never a dead-steady note...
            self.assertLess(b["spread"], 1.05, k)                 # ...but only a small wobble
            self.assertLessEqual(b["q"], 0.9, k)
            self.assertEqual(b["layers"], 2, k)                   # the exhaust roar and the FM jitter

    def test_watchdog_stops_a_forgotten_voice(self):
        w = self.o["watch"]
        self.assertGreaterEqual(w["live0"], 1)
        self.assertTrue(w["keptAt03"])                            # 0.3 s without set(): still there
        self.assertTrue(w["stopped"])                             # 0.7 s: every node stopped
        self.assertEqual(w["liveAfter"], 0)                       # nothing anywhere left running
        self.assertTrue(w["rebuilt"])
        self.assertEqual(w["liveAgain"], 1)
        self.assertEqual(w["liveStopped"], 0)

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

    def test_koenigseggs_sound_their_own(self):
        k = self.o["ko"]
        j, a, o1, r = (k["koenigsegg-" + n] for n in ("jesko-absolut", "agera-rs", "one-1", "regera"))
        # the Jesko's flat-plane crank: no half-order burble, a brighter wave, the low-pass far up; the 8,500 limit
        self.assertLess(j["sub"], a["sub"]*0.2)
        self.assertIsNotNone(j["hKey"]); self.assertIsNone(a["hKey"])
        self.assertGreater(sum(j["h"][3:]), sum(a["h"][3:])*1.4)
        self.assertGreater(j["cut"][1], max(a["cut"][1], o1["cut"][1], r["cut"][1])*1.4)
        self.assertEqual(j["red"], 8500); self.assertEqual(a["red"], 8250)
        self.assertEqual(j["shiftS"], 0.025)
        self.assertEqual(j["spool"], 1)                                  # the air tank's anti-lag
        # the Agera's cannon on the upshift, the One:1 the loudest (Spa's 103 dB), the Regera the hybrid with a flutter
        self.assertGreater(a["bang"], max(j["bang"], r["bang"]))
        self.assertGreater(o1["gain"], max(j["gain"], a["gain"], r["gain"]))
        self.assertEqual(r["hybrid"], 1); self.assertEqual(r["flutter"], 1); self.assertEqual(o1["flutter"], 0)
        sig = {n: (round(v["sub"], 3), tuple(v["cut"]), round(v["gain"], 4), v["flutter"], v["bang"]) for n, v in k.items()}
        self.assertEqual(len(set(sig.values())), 4, "four different notes")

    def test_flutter_bang_seamless_and_hybrid(self):
        f, b, h = self.o["flutter"], self.o["bang"], self.o["hybrid"]
        self.assertGreaterEqual(f[0], 6, "a wastegate flutter: a train of bursts"); self.assertEqual(f[1], 0, "a blow-off: one pssh")
        self.assertGreaterEqual(b[0]["bursts"], 1); self.assertEqual(b[1]["bursts"], 0)
        self.assertEqual(b[1]["dip"], [0.3])                                   # a 100 ms box: the usual cut
        self.assertEqual(b[2]["dip"], [0.7])                                   # the LST: the note barely dips
        self.assertEqual(h["extra"], 2)                                        # the whine's two oscillators, made once
        self.assertAlmostEqual(h["whine"], 43.2*4, delta=3)
        self.assertLess(h["slow"], h["fast"]*0.6, "creeping on the motors: the engine hushed")

    def test_planes_get_a_prop(self):
        with open(os.path.join(ROOT, "games", "hq3d.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('V.eng === "six") ? "prop"', src)
        self.assertIn("ride.eng.set(ride.rpm, {thr:", src)


if __name__ == "__main__":
    unittest.main()
