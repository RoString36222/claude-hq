"""games/hqrail.js: a rail line from the Commons' station to an island's, and the Island Link (HQ 3.15, D7), run under node."""
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
const A0 = {world: 'claude-hq@3', x: 0, z: 0, W: Wc, tier: 5, sea: Wc.island.sea_cm/100};
const B0 = {world: 'user:x@3', x: B.x, z: B.z, W: Wi, tier: TIER_B, sea: Wi.island.sea_cm/100};
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
const da1 = RL.departures('claude-hq@3', 'user:x@3', 1e12, 6e5, 6e5), da2 = RL.departures('claude-hq@3', 'user:x@3', 1e12, 6e5, 6e5);
const db1 = RL.departures('user:x@3', 'claude-hq@3', 1e12, 6e5, 6e5);
out.same = JSON.stringify(da1) === JSON.stringify(da2); out.n = da1.length; out.gap = da1[1] - da1[0];
out.interleave = Math.abs(((db1[0] - da1[0]) % RL.EVERY + RL.EVERY) % RL.EVERY - RL.EVERY/2) < 1;
out.next = RL.nextDeparture('claude-hq@3', 'user:x@3', 1e12) >= 1e12;
out.key = RL.lineKey('user:x@3', 'claude-hq@3');
// the station menu
const rail = {cost: 500, min_tier: 2, lines: [{a: 'claude-hq@3', b: 'user:aaaaaaaa-0000-4000-8000-000000000001@3'}]};
const mine = 'user:aaaaaaaa-0000-4000-8000-000000000001@3', other = 'user:bbbbbbbb-0000-4000-8000-000000000002@3';
const places = [{world: 'claude-hq@3', name: 'The Commons', tier: 5}, {world: other, name: 'Bee', tier: 2}, {world: 'user:cccccccc-0000-4000-8000-000000000003@3', name: 'Sea', tier: 1}];
out.rowsMine = RL.menuRows(rail, mine, places, mine, 3, 1e12).map(r => r.kind + ':' + r.to.world);
out.rowsCommons = RL.menuRows(rail, 'claude-hq@3', [{world: mine, name: 'My island', tier: 3}, {world: other, name: 'Bee', tier: 2}], mine, 3, 1e12).map(r => r.kind + ':' + r.to.world);
out.rowsNoLine = RL.menuRows({lines: []}, 'claude-hq@3', [{world: mine, name: 'My island', tier: 3}], mine, 3, 1e12).map(r => r.kind);
out.rowsLowTier = RL.menuRows({lines: []}, mine, places, mine, 1, 1e12).length;
// an older Arena lists @2 lines: they still show from an @3 world (as that world's version), and @2 worlds still work
const rail2 = {cost: 500, min_tier: 2, lines: [{a: 'claude-hq@2', b: 'user:aaaaaaaa-0000-4000-8000-000000000001@2'}]};
out.at2 = RL.linesAt(rail2, 'claude-hq@3').map(l => l.other);
out.at2on2 = RL.linesAt(rail2, 'claude-hq@2').map(l => l.other);
out.rows2 = RL.menuRows(rail2, mine, places, mine, 3, 1e12).map(r => r.kind + ':' + r.to.world);
out.junk = RL.linesAt({lines: [{a: 'claude-hq@9', b: mine}, {a: 'user:../x@3', b: 'claude-hq@3'}, {a: mine, b: mine.replace('@3', '@2')}]}, 'claude-hq@3').length;
out.commons = RL.commonsId();
// three lines out of the Commons' station along the same streets: side by side in lanes, never on one track
const Bs = [{world: 'user:a@3', x: 2400, z: -3200}, {world: 'user:b@3', x: 3100, z: -2300}, {world: 'user:c@3', x: 1500, z: -3500}];
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
out.lane1 = RL.lanes(Wc, 5, {x: 0, z: 0}, Bs.slice(0, 1))['user:a@3'];
// lines leaving the other way along the street (one north-west, one south-east): no lanes
const Lo = RL.lanes(Wc, 5, {x: 0, z: 0}, [{world: 'user:a@3', x: 2400, z: -3200}, {world: 'user:d@3', x: -3000, z: 2600}]);
out.lanesApart = [Lo['user:a@3'].off, Lo['user:d@3'].off];
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
        self.assertEqual(o["key"], "claude-hq@3|user:x@3")

    def test_station_menu(self):
        o = self.o
        # on your island: ride the built line, build to the other island with a station, not to a tier-1 one
        self.assertEqual(o["rowsMine"], ["ride:claude-hq@3", "build:user:bbbbbbbb-0000-4000-8000-000000000002@3"])
        # in the Commons: ride to your island; the others are built from their own stations
        self.assertEqual(o["rowsCommons"], ["ride:user:aaaaaaaa-0000-4000-8000-000000000001@3", "note:user:bbbbbbbb-0000-4000-8000-000000000002@3"])
        self.assertEqual(o["rowsNoLine"], ["build-from"])
        self.assertEqual(o["rowsLowTier"], 0)

    def test_older_arena_ids(self):
        o = self.o
        mine = "user:aaaaaaaa-0000-4000-8000-000000000001"
        self.assertEqual(o["at2"], [mine + "@3"])          # an @2 line, seen from the live @3 Commons
        self.assertEqual(o["at2on2"], [mine + "@2"])       # an @2 client keeps @2
        self.assertEqual(o["rows2"], ["ride:claude-hq@3", "build:user:bbbbbbbb-0000-4000-8000-000000000002@3"])
        self.assertEqual(o["junk"], 0)                     # unknown versions, bad ids and a line to itself
        self.assertEqual(o["commons"], "claude-hq@3")

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


# ---------- the Island Link (HQ 3.15, D7) ----------
# An island: the synthetic @3 doc tests/fixtures/world_v3_tiny.json (its IL: an underground platform, a tunnel, a
# portal, the track at grade to the sea abutment). The Commons: a synthetic raw doc with Commons Central (6 platforms)
# and its sea junction. With tests/fixtures/claude-hq@3.json.gz and island@3.json.gz present, the same checks run on them.
IL_SCRIPT = r"""
const fs = require('fs'), zlib = require('zlib'), path = require('path'), R0 = process.argv[1];
const store = {};
global.window = {HQV: {}, localStorage: {getItem: k => k in store ? store[k] : null, setItem: (k, v) => { store[k] = String(v); }}}; global.self = window;
for (const f of ['world.js', 'hqride.js', 'hqcommute.js', 'hqrail.js', 'hqtravel.js']) eval(fs.readFileSync(path.join(R0, 'games', f), 'utf8'));
const WD = window.HQV.world, RL = window.HQV.hqRail, TV = window.HQV.hqTravel, RD = window.HQV.hqRide;
const out = {};
const ISL = 'user:aaaaaaaa-0000-4000-8000-000000000001@3', ISL2 = ISL.replace('@3', '@2'), C3 = 'claude-hq@3';
const Wi = WD.pack(JSON.parse(fs.readFileSync(path.join(R0, 'tests/fixtures/world_v3_tiny.json'))));
// the Commons (raw doc, cm): Commons Central (a surface terminal) at (0, 0), the IL out to the junction 600 m south
const CDOC = {id: C3, layers: {island: {sea_cm: 0}, sites: [], rail: {
  lines: [{id: 'IL', kind: 'island', stations: ['rail:9'], path: [[0, 600, 0], [0, 600, -30000], [0, 500, -45000], [0, 400, -60000]], kinds: ['grade', 'grade', 'viaduct'], tier: 1}],
  stations: [{id: 'rail:9', kind: 'terminal', x: 0, y: 600, z: 0, along: [0, -65536], len: 9000, platforms: 6, lines: ['IL'], stairs: []}],
  sea: {x: 0, z: -60000, y: 400, front: [0, -65536]}}}};
const ARCH = {commons: {x: 0, z: 0}, islands: [{world: ISL, x: 300000, z: -250000, name: 'Tiny'}]};
const IP = {x: 3000, z: -2500};
// ---- timetable: every 300 s each way, the same for @2 and @3, the two ways half a period apart ----
const d1 = RL.linkDepartures(ISL, 'out', 1e12, 0, 1.5e6), d2 = RL.linkDepartures(ISL2, 'out', 1e12, 0, 1.5e6), dIn = RL.linkDepartures(ISL, 'in', 1e12, 0, 1.5e6);
out.tt = {n: d1.length, gap: d1[1] - d1[0], same: JSON.stringify(d1) === JSON.stringify(d2), half: (((dIn[0] - d1[0]) % 300000) + 300000) % 300000,
          next: RL.linkNext(ISL, 'out', 1e12), travelNext: TV.linkNext(ISL, 'out', 1e12), travelNextIn: TV.linkNext(ISL2, 'in', 1e12 + 7), railNextIn: RL.linkNext(ISL, 'in', 1e12 + 7),
          other: RL.linkNext('user:bbbbbbbb-0000-4000-8000-000000000002@3', 'out', 1e12)};
// ---- platforms at Commons Central ----
const ids = []; for (let i = 0; i < 9; i++) ids.push('user:' + (i + 10) + 'aaaaaa-0000-4000-8000-000000000001@3');
const six = ids.slice(0, 6), p6 = six.map(w => RL.linkPlatform(w, six)), p6r = six.map(w => RL.linkPlatform(w, six.slice().reverse().map(x => x.replace('@3', '@2'))));
out.plat = {six: p6, sameOrder: JSON.stringify(p6) === JSON.stringify(p6r), nine: ids.map(w => RL.linkPlatform(w, ids)), alone: RL.linkPlatform(ISL)};
// ---- the route: island platform -> tunnel -> portal -> abutment -> sea viaduct -> junction -> Commons Central ----
const R = RL.linkRoute({world: ISL, x: IP.x, z: IP.z, W: Wi}, {world: C3, x: 0, z: 0, W: CDOC}, {plat: 2}), Rb = RL.reverse(R);
const il = RL.ilOf(Wi), st = il.station, mid0 = RL.at(R, RL.TRAIN_L/2 + RL.STOP_END), midE = RL.at(R, R.len - RL.TRAIN_L/2 - RL.STOP_END);
let kinds = [], under0 = -1, under1 = -1, minSea = 1e9, maxSea = -1e9, maxV = 0, back = 0, prev = -1;
for (let s = 0; s <= R.len; s += 4) { const k = RL.kAt(R, s); if (!kinds.length || kinds[kinds.length - 1] !== k) kinds.push(k); if (RL.underAt(R, s)) { if (under0 < 0) under0 = s; under1 = s; } }
for (let s = R.seaA + 300; s <= R.seaB - 300; s += 20) { const p = RL.at(R, s); minSea = Math.min(minSea, p.y); maxSea = Math.max(maxSea, p.y); }
for (let t = -5; t <= R.T + 5; t += 0.5) { const p = RL.poseAt(R, t); maxV = Math.max(maxV, p.speed); if (p.along < prev - 1e-6) back++; prev = p.along; }
const hp = RL.poseAt(R, R.hand);
out.route = {len: R.len, T: R.T, seaA: R.seaA, seaB: R.seaB, hand: R.hand, handLeg: hp.leg, kinds, under0, under1, minSea, maxSea, maxV, back,
  startOff: Math.hypot(mid0.x - IP.x - st.x, mid0.z - IP.z - st.z), startY: mid0.y - st.y,
  endOff: Math.hypot(midE.x - 0, midE.z - 0), endLat: Math.abs(midE.x), revLen: Rb.len, revT: Rb.T, revUnderEnd: RL.underAt(Rb, Rb.len - 40), revUnderStart: RL.underAt(Rb, 40),
  same: JSON.stringify(Array.from(RL.linkRoute({world: ISL, x: IP.x, z: IP.z, W: Wi}, {world: C3, x: 0, z: 0, W: CDOC}, {plat: 2}).pts)) === JSON.stringify(Array.from(R.pts))};
// ---- [3.36] the island on each side of the Commons: the sea viaduct never crosses its own land ----
out.swing = [IP, {x: -IP.x, z: -IP.z}, {x: -IP.z, z: IP.x}, {x: IP.z, z: -IP.x}].map(function(P){
  const Rs = RL.linkRoute({world: ISL, x: P.x, z: P.z, W: Wi}, {world: C3, x: 0, z: 0, W: CDOC}, {plat: 2}), co = Wi.island && Wi.island.coast; let over = 0;
  for (let s = Rs.seaA + 400; s <= Rs.seaB - 400; s += 10) { const q = RL.at(Rs, s), lx = (q.x - P.x)*100, lz = (q.z - P.z)*100; let ins = false;
    if (co) for (let i = 0, j = co.length - 1; i < co.length; j = i++) { const a = co[i], b = co[j]; if ((a[1] > lz) !== (b[1] > lz) && lx < (b[0] - a[0])*(lz - a[1])/(b[1] - a[1]) + a[0]) ins = !ins; }
    if (ins) over++; }
  return {over: over, coast: !!co};
});
// ---- the Service on the island ----
const svc = RL.linkService({here: ISL, W: Wi, arch: ARCH, docs: {[C3]: CDOC}});
const ms = 1.7e12, lines = svc.lines(), deps = svc.departures('il:' + ISL, ms, 4), T1 = svc.trip(lines[0].id, 'il:' + ISL, 'il:' + C3, ms);
const tun = T1.pose(T1.depart + 20000), sea = T1.pose(T1.hand), atEnd = T1.pose(T1.reach + 1000, 'to'), atStart = T1.pose(T1.arrive + 1000);
const seats = []; for (let i = 0; i < T1.seats + T1.standing; i++) { const sp = T1.seat(i, T1.hand), pp = T1.pose(T1.hand); seats.push([Math.hypot(sp.x - pp.x, sp.z - pp.z), sp.y - pp.y]); }
out.isl = {lines: lines.map(l => [l.id, l.short, l.world, l.stops]), stops: svc.stops().map(s => [s.id, s.under, s.name]), deps: deps.map(d => [d.at - ms, d.short, d.plat, d.to]),
  trip: {world: T1.world, mode: T1.mode, short: T1.short, dep: T1.depart - ms, arrive: T1.depart - T1.arrive, reach: (T1.reach - T1.depart)/1000, hand: (T1.hand - T1.depart)/1000,
         seats: T1.seats, standing: T1.standing, stops: T1.stops.map(s => s.id)},
  tunUnder: tun.under, seaUnder: sea.under, seaY: sea.y, startUnder: atStart.under, startDoors: atStart.doors, startOff: Math.hypot(atStart.x - st.x, atStart.z - st.z),
  endOffTo: Math.hypot(atEnd.x, atEnd.z), endDoors: atEnd.done, maxSeat: Math.max(...seats.map(q => q[0])), seatsY: [Math.min(...seats.map(q => q[1])), Math.max(...seats.map(q => q[1]))],
  veh: svc.vehicles(T1.depart + 20000).filter(v => v.id === T1.vehicle).map(v => [v.under, v.mode]), shift: T1.shift,
  noFrom: svc.trip(lines[0].id, 'il:' + C3, 'il:' + ISL, ms)};
// ---- the Service at the Commons: one line an island, each on its own platform ----
const isles = ['user:11111111-0000-4000-8000-000000000001@3', 'user:22222222-0000-4000-8000-000000000002@3', ISL];
const arch3 = {commons: {x: 0, z: 0}, islands: isles.map((w, i) => ({world: w, x: (i + 1)*250000, z: -250000 + i*90000}))};
const cs = RL.linkService({here: C3, W: CDOC, arch: arch3, docs: {[ISL]: Wi}});
const cl = cs.lines(), T2 = cs.trip('IL:' + ISL.replace('@3', ''), 'il:' + C3, 'il:' + ISL, ms);
out.com = {lines: cl.map(l => [l.id, l.world, l.plat]), local: cs.stops()[0].name, deps: cs.departures('il:' + C3, ms, 6).map(d => [d.plat, d.to, d.short]),
  trip: T2 && {world: T2.world, reach: (T2.reach - T2.depart)/1000, startUnder: T2.pose(T2.depart + 1000).under, endUnderTo: T2.pose(T2.reach - 5000, 'to').under,
               endTo: (() => { const p = T2.pose(T2.reach + 1000, 'to'); return Math.hypot(p.x - st.x, p.z - st.z); })()},
  sameRun: Math.abs((T2.reach - T2.depart) - (T1.reach - T1.depart)) < 1, inDep: (T2.depart - TV.linkNext(ISL, 'in', ms))};
// ---- spawns ----
out.spawn = {isl: RL.linkSpawn(Wi, ISL), com: RL.linkSpawn(CDOC, C3, ISL, isles), raw: RL.linkSpawn({layers: {sites: [{id: 'transit:0', kind: 'transit', x: 1000, z: 0, d: 2000, front: [0, 65536]}]}}, ISL)};
// ---- the planner: an IL leg to the other world ----
RD.register(svc);
const plan = RD.plan({x: st.x + 30, z: st.z}, {world: C3}, ms);
out.plan = plan.map(p => ({world: p.world, legs: p.legs.map(l => l.mode + ':' + (l.short || ''))}));
// ---- @3 fixtures, when there ----
const fx = f => path.join(R0, 'tests/fixtures', f);
if (fs.existsSync(fx('claude-hq@3.json.gz')) && fs.existsSync(fx('island@3.json.gz'))) {
  const doc = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(fx(f))));
  const Wc3 = WD.pack(doc('claude-hq@3.json.gz')), Wi3 = WD.pack(doc('island@3.json.gz'));
  const R3 = RL.linkRoute({world: ISL, x: 2400, z: -3200, W: Wi3}, {world: C3, x: 0, z: 0, W: Wc3}, {plat: 3});
  let u3 = false; for (let s = 0; s < R3.len; s += 8) if (RL.underAt(R3, s)) u3 = true;
  out.fix = {T: R3.T, len: R3.len, hand: R3.hand, seaA: R3.seaA, seaB: R3.seaB, under: u3, ilI: !!RL.ilOf(Wi3), ilC: !!RL.ilOf(Wc3), handLeg: RL.poseAt(R3, R3.hand).leg};
}
console.log(JSON.stringify(out));
"""

IL_VIEW = r"""
import fs from 'fs'; import path from 'path'; import url from 'url';
const R0 = process.argv[2];
const THREE = await import(url.pathToFileURL(R0 + '/games/vendor/three-module.js').href);
globalThis.window = {HQV: {}}; globalThis.self = globalThis.window;
for (const f of ['world.js', 'hqride.js', 'hqcommute.js', 'hqrail.js']) (new Function(fs.readFileSync(path.join(R0, 'games', f), 'utf8')))();
const H = window.HQV, WD = H.world, W = WD.pack(JSON.parse(fs.readFileSync(path.join(R0, 'tests/fixtures/world_v3_tiny.json'))));
const scene = new THREE.Scene(), c = {THREE, scene, mat: (col, o) => new THREE.MeshStandardMaterial(Object.assign({color: col}, o || {}))};
const ISL = 'user:aaaaaaaa-0000-4000-8000-000000000001@3';
const svc = H.hqRail.linkService({here: ISL, W, arch: {commons: {x: 0, z: 0}, islands: [{world: ISL, x: 300000, z: -250000}]}});
let under = false;
const V = H.hqRail.linkView(c, svc, {seaY: 0, under: () => under, night: () => true});
const ms = 1.7e12, out = {calls: [], under: []};
for (let t = 0; t < 600; t += 13) { V.update(ms + t*1000, 0.016, {x: 0, z: 0}); out.calls.push(V.drawCalls()); }
under = true; V.update(ms, 0.016, {x: 0, z: 0}); out.under.push(V.drawCalls());
under = false;
let m = ms; while (!svc.vehicles(m).length) m += 1000;
V.focus(svc.vehicles(m)[0].id); V.update(m, 0.016, {x: 0, z: 0}); out.focused = V.drawCalls();
out.shot = V.tools.shotCam('link-viaduct');
V.dispose();
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class IslandLinkTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", IL_SCRIPT, ROOT], capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout)

    def test_timetable_per_island(self):
        t = self.o["tt"]
        self.assertEqual(t["gap"], 300000)
        self.assertGreaterEqual(t["n"], 5)
        self.assertTrue(t["same"], "an @2 and an @3 id share the timetable")
        self.assertEqual(t["half"], 150000)
        self.assertEqual(t["next"], t["travelNext"], "hqTravel and hqRail agree")
        self.assertEqual(t["travelNextIn"], t["railNextIn"])
        self.assertNotEqual(t["next"], t["other"], "each island its own offset")

    def test_commons_platforms(self):
        p = self.o["plat"]
        self.assertEqual(sorted(p["six"]), [1, 2, 3, 4, 5, 6])
        self.assertTrue(p["sameOrder"], "whatever order and version the list comes in")
        self.assertTrue(all(1 <= x <= 6 for x in p["nine"]))
        self.assertEqual(sorted(set(p["nine"])), [1, 2, 3, 4, 5, 6], "shared once there are more than six")
        self.assertTrue(1 <= p["alone"] <= 6)

    def test_sea_viaduct_keeps_off_the_island_whichever_way_it_faces(self):
        for w in self.o["swing"]:
            self.assertTrue(w["coast"])
            self.assertEqual(w["over"], 0, w)

    def test_route_tunnel_portal_sea(self):
        r = self.o["route"]
        self.assertEqual(r["kinds"][0], 1, "it leaves underground")
        self.assertIn(2, r["kinds"])                  # through the portal
        self.assertIn(5, r["kinds"])                  # over the sea
        self.assertEqual(r["under0"], 0)
        self.assertGreater(r["under1"], 100)
        self.assertLess(r["startOff"], 3, "a train's middle stands at the island's IL platform")
        self.assertAlmostEqual(r["startY"], 0, delta=0.5)
        self.assertAlmostEqual(r["endLat"], 1.5*5.5, delta=1.0, msg="on platform 2's track at Commons Central")
        self.assertLess(r["endOff"], 12)
        self.assertTrue(12 <= r["minSea"] and r["maxSea"] <= 14.5, (r["minSea"], r["maxSea"]))   # 13 m over the water
        self.assertTrue(r["seaA"] < r["seaB"])
        self.assertEqual(r["handLeg"], "sea", "the handover is mid-sea")
        self.assertLessEqual(r["maxV"], 45.0001)
        self.assertEqual(r["back"], 0)
        self.assertTrue(60 < r["T"] < 900, r["T"])
        self.assertAlmostEqual(r["revLen"], r["len"], delta=0.01)
        self.assertTrue(r["revUnderEnd"] and not r["revUnderStart"], "the way back leaves the surface terminal and ends underground")
        self.assertTrue(r["same"], "a pure function of the docs and positions")

    def test_service_on_the_island(self):
        o = self.o["isl"]
        self.assertEqual(o["lines"], [["IL:user:aaaaaaaa-0000-4000-8000-000000000001", "IL", "claude-hq@3",
                                       ["il:user:aaaaaaaa-0000-4000-8000-000000000001@3", "il:claude-hq@3"]]])
        self.assertEqual(o["stops"][0][1], True, "the island's IL platform is underground")
        self.assertEqual(len(o["deps"]), 4)
        self.assertEqual([d[0] % 1 for d in o["deps"]], [0, 0, 0, 0])
        self.assertEqual(o["deps"][1][0] - o["deps"][0][0], 300000)
        self.assertEqual(o["deps"][0][1], "IL")
        t = o["trip"]
        self.assertEqual((t["world"], t["mode"], t["short"]), ("claude-hq@3", "link", "IL"))
        self.assertTrue(0 <= t["dep"] < 300000)
        self.assertEqual(t["arrive"], 40000)
        self.assertTrue(0 < t["hand"] < t["reach"])
        self.assertEqual((t["seats"], t["standing"]), (104, 32))
        self.assertTrue(o["tunUnder"] and not o["seaUnder"])
        self.assertTrue(10 < o["seaY"] < 16)
        self.assertTrue(o["startUnder"])
        self.assertEqual(o["startDoors"], 1)
        self.assertLess(o["startOff"], 3)
        self.assertLess(o["endOffTo"], 17, "pose(ms, 'to'): at Commons Central (on its platform's track) in the Commons' own frame")
        self.assertTrue(o["endDoors"])
        self.assertLess(o["maxSeat"], 40)
        self.assertTrue(-0.1 < o["seatsY"][0] and o["seatsY"][1] < 0.6)
        self.assertEqual(o["veh"], [[True, "link"]])
        self.assertEqual(o["shift"], {"x": -3000, "z": 2500})
        self.assertIsNone(o["noFrom"], "trains are boarded where you are")

    def test_service_at_the_commons(self):
        c = self.o["com"]
        self.assertEqual(len(c["lines"]), 3)
        self.assertEqual(len(set(l[2] for l in c["lines"])), 3, "one platform an island")
        self.assertEqual(c["local"], "Commons Central")
        self.assertEqual(len(c["deps"]), 6)
        self.assertTrue(all(d[2] == "IL" and d[0] in "123456" for d in c["deps"]))
        self.assertEqual(c["trip"]["world"], "user:aaaaaaaa-0000-4000-8000-000000000001@3")
        self.assertFalse(c["trip"]["startUnder"])
        self.assertTrue(c["trip"]["endUnderTo"], "into the island's tunnel at the end")
        self.assertLess(c["trip"]["endTo"], 3, "arrives at the island's IL platform")
        self.assertEqual(c["inDep"], 0)

    def test_spawns(self):
        s = self.o["spawn"]
        self.assertTrue(s["isl"]["under"])
        self.assertEqual(s["isl"]["world"], "user:aaaaaaaa-0000-4000-8000-000000000001@3")
        self.assertEqual(s["isl"]["site"], "rail:2")
        self.assertFalse(s["com"]["under"])
        self.assertEqual(s["com"]["site"], "rail:9")
        self.assertEqual(s["raw"]["site"], "transit:0", "no IL in the doc: the station")

    def test_planner_books_the_link(self):
        p = self.o["plan"]
        self.assertTrue(p)
        self.assertEqual(p[0]["world"], "claude-hq@3")
        self.assertEqual(p[0]["legs"][-1], "link:IL")

    def test_on_the_v3_fixtures(self):
        f = self.o.get("fix")
        if not f:
            self.skipTest("tests/fixtures/claude-hq@3.json.gz and island@3.json.gz not there yet")
        # a route always exists (a doc without its IL yet gets the nominal leg from its station to its coast)
        self.assertTrue(f["seaA"] < f["seaB"])
        self.assertTrue(30 < f["T"] < 1200, f["T"])
        self.assertEqual(f["handLeg"], "sea")
        if not (f["ilI"] and f["ilC"]):
            self.skipTest("the @3 fixtures carry no Island Link yet (layers.rail is empty)")
        self.assertTrue(f["under"])

    def test_view_budget(self):
        r = subprocess.run([NODE, "--input-type=module", "-e", IL_VIEW, "x", ROOT], capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            raise AssertionError(r.stderr)
        v = json.loads(r.stdout)
        self.assertLessEqual(max(v["calls"]), 4, "viaduct, trains (2), commuters")
        self.assertLessEqual(v["under"][0], 4)
        self.assertLessEqual(v["focused"], 6)
        self.assertIsNotNone(v["shot"])


if __name__ == "__main__":
    unittest.main()
