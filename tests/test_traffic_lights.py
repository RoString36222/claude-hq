"""Traffic lights and a fuller City (HQ 3.22 city play): games/citylife.js signals / signalAt / walkAt / parked, the
lights in games/traffic.js (platoons that stop at red, lightAt) and its street() view.

Under node, on the @3 fixtures (tests/fixtures/*@3.json.gz) and on a v4-shaped world (the @3 commons with its roads
renamed to City Gen v4's classes, as tests/test_citylife.py does): lights stand at real junctions and never on a
highway's mainline, an expressway or a ring road; every light cycles, the same for everyone, and its two axes are never
green together; nobody may walk across a road while it has green; the traffic stops at red (no car, van, bus... with
its nose over a red line) and its cars never run into each other; there are more cars than before; lightAt finds the
light ahead; parked cars stand on their own street's kerb, never in a lane the traffic drives, a junction, or at a stop;
the street view is a few instanced draw calls and its poles and parked cars are solid. Skipped without node.
Stdlib only."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
FIXTURE = os.path.join(ROOT, "tests", "fixtures", "claude-hq@3.json.gz")

HARNESS = r"""
import fs from "fs";
import zlib from "zlib";
const root = %(root)s, FIX = root + "/tests/fixtures/";
globalThis.window = {HQV: {}};
for (const f of ["world", "citylife", "traffic"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const THREE = await import(root + "/games/vendor/three-module.js");
const H = window.HQV, WD = H.world, L = H.cityLife, T = H.traffic, out = {};
function doc(p){ return JSON.parse(zlib.gunzipSync(fs.readFileSync(FIX + p)).toString("utf8")); }
// a v4-shaped world: v4's class names (and their tram versions) on @3's roads
const V4 = {local: ["lane", "local street", "collector", "shared street", "service road", "local street + tram"],
            arterial: ["avenue", "boulevard", "boulevard + tram", "avenue_tram"], highway: ["highway", "expressway"], ring: ["expressway"]};
// ([3.29] not the roads the generator already classes as expressways, ramps and flyovers: the interchanges keep theirs)
function v4(d){ d.layers.roads.edges.forEach(function(e, i){ const o = V4[e["class"]]; if(o && !e.v4) e["class"] = o[i %% o.length]; }); return d; }
const SRC = {commons: function(){ return doc("claude-hq@3.json.gz"); }, island: function(){ return doc("island@3.json.gz"); }, v4: function(){ return v4(doc("claude-hq@3.json.gz")); }};
const FAST = {expressway: 1, ring: 1, ramp: 1, flyover: 1, underpass: 1};
const DAY = Date.UTC(2026, 9, 27, 10), NIGHT = Date.UTC(2026, 9, 27, 3);
// each body as tests/test_traffic.py measures the traffic, a car's (a scooter or bike its own, smaller: a van or lorry
// on a bend swings its long body a little wider than the clash test's car)
function boxes(list){
  const b = [];
  list.forEach(function(v){
    const S0 = T.SPEC[v.type] || T.SPEC[v.kind], S = S0 && S0.len < T.SPEC.car.len ? S0 : T.SPEC.car;
    if(v.kind === "car") b.push({id: v.id, x: v.x, y: v.y, z: v.z, yaw: v.yaw, len: S.len, wid: S.wid});
  });
  return b;
}
function overlap(a, b){
  // ([3.29] a car on a flyover over one on the road it crosses: 7 m apart, not touching)
  if(Math.abs((a.y || 0) - (b.y || 0)) > 3) return false;
  const ax = [Math.sin(a.yaw), Math.cos(a.yaw)], ay = [ax[1], -ax[0]], bx = [Math.sin(b.yaw), Math.cos(b.yaw)], by = [bx[1], -bx[0]];
  const d = [b.x - a.x, b.z - a.z], axes = [ax, ay, bx, by];
  function r(u, x, y, Ln, Wd){ return Math.abs(x[0]*u[0] + x[1]*u[1])*Ln/2 + Math.abs(y[0]*u[0] + y[1]*u[1])*Wd/2; }
  for(let i = 0; i < 4; i++){ const u = axes[i]; if(Math.abs(d[0]*u[0] + d[1]*u[1]) > r(u, ax, ay, a.len, a.wid) + r(u, bx, by, b.len, b.wid)) return false; }
  return true;
}
// mean cars on screen around sample points (every 5th node on a main road) over ten moments
function onScreen(s, W, ms0, rad){
  const pts = [], main = {};
  W.edges.forEach(function(e){ if(L.road(e.cls).kind === "main"){ main[e.a] = 1; main[e.b] = 1; } });
  W.nodes.forEach(function(n, i){ if(main[n.id] && i %% 5 === 0) pts.push({x: n.x/100, z: n.z/100}); });
  let n = 0, k = 0;
  for(let m = 0; m < 10; m++) pts.forEach(function(q){ n += s.at(ms0 + m*37000, q, rad).filter(function(v){ return v.kind === "car"; }).length; k++; });
  return k ? n/k : 0;
}
Object.keys(SRC).forEach(function(name){
  const W = WD.pack(SRC[name]()), S = L.signals(W), ids = Object.keys(S), o = out[name] = {};
  const inc = {};
  W.edges.forEach(function(e){ (inc[e.a] = inc[e.a] || []).push(e); (inc[e.b] = inc[e.b] || []).push(e); });
  o.lights = ids.length;
  // [3.26] City Gen v4's junction data: lights only where it says signals
  o.genSignals = W.nodes.filter(function(n){ return n.junction === "signals"; }).length;
  o.offGen = ids.filter(function(id){ const n = W.nodes.find(function(q){ return String(q.id) === String(id); }); return o.genSignals && (!n || n.junction !== "signals"); }).length;
  o.kinds = {}; ids.forEach(function(id){ o.kinds[S[id].kind] = (o.kinds[S[id].kind] || 0) + 1; });
  o.onFast = ids.filter(function(id){
    const es = inc[id] || [];
    return es.some(function(e){ return FAST[L.normCls(e.cls)]; }) || es.filter(function(e){ return L.normCls(e.cls) === "highway"; }).length >= 2;
  });
  o.same = JSON.stringify(L.signals(WD.pack(SRC[name]()))) === JSON.stringify(S);
  o.armless = ids.filter(function(id){ return !S[id].arms.length || !(S[id].r > 0); }).length;
  // every light cycles (green, amber and red each come round, the same a cycle later); its two axes are never green
  // together; walking along an axis only while the other axis (the road crossed) is not green
  o.cycles = 0; o.periodic = true; o.bothGreen = 0; o.walkBad = 0; o.walks = 0;
  ids.forEach(function(id){
    const sg = S[id], seen = {};
    for(let t = 0; t < 60000; t += 250){
      const ms = DAY + t, a = L.signalAt(sg, ms, sg.axes[0]), b = L.signalAt(sg, ms, sg.axes[1]);
      seen[a] = 1;
      if(a !== L.signalAt(sg, ms + 60000, sg.axes[0]) || a !== L.signalAt(sg, ms + 60000, sg.axes[0] + Math.PI)) o.periodic = false;
      if(a === "green" && b === "green") o.bothGreen++;
      [0, 1].forEach(function(k){
        if(L.walkAt(sg, ms, sg.axes[k])){ o.walks++; if(L.signalAt(sg, ms, sg.axes[1 - k]) === "green") o.walkBad++; }
      });
    }
    if(seen.green && seen.amber && seen.red) o.cycles++;
  });
  // the traffic: lights on, stopping at red, never into each other, and more of it than without the lights
  const sim = T.create(WD.docOf(W), {tier: 5, seed: W.id, W: W, local: 0}), old = T.create(WD.docOf(W), {tier: 5, seed: W.id, W: W, local: 0, signals: false});
  o.info = sim.info(); o.oldCars = old.info().cars;
  o.carsOverlap = 0; o.redChecks = 0; o.redBad = 0; o.redFirst = null;
  const sl = sim.signals();
  for(let t = 0; t < 480; t += 0.5){
    const ms = DAY + t*1000, all = sim.at(ms, {x: 0, z: 0}, 1e9), B = boxes(all);
    for(let i = 0; i < B.length; i++) for(let j = i + 1; j < B.length; j++){
      if(Math.abs(B[i].x - B[j].x) > 12 || Math.abs(B[i].z - B[j].z) > 12) continue;
      if(overlap(B[i], B[j])) o.carsOverlap++;
    }
    sl.forEach(function(sg){
      sg.arms.forEach(function(a){
        if(L.signalAt(sg, ms, a.heading) !== "red" || L.signalAt(sg, ms - 1000, a.heading) !== "red") return;
        o.redChecks++;
        const ax = Math.sin(a.heading), az = Math.cos(a.heading);
        all.forEach(function(v){
          // (a 27 m tram on a link shorter than itself stands over a line; the emergency runs may go through red)
          if(v.siren || v.kind === "tram" || Math.cos(v.yaw - a.heading) < 0.85) return;
          const dx = v.x - a.stopX, dz = v.z - a.stopZ, along = dx*ax + dz*az, lat = Math.abs(dx*az - dz*ax), S0 = T.SPEC[v.type] || T.SPEC[v.kind];
          if(lat > a.half/2 + 1.5) return;
          if(along + S0.len/2 > 0.3 && along < 4){ o.redBad++; o.redFirst = o.redFirst || [t, v.id, sg.id, a.edge]; }
        });
      });
    });
  }
  o.day = onScreen(sim, W, DAY, 320); o.oldDay = onScreen(old, W, DAY, 320); o.night = onScreen(sim, W, NIGHT, 320); o.dayFar = onScreen(sim, W, DAY, 420);
  // the same cars for everyone
  const sim2 = T.create(WD.docOf(WD.pack(SRC[name]())), {tier: 5, seed: W.id, W: WD.pack(SRC[name]()), local: 0});
  o.det = [DAY, DAY + 7777, NIGHT].every(function(ms){ return JSON.stringify(sim.at(ms, {x: 0, z: 0}, 1e9)) === JSON.stringify(sim2.at(ms, {x: 0, z: 0}, 1e9)); });
  // lightAt: 15 m short of a stop line, coming in along its arm
  const sg = sl[0], a = sg.arms[0], ax = Math.sin(a.heading), az = Math.cos(a.heading), ms = DAY + 12345;
  const la = sim.lightAt(a.stopX - ax*15, a.stopZ - az*15, a.heading, ms);
  o.lightAt = la ? {id: la.sig.id === sg.id, dist: la.dist, state: la.state === L.signalAt(sg, ms, a.heading)} : null;
  o.lightAway = sim.lightAt(a.stopX - ax*15, a.stopZ - az*15, a.heading + Math.PI, ms);
  o.lightFar = sim.lightAt(a.stopX - ax*400, a.stopZ - az*400, a.heading, ms);
  // parked cars
  const P = L.parked(W), lanes = T.lanes(W, 5), busy = {};
  lanes.forEach(function(l){ if(l.cars || l.bus[0] || l.bus[1] || l.tram) busy[l.id] = 1; });
  o.parked = P.length;
  o.parkedSame = JSON.stringify(L.parked(WD.pack(SRC[name]()))) === JSON.stringify(P);
  o.parkedBad = {lane: 0, box: 0, surface: 0, stop: 0};
  const F = L.facts(W);
  P.forEach(function(c){
    if(busy[c.edge]) o.parkedBad.lane++;
    if(ids.some(function(id){ return Math.hypot(S[id].x - c.x, S[id].z - c.z) < S[id].r + 2; })) o.parkedBad.box++;
    [-2.2, 0, 2.2].forEach(function(f){ if(WD.surfaceAt(W, c.x + Math.sin(c.yaw)*f, c.z + Math.cos(c.yaw)*f) !== "road") o.parkedBad.surface++; });
    if(F.stopDist(c.x, c.z) < 10) o.parkedBad.stop++;
  });
  // the street view: a few instanced draw calls; the poles and the parked cars are solid
  const scene = new THREE.Scene(), V = T.street(THREE, scene, W, {});
  V.update(DAY, {x: sg.x, z: sg.z});
  let inst = true;
  V.group.traverse(function(m){ if(m.isMesh && !m.isInstancedMesh) inst = false; });
  const pole = V.arms[0], car = P[0];
  V.update(DAY, {x: car.x, z: car.z});
  o.view = {calls: V.drawCalls(), inst: inst, pole: V.blocked(pole.x, pole.z), poleBeside: V.blocked(pole.x + 2.5, pole.z + 2.5), car: V.blocked(car.x, car.z), info: V.info()};
  V.dispose();
});
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE and os.path.exists(FIXTURE), "node or the @3 fixture missing")
class TrafficLights(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "--input-type=module", "-e", HARNESS % {"root": json.dumps(ROOT)}], capture_output=True, text=True, timeout=900)
        if r.returncode:
            raise AssertionError(r.stderr[-4000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def worlds(self):
        return ("commons", "island", "v4")

    def test_lights_at_real_junctions_never_on_fast_roads(self):
        for w in self.worlds():
            o = self.o[w]
            self.assertGreater(o["lights"], 5, w)
            self.assertGreater(o["kinds"].get("main", 0), 5, w)
            self.assertEqual(o["onFast"], [], w + ": no light on a highway's mainline, an expressway or a ring road")
            self.assertEqual(o["armless"], 0, w)
            self.assertTrue(o["same"], w + ": the lights are a pure function of the world")
        # [3.26] where the world says which junctions have signals (City Gen v4), the lights are there and nowhere else
        # (a downtown crossroads of local streets gives way, as the plan's road-pair table has it)
        for w in self.worlds():
            self.assertGreater(self.o[w]["genSignals"], 0, w)
            self.assertEqual(self.o[w]["offGen"], 0, w + ": a light where the world has no signals")
        # and nearly all of them lit (two a short link apart are one junction: the busier keeps its light)
        for w in self.worlds():
            self.assertGreaterEqual(self.o[w]["lights"] * 4, self.o[w]["genSignals"] * 3, w)

    def test_every_light_cycles_and_its_axes_take_turns(self):
        for w in self.worlds():
            o = self.o[w]
            self.assertEqual(o["cycles"], o["lights"], w + ": green, amber and red each come round")
            self.assertTrue(o["periodic"], w + ": a 60 s cycle, a heading and its reverse alike")
            self.assertEqual(o["bothGreen"], 0, w + ": the two axes are never green together")

    def test_walk_only_while_the_road_crossed_is_not_green(self):
        for w in self.worlds():
            o = self.o[w]
            self.assertGreater(o["walks"], 0, w)
            self.assertEqual(o["walkBad"], 0, w)

    def test_the_traffic_stops_at_red(self):
        for w in self.worlds():
            o = self.o[w]
            self.assertEqual(o["info"]["errors"], [], w)
            self.assertGreater(o["info"]["lights"], 0, w)
            self.assertGreater(o["redChecks"], 1000, w)
            self.assertEqual(o["redBad"], 0, "%s: nobody's nose over a red line: %s" % (w, o["redFirst"]))

    def test_cars_queue_but_never_run_into_each_other(self):
        for w in self.worlds():
            self.assertEqual(self.o[w]["carsOverlap"], 0, w)

    def test_a_fuller_city_by_day_calmer_by_night(self):
        for w in self.worlds():
            o = self.o[w]
            self.assertGreater(o["info"]["cars"], o["oldCars"], w + ": more cars than before the lights")
            self.assertGreater(o["day"], o["night"], w + ": calmer at night")
            self.assertGreater(o["dayFar"], o["day"], w + ": the wider view shows more")
        c = self.o["commons"]
        # (about twice: [3.26] City Gen v4's junctions light fewer side streets than 3.22.1 did, and its mini roundabouts
        # fill the City without lights a little more)
        self.assertGreater(c["day"], 1.7 * c["oldDay"], "about twice the cars on screen in the commons by day")
        self.assertGreater(self.o["island"]["dayFar"], 1.5 * self.o["island"]["oldDay"])

    def test_the_same_for_everyone(self):
        for w in self.worlds():
            self.assertTrue(self.o[w]["det"], w)

    def test_light_ahead(self):
        for w in self.worlds():
            o = self.o[w]
            self.assertIsNotNone(o["lightAt"], w)
            self.assertTrue(o["lightAt"]["id"], w)
            self.assertAlmostEqual(o["lightAt"]["dist"], 15, delta=0.5)
            self.assertTrue(o["lightAt"]["state"], w)
            self.assertIsNone(o["lightFar"], w)
            if o["lightAway"]:
                self.assertNotEqual(o["lightAway"].get("dist"), o["lightAt"]["dist"], w)

    def test_parked_cars_keep_to_the_kerb(self):
        for w in self.worlds():
            o = self.o[w]
            self.assertGreater(o["parked"], 50, w)
            self.assertTrue(o["parkedSame"], w)
            self.assertEqual(o["parkedBad"], {"lane": 0, "box": 0, "surface": 0, "stop": 0}, w)

    def test_the_street_view(self):
        for w in self.worlds():
            v = self.o[w]["view"]
            self.assertTrue(v["inst"], w)
            self.assertLessEqual(v["calls"], 4, w)
            self.assertTrue(v["pole"], w + ": a pole is solid")
            self.assertFalse(v["poleBeside"], w)
            self.assertTrue(v["car"], w + ": a parked car is solid")
            self.assertGreater(v["info"]["shown"], 0, w)


class Source(unittest.TestCase):
    def test_no_random_no_network(self):
        for f in ("traffic.js", "citylife.js"):
            with open(os.path.join(ROOT, "games", f), encoding="utf-8") as fh:
                src = fh.read()
            self.assertNotIn("Math.random", src, f)
            self.assertNotIn("fetch(", src, f)


if __name__ == "__main__":
    unittest.main()
