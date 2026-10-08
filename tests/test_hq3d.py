"""HQ 2.0 Wave 0: the 3D HQ (games/hq3d.js) and its glue (ui/app/22-hq.js). The scene
needs WebGL, so this checks what can run headless: how a session maps to a crew
member (state, project, name), and that the page wires the view, the H key, the
header switch and the crew list. The scene module runs in node with stubs."""
import json
import os
import shutil
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import dashboard  # noqa: E402

SCRIPT = r"""
const fs = require('fs');
const window = {HQV: {}, matchMedia: () => ({matches: false})};
const document = {documentElement: {classList: {contains: () => false}}};
global.performance = {now: () => 0};
for (const f of process.argv.slice(2)) new Function('window', 'document', fs.readFileSync(f, 'utf8'))(window, document);
const H = window.HQV.hq3d, out = {};
out.states = ['working', 'needs', 'idle', 'stale', 'weird', undefined].map(s => H.crewState({status: s}));
out.proj = [H.projectOf({cwd: '/Users/me/code/claude-hq/', folder: '-Users-me-code-claude-hq'}),
            H.projectOf({folder: '-Users-me-fleet'}), H.projectOf({}), H.projectOf({folder: 'plain'})];
out.title = [H.titleOf({title: 'Fix the shinies'}), H.titleOf({title: 'Untitled session', name: '02d87ed7', cwd: '/x/analytics'}),
             H.titleOf({name: 'adapalokesh-15'})];
console.log(JSON.stringify(out));
"""


class HqWiring(unittest.TestCase):
    def setUp(self):
        self.html = dashboard.assemble_index()

    def test_view_tab_switch_and_container(self):
        self.assertIn('data-view="hq"', self.html)
        self.assertIn('id="hqModeBtn"', self.html)
        self.assertIn('id="hqView"', self.html)
        self.assertIn('id="hqCrew"', self.html)
        self.assertIn('if(typeof hqViewChanged==="function") hqViewChanged(v);', self.html)
        self.assertIn('e.key==="h"||e.key==="H"){ e.preventDefault(); hqToggle(); }', self.html)

    def test_mode_is_remembered_and_calm_opens_classic(self):
        self.assertIn('hqModePref()==="3d" && !hqCalm() && hqWebGL()', self.html)
        self.assertIn('hqModeSave("classic")', self.html)
        self.assertIn('hqModeSave("3d")', self.html)

    def test_scene_files_are_served(self):
        for name in ("engine.js", "hq3d.js", "hqlobby.js", "hqbase.js"):
            got = dashboard.game_file(name)
            self.assertIsNotNone(got, name)
            self.assertEqual(dashboard.game_cache_control(name), "no-store")

    def test_nothing_leaves_the_machine(self):
        for name in ("hq3d.js", "hqlobby.js", "hqbase.js"):
            with open(os.path.join(ROOT, "games", name), encoding="utf-8") as f:
                src = f.read()
            for bad in ("fetch(", "XMLHttpRequest", "WebSocket", "sendBeacon", "MP.send"):
                self.assertNotIn(bad, src, name + ": " + bad)

    def test_floors_link_up(self):
        # Base front door -> Lobby; Lobby lifts -> Mission Control, front door -> Base; Mission Control lift -> Lobby
        src = {n: open(os.path.join(ROOT, "games", n + ".js"), encoding="utf-8").read() for n in ("hq3d", "hqlobby", "hqbase")}
        self.assertIn('view: "@lobby"', src["hqbase"])
        self.assertIn('view: "@mission"', src["hqlobby"])
        self.assertIn('view: "@base"', src["hqlobby"])
        self.assertIn('view: "@lobby"', src["hq3d"])
        self.assertIn('["hq3d","hqlobby","hqbase"]', dashboard.assemble_index())


@unittest.skipUnless(shutil.which("node"), "node not installed")
class HqCrewMapping(unittest.TestCase):
    def test_mapping(self):
        r = subprocess.run(["node", "-", os.path.join(ROOT, "games", "engine.js"), os.path.join(ROOT, "games", "hq3d.js")],
                           input=SCRIPT, capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        o = json.loads(r.stdout)
        self.assertEqual(o["states"], ["working", "needs", "idle", "stale", "stale", "stale"])
        self.assertEqual(o["proj"], ["claude-hq", "fleet", "other", "plain"])
        self.assertEqual(o["title"], ["Fix the shinies", "analytics", "adapalokesh-15"])


if __name__ == "__main__":
    unittest.main()


class HqArenaBoundary(unittest.TestCase):
    """HQ 2.1: what an open HQ sends the Arena is allowlisted in arena.py, and the
    crew counts come from this process's own view of your sessions."""

    def setUp(self):
        import arena
        self.arena = arena
        self.sent = []
        self._saved = (arena._request, arena._authed)
        arena._authed = lambda: ("tok", "https://arena.test")
        arena._request = lambda m, url, token=None, body=None: (self.sent.append((m, url, body)) or (200, {}))

    def tearDown(self):
        self.arena._request, self.arena._authed = self._saved

    def test_only_open_look_and_counts_leave(self):
        self.arena.hq_update(open_=True, look={"paint": "#224466", "sign": "Mine", "cwd": "/Users/me", "title": "secret"},
                             crew={"working": 3, "needs": 1, "idle": 99, "sessionId": "x"})
        m, url, body = self.sent[-1]
        self.assertEqual((m, url), ("PUT", "https://arena.test/v1/hq/me"))
        self.assertEqual(body, {"open": True, "look": {"paint": "#224466", "sign": "Mine"},
                                "crew": {"working": 3, "needs": 1, "idle": 64}})

    def test_visit_validates_the_user_id(self):
        self.assertEqual(self.arena.hq_visit("../../v1/admin")[0], 400)
        self.arena.hq_visit("11111111-2222-3333-4444-555555555555")
        self.assertTrue(self.sent[-1][1].endswith("/v1/hq/11111111-2222-3333-4444-555555555555"))

    def test_crew_counts_are_three_numbers(self):
        c = dashboard.hq_crew_counts()
        self.assertEqual(set(c), {"working", "needs", "idle"})
        self.assertTrue(all(isinstance(v, int) for v in c.values()))


class ProgressBoundary(unittest.TestCase):
    def setUp(self):
        import arena
        self.arena = arena
        self.sent = []
        self._saved = (arena._request, arena._authed)
        arena._authed = lambda: ("tok", "https://arena.test")
        arena._request = lambda m, url, token=None, body=None: (self.sent.append((m, url, body)) or (200, {}))

    def tearDown(self):
        self.arena._request, self.arena._authed = self._saved

    def test_read_only_and_validated(self):
        self.arena.progress(); self.arena.leaderboards("kart", "meadow"); self.arena.profile("me")
        self.assertEqual([(m, u.split("arena.test")[1], b) for m, u, b in self.sent],
                         [("GET", "/v1/progress/me", None), ("GET", "/v1/leaderboards/kart?key=meadow", None),
                          ("GET", "/v1/profile/me", None)])
        self.assertEqual(self.arena.leaderboards("chess")[0], 400)
        self.assertEqual(self.arena.profile("../admin")[0], 400)
        self.arena.leaderboards("golf", "../../x")
        self.assertTrue(self.sent[-1][1].endswith("/v1/leaderboards/golf"))

    def test_page_has_card_and_boards(self):
        html = dashboard.assemble_index()
        for needle in ('id="tcardBack"', 'id="gbWrap"', 'id="hqMyCard"', "//@include" not in html and "function tcardOpen"):
            self.assertTrue(needle in html if isinstance(needle, str) else needle)
