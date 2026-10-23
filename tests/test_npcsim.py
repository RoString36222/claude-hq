"""The City's residents (games/npcsim.js, Cities spec task cl-npc) on a synthetic WorldDoc v2 town.

npcsim.js is pure, so node loads it against a stub `window` and the town from tests/fixtures/npc_town@2.json
(written by tests/fixtures/npc_fixture.py), runs every scenario in one process and prints the numbers; the
Python side checks them: population by tier, determinism (two sims agree, whatever order they are asked in),
nobody inside a block or in the water, walkers on the sidewalks, zones filled with their own jobs at their
own hours, the day's schedule (commute, lunch, home, nights, shifts), modes by distance, cached routes, the
local clock and the speech lines. Skipped when node is not installed. Stdlib only."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
FIXTURE = os.path.join(ROOT, "tests", "fixtures", "npc_town@2.json")

HARNESS = r"""
var fs = require("fs"), root = %(root)s;
global.window = {HQV: {}};
new Function(fs.readFileSync(root + "/games/npcsim.js", "utf8"))();
var S = window.HQV.npcSim, doc = JSON.parse(fs.readFileSync(root + "/tests/fixtures/npc_town@2.json", "utf8"));
var L = doc.layers, H = S.HOUR, DAY = S.DAY, D0 = 20*DAY, out = {};
var ALL = {x: 0, z: 0}, BIG = 5000;

// population by tier and grow
out.pop = [1, 2, 3, 4, 5].map(function(t){ return [S.population(t, 0), S.create(doc, {tier: t, grow: 0}).residents.length]; });
out.popGrow = [S.population(1, 500), S.population(2, 1000), S.population(5, 1000), S.population(5, 500), S.population(3, 250)];

// determinism: B is asked in the reverse order, over the whole town; C has another seed
var A = S.create(doc, {tier: 5, grow: 300, seed: "town"}), B = S.create(doc, {tier: 5, grow: 300, seed: "town"});
var C = S.create(doc, {tier: 5, grow: 300, seed: "other"});
var hours = [3, 6.6, 7.4, 7.9, 8.3, 8.75, 12.05, 12.3, 12.7, 16.1, 17.2, 17.6, 18.1, 18.6, 19.4, 21, 23.5];
var times = []; [0, 1].forEach(function(d){ hours.forEach(function(h){ times.push(D0 + d*DAY + h*H); }); });
var a = {}, maxd = 0, nA = 0, missing = 0;
times.forEach(function(t){ a[t] = {}; A.at(t, {x: 40, z: -30}, 400).forEach(function(r){ a[t][r.id] = r; nA++; }); });
times.slice().reverse().forEach(function(t){
  B.at(t, ALL, BIG).forEach(function(r){
    var q = a[t][r.id]; if(!q) return;
    maxd = Math.max(maxd, Math.hypot(q.x - r.x, q.y - r.y, q.z - r.z));
  });
  var seen = {}; B.at(t, ALL, BIG).forEach(function(r){ seen[r.id] = 1; });
  Object.keys(a[t]).forEach(function(id){ if(!seen[id]) missing++; });
});
var diff = 0; times.forEach(function(t){ var c = {}; C.at(t, ALL, BIG).forEach(function(r){ c[r.id] = r; });
  B.at(t, ALL, BIG).forEach(function(r){ var q = c[r.id]; if(!q || Math.hypot(q.x - r.x, q.z - r.z) > 0.5) diff++; }); });
out.det = {maxd: maxd, n: nA, missing: missing, otherSeedDiffers: diff,
           jobsSame: JSON.stringify(A.residents) === JSON.stringify(B.residents)};

// nobody inside a block, outside the coast or on a water cell; walkers on the road corridor, off its middle
var blocks = L.blocks.map(function(b){ return b.poly.map(function(p){ return [p[0]/100, p[1]/100]; }); });
var coast = L.island.coast.map(function(p){ return [p[0]/100, p[1]/100]; });
var Dl = L.districts, WATER = Dl.legend.indexOf("water");
var nodes = {}; L.roads.nodes.forEach(function(n){ nodes[n.id] = [n.x/100, n.z/100]; });
function segD(px, pz, a, b){
  var dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx*dx + dz*dz, t = l2 ? Math.max(0, Math.min(1, ((px - a[0])*dx + (pz - a[1])*dz)/l2)) : 0;
  return Math.hypot(px - a[0] - dx*t, pz - a[1] - dz*t);
}
var geo = {speeds: [], crossings: 0, checked: 0, walkers: 0, inBlock: 0, offCoast: 0, onWater: 0, offRoad: 0, midRoad: 0, badY: 0, examples: []};
[3, 5].forEach(function(tier){
  var sim = S.create(doc, {tier: tier, grow: 900, seed: "geo"});
  var edges = L.roads.edges.filter(function(e){ return (e.min_tier | 0) <= tier; });
  for(var m = 0; m < 24*60; m += 7){
    sim.at(D0 + m*60000, ALL, BIG).forEach(function(r){
      geo.checked++;
      if(!(r.y > 0.4 && r.y < 0.8)) geo.badY++;
      for(var b = 0; b < blocks.length; b++) if(S.inPoly(blocks[b], r.x, r.z)){ geo.inBlock++; if(geo.examples.length < 5) geo.examples.push([tier, m, r]); break; }
      if(!S.inPoly(coast, r.x, r.z)) geo.offCoast++;
      var ci = Math.floor((r.x*100 - Dl.origin_cm)/Dl.cell_cm), cj = Math.floor((r.z*100 - Dl.origin_cm)/Dl.cell_cm);
      if(Dl.kinds[cj*Dl.n + ci] === WATER) geo.onWater++;
      if(r.anim !== "walk" && r.anim !== "idle") return;
      geo.walkers++;
      var best = Infinity, inside = false, nearNode = Infinity, be = null;
      edges.forEach(function(e){
        var d = segD(r.x, r.z, nodes[e.a], nodes[e.b]);
        if(d < best){ best = d; be = e; }
        if(d <= e.width/200 + 0.05) inside = true;
      });
      if(r.anim === "walk") geo.speeds.push(r.speed);
      Object.keys(nodes).forEach(function(k){ nearNode = Math.min(nearNode, Math.hypot(r.x - nodes[k][0], r.z - nodes[k][1])); });
      if(!inside) geo.offRoad++;
      // off the carriageway's middle, except crossing over: at a junction, or straight across mid-block
      var ea = nodes[be.a], eb = nodes[be.b], across = Math.abs(Math.sin(r.yaw - Math.atan2(eb[0] - ea[0], eb[1] - ea[1])));
      if(best < 1.0 && nearNode > 13){ if(r.anim === "walk" && across > 0.95) geo.crossings++; else geo.midRoad++; }
    });
  }
});
geo.speeds.sort(function(a, b){ return a - b; });
geo.speed = {p50: geo.speeds[geo.speeds.length >> 1], p99: geo.speeds[Math.floor(geo.speeds.length*0.99)], max: geo.speeds[geo.speeds.length - 1]};
delete geo.speeds;
out.geo = geo;

// zones: every job place staffed with its own table's jobs, at its own hours
var Z = S.create(doc, {tier: 5, grow: 1000, seed: "zones"});
var placeKind = {}; Z.places.forEach(function(p){ placeKind[p.key] = p.table; });
var lotDistrict = {}; L.lots.forEach(function(l){ lotDistrict["lot:" + l.id] = Dl.legend[l.district]; });
var zones = {badJob: [], staffed: {}, places: {}, lotTable: {}};
Z.places.forEach(function(p){ if(p.table) zones.places[p.key] = 0; });
Z.residents.forEach(function(r){
  if(!r.job) return;
  var tbl = S.JOBS[r.job.kind] || [];
  var ok = tbl.some(function(row){ return row[0] === r.job.job && row[1] === r.job.from && row[2] === r.job.to; });
  if(!ok || placeKind[r.job.place] !== r.job.kind) zones.badJob.push(r.job);
  zones.places[r.job.place]++;
  if(lotDistrict[r.job.place]){ var k = lotDistrict[r.job.place] + ">" + r.job.kind; zones.lotTable[k] = (zones.lotTable[k] | 0) + 1; }
});
zones.unstaffed = Object.keys(zones.places).filter(function(k){ return !zones.places[k]; });
// at work share by (kind, job, shift) at given hours
function atWork(sim, filter, h){
  var n = 0, w = 0;
  sim.residents.forEach(function(r){ if(!r.job || !filter(r.job)) return; n++;
    var s = sim.where(r.id, D0 + h*H).state; if(s === "work") w++; });
  return n ? [w, n] : [0, 0];
}
function K(kind, job, from){ return function(j){ return j.kind === kind && (!job || j.job === job) && (from == null || j.from === from); }; }
zones.hours = {
  office: [10.5, 14, 3, 20].map(function(h){ return atWork(Z, K("office"), h); }),
  campus8: [9, 3].map(function(h){ return atWork(Z, K("campus", "engineer", 8), h); }),
  campus12: [9, 14, 19.5].map(function(h){ return atWork(Z, K("campus", "engineer", 12), h); }),
  campusAll: [9, 14.2].map(function(h){ return atWork(Z, K("campus"), h); }),
  crew: [7, 15, 21].map(function(h){ return atWork(Z, K("studio", "crew"), h); }),
  cast: [7, 10.5, 15].map(function(h){ return atWork(Z, K("studio", "cast"), h); }),
  police22: [3, 12].map(function(h){ return atWork(Z, K("police", "officer", 22), h); }),
  policeAll3: atWork(Z, K("police"), 3),
  fire19: [3, 12].map(function(h){ return atWork(Z, K("fire", "firefighter", 19), h); }),
  fire7: [3, 12].map(function(h){ return atWork(Z, K("fire", "firefighter", 7), h); }),
  farm: [6.5, 20].map(function(h){ return atWork(Z, K("farm"), h); }),
  warehouse14: [10, 16].map(function(h){ return atWork(Z, K("warehouse", "loader", 14), h); })
};
// Layers.zones overrides a kind's table
var doc2 = JSON.parse(JSON.stringify(doc)); doc2.layers.zones = {jobs: {office: [["coder", 10, 18, 3], {job: "lead", from: 10, to: 18, n: 1}]}};
var Z2 = S.create(doc2, {tier: 5, grow: 1000, seed: "zones"}), names = {};
Z2.residents.forEach(function(r){ if(r.job && r.job.kind === "office") names[r.job.job] = (names[r.job.job] | 0) + 1; });
zones.override = {names: names, h930: atWork(Z2, K("office"), 8.95), h1100: atWork(Z2, K("office"), 11)};
out.zones = zones;

// the day: commute, lunch, home (via the market or a park), nights home, shifts
var day = {dep917: [], lunch: [], lunchTo: {}, home917: [], arriveHome: [], via: 0, nightNotHome: 0, nightN: 0, jobless: 0, joblessOut: 0};
Z.residents.forEach(function(r){
  var p = Z.plan(r.id, 20);
  if(!r.job){
    day.jobless++;
    if(p.length) day.joblessOut++;
  } else if(r.job.from === 9 && r.job.to === 17){
    var first = p[0], work = r.job.place;
    if(first && first.from === r.home && first.mode !== "bus") day.dep917.push(first.t0/H);
    p.forEach(function(m, i){
      if(m.from === work && m.to !== r.home && m.t0 < 13*H){ day.lunch.push(m.t0/H); day.lunchTo[placeKind[m.to] || Z.places.filter(function(q){ return q.key === m.to; })[0].kind] = 1; }
      if(m.from === work && m.t0 >= 16*H) day.home917.push(m.t0/H);
      if(m.from === work && m.t0 >= 16*H && m.to !== r.home && Z.places.some(function(q){ return q.key === m.to && q.kind !== "busstop"; })) day.via++;
    });
    var last = null; p.forEach(function(m){ if(m.to === r.home && m.t0 < 20*H) last = m; });
    if(last) day.arriveHome.push((last.t0 + last.dur)/H);
  }
  // nights home: 03:00, unless the shift covers the night
  if(r.job && (r.job.to <= r.job.from || r.job.from <= 3 || r.job.to > 24)) return;
  day.nightN++;
  if(Z.where(r.id, D0 + 3*H).state !== "home") day.nightNotHome++;
});
out.day = day;

// modes by distance
var places = {}; Z.places.forEach(function(p){ places[p.key] = p; });
var modes = {walkFar: 0, rideNear: 0, counts: {}};
Z.residents.forEach(function(r){
  modes.counts[r.mode] = (modes.counts[r.mode] | 0) + 1;
  if(!r.job) return;
  var h = places[r.home], w = places[r.job.place], d = Math.hypot(h.x - w.x, h.z - w.z);
  if(r.mode === "walk" && d > 900) modes.walkFar++;
  if(r.mode !== "walk" && d <= 900) modes.rideNear++;
});
var T1 = S.create(doc, {tier: 1, grow: 1000, seed: "zones"}), t1 = {};
T1.residents.forEach(function(r){ t1[r.mode] = (t1[r.mode] | 0) + 1; });
modes.tier1 = t1;
var visModes = {}; for(var hh = 6; hh < 20; hh += 0.25) Z.at(D0 + hh*H, ALL, BIG).forEach(function(r){ visModes[r.mode + "/" + r.anim] = 1; });
modes.visible = Object.keys(visModes).sort();
out.modes = modes;

// routes are planned once and cached; a position does not depend on what was asked before
var R = S.create(doc, {tier: 4, grow: 0, seed: "cache"}), tq = D0 + 8.1*H;
var p1 = R.at(tq, ALL, BIG), n1 = R.stats.paths;
var p2 = R.at(tq, ALL, BIG), n2 = R.stats.paths;
R.at(tq - 5*H, ALL, BIG); R.at(tq + 30*DAY, ALL, BIG);
var p3 = R.at(tq, ALL, BIG), same = p1.length === p3.length;
p1.forEach(function(r, i){ if(!p3[i] || p3[i].id !== r.id || Math.abs(p3[i].x - r.x) > 1e-9 || Math.abs(p3[i].z - r.z) > 1e-9) same = false; });
out.cache = {n1: n1, n2: n2, astar: R.stats.astar, paths: R.stats.paths, same: same, vis: p1.length,
             sorted: p1.every(function(r, i){ return !i || p1[i - 1].d2 <= r.d2; }),
             keys: p1.length ? Object.keys(p1[0]).sort() : []};
// a whole-day sweep moves each resident along its route continuously: no jumps between 1 s samples
var jump = 0, prev = {};
for(var s = 0; s < 3600; s += 1){
  var cur = {}; R.at(D0 + 7.5*H + s*1000, ALL, BIG).forEach(function(r){ cur[r.id] = r;
    var q = prev[r.id]; if(q && q.anim === "walk" && r.anim === "walk") jump = Math.max(jump, Math.hypot(r.x - q.x, r.z - q.z)); });
  prev = cur;
}
out.cache.walkJump = jump;

// the local clock (run under TZ=Asia/Kolkata)
var d = new Date(Date.UTC(2026, 9, 19, 3, 30)), lm = S.localMs(d);
out.clock = {hour: (lm % DAY)/H, tz: process.env.TZ};

// speech: from the job and the time, plain text, the same for the same inputs
var sp = {lines: [], same: true, html: 0, shift: 0};
Z.residents.slice(0, 300).forEach(function(r){
  [7.5, 8.3, 12.2, 17.4, 22].forEach(function(h){
    var t = D0 + h*H, s1 = Z.speak(r.id, t), s2 = Z.speak(r.id, t);
    if(s1 !== s2 || !s1) sp.same = false;
    if(/[<>&]/.test(s1)) sp.html++;
    var w = Z.where(r.id, t);
    if(r.job && w.state === "travel" && /shift starts|Can't be late/.test(s1) && s1.indexOf(String(Math.floor(r.job.from))) >= 0) sp.shift++;
    if(sp.lines.length < 6 && r.job) sp.lines.push(s1);
  });
});
sp.empty = Z.speak(99999, D0);
out.speak = sp;
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE and os.path.exists(FIXTURE), "node and tests/fixtures/npc_town@2.json needed")
class NpcSimTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        js = HARNESS.replace("%(root)s", json.dumps(ROOT))
        env = dict(os.environ, TZ="Asia/Kolkata")
        p = subprocess.run([NODE, "-e", js], capture_output=True, text=True, timeout=300, env=env)
        if p.returncode != 0:
            raise AssertionError("node harness failed:\n" + p.stderr[-4000:])
        cls.r = json.loads(p.stdout)

    def test_population_by_tier(self):
        self.assertEqual(self.r["pop"], [[50, 50], [200, 200], [600, 600], [1200, 1200], [2000, 2000]])
        # grow (per-mille through the tier) scales toward the next tier's number; tier 5 stays at 2000
        self.assertEqual(self.r["popGrow"], [125, 600, 2000, 2000, 750])

    def test_determinism(self):
        d = self.r["det"]
        self.assertGreater(d["n"], 500)
        self.assertLess(d["maxd"], 0.5)
        self.assertEqual(d["missing"], 0)
        self.assertTrue(d["jobsSame"])
        self.assertGreater(d["otherSeedDiffers"], 100)       # the seed matters

    def test_never_inside_blocks_or_water(self):
        g = self.r["geo"]
        self.assertGreater(g["checked"], 12000)
        self.assertGreater(g["walkers"], 6000)
        self.assertEqual(g["inBlock"], 0, g["examples"])
        self.assertEqual(g["offCoast"], 0)
        self.assertEqual(g["onWater"], 0)
        self.assertEqual(g["badY"], 0)

    def test_walkers_on_the_sidewalk(self):
        g = self.r["geo"]
        self.assertEqual(g["offRoad"], 0)                     # within the road corridor (sidewalks included)
        self.assertEqual(g["midRoad"], 0)                     # never along the carriageway's middle
        # at a walking pace: each walker's own (1.15-1.55 m/s), a little brisker on a long way round
        self.assertTrue(1.15 <= g["speed"]["p50"] <= 1.55, g["speed"])
        self.assertLess(g["speed"]["p99"], 1.8)
        self.assertLess(g["speed"]["max"], 2.5)

    def test_zones_fill_with_their_jobs(self):
        z = self.r["zones"]
        self.assertEqual(z["badJob"], [])
        self.assertEqual(z["unstaffed"], [])
        lt = z["lotTable"]
        for district, table in (("office", "office"), ("tech", "campus"), ("studio", "studio"), ("finance", "finance"),
                                ("biotech", "biotech"), ("media", "media"), ("logistics", "warehouse"), ("farm", "farm")):
            self.assertGreater(lt.get(district + ">" + table, 0), 0, district)
        for k in lt:                                          # zone lots only hire from their own table
            d, t = k.split(">")
            self.assertNotIn(t, {"office", "campus", "studio"} - {{"office": "office", "tech": "campus", "studio": "studio"}.get(d)}, k)

    def test_zone_hours(self):
        h = self.r["zones"]["hours"]

        def share(p):
            return p[0] / p[1] if p[1] else -1
        # office 9-17: in at 10:30 and 14:00, gone at 03:00 and 20:00
        self.assertGreater(h["office"][0][1], 10)
        self.assertGreaterEqual(share(h["office"][0]), 0.95)
        self.assertGreaterEqual(share(h["office"][1]), 0.9)
        self.assertEqual(h["office"][2][0], 0)
        self.assertEqual(h["office"][3][0], 0)
        # tech in waves: the 8:00 wave in at 9:00, the 12:00 wave not yet, in at 14:00, gone by 19:30
        self.assertGreaterEqual(share(h["campus8"][0]), 0.9)
        self.assertEqual(h["campus8"][1][0], 0)
        self.assertEqual(h["campus12"][0][0], 0)
        self.assertGreaterEqual(share(h["campus12"][1]), 0.9)
        self.assertGreater(share(h["campusAll"][0]), 0.1)
        self.assertLess(share(h["campusAll"][0]), 0.6)
        self.assertGreaterEqual(share(h["campusAll"][1]), 0.85)
        # studio: the crew on set from 6, the cast from 9
        self.assertGreaterEqual(share(h["crew"][0]), 0.9)
        self.assertGreaterEqual(share(h["crew"][1]), 0.9)
        self.assertEqual(h["crew"][2][0], 0)
        self.assertEqual(h["cast"][0][0], 0)
        self.assertGreaterEqual(share(h["cast"][1]), 0.9)
        # police and fire on shifts: the night shift on duty at 03:00, off at noon
        self.assertGreaterEqual(share(h["police22"][0]), 0.9)
        self.assertEqual(h["police22"][1][0], 0)
        self.assertGreater(h["policeAll3"][0], 0)
        self.assertGreaterEqual(share(h["fire19"][0]), 0.9)
        self.assertEqual(h["fire19"][1][0], 0)
        self.assertEqual(h["fire7"][0][0], 0)
        self.assertGreaterEqual(share(h["fire7"][1]), 0.9)
        self.assertGreaterEqual(share(h["farm"][0]), 0.9)
        self.assertEqual(h["farm"][1][0], 0)
        self.assertEqual(h["warehouse14"][0][0], 0)
        self.assertGreaterEqual(share(h["warehouse14"][1]), 0.9)

    def test_layers_zones_override(self):
        o = self.r["zones"]["override"]
        self.assertEqual(set(o["names"]), {"coder", "lead"})
        self.assertGreater(o["names"]["coder"], o["names"]["lead"])
        self.assertEqual(o["h930"][0], 0)
        self.assertGreaterEqual(o["h1100"][0] / o["h1100"][1], 0.95)

    def test_daily_schedule(self):
        d = self.r["day"]
        dep = d["dep917"]
        self.assertGreater(len(dep), 30)
        self.assertTrue(all(6.5 <= h < 9 for h in dep), (min(dep), max(dep)))
        self.assertGreaterEqual(sum(1 for h in dep if 7 <= h < 9) / len(dep), 0.9)   # 07:00-09:00
        self.assertGreater(len(d["lunch"]), 20)
        self.assertTrue(all(12 <= h < 12.5 for h in d["lunch"]))
        self.assertTrue(set(d["lunchTo"]) <= {"market", "mall", "shop"}, d["lunchTo"])
        self.assertTrue(all(17 <= h < 18.01 for h in d["home917"]), (min(d["home917"]), max(d["home917"])))
        arr = d["arriveHome"]
        self.assertGreaterEqual(sum(1 for h in arr if 17 <= h <= 19.5) / len(arr), 0.9)  # 17:00-19:00 commute home
        self.assertGreater(d["via"], 5)                        # some via the market or a park
        self.assertGreater(d["nightN"], 1000)
        self.assertEqual(d["nightNotHome"], 0)                 # nights home
        self.assertGreater(d["jobless"], 0)
        self.assertEqual(d["joblessOut"], d["jobless"])        # no job: still an outing

    def test_modes_by_distance(self):
        m = self.r["modes"]
        self.assertEqual(m["walkFar"], 0)
        self.assertEqual(m["rideNear"], 0)
        self.assertTrue(set(m["counts"]) <= {"walk", "car", "bus"})
        self.assertGreater(m["counts"].get("walk", 0), 0)
        self.assertGreater(m["counts"].get("car", 0) + m["counts"].get("bus", 0), 0)
        self.assertNotIn("bus", m["tier1"])                    # no buses before tier 2
        self.assertTrue(set(m["visible"]) <= {"walk/walk", "walk/idle", "car/drive", "bus/idle"}, m["visible"])

    def test_routes_cached_and_pure(self):
        c = self.r["cache"]
        self.assertGreater(c["vis"], 10)
        self.assertGreater(c["n1"], 0)
        self.assertEqual(c["n1"], c["n2"])                     # asking again plans nothing
        self.assertTrue(c["same"])
        self.assertTrue(c["sorted"])
        self.assertEqual(c["keys"], ["anim", "d2", "id", "mode", "speed", "x", "y", "yaw", "z"])
        self.assertLess(c["walkJump"], 2.5)                    # continuous: walking pace between 1 s samples

    def test_local_clock(self):
        self.assertEqual(self.r["clock"]["tz"], "Asia/Kolkata")
        self.assertAlmostEqual(self.r["clock"]["hour"], 9.0)   # 03:30 UTC is 09:00 in IST

    def test_speech(self):
        s = self.r["speak"]
        self.assertTrue(s["same"])
        self.assertEqual(s["html"], 0)
        self.assertGreater(s["shift"], 0)
        self.assertEqual(s["empty"], "")
        self.assertTrue(all(isinstance(x, str) and len(x) > 5 for x in s["lines"]))

    def test_source_rules(self):
        with open(os.path.join(ROOT, "games", "npcsim.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertNotIn("Math.random", src)
        self.assertNotIn("innerHTML", src)
        self.assertNotRegex(src, r"https?://")
        self.assertNotRegex(src, r"Math\.min\(\s*1\s*,\s*dt")


CITY_HARNESS = r"""
var fs = require("fs"), root = %(root)s;
global.window = {HQV: {}};
new Function(fs.readFileSync(root + "/games/npcsim.js", "utf8"))();
var S = window.HQV.npcSim, doc = JSON.parse(fs.readFileSync(root + "/tests/fixtures/npc_town@2.json", "utf8"));
var L = doc.layers, H = S.HOUR, DAY = S.DAY, MIN = 60000, D0 = 20*DAY, out = {}, ALL = {x: 0, z: 0}, BIG = 5000;
var site = {}; L.sites.forEach(function(s){ site[s.id] = s; });
function m(v){ return (v | 0)/100; }
// the busiest home lot (most residents' homes within 120 m) for the fire and the medical call
var probe = S.create(doc, {tier: 5, grow: 1000, seed: "city"}), homes = {};
probe.residents.forEach(function(r){ if(r.home) homes[r.home] = (homes[r.home] | 0) + 1; });
var lots = probe.places.filter(function(p){ return homes[p.key]; }), bestLot = null, bestN = -1;
lots.forEach(function(p){ var n = 0; lots.forEach(function(q){ if(Math.hypot(p.x - q.x, p.z - q.z) <= 120) n += homes[q.key]; }); if(n > bestN){ bestN = n; bestLot = p; } });
var lotId = bestLot.key.slice(4), fs0 = site["fire:0"], hs = site["hospital:0"], ps = site["police:0"];
var node = L.roads.nodes.reduce(function(a, n){ return Math.hypot(n.x, n.z) < Math.hypot(a.x, a.z) ? n : a; });
function U(kind, st, s, en, o){ return {kind: kind, station: st, dispatch: s + 20000, arrive: s + 3*MIN, leave: en - (o || 5)*MIN, back: en + 3*MIN}; }
// the stub director: the contract's shapes (UTC ms; the tests run the local clock at UTC: clockTzMin 0)
var EV = [
  {id: "fire-1", kind: "fire", start: D0 + 10*H, end: D0 + 10*H + 40*MIN, x: bestLot.x, z: bestLot.z, lot: lotId, street: "Elm <b>Street</b>", severity: 3, label: "Fire",
   units: [U("fire", "fire:0", D0 + 10*H, D0 + 10*H + 40*MIN), U("police", "police:0", D0 + 10*H, D0 + 10*H + 40*MIN)]},
  {id: "med-1", kind: "medical", start: D0 + 11*H, end: D0 + 11*H + 30*MIN, x: bestLot.x + 10, z: bestLot.z, street: "Oak Road", severity: 1,
   units: [U("ambulance", "hospital:0", D0 + 11*H, D0 + 11*H + 30*MIN, 12)], dest: "hospital:0"},
  {id: "crash-1", kind: "crash", start: D0 + 14*H, end: D0 + 14*H + 20*MIN, x: m(node.x), z: m(node.z), node: node.id, street: "Mill Lane", severity: 2, units: []},
  {id: "school-1", kind: "school", start: D0 + 8*H, end: D0 + 15*H, site: "school:0", x: m(site["school:0"].x), z: m(site["school:0"].z), units: []},
  {id: "market-1", kind: "market", start: D0 + 8*H, end: D0 + 13*H, site: "market:0", x: m(site["market:0"].x), z: m(site["market:0"].z), units: []},
  {id: "match-1", kind: "match", start: D0 + 19*H, end: D0 + 21*H, site: "stadium:0", x: m(site["stadium:0"].x), z: m(site["stadium:0"].z), units: []},
  {id: "fest-1", kind: "festival", start: D0 + 20*H + 30*MIN, end: D0 + 23*H, site: "townhall:0", x: m(site["townhall:0"].x), z: m(site["townhall:0"].z), units: []}
];
var calls = 0;
var D = {
  events: function(a, b){ calls++; return EV.filter(function(e){ return e.end >= a && e.start <= b; }); },
  active: function(ms){ return EV.filter(function(e){ return e.start <= ms && ms < e.end && e.kind in {fire: 1, medical: 1, crime: 1, crash: 1}; }); },
  at: function(ms){ var o = {rush: 0, match: null, market: null, school: null, festival: null}; EV.forEach(function(e){ if(e.start <= ms && ms < e.end && e.kind in o) o[e.kind] = e; }); return o; },
  phase: function(e, ms){ return ms < e.start ? "reported" : ms < e.end ? "onscene" : "done"; },
  unitsAt: function(){ return []; }
};
function mk(seed){ return S.create(doc, {tier: 5, grow: 1000, seed: seed || "city", city: D, clockTzMin: 0}); }
var C = mk(), byKind = function(t){ var k = {}; C.joined(t).forEach(function(j){ k[j.kind] = (k[j.kind] | 0) + 1; }); return k; };
function near(rows, x, z, R){ return rows.filter(function(r){ return Math.hypot(r.x - x, r.z - z) <= R; }); }
function rowsOf(t, kind){ var ids = {}; C.joined(t).forEach(function(j){ if(!kind || j.kind === kind) ids[j.id] = 1; }); return C.at(t, ALL, BIG).filter(function(r){ return ids[r.id]; }); }

// the fire: onlookers at the cordon, crews at the station, then the scene
var tf = D0 + 10*H + 20*MIN, gawk = rowsOf(tf, "gawk");
out.fire = {kinds: byKind(tf), gawk: gawk.length, gawkNear: near(gawk, bestLot.x, bestLot.z, 60).length,
            gawkIdle: gawk.filter(function(r){ return r.anim === "idle"; }).length,
            before: (byKind(D0 + 10*H - MIN).gawk | 0), after: (byKind(D0 + 12*H).gawk | 0) + (byKind(D0 + 12*H).crew | 0)};
var crew0 = rowsOf(D0 + 10*H + 15000, "crew"), crewS = rowsOf(D0 + 10*H + 10*MIN, "crew");
out.crew = {station: crew0.length, atStation: near(crew0, m(fs0.x), m(fs0.z), 80).length + near(crew0, m(ps.x), m(ps.z), 80).length,
            scene: crewS.length, atScene: near(crewS, bestLot.x, bestLot.z, 60).length, riding: (byKind(D0 + 10*H + 2*MIN).crew | 0),
            jobs: C.joined(D0 + 10*H + 15000).filter(function(j){ return j.kind === "crew"; }).map(function(j){ return C.residents[j.id].job.job; }).sort()};
// the medical call: one patient lying, gone once the ambulance leaves
var pt = rowsOf(D0 + 11*H + 5*MIN, "patient"), pAway = byKind(D0 + 11*H + 25*MIN).patient | 0, pRows = rowsOf(D0 + 11*H + 25*MIN, "patient");
out.medical = {lying: pt.map(function(r){ return r.anim; }), away: pAway, awayVisible: pRows.length, ambo: near(rowsOf(D0 + 11*H + 10*MIN, "crew"), bestLot.x, bestLot.z, 80).length};
// the match: fans cheering outside before kick-off, inside during it, out after
var st = site["stadium:0"], sx = m(st.x), sz = m(st.z), fanB = rowsOf(D0 + 19*H - 8*MIN, "fan"), fanIn = rowsOf(D0 + 20*H, "fan");
out.match = {joined: byKind(D0 + 19*H - 8*MIN).fan | 0, cheer: fanB.filter(function(r){ return r.anim === "cheer"; }).length,
             near: near(fanB, sx, sz, 160).length, inside: byKind(D0 + 20*H).fan | 0, insideVisible: fanIn.length,
             outAfter: rowsOf(D0 + 21*H + 6*MIN, "fan").length, early: byKind(D0 + 16*H).fan | 0};
// school, market, festival
var sc = site["school:0"], pu = rowsOf(D0 + 8*H - 2*MIN, "pupil");
out.school = {joined: byKind(D0 + 8*H - 2*MIN).pupil | 0, visible: pu.length, near: near(pu, m(sc.x), m(sc.z), 80).length,
              noon: byKind(D0 + 12*H).pupil | 0, noonVisible: rowsOf(D0 + 12*H, "pupil").length,
              jobless: C.joined(D0 + 12*H).filter(function(j){ return j.kind === "pupil"; }).every(function(j){ return !C.residents[j.id].job; })};
var mk0 = site["market:0"], shop = [], shopMax = 0;
for(var h = 8.5; h < 13; h += 0.5){ var sr = rowsOf(D0 + h*H, "shopper"); shopMax = Math.max(shopMax, sr.length); if(h === 10) shop = sr; }
out.market = {max: shopMax, near: near(shop, m(mk0.x), m(mk0.z), 80).length, at10: shop.length};
var fe = rowsOf(D0 + 21.5*H, "festival");
out.festival = {visible: fe.length, cheer: fe.filter(function(r){ return r.anim === "cheer"; }).length};
var w = C.joined(D0 + 10*H + 20*MIN).filter(function(j){ return j.kind === "gawk"; })[0];
out.where = w ? C.where(w.id, D0 + 10*H + 20*MIN) : null;

// determinism: another sim asked in the reverse order agrees; the index matches asking everyone
var C2 = mk(), times = [], diff = 0, idx = 0, pairs = 0;
for(var hh = 7; hh < 23.5; hh += 0.23) times.push(D0 + Math.round(hh*H));
var A1 = {}; times.forEach(function(t){ A1[t] = JSON.stringify(C.at(t, {x: 40, z: -30}, 400)); });
times.slice().reverse().forEach(function(t){ if(JSON.stringify(C2.at(t, {x: 40, z: -30}, 400)) !== A1[t]) diff++; });
var C3 = mk();
times.forEach(function(t){
  C3.atScan(t, ALL, BIG).filter(function(r, i){ return i % 37 === 0; }).forEach(function(r){
    pairs++; if(JSON.stringify(C3.at(t, r, 60)) !== JSON.stringify(C3.atScan(t, r, 60))) idx++;
  });
});
out.det = {diff: diff, idx: idx, pairs: pairs, calls: calls};

// continuity: residents walking or standing never jump between 1 s samples (a turn into the crowd: < 3 m)
var jump = {walk: 0, any: 0, n: 0}, C4 = mk();
[[D0 + 10*H - 30000, 900], [D0 + 19*H - 50*MIN, 1200], [D0 + 21*H - 60000, 1500], [D0 + 8*H - 30*MIN, 900]].forEach(function(w){
  var prev = {};
  for(var s = 0; s < w[1]; s++){
    var cur = {};
    C4.at(w[0] + s*1000, ALL, BIG).forEach(function(r){
      cur[r.id] = r; var q = prev[r.id]; if(!q || q.anim === "drive" || r.anim === "drive") return;
      var d = Math.hypot(r.x - q.x, r.z - q.z); jump.n++;
      if(q.anim === "walk" && r.anim === "walk") jump.walk = Math.max(jump.walk, d);
      jump.any = Math.max(jump.any, d);
    });
    prev = cur;
  }
});
out.jump = jump;

// nobody inside a block or in the water, whatever the events
var blocks = L.blocks.map(function(b){ return b.poly.map(function(p){ return [p[0]/100, p[1]/100]; }); });
var Dl = L.districts, WATER = Dl.legend.indexOf("water"), geo = {checked: 0, inBlock: 0, onWater: 0, badY: 0, anims: {}};
for(var mm = 6*60; mm < 24*60; mm += 4){
  rowsOf(D0 + mm*MIN).forEach(function(r){
    geo.checked++; geo.anims[r.anim] = 1;
    if(!(r.y > 0.4 && r.y < 0.8)) geo.badY++;
    for(var b = 0; b < blocks.length; b++) if(S.inPoly(blocks[b], r.x, r.z)){ geo.inBlock++; break; }
    var ci = Math.floor((r.x*100 - Dl.origin_cm)/Dl.cell_cm), cj = Math.floor((r.z*100 - Dl.origin_cm)/Dl.cell_cm);
    if(Dl.kinds[cj*Dl.n + ci] === WATER) geo.onWater++;
  });
}
out.geo = geo;

// speech: lines about the events, by street, plain text
var sp = {fire: 0, gawk: 0, html: 0, match: 0, same: true};
C.residents.forEach(function(r){
  [D0 + 10*H + 20*MIN, D0 + 11*H, D0 + 17*H].forEach(function(t){
    var s1 = C.speak(r.id, t); if(s1 !== C.speak(r.id, t)) sp.same = false;
    if(/[<>&]/.test(s1)) sp.html++;
    if(/fire on Elm bStreet|fire on Elm Street/.test(s1)) sp.fire++;
    if(/match/i.test(s1)) sp.match++;
  });
});
C.joined(tf).forEach(function(j){ if(j.kind === "gawk" && /Elm/.test(C.speak(j.id, tf))) sp.gawk++; });
out.speak = sp;

// O(visible): a street-level circle works out a fraction of the town; fast with the crowds out
var P = mk(), t9 = D0 + 19*H - 8*MIN, cands = [], ms = [];
P.at(t9, ALL, BIG);
[[0, 0], [200, -200], [sx, sz], [-300, 300], [300, 100]].forEach(function(c){
  var t0 = process.hrtime.bigint();
  for(var k = 0; k < 50; k++) P.at(t9 + k*200, {x: c[0], z: c[1]}, 150);
  ms.push(Number(process.hrtime.bigint() - t0)/1e6/50);
  cands.push(P.stats.cand);
});
out.perf = {cand: cands, ms: ms, pop: P.population};
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE and os.path.exists(FIXTURE), "node and tests/fixtures/npc_town@2.json needed")
class NpcCityTest(unittest.TestCase):
    """Residents reacting to the city's events (opts.city, a stub director in the contract's shapes)."""
    @classmethod
    def setUpClass(cls):
        js = CITY_HARNESS.replace("%(root)s", json.dumps(ROOT))
        p = subprocess.run([NODE, "-e", js], capture_output=True, text=True, timeout=300)
        if p.returncode != 0:
            raise AssertionError("node harness failed:\n" + p.stderr[-4000:])
        cls.r = json.loads(p.stdout)

    def test_fire_onlookers(self):
        f = self.r["fire"]
        self.assertGreater(f["gawk"], 2)
        self.assertLessEqual(f["kinds"]["gawk"], 12)            # 3 + 3 x severity at most
        self.assertEqual(f["gawkNear"], f["gawk"])               # at the cordon
        self.assertGreater(f["gawkIdle"], 0)
        self.assertEqual(f["before"], 0)
        self.assertEqual(f["after"], 0)

    def test_crews_turn_out(self):
        c = self.r["crew"]
        self.assertGreater(c["station"], 0)
        self.assertEqual(c["atStation"], c["station"])           # at the bay when the run starts
        self.assertGreater(c["riding"], 0)                       # then away on the engine
        self.assertGreater(c["scene"], 0)
        self.assertEqual(c["atScene"], c["scene"])
        self.assertTrue(set(c["jobs"]) <= {"firefighter", "officer"}, c["jobs"])

    def test_patient(self):
        m = self.r["medical"]
        self.assertEqual(m["lying"], ["lie"])
        self.assertEqual(m["away"], 1)                           # in the ambulance, not on the street
        self.assertEqual(m["awayVisible"], 0)
        self.assertGreater(m["ambo"], 0)

    def test_match_day(self):
        m = self.r["match"]
        self.assertGreater(m["joined"], 50)
        self.assertGreater(m["cheer"], 20)
        self.assertGreater(m["near"], 20)
        self.assertGreater(m["inside"], 50)
        self.assertEqual(m["insideVisible"], 0)
        self.assertGreater(m["outAfter"], 5)
        self.assertEqual(m["early"], 0)

    def test_school_market_festival(self):
        s = self.r["school"]
        self.assertGreater(s["joined"], 5)
        self.assertGreater(s["near"], 0)
        self.assertGreater(s["noon"], 5)
        self.assertEqual(s["noonVisible"], 0)                   # in class
        self.assertTrue(s["jobless"])
        self.assertGreater(self.r["market"]["max"], 3)
        self.assertGreater(self.r["festival"]["cheer"], 5)
        self.assertEqual(self.r["where"]["state"], "gawk")

    def test_deterministic_and_indexed(self):
        d = self.r["det"]
        self.assertEqual(d["diff"], 0)
        self.assertGreater(d["pairs"], 200)
        self.assertEqual(d["idx"], 0)                            # the index answers as asking everyone does

    def test_continuity(self):
        j = self.r["jump"]
        self.assertGreater(j["n"], 10000)
        self.assertLess(j["walk"], 2.5, j)
        self.assertLess(j["any"], 8, j)

    def test_on_the_sidewalks(self):
        g = self.r["geo"]
        self.assertGreater(g["checked"], 1000)
        self.assertEqual(g["inBlock"], 0)
        self.assertEqual(g["onWater"], 0)
        self.assertEqual(g["badY"], 0)
        self.assertTrue({"lie", "cheer", "idle", "walk"} <= set(g["anims"]), g["anims"])

    def test_speech_about_events(self):
        s = self.r["speak"]
        self.assertTrue(s["same"])
        self.assertEqual(s["html"], 0)                           # the street's markup is stripped
        self.assertGreater(s["fire"] + s["gawk"], 0)
        self.assertGreater(s["match"], 0)

    def test_visible_cost(self):
        p = self.r["perf"]
        self.assertEqual(p["pop"], 2000)
        self.assertTrue(all(c < p["pop"] / 3 for c in p["cand"]), p["cand"])
        self.assertLess(max(p["ms"]), 3.0, p)


REAL_HARNESS = r"""
var fs = require("fs"), root = %(root)s;
global.window = {HQV: {}};
new Function(fs.readFileSync(root + "/games/citysim.js", "utf8"))();
new Function(fs.readFileSync(root + "/games/npcsim.js", "utf8"))();
var S = window.HQV.npcSim, doc = JSON.parse(fs.readFileSync(root + "/tests/fixtures/npc_town@2.json", "utf8"));
var H = S.HOUR, DAY = S.DAY, MIN = 60000, D0 = 20*DAY, out = {};   // 1970-01-21: a Wednesday (match, market, school)
var D = window.HQV.citySim.create(doc, {tier: 5, seed: "town"});
var C = S.create(doc, {tier: 5, grow: 1000, seed: "town", city: D, clockTzMin: 0});
var match = D.events(D0, D0 + DAY).filter(function(e){ return e.kind === "match"; })[0];
var st = C.places.filter(function(p){ return p.key === "site:" + match.site; })[0];
var seen = {}, anims = {}, t0 = Date.now(), idx = 0, pairs = 0;
for(var h = 6; h < 24; h += 0.25){
  var t = D0 + h*H;
  C.joined(t).forEach(function(j){ seen[j.kind] = 1; });
  var rows = C.at(t, {x: 0, z: 0}, 5000);
  rows.forEach(function(r){ anims[r.anim] = 1; });
  rows.filter(function(r, i){ return i % 29 === 0; }).forEach(function(r){
    pairs++; if(JSON.stringify(C.at(t, r, 80)) !== JSON.stringify(C.atScan(t, r, 80))) idx++;
  });
}
var ms = Date.now() - t0;
function fans(t){ var ids = {}; C.joined(t).forEach(function(j){ if(j.kind === "fan") ids[j.id] = 1; });
  return C.at(t, {x: 0, z: 0}, 5000).filter(function(r){ return ids[r.id]; }); }
var before = fans(match.kick - 6*MIN), during = fans(match.kick + H);
out = {seen: Object.keys(seen).sort(), anims: Object.keys(anims).sort(), ms: ms, idx: idx, pairs: pairs,
       cheer: before.filter(function(r){ return r.anim === "cheer" && Math.hypot(r.x - st.x, r.z - st.z) < 200; }).length,
       during: during.length, joinedDuring: C.joined(match.kick + H).filter(function(j){ return j.kind === "fan"; }).length};
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE and os.path.exists(FIXTURE) and os.path.exists(os.path.join(ROOT, "games", "citysim.js")),
                     "node, the fixture and games/citysim.js needed")
class NpcRealCityTest(unittest.TestCase):
    """The residents on the real director (games/citysim.js) for a whole Wednesday."""
    @classmethod
    def setUpClass(cls):
        js = REAL_HARNESS.replace("%(root)s", json.dumps(ROOT))
        p = subprocess.run([NODE, "-e", js], capture_output=True, text=True, timeout=300)
        if p.returncode != 0:
            raise AssertionError("node harness failed:\n" + p.stderr[-4000:])
        cls.r = json.loads(p.stdout)

    def test_everyone_reacts(self):
        self.assertTrue({"gawk", "crew", "patient", "fan", "pupil", "shopper"} <= set(self.r["seen"]), self.r["seen"])
        self.assertTrue({"walk", "idle", "lie", "cheer"} <= set(self.r["anims"]), self.r["anims"])

    def test_match_on_the_real_clock(self):
        self.assertGreater(self.r["cheer"], 20)                  # outside before kick-off
        self.assertGreater(self.r["joinedDuring"], 50)
        self.assertEqual(self.r["during"], 0)                    # inside for the match

    def test_index_and_cost(self):
        self.assertGreater(self.r["pairs"], 100)
        self.assertEqual(self.r["idx"], 0)
        self.assertLess(self.r["ms"], 8000, self.r["ms"])        # 72 whole-town asks with every event built


FRAME_HARNESS = r"""
var fs = require("fs"), zlib = require("zlib"), root = %(root)s;
global.window = {HQV: {}};
["world", "roadsmooth", "citysim", "npcsim"].forEach(function(f){ new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))(); });
var HQV = window.HQV, W = HQV.world.pack(JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/claude-hq@2.json.gz"))));
var doc = HQV.world.docOf(W), D = HQV.citySim.create(doc, {seed: W.id, tier: 5, coverage: 0.6});
function make(){ return HQV.npcSim.create(doc, {tier: 5, seed: W.seed || W.id, city: D, clockTzMin: 0}); }
var t0 = Date.UTC(2026, 9, 24, 13, 0, 0), out = {};   // a Saturday: a match at 15:00
function ms(f){ var a = process.hrtime.bigint(); var r = f(); return [Number(process.hrtime.bigint() - a)/1e6, r]; }
var A = make(), B = make();
out.prewarm = ms(function(){ return A.warm(t0, 1e9); })[0];
out.first = ms(function(){ return A.at(t0, {x: 0, z: 0}, 150); })[0];
var worst = 0, diff = 0;
for(var s = 1; s < 2*3600; s++){
  var t = t0 + s*1000; A.warm(t, 3);
  var r = ms(function(){ return A.at(t, {x: 0, z: 0}, 150); }); worst = Math.max(worst, r[0]);
  if(s %% 120 === 0 && JSON.stringify(r[1]) !== JSON.stringify(B.at(t, {x: 0, z: 0}, 150))) diff++;
}
out.worst = worst; out.diff = diff;
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE and os.path.exists(os.path.join(ROOT, "games", "citysim.js")), "node and games/citysim.js needed")
class NpcCityFrameCost(unittest.TestCase):
    """On the Commons (claude-hq@2, roads smoothed) with the real director at tier 5 through a Saturday match: once
    warmed at setup, no frame's at() builds a crowd (warm() does it a little at a time, ahead), and the rows are
    the same as a cold instance's."""
    @classmethod
    def setUpClass(cls):
        js = FRAME_HARNESS.replace("%(root)s", json.dumps(ROOT)).replace("%%", "%")
        p = subprocess.run([NODE, "-e", js], capture_output=True, text=True, timeout=300)
        if p.returncode != 0:
            raise AssertionError("node harness failed:\n" + p.stderr[-4000:])
        cls.r = json.loads(p.stdout)

    def test_frames_stay_in_budget(self):
        self.assertLess(self.r["first"], 20, self.r)             # the first frame after the setup warm
        self.assertLess(self.r["worst"], 8, self.r)              # 2 h of frames, events coming and going
        self.assertEqual(self.r["diff"], 0)                      # warm() changes when, never what


if __name__ == "__main__":
    unittest.main()
