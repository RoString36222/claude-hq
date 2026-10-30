"""HQ Exosuit (games/hqexo.js): every frame builds within budget and poses finite, whatever it is given.

One node process loads the vendored three.js and games/hqexo.js and builds every frame x paint x finish x glow, and
again with odd inputs (NaN, negative, huge, strings, missing); counts each suit's draw calls and triangles (at most 6
and 6k); poses each on foot (idle, walk, sprint, sit, the page's loco blend) and in the air (hover, cruise, boost,
swim) through odd clocks (NaN, a step back, a long stall, a zero step) and checks every bone stays finite; runs every
suit-up style forward and in reverse to the end (and its pieces land on the body); and round-trips presence `ex`
(encode / decode, and decode refusing anything out of range). Then the wiring, by reading the files: the scripts load,
hq3d builds the suit for you and for peers, U summons it, the lobby has the Suit-Up Centre, presence `ex` goes out only
where the Arena lists "exo", and the Arena keeps it (backend/src/valley/hq.rs). Skipped when node is not installed.
Stdlib only."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

HARNESS = r"""
var fs = require("fs"), url = require("url"), root = process.argv[1];
import(url.pathToFileURL(root + "/games/vendor/three-module.js").href).then(function(T){
  global.window = {HQV: {}};
  new Function(fs.readFileSync(root + "/games/hqexo.js", "utf8"))();
  var X = window.HQV.hqExo, out = {built: 0, posed: 0, bad: [], budget: {}, over: [], seq: {}, rt: [], refused: 0, odd: 0};
  var ODD = [{}, {f: NaN, p: NaN, fin: NaN, g: NaN}, {f: -3, p: -1, fin: -9, g: -2}, {f: 99, p: 1e9, fin: 7, g: 1e6}, {f: "flux", p: "2", fin: "1", g: "x"}, null];
  var CLOCK = [0, 0, 0.016, NaN, 0.5, -0.4, 30, 30, 1e6, 0.016];
  var FLY = [null, {mode: "hover"}, {mode: "cruise", speed: 30}, {mode: "cruise", speed: NaN, boost: true}, {mode: "swim", speed: 4}, {mode: "nonsense"}];
  var CUR = ["idle", "walk", "sprint", "sit", "loco", null];
  function finite(ch){ var ok = true; ch.o.updateMatrixWorld(true); ch.o.traverse(function(o){ var e = o.matrixWorld.elements; for(var i = 0; i < 16; i++) if(!isFinite(e[i])) ok = false; }); return ok; }
  function posed(ch, tag){
    var t = 1;
    CUR.forEach(function(c, ci){ FLY.forEach(function(fl){
      ch.cur = c; ch.loco = c === "loco" ? {idle: 0.2, walk: 0.5, sprint: 0.3} : null;
      ch.acts.idle.weight = 0.2; ch.acts.walk.weight = ci % 2 ? 0.7 : NaN; ch.acts.sprint.weight = 0.3; ch._fly = fl;
      for(var f = 0; f < CLOCK.length; f++){ var k = CLOCK[f]; t = isFinite(k) ? t + k : NaN; ch.update(t); out.posed++; if(!isFinite(t)) t = 1; }
    }); });
    if(!finite(ch)) out.bad.push(tag);
  }
  X.FRAMES.forEach(function(F, fi){
    for(var p = 0; p < X.PAINTS.length; p++) for(var fin = 0; fin < X.FINISHES.length; fin++) for(var g = 0; g < X.GLOWS.length; g++){
      var ch = X.build(T, {f: fi, p: p, fin: fin, g: g}); out.built++;
      var s = X.stats(ch); out.budget[F.id] = s; if(s.draws > 6 || s.tris > 6000) out.over.push([F.id, p, fin, g, s]);
      if(p === 0 && g === 0) posed(ch, F.id + "/" + fin);
      X.dispose(ch);
    }
    ["gantry", "summon", "flow", "drop"].forEach(function(st){ [false, true].forEach(function(rev){
      var ch = X.build(T, {f: fi}), S = X.seq(T, ch, st, {reverse: rev}), r = null, n = 0, locks = 0;
      for(; n < 2000; n++){ r = X.seqStep(S, n % 7 ? 1/60 : (n % 3 ? NaN : -1)); if(r.lock) locks++; if(r.done) break; }
      var shown = ch._exo.meshes.every(function(m){ return m.visible; });
      out.seq[F.id + "/" + st + (rev ? "/off" : "")] = {done: !!(r && r.done), steps: n, locks: locks, shown: shown, left: S.g.parent ? 1 : 0, finite: finite(ch)};
    }); });
  });
  ODD.forEach(function(o, i){ var ch = X.build(T, o); posed(ch, "odd" + i); out.odd++; });
  for(var f = 0; f < 6; f++) for(var m = 1; m <= 6; m++){ var e = X.encode({f: f, p: (f*3) % 9, fin: f % 4, g: f % 5}, m), d = X.decode(e); out.rt.push([e, d && [d.f, d.p, d.fin, d.g, d.m]]); }
  [[6, 0, 0, 0, 2], [0, 9, 0, 0, 2], [0, 0, 4, 0, 2], [0, 0, 0, 5, 2], [0, 0, 0, 0, 0], [0, 0, 0, 0, 7], [0, 0, 0, 0], [0.5, 0, 0, 0, 2], "x", null, [-1, 0, 0, 0, 2]]
    .forEach(function(a){ if(X.decode(a) === null) out.refused++; });
  out.styles = X.FRAMES.map(function(F, i){ return [F.id, X.styleFor(i, "bay"), X.styleFor(i, "city")]; });
  out.wanted = [X.wanted("you:me"), X.peer("u1", [2, 0, 0, 0, 4]) && X.wanted("peer:u1"), X.peer("u1", null), X.wanted("peer:u1")];
  console.log(JSON.stringify(out));
}).catch(function(e){ console.error(e && e.stack || e); process.exit(1); });
"""


def read(*p):
    with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
        return f.read()


@unittest.skipUnless(NODE, "node not installed")
class ExoBudget(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", HARNESS, ROOT], capture_output=True, text=True, timeout=240)
        assert r.returncode == 0, r.stderr[-3000:]
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_every_frame_paint_finish_and_glow_builds_within_budget(self):
        o = self.o
        self.assertEqual(o["built"], 6*9*4*5)
        self.assertEqual(o["over"], [], "a suit over 6 draw calls or 6k triangles")
        self.assertEqual(sorted(o["budget"]), ["abyss", "bulwark", "flux", "sentinel", "stratos", "strider"])
        for k, s in o["budget"].items():
            self.assertLessEqual(s["draws"], 6, k)
            self.assertLessEqual(s["tris"], 6000, k)
        self.assertEqual(o["budget"]["abyss"]["draws"], 4, "abyss alone has the glass dome")

    def test_poses_stay_finite_with_odd_inputs_and_clocks(self):
        self.assertEqual(self.o["bad"], [])
        self.assertEqual(self.o["odd"], 6)
        self.assertGreater(self.o["posed"], 6*4*36*10)

    def test_every_suit_up_style_ends_on_the_body(self):
        seq = self.o["seq"]
        self.assertEqual(len(seq), 6*4*2)
        for k, s in seq.items():
            self.assertTrue(s["done"], k)
            self.assertTrue(s["finite"], k)
            self.assertEqual(s["left"], 0, k + ": its pieces are gone once it ends")
            if k.endswith("/off"):
                continue
            self.assertTrue(s["shown"], k + ": the merged suit shows once the pieces land")
            self.assertGreater(s["locks"], 3, k)
            self.assertLess(s["steps"], 400, k)

    def test_styles_presence_and_who_wears_a_suit(self):
        o = self.o
        for e, d in o["rt"]:
            self.assertEqual(e, d)
        self.assertEqual(o["refused"], 11)
        st = {f: [b, c] for f, b, c in o["styles"]}
        self.assertEqual(st["sentinel"], ["gantry", "summon"])
        self.assertEqual(st["stratos"], ["gantry", "summon"])
        self.assertEqual(st["bulwark"], ["drop", "drop"])
        self.assertEqual(st["flux"], ["flow", "flow"])
        self.assertEqual(o["wanted"][0], None, "not suited: your own body")
        self.assertEqual(o["wanted"][1]["f"], 2, "a peer's ex picks their suit")
        self.assertIsNone(o["wanted"][3], "and none once they take it off")


class ExoWiring(unittest.TestCase):
    def test_the_page_loads_and_sends_the_suit(self):
        hq = read("ui", "app", "22-hq.js")
        for f in ("hqexo", "hqexoride", "hqexohud"):
            self.assertIn('"%s"' % f, hq)
        self.assertIn('hqNetCan("exo")', hq)
        self.assertIn("msg.ex=ex.slice()", hq)

    def test_hq3d_builds_suits_and_takes_the_keys(self):
        s = read("games", "hq3d.js")
        self.assertIn("XO.wanted(key)", s)
        self.assertIn("HQV.hqExo.peer(p.u, p.ex)", s)
        self.assertIn('e.code !== "KeyU"', s)
        self.assertIn("if(exoKey(e)) return;", s)
        self.assertLess(s.index("if(exoKey(e)) return;"), s.index("if(petsKey(e)) return;"), "U: the suit's before a pet's")
        self.assertIn("ctx.exoBay", s)
        self.assertIn("EXO.black = 6", s, "the cut to black: six frames")
        lob = read("games", "hqlobby.js")
        self.assertIn("HQV.hqExo.bay(c, w,", lob)
        self.assertIn("w.use = function(p)", lob)
        cam = read("games", "camrig.js")
        self.assertIn("exo:     {", cam)
        self.assertIn("<kbd>U</kbd> summons your exosuit", read("index.html"))

    def test_the_arena_keeps_ex(self):
        proto = read("backend", "src", "protocol.rs")
        self.assertEqual(proto.count('"airliner", "exo", "boombox"'), 2)
        hq = read("backend", "src", "valley", "hq.rs")
        self.assertIn("fn read_exo(", hq)
        self.assertIn('m.insert("ex".into()', hq)


if __name__ == "__main__":
    unittest.main()
