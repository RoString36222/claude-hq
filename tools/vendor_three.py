#!/usr/bin/env python3
"""Re-create games/vendor/ (three.js for Mini Golf) from the official npm package.

Downloads the unminified files of three@VERSION from jsDelivr, renames them to names the
dashboard's /games/vendor/ route allows, and rewrites ONLY the import specifiers so the
modules find each other there ('three' and './three.core.js' and '../utils/X.js' become
'./three-*.js'). Nothing else is changed. Stdlib only; run from the repo root:

    python3 tools/vendor_three.py            # writes games/vendor/
    python3 tools/vendor_three.py --check    # verifies games/vendor/ matches upstream
"""
import argparse
import hashlib
import os
import re
import sys
import urllib.request

VERSION = "0.186.1"
BASE = f"https://cdn.jsdelivr.net/npm/three@{VERSION}/"
FILES = {                                   # upstream path -> vendored name
    "build/three.module.js": "three-module.js",
    "build/three.core.js": "three-core.js",
    "examples/jsm/loaders/GLTFLoader.js": "three-gltf-loader.js",
    "examples/jsm/utils/SkeletonUtils.js": "three-skeleton-utils.js",
    "examples/jsm/utils/BufferGeometryUtils.js": "three-buffer-geometry-utils.js",
}
SPECIFIERS = {
    "three": "./three-module.js",
    "./three.core.js": "./three-core.js",
    "../utils/BufferGeometryUtils.js": "./three-buffer-geometry-utils.js",
    "../utils/SkeletonUtils.js": "./three-skeleton-utils.js",
}
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(HERE, "games", "vendor")
_SPEC_RE = re.compile(r"""(\bfrom\s+|\bimport\s+)(['"])([^'"]+)\2""")


def fetch(path: str) -> bytes:
    with urllib.request.urlopen(BASE + path, timeout=60) as r:
        return r.read()


def rewrite(src: str) -> str:
    def sub(m: re.Match) -> str:
        spec = m.group(3)
        return m.group(1) + m.group(2) + SPECIFIERS.get(spec, spec) + m.group(2)
    return _SPEC_RE.sub(sub, src)


def build() -> dict[str, bytes]:
    out, notes = {}, []
    for up, name in FILES.items():
        raw = fetch(up)
        notes.append(f"  {up:45} sha256 {hashlib.sha256(raw).hexdigest()}  -> {name}")
        out[name] = rewrite(raw.decode("utf-8")).encode("utf-8")
    lic = fetch("LICENSE").decode("utf-8")
    header = (f"three.js r{VERSION.split('.')[1]} (npm three@{VERSION}), vendored for Mini Golf by tools/vendor_three.py.\n"
              f"Source: {BASE}\nOnly the import specifiers were rewritten (to ./three-*.js); upstream sha256:\n"
              + "\n".join(notes) + "\n\n")
    out["LICENSE-three.txt"] = (header + lic).encode("utf-8")
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="compare with games/vendor/ instead of writing")
    args = ap.parse_args()
    files = build()
    bad = 0
    for name, data in files.items():
        path = os.path.join(OUT, name)
        if args.check:
            try:
                with open(path, "rb") as f:
                    same = f.read() == data
            except OSError:
                same = False
            print(("ok   " if same else "DIFF ") + name)
            bad += not same
        else:
            os.makedirs(OUT, exist_ok=True)
            with open(path, "wb") as f:
                f.write(data)
            print("wrote", name)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
