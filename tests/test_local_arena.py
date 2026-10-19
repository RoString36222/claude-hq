"""tools/local_arena.sh end to end, against throwaway copies only.

A temp HQ root holds a FAKE production config.json + arena-link.json (never the
real ones), and every port, the Arena's data dir and the LaunchAgents folder are
temp too. Runs: start, dashboard-tmp, pair, status, pair again (idempotent),
pair2, restore, status; plus a foreign port holder, stale pid files and a git
root that does not ignore the backups. Skipped when the release binaries are missing
(`tools/local_arena.sh build`).
"""
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import unittest
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
SCRIPT = os.path.join(REPO, "tools", "local_arena.sh")
ARENA = os.path.join(REPO, "backend", "target", "release", "arena")
HQ = os.path.join(REPO, "dashboard-rs", "target", "release", "claudehq")
PROD = "https://arena.heshdev.tech"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def get_json(url):
    with urllib.request.urlopen(url, timeout=10) as r:
        return json.loads(r.read().decode())


@unittest.skipUnless(os.access(ARENA, os.X_OK) and os.access(HQ, os.X_OK),
                     "release binaries missing (tools/local_arena.sh build)")
class LocalArenaScript(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="hq-local-arena-")
        self.root = os.path.join(self.tmp, "hq")
        self.data = os.path.join(self.tmp, "data")
        home = os.path.join(self.tmp, "home")
        os.makedirs(os.path.join(home, ".claude", "projects"))
        os.makedirs(self.root)
        for name in ("index.html", "ui", "games"):
            os.symlink(os.path.join(REPO, name), os.path.join(self.root, name))
        self.files = {
            "config.json": json.dumps({"arenaUrl": PROD, "arenaEnabled": False}).encode(),
            "arena-link.json": json.dumps({"url": PROD, "token": "fake-prod-token", "handle": "owner"}).encode(),
        }
        for name, body in self.files.items():
            p = os.path.join(self.root, name)
            with open(p, "wb") as f:
                f.write(body)
            os.chmod(p, 0o600)
        self.arena_port, self.port = free_port(), free_port()
        self.env = dict(os.environ, HOME=home, REPO=REPO, HQ_ROOT=self.root, ARENA_DEV_DATA=self.data,
                        ARENA_PORT=str(self.arena_port), HQ_PORT=str(free_port()), HQ2_PORT=str(free_port()),
                        LAUNCH_AGENTS=os.path.join(self.tmp, "LaunchAgents"))

    def tearDown(self):
        for args in (["stop2"], ["stop-tmp", str(self.port)], ["stop"]):
            subprocess.run([SCRIPT] + args, env=self.env, capture_output=True, timeout=60)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_sh(self, *args, ok=True):
        r = subprocess.run([SCRIPT] + list(args), env=self.env, capture_output=True, text=True, timeout=240)
        if ok:
            self.assertEqual(r.returncode, 0, f"{args}: {r.stdout}\n{r.stderr}")
        return r.stdout + r.stderr

    def db(self, sql):
        with sqlite3.connect(os.path.join(self.data, "arena.db")) as c:
            return c.execute(sql).fetchall()

    def test_end_to_end(self):
        self.run_sh("start")
        self.assertEqual(get_json(f"http://127.0.0.1:{self.arena_port}/health").get("status", "ok"), "ok")
        self.assertEqual(oct(os.stat(self.data).st_mode & 0o777), "0o700")
        self.assertEqual(oct(os.stat(os.path.join(self.data, "secret_key")).st_mode & 0o777), "0o600")
        self.run_sh("dashboard-tmp", self.root, str(self.port))
        base = f"http://127.0.0.1:{self.port}"
        self.assertEqual(get_json(base + "/api/arena/status")["url"], PROD)

        out = self.run_sh("pair", str(self.port))
        self.assertIn("world 200 + 304 ok", out)
        st = get_json(base + "/api/arena/status")
        self.assertEqual((st["paired"], st["url"]), (True, f"http://127.0.0.1:{self.arena_port}"))
        for name, body in self.files.items():
            bak = os.path.join(self.root, name + ".prod-bak")
            with open(bak, "rb") as f:
                self.assertEqual(f.read(), body, name)
            self.assertEqual(oct(os.stat(bak).st_mode & 0o777), "0o600")
        bak_mtimes = {n: os.stat(os.path.join(self.root, n + ".prod-bak")).st_mtime_ns for n in self.files}
        with open(os.path.join(self.root, "config.json")) as f:
            self.assertEqual(json.load(f)["arenaUrl"], f"http://127.0.0.1:{self.arena_port}")
        codes = self.db("SELECT COUNT(*) FROM pair_codes")[0][0]
        self.assertEqual(codes, 1)

        out = self.run_sh("status")
        self.assertIn("paired: true", out)
        self.assertIn("health:    ok", out)
        self.assertIn(".prod-bak", out)

        # Idempotent: no new code, the backups untouched.
        self.assertIn("already paired", self.run_sh("pair", str(self.port)))
        self.assertEqual(self.db("SELECT COUNT(*) FROM pair_codes")[0][0], codes)
        self.assertEqual(bak_mtimes, {n: os.stat(os.path.join(self.root, n + ".prod-bak")).st_mtime_ns
                                      for n in self.files})

        # The second browser: its own dashboard, its own user.
        self.run_sh("pair2")
        rows = self.db("SELECT handle, github_id FROM users ORDER BY handle")
        self.assertEqual([r[0] for r in rows], ["dev", "dev2"])
        self.assertTrue(all(r[1] < 0 for r in rows) and rows[0][1] != rows[1][1])
        st2 = get_json(f"http://127.0.0.1:{self.env['HQ2_PORT']}/api/arena/status")
        self.assertEqual((st2["paired"], st2["handle"]), (True, "dev2"))
        self.run_sh("stop2")
        self.assertFalse(os.path.exists(os.path.join(self.data, "hq2")))

        # Restore: byte-identical, backups gone, the dashboard back on production.
        out = self.run_sh("restore", str(self.port))
        self.assertIn(PROD, out)
        for name, body in self.files.items():
            with open(os.path.join(self.root, name), "rb") as f:
                self.assertEqual(f.read(), body, name)
            self.assertFalse(os.path.exists(os.path.join(self.root, name + ".prod-bak")))
        st = get_json(base + "/api/arena/status")
        self.assertEqual((st["paired"], st["url"]), (True, PROD))
        out = self.run_sh("status")
        self.assertIn(f"arena url: {PROD}  paired: true", out)
        self.assertNotIn("ARENA DOWN", out)
        # A second restore has no backups and fails loudly, touching nothing.
        r = subprocess.run([SCRIPT, "restore", str(self.port)], env=self.env, capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("nothing restored", r.stderr)

    def test_restore_removes_a_link_that_pairing_created(self):
        os.remove(os.path.join(self.root, "arena-link.json"))
        self.run_sh("start")
        self.run_sh("dashboard-tmp", self.root, str(self.port))
        self.run_sh("pair", str(self.port))
        self.assertTrue(os.path.exists(os.path.join(self.root, "arena-link.json.absent.prod-bak")))
        self.assertIn("unpaired, as before", self.run_sh("restore", str(self.port)))
        self.assertFalse(os.path.exists(os.path.join(self.root, "arena-link.json")))
        with open(os.path.join(self.root, "config.json"), "rb") as f:
            self.assertEqual(f.read(), self.files["config.json"])
        self.assertEqual([n for n in os.listdir(self.root) if n.endswith(".prod-bak")], [])
        self.assertFalse(get_json(f"http://127.0.0.1:{self.port}/api/arena/status")["paired"])

    def test_start_refuses_a_foreign_listener(self):
        with socket.socket() as s:
            s.bind(("127.0.0.1", self.arena_port))
            s.listen()
            out = self.run_sh("start", ok=False)
        self.assertIn("not ours, killing nothing", out)

    def test_stale_pid_files_kill_nothing(self):
        # after a reboot the pid in a pid file can be anyone's: stop and stop-tmp leave it alive
        os.makedirs(self.data, exist_ok=True)
        victim = subprocess.Popen(["sleep", "60"])
        try:
            for pidfile, args in (("arena.pid", ["stop"]), (f"hq-{self.port}.pid", ["stop-tmp", str(self.port)])):
                with open(os.path.join(self.data, pidfile), "w") as f:
                    f.write(str(victim.pid))
                out = self.run_sh(*args)
                self.assertIn("not ours; killing nothing", out)
                self.assertIsNone(victim.poll(), f"{args} killed an unrelated process")
                self.assertFalse(os.path.exists(os.path.join(self.data, pidfile)))
        finally:
            victim.kill()
            victim.wait()

    def test_pair_refuses_a_git_root_that_does_not_ignore_backups(self):
        subprocess.run(["git", "init", "-q", self.root], check=True)
        with open(os.path.join(self.root, ".gitignore"), "w") as f:
            f.write("config.json\narena-link.json\n")
        self.run_sh("dashboard-tmp", self.root, str(self.port))
        out = self.run_sh("pair", str(self.port), ok=False)
        self.assertIn("does not ignore config.json.prod-bak", out)
        self.assertEqual([n for n in os.listdir(self.root) if n.endswith(".prod-bak")], [])
        with open(os.path.join(self.root, ".gitignore"), "a") as f:
            f.write("*.prod-bak\n")
        out = self.run_sh("pair", str(self.port), ok=False)   # past the guard; no Arena runs here
        self.assertIn("the local Arena is not running", out)

    def test_status_flags_paired_to_local_with_the_arena_down(self):
        self.run_sh("dashboard-tmp", self.root, str(self.port))
        link = {"url": f"http://127.0.0.1:{self.arena_port}", "token": "t", "handle": "dev"}
        with open(os.path.join(self.root, "arena-link.json"), "w") as f:
            json.dump(link, f)
        self.assertIn("PAIRED TO LOCAL BUT ARENA DOWN", self.run_sh("status"))


if __name__ == "__main__":
    unittest.main()
