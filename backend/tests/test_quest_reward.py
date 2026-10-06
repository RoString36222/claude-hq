"""Tests for POST /v1/pantry/reward — quest and achievement coin rewards."""
from datetime import UTC, date, datetime, time, timedelta

import pytest
from sqlalchemy import select, update

from app import pantry
from app.db import SessionLocal
from app.models import PokeBalance, PokeLedger
from tests.conftest import auth, make_user


class Clock:
    def __init__(self) -> None:
        self.day = date(2026, 9, 29)
        self.ticks = 0

    def today(self) -> date:
        return self.day

    def now(self) -> datetime:
        self.ticks += 1
        return (datetime.combine(self.day, time(10, 0, 0, 0), tzinfo=UTC)
                + timedelta(seconds=self.ticks))


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    c = Clock()
    monkeypatch.setattr(pantry, "_today", c.today)
    monkeypatch.setattr(pantry, "_now", c.now)
    return c


def reward(client, token, body):
    return client.post("/v1/pantry/reward", json=body, headers=auth(token))


async def put(uid: str, **held: int) -> None:
    async with SessionLocal() as db:
        for item, qty in held.items():
            res = await db.execute(
                update(PokeBalance)
                .where(PokeBalance.user_id == uid, PokeBalance.item == item)
                .values(qty=qty)
            )
            if res.rowcount == 0:
                db.add(PokeBalance(user_id=uid, item=item, qty=qty))
        await db.commit()


async def test_reward_happy_path(client):
    uid, tok = await make_user("ash", 300)
    await put(uid, coins=10)
    r = reward(client, tok, {
        "requestId": "quest:d_prompts_10:2026-09-29",
        "kind": "quest", "questId": "d_prompts_10", "coins": 2,
    })
    assert r.status_code == 200
    j = r.json()
    assert j["ok"] is True
    assert j["reward"] == 2
    assert j["coins"] == 12


async def test_reward_idempotent(client):
    uid, tok = await make_user("ash", 301)
    await put(uid, coins=10)
    body = {
        "requestId": "quest:d_prompts_10:2026-09-29",
        "kind": "quest", "questId": "d_prompts_10", "coins": 2,
    }
    r1 = reward(client, tok, body)
    assert r1.json()["reward"] == 2
    r2 = reward(client, tok, body)
    assert r2.status_code == 200
    assert r2.json()["reward"] == 0
    assert r2.json()["coins"] == 12


async def test_reward_unknown_quest(client):
    _, tok = await make_user("ash", 302)
    r = reward(client, tok, {
        "requestId": "quest:d_nonexistent:2026-09-29",
        "kind": "quest", "questId": "d_nonexistent", "coins": 2,
    })
    assert r.status_code == 404


async def test_reward_wrong_coins(client):
    _, tok = await make_user("ash", 303)
    r = reward(client, tok, {
        "requestId": "quest:d_prompts_10:2026-09-29",
        "kind": "quest", "questId": "d_prompts_10", "coins": 5,
    })
    assert r.status_code == 422


async def test_reward_achievement(client):
    uid, tok = await make_user("ash", 304)
    await put(uid, coins=0)
    r = reward(client, tok, {
        "requestId": "ach:a_first_prompt:bronze",
        "kind": "achievement", "questId": "a_first_prompt",
        "tier": "bronze", "coins": 2,
    })
    assert r.status_code == 200
    assert r.json()["reward"] == 2
    assert r.json()["coins"] == 2


# Ten distinct catalog rewards (21 coins, under COIN_CAP) and an eleventh.
TEN_REWARDS = [
    ("quest", "d_prompts_10", None, 2), ("quest", "d_tools_50", None, 2),
    ("quest", "d_sessions_3", None, 2), ("quest", "d_active", None, 1),
    ("quest", "d_artifacts_1", None, 2), ("quest", "d_feed_creature", None, 1),
    ("achievement", "a_first_prompt", "bronze", 2), ("achievement", "a_prompts", "bronze", 3),
    ("achievement", "a_tools", "bronze", 3), ("achievement", "a_streak", "bronze", 3),
]


def body_for(kind, qid, tier, coins, rid=None):
    b = {"kind": kind, "questId": qid, "coins": coins,
         "requestId": rid or (f"quest:{qid}:2026-09-29" if kind == "quest" else f"ach:{qid}:{tier}")}
    if tier:
        b["tier"] = tier
    return b


async def ledger_ids(uid):
    async with SessionLocal() as db:
        return sorted((await db.execute(
            select(PokeLedger.request_id).where(
                PokeLedger.user_id == uid, PokeLedger.op == "quest")
        )).scalars())


async def test_reward_rate_limit(client, clock):
    uid, tok = await make_user("ash", 305)
    await put(uid, coins=0)
    for i, r in enumerate(TEN_REWARDS):
        res = reward(client, tok, body_for(*r))
        assert res.status_code == 200, f"reward {i} failed: {res.json()}"
        assert res.json()["reward"] == r[3]
    res = reward(client, tok, body_for("achievement", "a_shiny", "bronze", 3))
    assert res.status_code == 429
    # The refused claim rolled back: no eleventh row, no coins.
    assert len(await ledger_ids(uid)) == 10
    async with SessionLocal() as db:
        coins = (await db.execute(select(PokeBalance.qty).where(
            PokeBalance.user_id == uid, PokeBalance.item == "coins"))).scalar_one()
    assert coins == 21


async def test_reward_cap_resets_next_day(client, clock):
    uid, tok = await make_user("ash", 308)
    await put(uid, coins=0)
    for r in TEN_REWARDS:
        assert reward(client, tok, body_for(*r)).status_code == 200
    clock.day += timedelta(days=1)
    res = reward(client, tok, body_for("achievement", "a_shiny", "bronze", 3))
    assert res.status_code == 200


async def test_same_quest_cannot_be_claimed_twice_with_new_request_ids(client):
    uid, tok = await make_user("ash", 309)
    await put(uid, coins=0)
    first = reward(client, tok, body_for("quest", "d_prompts_10", None, 2,
                                         rid="quest:d_prompts_10:2026-09-29"))
    assert first.json()["reward"] == 2
    for rid in ("quest:d_prompts_10:day-1", "quest:d_prompts_10:2026-09-28",
                "quest:d_prompts_10:anything-else"):
        again = reward(client, tok, body_for("quest", "d_prompts_10", None, 2, rid=rid))
        assert again.status_code == 200
        assert again.json()["reward"] == 0
        assert again.json()["coins"] == 2
    assert await ledger_ids(uid) == ["quest:d_prompts_10:2026-09-29"]


async def test_achievement_tier_pays_once_ever(client, clock):
    uid, tok = await make_user("ash", 310)
    await put(uid, coins=0)
    assert reward(client, tok, body_for("achievement", "a_prompts", "bronze", 3)).json()["reward"] == 3
    clock.day += timedelta(days=40)
    again = reward(client, tok, body_for("achievement", "a_prompts", "bronze", 3,
                                         rid="ach:a_prompts:bronze-again"))
    assert again.json()["reward"] == 0
    # A higher tier is a different reward.
    assert reward(client, tok, body_for("achievement", "a_prompts", "silver", 5)).json()["reward"] == 5
    assert await ledger_ids(uid) == ["ach:a_prompts:bronze", "ach:a_prompts:silver"]


async def test_daily_quest_pays_again_next_day(client, clock):
    uid, tok = await make_user("ash", 311)
    await put(uid, coins=0)
    assert reward(client, tok, body_for("quest", "d_active", None, 1)).json()["reward"] == 1
    clock.day += timedelta(days=1)
    assert reward(client, tok, body_for("quest", "d_active", None, 1)).json()["reward"] == 1
    assert await ledger_ids(uid) == ["quest:d_active:2026-09-29", "quest:d_active:2026-09-30"]


async def test_weekly_quest_pays_once_per_iso_week(client, clock):
    uid, tok = await make_user("ash", 312)
    await put(uid, coins=0)
    clock.day = date(2026, 9, 28)  # a Monday, ISO week 40
    w = ("quest", "w_active_5", None, 5)
    assert reward(client, tok, body_for(*w, rid="quest:w_active_5:2026-W40")).json()["reward"] == 5
    clock.day = date(2026, 10, 4)  # Sunday, same week
    assert reward(client, tok, body_for(*w, rid="quest:w_active_5:2026-W41")).json()["reward"] == 0
    clock.day = date(2026, 10, 5)  # next Monday
    assert reward(client, tok, body_for(*w, rid="quest:w_active_5:2026-W41")).json()["reward"] == 5
    assert await ledger_ids(uid) == ["quest:w_active_5:2026-W40", "quest:w_active_5:2026-W41"]


def test_reward_request_id_matches_the_page():
    # index.html builds "quest:<id>:"+todayStr() / isoWeekStr() and "ach:<id>:<tier>".
    d = date(2027, 1, 1)  # ISO week 53 of 2026
    assert pantry.reward_request_id("quest", "d_active", None, d) == "quest:d_active:2027-01-01"
    assert pantry.reward_request_id("quest", "w_active_5", None, d) == "quest:w_active_5:2026-W53"
    assert pantry.reward_request_id("achievement", "a_gift", "gold", d) == "ach:a_gift:gold"
    longest = max(
        [pantry.reward_request_id("quest", q, None, d) for q in pantry.QUEST_REWARDS]
        + [pantry.reward_request_id("achievement", a, "silver", d) for a in pantry.ACH_REWARDS],
        key=len,
    )
    assert len(longest) <= 64


async def test_reward_request_id_longer_than_the_column_is_422(client):
    _, tok = await make_user("ash", 313)
    r = reward(client, tok, body_for("quest", "d_active", None, 1,
                                     rid="quest:d_active:" + "x" * 60))
    assert r.status_code == 422


async def test_reward_extra_fields_rejected(client):
    _, tok = await make_user("ash", 306)
    r = reward(client, tok, {
        "requestId": "quest:d_active:2026-09-29",
        "kind": "quest", "questId": "d_active", "coins": 1,
        "sessionId": "abc-secret",
    })
    assert r.status_code == 422


async def test_reward_bad_request_id(client):
    _, tok = await make_user("ash", 307)
    r = reward(client, tok, {
        "requestId": "bad-no-colons",
        "kind": "quest", "questId": "d_active", "coins": 1,
    })
    assert r.status_code == 422
