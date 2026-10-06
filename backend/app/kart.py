"""
Kart Racing for the Valley (g = "kart"): the tracks, the grid, and the race referee.

Each player drives their own car in the browser (games/kart.js) and streams where it
is; the server runs a fixed-rate tick (app/realtime.py) that checks every position,
keeps the standings and sends one batched snapshot to the lobby per tick. The server
does not simulate the cars: it checks that each move is on the road and no faster
than a car can go, counts laps in order around the track, and times the finish.

Tracks live in kart_tracks.json (a byte copy of games/kart/tracks.json). A track is a
loop of 10 m tiles written as letters from the start line, driving north first: F the
finish straight, S a straight, L/R a 90-degree corner. Geometry (metres, tile-local,
origin at the tile centre) matches Kenney's Starter Kit Racing pieces: a straight's road
is 9 m wide between its barriers; a corner is a quarter ring around the tile corner it
turns about, from radius 0.5 to 9.5 m (centre line 5 m). Everything is drawn and checked
at SCALE (1.5x: 15 m tiles, a 13.5 m road) so eight cars have room.

Units on the wire: x, z in centimetres, yaw in whole degrees, speed in decimetres/s,
the sender's clock in centiseconds (q). Nothing transcript-derived ever travels.
"""
import json
import math
import os
from typing import Any

SCALE = 1.5                  # the kit's 10 m pieces drawn 1.5x: a 13.5 m road fits 8 cars
TILE = 10.0 * SCALE
HALF = TILE / 2
ROAD_HALF = 4.5 * SCALE      # straight: road from -6.75 to 6.75 m across
R_IN, R_MID, R_OUT = 0.5 * SCALE, 5.0 * SCALE, 9.5 * SCALE
MARGIN = 1.5                 # off the road by more than this (m): not a real position
MAX_SPEED = 34.0             # m/s; the browser's car tops out at 30
SLACK = 2.5                  # m of distance allowed on top of MAX_SPEED x dt (bunched frames)
CLOCK_LEAD = 0.6             # s a sender's clock may run ahead of ours, summed over the race
MAX_STEP_TILES = 3           # one update may move the track distance at most this far
HZ = 15                      # server ticks per second while a race is on
COUNTDOWN = 4.0              # seconds from "start" to "go"
FINISH_GRACE = 30.0          # after the winner crosses the line, the rest get this long
MAX_RACE = 600.0             # a race is called after 10 minutes whatever happens
GRACE = 20.0                 # a dropped racer's car waits this long for a rejoin
POS_RATE = 25.0              # position frames per second per player (clients send 20)
POS_BURST = 10
FIX_GAP = 0.5                # at most one "back to the road" correction per this long
MAX_PLAYERS = 8
CARS = 5                     # four trucks and a motorcycle
MIN_LAPS, MAX_LAPS = 1, 5
DIRS = ((0, -1), (1, 0), (0, 1), (-1, 0))     # headings: north (-z), east, south, west

_HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(_HERE, "kart_tracks.json"), encoding="utf-8") as _f:
    DATA = json.load(_f)


def compile_track(path: str) -> dict:
    """The tile loop for a path string: cells in order, each with its kind, the heading
    it is entered with (d) and left with (o), and a corner's pivot (tile-local)."""
    col = row = 0
    d = 0
    tiles: list[dict] = []
    cells: dict[tuple[int, int], int] = {}
    for i, ch in enumerate(path):
        if ch not in "FSLR" or (col, row) in cells:
            raise ValueError(f"bad track at tile {i}")
        o = (d + 1) % 4 if ch == "R" else (d - 1) % 4 if ch == "L" else d
        t = {"col": col, "row": row, "kind": "C" if ch in "LR" else ch, "d": d, "o": o}
        if ch in "LR":
            ex, ez = DIRS[(d + 2) % 4]          # the side we came in through
            ox, oz = DIRS[o]                    # the side we leave by
            t["pivot"] = ((ex + ox) * HALF, (ez + oz) * HALF)
        cells[(col, row)] = i
        tiles.append(t)
        d = o
        col, row = col + DIRS[d][0], row + DIRS[d][1]
    if (col, row) != (0, 0) or d != 0 or not path.startswith("F"):
        raise ValueError("track does not close on its start line")
    return {"tiles": tiles, "cells": cells, "n": len(tiles)}


TRACKS: dict[str, dict] = {}
for _t in DATA["tracks"]:
    TRACKS[_t["id"]] = {"id": _t["id"], "name": _t["name"], "laps": int(_t.get("laps", 3)),
                        **compile_track(_t["path"])}


def cell_of(v: float) -> int:
    return math.floor((v + HALF) / TILE)


def locate(tr: dict, x: float, z: float) -> tuple[int, float, float] | None:
    """(tile index, distance along it 0..1, metres off the centre line) for a point on
    the track's tiles, else None."""
    i = tr["cells"].get((cell_of(x), cell_of(z)))
    if i is None:
        return None
    t = tr["tiles"][i]
    lx, lz = x - t["col"] * TILE, z - t["row"] * TILE
    if t["kind"] != "C":
        hx, hz = DIRS[t["d"]]
        along = lx * hx + lz * hz
        lat = lx * -hz + lz * hx
        return i, min(1.0, max(0.0, (along + HALF) / TILE)), lat
    px, pz = t["pivot"]
    vx, vz = lx - px, lz - pz
    r = math.hypot(vx, vz)
    ax, az = -DIRS[t["o"]][0], -DIRS[t["o"]][1]          # pivot -> entry edge, as a direction
    ang = abs(math.atan2(ax * vz - az * vx, ax * vx + az * vz))
    return i, min(1.0, max(0.0, ang / (math.pi / 2))), r - R_MID


def point_at(tr: dict, u: float, lat: float = 0.0) -> tuple[float, float, float]:
    """(x, z, yaw in degrees) at track distance u (tiles from the start of tile 0, any
    lap), `lat` metres right of the centre line. Yaw 0 = north (-z), 90 = east (+x)."""
    n = tr["n"]
    w = u % n
    i = min(n - 1, int(w))
    s = w - i
    t = tr["tiles"][i]
    cx, cz = t["col"] * TILE, t["row"] * TILE
    if t["kind"] != "C":
        hx, hz = DIRS[t["d"]]
        x = cx + hx * (s * TILE - HALF) - hz * lat
        z = cz + hz * (s * TILE - HALF) + hx * lat
        return x, z, math.degrees(math.atan2(hx, -hz)) % 360
    a0x, a0z = -DIRS[t["o"]][0], -DIRS[t["o"]][1]
    a1x, a1z = DIRS[t["d"]]
    th = s * math.pi / 2
    turn = 1 if t["o"] == (t["d"] + 1) % 4 else -1           # right turns: "right" is towards the pivot
    rad = R_MID - lat * turn
    px, pz = t["pivot"]
    vx, vz = a0x * math.cos(th) + a1x * math.sin(th), a0z * math.cos(th) + a1z * math.sin(th)
    tx, tz = -a0x * math.sin(th) + a1x * math.cos(th), -a0z * math.sin(th) + a1z * math.cos(th)
    return cx + px + vx * rad, cz + pz + vz * rad, math.degrees(math.atan2(tx, -tz)) % 360


def on_road(tr: dict, x: float, z: float, margin: float = 0.0) -> bool:
    loc = locate(tr, x, z)
    return loc is not None and abs(loc[2]) <= ROAD_HALF + margin


def grid_slot(tr: dict, k: int) -> tuple[float, float]:
    """Start position k (0 = pole) behind the line in the middle of tile 0, two abreast,
    facing north. The line is at z = 0; the grid runs back into the tile behind it."""
    return (-3.0 if k % 2 == 0 else 3.0), 4.0 + (k // 2) * 4.0 + (2.0 if k % 2 else 0.0)


def as_num(v: Any, lo: float, hi: float) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or v in (float("inf"), float("-inf")):
        return None
    return min(hi, max(lo, float(v)))


class Kart:
    """One room's race. idle -> grid (countdown) -> race -> done; the host starts the
    next one from done or idle."""

    def __init__(self) -> None:
        self.track: str | None = None
        self.laps = 3
        self.phase = "idle"
        self.go_at = 0.0
        self.first_at: float | None = None        # when the winner finished
        self.players: dict[str, dict] = {}
        self.cars: dict[str, int] = {}            # user_id -> vehicle, kept between races
        self.results: list[dict] | None = None
        self.dirty: set[str] = set()
        self.order_sig: tuple = ()

    # -- views --
    def tr(self) -> dict | None:
        return TRACKS.get(self.track) if self.track else None

    def ms(self, t: float) -> int:
        return max(0, int(round((t - self.go_at) * 1000)))

    def lap_of(self, p: dict) -> int:
        tr = self.tr()
        n = tr["n"] if tr else 1
        return max(1, min(self.laps, math.floor((p["u"] - 0.5) / n) + 1))

    def order(self) -> list[str]:
        """Standings: finishers by time, then by distance covered, dropped racers last."""
        def key(item: tuple[str, dict]) -> tuple:
            p = item[1]
            if p["fin"] is not None:
                return (0, p["fin"], 0.0)
            return (1 if not p["dnf"] else 2, 0, -p["u"])
        return [uid for uid, _ in sorted(self.players.items(), key=key)]

    def view(self, t: float) -> dict | None:
        if self.track is None:
            return None
        order = self.order()
        return {"track": self.track, "laps": self.laps, "phase": self.phase,
                "goInMs": max(0, int((self.go_at - t) * 1000)) if self.phase == "grid" else 0,
                "raceMs": self.ms(t) if self.phase == "race" else 0,
                "players": [{"user": p["user"], "slot": p["slot"], "car": p["car"], "lap": self.lap_of(p),
                             "place": order.index(uid) + 1, "fin": p["fin"], "dnf": p["dnf"], "away": p["away"],
                             "x": p["x"], "z": p["z"], "r": p["r"]}
                            for uid, p in self.players.items()],
                "results": self.results, "cars": dict(self.cars)}

    # -- ops --
    def car(self, uid: str, msg: dict) -> int | None:
        c = as_num(msg.get("car"), -1, CARS)
        if c is None or c != int(c) or not 0 <= c < CARS:
            return None
        self.cars[uid] = int(c)
        if uid in self.players and self.phase in ("idle", "grid", "done"):
            self.players[uid]["car"] = int(c)
        return int(c)

    def start(self, members: dict[str, dict], track: Any, laps: Any, t: float) -> str | None:
        if self.phase in ("grid", "race"):
            return "a race is already on: the host can end it first"
        if not isinstance(track, str) or track not in TRACKS:
            return "pick a track"
        tr = TRACKS[track]
        n_laps = as_num(laps, MIN_LAPS, MAX_LAPS)
        self.track = track
        self.laps = int(n_laps) if n_laps is not None else tr["laps"]
        self.phase = "grid"
        self.go_at = t + COUNTDOWN
        self.first_at = None
        self.results = None
        self.players = {}
        for k, (uid, pub) in enumerate(list(members.items())[:MAX_PLAYERS]):
            gx, gz = grid_slot(tr, k)
            self.players[uid] = {"user": pub, "slot": k, "car": self.cars.get(uid, k % CARS),
                                 "x": int(gx * 100), "z": int(gz * 100), "r": 0, "s": 0, "dr": 0, "q": None, "q0": 0, "t0": t,
                                 "u": 0.5 - gz / TILE, "at": t, "lap_at": [], "fin": None, "dnf": False,
                                 "away": None, "bucket": [float(POS_BURST), t], "fix_at": 0.0, "bad": 0}
        self.dirty = set(self.players)
        self.order_sig = ()
        return None

    def end(self) -> None:
        self.phase = "idle"
        self.players = {}
        self.results = None
        self.first_at = None

    def pos(self, uid: str, msg: dict, t: float) -> tuple[bool, dict | None]:
        """A position frame from a driver. Returns (accepted, correction to send back).
        Before the green light, and after you finish, frames are ignored."""
        p = self.players.get(uid)
        tr = self.tr()
        if p is None or tr is None or self.phase != "race" or p["fin"] is not None or p["dnf"]:
            return False, None
        b = p["bucket"]
        b[0] = min(float(POS_BURST), b[0] + (t - b[1]) * POS_RATE)
        b[1] = t
        if b[0] < 1.0:
            return False, None
        b[0] -= 1.0
        x, z = as_num(msg.get("x"), -1e7, 1e7), as_num(msg.get("z"), -1e7, 1e7)
        r, s = as_num(msg.get("r"), -100000, 100000), as_num(msg.get("s"), -1000, 1000)
        if x is None or z is None or r is None:
            return False, None
        q = as_num(msg.get("q"), 0, (1 << 30) - 1)
        q = int(q) if q is not None else None
        # Elapsed time between this frame and the last one we took. Frames arrive bunched
        # and out of order (jitter), so the sender's own clock (q, centiseconds) is the
        # honest measure; an older frame than the last one taken is just stale. A client
        # can't buy speed by running its clock fast: since its first frame, its clock may
        # never get more than CLOCK_LEAD seconds ahead of ours.
        if q is not None and p["q"] is not None:
            if q <= p["q"]:
                return False, None
            dt = (q - p["q"]) / 100.0
            if (q - p["q0"]) / 100.0 > (t - p["t0"]) + CLOCK_LEAD:
                dt = -1.0
        else:
            dt = max(0.0, t - p["at"])
        xm, zm = x / 100.0, z / 100.0
        loc = locate(tr, xm, zm)
        moved = math.hypot(xm - p["x"] / 100.0, zm - p["z"] / 100.0)
        ok = dt >= 0 and loc is not None and abs(loc[2]) <= ROAD_HALF + MARGIN and moved <= MAX_SPEED * dt + SLACK
        if ok:
            n = tr["n"]
            d_now = loc[0] + loc[1]
            delta = (d_now - p["u"]) % n
            if delta >= n / 2:
                delta -= n
            ok = abs(delta) <= MAX_STEP_TILES
        if not ok:
            p["bad"] += 1
            if t - p["fix_at"] < FIX_GAP:
                return False, None
            p["fix_at"] = t
            return False, {"x": p["x"], "z": p["z"], "r": p["r"]}
        before = self.lap_of(p)
        p["u"] += delta
        p["x"], p["z"], p["r"] = int(x), int(z), int(r) % 360
        p["s"] = int(s) if s is not None else 0
        p["dr"] = 1 if msg.get("dr") else 0
        if q is not None and p["q"] is None:
            p["q0"], p["t0"] = q, t
        p["q"] = q
        p["at"] = t
        self.dirty.add(uid)
        after = self.lap_of(p)
        if after > before:
            p["lap_at"].append(self.ms(t))
        if p["u"] >= 0.5 + self.laps * tr["n"]:
            p["fin"] = self.ms(t)
            p["lap_at"].append(p["fin"])
            if self.first_at is None:
                self.first_at = t
        return True, None

    def tick(self, t: float, send: bool) -> list[tuple[str, dict]]:
        """Advance the race clock; returns the events for the lobby, in order."""
        evs: list[tuple[str, dict]] = []
        if self.phase == "grid" and t >= self.go_at:
            self.phase = "race"
            for p in self.players.values():
                p["at"] = t
                p["bucket"] = [float(POS_BURST), t]
            evs.append(("go", {"track": self.track}))
        if self.phase != "race":
            return evs
        for uid, p in self.players.items():
            if p["away"] is not None and not p["dnf"] and p["fin"] is None and t - p["away"] >= GRACE:
                p["dnf"] = True
                evs.append(("dnf", {"user": uid}))
            if p["fin"] is not None and not p.get("told"):
                p["told"] = True
                evs.append(("finish", {"user": uid, "ms": p["fin"], "place": self.order().index(uid) + 1,
                                       "laps": p["lap_at"]}))
        racing = [p for p in self.players.values() if p["fin"] is None and not p["dnf"]]
        late = self.first_at is not None and t - self.first_at >= FINISH_GRACE
        if not racing or late or t - self.go_at >= MAX_RACE or not self.players:
            self.phase = "done"
            order = self.order()
            self.results = [{"user": self.players[u]["user"], "place": i + 1, "ms": self.players[u]["fin"],
                             "dnf": self.players[u]["fin"] is None, "laps": self.players[u]["lap_at"]}
                            for i, u in enumerate(order)]
            evs.append(("done", {"results": self.results, "track": self.track}))
            return evs
        order = tuple(self.order())
        if send and (self.dirty or order != self.order_sig):
            cars = []
            for uid in self.dirty:
                p = self.players.get(uid)
                if p is None:
                    continue
                c = {"u": uid, "x": p["x"], "z": p["z"], "r": p["r"], "s": p["s"], "lap": self.lap_of(p)}
                if p["dr"]:
                    c["dr"] = 1
                if p["q"] is not None:
                    c["q"] = p["q"]
                cars.append(c)
            evs.append(("snap", {"ms": self.ms(t), "cars": cars, "order": list(order)}))
            self.dirty = set()
            self.order_sig = order
        return evs

    def running(self) -> bool:
        return self.phase in ("grid", "race")

    def drop(self, uid: str, t: float, blip: bool = False) -> bool:
        """A racer left. Mid-race a dropped socket (blip) keeps their car on track for
        GRACE seconds; an explicit leave is a DNF. On the grid they just go."""
        p = self.players.get(uid)
        if p is None:
            return False
        if self.phase == "race" and p["fin"] is None and not p["dnf"]:
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
