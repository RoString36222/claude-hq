"""The tank in the 3D City (games/hqtank.js, HQ 3.16): driven by one, its three other seats carpool seats.

node runs the pure parts of games/hqtank.js: driving (it pulls away gently, stops hard, turns on the spot, a wall
stops it and it can always drive out of one), where it fits when you call it, the gunner's aim and its presence form;
carpooling's games/hqdrive.js poolSeats / poolSeat with a tank (four seats, seat 1 the gunner's). It also runs
hq3d.js's peerBlocked: a driven tank is solid, someone riding in it is not. The shell (grenade kind 1) goes off on
whatever it touches. The rest reads the files: the wiring in games/hq3d.js and ui/app/22-hq.js, the model's named
seats, and that the page keeps to the Arena's bounds.
"""
import json
import math
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")


def read(*p):
    with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
        return f.read()


def func_body(src, name):
    m = re.search(r"function %s\([^)]*\)\s*\{" % re.escape(name), src)
    assert m, name
    i, depth = m.end(), 1
    while depth:
        depth += src[i] == "{"
        depth -= src[i] == "}"
        i += 1
    return src[m.start():i]


HQ3D = read("games", "hq3d.js")

NODE_HARNESS = r"""
var fs = require("fs"), root = %(root)s;
global.window = global; window.HQV = {};
["hqgrenade", "hqtank", "hqdrive"].forEach(function(f){ new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))(); });
var T = HQV.hqTank, H = HQV.hqGrenade, D = HQV.hqDrive, out = {loaded: !!T};
var open = {blocked: function(){ return false; }};
function drive(st, inp, secs, env){ for(var i = 0; i < Math.round(secs*60); i++) T.step(st, inp, 1/60, env || open); return st; }
var a = drive(T.newState(0, 0, 0), {fwd: 1}, 1), full = drive(T.newState(0, 0, 0), {fwd: 1}, 6);
out.go = {v1: a.speed, z1: a.z, x1: a.x, top: full.speed};
out.stop = drive(full, {}, 1).speed;
out.rev = drive(T.newState(0, 0, 0), {fwd: -1}, 4).speed;
var piv = drive(T.newState(0, 0, 0), {turn: 1}, 1); out.pivot = {yaw: piv.yaw, x: piv.x, z: piv.z, l: piv.trk[0], r: piv.trk[1]};
out.fastRate = drive(drive(T.newState(0, 0, 0), {fwd: 1}, 6), {fwd: 1, turn: 1}, 1).rate;
// a wall across z = 10: it stops there and says so; it can still back away
var wall = {blocked: function(x, z){ return z > 10; }}, bumps = [], w = T.newState(0, 0, 0);
for(var i = 0; i < 600; i++) T.step(w, {fwd: 1}, 1/60, wall).forEach(function(e){ bumps.push(e.type); });
out.wall = {z: w.z, speed: w.speed, bumps: bumps.length};
out.back = drive(w, {fwd: -1}, 1, wall).z;
// stuck inside something already (parked over a car): it may drive out
out.stuck = drive(T.newState(0, 0, 0), {fwd: 1}, 2, {blocked: function(x, z){ return Math.abs(x) < 1 && Math.abs(z) < 1; }}).z;
// where it fits beside you: your right first (-x facing +z), else your left
out.spot = [T.spot(0, 0, 0, open), T.spot(0, 0, 0, {blocked: function(x){ return x < -2; }}), T.spot(0, 0, 0, {blocked: function(){ return true; }})];
// carpooling with a tank: four seats, the gunner's (1) first, a lower id keeps a seat two take at once
out.pool = {seats: D.poolSeats("tank", null, null, null), first: D.poolSeat("me", "drv", [], 4, 0),
            next: D.poolSeat("me", "drv", [{u: "a", pb: "drv", ps: 1}], 4, 0),
            full: D.poolSeat("me", "drv", [{u: "a", pb: "drv", ps: 1}, {u: "b", pb: "drv", ps: 2}, {u: "c", pb: "drv", ps: 3}], 4, 0),
            tie: D.poolSeat("b", "drv", [{u: "a", pb: "drv", ps: 1}], 4, 1), keep: D.poolSeat("a", "drv", [{u: "b", pb: "drv", ps: 1}], 4, 1)};
out.ta = [T.taWire(Math.PI, 1), T.taWire(-0.5, -1), T.taFrom([90, 20]), T.taFrom([181, 0]), T.taFrom([0, 61]), T.taFrom([0, -16]), T.taFrom([0, -15]), T.taFrom([1.5, 0])];
out.aim = [T.aimFrom({x: 0, y: 0, z: 1}, 0), T.aimFrom({x: 1, y: 0, z: 0}, Math.PI/2), T.aimFrom({x: 0, y: 1, z: 0}, 0), T.aimFrom({x: 0, y: -1, z: 0}, 0)];
// the shell: off on the ground, on a wall, in water
var flat = {ground: function(){ return 0; }};
var sh = H.shot({k: 1, x: 0, y: 2, z: 0, vx: 0, vy: -1, vz: 38}), bs = H.advance(sh, flat, 4);
out.shell = {b: bs, n: sh.n, done: sh.done};
var wl = {ground: function(){ return 0; }, hit: function(a, b){ return (a.z < 20) !== (b.z < 20) ? 0.5 : 1; }};
out.shellWall = H.advance(H.shot({k: 1, x: 0, y: 2, z: 0, vx: 0, vy: 2, vz: 38}), wl, 4);
out.shellSea = H.advance(H.shot({k: 1, x: 0, y: 2, z: 0, vx: 0, vy: 0, vz: 38}), {ground: function(){ return -3; }, water: function(){ return 0; }}, 4);
out.K1 = H.KINDS[1];
process.stdout.write(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
class TankPure(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-"], input=NODE_HARNESS % {"root": json.dumps(ROOT)}, capture_output=True, text=True, timeout=60)
        if r.returncode:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout)

    def test_loads_without_three(self):
        self.assertTrue(self.o["loaded"])

    def test_drives_like_a_tank(self):
        go = self.o["go"]
        self.assertAlmostEqual(go["v1"], 3.5, delta=0.05)          # pulls away at 3.5 m/s²
        self.assertGreater(go["z1"], 1.5)                          # forward is +z at yaw 0
        self.assertAlmostEqual(go["x1"], 0, places=9)
        self.assertAlmostEqual(go["top"], 11, places=6)            # its top speed
        self.assertAlmostEqual(self.o["stop"], 3, delta=0.05)      # stops at 8 m/s² with no throttle
        self.assertAlmostEqual(self.o["rev"], -5, places=6)        # slower backwards
        pv = self.o["pivot"]
        self.assertGreater(pv["yaw"], 0.5)                         # A turns it left, on the spot
        self.assertAlmostEqual(pv["x"], 0, places=9)
        self.assertAlmostEqual(pv["z"], 0, places=9)
        self.assertLess(pv["l"], 0)                                # the treads run opposite ways
        self.assertGreater(pv["r"], 0)
        self.assertLess(self.o["fastRate"], 0.6)                   # turns slower at speed

    def test_a_wall_stops_it(self):
        w = self.o["wall"]
        self.assertLessEqual(w["z"], 10 - 3.3 + 0.2)               # its nose at the wall, not through it
        self.assertEqual(w["speed"], 0)
        self.assertGreaterEqual(w["bumps"], 1)
        self.assertLess(self.o["back"], w["z"])                    # and it backs away
        self.assertGreater(self.o["stuck"], 1)                     # already inside something: it can drive out

    def test_where_it_is_called_to(self):
        right, left, none = self.o["spot"]
        self.assertAlmostEqual(right["x"], -6, places=9)           # your right (facing +z, -x is your right)
        self.assertAlmostEqual(left["x"], 6, places=9)
        self.assertIsNone(none)

    def test_seats_are_carpool_seats(self):
        po = self.o["pool"]
        self.assertEqual(po["seats"], 4)                           # its driver, the gunner, two on the back
        self.assertEqual(po["first"], 1)                           # the first in is the gunner
        self.assertEqual(po["next"], 2)
        self.assertEqual(po["full"], 0)
        self.assertEqual(po["tie"], 2)                             # two at once: the lower id keeps the gunner's seat
        self.assertEqual(po["keep"], 1)

    def test_aim_form(self):
        ta = self.o["ta"]
        self.assertEqual(ta[0], [180, 40])                         # clamped to the barrel's reach
        self.assertEqual(ta[1], [round(-0.5*180/math.pi), -8])
        self.assertAlmostEqual(ta[2]["yaw"], math.pi/2)
        self.assertAlmostEqual(ta[2]["pitch"], 20*math.pi/180)
        self.assertEqual(ta[3:6], [None, None, None])
        self.assertAlmostEqual(ta[6]["pitch"], -8*math.pi/180)     # the Arena's -15 is still only -8 here
        self.assertIsNone(ta[7])

    def test_gunner_aim(self):
        ahead, side, up, down = self.o["aim"]
        self.assertAlmostEqual(ahead["yaw"], 0, places=9)
        self.assertAlmostEqual(ahead["pitch"], 0.3, places=9)      # lifted over the chase camera's look down
        self.assertAlmostEqual(side["yaw"], 0, places=9)           # relative to the hull
        self.assertAlmostEqual(up["pitch"], 40*math.pi/180, places=9)
        self.assertAlmostEqual(down["pitch"], -8*math.pi/180, places=9)

    def test_the_shell(self):
        s = self.o["shell"]
        self.assertTrue(s["done"])
        self.assertLess(s["n"], 60)                                # off on the ground long before its 4 s
        self.assertEqual(s["b"]["k"], 1)
        self.assertLess(self.o["shellWall"]["z"], 20)              # on the wall's face
        self.assertTrue(self.o["shellSea"]["wet"])
        K = self.o["K1"]
        self.assertTrue(K["impact"])
        self.assertGreater(K["blast"], 6)


@unittest.skipUnless(NODE, "node is not installed")
class TankIsSolid(unittest.TestCase):
    """hq3d.js peerBlocked: a driven tank (a = 14) blocks you along its whole hull; someone riding in it does not."""

    @classmethod
    def setUpClass(cls):
        fn = re.search(r"\n  function peerBlocked\(x, z\)\{.*?\n  \}\n", HQ3D, re.S).group(0)
        src = r"""
var scene = {}, cur = {scene: scene}, avatar = {g: {position: {y: 0}}};
var VEHICLES = {tank: {box: [1.7, 3.3]}};
var PEER_VEHICLE = {14: "tank"};
function peer(x, z, a, o){ var P = {g: {parent: scene}, x: x, z: z, yaw: 0, a: a, hy: 0}; for(var k in o || {}) P[k] = o[k]; return P; }
var peers = {};
""" + fn + r"""
var out = {};
peers = {t: peer(0, 0, 14)};
out.tank = [peerBlocked(0, 3.4), peerBlocked(1.8, 0), peerBlocked(0, 3.6), peerBlocked(2, 0)];
peers = {s: peer(0, 0, 0, {pb: "t", ps: 1})}; out.riding = peerBlocked(0, 0);
process.stdout.write(JSON.stringify(out));
"""
        r = subprocess.run([NODE, "-e", src], capture_output=True, text=True, timeout=60)
        if r.returncode:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout)

    def test_hull_blocks_and_passengers_do_not(self):
        self.assertEqual(self.o["tank"], [True, True, False, False])
        self.assertFalse(self.o["riding"])


class TankWiring(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.hq = HQ3D
        cls.ui = read("ui", "app", "22-hq.js")
        cls.rs = read("backend", "src", "valley", "hq.rs")
        cls.proto = read("backend", "src", "protocol.rs")
        cls.mod = read("games", "hqtank.js")
        cls.drive = read("games", "hqdrive.js")

    def test_keys(self):
        self.assertIn('if(e.code === "KeyK" && !ride && !POOL.u && inst.running && tkOk() && !typing(e.target)', self.hq)
        self.assertIn("if(e.type === \"keydown\" && !e.repeat) tankSummon(); return;", self.hq)
        self.assertIn("if(!ride && nearTank()){ mountTank(); return true; }", func_body(self.hq, "useKey"))
        self.assertIn("if(e.button === 0 && !tkFire()) gnFire();", func_body(self.hq, "onDown"))
        self.assertIn('if(e.code === "KeyX") gnToggle(); else if(!tkFire()) gnFire();', self.hq)

    def test_driving(self):
        mv = func_body(self.hq, "moveAvatar")
        self.assertIn("if(ride){ if(ride.tank) tankMove(dt);", mv)
        self.assertIn("if(ride.tank){ dismountTank(force); return; }", func_body(self.hq, "dismount"))
        self.assertIn("placePeers(dt, t);\n    tankFrame(dt);", func_body(self.hq, "frame"))
        self.assertIn("return ride ? (ride.tank ? 14 :", self.hq)
        self.assertIn('vehicle: "tank"', func_body(self.hq, "rigTarget"))

    def test_seats_ride_on_carpool(self):
        self.assertIn('if(base === "tank") return 4;', self.drive)
        self.assertIn('if(vk === "tank") return HQV.hqTank ?', func_body(self.hq, "poolKind"))
        self.assertIn('k.base === "tank" ? HQV.hqTank.REACH', func_body(self.hq, "poolNear"))
        self.assertIn("ride.tank", func_body(self.hq, "poolDraw"))               # your own tank's passengers
        self.assertIn("var offs = tank ?", func_body(self.hq, "poolOff"))        # out clear of its hull
        self.assertIn('if(i) o.name = "a-seat-" + i;', self.mod)                # carpool's poolSpot finds its seats
        self.assertIn("var D = POOL.u && POOL.seat === 1 ? peers[POOL.u] : null; return !!(D && D.a === 14);", func_body(self.hq, "tkGunner"))
        self.assertIn("Q.pb === u && Q.ps === 1", func_body(self.hq, "tkGunnerOf"))
        for gone in ("TK.seat", "seatPeers", "tsFrom", "sbFrom"):
            self.assertNotIn(gone, self.hq)

    def test_the_driver_has_the_turret_while_nobody_is_gunner(self):
        self.assertIn("return !!(ride && ride.tank && tkGunnerOf(cvMe()) == null);", func_body(self.hq, "tkDriverGuns"))
        fire = func_body(self.hq, "tkFire")
        self.assertLess(fire.index("if(tkGunner())"), fire.index("else if(tkDriverGuns()){ top = avatar.g; B = ride.B; }"))
        self.assertIn("else return false;", fire)
        tf = func_body(self.hq, "tankFrame")
        self.assertIn("if(!G){ f0 = new THREE.Vector3(); curCam().getWorldDirection(f0); TK.aim = TKm.aimFrom(", tf)
        self.assertIn('var tkF = e.code === "KeyF" && (tkGunner() || tkDriverGuns());', self.hq)
        self.assertIn("&& (!ride || tkF) &&", self.hq)                              # F works in the tank; X does not
        self.assertIn("P.ta || {yaw: 0, pitch: 0};   // its gunner's, else its driver's", self.hq)

    def test_blasts_never_move_a_tank(self):
        kn = func_body(self.hq, "gnKnock")
        self.assertIn("ride.tank ||", kn)
        self.assertIn("if(POOL.u ||", kn)
        self.assertIn("!POOL.u", func_body(self.hq, "gnCan"))

    def test_presence(self):
        self.assertIn('if(a===14 && !hqNetCan("tank")) a = 0;', self.ui)
        self.assertIn('var tk = hqNetCan("tank") && (msg.pb || a===14) && HQ3D.inst.tankNet ? HQ3D.inst.tankNet() : null;', self.ui)
        self.assertIn("JSON.stringify(msg.gn||0),JSON.stringify(msg.ta||0)].join", self.ui)
        self.assertLess(self.ui.index("msg.pb=pl.pb"), self.ui.index("var tk = hqNetCan(\"tank\")"))   # the seat first
        self.assertIn('"hqgrenade","hqtank","cityevents3d","cityplay","playjobs","playheat","playraces","playfinds","playstreet","playarena","hqcity3d"]', self.ui)
        self.assertIn("P.ta = TKm && (p.pb || (p.a | 0) === 14) ? TKm.taFrom(p.ta) : null;", self.hq)
        self.assertIn('"petride", "carpool", "grenade", "tank"]', self.proto)
        self.assertIn('14: "tank"', self.hq)
        net = self.hq[self.hq.index("inst.tankNet = function(){"):][:300]
        self.assertIn("(tkGunner() || tkDriverGuns()) ? {ta: TKm.taWire(", net)   # only whoever has the turret sends an aim
        self.assertIn("let ta = ta.filter(|_| pool.is_some() || a.as_f64() == Some(14.0));", self.rs)   # a gunner's or a driver's

    def test_bounds_match_the_arena(self):
        def const(name):
            m = re.search(r"const %s: \w+ = (-?[0-9_]+);" % name, self.rs)
            self.assertTrue(m, name)
            return int(m.group(1).replace("_", ""))
        self.assertEqual(const("TA_YAW_MAX"), 180)
        self.assertIn("Math.abs(a[0]) > 180 || a[1] < %d || a[1] > %d" % (const("TA_PITCH_MIN"), const("TA_PITCH_MAX")), self.mod)
        self.assertEqual(const("GN_K_MAX"), 1)

    def test_no_network_of_its_own(self):
        for bad in ("fetch(", "XMLHttpRequest", "WebSocket", "sendBeacon", "Math.random"):
            self.assertNotIn(bad, self.mod)


if __name__ == "__main__":
    unittest.main()
