"""What isn't a box doesn't block as one (HQ 3.13.1): a civic mass noted "ell" blocks its oval (the stadium's bowl,
the cooling tower, stacks, silos), one noted "open" blocks nothing but the parts noted on their own (a crane's or the
water tower's legs, a shelter's back and posts); the air base's control tower and radar block their circles and a
parked jet its outline; the airport car park's ground floor is open between its columns. node runs the functions
themselves, cut out of the game files. Stdlib only."""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")


def read(*p):
    with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
        return f.read()


def cut(src, start):
    m = re.search(r"\n(\s*)" + re.escape(start) + r".*?\n\1\}\n", src, re.S)
    assert m, start
    return m.group(0)


@unittest.skipUnless(NODE, "node is not installed")
class Shapes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        city, base = read("games", "hqcity3d.js"), read("games", "hqairbase.js")
        jet = re.search(r"\nvar JET_OUTLINE = .*?\}\)\);\n", base, re.S).group(0)
        src = "var CLEAR_UNDER = 2.4;\n" + cut(city, "function civicBlocked(x, z){") + cut(base, "function rectHit(R, x, z){") + \
            cut(base, "function inPoly(P, x, z){") + jet + r"""
function box(o){ return {min: {x: o.x - 50, z: o.z - 50}, max: {x: o.x + 50, z: o.z + 50}, o: o}; }
var civics = [{boxes: [box({x: 0, z: 0, hw: 50, hd: 40, rot: 0, y0: 0, ell: true}),                  // a stadium
                       box({x: 200, z: 0, hw: 5, hd: 18, rot: 0, y0: 0, open: true}),                // a crane, open...
                       box({x: 195.5, z: -9, hw: 0.5, hd: 0.5, rot: 0, y0: 0})]}];                  // ...but for its leg
var jetR = {x: 0, z: 0, hw: 5.4, hd: 8.7, rot: 0, polys: JET_OUTLINE};
process.stdout.write(JSON.stringify({
  stadium: [civicBlocked(0, 0), civicBlocked(49, 0), civicBlocked(45, 36), civicBlocked(30, 25)],
  crane: [civicBlocked(200, 0), civicBlocked(195.5, -9)],
  tower: [rectHit({x: 0, z: 0, hw: 3, hd: 3, circle: 3}, 2.5, 0), rectHit({x: 0, z: 0, hw: 3, hd: 3, circle: 3}, 2.6, 2.6)],
  jet: [rectHit(jetR, 0, 0), rectHit(jetR, 4.5, -3.8), rectHit(jetR, 4.5, 4), rectHit(jetR, 2.5, -7), rectHit(jetR, 4, -7)]}));
"""
        r = subprocess.run([NODE, "-e", src], capture_output=True, text=True, timeout=60)
        if r.returncode:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout)

    def test_an_oval_blocks_its_oval(self):
        self.assertEqual(self.o["stadium"], [True, True, False, True], "centre, rim, the box's empty corner, inside")

    def test_an_open_mass_blocks_only_its_parts(self):
        self.assertEqual(self.o["crane"], [False, True])

    def test_round_and_jet_shapes(self):
        self.assertEqual(self.o["tower"], [True, False])
        self.assertEqual(self.o["jet"], [True, True, False, True, False], "fuselage, wingtip, beside the nose, tailplane, past it")


class Source(unittest.TestCase):
    def test_the_round_and_open_things_say_so(self):
        civ = read("games", "hqcivic.js")
        self.assertIn('k.note(0, 0, 2*rx, 2*rz, 0, hgt + (T >= 4 ? 6.5 : 1.5), false, "ell")', civ)
        self.assertIn('this.note(x, z + 6, s + 1, 36, 0, h + 3.4, true, "open")', civ)
        self.assertIn('k.note(0, -1, 2*r, 2*r, 0, lh + th + r*0.6, false, "open")', civ)
        self.assertIn('k.note(x, z, len, 1.8, 0, 2.8, false, "open")', civ)

    def test_the_airport_car_parks_ground_floor_is_open(self):
        b = read("games", "hqairbldg.js")
        self.assertIn('blk("carpark", cp.u0, cp.u1, cp.v0, cp.v1, ys + 2.9, ys + 12.5);', b)


if __name__ == "__main__":
    unittest.main()
