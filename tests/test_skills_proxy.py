"""HQ 2.5 skill tree: the local proxy (ext_skills.py), the opt-in reporter,
the config switch, and the catalogue mirror between skills.rs and 35-skills.js.
arena._request / load_link are monkeypatched; nothing reaches a network.
"""
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)

import arena  # noqa: E402
import dashboard  # noqa: E402
import ext_skills  # noqa: E402
import worksignals  # noqa: E402
from test_arena import FORBIDDEN_KEYS, _collect_keys  # noqa: E402

UID = "0f8fad5b-d9cb-469f-a165-70867728950e"
FULL_DAY = dict.fromkeys(worksignals.KEYS, 3)


class _Proxy(unittest.TestCase):
    def setUp(self):
        self._req, self._link, self._dc = arena._request, arena.load_link, worksignals.day_counts
        arena.load_link = lambda: {"token": "T", "url": "https://arena.example"}
        self.sent = []
        self.reply = (200, {"ok": True})
        arena._request = self._fake
        self.days = {"2026-10-09": dict(FULL_DAY), "2026-10-10": dict(FULL_DAY, tests=7)}
        worksignals.day_counts = lambda days=7, now=None, paths=None: {d: dict(v) for d, v in self.days.items()}
        ext_skills._state["sent"] = {}
        ext_skills._state["lastReport"] = None

    def tearDown(self):
        arena._request, arena.load_link, worksignals.day_counts = self._req, self._link, self._dc
        ext_skills._state["sent"] = {}
        ext_skills._state["lastReport"] = None
        for method, url, token, body in self.sent:
            self.assertEqual(_collect_keys(body) & FORBIDDEN_KEYS, set(), url)

    def _fake(self, method, url, token=None, body=None):
        self.sent.append((method, url, token, body))
        return self.reply


class ReporterTests(_Proxy):
    def test_the_report_body_is_exactly_day_and_seven_counts(self):
        n = ext_skills.report_once(lambda: {"workSignals": True})
        self.assertEqual(n, 2)
        self.assertEqual(len(self.sent), 2)
        for m, url, tok, body in self.sent:
            self.assertEqual(m, "POST")
            self.assertEqual(url, "https://arena.example/v1/skills/report")
            self.assertEqual(tok, "T")
            self.assertEqual(set(body), {"day", "counts"})
            self.assertEqual(set(body["counts"]), set(worksignals.SKILL_CATS))
            self.assertNotIn("tests_green", body["counts"])
            self.assertNotIn("focus_long", body["counts"])
            self.assertTrue(all(isinstance(v, int) and 0 <= v <= 200 for v in body["counts"].values()))
            self.assertRegex(body["day"], r"^\d{4}-\d{2}-\d{2}$")
        self.assertEqual([b["day"] for _, _, _, b in self.sent], ["2026-10-09", "2026-10-10"])
        self.assertEqual(self.sent[1][3]["counts"]["tests"], 7)
        last = ext_skills._state["lastReport"]
        self.assertTrue(last["ok"])
        self.assertEqual(last["days"], 2)

    def test_with_work_signals_off_it_never_calls_request(self):
        for cfg in ({}, {"workSignals": False}, {"workSignals": "yes"}, None):
            self.assertEqual(ext_skills.report_once(lambda c=cfg: c), 0)
        self.assertEqual(ext_skills.report_once(lambda: (_ for _ in ()).throw(OSError())), 0)
        self.assertEqual(self.sent, [])

    def test_unpaired_never_calls_request(self):
        arena.load_link = lambda: {}
        arena._load_config = lambda: {}
        self.assertEqual(ext_skills.report_once(lambda: {"workSignals": True}), 0)
        self.assertEqual(self.sent, [])

    def test_an_unchanged_day_is_not_resent_and_a_failure_is_retried(self):
        ext_skills.report_once(lambda: {"workSignals": True})
        self.sent.clear()
        self.assertEqual(ext_skills.report_once(lambda: {"workSignals": True}), 0)
        self.days["2026-10-10"]["docs"] = 9
        self.reply = (503, {"error": "down"})
        self.assertEqual(ext_skills.report_once(lambda: {"workSignals": True}), 1)
        self.assertFalse(ext_skills._state["lastReport"]["ok"])
        self.reply = (200, {"ok": True})
        self.assertEqual(ext_skills.report_once(lambda: {"workSignals": True}), 1)

    def test_an_all_zero_day_is_skipped(self):
        self.days = {"2026-10-08": dict.fromkeys(worksignals.KEYS, 0)}
        self.assertEqual(ext_skills.report_once(lambda: {"workSignals": True}), 0)


class RouteTests(_Proxy):
    def arg(self, q):
        return lambda k: q.get(k, "")

    def test_get_me_and_a_user(self):
        ext_skills.get_skills(self.arg({}))
        ext_skills.get_skills(self.arg({"u": "me"}))
        ext_skills.get_skills(self.arg({"u": UID}))
        self.assertEqual([s[1] for s in self.sent], ["https://arena.example/v1/skills/me"] * 2
                         + ["https://arena.example/v1/skills/" + UID])
        self.assertTrue(all(s[0] == "GET" and s[3] is None for s in self.sent))

    def test_a_bad_user_id_is_refused_locally(self):
        for bad in ("../me", "x", UID + "/x", "me?x=1"):
            code, _ = ext_skills.get_skills(self.arg({"u": bad}))
            self.assertEqual(code, 400)
        self.assertEqual(self.sent, [])

    def test_title_posts_only_the_title(self):
        code, _ = ext_skills.post_title({"title": "tests-3"})
        self.assertEqual(code, 200)
        ext_skills.post_title({"title": None})
        self.assertEqual([s[3] for s in self.sent], [{"title": "tests-3"}, {"title": None}])
        self.assertTrue(all(s[1].endswith("/v1/skills/title") and s[0] == "POST" for s in self.sent))
        self.sent.clear()
        for bad in ({}, {"title": "tests-4"}, {"title": "magic-3"}, {"title": 3}, {"title": "tests-3 "}, None):
            code, _ = ext_skills.post_title(bad)
            self.assertEqual(code, 400)
        self.assertEqual(self.sent, [])

    def test_local_view(self):
        code, resp = ext_skills.get_local(self.arg({}))
        self.assertEqual(code, 200)
        self.assertEqual(set(resp), {"enabled", "days", "lastReport"})
        for d in resp["days"].values():
            self.assertEqual(set(d), set(worksignals.SKILL_CATS))
        self.assertEqual(self.sent, [])

    def test_the_routes_are_wired_into_the_dashboard(self):
        self.assertIn(ext_skills, dashboard.EXT)
        self.assertIn("/api/arena/skills/title", dashboard.POST_PATHS)
        self.assertIn("/api/arena/skills", ext_skills.GET)
        self.assertIn("/api/skills/local", ext_skills.GET)


class ConfigTests(unittest.TestCase):
    def test_work_signals_default_off_and_bool_only(self):
        self.assertIs(dashboard.DEFAULT_CONFIG["workSignals"], False)
        self.assertIs(dashboard.DEFAULT_CONFIG["workSignalsPRs"], False)
        base = dict(dashboard.DEFAULT_CONFIG)
        on = dashboard._validate_config({"workSignals": True, "workSignalsPRs": True}, base=base)
        self.assertIs(on["workSignals"], True)
        self.assertIs(on["workSignalsPRs"], True)
        kept = dashboard._validate_config({"workSignals": "yes", "workSignalsPRs": 1}, base=on)
        self.assertIs(kept["workSignals"], True)
        self.assertIs(kept["workSignalsPRs"], True)


class CatalogueSyncTests(unittest.TestCase):
    def test_the_page_mirrors_skills_rs(self):
        with open(os.path.join(ROOT, "backend-rs", "src", "skills.rs"), encoding="utf-8") as f:
            rs = f.read()
        with open(os.path.join(ROOT, "ui", "app", "35-skills.js"), encoding="utf-8") as f:
            js = f.read()
        rs_perks = re.findall(r'\("([a-z]+)", \[((?:"[^"]+",? ?)+)\]\)', rs)
        self.assertEqual(len(rs_perks), 7)
        js_cats = re.findall(r'id:"([a-z]+)",\s*name:"[^"]+",\s*icon:"[^"]+",\s*how:"[^"]+",\s*perks:\[([^\]]+)\]', js)
        self.assertEqual([c for c, _ in js_cats], [c for c, _ in rs_perks])
        self.assertEqual([c for c, _ in rs_perks], list(worksignals.SKILL_CATS))
        for (c1, p1), (c2, p2) in zip(rs_perks, js_cats):
            self.assertEqual(re.findall(r'"([^"]+)"', p1), re.findall(r'"([^"]+)"', p2), c1)
        tiers = re.search(r"pub const TIERS: \[i64; 5\] = \[([^\]]+)\]", rs).group(1)
        self.assertIn("var SKILL_TIERS = [%s];" % tiers.replace(" ", ""), js)
        self.assertIn("pub const MAX_N: i64 = %d;" % worksignals.MAX_N, rs)


if __name__ == "__main__":
    unittest.main()
