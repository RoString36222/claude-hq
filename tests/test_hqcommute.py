"""Commuters (games/hqcommute.js, HQ 3.15 transport revamp plan 3.5 / 5.6).

node loads hqcommute.js against a stub `window` (TZ=UTC; [3.23] the city clock is Koramangala's, IST, whatever TZ is) and prints the numbers:
the day curve (peaks, midday, night, smooth), loads and occupancy (deterministic, sized by the load, standing
only over capacity), crowds at stops, the npcsim riders hook, colours and the passenger geometry (and, with
the vendored three.js, the figures' BufferGeometry). Skipped when node is not installed. Stdlib only."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

HARNESS = r"""
import fs from "fs";
const root = %(root)s;
globalThis.window = {HQV: {}};
new Function(fs.readFileSync(root + "/games/hqcommute.js", "utf8"))();
// ([3.23] the City's clock is Koramangala's, IST: D0 is midnight there)
const C = window.HQV.hqCommute, out = {}, H = 3600000, D0 = Date.UTC(2026, 9, 21) - 5.5*H;
out.curve = {};
for(let h = 0; h <= 24; h += 0.25) out.curve[h.toFixed(2)] = C.curve(h);
out.wrap = [C.curve(-1), C.curve(23), C.curve(25), C.curve(1), C.curve(NaN)];
// smoothness: the largest step between samples 1 minute apart
let worst = 0; for(let m = 0; m < 24*60; m++) worst = Math.max(worst, Math.abs(C.curve((m + 1)/60) - C.curve(m/60)));
out.maxStep = worst;
out.load = {
  peak: C.load("tram", "T1", "t1:4", D0 + 8.5*H, "w"), noon: C.load("tram", "T1", "t1:4", D0 + 12.5*H, "w"), night: C.load("tram", "T1", "t1:4", D0 + 3*H, "w"),
  same: C.load("bus", "B1", "b1:2", D0 + 17.5*H, "w") === C.load("bus", "B1", "b1:2", D0 + 17.5*H, "w"),
  seeds: [C.load("bus", "B1", "b1:2", D0 + 17.5*H, "w"), C.load("bus", "B1", "b1:2", D0 + 17.5*H, "x")], cab: C.load("cab", "x", "y", D0 + 8*H, "w")
};
let lo = 9, hi = -9;
["bus", "tram", "metro", "rail", "link", "ferry", "gondola"].forEach(function(m){ for(let h = 0; h < 48; h += 0.5) for(let v = 0; v < 6; v++){ const l = C.load(m, "L" + v, "v" + v, D0 + h*H, "s"); lo = Math.min(lo, l); hi = Math.max(hi, l); } });
out.load.range = [lo, hi];
out.occ = {
  peak: C.occupied("tram", "t1:4", "k", 48, 20, D0 + 8.5*H, "w"), peak2: C.occupied("tram", "t1:4", "k", 48, 20, D0 + 8.5*H, "w"),
  noon: C.occupied("tram", "t1:4", "k", 48, 20, D0 + 12.5*H, "w"), night: C.occupied("tram", "t1:4", "k", 48, 20, D0 + 3*H, "w"),
  // ([3.23] other at noon: at the peak both can be full)
  other: C.occupied("tram", "t1:4", "k2", 48, 20, D0 + 12.5*H, "w"), zero: C.occupied("tram", "t1:4", "k", 0, 0, D0 + 8.5*H, "w"),
  loadPeak: C.load("tram", null, "t1:4", D0 + 8.5*H, "w"), loadNoon: C.load("tram", null, "t1:4", D0 + 12.5*H, "w")
};
out.crowd = {peak: C.crowd("s1", "tram", D0 + 8.5*H, "w"), night: C.crowd("s1", "tram", D0 + 3*H, "w"), same: C.crowd("s1", "bus", D0 + 9*H, "w") === C.crowd("s1", "bus", D0 + 9*H, "w")};
let cmax = 0; for(let h = 0; h < 24; h += 0.25) for(let s = 0; s < 20; s++) cmax = Math.max(cmax, C.crowd("s" + s, "metro", D0 + h*H, "q"));
out.crowd.max = cmax;
// npcsim riders raise a line's load
const before = C.load("bus", "bus:0", "v1", D0 + 12.5*H, "w");
window.HQV.npcSim = {ridersOn: function(line){ return line === "bus:0" ? 60 : 0; }};
out.riders = {before: before, after: C.load("bus", "bus:0", "v1", D0 + 12.5*H, "w"), other: C.load("bus", "bus:1", "v1", D0 + 12.5*H, "w") === C.load("bus", "bus:1", "v1", D0 + 12.5*H, "w")};
window.HQV.npcSim = {ridersOn: function(){ throw new Error("x"); }};
out.riders.throws = C.load("bus", "bus:0", "v1", D0 + 12.5*H, "w") === before;
delete window.HQV.npcSim;
out.paint = [C.paint("a"), C.paint("a"), C.paint("b")];
const gs = C.figureGeometry("seated"), gt = C.figureGeometry("standing");
function ext(g){ let y0 = 9, y1 = -9; for(let i = 1; i < g.pos.length; i += 3){ y0 = Math.min(y0, g.pos[i]); y1 = Math.max(y1, g.pos[i]); } return [y0, y1]; }
out.geo = {seated: {v: gs.pos.length/3, tris: gs.idx.length/3, y: ext(gs), tint: Array.from(gs.tint).filter(function(t){ return t; }).length, cols: gs.col.length/3},
           standing: {v: gt.pos.length/3, tris: gt.idx.length/3, y: ext(gt)}};
let three = null;
try { three = await import(root + "/games/vendor/three-module.js"); } catch(e){ three = null; }
if(three){
  const F = C.figures(three), F2 = C.figures(three);
  out.three = {same: F === F2, attrs: Object.keys(F.seated.attributes).sort(), vc: F.material.vertexColors, idx: F.standing.index.count};
  const sh = {vertexShader: three.ShaderLib.lambert.vertexShader};
  F.material.onBeforeCompile(sh);
  out.three.patched = sh.vertexShader.indexOf("mix(vec3(1.0), instanceColor.rgb, aTint)") >= 0 && sh.vertexShader.indexOf("attribute float aTint") >= 0;
}
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
class HqCommuteTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        p = subprocess.run([NODE, "--input-type=module", "-e", HARNESS % {"root": json.dumps(ROOT)}],
                           capture_output=True, text=True, timeout=120, env=dict(os.environ, TZ="UTC"))
        if p.returncode != 0:
            raise AssertionError("node failed:\n" + p.stderr[-4000:])
        cls.r = json.loads(p.stdout.strip().splitlines()[-1])

    def test_curve_values(self):
        c = self.r["curve"]
        for h in ("8.00", "8.50", "9.00", "9.50", "17.00", "18.00", "19.00"):
            self.assertAlmostEqual(c[h], 1.15, places=9, msg=h)
        for h in ("11.00", "12.50", "14.00", "15.50"):
            self.assertAlmostEqual(c[h], 0.45, places=9, msg=h)
        for h in ("0.00", "2.00", "4.00", "5.00", "24.00"):
            self.assertAlmostEqual(c[h], 0.08, places=9, msg=h)
        self.assertTrue(all(0.08 - 1e-9 <= v <= 1.15 + 1e-9 for v in c.values()))
        self.assertLess(self.r["maxStep"], 0.03)                  # smooth: no jumps
        self.assertGreater(c["7.00"], c["6.00"])
        self.assertLess(c["21.00"], c["19.00"])
        w = self.r["wrap"]
        self.assertAlmostEqual(w[0], w[1])
        self.assertAlmostEqual(w[2], w[3])
        self.assertAlmostEqual(w[4], 0.08)

    def test_load(self):
        l = self.r["load"]
        self.assertGreater(l["peak"], l["noon"])
        self.assertGreater(l["noon"], l["night"])
        self.assertTrue(l["same"])
        self.assertNotEqual(l["seeds"][0], l["seeds"][1])
        self.assertEqual(l["cab"], 0)
        self.assertGreaterEqual(l["range"][0], 0)
        self.assertLessEqual(l["range"][1], 1.15)
        self.assertGreater(l["range"][1], 1.0)                    # some vehicles have people standing at the peak

    def test_occupied_sizes_and_determinism(self):
        o = self.r["occ"]
        self.assertEqual(o["peak"], o["peak2"])
        self.assertNotEqual(o["noon"], o["other"])
        for k in ("peak", "noon", "night", "other"):
            s, t = o[k]["seats"], o[k]["standing"]
            self.assertEqual(s, sorted(set(s)))
            self.assertEqual(t, sorted(set(t)))
            self.assertTrue(all(0 <= i < 48 for i in s))
            self.assertTrue(all(0 <= j < 20 for j in t))
            if t:
                self.assertEqual(len(s), 48)                       # standing only once every seat is taken
        self.assertEqual(len(o["noon"]["seats"]), round(o["loadNoon"] * 48))
        self.assertEqual(o["noon"]["standing"], [])
        if o["loadPeak"] > 1:
            self.assertEqual(len(o["peak"]["standing"]), min(20, round((o["loadPeak"] - 1) / 0.15 * 20)))
        self.assertLess(len(o["night"]["seats"]), 10)
        self.assertEqual(o["zero"], {"seats": [], "standing": []})

    def test_crowd(self):
        c = self.r["crowd"]
        self.assertGreater(c["peak"], c["night"])
        self.assertTrue(c["same"])
        self.assertLessEqual(c["max"], 24)
        self.assertGreater(c["max"], 10)

    def test_npcsim_riders(self):
        r = self.r["riders"]
        self.assertGreater(r["after"], r["before"])
        self.assertLessEqual(r["after"] - r["before"], 0.3 + 1e-9)
        self.assertTrue(r["other"])
        self.assertTrue(r["throws"])

    def test_paint_and_geometry(self):
        p = self.r["paint"]
        self.assertEqual(p[0], p[1])
        self.assertNotEqual(p[0], p[2])
        for k in ("shirt", "hair", "skin"):
            self.assertEqual(len(p[0][k]), 3)
            self.assertTrue(all(0 <= v <= 1 for v in p[0][k]))
        g = self.r["geo"]
        self.assertLess(g["seated"]["tris"], 200)                   # low poly (one InstancedMesh each)
        self.assertLess(g["standing"]["tris"], 200)
        self.assertAlmostEqual(g["seated"]["y"][0], -0.45, places=5)   # feet on the floor below the seat
        self.assertGreater(g["seated"]["y"][1], 0.95)
        self.assertAlmostEqual(g["standing"]["y"][0], 0, places=5)
        self.assertGreater(g["standing"]["y"][1], 1.85)                # the hand up on the rail
        self.assertGreater(g["seated"]["tint"], 0)
        self.assertEqual(g["seated"]["cols"], g["seated"]["v"])

    def test_three_figures(self):
        t = self.r.get("three")
        if not t:
            self.skipTest("vendored three.js not importable")
        self.assertTrue(t["same"])
        self.assertEqual(t["attrs"], ["aTint", "color", "normal", "position"])
        self.assertTrue(t["vc"])
        self.assertTrue(t["patched"])


if __name__ == "__main__":
    unittest.main()
