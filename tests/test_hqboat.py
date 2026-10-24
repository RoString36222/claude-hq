"""Boats on the sea (games/hqboat.js): the rowboat and the jet ski.

hqboat.js is pure, so node loads it (with games/ocean.js for the coast test and the waves) against
a stub `window` and runs the scenarios below in one process; the Python side checks the numbers:
determinism, the same path at 30 and 120 Hz, the turn rate rising with speed, bob/pitch/roll on the
waves, beaching at a coast polygon, docking at a berth (and leaving it), and the models built from
the hq3d ctx with the vendored three.js. Skipped when node is not installed. Stdlib only."""
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
for (const f of ["ocean", "hqboat"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const B = window.HQV.hqboat, O = window.HQV.ocean, out = {};

// a round island, coast radius R m (cm in the doc, CCW), one dock on its north shore facing out
function islandDoc(R, dockAng){
  var coast = [], n = 96;
  for(var i = 0; i < n; i++){ var a = i/n*Math.PI*2; coast.push([Math.round(Math.sin(a)*R*100), Math.round(Math.cos(a)*R*100)]); }
  var a = dockAng || 0, c = R - 10;
  return {layers: {island: {coast: coast, sea_cm: 0, docks: ["d1"], radius_by_tier: [200, 300, 400, 500, 600]},
    sites: [{id: "d1", kind: "dock", x: Math.round(Math.sin(a)*c*100), z: Math.round(Math.cos(a)*c*100), w: 600, d: 2000,
             front: [Math.round(Math.sin(a)*65536), Math.round(Math.cos(a)*65536)]},
            {id: "s2", kind: "market", x: 0, z: 0, w: 4000, d: 4000}]}};
}
// a scripted run: inputs are a function of time (changing only on whole seconds), samples every second
function run(kind, hz, secs, inputs, sea, x, z, yaw){
  var st = B.newState(kind, x || 0, z || 0, yaw || 0), dt = 1/hz, n = Math.round(secs*hz), path = [], ev = [];
  for(var i = 0; i < n; i++){
    var t = i*dt, e = B.step(st, inputs(t), dt, sea);
    e.forEach(function(q){ ev.push([Math.round((t + dt)*1000)/1000, q.type, q.id || null]); });
    if((i + 1) %% hz === 0) path.push([st.x, st.z, st.yaw, st.speed, st.y, st.pitch, st.roll]);
  }
  return {st: st, path: path, ev: ev};
}
function sched(t){
  var s = Math.floor(t);
  if(s < 6) return {thr: 1, steer: s >= 3 ? 0.6 : 0};
  if(s < 9) return {thr: 0.5, steer: -1};
  if(s < 11) return {thr: 0, steer: 0};
  if(s < 14) return {thr: -1, steer: 0.5};
  return {thr: 1, steer: 0};
}
var open = {land: function(){ return false; }, docks: [], y: 0, wave: O.waveAt};

// determinism and frame-rate independence, both kinds, on the waves
out.fri = {};
B.KINDS.forEach(function(k){
  var a = run(k, 30, 20, sched, open), b = run(k, 120, 20, sched, open), c = run(k, 120, 20, sched, open);
  out.fri[k] = {p30: a.path, p120: b.path, same: JSON.stringify(b) === JSON.stringify(c), moved: Math.hypot(b.st.x, b.st.z)};
});
// the speed is exact (closed form) on a straight run, any step size
out.straight = [10, 30, 60, 120, 240].map(function(hz){ var r = run("jetski", hz, 4, function(){ return {thr: 1}; }, {}); return [r.st.speed, r.st.z]; });
out.top = B.KINDS.map(function(k){ var r = run(k, 60, 120, function(){ return {thr: 1}; }, {}); return [k, r.st.speed, B.VEHICLES[k].top]; });
out.rev = B.KINDS.map(function(k){ var r = run(k, 60, 60, function(){ return {thr: -1}; }, {}); return [k, r.st.speed, B.VEHICLES[k].rev]; });
// turning: the rate a hull can make grows with speed; a jet ski barely turns at rest, a rowboat pivots
out.turnAt = B.KINDS.map(function(k){ var V = B.VEHICLES[k]; return [0, 1, 3, 6, 12, 20].map(function(v){ return B.turnAt(V, v); }); });
out.turnRest = B.KINDS.map(function(k){ var r = run(k, 60, 2, function(){ return {steer: 1}; }, {}); return [k, r.st.yaw]; });
out.turnFast = (function(){
  var st = B.newState("jetski", 0, 0, 0);
  for(var i = 0; i < 600; i++) B.step(st, {thr: 1}, 1/60, {});
  var y0 = st.yaw; for(i = 0; i < 60; i++) B.step(st, {thr: 1, steer: 1}, 1/60, {});
  return st.yaw - y0;
})();
out.astern = (function(){ var r = run("rowboat", 60, 6, function(t){ return {thr: -1, steer: t > 3 ? 1 : 0}; }, {}); return r.st.yaw; })();
// bob, pitch and roll: a sloping sea pitches the nose up going uphill, a sea higher on the left puts the right side down
function settled(kind, wave, yaw){ var st = B.newState(kind, 0, 0, yaw); for(var i = 0; i < 300; i++) B.step(st, {}, 1/60, {wave: wave, y: 1.5}); return st; }
out.tilt = {up: settled("rowboat", function(x, z){ return 0.1*z; }, 0).pitch, down: settled("rowboat", function(x, z){ return 0.1*z; }, Math.PI).pitch,
            left: settled("rowboat", function(x){ return 0.1*x; }, 0).roll, y: settled("rowboat", function(){ return 0.2; }, 0).y,
            draft: B.VEHICLES.rowboat.draft};
out.bob = (function(){ var st = B.newState("rowboat", 3, 4, 0.3), ys = [], ps = []; for(var i = 0; i < 600; i++){ B.step(st, {}, 1/60, open); if(i %% 30 === 0){ ys.push(st.y); ps.push(st.pitch); } } return {ys: ys, ps: ps}; })();
out.lean = (function(){ var st = B.newState("jetski", 0, 0, 0); for(var i = 0; i < 600; i++) B.step(st, {thr: 1}, 1/60, {}); for(i = 0; i < 90; i++) B.step(st, {thr: 1, steer: 1}, 1/60, {}); return [st.rate, st.roll]; })();

// beaching: full ahead at the coast stops the bow on the shore, at any frame rate; reverse frees it
var doc = islandDoc(850, 0), sea = O.seaOf(doc);
out.dockBerth = sea.docks;
out.beach = [30, 60, 120].map(function(hz){
  // from the east, 40 m out, heading west at the island
  var r = run("jetski", hz, 12, function(){ return {thr: 1}; }, sea, 890, -200, -Math.PI/2);
  var st = r.st, V = B.VEHICLES.jetski, bx = st.x + Math.sin(st.yaw)*V.len/2, bz = st.z + Math.cos(st.yaw)*V.len/2;
  return {x: st.x, z: st.z, bowR: Math.hypot(bx, bz), bowLand: sea.land(bx, bz), speed: st.speed, beached: st.beached, ev: r.ev};
});
out.unbeach = (function(){
  var r = run("jetski", 60, 12, function(t){ return {thr: t < 8 ? 1 : -1}; }, sea, 890, -200, -Math.PI/2), st = r.st;
  return {x: st.x, beached: st.beached, ev: r.ev, speed: st.speed};
})();
out.rowBeach = (function(){ var r = run("rowboat", 60, 40, function(){ return {thr: 1}; }, sea, 0, -880, 0); return {z: r.st.z, ev: r.ev, speed: r.st.speed}; })();

// docking: slow by the berth, held there; too fast goes past; the throttle leaves; no re-dock until clear
var berth = sea.docks[0];
out.dock = [30, 120].map(function(hz){
  // 30 m out to sea from the berth, heading in toward the island, at rowing pace
  var r = run("rowboat", hz, 30, function(){ return {thr: 0.7}; }, sea, berth.x, berth.z + 30, Math.PI + 0.2);
  return {ev: r.ev, x: r.st.x, z: r.st.z, yaw: r.st.yaw, dock: r.st.dock, speed: r.st.speed};
});
out.fastPast = (function(){
  // a jet ski at speed across the berth (along the shore): no dock
  var st = B.newState("jetski", berth.x - 120, berth.z + 2, Math.PI/2), ev = [];
  for(var i = 0; i < 60*12; i++) B.step(st, {thr: 1}, 1/60, sea).forEach(function(e){ ev.push(e.type); });
  return ev;
})();
out.leave = (function(){
  var st = B.newState("rowboat", berth.x, berth.z + 3, Math.PI), ev = [];
  function go(secs, inp){ for(var i = 0; i < Math.round(secs*60); i++) B.step(st, inp, 1/60, sea).forEach(function(e){ ev.push([e.type, Math.hypot(st.x - berth.x, st.z - berth.z)]); }); }
  go(1, {});                                // docks where it is (slow, in range)
  go(3, {thr: -1});                         // backs away from the shore: undocks
  var gone = Math.hypot(st.x - berth.x, st.z - berth.z);
  go(4, {});                                // drifts to a stop, slow and in range, but just left: no re-dock
  var held = st.dock;
  go(9, {thr: -1});                         // on out, clear of it (past rearm*r)
  go(16, {thr: 0.5});                       // in again, slowly: it takes you once you have been clear of it
  return {ev: ev, gone: gone, held: held, dock: st.dock};
})();

// the models, from a stub hq3d ctx with real THREE
var c = {THREE: THREE, mat: function(col, o){ return new THREE.MeshStandardMaterial(Object.assign({color: col}, o || {})); }};
out.models = B.KINDS.map(function(k){
  var M = B.model(c, k, 0x3366aa, 0xffffff), meshes = 0, tris = 0;
  M.g.traverse(function(o){ if(o.isMesh){ meshes++; var g = o.geometry; tris += (g.index ? g.index.count : g.attributes.position.count)/3; } });
  var bb = new THREE.Box3().setFromObject(M.g), sz = bb.getSize(new THREE.Vector3());
  B.animate(M, {steer: 0.8}, {thr: 1, steer: 0.8}, 0.3);
  return {kind: k, name: M.g.name, meshes: meshes, tris: tris, size: [sz.x, sz.y, sz.z], minY: bb.min.y,
          anchors: !!(M.seat && M.grips[0] && M.grips[1] && M.feet[0] && M.feet[1]), steer: M.steer ? M.steer.rotation.y : null,
          oar: M.oars ? M.oars[0].rotation.y : null};
});
console.log(JSON.stringify(out));
"""


def dist(a, b):
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5


@unittest.skipUnless(NODE, "node not installed")
class BoatTest(unittest.TestCase):
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
            self.assertGreater(f["moved"], 5, k)
            self.assertEqual(len(f["p30"]), 20)
            for s, (a, b) in enumerate(zip(f["p30"], f["p120"])):
                self.assertLess(dist(a, b), 0.25, "%s t=%d %r %r" % (k, s + 1, a, b))
                self.assertLess(abs(a[2] - b[2]), 0.01, "%s yaw t=%d" % (k, s + 1))
                self.assertLess(abs(a[3] - b[3]), 0.05, "%s speed t=%d" % (k, s + 1))
                self.assertLess(abs(a[4] - b[4]), 0.03, "%s heave t=%d" % (k, s + 1))
                self.assertLess(abs(a[5] - b[5]), 0.01, "%s pitch t=%d" % (k, s + 1))

    def test_straight_speed_is_exact_at_any_rate(self):
        v0, z0 = self.o["straight"][0]
        for v, z in self.o["straight"]:
            self.assertAlmostEqual(v, v0, places=9)
            self.assertAlmostEqual(z, z0, places=6)

    def test_top_and_reverse_speeds(self):
        for k, v, top in self.o["top"]:
            self.assertAlmostEqual(v, top, delta=0.01 * top, msg=k)
        for k, v, rev in self.o["rev"]:
            self.assertAlmostEqual(v, -rev, delta=0.01 * rev, msg=k)

    def test_turn_rate_rises_with_speed(self):
        for rates in self.o["turnAt"]:
            for a, b in zip(rates, rates[1:]):
                self.assertGreater(b, a)
        row, jet = dict(self.o["turnRest"])["rowboat"], dict(self.o["turnRest"])["jetski"]
        self.assertGreater(row, 0.5)            # oars pivot it from rest (A turns left: yaw grows)
        self.assertLess(jet, 0.35)              # no thrust, (almost) no steering
        self.assertGreater(self.o["turnFast"], 0.8)
        self.assertLess(self.o["astern"], 0)    # going astern the helm works the other way

    def test_waves_pitch_roll_and_bob(self):
        t = self.o["tilt"]
        self.assertAlmostEqual(t["up"], 0.0997, delta=0.01)
        self.assertAlmostEqual(t["down"], -0.0997, delta=0.01)
        self.assertAlmostEqual(t["left"], 0.0997, delta=0.01)       # higher on the left: right side down (roll > 0)
        self.assertAlmostEqual(t["y"], 1.5 + 0.2 - t["draft"], delta=0.01)
        ys, ps = self.o["bob"]["ys"], self.o["bob"]["ps"]
        self.assertGreater(max(ys) - min(ys), 0.05)
        self.assertGreater(max(ps) - min(ps), 0.005)
        rate, roll = self.o["lean"]
        self.assertGreater(rate, 0.5)
        self.assertLess(roll, -0.05)            # leans into a left turn (left side down)

    def test_beaching_stops_at_the_shore(self):
        stops = []
        for b in self.o["beach"]:
            self.assertFalse(b["bowLand"])
            self.assertAlmostEqual(b["bowR"], 849.5, delta=0.6)     # the 96-gon's coast at that bearing
            self.assertEqual(b["speed"], 0)
            self.assertTrue(b["beached"])
            self.assertEqual([e[1] for e in b["ev"]], ["beach"])
            stops.append((b["x"], b["z"]))
        for s in stops:
            self.assertLess(dist(s, stops[0]), 0.05)
        u = self.o["unbeach"]
        self.assertFalse(u["beached"])
        self.assertLess(u["speed"], 0)
        self.assertGreater(u["x"], self.o["beach"][1]["x"] + 2)
        rb = self.o["rowBeach"]
        self.assertEqual([e[1] for e in rb["ev"]], ["beach"])
        self.assertEqual(rb["speed"], 0)

    def test_docking(self):
        berth = self.o["dockBerth"][0]
        self.assertEqual(berth["id"], "d1")
        self.assertAlmostEqual(berth["z"], 840 + 14, delta=0.01)   # site centre + half its depth + 4 m, on the water side
        self.assertAlmostEqual(berth["yaw"], 0, delta=1e-9)       # facing out to sea
        for d in self.o["dock"]:
            self.assertEqual([e[1] for e in d["ev"]], ["dock"])
            self.assertEqual(d["dock"], "d1")
            self.assertLess(dist((d["x"], d["z"]), (berth["x"], berth["z"])), 0.05)
            self.assertLess(min(abs(d["yaw"]), abs(abs(d["yaw"]) - 3.14159265)), 0.01)   # alongside, either way round
        self.assertLess(abs(self.o["dock"][0]["ev"][0][0] - self.o["dock"][1]["ev"][0][0]), 0.05)
        self.assertNotIn("dock", self.o["fastPast"])
        lv = self.o["leave"]
        kinds = [e[0] for e in lv["ev"]]
        self.assertEqual(kinds[:2], ["dock", "undock"])
        self.assertIsNone(lv["held"])
        self.assertLess(lv["gone"], 8)
        self.assertEqual(kinds[2:], ["dock"])                     # back in only after clearing the berth
        self.assertEqual(lv["dock"], "d1")

    def test_models(self):
        for m in self.o["models"]:
            self.assertEqual(m["name"], m["kind"])
            self.assertTrue(m["anchors"])
            self.assertLess(m["meshes"], 40)
            self.assertLess(m["tris"], 6000)
            self.assertGreater(m["size"][2], 2.5)
            self.assertLess(m["size"][2], 5.5)
            self.assertLess(m["minY"], 0)                          # the hull sits in the water
        row, jet = self.o["models"]
        self.assertNotEqual(row["oar"], 0)
        self.assertAlmostEqual(jet["steer"], 0.4, delta=1e-6)

    def test_frame_rate_rule(self):
        for f in ("hqboat.js", "ocean.js"):
            with open(os.path.join(ROOT, "games", f), encoding="utf-8") as fh:
                src = fh.read()
            self.assertIsNone(re.search(r"Math\.min\(\s*1\s*,\s*dt\s*\*", src), f)
            self.assertIsNone(re.search(r"Math\.random\(", src), f)


HIRE_HARNESS = r"""
import fs from "fs";
const root = process.argv[1], doc = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const THREE = await import(root + "/games/vendor/three-module.js");
globalThis.window = {HQV: {}};
for (const f of ["world", "ocean", "hqboat"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const B = window.HQV.hqboat, WD = window.HQV.world, W = WD.pack(doc), out = {};
out.kinds = {KINDS: B.KINDS, HIRE: B.HIRE_KINDS, ALL: B.ALL_KINDS, hire: B.ALL_KINDS.map(k => [k, !!B.VEHICLES[k].hire, !!B.VEHICLES[k].boat])};
out.top = ["pedalo", "kayak"].map(k => { const st = B.newState(k, 0, 0, 0); for (let i = 0; i < 60*90; i++) B.step(st, {thr: 1}, 1/60, {}); return [k, st.speed, B.VEHICLES[k].top]; });
out.hireKinds = {marinaHire: B.hireKinds(W, "pier:4"), lakeHire: B.hireKinds(W, "pier:7"), fuel: B.hireKinds(W, "pier:5"), bus: B.hireKinds(W, "pier:0"), none: B.hireKinds(W, "pier:99")};
out.refuse = [B.hire(W, "pier:7", "jetski").reason, B.hire(W, "pier:99", "rowboat").reason, B.hire(W, "pier:0", "rowboat").reason, B.hire(null, "pier:7", "rowboat").reason];
// the fence: a hired boat full ahead into every shore of its lake, at 30 and 120 Hz; never outside the lake
function lake(kind, hz, heading){
  const h = B.hire(W, "pier:7", kind), st = h.st, sea = h.sea, body = B.water(W).bodies.filter(b => b.id === "lake:0")[0];
  st.yaw = heading; let out = 0, beached = false, ev = [];
  for (let i = 0; i < hz*80; i++) {
    B.step(st, {thr: 1, steer: (Math.floor(i/hz/7) % 3) - 1}, 1/hz, sea).forEach(e => ev.push(e.type));
    if (!B.inBody(body, st.x, st.z)) out++;
    const V = B.VEHICLES[st.kind], bx = st.x + Math.sin(st.yaw)*V.len/2, bz = st.z + Math.cos(st.yaw)*V.len/2;
    if (!B.inBody(body, bx, bz) && Math.abs(st.speed) > 0.5) out++;      // under way (a turn at the bank may swing the bow over it)
    beached = beached || st.beached;
  }
  return {ok: h.ok, kind: h.kind, body: h.body, out, beached, beaches: ev.filter(e => e === "beach").length, x: st.x, z: st.z, y: st.y};
}
out.fence = [];
for (const k of ["pedalo", "rowboat", "kayak"]) for (const hz of [30, 120]) for (const hd of [0, 1.3, 2.6, 4.0, 5.2]) out.fence.push([k, hz, hd, lake(k, hz, hd)]);
// a canal boat stops at the marina's mouth (the canal is its body), and its sea floats it at the canal's level
(function(){
  const sea = B.bodySea(W, "canal:0"), st = B.newState("kayak", 80, 0, Math.PI/2), body = B.water(W).bodies.filter(b => b.id === "canal:0")[0];
  for (let i = 0; i < 60*60; i++) B.step(st, {thr: 1}, 1/60, sea);
  out.canal = {x: st.x, beached: st.beached, inside: B.inBody(body, st.x, st.z), y: sea.y, kind: sea.kind, docks: sea.docks.map(d => d.id)};
})();
// the jet ski at the marina's hire jetty and its fuel jetty
out.jet = ["pier:4", "pier:5"].map(j => { const h = B.hire(W, j, "jetski"); return [j, h.ok, h.body, h.ok && !h.sea.land(h.st.x, h.st.z)]; });
// returning at a jetty with E: at it (moored or slow and close), not out on the water
(function(){
  const h = B.hire(W, "pier:7", "rowboat"), st = h.st, sea = h.sea, r = {};
  r.atStart = B.returnAt(W, st, sea);
  st.dock = null; st.left = "pier:7";
  for (let i = 0; i < 60*12; i++) B.step(st, {thr: -0.6}, 1/60, sea);
  r.away = Math.hypot(st.x - sea.docks.filter(d => d.id === "pier:7")[0].x, st.z - sea.docks.filter(d => d.id === "pier:7")[0].z);
  r.far = B.returnAt(W, st, sea);
  const lp = sea.docks.filter(d => d.id === "pier:6")[0];
  st.x = lp.x + 3; st.z = lp.z; st.speed = 0.3; st.dock = null;
  r.near = B.returnAt(W, st, sea);
  st.speed = 2.5; r.tooFast = B.returnAt(W, st, sea);
  st.dock = "pier:7"; r.moored = B.returnAt(W, st, sea);
  out.ret = r;
})();
// calm water: a ripple of a few cm, less under Calm
(function(){
  let calm = false; const sea = B.bodySea(W, "lake:0", {calm: () => calm}), a = [], b = [];
  for (let t = 0; t < 20; t += 0.25) a.push(sea.surface(-100, -180, t) - sea.y);
  calm = true; for (let t = 0; t < 20; t += 0.25) b.push(sea.surface(-100, -180, t) - sea.y);
  out.ripple = {free: Math.max(...a.map(Math.abs)), calm: Math.max(...b.map(Math.abs)), y: sea.y, lakeY: B.water(W).bodies.filter(x => x.id === "lake:0")[0].y};
})();
// the models: anchors for the rider, the right size, the wheel and the paddle move (less under Calm)
const c = {THREE, mat: (col, o) => new THREE.MeshStandardMaterial(Object.assign({color: col}, o || {}))};
out.models = ["pedalo", "kayak"].map(k => {
  const M = B.model(c, k, 0x3366aa, 0xffffff), bb = new THREE.Box3().setFromObject(M.g), sz = bb.getSize(new THREE.Vector3());
  let meshes = 0; M.g.traverse(o => { if (o.isMesh) meshes++; });
  B.animate(M, {steer: 0}, {thr: 1}, 0.2, false);
  const free = M.paddle ? Math.abs(M.paddle.rotation.z) + Math.abs(M.paddle.rotation.y) : M.wheel.rotation.x;
  const M2 = B.model(c, k, 0x3366aa, 0xffffff); B.animate(M2, {steer: 0}, {thr: 1}, 0.2, true);
  const calm = M2.paddle ? Math.abs(M2.paddle.rotation.z) + Math.abs(M2.paddle.rotation.y) : M2.wheel.rotation.x;
  return {kind: k, name: M.g.name, size: [sz.x, sz.y, sz.z], minY: bb.min.y, meshes, anchors: !!(M.seat && M.grips[0] && M.grips[1] && M.feet[0] && M.feet[1]), free, calm};
});
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class HireTest(unittest.TestCase):
    """HQ 3.15 boat hire (plan 3.8): the pedalo and the kayak beside the rowboat, the jet ski only at the marina, the
    body polygon as the fence, return at any jetty."""

    @classmethod
    def setUpClass(cls):
        import sys
        import tempfile
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from water_fixture import synthetic_doc
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
            json.dump(synthetic_doc(), fh)
            path = fh.name
        try:
            r = subprocess.run([NODE, "--input-type=module", "-e", HIRE_HARNESS, ROOT, path], capture_output=True, text=True, timeout=300)
        finally:
            os.unlink(path)
        if r.returncode != 0:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_kinds(self):
        k = self.o["kinds"]
        self.assertEqual(k["KINDS"], ["rowboat", "jetski"])          # the sea docks keep their two boats
        self.assertEqual(k["HIRE"], ["pedalo", "rowboat", "kayak"])
        for kind, hire, boat in k["hire"]:
            self.assertTrue(boat, kind)
            self.assertEqual(hire, kind != "jetski", kind)
        for kind, v, top in self.o["top"]:
            self.assertAlmostEqual(v, top, delta=0.01 * top, msg=kind)

    def test_what_each_jetty_hires(self):
        h = self.o["hireKinds"]
        self.assertEqual(h["marinaHire"], ["pedalo", "rowboat", "kayak", "jetski"])
        self.assertEqual(h["lakeHire"], ["pedalo", "rowboat", "kayak"])
        self.assertEqual(h["fuel"], ["jetski"])
        self.assertEqual(h["bus"], [])
        self.assertEqual(h["none"], [])
        self.assertEqual(self.o["refuse"], ["kind", "no-jetty", "kind", "no-water"])
        for j, ok, body, wet in self.o["jet"]:
            self.assertTrue(ok, j)
            self.assertEqual(body, "marina:0")
            self.assertTrue(wet)

    def test_lake_boats_stay_in_the_lake(self):
        hit = 0
        for kind, hz, hd, r in self.o["fence"]:
            self.assertTrue(r["ok"])
            self.assertEqual(r["kind"], kind)
            self.assertEqual(r["body"], "lake:0")
            self.assertEqual(r["out"], 0, (kind, hz, hd))
            hit += r["beaches"]
        self.assertGreater(hit, 10)                                     # they do run into the shore (and stop there)
        c = self.o["canal"]
        self.assertTrue(c["inside"])
        self.assertTrue(c["beached"])
        self.assertLess(c["x"], 100)                                    # the marina starts at x = 100: not for a canal boat
        self.assertEqual(c["kind"], "canal")
        self.assertIn("pier:0", c["docks"])

    def test_return_at_a_jetty(self):
        r = self.o["ret"]
        self.assertIsNotNone(r["atStart"])
        self.assertGreater(r["away"], 10)
        self.assertIsNone(r["far"])
        self.assertEqual(r["near"]["id"], "pier:6")                     # any jetty of the lake, not only where you hired
        self.assertIsNone(r["tooFast"])
        self.assertEqual(r["moored"]["id"], "pier:7")
        for k in ("x", "y", "z", "yaw"):
            self.assertIn(k, r["near"])

    def test_calm_lake_water(self):
        rp = self.o["ripple"]
        self.assertAlmostEqual(rp["y"], rp["lakeY"], places=6)
        self.assertGreater(rp["free"], 0.005)
        self.assertLess(rp["free"], 0.05)
        self.assertLess(rp["calm"], rp["free"] * 0.5)

    def test_new_models(self):
        for m in self.o["models"]:
            self.assertEqual(m["name"], m["kind"])
            self.assertTrue(m["anchors"])
            self.assertLess(m["meshes"], 40)
            self.assertGreater(m["size"][2], 2.4)
            self.assertLess(m["size"][2], 5.0)
            self.assertLess(m["minY"], 0)
            self.assertGreater(m["free"], 0)
            self.assertLess(m["calm"], m["free"])                       # Calm: a smaller, slower stroke


if __name__ == "__main__":
    unittest.main()
