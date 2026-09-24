"""Unit tests for the cost model and config validation in dashboard.py.

Stdlib only (unittest), to keep Claude HQ's "no pip install" promise. Run with:
    python3 -m unittest discover -s tests
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import dashboard  # noqa: E402


class PriceForTests(unittest.TestCase):
    def test_known_models_match_by_substring(self):
        self.assertEqual(dashboard._price_for("claude-opus-4-8"), (15.0, 75.0))
        self.assertEqual(dashboard._price_for("claude-sonnet-5"), (3.0, 15.0))
        self.assertEqual(dashboard._price_for("claude-haiku-4-5"), (0.8, 4.0))
        self.assertEqual(dashboard._price_for("some-fable-thing"), (15.0, 75.0))

    def test_unknown_and_empty_fall_back_to_sonnet(self):
        self.assertEqual(dashboard._price_for("gpt-4o"), (3.0, 15.0))
        self.assertEqual(dashboard._price_for(""), (3.0, 15.0))
        self.assertEqual(dashboard._price_for(None), (3.0, 15.0))

    def test_matches_are_case_insensitive(self):
        self.assertEqual(dashboard._price_for("CLAUDE-OPUS"), (15.0, 75.0))


class UsageCostTests(unittest.TestCase):
    def test_non_dict_usage_is_zeroed(self):
        self.assertEqual(dashboard._usage_cost("opus", None), (0.0, 0, 0, 0, 0))
        self.assertEqual(dashboard._usage_cost("opus", "nope"), (0.0, 0, 0, 0, 0))

    def test_plain_input_output_cost(self):
        # 1e6 input @ $15 + 1e6 output @ $75 = $90 on opus pricing.
        cost, out, inp, cr, cc = dashboard._usage_cost(
            "opus", {"input_tokens": 1_000_000, "output_tokens": 1_000_000})
        self.assertAlmostEqual(cost, 90.0, places=6)
        self.assertEqual((out, inp, cr, cc), (1_000_000, 1_000_000, 0, 0))

    def test_cache_read_is_ten_percent_and_creation_is_125_percent(self):
        # cache_read @ 10% of input price, cache_creation @ 125% of input price.
        cost, *_ = dashboard._usage_cost(
            "sonnet", {"cache_read_input_tokens": 1_000_000,
                       "cache_creation_input_tokens": 1_000_000})
        # 1e6 * 3 * 0.1 + 1e6 * 3 * 1.25 = 0.3 + 3.75 = 4.05
        self.assertAlmostEqual(cost, 4.05, places=6)

    def test_missing_fields_default_to_zero(self):
        cost, out, inp, cr, cc = dashboard._usage_cost("haiku", {})
        self.assertEqual((cost, out, inp, cr, cc), (0.0, 0, 0, 0, 0))


class ValidateConfigTests(unittest.TestCase):
    def test_defaults_returned_for_garbage(self):
        self.assertEqual(dashboard._validate_config("not a dict"),
                         dict(dashboard.DEFAULT_CONFIG))
        self.assertEqual(dashboard._validate_config({}),
                         dict(dashboard.DEFAULT_CONFIG))

    def test_theme_and_pack_allowlisted(self):
        cfg = dashboard._validate_config({"theme": "forest", "creaturePack": "animals"})
        self.assertEqual(cfg["theme"], "forest")
        self.assertEqual(cfg["creaturePack"], "animals")
        # Unknown values fall back to the default, not the raw value.
        cfg = dashboard._validate_config({"theme": "neon", "creaturePack": "dragons"})
        self.assertEqual(cfg["theme"], dashboard.DEFAULT_CONFIG["theme"])
        self.assertEqual(cfg["creaturePack"], dashboard.DEFAULT_CONFIG["creaturePack"])

    def test_numeric_ranges_clamped_by_rejection(self):
        # Out-of-range values are ignored (keep the base), in-range accepted.
        base = dict(dashboard.DEFAULT_CONFIG)
        cfg = dashboard._validate_config({"refreshMs": 999, "stuckMinutes": 999,
                                          "dailyBudgetUSD": -5}, base=base)
        self.assertEqual(cfg["refreshMs"], base["refreshMs"])
        self.assertEqual(cfg["stuckMinutes"], base["stuckMinutes"])
        self.assertEqual(cfg["dailyBudgetUSD"], base["dailyBudgetUSD"])
        cfg = dashboard._validate_config({"refreshMs": 3000, "stuckMinutes": 30,
                                          "dailyBudgetUSD": 12.5})
        self.assertEqual(cfg["refreshMs"], 3000)
        self.assertEqual(cfg["stuckMinutes"], 30)
        self.assertEqual(cfg["dailyBudgetUSD"], 12.5)

    def test_trainer_name_sanitised(self):
        cfg = dashboard._validate_config({"trainerName": "  Swastik \x07  Tripathi  "})
        self.assertEqual(cfg["trainerName"], "Swastik Tripathi")
        cfg = dashboard._validate_config({"trainerName": "x" * 50})
        self.assertEqual(len(cfg["trainerName"]), 32)
        # Non-string is ignored.
        cfg = dashboard._validate_config({"trainerName": 123})
        self.assertEqual(cfg["trainerName"], dashboard.DEFAULT_CONFIG["trainerName"])

    def test_arena_url_requires_http_scheme(self):
        cfg = dashboard._validate_config({"arenaUrl": "https://example.fly.dev"})
        self.assertEqual(cfg["arenaUrl"], "https://example.fly.dev")
        # Non-http(s) is dropped so it can't become an outbound target.
        cfg = dashboard._validate_config({"arenaUrl": "file:///etc/passwd"})
        self.assertEqual(cfg["arenaUrl"], "")
        cfg = dashboard._validate_config({"arenaUrl": "javascript:alert(1)"})
        self.assertEqual(cfg["arenaUrl"], "")

    def test_arena_flags_coerced_to_bool(self):
        cfg = dashboard._validate_config({"arenaEnabled": 1, "arenaShareCost": ""})
        self.assertIs(cfg["arenaEnabled"], True)
        self.assertIs(cfg["arenaShareCost"], False)


if __name__ == "__main__":
    unittest.main()
