"""Issue #45: atomic local state, quarantine of corrupt state files, the safer
Close action, and the POST body cap. Everything runs against temp dirs and an
ephemeral 127.0.0.1 server; nothing touches the real state files or network.
Stdlib only.
"""
import glob
import http.client
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import arena  # noqa: E402
import dashboard  # noqa: E402

SID = "11111111-1111-4111-8111-111111111111"
MODULES = (dashboard, arena)


def _mode(path):
    return stat.S_IMODE(os.stat(path).st_mode)


class TempDirCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="hq-atomic-")

    def tearDown(self):
        for p in glob.glob(os.path.join(self.dir, "*")):
            try:
                os.chmod(p, 0o600)
            except OSError:
                pass
        shutil.rmtree(self.dir, ignore_errors=True)

    def path(self, name):
        return os.path.join(self.dir, name)

    def leftovers(self):
        return sorted(os.listdir(self.dir))


class AtomicWriteTests(TempDirCase):
    def test_writes_json_with_0600_and_no_temp_left(self):
        for mod in MODULES:
            p = self.path("state-%s.json" % mod.__name__)
            mod._atomic_write_json(p, {"a": 1})
            with open(p, encoding="utf-8") as f:
                self.assertEqual(json.load(f), {"a": 1})
            self.assertEqual(_mode(p), 0o600)
        self.assertEqual(self.leftovers(), ["state-arena.json", "state-dashboard.json"])

    def test_replaces_a_loose_existing_file_and_tightens_mode(self):
        p = self.path("config.json")
        with open(p, "w") as f:
            f.write('{"old": true}')
        os.chmod(p, 0o644)
        dashboard._atomic_write_json(p, {"new": True})
        with open(p) as f:
            self.assertEqual(json.load(f), {"new": True})
        self.assertEqual(_mode(p), 0o600)

    def test_symlinked_target_is_written_through_and_link_kept(self):
        for mod in MODULES:
            real = self.path("real-%s.json" % mod.__name__)
            link = self.path("link-%s.json" % mod.__name__)
            with open(real, "w") as f:
                f.write("{}")
            os.symlink(real, link)
            mod._atomic_write_json(link, {"via": "link"})
            self.assertTrue(os.path.islink(link))
            with open(real) as f:
                self.assertEqual(json.load(f), {"via": "link"})
            self.assertEqual(mod._load_json_guarded(link, {}), {"via": "link"})

    def test_custom_mode(self):
        p = self.path("x.json")
        dashboard._atomic_write_json(p, [], mode=0o640)
        self.assertEqual(_mode(p), 0o640)

    def test_failed_serialisation_keeps_the_old_file_and_cleans_up(self):
        for mod in MODULES:
            p = self.path("keep-%s.json" % mod.__name__)
            mod._atomic_write_json(p, {"v": 1})
            with self.assertRaises(TypeError):
                mod._atomic_write_json(p, {"v": object()})
            with open(p) as f:
                self.assertEqual(json.load(f), {"v": 1})
        self.assertEqual(self.leftovers(), ["keep-arena.json", "keep-dashboard.json"])

    def test_missing_directory_raises_oserror(self):
        for mod in MODULES:
            with self.assertRaises(OSError):
                mod._atomic_write_json(self.path("nope/x.json"), {})


class GuardedLoadTests(TempDirCase):
    def test_missing_file_returns_default(self):
        for mod in MODULES:
            self.assertEqual(mod._load_json_guarded(self.path("absent.json"), {"d": 1}), {"d": 1})
        self.assertEqual(self.leftovers(), [])

    def test_valid_file_is_parsed(self):
        p = self.path("ok.json")
        with open(p, "w") as f:
            f.write('{"k": [1, 2]}')
        for mod in MODULES:
            self.assertEqual(mod._load_json_guarded(p, {}), {"k": [1, 2]})

    def test_corrupt_file_is_quarantined_and_default_returned(self):
        for mod in MODULES:
            for junk in (b'{"half": ', b"\xff\xfe not utf8"):
                p = self.path("bad.json")
                with open(p, "wb") as f:
                    f.write(junk)
                self.assertEqual(mod._load_json_guarded(p, {}), {})
                self.assertFalse(os.path.exists(p))
                q = glob.glob(p + ".corrupt-*")
                self.assertEqual(len(q), 1, q)
                with open(q[0], "rb") as f:
                    self.assertEqual(f.read(), junk)  # evidence preserved
                os.remove(q[0])

    def test_good_file_saved_mid_read_is_not_quarantined(self):
        """Race: a reader parses corrupt bytes while a concurrent save swaps a
        valid file in; the reader must not move the fresh file aside."""
        real_loads = json.loads
        for mod in MODULES:
            p = self.path("race-%s.json" % mod.__name__)
            with open(p, "w") as f:
                f.write("{corrupt")

            def loads(text, *a, **k):
                mod._atomic_write_json(p, {"theme": "forest"})  # concurrent save
                return real_loads(text, *a, **k)

            json.loads = loads
            try:
                self.assertEqual(mod._load_json_guarded(p, {}), {})
            finally:
                json.loads = real_loads
            self.assertEqual(glob.glob(p + ".corrupt-*"), [])
            self.assertEqual(mod._load_json_guarded(p, {}), {"theme": "forest"})

    @unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0, "root reads anything")
    def test_permission_error_never_quarantines(self):
        p = self.path("locked.json")
        with open(p, "w") as f:
            f.write("{not json")
        os.chmod(p, 0)
        for mod in MODULES:
            self.assertEqual(mod._load_json_guarded(p, {"d": 0}), {"d": 0})
        self.assertEqual(self.leftovers(), ["locked.json"])


class ConfigMetaPersistenceTests(TempDirCase):
    def setUp(self):
        super().setUp()
        self._saved = (dashboard.CONFIG_PATH, dashboard.META_PATH)
        dashboard.CONFIG_PATH = self.path("config.json")
        dashboard.META_PATH = self.path("sessions-meta.json")

    def tearDown(self):
        dashboard.CONFIG_PATH, dashboard.META_PATH = self._saved
        super().tearDown()

    def test_save_config_round_trips_atomically(self):
        saved = dashboard.save_config({"dailyBudgetUSD": 25})
        self.assertEqual(dashboard.load_config(), saved)
        self.assertEqual(_mode(dashboard.CONFIG_PATH), 0o600)
        self.assertEqual(self.leftovers(), ["config.json"])

    def test_corrupt_config_is_quarantined_not_overwritten(self):
        with open(dashboard.CONFIG_PATH, "w") as f:
            f.write("{oops")
        self.assertEqual(dashboard.load_config(), dashboard._validate_config({}))
        self.assertEqual(len(glob.glob(dashboard.CONFIG_PATH + ".corrupt-*")), 1)

    def test_save_config_raises_when_unwritable(self):
        dashboard.CONFIG_PATH = self.path("missing-dir/config.json")
        with self.assertRaises(OSError):
            dashboard.save_config({"dailyBudgetUSD": 25})

    def test_save_meta_round_trips_and_raises_when_unwritable(self):
        entry = dashboard.save_meta(SID, {"pinned": True, "note": "hi"})
        self.assertEqual(dashboard.load_meta()[SID], entry)
        self.assertEqual(_mode(dashboard.META_PATH), 0o600)
        dashboard.META_PATH = self.path("missing-dir/meta.json")
        with self.assertRaises(OSError):
            dashboard.save_meta(SID, {"pinned": False})

    def test_corrupt_meta_is_quarantined(self):
        with open(dashboard.META_PATH, "w") as f:
            f.write("[[[")
        self.assertEqual(dashboard.load_meta(), {})
        self.assertEqual(len(glob.glob(dashboard.META_PATH + ".corrupt-*")), 1)


class DexSaltTests(TempDirCase):
    def setUp(self):
        super().setUp()
        self._saved = (dashboard.DEX_SEED_PATH, dashboard._dex_salt_cache)
        dashboard.DEX_SEED_PATH = self.path(".dex-seed")
        dashboard._dex_salt_cache = None

    def tearDown(self):
        dashboard.DEX_SEED_PATH, dashboard._dex_salt_cache = self._saved
        super().tearDown()

    def test_new_salt_is_written_atomically_with_0600(self):
        s = dashboard.dex_salt()
        with open(dashboard.DEX_SEED_PATH) as f:
            self.assertEqual(f.read(), s)
        self.assertEqual(_mode(dashboard.DEX_SEED_PATH), 0o600)
        self.assertEqual(self.leftovers(), [".dex-seed"])

    def test_unwritable_dir_still_returns_a_salt(self):
        dashboard.DEX_SEED_PATH = self.path("missing/.dex-seed")
        self.assertRegex(dashboard.dex_salt(), r"^[0-9a-f]{16}$")


class ArenaLinkTests(TempDirCase):
    def setUp(self):
        super().setUp()
        self._saved = (arena._link_path, arena._request, arena._load_config)
        arena._link_path = self.path("arena-link.json")
        arena._load_config = lambda: {"arenaUrl": "https://arena.example"}

    def tearDown(self):
        arena._link_path, arena._request, arena._load_config = self._saved
        super().tearDown()

    def test_save_link_is_atomic_and_private(self):
        arena.save_link({"token": "T", "url": "https://arena.example"})
        self.assertEqual(arena.load_link()["token"], "T")
        self.assertEqual(_mode(arena._link_path), 0o600)
        self.assertEqual(self.leftovers(), ["arena-link.json"])

    def test_corrupt_link_is_quarantined(self):
        with open(arena._link_path, "w") as f:
            f.write('{"token": "T"')
        self.assertEqual(arena.load_link(), {})
        self.assertEqual(len(glob.glob(arena._link_path + ".corrupt-*")), 1)

    def test_non_dict_link_reads_as_empty(self):
        with open(arena._link_path, "w") as f:
            f.write("[1, 2]")
        self.assertEqual(arena.load_link(), {})

    def test_pair_reports_a_failed_token_save(self):
        arena._link_path = self.path("missing-dir/arena-link.json")
        arena._request = lambda *a, **k: (200, {"token": "T", "handle": "ash"})
        code, resp = arena.pair("abcd")
        self.assertEqual(code, 500)
        self.assertIn("could not save", resp["error"])

    def test_pair_success_persists(self):
        arena._request = lambda *a, **k: (200, {"token": "T", "handle": "ash"})
        code, resp = arena.pair("abcd")
        self.assertEqual((code, resp.get("ok")), (200, True))
        self.assertEqual(arena.load_link()["handle"], "ash")


class ActionCloseTests(unittest.TestCase):
    def setUp(self):
        self._live = dashboard.get_live_agents
        self.agents = []
        dashboard.get_live_agents = lambda: (self.agents, None)
        self.procs = []

    def tearDown(self):
        dashboard.get_live_agents = self._live
        for p in self.procs:
            if p.poll() is None:
                p.kill()
            p.wait(5)

    def spawn(self, tag):
        p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)", tag])
        self.procs.append(p)
        return p

    def test_rejects_bad_pids(self):
        for bad in (None, "x", True, 0, 1, -5):
            code, _ = dashboard.action_close(bad)
            self.assertEqual(code, 400, bad)

    def test_refuses_the_dashboard_itself_even_if_listed(self):
        self.agents = [{"kind": "interactive", "pid": os.getpid()}]
        code, resp = dashboard.action_close(os.getpid())
        self.assertEqual(code, 400)
        self.assertIn("refusing", resp["error"])

    def test_refuses_a_pid_that_is_not_a_live_interactive_agent(self):
        p = self.spawn("claude-not-listed")
        self.agents = [{"kind": "background", "pid": p.pid}]
        code, resp = dashboard.action_close(p.pid)
        self.assertEqual(code, 400)
        self.assertIn("not a live interactive", resp["error"])
        self.assertIsNone(p.poll())  # still running

    def test_command_check_remains_a_second_guard(self):
        p = self.spawn("innocent-bystander")
        self.agents = [{"pid": p.pid}]  # kind defaults to interactive
        code, resp = dashboard.action_close(p.pid)
        self.assertEqual(code, 400)
        self.assertIn("not a Claude process", resp["error"])
        self.assertIsNone(p.poll())

    def test_refuses_a_pid_absent_from_the_agent_list(self):
        p = self.spawn("claude-unlisted")
        self.agents = [{"kind": "interactive", "pid": p.pid + 100000}]
        code, resp = dashboard.action_close(p.pid)
        self.assertEqual(code, 400)
        self.assertIn("not a live interactive", resp["error"])
        self.assertIsNone(p.poll())

    def test_agent_list_failure_is_503_with_the_cli_error(self):
        p = self.spawn("claude-session")
        dashboard.get_live_agents = lambda: ([], "claude CLI not found on PATH")
        code, resp = dashboard.action_close(p.pid)
        self.assertEqual(code, 503)
        self.assertIn("cannot verify live sessions", resp["error"])
        self.assertIn("claude CLI not found", resp["error"])
        self.assertIsNone(p.poll())

    def test_agent_without_kind_counts_as_interactive(self):
        p = self.spawn("claude-session")
        self.agents = [{"pid": p.pid}]
        code, resp = dashboard.action_close(p.pid)
        self.assertEqual((code, resp.get("pid")), (200, p.pid))
        p.wait(5)

    def test_closes_a_live_interactive_claude(self):
        p = self.spawn("claude-session")
        self.agents = [{"kind": "interactive", "pid": p.pid}, "junk", {"pid": "7"}]
        code, resp = dashboard.action_close(str(p.pid))
        self.assertEqual((code, resp.get("pid")), (200, p.pid))
        p.wait(5)
        self.assertIsNotNone(p.returncode)


class PostLimitTests(TempDirCase):
    """The real Handler on an ephemeral 127.0.0.1 port."""

    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), dashboard.Handler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(5)

    def setUp(self):
        super().setUp()
        self._saved = (dashboard.CONFIG_PATH, dashboard.META_PATH)
        dashboard.CONFIG_PATH = self.path("config.json")
        dashboard.META_PATH = self.path("sessions-meta.json")

    def tearDown(self):
        dashboard.CONFIG_PATH, dashboard.META_PATH = self._saved
        super().tearDown()

    def post(self, path, body=b"{}", length="auto"):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.putrequest("POST", path)
            conn.putheader("Content-Type", "application/json")
            conn.putheader("X-HQ-Token", dashboard.CSRF_TOKEN)
            if length == "auto":
                conn.putheader("Content-Length", str(len(body)))
            elif length is not None:
                conn.putheader("Content-Length", length)
            conn.endheaders()
            if body:
                conn.send(body)
            resp = conn.getresponse()
            return resp.status, json.loads(resp.read().decode("utf-8") or "{}")
        finally:
            conn.close()

    def test_limits(self):
        self.assertEqual(dashboard._post_body_limit("/api/config"), 1024 * 1024)
        self.assertEqual(dashboard._post_body_limit("/api/arena/sounds"), 8 * 1024 * 1024)
        # base64 of the largest allowed clip, plus JSON framing, must fit.
        self.assertGreater(dashboard.MAX_SOUND_POST_BODY,
                           dashboard.MAX_SOUND_UPLOAD * 4 // 3 + 4096)

    def test_oversize_declared_length_is_413_without_reading(self):
        code, resp = self.post("/api/config", body=b"", length=str(1024 * 1024 + 1))
        self.assertEqual(code, 413)
        code, _ = self.post("/api/arena/sounds", body=b"", length=str(8 * 1024 * 1024 + 1))
        self.assertEqual(code, 413)

    def test_missing_content_length_is_411(self):
        code, _ = self.post("/api/config", body=b"", length=None)
        self.assertEqual(code, 411)

    def test_invalid_content_length_is_400(self):
        for bad in ("abc", "-5", "1e3", "\u00b2"):
            code, _ = self.post("/api/config", body=b"", length=bad)
            self.assertEqual(code, 400, bad)

    def test_normal_config_save_succeeds(self):
        code, resp = self.post("/api/config", json.dumps({"dailyBudgetUSD": 30}).encode())
        self.assertEqual(code, 200)
        self.assertEqual(dashboard.load_config(), resp)

    def test_empty_body_with_zero_length_is_accepted(self):
        code, _ = self.post("/api/config", body=b"", length="0")
        self.assertEqual(code, 200)

    def test_config_write_failure_is_500(self):
        dashboard.CONFIG_PATH = self.path("missing-dir/config.json")
        code, resp = self.post("/api/config", json.dumps({"dailyBudgetUSD": 30}).encode())
        self.assertEqual(code, 500)
        self.assertIn("could not save", resp["error"])

    def test_meta_write_failure_is_500(self):
        dashboard.META_PATH = self.path("missing-dir/meta.json")
        code, resp = self.post("/api/meta", json.dumps(
            {"sessionId": SID, "pinned": True}).encode())
        self.assertEqual(code, 500)
        self.assertIn("could not save", resp["error"])


if __name__ == "__main__":
    unittest.main()
