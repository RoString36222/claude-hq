"""games/engine.js (Wave 0): the helpers Kart, Platformer and Blaster share, run under
node with a tiny window stub. Skipped without node."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SCRIPT = r"""
const fs = require('fs');
const window = {HQV: {}, matchMedia: () => ({matches: false})};
const document = {documentElement: {classList: {contains: () => false}}};
global.performance = {now: () => 0};
new Function('window', 'document', fs.readFileSync(process.argv[2], 'utf8'))(window, document);
const E = window.HQV.engine, out = {};
// sender clock: first frame sets the offset; a stale frame is dropped; a reload restarts
const P = {lastQ: -1, off: null, jit: 0};
out.first = E.senderTime(P, 100, 5.0, 0.2);            // q = 1.00 s at our 5.00 s
out.stale = E.senderTime(P, 90, 5.1, 0.2);             // older than the last: null
out.next = E.senderTime(P, 110, 5.15, 0.2);            // 0.05 s late -> jitter rises
out.jit = P.jit;
E.senderTime(P, 9000, 6.0, 0.2);                        // a minute and a half later
out.reload = E.senderTime(P, 5, 9.0, 0.2) !== null && P.lastQ === 5;   // >60 s back: the sender reloaded
// buffer + bracket
const sn = [];
for (const t of [1, 2, 2, 3]) E.pushSnap(sn, {t: t, x: t * 10}, 3);
out.times = sn.map(s => s.t);                          // strictly increasing, capped at 3
out.before = E.bracket(sn, 0).A.t;
const mid = E.bracket(sn, 2.5);
out.mid = [mid.A.t, mid.B.t, Math.round(mid.u * 100) / 100];
out.after = E.bracket(sn, 4).after;
out.empty = E.bracket([], 1);
out.fmt = [E.fmtTime(83456), E.fmtTime(null)];
out.ang = Math.round(E.angLerp(3.0, -3.0, 0.5) * 1000) / 1000;
E.loadGlb({}, 'nope', 'x').then(() => { out.kit = 'loaded'; }, e => { out.kit = e.message; })
  .then(() => console.log(JSON.stringify(out)));
"""


@unittest.skipUnless(shutil.which("node"), "node not installed")
class EngineTests(unittest.TestCase):
    def test_engine(self):
        r = subprocess.run(["node", "-", os.path.join(ROOT, "games", "engine.js")], input=SCRIPT,
                           capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        o = json.loads(r.stdout)
        self.assertEqual(o["first"], 5.0)
        self.assertIsNone(o["stale"])
        self.assertAlmostEqual(o["next"], 5.1, places=2)          # offset drifts 1% toward newer frames
        self.assertGreater(o["jit"], 0)
        self.assertTrue(o["reload"])
        self.assertEqual(len(o["times"]), 3)
        self.assertTrue(all(a < b for a, b in zip(o["times"], o["times"][1:])))
        self.assertEqual(o["before"], o["times"][0])
        self.assertTrue(o["mid"][0] <= 2.5 <= o["mid"][1])
        self.assertEqual(o["after"], 4 - o["times"][-1])
        self.assertIsNone(o["empty"])
        self.assertEqual(o["fmt"], ["1:23.46", "–"])
        self.assertAlmostEqual(abs(o["ang"]), 3.142, places=2)    # the short way round, through pi
        self.assertEqual(o["kit"], "bad model name")

    def test_games_use_the_engine(self):
        for name in ("kart", "platformer", "fps"):
            with open(os.path.join(ROOT, "games", name + ".js"), encoding="utf-8") as f:
                src = f.read()
            self.assertIn("var E = HQV.engine;", src, name)
            self.assertNotIn("GLTFLoader(", src, name)            # one three.js loader, in the engine
            self.assertNotIn("function hasWebGL2", src, name)


if __name__ == "__main__":
    unittest.main()
