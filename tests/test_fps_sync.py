"""Blaster Arena: the browser and the Arena server must agree on the arena and the rules.

games/fps/map.json is mirrored byte-for-byte at backend-rs/data/fps_map.json (the Rust
Arena embeds that copy), the constants in games/fps.js (FPS-SHARED block) must equal
backend-rs/src/fps.rs's, and the shared geometry must give the same answers as the
server: the browser predicts its own movement with the same collision the server
checks, and draws its shots with the same rays and spread the server judges them with.

The geometry is pinned by backend-rs/tests/fps_golden.json, generated once from the last
Python Arena (fps.py) and fixed by design: node replays it through the FPS-SHARED block
here, and src/fps/tests.rs replays it through the Rust Arena. Stdlib only; the JS half
runs under node when it is installed (the script goes over stdin: one argv string is
capped at 128 KB on Linux)."""
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
FPS_JS = os.path.join(ROOT, "games", "fps.js")
FPS_RS = rs_path("backend-rs", "src", "fps.rs")
MAP = os.path.join(ROOT, "games", "fps", "map.json")
SERVER_MAP = os.path.join(ROOT, "backend-rs", "data", "fps_map.json")
GOLDEN = os.path.join(ROOT, "backend-rs", "tests", "fps_golden.json")
NODE = shutil.which("node")


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def block():
    return re.search(r"/\* FPS-SHARED BEGIN \*/(.*?)/\* FPS-SHARED END \*/", read(FPS_JS), re.S).group(1)


class FpsSync(unittest.TestCase):
    def test_map_file_is_mirrored(self):
        with open(MAP, "rb") as a, open(SERVER_MAP, "rb") as b:
            self.assertEqual(a.read(), b.read(), "copy games/fps/map.json to backend-rs/data/fps_map.json")

    def test_constants_match(self):
        src = block()
        for name in ("R", "H", "EYE", "STEP_H", "RUN", "ACCEL", "AIR_ACCEL", "GRAVITY", "JUMP_V", "FALL_MAX",
                     "BODY_R", "BODY_H", "HEAD_R", "HEAD_TOP"):
            m = re.search(r"\b%s\s*=\s*([0-9.]+)" % name, src)
            self.assertIsNotNone(m, name)
            self.assertEqual(float(m.group(1)), rs_num(FPS_RS, name), name)
        js = read(FPS_JS)
        self.assertLessEqual(float(re.search(r"\bRUN\s*=\s*([0-9.]+)", src).group(1)), rs_num(FPS_RS, "MAX_SPEED"))
        self.assertLessEqual(float(re.search(r"\bINTERP\s*=\s*([0-9.]+)", js).group(1)) +
                             float(re.search(r"\bJIT_MAX\s*=\s*([0-9.]+)", js).group(1)), rs_num(FPS_RS, "IP_CAP"))
        self.assertEqual(float(re.search(r"\bSWITCH\s*=\s*([0-9.]+)", js).group(1)), rs_num(FPS_RS, "SWITCH"))
        self.assertEqual(float(re.search(r"\bRESPAWN\s*=\s*([0-9.]+)", js).group(1)), rs_num(FPS_RS, "RESPAWN"))

    @unittest.skipUnless(NODE, "node not installed")
    def test_shared_functions_match_the_golden_vectors_under_node(self):
        gold = json.loads(read(GOLDEN))
        data = json.loads(read(MAP))
        script = block() + """
var input = %s, m = FS.compileMap(input.data), out = {rays: [], runs: [], spread: [], mb: [], over: []};
input.rays.forEach(function(r){
  var d = FS.dirOf(r.yaw, r.pitch);
  out.rays.push([d, FS.rayMap(m, r.o, d, 80), FS.rayPlayer(r.o, d, r.target[0], r.target[1], r.target[2], 80)]);
});
input.runs.forEach(function(rn){
  var s = {x: rn.start[0], y: rn.start[1], z: rn.start[2], vx: 0, vy: 0, vz: 0, g: true}, trace = [];
  rn.steps.forEach(function(st, j){ FS.move(m, s, st[0], st[1], !!st[2], 1/120); if(j %% 30 === 0) trace.push([s.x, s.y, s.z, s.g]); });
  out.runs.push(trace);
});
input.spread.forEach(function(v){ out.spread.push([FS.spreadOf(v.n, 0), FS.spreadOf(v.n, 1)]); out.mb.push(FS.mb32(v.n * 7919)); });
input.over.forEach(function(v){ out.over.push(FS.overlaps(m, v[0], 0.2, v[1], 0.05)); });
console.log(JSON.stringify(out));
""" % json.dumps({"data": data, "rays": gold["rays"], "runs": [{"start": r["start"], "steps": r["steps"]} for r in gold["runs"]],
                  "spread": gold["spread"], "over": gold["over"]})
        res = subprocess.run([NODE, "-"], input=script, capture_output=True, text=True, timeout=120)
        self.assertEqual(res.returncode, 0, res.stderr)
        got = json.loads(res.stdout)
        self.assertEqual(len(got["rays"]), len(gold["rays"]))
        for want, (d, tm, tpl) in zip(gold["rays"], got["rays"]):
            for a, b in zip(d, want["dir"]):
                self.assertAlmostEqual(a, b, places=9)
            self.assertAlmostEqual(tm, want["map"], places=6)
            if want["player"] is None:
                self.assertIsNone(tpl)
            else:
                self.assertAlmostEqual(tpl[0], want["player"][0], places=6)
                self.assertEqual(tpl[1], want["player"][1])
        hits = sum(1 for r in gold["rays"] if r["player"] is not None)
        self.assertGreater(len(gold["rays"]), hits)
        self.assertGreater(hits, 0)
        for run, trace in zip(gold["runs"], got["runs"]):
            self.assertEqual(len(trace), len(run["trace"]))
            for a, b in zip(trace, run["trace"]):
                for u, v in zip(a[:3], b[:3]):
                    self.assertAlmostEqual(u, v, places=6)
                self.assertEqual(a[3], b[3])
        for v, (a, b), mb in zip(gold["spread"], got["spread"], got["mb"]):
            self.assertEqual(a, v["w0"])
            self.assertEqual(b, v["w1"])
            self.assertEqual(mb, v["mb"])
        self.assertEqual(got["over"], [v[2] for v in gold["over"]])


if __name__ == "__main__":
    unittest.main()
