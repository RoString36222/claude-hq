"""HQ 3.40.1 (games/worldbuild.js): the City opens once the tiles round the spawn are built, and a pool of workers builds.

One node process loads the vendored three.js, world.js, citylife.js, worldgeom.js and worldbuild.js, stands in a Worker
that speaks games/worldbuild-worker.js's protocol (buildTile a tick later), and creates the world from the fixtures:
the v2 Commons (8 x 8 tiles) and the v5 Commons (16 x 16). With wb.focus(spawn), wb.ready resolves while most tiles
still owe their first build, and only once every tile within READY_NEAR of the spawn has one; without it, only after
every tile (as before). Either way every tile is built in the end, the world-wide instanced props (parked cars, signs,
gantries, furniture) come out the same, and the tiles are spread over the workers (cores - 1, at most 4).
Skipped when node is not installed. Stdlib only."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

HARNESS = r"""
var fs = require("fs"), zlib = require("zlib"), url = require("url"), root = process.argv[1];
import(url.pathToFileURL(root + "/games/vendor/three-module.js").href).then(function(T){
  global.window = {HQV: {}, navigator: {hardwareConcurrency: +process.argv[4]}};
  ["world", "citylife", "worldgeom", "worldbuild"].forEach(function(f){ new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))(); });
  var H = window.HQV.world, G = window.HQV.worldgeom, B = window.HQV.worldbuild, made = 0, busy = {};
  window.Worker = function(){
    var me = this, W = null, id = made++;
    me.terminate = function(){};
    me.postMessage = function(m){ setTimeout(function(){
      if(m.op === "init"){ W = m.W; me.onmessage({data: {op: "ready"}}); return; }
      busy[id] = (busy[id] || 0) + 1; me.onmessage({data: G.buildTile(W, m)});
    }, 0); };
  };
  var W = H.pack(JSON.parse(zlib.gunzipSync(fs.readFileSync(process.argv[2])))), focus = process.argv[3] === "focus";
  var wb = B.create({THREE: T}, W, {quality: 2}), out = {NT: 0};
  if(focus) wb.focus(300, -200);
  wb.ready.then(function(){
    var s = wb.stats();
    out.atReady = s.unbuilt; out.workers = s.workers;
    out.NT = G.NT;
    // every tile within READY_NEAR (400 m) of the spawn is built by now
    var near = 0;
    for(var tx = 0; tx < G.NT; tx++) for(var tz = 0; tz < G.NT; tz++){
      var x0 = G.ORIGIN + tx*G.TILE, z0 = G.ORIGIN + tz*G.TILE;
      var dx = Math.max(x0 - 300, 0, 300 - (x0 + G.TILE)), dz = Math.max(z0 + 200, 0, -200 - (z0 + G.TILE));
      if(Math.sqrt(dx*dx + dz*dz) < B.LIMITS.ready) near++;
    }
    out.near = near;
    (function wait(){
      var s2 = wb.stats();
      if(s2.unbuilt > 0 || s2.pending > 0) return setTimeout(wait, 2);
      out.left = s2.unbuilt; out.used = Object.keys(busy).length;
      out.ww = wb.root.children.filter(function(o){ return o.isInstancedMesh; }).map(function(o){ return o.instanceMatrix.count; })
        .sort(function(a, b){ return a - b; });
      wb.destroy();
      process.stdout.write(JSON.stringify(out));
    })();
  }, function(e){ process.stderr.write("rejected: " + e); process.exit(1); });
});
"""


def run(fixture, mode, cores=8):
    p = subprocess.run([NODE, "-e", HARNESS, ROOT, os.path.join(ROOT, "tests", "fixtures", fixture), mode, str(cores)],
                       capture_output=True, text=True, timeout=600)
    if p.returncode != 0:
        raise AssertionError("node failed:\n" + p.stderr[-4000:])
    return json.loads(p.stdout)


@unittest.skipUnless(NODE, "node is not installed")
class FastOpen(unittest.TestCase):
    def check(self, fixture, nt):
        f, a = run(fixture, "focus"), run(fixture, "all")
        self.assertEqual((f["NT"], a["NT"]), (nt, nt))
        # with a focus the City opens early: most tiles still to come, all of those near the spawn in
        self.assertGreater(f["atReady"], nt*nt//2, f)
        self.assertLessEqual(f["atReady"], nt*nt - f["near"], f)
        self.assertEqual(a["atReady"], 0, "without a focus it waits for every tile, as before")
        for o in (f, a):
            self.assertEqual(o["left"], 0, "every tile gets its first build")
            self.assertEqual((o["workers"], o["used"]), (4, 4), "cores - 1 workers, at most 4, all of them used")
        self.assertEqual(f["ww"], a["ww"], "the world-wide props are rebuilt with the late tiles' in")

    def test_v2_commons(self):
        self.check("claude-hq@2.json.gz", 8)

    def test_v5_commons(self):
        self.check("commons_v5.json.gz", 16)

    def test_worker_count_follows_the_cores(self):
        for cores, n in ((1, 1), (2, 1), (3, 2), (16, 4)):
            self.assertEqual(run("claude-hq@2.json.gz", "focus", cores)["workers"], n, cores)


class Wiring(unittest.TestCase):
    def test_the_city_focuses_on_its_spawn(self):
        with open(os.path.join(ROOT, "games", "hqcity3d.js"), encoding="utf-8") as fh:
            js = fh.read()
        i = js.index("wb = HQV.worldbuild.create(")
        self.assertIn("wb.focus(w.spawn.x, w.spawn.z)", js[i:i + 4000])


if __name__ == "__main__":
    unittest.main()
