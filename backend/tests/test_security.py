"""Issue #49: startup secret guard, device management + idle expiry, ingest
caps, /health status codes."""
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, update
from starlette.websockets import WebSocketDisconnect

from app import main as app_main
from app.auth import hash_token, issue_ws_ticket, new_device_token
from app.config import DEFAULT_SECRET_KEY, Settings, check_secret_key
from app.db import SessionLocal
from app.main import app
from app.models import Device
from tests.conftest import auth, make_user

TODAY = datetime.now(UTC).date()
GOOD_KEY = "k" * 32


async def add_device(uid: str, label: str = "desktop") -> tuple[str, str]:
    """Pair another device for uid. Returns (device_id, token)."""
    token = new_device_token()
    async with SessionLocal() as db:
        d = Device(user_id=uid, token_hash=hash_token(token), label=label)
        db.add(d)
        await db.commit()
        return d.id, token


async def device_of(token: str) -> Device:
    async with SessionLocal() as db:
        return (
            await db.execute(select(Device).where(Device.token_hash == hash_token(token)))
        ).scalar_one()


# --- 1. startup guard --------------------------------------------------------

@pytest.mark.parametrize("key", [DEFAULT_SECRET_KEY, "short", "x" * 31])
def test_insecure_secret_key_is_refused(key):
    with pytest.raises(RuntimeError, match="ARENA_SECRET_KEY"):
        check_secret_key(Settings(secret_key=key, dev=False))


def test_strong_secret_key_is_accepted():
    check_secret_key(Settings(secret_key=GOOD_KEY, dev=False))


def test_dev_mode_allows_a_weak_key():
    check_secret_key(Settings(secret_key=DEFAULT_SECRET_KEY, dev=True))


def test_dev_flag_reads_arena_dev(monkeypatch):
    monkeypatch.setenv("ARENA_DEV", "0")
    assert Settings().dev is False
    monkeypatch.setenv("ARENA_DEV", "1")
    assert Settings().dev is True


def test_app_refuses_to_start_with_the_default_key(monkeypatch):
    insecure = Settings(secret_key=DEFAULT_SECRET_KEY, dev=False)
    monkeypatch.setattr(app_main, "get_settings", lambda: insecure)
    with pytest.raises(RuntimeError, match="ARENA_SECRET_KEY"):
        with TestClient(app):
            pass


# --- 5. /health --------------------------------------------------------------

def test_health_is_200_when_the_db_answers(client):
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json()["ok"] is True


def test_health_is_503_when_the_db_is_unreachable(client, monkeypatch):
    async def boom():
        raise OSError("connection refused")

    monkeypatch.setattr(app_main, "describe_backend", boom)
    res = client.get("/health")
    assert res.status_code == 503
    assert res.json()["ok"] is False
    assert "unreachable" in res.json()["db"]


# --- 2. devices --------------------------------------------------------------

async def test_list_devices_marks_the_current_one(client):
    uid, tok = await make_user("ash", 900)
    other_id, _ = await add_device(uid, "desktop")
    _, stranger_tok = await make_user("gary", 901)

    res = client.get("/v1/auth/devices", headers=auth(tok))
    assert res.status_code == 200
    devices = res.json()["devices"]
    assert len(devices) == 2
    assert devices[0]["current"] is True
    assert devices[0]["label"] == "test"
    assert {d["id"] for d in devices if not d["current"]} == {other_id}
    assert set(devices[0]) == {"id", "label", "created", "lastSeen", "current"}

    # Only your own devices.
    theirs = client.get("/v1/auth/devices", headers=auth(stranger_tok)).json()["devices"]
    assert other_id not in {d["id"] for d in theirs}


async def test_revoke_another_of_my_devices(client):
    uid, tok = await make_user("ash", 902)
    other_id, other_tok = await add_device(uid)

    res = client.post(f"/v1/auth/devices/{other_id}/revoke", headers=auth(tok))
    assert res.status_code == 200
    assert res.json()["revoked"] == other_id

    assert client.get("/v1/me", headers=auth(other_tok)).status_code == 401
    assert client.get("/v1/me", headers=auth(tok)).status_code == 200
    listed = client.get("/v1/auth/devices", headers=auth(tok)).json()["devices"]
    assert [d["id"] for d in listed] != [] and other_id not in {d["id"] for d in listed}
    # Already revoked: gone.
    assert client.post(f"/v1/auth/devices/{other_id}/revoke", headers=auth(tok)).status_code == 404


async def test_cannot_revoke_someone_elses_device(client):
    _, tok = await make_user("ash", 903)
    _, their_tok = await make_user("gary", 904)
    their_id = (await device_of(their_tok)).id

    res = client.post(f"/v1/auth/devices/{their_id}/revoke", headers=auth(tok))
    assert res.status_code == 404
    assert client.get("/v1/me", headers=auth(their_tok)).status_code == 200


async def test_revoke_self(client):
    _, tok = await make_user("ash", 905)
    res = client.post("/v1/auth/revoke-self", headers=auth(tok))
    assert res.status_code == 200
    assert client.get("/v1/me", headers=auth(tok)).status_code == 401
    assert client.post("/v1/auth/revoke-self", headers=auth(tok)).status_code == 401


async def test_ticket_carries_the_device_and_dies_with_it(client):
    _, tok = await make_user("ash", 906)
    ticket = client.post("/v1/auth/ticket", headers=auth(tok)).json()["ticket"]
    client.post("/v1/auth/revoke-self", headers=auth(tok))

    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(f"/v1/rooms/lobby/ws?ticket={ticket}") as ws:
            ws.receive_json()
    assert exc.value.code == 4401


async def test_revoking_a_device_closes_its_live_sockets(client):
    uid, tok = await make_user("ash", 907)
    other_id, other_tok = await add_device(uid)
    b_id, _ = await make_user("gary", 908)

    ticket = client.post("/v1/auth/ticket", headers=auth(other_tok)).json()["ticket"]
    with client.websocket_connect(f"/v1/rooms/lobby/ws?ticket={issue_ws_ticket(b_id)}") as b:
        assert b.receive_json()["type"] == "welcome"
        with client.websocket_connect(f"/v1/rooms/lobby/ws?ticket={ticket}") as a:
            assert a.receive_json()["type"] == "welcome"
            assert b.receive_json()["type"] == "join"

            res = client.post(f"/v1/auth/devices/{other_id}/revoke", headers=auth(tok))
            assert res.json()["closedSockets"] == 1

            with pytest.raises(WebSocketDisconnect) as exc:
                a.receive_json()
            assert exc.value.code == 4401
        # The other member sees them leave; unrelated sockets stay up.
        assert b.receive_json()["type"] == "leave"


async def _age(token: str, days: int) -> None:
    async with SessionLocal() as db:
        await db.execute(
            update(Device)
            .where(Device.token_hash == hash_token(token))
            .values(last_seen_at=datetime.now(UTC) - timedelta(days=days))
        )
        await db.commit()


async def test_idle_device_expires_and_is_revoked(client):
    _, tok = await make_user("ash", 909)
    await _age(tok, 91)
    res = client.get("/v1/me", headers=auth(tok))
    assert res.status_code == 401
    assert "inactivity" in res.json()["detail"]
    assert (await device_of(tok)).revoked is True


async def test_recently_used_device_stays_valid(client):
    _, tok = await make_user("ash", 910)
    await _age(tok, 89)
    assert client.get("/v1/me", headers=auth(tok)).status_code == 200


async def test_never_seen_device_ages_from_pairing(client):
    _, tok = await make_user("ash", 911)
    async with SessionLocal() as db:
        await db.execute(
            update(Device)
            .where(Device.token_hash == hash_token(tok))
            .values(last_seen_at=None, created_at=datetime.now(UTC) - timedelta(days=120))
        )
        await db.commit()
    assert client.get("/v1/me", headers=auth(tok)).status_code == 401


async def test_idle_device_ticket_cannot_open_a_socket(client):
    uid, tok = await make_user("ash", 912)
    device = await device_of(tok)
    ticket = issue_ws_ticket(uid, device.id)
    await _age(tok, 200)
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(f"/v1/rooms/lobby/ws?ticket={ticket}") as ws:
            ws.receive_json()
    assert exc.value.code == 4401
    assert (await device_of(tok)).revoked is True


# --- 3. ingest caps ----------------------------------------------------------

def _day(**kw):
    return {"date": TODAY.isoformat(), **kw}


def _post(client, tok, *days):
    return client.post("/v1/stats", headers=auth(tok),
                       json={"schemaVersion": 1, "days": list(days)})


@pytest.mark.parametrize("field,value,note", [
    ("artifacts", 5_001, "artifacts"),
    ("replies", 50_001, "replies"),
    ("tokens", {"input": 10_000_000_001}, "token"),
    ("tokens", {"cacheRead": 10_000_000_001}, "token"),
    ("toolBreakdown", [{"name": "Bash", "count": 50_001}], "tool breakdown"),
])
async def test_ingest_rejects_days_over_the_caps(client, field, value, note):
    _, tok = await make_user("ash", 920)
    res = _post(client, tok, _day(**{field: value}))
    assert res.status_code == 200
    body = res.json()
    assert body["accepted"] == 0 and body["rejected"] == 1
    assert any(note in n for n in body["notes"])


async def test_ingest_accepts_days_at_the_caps(client):
    _, tok = await make_user("ash", 921)
    res = _post(client, tok, _day(
        artifacts=5_000, replies=50_000, tools=50_000,
        tokens={"input": 10_000_000_000, "output": 1, "cacheRead": 10_000_000_000,
                "cacheCreation": 0},
    ))
    assert res.json() == {"accepted": 1, "rejected": 0, "notes": []}


@pytest.mark.parametrize("day", [
    {"replies": 2**31},
    {"artifacts": 2**31},
    {"tokens": {"output": 2**63}},
    {"toolBreakdown": [{"name": "Bash", "count": 2**31}]},
])
async def test_values_beyond_column_range_are_422(client, day):
    _, tok = await make_user("ash", 922)
    assert _post(client, tok, _day(**day)).status_code == 422
