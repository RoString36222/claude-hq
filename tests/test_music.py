"""music.py: Now Playing parsing, the wire boundary, the share loop, YouTube lookups."""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import music  # noqa: E402


class ParsePlayer(unittest.TestCase):
    def test_spotify(self):
        out = "playing\tOWA OWA\tLil Tecca\tDOPAMINE\tspotify:track:1lfO0bqThTLimzHsvk3LrN\t132381\t41,869"
        t = music.parse_player(out, "spotify")
        self.assertEqual(t["title"], "OWA OWA")
        self.assertEqual(t["artist"], "Lil Tecca")
        self.assertEqual(t["spotifyId"], "1lfO0bqThTLimzHsvk3LrN")
        self.assertEqual(t["durationMs"], 132381)
        self.assertEqual(t["positionMs"], 41869)   # a locale's decimal comma
        self.assertTrue(t["playing"])

    def test_apple_paused_and_stopped(self):
        t = music.parse_player("paused\tSong\tArtist\tAlbum\t\t200000\t12.5", "apple")
        self.assertFalse(t["playing"])
        self.assertNotIn("spotifyId", t)
        self.assertEqual(t["positionMs"], 12500)
        self.assertIsNone(music.parse_player("stopped", "apple"))
        self.assertIsNone(music.parse_player("", "spotify"))
        self.assertIsNone(music.parse_player("playing\t\tA\tB\t\t1\t1", "spotify"))

    def test_text_is_cleaned(self):
        t = music.parse_player("playing\tA‮B\x00  C\tX\tY\t\t1000\t0", "apple")
        self.assertEqual(t["title"], "A B C")


class YouTube(unittest.TestCase):
    def test_ids_from_links(self):
        f = music.youtube_id_from_url
        self.assertEqual(f("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3"), "dQw4w9WgXcQ")
        self.assertEqual(f("https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=x"), "dQw4w9WgXcQ")
        self.assertEqual(f("youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ")
        self.assertEqual(f("https://youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ")
        self.assertEqual(f("dQw4w9WgXcQ"), "dQw4w9WgXcQ")
        self.assertIsNone(f("https://evil.example/watch?v=dQw4w9WgXcQ"))
        self.assertIsNone(f("some song name"))
        self.assertIsNone(f(None))

    def test_ytmusic_tab(self):
        t = music.parse_ytmusic_tab("Blinding Lights • The Weeknd - YouTube Music\thttps://music.youtube.com/watch?v=4NRXx6U8ABQ")
        self.assertEqual((t["title"], t["artist"], t["youtubeId"]), ("Blinding Lights", "The Weeknd", "4NRXx6U8ABQ"))
        self.assertIsNone(music.parse_ytmusic_tab("YouTube Music\thttps://music.youtube.com/"))
        self.assertIsNone(music.parse_ytmusic_tab("Inbox - Gmail\thttps://mail.google.com/"))

    def test_search_page(self):
        html = ('..."videoRenderer":{"videoId":"Uu43993zDMA","thumbnail":{},"title":{"runs":[{"text":"F3miii - FROM YOUR EYES \\u0026 more"}]},'
                '"ownerText":{"runs":[{"text":"f3miii"}]},"lengthText":{"accessibility":{"accessibilityData":{"label":"2 minutes"}},"simpleText":"2:37"}}'
                '..."videoRenderer":{"videoId":"Uu43993zDMA"}...')
        r = music.parse_search(html)
        self.assertEqual(r, [{"v": "Uu43993zDMA", "title": "F3miii - FROM YOUR EYES & more",
                              "author": "f3miii", "length": "2:37"}])


class Boundary(unittest.TestCase):
    def test_wire_track_keeps_only_track_keys(self):
        t = {"title": "T", "source": "spotify", "playing": True, "cwd": "/Users/x/secret", "sessionId": "abc"}
        self.assertEqual(music.wire_track(t), {"title": "T", "source": "spotify", "playing": True})
        self.assertIsNone(music.wire_track({"title": "T", "source": "winamp"}))
        self.assertIsNone(music.wire_track({"source": "apple"}))


class Share(unittest.TestCase):
    def loop(self, on=True):
        calls = []
        lp = music.ShareLoop(lambda: on_box[0], put=lambda t: calls.append(("put", t["title"])) or 200,
                             clear=lambda: calls.append(("clear",)) or 200, refresh=45)
        on_box = [on]
        return lp, calls, on_box

    def test_puts_on_change_refreshes_and_clears(self):
        lp, calls, on = self.loop()
        a = {"title": "A", "artist": "x", "source": "spotify", "playing": True, "positionMs": 1}
        lp.step(now=0, track=a)
        lp.step(now=10, track=dict(a, positionMs=9000))       # same song, position moved: quiet
        lp.step(now=50, track=a)                               # refresh before the Arena's TTL
        lp.step(now=55, track=dict(a, title="B"))              # a new song
        lp.step(now=60, track=dict(a, title="B", playing=False))   # paused: off the board
        self.assertEqual(calls, [("put", "A"), ("put", "A"), ("put", "B"), ("clear",)])

    def test_turning_sharing_off_clears_once(self):
        lp, calls, on = self.loop()
        lp.step(now=0, track={"title": "A", "source": "apple", "playing": True})
        on[0] = False
        lp.step(now=5)
        lp.step(now=10)
        self.assertEqual(calls, [("put", "A"), ("clear",)])

    def test_a_failed_put_is_retried(self):
        codes = [0, 200]
        sent = []
        lp = music.ShareLoop(lambda: True, put=lambda t: sent.append(t) or codes.pop(0), clear=lambda: 200)
        t = {"title": "A", "source": "apple", "playing": True}
        lp.step(now=0, track=t)
        self.assertEqual(lp.last_error, 0)
        lp.step(now=10, track=t)
        self.assertEqual(len(sent), 2)
        self.assertIsNone(lp.last_error)


class OldArena(unittest.TestCase):
    def test_a_404_backs_off_for_ten_minutes(self):
        sent = []
        lp = music.ShareLoop(lambda: True, put=lambda t: sent.append(1) or 404, clear=lambda: 200)
        t = {"title": "A", "source": "apple", "playing": True}
        for now in (0, 10, 20, 300):
            lp.step(now=now, track=t)
        self.assertEqual(len(sent), 1)
        lp.step(now=601, track=t)
        self.assertEqual(len(sent), 2)


class LocalAudio(unittest.TestCase):
    def test_no_ytdlp_says_unavailable_before_anything_else(self):
        import tempfile
        c = music.AudioCache(tempfile.mkdtemp())
        orig = music._tool
        music._tool = lambda name: None
        try:
            self.assertEqual(c.prepare("-"), {"state": "unavailable"})
            self.assertEqual(c.prepare("dQw4w9WgXcQ"), {"state": "unavailable"})
        finally:
            music._tool = orig

    def test_a_fetched_file_is_found_and_bad_ids_never_touch_the_disk(self):
        import tempfile
        d = tempfile.mkdtemp()
        open(os.path.join(d, "dQw4w9WgXcQ.m4a"), "wb").write(b"x" * 10)
        c = music.AudioCache(d)
        self.assertEqual(c.file("dQw4w9WgXcQ")[1], "audio/mp4")
        self.assertEqual(c.file("../../etc/passwd"), (None, None))
        orig = music._tool
        music._tool = lambda name: "/bin/true"
        try:
            self.assertEqual(c.prepare("dQw4w9WgXcQ")["state"], "ready")
            self.assertEqual(c.prepare("../x"), {"state": "error", "error": "bad video id"})
        finally:
            music._tool = orig

    def test_cookie_browsers_are_an_allowlist(self):
        self.assertTrue(music.cookie_arg("operagx").startswith("opera:"))
        self.assertEqual(music.cookie_arg("chrome"), "chrome")
        self.assertIsNone(music.cookie_arg("rm -rf"))
        self.assertIsNone(music.cookie_arg(""))
        import dashboard
        self.assertEqual(dashboard.DEFAULT_CONFIG["musicCookies"], "")
        self.assertEqual(dashboard._validate_config({"musicCookies": "safari"})["musicCookies"], "safari")
        self.assertEqual(dashboard._validate_config({"musicCookies": "evil"})["musicCookies"], "")


class Config(unittest.TestCase):
    def test_music_share_defaults_on_and_validates(self):
        import dashboard
        self.assertTrue(dashboard.DEFAULT_CONFIG["musicShare"])
        self.assertFalse(dashboard._validate_config({"musicShare": False})["musicShare"])
        self.assertTrue(dashboard._validate_config({"musicShare": "yes"})["musicShare"])


if __name__ == "__main__":
    unittest.main()
