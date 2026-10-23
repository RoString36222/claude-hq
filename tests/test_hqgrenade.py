"""The grenade launcher in the 3D City (games/hqgrenade.js, HQ 3.16).

One node process loads games/hqgrenade.js against a bare window and checks the pure parts: the flight in fixed steps
(the same path and the same blast at any frame rate), bounces off the ground and a wall, sinking in water, the fuse,
the knock-back and its fall-off, the aim, and the presence form of a shot (inside the Arena's bounds, junk refused).
The rest reads the files: the wiring in games/hq3d.js and ui/app/22-hq.js, and that the bounds the page keeps to are
the ones backend/src/valley/hq.rs enforces.
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
    """The text of `function name(...){ ... }` (brace matched)."""
    m = re.search(r"function %s\([^)]*\)\s*\{" % re.escape(name), src)
    assert m, name
    i, depth = m.end(), 1
    while depth:
        depth += src[i] == "{"
        depth -= src[i] == "}"
        i += 1
    return src[m.start():i]


NODE_HARNESS = r"""
var fs = require("fs"), root = %(root)s;
global.window = global; window.HQV = {};
new Function(fs.readFileSync(root + "/games/hqgrenade.js", "utf8"))();
var H = HQV.hqGrenade, out = {loaded: !!H};
var flat = {ground: function(){ return 0; }};
var L = {x: 0, y: 1.5, z: 0, vx: 0, vy: 8, vz: 12};
// the same flight whether a page draws at 30 or 144 frames a second, or catches up in one go
function fly(fps){ var g = H.shot(L), b = null, t = 0; while(!g.done && t < 4){ t += 1/fps; b = H.advance(g, flat, t) || b; } return {b: b, n: g.n, x: g.x, z: g.z, rest: g.rest}; }
var one = H.shot(L), b1 = H.advance(one, flat, 5);
out.det = [fly(30), fly(144), {b: b1, n: one.n, x: one.x, z: one.z, rest: one.rest}];
out.again = H.advance(one, flat, 9);                           // gone off once: never again
var gr = H.shot({x: 0, y: 0.3, z: 0, vx: 0, vy: 0, vz: 5}); H.advance(gr, flat, 1.5); out.roll = {rest: gr.rest, z: gr.z, done: gr.done};
// the first bounce off the ground: up again, slower
var gb = H.shot({x: 0, y: 1, z: 0, vx: 0, vy: -6, vz: 0}); H.advance(gb, flat, 12/60); out.bounce = {y: gb.y, vy: gb.vy, bounced: gb.bounced};
// a wall across z = 5 (below 10 m): it comes back off it
var wall = {ground: function(){ return 0; }, hit: function(a, b){ return (a.z < 5) !== (b.z < 5) && Math.max(a.y, b.y) < 10 ? 0.5 : 1; }};
var gw = H.shot({x: 0, y: 1.5, z: 0, vx: 0, vy: 3, vz: 15}); H.advance(gw, wall, 1);
out.wall = {z: gw.z, vz: gw.vz, x: gw.x, bounced: gw.bounced};
// the sea beyond z = 4 (surface 0.5, the bed 3 m down): it sinks, and still goes off, a wet one
var sea = {ground: function(){ return -3; }, water: function(x, z){ return z > 4 ? 0.5 : null; }};
var gs = H.shot({x: 0, y: 1.5, z: 0, vx: 0, vy: 2, vz: 10}), bs = H.advance(gs, sea, 3);
out.sea = {wet: gs.wet, b: bs, y: gs.y};
var bl = {x: 0, y: 0, z: 0, k: 0};
out.knock = [H.knock(bl, 3, 0.9, 0), H.knock(bl, 0, 0.5, 0), H.knock(bl, 7, 0, 0), H.knock({x: 0, y: 0, z: 0, k: 0, wet: true}, 3, 0.9, 0), H.knock(null, 0, 0, 0)];
out.aim = [H.aim({x: 0, y: 0, z: 1}, 0), H.aim({x: 1, y: -5, z: 0}, 0), H.aim(null, 0), H.aim({x: 0, y: 1, z: 0}, 0)];
var g0 = H.shot({s: 70000, x: 12.34, y: 1.55, z: -3.2, vx: 1.234, vy: 70, vz: -2});
out.wire = H.toWire(g0, 300.4); out.back = H.fromWire(out.wire);
out.far = H.toWire(H.shot({x: 2000}), 0);
out.old = H.toWire(H.shot({}), 99999)[8];
out.bad = [[1, 2, 3], [0, 0, 0, 0, 0, 0, 0, 1, 0], [0, 0, 0, 0, 0, 0, 0, 0, 2001], [0.5, 0, 0, 0, 0, 0, 0, 0, 0],
           [0, 0, 0, 0, 7000, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, "1"], [-1, 0, 0, 0, 0, 0, 0, 0, 0], [65536, 0, 0, 0, 0, 0, 0, 0, 0],
           [0, 102401, 0, 0, 0, 0, 0, 0, 0], [0, 0, 50001, 0, 0, 0, 0, 0, 0], null, "x", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]].map(H.fromWire);
out.K = H.KINDS[0]; out.LOFT = H.LOFT; out.WIRE = H.WIRE; out.DT = H.DT; out.junk = H.shot(null);
process.stdout.write(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
class GrenadePure(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-"], input=NODE_HARNESS % {"root": json.dumps(ROOT)}, capture_output=True, text=True, timeout=60)
        if r.returncode:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout)

    def test_loads_without_three(self):
        self.assertTrue(self.o["loaded"])

    def test_same_flight_at_any_frame_rate(self):
        a, b, c = self.o["det"]
        fuse_steps = round(self.o["K"]["fuse"]/self.o["DT"])
        for d in (a, b, c):
            self.assertEqual(d["n"], fuse_steps)                 # goes off on its fuse's step
            self.assertIsNotNone(d["b"])
            self.assertEqual(d["b"]["x"], a["b"]["x"])           # exactly the same blast, not just close
            self.assertEqual(d["b"]["z"], a["b"]["z"])
            self.assertEqual(d["b"]["y"], a["b"]["y"])
        self.assertGreater(a["b"]["z"], 5)                       # it went somewhere
        self.assertIsNone(self.o["again"])

    def test_bounces_and_comes_to_rest(self):
        bo = self.o["bounce"]
        self.assertGreater(bo["vy"], 0)                          # off the ground, upward
        self.assertLess(bo["vy"], 6*0.5)                         # and slower
        self.assertGreaterEqual(bo["bounced"], 1)
        self.assertFalse(self.o["det"][0]["rest"])               # that lob was still in the air on its fuse
        ro = self.o["roll"]
        self.assertTrue(ro["rest"])                              # rolled along the ground, it stops before its fuse
        self.assertFalse(ro["done"])
        self.assertGreater(ro["z"], 0)

    def test_comes_back_off_a_wall(self):
        w = self.o["wall"]
        self.assertLess(w["z"], 5)
        self.assertLess(w["vz"], 0)
        self.assertEqual(w["x"], 0)
        self.assertGreaterEqual(w["bounced"], 1)

    def test_sinks_and_goes_off_wet(self):
        s = self.o["sea"]
        self.assertTrue(s["wet"])
        self.assertTrue(s["b"]["wet"])
        self.assertLess(s["y"], 0.5)

    def test_knock_falls_off_to_the_edge(self):
        k3, above, out7, wet, none = self.o["knock"]
        K = self.o["K"]
        s = 1 - math.sqrt(9 + 0.81)/K["blast"]
        self.assertAlmostEqual(k3["s"], s, places=9)
        self.assertAlmostEqual(k3["push"], K["push"]*s, places=9)
        self.assertAlmostEqual(k3["lift"], K["lift"]*s, places=9)
        self.assertEqual((k3["dx"], k3["dz"]), (1, 0))           # away from its heart
        self.assertEqual((above["dx"], above["dz"]), (0, 0))     # right over it: straight up
        self.assertGreater(above["lift"], k3["lift"])
        self.assertIsNone(out7)                                  # beyond the blast radius
        self.assertAlmostEqual(wet["push"], k3["push"]*0.4, places=9)
        self.assertIsNone(none)

    def test_aim_lofts_and_clamps(self):
        level, down, junk, up = self.o["aim"]
        K, loft = self.o["K"], self.o["LOFT"]
        self.assertAlmostEqual(level["vx"], 0, places=9)
        self.assertAlmostEqual(level["vy"], math.sin(loft)*K["muzzle"], places=9)
        self.assertAlmostEqual(level["vz"], math.cos(loft)*K["muzzle"], places=9)
        self.assertAlmostEqual(down["vy"], math.sin(-0.35)*K["muzzle"], places=9)   # never into your feet
        self.assertGreater(down["vx"], 0)
        self.assertAlmostEqual(abs(down["vz"]), 0, places=9)
        self.assertEqual(junk, level)
        self.assertAlmostEqual(up["vy"], math.sin(1.25)*K["muzzle"], places=9)      # never straight up

    def test_presence_form(self):
        self.assertEqual(self.o["wire"], [70000 & 0xffff, 1234, 155, -320, 123, 6000, -200, 0, 300])
        b = self.o["back"]
        self.assertEqual((b["s"], b["k"]), (4464, 0))
        self.assertAlmostEqual(b["x"], 12.34)
        self.assertAlmostEqual(b["vy"], 60)
        self.assertAlmostEqual(b["age"], 0.3)
        self.assertIsNone(self.o["far"])                          # outside the Arena's map: never sent
        self.assertEqual(self.o["old"], 2000)                     # an age is clamped to what the Arena takes
        self.assertEqual(self.o["bad"], [None]*13)
        self.assertEqual(self.o["junk"]["s"], 0)


class GrenadeWiring(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.hq = read("games", "hq3d.js")
        cls.ui = read("ui", "app", "22-hq.js")
        cls.rs = read("backend", "src", "valley", "hq.rs")
        cls.proto = read("backend", "src", "protocol.rs")
        cls.mod = read("games", "hqgrenade.js")

    def test_keys_and_click(self):
        self.assertIn('(e.code === "KeyX" || (e.code === "KeyF" && GN.out)) && !ride && inst.running && gnHere() && !typing(e.target)', self.hq)
        self.assertIn('if(e.code === "KeyX") gnToggle(); else gnFire();', self.hq)
        # a captured click (Mouse steering) fires; no repeat fire from a held key
        self.assertIn("if(e.button === 0) gnFire();", func_body(self.hq, "onDown"))
        self.assertIn('if(e.type === "keydown" && !e.repeat)', self.hq)
        # only on foot in the 3D City, never on a ride, a trip or a bus seat
        can = func_body(self.hq, "gnCan")
        for k in ("gnHere()", "!ride", "cur.carry()", "!tripHeld()"):
            self.assertIn(k, can)
        self.assertIn('w.indexOf("city3d") === 0', func_body(self.hq, "gnHere"))
        self.assertIn("GN.cd > 0", func_body(self.hq, "gnFire"))

    def test_frame_and_drawing(self):
        fr0 = func_body(self.hq, "frame")
        self.assertLess(fr0.index("moveAvatar(dt);"), fr0.index("gnFrame(dt);"))   # after you move, before the camera
        self.assertLess(fr0.index("gnFrame(dt);"), fr0.index("rigFrame(t, dt)"))
        self.assertIn("gunStep(avatar.ch, GN.out && !ride, true);", self.hq)
        self.assertIn("gunStep(P.ch, !!P.gl && !vk, true);", self.hq)
        fr = func_body(self.hq, "gnFrame")
        self.assertIn("if(GN.out && !gnCan()) GN.out = false;", fr)
        self.assertIn("if(g.w !== w)", fr)                         # a shot belongs to the floor it was fired on
        self.assertIn("GN.fx.clear()", fr)

    def test_knock_only_moves_you(self):
        kn = func_body(self.hq, "gnKnock")
        self.assertIn("H.knock(b, avatar.x", kn)
        self.assertIn("if(!E.calm()){ avatar.airborne = true;", kn)   # Calm: a shove, never a flight
        self.assertIn("drvHit(", kn)
        self.assertNotIn("peers", kn)                                # never anyone else: they knock themselves
        mv = func_body(self.hq, "moveAvatar")
        self.assertIn("if(GN.kx || GN.kz){", mv)
        self.assertIn("blocked(kx, kz)", mv)                         # slid along walls, never through them
        bl = func_body(self.hq, "gnBlast")
        self.assertIn("if(!calm && !(camSet && camSet.reduced)) GN.shake", bl)
        self.assertIn("GN.fx.blast(b.x, b.y, b.z, b.k, b.wet, calm)", bl)

    def test_presence_wiring(self):
        self.assertIn('var gr = hqNetCan("grenade") && HQ3D.inst.grenadeNet ? HQ3D.inst.grenadeNet() : null;', self.ui)
        self.assertIn("msg.gn=gr.gn.slice(0,4)", self.ui)
        self.assertIn("msg.rpm,msg.gl,JSON.stringify(msg.gn||0)].join", self.ui)
        self.assertIn('"hqstunts","hqgrenade","hqcity3d"]', self.ui)
        self.assertIn("hqgrenade:1", self.ui)
        net = self.hq[self.hq.index("inst.grenadeNet = function(){"):]
        self.assertIn("H.toWire(g.launch,", net[:400])                # the launch, never where it is now
        self.assertIn("if(Array.isArray(p.gn) && p.w === curW()) gnSeen(p.u, p.gn);", self.hq)
        self.assertIn('"petride", "grenade"]', self.proto)

    def test_bounds_match_the_arena(self):
        def const(name):
            m = re.search(r"const %s: \w+ = ([0-9_.]+);" % name, self.rs)
            self.assertTrue(m, name)
            return float(m.group(1).replace("_", ""))
        w = re.search(r"var WIRE = \{xz: (\d+), y: (\d+), v: (\d+), s: (\d+), age: (\d+), n: (\d+), kMax: (\d+)\};", self.mod)
        self.assertTrue(w)
        xz, y, v, s, age, n, kmax = (int(g) for g in w.groups())
        self.assertEqual(xz, const("XZ_MAX_CM"))
        self.assertEqual(y, const("ALT_H_MAX"))
        self.assertEqual(v, const("GN_V_MAX"))
        self.assertEqual(s, const("GN_S_MAX"))
        self.assertEqual(age, const("GN_AGE_MAX"))
        self.assertEqual(n, const("GN_MAX"))
        self.assertEqual(kmax, const("GN_K_MAX"))

    def test_no_network_of_its_own(self):
        for bad in ("fetch(", "XMLHttpRequest", "WebSocket", "sendBeacon", "Math.random"):
            self.assertNotIn(bad, self.mod)


if __name__ == "__main__":
    unittest.main()
