"""City play: police heat (games/playheat.js, HQ 3.22), light-hearted GTA-style stars.

Under node on the @3 fixture (tests/fixtures/claude-hq@3.json.gz) with the vendored three and the real City play core
(games/cityplay.js), a fake traffic sim (cars placed where a test wants them, optional lightAt), a fake engine (its
siren pool records what it is asked to play) and a fake hq3d context (teleport recorded):
your own blasts near traffic raise the stars, someone else's don't; the stars decay when no police car can see you and
"You lost them" pays a little rep; the pursuit cars come along the road graph toward you; standing still by one is
"Busted" (station door, heat 0, rep down, never below 0); a red light run in front of the police counts; Calm has no
siren and steady lightbars; dispose takes every mesh out.
"""
import json
import math
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
const root = %(root)s;
globalThis.window = {HQV: {}};
for (const f of ["world", "hqnav", "cityplay", "playheat"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const THREE = await import(root + "/games/vendor/three-module.js");
const H = window.HQV, WD = H.world, NAV = H.hqnav, CP = H.cityPlay, out = {};
const W = WD.pack(JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/claude-hq@3.json.gz")).toString("utf8")));
const G = NAV.graph(W, 5);
const station = W.sites.filter(function(s){ return s.kind === "police"; })[0], door = NAV.doorOf(station);
// a spot on a road 300 m from the station
function roadPt(x, z){ const s = NAV.snap(G, x, z); return {x: s.x, z: s.z}; }
const P0 = roadPt(door.x + 300, door.z + 200), P1 = roadPt(door.x + 120, door.z + 60);

function world(o){
  o = o || {};
  const scene = new THREE.Scene(), events = [], pools = {}, tele = [];
  const E = {pool: function(kind){ const p = pools[kind] = {updates: [], stopped: false}; return {update: function(src){ p.updates.push(src.length); }, stop: function(){ p.stopped = true; }}; },
             loop: function(){ return {set: function(){}}; }, engineSound: function(){ return {set: function(){}}; }};
  const cars = o.cars || [];
  const tsim = {tier: 5, at: function(ms, c, r){ return cars.filter(function(v){ return Math.hypot(v.x - c.x, v.z - c.z) <= r; }); }};
  if(o.lightAt) tsim.lightAt = o.lightAt;
  const store = {};
  const play = CP.create(THREE, {scene: scene, W: W, worldId: W.id, tsim: tsim, nsim: null, c: {E: E, teleport: function(x, z, yaw){ tele.push({x: x, z: z}); }},
                                 calm: function(){ return !!o.calm; }, blocked: o.blocked || function(){ return false; }, groundY: function(){ return 0; }});
  play.ctx.store.set("rep", o.rep != null ? o.rep : 10);
  const off = CP.on(function(k, d){ events.push([k, d]); });
  const heat = play.feature("heat");
  const at = o.at || P0, me = {x: at.x, y: 0, z: at.z, yaw: 0};
  let ms = Date.UTC(2026, 9, 26, 12);
  function step(secs, motion, each){
    for(let i = 0; i < Math.round(secs*20); i++){
      ms += 50; if(each) each(i);
      play.update(0.05, {ms: ms, local: ms, me: me, motion: Object.assign({speed: 0, ride: null, yaw: me.yaw}, motion || {}), traffic: o.traffic || []});
    }
  }
  return {scene: scene, play: play, heat: heat, events: events, pools: pools, tele: tele, me: me, step: step, cars: cars, off: off,
          kinds: function(k){ return events.filter(function(e){ return e[0] === k; }).map(function(e){ return e[1]; }); }};
}

// ---- blasts: yours near traffic count, someone else's never, yours in an empty spot neither ----
(function(){
  const w = world({cars: [{kind: "car", x: P0.x + 5, z: P0.z}, {kind: "car", x: P0.x - 6, z: P0.z + 2}, {kind: "car", x: P0.x, z: P0.z + 8}]});
  CP.emit("blast", {x: P0.x, z: P0.z, k: 0, mine: false});
  const theirs = w.heat.stars();
  CP.emit("blast", {x: P0.x + 500, z: P0.z + 500, k: 0, mine: true});
  const empty = w.heat.stars();
  CP.emit("blast", {x: P0.x, z: P0.z, k: 0, mine: true});
  out.blast = {theirs: theirs, empty: empty, mine: w.heat.stars(), heat: w.kinds("heat")};
  // rams: slow ones don't, a fast one into a car does; a person; props add a little at a time
  w.heat.clear();
  CP.emit("ram", {x: P0.x + 4, z: P0.z, speed: 5});
  const slow = w.heat.stars();
  CP.emit("ram", {x: P0.x + 4, z: P0.z, speed: 12});
  out.ram = {slow: slow, fast: w.heat.stars()};
  w.heat.clear(); CP.emit("ram", {what: "person", x: P0.x, z: P0.z}); out.ram.person = w.heat.stars();
  w.heat.clear(); CP.emit("ram", {what: "prop", x: P0.x, z: P0.z}); out.ram.prop = [w.heat.stars(), w.heat.heat()];
  w.heat.clear(); CP.emit("shot", {x: P0.x, z: P0.z}); out.shot = w.heat.stars();
  w.heat.clear(); w.play.dispose(); w.off();
})();

// ---- the chase: cars come along the roads toward you (you drive away, unseen behind walls: they lose you) ----
(function(){
  // walls everywhere but the roads' own points near a car or you: nobody sees down a street (LOS samples are blocked)
  const w = world({blocked: function(){ return true; }, rep: 2});
  w.heat.add(1, "test");
  const first = {stars: w.heat.stars(), hud: null};
  let d0 = null, onRoad = [], seenAny = false;
  w.step(8, {speed: 10, ride: "car"}, function(i){
    const c = w.heat.chasers();
    if(c.length && d0 == null) d0 = Math.hypot(c[0].x - w.me.x, c[0].z - w.me.z);
    if(i %% 20 === 0) c.forEach(function(k){ onRoad.push(NAV.snap(G, k.x, k.z).d); });
    if(w.heat.seen()) seenAny = true;
  });
  const c = w.heat.chasers();
  out.chase = {first: first, n: c.length, d0: d0, d1: c.length ? Math.hypot(c[0].x - w.me.x, c[0].z - w.me.z) : null, onRoad: Math.max.apply(null, onRoad.concat([0])), seenAny: seenAny,
               meshes: w.scene.getObjectByName("playheat-cars").count};
  w.step(20, {speed: 10, ride: "car"});
  out.lost = {stars: w.heat.stars(), escaped: w.kinds("escaped"), rep: w.play.ctx.store.get("rep"), heat: w.kinds("heat").map(function(h){ return h.stars; })};
  w.play.dispose(); w.off();
})();

// ---- seen: the stars stay while they can see you; hidden in the metro they go faster ----
(function(){
  const w = world({at: P1});
  w.heat.add(2, "test");
  // a car parked right by you (a clear line): you are seen and the stars stay
  let stars = [];
  w.step(30, {speed: 10, ride: "car"}, function(i){ if(i %% 100 === 0) stars.push(w.heat.stars()); });
  out.seen = {stars: stars, end: w.heat.stars(), seen: w.heat.seen(), n: w.heat.chasers().length};
  w.heat.clear();
  H.hqUnderground = {under: function(){ return true; }};
  w.heat.add(2, "test"); let t = 0;
  w.step(40, {speed: 10, ride: "car"}, function(){ if(w.heat.stars() > 0) t += 0.05; });
  delete H.hqUnderground;
  out.metro = {t: t, stars: w.heat.stars()};
  w.play.dispose(); w.off();
})();

// ---- busted: on foot, they reach you; at the station door, heat 0, rep down (never below 0) ----
(function(){
  const w = world({rep: 3, at: P1});
  w.heat.add(1, "test");
  let at = null;
  w.step(90, {speed: 0, ride: null}, function(i){ if(at == null && w.heat.busting()) at = i*0.05; });
  out.busted = {at: at, events: w.kinds("busted"), stars: w.heat.stars(), rep: w.play.ctx.store.get("rep"), tele: w.tele, door: door, n: w.heat.chasers().length};
  w.play.dispose(); w.off();
  // in a car: slow next to one for 3 s
  const v = world({rep: 20, at: P1});
  v.heat.add(1, "test");
  let at2 = null;
  v.step(90, {speed: 0.5, ride: "car"}, function(i){ if(at2 == null && v.heat.busting()) at2 = i*0.05; });
  out.bustedCar = {at: at2, rep: v.play.ctx.store.get("rep")};
  v.play.dispose(); v.off();
})();

// ---- red lights: running one with a police car by counts; with none (and no camera) it doesn't ----
(function(){
  // which junctions have a camera: a pure function of the world's seed and the signal (1 in 4)
  const seed = CP.hashStr(W.seed || W.id), cam = function(sig){ return CP.hashStr(seed + ":cam:" + sig) %% 4 === 0; };
  let plain = null, camd = null;
  for(let i = 0; i < 64 && (plain == null || camd == null); i++){ const s = "j" + i; if(cam(s)){ if(camd == null) camd = s; } else if(plain == null) plain = s; }
  function lights(sig, state){ let d = 12; return function(){ d -= 1.5; return d > -1 ? {state: state || "red", sig: sig, dist: d} : null; }; }
  const a = world({lightAt: lights(plain), traffic: [{kind: "police", x: P0.x + 20, z: P0.z}]});
  a.step(1.5, {speed: 12, ride: "car"});
  const b = world({lightAt: lights(plain), traffic: []});
  b.step(1.5, {speed: 12, ride: "car"});
  const c = world({lightAt: lights(camd), traffic: []});
  c.step(1.5, {speed: 12, ride: "car"});
  const g = world({lightAt: lights(plain, "green"), traffic: [{kind: "police", x: P0.x + 20, z: P0.z}]});
  g.step(1.5, {speed: 12, ride: "car"});
  out.red = {seen: a.heat.stars(), unseen: b.heat.stars(), camera: c.heat.stars(), green: g.heat.stars(), why: a.kinds("heat").map(function(h){ return h.why; })};
  [a, b, c, g].forEach(function(w){ w.play.dispose(); w.off(); });
})();

// ---- four stars: a roadblock across the road ahead of you; the cars are solid ----
(function(){
  const w = world({});
  const R = NAV.route(G, P0, roadPt(P0.x + 900, P0.z - 600), "drive");
  w.heat.add(4, "test");
  let s = 0, blocks = null;
  w.step(12, {speed: 15, ride: "car"}, function(){
    s = Math.min(R.len - 1, s + 0.75);
    let i = 0; while(i + 2 < R.cum.length && R.cum[i + 1] < s) i++;
    const t = (s - R.cum[i])/Math.max(1e-6, R.cum[i + 1] - R.cum[i]), dx = R.pts[2*i + 2] - R.pts[2*i], dz = R.pts[2*i + 3] - R.pts[2*i + 1];
    w.me.x = R.pts[2*i] + dx*t; w.me.z = R.pts[2*i + 1] + dz*t; w.me.yaw = Math.atan2(dx, dz);
    const b = w.heat.chasers().filter(function(c){ return c.kind === "block"; });
    if(b.length && !blocks) blocks = {cars: b, me: {x: w.me.x, z: w.me.z}, solid: b.every(function(c){ return w.play.blocked(c.x, c.z); }),
                                       apart: Math.hypot(b[0].x - b[1].x, b[0].z - b[1].z), road: b.map(function(c){ return NAV.snap(G, c.x, c.z).d; })};
  });
  out.block = blocks;
  out.block.open = w.play.blocked(w.me.x + 500, w.me.z + 500);
  w.play.dispose(); w.off();
})();

// ---- calm: no siren, steady lightbars; dispose leaves nothing ----
(function(){
  function colours(w){ const m = w.scene.getObjectByName("playheat-lamps"); return m && m.instanceColor ? Array.from(m.instanceColor.array.slice(0, 6)).map(function(v){ return Math.round(v*100); }) : null; }
  const loud = world({}), quiet = world({calm: true});
  [loud, quiet].forEach(function(w){ w.heat.add(5, "test"); });
  const lc = [], qc = [];
  for(let i = 0; i < 8; i++){ loud.step(0.1, {speed: 10, ride: "car"}); quiet.step(0.1, {speed: 10, ride: "car"}); lc.push(JSON.stringify(colours(loud))); qc.push(JSON.stringify(colours(quiet))); }
  const sl = loud.pools.siren ? loud.pools.siren.updates : [], sq = quiet.pools.siren ? quiet.pools.siren.updates : [];
  out.calm = {loudSiren: Math.max.apply(null, sl.concat([0])), quietSiren: Math.max.apply(null, sq.concat([0])),
              loudFlash: new Set(lc).size, quietFlash: new Set(qc).size, heli: !!loud.heat.heli(), heliShown: loud.scene.getObjectByName("playheat-heli").visible};
  const before = loud.scene.children.length;
  loud.play.dispose(); quiet.play.dispose(); loud.off(); quiet.off();
  let left = 0; loud.scene.traverse(function(o){ if(/^playheat/.test(o.name || "")) left++; });
  out.dispose = {before: before, after: loud.scene.children.length, left: left, sirenStopped: !!(loud.pools.siren && loud.pools.siren.stopped)};
})();

console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE and os.path.exists(FIXTURE), "node or the @3 fixture missing")
class PlayHeat(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "--input-type=module", "-e", HARNESS % {"root": json.dumps(ROOT)}], capture_output=True, text=True, timeout=600)
        if r.returncode:
            raise AssertionError(r.stderr[-4000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_your_blasts_raise_heat_but_not_others(self):
        b = self.o["blast"]
        self.assertEqual(b["theirs"], 0, "someone else's grenade is not your heat")
        self.assertEqual(b["empty"], 0, "a blast with nobody near")
        self.assertEqual(b["mine"], 2, "your blast by three cars")
        self.assertEqual(b["heat"][-1]["stars"], 2)
        self.assertTrue(b["heat"][-1]["why"])

    def test_rams_props_and_shots(self):
        r = self.o["ram"]
        self.assertEqual(r["slow"], 0)
        self.assertEqual(r["fast"], 1)
        self.assertEqual(r["person"], 1)
        self.assertEqual(r["prop"][0], 0)
        self.assertGreater(r["prop"][1], 0)
        self.assertEqual(self.o["shot"], 1)

    def test_chasers_drive_the_roads_toward_you(self):
        c = self.o["chase"]
        self.assertEqual(c["first"]["stars"], 1)
        self.assertGreaterEqual(c["n"], 1)
        self.assertLess(c["onRoad"], 3, "on the road graph while they route")
        self.assertIsNotNone(c["d0"])
        self.assertLess(c["d1"], c["d0"] - 30, "closer after 8 s")
        self.assertFalse(c["seenAny"], "walls: no line of sight")
        self.assertEqual(c["meshes"], c["n"])

    def test_decays_without_line_of_sight_and_escape_pays(self):
        lost = self.o["lost"]
        self.assertEqual(lost["stars"], 0)
        self.assertEqual(len(lost["escaped"]), 1)
        self.assertEqual(lost["rep"], 2 + lost["escaped"][0]["reward"])
        self.assertEqual(lost["heat"], [1, 0])

    def test_seen_keeps_the_stars_and_hiding_is_faster(self):
        s = self.o["seen"]
        self.assertEqual(s["end"], 2, s)
        self.assertTrue(s["seen"])
        m = self.o["metro"]
        self.assertEqual(m["stars"], 0)
        self.assertLess(m["t"], 0.5 * ((12 + 6 * 2) + (12 + 6)))   # 2 stars unseen in the open: 24 + 18 s

    def test_busted_on_foot_and_in_a_car(self):
        b = self.o["busted"]
        self.assertIsNotNone(b["at"], "they reach you")
        self.assertEqual(len(b["events"]), 1)
        self.assertEqual(b["stars"], 0)
        self.assertEqual(b["rep"], 0, "3 - 5 stays at 0")
        self.assertEqual(b["events"][0]["penalty"], 3)
        self.assertEqual(len(b["tele"]), 1)
        self.assertAlmostEqual(b["tele"][0]["x"], b["door"]["x"], 3)
        self.assertEqual(b["n"], 0)
        c = self.o["bustedCar"]
        self.assertIsNotNone(c["at"])
        self.assertEqual(c["rep"], 15)

    def test_red_light_needs_a_witness(self):
        r = self.o["red"]
        self.assertEqual(r["seen"], 1)
        self.assertEqual(r["unseen"], 0)
        self.assertEqual(r["camera"], 1, "a camera junction sees it")
        self.assertEqual(r["green"], 0)
        self.assertIn("ran a red light", r["why"])

    def test_roadblock_at_four_stars_is_solid(self):
        b = self.o["block"]
        self.assertIsNotNone(b, "a roadblock went up")
        self.assertEqual(len(b["cars"]), 2)
        self.assertTrue(b["solid"])
        self.assertFalse(b["open"])
        self.assertAlmostEqual(b["apart"], 5, 1)
        self.assertLess(max(b["road"]), 4, "on the road")
        d = min(math.hypot(c["x"] - b["me"]["x"], c["z"] - b["me"]["z"]) for c in b["cars"])
        self.assertGreater(d, 50)

    def test_calm_has_no_siren_and_steady_lights(self):
        c = self.o["calm"]
        self.assertGreater(c["loudSiren"], 0)
        self.assertEqual(c["quietSiren"], 0)
        self.assertGreater(c["loudFlash"], 1)
        self.assertEqual(c["quietFlash"], 1)
        self.assertTrue(c["heli"] and c["heliShown"], "five stars: the helicopter")

    def test_dispose_removes_meshes(self):
        d = self.o["dispose"]
        self.assertEqual(d["left"], 0)
        self.assertLess(d["after"], d["before"])
        self.assertTrue(d["sirenStopped"])

    def test_registered_and_wired(self):
        with open(os.path.join(ROOT, "games", "playheat.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('register({id: "heat"', src)
        self.assertNotIn("Math.random", src)
        self.assertNotIn("fetch(", src)


if __name__ == "__main__":
    unittest.main()
