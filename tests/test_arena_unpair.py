"""Unpair revokes the device token on the Arena (best-effort) before forgetting
the local link, and the quest requestId fits the Arena's 64-char ledger key.
The Arena is always stubbed; nothing here touches the network. Stdlib only.
"""
import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import arena  # noqa: E402
import dashboard  # noqa: E402
from test_arena import FORBIDDEN_KEYS, _collect_keys  # noqa: E402


class UnpairTests(unittest.TestCase):
    def setUp(self):
        self._req, self._load, self._clear = arena._request, arena.load_link, arena.clear_link
        self.sent, self.cleared = [], []
        self.reply = (200, {"ok": True, "revoked": "dev-1"})
        self.link = {"token": "hqd_T", "url": "https://arena.example"}
        arena.load_link = lambda: dict(self.link)
        arena.clear_link = lambda: self.cleared.append(True)
        arena._request = self._fake

    def tearDown(self):
        arena._request, arena.load_link, arena.clear_link = self._req, self._load, self._clear
        for _m, _url, _tok, body, _t in self.sent:
            self.assertEqual(_collect_keys(body) & FORBIDDEN_KEYS, set())

    def _fake(self, method, url, token=None, body=None, timeout=None):
        self.sent.append((method, url, token, body, timeout))
        if isinstance(self.reply, Exception):
            raise self.reply
        return self.reply

    def test_revokes_then_clears(self):
        code, body = arena.unpair()
        self.assertEqual((code, body), (200, {"ok": True, "revoked": True}))
        self.assertEqual(len(self.sent), 1)
        method, url, token, payload, timeout = self.sent[0]
        self.assertEqual(method, "POST")
        self.assertEqual(url, "https://arena.example/v1/auth/revoke-self")
        self.assertEqual(token, "hqd_T")
        self.assertIsNone(payload)
        self.assertLessEqual(timeout, 5)
        self.assertEqual(self.cleared, [True])

    def test_already_revoked_token_counts_as_revoked(self):
        self.reply = (401, {"error": "unknown or revoked device"})
        self.assertEqual(arena.unpair(), (200, {"ok": True, "revoked": True}))
        self.assertEqual(self.cleared, [True])

    def test_unreachable_server_still_unpairs(self):
        for reply in ((0, {"error": "timed out"}), (404, {"error": "Not Found"}),
                      RuntimeError("boom")):
            self.cleared.clear()
            self.reply = reply
            self.assertEqual(arena.unpair(), (200, {"ok": True, "revoked": False}))
            self.assertEqual(self.cleared, [True])

    def test_not_paired_makes_no_request(self):
        self.link = {}
        orig = arena._load_config
        arena._load_config = lambda: {}
        try:
            self.assertEqual(arena.unpair(), (200, {"ok": True, "revoked": False}))
        finally:
            arena._load_config = orig
        self.assertEqual(self.sent, [])
        self.assertEqual(self.cleared, [True])


class UnpairRouteTests(unittest.TestCase):
    """POST /api/arena/unpair goes through arena.unpair()."""

    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), dashboard.Handler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(5)

    def setUp(self):
        self._unpair = arena.unpair
        self.calls = []

        def fake():
            self.calls.append(True)
            return 200, {"ok": True, "revoked": True}
        arena.unpair = fake

    def tearDown(self):
        arena.unpair = self._unpair

    def test_route_calls_unpair(self):
        req = urllib.request.Request(
            "http://127.0.0.1:%d/api/arena/unpair" % self.port, method="POST", data=b"{}")
        req.add_header("Content-Type", "application/json")
        req.add_header("X-HQ-Token", dashboard.CSRF_TOKEN)
        with self.opener.open(req, timeout=10) as resp:
            self.assertEqual(resp.status, 200)
            self.assertEqual(json.loads(resp.read().decode("utf-8"))["revoked"], True)
        self.assertEqual(self.calls, [True])


class QuestRidLengthTests(unittest.TestCase):
    def setUp(self):
        self._orig = arena.quest_reward
        self.sent = []
        arena.quest_reward = lambda *a: (self.sent.append(a), (200, {"ok": True}))[1]

    def tearDown(self):
        arena.quest_reward = self._orig

    def test_rid_matches_the_arena_column(self):
        ok = "quest:d_active:" + "x" * (64 - len("quest:d_active:"))
        self.assertEqual(len(ok), 64)
        self.assertTrue(dashboard._QUEST_RID_RE.fullmatch(ok))
        self.assertFalse(dashboard._QUEST_RID_RE.fullmatch(ok + "x"))

    def test_too_long_rid_is_refused_locally(self):
        code, _ = dashboard._quest_reward({
            "requestId": "quest:d_active:" + "x" * 60, "kind": "quest",
            "questId": "d_active", "coins": 1})
        self.assertEqual(code, 400)
        self.assertEqual(self.sent, [])
        code, _ = dashboard._quest_reward({
            "requestId": "quest:w_prompts_250:2026-W40", "kind": "quest",
            "questId": "w_prompts_250", "coins": 8})
        self.assertEqual(code, 200)


if __name__ == "__main__":
    unittest.main()
