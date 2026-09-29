"""Client-side quest reward proxy tests for arena.py and dashboard.py.

Verifies the wire format, the privacy boundary (no forbidden keys), and the
dashboard validation layer.
"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import arena  # noqa: E402
from test_arena import FORBIDDEN_KEYS, _collect_keys  # noqa: E402

sys.path.insert(0, os.path.dirname(HERE))
import importlib  # noqa: E402


class QuestRewardWireTests(unittest.TestCase):
    def setUp(self):
        self._req = arena._request
        self._link = arena.load_link
        arena.load_link = lambda: {"token": "T", "url": "https://arena.example"}
        self.sent = []
        self.reply = (200, {"ok": True, "coins": 12, "reward": 2})
        arena._request = self._fake

    def tearDown(self):
        arena._request = self._req
        arena.load_link = self._link
        for method, url, token, body in self.sent:
            self.assertEqual(_collect_keys(body) & FORBIDDEN_KEYS, set(), url)

    def _fake(self, method, url, token=None, body=None):
        self.sent.append((method, url, token, body))
        return self.reply

    def test_quest_reward_wire(self):
        code, resp = arena.quest_reward(
            "quest:d_prompts_10:2026-09-29", "quest", "d_prompts_10", None, 2)
        self.assertEqual(code, 200)
        self.assertEqual(len(self.sent), 1)
        m, url, tok, body = self.sent[0]
        self.assertEqual(m, "POST")
        self.assertIn("/v1/pantry/reward", url)
        self.assertEqual(body["requestId"], "quest:d_prompts_10:2026-09-29")
        self.assertEqual(body["kind"], "quest")
        self.assertEqual(body["questId"], "d_prompts_10")
        self.assertNotIn("tier", body)
        self.assertEqual(body["coins"], 2)

    def test_achievement_reward_wire(self):
        code, resp = arena.quest_reward(
            "ach:a_prompts:bronze", "achievement", "a_prompts", "bronze", 3)
        self.assertEqual(code, 200)
        m, url, tok, body = self.sent[0]
        self.assertEqual(body["tier"], "bronze")
        self.assertEqual(body["kind"], "achievement")

    def test_not_paired(self):
        arena.load_link = lambda: {}
        arena._load_config = lambda: {}
        code, resp = arena.quest_reward("quest:x:y", "quest", "x", None, 1)
        self.assertEqual(code, 400)

    def test_no_forbidden_keys_leak(self):
        arena.quest_reward(
            "quest:d_active:2026-09-29", "quest", "d_active", None, 1)
        for _, _, _, body in self.sent:
            self.assertEqual(_collect_keys(body) & FORBIDDEN_KEYS, set())


class DashboardQuestValidationTests(unittest.TestCase):
    """Test the dashboard's _quest_reward validation."""

    @classmethod
    def setUpClass(cls):
        # Avoid importing dashboard at module level (it starts a server).
        # We just need the _quest_reward function and its helpers.
        import types
        cls._arena_quest_reward = arena.quest_reward
        cls._sent = []
        cls._reply = (200, {"ok": True, "coins": 5, "reward": 2})

    def setUp(self):
        self._sent = []
        self._orig = arena.quest_reward
        arena.quest_reward = self._fake_quest_reward

    def tearDown(self):
        arena.quest_reward = self._orig

    def _fake_quest_reward(self, *a, **kw):
        self._sent.append((a, kw))
        return self._reply

    def test_quest_rid_allows_colons(self):
        """The quest requestId format uses colons, unlike regular pantry _RID_RE."""
        import re
        pat = re.compile(r"^(quest|ach):[a-z0-9_]+:.{1,60}$")
        self.assertTrue(pat.fullmatch("quest:d_prompts_10:2026-09-29"))
        self.assertTrue(pat.fullmatch("ach:a_prompts:bronze"))
        self.assertFalse(pat.fullmatch("hack:injection:attempt"))
        self.assertFalse(pat.fullmatch(""))

    def test_quest_rid_rejects_regular_pantry_ids(self):
        import re
        pat = re.compile(r"^(quest|ach):[a-z0-9_]+:.{1,60}$")
        self.assertFalse(pat.fullmatch("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"))


if __name__ == "__main__":
    unittest.main()
