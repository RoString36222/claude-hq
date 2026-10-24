"""Ambient sounds (HQ 3.11.1, Sound PR B): thunder and fireworks are heard only within about a kilometre of the camera,
fading to nothing at that edge (no floor), and an "Ambient sounds" volume (localStorage hq_ambient, 0..1, 100% by
default; Sound PR B made the 3.11.1 switch a slider, its stored "0" still off) silences thunder, fireworks, the rain's
hiss and the jets' roar at 0% without touching engines or game sounds. Node with a fake AudioContext; skipped without
node. The volume's scaling and the migration: tests/test_spatial_sound.py. The Settings slider (ui/app/16-settings.js)
runs under node too, on stub rows: what it shows for each stored value, what it stores, its aria-valuetext, its
announcement and its preview."""
import json
import os
import re
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


# ui/app/16-settings.js's Ambient sounds block (its helper and its IIFE), run on stub rows: $, announce, localStorage,
# with and without the engine (HQV.engine)
SETTINGS = r"""
const fs = require('fs'), path = require('path'), R0 = process.argv[1];
const src = fs.readFileSync(path.join(R0, 'ui', 'app', '16-settings.js'), 'utf8');
const i = src.indexOf('/* ---- ambient sounds volume'), j = src.indexOf('})();', i) + 5;
const block = src.slice(i, j);
function page(stored, engine){
  const store = {}, said = [], els = {}, calls = [];
  if (stored !== undefined) store.hq_ambient = stored;
  const el = id => { const on = {}; return (els[id] = {id, value: '', textContent: '', attrs: {},
    setAttribute(k, v){ this.attrs[k] = String(v); }, addEventListener(k, f){ on[k] = f; }, fire(k){ on[k](); }}); };
  el('setAmbient'); el('setAmbientVal');
  const localStorage = {getItem: k => k in store ? store[k] : null, setItem(k, v){ store[k] = String(v); }};
  const HQV = engine ? {engine: engine(calls, store)} : {};
  new Function('window', 'HQV', '$', 'announce', 'localStorage', 'MutationObserver', block)(
    {HQV}, HQV, id => els[id] || null, t => said.push(t), localStorage, function(){ this.observe = function(){}; });
  const r = els.setAmbient, l = els.setAmbientVal;
  return {said, calls,
    now: () => ({value: +r.value, text: l.textContent, aria: r.attrs['aria-valuetext'], stored: store.hq_ambient === undefined ? null : store.hq_ambient}),
    set(v, ev){ r.value = String(v); r.fire(ev); }};
}
const out = {shown: {}};
// what it shows: the 3.11.1 Off ("0") is 0%, its On ("1"), unset, empty and garbage are 100%
[['0'], ['1'], [undefined], ['0.35'], ['garbage'], ['']].forEach(([v]) => { out.shown[String(v)] = page(v).now(); });
// without the engine: input stores the 0..1 number and labels it, change announces it
const p = page(undefined);
p.set(35, 'input'); out.input35 = p.now();
p.set(35, 'change'); out.said35 = p.said.slice();
p.set(0, 'input'); out.input0 = p.now();
p.set(0, 'change'); out.said0 = p.said.slice(1);
p.set(150, 'input'); out.clamped = p.now();
// with the engine: input sets its volume; change announces and previews the level (not at 0%, not under Calm)
let calm = false;
const eng = (calls, store) => ({ambientVolume: () => store.hq_ambient === undefined ? 1 : +store.hq_ambient,
  ambientSetVolume: v => { calls.push(['set', v]); store.hq_ambient = String(v); }, ambientPreview: () => { calls.push(['preview']); }, calm: () => calm});
const q = page('0.5', eng);
out.engShown = q.now();
q.set(70, 'input'); q.set(70, 'change'); q.set(0, 'input'); q.set(0, 'change'); calm = true; q.set(40, 'input'); q.set(40, 'change');
out.engCalls = q.calls; out.engSaid = q.said; out.engNow = q.now();
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
        html = self.read("index.html")
        m = re.search(r'<input\b[^>]*\bid="setAmbient"[^>]*>', html)
        self.assertTrue(m, "the slider")
        attrs = dict(re.findall(r'([\w-]+)="([^"]*)"', m.group(0)))
        self.assertEqual({k: attrs.get(k) for k in ("type", "min", "max", "step", "aria-describedby")},
                         {"type": "range", "min": "0", "max": "100", "step": "5", "aria-describedby": "setAmbientHint"})
        lab = re.search(r'<label\b[^>]*\bfor="setAmbient"[^>]*>(.*?)</label>', html, re.S)
        self.assertTrue(lab, "a label for it")
        self.assertTrue(lab.group(1).strip().startswith("Ambient sounds"))
        self.assertRegex(lab.group(1), r'<span\b[^>]*\bid="setAmbientVal"[^>]*\baria-hidden="true"')   # the % shown, not read twice
        self.assertRegex(html, r'<span\b[^>]*\bid="setAmbientHint"[^>]*>[^<]+</span>')
        self.assertNotIn('type="checkbox" id="setAmbient"', html)     # the 3.11.1 switch is gone


@unittest.skipUnless(NODE, "node is not installed")
class AmbientSlider(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", SETTINGS, ROOT], capture_output=True, text=True, timeout=120)
        if r.returncode:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_it_shows_the_stored_volume(self):
        s = self.o["shown"]
        self.assertEqual(s["0"], {"value": 0, "text": "off", "aria": "Off", "stored": "0"})      # the old Off: 0%, Off
        self.assertEqual(s["1"], {"value": 100, "text": "100%", "aria": "100%", "stored": "1"})  # the old On: 100%
        self.assertEqual(s["undefined"], {"value": 100, "text": "100%", "aria": "100%", "stored": None})
        self.assertEqual((s["0.35"]["value"], s["0.35"]["aria"]), (35, "35%"))
        self.assertEqual(s["garbage"]["value"], 100)
        self.assertEqual(s[""]["value"], 100)

    def test_without_the_engine_it_stores_the_number(self):
        o = self.o
        self.assertEqual(o["input35"], {"value": 35, "text": "35%", "aria": "35%", "stored": "0.35"})
        self.assertEqual(o["said35"], ["Ambient sounds 35%"])          # announced on change...
        self.assertEqual(o["input0"], {"value": 0, "text": "off", "aria": "Off", "stored": "0"})
        self.assertEqual(o["said0"], ["Ambient sounds off"])
        self.assertEqual((o["clamped"]["stored"], o["clamped"]["aria"]), ("1", "100%"))

    def test_with_the_engine_it_sets_and_previews(self):
        o = self.o
        self.assertEqual((o["engShown"]["value"], o["engShown"]["aria"]), (50, "50%"))
        self.assertEqual(o["engCalls"], [["set", 0.7], ["preview"], ["set", 0], ["set", 0.4]])   # no preview at 0% or Calm
        self.assertEqual(o["engSaid"], ["Ambient sounds 70%", "Ambient sounds off", "Ambient sounds 40%"])
        self.assertEqual(o["engNow"]["aria"], "40%")


if __name__ == "__main__":
    unittest.main()
