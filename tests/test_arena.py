"""Privacy-boundary tests for arena.build_payload.

The one job that matters here: only daily *counts* leave the machine, and no
tool name outside the built-in allowlist (an MCP name can carry an employer or
client) ever reaches the wire. Stdlib only. Run with:
    python3 -m unittest discover -s tests
"""
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


if __name__ == "__main__":
    unittest.main()
