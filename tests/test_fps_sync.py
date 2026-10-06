"""Blaster Arena: the browser and the Arena server must agree on the arena and the rules.

games/fps/map.json is mirrored byte-for-byte at backend/app/fps_map.json (the server
deploys backend/ only), and the shared geometry in games/fps.js (FPS-SHARED block) must
give the same answers as backend/app/fps.py: the browser predicts its own movement with
the same collision the server checks, and draws its shots with the same rays and spread
the server judges them with. The server module is stdlib-only, so it is loaded straight
from its file. Stdlib only; the JS half runs under node when it is installed (the script
goes over stdin: one argv string is capped at 128 KB on Linux)."""
import importlib.util
import json
import math
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FPS_JS = os.path.join(ROOT, "games", "fps.js")
MAP = os.path.join(ROOT, "games", "fps", "map.json")
SERVER_MAP = os.path.join(ROOT, "backend", "app", "fps_map.json")
NODE = shutil.which("node")


def load_server():
    spec = importlib.util.spec_from_file_location("fps_server", os.path.join(ROOT, "backend", "app", "fps.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def block():
    return re.search(r"/\* FPS-SHARED BEGIN \*/(.*?)/\* FPS-SHARED END \*/", read(FPS_JS), re.S).group(1)


class FpsSync(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fps = load_server()

    def test_map_file_is_mirrored(self):
        with open(MAP, "rb") as a, open(SERVER_MAP, "rb") as b:
            self.assertEqual(a.read(), b.read(), "copy games/fps/map.json to backend/app/fps_map.json")

    def test_constants_match(self):
        src = block()
        for name in ("R", "H", "EYE", "STEP_H", "RUN", "ACCEL", "AIR_ACCEL", "GRAVITY", "JUMP_V", "FALL_MAX",
                     "BODY_R", "BODY_H", "HEAD_R", "HEAD_TOP"):
            m = re.search(r"\b%s\s*=\s*([0-9.]+)" % name, src)
            self.assertIsNotNone(m, name)
            self.assertEqual(float(m.group(1)), float(getattr(self.fps, name)), name)
        js = read(FPS_JS)
        self.assertLessEqual(float(re.search(r"\bRUN\s*=\s*([0-9.]+)", src).group(1)), self.fps.MAX_SPEED)
        self.assertLessEqual(float(re.search(r"\bINTERP\s*=\s*([0-9.]+)", js).group(1)) +
                             float(re.search(r"\bJIT_MAX\s*=\s*([0-9.]+)", js).group(1)), self.fps.IP_CAP)
        self.assertEqual(float(re.search(r"\bSWITCH\s*=\s*([0-9.]+)", js).group(1)), self.fps.SWITCH)
        self.assertEqual(float(re.search(r"\bRESPAWN\s*=\s*([0-9.]+)", js).group(1)), self.fps.RESPAWN)

    @unittest.skipUnless(NODE, "node not installed")
    def test_shared_functions_match_under_node(self):
        f = self.fps
        m = f.MAP
        data = json.loads(read(MAP))
        # rays: from a grid of eyes in many directions, against the map and a player
        rays = []
        for i in range(160):
            o = (-20 + (i * 7.3) % 40, 0.3 + (i * 1.7) % 4, -20 + (i * 3.1) % 40)
            yaw, pitch = (i * 37.7) % 360 - 180, (i * 11.3) % 120 - 60
            rays.append([o, yaw, pitch, ((i * 5.1) % 30 - 15, (i % 3) * 0.7, (i * 2.3) % 30 - 15)])
        # movement: a few runners steering through the arena, jumping now and then
        runs = []
        for k in range(6):
            sx, sy, sz, _ = m["spawns"][k]
            steps = []
            for j in range(900):
                a = (k * 1.3 + j * 0.011) % (2 * math.pi)
                steps.append([math.sin(a), -math.cos(a), j % 97 == 0])
            runs.append([[sx, sy, sz], steps])
        script = block() + """
var input = %s, m = FS.compileMap(input.data), out = {rays: [], runs: [], spread: [], mb: [], over: []};
input.rays.forEach(function(r){
  var d = FS.dirOf(r[1], r[2]);
  out.rays.push([d, FS.rayMap(m, r[0], d, 80), FS.rayPlayer(r[0], d, r[3][0], r[3][1], r[3][2], 80)]);
});
input.runs.forEach(function(rn){
  var s = {x: rn[0][0], y: rn[0][1], z: rn[0][2], vx: 0, vy: 0, vz: 0, g: true}, trace = [];
  rn[1].forEach(function(st, j){ FS.move(m, s, st[0], st[1], st[2], 1/120); if(j %% 30 === 0) trace.push([s.x, s.y, s.z, s.g]); });
  out.runs.push(trace);
});
for(var n = 0; n < 200; n++){ out.spread.push([FS.spreadOf(n, 0), FS.spreadOf(n, 1)]); out.mb.push(FS.mb32(n * 7919)); }
for(var x = -21; x <= 21; x += 1.5) for(var z = -21; z <= 21; z += 1.5) out.over.push(FS.overlaps(m, x, 0.2, z, 0.05));
console.log(JSON.stringify(out));
""" % json.dumps({"data": data, "rays": rays, "runs": runs})
        res = subprocess.run([NODE, "-"], input=script, capture_output=True, text=True, timeout=120)
        self.assertEqual(res.returncode, 0, res.stderr)
        got = json.loads(res.stdout)
        for (o, yaw, pitch, tp), (d, tm, tpl) in zip(rays, got["rays"]):
            want = f.dir_of(yaw, pitch)
            for a, b in zip(d, want):
                self.assertAlmostEqual(a, b, places=9)
            self.assertAlmostEqual(tm, f.ray_map(m, o, want, 80), places=6)
            wp = f.ray_player(o, want, tp[0], tp[1], tp[2], 80)
            if wp is None:
                self.assertIsNone(tpl)
            else:
                self.assertAlmostEqual(tpl[0], wp[0], places=6)
                self.assertEqual(tpl[1], wp[1])
        hits = sum(1 for _, _, tpl in got["rays"] if tpl is not None)
        self.assertGreater(len(rays), hits)
        for (start, steps), trace in zip(runs, got["runs"]):
            s = {"x": start[0], "y": start[1], "z": start[2], "vx": 0.0, "vy": 0.0, "vz": 0.0, "g": True}
            want = []
            for j, st in enumerate(steps):
                f.move(m, s, st[0], st[1], st[2], 1 / 120)
                if j % 30 == 0:
                    want.append([s["x"], s["y"], s["z"], s["g"]])
            for a, b in zip(trace, want):
                for u, v in zip(a[:3], b[:3]):
                    self.assertAlmostEqual(u, v, places=6)
                self.assertEqual(a[3], b[3])
        for n, (a, b) in enumerate(got["spread"]):
            self.assertEqual(tuple(a), f.spread_of(n, 0))
            self.assertEqual(tuple(b), f.spread_of(n, 1))
            self.assertEqual(got["mb"][n], f.mb32(n * 7919))
        k = 0
        x = -21.0
        while x <= 21:
            z = -21.0
            while z <= 21:
                self.assertEqual(got["over"][k], f.overlaps(m, x, 0.2, z, 0.05), (x, z))
                k += 1
                z += 1.5
            x += 1.5


if __name__ == "__main__":
    unittest.main()
