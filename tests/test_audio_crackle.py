"""Crackle in the sound (games/engine.js): the master bus ends in a limiter, transparent below its threshold; the
engine voice's WaveShaper is 4x oversampled (its aliasing measured numerically below); the downshift's exhaust pop
respects Calm like every other pop. Node with a fake AudioContext that records the graph. Skipped without node."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

SCRIPT = r"""
const fs = require('fs');
let now = 0; const shapers = [];
function param(v){ return {value: v, setTargetAtTime(){}, cancelScheduledValues(){}, setValueAtTime(){}, exponentialRampToValueAtTime(){}}; }
function node(kind){ return {kind, outs: [], connect(n){ this.outs.push(n); return n; }, start(){}, stop(){}, frequency: param(0), detune: param(0),
  Q: param(0), pan: param(0), type: '', setPeriodicWave(){}}; }
class AC { constructor(){ this.state = 'running'; this.sampleRate = 8000; this.destination = {kind: 'dest'}; }
  get currentTime(){ return now; } resume(){ return Promise.resolve(); }
  createGain(){ const n = node('gain'); n.gain = param(1); return n; } createOscillator(){ return node('osc'); }
  createBiquadFilter(){ return node('biquad'); } createBufferSource(){ return node('src'); } createStereoPanner(){ return node('pan'); }
  createWaveShaper(){ const n = node('shaper'); shapers.push(n); return n; } createPeriodicWave(){ return {}; }
  createDynamicsCompressor(){ const n = node('comp'); ['threshold', 'knee', 'ratio', 'attack', 'release'].forEach(k => n[k] = param(0)); return n; }
  createBuffer(c, n){ const d = new Float32Array(n); return {getChannelData: () => d}; } }
const window = {HQV: {}, matchMedia: () => ({matches: false}), AudioContext: AC};
const document = {documentElement: {classList: {contains: () => false}}};
global.localStorage = {getItem: () => '1', setItem(){}};
global.performance = {now: () => 0};
new Function('window', 'document', fs.readFileSync(process.argv[1], 'utf8'))(window, document);
const E = window.HQV.engine, out = {};
const A = E.audioOut(), m = A.out, c = m.outs[0], t = c && c.outs[0];
out.chain = [m.kind, c && c.kind, t && t.kind, t && t.outs[0] && t.outs[0].kind];
out.lim = c ? {threshold: c.threshold.value, knee: c.knee.value, ratio: c.ratio.value, attack: c.attack.value, release: c.release.value} : null;
out.trim = t ? t.gain.value : null;
// the static curve the spec gives a DynamicsCompressor (knee 0), with its makeup gain, then the trim: in dB
const L = E.limiter;
function curve(x){ return x <= L.threshold ? x : L.threshold + (x - L.threshold)/L.ratio; }
const makeup = -0.6*curve(0), trimDb = 20*Math.log10(out.trim);
out.io = [-40, -12, -6, -3, 0, 6, 12].map(x => [x, +(curve(x) + makeup + trimDb).toFixed(3)]);
E.engineSound('v8').set(3000, {thr: 1});
out.oversample = shapers.map(s => s.oversample);
console.log(JSON.stringify(out));
"""

# aliasing of the engine's shaper (engine.js engineCurve, the v8: grit 2.2, its harmonics, the twin at 0.7 and the
# sub): the inharmonic share of the spectrum below 5 kHz (what the voice's low-pass lets through), oversampled R times
# with an ideal anti-alias filter, as the browser's WaveShaper does it
ALIAS = r"""
function fft(re, im){ const n = re.length;
  for(let i = 1, j = 0; i < n; i++){ let b = n >> 1; for(; j & b; b >>= 1) j ^= b; j ^= b; if(i < j){ [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for(let len = 2; len <= n; len <<= 1){ const a = -2*Math.PI/len, wr = Math.cos(a), wi = Math.sin(a);
    for(let i = 0; i < n; i += len){ let cr = 1, ci = 0; for(let k = 0; k < len/2; k++){
      const h = i + k + len/2, vr = re[h]*cr - im[h]*ci, vi = re[h]*ci + im[h]*cr;
      re[h] = re[i+k] - vr; im[h] = im[i+k] - vi; re[i+k] += vr; im[i+k] += vi; const nr = cr*wr - ci*wi; ci = cr*wi + ci*wr; cr = nr; } } } }
const FS = 48000, N = 16384, H = [1, .8, .55, .5, .3, .25, .15, .12, .08], grit = 2.2;
const curve = new Float32Array(1024), th = Math.tanh(grit); for(let i = 0; i < 1024; i++) curve[i] = Math.tanh(grit*(i/511.5 - 1))/th;
function shape(x){ const v = (Math.max(-1, Math.min(1, x)) + 1)*0.5*1023, k = Math.floor(v), f = v - k; return k >= 1023 ? curve[1023] : curve[k]*(1 - f) + curve[k + 1]*f; }
let pk = 0; for(let i = 0; i < 4096; i++){ let s = 0; H.forEach((h, j) => s += h*Math.sin(2*Math.PI*(j + 1)*i/4096)); pk = Math.max(pk, Math.abs(s)); }
function tri(p){ p -= Math.floor(p); return p < 0.25 ? 4*p : p < 0.75 ? 2 - 4*p : 4*p - 4; }
function alias(half, R){         // f0 = 2*half bins (the sub at `half`, an odd prime: aliases fall between harmonics)
  const n = N*R, f0 = 2*half*FS/N, re = new Float64Array(n), im = new Float64Array(n), drive = grit*1.35;
  for(let i = 0; i < n; i++){ const t = i/(FS*R); let s = 0; H.forEach((h, j) => s += h*Math.sin(2*Math.PI*(j + 1)*f0*t)); re[i] = shape(drive*((s/pk)*1.7 + 0.6*tri(f0*0.5*t))); }
  fft(re, im); let harm = 0, inh = 0;
  for(let b = 1; b*FS/N <= 5000; b++){ const p = re[b]*re[b] + im[b]*im[b]; if(b % half === 0) harm += p; else inh += p; }
  return 10*Math.log10(inh/harm);
}
console.log(JSON.stringify([1, 4].map(R => alias(139, R))));      // f0 ~ 815 Hz: a V8 near its 6,200 rpm redline
"""


@unittest.skipUnless(NODE, "node not installed")
class AudioCrackle(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", SCRIPT, "--", os.path.join(ROOT, "games", "engine.js")], capture_output=True, text=True, timeout=60)
        if r.returncode:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_master_ends_in_a_limiter(self):
        self.assertEqual(self.o["chain"], ["gain", "comp", "gain", "dest"])
        lim = self.o["lim"]
        self.assertEqual((lim["threshold"], lim["knee"], lim["ratio"]), (-3, 0, 20))
        self.assertLessEqual(lim["attack"], 0.003)

    def test_limiter_is_transparent_below_threshold_and_holds_peaks(self):
        for x, y in self.o["io"]:
            if x <= -3:
                self.assertAlmostEqual(y, x, places=6, msg=x)       # unity: the makeup gain is taken back off
            else:
                self.assertLess(y, -2.0, (x, y))                     # +12 dB in stays under -2 dBFS out

    def test_engine_shaper_is_oversampled(self):
        self.assertTrue(self.o["oversample"])
        self.assertEqual(set(self.o["oversample"]), {"4x"})

    def test_oversampling_removes_the_aliasing(self):
        r = subprocess.run([NODE, "-e", ALIAS], capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stderr)
        x1, x4 = json.loads(r.stdout.strip().splitlines()[-1])
        self.assertGreater(x1, -45)            # 1x: an audible inharmonic fizz
        self.assertLess(x4, -65)               # 4x: gone under the harmonics
        self.assertGreater(x1 - x4, 25)

    def test_downshift_pop_respects_calm(self):
        with open(os.path.join(ROOT, "games", "engine.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("S.blip = 0.16; if(P.pops && on && !calm()) crackle(", src)


if __name__ == "__main__":
    unittest.main()
