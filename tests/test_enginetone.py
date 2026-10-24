"""The motorbike engine notes, rendered ("the buzz"): every bike voice at a steady rpm through a real WebAudio
graph (an OfflineAudioContext in headless Chromium), and its spectrum: no single partial may carry most of the energy
(the top partial's share, +-2 % around it, of 80 Hz..6 kHz). Before the fix a BMW M 1000 RR cruising at 7000 rpm put
57 % of its energy in the 233 Hz firing tone, a boxer 80 %; at a steady 3000/6000/9000 rpm the old voices scored up
to 0.83 here, the new ones at most 0.55. Optional: needs node, numpy and Playwright, so it runs only
with HQ_PLAYWRIGHT_CORE (a playwright-core module dir) and HQ_CHROMIUM (a Chromium binary) set; skipped otherwise."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PW, CHROME = os.environ.get("HQ_PLAYWRIGHT_CORE"), os.environ.get("HQ_CHROMIUM")
try:
    import numpy as np
except ImportError:
    np = None

SCRIPT = r"""
const fs = require('fs'), [pw, exe, root] = process.argv.slice(2);
const { chromium } = require(pw);
(async () => {
  const br = await chromium.launch({ executablePath: exe, args: ['--mute-audio'] });
  try {
    const pg = await br.newPage(); await pg.setContent('<html></html>');
    const src = n => fs.readFileSync(root + '/games/' + n, 'utf8');
    const out = await pg.evaluate(async ({ eng, phys }) => {
      const res = {};
      for (const k of ['bike', 'single', 'twin', 'vtwin', 'boxer', 'four', 'v4', 'triple', 'crossplane', 'longstroke', 'twin270', 'vtwin45'])
        for (const rpm of [3000, 6000, 9000]) {
          const sr = 22050, off = new OfflineAudioContext(1, sr*2.5, sr);
          window.AudioContext = function(){ return off; }; try { localStorage.setItem('hq_sfx', '0.5'); } catch(e){}
          window.HQV = {}; new Function(phys)(); new Function(eng)();
          const E = window.HQV.engine, P = E.engineProfile(k);
          const e = E.engineSound(k, null, {idle: P.idle, red: P.red, limit: P.red + 400, cyl: P.cyl}), r = Math.min(rpm, P.red - 200);
          for (let i = 1; i < 149; i++) off.suspend(i/60).then(() => { e.set(r, {thr: 0.3, gear: 4, speed: 20}); off.resume(); });
          res[k + '@' + rpm] = Array.from((await off.startRendering()).getChannelData(0).subarray(sr*0.8));
        }
      return res;
    }, { eng: src('engine.js'), phys: src('hqvehiclephys.js') });
    console.log(JSON.stringify(out));
  } finally { await br.close(); }
})().catch(e => { console.error(e); process.exit(1); });
"""


@unittest.skipUnless(shutil.which("node") and np is not None and PW and CHROME, "needs node, numpy, HQ_PLAYWRIGHT_CORE, HQ_CHROMIUM")
class EngineTone(unittest.TestCase):
    def test_no_bike_voice_is_a_held_tone(self):
        r = subprocess.run(["node", "-", PW, CHROME, ROOT], input=SCRIPT, capture_output=True, text=True, timeout=300)
        self.assertEqual(r.returncode, 0, r.stderr)
        for name, x in json.loads(r.stdout).items():
            x = np.asarray(x)
            X = np.abs(np.fft.rfft(x*np.hanning(len(x))))**2
            f = np.fft.rfftfreq(len(x), 1/22050)
            m = (f > 80) & (f < 6000)
            P, fm = X[m], f[m]
            k = int(np.argmax(P))
            top = P[np.abs(fm - fm[k]) < max(2.0, 0.02*fm[k])].sum()/P.sum()
            self.assertLess(top, 0.58, "%s: %.0f%% of the energy in one partial at %.0f Hz" % (name, top*100, fm[k]))
            # the firing pulses: the 3 ms envelope beats instead of sitting flat
            n = int(22050*0.003)
            env = np.sqrt(np.convolve(x*x, np.ones(n)/n, "valid"))
            self.assertGreater(env.std()/env.mean(), 0.08, name)


if __name__ == "__main__":
    unittest.main()
