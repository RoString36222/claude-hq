#!/usr/bin/env python3
"""Regenerate the client test fixtures for Arena City from the Rust world generator.

Runs backend/'s `worldgen` bin and writes:

    tests/fixtures/claude-hq@1.json.gz       the WorldDoc (gzip level 9, mtime 0: byte-stable)
    tests/fixtures/claude-hq@1.samples.json  probe points (height, district, lot, site) the
                                             JS world queries must agree with

Run it from the repo root after every re-pin of CLAUDE_HQ_1 (the Rust test
`fixture_matches_pin` fails until the samples carry the pinned fingerprint):

    python3 tools/world_fixture.py
"""
import gzip
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORLD = "claude-hq@1"
CARGO = os.path.expanduser("~/.cargo/bin/cargo")
OUT = os.path.join(ROOT, "tests", "fixtures")


def worldgen(flag):
    cmd = [CARGO, "run", "--quiet", "--release", "--manifest-path", os.path.join(ROOT, "backend", "Cargo.toml"),
           "--bin", "worldgen", "--", WORLD, flag]
    # stdout only: cargo's and the generator's errors reach the terminal
    return subprocess.run(cmd, check=True, stdout=subprocess.PIPE, cwd=ROOT).stdout


def main():
    doc = worldgen("--json").strip()
    samples = worldgen("--samples").strip()
    world = json.loads(doc)["hashes"]["world"]
    if json.loads(samples)["world"] != world:
        sys.exit("world_fixture: --json and --samples disagree on the fingerprint")
    os.makedirs(OUT, exist_ok=True)
    gz = os.path.join(OUT, WORLD + ".json.gz")
    with open(gz, "wb") as f:
        with gzip.GzipFile(filename="", mode="wb", compresslevel=9, fileobj=f, mtime=0) as z:
            z.write(doc)
    with open(os.path.join(OUT, WORLD + ".samples.json"), "wb") as f:
        f.write(samples + b"\n")
    print(f"{WORLD} {world}: {len(doc) // 1024} KB doc ({os.path.getsize(gz) // 1024} KB gz), "
          f"{len(json.loads(samples)['samples'])} samples -> {os.path.relpath(OUT, ROOT)}")


if __name__ == "__main__":
    main()
