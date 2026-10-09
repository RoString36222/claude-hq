"""Map gallery proxy (ext_maps.py): the wire format, the privacy boundary
(only {id,kind,name,data,scope,roomId} ever leaves on a save, and no forbidden
key anywhere), local validation, and the dashboard wiring (GET routes, POST
routes behind the CSRF check)."""
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
import ext_maps  # noqa: E402
from test_arena import FORBIDDEN_KEYS, _collect_keys  # noqa: E402

ROOT = os.path.dirname(HERE)
KART = {"tiles": "FSSSSSRSSSRSSSSSSSSRSSSRSS", "scenery": "forest",
        "theme": {"sky": "#9fd3f0", "fog": "#cfe8f2", "ground": "#76b85a"}}
UID = "0f1e2d3c-4b5a-4968-8776-655443322110"
MID = "m-0123456789ab"


def args(d):
    return lambda k: (d.get(k) or "").strip()


class Wire(unittest.TestCase):
    def setUp(self):
        self._req, self._link = arena._request, arena.load_link
        arena.load_link = lambda: {"token": "T", "url": "https://arena.example/"}
        self.sent = []
        self.reply = (200, {"ok": True})
        arena._request = self._fake

    def tearDown(self):
        arena._request, arena.load_link = self._req, self._link
        for method, url, token, body in self.sent:
            self.assertEqual(token, "T")
            self.assertEqual(_collect_keys(body) & FORBIDDEN_KEYS, set(), url)

    def _fake(self, method, url, token=None, body=None):
        self.sent.append((method, url, token, body))
        return self.reply

    def last(self):
        return self.sent[-1]

    # ---- saves ----

    def test_save_forwards_exactly_the_six_keys(self):
        code, _ = ext_maps.save({"kind": "kart", "name": "  Loop  ", "data": KART, "scope": "public"})
        self.assertEqual(code, 200)
        m, url, _, body = self.last()
        self.assertEqual((m, url), ("POST", "https://arena.example/v1/maps"))
        self.assertEqual(body, {"kind": "kart", "name": "Loop", "data": KART, "scope": "public"})
        ext_maps.save({"id": MID, "kind": "kart", "name": "Home", "data": KART, "scope": "room",
                       "roomId": "hq_" + UID})
        body = self.last()[3]
        self.assertEqual(set(body), {"id", "kind", "name", "data", "scope", "roomId"})
        self.assertTrue(set(body) <= set(ext_maps.SAVE_KEYS))
        ext_maps.save({"kind": "plat", "name": "Crew", "data": {"kill": -5}, "scope": "room",
                       "roomId": "r_" + "A" * 22})
        self.assertEqual(self.last()[3]["roomId"], "r_" + "A" * 22)

    def test_save_refuses_bad_bodies_locally(self):
        bad = [
            {"kind": "kart", "name": "X", "data": KART, "scope": "public", "title": "x"},
            {"kind": "golf", "name": "X", "data": KART, "scope": "public"},
            {"kind": "kart", "name": "", "data": KART, "scope": "public"},
            {"kind": "kart", "name": "x" * 33, "data": KART, "scope": "public"},
            {"kind": "kart", "name": "<b>", "data": KART, "scope": "public"},
            {"kind": "kart", "name": "go to http://x", "data": KART, "scope": "public"},
            {"kind": "kart", "name": "www.x.io", "data": KART, "scope": "public"},
            {"kind": "kart", "name": "a\x07b", "data": KART, "scope": "public"},
            {"kind": "kart", "name": 5, "data": KART, "scope": "public"},
            {"kind": "kart", "name": "X", "data": [1], "scope": "public"},
            {"kind": "kart", "name": "X", "data": dict(KART, pad="x" * (13 * 1024)), "scope": "public"},
            {"kind": "kart", "name": "X", "data": dict(KART, deco=[{"text": "hi"}]), "scope": "public"},
            {"kind": "kart", "name": "X", "data": dict(KART, path="FSS"), "scope": "public"},
            {"kind": "kart", "name": "X", "data": KART, "scope": "friends"},
            {"kind": "kart", "name": "X", "data": KART, "scope": "room"},
            {"kind": "kart", "name": "X", "data": KART, "scope": "room", "roomId": "lobby"},
            {"kind": "kart", "name": "X", "data": KART, "scope": "room", "roomId": "qp_abc"},
            {"kind": "kart", "name": "X", "data": KART, "scope": "public", "roomId": "hq_" + UID},
            {"id": "m-XYZ", "kind": "kart", "name": "X", "data": KART, "scope": "public"},
            {"id": 7, "kind": "kart", "name": "X", "data": KART, "scope": "public"},
            None, [], "x",
        ]
        for b in bad:
            code, resp = ext_maps.save(b)
            self.assertEqual(code, 400, b if not isinstance(b, dict) else b.get("name"))
            self.assertIn("error", resp)
        self.assertEqual(self.sent, [])

    def test_twelve_kib_is_the_line(self):
        base = len(json.dumps(dict(KART, pad=""), separators=(",", ":")))
        fits = dict(KART, pad="x" * (12 * 1024 - base))
        self.assertEqual(ext_maps.save({"kind": "kart", "name": "Big", "data": fits, "scope": "private"})[0], 200)
        over = dict(KART, pad="x" * (12 * 1024 - base + 1))
        self.assertEqual(ext_maps.save({"kind": "kart", "name": "Big", "data": over, "scope": "private"})[0], 400)

    # ---- small writes ----

    def test_like_report_delete_hide(self):
        ext_maps.like({"id": MID, "on": True})
        self.assertEqual(self.last()[:2], ("POST", "https://arena.example/v1/maps/%s/like" % MID))
        self.assertEqual(self.last()[3], {"on": True})
        ext_maps.report({"id": MID, "reason": "broken"})
        self.assertEqual(self.last()[1], "https://arena.example/v1/maps/%s/report" % MID)
        self.assertEqual(self.last()[3], {"reason": "broken"})
        ext_maps.delete({"id": MID})
        self.assertEqual(self.last()[1:4:2], ("https://arena.example/v1/maps/%s/delete" % MID, {}))
        ext_maps.hide({"id": MID, "hidden": False})
        self.assertEqual(self.last()[3], {"hidden": False})
        n = len(self.sent)
        for fn, b in [(ext_maps.like, {"id": MID, "on": 1}), (ext_maps.like, {"id": "../x", "on": True}),
                      (ext_maps.report, {"id": MID, "reason": "meh"}), (ext_maps.report, {"reason": "spam"}),
                      (ext_maps.delete, {"id": MID + "0"}), (ext_maps.hide, {"id": MID}),
                      (ext_maps.like, None)]:
            self.assertEqual(fn(b)[0], 400, b)
        self.assertEqual(len(self.sent), n)

    # ---- reads ----

    def test_list_builds_a_clean_query(self):
        ext_maps.list_maps(args({}))
        self.assertEqual(self.last()[:2], ("GET", "https://arena.example/v1/maps"))
        ext_maps.list_maps(args({"kind": "kart", "sort": "week", "limit": "12", "cursor": "ab12"}))
        self.assertEqual(self.last()[1], "https://arena.example/v1/maps?kind=kart&sort=week&cursor=ab12&limit=12")
        ext_maps.list_maps(args({"room": "hq_" + UID}))
        self.assertTrue(self.last()[1].endswith("?room=hq_" + UID))
        ext_maps.list_maps(args({"mine": "1", "ckey": "c-0123456789ab"}))
        self.assertTrue(self.last()[1].endswith("?mine=1&ckey=c-0123456789ab"))
        n = len(self.sent)
        for d in [{"kind": "golf"}, {"sort": "old"}, {"room": "qp_x"}, {"limit": "31"}, {"limit": "x"},
                  {"cursor": "zz"}, {"ckey": "meadow"}, {"mine": "1", "room": "hq_" + UID}]:
            self.assertEqual(ext_maps.list_maps(args(d))[0], 400, d)
        self.assertEqual(len(self.sent), n)

    def test_one_and_featured(self):
        ext_maps.one_map(args({"id": MID}))
        self.assertEqual(self.last()[:2], ("GET", "https://arena.example/v1/maps/" + MID))
        self.assertEqual(ext_maps.one_map(args({"id": "m-1/../x"}))[0], 400)
        ext_maps.featured(args({}))
        self.assertEqual(self.last()[1], "https://arena.example/v1/maps/featured")

    def test_not_paired(self):
        arena.load_link = lambda: {}
        saved = arena._base_url
        arena._base_url = lambda: ""
        try:
            self.assertEqual(ext_maps.featured(args({}))[0], 400)
            self.assertEqual(ext_maps.save({"kind": "kart", "name": "X", "data": KART, "scope": "public"})[0], 400)
        finally:
            arena._base_url = saved
        self.assertEqual(self.sent, [])


class Wiring(unittest.TestCase):
    """The dashboard serves these routes, POSTs only behind X-HQ-Token."""

    @classmethod
    def setUpClass(cls):
        import dashboard
        cls.d = dashboard
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
        self._req, self._link = arena._request, arena.load_link
        arena.load_link = lambda: {"token": "T", "url": "https://arena.example"}
        self.sent = []
        arena._request = lambda m, u, token=None, body=None: (self.sent.append((m, u, body)) or (200, {"maps": []}))

    def tearDown(self):
        arena._request, arena.load_link = self._req, self._link

    def call(self, method, path, body=None, token=True):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request("http://127.0.0.1:%d%s" % (self.port, path), data=data, method=method)
        req.add_header("Content-Type", "application/json")
        if token:
            req.add_header("X-HQ-Token", self.d.CSRF_TOKEN)
        try:
            with self.opener.open(req, timeout=5) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read() or b"{}")
            except ValueError:
                return e.code, {}
            finally:
                e.close()

    def test_every_post_route_is_csrf_guarded(self):
        self.assertIn(ext_maps, self.d.EXT)
        for p in ext_maps.POST:
            self.assertIn(p, self.d.POST_PATHS)
            code, _ = self.call("POST", p, {"id": MID, "on": True}, token=False)
            self.assertEqual(code, 403, p)
        self.assertEqual(self.sent, [])

    def test_routes_reach_the_arena(self):
        code, resp = self.call("GET", "/api/arena/maps?kind=kart&sort=top")
        self.assertEqual((code, resp), (200, {"maps": []}))
        self.assertEqual(self.sent[-1][1], "https://arena.example/v1/maps?kind=kart&sort=top")
        self.assertEqual(self.call("GET", "/api/arena/maps/one?id=nope")[0], 400)
        self.assertEqual(self.call("GET", "/api/arena/maps/featured")[0], 200)
        code, _ = self.call("POST", "/api/arena/maps/save",
                            {"kind": "kart", "name": "Loop", "data": KART, "scope": "public"})
        self.assertEqual(code, 200)
        self.assertEqual(self.sent[-1][2], {"kind": "kart", "name": "Loop", "data": KART, "scope": "public"})
        self.assertEqual(self.call("POST", "/api/arena/maps/like", {"id": MID, "on": True})[0], 200)
        self.assertEqual(self.sent[-1][1], "https://arena.example/v1/maps/%s/like" % MID)


class PageRules(unittest.TestCase):
    """31-workshop.js keeps the house rules the page relies on."""

    def setUp(self):
        with open(os.path.join(ROOT, "ui", "app", "31-workshop.js"), encoding="utf-8") as f:
            self.src = f.read()

    def test_contract_hooks_exist(self):
        for name in ("function workshopEnter", "function workshopLeave", "window.workshopPublish",
                     "window.workshopOpenMaker", "make-publish", "/api/arena/leaderboards?game="):
            self.assertIn(name, self.src)

    def test_no_math_random_and_no_eval(self):
        self.assertNotIn("Math.random", self.src)
        self.assertNotIn("eval(", self.src)

    def test_the_save_body_names_only_the_six_keys(self):
        i = self.src.index("var body = {kind:")
        line = self.src[i:self.src.index("\n", i)]
        self.assertRegex(line, r"\{kind:doc\.kind, name:[^,]+, data:doc\.data, scope:scope\}")


if __name__ == "__main__":
    unittest.main()
