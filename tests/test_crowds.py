"""Crowds by place and time (HQ 3.21, city life workstream 5): games/npcsim.js over games/citylife.js.

Under node, on the @3 fixture (tests/fixtures/claude-hq@3.json.gz) packed by games/world.js: with the city life loaded,
shops and cafes are job places (shop staff 9-20, baristas 7-23 in shifts) and lunch goes to cafes and food shops; the
gathering spots fill and empty with the clock (terraces at lunch, never at 03:00; stops in the morning rush; the
school gate at 08:00 on a weekday, never on Sunday); Sunday's parade walks its route only from 15:00 to 16:30; and
all of it is a pure function of (world, seed, local ms). npcdraw draws the borrowed looks, children and seated
people. Skipped without node. Stdlib only."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

SCRIPT = r"""
var fs = require("fs"), zlib = require("zlib"), root = %(root)s;
global.window = {HQV: {}};
for (var f of ["world", "citylife", "npcsim", "npcdraw"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
var WD = window.HQV.world, CL = window.HQV.cityLife, S = window.HQV.npcSim, D = window.HQV.npcDraw, out = {};
var raw = zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/claude-hq@3.json.gz")).toString("utf8");
var W = WD.pack(JSON.parse(raw)), doc = WD.docOf(W), H = 36e5;
function at(day, h){ return Date.UTC(2026, 9, day, 0) + h*H; }        // 24 Saturday, 25 Sunday, 26 Monday (local ms)
var sim = S.create(doc, {tier: 5, grow: 0, seed: "crowds", world: W}), N = sim.population, ALL = {x: 0, z: 0}, BIG = 5000;
function count(rows){ var m = {}; rows.forEach(function(r){ m[r.crowd] = (m[r.crowd] || 0) + 1; }); return m; }

// jobs: who works at a shop or a cafe, at what hours; lunch at cafes and food shops
var tables = {}, rows = {}, placeTable = {};
sim.places.forEach(function(p){ placeTable[p.key] = p.table || p.kind; });
sim.residents.forEach(function(r){
  if(!r.job) return;
  tables[r.job.kind] = (tables[r.job.kind] || 0) + 1;
  if(r.job.kind === "retail" || r.job.kind === "cafe") rows[r.job.kind + ":" + r.job.job + ":" + r.job.from + "-" + r.job.to] = 1;
});
var day = Math.floor(at(26, 0)/S.DAY), lunch = {}, atShop = [0, 0];
sim.residents.forEach(function(r){
  if(!r.job) return;
  sim.plan(r.id, day).forEach(function(m){
    if(m.from === r.job.place && m.t0 >= 11.9*H && m.t0 < 12.5*H && m.to !== r.home) lunch[placeTable[m.to]] = (lunch[placeTable[m.to]] || 0) + 1;
  });
  if(r.job.kind === "retail" && r.job.from === 9 && r.job.to === 20){ atShop[1]++; if(sim.where(r.id, at(26, 11)).state === "work") atShop[0]++; }
});
var off = S.create(doc, {tier: 5, grow: 0, seed: "crowds", world: W, cityLife: false}), offKinds = {};
off.residents.forEach(function(r){ if(r.job) offKinds[r.job.kind] = 1; });
out.jobs = {tables: tables, rows: Object.keys(rows).sort(), lunch: lunch, atShop: atShop, offKinds: offKinds, offGather: off.gather(at(26, 12.5), ALL, BIG).length};

// the gathering spots by the clock
var T = {mon1230: at(26, 12.5), mon0300: at(26, 3), mon0800: at(26, 8), mon1510: at(26, 15.17), sun0800: at(25, 8), sun1500: at(25, 15.05),
         sun1530: at(25, 15.5), sun1629: at(25, 16.48), sun1440: at(25, 14.67), sun1640: at(25, 16.67), sat1530: at(24, 15.5), sat1600: at(24, 16), sat1000: at(24, 10), mon0700: at(26, 7)};
out.counts = {};
Object.keys(T).forEach(function(k){ out.counts[k] = count(sim.gather(T[k], ALL, BIG)); });
out.spots = {}; sim.spots().forEach(function(s){ out.spots[s.kind] = (out.spots[s.kind] || 0) + 1; });

// what they do: sit at terraces, children at the gate, standing at stops facing the road
var mon = sim.gather(T.mon1230, ALL, BIG), gate = sim.gather(T.mon0800, ALL, BIG).filter(function(r){ return r.crowd === "gate"; });
out.anim = {terraceSit: mon.filter(function(r){ return r.crowd === "terrace" && r.anim === "sit"; }).length,
            terrace: mon.filter(function(r){ return r.crowd === "terrace"; }).length,
            kids: gate.filter(function(r){ return r.size < 1; }).length, gate: gate.length,
            waitIdle: mon.filter(function(r){ return r.crowd === "wait" && r.anim === "idle"; }).length,
            lkOk: mon.every(function(r){ return r.lk >= 0 && r.lk < N && r.id >= N; })};
// the stop's people face the road: their facing points at a carriageway within 4 m
var faceRoad = 0, waits = mon.filter(function(r){ return r.crowd === "wait"; });
waits.forEach(function(r){
  for(var d = 0.5; d <= 4; d += 0.5) if(WD.surfaceAt(W, r.x + Math.sin(r.yaw)*d, r.z + Math.cos(r.yaw)*d) === "road"){ faceRoad++; break; }
});
out.anim.faceRoad = [faceRoad, waits.length];
// nobody in a building or in the water; only the market and the parade on a carriageway
var bad = {lot: 0, water: 0, road: 0, n: 0};
[T.mon1230, T.mon0800, T.sat1600, T.sat1000, T.sun1530].forEach(function(t){
  sim.gather(t, ALL, BIG).forEach(function(r){
    var sf = WD.surfaceAt(W, r.x, r.z); bad.n++;
    if(sf === "lot") bad.lot++;
    if(sf === "water") bad.water++;
    if(sf === "road" && r.crowd !== "market" && r.crowd !== "parade") bad.road++;
  });
});
out.where = bad;

// the parade: on its route, moving, only in its window
var ev = CL.events(W, T.sun1530).filter(function(e){ return e.kind === "parade"; })[0], route = {};
(ev ? ev.edges : []).forEach(function(id){ route[id] = 1; });
var p1 = sim.gather(T.sun1530, ALL, BIG).filter(function(r){ return r.crowd === "parade"; });
var p2 = sim.gather(T.sun1530 + 60000, ALL, BIG).filter(function(r){ return r.crowd === "parade"; }), moved = 0, byId = {};
p1.forEach(function(r){ byId[r.id] = r; });
p2.forEach(function(r){ var q = byId[r.id]; if(q && Math.hypot(q.x - r.x, q.z - r.z) > 1) moved++; });
var onRoute = p1.filter(function(r){ var n = WD.nearestRoad(W, r.x, r.z, 12); return n && route[n.edge] && n.dist <= n.carriage + 0.01; }).length;
out.parade = {n: p1.length, onRoute: onRoute, moved: moved, walking: p1.filter(function(r){ return r.anim === "walk"; }).length};

// determinism: a second sim on a freshly packed world, asked in the reverse order, agrees exactly; at() carries them
var W2 = WD.pack(JSON.parse(raw)), sim2 = S.create(WD.docOf(W2), {tier: 5, grow: 0, seed: "crowds", world: W2}), same = true, keys = Object.keys(T);
var first = {}; keys.forEach(function(k){ first[k] = JSON.stringify(sim.gather(T[k], ALL, BIG)); });
keys.slice().reverse().forEach(function(k){ if(JSON.stringify(sim2.gather(T[k], ALL, BIG)) !== first[k]) same = false; });
keys.forEach(function(k){ if(JSON.stringify(sim.gather(T[k], ALL, BIG)) !== first[k]) same = false; });
out.det = {same: same, jobsSame: JSON.stringify(sim.residents) === JSON.stringify(sim2.residents)};
var near = mon.filter(function(r){ return r.crowd === "terrace"; })[0], inAt = 0, ms = 0;
if(near){
  var list = sim.at(T.mon1230, {x: near.x, z: near.z}, 150);
  inAt = list.filter(function(r){ return r.id === near.id && r.crowd === "terrace"; }).length;
  var t0 = Date.now(); for(var i = 0; i < 60; i++) sim.at(T.mon1230 + i*16, {x: near.x, z: near.z}, 150); ms = (Date.now() - t0)/60;
}
out.at = {inAt: inAt, ms: ms, speak: near ? sim.speak(near.id, T.mon1230) : "", speakResident: sim.speak(0, T.mon1230).length > 0};

// npcdraw: a crowd row wears its lk's colours, a child is smaller, a far sitter sinks to the seat
var cols = D.colours(sim), B = D.farBuffers(3);
D.packFar([{id: N + 5, lk: 3, x: 0, y: 1, z: 0, yaw: 0, anim: "sit"}, {id: N + 6, lk: 4, x: 1, y: 1, z: 0, yaw: 0, anim: "idle", size: 0.62},
           {id: N + 7, lk: 2, x: 2, y: 1, z: 0, yaw: 0, anim: "jog", speed: 2.8}], B, cols);
out.draw = {shirt0: Array.from(B.shirt.slice(0, 3)).map(function(v){ return +v.toFixed(5); }), lk3: Array.from(cols.slice(27, 30)).map(function(v){ return +v.toFixed(5); }),
            y0: B.mat[13], scale1: +B.mat[16 + 5].toFixed(3), jogGait: B.gait[3*2 + 1] > 0 && B.gait[3*2 + 2] > 0.55};
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class Crowds(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", SCRIPT % {"root": json.dumps(ROOT)}], capture_output=True, text=True, timeout=300)
        if r.returncode:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_shops_and_cafes_are_job_places(self):
        j = self.o["jobs"]
        self.assertGreater(j["tables"].get("retail", 0), 20)
        self.assertGreater(j["tables"].get("cafe", 0), 10)
        self.assertGreater(j["tables"].get("office", 0), 50)
        for row in j["rows"]:
            kind, job, hours = row.split(":")
            a, b = (float(x) for x in hours.split("-"))
            if kind == "retail":
                self.assertTrue(9 <= a < b <= 20, row)
            else:
                self.assertEqual(job, "barista", row)
                self.assertTrue(7 <= a < b <= 23, row)
        self.assertIn("cafe:barista:7-15", j["rows"])
        self.assertIn("cafe:barista:15-23", j["rows"])
        self.assertGreater(j["atShop"][0], j["atShop"][1]*0.7, "shop staff are at the shop at 11:00")
        # lunch goes to cafes and food shops
        self.assertGreater(j["lunch"].get("cafe", 0) + j["lunch"].get("retail", 0), 0, j["lunch"])
        # without the city life: the old tables, nobody gathering
        self.assertNotIn("retail", j["offKinds"])
        self.assertNotIn("cafe", j["offKinds"])
        self.assertEqual(j["offGather"], 0)

    def test_terraces_fill_at_lunch_and_empty_at_night(self):
        c = self.o["counts"]
        self.assertGreater(c["mon1230"].get("terrace", 0), 10)
        self.assertEqual(c["mon0300"], {}, "nobody out at 03:00")
        self.assertEqual(c["mon1510"].get("terrace", 0), 0, "between lunch and the evening")
        a = self.o["anim"]
        self.assertGreater(a["terraceSit"], a["terrace"]*0.6, "most at a terrace sit")
        self.assertTrue(a["lkOk"])

    def test_stops_have_people_waiting_in_the_morning_rush(self):
        c = self.o["counts"]
        self.assertGreater(c["mon0800"].get("wait", 0), 40)
        a = self.o["anim"]
        self.assertGreater(a["waitIdle"], 0)
        self.assertGreater(a["faceRoad"][0], a["faceRoad"][1]*0.8, "waiting faces the road")

    def test_school_gate_busy_weekday_mornings_only(self):
        c = self.o["counts"]
        self.assertGreater(c["mon0800"].get("gate", 0), 10)
        self.assertGreater(c["mon1510"].get("gate", 0), 10, "15:00 pick-up")
        self.assertEqual(c["sun0800"].get("gate", 0), 0)
        self.assertEqual(c["mon0700"].get("gate", 0), 0)
        self.assertGreater(self.o["anim"]["kids"], 0)
        self.assertLess(self.o["anim"]["kids"], self.o["anim"]["gate"])

    def test_stadium_market_park(self):
        c = self.o["counts"]
        self.assertGreater(c["sat1600"].get("event", 0), 20, "Saturday afternoon's match")
        self.assertEqual(c["sun1530"].get("event", 0), 0)
        self.assertGreater(c["sat1000"].get("market", 0), 5, "Saturday's market")
        self.assertEqual(c["mon1230"].get("market", 0), 0)
        self.assertGreater(c["mon0800"].get("jog", 0), 0, "morning joggers")
        self.assertEqual(c["mon1230"].get("jog", 0), 0)
        self.assertIn("jog", self.o["spots"])

    def test_parade_walks_only_sunday_15_to_1630(self):
        c = self.o["counts"]
        for k in ("sun1500", "sun1530", "sun1629"):
            self.assertGreater(c[k].get("parade", 0), 0, k)
        for k in ("sun1440", "sun1640", "sat1530", "mon1230"):
            self.assertEqual(c[k].get("parade", 0), 0, k)
        p = self.o["parade"]
        self.assertEqual(p["onRoute"], p["n"], "the parade keeps to its closed route")
        self.assertEqual(p["walking"], p["n"])
        self.assertEqual(p["moved"], p["n"], "a minute on, everyone has walked on")

    def test_nobody_in_a_building_the_water_or_traffic(self):
        w = self.o["where"]
        self.assertGreater(w["n"], 200)
        self.assertEqual((w["lot"], w["water"], w["road"]), (0, 0, 0), w)

    def test_deterministic(self):
        self.assertTrue(self.o["det"]["same"])
        self.assertTrue(self.o["det"]["jobsSame"])

    def test_at_carries_them_within_budget(self):
        a = self.o["at"]
        self.assertEqual(a["inAt"], 1)
        self.assertLess(a["ms"], 6, "sim.at at a busy terrace, ms per call")
        self.assertTrue(a["speak"])
        self.assertTrue(a["speakResident"])

    def test_draw_wears_the_borrowed_look(self):
        d = self.o["draw"]
        self.assertEqual(d["shirt0"], d["lk3"])
        self.assertLess(d["y0"], 1, "a far sitter sinks to the seat")
        self.assertAlmostEqual(d["scale1"], 0.62, places=3)
        self.assertTrue(d["jogGait"])


if __name__ == "__main__":
    unittest.main()
