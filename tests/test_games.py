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

    def test_serves_golf_assets_and_vendored_three(self):
        for name, ctype in (("vendor/three-module.js", "application/javascript"),
                            ("vendor/three-core.js", "application/javascript"),
                            ("vendor/three-gltf-loader.js", "application/javascript"),
                            ("golf/courses.json", "application/json"),
                            ("golf/straight.glb", "model/gltf-binary"),
                            ("golf/colormap.png", "image/png"),
                            ("kart/tracks.json", "application/json"),
                            ("kart/track-corner.glb", "model/gltf-binary"),
                            ("kart/vehicle-motorcycle.glb", "model/gltf-binary"),
                            ("kart/smoke.png", "image/png"),
                            ("platformer/levels.json", "application/json"),
                            ("platformer/character.glb", "model/gltf-binary"),
                            ("platformer/platform-grass-large-round.glb", "model/gltf-binary"),
                            ("platformer/colormap.png", "image/png"),
                            ("platformer/blob-shadow.png", "image/png"),
                            ("fps/map.json", "application/json"),
                            ("fps/blaster-repeater.glb", "model/gltf-binary"),
                            ("fps/wall-high.glb", "model/gltf-binary"),
                            ("fps/colormap.png", "image/png"),
                            ("fps/burst.png", "image/png")):
            got = dashboard.game_file(name)
            self.assertIsNotNone(got, name)
            self.assertTrue(got[1].startswith(ctype), name)

    def test_rejects_other_subpaths(self):
        for bad in ("vendor/../dashboard.py", "vendor/x.css", "golf/Textures/colormap.png", "golf/a/b.glb",
                    "golf/X.glb", "vendor/three.core.js", "golf/x.js", "golf/x.glb\n", "vendor/", "golf/.x.glb",
                    "golf/LICENSE-kenney.txt", "vendor/LICENSE-three.txt", "other/three-module.js",
                    "golf/missing.glb", "golf//straight.glb", "golf/straight.glb/", "/golf/straight.glb",
                    "kart/LICENSE-kenney.txt", "kart/x.js", "kart/../dashboard.py", "karts/track-corner.glb",
                    "platformer/LICENSE-kenney.txt", "platformer/x.js", "platformer/../dashboard.py",
                    "platformer/Textures/colormap.png", "platformers/coin.glb", "platformer/Coin.glb",
                    "platformer/missing.glb", "platformer/coin.glb/",
                    "fps/LICENSE-kenney.txt", "fps/x.js", "fps/../dashboard.py", "fps/Textures/colormap.png",
                    "fpss/blaster.glb", "fps/Blaster.glb", "fps/missing.glb", "fps/blaster.glb/", "fps/a/b.glb"):
            self.assertIsNone(dashboard.game_file(bad), repr(bad))

    def test_golf_assets_revalidate_and_game_scripts_never_cache(self):
        for name in ("vendor/three-core.js", "golf/straight.glb", "golf/courses.json"):
            self.assertEqual(dashboard.game_cache_control(name), "no-cache", name)
        for name in ("golf.js", "multi.js", "games.css", "vendor/../golf.js", None):
            self.assertEqual(dashboard.game_cache_control(name), "no-store", repr(name))
        a = dashboard.game_etag(b"abc")
        self.assertEqual(a, dashboard.game_etag(b"abc"))
        self.assertNotEqual(a, dashboard.game_etag(b"abd"))
        self.assertRegex(a, r'^"[0-9a-f]{20}"$')

    def test_rejects_symlink_escaping_the_folder(self):
        link = os.path.join(GAMES, "golf", "zz-escape.json")
        try:
            os.symlink(os.path.join(ROOT, "README.md"), link)
        except OSError:
            self.skipTest("cannot create symlinks here")
        try:
            self.assertIsNone(dashboard.game_file("golf/zz-escape.json"))
        finally:
            os.unlink(link)

    def test_index_loads_every_game_file_that_exists(self):
        html = dashboard.assemble_index()
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

    def test_vendored_modules_import_only_relative_siblings(self):
        vendor = os.path.join(GAMES, "vendor")
        for n in sorted(os.listdir(vendor)):
            if not n.endswith(".js"):
                continue
            with open(os.path.join(vendor, n), encoding="utf-8") as f:
                src = f.read()
            for spec in re.findall(r"^(?:import|export)[^;]*?from\s+'([^']+)'", src, re.M):
                self.assertRegex(spec, r"^\./three-[a-z-]+\.js$", n)
                self.assertTrue(os.path.isfile(os.path.join(vendor, spec[2:])), spec)
            self.assertNotRegex(src, r"import\(\s*['\"]https?:", n)

    def test_third_party_files_carry_their_licenses(self):
        with open(os.path.join(GAMES, "vendor", "LICENSE-three.txt"), encoding="utf-8") as f:
            self.assertIn("The MIT License", f.read())
        with open(os.path.join(GAMES, "golf", "LICENSE-kenney.txt"), encoding="utf-8") as f:
            self.assertGreaterEqual(f.read().count("Creative Commons Zero, CC0"), 2)
        with open(os.path.join(GAMES, "kart", "LICENSE-kenney.txt"), encoding="utf-8") as f:
            self.assertGreaterEqual(f.read().count("Creative Commons Zero, CC0"), 2)
        with open(os.path.join(GAMES, "platformer", "LICENSE-kenney.txt"), encoding="utf-8") as f:
            self.assertGreaterEqual(f.read().count("Creative Commons Zero, CC0"), 2)
        with open(os.path.join(GAMES, "fps", "LICENSE-kenney.txt"), encoding="utf-8") as f:
            self.assertGreaterEqual(f.read().count("Creative Commons Zero, CC0"), 2)
        for n in os.listdir(os.path.join(GAMES, "fps")):
            self.assertRegex(n, r"^([a-z][a-z0-9-]*\.glb|colormap\.png|burst\.png|hit\.png|map\.json|LICENSE-kenney\.txt)$", n)
        # every vendored platformer file is one of the kit's (named in its license)
        for n in os.listdir(os.path.join(GAMES, "platformer")):
            self.assertRegex(n, r"^([a-z][a-z0-9-]*\.glb|colormap\.png|blob-shadow\.png|levels\.json|LICENSE-kenney\.txt)$", n)

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


class IndexAssembly(unittest.TestCase):
    """index.html is a template stitched from ui/ (Wave 0 split)."""

    def test_every_include_exists_and_nothing_is_left_unstitched(self):
        html = dashboard.assemble_index()
        self.assertNotIn("@include ui/", html)
        self.assertGreater(len(html), 500000)
        self.assertIn('"use strict";\nvar $ = function(id)', html)

    def test_include_cannot_escape_ui(self):
        for bad in ("ui/../dashboard.py", "ui/app/../../README.md", "ui/nope.js"):
            with self.assertRaises(FileNotFoundError):
                dashboard._include_path(bad)

    def test_edit_in_ui_shows_up_without_restart(self):
        path = os.path.join(ROOT, "ui", "app", "zz-probe.js")
        tpl = os.path.join(ROOT, "index.html")
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write("var ZZ_PROBE = 1;\n")
            saved = dashboard.INDEX_HTML
            with open(tpl, encoding="utf-8") as f:
                body = f.read()
            alt = os.path.join(ROOT, "ui", "zz-index.html")
            with open(alt, "w", encoding="utf-8") as f:
                f.write(body.replace("</body>", "<script>\n//@include ui/app/zz-probe.js\n</script>\n</body>"))
            dashboard.INDEX_HTML = alt
            self.assertIn("var ZZ_PROBE = 1;", dashboard.assemble_index())
            with open(path, "w", encoding="utf-8") as f:
                f.write("var ZZ_PROBE = 2;\n")
            os.utime(path, ns=(1, 10 ** 18))       # a different mtime even on coarse clocks
            self.assertIn("var ZZ_PROBE = 2;", dashboard.assemble_index())
        finally:
            dashboard.INDEX_HTML = saved
            for p in (path, os.path.join(ROOT, "ui", "zz-index.html")):
                if os.path.exists(p):
                    os.remove(p)
