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
