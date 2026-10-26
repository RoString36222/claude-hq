"""City play's core (games/cityplay.js, HQ 3.22): the one small hub every City feature plugs into.

Under node with no DOM and no three.js: features register (once per id, in order), each City instance creates them
with one ctx, frames and events reach every feature, a feature's blocked() blocks, one feature throwing never stops
the others, HQV.cityPlay.emit is safe with no City, and dispose ends it all. And hqcity3d.js and hq3d.js wire it in.
Skipped without node."""
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


SCRIPT = r"""
var fs = require("fs"), root = %(root)s;
global.window = {HQV: {}};
new Function(fs.readFileSync(root + "/games/cityplay.js", "utf8"))();
var P = window.HQV.cityPlay, log = [], out = {};
out.emitNoCity = (function(){ try { P.emit("blast", {x: 0, z: 0}); return true; } catch(e){ return false; } })();
P.register({id: "b", order: 2, create: function(ctx){ return {update: function(dt, f){ log.push("b" + f.n); }, on: function(k){ log.push("b:" + k); },
                                                       blocked: function(x){ return x > 10; }, dispose: function(){ log.push("bx"); }}; }});
P.register({id: "a", order: 1, create: function(ctx){ return {update: function(){ throw new Error("boom"); }}; }});   // replaced below
P.register({id: "a", order: 1, create: function(ctx){ return {update: function(dt, f){ log.push("a" + f.n); }, on: function(k, d){ log.push("a:" + k + d.n); }}; }});
P.register({id: "bad"}); P.register({id: "c", create: function(){ throw new Error("no"); }});
out.features = P.features();
var heard = []; var off = P.on(function(k){ heard.push(k); });
var city = P.create(null, {W: {id: "claude-hq@3"}});
city.update(0.016, {n: 1}); P.emit("ram", {n: 7}); off(); city.emit("shot", {n: 8});
out.log = log; out.heard = heard; out.blocked = [city.blocked(5, 0), city.blocked(20, 0)];
out.live = P.live() === city; out.store = city.ctx.store.get("x", 3); city.ctx.store.set("x", 4); out.store2 = city.ctx.store.get("x", 3);
var c2 = P.create(null, {W: {id: "claude-hq@3"}}); out.same = c2.ctx.seed === city.ctx.seed && city.ctx.seed > 0; c2.dispose();
city.dispose(); city.update(0.016, {n: 2}); out.after = log.slice(-1)[0];
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class Core(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", SCRIPT % {"root": json.dumps(ROOT)}], capture_output=True, text=True, timeout=60)
        if r.returncode:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_features_register_once_in_order(self):
        self.assertTrue(self.o["emitNoCity"])
        self.assertEqual(self.o["features"], ["c", "a", "b"])

    def test_frames_and_events_reach_every_feature(self):
        self.assertEqual(self.o["log"][:4], ["a1", "b1", "a:ram7", "b:ram"])
        self.assertEqual(self.o["heard"], ["ram"])
        self.assertEqual(self.o["blocked"], [False, True])
        self.assertTrue(self.o["live"])
        self.assertTrue(self.o["same"], "the seed is a pure function of the world")

    def test_store_and_dispose(self):
        self.assertEqual(self.o["store"], 3)
        self.assertEqual(self.o["store2"], 4)
        self.assertEqual(self.o["after"], "bx")


class Wiring(unittest.TestCase):
    def test_the_city_and_the_player_wire_it_in(self):
        city, hq = read("games", "hqcity3d.js"), read("games", "hq3d.js")
        self.assertIn("play = HQV.cityPlay.create(THREE, {", city)
        self.assertIn("if(play && !playSkip && play.blocked(x, z)) return true;", city)
        self.assertIn("if(play){ try { play.dispose(); } catch(e){} play = null; }", city)
        for k in ('"ram"', '"blast"', '"shot"'):
            self.assertIn("HQV.cityPlay.emit(" + k, hq)


if __name__ == "__main__":
    unittest.main()
