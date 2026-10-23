"""The tank in the 3D City (games/hqtank.js, HQ 3.17): four seats, a turret, a shell.

node runs the pure parts of games/hqtank.js: driving (it pulls away gently, stops hard, turns on the spot, a wall
stops it and it can always drive out of one), where it fits when you call it, the seat rules (the driver's page gives
a free seat to the first who asks, keeps a seat while it is claimed, a passenger moves on when theirs goes), the
presence forms of the seats and the aim, the gunner's aim from the camera. It also runs hq3d.js's peerBlocked: a
driven tank is solid, its passengers are not. The shell (grenade kind 1) goes off on whatever it touches. The rest
reads the files: the wiring in games/hq3d.js and ui/app/22-hq.js, and that the page keeps to the Arena's bounds.
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
["hqgrenade", "hqtank"].forEach(function(f){ new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))(); });
var T = HQV.hqTank, H = HQV.hqGrenade, out = {loaded: !!T};
var open = {blocked: function(){ return false; }};
function drive(st, inp, secs, env){ for(var i = 0; i < Math.round(secs*60); i++) T.step(st, inp, 1/60, env || open); return st; }
var a = drive(T.newState(0, 0, 0), {fwd: 1}, 1), full = drive(T.newState(0, 0, 0), {fwd: 1}, 6);
out.go = {v1: a.speed, z1: a.z, x1: a.x, top: full.speed};
var stop = drive(full, {}, 1); out.stop = stop.speed;
out.rev = drive(T.newState(0, 0, 0), {fwd: -1}, 4).speed;
var piv = drive(T.newState(0, 0, 0), {turn: 1}, 1); out.pivot = {yaw: piv.yaw, x: piv.x, z: piv.z, l: piv.trk[0], r: piv.trk[1]};
var fast = drive(drive(T.newState(0, 0, 0), {fwd: 1}, 6), {fwd: 1, turn: 1}, 1); out.fastRate = fast.rate;
// a wall across z = 10: it stops there and says so; it can still back away
var wall = {blocked: function(x, z){ return z > 10; }}, bumps = [], w = T.newState(0, 0, 0);
for(var i = 0; i < 600; i++) T.step(w, {fwd: 1}, 1/60, wall).forEach(function(e){ bumps.push(e.type); });
out.wall = {z: w.z, speed: w.speed, bumps: bumps.length};
out.back = drive(w, {fwd: -1}, 1, wall).z;
// stuck inside something already (parked over a car): it may drive out
var inside = {blocked: function(x, z){ return Math.abs(x) < 1 && Math.abs(z) < 1; }};
out.stuck = drive(T.newState(0, 0, 0), {fwd: 1}, 2, inside).z;
// where it fits beside you: your right first (-x facing +z), else your left
out.spot = [T.spot(0, 0, 0, open), T.spot(0, 0, 0, {blocked: function(x){ return x < -2; }}), T.spot(0, 0, 0, {blocked: function(){ return true; }})];
// seats
out.assign = [
  T.assign(["", "", ""], [{u: "a", n: 1}, {u: "b", n: 1}, {u: "c", n: 3}]),
  T.assign(["a", "", "c"], [{u: "c", n: 3}, {u: "b", n: 1}]),            // a left: the gunner's seat frees for b
  T.assign(["a", "", ""], [{u: "a", n: 2}]),                              // a moved: only the claimed seat
  T.assign(["a", "", ""], [{u: "a", n: 1}, {u: "a", n: 2}]),             // one id, one seat (its first claim)
  T.assign(null, [null, {u: "bad id!", n: 1}, {u: "z", n: 9}, {u: "y", n: 2}])];
out.pick = [T.pick(["", "", ""], "me"), T.pick(["a", "", ""], "me"), T.pick(["a", "b", ""], "me"), T.pick(["a", "b", "c"], "me"), T.pick(["a", "me", "c"], "me"), T.pick(null, "me")];
out.status = [T.status(["", "me", ""], "me", 2), T.status(["", "x", ""], "me", 2), T.status(["", "", ""], "me", 2), T.status(null, "me", 1)];
out.ts = [T.tsWire(["a", "me", "a"], "me"), T.tsWire(["<b>", "ok_1", null], "me"), T.tsFrom(["a", "", "b"]), T.tsFrom(["a", ""]), T.tsFrom(["a", 1, ""]), T.tsFrom(["a b", "", ""])];
out.sb = [T.sbWire("drv", 1), T.sbWire("drv", 4), T.sbWire("", 1), T.sbFrom(["drv", 3]), T.sbFrom(["drv", 1.5]), T.sbFrom(["drv", 0]), T.sbFrom("drv")];
out.ta = [T.taWire(Math.PI, 1), T.taWire(-0.5, -1), T.taFrom([90, 20]), T.taFrom([181, 0]), T.taFrom([0, 61]), T.taFrom([0, -16]), T.taFrom([0, -15]), T.taFrom([1.5, 0])];
out.aim = [T.aimFrom({x: 0, y: 0, z: 1}, 0), T.aimFrom({x: 1, y: 0, z: 0}, Math.PI/2), T.aimFrom({x: 0, y: 1, z: 0}, 0), T.aimFrom({x: 0, y: -1, z: 0}, 0)];
// the shell: off on the ground, on a wall, in water; a grenade still bounces
var flat = {ground: function(){ return 0; }};
var sh = H.shot({k: 1, x: 0, y: 2, z: 0, vx: 0, vy: -1, vz: 38}), bs = H.advance(sh, flat, 4);
out.shell = {b: bs, n: sh.n, done: sh.done};
var wl = {ground: function(){ return 0; }, hit: function(a, b){ return (a.z < 20) !== (b.z < 20) ? 0.5 : 1; }};
var sw = H.shot({k: 1, x: 0, y: 2, z: 0, vx: 0, vy: 2, vz: 38}); out.shellWall = H.advance(sw, wl, 4);
var sea = {ground: function(){ return -3; }, water: function(){ return 0; }};
out.shellSea = H.advance(H.shot({k: 1, x: 0, y: 2, z: 0, vx: 0, vy: 0, vz: 38}), sea, 4);
out.K1 = H.KINDS[1]; out.AIM = T.AIM; out.REACH = T.REACH; out.HALF = [T.HALF_W, T.HALF_L];
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

    def test_seat_rules(self):
        first, freed, moved, once, junk = self.o["assign"]
        self.assertEqual(first, ["a", "", "c"])                    # first come first served; b waits
        self.assertEqual(freed, ["b", "", "c"])
        self.assertEqual(moved, ["", "a", ""])
        self.assertEqual(once, ["a", "", ""])
        self.assertEqual(junk, ["", "y", ""])
        self.assertEqual(self.o["pick"], [1, 2, 3, 0, 2, 1])       # the gunner's seat first; yours if you have one
        self.assertEqual(self.o["status"], ["ok", "lost", "wait", "wait"])

    def test_presence_forms(self):
        self.assertEqual(self.o["ts"], [["a", "", ""], ["", "ok_1", ""], ["a", "", "b"], None, None, None])
        self.assertEqual(self.o["sb"], [["drv", 1], None, None, {"u": "drv", "n": 3}, None, None, None])
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
    """hq3d.js peerBlocked: a driven tank (a = 14) blocks you along its whole hull; someone sitting in it does not."""

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
peers = {s: peer(0, 0, 0, {seated: true})}; out.seated = peerBlocked(0, 0);
process.stdout.write(JSON.stringify(out));
"""
        r = subprocess.run([NODE, "-e", src], capture_output=True, text=True, timeout=60)
        if r.returncode:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout)

    def test_hull_blocks_and_passengers_do_not(self):
        self.assertEqual(self.o["tank"], [True, True, False, False])
        self.assertFalse(self.o["seated"])


class TankWiring(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.hq = HQ3D
        cls.ui = read("ui", "app", "22-hq.js")
        cls.rs = read("backend", "src", "valley", "hq.rs")
        cls.proto = read("backend", "src", "protocol.rs")
        cls.mod = read("games", "hqtank.js")

    def test_keys(self):
        self.assertIn('if(e.code === "KeyK" && !ride && !TK.seat && inst.running && tkOk() && !typing(e.target)', self.hq)
        self.assertIn("if(e.type === \"keydown\" && !e.repeat) tankSummon(); return;", self.hq)
        uk = func_body(self.hq, "useKey")
        self.assertIn('if(TK.seat){ seatLeave("You climbed out of the tank"); return true; }', uk)
        self.assertIn("if(!ride && nearTank()){ mountTank(); return true; }", uk)
        self.assertIn("var tu = tankPeerNear(); if(tu){ seatTake(tu); return true; }", uk)
        self.assertIn("if(e.button === 0 && !tkFire()) gnFire();", func_body(self.hq, "onDown"))
        self.assertIn('if(e.code === "KeyX") gnToggle(); else if(!tkFire()) gnFire();', self.hq)

    def test_driving_and_seats_in_the_frame(self):
        mv = func_body(self.hq, "moveAvatar")
        self.assertLess(mv.index("if(TK.seat){ seatMove(dt); return; }"), mv.index("if(ride){"))
        self.assertIn("if(ride.tank) tankMove(dt);", mv)
        self.assertIn("if(ride.tank){ dismountTank(force); return; }", func_body(self.hq, "dismount"))
        fr = func_body(self.hq, "frame")
        self.assertIn("placePeers(dt, t);\n    tankFrame(dt); seatPeers(dt); seatPlace();", fr)
        self.assertIn("return ride ? (ride.tank ? 14 :", self.hq)
        self.assertIn('vehicle: "tank"', func_body(self.hq, "rigTarget"))
        tf = func_body(self.hq, "tankFrame")
        self.assertIn("TK.ts = TKm.assign(TK.ts, claims);", tf)       # the driver's page decides
        self.assertIn("claims.sort(", tf)                              # first come, first served
        sm = func_body(self.hq, "seatMove")
        self.assertIn('if(!P || P.a !== 14 || P.w !== curW())', sm)    # the driver got out or left: out
        self.assertIn("E.now() - S.t0 > 4", sm)                        # an older driver's page never answers
        sp = func_body(self.hq, "seatPeers")
        self.assertIn("D.ts[sb.n - 1] === u", sp)                      # drawn seated only where the driver says
        self.assertIn("if(P.seated){ P.px = P.x; P.pz = P.z; P.pyaw = P.yaw; return; }", func_body(self.hq, "placePeers"))

    def test_blasts_never_move_a_tank(self):
        kn = func_body(self.hq, "gnKnock")
        self.assertIn("ride.tank ||", kn)
        self.assertIn("if(TK.seat ||", kn)
        self.assertIn("!TK.seat", func_body(self.hq, "gnCan"))

    def test_presence(self):
        self.assertIn('if(a===14 && !hqNetCan("tank")) a = 0;', self.ui)
        self.assertIn('var tk = hqNetCan("tank") && HQ3D.inst.tankNet ? HQ3D.inst.tankNet() : null;', self.ui)
        self.assertIn("if(a===14 && Array.isArray(tk.ts)) msg.ts=tk.ts;", self.ui)
        self.assertIn("JSON.stringify(msg.ts||0),JSON.stringify(msg.sb||0),JSON.stringify(msg.ta||0)].join", self.ui)
        self.assertIn('"hqgrenade","hqtank","hqcity3d"]', self.ui)
        self.assertIn("P.ts = TKm && (p.a | 0) === 14 ? TKm.tsFrom(p.ts) : null;", self.hq)
        self.assertIn('"petride", "grenade", "tank"]', self.proto)
        self.assertIn("14: \"tank\"", self.hq)
        net = self.hq[self.hq.index("inst.tankNet = function(){"):][:600]
        self.assertIn("if(tkGunner()) o.ta = TKm.taWire(", net)        # only a confirmed gunner sends an aim

    def test_bounds_match_the_arena(self):
        def const(name):
            m = re.search(r"const %s: \w+ = (-?[0-9_]+);" % name, self.rs)
            self.assertTrue(m, name)
            return int(m.group(1).replace("_", ""))
        self.assertEqual(const("TA_YAW_MAX"), 180)
        self.assertIn("Math.abs(a[0]) > 180 || a[1] < %d || a[1] > %d" % (const("TA_PITCH_MIN"), const("TA_PITCH_MAX")), self.mod)
        self.assertEqual(const("TANK_SEATS"), 3)
        self.assertEqual(const("GN_K_MAX"), 1)

    def test_no_network_of_its_own(self):
        for bad in ("fetch(", "XMLHttpRequest", "WebSocket", "sendBeacon", "Math.random"):
            self.assertNotIn(bad, self.mod)


if __name__ == "__main__":
    unittest.main()
