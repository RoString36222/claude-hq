"""Needs-you detection without hooks (issue #46): an open AskUserQuestion /
ExitPlanMode call makes a live tab "needs", a permission-gated tool left open a
while in a prompting permission mode only adds a likelyAwaiting hint, and a
live status other than busy/idle that means "waiting" reads as needs.
Stdlib only; transcripts are written to a temp dir, nothing touches ~/.claude.
"""
import json
import os
import shutil
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import dashboard  # noqa: E402

SID = "33333333-3333-4333-8333-333333333333"


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def ago(secs):
    return iso(datetime.now(timezone.utc) - timedelta(seconds=secs))


def asst(blocks, ts, mid):
    return {"type": "assistant", "timestamp": ts,
            "message": {"id": mid, "model": "claude-opus-5-5", "content": blocks,
                        "usage": {"input_tokens": 1, "output_tokens": 1}}}


def user(content, ts, **extra):
    rec = {"type": "user", "timestamp": ts, "message": {"content": content}}
    rec.update(extra)
    return rec


def tool_use(tid, name, inp=None):
    return {"type": "tool_use", "id": tid, "name": name, "input": inp or {}}


def tool_result(tid):
    return [{"type": "tool_result", "tool_use_id": tid, "content": "ok"}]


ASK = tool_use("ask1", "AskUserQuestion",
               {"questions": [{"question": "Which   table should I use?", "options": []}]})


class _Case(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._saved = (dashboard.PROJECTS_DIR, dashboard.find_transcript)
        dashboard.PROJECTS_DIR = self.tmp
        os.makedirs(os.path.join(self.tmp, "proj"))
        self.path = os.path.join(self.tmp, "proj", SID + ".jsonl")
        dashboard.find_transcript = lambda sid: self.path if sid == SID else None

    def tearDown(self):
        dashboard.PROJECTS_DIR, dashboard.find_transcript = self._saved
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write(self, records):
        with open(self.path, "w", encoding="utf-8") as f:
            for r in records:
                f.write(json.dumps(r) + "\n")

    def session(self, records, status="busy", kind="interactive"):
        self.write(records)
        agent = {"sessionId": SID, "cwd": "/tmp/proj", "kind": kind, "pid": 4242}
        agent["status" if kind == "interactive" else "state"] = status
        return dashboard.build_session(agent, meals={}, fatigue_on=False)


class PendingAskTests(_Case):
    def test_open_question_is_needs_with_its_text(self):
        s = self.session([user("help me", ago(60), permissionMode="default"),
                          asst([ASK], ago(50), "m1")])
        self.assertEqual(s["status"], "needs")
        self.assertEqual(s["alertKind"], "question")
        self.assertEqual(s["alert"], "Asked you a question: Which table should I use?")
        self.assertTrue(s["waitingSince"])

    def test_plan_approval_is_needs(self):
        s = self.session([user("plan it", ago(60)),
                          asst([tool_use("p1", "ExitPlanMode", {"plan": "x"})], ago(50), "m1")],
                         status="idle")
        self.assertEqual(s["status"], "needs")
        self.assertEqual(s["alertKind"], "plan")
        self.assertEqual(s["alert"], "Waiting for you to approve a plan")

    def test_answered_question_is_not_needs(self):
        s = self.session([user("help me", ago(60)),
                          asst([ASK], ago(50), "m1"),
                          user(tool_result("ask1"), ago(40))], status="idle")
        self.assertEqual(s["status"], "idle")
        self.assertIsNone(s["alertKind"])

    def test_new_prompt_or_interrupt_clears_an_orphaned_question(self):
        for closer in ("go on instead", [{"type": "text", "text": "[Request interrupted by user]"}]):
            s = self.session([user("help me", ago(60)),
                              asst([ASK], ago(50), "m1"),
                              user(closer, ago(40))], status="idle")
            self.assertEqual(s["status"], "idle", closer)

    def test_question_on_a_stale_tab_stays_stale(self):
        s = self.session([user("help me", ago(3 * 86400)),
                          asst([ASK], ago(3 * 86400 - 10), "m1")], status="idle")
        self.assertEqual(s["status"], "stale")

    def test_scanner_keeps_latest_pending_ask(self):
        self.write([user("x", ago(60)),
                    asst([ASK], ago(50), "m1"),
                    asst([tool_use("p1", "ExitPlanMode")], ago(40), "m2")])
        agg = dashboard._scan_file_uncached(self.path)
        self.assertEqual(agg["pending_ask"]["kind"], "plan")
        self.assertEqual(agg["pending_ask"]["text"], "")


class LikelyAwaitingTests(_Case):
    def recs(self, mode, name="Bash", open_for=60):
        return [user("run it", ago(open_for + 5), permissionMode=mode),
                asst([tool_use("b1", name, {"command": "ls"})], ago(open_for), "m1")]

    def test_bash_open_in_default_mode_is_a_hint_only(self):
        s = self.session(self.recs("default"))
        self.assertEqual(s["status"], "working")
        self.assertEqual(s["likelyAwaiting"], "May be waiting for permission to run Bash")
        self.assertIsNone(s["alert"])

    def test_no_hint_in_auto_or_bypass_mode(self):
        for mode in ("auto", "bypassPermissions"):
            self.assertIsNone(self.session(self.recs(mode))["likelyAwaiting"], mode)

    def test_no_hint_for_a_fresh_tool_or_ungated_tool(self):
        self.assertIsNone(self.session(self.recs("default", open_for=5))["likelyAwaiting"])
        self.assertIsNone(self.session(self.recs("default", name="Read"))["likelyAwaiting"])

    def test_edits_are_not_gated_in_accept_edits_mode(self):
        self.assertIsNone(self.session(self.recs("acceptEdits", name="Edit"))["likelyAwaiting"])
        self.assertIsNotNone(self.session(self.recs("acceptEdits", name="Bash"))["likelyAwaiting"])
        self.assertIsNotNone(self.session(self.recs("default", name="mcp__x__y"))["likelyAwaiting"])

    def test_no_hint_once_the_tool_returns(self):
        recs = self.recs("default") + [user(tool_result("b1"), ago(1))]
        self.assertIsNone(self.session(recs)["likelyAwaiting"])

    def test_no_hint_when_not_working(self):
        self.assertIsNone(self.session(self.recs("default"), status="idle")["likelyAwaiting"])


class LiveStatusTests(_Case):
    def test_waiting_like_status_is_needs(self):
        recs = [user("hi", ago(30))]
        for st in dashboard.LIVE_WAIT_STATES:
            s = self.session(recs, status=st)
            self.assertEqual(s["status"], "needs", st)
            self.assertEqual(s["alertKind"], "waiting", st)

    def test_unknown_status_still_idle(self):
        self.assertEqual(self.session([user("hi", ago(30))], status="mystery")["status"], "idle")

    def test_background_blocked_unchanged(self):
        s = self.session([user("hi", ago(30))], status="blocked", kind="background")
        self.assertEqual(s["status"], "needs")
        self.assertEqual(s["alertKind"], "blocked")


if __name__ == "__main__":
    unittest.main()
