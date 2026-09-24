import pytest
from starlette.websockets import WebSocketDisconnect

from app.auth import issue_ws_ticket
from tests.conftest import auth, make_user


def url(room: str, ticket: str) -> str:
    return f"/v1/rooms/{room}/ws?ticket={ticket}"


async def test_invalid_ticket_is_closed(client):
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(url("lobby", "garbage")) as ws:
            ws.receive_json()
    assert exc.value.code == 4401


async def test_join_broadcasts_presence_and_messages(client):
    a_id, a_tok = await make_user("ash", 30)
    b_id, _ = await make_user("gary", 31)

    with client.websocket_connect(url("lobby", issue_ws_ticket(a_id))) as a:
        hello = a.receive_json()
        assert hello["type"] == "welcome"
        assert hello["you"]["handle"] == "ash"
        assert [m["handle"] for m in hello["members"]] == ["ash"]

        with client.websocket_connect(url("lobby", issue_ws_ticket(b_id))) as b:
            # A sees B arrive.
            joined = a.receive_json()
            assert joined["type"] == "join"
            assert joined["member"]["handle"] == "gary"
            assert {m["handle"] for m in joined["members"]} == {"ash", "gary"}

            b.receive_json()  # b's own welcome
            b.send_json({"type": "say", "data": {"hi": "there"}})

            heard = a.receive_json()
            assert heard["type"] == "say"
            assert heard["from"]["handle"] == "gary"
            assert heard["data"] == {"hi": "there"}

        left = a.receive_json()
        assert left["type"] == "leave"
        assert left["member"]["handle"] == "gary"


async def test_shared_state_merges_and_broadcasts(client):
    a_id, _ = await make_user("ash", 32)
    b_id, _ = await make_user("gary", 33)

    with client.websocket_connect(url("game", issue_ws_ticket(a_id))) as a:
        a.receive_json()
        a.send_json({"type": "state", "patch": {"turn": "ash", "round": 1}})
        assert a.receive_json()["state"] == {"turn": "ash", "round": 1}

        with client.websocket_connect(url("game", issue_ws_ticket(b_id))) as b:
            # A late joiner is handed current state, not an empty room.
            welcome = b.receive_json()
            assert welcome["state"] == {"turn": "ash", "round": 1}
            a.receive_json()  # join notice

            b.send_json({"type": "state", "patch": {"turn": "gary"}})
            assert b.receive_json()["state"] == {"turn": "gary", "round": 1}


async def test_malformed_frames_are_reported_not_fatal(client):
    a_id, _ = await make_user("ash", 34)
    with client.websocket_connect(url("lobby", issue_ws_ticket(a_id))) as a:
        a.receive_json()
        a.send_text("{not json")
        assert a.receive_json() == {"type": "error", "error": "malformed json"}

        a.send_json({"type": "state", "patch": "nope"})
        assert "object" in a.receive_json()["error"]

        a.send_json({"type": "ping"})
        assert a.receive_json() == {"type": "pong"}


async def test_empty_rooms_are_reaped(client):
    a_id, a_tok = await make_user("ash", 35)
    with client.websocket_connect(url("ephemeral", issue_ws_ticket(a_id))) as a:
        a.receive_json()
        assert client.get("/v1/rooms", headers=auth(a_tok)).json()["rooms"] == [
            {"roomId": "ephemeral", "members": 1}
        ]
    assert client.get("/v1/rooms", headers=auth(a_tok)).json()["rooms"] == []
