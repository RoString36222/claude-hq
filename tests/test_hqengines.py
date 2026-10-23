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


AUTO = r"""
const fs = require('fs'), path = require('path'), R0 = process.argv[1];
global.window = {HQV: {}}; eval(fs.readFileSync(path.join(R0, 'games', 'hqvehiclephys.js'), 'utf8'));
const P = window.HQV.hqVehiclePhys, cat = JSON.parse(fs.readFileSync(path.join(R0, 'games/vehicles/catalogue.json'), 'utf8'));
const m = cat.vehicles.find(x => x.id === 'bmw-m3-competition'), E = P.engineFor(m.spec, 'car', 'turbo6'), dt = 1/60;
// a simple longitudinal model: throttle pulls (times the gearbox's drive), brakes and engine braking slow it
function run(v0, g0, fn, secs){
  const G = P.gearState(E); G.gear = g0; G.rpm = v0*E.k[g0 - 1]; let v = v0; const log = [];
  for (let t = 0; t < secs; t += dt){
    const inp = fn(t, v), o = P.gearStep(G, Object.assign({speed: v}, inp), E, dt);
    v = Math.max(0, Math.min(o.cap, v + (inp.thr ? 6*o.drive*inp.thr : 0)*dt - (inp.brake ? 9 : (inp.thr ? 0 : 1 + o.engineBrake))*dt));
    log.push({t, v, g: G.gear, rpm: o.rpm, ev: o.events});
  }
  return log;
}
const out = {};
{ const L = run(150/3.6, 6, () => ({thr: 0, brake: true}), 6);           // braking from 150 to a stop
  const gears = L.map(x => x.g); out.brake = {first: gears[0], last: gears[gears.length - 1],
    monotonic: gears.every((g, i) => i === 0 || g <= gears[i - 1]),
    rpmMid: L.filter(x => x.v > 8).map(x => x.rpm).reduce((a, b) => Math.min(a, b), 1e9),
    downs: L.filter(x => x.ev.includes('down')).length}; }
{ const L = run(80/3.6, 8, () => ({thr: 1}), 0.4); out.kick = {gear: L[L.length - 1].g, first: L.findIndex(x => x.ev.includes('down'))}; }
{ const L = run(60/3.6, 2, () => ({thr: 0.25}), 4); out.cruise = {gear: L[L.length - 1].g, rpm: L[L.length - 1].rpm}; }
{ const L = run(120/3.6, 3, () => ({thr: 0}), 4); out.coast = {gear: L[L.length - 1].g, rpm: L[L.length - 1].rpm}; }
// steady speed, steady throttle: settles and stays (no hunting)
{ const G = P.gearState(E); G.gear = 2; let shifts = 0;
  for (let t = 0; t < 12; t += dt){ const o = P.gearStep(G, {speed: 70/3.6, thr: 0.3}, E, dt); if (t > 2) shifts += o.events.filter(e => e === 'up' || e === 'down').length; }
  out.steady = shifts; }
out.span = [E.idle, E.red, E.shiftUp];
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class AutomaticGearbox(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", AUTO, ROOT], capture_output=True, text=True, timeout=60)
        if r.returncode:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_braking_downshifts_all_the_way(self):
        b = self.o["brake"]
        self.assertEqual(b["first"], 6)
        self.assertEqual(b["last"], 1)
        self.assertTrue(b["monotonic"], "down a gear at a time, never back up while braking")
        self.assertGreaterEqual(b["downs"], 4)
        self.assertGreater(b["rpmMid"], 1500, "kept in the pulling band while braking, not lugging at idle")

    def test_kickdown_skips_straight_down(self):
        k = self.o["kick"]
        self.assertLessEqual(k["gear"], 4)
        self.assertLess(k["first"], 15, "within a quarter of a second")

    def test_part_throttle_cruises_in_a_tall_gear(self):
        c = self.o["cruise"]
        self.assertGreaterEqual(c["gear"], 4)
        self.assertLess(c["rpm"], 4200)

    def test_coasting_relaxes(self):
        c = self.o["coast"]
        self.assertGreaterEqual(c["gear"], 6)
        self.assertLess(c["rpm"], 2800)

    def test_no_hunting(self):
        self.assertLessEqual(self.o["steady"], 1)


INSANE = r"""
const fs = require('fs'), path = require('path'), R0 = process.argv[1];
global.window = {HQV: {}}; eval(fs.readFileSync(path.join(R0, 'games', 'hqvehiclephys.js'), 'utf8'));
const P = window.HQV.hqVehiclePhys, dt = 1/60, out = {};
// nitrous: about 4 s of it, then a refill
{ const N = {charge: 1}; let on = 0; for (let i = 0; i < 600; i++){ if (P.nitroStep(N, true, 1, 20, dt)) on++; else break; }
  out.nitroSecs = on*dt; out.empty = N.charge; out.dryRefire = P.nitroStep(N, true, 1, 20, dt); for (let i = 0; i < 60*20; i++) P.nitroStep(N, false, 1, 20, dt); out.refilled = N.charge;
  out.needsThrottle = P.nitroStep({charge: 1}, true, 0, 20, dt); }
// the performance timer: a steady 5 m/s^2 from a standstill
{ const T = {}; let v = 0, evs = []; P.perfStep(T, 0, dt);
  for (let i = 0; i < 60*20; i++){ v += 5*dt; evs = evs.concat(P.perfStep(T, v, dt)); }
  out.perf = evs.map(e => [e.kind, Math.round(e.t*100)/100]); }
// wheelies: held throttle in 1st loops out; feathered holds; stoppie at 12 m/s holds, at 25 goes over
// a wheelie let down (W and F released) lands: no stoppie from the bounce
{ const W = {p: 0, pv: 0}, ev = []; for (let i = 0; i < 240; i++){ const up = i < 60;
    P.wheelieStep(W, {trick: up, thr: up ? 1 : 0, speed: 10, gear: 1, rpmFrac: 0.7}, dt).events.forEach(e => ev.push(e.kind + ":" + e.trick)); }
  out.landing = {ev: ev, p: W.p}; }
function wsim(fn, n){ const W = {p: 0, pv: 0}, ev = []; let maxP = 0, minP = 0;
  for (let i = 0; i < n; i++){ const o = P.wheelieStep(W, fn(i), dt); o.events.forEach(e => ev.push(e.kind)); maxP = Math.max(maxP, W.p); minP = Math.min(minP, W.p); }
  return {ev, maxP, minP}; }
out.held = wsim(i => ({trick: true, thr: 1, speed: 10, gear: 1, rpmFrac: 0.6}), 180);
out.feather = wsim(i => ({trick: true, thr: (Math.floor(i/30) % 2) ? 0 : 1, speed: 10, gear: 1, rpmFrac: 0.6}), 600);
out.stoppie = wsim(i => ({trick: true, brake: true, speed: Math.max(0, 12 - i/30), gear: 2}), 400);
out.over = wsim(i => ({trick: true, brake: true, speed: 25, gear: 4}), 60);
out.stopped = wsim(i => ({trick: true, brake: true, speed: 0, gear: 1}), 120);
// drive modes: the automatic's choice at a light throttle, 70 km/h, in an M3
{ const cat = JSON.parse(fs.readFileSync(path.join(R0, 'games/vehicles/catalogue.json'), 'utf8')), m = cat.vehicles.find(x => x.id === 'bmw-m3-competition');
  const E = P.engineFor(m.spec, 'car', 'turbo6'), v = 70/3.6;
  out.modes = ['comfort', 'sport', 'track'].map(md => { const g = P.autoGear(E, E.k, v, 0.4, false, md); return [md, g, Math.round(v*E.k[g - 1])]; }); }
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class InsaneVehicles(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", INSANE, ROOT], capture_output=True, text=True, timeout=60)
        if r.returncode:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_nitrous(self):
        self.assertAlmostEqual(self.o["nitroSecs"], 4, delta=0.2)
        self.assertLess(self.o["empty"], 0.01)
        self.assertFalse(self.o["dryRefire"], "empty: it waits for a refill, no flicker")
        self.assertGreater(self.o["refilled"], 0.99)
        self.assertFalse(self.o["needsThrottle"])

    def test_performance_timer(self):
        p = dict(self.o["perf"])
        self.assertAlmostEqual(p["0-100"], 100/3.6/5, delta=0.05)
        self.assertAlmostEqual(p["0-200"], 200/3.6/5, delta=0.05)
        self.assertAlmostEqual(p["quarter"], (2*402.3/5)**0.5, delta=0.1)

    def test_wheelie_takes_skill(self):
        h, f = self.o["held"], self.o["feather"]
        self.assertIn("start", h["ev"]); self.assertIn("bail", h["ev"], "throttle held: it loops out")
        self.assertNotIn("bail", f["ev"], "feathered: it holds")
        self.assertGreater(f["maxP"], 0.8)

    def test_wheelie_lands_without_a_phantom_stoppie(self):
        self.assertEqual(self.o["landing"]["ev"], ["start:wheelie", "end:wheelie"])
        self.assertEqual(self.o["landing"]["p"], 0)

    def test_stoppie(self):
        s, o = self.o["stoppie"], self.o["over"]
        self.assertEqual(s["ev"], ["start", "end"])
        self.assertLess(s["minP"], -0.3)
        self.assertIn("bail", o["ev"], "too fast: over the bars")
        self.assertEqual(self.o["stopped"]["ev"], [], "nothing happens at a standstill")

    def test_drive_modes(self):
        (c, gc, rc), (s, gs, rs), (t, gt, rt) = self.o["modes"]
        self.assertGreaterEqual(gc, gs); self.assertGreaterEqual(gs, gt)
        self.assertLess(rc, rs); self.assertLess(rs, rt)

    def test_wiring(self):
        src = open(os.path.join(ROOT, "games", "hq3d.js")).read()
        for needle in ("PH.nitroStep(", "PH.wheelieStep(", "PH.perfStep(", "vfxFrame(t, dt)", "standShow(", 'E.sfx("crank")',
                       'E.sfx("horn"', "ride.burn", "modePref("):
            self.assertIn(needle, src)
        eng = open(os.path.join(ROOT, "games", "engine.js")).read()
        self.assertIn("horn: function(a, opt)", eng)
        self.assertIn("crank: function(a)", eng)
        vfx = open(os.path.join(ROOT, "games", "hqvfx.js")).read()
        self.assertNotIn("Math.random", vfx)
        self.assertNotIn("innerHTML", vfx)
