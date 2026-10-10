"""HQ 2.5 tournaments: the local cups proxy (ext_cups.py) and its dashboard wiring.

The cups routes are read-only GETs: they forward only a validated cup id,
season or user id, never a body, so nothing from a transcript can leave.
"""
import json
import os
import sys
import threading
import unittest
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import arena  # noqa: E402
import ext_cups  # noqa: E402
from test_arena import FORBIDDEN_KEYS, _collect_keys  # noqa: E402

UID = "0f8fad5b-d9cb-469f-a165-70867728950e"


def _arg(d):
    return lambda k: (d.get(k) or "").strip()


class CupsWireTests(unittest.TestCase):
    def setUp(self):
        self._req = arena._request
        self._link = arena.load_link
        arena.load_link = lambda: {"token": "T", "url": "https://arena.example"}
        self.sent = []
        self.reply = (200, {"week": "2026-W41", "endsAt": "2026-10-11 23:59:59.999999", "cups": []})
        arena._request = self._fake

    def tearDown(self):
        arena._request = self._req
        arena.load_link = self._link
        for method, url, token, body in self.sent:
            self.assertEqual(method, "GET", url)
            self.assertIsNone(body, url)
            self.assertEqual(_collect_keys(body) & FORBIDDEN_KEYS, set(), url)

    def _fake(self, method, url, token=None, body=None):
        self.sent.append((method, url, token, body))
        return self.reply

    def test_list(self):
        code, resp = ext_cups.cups(_arg({}))
        self.assertEqual(code, 200)
        self.assertEqual(self.sent[0][1], "https://arena.example/v1/cups")
        self.assertEqual(self.sent[0][2], "T")

    def test_one_validates_the_id(self):
        code, _ = ext_cups.cup_one(_arg({"id": "cup-2026-W41-kart"}))
        self.assertEqual(code, 200)
        self.assertEqual(self.sent[-1][1], "https://arena.example/v1/cups/cup-2026-W41-kart")
        for bad in ("", "cup-2026-W41-td", "cup-2026-W54-kart", "cup-2026-W00-golf",
                    "cup-2026-W41-kart/../x", "cup-2026-W41-kart?x=1", "../v1/admin",
                    "cup-26-W41-kart", "CUP-2026-W41-kart", "cup-2026-W41-kart\n"):
            n = len(self.sent)
            code, resp = ext_cups.cup_one(lambda k, b=bad: b)
            self.assertEqual(code, 400, bad)
            self.assertEqual(len(self.sent), n, bad)
        for g in ext_cups.CUP_GAMES:
            self.assertEqual(ext_cups.cup_one(_arg({"id": "cup-2026-W53-" + g}))[0], 200)

    def test_season(self):
        ext_cups.season(_arg({}))
        self.assertEqual(self.sent[-1][1], "https://arena.example/v1/cups/season")
        ext_cups.season(_arg({"season": "2026-09"}))
        self.assertEqual(self.sent[-1][1], "https://arena.example/v1/cups/season?season=2026-09")
        n = len(self.sent)
        for bad in ("2026-13", "2026-9", "26-09", "2026-09&x=1", "2026-00"):
            self.assertEqual(ext_cups.season(_arg({"season": bad}))[0], 400, bad)
        self.assertEqual(len(self.sent), n)

    def test_trophies(self):
        ext_cups.trophies(_arg({}))
        self.assertEqual(self.sent[-1][1], "https://arena.example/v1/cups/trophies/me")
        ext_cups.trophies(_arg({"u": UID}))
        self.assertEqual(self.sent[-1][1], "https://arena.example/v1/cups/trophies/" + UID)
        n = len(self.sent)
        for bad in ("alice", "../me", UID.upper(), UID + "x", "me/../x"):
            self.assertEqual(ext_cups.trophies(_arg({"u": bad}))[0], 400, bad)
        self.assertEqual(len(self.sent), n)

    def test_not_paired(self):
        arena.load_link = lambda: {"url": "https://arena.example"}
        for fn in (ext_cups.cups, ext_cups.season, ext_cups.trophies):
            self.assertEqual(fn(_arg({}))[0], 400)
        self.assertEqual(ext_cups.cup_one(_arg({"id": "cup-2026-W41-golf"}))[0], 400)
        self.assertEqual(self.sent, [])

    def test_maps_are_get_only(self):
        self.assertEqual(ext_cups.POST, {})
        self.assertEqual(set(ext_cups.GET), {
            "/api/arena/cups", "/api/arena/cups/one",
            "/api/arena/cups/season", "/api/arena/cups/trophies"})


class CupsDashboardRouteTests(unittest.TestCase):
    """The routes answer through dashboard.py's EXT wiring on a real server."""

    @classmethod
    def setUpClass(cls):
        import dashboard
        cls.dashboard = dashboard
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), dashboard.Handler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self._req = arena._request
        self._link = arena.load_link
        arena.load_link = lambda: {"token": "T", "url": "https://arena.example"}
        self.sent = []
        arena._request = lambda m, u, token=None, body=None: (
            self.sent.append((m, u, body)) or (200, {"ok": True, "url": u}))

    def tearDown(self):
        arena._request = self._req
        arena.load_link = self._link

    def _get(self, path):
        req = urllib.request.Request("http://127.0.0.1:%d%s" % (self.port, path))
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read().decode() or "{}")
            finally:
                e.close()

    def test_ext_is_wired(self):
        self.assertTrue(any(m.__name__ == "ext_cups" for m in self.dashboard.EXT))

    def test_routes(self):
        code, resp = self._get("/api/arena/cups")
        self.assertEqual(code, 200)
        self.assertTrue(resp["url"].endswith("/v1/cups"))
        code, resp = self._get("/api/arena/cups/one?id=cup-2026-W41-bowl")
        self.assertEqual(code, 200)
        self.assertTrue(resp["url"].endswith("/v1/cups/cup-2026-W41-bowl"))
        code, resp = self._get("/api/arena/cups/season?season=2026-10")
        self.assertTrue(resp["url"].endswith("/v1/cups/season?season=2026-10"))
        code, resp = self._get("/api/arena/cups/trophies?u=" + UID)
        self.assertTrue(resp["url"].endswith("/v1/cups/trophies/" + UID))
        code, resp = self._get("/api/arena/cups/one?id=cup-2026-W41-td")
        self.assertEqual(code, 400)
        self.assertIn("error", resp)
        self.assertEqual(len(self.sent), 4)
        for m, u, body in self.sent:
            self.assertEqual(m, "GET")
            self.assertIsNone(body)


if __name__ == "__main__":
    unittest.main()
