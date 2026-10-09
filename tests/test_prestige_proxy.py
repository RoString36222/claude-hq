"""Prestige (HQ 2.5): the local proxy routes in ext_prestige.py.

Only a requestId ever leaves the machine; user ids are checked before any
request is made. The Arena is mocked.
"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import arena  # noqa: E402
import dashboard  # noqa: E402
import ext_prestige  # noqa: E402
from test_arena import FORBIDDEN_KEYS, _collect_keys  # noqa: E402

UID = "0123abcd-0000-4000-8000-00000000beef"


class PrestigeProxyTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self._req, self._link = arena._request, arena.load_link

        def fake(method, url, token=None, body=None, **kw):
            self.calls.append((method, url, token, body))
            return 200, {"stars": 1}
        arena._request = fake
        arena.load_link = lambda: {"token": "tok", "url": "https://arena.test"}

    def tearDown(self):
        arena._request, arena.load_link = self._req, self._link

    def arg(self, q):
        return lambda k: q.get(k, "")

    def test_get_me_and_a_user(self):
        self.assertEqual(ext_prestige.get_prestige(self.arg({}))[0], 200)
        ext_prestige.get_prestige(self.arg({"u": UID}))
        self.assertEqual(self.calls[0][:3], ("GET", "https://arena.test/v1/prestige/me", "tok"))
        self.assertEqual(self.calls[1][1], "https://arena.test/v1/prestige/" + UID)
        self.assertIsNone(self.calls[0][3])

    def test_bad_user_ids_never_reach_the_arena(self):
        for u in ("../me", "bob", UID + "x", "me/../x"):
            code, body = ext_prestige.get_prestige(self.arg({"u": u}))
            self.assertEqual(code, 400)
        self.assertEqual(self.calls, [])

    def test_claim_sends_only_a_request_id(self):
        ext_prestige.post_claim({"requestId": "prestige-abcdef0123456789", "stars": 9, "title": "x"})
        ext_prestige.post_claim({})
        ext_prestige.post_claim({"requestId": "bad id"})
        ext_prestige.post_claim(None)
        self.assertEqual(len(self.calls), 4)
        for method, url, token, body in self.calls:
            self.assertEqual((method, url, token), ("POST", "https://arena.test/v1/prestige", "tok"))
            self.assertEqual(set(body), {"requestId"})
            self.assertRegex(body["requestId"], r"^[A-Za-z0-9_-]{16,64}$")
            self.assertEqual(_collect_keys(body) & FORBIDDEN_KEYS, set())
        self.assertEqual(self.calls[0][3]["requestId"], "prestige-abcdef0123456789")

    def test_unpaired_is_a_local_400(self):
        saved = arena._authed
        arena._authed = lambda: (None, None)
        self.addCleanup(setattr, arena, "_authed", saved)
        self.assertEqual(ext_prestige.post_claim({})[0], 400)
        self.assertEqual(ext_prestige.get_prestige(self.arg({}))[0], 400)
        self.assertEqual(self.calls, [])

    def test_wired_into_the_dashboard(self):
        self.assertIn(ext_prestige, dashboard.EXT)
        self.assertIn("/api/arena/prestige/claim", dashboard.POST_PATHS)


if __name__ == "__main__":
    unittest.main()
