"""The route in 3D (games/hqroutefx.js, spec nav-river "Client: the route in 3D").

node loads hqroutefx.js against a stub `window` and the vendored three.js, builds the chevrons and
the pillar into a real THREE.Scene and runs the scenarios below in one process; the Python side
checks the numbers: the instance count follows the 250 m window, every chevron sits LIFT over the
road and points along it, the flow runs forward and fades near and far, the pillar follows the
waypoint, 30 Hz and 144 Hz give the same frame, at most 3 draw calls, and dispose leaves nothing in
the scene. Skipped when node is not installed. Stdlib only."""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

HARNESS = r"""
import fs from "fs";
const root = %(root)s;
const THREE = await import(root + "/games/vendor/three-module.js");
globalThis.window = {HQV: {}};
new Function(fs.readFileSync(root + "/games/hqroutefx.js", "utf8"))();
const R = window.HQV.hqroutefx, out = {consts: {SPACING: R.SPACING, LIFT: R.LIFT, AHEAD: R.AHEAD, FLOW: R.FLOW, MAX: R.MAX}};
const ctx = {THREE: THREE};
const slope = (x, z) => 2 + 0.05*x + 0.02*z;                 // a road that climbs
const m4 = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
function chevrons(fx, ground){
  var c = fx.chevrons, r = [], col = new THREE.Color();
  for(var i = 0; i < c.count; i++){
    c.getMatrixAt(i, m4); m4.decompose(p, q, s);
    var f = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    c.getColorAt(i, col);
    r.push({x: p.x, y: p.y, z: p.z, g: ground ? ground(p.x, p.z) : 0, fwd: [f.x, f.y, f.z], col: [col.r, col.g, col.b]});
  }
  return r;
}
function meshes(scene){ var n = 0; scene.traverse(o => { if(o.isMesh) n++; }); return n; }

// ---- a straight 1 km road along +x: the 250 m window ----
(function(){
  var scene = new THREE.Scene(), fx = R.create(ctx, scene), r = {};
  fx.setRoute(new Float64Array([0, 0, 500, 0, 1000, 0]), slope);
  r.before = fx.state().count;
  [[0, 0], [100, 3], [800, -2], [900, 0], [990, 0], [1200, 0]].forEach(function(pp){
    fx.update(0, {x: pp[0], z: pp[1]}, null);
    var st = fx.state(), cs = chevrons(fx, slope);
    r["at" + pp[0]] = {count: st.count, along: st.along, xs: cs.map(c => c.x), visible: fx.chevrons.visible};
  });
  fx.update(0, {x: 100, z: 3}, null);
  r.cs = chevrons(fx, slope);
  r.brand = new THREE.Color("#7c6cf0").toArray();
  r.meshes = meshes(scene);
  fx.setRoute(null); fx.update(0.1, {x: 100, z: 0}, null);
  r.cleared = [fx.state().count, fx.chevrons.visible];
  fx.setRoute(new Float64Array([5, 5]), slope); fx.update(0.1, {x: 5, z: 5}, null);
  r.onePoint = fx.state().count;
  out.straight = r;
})();

// ---- an L: east 100 m, then north 300 m; chevrons turn the corner ----
(function(){
  var scene = new THREE.Scene(), fx = R.create(ctx, scene);
  fx.setRoute(new Float64Array([0, 0, 100, 0, 100, 300]), slope);
  fx.update(0, {x: 0, z: 0}, null);
  out.ell = chevrons(fx, slope);
  fx.dispose();
})();

// ---- a U-turn: east 200 m, back west on a street 10 m away; drifting sideways keeps your leg ----
(function(){
  var scene = new THREE.Scene(), fx = R.create(ctx, scene), r = {};
  fx.setRoute(new Float64Array([0, 0, 200, 0, 200, 10, 0, 10]), slope);
  fx.update(0, {x: 20, z: 0}, null); r.start = fx.state().along;
  fx.update(0, {x: 20, z: 5.1}, null); r.drift = fx.state(); r.driftCs = chevrons(fx, slope);
  fx.update(0, {x: 20, z: 1}, null); r.back = fx.state().along;
  fx.update(0, {x: 18, z: 1}, null); r.reverse = fx.state().along;
  fx.update(0, {x: 120, z: 9}, null); r.lost = fx.state().along;       // a teleport onto the return leg
  fx.setRoute(new Float64Array([0, 0, 200, 0, 200, 10, 0, 10]), slope);
  fx.update(0, {x: 20, z: 9}, null); r.fresh = fx.state().along;       // a new route searches it all
  fx.dispose();
  out.uturn = r;
})();

// ---- a repeated last point (a 0 m end leg): the last chevron still points along the road ----
(function(){
  var scene = new THREE.Scene(), fx = R.create(ctx, scene);
  fx.setRoute(new Float64Array([0, 0, 100, 0, 100, 0]), slope);
  fx.update(0, {x: 96, z: 0}, null);
  out.dup = chevrons(fx, slope);
  fx.dispose();
})();

// ---- the flow: forward, and the same at 30 Hz and 144 Hz ----
(function(){
  var r = {};
  function run(hz, secs){
    var scene = new THREE.Scene(), fx = R.create(ctx, scene);
    fx.setRoute(new Float64Array([0, 0, 1000, 0]), slope);
    var n = Math.round(secs*hz);
    for(var i = 0; i < n; i++) fx.update(1/hz, {x: 50, z: 0}, null);
    var o = {state: fx.state(), cs: chevrons(fx, slope)}; fx.dispose(); return o;
  }
  r.a = run(30, 1.5); r.b = run(144, 1.5);
  var scene = new THREE.Scene(), fx = R.create(ctx, scene);
  fx.setRoute(new Float64Array([0, 0, 1000, 0]), slope);
  fx.update(0, {x: 50, z: 0}, null); var c0 = chevrons(fx, slope);
  fx.update(0.2, {x: 50, z: 0}, null); var c1 = chevrons(fx, slope);
  r.shift = [c0[2].x, c1[2].x];
  fx.dispose();
  out.flow = r;
})();

// ---- the pillar ----
(function(){
  var scene = new THREE.Scene(), fx = R.create(ctx, scene), r = {};
  r.hidden = fx.pillar.visible;
  fx.setWaypoint({x: 10, y: 3, z: -5}); r.first = fx.pillar.position.toArray(); r.shown = fx.pillar.visible;
  fx.setWaypoint({x: -400, y: 1.5, z: 820}); r.moved = fx.pillar.position.toArray();
  fx.update(1/60, {x: 0, z: 0}, {position: {x: -390, y: 20, z: 820}}); r.nearScale = fx.pillar.scale.x;
  fx.update(1/60, {x: 0, z: 0}, new THREE.Vector3(1600, 30, 820)); r.farScale = fx.pillar.scale.x;
  r.fog = fx.pillar.material.fog; r.pillarTop = (fx.pillar.geometry.computeBoundingBox(), fx.pillar.geometry.boundingBox.max.y);
  r.meshes = meshes(scene);
  fx.setWaypoint(null); r.cleared = fx.pillar.visible;
  out.pillar = r;
})();

// ---- materials, dispose ----
(function(){
  var scene = new THREE.Scene(), fx = R.create({THREE: THREE, brand: 0xff2200}, scene), r = {}, freed = [];
  fx.setRoute(new Float64Array([0, 0, 300, 0]), slope); fx.setWaypoint({x: 300, y: 2, z: 0});
  fx.update(1/60, {x: 0, z: 0}, {x: 0, y: 5, z: 0});
  var cm = fx.chevrons.material, pm = fx.pillar.material;
  r.chev = {basic: cm.isMeshBasicMaterial, additive: cm.blending === THREE.AdditiveBlending, depthTest: cm.depthTest,
            depthWrite: cm.depthWrite, instanced: fx.chevrons.isInstancedMesh, max: fx.chevrons.instanceMatrix.count};
  r.pill = {basic: pm.isMeshBasicMaterial, additive: pm.blending === THREE.AdditiveBlending};
  r.brandMid = chevrons(fx, slope)[20].col; r.brandRef = new THREE.Color(0xff2200).toArray();
  [fx.chevrons.geometry, cm, fx.pillar.geometry, pm].forEach(function(o, i){ o.addEventListener("dispose", () => freed.push(i)); });
  var inst = 0; fx.chevrons.addEventListener("dispose", () => inst++);
  r.childrenBefore = scene.children.length;
  fx.dispose();
  r.childrenAfter = scene.children.length; r.freed = freed.sort(); r.inst = inst;
  var left = 0; scene.traverse(o => { if(o !== scene) left++; }); r.left = left;
  fx.update(1/60, {x: 0, z: 0}, null); fx.dispose(); r.after = scene.children.length;
  out.dispose = r;
})();
process.stdout.write(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
class RouteFxTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "--input-type=module", "-e", HARNESS % {"root": json.dumps(ROOT)}],
                           capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            raise AssertionError("node failed:\n" + r.stderr[-4000:])
        cls.out = json.loads(r.stdout)
        cls.k = cls.out["consts"]

    def test_constants(self):
        self.assertEqual((self.k["SPACING"], self.k["LIFT"], self.k["AHEAD"]), (4, 0.06, 250))
        self.assertGreaterEqual(self.k["MAX"], 250 // 4 + 1)

    def test_the_window_follows_you(self):
        st, sp, ahead = self.out["straight"], self.k["SPACING"], self.k["AHEAD"]
        self.assertEqual(st["before"], 0, "nothing before the first update")
        for x, (lo, hi) in {0: (0, 250), 100: (100, 350), 800: (800, 1000), 900: (900, 1000), 990: (990, 1000)}.items():
            a = st["at%d" % x]
            self.assertAlmostEqual(a["along"], x, places=6)
            want = len([s for s in range(0, 1001, sp) if lo <= s <= hi])   # phase 0: chevrons on multiples of 4
            self.assertEqual(a["count"], want, "at %d m" % x)
            self.assertTrue(all(lo - 1e-6 <= v <= hi + 1e-6 for v in a["xs"]), "within %d m ahead" % ahead)
            self.assertTrue(a["visible"])
        self.assertEqual(st["at0"]["count"], 63)
        self.assertLessEqual(st["at1200"]["count"], 1, "past the end of the route")
        self.assertEqual(st["cleared"], [0, False])
        self.assertEqual(st["onePoint"], 0, "a route of one point draws nothing")

    def test_on_the_road_pointing_along_it(self):
        lift = self.k["LIFT"]
        for c in self.out["straight"]["cs"]:
            self.assertAlmostEqual(c["y"], c["g"] + lift, places=5)
            self.assertAlmostEqual(c["z"], 0, places=6, msg="on the route, not where the player is")
            self.assertGreater(c["fwd"][0], 0.99)
            self.assertAlmostEqual(c["fwd"][2], 0, places=6)
            self.assertAlmostEqual(c["fwd"][1] / c["fwd"][0], 0.05, places=3, msg="tilted with the road")
        ell = self.out["ell"]
        self.assertEqual(len(ell), 63)
        for c in ell:
            self.assertAlmostEqual(c["y"], c["g"] + lift, places=5)
            if c["x"] < 99.9:
                self.assertAlmostEqual(c["z"], 0, places=6)
                self.assertGreater(c["fwd"][0], 0.99)
            else:
                self.assertAlmostEqual(c["x"], 100, places=6)
                self.assertGreater(c["fwd"][2], 0.99, "round the corner, pointing north")
        self.assertTrue(any(c["z"] > 100 for c in ell))

    def test_a_u_turn_keeps_your_leg(self):
        u = self.out["uturn"]
        self.assertAlmostEqual(u["start"], 20, places=6)
        self.assertAlmostEqual(u["drift"]["along"], 20, places=6, msg="5.1 m off, still on the leg you are on")
        self.assertEqual(u["drift"]["count"], 63, "the full window, not the last 10 m")
        self.assertTrue(any(abs(c["z"]) < 1e-6 and c["fwd"][0] > 0.99 for c in u["driftCs"]))
        self.assertAlmostEqual(u["back"], 20, places=6)
        self.assertAlmostEqual(u["reverse"], 18, places=6, msg="a little backwards is followed")
        self.assertAlmostEqual(u["lost"], 210 + 80, places=6, msg="far off the tracked stretch: searched again")
        self.assertAlmostEqual(u["fresh"], 210 + 180, places=6, msg="setRoute forgets the old fix")

    def test_a_repeated_end_point_still_points_along(self):
        dup = self.out["dup"]
        self.assertTrue(any(abs(c["x"] - 100) < 1e-6 for c in dup), "a chevron lands on the end")
        for c in dup:
            self.assertGreater(c["fwd"][0], 0.99, "east, like the road, never +z")

    def test_fades_near_and_far(self):
        cs, brand = self.out["straight"]["cs"], self.out["straight"]["brand"]
        lum = [sum(c["col"]) for c in cs]
        self.assertLess(lum[0], 0.05 * sum(brand), "the one at your feet has faded out")
        self.assertLess(lum[-1], 0.1 * sum(brand), "the farthest is still fading in")
        mid = cs[len(cs) // 2]["col"]
        for a, b in zip(mid, brand):
            self.assertAlmostEqual(a, b, places=5, msg="the middle glows in the brand colour")
        self.assertEqual(lum.index(max(lum)) not in (0, len(lum) - 1), True)

    def test_flows_forward_frame_rate_independent(self):
        f = self.out["flow"]
        self.assertAlmostEqual(f["a"]["state"]["phase"], f["b"]["state"]["phase"], places=9)
        self.assertAlmostEqual(f["a"]["state"]["phase"], (1.5 * self.k["FLOW"]) % self.k["SPACING"], places=9)
        self.assertEqual(len(f["a"]["cs"]), len(f["b"]["cs"]))
        for a, b in zip(f["a"]["cs"], f["b"]["cs"]):
            for k in ("x", "y", "z"):
                self.assertAlmostEqual(a[k], b[k], places=6)
            for u, v in zip(a["col"], b["col"]):
                self.assertAlmostEqual(u, v, places=6)
        x0, x1 = f["shift"]
        self.assertAlmostEqual(x1 - x0, 0.2 * self.k["FLOW"], places=4, msg="forward, at FLOW m/s")

    def test_the_pillar(self):
        p = self.out["pillar"]
        self.assertFalse(p["hidden"])
        self.assertTrue(p["shown"])
        self.assertEqual(p["first"], [10, 3, -5])
        self.assertEqual(p["moved"], [-400, 1.5, 820])
        self.assertEqual(p["nearScale"], 1)
        self.assertGreater(p["farScale"], 5, "wider from across the city, so it still reads")
        self.assertFalse(p["fog"], "seen from afar through the fog")
        self.assertGreaterEqual(p["pillarTop"], 100)
        self.assertFalse(p["cleared"])

    def test_draw_calls_and_materials(self):
        self.assertLessEqual(self.out["straight"]["meshes"], 3)
        self.assertLessEqual(self.out["pillar"]["meshes"], 3)
        d = self.out["dispose"]
        self.assertEqual(d["chev"], {"basic": True, "additive": True, "depthTest": True, "depthWrite": False,
                                     "instanced": True, "max": self.k["MAX"]})
        self.assertEqual(d["pill"], {"basic": True, "additive": True})
        for a, b in zip(d["brandMid"], d["brandRef"]):
            self.assertAlmostEqual(a, b, places=5, msg="the ctx's brand colour wins")

    def test_dispose_leaves_nothing(self):
        d = self.out["dispose"]
        self.assertEqual(d["childrenBefore"], 2)
        self.assertEqual(d["childrenAfter"], 0)
        self.assertEqual(d["left"], 0)
        self.assertEqual(d["freed"], [0, 1, 2, 3], "both geometries and both materials")
        self.assertEqual(d["inst"], 1, "the InstancedMesh's own buffers")
        self.assertEqual(d["after"], 0, "update and dispose again after dispose are no-ops")

    def test_source_rules(self):
        with open(os.path.join(ROOT, "games", "hqroutefx.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIsNone(re.search(r"Math\.min\(\s*1\s*,[^)]*dt", src), "use ease(k, dt), never Math.min(1, dt*k)")
        for bad in ("innerHTML", "outerHTML", "insertAdjacentHTML", "fetch(", "XMLHttpRequest", "WebSocket"):
            self.assertNotIn(bad, src)


if __name__ == "__main__":
    unittest.main()
