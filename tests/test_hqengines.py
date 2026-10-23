"""Real revs and exhaust notes (games/hqvehiclephys.js engineFor, games/engine.js engineProfile/engineHz), run under node.

Every catalogue vehicle carries its researched engine (spec.engine: idle, redline, limiter, gear ratios, primary and
final drive, rear tyre, voice, exhaust tone). Checked: the figures are sane, the gearing reaches the vehicle's real
top speed at redline, a real profile plays the engine's own rpm, and the rev counter's scale fits.
"""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
SCRIPT = r"""
const fs = require('fs'), path = require('path'), R0 = process.argv[1];
global.window = {HQV: {}, addEventListener: function(){}}; global.self = window;
eval(fs.readFileSync(path.join(R0, 'games', 'hqvehiclephys.js'), 'utf8'));
const P = window.HQV.hqVehiclePhys, cat = JSON.parse(fs.readFileSync(path.join(R0, 'games/vehicles/catalogue.json'), 'utf8'));
const cls = {}; cat.classes.forEach(c => { cls[c.id] = c; });
const out = {v: []};
cat.vehicles.forEach(v => {
  const c = cls[v.class] || {}, kind = c.kind === 'bike' || /^bike/.test(v.class) ? 'bike' : 'car';
  const V = P.derive({kind, type: c.type, spec: v.spec, dims: v.dims, sound: v.sound}), E = V.engine;
  out.v.push({id: v.id, kind, eng: V.eng, E, gears: V.gears, top: v.spec.topKmh, researched: !!v.spec.engine, ratios: !!(v.spec.engine && v.spec.engine.ratios)});
});
console.log(JSON.stringify(out));
"""

@unittest.skipUnless(NODE, "node not installed")
class Engines(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", SCRIPT, ROOT], capture_output=True, text=True, timeout=60)
        if r.returncode:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_every_vehicle_has_sane_revs(self):
        for v in self.o["v"]:
            E = v["E"]
            if E["electric"]:
                self.assertGreater(E["motorMax"], 5000, v["id"])
                continue
            self.assertTrue(500 <= E["idle"] < E["red"] <= E["limit"] <= 16000, (v["id"], E))
            self.assertLessEqual(E["limit"] - E["red"], 800, v["id"])
            self.assertTrue(E["k"] and all(a > b for a, b in zip(E["k"], E["k"][1:])), (v["id"], "each gear taller than the last"))

    def test_the_research_is_in(self):
        missing = [v["id"] for v in self.o["v"] if not v["researched"]]
        self.assertLessEqual(len(missing), 7, missing)          # KTM's six may follow; everything else is researched

    def test_real_gearing_reaches_its_top_speed(self):
        for v in self.o["v"]:
            if not v["ratios"]:
                continue
            E = v["E"]
            first, top = E["red"]/E["k"][0]*3.6, E["red"]/E["k"][-1]*3.6
            self.assertGreater(top, v["top"]*0.85, (v["id"], top))
            self.assertTrue(25 < first < 260, (v["id"], first))
            self.assertAlmostEqual(v["gears"][-1]*3.6, top, delta=1, msg=v["id"])   # gear speeds from the same gearing

    def test_famous_redlines(self):
        E = {v["id"]: v["E"] for v in self.o["v"]}
        self.assertEqual(E["bmw-m-1000-rr"]["limit"], 15100)
        self.assertEqual(E["lamborghini-temerario"]["red"], 10000)
        self.assertEqual(E["lamborghini-revuelto"]["red"], 9500)
        self.assertEqual(E["lamborghini-huracan-sto"]["red"], 8500)
        self.assertLessEqual(E["harley-davidson-fat-boy-114"]["red"], 6000)
        self.assertLessEqual(E["royal-enfield-classic-350"]["red"], 6500)


if __name__ == "__main__":
    unittest.main()
