"""Valley multiplayer (app/valley.py): lobbies, invites, and the server-refereed
pond, race, duel, mines and farm, driven over real room websockets."""
from datetime import date

import pytest

from app import valley
from app.auth import issue_ws_ticket
from app.db import SessionLocal
from app.models import DailyStat
from tests.conftest import make_user


def url(room, uid):
    return f"/v1/rooms/{room}/ws?ticket={issue_ws_ticket(uid)}"


def until(ws, ev, g=None, limit=40, where=None):
    """Read frames until a game event `ev` (optionally for game `g`, matching `where`) arrives."""
    for _ in range(limit):
        m = ws.receive_json()
        if (m.get("type") == "game" and m.get("ev") == ev and (g is None or m.get("g") == g)
                and (where is None or where(m))):
            return m
    raise AssertionError(f"no {ev} event")


def both_in(g, *sockets):
    """Join every socket to game g's lobby and wait until each has seen all of them."""
    for ws in sockets:
        ws.send_json({"type": "game", "g": g, "op": "join"})
    for ws in sockets:
        until(ws, "lobby", where=lambda m: len(m["members"]) == len(sockets))


@pytest.fixture
def clock(monkeypatch):
    t = {"now": 1000.0, "wall": 1_790_000_000.0}
    monkeypatch.setattr(valley, "now", lambda: t["now"])
    monkeypatch.setattr(valley, "wall", lambda: t["wall"])
    valley._rooms.clear()
    return t


async def test_lobby_join_notice_and_host(client, clock):
    a, _ = await make_user("ash", 1)
    b, _ = await make_user("misty", 2)
    with client.websocket_connect(url("lobby", a)) as wa:
        wa.receive_json()
        wa.send_json({"type": "game", "g": "race", "op": "join"})
        first = until(wa, "lobby")
        assert first["joined"]["handle"] == "ash" and first["members"][0]["host"] is True
        with client.websocket_connect(url("lobby", b)) as wb:
            wb.receive_json()
            wb.send_json({"type": "game", "g": "race", "op": "join"})
            seen = until(wa, "lobby", where=lambda m: len(m["members"]) == 2)
            assert seen["joined"]["handle"] == "misty"
            assert seen["name"] == "Puzzle Race"
            assert [m["host"] for m in seen["members"]] == [True, False]
        left = until(wa, "lobby")
        assert left["left"]["handle"] == "misty"


async def test_invite_reaches_the_user_in_another_room(client, clock):
    a, _ = await make_user("ash", 3)
    b, _ = await make_user("misty", 4)
    with client.websocket_connect(url("lobby", a)) as wa, client.websocket_connect(url("other", b)) as wb:
        wa.receive_json(); wb.receive_json()
        wa.send_json({"type": "game", "g": "pond", "op": "join"})
        until(wa, "lobby")
        wa.send_json({"type": "game", "g": "pond", "op": "invite", "to": b})
        inv = until(wb, "invite")
        assert inv["from"]["handle"] == "ash" and inv["room"] == "lobby" and inv["name"] == "Fishing Pond"
        assert until(wa, "invited")["delivered"] == 1


async def test_pond_refuses_fast_reels_and_scores_real_ones(client, clock):
    a, _ = await make_user("ash", 5)
    with client.websocket_connect(url("lobby", a)) as wa:
        wa.receive_json()
        wa.send_json({"type": "game", "g": "pond", "op": "join"})
        until(wa, "pond")
        wa.send_json({"type": "game", "g": "pond", "op": "cast"})
        cast = until(wa, "cast")
        wa.send_json({"type": "game", "g": "pond", "op": "land", "token": cast["token"]})
        assert "too fast" in until(wa, "error")["error"]
        clock["now"] += (cast["biteIn"] + valley.MIN_REEL_MS[cast["rarity"]]) / 1000 + 0.1
        wa.send_json({"type": "game", "g": "pond", "op": "land", "token": cast["token"]})
        got = until(wa, "caught")
        assert got["fish"] == cast["fish"]
        assert got["points"] == valley.FISH_POINTS[cast["rarity"]]
        assert got["goal"] == 1
        wa.send_json({"type": "game", "g": "pond", "op": "land", "token": cast["token"]})
        assert until(wa, "error")["error"] == "no such cast"


async def test_pond_boss_needs_everyone_pulling(client, clock):
    a, _ = await make_user("ash", 6)
    v = valley.valley_for("lobby")
    with client.websocket_connect(url("lobby", a)) as wa:
        wa.receive_json()
        wa.send_json({"type": "game", "g": "pond", "op": "join"})
        until(wa, "pond")
        v.pond.catches = valley.BOSS_EVERY - 1
        wa.send_json({"type": "game", "g": "pond", "op": "cast"})
        cast = until(wa, "cast")
        clock["now"] += 10
        wa.send_json({"type": "game", "g": "pond", "op": "land", "token": cast["token"]})
        boss = until(wa, "boss")["boss"]
        assert boss["hp"] == valley.BOSS_HP_PER_PLAYER
        # Rate limit: only PULL_RATE pulls count per second.
        for _ in range(valley.PULL_RATE + 5):
            wa.send_json({"type": "game", "g": "pond", "op": "pull"})
        until(wa, "bosshp")
        assert v.pond.boss["hp"] == valley.BOSS_HP_PER_PLAYER - valley.PULL_RATE
        for _ in range(10):
            clock["now"] += 1.1
            for _ in range(valley.PULL_RATE):
                wa.send_json({"type": "game", "g": "pond", "op": "pull"})
        down = until(wa, "bossdown")
        assert down["helpers"] == [a] and down["scores"][a] >= 10


def pond_op(ws, op, **data):
    ws.send_json({"type": "game", "g": "pond", "op": op, **data})


async def test_pond_cast_aim_is_clamped_and_shared(client, clock):
    a, _ = await make_user("ash", 31)
    b, _ = await make_user("misty", 32)
    with client.websocket_connect(url("lobby", a)) as wa, client.websocket_connect(url("lobby", b)) as wb:
        wa.receive_json(); wb.receive_json()
        both_in("pond", wa, wb)
        for aim, check in ((5, lambda x: x == 1.0), (-2, lambda x: x == 0.0), (0.42, lambda x: x == 0.42),
                           ("x", lambda x: 0 <= x <= 1), (True, lambda x: 0 <= x <= 1),
                           (None, lambda x: 0 <= x <= 1)):
            pond_op(wa, "cast", **({} if aim is None else {"aim": aim}))
            cast = until(wa, "cast")
            seen = until(wb, "casting")
            assert seen["user"]["handle"] == "ash" and isinstance(seen["aim"], float) and check(seen["aim"]), aim
            assert isinstance(cast["chest"], bool) and seen["id"] == cast["id"]
            pond_op(wa, "lose", token=cast["token"])
            assert until(wb, "lost")["id"] == cast["id"]
            clock["now"] += 1.1          # stay under the per-player op rate


async def test_pond_hook_waits_for_the_bite_and_shows_in_snapshot(client, clock):
    a, _ = await make_user("ash", 33)
    b, _ = await make_user("misty", 34)
    with client.websocket_connect(url("lobby", a)) as wa, client.websocket_connect(url("lobby", b)) as wb:
        wa.receive_json(); wb.receive_json()
        both_in("pond", wa, wb)
        pond_op(wa, "cast", aim=0.3)
        cast = until(wa, "cast")
        pond_op(wa, "hook", token=cast["token"])
        assert until(wa, "error")["error"] == "not yet"
        clock["now"] += (cast["biteIn"] - valley.HOOK_EARLY_MS + 10) / 1000
        pond_op(wa, "hook", token=cast["token"])
        hooked = until(wb, "hooked")
        assert hooked["user"]["handle"] == "ash" and hooked["id"] == cast["id"]
        # A late joiner gets every line with its aim and state.
        wb.send_json({"type": "game", "g": "pond", "op": "join"})
        snap = until(wb, "pond")["pond"]
        assert snap["casting"] == [a]
        assert snap["lines"] == [{"userId": a, "id": cast["id"], "aim": 0.3, "hooked": True}]


async def test_pond_perfect_is_cosmetic_and_chest_is_server_rolled(client, clock, monkeypatch):
    a, _ = await make_user("ash", 35)
    with client.websocket_connect(url("lobby", a)) as wa:
        wa.receive_json()
        pond_op(wa, "join")
        until(wa, "pond")
        for chance in (1, 0):
            monkeypatch.setattr(valley, "CHEST_CHANCE", chance)
            clock["now"] += 1.1
            pond_op(wa, "cast")
            cast = until(wa, "cast")
            assert cast["chest"] is bool(chance)
            clock["now"] += (cast["biteIn"] + valley.MIN_REEL_MS[cast["rarity"]]) / 1000 + 0.1
            pond_op(wa, "land", token=cast["token"], perfect=True, chest=True)
            frames = []
            while True:
                m = wa.receive_json()
                frames.append(m)
                if m.get("ev") == "caught":
                    break
            loot = [m for m in frames if m.get("ev") == "loot"]
            got = frames[-1]
            assert got["perfect"] is True     # relayed for the feed and the card...
            assert got["points"] == valley.FISH_POINTS[cast["rarity"]]   # ...but never worth points
            if chance:
                assert len(loot) == 1 and loot[0]["item"] in dict(valley.CHEST_LOOT)
            else:
                assert not loot


async def test_pond_line_left_out_is_lost_for_everyone_on_leave_and_disconnect(client, clock):
    a, _ = await make_user("ash", 37)
    b, _ = await make_user("misty", 38)
    with client.websocket_connect(url("lobby", b)) as wb:
        wb.receive_json()
        with client.websocket_connect(url("lobby", a)) as wa:
            wa.receive_json()
            both_in("pond", wa, wb)
            pond_op(wa, "cast")
            cast = until(wa, "cast")
            until(wb, "casting")
            pond_op(wa, "leave")
            lost = until(wb, "lost")
            assert lost["id"] == cast["id"] and lost["user"]["userId"] == a and lost["fish"] == cast["fish"]
            assert until(wb, "lobby")["left"]["userId"] == a
            clock["now"] += 1.1
            pond_op(wa, "join")
            until(wa, "pond")
            pond_op(wa, "cast")
            cast = until(wa, "cast")
            until(wb, "casting")
        lost = until(wb, "lost")         # the socket dropped with a line out
        assert lost["id"] == cast["id"] and lost["user"]["userId"] == a


async def test_pond_second_cast_replaces_the_old_line(client, clock):
    a, _ = await make_user("ash", 39)
    b, _ = await make_user("misty", 40)
    with client.websocket_connect(url("lobby", a)) as wa, client.websocket_connect(url("lobby", b)) as wb:
        wa.receive_json(); wb.receive_json()
        both_in("pond", wa, wb)
        pond_op(wa, "cast")
        old = until(wa, "cast")
        until(wb, "casting")
        clock["now"] += 1.1
        pond_op(wa, "cast")
        lost = until(wb, "lost")
        assert lost["id"] == old["id"]
        new = until(wb, "casting")
        assert new["id"] != old["id"]
        cast = until(wa, "cast")
        assert cast["id"] == new["id"]
        pond_op(wa, "land", token=old["token"])
        assert until(wa, "error")["error"] == "no such cast"


async def test_pond_line_ops_are_rate_limited(client, clock):
    a, _ = await make_user("ash", 36)
    v = valley.valley_for("lobby")
    with client.websocket_connect(url("lobby", a)) as wa:
        wa.receive_json()
        pond_op(wa, "join")
        until(wa, "pond")
        for _ in range(valley.POND_OP_RATE + 4):
            pond_op(wa, "land", token="nope")
        pond_op(wa, "join")                 # not a line op: always answered
        until(wa, "pond")
        assert len(v.pond.ops[a]) == valley.POND_OP_RATE
        clock["now"] += 1.1
        pond_op(wa, "cast")
        until(wa, "cast")


async def test_race_marks_privately_and_announces_winner(client, clock, monkeypatch):
    a, _ = await make_user("ash", 7)
    b, _ = await make_user("misty", 8)
    monkeypatch.setattr(valley, "RACE_WORDS", ("cache",))
    with client.websocket_connect(url("lobby", a)) as wa, client.websocket_connect(url("lobby", b)) as wb:
        wa.receive_json(); wb.receive_json()
        both_in("race", wa, wb)
        wa.send_json({"type": "game", "g": "race", "op": "start"})
        rnd = until(wb, "start")["round"]
        wb.send_json({"type": "game", "g": "race", "op": "guess", "round": rnd, "word": "catch"})
        mk = until(wb, "mark")
        assert mk["marks"] == ["hit", "hit", "miss", "near", "near"]
        prog = until(wa, "progress")
        assert prog["hits"] == 2 and "word" not in prog and "marks" not in prog
        wa.send_json({"type": "game", "g": "race", "op": "guess", "round": rnd, "word": "cache"})
        win = until(wb, "win")
        assert win["user"]["handle"] == "ash" and win["word"] == "cache"


def test_mark_handles_repeated_letters():
    assert valley.mark("eerie", "there") == ["near", "miss", "near", "miss", "hit"]


async def test_duel_turns_and_server_side_stats(client, clock):
    a, _ = await make_user("ash", 9)
    b, _ = await make_user("misty", 10)
    team_a = [{"name": "Sparky", "type": "Electric", "stage": 4, "hp": 9999, "atk": 9999}]
    team_b = [{"name": "Splash", "type": "Water", "stage": 0}]
    with client.websocket_connect(url("lobby", a)) as wa, client.websocket_connect(url("lobby", b)) as wb:
        wa.receive_json(); wb.receive_json()
        both_in("duel", wa, wb)
        wa.send_json({"type": "game", "g": "duel", "op": "challenge", "to": b, "team": team_a})
        assert until(wb, "challenge")["from"]["handle"] == "ash"
        wb.send_json({"type": "game", "g": "duel", "op": "accept", "team": team_b})
        duel = until(wa, "duel", where=lambda m: m["duel"])["duel"]
        sparky = duel["teams"][a][0]
        assert sparky["hp"] == 30 + 4 * 12 and sparky["atk"] == 8 + 4 * 3   # client hp/atk ignored
        first = duel["turn"]
        other_ws = wb if first == a else wa
        other_ws.send_json({"type": "game", "g": "duel", "op": "move", "idx": 0})
        assert until(other_ws, "error")["error"] == "not your turn"
        # Play it out: Electric vs Water is super effective, so ash wins.
        for _ in range(20):
            turn_ws = wa if first == a else wb
            turn_ws.send_json({"type": "game", "g": "duel", "op": "move", "idx": 0})
            m = wa.receive_json()
            while m.get("ev") not in ("duel", "duelend") or (m.get("ev") == "duel" and not m.get("duel")):
                m = wa.receive_json()
            if m["ev"] == "duelend":
                assert m["winner"]["handle"] == "ash"
                break
            first = m["duel"]["turn"]
        else:
            raise AssertionError("duel never ended")


async def test_mines_coop_loot_goes_to_the_digger(client, clock):
    a, _ = await make_user("ash", 11)
    with client.websocket_connect(url("lobby", a)) as wa:
        wa.receive_json()
        wa.send_json({"type": "game", "g": "mines", "op": "join"})
        until(wa, "lobby")
        wa.send_json({"type": "game", "g": "mines", "op": "start"})
        run = until(wa, "mines", where=lambda m: m["run"])["run"]
        assert run["depth"] == 1 and run["players"][a]["hp"] == 5
        assert "ladder" not in str(run["grid"])          # hidden until dug up
        wa.send_json({"type": "game", "g": "mines", "op": "move", "dx": 5, "dy": 0})
        assert until(wa, "error")["error"] == "move one tile"
        wa.send_json({"type": "game", "g": "mines", "op": "move", "dx": 1, "dy": 0})
        until(wa, "mines")
        wa.send_json({"type": "game", "g": "mines", "op": "exit"})
        loot = until(wa, "loot")
        assert loot["fainted"] is False and isinstance(loot["items"], dict)
        until(wa, "minesend")


async def test_farm_is_watered_by_published_prompts_and_persists(client, clock):
    a, _ = await make_user("ash", 12)
    with client.websocket_connect(url("farmroom", a)) as wa:
        wa.receive_json()
        wa.send_json({"type": "game", "g": "farm", "op": "join"})
        farm = until(wa, "farm")["farm"]
        assert farm["seedBoxOpen"] is True and farm["gardeners"] == 1
        wa.send_json({"type": "game", "g": "farm", "op": "seeds"})
        farm = until(wa, "farm")["farm"]
        assert sum(farm["seeds"].values()) == valley.FARM_SEEDS_PER_DAY and not farm["seedBoxOpen"]
        crop = next(iter(farm["seeds"]))
        wa.send_json({"type": "game", "g": "farm", "op": "plant", "plot": 0, "crop": crop})
        plot = until(wa, "farm")["farm"]["plots"][0]
        assert plot["crop"] == crop and plot["water"] == 0 and not plot["ripe"]
        wa.send_json({"type": "game", "g": "farm", "op": "harvest", "plot": 0})
        assert until(wa, "error")["error"] == "not ripe yet"
    # Water comes from daily_stats; time from the clock.
    async with SessionLocal() as db:
        db.add(DailyStat(user_id=a, stat_date=valley._today(), prompts=500))
        await db.commit()
    clock["wall"] += 24 * 3600
    with client.websocket_connect(url("farmroom", a)) as wa:
        wa.receive_json()
        wa.send_json({"type": "game", "g": "farm", "op": "join"})
        plot = until(wa, "farm")["farm"]["plots"][0]
        assert plot["ripe"] is True                       # survived the reconnect (stored)
        wa.send_json({"type": "game", "g": "farm", "op": "harvest", "plot": 0})
        h = until(wa, "harvest")
        assert h["crop"] == crop and h["n"] == 2


async def test_actions_need_the_lobby(client, clock):
    a, _ = await make_user("ash", 13)
    with client.websocket_connect(url("lobby", a)) as wa:
        wa.receive_json()
        wa.send_json({"type": "game", "g": "pond", "op": "cast"})
        assert until(wa, "error")["error"] == "join the lobby first"
        wa.send_json({"type": "game", "g": "nope", "op": "join"})
        assert until(wa, "error")["error"] == "unknown game"
