"""Now Playing for Claude HQ: what this Mac is playing, and YouTube lookups for
the listen-along rooms. Python stdlib only.

Detection asks the music apps themselves, on this machine, through AppleScript:
Spotify and Apple Music for the current track, and Chrome-family browsers or
Safari for an open YouTube Music tab. An app is only asked while it is already
running (a `tell` to an app that is not running would launch it, and one that is
not installed would pop a "where is it?" dialog), and every ask has a short
timeout. The first ask makes macOS show its one-time "HQ wants to control
Spotify" prompt; saying no just means that source is skipped.

What may leave the machine, and only through the opt-in Arena link
(`arena.music_now_put`): the track's title, artist, album, which app, its
Spotify or YouTube id, length, position and whether it is playing -- the fields
in `TRACK_KEYS`. Nothing about sessions or transcripts is read here.

YouTube lookups (`oembed`, `search`) go straight to youtube.com when someone
adds a song to a listen-along room; they carry a video id or the search words,
nothing else.
"""

import json
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

TRACK_KEYS = ("title", "artist", "album", "source", "spotifyId", "youtubeId",
              "durationMs", "positionMs", "playing")
SOURCES = ("spotify", "apple", "ytmusic")
YT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
SPOTIFY_ID_RE = re.compile(r"^[A-Za-z0-9]{22}$")
TEXT_MAX = 150
DUR_MAX_MS = 86400000
_OSA_TIMEOUT = 4.0
_HTTP_TIMEOUT = 6.0
_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"

# --------------------------------------------------------------------------- #
# Detection
# --------------------------------------------------------------------------- #

_SPOTIFY = '''
tell application id "com.spotify.client"
  set ps to player state as string
  if ps is "stopped" then return "stopped"
  set t to current track
  return ps & tab & (name of t) & tab & (artist of t) & tab & (album of t) & tab & (id of t) & tab & ((duration of t) as string) & tab & ((player position) as string)
end tell
'''

_APPLE = '''
tell application id "com.apple.Music"
  set ps to player state as string
  if ps is "stopped" then return "stopped"
  try
    set t to current track
    return ps & tab & (name of t) & tab & (artist of t) & tab & (album of t) & tab & "" & tab & (((duration of t) * 1000) as integer as string) & tab & ((player position) as string)
  on error
    return "stopped"
  end try
end tell
'''

# Chrome-family browsers share one dictionary: title + URL of every tab.
_CHROMIUM = '''
tell application "%s"
  repeat with w in windows
    repeat with t in tabs of w
      set u to URL of t
      if u starts with "https://music.youtube.com/" then return (title of t) & tab & u
    end repeat
  end repeat
end tell
return ""
'''

_SAFARI = '''
tell application "Safari"
  repeat with w in windows
    repeat with t in tabs of w
      set u to URL of t
      if u starts with "https://music.youtube.com/" then return (name of t) & tab & u
    end repeat
  end repeat
end tell
return ""
'''

# (process name as pgrep sees it, AppleScript application name)
_CHROMIUM_APPS = (
    ("Google Chrome", "Google Chrome"),
    ("Arc", "Arc"),
    ("Brave Browser", "Brave Browser"),
    ("Microsoft Edge", "Microsoft Edge"),
    ("Vivaldi", "Vivaldi"),
    ("Chromium", "Chromium"),
)


def _running(proc):
    try:
        return subprocess.run(["pgrep", "-xq", proc], timeout=2).returncode == 0
    except Exception:
        return False


def _osa(script):
    try:
        r = subprocess.run(["osascript", "-e", script], capture_output=True,
                           text=True, timeout=_OSA_TIMEOUT)
    except Exception:
        return ""
    return r.stdout.strip() if r.returncode == 0 else ""


def clean_text(s, cap=TEXT_MAX):
    """Printable characters only, whitespace folded, clipped (as the Arena does)."""
    if not isinstance(s, str):
        return ""
    s = "".join(ch if ch.isprintable() else " " for ch in s)
    return " ".join(s.split())[:cap]


def _num(s):
    """An AppleScript number as text -> float (some locales write 1,5)."""
    try:
        return float((s or "").strip().replace(",", "."))
    except Exception:
        return None


def parse_player(out, source):
    """Parse the tab-separated answer of _SPOTIFY / _APPLE into a track or None."""
    if not out or out == "stopped":
        return None
    parts = out.split("\t")
    if len(parts) < 7:
        return None
    state, name, artist, album, tid, dur, pos = parts[:7]
    title = clean_text(name)
    if not title:
        return None
    dur_ms = _num(dur)
    pos_s = _num(pos)
    track = {"title": title, "artist": clean_text(artist), "album": clean_text(album),
             "source": source, "playing": state.strip() == "playing"}
    if dur_ms is not None and 0 < dur_ms <= DUR_MAX_MS:
        track["durationMs"] = int(dur_ms)
    if pos_s is not None and pos_s >= 0:
        p = int(pos_s * 1000)
        track["positionMs"] = min(p, track.get("durationMs", DUR_MAX_MS))
    if source == "spotify":
        sid = tid.rsplit(":", 1)[-1] if tid.startswith("spotify:track:") else ""
        if SPOTIFY_ID_RE.match(sid):
            track["spotifyId"] = sid
    return track


def youtube_id_from_url(url):
    """The video id of a YouTube / YouTube Music / youtu.be link, else None."""
    if not isinstance(url, str):
        return None
    url = url.strip()
    if YT_ID_RE.match(url):
        return url
    try:
        u = urllib.parse.urlsplit(url if "://" in url else "https://" + url)
    except Exception:
        return None
    host = (u.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    if host.startswith("m."):
        host = host[2:]
    v = None
    if host == "youtu.be":
        v = u.path.strip("/").split("/")[0]
    elif host in ("youtube.com", "music.youtube.com", "youtube-nocookie.com"):
        if u.path == "/watch":
            v = (urllib.parse.parse_qs(u.query).get("v") or [""])[0]
        else:
            m = re.match(r"^/(?:embed|shorts|live|v)/([^/?#]+)", u.path)
            v = m.group(1) if m else None
    return v if v and YT_ID_RE.match(v) else None


def parse_ytmusic_tab(out):
    """Parse "title<TAB>url" of a YouTube Music tab into a track or None.

    The tab is titled "<song> - YouTube Music" while something plays, sometimes
    "<song> • <artist> - YouTube Music"; plain "YouTube Music" means nothing
    is loaded. A browser cannot tell us whether it is paused, so a loaded song
    counts as playing.
    """
    if not out or "\t" not in out:
        return None
    title, url = out.split("\t", 1)
    title = title.strip()
    for suffix in (" - YouTube Music", " – YouTube Music"):
        if title.endswith(suffix):
            title = title[: -len(suffix)]
            break
    else:
        return None
    if not title or title == "YouTube Music":
        return None
    artist = ""
    if " • " in title:
        title, artist = title.split(" • ", 1)
    track = {"title": clean_text(title), "artist": clean_text(artist), "album": "",
             "source": "ytmusic", "playing": True}
    if not track["title"]:
        return None
    vid = youtube_id_from_url(url)
    if vid:
        track["youtubeId"] = vid
    return track


def detect():
    """What this Mac is playing: the first playing source in priority order, or
    the first paused one, or None. Off macOS there is nothing to ask."""
    if sys.platform != "darwin":
        return None
    found = []
    if _running("Spotify"):
        t = parse_player(_osa(_SPOTIFY), "spotify")
        if t:
            found.append(t)
    if _running("Music"):
        t = parse_player(_osa(_APPLE), "apple")
        if t:
            found.append(t)
    if not any(t["playing"] for t in found):
        for proc, app in _CHROMIUM_APPS:
            if _running(proc):
                t = parse_ytmusic_tab(_osa(_CHROMIUM % app))
                if t:
                    found.append(t)
                    break
        else:
            if _running("Safari"):
                t = parse_ytmusic_tab(_osa(_SAFARI))
                if t:
                    found.append(t)
    for t in found:
        if t["playing"]:
            return t
    return found[0] if found else None


_cache = {"at": 0.0, "track": None}
_cache_lock = threading.Lock()


def current(max_age=4.0, with_age=False):
    """detect(), cached for `max_age` seconds so the page and the share loop
    asking at once cost one round of AppleScript. `with_age` also returns how
    old the reading is (seconds), so a clock can be anchored on it."""
    with _cache_lock:
        if time.time() - _cache["at"] < max_age:
            t, age = _cache["track"], time.time() - _cache["at"]
            return (t, age) if with_age else t
    t = detect()
    with _cache_lock:
        _cache.update(at=time.time(), track=t)
    return (t, 0.0) if with_age else t


def wire_track(t):
    """Only TRACK_KEYS, the boundary of what leaves this machine."""
    if not isinstance(t, dict):
        return None
    out = {k: t[k] for k in TRACK_KEYS if k in t and t[k] is not None}
    if out.get("source") not in SOURCES or not out.get("title"):
        return None
    return out


def same_song(a, b):
    """Same track, same play state: a position moving on is not news."""
    if not a or not b:
        return a is b
    keys = ("title", "artist", "source", "playing")
    return all(a.get(k) == b.get(k) for k in keys)


# --------------------------------------------------------------------------- #
# Sharing to the Arena
# --------------------------------------------------------------------------- #

class ShareLoop:
    """Every `every` seconds: if sharing is on, put the playing track on the
    Arena when it changes (and every `refresh` seconds so it doesn't expire),
    and take it off when the music stops or sharing is turned off.

    `enabled()` says whether to share right now; `put(track)` / `clear()` talk
    to the Arena and return an HTTP status (0 for no answer).
    """

    def __init__(self, enabled, put, clear, every=10.0, refresh=45.0):
        self.enabled, self.put, self.clear = enabled, put, clear
        self.every, self.refresh = every, refresh
        self.sent = None
        self.sent_at = 0.0
        self.last_error = None
        self.err_at = 0.0
        self._stop = threading.Event()

    def step(self, now=None, track=None, detect_fn=None):
        now = time.time() if now is None else now
        on = False
        try:
            on = bool(self.enabled())
        except Exception:
            on = False
        if not on:
            if self.sent is not None:
                self.clear()
                self.sent = None
            return
        t = track if track is not None else (detect_fn or current)()
        t = wire_track(t) if t and t.get("playing") else None
        if t is None:
            if self.sent is not None:
                self.clear()
                self.sent = None
            return
        if same_song(t, self.sent) and now - self.sent_at < self.refresh:
            return
        if self.last_error == 404 and now - self.err_at < 600:
            return   # this Arena has no music routes yet: ask again in 10 minutes, not every tick
        code = self.put(t)
        if code == 200:
            self.sent, self.sent_at, self.last_error = t, now, None
        else:
            self.last_error, self.err_at = code, now

    def run(self):
        while not self._stop.wait(self.every):
            try:
                self.step()
            except Exception:
                pass

    def start(self):
        threading.Thread(target=self.run, daemon=True, name="hq-music-share").start()
        return self

    def stop(self):
        self._stop.set()


# --------------------------------------------------------------------------- #
# YouTube lookups for listen-along rooms
# --------------------------------------------------------------------------- #

_oembed_cache = {}


def _ssl():
    # python.org builds ship without a CA bundle; arena.py already knows where
    # to find one (the macOS keychain, then certifi if present).
    try:
        import arena
        return arena._ssl_context()
    except Exception:
        return None


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": _UA, "Accept-Language": "en"})
    with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT, context=_ssl()) as r:
        return r.read(2_000_000).decode("utf-8", "replace")


def oembed(vid):
    """Title and channel of one video (YouTube's public oEmbed), or None.

    oEmbed answers 401 for a video whose owner turned embedding off: those
    come back as {"embeddable": False} so search can leave them out (they
    would only error in the room's player)."""
    if not isinstance(vid, str) or not YT_ID_RE.match(vid):
        return None
    if vid in _oembed_cache:
        return _oembed_cache[vid]
    try:
        raw = _get("https://www.youtube.com/oembed?format=json&url="
                   + urllib.parse.quote("https://www.youtube.com/watch?v=" + vid, safe=""))
        j = json.loads(raw)
        out = {"v": vid, "title": clean_text(j.get("title", "")),
               "author": clean_text(j.get("author_name", "")), "embeddable": True}
    except urllib.error.HTTPError as e:
        if e.code not in (401, 403):
            return None
        out = {"v": vid, "title": "", "author": "", "embeddable": False}
    except Exception:
        return None
    if len(_oembed_cache) > 500:
        _oembed_cache.clear()
    _oembed_cache[vid] = out
    return out


def parse_search(html, limit=6):
    """Video results out of a YouTube results page's ytInitialData."""
    out, seen = [], set()
    for m in re.finditer(r'"videoRenderer":\{"videoId":"([A-Za-z0-9_-]{11})"', html):
        vid = m.group(1)
        if vid in seen:
            continue
        seen.add(vid)
        chunk = html[m.end(): m.end() + 4000]
        tm = re.search(r'"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"', chunk)
        am = re.search(r'"ownerText":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"', chunk)
        lm = re.search(r'"lengthText":\{"accessibility":\{"accessibilityData":\{"label":"(?:[^"\\]|\\.)*"\}\},"simpleText":"([0-9:]+)"', chunk)

        def unq(s):
            try:
                return json.loads('"%s"' % s)
            except Exception:
                return s
        title = clean_text(unq(tm.group(1))) if tm else ""
        if not title:
            continue
        out.append({"v": vid, "title": title,
                    "author": clean_text(unq(am.group(1))) if am else "",
                    "length": lm.group(1) if lm else ""})
        if len(out) >= limit:
            break
    return out


def search(q, limit=6):
    """Search YouTube for `q` (no API key: reads the public results page),
    leaving out videos that can't be embedded."""
    q = clean_text(q, 120)
    if not q:
        return []
    try:
        html = _get("https://www.youtube.com/results?search_query=" + urllib.parse.quote_plus(q))
    except Exception:
        return []
    found = parse_search(html, limit * 2)
    with ThreadPoolExecutor(max_workers=6) as ex:
        checks = list(ex.map(lambda r: oembed(r["v"]), found))
    # A lookup that failed outright (None) keeps its result: only a known "no" drops one.
    return [r for r, c in zip(found, checks) if not (c and c.get("embeddable") is False)][:limit]
