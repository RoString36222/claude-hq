"""The dragon revamp (games/hqpets.js drSweep / drSweepPose / drMat / Fx / sfx, games/strike.js dragonInterp).

One node process loads the vendored three.js and games/hqpets.js against a stub `window` and checks: each dragon's
body is one swept tube (the neck, chest, hips and tail together) carrying the hide's surface coordinates, its faces
point outward (a tube built inside out shades dark from every side), it stays finite through every pose, its far
version is lighter; the breath pool drops new particles when full instead of cutting live ones short, thins its rate
for big puffs, and lights the scene; the dragons' sound is silent without the engine's output. Then Strike's dragon
drawing by reading the file: one pose a frame, the remote mounts drawn from a snapshot buffer. Skipped when node is
not installed. Stdlib only."""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

HARNESS = r"""
var fs = require("fs"), url = require("url"), root = process.argv[1];
import(url.pathToFileURL(root + "/games/vendor/three-module.js").href).then(function(THREE){
  global.window = {HQV: {}};
  ["world", "hqnav", "hqdealer", "hqcasino", "hqpets"].forEach(function(f){ new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))(); });
  var P = window.HQV.hqPets, out = {dragons: {}};
  var ANIMS = ["stand", "walk", "run", "sit", "sleep", "roar", "breath", "wings", "fly", "big", "roll"];
  ["firedragon", "icedragon", "stormdragon", "crystaldragon", "shadowdragon", "golddragon"].forEach(function(id){
    var M = P.model(THREE, {species: id, variant: 0, acc: 31, stage: 2}), st = P.newState(3, 0, 0, 0), g = M.parts.body.geometry, finite = true, outward = 0, tri = 0;
    ANIMS.forEach(function(a, k){ st.anim = a; st.ph = 1.3; st.wing = a === "fly" ? "climb" : null; st.trick = {t: 0.5, dur: 1.6}; for(var i = 0; i < 4; i++) P.pose(M, st, 2 + k + i/30, false); });
    st.anim = "fly"; st.wing = "glide"; P.pose(M, st, 30, false);
    var p = g.attributes.position.array, n = g.attributes.normal.array, ix = g.index.array;
    for(var i = 0; i < p.length; i++) if(!isFinite(p[i]) || !isFinite(n[i])) finite = false;
    for(var t = 0; t < ix.length; t += 3){
      var a = ix[t]*3, b = ix[t + 1]*3, c = ix[t + 2]*3;
      var ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2], vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      var fx = uy*vz - uz*vy, fy = uz*vx - ux*vz, fz = ux*vy - uy*vx, fl = Math.hypot(fx, fy, fz); if(fl < 1e-12) continue;
      tri++; if(fx*(n[a] + n[b] + n[c]) + fy*(n[a + 1] + n[b + 1] + n[c + 1]) + fz*(n[a + 2] + n[b + 2] + n[c + 2]) > 0) outward++;
    }
    var near = M.tris, lodT = 0; M.lod = true; P.pose(M, st, 31, false);
    [M.limbs, M.bits].forEach(function(im){ var gg = im.geometry; lodT += im.count*(gg.index ? gg.index.count : gg.attributes.position.count)/3; });
    var nearT = 0; M.lod = false; for(var q = 0; q < 4; q++) P.pose(M, st, 32 + q, false);
    [M.limbs, M.bits].forEach(function(im){ var gg = im.geometry; nearT += im.count*(gg.index ? gg.index.count : gg.attributes.position.count)/3; });
    out.dragons[id] = {inPg: M.parts.body.parent === M.P, rings: M.sw ? M.sw.R : 0, uv: !!g.attributes.uv, rest: !!g.attributes.drRp && !!g.attributes.drRn,
                       finite: finite, outward: tri ? outward/tri : 0, meshes: M.meshes, tris: near, lodLimbs: lodT, nearLimbs: nearT,
                       mat: M.parts.body.material.type, wing: M.wingMesh.material.alphaToCoverage === true};
  });
  // the breath pool: full means new particles are dropped, never a live one recycled
  var F = P.Fx(THREE, null), i;
  for(i = 0; i < 60; i++) F.emit("fire", 0, 1, 0, 64, 1, 0, 20, 2, 5, 0);
  F.step(0.01);
  out.fx = {cap: F.cap, used: F.used, dropped: F.dropped, light: !!F.light, instanced: !!(F.pts.geometry && F.pts.geometry.isInstancedBufferGeometry)};
  var G = P.Fx(THREE, null); G.pts.material.size = 0.95;
  for(i = 0; i < 10; i++) G.emit("fire", 0, 1, 0, 26, 1, 0, 22, 3, 1, 0);
  G.step(0.01); out.fx.bigUsed = G.used;
  out.fx.lit = (function(){ var H = P.Fx(THREE, null); H.emit("fire", 0, 1, 0, 12, 1, 0, 20, 2, 1, 0); H.step(0.016); return H.light.intensity > 0; })();
  out.fx.bad = (function(){ var H = P.Fx(THREE, null); H.emit("fire", NaN, 1, 0, 12, 1, 0, 20, 2, 1, 0); H.step(NaN); return H.used; })();
  out.sfx = [typeof P.sfx, P.sfx("roar", {vol: 1}), P.sfx("nope")];
  process.stdout.write(JSON.stringify(out));
}).catch(function(e){ process.stdout.write(JSON.stringify({error: String(e && e.stack || e)})); });
"""


@unittest.skipUnless(NODE, "node not installed")
class DragonRevamp(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", HARNESS, ROOT], capture_output=True, text=True, timeout=240)
        cls.o = json.loads(r.stdout or "{}")
        if "error" in cls.o or not cls.o:
            raise AssertionError((cls.o.get("error") if cls.o else "") or r.stderr[-2000:])

    def test_body_is_one_swept_tube_facing_out(self):
        for sid, d in self.o["dragons"].items():
            self.assertTrue(d["inPg"], sid)
            self.assertGreaterEqual(d["rings"], 40, sid)
            self.assertTrue(d["uv"] and d["rest"], "the hide's surface coordinates ride on the tube: " + sid)
            self.assertTrue(d["finite"], sid)
            self.assertGreater(d["outward"], 0.97, "its faces wind outward (inside out it shades dark): " + sid)
            self.assertEqual(d["mat"], "MeshStandardMaterial", sid)
            self.assertLessEqual(d["meshes"], 6, sid)
            self.assertLessEqual(d["tris"], 14000, sid)
            self.assertTrue(d["wing"], "soft membrane edges (alpha to coverage): " + sid)

    def test_far_dragons_are_lighter(self):
        for sid, d in self.o["dragons"].items():
            self.assertLess(d["lodLimbs"], d["nearLimbs"]*0.6, sid)

    def test_breath_pool_never_cuts_a_live_jet_short(self):
        fx = self.o["fx"]
        self.assertGreaterEqual(fx["cap"], 2048)
        self.assertTrue(fx["instanced"], "one instanced draw call")
        self.assertEqual(fx["used"], fx["cap"], "full")
        self.assertEqual(fx["dropped"], 60*64 - fx["cap"], "the overflow dropped, the live ones kept")
        self.assertLess(fx["bigUsed"], 120, "metre-scale puffs are thinned (a battle jet is not a white wall)")
        self.assertGreater(fx["bigUsed"], 20)
        self.assertTrue(fx["light"] and fx["lit"], "the breath lights the scene")
        self.assertEqual(fx["bad"], 0, "NaN never enters the pool")

    def test_sound_is_silent_without_the_engine(self):
        self.assertEqual(self.o["sfx"], ["function", False, False])


class StrikeDragonDrawing(unittest.TestCase):
    def setUp(self):
        with open(os.path.join(ROOT, "games", "strike.js"), encoding="utf-8") as f:
            self.js = f.read()

    def test_one_pose_a_frame(self):
        tick = self.js[self.js.index("function dragonTick(dt, t){"):self.js.index("function wardenBoxes(")]
        self.assertEqual(len(re.findall(r"R3\.moveDragons\(V\.dragons\)", tick)), 1, "two poses a frame read zero speed")
        snap = self.js[self.js.index("if(Array.isArray(m.drg)){"):self.js.index("function onError(m){")]
        self.assertNotIn("moveDragons(V.dragons)", snap.split("} else if(V.dragons && V.dragons.length")[0])

    def test_remote_mounts_are_interpolated(self):
        self.assertIn("function dragonSnapPush(D, t)", self.js)
        self.assertIn("function dragonInterp(t)", self.js)
        self.assertRegex(self.js, r"if\(!D\.riderIsMe\) dragonSnapPush\(D, t\)")
        self.assertRegex(self.js, r"D\.yaw = a\.yaw \+ wrapPi\(c\.yaw - a\.yaw\)\*f")

    def test_breath_sound_gated(self):
        self.assertRegex(self.js, r"Ps\.sfx\(\"roar\"")
        body = self.js[self.js.index("function dragonBreathFx(D, at, dts, quiet){"):]
        self.assertLess(body.index("if(!F || quiet) return;"), body.index("Ps.sfx("), "no sound under Calm")


if __name__ == "__main__":
    unittest.main()
