"""
Mini Golf for the Valley (g = "golf"): deterministic putting physics and the round referee.

The physics is integer-only so the server and every browser compute exactly the same
roll: the server simulates each shot from {ax, az, power} and broadcasts the result,
and the clients replay the same simulation (games/golf.js, between the GOLF-SIM
markers) only to animate it. Keep the two in lock-step: tests/test_golf_sync.py runs
the JS copy against golden vectors produced by this file.

Units: 1 tile = 10000. Velocity is units/tick x VS, 120 ticks per second. Courses
live in golf_courses.json (a byte copy of games/golf/courses.json; the wall segments
are generated from the Kenney GLB tiles by tools/golf_walls.py).

Rules: tdiv truncates toward zero, isqrt floors; no floats anywhere in simulate().
"""
import json
import math
import os
from typing import Any

# ------------------------------------------------------------------ physics --
TILE = 10000
HALF = TILE // 2
R = 350                      # ball radius
CUP = 670                    # cup radius: the ball centre must be inside it
VS = 256                     # velocity scale
TICK = 120                   # ticks per second
VMIN = 30 * VS
VMAX = 360 * VS
DRAG_NUM = 25                # proportional drag: 25/10000 of the speed per tick
DRAG_DEN = 10000
ROLL = 90                    # constant rolling resistance per tick
STOP = 60
REST_NUM = 3                 # a wall keeps 3/4 of the normal speed
REST_DEN = 4
CAPTURE = 160 * VS           # faster balls roll over the cup
SUBSTEP = 150 * VS           # at most 150 units of travel per collision substep
MAX_TICKS = 1800
MAX_STROKES = 8
OOB_PENALTY = 1
AIM_MAX = 4096


def isqrt(n: int) -> int:
    return math.isqrt(n) if n > 0 else 0


def tdiv(a: int, b: int) -> int:
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b >= 0) else -q


def rot(x: int, z: int, k: int) -> tuple[int, int]:
    """three.js rotation.y = k * 90 degrees, on integers."""
    k &= 3
    if k == 1:
        return z, -x
    if k == 2:
        return -x, -z
    if k == 3:
        return -z, x
    return x, z


def cell_of(v: int) -> int:
    return (v + HALF) // TILE


# ------------------------------------------------------------------ courses --
_DATA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "golf_courses.json")
with open(_DATA_PATH, encoding="utf-8") as _f:
    DATA: dict = json.load(_f)
COURSES: dict[str, dict] = {c["id"]: c for c in DATA["courses"]}


def compile_hole(hole: dict, pieces: dict | None = None) -> dict:
    """Place every tile: world wall segments, a per-cell broad phase, floor cells,
    voids, the tee and the cup."""
    pieces = pieces if pieces is not None else DATA["pieces"]
    segs: list[tuple[int, int, int, int, int]] = []
    seen: set = set()
    floor: set = set()
    voids: list[tuple[int, int, int, int]] = []
    tee = cup = None
    cols, rows = [], []
    for name, col, row, k in hole["tiles"]:
        p = pieces[name]
        cx, cz = col * TILE, row * TILE
        floor.add((col, row))
        cols.append(col)
        rows.append(row)
        for x1, z1, x2, z2 in p["segs"]:
            ax, az = rot(x1, z1, k)
            bx, bz = rot(x2, z2, k)
            s = (cx + ax, cz + az, cx + bx, cz + bz)
            key = min(s, (s[2], s[3], s[0], s[1]))
            if key in seen:
                continue
            seen.add(key)
            dx, dz = s[2] - s[0], s[3] - s[1]
            segs.append((s[0], s[1], dx, dz, isqrt(dx * dx + dz * dz) or 1))
        for x1, z1, x2, z2 in p.get("voids", []):
            ax, az = rot(x1, z1, k)
            bx, bz = rot(x2, z2, k)
            voids.append((cx + min(ax, bx), cz + min(az, bz), cx + max(ax, bx), cz + max(az, bz)))
        if "tee" in p:
            tx, tz = rot(p["tee"][0], p["tee"][1], k)
            tee = (cx + tx, cz + tz)
        if "cup" in p:
            ux, uz = rot(p["cup"][0], p["cup"][1], k)
            cup = (cx + ux, cz + uz)
    grid: dict[tuple[int, int], list[int]] = {}
    for i, (x1, z1, dx, dz, _L) in enumerate(segs):
        lo_x, hi_x = min(x1, x1 + dx) - R, max(x1, x1 + dx) + R
        lo_z, hi_z = min(z1, z1 + dz) - R, max(z1, z1 + dz) + R
        for c in range(cell_of(lo_x), cell_of(hi_x) + 1):
            for r in range(cell_of(lo_z), cell_of(hi_z) + 1):
                grid.setdefault((c, r), []).append(i)
    return {"name": hole["name"], "par": hole["par"], "segs": segs, "grid": grid, "floor": floor,
            "voids": voids, "tee": tee, "cup": cup,
            "bbox": (min(cols) * TILE - HALF, min(rows) * TILE - HALF,
                     max(cols) * TILE + HALF, max(rows) * TILE + HALF)}


_COMPILED: dict[str, list[dict]] = {}


def course_holes(course_id: str) -> list[dict]:
    if course_id not in _COMPILED:
        _COMPILED[course_id] = [compile_hole(h) for h in COURSES[course_id]["holes"]]
    return _COMPILED[course_id]


def on_floor(h: dict, x: int, z: int) -> bool:
    if (cell_of(x), cell_of(z)) not in h["floor"]:
        return False
    for x1, z1, x2, z2 in h["voids"]:
        if x1 < x < x2 and z1 < z < z2:
            return False
    return True


# ----------------------------------------------------------------- simulate --
def launch(ax: int, az: int, power: int) -> tuple[int, int]:
    m = isqrt(ax * ax + az * az) or 1
    sp = VMIN + tdiv((power - 1) * (VMAX - VMIN), 99)
    return tdiv(ax * sp, m), tdiv(az * sp, m)


def simulate(h: dict, bx: int, bz: int, ax: int, az: int, power: int) -> dict:
    """Roll one shot. Returns {end:[x,z], holed, oob, ticks}."""
    sx, sz = bx, bz
    vx, vz = launch(ax, az, power)
    cx, cz = h["cup"]
    segs, grid = h["segs"], h["grid"]
    rr = R * R
    for t in range(1, MAX_TICKS + 1):
        s = isqrt(vx * vx + vz * vz)
        n = max(1, tdiv(s + SUBSTEP - 1, SUBSTEP))
        for _ in range(n):
            bx += tdiv(vx, n * VS)
            bz += tdiv(vz, n * VS)
            for i in grid.get((cell_of(bx), cell_of(bz)), ()):
                x1, z1, dx, dz, L = segs[i]
                p = tdiv((bx - x1) * dx + (bz - z1) * dz, L)
                p = 0 if p < 0 else (L if p > L else p)
                px, pz = x1 + tdiv(dx * p, L), z1 + tdiv(dz * p, L)
                ox, oz = bx - px, bz - pz
                d2 = ox * ox + oz * oz
                if d2 < rr:
                    d = isqrt(d2) or 1
                    bx, bz = px + tdiv(ox * R, d), pz + tdiv(oz * R, d)
                    vn = tdiv(vx * ox + vz * oz, d)
                    if vn < 0:
                        vx -= tdiv((REST_DEN + REST_NUM) * vn * ox, REST_DEN * d)
                        vz -= tdiv((REST_DEN + REST_NUM) * vn * oz, REST_DEN * d)
        s = isqrt(vx * vx + vz * vz)
        ddx, ddz = bx - cx, bz - cz
        if ddx * ddx + ddz * ddz < CUP * CUP and s <= CAPTURE:
            return {"end": [cx, cz], "holed": True, "oob": False, "ticks": t}
        if not on_floor(h, bx, bz):
            return {"end": [sx, sz], "holed": False, "oob": True, "ticks": t}
        ns = s - tdiv(s * DRAG_NUM, DRAG_DEN) - ROLL
        if ns <= STOP:
            return {"end": [bx, bz], "holed": False, "oob": False, "ticks": t}
        vx, vz = tdiv(vx * ns, s), tdiv(vz * ns, s)
    return {"end": [bx, bz], "holed": False, "oob": False, "ticks": MAX_TICKS}


def as_int(v: Any, lo: int, hi: int) -> int | None:
    """A JSON number coerced to a clamped int; None for anything else."""
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or v in (float("inf"), float("-inf")):
        return None
    return max(lo, min(hi, int(v)))


# ------------------------------------------------------------------- referee --
HOLE_PAUSE = 4.0             # scorecard cut-scene between holes (seconds)
SHOT_GRACE = 0.3
POS_GAP = 0.09               # at most one position update per user per 90 ms
CHARS = 6
COLORS = 8


class Golf:
    """One room's Mini Golf round. Everybody plays at once (balls are ghosts); the
    hole advances when every player has holed out or picked up."""

    def __init__(self) -> None:
        self.course: str | None = None
        self.hole = 0
        self.phase = "idle"                # idle | playing | done
        self.players: dict[str, dict] = {}
        self.chars: dict[str, int] = {}    # user_id -> character, kept between rounds
        self.last_pos: dict[str, float] = {}
        self.hole_ready_at = 0.0
        self.last_shot: dict[str, dict] = {}

    # -- views --
    def holes(self) -> list[dict]:
        return course_holes(self.course) if self.course else []

    def view(self, t: float) -> dict | None:
        if self.course is None:
            return None
        return {"course": self.course, "hole": self.hole, "phase": self.phase,
                "par": [h["par"] for h in self.holes()],
                "players": [{"user": p["user"], "c": p["c"], "color": p["color"], "ball": list(p["ball"]),
                             "done": p["done"], "strokes": list(p["strokes"])} for p in self.players.values()],
                "readyInMs": max(0, int((self.hole_ready_at - t) * 1000)),
                "chars": dict(self.chars)}

    def card(self) -> dict:
        return {uid: list(p["strokes"]) for uid, p in self.players.items()}

    # -- ops --
    def char(self, uid: str, msg: dict) -> int | None:
        c = as_int(msg.get("c"), 0, CHARS - 1)
        if c is None:
            return None
        self.chars[uid] = c
        if uid in self.players:
            self.players[uid]["c"] = c
        return c

    def start(self, members: dict[str, dict], course: Any, t: float) -> str | None:
        if self.phase == "playing":
            return "a round is already on: the host can end it first"
        if not isinstance(course, str) or course not in COURSES:
            return "pick a course"
        self.course = course
        self.hole = 0
        self.phase = "playing"
        self.hole_ready_at = t
        self.last_shot = {}
        holes = self.holes()
        tee = holes[0]["tee"]
        self.players = {}
        for i, (uid, pub) in enumerate(list(members.items())[:8]):
            self.players[uid] = {"user": pub, "c": self.chars.get(uid, i % CHARS), "color": i % COLORS,
                                 "ball": tee, "done": False, "strokes": [0] * len(holes),
                                 "busy_until": 0.0}
        return None

    def shot(self, uid: str, msg: dict, t: float) -> tuple[dict | None, str | None]:
        """Validate and roll one shot. Returns (shot event, error)."""
        p = self.players.get(uid)
        if self.phase != "playing":
            return None, "no round is being played"
        if p is None:
            return None, "you're not in this round"
        if p["done"]:
            return None, "you've finished this hole"
        if t < max(p["busy_until"], self.hole_ready_at):
            return None, "wait for the ball to stop"
        ax, az = as_int(msg.get("ax"), -AIM_MAX, AIM_MAX), as_int(msg.get("az"), -AIM_MAX, AIM_MAX)
        power = as_int(msg.get("power"), 1, 100)
        if ax is None or az is None or power is None or (ax == 0 and az == 0):
            return None, "bad shot"
        seq = as_int(msg.get("seq"), 0, 1 << 30) or 0
        h = self.holes()[self.hole]
        frm = p["ball"]
        res = simulate(h, frm[0], frm[1], ax, az, power)
        n = self.hole
        p["strokes"][n] += 1 + (OOB_PENALTY if res["oob"] else 0)
        p["ball"] = tuple(res["end"])
        p["busy_until"] = t + res["ticks"] / TICK + SHOT_GRACE
        if res["holed"]:
            p["done"] = True
        elif p["strokes"][n] >= MAX_STROKES:
            p["strokes"][n] = MAX_STROKES
            p["done"] = True
        ev = {"user": p["user"], "seq": seq, "hole": n, "from": list(frm), "ax": ax, "az": az, "power": power,
              "end": res["end"], "holed": res["holed"], "oob": res["oob"], "ticks": res["ticks"],
              "strokes": p["strokes"][n], "done": p["done"]}
        self.last_shot[uid] = {"ev": ev, "at": t}
        return ev, None

    def pick_up(self, uids: list[str]) -> list[str]:
        """Everyone listed who hasn't finished takes MAX_STROKES for the hole."""
        took = []
        for uid in uids:
            p = self.players.get(uid)
            if self.phase == "playing" and p is not None and not p["done"]:
                p["strokes"][self.hole] = MAX_STROKES
                p["done"] = True
                took.append(uid)
        return took

    def advance(self, t: float, last_ticks: int = 0) -> tuple[str, dict] | None:
        """If everyone is done with the hole: ("hole", data) or ("done", data)."""
        if self.phase != "playing" or not self.players or not all(p["done"] for p in self.players.values()):
            return None
        holes = self.holes()
        card = self.card()
        if self.hole + 1 >= len(holes):
            self.phase = "done"
            totals = {uid: sum(s) for uid, s in card.items()}
            best = min(totals.values())
            winners = [uid for uid, v in totals.items() if v == best]
            return "done", {"card": card, "totals": totals, "par": [h["par"] for h in holes], "winners": winners,
                            "course": self.course}
        self.hole += 1
        tee = holes[self.hole]["tee"]
        for p in self.players.values():
            p["ball"], p["done"], p["busy_until"] = tee, False, 0.0
        self.hole_ready_at = t + last_ticks / TICK + HOLE_PAUSE
        self.last_shot = {}
        return "hole", {"hole": self.hole, "delayMs": int((self.hole_ready_at - t) * 1000), "card": card}

    def end(self) -> None:
        self.phase = "idle"
        self.players = {}
        self.last_shot = {}

    def pos(self, uid: str, msg: dict, t: float) -> dict | None:
        """A walking update to relay, or None (throttled, not playing, or malformed)."""
        if uid not in self.players or self.phase != "playing":
            return None
        if t - self.last_pos.get(uid, -1e9) < POS_GAP:
            return None
        x0, z0, x1, z1 = self.holes()[self.hole]["bbox"]
        x = as_int(msg.get("x"), x0 - 2 * TILE, x1 + 2 * TILE)
        z = as_int(msg.get("z"), z0 - 2 * TILE, z1 + 2 * TILE)
        r = as_int(msg.get("r"), -100000, 100000)
        a = as_int(msg.get("a"), 0, 7)
        if x is None or z is None or r is None or a is None:
            return None
        self.last_pos[uid] = t
        return {"u": uid, "x": x, "z": z, "r": r % 360, "a": a}

    def drop(self, uid: str) -> bool:
        """Remove a player; True if they were in the round."""
        self.last_pos.pop(uid, None)
        self.last_shot.pop(uid, None)
        if self.players.pop(uid, None) is None:
            return False
        if self.phase == "playing" and not self.players:
            self.phase = "idle"
        return True
