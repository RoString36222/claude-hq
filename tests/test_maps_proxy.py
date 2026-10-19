"""Map gallery: the house rules ui/app/31-workshop.js keeps (the save body
names only the six allowlisted keys, no Math.random / eval).

The proxy wire, validation and routing tests that lived here are Rust tests
now (dashboard-rs/tests/py_proxies.rs map_*, py_routes.rs maps_*).
"""
import os
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class PageRules(unittest.TestCase):
    """31-workshop.js keeps the house rules the page relies on."""

    def setUp(self):
        with open(os.path.join(ROOT, "ui", "app", "31-workshop.js"), encoding="utf-8") as f:
            self.src = f.read()

    def test_contract_hooks_exist(self):
        for name in ("function workshopEnter", "function workshopLeave", "window.workshopPublish",
                     "window.workshopOpenMaker", "make-publish", "/api/arena/leaderboards?game="):
            self.assertIn(name, self.src)

    def test_no_math_random_and_no_eval(self):
        self.assertNotIn("Math.random", self.src)
        self.assertNotIn("eval(", self.src)

    def test_the_save_body_names_only_the_six_keys(self):
        i = self.src.index("var body = {kind:")
        line = self.src[i:self.src.index("\n", i)]
        self.assertRegex(line, r"\{kind:doc\.kind, name:[^,]+, data:doc\.data, scope:scope\}")


if __name__ == "__main__":
    unittest.main()
