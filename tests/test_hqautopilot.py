"""The autopilot (games/hqautopilot.js): a car round a route through rideMove's own handling (the steering eases
in at 6/s, the yaw rate is steer x 1.9 rad/s), stopping for what is in the lane and at the end; a car with no route
keeps to its road, straight on at a junction; a boat round an island to a buoy and a helicopter from the ground to a
landing, both through their real physics (games/hqboat.js, games/hqheli.js). And the wiring in games/hq3d.js."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")


def read(*p):
    with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
        return f.read()


HARNESS = r"""
const fs = require('fs'), path = require('path'), R0 = process.argv[1];
global.window = {HQV: {}};
['hqnav', 'hqautopilot', 'hqheli', 'hqboat'].forEach(f => eval(fs.readFileSync(path.join(R0, 'games', f + '.js'), 'utf8')));
const A = window.HQV.hqAutopilot, dt = 1/60, out = {};
function wrap(a){ while(a > Math.PI) a -= 2*Math.PI; while(a < -Math.PI) a += 2*Math.PI; return a; }
// rideMove's handling, as games/hq3d.js: thr pulls (acc, less near the top) or brakes (14 m/s^2 at full), coasting 3 m/s^2
function car(route, o, obstacle){
  const P = A.plan(route), c = {x: route[0], z: route[1], yaw: Math.atan2(route[2] - route[0], route[3] - route[1]), speed: 0, steer: 0};
  let t = 0, maxV = 0, maxOff = 0, done = false, minGap = Infinity, rev = false;
  while(t < 120 && !done){
    const ob = obstacle ? obstacle(t) : null;
    let ahead = Infinity;
    if(ob){ const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw), dx = ob.x - c.x, dz = ob.z - c.z, a = dx*fx + dz*fz;
      if(a > 0 && Math.abs(dx*fz - dz*fx) < 3.4) ahead = a - 2; minGap = Math.min(minGap, Math.hypot(dx, dz)); }
    const d = A.drive(P, c, Object.assign({vmax: 18, yawRate: 1.9, ahead: ahead}, o || {}));
    if(d.thr > 0) c.speed = Math.min(60, c.speed + 5*Math.max(0.25, 1 - c.speed/60)*d.thr*dt);
    else if(d.thr < 0) c.speed = c.speed > 0 ? Math.max(0, c.speed + 14*d.thr*dt) : c.speed - 4*dt;
    else c.speed = c.speed > 0 ? Math.max(0, c.speed - 3*dt) : 0;
    if(c.speed < 0) rev = true;
    c.steer += (d.steer - c.steer)*(1 - Math.exp(-6*dt));
    c.yaw = wrap(c.yaw + c.steer*Math.min(1, Math.abs(c.speed)/2.5)*1.9*dt);
    c.x += Math.sin(c.yaw)*c.speed*dt; c.z += Math.cos(c.yaw)*c.speed*dt;
    maxV = Math.max(maxV, c.speed); maxOff = Math.max(maxOff, d.off); done = d.done; t += dt;
  }
  const end = A.pointAt(P, P.len);
  return {t: t, done: done, maxV: maxV, maxOff: maxOff, endD: Math.hypot(c.x - end.x, c.z - end.z), minGap: minGap, rev: rev};
}
// an L: 150 m along +z, a right-angle turn, 100 m along +x
out.L = car([0, 0, 0, 75, 0, 150, 50, 150, 100, 150]);
// an S-bend
{ const s = []; for(let i = 0; i <= 60; i++){ const z = i*5; s.push(Math.sin(z/45)*25, z); } out.S = car(s); }
// the corner speed: with an easy 'lat' it takes the L's corner slower than with a hard one
{ let vs = []; for(const lat of [3, 8]){ const P = A.plan([0, 0, 0, 75, 0, 150, 50, 150, 100, 150]);
    P.s = 146; vs.push(A.drive(P, {x: 1.8, z: 146, yaw: 0, speed: 15}, {vmax: 30, lat: lat}).v); } out.cornerV = vs; }
// a car stopped in the lane 80 m ahead: it stops behind it, never into it and never backing up
out.blocked = car([0, 0, 0, 200], {}, t => ({x: 1.8, z: 80}));
out.blockedHeld = (() => { const P = A.plan([0, 0, 0, 200]); P.s = 60; return A.drive(P, {x: 1.8, z: 75, yaw: 0, speed: 0}, {ahead: 3}); })();
// cruising with no route: a T, straight on at the junction rather than the side road
{ const cm = v => Math.round(v*100), N = {a: [0, 0], b: [0, 100], c: [0, 220], d: [100, 100]};
  const edge = (a, b) => ({a: a, b: b, cls: 'street', pts: Int32Array.from([cm(N[a][0]), 0, cm(N[a][1]), cm((N[a][0] + N[b][0])/2), 0, cm((N[a][1] + N[b][1])/2), cm(N[b][0]), 0, cm(N[b][1])])});
  const W = {nodes: Object.keys(N).map(k => ({id: k, x: cm(N[k][0]), z: cm(N[k][1])})), edges: [edge('a', 'b'), edge('b', 'c'), edge('b', 'd')]};
  const G = window.HQV.hqnav.graph(W, 5), pts = A.cruise(G, 0.5, 20, 0, 150);
  out.cruise = {last: [pts[pts.length - 2], pts[pts.length - 1]], maxX: Math.max(...pts.filter((v, i) => i % 2 === 0))};
  const back = A.cruise(G, 0.5, 200, Math.PI, 150);              // facing -z from the far end: down to a, then back (a dead end)
  out.cruiseBack = {first: [back[2], back[3]], len: back.length/2}; }
// a helicopter: off the ground, over a 60 m hill, 600 m away, down onto the spot
{ const H = window.HQV.hqheli, st = H.newState('heli', 0, 0, 0, 0), to = {x: 400, z: 450};
  const floor = (x, z) => Math.hypot(x - 200, z - 220) < 60 ? 60 : 0;
  let t = 0, minClear = Infinity, phases = {}, landed = null;
  while(t < 180){
    const a = A.heli(st, to, {floor: floor, alt: 40, top: H.VEHICLES.heli.top, acc: H.VEHICLES.heli.acc});
    phases[a.phase] = 1;
    const ev = H.step(st, {fwd: a.fwd, turn: a.turn, lift: a.lift}, dt, {floor: floor});
    if(!st.ground) minClear = Math.min(minClear, st.y - floor(st.x, st.z));
    if(ev.some(e => e.type === 'bump')) phases.bump = 1;
    if(ev.some(e => e.type === 'land') && t > 5){ landed = Math.hypot(st.x - to.x, st.z - to.z); break; }
    t += dt;
  }
  out.heli = {landed: landed, t: t, phases: phases, minClear: minClear}; }
// a jet ski: an island between it and the buoy; it goes round, never aground, and stops at the buoy
{ const B = window.HQV.hqboat, st = B.newState('jetski', 0, 0, 0), to = {x: 0, z: 300};
  const land = (x, z) => Math.hypot(x, z - 150) < 50;
  const sea = {land: land, docks: [], y: 0, wave: () => 0};
  let t = 0, aground = false, done = false, minD = Infinity;
  while(t < 120 && !done){
    const a = A.boat({x: st.x, z: st.z, yaw: st.yaw, speed: st.speed}, to, {top: B.VEHICLES.jetski.top, land: land});
    B.step(st, {thr: a.thr, steer: a.steer}, dt, sea);
    if(land(st.x, st.z)) aground = true;
    minD = Math.min(minD, Math.hypot(st.x, st.z - 150));
    done = a.done; t += dt;
  }
  out.boat = {done: done, t: t, aground: aground, endD: Math.hypot(st.x - to.x, st.z - to.z), minD: minD}; }
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
class Autopilot(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", HARNESS, ROOT], capture_output=True, text=True, timeout=120)
        if r.returncode:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_follows_a_route_and_stops_at_the_end(self):
        for k in ("L", "S"):
            o = self.o[k]
            self.assertTrue(o["done"], k)
            self.assertLess(o["endD"], 3, k)
            self.assertLess(o["maxOff"], 1.5, "%s: keeps to its lane" % k)
            self.assertLessEqual(o["maxV"], 18.3, k)
            self.assertFalse(o["rev"], k)

    def test_slows_for_corners(self):
        easy, hard = self.o["cornerV"]
        self.assertLess(easy, hard)
        self.assertLess(easy, 10)

    def test_stops_for_whats_in_the_lane(self):
        b = self.o["blocked"]
        self.assertGreater(b["minGap"], 4, "never into it")
        self.assertFalse(b["rev"])
        h = self.o["blockedHeld"]
        self.assertEqual(h["thr"], 0)
        self.assertEqual(h["v"], 0)

    def test_cruise_keeps_to_the_road_straight_on(self):
        c = self.o["cruise"]
        self.assertLess(abs(c["last"][0]), 1, "straight on, not the side road")
        self.assertLess(c["maxX"], 1)
        self.assertGreater(c["last"][1], 200)
        self.assertGreater(self.o["cruiseBack"]["len"], 4)

    def test_helicopter_takes_off_flies_over_the_hill_and_lands(self):
        h = self.o["heli"]
        self.assertIsNotNone(h["landed"], h)
        self.assertLess(h["landed"], 12)
        self.assertNotIn("bump", h["phases"])
        self.assertGreater(h["minClear"], -0.01)
        for p in ("takeoff", "cruise", "landing"):
            self.assertIn(p, h["phases"])

    def test_boat_goes_round_the_island(self):
        b = self.o["boat"]
        self.assertTrue(b["done"], b)
        self.assertFalse(b["aground"])
        self.assertLess(b["endD"], 10)
        self.assertGreater(b["minD"], 53, "a margin off the coast")


class Wiring(unittest.TestCase):
    def test_every_kind_of_vehicle_is_wired(self):
        hq = read("games", "hq3d.js")
        self.assertIn('e.code === "KeyI" && ride', hq)
        for move in ("function rideMove", "function tankMove", "function boatMove", "function heliMove"):
            body = hq[hq.index(move):hq.index("\n  }\n", hq.index(move))]
            self.assertIn("ride.auto", body, move)
            self.assertIn('apOff("Autopilot off: you have it")', body, move + ": your controls take over")
        self.assertIn('if(k === "plane") return planeKey("KeyK")', hq)
        self.assertIn("I autopilot", hq)
        self.assertIn("w.navGraph = function", read("games", "hqcity3d.js"))
        self.assertIn('"hqautopilot"', read("ui", "app", "22-hq.js"))


if __name__ == "__main__":
    unittest.main()
