"""The 3D character spec's maximums live in three places that must agree: games/avatar3d.js MAX (the builder
and Settings' clamp), ui/app/30-character.js CHAR_MAX (Settings, before avatar3d has loaded) and
dashboard-rs/src/app.rs CHARACTER_MAX (the server's config validation). games/people3d.js reads the same spec
through avatar3d's clamp, so its headwear, accessory and outfit ranges are covered here too."""
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(*p):
    with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
        return f.read()


def nums(pattern, text):
    m = re.search(pattern, text)
    if not m:
        return None
    return [int(x) for x in re.findall(r"-?\d+", m.group(1))]


class CharacterSpecMaximums(unittest.TestCase):
    def setUp(self):
        self.js = nums(r"\nvar MAX = \[([^\]]*)\];", read("games", "avatar3d.js"))
        self.ui = nums(r"\nvar CHAR_MAX = \[([^\]]*)\];", read("ui", "app", "30-character.js"))
        self.rs = nums(r"pub const CHARACTER_MAX: \[i64; 10\] = \[([^\]]*)\];", read("dashboard-rs", "src", "app.rs"))

    def test_all_three_found(self):
        for name, v in (("avatar3d MAX", self.js), ("30-character CHAR_MAX", self.ui), ("app.rs CHARACTER_MAX", self.rs)):
            self.assertIsNotNone(v, name)
            self.assertEqual(len(v), 10, name)

    def test_the_three_agree(self):
        self.assertEqual(self.js, self.ui)
        self.assertEqual(self.js, self.rs)

    def test_people3d_covers_the_ranges(self):
        p = read("games", "people3d.js")
        files = re.search(r"\nvar FILES = \[([^\]]*)\];", p).group(1)
        self.assertEqual(len(re.findall(r'"[a-z-]+"', files)), self.js[0] + 1)   # one body per base
        for hw in range(1, self.js[5] + 1):                                       # every headwear is drawn
            self.assertIn("hw === %d" % hw, p)
        for acc in range(1, self.js[6] + 1):                                      # and every accessory
            self.assertRegex(p, r"acc === %d" % acc)


if __name__ == "__main__":
    unittest.main()
