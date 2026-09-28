"""The local meal ledger (meals.json): which session ate what.

It is written only after the Arena confirmed a snack, so it must be idempotent
by requestId across every session, atomic, private (0600) and bounded.
Stdlib only.
"""
import glob
import json
import os
import stat
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import dashboard  # noqa: E402

SID_A = "11111111-1111-4111-8111-111111111111"
SID_B = "22222222-2222-4222-8222-222222222222"
NOW = 1790000000.0


def rid(n):
    return "req-%016d" % n


class MealLedgerTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._path = dashboard.MEALS_PATH
        dashboard.MEALS_PATH = os.path.join(self._tmp.name, "meals.json")

    def tearDown(self):
        dashboard.MEALS_PATH = self._path
        self._tmp.cleanup()

    def _raw(self):
        with open(dashboard.MEALS_PATH, encoding="utf-8") as f:
            return json.load(f)

    def _write_raw(self, meals):
        with open(dashboard.MEALS_PATH, "w", encoding="utf-8") as f:
            f.write(json.dumps({"version": 1, "meals": meals}))

    def test_idempotent_by_request_id_across_sessions(self):
        first = dashboard.record_meal(rid(1), SID_A, "berry", NOW - 10, now=NOW)
        again = dashboard.record_meal(rid(1), SID_B, "bento", NOW - 5, now=NOW)
        self.assertEqual(again, first)
        self.assertEqual(self._raw()["meals"], [first])
        self.assertEqual(dashboard.load_meals(now=NOW), {SID_A: [(NOW - 10, "berry")]})

    def test_find_meal(self):
        self.assertIsNone(dashboard.find_meal(rid(1)))
        dashboard.record_meal(rid(1), SID_A, "riceball", time.time() - 5)
        self.assertEqual(dashboard.find_meal(rid(1))["sessionId"], SID_A)
        self.assertIsNone(dashboard.find_meal(rid(2)))

    def test_file_is_valid_private_json_with_no_temp_left(self):
        for i in range(3):
            dashboard.record_meal(rid(i), SID_A, "berry", NOW - i, now=NOW)
            data = self._raw()
            self.assertEqual(data["version"], 1)
            self.assertEqual(len(data["meals"]), i + 1)
            mode = stat.S_IMODE(os.stat(dashboard.MEALS_PATH).st_mode)
            self.assertEqual(mode, 0o600)
            self.assertEqual(glob.glob(os.path.join(self._tmp.name, ".meals-*.tmp")), [])
        self.assertEqual(set(data["meals"][0]), {"requestId", "sessionId", "kind", "at"})

    def test_failed_write_leaves_the_old_file_intact(self):
        dashboard.record_meal(rid(1), SID_A, "berry", NOW - 10, now=NOW)
        before = self._raw()
        with mock.patch("json.dump", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                dashboard.record_meal(rid(2), SID_A, "bento", NOW - 5, now=NOW)
        self.assertEqual(self._raw(), before)
        self.assertEqual(glob.glob(os.path.join(self._tmp.name, ".meals-*.tmp")), [])

    def test_missing_or_corrupt_file_reads_empty(self):
        self.assertEqual(dashboard.load_meals(now=NOW), {})
        with open(dashboard.MEALS_PATH, "w") as f:
            f.write("{not json")
        self.assertEqual(dashboard.load_meals(now=NOW), {})
        self._write_raw("nope")
        self.assertEqual(dashboard.load_meals(now=NOW), {})

    def test_invalid_entries_are_dropped(self):
        good = {"requestId": rid(1), "sessionId": SID_A, "kind": "berry", "at": NOW - 60}
        bad = [
            dict(good, requestId=rid(2), sessionId="../etc/passwd"),
            dict(good, requestId=rid(3), sessionId=SID_A + "\n"),
            dict(good, requestId=rid(4), kind="pizza"),
            dict(good, requestId=rid(5), kind=["berry"]),
            dict(good, requestId="short"),
            dict(good, requestId="has a space in it!!"),
            dict(good, requestId=rid(6), at=True),
            dict(good, requestId=rid(7), at="1790000000"),
            dict(good, requestId=rid(8), at=NOW - dashboard.MEALS_KEEP_SECS - 1),
            dict(good, requestId=rid(9), at=NOW + 61),
            "not a dict",
            # NaN and Infinity are valid for Python's json but must never reach the walk.
            dict(good, requestId=rid(10), at=float("nan")),
            dict(good, requestId=rid(11), at=float("inf")),
        ]
        self._write_raw([good] + bad)
        self.assertEqual(dashboard.load_meals(now=NOW), {SID_A: [(NOW - 60, "berry")]})

    def test_per_session_and_total_caps(self):
        entries = []
        for i in range(30):
            entries.append({"requestId": rid(i), "sessionId": SID_A, "kind": "berry",
                            "at": NOW - 1000 + i})
        self._write_raw(entries)
        dashboard.record_meal(rid(99), SID_A, "bento", NOW, now=NOW)
        meals = dashboard.load_meals(now=NOW)[SID_A]
        self.assertEqual(len(meals), dashboard.MEALS_PER_SID)
        self.assertEqual(meals[-1], (NOW, "bento"))      # the newest are kept
        self.assertEqual(meals[0], (NOW - 1000 + 11, "berry"))

        many = []
        for i in range(600):
            sid = "%08d-0000-4000-8000-000000000000" % i
            many.append({"requestId": rid(1000 + i), "sessionId": sid, "kind": "berry",
                         "at": NOW - 600 + i})
        self._write_raw(many)
        dashboard.record_meal(rid(5000), SID_B, "tonic", NOW, now=NOW)
        data = self._raw()["meals"]
        self.assertEqual(len(data), dashboard.MEALS_MAX)
        self.assertEqual(data[-1]["requestId"], rid(5000))
        self.assertEqual([m["at"] for m in data], sorted(m["at"] for m in data))

    def test_concurrent_records_both_land(self):
        start = threading.Barrier(2)

        def eat(i, sid):
            start.wait()
            dashboard.record_meal(rid(i), sid, "berry", NOW - i, now=NOW)

        ts = [threading.Thread(target=eat, args=(1, SID_A)),
              threading.Thread(target=eat, args=(2, SID_B))]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        self.assertEqual(sorted(m["requestId"] for m in self._raw()["meals"]),
                         [rid(1), rid(2)])


if __name__ == "__main__":
    unittest.main()
