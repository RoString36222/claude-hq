"""games/hqportals.js: tunnel mouths (City Gen v5, @4), run under node.

A synthetic world (cm): a City Line climbing out of its tunnel (8 m under a flat 5 m ground) through an open cutting to
the surface, its portal in layers.rail.portals, and a metro line doing the same into a depot (layers.metro.portals).
Checks: the plan (both portals, their sections from the headwall to the open end along the way out, the rail climbing,
the rail portal drawn in full and the metro one as hqmetro's add-on), the physics (the coping, fence and headwall block
from the land, the cutting blocks from the land and is free down at its track, the land beyond is free, and nothing in
a world without portals), and with the vendored three.js the view: four draw calls at most, every mesh disposed.
"""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

WORLD = r"""
const cm = v => Math.round(v*100);
// the rail climbs from 8 m under the ground at x = 0 to the ground at x = 200 (4 %), on from there at grade
const rail = x => x <= 0 ? -3 : x >= 200 ? 5 : -3 + 8*x/200;
const P = []; for (let x = -200; x <= 400; x += 4) P.push([cm(x), cm(rail(x)), 0]);
const kinds = P.slice(1).map((p, i) => P[i][0] < 0 ? 'tunnel' : P[i][0] < 20000 ? 'portal' : 'grade');
const hole = [[0, -600], [20000, -600], [20000, 600], [0, 600]];
const MP = []; for (let x = -200; x <= 400; x += 4) MP.push([0, cm(rail(x)), cm(1000 + x)]);
const W = {id: 'synth@4', rail: {lines: [{id: 'CL', kind: 'city', stations: [], path: P, kinds, tier: 1}], stations: [], sea: null, holes: [hole],
             portals: [{id: 'rail-portal:0', line: 'CL', x: 0, z: 0, y: 500, front: [-65536, 0], w: 1200, len: 20000, hole}]},
           metro: {lines: [{id: 'M1', stations: [], path: MP, kinds: MP.slice(1).map((p, i) => MP[i][2] < 100000 ? 'bored' : MP[i][2] < 120000 ? 'portal' : 'open'), depot: null, tier: 1}],
                   stations: [], entrances: [], depots: [], holes: [],
                   portals: [{id: 'portal:0', line: 'M1', x: 0, z: 100000, y: 500, front: [0, -65536], w: 1400, len: 20000, hole: [[-700, 100000], [700, 100000], [700, 120000], [-700, 120000]]}]}};
"""

SCRIPT = r"""
const fs = require('fs'), path = require('path'), R0 = process.argv[1];
global.window = {HQV: {}}; global.self = window;
for (const f of ['world.js', 'hqportals.js']) eval(fs.readFileSync(path.join(R0, 'games', f), 'utf8'));
const PO = window.HQV.hqPortals, out = {};
""" + WORLD + r"""
const pl = PO.plan(W);
out.plan = pl.map(p => ({id: p.id, kind: p.kind, line: p.line, name: p.name, full: p.full, walls: p.walls, w: p.w, len: p.len, x: p.x, z: p.z,
  yaw: p.yaw, n: p.secs.length, first: p.secs[0], last: p.secs[p.secs.length - 1], rises: p.secs.every((s, i) => !i || s.rail >= p.secs[i - 1].rail - 1e-9)}));
out.same = PO.plan(W) === pl;
const b = (x, z, y) => PO.blocked(W, x, z, y);
out.block = {
  coping: [b(100, 6.4), b(100, -6.4)], fence: b(100, 6.7), beyond: [b(100, 8.5), b(100, -8.5)], middleFromLand: b(100, 0), middleAtTrack: b(100, 0, rail(100) + 0.2),
  headwall: b(-0.5, 0), overTunnel: b(-6, 0), pastOpenEnd: b(230, 0), metroCoping: b(7.5, 1100), metroBeyond: b(10, 1100), metroAtTrack: b(0, 1100, rail(100) + 0.5)
};
out.empty = [PO.blocked({id: 'none@4'}, 0, 0), PO.plan({id: 'none@4'}).length, PO.plan(null).length, PO.blocked(null, 0, 0)];
console.log(JSON.stringify(out));
"""

VIEW = r"""
import fs from 'fs'; import path from 'path'; import url from 'url';
const R0 = process.argv[2];
const THREE = await import(url.pathToFileURL(R0 + '/games/vendor/three-module.js').href);
globalThis.window = {HQV: {}}; globalThis.self = globalThis.window;
for (const f of ['world.js', 'hqportals.js']) (new Function(fs.readFileSync(path.join(R0, 'games', f), 'utf8')))();
""" + WORLD + r"""
const scene = new THREE.Scene(), c = {THREE, scene};
let night = false;
const V = window.HQV.hqPortals.view(c, W, {night: () => night});
const out = {calls: V.drawCalls(), inScene: scene.children.length, cams: ['portal:rail-portal:0', 'portal-mouth:portal:0', 'nope'].map(n => V.tools.shotCam(n))};
let tris = 0; scene.traverse(o => { if (o.isMesh && o.geometry) tris += o.geometry.attributes.position.count/3; });
out.tris = tris;
night = true; V.update(); V.setNight(false); V.setNight(true);
V.dispose();
out.left = scene.children.length;
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
class TestHqPortals(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", SCRIPT, ROOT], capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout)

    def test_plan(self):
        p = {q["id"]: q for q in self.o["plan"]}
        self.assertEqual(sorted(p), ["portal:0", "rail-portal:0"])
        r, m = p["rail-portal:0"], p["portal:0"]
        self.assertEqual((r["kind"], r["line"], r["name"], r["full"], r["walls"]), ("rail", "CL", "City Line", True, True))
        self.assertEqual((m["kind"], m["full"], m["name"]), ("metro", False, "Red line"))
        # from the headwall out along the cutting (away from the tunnel), the rail climbing to the ground
        self.assertAlmostEqual(r["first"]["x"], 0, places=3)
        self.assertAlmostEqual(r["last"]["x"], 200, places=3)
        self.assertAlmostEqual(r["yaw"], 1.5708, places=3)          # facing +x, out of the tunnel
        self.assertAlmostEqual(r["first"]["rail"], -3, places=3)
        self.assertAlmostEqual(r["last"]["rail"], 5, places=3)
        self.assertTrue(r["rises"] and m["rises"])
        self.assertGreaterEqual(r["n"], 100)                         # every 2 m
        self.assertAlmostEqual(m["last"]["z"], 1200, places=3)
        self.assertTrue(self.o["same"], "memoised per world")

    def test_you_cannot_fall_into_a_cutting(self):
        b = self.o["block"]
        self.assertEqual(b["coping"], [True, True])
        self.assertTrue(b["fence"])
        self.assertEqual(b["beyond"], [False, False], "the land past the fence is free")
        self.assertTrue(b["middleFromLand"], "from the land the cutting is a drop: blocked")
        self.assertFalse(b["middleAtTrack"], "down at its track it is the floor")
        self.assertTrue(b["headwall"])
        self.assertFalse(b["overTunnel"], "the land over the tunnel is walkable")
        self.assertFalse(b["pastOpenEnd"], "past where the rail meets the ground the cutting has ended")
        self.assertTrue(b["metroCoping"])
        self.assertFalse(b["metroBeyond"])
        self.assertFalse(b["metroAtTrack"])

    def test_no_portals_no_effect(self):
        self.assertEqual(self.o["empty"], [False, 0, 0, False])

    @unittest.skipUnless(os.path.exists(os.path.join(ROOT, "games", "vendor", "three-module.js")), "no vendored three.js")
    def test_view(self):
        r = subprocess.run([NODE, "--input-type=module", "-e", VIEW, "x", ROOT], capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            raise AssertionError(r.stderr)
        v = json.loads(r.stdout)
        self.assertGreaterEqual(v["calls"], 3)
        self.assertLessEqual(v["calls"], 4, "the concrete, the fence's panels, the lights (the plates need a canvas)")
        self.assertEqual(v["inScene"], 1)
        self.assertGreater(v["tris"], 500)
        self.assertLess(v["tris"], 60000)
        rc, mc, none = v["cams"]
        self.assertIsNotNone(rc)
        self.assertIsNotNone(mc)
        self.assertIsNone(none)
        self.assertEqual(v["left"], 0, "disposed")


if __name__ == "__main__":
    unittest.main()
