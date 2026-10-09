"""The 3D character: the three copies of its bounds agree, config and portrait checks."""
import base64
import json
import os
import re
import struct
import sys
import unittest
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import arena  # noqa: E402
import dashboard  # noqa: E402


def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return f.read()


def js_array(src, name):
    m = re.search(r"var %s = (\[[^\]]*\]);" % name, src)
    return json.loads(m.group(1))


def png(w, h=None):
    h = w if h is None else h
    raw = b"".join(b"\x00" + b"\x10\x20\x30\xff" * w for _ in range(h))
    ch = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    return (b"\x89PNG\r\n\x1a\n" + ch(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + ch(b"IDAT", zlib.compress(raw)) + ch(b"IEND", b""))


class Bounds(unittest.TestCase):
    def test_the_three_copies_agree(self):
        py = list(dashboard.CHARACTER_MAX)
        self.assertEqual(js_array(read("games/avatar3d.js"), "MAX"), py)
        self.assertEqual(js_array(read("ui/app/30-character.js"), "CHAR_MAX"), py)

    def test_every_choice_has_a_label_and_every_palette_a_colour(self):
        src = read("ui/app/30-character.js")
        axes = js_array(src, "CHAR_AXES")
        for i, ax in enumerate(axes):
            m = re.search(r"\b%s: (\[[^\]]*\])" % ax, src[src.index("var CHAR_LABELS"):])
            self.assertEqual(len(json.loads(m.group(1))), dashboard.CHARACTER_MAX[i] + 1, ax)
        # the cyberpunk set is last on its axis (append-only)
        for needle in ('"Chrome"]', '"Neon cyan"]', '"Hot magenta"]', '"Neon crest"]', '"Neural halo"]',
                       '"AR visor"]', '"Lit eyes"]', '"Neon grid"]', '"Techwear"]'):
            self.assertIn(needle, src)

    def test_the_arena_takes_the_whole_spec(self):
        hq = read("backend-rs/src/valley/hq.rs")
        self.assertGreaterEqual(int(re.search(r"LOOK_LEN: usize = (\d+)", hq).group(1)), len(dashboard.CHARACTER_MAX))
        self.assertGreaterEqual(int(re.search(r"LOOK_MAX: u64 = (\d+)", hq).group(1)), max(dashboard.CHARACTER_MAX))


class Config(unittest.TestCase):
    def test_character_is_validated_like_the_trainer(self):
        v = dashboard._validate_config
        self.assertIsNone(dashboard.DEFAULT_CONFIG["character"])
        self.assertEqual(v({"character": [5, 7, 9, 9, 2, 5, 3, 1, 4, 1]})["character"], [5, 7, 9, 9, 2, 5, 3, 1, 4, 1])
        self.assertEqual(v({"character": [6, -1, "x"]})["character"], [0, 7, 0, 0, 0, 0, 0, 0, 0, 0])
        self.assertIsNone(v({"character": None})["character"])
        self.assertIsNone(v({"character": "evil"})["character"])


class Portrait(unittest.TestCase):
    def url(self, b):
        return "data:image/png;base64," + base64.b64encode(b).decode()

    def test_only_small_square_pngs_leave(self):
        self.assertEqual(arena.portrait_png(self.url(png(128))), png(128))
        self.assertIsNone(arena.portrait_png(self.url(png(16))))
        self.assertIsNone(arena.portrait_png(self.url(png(128, 64))))
        self.assertIsNone(arena.portrait_png("data:image/jpeg;base64,AAAA"))
        self.assertIsNone(arena.portrait_png("data:image/png;base64,!!!"))
        self.assertIsNone(arena.portrait_png(None))
        self.assertIn("/api/arena/portrait", dashboard.POST_PATHS)


if __name__ == "__main__":
    unittest.main()
