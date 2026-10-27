"""Buses and trams you ride (games/hqcoach.js, HQ 3.15, docs/plans/transport-revamp.md 3.2).

node loads traffic.js and hqcoach.js against a stub `window`: the seat table traffic.js shares with the models
(31 bus seats 2+2 with a rear row of 5, 48 tram seats 2+1 in facing bays) lies inside the bodies and clear of the
doors, the bay and each other; occupied() takes hqCommute's answer (checked) or a seeded fallback from the load;
the destination atlas lays its cells out without overlap; Calm keeps the door and kneel poses with no motion; and
the view (against the vendored three.js, on the synthetic hub city) keeps its draw-call budgets. Skipped without
node. Stdlib only."""
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
for (const f of ["traffic", "hqcoach"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const THREE = await import(root + "/games/vendor/three-module.js");
const H = window.HQV, T = H.traffic, K = H.hqCoach, city = require(root + "/tests/fixtures/traffic_city.js"), out = {};

// ---- the seat table ----
function rectsOverlap(a, b){ return Math.abs(a.x - b.x) < 0.44 - 1e-6 && Math.abs(a.z - b.z) < 0.44 - 1e-6; }
(function(){
  // [3.22.3] the bus's doors are on the kerb side: model-local +x is the left, the kerb is SIDE x the right, so the
  // doors are where x*DS > 0 (DS = -SIDE: the left with traffic on the left), the bay and the cab on the other side
  var B = T.SEATS.bus, R = T.SEATS.tram, D = T.DOORS, e = {bus: [], tram: []}, DS = -T.SIDE;
  B.forEach(function(s, i){
    if(Math.abs(s.x) + 0.22 > 1.2) e.bus.push(["wall", i]);
    if(Math.abs(s.z) + 0.25 > 5.95) e.bus.push(["end", i]);
    if(s.x*DS > 0) D.bus.forEach(function(z){ if(Math.abs(s.z - z) < 0.6 + 0.22) e.bus.push(["door", i]); });
    if(s.x*DS < 0 && s.z > -0.9 && s.z < 1.4) e.bus.push(["bay", i]);
    B.forEach(function(t, j){ if(j > i && rectsOverlap(s, t)) e.bus.push(["overlap", i, j]); });
    if(s.z > 4.6 && s.x*DS < 0) e.bus.push(["cab", i]);
  });
  R.forEach(function(s, i){
    var az = Math.abs(s.z);
    if(Math.abs(s.x) + 0.22 > 1.25) e.tram.push(["wall", i]);
    if(az < 0.5 + 0.22 || az > 12.0 - 0.22) e.tram.push(["joint or cab", i]);
    D.tram.forEach(function(z){ if(Math.abs(s.z - z) < 0.65 + 0.22) e.tram.push(["door", i]); });
    R.forEach(function(t, j){ if(j > i && rectsOverlap(s, t)) e.tram.push(["overlap", i, j]); });
  });
  // the rear section is the front one turned round
  var sym = true;
  for(var i = 0; i < 24; i++){ var a = R[i], b = R[i + 24]; if(Math.abs(a.x + b.x) > 1e-9 || Math.abs(a.z + b.z) > 1e-9 || Math.abs(Math.cos(a.yaw + Math.PI) - Math.cos(b.yaw)) > 1e-9) sym = false; }
  // facing bays: every forward-facing row has a backward-facing row ahead of it within 1.5 m
  var rows = {};
  R.slice(0, 24).forEach(function(s){ rows[s.z.toFixed(2)] = s.yaw; });
  var zs = Object.keys(rows).map(Number).sort(function(a, b){ return a - b; }), facing = 0;
  zs.forEach(function(z, k){ if(rows[z.toFixed(2)] === 0 && zs[k + 1] != null && rows[zs[k + 1].toFixed(2)] !== 0 && zs[k + 1] - z < 1.5) facing++; });
  out.seats = {bus: B.length, tram: R.length, stands: [T.STANDS.bus.length, T.STANDS.tram.length], errs: e, sym: sym, bays: facing,
               perRow: R.slice(0, 24).filter(function(s){ return s.z === R[0].z; }).length,
               windows: [B.filter(function(s){ return s.window; }).length, R.filter(function(s){ return s.window; }).length],
               priority: [B.filter(function(s){ return s.priority; }).length, R.filter(function(s){ return s.priority; }).length],
               keys: Object.keys(B[0]).sort(), rear5: B.filter(function(s){ return s.z === -5.4; }).length,
               standIn: T.STANDS.bus.every(function(p){ return Math.abs(p.x) < 1.1 && Math.abs(p.z) < 5.8; }) && T.STANDS.tram.every(function(p){ return Math.abs(p.x) < 1.2 && Math.abs(p.z) < 12; })};
})();

// ---- occupied(): hqCommute's answer (checked), else the seeded fallback ----
(function(){
  var v = {id: "tT1.0", line: "T1", trip: 12, load: 0.5};
  var f1 = K.occupied("tram", v, 1e6, 7), f2 = K.occupied("tram", v, 1e6, 7), f3 = K.occupied("tram", {id: "tT1.1", trip: 12, load: 0.5}, 1e6, 7);
  var full = K.occupied("bus", {id: "bB1.0", trip: 1, load: 1.15}, 0, 7), light = K.occupied("bus", {id: "bB1.0", trip: 1, load: 0.08}, 0, 7);
  var calls = [];
  H.hqCommute = {occupied: function(mode, vid, tripKey, seats, standing, ms, seed){ calls.push([mode, vid, tripKey, seats, standing, ms, seed]); return {seats: [0, 5, 47, 99, 5, -1], standing: [2, 2, 40]}; }};
  var c = K.occupied("tram", v, 5000, 9), figs = K.figures("tram", c);
  delete H.hqCommute;
  out.occ = {det: JSON.stringify(f1) === JSON.stringify(f2), differ: JSON.stringify(f1) !== JSON.stringify(f3), half: f1.seats.length, stand0: f1.standing.length,
             full: [full.seats.length, full.standing.length], light: light.seats.length, sorted: f1.seats.every(function(x, i){ return !i || f1.seats[i-1] < x; }),
             commute: c, calls: calls, figs: figs.map(function(f){ return [f.pose, f.seat, f.x, f.z]; }),
             seatXZ: [[T.SEATS.tram[0].x, T.SEATS.tram[0].z], [T.SEATS.tram[5].x, T.SEATS.tram[5].z], [T.SEATS.tram[47].x, T.SEATS.tram[47].z], [T.STANDS.tram[2].x, T.STANDS.tram[2].z]]};
})();

// ---- toWorld on a tram's two sections ----
(function(){
  var v = {x: 0, y: 0, z: 0, yaw: 0, parts: [{x: 0, y: 0, z: 7, yaw: 0}, {x: 0, y: 0, z: -7, yaw: 0}]};
  var a = K.toWorld("tram", v, {x: 0.5, y: 0.45, z: 3, yaw: 0}), b = K.toWorld("tram", v, {x: 0.5, y: 0.45, z: -3, yaw: Math.PI});
  var bent = {x: 0, y: 0, z: 0, yaw: 0, parts: [{x: 0, y: 0, z: 7, yaw: 0.2}, {x: 0, y: 0, z: -7, yaw: -0.2}]}, c = K.toWorld("tram", bent, {x: 0, y: 0, z: 7});
  out.world = {a: [a.x, a.y, a.z], b: [b.x, b.z, b.yaw], bent: [c.x, c.z]};
})();

// ---- the atlas ----
(function(){
  var ent = [{short: "T1", to: "Harbour Street"}, {short: "T1", to: "Harbour Street"}, {short: "B2", to: "A Very Long Destination Name Indeed That Goes On"}];
  for(var i = 0; i < 40; i++) ent.push({short: "B" + (i %% 5), to: "Stop " + i});
  var A = K.atlasLayout(ent, {w: 1024}), A2 = K.atlasLayout(ent, {w: 1024}), overl = 0, inside = true, uv = true;
  var all = A.cells.concat([A.white]);
  all.forEach(function(c, i){
    if(c.x < 0 || c.y < 0 || c.x + c.w > A.w || c.y + c.h > A.h) inside = false;
    if(!(c.u0 >= 0 && c.u1 <= 1 && c.u0 < c.u1 && c.v0 >= 0 && c.v1 <= 1 && c.v0 < c.v1)) uv = false;
    all.forEach(function(d, j){ if(j > i && c.x < d.x + d.w && d.x < c.x + c.w && c.y < d.y + d.h && d.y < c.y + c.h) overl++; });
  });
  out.atlas = {n: A.cells.length, h: A.h, w: A.w, pow2: (A.h & (A.h - 1)) === 0, overl: overl, inside: inside, uv: uv, det: JSON.stringify(A) === JSON.stringify(A2),
               white: [A.white.x, A.white.y], first: A.cells[0].text, long: A.cells[1].text, maxLen: Math.max.apply(null, A.cells.map(function(c){ return c.text.length; })),
               empty: K.atlasLayout([]).cells.length, max: K.MAX_CHARS};
})();

// ---- Calm: pose only ----
out.calm = {open: [K.doorOpen(0.3, true), K.doorOpen(0.7, true), K.doorOpen(0.3, false) > 0 && K.doorOpen(0.3, false) < 1],
            kneel: [K.kneel("bus", 0.1, true), K.kneel("bus", 0, true), K.kneel("tram", 1, false), K.kneel("bus", 1, false)]};

// ---- the view: budgets, focus, hide, stop requests, shots ----
(function(){
  var sim = T.create(city(1, 7, true), {tier: 5, seed: 7}), sounds = [], calm = false, placed = {};
  // [sound] every sound but the stop bell carries its place and kind
  var V = K.view({THREE: THREE}, sim, {sfx: function(n, o){ sounds.push(n); var p = o && o.pos, k = n + ":" + (o && o.kind) + ":" + (p && isFinite(p.x) && isFinite(p.y) && isFinite(p.z) ? "pos" : "none");
                                                              placed[k] = (placed[k] || 0) + 1; }, night: function(){ return true; }, calm: function(){ return calm; }});
  var tram = V.services.tram.vehicles(1e6)[0], worst = {far: 0, near: 0, people: 0, total: 0, tris: 0};
  V.focus(tram.id);
  for(var t = 1e6; t < 1e6 + 900e3; t += 1500){
    var me = V.services.tram.vehicles(t).filter(function(v){ return v.id === tram.id; })[0];
    V.update(t, 1.5, {x: me.x, y: 0, z: me.z});
    var by = V.drawCallsBy();
    worst.far = Math.max(worst.far, by.far); worst.near = Math.max(worst.near, by.near); worst.people = Math.max(worst.people, by.people);
    worst.total = Math.max(worst.total, V.drawCalls()); worst.tris = Math.max(worst.tris, V.triangles());
  }
  var hidden = Object.keys(V.hide());
  var req = V.requestStop(tram.id), soundsAfter = sounds.slice(-1)[0];
  // under Calm the door leaves stand open or shut, never part way
  calm = true;
  var doorsMoving = null;
  for(var t2 = 1e6; t2 < 1e6 + 900e3 && doorsMoving == null; t2 += 100){
    var v2 = V.services.tram.vehicles(t2).filter(function(v){ return v.id === tram.id; })[0];
    if(v2.doors > 0.2 && v2.doors < 0.8) doorsMoving = t2;
  }
  var poses = [];
  if(doorsMoving != null){
    var v3 = V.services.tram.vehicles(doorsMoving).filter(function(v){ return v.id === tram.id; })[0];
    V.update(doorsMoving, 0.1, {x: v3.x, y: 0, z: v3.z});
    var dm = V.group.children.filter(function(m){ return m.name === "hqcoach-near-doors" && m.visible; })[0], m4 = new THREE.Matrix4(), p = new THREE.Vector3();
    dm.getMatrixAt(0, m4); p.setFromMatrixPosition(m4); poses.push([p.x, p.z]);
  }
  var shots = {};
  ["tram-interior", "bus-interior", "tram-stop", "tram-junction"].forEach(function(n){ shots[n] = !!V.tools.shotCam(n); });
  out.view = {worst: worst, hidden: hidden, focus: tram.id, req: req, bell: soundsAfter, sounds: sounds.filter(function(v, i, a){ return a.indexOf(v) === i; }).sort(),
              calmDoors: doorsMoving != null, shots: shots, atlas: V.atlas().cells.length, placed: Object.keys(placed).sort()};
  V.dispose();
})();
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
class Coach(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        res = subprocess.run([NODE, "--input-type=module", "-e", HARNESS % {"root": json.dumps(ROOT)}], capture_output=True, text=True, timeout=600)
        if res.returncode != 0:
            raise AssertionError("node harness failed:\n" + res.stderr[-4000:])
        cls.r = json.loads(res.stdout.strip().splitlines()[-1])

    def test_seat_counts(self):
        s = self.r["seats"]
        self.assertEqual(s["bus"], 31, "a 12 m bus: 31 seats")
        self.assertEqual(s["tram"], 48, "a 27 m tram: 48 seats")
        self.assertEqual(s["rear5"], 5, "the bus's rear row of 5")
        self.assertEqual(s["perRow"], 3, "2+1 on the tram")
        self.assertEqual(s["bays"], 4, "four facing bays a section")
        self.assertEqual(s["keys"], sorted(["x", "y", "z", "yaw", "window", "priority"]))
        self.assertGreater(min(s["windows"]), 10)
        self.assertGreater(min(s["priority"]), 3)

    def test_seats_inside_the_body(self):
        s = self.r["seats"]
        self.assertEqual(s["errs"], {"bus": [], "tram": []}, "inside the walls, clear of the doors, the bay, the cab and each other")
        self.assertTrue(s["sym"], "the tram's rear section is its front one turned round")
        self.assertTrue(s["standIn"])

    def test_occupied_mapping(self):
        o = self.r["occ"]
        self.assertTrue(o["det"], "the same passengers for everyone")
        self.assertTrue(o["differ"], "another vehicle, other passengers")
        self.assertEqual(o["half"], 24, "load 0.5 fills half the seats")
        self.assertEqual(o["stand0"], 0)
        self.assertEqual(o["full"], [31, 11], "1.15 fills every seat and standing spot")
        self.assertEqual(o["light"], 2)
        self.assertTrue(o["sorted"])
        # hqCommute's answer, checked: out-of-range and repeated indices dropped
        self.assertEqual(o["commute"], {"seats": [0, 5, 47], "standing": [2]})
        call = o["calls"][0]
        self.assertEqual(call[:5], ["tram", "tT1.0", 12, 48, 15])
        self.assertEqual(call[5:], [5000, 9])
        figs = o["figs"]
        self.assertEqual([f[0] for f in figs], ["sit", "sit", "sit", "stand"])
        self.assertEqual([f[1] for f in figs], [0, 5, 47, 50])
        for f, xz in zip(figs, o["seatXZ"]):
            self.assertEqual([f[2], f[3]], xz, "a figure sits on its seat")

    def test_to_world(self):
        w = self.r["world"]
        self.assertAlmostEqual(w["a"][0], 0.5)
        self.assertAlmostEqual(w["a"][1], 0.36 + 0.45)
        self.assertAlmostEqual(w["a"][2], 3)
        self.assertAlmostEqual(w["b"][1], -3)
        self.assertAlmostEqual(w["bent"][0], 0, 6)
        self.assertAlmostEqual(w["bent"][1], 7, 6, "a point on the front section rides with that section")

    def test_atlas_layout(self):
        a = self.r["atlas"]
        self.assertEqual(a["n"], 42, "one cell per line + terminus text")
        self.assertEqual(a["overl"], 0)
        self.assertTrue(a["inside"] and a["uv"] and a["pow2"] and a["det"])
        self.assertEqual(a["white"], [0, 0], "a white cell for plain colours")
        self.assertEqual(a["first"], "T1 Harbour Street")
        self.assertLessEqual(a["maxLen"], a["max"])
        self.assertTrue(a["long"].endswith("."), "long names are cut to fit")
        self.assertEqual(a["empty"], 0)

    def test_calm_is_pose_only(self):
        c = self.r["calm"]
        self.assertEqual(c["open"][:2], [0, 1])
        self.assertTrue(c["open"][2], "doors slide over 1.2 s without Calm")
        self.assertEqual(c["kneel"][:3], [0.06, 0, 0])
        self.assertAlmostEqual(c["kneel"][3], 0.06)

    def test_view(self):
        v = self.r["view"]
        w = v["worst"]
        self.assertLessEqual(w["far"], 3, "far additions: displays, bands, windows and passengers")
        self.assertLessEqual(w["near"], 12, "at most 3 near vehicles, 3 calls each")
        self.assertLessEqual(w["people"], 3)
        self.assertGreater(w["near"], 0)
        self.assertLess(w["tris"], 150000)
        self.assertIn(v["focus"], v["hidden"], "the focused vehicle is drawn in detail (traffic.view hides it)")
        self.assertTrue(v["req"])
        self.assertEqual(v["bell"], "stop-bell")
        for s in ("door", "hiss", "tram-bell"):
            self.assertIn(s, v["sounds"])
        # Sound PR B: each at its vehicle, with its spatial kind; the stop bell is yours and centred
        self.assertEqual(set(v["placed"]) - {"air-brake:bus:pos"},
                         {"door:door:pos", "hiss:door:pos", "tram-bell:bell:pos", "stop-bell:undefined:none"}, v["placed"])
        self.assertTrue(v["calmDoors"])
        self.assertEqual(v["shots"], {"tram-interior": True, "bus-interior": True, "tram-stop": True, "tram-junction": True})
        self.assertGreater(v["atlas"], 0)


class Source(unittest.TestCase):
    def test_house_rules(self):
        with open(os.path.join(ROOT, "games", "hqcoach.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertNotIn("Math.random", src)
        self.assertNotIn("innerHTML", src)
        self.assertNotIn("fetch(", src)
        self.assertNotIn("payFare", src)
        self.assertIsNone(re.search(r"\blet\b|\bconst\b|=>", src), "var-style JS")


if __name__ == "__main__":
    unittest.main()
