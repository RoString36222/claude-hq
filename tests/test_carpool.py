"""Carpooling (HQ 3.15): a passenger seat in someone else's car, behind them on a bike or a scooter.

The seats (games/hqdrive.js poolSeats / poolSeat, under node), the scooter's three seats (games/hqvehiclemodels.js,
built with the vendored three.js), the Suzuki Access in the catalogue, and the wiring: presence carries pb / ps only
where the Arena lists "carpool", and games/hq3d.js reads them and seats the passenger. Skipped without node."""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")


def read(path):
    with open(os.path.join(ROOT, path), encoding="utf-8") as f:
        return f.read()


SEATS = r"""
const fs = require('fs'), path = require('path');
global.window = {HQV: {}, localStorage: null};
eval(fs.readFileSync(path.join(%(root)s, 'games', 'hqdrive.js'), 'utf8'));
const D = window.HQV.hqDrive, out = {};
out.seats = [D.poolSeats('car', null), D.poolSeats('car', 'sedan'), D.poolSeats('car', 'suv'), D.poolSeats('car', 'coupe'),
             D.poolSeats('car', 'hyper'), D.poolSeats('car', 'super'), D.poolSeats('moto', null), D.poolSeats('moto', 'naked'),
             D.poolSeats('moto', 'scooter'), D.poolSeats('bike', null), D.poolSeats('heli', null), D.poolSeats('moto', 'naked', 3),
             D.poolSeats('car', 'sedan', 9), D.poolSeats('car', 'sedan', 1.5),
             D.poolSeats('moto', 'hypersport', null, 'over950'), D.poolSeats('moto', 'sport', null, 'over950'),
             D.poolSeats('moto', 'sport', null, '400'), D.poolSeats('moto', 'naked', null, 'over950')];
const L = [{u: 'b', pb: 'drv', ps: 1}, {u: 'x', pb: 'other', ps: 1}];
out.next = D.poolSeat('me', 'drv', L, 4, 0);                    // seat 1 is b's: the next
out.free = D.poolSeat('me', 'drv', [], 4, 0);
out.full = D.poolSeat('me', 'drv', [{u: 'b', pb: 'drv', ps: 1}], 2, 0);
out.keep = D.poolSeat('me', 'drv', L, 4, 2);                    // yours stays yours
// two on one seat at once: the lower id keeps it, the other moves along, or off when none is left
out.lowKeeps = D.poolSeat('a', 'drv', [{u: 'm', pb: 'drv', ps: 1}], 3, 1);
out.highMoves = D.poolSeat('m', 'drv', [{u: 'a', pb: 'drv', ps: 1}], 3, 1);
out.highOff = D.poolSeat('m', 'drv', [{u: 'a', pb: 'drv', ps: 1}], 2, 1);
out.ignoresBad = D.poolSeat('me', 'drv', [{u: 'b', pb: 'drv', ps: 7}, null, {u: 'me', pb: 'drv', ps: 1}], 3, 0);
console.log(JSON.stringify(out));
"""

SCOOTER = r"""
import fs from "fs";
const root = %(root)s, entry = %(entry)s;
const THREE = await import(root + "/games/vendor/three-module.js");
globalThis.window = {HQV: {}};
new Function(fs.readFileSync(root + "/games/hqvehiclemodels.js", "utf8"))();
const r = window.HQV.hqVehicleModels.build(THREE, entry, 0x3366cc);
r.g.updateMatrixWorld(true);
const at = n => { const o = r.g.getObjectByName(n); return o ? {p: o.position.toArray(), parent: o.parent === r.seat.parent} : null; };
console.log(JSON.stringify({seat: at("a-seat"), s1: at("a-seat-1"), s2: at("a-seat-2"), radii: r.radii, kind: r.kind,
                            steer: !!r.steer, wheels: r.wheels.filter(Boolean).length}));
"""


class Seats(unittest.TestCase):
    @unittest.skipUnless(NODE, "node not installed")
    def test_how_many_each_carries_and_which_seat_you_take(self):
        r = subprocess.run([NODE, "-e", SEATS % {"root": json.dumps(ROOT)}], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        o = json.loads(r.stdout)
        # starter hatch 2, sedan / SUV 4, coupe / hyper / super 2, a motorbike 2, a scooter 3, a bicycle 2, a helicopter none;
        # the catalogue's own count (1-4) wins, anything else is ignored
        self.assertEqual(o["seats"][:14], [2, 4, 4, 2, 2, 2, 2, 2, 3, 2, 0, 3, 4, 4])
        # no pillion on a super sports bike (a hypersport, a sport bike over 950 cc); a 400 cc sport bike and a big naked keep one
        self.assertEqual(o["seats"][14:], [1, 1, 2, 2])
        self.assertEqual((o["next"], o["free"], o["full"], o["keep"]), (2, 1, 0, 2))
        self.assertEqual((o["lowKeeps"], o["highMoves"], o["highOff"]), (1, 2, 0))
        self.assertEqual(o["ignoresBad"], 1)


class Scooter(unittest.TestCase):
    def setUp(self):
        cat = json.loads(read("games/vehicles/catalogue.json"))
        self.v = next(v for v in cat["vehicles"] if v["id"] == "suzuki-access-125")
        self.cls = next(c for c in cat["classes"] if c["id"] == self.v["class"])

    def test_the_access_is_in_the_catalogue_and_seats_three(self):
        v = self.v
        self.assertEqual((v["brand"], v["model"], v["class"], v["body"], v["seats"]), ("Suzuki", "Access 125", "bike.scooter.400", "scooter", 3))
        self.assertEqual((self.cls["type"], self.cls["band"]), ("scooter", "400"))
        self.assertEqual((v["spec"]["cc"], v["spec"]["gears"]), (124, 1))
        self.assertEqual(read("games/vehicles/catalogue.json"), read("backend/data/vehicles.json"))

    @unittest.skipUnless(NODE, "node not installed")
    def test_its_body_has_three_seats_one_behind_another(self):
        r = subprocess.run([NODE, "--input-type=module", "-e", SCOOTER % {"root": json.dumps(ROOT), "entry": json.dumps(self.v)}],
                           capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stderr)
        o = json.loads(r.stdout)
        self.assertEqual((o["kind"], o["steer"], o["wheels"]), ("bike", True, 2))
        self.assertLess(o["radii"][0], 0.35)                                  # small wheels (10" / 12", drawn at 1.3x)
        z = [o["seat"]["p"][2], o["s1"]["p"][2], o["s2"]["p"][2]]
        self.assertTrue(o["s1"]["parent"] and o["s2"]["parent"])            # beside the rider's seat, in its frame
        self.assertTrue(z[0] > z[1] > z[2], z)                               # the rider, then two behind
        self.assertTrue(all(0.25 < z[i] - z[i + 1] < 0.6 for i in range(2)), z)
        self.assertTrue(all(abs(o[k]["p"][0]) < 1e-6 for k in ("seat", "s1", "s2")))


class Wiring(unittest.TestCase):
    def test_presence_carries_pb_and_ps_only_where_the_arena_lists_carpool(self):
        ui = read("ui/app/22-hq.js")
        self.assertIn('hqNetCan("carpool") && HQ3D.inst.poolNet', ui)
        self.assertRegex(ui, r"msg\.pb=pl\.pb; msg\.ps=pl\.ps\|0;")
        self.assertIn("msg.a,msg.pb,msg.ps", ui)                                    # in the resend key: a new seat goes out at once
        self.assertIn('"carpool"', read("backend/src/protocol.rs"))

    def test_hq3d_reads_them_and_seats_the_passenger(self):
        hq = read("games/hq3d.js")
        self.assertIn("inst.poolNet = function()", hq)
        self.assertRegex(hq, r'P\.pb = typeof p\.pb === "string" && UR\.test\(p\.pb\)')
        self.assertIn("if(POOL.u && poolMove()) return;", hq)                # a passenger goes where the driver goes
        self.assertIn("poolDraw(P, dt, t)) return;", hq)                     # and is drawn in their seat
        self.assertIn('if(!ride && POOL.u){ poolOff(null); return true; }', hq)
        self.assertIn("P.x == null || P.pb) continue;", hq)                  # not solid to their driver (peerBlocked)
        # E: a parked vehicle before someone's car
        self.assertLess(hq.index("if(ride || nearBike() >= 0){ rideToggle(); return true; }"), hq.index("if(!ride && POOL.near){ poolBoard(POOL.near); return true; }"))


if __name__ == "__main__":
    unittest.main()
