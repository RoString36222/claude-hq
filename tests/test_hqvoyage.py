"""games/hqvoyage.js: a ferry route from the Commons' dock to an island's, run under node on the fixtures."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
SCRIPT = r"""
const fs = require('fs'), zlib = require('zlib'), path = require('path'), R0 = process.argv[1];
global.window = {HQV: {}};
eval(fs.readFileSync(path.join(R0, 'games/world.js'), 'utf8')); eval(fs.readFileSync(path.join(R0, 'games/hqvoyage.js'), 'utf8'));
const WD = window.HQV.world, V = window.HQV.hqVoyage;
const doc = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(R0, 'tests/fixtures', f + '.json.gz'))));
const Wc = WD.pack(doc('claude-hq@2')), Wi = WD.pack(doc('island@2')), B = {x: 2400, z: -3200};
const R = V.route({world: 'claude-hq@2', x: 0, z: 0, W: Wc}, {world: 'user:x@2', x: B.x, z: B.z, W: Wi});
let dry = 0, back = 0, prev = -1, maxV = 0, riverSamples = 0;
for(let t = 0; t <= R.T; t += 1){
  const p = V.poseAt(R, t);
  if(p.along < prev - 1e-6) back++; prev = p.along; maxV = Math.max(maxV, p.speed);
  if(p.leg === 'river'){
    riverSamples++;
    const inA = Math.hypot(p.x, p.z) < Math.hypot(p.x - B.x, p.z - B.z);
    const W = inA ? Wc : Wi, lx = inA ? p.x : p.x - B.x, lz = inA ? p.z : p.z - B.z;
    if(!WD.riverAt(W, lx, lz)) dry++;
  }
}
const h = V.poseAt(R, R.hand), s0 = V.poseAt(R, 0), s1 = V.poseAt(R, R.T);
const sa = V.sailings('a', 'b', 1e9, 6e5, 6e5), sb = V.sailings('b', 'a', 1e9, 6e5, 6e5);
console.log(JSON.stringify({T: R.T, len: R.len, dry, back, maxV, riverSamples, s0: s0.speed, s1: s1.speed,
  handA: Math.hypot(h.x, h.z), handB: Math.hypot(h.x - B.x, h.z - B.z), handLeg: h.leg,
  end: [s1.x - B.x, s1.z - B.z], berth: V.berthOf(Wi), same: JSON.stringify(sa) === JSON.stringify(sb), n: sa.length,
  next: V.nextSailing('a', 'b', 1e9) >= 1e9}));
"""


@unittest.skipUnless(NODE, "node not installed")
class VoyageTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", SCRIPT, ROOT], capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout)

    def test_stays_on_the_water(self):
        self.assertGreater(self.o["riverSamples"], 60)
        self.assertEqual(self.o["dry"], 0)

    def test_moves_forward_from_rest_to_rest(self):
        self.assertEqual(self.o["back"], 0)
        self.assertEqual(self.o["s0"], 0)
        self.assertLess(self.o["s1"], 0.5)
        self.assertLessEqual(self.o["maxV"], 21.0001)
        self.assertGreater(self.o["T"], 120)

    def test_hands_over_mid_sea(self):
        self.assertEqual(self.o["handLeg"], "sea")
        self.assertAlmostEqual(self.o["handA"], self.o["handB"], delta=40)

    def test_ends_at_the_island_berth(self):
        b = self.o["berth"]
        self.assertAlmostEqual(self.o["end"][0], b["x"], delta=1)
        self.assertAlmostEqual(self.o["end"][1], b["z"], delta=1)

    def test_sailings_shared_both_ways(self):
        self.assertTrue(self.o["same"])
        self.assertEqual(self.o["n"], 10)
        self.assertTrue(self.o["next"])


if __name__ == "__main__":
    unittest.main()


# the big ships' sea loops (fleet, seaLoop, shipAt, calls) on synthetic archipelagos: islands >= 3 km apart
BIG = r"""
const fs = require('fs'), path = require('path'), vm = require('vm'), R0 = process.argv[1];
const src = fs.readFileSync(path.join(R0, 'games/hqvoyage.js'), 'utf8');
function load(){ const ctx = {window: {HQV: {}}, Math, JSON, Float64Array, Object, Array, String, Number, isFinite}; vm.createContext(ctx); vm.runInContext(src, ctx); return ctx.window.HQV.hqVoyage; }
const V = load(), V2 = load();
function arch(n, seed){
  let s = seed; const rnd = () => (s = (s*16807) % 2147483647)/2147483647;
  const isl = []; let tries = 0;
  while(isl.length < n && tries++ < 100000){ const a = rnd()*2*Math.PI, r = 3000 + rnd()*(2000 + 900*n), x = Math.sin(a)*r, z = Math.cos(a)*r;
    if(Math.hypot(x, z) < 3000 || isl.some(o => Math.hypot(o.x - x, o.z - z) < 3000)) continue;
    isl.push({world: 'user:' + isl.length + '@2', name: 'I' + isl.length, x, z}); }
  return {commons: {x: 0, z: 0}, islands: isl};
}
function alongT(R, along){ const s = R.s; let lo = 0, hi = s.length - 1; while(hi - lo > 1){ const m = (lo + hi) >> 1; if(s[m] <= along) lo = m; else hi = m; }
  return R.t[lo] + (s[hi] > s[lo] ? (R.t[hi] - R.t[lo])*(along - s[lo])/(s[hi] - s[lo]) : 0); }
const out = [];
for(const [n, seed] of [[0, 1], [1, 2], [2, 3], [3, 7], [4, 5], [7, 9], [12, 11]]){
  const A = arch(n, seed), F = V.fleet(A), C = V.bigCities(A), G = V2.fleet(JSON.parse(JSON.stringify(A)));
  for(const sh of F.cruise.concat(F.cargo)){
    const R = sh.R, P = R.pts, m = R.t.length;
    let clear = 1e9, back = 0, turn = 0, vmax = 0;
    for(let k = 0; k < m; k++){
      for(const c of C) clear = Math.min(clear, Math.hypot(P[2*k] - c.x, P[2*k + 1] - c.z) - c.r);
      if(k && R.s[k] < R.s[k - 1]) back++;
      vmax = Math.max(vmax, R.v[k]);
    }
    // the heading's change over 120 m, away from the anchorages (where the ship is down to a crawl)
    for(let a = 0; a < R.len; a += 20){
      const at = x => V.poseAt(R, alongT(R, ((x % R.len) + R.len) % R.len)), p0 = at(a - 60), p1 = at(a), p2 = at(a + 60);
      if(Math.min(...R.stops.map(st => Math.hypot(st.x - p1.x, st.z - p1.z))) < 300) continue;
      let d = Math.atan2(p2.x - p1.x, p2.z - p1.z) - Math.atan2(p1.x - p0.x, p1.z - p0.z);
      while(d > Math.PI) d -= 2*Math.PI; while(d < -Math.PI) d += 2*Math.PI;
      turn = Math.max(turn, Math.abs(d)*180/Math.PI);
    }
    const now = 1.7e12, twin = (sh.kind === 'cruise' ? G.cruise : G.cargo)[sh.k];
    const a0 = V.shipAt(sh, now, 0), a1 = V.shipAt(sh, now + R.T*1000, 0), b0 = V2.shipAt(twin, now, 0);
    const worlds = R.stops.map(st => st.world), calls = V.calls(sh, worlds[0], now, R.T*1000), ns = V.nextStop(sh, V.loopT(sh, now, 0));
    out.push({n, kind: sh.kind, k: sh.k, cities: C.length, closed: Math.hypot(P[0] - P[2*(m - 1)], P[1] - P[2*m - 1]), clear, back, turn, vmax,
      stops: worlds, uniq: new Set(worlds).size, T: R.T, periodic: Math.hypot(a0.x - a1.x, a0.z - a1.z), same: Math.hypot(a0.x - b0.x, a0.z - b0.z),
      call: calls.length ? (calls[0].here ? 0 : calls[0].arrive - now) : -1, callLeave: calls.length ? calls[0].leave - calls[0].arrive : 0,
      next: ns && ns.stop ? 1 : 0, boxes: sh.boxes || 0});
  }
}
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class BigShipsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", BIG, ROOT], capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout)

    def test_every_archipelago_has_ships(self):
        for n in (0, 1, 2, 3, 4, 7, 12):
            rows = [r for r in self.o if r["n"] == n]
            self.assertEqual(sum(r["kind"] == "cruise" for r in rows), 2 if n + 1 > 4 else 1, n)
            self.assertGreaterEqual(sum(r["kind"] == "cargo" for r in rows), 1, n)

    def test_loops_are_closed_and_forward(self):
        for r in self.o:
            self.assertLess(r["closed"], 1e-6, r)
            self.assertEqual(r["back"], 0, r)
            self.assertLess(r["periodic"], 1e-3, r)

    def test_loops_keep_off_every_coast(self):
        for r in self.o:
            self.assertGreater(r["clear"], 200, r)

    def test_loops_turn_smoothly(self):
        for r in self.o:
            self.assertLess(r["turn"], 45, r)

    def test_speeds(self):
        for r in self.o:
            self.assertLessEqual(r["vmax"], 12.0001, r)
            self.assertGreaterEqual(r["vmax"], 9, r)

    def test_cruise_calls_at_every_city_once(self):
        for r in self.o:
            if r["kind"] == "cruise":
                self.assertEqual(len(r["stops"]), r["cities"], r)
                self.assertEqual(r["uniq"], r["cities"], r)
            else:
                self.assertGreaterEqual(len(r["stops"]), 1, r)
                self.assertEqual(r["uniq"], len(r["stops"]), r)
                self.assertGreaterEqual(r["boxes"], 60, r)

    def test_schedule_deterministic(self):
        for r in self.o:
            self.assertLess(r["same"], 1e-6, r)        # another client, building the fleet on its own: the same place
            self.assertGreaterEqual(r["call"], 0, r)
            self.assertLessEqual(r["call"], r["T"]*1000, r)
            self.assertGreater(r["callLeave"], 60000, r)   # it stays a while at anchor
            self.assertEqual(r["next"], 1, r)
