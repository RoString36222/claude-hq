"""Mission Control desk (dashboard-rs/src/mcdesk.rs + games/hqmcdesk.js).

Rust: runs `cargo test --lib mcdesk` once lib.rs declares `pub mod mcdesk;` (skipped before).
JS: node loads hqmcdesk.js against a stub window and checks describe(). Stdlib only."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
CARGO = shutil.which("cargo") or (os.path.expanduser("~/.cargo/bin/cargo") if os.path.exists(os.path.expanduser("~/.cargo/bin/cargo")) else None)
LIB = os.path.join(ROOT, "dashboard-rs", "src", "lib.rs")

HARNESS = r"""
var fs = require("fs"); global.window = {HQV: {}};
new Function(fs.readFileSync(%s, "utf8"))();
var D = window.HQV.hqMcDesk;
console.log(JSON.stringify({
  fns: [typeof D.panel, typeof D.describe],
  bash: D.describe({tool: "Bash", input: {command: "rm -rf build"}, cwd: "/w"}),
  edit: D.describe({tool: "Edit", input: {file_path: "/w/a.py", old_string: "x"}}),
  other: D.describe({tool: "WebSearch", input: {q: 1}}),
  empty: D.describe(null)
}));
"""


class JsDesk(unittest.TestCase):
    @unittest.skipUnless(NODE, "node not installed")
    def test_describe(self):
        src = json.dumps(os.path.join(ROOT, "games", "hqmcdesk.js"))
        out = json.loads(subprocess.run([NODE, "-e", HARNESS % src], capture_output=True, text=True, check=True).stdout)
        self.assertEqual(out["fns"], ["function", "function"])
        self.assertEqual(out["bash"], {"tool": "Bash", "detail": "rm -rf build", "cwd": "/w"})
        self.assertEqual(out["edit"]["detail"], "/w/a.py")
        self.assertIn('"q": 1', out["other"]["detail"])
        self.assertEqual(out["empty"]["tool"], "?")


class RustDesk(unittest.TestCase):
    @unittest.skipUnless(CARGO, "cargo not installed")
    def test_cargo(self):
        with open(LIB, encoding="utf-8") as f:
            if "mod mcdesk;" not in f.read():
                self.skipTest("lib.rs does not declare mod mcdesk yet")
        r = subprocess.run([CARGO, "test", "--lib", "mcdesk"], cwd=os.path.join(ROOT, "dashboard-rs"),
                           capture_output=True, text=True, timeout=900)
        self.assertEqual(r.returncode, 0, r.stdout[-3000:] + r.stderr[-3000:])
        self.assertIn("3 passed", r.stdout)


if __name__ == "__main__":
    unittest.main()
