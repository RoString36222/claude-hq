"""Achievement pop-ups behind a Settings switch, off by default (achievementToasts).

The key defaults to false in the page (CONFIG_DEFAULTS) and in dashboard-rs (default_config, tested there); Settings has
the switch with a hint, fills it from CONFIG and saves it. With it off, an unlock still lands in the event log (and in
every list), but checkCelebration shows no toast and no confetti; the transit achievements' toast and spoken line are
gated the same way (games/playjobs.js is covered in tests/test_play_jobs.py). Skipped without node where noted."""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")


def read(*p):
    with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
        return f.read()


def func(src, name):
    i = src.index("function " + name + "(")
    j = src.index("{", i)
    d = 0
    for k in range(j, len(src)):
        d += {"{": 1, "}": -1}.get(src[k], 0)
        if d == 0:
            return src[i:k + 1]
    raise AssertionError(name)


SCRIPT = r"""
var CONFIG, CELEB_READY = false, PREV_LEVEL = null, PREV_ACH = {}, seen = [];
function toast(t, k){ seen.push("toast:" + t); }
function confettiBurst(){ seen.push("confetti"); }
function logEvent(i, t){ seen.push("log:" + t); }
%(src)s
var S0 = {level: 1, achievements: [{id: "a", name: "First", unlocked: false}]};
var S1 = {level: 1, achievements: [{id: "a", name: "First", unlocked: true}]};
var out = {};
CONFIG = {achievementToasts: false}; checkCelebration(S0); checkCelebration(S1); out.off = seen; seen = [];
CELEB_READY = false; PREV_ACH = {}; CONFIG = {}; checkCelebration(S0); checkCelebration(S1); out.unset = seen; seen = [];
CELEB_READY = false; PREV_ACH = {}; CONFIG = {achievementToasts: true}; checkCelebration(S0); checkCelebration(S1); out.on = seen;
console.log(JSON.stringify(out));
"""


class AchievementToasts(unittest.TestCase):
    def test_default_off_in_the_page(self):
        m = re.search(r"var CONFIG_DEFAULTS = \{([^}]*)\}", read("ui", "app", "01-creatures.js"))
        self.assertIn("achievementToasts:false", m.group(1))

    def test_settings_switch_fills_and_saves(self):
        html = read("index.html")
        self.assertIn('id="setAchToasts"', html)
        self.assertIn('id="setAchToastsHint"', html)
        self.assertIn('aria-describedby="setAchToastsHint"', html)
        src = read("ui", "app", "16-settings.js")
        self.assertIn('at.checked = c.achievementToasts===true', src)
        self.assertIn('body.achievementToasts=!!$("setAchToasts").checked', src)

    def test_transit_toast_and_announce_are_gated(self):
        src = read("games", "hqtransit.js")
        line = [l for l in src.splitlines() if "achievements.onUnlock(" in l]
        self.assertEqual(len(line), 1)
        self.assertIn("a.name && achToasts()", line[0])
        self.assertIn("C.achievementToasts === true", func(src, "achToasts"))

    def test_playjobs_line_is_gated(self):
        src = read("games", "playjobs.js")
        self.assertIn('if(achToasts()) after.forEach(function(a, i){ if(a.done && !before[i].done) say("Achievement: "', src)

    @unittest.skipUnless(NODE, "node not installed")
    def test_check_celebration(self):
        ov = read("ui", "app", "14-overlays.js")
        src = func(ov, "achToastsOn") + "\n" + func(ov, "checkCelebration")
        r = subprocess.run([NODE, "-e", SCRIPT % {"src": src}], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        o = json.loads(r.stdout.strip().splitlines()[-1])
        self.assertEqual(o["off"], ["log:Achievement unlocked: First"])
        self.assertEqual(o["unset"], ["log:Achievement unlocked: First"])
        self.assertEqual(o["on"], ["toast:🏅 Achievement: First", "confetti", "log:Achievement unlocked: First"])


if __name__ == "__main__":
    unittest.main()
