"""Valley minigames (games/): the page loads every game file, and the house rules for
the game scripts (no external URLs, no innerHTML). The allowlisted static route, the
local save endpoint and the include guard are tested in dashboard-rs/tests/py_games.rs."""
import os
import re
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tests"))

import hq  # noqa: E402

GAMES = os.path.join(ROOT, "games")


class GameIndexTests(unittest.TestCase):
    def test_index_loads_every_game_file_that_exists(self):
        html = hq.assemble_index()
        files = re.search(r'VALLEY_FILES = \[([^\]]*)\]', html).group(1)
        names = re.findall(r'"([a-z]+)"', files)
        self.assertEqual(names[0], "core")
        for n in names:
            self.assertTrue(os.path.isfile(os.path.join(GAMES, n + ".js")), n)


class GameScriptRules(unittest.TestCase):
    def scripts(self):
        for n in sorted(os.listdir(GAMES)):
            if n.endswith(".js"):
                with open(os.path.join(GAMES, n), encoding="utf-8") as f:
                    yield n, f.read()

    def test_no_external_urls_or_innerhtml(self):
        for n, src in self.scripts():
            self.assertNotRegex(src, r"https?://", n)
            self.assertNotIn("innerHTML", src, n)
            self.assertNotIn("eval(", src, n)

    def test_vendored_modules_import_only_relative_siblings(self):
        vendor = os.path.join(GAMES, "vendor")
        for n in sorted(os.listdir(vendor)):
            if not n.endswith(".js"):
                continue
            with open(os.path.join(vendor, n), encoding="utf-8") as f:
                src = f.read()
            for spec in re.findall(r"^(?:import|export)[^;]*?from\s+'([^']+)'", src, re.M):
                self.assertRegex(spec, r"^\./three-[a-z-]+\.js$", n)
                self.assertTrue(os.path.isfile(os.path.join(vendor, spec[2:])), spec)
            self.assertNotRegex(src, r"import\(\s*['\"]https?:", n)

    def test_third_party_files_carry_their_licenses(self):
        with open(os.path.join(GAMES, "vendor", "LICENSE-three.txt"), encoding="utf-8") as f:
            self.assertIn("The MIT License", f.read())
        with open(os.path.join(GAMES, "golf", "LICENSE-kenney.txt"), encoding="utf-8") as f:
            self.assertGreaterEqual(f.read().count("Creative Commons Zero, CC0"), 2)
        with open(os.path.join(GAMES, "kart", "LICENSE-kenney.txt"), encoding="utf-8") as f:
            self.assertGreaterEqual(f.read().count("Creative Commons Zero, CC0"), 2)
        with open(os.path.join(GAMES, "platformer", "LICENSE-kenney.txt"), encoding="utf-8") as f:
            self.assertGreaterEqual(f.read().count("Creative Commons Zero, CC0"), 2)
        with open(os.path.join(GAMES, "fps", "LICENSE-kenney.txt"), encoding="utf-8") as f:
            self.assertGreaterEqual(f.read().count("Creative Commons Zero, CC0"), 2)
        for n in os.listdir(os.path.join(GAMES, "fps")):
            self.assertRegex(n, r"^([a-z][a-z0-9-]*\.glb|colormap\.png|burst\.png|hit\.png|map\.json|LICENSE-kenney\.txt)$", n)
        # every vendored platformer file is one of the kit's (named in its license)
        for n in os.listdir(os.path.join(GAMES, "platformer")):
            self.assertRegex(n, r"^([a-z][a-z0-9-]*\.glb|colormap\.png|blob-shadow\.png|levels\.json|LICENSE-kenney\.txt)$", n)

    def test_css_uses_tokens_not_hex(self):
        with open(os.path.join(GAMES, "games.css"), encoding="utf-8") as f:
            css = f.read()
        self.assertIsNone(re.search(r"#[0-9a-fA-F]{3,8}\b", css))



class IndexAssembly(unittest.TestCase):
    """index.html is a template stitched from ui/ (Wave 0 split)."""

    def test_every_include_exists_and_nothing_is_left_unstitched(self):
        html = hq.assemble_index()
        self.assertNotIn("@include ui/", html)
        self.assertGreater(len(html), 500000)
        self.assertIn('"use strict";\nvar $ = function(id)', html)


if __name__ == "__main__":
    unittest.main()
