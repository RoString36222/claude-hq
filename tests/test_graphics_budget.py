"""City Gen v4 phase 11 (HQ 3.34.0): the frame budgets are one set of numbers, and the graphics tour finds its spots.

The plan's budgets (1,200 draw calls a frame on the surface, 240 below the street, sized for an M3 Pro and up) are
pinned in tools/ui_smoke.py, read by tools/graphics_tour.py and tools/transit_tour.py, and stated by the page in
HQ3D_DEBUG.stats().budget (games/hq3d.js SMOKE_BUDGET): they must agree. The tour's spots come from the @3 fixture
(tools/graphics_tour.py tour_spots): every one of them must be there, with a camera where it holds one. No browser
here; the tour itself runs in CI after the UI smoke test. Stdlib only."""
import json
import os
import re
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))


def _import_tour():
    argv = sys.argv[:]
    try:
        sys.argv = [argv[0]]
        import graphics_tour  # noqa: E402  (it reads its own argv at import)
        return graphics_tour
    finally:
        sys.argv = argv


def _read(*path):
    with open(os.path.join(ROOT, *path), encoding="utf-8") as f:
        return f.read()


G = _import_tour()
U = G.U


class Budgets(unittest.TestCase):
    def test_the_plan_numbers(self):
        self.assertEqual((U.MAX_FRAME_CALLS, U.MAX_UNDER_CALLS), (1200, 240))
        self.assertEqual((G.MAX_FRAME, G.MAX_UNDER, G.MAX_TRI), (U.MAX_FRAME_CALLS, U.MAX_UNDER_CALLS, U.MAX_TRIANGLES))
        # the world's tiles keep their own, smaller budget (a regression guard on the tile batching)
        self.assertEqual(U.MAX_DRAW_CALLS, 400)
        self.assertEqual(U.MAX_TRIANGLES, 1_500_000)

    def test_the_page_states_the_same_budget(self):
        src = _read("games", "hq3d.js")
        m = re.search(r"var SMOKE_BUDGET = \{frame: (\d+), under: (\d+), triangles: (\d+)\};", src)
        self.assertIsNotNone(m, "hq3d.js SMOKE_BUDGET")
        self.assertEqual(tuple(int(x) for x in m.groups()), (U.MAX_FRAME_CALLS, U.MAX_UNDER_CALLS, U.MAX_TRIANGLES))
        self.assertIn("budget: SMOKE_BUDGET", src)

    def test_transit_tour_reads_the_same_numbers(self):
        src = _read("tools", "transit_tour.py")
        self.assertIn("MAX_FRAME = U.MAX_FRAME_CALLS", src)
        self.assertIn("MAX_UNDER = U.MAX_UNDER_CALLS", src)


class Spots(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        live = U.load_worlds().get(U.LIVE_ID)
        if not live:
            raise unittest.SkipTest("no @3 fixture")
        cls.spots = G.tour_spots(live)

    def test_every_spot(self):
        names = [n for n, _c, _s in self.spots]
        self.assertEqual(names, ["trumpet", "flyover", "boulevard", "tram-bed", "tram-platform", "tunnel", "cutting",
                                 "signals", "plaza", "metro", "hq-lot"])

    def test_held_cameras_are_finite_and_near(self):
        for name, _c, s in self.spots:
            if "pos" not in s:
                continue
            at, pos, look = s["at"], s["pos"], s["look"]
            for v in pos + look + list(at):
                self.assertTrue(isinstance(v, float) and v == v and abs(v) < 2000, (name, s))
            self.assertLess(((pos[0] - at[0]) ** 2 + (pos[2] - at[1]) ** 2) ** 0.5, 120, (name, s))
            self.assertNotEqual(pos, look, name)

    def test_tunnel_camera_is_at_the_road(self):
        t = {"x": 10.0, "y": -8.0, "z": 20.0, "dx": 0.0, "dz": 1.0}
        s = G.tunnel_spec(t, "tunnel")
        self.assertAlmostEqual(s["pos"][1], -8.0 + 2.2)
        self.assertAlmostEqual(s["look"][1], -8.0 + 2.0)
        self.assertEqual(s["pos"][2], 12.0)     # 8 m back along the bore
        json.dumps(s)


if __name__ == "__main__":
    unittest.main()
