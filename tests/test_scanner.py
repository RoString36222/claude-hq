"""Scanner correctness in dashboard.py (issues #43, #44): usage dedupe by
message.id, TTL-aware cache-write pricing, image/list-content prompts, API-error
detection, Esc interrupts, and UUID validation on the session GET routes.
Stdlib only; transcripts are written to a temp dir, nothing touches ~/.claude.
"""
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import dashboard  # noqa: E402

SID = "22222222-2222-4222-8222-222222222222"
TS = "2026-09-01T10:00:00.000Z"
DAY = "2026-09-01"
USAGE = {"input_tokens": 1000, "output_tokens": 500,
         "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}


def asst(blocks, mid=None, rid=None, usage=None, ts=TS, **extra):
    msg = {"model": "claude-sonnet-4-6", "content": blocks,
           "usage": dict(usage or USAGE)}
    if mid is not None:
        msg["id"] = mid
    rec = {"type": "assistant", "timestamp": ts, "message": msg}
    if rid is not None:
        rec["requestId"] = rid
    rec.update(extra)
    return rec


def user(content, ts=TS):
    return {"type": "user", "timestamp": ts, "message": {"content": content}}


def text(t):
    return {"type": "text", "text": t}


class _TranscriptCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.path = os.path.join(self.tmp, SID + ".jsonl")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def scan(self, records):
        with open(self.path, "w", encoding="utf-8") as f:
            for r in records:
                f.write(json.dumps(r) + "\n")
        return dashboard._scan_file_uncached(self.path)


class UsageDedupeTests(_TranscriptCase):
    def one_record_cost(self):
        return dashboard._usage_cost("claude-sonnet-4-6", USAGE)[0]

    def test_records_sharing_message_id_count_once(self):
        agg = self.scan([
            asst([text("thinking about it")], mid="msg_1", rid="req_1"),
            asst([{"type": "tool_use", "id": "t1", "name": "Read", "input": {}}],
                 mid="msg_1", rid="req_1"),
            asst([text("done")], mid="msg_1", rid="req_1"),
        ])
        self.assertEqual(agg["tok_output"], 500)
        self.assertEqual(agg["tok_input"], 1000)
        self.assertAlmostEqual(agg["cost"], self.one_record_cost())
        day = agg["per_day"][DAY]
        self.assertEqual(day["output"], 500)
        self.assertAlmostEqual(day["cost"], self.one_record_cost())
        # Non-usage per-day counters still see every record.
        self.assertEqual(day["tools"], 1)
        self.assertEqual(day["replies"], 2)

    def test_distinct_message_ids_each_count(self):
        agg = self.scan([asst([text("a")], mid="msg_1"), asst([text("b")], mid="msg_2")])
        self.assertEqual(agg["tok_output"], 1000)

    def test_request_id_is_the_fallback_key(self):
        agg = self.scan([asst([text("a")], rid="req_1"), asst([text("b")], rid="req_1"),
                         asst([text("c")], rid="req_2")])
        self.assertEqual(agg["tok_output"], 1000)

    def test_records_without_any_id_still_count(self):
        agg = self.scan([asst([text("a")]), asst([text("b")])])
        self.assertEqual(agg["tok_output"], 1000)

    def test_per_day_bucket_exists_for_a_deduped_record_on_a_new_day(self):
        agg = self.scan([asst([text("a")], mid="m"),
                         asst([text("b")], mid="m", ts="2026-09-02T00:30:00.000Z")])
        self.assertIn("2026-09-02", agg["per_day"])
        self.assertEqual(agg["per_day"]["2026-09-02"]["output"], 0)
        self.assertEqual(agg["per_day"]["2026-09-02"]["replies"], 1)


class PricingTests(unittest.TestCase):
    def test_current_list_prices(self):
        p = dashboard._price_for
        self.assertEqual(p("claude-opus-5-5"), (4.0, 20.0))
        self.assertEqual(p("claude-opus-5"), (5.0, 25.0))
        self.assertEqual(p("claude-opus-4-8"), (5.0, 25.0))
        self.assertEqual(p("claude-opus-4-6"), (5.0, 25.0))
        self.assertEqual(p("claude-opus-4-1-20250805"), (15.0, 75.0))
        self.assertEqual(p("claude-fable-5-1"), (10.0, 50.0))
        self.assertEqual(p("claude-sonnet-5-5"), (2.0, 10.0))
        self.assertEqual(p("claude-sonnet-5"), (2.0, 10.0))
        self.assertEqual(p("claude-sonnet-4-6"), (3.0, 15.0))
        self.assertEqual(p("claude-haiku-4-5"), (1.0, 5.0))

    def test_cache_read_multipliers(self):
        m = dashboard._cache_read_mult
        self.assertEqual(m("claude-opus-5-5"), 0.05)
        self.assertEqual(m("claude-fable-5-1"), 0.025)
        self.assertEqual(m("claude-opus-5"), 0.1)
        self.assertEqual(m(None), 0.1)

    def test_one_hour_cache_write_is_2x_and_five_minute_is_125x(self):
        usage = {"cache_creation_input_tokens": 3_000_000,
                 "cache_creation": {"ephemeral_5m_input_tokens": 1_000_000,
                                    "ephemeral_1h_input_tokens": 2_000_000}}
        cost, _, _, _, cc = dashboard._usage_cost("claude-sonnet-4-6", usage)
        # 1e6 * 3 * 1.25 + 2e6 * 3 * 2 = 3.75 + 12 = 15.75
        self.assertAlmostEqual(cost, 15.75)
        self.assertEqual(cc, 3_000_000)

    def test_undifferentiated_remainder_is_125x(self):
        usage = {"cache_creation_input_tokens": 2_000_000,
                 "cache_creation": {"ephemeral_1h_input_tokens": 1_000_000}}
        cost, *_ = dashboard._usage_cost("claude-sonnet-4-6", usage)
        # 1e6 @ 2x + 1e6 @ 1.25x on $3 = 6 + 3.75
        self.assertAlmostEqual(cost, 9.75)

    def test_breakdown_without_total_still_counts(self):
        usage = {"cache_creation": {"ephemeral_1h_input_tokens": 1_000_000}}
        cost, _, _, _, cc = dashboard._usage_cost("claude-sonnet-4-6", usage)
        self.assertAlmostEqual(cost, 6.0)
        self.assertEqual(cc, 1_000_000)

    def test_garbage_breakdown_is_ignored(self):
        usage = {"cache_creation_input_tokens": 1_000_000, "cache_creation": "x"}
        cost, *_ = dashboard._usage_cost("claude-sonnet-4-6", usage)
        self.assertAlmostEqual(cost, 3.75)
        usage = {"cache_creation": {"ephemeral_1h_input_tokens": "lots"}}
        self.assertEqual(dashboard._usage_cost("claude-sonnet-4-6", usage)[0], 0.0)

    def test_opus_5_5_cache_read_is_005x(self):
        cost, *_ = dashboard._usage_cost(
            "claude-opus-5-5", {"cache_read_input_tokens": 1_000_000})
        self.assertAlmostEqual(cost, 0.2)


class ImagePromptTests(_TranscriptCase):
    def test_list_content_prompt_feeds_per_day_and_timeline(self):
        art = "https://claude.ai/artifact/abc123"
        agg = self.scan([user([
            {"type": "image", "source": {"type": "base64", "data": "xx"}},
            text("look at this " + art),
        ])])
        self.assertEqual(agg["prompt_count"], 1)
        day = agg["per_day"][DAY]
        self.assertEqual(day["prompts"], 1)
        self.assertEqual(day["artifacts"], 1)
        self.assertEqual(sum(day["hours"].values()), 1)
        self.assertEqual([t["kind"] for t in agg["timeline"]], ["you"])
        self.assertEqual([lk["url"] for lk in agg["links"]], [art])


class ErrorSignatureTests(_TranscriptCase):
    def test_assistant_prose_about_billing_is_not_an_error(self):
        agg = self.scan([asst([text("Your billing quota and rate limit look fine.")],
                              mid="m1")])
        self.assertEqual(agg["errors"], [])

    def test_assistant_api_error_message_matches(self):
        agg = self.scan([asst([text("API Error: Credit balance is too low")],
                              mid="m1", isApiErrorMessage=True)])
        self.assertEqual([sig for _, sig in agg["errors"]], ["credit balance"])

    def test_system_api_error_matches_on_the_error_payload(self):
        err = {"message": '529 {"type":"error","error":{"type":"overloaded_error",'
                          '"message":"Overloaded"}}', "status": 529}
        agg = self.scan([{"type": "system", "subtype": "api_error", "level": "error",
                          "timestamp": TS, "error": err,
                          "retryAttempt": 10, "maxRetries": 10}])
        self.assertEqual([sig for _, sig in agg["errors"]], ["overloaded"])

    def test_system_api_error_still_retrying_is_ignored(self):
        agg = self.scan([{"type": "system", "subtype": "api_error", "timestamp": TS,
                          "error": {"message": "Overloaded"},
                          "retryAttempt": 1, "maxRetries": 10}])
        self.assertEqual(agg["errors"], [])

    def test_other_system_records_are_ignored(self):
        agg = self.scan([{"type": "system", "subtype": "away_summary", "timestamp": TS,
                          "content": "We discussed the billing quota and rate limits."}])
        self.assertEqual(agg["errors"], [])

    def test_flagged_error_texts_without_old_signatures_match(self):
        for msg, sig in (("You've hit your monthly spend limit", "spend limit"),
                         ("Login expired \u00b7 Please run /login", "login expired"),
                         ("Prompt is too long", "prompt is too long")):
            agg = self.scan([asst([text(msg)], mid="m1", isApiErrorMessage=True)])
            self.assertEqual([s for _, s in agg["errors"]], [sig], msg)

    def test_flagged_error_with_unknown_text_gets_generic_sig(self):
        agg = self.scan([asst([text("API Error: Unable to connect to API (ENOTFOUND)")],
                              mid="m1", isApiErrorMessage=True)])
        self.assertEqual([s for _, s in agg["errors"]], ["api_error"])
        agg = self.scan([{"type": "system", "subtype": "api_error", "timestamp": TS,
                          "error": {"message": "socket hang up"}}])
        self.assertEqual([s for _, s in agg["errors"]], ["api_error"])

    def test_permission_denied_signature_removed(self):
        self.assertNotIn("permission denied by user", dashboard._ERROR_SIGS)

    def test_record_error_sig_garbage(self):
        self.assertIsNone(dashboard._record_error_sig(None))
        self.assertIsNone(dashboard._record_error_sig({"type": "user"}))
        self.assertIsNone(dashboard._record_error_sig(
            {"type": "assistant", "isApiErrorMessage": "yes",
             "message": {"content": "rate limit"}}))


class TranscriptErrorEventTests(_TranscriptCase):
    def events(self, records):
        self.scan(records)
        return list(dashboard._iter_transcript_events(self.path))

    def test_system_note_mentioning_billing_is_not_an_error_event(self):
        ev = self.events([{"type": "system", "subtype": "away_summary",
                           "timestamp": TS,
                           "content": "We discussed billing and the rate limit."}])
        self.assertEqual([e for e in ev if e["role"] == "system"], [])

    def test_final_api_error_is_an_error_event_with_payload_text(self):
        ev = self.events([
            {"type": "system", "subtype": "api_error", "timestamp": TS,
             "error": {"message": "Overloaded"}, "retryAttempt": 1, "maxRetries": 10},
            {"type": "system", "subtype": "api_error", "timestamp": TS,
             "error": {"message": "Overloaded"}, "retryAttempt": 10, "maxRetries": 10},
        ])
        sys_ev = [e for e in ev if e["role"] == "system"]
        self.assertEqual(len(sys_ev), 1)
        self.assertIn("Overloaded", sys_ev[0]["text"])


class InterruptTests(_TranscriptCase):
    def test_interrupt_markers_are_not_prompts(self):
        for marker in ("[Request interrupted by user]",
                       "[Request interrupted by user for tool use]"):
            self.assertFalse(dashboard.is_real_human_prompt(marker))
            self.assertFalse(dashboard.is_real_human_prompt([text(marker)]))
        self.assertTrue(dashboard.is_real_human_prompt("please continue"))

    def test_interrupt_is_not_counted_in_scan(self):
        agg = self.scan([user("build it"),
                         user([text("[Request interrupted by user]")]),
                         user("[Request interrupted by user for tool use]")])
        self.assertEqual(agg["prompt_count"], 1)
        self.assertEqual(agg["per_day"][DAY]["prompts"], 1)
        self.assertEqual(agg["first_prompt"], "build it")


class FindTranscriptTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._saved = dashboard.PROJECTS_DIR
        dashboard.PROJECTS_DIR = self.tmp
        os.makedirs(os.path.join(self.tmp, "proj"))
        self.path = os.path.join(self.tmp, "proj", SID + ".jsonl")
        with open(self.path, "w", encoding="utf-8") as f:
            f.write(json.dumps(user("hello")) + "\n")

    def tearDown(self):
        dashboard.PROJECTS_DIR = self._saved
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_uuid_is_found(self):
        self.assertEqual(dashboard.find_transcript(SID), self.path)

    def test_non_uuids_are_rejected_before_glob(self):
        for bad in ("*", "2222*", SID[:-1] + "?", "../proj/" + SID, SID + "\n",
                    "", None, 123, ["x"]):
            self.assertIsNone(dashboard.find_transcript(bad), repr(bad))


class SessionRouteTests(unittest.TestCase):
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
        self.calls = []
        self._saved = dashboard.find_transcript

        def spy(sid):
            self.calls.append(sid)
            return None

        dashboard.find_transcript = spy

    def tearDown(self):
        dashboard.find_transcript = self._saved

    def get(self, path):
        req = urllib.request.Request("http://127.0.0.1:%d%s" % (self.port, path))
        try:
            with self.opener.open(req, timeout=5) as r:
                return r.status
        except urllib.error.HTTPError as e:
            e.close()
            return e.code

    def test_non_uuid_ids_404_without_lookup(self):
        for bad in ("*", "%2A", "abc", SID[:-1] + "*", SID + "x"):
            for route in ("/api/transcript/%s", "/api/session/%s",
                          "/api/session/%s/export.md"):
                self.assertEqual(self.get(route % bad), 404, route % bad)
        self.assertEqual(self.calls, [])

    def test_uuid_ids_reach_the_lookup(self):
        for route in ("/api/transcript/%s", "/api/session/%s/export.md"):
            self.assertEqual(self.get(route % SID), 404)
        self.assertEqual(self.calls, [SID, SID])


if __name__ == "__main__":
    unittest.main()
