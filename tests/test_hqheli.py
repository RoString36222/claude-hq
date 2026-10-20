"""Helicopters (games/hqheli.js) and the jets' sorties (games/hqairbase.js jetsAt).

hqheli.js and hqairbase.js's core are pure, so node loads them against a stub `window` and runs the scenarios
below in one process; the Python side checks the numbers: determinism, the same flight at 30 and 120 Hz,
the spool-up before lift-off, hover holding its height, the top speed, the ceiling, a soft landing in ground
effect, a wall that stops you, turning, the sorties (deterministic, continuous, high over the city, launched
off the carrier's deck), and the models built from the hq3d ctx with the vendored three.js.
Skipped when node is not installed. Stdlib only."""
import json
import math
import os
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
for (const f of ["hqheli", "hqairbase"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const H = window.HQV.hqheli, A = window.HQV.hqAirbase, out = {};
const flat = {floor: function(){ return 0; }};

// a scripted flight: inputs a function of time (changing on whole seconds), sampled every second
function fly(kind, hz, secs, inputs, env, x, y, z, yaw){
  var st = H.newState(kind, x || 0, y || 0, z || 0, yaw || 0), dt = 1/hz, n = Math.round(secs*hz), path = [], ev = [];
  for(var i = 0; i < n; i++){
    var t = i*dt;
    H.step(st, inputs(t), dt, env || flat).forEach(function(e){ ev.push([Math.round((t + dt)*100)/100, e.type, e.hard || false, e.v || 0]); });
    if((i + 1) %% hz === 0) path.push([st.x, st.y, st.z, st.yaw, st.speed, st.pitch, st.roll]);
  }
  return {st: st, path: path, ev: ev};
}
function sched(t){
  var s = Math.floor(t);
  if(s < 5) return {lift: 1};
  if(s < 12) return {fwd: 1, turn: s >= 8 ? 0.7 : 0};
  if(s < 15) return {fwd: -1, lift: 0.5};
  if(s < 18) return {};
  return {fwd: 0.5, turn: -1, lift: -0.3};
}
out.fri = {};
H.KINDS.forEach(function(k){
  var a = fly(k, 30, 24, sched), b = fly(k, 120, 24, sched), c = fly(k, 120, 24, sched), d = fly(k, 60, 24, sched);
  out.fri[k] = {p30: a.path, p120: b.path, p60: d.path, same: JSON.stringify(b) === JSON.stringify(c)};
});
// spool: Space from rest; when it leaves the ground
out.spool = H.KINDS.map(function(k){ var r = fly(k, 60, 4, function(){ return {lift: 1}; }); var to = r.ev.filter(function(e){ return e[1] === "takeoff"; })[0]; return [k, to ? to[0] : null, r.st.y, H.VEHICLES[k].spool]; });
// hover: climb 6 s, let go; the height over the next 10 s
out.hover = (function(){
  var st = H.newState("heli", 0, 0, 0, 0), ys = [];
  for(var i = 0; i < 6*60; i++) H.step(st, {lift: 1}, 1/60, flat);
  for(i = 0; i < 2*60; i++) H.step(st, {}, 1/60, flat);
  for(i = 0; i < 10*60; i++){ H.step(st, {}, 1/60, flat); if(i %% 60 === 0) ys.push(st.y); }
  return {ys: ys, vx: st.vx, vz: st.vz};
})();
out.top = H.KINDS.map(function(k){ var r = fly(k, 60, 60, function(t){ return t < 4 ? {lift: 1} : {fwd: 1}; }); return [k, r.st.speed, H.VEHICLES[k].top, r.st.pitch]; });
out.ceiling = (function(){ var r = fly("heli", 30, 140, function(){ return {lift: 1}; }); return {y: r.st.y, ceil: H.VEHICLES.heli.ceil}; })();
// landing: from 40 m, hold Shift; ground effect cushions it
out.land = (function(){
  var st = H.newState("heli", 0, 0, 0, 0), ev = [], minV = 0;
  for(var i = 0; i < 9*60; i++) H.step(st, {lift: 1}, 1/60, flat);
  var top = st.y;
  for(i = 0; i < 40*60 && !st.ground; i++){ H.step(st, {lift: -1}, 1/60, flat).forEach(function(e){ ev.push(e); }); minV = Math.min(minV, st.vy); }
  return {top: top, ground: st.ground, y: st.y, ev: ev, t: i/60, minV: minV};
})();
// a hard landing: thrown down from height at full sink with no ground effect (an overhang under a ledge)
out.wall = (function(){
  // a 30 m block from x 50 on; fly at it 10 m up
  var env = {floor: function(x){ return x > 50 ? 30 : 0; }}, st = H.newState("heli", 0, 0, 0, Math.PI/2), ev = [], maxX = 0;
  for(var i = 0; i < 3*60; i++) H.step(st, {lift: 1}, 1/60, env);
  for(i = 0; i < 20*60; i++){ H.step(st, {fwd: 1}, 1/60, env).forEach(function(e){ ev.push(e.type); }); maxX = Math.max(maxX, st.x); }
  return {maxX: maxX, y: st.y, ev: ev, x: st.x};
})();
// skimming up a hillside: the ground rising under you lifts you, it is not a wall
out.step = (function(){
  var env = {floor: function(x){ return Math.max(0, (x - 30)*0.5); }}, st = H.newState("heli", 0, 0, 0, Math.PI/2), ev = [];
  for(var i = 0; i < 150; i++) H.step(st, {lift: 1}, 1/60, env);
  for(i = 0; i < 8*60; i++) H.step(st, {fwd: 1}, 1/60, env).forEach(function(e){ ev.push(e.type); });
  return {x: st.x, y: st.y, ev: ev};
})();
out.turn = H.KINDS.map(function(k){ var r = fly(k, 60, 4.5, function(t){ return t < 3 ? {lift: 1} : {turn: 1}; }); return [k, r.st.yaw, r.st.roll]; });
out.groundStill = (function(){ var r = fly("heli", 60, 3, function(){ return {fwd: 1, turn: 1}; }); return [r.st.x, r.st.z, r.st.yaw, r.st.ground]; })();

// the sorties
var K = {x: 1400, z: 200, yaw: 1.2, deck: 18}, P = {cx: 0, cz: 0, seed: 12345, carrier: K};
out.jetsSame = JSON.stringify(A.jetsAt(1e12 + 33333, P)) === JSON.stringify(A.jetsAt(1e12 + 33333, P));
out.sorties = [];
for(var n = 0; n < 40; n++){
  var base = 1.7e12 - (1.7e12 %% A.CYCLE) + n*A.CYCLE, rec = {kinds: {}, maxJump: 0, minY: 1e9, maxV: 0, deck: null, count: 0, maxR: 0};
  var prev = {};
  for(var t = 0; t < A.CYCLE; t += 50){
    var js = A.jetsAt(base + t, P);
    rec.count = Math.max(rec.count, js.length);
    js.forEach(function(j){
      rec.kinds[j.id] = 1; rec.maxV = Math.max(rec.maxV, j.v);
      var p = prev[j.id]; if(p){ rec.maxJump = Math.max(rec.maxJump, Math.hypot(j.x - p.x, j.y - p.y, j.z - p.z)); }
      prev[j.id] = j;
      if(j.id === "a" || j.id === "b"){ var r = Math.hypot(j.x, j.z); rec.maxR = Math.max(rec.maxR, r); if(r < 1200) rec.minY = Math.min(rec.minY, j.y); }
      if(j.id === "cat" && t === 1000) rec.deck = [j.x, j.y, j.z];
    });
  }
  out.sorties.push(rec);
}
out.carrierXZ = K;
out.rect = [A.rectHit({x: 10, z: 0, hw: 5, hd: 1, rot: 0}, 14, 0.5), A.rectHit({x: 10, z: 0, hw: 5, hd: 1, rot: 0}, 10, 3),
            A.rectHit({x: 0, z: 0, hw: 5, hd: 1, rot: Math.PI/2}, 0, 4), A.rectHit({x: 0, z: 0, hw: 5, hd: 1, rot: Math.PI/2}, 4, 0)];

// the models
var c = {THREE: THREE, mat: function(col, o){ return new THREE.MeshStandardMaterial(Object.assign({color: col}, o || {})); }};
out.models = H.KINDS.map(function(k){
  var M = H.model(c, k, null, null), meshes = 0;
  M.g.traverse(function(o){ if(o.isMesh) meshes++; });
  M.g.remove(M.beam);
  var bb = new THREE.Box3().setFromObject(M.g); M.g.add(M.beam); var sz = bb.getSize(new THREE.Vector3());
  var st = H.newState(k, 0, 0, 0, 0); st.rpm = 1; st.ground = false; st.t = 0.05;
  H.animate(M, st, 0.1, true);
  return {kind: k, meshes: meshes, size: [sz.x, sz.y, sz.z], minY: bb.min.y, anchors: !!(M.seat && M.grips[1] && M.feet[1]),
          disc: M.disc.material.opacity, beam: M.beam.visible, strobe: M.lights.strobe.visible};
});
out.jet = (function(){ var J = A.jetModel(c); var bb = new THREE.Box3().setFromObject(J.g), sz = bb.getSize(new THREE.Vector3()); return [sz.x, sz.y, sz.z]; })();
console.log(JSON.stringify(out));
"""


def d3(a, b):
    return math.sqrt(sum((a[i] - b[i]) ** 2 for i in range(3)))


@unittest.skipUnless(NODE, "node not installed")
class HeliTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        src = HARNESS % {"root": json.dumps(ROOT)}
        r = subprocess.run([NODE, "--input-type=module", "-e", src], capture_output=True, text=True, timeout=180)
        if r.returncode != 0:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_deterministic_and_frame_rate_independent(self):
        for k, f in self.o["fri"].items():
            self.assertTrue(f["same"], k)
            self.assertEqual(len(f["p30"]), 24)
            self.assertGreater(max(d3(q, [0, 0, 0]) for q in f["p120"]), 100, k)       # it really flew
            for s, (a, b, c) in enumerate(zip(f["p30"], f["p120"], f["p60"])):
                self.assertLess(d3(a, b), 1e-6, "%s t=%d %r %r" % (k, s + 1, a, b))
                self.assertLess(d3(c, b), 1e-6, "%s t=%d" % (k, s + 1))

    def test_spools_up_before_lift_off(self):
        for k, t, y, spool in self.o["spool"]:
            self.assertIsNotNone(t, k)
            self.assertGreater(t, spool * 0.9, k)           # not before the rotor is up to speed
            self.assertLess(t, spool + 0.5, k)
            self.assertGreater(y, 5, k)

    def test_hover_holds_height(self):
        ys = self.o["hover"]["ys"]
        self.assertGreater(ys[0], 30)
        self.assertLess(max(ys) - min(ys), 0.3)
        self.assertLess(abs(self.o["hover"]["vx"]) + abs(self.o["hover"]["vz"]), 1e-6)

    def test_top_speed(self):
        for k, v, top, pitch in self.o["top"]:
            self.assertAlmostEqual(v, top, delta=0.02 * top, msg=k)
            self.assertLessEqual(v, top + 0.01, k)
            self.assertLess(pitch, -0.2, k)                    # nose down to fly forward

    def test_ceiling(self):
        c = self.o["ceiling"]
        self.assertLessEqual(c["y"], c["ceil"] + 1e-6)
        self.assertGreater(c["y"], c["ceil"] - 15)

    def test_soft_landing(self):
        L = self.o["land"]
        self.assertGreater(L["top"], 40)
        self.assertTrue(L["ground"])
        self.assertAlmostEqual(L["y"], 0, places=6)
        lands = [e for e in L["ev"] if e["type"] == "land"]
        self.assertEqual(len(lands), 1)
        self.assertFalse(lands[0]["hard"])
        self.assertGreater(lands[0]["v"], -2.5)                 # the ground effect's cushion
        self.assertLess(L["minV"], -6)                          # it came down at a fair rate before that

    def test_walls_stop_it(self):
        w = self.o["wall"]
        self.assertLessEqual(w["maxX"], 50.0001)
        self.assertIn("bump", w["ev"])
        s = self.o["step"]
        self.assertGreater(s["x"], 60)                          # a low step is no wall
        self.assertNotIn("bump", s["ev"])

    def test_turning_and_banking(self):
        for k, yaw, roll in self.o["turn"]:
            self.assertGreater(yaw, 0.6, k)                     # A (+) turns left: the yaw grows
        x, z, yaw, ground = self.o["groundStill"]
        self.assertEqual((x, z, yaw, ground), (0, 0, 0, True))  # on the ground the stick does nothing

    def test_sorties(self):
        self.assertTrue(self.o["jetsSame"])
        kinds = set()
        for rec in self.o["sorties"]:
            kinds |= set(rec["kinds"])
            self.assertLess(rec["maxJump"], 0.05 * 260, rec)    # 50 ms apart: no teleports within a sortie
            self.assertLessEqual(rec["count"], 4)
            if "a" in rec["kinds"]:
                self.assertGreater(rec["minY"], 150, rec)       # over the city, high
                self.assertGreater(rec["maxR"], 2000, rec)      # comes from (and goes to) far off
            if rec["deck"]:
                K = self.o["carrierXZ"]
                self.assertLess(math.hypot(rec["deck"][0] - K["x"], rec["deck"][2] - K["z"]), 130)
                self.assertAlmostEqual(rec["deck"][1], K["deck"], places=6)
        self.assertTrue({"a", "b", "cat", "trap"} <= kinds, kinds)
        self.assertEqual(self.o["rect"], [True, False, True, False])

    def test_models(self):
        for m in self.o["models"]:
            self.assertTrue(m["anchors"], m)
            self.assertGreater(m["meshes"], 25, m)
            self.assertGreater(m["size"][2], 9, m)              # nose to tail
            self.assertGreater(m["size"][0], 9, m)              # the rotor's span
            self.assertGreaterEqual(m["minY"], -0.05, m)        # stands on its skids / wheels
            self.assertGreater(m["disc"], 0.2, m)               # spinning: the blur disc shows
            self.assertTrue(m["beam"], m)                       # night, flying: the searchlight
        x, y, z = self.o["jet"]
        self.assertTrue(14 < z < 19 and 9 < x < 12, self.o["jet"])


if __name__ == "__main__":
    unittest.main()
