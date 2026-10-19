"""The page the frontend tests read: index.html stitched with ui/, assembled by the
server itself (dashboard-rs, `claudehq --print-index`), so the tests check exactly
what the browser gets. Builds the server once per test run."""
import functools
import os
import shutil
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(ROOT, "dashboard-rs", "Cargo.toml")


def _cargo():
    return shutil.which("cargo") or os.path.expanduser("~/.cargo/bin/cargo")


@functools.lru_cache(maxsize=None)
def assemble_index():
    r = subprocess.run([_cargo(), "run", "--quiet", "--manifest-path", MANIFEST, "--bin", "claudehq",
                        "--", "--root", ROOT, "--print-index"],
                       capture_output=True, text=True, check=True)
    return r.stdout
