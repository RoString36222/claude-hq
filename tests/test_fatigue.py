"""Creature fatigue: the pure walk, the scan-time busy-span collector, and the
wiring into the session payload.

The vectors are the contract's (computed by the reference walk that splits
blocks at meals). Stdlib only. Run with:
    python3 -m unittest discover -s tests
"""
import json
import os
import random
import sys
import tempfile
import time
import unittest
import uuid
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import dashboard  # noqa: E402

H, M = 3600, 60
BASE = 1789999200  # 2026-09-21T14:00:00Z, a multiple of the 15-min tick
SID = "00000000-0000-4000-8000-000000000000"
KEYS = {"state", "energy", "loadMins", "mayFaint", "phase", "restInMins",
        "restMins", "streakMins", "lastMeal"}


def fz(spans, now, meals=(), open_since=None, sid=SID):
    return dashboard.fatigue_for(
        sid, [(BASE + a, BASE + b) for a, b in spans], BASE + now,
        open_since=(BASE + open_since) if open_since is not None else None,
        meals=[(BASE + t, k) for t, k in meals])


# name: (spans, now, meals, open_since,
#        (state, energy, loadMins, mayFaint, phase, restInMins, restMins, streakMins),
#        lastMeal kind or None)
VECTORS = {
    "V1": ([(0, 2 * H)], 2 * H, (), None,
           ("fatigued", 0.5, 120, False, "active", 10, 27, 120), None),
    "V2": ([(0, 2 * H)], 2 * H + 8 * M, (), None,
           ("fatigued", 0.479, 125, False, "pause", 2, 19, 125), None),
    "V3": ([(0, 2 * H)], 2 * H + 30 * M, (), None,
           ("rested", 0.812, 45, False, "resting", 0, 0, 0), None),
    "V4": ([(0, 115 * M), (127 * M, 137 * M)], 137 * M, (), None,
           ("fatigued", 0.492, 122, False, "active", 10, 27, 10), None),
    "V5": ([(0, 130 * M)], 130 * M, [(130 * M, "riceball")], None,
           ("tired", 0.646, 85, False, "active", 10, 18, 130), "riceball"),
    "V5b": ([(0, 150 * M)], 150 * M, [(130 * M, "riceball")], None,
            ("tired", 0.562, 105, False, "active", 10, 23, 150), "riceball"),
    "V6": ([(0, 4 * H)], 4 * H, (), None,
           ("unconscious", 0.0, 240, False, "active", 10, 42, 240), None),
    "V7": ([(0, 4 * H)], 4 * H + 30 * M, (), None,
           ("unconscious", 0.312, 165, False, "resting", 0, 12, 0), None),
    "V7b": ([(0, 4 * H)], 4 * H + 45 * M, (), None,
            ("tired", 0.562, 105, False, "resting", 0, 12, 0), None),
    "V8": ([(0, 4 * H)], 4 * H, [(4 * H, "tonic")], None,
           ("tired", 0.562, 105, False, "active", 10, 23, 240), "tonic"),
    "V8b": ([(0, 6 * H)], 6 * H, (), None,
            ("unconscious", 0.0, 300, False, "active", 10, 57, 360), None),
    "V8c": ([(0, 6 * H)], 6 * H, [(6 * H, "tonic")], None,
            ("tired", 0.562, 105, False, "active", 10, 23, 360), "tonic"),
    "V8d": ([(0, 6 * H)], 6 * H + 55 * M, (), None,
            ("unconscious", 0.5, 120, False, "resting", 0, 1, 0), None),
    "V9": ([(0, 2 * H)], 2 * H, [(2 * H, "bento")], None,
           ("rested", 1.0, 0, False, "active", 10, 0, 120), "bento"),
    "V10": ([(0, 50 * M), (70 * M, 120 * M), (140 * M, 190 * M), (210 * M, 260 * M)],
            260 * M, (), None,
            ("tired", 0.604, 95, False, "active", 10, 21, 50), None),
    "V12": ([(0, 3 * H)], 3 * H, (), None,
            ("fatigued", 0.25, 180, True, "active", 10, 42, 180), None),
    "V12a": ([(0, 3 * H + 15 * M)], 3 * H + 15 * M, (), None,
             ("unconscious", 0.188, 195, False, "active", 10, 31, 195), None),
    "V13": ([(0, 30 * M)], 70 * M, (), 30 * M,
            ("tired", 0.708, 70, False, "active", 10, 14, 70), None),
    "V13b": ([(10 * M, 30 * M)], 70 * M, (), 5 * M,
             ("rested", 1.0, 0, False, "resting", 0, 0, 0), None),
    "V13c": ([(0, 30 * M)], 120 * M, (), 30 * M,
             ("rested", 0.938, 15, False, "resting", 0, 0, 0), None),
    "V14": ([(0, 30 * M)], 30 * M, [(30 * M, "berry")], None,
            ("rested", 0.958, 10, False, "active", 10, 0, 30), "berry"),
    "V16": ([(0, 110 * M), (124 * M, 125 * M)], 125 * M, (), None,
            ("tired", 0.583, 100, False, "active", 10, 22, 1), None),
}


class FatigueVectorTests(unittest.TestCase):
    def test_contract_vectors(self):
        for name, (spans, now, meals, osn, want, meal_kind) in VECTORS.items():
            with self.subTest(name):
                r = fz(spans, now, meals, osn)
                got = (r["state"], r["energy"], r["loadMins"], r["mayFaint"], r["phase"],
                       r["restInMins"], r["restMins"], r["streakMins"])
                self.assertEqual(got, want)
                if meal_kind is None:
                    self.assertIsNone(r["lastMeal"])
                else:
                    self.assertEqual(r["lastMeal"]["kind"], meal_kind)

    def test_last_meal_is_iso_utc_at_the_meal_time(self):
        r = fz([(0, 30 * M)], 30 * M, [(30 * M, "berry")])
        self.assertEqual(r["lastMeal"], {"kind": "berry", "at": "2026-09-21T14:30:00+00:00"})

    def test_v11_long_idle_is_exactly_rested(self):
        self.assertEqual(fz([(0, 2 * H)], 27 * H), dashboard.FATIGUE_RESTED)
        self.assertEqual(fz([], 0), dashboard.FATIGUE_RESTED)

    def test_v15_meal_outside_the_window_is_ignored(self):
        self.assertEqual(fz([(0, 2 * H)], 2 * H, [(-25 * H, "bento")]),
                         fz([(0, 2 * H)], 2 * H))

    def test_unknown_food_is_ignored(self):
        self.assertEqual(fz([(0, 2 * H)], 2 * H, [(2 * H, "pizza")]),
                         fz([(0, 2 * H)], 2 * H))

    def test_result_is_a_fresh_dict(self):
        r = fz([], 0)
        r["state"] = "mutated"
        self.assertEqual(dashboard.FATIGUE_RESTED["state"], "rested")


class FatigueBehaviourTests(unittest.TestCase):
    def test_continuity_one_second_steps(self):
        prev = None
        for sec in range(2 * H - 60, 2 * H + 20 * M):
            load = fz([(0, 2 * H)], sec)["loadMins"]
            if prev is not None:
                self.assertLessEqual(abs(load - prev), 1, "jump at %d s" % sec)
            prev = load

    def test_no_retroactive_jump_on_resume(self):
        want = {4: (113, 114), 8: (115, 115), 12: (107, 107), 14: (99, 99),
                16: (91, 91), 30: (35, 35)}
        for g, (b_want, a_want) in want.items():
            with self.subTest(pause=g):
                resume = 110 * M + g * M
                before = fz([(0, 110 * M)], resume - 1)["loadMins"]
                after = fz([(0, 110 * M), (resume, resume + 1)], resume + 1)["loadMins"]
                self.assertEqual((before, after), (b_want, a_want))
                self.assertLessEqual(abs(after - before), 1)

    def test_never_faints_before_3h_and_always_by_4h(self):
        for i in range(200):
            sid = str(uuid.UUID(int=i * 7919 + 12345))
            with self.subTest(sid=sid):
                self.assertNotEqual(
                    fz([(0, 3 * H - 1)], 3 * H - 1, sid=sid)["state"], "unconscious")
                self.assertEqual(fz([(0, 4 * H)], 4 * H, sid=sid)["state"], "unconscious")

    def test_deterministic_and_order_independent(self):
        spans = [(0, 50 * M), (70 * M, 120 * M), (140 * M, 190 * M), (210 * M, 260 * M)]
        meals = [(100 * M, "berry"), (200 * M, "riceball")]
        a = fz(spans, 260 * M, meals)
        shuffled = list(spans)
        random.Random(3).shuffle(shuffled)
        self.assertEqual(a, fz(shuffled, 260 * M, list(reversed(meals))))
        self.assertEqual(a, fz(spans, 260 * M, meals))

    def test_output_shape_and_energy_range(self):
        for name, (spans, now, meals, osn, _, _) in VECTORS.items():
            r = fz(spans, now, meals, osn)
            self.assertEqual(set(r), KEYS, name)
            self.assertTrue(0.0 <= r["energy"] <= 1.0, name)

    def test_rolls_use_absolute_ticks(self):
        # The same absolute tick gives the same roll whatever "now" or the clip is.
        self.assertEqual(dashboard._faint_roll(SID, 5), dashboard._faint_roll(SID, 5))
        self.assertNotEqual(dashboard._faint_roll(SID, 5), dashboard._faint_roll(SID, 6))
        self.assertTrue(0.0 <= dashboard._faint_roll(SID, 7) < 1.0)

    def test_safe_wrapper_never_raises(self):
        self.assertEqual(dashboard._fatigue_safe(SID, None, None, ()), dashboard.FATIGUE_RESTED)
        self.assertEqual(dashboard._fatigue_safe(SID, {"busy_spans": [["x", None]]}, None, ()),
                         dashboard.FATIGUE_RESTED)


class MergeSpansTests(unittest.TestCase):
    def test_sorts_inverted_input(self):
        self.assertEqual(dashboard._merge_spans([(500, 600), (0, 100)], 300),
                         [[0.0, 100.0], [500.0, 600.0]])

    def test_gap_boundary(self):
        self.assertEqual(dashboard._merge_spans([(0, 100), (400, 500)], 300), [[0.0, 500.0]])
        self.assertEqual(dashboard._merge_spans([(0, 100), (401, 500)], 300),
                         [[0.0, 100.0], [401.0, 500.0]])

    def test_drops_reversed_pairs_and_keeps_containing_span(self):
        self.assertEqual(dashboard._merge_spans([(10, 5), (0, 100), (20, 30)], 300),
                         [[0.0, 100.0]])


def _ts(**kw):
    b = datetime(2026, 9, 21, 14, 0, 0, tzinfo=timezone.utc)
    return (b + timedelta(**kw)).isoformat().replace("+00:00", "Z")


FIXTURE = [
    {"type": "user", "timestamp": _ts(), "message": {"role": "user", "content": "fix the tests"}},
    {"type": "user", "timestamp": _ts(days=-13), "message": {"content": "old copied prompt"}},
    {"type": "assistant", "timestamp": _ts(seconds=10),
     "message": {"content": [{"type": "tool_use", "id": "tu1", "name": "Bash", "input": {}}]}},
    {"type": "user", "timestamp": _ts(minutes=50),
     "message": {"content": [{"type": "tool_result", "tool_use_id": "tu1", "content": "ok"}]}},
    {"type": "assistant", "timestamp": _ts(minutes=50, seconds=20),
     "message": {"content": [{"type": "text", "text": "done"}]}},
    {"type": "system", "subtype": "turn_duration", "durationMs": 3030000,
     "timestamp": _ts(minutes=50, seconds=30)},
    {"type": "system", "subtype": "away_summary", "timestamp": _ts(minutes=58), "content": "x"},
    {"type": "assistant", "timestamp": _ts(minutes=60),
     "message": {"content": [{"type": "tool_use", "id": "tu2", "name": "AskUserQuestion",
                              "input": {}}]}},
    {"type": "attachment", "timestamp": _ts(minutes=70)},
    {"type": "user", "timestamp": _ts(minutes=100),
     "message": {"content": [{"type": "tool_result", "tool_use_id": "tu2", "content": "yes"}]}},
    {"type": "assistant", "timestamp": _ts(minutes=100, seconds=5),
     "message": {"content": [{"type": "text", "text": "ok"}]}},
    {"type": "assistant", "timestamp": _ts(minutes=130),
     "message": {"content": [{"type": "tool_use", "id": "tu3", "name": "Bash", "input": {}}]}},
]

# Every key the scan produced before fatigue existed; they must not change.
PRE_FATIGUE_KEYS = {
    "ai_title", "last_prompt", "last_reply", "now_label", "first_prompt",
    "prompt_count", "last_activity", "links", "folder", "per_day", "activity_ts",
    "errors", "timeline", "files", "model", "tok_output", "tok_input",
    "tok_cacheRead", "tok_cacheCreation", "cost",
}


class ScanCollectorTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        proj = os.path.join(self._tmp.name, "proj")
        os.makedirs(proj)
        self.path = os.path.join(proj, SID + ".jsonl")
        self._write(FIXTURE)

    def tearDown(self):
        with dashboard._scan_lock:
            dashboard._scan_cache.pop(self.path, None)
        self._tmp.cleanup()

    def _write(self, recs):
        with open(self.path, "w", encoding="utf-8") as f:
            f.write("\n".join(json.dumps(r) for r in recs) + "\n")

    def test_busy_spans_and_open_tool(self):
        agg = dashboard.scan_file(self.path)
        mins = [[round((s - BASE) / 60.0, 3), round((e - BASE) / 60.0, 3)]
                for s, e in agg["busy_spans"]]
        self.assertEqual(mins, [[-18720, -18720], [0, 50.5], [60, 60],
                                [100, 100.083], [130, 130]])
        self.assertEqual(agg["open_tool_since"], BASE + 130 * M)

    def test_real_prompt_closes_orphaned_tools(self):
        self._write(FIXTURE + [{"type": "user", "timestamp": _ts(minutes=140),
                                "message": {"content": "next task"}}])
        agg = dashboard._scan_file_uncached(self.path)
        self.assertIsNone(agg["open_tool_since"])
        # The orphan is dropped, never turned into a 10-min interval.
        self.assertEqual(agg["busy_spans"][-2:], [[BASE + 130 * M, BASE + 130 * M],
                                                  [BASE + 140 * M, BASE + 140 * M]])

    def test_existing_keys_are_unchanged(self):
        agg = dashboard._scan_file_uncached(self.path)
        self.assertEqual(set(agg) - {"busy_spans", "open_tool_since"}, PRE_FATIGUE_KEYS)
        self.assertEqual(agg["prompt_count"], 2)
        self.assertEqual(agg["activity_ts"],
                         [BASE, BASE - 13 * 86400, BASE + 10, BASE + 3020,
                          BASE + 3600, BASE + 6005, BASE + 7800])
        self.assertEqual(sorted(agg["per_day"]), ["2026-09-08", "2026-09-21"])
        day = agg["per_day"]["2026-09-21"]
        self.assertEqual((day["prompts"], day["tools"], day["replies"]), (1, 3, 2))
        self.assertEqual(day["tools_by_name"], {"Bash": 2, "AskUserQuestion": 1})
        self.assertEqual(agg["per_day"]["2026-09-08"]["prompts"], 1)

    def test_turn_duration_is_clamped_not_dropped(self):
        recs = [{"type": "system", "subtype": "turn_duration", "durationMs": 30 * 3600 * 1000,
                 "timestamp": _ts(hours=10)},
                {"type": "system", "subtype": "turn_duration", "durationMs": True,
                 "timestamp": _ts(hours=20)}]
        self._write(recs)
        agg = dashboard._scan_file_uncached(self.path)
        self.assertEqual(agg["busy_spans"], [[BASE + 4 * H, BASE + 10 * H]])

    def test_spans_are_capped(self):
        recs = [{"type": "assistant", "timestamp": _ts(minutes=10 * i),
                 "message": {"content": [{"type": "text", "text": "x"}]}} for i in range(150)]
        self._write(recs)
        spans = dashboard._scan_file_uncached(self.path)["busy_spans"]
        self.assertEqual(len(spans), dashboard.FATIGUE_MAX_SPANS)
        self.assertEqual(spans[-1], [BASE + 1490 * M, BASE + 1490 * M])

    def test_unreadable_file_still_has_the_keys(self):
        agg = dashboard._scan_file_uncached(os.path.join(self._tmp.name, "missing.jsonl"))
        self.assertEqual((agg["busy_spans"], agg["open_tool_since"]), ([], None))


class PayloadWiringTests(unittest.TestCase):
    """s.creature.fatigue in the builders, and the config toggle."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        proj = os.path.join(self._tmp.name, "proj")
        os.makedirs(proj)
        self._orig = {k: getattr(dashboard, k) for k in
                      ("PROJECTS_DIR", "MEALS_PATH", "load_config", "get_live_agents",
                       "build_payload_memo")}
        dashboard.PROJECTS_DIR = self._tmp.name
        dashboard.MEALS_PATH = os.path.join(self._tmp.name, "meals.json")
        # A user prompt 70 min ago, then a tool that has been running for 40 min.
        now = time.time()
        iso = lambda t: datetime.fromtimestamp(t, tz=timezone.utc).isoformat()  # noqa: E731
        self.path = os.path.join(proj, SID + ".jsonl")
        with open(self.path, "w", encoding="utf-8") as f:
            f.write(json.dumps({"type": "user", "timestamp": iso(now - 70 * M),
                                "message": {"content": "build it"}}) + "\n")
            f.write(json.dumps({"type": "assistant", "timestamp": iso(now - 40 * M),
                                "message": {"content": [{"type": "tool_use", "id": "t1",
                                                         "name": "Bash", "input": {}}]}}) + "\n")

    def tearDown(self):
        for k, v in self._orig.items():
            setattr(dashboard, k, v)
        with dashboard._scan_lock:
            dashboard._scan_cache.pop(self.path, None)
        self._tmp.cleanup()

    def test_busy_interactive_session_with_an_open_tool_keeps_tiring(self):
        busy = dashboard.build_session({"sessionId": SID, "kind": "interactive",
                                        "status": "busy"}, meals={}, fatigue_on=True)
        idle = dashboard.build_session({"sessionId": SID, "kind": "interactive",
                                        "status": "idle"}, meals={}, fatigue_on=True)
        self.assertEqual(set(busy["creature"]["fatigue"]), KEYS)
        self.assertEqual(busy["creature"]["fatigue"]["phase"], "active")
        self.assertGreaterEqual(busy["creature"]["fatigue"]["loadMins"], 39)
        self.assertEqual(idle["creature"]["fatigue"]["phase"], "resting")
        self.assertEqual(idle["creature"]["fatigue"]["loadMins"], 0)

    def test_toggle_off_removes_the_key(self):
        s = dashboard.build_session({"sessionId": SID, "kind": "interactive",
                                     "status": "busy"}, fatigue_on=False)
        self.assertNotIn("fatigue", s["creature"])
        a = dashboard.build_archived_session(self.path, SID, fatigue_on=False)
        self.assertNotIn("fatigue", a["creature"])
        a = dashboard.build_archived_session(self.path, SID, meals={}, fatigue_on=True)
        self.assertEqual(set(a["creature"]["fatigue"]), KEYS)

    def test_build_payload_reads_the_toggle(self):
        dashboard.get_live_agents = lambda: ([], None)
        for on in (True, False):
            with self.subTest(creatureFatigue=on):
                dashboard.load_config = lambda: dict(dashboard.DEFAULT_CONFIG,
                                                     creatureFatigue=on)
                payload = dashboard.build_payload()
                self.assertIs(payload["config"]["creatureFatigue"], on)
                self.assertEqual(len(payload["sessions"]), 1)
                self.assertEqual("fatigue" in payload["sessions"][0]["creature"], on)

    def test_session_detail_carries_the_creature(self):
        dashboard.build_payload_memo = lambda: {"sessions": []}
        dashboard.load_config = lambda: dict(dashboard.DEFAULT_CONFIG)
        detail = dashboard.build_session_detail(SID)
        self.assertEqual(set(detail["creature"]["fatigue"]), KEYS)
        self.assertEqual(detail["creature"]["species"],
                         dashboard.creature_for(SID)["species"])
        dashboard.build_payload_memo = lambda: {"sessions": [
            {"sessionId": SID, "creature": {"species": 1, "fatigue": {"state": "tired"}}}]}
        self.assertEqual(dashboard.build_session_detail(SID)["creature"],
                         {"species": 1, "fatigue": {"state": "tired"}})


class PayloadMemoTests(unittest.TestCase):
    def setUp(self):
        self._build = dashboard.build_payload
        with dashboard._payload_memo_lock:
            self._saved = dict(dashboard._payload_memo)

    def tearDown(self):
        dashboard.build_payload = self._build
        with dashboard._payload_memo_lock:
            dashboard._payload_memo.clear()
            dashboard._payload_memo.update(self._saved)

    def test_invalidation_during_a_build_is_not_cached_as_fresh(self):
        def build():
            dashboard._invalidate_payload_memo()  # a meal lands mid-build
            return {"n": 1}
        dashboard._invalidate_payload_memo()
        dashboard.build_payload = build
        self.assertEqual(dashboard.build_payload_memo(), {"n": 1})
        self.assertEqual(dashboard._payload_memo["ts"], 0.0)

    def test_quiet_build_is_cached(self):
        dashboard._invalidate_payload_memo()
        dashboard.build_payload = lambda: {"n": 2}
        dashboard.build_payload_memo()
        self.assertGreater(dashboard._payload_memo["ts"], 0.0)
        dashboard.build_payload = lambda: {"n": 3}
        self.assertEqual(dashboard.build_payload_memo(), {"n": 2})


class UiSyncTests(unittest.TestCase):
    """index.html mirrors two fatigue constants; drift breaks the meter."""

    def test_fz_constants_in_index_html(self):
        with open(os.path.join(ROOT, "index.html"), encoding="utf-8") as f:
            lines = {ln.strip() for ln in f}
        for want in ("var FZ_SCALE_MINS = %d;" % (dashboard.FATIGUE_CERTAIN_SECS // 60),
                     "var FZ_TIRED_MINS = %d;" % (dashboard.FATIGUE_TIRED_SECS // 60)):
            self.assertTrue(want in lines, "index.html has no line %r" % want)


if __name__ == "__main__":
    unittest.main()
