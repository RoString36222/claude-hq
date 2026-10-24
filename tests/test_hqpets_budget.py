"""Pets: every build finishes, and quickly, whatever it is given (a guard for tools/ui_smoke.py's map run).

One node process loads the vendored three.js and games/hqpets.js and builds every species, variant and stage (the
wyvern and every dragon on the drake build included) with odd inputs as well (NaN, negative, huge and missing
variant, stage and accessories; a peer's half-filled pet), then poses each through every animation for many frames
with odd clocks (NaN, a step back in time, a long stall, a zero step). It must finish inside a wall-clock budget
(a loop that never ends trips the subprocess timeout), every pose stays finite, and the wyvern's membrane texture is
built once per page however many wyverns there are. Skipped when node is not installed. Stdlib only."""
import json
import os
import shutil
import subprocess
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

HARNESS = r"""
var fs = require("fs"), url = require("url"), root = process.argv[1];
import(url.pathToFileURL(root + "/games/vendor/three-module.js").href).then(function(THREE){
  global.window = {HQV: {}};
  ["world", "hqnav", "hqdealer", "hqcasino", "hqpets"].forEach(function(f){ new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))(); });
  var P = window.HQV.hqPets, out = {built: 0, posed: 0, bad: [], slow: [], tex: 0};
  var ANIMS = ["stand", "walk", "run", "carry", "sit", "look", "sleep", "sniff", "wag", "groom", "yawn", "shake", "stretch", "stomp", "roar", "breath", "puff",
               "wings", "fly", "swim", "float", "slither", "coil", "spin", "beg", "roll", "big", "nonsense"];
  var ODD = [{}, {variant: NaN, stage: NaN, acc: NaN}, {variant: -3, stage: -1, acc: -1}, {variant: 99, stage: 9, acc: 1e9}, {variant: "2", stage: "1", acc: "7"}];
  var CLOCK = [0, 0, 0.016, NaN, 0.5, -0.4, 30, 30, 1e6, 0.016];      // a zero step, NaN, back in time, a long stall, a huge t
  function finite(M){ var ok = true; M.g.updateMatrixWorld(true); M.g.traverse(function(o){
    if(!isFinite(o.matrixWorld.elements[12]) || !isFinite(o.matrixWorld.elements[13]) || !isFinite(o.matrixWorld.elements[14])) ok = false;
    if(o.isInstancedMesh){ var a = o.instanceMatrix.array; for(var i = 0; i < a.length; i++) if(!isFinite(a[i])){ ok = false; break; } } }); return ok; }
  P.SPECIES.forEach(function(sp){
    var t0 = Date.now();
    ODD.forEach(function(odd, oi){
      for(var v = 0; v < P.VARIANTS; v++) for(var g = 0; g < 3; g++){
        var o = Object.assign({species: sp.id, variant: v, stage: g, acc: sp.saddle ? 31 : 23, name: "Rex"}, oi ? odd : {});
        var M = P.model(THREE, o); out.built++;
        var st = P.newState(7 + v, 0, 0, 0), t = 1;
        ANIMS.forEach(function(a, ai){
          st.anim = a; st.speed = ai % 3 ? 2 : 5; st.trick = ai % 4 ? null : {t: 0.5, dur: 1.6}; st.wing = ai % 2 ? "flap" : "glide";
          for(var f = 0; f < 12; f++){ var c = CLOCK[f % CLOCK.length]; t = isFinite(c) ? (c > 10 ? t + c : t + c) : NaN; st.ph = (st.ph || 0) + 0.2; st.yaw = f*0.4;
            P.pose(M, st, isFinite(t) ? t : NaN, f % 5 === 0, f % 3 ? {x: 1, y: 0.4, z: 2} : null); out.posed++; }
          if(!isFinite(t)) t = 1;
        });
        if(!finite(M)) out.bad.push(sp.id + "/" + v + "/" + g + "/" + oi);
      }
    });
    var ms = Date.now() - t0; if(ms > 4000) out.slow.push([sp.id, ms]);
  });
  out.tex = P.wyTexCount ? P.wyTexCount() : -1;
  console.log(JSON.stringify(out));
}).catch(function(e){ console.error(e && e.stack || e); process.exit(1); });
"""


@unittest.skipUnless(NODE, "node not installed")
class PetsBudget(unittest.TestCase):
    def test_every_build_and_pose_finishes_fast_and_finite(self):
        t0 = time.time()
        r = subprocess.run([NODE, "-e", HARNESS, ROOT], capture_output=True, text=True, timeout=180)
        wall = time.time() - t0
        self.assertEqual(r.returncode, 0, r.stderr[-3000:])
        o = json.loads(r.stdout.strip().splitlines()[-1])
        self.assertGreater(o["built"], 22*4*3*5 - 1, "every species x variant x stage x odd input")
        self.assertGreater(o["posed"], 100000)
        self.assertEqual(o["bad"], [], "a pose went non-finite")
        self.assertEqual(o["slow"], [], "a species took over 4 s to build and pose (a loop that runs away?)")
        self.assertLess(wall, 120, "the whole roster built and posed in under two minutes")
        self.assertIn(o["tex"], (1, 2), "the wyvern's membrane texture is made once per page (one per look: standard, elder)")


if __name__ == "__main__":
    unittest.main()
