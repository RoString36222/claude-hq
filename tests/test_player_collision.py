"""Other players are solid (HQ 3.13.2): games/hq3d.js blocked() asks peerBlocked, which stops you at a player on
foot (a 0.55 m body), at the box of the vehicle they ride or drive (turned their way, a catalogue car its own size),
not at one who flies, nor one on a floor above or below you, nor one in another world. node runs peerBlocked
itself, cut out of hq3d.js. Stdlib only."""
import json
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


HQ3D = read("games", "hq3d.js")


@unittest.skipUnless(NODE, "node is not installed")
class PeerBlocked(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fn = re.search(r"\n  function peerBlocked\(x, z\)\{.*?\n  \}\n", HQ3D, re.S).group(0)
        src = r"""
var scene = {}, cur = {scene: scene}, avatar = {g: {position: {y: 0}}};
var VEHICLES = {car: {box: [0.66, 1.66]}, bike: {box: [0, 0.4]}, "bmw-m2": {box: [1, 2.3], cat: true}};
var PEER_VEHICLE = {3: "bike", 5: "car", 6: "moto", 7: "heli"};
function peer(x, z, a, o){ var P = {g: {parent: scene}, x: x, z: z, yaw: 0, a: a, hy: 0}; for(var k in o || {}) P[k] = o[k]; return P; }
var peers = {};
""" + fn + r"""
var out = {};
peers = {w: peer(0, 0, 1)};
out.walker = [peerBlocked(0, 0.4), peerBlocked(0.6, 0)];
peers = {c: peer(0, 0, 5)};
out.car = [peerBlocked(0, 1.8), peerBlocked(0.8, 0), peerBlocked(0, 2.1), peerBlocked(1.1, 0)];
peers = {c: peer(0, 0, 5, {yaw: Math.PI/2})};
out.turned = [peerBlocked(1.8, 0), peerBlocked(0, 1.8)];
peers = {m: peer(0, 0, 5, {v: "bmw-m2"})};
out.catalogue = peerBlocked(0, 2.4);
peers = {h: peer(0, 0, 7)}; out.flying = peerBlocked(0, 0);
peers = {u: peer(0, 0, 1, {hy: 6})}; out.upstairs = peerBlocked(0, 0);
peers = {o: peer(0, 0, 1, {g: {parent: {}}})}; out.elsewhere = peerBlocked(0, 0);
process.stdout.write(JSON.stringify(out));
"""
        r = subprocess.run([NODE, "-e", src], capture_output=True, text=True, timeout=60)
        if r.returncode:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout)

    def test_a_player_on_foot_is_a_body(self):
        self.assertEqual(self.o["walker"], [True, False])

    def test_a_driver_is_their_cars_box_turned_their_way(self):
        self.assertEqual(self.o["car"], [True, True, False, False])
        self.assertEqual(self.o["turned"], [True, False])
        self.assertTrue(self.o["catalogue"], "a catalogue car blocks at its own size")

    def test_not_in_the_air_upstairs_or_elsewhere(self):
        self.assertFalse(self.o["flying"])
        self.assertFalse(self.o["upstairs"])
        self.assertFalse(self.o["elsewhere"])


class Source(unittest.TestCase):
    def test_blocked_asks_about_players(self):
        self.assertIn("cur.blocked(x, z)) || peerBlocked(x, z) || tankPropBlocked(x, z); }", HQ3D)   # [3.17] your parked tank


if __name__ == "__main__":
    unittest.main()
