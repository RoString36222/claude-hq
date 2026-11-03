"""The Island Link and the City Line on the v5 Commons: off the runway, and never a pier on a road (run under node).

The fixture tests/fixtures/commons_v5_rail.json.gz is the live Commons (claude-hq@3 built by City Gen v5) cut down to
what the rail needs: its terrain, roads, coast, rail layer (with keep_out: the runway's area and both approaches), the
airport site and the lots near the lines. The islands are the archipelago's slots (backend/src/archipelago.rs slot_pos: 1,800 m * sqrt(n + 3) out, the
golden angle apart), laid the way hqtransit lays them on the Commons: the island's doc is not there (docs: {}), so its end
is a nominal leg facing the Commons. Checks:
  - every slot's route (0..63): no point of the drawn track inside the runway's area or an approach (the user's "train
    track on the runway, the track which leads to other city"), and the sea crossing never runs through the city (no
    point of it on the Commons' land below DECK_UP over the ground, nor 200 m inside its coast past the abutment);
  - every pier the views draw (the City Line's, and the Island Link's for 12 slots): none on a road (its width,
    pavements included, plus the pier's radius) nor in a lot (the fixture keeps those within 100 m of a line), and the
    deck at least 5 m over every road it passes over;
  - hqRail.pierAt on a synthetic line: a pier due on a road moves off it, along or aside; a line along a wide road gets a
    portal frame with a leg each side.
"""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
FIXTURE = os.path.join(ROOT, "tests", "fixtures", "commons_v5_rail.json.gz")

COMMON = r"""
const fs = require('fs'), zlib = require('zlib'), path = require('path');
const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(R0, 'tests/fixtures/commons_v5_rail.json.gz'))));
const H = window.HQV, WD = H.world, RL = H.hqRail, W = WD.pack(raw);
const G = 2.399963229728653;
function slot(n) { const r = 1800*Math.sqrt(n + 3), a = (n + 1)*G; return {world: 'user:00000000-0000-4000-8000-' + String(n).padStart(12, '0') + '@3', x: Math.round(r*Math.cos(a)), z: Math.round(r*Math.sin(a))}; }
function inside(P, x, z) { let q = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const a = P[i], b = P[j]; if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0])*(z - a[1])/(b[1] - a[1]) + a[0]) q = !q; } return q; }
const KO = raw.layers.rail.keep_out.map(P => P.map(p => [p[0]/100, p[1]/100]));
const coast = raw.layers.island.coast.map(p => [p[0]/100, p[1]/100]);
const E = raw.layers.roads.edges.filter(e => e.under !== 'tunnel').map(e => ({id: e.id, half: e.width/200, P: e.points.map(p => [p[0]/100, p[1]/100, p[2]/100])}));
function road(x, z, pad) {
  for (const e of E) for (let k = 0; k + 1 < e.P.length; k++) {
    const a = e.P[k], b = e.P[k + 1], dx = b[0] - a[0], dz = b[2] - a[2], L = dx*dx + dz*dz, t = L > 0 ? Math.max(0, Math.min(1, ((x - a[0])*dx + (z - a[2])*dz)/L)) : 0;
    const d = Math.hypot(x - a[0] - dx*t, z - a[2] - dz*t);
    if (d < e.half + pad) return {id: e.id, d: d, half: e.half, y: a[1] + (b[1] - a[1])*t};
  }
  return null;
}
// the lots (each holds a building) the fixture keeps: those within 100 m of a rail line or an Island Link route
const LOTS = (raw.layers.lots || []).filter(l => l.poly && l.poly.length >= 3).map(l => ({id: l.id, P: l.poly.map(q => [q[0]/100, q[1]/100])}));
function lot(x, z) { for (const l of LOTS) if (inside(l.P, x, z)) return {id: 'lot:' + l.id, d: 0, half: 0}; return null; }
"""

ROUTES = r"""
const R0 = process.argv[1];
global.window = {HQV: {}}; global.self = window;
for (const f of ['world.js', 'hqrail.js']) eval(require('fs').readFileSync(require('path').join(R0, 'games', f), 'utf8'));
""" + COMMON + r"""
const out = {keepOut: KO.length, slots: []};
for (let n = 0; n < 64; n++) {
  const I = slot(n), R = RL.linkRoute({world: I.world, x: I.x, z: I.z, W: null}, {world: 'claude-hq@3', x: 0, z: 0, W: W}, {plat: 1});
  const o = {n, len: R.len, onRunway: [], lowOverLand: 0, deepInland: 0};
  for (let i = 0; i < R.n; i++) {
    const x = R.pts[3*i], y = R.pts[3*i + 1], z = R.pts[3*i + 2];
    for (let k = 0; k < KO.length; k++) if (inside(KO[k], x, z)) { if (o.onRunway.length < 3) o.onRunway.push([k, Math.round(x), Math.round(z)]); else o.onRunway.push(1); break; }
    if (R.s[i] <= R.seaA + 1 || R.s[i] >= R.seaB - 1 || !inside(coast, x, z)) continue;
    if (y < WD.groundAt(W, x, z) + RL.DECK_UP - 0.5) o.lowOverLand++;
  }
  // past the Commons' abutment the crossing heads for the shore: never back over the city (a point well inside the coast,
  // further from it than the abutment is)
  const sea = raw.layers.rail.sea, ab = [sea.x/100, sea.z/100], rAb = Math.hypot(ab[0], ab[1]);
  for (let s = R.seaA; s < R.seaB; s += 10) { const p = RL.at(R, s); if (Math.hypot(p.x, p.z) < rAb - 200) o.deepInland++; }
  out.slots.push(o);
}
console.log(JSON.stringify(out));
"""

PIERS = r"""
import fs from 'fs'; import path from 'path'; import url from 'url'; import zlib from 'zlib';
const R0 = process.argv[2];
const THREE = await import(url.pathToFileURL(R0 + '/games/vendor/three-module.js').href);
globalThis.window = {HQV: {}}; globalThis.self = globalThis.window; globalThis.require = (m) => ({fs, zlib, path})[m];
for (const f of ['world.js', 'hqrail.js', 'hqcityrail.js']) (new Function(fs.readFileSync(path.join(R0, 'games', f), 'utf8')))();
""" + COMMON.replace("const fs = require('fs'), zlib = require('zlib'), path = require('path');\n", "") + r"""
const scene = new THREE.Scene(), c = {THREE, scene, mat: (col, o) => new THREE.MeshStandardMaterial(Object.assign({color: col}, o || {}))};
const ground = (x, z) => WD.groundAt(W, x, z), out = {cl: 0, il: 0, onRoad: [], low: [], bents: 0, moved: 0, lots: LOTS.length};
const cl = H.hqCityRail.create(W, {tier: 9, seed: W.id}), vc = H.hqCityRail.view(c, cl, {W, ground});
for (const p of vc.tools.piers()) { out.cl++; const r = road(p.x, p.z, 1.1) || lot(p.x, p.z); if (r) out.onRoad.push(['CL', p.x, p.z, r.id, r.d, r.half]); }
const islands = []; for (let n = 0; n < 12; n++) { const s = slot(n); islands.push({world: s.world, x: s.x*100, z: s.z*100}); }
const svc = RL.linkService({here: 'claude-hq@3', W, arch: {commons: {world: 'claude-hq@3', x: 0, z: 0}, islands}, docs: {}, seed: 'claude-hq@3'});
const vl = RL.linkView(c, svc, {seaY: W.island.sea_cm/100, ground});
for (const p of vl.tools.piers()) {
  if (p.legs.length > 1) out.bents++;
  for (const L of p.legs) { out.il++; if (Math.hypot(L[0] - p.x, L[1] - p.z) > 0.01) out.moved++; const r = road(L[0], L[1], 1.05) || lot(L[0], L[1]); if (r) out.onRoad.push([p.line, L[0], L[1], r.id, r.d, r.half]); }
}
// the deck over the roads: the soffit (the City Line's 2.4 m, the Island Link's 1.9 m under the rail head) 5 m up at least
for (const l of cl.lines()) { const R = cl.track(l.id); for (let s = 0; s < R.len; s += 2) { const q = RL.at(R, s), k = R.k[Math.min(R.n - 1, Math.round(s/4))]; if (k < 3) continue; const r = road(q.x, q.z, 0); if (r && q.y - 2.4 - r.y < 5) out.low.push(['CL', q.x, q.z, q.y - 2.4 - r.y]); } }
for (const l of svc.lines()) { const R = svc.route(l.id, 'out'); for (let s = 0; s < R.len; s += 2) { const q = RL.at(R, s); if (RL.kAt(R, s) < 3 || Math.hypot(q.x, q.z) > 2600) continue; const r = road(q.x, q.z, 0); if (r && q.y - 1.9 - r.y < 5) out.low.push([l.id, q.x, q.z, q.y - 1.9 - r.y]); } }
out.onRoad = out.onRoad.slice(0, 20); out.low = out.low.slice(0, 20);
vl.dispose && vl.dispose(); vc.dispose && vc.dispose();
console.log(JSON.stringify(out));
"""

PIER_AT = r"""
const fs = require('fs'), path = require('path'), R0 = process.argv[1];
global.window = {HQV: {}}; global.self = window;
for (const f of ['world.js', 'hqrail.js']) eval(fs.readFileSync(path.join(R0, 'games', f), 'utf8'));
const RL = window.HQV.hqRail, out = {};
// a straight line along +x at 12 m, as a route (pts every 4 m)
function line(n) { const pts = new Float64Array(3*n), s = new Float64Array(n); for (let i = 0; i < n; i++) { pts[3*i] = 4*i; pts[3*i + 1] = 12; pts[3*i + 2] = 0; s[i] = 4*i; } return {pts, s, n, len: s[n - 1]}; }
const R = line(101);
// a 12 m road across it at x = 100 (pavements included), and a 30 m avenue along it from x = 300, its middle 6 m to the left
const W = {layers: {roads: {edges: [
  {id: 1, width: 1200, points: [[10000, 0, -20000], [10000, 0, 20000]]},
  {id: 2, width: 3000, points: [[30000, 0, 600], [40000, 0, 600]]}]}}};
const free = RL.roadFree(W);
const p = RL.pierAt(R, 100, free), q = RL.pierAt(R, 350, free), z = RL.pierAt(R, 50, free);
out.across = {s: p.s, legs: p.legs};
out.along = q && {legs: q.legs, s: q.s};
out.clear = {s: z.s, legs: z.legs};
out.noFree = RL.pierAt(R, 100, null).legs;
out.frees = [free(100, 0), free(107.5, 0), free(107.7, 0), free(50, 0), free(350, 6 - 16.7), free(350, 6 + 16.7)];
console.log(JSON.stringify(out));
"""


def run(script, *args, module=False):
    cmd = [NODE, "--input-type=module", "-e", script, "x", ROOT] if module else [NODE, "-e", script, ROOT]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        raise AssertionError(r.stderr[-4000:])
    return json.loads(r.stdout)


@unittest.skipUnless(NODE and os.path.exists(FIXTURE), "node or the v5 Commons fixture missing")
class LinkOffTheRunwayTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = run(ROUTES)

    def test_the_fixture_keeps_the_runway_and_both_approaches_out(self):
        self.assertEqual(self.o["keepOut"], 3)

    def test_no_slot_crosses_the_runway_or_its_approaches(self):
        bad = [(s["n"], s["onRunway"][:3]) for s in self.o["slots"] if s["onRunway"]]
        self.assertEqual(bad, [], "slots whose Island Link runs over the runway's area or an approach")

    def test_no_slot_runs_its_sea_viaduct_through_the_city(self):
        deep = [(s["n"], s["deepInland"]) for s in self.o["slots"] if s["deepInland"]]
        self.assertEqual(deep, [], "slots whose sea crossing turns back over the Commons")
        low = [(s["n"], s["lowOverLand"]) for s in self.o["slots"] if s["lowOverLand"]]
        self.assertEqual(low, [], "slots whose sea viaduct runs under DECK_UP over the Commons' land")

    def test_routes_stay_railway_sized(self):
        # a way round, not a voyage: the longest is a few times the spiral's distance
        for s in self.o["slots"]:
            self.assertLess(s["len"], 30000, s["n"])


@unittest.skipUnless(NODE and os.path.exists(FIXTURE), "node or the v5 Commons fixture missing")
class PiersOffTheRoadsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not os.path.exists(os.path.join(ROOT, "games", "vendor", "three-module.js")):
            raise unittest.SkipTest("no vendored three.js")
        cls.o = run(PIERS, module=True)

    def test_piers_are_drawn(self):
        self.assertGreater(self.o["cl"], 0)
        self.assertGreater(self.o["il"], 500)

    def test_no_pier_on_a_road_or_in_a_building(self):
        self.assertGreater(self.o["lots"], 100, "the fixture keeps the lots along the lines")
        self.assertEqual(self.o["onRoad"], [], "[line, x, z, road (or lot:id), distance, road half width]")

    def test_the_deck_clears_every_road_it_passes_over(self):
        self.assertEqual(self.o["low"], [], "[line, x, z, soffit over the road]")


@unittest.skipUnless(NODE, "node not installed")
class PierAtTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = run(PIER_AT)

    def test_free_is_the_road_width_and_the_pier(self):
        self.assertEqual(self.o["frees"], [False, False, True, True, True, True])

    def test_a_pier_due_on_a_road_moves_off_it(self):
        a = self.o["across"]
        self.assertEqual(len(a["legs"]), 1)
        x, z, lat = a["legs"][0]
        self.assertGreaterEqual(abs(x - 100), 6 + 1.6 - 1e-6, "off the road and its pavements")
        self.assertLessEqual(abs(a["s"] - 100), 8, "along the line, PIER_SLIDE at most")
        self.assertEqual(lat, 0, "moving along is cheaper than stepping aside")

    def test_a_pier_on_clear_ground_stays(self):
        self.assertEqual(self.o["clear"]["s"], 50)
        self.assertEqual(self.o["clear"]["legs"], [[50, 0, 0]])
        self.assertEqual(self.o["noFree"], [[100, 0, 0]], "no road test: where it was due")

    def test_a_line_along_a_wide_road_gets_a_portal_frame(self):
        q = self.o["along"]
        self.assertIsNotNone(q)
        self.assertEqual(len(q["legs"]), 2, q)
        for x, z, lat in q["legs"]:
            self.assertGreaterEqual(abs(z - 6), 15 + 1.6 - 1e-6, "each leg off the avenue")
        self.assertLess(min(l[2] for l in q["legs"]), 0)
        self.assertGreater(max(l[2] for l in q["legs"]), 0)


if __name__ == "__main__":
    unittest.main()
