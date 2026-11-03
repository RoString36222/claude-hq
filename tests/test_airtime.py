"""Airtime for cars and motorbikes (games/hqvehiclephys.js airStep, airKeep, suspStep; driven by games/hq3d.js rideAir).

Under node, the physics step on its own and over the fixtures' real roads (games/world.js groundAt, read at the
vehicle's height as hq3d's groundAt reads it):
  - synthetic: over a crest of radius R it leaves the ground above sqrt(G R) and not below it; off a ramp's lip the
    flight lands where the parabola says (at 60 and 30 fps); a kerb or a seam is climbed and launches nothing; over a
    bumpy road it never ends under its ground; a touchdown costs a little speed, the suspension dips, bounces, settles;
  - real crests (tests/fixtures/commons_v5.json.gz, every road both ways at 15 and 45 m/s): never under the ground,
    never a level off its own road on the ground, and faster means more air;
  - multi-level (tests/fixtures/claude-hq@3.json.gz): launched hard under a flyover it stops under the deck and lands
    back on the road below; falling over the flyover it lands on the deck; launched in the tunnel it stays under the
    tunnel's roof and lands on the tunnel's road, not the land over it.
Skipped without node or the fixtures. Stdlib only."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
FIX_V5 = os.path.join(ROOT, "tests", "fixtures", "commons_v5.json.gz")
FIX_V4 = os.path.join(ROOT, "tests", "fixtures", "claude-hq@3.json.gz")

HARNESS = r"""
const fs = require('fs'), zlib = require('zlib'), root = process.argv[2];
globalThis.window = {HQV: {}}; globalThis.self = globalThis.window;
for (const f of ['world', 'citylife', 'worldgeom', 'hqvehiclephys']) new Function(fs.readFileSync(root + '/games/' + f + '.js', 'utf8'))();
const H = window.HQV, WD = H.world, P = H.hqVehiclePhys, G = P.AIR.G, out = {};
function mulberry32(a){ return function(){ a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0)/4294967296; }; }
// drive a profile y = prof(x) at v m/s: {air (s), first (x it left the ground), land (x it came down), under, upEver, top}
function run(prof, v, dt, x1){
  var J = {}, y = prof(0), r = {air: 0, first: null, land: null, under: 0, upEver: false, top: 0, impact: 0};
  for (var x = 0; x < x1; ){
    x += v*dt;
    var g = prof(x), sl = (prof(x + 0.75) - prof(x - 0.75))/1.5;
    var o = P.airStep(J, {y: y, ground: g, d: v*dt, slope: sl, dt: dt});
    y = o.y;
    if (y < g - 1e-9) r.under++;
    if (o.air){ r.air += dt; if (r.first == null) r.first = x; r.top = Math.max(r.top, y - g); }
    if (J.up) r.upEver = true;
    if (o.impact && r.land == null){ r.land = x; r.impact = o.impact; }
  }
  return r;
}
// a crest of radius R between two tangent slopes (s = +-L/R)
function crest(R, L){ return function(x){ var u = x - 60; if (u < -L) return (u + L)*L/R - L*L/(2*R); if (u > L) return -(u - L)*L/R - L*L/(2*R); return -u*u/(2*R); }; }
out.crest = [50, 100, 200].map(function(R){ var vc = Math.sqrt(G*R); return {R: R, below: run(crest(R, 15), 0.9*vc, 1/60, 140).air, above: run(crest(R, 15), 1.1*vc, 1/60, 140).air}; });
// a 10 m ramp at 0.3 up to a lip 3 m over the flat
function ramp(x){ return x < 20 ? 0 : x < 30 ? (x - 20)*0.3 : 0; }
out.ramp = [];
[10, 20].forEach(function(v){ [1/60, 1/30].forEach(function(dt){
  var vy = v*0.3, T = (vy + Math.sqrt(vy*vy + 2*G*3))/G, r = run(ramp, v, dt, 120);
  out.ramp.push({v: v, dt: dt, land: r.land, want: 30 + v*T, first: r.first, under: r.under, impact: r.impact});
}); });
// a 0.15 m kerb up, then a seam of 0.1 m up and down, at 15 m/s
out.kerb = run(function(x){ return x < 20 ? 0 : x < 40 ? 0.15 : x < 40.3 ? 0.25 : 0.15; }, 15, 1/60, 60);
// bumps: never under the ground, at any speed
var rnd = mulberry32(7), B = []; for (var i = 0; i < 400; i++) B.push((rnd() - 0.5)*0.6);
function bumpy(x){ var i = Math.max(0, Math.floor(x/2)), f = x/2 - i; return B[i % 400]*(1 - f) + B[(i + 1) % 400]*f + Math.sin(x/30)*4; }
out.bumpy = [8, 25, 50, 80].map(function(v){ return run(bumpy, v, 1/60, 700).under; });
out.keep = [P.airKeep(0.5), P.airKeep(1.9), P.airKeep(6), P.airKeep(100)];
var S = {y: 0, v: 0}, mn = 0, mx = 0; P.suspStep(S, 1/60, 6);
for (var k = 0; k < 90; k++){ P.suspStep(S, 1/60); mn = Math.min(mn, S.y); if (mn < -0.01) mx = Math.max(mx, S.y); }
out.susp = {min: mn, bounce: mx, end: S.y};

function load(f){ return WD.pack(JSON.parse(zlib.gunzipSync(fs.readFileSync(root + '/tests/fixtures/' + f)).toString('utf8'))); }
var ROOF = 1.5;
// as hq3d: the ground at the vehicle's height (a tunnel's road when it is in one), and its ceiling (rideCeil)
function ground(W, x, z, y){ return WD.groundAt(W, x, z, false, y); }
function ceil(W, x, z, g){ return function(yy){
  var tu = WD.tunnelAt(W, x, z, g), cap = tu && tu.ceil != null ? tu.ceil - ROOF : null;
  var up = WD.groundAt(W, x, z, false, yy + ROOF); if (up > g + 2){ var u = up - 1 - ROOF; cap = cap == null ? u : Math.min(cap, u); }
  return cap; }; }
// every road both ways at v m/s
function roads(W, v){
  var T = {under: 0, off: 0, air: 0, ups: 0, runs: 0}, dt = 1/60;
  W.edges.forEach(function(e){
    var p = e.pts; if (!p || p.length < 6) return;
    [false, true].forEach(function(rev){
      var Q = []; for (var k = 0; k < p.length; k += 3) Q.push([p[k]/100, p[k+1]/100, p[k+2]/100]); if (rev) Q.reverse();
      var L = [], tot = 0; for (k = 1; k < Q.length; k++){ L.push(Math.hypot(Q[k][0] - Q[k-1][0], Q[k][2] - Q[k-1][2])); tot += L[k-1]; }
      if (tot < 5) return; T.runs++;
      function at(s){ var j = 0; while (j < L.length - 1 && s > L[j]){ s -= L[j]; j++; } var f = Math.min(1, s/(L[j] || 1)), a = Q[j], b = Q[j+1];
        return [a[0] + (b[0] - a[0])*f, a[1] + (b[1] - a[1])*f, a[2] + (b[2] - a[2])*f]; }
      var J = {}, q = at(0), y = ground(W, q[0], q[2], q[1]), was = false;
      for (var s = v*dt; s < tot; s += v*dt){
        q = at(s); var g = ground(W, q[0], q[2], y), a = at(s + 1.5), b = at(Math.max(0, s - 1.5));
        var sl = (ground(W, a[0], a[2], y) - ground(W, b[0], b[2], y))/3;
        var o = P.airStep(J, {y: y, ground: g, d: v*dt, dt: dt, slope: sl, ceil: ceil(W, q[0], q[2], g)});
        y = o.y;
        if (y < g - 1e-6) T.under++;
        if (!o.air && Math.abs(y - q[1]) > 1.8) T.off++;
        if (o.air) T.air += dt;
        if (J.up && !was) T.ups++;
        was = !!J.up;
      }
    });
  });
  return T;
}
var W5 = load('commons_v5.json.gz');
out.roads = {slow: roads(W5, 15), fast: roads(W5, 45)};
// straight up from (x, z) at y with vy, standing still: {maxY, end, roofHit}
function launch(W, x, z, y, vy){
  var J = {air: true, vy: vy, t: 0, top: 0}, r = {maxY: y, end: null}, dt = 1/60;
  for (var i = 0; i < 600; i++){
    var g = ground(W, x, z, y), o = P.airStep(J, {y: y, ground: g, d: 0, dt: dt, slope: 0, ceil: ceil(W, x, z, g)});
    y = o.y; r.maxY = Math.max(r.maxY, y);
    if (!o.air){ r.end = y; break; }
  }
  return r;
}
var W4 = load('claude-hq@3.json.gz');
// a flyover's deck over a road: the first road point where the levels are more than 4 m apart
var fly = null;
W4.edges.forEach(function(e){ var p = e.pts; for (var k = 0; !fly && k < p.length; k += 3){ var x = p[k]/100, z = p[k+2]/100;
  var lo = WD.groundAt(W4, x, z, false, -1e4), hi = WD.groundAt(W4, x, z, false, 1e4); if (hi - lo > 4) fly = {x: x, z: z, lo: lo, hi: hi}; } });
out.fly = fly && {lo: fly.lo, hi: fly.hi, under: launch(W4, fly.x, fly.z, fly.lo, 14), over: launch(W4, fly.x, fly.z, fly.hi + 3, 0)};
var tun = null;
W4.edges.forEach(function(e){ if (e.under !== 'tunnel') return; var p = e.pts; for (var k = 0; !tun && k < p.length; k += 3){ var x = p[k]/100, z = p[k+2]/100, y = p[k+1]/100;
  var t = WD.tunnelAt(W4, x, z, y); if (t && t.kind === 'tunnel' && t.ceil != null && WD.groundAt(W4, x, z, false, t.ceil + 3) > t.ceil) tun = {x: x, z: z, y: t.y, ceil: t.ceil, land: WD.groundAt(W4, x, z, false, t.ceil + 3)}; } });
out.tun = tun && {y: tun.y, ceil: tun.ceil, land: tun.land, up: launch(W4, tun.x, tun.z, tun.y, 14)};
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE and os.path.exists(FIX_V5) and os.path.exists(FIX_V4), "node or the fixtures missing")
class Airtime(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-", ROOT], input=HARNESS, capture_output=True, text=True, timeout=600)
        if r.returncode:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout)

    def test_crest_leaves_the_ground_above_sqrt_g_r(self):
        for c in self.o["crest"]:
            self.assertEqual(c["below"], 0, c)
            self.assertGreater(c["above"], 0.3, c)

    def test_ramp_flight_lands_where_the_parabola_does(self):
        for r in self.o["ramp"]:
            self.assertEqual(r["under"], 0, r)
            self.assertAlmostEqual(r["first"], 30, delta=r["v"]*r["dt"] + 0.01)
            self.assertAlmostEqual(r["land"], r["want"], delta=1.0, msg=r)
            self.assertGreater(r["impact"], 5, r)

    def test_a_kerb_launches_nothing(self):
        k = self.o["kerb"]
        self.assertFalse(k["upEver"], k)
        self.assertLess(k["top"], 0.12, k)
        self.assertEqual(k["under"], 0)

    def test_never_under_the_ground(self):
        self.assertEqual(self.o["bumpy"], [0, 0, 0, 0])

    def test_touchdown_costs_a_little_speed_and_bounces(self):
        keep = self.o["keep"]
        self.assertEqual(keep[0], 1)
        self.assertEqual(keep[1], 1)
        self.assertTrue(0.8 < keep[2] < 1, keep)
        self.assertAlmostEqual(keep[3], 0.8)
        s = self.o["susp"]
        self.assertLess(s["min"], -0.08, s)
        self.assertGreater(s["min"], -0.3, s)
        self.assertGreater(s["bounce"], 0.005, s)
        self.assertLess(abs(s["end"]), 0.005, s)

    def test_real_roads(self):
        slow, fast = self.o["roads"]["slow"], self.o["roads"]["fast"]
        for t in (slow, fast):
            self.assertEqual(t["under"], 0, t)
            self.assertEqual(t["off"], 0, t)
        self.assertGreater(fast["air"], slow["air"]*1.5, (slow, fast))
        self.assertGreater(fast["ups"], slow["ups"], (slow, fast))
        # at a city speed most runs never really leave the road
        self.assertLess(slow["ups"], slow["runs"]*0.2, slow)

    def test_flyover_picks_the_right_level(self):
        f = self.o["fly"]
        self.assertIsNotNone(f, "no flyover in the fixture")
        self.assertLessEqual(f["under"]["maxY"] + 1.5, f["hi"] - 1 + 1e-6, f)
        self.assertAlmostEqual(f["under"]["end"], f["lo"], delta=0.05, msg=f)
        self.assertAlmostEqual(f["over"]["end"], f["hi"], delta=0.05, msg=f)

    def test_tunnel_roof(self):
        t = self.o["tun"]
        self.assertIsNotNone(t, "no tunnel in the fixture")
        self.assertLessEqual(t["up"]["maxY"] + 1.5, t["ceil"] + 1e-6, t)
        self.assertAlmostEqual(t["up"]["end"], t["y"], delta=0.3, msg=t)


if __name__ == "__main__":
    unittest.main()
