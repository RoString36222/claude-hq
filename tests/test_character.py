"""The 3D character: the three copies of its bounds agree.

Config validation and the portrait check live in Rust (dashboard-rs):
app::tests::character_and_trainer_specs, arena::tests::portraits,
tests/py_character.rs."""
import json
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return f.read()


def js_array(src, name):
    m = re.search(r"var %s = (\[[^\]]*\]);" % name, src)
    return json.loads(m.group(1))


def server_max():
    """The server's clamp, CHARACTER_MAX in dashboard-rs/src/app.rs."""
    m = re.search(r"pub const CHARACTER_MAX: \[i64; \d+\] = (\[[^\]]*\]);", read("dashboard-rs/src/app.rs"))
    return json.loads(m.group(1))


class Bounds(unittest.TestCase):
    def test_the_three_copies_agree(self):
        py = server_max()
        self.assertEqual(js_array(read("games/avatar3d.js"), "MAX"), py)
        self.assertEqual(js_array(read("ui/app/30-character.js"), "CHAR_MAX"), py)

    def test_every_choice_has_a_label_and_every_palette_a_colour(self):
        src = read("ui/app/30-character.js")
        axes = js_array(src, "CHAR_AXES")
        for i, ax in enumerate(axes):
            m = re.search(r"\b%s: (\[[^\]]*\])" % ax, src[src.index("var CHAR_LABELS"):])
            self.assertEqual(len(json.loads(m.group(1))), server_max()[i] + 1, ax)
        # the cyberpunk set is last on its axis (append-only)
        for needle in ('"Chrome"]', '"Neon cyan"]', '"Hot magenta"]', '"Neon crest"]', '"Neural halo"]',
                       '"AR visor"]', '"Lit eyes"]', '"Neon grid"]', '"Techwear"]'):
            self.assertIn(needle, src)

    def test_the_arena_takes_the_whole_spec(self):
        hq = read("backend-rs/src/valley/hq.rs")
        self.assertGreaterEqual(int(re.search(r"LOOK_LEN: usize = (\d+)", hq).group(1)), len(server_max()))
        self.assertGreaterEqual(int(re.search(r"LOOK_MAX: u64 = (\d+)", hq).group(1)), max(server_max()))


if __name__ == "__main__":
    unittest.main()
