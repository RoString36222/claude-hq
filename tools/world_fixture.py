#!/usr/bin/env python3
"""Regenerate the client test fixtures for Arena City from the Rust world generator.

Runs backend/'s `worldgen` bin and writes:

    tests/fixtures/claude-hq@1.json.gz       the WorldDoc (gzip level 9, mtime 0: byte-stable)
    tests/fixtures/claude-hq@1.samples.json  probe points (height, district, lot, site) the
                                             JS world queries must agree with
    tests/fixtures/claude-hq@2.json.gz       the Commons (Cities, WorldDoc v2)
    tests/fixtures/island@2.json.gz          a personal island (ISLAND below), WorldDoc v2

The v2 docs are what tests/test_cities.py builds the 3D City on; rerun this after any change to the
organic generator, civic, transit or island code (their fingerprints move with it).

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
COMMONS = "claude-hq@2"
ISLAND = "user:0b8e4c1a-3f2d-4e5b-9a6c-7d8e9f0a1b2c@2"
CARGO = os.path.expanduser("~/.cargo/bin/cargo")
OUT = os.path.join(ROOT, "tests", "fixtures")


def worldgen(flag, world=WORLD):
    cmd = [CARGO, "run", "--quiet", "--release", "--manifest-path", os.path.join(ROOT, "backend", "Cargo.toml"),
           "--bin", "worldgen", "--", world, flag]
    # stdout only: cargo's and the generator's errors reach the terminal
    return subprocess.run(cmd, check=True, stdout=subprocess.PIPE, cwd=ROOT).stdout


def write_gz(path, data):
    with open(path, "wb") as f:
        with gzip.GzipFile(filename="", mode="wb", compresslevel=9, fileobj=f, mtime=0) as z:
            z.write(data)


def main():
    doc = worldgen("--json").strip()
    samples = worldgen("--samples").strip()
    world = json.loads(doc)["hashes"]["world"]
    if json.loads(samples)["world"] != world:
        sys.exit("world_fixture: --json and --samples disagree on the fingerprint")
    os.makedirs(OUT, exist_ok=True)
    gz = os.path.join(OUT, WORLD + ".json.gz")
    write_gz(gz, doc)
    with open(os.path.join(OUT, WORLD + ".samples.json"), "wb") as f:
        f.write(samples + b"\n")
    print(f"{WORLD} {world}: {len(doc) // 1024} KB doc ({os.path.getsize(gz) // 1024} KB gz), "
          f"{len(json.loads(samples)['samples'])} samples -> {os.path.relpath(OUT, ROOT)}")
    for world, name in ((COMMONS, COMMONS), (ISLAND, "island@2")):
        v2 = worldgen("--json", world).strip()
        out = os.path.join(OUT, name + ".json.gz")
        write_gz(out, v2)
        print(f"{world} {json.loads(v2)['hashes']['world']}: {len(v2) // 1024} KB doc ({os.path.getsize(out) // 1024} KB gz) -> {os.path.relpath(out, ROOT)}")


if __name__ == "__main__":
    main()
