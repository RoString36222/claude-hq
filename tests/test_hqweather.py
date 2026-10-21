"""games/hqweather.js: the 3D City's forecast, run under node.

The weather is a pure function of the UTC clock and the world id, so everyone in a city sees the same storm and
nothing is sent anywhere; the drawing half is checked in the browser. Here: the forecast and its blending, the
lightning schedule, and that Calm and reduced motion never get falling particles or flashes.
"""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
SCRIPT = r"""
const fs = require('fs'), path = require('path'), R0 = process.argv[1];
global.window = {HQV: {}};
eval(fs.readFileSync(path.join(R0, 'games', 'hqweather.js'), 'utf8'));
const X = window.HQV.hqWeather, out = {};
// the same slot, the same weather, in every client; another world can differ
out.same = X.kindAt('claude-hq@2', 123456) === X.kindAt('claude-hq@2', 123456);
let differ = 0; for (let s = 0; s < 200; s++) if (X.kindAt('claude-hq@2', s) !== X.kindAt('user:x@2', s)) differ++;
out.differ = differ;
// over many slots, each kind about as often as its weight says
const n = 20000, count = {}; X.KINDS.forEach(k => count[k] = 0);
for (let s = 0; s < n; s++) count[X.kindAt('claude-hq@2', s)]++;
out.share = {}; X.KINDS.forEach((k, i) => out.share[k] = [count[k]/n, X.WEIGHT[i]/100]);
// a slot eases in from the last one's look to its own
const t0 = 1792000000000 - (1792000000000 % X.SLOT), A0 = X.at('w', t0), A1 = X.at('w', t0 + X.EASE + 1);
out.ease = [A0.e, A1.e, A0.next - t0];
const L0 = X.look('w', t0), L1 = X.look('w', t0 + X.EASE + 1), P = X.LOOK[A0.prev], Q = X.LOOK[A0.kind];
out.blend = {startFog: [L0.fogFar, P.fogFar], endFog: [L1.fogFar, Q.fogFar], tint: [L1.tint, Q.tint]};
let mono = true, prevE = -1; for (let t = t0; t <= t0 + X.EASE; t += 1000) { const e = X.at('w', t).e; if (e < prevE - 1e-12) mono = false; prevE = e; }
out.mono = mono;
// lightning: the same strikes for everyone, at most two per window, inside it
let maxN = 0, inside = true, sameS = true;
for (let w = 0; w < 500; w++) {
  const sec = w*X.STRIKE_WIN + 3, s1 = X.strikes('w', sec), s2 = X.strikes('w', sec);
  if (JSON.stringify(s1) !== JSON.stringify(s2)) sameS = false;
  maxN = Math.max(maxN, s1.length);
  s1.forEach(s => { if (s.t < w*X.STRIKE_WIN || s.t > (w + 1)*X.STRIKE_WIN) inside = false; });
}
Object.assign(out, {maxN, inside, sameS});
const f = X.forecast('w', t0, 3); out.forecast = [f.length, f[0].at === t0, f[1].at - f[0].at, !!f[0].name, !!f[0].icon];
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
class ForecastTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", SCRIPT, ROOT], capture_output=True, text=True, timeout=60)
        if r.returncode:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_everyone_in_a_city_gets_the_same_weather(self):
        self.assertTrue(self.o["same"])
        self.assertGreater(self.o["differ"], 50)       # but each world has its own

    def test_each_kind_turns_up_as_often_as_its_weight(self):
        for k, (got, want) in self.o["share"].items():
            self.assertAlmostEqual(got, want, delta=0.02, msg=k)

    def test_a_slot_eases_in_from_the_last_ones_look(self):
        e0, e1, span = self.o["ease"]
        self.assertEqual(e0, 0)
        self.assertEqual(e1, 1)
        self.assertEqual(span, 15 * 60 * 1000)
        self.assertTrue(self.o["mono"])
        b = self.o["blend"]
        self.assertEqual(b["startFog"][0], b["startFog"][1])
        self.assertEqual(b["endFog"][0], b["endFog"][1])
        self.assertEqual(b["tint"][0], b["tint"][1])

    def test_lightning_is_shared_and_bounded(self):
        self.assertTrue(self.o["sameS"])
        self.assertTrue(self.o["inside"])
        self.assertLessEqual(self.o["maxN"], 2)

    def test_the_forecast_runs_slot_by_slot(self):
        self.assertEqual(self.o["forecast"], [4, True, 15 * 60 * 1000, True, True])


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.js = open(os.path.join(ROOT, "games", "hqweather.js"), encoding="utf-8").read()

    def test_calm_gets_no_falling_particles_and_no_flashes(self):
        self.assertIn("var rainA = show && !calm ? amt(L.rain) : 0, snowA = show && !calm ? amt(L.snow) : 0;", self.js)
        self.assertIn("if(show && !calm && L.storm > 0.5){", self.js)
        self.assertIn("L.flash = calm ? 0 : flash;", self.js)

    def test_nothing_is_fetched_and_nothing_random_is_seen_twice(self):
        self.assertNotIn("fetch(", self.js)
        self.assertNotIn("Math.random(", self.js)

    def test_thunder_goes_through_the_engines_volume(self):
        self.assertIn("E.audioOut ? E.audioOut() : null", self.js)
        self.assertIn("gn.connect(A.out)", self.js)


if __name__ == "__main__":
    unittest.main()
