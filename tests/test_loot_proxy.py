"""Loot (HQ 2.5): the local reporter and proxy routes in ext_loot.py.

The privacy boundary under test: with workSignals off nothing is sent at all;
with it on, the only body that leaves is exactly {requestId, type, n, day}; `gh`
runs only when workSignalsPRs is ALSO on, and PR urls never reach the wire.
Stdlib only; gh and the Arena are mocked.
"""
import json
import os
import shutil
import stat
import sys
import tempfile
import types
import unittest
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import arena  # noqa: E402
import ext_loot  # noqa: E402
from test_arena import FORBIDDEN_KEYS, _collect_keys  # noqa: E402


def _urls(n):
    return [{"url": "https://github.com/acme/secret-repo/pull/%d" % (i + 1)} for i in range(n)]


class _Done:
    def __init__(self, rows, code=0):
        self.returncode = code
        self.stdout = json.dumps(rows)
        self.stderr = ""


class LootReporterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.saved = (arena._request, arena.load_link, ext_loot._run, ext_loot._which,
                      ext_loot._load_config, ext_loot._base_dir, ext_loot.worksignals)
        arena.load_link = lambda: {"token": "T", "url": "https://arena.example", "handle": "ann"}
        ext_loot._base_dir = self.tmp
        ext_loot._which = lambda name: "/usr/bin/gh"
        ext_loot.worksignals = None
        self.cfg = {"workSignals": True, "workSignalsPRs": True}
        ext_loot._load_config = lambda: dict(self.cfg)
        self.gh_rows = _urls(3)
        self.gh_calls = []
        ext_loot._run = self._gh
        self.sent = []
        self.reply = (200, {"accepted": 1, "chests": [{"id": "ch-" + "a" * 32}]})
        arena._request = self._fake

    def tearDown(self):
        (arena._request, arena.load_link, ext_loot._run, ext_loot._which,
         ext_loot._load_config, ext_loot._base_dir, ext_loot.worksignals) = self.saved
        shutil.rmtree(self.tmp, ignore_errors=True)
        for method, url, token, body in self.sent:
            self.assertEqual(_collect_keys(body) & FORBIDDEN_KEYS, set(), url)
            self.assertNotIn("github.com", json.dumps(body))

    def _gh(self, argv, **kw):
        self.gh_calls.append((argv, kw))
        return _Done(self.gh_rows)

    def _fake(self, method, url, token=None, body=None):
        self.sent.append((method, url, token, body))
        return self.reply

    def _today(self):
        return datetime.now(timezone.utc).date().isoformat()

    def test_first_scan_is_a_baseline_then_a_new_merge_reports_one(self):
        ext_loot.run_once()
        self.assertEqual(self.sent, [], "no backfill burst on the first run")
        self.assertEqual(len(self.gh_calls), 1)
        argv, kw = self.gh_calls[0]
        self.assertEqual(argv[:6], ["gh", "search", "prs", "--author=@me", "--merged", "--merged-at"])
        self.assertTrue(argv[6].startswith(">="))
        self.assertEqual(argv[7:], ["--json", "url", "--limit", "50"])
        self.assertEqual(kw.get("timeout"), 20)
        ext_loot.run_once()
        self.assertEqual(self.sent, [], "nothing new merged")
        self.gh_rows = _urls(4)
        ext_loot.run_once()
        self.assertEqual(len(self.sent), 1)
        method, url, token, body = self.sent[0]
        self.assertEqual((method, url, token), ("POST", "https://arena.example/v1/loot/events", "T"))
        self.assertEqual(set(body), {"requestId", "type", "n", "day"})
        self.assertEqual(body["type"], "pr_merged")
        self.assertEqual(body["n"], 1)
        self.assertEqual(body["day"], self._today())
        self.assertRegex(body["requestId"], r"^loot-[0-9a-f]{40}$")
        # Sent once; the next cycle has nothing to say.
        ext_loot.run_once()
        self.assertEqual(len(self.sent), 1)

    def test_the_state_file_keeps_hashes_not_urls(self):
        ext_loot.run_once()
        path = os.path.join(self.tmp, "loot-state.json")
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        raw = open(path).read()
        self.assertNotIn("github", raw)
        self.assertNotIn("secret-repo", raw)
        st = json.loads(raw)
        self.assertEqual(len(st["seen"]), 3)

    def test_a_4xx_is_not_retried_but_a_5xx_is(self):
        ext_loot.run_once()
        self.gh_rows = _urls(4)
        self.reply = (422, {"error": "day must be today or yesterday (UTC)"})
        ext_loot.run_once()
        self.assertEqual(len(self.sent), 1)
        ext_loot.run_once()
        self.assertEqual(len(self.sent), 1, "a 422 marks the delta sent")
        self.gh_rows = _urls(5)
        self.reply = (503, {"error": "busy"})
        ext_loot.run_once()
        self.reply = (0, {"error": "offline"})
        ext_loot.run_once()
        self.reply = (200, {"accepted": 1, "chests": []})
        ext_loot.run_once()
        ext_loot.run_once()
        bodies = [b for _, _, _, b in self.sent[1:]]
        self.assertEqual(len(bodies), 3, "retried until a 2xx, then quiet")
        self.assertEqual(len({b["requestId"] for b in bodies}), 1, "a retry reuses its requestId")

    def test_prs_off_runs_no_subprocess(self):
        self.cfg["workSignalsPRs"] = False
        ext_loot.run_once()
        ext_loot.get_status(lambda k: "")
        self.assertEqual(self.gh_calls, [])
        self.assertEqual(self.sent, [])

    def test_no_gh_on_path_runs_no_subprocess(self):
        ext_loot._which = lambda name: None
        ext_loot.run_once()
        self.assertEqual(self.gh_calls, [])

    def test_work_signals_off_sends_nothing_at_all(self):
        self.cfg = {"workSignals": False, "workSignalsPRs": True}
        ext_loot.worksignals = types.SimpleNamespace(
            day_counts=lambda days: {self._today(): {"tests_green": 3}})
        self.assertIn("skipped", ext_loot.run_once())
        self.assertEqual(self.sent, [])
        self.assertEqual(self.gh_calls, [])
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "loot-state.json")))

    def test_unpaired_sends_nothing(self):
        arena.load_link = lambda: {"url": "https://arena.example"}  # no token
        ext_loot.run_once()
        self.assertEqual(self.sent, [])
        self.assertEqual(self.gh_calls, [])
        code, resp = ext_loot.get_loot(lambda k: "")
        self.assertEqual(code, 400)

    def test_worksignals_counts_report_as_deltas(self):
        self.cfg["workSignalsPRs"] = False
        today = self._today()
        yday = (datetime.now(timezone.utc).date() - timedelta(days=1)).isoformat()
        counts = {today: {"tests_green": 2, "focus_long": 1, "tests": 40, "docs": 3},
                  yday: {"tests_green": 1}, "2020-01-01": {"tests_green": 9}}
        ext_loot.worksignals = types.SimpleNamespace(day_counts=lambda days: counts)
        code, st = ext_loot.get_status(lambda k: "")
        self.assertEqual(st["pending"], {"tests_green": 3, "focus_long": 1})
        ext_loot.run_once()
        got = sorted((b["type"], b["day"], b["n"]) for _, _, _, b in self.sent)
        self.assertEqual(got, sorted([("focus_long", today, 1), ("tests_green", today, 2),
                                      ("tests_green", yday, 1)]))
        for _, _, _, b in self.sent:
            self.assertEqual(set(b), {"requestId", "type", "n", "day"})
        counts[today]["tests_green"] = 9
        ext_loot.run_once()
        last = self.sent[-2:]
        self.assertEqual([b["n"] for _, _, _, b in last], [5, 2], "split into n<=5")
        code, st = ext_loot.get_status(lambda k: "")
        self.assertEqual(st["pending"], {})
        self.assertTrue(st["enabled"])
        self.assertFalse(st["prs"])
        self.assertIsNotNone(st["lastReport"])

    def test_old_days_are_pruned(self):
        st = ext_loot.load_state()
        st["sent"] = {"pr_merged": {"2020-01-01": 3}}
        st["prs"] = {"2020-01-01": 3}
        ext_loot.save_state(st)
        ext_loot.run_once()
        st = ext_loot.load_state()
        self.assertEqual(st["prs"], {})
        self.assertEqual(st["sent"]["pr_merged"], {})

    def test_open_forwards_only_the_chest_and_a_request_id(self):
        cid = "ch-" + "0123456789abcdef" * 2
        code, _ = ext_loot.post_open({"chestId": cid, "title": "x", "path": "/etc"})
        self.assertEqual(code, 200)
        method, url, token, body = self.sent[-1]
        self.assertEqual((method, url), ("POST", "https://arena.example/v1/loot/open"))
        self.assertEqual(set(body), {"chestId", "requestId"})
        self.assertRegex(body["requestId"], r"^open-[0-9a-f]{24}$")
        ext_loot.post_open({"chestId": cid, "requestId": "open-mine-0123456789"})
        self.assertEqual(self.sent[-1][3]["requestId"], "open-mine-0123456789")
        n = len(self.sent)
        for bad in ("", "ch-xyz", "ch-" + "A" * 32, None, 7, "../v1/loot"):
            code, resp = ext_loot.post_open({"chestId": bad})
            self.assertEqual(code, 400, bad)
        self.assertEqual(len(self.sent), n)

    def test_get_loot_proxies(self):
        code, _ = ext_loot.get_loot(lambda k: "")
        self.assertEqual(code, 200)
        self.assertEqual(self.sent[-1][:2], ("GET", "https://arena.example/v1/loot"))

    def test_the_routes_are_registered(self):
        self.assertIn("/api/arena/loot", ext_loot.GET)
        self.assertIn("/api/loot/status", ext_loot.GET)
        self.assertEqual(set(ext_loot.POST), {"/api/arena/loot/open"})
        import dashboard
        self.assertIn("/api/arena/loot/open", dashboard.POST_PATHS)
        self.assertIn(ext_loot, dashboard.EXT)


if __name__ == "__main__":
    unittest.main()
