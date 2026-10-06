"""Platformer Rush: the browser and the Arena server must agree on the levels.

games/platformer/levels.json is mirrored byte-for-byte at backend/app/platformer_levels.json
(the server deploys backend/ only), and the level geometry in games/platformer.js
(PLAT-LEVEL block) must give the same answers as backend/app/platformer.py: the browser
lands, collects and counts checkpoints with the same shapes the server checks them with.
The browser's character must also stay inside the referee's limits. The server module is
stdlib-only, so it is loaded straight from its file. Stdlib only; the JS half runs under
node when it is installed."""
import importlib.util
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS = os.path.join(ROOT, "games", "platformer.js")
LEVELS = os.path.join(ROOT, "games", "platformer", "levels.json")
SERVER_LEVELS = os.path.join(ROOT, "backend", "app", "platformer_levels.json")
NODE = shutil.which("node")


def load_server():
    spec = importlib.util.spec_from_file_location("plat_server", os.path.join(ROOT, "backend", "app", "platformer.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def block():
    return re.search(r"/\* PLAT-LEVEL BEGIN \*/(.*?)/\* PLAT-LEVEL END \*/", read(JS), re.S).group(1)


def js_num(name, src):
    m = re.search(r"\b%s\s*=\s*([0-9.]+)" % name, src)
    assert m, name
    return float(m.group(1))


class PlatformerSync(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pf = load_server()

    def test_level_file_is_mirrored(self):
        with open(LEVELS, "rb") as a, open(SERVER_LEVELS, "rb") as b:
            self.assertEqual(a.read(), b.read(), "copy games/platformer/levels.json to backend/app/platformer_levels.json")

    def test_shared_constants_and_models_match(self):
        b = block()
        for name in ("PR", "PH", "CENTER"):
            self.assertEqual(js_num(name, b), float(getattr(self.pf, name)), name)
        models = re.search(r"var MODELS = (\{.*?\});", b, re.S).group(1)
        got = json.loads(models)
        self.assertEqual({k: (v[0], float(v[1]), float(v[2]), float(v[3])) for k, v in got.items()}, self.pf.MODELS)

    def test_the_browsers_character_stays_inside_the_referees_limits(self):
        js, pf = read(JS), self.pf
        run, grav, jump, djump, fall = (js_num(n, js) for n in ("RUN", "GRAV", "JUMP", "DJUMP", "FALL_MAX"))
        self.assertLess(run, pf.MAX_RUN)
        self.assertLess(jump, pf.MAX_RISE)
        self.assertLess(fall, pf.MAX_FALL)
        self.assertLessEqual(jump, pf.S_JUMP)
        self.assertLessEqual(djump, pf.S_DJUMP)
        self.assertGreaterEqual(grav, pf.S_GRAV)
        # the browser collects coins and counts checkpoints no further out than the server does
        self.assertLess(js_num("COIN_TAKE", js), pf.COIN_R)
        self.assertLessEqual(js_num("CP_R", js), pf.CP_R)
        self.assertLessEqual(js_num("FLAG_R", js), pf.FLAG_R)
        # the client's apex (jump + double jump) is under the envelope's
        self.assertLess(jump * jump / (2 * grav) + djump * djump / (2 * grav), pf.H_APEX)

    @unittest.skipUnless(NODE, "node not installed")
    def test_geometry_matches_under_node(self):
        pf = self.pf
        data = json.loads(read(LEVELS))
        probes = []
        for lv in data["levels"]:
            L = pf.LEVELS[lv["id"]]
            for s in L["solids"]:
                for dx, dy, dz in ((0, 0, 0), (0.9, 0.2, -0.4), (s["x1"] - s["cx"] + 0.25, 0.0, 0.1), (-2.6, 0.55, 2.4),
                                   (0.3, -0.2, 0.3), (0.0, -0.4, 0.0)):
                    probes.append([lv["id"], s["cx"] + dx, s["y1"] + dy, s["cz"] + dz])
        segs = [[[0, 0, 0], [2, 1, 0], [1, 1.5, 0.3]], [[1, 2, 3], [1, 2, 3], [0, 0, 0]], [[-1, 0, 4], [3, -2, 1], [5, 5, 5]]]
        script = block() + """
var data = %s, probes = %s, segs = %s, L = {}, out = [];
data.levels.forEach(function(lv){ L[lv.id] = PL.compileLevel(lv); });
probes.forEach(function(p){
  var lv = L[p[0]];
  out.push([PL.support(lv, p[1], p[2], p[3], PL.PR + 0.2, 0.6), PL.support(lv, p[1], p[2], p[3], -PL.PR, 0.01),
            PL.inside(lv, p[1], p[2], p[3]), lv.solids.map(function(s){ return PL.inFoot(s, p[1], p[3], 0.3); })]);
});
console.log(JSON.stringify({out: out, seg: segs.map(function(s){ return PL.segDist(s[0], s[1], s[2]); }),
  levels: data.levels.map(function(lv){ var c = L[lv.id]; return {solids: c.solids, bounds: c.bounds, goal: c.goal, secs: c.secs,
    spawns: c.spawns, cps: c.cps, flag: c.flag, kill: c.kill}; })}));
""" % (json.dumps(data), json.dumps(probes), json.dumps(segs))
        # piped in: argv is capped at 128 KB per string on Linux, and the probes grow with the levels
        res = subprocess.run([NODE, "-"], input=script, capture_output=True, text=True, timeout=60)
        self.assertEqual(res.returncode, 0, res.stderr)
        got = json.loads(res.stdout)
        for (lid, x, y, z), (sup, ground, ins, feet) in zip(probes, got["out"]):
            L = pf.LEVELS[lid]
            self.assertEqual(sup, pf.support(L, x, y, z, pf.PR + 0.2, 0.6), (lid, x, y, z))
            self.assertEqual(ground, pf.support(L, x, y, z, -pf.PR, 0.01), (lid, x, y, z))
            self.assertEqual(ins, pf.inside(L, x, y, z), (lid, x, y, z))
            self.assertEqual(feet, [pf.in_foot(s, x, z, 0.3) for s in L["solids"]])
        for (a, b, p), d in zip(segs, got["seg"]):
            self.assertAlmostEqual(d, pf.seg_dist(tuple(a), tuple(b), tuple(p)), places=9)
        for lv, c in zip(data["levels"], got["levels"]):
            L = pf.LEVELS[lv["id"]]
            for k in ("bounds", "spawns", "cps", "flag", "kill", "goal", "secs"):
                self.assertEqual(c[k] if not isinstance(c[k], list) else [list(map(float, x)) if isinstance(x, list) else float(x) for x in c[k]],
                                 L[k] if not isinstance(L[k], list) else [list(map(float, x)) if isinstance(x, list) else float(x) for x in L[k]], k)
            for a, b in zip(c["solids"], L["solids"]):
                self.assertEqual(a["m"], b["m"])
                for k in ("x0", "x1", "y0", "y1", "z0", "z1", "cx", "cz", "r"):
                    self.assertAlmostEqual(a[k], b[k], places=9, msg=(lv["id"], k))


if __name__ == "__main__":
    unittest.main()
