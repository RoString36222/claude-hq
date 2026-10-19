#!/usr/bin/env python3
"""Claude HQ runs on Rust now (dashboard-rs/, the `claudehq` binary).

This is not a server. It is here so an install that still starts HQ as
`python3 dashboard.py` -- an older LaunchAgent, an alias, or an older HQ's
Update button restarting itself -- keeps working: it builds the Rust server and
replaces itself with it, passing the same arguments. Run the binary directly:

    cargo build --release --manifest-path dashboard-rs/Cargo.toml
    dashboard-rs/target/release/claudehq [--port 8765] [--no-open]
    dashboard-rs/target/release/claudehq --install     # LaunchAgent on the binary
"""
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BINARY = os.path.join(HERE, "dashboard-rs", "target", "release", "claudehq")


def main():
    cargo = shutil.which("cargo") or os.path.expanduser("~/.cargo/bin/cargo")
    if not os.access(cargo, os.X_OK):
        sys.exit("Claude HQ now runs on Rust. Install it from https://rustup.rs, then run this again.")
    print("Claude HQ now runs on Rust: building dashboard-rs (a few minutes the first time)...", file=sys.stderr)
    r = subprocess.run([cargo, "build", "--release", "--locked", "--manifest-path",
                        os.path.join(HERE, "dashboard-rs", "Cargo.toml")])
    if r.returncode != 0:
        sys.exit("Building the Rust server failed (see above).")
    os.execv(BINARY, [BINARY] + sys.argv[1:])


if __name__ == "__main__":
    main()
