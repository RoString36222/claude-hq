"""The Commons' air base and carrier keep clear of the airfield (games/hqairbase.js, docs/plans/airport-spec.md 8).

hqairbase.js exports two pure helpers: clearOfAirfield(L, rect, buffer) and carrierSpot(sea.land, airportSite, L).
Node runs them on the airfield fixture (tests/fixtures/airfield_commons.json) and the Commons' doc (claude-hq@2, its
sea from games/ocean.js seaOf), and then builds the City's air side with the vendored three.js the way
hqcity3d does (o.airfield = L), to check where the base and the carrier really go. Python checks the numbers, and
measures the carrier's clearance from the keepOut capsule and corridors itself. Skipped without node."""
import gzip
import json
import math
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXT = os.path.join(ROOT, "tests", "fixtures", "airfield_commons.json")
NODE = shutil.which("node")

HARNESS = r"""
import fs from "fs";
import zlib from "zlib";
const root = %(root)s;
const THREE = await import(root + "/games/vendor/three-module.js");
globalThis.window = {HQV: {}};
for (const f of ["world", "ocean", "hqheli", "hqairbase"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const H = window.HQV, A = H.hqAirbase, out = {};
const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/claude-hq@2.json.gz")).toString("utf8"));
const L = JSON.parse(fs.readFileSync(root + "/tests/fixtures/airfield_commons.json", "utf8"));
const W = H.world.pack(raw), sea = H.ocean.seaOf(raw, null, 5), land = (x, z) => sea.land(x, z);
const site = raw.layers.sites.filter(s => s.kind === "airport")[0];
const R = (x, z, hw, hd, rot) => ({x, z, hw, hd, rot: rot || 0});

// the carrier: today's spot (no airfield) and the one clear of it
out.oldSpot = A.carrierSpot(land, site, null);
out.oldClear = A.clearOfAirfield(L, out.oldSpot, 40);
out.spot = A.carrierSpot(land, site, L);
out.spotClear = out.spot && A.clearOfAirfield(L, out.spot, 40);
out.spotWet = (function(){ var K = out.spot, c = Math.cos(K.rot), s = Math.sin(K.rot), wet = true;
  for(var u = -1; u <= 1; u += 0.25) for(var v = -1; v <= 1; v += 0.125){ var a = u*K.hw, b = v*K.hd; if(land(K.x + a*c + b*s, K.z - a*s + b*c)) wet = false; }
  return wet; })();
out.spotSame = JSON.stringify(A.carrierSpot(land, site, L)) === JSON.stringify(out.spot);
out.noSea = A.carrierSpot(null, site, L);

// clearOfAirfield: each footprint on its own (the rectangles are placed so only the one named is within 20 m)
out.cases = {
  platform: A.clearOfAirfield(L, R(-830, 0, 10, 10), 20),           // on the apron
  nearPlatform: A.clearOfAirfield(L, R(-744, -40, 20, 10), 20),     // 10 m east of the apron's edge (x -774)
  farPlatform: A.clearOfAirfield(L, R(-730, -40, 20, 10), 20),      // 24 m east of it
  skybridge: A.clearOfAirfield(L, R(-730, 30, 10, 10), 20),         // 16 m beside the skybridge's capsule (r 4)
  skybridgeOver: A.clearOfAirfield(L, R(-730, 0, 3, 3), 0),         // right on it, no buffer
  tower: A.clearOfAirfield(L, R(-715, -133, 5, 5), 20),             // 13 m outside the tower's 15 m circle
  asr: A.clearOfAirfield(L, R(-730, 143, 5, 5), 20),                // 13 m outside the ASR's
  terminal: A.clearOfAirfield(L, R(-620, 0, 4, 4), 0),
  forecourt: A.clearOfAirfield(L, R(-497, 40, 1, 1), 0),            // on its outer road (x -500, roadW 8)
  carpark: A.clearOfAirfield(L, R(-590, 60, 4, 4), 0),
  corridorN: A.clearOfAirfield(L, R(-800, 2000, 20, 20), 20),       // 195 m off the approach axis (r 250)
  corridorS: A.clearOfAirfield(L, R(-1200, -3000, 20, 20), 20),
  clearOfCorridor: A.clearOfAirfield(L, R(-700, 2000, 20, 20), 20),  // 295 m off it
  capsule: A.clearOfAirfield(L, R(-1015, 1300, 20, 20), 40),         // past the runway's end, inside the keepOut capsule
  turned: A.clearOfAirfield(L, R(-735, -40, 20, 10, 0.6), 20),      // turned, its corner reaches the apron's buffer
  noL: A.clearOfAirfield(null, R(-830, 0, 10, 10), 20),
  notOk: A.clearOfAirfield({ok: false, why: "no site"}, R(-830, 0, 10, 10), 20),
  city: A.clearOfAirfield(L, R(-200, 100, 56, 40), 20)
};

// the City's air side, built as hqcity3d builds it: without the airfield (as today), then with it
const c = {THREE, mat: (col, o) => new THREE.MeshStandardMaterial(Object.assign({color: col}, o || {}))};
function build(af){
  const X = A.create(c, new THREE.Group(), {W, sea, commons: true, airfield: af, civics: []}), b = X.base;
  const r = {base: b, carrier: X.carrier};
  if(b){ const q = {x: b.x, z: b.z, rot: b.rot, hw: 56, hd: 40}, co = Math.cos(b.rot), si = Math.sin(b.rot);
    r.clear20 = A.clearOfAirfield(L, q, 20);
    r.onLand = [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]].every(k => land(b.x + k[0]*56*co + k[1]*40*si, b.z - k[0]*56*si + k[1]*40*co));
    const f = site.front, fl = Math.hypot(f[0], f[1]); r.rotFront = Math.atan2(f[0]/fl, f[1]/fl) + Math.PI/2; }
  X.destroy();
  return r;
}
out.plain = build(null);
out.withL = build(L);
process.stdout.write(JSON.stringify({out, keepOut: L.keepOut}));
"""


def seg_dist(px, pz, a, b):
    dx, dz = b[0] - a[0], b[1] - a[1]
    l2 = dx*dx + dz*dz
    u = max(0.0, min(1.0, ((px - a[0])*dx + (pz - a[1])*dz)/l2)) if l2 else 0.0
    return math.hypot(px - a[0] - dx*u, pz - a[1] - dz*u)


def rect_points(K, step=2.0):
    # every point of the rectangle's outline and inside, at <= step m
    c, s = math.cos(K["rot"]), math.sin(K["rot"])
    nu, nv = int(2*K["hw"]/step) + 1, int(2*K["hd"]/step) + 1
    for i in range(nu + 1):
        for j in range(nv + 1):
            a = -K["hw"] + 2*K["hw"]*i/nu
            b = -K["hd"] + 2*K["hd"]*j/nv
            yield K["x"] + a*c + b*s, K["z"] - a*s + b*c


@unittest.skipUnless(NODE, "node not installed")
class AirbaseSpotTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        js = HARNESS % {"root": json.dumps(ROOT)}
        r = subprocess.run([NODE, "--input-type=module", "-e", js], capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            raise AssertionError(r.stderr)
        o = json.loads(r.stdout)
        cls.o, cls.keep = o["out"], o["keepOut"]

    def clearance(self, K):
        # m from the rectangle to the nearest keepOut shape (capsule and corridors), past its radius
        m = math.inf
        for C in [self.keep["capsule"]] + self.keep["corridors"]:
            for x, z in rect_points(K):
                m = min(m, seg_dist(x, z, C["a"], C["b"]) - C["r"])
        return m

    def test_todays_carrier_spot_is_rejected(self):
        old = self.o["oldSpot"]
        self.assertAlmostEqual(old["x"], -1160, delta=1)
        self.assertAlmostEqual(old["z"], 0, delta=1)
        self.assertFalse(self.o["oldClear"])
        self.assertLess(self.clearance(old), 0)                    # it sat on the runway's keepOut

    def test_carrier_spot_clears_keep_out(self):
        K = self.o["spot"]
        self.assertIsNotNone(K)
        self.assertTrue(self.o["spotClear"])
        self.assertTrue(self.o["spotWet"])
        self.assertTrue(self.o["spotSame"])                        # deterministic
        self.assertEqual((K["hw"], K["hd"]), (24, 140))            # the 48 x 280 m deck
        self.assertGreaterEqual(self.clearance(K), 40 - 0.5)       # buffered 40 m (sampled at 2 m)
        self.assertIsNone(self.o["noSea"])

    def test_clear_of_airfield_rejects_overlaps(self):
        c = self.o["cases"]
        for k in ("platform", "nearPlatform", "skybridge", "skybridgeOver", "tower", "asr", "terminal", "forecourt",
                  "carpark", "corridorN", "corridorS", "capsule", "turned"):
            self.assertFalse(c[k], k)
        for k in ("farPlatform", "clearOfCorridor", "noL", "notOk", "city"):
            self.assertTrue(c[k], k)

    def test_capsule_matches_the_fixture(self):
        with open(FIXT, encoding="utf-8") as f:
            L = json.load(f)
        self.assertEqual(self.keep, L["keepOut"])
        self.assertEqual(len(self.keep["corridors"]), 2)

    def test_city_air_side(self):
        p, w = self.o["plain"], self.o["withL"]
        # without the airfield: as before (the carrier at its old spot)
        self.assertAlmostEqual(p["carrier"]["x"], -1160, delta=1)
        # with it: the base on land, 20 m off every footprint; rot from the site's front; the carrier clear
        self.assertIsNotNone(w["base"])
        self.assertTrue(w["clear20"])
        self.assertTrue(w["onLand"])
        self.assertAlmostEqual(math.remainder(w["base"]["rot"] - w["rotFront"], math.pi/2), 0, places=6)
        K = w["carrier"]
        self.assertAlmostEqual(K["x"], self.o["spot"]["x"], places=6)
        self.assertAlmostEqual(K["z"], self.o["spot"]["z"], places=6)
        self.assertAlmostEqual(K["yaw"], self.o["spot"]["rot"], places=6)


if __name__ == "__main__":
    unittest.main()
