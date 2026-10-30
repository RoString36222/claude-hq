"""The v5 runway (backend/src/worldgen/v5/airport.rs RUNWAY_CM) is long enough for every HQ vehicle to run from a
standstill to its top speed with nitro on and brake to a stop, with the game's own physics (games/hqvehiclephys.js:
derive, nitroStep), every vehicle of games/vehicles/catalogue.json, run under node."""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
SCRIPT = r"""
const fs = require('fs'), path = require('path'), R0 = process.argv[1];
global.window = {HQV: {}};
new Function(fs.readFileSync(path.join(R0, 'games/hqvehiclephys.js'), 'utf8'))();
const PH = window.HQV.hqVehiclePhys, cat = JSON.parse(fs.readFileSync(path.join(R0, 'games/vehicles/catalogue.json'), 'utf8'));
const rows = [];
cat.vehicles.forEach(e => {
  if(!e.spec) return;
  let V; try { V = PH.derive(e); } catch(x){ return; }
  if(!V || !V.top) return;
  // flat out from a standstill, nitro held (as the driven car: its pull eases off toward its top, nitro adds 0.7 of it
  // and 25 % to the top), until it goes no faster for 20 s; then its brakes from there
  const dt = 1/120, N = {charge: 1}, log = [];
  let v = 0, d = 0, t = 0, vmax = 0, stall = 0;
  while(t < 300){
    const nit = PH.nitroStep(N, true, 1, v, dt), top = V.top*(nit ? 1.25 : 1);
    const pull = V.acc*Math.max(V.floor || 0.25, 1 - v/top) + (nit ? V.acc*0.7 : 0);
    let nv = Math.min(top, v + pull*dt); if(v > top) nv = Math.max(top, v - 6*dt);
    v = nv; d += v*dt; t += dt; log.push([v, d]);
    if(v > vmax + 1e-4){ vmax = v; stall = 0; } else if((stall += dt) > 20) break;
  }
  for(let i = 0; i < log.length; i++) if(log[i][0] >= vmax - 0.3){ d = log[i][1]; vmax = log[i][0]; break; }
  const b = V.brake || 14;
  rows.push({id: e.id, go: d, stop: vmax*vmax/(2*b), all: d + vmax*vmax/(2*b)});
});
console.log(JSON.stringify(rows));
"""


def runway_cm():
    with open(os.path.join(ROOT, "backend", "src", "worldgen", "v5", "airport.rs"), encoding="utf-8") as f:
        m = re.search(r"pub const RUNWAY_CM: i64 = ([0-9_]+);", f.read())
    return int(m.group(1).replace("_", "")) if m else None


@unittest.skipUnless(NODE, "node not installed")
class RunwayLength(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        out = subprocess.run([NODE, "-e", SCRIPT, ROOT], capture_output=True, text=True, timeout=300)
        if out.returncode != 0:
            raise AssertionError(out.stderr)
        cls.rows = json.loads(out.stdout)

    def test_every_vehicle_runs_up_and_stops_on_the_runway(self):
        cm = runway_cm()
        self.assertIsNotNone(cm, "RUNWAY_CM in v5/airport.rs")
        self.assertGreater(len(self.rows), 20, "the catalogue's vehicles")
        longest = max(self.rows, key=lambda r: r["all"])
        for r in self.rows:
            self.assertLessEqual(r["all"], cm / 100.0, f"{r['id']}: {r['all']:.0f} m to top speed and back to a stop")
        # and the runway is not much longer than the fastest needs (it is rounded up to the next 100 m)
        self.assertLess(cm / 100.0 - longest["all"], 100.0, f"{longest['id']} needs {longest['all']:.0f} m")


if __name__ == "__main__":
    unittest.main()
