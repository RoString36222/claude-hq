"""Village pack: original art only (issue #50) and the Village view bugs.

Static checks on index.html, plus (when `node` is on PATH) a run of the pure
Village helpers extracted from index.html, plus the backend `projectSlug`
field the Workshop Quarter uses to open /api/project. Stdlib only. Run with:
    python3 -m unittest discover -s tests
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import dashboard  # noqa: E402

SID = "11111111-1111-4111-8111-111111111111"


def _html():
    with open(os.path.join(ROOT, "index.html"), encoding="utf-8") as f:
        return f.read()


def _func_src(html, name):
    """Source of `function name(...){...}` from index.html (brace-matched)."""
    m = re.search(r"function %s\(" % re.escape(name), html)
    if not m:
        raise AssertionError("index.html has no function %s" % name)
    i = html.index("{", m.end())
    depth = 0
    for j in range(i, len(html)):
        c = html[j]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return html[m.start():j + 1]
    raise AssertionError("unbalanced braces in %s" % name)


class NoThirdPartyTroopArtTests(unittest.TestCase):
    """IP rule: the Village pack renders only the locally drawn troopSVG."""

    def setUp(self):
        self.html = _html()
        self.low = self.html.lower()

    def test_no_supercell_or_clash_cdn_hosts(self):
        for host in ("supercell", "clashofclans", "clash-of-clans", "chiefpansancolt"):
            self.assertNotIn(host, self.low, "index.html still references %r" % host)

    def test_hotlink_machinery_is_gone(self):
        for ident in ("TROOP_CDN", "TROOP_SLUGS", "TROOP_LABELS", "TROOP_MAXLVL",
                      "troopErr", "troopImgHTML", "troopImgURL", "troopPreload",
                      "troopLabel", "dedupeTroopDex"):
            self.assertIsNone(re.search(r"\b%s\b" % ident, self.html),
                              "index.html still has %s" % ident)

    def test_no_real_troop_names(self):
        for name in ("Barbarian", "Hog Rider", "P.E.K.K.A", "Valkyrie", "Lava Hound",
                     "Wall Breaker", "Electro Dragon", "Apprentice Warden"):
            self.assertNotIn(name, self.html)

    def test_pack_option_label_is_original(self):
        m = re.search(r'<option value="village">([^<]*)</option>', self.html)
        self.assertIsNotNone(m)
        self.assertNotIn("clash", m.group(1).lower())

    def test_village_buildings_have_original_names(self):
        for old in ("Town Hall", "Army Camp", "Builder Base", "War Log", "XP to TH "):
            self.assertNotIn(old, self.html)
        for new in ("Citadel", "Muster Grounds", "Workshop Quarter"):
            self.assertIn(new, self.html)

    def test_troop_visual_draws_svg(self):
        src = _func_src(self.html, "troopVisual")
        self.assertIn("troopSVG(", src)
        self.assertNotIn("<img", src)

    def test_village_resources_are_not_spend_based(self):
        for fn in ("renderVillage", "villageResources"):
            self.assertNotIn("estCostUSD", _func_src(self.html, fn))
        self.assertNotIn('id="vilGold"', self.html)
        self.assertIn('id="vilOre"', self.html)


class VillageViewBugTests(unittest.TestCase):
    def setUp(self):
        self.html = _html()

    def test_view_restore_allowlist_is_view_titles(self):
        m = re.search(r"var VIEW = \(function\(\)\{.*?\}\)\(\);", self.html, re.S)
        self.assertIsNotNone(m)
        self.assertIn("hasOwnProperty.call(VIEW_TITLES", m.group(0))
        # VIEW_TITLES must be assigned before the IIFE reads it.
        self.assertLess(self.html.index("var VIEW_TITLES = {"), m.start())
        titles = self.html[self.html.index("var VIEW_TITLES = {"):m.start()]
        for v in ("village:", "store:", "live:"):
            self.assertIn(v, titles)

    def test_battle_log_converts_ms_to_iso(self):
        src = _func_src(self.html, "renderVillage")
        self.assertIn("relTime(eventIso(e.t))", src)
        self.assertNotIn("relTime(e.t)", src)

    def test_workshop_opens_project_by_slug(self):
        src = _func_src(self.html, "renderVillage")
        self.assertIn("openProject(b.slug)", src)
        self.assertNotIn("openProject(b.f)", src)


@unittest.skipUnless(shutil.which("node"), "node not installed")
class VillageHelpersJsTests(unittest.TestCase):
    """Run the pure helpers from index.html under node."""

    def _run(self, body, calm=False):
        html = _html()
        names = ("looksLikeSlug", "villageResources", "villageProjectSlug", "eventIso",
                 "troopRankName", "troopSVG")
        js = ['var TROOP_LEVELS=["Recruit","Fighter","Veteran","Champion","Warlord"];',
              "function calmMode(){ return %s; }" % ("true" if calm else "false")]
        js += [_func_src(html, n) for n in names]
        js.append("console.log(JSON.stringify((function(){ %s })()));" % body)
        out = subprocess.run(["node", "-e", "\n".join(js)], capture_output=True,
                             text=True, timeout=30)
        self.assertEqual(out.returncode, 0, out.stderr)
        return json.loads(out.stdout)

    def test_village_resources_from_activity(self):
        r = self._run('return villageResources({totals:{tools:42,prompts:7}},'
                      '[{tokens:{output:100,estCostUSD:99}},{tokens:{output:5}},{}]);')
        self.assertEqual(r, {"ore": 42, "mana": 105, "ember": 7})
        self.assertEqual(self._run("return villageResources(null, null);"),
                         {"ore": 0, "mana": 0, "ember": 0})

    def test_project_slug_prefers_transcript_dir(self):
        r = self._run('return [villageProjectSlug({folder:"repo",projectSlug:"-Users-me-repo"}),'
                      'villageProjectSlug({folder:"-Users-me-old"}),'
                      'villageProjectSlug({folder:"repo"}), villageProjectSlug(null)];')
        self.assertEqual(r, ["-Users-me-repo", "-Users-me-old", "", ""])

    def test_event_iso(self):
        r = self._run('return [eventIso(0), eventIso(1700000000000), eventIso(null), eventIso("x")];')
        self.assertEqual(r, ["1970-01-01T00:00:00.000Z", "2023-11-14T22:13:20.000Z", "", ""])

    def test_rank_names(self):
        self.assertEqual(self._run("return [troopRankName(0), troopRankName(9)];"),
                         ["Lv 1 · Recruit", "Lv 5 · Warlord"])

    def test_troop_svg_stills_in_calm_mode(self):
        moving = self._run('return troopSVG(1, 30, "caster", 4, true, 46);')
        still = self._run('return troopSVG(1, 30, "caster", 4, true, 46);', calm=True)
        self.assertIn("<animate", moving)
        self.assertNotIn("<animate", still)
        self.assertNotIn("<img", moving)


class ProjectSlugPayloadTests(unittest.TestCase):
    """Live sessions expose the /api/project slug, not just the cwd basename."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.slug = "-Users-me-work-repo"
        proj = os.path.join(self._tmp.name, self.slug)
        os.makedirs(proj)
        self._orig = {k: getattr(dashboard, k) for k in ("PROJECTS_DIR", "MEALS_PATH")}
        dashboard.PROJECTS_DIR = self._tmp.name
        dashboard.MEALS_PATH = os.path.join(self._tmp.name, "meals.json")
        self.path = os.path.join(proj, SID + ".jsonl")
        iso = datetime.fromtimestamp(time.time() - 60, tz=timezone.utc).isoformat()
        with open(self.path, "w", encoding="utf-8") as f:
            f.write(json.dumps({"type": "user", "timestamp": iso,
                                "message": {"content": "hi"}}) + "\n")

    def tearDown(self):
        for k, v in self._orig.items():
            setattr(dashboard, k, v)
        with dashboard._scan_lock:
            dashboard._scan_cache.pop(self.path, None)
        self._tmp.cleanup()

    def test_build_session_carries_project_slug(self):
        s = dashboard.build_session({"sessionId": SID, "kind": "interactive",
                                     "status": "idle", "cwd": "/Users/me/work/repo"},
                                    meals={}, fatigue_on=False)
        self.assertEqual(s["folder"], "repo")
        self.assertEqual(s["projectSlug"], self.slug)
        self.assertIsNotNone(dashboard.compute_project(s["projectSlug"]))
        self.assertIsNone(dashboard.compute_project(s["folder"]))

    def test_missing_transcript_gives_empty_slug(self):
        s = dashboard.build_session({"sessionId": "22222222-2222-4222-8222-222222222222",
                                     "kind": "interactive", "status": "idle"},
                                    meals={}, fatigue_on=False)
        self.assertEqual(s["projectSlug"], "")


if __name__ == "__main__":
    unittest.main()
