"""Story campaign (games/story.js): the STORY-MAPS block, chapter shape and house rules.

The Rust side (backend-rs/src/story_check.rs) runs the same block through the Arena's real
validators; this file checks what Python can see without the Arena.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tests"))
from test_arena import FORBIDDEN_KEYS, _collect_keys  # noqa: E402

STORY = os.path.join(ROOT, "games", "story.js")
NOTES = {"td-wave", "td-clear", "bowl-strike", "bowl-game", "make-save", "make-publish", "race-custom"}
BEGIN, END = "/* STORY-MAPS BEGIN */", "/* STORY-MAPS END */"


def src():
    with open(STORY, encoding="utf-8") as f:
        return f.read()


def story_maps(text=None):
    text = src() if text is None else text
    a = text.index(BEGIN) + len(BEGIN)
    b = text.index(END, a)
    return json.loads(text[a:b])


class StoryMapsTests(unittest.TestCase):
    def test_block_is_one_pure_json_array(self):
        s = src()
        self.assertEqual(s.count(BEGIN), 1)
        self.assertEqual(s.count(END), 1)
        self.assertIsInstance(story_maps(s), list)

    def test_three_kart_tracks_and_two_plat_levels(self):
        maps = story_maps()
        self.assertEqual([d["kind"] for d in maps].count("kart"), 3)
        self.assertEqual([d["kind"] for d in maps].count("plat"), 2)

    def test_mapdoc_shape(self):
        names = set()
        for d in story_maps():
            self.assertEqual(list(d), ["kind", "v", "name", "data"])
            self.assertEqual(d["v"], 1)
            n = d["name"]
            self.assertTrue(1 <= len(n) <= 32 and n == n.strip(), n)
            self.assertNotRegex(n, r"[<>]|(?i:http)")
            self.assertNotIn(n, names)
            names.add(n)
            self.assertLessEqual(len(json.dumps(d["data"], separators=(",", ":"))), 12 * 1024)
            if d["kind"] == "kart":
                data = d["data"]
                self.assertEqual(list(data), ["tiles", "scenery", "theme"])
                self.assertRegex(data["tiles"], r"^F[FSLR]{7,79}$")
                self.assertIn(data["scenery"], ("forest", "tents", "empty"))
                self.assertEqual(list(data["theme"]), ["sky", "fog", "ground"])
            else:
                self.assertEqual(list(d["data"]), ["kill", "coopGoal", "coopSecs", "theme", "spawns", "cps",
                                                   "flag", "coins", "solids", "route", "deco"])
            for c in re.findall(r'"#[0-9A-Fa-f]{6}"', json.dumps(d["data"])):
                self.assertEqual(c, c.lower())

    def test_kart_loops_close_without_reusing_a_cell(self):
        step = [(0, 1), (1, 0), (0, -1), (-1, 0)]
        for d in story_maps():
            if d["kind"] != "kart":
                continue
            x = z = h = 0
            seen = set()
            for ch in d["data"]["tiles"]:
                self.assertNotIn((x, z), seen, d["name"])
                seen.add((x, z))
                h = (h + (1 if ch == "R" else -1 if ch == "L" else 0)) % 4
                x, z = x + step[h][0], z + step[h][1]
            self.assertEqual((x, z, h), (0, 0, 0), d["name"])
            self.assertTrue(d["data"]["tiles"].endswith("SS"), "the grid sits on the last tile")

    def test_no_forbidden_keys_on_the_wire(self):
        # a story MapDoc is what goes over the kart/plat custom start op
        self.assertEqual(_collect_keys(story_maps()) & FORBIDDEN_KEYS, set())


class StoryChapterTests(unittest.TestCase):
    def test_chapter_ids_unique_and_six(self):
        ids = re.findall(r'\{id:"(c\d+)", name:', src())
        self.assertEqual(len(ids), 6)
        self.assertEqual(len(set(ids)), 6)

    def test_note_names_come_from_the_global_list(self):
        s = src()
        listed = re.search(r"var NOTES = \[([^\]]*)\]", s).group(1)
        self.assertEqual(set(re.findall(r'"([a-z-]+)"', listed)), NOTES)
        used = set(re.findall(r'ev:"([a-z-]+)"', s))
        self.assertTrue(used)
        self.assertLessEqual(used, NOTES)

    def test_every_chapter_has_three_to_five_goals(self):
        s = src()
        blocks = re.split(r'\n \{id:"c\d+"', s.split("var CHAPTERS = [", 1)[1].split("\n];", 1)[0])[1:]
        self.assertEqual(len(blocks), 6)
        for b in blocks:
            goals = b.split("goals:[", 1)[1].split("unlocks:[", 1)[0]
            self.assertTrue(3 <= len(re.findall(r"\{k:\"", goals)) <= 5, goals)

    def test_map_unlocks_point_at_real_maps(self):
        s = src()
        idx = [int(i) for i in re.findall(r"\{map:(\d+)\}", s)]
        self.assertEqual(sorted(idx), list(range(len(story_maps()))))

    def test_forbidden_strings_and_house_rules(self):
        s = src()
        for bad in ("http://", "https://", "innerHTML", "eval(", "Math.random"):
            self.assertNotIn(bad, s)
        self.assertNotIn("pantry/reward", s)    # the story never grants coins
        self.assertIn("api.calm()", s)          # typewriter off under calm
        self.assertIn('aria-live', s)

    def test_story_is_in_valley_files_when_the_scaffold_lists_it(self):
        views = open(os.path.join(ROOT, "ui", "app", "10-views.js"), encoding="utf-8").read()
        m = re.search(r"VALLEY_FILES\s*=\s*\[([^\]]*)\]", views)
        files = re.findall(r'"([a-z0-9_-]+)"', m.group(1)) if m else []
        if "story" not in files:
            self.skipTest("VALLEY_FILES comes from the scaffold")
        self.assertGreater(files.index("story"), files.index("core"))

    @unittest.skipUnless(shutil.which("node"), "node not installed")
    def test_story_runs_under_node(self):
        # a tiny HQV stub: register the card, note events, complete a chapter
        script = r"""
        var saved = {inv:{a:3}}, reg = null, toasts = [];
        global.window = global; global.document = {querySelector: function(){ return null; }};
        window.myLevel = function(){ return {level: 5}; };
        window.HQV = {api: {save: saved, persist: function(){}, mk: function(){}, btn: function(){},
          activity: function(){ return {prompts30: 12, weekActiveDays: 2, streak: 0, level: 5}; },
          day: function(){ return "2026-10-10"; }, toast: function(m){ toasts.push(m); }, calm: function(){ return true; },
          open: function(){}, inArenaRoom: function(){ return false; }},
          register: function(g){ reg = g; }};
        require(process.argv[1]);
        var S = HQV.story;
        S.note("bogus"); S.note("td-wave", 5);
        // c1 needs a catch; without a Pokédex it stays open
        var out = {id: reg.id, badge: reg.badge(), ch: S.chapter(), notes: saved.story.notes, unlocked: S.unlocked()};
        console.log(JSON.stringify(out));
        """
        r = subprocess.run(["node", "-e", script, STORY], capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout.strip().splitlines()[-1])
        self.assertEqual(out["id"], "story")
        self.assertEqual(out["notes"], {"td-wave": 5})
        self.assertEqual(out["ch"]["index"], 0)
        self.assertEqual(out["badge"], "Ch 1/6")
        self.assertEqual(out["unlocked"], [])


if __name__ == "__main__":
    unittest.main()
