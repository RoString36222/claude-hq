"""The two battle engines agree: games/pokebattle.js (solo, in the browser) and
backend-rs/src/valley/pokebattle.rs (the Arena duel referee) play the same random stream
and the same choices into identical events and states.

The meeting point is backend-rs/tests/pokebattle_golden.json: 40 seeded battles (teams,
choices, the rng() draws each consumed, every step's events and the final state) plus the
damage formula's known test vector. It was generated once from the last Python Arena
(its pokebattle.py at commit a1eda91~1, since removed) and is fixed by design: this test
replays it through the JS under node, and pokebattle.rs's
`the_golden_battles_replay_exactly` replays it through the Rust. Stdlib only; the JS half
is skipped without node."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GOLDEN = os.path.join(ROOT, "backend-rs", "tests", "pokebattle_golden.json")

NODE_RUNNER = r"""
const fs = require("fs"), vm = require("vm"), path = require("path");
const root = process.env.HQ_ROOT, job = JSON.parse(fs.readFileSync(process.env.GOLDEN, "utf8"));
const ctx = {console}; ctx.window = ctx; vm.createContext(ctx);
for(const f of ["pokedata.js", "pokebattle.js"]) vm.runInContext(fs.readFileSync(path.join(root, "games", f), "utf8"), ctx);
const pk = ctx.HQV.pk, out = {games: []};
for(const g of job.games){
  const fl = g.draws53.map(k => k / 2 ** 53);   // exact: each draw is k / 2**53
  let i = 0; const rng = () => fl[i++ % fl.length];
  const st = pk.newBattle(g.a.map(pk.buildMon), g.b.map(pk.buildMon)), steps = [];
  for(const s of g.script){
    const ev = s.k === "turn" ? pk.resolveTurn(st, pk.legal(st, 0, s.a), pk.legal(st, 1, s.b), rng) : pk.replace(st, s.side, s.slot);
    steps.push(ev);
  }
  out.games.push({steps, state: st, draws: i});
}
const v = job.vector, c = pk.buildMon(v.att), d = pk.buildMon(v.def), mv = ctx.HQV_POKEDATA.moves[v.move];
out.stats = [c.stats.spa, d.stats.spd, d.max];
out.damage = [pk.damage(c, d, mv, false, 85), pk.damage(c, d, mv, false, 100)];
out.evo = {}; for(const n of [1, 2, 3]) out.evo[n] = [0, 1, 2, 3, 4].map(s => pk.evoPos(s, n));
process.stdout.write(JSON.stringify(out));
"""


def golden():
    with open(GOLDEN, encoding="utf-8") as f:
        return json.load(f)


class GoldenShape(unittest.TestCase):
    def test_the_golden_is_the_fixed_python_record(self):
        g = golden()
        self.assertIn("a1eda91", g["note"])
        self.assertEqual(len(g["games"]), 40)
        self.assertGreater(sum(len(x["steps"]) for x in g["games"]), 200)
        # the damage vector the old DamageVector test pinned
        self.assertEqual(g["vector"]["stats"], [141, 132, 170])
        self.assertEqual(g["vector"]["damage"], [[120, 2], [144, 2]])
        # stage mapping rounds half up like JS (round(0.5) would say 0 for a 2-line)
        self.assertEqual(g["evo_pos"], {"1": [0] * 5, "2": [0, 0, 1, 1, 1], "3": [0, 1, 1, 2, 2]})


@unittest.skipUnless(shutil.which("node"), "node not installed")
class EngineParity(unittest.TestCase):
    def test_js_replays_the_golden_battles(self):
        g = golden()
        res = subprocess.run(["node", "-e", NODE_RUNNER], capture_output=True, text=True, timeout=120,
                             env=dict(os.environ, HQ_ROOT=ROOT, GOLDEN=GOLDEN))
        self.assertEqual(res.returncode, 0, res.stderr)
        out = json.loads(res.stdout)
        self.assertEqual(out["stats"], g["vector"]["stats"])
        self.assertEqual(out["damage"], g["vector"]["damage"])
        self.assertEqual(out["evo"], g["evo_pos"])
        turns = 0
        for want, js in zip(g["games"], out["games"]):
            self.assertEqual(js["draws"], want["draws"], want["seed"])   # same stream, same order
            self.assertEqual(len(want["steps"]), len(js["steps"]))
            for py_ev, js_ev in zip(want["steps"], js["steps"]):
                self.assertEqual(py_ev, js_ev, want["seed"])
                turns += 1
            self.assertEqual(want["state"], js["state"], want["seed"])
        self.assertGreater(turns, 200)


if __name__ == "__main__":
    unittest.main()
