"""World boss proxy tests (ext_boss.py).

Verifies the wire format (URL, method, body), the privacy boundary (no
forbidden keys, team specs rebuilt from an allowlist) and the validation layer.
"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import arena  # noqa: E402
import ext_boss  # noqa: E402
from test_arena import FORBIDDEN_KEYS, _collect_keys  # noqa: E402

UID = "0f8fad5b-d9cb-469f-a165-70867728950e"
SPEC = {"sp": 1, "st": 4, "br": None, "mg": None, "sh": False}


class BossWireTests(unittest.TestCase):
    def setUp(self):
        self._req = arena._request
        self._link = arena.load_link
        arena.load_link = lambda: {"token": "T", "url": "https://arena.example"}
        self.sent = []
        self.reply = (200, {"ok": True})
        arena._request = self._fake

    def tearDown(self):
        arena._request = self._req
        arena.load_link = self._link
        for method, url, token, body in self.sent:
            self.assertEqual(_collect_keys(body) & FORBIDDEN_KEYS, set(), url)

    def _fake(self, method, url, token=None, body=None):
        self.sent.append((method, url, token, body))
        return self.reply

    def test_maps_name_the_routes(self):
        self.assertEqual(set(ext_boss.GET), {"/api/arena/boss", "/api/arena/boss/badges"})
        self.assertEqual(set(ext_boss.POST), {"/api/arena/boss/fight"})

    def test_state_get(self):
        code, _ = ext_boss.GET["/api/arena/boss"](lambda k: "")
        self.assertEqual(code, 200)
        self.assertEqual(self.sent, [("GET", "https://arena.example/v1/boss", "T", None)])

    def test_badges_me_and_uuid(self):
        ext_boss.GET["/api/arena/boss/badges"](lambda k: "")
        ext_boss.GET["/api/arena/boss/badges"](lambda k: "me")
        ext_boss.GET["/api/arena/boss/badges"](lambda k: UID)
        self.assertEqual([s[1] for s in self.sent], [
            "https://arena.example/v1/boss/badges/me",
            "https://arena.example/v1/boss/badges/me",
            "https://arena.example/v1/boss/badges/" + UID,
        ])

    def test_badges_refuse_a_bad_user(self):
        for bad in ("../x", "abc", UID + "/x", "ME"):
            code, resp = ext_boss.GET["/api/arena/boss/badges"](lambda k, b=bad: b)
            self.assertEqual(code, 400, bad)
        self.assertEqual(self.sent, [])

    def test_fight_wire(self):
        rid = "boss-0123456789abcdef"
        code, _ = ext_boss.POST["/api/arena/boss/fight"](
            {"requestId": rid, "team": [SPEC, dict(SPEC, sp=3, br=None, mg="charizard-mega-x", sh=1)]})
        self.assertEqual(code, 200)
        m, url, tok, body = self.sent[0]
        self.assertEqual((m, url, tok), ("POST", "https://arena.example/v1/boss/fight", "T"))
        self.assertEqual(body, {"requestId": rid, "team": [
            SPEC, {"sp": 3, "st": 4, "br": None, "mg": "charizard-mega-x", "sh": True}]})

    def test_fight_mints_a_request_id_when_absent(self):
        ext_boss.POST["/api/arena/boss/fight"]({"team": [SPEC]})
        rid = self.sent[0][3]["requestId"]
        self.assertRegex(rid, r"^boss-[0-9a-f]{32}$")

    def test_fight_drops_unknown_top_level_keys(self):
        ext_boss.POST["/api/arena/boss/fight"]({"team": [SPEC], "title": "x", "sessionId": "s"})
        self.assertEqual(set(self.sent[0][3]), {"requestId", "team"})

    def test_fight_refuses_bad_teams(self):
        bad_teams = [
            None, "x", [], [SPEC] * 7, [1], [dict(SPEC, name="Sparky")],
            [{"sp": 1, "st": 4}], [dict(SPEC, sp=True)], [dict(SPEC, sp=1.0)],
            [dict(SPEC, st=5)], [dict(SPEC, sp=-1)], [dict(SPEC, br="x")],
            [dict(SPEC, mg="<b>")], [dict(SPEC, sh=2)], [dict(SPEC, path="/x")],
        ]
        for team in bad_teams:
            code, resp = ext_boss.POST["/api/arena/boss/fight"]({"team": team})
            self.assertEqual(code, 400, team)
            self.assertIn("error", resp)
        for rid in ("short", "x" * 65, "has space in it ok", 12345678901234567):
            code, _ = ext_boss.POST["/api/arena/boss/fight"]({"team": [SPEC], "requestId": rid})
            self.assertEqual(code, 400, rid)
        self.assertEqual(self.sent, [])

    def test_unpaired(self):
        arena.load_link = lambda: {}
        orig = arena._base_url
        arena._base_url = lambda: ""
        try:
            self.assertEqual(ext_boss.boss_state()[0], 400)
            self.assertEqual(ext_boss.boss_badges("me")[0], 400)
            self.assertEqual(ext_boss.boss_fight({"team": [SPEC]})[0], 400)
        finally:
            arena._base_url = orig
        self.assertEqual(self.sent, [])

    def test_post_paths_include_the_fight(self):
        try:
            import dashboard
        except Exception as e:  # pragma: no cover
            self.skipTest("dashboard import failed: %s" % e)
        if not hasattr(dashboard, "EXT"):
            self.skipTest("EXT wiring arrives with the scaffold")
        self.assertIn("/api/arena/boss/fight", dashboard.POST_PATHS)


if __name__ == "__main__":
    unittest.main()
