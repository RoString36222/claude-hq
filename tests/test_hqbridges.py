"""games/hqbridges.js: the opening bridges over the river, run under node on the v2 fixtures.

find(W) on the Commons and the island, the state machine driven by a real ferry voyage (games/hqvoyage.js) at two
frame rates, blockedAt / obstacles, the models built from the vendored three.js, and worldgeom's roadTile gap option
(the static deck over the water left out; @1 unchanged). Skipped when node is not installed. Stdlib only."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

HARNESS = r"""
import fs from "fs";
import zlib from "zlib";
const root = %(root)s;
const THREE = await import(root + "/games/vendor/three-module.js");
globalThis.window = globalThis.self = {HQV: {}};
for (const f of ["world", "worldgeom", "hqvoyage", "hqbridges"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const WD = window.HQV.world, G = window.HQV.worldgeom, V = window.HQV.hqVoyage, BR = window.HQV.hqBridges, out = {};
const doc = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/" + f + ".json.gz")));
const Wc = WD.pack(doc("claude-hq@2")), Wi = WD.pack(doc("island@2")), W1 = WD.pack(doc("claude-hq@1"));

// find: the spans, their ends on the banks, their middles on the water
out.find = [["c", Wc], ["i", Wi]].map(([n, W]) => BR.find(W).map(b => ({
  id: b.id, kind: b.kind, len: b.len, y: b.y, width: b.width, waterY: b.waterY,
  aWet: WD.riverAt(W, b.a.x, b.a.z), bWet: WD.riverAt(W, b.b.x, b.b.z),
  midWet: WD.riverAt(W, (b.a.x + b.b.x)/2, (b.a.z + b.b.z)/2), axis: Math.hypot(b.axis[0], b.axis[1])})));
out.again = JSON.stringify(BR.find(Wc)) === JSON.stringify(BR.find(Wc));
out.find1 = BR.find(W1).length;

// a voyage from the Commons to the island: every bridge the ferry passes is open as it passes, at 30 and 144 Hz
const B = {x: 2400, z: -3200};
const R = V.route({world: "claude-hq@2", x: 0, z: 0, W: Wc}, {world: "user:x@2", x: B.x, z: B.z, W: Wi});
function sail(W, ox, oz, hz){
  const list = BR.find(W), sts = list.map(() => BR.newState()), dt = 1/hz, n = Math.ceil((R.T + 40)*hz);
  const rep = list.map(b => ({id: b.id, passes: 0, shut: 0, early: 0, closeAt: null, lastNear: null}));
  const samples = [];
  for(let i = 0; i <= n; i++){
    const t = i*dt, p = V.poseAt(R, Math.min(R.T, t)), ship = {x: p.x - ox, z: p.z - oz, yaw: p.yaw, speed: t > R.T ? 0 : p.speed};
    list.forEach((b, k) => {
      const st = BR.step(b, sts[k], dt, [ship]), r = rep[k];
      if(st.u > 0 && st.bar < 0.99) r.early++;
      const cx = (b.a.x + b.b.x)/2, cz = (b.a.z + b.b.z)/2, d = Math.hypot(ship.x - cx, ship.z - cz);
      if(d < b.len/2 + 20){ r.passes++; if(st.u < 1) r.shut++; r.lastNear = t; }
      if(r.lastNear != null && r.closeAt == null && st.u === 0 && st.bar === 0) r.closeAt = t - r.lastNear;
    });
    if(Math.abs(t*2 - Math.round(t*2)) < dt/2) samples.push(sts.map(s => [s.u, s.bar]));
  }
  return {rep: rep, samples: samples};
}
out.sailC = [30, 144].map(hz => sail(Wc, 0, 0, hz));
out.sailI = [30, 144].map(hz => sail(Wi, B.x, B.z, hz));

// a ship racing at the bridge (full ahead): the bridge still opens in time
(function(){
  const b = BR.find(Wc)[0], st = BR.newState(), cx = (b.a.x + b.b.x)/2, cz = (b.a.z + b.b.z)/2;
  const nx = b.left[0], nz = b.left[1], v = 50, dt = 1/60;
  let d = 240, shut = 0;
  while(d > -60){
    const ship = {x: cx - nx*d, z: cz - nz*d, yaw: Math.atan2(nx, nz), speed: v};
    BR.step(b, st, dt, [ship]);
    if(Math.abs(d) < b.width/2 + 6 && st.u < 1) shut++;
    d -= v*dt;
  }
  out.race = shut;
  // a ship sailing away, far off: nothing happens
  const st2 = BR.newState();
  for(let i = 0; i < 600; i++) BR.step(b, st2, 1/60, [{x: cx - nx*200, z: cz - nz*200, yaw: Math.atan2(-nx, -nz), speed: 6}]);
  out.away = [st2.u, st2.bar, st2.lights];
})();

// the models, blockedAt and obstacles
(function(){
  const c = {THREE: THREE};
  const scene = new THREE.Scene(), Bc = BR.create(c, Wc, scene), Bi = BR.create(c, Wi, scene);
  const kinds = {}, meshes = [];
  [Bc, Bi].forEach(Bx => Bx.list().forEach(b => { kinds[b.kind] = (kinds[b.kind] || 0) + 1; }));
  Bc.group.children.forEach(g => { let m = 0; g.traverse(o => { if(o.isMesh) m++; }); meshes.push(m); });
  const b = Bc.list()[0], mid = {x: (b.a.x + b.b.x)/2, z: (b.a.z + b.b.z)/2};
  const before = Bc.blockedAt(mid.x, mid.z);
  const ship = {x: mid.x - b.left[0]*30, z: mid.z - b.left[1]*30, yaw: Math.atan2(b.left[0], b.left[1]), speed: 0};
  let barT = null, openT = null, obsMax = 0;
  for(let i = 0; i < 20*60; i++){
    Bc.update(1/60, [ship]);
    const s = Bc.state(b.id);
    if(barT == null && s.bar > 0.99) barT = i/60;
    if(openT == null && Bc.open(b.id) >= 1) openT = i/60;
    obsMax = Math.max(obsMax, Bc.obstacles().length);
  }
  const during = Bc.blockedAt(mid.x, mid.z);
  for(let i = 0; i < 30*60; i++) Bc.update(1/60, []);
  out.model = {kinds, meshes, before, during, after: Bc.blockedAt(mid.x, mid.z), barT, openT, obsMax, obsAfter: Bc.obstacles().length,
               openAfter: Bc.open(b.id), offRoad: Bc.blockedAt(mid.x + 300, mid.z)};
  // a lift's span rises to clear LIFT_CLEAR over the water when open
  const lifts = Bc.list().concat(Bi.list()).filter(x => x.kind === "lift");
  Bc.dispose(); Bi.dispose();
  out.disposed = scene.children.length;
  out.lifts = lifts.length;
})();

// roadTile's gap: nothing of a bridge's deck over the water, the same tiles elsewhere; @1 unchanged
(function(){
  function wetVerts(W, gap){
    let n = 0, total = 0;
    const gaps = BR.find(W);
    for(let tz = 0; tz < G.NT; tz++) for(let tx = 0; tx < G.NT; tx++){
      const r = G.roadTile(W, tx, tz, false, gap);
      ["asphalt", "walk", "kerb", "marks", "bridge"].forEach(k => {
        const g = r[k]; if(!g) return;
        for(let i = 0; i < g.pos.length; i += 3){
          total++;
          const x = g.pos[i], z = g.pos[i+2];
          if(gaps.some(b => { const dx = x - b.a.x, dz = z - b.a.z, s = dx*b.axis[0] + dz*b.axis[1], o = dx*b.left[0] + dz*b.left[1];
                              return s > 0.2 && s < b.len - 0.2 && Math.abs(o) < b.width/2 - 0.05; })) n++;
        }
      });
    }
    return {n, total};
  }
  out.gap = {plain: wetVerts(Wc, false), gapped: wetVerts(Wc, true)};
  let same1 = true;
  for(let tz = 0; tz < G.NT; tz++) for(let tx = 0; tx < G.NT; tx++)
    if(JSON.stringify(G.roadTile(W1, tx, tz)) !== JSON.stringify(G.roadTile(W1, tx, tz, false, true))) same1 = false;
  out.gap.same1 = same1;
  out.gap.buildTile = !!G.buildTile(Wc, {tx: 3, tz: 4, want: ["roads"], gap: true}).roads;
})();
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class BridgesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        src = HARNESS % {"root": json.dumps(ROOT)}
        r = subprocess.run([NODE, "--input-type=module", "-e", src], capture_output=True, text=True, timeout=300)
        if r.returncode != 0:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_find_spans_the_water(self):
        c, i = self.o["find"]
        self.assertEqual(len(c), 4)
        self.assertEqual(len(i), 6)
        self.assertEqual(len({b["id"] for b in c}), 4)
        self.assertEqual(len({b["id"] for b in i}), 6)
        for b in c + i:
            self.assertIn(b["kind"], ("bascule", "lift", "swing"))
            self.assertFalse(b["aWet"], b)
            self.assertFalse(b["bWet"], b)
            self.assertTrue(b["midWet"], b)
            self.assertGreater(b["len"], 20)
            self.assertGreater(b["y"], b["waterY"])
            self.assertAlmostEqual(b["axis"], 1, places=6)
        self.assertTrue(self.o["again"])
        self.assertEqual(self.o["find1"], 0)

    def test_every_kind_appears(self):
        self.assertEqual(set(self.o["model"]["kinds"]), {"bascule", "lift", "swing"})

    def test_open_as_the_ferry_passes(self):
        passed = 0
        for runs in (self.o["sailC"], self.o["sailI"]):
            for run in runs:
                for r in run["rep"]:
                    self.assertEqual(r["shut"], 0, r)
                    self.assertEqual(r["early"], 0, r)          # the arms are down before it moves
                    if r["passes"]:
                        passed += 1
                        self.assertIsNotNone(r["closeAt"], r)
                        # out of HOLD_NEAR (a few s at river speed), CLOSE_AFTER, MOVE, the arms up
                        self.assertLess(r["closeAt"], 6 + 6 + 8 + 4, r)
        self.assertGreaterEqual(passed, 2 * (3 + 4))

    def test_frame_rate_independent(self):
        for runs in (self.o["sailC"], self.o["sailI"]):
            a, b = runs[0]["samples"], runs[1]["samples"]
            n = min(len(a), len(b))
            self.assertGreater(n, 100)
            for k in range(n):
                for x, y in zip(a[k], b[k]):
                    self.assertLess(abs(x[0] - y[0]), 0.02, k)
                    self.assertLess(abs(x[1] - y[1]), 0.05, k)

    def test_opens_in_time_for_a_fast_ship(self):
        self.assertEqual(self.o["race"], 0)
        self.assertEqual(self.o["away"], [0, 0, False])

    def test_models_block_and_dispose(self):
        m = self.o["model"]
        self.assertFalse(m["before"])
        self.assertTrue(m["during"])
        self.assertFalse(m["after"])
        self.assertFalse(m["offRoad"])
        self.assertGreater(m["barT"], 0.5)
        self.assertGreater(m["openT"], 5 + 7)
        self.assertLess(m["openT"], 5 + 8.5)
        self.assertGreater(m["obsMax"], 0)
        self.assertEqual(m["obsAfter"], 0)
        self.assertEqual(m["openAfter"], 0)
        for n in m["meshes"]:
            self.assertGreaterEqual(n, 7)
            self.assertLessEqual(n, 12)
        self.assertEqual(self.o["disposed"], 0)

    def test_road_gap(self):
        g = self.o["gap"]
        self.assertGreater(g["plain"]["n"], 50)
        self.assertEqual(g["gapped"]["n"], 0)
        self.assertGreater(g["gapped"]["total"], g["plain"]["total"] * 0.9)
        self.assertTrue(g["same1"])
        self.assertTrue(g["buildTile"])


if __name__ == "__main__":
    unittest.main()
