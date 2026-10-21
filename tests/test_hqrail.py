"""games/hqrail.js: a rail line from the Commons' station to an island's, run under node on the fixtures."""
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
for (const f of ['world.js', 'hqnav.js', 'hqrail.js']) eval(fs.readFileSync(path.join(R0, 'games', f), 'utf8'));
const WD = window.HQV.world, RL = window.HQV.hqRail;
const doc = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(R0, 'tests/fixtures', f + '.json.gz'))));
const Wc = WD.pack(doc('claude-hq@2')), Wi = WD.pack(doc('island@2')), B = {x: 2400, z: -3200}, TIER_B = 3;
const A0 = {world: 'claude-hq@2', x: 0, z: 0, W: Wc, tier: 5, sea: Wc.island.sea_cm/100};
const B0 = {world: 'user:x@2', x: B.x, z: B.z, W: Wi, tier: TIER_B, sea: Wi.island.sea_cm/100};
const R = RL.alignment(A0, B0), Rb = RL.alignment(B0, A0);
const Rr = RL.reverse(R), pe = RL.at(Rr, 0), pz = RL.at(R, R.len);
const out = {len: R.len, T: R.T, seaA: R.seaA, seaB: R.seaB, lenB: Rb.len, Tb: Rb.T, revT: Rr.T, revLen: Rr.len,
  revStart: Math.hypot(pe.x - pz.x, pe.z - pz.z), revHand: RL.poseAt(Rr, Rr.hand).leg};
// over the land: never over a building standing at that city's tier, always well clear of the ground
let overB = 0, landPts = 0, minClear = 1e9, maxGrade = 0, minR = 1e9;
for (let i = 0; i < R.n; i++) {
  const x = R.pts[3*i], y = R.pts[3*i + 1], z = R.pts[3*i + 2];
  const inA = Math.hypot(x, z) < Math.hypot(x - B.x, z - B.z), W = inA ? Wc : Wi, tier = inA ? 5 : TIER_B;
  const lx = inA ? x : x - B.x, lz = inA ? z : z - B.z;
  if (i) maxGrade = Math.max(maxGrade, Math.abs(y - R.pts[3*i - 2])/(R.s[i] - R.s[i - 1]));
  if (isFinite(R.r[i])) minR = Math.min(minR, R.r[i]);
  if (R.s[i] > R.seaA && R.s[i] < R.seaB) continue;
  landPts++;
  minClear = Math.min(minClear, y - WD.groundAt(W, lx, lz));
  const lot = WD.lotAt(W, lx, lz);
  if (lot && !(lot.min_tier > tier) && WD.surfaceAt(W, lx, lz) === 'lot' && WD.blockedAt(W, lx, lz)) overB++;
}
Object.assign(out, {overB, landPts, minClear, maxGrade, minR});
// the station ends: over the street by the station's door
const sa = RL.stationOf(Wc), da = RL.doorOf(sa), p0 = RL.at(R, 0);
const sb = RL.stationOf(Wi), db = RL.doorOf(sb), p1 = RL.at(R, R.len);
out.startFromDoor = Math.hypot(p0.x - da.x, p0.z - da.z);
out.endFromDoor = Math.hypot(p1.x - B.x - db.x, p1.z - B.z - db.z);
// the ride: from rest to rest, never backwards, the handover at sea
let back = 0, prev = -1, maxV = 0, maxA = 0, pv = 0;
for (let t = -5; t <= R.T + 5; t += 0.25) {
  const p = RL.poseAt(R, t);
  if (p.along < prev - 1e-6) back++;
  if (t > 0) maxA = Math.max(maxA, Math.abs(p.speed - pv)/0.25);
  prev = p.along; pv = p.speed; maxV = Math.max(maxV, p.speed);
}
const h = RL.poseAt(R, R.hand), s0 = RL.poseAt(R, 0), s1 = RL.poseAt(R, R.T);
Object.assign(out, {back, maxV, maxA, s0v: s0.speed, s1v: s1.speed, s0a: s0.along, s1a: s1.along, handLeg: h.leg,
  handA: Math.hypot(h.x, h.z), handB: Math.hypot(h.x - B.x, h.z - B.z)});
// schedules: the same departures on every client, every 3 min each way, the two ways interleaved
const da1 = RL.departures('claude-hq@2', 'user:x@2', 1e12, 6e5, 6e5), da2 = RL.departures('claude-hq@2', 'user:x@2', 1e12, 6e5, 6e5);
const db1 = RL.departures('user:x@2', 'claude-hq@2', 1e12, 6e5, 6e5);
out.same = JSON.stringify(da1) === JSON.stringify(da2); out.n = da1.length; out.gap = da1[1] - da1[0];
out.interleave = Math.abs(((db1[0] - da1[0]) % RL.EVERY + RL.EVERY) % RL.EVERY - RL.EVERY/2) < 1;
out.next = RL.nextDeparture('claude-hq@2', 'user:x@2', 1e12) >= 1e12;
out.key = RL.lineKey('user:x@2', 'claude-hq@2');
// the station menu
const rail = {cost: 500, min_tier: 2, lines: [{a: 'claude-hq@2', b: 'user:aaaaaaaa-0000-4000-8000-000000000001@2'}]};
const mine = 'user:aaaaaaaa-0000-4000-8000-000000000001@2', other = 'user:bbbbbbbb-0000-4000-8000-000000000002@2';
const places = [{world: 'claude-hq@2', name: 'The Commons', tier: 5}, {world: other, name: 'Bee', tier: 2}, {world: 'user:cccccccc-0000-4000-8000-000000000003@2', name: 'Sea', tier: 1}];
out.rowsMine = RL.menuRows(rail, mine, places, mine, 3, 1e12).map(r => r.kind + ':' + r.to.world);
out.rowsCommons = RL.menuRows(rail, 'claude-hq@2', [{world: mine, name: 'My island', tier: 3}, {world: other, name: 'Bee', tier: 2}], mine, 3, 1e12).map(r => r.kind + ':' + r.to.world);
out.rowsNoLine = RL.menuRows({lines: []}, 'claude-hq@2', [{world: mine, name: 'My island', tier: 3}], mine, 3, 1e12).map(r => r.kind);
out.rowsLowTier = RL.menuRows({lines: []}, mine, places, mine, 1, 1e12).length;
// three lines out of the Commons' station along the same streets: side by side in lanes, never on one track
const Bs = [{world: 'user:a@2', x: 2400, z: -3200}, {world: 'user:b@2', x: 3100, z: -2300}, {world: 'user:c@2', x: 1500, z: -3500}];
const lay = (L, bs) => bs.map(b => RL.alignment(Object.assign({}, A0, {lane: L[b.world]}), {world: b.world, x: b.x, z: b.z, W: Wi, tier: 3, sea: B0.sea}));
function minSep(Rs){
  let m = 1e9;
  for (let a = 0; a < Rs.length; a++) for (let b = a + 1; b < Rs.length; b++)
    for (let i = 0; i < Rs[a].n; i++) {
      const x = Rs[a].pts[3*i], z = Rs[a].pts[3*i + 2];
      if (Math.hypot(x, z) > 1500) continue;                                          // the Commons' end
      for (let j = 0; j < Rs[b].n; j++) m = Math.min(m, Math.hypot(Rs[b].pts[3*j] - x, Rs[b].pts[3*j + 2] - z));
    }
  return m;
}
const L3 = RL.lanes(Wc, 5, {x: 0, z: 0}, Bs), L3r = RL.lanes(Wc, 5, {x: 0, z: 0}, Bs.slice().reverse());
out.lanes3 = Bs.map(b => L3[b.world].off).sort((a, b) => a - b);
out.lanesSame = JSON.stringify(L3) === JSON.stringify(Object.fromEntries(Object.keys(L3).sort().map(k => [k, L3r[k]])));
out.sepNone = minSep(lay({}, Bs)); out.sep3 = minSep(lay(L3, Bs));
const L2 = RL.lanes(Wc, 5, {x: 0, z: 0}, Bs.slice(0, 2)), R2 = lay(L2, Bs.slice(0, 2));
out.sep2 = minSep(R2); out.lanes2 = Bs.slice(0, 2).map(b => L2[b.world]);
// beside each other along the platforms: LANE apart, an island platform between
const q0 = RL.at(R2[0], 40), q1 = RL.at(R2[1], 40); out.platGap = Math.hypot(q0.x - q1.x, q0.z - q1.z);
out.lane1 = RL.lanes(Wc, 5, {x: 0, z: 0}, Bs.slice(0, 1))['user:a@2'];
// lines leaving the other way along the street (one north-west, one south-east): no lanes
const Lo = RL.lanes(Wc, 5, {x: 0, z: 0}, [{world: 'user:a@2', x: 2400, z: -3200}, {world: 'user:d@2', x: -3000, z: 2600}]);
out.lanesApart = [Lo['user:a@2'].off, Lo['user:d@2'].off];
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class RailTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", SCRIPT, ROOT], capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout)

    def test_over_the_streets_not_the_buildings(self):
        o = self.o
        self.assertGreater(o["landPts"], 200)
        self.assertLessEqual(o["overB"], o["landPts"]*0.02, "a few points where a street corner is cut at most")
        self.assertGreater(o["minClear"], 7.5)

    def test_grades_and_curves(self):
        self.assertLessEqual(self.o["maxGrade"], 0.0351)
        self.assertGreater(self.o["minR"], 8)

    def test_station_to_station_across_the_sea(self):
        o = self.o
        self.assertLess(o["startFromDoor"], 40)
        self.assertLess(o["endFromDoor"], 40)
        self.assertGreater(o["seaB"] - o["seaA"], 1000, "a sea viaduct between the coasts")
        self.assertAlmostEqual(o["len"], o["lenB"], delta=o["len"]*0.03, msg="the same line built from either end")
        # the way back runs on the same track
        self.assertAlmostEqual(o["revLen"], o["len"], delta=0.01)
        self.assertLess(o["revStart"], 0.01)
        self.assertEqual(o["revHand"], "sea")
        self.assertTrue(60 < o["revT"] < 600)

    def test_runs_forward_from_rest_to_rest(self):
        o = self.o
        self.assertEqual(o["back"], 0)
        self.assertEqual(o["s0v"], 0)
        self.assertLess(o["s1v"], 0.5)
        self.assertLessEqual(o["maxV"], 45.0001)
        self.assertLess(o["maxA"], 2.5)
        self.assertGreater(o["s1a"], o["s0a"])
        self.assertTrue(60 < o["T"] < 600, o["T"])

    def test_hands_over_mid_sea(self):
        self.assertEqual(self.o["handLeg"], "sea")
        self.assertAlmostEqual(self.o["handA"], self.o["handB"], delta=40)

    def test_timetable(self):
        o = self.o
        self.assertTrue(o["same"])
        self.assertEqual(o["gap"], 180000)
        self.assertGreaterEqual(o["n"], 6)
        self.assertTrue(o["interleave"])
        self.assertTrue(o["next"])
        self.assertEqual(o["key"], "claude-hq@2|user:x@2")

    def test_station_menu(self):
        o = self.o
        # on your island: ride the built line, build to the other island with a station, not to a tier-1 one
        self.assertEqual(o["rowsMine"], ["ride:claude-hq@2", "build:user:bbbbbbbb-0000-4000-8000-000000000002@2"])
        # in the Commons: ride to your island; the others are built from their own stations
        self.assertEqual(o["rowsCommons"], ["ride:user:aaaaaaaa-0000-4000-8000-000000000001@2", "note:user:bbbbbbbb-0000-4000-8000-000000000002@2"])
        self.assertEqual(o["rowsNoLine"], ["build-from"])
        self.assertEqual(o["rowsLowTier"], 0)

    def test_lines_from_one_station_run_side_by_side(self):
        o = self.o
        lane = 7.7
        self.assertLess(o["sepNone"], 1, "without lanes the three lines share one track out of the station")
        self.assertEqual(o["lanes3"], [-lane, 0, lane])
        self.assertTrue(o["lanesSame"], "the same lanes whatever order the lines are listed in")
        # never on one track: the trains (2.9 m wide) and the masts beside them stay clear
        self.assertGreater(o["sep3"], 6)
        self.assertGreater(o["sep2"], 7)
        self.assertEqual([l["off"] for l in o["lanes2"]], [-lane/2, lane/2])
        self.assertAlmostEqual(o["platGap"], lane, delta=0.3)
        # the island platform between them is drawn once (by the right-hand line) and both see their neighbour
        self.assertEqual([(l["left"], l["right"]) for l in o["lanes2"]], [(True, False), (False, True)])
        self.assertEqual(o["lane1"]["off"], 0)
        self.assertEqual(o["lanesApart"], [0, 0])


if __name__ == "__main__":
    unittest.main()
