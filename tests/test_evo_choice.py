"""Evolution picks kept by the server (POST /api/evo-choice -> evo-choices.json ->
creature.evo in /api/sessions), so the notch and other browsers see them. This checks
the page's side; the server's is tested in dashboard-rs."""
import os
import unittest


class PageWiring(unittest.TestCase):
    def test_page_posts_and_seeds(self):
        here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        with open(os.path.join(here, "ui", "app", "12-pokedex.js"), encoding="utf-8") as f:
            dex = f.read()
        with open(os.path.join(here, "ui", "app", "09-drawer.js"), encoding="utf-8") as f:
            drawer = f.read()
        self.assertIn("evoChoicePost(sid, patch);", dex)
        self.assertIn('fetch("/api/evo-choice",{method:"POST"', dex)
        self.assertIn("evoSeedFromServer(STATE.sessions);", drawer)


if __name__ == "__main__":
    unittest.main()
