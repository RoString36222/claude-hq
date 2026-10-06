"""The two battle engines agree: games/pokebattle.js (solo, in the browser) and
backend/app/pokebattle.py (the Arena duel referee) play the same random stream and the
same choices into identical events and states. Also the damage formula's known test
vector in both. Needs `node` for the JS half (skipped without it). Stdlib only."""
import importlib.util
import json
import os
import random
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("pokebattle", os.path.join(ROOT, "backend", "app", "pokebattle.py"))
pb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pb)

NODE_RUNNER = r"""
const fs = require("fs"), vm = require("vm"), path = require("path");
const root = process.env.HQ_ROOT, job = JSON.parse(fs.readFileSync(0, "utf8"));
const ctx = {console}; ctx.window = ctx; vm.createContext(ctx);
for(const f of ["pokedata.js", "pokebattle.js"]) vm.runInContext(fs.readFileSync(path.join(root, "games", f), "utf8"), ctx);
const pk = ctx.HQV.pk, out = [];
for(const g of job.games){
  let i = 0; const rng = () => g.floats[i++ % g.floats.length];
  const st = pk.newBattle(g.a.map(pk.buildMon), g.b.map(pk.buildMon)), steps = [];
  for(const s of g.script){
    const ev = s.k === "turn" ? pk.resolveTurn(st, pk.legal(st, 0, s.a), pk.legal(st, 1, s.b), rng) : pk.replace(st, s.side, s.slot);
    steps.push(ev);
  }
  out.push({steps, state: st});
}
const v = job.vector, c = pk.buildMon(v.att), d = pk.buildMon(v.def), mv = ctx.HQV_POKEDATA.moves[v.move];
out.push([pk.damage(c, d, mv, false, 85), pk.damage(c, d, mv, false, 100)]);
process.stdout.write(JSON.stringify(out));
"""


def spec_of(r: random.Random) -> dict:
    sp = r.randrange(48)
    st = r.randrange(5)
    final = pb.DATA["lines"][sp][-1]
    br = r.choice(pb.DATA["branches"].get(str(sp), [None]))
    megas = pb.DATA["megaFor"].get(str(br if br else final), [])
    return {"sp": sp, "st": st, "br": br, "mg": r.choice(megas) if megas and r.random() < 0.5 else None,
            "sh": r.random() < 0.2, "name": ""}


def play_python(seed: int) -> dict:
    """Random teams + random legal choices; returns the job for node and Python's result."""
    r = random.Random(seed)
    a = [spec_of(r) for _ in range(r.randint(1, 3))]
    b = [spec_of(r) for _ in range(r.randint(1, 3))]
    floats = [r.random() for _ in range(3000)]
    i = [0]

    def rng():
        v = floats[i[0] % len(floats)]
        i[0] += 1
        return v

    st = pb.new_battle([pb.build_mon(x) for x in a], [pb.build_mon(x) for x in b])
    script, steps = [], []
    for _ in range(60):
        if st["over"]:
            break
        need = pb.needs_replace(st)
        if need:
            for side in need:
                slot = r.choice(pb.alive(st, side))
                script.append({"k": "replace", "side": side, "slot": slot})
                steps.append(pb.replace(st, side, slot))
            continue
        acts = []
        for side in (0, 1):
            mon = pb.active(st, side)
            opts = [{"k": "move", "i": j} for j in range(len(mon["moves"]))]
            opts += [{"k": "switch", "to": j} for j in pb.alive(st, side) if j != st["sides"][side]["active"]]
            act = None
            while act is None:
                act = pb.legal(st, side, r.choice(opts) if r.random() < 0.9 else {"k": "move", "i": 0})
            acts.append(act)
        script.append({"k": "turn", "a": acts[0], "b": acts[1]})
        steps.append(pb.resolve_turn(st, acts[0], acts[1], rng))
    return {"job": {"a": a, "b": b, "floats": floats, "script": script}, "steps": steps, "state": st}


class DamageVector(unittest.TestCase):
    def test_charizard_flamethrower_on_venusaur(self):
        c = pb.build_mon({"sp": 1, "st": 4, "br": None, "mg": None, "sh": False})
        v = pb.build_mon({"sp": 3, "st": 4, "br": None, "mg": None, "sh": False})
        self.assertEqual((c["stats"]["spa"], v["stats"]["spd"], v["max"]), (141, 132, 170))
        fl = pb.MOVES["flamethrower"]
        self.assertEqual(pb.damage(c, v, fl, False, 85), (120, 2))
        self.assertEqual(pb.damage(c, v, fl, False, 100), (144, 2))

    def test_stage_mapping_rounds_half_up_like_js(self):
        self.assertEqual([pb.evo_pos(s, 3) for s in range(5)], [0, 1, 1, 2, 2])
        self.assertEqual([pb.evo_pos(s, 2) for s in range(5)], [0, 0, 1, 1, 1])   # round(0.5) would say 0
        self.assertEqual([pb.evo_pos(s, 1) for s in range(5)], [0] * 5)


@unittest.skipUnless(shutil.which("node"), "node not installed")
class EngineParity(unittest.TestCase):
    def test_same_stream_same_battle(self):
        games = [play_python(seed) for seed in range(40)]
        job = {"games": [g["job"] for g in games],
               "vector": {"att": {"sp": 1, "st": 4}, "def": {"sp": 3, "st": 4}, "move": "flamethrower"}}
        res = subprocess.run(["node", "-e", NODE_RUNNER], input=json.dumps(job), capture_output=True,
                             text=True, timeout=120, env=dict(os.environ, HQ_ROOT=ROOT))
        self.assertEqual(res.returncode, 0, res.stderr)
        out = json.loads(res.stdout)
        self.assertEqual(out[-1], [[120, 2], [144, 2]])
        turns = 0
        for g, js in zip(games, out[:-1]):
            self.assertEqual(len(g["steps"]), len(js["steps"]))
            for py_ev, js_ev in zip(g["steps"], js["steps"]):
                self.assertEqual(py_ev, js_ev)
                turns += 1
            self.assertEqual(json.loads(json.dumps(g["state"])), js["state"])
        self.assertGreater(turns, 200)


if __name__ == "__main__":
    unittest.main()
