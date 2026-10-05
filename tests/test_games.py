"""Valley minigames (games/): the allowlisted static route, the local save endpoint,
and the house rules for the game scripts (no external URLs, no innerHTML).
Stdlib only; the save file is redirected to a temp dir."""
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import dashboard  # noqa: E402

GAMES = os.path.join(ROOT, "games")


class GameFileTests(unittest.TestCase):
    def test_serves_allowlisted_files(self):
        body, ctype = dashboard.game_file("core.js")
        self.assertIn(b"HQV", body)
        self.assertTrue(ctype.startswith("application/javascript"))
        self.assertTrue(dashboard.game_file("games.css")[1].startswith("text/css"))

    def test_rejects_everything_else(self):
        for bad in ("../dashboard.py", "..%2fdashboard.py", ".hidden.js", "core.py", "Core.js",
                    "sub/core.js", "", None, "core.js\n", "a" * 60 + ".js", "missing.js"):
            self.assertIsNone(dashboard.game_file(bad), repr(bad))

    def test_index_loads_every_game_file_that_exists(self):
        with open(os.path.join(ROOT, "index.html"), encoding="utf-8") as f:
            html = f.read()
        files = re.search(r'VALLEY_FILES = \[([^\]]*)\]', html).group(1)
        names = re.findall(r'"([a-z]+)"', files)
        self.assertEqual(names[0], "core")
        for n in names:
            self.assertTrue(os.path.isfile(os.path.join(GAMES, n + ".js")), n)


class GameScriptRules(unittest.TestCase):
    def scripts(self):
        for n in sorted(os.listdir(GAMES)):
            if n.endswith(".js"):
                with open(os.path.join(GAMES, n), encoding="utf-8") as f:
                    yield n, f.read()

    def test_no_external_urls_or_innerhtml(self):
        for n, src in self.scripts():
            self.assertNotRegex(src, r"https?://", n)
            self.assertNotIn("innerHTML", src, n)
            self.assertNotIn("eval(", src, n)

    def test_css_uses_tokens_not_hex(self):
        with open(os.path.join(GAMES, "games.css"), encoding="utf-8") as f:
            css = f.read()
        self.assertIsNone(re.search(r"#[0-9a-fA-F]{3,8}\b", css))


class SaveEndpointTests(unittest.TestCase):
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
        self.tmp = tempfile.mkdtemp()
        self._saved = (dashboard.GAMES_SAVE_PATH, dashboard.HERE)
        dashboard.GAMES_SAVE_PATH = os.path.join(self.tmp, "games-save.json")
        dashboard.HERE = self.tmp

    def tearDown(self):
        dashboard.GAMES_SAVE_PATH, dashboard.HERE = self._saved
        shutil.rmtree(self.tmp, ignore_errors=True)

    def call(self, method, path, body=None, token=True):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request("http://127.0.0.1:%d%s" % (self.port, path), data=data, method=method)
        req.add_header("Content-Type", "application/json")
        if token:
            req.add_header("X-HQ-Token", dashboard.CSRF_TOKEN)
        try:
            with self.opener.open(req, timeout=5) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read() or b"{}")
            finally:
                e.close()

    def test_round_trip(self):
        self.assertEqual(self.call("GET", "/api/games/state"), (200, {"state": {}}))
        st = {"v": 1, "inv": {"koi": 2}}
        code, _ = self.call("POST", "/api/games/state", {"state": st})
        self.assertEqual(code, 200)
        self.assertEqual(self.call("GET", "/api/games/state"), (200, {"state": st}))
        self.assertEqual(os.stat(dashboard.GAMES_SAVE_PATH).st_mode & 0o777, 0o600)

    def test_rejects_bad_saves(self):
        self.assertEqual(self.call("POST", "/api/games/state", {"state": [1]})[0], 400)
        self.assertEqual(self.call("POST", "/api/games/state", {"nope": 1})[0], 400)
        big = {"state": {"x": "y" * (dashboard.GAMES_SAVE_MAX + 10)}}
        self.assertIn(self.call("POST", "/api/games/state", big)[0], (400, 413))
        self.assertFalse(os.path.exists(dashboard.GAMES_SAVE_PATH))

    def test_needs_csrf(self):
        self.assertEqual(self.call("POST", "/api/games/state", {"state": {}}, token=False)[0], 403)

    def test_static_route(self):
        req = urllib.request.Request("http://127.0.0.1:%d/games/core.js" % self.port)
        with self.opener.open(req, timeout=5) as r:
            self.assertEqual(r.status, 200)
        req = urllib.request.Request("http://127.0.0.1:%d/games/..%%2fdashboard.py" % self.port)
        with self.assertRaises(urllib.error.HTTPError) as cm:
            self.opener.open(req, timeout=5)
        self.assertEqual(cm.exception.code, 404)
        cm.exception.close()


if __name__ == "__main__":
    unittest.main()
