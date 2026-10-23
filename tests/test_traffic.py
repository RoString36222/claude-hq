"""City traffic (games/traffic.js, cities spec task cl-traffic): cars, buses, trams, emergency runs.

traffic.js's sim is pure, so node loads it against a stub `window` with the synthetic WorldDoc v2 in
tests/fixtures/traffic_city.js (a jittered 7 x 7 grid: arterials, a tier-2 bus loop, a tier-4
out-and-back tram, stations; its hub variant adds lines that share lanes and stops with those) and
runs the scenarios below in one process; the Python side checks the numbers. The view is built against the vendored three.js. Skipped when node is not installed.
Stdlib only."""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

HARNESS = r"""
import fs from "fs";
import { createRequire } from "module";
const root = %(root)s, require = createRequire(root + "/tests/");
globalThis.window = {HQV: {}};
new Function(fs.readFileSync(root + "/games/traffic.js", "utf8"))();
const T = window.HQV.traffic, city = require(root + "/tests/fixtures/traffic_city.js"), out = {};
const ALL = {x: 0, z: 0}, FAR = 1e6;
function find(list, id){ for(var i = 0; i < list.length; i++) if(list[i].id === id) return list[i]; return null; }
function sim(tier, o){ return T.create(o && o.doc || city(1), Object.assign({tier: tier, seed: 7}, o || {})); }

// ---- determinism: same inputs, same vehicles; another seed, other traffic ----
(function(){
  var a = sim(5), b = sim(5), c = sim(5, {seed: 8}), same = true, diff = false, n = 0;
  for(var t = 0; t < 3600; t += 37.3){
    var A = JSON.stringify(a.at(t*1000, ALL, FAR)), B = JSON.stringify(b.at(t*1000, ALL, FAR)), C = JSON.stringify(c.at(t*1000, ALL, FAR));
    if(A !== B) same = false;
    if(A !== C) diff = true;
    n += JSON.parse(A).length;
  }
  // obstacles are a local override: the same call sequence gives the same result
  var p = sim(3), q = sim(3), ob = [{x: 200, z: -200, r: 3}], so = true;
  for(t = 50; t < 80; t += 1/30) if(JSON.stringify(p.at(t*1000, ALL, FAR, ob)) !== JSON.stringify(q.at(t*1000, ALL, FAR, ob))) so = false;
  out.det = {same: same, diff: diff, n: n, obstacles: so, incidents: JSON.stringify(a.incidents(5e6)) === JSON.stringify(b.incidents(5e6))};
})();

// ---- no two vehicles overlap: oriented boxes, every 0.5 s for 30 minutes, every tier, every kind ----
function boxes(list){
  var b = [];
  list.forEach(function(v){
    if(v.kind === "tram") v.parts.forEach(function(p, j){ b.push({id: v.id + "/" + j, veh: v.id, kind: "tram", x: p.x, z: p.z, yaw: p.yaw, len: T.SPEC.tram.sec, wid: T.SPEC.tram.wid}); });
    else if(T.SPEC[v.kind]) b.push({id: v.id, veh: v.id, kind: v.kind, x: v.x, z: v.z, yaw: v.yaw, len: T.SPEC[v.kind].len, wid: T.SPEC[v.kind].wid, ev: !!v.siren});
  });
  return b;
}
function overlap(a, b, shrink){
  var ax = [Math.sin(a.yaw), Math.cos(a.yaw)], ay = [ax[1], -ax[0]], bx = [Math.sin(b.yaw), Math.cos(b.yaw)], by = [bx[1], -bx[0]];
  var d = [b.x - a.x, b.z - a.z], axes = [ax, ay, bx, by];
  function r(u, x, y, L, W){ return Math.abs(x[0]*u[0] + x[1]*u[1])*L/2 + Math.abs(y[0]*u[0] + y[1]*u[1])*W/2; }
  for(var i = 0; i < 4; i++){
    var u = axes[i];
    if(Math.abs(d[0]*u[0] + d[1]*u[1]) > r(u, ax, ay, a.len, a.wid - shrink) + r(u, bx, by, b.len, b.wid - shrink)) return false;
  }
  return true;
}
// pairs of boxes that overlap in one sample: cars against cars exactly; a long body on a bend cuts
// the corner of its lane by a few cm (the yaw is the chord over its wheelbase), so 10 cm a side of
// slack for the rest. evOnly: only pairs with an emergency vehicle in them.
function clashes(all, evOnly){
  var B = boxes(all), hits = [];
  for(var i = 0; i < B.length; i++) for(var j = i + 1; j < B.length; j++){
    if(B[i].veh === B[j].veh || (evOnly && !B[i].ev && !B[j].ev)) continue;
    var cars = B[i].kind === "car" && B[j].kind === "car";
    if(overlap(B[i], B[j], cars ? 0 : 0.2)) hits.push([B[i].id, B[j].id, cars]);
  }
  return hits;
}
function sweep(s, t0, t1, evOnly){
  var o = {cars: 0, any: 0, first: null, maxCars: 0, samples: 0};
  for(var t = t0; t < t1; t += 0.5){
    var all = s.at(t*1000, ALL, FAR);
    if(evOnly && !all.some(function(v){ return v.siren; })) continue;
    o.samples++;
    o.maxCars = Math.max(o.maxCars, all.filter(function(v){ return v.kind === "car"; }).length);
    clashes(all, evOnly).forEach(function(h){ o.any++; if(h[2]) o.cars++; o.first = o.first || [t, h[0], h[1]]; });
  }
  return o;
}
out.overlap = {};
[1, 2, 3, 4, 5].forEach(function(tier){
  var s = sim(tier), o = sweep(s, 0, 1800, false);
  o.info = s.info();
  out.overlap[tier] = o;
});
// emergency vehicles against everything, through every run in four hours
out.evOverlap = {};
[3, 5].forEach(function(tier){ var s = sim(tier); out.evOverlap[tier] = sweep(s, 0, 4*3600, true); out.evOverlap[tier].runs = 0; for(var t = 0; t < 4*3600; t += 30) out.evOverlap[tier].runs = Math.max(out.evOverlap[tier].runs, +((s.incidents(t*1000).slice(-1)[0] || {id: "e0"}).id.slice(1))); });

// ---- the hub: lines sharing lanes and stops (buses through the hub, trams on one track) ----
out.hub = {};
[2, 3, 4, 5].forEach(function(tier){
  var s = sim(tier, {doc: city(1, 7, true)}), o = sweep(s, 0, 3600, false), ev = sweep(s, 3600, 4*3600, true);
  out.hub[tier] = {any: o.any, cars: o.cars, first: o.first, ev: ev.any, evFirst: ev.first, evSamples: ev.samples, info: s.info(),
                   lines: s.lines().map(function(l){ return {id: l.id, vehicles: l.vehicles, lap: l.lap}; })};
});
(function(){
  // every line keeps its timetable on shared lanes too
  var s = sim(5, {doc: city(1, 7, true)}), errs = [];
  s.lines().forEach(function(l){
    l.stops.forEach(function(st){
      var na = s.nextArrival(st.id, 500000, l.id), seen = null, a = na.arrive/1000, rest = find(s.at((a + 3)*1000, ALL, FAR), na.vehicle);
      for(var t = a - 6; t <= a + 6; t += 0.1){
        var v = find(s.at(t*1000, ALL, FAR), na.vehicle);
        if(v && v.speed < 0.05 && Math.hypot(v.x - rest.x, v.z - rest.z) < 0.3){ seen = t; break; }
      }
      errs.push(seen == null ? 99 : Math.abs(seen - a));
    });
  });
  out.hubTimetable = {checked: errs.length, worst: Math.max.apply(null, errs)};
})();

// ---- tier gating ----
out.tiers = {};
[1, 2, 3, 4, 5].forEach(function(tier){
  var s = sim(tier), kinds = {}, reach = 0;
  for(var t = 0; t < 3600; t += 10) s.at(t*1000, ALL, FAR).forEach(function(v){
    kinds[v.kind] = (kinds[v.kind] || 0) + 1;
    if(v.kind === "car") reach = Math.max(reach, Math.min(Math.abs(v.x), Math.abs(v.z)));
  });
  out.tiers[tier] = {lines: s.lines().map(function(l){ return l.id; }), kinds: kinds, reach: reach,
                     tramStop: s.stopsNear(-200, 200, 400).filter(function(x){ return x.kind === "tramstop"; }).length,
                     busStop: s.stopsNear(0, 0, 400).filter(function(x){ return x.kind === "busstop"; }).length};
});

// ---- the timetable: every arrival seen within 1 s of its schedule, no obstacles ----
(function(){
  var s = sim(5), errs = [], checked = 0, onSite = [];
  var doc = city(1), site = {};
  doc.layers.sites.forEach(function(x){ site[x.id] = x; });
  s.lines().forEach(function(l){
    l.stops.forEach(function(st){
      for(var t0 = 200; t0 < 200 + 2*l.lap; t0 += l.lap/2){
        var na = s.nextArrival(st.id, t0*1000, l.id);
        if(na.arrive < t0*1000) na = s.nextArrival(st.id, na.depart + 1000, l.id);
        var a = na.arrive/1000, rest = find(s.at((a + 3)*1000, ALL, FAR), na.vehicle), seen = null;
        for(var t = a - 6; t <= a + 6; t += 0.1){
          var v = find(s.at(t*1000, ALL, FAR), na.vehicle);
          if(v && v.speed < 0.05 && Math.hypot(v.x - rest.x, v.z - rest.z) < 0.3){ seen = t; break; }
        }
        checked++;
        errs.push(seen == null ? 99 : Math.abs(seen - a));
        onSite.push(Math.hypot(rest.x - site[st.id].x/100, rest.z - site[st.id].z/100));
      }
    });
  });
  out.timetable = {checked: checked, worst: Math.max.apply(null, errs), far: Math.max.apply(null, onSite), lines: s.lines()};
})();

// ---- riding: stops, next arrival, a trip and its fare ----
(function(){
  var paid = [], s = sim(4, {onFare: function(f){ paid.push(f); }});
  var near = s.stopsNear(-200, -200, 400), B1 = s.lines()[0], order = B1.stops.map(function(x){ return x.id; });
  var from = order[0], to = order[3], trip = s.rideTo("B1", from, to, 300000);
  var v0 = find(s.at(trip.depart, ALL, FAR), trip.vehicle), p0 = trip.pose(trip.depart);
  var v1 = find(s.at(trip.reach, ALL, FAR), trip.vehicle), p1 = trip.pose(trip.reach), pm = trip.pose((trip.depart + trip.reach)/2);
  out.ride = {near: near.map(function(x){ return [x.id, x.lines, +x.dist.toFixed(1)]; }), trip: {line: trip.line, kind: trip.kind, from: trip.from, to: trip.to,
              order: trip.arrive <= trip.depart && trip.depart < trip.reach, stops: trip.stops, via: order.slice(1, 3), fare: trip.fare,
              ride: (trip.reach - trip.depart)/1000, sched: B1.stops[3].arr - B1.stops[0].dep},
              atDepart: Math.hypot(v0.x - p0.x, v0.z - p0.z), atReach: Math.hypot(v1.x - p1.x, v1.z - p1.z), done: [pm.done, p1.done],
              pay: [trip.pay(), trip.pay()], paid: paid,
              same: s.rideTo("B1", from, from, 300000), bogus: s.rideTo("B1", from, "nope", 300000), tram2: sim(2).rideTo("T1", "tramstop:0", "tramstop:2", 0)};
  var na = s.nextArrival(from, 300000);
  out.ride.next = {line: na.line, ahead: na.depart >= 300000};
})();

// ---- emergency runs: seeded, rare, and the cars give way ----
(function(){
  var s = sim(5), seen = {}, kinds = {}, pulled = 0, evSeen = 0;
  for(var t = 0; t < 4*3600; t += 30) s.incidents(t*1000).forEach(function(I){ seen[I.id] = I; });
  Object.keys(seen).forEach(function(id){ kinds[seen[id].kind] = (kinds[seen[id].kind] || 0) + 1; });
  var ids = Object.keys(seen).sort();
  ids.slice(0, 6).forEach(function(id){
    var I = seen[id];
    for(var t = I.start + 2000; t < I.end; t += 1000){
      var all = s.at(t, ALL, FAR), ev = find(all, id);
      if(ev){ evSeen++; all.forEach(function(v){ if(v.kind === "car" && v.pull > 0 && Math.hypot(v.x - ev.x, v.z - ev.z) < 60) pulled++; }); }
    }
  });
  out.ev = {n: ids.length, kinds: kinds, evSeen: evSeen, pulled: pulled, siren: ids.length ? !!find(s.at(seen[ids[0]].start + 5000, ALL, FAR), ids[0]).siren : null};
})();

// ---- an obstacle (the player's car) brakes the traffic behind it; the same at any frame rate ----
(function(){
  var s0 = sim(3), t0 = 100, car = s0.at(t0*1000, ALL, FAR).filter(function(v){ return v.kind === "car" && v.speed > 8; })[0];
  var ahead = find(s0.at((t0 + 6)*1000, ALL, FAR), car.id), ob = {x: ahead.x, z: ahead.z, r: 2};
  out.obstacle = {r: ob.r, len: T.SPEC.car.len, fps: {}};
  [60, 30, 20].forEach(function(fps){
    var s = sim(3), minD = 1e9, stopped = 0, back = null;
    for(var k = 0, n = 25*fps; k <= n; k++){
      var t = t0 + k/fps, obs = t < t0 + 15 ? [ob] : [], v = find(s.at(t*1000, ob, 300, obs), car.id);
      if(v && t < t0 + 15){ minD = Math.min(minD, Math.hypot(v.x - ob.x, v.z - ob.z)); if(t > t0 + 10 && v.speed < 0.1) stopped++; }
      if(v) back = v;
    }
    var ref = find(s0.at((t0 + 25)*1000, ALL, FAR), car.id);
    out.obstacle.fps[fps] = {minD: minD, stopped: stopped > 0, behind: Math.hypot(back.x - ref.x, back.z - ref.z)};
  });
})();

// ---- 200 cars: build and step cost ----
(function(){
  var doc = city(1, 13), t = process.hrtime.bigint(), s = T.create(doc, {tier: 5, seed: 7}), build = Number(process.hrtime.bigint() - t)/1e6;
  var F = 600, n = 0;
  for(var k = 0; k < 60; k++) s.at(k*16.7, ALL, FAR);
  t = process.hrtime.bigint();
  for(k = 0; k < F; k++) n = Math.max(n, s.at(1000 + k*16.7, ALL, FAR).filter(function(v){ return v.kind === "car"; }).length);
  out.perf = {cars: s.info().cars, seen: n, build: build, step: Number(process.hrtime.bigint() - t)/1e6/F};
})();

// ---- the view: instanced, a handful of draw calls for 200 cars and the rest ----
(async function(){
  const THREE = await import(root + "/games/vendor/three-module.js");
  var s = T.create(city(1, 13), {tier: 5, seed: 7}), V = T.view({THREE: THREE}), list = s.at(30000, ALL, FAR);
  var ev = null;
  for(var t = 0; !ev && t < 4*3600e3; t += 30e3) ev = s.incidents(t)[0];
  list = list.concat(s.at(ev.start + 5000, ALL, FAR).filter(function(v){ return v.siren; }));
  var n = V.update(list, 30000), meshes = 0, inst = true;
  V.group.traverse(function(o){ if(o.isMesh){ meshes++; if(!o.isInstancedMesh) inst = false; } });
  out.view = {n: n, calls: V.drawCalls(), meshes: meshes, instanced: inst, cap: T.CAP.car, carCount: V.meshes.car.count};
  V.dispose();
  console.log(JSON.stringify(out));
})();
"""


@unittest.skipUnless(NODE, "node is not installed")
class Traffic(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        js = HARNESS % {"root": json.dumps(ROOT)}
        res = subprocess.run([NODE, "--input-type=module", "-e", js], capture_output=True, text=True, timeout=600)
        if res.returncode != 0:
            raise AssertionError("node harness failed:\n" + res.stderr[-4000:])
        cls.r = json.loads(res.stdout.strip().splitlines()[-1])

    def test_determinism(self):
        d = self.r["det"]
        self.assertTrue(d["same"], "two clients with the same doc, tier and clock see the same vehicles")
        self.assertTrue(d["diff"], "another seed gives other traffic")
        self.assertGreater(d["n"], 1000)
        self.assertTrue(d["obstacles"], "the obstacle override is deterministic for the same calls")
        self.assertTrue(d["incidents"])

    def test_no_two_vehicles_overlap(self):
        for tier, o in self.r["overlap"].items():
            self.assertEqual(o["cars"], 0, "tier %s: two cars overlap: %s" % (tier, o["first"]))
            self.assertEqual(o["any"], 0, "tier %s: vehicles overlap: %s" % (tier, o["first"]))
            self.assertGreater(o["maxCars"], 20, "tier %s has traffic" % tier)
            self.assertEqual(o["info"]["errors"], [])
            self.assertEqual(o["info"]["dropped"], 0)

    def test_emergency_vehicles_overlap_nothing(self):
        # in the junction boxes and along the roads, on the way out, on scene and back
        for tier, o in self.r["evOverlap"].items():
            self.assertGreater(o["samples"], 500, "tier %s: emergency runs to check" % tier)
            self.assertEqual(o["any"], 0, "tier %s: an emergency vehicle overlaps: %s" % (tier, o["first"]))

    def test_lines_sharing_lanes_take_them_in_turn(self):
        h = self.r["hub"]
        self.assertEqual([l["id"] for l in h["2"]["lines"]], ["B1", "B2"])
        self.assertEqual([l["id"] for l in h["5"]["lines"]], ["B1", "T1", "B2", "B3", "T2"])
        for tier, o in h.items():
            self.assertEqual(o["any"], 0, "tier %s: vehicles on shared lanes overlap: %s" % (tier, o["first"]))
            self.assertEqual(o["ev"], 0, "tier %s: an emergency vehicle overlaps: %s" % (tier, o["evFirst"]))
            self.assertEqual(o["info"]["errors"], [])
            self.assertEqual(o["info"].get("dropped"), 0, "tier %s: every line runs" % tier)
            for line in o["lines"]:
                self.assertGreater(line["vehicles"], 0, "tier %s: %s has vehicles" % (tier, line["id"]))
        # the lines that share lanes keep laps with a long common period
        laps = {l["id"]: l["lap"] for l in h["5"]["lines"]}
        for line in ("B1", "B2"):
            k = round(laps[line] / laps["B3"])
            self.assertAlmostEqual(laps[line], k * laps["B3"], 3, "%s's lap is a multiple of B3's" % line)
        self.assertAlmostEqual(laps["T1"], laps["T2"], 3)
        tt = self.r["hubTimetable"]
        self.assertGreaterEqual(tt["checked"], 15)
        self.assertLessEqual(tt["worst"], 1.0, "arrivals within 1 s of the timetable on shared lanes")

    def test_tier_gating(self):
        t = self.r["tiers"]
        self.assertEqual(t["1"]["lines"], [])
        self.assertNotIn("bus", t["1"]["kinds"])
        self.assertNotIn("tram", t["1"]["kinds"])
        for tier in ("2", "3"):
            self.assertEqual(t[tier]["lines"], ["B1"], "buses from tier 2")
            self.assertIn("bus", t[tier]["kinds"])
            self.assertNotIn("tram", t[tier]["kinds"])
            self.assertEqual(t[tier]["tramStop"], 0, "a tram stop only exists from its tier")
        for tier in ("4", "5"):
            self.assertEqual(t[tier]["lines"], ["B1", "T1"], "trams from tier 4")
            self.assertIn("tram", t[tier]["kinds"])
            self.assertGreater(t[tier]["tramStop"], 0)
        self.assertEqual(t["1"]["busStop"], 0)
        self.assertGreater(t["2"]["busStop"], 0)
        # roads gated by min_tier: only the outer ring (600 m out) has both |x| and |z| over 500 m,
        # and it carries cars only from tier 3
        self.assertLess(t["1"]["reach"], 500)
        self.assertLess(t["2"]["reach"], 500)
        self.assertGreater(t["3"]["reach"], 550)

    def test_buses_and_trams_keep_their_timetable(self):
        tt = self.r["timetable"]
        self.assertGreaterEqual(tt["checked"], 40)
        self.assertLessEqual(tt["worst"], 1.0, "every arrival within 1 s of its schedule")
        self.assertLess(tt["far"], 40, "vehicles stop at their stop sites")
        for line in tt["lines"]:
            self.assertGreater(line["vehicles"], 0)
            for st in line["stops"]:
                self.assertGreaterEqual(st["dep"] - st["arr"], 20 - 1e-6, "at least a 20 s dwell at every stop")

    def test_riding(self):
        r = self.r["ride"]
        self.assertTrue(r["near"])
        self.assertTrue(all(lines == ["B1"] for sid, lines, _d in r["near"] if sid.startswith("busstop")))
        self.assertEqual(r["trip"]["line"], "B1")
        self.assertEqual(r["trip"]["kind"], "bus")
        self.assertTrue(r["trip"]["order"])
        self.assertEqual(r["trip"]["stops"], r["trip"]["via"], "the two stops on the way, in order")
        self.assertAlmostEqual(r["trip"]["ride"], r["trip"]["sched"], 2, "the ride takes what the timetable says")
        self.assertEqual(r["trip"]["fare"], {"kind": "bus", "coins": 2})
        self.assertLess(r["atDepart"], 0.01, "the trip moves the rider with the bus")
        self.assertLess(r["atReach"], 0.01)
        self.assertEqual(r["done"], [False, True])
        self.assertEqual(r["pay"], [True, False], "the fare is paid once")
        self.assertEqual(len(r["paid"]), 1)
        self.assertEqual(r["paid"][0]["coins"], 2)
        self.assertEqual(r["paid"][0]["kind"], "bus")
        self.assertIsNone(r["same"])
        self.assertIsNone(r["bogus"])
        self.assertIsNone(r["tram2"], "no tram ride below the tram's tier")
        self.assertEqual(r["next"]["line"], "B1")
        self.assertTrue(r["next"]["ahead"])

    def test_emergency_runs(self):
        e = self.r["ev"]
        self.assertGreater(e["n"], 3, "a few incidents in four hours")
        self.assertLess(e["n"], 40, "but rare")
        self.assertEqual(set(e["kinds"]) - {"fire", "ambulance", "police"}, set())
        self.assertGreaterEqual(len(e["kinds"]), 2)
        self.assertGreater(e["evSeen"], 50)
        self.assertGreater(e["pulled"], 0, "cars pull over for an emergency vehicle")
        self.assertTrue(e["siren"])

    def test_obstacles_brake_traffic_at_any_frame_rate(self):
        o = self.r["obstacle"]
        for fps, f in o["fps"].items():
            self.assertGreater(f["minD"], o["r"] + o["len"] / 2, "%s fps: the car stops short of the obstacle" % fps)
            self.assertTrue(f["stopped"])
        a, b = o["fps"]["60"], o["fps"]["20"]
        self.assertLess(abs(a["minD"] - b["minD"]), 0.5, "where it stops does not depend on the frame rate")
        self.assertLess(abs(a["behind"] - b["behind"]), 1.0, "nor how far behind schedule it is")

    def test_200_cars_performance(self):
        p = self.r["perf"]
        self.assertGreaterEqual(p["cars"], 200)
        self.assertGreaterEqual(p["seen"], 200)
        self.assertLess(p["build"], 3000, "create() in well under a few seconds")
        self.assertLess(p["step"], 3.0, "at() for 200+ cars in a few ms a frame")

    def test_view_is_instanced(self):
        v = self.r["view"]
        self.assertTrue(v["instanced"])
        self.assertEqual(v["carCount"], min(v["cap"], v["n"]["car"]))
        self.assertEqual(v["n"]["car"], 200, "up to 200 cars drawn")
        self.assertLessEqual(v["calls"], 12, "a draw call per body kind, not per car")
        self.assertEqual(sum(v["n"][k] for k in ("fire", "ambulance", "police")), 1)
        self.assertEqual(v["n"]["beacon"], 2, "an emergency vehicle has its light bar")


# ---- with a city (o.city): a stub director with citysim's contract shapes, and the real one when present ----
CITY_HARNESS = r"""
import fs from "fs";
import { createRequire } from "module";
const root = %(root)s, require = createRequire(root + "/tests/");
globalThis.window = {HQV: {}};
new Function(fs.readFileSync(root + "/games/traffic.js", "utf8"))();
const T = window.HQV.traffic, city = require(root + "/tests/fixtures/traffic_city.js"), out = {};
const ALL = {x: 0, z: 0}, FAR = 1e6, S = 1000, W = 1200, T0 = Date.UTC(2026, 9, 19, 6);
function find(list, id){ for(var i = 0; i < list.length; i++) if(list[i].id === id) return list[i]; return null; }

// The stub D: every 20 minutes a fire (two engines, a police car), a medical call (ambulance to a "hospital"),
// a robbery (getaway along a route, two chasers), a crash (police, tow), a school run, a market van; patrols
// and delivery rounds per 2 h; rush 07-09 UTC. Node ids on the n x n grid are r*n + c.
function stub(n){
  n = n || 7;
  function id(r, c){ return r*n + c; }
  var memo = {};
  function win(w){
    if(memo[w]) return memo[w];
    var t = w*W*S, list = [];
    function ev(kind, off, node, units, extra){
      var e = {id: kind + ":" + w, kind: kind, start: t + off*S, end: t + (off + 1000)*S, node: node, x: 0, z: 0, units: units, severity: 2, label: kind};
      for(var k in extra || {}) e[k] = extra[k];
      e.units.forEach(function(u){ ["dispatch", "arrive", "leave", "back", "drop"].forEach(function(f){ if(u[f] != null) u[f] = t + u[f]*S; }); });
      list.push(e);
    }
    ev("fire", 30, id(4, 2), [{kind: "fire", station: "fire:0", home: id(1, 1), node: id(4, 2), dispatch: 60, arrive: 120, leave: 700, back: 800},
                              {kind: "fire", station: "fire:0", home: id(1, 1), node: id(4, 2), dispatch: 150, arrive: 210, leave: 730, back: 830},
                              {kind: "police", station: "police:0", home: id(1, 5), node: id(4, 2), dispatch: 60, arrive: 120, leave: 760, back: 860}]);
    ev("medical", 200, id(2, 2), [{kind: "ambulance", station: "clinic:0", home: id(5, 5), node: id(2, 2), dispatch: 230, arrive: 300, leave: 500, drop: 600, back: 800}], {dest: "transit:0"});
    ev("crime", 400, id(3, 1), [{kind: "getaway", station: null, home: null, node: id(5, 4), dispatch: 420, arrive: 520, leave: 700, back: 700},
                                {kind: "police", station: "police:0", home: id(1, 5), node: id(5, 4), lag: 3.5, dispatch: 423.5, arrive: 523.5, leave: 700, back: 800},
                                {kind: "police", station: "police:0", home: id(1, 5), node: id(5, 4), lag: 5.2, dispatch: 425.2, arrive: 525.2, leave: 700, back: 800}],
       {route: [id(3, 1), id(3, 2), id(3, 3), id(3, 4), id(4, 4), id(5, 4)]});
    ev("crash", 600, id(2, 4), [{kind: "police", station: "police:0", home: id(1, 5), node: id(2, 4), dispatch: 610, arrive: 650, leave: 900, back: 960},
                                {kind: "tow", station: "transit:0", home: id(3, 3), node: id(2, 4), dispatch: 620, arrive: 680, leave: 880, back: 950}]);
    ev("school", 800, id(1, 3), [{kind: "schoolbus", station: "transit:0", home: id(3, 3), node: id(1, 3), dispatch: 800, arrive: 860, leave: 1000, back: 1080}]);
    ev("market", 900, id(5, 2), [{kind: "van", station: "transit:0", home: id(3, 3), node: id(5, 2), dispatch: 900, arrive: 960, leave: 1100, back: 1180}]);
    if(w %% 6 === 0){
      for(var j = 0; j < 3; j++) list.push({id: "patrol:" + w + ":" + j, kind: "patrol", start: t, end: t + 7200*S, node: id(1, 5), units: [{kind: "police", station: "police:0", home: id(1, 5), node: id(1, 5), dispatch: t, arrive: t, leave: t + 7200*S, back: t + 7200*S}]});
      for(j = 0; j < 2; j++) list.push({id: "delivery:" + w + ":" + j, kind: "delivery", start: t, end: t + 3600*S, node: id(3, 3), units: [{kind: "van", station: "transit:0", home: id(3, 3), node: id(3, 3), dispatch: t, arrive: t, leave: t + 3600*S, back: t + 3600*S}]});
    }
    return (memo[w] = list);
  }
  function events(a, b){
    var outl = [];
    for(var w = Math.floor((a - 7200*S)/(W*S)); w <= Math.floor(b/(W*S)); w++) win(w).forEach(function(e){ if(e.start < b && e.end > a) outl.push(e); });
    return outl.sort(function(x, y){ return x.start - y.start || (x.id < y.id ? -1 : 1); });
  }
  function active(ms){ return events(ms, ms + 1).filter(function(e){ return e.start <= ms && ms < e.end; }); }
  function unitsAt(ms){
    var o = [];
    active(ms).forEach(function(e){ e.units.forEach(function(u){ if(ms >= u.dispatch && ms < u.back) o.push({ev: e, unit: u, phase: "responding", from: {x: 0, z: 0}, to: {x: 0, z: 0}}); }); });
    return o;
  }
  function at(ms){ var h = (ms/3600000) %% 24; return {rush: h >= 7 && h < 9 ? 1 : 0, match: null, market: null, school: null, festival: null}; }
  return {events: events, active: active, unitsAt: unitsAt, at: at, phase: function(){ return "onscene"; }};
}
function sim(o){ return T.create(o && o.doc || city(1, 7, true), Object.assign({tier: 5, seed: 7, city: stub()}, o || {})); }

// ---- determinism: the same clock, the same city traffic; a fresh instance asked mid-event agrees ----
(function(){
  var a = sim(), b = sim(), same = true, fresh = true, n = 0;
  for(var t = T0; t < T0 + 3600*S; t += 4.7*S){
    var A = JSON.stringify(a.at(t, ALL, FAR)), B = JSON.stringify(b.at(t, ALL, FAR));
    if(A !== B) same = false;
    n++;
  }
  [T0 + 1500*S, T0 + 2300*S, T0 + 2900*S].forEach(function(t){
    if(JSON.stringify(sim().at(t, ALL, FAR)) !== JSON.stringify(a.at(t, ALL, FAR))) fresh = false;
  });
  out.det = {same: same, fresh: fresh, n: n};
})();

// ---- every unit runs, through its phases, with the right lights; patrols and vans on the rings ----
(function(){
  var s = sim(), kinds = {}, phases = {}, units = {}, patrolMax = 0, vanRing = 0, fireMax = 0, siren = {}, lights = {}, pulled = 0;
  var cars = {rush: [], calm: []};
  for(var t = T0; t < T0 + 3*3600*S; t += 2*S){
    var all = s.at(t, ALL, FAR), pat = 0, fires = 0, nc = 0;
    all.forEach(function(v){
      if(v.patrol) pat++;
      if(v.kind === "van" && !v.ev) vanRing++;
      if(v.kind === "car") nc++;
      if(!v.ev) return;
      kinds[v.kind] = 1; units[v.id] = 1; phases[v.kind + ":" + v.phase] = 1;
      if(v.kind === "fire") fires++;
      if(v.siren) siren[v.kind + ":" + v.phase] = 1;
      if(v.lights) lights[v.kind + ":" + v.phase] = 1;
    });
    all.forEach(function(v){ if(v.kind === "car" && v.pull > 0) pulled++; });
    patrolMax = Math.max(patrolMax, pat); fireMax = Math.max(fireMax, fires);
    var h = ((t/3600000) %% 24);
    (h >= 7 && h < 9 ? cars.rush : cars.calm).push(nc);
  }
  function avg(l){ return l.reduce(function(a, b){ return a + b; }, 0)/l.length; }
  out.units = {kinds: Object.keys(kinds).sort(), phases: Object.keys(phases).sort(), n: Object.keys(units).length, patrolMax: patrolMax, vanRing: vanRing,
               fireMax: fireMax, siren: Object.keys(siren).sort(), lights: Object.keys(lights).sort(), pulled: pulled,
               rush: avg(cars.rush), calm: avg(cars.calm), incidents: s.incidents(T0 + 1300*S).map(function(i){ return i.kind; }).sort()};
})();

// ---- the chase: the getaway flees along the route, the police pass the same spot their lag behind ----
(function(){
  var s = sim(), w = Math.floor(T0/(W*S)) + 1, gid = "crime:" + w + "/0", g = null, t;
  for(t = T0; !g && t < T0 + 3*W*S; t += 0.5*S){ var v = find(s.at(t, ALL, FAR), gid); if(v && v.speed > 1) g = {t: t, v: v}; }
  // where the getaway car is 2 s into its run: each chaser passes there its lag behind (later on it may lose
  // time queueing behind the car ahead at a box)
  var mark = find(s.at(g.t + 2*S, ALL, FAR), gid), lags = [], sirens = true, held = null;
  ["crime:" + w + "/1", "crime:" + w + "/2"].forEach(function(pid){
    var seen = null;
    for(var u = g.t; u < g.t + 60*S; u += 0.05*S){
      var p = find(s.at(u, ALL, FAR), pid);
      if(p && p.phase === "chase" && !p.siren) sirens = false;
      if(p && Math.hypot(p.x - mark.x, p.z - mark.z) < 1.0){ seen = u; break; }
    }
    lags.push(seen == null ? null : (seen - g.t - 2*S)/S);
  });
  for(t = g.t; t < g.t + 400*S; t += 1*S){
    var all = s.at(t, ALL, FAR), G = find(all, gid), P = find(all, "crime:" + w + "/1");
    if(G && P && G.phase === "caught" && P.phase === "onscene"){ held = Math.hypot(G.x - P.x, G.z - P.z); break; }
  }
  out.chase = {lags: lags, sirens: sirens, held: held};
})();

// ---- nothing overlaps: every vehicle, every 0.5 s, for an hour of events ----
function boxes(list){
  var b = [];
  list.forEach(function(v){
    if(v.kind === "tram") v.parts.forEach(function(p, j){ b.push({id: v.id + "/" + j, veh: v.id, kind: "tram", x: p.x, z: p.z, yaw: p.yaw, len: T.SPEC.tram.sec, wid: T.SPEC.tram.wid}); });
    else b.push({id: v.id, veh: v.id, kind: v.kind, x: v.x, z: v.z, yaw: v.yaw, len: T.SPEC[v.kind].len, wid: T.SPEC[v.kind].wid, ev: v.ev});
  });
  return b;
}
function overlap(a, b, shrink){
  var ax = [Math.sin(a.yaw), Math.cos(a.yaw)], ay = [ax[1], -ax[0]], bx = [Math.sin(b.yaw), Math.cos(b.yaw)], by = [bx[1], -bx[0]];
  var d = [b.x - a.x, b.z - a.z], axes = [ax, ay, bx, by];
  function r(u, x, y, L, Wd){ return Math.abs(x[0]*u[0] + x[1]*u[1])*L/2 + Math.abs(y[0]*u[0] + y[1]*u[1])*Wd/2; }
  for(var i = 0; i < 4; i++){
    var u = axes[i];
    if(Math.abs(d[0]*u[0] + d[1]*u[1]) > r(u, ax, ay, a.len, a.wid - shrink) + r(u, bx, by, b.len, b.wid - shrink)) return false;
  }
  return true;
}
(function(){
  var s = sim(), o = {any: 0, cross: 0, first: null, samples: 0, kinds: {}};
  for(var t = T0 + W*S; t < T0 + 3*W*S; t += 0.5*S){
    var B = boxes(s.at(t, ALL, FAR));
    o.samples++;
    for(var i = 0; i < B.length; i++) for(var j = i + 1; j < B.length; j++){
      var cars = B[i].kind === "car" && B[j].kind === "car";
      if(B[i].veh === B[j].veh || !overlap(B[i], B[j], cars ? 0 : 0.2)) continue;
      // units of two different events are not planned against each other
      if(B[i].ev && B[j].ev && B[i].ev !== B[j].ev){ o.cross++; continue; }
      o.any++; o.first = o.first || [t, B[i].id, B[j].id];
    }
  }
  out.overlap = o;
})();

// ---- perf: 200+ cars and the city's units, planning included ----
(function(){
  var doc = city(1, 13), D = stub(13), s = T.create(doc, {tier: 5, seed: 7, city: D}), F = 600, worst = 0, n = 0;
  for(var k = 0; k < 60; k++) s.at(T0 + k*16.7, ALL, FAR);
  var t0 = process.hrtime.bigint();
  for(k = 0; k < F; k++){
    var t1 = process.hrtime.bigint(), list = s.at(T0 + 25*S + k*1000, ALL, FAR);
    worst = Math.max(worst, Number(process.hrtime.bigint() - t1)/1e6);
    n = Math.max(n, list.filter(function(v){ return v.ev; }).length);
  }
  out.perf = {step: Number(process.hrtime.bigint() - t0)/1e6/F, worst: worst, units: n, cars: s.info().cars};
})();

// ---- real citysim when it is there ----
(function(){
  var f = root + "/games/citysim.js";
  if(!fs.existsSync(f)){ out.real = null; return; }
  new Function(fs.readFileSync(f, "utf8"))();
  var doc = city(1, 7, true), D = window.HQV.citySim.create(doc, {tier: 5}), s = T.create(doc, {tier: 5, seed: 7, city: D});
  var D2 = window.HQV.citySim.create(doc, {tier: 5}), s2 = T.create(doc, {tier: 5, seed: 7, city: D2});
  var kinds = {}, same = true, t0 = process.hrtime.bigint(), frames = 0, units = {}, patrol = 0;
  for(var t = T0; t < T0 + 6*3600*S; t += 3*S){
    var A = s.at(t, ALL, FAR); frames++;
    A.forEach(function(v){ if(v.ev){ kinds[v.kind] = 1; units[v.id] = 1; } if(v.patrol) patrol++; });
    if(frames %% 97 === 0 && JSON.stringify(A) !== JSON.stringify(s2.at(t, ALL, FAR))) same = false;
  }
  var want = {};
  D.events(T0, T0 + 6*3600*S).forEach(function(e){ if(e.kind !== "patrol" && e.kind !== "delivery") e.units.forEach(function(u, k){ if(u.dispatch < T0 + 6*3600*S - 1200*S && u.home !== u.node) want[e.id + "/" + k] = 1; }); });   // (a unit already there drives nowhere)
  var got = Object.keys(want).filter(function(id){ return units[id]; }).length;
  out.real = {kinds: Object.keys(kinds).sort(), same: same, step: Number(process.hrtime.bigint() - t0)/1e6/frames, want: Object.keys(want).length, got: got, patrol: patrol};
  // and on the real map (claude-hq@2): an hour, at a frame a second near the centre
  const zlib = require("zlib"), hq = JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/claude-hq@2.json.gz")));
  var DH = window.HQV.citySim.create(hq, {tier: 5}), sh = T.create(hq, {tier: 5, city: DH}), T1 = Date.UTC(2026, 9, 21, 7), seenH = {}, wantH = 0, gotH = 0;
  for(var k = 0; k < 4; k++) sh.at(T1 + k*1000, ALL, 400);
  t0 = process.hrtime.bigint();
  for(t = T1; t < T1 + 3600*S; t += S) sh.at(t, ALL, 400);
  var stepH = Number(process.hrtime.bigint() - t0)/1e6/3600;
  for(t = T1; t < T1 + 3600*S; t += 3*S) sh.at(t, ALL, FAR).forEach(function(v){ if(v.ev) seenH[v.id] = 1; });
  DH.events(T1, T1 + 3600*S).forEach(function(e){ if(e.kind !== "patrol" && e.kind !== "delivery") e.units.forEach(function(u, k){ if(u.dispatch < T1 + 2400*S && u.home !== u.node){ wantH++; if(seenH[e.id + "/" + k]) gotH++; } }); });
  out.real.hq = {step: stepH, want: wantH, got: gotH};
})();

// ---- the view: the new kinds instanced, the getaway in the car meshes, Calm beacons steady ----
(async function(){
  const THREE = await import(root + "/games/vendor/three-module.js");
  var V = T.view({THREE: THREE}), p = {x: 0, y: 0, z: 0, yaw: 0, speed: 5};
  function veh(id, kind, extra){ var v = Object.assign({id: id, kind: kind}, p, extra || {}); return v; }
  var list = [veh("c1", "car", {paint: 0xffffff}), veh("g", "getaway", {ev: "x"}), veh("v", "van", {paint: 0xe8b730}), veh("tw", "tow", {lights: true, siren: false}),
              veh("sb", "schoolbus"), veh("pp", "police", {patrol: true, siren: false}), veh("f", "fire", {siren: true})];
  var n = V.update(list, 0), calls = V.drawCalls(), inst = true;
  V.group.traverse(function(o){ if(o.isMesh && !o.isInstancedMesh) inst = false; });
  var col = new THREE.Color(), beacons = [];
  [0, 250].forEach(function(ms){
    V.update(list, ms, {calm: true});
    var c = []; for(var i = 0; i < V.meshes.beacon.count; i++){ V.meshes.beacon.getColorAt(i, col); c.push(col.getHex()); }
    beacons.push(c.join(","));
  });
  var flashing = [];
  [0, 250].forEach(function(ms){
    V.update(list, ms);
    var c = []; for(var i = 0; i < V.meshes.beacon.count; i++){ V.meshes.beacon.getColorAt(i, col); c.push(col.getHex()); }
    flashing.push(c.join(","));
  });
  out.view = {n: n, calls: calls, instanced: inst, carMesh: V.meshes.car.count, calmSteady: beacons[0] === beacons[1], flashes: flashing[0] !== flashing[1]};
  V.dispose();
  console.log(JSON.stringify(out));
})();
"""


@unittest.skipUnless(NODE, "node is not installed")
class CityTraffic(unittest.TestCase):
    """traffic.create(doc, {city: D}) (Living City plan 2.2): the director's units, chases, patrols, vans, rush."""

    @classmethod
    def setUpClass(cls):
        js = CITY_HARNESS % {"root": json.dumps(ROOT)}
        res = subprocess.run([NODE, "--input-type=module", "-e", js], capture_output=True, text=True, timeout=600)
        if res.returncode != 0:
            raise AssertionError("node harness failed:\n" + res.stderr[-4000:])
        cls.r = json.loads(res.stdout.strip().splitlines()[-1])

    def test_determinism(self):
        d = self.r["det"]
        self.assertTrue(d["same"], "two clients with the same city see the same units")
        self.assertTrue(d["fresh"], "a fresh instance asked mid-event agrees: trips are pure")

    def test_units_run_their_phases(self):
        u = self.r["units"]
        self.assertEqual(u["kinds"], ["ambulance", "fire", "getaway", "police", "schoolbus", "tow", "van"])
        for ph in ("fire:responding", "fire:onscene", "fire:returning", "ambulance:transport", "ambulance:drop",
                   "getaway:chase", "getaway:caught", "police:chase", "tow:onscene", "schoolbus:responding", "van:onscene"):
            self.assertIn(ph, u["phases"])
        self.assertGreaterEqual(u["fireMax"], 2, "several engines at one fire")
        self.assertIn("fire:responding", u["siren"])
        self.assertIn("ambulance:transport", u["siren"])
        self.assertNotIn("fire:returning", u["siren"], "no siren on the way home")
        self.assertNotIn("tow:responding", u["siren"])
        self.assertIn("fire:onscene", u["lights"], "lights on at the scene")
        self.assertIn("tow:responding", u["lights"])
        self.assertGreater(u["pulled"], 0, "cars pull over for the city's emergency runs")
        self.assertEqual(u["patrolMax"], 3, "as many patrol cars on the rings as the city has out")
        self.assertGreater(u["vanRing"], 0, "delivery vans on the rings")
        self.assertGreater(u["rush"], u["calm"] * 1.2, "more cars in the rush hour")
        self.assertTrue(u["incidents"])

    def test_chase(self):
        c = self.r["chase"]
        for lag in c["lags"]:
            self.assertIsNotNone(lag, "the police drive the getaway car's path")
            self.assertGreaterEqual(lag, 2.0)
            self.assertLessEqual(lag, 9.0, "a few seconds behind (the director's lag, 3-6 s, within the slack)")
        self.assertTrue(c["sirens"], "chasers have their sirens on")
        self.assertIsNotNone(c["held"])
        self.assertLess(c["held"], 15, "the police stop in line behind the caught car")

    def test_no_overlaps(self):
        o = self.r["overlap"]
        self.assertGreater(o["samples"], 4000)
        self.assertEqual(o["any"], 0, "vehicles overlap: %s" % (o["first"],))

    def test_performance(self):
        p = self.r["perf"]
        self.assertGreaterEqual(p["cars"], 200)
        self.assertGreater(p["units"], 2)
        self.assertLess(p["step"], 3.0, "at() with the city's units in a few ms a frame, planning included")

    def test_real_citysim(self):
        r = self.r["real"]
        if r is None:
            self.skipTest("games/citysim.js is not there yet")
        self.assertTrue(r["same"])
        self.assertIn("police", r["kinds"])
        self.assertGreater(r["patrol"], 0, "the director's patrols ride the rings")
        self.assertGreater(r["want"], 3)
        self.assertGreaterEqual(r["got"], 0.8 * r["want"], "most of the director's units drive (%s of %s)" % (r["got"], r["want"]))
        self.assertLess(r["step"], 3.0)
        hq = r["hq"]
        self.assertLess(hq["step"], 3.0, "the real map, with its events planned as they come")
        self.assertGreater(hq["want"], 3)
        self.assertGreaterEqual(hq["got"], 0.6 * hq["want"], "most units drive on the real map (%s of %s)" % (hq["got"], hq["want"]))

    def test_view(self):
        v = self.r["view"]
        self.assertTrue(v["instanced"])
        self.assertLessEqual(v["calls"], 13, "a draw call per body kind")
        self.assertEqual(v["carMesh"], 2, "the getaway car is drawn with the cars")
        for k in ("van", "tow", "schoolbus", "getaway", "police", "fire"):
            self.assertEqual(v["n"][k], 1)
        self.assertEqual(v["n"]["beacon"], 6, "light bars on the police car, the fire engine and the tow truck")
        self.assertTrue(v["calmSteady"], "Calm: beacons never flash")
        self.assertTrue(v["flashes"])


REAL_HQ = r"""
var fs = require("fs"), zlib = require("zlib"), root = %(root)s;
global.window = {HQV: {}};
["world", "roadsmooth", "citysim", "traffic"].forEach(function(f){ new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))(); });
var HQV = window.HQV, W = HQV.world.pack(JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/claude-hq@2.json.gz"))));
var doc = HQV.world.docOf(W), D = HQV.citySim.create(doc, {seed: W.id, tier: 5, coverage: 0.6}), out = {};
function make(){ return HQV.traffic.create(doc, {tier: 5, seed: W.id, city: D}); }
function ms(f){ var a = process.hrtime.bigint(); f(); return Number(process.hrtime.bigint() - a)/1e6; }
// 30 minutes of frames (10 a second) round the camera, warm() given 2 ms a frame as the City does
var T = make(), C = make(), t0 = Date.UTC(2026, 9, 21, 9, 0, 0), worst = 0, sum = 0, n = 0, wWorst = 0, diff = 0;
out.setup = ms(function(){ T.warm(t0, Infinity, true); });
for(var f = 0; f < 30*60*10; f++){
  var t = t0 + f*100;
  wWorst = Math.max(wWorst, ms(function(){ T.warm(t, 2); }));
  var d = ms(function(){ T.at(t, {x: 0, z: 0}, 320, []); }); worst = Math.max(worst, d); sum += d; n++;
  if(f % 600 === 0 && JSON.stringify(T.incidents(t)) !== JSON.stringify(C.incidents(t))) diff++;
}
out.perf = {worst: worst, mean: sum/n, warmWorst: wWorst, diff: diff};
// a week: the school buses and the market vans drive
var S = make(), wk = Date.UTC(2026, 9, 19), kinds = {}, vans = {};
D.events(wk, wk + 7*86400000).filter(function(e){ return e.kind === "school" || e.kind === "market"; }).forEach(function(ev){
  for(var t = ev.start; t < ev.end; t += 10000) S.incidents(t).forEach(function(x){
    if(x.ev !== ev.id) return;
    kinds[ev.kind + ":" + x.kind] = 1;
    if(ev.kind === "market" && x.kind === "van") (vans[ev.id] = vans[ev.id] || {})[x.id] = 1;
  });
});
out.week = {kinds: Object.keys(kinds).sort(), vans: Object.keys(vans).map(function(k){ return Object.keys(vans[k]).length; })};
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE and os.path.exists(os.path.join(ROOT, "games", "citysim.js")), "node and games/citysim.js needed")
class RealCityFrames(unittest.TestCase):
    """The Commons (claude-hq@2, roads smoothed) with the real director at tier 5, coverage 0.6: no frame plans a
    whole event (warm() plans them a step at a time, ahead), and the school buses and market vans really drive."""
    @classmethod
    def setUpClass(cls):
        p = subprocess.run([NODE, "-e", REAL_HQ.replace("%(root)s", json.dumps(ROOT))], capture_output=True, text=True, timeout=600)
        if p.returncode != 0:
            raise AssertionError(p.stderr[-4000:])
        cls.r = json.loads(p.stdout)

    def test_worst_frame_in_budget(self):
        p = self.r["perf"]
        self.assertLess(p["worst"], 3.0, p)                     # at(): never a plan in a frame once warm runs
        self.assertLess(p["mean"], 0.5, p)
        self.assertEqual(p["diff"], 0, "warm() changes when an event is planned, never its trips")

    def test_school_buses_and_market_vans_drive(self):
        w = self.r["week"]
        self.assertIn("school:schoolbus", w["kinds"])
        self.assertIn("market:van", w["kinds"])
        self.assertTrue(w["vans"] and max(w["vans"]) >= 2, w)


class Source(unittest.TestCase):
    def test_frame_rate_independent_and_seeded(self):
        with open(os.path.join(ROOT, "games", "traffic.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIsNone(re.search(r"Math\.min\(\s*1\s*,[^)]*dt", src), "use ease(k, dt), never Math.min(1, dt*k)")
        self.assertNotIn("Math.random", src)
        self.assertNotIn("innerHTML", src)
        self.assertNotIn("fetch(", src, "the fare goes through the integrator's hook")


if __name__ == "__main__":
    unittest.main()
