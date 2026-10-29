#!/usr/bin/env python3
"""Pack the Arena release CI publishes for the host (ops/release.sh deploy reads it).

    python3 ops/release_bundle.py OUT_DIR VERSION SHA IMAGE

writes two files into OUT_DIR:
  arena-config-<VERSION>.tar.gz  every config the host runs the Arena with: backend/docker-compose.yml,
                                 backend/monitoring/ and ops/ (the panel's image, the deploy scripts).
                                 Not .env, the Caddyfile or sounds/: those belong to the host (secrets,
                                 the blocks the panel and monitoring installers append, uploaded clips).
  arena-release.json             {version, sha, image, config, config_sha256}; image is IMAGE as pushed
                                 (by digest), config the tarball's name, config_sha256 its sha256.
The tarball is reproducible (sorted, mtime 0, no owners), so the same commit packs to the same bytes.
Stdlib only.
"""
import gzip
import hashlib
import io
import json
import os
import sys
import tarfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILES = ["backend/docker-compose.yml", "backend/monitoring", "ops"]
SKIP = {"__pycache__", ".DS_Store"}


def members(root=ROOT):
    """The bundle's paths (repo-relative, sorted): FILES, directories walked, SKIP left out."""
    out = []
    for f in FILES:
        p = os.path.join(root, f)
        if os.path.isfile(p):
            out.append(f)
            continue
        for d, dirs, names in os.walk(p):
            dirs[:] = sorted(x for x in dirs if x not in SKIP)
            for n in names:
                if n not in SKIP and not n.endswith(".pyc"):
                    out.append(os.path.relpath(os.path.join(d, n), root))
    return sorted(out)


def pack(root=ROOT):
    """-> the tar.gz bytes."""
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as tar:
        for rel in members(root):
            info = tarfile.TarInfo(rel)
            with open(os.path.join(root, rel), "rb") as fh:
                data = fh.read()
            info.size = len(data)
            info.mode = 0o755 if os.access(os.path.join(root, rel), os.X_OK) else 0o644
            info.mtime = 0
            tar.addfile(info, io.BytesIO(data))
    out = io.BytesIO()
    with gzip.GzipFile(fileobj=out, mode="wb", mtime=0) as gz:
        gz.write(raw.getvalue())
    return out.getvalue()


def main(argv):
    if len(argv) != 5:
        sys.exit(__doc__)
    out_dir, version, sha, image = argv[1:]
    os.makedirs(out_dir, exist_ok=True)
    data = pack()
    name = "arena-config-%s.tar.gz" % version
    with open(os.path.join(out_dir, name), "wb") as f:
        f.write(data)
    manifest = {"version": version, "sha": sha, "image": image, "config": name,
                "config_sha256": hashlib.sha256(data).hexdigest()}
    with open(os.path.join(out_dir, "arena-release.json"), "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")
    print(json.dumps(manifest))


if __name__ == "__main__":
    main(sys.argv)
