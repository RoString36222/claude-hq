"""games/hqair.js: an airliner from the Commons' airport to an island's, a seaplane dock to dock, run under node."""
import json
import math
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
SCRIPT = r"""
const fs = require('fs'), zlib = require('zlib'), path = require('path'), R0 = process.argv[1];
global.window = {HQV: {}};
for(const f of ['world', 'hqvoyage', 'hqair']) eval(fs.readFileSync(path.join(R0, 'games', f + '.js'), 'utf8'));
const WD = window.HQV.world, A = window.HQV.hqAir;
const doc = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(R0, 'tests/fixtures', f + '.json.gz'))));
const Wc = WD.pack(doc('claude-hq@2')), Wi = WD.pack(doc('island@2')), B = {x: 2400, z: -3200};
const site = Wc.sites.find(s => s.kind === 'airport');
const ea = A.airportEnd(site, 0, 0, 0.3), eb = A.nominalAirport(B.x, B.z, [0, 0]);
const R = A.route('jet', {world: 'claude-hq@2', x: 0, z: 0}, {world: 'user:x@2', x: B.x, z: B.z}, {a: ea, b: eb});
const out = {T: R.T, cruiseY: R.cruiseY, y0: ea.y, y1: eb.y};
let back = 0, prev = -1, maxY = -1e9, maxV = 0, liftV = null, maxRoll = 0, maxPitch = -1, minPitch = 1, phases = [], gearUpAir = false;
for(let t = 0; t <= R.T; t += 0.5){
  const p = A.poseAt(R, t);
  if(p.along < prev - 1e-6) back++; prev = p.along;
  maxY = Math.max(maxY, p.y); maxV = Math.max(maxV, p.speed); maxRoll = Math.max(maxRoll, Math.abs(p.roll));
  maxPitch = Math.max(maxPitch, p.pitch); minPitch = Math.min(minPitch, p.pitch);
  if(liftV == null && p.along >= R.sLift) liftV = p.speed;
  if(p.gear < 0.01 && p.y > 200) gearUpAir = true;
  if(!phases.length || phases[phases.length - 1] !== p.phase) phases.push(p.phase);
}
const s0 = A.poseAt(R, 0), s1 = A.poseAt(R, R.T), h = A.poseAt(R, R.hand);
if(phases[phases.length - 1] !== s1.phase) phases.push(s1.phase);
// the glideslope: the height lost per metre over the 600..1500 m before touchdown, and the heading on the final
const yAt = d => { let lo = 0, hi = R.T; for(let i = 0; i < 60; i++){ const m = (lo + hi)/2; if(A.poseAt(R, m).along < R.sTD - d) lo = m; else hi = m; } return A.poseAt(R, lo); };
const g0 = yAt(1500), g1 = yAt(600), gs = (g0.y - g1.y)/900;
const land = Math.atan2(-eb.dir[0], -eb.dir[1]);
let finalOff = 0; for(const d of [200, 800, 1500, 2200]) finalOff = Math.max(finalOff, Math.abs(Math.atan2(Math.sin(yAt(d).yaw - land), Math.cos(yAt(d).yaw - land))));
const td = yAt(0.5), tdAlong = (td.x - eb.thr[0])*eb.dir[0] + (td.z - eb.thr[1])*eb.dir[1], tdSide = Math.abs((td.x - eb.thr[0])*eb.dir[1] - (td.z - eb.thr[1])*eb.dir[0]);
Object.assign(out, {back, maxY, maxV, liftV, maxRoll, maxPitch, minPitch, phases, gearUpAir, s0v: s0.speed, s1v: s1.speed,
  start: [s0.x - ea.taxi[0][0], s0.z - ea.taxi[0][1]], end: [s1.x - eb.taxi[0][0], s1.z - eb.taxi[0][1]], endPhase: s1.phase,
  hand: [Math.hypot(h.x, h.z), Math.hypot(h.x - B.x, h.z - B.z), h.y], gs, finalOff, tdAlong, tdSide, len: eb.len, runwayY: [s0.y, s1.y]});
// the seaplane: the Commons' dock to the island's, on the water at both ends
const S = A.route('sea', {world: 'claude-hq@2', x: 0, z: 0}, {world: 'user:x@2', x: B.x, z: B.z},
                  {a: A.dockEnd(Wc, 0, 0, [B.x, B.z]), b: A.dockEnd(Wi, B.x, B.z, [0, 0])});
let wet = 0, dry = 0, sMaxY = 0;
for(let t = 0; t <= S.T; t += 1){
  const p = A.poseAt(S, t); sMaxY = Math.max(sMaxY, p.y);
  if(p.air) continue;
  const inA = Math.hypot(p.x, p.z) < Math.hypot(p.x - B.x, p.z - B.z), W = inA ? Wc : Wi, lx = inA ? p.x : p.x - B.x, lz = inA ? p.z : p.z - B.z;
  if(WD.riverAt(W, lx, lz) || WD.heightAt(W, lx, lz) < -0.5 || Math.hypot(lx, lz) > V_coast(W)) wet++; else dry++;
}
function V_coast(W){ return window.HQV.hqVoyage.coastR(W); }
const se = A.poseAt(S, S.T), sb = window.HQV.hqVoyage.berthOf(Wi), std = (() => { let lo = 0, hi = S.T; for(let i = 0; i < 60; i++){ const m = (lo + hi)/2; if(A.poseAt(S, m).along < S.sTD) lo = m; else hi = m; } return A.poseAt(S, hi); })();
out.sea = {T: S.T, wet, dry, maxY: sMaxY, end: [se.x - B.x - sb.x, se.z - B.z - sb.z], endV: se.speed, tdH: WD.heightAt(Wi, std.x - B.x, std.z - B.z),
           tdR: Math.hypot(std.x - B.x, std.z - B.z), coast: V_coast(Wi)};
const f1 = A.flights('a', 'b', 1e9, 6e5, 6e5), f2 = A.flights('a', 'b', 1e9, 6e5, 6e5), f3 = A.flights('b', 'a', 1e9, 6e5, 6e5);
out.sched = {same: JSON.stringify(f1) === JSON.stringify(f2), n: f1.length, directed: JSON.stringify(f1) !== JSON.stringify(f3), next: A.nextFlight('a', 'b', 1e9) >= 1e9};
const amb = A.ambient([{world: 'claude-hq@2', x: 0, z: 0}, {world: 'user:x@2', x: B.x, z: B.z}, {world: 'user:y@2', x: -3000, z: 2500}], 1e12, 0, 0, 9000);
out.amb = {n: amb.length, minY: Math.min(...amb.map(a => a.y)), trail: amb.every(a => a.trail.length === 2)};
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class AirTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", SCRIPT, ROOT], capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout)

    def test_stand_to_stand(self):
        o = self.o
        self.assertEqual(o["back"], 0)
        self.assertEqual(o["s0v"], 0)
        self.assertLess(o["s1v"], 0.5)
        self.assertLess(math.hypot(*o["start"]), 0.5)
        self.assertLess(math.hypot(*o["end"]), 0.5)
        self.assertEqual(o["endPhase"], "parked")
        self.assertAlmostEqual(o["runwayY"][0], o["y0"], places=3)
        self.assertAlmostEqual(o["runwayY"][1], o["y1"], places=3)

    def test_phases_in_order(self):
        want = ["taxi", "takeoff", "climb", "descent", "approach", "flare", "rollout", "taxi", "parked"]
        got = [p for p in self.o["phases"] if p != "cruise"]
        self.assertEqual(got, want)

    def test_takeoff_and_cruise(self):
        o = self.o
        self.assertGreater(o["liftV"], 60)          # rotates near 70 m/s
        self.assertLessEqual(o["maxV"], 115.001)
        self.assertLessEqual(o["maxY"], o["cruiseY"] + 0.01)
        self.assertGreater(o["maxY"], 300)
        self.assertTrue(o["gearUpAir"])
        self.assertLess(o["maxRoll"], 0.61)
        self.assertLess(o["maxPitch"], 0.3)
        self.assertGreater(o["minPitch"], -0.15)

    def test_glideslope_onto_the_runway(self):
        o = self.o
        self.assertAlmostEqual(math.degrees(math.atan(o["gs"])), 3.0, delta=0.15)
        self.assertLess(math.degrees(o["finalOff"]), 1.0)
        self.assertLess(o["tdSide"], 1.0)
        self.assertGreater(o["tdAlong"], 0)
        self.assertLess(o["tdAlong"], o["len"])

    def test_hands_over_in_the_air_far_from_both(self):
        a, b, y = self.o["hand"]
        self.assertGreater(min(a, b), 1500)
        self.assertGreater(y, 50)

    def test_seaplane_on_the_water(self):
        s = self.o["sea"]
        self.assertGreater(s["wet"], 50)
        self.assertEqual(s["dry"], 0)
        self.assertGreater(math.hypot(*s["end"]), 40)    # tied up down the river from the ferry's berth
        self.assertLess(math.hypot(*s["end"]), 80)
        self.assertLess(s["endV"], 0.5)
        self.assertGreater(s["tdR"], s["coast"])      # touches down at sea, off the mouth
        self.assertGreater(s["maxY"], 150)

    def test_schedules(self):
        s = self.o["sched"]
        self.assertTrue(s["same"])
        self.assertTrue(s["directed"])
        self.assertEqual(s["n"], 10)
        self.assertTrue(s["next"])

    def test_ambient_high_with_contrails(self):
        a = self.o["amb"]
        self.assertGreater(a["n"], 0)
        self.assertGreaterEqual(a["minY"], 1500)
        self.assertTrue(a["trail"])


if __name__ == "__main__":
    unittest.main()
