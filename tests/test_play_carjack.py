"""The garage's cars on the street and carjacking (HQ 3.27): games/traffic.js's models, games/playcarjack.js.

Under node on the @3 fixture (tests/fixtures/claude-hq@3.json.gz) with the vendored three, the real catalogue
(games/vehicles/catalogue.json) and the real stand-in bodies (games/hqvehiclemodels.js):
  - traffic.streetCars picks a few everyday catalogue cars (no bikes, Formula 1, hyper or super cars), the same every
    time; carLook gives every car a model and one of its paints from a hash of its id (no Math.random);
  - view() draws the nearest ordinary cars of the 08:15 rush as those models, one InstancedMesh each (a few more draw
    calls, not one per car), each body inside the sim's car footprint (SPEC.car), painted per instance; taxis, vans,
    lorries, buses keep their own bodies; without hqvehiclemodels.js (or without the catalogue) it is today's box car;
  - the carjack feature (with the real City play core and police heat): on foot by a stopped ordinary car the prompt
    is "E  Take the car"; not by a moving one, a taxi, a van, from afar or while you ride; E (take) seats you in that
    car's look (hq3d's ctx.carjack gets its model, paint, place and heading), announces "You took the car", hides that
    vehicle from the traffic the City draws and collides with (hide), and only a police car close by makes it heat
    ("stealing a car", half a star); once hq3d lets it go the traffic car is back;
  - the City and hq3d are wired: hqcity3d filters the traffic through the feature, hq3d keeps the prompt on E.
Skipped without node. Stdlib only."""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
FIXTURE = os.path.join(ROOT, "tests", "fixtures", "claude-hq@3.json.gz")


def read(*p):
    with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
        return f.read()


HARNESS = r"""
import fs from "fs";
import zlib from "zlib";
const root = %(root)s;
globalThis.window = {HQV: {}};
for (const f of ["world", "citylife", "traffic", "hqvehiclemodels", "cityplay", "playheat", "playcarjack"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const THREE = await import(root + "/games/vendor/three-module.js");
const H = window.HQV, WD = H.world, T = H.traffic, CP = H.cityPlay, out = {};
const CAT = JSON.parse(fs.readFileSync(root + "/games/vehicles/catalogue.json", "utf8"));
const W = WD.pack(JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/claude-hq@3.json.gz")).toString("utf8")));
const MON = Date.UTC(2026, 9, 26), HR = 36e5;
const sim = T.create(WD.docOf(W), {tier: 5, seed: W.id, W: W, local: 0});

// ---- the models: which, and each car's look ----
const M = T.streetCars(CAT), M2 = T.streetCars(JSON.parse(JSON.stringify(CAT)));
out.models = {ids: M.map(function(e){ return e.id; }), classes: M.map(function(e){ return e["class"]; }), same: JSON.stringify(M.map(function(e){ return e.id; })) === JSON.stringify(M2.map(function(e){ return e.id; })),
              N: T.MODEL_N, near: T.MODEL_NEAR, none: T.streetCars(null).length, noCars: T.streetCars({vehicles: CAT.vehicles.filter(function(v){ return /^bike\./.test(v["class"]); })}).length};
const ids = []; for(let i = 0; i < 400; i++) ids.push("car:" + i);
const looks = ids.map(function(id){ return T.carLook(id, M); });
out.looks = {again: JSON.stringify(looks) === JSON.stringify(ids.map(function(id){ return T.carLook(id, M); })),
             used: Array.from(new Set(looks.map(function(l){ return l.i; }))).length,
             paints: Array.from(new Set(looks.map(function(l){ return l.id + ":" + l.paint; }))).length,
             valid: looks.every(function(l){ const e = M[l.i]; return e && e.id === l.id && l.paint >= 0 && l.paint < e.paints.length && parseInt(e.paints[l.paint].hex.slice(1), 16) === l.hex; }),
             none: T.carLook("car:1", []) === null};

// ---- the view: the rush hour round the middle, with models and without ----
const list = sim.at(MON + 8.25*HR, {x: 0, z: 0}, 420);
function drawn(V){
  const n = V.update(list, MON + 8.25*HR), meshes = {};
  Object.keys(V.meshes).forEach(function(k){ if(V.meshes[k].count) meshes[k] = V.meshes[k].count; });
  return {n: n, calls: V.drawCalls(), meshes: meshes};
}
const VM = H.hqVehicleModels;
delete H.hqVehicleModels;
const V0 = T.view({THREE: THREE, catalogue: function(){ return CAT; }}), before = drawn(V0);
out.box = {before: before, models: V0.models().length, look: V0.look(list.filter(function(v){ return T.modelled(v); })[0])};
H.hqVehicleModels = VM;
const Vn = T.view({THREE: THREE, catalogue: function(){ return null; }});
out.noCatView = {models: Vn.models().length, calls: drawn(Vn).calls};
const V = T.view({THREE: THREE, catalogue: function(){ return CAT; }}), after = drawn(V);
const geo = {};
Object.keys(V.meshes).filter(function(k){ return /^model\d$/.test(k); }).forEach(function(k){
  const g = V.meshes[k].geometry; g.computeBoundingBox(); const b = g.boundingBox;
  geo[k] = {len: b.max.z - b.min.z, wid: b.max.x - b.min.x, y0: b.min.y, h: b.max.y - b.min.y, tris: g.attributes.position.count/3,
            paint: !!g.attributes.hqPaint, painted: Array.from(g.attributes.hqPaint.array).some(function(v){ return v === 1; }) && Array.from(g.attributes.hqPaint.array).some(function(v){ return v === 0; }),
            instanced: !!V.meshes[k].isInstancedMesh};
});
// each modelled car's instance colour is its look's paint (the nearest MODEL_NEAR ordinary cars)
const mc = {}, col = new THREE.Color();
let paintOk = true, checked = 0;
list.filter(function(v){ return T.modelled(v); }).slice(0, T.MODEL_NEAR).forEach(function(v){
  const lk = V.look(v), m = V.meshes["model" + lk.i], j = mc[lk.i] = (mc[lk.i] || 0);
  mc[lk.i]++;
  m.getColorAt(j, col);
  if(col.getHex() !== lk.hex) paintOk = false;
  checked++;
});
const tally = {}; list.forEach(function(v){ const k = v.kind === "car" ? v.type || "car" : v.kind; tally[k] = (tally[k] || 0) + 1; });
out.view = {after: after, geo: geo, paintOk: paintOk, checked: checked, tally: tally, spec: T.SPEC.car, plain: list.filter(function(v){ return T.modelled(v); }).length,
            hide: (function(){ const v = list.filter(function(v){ return T.modelled(v); })[0], h = {}; h[v.id] = true; return V.update(list, MON + 8.25*HR, {hide: h}).car; })()};
V.dispose(); V0.dispose(); Vn.dispose();

// ---- the carjack feature, with the City play core and the police ----
function city(o){
  o = o || {};
  const scene = new THREE.Scene(), events = [], said = [], took = [];
  let held = null;
  const c = {catalogue: function(){ return o.noCat ? null : CAT; },
             carjack: function(look){ if(o.refuse) return false; took.push(look); held = look.vid; return true; },
             carjacked: function(){ return held; }};
  const play = CP.create(THREE, {scene: scene, W: null, worldId: "test", tsim: {tier: 5, at: function(){ return []; }}, c: c,
                                 api: {announce: function(t){ said.push(t); }}, blocked: function(){ return false; }, groundY: function(){ return 0; }});
  const off = CP.on(function(k, d){ events.push([k, d]); });
  const J = play.feature("carjack"), heat = play.feature("heat");
  let ms = MON + 9*HR;
  function step(traffic, motion, me){ ms += 50; play.update(0.05, {ms: ms, local: ms, me: me || {x: 0, y: 0, z: 0, yaw: 0}, motion: Object.assign({speed: 0, ride: null, yaw: 0}, motion || {}), traffic: traffic}); }
  return {play: play, J: J, heat: heat, events: events, said: said, took: took, step: step, off: off, release: function(){ held = null; }};
}
const cars = [{id: "r4:7", kind: "car", type: "car", x: 10, y: 0, z: 0, yaw: 1.2, speed: 0},
              {id: "r4:8", kind: "car", type: "car", x: 10, y: 0, z: 30, yaw: 0, speed: 11},
              {id: "r5:1", kind: "car", type: "taxi", x: 40, y: 0, z: 0, yaw: 0, speed: 0},
              {id: "r5:2", kind: "car", type: "van", x: 70, y: 0, z: 0, yaw: 0, speed: 0},
              {id: "b1", kind: "bus", x: 100, y: 0, z: 0, yaw: 0, speed: 0}];
const cop = {id: "ev:police:3", kind: "police", x: 40, y: 0, z: 25, yaw: 0, speed: 0};
(function(){
  const a = city();
  a.step(cars);
  const p = {x: 12.5, z: 1};
  out.jack = {prompt: a.J.jackPrompt(p), far: a.J.jackPrompt({x: 16, z: 0}), moving: a.J.jackPrompt({x: 11, z: 30}), taxi: a.J.jackPrompt({x: 41, z: 0}),
              van: a.J.jackPrompt({x: 71, z: 0}), bus: a.J.jackPrompt({x: 101, z: 0}), viaCore: a.play.prompt(p), near: a.J.near(p)};
  a.step(cars, {ride: "car", speed: 0});
  out.jack.riding = a.J.jackPrompt(p);
  a.step(cars);
  out.jack.take = a.J.take(p);
  out.jack.took = a.took;
  out.jack.look = T.carLook("r4:7", M);
  out.jack.said = a.said;
  out.jack.event = a.events.filter(function(e){ return e[0] === "carjack"; }).map(function(e){ return e[1]; });
  out.jack.taken = a.J.taken();
  out.jack.hidden = a.J.hide(cars).map(function(v){ return v.id; });
  out.jack.again = a.J.jackPrompt(p);
  out.jack.heat = [a.heat.stars(), a.heat.heat()];
  a.release(); a.step(cars);
  out.jack.back = {taken: a.J.taken(), n: a.J.hide(cars).length, prompt: a.J.jackPrompt(p)};
  a.play.dispose(); a.off();
  // a police car within sight: half a star, "stealing a car"
  const b = city(), withCop = cars.concat([cop]);
  b.step(withCop); b.step(withCop);
  const ok = b.J.take(p);
  out.seen = {ok: ok, stars: b.heat.stars(), heat: b.heat.heat(), why: b.events.filter(function(e){ return e[0] === "heat"; }).map(function(e){ return e[1].why; }),
              hud: b.heat.heat() > 0};
  b.play.dispose(); b.off();
  // hq3d can't seat you (no catalogue vehicle, riding): nothing taken, nothing hidden, no news
  const c = city({refuse: true});
  c.step(withCop);
  out.refused = {take: c.J.take(p), taken: c.J.taken(), n: c.J.hide(cars).length, events: c.events.length, said: c.said.length, heat: c.heat.heat()};
  c.play.dispose(); c.off();
  // no catalogue yet (no models): no prompt
  const d = city({noCat: true});
  d.step(cars);
  out.noCat = {prompt: d.J.jackPrompt(p), take: d.J.take(p)};
  d.play.dispose(); d.off();
})();

console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE and os.path.exists(FIXTURE), "node or the @3 fixture missing")
class PlayCarjack(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "--input-type=module", "-e", HARNESS % {"root": json.dumps(ROOT)}], capture_output=True, text=True, timeout=600)
        if r.returncode:
            raise AssertionError(r.stderr[-4000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    # ---- the garage's cars on the street ----
    def test_street_models_are_everyday_catalogue_cars(self):
        m = self.o["models"]
        self.assertEqual(len(m["ids"]), m["N"])
        self.assertTrue(m["same"], "the same pick every time")
        for c in m["classes"]:
            self.assertTrue(c.startswith("car."), c)
            self.assertNotRegex(c, r"^car\.(formula|hyper|super)\.")
        self.assertGreaterEqual(len({c.split(".")[1] for c in m["classes"]}), 3, "a hatch, sedans, SUVs, a coupe")
        self.assertEqual(m["none"], 0)
        self.assertEqual(m["noCars"], 0, "bikes never drive as traffic cars")

    def test_each_car_gets_a_look_from_its_id(self):
        lk = self.o["looks"]
        self.assertTrue(lk["again"], "a pure function of the id")
        self.assertTrue(lk["valid"], "a model of the pick and one of its own paints")
        self.assertEqual(lk["used"], self.o["models"]["N"], "every model is on the street")
        self.assertGreater(lk["paints"], 15, "and in their paints")
        self.assertTrue(lk["none"])

    def test_models_are_instanced_within_the_budget(self):
        v, before = self.o["view"], self.o["box"]["before"]
        after = v["after"]
        near = min(self.o["models"]["near"], v["plain"])
        self.assertGreater(v["plain"], 20, "the rush round the middle")
        self.assertEqual(after["n"]["model"], near, "the nearest ordinary cars are models")
        self.assertEqual(after["n"]["car"], before["n"]["car"], "every car still drawn")
        models = sum(c for k, c in after["meshes"].items() if k.startswith("model"))
        self.assertEqual(models, after["n"]["model"])
        self.assertEqual(models + after["meshes"].get("car", 0), after["n"]["car"], "the rest (taxis, the far ones) box cars")
        self.assertLessEqual(after["calls"], before["calls"] + self.o["models"]["N"], "a draw call per model, not per car")
        self.assertLessEqual(after["calls"], 20)
        self.assertEqual(after["n"]["beacon"], before["n"]["beacon"], "taxis keep their roof signs")
        for k in ("van", "lorry", "bus", "scooter", "bike"):
            self.assertEqual(after["n"].get(k), before["n"].get(k), k)
        self.assertEqual(v["checked"], near)
        self.assertTrue(v["paintOk"], "each painted in its look's paint")
        self.assertEqual(v["hide"], after["n"]["car"] - 1, "a hidden vehicle is not drawn")

    def test_model_bodies_fit_the_car_spec(self):
        v = self.o["view"]
        self.assertEqual(len(v["geo"]), self.o["models"]["N"])
        for k, g in v["geo"].items():
            self.assertTrue(g["instanced"], k)
            self.assertLessEqual(g["len"], v["spec"]["len"] + 1e-3, k)
            self.assertLessEqual(g["wid"], v["spec"]["wid"] + 1e-3, k)
            self.assertGreater(g["len"], v["spec"]["len"] - 0.05, k + ": as long as the sim's car")
            self.assertAlmostEqual(g["y0"], 0, 3)
            self.assertGreater(g["h"], 0.9, k)
            self.assertLess(g["tris"], 8000, k)
            self.assertTrue(g["paint"] and g["painted"], k + ": paint marked, trim not")

    def test_fallback_without_models_is_the_box_car(self):
        b = self.o["box"]
        self.assertEqual(b["models"], 0)
        self.assertIsNone(b["look"])
        self.assertEqual(b["before"]["meshes"]["car"], b["before"]["n"]["car"])
        self.assertFalse(any(k.startswith("model") for k in b["before"]["meshes"]))
        self.assertEqual(self.o["noCatView"]["models"], 0)
        self.assertEqual(self.o["noCatView"]["calls"], b["before"]["calls"])

    # ---- carjacking ----
    def test_prompt_only_by_a_stopped_ordinary_car_on_foot(self):
        j = self.o["jack"]
        self.assertEqual(j["prompt"], "E  Take the car")
        self.assertIsNone(j["viaCore"], "not the City's F prompt: E gets you into a vehicle")
        self.assertEqual(j["near"]["vid"], "r4:7")
        for k in ("far", "moving", "taxi", "van", "bus", "riding"):
            self.assertIsNone(j[k], k)
        self.assertIsNone(self.o["noCat"]["prompt"])
        self.assertFalse(self.o["noCat"]["take"])

    def test_take_seats_you_in_that_car_and_hides_it(self):
        j = self.o["jack"]
        self.assertTrue(j["take"])
        self.assertEqual(len(j["took"]), 1)
        t, lk = j["took"][0], j["look"]
        self.assertEqual((t["model"], t["paint"], t["hex"]), (lk["id"], lk["paint"], lk["hex"]), "the look it had on the street")
        self.assertEqual((t["x"], t["z"], t["yaw"], t["vid"]), (10, 0, 1.2, "r4:7"))
        self.assertEqual(len(j["said"]), 1)
        self.assertTrue(j["said"][0].startswith("You took the car"), j["said"])
        self.assertEqual(j["event"], [{"x": 10, "z": 0, "id": "r4:7"}])
        self.assertEqual(j["taken"], "r4:7")
        self.assertNotIn("r4:7", j["hidden"])
        self.assertEqual(len(j["hidden"]), 4)
        self.assertIsNone(j["again"], "it is yours now")
        self.assertEqual(j["back"], {"taken": None, "n": 5, "prompt": "E  Take the car"}, "let go: back in the traffic")

    def test_heat_only_when_a_police_car_sees_it(self):
        self.assertEqual(self.o["jack"]["heat"], [0, 0], "nobody saw")
        s = self.o["seen"]
        self.assertTrue(s["ok"])
        self.assertAlmostEqual(s["heat"], 0.5, 6)
        self.assertEqual(s["stars"], 0, "half a star: no star for one car")
        r = self.o["refused"]
        self.assertFalse(r["take"])
        self.assertIsNone(r["taken"])
        self.assertEqual(r["n"], 5)
        self.assertEqual((r["events"], r["said"], r["heat"]), (0, 0, 0))

    # ---- wiring ----
    def test_city_and_hq3d_are_wired(self):
        city, hq3d, ui = read("games", "hqcity3d.js"), read("games", "hq3d.js"), read("ui", "app", "22-hq.js")
        self.assertIn('play.feature("carjack")', city)
        self.assertIn("callTraffic = JK.hide(callTraffic)", city)
        self.assertIn("w.jackPrompt = function(p)", city)
        self.assertIn("w.jack = function(p)", city)
        self.assertIn("carjack: function(o){ return jackTake(o); }", hq3d)
        self.assertIn("carjacked: function(){ return jack ? jack.vid : null; }", hq3d)
        # the prompt stays E (the world's own prompts are shown as F below it)
        hp = hq3d[hq3d.index("function hudPrompt(){"):]
        hp = hp[:hp.index("\n  }\n")]
        self.assertLess(hp.index("cur.jackPrompt"), hp.index('replace(/^E(\\s)/, "F$1")'))
        uk = hq3d[hq3d.index("function useKey(){"):]
        uk = uk[:uk.index("\n  }\n")]
        self.assertIn("cur.jack({x: avatar.x, z: avatar.z, yaw: avatar.yaw})", uk)
        self.assertLess(uk.index("rideToggle()"), uk.index("cur.jack("), "your own vehicle first")
        self.assertIn("jackStep();", hq3d)
        self.assertRegex(ui, r'"playstreet","playcarjack","playarena","hqcity3d"\]')
        self.assertIn("playcarjack:1", ui)
        self.assertLess(ui.index('"hqvehiclemodels"'), ui.index('"hqcity3d"]'), "the models load before the City builds its traffic")
        for f in ("playcarjack.js", "traffic.js"):
            src = read("games", f)
            self.assertNotIn("Math.random", src, f)
            self.assertNotIn("fetch(", src, f)
        self.assertIn('register({id: "carjack"', read("games", "playcarjack.js"))


if __name__ == "__main__":
    unittest.main()
