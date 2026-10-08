"""HQ 2.1 cosmetics + wallet: buy with Poke Coins through the pantry journal, level
unlocks, equip one per slot, worn in every room's member info, and the Valley
market (capped per day)."""
from sqlalchemy import select

from app.auth import issue_ws_ticket
from app.db import SessionLocal
from app.models import PokeBalance
from tests.conftest import auth, make_user


async def coins(uid, n):
    async with SessionLocal() as db:
        db.add(PokeBalance(user_id=uid, item="coins", qty=n))
        await db.commit()


def item(state, cid):
    return next(i for i in state["items"] if i["id"] == cid)


async def test_buy_equip_and_wear_it_in_a_room(client):
    a, ta = await make_user("ann", 1)
    await coins(a, 30)
    st = client.get("/v1/cosmetics", headers=auth(ta)).json()
    assert st["coins"] == 30 and not item(st, "k-neon")["owned"] and item(st, "k-gold")["locked"]
    assert client.post("/v1/cosmetics/equip", headers=auth(ta), json={"slot": "kart", "item": "k-neon"}).status_code == 409
    r = client.post("/v1/cosmetics/buy", headers=auth(ta), json={"requestId": "buy-0001", "item": "k-neon"})
    assert r.status_code == 200 and r.json()["coins"] == 10 and item(r.json(), "k-neon")["owned"]
    again = client.post("/v1/cosmetics/buy", headers=auth(ta), json={"requestId": "buy-0001", "item": "k-neon"})
    assert again.json()["coins"] == 10                                # a replay, not a second charge
    assert client.post("/v1/cosmetics/buy", headers=auth(ta), json={"requestId": "buy-0002", "item": "k-neon"}).status_code == 409
    assert client.post("/v1/cosmetics/buy", headers=auth(ta), json={"requestId": "buy-0003", "item": "k-gold"}).status_code == 400
    assert client.post("/v1/cosmetics/buy", headers=auth(ta), json={"requestId": "buy-0004", "item": "d-fireworks"}).status_code == 409
    st = client.post("/v1/cosmetics/equip", headers=auth(ta), json={"slot": "kart", "item": "k-neon"}).json()
    assert item(st, "k-neon")["equipped"]
    assert client.post("/v1/cosmetics/equip", headers=auth(ta), json={"slot": "ball", "item": "k-neon"}).status_code == 400
    with client.websocket_connect(f"/v1/rooms/lobby/ws?ticket={issue_ws_ticket(a)}") as ws:
        assert ws.receive_json()["you"]["cos"] == {"kart": "#39ff88"}
    assert client.get(f"/v1/profile/{a}", headers=auth(ta)).json()["cos"] == {"kart": "#39ff88"}
    client.post("/v1/cosmetics/equip", headers=auth(ta), json={"slot": "kart", "item": None})
    with client.websocket_connect(f"/v1/rooms/lobby/ws?ticket={issue_ws_ticket(a)}") as ws:
        assert "cos" not in ws.receive_json()["you"]


async def test_market_sells_finds_with_a_daily_cap(client):
    a, ta = await make_user("ann", 1)
    r = client.post("/v1/market/sell", headers=auth(ta), json={"requestId": "sell-0001", "cat": "gem", "qty": 4})
    assert r.json() == {"ok": True, "coins": 8, "earned": 8}
    assert client.post("/v1/market/sell", headers=auth(ta), json={"requestId": "sell-0001", "cat": "gem", "qty": 4}).json()["earned"] == 0
    assert client.post("/v1/market/sell", headers=auth(ta), json={"requestId": "sell-0002", "cat": "fish", "qty": 5}).status_code == 429
    assert client.post("/v1/market/sell", headers=auth(ta), json={"requestId": "sell-0003", "cat": "fish", "qty": 2}).json()["coins"] == 10
    assert client.post("/v1/market/sell", headers=auth(ta), json={"requestId": "sell-0004", "cat": "lava", "qty": 1}).status_code == 400
    async with SessionLocal() as db:
        assert (await db.execute(select(PokeBalance.qty).where(PokeBalance.user_id == a, PokeBalance.item == "coins"))).scalar() == 10
