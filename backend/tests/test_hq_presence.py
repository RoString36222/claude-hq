"""HQ 2.1 live presence (g = "hq"): everyone in an HQ room sees where everyone else
stands, a few times a second. Only the owner, or anyone while the HQ is open, gets in."""
import pytest
from starlette.websockets import WebSocketDisconnect

from app import hqpresence
from app.auth import issue_ws_ticket
from tests.conftest import auth, make_user


def url(room, uid):
    return f"/v1/rooms/{room}/ws?ticket={issue_ws_ticket(uid)}"


def until(ws, ev, limit=80, where=None):
    for _ in range(limit):
        m = ws.receive_json()
        if m.get("type") == "game" and m.get("g") == "hq" and m.get("ev") == ev and (where is None or where(m)):
            return m
    raise AssertionError(f"no {ev} event")


def send(ws, op, **data):
    ws.send_json({"type": "game", "g": "hq", "op": op, **data})


async def test_visitors_see_each_other_move(client):
    a, ta = await make_user("ann", 1)
    b, _tb = await make_user("bob", 2)
    client.put("/v1/hq/me", headers=auth(ta), json={"open": True})
    room = "hq_" + a
    with client.websocket_connect(url(room, a)) as wa, client.websocket_connect(url(room, b)) as wb:
        wa.receive_json(); wb.receive_json()                      # welcomes
        send(wa, "join")
        first = until(wa, "snap")
        assert [p["u"] for p in first["ps"]] == [a]
        send(wb, "join")
        send(wb, "pos", w="lobby", x=-1250, z=300, r=90, a=1)
        snap = until(wa, "snap", where=lambda m: any(p["u"] == b and p["w"] == "lobby" for p in m["ps"]))
        bob = next(p for p in snap["ps"] if p["u"] == b)
        assert bob == {"u": b, "n": "Bob", "w": "lobby", "x": -1250, "z": 300, "r": 90, "a": 1}
        # nonsense is ignored, not stored
        send(wb, "pos", w="roof", x=1, z=1, r=0)
        send(wb, "pos", w="base", x=10**9, z=0, r=0)
        send(wb, "pos", w="base", x="1", z=0, r=0)
        send(wb, "leave")
        until(wa, "snap", where=lambda m: [p["u"] for p in m["ps"]] == [a])


async def test_closed_hq_keeps_visitors_out(client):
    a, _ta = await make_user("ann", 1)
    b, _tb = await make_user("bob", 2)
    with pytest.raises(WebSocketDisconnect) as e:
        with client.websocket_connect(url("hq_" + a, b)) as ws:
            ws.receive_json()
    assert e.value.code == 4403
    with client.websocket_connect(url("hq_" + a, a)) as ws:      # the owner always gets in
        assert ws.receive_json()["type"] == "welcome"


async def test_hq_presence_only_in_hq_rooms(client):
    a, _ta = await make_user("ann", 1)
    with client.websocket_connect(url("lobby", a)) as ws:
        ws.receive_json()
        send(ws, "join")
        assert until(ws, "error")["error"] == "HQ presence lives in an HQ room"


def test_position_rules():
    p = hqpresence.Presence()
    p.enter("u", {"handle": "u"}, 0.0)
    assert p.pos("u", {"w": "mission", "x": 100, "z": -200, "r": -90, "a": 2}, 0.1)
    assert p.listing()[0]["r"] == 270
    assert not p.pos("u", {"w": "mission", "x": True, "z": 0, "r": 0}, 0.2)
    assert not p.pos("u", {"w": "mission", "x": 0, "z": 0, "r": 0, "a": 7}, 0.3)
    assert not p.pos("nobody", {"w": "base", "x": 0, "z": 0, "r": 0}, 0.4)


async def test_arena_city_is_open_to_everyone_and_tags_wear_their_frame(client):
    from app.db import SessionLocal
    from app.models import EquippedCosmetics
    a, _ = await make_user("ann", 1)
    b, _ = await make_user("bob", 2)
    async with SessionLocal() as db:
        db.add(EquippedCosmetics(user_id=b, slots={"frame": "f-brass"}))
        await db.commit()
    with client.websocket_connect(url("hq_city", a)) as wa, client.websocket_connect(url("hq_city", b)) as wb:
        wa.receive_json(); wb.receive_json()
        send(wa, "join"); send(wb, "join")
        send(wb, "pos", w="city", x=500, z=-2400, r=0, a=1)
        snap = until(wa, "snap", where=lambda m: any(p["u"] == b and p["w"] == "city" for p in m["ps"]))
        bob = next(p for p in snap["ps"] if p["u"] == b)
        assert bob["f"] == "#d8b34a" and "f" not in next(p for p in snap["ps"] if p["u"] == a)
