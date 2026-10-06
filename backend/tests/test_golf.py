"""Mini Golf (app/golf.py + the golf branch of app/valley.py): the integer physics, the
courses, and the server-refereed round over real room websockets."""
import json
import math
import os
import time
from collections import deque

import pytest

from app import golf, valley
from app.auth import issue_ws_ticket
from tests.conftest import make_user

GOLDEN = os.path.join(os.path.dirname(__file__), "golf_golden.json")


def url(room, uid):
    return f"/v1/rooms/{room}/ws?ticket={issue_ws_ticket(uid)}"


def until(ws, ev, limit=60, where=None):
    for _ in range(limit):
        m = ws.receive_json()
        if m.get("type") == "game" and m.get("g") == "golf" and m.get("ev") == ev and (where is None or where(m)):
            return m
    raise AssertionError(f"no {ev} event")


def send(ws, op, **data):
    ws.send_json({"type": "game", "g": "golf", "op": op, **data})


@pytest.fixture
def clock(monkeypatch):
    t = {"now": 1000.0}
    monkeypatch.setattr(valley, "now", lambda: t["now"])
    valley._rooms.clear()
    return t


# ------------------------------------------------------------------ physics --
def test_golden_vectors_match():
    vecs = json.load(open(GOLDEN))
    assert len(vecs) >= 150
    for v in vecs:
        h = golf.course_holes(v["course"])[v["hole"]]
        r = golf.simulate(h, v["from"][0], v["from"][1], v["ax"], v["az"], v["power"])
        assert (r["end"], r["holed"], r["oob"], r["ticks"]) == (v["end"], v["holed"], v["oob"], v["ticks"]), v


def test_deterministic_and_integer():
    h = golf.course_holes("windmill")[3]
    a = golf.simulate(h, *h["tee"], 1234, -3000, 77)
    b = golf.simulate(h, *h["tee"], 1234, -3000, 77)
    assert a == b
    assert all(isinstance(x, int) for x in a["end"])


def test_tdiv_truncates_toward_zero_and_isqrt_floors():
    assert golf.tdiv(7, 2) == 3 and golf.tdiv(-7, 2) == -3 and golf.tdiv(7, -2) == -3 and golf.tdiv(-7, -2) == 3
    assert [golf.isqrt(n) for n in (0, 1, 3, 4, 99, 100, 10**12 + 1)] == [0, 1, 1, 2, 9, 10, 10**6]


def test_full_power_rolls_about_seven_tiles():
    hole = {"name": "t", "par": 2, "tiles": [["start", 0, 0, 0]] + [["straight", 0, -i, 0] for i in range(1, 12)]
            + [["hole-round", 0, -12, 2]]}
    h = golf.compile_hole(hole)
    r = golf.simulate(h, *h["tee"], 0, -4096, 100)
    dist = (h["tee"][1] - r["end"][1]) / golf.TILE
    assert 6.5 < dist < 8 and not r["oob"]


def test_every_hole_compiles():
    assert len(golf.COURSES) >= 3
    for cid, c in golf.COURSES.items():
        assert len(c["holes"]) >= 3
        for spec, h in zip(c["holes"], golf.course_holes(cid)):
            names = [t[0] for t in spec["tiles"]]
            assert names.count("start") == 1, spec["name"]
            assert sum(n.startswith("hole-") for n in names) == 1, spec["name"]
            assert golf.on_floor(h, *h["tee"]) and golf.on_floor(h, *h["cup"]), spec["name"]
            for x1, z1, dx, dz, L in h["segs"]:
                assert dx * dx + dz * dz <= 15000 ** 2
            assert 2 <= h["par"] <= 5
            assert len({(t[1], t[2]) for t in spec["tiles"]}) == len(spec["tiles"]), "overlapping tiles"


def test_shot_time_is_small_on_the_largest_hole():
    h = max((h for c in golf.COURSES for h in golf.course_holes(c)), key=lambda h: len(h["segs"]))
    worst = 0.0
    for i in range(24):
        a = 2 * math.pi * i / 24
        t = time.perf_counter()
        golf.simulate(h, *h["tee"], round(math.cos(a) * 4096), round(math.sin(a) * 4096), 100)
        worst = max(worst, time.perf_counter() - t)
    assert worst < 0.030


def _dist_field(h, step=500):
    """Walking distance to the cup on a grid that doesn't pass through walls."""
    def blocked(a, b):
        for k in range(5):
            x, z = a[0] + (b[0] - a[0]) * k // 4, a[1] + (b[1] - a[1]) * k // 4
            for i in h["grid"].get((golf.cell_of(x), golf.cell_of(z)), ()):
                x1, z1, dx, dz, L = h["segs"][i]
                p = max(0, min(L, ((x - x1) * dx + (z - z1) * dz) / L))
                if (x - x1 - dx * p / L) ** 2 + (z - z1 - dz * p / L) ** 2 < (golf.R * 0.8) ** 2:
                    return True
        return False
    cup = tuple(h["cup"])
    dist, q = {cup: 0}, deque([cup])
    while q:
        p = q.popleft()
        for dx, dz in ((step, 0), (-step, 0), (0, step), (0, -step)):
            n = (p[0] + dx, p[1] + dz)
            if n not in dist and golf.on_floor(h, *n) and not blocked(p, n):
                dist[n] = dist[p] + step
                q.append(n)

    def at(x, z):
        gx, gz, best = round(x / step) * step, round(z / step) * step, 1e12
        for ox in (-step, 0, step):
            for oz in (-step, 0, step):
                k = (gx + ox, gz + oz)
                if k in dist:
                    best = min(best, dist[k] + math.hypot(x - k[0], z - k[1]))
        return best
    return at


def test_every_hole_is_playable_within_par_plus_three():
    """A greedy bot (36 angles x 10 powers per stroke) must hole out within par + 3."""
    for cid in golf.COURSES:
        for h in golf.course_holes(cid):
            at, ball, strokes, holed = _dist_field(h), h["tee"], 0, False
            while strokes < h["par"] + 3 and not holed:
                best = None
                for ai in range(36):
                    a = 2 * math.pi * ai / 36
                    ax, az = round(math.cos(a) * 4096), round(math.sin(a) * 4096)
                    for pw in range(1, 101, 11):
                        r = golf.simulate(h, ball[0], ball[1], ax, az, pw)
                        score = -1 if r["holed"] else 1e13 if r["oob"] else at(*r["end"])
                        if best is None or score < best[0]:
                            best = (score, r)
                r = best[1]
                strokes += 1 + (golf.OOB_PENALTY if r["oob"] else 0)
                ball, holed = r["end"], r["holed"]
            assert holed and strokes <= h["par"] + 3, (cid, h["name"], strokes)


def test_gap_is_out_of_bounds_and_returns_to_the_lie():
    h = golf.course_holes("keep")[0]           # Moat: start, straight, gap, straight, cup
    for pw in range(1, 101):
        r = golf.simulate(h, *h["tee"], 0, -4096, pw)
        if r["oob"]:
            assert r["end"] == list(h["tee"])
            return
    pytest.fail("no power drops the ball into the moat")


def test_backwards_off_the_tee_ramp_is_out_of_bounds():
    h = golf.course_holes("meadow")[0]
    r = golf.simulate(h, *h["tee"], 0, 4096, 60)
    assert r["oob"] and r["end"] == list(h["tee"])


# ------------------------------------------------------------------ engine --
def test_engine_max_strokes_pickup_and_card():
    g = golf.Golf()
    members = {"a": {"userId": "a"}, "b": {"userId": "b"}}
    assert g.start(members, "meadow", 0.0) is None
    t = 0.0
    for i in range(4):                      # backwards off the ramp: 2 strokes each
        t += 30
        ev, err = g.shot("a", {"ax": 0, "az": 4096, "power": 60}, t)
        assert err is None and ev["oob"]
    assert ev["strokes"] == golf.MAX_STROKES and ev["done"]
    assert g.shot("a", {"ax": 0, "az": -4096, "power": 50}, t + 30)[1] == "you've finished this hole"
    assert g.advance(t) is None              # b still playing
    assert g.pick_up(["b"]) == ["b"]
    kind, data = g.advance(t, 120)
    assert kind == "hole" and data["hole"] == 1 and data["card"]["a"][0] == golf.MAX_STROKES
    assert g.hole_ready_at == pytest.approx(t + 1 + golf.HOLE_PAUSE)
    assert g.shot("a", {"ax": 0, "az": -4096, "power": 50}, t + 1)[1] == "wait for the ball to stop"


def test_engine_rejects_bad_shots():
    g = golf.Golf()
    assert g.shot("a", {"ax": 1, "az": 0, "power": 5}, 0)[1] == "no round is being played"
    g.start({"a": {"userId": "a"}}, "meadow", 0.0)
    assert g.shot("x", {"ax": 1, "az": 0, "power": 5}, 1)[1] == "you're not in this round"
    for bad in ({"ax": 0, "az": 0, "power": 5}, {"ax": "1", "az": 0, "power": 5}, {"ax": 1, "az": 0},
                {"ax": True, "az": 0, "power": 5}, {"ax": 1, "az": 0, "power": float("nan")}):
        assert g.shot("a", bad, 1)[1] == "bad shot", bad
    ev, err = g.shot("a", {"ax": 99999, "az": -99999, "power": 500}, 1)
    assert err is None and (ev["ax"], ev["az"], ev["power"]) == (4096, -4096, 100)
    assert g.shot("a", {"ax": 1, "az": 0, "power": 5}, 1.01)[1] == "wait for the ball to stop"


# --------------------------------------------------------------- websockets --
async def test_round_over_websockets(client, clock):
    a, _ = await make_user("ash", 31)
    b, _ = await make_user("misty", 32)
    c, _ = await make_user("brock", 33)
    with client.websocket_connect(url("lobby", a)) as wa, client.websocket_connect(url("lobby", b)) as wb, \
            client.websocket_connect(url("lobby", c)) as wc:
        wa.receive_json(); wb.receive_json(); wc.receive_json()
        send(wa, "join")
        assert until(wa, "golf")["round"] is None
        send(wb, "join")
        until(wb, "golf")
        until(wa, "lobby", where=lambda m: len(m["members"]) == 2)
        # host only
        send(wb, "start", course="windmill")
        assert until(wb, "error")["error"] == "only the host can do that"
        send(wa, "start", course="nope")
        assert until(wa, "error")["error"] == "pick a course"
        send(wb, "char", c=4)
        assert until(wa, "char")["c"] == 4
        send(wa, "start", course="windmill")
        rnd = until(wb, "golf", where=lambda m: m["round"] and m["round"]["phase"] == "playing")["round"]
        assert [p["user"]["userId"] for p in rnd["players"]] == [a, b]
        assert rnd["players"][1]["c"] == 4 and rnd["course"] == "windmill" and len(rnd["par"]) == 5
        # a shot is rolled by the server and reaches the lobby
        send(wa, "shot", ax=0, az=-4096, power=40, seq=7)
        shot = until(wb, "shot")
        h = golf.course_holes("windmill")[0]
        ref = golf.simulate(h, *h["tee"], 0, -4096, 40)
        assert shot["end"] == ref["end"] and shot["ticks"] == ref["ticks"] and shot["seq"] == 7
        assert shot["user"]["userId"] == a and shot["strokes"] == 1 and shot["from"] == list(h["tee"])
        until(wa, "shot")
        # busy until the ball stops
        send(wa, "shot", ax=0, az=-4096, power=40)
        assert until(wa, "error")["error"] == "wait for the ball to stop"
        # c is not in the lobby: no golf traffic for them, and they can't play
        send(wc, "shot", ax=0, az=-4096, power=40)
        while True:                                   # only generic lobby rosters reach c
            m = wc.receive_json()
            if m.get("ev") == "error":
                break
            assert m.get("ev") == "lobby", m
        assert m["error"] == "join the lobby first"
        # positions: throttled, clamped, only to the others in the lobby
        send(wb, "pos", x=10**9, z=-5, r=725, a=1)
        p = until(wa, "pos")
        x0, z0, x1, z1 = h["bbox"]
        assert p == {"type": "game", "g": "golf", "ev": "pos", "u": b, "x": x1 + 2 * golf.TILE, "z": -5, "r": 5, "a": 1}
        send(wb, "pos", x=1, z=2, r=0, a=0)          # < 90 ms later: dropped
        send(wb, "view")                              # round-trip so the server has handled it
        seen = []
        while True:                                   # b never sees their own pos echoed
            m = wb.receive_json()
            seen.append(m.get("ev"))
            if m.get("ev") == "golf":
                break
        assert "pos" not in seen and m["round"]["hole"] == 0
        clock["now"] += 0.1
        send(wb, "pos", x=3, z=4, r=0, a=0)
        assert until(wa, "pos")["x"] == 3
        # the host skips every hole to the end
        for i in range(5):
            clock["now"] += 30
            send(wa, "skip")
            if i < 4:
                hole = until(wb, "hole")
                assert hole["hole"] == i + 1 and hole["delayMs"] >= 4000
            else:
                done = until(wb, "done")
        assert done["totals"] == {a: golf.MAX_STROKES * 5, b: golf.MAX_STROKES * 5}
        assert sorted(done["winners"]) == sorted([a, b]) and done["card"][b] == [golf.MAX_STROKES] * 5
        assert done["par"] == [h["par"] for h in golf.course_holes("windmill")]
        assert until(wa, "golf", where=lambda m: m["round"]["phase"] == "done")
        send(wa, "end")
        assert until(wb, "golf", where=lambda m: m["round"]["phase"] == "idle")
        # c never received any golf event
        send(wc, "join")
        first = until(wc, "golf")
        assert first["round"]["phase"] == "idle"


async def test_hole_ready_blocks_early_shots_and_leaving_drops_the_player(client, clock):
    a, _ = await make_user("ash", 41)
    b, _ = await make_user("misty", 42)
    with client.websocket_connect(url("lobby", a)) as wa:
        wa.receive_json()
        with client.websocket_connect(url("lobby", b)) as wb:
            wb.receive_json()
            send(wa, "join"); until(wa, "golf")
            send(wb, "join"); until(wb, "golf")
            until(wa, "lobby", where=lambda m: len(m["members"]) == 2)
            send(wa, "start", course="meadow")
            until(wa, "golf", where=lambda m: m["round"] and m["round"]["phase"] == "playing")
            send(wa, "concede")
            until(wa, "golf", where=lambda m: m["round"]["players"][0]["done"])
            send(wb, "concede")
            hole = until(wa, "hole")
            assert hole["hole"] == 1
            send(wa, "shot", ax=0, az=-4096, power=30)
            assert until(wa, "error")["error"] == "wait for the ball to stop"
            clock["now"] += hole["delayMs"] / 1000 + 0.01
            send(wa, "shot", ax=0, az=-4096, power=30)
            until(wa, "shot")
            send(wb, "concede")
            until(wa, "golf", where=lambda m: m["round"]["players"][1]["done"])
        # b disconnected: removed from the round, a still plays
        gone = until(wa, "golf", where=lambda m: m.get("left") == b)
        assert [p["user"]["userId"] for p in gone["round"]["players"]] == [a]
        send(wa, "leave")
    v = valley._rooms.get("lobby")
    assert v is None or v.golf.phase == "idle"
