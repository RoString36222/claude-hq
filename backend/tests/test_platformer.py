"""Platformer Rush (app/platformer.py, the plat branch of app/valley.py): level sanity,
the referee's rules, an 8-player race and co-op run under simulated lag, and runs over
real room websockets."""
import heapq
import json
import math
import random
import time

import pytest

from app import platformer as pf
from app import realtime, valley
from app.auth import issue_ws_ticket
from tests.conftest import make_user

# The browser's character (games/platformer.js): run speed, gravity, jump, double jump.
RUN, GRAV, JUMP, DJUMP = 6.0, 26.0, 8.6, 7.8


def url(room, uid):
    return f"/v1/rooms/{room}/ws?ticket={issue_ws_ticket(uid)}"


def until(ws, ev, limit=300, where=None):
    for _ in range(limit):
        m = ws.receive_json()
        if m.get("type") == "game" and m.get("g") == "plat" and m.get("ev") == ev and (where is None or where(m)):
            return m
    raise AssertionError(f"no {ev} event")


def send(ws, op, **data):
    ws.send_json({"type": "game", "g": "plat", "op": op, **data})


def pub(uid):
    return {"userId": uid, "handle": uid, "displayName": uid, "avatarUrl": ""}


def fr(x, y, z, q=None, a=1):
    m = {"x": round(x * 100), "y": round(y * 100), "z": round(z * 100), "r": 0, "a": a}
    if q is not None:
        m["q"] = q
    return m


# ------------------------------------------------- the route, as a character runs it --
def arc_time(d, dh, kind):
    if kind == "j":
        return (JUMP + math.sqrt(JUMP * JUMP - 2 * GRAV * dh)) / GRAV
    s = JUMP / GRAV
    return s + (DJUMP + math.sqrt(DJUMP * DJUMP + 2 * GRAV * (JUMP * JUMP / (2 * GRAV) - dh))) / GRAV


def arc_lift(t, kind):
    if kind == "j" or t <= JUMP / GRAV:
        return JUMP * t - GRAV * t * t / 2
    r = t - JUMP / GRAV
    return JUMP * JUMP / (2 * GRAV) + DJUMP * r - GRAV * r * r / 2


def route_path(level, start, speed):
    """The way a character runs the level's route from `start`: a function of time
    since the go -> (x, y, z), and the total time. Walks at `speed`, jumps and
    double-jumps on the route's arcs (horizontal speed as each arc needs)."""
    pts = [list(start) + ["w"]] + [p for p in pf.DATA_BY_ID[level]["route"]]
    segs = []
    t = 0.0
    for a, b in zip(pts, pts[1:]):
        d = math.hypot(b[0] - a[0], b[2] - a[2])
        if b[3] == "w":
            T = d / speed if d > 1e-9 else 0.0
        else:
            T = arc_time(d, b[1] - a[1], b[3])
        segs.append((t, T, a, b))
        t += T

    def at(tt):
        for t0, T, a, b in segs:
            if tt <= t0 + T or (t0, T, a, b) == segs[-1]:
                u = 0.0 if T <= 0 else min(1.0, max(0.0, (tt - t0) / T))
                x, z = a[0] + (b[0] - a[0]) * u, a[2] + (b[2] - a[2]) * u
                y = a[1] if b[3] == "w" else a[1] + arc_lift(u * T, b[3])
                if b[3] != "w" and u >= 1.0:
                    y = b[1]
                return x, y, z
        return tuple(pts[-1][:3])
    return at, t


pf.DATA_BY_ID = {lv["id"]: lv for lv in pf.DATA["levels"]}


# ------------------------------------------------------------------ levels --
def test_levels_are_sane():
    assert [lid for lid in pf.LEVELS] == ["meadow", "sky", "fortress"]
    for lid, L in pf.LEVELS.items():
        raw = pf.DATA_BY_ID[lid]
        assert len(L["spawns"]) == pf.MAX_PLAYERS and len(L["cps"]) >= 2, lid
        for name in raw["solids"]:
            assert name["m"] in pf.MODELS and int(name.get("r", 0)) % 90 == 0, (lid, name)
        def on_ground(p):
            top = pf.support(L, p[0], p[1], p[2], -pf.PR, 0.01)
            return top is not None and abs(top - p[1]) < 1e-6
        for p in L["spawns"] + L["cps"] + [L["flag"]]:
            assert on_ground(p) and not pf.inside(L, *p), (lid, p)
        for a in range(len(L["spawns"])):
            for b in range(a + 1, len(L["spawns"])):
                assert math.dist(L["spawns"][a], L["spawns"][b]) >= 0.9
        for c in L["coins"]:
            assert not pf.inside(L, *c), (lid, c)
            # within a jump of some platform below it
            assert any(s["y1"] <= c[1] <= s["y1"] + 3.2 and pf.in_foot(s, c[0], c[2], 3.5) for s in L["solids"]), (lid, c)
        assert 0 < L["goal"] <= len(L["coins"]) and L["secs"] >= 60
        # the route starts on the spawn island, passes every checkpoint in order, ends at the flag
        route = raw["route"]
        for p in route:
            top = pf.support(L, p[0], p[1], p[2], 0.0, 0.01)
            assert top is not None and abs(top - p[1]) < 1e-6 and p[3] in "wjd", (lid, p)
        k = 0
        for p in route:
            if k < len(L["cps"]) and math.dist(p[:3], L["cps"][k]) < 0.01:
                k += 1
        assert k == len(L["cps"]), lid
        assert math.dist(route[-1][:3], L["flag"]) < 0.01


def test_the_envelope_covers_the_browsers_jump():
    """Every height the browser's jump + double jump reaches (double at any moment) is
    under the referee's bound at that time, and the bound comes back down."""
    for k in range(0, 120):
        s = k / 60
        for i in range(0, 200):
            t = i / 100
            if t <= s:
                h = JUMP * t - GRAV * t * t / 2
            else:
                h0 = JUMP * s - GRAV * s * s / 2
                h = h0 + DJUMP * (t - s) - GRAV * (t - s) ** 2 / 2
            assert h <= pf.lift_bound(t) + 1e-9, (s, t)
    assert pf.H_APEX < 3.2 and pf.lift_bound(2.0) < 0


def test_geometry_helpers():
    L = pf.LEVELS["meadow"]
    s = L["solids"][0]
    assert pf.in_foot(s, s["cx"], s["cz"], 0) and not pf.in_foot(s, s["x1"] + 0.2, s["cz"], 0.1)
    assert pf.support(L, s["cx"], s["y1"] + 0.3, s["cz"], 0, 0.6) == s["y1"]
    assert pf.support(L, s["cx"], s["y1"] + 0.8, s["cz"], 0, 0.6) is None
    assert pf.inside(L, s["cx"], s["y1"] - 0.3, s["cz"]) and not pf.inside(L, s["cx"], s["y1"], s["cz"])
    assert pf.seg_dist((0, 0, 0), (2, 0, 0), (1, 1, 0)) == 1.0
    assert pf.seg_dist((0, 0, 0), (0, 0, 0), (3, 4, 0)) == 5.0
    round_ = [x for x in L["solids"] if x["r"] > 0][0]
    assert pf.in_foot(round_, round_["cx"] + 2.4, round_["cz"], 0)
    assert not pf.in_foot(round_, round_["x1"] - 0.1, round_["z1"] - 0.1, 0)      # the box's corner is air


# ----------------------------------------------------------------- referee --
def started(n=2, level="meadow", mode="race"):
    g = pf.Plat()
    members = {f"u{i}": pub(f"u{i}") for i in range(n)}
    assert g.start(members, level, mode, 100.0) is None
    g.tick(100.0 + pf.COUNTDOWN, True)
    assert g.phase == "run"
    return g, pf.LEVELS[level], 100.0 + pf.COUNTDOWN


def run(g, uid, t0, until_t=None, speed=5.5, hz=20, q0=None):
    """Run uid along the route from its spawn; every frame must be accepted."""
    p = g.players[uid]
    at, total = route_path(g.level, g.lv()["spawns"][p["slot"]], speed)
    end = total if until_t is None else min(total, until_t)
    t = 0.0
    while t < end + 1e-9 and p["fin"] is None:
        t = min(end, t + 1 / hz)
        x, y, z = at(t)
        q = None if q0 is None else q0 + int(round(t * 100))
        ok, fix = g.pos(uid, fr(x, y, z, q), t0 + t)
        assert ok and fix is None, (uid, t, x, y, z)
        if t >= end:
            break
    return t0 + t


def test_start_rules():
    g = pf.Plat()
    assert g.start({}, "nope", "race", 0.0) == "pick a level"
    assert g.start({"a": pub("a")}, "meadow", "golf", 0.0) == "pick race or co-op"
    assert g.start({"a": pub("a")}, "meadow", None, 0.0) is None and g.mode == "race"
    assert g.start({"a": pub("a")}, "meadow", "coop", 0.0) is not None        # one at a time
    g.end()
    g.start({f"u{i}": pub(f"u{i}") for i in range(12)}, "sky", "coop", 0.0)
    assert len(g.players) == pf.MAX_PLAYERS and g.mode == "coop"
    v = g.view(0.0)
    assert v["goInMs"] == 4000 and v["goal"] == pf.LEVELS["sky"]["goal"] and len(v["players"]) == 8


def test_chars_are_picked_and_kept():
    g = pf.Plat()
    assert g.char("a0", {"char": 5}) == 5
    for bad in ({"char": 6}, {"char": -1}, {"char": 1.5}, {"char": True}, {}):
        assert g.char("a0", bad) is None
    g.start({"a0": pub("a0"), "a1": pub("a1")}, "meadow", "race", 0.0)
    assert g.players["a0"]["char"] == 5 and g.players["a1"]["char"] == 1


def test_frames_before_the_start_are_ignored():
    g = pf.Plat()
    g.start({"a": pub("a")}, "meadow", "race", 0.0)
    s = pf.LEVELS["meadow"]["spawns"][0]
    assert g.pos("a", fr(*s), 1.0) == (False, None)
    assert g.tick(pf.COUNTDOWN, True)[0][0] == "go"


def test_a_full_race_run_finishes():
    g, L, t = started(n=1)
    t = run(g, "u0", t)
    p = g.players["u0"]
    assert p["fin"] is not None and p["cp"] == len(L["cps"]) and len(p["cp_at"]) == len(L["cps"])
    assert p["bad"] == 0 and len(p["got"]) >= len(L["coins"]) // 2
    evs = g.tick(t + 0.01, True)
    names = [e[0] for e in evs]
    assert names.count("cp") == len(L["cps"]) and "coin" in names and "finish" in names and names[-1] == "done"
    assert g.results[0]["place"] == 1 and not g.results[0]["dnf"]


def test_checkpoints_count_only_in_order():
    g, L, t = started(n=1)
    p = g.players["u0"]
    c1 = L["cps"][1]
    # standing on checkpoint 2 first does nothing (and is not a legal move from the start anyway)
    p["x"], p["y"], p["z"] = int(c1[0] * 100), int(c1[1] * 100), int(c1[2] * 100)
    p["base"], p["air"] = c1[1], None
    assert g.pos("u0", fr(c1[0] + 0.1, c1[1], c1[2]), t + 0.1)[0]
    assert p["cp"] == 0
    c0 = L["cps"][0]
    p["x"], p["y"], p["z"] = int(c0[0] * 100), int(c0[1] * 100), int(c0[2] * 100)
    p["base"] = c0[1]
    assert g.pos("u0", fr(c0[0], c0[1], c0[2] - 0.1), t + 0.2)[0]
    assert p["cp"] == 1


def test_the_flag_needs_every_checkpoint():
    g, L, t = started(n=1)
    p = g.players["u0"]
    f = L["flag"]
    p["x"], p["y"], p["z"] = int(f[0] * 100), int(f[1] * 100), int(f[2] * 100 + 100)
    p["base"] = f[1]
    assert g.pos("u0", fr(f[0], f[1], f[2]), t + 0.2)[0]
    assert p["fin"] is None
    p["cp"] = len(L["cps"])
    assert g.pos("u0", fr(f[0], f[1], f[2] + 0.2), t + 0.3)[0]
    assert p["fin"] is not None


def test_coins_need_reach_and_count_once_per_player():
    g, L, t = started(n=2)
    # a coin that floats over a platform, with room to walk past it 1.5 m to one side
    pick = None
    for i, c in enumerate(L["coins"]):
        for x in L["solids"]:
            if x["y1"] <= c[1] <= x["y1"] + 1.2 and pf.in_foot(x, c[0], c[2], -0.2):
                for gx in (c[0] + 1.5, c[0] - 1.5):
                    if pf.in_foot(x, gx, c[2], -0.2) and pf.support(L, gx, x["y1"], c[2], 0, 0.01) == x["y1"]:
                        pick = (i, c, x, gx)
                        break
            if pick:
                break
        if pick:
            break
    i, c, s, gx = pick
    p = g.players["u0"]
    p["x"], p["y"], p["z"] = int(gx * 100), int(s["y1"] * 100), int(c[2] * 100)
    p["base"] = s["y1"]
    assert g.pos("u0", fr(gx, s["y1"], c[2] + 0.01), t + 0.2)[0]
    assert i not in p["got"]
    assert g.pos("u0", fr(c[0], s["y1"], c[2]), t + 0.6)[0]
    assert i in p["got"]
    n = len(p["got"])
    assert g.pos("u0", fr(c[0], s["y1"], c[2] + 0.05), t + 0.7)[0]
    assert len(p["got"]) == n                     # once per player
    evs = [e for e in g.tick(t + 0.8, True) if e[0] == "coin"]
    assert len(evs) == n and evs[0][1]["user"] == "u0" and "room" not in evs[0][1]
    # the other racer can still take the same coin
    q = g.players["u1"]
    q["x"], q["y"], q["z"], q["base"] = int(gx * 100), int(s["y1"] * 100), int(c[2] * 100), s["y1"]
    assert g.pos("u1", fr(c[0], s["y1"], c[2]), t + 1.0)[0] and i in q["got"]


def test_coop_coins_are_taken_once_for_the_room():
    g, L, t = started(n=2, mode="coop")
    t1 = run(g, "u0", t, until_t=3.0)
    t2 = run(g, "u1", t, until_t=3.0)
    a, b = g.players["u0"]["got"], g.players["u1"]["got"]
    assert a and not (a & b)                       # u1 ran the same way a moment later: nothing left
    assert sorted(g.taken) == sorted(a | b) and len(g.taken) == len(set(g.taken))
    evs = [e for e in g.tick(max(t1, t2) + 0.01, True) if e[0] == "coin"]
    assert [e[1]["room"] for e in evs] == list(range(1, len(g.taken) + 1))


def test_coop_wins_at_the_goal_or_loses_at_the_time_limit():
    g, L, t = started(n=1, mode="coop")
    g.taken = list(range(L["goal"] - 1))
    g.tick(t + 1, True)
    assert g.phase == "run"
    g.taken.append(L["goal"] - 1)
    evs = g.tick(t + 2, True)
    assert evs[-1][0] == "done" and evs[-1][1]["win"] and evs[-1][1]["total"] == L["goal"]
    g2, L2, t2 = started(n=1, mode="coop")
    evs = g2.tick(t2 + L2["secs"], True)
    assert evs[-1][0] == "done" and evs[-1][1]["win"] is False


def test_teleports_speed_and_flying_are_refused_with_a_fix():
    g, L, t = started(n=1)
    t = run(g, "u0", t, until_t=1.0)
    p = g.players["u0"]
    before = (p["x"], p["y"], p["z"])
    ok, fix = g.pos("u0", fr(p["x"] / 100, p["y"] / 100, p["z"] / 100 - 6), t + 0.05)   # 6 m in 50 ms
    assert not ok and fix is not None and (fix["x"], fix["z"]) == (round(p["safe"][0] * 100), round(p["safe"][2] * 100))
    assert p["bad"] == 1
    # straight up 5 m over a second: a jump can't do it
    sx, sy, sz = p["x"] / 100, p["y"] / 100, p["z"] / 100
    caught = False
    for k in range(1, 21):
        ok, fix = g.pos("u0", fr(sx, sy + k * 0.25, sz), t + 0.6 + k * 0.05)
        if not ok:
            caught = True
            break
    assert caught and p["bad"] == 2
    # hovering at the take-off height across a gap: caught when a fall should have started
    s = L["solids"][0]
    p["x"], p["y"], p["z"] = int(s["cx"] * 100), int(s["y1"] * 100), int(s["z1"] * 100 - 10)
    p["base"], p["air"], p["fix_at"] = s["y1"], None, 0.0
    tt = t + 5
    caught = False
    for k in range(1, 60):
        ok, fix = g.pos("u0", fr(s["cx"], s["y1"] + 0.4, s["z1"] + k * 0.25), tt + k * 0.05)
        if not ok:
            caught = k * 0.05
            break
    assert caught and caught < 2.0
    assert before is not None


def test_inside_a_platform_is_refused():
    g, L, t = started(n=1)
    s = g.lv()["solids"][0]
    p = g.players["u0"]
    ok, fix = g.pos("u0", fr(p["x"] / 100, s["y1"] - 0.3, p["z"] / 100), t + 0.1)
    assert not ok and fix is not None


def test_a_fast_clock_buys_no_speed():
    g, L, t = started(n=1)
    p = g.players["u0"]
    at, total = route_path("meadow", L["spawns"][0], 5.5)
    q, tt, rt = 10000, t, 0.0
    for _ in range(30):                        # honest for 1.5 s
        rt += 0.05; tt += 0.05; q += 5
        assert g.pos("u0", fr(*at(rt), q=q), tt)[0]
    caught = False
    for _ in range(60):                        # then 2x the real speed with a clock to match
        rt += 0.1; tt += 0.05; q += 10
        ok, fix = g.pos("u0", fr(*at(rt), q=q), tt)
        if not ok:
            caught = fix is not None
            break
    assert caught and p["bad"] == 1


def test_stale_frames_are_dropped_quietly():
    g, L, t = started(n=1)
    s = L["spawns"][0]
    assert g.pos("u0", fr(s[0], s[1], s[2] - 0.3, q=500), t + 0.05)[0]
    assert g.pos("u0", fr(s[0], s[1], s[2] - 0.2, q=495), t + 0.06) == (False, None)
    assert g.pos("u0", fr(s[0], s[1], s[2] - 0.3, q=500), t + 0.07) == (False, None)
    assert g.players["u0"]["bad"] == 0


def test_malformed_frames_are_not_cheating():
    g, L, t = started(n=1)
    for bad in ({}, {"x": "1", "y": 0, "z": 0, "r": 0}, {"x": True, "y": 0, "z": 0, "r": 0}, {"x": 0, "y": None, "z": 0, "r": 0}):
        assert g.pos("u0", bad, t + 0.1) == (False, None)
    assert g.players["u0"]["bad"] == 0 and g.pos("nobody", fr(0, 0, 0), t) == (False, None)


def test_a_stalling_tab_in_slow_motion_is_never_refused():
    """A tab that renders at a few frames a second clamps its physics step, so its runner
    moves in slow motion; it sends its simulation clock as q, so every frame (sent at
    ragged 0.14-0.45 s intervals) is still honest to the referee."""
    rng = random.Random(3)
    for level in pf.LEVELS:
        g = pf.Plat()
        g.start({"a": pub("a")}, level, "race", 0.0)
        g.tick(pf.COUNTDOWN, True)
        L = pf.LEVELS[level]
        at, total = route_path(level, L["spawns"][0], 5.5)
        wall, sim, q0 = pf.COUNTDOWN, 0.0, 777
        p = g.players["a"]
        while p["fin"] is None and sim < total:
            gap = rng.uniform(0.14, 0.45)
            wall += gap
            sim = min(total, sim + min(gap, 0.1) * rng.uniform(0.8, 1.0))     # at most 0.1 s of physics per frame
            ok, fix = g.pos("a", fr(*at(sim), q=q0 + int(sim * 100)), wall)
            assert ok and fix is None, (level, sim)
        assert p["fin"] is not None and p["bad"] == 0


def test_frames_are_rate_limited():
    g, L, t = started(n=1)
    s = L["spawns"][0]
    took = sum(g.pos("u0", fr(*s), t)[0] for _ in range(50))
    assert took <= pf.POS_BURST


def test_respawn_goes_to_the_last_checkpoint():
    g, L, t = started(n=1)
    sp = g.respawn("u0", t + 0.1)
    assert (sp["x"], sp["z"]) == (round(L["spawns"][0][0] * 100), round(L["spawns"][0][2] * 100)) and sp["cp"] == 0
    assert g.respawn("u0", t + 0.2) is None                         # spaced out
    at, total = route_path("meadow", L["spawns"][0], 5.5)
    rt, tt = 0.0, t + 1
    p = g.players["u0"]
    while p["cp"] < 1:
        rt += 0.05; tt += 0.05
        assert g.pos("u0", fr(*at(rt)), tt)[0]
    # fall off: frames below the kill plane are fine, then respawn at checkpoint 1
    x, y, z = at(rt)
    for k in range(1, 30):
        if y - k * 0.6 < L["kill"] - 1:
            break
        assert g.pos("u0", fr(x + 0.2, y - k * 0.6, z), tt + k * 0.05)[0]
    sp = g.respawn("u0", tt + 2)
    c = L["cps"][0]
    assert (sp["x"], sp["y"], sp["z"]) == (round(c[0] * 100), round(c[1] * 100), round(c[2] * 100))
    assert g.pos("u0", fr(c[0], c[1], c[2] - 0.2), tt + 2.1)[0]      # and runs on from there
    snap = dict(g.tick(tt + 2.2, True))["snap"]
    assert snap["ps"][0].get("tp") is None or snap["ps"][0]["tp"] == 1


def test_standings_and_snapshots_only_carry_what_moved():
    g, L, t = started(n=3)
    run(g, "u2", t, until_t=4.0)
    evs = dict(g.tick(t + 4.1, True))
    assert evs["snap"]["order"][0] == "u2" and [c["u"] for c in evs["snap"]["ps"]] == ["u2"]
    assert "snap" not in dict(g.tick(t + 4.2, True))
    s = L["spawns"][0]
    g.pos("u0", fr(s[0], s[1], s[2] - 0.2), t + 4.3)
    assert "snap" not in dict(g.tick(t + 4.35, False))
    ps = dict(g.tick(t + 4.4, True))["snap"]["ps"]
    assert [c["u"] for c in ps] == ["u0"] and {"x", "y", "z", "r", "a", "cp"} <= set(ps[0])


def test_a_dropped_player_keeps_their_place_for_the_grace_then_dnf():
    g, L, t = started(n=2)
    assert g.drop("u1", t, blip=True) and g.players["u1"]["away"] == t
    assert g.restore("u1", pub("u1")) and g.players["u1"]["away"] is None
    g.drop("u1", t, blip=True)
    assert ("dnf", {"user": "u1"}) in g.tick(t + pf.GRACE + 0.1, True)
    assert not g.restore("u1", pub("u1"))
    g.drop("u0", t + pf.GRACE + 0.2)
    names = [e[0] for e in g.tick(t + pf.GRACE + 0.3, True)]
    assert names[-1] == "done" and all(r["dnf"] for r in g.results)


def test_leaving_before_the_start_takes_you_off():
    g = pf.Plat()
    g.start({f"u{i}": pub(f"u{i}") for i in range(3)}, "meadow", "race", 0.0)
    assert g.drop("u1", 0.5) and len(g.players) == 2 and not g.drop("nobody", 0.5)


def test_the_rest_get_finish_grace_after_the_winner():
    g, L, t = started(n=2)
    t = run(g, "u0", t)
    g.tick(t, True)
    assert g.phase == "run"
    names = [e[0] for e in g.tick(t + pf.FINISH_GRACE + 0.01, True)]
    assert names[-1] == "done"
    assert [r["user"]["userId"] for r in g.results] == ["u0", "u1"] and g.results[1]["dnf"]


def test_a_race_is_called_after_the_time_limit():
    g, L, t = started(n=2)
    g.tick(t + pf.MAX_RUN_SECS - 1, True)
    assert g.phase == "run"
    assert g.tick(t + pf.MAX_RUN_SECS, True)[-1][0] == "done"


# ------------------------------------------ 8 players under simulated lag --
def lag_run(level, mode, seed):
    """Eight bots run the route at different speeds, 20 frames a second through a
    120 ms +- 60 ms link (frames arrive bunched and out of order)."""
    rng = random.Random(seed)
    g = pf.Plat()
    members = {f"bot{i}": pub(f"bot{i}") for i in range(8)}
    t0 = 1000.0
    assert g.start(members, level, mode, t0) is None
    L = pf.LEVELS[level]
    go = t0 + pf.COUNTDOWN
    paths = {}
    for i, uid in enumerate(members):
        paths[uid] = route_path(level, L["spawns"][g.players[uid]["slot"]], 5.9 - i * 0.3)
    flight = []
    seq = 0
    t = t0
    next_tick = t0
    snap_bytes = []
    true_finish = {}
    coin_evs = []
    out_of_order = 0
    last_q = {}
    while t < go + 300 and g.phase != "done":
        t = round(t + 0.05, 6)
        if t >= go:
            for uid in members:
                at, total = paths[uid]
                rt = t - go
                if uid in true_finish:
                    continue
                rt = min(rt, total)
                x, y, z = at(rt)
                if rt > total / 2 and math.dist((x, y, z), L["flag"]) <= pf.FLAG_R:
                    true_finish[uid] = t
                delay = min(0.24, max(0.0, rng.gauss(0.12, 0.06)))
                seq += 1
                heapq.heappush(flight, (t + delay, seq, uid, fr(*at(rt), q=int(round(t * 100)))))
        while flight and flight[0][0] <= t:
            arr, _s, uid, f = heapq.heappop(flight)
            if f["q"] < last_q.get(uid, -1):
                out_of_order += 1
            last_q[uid] = max(last_q.get(uid, -1), f["q"])
            g.pos(uid, f, arr)
        while next_tick <= t:
            for ev, data in g.tick(next_tick, True):
                if ev == "snap":
                    snap_bytes.append((next_tick, len(json.dumps({"type": "game", "g": "plat", "ev": ev, **data},
                                                                 separators=(",", ":")))))
                if ev == "coin":
                    coin_evs.append(data)
            next_tick += 1 / pf.HZ
    assert g.phase == "done" and out_of_order > 0
    assert sum(p["bad"] for p in g.players.values()) == 0, {u: p["bad"] for u, p in g.players.items()}
    per_sec = {}
    for at_, n in snap_bytes:
        per_sec[int(at_)] = per_sec.get(int(at_), 0) + n * 8
    assert max(per_sec.values()) < realtime.ROOM_BYTES_PER_SEC
    return g, true_finish, coin_evs


@pytest.mark.parametrize("level", ["meadow", "sky", "fortress"])
def test_eight_runners_race_with_lag_finish_in_order_with_no_false_rejections(level):
    for seed in (7, 8):
        g, true_finish, _ = lag_run(level, "race", seed)
        order = [r["user"]["userId"] for r in g.results]
        assert order == sorted(true_finish, key=true_finish.get)
        assert all(not r["dnf"] for r in g.results)
        assert all(p["cp"] == len(g.lv()["cps"]) for p in g.players.values())


@pytest.mark.parametrize("level", ["meadow", "sky", "fortress"])
def test_eight_runners_coop_with_lag_count_each_coin_once(level):
    g, _, coin_evs = lag_run(level, "coop", 9)
    assert g.win is True
    ids = [e["id"] for e in coin_evs]
    assert len(ids) == len(set(ids)) == len(g.taken)
    assert [e["room"] for e in coin_evs] == list(range(1, len(ids) + 1))
    assert sum(len(p["got"]) for p in g.players.values()) == len(g.taken)


def test_eight_runner_tick_is_cheap():
    g, L, t = started(n=8)
    paths = {f"u{i}": route_path("meadow", L["spawns"][i], 5.0)[0] for i in range(8)}
    start = time.perf_counter()
    for f in range(20 * 30):
        tt = t + f * 0.05
        for uid, at in paths.items():
            g.pos(uid, fr(*at(f * 0.05)), tt)
        if f % 2 == 0:
            g.tick(tt, True)
    per_second = (time.perf_counter() - start) / 30
    assert per_second < 0.05


# ---------------------------------------------------- over real websockets --
@pytest.fixture
def clock(monkeypatch):
    t = {"now": 1000.0}
    monkeypatch.setattr(valley, "now", lambda: t["now"])
    valley._rooms.clear()
    return t


async def test_race_over_websockets(client, clock):
    a, _ = await make_user("plat-a", 911)
    b, _ = await make_user("plat-b", 912)
    with client.websocket_connect(url("platroom", a)) as wa, client.websocket_connect(url("platroom", b)) as wb:
        wa.receive_json(); wb.receive_json()
        send(wa, "join")
        until(wa, "plat")
        send(wb, "join")
        until(wb, "plat")
        send(wb, "start", level="meadow", mode="race")
        assert until(wb, "error")["error"] == "only the host can do that"
        send(wa, "char", char=3)
        assert until(wb, "char")["char"] == 3
        send(wa, "start", level="meadow", mode="race")
        run_ = until(wb, "plat", where=lambda m: m["run"] and m["run"]["phase"] == "grid")["run"]
        assert run_["mode"] == "race" and len(run_["players"]) == 2
        assert {p["char"] for p in run_["players"] if p["user"]["userId"] == a} == {3}
        clock["now"] += pf.COUNTDOWN + 0.01
        until(wa, "go")
        until(wb, "go")
        L = pf.LEVELS["meadow"]
        at, total = route_path("meadow", L["spawns"][0], 5.5)
        rt = 0.0
        while rt < total:
            rt = min(total, rt + 0.05)
            clock["now"] += 0.05
            send(wa, "pos", **fr(*at(rt)))
        until(wb, "cp", where=lambda m: m["user"] == a)
        until(wb, "coin", where=lambda m: m["user"] == a)
        until(wb, "finish", where=lambda m: m["user"] == a)
        send(wb, "leave")
        done = until(wa, "done")
        assert done["results"][0]["user"]["userId"] == a and done["results"][0]["place"] == 1
        assert not valley.valley_for("platroom").plat.running()


async def test_coop_respawn_and_fix_over_websockets(client, clock):
    a, _ = await make_user("plat-c", 913)
    with client.websocket_connect(url("platco", a)) as wa:
        wa.receive_json()
        send(wa, "join")
        until(wa, "plat")
        send(wa, "start", level="sky", mode="coop")
        until(wa, "plat", where=lambda m: m["run"] and m["run"]["phase"] == "grid")
        clock["now"] += pf.COUNTDOWN + 0.01
        until(wa, "go")
        s = pf.LEVELS["sky"]["spawns"][0]
        send(wa, "pos", **fr(s[0], s[1], s[2] - 9))            # 9 m in no time
        fix = until(wa, "fix")
        assert {"x", "y", "z"} <= set(fix)
        clock["now"] += 1
        send(wa, "respawn")
        sp = until(wa, "spawn")
        assert (sp["x"], sp["z"]) == (round(s[0] * 100), round(s[2] * 100))
        send(wa, "end")
        assert until(wa, "plat")["run"]["phase"] == "idle"
