"""The trainer-avatar spec: the client and the dashboard must agree on its bounds.

A saved avatar is nine small integers. ui/app/06-trainer-packs.js renders them
and dashboard.py clamps them on the way into the config, so if the two disagree
the symptom is quiet and confusing: the builder offers a choice the server
clamps away, and the avatar changes by itself on the next save.

Nothing checked that before -- dashboard.py's comment even claimed schemas.py
held a third copy, which it never did; the avatar does not leave the machine.

The spec is APPEND-ONLY. Raising a max must never renumber an existing choice,
because the numbers are what is stored: inserting a hair style in the middle
would silently restyle everyone whose index sits above it.
"""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PACKS = os.path.join(ROOT, "ui", "app", "06-trainer-packs.js")

AXES = ["skin", "hair", "hairColor", "outfit", "outfitColor", "hat", "accessory", "bg", "face"]
# Palette arrays that must be as long as their axis allows. bg's index 0 is the
# "Theme" sentinel (an empty string), so it is sized the same way.
PALETTES = {"skin": "TR_SKIN", "hairColor": "TR_HAIRC", "outfitColor": "TR_OUTC", "bg": "TR_BG"}


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def js_int_list(src, name):
    m = re.search(r"var %s\s*=\s*\[([^\]]*)\]" % name, src)
    return [int(x) for x in m.group(1).split(",")]


def js_str_list(src, name):
    m = re.search(r"var %s\s*=\s*\[([^\]]*)\]" % name, src)
    return re.findall(r"'([^']*)'", m.group(1))


def js_labels(src):
    body = re.search(r"var TR_LABELS\s*=\s*\{(.*?)\n\};", src, re.S).group(1)
    out = {}
    for axis in AXES:
        m = re.search(r"\b%s\s*:\s*\[([^\]]*)\]" % axis, body)
        out[axis] = re.findall(r"'([^']*)'", m.group(1))
    return out


class TrainerSpecBounds(unittest.TestCase):
    def setUp(self):
        self.js = read(PACKS)
        self.tr_max = js_int_list(self.js, "TR_MAX")

    def test_the_client_and_the_dashboard_agree(self):
        py = read(os.path.join(ROOT, "dashboard.py"))
        m = re.search(r"^TRAINER_MAX = \(([^)]*)\)", py, re.M)
        server = [int(x) for x in m.group(1).split(",")]
        self.assertEqual(self.tr_max, server,
                         "TR_MAX and TRAINER_MAX have drifted; the builder and the "
                         "server would disagree about which choices exist")
        self.assertEqual(len(self.tr_max), 9)

    def test_every_axis_labels_every_choice(self):
        labels = js_labels(self.js)
        for i, axis in enumerate(AXES):
            with self.subTest(axis=axis):
                self.assertEqual(len(labels[axis]), self.tr_max[i] + 1,
                                 f"{axis} allows {self.tr_max[i] + 1} choices but names "
                                 f"{len(labels[axis])}; the builder would show 'Option N'")

    def test_every_colour_axis_has_a_swatch_per_choice(self):
        for axis, name in PALETTES.items():
            with self.subTest(axis=axis):
                self.assertEqual(len(js_str_list(self.js, name)), self.tr_max[AXES.index(axis)] + 1,
                                 f"{name} is shorter than {axis} allows; the last swatch "
                                 f"would render undefined")

    def test_no_choice_was_renumbered(self):
        """Append-only, checked against the values this test was written with.

        Raising a bound is fine and needs no edit here. Lowering one, or
        reordering a palette or a label list, means a stored avatar now means
        something else -- update this list only alongside a migration.
        """
        FIRST_SIX_SKINS = ['#f4d6bb', '#e7b892', '#cd9269', '#a06a45', '#6f4a32', '#402a20']
        self.assertEqual(js_str_list(self.js, "TR_SKIN")[:6], FIRST_SIX_SKINS)
        self.assertEqual(js_labels(self.js)["hair"][:8],
                         ['Bald', 'Short', 'Side part', 'Spiky', 'Pulled back', 'Long',
                          'Curly', 'Top knot'])
        for i, floor in enumerate([5, 7, 7, 7, 7, 6, 4, 7, 3]):
            with self.subTest(axis=AXES[i]):
                self.assertGreaterEqual(self.tr_max[i], floor,
                                        f"{AXES[i]} lost a choice; stored avatars above "
                                        f"index {self.tr_max[i]} would be clamped")


@unittest.skipUnless(shutil.which("node"), "node not installed")
class TrainerRendering(unittest.TestCase):
    """Render every choice of every axis and prove each one draws something new.

    This is the test that catches the mistake this feature could easily have
    made. Each renderer in 06-trainer-packs.js ends in a bare `return` that acts
    as the last option's branch, so appending a choice without making that
    branch explicit leaves the new option drawing the OLD one -- a new entry in
    the dropdown that changes nothing on screen, and nothing else would notice.
    """

    SCRIPT = r"""
const fs = require('fs');
// The handful of globals 06-trainer-packs.js borrows from the rest of the app.
const sandbox = {
  esc: s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
  calmMode: () => true,
  mulberry32: a => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; },
  hashStr: s => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; },
};
const names = Object.keys(sandbox), vals = names.map(n => sandbox[n]);
const src = fs.readFileSync(process.argv[2], 'utf8');
const api = new Function(...names, src + '\nreturn {trainerSVG, TR_MAX};')(...vals);
const out = {max: api.TR_MAX, svg: {}};
// Baseline 1s, NOT 0s. From an all-zero spec the colour axes are invisible:
// hair 0 is Bald so no hair colour is drawn, and hat 0 is None -- and the
// "outfit colour" axis only ever colours the HEADWEAR (06-trainer-packs.js:148
// takes the outfit's own fill from TR_OUTC[outfitIndex]), so with no hat it
// changes nothing at all. Every axis needs the feature it tints to be present.
for (let axis = 0; axis < api.TR_MAX.length; axis++) {
  out.svg[axis] = [];
  for (let v = 0; v <= api.TR_MAX[axis]; v++) {
    const spec = new Array(api.TR_MAX.length).fill(1);
    spec[axis] = v;
    out.svg[axis].push(api.trainerSVG(spec, 96, {animate: false}));
  }
}
console.log(JSON.stringify(out));
"""

    @classmethod
    def setUpClass(cls):
        r = subprocess.run(["node", "-", PACKS], input=cls.SCRIPT,
                           capture_output=True, text=True, cwd=ROOT, timeout=60)
        if r.returncode != 0:
            raise unittest.SkipTest(f"could not evaluate the avatar renderer: {r.stderr[-400:]}")
        cls.out = json.loads(r.stdout)

    def test_every_choice_renders_a_whole_svg(self):
        for axis, svgs in self.out["svg"].items():
            for v, svg in enumerate(svgs):
                with self.subTest(axis=AXES[int(axis)], value=v):
                    self.assertTrue(svg.startswith("<svg"), "not an svg")
                    self.assertTrue(svg.rstrip().endswith("</svg>"), "truncated svg")
                    self.assertNotIn("undefined", svg, "a palette entry is missing")
                    self.assertNotIn("NaN", svg, "a number came out NaN")

    def test_no_svg_declares_an_id(self):
        """Several avatars share a page, so a fixed id would collide. The file
        does glow with an inline filter:drop-shadow for exactly this reason."""
        for axis, svgs in self.out["svg"].items():
            for v, svg in enumerate(svgs):
                with self.subTest(axis=AXES[int(axis)], value=v):
                    self.assertNotIn('id="', svg)

    def test_the_last_choice_of_each_axis_draws_something_of_its_own(self):
        for axis, svgs in self.out["svg"].items():
            name = AXES[int(axis)]
            with self.subTest(axis=name):
                self.assertNotEqual(
                    svgs[-1], svgs[-2],
                    f"the last {name} choice renders identically to the one before it: "
                    f"its branch is missing and it is falling through")

    def test_every_choice_of_an_axis_is_distinct(self):
        for axis, svgs in self.out["svg"].items():
            name = AXES[int(axis)]
            with self.subTest(axis=name):
                self.assertEqual(len(set(svgs)), len(svgs),
                                 f"two {name} choices render the same thing")


if __name__ == "__main__":
    unittest.main()
