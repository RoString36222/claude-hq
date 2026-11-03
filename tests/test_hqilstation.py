"""[island trains] games/hqilstation.js and the Island Link's stations in games/hqrail.js, run under node: an island
without an IL in its doc gets its own terminal on its coast (islandLeg), the station is a walkable place (floors, walls,
gates, stairs, platforms, the camera's boxes) and its passengers are a pure function of the timetable and the clock."""
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
for (const f of ['world.js', 'hqnav.js', 'hqrail.js', 'hqilstation.js', 'hqride.js', 'npcsim.js']) eval(fs.readFileSync(path.join(R0, 'games', f), 'utf8'));
const WD = window.HQV.world, RL = window.HQV.hqRail, ST = window.HQV.hqILStation;
const doc = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(R0, 'tests/fixtures', f + '.json.gz'))));
const raw = doc('island@2'), Wi = WD.pack(raw), ISL = 'user:aaaaaaaa-0000-4000-8000-000000000001@3', C3 = 'claude-hq@3';
const IP = {x: 2600, z: -900}, TOW = [-IP.x, -IP.z];
const out = {};
// ---- the island's own terminal
const g = RL.islandLeg(Wi, TOW), g2 = RL.islandLeg(Wi, TOW);
const st = g.station, ax = st.along[0], az = st.along[1], lx = az, lz = -ax, tl = Math.hypot(TOW[0], TOW[1]);
function w(u, v){ return [st.x + ax*u + lx*v, st.z + az*u + lz*v]; }
function inPoly(P, x, z){ let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const a = P[i], b = P[j]; if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0])*(z - a[1])/(b[1] - a[1]) + a[0]) c = !c; } return c; }
const lots = (Wi.lots || []).filter(l => l && l.poly && l.poly.length >= 3).map(l => l.poly.map(q => [q[0]/100, q[1]/100]));
let underLot = 0;
for (let u = -55; u <= 55; u += 2) for (let v = -4; v <= 9; v += 1.5) { const p = w(u, v); if (lots.some(P => inPoly(P, p[0], p[1]))) underLot++; }
const coast = Wi.island.coast.map(q => [q[0]/100, q[1]/100]);
let hallWet = 0;
for (let u = -24; u <= 2; u += 2) for (let v = -1.4; v <= 9.6; v += 2) { const p = w(u, v); if (!inPoly(coast, p[0], p[1])) hallWet++; }
out.leg = {gen: !!st.gen, kind: st.kind, same: JSON.stringify(g) === JSON.stringify(g2), face: (ax*TOW[0] + az*TOW[1])/tl, underLot, hallWet,
  over: st.y - st.ground, seaOut: !inPoly(coast, g.sea.x, g.sea.z), P0: Math.hypot(g.P[0][0] - st.x, g.P[0][2] - st.z), ilOf: RL.ilOf(Wi) === g,
  commons: RL.ilOf(WD.pack(doc('claude-hq@2')), TOW)};
// ---- the service on the island: its local stop, the route out of the terminal, the doors on the platform side
const ARCH = {commons: {x: 0, z: 0}, islands: [{world: ISL, x: IP.x*100, z: IP.z*100, name: 'Ravi'}]};
const svc = RL.linkService({here: ISL, W: Wi, arch: ARCH, docs: {}});
const spec = svc.station(), L = ST.layout(spec), l0 = svc.lines()[0], ms = 1e12;
const tr = svc.trip(l0.id, l0.stops[0], l0.stops[1], ms), p0 = tr.pose(tr.depart - 10000), d0 = tr.door(tr.depart - 10000);
const dl = L.loc(d0.x, d0.z), onPlat = L.floorAt(d0.x + L.lx*(dl.v < spec.plats[0].c ? 0.5 : -0.5), L.yp, d0.z + L.lz*(dl.v < spec.plats[0].c ? 0.5 : -0.5));
const sp = svc.spawn(), spf = L.floorAt(sp.x, L.yp + 0.2, sp.z);
out.isl = {stop: svc.stops()[0].name, tracks: spec.tracks.length, plats: spec.plats.length, mid: Math.hypot(p0.x - spec.x, p0.z - spec.z), floorY: p0.y - L.yp,
  doorV: dl.v, doorOn: onPlat ? onPlat.kind : null, spawn: spf ? spf.kind : null, far: tr.toName, sideDep: svc.sideHere(l0.id, false), sideArr: svc.sideHere(l0.id, true)};
// ---- the station's floors, walls, gates and stairs (a Commons-like spec: six tracks, three island platforms)
const SC = {id: 'il:c', x: 100, z: -50, ax: 0.6, az: 0.8, yr: 17, ys: 8, len: 110, commons: true, tracks: [], plats: []};
RL.LINK_LAT.forEach((v, i) => SC.tracks.push({plat: i + 1, v: -v}));
for (let k = 0; k < 6; k += 2) SC.plats.push({c: -(RL.LINK_LAT[k] + RL.LINK_LAT[k + 1])/2, hw: RL.LINK_PW/2, tracks: [k + 1, k + 2]});
const C = ST.layout(SC), W = (u, v) => C.world(u, v), yes = () => true, no = () => false;
const H = C.hall, s0 = C.stairs[1], pc = C.plats[1].c;
function b(u, v, feet, ok){ const p = W(u, v); return C.blocked(p.x, p.z, feet, ok || yes); }
function f(u, v, y){ const p = W(u, v), q = C.floorAt(p.x, y, p.z); return q ? [q.kind, +q.y.toFixed(2)] : null; }
out.lay = {
  hallFloor: f(-20, 0, 8), stairLow: f(s0.u0 + 1, pc, 8.3), stairMid: f((s0.u0 + s0.u1)/2, pc, (s0.y0 + s0.y1)/2), plat: f(30, pc, C.yp), track: f(30, SC.tracks[2].v, C.yp),
  well: f(5, pc, C.yp), stairTop: f(s0.u1 - 0.1, pc, C.yp),
  // walls: shut but at the doors; the gates: shut without a ticket, open in a lane with one, the glass between always
  wall: b(H.u0, pc + 3.5, 8), door: b(H.u0, pc, 8), side: b(-10, H.v1, 8), inHall: b(-20, pc, 8),
  gateNo: b(-15, pc + 0.55, 8, no), gateYes: b(-15, pc + 0.55, 8, yes), glass: b(-15, pc + 3.6, 8, yes),
  // a stair is walked on at its foot, never from its side nor under it; up top, the edges and the well are shut
  stairFoot: b(s0.u0 + 0.1, pc, 8), stairSide: b(s0.u0 + 6, pc + s0.hw + 0.2, 8), underStair: b(s0.u0 + 10, pc, 8),
  edge: b(30, C.plats[1].c + C.plats[1].hw - 0.1, C.yp), platOk: b(30, pc, C.yp), wellUp: b(5, pc, C.yp), onTrack: b(30, SC.tracks[2].v, C.yp),
  street: b(-40, 0, 8), paidStreet: C.paidAt(W(-20, 0).x, W(-20, 0).z, 8), paidHall: C.paidAt(W(-10, 0).x, W(-10, 0).z, 8), paidPlat: C.paidAt(W(30, pc).x, W(30, pc).z, C.yp),
  machines: C.machines.length, lanes: C.gate.lanes.length,
  ceilHall: C.ceilAt(W(-20, 0).x, 9, W(-20, 0).z), ceilPlat: C.ceilAt(W(30, pc).x, C.yp + 1, W(30, pc).z),
  // the camera: kept inside the hall from inside it, stopped at its wall from outside, under a canopy
  camIn: C.camHit({x: W(-20, 0).x, y: 9.6, z: W(-20, 0).z}, {x: W(-40, 0).x, y: 11, z: W(-40, 0).z}),
  camOut: C.camHit({x: W(-40, 0).x, y: 9.6, z: W(-40, 0).z}, {x: W(-10, 0).x, y: 9.6, z: W(-10, 0).z}),
  camCanopy: C.camHit({x: W(30, pc).x, y: C.yp + 1.6, z: W(30, pc).z}, {x: W(30, pc).x, y: C.yp + 8, z: W(30, pc).z})};
// ---- the passengers: the same for everyone, never faster than walking, all aboard before the doors shut
const deps = [{key: 'IL:x:1', at: 1e12, open: 1e12 - 40000, plat: 1, track: SC.tracks[2].v, doors: [W(-10, SC.tracks[2].v - 1.47), W(10, SC.tracks[2].v - 1.47)]}];
const arrs = [{key: 'IL:x:a1', at: 1e12 - 60000, plat: 1, track: SC.tracks[3].v, doors: [W(0, SC.tracks[3].v + 1.47)]}];
let seen = {}, fast = 0, after = 0, maxN = 0;
for (let t = 1e12 - 400000; t <= 1e12 + 5000; t += 100) {
  const a = ST.walkers(C, t, {deps, arrs}), b2 = ST.walkers(C, t, {deps, arrs});
  if (JSON.stringify(a) !== JSON.stringify(b2)) out.notSame = true;
  maxN = Math.max(maxN, a.length);
  a.forEach(r => { const p = seen[r.id]; if (p && p.t === t - 100 && Math.hypot(r.x - p.x, r.z - p.z, r.y - p.y) > 0.25) fast++; seen[r.id] = {x: r.x, y: r.y, z: r.z, t};
    if (t >= 1e12 && r.key.indexOf('b:') === 0) after++; });
}
out.walk = {ids: Object.keys(seen).length, fast, after, maxN, same: !out.notSame};
// ---- the ride carried over to another world keeps its session (hqRide.session().rebind)
const S = window.HQV.hqRide.session({trip: tr, now: () => ms});
out.rebind = typeof S.rebind === 'function';
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class ILStationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", SCRIPT, ROOT], capture_output=True, text=True, timeout=180)
        if r.returncode != 0:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_an_island_gets_its_own_terminal(self):
        g = self.o["leg"]
        self.assertTrue(g["gen"])
        self.assertEqual(g["kind"], "elevated")
        self.assertTrue(g["same"], "a pure function of the doc and the direction")
        self.assertGreater(g["face"], 0.3, "on the coast facing the Commons")
        self.assertEqual(g["underLot"], 0, "no building under the platforms")
        self.assertEqual(g["hallWet"], 0, "the hall stands on land")
        self.assertGreaterEqual(g["over"], 9 - 0.01, "the platforms up over the street")
        self.assertTrue(g["seaOut"], "the line runs out over the water")
        self.assertAlmostEqual(g["P0"], 35.7 + 8, delta=0.2)          # behind the platform: a train's middle stands at it
        self.assertTrue(g["ilOf"])
        self.assertIsNone(g["commons"], "the Commons never gets an island's terminal")

    def test_the_island_service_stands_its_train_at_the_terminal(self):
        s = self.o["isl"]
        self.assertEqual(s["stop"], "Ravi's island")
        self.assertEqual(s["far"], "Commons Central")
        self.assertEqual((s["tracks"], s["plats"]), (1, 1))
        self.assertLess(s["mid"], 1.0)
        self.assertAlmostEqual(s["floorY"], 0, delta=0.05, msg="the car's floor level with the platform")
        self.assertEqual(s["doorOn"], "platform", "the door it stands with open is on the platform's side")
        self.assertEqual(s["spawn"], "platform")
        self.assertEqual((s["sideDep"], s["sideArr"]), (1, -1))

    def test_the_station_is_walkable(self):
        l = self.o["lay"]
        self.assertEqual(l["hallFloor"], ["hall", 8])
        self.assertEqual(l["stairLow"][0], "stairs")
        self.assertEqual(l["stairMid"][0], "stairs")
        self.assertEqual(l["plat"], ["platform", 17.95])
        self.assertIsNone(l["track"])
        self.assertEqual(l["well"][0], "stairs", "over a well only the stairs below it")
        self.assertLess(l["well"][1], 17.95 - 1)
        self.assertEqual(l["stairTop"][0], "stairs")
        self.assertTrue(l["wall"])
        self.assertFalse(l["door"])
        self.assertTrue(l["side"])
        self.assertFalse(l["inHall"])
        self.assertTrue(l["gateNo"])
        self.assertFalse(l["gateYes"])
        self.assertTrue(l["glass"])
        self.assertFalse(l["stairFoot"])
        self.assertTrue(l["stairSide"])
        self.assertTrue(l["underStair"])
        self.assertTrue(l["edge"])
        self.assertFalse(l["platOk"])
        self.assertTrue(l["wellUp"])
        self.assertTrue(l["onTrack"])
        self.assertIsNone(l["street"], "outside the station the street decides")
        self.assertEqual((l["paidStreet"], l["paidHall"], l["paidPlat"]), (False, True, True))
        self.assertEqual(l["machines"], 6)
        self.assertEqual(l["lanes"], 12)
        self.assertAlmostEqual(l["ceilHall"], 8 + 4.4)
        self.assertAlmostEqual(l["ceilPlat"], 17.95 + 3.6)

    def test_the_camera_keeps_to_the_station(self):
        l = self.o["lay"]
        self.assertLess(l["camIn"], 0.25, "from inside the hall the camera stays inside it")
        self.assertTrue(0.3 < l["camOut"] < 0.6, "from the street it stops at the hall's wall")
        self.assertLess(l["camCanopy"], 0.5, "under the canopy, not through it")

    def test_passengers(self):
        w = self.o["walk"]
        self.assertTrue(w["same"], "a pure function of the station, the timetable and the clock")
        self.assertGreaterEqual(w["ids"], 5)
        self.assertEqual(w["fast"], 0, "nobody moves faster than a walk")
        self.assertEqual(w["after"], 0, "every passenger is aboard before the doors close")
        self.assertLessEqual(w["maxN"], 60)

    def test_session_can_be_carried_into_another_world(self):
        self.assertTrue(self.o["rebind"])


if __name__ == "__main__":
    unittest.main()
