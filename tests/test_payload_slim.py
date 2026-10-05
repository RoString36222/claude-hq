"""Slim live payload (issue #48): session text is trimmed in every stream frame,
the full text stays available from the detail endpoint and the JSON export,
and the stream's change signature ignores the clock and per-tick ages.
Stdlib only; transcripts are written to a temp dir, nothing touches ~/.claude.
"""
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import dashboard  # noqa: E402

SID = "44444444-4444-4444-8444-444444444444"
TS = "2026-09-01T10:00:00.000Z"
LONG_PROMPT = "please analyse " + "x" * 20000
LONG_REPLY = "done: " + "y" * 5000


class _Case(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._saved = (dashboard.PROJECTS_DIR, dashboard.find_transcript)
        dashboard.PROJECTS_DIR = self.tmp
        os.makedirs(os.path.join(self.tmp, "proj"))
        self.path = os.path.join(self.tmp, "proj", SID + ".jsonl")
        with open(self.path, "w", encoding="utf-8") as f:
            f.write(json.dumps({"type": "user", "timestamp": TS,
                                "message": {"content": LONG_PROMPT}}) + "\n")
            f.write(json.dumps({"type": "assistant", "timestamp": TS, "message": {
                "id": "m1", "model": "claude-opus-5-5",
                "content": [{"type": "text", "text": LONG_REPLY}],
                "usage": {"input_tokens": 1, "output_tokens": 1}}}) + "\n")
        dashboard.find_transcript = lambda sid: self.path if sid == SID else None

    def tearDown(self):
        dashboard.PROJECTS_DIR, dashboard.find_transcript = self._saved
        shutil.rmtree(self.tmp, ignore_errors=True)


class TrimTests(_Case):
    def test_archived_card_text_is_trimmed(self):
        s = dashboard.build_archived_session(self.path, SID, meals={}, fatigue_on=False)
        self.assertLessEqual(len(s["firstPrompt"]), dashboard.LIVE_PROMPT_MAX)
        self.assertLessEqual(len(s["lastPrompt"]), dashboard.LIVE_PROMPT_MAX)
        self.assertLessEqual(len(s["lastReply"]), dashboard.LIVE_REPLY_MAX)
        self.assertTrue(s["firstPrompt"].startswith("please analyse"))
        self.assertTrue(s["firstPrompt"].endswith("…"))

    def test_live_card_text_is_trimmed(self):
        s = dashboard.build_session({"sessionId": SID, "cwd": "/tmp/proj",
                                     "kind": "interactive", "status": "idle"},
                                    meals={}, fatigue_on=False)
        self.assertLessEqual(len(s["firstPrompt"]), dashboard.LIVE_PROMPT_MAX)
        self.assertLessEqual(len(s["lastReply"]), dashboard.LIVE_REPLY_MAX)

    def test_card_size_budget(self):
        s = dashboard.build_archived_session(self.path, SID, meals={}, fatigue_on=False)
        # A card stays a few KB however long the prompt was (it was 20 KB+ before).
        self.assertLess(len(json.dumps(s)), 4000)


class FullTextTests(_Case):
    def test_detail_has_full_text(self):
        saved = dashboard.build_payload_memo
        dashboard.build_payload_memo = lambda: {"sessions": []}
        try:
            d = dashboard.build_session_detail(SID)
        finally:
            dashboard.build_payload_memo = saved
        self.assertEqual(d["firstPromptFull"], LONG_PROMPT)
        self.assertEqual(d["lastPromptFull"], LONG_PROMPT)
        self.assertEqual(d["lastReplyFull"], LONG_REPLY)

    def test_export_rehydrates_full_text(self):
        card = dashboard.build_archived_session(self.path, SID, meals={}, fatigue_on=False)
        out = dashboard._full_text_sessions([card])
        self.assertEqual(out[0]["firstPrompt"], LONG_PROMPT)
        self.assertEqual(out[0]["lastReply"], LONG_REPLY)
        self.assertLessEqual(len(card["firstPrompt"]), dashboard.LIVE_PROMPT_MAX)  # input untouched


class StreamSigTests(unittest.TestCase):
    def payload(self, updated, age, title="t"):
        return {"updated": updated, "sessions": [{"sessionId": "a", "ageSecs": age,
                                                  "title": title}]}

    def test_clock_and_ages_do_not_change_the_signature(self):
        self.assertEqual(dashboard._stream_sig(self.payload("t1", 5)),
                         dashboard._stream_sig(self.payload("t2", 9)))

    def test_real_changes_do(self):
        self.assertNotEqual(dashboard._stream_sig(self.payload("t1", 5)),
                            dashboard._stream_sig(self.payload("t1", 5, title="new")))

    def test_blob_is_serialized_once_per_payload(self):
        saved = dashboard.build_payload_memo
        p = self.payload("t1", 5)
        dashboard.build_payload_memo = lambda: p
        try:
            b1, s1 = dashboard.build_payload_blob()
            b2, s2 = dashboard.build_payload_blob()
        finally:
            dashboard.build_payload_memo = saved
        self.assertIs(b1, b2)
        self.assertEqual(json.loads(b1), p)
        self.assertEqual(s1, s2)


if __name__ == "__main__":
    unittest.main()
