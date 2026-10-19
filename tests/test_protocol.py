"""Arena protocol versions (Wave 0): the client's CLIENT_PROTO in games/multi.js must
cover the Rust Arena's table (backend-rs/src/protocol.rs), game for game, and protoCheck
must tell "update the Arena" from "update Claude HQ". The JS runs in node (piped on
stdin); skipped without node."""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(*p):
    with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
        return f.read()


def client_proto():
    m = re.search(r"var CLIENT_PROTO = (\{[^}]*\});", read("games", "multi.js"))
    return json.loads(re.sub(r"(\w+):", r'"\1":', m.group(1)))


def rust_rows():
    rows = [(g, int(v)) for g, v in re.findall(r'\("(\w+)", (\d+), &\[', read("backend-rs", "src", "protocol.rs"))]
    assert rows, "no protocol rows parsed out of protocol.rs"
    return rows


class ProtocolTables(unittest.TestCase):
    def test_client_knows_exactly_the_rust_games(self):
        """A game the Arena referees but the client has no range for (or the reverse) is
        the drift this catches."""
        rows = rust_rows()
        self.assertEqual(len({g for g, _ in rows}), len(rows), "a game is listed twice in protocol.rs")
        self.assertEqual(set(client_proto()), {g for g, _ in rows})

    def test_client_covers_rust_versions(self):
        cp = client_proto()
        for g, v in rust_rows():
            self.assertTrue(cp[g][0] <= v <= cp[g][1], f"{g}: Rust v{v} not in the client's {cp[g]}")


@unittest.skipUnless(shutil.which("node"), "node not installed")
class ProtoCheck(unittest.TestCase):
    SCRIPT = r"""
const fs = require('fs');
function stub(){ return new Proxy(function(){}, {get:(t,k)=>k===Symbol.toPrimitive?()=>'':stub(), apply:()=>stub(), set:()=>true}); }
const window = {HQV:{api:stub(), games:{}, register:()=>{}, onGame:null}};
window.ARENA = {arena:{impl:"rs", games:{kart:{v:2,caps:[]}, plat:{v:1,caps:[]}, fps:{v:3,caps:[]}}}};
new Function('window','document', fs.readFileSync(process.argv[2],'utf8'))(window, stub());
const pc = window.HQV.protoCheck, out = {};
out.kart = pc("kart"); out.golf = pc("golf"); out.fps = pc("fps");
window.ARENA.arena.games.plat.v = 0; out.plat = pc("plat");
window.ARENA.arena = null; out.legacy = pc("golf");
console.log(JSON.stringify(out));
"""

    def test_verdicts(self):
        r = subprocess.run(["node", "-", os.path.join(ROOT, "games", "multi.js")], input=self.SCRIPT,
                           capture_output=True, text=True, cwd=ROOT, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)
        self.assertIsNone(out["kart"])                       # in range
        # An Arena whose table omits golf -- stubbed above, not the real Rust
        # one, which runs it now. What is under test is the client's verdict.
        self.assertEqual(out["golf"]["who"], "arena")
        self.assertIn("doesn't run", out["golf"]["text"])
        self.assertEqual(out["fps"]["who"], "hq")            # server newer than client
        self.assertEqual(out["plat"]["who"], "arena")        # server older than client
        self.assertIsNone(out["legacy"])                     # pre-2.0 Arena: games cope alone


if __name__ == "__main__":
    unittest.main()
