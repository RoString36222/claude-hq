"""The food catalog is mirrored by hand in several places; this catches drift.

backend-rs/src/pantry.rs CATALOG is the authority for names, prices and
effects (its request validation, `food_kinds()`, is derived from it), and the
local server mirrors it: dashboard-rs/src/arena.rs FOOD_KINDS / FOOD_LABELS
(kinds and gift-notice labels) and dashboard-rs/src/fatigue.rs FOOD_EFFECTS
(what a snack does to a creature). The Rust is read as text, so no toolchain
is needed. Stdlib only.
"""
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from rsconst import read, rs_block, rs_path, rs_strings  # noqa: E402

PANTRY_RS = rs_path("backend-rs", "src", "pantry.rs")
ARENA_RS = rs_path("dashboard-rs", "src", "arena.rs")
FATIGUE_RS = rs_path("dashboard-rs", "src", "fatigue.rs")
SEASONS = ("all", "spring", "summer", "fall", "winter")

FOOD_RE = re.compile(
    r'Food \{ kind: "(\w+)",\s*name: "([^"]*)",\s*plural: "([^"]*)",\s*emoji: "([^"]*)",\s*'
    r'price: (\d+),\s*restore_mins: (\d+),\s*revives: (true|false),\s*season: "(\w+)" \}')


def load_catalog():
    """kind -> entry, in CATALOG order."""
    block = rs_block(PANTRY_RS, "CATALOG")
    rows = FOOD_RE.findall(block)
    if len(rows) != block.count("Food {"):
        raise AssertionError("a CATALOG row did not parse")
    return {k: {"name": n, "plural": p, "emoji": e, "price": int(pr), "restoreMins": int(rm),
                "revives": rv == "true", "season": s}
            for k, n, p, e, pr, rm, rv, s in rows}


def load_effects():
    return [(k, (int(secs), rv == "true")) for k, secs, rv in
            re.findall(r'\("(\w+)",\s*\((\d+),\s*(true|false)\)\)', rs_block(FATIGUE_RS, "FOOD_EFFECTS"))]


def load_labels():
    flat = rs_strings(ARENA_RS, "FOOD_LABELS")
    return [(flat[i], (flat[i + 1], flat[i + 2])) for i in range(0, len(flat), 3)]


class CatalogSyncTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        for path in (PANTRY_RS, ARENA_RS, FATIGUE_RS):
            if not os.path.exists(path):
                raise AssertionError(path + " is missing")
        cls.catalog = load_catalog()
        cls.kinds = tuple(rs_strings(ARENA_RS, "FOOD_KINDS"))

    def test_kinds_match_in_order(self):
        self.assertEqual(len(self.catalog), 21)
        self.assertIn("static CATALOG: [Food; %d]" % len(self.catalog), read(PANTRY_RS))
        self.assertEqual(tuple(self.catalog), self.kinds)
        self.assertEqual(tuple(k for k, _ in load_effects()), self.kinds)
        self.assertEqual(tuple(k for k, _ in load_labels()), self.kinds)
        # The Arena validates a food kind against CATALOG itself, not a copy.
        self.assertRegex(read(PANTRY_RS), r"fn food_kinds\(\) -> Vec<&'static str> \{\s*CATALOG\.iter\(\)\.map\(\|f\| f\.kind\)\.collect\(\)")

    def test_kinds_fit_the_columns(self):
        # poke_balances.item and poke_ledger.kind are String(16).
        for kind in self.catalog:
            with self.subTest(kind=kind):
                self.assertRegex(kind, re.compile(r"^[a-z]{1,16}$"))

    def test_effects_match(self):
        effects = dict(load_effects())
        for kind, item in self.catalog.items():
            with self.subTest(kind=kind):
                self.assertEqual(effects[kind], (item["restoreMins"] * 60, item["revives"]))

    def test_labels_match(self):
        labels = dict(load_labels())
        for kind, item in self.catalog.items():
            with self.subTest(kind=kind):
                self.assertEqual(labels[kind], (item["name"], item["plural"]))

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
                self.assertTrue(item["name"].strip() and item["plural"].strip() and item["emoji"])
                self.assertTrue(1 <= item["price"] <= 30)
                self.assertGreaterEqual(item["restoreMins"], 0)
                if not item["revives"]:
                    self.assertGreater(item["restoreMins"], 0)


if __name__ == "__main__":
    unittest.main()
