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
// the Commons' airfield: its capsule (the fixture's L.keepOut.capsule) and everything on the water round it
const L = JSON.parse(fs.readFileSync(path.join(R0, 'tests/fixtures/airfield_commons.json'), 'utf8')), AIR = V.COMMONS_AIRFIELD;
function clearOf(P, n){ let m = 1e9; for(let k = 0; k + 1 < n; k++) for(let j = 0; j <= 6; j++){ const u = j/6;
  m = Math.min(m, V.airClear(AIR, P[2*k] + (P[2*k + 2] - P[2*k])*u, P[2*k + 1] + (P[2*k + 3] - P[2*k + 1])*u)); } return m; }
const air = {capsule: AIR, fixture: L.keepOut.capsule, ferries: [], inside: V.airClear(AIR, -1015, 0), edge: V.airClear(AIR, -1015 + 220, 0)};
for(let i = 0; i < 24; i++) for(const d of [3200, 6500]){
  const a = i/24*2*Math.PI, I = {world: 'user:t' + i + '@2', x: Math.sin(a)*d, z: Math.cos(a)*d, W: null};
  const out = V.route({world: 'claude-hq@2', x: 0, z: 0, W: Wc}, I), back = V.route(I, {world: 'claude-hq@2', x: 0, z: 0, W: Wc}),
        blind = V.route(I, {world: 'claude-hq@2', x: 0, z: 0, W: null});
  air.ferries.push([i, d, clearOf(out.pts, out.pts.length/2), clearOf(back.pts, back.pts.length/2), clearOf(blind.pts, blind.pts.length/2)]);
}
// the seaplane at the Commons: hqair's dock end, down the river and out along its water runway
eval(fs.readFileSync(path.join(R0, 'games/hqair.js'), 'utf8'));
const E = window.HQV.hqAir.dockEnd(Wc, 0, 0, [-5000, 0]), sp = [];
E.taxi.forEach(p => sp.push(p[0], p[1])); sp.push(E.thr[0] + E.dir[0]*E.len, E.thr[1] + E.dir[1]*E.len);
air.seaplane = clearOf(sp, sp.length/2);
console.log(JSON.stringify({air, T: R.T, len: R.len, dry, back, maxV, riverSamples, s0: s0.speed, s1: s1.speed,
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

    def test_airfield_capsule_is_the_fixtures(self):
        a = self.o["air"]
        self.assertEqual(a["capsule"], a["fixture"])
        self.assertEqual(a["capsule"], {"a": [-1015, -1220], "b": [-1015, 1220], "r": 180})
        self.assertAlmostEqual(a["inside"], -180)
        self.assertAlmostEqual(a["edge"], 40)

    def test_ferries_and_seaplane_keep_off_the_airfield(self):
        a = self.o["air"]
        self.assertEqual(len(a["ferries"]), 48)
        for f in a["ferries"]:
            self.assertGreaterEqual(min(f[2:]), 40, f)          # out, back, and seen from an island without the doc
        self.assertGreaterEqual(a["seaplane"], 40)

    def test_sailings_shared_both_ways(self):
        self.assertTrue(self.o["same"])
        self.assertEqual(self.o["n"], 10)
        self.assertTrue(self.o["next"])




# the big ships' sea loops (fleet, seaLoop, shipAt, calls) on synthetic archipelagos: islands >= 3 km apart
BIG = r"""
const fs = require('fs'), path = require('path'), vm = require('vm'), R0 = process.argv[1];
const src = fs.readFileSync(path.join(R0, 'games/hqvoyage.js'), 'utf8');
function load(){ const ctx = {window: {HQV: {}}, Math, JSON, Float64Array, Object, Array, String, Number, isFinite}; vm.createContext(ctx); vm.runInContext(src, ctx); return ctx.window.HQV.hqVoyage; }
const V = load(), V2 = load();
// mouths: each city's river mouth, as the archipelago lists it ([x, z] cm in its own frame on a 700-950 m coast, the
// way out per mille, up to 0.6 rad off straight out)
function arch(n, seed, mouths){
  let s = seed; const rnd = () => (s = (s*16807) % 2147483647)/2147483647;
  const mouth = () => { const a = rnd()*2*Math.PI, r = 700 + rnd()*250, t = a + (rnd() - 0.5)*1.2;
    return [Math.round(Math.sin(a)*r*100), Math.round(Math.cos(a)*r*100), Math.round(Math.sin(t)*1000), Math.round(Math.cos(t)*1000)]; };
  const isl = []; let tries = 0;
  while(isl.length < n && tries++ < 100000){ const a = rnd()*2*Math.PI, r = 3000 + rnd()*(2000 + 900*n), x = Math.sin(a)*r, z = Math.cos(a)*r;
    if(Math.hypot(x, z) < 3000 || isl.some(o => Math.hypot(o.x - x, o.z - z) < 3000)) continue;
    isl.push(Object.assign({world: 'user:' + isl.length + '@2', name: 'I' + isl.length, x, z}, mouths ? {mouth: mouth()} : {})); }
  // the Commons' river never runs out under its airfield (the runway's capsule holds the west coast)
  const cmouth = () => { let m = mouth(); while(V.airClear(V.COMMONS_AIRFIELD, m[0]/100, m[1]/100) < 400) m = mouth(); return m; };
  return {commons: Object.assign({x: 0, z: 0}, mouths ? {mouth: cmouth()} : {}), islands: isl};
}
function alongT(R, along){ const s = R.s; let lo = 0, hi = s.length - 1; while(hi - lo > 1){ const m = (lo + hi) >> 1; if(s[m] <= along) lo = m; else hi = m; }
  return R.t[lo] + (s[hi] > s[lo] ? (R.t[hi] - R.t[lo])*(along - s[lo])/(s[hi] - s[lo]) : 0); }
// m from the segment p-q to the airfield capsule (negative: inside)
const AIR = V.COMMONS_AIRFIELD;
function segSeg(p, q, a, b){
  const d = (x, z, a, b) => { const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx*dx + dz*dz; let u = L2 ? ((x - a[0])*dx + (z - a[1])*dz)/L2 : 0;
    u = Math.max(0, Math.min(1, u)); return Math.hypot(x - a[0] - dx*u, z - a[1] - dz*u); };
  const cr = (a, b, c) => (b[0] - a[0])*(c[1] - a[1]) - (b[1] - a[1])*(c[0] - a[0]);
  if((cr(a, b, p) > 0) !== (cr(a, b, q) > 0) && (cr(p, q, a) > 0) !== (cr(p, q, b) > 0)) return 0;
  return Math.min(d(p[0], p[1], a, b), d(q[0], q[1], a, b), d(a[0], a[1], p, q), d(b[0], b[1], p, q));
}
function airMin(P, n, ox, oz){ let m = 1e9; for(let k = 0; k + 1 < n; k++) m = Math.min(m, segSeg([P[2*k] - ox, P[2*k + 1] - oz], [P[2*k + 2] - ox, P[2*k + 3] - oz], AIR.a, AIR.b) - AIR.r); return m; }
const ferries = [];
const out = [];
for(const [n, seed, mouths] of [[0, 1], [1, 2], [2, 3], [3, 7], [4, 5], [7, 9], [12, 11],
                                 [0, 21, 1], [1, 22, 1], [2, 23, 1], [3, 27, 1], [4, 25, 1], [7, 29, 1], [12, 31, 1]]){
  const A = arch(n, seed, mouths), F = V.fleet(A), C = V.bigCities(A), G = V2.fleet(JSON.parse(JSON.stringify(A)));
  // the ferries between the Commons (no doc here: its nominal river) and each island, both ways
  for(const o of A.islands){
    const cm = {world: 'claude-hq@2', x: 0, z: 0, W: null}, is = {world: o.world, x: o.x, z: o.z, W: null};
    for(const R of [V.route(cm, is), V.route(is, cm)]) ferries.push({n, seed, to: o.world, air: airMin(R.pts, R.pts.length/2, 0, 0)});
  }
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
    // each anchorage against its city's river mouth: how far off it, and how square to the river's way out
    let offMouth = 0, square = 1;
    for(const st of R.stops){ const c = C.find(c => c.world === st.world), m = c.mouth; if(!m) continue;
      const d = Math.hypot(st.x - m.x, st.z - m.z); offMouth = Math.max(offMouth, d);
      if(sh.kind === 'cruise') square = Math.min(square, ((st.x - m.x)*m.dx + (st.z - m.z)*m.dz)/d); }
    const worlds = R.stops.map(st => st.world), calls = V.calls(sh, worlds[0], now, R.T*1000), ns = V.nextStop(sh, V.loopT(sh, now, 0));
    out.push({n, mouths: !!mouths, offMouth, square, kind: sh.kind, k: sh.k, cities: C.length, closed: Math.hypot(P[0] - P[2*(m - 1)], P[1] - P[2*m - 1]), clear, back, turn, vmax,
      stops: worlds, uniq: new Set(worlds).size, T: R.T, periodic: Math.hypot(a0.x - a1.x, a0.z - a1.z), same: Math.hypot(a0.x - b0.x, a0.z - b0.z),
      call: calls.length ? (calls[0].here ? 0 : calls[0].arrive - now) : -1, callLeave: calls.length ? calls[0].leave - calls[0].arrive : 0,
      next: ns && ns.stop ? 1 : 0, boxes: sh.boxes || 0, air: airMin(P, m, 0, 0)});
  }
}
console.log(JSON.stringify({ships: out, ferries}));
"""


@unittest.skipUnless(NODE, "node not installed")
class BigShipsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", BIG, ROOT], capture_output=True, text=True, timeout=180)
        if r.returncode != 0:
            raise AssertionError(r.stderr)
        o = json.loads(r.stdout)
        cls.o, cls.ferries = o["ships"], o["ferries"]

    def test_loops_and_ferries_keep_off_the_airfield(self):
        # docs/plans/airport-spec.md 8: nothing sails within 40 m of the runway's keepOut capsule
        for r in self.o:
            self.assertGreaterEqual(r["air"], 40, r)
        self.assertGreater(len(self.ferries), 50)
        for f in self.ferries:
            self.assertGreaterEqual(f["air"], 40, f)

    def test_anchorages_off_the_river_mouth(self):
        rows = [r for r in self.o if r["mouths"]]
        self.assertTrue(rows)
        for r in rows:
            if r["kind"] == "cruise":
                # out along the river's way out, past the coast: a few hundred metres off the mouth
                self.assertLess(r["offMouth"], 900, r)
                self.assertGreater(r["square"], 0.8, r)
            else:
                self.assertLess(r["offMouth"], 1700, r)   # beside the cruise ship's

    def test_every_archipelago_has_ships(self):
        for n in (0, 1, 2, 3, 4, 7, 12):
            rows = [r for r in self.o if r["n"] == n and not r["mouths"]]
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


COMMONS_SCRIPT = r"""
const fs = require('fs'), zlib = require('zlib'), path = require('path'), R0 = process.argv[1];
const src = f => fs.readFileSync(path.join(R0, 'games', f + '.js'), 'utf8'), out = {};
// without games/world.js: the fallback live id
global.window = {HQV: {}};
eval(src('hqvoyage'));
let V = window.HQV.hqVoyage;
out.bare = {commons: V.commons(), at2: V.isCommons('claude-hq@2'), at3: V.isCommons('claude-hq@3'), at1: V.isCommons('claude-hq@1'),
            island: V.isCommons('user:x@3'), junk: V.isCommons(null),
            cities: V.bigCities({commons: {x: 0, z: 0}, islands: [{world: 'user:a@3', x: 4000, z: 0}]}).map(c => [c.world, !!c.air])};
// with games/world.js: HQV.world.COMMONS is the live id
global.window = {HQV: {}};
eval(src('world')); eval(src('hqvoyage'));
V = window.HQV.hqVoyage;
const WD = window.HQV.world;
const doc = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(R0, 'tests/fixtures', f + '.json.gz'))));
const Wc = WD.pack(doc('claude-hq@2'));
function clearOf(P){ let m = 1e9; for(let k = 0; k + 2 < P.length; k += 2) for(let j = 0; j <= 6; j++){ const u = j/6;
  m = Math.min(m, V.airClear(V.COMMONS_AIRFIELD, P[k] + (P[k + 2] - P[k])*u, P[k + 1] + (P[k + 3] - P[k + 1])*u)); } return m; }
out.live = {commons: V.commons(), world: WD.COMMONS, at2: V.isCommons('claude-hq@2'), at3: V.isCommons(WD.COMMONS),
            air3: V.airOf('claude-hq@3') === V.COMMONS_AIRFIELD, air2: V.airOf('claude-hq@2') === V.COMMONS_AIRFIELD, airIsland: V.airOf('user:a@3'),
            cities: V.bigCities({commons: {x: 0, z: 0}}).map(c => [c.world, !!c.air])};
// a ferry from the @3 Commons keeps off its airfield exactly as the @2 one did
out.ferries = [];
for(let i = 0; i < 12; i++){
  const a = i/12*2*Math.PI, I = {world: 'user:t' + i + '@3', x: Math.sin(a)*4000, z: Math.cos(a)*4000, W: null};
  const r3 = V.route({world: 'claude-hq@3', x: 0, z: 0, W: Wc}, I), r2 = V.route({world: 'claude-hq@2', x: 0, z: 0, W: Wc}, I);
  out.ferries.push([clearOf(r3.pts), JSON.stringify(Array.from(r3.pts)) === JSON.stringify(Array.from(r2.pts))]);
}
// the fleet at the @3 Commons calls there under its @3 id
const F = V.fleet({commons: {world: 'claude-hq@3', x: 0, z: 0}, islands: [{world: 'user:a@3', x: 3500, z: 1200}, {world: 'user:b@3', x: -3000, z: 2600}]});
out.calls3 = F.cruise.length ? V.calls(F.cruise[0], 'claude-hq@3', 1e12, F.cruise[0].R.T*1000).length : -1;
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class CommonsV3Test(unittest.TestCase):
    """The live worlds move to @3 (HQ 3.15, D2): the @3 Commons is the Commons, and keeps its airfield."""

    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", COMMONS_SCRIPT, ROOT], capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_ids_without_world_js(self):
        b = self.o["bare"]
        self.assertEqual(b["commons"], "claude-hq@3")
        self.assertTrue(b["at2"])
        self.assertTrue(b["at3"])
        self.assertFalse(b["at1"])
        self.assertFalse(b["island"])
        self.assertFalse(b["junk"])
        self.assertEqual(b["cities"][0], ["claude-hq@3", True])
        self.assertEqual(b["cities"][1], ["user:a@3", False])

    def test_ids_from_world_js(self):
        lv = self.o["live"]
        self.assertEqual(lv["commons"], lv["world"])
        self.assertTrue(lv["at2"])
        self.assertTrue(lv["at3"])
        self.assertTrue(lv["air3"])
        self.assertTrue(lv["air2"])
        self.assertIsNone(lv["airIsland"])
        self.assertEqual(lv["cities"], [[lv["world"], True]])

    def test_v3_commons_ferries_keep_off_the_airfield(self):
        for clear, same in self.o["ferries"]:
            self.assertGreaterEqual(clear, 40 - 1e-6)
            self.assertTrue(same)             # the same lane as from the @2 Commons

    def test_fleet_calls_at_the_v3_commons(self):
        self.assertGreater(self.o["calls3"], 0)


if __name__ == "__main__":
    unittest.main()
