"""HQ lots (City Gen v5, claude-hq@4): every lot the same size, so what an owner's usage (the HQ level) buys shows in the
height of their three buildings (games/hqtower.js massing: the tower and two annexes) and in the finish of the lot round
them (games/hqcityparts.js dressPlan: plain paving, then lawns, trees and lamps, then a forecourt, fountain, planters and
flags, then marble, gold trim and valet cars), deterministic per owner. Runs the pure parts under node on a 36 x 34 m lot
(backend/src/worldgen/v5/doc.rs HQ_LOT_W x HQ_LOT_D) placed as hqcity3d places it. Stdlib only; skipped without node."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

HARNESS = r"""
const fs = require("fs");
const root = %(root)s;
globalThis.window = {HQV: {}};
const HQV = window.HQV;
for (const f of ["hqstyle", "hqtower", "hqbase", "world", "hqcityparts", "hqcity", "hqmerge", "hqcity3d"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const C3 = HQV.hqCity3d, P = HQV.hqCityParts, T = HQV.hqTower;
function hashStr(s){ var h = 2166136261 >>> 0; s = String(s); for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function rng(seed){ var a = seed >>> 0 || 1; return function(){ a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0)/4294967296; }; }
const rngOf = k => rng(hashStr(k));
// an HQ lot as the generator writes it: 36 m along its street, 34 m deep, its door on the street (+z)
const lot = {id: 7, kind: "hq", rank: 0, x: 10000, z: 20000, w: 3600, d: 3400, front: [0, 65536], door: [10000, 0, 21700],
  poly: [[8200, 18300], [11800, 18300], [11800, 21700], [8200, 21700]]};
const p = C3.placeLot(lot), g = C3.grandOf(lot, p), R = C3.lotRing(lot, p), gar = C3.garagePlace(lot, p, 2, g), keep = C3.lotKeep(g, gar);
function inRing(x, z){ var c = false; for(var i = 0, j = R.length - 1; i < R.length; j = i++){ var a = R[i], b = R[j]; if((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0])*(z - a[1])/(b[1] - a[1]) + a[0]) c = !c; } return c; }
const out = {grand: g, garage: gar, plans: {}, clear: [], massing: []};
[1, 9, 10, 24, 25, 39, 40, 60].forEach(L => {
  const pl = P.dressPlan(R, L, "user-a", keep, rngOf), c = {};
  pl.forEach(o => { c[o.kind] = (c[o.kind] || 0) + 1;
    if(o.kind === "lawn" || o.kind === "forecourt") return;
    out.clear.push({L, kind: o.kind, inside: inRing(o.x, o.z), hits: keep.some(K => Math.abs(o.x - K[0]) < K[2] && Math.abs(o.z - K[1]) < K[3])}); });
  out.plans[L] = {tier: P.dressTier(L), kinds: c};
});
out.same = JSON.stringify(P.dressPlan(R, 40, "user-a", keep, rngOf)) === JSON.stringify(P.dressPlan(R, 40, "user-a", keep, rngOf));
out.differ = JSON.stringify(P.dressPlan(R, 40, "user-a", keep, rngOf)) !== JSON.stringify(P.dressPlan(R, 40, "user-b", keep, rngOf));
out.blocked = P.dressBlocked({blocks: [[1, 2, 0.5], [5, 5, 0, 2, 1]]}, 1.2, 2) && P.dressBlocked({blocks: [[5, 5, 0, 2, 1]]}, 6.5, 5.5) && !P.dressBlocked({blocks: [[5, 5, 0, 2, 1]]}, 7.5, 5);
[1, 5, 10, 20, 30, 40, 50].forEach(L => { const M = T.massing(L, g, 0, null, "glass"); out.massing.push({L, top: M.top, three: M.three, annexes: M.wings.filter(w => w.annex).length, towerTop: M.tiers[M.tiers.length - 1].y0 + M.tiers[M.tiers.length - 1].h, annexTop: Math.max.apply(null, M.wings.map(w => w.y0 + w.h))}); });
// the same lot turned 30 degrees to its block's frame (v5 blocks are rotated rectangles): its front Q16, its corners turned
const th = Math.PI/6, fx = Math.sin(th), fz = Math.cos(th), ax = fz, az = -fx;
const rot = (a, b) => [Math.round(10000 + a*ax + b*fx), Math.round(20000 + a*az + b*fz)];
const tl = {id: 8, kind: "hq", rank: 1, x: 10000, z: 20000, w: 3600, d: 3400, front: [Math.round(fx*65536), Math.round(fz*65536)],
  door: [rot(0, 1700)[0], 0, rot(0, 1700)[1]], poly: [rot(-1800, -1700), rot(1800, -1700), rot(1800, 1700), rot(-1800, 1700)]};
const tp = C3.placeLot(tl), tR = C3.lotRing(tl, tp), tg = C3.grandOf(tl, tp), tgar = C3.garagePlace(tl, tp, 2, tg);
const xs = tR.map(q => q[0]), zs = tR.map(q => q[1]);
const corner = rot(1800, 1700);
out.turned = {grand: tg, garage: !!tgar, rot: tp.rot, x: [Math.min(...xs), Math.max(...xs)], z: [Math.min(...zs), Math.max(...zs)],
  same: JSON.stringify(R.map(q => q.map(v => Math.round(v*10)))) === JSON.stringify(tR.map(q => q.map(v => Math.round(v*10)))),
  pickIn: !!C3.pickAt([{lot: tl}], (corner[0] - 100*(fx + ax))/100, (corner[1] - 100*(fz + az))/100),
  pickOut: !!C3.pickAt([{lot: tl}], 100 + 17.5, 200 + 16.5)};   // (inside the lot's unturned w x d box, outside the lot)
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node missing")
class HqLots(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", HARNESS % {"root": json.dumps(ROOT)}], capture_output=True, text=True, timeout=300)
        if r.returncode != 0:
            raise AssertionError("node failed:\n" + r.stderr[-4000:])
        cls.out = json.loads(r.stdout)

    def test_the_lot_holds_the_biggest_hq_and_its_garage(self):
        self.assertEqual(self.out["grand"], 1)
        self.assertIsNotNone(self.out["garage"])

    def test_three_buildings_as_tall_as_the_owners_usage(self):
        m = self.out["massing"]
        for x in m:
            with self.subTest(level=x["L"]):
                self.assertTrue(x["three"])
                self.assertEqual(x["annexes"], 2, "the tower and two annexes")
                self.assertLess(x["annexTop"], x["towerTop"], "the tower stands over its annexes")
        tops = [x["top"] for x in m]
        self.assertEqual(tops, sorted(tops))
        self.assertGreater(tops[-1], 3 * tops[0], "a level-50 HQ towers over a level-1 one on the same lot")

    def test_poshness_by_level(self):
        P = self.out["plans"]
        self.assertEqual(P["1"]["kinds"], {}, "level 1: plain paving")
        self.assertEqual(P["9"]["tier"], 0)
        for L in ("10", "24"):
            self.assertEqual(P[L]["tier"], 1)
            self.assertGreaterEqual(P[L]["kinds"].get("tree", 0), 6)
            self.assertGreaterEqual(P[L]["kinds"].get("lamp", 0), 1)
            self.assertIn("lawn", P[L]["kinds"])
            self.assertNotIn("fountain", P[L]["kinds"])
        for L in ("25", "39"):
            self.assertEqual(P[L]["tier"], 2)
            for k in ("forecourt", "fountain", "planter", "flag"):
                self.assertIn(k, P[L]["kinds"], k)
            self.assertNotIn("car", P[L]["kinds"])
        for L in ("40", "60"):
            self.assertEqual(P[L]["tier"], 3)
            self.assertGreaterEqual(P[L]["kinds"].get("car", 0), 2, "valet cars")
        n = [sum(P[L]["kinds"].values()) for L in ("1", "10", "25", "40")]
        self.assertEqual(n, sorted(n))

    def test_the_finish_stays_on_the_lot_clear_of_the_hq_and_garage(self):
        self.assertGreater(len(self.out["clear"]), 50)
        for c in self.out["clear"]:
            with self.subTest(level=c["L"], kind=c["kind"]):
                self.assertTrue(c["inside"])
                self.assertFalse(c["hits"], "on the building, the walk, the garage or its way out")
        self.assertTrue(self.out["blocked"])

    def test_a_turned_lot_is_the_same_lot_in_its_own_frame(self):
        t = self.out["turned"]
        self.assertAlmostEqual(t["rot"], 0.5236, places=3, msg="the HQ turned to the lot's front")
        self.assertTrue(t["same"], "the lot's ring in the HQ's frame as the unturned lot's")
        self.assertAlmostEqual(t["x"][0], -18, places=1)
        self.assertAlmostEqual(t["x"][1], 18, places=1)
        self.assertEqual(t["grand"], 1)
        self.assertTrue(t["garage"])
        self.assertTrue(t["pickIn"], "a tap just inside the turned lot's corner picks it")
        self.assertFalse(t["pickOut"], "a tap in its unturned box, off the lot, does not")

    def test_deterministic_per_owner(self):
        self.assertTrue(self.out["same"])
        self.assertTrue(self.out["differ"])


if __name__ == "__main__":
    unittest.main()
