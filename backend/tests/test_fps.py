"""Blaster Arena (app/fps.py, the fps branch of app/valley.py): the arena map, the shared
geometry (collision, rays, spread), the shot rules, lag compensation, the match clock,
movement checks, an 8-player match under simulated lag, and a match over real room
websockets."""
import heapq
import json
import math
import random
import time

import pytest

from app import fps, realtime, valley
from app.auth import issue_ws_ticket
from tests.conftest import make_user

M = fps.MAP
SIM_SECS = 60


def url(room, uid):
    return f"/v1/rooms/{room}/ws?ticket={issue_ws_ticket(uid)}"


def until(ws, ev, limit=300, where=None):
    for _ in range(limit):
        m = ws.receive_json()
        if m.get("type") == "game" and m.get("g") == "fps" and m.get("ev") == ev and (where is None or where(m)):
            return m
    raise AssertionError(f"no {ev} event")


def send(ws, op, **data):
    ws.send_json({"type": "game", "g": "fps", "op": op, **data})


def pub(uid):
    return {"userId": uid, "handle": uid, "displayName": uid, "avatarUrl": ""}


def cm(v):
    return round(v * 100)


def frame(x, y, z, q=None, e=None, k=None, r=0):
    m = {"x": cm(x), "y": cm(y), "z": cm(z), "r": r, "p": 0}
    if q is not None:
        m["q"] = q
    if e is not None:
        m["e"] = e
    if k is not None:
        m["k"] = k
    return m


def aim(o, target):
    """yaw, pitch (degrees) from o to target."""
    dx, dy, dz = target[0] - o[0], target[1] - o[1], target[2] - o[2]
    return math.degrees(math.atan2(dx, -dz)), math.degrees(math.atan2(dy, math.hypot(dx, dz)))


def shot(o, target, q, w=0, ip=100, k=None, n_next=1):
    """A fire op from eye o at target, pre-corrected for the deterministic spread of the
    shooter's n-th shot so tests can aim exactly."""
    yaw, pitch = aim(o, target)
    dy, dp = fps.spread_of(n_next, w)
    m = {"w": w, "ox": cm(o[0]), "oy": cm(o[1]), "oz": cm(o[2]), "r": round((yaw - dy) * 100),
         "p": round((pitch - dp) * 100), "q": q, "ip": ip}
    if k is not None:
        m["k"] = k
    return m


# --------------------------------------------------------------------- map --
def test_map_is_sane():
    b = M["bounds"]
    assert len(M["spawns"]) >= 8 and len(M["boxes"]) >= 20
    for sx, sy, sz, yaw in M["spawns"]:
        assert b[0] < sx < b[3] and b[2] < sz < b[5], (sx, sz)
        assert fps.overlaps(M, sx, sy, sz) < 0, "spawn inside a wall"
        assert fps.overlaps(M, sx, sy - 0.05, sz) >= 0, "spawn not on the ground"
        assert fps.top_under(M, sx, sy - 0.05, sz) == sy
        assert 0 <= yaw < 360
    for i, a in enumerate(M["spawns"]):
        for c in M["spawns"][i + 1:]:
            assert math.dist(a[:3], c[:3]) >= 5
    for pk in M["pickups"]:
        x, y, z = pk["at"]
        assert pk["kind"] in ("health", "ammo")
        assert fps.overlaps(M, x, y, z) < 0 and fps.overlaps(M, x, y - 0.05, z) >= 0
    # the outer walls close the arena: a runner can't leave the bounds
    for d in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        o = (0.0, 1.0, 0.0)
        dist = fps.ray_map(M, (o[0] + d[0] * 6, 1.0, o[2] + d[1] * 6), (d[0], 0.0, d[1]), 100.0)
        assert dist < 20
    for tg in M["targets"]:
        for u in (0.0, 1.3, 2.7, 4.1):
            c = fps.target_at(tg, u)
            assert fps.overlaps(M, c[0], c[1] - 0.9, c[2], 0.2) < 0


def test_compile_refuses_empty_boxes():
    bad = dict(fps.DATA, boxes=[[0, 0, 0, 0, 1, 1, "x"]])
    with pytest.raises(ValueError):
        fps.compile_map(bad)


# ---------------------------------------------------------------- geometry --
def test_ray_box():
    b = (-1, -1, -1, 1, 1, 1)
    assert fps.ray_box((-5, 0, 0), (1, 0, 0), b) == pytest.approx(4)
    assert fps.ray_box((5, 0, 0), (1, 0, 0), b) is None                 # behind
    assert fps.ray_box((0, 0, 0), (0, 1, 0), b) == 0                    # inside
    assert fps.ray_box((-5, 2, 0), (1, 0, 0), b) is None                # passes above
    d = (1 / math.sqrt(2), 1 / math.sqrt(2), 0)
    assert fps.ray_box((-3, -3, 0), d, b) == pytest.approx(2 * math.sqrt(2))
    assert fps.ray_box((-5, 0, 0), (0, 0, 1), b) is None                # parallel, outside the slab


def test_ray_player_head_and_body():
    o = (0.0, fps.EYE, 10.0)
    # aimed at the chest of a player at the origin
    t, head = fps.ray_player(o, fps.dir_of(0, math.degrees(math.atan2(1.0 - fps.EYE, 10))), 0, 0, 0, 100)
    assert not head and t == pytest.approx(10 - fps.BODY_R, abs=0.05)
    t, head = fps.ray_player(o, fps.dir_of(0, math.degrees(math.atan2(1.65 - fps.EYE, 10))), 0, 0, 0, 100)
    assert head
    assert fps.ray_player(o, fps.dir_of(10, 0), 0, 0, 0, 100) is None        # wide
    assert fps.ray_player(o, fps.dir_of(0, -5), 0, 0, 0, 5) is None          # beyond reach


def test_dir_and_spread():
    for yaw, want in ((0, (0, 0, -1)), (90, (1, 0, 0)), (180, (0, 0, 1)), (270, (-1, 0, 0))):
        assert fps.dir_of(yaw, 0) == pytest.approx(want, abs=1e-12)
    assert fps.dir_of(0, 90) == pytest.approx((0, 1, 0), abs=1e-12)
    seen = set()
    for w, wp in enumerate(fps.WEAPONS):
        for n in range(1, 300):
            a, b = fps.spread_of(n, w)
            assert abs(a) <= wp["spread"] and abs(b) <= wp["spread"]
            assert fps.spread_of(n, w) == (a, b)
            seen.add(round(a, 6))
    assert len(seen) > 500          # it really varies shot to shot
    assert fps.mb32(0) == pytest.approx(0.26642920868471265)


def test_runner_collides_steps_jumps_and_lands():
    s = {"x": 0.0, "y": 0.0, "z": 8.0, "vx": 0.0, "vy": 0.0, "vz": 0.0, "g": True}
    for _ in range(240):                                 # run north at the keep's south face
        fps.move(M, s, 0, -1, False, 1 / 120)
    assert s["z"] > 3.5 + fps.R - 0.01 and s["y"] == 0.0 and s["g"]
    assert fps.overlaps(M, s["x"], s["y"], s["z"]) < 0
    # the east steps: 0.5 m each, walked up onto the 1.5 m keep
    s = {"x": 8.0, "y": 0.0, "z": 0.0, "vx": 0.0, "vy": 0.0, "vz": 0.0, "g": True}
    for _ in range(400):
        fps.move(M, s, -1, 0, False, 1 / 120)
        if s["x"] < 2.0:
            break
    assert s["y"] == 1.5 and s["x"] < 2.0
    # a jump goes up ~1.17 m and lands back on the keep
    s["vx"] = 0.0
    top = 0.0
    fps.move(M, s, 0, 0, True, 1 / 120)
    for _ in range(240):
        fps.move(M, s, 0, 0, False, 1 / 120)
        top = max(top, s["y"])
    assert 2.5 < top < 2.8 and s["y"] == 1.5 and s["g"]
    # a 2.5 m tower wall can't be stepped onto
    s = {"x": 12.0, "y": 0.0, "z": -14.6, "vx": 0.0, "vy": 0.0, "vz": 0.0, "g": True}
    for _ in range(240):
        fps.move(M, s, 1, 0, False, 1 / 120)
    assert s["y"] == 0.0 and s["x"] < 14.0 - fps.R + 0.01
    s = {"x": 9.0, "y": 0.0, "z": -16.0, "vx": 0.0, "vy": 0.0, "vz": 0.0, "g": True}
    for _ in range(600):                                # ... but the stairs climb it
        fps.move(M, s, 1, 0, False, 1 / 120)
        if s["x"] > 15:
            break
    assert s["y"] == 2.5


# ------------------------------------------------------------------ referee --
def started(n=2, t0=100.0):
    f = fps.Fps()
    members = {f"u{i}": pub(f"u{i}") for i in range(n)}
    assert f.start(members, 5, 20, t0) is None
    f.tick(t0 + fps.COUNTDOWN, True)
    assert f.phase == "round"
    return f, t0 + fps.COUNTDOWN


def put(f, uid, x, y, z, t, q=None):
    """Teleport a player (test setup) with a clean history at t."""
    p = f.players[uid]
    p["x"], p["y"], p["z"] = x, y, z
    p["hist"].clear()
    p["hist"].append((t, x, y, z))
    p["protect"] = 0.0
    p["spawn_t"] = t - 5
    if q is not None:
        p["q"], p["q0"], p["t0"], p["qmax"], p["off"] = q, q, t, q, t - q / 100.0


def eye(f, uid):
    p = f.players[uid]
    return (p["x"], p["y"] + fps.EYE, p["z"])


def chest(f, uid):
    p = f.players[uid]
    return (p["x"], p["y"] + 1.0, p["z"])


def test_start_rules():
    f = fps.Fps()
    assert f.view(0)["phase"] == "idle" and f.view(0)["players"] == []
    assert f.start({"a": pub("a")}, 99, 7, 0.0) is None
    assert (f.minutes, f.limit, f.phase) == (5, 20, "warmup")
    assert f.start({"a": pub("a")}, 3, 10, 0.0) is not None          # one at a time
    f.end()
    assert f.start({f"u{i}": pub(f"u{i}") for i in range(12)}, 3, 10, 0.0) is None
    assert len(f.players) == fps.MAX_PLAYERS and (f.minutes, f.limit) == (3, 10)
    spots = {(p["x"], p["z"]) for p in f.players.values()}
    assert len(spots) == fps.MAX_PLAYERS                               # everyone on their own spawn
    assert f.pos("u0", frame(0, 0, -19), 1.0) == (False, None)        # frozen in the countdown
    assert f.tick(fps.COUNTDOWN, True)[0][0] == "go"


def test_a_hit_damage_kill_respawn_and_score():
    f, t = started(2)
    put(f, "u0", 5, 0, 16, t)
    put(f, "u1", 5, 0, 9, t)
    hp = 100
    n = 0
    while hp > 0:
        n += 1
        t += 0.11
        s, sync = f.fire("u0", shot(eye(f, "u0"), chest(f, "u1"), int(t * 100), n_next=n), t)
        assert s is not None and s[5] == f.players["u1"]["slot"] and sync is None
        hp -= fps.WEAPONS[0]["damage"]
        assert f.players["u1"]["hp"] == max(0, hp)
    assert n == 9                                          # 9 body hits of 12
    v = f.players["u1"]
    assert v["dead"] and v["deaths"] == 1 and f.players["u0"]["kills"] == 1
    evs = dict(f.tick(t + 0.01, True))
    assert evs["kill"]["k"] == "u0" and evs["kill"]["v"] == "u1" and evs["kill"]["hs"] == 0
    assert len(evs["snap"]["s"]) == 9 and evs["snap"]["s"][-1][5] == v["slot"]
    # dead players don't move or shoot, and can't be shot
    assert f.pos("u1", frame(0, 0, 6.2), t + 0.1) == (False, None)
    assert f.fire("u1", shot(eye(f, "u1"), chest(f, "u0"), int(t * 100) + 50), t + 0.5)[0] is None
    s, _ = f.fire("u0", shot(eye(f, "u0"), chest(f, "u1"), int(t * 100) + 60, n_next=n + 1), t + 0.6)
    assert s[5] == -1
    # respawn after RESPAWN, at the spawn farthest from u0, protected for a moment
    evs = f.tick(t + fps.RESPAWN + 0.01, True)
    sp = [e for e in evs if e[0] == "spawn"][0][1]
    assert sp["user"] == "u1" and sp["e"] == 2 and not v["dead"] and v["hp"] == 100
    far = max(M["spawns"], key=lambda s_: math.dist(s_[:3], (5, 0, 16)))
    assert (cm(far[0]), cm(far[2])) == (sp["x"], sp["z"])
    t2 = t + fps.RESPAWN + 0.05
    put(f, "u1", 5, 0, 9, t2)
    v["protect"] = t2 + fps.PROTECT
    s, _ = f.fire("u0", shot(eye(f, "u0"), chest(f, "u1"), int(t2 * 100) + 10, n_next=n + 2), t2 + 0.1)
    assert s[5] == v["slot"] and v["hp"] == 100            # registered, no damage while protected
    # firing ends your own protection
    f.fire("u1", shot(eye(f, "u1"), chest(f, "u0"), int(t2 * 100) + 20, n_next=1), t2 + 0.2)
    assert v["protect"] <= t2 + 0.2


def test_headshots_and_the_heavy_blaster():
    f, t = started(2)
    put(f, "u0", 5, 0, 14, t)
    put(f, "u1", 5, 0, 7, t)
    assert f.weapon("u0", {"w": 1, "q": int(t * 100)}, t)
    head = (5, 1.65, 7)
    s, sync = f.fire("u0", shot(eye(f, "u0"), head, int(t * 100) + 10, w=1), t + 0.1)
    assert s is None and sync["w"] == 1                    # still switching
    s, _ = f.fire("u0", shot(eye(f, "u0"), head, int(t * 100) + 30, w=1), t + 0.3)
    assert s[6] == 1 and f.players["u1"]["hp"] == 100 - fps.WEAPONS[1]["head"]
    s, _ = f.fire("u0", shot(eye(f, "u0"), head, int(t * 100) + 60, w=1, n_next=2), t + 0.6)
    assert s is None                                        # 0.8 s between heavy shots
    s, _ = f.fire("u0", shot(eye(f, "u0"), (5, 1.0, 7), int(t * 100) + 110, w=1, n_next=2), t + 1.1)
    assert s[6] == 0 and f.players["u1"]["dead"]


def test_fire_rate_ammo_and_reload():
    f, t = started(2)
    put(f, "u0", -10, 0, 18, t)
    put(f, "u1", 10, 0, -18, t)
    q = int(t * 100)
    tgt = (-10, 1.0, 10)
    ok = 0
    for i in range(40):                                     # 40 shots 5 cs apart: half are too fast
        q += 5
        t += 0.05
        f.players["u0"]["fb"] = [99.0, t]
        if f.fire("u0", shot(eye(f, "u0"), tgt, q), t)[0] is not None:
            ok += 1
    assert ok == 20 and f.players["u0"]["mag"][0] == 10
    for _ in range(10):
        q += 10
        t += 0.1
        assert f.fire("u0", shot(eye(f, "u0"), tgt, q), t)[0] is not None
    q += 10
    t += 0.1
    s, sync = f.fire("u0", shot(eye(f, "u0"), tgt, q), t)
    assert s is None and sync == {"w": 0, "mag": [0, 6], "res": [90, 18], "reloading": False}
    assert f.reload("u0", {"q": q}, t)
    assert not f.reload("u0", {"q": q + 1}, t)              # already reloading
    s, sync = f.fire("u0", shot(eye(f, "u0"), tgt, q + 100), t + 1.0)
    assert s is None                                        # 1.6 s to reload
    s, _ = f.fire("u0", shot(eye(f, "u0"), tgt, q + 170), t + 1.7)
    assert s is not None and f.players["u0"]["mag"][0] == 29 and f.players["u0"]["res"][0] == 60
    # the fire-op flood bucket
    f.players["u0"]["fb"] = [float(fps.FIRE_BURST), t + 2.0]
    took = sum(f.fire("u0", shot(eye(f, "u0"), tgt, q + 200 + 10 * i), t + 2.0)[0] is not None for i in range(30))
    assert took <= fps.FIRE_BURST
    # a shot from somewhere you aren't is refused
    p = f.players["u0"]
    bad = p["bad"]
    assert f.fire("u0", shot((5, 1.6, 5), tgt, q + 700), t + 7.0)[0] is None and p["bad"] == bad + 1


def test_no_hits_through_walls():
    f, t = started(2)
    # the keep (a 1.5 m block) between them, both on the ground: the chest is hidden ...
    put(f, "u0", 0, 0, 8, t)
    put(f, "u1", 0, 0, -8, t)
    s, _ = f.fire("u0", shot(eye(f, "u0"), chest(f, "u1"), int(t * 100)), t)
    assert s[5] == -1 and s[4] > -400                       # stopped at the keep's face
    # ... and an L-wall in the north-west corner
    put(f, "u0", -12, 0, -12, t)
    put(f, "u1", -17, 0, -17, t)
    s, _ = f.fire("u0", shot(eye(f, "u0"), chest(f, "u1"), int(t * 100) + 20, n_next=2), t + 0.2)
    assert s[5] == -1
    # in the open it hits
    put(f, "u1", -12, 0, -4, t)
    s, _ = f.fire("u0", shot(eye(f, "u0"), chest(f, "u1"), int(t * 100) + 40, n_next=3), t + 0.4)
    assert s[5] == f.players["u1"]["slot"]


def run_target(f, uid, t0, t1, x0, x1, z, q0=None):
    """Feed a player running from x0 to x1 along z as 20 Hz frames (its clock = ours)."""
    steps = int(round((t1 - t0) * 20))
    for i in range(1, steps + 1):
        t = t0 + i / 20
        x = x0 + (x1 - x0) * i / steps
        ok, fix = f.pos(uid, frame(x, 0, z, q=int(round(t * 100))), t)
        assert ok, (uid, x)
    return t1


def test_lag_compensation_hits_what_the_shooter_saw():
    """The target ran east; the shooter, 100 ms of interpolation behind, fired at where it
    drew them. The server rewinds and it's a hit, though the target has moved on ~0.6 m."""
    f, t = started(2)
    put(f, "u0", -6, 0, 16, t, q=int(round(t * 100)))
    put(f, "u1", -9, 0, 6, t, q=int(round(t * 100)))
    t = run_target(f, "u1", t, t + 1.0, -9, -3, 6)            # 6 m/s east
    seen = f.where(f.players["u1"], t - 0.1)
    assert abs(seen[0] - f.players["u1"]["x"]) > 0.5
    s, _ = f.fire("u0", shot(eye(f, "u0"), (seen[0], 1.0, seen[2]), int(round(t * 100)), ip=100), t)
    assert s[5] == f.players["u1"]["slot"]
    # without compensation (ip 0) the same aim misses
    f2, t2 = started(2)
    put(f2, "u0", -6, 0, 16, t2, q=int(round(t2 * 100)))
    put(f2, "u1", -9, 0, 6, t2, q=int(round(t2 * 100)))
    t2 = run_target(f2, "u1", t2, t2 + 1.0, -9, -3, 6)
    s, _ = f2.fire("u0", shot(eye(f2, "u0"), (seen[0], 1.0, seen[2]), int(round(t2 * 100)), ip=0), t2)
    assert s[5] == -1


def test_measured_round_trip_is_compensated():
    """With 150 ms each way, the shooter's view is the round trip plus its interpolation
    behind the server; the round trip is measured from snapshot acks, not claimed."""
    f, t = started(2)
    lat = 0.15
    put(f, "u0", -6, 0, 16, t, q=int(round(t * 100)))
    put(f, "u1", -9, 0, 6, t, q=int(round(t * 100)))
    f.players["u0"].update(q=None, off=None, qmax=None)     # its clock is learnt from its frames
    sent_snaps = []                                         # (tick, when the server sent it)
    x = -9.0
    for i in range(1, 21):
        t += 0.05
        x += 0.3
        f.pos("u1", frame(x, 0, 6, q=int(round(t * 100))), t)
        sent_snaps += [(e[1]["k"], t) for e in f.tick(t, True) if e[0] == "snap"]
        # the shooter's frames arrive lat after it sent them (clock = ours), acking the
        # snapshot it had received by then (sent lat before it sent the frame)
        sent = t - lat
        k = max((kk for kk, at in sent_snaps if at <= sent - lat + 1e-9), default=None)
        f.pos("u0", frame(-6, 0, 16, q=int(round(sent * 100)), k=k), t)
    assert f.players["u0"]["rtt"] == pytest.approx(2 * lat, abs=0.06)
    # it fired at sent time, drawing u1 100 ms behind what it had received
    fire_at = t - lat
    seen = f.where(f.players["u1"], fire_at - lat - 0.1)
    s, _ = f.fire("u0", shot(eye(f, "u0"), (seen[0], 1.0, seen[2]), int(round(fire_at * 100)), ip=100), t)
    assert s[5] == f.players["u1"]["slot"]


def test_an_impossible_rewind_is_clamped_and_misses():
    f, t = started(2)
    put(f, "u0", -6, 0, 16, t, q=int(round(t * 100)))
    put(f, "u1", -9, 0, 6, t, q=int(round(t * 100)))
    t = run_target(f, "u1", t, t + 1.0, -9, -3, 6)
    old = f.where(f.players["u1"], t - 0.8)                   # where u1 was 0.8 s ago
    s, _ = f.fire("u0", shot(eye(f, "u0"), (old[0], 1.0, old[2]), int(round(t * 100)), ip=800), t)
    assert s[5] == -1                                         # claimed 800 ms, got IP_CAP
    # nor does an old clock buy rewind: a shot dated 0.8 s back is refused
    s, _ = f.fire("u0", shot(eye(f, "u0"), (old[0], 1.0, old[2]), int(round((t - 0.8) * 100)), n_next=2), t + 0.1)
    assert s is None


def test_teleports_walls_and_flying_are_fixed():
    f, t = started(1)
    p = f.players["u0"]
    put(f, "u0", -6, 0, 16, t, q=int(round(t * 100)))
    q = int(round(t * 100))
    ok, fix = f.pos("u0", frame(-6, 0, 10, q=q + 5), t + 0.05)          # 6 m in 50 ms
    assert not ok and fix == {"x": -600, "y": 0, "z": 1600, "e": p["life"]}
    ok, fix = f.pos("u0", frame(-6, 0, 15.5, q=q + 70), t + 0.7)
    assert ok
    ok, fix = f.pos("u0", frame(0, 0.5, 3.2, q=q + 300), t + 3.0)       # inside the keep
    assert not ok and fix is not None
    ok, _ = f.pos("u0", frame(0, 0, 30, q=q + 900), t + 9.0)            # out of the arena
    assert not ok
    # hovering: off the ground for longer than any jump
    y = 0.5
    took = 0
    for i in range(1, 60):
        y = min(3.0, y + 0.1)
        took += f.pos("u0", frame(-6, y, 15.5, q=q + 1000 + i * 5), t + 10 + i * 0.05)[0]
    assert took < 50 and p["bad"] >= 4


def test_a_fast_clock_buys_no_speed():
    f, t = started(1)
    put(f, "u0", -18, 0, 19, t, q=10000)
    p = f.players["u0"]
    x, q = -18.0, 10000
    for _ in range(40):                       # honest for 2 s at 5 m/s
        x += 0.25; t += 0.05; q += 5
        assert f.pos("u0", frame(x, 0, 19, q=q), t)[0]
    caught = False
    for _ in range(40):                       # then 3x the speed, with a clock to match
        x += 0.75; t += 0.05; q += 15
        ok, fix = f.pos("u0", frame(min(x, 20.0), 0, 19, q=q), t)
        if not ok:
            caught = fix is not None
            break
    assert caught and p["bad"] == 1


def test_stale_frames_and_earlier_lives_are_dropped_quietly():
    f, t = started(1)
    put(f, "u0", -18, 0, 12, t, q=10000)
    p = f.players["u0"]
    assert f.pos("u0", frame(-17.8, 0, 12, q=10010), t + 0.1)[0]
    assert f.pos("u0", frame(-17.9, 0, 12, q=10005), t + 0.12) == (False, None)    # older
    assert f.pos("u0", frame(-17.7, 0, 12, q=10020, e=p["life"] - 1), t + 0.2) == (False, None)
    assert f.pos("u0", frame(-17.7, 0, 12, q=10020, e=p["life"]), t + 0.2)[0]
    assert p["bad"] == 0


def test_frames_are_rate_limited():
    f, t = started(1)
    put(f, "u0", -18, 0, 12, t)
    took = sum(f.pos("u0", frame(-18, 0, 12), t)[0] for _ in range(50))
    assert took <= fps.POS_BURST


def test_pickups():
    f, t = started(2)
    p = f.players["u0"]
    p["hp"] = 30
    h = M["pickups"][1]["at"]
    put(f, "u0", h[0] + 3, h[1], h[2], t)
    assert f.pos("u0", frame(h[0] + 0.5, h[1], h[2]), t + 0.6)[0]
    assert p["hp"] == 80 and f.items[1] is not None
    evs = dict(f.tick(t + 0.7, True))
    assert evs["pick"]["i"] == 1 and evs["pick"]["user"] == "u0"
    back = [e for e in f.tick(t + 0.7 + fps.PICKUP_BACK, True) if e[0] == "item"]
    assert back == [("item", {"i": 1, "on": 1})]
    # ammo
    a = M["pickups"][3]["at"]
    p["res"] = [0, 0]
    put(f, "u0", a[0], a[1], a[2] + 2, t + 20)
    assert f.pos("u0", frame(a[0], a[1], a[2] + 0.5), t + 20.5)[0]
    assert p["res"] == [fps.WEAPONS[0]["pack"], fps.WEAPONS[1]["pack"]]


def test_the_round_ends_on_the_kill_limit_with_results():
    f = fps.Fps()
    f.start({"a": pub("a"), "b": pub("b"), "c": pub("c")}, 3, 10, 0.0)
    t = fps.COUNTDOWN
    f.tick(t, True)
    f.players["a"]["kills"], f.players["b"]["kills"], f.players["c"]["kills"] = 9, 3, 3
    f.players["b"]["deaths"], f.players["c"]["deaths"] = 4, 4
    f.tick(t + 1, True)
    assert f.phase == "round"
    f.players["a"]["kills"] = 10
    evs = f.tick(t + 2, True)
    assert evs[-1][0] == "done"
    res = f.results
    assert [r["user"]["userId"] for r in res] == ["a", "b", "c"] and [r["place"] for r in res] == [1, 2, 2]
    assert not f.running()


def test_the_round_ends_on_time():
    f, t = started(2)
    names = [e[0] for e in f.tick(t + 5 * 60 - 0.1, True)]
    assert "done" not in names
    assert f.tick(t + 5 * 60 + 0.01, True)[-1][0] == "done"


def test_drops_rejoins_and_drop_ins():
    f, t = started(3)
    f.players["u1"]["kills"] = 4
    assert f.drop("u1", t, blip=True)
    assert f.enter("u1", pub("u1"), t + 3)                         # back within the grace: same score
    assert f.players["u1"]["kills"] == 4 and f.players["u1"]["away"] is None
    f.drop("u1", t + 4, blip=True)
    evs = f.tick(t + 4 + fps.GRACE + 0.1, True)
    assert ("gone", {"user": "u1"}) in evs
    assert f.enter("u1", pub("u1"), t + 30)                         # even later the score comes back
    assert f.players["u1"]["kills"] == 4 and f.players["u1"]["dead"]
    assert any(e[0] == "spawn" for e in f.tick(t + 30.1, True))
    # someone new drops in mid-round and spawns next tick
    assert f.enter("u9", pub("u9"), t + 31)
    assert f.players["u9"]["slot"] == 3 and f.players["u9"]["dead"]
    assert [e[1]["user"] for e in f.tick(t + 31.1, True) if e[0] == "spawn"] == ["u9"]
    # an explicit leave benches at once; the last one standing ends the round
    f.drop("u0", t + 32)
    f.drop("u1", t + 32)
    f.tick(t + 32.05, True)
    assert f.phase == "round"
    f.drop("u9", t + 32)
    assert f.tick(t + 32.1, True)[-1][0] == "done"
    assert {r["user"]["userId"]: r["left"] for r in f.results} == {"u0": True, "u1": True, "u2": False, "u9": True}


def test_snapshots_carry_only_what_changed():
    f, t = started(3)
    put(f, "u2", -18, 0, 12, t)
    f.tick(t, True)
    assert "snap" not in dict(f.tick(t + 0.05, True))
    f.pos("u2", frame(-17.8, 0, 12), t + 0.1)
    assert "snap" not in dict(f.tick(t + 0.1, False))              # thinned: held ...
    snap = dict(f.tick(t + 0.15, True))["snap"]                    # ... to the next
    assert [e[0] for e in snap["p"]] == [f.players["u2"]["slot"]] and snap["s"] == []


def test_characters():
    f = fps.Fps()
    assert f.char("a", {"c": 3}) == 3 and f.char("a", {"c": 6}) is None and f.char("a", {"c": True}) is None
    f.start({"a": pub("a")}, 5, 20, 0)
    assert f.players["a"]["char"] == 3


# --------------------------------------------- 8 players under simulated lag --
class View:
    """A bot's picture of one other player: snapshot interpolation as games/fps.js does
    it. Entries are stamped with the server's clock; the bot maps that onto its own with
    the smallest arrival offset of the snapshots (off)."""
    INTERP, JIT_MAX = 0.1, 0.25

    def __init__(self):
        self.snaps, self.last, self.jit, self.seen = [], -1, 0.0, 0.0
        self.dead, self.life_at = False, -1e9

    def push(self, e, now, off):
        if e[8] & 1:
            self.dead = True
        elif self.dead:
            self.dead, self.life_at = False, now
            self.snaps = []
        key = e[9]
        if key < 0 or key <= self.last:
            return
        self.last = key
        late = min(self.JIT_MAX, max(0.0, now - (key / 1000 + off)))
        self.jit += (late - self.jit) * (0.3 if late > self.jit else 0.02)
        self.snaps.append((key / 1000, e[1] / 100, e[2] / 100, e[3] / 100))
        self.snaps = self.snaps[-12:]

    def at(self, now, off, back=0.0):
        """Where this player is drawn at local time now (server time now - off), and
        remember which server moment that is (seen)."""
        sn = self.snaps
        if not sn:
            return None
        rt = now - off - self.INTERP - self.jit - back
        self.seen = rt
        if rt <= sn[0][0]:
            return sn[0][1:] if back == 0 else None
        if rt >= sn[-1][0]:
            self.seen = sn[-1][0]
            return sn[-1][1:]
        for i in range(len(sn) - 1, 0, -1):
            if sn[i - 1][0] <= rt:
                a, b = sn[i - 1], sn[i]
                u = (rt - a[0]) / ((b[0] - a[0]) or 1)
                return tuple(a[j] + (b[j] - a[j]) * u for j in (1, 2, 3))
        return None


def open_points():
    pts = []
    for x in range(-20, 21, 2):
        for z in range(-20, 21, 2):
            if fps.overlaps(M, x, 0.31, z, -0.3) < 0 and fps.overlaps(M, x, -0.05, z) >= 0:
                pts.append((float(x), float(z)))
    return pts


def lagged_match(seed):
    rng = random.Random(seed)
    f = fps.Fps()
    uids = [f"bot{i}" for i in range(8)]
    t0 = 1000.0
    assert f.start({u: pub(u) for u in uids}, 3, 30, t0) is None
    pts = open_points()
    slot_of = {u: f.players[u]["slot"] for u in uids}
    uid_of = {s: u for u, s in slot_of.items()}

    def lag():
        return min(0.24, max(0.0, rng.gauss(0.12, 0.06)))

    bots = {}
    for u in uids:
        p = f.players[u]
        bots[u] = {"s": {"x": p["x"], "y": p["y"], "z": p["z"], "vx": 0.0, "vy": 0.0, "vz": 0.0, "g": True},
                   "clk": rng.uniform(-500, 500), "goal": rng.choice(pts), "views": {}, "k": None, "kq": None,
                   "off": None,
                   "life": p["life"], "dead": True, "n": 0, "mag": 30, "res": 90, "reload_until": 0.0,
                   "next_shot": 0.0, "sent_at": 0.0, "stuck": 0.0, "last": (p["x"], p["z"])}
    up, down = [], []            # (arrival, seq, ...)
    seq = 0
    snap_bytes = {}
    counts = {"expected": 0, "registered": 0, "stale": 0, "stale_hits": 0, "dropped": 0, "target_died": 0,
              "blocked_by_other": 0}
    pending = {}                 # (uid, n) -> expected target slot or "stale"
    kills_seen = 0
    t = t0
    dt = 1 / 60
    next_tick = t0
    while f.phase != "done" and t < t0 + fps.COUNTDOWN + SIM_SECS:
        t = round(t + dt, 9)
        # --- server: arrivals, then its tick ---
        while up and up[0][0] <= t:
            at, _s, u, op, msg = heapq.heappop(up)
            if op == "pos":
                f.pos(u, msg, at)
            elif op == "reload":
                f.reload(u, msg, at)
            else:
                was_dead = f.players[u]["dead"] or msg["e"] != f.players[u]["life"]
                want0 = pending.get((u, msg["_n"]))
                if isinstance(want0, int) and f.players[uid_of[want0]]["dead"]:
                    pending.pop((u, msg["_n"]))           # killed by someone else meanwhile: can't count
                    counts["expected"] -= 1
                    counts["target_died"] += 1
                s_, _sync = f.fire(u, msg, at)
                want = pending.pop((u, msg["_n"]), None)
                if s_ is None:
                    assert was_dead, (u, msg)                 # only a shot from an earlier life is dropped
                    counts["dropped"] += 1
                    if want == "stale":
                        counts["stale"] -= 1
                    elif want is not None:
                        counts["expected"] -= 1
                elif want == "stale":
                    counts["stale_hits"] += s_[5] >= 0
                elif want is not None:
                    counts["registered"] += s_[5] == want
                    counts["blocked_by_other"] += s_[5] >= 0 and s_[5] != want
        while next_tick <= t:
            for ev, data in f.tick(next_tick, True):
                payload = json.dumps({"type": "game", "g": "fps", "ev": ev, **data}, separators=(",", ":"))
                snap_bytes[int(next_tick)] = snap_bytes.get(int(next_tick), 0) + len(payload) * 8
                if ev == "kill":
                    kills_seen += 1
                for u in uids:
                    seq += 1
                    heapq.heappush(down, (next_tick + lag(), seq, u, ev, data))
            next_tick += 1 / fps.HZ
        # --- clients: what reached them ---
        while down and down[0][0] <= t:
            at, _s, u, ev, data = heapq.heappop(down)
            b = bots[u]
            local = at + b["clk"]
            if ev == "go":
                b["dead"] = False
            elif ev == "snap":
                if b["k"] is None or data["k"] > b["k"]:
                    b["k"], b["kq"] = data["k"], int(local * 100)
                o_ = local - data["ts"] / 1000
                b["off"] = o_ if b["off"] is None or o_ < b["off"] else b["off"]
                for e in data["p"]:
                    if e[0] != slot_of[u]:
                        b["views"].setdefault(e[0], View()).push(e, local, b["off"])
            elif ev == "kill" and data["v"] == u:
                b["dead"] = True
            elif ev == "spawn" and data["user"] == u:
                b["dead"], b["life"], b["n"] = False, data["e"], 0
                b["s"].update(x=data["x"] / 100, y=data["y"] / 100, z=data["z"] / 100, vx=0.0, vy=0.0, vz=0.0, g=True)
            elif ev == "fix" and data.get("user") == u:
                raise AssertionError("an honest bot got a fix")
        if f.phase != "round":
            continue
        for u in uids:
            b = bots[u]
            if b["dead"]:
                continue
            s = b["s"]
            gx, gz = b["goal"]
            dx, dz = gx - s["x"], gz - s["z"]
            d = math.hypot(dx, dz)
            if d < 1.0:
                b["goal"] = rng.choice(pts)
            wx, wz = (dx / d, dz / d) if d > 1e-6 else (0.0, 0.0)
            fps.move(M, s, wx, wz, rng.random() < 0.004, dt)
            local = t + b["clk"]
            q = int(local * 100)
            if t - b["sent_at"] >= 0.05:
                b["sent_at"] = t
                if math.hypot(s["x"] - b["last"][0], s["z"] - b["last"][1]) < 0.05:
                    b["goal"] = rng.choice(pts)
                b["last"] = (s["x"], s["z"])
                msg = frame(s["x"], s["y"], s["z"], q=q, e=b["life"], k=b["k"])
                msg["kq"] = b["kq"]
                seq += 1
                heapq.heappush(up, (t + lag(), seq, u, "pos", msg))
            # shoot at the nearest drawn player in sight, ~4 times a second
            if t < b["next_shot"]:
                continue
            if b["mag"] == 0:
                if b["reload_until"] == 0.0 and b["res"] > 0:
                    b["reload_until"] = t + fps.WEAPONS[0]["reload"] + 0.02
                    seq += 1
                    heapq.heappush(up, (t + lag(), seq, u, "reload", {"q": q, "e": b["life"]}))
                elif b["reload_until"] and t >= b["reload_until"]:
                    take = min(30, b["res"])
                    b["mag"], b["res"], b["reload_until"] = take, b["res"] - take, 0.0
                continue
            o = (s["x"], s["y"] + fps.EYE, s["z"])
            best = None
            for slot, vw in b["views"].items():
                if vw.dead or local - vw.life_at < 0.8:
                    continue
                pos = vw.at(local, b["off"])
                if pos is None:
                    continue
                c = (pos[0], pos[1] + 1.0, pos[2])
                dist = math.dist(o, c)
                if dist > 22:
                    continue
                dd = tuple((c[i] - o[i]) / dist for i in range(3))
                if fps.ray_map(M, o, dd, dist) < dist:
                    continue
                if best is None or dist < best[0]:
                    best = (dist, slot, pos, vw)
            if best is None:
                continue
            _dist, slot, pos, vw = best
            stale = rng.random() < 0.12
            if stale:
                old = vw.at(local, b["off"], back=0.8)
                if old is None or math.hypot(old[0] - pos[0], old[2] - pos[2]) < 1.6:
                    continue
                aim_at, ip = (old[0], old[1] + 1.0, old[2]), 1100
            else:
                aim_at, ip = (pos[0], pos[1] + 1.0, pos[2]), round((local - b["off"] - vw.seen) * 1000)
            b["n"] += 1
            b["mag"] -= 1
            b["next_shot"] = t + 0.25
            yaw, pitch = aim(o, aim_at)
            dy, dp = fps.spread_of(b["n"], 0)
            msg = {"w": 0, "ox": cm(o[0]), "oy": cm(o[1]), "oz": cm(o[2]), "r": round(yaw * 100),
                   "p": round(pitch * 100), "q": q, "ip": ip, "k": b["k"], "kq": b["kq"], "e": b["life"], "_n": b["n"]}
            # what the shooter's own screen says the shot does (spread included)
            d3 = fps.dir_of(yaw + dy, max(-89.0, min(89.0, pitch + dp)))
            reach = fps.ray_map(M, o, d3, fps.WEAPONS[0]["range"])
            if stale:
                pending[(u, b["n"])] = "stale"
                counts["stale"] += 1
            elif fps.ray_player(o, d3, pos[0], pos[1], pos[2], reach) is not None:
                pending[(u, b["n"])] = slot
                counts["expected"] += 1
            seq += 1
            heapq.heappush(up, (t + lag(), seq, u, "fire", msg))
    return f, counts, kills_seen, snap_bytes


@pytest.mark.parametrize("seed", [7, 8])
def test_eight_players_with_lag_hits_register_and_nothing_honest_is_refused(seed):
    """Eight bots run around the arena and shoot at what they see: other players drawn
    100 ms (+ measured jitter) in the past from snapshots that crossed a 120 ms +- 60 ms
    link each way (so frames and snapshots arrive bunched and out of order). Every
    honest frame is accepted, shots aimed at the drawn target register, shots aimed at
    where someone was half a second earlier (claiming a big delay) don't, the score adds
    up, and the room stays inside its bandwidth budget."""
    f, c, kills_seen, snap_bytes = lagged_match(seed)
    assert sum(p["bad"] for p in f.players.values()) == 0
    assert c["expected"] > 150, c
    assert c["registered"] / c["expected"] >= 0.9, c
    assert c["stale"] > 10 and c["stale_hits"] / c["stale"] <= 0.15, c
    kills = sum(p["kills"] for p in f.players.values())
    deaths = sum(p["deaths"] for p in f.players.values())
    assert kills == deaths == kills_seen and kills > 5
    assert max(snap_bytes.values()) < realtime.ROOM_BYTES_PER_SEC


def test_eight_player_tick_is_cheap():
    f, t = started(8)
    pts = open_points()
    rng = random.Random(3)
    for u in f.players:
        x, z = rng.choice(pts)
        put(f, u, x, 0, z, t)
    start = time.perf_counter()
    for i in range(20 * 30):                                       # 30 s at 20 Hz
        tt = t + i * 0.05
        for j, (u, p) in enumerate(f.players.items()):
            if p["dead"]:
                continue
            f.pos(u, frame(p["x"] + (0.2 if i % 40 < 20 else -0.2), p["y"], p["z"]), tt)
            if i % 3 == j % 3:
                o = eye(f, u)
                f.fire(u, {"w": 0, "ox": cm(o[0]), "oy": cm(o[1]), "oz": cm(o[2]), "r": j * 4500, "p": 0,
                           "q": int(tt * 100), "ip": 100}, tt)
            if p["mag"][0] == 0:
                p["mag"][0] = 30
        f.tick(tt, True)
    per_second = (time.perf_counter() - start) / 30
    assert per_second < 0.05                                       # < 5% of one core per room


# ---------------------------------------------------- over real websockets --
@pytest.fixture
def clock(monkeypatch):
    t = {"now": 1000.0}
    monkeypatch.setattr(valley, "now", lambda: t["now"])
    valley._rooms.clear()
    return t


async def test_a_match_over_websockets(client, clock):
    a, _ = await make_user("fps-a", 911)
    b, _ = await make_user("fps-b", 912)
    with client.websocket_connect(url("fpsroom", a)) as wa, client.websocket_connect(url("fpsroom", b)) as wb:
        wa.receive_json(); wb.receive_json()
        send(wa, "join")
        assert until(wa, "fps")["match"]["phase"] == "idle"
        send(wb, "join")
        until(wb, "fps")
        send(wb, "start", minutes=3, kills=10)
        assert until(wb, "error")["error"] == "only the host can do that"
        send(wa, "char", c=4)
        assert until(wb, "char")["c"] == 4
        send(wa, "start", minutes=3, kills=10)
        match = until(wb, "fps", where=lambda m: m["match"] and m["match"]["phase"] == "warmup")["match"]
        assert (match["minutes"], match["limit"]) == (3, 10) and len(match["players"]) == 2
        clock["now"] += fps.COUNTDOWN + 0.01
        until(wa, "go")
        until(wb, "go")
        v = valley.valley_for("fpsroom").fps
        put(v, a, 0, 0, 12, clock["now"])
        put(v, b, 0, 0, 6, clock["now"])
        q = 5000
        for n in range(1, 10):
            q += 11
            clock["now"] += 0.11
            send(wa, "fire", **shot((0, fps.EYE, 12), (0, 1.0, 6), q, n_next=n))
        kill = until(wb, "kill")
        assert kill["k"] == a and kill["v"] == b and kill["kills"] == 1
        snap = until(wa, "snap", where=lambda m: any(s[5] >= 0 for s in m["s"]))
        assert snap["s"][0][0] == v.players[a]["slot"]
        clock["now"] += fps.RESPAWN + 0.05
        sp = until(wb, "spawn")
        assert sp["user"] == b and sp["e"] == 2
        send(wb, "leave")                                         # alone now: the round is over
        done = until(wa, "done")
        assert done["results"][0]["user"]["userId"] == a and done["results"][0]["kills"] == 1
        assert not v.running()


async def test_teleport_over_websockets_gets_a_fix_and_end_stops_it(client, clock):
    a, _ = await make_user("fps-c", 913)
    with client.websocket_connect(url("fpsfix", a)) as wa:
        wa.receive_json()
        send(wa, "join")
        until(wa, "fps")
        send(wa, "start")
        until(wa, "fps", where=lambda m: m["match"] and m["match"]["phase"] == "warmup")
        clock["now"] += fps.COUNTDOWN + 0.01
        until(wa, "go")
        send(wa, "pos", **frame(15, 0, 15))
        fix = until(wa, "fix")
        assert {"x", "y", "z", "e"} <= set(fix)
        send(wa, "end")
        assert until(wa, "fps")["match"]["phase"] == "idle"
        assert realtime.get("fps:fpsfix") is None
