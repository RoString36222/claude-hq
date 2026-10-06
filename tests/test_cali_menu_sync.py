"""The cali menu is mirrored by hand in three places; this catches drift.

backend app/tacos.py CALI_MENU is the authority (keys and display names),
app/schemas.py `MenuItem = Literal[...]` lists its keys for request validation,
and arena.CALI_ITEM_KEYS is the local allowlist. dashboard.CALI_MAX_PER_ITEM
mirrors schemas.MAX_PER_ITEM. The backend files are read with `ast`, so no
backend dependency is imported. Stdlib only.
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

TACOS_PY = os.path.join(ROOT, "backend", "app", "tacos.py")
SCHEMAS_PY = os.path.join(ROOT, "backend", "app", "schemas.py")


def _module_assign(path, name):
    """The value node of a module-level `name = ...` in path."""
    with open(path, encoding="utf-8") as f:
        tree = ast.parse(f.read(), path)
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == name for t in node.targets):
            return node.value
    raise AssertionError("no module-level %s in %s" % (name, os.path.relpath(path, ROOT)))


def load_menu():
    return ast.literal_eval(_module_assign(TACOS_PY, "CALI_MENU"))


def load_menu_item_literal():
    """The strings in schemas.py's `MenuItem = Literal[...]`, in order."""
    node = _module_assign(SCHEMAS_PY, "MenuItem")
    if not (isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name)
            and node.value.id == "Literal"):
        raise AssertionError("MenuItem is not a Literal[...]")
    elts = node.slice.elts if isinstance(node.slice, ast.Tuple) else [node.slice]
    return tuple(ast.literal_eval(e) for e in elts)


class CaliMenuSyncTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        for path in (TACOS_PY, SCHEMAS_PY):
            if not os.path.exists(path):
                raise AssertionError(os.path.relpath(path, ROOT) + " is missing")
        cls.menu = load_menu()

    def test_allowlist_matches_the_menu_in_order(self):
        self.assertEqual(tuple(self.menu), arena.CALI_ITEM_KEYS)

    def test_schema_literal_matches_the_menu_in_order(self):
        self.assertEqual(load_menu_item_literal(), tuple(self.menu))

    def test_keys_are_short_lowercase_words(self):
        for k, name in self.menu.items():
            with self.subTest(kind=k):
                self.assertRegex(k, r"^[a-z]{1,16}$")
                self.assertTrue(isinstance(name, str) and name.strip())

    def test_no_menu_key_collides_with_a_taco_variant(self):
        """The board's `favorite` is either kind of key, so they must not overlap."""
        self.assertFalse(set(self.menu) & set(arena.CALI_TACO_KEYS))

    def test_item_cap_matches(self):
        cap = ast.literal_eval(_module_assign(SCHEMAS_PY, "MAX_PER_ITEM"))
        self.assertEqual(dashboard.CALI_MAX_PER_ITEM, cap)

    def test_windows_include_lastseason_both_sides(self):
        self.assertIn("lastseason", arena.CALI_WINDOWS)
        with open(TACOS_PY, encoding="utf-8") as f:
            self.assertTrue(re.search(r'CALI_WINDOWS = WINDOWS \+ \("lastseason",\)', f.read()))


if __name__ == "__main__":
    unittest.main()
