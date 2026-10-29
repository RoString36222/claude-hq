"""games/worldgeom.js massing (HQ 3.36): a commercial block of 7 floors or more is a podium and a set-back tower
(a tall one stepping in again); everything else stays one box. Pure, run under node."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

SCRIPT = r"""
const fs = require("fs"), root = process.argv[1];
globalThis.window = {HQV: {}};
new Function(fs.readFileSync(root + "/games/world.js", "utf8"))();
new Function(fs.readFileSync(root + "/games/worldgeom.js", "utf8"))();
const G = window.HQV.worldgeom;
function rng(seed){ let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const R = {x0: 0, x1: 40, z0: 0, z1: 30}, out = {};
function m(floors, style, seed){ return G.massing(R, -1, 0, floors*3.5, floors, style, rng(seed)); }
out.low = m(5, "com", 1).length; out.res = m(20, "res", 1).length; out.ind = m(20, "ind", 1).length;
out.mid = [1, 2, 3, 4, 5].map(s => m(10, "com", s));
out.tall = [1, 2, 3, 4, 5, 6, 7, 8].map(s => m(30, "com", s).length);
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class Massing(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", SCRIPT, ROOT], capture_output=True, text=True, timeout=60)
        if r.returncode:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout)

    def test_low_and_other_styles_stay_one_box(self):
        self.assertEqual((self.o["low"], self.o["res"], self.o["ind"]), (1, 1, 1))

    def test_a_tower_stands_set_back_on_its_podium(self):
        for t in self.o["mid"]:
            self.assertEqual(len(t), 2)
            p, tw = t
            self.assertTrue(1 <= p["f1"] <= 3, p)
            self.assertEqual((tw["f0"], tw["f1"]), (p["f1"], 10))
            self.assertAlmostEqual(tw["y0"], p["y1"])
            self.assertGreater(tw["R"]["x0"], p["R"]["x0"]); self.assertLess(tw["R"]["x1"], p["R"]["x1"])
            self.assertGreaterEqual(tw["R"]["x1"] - tw["R"]["x0"], 8)

    def test_tall_towers_sometimes_step_in_again(self):
        self.assertIn(3, self.o["tall"])
        self.assertTrue(all(n in (2, 3) for n in self.o["tall"]))


if __name__ == "__main__":
    unittest.main()
