"""Quick Play (HQ 2.1): queue per game, crewmates first, a fresh qp_ room per match."""
import pytest

from app import quickplay
from tests.conftest import auth, make_user


@pytest.fixture(autouse=True)
def clean():
    quickplay.reset()
    yield
    quickplay.reset()


async def test_match_after_the_wait_and_crew_first(client, monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(quickplay, "_now", lambda: clock[0])
    a, ta = await make_user("ann", 1)
    b, tb = await make_user("bob", 2)
    c, tc = await make_user("cat", 3)
    # ann and cat are crewmates
    code = client.post("/v1/crews/create", headers=auth(ta), json={"name": "Owls", "tag": "OWL", "color": "#ffffff"}).json()["crew"]["code"]
    client.post("/v1/crews/join", headers=auth(tc), json={"code": code})
    assert client.post("/v1/quickplay/join", headers=auth(ta), json={"game": "kart"}).json()["state"] == "waiting"
    clock[0] += 1
    client.post("/v1/quickplay/join", headers=auth(tb), json={"game": "kart"})
    clock[0] += 1
    client.post("/v1/quickplay/join", headers=auth(tc), json={"game": "kart"})
    assert client.get("/v1/quickplay/status", headers=auth(ta)).json()["waiting"] == 3     # not yet: under the wait
    clock[0] += quickplay.WAIT_SECS
    sa = client.get("/v1/quickplay/status", headers=auth(ta)).json()
    sc = client.get("/v1/quickplay/status", headers=auth(tc)).json()
    assert sa["state"] == "matched" and sa["room"].startswith("qp_") and sa["game"] == "kart" and sa["room"] == sc["room"]
    assert client.post("/v1/quickplay/join", headers=auth(ta), json={"game": "chess"}).json()["state"] == "error"
    assert client.post("/v1/quickplay/leave", headers=auth(tb)).json()["state"] == "idle"


async def test_a_full_group_matches_at_once_and_stale_entries_drop(client, monkeypatch):
    clock = [5000.0]
    monkeypatch.setattr(quickplay, "_now", lambda: clock[0])
    toks = []
    for i in range(9):
        _, t = await make_user("p%d" % i, 100 + i)
        toks.append(t)
    for t in toks[:8]:
        client.post("/v1/quickplay/join", headers=auth(t), json={"game": "type"})
    assert client.get("/v1/quickplay/status", headers=auth(toks[0])).json()["players"] == 8
    client.post("/v1/quickplay/join", headers=auth(toks[8]), json={"game": "type"})
    clock[0] += quickplay.STALE_SECS + 1
    assert client.get("/v1/quickplay/status", headers=auth(toks[8])).json()["state"] == "idle"   # stopped polling: dropped


async def test_only_matched_players_get_into_the_room(client, monkeypatch):
    from starlette.websockets import WebSocketDisconnect
    from app.auth import issue_ws_ticket
    clock = [9000.0]
    monkeypatch.setattr(quickplay, "_now", lambda: clock[0])
    a, ta = await make_user("ann", 1)
    b, tb = await make_user("bob", 2)
    c, _tc = await make_user("cat", 3)
    client.post("/v1/quickplay/join", headers=auth(ta), json={"game": "golf"})
    client.post("/v1/quickplay/join", headers=auth(tb), json={"game": "golf"})
    clock[0] += quickplay.WAIT_SECS
    room = client.get("/v1/quickplay/status", headers=auth(ta)).json()["room"]
    with client.websocket_connect(f"/v1/rooms/{room}/ws?ticket={issue_ws_ticket(a)}") as ws:
        w = ws.receive_json()
        assert w["type"] == "welcome" and w["roomInfo"] == {"kind": "quickplay", "id": room, "game": "golf", "name": "Quick Play: Mini Golf"}
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"/v1/rooms/{room}/ws?ticket={issue_ws_ticket(c)}") as ws:
            ws.receive_json()
