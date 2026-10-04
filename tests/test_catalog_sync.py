"""The food catalog is mirrored by hand in four places; this catches drift.

The backend's app/pantry.py CATALOG is the authority for names and prices,
app/schemas.py FoodKind lists its kinds for request validation,
arena.FOOD_KINDS / FOOD_LABELS mirror its kinds and labels, and
dashboard.FOOD_EFFECTS mirrors its effects. The backend files are read with
`ast`, so no backend dependency is imported. Stdlib only.
"""
import ast
import os
import re
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import arena  # noqa: E402
import dashboard  # noqa: E402

PANTRY_PY = os.path.join(ROOT, "backend", "app", "pantry.py")
SCHEMAS_PY = os.path.join(ROOT, "backend", "app", "schemas.py")
SEASONS = ("all", "spring", "summer", "fall", "winter")


def _module_assign(path, name):
    """The value node of a module-level `name = ...` in path."""
    with open(path, encoding="utf-8") as f:
        tree = ast.parse(f.read(), path)
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == name for t in node.targets):
            return node.value
    raise AssertionError("no module-level %s in %s" % (name, os.path.relpath(path, ROOT)))


def load_catalog():
    return ast.literal_eval(_module_assign(PANTRY_PY, "CATALOG"))


def load_food_kinds():
    """The strings in schemas.py's `FoodKind = Literal[...]`, in order."""
    node = _module_assign(SCHEMAS_PY, "FoodKind")
    if not (isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name)
            and node.value.id == "Literal"):
        raise AssertionError("FoodKind is not a Literal[...]")
    elts = node.slice.elts if isinstance(node.slice, ast.Tuple) else [node.slice]
    return tuple(ast.literal_eval(e) for e in elts)


class CatalogSyncTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        for path in (PANTRY_PY, SCHEMAS_PY):
            if not os.path.exists(path):
                raise AssertionError(os.path.relpath(path, ROOT) + " is missing")
        cls.catalog = load_catalog()

    def test_kinds_match_in_order(self):
        self.assertEqual(tuple(self.catalog), arena.FOOD_KINDS)
        self.assertEqual(tuple(dashboard.FOOD_EFFECTS), arena.FOOD_KINDS)
        self.assertEqual(load_food_kinds(), arena.FOOD_KINDS)

    def test_kinds_fit_the_columns(self):
        # poke_balances.item and poke_ledger.kind are String(16).
        for kind in self.catalog:
            with self.subTest(kind=kind):
                self.assertRegex(kind, re.compile(r"^[a-z]{1,16}$"))

    def test_effects_match(self):
        for kind, item in self.catalog.items():
            with self.subTest(kind=kind):
                self.assertEqual(dashboard.FOOD_EFFECTS[kind],
                                 (item["restoreMins"] * 60, item["revives"]))

    def test_labels_match(self):
        for kind, item in self.catalog.items():
            with self.subTest(kind=kind):
                self.assertEqual(arena.FOOD_LABELS[kind], (item["name"], item["plural"]))

    def test_seasons_are_valid(self):
        for kind, item in self.catalog.items():
            with self.subTest(kind=kind):
                self.assertIn(item["season"], SEASONS)
        # Every season has something of its own to sell.
        for season in SEASONS[1:]:
            with self.subTest(season=season):
                self.assertTrue(any(i["season"] == season for i in self.catalog.values()))

    def test_entries_are_well_formed(self):
        for kind, item in self.catalog.items():
            with self.subTest(kind=kind):
                self.assertEqual(set(item), {"name", "plural", "emoji", "price",
                                             "restoreMins", "revives", "season"})
                self.assertTrue(1 <= item["price"] <= 30)
                self.assertGreaterEqual(item["restoreMins"], 0)
                self.assertIsInstance(item["revives"], bool)
                if not item["revives"]:
                    self.assertGreater(item["restoreMins"], 0)


if __name__ == "__main__":
    unittest.main()
