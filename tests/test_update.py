"""Self-update (GET/POST /api/update): status against an upstream, fast-forward
only, refusing local edits and diverged history. Uses throwaway git repos; the
restart is stubbed so the test process is never replaced."""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import dashboard  # noqa: E402


def git(cwd, *args):
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t",
               GIT_COMMITTER_EMAIL="t@t")
    return subprocess.run(["git", "-C", cwd] + list(args), check=True, capture_output=True, text=True, env=env).stdout


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.origin = os.path.join(self.tmp, "origin.git")
        self.mine = os.path.join(self.tmp, "mine")
        self.other = os.path.join(self.tmp, "other")
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", self.origin], check=True)
        subprocess.run(["git", "clone", "-q", self.origin, self.other], check=True, capture_output=True)
        self.commit(self.other, "a.txt", "one", "first")
        git(self.other, "push", "-q", "origin", "HEAD:main")
        subprocess.run(["git", "clone", "-q", self.origin, self.mine], check=True, capture_output=True)
        self._saved = (dashboard.HERE, dashboard._restart_self)
        dashboard.HERE = self.mine
        self.restarts = []
        dashboard._restart_self = lambda binary=None: self.restarts.append(binary)
        dashboard._update_cache.update(at=0.0, data=None)

    def tearDown(self):
        dashboard.HERE, dashboard._restart_self = self._saved
        dashboard._update_cache.update(at=0.0, data=None)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def commit(self, repo, name, text, msg):
        with open(os.path.join(repo, name), "w") as f:
            f.write(text)
        git(repo, "add", name)
        git(repo, "commit", "-q", "-m", msg)

    def push_upstream(self, msg="second"):
        self.commit(self.other, "a.txt", msg, msg)
        git(self.other, "push", "-q", "origin", "HEAD:main")

    def test_up_to_date(self):
        st = dashboard.update_status(force=True)
        self.assertTrue(st["ok"])
        self.assertEqual((st["behind"], st["ahead"], st["dirty"]), (0, 0, False))
        self.assertEqual(dashboard.update_and_restart()[1]["updated"], False)
        self.assertEqual(self.restarts, [])

    def test_behind_then_fast_forward_and_restart(self):
        self.push_upstream("second")
        st = dashboard.update_status(force=True)
        self.assertEqual(st["behind"], 1)
        self.assertTrue(st["commits"][0].endswith(" second"))
        code, resp = dashboard.update_and_restart()
        self.assertEqual(code, 200)
        self.assertTrue(resp["updated"] and resp["restarting"])
        self.assertEqual((resp["server"], resp["rustError"]), ("python", "this copy has no dashboard-rs/"))
        with open(os.path.join(self.mine, "a.txt")) as f:
            self.assertEqual(f.read(), "second")
        import time
        time.sleep(1.3)                  # the restart fires on a 1s timer
        self.assertEqual(self.restarts, [None])     # no dashboard-rs/ here: Python again

    def test_refuses_local_edits(self):
        self.push_upstream()
        with open(os.path.join(self.mine, "a.txt"), "w") as f:
            f.write("my edit")
        code, resp = dashboard.update_and_restart()
        self.assertEqual(code, 409)
        self.assertIn("local changes", resp["error"])
        with open(os.path.join(self.mine, "a.txt")) as f:
            self.assertEqual(f.read(), "my edit")

    def test_refuses_diverged_history(self):
        self.push_upstream()
        self.commit(self.mine, "b.txt", "local", "local work")
        code, resp = dashboard.update_and_restart()
        self.assertEqual(code, 409)
        self.assertIn("diverged", resp["error"])

    def test_cache_until_forced(self):
        dashboard.update_status(force=True)
        self.push_upstream()
        self.assertEqual(dashboard.update_status()["behind"], 0)        # cached
        self.assertEqual(dashboard.update_status(force=True)["behind"], 1)

    def test_stale_code_restarts_without_pulling(self):
        # The code on disk changed after this process started (a terminal pull, a local
        # edit): nothing to fetch, but the server must restart to run it.
        saved = dashboard.BOOT_CODE_SIG
        dashboard.BOOT_CODE_SIG = ("older",)
        try:
            st = dashboard.update_status(force=True)
            self.assertTrue(st["stale"])
            self.assertTrue(dashboard.update_status()["stale"])       # fresh even when cached
            code, resp = dashboard.update_and_restart()
            self.assertEqual(code, 200)
            self.assertEqual((resp["updated"], resp["restarting"]), (False, True))
            import time
            time.sleep(1.3)
            self.assertEqual(self.restarts, [None])     # no dashboard-rs/ here: Python again
        finally:
            dashboard.BOOT_CODE_SIG = saved

    def test_not_stale_by_default(self):
        self.assertFalse(dashboard.update_status(force=True)["stale"])

    def test_payload_carries_boot_id(self):
        self.assertEqual(len(dashboard.BOOT_ID), 16)
        self.assertIn('"boot": BOOT_ID', open(dashboard.__file__).read())


if __name__ == "__main__":
    unittest.main()


class RestartIntoRust(unittest.TestCase):
    """The update button builds dashboard-rs/ and restarts into it; Python again if it can't."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._saved = (dashboard.HERE, os.environ.get("PATH"))
        dashboard.HERE = self.tmp
        self.rust = os.path.join(self.tmp, "dashboard-rs")
        os.makedirs(self.rust)
        with open(os.path.join(self.rust, "Cargo.toml"), "w") as f:
            f.write("[package]\n")
        self.bin = os.path.join(self.tmp, "bin")
        os.makedirs(self.bin)
        os.environ["PATH"] = self.bin + os.pathsep + "/usr/bin:/bin"

    def tearDown(self):
        dashboard.HERE, path = self._saved
        os.environ["PATH"] = path
        shutil.rmtree(self.tmp, ignore_errors=True)

    def fake_cargo(self, script):
        p = os.path.join(self.bin, "cargo")
        with open(p, "w") as f:
            f.write("#!/bin/sh\n" + script)
        os.chmod(p, 0o755)

    def test_builds_the_release_binary(self):
        out = os.path.join(self.rust, "target", "release")
        self.fake_cargo('echo "$@" > "%s/args"; mkdir -p "%s"; printf "#!/bin/sh\\n" > "%s/claudehq"; chmod +x "%s/claudehq"\n'
                        % (self.tmp, out, out, out))
        binary, why = dashboard.build_rust()
        self.assertEqual((binary, why), (os.path.join(out, "claudehq"), None))
        with open(os.path.join(self.tmp, "args")) as f:
            self.assertTrue(f.read().startswith("build --release --locked --manifest-path "))

    def test_a_failed_build_says_why(self):
        self.fake_cargo('echo "error[E0308]: mismatched types" >&2; exit 101\n')
        binary, why = dashboard.build_rust()
        self.assertIsNone(binary)
        self.assertIn("mismatched types", why)

    def test_no_cargo(self):
        saved = dashboard._cargo
        dashboard._cargo = lambda: None
        try:
            self.assertEqual(dashboard.build_rust(), (None, "cargo is not installed (https://rustup.rs)"))
        finally:
            dashboard._cargo = saved

    def test_restart_execs_the_rust_binary(self):
        calls = []

        class Exec(Exception):                                    # a real execv never returns
            pass

        def execv(path, argv):
            calls.append((path, argv))
            raise Exec()
        saved = (dashboard.os.execv, dashboard.os.getppid, os.environ.pop("XPC_SERVICE_NAME", None))
        dashboard.os.execv = execv
        dashboard.os.getppid = lambda: 1                          # an orphan (nohup ... &) is not the LaunchAgent
        try:
            with self.assertRaises(Exec):
                dashboard._restart_self("/x/claudehq")
        finally:
            dashboard.os.execv, dashboard.os.getppid = saved[:2]
            if saved[2] is not None:
                os.environ["XPC_SERVICE_NAME"] = saved[2]
        self.assertEqual(calls, [("/x/claudehq", ["/x/claudehq"] + sys.argv[1:])])

