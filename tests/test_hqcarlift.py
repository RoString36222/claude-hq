"""The car lift (games/hqcarlift.js, HQ 3.4 "Basement Garage").

node runs the lift's ride (its phases, their lengths, Calm's short ride, the platform's height), the door hand-off
(carries: a carlift door while riding a car, motorbike or bicycle, never a board or a boat), the bay's spots (the
street apron faces away from the tower), the carpark duck type a basement-homed vehicle is called through, and builds
the mesh with the vendored three.js (its parts, its draw calls, update() moving the platform and the doors).
Skipped when node is not installed. Stdlib only."""
import json
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
for(const f of %(files)s) new Function(fs.readFileSync(root + "/games/" + f, "utf8"))();
const L = window.HQV.hqCarLift, out = {};
function run(o, dt){
  const s = L.create(o), seen = [s.phase], ys = [s.y]; let t = 0, guard = 0;
  while(!s.done && guard++ < 100000){ L.step(s, dt); t += dt; if(seen[seen.length - 1] !== s.phase) seen.push(s.phase); ys.push(s.y); }
  return {phases: seen, t: t, ys: ys, last: {y: s.y, doors: s.doors, p: s.p, floor: s.floor}};
}
// 1. phases and the total
const a = run({dir: "down", depth: 6, k: 1}, 1/60);
out.phases = a.phases; out.t = a.t; out.total = L.total(1); out.last = a.last;
const big = run({dir: "down", depth: 6, k: 1}, 2.5);           // a long frame carries over
out.bigPhases = big.phases; out.bigT = big.t;
// 2. Calm
out.calmTotal = L.total(0); out.calm = run({dir: "down", k: 0}, 1/60).t;
// 3. y in range and monotonic, both ways
function mono(ys, sgn){ for(let i = 1; i < ys.length; i++) if(sgn*(ys[i] - ys[i - 1]) < -1e-9) return false; return true; }
const up = run({dir: "up", depth: 6}, 1/30);
out.downRange = a.ys.every(y => y >= -6 - 1e-9 && y <= 0); out.downMono = mono(a.ys, -1);
out.upRange = up.ys.every(y => y >= -6 - 1e-9 && y <= 0); out.upMono = mono(up.ys, 1);
out.upStart = up.ys[0]; out.upEnd = up.last.y; out.downEnd = a.last.y;
// doors: open, shut while moving, open at the end
const s = L.create({dir: "down"}); const doors = [];
for(let i = 0; i < 400 && !s.done; i++){ L.step(s, 1/60); doors.push([s.phase, s.doors]); }
out.doorsMoving = doors.filter(d => d[0] === "moving").every(d => d[1] === 0);
out.doorsRange = doors.every(d => d[1] >= 0 && d[1] <= 1);
out.doorsEnd = s.doors;
out.neg = L.step(L.create({}), -5).phase;
// 4. carries
const lift = {view: "@basement", kind: "carlift"}, lobby = {view: "@basement", kind: "lift"};
out.carries = {
  car: L.carries("city", "basement", {kind: "car"}, lift), moto: L.carries("city", "basement", {kind: "moto"}, lift),
  bike: L.carries("city", "basement", {}, lift), own: L.carries("city", "basement", {kind: "porsche-911", b: {own: {key: "own:1"}}}, lift),
  walk: L.carries("city", "basement", null, lift), liftDoor: L.carries("city", "basement", {kind: "car"}, lobby),
  skate: L.carries("city", "basement", {kind: "skate"}, lift), boat: L.carries("city", "basement", {kind: "boat", b: {boat: 1}}, lift),
  heli: L.carries("city", "basement", {kind: "heli"}, lift), noDoor: L.carries("city", "basement", {kind: "car"}, null)
};
L.arm(lift); out.armedCarries = L.carries("city", "basement", {kind: "car"}); out.armed = L.armed() === lift;
L.arm(null); out.disarmed = L.armed() === null && !L.carries("city", "basement", {kind: "car"});
// 5. liftSite: the carpark's duck type, and its paths
const C = {home: {x: 40, y: 0, z: -12, yaw: 0.7}};
const K = L.liftSite(C, "u1"), cpFns = Object.keys(window.HQV.hqCarpark || {}).filter(k => typeof window.HQV.hqCarpark[k] === "function");
out.cpFns = cpFns; out.missing = cpFns.filter(k => typeof K.cp[k] !== "function");
const B = K.cp.bays(K.site), bay = B[0], ex = K.cp.exitPath(bay, K.site), en = K.cp.entryPath(bay, K.site), ent = K.cp.entrance(K.site);
out.nBays = B.length; out.exitStart = Math.hypot(ex[0].x - bay.x, ex[0].z - bay.z);
out.exitEnd = Math.hypot(ex[ex.length - 1].x - K.site.apron.x, ex[ex.length - 1].z - K.site.apron.z);
out.exitY = ex.every(p => p.y === 0); out.entryRev = JSON.stringify(en) === JSON.stringify(ex.slice().reverse());
out.entAtApron = Math.hypot(ent.x - K.site.apron.x, ent.z - K.site.apron.z);
out.bayFor = K.cp.bayFor(K.site, "u1", "own:1").x === bay.x;
let fired = null; L.onStored(ev => { fired = ev.o.key; }); out.storedRet = K.cp.stored(K.site, bay, {key: "own:7"}); out.fired = fired;
out.callShape = !!(window.HQV.hqCall && window.HQV.hqCall.poly && window.HQV.hqCall.poly(ex));
out.noHome = L.liftSite({}, "u1") === null && L.streetSpot({}) === null;
// 6. streetSpot faces away from the tower (the tower stands at the lot's middle, behind the door)
const sp = L.streetSpot(C), F = L.lotOf(C), fx = Math.sin(sp.yaw), fz = Math.cos(sp.yaw);
out.away = fx*(sp.x - F.p.x) + fz*(sp.z - F.p.z);
out.spotIsApron = Math.hypot(sp.x - K.site.apron.x, sp.z - K.site.apron.z);
const E = {x: 5, z: 5, rot: Math.PI, garage: {x: -13, z: 6.7, s: -1}}, sp2 = L.streetSpot(C, E);
out.away2 = Math.sin(sp2.yaw)*(sp2.x - 5) + Math.cos(sp2.yaw)*(sp2.z - 5);
out.pad = L.padLocal(); out.padSpot = L.padSpot(); out.padSpotL = L.padSpot({pad: {x: 3, z: 4, yaw: 1}});
// the mesh
const M = L.mesh({THREE}, {level: "G"}), Mb = L.mesh({THREE}, {level: "B1"});
out.mesh = {hasG: !!M.g, platform: !!M.platform, doors: !!(M.doors.L && M.doors.R), screen: !!M.screen, calls: M.drawCalls()};
const r = L.create({dir: "down"}); for(let i = 0; i < 120; i++) L.step(r, 1/60);   // into the ride
M.update(r, 1, 1); out.platY = M.platform.position.y; out.platYState = r.y;
Mb.update(r, 1, 1); out.platYB = Mb.platform.position.y;
const r0 = L.create({dir: "down"}); M.update(r0, 0, 0); const openX = M.doors.R.position.x, openW = M.doors.R.scale.x;
const r1 = L.create({dir: "down"}); while(r1.phase !== "moving") L.step(r1, 1/60); M.update(r1, 0, 0); const shutX = M.doors.R.position.x;
out.doorsSlide = openX > shutX && openW < M.doors.w/4 && openX + openW/2 <= M.size.w/2 + 1e-6;
M.setNight(true); M.dispose();
out.nullCtx = L.mesh(null) === null || true;
console.log(JSON.stringify(out));
"""


def run(files):
    js = HARNESS % {"root": json.dumps(ROOT), "files": json.dumps(files)}
    p = subprocess.run([NODE, "--input-type=module", "-e", js], capture_output=True, text=True, timeout=120)
    if p.returncode:
        raise AssertionError(p.stderr[-3000:])
    return json.loads(p.stdout.strip().splitlines()[-1])


@unittest.skipUnless(NODE, "node not installed")
class CarLiftTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = run(["hqmerge.js", "world.js", "hqnav.js", "hqcarpark.js", "hqcall.js", "hqcity.js", "hqcarlift.js"])

    def test_phases_and_total(self):
        o = self.o
        self.assertEqual(o["phases"], ["approach", "closing", "moving", "opening", "done"])
        self.assertAlmostEqual(o["total"], 0.4 + 0.8 + 3.0 + 0.8)
        self.assertLess(abs(o["t"] - o["total"]), 1 / 30)
        self.assertEqual(o["bigPhases"][-1], "done")
        self.assertLessEqual(o["bigT"], o["total"] + 2.5)
        self.assertEqual(o["neg"], "approach")

    def test_calm_is_instant(self):
        self.assertLessEqual(self.o["calmTotal"], 0.31)
        self.assertLess(self.o["calm"], 0.35)

    def test_height_range_and_monotonic(self):
        o = self.o
        for k in ("downRange", "downMono", "upRange", "upMono", "doorsMoving", "doorsRange"):
            self.assertTrue(o[k], k)
        self.assertEqual(o["upStart"], -6)
        self.assertEqual(o["upEnd"], 0)
        self.assertEqual(o["downEnd"], -6)
        self.assertEqual(o["doorsEnd"], 1)
        self.assertEqual(o["last"]["floor"], "B1")

    def test_carries(self):
        c = self.o["carries"]
        for k in ("car", "moto", "bike", "own"):
            self.assertTrue(c[k], k)
        for k in ("walk", "liftDoor", "skate", "boat", "heli", "noDoor"):
            self.assertFalse(c[k], k)
        self.assertTrue(self.o["armedCarries"] and self.o["armed"] and self.o["disarmed"])

    def test_lift_site_duck_type(self):
        o = self.o
        self.assertGreater(len(o["cpFns"]), 5)
        self.assertEqual(o["missing"], [])
        self.assertEqual(o["nBays"], 1)
        self.assertLess(o["exitStart"], 1e-6)
        self.assertLess(o["exitEnd"], 1e-6)
        self.assertTrue(o["exitY"] and o["entryRev"] and o["bayFor"] and o["callShape"])
        self.assertLess(o["entAtApron"], 1e-6)
        self.assertTrue(o["storedRet"])
        self.assertEqual(o["fired"], "own:7")
        self.assertTrue(o["noHome"])

    def test_street_spot_faces_away(self):
        o = self.o
        self.assertGreater(o["away"], 0)
        self.assertGreater(o["away2"], 0)
        self.assertLess(o["spotIsApron"], 1e-6)
        self.assertEqual({k: o["pad"][k] for k in ("x", "z", "w", "d")}, {"x": 13, "z": 6.7, "w": 7, "d": 6.2})
        self.assertEqual(o["padSpotL"]["x"], 3)
        self.assertAlmostEqual(o["padSpot"]["camYaw"], o["padSpot"]["yaw"] + 0.55)

    def test_mesh(self):
        m = self.o["mesh"]
        self.assertTrue(m["hasG"] and m["platform"] and m["doors"] and m["screen"])
        self.assertLessEqual(m["calls"], 20)
        self.assertAlmostEqual(self.o["platY"], self.o["platYState"])
        self.assertAlmostEqual(self.o["platYB"], self.o["platYState"] + 6)
        self.assertTrue(self.o["doorsSlide"])


if __name__ == "__main__":
    unittest.main()
