"""
Blaster Arena for the Valley (g = "fps"): a first-person free-for-all for up to 8, and
its referee.

Each player runs and aims in the browser (games/fps.js) and streams where they are; the
server runs a 20 Hz tick (app/realtime.py) that checks every move, judges every shot,
keeps the score and sends the lobby one batched snapshot per tick. Movement is checked
the way Kart Racing checks a car (no faster than a runner can go, measured on the
sender's own clock; not inside a wall; inside the arena); shots are decided here with
lag compensation:

  The shooter sees everyone else ~100 ms in the past (snapshot interpolation) plus the
  network delay. So a "fire" carries the shooter's clock (q), the snapshot tick it had
  last seen (k) and the interpolation delay it was drawing with (ip). The server maps q
  onto its own clock (the smallest arrival offset seen from that sender), takes off the
  shooter's round trip (measured here from snapshot acknowledgements, never claimed by
  the client) and the interpolation delay (capped at IP_CAP), and rewinds every target
  to that moment in the short position history it keeps for each player. The ray is
  then tested against the rewound hit boxes and the arena's solid boxes (no hits
  through walls). However far the client claims to be behind, the claimed part never
  exceeds IP_CAP, and the whole rewind never exceeds HISTORY.

The arena lives in fps_map.json (a byte copy of games/fps/map.json): axis-aligned solid
boxes (metres; collision for the players and occlusion for the shots), spawn points,
pickups and the practice range's drone paths. The shared geometry below mirrors the
FPS-SHARED block of games/fps.js (tests/test_fps_sync.py runs both).

Units on the wire: x, y, z in centimetres, yaw and pitch in hundredths of a degree
(yaw 0 looks north, -z; 90 east, +x; pitch up is positive), the sender's clock in
centiseconds (q). Nothing transcript-derived ever travels.
"""
import json
import math
import os
from collections import deque
from typing import Any

# --- movement (shared with games/fps.js) ---
R = 0.35                 # half the width of a player's collision box (m)
H = 1.8                  # its height; positions are the feet
EYE = 1.6                # eye height above the feet
STEP_H = 0.55            # a ledge this high is stepped onto while walking
RUN = 6.0                # m/s
ACCEL = 12.0             # how fast the run speed follows the stick on the ground (1/s)
AIR_ACCEL = 3.0          # ... and in the air
GRAVITY = 18.0           # m/s^2
JUMP_V = 6.5             # take-off speed (a ~1.17 m jump)
FALL_MAX = 25.0          # terminal fall speed

# --- weapons (shared with games/fps.js) ---
WEAPONS = (
    {"id": "rapid", "name": "Rapid blaster", "interval": 0.1, "damage": 12, "head": 18, "mag": 30,
     "reserve": 90, "reload": 1.6, "spread": 1.2, "range": 60.0, "auto": True, "pack": 60},
    {"id": "heavy", "name": "Heavy blaster", "interval": 0.8, "damage": 55, "head": 85, "mag": 6,
     "reserve": 18, "reload": 2.0, "spread": 0.3, "range": 80.0, "auto": False, "pack": 12},
)
SWITCH = 0.25            # s after a weapon switch before it fires
HP = 100
HEAL = 50                # a health pack
BODY_R = 0.4             # hit boxes around a player's feet position: body ...
BODY_H = 1.4
HEAD_R = 0.25            # ... and head
HEAD_TOP = 1.9

# --- referee ---
HZ = 20                  # server ticks per second while a match is on
MAX_SPEED = 7.5          # m/s across the ground; the browser runs at 6
SLACK = 1.0              # m allowed on top of speed x dt (bunched frames)
SHRINK = 0.05            # a position may touch a wall by this much (float noise)
MAX_AIR = 2.0            # s off the ground before a position is not believed
CLOCK_LEAD = 0.6         # s a sender's clock may run ahead of ours, summed over the match
POS_RATE = 25.0          # position frames per second per player (clients send 20)
POS_BURST = 10
FIRE_RATE = 15.0         # fire ops per second per player (the rapid blaster fires 10)
FIRE_BURST = 6
OP_RATE = 6.0            # reload / weapon ops per second
OP_BURST = 4
FIX_GAP = 0.5            # at most one correction per this long
ORIGIN_SLACK = 1.0       # m a shot may start from the shooter's last known eye
FIRE_LATE = 0.5          # s: a shot's own clock may be at most this far behind its arrival
IP_CAP = 0.35            # s of interpolation delay a client may claim (100 ms + jitter buffer)
RTT_CAP = 0.4            # s of measured round trip that is compensated
RTT_WINDOW = 3.0         # s of acknowledgements the round trip is the minimum of
HISTORY = 1.2            # s of position history per player (>= the largest rewind)
COUNTDOWN = 4.0          # s from "start" to "go"
RESPAWN = 3.0            # s dead before respawning
PROTECT = 1.5            # s of spawn protection (ends early when you fire)
PICK_R = 1.1             # m to walk over a pickup
PICKUP_BACK = 15.0       # s before a taken pickup is back
GRACE = 15.0             # s a dropped player's score waits on the board for a rejoin
MINUTES = (3, 5, 10)
KILLS = (10, 20, 30)
MAX_PLAYERS = 8
CHARS = 6                # the Mini Characters looks

_HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(_HERE, "fps_map.json"), encoding="utf-8") as _f:
    DATA = json.load(_f)


def compile_map(d: dict) -> dict:
    boxes = [tuple(float(v) for v in b[:6]) for b in d["boxes"]]
    for b in boxes:
        if not (b[0] < b[3] and b[1] < b[4] and b[2] < b[5]):
            raise ValueError("box with no volume")
    return {"id": d["id"], "name": d["name"], "bounds": tuple(float(v) for v in d["bounds"]), "boxes": boxes,
            "spawns": [tuple(float(v) for v in s) for s in d["spawns"]],
            "pickups": [{"id": p["id"], "kind": p["kind"], "at": tuple(float(v) for v in p["at"])} for p in d["pickups"]],
            "targets": d.get("targets", [])}


MAP = compile_map(DATA)


# ------------------------------------------------------- shared geometry --
def overlaps(m: dict, x: float, y: float, z: float, shrink: float = 0.0) -> int:
    """Index of the first solid box a player standing at (x, y, z) is inside, else -1.
    Touching is not inside."""
    x0, x1 = x - R + shrink, x + R - shrink
    y0, y1 = y + shrink, y + H - shrink
    z0, z1 = z - R + shrink, z + R - shrink
    for i, b in enumerate(m["boxes"]):
        if x1 > b[0] and x0 < b[3] and y1 > b[1] and y0 < b[4] and z1 > b[2] and z0 < b[5]:
            return i
    return -1


def top_under(m: dict, x: float, y: float, z: float) -> float | None:
    """The highest box top under a player at (x, y, z) among the boxes it overlaps."""
    best = None
    x0, x1, z0, z1 = x - R, x + R, z - R, z + R
    for b in m["boxes"]:
        if x1 > b[0] and x0 < b[3] and y + H > b[1] and y < b[4] and z1 > b[2] and z0 < b[5]:
            if best is None or b[4] > best:
                best = b[4]
    return best


def move(m: dict, s: dict, wx: float, wz: float, jump: bool, dt: float) -> dict:
    """One step of the runner: s = {x, y, z, vx, vy, vz, g (on the ground)}; (wx, wz) the
    wished direction in world space (length <= 1). Mutates and returns s. Axis by axis
    against the solid boxes; a low ledge is stepped onto while on the ground."""
    k = min(1.0, dt * (ACCEL if s["g"] else AIR_ACCEL))
    s["vx"] += (wx * RUN - s["vx"]) * k
    s["vz"] += (wz * RUN - s["vz"]) * k
    if jump and s["g"]:
        s["vy"] = JUMP_V
        s["g"] = False
    s["vy"] = max(-FALL_MAX, s["vy"] - GRAVITY * dt)
    for ax in ("x", "z"):
        old = s[ax]
        s[ax] = old + s["v" + ax] * dt
        i = overlaps(m, s["x"], s["y"], s["z"])
        if i >= 0:
            top = m["boxes"][i][4]
            if s["g"] and 0.0 < top - s["y"] <= STEP_H and overlaps(m, s["x"], top, s["z"]) < 0:
                s["y"] = top
            else:
                s[ax] = old
                s["v" + ax] = 0.0
    ny = s["y"] + s["vy"] * dt
    if overlaps(m, s["x"], ny, s["z"]) < 0:
        s["y"] = ny
        s["g"] = False
    elif s["vy"] <= 0.0:
        top = top_under(m, s["x"], ny, s["z"])
        if top is not None and top <= s["y"] + 1e-9:
            s["y"] = top
        s["vy"] = 0.0
        s["g"] = True
    else:
        s["vy"] = 0.0
    return s


def dir_of(yaw: float, pitch: float) -> tuple[float, float, float]:
    """Unit view direction for yaw/pitch in degrees (yaw 0 = -z, 90 = +x; pitch up +)."""
    y, p = math.radians(yaw), math.radians(pitch)
    cp = math.cos(p)
    return math.sin(y) * cp, math.sin(p), -math.cos(y) * cp


def mb32(a: int) -> float:
    """mulberry32, one draw: the same 32-bit integer steps as the browser's."""
    a = (a + 0x6D2B79F5) & 0xFFFFFFFF
    t = _imul(a ^ (a >> 15), 1 | a)
    t = ((t + _imul(t ^ (t >> 7), 61 | t)) & 0xFFFFFFFF) ^ t
    return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296


def _imul(a: int, b: int) -> int:
    return (a * b) & 0xFFFFFFFF


def spread_of(n: int, w: int) -> tuple[float, float]:
    """The deterministic spread (degrees of yaw, pitch) of a player's n-th shot."""
    s = WEAPONS[w]["spread"]
    seed = (n * 2654435761 + w * 40503) & 0xFFFFFFFF
    return (mb32(seed) * 2 - 1) * s, (mb32(seed ^ 0x5BD1E995) * 2 - 1) * s


def ray_box(o: tuple, d: tuple, b: tuple) -> float | None:
    """Distance along the ray o + t d (t >= 0) to the box (x0, y0, z0, x1, y1, z1); 0 if
    o is inside it; None if it misses."""
    tmin, tmax = 0.0, math.inf
    for a in range(3):
        if abs(d[a]) < 1e-12:
            if o[a] < b[a] or o[a] > b[a + 3]:
                return None
        else:
            inv = 1.0 / d[a]
            t1 = (b[a] - o[a]) * inv
            t2 = (b[a + 3] - o[a]) * inv
            if t1 > t2:
                t1, t2 = t2, t1
            if t1 > tmin:
                tmin = t1
            if t2 < tmax:
                tmax = t2
            if tmin > tmax:
                return None
    return tmin


def ray_map(m: dict, o: tuple, d: tuple, maxd: float) -> float:
    """Distance to the first solid box along the ray, or maxd."""
    best = maxd
    for b in m["boxes"]:
        t = ray_box(o, d, b)
        if t is not None and t < best:
            best = t
    return best


def hit_boxes(x: float, y: float, z: float) -> tuple[tuple, tuple]:
    return ((x - BODY_R, y, z - BODY_R, x + BODY_R, y + BODY_H, z + BODY_R),
            (x - HEAD_R, y + BODY_H, z - HEAD_R, x + HEAD_R, y + HEAD_TOP, z + HEAD_R))


def ray_player(o: tuple, d: tuple, x: float, y: float, z: float, maxd: float) -> tuple[float, bool] | None:
    """(distance, head?) where the ray first meets a player standing at (x, y, z), if
    nearer than maxd."""
    body, head = hit_boxes(x, y, z)
    tb, th = ray_box(o, d, body), ray_box(o, d, head)
    best = None
    if tb is not None and tb < maxd:
        best = (tb, False)
    if th is not None and th < maxd and (best is None or th < best[0]):
        best = (th, True)
    return best


def target_at(tg: dict, t: float) -> tuple[float, float, float]:
    """A practice drone's centre at time t: back and forth between a and b at s m/s."""
    a, b, s = tg["a"], tg["b"], float(tg["s"])
    ln = math.dist(a, b) or 1.0
    ph = (t * s / ln) % 2.0
    u = ph if ph <= 1.0 else 2.0 - ph
    return tuple(a[i] + (b[i] - a[i]) * u for i in range(3))


def as_num(v: Any, lo: float, hi: float) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or v in (float("inf"), float("-inf")):
        return None
    return min(hi, max(lo, float(v)))


# ----------------------------------------------------------------- referee --
class Fps:
    """One room's match. idle -> warmup (countdown) -> round -> done; the host starts the
    next one from done or idle. Players who join the lobby mid-round drop in."""

    def __init__(self) -> None:
        self.m = MAP
        self.phase = "idle"
        self.minutes = 5
        self.limit = 20
        self.go_at = 0.0
        self.ends_at = 0.0
        self.players: dict[str, dict] = {}
        self.chars: dict[str, int] = {}             # user_id -> look, kept between matches
        self.results: list[dict] | None = None
        self.items: list[float | None] = []         # per pickup: None = there, else when it returns
        self.dirty: set[str] = set()
        self.shots: list[list] = []                 # judged since the last snapshot
        self.pending: list[tuple[str, dict]] = []   # kills, pickups: out with the next tick
        self.k = 0                                  # tick number
        self.sent: deque = deque()                  # (tick, time) of the snapshots sent

    # -- views --
    def ms_left(self, t: float) -> int:
        if self.phase == "round":
            return max(0, int((self.ends_at - t) * 1000))
        return int(self.minutes * 60000) if self.phase == "warmup" else 0

    def _pub(self, uid: str, p: dict) -> dict:
        return {"user": p["user"], "slot": p["slot"], "char": p["char"], "kills": p["kills"], "deaths": p["deaths"],
                "hp": p["hp"], "dead": p["dead"], "away": p["away"] is not None, "gone": p["gone"], "w": p["w"],
                "x": round(p["x"] * 100), "y": round(p["y"] * 100), "z": round(p["z"] * 100), "r": p["r"],
                "e": p["life"]}

    def view(self, t: float) -> dict:
        return {"map": self.m["id"], "phase": self.phase, "minutes": self.minutes, "limit": self.limit,
                "goInMs": max(0, int((self.go_at - t) * 1000)) if self.phase == "warmup" else 0,
                "msLeft": self.ms_left(t), "players": [self._pub(u, p) for u, p in self.players.items()],
                "items": [1 if a is None else 0 for a in self.items], "results": self.results,
                "chars": dict(self.chars)}

    def order(self) -> list[str]:
        return [u for u, _ in sorted(self.players.items(),
                                     key=lambda it: (-it[1]["kills"], it[1]["deaths"], it[1]["slot"]))]

    # -- setup --
    def char(self, uid: str, msg: dict) -> int | None:
        c = as_num(msg.get("c"), -1, CHARS)
        if c is None or c != int(c) or not 0 <= c < CHARS:
            return None
        self.chars[uid] = int(c)
        if uid in self.players:
            self.players[uid]["char"] = int(c)
        return int(c)

    def _new(self, pub: dict, slot: int, uid: str, t: float) -> dict:
        return {"user": pub, "slot": slot, "char": self.chars.get(uid, slot % CHARS),
                "x": 0.0, "y": 0.0, "z": 0.0, "r": 0, "pt": 0, "hp": HP, "w": 0,
                "mag": [w["mag"] for w in WEAPONS], "res": [w["reserve"] for w in WEAPONS],
                "last": [deque(), deque()], "ready": -(1 << 30), "reload": None, "n": 0,
                "kills": 0, "deaths": 0, "dead": False, "respawn_at": 0.0, "life": 0, "spawn_t": t,
                "protect": 0.0, "away": None, "gone": False,
                "q": None, "q0": 0, "t0": t, "off": None, "qmax": None, "at": t, "air_at": t,
                "pb": [float(POS_BURST), t], "fb": [float(FIRE_BURST), t], "ob": [float(OP_BURST), t],
                "fix_at": -1e9, "sync_at": -1e9, "bad": 0, "hist": deque(), "rtts": deque(), "rtt": 0.0}

    def _place(self, p: dict, i: int, t: float) -> None:
        sx, sy, sz, yaw = self.m["spawns"][i]
        p.update(x=sx, y=sy, z=sz, r=int(yaw * 100) % 36000, pt=0, hp=HP, dead=False, w=p["w"],
                 mag=[w["mag"] for w in WEAPONS], res=[w["reserve"] for w in WEAPONS], reload=None,
                 spawn_t=t, protect=t + PROTECT, air_at=t, n=0)     # the spread sequence restarts each life
        p["life"] += 1
        p["hist"] = deque([(t, sx, sy, sz)])

    def start(self, members: dict[str, dict], minutes: Any, kills: Any, t: float) -> str | None:
        if self.phase in ("warmup", "round"):
            return "a match is already on: the host can end it first"
        mi, ki = as_num(minutes, 0, 1000), as_num(kills, 0, 1000)
        self.minutes = int(mi) if mi is not None and int(mi) in MINUTES else 5
        self.limit = int(ki) if ki is not None and int(ki) in KILLS else 20
        self.phase = "warmup"
        self.go_at = t + COUNTDOWN
        self.results = None
        self.players = {}
        self.items = [None] * len(self.m["pickups"])
        self.shots, self.pending = [], []
        self.sent = deque()
        n = len(self.m["spawns"])
        for k, (uid, pub) in enumerate(list(members.items())[:MAX_PLAYERS]):
            p = self.players[uid] = self._new(pub, k, uid, t)
            self._place(p, (k * 5) % n, t)
        self.dirty = set(self.players)
        return None

    def end(self) -> None:
        self.phase = "idle"
        self.players = {}
        self.results = None
        self.shots, self.pending = [], []

    def running(self) -> bool:
        return self.phase in ("warmup", "round")

    def active(self) -> list[str]:
        return [u for u, p in self.players.items() if not p["gone"]]

    # -- comings and goings --
    def enter(self, uid: str, pub: dict, t: float) -> bool:
        """A lobby member (re)joined while a match is on: a dropped player gets their score
        back; someone new drops in (and spawns on the next tick). True if the match changed."""
        if not self.running():
            return False
        p = self.players.get(uid)
        if p is not None:
            was_gone = p["gone"]
            p["away"], p["gone"], p["user"] = None, False, pub
            p["q"], p["off"], p["qmax"] = None, None, None      # a reloaded page starts a new clock
            p["rtts"] = deque()
            p["pb"], p["fb"], p["ob"] = [float(POS_BURST), t], [float(FIRE_BURST), t], [float(OP_BURST), t]
            if was_gone and self.phase == "round" and not p["dead"]:
                p["dead"], p["respawn_at"] = True, t           # back from the bench: a fresh spawn
            self.dirty.add(uid)
            return True
        if len(self.active()) >= MAX_PLAYERS:
            return False
        slot = 1 + max((q["slot"] for q in self.players.values()), default=-1)
        p = self.players[uid] = self._new(pub, slot, uid, t)
        if self.phase == "warmup":
            self._place(p, (slot * 5) % len(self.m["spawns"]), t)
        else:
            p["dead"], p["respawn_at"] = True, t
        self.dirty.add(uid)
        return True

    def drop(self, uid: str, t: float, blip: bool = False) -> bool:
        """A player left. A dropped socket (blip) keeps their place for GRACE seconds; an
        explicit leave benches them at once. Their score stays on the board either way."""
        p = self.players.get(uid)
        if p is None or not self.running() or p["gone"]:
            return False
        if blip:
            p["away"] = t
        else:
            p["gone"] = True
        self.dirty.add(uid)
        return True

    # -- clocks --
    def _bucket(self, b: list, rate: float, burst: float, t: float) -> bool:
        b[0] = min(float(burst), b[0] + (t - b[1]) * rate)
        b[1] = t
        if b[0] < 1.0:
            return False
        b[0] -= 1.0
        return True

    def _lead_ok(self, p: dict, q: int, t: float) -> bool:
        """The sender's clock may never get more than CLOCK_LEAD ahead of ours since its
        first frame: a fast clock buys no speed and no rate."""
        if p["qmax"] is None:
            p["q0"], p["t0"], p["qmax"] = q, t, q
            return True
        return (q - p["q0"]) / 100.0 <= (t - p["t0"]) + CLOCK_LEAD

    def _seen(self, p: dict, q: int, t: float) -> None:
        sample = t - q / 100.0
        if p["off"] is None or sample < p["off"]:
            p["off"] = sample
        if p["qmax"] is None or q > p["qmax"]:
            p["qmax"] = q

    def _ack(self, p: dict, msg: dict, q: int | None, t: float) -> None:
        """A frame acknowledging snapshot tick k, which reached the sender at its clock
        kq: one round-trip sample (our send -> their arrival, mapped onto our clock, which
        adds the sender's fastest trip up). Without kq the frame's own time stands in."""
        kk = as_num(msg.get("k"), 0, 1 << 30)
        if kk is None or q is None or p["off"] is None:
            return
        kk = int(kk)
        kq = as_num(msg.get("kq"), 0, (1 << 30) - 1)
        arrived = int(kq) if kq is not None and q - 100 <= kq <= q else q
        mapped = arrived / 100.0 + p["off"]
        for tick, at in reversed(self.sent):
            if tick == kk:
                p["rtts"].append((t, max(0.0, mapped - at)))
                break
            if tick < kk:
                break
        while p["rtts"] and t - p["rtts"][0][0] > RTT_WINDOW:
            p["rtts"].popleft()
        if p["rtts"]:
            p["rtt"] = min(s for _, s in p["rtts"])

    # -- movement --
    def pos(self, uid: str, msg: dict, t: float) -> tuple[bool, dict | None]:
        """A position frame. Returns (accepted, correction to send back). Ignored before
        the round, while dead, and from an earlier life (frames still in flight)."""
        p = self.players.get(uid)
        if p is None or self.phase != "round" or p["dead"] or p["gone"]:
            return False, None
        if not self._bucket(p["pb"], POS_RATE, POS_BURST, t):
            return False, None
        x, y, z = (as_num(msg.get(c), -1e6, 1e6) for c in ("x", "y", "z"))
        r, pt = as_num(msg.get("r"), -1e6, 1e6), as_num(msg.get("p"), -9000, 9000)
        if x is None or y is None or z is None or r is None:
            return False, None
        e = as_num(msg.get("e"), 0, 1 << 30)
        if e is not None and int(e) != p["life"]:
            return False, None
        q = as_num(msg.get("q"), 0, (1 << 30) - 1)
        q = int(q) if q is not None else None
        if q is not None and p["q"] is not None:
            if q <= p["q"]:
                return False, None                   # older than what we have: stale, not cheating
            dt = (q - p["q"]) / 100.0 if self._lead_ok(p, q, t) else -1.0
        else:
            if q is not None:
                self._lead_ok(p, q, t)
            dt = max(0.0, t - p["at"])
        xm, ym, zm = x / 100.0, y / 100.0, z / 100.0
        b = self.m["bounds"]
        ok = dt >= 0 and b[0] <= xm <= b[3] and b[1] <= ym <= b[4] and b[2] <= zm <= b[5]
        if ok:
            across = math.hypot(xm - p["x"], zm - p["z"])
            dy = ym - p["y"]
            ok = (across <= MAX_SPEED * dt + SLACK and dy <= JUMP_V * dt + STEP_H + SLACK
                  and -dy <= FALL_MAX * dt + SLACK and overlaps(self.m, xm, ym, zm, SHRINK) < 0)
        # the air clock runs on server time (the sender's clock mapped onto ours)
        clock = q / 100.0 + p["off"] if q is not None and p["off"] is not None else t
        grounded = False
        if ok:
            grounded = overlaps(self.m, xm, ym - 0.1, zm) >= 0
            if not grounded and clock - p["air_at"] > MAX_AIR:
                ok = False
        if not ok:
            p["bad"] += 1
            if t - p["fix_at"] < FIX_GAP:
                return False, None
            p["fix_at"] = t
            return False, {"x": round(p["x"] * 100), "y": round(p["y"] * 100), "z": round(p["z"] * 100), "e": p["life"]}
        if q is not None:
            self._seen(p, q, t)
            p["q"] = q
            mapped = q / 100.0 + p["off"]
        else:
            mapped = t
        if grounded:
            p["air_at"] = mapped
        p["x"], p["y"], p["z"] = xm, ym, zm
        p["r"] = int(r) % 36000
        p["pt"] = int(pt) if pt is not None else 0
        p["at"] = t
        h = p["hist"]
        h.append((mapped, xm, ym, zm))
        while len(h) > 2 and mapped - h[0][0] > HISTORY:
            h.popleft()
        self._ack(p, msg, q, t)
        self.dirty.add(uid)
        self._pickups(uid, p, t)
        return True, None

    def _pickups(self, uid: str, p: dict, t: float) -> None:
        for i, pk in enumerate(self.m["pickups"]):
            if self.items[i] is not None:
                continue
            ax, ay, az = pk["at"]
            if math.hypot(p["x"] - ax, p["z"] - az) > PICK_R or abs(p["y"] - ay) > 1.2:
                continue
            if pk["kind"] == "health":
                if p["hp"] >= HP:
                    continue
                p["hp"] = min(HP, p["hp"] + HEAL)
            else:
                full = all(p["res"][w] >= WEAPONS[w]["reserve"] * 2 for w in range(len(WEAPONS)))
                if full:
                    continue
                p["res"] = [min(WEAPONS[w]["reserve"] * 2, p["res"][w] + WEAPONS[w]["pack"]) for w in range(len(WEAPONS))]
            self.items[i] = t + PICKUP_BACK
            self.pending.append(("pick", {"i": i, "user": uid, "hp": p["hp"], "res": list(p["res"])}))

    def where(self, p: dict, at: float) -> tuple[float, float, float]:
        """Where a player was at server time `at`, from their history (held at the ends)."""
        h = p["hist"]
        if not h:
            return p["x"], p["y"], p["z"]
        if at <= h[0][0]:
            return h[0][1:]
        if at >= h[-1][0]:
            return h[-1][1:]
        lo, hi = 0, len(h) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if h[mid][0] <= at:
                lo = mid
            else:
                hi = mid
        a, b = h[lo], h[hi]
        u = (at - a[0]) / ((b[0] - a[0]) or 1.0)
        return a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u

    # -- shooting --
    def _sync(self, p: dict, t: float) -> dict | None:
        """The shooter's ammo as the server sees it, at most once per FIX_GAP."""
        if t - p["sync_at"] < FIX_GAP:
            return None
        p["sync_at"] = t
        return {"w": p["w"], "mag": list(p["mag"]), "res": list(p["res"]), "reloading": p["reload"] is not None}

    def _this_life(self, p: dict, msg: dict) -> bool:
        """Ops carry the life they were made in (e); one from before the last respawn is
        still in flight and just dropped."""
        e = as_num(msg.get("e"), 0, 1 << 30)
        return e is None or int(e) == p["life"]

    def _clock(self, p: dict, msg: dict, t: float) -> int | None:
        q = as_num(msg.get("q"), 0, (1 << 30) - 1)
        if q is None:
            return None
        q = int(q)
        if not self._lead_ok(p, q, t):
            p["bad"] += 1
            return None
        if p["qmax"] is not None and q < p["qmax"] - int(FIRE_LATE * 100):
            return None
        self._seen(p, q, t)
        return q

    def _finish_reload(self, p: dict, q: int) -> None:
        if p["reload"] is not None and q >= p["reload"][2]:
            w = p["reload"][0]
            take = min(WEAPONS[w]["mag"] - p["mag"][w], p["res"][w])
            p["mag"][w] += take
            p["res"][w] -= take
            p["reload"] = None

    def fire(self, uid: str, msg: dict, t: float) -> tuple[list | None, dict | None]:
        """A shot. Returns (the judged shot for the snapshot, or None if refused; the
        shooter's ammo to send back when it was refused for ammo, or None)."""
        p = self.players.get(uid)
        if p is None or self.phase != "round" or p["dead"] or p["gone"]:
            return None, None
        if not self._bucket(p["fb"], FIRE_RATE, FIRE_BURST, t):
            return None, None
        w = as_num(msg.get("w"), -1, 99)
        ox, oy, oz = (as_num(msg.get(c), -1e6, 1e6) for c in ("ox", "oy", "oz"))
        yaw, pitch = as_num(msg.get("r"), -1e6, 1e6), as_num(msg.get("p"), -9000, 9000)
        if w is None or int(w) != w or not 0 <= w < len(WEAPONS) or None in (ox, oy, oz, yaw, pitch):
            return None, None
        w = int(w)
        if not self._this_life(p, msg):
            return None, None
        q = self._clock(p, msg, t)
        if q is None:
            return None, None
        self._ack(p, msg, q, t)
        wp = WEAPONS[w]
        self._finish_reload(p, q)
        rl = p["reload"]
        if w != p["w"] or q < p["ready"] or (rl is not None and rl[1] <= q) or p["mag"][w] <= 0:
            return None, self._sync(p, t)
        # The fire rate, on the shooter's clock: every two shots of a weapon at least its
        # interval apart (1 cs of rounding), whatever order the network delivered them in.
        gap = int(round(wp["interval"] * 100)) - 1
        last = p["last"][w]
        if any(abs(q - lq) < gap for lq in last):
            return None, None
        o = (ox / 100.0, oy / 100.0, oz / 100.0)
        lag = abs(q - p["q"]) / 100.0 if p["q"] is not None else 0.0
        if math.dist(o, (p["x"], p["y"] + EYE, p["z"])) > ORIGIN_SLACK + MAX_SPEED * min(lag, FIRE_LATE):
            p["bad"] += 1
            return None, None
        p["mag"][w] -= 1
        last.append(q)
        while len(last) > 8:
            last.popleft()
        p["n"] += 1
        if p["protect"] > t:
            p["protect"] = t
            self.dirty.add(uid)
        dy, dp = spread_of(p["n"], w)
        d = dir_of(yaw / 100.0 + dy, max(-89.0, min(89.0, pitch / 100.0 + dp)))
        # lag compensation: where was everyone when the shooter pulled the trigger, as
        # the shooter saw them?
        t_fire = min(t, max(t - FIRE_LATE, q / 100.0 + p["off"]))
        ip = as_num(msg.get("ip"), 0, 1e6)
        t_view = t_fire - min(p["rtt"], RTT_CAP) - min((ip or 0.0) / 1000.0, IP_CAP)
        t_view = max(t_view, t - HISTORY)
        reach = ray_map(self.m, o, d, wp["range"])
        best = None
        for vid, v in self.players.items():
            if vid == uid or v["dead"] or v["gone"] or v["spawn_t"] > t_view:
                continue
            vx, vy, vz = self.where(v, t_view)
            h = ray_player(o, d, vx, vy, vz, reach)
            if h is not None and (best is None or h[0] < best[1][0]):
                best = (vid, h)
        end = reach if best is None else best[1][0]
        shot = [p["slot"], w, round((o[0] + d[0] * end) * 100), round((o[1] + d[1] * end) * 100),
                round((o[2] + d[2] * end) * 100), -1, 0]
        if best is not None:
            vid, (_, head) = best
            v = self.players[vid]
            shot[5], shot[6] = v["slot"], 1 if head else 0
            dmg = 0 if v["protect"] > t else (wp["head"] if head else wp["damage"])
            v["hp"] = max(0, v["hp"] - dmg)
            self.dirty.add(vid)
            if dmg and v["hp"] <= 0:
                self._kill(uid, vid, w, head, t)
        self.shots.append(shot)
        return shot, None

    def _kill(self, uid: str, vid: str, w: int, head: bool, t: float) -> None:
        p, v = self.players[uid], self.players[vid]
        v["dead"], v["deaths"], v["respawn_at"] = True, v["deaths"] + 1, t + RESPAWN
        v["reload"] = None
        p["kills"] += 1
        self.pending.append(("kill", {"k": uid, "v": vid, "w": w, "hs": 1 if head else 0,
                                      "kills": p["kills"], "deaths": v["deaths"]}))

    def reload(self, uid: str, msg: dict, t: float) -> bool:
        p = self.players.get(uid)
        if p is None or self.phase != "round" or p["dead"] or p["gone"]:
            return False
        if not self._bucket(p["ob"], OP_RATE, OP_BURST, t) or not self._this_life(p, msg):
            return False
        q = self._clock(p, msg, t)
        if q is None:
            return False
        self._finish_reload(p, q)
        w = p["w"]
        if p["reload"] is not None or p["mag"][w] >= WEAPONS[w]["mag"] or p["res"][w] <= 0:
            return False
        p["reload"] = (w, q, q + int(round(WEAPONS[w]["reload"] * 100)))
        return True

    def weapon(self, uid: str, msg: dict, t: float) -> bool:
        p = self.players.get(uid)
        if p is None or self.phase not in ("warmup", "round") or p["gone"]:
            return False
        if not self._bucket(p["ob"], OP_RATE, OP_BURST, t):
            return False
        w = as_num(msg.get("w"), -1, 99)
        if w is None or int(w) != w or not 0 <= w < len(WEAPONS):
            return False
        q = self._clock(p, msg, t) if msg.get("q") is not None else None
        if int(w) == p["w"]:
            return False
        p["w"] = int(w)
        p["reload"] = None
        p["ready"] = (q if q is not None else (p["qmax"] or 0)) + int(SWITCH * 100)
        self.dirty.add(uid)
        return True

    # -- the clock --
    def spawn_for(self, uid: str) -> int:
        """The spawn point farthest from every living opponent (ties: the lowest index
        after this player's slot, so a quiet arena still spreads people out)."""
        foes = [(v["x"], v["y"], v["z"]) for u, v in self.players.items()
                if u != uid and not v["dead"] and not v["gone"]]
        n = len(self.m["spawns"])
        start = self.players[uid]["slot"] * 5
        best, best_d = 0, -1.0
        for j in range(n):
            i = (start + j) % n
            s = self.m["spawns"][i]
            dmin = min((math.dist(s[:3], f) for f in foes), default=1e9)
            if dmin > best_d + 1e-9:
                best, best_d = i, dmin
        return best

    def tick(self, t: float, send: bool) -> list[tuple[str, dict]]:
        """Advance the match clock; returns the events for the lobby, in order."""
        evs: list[tuple[str, dict]] = []
        self.k += 1
        if self.phase == "warmup" and t >= self.go_at:
            self.phase = "round"
            self.ends_at = self.go_at + self.minutes * 60
            for p in self.players.values():
                p["at"], p["air_at"] = t, t
                p["protect"] = t + PROTECT
                p["pb"], p["fb"], p["ob"] = [float(POS_BURST), t], [float(FIRE_BURST), t], [float(OP_BURST), t]
            self.dirty = set(self.players)
            evs.append(("go", {"msLeft": self.ms_left(t)}))
        if self.phase != "round":
            return evs
        for uid, p in self.players.items():
            if p["gone"]:
                continue
            if p["away"] is not None and t - p["away"] >= GRACE:
                p["gone"] = True
                self.dirty.add(uid)
                evs.append(("gone", {"user": uid}))
                continue
            if p["dead"] and t >= p["respawn_at"]:
                self._place(p, self.spawn_for(uid), t)
                self.dirty.add(uid)
                evs.append(("spawn", {"user": uid, "x": round(p["x"] * 100), "y": round(p["y"] * 100),
                                      "z": round(p["z"] * 100), "r": p["r"], "e": p["life"]}))
            elif p["protect"] and t >= p["protect"]:
                p["protect"] = 0.0
                self.dirty.add(uid)
        for i, back in enumerate(self.items):
            if back is not None and t >= back:
                self.items[i] = None
                evs.append(("item", {"i": i, "on": 1}))
        evs.extend(self.pending)
        self.pending = []
        top = max((p["kills"] for p in self.players.values()), default=0)
        # over at the kill limit, at the time, or when everyone else has left (a match
        # started alone runs until its clock, for practice with the server)
        alone = len(self.active()) < (2 if len(self.players) >= 2 else 1)
        if top >= self.limit or t >= self.ends_at or alone:
            self.phase = "done"
            self.results = []
            prev, place = None, 0
            for i, u in enumerate(self.order()):
                p = self.players[u]
                key = (p["kills"], p["deaths"])
                if key != prev:
                    place, prev = i + 1, key
                self.results.append({"user": p["user"], "place": place, "kills": p["kills"], "deaths": p["deaths"],
                                     "left": p["gone"]})
            if self.shots:
                evs.append(("snap", self._snap(t)))
            evs.append(("done", {"results": self.results}))
            return evs
        if send and (self.dirty or self.shots):
            evs.append(("snap", self._snap(t)))
        return evs

    def _ms(self, at: float) -> int:
        """A server time on the wire: ms since the round's start (the match clock)."""
        return int(round((at - self.go_at) * 1000))

    def _snap(self, t: float) -> dict:
        """One snapshot: each changed player as [slot, x, y, z, yaw, pitch, hp, weapon,
        flags, when] (when = the server time that position is from, on the match clock,
        the sender's own clock mapped onto ours, so network jitter is already taken out),
        the shots judged since the last one, and ts = when this snapshot left."""
        ents = []
        for uid in self.dirty:
            p = self.players.get(uid)
            if p is None:
                continue
            f = (1 if p["dead"] else 0) | (2 if p["protect"] > t else 0) | (4 if p["away"] is not None else 0) | \
                (8 if p["gone"] else 0)
            ents.append([p["slot"], round(p["x"] * 100), round(p["y"] * 100), round(p["z"] * 100), p["r"], p["pt"],
                         p["hp"], p["w"], f, self._ms(p["hist"][-1][0]) if p["hist"] else -1])
        snap = {"k": self.k, "ts": self._ms(t), "ms": self.ms_left(t), "p": ents, "s": self.shots}
        self.dirty = set()
        self.shots = []
        self.sent.append((self.k, t))
        while self.sent and t - self.sent[0][1] > RTT_WINDOW + 1.0:
            self.sent.popleft()
        return snap
