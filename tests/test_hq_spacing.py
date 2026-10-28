"""City Gen v4 HQ spacing: the generator's HQ pool (backend/src/worldgen/organic/hq.rs) checked with the client's own code.

The generator mirrors the client's measures (hqtower.js footprint, hqcity3d.js placeLot, grandOf, garageFits) in mm to pick
HQ lots that hold a tower and a legal garage. This runs the real modules under node on the @3 fixtures
(tests/fixtures/claude-hq@3.json.gz, island@3.json.gz) and checks, for every HQ lot:
  - the smallest tower's podium (footprint(0, 2)) stands inside the lot;
  - at the size the client grows the tower to (grandOf), some garage spot passes garageFits (0.5 m grid, 4 turns);
and for the Commons: its 64 ranks, nearest the plaza first, no two HQs closer than 40 m.
Stdlib only; skipped without node."""
import json
import math
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

HARNESS = r"""
import fs from "fs";
import zlib from "zlib";
const root = %(root)s;
globalThis.window = {HQV: {}};
const HQV = window.HQV;
for (const f of ["hqstyle", "hqtower", "hqbase", "world", "hqcityparts", "hqcity", "hqmerge", "hqnav", "hqcarpark", "hqcall", "hqcarlift", "hqcity3d"])
  new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const C3 = HQV.hqCity3d, T = HQV.hqTower;
const gz = p => JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString("utf8"));
function inRing(P, x, z){ var inside = false; for(var i = 0, j = P.length - 1; i < P.length; j = i++){ var xi = P[i][0], zi = P[i][1], xj = P[j][0], zj = P[j][1]; if((zi > z) !== (zj > z) && x < (xj - xi)*(z - zi)/(zj - zi) + xi) inside = !inside; } return inside; }
const out = {};
for (const name of ["claude-hq@3", "island@3"]) {
  const W = HQV.world.pack(gz(root + "/tests/fixtures/" + name + ".json.gz"));
  out[name] = W.lots.filter(l => l.kind === "hq").map(function(l){
    const p = C3.placeLot(l), R = C3.lotRing(l, p), g = C3.grandOf(l, p), b = T.footprint(0, 2)[0];
    let podium = true;
    for (let i = -1; i <= 1; i += 0.5) for (let j = -1; j <= 1; j += 0.5) if (!inRing(R, b[0] + i*b[2], b[1] + j*b[3])) podium = false;
    let spots = 0;
    for (let x = -30; x <= 30; x += 0.5) for (let z = -25; z <= 25; z += 0.5) for (let r = 0; r < 4; r++) if (C3.garageFits(l, p, {x: x, z: z, r: r}, g).ok) spots++;
    return {id: l.id, rank: l.rank, x: l.x, z: l.z, grand: g, podium: podium, spots: spots};
  });
}
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class HqSpacing(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        js = HARNESS % {"root": json.dumps(ROOT)}
        r = subprocess.run([NODE, "--input-type=module", "-e", js], capture_output=True, text=True, timeout=600)
        if r.returncode:
            raise RuntimeError(r.stderr)
        cls.o = json.loads(r.stdout)

    def test_every_hq_lot_holds_its_tower_and_a_legal_garage(self):
        for name, lots in self.o.items():
            self.assertTrue(lots, name)
            for l in lots:
                self.assertTrue(l["podium"], (name, l))
                self.assertGreater(l["spots"], 0, (name, l))

    def test_the_commons_keeps_64_ranks_nearest_first_40_m_apart(self):
        lots = sorted(self.o["claude-hq@3"], key=lambda l: l["rank"])
        self.assertEqual([l["rank"] for l in lots], list(range(64)))
        d = [math.hypot(l["x"], l["z"]) for l in lots]
        self.assertEqual(d, sorted(d), "rank 0 nearest the plaza")
        gap = min(math.hypot(a["x"] - b["x"], a["z"] - b["z"]) for i, a in enumerate(lots) for b in lots[i + 1:])
        self.assertGreaterEqual(gap, 4000)

    def test_an_island_has_its_one_hq(self):
        self.assertEqual([l["rank"] for l in self.o["island@3"]], [0])


if __name__ == "__main__":
    unittest.main()
