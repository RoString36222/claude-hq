"""games/hqgondola.js: the gondola G1 (HQ 3.15, plan 3.4 / 5.3 / 5.4), run under node.

A synthetic layers.gondola (cm): a summit line up a hill over three lattice towers, with a fake heightAt (the hill,
and a knoll under one span). Checks: cabins every 18 s, 90 m apart on the rope at 5 m/s, 0.3 m/s through the
stations round the bull wheel, a loop that is a whole number of 18 s, the rope as a catenary with 2 % sag (less only
where a cabin would come within 3 m of the ground), cabins never below that clearance, the two facing benches of 4,
trips and departures, the seeded wind sway (none under Calm), and (with the vendored three.js) the view: three draw
calls, the screenshot cameras, a clunk at each tower (your cabin's, and every cabin's within earshot, each at its grip),
the bull wheel's rumble and the wind placed where they are, and no sway under Calm. Also runs
tests/fixtures/world_v3_tiny.json (a crossing) and the @3 fixtures when present (skipped while their gondola layer is
empty).
"""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
SCRIPT = r"""
const fs = require('fs'), zlib = require('zlib'), path = require('path'), R0 = process.argv[1];
global.window = {HQV: {}}; global.self = window;
for (const f of ['world.js', 'hqride.js', 'hqcommute.js', 'hqgondola.js']) eval(fs.readFileSync(path.join(R0, 'games', f), 'utf8'));
const WD = window.HQV.world, G = window.HQV.hqGondola, RD = window.HQV.hqRide, out = {};
// the hill: 5 m at the valley station (z = 0) up to 120 m at the summit (z = 600); a knoll under the middle span
const hill = (x, z) => 5 + 115*Math.max(0, Math.min(1, z/600));
const knoll = (x, z) => hill(x, z) + Math.max(0, 16 - Math.abs(z - 375)/4);
const cm = v => Math.round(v*100);
const W = {id: 'hill@3', gondola: {lines: [{id: 'G1', kind: 'summit', tier: 1,
  stations: [{id: 'gondola:0', x: 0, y: cm(5), z: 0, front: [0, 65536]}, {id: 'gondola:1', x: 0, y: cm(120), z: cm(600), front: [0, -65536]}],
  towers: [[60, 16], [250, 22], [450, 24], [560, 12]].map(q => ({x: 0, y: cm(hill(0, q[0])), z: cm(q[0]), h: cm(q[1])}))}]}};
const sim = G.create(W, {seed: 'g', heightAt: hill}), simK = G.create(W, {seed: 'g', heightAt: knoll}), L = sim.loop();
out.loop = L; out.n18 = L.T/18;
// cabins: spacing on the rope, speeds, continuity, doors only in the stations
const ms = 1.7e12;
let gaps = [], vRope = new Set(), vSlow = 1e9, vMax = 0, jump = 0, doorsOut = 0, prev = null;
for (let t = 0; t < L.T; t += 0.5) {
  const cs = sim.cabins(ms + t*1000), up = cs.filter(c => c.leg === 'out').map(c => c.d).sort((a, b) => a - b);
  for (let i = 1; i < up.length; i++) gaps.push(up[i] - up[i - 1]);
  cs.forEach(c => { if (c.station < 0) vRope.add(Math.round(c.speed*1000)/1000); else vSlow = Math.min(vSlow, c.speed); vMax = Math.max(vMax, c.speed); if (c.station < 0 && c.doors) doorsOut++; });
}
for (let t = 0; t < L.T; t += 0.05) { const p = sim.at(t); if (prev) jump = Math.max(jump, Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z)); prev = p; }
out.cab = {gapMin: Math.min(...gaps), gapMax: Math.max(...gaps), vRope: [...vRope], vSlow, vMax, jump, doorsOut, n: sim.cabins(ms).length};
// departures every 18 s from both stations
const dv = sim.departures('gondola:0', ms, 4), dS = sim.departures('gondola:1', ms, 4);
out.deps = {gaps: dv.slice(1).map((d, i) => d.at - dv[i].at), first: dv[0].at - ms, to: dv[0].to, toS: dS[0].to, short: dv[0].short};
// the rope: tower tops, the 2 % sag at mid-span, the knoll tensioning its span
out.spans = sim.spans(); out.spansK = simK.spans();
out.supports = sim.supports();
out.mid = sim.spans().map(s => { const m = (s.a + s.b)/2; return (s.ya + s.yb)/2 - sim.ropeAt(m); });
out.clear = sim.clearance(hill); out.clearK = simK.clearance(knoll);
// the whole loop's cabin bottoms over the ground away from the stations
let low = 1e9; for (let t = 0; t < L.T; t += 0.25) { const p = simK.at(t); if (p.station < 0 && p.d > 20 && p.d < 580) low = Math.min(low, p.y - knoll(p.x, p.z)); }
out.lowK = low;
// trips: valley -> summit, boarding at 0.3 m/s, 5 m/s on the rope; the summit flag for the achievement
const t1 = sim.trip('G1', 'gondola:0', 'gondola:1', ms), t2 = sim.trip('G1', 'gondola:1', 'gondola:0', ms);
const midT = (t1.depart + t1.reach)/2;
out.trip = {arrive: t1.arrive - ms, depart: t1.depart - ms, ride: (t1.reach - t1.depart)/1000, summit: t1.summit, summit2: t2.summit, seats: t1.seats, standing: t1.standing,
  vBoard: t1.pose((t1.arrive + t1.depart)/2).speed, doorsBoard: t1.pose((t1.arrive + t1.depart)/2).doors, vMid: t1.pose(midT).speed, doorsMid: t1.pose(midT).doors,
  endD: Math.hypot(t1.pose(t1.reach).x, t1.pose(t1.reach).z - 600), ride2: (t2.reach - t2.depart)/1000, bad: sim.trip('G1', 'gondola:0', 'gondola:0', ms),
  seatSpan: (() => { let m = 0; for (let i = 0; i < 8; i++) { const s = t1.seat(i, midT), p = t1.pose(midT); m = Math.max(m, Math.hypot(s.x - p.x, s.z - p.z)); } return m; })()};
out.seats = G.SEATS;
// sway: seeded, gentle, none under Calm or without wind
out.sway = {calm: G.swayAt(3, ms, 1, true, 's'), still: G.swayAt(3, ms, 0, false, 's'), a: G.swayAt(3, ms, 1, false, 's'), b: G.swayAt(3, ms, 1, false, 's'), c: G.swayAt(4, ms, 1, false, 's')};
let sw = 0; for (let t = 0; t < 60; t += 0.1) sw = Math.max(sw, Math.abs(G.swayAt(1, ms + t*1000, 1, false, 's').roll)); out.swayMax = sw;
// the planner: the summit by gondola
RD.register(sim); out.plan = RD.plan({x: 5, z: 5}, {x: 5, z: 590}, ms).map(p => p.legs.map(l => l.mode));
// fixtures
const tiny = WD.pack(JSON.parse(fs.readFileSync(path.join(R0, 'tests/fixtures/world_v3_tiny.json'))));
const gt = G.create(tiny, {}); out.tiny = {kind: gt.kind, n: gt.lines().length, trip: !!gt.trip('G1', 'gondola:0', 'gondola:1', ms), clear: gt.clearance()};
out.empty = G.create({id: 'none'}, {}).lines().length;
const fx = path.join(R0, 'tests/fixtures/island@3.json.gz');
if (fs.existsSync(fx)) { const Wf = WD.pack(JSON.parse(zlib.gunzipSync(fs.readFileSync(fx)))), gf = G.create(Wf, {}); out.fix = {n: gf.lines().length, clear: gf.lines().length ? gf.clearance() : null}; }
console.log(JSON.stringify(out));
"""

VIEW = r"""
import fs from 'fs'; import path from 'path'; import url from 'url';
const R0 = process.argv[2];
const THREE = await import(url.pathToFileURL(R0 + '/games/vendor/three-module.js').href);
globalThis.window = {HQV: {}}; globalThis.self = globalThis.window;
for (const f of ['world.js', 'hqride.js', 'hqweather.js', 'hqrail.js', 'hqgondola.js']) (new Function(fs.readFileSync(path.join(R0, 'games', f), 'utf8')))();
const H = window.HQV, W = H.world.pack(JSON.parse(fs.readFileSync(path.join(R0, 'tests/fixtures/world_v3_tiny.json'))));
const scene = new THREE.Scene(), c = {THREE, scene, mat: (col, o) => new THREE.MeshStandardMaterial(Object.assign({color: col}, o || {}))};
H.hqWeather.look = () => ({wind: 1});                                  // a gale, so the sway shows
const sim = H.hqGondola.create(W, {seed: 'v'});
let calm = false, cur = 0; const sounds = [];
const V = H.hqGondola.view(c, sim, {ground: (x, z) => H.world.groundAt(W, x, z), calm: () => calm, sfx: (n, o) => sounds.push({n, o: o || {}, ms: cur})});
const ms = 1.7e12, L = sim.loop(), out = {};
V.focus('G1:0');
for (let t = 0; t < L.T; t += 0.5) { cur = ms + t*1000; V.update(cur, 0.5, {x: -180, z: 100}); }
out.calls = V.drawCalls();
// each clunk is at a cabin's grip: yours (G1:0) at each tower both ways, and every other cabin's within earshot
const clunks = sounds.filter(s => s.n === 'gondola-clunk'), F = sim.frame();
const atCab = (s, i) => { const p = sim.cabins(s.ms)[i]; return !!s.o.pos && Math.hypot(s.o.pos.x - p.x, s.o.pos.z - p.z) < 1e-6 && Math.abs(s.o.pos.y - p.y - H.hqGondola.HANG) < 1e-6; };
const rum = sounds.filter(s => s.n === 'gondola-rumble'), wind = sounds.filter(s => s.n === 'gondola-wind');
out.sounds = {clunk: clunks.filter(s => atCab(s, 0)).length, all: clunks.length, n: L.n, towers: sim.supports().filter(s => s.kind === 'tower').length,
  atSome: clunks.every(s => sim.cabins(s.ms).some((p, i) => atCab(s, i))), clunkKinds: [...new Set(clunks.map(s => s.o.kind))],
  rumble: rum.length, rumbleKinds: [...new Set(rum.map(s => s.o.kind))], rumbleFromA: rum.length ? Math.hypot(rum[0].o.pos.x - F.A.x, rum[0].o.pos.z - F.A.z) : null,
  wind: wind.length, windKinds: [...new Set(wind.map(s => s.o.kind))], unplaced: sounds.filter(s => !s.o.pos).length};
const cabs = scene.getObjectByName('gondola').children.filter(o => o.isInstancedMesh)[0], m = new THREE.Matrix4(), e = new THREE.Euler();
function maxRoll(){ let r = 0; for (let i = 0; i < cabs.count; i++) { cabs.getMatrixAt(i, m); e.setFromRotationMatrix(m, 'YXZ'); r = Math.max(r, Math.abs(e.z), Math.abs(e.x)); } return r; }
V.update(ms + 7000, 0.016, {x: 0, z: 0}); out.rollWind = maxRoll();
calm = true; V.update(ms + 7000, 0.016, {x: 0, z: 0}); out.rollCalm = maxRoll();
out.shots = ['gondola-line', 'gondola-cabin', 'gondola-summit', 'nope'].map(n => V.tools.shotCam(n));
V.dispose(); out.left = scene.children.length;
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class GondolaTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", SCRIPT, ROOT], capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout)

    def test_loop_is_whole_headways(self):
        o = self.o
        self.assertEqual(o["n18"], o["loop"]["n"])
        self.assertEqual(o["cab"]["n"], o["loop"]["n"])
        self.assertGreaterEqual(o["loop"]["straight"], 6)

    def test_cabin_spacing_and_speeds(self):
        c = self.o["cab"]
        self.assertAlmostEqual(c["gapMin"], 90, delta=0.01, msg="every 18 s at 5 m/s")
        self.assertAlmostEqual(c["gapMax"], 90, delta=0.01)
        self.assertEqual(c["vRope"], [5])
        self.assertAlmostEqual(c["vSlow"], 0.3, delta=1e-6, msg="0.3 m/s round the bull wheel")
        self.assertLessEqual(c["vMax"], 5.0001)
        self.assertLess(c["jump"], 0.3, "no jumps along the loop")
        self.assertEqual(c["doorsOut"], 0, "doors open only in a station")

    def test_departures(self):
        d = self.o["deps"]
        self.assertEqual(d["gaps"], [18000, 18000, 18000])
        self.assertTrue(0 <= d["first"] < 18000)
        self.assertEqual(d["short"], "G1")
        self.assertNotEqual(d["to"], d["toS"])

    def test_catenary_sag(self):
        o = self.o
        self.assertEqual([s["kind"] for s in o["supports"]], ["station", "tower", "tower", "tower", "tower", "station"])
        for s, m in zip(o["spans"], o["mid"]):
            self.assertAlmostEqual(m, 0.02*s["len"], delta=0.01, msg="2 % of the span at its middle")
        tops = [s["y"] for s in o["supports"][1:-1]]
        for got, want in zip(tops, [5 + 115*60/600 + 16, 5 + 115*250/600 + 22, 5 + 115*450/600 + 24, 5 + 115*560/600 + 12]):
            self.assertAlmostEqual(got, want, delta=0.01, msg="the rope over each tower's sheaves")
        # the knoll under the third span: its rope is tensioned (less sag), the others keep 2 %
        sk = [s["sag"] for s in o["spansK"]]
        self.assertLess(sk[2], 0.02*o["spansK"][2]["len"])
        self.assertAlmostEqual(sk[1], 0.02*o["spansK"][1]["len"], delta=0.01)

    def test_cabins_clear_the_ground(self):
        self.assertGreaterEqual(self.o["clear"], 3)
        self.assertGreaterEqual(self.o["clearK"], 3 - 0.01)
        self.assertGreaterEqual(self.o["lowK"], 3 - 0.3)     # sampled every 1.25 m over a sharp knoll

    def test_trips(self):
        t = self.o["trip"]
        self.assertTrue(0 <= t["arrive"] < t["depart"])
        self.assertTrue(t["summit"])
        self.assertFalse(t["summit2"])
        self.assertEqual((t["seats"], t["standing"]), (8, 0))
        self.assertAlmostEqual(t["vBoard"], 0.3, delta=1e-6)
        self.assertEqual(t["doorsBoard"], 1)
        self.assertEqual((t["vMid"], t["doorsMid"]), (5, 0))
        self.assertLess(t["endD"], 25, "you step off at the summit")
        self.assertTrue(120 < t["ride"] < 200, t["ride"])
        self.assertAlmostEqual(t["ride2"], t["ride"], delta=0.01)
        self.assertIsNone(t["bad"])
        self.assertLess(t["seatSpan"], 1.3, "the benches inside the cabin")

    def test_two_facing_benches(self):
        s = self.o["seats"]
        self.assertEqual(len(s), 8)
        self.assertEqual(sum(1 for q in s if q["back"]), 4)
        self.assertEqual(sorted(set(q["z"] for q in s)), [-0.62, 0.62])
        self.assertTrue(all((q["z"] < 0) != q["back"] for q in s), "each bench faces the other")

    def test_sway(self):
        w = self.o["sway"]
        self.assertEqual(w["calm"], {"roll": 0, "pitch": 0})
        self.assertEqual(w["still"], {"roll": 0, "pitch": 0})
        self.assertEqual(w["a"], w["b"])
        self.assertNotEqual(w["a"], w["c"])
        self.assertTrue(0.01 < self.o["swayMax"] <= 0.05)

    def test_planner_and_fixtures(self):
        self.assertTrue(any("gondola" in p for p in self.o["plan"]))
        t = self.o["tiny"]
        self.assertEqual((t["kind"], t["n"], t["trip"]), ("crossing", 1, True))
        self.assertEqual(self.o["empty"], 0)
        f = self.o.get("fix")
        if not f:
            self.skipTest("tests/fixtures/island@3.json.gz not there yet")
        if not f["n"]:
            self.skipTest("the @3 fixture carries no gondola yet (layers.gondola is empty)")
        self.assertGreaterEqual(f["clear"], 3 - 0.05)

    def test_view(self):
        r = subprocess.run([NODE, "--input-type=module", "-e", VIEW, "x", ROOT], capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            raise AssertionError(r.stderr)
        v = json.loads(r.stdout)
        self.assertEqual(v["calls"], 3)
        s = v["sounds"]
        self.assertEqual(s["clunk"], 2*2, "your cabin: a clunk at each of the two towers, both ways")
        # both towers are within earshot here: every cabin clunks at each, both ways, once a loop, at its own grip
        self.assertEqual(s["all"], s["n"] * s["towers"] * 2)
        self.assertTrue(s["atSome"])
        self.assertEqual(s["clunkKinds"], ["gondola"])
        self.assertGreater(s["rumble"], 0)
        self.assertEqual(s["rumbleKinds"], ["gondola"])
        self.assertLess(s["rumbleFromA"], 25, "the rumble comes from the bull wheel of the station beside the camera")
        self.assertGreater(s["wind"], 0, "a gale, high up: the wind round your cabin")
        self.assertEqual(s["windKinds"], ["rain"], "weather: the ambient bed")
        self.assertEqual(s["unplaced"], 0, "every gondola sound is where it is")
        self.assertGreater(v["rollWind"], 0.005)
        self.assertLess(v["rollWind"], 0.06)
        self.assertLess(v["rollCalm"], 1e-9, "Calm: no sway")
        self.assertTrue(all(s for s in v["shots"][:3]))
        self.assertIsNone(v["shots"][3])
        self.assertEqual(v["left"], 0)


if __name__ == "__main__":
    unittest.main()
