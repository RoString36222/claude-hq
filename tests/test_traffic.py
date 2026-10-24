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


STREETS = r"""
var fs = require("fs"), zlib = require("zlib"), root = %(root)s, FIX = root + "/tests/fixtures/";
global.window = {HQV: {}};
for (var f of ["world", "traffic"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
var T = window.HQV.traffic, WD = window.HQV.world, city = require(FIX + "traffic_city.js"), out = {};
function gz(p){ return JSON.parse(zlib.gunzipSync(fs.readFileSync(FIX + p)).toString("utf8")); }
var worlds = {city: city(1, 7, true), commons: WD.pack(gz("claude-hq@2.json.gz"))};
if(fs.existsSync(FIX + "claude-hq@3.json.gz")) worlds.v3 = WD.pack(gz("claude-hq@3.json.gz"));
function now(){ var t = process.hrtime(); return t[0]*1e3 + t[1]/1e6; }
function local(p, x, z){ var dx = x - p.x, dz = z - p.z, c = Math.cos(p.yaw), s = Math.sin(p.yaw); return {x: dx*c - dz*s, z: dx*s + dz*c}; }
Object.keys(worlds).forEach(function(name){
  var W = worlds[name], t0 = now(), sim = T.create(W, {tier: 5, seed: 7}), build = now() - t0, o = out[name] = {build: build, info: sim.info()};
  t0 = now();
  for(var k = 0; k < 300; k++) sim.at(1e6 + k*16.7, {x: 0, z: 0}, Infinity);
  o.step = (now() - t0)/300;
  // lanes(): the very numbers the sim drives on, with or without the sim
  var L = T.lanes(W, 5, sim), L2 = T.lanes(W, 5), E = sim._.edges, bad = 0;
  L.forEach(function(e, i){
    var x = E[i], y = L2[i];
    if(e.id !== x.id || e.tram !== !!x.tram || (x.tram && e.tramOff !== x.tramOff) || e.bus[0] !== x.bus[0] || e.bus[1] !== x.bus[1] ||
       ((x.bus[0] || x.bus[1]) && e.busOff !== x.busOff) || e.cars !== !!x.cars || (x.cars && e.carOff !== x.carOff)) bad++;
    if(JSON.stringify(e) !== JSON.stringify(y)) bad++;
  });
  o.lanes = {n: L.length, bad: bad, tram: L.filter(function(e){ return e.tram; }).length, tramOffs: L.filter(function(e){ return e.tram; }).map(function(e){ return e.tramOff; }).filter(function(v, i, a){ return a.indexOf(v) === i; })};
  // tramPaths(): every tram lane covered; the trams drive on the pieces (vehicle centres within 0.2 m)
  var P = T.tramPaths(W, 5, sim), keys = {};
  P.forEach(function(p){ keys[p.key] = p; });
  var missing = 0;
  sim._.lines.forEach(function(r){ if(r.kind === "tram") r.lanes.forEach(function(ln){ if(!keys["L:" + ln.e.i + ":" + ln.dir]) missing++; }); });
  var segs = [];
  P.forEach(function(p){ for(var i = 3; i < p.pts.length; i += 3) segs.push([p.pts[i-3], p.pts[i-1], p.pts[i], p.pts[i+2], p.kind]); });
  function dist(x, z){
    var best = 1e9;
    segs.forEach(function(sg){ var ux = sg[2] - sg[0], uz = sg[3] - sg[1], l = ux*ux + uz*uz, t = l > 1e-12 ? Math.max(0, Math.min(1, ((x - sg[0])*ux + (z - sg[1])*uz)/l)) : 0;
      var d = Math.hypot(x - sg[0] - ux*t, z - sg[1] - uz*t); if(d < best) best = d; });
    return best;
  }
  var ds = [], tram = T.service(sim, "tram");
  for(var t = 1000; t < 1000 + 1800; t += 7.3) tram.vehicles(t*1000).forEach(function(v){ ds.push(dist(v.x, v.z)); });
  ds.sort(function(a, b){ return a - b; });
  o.paths = {n: P.length, kinds: P.map(function(p){ return p.kind; }).filter(function(v, i, a){ return a.indexOf(v) === i; }).sort(), missing: missing,
             xovers: P.filter(function(p){ return p.kind === "xover"; }).length, cusps: sim._.lines.reduce(function(a, r){ return a + (r.cusps ? r.cusps.length : 0); }, 0),
             samples: ds.length, p50: ds[Math.floor(ds.length*0.5)] || 0, p95: ds[Math.floor(ds.length*0.95)] || 0, max: ds[ds.length - 1] || 0};
  // the Service contract
  o.svc = {};
  ["bus", "tram"].forEach(function(kind){
    var S = T.service(sim, kind), lines = S.lines(), stops = S.stops(), ms = 2e6, r = {kind: kind};
    r.mode = S.mode; r.lineKeys = lines.length ? Object.keys(lines[0]).sort() : [];
    r.stopKeys = stops.length ? Object.keys(stops[0]).sort() : [];
    r.lines = lines.length; r.stops = stops.length; r.unique = stops.map(function(s){ return s.name; }).filter(function(v, i, a){ return a.indexOf(v) === i; }).length;
    r.shorts = lines.map(function(l){ return l.short; });
    var st = stops[0], near = S.stopsNear(st.x, st.z, 300);
    r.nearSorted = near.every(function(x, i){ return !i || near[i-1].dist <= x.dist; }); r.nearFirst = near[0] && near[0].id === st.id;
    r.nearKeys = near.length ? Object.keys(near[0]).sort() : [];
    var dep = S.departures(st.id, ms, 6);
    r.dep = {n: dep.length, sorted: dep.every(function(x, i){ return !i || dep[i-1].at <= x.at; }), keys: dep.length ? Object.keys(dep[0]).sort() : [],
             future: dep.every(function(x){ return x.dep > ms; }), boardingOk: dep.every(function(x){ return x.boarding === (x.at <= ms && ms < x.dep); })};
    // a boarding row: ask at a time the first vehicle stands there
    var d0 = S.departures(st.id, ms, 1)[0], mid = (d0.at + d0.dep)/2, d1 = S.departures(st.id, mid, 1)[0];
    r.boarding = d1.boarding && d1.at === d0.at;
    // a trip and its pose, seats and door
    var l0 = lines[lines.length - 1], trip = S.trip(l0.id, l0.stops[0], l0.stops[Math.min(3, l0.stops.length - 1)], ms), bigJump = 0, outSeat = 0, checked = 0, doorFar = 0, prev = null;
    r.tripKeys = Object.keys(trip).sort();
    r.trip = {order: trip.arrive <= trip.depart && trip.depart < trip.reach && trip.arrive >= ms - 60000, last: trip.stops[trip.stops.length - 1].id === trip.to,
              stopsSorted: trip.stops.every(function(x, i){ return !i || trip.stops[i-1].at <= x.at; }), seats: trip.seats, standing: trip.standing, fare: "fare" in trip || "pay" in trip};
    var spec = T.SPEC[kind], vehById = function(t2){ return S.vehicles(t2).filter(function(v){ return v.id === trip.vehicle; })[0]; };
    for(var tm = trip.arrive; tm <= trip.reach; tm += 100){
      var p = trip.pose(tm);
      if(prev){ var jump = Math.hypot(p.x - prev.x, p.z - prev.z); if(jump > spec.vmax*0.1 + 0.05) bigJump++; }
      prev = p;
      if((tm - trip.arrive) %% 3000 !== 0) continue;
      var v = vehById(tm), parts = kind === "tram" ? v.parts.map(function(q){ return {x: q.x, z: q.z, yaw: q.yaw, len: spec.sec}; }) : [{x: p.x, z: p.z, yaw: p.yaw, len: spec.len}];
      if(Math.hypot(v.x - p.x, v.z - p.z) > 0.01) bigJump += 1000;
      for(var i = 0; i < trip.seats + trip.standing; i++){
        var sp = trip.seat(i, tm), inside = parts.some(function(q){ var lc = local(q, sp.x, sp.z); return Math.abs(lc.x) < spec.wid/2 - 0.05 && Math.abs(lc.z) < q.len/2 + (kind === "tram" ? 0.55 : 0); });
        checked++; if(!inside || Math.abs(sp.y - p.y - 0.45) > 0.46) outSeat++;
      }
      var dr = trip.door(tm), dl = Math.min.apply(null, parts.map(function(q){ var lc = local(q, dr.x, dr.z); return Math.abs(Math.abs(lc.x) - spec.wid/2) + Math.max(0, Math.abs(lc.z) - q.len/2); }));
      if(dl > 0.5) doorFar++;
    }
    r.trip.bigJump = bigJump; r.trip.outSeat = outSeat; r.trip.checked = checked; r.trip.doorFar = doorFar;
    var vs = S.vehicles(ms);
    r.veh = {n: vs.length, keys: vs.length ? Object.keys(vs[0]).sort() : [], loads: vs.every(function(v){ return v.load >= 0 && v.load <= 1.15; }), doors: vs.every(function(v){ return v.doors >= 0 && v.doors <= 1; })};
    r.det = JSON.stringify(S.departures(st.id, ms, 4)) === JSON.stringify(T.service(T.create(W, {tier: 5, seed: 7}), kind).departures(st.id, ms, 4));
    o.svc[kind] = r;
  });
  // a traffic incident on a tram line: its rows say delayed
  var tr = T.service(sim, "tram"), e0 = sim._.edges.filter(function(e){ return e.tram; })[0], keep = sim._.incidentsAt;
  sim._.incidentsAt = function(t){ return [{out: {lanes: [{e: e0, dir: 0}]}, back: {lanes: []}, start: t - 10, end: t + 200}]; };
  var hit = sim._.lines.filter(function(r){ return r.kind === "tram" && r.lanes.some(function(m){ return m.e === e0; }); })[0], s0 = tr.stops().filter(function(s){ return s.lines.indexOf(hit.id) >= 0; })[0];
  o.delay = {blocked: tr.departures(s0.id, 2e6, 8).filter(function(x){ return x.line === hit.id; }).map(function(x){ return x.delay; }),
             other: tr.departures(s0.id, 2e6, 8).filter(function(x){ return !hit.lanes.some(function(m){ return m.e === e0; }) || x.line !== hit.id; }).filter(function(x){ return !sim._.lines.filter(function(r){ return r.id === x.line; })[0].lanes.some(function(m){ return m.e === e0; }); }).map(function(x){ return x.delay; }), bus: T.service(sim, "bus").departures(T.service(sim, "bus").stops()[0].id, 2e6, 2).map(function(x){ return x.delay; })};
  sim._.incidentsAt = keep;
  o.delay.clear = tr.departures(s0.id, 2e6, 3).map(function(x){ return x.delay; });
});
// the seat table
out.seats = {bus: T.SEATS.bus.length, tram: T.SEATS.tram.length, stands: [T.STANDS.bus.length, T.STANDS.tram.length]};
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
class Streets(unittest.TestCase):
    """HQ 3.15: lanes(), tramPaths() and the ride Service (docs/plans/transport-revamp.md 3.2, 5.3), on the synthetic
    hub city, the @2 Commons and (when its fixture exists) the @3 Commons, all at tier 5 (D1: every city max level)."""

    @classmethod
    def setUpClass(cls):
        res = subprocess.run([NODE, "-e", STREETS % {"root": json.dumps(ROOT)}], capture_output=True, text=True, timeout=600)
        if res.returncode != 0:
            raise AssertionError("node harness failed:\n" + res.stderr[-4000:])
        cls.r = json.loads(res.stdout.strip().splitlines()[-1])

    def worlds(self):
        return [k for k in self.r if k not in ("seats",)]

    def test_budgets_at_tier_5(self):
        for w in self.worlds():
            o = self.r[w]
            self.assertEqual(o["info"]["errors"], [], w)
            self.assertEqual(o["info"]["dropped"], 0, "%s: every line runs at tier 5" % w)
            self.assertLess(o["build"], 3000, "%s: create() at tier 5" % w)
            self.assertLess(o["step"], 3.0, "%s: at() a frame at tier 5" % w)

    def test_lanes_are_the_sims_offsets(self):
        for w in self.worlds():
            l = self.r[w]["lanes"]
            self.assertGreater(l["tram"], 0, w)
            self.assertEqual(l["bad"], 0, "%s: lanes() equals the sim's lateral plan, with or without the sim" % w)
            self.assertEqual(len(l["tramOffs"]), 1, w)
            self.assertAlmostEqual(l["tramOffs"][0], 1.475, 9, "%s: a tram lane is 1.475 m off the centre line" % w)

    def test_tram_paths_are_where_trams_drive(self):
        for w in self.worlds():
            p = self.r[w]["paths"]
            self.assertEqual(p["missing"], 0, "%s: every tram lane has its piece" % w)
            self.assertEqual(p["kinds"], ["lane", "turn", "xover"], w)
            self.assertGreater(p["xovers"], 0, "%s: crossovers at the termini" % w)
            self.assertGreater(p["samples"], 100)
            self.assertLess(p["p95"], 0.2, "%s: trams drive on the track pieces" % w)
        self.assertLess(self.r["city"]["paths"]["max"], 0.25, "on long lanes every pose is on a piece")

    def test_service_contract(self):
        for w in self.worlds():
            for kind, s in self.r[w]["svc"].items():
                self.assertEqual(s["mode"], kind)
                self.assertEqual(s["lineKeys"], sorted(["id", "mode", "name", "short", "color", "stops", "headway", "loop"]))
                self.assertEqual(s["stopKeys"], sorted(["id", "name", "x", "y", "z", "mode", "lines", "kind", "under"]))
                self.assertEqual(s["nearKeys"], sorted(["id", "name", "dist", "mode", "lines"]))
                self.assertTrue(s["nearSorted"] and s["nearFirst"])
                self.assertEqual(s["unique"], s["stops"], "%s %s: stop names are unique" % (w, kind))
                for sh in s["shorts"]:
                    self.assertRegex(sh, r"^[BT]\d+$" if kind else "")
                for k in ("line", "short", "to", "at", "plat", "boarding", "delay"):
                    self.assertIn(k, s["dep"]["keys"])
                for k in ("id", "line", "mode", "x", "y", "z", "yaw", "speed", "doors", "load", "under"):
                    self.assertIn(k, s["veh"]["keys"])
                self.assertTrue(s["veh"]["loads"] and s["veh"]["doors"])
                for k in ("mode", "line", "short", "vehicle", "from", "to", "fromName", "toName", "arrive", "depart", "reach", "stops", "seats", "standing", "pose", "seat", "door"):
                    self.assertIn(k, s["tripKeys"])
                self.assertTrue(s["det"], "the same departures on two clients")

    def test_departures_ordering(self):
        for w in self.worlds():
            for kind, s in self.r[w]["svc"].items():
                d = s["dep"]
                self.assertEqual(d["n"], 6)
                self.assertTrue(d["sorted"], "%s %s: soonest first" % (w, kind))
                self.assertTrue(d["future"], "a row is a call that has not left yet")
                self.assertTrue(d["boardingOk"])
                self.assertTrue(s["boarding"], "%s %s: boarding while it stands at the stop" % (w, kind))

    def test_trip_pose_is_continuous_and_seats_are_inside(self):
        for w in self.worlds():
            for kind, s in self.r[w]["svc"].items():
                t = s["trip"]
                self.assertTrue(t["order"] and t["last"] and t["stopsSorted"], "%s %s: %s" % (w, kind, t))
                self.assertFalse(t["fare"], "rides are free (D4): no fare on a Service trip")
                self.assertEqual(t["seats"], 31 if kind == "bus" else 48)
                self.assertEqual(t["bigJump"], 0, "%s %s: the pose never jumps (and is the vehicle's)" % (w, kind))
                self.assertGreater(t["checked"], 100)
                self.assertEqual(t["outSeat"], 0, "%s %s: every seat and standing spot inside the body, all trip long" % (w, kind))
                self.assertEqual(t["doorFar"], 0, "%s %s: the door is on the body's side" % (w, kind))

    def test_incident_delays_trams_only(self):
        for w in self.worlds():
            d = self.r[w]["delay"]
            self.assertTrue(d["blocked"] and all(x >= 60 for x in d["blocked"]), "%s: a tram row is delayed while an incident blocks its line" % w)
            self.assertTrue(all(x == 0 for x in d["other"]), "%s: other lines stay on time" % w)
            self.assertEqual(d["clear"], [0, 0, 0])
            self.assertEqual(d["bus"], [0, 0])

    def test_seat_table(self):
        s = self.r["seats"]
        self.assertEqual(s["bus"], 31)
        self.assertEqual(s["tram"], 48)
        self.assertGreater(min(s["stands"]), 8)


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
