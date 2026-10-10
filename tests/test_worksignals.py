"""Work signals (HQ 2.5): local classification of transcripts into per-UTC-day
counts. Transcripts are written to a temp dir and scanned through
dashboard.scan_file (the single cached pass); nothing touches ~/.claude.
"""
import json
import os
import shutil
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import dashboard  # noqa: E402
import worksignals as ws  # noqa: E402

DAY = "2026-09-01"


def ts(h, m, s=0, day=DAY):
    return "%sT%02d:%02d:%02d.000Z" % (day, h, m, s)


def use(tid, name, inp, t):
    return {"type": "assistant", "timestamp": t,
            "message": {"content": [{"type": "tool_use", "id": tid, "name": name, "input": inp}]}}


def result(tid, out, t, err=False):
    b = {"type": "tool_result", "tool_use_id": tid, "content": out}
    if err:
        b["is_error"] = True
    return {"type": "user", "timestamp": t, "message": {"content": [b]}}


def synthetic():
    """One of each signal, all on DAY."""
    r = []
    # tests + tests_green: a passing pytest run (after a cd).
    r.append(use("t1", "Bash", {"command": "cd app && python3 -m pytest -q"}, ts(10, 0)))
    r.append(result("t1", "12 passed in 0.4s", ts(10, 0, 5)))
    # tests (not green): a failing cargo test.
    r.append(use("t2", "Bash", {"command": "cargo test"}, ts(10, 1)))
    r.append(result("t2", "test result: FAILED. 3 passed; 1 failed", ts(10, 1, 9)))
    # tests: editing a test file.
    r.append(use("t3", "Edit", {"file_path": "/r/tests/test_x.py", "old_string": "a", "new_string": "b"}, ts(10, 2)))
    r.append(result("t3", "ok", ts(10, 2, 1)))
    # docs: a README and a docs/ page.
    r.append(use("d1", "Write", {"file_path": "/r/README.md", "content": "# hi"}, ts(10, 3)))
    r.append(result("d1", "ok", ts(10, 3, 1)))
    r.append(use("d2", "Edit", {"file_path": "/r/docs/guide.html", "old_string": "a", "new_string": "b"}, ts(10, 4)))
    r.append(result("d2", "ok", ts(10, 4, 1)))
    # refactor: MultiEdit with two edits, and a two-hunk Edit, on code.
    r.append(use("r1", "MultiEdit", {"file_path": "/r/src/a.py", "edits": [{"old_string": "a", "new_string": "b"},
                                                                           {"old_string": "c", "new_string": "d"}]}, ts(10, 5)))
    r.append(result("r1", "ok", ts(10, 5, 1)))
    r.append(use("r2", "Edit", {"file_path": "/r/src/a.py", "old_string": "x = 1\ny = 2\nz = 3\n",
                                "new_string": "x = 9\ny = 2\nz = 8\n"}, ts(10, 6)))
    r.append(result("r2", "ok", ts(10, 6, 1)))
    # build: a single-hunk code edit, and a new code file.
    r.append(use("b1", "Edit", {"file_path": "/r/src/b.rs", "old_string": "fn a", "new_string": "fn b"}, ts(10, 7)))
    r.append(result("b1", "ok", ts(10, 7, 1)))
    r.append(use("b2", "Write", {"file_path": "/r/src/c.js", "content": "var a;"}, ts(10, 8)))
    r.append(result("b2", "ok", ts(10, 8, 1)))
    # review: git diff and gh pr view.
    r.append(use("v1", "Bash", {"command": "git diff HEAD~1"}, ts(10, 9)))
    r.append(result("v1", "diff --git", ts(10, 9, 1)))
    r.append(use("v2", "Bash", {"command": "gh pr view 12"}, ts(10, 10)))
    r.append(result("v2", "title", ts(10, 10, 1)))
    # explore: Grep, Glob, Read.
    for i, n in enumerate(("Grep", "Glob", "Read")):
        r.append(use("e%d" % i, n, {"pattern": "x"}, ts(10, 11 + i)))
        r.append(result("e%d" % i, "found", ts(10, 11 + i, 1)))
    # debug: an errored Bash, then a retry of Bash (echo: not a test, not review).
    r.append(use("g1", "Bash", {"command": "make it"}, ts(10, 20)))
    r.append(result("g1", "boom", ts(10, 20, 1), err=True))
    r.append(use("g2", "Bash", {"command": "make it go"}, ts(10, 21)))
    r.append(result("g2", "ok", ts(10, 21, 1)))
    # debug: a traceback in a Read result (also one more explore).
    r.append(use("g3", "Read", {"file_path": "/r/log.txt"}, ts(10, 22)))
    r.append(result("g3", "Traceback (most recent call last):\n  File x", ts(10, 22, 1)))
    # not a test: echo pytest.
    r.append(use("n1", "Bash", {"command": "echo pytest"}, ts(10, 23)))
    r.append(result("n1", "pytest", ts(10, 23, 1)))
    return r


EXPECTED = {"tests": 3, "tests_green": 1, "docs": 2, "refactor": 2, "build": 2,
            "review": 2, "explore": 4, "debug": 2, "focus_long": 0}


class _Case(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._cache = dict(dashboard._scan_cache)
        dashboard._scan_cache.clear()
        ws.init(dashboard.scan_file, lambda: iter(()))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        dashboard._scan_cache.clear()
        dashboard._scan_cache.update(self._cache)

    def write(self, name, records):
        p = os.path.join(self.tmp, name + ".jsonl")
        with open(p, "w", encoding="utf-8") as f:
            for r in records:
                f.write(json.dumps(r) + "\n")
        return p


class ClassifyTests(_Case):
    def test_synthetic_entries_give_the_expected_counts(self):
        p = self.write("a", synthetic())
        got = ws.day_counts([DAY], paths=[p])[DAY]
        self.assertEqual(set(got), set(ws.KEYS))
        self.assertEqual(got, EXPECTED)

    def test_classify_entry_on_a_bare_day_bucket(self):
        day = {}
        for r in synthetic():
            ws.classify_entry(r, day)
        self.assertEqual(day["ws"]["tests"], 3)
        self.assertEqual(day["ws"]["tests_green"], 1)
        # junk never raises
        for junk in (None, 3, "x", {"type": "assistant", "message": {"content": "hi"}},
                     {"type": "assistant", "message": {"content": [{"type": "tool_use", "input": 5}]}}):
            ws.classify_entry(junk, day)
            ws.classify_entry(junk, None)

    def test_helpers(self):
        self.assertTrue(ws.is_test_command("FOO=1 npm test"))
        self.assertTrue(ws.is_test_command("cd backend-rs && cargo test && cargo clippy"))
        self.assertTrue(ws.is_test_command("python3 -m unittest discover -s tests"))
        self.assertFalse(ws.is_test_command("grep pytest setup.cfg"))
        self.assertFalse(ws.is_test_command(None))
        self.assertTrue(ws.is_review_command("git --no-pager log --oneline"))
        self.assertFalse(ws.is_review_command("git commit -m diff"))
        self.assertEqual(ws.file_kind("src/foo.test.ts"), "test")
        self.assertEqual(ws.file_kind("notes.TXT"), "doc")
        self.assertEqual(ws.file_kind("a/b.py"), "code")
        self.assertEqual(ws.file_kind(""), "")

    def test_the_aggregate_holds_only_counts(self):
        p = self.write("a", synthetic())
        agg = dashboard.scan_file(p)
        blob = json.dumps(agg.get("ws_days"))
        for leak in ("README", "pytest", "git", "Grep", "/r/", ".py", "Traceback"):
            self.assertNotIn(leak, blob)


class CacheTests(_Case):
    def test_a_warm_cache_rescan_does_not_double_count(self):
        p = self.write("a", synthetic())
        first = ws.day_counts([DAY], paths=[p])
        again = ws.day_counts([DAY], paths=[p])
        third = ws.day_counts([DAY], paths=[p, p][:1])
        self.assertEqual(first, again)
        self.assertEqual(first, third)
        self.assertEqual(first[DAY]["tests"], 3)

    def test_an_mtime_bump_rescans_cold_with_identical_totals(self):
        p = self.write("a", synthetic())
        first = ws.day_counts([DAY], paths=[p])
        agg1 = dashboard.scan_file(p)
        st = os.stat(p)
        os.utime(p, (st.st_atime + 5, st.st_mtime + 5))
        agg2 = dashboard.scan_file(p)
        self.assertIsNot(agg1, agg2)          # really re-read
        self.assertEqual(ws.day_counts([DAY], paths=[p]), first)

    def test_two_transcripts_sum(self):
        a = self.write("a", synthetic())
        b = self.write("b", synthetic())
        got = ws.day_counts([DAY], paths=[a, b])[DAY]
        self.assertEqual(got["explore"], 8)
        self.assertEqual(got["tests_green"], 2)


class FocusTests(_Case):
    def _run(self, start_h, start_m, minutes, day, step=5):
        out = []
        h, m, d = start_h, start_m, day
        for i in range(0, minutes + 1, step):
            tot = start_h * 60 + start_m + i
            dd = d
            if tot >= 24 * 60:
                tot -= 24 * 60
                dd = "2026-09-02"
            out.append({"type": "user", "timestamp": ts(tot // 60, tot % 60, day=dd),
                        "message": {"content": "go"}})
        return out

    def test_a_50_minute_span_across_utc_midnight_credits_the_end_day(self):
        p = self.write("f", self._run(23, 40, 50, DAY))
        got = ws.day_counts([DAY, "2026-09-02"], paths=[p])
        self.assertEqual(got[DAY]["focus_long"], 0)
        self.assertEqual(got["2026-09-02"]["focus_long"], 1)

    def test_a_gap_over_ten_minutes_breaks_the_span(self):
        recs = self._run(9, 0, 30, DAY) + self._run(9, 45, 30, DAY)   # 15-min gap
        p = self.write("g", recs)
        self.assertEqual(ws.day_counts([DAY], paths=[p])[DAY]["focus_long"], 0)
        p2 = self.write("h", self._run(9, 0, 100, DAY, step=10))       # 10-min steps: one span
        self.assertEqual(ws.day_counts([DAY], paths=[p2])[DAY]["focus_long"], 1)

    def test_focus_spans(self):
        self.assertEqual(ws.focus_spans([]), [])
        self.assertEqual(ws.focus_spans([0, 600, 1200, 1800, 2400, 2700]), [(0, 2700)])
        self.assertEqual(ws.focus_spans([0, 2600]), [])


class ReportTests(unittest.TestCase):
    def test_report_counts_keeps_exactly_the_seven(self):
        one = dict.fromkeys(ws.KEYS, 4)
        self.assertEqual(set(ws.report_counts(one)), set(ws.SKILL_CATS))
        self.assertEqual(len(ws.SKILL_CATS), 7)
        many = ws.report_counts({DAY: one, "2026-09-02": {"tests": 999, "focus_long": 3}})
        self.assertEqual(set(many), {DAY, "2026-09-02"})
        for d in many.values():
            self.assertEqual(set(d), set(ws.SKILL_CATS))
            self.assertNotIn("tests_green", d)
            self.assertNotIn("focus_long", d)
        self.assertEqual(many["2026-09-02"]["tests"], ws.MAX_N)
        self.assertEqual(ws.report_counts({"tests": -3, "docs": "x", "build": True})["tests"], 0)

    def test_without_a_scanner_day_counts_is_all_zero(self):
        ws.init(None, None)
        try:
            got = ws.day_counts([DAY])
            self.assertEqual(got, {DAY: dict.fromkeys(ws.KEYS, 0)})
        finally:
            ws.init(dashboard.scan_file, lambda: iter(()))

    def test_last_days(self):
        import datetime as dt
        now = dt.datetime(2026, 10, 10, 0, 30, tzinfo=dt.timezone.utc)
        self.assertEqual(ws.last_days(3, now), ["2026-10-08", "2026-10-09", "2026-10-10"])
        self.assertEqual(len(ws.last_days(7)), 7)
        self.assertTrue(time.time())


if __name__ == "__main__":
    unittest.main()
