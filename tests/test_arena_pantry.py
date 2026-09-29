"""Client-side pantry tests for arena.py: the wire (paths, methods, the body
allowlist), the gift drain with its old-server backoff, the gift notice text
and the poller pass.

Network and link storage are stubbed, so these run with no server. Stdlib only.
"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import arena  # noqa: E402
from test_arena import FORBIDDEN_KEYS, _collect_keys  # noqa: E402

RID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"


class PantryWireTests(unittest.TestCase):
    def setUp(self):
        self._req = arena._request
        self._link = arena.load_link
        self._cfg = arena._load_config
        self._off = arena._gift_drain_off_until
        arena.load_link = lambda: {"token": "T", "url": "https://arena.example"}
        arena._load_config = lambda: {}  # normally injected via arena.init()
        arena._gift_drain_off_until = 0.0
        self.sent = []
        self.reply = (200, {"coins": 0})
        arena._request = self._fake

    def tearDown(self):
        arena._request = self._req
        arena.load_link = self._link
        arena._load_config = self._cfg
        arena._gift_drain_off_until = self._off
        for method, url, token, body in self.sent:
            self.assertEqual(_collect_keys(body) & FORBIDDEN_KEYS, set(), url)

    def _fake(self, method, url, token=None, body=None):
        self.sent.append((method, url, token, body))
        return self.reply

    def test_get_state(self):
        self.assertEqual(arena.pantry(), self.reply)
        self.assertEqual(self.sent, [("GET", "https://arena.example/v1/pantry", "T", None)])

    def test_actions_post_to_their_paths_with_exact_bodies(self):
        cases = [
            ("claim", {}, {}),
            ("buy", {"requestId": RID, "kind": "bento", "qty": 2},
             {"requestId": RID, "kind": "bento", "qty": 2}),
            ("eat", {"requestId": RID, "kind": "tonic"}, {"requestId": RID, "kind": "tonic"}),
            ("give", {"requestId": RID, "toHandle": "gary", "coins": 2, "kind": "berry",
                      "qty": 1, "note": "hi"},
             {"requestId": RID, "toHandle": "gary", "coins": 2, "kind": "berry",
              "qty": 1, "note": "hi"}),
        ]
        for action, body, want in cases:
            with self.subTest(action=action):
                self.sent.clear()
                arena.pantry(action, body)
                self.assertEqual(self.sent, [("POST", "https://arena.example/v1/pantry/" + action,
                                              "T", want)])

    def test_allowlist_strips_everything_else(self):
        leaky = {"requestId": RID, "kind": "berry", "sessionId": "abc", "title": "Secret plan",
                 "path": "/Users/me/client", "cwd": "/x", "fatigue": {"state": "tired"},
                 "retry": True}
        arena.pantry("eat", leaky)
        self.assertEqual(self.sent[0][3], {"requestId": RID, "kind": "berry"})
        arena.pantry("claim", None)
        self.assertEqual(self.sent[1][3], {})

    def test_unknown_action_makes_no_request(self):
        self.assertEqual(arena.pantry("steal", {"requestId": RID}),
                         (400, {"error": "unknown pantry action"}))
        self.assertEqual(arena.pantry("gifts/drain"), (400, {"error": "unknown pantry action"}))
        self.assertEqual(self.sent, [])

    def test_not_paired(self):
        arena.load_link = lambda: {}
        self.assertEqual(arena.pantry(), (400, {"error": "not paired"}))
        self.assertEqual(arena.pantry("claim", {}), (400, {"error": "not paired"}))
        self.assertEqual(arena.drain_gifts(), [])
        self.assertEqual(self.sent, [])

    def test_link_url_wins_over_config(self):
        arena._load_config = lambda: {"arenaUrl": "https://other.example"}
        arena.pantry()
        self.assertEqual(self.sent[0][1], "https://arena.example/v1/pantry")
        arena.load_link = lambda: {"token": "T"}
        arena.pantry()
        self.assertEqual(self.sent[1][1], "https://other.example/v1/pantry")

    def test_drain(self):
        gifts = [{"id": "g1", "fromHandle": "ash", "coins": 2}]
        self.reply = (200, {"gifts": gifts + ["junk"]})
        self.assertEqual(arena.drain_gifts(), gifts)
        self.assertEqual(self.sent, [("POST", "https://arena.example/v1/pantry/gifts/drain",
                                      "T", {})])
        for reply in ((500, {"error": "boom"}), (0, {"error": "offline"}), (200, {}),
                      (200, {"gifts": "x"}), (200, [])):
            with self.subTest(reply=reply):
                self.reply = reply
                self.assertEqual(arena.drain_gifts(), [])

    def test_drain_backs_off_after_an_old_server_404(self):
        self.reply = (404, {"detail": "Not Found", "error": "Not Found"})
        before = arena.time.time()
        self.assertEqual(arena.drain_gifts(), [])
        self.assertGreaterEqual(arena._gift_drain_off_until,
                                before + arena.GIFT_DRAIN_BACKOFF_SECS)
        self.reply = (200, {"gifts": [{"id": "g1"}]})
        self.assertEqual(arena.drain_gifts(), [])
        self.assertEqual(len(self.sent), 1)          # no request while backing off
        arena._gift_drain_off_until = arena.time.time() - 1   # expired
        self.assertEqual(arena.drain_gifts(), [{"id": "g1"}])
        self.assertEqual(len(self.sent), 2)


class GiftNoticeTests(unittest.TestCase):
    def test_coins_and_food_with_a_note(self):
        self.assertEqual(
            arena.gift_notice({"fromName": "Gary", "fromHandle": "gary", "coins": 2,
                               "kind": "riceball", "qty": 1, "note": "for your sleepy Voltkit"}),
            ("\U0001F381 Gary sent you a gift",
             "2 Poke Coins and 1 Rice Ball: for your sleepy Voltkit"))

    def test_coins_only(self):
        self.assertEqual(arena.gift_notice({"fromHandle": "ash", "coins": 1, "qty": 0,
                                            "kind": None}),
                         ("\U0001F381 ash sent you a gift", "1 Poke Coin"))

    def test_food_only_singular_and_plural(self):
        self.assertEqual(arena.gift_notice({"fromName": "Ash", "kind": "berry", "qty": 1})[1],
                         "1 Berry")
        self.assertEqual(arena.gift_notice({"fromName": "Ash", "kind": "berry", "qty": 2})[1],
                         "2 Berries")
        self.assertEqual(arena.gift_notice({"fromName": "Ash", "kind": "tonic", "qty": 3})[1],
                         "3 Revive Tonics")

    def test_odd_shapes_never_raise(self):
        self.assertEqual(arena.gift_notice({}), ("\U0001F381 Someone sent you a gift", "a gift"))
        self.assertEqual(arena.gift_notice({"fromName": 7, "coins": True, "qty": "2",
                                            "kind": ["berry"], "note": 5}),
                         ("\U0001F381 Someone sent you a gift", "a gift"))
        self.assertEqual(arena.gift_notice({"kind": "pizza", "qty": 2})[1], "a gift")


class PollOnceTests(unittest.TestCase):
    """The real poller pass, with the drains stubbed."""

    def setUp(self):
        self._nudges = arena.drain_nudges
        self._gifts = arena.drain_gifts

    def tearDown(self):
        arena.drain_nudges = self._nudges
        arena.drain_gifts = self._gifts

    def test_nudges_ping_and_gifts_are_silent(self):
        arena.drain_nudges = lambda: [{"fromName": "Ash", "note": "come look"},
                                      {"fromHandle": "gary", "note": ""}]
        arena.drain_gifts = lambda: [{"fromName": "Gary", "coins": 2, "kind": "riceball",
                                      "qty": 1, "note": "for your sleepy Voltkit"}]
        fired = []
        arena._poll_once(lambda *args: fired.append(args))
        self.assertEqual(fired, [
            ("\U0001F44B Ash nudged you", "Ash nudged you: come look"),
            ("\U0001F44B gary nudged you", "gary nudged you"),
            ("\U0001F381 Gary sent you a gift",
             "2 Poke Coins and 1 Rice Ball: for your sleepy Voltkit", False),
        ])

    def test_nothing_waiting_notifies_nothing(self):
        arena.drain_nudges = lambda: []
        arena.drain_gifts = lambda: []
        fired = []
        arena._poll_once(lambda *args: fired.append(args))
        self.assertEqual(fired, [])


if __name__ == "__main__":
    unittest.main()
