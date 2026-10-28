"""games/hqcityrail.js: the City Line (HQ 3.15, plan 3.4 / 5.3 / 5.4), run under node.

A synthetic layers.rail (cm): the line from Central over a river bridge to the Airport, elevated 9 m over a sloping
ground, four stations listed out of order. Checks: the timetable (every 240 s each way, 40 s dwell, termini one way
only, deterministic per seed), the station order, the run (25 m/s top speed, standing at every platform), the twin
track, the viaduct's height along the path, the 2+2 seats, the planner, and (with the vendored three.js) the view's
draw calls and screenshot cameras, the whole City Line + Island Link + gondola budget (14) included. Runs on
tests/fixtures/world_v3_tiny.json and, when present, the @3 fixtures (skipped while their rail layer is empty).
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
for (const f of ['world.js', 'hqride.js', 'hqcommute.js', 'hqrail.js', 'hqcityrail.js']) eval(fs.readFileSync(path.join(R0, 'games', f), 'utf8'));
const WD = window.HQV.world, CR = window.HQV.hqCityRail, RD = window.HQV.hqRide, RL = window.HQV.hqRail, out = {};
const g = (x, z) => 2 + 0.01*x;                                         // the ground (m)
const V = [[-60, 0], [300, 0], [360, 0], [500, 0], [500, 400], [500, 700]];
const cm = v => Math.round(v*100);
const W = {id: 'synth@3', rail: {
  lines: [{id: 'CL', kind: 'city', stations: ['rail:2', 'rail:0', 'rail:3', 'rail:1'], path: V.map(p => [cm(p[0]), cm(g(p[0], p[1]) + 9), cm(p[1])]),
           kinds: ['viaduct', 'bridge', 'viaduct', 'viaduct', 'viaduct'], tier: 1}],
  stations: [[2, 500, 300], [0, 0, 0], [3, 500, 640], [1, 450, 0]].map(q => ({id: 'rail:' + q[0], kind: 'elevated', x: cm(q[1]), y: cm(g(q[1], q[2]) + 9), z: cm(q[2]),
             along: [0, 65536], len: 7000, platforms: 2, lines: ['CL'], stairs: [[cm(q[1] + 12), cm(q[2] + 5)]]})),
  sea: null, holes: []}};
const sim = CR.create(W, {seed: 'w1'}), sim2 = CR.create(W, {seed: 'w1'}), simB = CR.create(W, {seed: 'other'});
const ms = 1.7e12;
out.lines = sim.lines(); out.stops = sim.stops().map(s => [s.id, Math.round(s.y*100)/100]);
const dep = id => sim.departures(id, ms, 4).map(d => [d.at - ms, d.plat, d.to, d.short]);
out.deps = {s0: dep('rail:0'), s1: dep('rail:1'), s3: dep('rail:3'), same: JSON.stringify(dep('rail:1')) === JSON.stringify(sim2.departures('rail:1', ms, 4).map(d => [d.at - ms, d.plat, d.to, d.short])),
            other: JSON.stringify(dep('rail:1')) !== JSON.stringify(simB.departures('rail:1', ms, 4).map(d => [d.at - ms, d.plat, d.to, d.short])),
            gap: (() => { const a = sim.departures('rail:0', ms, 3); return a[1].at - a[0].at; })(), none: sim.departures('nope', ms, 4).length};
function run(a, b){
  const t = sim.trip('CL', a, b, ms); if (!t) return null;
  let vmax = 0, back = 0, prevS = null, lat = 0;
  const R = sim.track('CL');
  for (let m = t.depart; m <= t.reach; m += 250) {
    const p = t.pose(m); vmax = Math.max(vmax, p.speed);
    const v = sim.vehicles(m).filter(x => x.id === t.vehicle)[0];
    if (v) { if (prevS != null && (v.s - prevS)*v.sgn < -1e-6) back++; prevS = v.s;
      const c = RL.at(R, v.s), rx = -Math.cos(v.yaw), rz = Math.sin(v.yaw); lat = Math.max(lat, Math.abs((v.x - c.x)*rx + (v.z - c.z)*rz - 2)); }
  }
  const atStops = t.stops.map(s => { const st = sim.stops().filter(q => q.id === s.id)[0], p = t.pose(s.at); return Math.hypot(p.x - st.x, p.z - st.z); });
  const seats = []; for (let i = 0; i < t.seats; i++) { const sp = t.seat(i, t.depart + 30000), pp = t.pose(t.depart + 30000); seats.push({d: Math.hypot(sp.x - pp.x, sp.z - pp.z), y: sp.y - pp.y}); }
  return {stops: t.stops.map(s => s.id), times: t.stops.map(s => (s.at - t.depart)/1000), dwell: (t.depart - t.arrive)/1000, ride: (t.reach - t.depart)/1000,
          vmax, back, lat, atStops, seats: t.seats, standing: t.standing, seatMaxD: Math.max(...seats.map(s => s.d)), seatY: [Math.min(...seats.map(s => s.y)), Math.max(...seats.map(s => s.y))],
          doorsAtDep: t.pose(t.depart - 1000).doors, doorsMid: t.pose((t.depart + t.reach)/2).doors, short: t.short, mode: t.mode};
}
out.out = run('rail:0', 'rail:3'); out.back = run('rail:3', 'rail:0'); out.hop = run('rail:1', 'rail:2'); out.bad = sim.trip('CL', 'rail:0', 'rail:0', ms);
const runs = sim.runs('CL').out, legs = []; for (let i = 1; i < runs.s.length; i++) legs.push(CR.legTime(Math.abs(runs.s[i] - runs.s[i - 1])));
out.legSum = legs.reduce((a, b) => a + b, 0) + 2*40;
out.clear = sim.clearance('CL', g);
// seats: 2+2 in rows, the cabs and car 1's luggage end without
const S = RL.SEATS, rows = {}; S.forEach(s => { const k = s.car + ':' + s.z; rows[k] = (rows[k] || 0) + 1; });
out.seats = {n: S.length, rows: [...new Set(Object.values(rows))], car: [0, 1, 2, 3].map(c => S.filter(s => s.car === c).length),
             lug: S.filter(s => s.car === 0 && s.z < -4).length, back: S.filter(s => s.back).length, win: S.filter(s => s.window).length, maxX: Math.max(...S.map(s => Math.abs(s.x)))};
// the planner rides it
RD.register(sim);
const pl = RD.plan({x: 0, z: 12}, {x: 500, z: 650}, ms);
out.plan = pl.map(p => p.legs.map(l => l.mode + ':' + (l.short || '')));
// the tiny @3 fixture and, when there, the real ones
const tiny = WD.pack(JSON.parse(fs.readFileSync(path.join(R0, 'tests/fixtures/world_v3_tiny.json'))));
const st = CR.create(tiny, {}); out.tiny = {lines: st.lines().length, stops: st.stops().length, trip: !!st.trip('CL', 'rail:0', 'rail:1', ms)};
const fx = path.join(R0, 'tests/fixtures/claude-hq@3.json.gz');
if (fs.existsSync(fx)) {
  const Wf = WD.pack(JSON.parse(zlib.gunzipSync(fs.readFileSync(fx)))), sf = CR.create(Wf, {}), L = sf.lines();
  out.fix = {lines: L.length, stops: sf.stops().length, trip: L.length ? !!sf.trip(L[0].id, L[0].stops[0], L[0].stops[L[0].stops.length - 1], ms) : null,
             clear: L.length ? sf.clearance(L[0].id, (x, z) => WD.groundAt(Wf, x, z)) : null};
}
console.log(JSON.stringify(out));
"""

VIEW = r"""
import fs from 'fs'; import path from 'path'; import url from 'url';
const R0 = process.argv[2];
const THREE = await import(url.pathToFileURL(R0 + '/games/vendor/three-module.js').href);
globalThis.window = {HQV: {}}; globalThis.self = globalThis.window;
for (const f of ['world.js', 'hqride.js', 'hqcommute.js', 'hqrail.js', 'hqcityrail.js', 'hqgondola.js']) (new Function(fs.readFileSync(path.join(R0, 'games', f), 'utf8')))();
const H = window.HQV, WD = H.world, W = WD.pack(JSON.parse(fs.readFileSync(path.join(R0, 'tests/fixtures/world_v3_tiny.json'))));
const scene = new THREE.Scene(), c = {THREE, scene, mat: (col, o) => new THREE.MeshStandardMaterial(Object.assign({color: col}, o || {}))};
const ground = (x, z) => WD.groundAt(W, x, z);
const cl = H.hqCityRail.create(W, {seed: 's'}), vc = H.hqCityRail.view(c, cl, {W, ground, night: () => true});
const gs = H.hqGondola.create(W, {seed: 's'}), vg = H.hqGondola.view(c, gs, {ground});
const ISL = 'user:aaaaaaaa-0000-4000-8000-000000000001@3';
const ls = H.hqRail.linkService({here: ISL, W, arch: {commons: {x: 0, z: 0}, islands: [{world: ISL, x: 300000, z: -250000}]}});
const vl = H.hqRail.linkView(c, ls, {seaY: 0});
const ms = 1.7e12, out = {cl: [], total: []};
let m = ms; while (!cl.vehicles(m).length) m += 1000;
for (let t = 0; t < 300; t += 11) {
  [vc, vg, vl].forEach(V => V.update(m + t*1000, 0.016, {x: 0, z: 60}));
  out.cl.push(vc.drawCalls()); out.total.push(vc.drawCalls() + vg.drawCalls() + vl.drawCalls());
}
vc.update(m, 0.016, {x: 0, z: 60});
vc.focus(cl.vehicles(m)[0].id); [vc, vg, vl].forEach(V => V.update(m, 0.016, {x: 0, z: 60}));
out.focused = vc.drawCalls(); out.focusedTotal = vc.drawCalls() + vg.drawCalls() + vl.drawCalls();
out.shots = ['cityline-viaduct', 'cityline-station', 'cityline-interior', 'nope'].map(n => vc.tools.shotCam(n));
let tris = 0; scene.traverse(o => { if (o.isMesh && o.visible && o.geometry) { const g = o.geometry, n = (g.index ? g.index.count : g.attributes.position.count)/3; tris += n*(o.isInstancedMesh ? o.count : 1); } });
out.tris = tris;
vc.focus(null); vc.update(m, 0.016, {x: 0, z: 60}); out.unfocused = vc.drawCalls();
[vc, vg, vl].forEach(V => V.dispose());
out.left = scene.children.length;
console.log(JSON.stringify(out));
"""

# City Gen v4 phase 8: the Commons fixture's City Line with the generator's piers, and the same doc without them
VIEW_PIERS = r"""
import fs from 'fs'; import path from 'path'; import url from 'url'; import zlib from 'zlib';
const R0 = process.argv[2];
const THREE = await import(url.pathToFileURL(R0 + '/games/vendor/three-module.js').href);
globalThis.window = {HQV: {}}; globalThis.self = globalThis.window;
for (const f of ['world.js', 'hqride.js', 'hqcommute.js', 'hqrail.js', 'hqcityrail.js']) (new Function(fs.readFileSync(path.join(R0, 'games', f), 'utf8')))();
const H = window.HQV, WD = H.world, out = {};
const fx = path.join(R0, 'tests/fixtures/claude-hq@3.json.gz');
if (!fs.existsSync(fx)) { console.log('{}'); process.exit(0); }
function one(strip){
  const doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(fx)));
  const line = ((doc.layers.rail || {}).lines || []).filter(l => l.kind === 'city')[0];
  if (!line) return null;
  const docPiers = (line.piers || []).map(p => ({x: p.x/100, y: p.y/100, z: p.z/100, h: p.h/100}));
  if (strip) delete line.piers;
  const W = WD.pack(doc), scene = new THREE.Scene(), c = {THREE, scene, mat: (col, o) => new THREE.MeshStandardMaterial(Object.assign({color: col}, o || {}))};
  const cl = H.hqCityRail.create(W, {seed: 's'}), vc = H.hqCityRail.view(c, cl, {W, ground: (x, z) => WD.groundAt(W, x, z), night: () => false});
  const ms = 1.7e12, calls = [];
  for (let t = 0; t < 600; t += 23) { vc.update(ms + t*1000, 0.016, {x: -300, z: -80}); calls.push(vc.drawCalls()); }
  let tris = 0; scene.traverse(o => { if (o.isMesh && o.visible && o.geometry) { const g = o.geometry; tris += (g.index ? g.index.count : g.attributes.position.count)/3*(o.isInstancedMesh ? o.count : 1); } });
  const R = cl.track(line.id), piers = vc.tools.piers();
  const r = {doc: docPiers, drawn: piers, simPiers: cl.piers(line.id), calls: Math.max(...calls), tris,
             len: R.len, railY: piers.map(p => H.hqRail.at(R, H.hqCityRail.project(R, p.x, p.z)).y)};
  vc.dispose();
  return r;
}
out.with = one(false); out.without = one(true);
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class CityLinePiersTest(unittest.TestCase):
    """Phase 8: the doc's `piers` replace the view's own every 30 m; without them, today's piers."""

    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "--input-type=module", "-e", VIEW_PIERS, "x", ROOT], capture_output=True, text=True, timeout=180)
        if r.returncode != 0:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout)
        if not cls.o.get("with"):
            raise unittest.SkipTest("no Commons fixture with a City Line")
        if not cls.o["with"]["doc"]:
            raise unittest.SkipTest("the Commons fixture's City Line has no piers yet")

    def test_doc_piers_drawn_exactly(self):
        w = self.o["with"]
        self.assertEqual(len(w["drawn"]), len(w["doc"]))
        self.assertEqual(len(w["simPiers"]), len(w["doc"]))
        for d, p in zip(w["doc"], w["drawn"]):
            self.assertAlmostEqual(p["x"], d["x"], places=3)
            self.assertAlmostEqual(p["z"], d["z"], places=3)
            self.assertAlmostEqual(p["y0"], d["y"], places=3, msg="from its foot")
            self.assertAlmostEqual(p["y1"], d["y"] + d["h"] - 2.4, places=3, msg="up to the girder's soffit")

    def test_doc_piers_under_the_line(self):
        w = self.o["with"]
        for p, y in zip(w["drawn"], w["railY"]):
            self.assertAlmostEqual(p["y1"] + 2.4, y, delta=0.3, msg="the doc's rail level is the track's")

    def test_budget_holds(self):
        for k in ("with", "without"):
            self.assertLessEqual(self.o[k]["calls"], 5, k)
            self.assertLess(self.o[k]["tris"], 120000, k)

    def test_fallback_without_the_field(self):
        n = self.o["without"]
        self.assertIsNone(n["simPiers"])
        P = n["drawn"]
        self.assertGreater(len(P), 5)
        # today's loop: every 30 m along the track (60 m over a bridge), never from the doc
        import math
        gaps = [math.hypot(b["x"] - a["x"], b["z"] - a["z"]) for a, b in zip(P, P[1:])]
        self.assertTrue(all(g >= 29 for g in gaps), gaps)
        self.assertGreaterEqual(len(P), int((n["len"] - 12) // 31))
        self.assertNotEqual([(round(p["x"], 2), round(p["z"], 2)) for p in P],
                            [(round(p["x"], 2), round(p["z"], 2)) for p in self.o["with"]["drawn"]])


@unittest.skipUnless(NODE, "node not installed")
class CityLineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", SCRIPT, ROOT], capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout)

    def test_line_and_station_order(self):
        o = self.o
        self.assertEqual(len(o["lines"]), 1)
        l = o["lines"][0]
        self.assertEqual((l["short"], l["mode"], l["headway"], l["loop"]), ("CL", "rail", 240, False))
        self.assertEqual(l["stops"], ["rail:0", "rail:1", "rail:2", "rail:3"], "in path order, whatever the doc's order")
        self.assertEqual([s[0] for s in o["stops"]], ["rail:0", "rail:1", "rail:2", "rail:3"])

    def test_timetable(self):
        d = self.o["deps"]
        self.assertEqual(d["gap"], 240000)
        self.assertTrue(all(r[1] == "1" for r in d["s0"]), "Central: only the way out")
        self.assertTrue(all(r[1] == "2" for r in d["s3"]), "the Airport: only the way back")
        self.assertEqual(set(r[1] for r in d["s1"]), {"1", "2"})
        self.assertTrue(all(r[3] == "CL" for r in d["s1"]))
        self.assertTrue(all(r[0] >= 0 for r in d["s1"]))
        self.assertEqual([r[0] for r in d["s1"]], sorted(r[0] for r in d["s1"]))
        self.assertTrue(d["same"], "the same on every client")
        self.assertTrue(d["other"], "seeded by the world")
        self.assertEqual(d["none"], 0)

    def test_the_run(self):
        a = self.o["out"]
        self.assertEqual(a["stops"], ["rail:0", "rail:1", "rail:2", "rail:3"])
        self.assertEqual(a["times"], sorted(a["times"]))
        self.assertEqual(a["dwell"], 40)
        self.assertAlmostEqual(a["ride"], self.o["legSum"], delta=0.01)
        self.assertLessEqual(a["vmax"], 25.0001)
        self.assertGreater(a["vmax"], 20)
        self.assertEqual(a["back"], 0)
        self.assertLess(max(a["atStops"]), 2.5, "the train's middle stands at each platform (on its own track)")
        self.assertLess(a["lat"], 0.01, "each way on its own track, 2 m right of the middle")
        self.assertEqual((a["doorsAtDep"], a["doorsMid"]), (1, 0))
        self.assertEqual((a["mode"], a["short"]), ("rail", "CL"))
        b = self.o["back"]
        self.assertEqual(b["stops"], ["rail:3", "rail:2", "rail:1", "rail:0"])
        self.assertAlmostEqual(b["ride"], a["ride"], delta=0.01)
        self.assertEqual(self.o["hop"]["stops"], ["rail:1", "rail:2"])
        self.assertIsNone(self.o["bad"])

    def test_viaduct_height_along_the_path(self):
        c = self.o["clear"]
        self.assertGreater(c["n"], 200)
        self.assertAlmostEqual(c["min"], 9, delta=0.05)
        self.assertAlmostEqual(c["max"], 9, delta=0.05)
        self.assertEqual([s[1] for s in self.o["stops"]], [2 + 9 + 0.95, 2 + 4.5 + 9 + 0.95, 2 + 5 + 9 + 0.95, 2 + 5 + 9 + 0.95])

    def test_seats(self):
        s = self.o["seats"]
        self.assertEqual(s["n"], 104)
        self.assertEqual(s["rows"], [4], "2+2 in every row")
        self.assertEqual(s["car"], [16, 32, 32, 24], "the cabs and car 1's luggage stack take their ends")
        self.assertEqual(s["lug"], 0)
        self.assertEqual(s["back"], 52, "facing bays")
        self.assertEqual(s["win"], 52)
        self.assertLessEqual(s["maxX"], 1.05)
        a = self.o["out"]
        self.assertEqual((a["seats"], a["standing"]), (104, 32))
        self.assertLess(a["seatMaxD"], 38, "every seat inside the train")
        self.assertTrue(0.1 < a["seatY"][0] and a["seatY"][1] < 0.8, a["seatY"])    # over the floor (the track climbs 1 %)

    def test_planner(self):
        p = self.o["plan"]
        self.assertTrue(p)
        self.assertIn("rail:CL", p[0])

    def test_fixtures(self):
        self.assertEqual(self.o["tiny"], {"lines": 1, "stops": 2, "trip": True})
        f = self.o.get("fix")
        if not f:
            self.skipTest("tests/fixtures/claude-hq@3.json.gz not there yet")
        if not f["lines"]:
            self.skipTest("the @3 fixture carries no City Line yet (layers.rail is empty)")
        self.assertTrue(f["trip"])
        self.assertGreater(f["clear"]["min"], 5)

    def test_view(self):
        r = subprocess.run([NODE, "--input-type=module", "-e", VIEW, "x", ROOT], capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            raise AssertionError(r.stderr)
        v = json.loads(r.stdout)
        self.assertLessEqual(max(v["cl"]), 5, "static, boards, two for the trains, commuters")
        self.assertLessEqual(v["focused"], 7)
        self.assertLessEqual(max(v["total"]), 14, "plan 3.14: City Line + Island Link + gondola")
        self.assertLessEqual(v["focusedTotal"], 14)
        self.assertLessEqual(v["unfocused"], 5)
        self.assertTrue(all(s for s in v["shots"][:3]))
        self.assertIsNone(v["shots"][3])
        self.assertLess(v["tris"], 120000)
        self.assertEqual(v["left"], 0, "dispose takes it all out of the scene")


if __name__ == "__main__":
    unittest.main()
