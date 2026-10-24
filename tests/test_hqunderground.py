"""Going below ground (games/hqunderground.js, docs/plans/transport-revamp.md 3.3, 5.7).

node loads hqmetro.js and hqunderground.js, builds the metro from the synthetic @3 layer in tests/test_hqmetro.py and
checks the pure decisions (walking down and up an entrance's stairs with hysteresis, E at an entrance and in a station,
riding past a portal mouth, lifts) and the controller (a 0.6 s fade with the switch at its midpoint; Calm and rides cut;
the announcements; the teleport; one switch at a time). Skipped when node is not installed. Stdlib only."""
import importlib.util
import json
import math
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")


def metro_fixture():
    spec = importlib.util.spec_from_file_location("hqmetro_fixture", os.path.join(ROOT, "tests", "test_hqmetro.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.metro_fixture()


HARNESS = r"""
const fs = require("fs");
const root = %(root)s, doc = %(doc)s;
globalThis.window = {HQV: {}};
new Function(fs.readFileSync(root + "/games/hqmetro.js", "utf8"))();
new Function(fs.readFileSync(root + "/games/hqunderground.js", "utf8"))();
const H = window.HQV.hqMetro, U = window.HQV.hqUndergroundCtl, out = {};
const sim = H.create(doc, {tier: 5}), L = sim.layout();
const E = L.entrances.find(e => e.station === "metro:0" && e.kind === "stairs");
const lift = L.entrances.find(e => e.kind === "lift");
const C = L.entrances.find(e => e.station === "metro:1" && e.kind === "stairs");
function along(e, u){ return {x: e.x + Math.sin(e.yaw)*u, z: e.z + Math.cos(e.yaw)*u}; }
function rampY(e, u){ const r = L.rampAt(along(e, u).x, along(e, u).z); return r ? r.y : null; }
const st0 = L.byId["metro:0"], plat = st0.plats[0];
const d = (under, me) => U.decide(under, me, L);
const top = along(E, 0.3), deep = along(E, E.run*0.6), shallow = along(E, E.run*0.15);
out.street = {E: {x: E.x, y: E.y, z: E.z, yaw: E.yaw, run: E.run, foot: E.foot}};
out.dec = {
  atTop: d(false, {x: top.x, y: E.y, z: top.z}),
  walkDown: d(false, {x: deep.x, y: rampY(E, E.run*0.6), z: deep.z}),
  walkUp: d(true, {x: top.x, y: rampY(E, 0.3), z: top.z}),
  midDown: d(false, {x: along(E, 1.6/0.7*0.85).x, y: E.y - 1.3, z: along(E, 1.6/0.7*0.85).z}),
  midUp: d(true, {x: along(E, 1.6/0.7*0.85).x, y: E.y - 1.3, z: along(E, 1.6/0.7*0.85).z}),
  keyEnt: d(false, {x: E.x - Math.sin(E.yaw)*2, y: E.y, z: E.z - Math.cos(E.yaw)*2, key: "E"}),
  keyFar: d(false, {x: E.x + 40, y: E.y, z: E.z + 40, key: "E"}),
  keyLift: d(false, {x: lift.x, y: lift.y, z: lift.z, key: "E"}),
  walkLift: d(false, {x: lift.x + Math.sin(lift.yaw)*1.2, y: lift.y, z: lift.z + Math.cos(lift.yaw)*1.2}),
  keyPlat: d(true, {x: plat.r.cx, y: plat.y0, z: plat.r.cz, key: "E"}),
  platNoKey: d(true, {x: plat.r.cx, y: plat.y0, z: plat.r.cz}),
  rideIn: d(false, {x: 0, y: -10, z: 0, riding: {under: true, line: "M1", to: "Central"}}),
  rideOut: d(true, {x: 0, y: 2, z: 0, riding: {under: false, line: "M1"}}),
  rideSame: d(true, {x: 0, y: -10, z: 0, riding: {under: true}}),
  teleported: d(false, {x: plat.r.cx, y: plat.y0, z: plat.r.cz}),
  lost: d(true, {x: 3000, y: 2, z: 3000})
};
out.exit = L.exitTo("metro:0", plat.r.cx, plat.r.cz);
out.text = {down: U.text("down", {name: "Harbour Street", lines: ["M1", "M2"]}), one: U.text("down", {name: "Gate", lines: ["M1"]}),
            ride: U.text("down", {ride: {line: "M1", to: "Central"}}), up: U.text("up", {})};
// the controller
function run(calm, steps){
  const log = [];
  const ctl = U.create({metro: null, sim, calm: () => calm, announce: t => log.push(["say", t]), fade: ms => log.push(["fade", ms]),
                        set: (on, why) => log.push(["set", on, why]), teleport: p => log.push(["tp", Math.round(p.x*100)/100, Math.round(p.z*100)/100])});
  const states = steps.map(([ms, me, use]) => { const r = use ? ctl.use(ms, me) : ctl.step(ms, me); return use ? {used: r, st: ctl.state()} : Object.assign({}, r, {st: ctl.state()}); });
  return {log, states};
}
const down = {x: deep.x, y: rampY(E, E.run*0.6), z: deep.z};
out.fade = run(false, [[0, down], [100, down], [299, down], [300, down], [450, down], [600, down], [700, {x: top.x, y: rampY(E, 0.3), z: top.z}], [1000, {x: top.x, y: E.y, z: top.z}], [1300, {x: top.x, y: E.y, z: top.z}]]);
out.calm = run(true, [[0, down], [10, down], [20, {x: top.x, y: rampY(E, 0.3), z: top.z}]]);
out.ride = run(false, [[0, {x: 0, y: -10, z: 0, riding: {under: true, line: "M1", to: "Central"}}], [5, {x: 0, y: 2, z: 0, riding: {under: false, line: "M1"}}]]);
const cent = L.byId["metro:1"];
out.key = run(true, [[0, {x: C.x, y: C.y, z: C.z}, true], [10, {x: cent.plats[0].r.cx, y: cent.plats[0].y0, z: cent.plats[0].r.cz}, true], [20, {x: 4000, y: 2, z: 4000}, true]]);
out.keyFoot = {x: C.foot.x, z: C.foot.z};
out.force = (() => { const log = []; const ctl = U.create({sim, set: (on, w) => log.push([on, w]), announce: t => log.push(t)}); ctl.force(true, "tour"); ctl.force(true, "tour"); ctl.force(false); return {log, under: ctl.under()}; })();
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class Underground(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", HARNESS % {"root": json.dumps(ROOT), "doc": json.dumps(metro_fixture())}],
                           capture_output=True, text=True, timeout=120)
        if r.returncode:
            raise AssertionError(r.stderr[-4000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])
        cls.d = cls.o["dec"]

    def test_walking_down_and_up_the_stairs(self):
        self.assertIsNone(self.d["atTop"], "standing at the top of the stairs is still the street")
        w = self.d["walkDown"]
        self.assertEqual((w["go"], w["reason"], w["cut"], w["station"]), ("down", "walk", False, "metro:0"))
        self.assertNotIn("teleport", w, "walking keeps you where you are")
        u = self.d["walkUp"]
        self.assertEqual((u["go"], u["reason"]), ("up", "walk"))

    def test_hysteresis(self):
        self.assertIsNone(self.d["midDown"], "1.3 m down is not yet underground")
        self.assertIsNone(self.d["midUp"], "and from below, 1.3 m down is not yet the street")

    def test_e_at_an_entrance_takes_you_down(self):
        k = self.d["keyEnt"]
        self.assertEqual((k["go"], k["reason"]), ("down", "key"))
        foot = self.o["street"]["E"]["foot"]
        self.assertAlmostEqual(k["teleport"]["x"], foot["x"], places=6)
        self.assertAlmostEqual(k["teleport"]["y"], foot["y"], places=6)
        self.assertIsNone(self.d["keyFar"])
        self.assertEqual(self.d["keyLift"]["go"], "down", "a lift is E only")
        self.assertIsNone(self.d["walkLift"], "you do not walk down a lift")

    def test_e_in_a_station_takes_you_up(self):
        k = self.d["keyPlat"]
        self.assertEqual((k["go"], k["reason"], k["station"]), ("up", "key", "metro:0"))
        self.assertAlmostEqual(k["teleport"]["x"], self.o["exit"]["x"], places=6)
        self.assertAlmostEqual(k["teleport"]["y"], self.o["exit"]["y"], places=6)
        self.assertIsNone(self.d["platNoKey"], "standing on the platform stays underground")

    def test_riding_past_a_portal_mouth(self):
        i, o = self.d["rideIn"], self.d["rideOut"]
        self.assertEqual((i["go"], i["reason"], i["cut"]), ("down", "ride", True))
        self.assertEqual((o["go"], o["reason"], o["cut"]), ("up", "ride", True))
        self.assertIsNone(self.d["rideSame"])

    def test_put_below_or_lost(self):
        self.assertEqual(self.d["teleported"]["go"], "down")
        self.assertTrue(self.d["teleported"]["cut"])
        self.assertEqual(self.d["lost"]["go"], "up")

    def test_texts(self):
        t = self.o["text"]
        self.assertEqual(t["down"], "Underground: Harbour Street station, M1 and M2")
        self.assertEqual(t["one"], "Underground: Gate station, M1")
        self.assertEqual(t["ride"], "Underground: M1 to Central")
        self.assertEqual(t["up"], "Back at street level")

    def test_fade_switches_at_the_midpoint(self):
        log, st = self.o["fade"]["log"], self.o["fade"]["states"]
        self.assertEqual(log[0], ["fade", 600])
        sets = [e for e in log if e[0] == "set"]
        self.assertEqual(sets[0], ["set", True, "walk"])
        self.assertEqual(st[0]["phase"], "out"); self.assertFalse(st[0]["under"])
        self.assertFalse(st[2]["under"], "not yet at 299 ms")
        self.assertTrue(st[3]["under"], "switched at 300 ms")
        self.assertEqual(st[4]["phase"], "in")
        self.assertEqual(st[5]["phase"], "idle")
        says = [e[1] for e in log if e[0] == "say"]
        self.assertTrue(says[0].startswith("Underground: ") and says[0].endswith(" station, M1"), says)
        self.assertEqual(len([e for e in sets if e[1] is True]), 1, "one switch while the fade runs")
        # walking back up
        self.assertIn(["set", False, "walk"], sets)
        self.assertEqual(says[-1], "Back at street level")
        self.assertFalse(st[-1]["under"])

    def test_calm_cuts(self):
        log, st = self.o["calm"]["log"], self.o["calm"]["states"]
        self.assertNotIn("fade", [e[0] for e in log], "Calm: no fade")
        self.assertEqual(log[0], ["set", True, "walk"])
        self.assertTrue(st[0]["under"])
        self.assertEqual(st[0]["phase"], "idle")
        self.assertEqual(len([e for e in log if e[0] == "set"]), 2, "down, then up")

    def test_rides_cut(self):
        log = self.o["ride"]["log"]
        self.assertNotIn("fade", [e[0] for e in log])
        self.assertEqual([e for e in log if e[0] == "set"], [["set", True, "ride"], ["set", False, "ride"]])
        says = [e[1] for e in log if e[0] == "say"]
        self.assertEqual(says, ["Underground: M1 to Central", "Back at street level"])

    def test_use_and_teleport(self):
        st, log = self.o["key"]["states"], self.o["key"]["log"]
        self.assertEqual([s["used"] for s in st], [True, True, False])
        tps = [e for e in log if e[0] == "tp"]
        self.assertEqual(len(tps), 2)
        self.assertAlmostEqual(tps[0][1], round(self.o["keyFoot"]["x"], 2), places=2)
        says = [e[1] for e in log if e[0] == "say"]
        self.assertEqual(says[0], "Underground: Central station, M1 and M2")
        self.assertEqual(says[1], "Back at street level")

    def test_force(self):
        f = self.o["force"]
        self.assertEqual([e for e in f["log"] if isinstance(e, list)], [[True, "tour"], [False, "force"]])
        self.assertFalse(f["under"])


if __name__ == "__main__":
    unittest.main()
