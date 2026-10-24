"""Owned vehicles on the client (games/hqgarage.js), and presence of the vehicle you drive.

node: HQV.hqGarage against a fake fetch: mine() caches and cleans rows (bad ids dropped, parked null in the
garage), buy() posts only {vehicle_id, paint} with the CSRF header and appends the claimed vehicle, a refused buy
answers {error, status}, park() posts a spot or {garage: true} to the owned vehicle's own path. The Python side
checks the page sends `v` / `vp` only while driving and only where the Arena lists "vehicles", and that hq3d draws
a peer's catalogue vehicle with hqVehicleModels. Skipped when node is not installed. Stdlib only."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
OWNED = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"


def read(*p):
    with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
        return f.read()


HARNESS = r"""
import fs from "fs";
const root = %(root)s, OWNED = %(owned)s;
globalThis.window = {HQV: {}};
globalThis.CSRF = "tok";
new Function(fs.readFileSync(root + "/games/hqgarage.js", "utf8"))();
const G = window.HQV.hqGarage, calls = [];
let replies = [];
G._io.fetch = (u, o) => {
  calls.push({u, method: (o && o.method) || "GET", body: o && o.body ? JSON.parse(o.body) : null, tok: o && o.headers && o.headers["X-HQ-Token"]});
  const [status, body] = replies.shift();
  return Promise.resolve({status, ok: status >= 200 && status < 300, json: () => Promise.resolve(body)});
};
const out = {};
let changes = 0; G.onChange(() => changes++);
replies.push([200, {vehicles: [
  {id: OWNED, vehicle_id: "bmw-m2", paint: 2, bought_at: 1, parked: null},
  {id: "../x", vehicle_id: "bmw-m2", paint: 0, parked: null},
  {id: "b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", vehicle_id: "ktm-390-duke", paint: 1, parked: {world: "claude-hq@2", x: 1, z: 2, yaw: 3}}]}]);
out.mine = await G.mine();
out.cachedSame = (await G.mine()) === out.mine;
out.fetchesAfterCache = calls.length;
replies.push([200, {ok: true, vehicle: {id: "c1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", vehicle_id: "bugatti-tourbillon", paint: 1, parked: null}, coins: 0}]);
out.buy = await G.buy("bugatti-tourbillon", 1);
out.buyCall = calls[calls.length - 1];
out.afterBuy = G.cached().length;
replies.push([409, {detail: "that vehicle isn't on sale"}]);
out.refused = await G.buy("bugatti-veyron", 0);
out.badId = await G.buy("../etc", 0);
replies.push([200, {ok: true}]);
await G.park(OWNED, {world: "claude-hq@2", x: 5, z: -6, yaw: 1});
out.parkCall = calls[calls.length - 1];
out.parkedNow = G.cached()[0].parked;
replies.push([200, {ok: true}]);
await G.park(OWNED, null);
out.homeCall = calls[calls.length - 1];
out.homeNow = G.cached()[0].parked;
out.changes = changes;
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class HqGarage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        src = HARNESS % {"root": json.dumps(ROOT), "owned": json.dumps(OWNED)}
        r = subprocess.run([NODE, "--input-type=module", "-e", src], capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_mine_is_cleaned_and_cached(self):
        m = self.o["mine"]
        self.assertEqual([v["vehicle_id"] for v in m], ["bmw-m2", "ktm-390-duke"], "a row with a bad id is dropped")
        self.assertIsNone(m[0]["parked"], "in the garage")
        self.assertEqual(m[1]["parked"], {"world": "claude-hq@2", "x": 1, "z": 2, "yaw": 3})
        self.assertTrue(self.o["cachedSame"])
        self.assertEqual(self.o["fetchesAfterCache"], 1)

    def test_buy_sends_only_id_and_paint(self):
        c = self.o["buyCall"]
        self.assertEqual((c["u"], c["method"], c["tok"]), ("/api/arena/vehicles/buy", "POST", "tok"))
        self.assertEqual(c["body"], {"vehicle_id": "bugatti-tourbillon", "paint": 1})
        self.assertEqual(self.o["buy"]["id"], "c1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d")
        self.assertEqual(self.o["afterBuy"], 3)
        self.assertEqual(self.o["refused"], {"error": "that vehicle isn't on sale", "status": 409})
        self.assertEqual(self.o["badId"]["status"], 400)

    def test_park_and_back_to_the_garage(self):
        self.assertEqual(self.o["parkCall"]["u"], "/api/arena/vehicles/" + OWNED + "/park")
        self.assertEqual(self.o["parkCall"]["body"], {"world": "claude-hq@2", "x": 5, "z": -6, "yaw": 1})
        self.assertEqual(self.o["parkedNow"], {"world": "claude-hq@2", "x": 5, "z": -6, "yaw": 1})
        self.assertEqual(self.o["homeCall"]["body"], {"garage": True})
        self.assertIsNone(self.o["homeNow"])
        self.assertGreaterEqual(self.o["changes"], 4)


class Presence(unittest.TestCase):
    def test_the_page_sends_the_vehicle_only_where_known(self):
        hq = read("ui", "app", "22-hq.js")
        self.assertIn('(a===5 || a===6) && HQ3D.inst.vehicle && hqNetCan("vehicles")', hq)
        self.assertIn("msg.v=veh.v", hq)
        self.assertIn("msg.v,msg.vp,msg.bb,msg.bt,msg.ci,msg.cv,msg.cg,msg.vt,JSON.stringify(msg.pt||0),msg.vx,msg.vz,msg.yr,msg.rpm,msg.gl,JSON.stringify(msg.gn||0),JSON.stringify(msg.ta||0)].join", hq, "a paint (or tune, 3.13, or pets out, 3.14) change is sent at once")

    def test_hq3d_draws_a_peers_catalogue_vehicle(self):
        src = read("games", "hq3d.js")
        self.assertIn("inst.vehicle = function()", src)
        self.assertIn("P.v = typeof p.v === \"string\" && VEHICLES[p.v] && VEHICLES[p.v].cat", src)
        self.assertIn("HQV.hqVehicleModels.build(ctx, Vc, ph, {tune: ptn})", src)   # [3.13] in its tune

    def test_protocol_lists_vehicles(self):
        self.assertRegex(read("backend", "src", "protocol.rs"), r'"hq", 4, &\[[^\]]*"vehicles"[,\]]')
        self.assertIn("hq:[1,4]", read("games", "multi.js"))


if __name__ == "__main__":
    unittest.main()
