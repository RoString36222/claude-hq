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
        for name in ("engine.js", "hq3d.js"):
            got = dashboard.game_file(name)
            self.assertIsNotNone(got, name)
            self.assertEqual(dashboard.game_cache_control(name), "no-store")

    def test_nothing_leaves_the_machine(self):
        with open(os.path.join(ROOT, "games", "hq3d.js"), encoding="utf-8") as f:
            src = f.read()
        for bad in ("fetch(", "XMLHttpRequest", "WebSocket", "sendBeacon", "MP.send"):
            self.assertNotIn(bad, src, bad)


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
