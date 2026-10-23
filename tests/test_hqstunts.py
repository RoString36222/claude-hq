"""games/hqstunts.js: where each city's stunts go, and that every flight lands, run under node on the fixtures.

claim() places the stunts on the client from the world doc alone: every client must place the same, never on a road,
the river, a site, an HQ or a tower district, and every flight must clear the skyline and come down on its own
landing ramp at the speed its pad gives. The drawing needs THREE and the flying is driven in hq3d.js (checked
headless in the browser); here: the placement, the flight maths and the house rules in the source.
"""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
SCRIPT = r"""
const fs = require('fs'), zlib = require('zlib'), path = require('path'), R0 = process.argv[1];
global.window = {HQV: {}}; global.self = window;
for (const f of ['world.js', 'worldgeom.js', 'ocean.js', 'hqnav.js', 'hqspectacle.js', 'hqbridges.js', 'hqstunts.js'])
  eval(fs.readFileSync(path.join(R0, 'games', f), 'utf8'));
const WD = window.HQV.world, ST = window.HQV.hqStunts, NAV = window.HQV.hqnav;
const doc = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(R0, 'tests/fixtures', f + '.json.gz'))));
function place(name){
  const W = WD.pack(doc(name)); window.HQV.hqSpectacle.claim(W, 5);
  const kinds = {}; W.lots.forEach((l, i) => { kinds[i] = l.kind; });
  const sites0 = W.sites.filter(s => s.kind !== 'stunt' && s.kind !== 'stuntland').map(s => Object.assign({}, s));
  const S = ST.claim(W, 5);
  return {W, S, kinds, sites0};
}
const out = {};
for (const name of ['claude-hq@2', 'island@2', 'claude-hq@1']) {
  const {W, S, kinds, sites0} = place(name), r = {n: S.list.length, kinds: S.list.map(s => s.kind)};
  r.again = ST.claim(W, 5) === S;
  r.same = JSON.stringify(ST.claim(place(name).W, 5).list.map(s => [s.id, s.pieces.map(p => [p.x, p.z, p.len])]))
        === JSON.stringify(S.list.map(s => [s.id, s.pieces.map(p => [p.x, p.z, p.len])]));
  r.ids = S.list.map(s => s.id);
  // every footprint: off the roads, the water, the earlier sites, the HQs; building lots under it were cleared
  let bad = [];
  const leg = W.districts.legend;
  S.pieces.forEach(pc => {
    for (let u = 0; u <= pc.len; u += 3) for (let l = -pc.hw; l <= pc.hw; l += 3) {
      const x = pc.x + pc.ux*u + pc.uz*l, z = pc.z + pc.uz*u - pc.ux*l;
      const rd = WD.nearestRoad(W, x, z, 20); if (rd && rd.dist <= rd.half) bad.push(['road', pc.stunt, x, z]);
      if (WD.riverAt(W, x, z)) bad.push(['river', pc.stunt]);
      const s0 = sites0.find(s => Math.abs(x*100 - s.x) <= s.w/2 && Math.abs(z*100 - s.z) <= s.d/2); if (s0) bad.push(['site', s0.kind, pc.stunt]);
      const lt = WD.lotAt(W, x, z);
      if (lt && lt.kind !== 'stunt') bad.push(['lot', lt.kind, pc.stunt]);
      if (lt && lt.kind === 'stunt' && ({downtown: 1, finance: 1, office: 1})[leg[lt.district]]) bad.push(['tower district', pc.stunt]);
    }
  });
  r.bad = bad.slice(0, 5); r.nBad = bad.length;
  r.cleared = W.lots.filter(l => l.kind === 'stunt').map(l => l.was);
  r.clearedWereBuildings = W.lots.every((l, i) => l.kind !== 'stunt' || kinds[i] === 'building');
  r.noBlock = S.pieces.every(pc => !WD.blockedAt(W, pc.x + pc.ux*pc.len/2, pc.z + pc.uz*pc.len/2));
  r.sites = S.list.map(s => !!W.sites.find(x => x.kind === 'stunt' && x.name === s.name && Math.abs(x.x/100 - (s.pieces[0].x + s.pieces[0].ux*s.pieces[0].len/2)) < 1));
  r.places = NAV.places(W, 5, {x: 0, z: 0}).filter(p => p.kind === 'stunt').map(p => p.label);
  // every jump, flown from its lip at its pad's speed: first contact is on its own landing ramp, square
  r.flights = S.list.filter(s => s.jump).map(s => {
    const J = s.jump, A = ST.newAir({x: J.lip.x, y: J.lip.y, z: J.lip.z, v: J.v, vy: J.v*Math.tan(J.theta), head: Math.atan2(J.ux, J.uz), pitch: J.theta});
    let hit = null, minClear = 1e9, hoops = 0;
    for (let i = 0; i < 4000 && !hit; i++) {
      const p0 = {x: A.x, y: A.y, z: A.z}; ST.airStep(A, {}, 1/30);
      S.hoops.forEach(h => { if (ST.hoopCross(h, p0, A)) hoops++; });
      const sy = ST.surfaceAt(S, A.x, A.z), gy = Math.max(WD.groundAt(W, A.x, A.z), sy == null ? -1e9 : sy);
      const along = (A.x - J.lip.x)*J.ux + (A.z - J.lip.z)*J.uz;
      if (!J.splash && along > 5 && along < J.Dland - 2) {
        const lt = WD.lotAt(W, A.x, A.z);
        if (lt && lt.kind !== 'stunt') minClear = Math.min(minClear, A.y - (WD.groundAt(W, A.x, A.z) + Math.max(1, lt.floors|0)*3.5));
      }
      if (J.splash ? (A.y <= 0 && !WD.lotAt(W, A.x, A.z) && along > 20) : A.y <= gy) {
        const land = s.pieces.find(pc => pc.kind === 'landing'), q = land ? {u: (A.x - land.x)*land.ux + (A.z - land.z)*land.uz} : null;
        const r1 = ST.surfaceAt(S, A.x + Math.sin(A.head)*0.8, A.z + Math.cos(A.head)*0.8), slope = sy != null && r1 != null ? (r1 - sy)/0.8 : 0;
        hit = {along, nearTarget: Math.abs(along - J.D) < 3, onLanding: !!land && sy != null && q.u >= 0 && q.u <= land.len, clean: ST.landing(A, slope).clean, t: A.t, splash: J.splash};
      }
    }
    return {kind: s.kind, D: J.D, v: J.v, hit, minClear, hoops, nHoops: s.hoops.length, pads: s.pads.map(p => p.v === J.v)};
  });
  r.loops = S.list.filter(s => s.kind === 'loop').map(s => {
    const L = s.loops[0], a = ST.loopPose(L, 0), m = ST.loopPose(L, Math.PI), e = ST.loopPose(L, 2*Math.PI);
    let jump = 0; for (let i = 1; i <= 200; i++) { const p = ST.loopPose(L, (i - 1)/200*2*Math.PI), q = ST.loopPose(L, i/200*2*Math.PI); jump = Math.max(jump, Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z)); }
    const pad = s.pads[0], entry = ST.loopAt(S, L.x + L.uz*(-L.shift/2), L.z - L.ux*(-L.shift/2), Math.atan2(L.ux, L.uz));
    return {top: m.y - a.y, shift: Math.hypot(e.x - a.x, e.z - a.z), maxStep: jump, padFast: pad.v >= L.vmin/0.85, entry: !!entry,
            exitNotEntry: !ST.loopAt(S, e.x, e.z, Math.atan2(L.ux, L.uz))};
  });
  out[name] = r;
}
// the flight maths
out.speed = ST.launchSpeed(100, 10, 10, Math.PI/4);                         // sqrt(g*100) on the level at 45 deg
{ const J = {lip: {x: 0, y: 5, z: 0}, theta: 0.6, v: ST.launchSpeed(80, 5, 2, 0.6)}; out.flightEnd = ST.flightY(J, 80); }
// the same flight at 20 and 144 Hz
out.fps = [20, 144].map(hz => { const A = ST.newAir({x: 0, y: 0, z: 0, v: 30, vy: 15, head: 0}); while (A.t < 2) ST.airStep(A, {}, 1/hz);
  return {err: Math.abs(A.y - (15*A.t - 9.81*A.t*A.t/2)), errZ: Math.abs(A.z - 30*A.t)}; });
// tricks: held W for a full flip then let go lands square; let go mid-spin settles back; a half-spin is a bail
{ const A = ST.newAir({x: 0, y: 50, z: 0, v: 30, vy: 10, head: 0});
  let t = 0; while (t < 2*Math.PI/5.2) { ST.airStep(A, {pitch: 1}, 1/60); t += 1/60; }
  for (let i = 0; i < 120; i++) ST.airStep(A, {}, 1/60);
  out.flip = ST.landing(A, Math.atan2(A.vy, A.v) > 0 ? 0 : Math.tan(Math.atan2(A.vy, A.v))); out.flipScore = ST.score(A, out.flip); }
{ const A = ST.newAir({x: 0, y: 50, z: 0, v: 30, vy: 10, head: 0}); for (let i = 0; i < 18; i++) ST.airStep(A, {spin: 1}, 1/60);
  A.spin = Math.PI; out.half = ST.landing(A, 0); out.halfScore = ST.score(A, out.half); }
out.hoop = [ST.hoopCross({x: 0, y: 10, z: 50, ux: 0, uz: 1, r: 8}, {x: 0, y: 12, z: 49}, {x: 0, y: 11, z: 51}),
            ST.hoopCross({x: 0, y: 10, z: 50, ux: 0, uz: 1, r: 8}, {x: 0, y: 30, z: 49}, {x: 0, y: 30, z: 51}),
            ST.hoopCross({x: 0, y: 10, z: 50, ux: 0, uz: 1, r: 8}, {x: 0, y: 12, z: 40}, {x: 0, y: 11, z: 45})];
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class Stunts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", SCRIPT, ROOT], capture_output=True, text=True, timeout=300)
        if r.returncode:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_every_city_gets_its_own_set(self):
        for name, want in (("claude-hq@2", {"loop", "cannon", "bigair", "river", "sea"}),
                           ("island@2", {"loop", "cannon", "bigair", "river", "sea"}),
                           ("claude-hq@1", {"loop", "cannon", "bigair"})):      # no river, no coast: none of those
            r = self.o[name]
            self.assertTrue(want <= set(r["kinds"]), (name, r["kinds"]))
            self.assertEqual(r["kinds"].count("cannon"), 2, name)
            self.assertLessEqual(r["kinds"].count("river"), 3, name)
        self.assertNotIn("river", self.o["claude-hq@1"]["kinds"])
        self.assertNotIn("sea", self.o["claude-hq@1"]["kinds"])

    def test_deterministic_and_memoised(self):
        for name in ("claude-hq@2", "island@2", "claude-hq@1"):
            r = self.o[name]
            self.assertTrue(r["again"], name)
            self.assertTrue(r["same"], name)
            self.assertEqual(len(set(r["ids"])), len(r["ids"]), "stable, distinct ids")

    def test_footprints_stay_off_roads_water_sites_and_hqs(self):
        for name in ("claude-hq@2", "island@2", "claude-hq@1"):
            r = self.o[name]
            self.assertEqual(r["nBad"], 0, (name, r["bad"]))
            self.assertTrue(r["clearedWereBuildings"], name)
            self.assertTrue(r["noBlock"], "a cleared lot no longer blocks")
            self.assertTrue(all(r["sites"]), name)

    def test_go_to_lists_them(self):
        r = self.o["claude-hq@2"]
        for n in ("Sky Cannon", "Mega Loop", "Big Air", "River Leap", "Sea Launch"):
            self.assertIn(n, r["places"])

    def test_every_flight_lands_on_its_own_ramp_through_its_rings(self):
        for name in ("claude-hq@2", "island@2", "claude-hq@1"):
            for f in self.o[name]["flights"]:
                h = f["hit"]
                self.assertIsNotNone(h, (name, f))
                self.assertTrue(all(f["pads"]), "the pad gives the flight's speed")
                self.assertEqual(f["hoops"], f["nHoops"], (name, f["kind"], "through every ring"))
                if h["splash"]:
                    continue
                self.assertTrue(h["onLanding"], (name, f))
                self.assertTrue(h["clean"], (name, f))
                self.assertTrue(h["nearTarget"], (name, f, "touches down at the target"))
                self.assertGreater(f["minClear"], 5, (name, f["kind"], "over the rooftops"))

    def test_insane_enough(self):
        for name in ("claude-hq@2", "island@2", "claude-hq@1"):
            cannons = [f for f in self.o[name]["flights"] if f["kind"] == "cannon"]
            for f in cannons:
                self.assertGreater(f["D"], 400, name)
                self.assertGreater(f["hit"]["t"], 7, (name, "seconds in the air"))

    def test_the_loop(self):
        for name in ("claude-hq@2", "island@2", "claude-hq@1"):
            for L in self.o[name]["loops"]:
                self.assertAlmostEqual(L["top"], 26, places=6)
                self.assertAlmostEqual(L["shift"], 6, places=6, msg="out on the other lane")
                self.assertLess(L["maxStep"], 1.0, "a smooth track")
                self.assertTrue(L["padFast"] and L["entry"] and L["exitNotEntry"], L)

    def test_flight_maths(self):
        o = self.o
        self.assertAlmostEqual(o["speed"], (9.81*100/2)**0.5, places=6)      # horizontal speed: vy = v tan(theta)
        self.assertAlmostEqual(o["flightEnd"], 2, places=6)
        for f in o["fps"]:                                   # 20 Hz and 144 Hz: on the exact parabola
            self.assertLess(f["err"], 1e-9)
            self.assertLess(f["errZ"], 1e-9)

    def test_tricks(self):
        o = self.o
        self.assertTrue(o["flip"]["clean"], o["flip"])
        self.assertEqual(abs(o["flip"]["flips"]), 1)
        self.assertIn("FLIP", o["flipScore"]["text"])
        self.assertFalse(o["half"]["clean"], "landing backwards is a bail")
        self.assertIn("BAIL", o["halfScore"]["text"])
        self.assertEqual(o["hoop"], [True, False, False])

    def test_house_rules(self):
        with open(os.path.join(ROOT, "games", "hqstunts.js")) as fh:
            src = fh.read()
        self.assertNotIn("innerHTML", src)
        with open(os.path.join(ROOT, "games", "hq3d.js")) as fh:
            hq3d = fh.read()
        block = hq3d[hq3d.index("[stunts] the jumps, the loop"):hq3d.index("function rideMove(dt)")]
        self.assertNotIn("innerHTML", block)
        self.assertIn("E.calm()", block, "Calm: no pads, no flying")
        self.assertIn("textContent", block)
        with open(os.path.join(ROOT, "ui", "app", "22-hq.js")) as fh:
            app = fh.read()
        order = re.search(r"var HQ_SCRIPTS = \[(.*?)\];", app, re.S).group(1)
        self.assertLess(order.index('"hqstunts"'), order.index('"hqcity3d"'))
        self.assertIn("hqstunts:1", app)


if __name__ == "__main__":
    unittest.main()
