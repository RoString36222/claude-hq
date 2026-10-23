"""Drawing the City's residents (games/npcdraw.js, Cities spec task cl-npc): LOD, avoidance, the instanced
bodies, speech, and the frame budget.

node loads games/npcsim.js and games/npcdraw.js against a stub `window` and the vendored three.js (as
tests/test_hqmerge.py), with the town from tests/fixtures/npc_town@2.json. The pure helpers (split, avoid,
packFar, bodyGeometry, colours, pickTalk) are checked directly; create() runs headless with a stand-in
character loader (no WebGL needed: nothing is rendered). The microbenchmark times a frame's work for 150
visible residents (sim.at, the LOD split, avoidance, the instance packing) against the spec's 2 ms budget.
Skipped when node is not installed. Stdlib only."""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
FIXTURE = os.path.join(ROOT, "tests", "fixtures", "npc_town@2.json")
SRC = os.path.join(ROOT, "games", "npcdraw.js")

HARNESS = r"""
var fs = require("fs"), url = require("url"), root = %(root)s;
global.window = {HQV: {}};
["npcsim.js", "npcdraw.js"].forEach(function(f){ new Function(fs.readFileSync(root + "/games/" + f, "utf8"))(); });
var S = window.HQV.npcSim, D = window.HQV.npcDraw, out = {};
var doc = JSON.parse(fs.readFileSync(root + "/tests/fixtures/npc_town@2.json", "utf8"));
var H = S.HOUR, D0 = 20*S.DAY;
function R(id, d, o){ var r = {id: id, x: d, y: 0.65, z: 0, yaw: 0, anim: "walk", mode: "walk", speed: 1.3, d2: d*d}; for(var k in o || {}) r[k] = o[k]; return r; }

// LOD split: near under 40 m (44 m for those already near), at most 30; far to 150 m, at most 120; no drivers
var L1 = [R(1, 10), R(2, 39), R(3, 42), R(4, 45), R(5, 60), R(6, 20, {anim: "drive", mode: "car"}), R(7, 149), R(8, 151)];
function ids(a){ return a.map(function(r){ return r.id; }); }
var s1 = D.split(L1, {}), s2 = D.split(L1, {3: 1, 4: 1});
var crowd = []; for(var i = 0; i < 200; i++) crowd.push(R(i, 5 + i*0.5));
var s3 = D.split(crowd, {});
out.split = {near: ids(s1.near), far: ids(s1.far), nearHyst: ids(s2.near), farHyst: ids(s2.far), crowd: [s3.near.length, s3.far.length],
             crowdNearMax: s3.near[s3.near.length - 1].d2, crowdFarMin: s3.far[0].d2};

// avoidance: a resident on the player's spot steps aside, capped; two on one spot part; frame-rate independent
function runAvoid(items, player, steps, dt){ var st = {}; for(var k = 0; k < steps; k++){ items.forEach(function(r){ delete r.ax; }); D.avoid(items, player, st, dt); } return st; }
var a60 = [R(1, 0, {x: 3, z: 4}), R(2, 0, {x: 3.1, z: 4})], a30 = [R(1, 0, {x: 3, z: 4}), R(2, 0, {x: 3.1, z: 4})];
var st60 = runAvoid(a60, {x: 3, z: 4.2}, 60, 1/60), st30 = runAvoid(a30, {x: 3, z: 4.2}, 30, 1/30);
var maxOff = 0, st = {}, pts = [R(1, 0, {x: 0, z: 0}), R(2, 0, {x: 0, z: 0}), R(3, 0, {x: 0.2, z: 0}), R(4, 0, {x: 0, z: 0.3})];
for(i = 0; i < 300; i++){ D.avoid(pts, {x: 0.05, z: 0.05}, st, 1/60); pts.forEach(function(r){ maxOff = Math.max(maxOff, Math.hypot(r.ax - r.x, r.az - r.z)); }); }
var st2 = {}, pair = [R(1, 0, {x: 0, z: 0}), R(2, 0, {x: 0, z: 0}), R(3, 0, {x: 3, z: 0})];
for(i = 0; i < 120; i++) D.avoid(pair, null, st2, 1/60);
pts = pair;
var minGap = Infinity; for(i = 0; i < pts.length; i++) for(var j = i + 1; j < pts.length; j++) minGap = Math.min(minGap, Math.hypot(pts[i].ax - pts[j].ax, pts[i].az - pts[j].az));
var far = [R(9, 0, {x: 50, z: 50})], stFar = {}; D.avoid(far, {x: 0, z: 0}, stFar, 1/60);
D.avoid([R(1, 0, {x: 0, z: 0})], null, st, 1/60);
var dead = [R(5, 0, {x: 7, z: 7})]; runAvoid(dead, {x: 7, z: 7}, 120, 1/60);
out.avoid = {d60: [a60[0].ax - a60[0].x, a60[0].az - a60[0].z, a60[1].ax - a60[1].x], d30: [a30[0].ax - a30[0].x, a30[0].az - a30[0].z, a30[1].ax - a30[1].x],
             playerGap: Math.hypot(a60[0].ax - 3, a60[0].az - 4.2), maxOff: maxOff, minGap: minGap, farOff: Math.hypot(far[0].ax - 50, far[0].az - 50),
             kept: Object.keys(st), deadOn: Math.hypot(dead[0].ax - 7, dead[0].az - 7)};

// the body: low poly, 1.7 m, faces wound with their normals, limbs on their pivots
var G = D.bodyGeometry(), wound = 0, top = 0, lo = Infinity;
for(i = 0; i < G.idx.length; i += 3){
  var p = [G.idx[i], G.idx[i+1], G.idx[i+2]].map(function(k){ return [G.pos[3*k], G.pos[3*k+1], G.pos[3*k+2]]; });
  var u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]], v = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
  var c = [u[1]*v[2] - u[2]*v[1], u[2]*v[0] - u[0]*v[2], u[0]*v[1] - u[1]*v[0]], n = G.idx[i]*3;
  if(c[0]*G.nrm[n] + c[1]*G.nrm[n+1] + c[2]*G.nrm[n+2] > 0) wound++;
}
for(i = 1; i < G.pos.length; i += 3){ top = Math.max(top, G.pos[i]); lo = Math.min(lo, G.pos[i]); }
var limbs = {}; for(i = 0; i < G.limb.length; i++){ var key = G.limb[i] + "@" + G.pivot[i].toFixed(2) + "/" + G.part[i]; limbs[key] = 1; }
out.body = {verts: G.pos.length/3, tris: G.idx.length/3, wound: wound, top: top, lo: lo, limbs: Object.keys(limbs).sort()};

// instance packing: yaw turns local +z to (sin yaw, cos yaw); gait swings only when walking; outfits
var sim = S.create(doc, {tier: 5, grow: 1000, seed: "draw"}), cols = D.colours(sim), B = D.farBuffers(4);
var n = D.packFar([R(7, 0, {x: 10, y: 0.6, z: -4, yaw: Math.PI/2}), R(8, 0, {x: 1, z: 2, anim: "idle", speed: 0, ax: 1.5, az: 2.5}),
                   R(9, 0), R(10, 0), R(11, 0)], B, cols);
var M = Array.from(B.mat.slice(0, 32)).map(function(v){ return Math.round(v*1e6)/1e6; });
out.pack = {n: n, m0: M.slice(0, 16), m1t: M.slice(28, 31), gait: Array.from(B.gait.slice(0, 6)),
            shirt7: Array.from(B.shirt.slice(0, 3)), want7: Array.from(cols.slice(63, 66)), lin: [D.lin(0xffffff), D.lin(0), D.lin(0x808080)]};

// the city's poses: a patient lies on its back, fans wave (a negative swing)
var B2 = D.farBuffers(3);
D.packFar([R(1, 0, {x: 3, y: 0.6, z: 4, yaw: 0, anim: "lie", speed: 0}), R(2, 0, {anim: "cheer", speed: 0}),
           R(3, 0, {x: 0, z: 0, yaw: Math.PI/2, anim: "lie", speed: 0})], B2, null);
out.poses = {lie: Array.from(B2.mat.slice(0, 16)).map(function(v){ return Math.round(v*1e6)/1e6; }),
             lie90: Array.from(B2.mat.slice(32, 48)).map(function(v){ return Math.round(v*1e6)/1e6; }),
             gait: Array.from(B2.gait.slice(0, 6)), clips: D.CLIPS};

// talk: the nearest drawn within reach
out.talk = {pick: (D.pickTalk([R(1, 0, {x: 2, z: 0}), R(2, 0, {x: 1, z: 1}), R(3, 0, {x: 0.5, z: 0, ax: 9, az: 9})], {x: 0, z: 0}) || {}).id,
            none: D.pickTalk([R(1, 0, {x: 5, z: 0})], {x: 0, z: 0})};

import(url.pathToFileURL(root + "/games/vendor/three-module.js").href).then(function(THREE){
  // the body shader patch lands on the Lambert chunks it names
  var mat = null, scene = new THREE.Scene();
  var loads = 0, LOOK = [];
  function loader(look, cb){   // a stand-in character: a group, a mixer, walk and idle actions
    loads++; LOOK.push(look.char);
    var o = new THREE.Group(), m = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.7, 0.2), new THREE.MeshStandardMaterial()), mixer = new THREE.AnimationMixer(o);
    m.name = "body"; o.add(m);
    var clip = function(nm){ return new THREE.AnimationClip(nm, 1, [new THREE.NumberKeyframeTrack("body.position[y]", [0, 0.5, 1], [0, 0.05, 0])]); };
    cb({o: o, mixer: mixer, acts: {idle: mixer.clipAction(clip("idle")), walk: mixer.clipAction(clip("walk"))}});
  }
  var dsim = S.create(doc, {tier: 5, grow: 1000, seed: "draw"}), draw = D.create(THREE, scene, dsim, {loader: loader});
  var body = draw.group.children.filter(function(c){ return c.isInstancedMesh; })[0], sh = {uniforms: {},
      vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader};
  body.material.onBeforeCompile(sh);
  out.shader = {vtx: /npcSw/.test(sh.vertexShader) && /attribute vec3 aGait/.test(sh.vertexShader) && /vNpcCol = /.test(sh.vertexShader),
                frag: /diffuseColor\.rgb \*= vNpcCol/.test(sh.fragmentShader), uniform: !!sh.uniforms.uNpcTime,
                key: body.material.customProgramCacheKey(), attrs: Object.keys(body.geometry.attributes).sort()};
  // run a minute at 08:15 over the busiest spot
  var t = D0 + 8.25*H, best = null;
  dsim.at(t, {x: 0, z: 0}, 5000).forEach(function(r){
    var k = dsim.at(t, r, 40).length; if(!best || k > best.k) best = {k: k, x: r.x, z: r.z};
  });
  var cam = {x: best.x, z: best.z}, worst = {near: 0, far: 0}, off = 0, nearIn = 0, chars = 0;
  for(var f = 0; f < 600; f++){
    var tt = t + f*100;
    draw.update(tt, cam, {x: cam.x, z: cam.z}, 0.1);
    worst.near = Math.max(worst.near, draw.stats.near); worst.far = Math.max(worst.far, body.count);
    var vis = {}; dsim.at(tt, cam, 150).forEach(function(r){ vis[r.id] = r; });
    draw.group.children.forEach(function(c){
      if(c.isInstancedMesh || !c.visible) return;
      chars++;
      var best2 = Infinity; Object.keys(vis).forEach(function(id){ var r = vis[id]; best2 = Math.min(best2, Math.hypot(c.position.x - r.x, c.position.z - r.z)); });
      off = Math.max(off, best2);
      if(Math.hypot(c.position.x - cam.x, c.position.z - cam.z) > D.NEAR_OUT + D.AV.max) nearIn++;
    });
  }
  var spoken = null; for(f = 0; f < 600 && !spoken; f++){ draw.update(t + 60000 + f*100, cam, null, 0.1);
    var vis2 = draw.group.children.filter(function(c){ return !c.isInstancedMesh && c.visible; });
    if(vis2.length){ spoken = draw.talk({x: vis2[0].position.x + 0.5, z: vis2[0].position.z}, t + 60000 + f*100); } }
  out.draw = {crowd: best.k, near: worst.near, far: worst.far, loads: loads, chars: chars, off: off, outside: nearIn,
              spoken: spoken, nobody: draw.talk({x: 1e5, z: 1e5}, t), looks: LOOK.every(function(c){ return c >= 0 && c < 6; })};
  // a loader that never finishes: near residents are drawn as bodies meanwhile
  var d2 = D.create(THREE, new THREE.Scene(), dsim, {loader: function(){}});
  d2.update(t, cam, null, 1/60);
  var bodies2 = d2.group.children.filter(function(c){ return c.isInstancedMesh; })[0];
  out.pending = {count: bodies2.count, near: d2.stats.near, loading: d2.stats.loading, visible: D.split(dsim.at(t, cam, 150), {}).near.length + D.split(dsim.at(t, cam, 150), {}).far.length};
  // the camera high over the same crowd (the map): its height counts, so nobody near and nobody skinned
  draw.update(t, {x: cam.x, y: 600, z: cam.z}, null, 0.1);
  out.high = {near: draw.stats.near, far: draw.stats.far, chars: draw.group.children.filter(function(c){ return !c.isInstancedMesh && c.visible; }).length};
  draw.update(t, {x: cam.x, y: 3, z: cam.z}, null, 0.1); out.high.lowNear = draw.stats.near;
  draw.dispose(); out.disposed = scene.children.length;

  // microbenchmark: 150 visible residents (a whole-town radius, the 150 nearest), a frame's work
  var bsim = S.create(doc, {tier: 5, grow: 1000, seed: "bench"}), bcols = D.colours(bsim), BB = D.farBuffers(150), bst = {};
  var bc = {x: 0, z: 0}, frames = [], vis150 = [];
  function frame(tt){
    var list = bsim.at(tt, bc, 2000).slice(0, 150), sp = D.split(list, {}, {near: 15, nearOut: 16, far: 1e9});
    D.avoid(sp.near, bc, bst, 1/60);
    D.packFar(sp.near.concat(sp.far), BB, bcols);
    return list.length;
  }
  var tb = D0 + 12.2*H;
  for(f = 0; f < 120; f++) frame(tb - 120*16.7 + f*16.7);   // warm-up (the JIT, the first routes)
  for(f = 0; f < 600; f++){
    var t0 = process.hrtime.bigint(); vis150.push(frame(tb + f*16.7)); frames.push(Number(process.hrtime.bigint() - t0)/1e6);
  }
  frames.sort(function(a, b){ return a - b; });
  out.bench = {mean: frames.reduce(function(a, b){ return a + b; }, 0)/frames.length, p50: frames[300], p95: frames[570], max: frames[599],
               visibleMin: Math.min.apply(null, vis150), pop: bsim.population};
  // and the whole update() of a 2000-resident town at rush hour (the routes it plans included)
  var usim = S.create(doc, {tier: 5, grow: 1000, seed: "bench"}), ud = D.create(THREE, new THREE.Scene(), usim, {loader: loader}), ut = [];
  for(f = 0; f < 120; f++) ud.update(t + f*16.7, cam, cam, 1/60);
  for(f = 0; f < 600; f++){ var u0 = process.hrtime.bigint(); ud.update(t + 2000 + f*16.7, cam, cam, 1/60); ut.push(Number(process.hrtime.bigint() - u0)/1e6); }
  out.bench.update = ut.reduce(function(a, b){ return a + b; }, 0)/ut.length;
  console.log(JSON.stringify(out));
}).catch(function(e){ console.error(e && e.stack || e); process.exit(1); });
"""


@unittest.skipUnless(NODE and os.path.exists(FIXTURE), "node and tests/fixtures/npc_town@2.json needed")
class NpcDrawTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        js = HARNESS.replace("%(root)s", json.dumps(ROOT))
        p = subprocess.run([NODE, "-e", js], capture_output=True, text=True, timeout=300)
        if p.returncode != 0:
            raise AssertionError("node harness failed:\n" + p.stderr[-4000:])
        cls.r = json.loads(p.stdout.strip().splitlines()[-1])

    def test_lod_split(self):
        s = self.r["split"]
        self.assertEqual(s["near"], [1, 2])
        self.assertEqual(s["far"], [3, 4, 5, 7])                 # the driver is in a car; 151 m is not drawn
        self.assertEqual(s["nearHyst"], [1, 2, 3])               # already near: stays near to 44 m
        self.assertEqual(s["farHyst"], [4, 5, 7])
        self.assertEqual(s["crowd"], [30, 120])                  # the caps
        self.assertLessEqual(s["crowdNearMax"], s["crowdFarMin"])  # the nearest get the characters

    def test_avoidance(self):
        a = self.r["avoid"]
        for x, y in zip(a["d60"], a["d30"]):                     # frame-rate independent
            self.assertAlmostEqual(x, y, places=6)
        self.assertGreater(a["playerGap"], 0.95)                 # stepped out of the player's way (0.2 m -> 1 m)
        self.assertLessEqual(a["maxOff"], 0.8 + 1e-9)            # never far from its sim position
        self.assertGreater(a["minGap"], 0.65)                    # two on one spot part to about AV.other
        self.assertAlmostEqual(a["farOff"], 0.0)
        self.assertAlmostEqual(a["deadOn"], 0.8, places=2)       # dead on the player: a full step aside
        self.assertEqual(a["kept"], ["1"])                       # gone residents' state is dropped

    def test_body_geometry(self):
        b = self.r["body"]
        self.assertEqual(b["verts"], 144)
        self.assertLessEqual(b["tris"], 100)                     # low poly
        self.assertEqual(b["wound"], b["tris"])
        self.assertAlmostEqual(b["top"], 1.7, places=3)
        self.assertAlmostEqual(b["lo"], 0.0, places=6)
        self.assertEqual(b["limbs"], ["-1@0.80/2", "-2@1.34/1", "0@0.00/0", "0@0.00/1", "1@0.80/2", "2@1.34/1"])

    def test_instance_packing(self):
        p = self.r["pack"]
        self.assertEqual(p["n"], 4)                              # the buffer's capacity
        m = p["m0"]
        self.assertEqual(m[8:11], [1, 0, 0])                     # yaw pi/2: local +z faces +x
        self.assertEqual(m[0:3], [0, 0, -1])
        self.assertEqual(m[12:16], [10, 0.6, -4, 1])
        self.assertEqual(p["m1t"], [1.5, 0.65, 2.5])             # the avoided position when there is one
        self.assertGreater(p["gait"][1], 0)
        self.assertGreater(p["gait"][2], 0)
        self.assertEqual(p["gait"][4:6], [0, 0])                 # idle: no swing
        self.assertEqual(p["shirt7"], p["want7"])
        self.assertEqual(p["lin"][0], [1, 1, 1])
        self.assertEqual(p["lin"][1], [0, 0, 0])
        self.assertAlmostEqual(p["lin"][2][0], 0.2158605, places=5)

    def test_city_poses(self):
        p = self.r["poses"]
        m = p["lie"]
        self.assertEqual(m[4:7], [0, 0, -1])                     # lying: the head (local +y) toward -z
        self.assertEqual(m[8:11], [0, 1, 0])                     # the face (local +z) up
        self.assertEqual(m[12:15], [3, 0.75, 4])                 # lifted out of the ground
        self.assertEqual(p["lie90"][4:7], [-1, 0, 0])            # turned with its yaw
        self.assertEqual(p["gait"][1:3], [0, 0])                 # lying still
        self.assertGreater(p["gait"][4], 0)
        self.assertLess(p["gait"][5], 0)                         # cheering: the arms-overhead wave
        self.assertEqual(p["clips"]["lie"], "die")
        self.assertEqual(p["clips"]["cheer"], "emote-yes")

    def test_talk_pick(self):
        self.assertEqual(self.r["talk"]["pick"], 2)              # 3 has stepped aside to (9, 9)
        self.assertIsNone(self.r["talk"]["none"])

    def test_shader_patch(self):
        s = self.r["shader"]
        self.assertTrue(s["vtx"])
        self.assertTrue(s["frag"])
        self.assertTrue(s["uniform"])
        self.assertEqual(s["key"], "hq-npc-body")
        self.assertTrue({"aGait", "aShirt", "aPants", "aSkin", "aPart", "aLimb", "aPivot", "position", "normal"} <= set(s["attrs"]))

    def test_draw_headless(self):
        d = self.r["draw"]
        self.assertGreater(d["crowd"], 5)
        self.assertGreater(d["near"], 0)
        self.assertLessEqual(d["near"], 30)
        self.assertLessEqual(d["far"], 150)
        self.assertGreater(d["chars"], 0)
        self.assertLessEqual(d["loads"], 36)                     # pooled: never more than the near cap + spares
        self.assertLessEqual(d["off"], 0.8 + 1e-6)               # characters stand where the sim says (+ avoidance)
        self.assertEqual(d["outside"], 0)
        self.assertTrue(d["looks"])
        self.assertIsNotNone(d["spoken"])
        self.assertTrue(isinstance(d["spoken"]["text"], str) and len(d["spoken"]["text"]) > 5)
        self.assertIsNone(d["nobody"])
        self.assertEqual(self.r["disposed"], 0)

    def test_camera_height_counts(self):
        h = self.r["high"]
        self.assertEqual([h["near"], h["far"], h["chars"]], [0, 0, 0], "a map camera 600 m up draws no residents")
        self.assertGreater(h["lowNear"], 0, "back at street level the crowd is near again")

    def test_loading_characters_drawn_as_bodies(self):
        p = self.r["pending"]
        self.assertEqual(p["near"], 0)
        self.assertGreater(p["count"], 0)
        self.assertEqual(p["count"], p["visible"])

    def test_frame_budget(self):
        b = self.r["bench"]
        self.assertEqual(b["pop"], 2000)
        self.assertGreaterEqual(b["visibleMin"], 150)
        # the spec's budget is 2 ms on M-series; asserted generously (shared CI machines), measured ~10x under
        self.assertLess(b["mean"], 2.0, b)
        self.assertLess(b["p95"], 4.0, b)
        self.assertLess(b["update"], 4.0, b)

    def test_source_rules(self):
        with open(SRC, encoding="utf-8") as f:
            src = f.read()
        self.assertNotIn("Math.random", src)
        self.assertNotIn("innerHTML", src)
        self.assertNotRegex(src, r"https?://")
        self.assertIsNone(re.search(r"Math\.min\(\s*1\s*,\s*[^)]*dt", src))


if __name__ == "__main__":
    unittest.main()
