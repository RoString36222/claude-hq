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
    function drawn(){ var n = 0; M.g.traverse(function(o){ if(!o.isMesh) return; var gg = o.geometry, c = (gg.index ? gg.index.count : gg.attributes.position.count)/3; n += o.isInstancedMesh ? c*o.count : c; }); return n; }
    var nearDrawn = drawn(), tag = g.attributes.drTag ? Array.prototype.filter.call(g.attributes.drTag.array, function(x){ return x > 0.5; }).length : 0;
    // the jaw: a sculpted mandible on its own pivot, opened by turning it
    st.anim = "roar"; for(var rq = 0; rq < 40; rq++) P.pose(M, st, 40 + rq/30, false);
    var jawOk = !!(M.parts.jaw && M.jaw.g && M.parts.jaw.parent === M.jaw.g), jawOpen = M.jaw.g.rotation.x;
    // wingbeats counted (the whoosh is played by whoever draws it)
    st.anim = "fly"; st.wing = "climb"; st.y = 3; st.agl = 3; var b0 = M.beats | 0; for(var fq = 0; fq < 90; fq++) P.pose(M, st, 50 + fq/30, false); var beats = (M.beats | 0) - b0;
    st.anim = "fly"; st.wing = "glide";
    var near = M.tris, lodT = 0; M.lod = true; P.pose(M, st, 31, false); var farDrawn = drawn();
    [M.limbs, M.bits].forEach(function(im){ var gg = im.geometry; lodT += im.count*(gg.index ? gg.index.count : gg.attributes.position.count)/3; });
    var nearT = 0; M.lod = false; for(var q = 0; q < 4; q++) P.pose(M, st, 32 + q, false);
    [M.limbs, M.bits].forEach(function(im){ var gg = im.geometry; nearT += im.count*(gg.index ? gg.index.count : gg.attributes.position.count)/3; });
    out.dragons[id] = {inPg: M.parts.body.parent === M.P, rings: M.sw ? M.sw.R : 0, uv: !!g.attributes.uv, rest: !!g.attributes.drRp && !!g.attributes.drRn,
                       finite: finite, outward: tri ? outward/tri : 0, meshes: M.meshes, tris: near, lodLimbs: lodT, nearLimbs: nearT,
                       mat: M.parts.body.material.type, wing: M.wingMesh.material.alphaToCoverage === true || (M.wingMesh.material.transparent === true && M.wingMesh.material.depthWrite === false),
                       nearDrawn: nearDrawn, farDrawn: farDrawn, crestVerts: tag, jaw: jawOk, jawOpen: jawOpen, beats: beats};
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
  // the jet's core: lit while it is called each frame, gone soon after; the heat haze only round the hot kinds
  out.jet = (function(){ var H = P.Fx(THREE, null), r = {};
    H.jet("a", "fire", 0, 1, 0, 1, 0, 0); H.step(1/60); r.on = H.jets[0].mesh.visible; r.haze = !!(H.jets[0].haze && H.jets[0].haze.visible); r.len = +H.jets[0].mesh.scale.z.toFixed(2);
    H.jet("b", "ice", 0, 1, 0, 0, 0, 1); H.step(1/60); r.two = H.jets[1].mesh.visible; r.coldHaze = !!(H.jets[1].haze && H.jets[1].haze.visible);
    for(var q = 0; q < 40; q++) H.step(1/60); r.off = !H.jets[0].mesh.visible && !H.jets[1].mesh.visible;
    H.jet("c", "fire", NaN, 1, 0, 1, 0, 0); H.step(1/60); r.nan = H.jets.some(function(J){ return J.mesh.visible; });
    return r; })();
  // [verify round 2] the closed mouth: every tooth hanging under the upper lip is seated inside the lower jaw's rim (no
  // row dangling outside the chin); far off the face keeps its eyes and teeth; breathing on the wing keeps the wings
  // open (the jaw opens, the wings keep working); the ice skin is a cold blue and see-through
  out.round2 = (function(){ var r = {};
    var M = P.model(THREE, {species: "firedragon", variant: 0, acc: 0, stage: 2}), st = P.newState(3, 0, 0, 0), hr = M.wy.d.hr;
    st.anim = "stand"; for(var q = 0; q < 5; q++) P.pose(M, st, 1 + q/30, false);
    var hg = M.parts.head.geometry, hp = hg.attributes.position.array, ht = hg.attributes.drTag.array, worst = 0, n = 0;
    for(var i = 0; i < ht.length; i++) if(Math.round(ht[i]) === 1 && hp[i*3 + 1] < -hr*0.07 && hp[i*3 + 2] > hr*0.2 && hp[i*3 + 2] < hr*2.1){ n++; worst = Math.max(worst, Math.abs(hp[i*3])/hr); }
    r.upperTeeth = n; r.teethHalfWidth = +worst.toFixed(3);                       // in head radii: the jaw's rim is 0.33 at its widest
    var lo = 0; M.lod = true; P.pose(M, st, 2, false); var lg = M.parts.head.geometry; if(lg.attributes.drTag) Array.prototype.forEach.call(lg.attributes.drTag.array, function(x){ if(Math.round(x) === 2) lo++; });
    r.farEye = lo; M.lod = false; P.pose(M, st, 3, false);
    function span(){ var a = M.wingMesh.geometry.attributes.position.array, mx = 0; for(var k = 0; k < a.length; k += 3) mx = Math.max(mx, Math.abs(a[k])); return mx; }
    st.anim = "fly"; st.wing = "glide"; st.y = 4; st.agl = 4; st.breath = false; for(q = 0; q < 30; q++) P.pose(M, st, 10 + q/30, false); r.glide = span();
    st.breath = true; for(q = 0; q < 30; q++) P.pose(M, st, 11 + q/30, false); r.glideBreath = span(); r.jawBreath = M.jaw.g.rotation.x;
    st.breath = false; st.anim = "breath"; for(q = 0; q < 30; q++) P.pose(M, st, 12 + q/30, false); r.groundBreath = span();
    var I = P.model(THREE, {species: "icedragon", variant: 0, acc: 0, stage: 2}), c = I.wingMesh.geometry.attributes.color.array, sr = 0, sb = 0;
    for(q = 0; q < c.length; q += 3){ sr += c[q]; sb += c[q + 2]; }
    r.iceBlue = sb > sr*1.08; r.iceGlass = I.wingMesh.material.transparent === true && I.wingMesh.material.opacity < 1;
    r.fireOpaque = M.wingMesh.material.transparent !== true;
    return r; })();
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
            self.assertLessEqual(d["tris"], 12000, sid)
            self.assertGreater(d["crestVerts"], 500, "the crest's blades ride on the tube (one draw call): " + sid)
            self.assertTrue(d["wing"], "soft membrane edges (alpha to coverage; the ice and crystal skins see-through): " + sid)

    def test_far_dragons_are_lighter(self):
        for sid, d in self.o["dragons"].items():
            self.assertLess(d["lodLimbs"], d["nearLimbs"]*0.6, sid)
            # every part, not just the limbs: the tube, the membrane, the head and jaw too
            self.assertLess(d["farDrawn"], d["nearDrawn"]*0.35, sid)

    def test_jaw_is_a_hinged_mandible(self):
        for sid, d in self.o["dragons"].items():
            self.assertTrue(d["jaw"], sid)
            self.assertGreater(d["jawOpen"], 0.4, "the roar opens the jaw on its hinge: " + sid)

    def test_wingbeats_are_counted(self):
        for sid, d in self.o["dragons"].items():
            self.assertGreaterEqual(d["beats"], 3, sid)

    def test_jet_core_and_haze(self):
        j = self.o["jet"]
        self.assertTrue(j["on"] and j["two"], "a core per breathing mouth")
        self.assertTrue(j["haze"], "heat haze round fire")
        self.assertFalse(j["coldHaze"], "no heat haze round ice")
        self.assertTrue(j["off"], "the core goes out once the breath stops")
        self.assertFalse(j["nan"], "NaN never lights a jet")

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

    def test_teeth_seat_inside_the_closed_jaw(self):
        r = self.o["round2"]
        self.assertGreaterEqual(r["upperTeeth"], 20, "the upper row is there")
        self.assertLess(r["teethHalfWidth"], 0.3, "inside the lower jaw's rim, not hanging outside it")

    def test_far_head_keeps_its_eyes(self):
        self.assertGreater(self.o["round2"]["farEye"], 30, "the burning eyes survive the far version")

    def test_breathing_on_the_wing_keeps_the_wings_open(self):
        r = self.o["round2"]
        self.assertGreater(r["glideBreath"], r["glide"]*0.85, "the wings stay spread while it breathes in flight")
        self.assertLess(r["groundBreath"], r["glide"]*0.75, "(on the ground they fold)")
        self.assertGreater(r["jawBreath"], 0.3, "the jaw opens")

    def test_ice_membrane_is_cold_and_see_through(self):
        r = self.o["round2"]
        self.assertTrue(r["iceBlue"], "a glacier blue skin, not parchment")
        self.assertTrue(r["iceGlass"], "see-through")
        self.assertTrue(r["fireOpaque"])

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

    def test_far_version_switch(self):
        self.assertRegex(self.js, r"Mo\.lod = lodD > \(Mo\.lod \? 38 : 42\)")
        self.assertIn('P.sfx("wing"', self.js)
        self.assertRegex(self.js, r"if\(F\.jet\) F\.jet\(D, ")

    def test_breath_reads_from_the_chase_camera(self):
        body = self.js[self.js.index("function dragonBreathFx(D, at, dts, quiet){"):self.js.index("function dragonFlamePool(")]
        self.assertIn("DRAGON_JET_LEN, 1.45, 1.8", body, "a long, flared, bright core")
        self.assertRegex(body, r"var tk = Math\.min\(4, Math\.floor\(D\.fxAcc \* 30\)\)", "emits by the ticks a frame covered")
        self.assertIn("D.riderIsMe ? clamp(Math.tan((V.pitch || 0)", body, "your own mount breathes where you look")
        self.assertIn("st.breath = brOn && flying;", self.js, "breathing in the air keeps the wings working")
        self.assertIn("dp.userData.hpBar.visible = !D.riderIsMe", self.js, "your mount's bar is off its head")

    def test_breath_sound_gated(self):
        self.assertRegex(self.js, r"Ps\.sfx\(\"roar\"")
        body = self.js[self.js.index("function dragonBreathFx(D, at, dts, quiet){"):]
        self.assertLess(body.index("if(!F || quiet) return;"), body.index("Ps.sfx("), "no sound under Calm")


if __name__ == "__main__":
    unittest.main()
