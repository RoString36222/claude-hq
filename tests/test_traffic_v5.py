"""Traffic on the v5 Commons (HQ 3.37): parked cars off the running lanes, the local streets driven, buses on the avenues.

The fixture tests/fixtures/commons_v5.json.gz is the Commons as City Gen v5 builds it now (`worldgen claude-hq@4 --json`,
its id set to the live claude-hq@3; blocks and zones left out: nothing here reads them), bus stops and bus loops
included. Under node with games/world.js, citylife.js and traffic.js:
  - parked cars (cityLife.parked): none in a running lane. A 6.5 m local street has no room for a parking lane beside two
    running lanes, so every car stands in a bay off the carriageway (no corner of its bay on a road, a pavement, a lot or
    a site, nothing solid under it, none on a junction's box, at a stop or in front of a door); the worldgeom.js parked
    props keep the same rule (none on these streets);
  - the roads' classes are read: every avenue (class "arterial") and the local streets carry cars both ways (the
    two-tier grid's locals are its street network; not one whose bend is too tight for its lanes), and the city is alive: cars within 420 m of the spawn and across the
    city at midday, fewer at night, the drawn caps never exceeded near any of the sample spots;
  - buses: the doc's bus loops run, every stop on an avenue is served, buses are out at midday and stop at the stops;
  - it stays cheap: create(), parked() and at() within their budgets; over two minutes few samples stand still and no
    two cars overlap.
Skipped without node or the fixture. Stdlib only."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
FIXTURE = os.path.join(ROOT, "tests", "fixtures", "commons_v5.json.gz")

HARNESS = r"""
import fs from "fs";
import zlib from "zlib";
const root = %(root)s;
globalThis.window = {HQV: {}};
for (const f of ["world", "citylife", "traffic", "worldgeom"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const THREE = await import(root + "/games/vendor/three-module.js");
const H = window.HQV, WD = H.world, L = H.cityLife, T = H.traffic, G = H.worldgeom, out = {};
const doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/commons_v5.json.gz")).toString("utf8"));
const W = WD.pack(doc);
const HR = 36e5, NOON = Date.UTC(2026, 9, 26, 13), NIGHT = Date.UTC(2026, 9, 26, 3);

// ---- parked cars ----
// (the world's own indexes first: the page has built them, with its terrain, before the street is drawn)
WD.blockedAt(W, 0, 0); WD.groundAt(W, 0, 0); WD.surfaceAt(W, 0, 0); L.signals(W); L.facts(W);
let t0 = Date.now();
const P = L.parked(W), B = L.bays(W);
out.parkMs = Date.now() - t0;
const SG = L.signals(W), F = L.facts(W), lanes = T.lanes(W, 5), byId = {};
lanes.forEach(function(l){ byId[l.id] = l; });
const doors = (W.lots || []).filter(function(l){ return l.door; }).map(function(l){ return {x: l.door[0]/100, z: l.door[2]/100}; });
out.park = {n: P.length, bays: B.length, kerb: 0, lane: 0, surface: 0, solid: 0, box: 0, stop: 0, door: 0};
P.forEach(function(c){
  if(!c.bay){ out.park.kerb++; const l = byId[c.edge], n = WD.nearestRoad(W, c.x, c.z, 20); if(!l || !n || n.dist - T.SPEC.car.wid/2 < (l.cars ? l.carOff + T.SPEC.car.wid/2 : 0)) out.park.lane++; return; }
  const s = Math.sin(c.yaw), co = Math.cos(c.yaw);
  [[-2.2, -0.95], [-2.2, 0.95], [2.2, -0.95], [2.2, 0.95], [0, 0]].forEach(function(q){
    const x = c.x + s*q[0] + co*q[1], z = c.z + co*q[0] - s*q[1], k = WD.surfaceAt(W, x, z);
    if(k === "road" || k === "sidewalk" || k === "lot" || k === "site" || k === "water") out.park.surface++;
    if(WD.blockedAt(W, x, z)) out.park.solid++;
  });
  if(Object.keys(SG).some(function(id){ return Math.hypot(SG[id].x - c.x, SG[id].z - c.z) < SG[id].r + 2; })) out.park.box++;
  if(F.stopDist(c.x, c.z) < 10) out.park.stop++;
  if(doors.some(function(d){ return Math.hypot(d.x - c.x, d.z - c.z) < 3; })) out.park.door++;
});
let wgParked = 0;
for(let tx = -10; tx <= 10; tx++) for(let tz = -10; tz <= 10; tz++) wgParked += G.props(W, tx, tz).parked.length;
out.wgParked = wgParked;

// ---- the traffic ----
t0 = Date.now();
const sim = T.create(WD.docOf(W), {tier: 5, seed: W.id, W: W, local: 0});
out.createMs = Date.now() - t0;
out.info = sim.info();
const E = {};
W.edges.forEach(function(e){ E[e.id] = e; });
out.driven = {arterial: [0, 0], local: [0, 0]};
lanes.forEach(function(l){ const c = E[l.id] && E[l.id].cls; if(out.driven[c]){ out.driven[c][1]++; if(l.cars) out.driven[c][0]++; } });
function cars(ms, x, z, r){ return sim.at(ms, {x: x, z: z}, r).filter(function(v){ return v.kind === "car"; }); }
const spots = [[0, 20], [600, 600], [-900, 300], [1200, -800], [-400, -1300], [300, 1500]];
out.near = {noon: spots.map(function(p){ return cars(NOON, p[0], p[1], 420).length; }), night: spots.map(function(p){ return cars(NIGHT, p[0], p[1], 420).length; })};
out.city = {noon: cars(NOON, 0, 0, 1e9).length, night: cars(NIGHT, 0, 0, 1e9).length};
out.peak = 0;
[8.5, 13, 18].forEach(function(h){ spots.forEach(function(p){
  const by = {};
  sim.at(Date.UTC(2026, 9, 26) + h*HR, {x: p[0], z: p[1]}, 420).forEach(function(v){ const k = v.kind === "car" ? (v.type || "car") : v.kind; by[k] = (by[k] || 0) + 1; });
  Object.keys(by).forEach(function(k){ if(T.CAP[k] != null) out.peak = Math.max(out.peak, by[k]/T.CAP[k]); });
}); });
t0 = Date.now();
for(let i = 0; i < 200; i++) sim.at(NOON + i*16, {x: 0, z: 20}, 420);
out.atMs = (Date.now() - t0)/200;
// two minutes at midday: standing still, and overlaps
let samples = 0, still = 0, overlap = 0;
for(let k = 0; k < 120; k++){
  const a = cars(NOON + k*1000, 0, 0, 1e9), b = {};
  cars(NOON + k*1000 + 1000, 0, 0, 1e9).forEach(function(v){ b[v.id] = v; });
  a.forEach(function(v){ const q = b[v.id]; if(!q) return; samples++; if(Math.hypot(q.x - v.x, q.z - v.z) < 0.2) still++; });
  // (each body as tests/test_traffic_lights.py measures them: a scooter's or bike's its own, the rest a car's)
  const g = {};
  a.forEach(function(v){ const key = Math.floor(v.x/8) + ":" + Math.floor(v.z/8); (g[key] = g[key] || []).push(v); });
  a.forEach(function(v){ for(let i = -1; i <= 1; i++) for(let j = -1; j <= 1; j++) (g[(Math.floor(v.x/8) + i) + ":" + (Math.floor(v.z/8) + j)] || []).forEach(function(u){
    if(u.id > v.id && obb(v, u)) overlap++; }); });
}
function body(v){ const S0 = T.SPEC[v.type] || T.SPEC.car, S = S0.len < T.SPEC.car.len ? S0 : T.SPEC.car; return {x: v.x, y: v.y, z: v.z, yaw: v.yaw, len: S.len, wid: S.wid}; }
function obb(p, q){
  const a = body(p), b = body(q);
  if(Math.abs((a.y || 0) - (b.y || 0)) > 3) return false;
  const ax = [Math.sin(a.yaw), Math.cos(a.yaw)], ay = [ax[1], -ax[0]], bx = [Math.sin(b.yaw), Math.cos(b.yaw)], by = [bx[1], -bx[0]], d = [b.x - a.x, b.z - a.z];
  function r(u, x, y, Ln, Wd){ return Math.abs(x[0]*u[0] + x[1]*u[1])*Ln/2 + Math.abs(y[0]*u[0] + y[1]*u[1])*Wd/2; }
  return [ax, ay, bx, by].every(function(u){ return Math.abs(d[0]*u[0] + d[1]*u[1]) <= r(u, ax, ay, a.len, a.wid) + r(u, bx, by, b.len, b.wid); });
}
out.still = still/Math.max(1, samples); out.overlap = overlap;

// ---- buses ----
const stops = (W.sites || []).filter(function(s){ return s.kind === "busstop"; });
out.bus = {stops: stops.length, lines: sim.lines().filter(function(l){ return l.kind === "bus"; }).map(function(l){ return {id: l.id, stops: l.stops.length, vehicles: l.vehicles, lap: l.lap}; }),
           served: stops.filter(function(s){ return sim.stopsNear(s.x/100, s.z/100, 5).some(function(n){ return n.id === s.id && n.lines.length; }); }).length,
           out: sim.at(NOON, {x: 0, z: 0}, 1e9).filter(function(v){ return v.kind === "bus"; }).length,
           onAvenue: 0, off: 0};
(doc.layers.transit.lines || []).forEach(function(l){
  const P2 = l.path || [];
  for(let i = 1; i < P2.length; i++){
    const e = doc.layers.roads.edges.filter(function(e){ return (e.a === P2[i - 1] && e.b === P2[i]) || (e.b === P2[i - 1] && e.a === P2[i]); })[0];
    if(e && e["class"] === "arterial") out.bus.onAvenue++; else out.bus.off++;
  }
});
// a bus stands at a stop: the next arrival there, and the bus at the stop then
const s0 = stops[0], arr = sim.nextArrival(s0.id, NOON);
out.bus.arrival = arr ? {line: arr.line, wait: arr.arrive - NOON} : null;
if(arr){
  const at = (arr.arrive + arr.depart)/2, near = sim.at(at, {x: s0.x/100, z: s0.z/100}, 25).filter(function(v){ return v.kind === "bus"; });
  out.bus.atStop = near.length ? {dist: Math.hypot(near[0].x - s0.x/100, near[0].z - s0.z/100), speed: near[0].speed} : null;
}

// ---- the street view: the bays' paving and the cars in them, solid ----
const scene = new THREE.Scene(), V = T.street(THREE, scene, W, {});
const c0 = P.filter(function(c){ return c.bay; })[0];
V.update(NOON, {x: c0.x, z: c0.z});
out.view = {calls: V.drawCalls(), info: V.info(), car: V.blocked(c0.x, c0.z), beside: V.blocked(c0.x + Math.cos(c0.yaw)*2.5, c0.z - Math.sin(c0.yaw)*2.5)};
V.dispose();
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE and os.path.exists(FIXTURE), "node or the v5 fixture missing")
class TrafficV5(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "--input-type=module", "-e", HARNESS % {"root": json.dumps(ROOT)}], capture_output=True, text=True, timeout=900)
        if r.returncode:
            raise AssertionError(r.stderr[-4000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_no_parked_car_in_a_running_lane(self):
        p = self.o["park"]
        self.assertGreater(p["n"], 1000)
        self.assertGreaterEqual(p["bays"], p["n"] - p["kerb"])
        self.assertEqual(p["kerb"], 0, "a 6.5 m street has no room for a parking lane beside two running lanes")
        for k in ("lane", "surface", "solid", "box", "stop", "door"):
            self.assertEqual(p[k], 0, k)
        self.assertEqual(self.o["wgParked"], 0)

    def test_classes_read_every_street_driven(self):
        d = self.o["driven"]
        self.assertGreater(d["arterial"][1], 100)
        self.assertEqual(d["arterial"][0], d["arterial"][1])
        self.assertGreater(d["local"][1], 800)
        # (all but the ones whose bends are too tight for their lanes: a cul-de-sac's loop)
        self.assertGreater(d["local"][0], 0.85 * d["local"][1])
        self.assertEqual(self.o["info"]["errors"], [])

    def test_the_city_is_alive(self):
        n = self.o["near"]
        self.assertGreaterEqual(n["noon"][0], 15, "cars within 420 m of the spawn at midday")
        self.assertGreaterEqual(min(n["noon"]), 5)
        self.assertGreater(self.o["city"]["noon"], 500)
        self.assertLess(self.o["city"]["night"], self.o["city"]["noon"])
        self.assertLessEqual(self.o["peak"], 1, "never more of a kind within 420 m than its drawn cap")
        self.assertLess(self.o["still"], 0.4)
        self.assertEqual(self.o["overlap"], 0)

    def test_buses_run_on_the_avenues(self):
        b = self.o["bus"]
        self.assertGreaterEqual(b["stops"], 12)
        self.assertGreaterEqual(len(b["lines"]), 1)
        self.assertEqual(b["served"], b["stops"])
        self.assertEqual(b["off"], 0, "a bus loop keeps to the avenues")
        self.assertGreater(b["out"], 0)
        for l in b["lines"]:
            self.assertGreater(l["vehicles"], 0, l)
        self.assertIsNotNone(b["arrival"])
        self.assertIsNotNone(b["atStop"])
        self.assertLess(b["atStop"]["dist"], 30)
        self.assertLess(b["atStop"]["speed"], 0.5)

    def test_budgets(self):
        self.assertLess(self.o["createMs"], 4000)
        self.assertLess(self.o["parkMs"], 3000)
        self.assertLess(self.o["atMs"], 2)

    def test_the_street_view(self):
        v = self.o["view"]
        self.assertLessEqual(v["calls"], 5)
        self.assertGreater(v["info"]["baysShown"], 0)
        self.assertTrue(v["car"], "a car in a bay is solid")


if __name__ == "__main__":
    unittest.main()
