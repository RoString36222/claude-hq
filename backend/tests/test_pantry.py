import asyncio
from datetime import UTC, date, datetime, time, timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy import select, text, update
from sqlalchemy.exc import IntegrityError

from app import pantry
from app.auth import issue_ws_ticket
from app.db import SessionLocal
from app.models import PokeBalance, PokeLedger, User
from app.schemas import BuyRequest
from tests.conftest import auth, make_user

# Copied from the client's tests/test_arena.py: nothing the pantry sends may
# carry any of these.
FORBIDDEN_KEYS = {
    "prompt", "prompts_text", "reply", "text", "content", "path", "paths",
    "cwd", "folder", "project", "projectName", "sessionId", "sessionTitle",
    "title", "file", "files",
}

KINDS = ["berry", "bread", "riceball", "coffee", "bento", "noodles", "hotpot", "tonic",
         "elixir", "strawberry", "dango", "omelette", "watermelon", "shavedice", "curry",
         "apple", "sweetpotato", "pumpkinstew", "chestnuts", "cocoa", "oden"]
# The Clock's default day, 2026-09-28, is in the fall and its special is the Hot Pot.
FALL = {"apple", "sweetpotato", "pumpkinstew"}


class Clock:
    """Stands in for pantry._today/_now. Every _now() is a second later, so
    ledger rows have a stable order, and carries microseconds so a round trip
    through the database is really tested."""

    def __init__(self) -> None:
        self.day = date(2026, 9, 28)
        self.ticks = 0

    def today(self) -> date:
        return self.day

    def now(self) -> datetime:
        self.ticks += 1
        return (datetime.combine(self.day, time(10, 2, 3, 123456), tzinfo=UTC)
                + timedelta(seconds=self.ticks))


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    c = Clock()
    monkeypatch.setattr(pantry, "_today", c.today)
    monkeypatch.setattr(pantry, "_now", c.now)
    return c


def rid(tag: str) -> str:
    return f"rid-{tag}-0000000000000000"[:64]


async def put(uid: str, **held: int) -> None:
    """Set balances directly, creating rows as needed."""
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


async def held(uid: str) -> dict:
    async with SessionLocal() as db:
        rows = await db.execute(
            select(PokeBalance.item, PokeBalance.qty).where(PokeBalance.user_id == uid)
        )
        return {item: qty for item, qty in rows.all() if qty}


async def ledger(**where) -> list[PokeLedger]:
    async with SessionLocal() as db:
        q = select(PokeLedger).order_by(PokeLedger.created_at)
        for col, val in where.items():
            q = q.where(getattr(PokeLedger, col) == val)
        return list((await db.execute(q)).scalars().all())


async def row_count(model) -> int:
    async with SessionLocal() as db:
        return len((await db.execute(select(model))).scalars().all())


async def deactivate(uid: str) -> None:
    async with SessionLocal() as db:
        await db.execute(update(User).where(User.id == uid).values(is_active=False))
        await db.commit()


def _collect_keys(obj) -> set:
    keys = set()
    if isinstance(obj, dict):
        for k, v in obj.items():
            keys.add(k)
            keys |= _collect_keys(v)
    elif isinstance(obj, list):
        for v in obj:
            keys |= _collect_keys(v)
    return keys


def post(client, token, path, body=None):
    return client.post(f"/v1/pantry/{path}", headers=auth(token), json=body or {})


def buy(client, token, kind, qty=1, r=None):
    return post(client, token, "buy", {"requestId": r or rid(f"buy-{kind}-{qty}"),
                                      "kind": kind, "qty": qty})


def give(client, token, to, r, coins=0, kind=None, qty=0, note=""):
    body = {"requestId": r, "toHandle": to, "coins": coins, "qty": qty, "note": note}
    if kind is not None:
        body["kind"] = kind
    return post(client, token, "give", body)


async def test_get_is_read_only(client):
    _, ash = await make_user("ash", 200)
    r = client.get("/v1/pantry", headers=auth(ash))
    assert r.status_code == 200
    j = r.json()
    assert j["coins"] == 0 and j["coinCap"] == 30 and j["itemCap"] == 10
    assert j["items"] == {k: 0 for k in KINDS}
    assert [c["kind"] for c in j["catalog"]] == KINDS
    assert [c["basePrice"] for c in j["catalog"]] == [
        1, 1, 2, 2, 3, 3, 4, 5, 7, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3]
    assert [c["restoreMins"] for c in j["catalog"]] == [
        20, 20, 45, 45, 120, 120, 180, 0, 60, 25, 55, 135, 25, 55, 135, 25, 55, 135, 25, 55, 135]
    assert [c["kind"] for c in j["catalog"] if c["revives"]] == ["tonic", "elixir"]
    assert j["catalog"][2] == {"kind": "riceball", "name": "Rice Ball", "plural": "Rice Balls",
                               "emoji": "\U0001F359", "price": 2, "basePrice": 2,
                               "restoreMins": 45, "revives": False, "season": "all",
                               "inStock": True, "special": False}
    assert (j["season"], j["special"]) == ("fall", "hotpot")
    assert j["claim"] == {"claimedToday": False, "claimable": True, "amount": 5,
                          "today": "2026-09-28", "nextClaimAt": "2026-09-29T00:00:00+00:00"}
    assert j["limits"] == {"buyMaxQty": 5, "giftMaxCoins": 5, "giftMaxQty": 3,
                           "giftsLeftToday": 8}
    assert j["recentGifts"] == []

    # Nothing was created or claimed by looking.
    assert await row_count(PokeBalance) == 0
    assert await row_count(PokeLedger) == 0
    assert client.get("/v1/pantry", headers=auth(ash)).json() == j


async def test_claim_once_per_utc_day(client, clock):
    _, ash = await make_user("ash", 201)

    first = post(client, ash, "claim").json()
    assert first["op"] == "claim"
    assert (first["claimed"], first["granted"], first["starter"], first["full"]) == (True, 5, True, False)
    assert first["coins"] == 5 and first["items"]["riceball"] == 1
    assert first["claim"]["claimedToday"] is True and first["claim"]["claimable"] is False

    again = post(client, ash, "claim").json()
    assert (again["claimed"], again["granted"], again["starter"], again["full"]) == (False, 0, False, False)
    assert again["coins"] == 5

    clock.day += timedelta(days=1)
    nxt = post(client, ash, "claim").json()
    assert (nxt["claimed"], nxt["granted"], nxt["starter"]) == (True, 5, False)
    assert nxt["coins"] == 10 and nxt["items"]["riceball"] == 1
    assert nxt["claim"]["today"] == "2026-09-29"
    assert nxt["claim"]["nextClaimAt"] == "2026-09-30T00:00:00+00:00"

    rows = await ledger(op="claim")
    assert [r.request_id for r in rows] == ["claim:2026-09-28", "claim:2026-09-29"]
    assert [(r.coins, r.kind, r.qty) for r in rows] == [(5, "riceball", 1), (5, None, 0)]


async def test_claim_purse_cap(client, clock):
    uid, ash = await make_user("ash", 202)
    await put(uid, coins=28)

    # A partial grant is recorded.
    r = post(client, ash, "claim").json()
    assert (r["claimed"], r["granted"], r["full"], r["coins"]) == (True, 2, False, 30)
    assert [row.coins for row in await ledger(op="claim")] == [2]

    # At the cap nothing is recorded, and the claim stays open for later today.
    clock.day += timedelta(days=1)
    full = post(client, ash, "claim").json()
    assert (full["claimed"], full["granted"], full["starter"], full["full"]) == (False, 0, False, True)
    assert full["claim"]["claimedToday"] is False and full["claim"]["claimable"] is False
    assert len(await ledger(op="claim")) == 1

    assert buy(client, ash, "bento").json()["coins"] == 27
    later = post(client, ash, "claim").json()
    assert (later["claimed"], later["granted"], later["coins"]) == (True, 3, 30)
    assert later["claim"]["claimedToday"] is True


async def test_buy(client):
    uid, ash = await make_user("ash", 203)
    await put(uid, coins=8)

    r = buy(client, ash, "bento", qty=2, r=rid("b1"))
    assert r.status_code == 200
    j = r.json()
    assert (j["op"], j["replayed"], j["kind"], j["qty"], j["spent"]) == ("buy", False, "bento", 2, 6)
    assert j["coins"] == 2 and j["items"]["bento"] == 2
    [row] = await ledger(op="buy")
    assert (row.kind, row.qty, row.coins, row.to_user_id, row.note) == ("bento", 2, 6, None, "")

    # Short of coins: refused whole, nothing written.
    rows_before = await row_count(PokeLedger)
    r = buy(client, ash, "bento", r=rid("b2"))
    assert r.status_code == 409
    assert r.json()["detail"] == "not enough Poke Coins (need 3, you have 2)"
    assert await held(uid) == {"coins": 2, "bento": 2}
    assert await row_count(PokeLedger) == rows_before

    # The pantry cap refuses the whole purchase too.
    await put(uid, coins=30, berry=9)
    r = buy(client, ash, "berry", qty=2, r=rid("b3"))
    assert r.status_code == 409
    assert r.json()["detail"] == "your pantry holds at most 10 Berries"
    assert (await held(uid))["coins"] == 30
    assert buy(client, ash, "berry", r=rid("b4")).json()["items"]["berry"] == 10

    good = {"requestId": rid("v"), "kind": "berry", "qty": 1}
    for bad in ({"kind": "pizza"}, {"qty": 0}, {"qty": 6}, {"qty": True}, {"qty": "2"},
                {"qty": 1.5}, {"sessionId": "00000000-0000-4000-8000-000000000000"},
                {"requestId": "tooshort"}, {"requestId": "has a space 0123456789"},
                {"requestId": "colon:0123456789abcdef"}, {"requestId": "x" * 65}):
        assert post(client, ash, "buy", {**good, **bad}).status_code == 422, bad


async def test_idempotency(client):
    uid, ash = await make_user("ash", 204)
    await put(uid, coins=10)

    body = {"requestId": rid("same"), "kind": "riceball", "qty": 1}
    a = post(client, ash, "buy", body).json()
    b = post(client, ash, "buy", body).json()
    assert a["replayed"] is False and b["replayed"] is True
    assert (b["kind"], b["qty"], b["spent"]) == ("riceball", 1, 2)
    assert a["coins"] == b["coins"] == 8
    assert len(await ledger(op="buy")) == 1

    for other in ({**body, "kind": "berry"}, {**body, "qty": 2}):
        r = post(client, ash, "buy", other)
        assert r.status_code == 409
        assert r.json()["detail"] == "that requestId was already used for a different request"
    r = post(client, ash, "eat", {"requestId": body["requestId"], "kind": "riceball"})
    assert r.status_code == 409

    # A refused attempt rolled its journal row back, so the same id runs again.
    retry = {"requestId": rid("retry"), "kind": "tonic", "qty": 2}
    assert post(client, ash, "buy", retry).status_code == 409
    await put(uid, coins=12)
    r = post(client, ash, "buy", retry).json()
    assert r["replayed"] is False and r["coins"] == 2 and r["items"]["tonic"] == 2


async def test_eat(client):
    uid, ash = await make_user("ash", 205)
    await put(uid, bento=2, tonic=1)

    r = post(client, ash, "eat", {"requestId": rid("e1"), "kind": "bento"})
    assert r.status_code == 200
    j = r.json()
    assert (j["op"], j["replayed"], j["kind"], j["restoreMins"], j["revives"]) == \
        ("eat", False, "bento", 120, False)
    assert j["items"]["bento"] == 1
    assert j["at"] == "2026-09-28T10:02:04.123456+00:00"

    # A replay returns the ORIGINAL time and eats nothing more.
    again = post(client, ash, "eat", {"requestId": rid("e1"), "kind": "bento"}).json()
    assert again["replayed"] is True and again["at"] == j["at"]
    assert again["items"]["bento"] == 1

    assert post(client, ash, "eat", {"requestId": rid("e2"), "kind": "bento"}).status_code == 200
    r = post(client, ash, "eat", {"requestId": rid("e3"), "kind": "bento"})
    assert r.status_code == 409
    assert r.json()["detail"] == "you have no Bentos left"

    tonic = post(client, ash, "eat", {"requestId": rid("e4"), "kind": "tonic"}).json()
    assert (tonic["restoreMins"], tonic["revives"], tonic["items"]["tonic"]) == (0, True, 0)
    assert [(row.kind, row.qty, row.coins) for row in await ledger(op="eat")] == \
        [("bento", 1, 0), ("bento", 1, 0), ("tonic", 1, 0)]
    assert post(client, ash, "eat", {"requestId": rid("e5"), "kind": "berry",
                                     "sessionId": "x"}).status_code == 422


async def test_give(client):
    ash_id, ash = await make_user("ash", 206)
    gary_id, _ = await make_user("gary", 207)
    misty_id, misty = await make_user("misty", 208)
    brock_id, _ = await make_user("brock", 209)
    await put(ash_id, coins=10, berry=3)

    r = give(client, ash, "gary", rid("g1"), coins=2, kind="berry", qty=1,
             note="  for your\x07 sleepy \n  Voltkit ")
    assert r.status_code == 200
    j = r.json()
    assert (j["op"], j["replayed"], j["toHandle"], j["deliveredLive"]) == ("give", False, "gary", 0)
    assert j["sent"] == {"coins": 2, "kind": "berry", "qty": 1}
    assert j["coins"] == 8 and j["items"]["berry"] == 2
    assert await held(gary_id) == {"coins": 2, "berry": 1}
    [row] = await ledger(op="give")
    assert (row.user_id, row.to_user_id, row.note) == (ash_id, gary_id, "for your sleepy Voltkit")

    # The same gift twice is one gift.
    again = give(client, ash, "gary", rid("g1"), coins=2, kind="berry", qty=1).json()
    assert again["replayed"] is True and again["deliveredLive"] == 0
    assert again["sent"] == {"coins": 2, "kind": "berry", "qty": 1}
    assert await held(gary_id) == {"coins": 2, "berry": 1}
    r = give(client, ash, "misty", rid("g1"), coins=2, kind="berry", qty=1)
    assert r.status_code == 409

    # Coins and food move together or not at all.
    await put(misty_id, coins=5)
    r = give(client, misty, "gary", rid("g2"), coins=2, kind="berry", qty=1)
    assert r.status_code == 409
    assert r.json()["detail"] == "not enough Berries (need 1, you have 0)"
    assert await held(misty_id) == {"coins": 5}
    assert await held(gary_id) == {"coins": 2, "berry": 1}

    r = give(client, ash, "ash", rid("g3"), coins=1)
    assert r.status_code == 400 and r.json()["detail"] == "you can't give to yourself"
    r = give(client, ash, "nobody", rid("g4"), coins=1)
    assert r.status_code == 404 and r.json()["detail"] == "no such person"
    await deactivate(brock_id)
    r = give(client, ash, "brock", rid("g5"), coins=1)
    assert r.status_code == 404 and r.json()["detail"] == "no such person"

    base = {"requestId": rid("g6"), "toHandle": "gary", "coins": 1}
    for bad in ({"kind": "berry"}, {"qty": 1}, {"coins": 0}, {"coins": 6}, {"coins": True},
                {"kind": "berry", "qty": 4}, {"kind": "pizza", "qty": 1},
                {"toHandle": "../x"}, {"note": "x" * 81}, {"sessionId": "s"}):
        assert post(client, ash, "give", {**base, **bad}).status_code == 422, bad
    assert await held(ash_id) == {"coins": 8, "berry": 2}


async def test_give_limits(client, clock):
    ash_id, ash = await make_user("ash", 210)
    for i, name in enumerate(("gary", "misty", "brock", "tracey")):
        await make_user(name, 211 + i)
    await put(ash_id, coins=30)

    n = 0

    def gift(to):
        nonlocal n
        n += 1
        return give(client, ash, to, rid(f"lim{n}"), coins=1)

    for _ in range(3):
        assert gift("gary").status_code == 200
    r = gift("gary")
    assert r.status_code == 429
    assert r.json()["detail"] == "you've already sent gary 3 gifts today"

    for to in ("misty", "misty", "misty", "brock", "brock"):
        assert gift(to).status_code == 200
    r = gift("tracey")
    assert r.status_code == 429
    assert r.json()["detail"] == "you've sent 8 gifts today, try again tomorrow"
    assert client.get("/v1/pantry", headers=auth(ash)).json()["limits"]["giftsLeftToday"] == 0

    # A new UTC day resets the giver's caps.
    clock.day += timedelta(days=1)
    assert gift("gary").status_code == 200

    # Recipient side: 15 coins a day from everyone combined...
    oak_id, _ = await make_user("oak", 220)
    givers, giver_ids = [], []
    for i in range(4):
        gid, tok = await make_user(f"giver{i}", 221 + i)
        await put(gid, coins=10, berry=5)
        givers.append(tok)
        giver_ids.append(gid)
    for i, tok in enumerate(givers[:3]):
        assert give(client, tok, "oak", rid(f"oak{i}"), coins=5).status_code == 200
    r = give(client, givers[3], "oak", rid("oak3"), coins=1)
    assert r.status_code == 409 and r.json()["detail"] == "oak can't receive that right now"

    # ...and 10 food units.
    for i, tok in enumerate(givers[:3]):
        assert give(client, tok, "oak", rid(f"oakf{i}"), kind="berry", qty=3).status_code == 200
    r = give(client, givers[3], "oak", rid("oakf3"), kind="berry", qty=2)
    assert r.status_code == 409 and r.json()["detail"] == "oak can't receive that right now"
    assert await held(oak_id) == {"coins": 15, "berry": 9}

    # A full purse gets the same generic refusal, which gives nothing away.
    may_id, _ = await make_user("may", 230)
    await put(may_id, coins=30)
    r = give(client, givers[3], "may", rid("may1"), coins=1)
    assert r.status_code == 409 and r.json()["detail"] == "may can't receive that right now"
    assert not any(ch.isdigit() for ch in r.text)
    # Every refusal rolled back the giver's side too.
    assert await held(may_id) == {"coins": 30}
    assert await held(giver_ids[3]) == {"coins": 10, "berry": 5}


async def test_give_refuses_the_sender_first(client):
    """A sender who can't pay hears that, whatever the recipient holds, or which
    409 comes back would read the recipient's balance for free. The ids pin the
    row order both ways round the recipient."""
    low_id, low = await make_user("low", 300, user_id="00000000-0000-4000-8000-000000000000")
    oak_id, _ = await make_user("oak", 301, user_id="77777777-7777-4777-8777-777777777777")
    high_id, high = await make_user("high", 302, user_id="ffffffff-ffff-4fff-8fff-ffffffffffff")
    rich_id, rich = await make_user("rich", 303)
    assert low_id < oak_id < high_id

    n = 0

    def probe(tok, **gift):
        nonlocal n
        n += 1
        return give(client, tok, "oak", rid(f"probe{n}"), **gift)

    def refused_as_broke(tok):
        for coins in range(1, 6):
            r = probe(tok, coins=coins)
            assert r.status_code == 409
            assert r.json()["detail"] == f"not enough Poke Coins (need {coins}, you have 0)"
        for qty in range(1, 4):
            r = probe(tok, kind="berry", qty=qty)
            assert r.status_code == 409
            assert r.json()["detail"] == f"not enough Berries (need {qty}, you have 0)"

    # A full purse and a full stack...
    await put(oak_id, coins=30, berry=10)
    for tok in (low, high):
        refused_as_broke(tok)

    # ...and today's receipts at the cap.
    await put(oak_id, coins=0, berry=0)
    await put(rich_id, coins=15)
    for i in range(3):
        assert give(client, rich, "oak", rid(f"rich{i}"), coins=5).status_code == 200
    for tok in (low, high):
        refused_as_broke(tok)

    # A sender who can pay still gets only the generic refusal, both ways round.
    await put(low_id, coins=5)
    await put(high_id, coins=5)
    for tok in (low, high):
        r = probe(tok, coins=1)
        assert r.status_code == 409 and r.json()["detail"] == "oak can't receive that right now"
    assert await held(low_id) == await held(high_id) == {"coins": 5}
    assert await held(oak_id) == {"coins": 15}
    assert [row.user_id for row in await ledger(op="give")] == [rich_id] * 3


async def test_gift_live_and_drain(client):
    ash_id, ash = await make_user("ash", 240)
    gary_id, gary = await make_user("gary", 241)
    await put(ash_id, coins=10, riceball=2)

    with client.websocket_connect(f"/v1/rooms/lobby/ws?ticket={issue_ws_ticket(gary_id)}") as g:
        g.receive_json()  # welcome
        r = give(client, ash, "gary", rid("live"), coins=2, kind="riceball", qty=1, note="hi")
        assert r.json()["deliveredLive"] == 1
        live = g.receive_json()
    assert live["type"] == "gift" and live["id"]
    assert live["from"] == {"userId": ash_id, "handle": "ash", "displayName": "Ash",
                            "avatarUrl": ""}
    assert (live["coins"], live["kind"], live["qty"], live["note"]) == (2, "riceball", 1, "hi")
    assert not _collect_keys(live) & {"url", "sessionId", "title", "command"}

    # Delivered live, so the poller has nothing to add.
    assert post(client, gary, "gifts/drain").json() == {"gifts": []}

    # Offline: the drain returns it exactly once.
    r = give(client, ash, "gary", rid("offline"), coins=1)
    assert r.json()["deliveredLive"] == 0
    [got] = post(client, gary, "gifts/drain").json()["gifts"]
    [row] = await ledger(request_id=rid("offline"))
    assert got["id"] == row.id
    assert {k: got[k] for k in ("fromHandle", "fromName", "coins", "kind", "qty", "note")} == \
        {"fromHandle": "ash", "fromName": "Ash", "coins": 1, "kind": None, "qty": 0, "note": ""}
    assert datetime.fromisoformat(got["at"]).tzinfo is not None
    assert post(client, gary, "gifts/drain").json() == {"gifts": []}

    # Both still show in the recipient's recent gifts, newest first; a GET
    # marks nothing.
    recent = client.get("/v1/pantry", headers=auth(gary)).json()["recentGifts"]
    assert [(g["coins"], g["kind"]) for g in recent] == [(1, None), (2, "riceball")]


async def test_gift_goes_one_way(client, monkeypatch):
    """A gift reaches the recipient live or through their drain, never both."""
    ash_id, ash = await make_user("ash", 320)
    gary_id, gary = await make_user("gary", 321)
    await put(ash_id, coins=10)
    real = pantry._deliver_live
    mid_send = []

    async def poller_lands_mid_send(to_id, payload):
        async with SessionLocal() as db:
            mid_send.append((await pantry.drain(db, await db.get(User, to_id))).gifts)
        return await real(to_id, payload)

    monkeypatch.setattr(pantry, "_deliver_live", poller_lands_mid_send)
    with client.websocket_connect(f"/v1/rooms/lobby/ws?ticket={issue_ws_ticket(gary_id)}") as g:
        g.receive_json()  # welcome
        assert give(client, ash, "gary", rid("race"), coins=1).json()["deliveredLive"] == 1
        assert g.receive_json()["type"] == "gift"
    # Their poller found nothing while the live send was in flight.
    assert mid_send == [[]]
    assert post(client, gary, "gifts/drain").json() == {"gifts": []}

    # In the lobby but no socket took it: the drain has it, exactly once.
    async def no_socket_took_it(to_id, payload):
        return 0

    monkeypatch.setattr(pantry, "_deliver_live", no_socket_took_it)
    with client.websocket_connect(f"/v1/rooms/lobby/ws?ticket={issue_ws_ticket(gary_id)}") as g:
        g.receive_json()
        assert give(client, ash, "gary", rid("lost"), coins=1).json()["deliveredLive"] == 0
    [got] = post(client, gary, "gifts/drain").json()["gifts"]
    [row] = await ledger(request_id=rid("lost"))
    assert got["id"] == row.id
    assert post(client, gary, "gifts/drain").json() == {"gifts": []}


async def test_give_replay_reports_delivery(client):
    """"Send again" after an unconfirmed send replays the same requestId. It
    must not call a gift that already landed "queued"."""
    ash_id, ash = await make_user("ash", 330)
    gary_id, gary = await make_user("gary", 331)
    await put(ash_id, coins=10)

    with client.websocket_connect(f"/v1/rooms/lobby/ws?ticket={issue_ws_ticket(gary_id)}") as g:
        g.receive_json()  # welcome
        assert give(client, ash, "gary", rid("live"), coins=1).json()["deliveredLive"] == 1
        g.receive_json()
    # Gary has left the lobby, so this reads the record; it sends nothing new.
    again = give(client, ash, "gary", rid("live"), coins=1).json()
    assert (again["replayed"], again["deliveredLive"]) == (True, 1)

    # Queued until their drain has it, and delivered after.
    assert give(client, ash, "gary", rid("queued"), coins=1).json()["deliveredLive"] == 0
    again = give(client, ash, "gary", rid("queued"), coins=1).json()
    assert (again["replayed"], again["deliveredLive"]) == (True, 0)
    assert len(post(client, gary, "gifts/drain").json()["gifts"]) == 1
    again = give(client, ash, "gary", rid("queued"), coins=1).json()
    assert (again["replayed"], again["deliveredLive"]) == (True, 1)
    assert await held(gary_id) == {"coins": 2}


async def test_drain_oldest_first_and_limited(client, monkeypatch):
    ash_id, ash = await make_user("ash", 250)
    for i in range(3):
        await make_user(f"f{i}", 251 + i)
    gary_id, gary = await make_user("gary", 255)
    await put(ash_id, coins=10)
    for i in range(3):
        assert give(client, ash, "gary", rid(f"d{i}"), coins=1, note=str(i)).status_code == 200
    monkeypatch.setattr(pantry, "DRAIN_LIMIT", 2)
    assert [g["note"] for g in post(client, gary, "gifts/drain").json()["gifts"]] == ["0", "1"]
    assert [g["note"] for g in post(client, gary, "gifts/drain").json()["gifts"]] == ["2"]


async def test_ops_cap(client, monkeypatch):
    uid, ash = await make_user("ash", 260)
    await put(uid, coins=30)
    monkeypatch.setattr(pantry, "MAX_OPS_PER_DAY", 2)
    assert buy(client, ash, "berry", r=rid("o1")).status_code == 200
    assert buy(client, ash, "berry", r=rid("o2")).status_code == 200
    r = buy(client, ash, "berry", r=rid("o3"))
    assert r.status_code == 429
    assert r.json()["detail"] == "that's a lot of pantry activity for one day, try again tomorrow"
    assert (await held(uid))["coins"] == 28


async def test_concurrency():
    """Separate sessions racing through the real service, each committing: the
    journal INSERT takes the write lock, so writers serialize on busy_timeout."""
    uid, _ = await make_user("ash", 270)
    await put(uid, coins=8)

    async def attempt(r):
        async with SessionLocal() as db:
            user = await db.get(User, uid)
            try:
                return await pantry.buy(db, user, BuyRequest(requestId=r, kind="bento", qty=1))
            except HTTPException as e:
                return e

    results = await asyncio.gather(*(attempt(rid(f"c{i}")) for i in range(6)))
    ok = [r for r in results if not isinstance(r, HTTPException)]
    refused = [r for r in results if isinstance(r, HTTPException)]
    assert len(ok) == 2
    assert {r.status_code for r in refused} == {409}
    assert await held(uid) == {"coins": 2, "bento": 2}
    assert len(await ledger(op="buy")) == 2

    # The same request id four times at once: one debit, three replays.
    await put(uid, coins=8, bento=0)
    results = await asyncio.gather(*(attempt(rid("same")) for _ in range(4)))
    assert not any(isinstance(r, HTTPException) for r in results)
    assert sorted(r.replayed for r in results) == [False, True, True, True]
    assert len(await ledger(request_id=rid("same"))) == 1
    assert await held(uid) == {"coins": 5, "bento": 1}


async def test_check_constraint():
    uid, _ = await make_user("ash", 280)
    await put(uid, coins=1)
    async with SessionLocal() as db:
        with pytest.raises(IntegrityError):
            await db.execute(text("UPDATE poke_balances SET qty = -1"))
        await db.rollback()
    for bad in ("op = 'steal'", "coins = -1", "qty = -1"):
        async with SessionLocal() as db:
            db.add(PokeLedger(user_id=uid, request_id=rid("chk"), op="buy",
                              op_date=date(2026, 9, 28), kind="berry", qty=1, coins=1,
                              note="", created_at=datetime.now(UTC)))
            await db.commit()
            with pytest.raises(IntegrityError):
                await db.execute(text(f"UPDATE poke_ledger SET {bad}"))
            await db.rollback()
            await db.execute(text("DELETE FROM poke_ledger"))
            await db.commit()


def test_schema_limits_mirror_pantry():
    """app/schemas.py spells the limits as literals; they must track pantry.py."""
    from typing import get_args

    from pydantic import ValidationError

    from app.schemas import FoodKind, GiveRequest

    assert get_args(FoodKind) == tuple(pantry.CATALOG)
    r = rid("lim")
    BuyRequest(requestId=r, kind="berry", qty=pantry.BUY_MAX_QTY)
    GiveRequest(requestId=r, toHandle="gary", coins=pantry.GIFT_MAX_COINS,
                kind="berry", qty=pantry.GIFT_MAX_QTY, note="x" * 80)
    for bad in (lambda: BuyRequest(requestId=r, kind="berry", qty=pantry.BUY_MAX_QTY + 1),
                lambda: GiveRequest(requestId=r, toHandle="gary",
                                    coins=pantry.GIFT_MAX_COINS + 1),
                lambda: GiveRequest(requestId=r, toHandle="gary", kind="berry",
                                    qty=pantry.GIFT_MAX_QTY + 1)):
        with pytest.raises(ValidationError):
            bad()


async def test_all_require_auth(client):
    assert client.get("/v1/pantry").status_code == 401
    for path in ("claim", "buy", "eat", "give", "gifts/drain"):
        assert client.post(f"/v1/pantry/{path}", json={}).status_code == 401, path
    assert client.post("/v1/pantry/claim", json={},
                       headers=auth("hqd_not-a-token")).status_code == 401


async def test_no_forbidden_keys(client):
    ash_id, ash = await make_user("ash", 290)
    gary_id, gary = await make_user("gary", 291)
    await put(ash_id, coins=10, berry=2)

    bodies = [client.get("/v1/pantry", headers=auth(ash)).json(),
              post(client, ash, "claim").json(),
              buy(client, ash, "berry", r=rid("f1")).json(),
              post(client, ash, "eat", {"requestId": rid("f2"), "kind": "berry"}).json()]
    with client.websocket_connect(f"/v1/rooms/lobby/ws?ticket={issue_ws_ticket(gary_id)}") as g:
        g.receive_json()
        bodies.append(give(client, ash, "gary", rid("f3"), coins=1, kind="berry", qty=1,
                           note="snack").json())
        bodies.append(g.receive_json())
    give(client, ash, "gary", rid("f4"), coins=1)
    bodies.append(post(client, gary, "gifts/drain").json())
    bodies.append(client.get("/v1/pantry", headers=auth(gary)).json())

    assert all(isinstance(b, dict) and "detail" not in b for b in bodies)
    leaked = _collect_keys(bodies) & FORBIDDEN_KEYS
    assert leaked == set(), leaked


# --- seasons and the daily special ------------------------------------------------

def test_season_of_boundaries():
    cases = {
        date(2027, 1, 1): "winter", date(2027, 2, 28): "winter", date(2027, 3, 1): "spring",
        date(2026, 5, 31): "spring", date(2026, 6, 1): "summer", date(2026, 8, 31): "summer",
        date(2026, 9, 1): "fall", date(2026, 11, 30): "fall", date(2026, 12, 1): "winter",
    }
    for day, season in cases.items():
        assert pantry.season_of(day) == season, day


def test_special_is_deterministic_and_in_stock():
    start, seen = date(2026, 1, 1), set()
    for i in range(400):
        day = start + timedelta(days=i)
        special = pantry.special_of(day)
        assert special == pantry.special_of(day)
        assert pantry.in_stock(special, day)
        base = pantry.CATALOG[special]["price"]
        assert base >= pantry.SPECIAL_MIN_PRICE
        assert pantry.price_of(special, day) == base - pantry.SPECIAL_DISCOUNT >= 1
        others = [k for k in pantry.CATALOG if k != special]
        assert all(pantry.price_of(k, day) == pantry.CATALOG[k]["price"] for k in others)
        seen.add(special)
    assert len(seen) >= 8   # it really rotates, and seasonal food takes its turn
    assert seen & {"dango", "omelette", "shavedice", "curry", "sweetpotato", "pumpkinstew",
                   "cocoa", "oden"}


async def test_catalog_flags(client, clock):
    _, ash = await make_user("ash", 340)
    j = client.get("/v1/pantry", headers=auth(ash)).json()
    by = {c["kind"]: c for c in j["catalog"]}
    for kind, c in by.items():
        assert c["inStock"] is (c["season"] == "all" or kind in FALL), kind
        assert c["special"] is (kind == "hotpot"), kind
        assert c["price"] == c["basePrice"] - (1 if kind == "hotpot" else 0), kind
    assert (by["hotpot"]["basePrice"], by["hotpot"]["price"]) == (4, 3)
    assert by["strawberry"]["season"] == "spring" and by["strawberry"]["inStock"] is False

    clock.day = date(2026, 12, 1)   # winter, the Hot Cocoa's day
    j = client.get("/v1/pantry", headers=auth(ash)).json()
    assert (j["season"], j["special"]) == ("winter", "cocoa")
    stocked = {c["kind"] for c in j["catalog"] if c["inStock"]}
    assert stocked & {"chestnuts", "cocoa", "oden"} == {"chestnuts", "cocoa", "oden"}
    assert not stocked & FALL


async def test_out_of_season_buy_is_refused(client):
    uid, ash = await make_user("ash", 341)
    await put(uid, coins=10)
    r = buy(client, ash, "strawberry", r=rid("oos"))
    assert r.status_code == 409
    assert r.json()["detail"] == "Strawberries are out of season"
    assert await held(uid) == {"coins": 10}
    assert await row_count(PokeLedger) == 0
    # In season it sells, at its base price.
    j = buy(client, ash, "apple", qty=2, r=rid("ins")).json()
    assert (j["spent"], j["coins"], j["items"]["apple"]) == (2, 8, 2)


async def test_off_season_food_is_still_eaten_and_given(client, clock):
    ash_id, ash = await make_user("ash", 342)
    await make_user("gary", 343)
    await put(ash_id, strawberry=3)
    r = post(client, ash, "eat", {"requestId": rid("s1"), "kind": "strawberry"})
    assert r.status_code == 200 and r.json()["restoreMins"] == 25
    r = give(client, ash, "gary", rid("s2"), kind="strawberry", qty=1)
    assert r.status_code == 200 and r.json()["items"]["strawberry"] == 1


async def test_special_price_is_charged(client):
    uid, ash = await make_user("ash", 344)
    await put(uid, coins=10)
    j = buy(client, ash, "hotpot", qty=2, r=rid("sp")).json()
    assert (j["spent"], j["coins"], j["items"]["hotpot"]) == (6, 4, 2)
    [row] = await ledger(op="buy")
    assert (row.kind, row.qty, row.coins, row.op_date) == ("hotpot", 2, 6, date(2026, 9, 28))


async def test_buy_replays_across_midnight(client, clock):
    uid, ash = await make_user("ash", 345)
    await put(uid, coins=20)
    body = {"requestId": rid("mid"), "kind": "hotpot", "qty": 1}
    first = post(client, ash, "buy", body).json()
    assert (first["spent"], first["coins"]) == (3, 17)   # the special's price

    clock.day = date(2026, 9, 29)   # a new special: the Hot Pot is back to 4
    again = post(client, ash, "buy", body)
    assert again.status_code == 200
    j = again.json()
    assert (j["replayed"], j["spent"], j["coins"], j["items"]["hotpot"]) == (True, 3, 17, 1)
    assert j["special"] == "pumpkinstew"
    new = buy(client, ash, "hotpot", r=rid("mid2")).json()
    assert (new["replayed"], new["spent"], new["coins"]) == (False, 4, 13)

    # A buy that committed in its season replays after the season has turned.
    clock.day = date(2026, 11, 30)
    late = {"requestId": rid("apple"), "kind": "apple", "qty": 1}
    assert post(client, ash, "buy", late).json()["replayed"] is False
    clock.day = date(2026, 12, 1)
    r = post(client, ash, "buy", late)
    assert r.status_code == 200 and r.json()["replayed"] is True
    r = buy(client, ash, "apple", r=rid("apple2"))
    assert (r.status_code, r.json()["detail"]) == (409, "Apples are out of season")


async def test_unknown_kind_is_422(client):
    uid, ash = await make_user("ash", 346)
    await make_user("gary", 347)
    await put(uid, coins=10)
    assert buy(client, ash, "pizza", r=rid("u1")).status_code == 422
    assert post(client, ash, "eat", {"requestId": rid("u2"), "kind": "pizza"}).status_code == 422
    assert give(client, ash, "gary", rid("u3"), kind="pizza", qty=1).status_code == 422
