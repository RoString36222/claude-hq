"""Real revs and exhaust notes (games/hqvehiclephys.js engineFor, games/engine.js engineProfile/engineHz), run under node.

Every catalogue vehicle carries its researched engine (spec.engine: idle, redline, limiter, gear ratios, primary and
final drive, rear tyre, voice, exhaust tone). Checked: the figures are sane, the gearing reaches the vehicle's real
top speed at redline, a real profile plays the engine's own rpm, and the rev counter's scale fits.
"""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
SCRIPT = r"""
const fs = require('fs'), path = require('path'), R0 = process.argv[1];
global.window = {HQV: {}, addEventListener: function(){}}; global.self = window;
eval(fs.readFileSync(path.join(R0, 'games', 'hqvehiclephys.js'), 'utf8'));
const P = window.HQV.hqVehiclePhys, cat = JSON.parse(fs.readFileSync(path.join(R0, 'games/vehicles/catalogue.json'), 'utf8'));
const cls = {}; cat.classes.forEach(c => { cls[c.id] = c; });
const out = {v: []};
cat.vehicles.forEach(v => {
  const c = cls[v.class] || {}, kind = c.kind === 'bike' || /^bike/.test(v.class) ? 'bike' : 'car';
  const V = P.derive({kind, type: c.type, spec: v.spec, dims: v.dims, sound: v.sound}), E = V.engine;
  out.v.push({id: v.id, kind, eng: V.eng, E, gears: V.gears, top: v.spec.topKmh, researched: !!v.spec.engine, ratios: !!(v.spec.engine && v.spec.engine.ratios)});
});
console.log(JSON.stringify(out));
"""

@unittest.skipUnless(NODE, "node not installed")
class Engines(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", SCRIPT, ROOT], capture_output=True, text=True, timeout=60)
        if r.returncode:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_every_vehicle_has_sane_revs(self):
        for v in self.o["v"]:
            E = v["E"]
            if E["electric"]:
                self.assertGreater(E["motorMax"], 5000, v["id"])
                continue
            self.assertTrue(500 <= E["idle"] < E["red"] <= E["limit"] <= 16000, (v["id"], E))
            self.assertLessEqual(E["limit"] - E["red"], 800, v["id"])
            self.assertTrue(E["k"] and all(a > b for a, b in zip(E["k"], E["k"][1:])), (v["id"], "each gear taller than the last"))

    def test_the_research_is_in(self):
        missing = [v["id"] for v in self.o["v"] if not v["researched"]]
        self.assertEqual(missing, [], "every vehicle is researched")

    def test_real_gearing_reaches_its_top_speed(self):
        for v in self.o["v"]:
            if not v["ratios"]:
                continue
            E = v["E"]
            first, top = E["red"]/E["k"][0]*3.6, E["red"]/E["k"][-1]*3.6
            self.assertGreater(top, v["top"]*0.85, (v["id"], top))
            self.assertTrue(25 < first < 260, (v["id"], first))
            self.assertAlmostEqual(v["gears"][-1]*3.6, top, delta=1, msg=v["id"])   # gear speeds from the same gearing

    def test_famous_redlines(self):
        E = {v["id"]: v["E"] for v in self.o["v"]}
        self.assertEqual(E["bmw-m-1000-rr"]["limit"], 15100)
        self.assertEqual(E["lamborghini-temerario"]["red"], 10000)
        self.assertEqual(E["lamborghini-revuelto"]["red"], 9500)
        self.assertEqual(E["lamborghini-huracan-sto"]["red"], 8500)
        self.assertLessEqual(E["harley-davidson-fat-boy-114"]["red"], 6000)
        self.assertLessEqual(E["royal-enfield-classic-350"]["red"], 6500)


if __name__ == "__main__":
    unittest.main()


GEARBOX = r"""
const fs = require('fs'), path = require('path'), R0 = process.argv[1];
global.window = {HQV: {}}; eval(fs.readFileSync(path.join(R0, 'games', 'hqvehiclephys.js'), 'utf8'));
const P = window.HQV.hqVehiclePhys, cat = JSON.parse(fs.readFileSync(path.join(R0, 'games/vehicles/catalogue.json'), 'utf8'));
const m = cat.vehicles.find(v => v.id === 'bmw-m3-competition'), E = P.engineFor(m.spec, 'car', 'turbo6');
const dt = 1/60, out = {limit: E.limit, k: E.k};
function drive(G, v, inp, secs){ let o; for (let t = 0; t < secs; t += dt){ o = P.gearStep(G, Object.assign({speed: v}, inp), E, dt); } return o; }
// automatic, flat out: up at the redline, never past the limiter
{ const G = P.gearState(E); let v = 0, maxRpm = 0, ups = [];
  let prev = 0;
  for (let i = 0; i < 1800; i++){ const o = P.gearStep(G, {thr: 1, speed: v}, E, dt); v = Math.min(o.cap, v + 7*o.drive*dt);
    maxRpm = Math.max(maxRpm, o.rpm); if (o.events.includes('up')) ups.push(Math.round(prev)); prev = o.rpm; }
  out.auto = {gear: G.gear, maxRpm, ups}; }
// manual: up, down (rev-matched), a refused over-rev, neutral, the gear's limiter is its top speed
{ const G = P.gearState(E); G.manual = true; G.gear = 3;
  const v3top = E.limit/E.k[2];
  let o = drive(G, v3top + 5, {thr: 1}, 0.3); out.cap3 = o.cap; out.limiter = o.limiter; out.limDrive = o.drive;
  const v = 20;                                        // 72 km/h in 3rd (an M3 tops out 2nd near 88 km/h)
  o = drive(G, v, {thr: 0}, 0.5); const before = o.rpm;
  o = P.gearStep(G, {speed: v, thr: 0, down: true}, E, dt); out.down = o.events.slice(); out.gearAfterDown = G.gear;
  o = drive(G, v, {thr: 0}, 0.15); out.revMatch = [before, o.rpm, v*E.k[1]];
  G.gear = 4; o = drive(G, 60, {thr: 0}, 0.2);            // 216 km/h in 4th: 1st would over-rev
  G.gear = 2; o = P.gearStep(G, {speed: 60, thr: 0, down: true}, E, dt); out.refused = o.events.slice(); out.gearAfterRefuse = G.gear;
  G.gear = 1; o = P.gearStep(G, {speed: 0, thr: 0, down: true}, E, dt); out.neutral = G.gear;
  o = drive(G, 0, {thr: 1}, 1.5); out.freeRev = {rpm: o.rpm, limiter: o.limiter, drive: o.drive};
  // engine braking: harder in 2nd than in 6th at the same road speed
  G.gear = 2; const eb2 = drive(G, 20, {thr: 0}, 0.3).engineBrake; G.gear = 6; const eb6 = drive(G, 20, {thr: 0}, 0.3).engineBrake; out.eb = [eb2, eb6]; }
// the clutch: revs free while held; dumped at standstill with the revs up: a launch with wheelspin
{ const G = P.gearState(E); G.manual = true; G.gear = 1;
  let o = drive(G, 0, {thr: 1, clutch: true}, 1.0); out.clutchRpm = o.rpm; out.clutchDrive = o.drive;
  o = P.gearStep(G, {speed: 0, thr: 1, clutch: false}, E, dt); out.dump = {events: o.events.slice(), slip: o.slip, drive: o.drive}; }
// automatic launch control: brake and throttle at a standstill hold the revs, then release
{ const G = P.gearState(E);
  let o = drive(G, 0, {thr: 1, brake: true}, 1.0); out.lc = {launch: o.launch, rpm: o.rpm, drive: o.drive};
  o = P.gearStep(G, {speed: 0, thr: 1, brake: false}, E, dt); out.lcGo = {events: o.events.slice(), slip: o.slip}; }
// a toggle: manual and back; automatic never sits in neutral
{ const G = P.gearState(E); let o = P.gearStep(G, {toggle: true, speed: 0}, E, dt); out.toggle1 = o.events.slice();
  G.gear = 0; o = P.gearStep(G, {toggle: true, speed: 0}, E, dt); out.toggle2 = [o.events.slice(), G.gear]; }
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class Gearbox(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", GEARBOX, ROOT], capture_output=True, text=True, timeout=60)
        if r.returncode:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_automatic_shifts_at_the_redline_and_never_over_revs(self):
        a = self.o["auto"]
        self.assertGreaterEqual(a["gear"], 6)
        self.assertLessEqual(a["maxRpm"], self.o["limit"])
        self.assertTrue(all(r > 6000 for r in a["ups"]), a["ups"])

    def test_each_gear_tops_out_at_its_limiter(self):
        self.assertAlmostEqual(self.o["cap3"], self.o["limit"]/self.o["k"][2], places=6)
        self.assertTrue(self.o["limiter"])
        self.assertEqual(self.o["limDrive"], 0, "on the limiter nothing more reaches the wheels")

    def test_a_downshift_is_rev_matched(self):
        self.assertEqual(self.o["down"], ["down"])
        self.assertEqual(self.o["gearAfterDown"], 2)
        before, after, wheel = self.o["revMatch"]
        self.assertGreater(after, before + 1000)
        self.assertLess(abs(after - wheel), 200, "the revs meet the lower gear's within 0.15 s")

    def test_an_over_rev_is_refused_and_below_first_is_neutral(self):
        self.assertEqual(self.o["refused"], ["refused"])
        self.assertEqual(self.o["gearAfterRefuse"], 2)
        self.assertEqual(self.o["neutral"], 0)
        f = self.o["freeRev"]
        self.assertTrue(f["limiter"] and f["drive"] == 0 and f["rpm"] > self.o["limit"] - 400, f)

    def test_the_clutch_and_a_launch(self):
        self.assertGreater(self.o["clutchRpm"], self.o["limit"] - 400)
        self.assertEqual(self.o["clutchDrive"], 0)
        d = self.o["dump"]
        self.assertIn("launch", d["events"])
        self.assertGreater(d["slip"], 0.5)
        self.assertGreater(d["drive"], 1.2, "the kick of a clutch dump")

    def test_launch_control(self):
        self.assertTrue(self.o["lc"]["launch"])
        self.assertEqual(self.o["lc"]["drive"], 0)
        self.assertGreater(self.o["lc"]["rpm"], 3000)
        self.assertIn("launch", self.o["lcGo"]["events"])
        self.assertGreater(self.o["lcGo"]["slip"], 0.3)

    def test_engine_braking_is_harder_in_a_lower_gear(self):
        eb2, eb6 = self.o["eb"]
        self.assertGreater(eb2, eb6 + 0.5)

    def test_toggle(self):
        self.assertEqual(self.o["toggle1"], ["manual"])
        self.assertEqual(self.o["toggle2"], [["auto"], 1])

    def test_damage_is_opt_in(self):
        hud = open(os.path.join(ROOT, "games", "hqhud.js")).read()
        self.assertIn('damage: false}', hud)
        self.assertIn('check("damage", "Vehicle damage (dents, smoke)")', hud)
        src = open(os.path.join(ROOT, "games", "hq3d.js")).read()
        self.assertIn("if(!D || !drvGround() || !DRV.key || !dmgOn()) return;", src)
        self.assertIn("DRV.dmg = dmgOn() ? D.dmgLoad(DRV.key) : null;", src)


QS = r"""
const fs = require('fs'), path = require('path'), R0 = process.argv[1];
global.window = {HQV: {}}; eval(fs.readFileSync(path.join(R0, 'games', 'hqvehiclephys.js'), 'utf8'));
const P = window.HQV.hqVehiclePhys, cat = JSON.parse(fs.readFileSync(path.join(R0, 'games/vehicles/catalogue.json'), 'utf8'));
const E = id => { const v = cat.vehicles.find(x => x.id === id); return P.engineFor(v.spec, /^bike/.test(v.class) || id === 'starter-moto' ? 'bike' : 'car', v.sound); };
const out = {has: {}};
['bmw-s-1000-rr', 'ducati-panigale-v4-s', 'bmw-m3-competition', 'starter-car', 'starter-moto', 'royal-enfield-classic-350'].forEach(id => { out.has[id] = E(id).qs; });
function up(id, thr){ const e = E(id), G = P.gearState(e); G.manual = true; G.gear = 2;
  P.gearStep(G, {speed: 20, thr: thr}, e, 1/60); const o = P.gearStep(G, {speed: 20, thr: thr, up: true}, e, 1/60);
  const o2 = P.gearStep(G, {speed: 20, thr: thr}, e, 1/60); return {events: o.events, shiftT: G.shiftT, drive: o2.drive}; }
out.qs = up('bmw-s-1000-rr', 1); out.noqs = up('royal-enfield-classic-350', 1); out.lift = up('bmw-s-1000-rr', 0);
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class Quickshifter(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", QS, ROOT], capture_output=True, text=True, timeout=60)
        if r.returncode:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_who_has_one(self):
        h = self.o["has"]
        self.assertTrue(h["bmw-s-1000-rr"] and h["ducati-panigale-v4-s"] and h["bmw-m3-competition"])
        self.assertFalse(h["starter-car"] or h["starter-moto"] or h["royal-enfield-classic-350"])

    def test_a_quickshift_keeps_the_drive(self):
        q, n = self.o["qs"], self.o["noqs"]
        self.assertIn("qs", q["events"])
        self.assertLessEqual(q["shiftT"], 0.05)
        self.assertEqual(q["drive"], 1, "a 50 ms cut: the clutch never comes in")
        self.assertNotIn("qs", n["events"])
        self.assertLess(n["drive"], 0.5, "no quickshifter: the drive drops for the shift")

    def test_only_under_power(self):
        self.assertNotIn("qs", self.o["lift"]["events"])
