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


async def test_reward_rate_limit(client, clock):
    uid, tok = await make_user("ash", 305)
    await put(uid, coins=0)
    for i in range(10):
        r = reward(client, tok, {
            "requestId": f"quest:d_prompts_10:day-{i}",
            "kind": "quest", "questId": "d_prompts_10", "coins": 2,
        })
        assert r.status_code == 200, f"reward {i} failed: {r.json()}"
    r = reward(client, tok, {
        "requestId": "quest:d_prompts_10:day-10",
        "kind": "quest", "questId": "d_prompts_10", "coins": 2,
    })
    assert r.status_code == 429


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
