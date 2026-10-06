"""Valley multiplayer (app/valley.py): lobbies, invites, and the server-refereed
pond, race, duel, mines and farm, driven over real room websockets."""
import random
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


class FixedRng:
    """Every draw is 0.5: no crits, no misses below 50% accuracy, damage roll 93, side b wins ties."""

    def random(self):
        return 0.5

    def __getattr__(self, name):
        return getattr(random.Random(1), name)


@pytest.fixture
def fixed(monkeypatch):
    monkeypatch.setattr(valley, "_rng", lambda: FixedRng())


CHARIZARD = {"sp": 1, "st": 4}            # Lv55, Speed 132: Flare Blitz, Dragon Claw, Air Slash, Scary Face
VENUSAUR = {"sp": 3, "st": 4}             # Lv55, Speed 110
PIKACHU18 = {"sp": 0, "st": 1}            # Lv18, Speed 42: Thunder Shock, Quick Attack (+1), ...
MAGIKARP = {"sp": 14, "st": 0}            # Lv8: Tackle only
GENGAR = {"sp": 5, "st": 4}               # Ghost/Poison


def start_duel(wa, wb, b, team_a, team_b):
    both_in("duel", wa, wb)
    wa.send_json({"type": "game", "g": "duel", "op": "challenge", "to": b, "team": team_a})
    assert until(wb, "challenge")["from"]["handle"] == "ash"
    wb.send_json({"type": "game", "g": "duel", "op": "accept", "team": team_b})
    duel = until(wa, "duel", where=lambda m: m["duel"])["duel"]
    until(wb, "duel", where=lambda m: m["duel"])
    return duel


def act(ws, turn, **a):
    ws.send_json({"type": "game", "g": "duel", "op": "act", "turn": turn, "a": a})


async def duel_users():
    a, _ = await make_user("ash", 9)
    b, _ = await make_user("misty", 10)
    return a, b


async def test_duel_stats_and_moves_are_derived_server_side(client, clock, fixed):
    a, b = await duel_users()
    fake = dict(CHARIZARD, hp=9999, max=9999, atk=9999, stats={"spe": 999}, moves=["hyperbeam"], name="Sparky")
    with client.websocket_connect(url("lobby", a)) as wa, client.websocket_connect(url("lobby", b)) as wb:
        wa.receive_json(); wb.receive_json()
        duel = start_duel(wa, wb, b, [fake], [VENUSAUR])
        zard = duel["sides"][a]["team"][0]
        assert (zard["name"], zard["lvl"], zard["hp"], zard["max"]) == ("Charizard", 55, 167, 167)
        assert zard["types"] == ["Fire", "Flying"]
        assert [m["id"] for m in zard["moves"]] == ["flareblitz", "dragonclaw", "airslash", "scaryface"]
        assert [m["pp"] for m in zard["moves"]] == [15, 15, 15, 10]
        assert duel["phase"] == "choose" and set(duel["waiting"]) == {a, b}


async def test_duel_simultaneous_choice_speed_damage_and_pp(client, clock, fixed):
    from app import pokebattle as pb
    a, b = await duel_users()
    with client.websocket_connect(url("lobby", a)) as wa, client.websocket_connect(url("lobby", b)) as wb:
        wa.receive_json(); wb.receive_json()
        duel = start_duel(wa, wb, b, [CHARIZARD], [VENUSAUR])
        act(wa, duel["turn"], k="move", i=0)                       # Flare Blitz
        assert until(wb, "waiting")["waiting"] == [b]              # nothing resolves on one choice
        act(wa, duel["turn"], k="move", i=0)                       # a resend is idempotent
        act(wb, duel["turn"], k="move", i=0)
        turn = until(wa, "turn")
        moves = [e for e in turn["events"] if e["t"] == "move"]
        assert [e["side"] for e in moves] == [0, 1]                # faster Charizard first
        zard, saur = pb.build_mon(dict(CHARIZARD, br=None, mg=None)), pb.build_mon(dict(VENUSAUR, br=None, mg=None))
        want, mult = pb.damage(zard, saur, pb.MOVES["flareblitz"], False, 93)
        assert mult == 2
        hit = next(e for e in turn["events"] if e["t"] == "dmg" and e["side"] == 1)
        assert hit["hp"] == saur["max"] - want and not hit["crit"]
        assert 1 <= want <= saur["max"]
        lo, hi = pb.damage(zard, saur, pb.MOVES["flareblitz"], False, 85)[0], pb.damage(zard, saur, pb.MOVES["flareblitz"], False, 100)[0]
        assert lo <= want <= hi
        recoil = next(e for e in turn["events"] if e["t"] == "residual" and e["why"] == "recoil")
        assert recoil["side"] == 0
        view = turn["duel"]
        assert view["sides"][a]["team"][0]["moves"][0]["pp"] == 14
        assert view["turn"] == duel["turn"] + 1
        # A move with no PP left is refused.
        valley._rooms["lobby"].duel.match["state"]["sides"][0]["team"][0]["moves"][1]["pp"] = 0
        act(wa, view["turn"], k="move", i=1)
        assert until(wa, "error")["error"] == "you can't do that now"
        act(wa, view["turn"] - 1, k="move", i=0)                   # stale turn: ignored, told the current one
        assert until(wa, "late")["turn"] == view["turn"]


async def test_duel_priority_beats_speed_and_type_immunity(client, clock, fixed):
    a, b = await duel_users()
    with client.websocket_connect(url("lobby", a)) as wa, client.websocket_connect(url("lobby", b)) as wb:
        wa.receive_json(); wb.receive_json()
        duel = start_duel(wa, wb, b, [GENGAR], [PIKACHU18])
        assert duel["sides"][b]["team"][0]["moves"][1]["id"] == "quickattack"
        act(wa, duel["turn"], k="move", i=0)
        act(wb, duel["turn"], k="move", i=1)                       # Quick Attack, +1 priority
        events = until(wa, "turn")["events"]
        moves = [e for e in events if e["t"] == "move"]
        assert moves[0]["side"] == 1 and moves[0]["move"] == "quickattack"
        assert next(e for e in events if e["side"] == 0 and e["t"] in ("dmg", "immune"))["t"] == "immune"


async def test_duel_replace_phase_then_win(client, clock, fixed):
    a, b = await duel_users()
    with client.websocket_connect(url("lobby", a)) as wa, client.websocket_connect(url("lobby", b)) as wb:
        wa.receive_json(); wb.receive_json()
        duel = start_duel(wa, wb, b, [CHARIZARD], [MAGIKARP, MAGIKARP])
        act(wa, duel["turn"], k="move", i=0)
        act(wb, duel["turn"], k="move", i=0)
        turn = until(wb, "turn")
        assert any(e["t"] == "faint" and e["side"] == 1 for e in turn["events"])
        view = turn["duel"]
        assert view["phase"] == "replace" and view["waiting"] == [b] and view["deadline_in"] == 30
        act(wa, view["turn"], k="move", i=0)
        assert until(wa, "error")["error"] == "wait for the other player"
        act(wb, view["turn"], k="move", i=0)
        assert until(wb, "error")["error"] == "you can't do that now"
        act(wb, view["turn"], k="switch", to=1)
        swap = until(wa, "turn")
        assert swap["events"] == [{"t": "switch", "side": 1, "slot": 1, "name": "Magikarp"}]
        assert swap["duel"]["phase"] == "choose"
        act(wa, view["turn"], k="move", i=0)
        act(wb, view["turn"], k="move", i=0)
        end = until(wa, "duelend")
        assert end["winner"]["handle"] == "ash" and not end.get("forfeit")


async def test_duel_timeout_picks_for_you_and_forfeit(client, clock, fixed):
    a, b = await duel_users()
    with client.websocket_connect(url("lobby", a)) as wa, client.websocket_connect(url("lobby", b)) as wb:
        wa.receive_json(); wb.receive_json()
        duel = start_duel(wa, wb, b, [VENUSAUR], [CHARIZARD])
        act(wa, duel["turn"], k="move", i=2)
        until(wa, "waiting")
        clock["now"] += valley.DUEL_FIRST_SECS + 1
        wa.send_json({"type": "game", "g": "duel", "op": "poke"})
        turn = until(wb, "turn")
        assert [e["move"] for e in turn["events"] if e["t"] == "move" and e["side"] == 1] == ["flareblitz"]
        wb.send_json({"type": "game", "g": "duel", "op": "forfeit"})
        end = until(wa, "duelend")
        assert end["winner"]["handle"] == "ash" and end["forfeit"] is True


async def test_duel_changing_your_mind_overwrites_until_both_are_in(client, clock, fixed):
    a, b = await duel_users()
    with client.websocket_connect(url("lobby", a)) as wa, client.websocket_connect(url("lobby", b)) as wb:
        wa.receive_json(); wb.receive_json()
        duel = start_duel(wa, wb, b, [CHARIZARD], [VENUSAUR])
        act(wa, duel["turn"], k="move", i=0)
        until(wb, "waiting")
        act(wa, duel["turn"], k="move", i=3)                       # Scary Face instead
        act(wb, duel["turn"], k="move", i=0)
        moves = [e["move"] for e in until(wa, "turn")["events"] if e["t"] == "move" and e["side"] == 0]
        assert moves == ["scaryface"]


async def test_duel_two_server_picks_in_a_row_forfeit(client, clock, fixed):
    a, b = await duel_users()
    with client.websocket_connect(url("lobby", a)) as wa, client.websocket_connect(url("lobby", b)) as wb:
        wa.receive_json(); wb.receive_json()
        duel = start_duel(wa, wb, b, [VENUSAUR], [VENUSAUR])
        act(wa, duel["turn"], k="move", i=0)
        until(wa, "waiting")                                        # processed before the clock moves
        clock["now"] += valley.DUEL_FIRST_SECS + 1
        wa.send_json({"type": "game", "g": "duel", "op": "poke"})
        view = until(wa, "turn")["duel"]                            # b idled once: the server chose
        assert view["deadline_in"] == valley.DUEL_CHOOSE_SECS
        act(wa, view["turn"], k="move", i=0)
        until(wa, "waiting", where=lambda m: m["turn"] == view["turn"])
        clock["now"] += valley.DUEL_CHOOSE_SECS + 1
        wa.send_json({"type": "game", "g": "duel", "op": "poke"})
        end = until(wa, "duelend")
        assert end["winner"]["handle"] == "ash" and end["timeout"] is True and end["forfeit"] is True


async def test_duel_choosing_resets_the_idle_count(client, clock, fixed):
    a, b = await duel_users()
    with client.websocket_connect(url("lobby", a)) as wa, client.websocket_connect(url("lobby", b)) as wb:
        wa.receive_json(); wb.receive_json()
        duel = start_duel(wa, wb, b, [VENUSAUR], [VENUSAUR])
        act(wa, duel["turn"], k="move", i=0)
        until(wa, "waiting")                                        # processed before the clock moves
        clock["now"] += valley.DUEL_FIRST_SECS + 1
        wa.send_json({"type": "game", "g": "duel", "op": "poke"})
        view = until(wb, "turn")["duel"]
        act(wb, view["turn"], k="move", i=0)                       # b is back
        act(wa, view["turn"], k="move", i=0)
        view = until(wb, "turn", where=lambda m: m["duel"]["turn"] == view["turn"] + 1)["duel"]
        act(wa, view["turn"], k="move", i=0)
        until(wa, "waiting", where=lambda m: m["turn"] == view["turn"])
        clock["now"] += valley.DUEL_CHOOSE_SECS + 1
        wa.send_json({"type": "game", "g": "duel", "op": "poke"})
        nxt = until(wa, "turn", where=lambda m: m["duel"]["turn"] == view["turn"] + 1)   # one more pick, no forfeit
        assert valley._rooms["lobby"].duel.match is not None and nxt["duel"]["phase"] == "choose"


async def test_duel_survives_a_dropped_connection_and_resumes(client, clock, fixed):
    a, b = await duel_users()
    with client.websocket_connect(url("lobby", a)) as wa:
        wa.receive_json()
        with client.websocket_connect(url("lobby", b)) as wb:
            wb.receive_json()
            duel = start_duel(wa, wb, b, [CHARIZARD], [VENUSAUR])
            act(wa, duel["turn"], k="move", i=0)
            act(wb, duel["turn"], k="move", i=0)
            hp = until(wb, "turn")["duel"]["sides"][b]["team"][0]["hp"]
        away = until(wa, "away")                                    # b's socket dropped: no forfeit yet
        assert away["user"] == b and away["ms"] == valley.DUEL_GRACE_SECS * 1000
        assert valley._rooms["lobby"].duel.match is not None
        clock["now"] += valley.DUEL_GRACE_SECS - 1
        with client.websocket_connect(url("lobby", b)) as wb2:     # e.g. a page refresh
            wb2.receive_json()
            wb2.send_json({"type": "game", "g": "duel", "op": "join"})
            assert until(wa, "back")["user"] == b
            view = until(wb2, "duel")["duel"]
            assert view["mid"] == duel["mid"] and view["turn"] == duel["turn"] + 1
            assert view["sides"][b]["team"][0]["hp"] == hp and view["away"] == {}
            assert view["sides"][a]["team"][0]["moves"][0]["pp"] == 14
            wb2.send_json({"type": "game", "g": "duel", "op": "sync"})
            assert until(wb2, "duel")["duel"]["mid"] == duel["mid"]
            act(wa, view["turn"], k="move", i=1)
            act(wb2, view["turn"], k="move", i=0)
            assert until(wb2, "turn")["duel"]["turn"] == view["turn"] + 1


async def test_duel_forfeits_when_the_dropped_player_never_returns(client, clock, fixed):
    a, b = await duel_users()
    with client.websocket_connect(url("lobby", a)) as wa:
        wa.receive_json()
        with client.websocket_connect(url("lobby", b)) as wb:
            wb.receive_json()
            start_duel(wa, wb, b, [CHARIZARD], [VENUSAUR])
        until(wa, "away")
        clock["now"] += valley.DUEL_GRACE_SECS + 1
        wa.send_json({"type": "game", "g": "duel", "op": "poke"})
        end = until(wa, "duelend")
        assert end["winner"]["handle"] == "ash" and end["left"] is True


async def test_duel_leaving_the_lobby_on_purpose_forfeits_at_once(client, clock, fixed):
    a, b = await duel_users()
    with client.websocket_connect(url("lobby", a)) as wa, client.websocket_connect(url("lobby", b)) as wb:
        wa.receive_json(); wb.receive_json()
        start_duel(wa, wb, b, [CHARIZARD], [VENUSAUR])
        wb.send_json({"type": "game", "g": "duel", "op": "leave"})
        end = until(wa, "duelend")
        assert end["winner"]["handle"] == "ash" and end["forfeit"] is True


async def test_duel_decline_tells_the_challenger(client, clock):
    a, b = await duel_users()
    with client.websocket_connect(url("lobby", a)) as wa, client.websocket_connect(url("lobby", b)) as wb:
        wa.receive_json(); wb.receive_json()
        both_in("duel", wa, wb)
        wa.send_json({"type": "game", "g": "duel", "op": "challenge", "to": b, "team": [CHARIZARD]})
        until(wb, "challenge")
        wb.send_json({"type": "game", "g": "duel", "op": "decline"})
        assert until(wa, "declined")["by"]["handle"] == "misty"
        wb.send_json({"type": "game", "g": "duel", "op": "accept", "team": [VENUSAUR]})
        assert until(wb, "error")["error"] == "that challenge is gone"


async def test_duel_non_participants_cannot_act(client, clock, fixed):
    a, b = await duel_users()
    c, _ = await make_user("brock", 11)
    with client.websocket_connect(url("lobby", a)) as wa, client.websocket_connect(url("lobby", b)) as wb, \
            client.websocket_connect(url("lobby", c)) as wc:
        wa.receive_json(); wb.receive_json(); wc.receive_json()
        duel = start_duel(wa, wb, b, [CHARIZARD], [VENUSAUR])
        wc.send_json({"type": "game", "g": "duel", "op": "join"})
        assert until(wc, "duel")["duel"]["mid"] == duel["mid"]     # spectators see the match
        act(wc, duel["turn"], k="move", i=0)
        assert until(wc, "error")["error"] == "you are not in this duel"


def test_duel_team_validation_mega_and_branch():
    t = valley._team
    assert t([]) is None and t([CHARIZARD] * 7) is None
    assert t([{"sp": True, "st": 4}]) is None and t([{"sp": 1, "st": 4.0}]) is None
    assert t([{"sp": 48, "st": 0}]) is None and t([{"sp": 1, "st": 5}]) is None
    assert t([dict(CHARIZARD, st=3, mg="charizard-megax")])[0]["name"] == "Charizard"   # Mega only at stage 4
    mega = t([dict(CHARIZARD, mg="charizard-megax")])[0]
    assert (mega["name"], mega["types"], mega["mega"], mega["sprite"]) == ("Mega Charizard X", ["Fire", "Dragon"], "charizard-megax", 10034)
    assert t([dict(CHARIZARD, mg="gengar-mega")])[0]["mega"] is None
    assert t([{"sp": 4, "st": 4, "br": 197}])[0]["name"] == "Umbreon"
    assert t([{"sp": 4, "st": 4, "br": 25}])[0]["name"] == "Vaporeon"       # not an Eevee branch: default
    assert t([{"sp": 4, "st": 1, "br": 197}])[0]["name"] == "Eevee"
    assert t([{"sp": 0, "st": 4, "name": "x" * 99}])[0]["name"] == "Raichu"


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
