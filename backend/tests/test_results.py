"""HQ 2.1: game results the Arena records itself, progression (session + game XP,
capped per day), leaderboards and trainer profiles."""
import pytest

from app import results
from app.db import SessionLocal
from app.models import GameResult
from tests.conftest import auth, make_user


def kart_done(a, b):
    return {"type": "game", "g": "kart", "ev": "done", "track": "meadow", "results": [
        {"user": {"userId": a}, "place": 1, "ms": 61000, "dnf": False, "laps": [20000, 41000, 61000]},
        {"user": {"userId": b}, "place": 2, "ms": None, "dnf": True, "laps": [25000]}]}


def test_rows_from_done_for_each_game():
    rows = results.rows_from_done("kart", kart_done("a", "b"))
    assert rows[0] == {"user_id": "a", "game": "kart", "place": 1, "players": 2, "key": "meadow",
                       "mode": "3 laps", "value": 61000, "extra": {"bestLap": 20000}}
    assert rows[1]["value"] is None and rows[1]["extra"] == {}
    fps = results.rows_from_done("fps", {"results": [{"user": {"userId": "a"}, "place": 1, "kills": 9, "deaths": 2}]})
    assert fps[0]["value"] == 9 and fps[0]["extra"] == {"kills": 9, "deaths": 2}
    golf = results.rows_from_done("golf", {"course": "windmill", "totals": {"a": 14, "b": 12, "c": 14}})
    assert [(r["user_id"], r["place"]) for r in golf] == [("b", 1), ("a", 2), ("c", 2)]
    plat = results.rows_from_done("plat", {"level": "sky", "mode": "coop", "results": [{"user": {"userId": "a"}, "place": 1, "ms": 9, "coins": 3}]})
    assert plat[0]["value"] is None and plat[0]["extra"] == {"coins": 3}      # co-op runs are not timed
    assert results.rows_from_done("kart", {"results": [{"user": "junk"}]}) == []


async def test_record_progress_boards_profile(client):
    a, ta = await make_user("ann", 1)
    b, tb = await make_user("bob", 2)
    assert await results.record("kart", kart_done(a, b)) == 2
    assert await results.record("fps", {"results": [{"user": {"userId": a}, "place": 1, "kills": 60, "deaths": 1},
                                                     {"user": {"userId": b}, "place": 2, "kills": 50, "deaths": 2}]}) == 2
    assert await results.record("nope", {}) == 0
    prog = client.get("/v1/progress/me", headers=auth(ta)).json()
    assert prog["gameXp"] == 2 * (20 + 30) and prog["sessionXp"] == 0 and prog["level"] >= 1
    assert client.get("/v1/hq/me", headers=auth(ta)).json()["level"] == prog["level"]
    board = client.get("/v1/leaderboards/kart", headers=auth(tb)).json()
    assert board["boards"][0]["key"] == "meadow"
    ent = board["boards"][0]["entries"]
    assert [e["user"]["handle"] for e in ent] == ["ann"] and ent[0]["best"] == 61000 and ent[0]["bestLap"] == 20000
    fps = client.get("/v1/leaderboards/fps", headers=auth(ta)).json()["boards"][0]["entries"]
    assert [(e["user"]["handle"], e["kills"], e["kd"]) for e in fps] == [("ann", 60, 60.0), ("bob", 50, 25.0)]
    assert client.get("/v1/leaderboards/chess", headers=auth(ta)).status_code == 404
    prof = client.get(f"/v1/profile/{a}", headers=auth(tb)).json()
    assert prof["totals"] == {"played": 2, "wins": 2, "podiums": 2} and prof["isYou"] is False
    assert {t["id"] for t in prof["trophies"]} >= {"first-game", "first-win"}
    assert prof["games"]["kart"]["best:meadow"] == 61000 and prof["games"]["fps"]["kd"] == 60.0
    assert client.get("/v1/profile/me", headers=auth(ta)).json()["isYou"] is True
    assert client.get("/v1/profile/nobody", headers=auth(ta)).status_code == 404


async def test_game_xp_is_capped_per_day(client):
    a, ta = await make_user("ann", 1)
    b, _ = await make_user("bob", 2)
    for _ in range(20):
        await results.record("kart", kart_done(a, b))
    assert client.get("/v1/progress/me", headers=auth(ta)).json()["gameXp"] == results.GAME_XP_DAY_CAP


async def test_a_real_race_end_is_recorded(client):
    """The hook in valley._flush keeps results from the server's own done event."""
    from app import valley
    from app.rooms import Room
    a, _ = await make_user("ann", 1)
    room = Room("lobby")
    out = valley.Out("kart")
    out.lobby([a], "done", **{k: v for k, v in kart_done(a, a).items() if k not in ("type", "g", "ev")})
    await valley._flush(room, out)
    import asyncio
    await asyncio.sleep(0.2)
    async with SessionLocal() as db:
        from sqlalchemy import select
        n = len((await db.execute(select(GameResult))).scalars().all())
    assert n == 2
