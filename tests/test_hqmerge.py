"""Static mesh merging for the 3D city (games/hqmerge.js, HQV.hqMerge).

node imports the vendored three.js, loads hqmerge.js against a stub `window`, builds synthetic
groups and reports draw counts, kept meshes, baked vertex positions and material sharing; the
Python side checks them. One node process for the whole file. Skipped when node is not installed.
Stdlib only."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

HARNESS = r"""
var fs = require("fs"), url = require("url"), root = %(root)s;
import(url.pathToFileURL(root + "/games/vendor/three-module.js").href).then(function(THREE){
  global.window = {HQV: {}};
  new Function(fs.readFileSync(root + "/games/hqmerge.js", "utf8"))();
  var M = window.HQV.hqMerge, out = {};
  var box = new THREE.BoxGeometry(1, 1, 1);
  function std(c){ return new THREE.MeshStandardMaterial({color: c, roughness: 0.8, metalness: 0}); }

  // 1. draw count: 30 meshes in 3 colours (fresh material per mesh, same values) -> 3 draws
  var g = new THREE.Group(), i;
  for(i = 0; i < 30; i++){ var m = new THREE.Mesh(box, std([0xff0000, 0x00ff00, 0x0000ff][i %% 3])); m.position.set(i, 0, 0); g.add(m); }
  var r = M.mergeStatic(THREE, g);
  out.count = {before: r.before, after: r.after, children: g.children.length, same: r.group === g,
               merged: g.children.map(function(c){ return c.userData.merged | 0; })};

  // 2. keep() and userData flags respected
  var g2 = new THREE.Group(), door = new THREE.Mesh(box, std(0xffffff)), kept = new THREE.Mesh(box, std(0xffffff));
  door.userData.door = true; kept.name = "sign";
  var animParent = new THREE.Group(); animParent.userData.anim = true; animParent.add(new THREE.Mesh(box, std(0xffffff)));
  var glass = new THREE.Mesh(box, new THREE.MeshStandardMaterial({color: 0xffffff, transparent: true, opacity: 0.5}));
  g2.add(door, kept, animParent, glass);
  for(i = 0; i < 4; i++) g2.add(new THREE.Mesh(box, std(0xffffff)));
  var r2 = M.mergeStatic(THREE, g2, {keep: function(o){ return o.name === "sign"; }});
  out.keep = {before: r2.before, after: r2.after, doorIn: door.parent === g2, keptIn: kept.parent === g2,
              animKids: animParent.children.length, glassIn: glass.parent === g2,
              merged: g2.children.filter(function(c){ return c.userData.merged; }).map(function(c){ return c.userData.merged; })};

  // 3. transforms baked relative to the group (nested parent, rotation, scale; group itself moved)
  var g3 = new THREE.Group(); g3.position.set(100, 0, 100); g3.rotation.y = 0.3;
  var sub = new THREE.Group(); sub.position.set(2, 3, 4); sub.rotation.y = Math.PI / 2; g3.add(sub);
  var a = new THREE.Mesh(box, std(0x808080)); a.position.set(1, 0, 0); a.scale.set(2, 1, 1); sub.add(a);
  var b = new THREE.Mesh(box, std(0x808080)); b.position.set(-5, 1, 0); b.rotation.x = 0.7; g3.add(b);
  g3.updateMatrixWorld(true);
  function bbox(o){ return new THREE.Box3().setFromObject(o, true); }
  var want = bbox(a).union(bbox(b));
  var r3 = M.mergeStatic(THREE, g3); g3.updateMatrixWorld(true);
  var merged = g3.children.filter(function(c){ return c.userData.merged; })[0];
  var got = bbox(merged), nrm = merged.geometry.attributes.normal, maxLen = 0, minLen = 9;
  for(i = 0; i < nrm.count; i++){ var l = Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i)); maxLen = Math.max(maxLen, l); minLen = Math.min(minLen, l); }
  out.bake = {want: [want.min.toArray(), want.max.toArray()], got: [got.min.toArray(), got.max.toArray()],
              local: merged.position.toArray().concat(merged.rotation.toArray().slice(0, 3)), verts: merged.geometry.attributes.position.count,
              nmin: minLen, nmax: maxLen, after: r3.after, subKids: sub.children.length};

  // 4. materials shared by key
  var made = 0, mk = function(T){ made++; return new T.MeshLambertMaterial({color: 0x123456}); };
  var m1 = M.mat(THREE, "wall:navy", mk), m2 = M.mat(THREE, "wall:navy", mk), m3 = M.mat(THREE, "wall:red", mk);
  var g4 = new THREE.Group();
  g4.add(new THREE.Mesh(box, std(0x111111)), new THREE.Mesh(box, std(0x111111)),
         new THREE.Mesh(box, new THREE.MeshStandardMaterial({color: 0x111111, roughness: 0.2})),
         new THREE.Mesh(box, new THREE.MeshLambertMaterial({color: 0x111111})), new THREE.Mesh(box, new THREE.MeshLambertMaterial({color: 0x111111})));
  var r4 = M.mergeStatic(THREE, g4);
  out.mat = {made: made, same: m1 === m2, diff: m1 !== m3, after: r4.after,
             types: g4.children.map(function(c){ return c.material.type + ":" + (c.userData.merged | 0); }).sort()};
  process.stdout.write(JSON.stringify(out));
}).catch(function(e){ console.error(e && e.stack || e); process.exit(1); });
"""


@unittest.skipUnless(NODE, "node not installed")
class TestHqMerge(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        js = HARNESS % {"root": json.dumps(ROOT)}
        p = subprocess.run([NODE, "-e", js], capture_output=True, text=True, timeout=120)
        if p.returncode != 0:
            raise AssertionError("node harness failed:\n" + p.stderr)
        cls.r = json.loads(p.stdout)

    def test_draw_count_reduction(self):
        c = self.r["count"]
        self.assertEqual(c["before"], 30)
        self.assertEqual(c["after"], 3)
        self.assertEqual(c["children"], 3)
        self.assertEqual(sorted(c["merged"]), [10, 10, 10])
        self.assertTrue(c["same"])

    def test_keep_and_flags_respected(self):
        k = self.r["keep"]
        self.assertTrue(k["doorIn"])      # userData.door
        self.assertTrue(k["keptIn"])      # opts.keep
        self.assertEqual(k["animKids"], 1)  # child of an animated parent stays with it
        self.assertTrue(k["glassIn"])     # transparent
        self.assertEqual(k["merged"], [4])
        self.assertEqual(k["before"], 8)
        self.assertEqual(k["after"], 5)

    def test_transforms_baked(self):
        b = self.r["bake"]
        for side in range(2):
            for axis in range(3):
                self.assertAlmostEqual(b["got"][side][axis], b["want"][side][axis], places=4)
        self.assertEqual(b["local"], [0, 0, 0, 0, 0, 0])
        self.assertEqual(b["verts"], 48)
        self.assertAlmostEqual(b["nmin"], 1, places=4)
        self.assertAlmostEqual(b["nmax"], 1, places=4)
        self.assertEqual(b["after"], 1)
        self.assertEqual(b["subKids"], 0)

    def test_materials_shared_by_key(self):
        m = self.r["mat"]
        self.assertEqual(m["made"], 2)
        self.assertTrue(m["same"])
        self.assertTrue(m["diff"])
        # two std 0x111111 merge, the rough-0.2 one stays alone, the two Lambert merge
        self.assertEqual(m["after"], 3)
        self.assertEqual(m["types"], ["MeshLambertMaterial:2", "MeshStandardMaterial:0", "MeshStandardMaterial:2"])


if __name__ == "__main__":
    unittest.main()
