"""Flexible streak (dashboard.flex_streak): a streak survives missed days as long
as no 7-day stretch inside it has more than 2 of them; today is never a miss
while in progress. Also checks the Arena server's copy agrees on random data."""
import importlib.util
import os
import random
import sys
import unittest
from datetime import date, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import dashboard  # noqa: E402

T = date(2026, 10, 6)


def days(*offsets):
    return {T - timedelta(days=o) for o in offsets}


class FlexStreakTests(unittest.TestCase):
    def s(self, active, end=T):
        return dashboard.flex_streak(active, end)

    def test_consecutive(self):
        self.assertEqual(self.s(days(0, 1, 2, 3)), 4)

    def test_today_in_progress_is_not_a_miss(self):
        self.assertEqual(self.s(days(1, 2, 3)), 3)

    def test_one_missed_day_does_not_reset(self):
        # active today, yesterday, 2 days ago; missed 3 days ago; active 4..9 days ago
        self.assertEqual(self.s(days(0, 1, 2, 4, 5, 6, 7, 8, 9)), 10)

    def test_two_misses_in_a_week_survive_three_break(self):
        self.assertEqual(self.s(days(0, 2, 4, 5, 6, 7)), 8)          # misses 1, 3
        self.assertEqual(self.s(days(0, 2, 4, 6, 7, 8, 9)), 5)       # misses 1,3,5 in one week -> only 0..4
        self.assertEqual(self.s(set()), 0)

    def test_users_real_pattern(self):
        # Sep 23-25 active, 26-27 missed, Sep 28 - Oct 2 active, Oct 3 missed, Oct 4-6 active
        active = {date(2026, 9, 23) + timedelta(days=i) for i in range(14)} - {date(2026, 9, 26), date(2026, 9, 27), date(2026, 10, 3)}
        self.assertEqual(self.s(active), 14)

    def test_long_gap_ends_it(self):
        self.assertEqual(self.s(days(0, 1, 5, 6, 7)), 2)             # 2,3,4 missed: 3 in a week


def _load_backend_scoring():
    spec = importlib.util.spec_from_file_location("arena_scoring", os.path.join(ROOT, "backend", "app", "scoring.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class ArenaParityTests(unittest.TestCase):
    def test_server_agrees_on_random_histories(self):
        scoring = _load_backend_scoring()
        rnd = random.Random(7)
        for _ in range(400):
            p = rnd.choice([0.5, 0.7, 0.85, 0.95])
            active = {T - timedelta(days=i) for i in range(60) if rnd.random() < p}
            self.assertEqual(dashboard.flex_streak(active, T), scoring.streak_from_dates(active, T), sorted(active))


if __name__ == "__main__":
    unittest.main()
