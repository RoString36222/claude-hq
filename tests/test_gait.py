"""The people's gait (games/people3d.js, HQ 3.41): one phase drives every locomotion clip, each clip's playback is the
ground speed over its MEASURED stride (Walk 1.43 m a cycle, Run 2.0 m, at the drawn 1.7 m), the run's stride
lengthens past a jog, and the way you move relative to your facing picks forward / back / sideways clips.

One node process loads people3d.js against a stub `window` (no engine: only the pure gait part runs) and the Python
side checks the plan: weights sum to 1, the cadence times the stride is the ground speed (no gliding), the zones
crossfade, the directions pick their clips, a diagonal's shorter blended stride is accounted for, and the crowds and
hq3d use the same paces. Skipped when node is not installed."""
import json
import math
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

HARNESS = r"""
var fs = require("fs"), root = process.argv[1];
global.window = {HQV: {}};
new Function(fs.readFileSync(root + "/games/people3d.js", "utf8"))();
var G = window.HQV.gait, out = {GAIT: G.GAIT, has3d: !!window.HQV.people3d};
var PI = Math.PI;
out.plans = [];
[0, 0.3, 0.8, 1.3, 2.0, 2.4, 3, 5.5, 8, 10.4].forEach(function(v){
  [0, PI/4, PI/2, -PI/2, PI, 3*PI/4].forEach(function(r){ var p = G.plan(v, r, 0); p.v = v; p.rel = r; out.plans.push(p); });
});
out.shuffle = G.plan(0, 0, 3);
out.still = G.plan(0, 0, 0);
out.odd = G.plan(NaN, Infinity, "x");
out.diag = [G.stride({sprint: 1}, 1), G.stride({sprint: 0.5, left: 0.5}, 1), G.stride({walk: 1}, 1.4), G.stride({}, 1)];
process.stdout.write(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class Gait(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", HARNESS, ROOT], capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout)

    def test_pure_part_loads_without_the_engine(self):
        self.assertFalse(self.o["has3d"])                       # the engine-bound part bailed out, the gait did not
        g = self.o["GAIT"]
        self.assertAlmostEqual(g["walk"]["stride"], 1.43, places=2)   # measured: 0.86 m/s x 1.667 s
        self.assertAlmostEqual(g["sprint"]["stride"], 2.0, places=2)  # measured: 2.0 m/s x 1.0 s

    def test_weights_sum_to_one(self):
        for p in self.o["plans"]:
            s = sum(p[k] for k in ("idle", "walk", "sprint", "back", "left", "right"))
            self.assertAlmostEqual(s, 1, places=9, msg=p)
            for k in ("idle", "walk", "sprint", "back", "left", "right"):
                self.assertGreaterEqual(p[k], 0)

    def test_cadence_times_stride_is_the_ground_speed(self):
        # no gliding: the feet cover exactly the ground the body does, whatever the blend
        for p in self.o["plans"]:
            if p["v"] > 0:
                self.assertAlmostEqual(p["cps"] * p["stride"], p["v"], places=9, msg=p)

    def test_zones_crossfade(self):
        f = {p["v"]: p for p in self.o["plans"] if p["rel"] == 0}
        self.assertEqual(f[0]["idle"], 1)
        self.assertGreater(f[0.3]["idle"], 0.3); self.assertGreater(f[0.3]["walk"], 0.3)   # setting off
        self.assertAlmostEqual(f[1.3]["walk"], 1, places=9)                                 # a walk
        self.assertGreater(f[2.0]["walk"], 0.1); self.assertGreater(f[2.0]["sprint"], 0.1)   # walk into run
        self.assertAlmostEqual(f[3]["sprint"], 1, places=9)
        self.assertEqual(f[1.3]["k"], 1)                                                    # a walk is never stretched
        self.assertGreater(f[5.5]["k"], 1.2)                                                 # W (FOOT.walk): a long run
        self.assertLessEqual(f[10.4]["k"], self.o["GAIT"]["kMax"] + 1e-9)
        # cadences stay human: W about 2 strides a second, Shift under 3
        self.assertTrue(1.6 < f[5.5]["cps"] < 2.3, f[5.5]["cps"])
        self.assertTrue(2.2 < f[8]["cps"] < 3.0, f[8]["cps"])

    def test_directions_pick_their_clips(self):
        d = {(p["v"], round(p["rel"], 3)): p for p in self.o["plans"]}
        self.assertAlmostEqual(d[(3, round(math.pi, 3))]["back"], 1, places=9)
        self.assertAlmostEqual(d[(3, round(math.pi / 2, 3))]["left"], 1, places=9)
        self.assertAlmostEqual(d[(3, round(-math.pi / 2, 3))]["right"], 1, places=9)
        diag = d[(3, round(math.pi / 4, 3))]
        self.assertAlmostEqual(diag["sprint"], 0.5, places=6); self.assertAlmostEqual(diag["left"], 0.5, places=6)

    def test_diagonal_blend_has_the_shorter_stride(self):
        full, diag, walk, none = self.o["diag"]
        self.assertAlmostEqual(diag / full, math.sqrt(0.5), places=6)   # the feet's paths blend as vectors
        self.assertAlmostEqual(walk, 1.43, places=6)                    # the walk is never stretched
        self.assertAlmostEqual(none, 1.43, places=6)

    def test_turning_on_the_spot_shuffles(self):
        s = self.o["shuffle"]
        self.assertGreater(s["walk"], 0.3); self.assertGreater(s["cps"], 0)
        self.assertEqual(self.o["still"]["cps"], 0)
        odd = self.o["odd"]
        self.assertTrue(all(math.isfinite(odd[k]) for k in ("idle", "walk", "sprint", "k", "stride", "cps")))

    def test_everyone_uses_the_measured_paces(self):
        npc = open(os.path.join(ROOT, "games", "npcdraw.js"), encoding="utf-8").read()
        walk_clip = float(re.search(r"var WALK_CLIP = ([0-9.]+)", npc).group(1))
        self.assertAlmostEqual(walk_clip, 0.86, places=2)
        self.assertIn("SPRINT_CLIP = 2.0", npc)
        spec = open(os.path.join(ROOT, "games", "hqspectacle.js"), encoding="utf-8").read()
        self.assertIn("m.v/0.86", spec)
        hq = open(os.path.join(ROOT, "games", "hq3d.js"), encoding="utf-8").read()
        self.assertIn("P3.gaitPlan(gv, gr, rate)", hq)
        self.assertIn("HQV.people3d.gaitPost(avatar.ch, dt)", hq)
        self.assertIn("HQV.people3d.gaitPost(P.ch, dt)", hq)


if __name__ == "__main__":
    unittest.main()
