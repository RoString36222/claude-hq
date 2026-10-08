"""Tests for private rooms: create, join, leave, rename, password, kick, unban, delete, directory, members."""
import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app

from tests.conftest import auth, make_user


@pytest.fixture
async def alice():
    return await make_user("alice", 1)


@pytest.fixture
async def bob():
    return await make_user("bob", 2)


@pytest.fixture
async def carol():
    return await make_user("carol", 3)


@pytest.fixture
async def aclient():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


async def _create(aclient, token, name="TestRoom", password="secret123"):
    return await aclient.post(
        "/v1/rooms/create",
        json={"name": name, "password": password},
        headers=auth(token),
    )


# --- create ---

@pytest.mark.anyio
async def test_create_room(aclient, alice):
    uid, tok = alice
    r = await _create(aclient, tok)
    assert r.status_code == 200
    body = r.json()
    assert body["room"]["name"] == "TestRoom"
    assert body["room"]["ownerHandle"] == "alice"
    assert body["room"]["role"] == "owner"
    assert body["already"] is False


@pytest.mark.anyio
async def test_create_duplicate_name(aclient, alice):
    _, tok = alice
    r1 = await _create(aclient, tok, name="Dup")
    assert r1.status_code == 200
    r2 = await _create(aclient, tok, name="dup")
    assert r2.status_code == 409


@pytest.mark.anyio
async def test_create_lobby_reserved(aclient, alice):
    _, tok = alice
    r = await _create(aclient, tok, name="Lobby")
    assert r.status_code == 422


@pytest.mark.anyio
async def test_create_bad_password(aclient, alice):
    _, tok = alice
    r = await _create(aclient, tok, password="hi")
    assert r.status_code == 422


@pytest.mark.anyio
async def test_create_bad_name(aclient, alice):
    _, tok = alice
    r = await _create(aclient, tok, name="   ")
    assert r.status_code == 422


# --- join ---

@pytest.mark.anyio
async def test_join_room(aclient, alice, bob):
    _, atok = alice
    _, btok = bob
    cr = await _create(aclient, atok)
    rid = cr.json()["room"]["id"]
    r = await aclient.post(
        "/v1/rooms/join",
        json={"roomId": rid, "password": "secret123"},
        headers=auth(btok),
    )
    assert r.status_code == 200
    assert r.json()["room"]["role"] == "member"
    assert r.json()["already"] is False


@pytest.mark.anyio
async def test_join_wrong_password(aclient, alice, bob):
    _, atok = alice
    _, btok = bob
    cr = await _create(aclient, atok)
    rid = cr.json()["room"]["id"]
    r = await aclient.post(
        "/v1/rooms/join",
        json={"roomId": rid, "password": "wrong!!"},
        headers=auth(btok),
    )
    assert r.status_code == 403
    assert "wrong password" in r.json()["detail"]


@pytest.mark.anyio
async def test_join_already_member(aclient, alice, bob):
    _, atok = alice
    _, btok = bob
    cr = await _create(aclient, atok)
    rid = cr.json()["room"]["id"]
    await aclient.post("/v1/rooms/join", json={"roomId": rid, "password": "secret123"}, headers=auth(btok))
    r = await aclient.post("/v1/rooms/join", json={"roomId": rid, "password": "secret123"}, headers=auth(btok))
    assert r.status_code == 200
    assert r.json()["already"] is True


# --- directory ---

@pytest.mark.anyio
async def test_directory(aclient, alice):
    _, tok = alice
    await _create(aclient, tok, name="Room1")
    await _create(aclient, tok, name="Room2")
    r = await aclient.get("/v1/rooms/directory", headers=auth(tok))
    assert r.status_code == 200
    body = r.json()
    assert body["lobby"]["name"] == "Lobby"
    assert len(body["rooms"]) == 2
    assert body["limits"]["nameMax"] == 40


# --- leave ---

@pytest.mark.anyio
async def test_leave_member(aclient, alice, bob):
    _, atok = alice
    _, btok = bob
    cr = await _create(aclient, atok)
    rid = cr.json()["room"]["id"]
    await aclient.post("/v1/rooms/join", json={"roomId": rid, "password": "secret123"}, headers=auth(btok))
    r = await aclient.post("/v1/rooms/leave", json={"roomId": rid}, headers=auth(btok))
    assert r.status_code == 200
    assert r.json()["ok"] is True
    assert r.json()["deleted"] is False


@pytest.mark.anyio
async def test_leave_owner_transfers(aclient, alice, bob):
    _, atok = alice
    _, btok = bob
    cr = await _create(aclient, atok)
    rid = cr.json()["room"]["id"]
    await aclient.post("/v1/rooms/join", json={"roomId": rid, "password": "secret123"}, headers=auth(btok))
    r = await aclient.post("/v1/rooms/leave", json={"roomId": rid}, headers=auth(atok))
    assert r.status_code == 200
    assert r.json()["newOwnerHandle"] == "bob"


@pytest.mark.anyio
async def test_leave_owner_deletes(aclient, alice):
    _, tok = alice
    cr = await _create(aclient, tok)
    rid = cr.json()["room"]["id"]
    r = await aclient.post("/v1/rooms/leave", json={"roomId": rid}, headers=auth(tok))
    assert r.status_code == 200
    assert r.json()["deleted"] is True


# --- rename ---

@pytest.mark.anyio
async def test_rename(aclient, alice):
    _, tok = alice
    cr = await _create(aclient, tok)
    rid = cr.json()["room"]["id"]
    r = await aclient.post(
        "/v1/rooms/rename",
        json={"roomId": rid, "name": "NewName"},
        headers=auth(tok),
    )
    assert r.status_code == 200
    assert r.json()["room"]["name"] == "NewName"


@pytest.mark.anyio
async def test_rename_not_owner(aclient, alice, bob):
    _, atok = alice
    _, btok = bob
    cr = await _create(aclient, atok)
    rid = cr.json()["room"]["id"]
    await aclient.post("/v1/rooms/join", json={"roomId": rid, "password": "secret123"}, headers=auth(btok))
    r = await aclient.post("/v1/rooms/rename", json={"roomId": rid, "name": "Nope"}, headers=auth(btok))
    assert r.status_code == 403


# --- password ---

@pytest.mark.anyio
async def test_change_password(aclient, alice, bob):
    _, atok = alice
    _, btok = bob
    cr = await _create(aclient, atok)
    rid = cr.json()["room"]["id"]
    await aclient.post("/v1/rooms/join", json={"roomId": rid, "password": "secret123"}, headers=auth(btok))
    r = await aclient.post(
        "/v1/rooms/password",
        json={"roomId": rid, "password": "newpass123", "signOutOthers": True},
        headers=auth(atok),
    )
    assert r.status_code == 200
    assert r.json()["signedOut"] >= 0

    # Old password fails
    r2 = await aclient.post("/v1/rooms/join", json={"roomId": rid, "password": "secret123"}, headers=auth(btok))
    assert r2.status_code == 403

    # New password works
    r3 = await aclient.post("/v1/rooms/join", json={"roomId": rid, "password": "newpass123"}, headers=auth(btok))
    assert r3.status_code == 200


# --- kick / unban ---

@pytest.mark.anyio
async def test_kick_and_unban(aclient, alice, bob):
    _, atok = alice
    buid, btok = bob
    cr = await _create(aclient, atok)
    rid = cr.json()["room"]["id"]
    await aclient.post("/v1/rooms/join", json={"roomId": rid, "password": "secret123"}, headers=auth(btok))

    r = await aclient.post("/v1/rooms/kick", json={"roomId": rid, "userId": buid}, headers=auth(atok))
    assert r.status_code == 200

    # Bob is banned, join fails
    r2 = await aclient.post("/v1/rooms/join", json={"roomId": rid, "password": "secret123"}, headers=auth(btok))
    assert r2.status_code == 403
    assert "removed" in r2.json()["detail"]

    # Unban
    r3 = await aclient.post("/v1/rooms/unban", json={"roomId": rid, "userId": buid}, headers=auth(atok))
    assert r3.status_code == 200

    # Now can rejoin
    r4 = await aclient.post("/v1/rooms/join", json={"roomId": rid, "password": "secret123"}, headers=auth(btok))
    assert r4.status_code == 200


@pytest.mark.anyio
async def test_kick_self_fails(aclient, alice):
    uid, tok = alice
    cr = await _create(aclient, tok)
    rid = cr.json()["room"]["id"]
    r = await aclient.post("/v1/rooms/kick", json={"roomId": rid, "userId": uid}, headers=auth(tok))
    assert r.status_code == 400


# --- delete ---

@pytest.mark.anyio
async def test_delete_room(aclient, alice):
    _, tok = alice
    cr = await _create(aclient, tok)
    rid = cr.json()["room"]["id"]
    r = await aclient.post("/v1/rooms/delete", json={"roomId": rid}, headers=auth(tok))
    assert r.status_code == 200

    # Room gone from directory
    d = await aclient.get("/v1/rooms/directory", headers=auth(tok))
    assert len(d.json()["rooms"]) == 0


@pytest.mark.anyio
async def test_delete_not_owner(aclient, alice, bob):
    _, atok = alice
    _, btok = bob
    cr = await _create(aclient, atok)
    rid = cr.json()["room"]["id"]
    await aclient.post("/v1/rooms/join", json={"roomId": rid, "password": "secret123"}, headers=auth(btok))
    r = await aclient.post("/v1/rooms/delete", json={"roomId": rid}, headers=auth(btok))
    assert r.status_code == 403


# --- members ---

@pytest.mark.anyio
async def test_members(aclient, alice, bob):
    _, atok = alice
    _, btok = bob
    cr = await _create(aclient, atok)
    rid = cr.json()["room"]["id"]
    await aclient.post("/v1/rooms/join", json={"roomId": rid, "password": "secret123"}, headers=auth(btok))
    r = await aclient.get(f"/v1/rooms/members?roomId={rid}", headers=auth(atok))
    assert r.status_code == 200
    body = r.json()
    assert len(body["members"]) == 2
    handles = {m["handle"] for m in body["members"]}
    assert handles == {"alice", "bob"}


@pytest.mark.anyio
async def test_members_non_member(aclient, alice, bob):
    _, atok = alice
    _, btok = bob
    cr = await _create(aclient, atok)
    rid = cr.json()["room"]["id"]
    r = await aclient.get(f"/v1/rooms/members?roomId={rid}", headers=auth(btok))
    assert r.status_code == 403


# --- 422 scrubber ---

@pytest.mark.anyio
async def test_422_scrubber(aclient, alice):
    _, tok = alice
    r = await aclient.post("/v1/rooms/create", json={}, headers=auth(tok))
    assert r.status_code == 422
    body = r.json()
    for err in body["detail"]:
        assert "input" not in err


# --- max owned ---

@pytest.mark.anyio
async def test_max_owned(aclient, alice):
    _, tok = alice
    import app.private_rooms as pr
    old = pr.MAX_OWNED
    pr.MAX_OWNED = 2
    try:
        await _create(aclient, tok, name="R1")
        await _create(aclient, tok, name="R2")
        r = await _create(aclient, tok, name="R3")
        assert r.status_code == 409
        assert "already own" in r.json()["detail"]
    finally:
        pr.MAX_OWNED = old


async def test_welcome_names_the_private_room(client, alice, bob):
    """The page only treats a room as open once the welcome says which private room it is
    (and your role there); without roomInfo it falls back to the Lobby."""
    from starlette.websockets import WebSocketDisconnect
    from app.auth import issue_ws_ticket
    (aid, atok), (bid, _btok) = alice, bob
    rid = client.post("/v1/rooms/create", json={"name": "Owls", "password": "secret123"}, headers=auth(atok)).json()["room"]["id"]
    with client.websocket_connect(f"/v1/rooms/{rid}/ws?ticket={issue_ws_ticket(aid)}") as ws:
        w = ws.receive_json()
        assert w["type"] == "welcome"
        assert w["roomInfo"] == {"kind": "private", "id": rid, "name": "Owls", "role": "owner"}
    with client.websocket_connect(f"/v1/rooms/lobby/ws?ticket={issue_ws_ticket(aid)}") as ws:
        assert ws.receive_json()["roomInfo"] is None
    with pytest.raises(WebSocketDisconnect):                          # not a member: still kept out
        with client.websocket_connect(f"/v1/rooms/{rid}/ws?ticket={issue_ws_ticket(bid)}") as ws:
            ws.receive_json()
