"""Kart Racing: the browser and the Arena server must agree on the tracks.

games/kart/tracks.json is mirrored byte-for-byte at backend/app/kart_tracks.json (the
server deploys backend/ only), and the track geometry in games/kart.js (KART-TRACK
block) must give the same answers as backend/app/kart.py: the browser keeps its car on
the road and counts its laps with the same rules the server checks them with. The
server module is stdlib-only, so it is loaded straight from its file. Stdlib only;
the JS half runs under node when it is installed."""
import importlib.util
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KART_JS = os.path.join(ROOT, "games", "kart.js")
TRACKS = os.path.join(ROOT, "games", "kart", "tracks.json")
SERVER_TRACKS = os.path.join(ROOT, "backend", "app", "kart_tracks.json")
NODE = shutil.which("node")


def load_server():
    spec = importlib.util.spec_from_file_location("kart_server", os.path.join(ROOT, "backend", "app", "kart.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


class KartSync(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.kart = load_server()

    def test_track_file_is_mirrored(self):
        with open(TRACKS, "rb") as a, open(SERVER_TRACKS, "rb") as b:
            self.assertEqual(a.read(), b.read(), "copy games/kart/tracks.json to backend/app/kart_tracks.json")

    def test_constants_match(self):
        block = re.search(r"/\* KART-TRACK BEGIN \*/(.*?)/\* KART-TRACK END \*/", read(KART_JS), re.S).group(1)
        for name in ("TILE", "HALF", "ROAD_HALF", "R_IN", "R_MID", "R_OUT"):
            m = re.search(r"\b%s\s*=\s*([0-9.]+)" % name, block)
            self.assertIsNotNone(m, name)
            self.assertEqual(float(m.group(1)), float(getattr(self.kart, name)), name)
        js = read(KART_JS)
        self.assertLessEqual(float(re.search(r"\bVMAX\s*=\s*([0-9.]+)", js).group(1)), self.kart.MAX_SPEED)

    @unittest.skipUnless(NODE, "node not installed")
    def test_geometry_matches_under_node(self):
        k = self.kart
        block = re.search(r"/\* KART-TRACK BEGIN \*/(.*?)/\* KART-TRACK END \*/", read(KART_JS), re.S).group(1)
        data = json.loads(read(TRACKS))
        probes = []
        for t in data["tracks"]:
            tr = k.TRACKS[t["id"]]
            for i in range(tr["n"] * 7):
                u = i / 7 + 0.013
                for lat in (-4.0, 0.0, 3.3):
                    x, z, _ = k.point_at(tr, u, lat)
                    probes.append([t["id"], u, lat, x + 0.37, z - 0.21])
        script = block + """
var data = %s, probes = %s, out = [], tr = {};
data.tracks.forEach(function(t){ tr[t.id] = KT.compileTrack(t.path); });
probes.forEach(function(p){
  out.push([KT.pointAt(tr[p[0]], p[1], p[2]), KT.locate(tr[p[0]], p[3], p[4])]);
});
var grid = []; for(var k = 0; k < 8; k++) grid.push(KT.gridSlot(k));
console.log(JSON.stringify({out: out, grid: grid, tiles: data.tracks.map(function(t){ return tr[t.id].tiles; })}));
""" % (json.dumps(data), json.dumps(probes))
        res = subprocess.run([NODE, "-e", script], capture_output=True, text=True, timeout=60)
        self.assertEqual(res.returncode, 0, res.stderr)
        got = json.loads(res.stdout)
        for (tid, u, lat, x, z), (pa, loc) in zip(probes, got["out"]):
            tr = k.TRACKS[tid]
            want = k.point_at(tr, u, lat)
            for a, b in zip(pa, want):
                self.assertAlmostEqual(a, b, places=6, msg=(tid, u, lat))
            wl = k.locate(tr, x, z)
            if wl is None:
                self.assertIsNone(loc)
            else:
                self.assertEqual(loc[0], wl[0])
                self.assertAlmostEqual(loc[1], wl[1], places=6)
                self.assertAlmostEqual(loc[2], wl[2], places=6)
        self.assertEqual([tuple(g) for g in got["grid"]], [tuple(map(float, k.grid_slot(None, i))) for i in range(8)])
        for t, tiles in zip(data["tracks"], got["tiles"]):
            for a, b in zip(tiles, k.TRACKS[t["id"]]["tiles"]):
                self.assertEqual((a["col"], a["row"], a["kind"], a["d"], a["o"]), (b["col"], b["row"], b["kind"], b["d"], b["o"]))
                if "pivot" in b:
                    self.assertEqual(tuple(a["pivot"]), tuple(b["pivot"]))


if __name__ == "__main__":
    unittest.main()
