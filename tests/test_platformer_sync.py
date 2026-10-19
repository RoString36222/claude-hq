"""Platformer Rush: the browser and the Arena server must agree on the levels.

games/platformer/levels.json is mirrored byte-for-byte at backend-rs/data/platformer_levels.json
(the Rust Arena embeds that copy), and the level geometry in games/platformer.js (PLAT-LEVEL
block) must give the same answers as the referee in backend-rs/src/platformer.rs: the browser
lands, collects and counts checkpoints with the same shapes the server checks them with. The
browser's character must also stay inside the referee's limits.

The geometry is pinned by backend-rs/tests/platformer_golden.json: probes and their answers
(support, inside, in_foot, seg_dist, the compiled levels, the model footprints and the jump
apex), generated once from the last Python Arena (platformer.py at a1eda91~1)
and fixed by design. Node replays it through the JS here; backend-rs/src/platformer/tests.rs
replays the same file through the Rust. Stdlib only; the JS half runs under node when it is
installed."""
import json
import os
import re
import shutil
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from rsconst import rs_num, rs_path  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS = os.path.join(ROOT, "games", "platformer.js")
LEVELS = os.path.join(ROOT, "games", "platformer", "levels.json")
SERVER_LEVELS = os.path.join(ROOT, "backend-rs", "data", "platformer_levels.json")
GOLDEN = os.path.join(ROOT, "backend-rs", "tests", "platformer_golden.json")
PLAT_RS = rs_path("backend-rs", "src", "platformer.rs")
NODE = shutil.which("node")


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def block():
    return re.search(r"/\* PLAT-LEVEL BEGIN \*/(.*?)/\* PLAT-LEVEL END \*/", read(JS), re.S).group(1)


def js_num(name, src):
    m = re.search(r"\b%s\s*=\s*([0-9.]+)" % name, src)
    assert m, name
    return float(m.group(1))


def rs(name):
    return rs_num(PLAT_RS, name)


class PlatformerSync(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.gold = json.loads(read(GOLDEN))

    def test_level_file_is_mirrored(self):
        with open(LEVELS, "rb") as a, open(SERVER_LEVELS, "rb") as b:
            self.assertEqual(a.read(), b.read(), "copy games/platformer/levels.json to backend-rs/data/platformer_levels.json")

    def test_shared_constants_and_models_match(self):
        b = block()
        for name in ("PR", "PH", "CENTER"):
            self.assertEqual(js_num(name, b), rs(name), name)
        got = json.loads(re.search(r"var MODELS = (\{.*?\});", b, re.S).group(1))
        self.assertEqual({k: [v[0], float(v[1]), float(v[2]), float(v[3])] for k, v in got.items()}, self.gold["models"])

    def test_the_browsers_character_stays_inside_the_referees_limits(self):
        js = read(JS)
        run, grav, jump, djump, fall = (js_num(n, js) for n in ("RUN", "GRAV", "JUMP", "DJUMP", "FALL_MAX"))
        self.assertLess(run, rs("MAX_RUN"))
        self.assertLess(jump, rs("MAX_RISE"))
        self.assertLess(fall, rs("MAX_FALL"))
        self.assertLessEqual(jump, rs("S_JUMP"))
        self.assertLessEqual(djump, rs("S_DJUMP"))
        self.assertGreaterEqual(grav, rs("S_GRAV"))
        # the browser collects coins and counts checkpoints no further out than the server does
        self.assertLess(js_num("COIN_TAKE", js), rs("COIN_R"))
        self.assertLessEqual(js_num("CP_R", js), rs("CP_R"))
        self.assertLessEqual(js_num("FLAG_R", js), rs("FLAG_R"))
        # the client's apex (jump + double jump) is under the envelope's (the Rust test pins
        # lift_max(T_APEX) to the golden's h_apex)
        self.assertLess(jump * jump / (2 * grav) + djump * djump / (2 * grav), self.gold["h_apex"])

    @unittest.skipUnless(NODE, "node not installed")
    def test_geometry_matches_the_golden_under_node(self):
        g = self.gold
        data = json.loads(read(LEVELS))
        self.assertEqual([lv["id"] for lv in data["levels"]], [lv["id"] for lv in g["levels"]],
                         "the levels changed: regenerate platformer_golden.json from the last Python Arena")
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
""" % (json.dumps(data), json.dumps(g["probes"]), json.dumps(g["segs"]))
        # piped in: argv is capped at 128 KB per string on Linux, and the probes grow with the levels
        res = subprocess.run([NODE, "-"], input=script, capture_output=True, text=True, timeout=60)
        self.assertEqual(res.returncode, 0, res.stderr)
        got = json.loads(res.stdout)
        self.assertEqual(len(got["out"]), len(g["out"]))
        for p, js, want in zip(g["probes"], got["out"], g["out"]):
            self.assertEqual(js, want, p)
        for d, want in zip(got["seg"], g["seg"]):
            self.assertAlmostEqual(d, want, places=9)

        def norm(v):
            return [list(map(float, x)) if isinstance(x, list) else float(x) for x in v] if isinstance(v, list) else v

        for c, L in zip(got["levels"], g["levels"]):
            for k in ("bounds", "spawns", "cps", "flag", "kill", "goal", "secs"):
                self.assertEqual(norm(c[k]), norm(L[k]), (L["id"], k))
            self.assertEqual(len(c["solids"]), len(L["solids"]))
            for a, b in zip(c["solids"], L["solids"]):
                self.assertEqual(a["m"], b["m"])
                for k in ("x0", "x1", "y0", "y1", "z0", "z1", "cx", "cz", "r"):
                    self.assertAlmostEqual(a[k], b[k], places=9, msg=(L["id"], k))


if __name__ == "__main__":
    unittest.main()
