"""Taco Tuesdays: the pooled buy-1-get-1 math, the order log and the board."""
from datetime import UTC, date, datetime, time, timedelta

import pytest

from app import tacos
from tests.conftest import auth, make_user

RID = "cali-2026-09-29-dinner"
RID2 = "cali-2026-10-06-dinner"


class Clock:
    """Stands in for tacos._today/_now, so "this Tuesday" is fixed and ledger
    rows have a stable order."""

    def __init__(self) -> None:
        self.day = date(2026, 9, 29)  # a Tuesday
        self.ticks = 0

    def today(self) -> date:
        return self.day

    def now(self) -> datetime:
        self.ticks += 1
        return (datetime.combine(self.day, time(19, 30, 0, 123456), tzinfo=UTC)
                + timedelta(seconds=self.ticks))


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    c = Clock()
    monkeypatch.setattr(tacos, "_today", c.today)
    monkeypatch.setattr(tacos, "_now", c.now)
    return c


def counts(mh=0, ms=0, wh=0, ws=0) -> dict:
    return {"mildHard": mh, "mildSoft": ms, "wildHard": wh, "wildSoft": ws}


def order_body(diners, rid=RID, **kw) -> dict:
    return {"requestId": rid, "diners": diners, **kw}


# --- the deal ---------------------------------------------------------------

class TestPaidTacos:
    """paid = ceil(TT / 2), pooled across the table."""

    @pytest.mark.parametrize("total,paid", [
        (0, 0), (1, 1), (2, 1), (3, 2), (4, 2), (5, 3), (8, 4), (9, 5), (100, 50),
    ])
    def test_pairs_every_second_taco(self, total, paid):
        assert tacos.paid_tacos(total) == paid

    def test_two_odd_diners_pay_as_one_even_table(self):
        """The whole reason orders are logged per table: 3 + 3 pays 3, but two
        separate 3-taco orders would pay 2 + 2 = 4."""
        assert tacos.paid_tacos(3 + 3) == 3
        assert tacos.paid_tacos(3) + tacos.paid_tacos(3) == 4


# --- logging an order --------------------------------------------------------

async def test_logs_an_order_and_prices_it(client):
    _, token = await make_user("ana", 1)
    body = order_body([
        {"handle": "ana", "tacos": counts(mh=3)},
        {"name": "Bo", "tacos": counts(ms=2, wh=2, ws=1)},
    ])
    r = client.post("/v1/cali/orders", json=body, headers=auth(token))
    assert r.status_code == 200, r.text

    o = r.json()["order"]
    assert r.json()["replayed"] is False
    assert o["totalTacos"] == 8
    assert o["paidTacos"] == 4      # ceil(8 / 2)
    assert o["freeTacos"] == 4
    assert o["people"] == 2
    assert o["tacosPerPerson"] == 4.0
    assert o["date"] == "2026-09-29"
    assert [d["name"] for d in o["diners"]] == ["Ana", "Bo"]
    assert o["diners"][0]["handle"] == "ana"
    assert o["diners"][1]["handle"] is None


async def test_odd_per_person_even_table_pays_half(client):
    _, token = await make_user("ana", 1)
    r = client.post("/v1/cali/orders", json=order_body([
        {"name": "Ana", "tacos": counts(mh=3)},
        {"name": "Bo", "tacos": counts(ws=3)},
    ]), headers=auth(token))
    o = r.json()["order"]
    assert (o["totalTacos"], o["paidTacos"], o["freeTacos"]) == (6, 3, 3)


async def test_odd_table_pays_for_the_odd_one_out(client):
    _, token = await make_user("ana", 1)
    r = client.post("/v1/cali/orders", json=order_body([
        {"name": "Ana", "tacos": counts(mh=3)},
        {"name": "Bo", "tacos": counts(ws=2)},
    ]), headers=auth(token))
    o = r.json()["order"]
    assert (o["totalTacos"], o["paidTacos"], o["freeTacos"]) == (5, 3, 2)
    assert o["tacosPerPerson"] == 2.5


async def test_replay_is_idempotent(client):
    _, token = await make_user("ana", 1)
    body = order_body([{"handle": "ana", "tacos": counts(mh=2)}])
    first = client.post("/v1/cali/orders", json=body, headers=auth(token))
    again = client.post("/v1/cali/orders", json=body, headers=auth(token))

    assert first.json()["replayed"] is False
    assert again.json()["replayed"] is True
    assert again.json()["order"]["id"] == first.json()["order"]["id"]
    assert len(client.get("/v1/cali/orders", headers=auth(token)).json()["orders"]) == 1


async def test_unknown_handle_rejects_the_whole_order(client):
    _, token = await make_user("ana", 1)
    r = client.post("/v1/cali/orders", json=order_body([
        {"handle": "ana", "tacos": counts(mh=1)},
        {"handle": "ghost", "tacos": counts(ws=1)},
    ]), headers=auth(token))
    assert r.status_code == 404
    assert len(client.get("/v1/cali/orders", headers=auth(token)).json()["orders"]) == 0


async def test_future_dinner_rejected(client):
    _, token = await make_user("ana", 1)
    r = client.post("/v1/cali/orders", json=order_body(
        [{"name": "Ana", "tacos": counts(mh=1)}], date="2026-10-06",
    ), headers=auth(token))
    assert r.status_code == 400


async def test_duplicate_diner_rejected(client):
    _, token = await make_user("ana", 1)
    r = client.post("/v1/cali/orders", json=order_body([
        {"handle": "ana", "tacos": counts(mh=1)},
        {"handle": "ana", "tacos": counts(ws=1)},
    ]), headers=auth(token))
    assert r.status_code == 422


async def test_stray_field_is_rejected(client):
    """extra="forbid": a client cannot start smuggling a field through."""
    _, token = await make_user("ana", 1)
    body = order_body([{"name": "Ana", "tacos": counts(mh=1)}])
    body["sessionId"] = "11111111-1111-4111-8111-111111111111"
    assert client.post("/v1/cali/orders", json=body, headers=auth(token)).status_code == 422


async def test_counts_must_be_real_ints(client):
    _, token = await make_user("ana", 1)
    r = client.post("/v1/cali/orders", json=order_body(
        [{"name": "Ana", "tacos": {"mildHard": "3"}}],
    ), headers=auth(token))
    assert r.status_code == 422


async def test_auth_required(client):
    assert client.get("/v1/cali/board").status_code == 401
    assert client.post("/v1/cali/orders", json=order_body(
        [{"name": "Ana", "tacos": counts(mh=1)}])).status_code == 401


# --- the board ---------------------------------------------------------------

async def test_board_ranks_by_tuesdays_then_tacos(client, clock):
    _, token = await make_user("ana", 1)

    # Week 1: Ana and Bo. Cam eats a mountain but only comes once.
    client.post("/v1/cali/orders", json=order_body([
        {"handle": "ana", "tacos": counts(mh=2)},
        {"name": "Bo", "tacos": counts(ws=1)},
        {"name": "Cam", "tacos": counts(mh=9)},
    ], rid=RID), headers=auth(token))

    # Week 2: Ana and Bo again; Bo out-eats Ana.
    clock.day = date(2026, 10, 6)
    client.post("/v1/cali/orders", json=order_body([
        {"handle": "ana", "tacos": counts(ms=1)},
        {"name": "Bo", "tacos": counts(wh=4)},
    ], rid=RID2), headers=auth(token))

    board = client.get("/v1/cali/board?window=all", headers=auth(token)).json()

    assert [(e["name"], e["tuesdays"], e["totalTacos"]) for e in board["entries"]] == [
        ("Bo", 2, 5),    # 2 Tuesdays, more tacos than Ana
        ("Ana", 2, 3),
        ("Cam", 1, 9),   # 9 tacos still loses to showing up twice
    ]
    assert [e["rank"] for e in board["entries"]] == [1, 2, 3]


async def test_board_reports_tpp_and_the_table_totals(client, clock):
    _, token = await make_user("ana", 1)
    client.post("/v1/cali/orders", json=order_body([
        {"handle": "ana", "tacos": counts(mh=3)},
        {"name": "Bo", "tacos": counts(ws=2)},
    ], rid=RID), headers=auth(token))
    clock.day = date(2026, 10, 6)
    client.post("/v1/cali/orders", json=order_body([
        {"handle": "ana", "tacos": counts(mh=2)},
    ], rid=RID2), headers=auth(token))

    board = client.get("/v1/cali/board?window=all", headers=auth(token)).json()
    ana = next(e for e in board["entries"] if e["handle"] == "ana")

    assert ana["totalTacos"] == 5
    assert ana["tuesdays"] == 2
    assert ana["tacosPerPerson"] == 2.5   # 5 tacos / 2 Tuesdays
    assert ana["isYou"] is True

    # Priced per order (3 + 2 -> 3 paid; 2 -> 1 paid), never over the sum.
    assert board["orders"] == 2
    assert (board["totalTacos"], board["paidTacos"], board["freeTacos"]) == (7, 4, 3)


async def test_board_counts_one_tuesday_once(client):
    """Two orders on the same night is still one Tuesday attended."""
    _, token = await make_user("ana", 1)
    for rid in ("cali-first-round-0001", "cali-second-round-002"):
        client.post("/v1/cali/orders", json=order_body(
            [{"handle": "ana", "tacos": counts(mh=2)}], rid=rid,
        ), headers=auth(token))

    ana = client.get("/v1/cali/board?window=all", headers=auth(token)).json()["entries"][0]
    assert ana["tuesdays"] == 1
    assert ana["totalTacos"] == 4


async def test_board_splits_mild_wild_and_hard_soft(client):
    _, token = await make_user("ana", 1)
    client.post("/v1/cali/orders", json=order_body([
        {"handle": "ana", "tacos": counts(mh=1, ms=2, wh=3, ws=4)},
    ]), headers=auth(token))

    ana = client.get("/v1/cali/board?window=all", headers=auth(token)).json()["entries"][0]
    assert (ana["mild"], ana["wild"]) == (3, 7)
    assert (ana["hard"], ana["soft"]) == (4, 6)
    assert ana["mild"] + ana["wild"] == ana["hard"] + ana["soft"] == ana["totalTacos"]


async def test_board_names_are_matched_case_insensitively(client, clock):
    _, token = await make_user("ana", 1)
    client.post("/v1/cali/orders", json=order_body(
        [{"name": "Bo", "tacos": counts(mh=1)}], rid=RID,
    ), headers=auth(token))
    clock.day = date(2026, 10, 6)
    client.post("/v1/cali/orders", json=order_body(
        [{"name": "bo", "tacos": counts(mh=1)}], rid=RID2,
    ), headers=auth(token))

    entries = client.get("/v1/cali/board?window=all", headers=auth(token)).json()["entries"]
    assert len(entries) == 1
    assert entries[0]["tuesdays"] == 2


async def test_board_window_excludes_older_dinners(client, clock):
    _, token = await make_user("ana", 1)
    clock.day = date(2026, 8, 4)
    client.post("/v1/cali/orders", json=order_body(
        [{"handle": "ana", "tacos": counts(mh=2)}], rid=RID,
    ), headers=auth(token))
    clock.day = date(2026, 9, 29)

    assert client.get("/v1/cali/board?window=7d", headers=auth(token)).json()["entries"] == []
    assert len(client.get("/v1/cali/board?window=all", headers=auth(token)).json()["entries"]) == 1


async def test_board_rejects_unknown_window(client):
    _, token = await make_user("ana", 1)
    assert client.get("/v1/cali/board?window=forever", headers=auth(token)).status_code == 400


async def test_board_is_shared_across_founders(client):
    """One table, one board: Bo sees the dinner Ana logged, flagged as theirs."""
    _, ana_token = await make_user("ana", 1)
    _, bo_token = await make_user("bo", 2)
    client.post("/v1/cali/orders", json=order_body([
        {"handle": "ana", "tacos": counts(mh=1)},
        {"handle": "bo", "tacos": counts(ws=1)},
    ]), headers=auth(ana_token))

    board = client.get("/v1/cali/board?window=all", headers=auth(bo_token)).json()
    you = [e["handle"] for e in board["entries"] if e["isYou"]]
    assert you == ["bo"]
