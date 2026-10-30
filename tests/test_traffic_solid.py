"""The traffic is solid (HQ 3.13.1): games/hqcity3d.js blocked() counts the cars, buses and trams drawn this
frame, so you hit them on foot, on a board and at the wheel (games/hq3d.js rideMove's bodyHits), and the
traffic sees you at your car's size so it stops short of you. Source checks plus the hit-test itself, run
under node on a stand-alone copy of trafficAt. Stdlib only."""
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


CITY = read("games", "hqcity3d.js")


class Source(unittest.TestCase):
    def test_blocked_counts_the_traffic(self):
        body = CITY[CITY.index("  function blocked(x, z, ride){"):]
        body = body[:body.index("\n  }\n")]
        self.assertIn("if(trafficAt(x, z)) return true;", body)

    def test_the_traffic_sees_your_car_at_its_size(self):
        self.assertIn('myR = mo && mo.ride === "car" ? 2.6', CITY)
        self.assertIn("[{x: me0.x, z: me0.z, r: myR}]", CITY)

    def test_your_car_bumps_off_whatever_blocked_says(self):
        self.assertIn("function blocked(x, z){ return (cur === worlds.mission ? missionBlocked(x, z) : cur.blocked(x, z)) || peerBlocked(x, z) || tankPropBlocked(x, z); }", read("games", "hq3d.js"))


@unittest.skipUnless(NODE, "node is not installed")
class HitTest(unittest.TestCase):
    def test_a_vehicle_is_solid_end_to_end_and_only_at_your_level(self):
        m = re.search(r"\n  function trafficAt\(x, z\)\{.*?\n  \}\n", CITY, re.S)
        src = """
var HQV = {traffic: {SPEC: {car: {len: 3.8, wid: 1.85}, tram: {len: 27, wid: 2.65, sec: 13}}}};
var callTraffic = [{kind: "car", x: 0, y: 0, z: 0, yaw: 0},
                   {kind: "tram", x: 100, y: 0, z: 0, yaw: Math.PI/2, parts: [{x: 107, y: 0, z: 0, yaw: Math.PI/2}, {x: 93, y: 0, z: 0, yaw: Math.PI/2}]},
                   {kind: "car", x: 0, y: 0, z: 50, yaw: 0}];
function groundY(x, z){ return z > 45 ? 6 : 0; }   // a deck over the street at z 50
""" + m.group(0) + """
process.stdout.write(JSON.stringify({
  car: [trafficAt(0, 0), trafficAt(0, 1.9), trafficAt(0, 2.3), trafficAt(1.2, 0)],
  tram: [trafficAt(100, 0), trafficAt(113, 0), trafficAt(115, 0), trafficAt(100, 1.6)],
  deck: trafficAt(0, 50)}));
"""
        r = subprocess.run([NODE, "-e", src], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        o = json.loads(r.stdout)
        self.assertEqual(o["car"], [True, True, False, False])
        self.assertEqual(o["tram"], [True, True, False, False], "the joint between its sections is solid too")
        self.assertFalse(o["deck"], "traffic under a deck you stand on")


if __name__ == "__main__":
    unittest.main()
