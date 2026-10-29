#!/usr/bin/env python3
"""UI smoke test: start the HQ server and load the page in headless Chrome.

    python3 tools/ui_smoke.py [path/to/claudehq] [--no-3d]

Runs claudehq against a throwaway HQ folder (the frontend symlinked in, no state
files but a config.json naming a FAKE Arena) with an empty HOME, so it never
reads or writes your real sessions or settings. Fails when the page or a core
API does not answer, when an @include was left unassembled, or when the page
throws a JavaScript error while loading.

Then the 3D City runs (skipped with --no-3d, or when the world fixture is
missing): a fake Arena on a free port serves the worlds (the decompressed
tests/fixtures JSON, with an ETag and 304s): the live Commons claude-hq@3 and the
fixture island user:<id>@3 (HQ 3.15), their @2 forms, and claude-hq@1; the
Commons' HQ ranks (/v1/world/claude-hq@3/assign) and /v1/hq/open, and
headless Chrome (swiftshader WebGL, driven over the DevTools pipe) opens
`/?hqsmoke=1&...` and polls `data-hq-smoke` in real time:
  - cam=map (the whole map, from the plaza): road, shield, HQ and peer labels
    all drawn;
  - at the spawn, the plaza and the H1 hill (cam=classic): the world's tiles
    < 400 draw calls, the whole frame <= 1,200 (City Gen v4 phase 11, HQ 3.34),
    triangles < 1.5M; reports whether the mesh worker ran;
  - C0: the second load with the same profile comes from the IndexedDB cache in
    < 100 ms, and the fake Arena answered a 304;
  - underground (HQ 3.15): below the street at a metro station (HQ3D_DEBUG.transit):
    the frame's draw calls <= 240 (phase 11; 120 before HQ 3.34);
  - fallback: an Arena answering 401 on /v1/world/* -> the legacy City with the
    "not available" announce and no JavaScript error.
Stdlib only; needs Google Chrome (or Chromium) for the browser half. Never opens
a visible window.
"""
import fcntl
import gzip
import hashlib
import html
import json
import math
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
BIN = ARGS[0] if ARGS else os.path.join(ROOT, "dashboard-rs", "target", "release", "claudehq")
FIXTURE = os.path.join(ROOT, "tests", "fixtures", "claude-hq@1.json.gz")
WORLD_ID = "claude-hq@1"
# HQ 3.15 (D2): the live worlds are @3; @2 stays served for older clients. The page asks for the live Commons first.
ISLAND_UID = "0b8e4c1a-3f2d-4e5b-9a6c-7d8e9f0a1b2c"
LIVE_ID = "claude-hq@3"
WORLD_FIXTURES = {"claude-hq@1": "claude-hq@1.json.gz", "claude-hq@2": "claude-hq@2.json.gz", "claude-hq@3": "claude-hq@3.json.gz",
                  "user:%s@2" % ISLAND_UID: "island@2.json.gz", "user:%s@3" % ISLAND_UID: "island@3.json.gz"}
CHROMES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    shutil.which("google-chrome") or "", shutil.which("chromium") or "", shutil.which("chromium-browser") or "",
]
# Console output Chrome prints for a page error. Network failures are not page
# bugs here: CI has no Arena and no sprite CDN guarantees.
JS_ERRORS = ("Uncaught", "SyntaxError", "ReferenceError", "TypeError")
# how long a page may take to load the world and draw 30 frames: the cold whole-map load is ~37 s on a
# fast Mac under SwiftShader and slower on CI's shared macOS runners (the budgets below are the real checks)
SMOKE_TIMEOUT = 180.0
# cam=map waits on the page for up to 900 frames for every label kind (games/hq3d.js smokeFrame); a CI box under
# SwiftShader draws a few frames a second, so give it the time those frames take rather than failing first
MAP_TIMEOUT = 420.0
# one DevTools call while the page's main thread is busy: a cold frame links ~90 shader programs at once under
# SwiftShader (three.js blocks in WebGLProgram onFirstUse), ~12 s locally and past 30 s on CI's shared macOS runners,
# so a Runtime.evaluate queued behind it waits that long. Not a hang: the poll's own deadline (SMOKE_TIMEOUT) still holds.
EVAL_TIMEOUT = 120.0
MAX_DRAW_CALLS = 400            # the world's tiles (HQ3D_DEBUG.stats().worldDrawCalls)
MAX_TRIANGLES = 1_500_000
# the whole frame (stats().drawCalls: the renderer's own count, the shadow pass included): the synthetic city's spawn
# drew 536 when this was first measured, the Commons spawn ~550 before its airport. City Gen v4 phase 11 (HQ 3.34, the
# graphics pass) raised it from 700 to the plan's 1,200, sized for an M3 Pro and up (docs/plans/city-gen-v4.md);
# tools/graphics_tour.py holds every new piece to it, and hq3d's HQ3D_DEBUG.stats().budget states the same numbers
MAX_FRAME_CALLS = 1200
MAX_UNDER_CALLS = 240           # below the street (HQ 3.15): the surface is hidden, the metro has its own budget (120 before 3.34)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def get(url):
    with urllib.request.urlopen(url, timeout=10) as r:
        return r.status, r.read().decode("utf-8", "replace")


def fail(msg, log=""):
    print("FAIL:", msg)
    if log:
        print(log[-4000:])
    sys.exit(1)


def find_chrome():
    return next((c for c in CHROMES if c and os.path.exists(c)), None)


# ----------------------------------------------------------------- fake Arena --

def synthetic_hqs():
    """Three open HQs, one of them yours (the /v1/hq/open shape)."""
    out = []
    for i, (h, n) in enumerate([("you", "You"), ("maya", "Maya"), ("ravi", "Ravi")]):
        out.append({"userId": "00000000-0000-4000-8000-00000000000%d" % (i + 1), "handle": h, "displayName": n,
                    "trainerName": "", "avatarUrl": "", "open": True, "isYou": i == 0, "level": 3 + i,
                    "look": {}, "crew": {}})
    return {"hqs": out}


class FakeArena:
    """A loopback Arena: the world (decompressed JSON, ETag, 304 on a match),
    /v1/hq/open, everything else 404. With deny_world, /v1/world/* answers 401.
    `log` keeps (path, status) of every request."""

    def __init__(self, world_bytes, deny_world=False, worlds=None):
        # worlds: {id: decompressed JSON}; world_bytes is claude-hq@1's (always served)
        self.worlds = dict(worlds or {})
        self.worlds[WORLD_ID] = world_bytes
        self.etags = {k: '"%s"' % hashlib.sha1(v).hexdigest()[:20] for k, v in self.worlds.items()}
        self.world = world_bytes
        self.etag = self.etags[WORLD_ID]
        self.deny = deny_world
        self.log = []
        arena = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def reply(self, code, body=b"", ctype="application/json", extra=()):
                arena.log.append((self.path, code))
                self.send_response(code)
                if code != 304:
                    self.send_header("Content-Type", ctype)
                    self.send_header("Content-Length", str(len(body)))
                for k, v in extra:
                    self.send_header(k, v)
                self.end_headers()
                if code != 304:
                    self.wfile.write(body)

            def do_GET(self):
                path = self.path.split("?")[0]
                if path.startswith("/v1/world/") and arena.deny:
                    return self.reply(401, b'{"detail":"unauthorised"}')
                if path.startswith("/v1/world/") and path.endswith("/assign") and path[len("/v1/world/"):-len("/assign")] in ("claude-hq@3", "claude-hq@2"):
                    # the Commons' HQ ranks: the synthetic HQs on ranks 0, 1, 2 (yours first)
                    rows = [{"user": h["userId"], "lot_rank": i} for i, h in enumerate(synthetic_hqs()["hqs"])]
                    return self.reply(200, json.dumps(rows).encode())
                wid = path[len("/v1/world/"):] if path.startswith("/v1/world/") else None
                if wid in arena.worlds:
                    tag = arena.etags[wid]
                    if self.headers.get("If-None-Match") == tag:
                        return self.reply(304, extra=[("ETag", tag)])
                    return self.reply(200, arena.worlds[wid], extra=[("ETag", tag)])
                if path == "/v1/archipelago" and LIVE_ID in arena.worlds:
                    # the Commons and the fixture island, as an Arena at @3 lists them (cm)
                    return self.reply(200, json.dumps({"commons": {"world": LIVE_ID, "x": 0, "z": 0},
                                                       "islands": [{"owner": ISLAND_UID, "name": "Fixture Island", "world": "user:%s@3" % ISLAND_UID,
                                                                    "x": 310000, "z": 0, "tier": 5}]}).encode())
                if path == "/v1/hq/open":
                    return self.reply(200, json.dumps(synthetic_hqs()).encode())
                return self.reply(404, b'{"detail":"Not Found"}')

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = "http://127.0.0.1:%d" % self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def count(self, code):
        return sum(1 for p, c in self.log if c == code and p.startswith("/v1/world/"))

    def close(self):
        self.srv.shutdown()


def load_world():
    with gzip.open(FIXTURE, "rb") as f:
        return f.read()


def load_worlds():
    """Every fixture world the fake Arena serves besides claude-hq@1 (those present)."""
    out = {}
    for wid, name in WORLD_FIXTURES.items():
        p = os.path.join(ROOT, "tests", "fixtures", name)
        if wid != WORLD_ID and os.path.exists(p):
            with gzip.open(p, "rb") as f:
                out[wid] = f.read()
    return out


def h1_route(d):
    """The H1 highway as one polyline in scene metres, the way worldgeom.routes()
    chains it: its edges joined from the dead end farther from the centre (the
    gate) inward. Old fixtures without refs: the first graded route. Returns
    (points [(x, y, z)], stations s [m])."""
    edges = d["layers"]["roads"]["edges"]
    graded = [e for e in edges if e["class"] in ("highway", "ring")]
    key = lambda e: (e["class"], e.get("ref") if e.get("ref") is not None else "~" + str(e.get("name")))
    pick = next((e for e in graded if e.get("ref") == "H1"), None) or \
        next((e for e in graded if e["class"] == "highway"), graded[0])
    es = [e for e in graded if key(e) == key(pick)]
    at = {}
    for e in es:
        at.setdefault(e["a"], []).append(e)
        at.setdefault(e["b"], []).append(e)
    # start at a dead end of the group (a loop: anywhere)
    node = next((n for n, l in at.items() if len(l) == 1), es[0]["a"])
    chain, used, cur = [], set(), node
    e = at[node][0]
    while e and e["id"] not in used:
        used.add(e["id"])
        pts = e["points"] if e["a"] == cur else e["points"][::-1]
        chain.extend(pts if not chain else pts[1:])
        cur = e["b"] if e["a"] == cur else e["a"]
        e = next((f for f in at.get(cur, []) if f["id"] not in used), None)
    P = [(p[0] / 100.0, p[1] / 100.0, p[2] / 100.0) for p in chain]
    if P[0][0] ** 2 + P[0][2] ** 2 < P[-1][0] ** 2 + P[-1][2] ** 2:
        P = P[::-1]                       # highways run from the outer end toward the city
    S = [0.0]
    for a, b in zip(P, P[1:]):
        S.append(S[-1] + ((b[0] - a[0]) ** 2 + (b[2] - a[2]) ** 2) ** 0.5)
    return P, S


def point_at(P, S, s):
    """(x, y, z, heading) at station s; heading = atan2(dx, dz) toward larger s."""
    s = max(0.0, min(s, S[-1]))
    for i in range(1, len(P)):
        if S[i] >= s or i == len(P) - 1:
            a, b, seg = P[i - 1], P[i], S[i] - S[i - 1]
            t = (s - S[i - 1]) / seg if seg else 0.0
            return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t,
                    math.atan2(b[0] - a[0], b[2] - a[2]))
    return (P[0][0], P[0][1], P[0][2], 0.0)


def spots(world_bytes):
    """Fixed spots in scene metres: spawn (your HQ door, where hqcity3d's at() puts
    you: synthetic_hqs()' "you" sorts first by userId, so it takes the rank-0 HQ lot;
    spawn_yaw faces the door), the plaza in front of the
    fountain, the steepest stretch of H1 at least 100 m from either end ("hill",
    with hill_yaw pointing up the slope along the road), and 30 m before the first
    periodic H1 gantry, which worldgeom puts 400 m from the gate ("gantry", with
    gantry_yaw facing it). Yaws are avatar yaws: atan2(dx, dz)."""
    d = json.loads(world_bytes)
    fountain = next((s for s in d["layers"]["sites"] if s["kind"] == "fountain"), {"x": 0, "z": 0, "d": 900})
    plaza = (fountain["x"] / 100.0, (fountain["z"] + fountain["d"] / 2 + 600) / 100.0)
    P, S = h1_route(d)
    L = S[-1]
    lo, hi = (100.0, L - 100.0) if L > 260 else (L * 0.3, L * 0.7)
    best = None
    for i in range(1, len(P)):
        mid = (S[i] + S[i - 1]) / 2
        ds = S[i] - S[i - 1]
        if not (lo <= mid <= hi) or ds < 1e-6:
            continue
        g = (P[i][1] - P[i - 1][1]) / ds
        if best is None or abs(g) > abs(best[1]):
            best = (mid, g)
    hs = best[0] if best else L / 2
    hx, _, hz, hh = point_at(P, S, hs)
    if best and best[1] < 0:
        hh += math.pi                     # face up the slope
    gs = 400.0 if L > 400 else L / 2
    gx, _, gz, gh = point_at(P, S, gs - 30)
    r = lambda v: round(v, 1)
    yaw = lambda a: round(math.atan2(math.sin(a), math.cos(a)), 3)
    # hqcity3d: placeLot (building HQ_DZ=2 m in front of the lot middle), door HQ_DOOR=4.8 m
    # in front of that, you stand 2.6 m further out on the street side
    lots = sorted((l for l in d["layers"]["lots"] if l.get("kind") == "hq"), key=lambda l: (l.get("rank") or 0, l["id"]))
    spawn, spawn_yaw = None, 0.0
    if lots:
        lot = lots[0]
        sg = -1 if lot.get("facing") == "south" else 1
        rot = 0.0 if sg > 0 else math.pi
        spawn = (r(lot["x"] / 100.0), r(lot["z"] / 100.0 + sg * (2 + 4.8 + 2.6)))
        spawn_yaw = yaw(rot + math.pi)
    return {"spawn": spawn, "spawn_yaw": spawn_yaw, "plaza": (r(plaza[0]), r(plaza[1])), "hill": (r(hx), r(hz)), "hill_yaw": yaw(hh),
            "hill_grade": round(best[1], 3) if best else 0.0,
            "gantry": (r(gx), r(gz)), "gantry_yaw": yaw(gh)}


def smoke_url(base, cam=None, at=None, **extra):
    q = ["hqsmoke=1"]
    if cam:
        q.append("cam=" + cam)
    if at:
        q.append("at=%s,%s" % at)
    for k, v in extra.items():
        q.append("%s=%s" % (k, v))
    return base + "/?" + "&".join(q)


# -------------------------------------------------- Chrome over the DevTools pipe --

class Chrome:
    """Headless Chrome driven over --remote-debugging-pipe (fd 3 in, fd 4 out,
    NUL-terminated JSON). One browser, one profile; each `open` is a new tab."""

    def __init__(self, exe, profile, size=(1280, 800), extra_flags=()):
        self.size = size
        r_ours, w_chrome = os.pipe()
        r_chrome, w_ours = os.pipe()

        def wire():
            a = fcntl.fcntl(r_chrome, fcntl.F_DUPFD, 10)
            b = fcntl.fcntl(w_chrome, fcntl.F_DUPFD, 10)
            os.dup2(a, 3)
            os.dup2(b, 4)

        # HQ_GL=metal draws WebGL on the GPU (still headless: no window); the default stays software (swiftshader)
        gl = ["--use-angle=metal"] if os.environ.get("HQ_GL") == "metal" else ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
        # --mute-audio: a headless Chrome still plays sound through the speakers (engines in a test drive)
        flags = ["--headless=new", "--mute-audio"] + gl + ["--no-first-run",
                 "--no-default-browser-check", "--disable-background-timer-throttling",
                 "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
                 "--remote-debugging-pipe", "--user-data-dir=" + profile,
                 "--window-size=%d,%d" % size] + list(extra_flags) + ["about:blank"]
        self.proc = subprocess.Popen([exe] + flags, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL, preexec_fn=wire, close_fds=False)
        # close_fds=False is safe: Python's own fds are close-on-exec (PEP 446);
        # only the two dup2'd ends (3, 4) survive into Chrome.
        os.close(r_chrome)
        os.close(w_chrome)
        self.rfd, self.wfd = r_ours, w_ours
        self.next_id = 0
        self.replies = {}
        self.events = {}           # sessionId -> [event]
        self.cv = threading.Condition()
        self.alive = True
        threading.Thread(target=self._reader, daemon=True).start()
        self.call("Browser.getVersion", timeout=20)

    def _reader(self):
        buf = b""
        while True:
            try:
                chunk = os.read(self.rfd, 1 << 16)
            except OSError:
                chunk = b""
            if not chunk:
                with self.cv:
                    self.alive = False
                    self.cv.notify_all()
                return
            buf += chunk
            while b"\0" in buf:
                raw, buf = buf.split(b"\0", 1)
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                with self.cv:
                    if "id" in msg:
                        self.replies[msg["id"]] = msg
                    else:
                        self.events.setdefault(msg.get("sessionId"), []).append(msg)
                    self.cv.notify_all()

    def call(self, method, params=None, session=None, timeout=30):
        with self.cv:
            self.next_id += 1
            mid = self.next_id
        msg = {"id": mid, "method": method, "params": params or {}}
        if session:
            msg["sessionId"] = session
        os.write(self.wfd, json.dumps(msg).encode() + b"\0")
        end = time.time() + timeout
        with self.cv:
            while mid not in self.replies:
                left = end - time.time()
                if left <= 0 or not self.alive:
                    raise RuntimeError("DevTools: no answer to " + method)
                self.cv.wait(left)
            r = self.replies.pop(mid)
        if "error" in r:
            raise RuntimeError("DevTools %s: %s" % (method, r["error"]))
        return r.get("result", {})

    def open(self, url):
        return Page(self, url)

    def close(self):
        try:
            self.call("Browser.close", timeout=5)
        except Exception:
            pass
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        for fd in (self.rfd, self.wfd):
            try:
                os.close(fd)
            except OSError:
                pass


PRELUDE = 'try { localStorage.setItem("hq_notch_invite", "never"); } catch(e) {}'


class Page:
    def __init__(self, chrome, url):
        self.c = chrome
        self.target = chrome.call("Target.createTarget", {"url": "about:blank"})["targetId"]
        self.sid = chrome.call("Target.attachToTarget", {"targetId": self.target, "flatten": True})["sessionId"]
        for m in ("Runtime.enable", "Page.enable"):
            chrome.call(m, session=self.sid)
        w, h = chrome.size
        chrome.call("Emulation.setDeviceMetricsOverride",
                    {"width": w, "height": h, "deviceScaleFactor": 1, "mobile": False}, session=self.sid)
        # First-run invites (HQ Notch) would sit over the scene in every shot.
        chrome.call("Page.addScriptToEvaluateOnNewDocument", {"source": PRELUDE}, session=self.sid)
        chrome.call("Page.navigate", {"url": url}, session=self.sid)

    def eval(self, expr, timeout=EVAL_TIMEOUT):
        r = self.c.call("Runtime.evaluate", {"expression": expr, "returnByValue": True}, session=self.sid, timeout=timeout)
        return r.get("result", {}).get("value")

    def _events(self):
        with self.c.cv:
            return list(self.c.events.get(self.sid, []))

    def errors(self):
        out = []
        for e in self._events():
            if e["method"] == "Runtime.exceptionThrown":
                d = e["params"]["exceptionDetails"]
                out.append((d.get("exception") or {}).get("description") or d.get("text", "exception"))
            elif e["method"] == "Runtime.consoleAPICalled" and e["params"]["type"] == "error":
                text = " ".join(str(a.get("value", a.get("description", ""))) for a in e["params"]["args"])
                if any(k in text for k in JS_ERRORS):
                    out.append(text)
        return out

    def console(self, first=None):
        """Console lines (args joined); only those whose first arg == first when given."""
        out = []
        for e in self._events():
            if e["method"] != "Runtime.consoleAPICalled":
                continue
            args = [a.get("value", a.get("description", "")) for a in e["params"]["args"]]
            if first is None or (args and args[0] == first):
                out.append(" ".join(str(a) for a in args))
        return out

    def wait_smoke(self, timeout=SMOKE_TIMEOUT):
        """Poll data-hq-smoke in real time; '' when it never appeared."""
        end = time.time() + timeout
        while time.time() < end:
            v = self.eval("document.documentElement.dataset.hqSmoke || ''") or ""
            if v:
                return v
            time.sleep(0.25)
        return ""

    def wait_true(self, expr, timeout=SMOKE_TIMEOUT):
        end = time.time() + timeout
        while time.time() < end:
            if self.eval(expr):
                return True
            time.sleep(0.25)
        return False

    def screenshot(self, path):
        import base64
        data = self.c.call("Page.captureScreenshot", {"format": "png"}, session=self.sid, timeout=60)["data"]
        with open(path, "wb") as f:
            f.write(base64.b64decode(data))

    def close(self):
        try:
            self.c.call("Target.closeTarget", {"targetId": self.target}, timeout=10)
        except Exception:
            pass


def parse_smoke(v, timeout=SMOKE_TIMEOUT):
    """'ok {json}' -> dict; raises with the page's message otherwise."""
    if not v:
        raise RuntimeError("data-hq-smoke never appeared within %ds" % timeout)
    if not v.startswith("ok "):
        raise RuntimeError("data-hq-smoke: " + v[:500])
    return json.loads(v[3:])


def dump_dom_smoke(chrome, profile, url):
    """Fallback without the DevTools pipe: repeated --dump-dom launches with a
    growing --timeout until data-hq-smoke is set. Returns (value, error lines)."""
    for ms in (8000, 16000, 32000, 60000):
        out = subprocess.run([chrome, "--headless=new", "--mute-audio", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
                              "--no-first-run", "--user-data-dir=" + profile, "--enable-logging=stderr", "--v=0",
                              "--timeout=%d" % ms, "--dump-dom", url], capture_output=True, text=True, timeout=ms / 1000 + 60)
        errs = [ln for ln in out.stderr.splitlines() if "CONSOLE" in ln and any(k in ln for k in JS_ERRORS)]
        m = re.search(r'data-hq-smoke="([^"]*)"', out.stdout)
        if m or errs:
            return (html.unescape(m.group(1)) if m else ""), errs
    return "", []


# ----------------------------------------------------------------- the server --

def make_root(tmp, arena_url=None):
    root, home = os.path.join(tmp, "hq"), os.path.join(tmp, "home")
    os.makedirs(root)
    os.makedirs(os.path.join(home, ".claude", "projects"))
    for name in ("index.html", "ui", "games", "notch"):
        if os.path.exists(os.path.join(ROOT, name)):
            os.symlink(os.path.join(ROOT, name), os.path.join(root, name))
    if arena_url:
        set_arena(root, arena_url)
    return root, home


def set_arena(root, url):
    """config.json is re-read per request, so this re-points a running server."""
    with open(os.path.join(root, "config.json"), "w") as f:
        json.dump({"arenaUrl": url}, f)


def start_server(tmp, root, home):
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    log_path = os.path.join(tmp, "server.log")
    env = dict(os.environ, HOME=home, CLAUDEHQ_ROOT=root)
    with open(log_path, "w") as log:
        server = subprocess.Popen([BIN, "--no-open", "--port", str(port), "--root", root],
                                  env=env, stdout=log, stderr=subprocess.STDOUT)
    for _ in range(60):
        try:
            if get(base + "/")[0] == 200:
                return server, base, log_path
        except OSError:
            pass
        if server.poll() is not None:
            fail("the server exited while starting", open(log_path).read())
        time.sleep(0.5)
    fail("the server never answered GET /", open(log_path).read())


def stop_server(server):
    server.terminate()
    try:
        server.wait(timeout=10)
    except subprocess.TimeoutExpired:
        server.kill()


# ----------------------------------------------------------------- the 3D runs --

def run_3d(chrome_exe, tmp, root, base, arena, world):
    shown = arena.worlds.get(LIVE_ID) or world        # the page builds the live Commons when the Arena has it
    sp = spots(shown)
    profile = os.path.join(tmp, "chrome-3d")
    try:
        br = Chrome(chrome_exe, profile)
    except Exception as e:  # no pipe support: the slower dump-dom path
        print(f"note: DevTools pipe unavailable ({e}); falling back to --dump-dom launches")
        return run_3d_dump_dom(chrome_exe, tmp, root, base, arena, sp)
    try:
        results = {}

        def one(name, url, timeout=SMOKE_TIMEOUT):
            pg = br.open(url)
            try:
                v = pg.wait_smoke(timeout)
                errs = pg.errors()
                if errs:
                    fail(f"{name}: the page threw:\n" + "\n".join(errs[:20]))
                try:
                    s = parse_smoke(v, timeout)
                except RuntimeError as e:
                    fail(f"{name}: {e}", "\n".join(pg.console()[-40:]))
                results[name] = s
                return s
            finally:
                pg.close()

        # 1. the map, first load: fetched from the Arena (200)
        # the whole map (span 2048) from the plaza: a highway (shields), the HQs and the
        # synthetic friend all in view; nearer the door the friend's tag loses to your HQ's
        s = one("map", smoke_url(base, "map", sp["plaza"], span=2048), MAP_TIMEOUT)
        lb = s.get("labels") or {}
        missing = [k for k in ("roads", "shields", "hqs", "peers") if not (lb.get(k) or 0) > 0]
        if missing:
            fail("cam=map drew no labels for: " + ", ".join(missing) + f" ({lb})")
        print(f"ok  cam=map labels {lb}")
        if arena.count(200) < 1:
            fail("the first load never fetched the world from the Arena", repr(arena.log))
        # 2. the three spots; the first of them is the second load (C0)
        for i, (name, at, ex) in enumerate([("spawn", None, {}), ("plaza", sp["plaza"], {}),
                                            ("hill", sp["hill"], {"yaw": sp["hill_yaw"]})]):
            s = one(name, smoke_url(base, "classic", at, **ex))
            dc, tri = s.get("drawCalls"), s.get("triangles")
            wdc = s.get("worldDrawCalls") if s.get("worldDrawCalls") is not None else dc
            wtri = s.get("worldTriangles") if s.get("worldTriangles") is not None else tri
            if not all(isinstance(v, (int, float)) and v > 0 for v in (dc, tri, wdc, wtri)):
                fail(f"{name}: no drawCalls/triangles in {s} (a 0 is a failed measurement)")
            if wdc >= MAX_DRAW_CALLS or wtri >= MAX_TRIANGLES:
                fail(f"{name}: over budget: the world's {wdc} draw calls (< {MAX_DRAW_CALLS}), {wtri} triangles (< {MAX_TRIANGLES})")
            if dc > MAX_FRAME_CALLS or tri >= MAX_TRIANGLES:
                fail(f"{name}: over budget: the frame's {dc} draw calls (<= {MAX_FRAME_CALLS}), {tri} triangles (< {MAX_TRIANGLES})")
            print(f"ok  cam=classic at {name} {at or ''}: frame {dc} draw calls / {tri} triangles, world {wdc} / {wtri}, worker {s.get('worker')}")
            if i == 0:
                cache = s.get("cache")
                if not isinstance(cache, (int, float)) or cache >= 100:
                    fail(f"C0: the second load's cache time is {cache!r} ms, want < 100")
                if arena.count(304) < 1:
                    fail("C0: the fake Arena never answered a 304", repr(arena.log))
                print(f"ok  C0 second load from cache in {cache} ms, Arena 304s: {arena.count(304)}")
        # 3. below the street (HQ 3.15): the first metro station, its platform, the underground view
        if LIVE_ID in arena.worlds:
            pg = br.open(smoke_url(base, "chase", sp["plaza"]))
            try:
                pg.wait_smoke()
                st = pg.eval("(function(){ var T = window.HQ3D_DEBUG && HQ3D_DEBUG.transit; if(!T) return null; var s = T.stops('metro')[0]; return s ? JSON.stringify(T.go(s.id)) : null; })()")
                if not st:
                    fail("underground: HQ3D_DEBUG.transit has no metro station", "\n".join(pg.console()[-40:]))
                time.sleep(3)
                v = json.loads(pg.eval("JSON.stringify(HQ3D_DEBUG.stats())") or "{}")
                errs = pg.errors()
                if errs:
                    fail("underground: the page threw:\n" + "\n".join(errs[:20]))
                dc = v.get("drawCalls")
                if not v.get("underground"):
                    fail(f"underground: not below the street at {st} ({v})")
                if not isinstance(dc, (int, float)) or dc <= 0 or dc > MAX_UNDER_CALLS:
                    fail(f"underground: the frame's {dc} draw calls (<= {MAX_UNDER_CALLS}) at {st}; transit {v.get('transit')}")
                print(f"ok  underground at {json.loads(st).get('name')}: frame {dc} draw calls / {v.get('triangles')} triangles, transit {v.get('transitDrawCalls')}")
            finally:
                pg.close()
        return results
    finally:
        br.close()


def run_3d_dump_dom(chrome_exe, tmp, root, base, arena, sp):
    profile = os.path.join(tmp, "chrome-3d-dd")
    for name, cam, at, ex in [("map", "map", sp["plaza"], {"span": 2048}), ("spawn", "classic", None, {}), ("plaza", "classic", sp["plaza"], {}),
                              ("hill", "classic", sp["hill"], {"yaw": sp["hill_yaw"]})]:
        v, errs = dump_dom_smoke(chrome_exe, profile, smoke_url(base, cam, at, **ex))
        if errs:
            fail(f"{name}: the page threw:\n" + "\n".join(errs[:20]))
        try:
            s = parse_smoke(v)
        except RuntimeError as e:
            fail(f"{name}: {e}")
        print(f"ok  {name}: {s}")
        if name == "spawn" and not (isinstance(s.get("cache"), (int, float)) and s["cache"] < 100 and arena.count(304)):
            fail(f"C0 failed: cache {s.get('cache')!r}, 304s {arena.count(304)}")


def run_fallback(chrome_exe, tmp, root, base, world):
    """An Arena that refuses the world: the legacy City, announced, no error."""
    deny = FakeArena(world, deny_world=True)
    set_arena(root, deny.url)
    try:
        br = Chrome(chrome_exe, os.path.join(tmp, "chrome-fallback"))
    except Exception as e:
        print(f"note: fallback run skipped, DevTools pipe unavailable ({e})")
        deny.close()
        return
    try:
        pg = br.open(smoke_url(base))
        seen = pg.wait_true("(document.body && document.body.textContent || '').indexOf('not available') >= 0")
        v = pg.eval("document.documentElement.dataset.hqSmoke || ''") or ""
        errs = pg.errors()
        if errs:
            fail("fallback: the page threw:\n" + "\n".join(errs[:20]))
        if not seen:
            fail("fallback: no 'not available' announce within %ds" % SMOKE_TIMEOUT, "\n".join(pg.console()[-40:]))
        if v.startswith("error"):
            fail("fallback: data-hq-smoke " + v[:300])
        if deny.count(401) < 1:
            fail("fallback: the page never asked the Arena for the world", repr(deny.log))
        print("ok  fallback: Arena 401 -> legacy City, announced 'not available', no JavaScript errors")
    finally:
        br.close()
        deny.close()


def main():
    if not os.access(BIN, os.X_OK):
        fail(f"no claudehq binary at {BIN} (cargo build --release --manifest-path dashboard-rs/Cargo.toml)")
    do_3d = "--no-3d" not in sys.argv
    world = load_world() if do_3d and os.path.exists(FIXTURE) else None
    if do_3d and world is None:
        print(f"note: {FIXTURE} missing; skipping the 3D runs")
    tmp = tempfile.mkdtemp(prefix="hq-ui-smoke-")
    arena = FakeArena(world, worlds=load_worlds()) if world else None
    root, home = make_root(tmp, arena.url if arena else None)
    server, base, log_path = start_server(tmp, root, home)
    try:
        status, page = get(base + "/")
        if "@include" in page:
            fail("GET / still contains an @include line: the page was not assembled")
        print(f"ok  GET / -> {status}, {len(page)} bytes, fully assembled")
        for path in ("/api/sessions", "/api/config", "/api/server-stats"):
            status, body = get(base + path)
            json.loads(body)
            print(f"ok  GET {path} -> {status}, JSON")

        chrome = find_chrome()
        if not chrome:
            fail("no Chrome/Chromium found for the browser check")
        # --dump-dom waits for the load event. Third-party sprite hotlinks are
        # allowed to fail (monsterSVG is the fallback) but a slow CDN can stall
        # load forever — that is what hung CI. Map every host to NOTFOUND so
        # those requests die instantly, and keep a wall-clock kill as the
        # backstop (Chrome's --timeout is not a wall clock here). Do not pass
        # --virtual-time-budget: virtual time freezes while a request is in
        # flight and hangs worse.
        cmd = [
            chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
            "--disable-extensions", "--disable-background-networking",
            "--disable-component-update", "--disable-default-apps", "--disable-sync",
            "--disable-translate", "--metrics-recording-only", "--mute-audio",
            "--no-default-browser-check", "--disable-dev-shm-usage",
            "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
            f"--user-data-dir={os.path.join(tmp, 'chrome')}",
            "--enable-logging=stderr", "--v=0",
            "--dump-dom", base + "/",
        ]
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, start_new_session=True)
        try:
            out, err = proc.communicate(timeout=30)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(proc.pid), 9)
            except OSError:
                proc.kill()
            try:
                out, err = proc.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                out, err = "", ""
            fail(f"headless Chrome did not dump the DOM in 30s (exit {proc.poll()})", err)
        console = [ln for ln in err.splitlines() if "CONSOLE" in ln]
        errors = [ln for ln in console if any(k in ln for k in JS_ERRORS)]
        if errors:
            fail("the page threw while loading:\n" + "\n".join(errors[:20]))
        if "<body" not in out or len(out) < 10000:
            fail("Chrome rendered an empty page", err)
        print(f"ok  headless Chrome loaded the page: {len(out)} bytes of DOM, "
              f"{len(console)} console lines, no JavaScript errors")

        if world:
            run_3d(chrome, tmp, root, base, arena, world)
            run_fallback(chrome, tmp, root, base, world)
    finally:
        stop_server(server)
        if arena:
            arena.close()
        shutil.rmtree(tmp, ignore_errors=True)
    print("UI smoke test passed")


if __name__ == "__main__":
    main()
