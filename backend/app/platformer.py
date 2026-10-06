"""
Platformer Rush for the Valley (g = "plat"): the levels, the start, and the referee.

Run, jump and double-jump through floating islands to the flag, collecting coins on
the way. Two modes for up to 8 players: a race (first to the flag wins; the flag only
counts once every checkpoint has been touched, in order) and co-op (the whole lobby
shares one coin goal and wins together if it gets there before the timer).

Each player runs their own character in the browser (games/platformer.js) and streams
where it is; the server runs a fixed-rate tick (app/realtime.py) that checks every
position, owns the checkpoints, the coins and the finish, and sends one batched
snapshot to the lobby per tick. The server does not simulate the characters: it checks
that each move stays inside the level, is no faster than a character can run, rises
and falls no faster than a jump and gravity allow, never ends inside a platform, and
never climbs higher above the last platform it stood on than a jump plus a double
jump can reach in the time since. A frame that fails gets a "fix" back (to the last
place the player stood on solid ground).

Levels live in platformer_levels.json (a byte copy of games/platformer/levels.json).
A level is a list of solids, each one of Kenney's Starter Kit 3D Platformer models
at a position (x, z the footprint centre, y its bottom), a quarter-turn rotation and a
uniform scale; MODELS gives each model's footprint and height. Plus 8 spawn points,
checkpoints in order, coins, the flag and a kill plane (fall below it and you respawn
at your last checkpoint), and a route the bots in the tests (and the browser's
autopilot) follow.

Units on the wire: x, y, z in centimetres (y = the feet), yaw in whole degrees, an
animation id, the sender's clock in centiseconds (q). Nothing transcript-derived.
"""
import json
import math
import os
from typing import Any

# -- shared with games/platformer.js (PLAT-LEVEL block; tests/test_platformer_sync.py) --
PR = 0.3                     # a character's half-width (m)
PH = 0.9                     # its height
CENTER = 0.45                # its centre above the feet: what reaches a coin or a checkpoint
MODELS = {                   # name: (shape, width x, depth z, height) before scale and rotation
    "platform": ("box", 2.0, 2.0, 0.5),
    "platform-medium": ("box", 3.0, 3.0, 0.5),
    "platform-large": ("box", 5.0, 5.0, 0.5),
    "platform-falling": ("box", 2.2, 2.2, 0.5),
    "platform-grass-large-round": ("round", 5.0, 5.0, 0.5),
    "brick": ("box", 1.0, 1.0, 1.0),
    "block-coin": ("box", 1.0, 1.0, 1.0),
}

# -- the referee's limits: a little above what the browser's character can do --
MAX_RUN = 8.0                # m/s across the ground; the browser runs at 6
SLACK_H = 1.2                # m allowed on top of MAX_RUN x dt (bunched frames)
MAX_RISE = 10.0              # m/s upwards; a jump starts at 8.6
MAX_FALL = 24.0              # m/s downwards; the browser falls at most 20
SLACK_V = 1.0
S_JUMP, S_DJUMP, S_GRAV = 9.0, 8.2, 24.0      # the jump the height envelope allows (browser: 8.6, 7.8, 26)
ENV_W = 0.3                  # s of take-off uncertainty either side
ENV_SLACK = 0.5              # m on top of the envelope
SUPPORT_M = PR + 0.2         # standing on a solid: within its footprint plus this ...
SUPPORT_TOL = 0.6            # ... and at most this far above its top
CLOCK_LEAD = 0.6             # s a sender's clock may run ahead of ours, summed over the run
CP_R = 2.0                   # a checkpoint counts within this of the character's centre
COIN_R = 1.0                 # a coin, within this (the browser takes it at 0.75)
FLAG_R = 1.6
HZ = 15                      # server ticks per second while a run is on
COUNTDOWN = 4.0
FINISH_GRACE = 30.0          # after the winner reaches the flag, the rest get this long
MAX_RUN_SECS = 420.0         # a race is called after 7 minutes whatever happens
GRACE = 20.0                 # a dropped player waits this long for a rejoin
POS_RATE = 25.0              # position frames per second per player (clients send 20)
POS_BURST = 10
FIX_GAP = 0.5                # at most one correction per this long
RESPAWN_GAP = 0.5            # at most one respawn per this long
MAX_PLAYERS = 8
CHARS = 6                    # colour tints of the one character model
MODES = ("race", "coop")
ANIMS = 5                    # 0 idle, 1 run, 2 jump, 3 fall, 4 double jump

_HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(_HERE, "platformer_levels.json"), encoding="utf-8") as _f:
    DATA = json.load(_f)


# ------------------------------------------------------------------ levels --
def solid_of(b: dict) -> dict:
    """The collision shape of one placed model: an axis-aligned box, or a cylinder for
    the round platform (r > 0). x0..x1, y0..y1, z0..z1 bound it either way."""
    shape, w, d, h = MODELS[b["m"]]
    s = float(b.get("s", 1))
    if int(b.get("r", 0)) % 180 == 90:
        w, d = d, w
    x, y, z = float(b["x"]), float(b["y"]), float(b["z"])
    r = w * s / 2 if shape == "round" else 0.0
    return {"m": b["m"], "x0": x - w * s / 2, "x1": x + w * s / 2, "y0": y, "y1": y + h * s,
            "z0": z - d * s / 2, "z1": z + d * s / 2, "cx": x, "cz": z, "r": r}


def compile_level(lv: dict) -> dict:
    solids = [solid_of(b) for b in lv["solids"]]
    if not solids:
        raise ValueError("a level needs solids")
    top = max(s["y1"] for s in solids)
    kill = float(lv["kill"])
    return {"id": lv["id"], "name": lv["name"], "kill": kill, "solids": solids,
            "spawns": [list(map(float, p)) for p in lv["spawns"]],
            "cps": [list(map(float, p)) for p in lv["cps"]],
            "coins": [list(map(float, p)) for p in lv["coins"]],
            "flag": list(map(float, lv["flag"])),
            "goal": int(lv.get("coopGoal", 0)), "secs": float(lv.get("coopSecs", 180)),
            "bounds": [min(s["x0"] for s in solids) - 12, max(s["x1"] for s in solids) + 12,
                       kill - 6, top + 10,
                       min(s["z0"] for s in solids) - 12, max(s["z1"] for s in solids) + 12]}


def in_foot(s: dict, x: float, z: float, m: float) -> bool:
    """(x, z) over the solid's footprint grown by m (shrunk if m < 0)."""
    if s["r"] > 0:
        dx, dz = x - s["cx"], z - s["cz"]
        return dx * dx + dz * dz <= (s["r"] + m) * (s["r"] + m)
    return s["x0"] - m <= x <= s["x1"] + m and s["z0"] - m <= z <= s["z1"] + m


def support(lv: dict, x: float, y: float, z: float, m: float, tol: float) -> float | None:
    """The top of the highest solid under (x, z) (footprint grown by m) that feet at
    height y stand on or hover at most tol above; None if there is none."""
    best = None
    for s in lv["solids"]:
        if s["y1"] - 0.05 <= y <= s["y1"] + tol and in_foot(s, x, z, m) and (best is None or s["y1"] > best):
            best = s["y1"]
    return best


def inside(lv: dict, x: float, y: float, z: float) -> bool:
    """Feet at (x, y, z) are inside a solid: not a place a character can be."""
    for s in lv["solids"]:
        if s["y0"] + 0.1 < y < s["y1"] - 0.15 and in_foot(s, x, z, -0.05):
            return True
    return False


def seg_dist(a: tuple, b: tuple, p: tuple) -> float:
    """Distance from point p to the segment a-b (3D)."""
    ab = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    ap = (p[0] - a[0], p[1] - a[1], p[2] - a[2])
    L = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2]
    u = 0.0 if L <= 1e-12 else max(0.0, min(1.0, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / L))
    d = (ap[0] - ab[0] * u, ap[1] - ab[1] * u, ap[2] - ab[2] * u)
    return math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2])


def lift_max(tau: float) -> float:
    """The highest the feet can be above the top they left, tau seconds after leaving
    it, with a jump and one double jump at the best moment (the referee's lenient
    constants). Closed form: the double jump at s* = (tau + (v1 - v2)/g) / 2."""
    if tau <= 0:
        return 0.0
    s = min(tau, max(0.0, (tau + (S_JUMP - S_DJUMP) / S_GRAV) / 2))
    r = tau - s
    return S_JUMP * s - S_GRAV * s * s / 2 + S_DJUMP * r - S_GRAV * r * r / 2


T_APEX = (S_JUMP + S_DJUMP) / S_GRAV
H_APEX = lift_max(T_APEX)


def lift_bound(tau: float) -> float:
    """lift_max with the take-off time uncertain by ENV_W either way, plus ENV_SLACK."""
    return lift_max(min(max(T_APEX, tau - ENV_W), tau + ENV_W)) + ENV_SLACK


LEVELS: dict[str, dict] = {}
for _lv in DATA["levels"]:
    LEVELS[_lv["id"]] = compile_level(_lv)


def as_num(v: Any, lo: float, hi: float) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or v in (float("inf"), float("-inf")):
        return None
    return min(hi, max(lo, float(v)))


# ----------------------------------------------------------------- referee --
class Plat:
    """One room's run. idle -> grid (countdown) -> run -> done; the host starts the
    next one from done or idle."""

    def __init__(self) -> None:
        self.level: str | None = None
        self.mode = "race"
        self.phase = "idle"
        self.go_at = 0.0
        self.first_at: float | None = None        # when the winner reached the flag
        self.players: dict[str, dict] = {}
        self.chars: dict[str, int] = {}           # user_id -> character tint, kept between runs
        self.results: list[dict] | None = None
        self.taken: list[int] = []                # co-op: the room's coins, in the order taken
        self.win: bool | None = None
        self.dirty: set[str] = set()
        self.order_sig: tuple = ()
        self.pending: list[tuple[str, dict]] = []  # coin / checkpoint / finish events for the next tick

    # -- views --
    def lv(self) -> dict | None:
        return LEVELS.get(self.level) if self.level else None

    def ms(self, t: float) -> int:
        return max(0, int(round((t - self.go_at) * 1000)))

    def limit(self) -> float:
        lv = self.lv()
        return lv["secs"] if self.mode == "coop" and lv else MAX_RUN_SECS

    def target(self, p: dict) -> list[float] | None:
        lv = self.lv()
        if lv is None:
            return None
        return lv["cps"][p["cp"]] if p["cp"] < len(lv["cps"]) else lv["flag"]

    def order(self) -> list[str]:
        """Standings. Race: finishers by time, then checkpoints passed, then the distance
        to the next one; dropped players last. Co-op: by coins."""
        def key(item: tuple[str, dict]) -> tuple:
            p = item[1]
            if self.mode == "coop":
                return (1 if p["dnf"] else 0, -len(p["got"]), p["slot"])
            if p["fin"] is not None:
                return (0, p["fin"], 0, 0.0)
            tg = self.target(p) or [0.0, 0.0, 0.0]
            d = math.dist((p["x"] / 100, p["y"] / 100, p["z"] / 100), tg)
            return (1 if not p["dnf"] else 2, 0, -p["cp"], round(d, 3))
        return [uid for uid, _ in sorted(self.players.items(), key=key)]

    def view(self, t: float) -> dict | None:
        lv = self.lv()
        if lv is None:
            return None
        order = self.order()
        return {"level": self.level, "mode": self.mode, "phase": self.phase,
                "goInMs": max(0, int((self.go_at - t) * 1000)) if self.phase == "grid" else 0,
                "runMs": self.ms(t) if self.phase == "run" else 0,
                "limitMs": int(self.limit() * 1000), "goal": lv["goal"], "taken": list(self.taken),
                "players": [{"user": p["user"], "slot": p["slot"], "char": p["char"], "cp": p["cp"],
                             "coins": len(p["got"]), "got": sorted(p["got"]) if self.mode == "race" else [],
                             "place": order.index(uid) + 1, "fin": p["fin"], "dnf": p["dnf"], "away": p["away"],
                             "x": p["x"], "y": p["y"], "z": p["z"], "r": p["r"]}
                            for uid, p in self.players.items()],
                "results": self.results, "win": self.win, "chars": dict(self.chars)}

    # -- ops --
    def char(self, uid: str, msg: dict) -> int | None:
        c = as_num(msg.get("char"), -1, CHARS)
        if c is None or c != int(c) or not 0 <= c < CHARS:
            return None
        self.chars[uid] = int(c)
        if uid in self.players and self.phase in ("idle", "grid", "done"):
            self.players[uid]["char"] = int(c)
        return int(c)

    def start(self, members: dict[str, dict], level: Any, mode: Any, t: float) -> str | None:
        if self.phase in ("grid", "run"):
            return "a run is already on: the host can end it first"
        if not isinstance(level, str) or level not in LEVELS:
            return "pick a level"
        if mode is None:
            mode = "race"
        if mode not in MODES:
            return "pick race or co-op"
        lv = LEVELS[level]
        self.level, self.mode = level, mode
        self.phase = "grid"
        self.go_at = t + COUNTDOWN
        self.first_at = None
        self.results = None
        self.win = None
        self.taken = []
        self.pending = []
        self.players = {}
        for k, (uid, pub) in enumerate(list(members.items())[:MAX_PLAYERS]):
            sx, sy, sz = lv["spawns"][k % len(lv["spawns"])]
            self.players[uid] = {
                "user": pub, "slot": k, "char": self.chars.get(uid, k % CHARS),
                "x": int(round(sx * 100)), "y": int(round(sy * 100)), "z": int(round(sz * 100)), "r": 0, "a": 0,
                "q": None, "q0": 0, "t0": t, "at": t, "base": sy, "air": None, "safe": (sx, sy, sz),
                "cp": 0, "cp_at": [], "got": set(), "fin": None, "dnf": False, "away": None, "told": False,
                "bucket": [float(POS_BURST), t], "fix_at": 0.0, "spawn_at": -1.0, "bad": 0, "tp": False}
        self.dirty = set(self.players)
        self.order_sig = ()
        return None

    def end(self) -> None:
        self.phase = "idle"
        self.players = {}
        self.results = None
        self.first_at = None
        self.pending = []

    def _fix(self, p: dict, t: float) -> dict | None:
        p["bad"] += 1
        if t - p["fix_at"] < FIX_GAP:
            return None
        p["fix_at"] = t
        self._place(p, p["safe"])
        return {"x": p["x"], "y": p["y"], "z": p["z"]}

    def _place(self, p: dict, at: tuple) -> None:
        """Put a player back on solid ground at `at` (a fix or a respawn)."""
        p["x"], p["y"], p["z"] = int(round(at[0] * 100)), int(round(at[1] * 100)), int(round(at[2] * 100))
        p["base"], p["air"], p["tp"] = at[1], None, True

    def pos(self, uid: str, msg: dict, t: float) -> tuple[bool, dict | None]:
        """A position frame. Returns (accepted, correction to send back). Before the
        start, after you finish, and while you are away, frames are ignored."""
        p = self.players.get(uid)
        lv = self.lv()
        if p is None or lv is None or self.phase != "run" or p["fin"] is not None or p["dnf"]:
            return False, None
        b = p["bucket"]
        b[0] = min(float(POS_BURST), b[0] + (t - b[1]) * POS_RATE)
        b[1] = t
        if b[0] < 1.0:
            return False, None
        b[0] -= 1.0
        x, y, z = as_num(msg.get("x"), -1e7, 1e7), as_num(msg.get("y"), -1e7, 1e7), as_num(msg.get("z"), -1e7, 1e7)
        r = as_num(msg.get("r"), -100000, 100000)
        if x is None or y is None or z is None or r is None:
            return False, None
        a = as_num(msg.get("a"), 0, ANIMS - 1)
        q = as_num(msg.get("q"), 0, (1 << 30) - 1)
        q = int(q) if q is not None else None
        # Elapsed time between this frame and the last one taken, on the sender's clock
        # (frames arrive bunched and out of order); an older frame is just stale, and
        # the sender's clock may never run more than CLOCK_LEAD ahead of ours.
        if q is not None and p["q"] is not None:
            if q <= p["q"]:
                return False, None
            dt = (q - p["q"]) / 100.0
            if (q - p["q0"]) / 100.0 > (t - p["t0"]) + CLOCK_LEAD:
                dt = -1.0
        else:
            dt = max(0.0, t - p["at"])
        clock = q / 100.0 if q is not None else t
        xm, ym, zm = x / 100.0, y / 100.0, z / 100.0
        px, py, pz = p["x"] / 100.0, p["y"] / 100.0, p["z"] / 100.0
        bx = lv["bounds"]
        tau = 0.0 if p["air"] is None else clock - p["air"]
        ok = (dt >= 0
              and bx[0] <= xm <= bx[1] and bx[2] <= ym <= bx[3] and bx[4] <= zm <= bx[5]
              and math.hypot(xm - px, zm - pz) <= MAX_RUN * dt + SLACK_H
              and ym - py <= MAX_RISE * dt + SLACK_V
              and py - ym <= MAX_FALL * dt + SLACK_V
              and ym - p["base"] <= lift_bound(tau)
              and not inside(lv, xm, ym, zm))
        if not ok:
            return False, self._fix(p, t)
        top = support(lv, xm, ym, zm, SUPPORT_M, SUPPORT_TOL)
        if top is not None:
            p["base"], p["air"] = top, clock
            if abs(ym - top) < 0.08:
                p["safe"] = (xm, top, zm)
        elif p["air"] is None:
            p["air"] = clock
        a0 = (px, py + CENTER, pz)
        a1 = (xm, ym + CENTER, zm)
        p["x"], p["y"], p["z"], p["r"] = int(x), int(y), int(z), int(r) % 360
        p["a"] = int(a) if a is not None else 0
        if q is not None and p["q"] is None:
            p["q0"], p["t0"] = q, t
        p["q"] = q
        p["at"] = t
        self.dirty.add(uid)
        self._reach(uid, p, lv, a0, a1, t)
        return True, None

    def _reach(self, uid: str, p: dict, lv: dict, a0: tuple, a1: tuple, t: float) -> None:
        """What the move from a0 to a1 (the character's centre) touched: the next
        checkpoint, coins, and the flag once every checkpoint is behind you."""
        if p["cp"] < len(lv["cps"]):
            c = lv["cps"][p["cp"]]
            if seg_dist(a0, a1, (c[0], c[1] + CENTER, c[2])) <= CP_R:
                p["cp"] += 1
                p["cp_at"].append(self.ms(t))
                p["safe"] = (c[0], c[1], c[2])
                self.pending.append(("cp", {"user": uid, "cp": p["cp"], "ms": self.ms(t)}))
        lo = (min(a0[0], a1[0]) - COIN_R, min(a0[1], a1[1]) - COIN_R, min(a0[2], a1[2]) - COIN_R)
        hi = (max(a0[0], a1[0]) + COIN_R, max(a0[1], a1[1]) + COIN_R, max(a0[2], a1[2]) + COIN_R)
        room = set(self.taken) if self.mode == "coop" else None
        for i, c in enumerate(lv["coins"]):
            if not (lo[0] <= c[0] <= hi[0] and lo[1] <= c[1] <= hi[1] and lo[2] <= c[2] <= hi[2]):
                continue
            if (room is not None and i in room) or i in p["got"]:
                continue
            if seg_dist(a0, a1, c) <= COIN_R:
                p["got"].add(i)
                ev = {"user": uid, "id": i, "n": len(p["got"])}
                if room is not None:
                    self.taken.append(i)
                    room.add(i)
                    ev["room"] = len(self.taken)
                self.pending.append(("coin", ev))
        if self.mode == "race" and p["cp"] >= len(lv["cps"]):
            f = lv["flag"]
            if seg_dist(a0, a1, (f[0], f[1] + CENTER, f[2])) <= FLAG_R:
                p["fin"] = self.ms(t)
                if self.first_at is None:
                    self.first_at = t

    def respawn(self, uid: str, t: float) -> dict | None:
        """Back to the last checkpoint passed (or the start) after a fall. Returns where."""
        p = self.players.get(uid)
        lv = self.lv()
        if p is None or lv is None or self.phase != "run" or p["fin"] is not None or p["dnf"]:
            return None
        if t - p["spawn_at"] < RESPAWN_GAP:
            return None
        p["spawn_at"] = t
        at = tuple(lv["cps"][p["cp"] - 1]) if p["cp"] > 0 else tuple(lv["spawns"][p["slot"] % len(lv["spawns"])])
        self._place(p, at)
        p["safe"] = at
        p["a"] = 0
        self.dirty.add(uid)
        return {"x": p["x"], "y": p["y"], "z": p["z"], "cp": p["cp"]}

    def _results(self) -> list[dict]:
        order = self.order()
        if self.mode == "coop":
            return [{"user": self.players[u]["user"], "place": i + 1, "coins": len(self.players[u]["got"]),
                     "dnf": self.players[u]["dnf"]} for i, u in enumerate(order)]
        return [{"user": self.players[u]["user"], "place": i + 1, "ms": self.players[u]["fin"],
                 "dnf": self.players[u]["fin"] is None, "coins": len(self.players[u]["got"]),
                 "cp": self.players[u]["cp"], "cps": self.players[u]["cp_at"]} for i, u in enumerate(order)]

    def tick(self, t: float, send: bool) -> list[tuple[str, dict]]:
        """Advance the run clock; returns the events for the lobby, in order."""
        evs: list[tuple[str, dict]] = []
        if self.phase == "grid" and t >= self.go_at:
            self.phase = "run"
            for p in self.players.values():
                p["at"] = t
                p["bucket"] = [float(POS_BURST), t]
            evs.append(("go", {"level": self.level, "mode": self.mode}))
        if self.phase != "run":
            return evs
        evs.extend(self.pending)
        self.pending = []
        for uid, p in self.players.items():
            if p["away"] is not None and not p["dnf"] and p["fin"] is None and t - p["away"] >= GRACE:
                p["dnf"] = True
                evs.append(("dnf", {"user": uid}))
            if p["fin"] is not None and not p["told"]:
                p["told"] = True
                evs.append(("finish", {"user": uid, "ms": p["fin"], "place": self.order().index(uid) + 1,
                                       "coins": len(p["got"]), "cps": p["cp_at"]}))
        lv = self.lv()
        active = [p for p in self.players.values() if p["fin"] is None and not p["dnf"]]
        over = t - self.go_at >= self.limit() or not self.players or not active
        if self.mode == "coop":
            self.win = len(self.taken) >= lv["goal"] if lv else False
            over = over or bool(self.win)
        else:
            over = over or (self.first_at is not None and t - self.first_at >= FINISH_GRACE)
        if over:
            self.phase = "done"
            self.results = self._results()
            done = {"results": self.results, "level": self.level, "mode": self.mode}
            if self.mode == "coop":
                done.update(win=bool(self.win), total=len(self.taken), goal=lv["goal"] if lv else 0,
                            ms=self.ms(t))
            evs.append(("done", done))
            return evs
        order = tuple(self.order())
        if send and (self.dirty or order != self.order_sig):
            ps = []
            for uid in self.dirty:
                p = self.players.get(uid)
                if p is None:
                    continue
                c = {"u": uid, "x": p["x"], "y": p["y"], "z": p["z"], "r": p["r"], "a": p["a"], "cp": p["cp"]}
                if p["q"] is not None:
                    c["q"] = p["q"]
                if p["tp"]:
                    c["tp"] = 1
                    p["tp"] = False
                ps.append(c)
            evs.append(("snap", {"ms": self.ms(t), "ps": ps, "order": list(order)}))
            self.dirty = set()
            self.order_sig = order
        return evs

    def running(self) -> bool:
        return self.phase in ("grid", "run")

    def drop(self, uid: str, t: float, blip: bool = False) -> bool:
        """A player left. Mid-run a dropped socket (blip) keeps their place for GRACE
        seconds; an explicit leave is out at once. Before the start they just go."""
        p = self.players.get(uid)
        if p is None:
            return False
        if self.phase == "run" and p["fin"] is None and not p["dnf"]:
            if blip:
                p["away"] = t
            else:
                p["dnf"] = True
            return True
        if self.phase == "grid":
            self.players.pop(uid, None)
        return True

    def restore(self, uid: str, pub: dict) -> bool:
        p = self.players.get(uid)
        if p is None or p["away"] is None or p["dnf"]:
            return False
        p["away"] = None
        p["user"] = pub
        p["q"] = None                     # a reloaded page starts a new clock
        p["bucket"] = [float(POS_BURST), p["at"]]
        return True
