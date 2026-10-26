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
// what lies on the ground: snow builds in a snow spell (to no more than SNOW_MAX), melts after; rain wets at once, dries
let sSlot = null; for (let s = 50; s < 6000 && sSlot == null; s++) if (X.kindAt('w', s) === 'snow' && X.kindAt('w', s - 1) === 'snow' && X.kindAt('w', s + 1) !== 'snow' && X.kindAt('w', s + 1) !== 'rain') sSlot = s;
const sEnd = (sSlot + 1)*X.SLOT;
let rSlot = null; for (let s = 50; s < 6000 && rSlot == null; s++) if (X.kindAt('w', s) === 'rain' && X.kindAt('w', s + 1) === 'clear' && X.kindAt('w', s + 2) === 'clear') rSlot = s;
const rEnd = (rSlot + 1)*X.SLOT;
let maxSnow = 0; for (let m = -60; m < 60; m++) maxSnow = Math.max(maxSnow, X.settled('w', sEnd + m*60000).snow);
out.ground = {snowIn: X.settled('w', sEnd - 60000).snow, snowLater: X.settled('w', sEnd + 45*60000).snow, maxSnow: maxSnow, cap: X.SNOW_MAX,
  wetIn: X.settled('w', rEnd - 60000).wet, wetLater: X.settled('w', rEnd + 15*60000).wet,
  smooth: Math.abs(X.settled('w', sEnd - 90000).snow - X.settled('w', sEnd - 89000).snow) < 0.01};
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


class GroundTests(unittest.TestCase):
    def setUp(self):
        if not hasattr(ForecastTests, "o"):
            ForecastTests.setUpClass()
        self.g = ForecastTests.o["ground"]

    def test_snow_settles_a_little_and_melts_after(self):
        self.assertGreater(self.g["snowIn"], 0.3)
        self.assertLessEqual(self.g["maxSnow"], self.g["cap"] + 1e-9)
        self.assertLessEqual(self.g["cap"], 0.5)                 # a dusting, not a blanket
        self.assertEqual(self.g["snowLater"], 0)

    def test_rain_wets_the_ground_and_it_dries(self):
        self.assertGreater(self.g["wetIn"], 0.9)
        self.assertEqual(self.g["wetLater"], 0)

    def test_the_cover_changes_smoothly(self):
        self.assertTrue(self.g["smooth"])


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.js = open(os.path.join(ROOT, "games", "hqweather.js"), encoding="utf-8").read()

    def test_calm_gets_no_falling_particles_and_no_flashes(self):
        self.assertIn("var rainA = show && !calm ? amt(L.rain) : 0, snowA = show && !calm ? amt(L.snow) : 0;", self.js)
        self.assertIn("if(show && !calm && L.storm > 0.5){", self.js)
        self.assertIn("L.flash = calm ? 0 : flash;", self.js)

    def test_nothing_is_fetched_and_nothing_random_is_seen_twice(self):
        # [3.23] the one fetch: the Arena's live reading through the local server
        self.assertEqual(self.js.count("fetch("), 1)
        self.assertIn('fetch("/api/arena/weather"', self.js)
        self.assertNotIn("Math.random(", self.js)

    def test_thunder_goes_through_the_engines_volume(self):
        self.assertIn("E.audioOut ? E.audioOut() : null", self.js)
        self.assertIn("gn.connect(A.out)", self.js)


LIVE = r"""
const fs = require('fs'), path = require('path'), R0 = process.argv[1];
global.window = {HQV: {}};
eval(fs.readFileSync(path.join(R0, 'games', 'hqweather.js'), 'utf8'));
const X = window.HQV.hqWeather, out = {};
const base = {temperature: 24, humidity: 70, wind_speed: 2, wind_direction: 270, rain_intensity: 0, rain_accumulation: 0, aqi_pm_10: 40, aqi_pm_2_point_5: 20};
function L(d){ return X.fromLive(Object.assign({}, base, d), 'Koramangala'); }
out.rain = [0, 0.3, 1, 2.5, 7.5, 20, 40, 80].map(r => L({rain_intensity: r}).rain);
out.kinds = [L({}).kind, L({rain_intensity: 1}).kind, L({rain_intensity: 30}).kind, L({rain_intensity: 14, wind_speed: 12}).kind,
             L({humidity: 97}).kind, L({humidity: 92}).kind, L({humidity: 30}).kind];
out.fog = [L({}).fogFar, L({rain_intensity: 10}).fogFar, L({aqi_pm_2_point_5: 180}).fogFar, L({humidity: 98}).fogFar];
out.dim = [L({}).dim, L({rain_intensity: 10}).dim, L({rain_intensity: 40}).dim];
out.wet = [L({}).wet, L({rain_accumulation: 6}).wet, L({rain_intensity: 5}).wet];
out.smogTint = [L({}).tint, L({aqi_pm_2_point_5: 200}).tint];
out.hotTint = [L({temperature: 24}).tint, L({temperature: 38}).tint, L({temperature: 12}).tint];
const wW = L({wind_direction: 270, wind_speed: 12});             // from the west: it blows east (+x)
out.wind = [Math.round(wW.wx*100)/100, Math.round(wW.wz*100)/100, wW.wind];
const nul = X.fromLive({rain_intensity: null, temperature: null, humidity: null, wind_speed: null, wind_direction: null, aqi_pm_10: null, aqi_pm_2_point_5: null});
out.nulls = [nul.kind, isFinite(nul.fogFar), isFinite(nul.dim), isFinite(nul.wx)];
// setLive: eases in, the forecast says what it is doing now, a stale or missing reading falls back
const t = 1792000000000, at = Math.floor(t/1000);
out.before = X.liveOn(t);
out.set = X.setLive({ok: true, place: 'Koramangala, Bengaluru', at: at, data: Object.assign({}, base, {rain_intensity: 12})}, t);
out.again = X.setLive({ok: true, place: 'Koramangala, Bengaluru', at: at, data: base}, t + 1000);
const e0 = X.look('w', t), e1 = X.look('w', t + X.EASE + 1);
out.ease = [e0.e, e1.e, e1.kind, Math.abs(e1.rain - X.fromLive(Object.assign({}, base, {rain_intensity: 12})).rain) < 1e-9, !!e1.live];
const f = X.forecast('w', t + X.EASE + 1, 1);
out.forecast = [f.length, f[0].live, f[0].name];
out.ground = X.settled('w', t + X.EASE + 1);
out.stale = [X.liveOn(t + 4*3600*1000), X.look('w', t + 4*3600*1000).live === undefined];
X.clearLive();
out.off = X.setLive({ok: false}, t);
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
class LiveWeatherTests(unittest.TestCase):
    """[3.23] the Arena's Weather Union reading (Koramangala) drives the sky: every number it gives is used."""
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", LIVE, ROOT], capture_output=True, text=True, timeout=60)
        if r.returncode:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_rain_follows_the_intensity(self):
        r = self.o["rain"]
        self.assertEqual(r[0], 0)
        self.assertTrue(all(b > a for a, b in zip(r, r[1:-1])), r)
        self.assertEqual(r[-1], 1)
        self.assertLess(r[1], 0.35, "a drizzle is light")
        self.assertGreater(r[5], 0.75, "20 mm/h is heavy")

    def test_kinds(self):
        self.assertEqual(self.o["kinds"], ["clear", "rain", "storm", "storm", "fog", "cloudy", "clear"])

    def test_haze_rain_smog_and_mist_close_the_view(self):
        clear, rain, smog, mist = self.o["fog"]
        self.assertLess(rain, clear)
        self.assertLess(smog, clear)
        self.assertLess(mist, rain)
        d = self.o["dim"]
        self.assertTrue(d[0] < d[1] < d[2])

    def test_the_ground_and_the_light(self):
        w = self.o["wet"]
        self.assertEqual(w[0], 0)
        self.assertGreater(w[1], 0.3, "yesterday's rain leaves the ground wet")
        self.assertGreater(w[2], 0.5)
        self.assertNotEqual(*self.o["smogTint"])
        hot = self.o["hotTint"]
        self.assertNotEqual(hot[0], hot[1])
        self.assertNotEqual(hot[0], hot[2])
        self.assertEqual(self.o["wind"], [1, 0, 1])
        self.assertEqual(self.o["nulls"], ["clear", True, True, True])

    def test_a_reading_eases_in_and_falls_back(self):
        o = self.o
        self.assertFalse(o["before"])
        self.assertTrue(o["set"])
        self.assertFalse(o["again"], "the same reading twice changes nothing")
        self.assertEqual(o["ease"][0], 0)
        self.assertEqual(o["ease"][1:], [1, "rain", True, True])
        self.assertEqual(o["forecast"][:2], [1, True])
        self.assertIn("12.0 mm/h", o["forecast"][2])
        self.assertIn("Koramangala", o["forecast"][2])
        self.assertEqual(o["ground"]["snow"], 0)
        self.assertGreater(o["ground"]["wet"], 0.5)
        self.assertEqual(o["stale"], [False, True])
        self.assertFalse(o["off"])


if __name__ == "__main__":
    unittest.main()
