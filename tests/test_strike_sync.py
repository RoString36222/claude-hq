"""Strikezone: the browser and the Arena server must agree on the dock and the rules.

games/strike/map.json is mirrored byte-for-byte at backend-rs/data/strike_map.json (the
server embeds it at build time), and the shared geometry in games/strike.js (STRIKE-SHARED
block) must give the same answers as backend-rs/src/strike.rs: the browser predicts its own
movement with the same collision the server checks, and draws its shots with the same rays
and spread the server judges them with.

The geometry is pinned by backend-rs/tests/strike_golden.json: vectors generated once from
the last Python Arena (strike.py at a1eda91~1) and fixed by design. Node replays
them through the JS here; strike/tests.rs replays them through the Rust. The constants, the
weapon table and the host's menu choices are read straight out of the Rust source. The
referee's own behaviour (totems, drop rings, bots) is tested in backend-rs/src/strike/tests.rs.
Stdlib only; the JS half runs under node when it is installed (the script goes over stdin:
one argv string is capped at 128 KB on Linux)."""
import json
import os
import re
import shutil
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rsconst import rs_block, rs_num, rs_path  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STRIKE_JS = os.path.join(ROOT, "games", "strike.js")
STRIKE_RS = rs_path("backend-rs", "src", "strike.rs")
MAP = os.path.join(ROOT, "games", "strike", "map.json")
SERVER_MAP = os.path.join(ROOT, "backend-rs", "data", "strike_map.json")
GOLDEN = os.path.join(ROOT, "backend-rs", "tests", "strike_golden.json")
NODE = shutil.which("node")


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def block():
    return re.search(r"/\* STRIKE-SHARED BEGIN \*/(.*?)/\* STRIKE-SHARED END \*/", read(STRIKE_JS), re.S).group(1)


def rs_ints(name):
    return [int(x) for x in re.findall(r"-?\d+", rs_block(STRIKE_RS, name))]


def rs_weapons():
    """The Rust WEAPONS array as [{id, interval, damage, ...}] (field: literal pairs)."""
    out = []
    for body in re.findall(r"Weapon\s*\{([^}]*)\}", rs_block(STRIKE_RS, "WEAPONS")):
        w = {}
        for k, v in re.findall(r"(\w+)\s*:\s*(\"[^\"]*\"|-?[\d.]+)", body):
            w[k] = v.strip('"') if v.startswith('"') else float(v)
        out.append(w)
    return out


class StrikeSync(unittest.TestCase):
    def test_map_file_is_mirrored(self):
        with open(MAP, "rb") as a, open(SERVER_MAP, "rb") as b:
            self.assertEqual(a.read(), b.read(), "copy games/strike/map.json to backend-rs/data/strike_map.json")

    def test_constants_match(self):
        src = block()
        for name in ("R", "H", "EYE", "STEP_H", "RUN", "ACCEL", "AIR_ACCEL", "GRAVITY", "JUMP_V", "FALL_MAX",
                     "BODY_R", "BODY_H", "HEAD_R", "HEAD_TOP", "MISSILE_V", "MISSILE_G", "MISSILE_TTL",
                     "BLAST_R", "DIRECT_R"):
            m = re.search(r"\b%s\s*=\s*([0-9.]+)" % name, src)
            self.assertIsNotNone(m, name)
            self.assertEqual(float(m.group(1)), rs_num(STRIKE_RS, name), name)
        js = read(STRIKE_JS)
        self.assertLessEqual(float(re.search(r"\bRUN\s*=\s*([0-9.]+)", src).group(1)), rs_num(STRIKE_RS, "MAX_SPEED"))
        self.assertLessEqual(float(re.search(r"\bINTERP\s*=\s*([0-9.]+)", js).group(1)) +
                             float(re.search(r"\bJIT_MAX\s*=\s*([0-9.]+)", js).group(1)), rs_num(STRIKE_RS, "IP_CAP"))
        self.assertEqual(float(re.search(r"\bSWITCH\s*=\s*([0-9.]+)", js).group(1)), rs_num(STRIKE_RS, "SWITCH"))
        self.assertEqual(float(re.search(r"\bRESPAWN\s*=\s*([0-9.]+)", js).group(1)), rs_num(STRIKE_RS, "RESPAWN"))
        # the host's choices (Teams / First to) must be exactly what the server offers
        menus = re.search(r"var MINUTES = (\[[^\]]*\]), KILLS = (\[[^\]]*\]), TEAM_SIZES = (\[[^\]]*\]);", js)
        self.assertIsNotNone(menus, "var MINUTES = [...], KILLS = [...], TEAM_SIZES = [...]; in games/strike.js")
        for i, name in enumerate(("MINUTES", "KILLS", "TEAM_SIZES"), 1):
            self.assertEqual(json.loads(menus.group(i)), rs_ints(name), name)

    @unittest.skipUnless(NODE, "node not installed")
    def test_weapons_match(self):
        # FS.WEAPONS under node is the honest parse of the JS (regex over JS object literals is not)
        res = subprocess.run([NODE, "-"], input=block() + "\nconsole.log(JSON.stringify(FS.WEAPONS));",
                             capture_output=True, text=True, timeout=60)
        self.assertEqual(res.returncode, 0, res.stderr)
        js, rs = json.loads(res.stdout), rs_weapons()
        self.assertEqual([w["id"] for w in js], [w["id"] for w in rs], "same weapons, same order")
        for a, b in zip(js, rs):
            for k in ("interval", "damage", "head", "mag", "reserve", "reload", "spread", "range", "pack"):
                self.assertEqual(float(a[k]), b[k], (a["id"], k))

    @unittest.skipUnless(NODE, "node not installed")
    def test_shared_functions_match_the_golden_vectors(self):
        g = json.loads(read(GOLDEN))
        script = block() + """
var g = %s, m = FS.compileMap(%s), out = {rays: [], runs: [], spread: [], mb: [], over: []};
g.rays.forEach(function(r){
  var d = FS.dirOf(r.yaw, r.pitch);
  out.rays.push([d, FS.rayMap(m, r.o, d, 80), FS.rayPlayer(r.o, d, r.target[0], r.target[1], r.target[2], 80)]);
});
g.runs.forEach(function(rn){
  var s = {x: rn.start[0], y: rn.start[1], z: rn.start[2], vx: 0, vy: 0, vz: 0, g: true}, trace = [];
  rn.steps.forEach(function(st, j){ FS.move(m, s, st[0], st[1], st[2], 1/120); if(j %% 30 === 0) trace.push([s.x, s.y, s.z, s.g]); });
  out.runs.push(trace);
});
g.spread.forEach(function(row, n){ out.spread.push(row.map(function(_, w){ return FS.spreadOf(n, w); })); });
g.mb32.forEach(function(p){ out.mb.push(FS.mb32(p[0])); });
g.overlaps.forEach(function(p){ out.over.push(FS.overlaps(m, p[0], 0.2, p[1], 0.05)); });
console.log(JSON.stringify(out));
""" % (json.dumps({k: g[k] for k in ("rays", "runs", "spread", "mb32", "overlaps")}), read(MAP))
        res = subprocess.run([NODE, "-"], input=script, capture_output=True, text=True, timeout=120)
        self.assertEqual(res.returncode, 0, res.stderr)
        got = json.loads(res.stdout)
        self.assertEqual(len(got["rays"]), len(g["rays"]))
        for r, (d, tm, tpl) in zip(g["rays"], got["rays"]):
            for a, b in zip(d, r["dir"]):
                self.assertAlmostEqual(a, b, places=9)
            self.assertAlmostEqual(tm, r["map"], places=6)
            if r["player"] is None:
                self.assertIsNone(tpl, r)
            else:
                self.assertAlmostEqual(tpl[0], r["player"][0], places=6)
                self.assertEqual(tpl[1], r["player"][1])
        hits = sum(1 for r in g["rays"] if r["player"] is not None)
        self.assertTrue(0 < hits < len(g["rays"]), "the vectors hit and miss players")
        for rn, trace in zip(g["runs"], got["runs"]):
            self.assertEqual(len(trace), len(rn["trace"]))
            for a, b in zip(trace, rn["trace"]):
                for u, v in zip(a[:3], b[:3]):
                    self.assertAlmostEqual(u, v, places=6)
                self.assertEqual(a[3], b[3])
        self.assertEqual(got["spread"], g["spread"])
        self.assertEqual(got["mb"], [p[1] for p in g["mb32"]])
        self.assertEqual(got["over"], [p[2] for p in g["overlaps"]])


if __name__ == "__main__":
    unittest.main()
