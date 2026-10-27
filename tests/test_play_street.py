"""City play: the street (HQ 3.22, games/playstreet.js, with the passers-by and crossings of games/npcsim.js and the dogs of
games/npcdraw.js).

Under node, on the @3 fixture (tests/fixtures/claude-hq@3.json.gz) packed by games/world.js, with games/citylife.js
loaded: the centre's pavements carry at least twice the people at lunchtime (the passers-by) and npcdraw draws more of
them; the passers-by are a pure function of (world, seed, local ms); they are on the carriageway only while crossing,
and only near a junction (a signal's kerb waits for walkAt); the street moments (busker, broken-down car, loose dog) are
deterministic and stand on footpaths; the dog walkers carry a dog; and the playstreet feature registers with
HQV.cityPlay and survives create / update / its hooks / dispose with a fake City (the vendored three.js). Skipped
without node. Stdlib only."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
FIXTURE = os.path.join(ROOT, "tests", "fixtures", "claude-hq@3.json.gz")

SCRIPT = r"""
var fs = require("fs"), zlib = require("zlib"), url = require("url"), root = %(root)s;
global.window = {HQV: {}};
for (var f of ["world", "citylife", "npcsim", "npcdraw", "cityplay", "playstreet"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
var HQV = window.HQV, WD = HQV.world, CL = HQV.cityLife, S = HQV.npcSim, D = HQV.npcDraw, PS = HQV.playStreet, CP = HQV.cityPlay, out = {};
var raw = zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/claude-hq@3.json.gz")).toString("utf8");
var W = WD.pack(JSON.parse(raw)), doc = WD.docOf(W), H = 36e5;
function at(day, h){ return Date.UTC(2026, 9, day, 0) + h*H; }        // 24 Saturday, 25 Sunday, 26 Monday (local ms)
var ALL = {x: 0, z: 0}, BIG = 5000, NOON = at(26, 12.5);
var sim = S.create(doc, {tier: 5, grow: 0, seed: "street", world: W}), noPass = S.create(doc, {tier: 5, grow: 0, seed: "street", world: W, passers: false});

// 1. more people on the centre's pavements: the 150 m round the busiest passer-by street's middle, with and without
var pass = sim.passers(NOON, ALL, BIG), best = null;
pass.forEach(function(r, i){ if(i % 7) return; var n = sim.at(NOON, r, 60).length; if(!best || n > best.n) best = {n: n, x: r.x, z: r.z}; });
function people(rows){ return rows.filter(function(r){ return r.anim !== "drive"; }).length; }
var c = {x: best.x, z: best.z};
// with and without the passers-by round the 10 busiest sampled spots: the median of their ratios (one spot alone may be
// a resident-heavy corner)
var spots = []; pass.forEach(function(r, i){ if(!(i % 7)) spots.push({n: sim.at(NOON, r, 60).length, x: r.x, z: r.z}); });
spots.sort(function(a, b){ return b.n - a.n || a.x - b.x || a.z - b.z; });
var ratios = spots.slice(0, 10).map(function(s){ return people(sim.at(NOON, s, 150))/Math.max(1, people(noPass.at(NOON, s, 150))); }).sort(function(a, b){ return a - b; });
out.pop = {with: people(sim.at(NOON, c, 150)), without: people(noPass.at(NOON, c, 150)), ratio: (ratios[4] + ratios[5])/2, night: sim.passers(at(26, 3.5), ALL, BIG).length,
           all: pass.length, streets: sim.passStreets().length, maxNear: D.MAX_NEAR, maxFar: D.MAX_FAR};
var t0 = Date.now(); for(var i = 0; i < 60; i++) sim.at(NOON + i*16, c, 150); out.pop.ms = (Date.now() - t0)/60;

// 2. deterministic: a second sim asked in another order agrees; and a person walks on (a pure function of the clock)
var sim2 = S.create(doc, {tier: 5, grow: 0, seed: "street", world: W}), times = [NOON + 300000, NOON, at(24, 17.2), at(25, 9.1)], same = true, n = 0;
var A = {}; times.forEach(function(t){ A[t] = sim.passers(t, ALL, BIG); });
times.slice().reverse().forEach(function(t){
  var b = sim2.passers(t, ALL, BIG), a = A[t];
  if(a.length !== b.length) same = false;
  for(var k = 0; k < Math.min(a.length, b.length); k++){ n++; if(a[k].id !== b[k].id || Math.abs(a[k].x - b[k].x) > 1e-6 || Math.abs(a[k].z - b[k].z) > 1e-6 || a[k].lk !== b[k].lk) same = false; }
});
var later = {}; sim.passers(NOON + 5000, ALL, BIG).forEach(function(r){ later[r.id] = r; });
var moved = 0, walkers = 0; A[NOON].forEach(function(r){ var q = later[r.id]; if(r.anim === "walk" && q && q.anim === "walk"){ walkers++; if(Math.hypot(q.x - r.x, q.z - r.z) > 3) moved++; } });
var other = S.create(doc, {tier: 5, grow: 0, seed: "street-2", world: W}).passers(NOON, ALL, BIG), diff = other.length !== A[NOON].length || other.some(function(r, k){ return !A[NOON][k] || Math.abs(r.x - A[NOON][k].x) > 0.01; });
out.det = {same: same, n: n, moved: moved, walkers: walkers, seedMatters: diff, extra: (sim.extra(A[NOON][0].id) || {}).kind, speak: sim.speak(A[NOON][0].id, NOON)};

// 3. crossings: on a carriageway only while crossing, and only near the street's end node
var nodes = {}; (doc.layers.roads.nodes || []).forEach(function(nd){ nodes[nd.id] = {x: nd.x/100, z: nd.z/100}; });
var streets = {}; sim.passStreets().forEach(function(s){ streets["edge:" + s.edge] = s; });
var cr = {road: 0, roadNotCrossing: 0, crossing: 0, farFromNode: 0, lot: 0, water: 0, n: 0};
[NOON, at(26, 8.3), at(24, 18), at(26, 15.2)].forEach(function(t){
  sim.passers(t, ALL, BIG).forEach(function(r){
    var sf = WD.surfaceAt(W, r.x, r.z); cr.n++;
    if(sf === "lot") cr.lot++;
    if(sf === "water") cr.water++;
    if(r.cross){
      cr.crossing++;
      var s = streets[r.spot], na = nodes[s.a], nb = nodes[s.b];
      var d = Math.min(Math.hypot(r.x - na.x, r.z - na.z), Math.hypot(r.x - nb.x, r.z - nb.z));
      if(d > Math.max(s.ca, s.len - s.cb) + 14) cr.farFromNode++;
    } else if(sf === "road"){
      cr.road++;
      // a footpath point counted as road: only where another road's paving meets it, at a junction
      var s2 = streets[r.spot], m2 = Math.min(Math.hypot(r.x - nodes[s2.a].x, r.z - nodes[s2.a].z), Math.hypot(r.x - nodes[s2.b].x, r.z - nodes[s2.b].z));
      if(m2 > Math.max(s2.ca, s2.len - s2.cb) + 14) cr.roadNotCrossing++;
    }
  });
});
out.cross = cr;

// 4. a signal at every junction (a stand-in for the traffic lights' HQV.cityLife.signals / walkAt): walk for the first 30 s
// of each minute; nobody starts crossing in the other 30 s, and some wait at the kerb meanwhile
var calls = 0;
CL.signals = function(w){ var o = {}; (w.nodes || []).forEach(function(nd){ o[nd.id] = {id: nd.id, x: nd.x/100, z: nd.z/100, r: 7, axes: [0, 1.5708], arms: []}; }); return o; };
CL.walkAt = function(sig, ms, heading){ calls++; return Math.floor(ms/30000) % 2 === 0; };
var sg = S.create(doc, {tier: 5, grow: 0, seed: "street", world: W}), sig = {crossInRed: 0, crossing: 0, waiting: 0, frames: 0, clear: 0};
for(var s = 0; s < 240; s += 5){
  var t = Math.floor(NOON/60000)*60000 + s*1000, red = Math.floor(t/30000) % 2 === 1, intoRed = (t % 30000)/1000;
  var rows = sg.passers(t, ALL, BIG); sig.frames++;
  rows.forEach(function(r){
    if(r.cross){ sig.crossing++; if(red && intoRed >= 25) sig.crossInRed++; }
    if(r.anim === "idle" && red) sig.waiting++;
  });
}
sig.clear = sg.passStreets().filter(function(s){ return s.signalA && s.signalB && s.ca >= 8; }).length;
sig.streets = sg.passStreets().length; sig.calls = calls;
delete CL.signals; delete CL.walkAt;
out.signal = sig;

// 5. the street moments: deterministic, off the carriageway, the kinds through a week
var kinds = {}, mom = {n: 0, bad: [], rows: 0, same: true, dogs: 0, cars: 0};
for(var hh = 0; hh < 24*7; hh += 1.5){
  var tm = at(20, 0) + hh*H, ms = PS.moments(W, "seed-a", tm), ms2 = PS.moments(W, "seed-a", tm);
  if(JSON.stringify(ms) !== JSON.stringify(ms2)) mom.same = false;
  ms.forEach(function(m){
    kinds[m.kind] = (kinds[m.kind] || 0) + 1; mom.n++;
    var sf = WD.surfaceAt(W, m.x, m.z); if(sf === "road" || sf === "lot" || sf === "water") mom.bad.push(m.kind + ":" + sf);
    var rs = PS.momentRows(W, m, tm, 600), rs2 = PS.momentRows(W, m, tm, 600);
    if(JSON.stringify(rs) !== JSON.stringify(rs2)) mom.same = false;
    rs.forEach(function(r){ mom.rows++; if(r.isDog) mom.dogs++; var s3 = WD.surfaceAt(W, r.x, r.z); if(s3 === "road" || s3 === "lot" || s3 === "water") mom.bad.push(m.kind + "/" + r.role + ":" + s3);
      if(!(r.id >= PS.MOMENT_IDS) || !(r.lk >= 0 && r.lk < 600)) mom.bad.push("id"); });
    if(m.kind === "breakdown") mom.cars++;
  });
}
mom.kinds = kinds;
mom.noon = PS.moments(W, "seed-a", NOON).length; mom.night = PS.moments(W, "seed-a", at(26, 3)).length;
mom.otherSeed = JSON.stringify(PS.moments(W, "seed-b", NOON)) !== JSON.stringify(PS.moments(W, "seed-a", NOON));
out.moments = mom;

// 6. dog walkers carry a dog; npcdraw's dog geometry and lead
var jog = sim.gather(at(26, 7.2), ALL, BIG).filter(function(r){ return r.crowd === "jog"; }), dogs = D.dogsOf(jog, 1e9, 1000);
out.dogs = {walkers: jog.filter(function(r){ return r.dog; }).length, joggers: jog.length, drawn: dogs.length, leads: dogs.filter(function(d){ return d.lead; }).length,
            ahead: dogs.length ? Math.hypot(dogs[0].x - dogs[0].lead[0], dogs[0].z - dogs[0].lead[2]) : 0, tris: D.dogGeometry().idx.length/3,
            loose: D.dogsOf([{id: 1, x: 0, z: 0, y: 0, yaw: 0, isDog: 1, d2: 1}]).length, far: D.dogsOf([{id: 1, x: 0, z: 0, y: 0, yaw: 0, isDog: 1, d2: 1e6}]).length};
// the flee curve
out.flee = [PS.flee(0), PS.flee(1), PS.flee(5), PS.flee(9.9), PS.flee(12.5), PS.flee(20)];

import(url.pathToFileURL(root + "/games/vendor/three-module.js").href).then(function(THREE){
  var scene = new THREE.Scene(), said = [], events = [], extrasFn = null, overrideFn = null, knocked = {}, unk = [];
  CP.on(function(k, d){ events.push([k, d]); });
  var spot = PS.foodSpots(W).filter(function(s){ return s.kind === "stall"; })[0];
  var furn = [{kind: "table", x: 10, y: 0, z: 10, yaw: 0}, {kind: "bench", x: 20, y: 0, z: 20, yaw: 0}];
  var fakeWb = {
    furnitureNear: function(x, z){ for(var i = 0; i < furn.length; i++){ var o = furn[i]; if(!knocked[o.x] && Math.hypot(x - o.x, z - o.z) < 0.9) return o; } return null; },
    furnitureKnock: function(o, on){ if(!!knocked[o.x] === !!on) return false; knocked[o.x] = !!on; return true; },
    furnitureKey: function(o){ return o.kind + ":" + o.x; },
    furnitureMesh: function(o){ return new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), 1); }
  };
  var fakeCev = {knockAt: function(x, z){ return Math.hypot(x - 40, z - 40) < 1.2 ? {key: "market:1|3", x: 40, y: 0, z: 40, yaw: 0, col: 0xd8443a, h: 0.2} : null; }, unknock: function(k){ unk.push(k); return true; }};
  var fakeDraw = {setExtras: function(fn){ extrasFn = fn; }, setOverride: function(fn){ overrideFn = fn; }};
  var LT = NOON;
  var inst = CP.create(THREE, {scene: scene, W: W, worldId: "test", nsim: sim, ndraw: fakeDraw, cev: fakeCev, wb: function(){ return fakeWb; },
    say: function(t){ said.push(t); }, local: function(){ return LT; }, groundY: function(){ return 0; }});
  var F = inst.feature("playstreet"), res = {registered: CP.features().indexOf("playstreet") >= 0, made: !!F, hooks: !!(extrasFn && overrideFn)};
  // the moments near the first busker at noon
  var bk = PS.moments(W, String(inst.ctx.seed), NOON).filter(function(m){ return m.kind === "busker"; })[0] || PS.moments(W, String(inst.ctx.seed), NOON)[0];
  var me = {x: bk.x + 3, y: 0, z: bk.z, yaw: 0};
  for(var fr = 0; fr < 10; fr++) inst.update(1/60, {ms: Date.now(), local: NOON + fr*16, me: me, motion: {ride: null, speed: 0}, cam: me});
  var ex = extrasFn(NOON, me) || [];
  res.moments = F.state().moments; res.extras = ex.length; res.extraSay = ex.filter(function(r){ return r.say; }).length;
  res.meshes = scene.getObjectByName("playstreet").children.length;
  // a blast: the people near it run away from it
  var rows = [{id: 1, x: me.x + 4, y: 0, z: me.z, yaw: 0, anim: "walk", speed: 1.3, d2: 1}, {id: 2, x: me.x + 60, y: 0, z: me.z, yaw: 0, anim: "walk", d2: 1}];
  inst.emit("blast", {x: me.x, z: me.z, k: 1});
  overrideFn(rows, NOON, 1/60, null);
  res.panic = {near: rows[0].anim, farAnim: rows[1].anim, state: F.state().reacting};
  // a speeding car: a person beside it flinches, one it reaches dives aside (and the City hears of it)
  var r3 = [{id: 3, x: 100 + 2, y: 0, z: 100 + 1, yaw: 0, anim: "walk", d2: 1}, {id: 4, x: 100.3, y: 0, z: 101, yaw: 0, anim: "walk", d2: 1}];
  inst.update(1/60, {ms: Date.now(), local: NOON, me: {x: 100, y: 0, z: 100, yaw: 0}, motion: {ride: "car", speed: 18}, cam: {x: 100, z: 100}});
  var x3 = r3[0].x; overrideFn(r3, NOON, 1/60, null);
  res.flinch = {moved: Math.abs(r3[0].x - x3) >= 0 && (r3[0].anim === "jog" || r3[0].anim === "idle"), dive: events.filter(function(e){ return e[0] === "ram" && e[1].what === "person"; }).length};
  // knocks: fast in a car into the table goes through it (and it falls), slow does not, a bench never does
  inst.update(1/60, {ms: Date.now(), local: NOON, me: {x: 9, y: 0, z: 9, yaw: 0.7}, motion: {ride: "car", speed: 3}, cam: {x: 9, z: 9}});
  res.slow = inst.through(10, 10);
  inst.update(1/60, {ms: Date.now(), local: NOON, me: {x: 9, y: 0, z: 9, yaw: 0.7}, motion: {ride: "car", speed: 11}, cam: {x: 9, z: 9}});
  res.fast = inst.through(10, 10); res.again = inst.through(10, 10);
  inst.update(1/60, {ms: Date.now(), local: NOON, me: {x: 19, y: 0, z: 19, yaw: 0.7}, motion: {ride: "car", speed: 11}, cam: {x: 19, z: 19}});
  res.bench = inst.through(20, 20);
  inst.update(1/60, {ms: Date.now(), local: NOON, me: {x: 39, y: 0, z: 39, yaw: 0.7}, motion: {ride: "car", speed: 11}, cam: {x: 39, z: 39}});
  res.stall = inst.through(40, 40);
  res.knocked = F.state().knocked; res.props = events.filter(function(e){ return e[0] === "ram" && e[1].what === "prop"; }).length;
  // far away: they stand up again
  inst.update(1/60, {ms: Date.now(), local: NOON, me: {x: 900, y: 0, z: 900, yaw: 0}, motion: null, cam: {x: 900, z: 900}});
  res.reset = {knocked: F.state().knocked, table: !!knocked[10], cev: unk.slice()};
  // a snack at a food stall, on foot
  if(spot){
    var p = {x: spot.x + 0.8, z: spot.z};
    inst.update(1/60, {ms: Date.now(), local: NOON, me: {x: p.x, y: 0, z: p.z, yaw: 0}, motion: {ride: null, speed: 0}, cam: p});
    res.prompt = inst.prompt(p); res.used = inst.use(p); res.mul = CP.sprintMul(); res.said = said.slice(-1)[0] || "";
    res.full = inst.use(p) && /full/.test(said.slice(-1)[0] || "");
    LT = at(26, 3); res.closed = inst.prompt(p);
    res.inCar = (function(){ inst.update(1/60, {ms: Date.now(), local: NOON, me: {x: p.x, y: 0, z: p.z, yaw: 0}, motion: {ride: "car", speed: 0}, cam: p}); return inst.prompt(p); })();
  }
  inst.dispose();
  res.disposed = {extras: extrasFn === null, scene: scene.children.length, mulAfter: CP.sprintMul()};
  // and a bare create with no THREE, no City: no throw
  var bare = CP.create(null, {W: null}); bare.update(0.016, {}); bare.emit("blast", {x: 0, z: 0}); bare.through(0, 0); bare.prompt({x: 0, z: 0}); bare.dispose();
  res.bare = true;
  out.feature = res;
  console.log(JSON.stringify(out));
}).catch(function(e){ console.error(e && e.stack || e); process.exit(1); });
"""


@unittest.skipUnless(NODE and os.path.exists(FIXTURE), "node and tests/fixtures/claude-hq@3.json.gz needed")
class PlayStreetTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        js = SCRIPT.replace("%(root)s", json.dumps(ROOT))
        p = subprocess.run([NODE, "-e", js], capture_output=True, text=True, timeout=300)
        if p.returncode != 0:
            raise AssertionError("node harness failed:\n" + p.stderr[-4000:])
        cls.o = json.loads(p.stdout.strip().splitlines()[-1])

    def test_more_people_on_the_pavements(self):
        p = self.o["pop"]
        self.assertGreaterEqual(p["ratio"], 2, p)                    # at least twice the people round the busiest streets
        self.assertGreater(p["with"], p["without"], p)
        self.assertGreater(p["all"], 300)
        self.assertGreater(p["streets"], 50)
        self.assertLess(p["night"], p["all"]*0.2, "fewer by night")
        self.assertGreaterEqual(p["maxNear"], 40)                    # npcdraw draws more of them
        self.assertGreaterEqual(p["maxFar"], 360)
        self.assertLess(p["ms"], 4, "sim.at with the passers-by, ms per call")

    def test_passers_by_are_deterministic(self):
        d = self.o["det"]
        self.assertTrue(d["same"])
        self.assertGreater(d["n"], 500)
        self.assertGreater(d["moved"], d["walkers"]*0.8, "five seconds on, the walkers have walked on")
        self.assertTrue(d["seedMatters"])
        self.assertEqual(d["extra"], "passer")
        self.assertTrue(isinstance(d["speak"], str) and len(d["speak"]) > 5)

    def test_crossings_only_at_junctions(self):
        c = self.o["cross"]
        self.assertGreater(c["n"], 1000)
        self.assertGreater(c["crossing"], 0)
        self.assertEqual(c["farFromNode"], 0, c)                     # a crossing is at a corner, never mid-block
        self.assertEqual(c["roadNotCrossing"], 0, c)
        self.assertLess(c["crossing"], c["n"]*0.25)
        self.assertEqual((c["lot"], c["water"]), (0, 0), c)

    def test_signals_hold_walkers_at_the_kerb(self):
        s = self.o["signal"]
        self.assertGreater(s["calls"], 0)                             # walkAt was asked
        self.assertGreater(s["crossing"], 0)
        self.assertEqual(s["crossInRed"], 0, s)                       # nobody starts across on don't-walk
        self.assertGreater(s["waiting"], 0)
        self.assertGreater(s["clear"], 0)                             # a signalled crossing keeps out of the junction box

    def test_street_moments(self):
        m = self.o["moments"]
        self.assertTrue(m["same"])
        self.assertEqual(m["bad"], [])                                # on footpaths: never on a carriageway, in a lot or the water
        for k in ("busker", "breakdown", "dog"):
            self.assertGreater(m["kinds"].get(k, 0), 0, k)
        self.assertGreater(m["noon"], 0)
        self.assertEqual(m["night"], 0)
        self.assertGreater(m["dogs"], 0)
        self.assertTrue(m["otherSeed"])

    def test_dog_walkers_have_dogs(self):
        d = self.o["dogs"]
        self.assertGreater(d["walkers"], 0)
        self.assertLess(d["walkers"], d["joggers"])
        self.assertEqual(d["drawn"], d["walkers"])
        self.assertEqual(d["leads"], d["walkers"])
        self.assertTrue(0.5 < d["ahead"] < 2.5, d)
        self.assertLessEqual(d["tris"], 140)
        self.assertEqual((d["loose"], d["far"]), (1, 0))
        f = self.o["flee"]
        self.assertEqual(f[0], 0)
        self.assertLess(f[1], f[2])
        self.assertGreater(f[3], 10)
        self.assertLess(f[4], f[3])
        self.assertEqual(f[5], 0)

    def test_feature_registers_and_survives(self):
        f = self.o["feature"]
        self.assertTrue(f["registered"])
        self.assertTrue(f["made"])
        self.assertTrue(f["hooks"])
        self.assertGreater(f["moments"], 0)
        self.assertGreater(f["extras"], 0)
        self.assertGreater(f["extraSay"], 0)
        self.assertGreater(f["meshes"], 0)
        self.assertEqual(f["panic"]["near"], "jog")
        self.assertEqual(f["panic"]["farAnim"], "walk")
        self.assertTrue(f["flinch"]["moved"])
        self.assertEqual(f["flinch"]["dive"], 1)
        self.assertFalse(f["slow"])
        self.assertTrue(f["fast"])
        self.assertFalse(f["again"])                                 # lying down: nothing left there to knock
        self.assertFalse(f["bench"])                                 # a bench stays put
        self.assertTrue(f["stall"])
        self.assertEqual(f["knocked"], 2)
        self.assertEqual(f["props"], 2)
        self.assertEqual(f["reset"]["knocked"], 0)
        self.assertFalse(f["reset"]["table"])
        self.assertEqual(f["reset"]["cev"], ["market:1|3"])
        self.assertTrue(f["prompt"].startswith("E  "))
        self.assertIn("(free)", f["prompt"])
        self.assertTrue(f["used"])
        self.assertAlmostEqual(f["mul"], 1.1)
        self.assertIn("Fed", f["said"])
        self.assertTrue(f["full"])
        self.assertIn("closed", f["closed"])
        self.assertIsNone(f["inCar"])
        self.assertTrue(f["disposed"]["extras"])
        self.assertEqual(f["disposed"]["scene"], 0)
        self.assertTrue(f["bare"])

    def test_wiring(self):
        def read(*a):
            with open(os.path.join(ROOT, *a), encoding="utf-8") as f:
                return f.read()
        city = read("games", "hqcity3d.js")
        self.assertIn("play.through(x, z)", city)                    # knocked props stop blocking
        self.assertIn("nsim.passers(npcMs(), {x: me0.x, z: me0.z}, 160)", city)   # cars wait for people crossing
        # walkAt takes the walker's heading: a passer-by crossing street e walks at a right angle to its arm
        self.assertIn("walkFrom(dir > 0 ? P.sb : P.sa, t1, (dir > 0 ? P.hb : P.ha) + Math.PI/2)", read("games", "npcsim.js"))
        self.assertIn("play.prompt(p)", city)
        self.assertIn("play.use(p)", city)
        self.assertIn("wb: function(){ return wb; }", city)
        hq3d = read("games", "hq3d.js")
        self.assertIn("HQV.cityPlay.sprintMul()", hq3d)
        self.assertIn("FOOT.run*runMul(inp)", hq3d)
        src = read("games", "playstreet.js")
        self.assertNotIn("Math.random(", src)
        self.assertNotIn("fetch(", src)
        self.assertNotIn("innerHTML", src)


if __name__ == "__main__":
    unittest.main()
