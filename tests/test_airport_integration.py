"""The airport's modules together (docs/plans/airport-spec.md section 11, integration).

node loads the real modules (games/world.js, hqairfield.js, hqair.js, hqairport3d.js, hqairbldg.js) against a stub
`window`, builds the Commons layout L from the real claude-hq@2 doc (HQV.hqAirfield.layout, not the fixture), and:
  - drawn = flown over the real modules: every stand, both runway ends, its class (jets at contact stands, the
    amphibian at commuter stands), departures and arrivals: hqAirfield.end() feeds hqAir.route(), and every ground
    sample of the flown track on the airfield lies within 0.5 m of a yellow centreline quad of hqAirport3d.plan()'s
    paint (the arrivals' A -> B U-turn included);
  - the walk from the terminal's door up the nave's ramp, over the skybridge and along the gallery to stand 3's gate
    with hqAirfield.floorAt and hqAirbldg.floorAt (the City's groundY), with no step over 0.5 m.
One node process for the whole file. Skipped when node is not installed. Stdlib only."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

HARNESS = r"""
var fs = require("fs"), zlib = require("zlib"), root = %(root)s;
global.window = {HQV: {}};
["world", "hqairfield", "hqair", "hqairport3d", "hqairbldg"].forEach(function(f){ new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))(); });
var HQV = window.HQV, WD = HQV.world, AF = HQV.hqAirfield, A = HQV.hqAir, A3 = HQV.hqAirport3d, B = HQV.hqAirbldg, out = {};
var W = WD.pack(JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/claude-hq@2.json.gz"))));
var site = (W.sites || []).filter(function(s){ return s.kind === "airport"; })[0];
var L = AF.layout(W, site), fx = JSON.parse(fs.readFileSync(root + "/tests/fixtures/airfield_commons.json", "utf8"));
out.sameAsFixture = JSON.stringify(L) === JSON.stringify(fx);
var ground = function(x, z){ return WD.heightAt(W, x, z); };
var P = A3.plan(L, {ground: ground});

/* ---------- drawn = flown ---------- */
// the yellow paint quads near the taxiways, bucketed (quads are [x0, y0, z0, .. x3, y3, z3])
var Y = P.paint.yellow, BK = 20, grid = {};
function key(i, j){ return i + "," + j; }
Y.forEach(function(q, n){
  var xs = [q[0], q[3], q[6], q[9]], zs = [q[2], q[5], q[8], q[11]];
  for(var i = Math.floor(Math.min.apply(null, xs)/BK); i <= Math.floor(Math.max.apply(null, xs)/BK); i++)
    for(var j = Math.floor(Math.min.apply(null, zs)/BK); j <= Math.floor(Math.max.apply(null, zs)/BK); j++) (grid[key(i, j)] = grid[key(i, j)] || []).push(n);
});
function dSeg(px, pz, ax, az, bx, bz){ var dx = bx - ax, dz = bz - az, l2 = dx*dx + dz*dz, t = l2 ? Math.max(0, Math.min(1, ((px - ax)*dx + (pz - az)*dz)/l2)) : 0;
  return Math.hypot(px - ax - dx*t, pz - az - dz*t); }
function inQuad(q, x, z){
  var ins = false, p = [[q[0], q[2]], [q[3], q[5]], [q[6], q[8]], [q[9], q[11]]];
  for(var i = 0, j = 3; i < 4; j = i++){ var a = p[i], b = p[j]; if((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0])*(z - a[1])/(b[1] - a[1]) + a[0]) ins = !ins; }
  if(ins) return 0;
  var d = 1e9; for(var k = 0, m = 3; k < 4; m = k++) d = Math.min(d, dSeg(x, z, p[m][0], p[m][1], p[k][0], p[k][1]));
  return d;
}
function paintDist(x, z){
  var L2 = grid[key(Math.floor(x/BK), Math.floor(z/BK))] || [], d = 1e9;
  for(var i = 0; i < L2.length; i++){ d = Math.min(d, inQuad(Y[L2[i]], x, z)); if(d === 0) return 0; }
  return d;
}
var runs = 0, samples = 0, worst = {d: 0}, onRwy = 0, missing = [];
L.stands.forEach(function(s){
  [0, 1].forEach(function(ei){
    var kind = s.kind === "contact" ? "jet" : "amphib", C = A.K[kind];
    var e = AF.end(L, s.id, ei, 0, 0, {stopDist: A.stopDist(C)});
    if(!e){ missing.push(s.id + "/" + ei); return; }
    var far = kind === "jet" ? A.nominalAirport(-9000, 2000, [0, 0]) : A.dockEnd(null, 3200, -2600, [0, 0]);
    var fn = A.normEnd(far), p0 = fn.dep.push.length ? fn.dep.push[0] : fn.dep.taxi[0], fP = {world: "far", x: p0[0], z: p0[1]}, here = {world: "claude-hq@2", x: 0, z: 0};
    [A.route(kind, here, fP, {a: e, b: far}), A.route(kind, fP, here, {a: far, b: e})].forEach(function(R){
      runs++;
      for(var t = 0; t <= R.T; t += 0.5){
        var p = A.poseAt(R, t);
        if(p.air || Math.abs(p.y - L.y) > 0.05 || AF.floorAt(L, p.x, p.z) == null) continue;
        if(AF.onPavement(L, p.x, p.z) === "runway"){ onRwy++; continue; }      // the runway's own centreline is white
        if(p.phase === "parked") continue;
        var d = paintDist(p.x, p.z); samples++;
        if(d > worst.d) worst = {d: d, stand: s.id, end: ei, phase: p.phase, x: p.x, z: p.z};
      }
    });
  });
});
out.flown = {runs: runs, samples: samples, worst: worst, onRunway: onRwy, missing: missing};
// a control: 3 m off B's centreline (between its edge lines) is not paint
var Bm = [(L.lines.B[0][0] + L.lines.B[1][0])/2, (L.lines.B[0][1] + L.lines.B[1][1])/2 + 300];
out.control = paintDist(Bm[0] + 3, Bm[1]);
var ut = AF.uturns(L); out.uturns = Object.keys(ut).sort();
out.uturnPainted = Object.keys(ut).map(function(k){ var q = ut[k][Math.floor(ut[k].length/2)]; return paintDist(q[0], q[1]); });

/* ---------- the walk: door -> nave -> ramp -> skybridge -> gallery -> stand 3's gate ---------- */
var BP = B.plan(L), F = L.frame, gate = B.gateSpot(BP, "3");
function w(u, v){ return [F.o[0] + u*F.B[0] + v*F.T[0], F.o[1] + u*F.B[1] + v*F.T[1]]; }
function floor(x, z, yRef){ var b = B.floorAt(BP, x, z, yRef); if(b != null) return b; var a = AF.floorAt(L, x, z); return a != null ? a : WD.groundAt(W, x, z); }
var path = [];
for(var u = -66; u <= 163; u += 0.5) path.push(w(u, 0));
var gF = [gate.x, gate.z], gU = (gF[0] - F.o[0])*F.B[0] + (gF[1] - F.o[1])*F.B[1], gV = (gF[0] - F.o[0])*F.T[0] + (gF[1] - F.o[1])*F.T[1];
for(var v = 0; Math.abs(v) <= Math.abs(gV); v += gV < 0 ? -0.5 : 0.5) path.push(w(163, v));
for(var u2 = 163; Math.abs(u2 - gU) > 0.25; u2 += gU > 163 ? 0.5 : -0.5) path.push(w(u2, gV));
path.push(gF);
var y = floor(path[0][0], path[0][1], null), maxStep = 0, ys = [y], blocked = 0;
for(var i = 1; i < path.length; i++){
  var y2 = floor(path[i][0], path[i][1], y); maxStep = Math.max(maxStep, Math.abs(y2 - y)); y = y2; ys.push(y);
  if(B.blockedAt(BP, path[i][0], path[i][1], y)) blocked++;
}
out.walk = {n: path.length, maxStep: maxStep, endY: y, gateY: gate.y, blocked: blocked, top: Math.max.apply(null, ys)};
// under the skybridge, at road level, the floor is the road
var rb = w(140, 0); out.underBridge = floor(rb[0], rb[1], -1.3);
process.stdout.write(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class TestAirportIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        p = subprocess.run([NODE, "-e", HARNESS % {"root": json.dumps(ROOT)}], capture_output=True, text=True, timeout=600)
        if p.returncode != 0:
            raise AssertionError("node harness failed:\n" + p.stderr[-4000:])
        cls.o = json.loads(p.stdout)

    def test_layout_is_the_fixture(self):
        self.assertTrue(self.o["sameAsFixture"])

    def test_drawn_is_flown(self):
        f = self.o["flown"]
        self.assertEqual(f["missing"], [])
        self.assertEqual(f["runs"], 9 * 2 * 2)
        self.assertGreater(f["samples"], 5000)
        self.assertGreater(f["onRunway"], 100)
        self.assertLessEqual(f["worst"]["d"], 0.5, f["worst"])
        self.assertGreater(self.o["control"], 1.0)      # the paint test does tell paint from bare pavement

    def test_uturns_are_painted(self):
        self.assertEqual(self.o["uturns"], ["A1/AB", "A6/AB"])
        for d in self.o["uturnPainted"]:
            self.assertEqual(d, 0)

    def test_walk_door_to_gate(self):
        wk = self.o["walk"]
        self.assertLessEqual(wk["maxStep"], 0.5, wk)
        self.assertAlmostEqual(wk["endY"], wk["gateY"], places=3)
        self.assertEqual(wk["blocked"], 0, wk)
        self.assertLess(self.o["underBridge"], 1.0)


if __name__ == "__main__":
    unittest.main()
