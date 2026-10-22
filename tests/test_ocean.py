"""The sea round the islands (games/ocean.js): waves, the archipelago, impostors, wakes, open-sea travel.

Node loads games/ocean.js and games/hqboat.js against a stub `window` (the vendored three.js for
mount()) and runs the scenarios below in one process; the Python side checks the numbers: the
waves and their GLSL twin, setArchipelago's frame and nearestIsland's arrival flag, the impostor
placement and its 1,000-island time bound, the draw calls staying flat as the archipelago grows,
the wake strip, and a jet ski driven dock to dock across open sea to another island, which is
streamed in on arrival. Skipped when node is not installed. Stdlib only."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

HARNESS = r"""
import fs from "fs";
const root = %(root)s;
const THREE = await import(root + "/games/vendor/three-module.js");
globalThis.window = {HQV: {}};
for (const f of ["ocean", "hqboat"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const O = window.HQV.ocean, B = window.HQV.hqboat, out = {};
function uuid(i){ var h = (i*2654435761 >>> 0).toString(16).padStart(8, "0"); return h + "-0000-4000-8000-" + String(i).padStart(12, "0"); }
function wrapPi(a){ return Math.atan2(Math.sin(a), Math.cos(a)); }

// the waves: bounded by the amplitudes, moving, and the GLSL carries the same coefficients
var amp = O.WAVES.reduce(function(s, w){ return s + w[2]; }, 0), mx = 0, moved = 0;
for(var i = 0; i < 2000; i++){ var x = (i*37.3) %% 500, z = (i*91.7) %% 500, h = O.waveAt(x, z, i*0.1); mx = Math.max(mx, Math.abs(h)); moved += Math.abs(h - O.waveAt(x, z, i*0.1 + 0.5)); }
out.waves = {amp: amp, max: mx, moved: moved, glsl: O.waveGlsl(), det: O.waveAt(12.5, -40, 3.25) === O.waveAt(12.5, -40, 3.25)};

// the archipelago: the Commons at the origin, islands on a spiral ~3 km apart
function arch(n){
  var isl = [];
  for(var i = 1; i <= n; i++){ var a = i*2.39996, r = 3000*Math.sqrt(i); isl.push({owner: uuid(i), name: "Isle " + i, world: "user:" + uuid(i) + "@2", x: Math.cos(a)*r, z: Math.sin(a)*r, tier: 1 + i %% 5}); }
  return {commons: {world: "claude-hq@2", x: 0, z: 0}, islands: isl};
}
var A = arch(12);
A.islands.push({owner: "x", world: "../etc", x: 1, z: 1, tier: 1}, {owner: "y", world: "user:" + uuid(99) + "@2", x: "nope", z: 0});
var s0 = O.setArchipelago(A, "claude-hq@2");
out.arch = {shift0: s0, cur: O.current(), near0: O.nearestIsland(0, 0)};
var i3 = A.islands[2];
var s1 = O.setArchipelago(A, i3.world);
out.arch.shift1 = s1; out.arch.i3 = [i3.x, i3.z]; out.arch.cur1 = O.current();
out.arch.nearHome = O.nearestIsland(0, 0);                  // on island 3: the nearest other one
out.arch.brute = A.islands.concat([A.commons]).filter(function(o){ return o !== i3 && isFinite(+o.x) && /^(claude|user:[0-9a-f-]{36}@)/.test(o.world); })
  .map(function(o){ return [Math.hypot(o.x - i3.x, o.z - i3.z), o.world]; }).sort(function(a, b){ return a[0] - b[0]; })[0];
// arrival by the coast ring, then by a known dock
O.setArchipelago(arch(1), "claude-hq@2");
var one = arch(1).islands[0], dir = [one.x/Math.hypot(one.x, one.z), one.z/Math.hypot(one.x, one.z)];
out.arrive = [3000, 1500, 1200, 1100].map(function(d){ var p = [one.x - dir[0]*d, one.z - dir[1]*d], q = O.nearestIsland(p[0], p[1]); return [d, q.arrive, Math.round(q.shore), q.world]; });
var withDock = arch(1); withDock.islands[0].docks = [[-dir[0]*854, -dir[1]*854]];
O.setArchipelago(withDock, "claude-hq@2");
out.arriveDock = [1500, 1300, 1200].map(function(d){ var q = O.nearestIsland(one.x - dir[0]*d, one.z - dir[1]*d); return [d, q.arrive, q.dock ? Math.round(Math.hypot(q.dock.x - one.x + dir[0]*854, q.dock.z - one.z + dir[1]*854)) : null]; });

// impostors: 1,000 islands, placed at their bearing, pulled in to the horizon; the per-frame time
var big = arch(999);
O.setArchipelago(big, big.islands[500].world);
var H = O.horizon(120, -80), far = 0, bearing = 0;
for(i = 0; i < H.n; i++){
  var j = i*5, dx = H.out[j] - 120, dz = H.out[j + 1] + 80, d = Math.hypot(dx, dz);
  if(d > O.HORIZON + 1e-3) far++;
}
// the first non-current island: its bearing is kept
var cur = O.current(), first = big.commons, fx = first.x - cur.x - 120, fz = first.z - cur.z + 80;
bearing = Math.abs(wrapPi(Math.atan2(H.out[0] - 120, H.out[1] + 80) - Math.atan2(fx, fz)));
var buf = H.out, t0 = process.hrtime.bigint(), N = 400;
for(i = 0; i < N; i++) O.horizon(120 + i, -80, buf);
out.horizon = {n: H.n, total: big.islands.length + 1, far: far, bearing: bearing, scale0: H.out[2], ms: Number(process.hrtime.bigint() - t0)/1e6/N};

// mount with real THREE: instance counts, flat draw calls, the per-frame step time
var c = {THREE: THREE, E: {calm: function(){ return false; }}};
var scene = new THREE.Group(), oc = O.mount(c, scene);
function counts(){ var s = oc.sky().reduce(function(a, m){ return a + m.count; }, 0); return [oc.sil().count, s]; }
O.setArchipelago(arch(10), "claude-hq@2"); var n10 = oc.step(1, 1/60, {x: 0, y: 2, z: 0}), c10 = counts(), d10 = oc.drawCalls();
O.setArchipelago(big, "claude-hq@2"); var n1k = oc.step(1, 1/60, {x: 0, y: 2, z: 0}), c1k = counts(), d1k = oc.drawCalls();
t0 = process.hrtime.bigint();
for(i = 0; i < N; i++) oc.step(1 + i/60, 1/60, {x: i*3, y: 2, z: 0});
var stepMs = Number(process.hrtime.bigint() - t0)/1e6/N;
var meshes = 0; scene.traverse(function(o){ if(o.isMesh) meshes++; });
oc.setTime(true); for(i = 0; i < 300; i++) oc.step(10 + i/60, 1/60, {x: 0, y: 2, z: 0});
var nightU = oc.sea.material.uniforms.uNight.value;
out.mount = {n10: n10, c10: c10, d10: d10, n1k: n1k, c1k: c1k, d1k: d1k, stepMs: stepMs, meshes: meshes, night: nightU,
             seaY: oc.sea.position.y, instanced: oc.sil().isInstancedMesh && oc.sky().every(function(m){ return m.isInstancedMesh; })};

// wakes: a trail behind a moving boat, widening and fading, gone once it stops long enough
var tr = {pts: []};
for(i = 0; i < 300; i++) O.wakePush(tr, 0, i*0.1*8, 0, 8, i*0.1, 1.2);
var S = O.wakeStrip(tr, 30), K = S.k*2, w0 = Math.abs(S.pos[2] - S.pos[8]), wl = Math.abs(S.pos[(S.n - 1)*K + 2] - S.pos[(S.n - 1)*K + 8]);
out.wake = {n: S.n, k: S.k, len: S.pos.length, w0: w0, wl: wl, a0: S.alpha[1], al: S.alpha[S.alpha.length - 2], edge: S.alpha[0], mid: S.alpha[2], max: O.WAKE.max};
for(i = 0; i < 80; i++) O.wakePush(tr, 0, 2400, 0, 0, 30 + i*0.1);
out.wake.after = tr.pts.length;
oc.wake([{id: "me", x: 0, z: 0, yaw: 0, speed: 8, beam: 1.2}]); oc.step(40, 0.1, {x: 0, y: 2, z: 0});
oc.wake([{id: "me", x: 0, z: 3, yaw: 0, speed: 8, beam: 1.2}]); oc.step(40.4, 0.4, {x: 0, y: 2, z: 0});
out.wake.calls = oc.drawCalls();
oc.dispose(); out.wake.disposed = scene.children.length;

// open sea: a jet ski from the Commons' dock to an island's dock, streaming the island in on arrival
function islandDoc(R, a){
  var coast = [], n = 96;
  for(var i = 0; i < n; i++){ var b = i/n*Math.PI*2; coast.push([Math.round(Math.sin(b)*R*100), Math.round(Math.cos(b)*R*100)]); }
  var cc = R - 10;
  return {layers: {island: {coast: coast, sea_cm: 0, docks: ["dock"]},
    sites: [{id: "dock", kind: "dock", x: Math.round(Math.sin(a)*cc*100), z: Math.round(Math.cos(a)*cc*100), w: 600, d: 2000,
             front: [Math.round(Math.sin(a)*65536), Math.round(Math.cos(a)*65536)]}]}};
}
var TX = 2100, TZ = 2300, toT = Math.atan2(TX, TZ);
var trip = {commons: {world: "claude-hq@2", x: 0, z: 0}, islands: [{owner: uuid(7), name: "Target", world: "user:" + uuid(7) + "@2", x: TX, z: TZ, tier: 3},
            {owner: uuid(8), name: "Other", world: "user:" + uuid(8) + "@2", x: -2900, z: 900, tier: 2}]};
O.setArchipelago(trip, "claude-hq@2");
var home = islandDoc(1000, toT), there = islandDoc(850, wrapPi(toT + Math.PI)), sea = O.seaOf(home), d0 = sea.docks[0];
var st = B.newState("jetski", d0.x, d0.z, d0.yaw), events = [], streamed = null, t = 0, dt = 1/60, goal = null, maxShore = 0;
// sits at the berth first (docks), then drives
B.step(st, {}, dt, sea).forEach(function(e){ events.push([t, e.type, e.id || null]); });
for(var k = 0; k < 60*400; k++){
  t += dt;
  var tgt = goal || {x: TX, z: TZ};
  if(!streamed){ var q = O.nearestIsland(st.x, st.z); if(q && q.arrive && q.world === trip.islands[0].world){
      // the integrator streams the island in: rebase into its frame, swap the sea
      var sh = O.setArchipelago(trip, q.world); st.x -= sh.dx; st.z -= sh.dz;
      sea = O.seaOf(there); goal = sea.docks[0]; streamed = {t: t, shore: q.shore, at: [st.x, st.z], world: O.current().world}; tgt = goal; } }
  var dx = tgt.x - st.x, dz = tgt.z - st.z, dist = Math.hypot(dx, dz), err = wrapPi(Math.atan2(dx, dz) - st.yaw);
  var thr = dist > 90 ? 1 : dist > 25 ? 0.3 : dist > 6 ? 0.12 : 0;     // ease off, then in at a walk
  var e = B.step(st, {thr: thr, steer: Math.max(-1, Math.min(1, err*2))}, dt, sea);
  e.forEach(function(ev){ events.push([Math.round(t*100)/100, ev.type, ev.id || null]); });
  if(!streamed) maxShore = Math.max(maxShore, Math.hypot(st.x, st.z));
  if(streamed && st.dock === "dock") break;
}
out.trip = {events: events, streamed: streamed, dock: st.dock, at: [st.x, st.z], goal: goal, t: t, maxFromHome: maxShore,
            beached: events.some(function(e){ return e[1] === "beach"; })};

// the river (tests/fixtures/river_island.json): its water is not land, a bridge deck is (but not to a hull), only once open
var rdoc = JSON.parse(fs.readFileSync(root + "/tests/fixtures/river_island.json", "utf8")), rs = O.seaOf(rdoc), RV = O.riverOf(rdoc);
var mid = rdoc.layers.river.center[40], be = rdoc.layers.roads.edges.filter(function(e){ return e.bridge; })[0], bp = be.points[be.points.length >> 1];
out.river = {water: rs.land(mid[0]/100, mid[1]/100), boatWater: rs.boat.land(mid[0]/100, mid[1]/100), inWater: RV.inWater(mid[0]/100, mid[1]/100),
             deck: rs.land(bp[0]/100, bp[2]/100), boatDeck: rs.boat.land(bp[0]/100, bp[2]/100),
             closed: O.seaOf(rdoc, null, (be.min_tier || 0) - 1).land(bp[0]/100, bp[2]/100),
             berths: rs.docks.map(function(d){ return RV.inWater(d.x, d.z) && !rs.land(d.x, d.z); }), none: O.riverOf({layers: {}})};
// flying on (3.11.1): a plane circling off the Commons, a straight flight out, a hover, a turn home and back out
O.setArchipelago(arch(6), "claude-hq@2");
function fly(path, secs, r){
  var S = O.flyOnState(), ev = [], firstSwap = null, dt = 1/30;
  for(var t = 0; t < secs; t += dt){
    var st = path(t), now = Math.round(t*1000), F = O.flyOn(S, st, {r: r, now: now});
    if(F.arm) ev.push(["arm", now, F.arm.world, F.say, Math.round(Math.hypot(st.x, st.z))]);
    if(F.cancel) ev.push(["cancel", now]);
    if(F.swap && firstSwap == null && S.go) firstSwap = {t: now, dn: Math.round(Math.hypot(st.x - S.go.x, st.z - S.go.z)), dh: Math.round(Math.hypot(st.x, st.z))};
  }
  return {ev: ev, swap: firstSwap};
}
function circle(R, v){ return function(t){ var a = v*t/R; return {x: R*Math.sin(a), z: R*Math.cos(a), vx: v*Math.cos(a), vz: -v*Math.sin(a)}; }; }
var i1 = arch(6).islands[0], u = [i1.x/Math.hypot(i1.x, i1.z), i1.z/Math.hypot(i1.x, i1.z)];
function line(d0, v, dir){ return function(t){ var d = d0 + v*t*dir; return {x: u[0]*d, z: u[1]*d, vx: u[0]*v*dir, vz: u[1]*v*dir}; }; }
function outBack(t){                                          // out toward island 1, home at 6 s, back out at 16 s
  var v = 60, d = t < 6 ? 1000 + v*t : t < 16 ? 1360 - v*(t - 6) : 760 + v*(t - 16), s = t < 6 || t >= 16 ? 1 : -1;
  return {x: u[0]*d, z: u[1]*d, vx: u[0]*v*s, vz: u[1]*v*s};
}
out.flyOn = {world1: i1.world, circuit: fly(circle(1500, 60), 300, 1150), circuitPlane: fly(circle(1500, 60), 300, 1800),
             straight: fly(line(1000, 60, 1), 40, 1150), hover: fly(function(){ return {x: -u[0]*1600, z: -u[1]*1600, vx: 0, vz: 0, yaw: 0, speed: 0}; }, 20, 1150),
             outBack: fly(outBack, 80, 1150)};
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class OceanTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        src = HARNESS % {"root": json.dumps(ROOT)}
        r = subprocess.run([NODE, "--input-type=module", "-e", src], capture_output=True, text=True, timeout=180)
        if r.returncode != 0:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_waves(self):
        w = self.o["waves"]
        self.assertLessEqual(w["max"], w["amp"] + 1e-9)
        self.assertLess(w["amp"], 0.4)                       # gentle
        self.assertGreater(w["moved"], 10)
        self.assertTrue(w["det"])
        self.assertIn("float waveH(vec2 p, float t)", w["glsl"])
        self.assertIn("vec2 waveG(vec2 p, float t)", w["glsl"])
        self.assertEqual(w["glsl"].count("sin("), 3)

    def test_archipelago_frame_and_nearest(self):
        a = self.o["arch"]
        self.assertEqual(a["cur"]["world"], "claude-hq@2")
        self.assertEqual(a["cur"]["count"], 13)              # the bad id and the bad x are dropped
        self.assertNotEqual(a["near0"]["world"], "claude-hq@2")
        self.assertAlmostEqual(a["shift1"]["dx"], a["i3"][0], places=6)
        self.assertAlmostEqual(a["shift1"]["dz"], a["i3"][1], places=6)
        self.assertAlmostEqual(a["cur1"]["x"], a["i3"][0], places=6)
        self.assertNotEqual(a["nearHome"]["world"], a["cur1"]["world"])
        self.assertEqual(a["nearHome"]["world"], a["brute"][1])
        self.assertAlmostEqual(a["nearHome"]["dist"], a["brute"][0], places=6)

    def test_arrival(self):
        got = {d: arr for d, arr, shore, world in self.o["arrive"]}
        self.assertFalse(got[3000])
        self.assertFalse(got[1500])
        self.assertTrue(got[1100])                           # within 300 m of an 850 m coast
        dock = {d: (arr, off) for d, arr, off in self.o["arriveDock"]}
        self.assertFalse(dock[1500][0])
        self.assertTrue(dock[1200][0])                       # within 400 m of its known dock (at 854 m)
        self.assertEqual(dock[1200][1], 0)

    def test_impostors_1000_islands_under_1ms(self):
        h = self.o["horizon"]
        self.assertEqual(h["n"], h["total"] - 1)             # every island but the one you are on
        self.assertEqual(h["far"], 0)                        # none beyond the horizon ring
        self.assertLess(h["bearing"], 1e-6)
        self.assertLess(h["scale0"], 1)
        self.assertLess(h["ms"], 1.0)
        m = self.o["mount"]
        self.assertTrue(m["instanced"])
        self.assertEqual(m["n10"], 10)
        self.assertEqual(m["c10"], [10, 10])
        self.assertEqual(m["n1k"], 999)
        self.assertEqual(m["c1k"], [999, 999])
        self.assertEqual(m["d10"], m["d1k"])                 # draw calls do not grow with the archipelago
        self.assertLessEqual(m["d1k"], 8)
        self.assertLessEqual(m["meshes"], 8)
        self.assertLess(m["stepMs"], 1.0)
        self.assertAlmostEqual(m["night"], 1, delta=0.02)

    def test_wake(self):
        w = self.o["wake"]
        self.assertEqual(w["n"], 30)                         # a point every 1.6 m at 8 m/s (0.2 s), kept 6 s
        self.assertEqual(w["len"], w["n"] * w["k"] * 2)
        self.assertGreater(w["wl"], w["w0"])                 # the arms spread further back
        self.assertEqual(w["edge"], 0)                       # soft outer edge, foam on the crest, churn between
        self.assertLess(w["mid"], w["a0"])
        self.assertGreater(w["a0"], w["al"])                 # fading
        self.assertEqual(w["after"], 0)
        self.assertEqual(w["calls"], 9)
        self.assertEqual(w["disposed"], 0)

    def test_river(self):
        r = self.o["river"]
        self.assertTrue(r["inWater"])
        self.assertFalse(r["water"])            # walking and driving stop at the bank
        self.assertFalse(r["boatWater"])
        self.assertTrue(r["deck"])              # a bridge deck is land
        self.assertFalse(r["boatDeck"])         # a hull passes under it
        self.assertFalse(r["closed"])           # not before the tier it opens in
        self.assertEqual(r["berths"], [True, True])
        self.assertIsNone(r["none"])

    def test_dock_to_dock_open_sea(self):
        tr = self.o["trip"]
        ev = [e[1] for e in tr["events"]]
        self.assertEqual(ev[0], "dock")                      # moored at the Commons
        self.assertEqual(ev[1], "undock")
        self.assertFalse(tr["beached"])
        self.assertGreater(tr["maxFromHome"], 1200)          # out past the Commons' coast, into open water
        self.assertIsNotNone(tr["streamed"])
        self.assertTrue(tr["streamed"]["world"].startswith("user:"))
        self.assertLess(tr["streamed"]["shore"], 300)
        self.assertEqual(ev[-1], "dock")
        self.assertEqual(tr["dock"], "dock")
        self.assertLess(((tr["at"][0] - tr["goal"]["x"]) ** 2 + (tr["at"][1] - tr["goal"]["z"]) ** 2) ** 0.5, 8)
        self.assertLess(tr["t"], 400)

    def test_fly_on_hysteresis(self):
        """3.11.1: taking off from the Commons' offshore airfield said "Flying on to …" (and built that City) over and
        over as a circuit armed, dropped and re-armed island after island. Now: heading for it, once, steady."""
        f = self.o["flyOn"]
        for k in ("circuit", "circuitPlane"):
            c = f[k]
            said = [e for e in c["ev"] if e[0] == "arm" and e[3]]
            self.assertLessEqual(len(said), 3, (k, c["ev"]))          # 5 laps of a 9.4 km circuit
            last = {}
            for e in said:                                          # never the same island twice inside a minute
                if e[2] in last:
                    self.assertGreaterEqual(e[1] - last[e[2]], 60000, (k, c["ev"]))
                last[e[2]] = e[1]
            self.assertIsNone(c["swap"], k)                         # never nearer another island than home
        st = f["straight"]
        arms = [e for e in st["ev"] if e[0] == "arm"]
        self.assertEqual(len(arms), 1, st["ev"])
        self.assertEqual(arms[0][2], f["world1"])
        self.assertTrue(arms[0][3])
        self.assertGreaterEqual(arms[0][1], (1150 - 1000) / 60 * 1000 + 2000 - 50)   # past the coast, then 2 s heading for it
        self.assertIsNotNone(st["swap"])
        self.assertLess(st["swap"]["dn"], st["swap"]["dh"] - 150 + 1)
        self.assertEqual(f["hover"]["ev"], [])                      # hovering beyond the coast: not heading anywhere
        ob = [e[0] for e in f["outBack"]["ev"]]
        self.assertEqual(ob[:2], ["arm", "cancel"], f["outBack"]["ev"])
        rearm = [e for e in f["outBack"]["ev"] if e[0] == "arm"][1:]
        self.assertTrue(rearm, f["outBack"]["ev"])
        cancel_t = [e for e in f["outBack"]["ev"] if e[0] == "cancel"][0][1]
        self.assertGreaterEqual(rearm[0][1] - cancel_t, 20000)       # that island rests 20 s
        self.assertFalse(rearm[0][3])                                # and is not announced again within the minute


if __name__ == "__main__":
    unittest.main()
