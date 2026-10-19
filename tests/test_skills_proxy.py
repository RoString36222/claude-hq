"""HQ 2.5 skill tree: the catalogue mirror between backend-rs/src/skills.rs,
ui/app/35-skills.js and the local server's work signals
(dashboard-rs/src/worksignals.rs SKILL_CATS / MAX_N).

The proxy, reporter and config tests that lived here are Rust tests now
(dashboard-rs/tests/py_proxies.rs, skills_*).
"""
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from rsconst import rs_int, rs_path, rs_strings  # noqa: E402

WORKSIGNALS_RS = rs_path("dashboard-rs", "src", "worksignals.rs")


class CatalogueSyncTests(unittest.TestCase):
    def test_the_page_mirrors_skills_rs(self):
        with open(os.path.join(ROOT, "backend-rs", "src", "skills.rs"), encoding="utf-8") as f:
            rs = f.read()
        with open(os.path.join(ROOT, "ui", "app", "35-skills.js"), encoding="utf-8") as f:
            js = f.read()
        rs_perks = re.findall(r'\("([a-z]+)", \[((?:"[^"]+",? ?)+)\]\)', rs)
        self.assertEqual(len(rs_perks), 7)
        js_cats = re.findall(r'id:"([a-z]+)",\s*name:"[^"]+",\s*icon:"[^"]+",\s*how:"[^"]+",\s*perks:\[([^\]]+)\]', js)
        self.assertEqual([c for c, _ in js_cats], [c for c, _ in rs_perks])
        self.assertEqual([c for c, _ in rs_perks], rs_strings(WORKSIGNALS_RS, "SKILL_CATS"))
        for (c1, p1), (c2, p2) in zip(rs_perks, js_cats):
            self.assertEqual(re.findall(r'"([^"]+)"', p1), re.findall(r'"([^"]+)"', p2), c1)
        tiers = re.search(r"pub const TIERS: \[i64; 5\] = \[([^\]]+)\]", rs).group(1)
        self.assertIn("var SKILL_TIERS = [%s];" % tiers.replace(" ", ""), js)
        self.assertIn("pub const MAX_N: i64 = %d;" % rs_int(WORKSIGNALS_RS, "MAX_N"), rs)


if __name__ == "__main__":
    unittest.main()
