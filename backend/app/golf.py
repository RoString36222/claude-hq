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
Moving obstacles (windmill blades, sliding gates) are functions of the shot clock: the
client sends the phase it putted at ("clk", 0..CLOCK-1) and both sides roll from it.
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
# Surfaces, bumpers and the shot clock that drives every moving obstacle.
SAND_DRAG = 150              # sand: much more drag and rolling resistance
SAND_ROLL = 420
ICE_DRAG = 6                 # ice: almost none
ICE_ROLL = 22
BUMP_NUM = 5                 # a bumper sends the ball off at 5/4 of its normal speed
BUMP_DEN = 4
CLOCK = 2880                 # the shot clock wraps every 24 s; every mover's period divides it
BLADE_GAP = 144              # a windmill blade passes the doorway every 144 ticks ...
BLADE_HIT = 20               # ... and blocks it for 20 ticks either side of straight down
Z_SAND = 1
Z_ICE = 2
Z_WATER = 3
ZONES = {"sand": Z_SAND, "ice": Z_ICE, "water": Z_WATER}
OCT = ((1000, 0), (707, 707), (0, 1000), (-707, 707), (-1000, 0), (-707, -707), (0, -1000), (707, -707))


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


def seg(x1: int, z1: int, x2: int, z2: int, kind: int) -> tuple:
    dx, dz = x2 - x1, z2 - z1
    return (x1, z1, dx, dz, isqrt(dx * dx + dz * dz) or 1, kind)


def box(x1: int, z1: int, x2: int, z2: int) -> tuple[int, int, int, int]:
    return (min(x1, x2), min(z1, z2), max(x1, x2), max(z1, z2))


def _i(v: Any) -> int:
    """JS `v|0` for the small integers in the course file."""
    return int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else 0


# ------------------------------------------------------------------ courses --
_DATA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "golf_courses.json")
with open(_DATA_PATH, encoding="utf-8") as _f:
    DATA: dict = json.load(_f)
COURSES: dict[str, dict] = {c["id"]: c for c in DATA["courses"]}


def compile_hole(hole: dict, pieces: dict | None = None) -> dict:
    """Place every tile: world wall segments, a per-cell broad phase, floor cells,
    voids, slopes, surfaces, bumpers, moving obstacles, the tee and the cup."""
    pieces = pieces if pieces is not None else DATA["pieces"]
    segs: list[tuple] = []
    seen: set = set()
    floor: set = set()
    voids: list[tuple[int, int, int, int]] = []
    slopes: list[tuple] = []
    zones: list[tuple] = []
    movers: list[tuple] = []
    bumpers: list[tuple[int, int, int]] = []
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
            segs.append(seg(s[0], s[1], s[2], s[3], 0))
        for x1, z1, x2, z2 in p.get("voids", []):
            ax, az = rot(x1, z1, k)
            bx, bz = rot(x2, z2, k)
            voids.append(box(cx + ax, cz + az, cx + bx, cz + bz))
        # a slope: a box where gravity pulls the ball along (gx, gz) every tick
        for x1, z1, x2, z2, gx, gz in p.get("slopes", []):
            ax, az = rot(x1, z1, k)
            bx, bz = rot(x2, z2, k)
            g = rot(gx, gz, k)
            slopes.append(box(cx + ax, cz + az, cx + bx, cz + bz) + g)
        if "blades" in p:
            ax, az = rot(p["blades"][0], p["blades"][1], k)
            bx, bz = rot(p["blades"][2], p["blades"][3], k)
            movers.append((0, seg(cx + ax, cz + az, cx + bx, cz + bz, 0)))
        if "tee" in p:
            tx, tz = rot(p["tee"][0], p["tee"][1], k)
            tee = (cx + tx, cz + tz)
        if "cup" in p:
            ux, uz = rot(p["cup"][0], p["cup"][1], k)
            cup = (cx + ux, cz + uz)
    # per-hole surfaces: [kind, col, row, x1, z1, x2, z2] (tile-local, not rotated)
    for z in hole.get("zones", []):
        c, r = _i(z[1]) * TILE, _i(z[2]) * TILE
        zones.append((ZONES.get(z[0], 0),) + box(c + _i(z[3]), r + _i(z[4]), c + _i(z[5]), r + _i(z[6])))
    # bumpers: [col, row, x, z, radius], an octagon that kicks the ball back harder than a wall
    for b in hole.get("bumpers", []):
        x, z, rad = _i(b[0]) * TILE + _i(b[2]), _i(b[1]) * TILE + _i(b[3]), _i(b[4])
        pts = [(x + tdiv(rad * o[0], 1000), z + tdiv(rad * o[1], 1000)) for o in OCT]
        for i, p0 in enumerate(pts):
            q = pts[(i + 1) % 8]
            segs.append(seg(p0[0], p0[1], q[0], q[1], 1))
        bumpers.append((x, z, rad))
    # sliders: ["slider", col, row, axis (0 = x, 1 = z), half width, half depth, travel, period, phase]
    for m in hole.get("movers", []):
        if m[0] == "slider":
            movers.append((1, _i(m[1]) * TILE, _i(m[2]) * TILE) + tuple(_i(v) for v in m[3:9]))
    grid: dict[tuple[int, int], list[int]] = {}
    for i, sg in enumerate(segs):
        x1, z1, dx, dz = sg[0], sg[1], sg[2], sg[3]
        lo_x, hi_x = min(x1, x1 + dx) - R, max(x1, x1 + dx) + R
        lo_z, hi_z = min(z1, z1 + dz) - R, max(z1, z1 + dz) + R
        for c in range(cell_of(lo_x), cell_of(hi_x) + 1):
            for r in range(cell_of(lo_z), cell_of(hi_z) + 1):
                grid.setdefault((c, r), []).append(i)
    return {"name": hole["name"], "par": hole["par"], "segs": segs, "grid": grid, "floor": floor,
            "voids": voids, "slopes": slopes, "zones": zones, "movers": movers, "bumpers": bumpers,
            "tee": tee, "cup": cup,
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


def zone_at(h: dict, x: int, z: int) -> int:
    for kind, x1, z1, x2, z2 in h["zones"]:
        if x1 < x < x2 and z1 < z < z2:
            return kind
    return 0


def slope_at(h: dict, x: int, z: int) -> tuple | None:
    for v in h["slopes"]:
        if v[0] < x < v[2] and v[1] < z < v[3]:
            return v
    return None


def slide_off(m: tuple, ph: int) -> int:
    """A slider's centre offset along its axis at clock phase ph (a triangle wave)."""
    u = (ph + m[8]) % m[7]
    half = tdiv(m[7], 2)
    tri = u if u < half else m[7] - u
    return -m[6] + tdiv(2 * m[6] * tri, half)


def blades_down(ph: int) -> bool:
    """Windmill blades block their doorway while one sweeps past the bottom."""
    return (ph + BLADE_HIT) % BLADE_GAP < 2 * BLADE_HIT


def mover_segs(h: dict, ph: int) -> list[tuple]:
    """The obstacle walls that exist at clock phase ph."""
    out = []
    for m in h["movers"]:
        if m[0] == 0:
            if blades_down(ph):
                out.append(m[1])
            continue
        off = slide_off(m, ph)
        x, z = m[1] + (0 if m[3] else off), m[2] + (off if m[3] else 0)
        x1, z1, x2, z2 = x - m[4], z - m[5], x + m[4], z + m[5]
        out += [seg(x1, z1, x2, z1, 0), seg(x2, z1, x2, z2, 0), seg(x2, z2, x1, z2, 0), seg(x1, z2, x1, z1, 0)]
    return out


# ----------------------------------------------------------------- simulate --
def launch(ax: int, az: int, power: int) -> tuple[int, int]:
    m = isqrt(ax * ax + az * az) or 1
    sp = VMIN + tdiv((power - 1) * (VMAX - VMIN), 99)
    return tdiv(ax * sp, m), tdiv(az * sp, m)


def simulate(h: dict, bx: int, bz: int, ax: int, az: int, power: int, clk: int = 0) -> dict:
    """Roll one shot from the shot clock's phase clk. Returns {end:[x,z], holed, oob, water, ticks}."""
    sx, sz = bx, bz
    vx, vz = launch(ax, az, power)
    cx, cz = h["cup"]
    segs, grid = h["segs"], h["grid"]
    rr = R * R
    clk %= CLOCK

    def hit(sg: tuple) -> None:
        nonlocal bx, bz, vx, vz
        x1, z1, dx, dz, L, kind = sg
        p = tdiv((bx - x1) * dx + (bz - z1) * dz, L)
        p = 0 if p < 0 else (L if p > L else p)
        px, pz = x1 + tdiv(dx * p, L), z1 + tdiv(dz * p, L)
        ox, oz = bx - px, bz - pz
        d2 = ox * ox + oz * oz
        if d2 < rr:
            d = isqrt(d2) or 1
            bx, bz = px + tdiv(ox * R, d), pz + tdiv(oz * R, d)
            vn = tdiv(vx * ox + vz * oz, d)
            num, den = (BUMP_NUM, BUMP_DEN) if kind else (REST_NUM, REST_DEN)
            if vn < 0:
                vx -= tdiv((den + num) * vn * ox, den * d)
                vz -= tdiv((den + num) * vn * oz, den * d)

    for t in range(1, MAX_TICKS + 1):
        dyn = mover_segs(h, (clk + t) % CLOCK) if h["movers"] else []
        s = isqrt(vx * vx + vz * vz)
        n = max(1, tdiv(s + SUBSTEP - 1, SUBSTEP))
        for _ in range(n):
            bx += tdiv(vx, n * VS)
            bz += tdiv(vz, n * VS)
            for i in grid.get((cell_of(bx), cell_of(bz)), ()):
                hit(segs[i])
            for sg in dyn:
                hit(sg)
        sl = slope_at(h, bx, bz)
        if sl is not None:
            vx += sl[4]
            vz += sl[5]
        s = isqrt(vx * vx + vz * vz)
        if s > VMAX:
            vx, vz = tdiv(vx * VMAX, s), tdiv(vz * VMAX, s)
            s = isqrt(vx * vx + vz * vz)
        ddx, ddz = bx - cx, bz - cz
        if ddx * ddx + ddz * ddz < CUP * CUP and s <= CAPTURE:
            return {"end": [cx, cz], "holed": True, "oob": False, "water": False, "ticks": t}
        if not on_floor(h, bx, bz):
            return {"end": [sx, sz], "holed": False, "oob": True, "water": False, "ticks": t}
        zk = zone_at(h, bx, bz)
        if zk == Z_WATER:
            return {"end": [sx, sz], "holed": False, "oob": True, "water": True, "ticks": t}
        dn = SAND_DRAG if zk == Z_SAND else ICE_DRAG if zk == Z_ICE else DRAG_NUM
        rl = SAND_ROLL if zk == Z_SAND else ICE_ROLL if zk == Z_ICE else ROLL
        ns = s - tdiv(s * dn, DRAG_DEN) - rl
        if ns <= STOP:
            if sl is None:
                return {"end": [bx, bz], "holed": False, "oob": False, "water": False, "ticks": t}
            if ns < 0:
                ns = 0           # on a slope the ball never rests: gravity takes it next tick
        if s:
            vx, vz = tdiv(vx * ns, s), tdiv(vz * ns, s)
    return {"end": [bx, bz], "holed": False, "oob": False, "water": False, "ticks": MAX_TICKS}


def as_int(v: Any, lo: int, hi: int) -> int | None:
    """A JSON number coerced to a clamped int; None for anything else."""
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or v in (float("inf"), float("-inf")):
        return None
    return max(lo, min(hi, int(v)))


# ------------------------------------------------------------------- referee --
HOLE_PAUSE = 4.0             # scorecard cut-scene between holes (seconds)
SHOT_GRACE = 0.3
POS_BURST = 3                # walking updates: a token bucket per player, 3 deep,
POS_RATE = 12.0              # refilled 12 per second (clients send <= 10/s)
PARK_SECS = 120.0            # a dropped player's card is kept this long for a rejoin
GRACE = 15.0                 # a socket drop holds the hole open this long for a rejoin
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
        self.bucket: dict[str, list[float]] = {}   # user_id -> [tokens, last refill time]
        self.parked: dict[str, dict] = {}          # user_id -> {p, hole, at, course, blip}
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
        self.parked = {}
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
        hole_no = msg.get("hole")
        if hole_no is not None and as_int(hole_no, -1, 1 << 16) != self.hole:
            return None, "that hole is over"
        if t < max(p["busy_until"], self.hole_ready_at):
            return None, "wait for the ball to stop"
        ax, az = as_int(msg.get("ax"), -AIM_MAX, AIM_MAX), as_int(msg.get("az"), -AIM_MAX, AIM_MAX)
        power = as_int(msg.get("power"), 1, 100)
        if ax is None or az is None or power is None or (ax == 0 and az == 0):
            return None, "bad shot"
        seq = as_int(msg.get("seq"), 0, 1 << 30) or 0
        clk = as_int(msg.get("clk"), 0, CLOCK - 1) or 0     # the shot clock's phase at the putt
        h = self.holes()[self.hole]
        frm = p["ball"]
        res = simulate(h, frm[0], frm[1], ax, az, power, clk)
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
              "clk": clk, "end": res["end"], "holed": res["holed"], "oob": res["oob"], "water": res["water"],
              "ticks": res["ticks"],
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
        """If everyone is done with the hole: ("hole", data) or ("done", data). A player
        whose socket dropped mid-hole less than GRACE ago still counts as playing it."""
        self.expire(t)
        if self.phase != "playing" or not self.players or not all(p["done"] for p in self.players.values()) \
                or self.holding(t):
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
        self.parked = {}

    def holding(self, t: float) -> bool:
        """Someone dropped off the network mid-hole and may still come back to it."""
        return any(k["blip"] and k["hole"] == self.hole and not k["p"]["done"] and t - k["at"] < GRACE
                   for k in self.parked.values())

    def grace_left(self, t: float) -> float | None:
        """Seconds until the last hold on this hole runs out (None: nothing held)."""
        left = [GRACE - (t - k["at"]) for k in self.parked.values()
                if k["blip"] and k["hole"] == self.hole and not k["p"]["done"] and t - k["at"] < GRACE]
        return max(left) if left else None

    def release(self) -> None:
        """The host skipped the hole: nobody parked holds it any more."""
        for k in self.parked.values():
            k["blip"] = False

    def expire(self, t: float) -> bool:
        """With nobody left in the round and no hold, it ends. True if it just did."""
        if self.phase == "playing" and not self.players and not self.holding(t):
            self.phase = "idle"
            self.parked = {}
            self.last_shot = {}
            return True
        return False

    def pos(self, uid: str, msg: dict, t: float) -> dict | None:
        """A walking update to relay, or None (over the rate, not playing, or malformed).
        Rate: a token bucket (POS_BURST deep, POS_RATE/s), so network bunching of a
        10 Hz sender never drops the final "stopped here" frame. No storage, no DB."""
        if uid not in self.players or self.phase != "playing":
            return None
        b = self.bucket.get(uid)
        if b is None:
            b = self.bucket[uid] = [float(POS_BURST), t]
        b[0] = min(float(POS_BURST), b[0] + (t - b[1]) * POS_RATE)
        b[1] = t
        if b[0] < 1.0:
            return None
        x0, z0, x1, z1 = self.holes()[self.hole]["bbox"]
        x = as_int(msg.get("x"), x0 - 2 * TILE, x1 + 2 * TILE)
        z = as_int(msg.get("z"), z0 - 2 * TILE, z1 + 2 * TILE)
        r = as_int(msg.get("r"), -100000, 100000)
        a = as_int(msg.get("a"), 0, 7)
        if x is None or z is None or r is None or a is None:
            return None
        b[0] -= 1.0
        q = as_int(msg.get("q"), 0, (1 << 30) - 1)
        out = {"u": uid, "x": x, "z": z, "r": r % 360, "a": a}
        if q is not None:
            out["q"] = q
        return out

    def drop(self, uid: str, t: float = 0.0, blip: bool = False) -> bool:
        """Remove a player; True if they were in the round. Mid-round their card is
        parked for PARK_SECS so a reconnect restores it. blip: the socket dropped (not
        an explicit leave), so the hole also waits GRACE seconds for them."""
        self.bucket.pop(uid, None)
        self.last_shot.pop(uid, None)
        p = self.players.pop(uid, None)
        if p is None:
            return False
        if self.phase == "playing":
            self.parked[uid] = {"p": p, "hole": self.hole, "at": t, "course": self.course, "blip": blip}
            self.expire(t)
        return True

    def restore(self, uid: str, pub: dict, t: float) -> bool:
        """A parked player rejoined the lobby: put them back in the round. Holes that
        finished without them count as picked up."""
        k = self.parked.pop(uid, None)
        if k is None or self.phase != "playing" or k["course"] != self.course or t - k["at"] > PARK_SECS \
                or uid in self.players or len(self.players) >= 8:
            return False
        p = k["p"]
        p["user"] = pub
        if k["hole"] != self.hole:
            for i in range(k["hole"], self.hole):
                if i == k["hole"] and p["done"]:
                    continue
                p["strokes"][i] = MAX_STROKES
            p["ball"], p["done"], p["busy_until"] = self.holes()[self.hole]["tee"], False, 0.0
        self.players[uid] = p
        return True
