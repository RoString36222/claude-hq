"""Privacy-boundary tests for arena.build_payload.

The one job that matters here: only daily *counts* leave the machine, and no
tool name outside the built-in allowlist (an MCP name can carry an employer or
client) ever reaches the wire. Stdlib only. Run with:
    python3 -m unittest discover -s tests
"""
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import arena  # noqa: E402

# Any key that must never appear anywhere in a published payload.
FORBIDDEN_KEYS = {
    "prompt", "prompts_text", "reply", "text", "content", "path", "paths",
    "cwd", "folder", "project", "projectName", "sessionId", "sessionTitle",
    "title", "file", "files",
}

# Local creature-fatigue and meal-ledger state: never in the stats payload.
# (requestId legitimately goes to the pantry routes, never to /v1/stats.)
LOCAL_ONLY_KEYS = {"fatigue", "busy_spans", "open_tool_since", "meals", "lastMeal",
                   "requestId"}


def _collect_keys(obj):
    keys = set()
    if isinstance(obj, dict):
        for k, v in obj.items():
            keys.add(k)
            keys |= _collect_keys(v)
    elif isinstance(obj, list):
        for v in obj:
            keys |= _collect_keys(v)
    return keys


class BuildPayloadTests(unittest.TestCase):
    def setUp(self):
        self._orig_scan = arena._scan_file
        self._tmp = tempfile.TemporaryDirectory()
        # build_payload globs <projects>/*/*.jsonl, so give it one file to find.
        proj = os.path.join(self._tmp.name, "some-project")
        os.makedirs(proj)
        self._jsonl = os.path.join(proj, "session.jsonl")
        open(self._jsonl, "w").close()
        today = datetime.now(timezone.utc).date().isoformat()
        # A synthetic day with a built-in tool AND an MCP tool that must bucket.
        self._synthetic = {
            "per_day": {
                today: {
                    "prompts": 3, "tools": 10, "artifacts": 1, "replies": 3,
                    "input": 100, "output": 200, "cacheRead": 50,
                    "cacheCreation": 25, "cost": 1.2345,
                    "tools_by_name": {"Bash": 6, "mcp__acme_corp__deploy": 4},
                }
            }
        }
        arena._scan_file = lambda path: self._synthetic

    def tearDown(self):
        arena._scan_file = self._orig_scan
        self._tmp.cleanup()

    def test_mcp_tool_names_are_bucketed_to_other(self):
        payload = arena.build_payload(self._tmp.name)
        names = {t["name"] for d in payload["days"] for t in d["toolBreakdown"]}
        self.assertIn("Bash", names)
        self.assertIn("Other", names)
        self.assertNotIn("mcp__acme_corp__deploy", names)

    def test_no_forbidden_keys_anywhere_in_payload(self):
        payload = arena.build_payload(self._tmp.name)
        leaked = _collect_keys(payload) & FORBIDDEN_KEYS
        self.assertEqual(leaked, set(), "payload leaked keys: %s" % leaked)

    def test_no_raw_mcp_string_anywhere_in_payload(self):
        import json
        blob = json.dumps(arena.build_payload(self._tmp.name))
        self.assertNotIn("acme_corp", blob)

    def test_cost_is_opt_in(self):
        without = arena.build_payload(self._tmp.name, share_cost=False)
        self.assertNotIn("costUSD", without["days"][0])
        with_cost = arena.build_payload(self._tmp.name, share_cost=True)
        self.assertIn("costUSD", with_cost["days"][0])
        self.assertAlmostEqual(with_cost["days"][0]["costUSD"], 1.2345, places=4)

    def test_counts_pass_through(self):
        day = arena.build_payload(self._tmp.name)["days"][0]
        self.assertEqual(day["prompts"], 3)
        self.assertEqual(day["tools"], 10)
        self.assertEqual(day["artifacts"], 1)
        self.assertEqual(day["tokens"]["output"], 200)

    def test_trainer_name_passthrough(self):
        payload = arena.build_payload(self._tmp.name, trainer_name="Ash")
        self.assertEqual(payload["trainerName"], "Ash")

    def test_fatigue_inputs_never_reach_the_stats_payload(self):
        # The scan aggregate carries the creature-fatigue inputs; they are local.
        self._synthetic["busy_spans"] = [[1790000000.0, 1790003600.0]]
        self._synthetic["open_tool_since"] = 1790003000.0
        payload = arena.build_payload(self._tmp.name)
        leaked = _collect_keys(payload) & (FORBIDDEN_KEYS | LOCAL_ONLY_KEYS)
        self.assertEqual(leaked, set(), "payload leaked keys: %s" % leaked)
        self.assertNotIn("1790003600", json.dumps(payload))


class PantryWireTests(unittest.TestCase):
    """arena.pantry is the privacy boundary for coins, food and gifts: whatever
    the caller passes, only the allowlisted fields go out."""

    def setUp(self):
        self._req = arena._request
        self._link = arena.load_link
        self._cfg = arena._load_config
        arena.load_link = lambda: {"token": "T", "url": "https://arena.example"}
        arena._load_config = lambda: {}
        self.sent = []
        arena._request = lambda method, url, token=None, body=None: (
            self.sent.append(body) or (200, {}))

    def tearDown(self):
        arena._request = self._req
        arena.load_link = self._link
        arena._load_config = self._cfg

    def test_no_forbidden_or_local_keys_on_the_wire(self):
        leaky = {k: "x" for k in FORBIDDEN_KEYS | LOCAL_ONLY_KEYS}
        leaky.update({"requestId": "a" * 16, "kind": "berry", "qty": 1, "coins": 1,
                      "toHandle": "gary", "note": "hi"})
        for action in arena.PANTRY_ACTIONS:
            arena.pantry(action, leaky)
        self.assertEqual(len(self.sent), len(arena.PANTRY_ACTIONS))
        for body in self.sent:
            self.assertEqual(
                _collect_keys(body) & (FORBIDDEN_KEYS | (LOCAL_ONLY_KEYS - {"requestId"})), set())
            self.assertLessEqual(set(body), set(arena._PANTRY_KEYS))


if __name__ == "__main__":
    unittest.main()
