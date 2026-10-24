"""Ambient sounds (HQ 3.11.1, Sound PR B): thunder and fireworks are heard only within about a kilometre of the camera,
fading to nothing at that edge (no floor), and an "Ambient sounds" volume (localStorage hq_ambient, 0..1, 100% by
default; Sound PR B made the 3.11.1 switch a slider, its stored "0" still off) silences thunder, fireworks, the rain's
hiss and the jets' roar at 0% without touching engines or game sounds. Node with a fake AudioContext; skipped without
node. The volume's scaling and the migration: tests/test_spatial_sound.py."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

SCRIPT = r"""
const fs = require('fs'), path = require('path'), R0 = process.argv[1];
let now = 0; const store = {}, gains = [];
function param(v){ const p = {value: v, ev: [], setTargetAtTime(x, t){ p.ev.push(['T', x, t]); },
  cancelScheduledValues(t){ p.ev = p.ev.filter(e => e[2] < t); }, setValueAtTime(x, t){ p.ev.push(['V', x, t]); },
  exponentialRampToValueAtTime(){}}; return p; }
function node(){ return {connect(){}, start(){}, stop(){}, frequency: param(0), detune: param(0), Q: param(0), type: '', playbackRate: param(1)}; }
class AC { constructor(){ this.state = 'running'; this.sampleRate = 8000; this.destination = {}; }
  get currentTime(){ return now; } resume(){ return Promise.resolve(); }
  createGain(){ const n = node(); n.gain = param(1); gains.push(n.gain); return n; }
  createOscillator(){ return node(); } createBiquadFilter(){ return node(); } createBufferSource(){ return node(); }
  createWaveShaper(){ return node(); } createPeriodicWave(){ return {}; }
  createDynamicsCompressor(){ const n = node(); ['threshold', 'knee', 'ratio', 'attack', 'release'].forEach(k => n[k] = param(0)); return n; }
  createBuffer(c, n){ const d = new Float32Array(n); return {getChannelData: () => d}; } }
const window = {HQV: {}, matchMedia: () => ({matches: false}), AudioContext: AC};
const document = {documentElement: {classList: {contains: () => false}}};
global.localStorage = {getItem: k => k in store ? store[k] : null, setItem(k, v){ store[k] = String(v); }};
global.performance = {now: () => 0};
store.hq_sfx = '0.5';
new Function('window', 'document', fs.readFileSync(path.join(R0, 'games', 'engine.js'), 'utf8'))(window, document);
const E = window.HQV.engine, out = {};
const last = p => p.ev.length ? p.ev[p.ev.length - 2 >= 0 ? p.ev.length - 2 : 0][1] : p.value;   // the target before set()'s fall-off
out.defaultOn = E.ambientOn(); out.outOn = !!E.ambientOut(); out.sfxOn = !!E.audioOut();
const loop = E.ambientLoop(2600, 0.35), g = gains[gains.length - 1];
loop.set(0.1); out.loopOn = last(g);
E.ambientSet(false);
out.stored = store.hq_ambient; out.off = E.ambientOn(); out.outOff = E.ambientOut(); out.sfxStill = !!E.audioOut();
now += 1; loop.set(0.1); out.loopOff = last(g);
E.ambientSet(true); out.back = E.ambientOn();
// the cut-off: thunder and fireworks fall to nothing at a kilometre, with no floor
global.window = {HQV: {}};
eval(fs.readFileSync(path.join(R0, 'games', 'hqweather.js'), 'utf8'));
const W = window.HQV.hqWeather;
eval(fs.readFileSync(path.join(R0, 'games', 'hqspectacle.js'), 'utf8'));
const S = window.HQV.hqSpectacle;
const ds = [0, 100, 500, 900, 990, 999.9, 1000, 1200, 1900, 2200, NaN, -5];
out.thunder = {M: W.THUNDER_M, v: ds.map(d => W.thunderVol(d))};
out.boom = {M: S.BOOM_M, v: ds.map(d => S.boomVol(d))};
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
class AmbientSoundTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", SCRIPT, ROOT], capture_output=True, text=True, timeout=120)
        if r.returncode:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def read(self, *p):
        with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
            return f.read()

    def test_switch_is_on_by_default_and_separate_from_game_sounds(self):
        o = self.o
        self.assertTrue(o["defaultOn"])
        self.assertTrue(o["outOn"])
        self.assertGreater(o["loopOn"], 0)
        self.assertEqual(o["stored"], "0")
        self.assertFalse(o["off"])
        self.assertIsNone(o["outOff"])
        self.assertEqual(o["loopOff"], 0)
        self.assertTrue(o["sfxStill"])       # engines and game sounds keep playing
        self.assertTrue(o["back"])

    def check_falloff(self, d, peak):
        self.assertLessEqual(d["M"], 1000)
        v = d["v"]
        self.assertAlmostEqual(v[0], peak)
        self.assertTrue(all(a > b for a, b in zip(v[:6], v[1:6])))   # falls with distance
        self.assertLess(v[5], 0.001)                                   # to nothing at the edge: no floor
        self.assertEqual(v[6:], [0, 0, 0, 0, 0, 0])                   # silent beyond it (1.9 km thunder, 2.2 km fireworks)

    def test_thunder_only_within_a_kilometre(self):
        self.check_falloff(self.o["thunder"], 0.85)

    def test_fireworks_only_within_a_kilometre(self):
        self.check_falloff(self.o["boom"], 0.55)

    def test_every_ambient_sound_goes_through_the_switch(self):
        w, s, a = self.read("games", "hqweather.js"), self.read("games", "hqspectacle.js"), self.read("games", "hqairbase.js")
        self.assertIn("E.ambientOut ? E.ambientOut()", w)
        self.assertIn("(E.ambientLoop || E.noiseLoop)(2600", w)
        self.assertIn("if(dist < THUNDER_M) pending.push", w)
        self.assertIn("E.ambientOut ? E.ambientOut()", s)
        self.assertIn("if(d < BOOM_M) boom(", s)
        self.assertIn("(E.ambientLoop || E.noiseLoop)(320", a)

    def test_settings_has_the_slider(self):
        html, js = self.read("index.html"), self.read("ui", "app", "16-settings.js")
        self.assertIn('<label for="setAmbient">Ambient sounds <span id="setAmbientVal" class="hint" aria-hidden="true"></span></label>', html)
        self.assertIn('<input id="setAmbient" type="range" min="0" max="100" step="5" aria-describedby="setAmbientHint">', html)
        self.assertIn('id="setAmbientHint"', html)
        self.assertNotIn('type="checkbox" id="setAmbient"', html)     # the 3.11.1 switch is gone
        self.assertIn('$("setAmbient")', js)
        self.assertIn("HQV.engine.ambientSetVolume(v/100)", js)
        self.assertIn('"hq_ambient"', js)
        self.assertIn('r.setAttribute("aria-valuetext", v ? v+"%" : "Off")', js)
        self.assertIn('announce(v ? "Ambient sounds "+v+"%" : "Ambient sounds off")', js)


if __name__ == "__main__":
    unittest.main()
