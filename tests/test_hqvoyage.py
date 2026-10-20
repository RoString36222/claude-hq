"""games/hqvoyage.js: a ferry route from the Commons' dock to an island's, run under node on the fixtures."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
SCRIPT = r"""
const fs = require('fs'), zlib = require('zlib'), path = require('path'), R0 = process.argv[1];
global.window = {HQV: {}};
eval(fs.readFileSync(path.join(R0, 'games/world.js'), 'utf8')); eval(fs.readFileSync(path.join(R0, 'games/hqvoyage.js'), 'utf8'));
const WD = window.HQV.world, V = window.HQV.hqVoyage;
const doc = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(R0, 'tests/fixtures', f + '.json.gz'))));
const Wc = WD.pack(doc('claude-hq@2')), Wi = WD.pack(doc('island@2')), B = {x: 2400, z: -3200};
const R = V.route({world: 'claude-hq@2', x: 0, z: 0, W: Wc}, {world: 'user:x@2', x: B.x, z: B.z, W: Wi});
let dry = 0, back = 0, prev = -1, maxV = 0, riverSamples = 0;
for(let t = 0; t <= R.T; t += 1){
  const p = V.poseAt(R, t);
  if(p.along < prev - 1e-6) back++; prev = p.along; maxV = Math.max(maxV, p.speed);
  if(p.leg === 'river'){
    riverSamples++;
    const inA = Math.hypot(p.x, p.z) < Math.hypot(p.x - B.x, p.z - B.z);
    const W = inA ? Wc : Wi, lx = inA ? p.x : p.x - B.x, lz = inA ? p.z : p.z - B.z;
    if(!WD.riverAt(W, lx, lz)) dry++;
  }
}
const h = V.poseAt(R, R.hand), s0 = V.poseAt(R, 0), s1 = V.poseAt(R, R.T);
const sa = V.sailings('a', 'b', 1e9, 6e5, 6e5), sb = V.sailings('b', 'a', 1e9, 6e5, 6e5);
console.log(JSON.stringify({T: R.T, len: R.len, dry, back, maxV, riverSamples, s0: s0.speed, s1: s1.speed,
  handA: Math.hypot(h.x, h.z), handB: Math.hypot(h.x - B.x, h.z - B.z), handLeg: h.leg,
  end: [s1.x - B.x, s1.z - B.z], berth: V.berthOf(Wi), same: JSON.stringify(sa) === JSON.stringify(sb), n: sa.length,
  next: V.nextSailing('a', 'b', 1e9) >= 1e9}));
"""


@unittest.skipUnless(NODE, "node not installed")
class VoyageTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", SCRIPT, ROOT], capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout)

    def test_stays_on_the_water(self):
        self.assertGreater(self.o["riverSamples"], 60)
        self.assertEqual(self.o["dry"], 0)

    def test_moves_forward_from_rest_to_rest(self):
        self.assertEqual(self.o["back"], 0)
        self.assertEqual(self.o["s0"], 0)
        self.assertLess(self.o["s1"], 0.5)
        self.assertLessEqual(self.o["maxV"], 21.0001)
        self.assertGreater(self.o["T"], 120)

    def test_hands_over_mid_sea(self):
        self.assertEqual(self.o["handLeg"], "sea")
        self.assertAlmostEqual(self.o["handA"], self.o["handB"], delta=40)

    def test_ends_at_the_island_berth(self):
        b = self.o["berth"]
        self.assertAlmostEqual(self.o["end"][0], b["x"], delta=1)
        self.assertAlmostEqual(self.o["end"][1], b["z"], delta=1)

    def test_sailings_shared_both_ways(self):
        self.assertTrue(self.o["same"])
        self.assertEqual(self.o["n"], 10)
        self.assertTrue(self.o["next"])


if __name__ == "__main__":
    unittest.main()
