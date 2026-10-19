"""The cali menu is mirrored by hand; this catches drift.

backend-rs/src/cali.rs CALI_MENU is the authority (keys and display names) and
its order validation looks keys up in CALI_MENU itself. The local server's
allowlist is dashboard-rs/src/arena.rs CALI_ITEM_KEYS, its item cap
dashboard-rs/src/handlers.rs CALI_MAX_PER_ITEM mirrors cali.rs MAX_PER_ITEM,
and its board windows (arena.rs CALI_WINDOWS) are the Arena's: service.rs
WINDOWS plus "lastseason". The Rust is read as text. Stdlib only.
"""
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from rsconst import read, rs_block, rs_int, rs_path, rs_strings  # noqa: E402

CALI_RS = rs_path("backend-rs", "src", "cali.rs")
SERVICE_RS = rs_path("backend-rs", "src", "service.rs")
ARENA_RS = rs_path("dashboard-rs", "src", "arena.rs")
HANDLERS_RS = rs_path("dashboard-rs", "src", "handlers.rs")


def load_menu():
    """key -> display name, in menu order."""
    return dict(re.findall(r'\("([^"]+)",\s*"([^"]*)"\)', rs_block(CALI_RS, "CALI_MENU")))


class CaliMenuSyncTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        for path in (CALI_RS, SERVICE_RS, ARENA_RS, HANDLERS_RS):
            if not os.path.exists(path):
                raise AssertionError(path + " is missing")
        cls.menu = load_menu()

    def test_allowlist_matches_the_menu_in_order(self):
        self.assertEqual(len(self.menu), 11)
        self.assertEqual(tuple(self.menu), tuple(rs_strings(ARENA_RS, "CALI_ITEM_KEYS")))

    def test_the_arena_validates_against_the_menu_itself(self):
        self.assertIn('CALI_MENU.iter().position(|(key, _)| *key == k.as_str())', read(CALI_RS))

    def test_keys_are_short_lowercase_words(self):
        for k, name in self.menu.items():
            with self.subTest(kind=k):
                self.assertRegex(k, r"^[a-z]{1,16}$")
                self.assertTrue(name.strip())

    def test_no_menu_key_collides_with_a_taco_variant(self):
        """The board's `favorite` is either kind of key, so they must not overlap."""
        tacos = set(rs_strings(ARENA_RS, "CALI_TACO_KEYS"))
        self.assertEqual(tacos, {"mildHard", "mildSoft", "wildHard", "wildSoft"})
        self.assertFalse(set(self.menu) & tacos)

    def test_item_cap_matches(self):
        self.assertEqual(rs_int(HANDLERS_RS, "CALI_MAX_PER_ITEM"), rs_int(CALI_RS, "MAX_PER_ITEM"))

    def test_windows_include_lastseason_both_sides(self):
        local = rs_strings(ARENA_RS, "CALI_WINDOWS")
        self.assertIn("lastseason", local)
        self.assertIn('w.push("lastseason");', read(CALI_RS))
        self.assertEqual(local, rs_strings(SERVICE_RS, "WINDOWS") + ["lastseason"])


if __name__ == "__main__":
    unittest.main()
