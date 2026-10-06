"""Kart Racing (app/kart.py, the kart branch of app/valley.py) and the real-time tick
(app/realtime.py): track geometry, the referee's checks, an 8-car race under simulated
lag, and a race over real room websockets."""
import asyncio
import heapq
import json
import math
import random
import time

import pytest

from app import kart, realtime, valley
from app.auth import issue_ws_ticket
from tests.conftest import make_user


def url(room, uid):
    return f"/v1/rooms/{room}/ws?ticket={issue_ws_ticket(uid)}"


def until(ws, ev, limit=200, where=None):
    for _ in range(limit):
        m = ws.receive_json()
        if m.get("type") == "game" and m.get("g") == "kart" and m.get("ev") == ev and (where is None or where(m)):
            return m
    raise AssertionError(f"no {ev} event")


def send(ws, op, **data):
    ws.send_json({"type": "game", "g": "kart", "op": op, **data})


def pub(uid):
    return {"userId": uid, "handle": uid, "displayName": uid, "avatarUrl": ""}


def frame(tr, u, lat=0.0, q=None):
    x, z, r = kart.point_at(tr, u, lat)
    m = {"x": round(x * 100), "z": round(z * 100), "r": round(r), "s": 200}
    if q is not None:
        m["q"] = q
    return m


# ------------------------------------------------------------------ tracks --
def test_tracks_compile_and_close():
    assert len(kart.TRACKS) >= 3
    for tid, tr in kart.TRACKS.items():
        tiles = tr["tiles"]
        assert tiles[0]["kind"] == "F" and tiles[-1]["kind"] == "S", tid   # the grid sits in the tile behind
        assert len({(t["col"], t["row"]) for t in tiles}) == tr["n"]
        for a, b in zip(tiles, tiles[1:] + tiles[:1]):
            assert abs(a["col"] - b["col"]) + abs(a["row"] - b["row"]) == 1, tid


def test_bad_paths_are_refused():
    for bad in ("SSSS", "FSSS", "FRRRR", "FX", "FRRSSRR"):
        with pytest.raises(ValueError):
            kart.compile_track(bad)


def test_centre_line_round_trips_and_road_edges():
    for tid, tr in kart.TRACKS.items():
        for k in range(tr["n"] * 20):
            u = k / 20 + 0.01
            x, z, _ = kart.point_at(tr, u)
            i, s, lat = kart.locate(tr, x, z)
            off = (i + s - u) % tr["n"]
            assert abs(lat) < 1e-6 and min(off, tr["n"] - off) < 1e-6, (tid, u)
            for side in (-4.2, 4.2):
                assert kart.on_road(tr, *kart.point_at(tr, u, side)[:2]), (tid, u, side)
        # well off the road: past a straight's barrier (ROAD_HALF), or off the track's tiles
        assert kart.locate(tr, 1000.0, 1000.0) is None
        x, z, _ = kart.point_at(tr, 0.3, kart.ROAD_HALF - 0.1)
        assert not kart.on_road(tr, x + 2.0, z)


def test_grid_slots_are_on_the_road_behind_the_line_and_apart():
    tr = kart.TRACKS["meadow"]
    pts = [kart.grid_slot(tr, k) for k in range(kart.MAX_PLAYERS)]
    for x, z in pts:
        assert kart.on_road(tr, x, z) and z > 0
    for a in range(len(pts)):
        for b in range(a + 1, len(pts)):
            assert math.dist(pts[a], pts[b]) >= 2.5


# ----------------------------------------------------------------- referee --
def started(n=2, track="meadow", laps=1):
    k = kart.Kart()
    members = {f"u{i}": pub(f"u{i}") for i in range(n)}
    assert k.start(members, track, laps, 100.0) is None
    k.tick(100.0 + kart.COUNTDOWN, True)
    assert k.phase == "race"
    return k, kart.TRACKS[track], 100.0 + kart.COUNTDOWN


def drive(k, tr, uid, u0, u1, t0, speed=20.0, hz=20):
    """Drive uid along the centre line from track distance u0 to u1 at `speed` m/s."""
    t, u = t0, u0
    step = speed / hz / kart.TILE
    while u < u1 and k.players[uid]["fin"] is None:
        u = min(u1, u + step)
        t += 1 / hz
        ok, fix = k.pos(uid, frame(kart.TRACKS[k.track], u), t)
        assert ok and fix is None, (uid, u)
    return t


def test_start_rules():
    k = kart.Kart()
    assert k.start({}, "nope", 3, 0.0) == "pick a track"
    assert k.start({"a": pub("a")}, "meadow", 99, 0.0) is None
    assert k.laps == kart.MAX_LAPS and k.phase == "grid"
    assert k.start({"a": pub("a")}, "meadow", 3, 0.0) is not None      # one at a time
    k.end()
    members = {f"u{i}": pub(f"u{i}") for i in range(12)}
    k.start(members, "canyon", None, 0.0)
    assert len(k.players) == kart.MAX_PLAYERS and k.laps == kart.TRACKS["canyon"]["laps"]


def test_frames_before_the_green_light_are_ignored():
    k = kart.Kart()
    k.start({"a": pub("a")}, "meadow", 1, 0.0)
    tr = kart.TRACKS["meadow"]
    assert k.pos("a", frame(tr, 0.6), 1.0) == (False, None)
    evs = k.tick(kart.COUNTDOWN, True)
    assert evs[0][0] == "go"


def test_a_lap_and_the_finish():
    k, tr, t = started(n=1, laps=2)
    p = k.players["u0"]
    t = drive(k, tr, "u0", p["u"], 0.5 + tr["n"] + 0.2, t)
    assert k.lap_of(p) == 2 and len(p["lap_at"]) == 1
    t = drive(k, tr, "u0", p["u"], 0.5 + 2 * tr["n"] + 0.1, t)
    assert p["fin"] is not None
    evs = k.tick(t + 0.01, True)
    names = [e[0] for e in evs]
    assert "finish" in names and names[-1] == "done"
    assert k.results[0]["place"] == 1 and not k.results[0]["dnf"]


def test_teleports_and_off_road_frames_are_refused_with_a_correction():
    k, tr, t = started(n=1)
    t = drive(k, tr, "u0", k.players["u0"]["u"], 2.0, t)
    before = dict(k.players["u0"])
    ok, fix = k.pos("u0", frame(tr, 9.0), t + 0.05)           # 7 tiles in 50 ms
    assert not ok and fix == {"x": before["x"], "z": before["z"], "r": before["r"]}
    x, z, _ = kart.point_at(tr, 2.1, 8.0)                      # into the grass
    ok, fix = k.pos("u0", {"x": round(x * 100), "z": round(z * 100), "r": 0}, t + 0.6)
    assert not ok and fix is not None
    assert k.players["u0"]["u"] == before["u"] and k.players["u0"]["bad"] == 2


def test_driving_backwards_over_the_line_does_not_count_a_lap():
    k, tr, t = started(n=1, laps=1)
    p = k.players["u0"]
    t = drive(k, tr, "u0", p["u"], 1.0, t)
    # reverse back over the line and forward again: still lap 1, nothing finished
    for u in [0.9 - i * 0.05 for i in range(10)] + [0.45 + i * 0.05 for i in range(10)]:
        t += 0.05
        assert k.pos("u0", frame(tr, u), t)[0]
    assert k.lap_of(p) == 1 and p["fin"] is None and not p["lap_at"]


def test_a_fast_clock_buys_no_speed():
    """A client that claims more time has passed than really has (to make a long jump
    look legal) is caught once its clock runs CLOCK_LEAD ahead of the server's."""
    k, tr, t = started(n=1)
    p = k.players["u0"]
    u, q = p["u"], 10000
    for _ in range(40):                       # honest for 2 s
        u += 0.1; t += 0.05; q += 5
        assert k.pos("u0", frame(tr, u, q=q), t)[0]
    caught = False
    for _ in range(40):                       # then 4x the real speed with a clock to match
        u += 0.4; t += 0.05; q += 20
        ok, fix = k.pos("u0", frame(tr, u, q=q), t)
        if not ok:
            caught = fix is not None
            break
    assert caught and p["bad"] == 1


def test_frames_are_rate_limited():
    k, tr, t = started(n=1)
    took = sum(k.pos("u0", frame(tr, 0.2), t)[0] for _ in range(50))
    assert took <= kart.POS_BURST


def test_standings_and_snapshots_only_carry_what_moved():
    k, tr, t = started(n=3)
    drive(k, tr, "u2", k.players["u2"]["u"], 3.0, t)
    evs = dict(k.tick(t + 1, True))
    assert evs["snap"]["order"][0] == "u2"
    assert [c["u"] for c in evs["snap"]["cars"]] == ["u2"]
    assert "snap" not in dict(k.tick(t + 1.1, True))         # nothing moved, order unchanged
    k.pos("u0", frame(tr, k.players["u0"]["u"] + 0.05), t + 1.2)
    assert "snap" not in dict(k.tick(t + 1.25, False))       # a thinned tick holds it back ...
    assert [c["u"] for c in dict(k.tick(t + 1.3, True))["snap"]["cars"]] == ["u0"]   # ... to the next


def test_a_dropped_racer_keeps_their_car_for_the_grace_then_dnf():
    k, tr, t = started(n=2)
    assert k.drop("u1", t, blip=True) and k.players["u1"]["away"] == t
    assert k.restore("u1", pub("u1")) and k.players["u1"]["away"] is None
    k.drop("u1", t, blip=True)
    evs = k.tick(t + kart.GRACE + 0.1, True)
    assert ("dnf", {"user": "u1"}) in evs
    k.drop("u0", t + kart.GRACE + 0.2)                          # an explicit leave: out at once
    names = [e[0] for e in k.tick(t + kart.GRACE + 0.3, True)]
    assert names[-1] == "done" and all(r["dnf"] for r in k.results)


def test_the_rest_get_finish_grace_after_the_winner():
    k, tr, t = started(n=2, laps=1)
    t = drive(k, tr, "u0", k.players["u0"]["u"], 0.5 + tr["n"] + 0.1, t)
    k.tick(t, True)
    assert k.phase == "race"
    names = [e[0] for e in k.tick(t + kart.FINISH_GRACE + 0.01, True)]
    assert names[-1] == "done"
    assert [r["user"]["userId"] for r in k.results] == ["u0", "u1"] and k.results[1]["dnf"]


# --------------------------------------------- 8 players under simulated lag --
def test_eight_cars_with_lag_finish_in_order_with_no_false_rejections():
    """Eight bots drive at different speeds, weaving across the road, sending 20 frames a
    second through a 120 ms +- 60 ms link (so frames arrive bunched and out of order).
    Every honest frame must be accepted, the finish order must be the true one, and the
    snapshots must stay inside the room's bandwidth budget."""
    rng = random.Random(7)
    tr = kart.TRACKS["peaks"]
    k = kart.Kart()
    members = {f"bot{i}": pub(f"bot{i}") for i in range(8)}
    t0 = 1000.0
    assert k.start(members, "peaks", 2, t0) is None
    go = t0 + kart.COUNTDOWN
    speeds = {f"bot{i}": 24.0 - i * 0.8 for i in range(8)}         # bot0 fastest; all inside FINISH_GRACE
    u = {uid: p["u"] for uid, p in k.players.items()}
    grid_x = {uid: kart.grid_slot(tr, p["slot"])[0] for uid, p in k.players.items()}
    goal = 0.5 + 2 * tr["n"] + 0.2
    q = []                                                          # (arrival, seq, uid, frame)
    seq = 0
    t = t0
    snap_bytes = []
    tick_every = 1 / kart.HZ
    next_tick = t0
    true_finish = {}
    while t < go + 200 and k.phase != "done":
        t = round(t + 0.05, 6)                                      # every client sends at 20 Hz
        if t >= go:
            for uid in members:
                if uid in true_finish:
                    continue
                u[uid] = min(goal, u[uid] + speeds[uid] * 0.05 / kart.TILE)
                w = min(1.0, (t - go) / 2)                          # ease from the grid slot into the weave
                lat = (1 - w) * grid_x[uid] + w * 2.5 * math.sin(u[uid] * 1.7 + int(uid[3:]))
                if u[uid] >= 0.5 + 2 * tr["n"]:
                    true_finish[uid] = t
                delay = min(0.24, max(0.0, rng.gauss(0.12, 0.06)))
                seq += 1
                heapq.heappush(q, (t + delay, seq, uid, frame(tr, u[uid], lat, q=int(t * 100))))
        while q and q[0][0] <= t:
            at, _s, uid, fr = heapq.heappop(q)
            # an out-of-order frame is older than what the server already has: it is
            # dropped as stale, never counted against the driver
            k.pos(uid, fr, at)
        while next_tick <= t:
            for ev, data in k.tick(next_tick, True):
                if ev == "snap":
                    snap_bytes.append((next_tick, len(json.dumps({"type": "game", "g": "kart", "ev": ev, **data},
                                                               separators=(",", ":")))))
            next_tick += tick_every
    assert k.phase == "done"
    order = [r["user"]["userId"] for r in k.results]
    assert order == sorted(true_finish, key=true_finish.get)
    assert all(not r["dnf"] for r in k.results)
    # Out-of-order frames are dropped as stale, never counted as cheating.
    assert sum(p["bad"] for p in k.players.values()) == 0
    per_sec = {}
    for at, n in snap_bytes:
        per_sec[int(at)] = per_sec.get(int(at), 0) + n * 8        # fanned out to 8 sockets
    assert max(per_sec.values()) < realtime.ROOM_BYTES_PER_SEC


def test_eight_car_tick_is_cheap():
    k, tr, t = started(n=8)
    start = time.perf_counter()
    for f in range(20 * 30):                                       # 30 s of 20 Hz frames
        tt = t + f * 0.05
        for i in range(8):
            k.pos(f"u{i}", frame(tr, k.players[f"u{i}"]["u"] + 0.1), tt)
        if f % (20 // kart.HZ or 1) == 0:
            k.tick(tt, True)
    per_second = (time.perf_counter() - start) / 30
    assert per_second < 0.05                                       # < 5% of one core per room


# ---------------------------------------------------------------- realtime --
def test_bucket():
    b = realtime.Bucket(10, 3, 0.0)
    assert [b.take(0.0) for _ in range(4)] == [True, True, True, False]
    assert b.take(0.1) and not b.take(0.1)


async def test_ticker_runs_thins_and_stops(monkeypatch):
    seen = []

    async def step(t, send):
        seen.append(send)
        tk = realtime.get("t:1")
        tk.count(realtime.ROOM_BYTES_PER_SEC)                       # always over budget
        return len(seen) < 12

    tk = realtime.start("t:1", 200, step, time.monotonic)
    assert tk is not None and realtime.start("t:1", 200, step, time.monotonic) is tk
    await asyncio.wait_for(tk.task, 2)
    assert len(seen) == 12 and realtime.get("t:1") is None
    assert tk.stride == realtime.MAX_STRIDE and seen.count(False) >= 4


async def test_ticker_budget_is_process_wide(monkeypatch):
    monkeypatch.setattr(realtime, "MAX_TICKERS", 2)

    async def step(t, send):
        await asyncio.sleep(0)
        return True

    a = realtime.start("t:a", 50, step, time.monotonic)
    b = realtime.start("t:b", 50, step, time.monotonic)
    assert a and b and realtime.start("t:c", 50, step, time.monotonic) is None
    realtime.stop("t:a")
    realtime.stop("t:b")
    await asyncio.sleep(0.01)
    assert realtime.stats()["running"] == 0


# ---------------------------------------------------- over real websockets --
@pytest.fixture
def clock(monkeypatch):
    t = {"now": 1000.0}
    monkeypatch.setattr(valley, "now", lambda: t["now"])
    valley._rooms.clear()
    return t


async def test_race_over_websockets(client, clock):
    a, _ = await make_user("kart-a", 901)
    b, _ = await make_user("kart-b", 902)
    with client.websocket_connect(url("kartroom", a)) as wa, client.websocket_connect(url("kartroom", b)) as wb:
        wa.receive_json(); wb.receive_json()
        send(wa, "join")
        until(wa, "kart")
        send(wb, "join")
        until(wb, "kart")
        send(wb, "start", track="meadow", laps=1)
        assert until(wb, "error")["error"] == "only the host can do that"
        send(wa, "car", car=4)
        assert until(wb, "car")["car"] == 4
        send(wa, "start", track="meadow", laps=1)
        race = until(wb, "kart", where=lambda m: m["race"] and m["race"]["phase"] == "grid")["race"]
        assert race["laps"] == 1 and len(race["players"]) == 2 and race["scale"] == kart.SCALE
        assert {p["car"] for p in race["players"] if p["user"]["userId"] == a} == {4}
        clock["now"] += kart.COUNTDOWN + 0.01
        until(wa, "go")
        until(wb, "go")
        tr = kart.TRACKS["meadow"]
        u = 0.5 - kart.grid_slot(tr, 0)[1] / kart.TILE
        while u < 0.5 + tr["n"] + 0.1:
            u += 0.08
            clock["now"] += 0.05
            send(wa, "pos", **frame(tr, u))
        until(wb, "finish", where=lambda m: m["user"] == a)
        send(wb, "leave")                                        # the other car is out: race over
        done = until(wa, "done")
        assert done["results"][0]["user"]["userId"] == a and done["results"][0]["place"] == 1
        assert not valley.valley_for("kartroom").kart.running()


async def test_teleport_over_websockets_gets_a_fix(client, clock):
    a, _ = await make_user("kart-c", 903)
    with client.websocket_connect(url("kartfix", a)) as wa:
        wa.receive_json()
        send(wa, "join")
        until(wa, "kart")
        send(wa, "start", track="canyon", laps=1)
        until(wa, "kart", where=lambda m: m["race"] and m["race"]["phase"] == "grid")
        clock["now"] += kart.COUNTDOWN + 0.01
        until(wa, "go")
        send(wa, "pos", **frame(kart.TRACKS["canyon"], 12.0))
        fix = until(wa, "fix")
        assert {"x", "z", "r"} <= set(fix)
        send(wa, "end")
        assert until(wa, "kart")["race"]["phase"] == "idle"
