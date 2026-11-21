"""HQ Notch kitty watcher (notch/kitty/hq_notch_kitty.py): it accepts {"focus": N} and nothing
else, over a private unix socket, and never needs kitty's remote control."""
import importlib.util
import json
import os
import shutil
import socket
import stat
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
WATCHER = os.path.join(os.path.dirname(HERE), "notch", "kitty", "hq_notch_kitty.py")

spec = importlib.util.spec_from_file_location("hq_notch_kitty", WATCHER)
kw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kw)


class ParseTests(unittest.TestCase):
    def test_focus_request(self):
        self.assertEqual(kw.parse(b'{"focus":3}'), 3)
        self.assertEqual(kw.parse(b'{"focus": 12}'), 12)

    def test_anything_else_is_ignored(self):
        for bad in (b"", b"focus 3", b'{"focus":"3"}', b'{"focus":true}', b'{"focus":0}', b'{"focus":-2}',
                    b'{"focus":3.5}', b'{"focus":3,"text":"rm -rf ~"}', b'{"send_text":"ls"}', b"[3]",
                    b'{"focus":3}' + b" " * 64, b"\xff\xfe"):
            self.assertIsNone(kw.parse(bad), bad)


class SocketTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="hqk", dir="/tmp")   # short: unix socket paths are capped
        self.old = kw.DIR
        kw.DIR = os.path.join(self.dir, "HQNotch")

    def tearDown(self):
        kw.DIR = self.old
        shutil.rmtree(self.dir, ignore_errors=True)

    def send(self, path, data):
        c = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        c.connect(path)
        c.sendall(data)
        c.close()

    def test_round_trip_and_permissions(self):
        s, path = kw.listen(4242)
        try:
            self.assertEqual(path, os.path.join(kw.DIR, "kitty-4242.sock"))
            self.assertEqual(stat.S_IMODE(os.stat(kw.DIR).st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
            got = []
            kw.drain(s, got.append)                       # nothing waiting: returns at once
            self.assertEqual(got, [])
            self.send(path, json.dumps({"focus": 7}).encode())
            self.send(path, b'{"send_text":"ls"}')
            self.send(path, b'{"focus":9}\n')
            kw.drain(s, got.append)
            self.assertEqual(got, [7, 9])
        finally:
            s.close()

    def test_replaces_a_stale_socket(self):
        os.makedirs(kw.DIR, mode=0o700)
        stale = kw.socket_path(4242)
        with open(stale, "w") as f:
            f.write("stale")
        s, path = kw.listen(4242)
        try:
            self.assertTrue(stat.S_ISSOCK(os.stat(path).st_mode))
        finally:
            s.close()


if __name__ == "__main__":
    unittest.main()
