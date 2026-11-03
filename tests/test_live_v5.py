"""Production draws the @3 ids with City Gen v5, and one line on the host rolls it back."""
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent


class LiveV5(unittest.TestCase):
    def test_compose_defaults_to_v5_and_the_host_can_override_it(self):
        compose = (ROOT / "backend" / "docker-compose.yml").read_text()
        self.assertIn("ARENA_WORLDGEN: ${ARENA_WORLDGEN:-v5}", compose)

    def test_the_generator_reads_it_for_the_live_version_only(self):
        src = (ROOT / "backend" / "src" / "worldgen" / "mod.rs").read_text()
        self.assertIn('version == 3 && std::env::var("ARENA_WORLDGEN").is_ok_and(|v| v == "v5")', src)
        arch = (ROOT / "backend" / "src" / "archipelago.rs").read_text()
        self.assertTrue(re.search(r"LIVE_V: \w+ = 3\b", arch))

    def test_the_migration_clears_only_positions(self):
        sql = (ROOT / "backend" / "migrations" / "0028_live_v5.sql").read_text()
        body = "\n".join(ln for ln in sql.splitlines() if not ln.startswith("--"))
        self.assertIn("WHERE parked_world LIKE '%@3'", body)
        self.assertIn("DELETE FROM hq_garage", body)
        self.assertEqual(len(re.findall(r"\b(DELETE FROM|DROP|UPDATE)\b", body)), 2)


if __name__ == "__main__":
    unittest.main()
