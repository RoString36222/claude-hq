from datetime import UTC, datetime, timedelta

from app.auth import mint_pair_code
from app.db import SessionLocal
from app.models import PairCode, User
from tests.conftest import auth, make_user


def test_health(client):
    assert client.get("/health").json()["ok"] is True


def test_unauthenticated_requests_are_rejected(client):
    assert client.get("/v1/board").status_code == 401
    assert client.post("/v1/stats", json={"schemaVersion": 1, "days": []}).status_code == 401
    assert client.get("/v1/board", headers=auth("hqd_nonsense")).status_code == 401


async def test_pair_code_exchanges_for_a_device_token(client):
    async with SessionLocal() as db:
        user = User(github_id=1, handle="ash", display_name="Ash")
        db.add(user)
        await db.flush()
        code = await mint_pair_code(db, user.id)
        await db.commit()

    res = client.post("/v1/auth/pair", json={"code": code, "label": "laptop"})
    assert res.status_code == 200
    token = res.json()["token"]
    assert res.json()["handle"] == "ash"

    me = client.get("/v1/me", headers=auth(token))
    assert me.status_code == 200
    assert me.json()["deviceLabel"] == "laptop"


async def test_pair_code_is_single_use(client):
    async with SessionLocal() as db:
        user = User(github_id=2, handle="misty")
        db.add(user)
        await db.flush()
        code = await mint_pair_code(db, user.id)
        await db.commit()

    assert client.post("/v1/auth/pair", json={"code": code}).status_code == 200
    assert client.post("/v1/auth/pair", json={"code": code}).status_code == 400


async def test_expired_pair_code_is_refused(client):
    async with SessionLocal() as db:
        user = User(github_id=3, handle="brock")
        db.add(user)
        await db.flush()
        db.add(PairCode(
            code="HQ-DEAD-BEEF", user_id=user.id,
            expires_at=datetime.now(UTC) - timedelta(minutes=1),
        ))
        await db.commit()

    assert client.post("/v1/auth/pair", json={"code": "HQ-DEAD-BEEF"}).status_code == 400


async def test_ticket_requires_a_device_token(client):
    _, token = await make_user("gary", 4)
    assert client.post("/v1/auth/ticket").status_code == 401
    res = client.post("/v1/auth/ticket", headers=auth(token))
    assert res.status_code == 200
    assert res.json()["ticket"]
