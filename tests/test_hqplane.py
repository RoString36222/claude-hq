"""Pilotable planes (games/hqplane.js, HQ 3.2): the seaplane and the prop plane.

hqplane.js's physics is pure, so node runs scripted flights against a stub `window` and the Python side checks them:
the takeoff roll and lift-off past vr, the climb, the top speed, level flight holding its height when the keys are
let go (assisted), the bank limit and wings levelling, coordinated turns, a gentle stall (the nose drops, no crash),
ground effect, landings (runway, any flat ground under the soft limit, water for the seaplane) and crashes (hard,
gear up, the prop plane on water, a wall), the same flight at 30 and 120 Hz, the autopilot holding height and turning
to a heading, and the models from the hq3d ctx with the vendored three.js. Skipped when node is not installed."""
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
for (const f of ["hqships", "hqaircraft", "hqplane"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const P = window.HQV.hqplane, out = {};
// a long runway at y 0 along +z; water everywhere x > 200 (for the seaplane), at y 0
const land = {floor: () => 0, water: (x) => x > 200, waterY: () => 0, runway: (x, z) => Math.abs(x) < 15};
const sea = {floor: () => -5, water: () => true, waterY: () => 0, runway: () => false};
function fly(kind, hz, secs, inputs, env, x, y, z, yaw, setup){
  var st = P.newState(kind, x || 0, y || 0, z || 0, yaw || 0), dt = 1/hz, n = Math.round(secs*hz), path = [], ev = [];
  if(setup) setup(st);
  for(var i = 0; i < n; i++){
    var t = i*dt;
    P.step(st, inputs(t, st), dt, env || land).forEach(function(e){ ev.push([Math.round((t + dt)*100)/100, e.type, e.why || e.hard || false]); });
    if((i + 1) %% hz === 0) path.push([st.x, st.y, st.z, st.yaw, st.speed, st.pitch, st.roll, st.ground]);
    if(st.crashed) break;
  }
  return {st: st, path: path, ev: ev};
}
function airborne(st, y, s){ st.ground = false; st.y = y; st.speed = s; st.thr = 0.7; st.rpm = 0.7; st.cmd = 0.05; st.pitch = 0.05; }
// full throttle down the runway; Up at 6 s
var to = fly("prop", 60, 30, (t) => ({thr: 1, pitch: t > 6 && t < 22 ? 1 : 0}));
out.takeoff = {ev: to.ev, end: to.st, path: to.path};
out.takeoff30 = fly("prop", 30, 30, (t) => ({thr: 1, pitch: t > 6 && t < 22 ? 1 : 0})).st;
out.takeoff120 = fly("prop", 120, 30, (t) => ({thr: 1, pitch: t > 6 && t < 22 ? 1 : 0})).st;
// assisted lift-off with no Up at all (it rotates by itself)
out.autoRotate = fly("prop", 60, 25, () => ({thr: 1})).ev;
// level flight: 300 m, keys let go, cruise power
out.level = fly("prop", 60, 30, () => ({}), land, 0, 300, 0, 0, (st) => airborne(st, 300, 45)).path;
out.top = fly("prop", 60, 90, () => ({thr: 1}), land, 0, 400, 0, 0, (st) => { airborne(st, 400, 40); st.gearUp = true; st.gear = 0; }).st.speed;
// bank: A held 4 s then let go
var bank = fly("prop", 60, 10, (t) => ({roll: t < 4 ? 1 : 0}), land, 0, 300, 0, 0, (st) => airborne(st, 300, 45));
out.bank = bank.path;
// manual: A held rolls past the assisted limit
out.manual = fly("prop", 60, 3, () => ({roll: 1, assist: false}), land, 0, 300, 0, 0, (st) => airborne(st, 300, 45)).path;
// stall: power off, nose held up, manual (assisted would not let it stall: it keeps 1.15 stall speed)
var stall = fly("prop", 60, 40, (t) => ({thr: -1, pitch: t < 20 ? 1 : 0, assist: false}), land, 0, 600, 0, 0, (st) => airborne(st, 600, 40));
out.protect = fly("prop", 60, 40, (t) => ({thr: -1, pitch: 1}), land, 0, 600, 0, 0, (st) => airborne(st, 600, 40)).path.map((p) => p[4]);
out.stall = {ev: stall.ev, path: stall.path, crashed: stall.st.crashed};
// landings
out.landRunway = fly("prop", 60, 60, () => ({thr: -1}), land, 0, 30, 0, 0, (st) => airborne(st, 30, 30));
out.landRough = fly("prop", 60, 60, () => ({thr: -1}), {floor: () => 0, water: () => false, waterY: () => 0, runway: () => false}, 0, 30, 0, 0, (st) => airborne(st, 30, 30));
out.gearUp = fly("prop", 60, 60, () => ({thr: -1}), land, 0, 30, 0, 0, (st) => { airborne(st, 30, 30); st.gearUp = true; st.gear = 0; });
out.dive = fly("prop", 60, 30, () => ({thr: 1, pitch: -1}), land, 0, 200, 0, 0, (st) => airborne(st, 200, 50));
out.propWater = fly("prop", 60, 60, () => ({thr: -1}), sea, 0, 30, 0, 0, (st) => airborne(st, 30, 30));
out.seaLand = fly("seaplane", 60, 60, () => ({thr: -1}), sea, 0, 30, 0, 0, (st) => airborne(st, 30, 34));
out.seaTakeoff = fly("seaplane", 60, 40, () => ({thr: 1}), sea).ev;
out.wall = fly("prop", 60, 20, () => ({}), {floor: (x, z) => z > 300 ? 120 : 0, water: () => false, waterY: () => 0, runway: () => true}, 0, 60, 0, 0, (st) => airborne(st, 60, 45));
// brakes: rolling at 20 m/s on the runway, idle, Space
out.brake = fly("prop", 60, 8, () => ({brake: true}), land, 0, 0, 0, 0, (st) => { st.speed = 20; }).st.speed;
// autopilot: hold 350 m and turn to heading PI/2 from 300 m heading 0
var ap = fly("prop", 60, 60, (t, st) => Object.assign({thr: 0}, P.autopilot(st, {alt: 350, hdg: Math.PI/2})), land, 0, 300, 0, 0, (st) => { airborne(st, 300, 45); st.thr = 0.75; });
out.ap = {y: ap.st.y, yaw: ap.st.yaw, crashed: ap.st.crashed};
// the airliners (HQ 3.6): full thrust down the runway, Up held from 5 s (it may lift off only past vr); the same off
// any runway (it never lifts off: "norunway"); the jets' spool against the prop's; the gear by itself; exits
const offRw = {floor: () => 0, water: () => false, waterY: () => 0, runway: () => false};
out.jets = {};
["regional", "airliner"].forEach((k) => {
  var o = out.jets[k] = {}, V = P.VEHICLES[k];
  var tk = fly(k, 60, 70, (t) => ({thr: 1, pitch: t > 5 && t < 45 ? 1 : 0}));
  var lift = tk.ev.find((e) => e[1] === "takeoff");
  o.takeoff = {ev: tk.ev, end: tk.st, t: lift ? lift[0] : null};
  // the speed and the distance at lift-off (60 Hz, Up held: the first sub-step past vr)
  var st = P.newState(k, 0, 0, 0, 0), at = null;
  for(var i = 0; i < 60*60 && !at; i++) P.step(st, {thr: 1, pitch: i > 300 ? 1 : 0}, 1/60, land).forEach((e) => { if(e.type === "takeoff") at = {v: st.speed, z: st.z}; });
  o.liftoff = at; o.vr = V.vr;
  var off = fly(k, 60, 60, (t) => ({thr: 1, pitch: t > 5 ? 1 : 0}), offRw);
  o.offRunway = {ev: off.ev, ground: off.st.ground, speed: off.st.speed};
  // spool: the throttle already open (thr 1), the engine at idle: rpm after 1 and 3 s
  var sp = P.newState(k, 0, 0, 0, 0); sp.thr = 1; var r = [];
  for(var j = 0; j < 180; j++){ P.step(sp, {brake: true}, 1/60, land); if(j === 59 || j === 179) r.push(sp.rpm); }
  o.spool = r;
  // the gear: on the ground it will not come up; in the air G toggles it (and takes it over from auto)
  var g = P.newState(k, 0, 0, 0, 0); o.gearGround = P.toggleGear(g);
  airborne(g, 300, 80); o.gearAir = [P.toggleGear(g), g.gearMan, P.toggleGear(g), g.gearUp];
  // auto gear, assisted: up after the climb-out, down again on the way in (a descent from 400 m at idle)
  o.autoUp = tk.ev.filter((e) => e[1] === "gear").map((e) => e[0]);
  var dn = fly(k, 60, 120, (t, s) => ({thr: -1, pitch: -0.3}), land, 0, 400, 0, 0, (s) => { airborne(s, 400, 85); s.gearUp = true; s.gear = 0; });
  o.autoDown = {ev: dn.ev, gear: dn.st.gear};
  // landing: on the runway (fine), on flat ground off it (a crash: an airliner lands on runways only)
  o.landRw = fly(k, 60, 90, () => ({thr: -1}), land, 0, 30, 0, 0, (s) => { airborne(s, 30, V.stall*1.1); s.flaps = 2; }).st;
  o.landOff = fly(k, 60, 90, () => ({thr: -1}), offRw, 0, 30, 0, 0, (s) => { airborne(s, 30, V.stall*1.1); s.flaps = 2; }).st;
  // the ground spoilers: out at idle once rolling
  o.spoil = fly(k, 60, 2, () => ({}), land, 0, 0, 0, 0, (s) => { s.speed = 40; s.thr = 0; }).st.spoil;
  // getting out: never airborne; on the ground only stopped and at a stand
  var e1 = P.newState(k, 0, 0, 0, 0); airborne(e1, 50, 70); var e2 = P.newState(k, 0, 0, 0, 0), e3 = P.newState(k, 0, 0, 0, 0); e3.speed = 10;
  o.exit = {air: P.canExit(e1, true), stand: P.canExit(e2, true), apronless: P.canExit(e2, false), rolling: P.canExit(e3, true)};
  o.exitSpot = P.exitSpot({kind: k, x: 0, z: 0, yaw: 0});
  // the autopilot holds 600 m
  var ap2 = fly(k, 60, 60, (t, s) => Object.assign({thr: 0}, P.autopilot(s, {alt: 600, hdg: 0})), land, 0, 560, 0, 0, (s) => { airborne(s, 560, 90); s.thr = 0.8; s.rpm = 0.8; s.gearUp = true; s.gear = 0; });
  o.ap = {y: ap2.st.y, crashed: ap2.st.crashed};
});
out.propExit = P.canExit(P.newState("prop", 0, 0, 0, 0), false);
var pp = P.newState("prop", 0, 0, 0, 0); pp.thr = 1; for(var q = 0; q < 60; q++) P.step(pp, {brake: true}, 1/60, land); out.propSpool = pp.rpm;
out.floats = P.toggleGear(P.newState("seaplane", 0, 0, 0, 0));
// an island's regional jet stand: flat land everywhere but a strip of sea at x > 120 (runway along +z from the origin)
out.beside = P.standBeside([0, 0], [0, 1], 0, {x: -30, z: 20}, (x, z) => x > 120 ? null : 0);
out.besideNone = P.standBeside([0, 0], [0, 1], 0, null, () => null);
// the models
const c = {THREE, mat: (col, o) => new THREE.MeshStandardMaterial(Object.assign({color: col}, o || {}))};
out.models = ["seaplane", "prop", "airliner", "regional"].map((k) => { const B = P.model(c, k); P.animate(B, P.newState(k), 1/60, true); let n = 0; B.g.traverse((o) => { if(o.isMesh || o.isPoints) n++; });
  const box = new THREE.Box3().setFromObject(B.g); return {k, draws: n, seat: !!B.seat, minY: box.min.y, len: box.max.z - box.min.z, span: box.max.x - box.min.x}; });
process.stdout.write(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
class HqPlane(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "--input-type=module", "-"], input=HARNESS % {"root": json.dumps(ROOT)},
                           capture_output=True, text=True, timeout=120)
        if r.returncode:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout)

    def types(self, ev):
        return [e[1] for e in ev]

    def test_takeoff_past_rotation_speed(self):
        t = self.o["takeoff"]
        self.assertIn("takeoff", self.types(t["ev"]))
        self.assertNotIn("crash", self.types(t["ev"]))
        self.assertGreater(t["end"]["y"], 80)                 # climbing away
        self.assertFalse(t["end"]["ground"])
        # it does not leave the ground before Up at 6 s (below vr it could not anyway)
        self.assertGreater(next(e[0] for e in t["ev"] if e[1] == "takeoff"), 6)

    def test_assisted_rotates_by_itself(self):
        self.assertIn("takeoff", self.types(self.o["autoRotate"]))

    def test_frame_rate_independent(self):
        a, b = self.o["takeoff30"], self.o["takeoff120"]
        for k in ("x", "y", "z", "speed"):
            self.assertAlmostEqual(a[k], b[k], delta=max(0.5, abs(b[k])*0.01), msg=k)

    def test_level_flight_holds_height(self):
        ys = [p[1] for p in self.o["level"]]
        self.assertLess(max(ys) - min(ys), 25)
        self.assertLess(abs(ys[-1] - ys[-6]), 6)              # settled

    def test_top_speed(self):
        self.assertAlmostEqual(self.o["top"], 66, delta=4)

    def test_bank_limit_and_level(self):
        rolls = [p[6] for p in self.o["bank"]]
        self.assertLess(min(rolls), -0.6)                     # A banks left (left side down)
        self.assertGreater(min(rolls), -0.72)                 # never past the assisted limit
        self.assertLess(abs(rolls[-1]), 0.05)                 # level again once let go
        yaws = [p[3] for p in self.o["bank"]]
        self.assertGreater(yaws[3], 0.3)                      # turned left
        self.assertGreater(max(abs(r[6]) for r in self.o["manual"]), 1.5)   # manual rolls on, past the assisted limit

    def test_gentle_stall(self):
        s = self.o["stall"]
        self.assertIn("stall", self.types(s["ev"]))
        self.assertIsNone(s["crashed"])
        pitches = [p[5] for p in s["path"]]
        self.assertLess(min(pitches[5:25]), 0)                # the nose drops even with Up held
        # assisted: Up held with the power off never gets it much under stall speed (21 m/s)
        self.assertGreater(min(self.o["protect"][5:]), 21*0.95)

    def test_landings(self):
        self.assertIn("land", self.types(self.o["landRunway"]["ev"]))
        self.assertIsNone(self.o["landRunway"]["st"]["crashed"])
        self.assertIn("land", self.types(self.o["landRough"]["ev"]))      # flat ground, slow enough: forgiving
        self.assertIn("land", self.types(self.o["seaLand"]["ev"]))
        self.assertTrue(self.o["seaLand"]["st"]["water"])
        self.assertIn("takeoff", self.types(self.o["seaTakeoff"]))

    def test_crashes(self):
        self.assertEqual(self.o["gearUp"]["st"]["crashed"], "gear")
        self.assertEqual(self.o["propWater"]["st"]["crashed"], "water")
        self.assertEqual(self.o["dive"]["st"]["crashed"], "hard")
        self.assertEqual(self.o["wall"]["st"]["crashed"], "wall")

    def test_brakes(self):
        self.assertLess(self.o["brake"], 1)

    def test_autopilot(self):
        ap = self.o["ap"]
        self.assertIsNone(ap["crashed"])
        self.assertAlmostEqual(ap["y"], 350, delta=25)
        self.assertAlmostEqual(math.atan2(math.sin(ap["yaw"] - math.pi/2), math.cos(ap["yaw"] - math.pi/2)), 0, delta=0.08)

    def test_models(self):
        for m in self.o["models"]:
            self.assertTrue(m["seat"])
            self.assertLess(m["draws"], 16, m)                 # merged by material
            self.assertGreater(m["minY"], -0.05, m)            # nothing below the surface it stands on
        sp, pp, al, rj = self.o["models"]
        self.assertAlmostEqual(sp["span"], 20, delta=1.5)
        self.assertAlmostEqual(pp["span"], 10.6, delta=0.8)
        self.assertAlmostEqual(al["span"], 36, delta=1)        # hqaircraft's airliner, full size
        self.assertAlmostEqual(al["len"], 38, delta=1.5)
        self.assertAlmostEqual(rj["span"], 36*0.72, delta=1)   # the regional jet: the same at 0.72


@unittest.skipUnless(NODE, "node is not installed")
class HqAirliner(unittest.TestCase):
    """HQ 3.6: the airliners you fly (the narrow-body and the regional jet)."""
    @classmethod
    def setUpClass(cls):
        cls.o = HqPlane.o if hasattr(HqPlane, "o") else None
        if cls.o is None:
            HqPlane.setUpClass(); cls.o = HqPlane.o

    def test_takeoff_only_past_rotation_speed_on_a_runway(self):
        for k, j in self.o["jets"].items():
            self.assertIsNotNone(j["takeoff"]["t"], k)
            self.assertGreater(j["takeoff"]["t"], 12, k)                       # a long roll: Up from 5 s does nothing yet
            self.assertGreaterEqual(j["liftoff"]["v"], j["vr"] - 0.01, k)     # never under vr
            self.assertGreater(j["liftoff"]["z"], 250, k)                     # hundreds of metres of runway
            self.assertLess(j["liftoff"]["z"], 520 if k == "regional" else 800, k)   # (the regional fits an island's 500 m)
            self.assertNotIn("crash", [e[1] for e in j["takeoff"]["ev"]], k)
            self.assertFalse(j["takeoff"]["end"]["ground"], k)
            self.assertGreater(j["takeoff"]["end"]["y"], 150, k)               # climbing away
            # off a runway: it rolls past vr and never lifts off
            self.assertNotIn("takeoff", [e[1] for e in j["offRunway"]["ev"]], k)
            self.assertIn("norunway", [e[1] for e in j["offRunway"]["ev"]], k)
            self.assertTrue(j["offRunway"]["ground"], k)

    def test_jet_spool_lag(self):
        self.assertGreater(self.o["propSpool"], 0.85)                        # the prop: there in a second
        for k, j in self.o["jets"].items():
            self.assertLess(j["spool"][0], 0.6, k)                           # a jet: still spooling after 1 s
            self.assertGreater(j["spool"][1], j["spool"][0] + 0.15, k)        # ... and getting there
        self.assertLess(self.o["jets"]["airliner"]["spool"][0], self.o["jets"]["regional"]["spool"][0])

    def test_gear(self):
        self.assertEqual(self.o["floats"]["why"], "floats")
        for k, j in self.o["jets"].items():
            self.assertFalse(j["gearGround"]["ok"], k)
            self.assertEqual(j["gearGround"]["why"], "ground", k)
            up, man, down, still_up = j["gearAir"]
            self.assertTrue(up["ok"] and up["up"], k)
            self.assertTrue(man, k)                                          # G takes it over from auto
            self.assertFalse(down["up"], k)
            self.assertFalse(still_up, k)
            self.assertTrue(j["autoUp"], k)                                  # assisted: up by itself after the climb-out
            self.assertIn("gear", [e[1] for e in j["autoDown"]["ev"]], k)    # ... and down on the way in
            self.assertIsNone(j["landRw"]["crashed"], k)                      # landing on a runway with it down
            self.assertTrue(j["landRw"]["ground"], k)

    def test_runway_landings_only_and_spoilers(self):
        for k, j in self.o["jets"].items():
            self.assertEqual(j["landOff"]["crashed"], "rough", k)
            self.assertGreater(j["spoil"], 0.9, k)

    def test_cannot_exit_airborne_or_away_from_a_stand(self):
        self.assertTrue(self.o["propExit"])
        for k, j in self.o["jets"].items():
            e = j["exit"]
            self.assertFalse(e["air"], k)
            self.assertFalse(e["rolling"], k)
            self.assertFalse(e["apronless"], k)
            self.assertTrue(e["stand"], k)
            s = j["exitSpot"]                                                 # by the forward left door (+x is left)
            self.assertGreater(s["x"], 2.5, k)
            self.assertGreater(s["z"], 9, k)

    def test_autopilot(self):
        for k, j in self.o["jets"].items():
            self.assertIsNone(j["ap"]["crashed"], k)
            self.assertAlmostEqual(j["ap"]["y"], 600, delta=30, msg=k)

    def test_island_stand(self):
        b = self.o["beside"]
        self.assertIsNotNone(b)
        self.assertGreaterEqual(abs(b["x"]), 38)          # off the centreline: wingtips clear of the takeoff roll
        self.assertGreaterEqual(b["z"], 60)               # well past the airliners' stand behind the threshold
        self.assertGreater(b["x"], 0)                     # the prop plane's other side
        self.assertGreater(math.hypot(b["x"] + 30, b["z"] - 20), 30)
        self.assertAlmostEqual(math.sin(b["yaw"]), -1, delta=1e-6)   # facing the runway
        self.assertIsNone(self.o["besideNone"])


AF_HARNESS = r"""
var fs = require("fs"), zlib = require("zlib"), root = %(root)s;
global.window = {HQV: {}};
["world", "hqairfield", "hqplane"].forEach(function(f){ new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))(); });
var HQV = window.HQV, WD = HQV.world, AF = HQV.hqAirfield, P = HQV.hqplane, out = {};
var W = WD.pack(JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/claude-hq@2.json.gz"))));
var site = (W.sites || []).filter(function(s){ return s.kind === "airport"; })[0];
var L = AF.layout(W, site), RU = L.frame.RU;
out.stands = P.commonsStands(L, AF).map(function(q){
  var V = P.VEHICLES[q.kind], hl = V.len/2, hs = V.span/2, f = [Math.sin(q.yaw), Math.cos(q.yaw)], r = [f[1], -f[0]], pts = [];
  for(var a = -hl; a <= hl + 1e-6; a += hl/4) for(var b = -hs; b <= hs + 1e-6; b += hs/4) pts.push([q.x + f[0]*a + r[0]*b, q.z + f[1]*a + r[1]*b]);
  var fr = pts.map(function(p){ return AF.toFrame(L, p[0], p[1]); });
  return {kind: q.kind, x: q.x, z: q.z,
    onPlatform: pts.every(function(p){ return AF.floorAt(L, p[0], p[1]) != null; }),
    pave: pts.map(function(p){ return AF.onPavement(L, p[0], p[1]); }).filter(function(s){ return s === "runway" || s === "taxiway"; }).length,
    minRunwayGap: Math.min.apply(null, fr.map(function(p){ return p[0] - RU; })),                 // u from the centreline (seaward > 0)
    v: [Math.min.apply(null, fr.map(function(p){ return p[1]; })), Math.max.apply(null, fr.map(function(p){ return p[1]; }))],
    standBoxes: L.stands.filter(function(s){ return pts.some(function(p){ var u = AF.toFrame(L, p[0], p[1]); var bx = s.box.map(function(c){ return AF.toFrame(L, c[0], c[1]); });
      var us = bx.map(function(c){ return c[0]; }), vs = bx.map(function(c){ return c[1]; });
      return u[0] >= Math.min.apply(null, us) && u[0] <= Math.max.apply(null, us) && u[1] >= Math.min.apply(null, vs) && u[1] <= Math.max.apply(null, vs); }); }).length};
});
var E0 = L.runway.ends[0], pad = L.runway.pad;
out.prop = AF.toFrame(L, E0.thr[0] - E0.dir[0]*pad*0.55, E0.thr[1] - E0.dir[1]*pad*0.55);
out.RU = RU; out.half = L.runway.len/2; out.rwHalfW = L.runway.w/2 + L.runway.shoulder;
out.gs = L.runway.ends.map(function(e){ return AF.toFrame(L, e.glideslope[0], e.glideslope[1]); });
out.papi = L.runway.ends.map(function(e){ return e.papi.map(function(p){ return AF.toFrame(L, p[0], p[1]); }); });
out.ws = L.runway.ends.map(function(e){ return AF.toFrame(L, e.windsock[0], e.windsock[1]); });
process.stdout.write(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
class AirlinerStands(unittest.TestCase):
    """The Commons' airliner stands against the real airfield layout (claude-hq@2): on the platform, off every
    runway and taxiway, clear of the scheduled jets' stands, their roll on the runway and the prop plane's pad."""
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-"], input=AF_HARNESS % {"root": json.dumps(ROOT)}, capture_output=True, text=True, timeout=120)
        if r.returncode:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout)

    def test_clear(self):
        o = self.o
        self.assertEqual([s["kind"] for s in o["stands"]], ["airliner", "regional"])
        for s in o["stands"]:
            self.assertTrue(s["onPlatform"], s)
            self.assertEqual(s["pave"], 0, s)                          # nothing on the runway, its shoulders or a taxiway
            self.assertEqual(s["standBoxes"], 0, s)                    # nor on a passenger stand
            self.assertGreater(s["minRunwayGap"], o["rwHalfW"] - 1, s)  # seaward of the runway's shoulder
            self.assertGreater(s["minRunwayGap"], 18 + 10, s)           # > 10 m from a rolling jet's wingtip
            self.assertGreater(s["v"][0], -o["half"] + 20, s)           # inside the threshold: clear of the prop plane's pad
            self.assertGreater(s["v"][0], o["prop"][1] + 60, s)
            for gs in o["gs"] + o["ws"] + [p for e in o["papi"] for p in e]:   # the aerials, the PAPIs, the windsocks
                self.assertFalse(s["v"][0] - 10 < gs[1] < s["v"][1] + 10 and gs[0] > o["RU"], (s, gs))
        a, b = o["stands"]
        self.assertGreater(b["v"][0] - a["v"][1], 20)                  # the two stands apart


class FlyOnWiring(unittest.TestCase):
    """3.11.1: taking off spammed "Flying on to <someone>'s island…", rebuilt that City again and again and could
    swap you mid-air into a fallback Commons. The City now asks HQV.ocean.flyOn (tests/test_ocean.py checks its
    hysteresis); hq3d never swaps in a City built ahead that came back as another world; a Go to route to a plane
    ends when you board one."""
    def test_wiring(self):
        city = open(os.path.join(ROOT, "games", "hqcity3d.js"), encoding="utf-8").read()
        hq = open(os.path.join(ROOT, "games", "hq3d.js"), encoding="utf-8").read()
        self.assertIn("HQV.ocean.flyOn(flyS,", city)
        self.assertNotIn("heliGo", city)                                     # the old arm-on-every-frame state
        self.assertIn("if(!h){ flyS.go = null;", city)                       # landing / getting out disarms
        self.assertIn("c.cityFailed(G.world)", city)
        self.assertIn("!w.prebuilt) say(", city)                            # a City built ahead says nothing
        self.assertIn('route.kind === "plane" ||', city)
        self.assertIn('name: "city", prebuilt: true}', hq)
        self.assertIn("got.world() !== world){ nextFailed[world] = true; dropNext(); return; }", hq)
        self.assertIn("nextFailed[world]) return false;", hq)


if __name__ == "__main__":
    unittest.main()
