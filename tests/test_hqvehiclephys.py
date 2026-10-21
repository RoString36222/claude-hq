"""Handling from real specs (games/hqvehiclephys.js) and the real vehicles' engine voices (games/engine.js).

hqvehiclephys.js is pure, so node loads it against a stub `window`; the Python side checks the numbers:
the two starters reproduce today's car and motorbike (games/hq3d.js VEHICLES) within 10%, real 0-100 times
come back within 15% under hq3d's pull curve, more power per tonne pulls harder, the game's speed caps hold,
an electric car has one gear and keeps its pull, RWD slides more than AWD than FWD, SUVs roll, bikes lean by
type, and every voice exists, sounds different and keeps engine.js's dead man's switch.
Skipped when node is not installed. Stdlib only."""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

PHYS = r"""
const fs = require('fs');
globalThis.window = {HQV: {}};
new Function(fs.readFileSync(process.argv[2], 'utf8'))();
const P = window.HQV.hqVehiclePhys, out = {};
const SPECS = JSON.parse(process.argv[3]);
for (const k in SPECS) {
  const V = P.derive(SPECS[k]);
  V.back0100 = P.t0100(V.top, V.acc, V.floor);
  out[k] = V;
}
// power-to-weight alone (no maker 0-100): more kW per tonne pulls harder
out.ladder = [60, 120, 250, 400, 700].map(kw => P.derive({kind: 'car', type: 'sedan',
  spec: {powerKw: kw, massKg: 1600, drive: 'rwd', topKmh: 250, gears: 6, cyl: 6}}).acc);
out.voices = {single: P.voiceFor({cyl: 1}, 'bike'), twin: P.voiceFor({cyl: 2, layout: 'parallel'}, 'bike'),
  vtwin: P.voiceFor({cyl: 2, layout: 'v'}, 'bike'), boxer: P.voiceFor({cyl: 2, layout: 'boxer'}, 'bike'),
  four: P.voiceFor({cyl: 4}, 'bike'), six: P.voiceFor({cyl: 6}, 'car'), v8: P.voiceFor({cyl: 8, layout: 'v'}, 'car'),
  w16: P.voiceFor({cyl: 16, layout: 'w16'}, 'car'), v16: P.voiceFor({cyl: 16, layout: 'v'}, 'car'),
  electric: P.voiceFor({electric: true}, 'car'), turbo4: P.voiceFor({cyl: 4, aspiration: 'turbo'}, 'car'),
  turbo6: P.voiceFor({cyl: 6, aspiration: 'twin-turbo'}, 'car'), v8tt: P.voiceFor({cyl: 8, layout: 'v8', aspiration: 'twin-turbo'}, 'car')};
console.log(JSON.stringify(out));
"""

# every voice through a fake AudioContext: its oscillators' frequencies at idle and at the redline,
# and the output gain's dead man's switch (a fade to 0 scheduled 0.25 s after each set())
AUDIO = r"""
const fs = require('fs');
let now = 0; const gains = [], oscs = [];
function param(v){ const p = {value: v, ev: [], setTargetAtTime(x, t){ p.ev.push([x, t]); },
  cancelScheduledValues(t){ p.ev = p.ev.filter(e => e[1] < t); }, setValueAtTime(){}, exponentialRampToValueAtTime(){}}; return p; }
function node(){ return {connect(){}, start(){}, stop(){}, frequency: param(0), Q: param(0), type: ''}; }
class AC { constructor(){ this.state = 'running'; this.sampleRate = 8000; this.destination = {}; }
  get currentTime(){ return now; } resume(){ return Promise.resolve(); }
  createGain(){ const n = node(); n.gain = param(1); gains.push(n.gain); return n; }
  createOscillator(){ const n = node(); oscs.push(n); return n; } createBiquadFilter(){ return node(); } createBufferSource(){ return node(); }
  createBuffer(c, n){ return {getChannelData: () => new Float32Array(n)}; } }
const window = {HQV: {}, matchMedia: () => ({matches: false}), AudioContext: AC};
const document = {documentElement: {classList: {contains: () => false}}};
global.localStorage = {getItem: () => '0.5', setItem(){}};
global.performance = {now: () => 0};
new Function('window', 'document', fs.readFileSync(process.argv[2], 'utf8'))(window, document);
const E = window.HQV.engine, out = {engines: E.engines};
for (const v of JSON.parse(process.argv[3])) {
  const o0 = oscs.length, g0 = gains.length, eng = E.engineSound(v);
  const main = oscs[o0], last = p => p.ev[p.ev.length - 1];
  now += 1; eng.set(900); const idle = last(main.frequency)[0];
  now += 1; eng.set(7600); const red = last(main.frequency)[0];
  const g = gains.slice(g0).find(p => p.ev.length), fade = g.ev[g.ev.length - 1];
  out[v] = {idle: idle, red: red, osc: main.type, fade: [fade[0], Math.round((fade[1] - now)*100)/100]};
  eng.stop();
}
console.log(JSON.stringify(out));
"""

# the two starters: today's car and motorbike (games/hq3d.js VEHICLES), as catalogue entries
STARTERS = {
    "starter_car": {"kind": "car", "type": "hatch", "sound": "turbo",
                    "spec": {"topKmh": 79.2, "zeroTo100s": 9.7, "drive": "rwd", "gears": 5, "cyl": 4, "massKg": 1100, "powerKw": 60},
                    "dims": {"lengthM": 3.95, "widthM": 1.65}},
    "starter_moto": {"kind": "bike", "type": "naked", "sound": "bike",
                     "spec": {"topKmh": 86.4, "zeroTo100s": 6.5, "gears": 5, "cyl": 1, "massKg": 150, "powerKw": 20},
                     "dims": {"lengthM": 1.9}},
}
REAL = {
    # a light FWD hatch (Swift-like), no maker 0-100: estimated from power-to-weight
    "swift": {"kind": "car", "type": "hatch", "spec": {"cc": 1197, "cyl": 4, "powerKw": 60, "massKg": 900, "drive": "fwd",
              "topKmh": 165, "gears": 5}, "dims": {"lengthM": 3.86, "widthM": 1.735}},
    "m3": {"kind": "car", "type": "sedan", "spec": {"cc": 2993, "cyl": 6, "layout": "inline", "powerKw": 375, "massKg": 1730,
           "drive": "rwd", "topKmh": 290, "zeroTo100s": 3.9, "gears": 8}, "dims": {"lengthM": 4.79, "widthM": 1.9}},
    "x5m": {"kind": "car", "type": "suv", "spec": {"cc": 4395, "cyl": 8, "layout": "v", "powerKw": 460, "massKg": 2400,
            "drive": "awd", "topKmh": 290, "zeroTo100s": 3.9, "gears": 8}, "dims": {"lengthM": 4.94, "widthM": 2.02}},
    "chiron": {"kind": "car", "type": "hyper", "spec": {"cc": 7993, "cyl": 16, "layout": "w16", "powerKw": 1176, "massKg": 1995,
               "drive": "awd", "topKmh": 440, "zeroTo100s": 2.4, "gears": 7}, "dims": {"lengthM": 4.54, "widthM": 2.04}},
    "i4": {"kind": "car", "type": "sedan", "spec": {"electric": True, "powerKw": 400, "massKg": 2290, "drive": "awd",
           "topKmh": 225, "zeroTo100s": 3.9}, "dims": {"lengthM": 4.78, "widthM": 1.85}},
    "duke390": {"kind": "bike", "type": "naked", "spec": {"cc": 399, "cyl": 1, "layout": "single", "powerKw": 33,
                "massKg": 165, "topKmh": 170, "gears": 6}, "dims": {"lengthM": 2.0}},
    "s1000rr": {"kind": "bike", "type": "sport", "spec": {"cc": 999, "cyl": 4, "layout": "inline", "powerKw": 154,
                "massKg": 197, "topKmh": 300, "zeroTo100s": 3.1, "gears": 6}, "dims": {"lengthM": 2.07}},
    "r1300gs": {"kind": "bike", "type": "adventure", "spec": {"cc": 1300, "cyl": 2, "layout": "boxer", "powerKw": 107,
                "massKg": 237, "topKmh": 220, "gears": 6}, "dims": {"lengthM": 2.21}},
}
# today's games/hq3d.js VEHICLES
TODAY = {
    "starter_car": {"top": 22, "acc": 6, "rev": 5, "lean": 0, "box": [0.66, 1.66], "gears": [5, 9.5, 14, 18.5, 23],
                    "slide": {"min": 7, "turn": 1.3, "grip": 2.2, "max": 0.62, "bleed": 3.4}},
    "starter_moto": {"top": 24, "acc": 9, "rev": 3, "lean": 0.42, "box": [0, 0.8], "gears": [6.5, 11.5, 16, 20.5, 25],
                     "slide": {"min": 8, "turn": 1.35, "grip": 3.2, "max": 0.32, "bleed": 3}},
}
VOICES = ["single", "twin", "vtwin", "boxer", "four", "six", "v8", "w16", "v16", "electric", "turbo4", "turbo6", "v8tt"]


def near(a, b, tol):
    return abs(a - b) <= tol*max(abs(b), 1e-9) if b else abs(a) <= tol


@unittest.skipUnless(NODE, "node not installed")
class VehiclePhys(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        specs = dict(STARTERS, **REAL)
        r = subprocess.run([NODE, "-", os.path.join(ROOT, "games", "hqvehiclephys.js"), json.dumps(specs)],
                           input=PHYS, capture_output=True, text=True, timeout=60)
        if r.returncode:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout)

    def test_starters_keep_todays_feel(self):
        for k, want in TODAY.items():
            V = self.o[k]
            for f in ("top", "acc", "rev", "lean"):
                self.assertTrue(near(V[f], want[f], 0.10), f"{k}.{f}: {V[f]} vs {want[f]}")
            for a, b in zip(V["box"], want["box"]):
                self.assertTrue(near(a, b, 0.10), f"{k}.box {V['box']}")
            self.assertEqual(len(V["gears"]), len(want["gears"]))
            for a, b in zip(V["gears"], want["gears"]):
                self.assertTrue(near(a, b, 0.10), f"{k}.gears {V['gears']}")
            for f, b in want["slide"].items():
                self.assertTrue(near(V["slide"][f], b, 0.10), f"{k}.slide.{f}")
            self.assertEqual(V["floor"], 0.25)          # hq3d's own pull curve
            self.assertEqual(V["brake"], 14)
            self.assertEqual(V["roll"], 0)               # the starter car does not roll
            self.assertTrue(V["motor"])
        self.assertEqual(self.o["starter_car"]["eng"], "turbo")
        self.assertEqual(self.o["starter_moto"]["eng"], "bike")

    def test_real_0_100_within_15_percent(self):
        for k, e in REAL.items():
            t = e["spec"].get("zeroTo100s")
            if t:
                self.assertTrue(near(self.o[k]["back0100"], t, 0.15), f"{k}: {self.o[k]['back0100']} vs {t}")
        # no maker figure: a plausible estimate from power-to-weight
        self.assertTrue(9 < self.o["swift"]["back0100"] < 15, self.o["swift"]["back0100"])
        self.assertTrue(4 < self.o["duke390"]["back0100"] < 8, self.o["duke390"]["back0100"])

    def test_more_power_pulls_harder(self):
        L = self.o["ladder"]
        self.assertEqual(L, sorted(L))
        self.assertLess(L[0], L[-1])
        self.assertGreater(self.o["chiron"]["acc"], self.o["m3"]["acc"])
        self.assertGreater(self.o["m3"]["acc"], self.o["swift"]["acc"])

    def test_caps(self):
        self.assertAlmostEqual(self.o["chiron"]["top"], 300/3.6, places=1)     # 440 km/h capped at 300
        self.assertAlmostEqual(self.o["s1000rr"]["top"], 280/3.6, places=1)    # bikes at 280
        self.assertAlmostEqual(self.o["m3"]["top"], 290/3.6, places=1)         # under the cap: its own
        for k in REAL:
            V = self.o[k]
            self.assertLessEqual(V["top"], (300 if V["kind"] == "car" else 280)/3.6 + 0.01)
            self.assertGreater(V["acc"], 0)
            self.assertAlmostEqual(V["gears"][-1], V["top"]*1.045, delta=0.2)  # the top gear reaches the top

    def test_electric(self):
        V = self.o["i4"]
        self.assertEqual(len(V["gears"]), 1)
        self.assertEqual(V["eng"], "electric")
        self.assertGreater(V["floor"], 0.25)            # keeps its pull at speed

    def test_drivetrains_and_bodies(self):
        o = self.o
        self.assertGreater(o["m3"]["slide"]["max"], o["x5m"]["slide"]["max"])      # RWD lets the tail out further
        self.assertGreater(o["x5m"]["slide"]["max"], o["swift"]["slide"]["max"])   # than AWD, than FWD
        self.assertGreater(o["m3"]["slip"], o["x5m"]["slip"])
        self.assertGreater(o["x5m"]["grip"], o["m3"]["grip"])                      # AWD launches cleaner
        self.assertGreater(o["x5m"]["roll"], o["m3"]["roll"])                      # an SUV rolls more
        self.assertLess(o["x5m"]["brake"], o["m3"]["brake"])                       # 2.4 t stops longer
        self.assertEqual(o["chiron"]["eng"], "w16")
        self.assertEqual(o["m3"]["eng"], "six")
        self.assertEqual(o["x5m"]["eng"], "v8")

    def test_bikes(self):
        o = self.o
        self.assertGreater(o["s1000rr"]["lean"], o["duke390"]["lean"])   # sport leans furthest
        self.assertGreater(o["duke390"]["lean"], o["r1300gs"]["lean"])   # adventure least
        for k in ("duke390", "s1000rr", "r1300gs"):
            self.assertEqual(o[k]["box"][0], 0)
            self.assertEqual(o[k]["roll"], 0)
        self.assertEqual(o["duke390"]["eng"], "single")
        self.assertEqual(o["r1300gs"]["eng"], "boxer")
        self.assertEqual(o["s1000rr"]["eng"], "four")

    def test_voice_for_layouts(self):
        self.assertEqual(self.o["voices"], {v: v for v in VOICES})


@unittest.skipUnless(NODE, "node not installed")
class Voices(unittest.TestCase):
    def test_every_voice(self):
        r = subprocess.run([NODE, "-", os.path.join(ROOT, "games", "engine.js"), json.dumps(VOICES)],
                           input=AUDIO, capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        o = json.loads(r.stdout)
        for v in VOICES:
            self.assertIn(v, o["engines"], v)
            self.assertGreater(o[v]["red"], o[v]["idle"], v)          # the note climbs with the revs
            self.assertEqual(o[v]["fade"], [0, 0.25], v)               # the dead man's switch
        # each voice has its own pitch range (no two share an idle and a redline)
        ranges = {(o[v]["idle"], o[v]["red"]) for v in VOICES}
        self.assertEqual(len(ranges), len(VOICES))
        self.assertGreater(o["electric"]["idle"], o["v8"]["red"])       # a motor's whine sits above any engine
        self.assertEqual(o["electric"]["osc"], "sine")
        self.assertLess(o["w16"]["idle"], o["v16"]["idle"])             # the W16's roar under the V16's shriek

    def test_hq3d_uses_the_new_fields(self):
        with open(os.path.join(ROOT, "games", "hq3d.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("Math.max(V.floor || 0.25,", src)
        self.assertIn("V.brake || 14", src)
        self.assertRegex(src, r"ride\.V\.roll")


if __name__ == "__main__":
    unittest.main()
