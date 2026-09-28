"""The food catalog is mirrored by hand in three places; this catches drift.

The backend's app/pantry.py CATALOG is the authority for names and prices,
arena.FOOD_KINDS / FOOD_LABELS mirror its kinds and labels, and
dashboard.FOOD_EFFECTS mirrors its effects. CATALOG is read with `ast`, so no
backend dependency is imported. Stdlib only.
"""
import ast
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import arena  # noqa: E402
import dashboard  # noqa: E402

PANTRY_PY = os.path.join(ROOT, "backend", "app", "pantry.py")


def load_catalog():
    with open(PANTRY_PY, encoding="utf-8") as f:
        tree = ast.parse(f.read(), PANTRY_PY)
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == "CATALOG" for t in node.targets):
            return ast.literal_eval(node.value)
    raise AssertionError("no module-level CATALOG literal in backend/app/pantry.py")


class CatalogSyncTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not os.path.exists(PANTRY_PY):
            raise AssertionError("backend/app/pantry.py is missing")
        cls.catalog = load_catalog()

    def test_kinds_match_in_order(self):
        self.assertEqual(tuple(self.catalog), arena.FOOD_KINDS)
        self.assertEqual(tuple(dashboard.FOOD_EFFECTS), arena.FOOD_KINDS)

    def test_effects_match(self):
        for kind, item in self.catalog.items():
            with self.subTest(kind=kind):
                if item["revives"]:
                    self.assertEqual(dashboard.FOOD_EFFECTS[kind], (0, True))
                else:
                    self.assertEqual(dashboard.FOOD_EFFECTS[kind],
                                     (item["restoreMins"] * 60, False))

    def test_labels_match(self):
        for kind, item in self.catalog.items():
            with self.subTest(kind=kind):
                self.assertEqual(arena.FOOD_LABELS[kind], (item["name"], item["plural"]))


if __name__ == "__main__":
    unittest.main()
