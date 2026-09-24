from app.auth import issue_ws_ticket
from tests.conftest import auth, make_user


async def test_nudge_queues_and_drains_when_offline(client):
    _, ash = await make_user("ash", 50)
    _, gary = await make_user("gary", 51)

    # Ash nudges Gary while Gary has nothing open -> queued, no live delivery.
    r = client.post("/v1/nudge", headers=auth(ash),
                    json={"toHandle": "gary", "note": "  come play\x07  "})
    assert r.status_code == 200
    assert r.json() == {"queued": True, "deliveredLive": 0}

    # Gary's client drains it later.
    got = client.get("/v1/nudges", headers=auth(gary)).json()["nudges"]
    assert len(got) == 1
    assert got[0]["fromHandle"] == "ash"
    assert got[0]["note"] == "come play"          # control char stripped, trimmed
    assert "url" not in got[0] and "link" not in got[0]

    # Draining is one-shot: a second poll is empty.
    assert client.get("/v1/nudges", headers=auth(gary)).json()["nudges"] == []


async def test_nudge_delivers_live_when_in_lobby(client):
    ash_id, ash = await make_user("ash", 52)
    gary_id, gary = await make_user("gary", 53)

    with client.websocket_connect(f"/v1/rooms/lobby/ws?ticket={issue_ws_ticket(gary_id)}") as g:
        g.receive_json()  # welcome
        r = client.post("/v1/nudge", headers=auth(ash), json={"toHandle": "gary"})
        assert r.json()["deliveredLive"] == 1
        live = g.receive_json()
        assert live["type"] == "nudge"
        assert live["from"]["handle"] == "ash"
        assert "url" not in live


async def test_unknown_and_self_targets_rejected(client):
    _, ash = await make_user("ash", 54)
    assert client.post("/v1/nudge", headers=auth(ash),
                       json={"toHandle": "nobody"}).status_code == 404
    assert client.post("/v1/nudge", headers=auth(ash),
                       json={"toHandle": "ash"}).status_code == 400


async def test_undelivered_nudges_are_capped(client):
    _, ash = await make_user("ash", 55)
    await make_user("gary", 56)
    for _ in range(5):
        assert client.post("/v1/nudge", headers=auth(ash),
                           json={"toHandle": "gary"}).status_code == 200
    # 6th while 5 are still undelivered -> rate-limited.
    assert client.post("/v1/nudge", headers=auth(ash),
                       json={"toHandle": "gary"}).status_code == 429


async def test_nudges_require_auth(client):
    assert client.get("/v1/nudges").status_code == 401
    assert client.post("/v1/nudge", json={"toHandle": "x"}).status_code == 401
