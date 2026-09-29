"""The local cali proxy in dashboard.py: order validation, the allowlist that
arena.cali_log_order() forwards, and the three local routes. The Arena is always
stubbed; nothing here touches the network. Stdlib only.
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

SID = "11111111-1111-4111-8111-111111111111"
RID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"


def counts(mh=0, ms=0, wh=0, ws=0):
    return {"mildHard": mh, "mildSoft": ms, "wildHard": wh, "wildSoft": ws}


def order(diners=None, **kw):
    body = {"requestId": RID,
            "diners": diners if diners is not None else [{"name": "Ana", "tacos": counts(mh=3)}]}
    body.update(kw)
    return body


class CaliBodyTests(unittest.TestCase):
    def ok(self, body):
        clean, err = dashboard.cali_body(body)
        self.assertIsNone(err, err)
        self.assertNotIn("sessionId", clean)
        return clean

    def err(self, body):
        clean, err = dashboard.cali_body(body)
        self.assertIsNone(clean)
        return err

    def test_minimal_order(self):
        clean = self.ok(order())
        self.assertEqual(clean["requestId"], RID)
        self.assertEqual(clean["diners"], [{"tacos": counts(mh=3), "name": "Ana"}])
        self.assertEqual(clean["note"], "")
        self.assertNotIn("date", clean)

    def test_missing_variants_default_to_zero(self):
        clean = self.ok(order([{"name": "Ana", "tacos": {"wildSoft": 2}}]))
        self.assertEqual(clean["diners"][0]["tacos"], counts(ws=2))

    def test_absent_tacos_is_a_zero_taco_diner(self):
        """Someone can come along and not order. They still attended."""
        clean = self.ok(order([{"name": "Ana"}]))
        self.assertEqual(clean["diners"][0]["tacos"], counts())

    def test_handle_and_name_both_kept(self):
        clean = self.ok(order([{"handle": "ana", "name": "Ana", "tacos": counts(mh=1)}]))
        self.assertEqual(clean["diners"][0]["handle"], "ana")
        self.assertEqual(clean["diners"][0]["name"], "Ana")

    def test_bad_request_id(self):
        self.assertEqual(self.err(order(**{"requestId": "short"})), "invalid requestId")

    def test_diner_needs_an_identity(self):
        self.assertEqual(self.err(order([{"tacos": counts(mh=1)}])),
                         "every diner needs a handle or a name")

    def test_no_diners(self):
        self.assertIn("1 to 20 diners", self.err(order([])))

    def test_too_many_diners(self):
        many = [{"name": "P%d" % i, "tacos": counts(mh=1)} for i in range(21)]
        self.assertIn("1 to 20 diners", self.err(order(many)))

    def test_duplicate_diner(self):
        self.assertEqual(
            self.err(order([{"name": "Ana", "tacos": counts(mh=1)},
                            {"name": "ana", "tacos": counts(ws=1)}])),
            "the same diner is listed twice")

    def test_bad_handle(self):
        self.assertEqual(self.err(order([{"handle": "a b", "tacos": counts(mh=1)}])),
                         "invalid handle")

    def test_boolean_is_not_a_taco_count(self):
        self.assertIn("whole number",
                      self.err(order([{"name": "Ana", "tacos": {"mildHard": True}}])))

    def test_string_is_not_a_taco_count(self):
        self.assertIn("whole number",
                      self.err(order([{"name": "Ana", "tacos": {"mildHard": "3"}}])))

    def test_count_over_the_cap(self):
        self.assertIn("whole number",
                      self.err(order([{"name": "Ana", "tacos": {"mildHard": 51}}])))

    def test_negative_count(self):
        self.assertIn("whole number",
                      self.err(order([{"name": "Ana", "tacos": {"mildHard": -1}}])))

    def test_bad_date(self):
        self.assertEqual(self.err(order(date="next tuesday")),
                         "date must look like YYYY-MM-DD")

    def test_good_date_kept(self):
        self.assertEqual(self.ok(order(date="2026-09-29"))["date"], "2026-09-29")

    def test_note_is_cleaned_and_capped(self):
        clean = self.ok(order(note="  bogo night  " + "x" * 200))
        self.assertTrue(clean["note"].startswith("bogo night x"))
        self.assertLessEqual(len(clean["note"]), 80)

    def test_unprintables_are_dropped_not_spaced(self):
        """Same cleaner as pantry_body and the server's GiveRequest: a control
        character is removed outright, so it never becomes a word break."""
        self.assertEqual(self.ok(order(note="bogo\tnight"))["note"], "bogonight")

    def test_name_is_cleaned_and_capped(self):
        clean = self.ok(order([{"name": "  A" + "n" * 80, "tacos": counts(mh=1)}]))
        self.assertLessEqual(len(clean["diners"][0]["name"]), 40)

    def test_stray_keys_are_dropped(self):
        clean = self.ok(order([{"name": "Ana", "tacos": counts(mh=1), "sessionId": SID}],
                              sessionId=SID, cwd="/Users/ana/secret-project"))
        self.assertFalse(FORBIDDEN_KEYS & _collect_keys(clean))

    def test_totals_are_never_accepted_from_the_page(self):
        """TT and the buy-1-get-1 price are the server's to decide."""
        clean = self.ok(order(totalTacos=999, paidTacos=0, freeTacos=999))
        self.assertNotIn("totalTacos", clean)
        self.assertNotIn("paidTacos", clean)
        self.assertNotIn("freeTacos", clean)


class ArenaAllowlistTests(unittest.TestCase):
    """arena._cali_order is the second gate: even a caller bug can't leak."""

    def test_rebuilds_from_allowlisted_keys_only(self):
        clean = arena._cali_order({
            "requestId": RID,
            "note": "bogo night",
            "date": "2026-09-29",
            "sessionId": SID,
            "projectName": "stealth-startup",
            "diners": [{"handle": "ana", "name": "Ana", "tacos": counts(mh=3),
                        "cwd": "/Users/ana", "title": "secret"}],
        })
        self.assertFalse(FORBIDDEN_KEYS & _collect_keys(clean))
        self.assertEqual(sorted(clean), ["date", "diners", "note", "requestId"])
        self.assertEqual(sorted(clean["diners"][0]), ["handle", "name", "tacos"])

    def test_non_dict_diners_are_dropped(self):
        clean = arena._cali_order({"requestId": RID, "diners": ["ana", None, 7]})
        self.assertEqual(clean["diners"], [])

    def test_garbage_body_is_survivable(self):
        self.assertEqual(arena._cali_order(None), {"diners": []})


class LocalRouteTests(unittest.TestCase):
    """The real Handler on an ephemeral 127.0.0.1 port, Arena stubbed."""

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
        self._saved = (arena.cali_board, arena.cali_orders, arena.cali_log_order)
        self.board_calls, self.order_calls, self.logged = [], [], []
        self.reply = (200, {"entries": []})

        def fake_board(window="season"):
            self.board_calls.append(window)
            return self.reply

        def fake_orders():
            self.order_calls.append(True)
            return self.reply

        def fake_log(body):
            self.logged.append(body)
            return self.reply

        arena.cali_board, arena.cali_orders, arena.cali_log_order = (
            fake_board, fake_orders, fake_log)

    def tearDown(self):
        arena.cali_board, arena.cali_orders, arena.cali_log_order = self._saved

    def call(self, method, path, body=None, token=True):
        req = urllib.request.Request(
            "http://127.0.0.1:%d%s" % (self.port, path), method=method,
            data=json.dumps(body).encode("utf-8") if body is not None else None)
        req.add_header("Content-Type", "application/json")
        if token:
            req.add_header("X-HQ-Token", dashboard.CSRF_TOKEN)
        try:
            with self.opener.open(req, timeout=10) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read().decode("utf-8"))
            finally:
                e.close()

    def test_get_board_passes_the_window(self):
        code, _ = self.call("GET", "/api/arena/cali/board?window=7d")
        self.assertEqual(code, 200)
        self.assertEqual(self.board_calls, ["7d"])

    def test_unknown_window_falls_back_to_season(self):
        self.call("GET", "/api/arena/cali/board?window=forever")
        self.assertEqual(self.board_calls, ["season"])

    def test_get_orders(self):
        code, _ = self.call("GET", "/api/arena/cali/orders")
        self.assertEqual(code, 200)
        self.assertEqual(self.order_calls, [True])

    def test_post_order_forwards_the_clean_body(self):
        code, _ = self.call("POST", "/api/arena/cali/order", order())
        self.assertEqual(code, 200)
        self.assertEqual(self.logged, [{
            "requestId": RID,
            "diners": [{"tacos": counts(mh=3), "name": "Ana"}],
            "note": "",
        }])

    def test_post_order_rejects_a_bad_body_locally(self):
        code, body = self.call("POST", "/api/arena/cali/order", order([]))
        self.assertEqual(code, 400)
        self.assertIn("diners", body["error"])
        self.assertEqual(self.logged, [])

    def test_post_order_needs_the_csrf_token(self):
        code, _ = self.call("POST", "/api/arena/cali/order", order(), token=False)
        self.assertEqual(code, 403)
        self.assertEqual(self.logged, [])

    def test_server_refusal_passes_through(self):
        self.reply = (404, {"detail": "no such person: ghost"})
        code, body = self.call("POST", "/api/arena/cali/order", order())
        self.assertEqual(code, 404)
        self.assertEqual(body["detail"], "no such person: ghost")

    def test_arena_failure_becomes_a_502(self):
        def boom(window="season"):
            raise RuntimeError("connection refused")
        arena.cali_board = boom
        code, body = self.call("GET", "/api/arena/cali/board")
        self.assertEqual(code, 502)
        self.assertIn("arena request failed", body["error"])


if __name__ == "__main__":
    unittest.main()
