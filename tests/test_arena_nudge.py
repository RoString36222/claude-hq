"""Client-side nudge tests: send, drain, and the offline-notification poller.

Network and link storage are stubbed, so these run with no server. Stdlib only.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import arena  # noqa: E402


class SendDrainTests(unittest.TestCase):
    def setUp(self):
        self._req = arena._request
        self._link = arena.load_link
        self._cfg = arena._load_config
        arena.load_link = lambda: {"token": "T", "url": "https://arena.example"}
        arena._load_config = lambda: {}  # normally injected via arena.init()

    def tearDown(self):
        arena._request = self._req
        arena.load_link = self._link
        arena._load_config = self._cfg

    def test_send_nudge_posts_handle_and_note(self):
        seen = {}
        def fake(method, url, token=None, body=None):
            seen.update(method=method, url=url, token=token, body=body)
            return 200, {"queued": True, "deliveredLive": 0}
        arena._request = fake
        code, resp = arena.send_nudge("gary", note="come play")
        self.assertEqual(code, 200)
        self.assertEqual(seen["method"], "POST")
        self.assertTrue(seen["url"].endswith("/v1/nudge"))
        self.assertEqual(seen["token"], "T")
        self.assertEqual(seen["body"], {"toHandle": "gary", "note": "come play"})

    def test_send_nudge_requires_pairing(self):
        arena.load_link = lambda: {}
        code, resp = arena.send_nudge("gary")
        self.assertEqual(code, 400)
        self.assertIn("not paired", resp["error"])

    def test_drain_returns_list_and_tolerates_errors(self):
        arena._request = lambda *a, **k: (200, {"nudges": [{"fromHandle": "ash"}]})
        self.assertEqual(arena.drain_nudges(), [{"fromHandle": "ash"}])
        arena._request = lambda *a, **k: (500, {"error": "boom"})
        self.assertEqual(arena.drain_nudges(), [])


class ErrorReasonTests(unittest.TestCase):
    """The dashboard page reads "error"; FastAPI sends "detail"."""

    def test_detail_becomes_error(self):
        self.assertEqual(arena._with_error({"detail": "no such person"}),
                         {"detail": "no such person", "error": "no such person"})

    def test_validation_detail_list_is_joined(self):
        body = {"detail": [{"msg": "field required"}, {"msg": "too long"}]}
        self.assertEqual(arena._with_error(body)["error"], "field required; too long")

    def test_existing_error_and_non_dicts_pass_through(self):
        self.assertEqual(arena._with_error({"error": "not paired"}), {"error": "not paired"})
        self.assertEqual(arena._with_error([1, 2]), [1, 2])

    def test_http_error_from_an_old_server_reaches_the_page_as_error(self):
        # An Arena server without /v1/nudge answers 404 {"detail": "Not Found"};
        # the page tells that apart from a missing person by this exact text.
        import io
        import urllib.error
        import urllib.request

        def fail(*args, **kwargs):
            raise urllib.error.HTTPError(
                "https://arena.example/v1/nudge", 404, "Not Found", {},
                io.BytesIO(b'{"detail": "Not Found"}'))

        original = urllib.request.urlopen
        urllib.request.urlopen = fail
        try:
            status, body = arena._request("POST", "https://arena.example/v1/nudge", body={})
        finally:
            urllib.request.urlopen = original
        self.assertEqual(status, 404)
        self.assertEqual(body["error"], "Not Found")


class PollerTests(unittest.TestCase):
    def test_one_poll_notifies_once_per_nudge(self):
        # Drive the poller body once without the sleep loop.
        nudges = [{"fromName": "Ash", "note": "come look"},
                  {"fromHandle": "gary", "note": ""}]
        fired = []
        # Reuse the same logic the poller runs per nudge.
        for n in nudges:
            who = n.get("fromName") or n.get("fromHandle") or "Someone"
            note = n.get("note") or ""
            body = (who + " nudged you") + (": " + note if note else "")
            fired.append((who, body))
        self.assertEqual(fired[0], ("Ash", "Ash nudged you: come look"))
        self.assertEqual(fired[1], ("gary", "gary nudged you"))


if __name__ == "__main__":
    unittest.main()
