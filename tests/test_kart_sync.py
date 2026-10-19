"""Kart Racing: the browser and the Arena server must agree on the tracks.

games/kart/tracks.json is mirrored byte-for-byte at backend-rs/data/kart_tracks.json (the
Rust Arena embeds that copy), the constants in games/kart.js (KART-TRACK block) must
equal backend-rs/src/kart.rs's, and the track geometry must give the same answers as
the server: the browser keeps its car on the road and counts its laps with the same
rules the server checks them with.

The geometry is pinned by backend-rs/tests/kart_golden.json, generated once from the last
Python Arena (kart.py) and fixed by design: node replays it through the KART-TRACK block
here, and src/kart/tests.rs replays it through the Rust Arena. Stdlib only; the JS half
runs under node when it is installed."""
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
KART_JS = os.path.join(ROOT, "games", "kart.js")
KART_RS = rs_path("backend-rs", "src", "kart.rs")
TRACKS = os.path.join(ROOT, "games", "kart", "tracks.json")
SERVER_TRACKS = os.path.join(ROOT, "backend-rs", "data", "kart_tracks.json")
GOLDEN = os.path.join(ROOT, "backend-rs", "tests", "kart_golden.json")
NODE = shutil.which("node")


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def block():
    return re.search(r"/\* KART-TRACK BEGIN \*/(.*?)/\* KART-TRACK END \*/", read(KART_JS), re.S).group(1)


class KartSync(unittest.TestCase):
    def test_track_file_is_mirrored(self):
        with open(TRACKS, "rb") as a, open(SERVER_TRACKS, "rb") as b:
            self.assertEqual(a.read(), b.read(), "copy games/kart/tracks.json to backend-rs/data/kart_tracks.json")

    def test_constants_match(self):
        src = block()
        for name in ("TILE", "HALF", "ROAD_HALF", "R_IN", "R_MID", "R_OUT"):
            m = re.search(r"\b%s\s*=\s*([0-9.]+)" % name, src)
            self.assertIsNotNone(m, name)
            self.assertEqual(float(m.group(1)), rs_num(KART_RS, name), name)
        js = read(KART_JS)
        self.assertLessEqual(float(re.search(r"\bVMAX\s*=\s*([0-9.]+)", js).group(1)), rs_num(KART_RS, "MAX_SPEED"))

    def test_golden_covers_every_track(self):
        gold = json.loads(read(GOLDEN))
        data = json.loads(read(TRACKS))
        self.assertEqual([(t["id"], t["path"]) for t in gold["tracks"]], [(t["id"], t["path"]) for t in data["tracks"]],
                         "a track changed: the golden pins the old geometry (see its note)")

    @unittest.skipUnless(NODE, "node not installed")
    def test_geometry_matches_the_golden_vectors_under_node(self):
        gold = json.loads(read(GOLDEN))
        script = block() + """
var gold = %s, out = [];
gold.tracks.forEach(function(t){
  var tr = KT.compileTrack(t.path);
  out.push({tiles: tr.tiles, probes: t.probes.map(function(p){
    return [KT.pointAt(tr, p[0], p[1]), KT.locate(tr, p[2][0] + 0.37, p[2][1] - 0.21)];
  })});
});
var grid = []; for(var k = 0; k < 8; k++) grid.push(KT.gridSlot(k));
console.log(JSON.stringify({out: out, grid: grid}));
""" % json.dumps({"tracks": [{"path": t["path"], "probes": t["probes"]} for t in gold["tracks"]]})
        # the script carries every probe: pipe it in (argv is capped at 128 KB per string on Linux)
        res = subprocess.run([NODE, "-"], input=script, capture_output=True, text=True, timeout=60)
        self.assertEqual(res.returncode, 0, res.stderr)
        got = json.loads(res.stdout)
        n = 0
        for t, js in zip(gold["tracks"], got["out"]):
            self.assertEqual(len(js["probes"]), len(t["probes"]))
            for (u, lat, want_pa, want_loc), (pa, loc) in zip(t["probes"], js["probes"]):
                for a, b in zip(pa, want_pa):
                    self.assertAlmostEqual(a, b, places=6, msg=(t["id"], u, lat))
                if want_loc is None:
                    self.assertIsNone(loc)
                else:
                    self.assertEqual(loc[0], want_loc[0])
                    self.assertAlmostEqual(loc[1], want_loc[1], places=6)
                    self.assertAlmostEqual(loc[2], want_loc[2], places=6)
                n += 1
            self.assertEqual(len(js["tiles"]), len(t["tiles"]))
            for a, (col, row, kind, d, o, pivot) in zip(js["tiles"], t["tiles"]):
                self.assertEqual((a["col"], a["row"], a["kind"], a["d"], a["o"]), (col, row, kind, d, o))
                if pivot is not None:
                    self.assertEqual(list(a["pivot"]), pivot)
        self.assertGreater(n, 1000)
        self.assertEqual(got["grid"], gold["grid"])


if __name__ == "__main__":
    unittest.main()
