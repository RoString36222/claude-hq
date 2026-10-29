"""HQ 3.36: the host deploys CI's Arena release instead of building (ops/release.sh deploy, ops/release_bundle.py).

The bundle: every config the host runs the Arena with and nothing that belongs to the host, packed the same
way every time. The deploy: the real script in a scratch repo, the release served from a file:// URL, docker
faked on PATH (it logs what it was asked and answers the health check): it takes the release's config, links
the host's .env / Caddyfile / sounds into it, pulls the image instead of building, and refuses a config whose
sha256 does not match.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "ops"))
import release_bundle  # noqa: E402

VERSION = "2026.10.29-abcdef1"
SHA = "abcdef1" + "0" * 33
IMAGE = "ghcr.io/rostring36222/claude-hq-arena@sha256:" + "a" * 64


def read(path, mode="r"):
    with open(path, mode) as f:
        return f.read()


class Bundle(unittest.TestCase):
    def test_carries_the_config_and_none_of_the_hosts_files(self):
        m = release_bundle.members()
        for f in ("backend/docker-compose.yml", "backend/monitoring/prometheus.yml", "ops/release.sh",
                  "ops/autodeploy.sh", "ops/deploy_panel.py", "ops/Dockerfile.panel"):
            self.assertIn(f, m)
        for f in m:
            self.assertNotIn("__pycache__", f)
            self.assertFalse(f.endswith((".env", "Caddyfile")), f)
            self.assertFalse(f.startswith("backend/sounds"), f)
        self.assertEqual(m, sorted(m))

    def test_packs_the_same_bytes_every_time(self):
        self.assertEqual(release_bundle.pack(), release_bundle.pack())

    def test_manifest_names_the_config_and_its_sha256(self):
        out = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, out)
        subprocess.run([sys.executable, os.path.join(ROOT, "ops", "release_bundle.py"), out, VERSION, SHA, IMAGE],
                       check=True, capture_output=True)
        m = json.loads(read(os.path.join(out, "arena-release.json")))
        self.assertEqual((m["version"], m["sha"], m["image"], m["config"]), (VERSION, SHA, IMAGE, "arena-config-%s.tar.gz" % VERSION))
        data = read(os.path.join(out, m["config"]), "rb")
        self.assertEqual(m["config_sha256"], hashlib.sha256(data).hexdigest())
        with tarfile.open(os.path.join(out, m["config"])) as t:
            self.assertIn("backend/docker-compose.yml", t.getnames())


class DeployFromRelease(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        repo = self.repo = os.path.join(self.tmp, "repo")
        os.makedirs(os.path.join(repo, "ops"))
        os.makedirs(os.path.join(repo, "backend", "sounds"))
        shutil.copy(os.path.join(ROOT, "ops", "release.sh"), os.path.join(repo, "ops"))
        for f, body in ((".env", "ARENA_DOMAIN=arena.example\n"), ("Caddyfile", "# the host's own\n")):
            with open(os.path.join(repo, "backend", f), "w") as fh:
                fh.write(body)
        # the release, served from a file:// URL
        self.rel = os.path.join(self.tmp, "release")
        subprocess.run([sys.executable, os.path.join(ROOT, "ops", "release_bundle.py"), self.rel, VERSION, SHA, IMAGE],
                       check=True, capture_output=True)
        self.bin = os.path.join(self.tmp, "bin")
        os.makedirs(self.bin)
        self.log = os.path.join(self.tmp, "docker.log")
        state = os.path.join(repo, "backend", ".release.env")
        self._tool("sleep", "exit 0")
        self._tool("gh", "exit 1")
        # docker: log every call; the app is healthy and runs the version the state names
        self._tool("docker", f"""
echo "$*" >> {self.log}
case "$*" in
  *printenv\\ ARENA_VERSION*) grep '^ARENA_VERSION=' {state} | cut -d= -f2 ;;
  "image ls"*) ;;
esac
exit 0
""")

    def _tool(self, name, body):
        path = os.path.join(self.bin, name)
        with open(path, "w") as f:
            f.write("#!/usr/bin/env bash\n" + body)
        os.chmod(path, 0o755)

    def run_sh(self, *args):
        env = dict(os.environ, PATH=self.bin + os.pathsep + os.environ["PATH"], ARENA_SKIP_PULL="1",
                   ARENA_RELEASE_URL="file://" + self.rel, TMPDIR=self.tmp)
        env.pop("ARENA_FROM", None)
        p = subprocess.run(["bash", os.path.join(self.repo, "ops", "release.sh")] + list(args),
                           env=env, capture_output=True, text=True, timeout=60)
        return p.returncode, p.stdout + p.stderr

    def docker_calls(self):
        return read(self.log).splitlines() if os.path.exists(self.log) else []

    def test_latest_names_the_release(self):
        rc, out = self.run_sh("latest")
        self.assertEqual((rc, out.strip()), (0, "%s %s" % (VERSION, SHA)))

    def test_deploys_the_release_config_and_image_without_building(self):
        rc, out = self.run_sh("deploy")
        self.assertEqual(rc, 0, out)
        self.assertIn("Released %s (rs)" % VERSION, out)
        dirb = os.path.join(self.repo, ".arena-releases", VERSION, "backend")
        state = read(os.path.join(self.repo, "backend", ".release.env"))
        self.assertIn("ARENA_CONFIG_DIR=" + dirb, state)
        self.assertIn("ARENA_APP_IMAGE=claude-hq-arena-rs:" + VERSION, state)
        # the release's own config, the host's files linked in (never copied from the release)
        self.assertTrue(os.path.isfile(os.path.join(dirb, "docker-compose.yml")))
        for f in (".env", "Caddyfile", "sounds"):
            self.assertEqual(os.readlink(os.path.join(dirb, f)), os.path.join(self.repo, "backend", f))
        calls = self.docker_calls()
        self.assertIn("pull -q " + IMAGE, calls)
        self.assertIn("tag %s claude-hq-arena-rs:%s" % (IMAGE, VERSION), calls)
        self.assertFalse([c for c in calls if " build" in c], calls)
        up = [c for c in calls if c.endswith("up -d --no-build app")]
        self.assertTrue(up and "--project-directory " + dirb in up[0] and "-f %s/docker-compose.yml" % dirb in up[0], calls)
        hist = read(os.path.join(self.repo, "backend", ".releases"))
        self.assertIn(" %s rs %s" % (VERSION, SHA[:7]), hist)
        # once it runs, the same release again is a no-op
        rc, out = self.run_sh("deploy")
        self.assertIn("is already running", out)

    def test_refuses_a_config_that_does_not_match_its_sha256(self):
        p = os.path.join(self.rel, "arena-release.json")
        m = json.loads(read(p))
        m["config_sha256"] = "0" * 64
        with open(p, "w") as f:
            json.dump(m, f)
        rc, out = self.run_sh("deploy")
        self.assertNotEqual(rc, 0)
        self.assertIn("does not match its sha256", out)
        self.assertFalse([c for c in self.docker_calls() if c.startswith("pull")])
        self.assertFalse(os.path.exists(os.path.join(self.repo, "backend", ".release.env")))

    def test_no_release_says_how_to_build_here(self):
        os.remove(os.path.join(self.rel, "arena-release.json"))
        rc, out = self.run_sh("deploy")
        self.assertNotEqual(rc, 0)
        self.assertIn("ARENA_FROM=git", out)


if __name__ == "__main__":
    unittest.main()
