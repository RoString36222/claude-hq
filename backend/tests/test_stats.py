from datetime import UTC, date, datetime, timedelta

from app.scoring import xp_from_counts
from tests.conftest import auth, make_user

TODAY = datetime.now(UTC).date()


def day(d: date, prompts=0, tools=0, artifacts=0, **kw):
    return {"date": d.isoformat(), "prompts": prompts, "tools": tools,
            "artifacts": artifacts, **kw}


def payload(*days, trainer="Ash"):
    return {"schemaVersion": 1, "trainerName": trainer, "days": list(days)}


async def test_ingest_then_board_uses_server_derived_xp(client):
    _, token = await make_user("ash", 10)
    res = client.post("/v1/stats", headers=auth(token),
                      json=payload(day(TODAY, prompts=10, tools=30, artifacts=1)))
    assert res.status_code == 200
    assert res.json() == {"accepted": 1, "rejected": 0, "notes": []}

    board = client.get("/v1/board", headers=auth(token)).json()
    entry = board["entries"][0]
    assert entry["handle"] == "ash"
    assert entry["xp"] == xp_from_counts(10, 30, 1) == 230
    assert entry["isYou"] is True
    assert entry["trainerName"] == "Ash"


async def test_resubmitting_a_day_replaces_rather_than_accumulates(client):
    """The client rescans whole transcripts, so a day's counts are authoritative."""
    _, token = await make_user("misty", 11)
    client.post("/v1/stats", headers=auth(token), json=payload(day(TODAY, prompts=10)))
    client.post("/v1/stats", headers=auth(token), json=payload(day(TODAY, prompts=14)))

    board = client.get("/v1/board", headers=auth(token)).json()
    assert board["entries"][0]["prompts"] == 14  # not 24


async def test_board_ranks_by_xp_descending(client):
    _, a = await make_user("ash", 12)
    _, b = await make_user("gary", 13)
    client.post("/v1/stats", headers=auth(a), json=payload(day(TODAY, prompts=5)))
    client.post("/v1/stats", headers=auth(b), json=payload(day(TODAY, prompts=50)))

    entries = client.get("/v1/board", headers=auth(a)).json()["entries"]
    assert [e["handle"] for e in entries] == ["gary", "ash"]
    assert [e["rank"] for e in entries] == [1, 2]
    assert entries[1]["isYou"] is True


async def test_client_cannot_submit_its_own_score(client):
    """There is no xp field on the wire; scoring is the server's job alone."""
    _, token = await make_user("cheater", 14)
    res = client.post("/v1/stats", headers=auth(token),
                      json={"schemaVersion": 1, "days": [], "xp": 999999})
    assert res.status_code == 422


async def test_unknown_fields_are_refused_so_they_cannot_leak(client):
    """A client that grows a field must have it added here deliberately."""
    _, token = await make_user("leaky", 15)
    res = client.post("/v1/stats", headers=auth(token), json={
        "schemaVersion": 1, "days": [],
        "folderLeaderboard": [{"folder": "/Users/me/acme-unreleased"}],
    })
    assert res.status_code == 422
    assert "folderLeaderboard" in res.text


async def test_mcp_tool_names_are_bucketed_not_stored(client):
    """`mcp__<server>__<tool>` can carry an employer or client name."""
    _, token = await make_user("mcpuser", 16)
    client.post("/v1/stats", headers=auth(token), json=payload(
        day(TODAY, tools=8, toolBreakdown=[
            {"name": "Bash", "count": 5},
            {"name": "mcp__acme_internal__query", "count": 3},
        ])
    ))
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import DailyToolStat
    async with SessionLocal() as db:
        names = set((await db.execute(select(DailyToolStat.tool_name))).scalars())
    assert names == {"Bash", "Other"}


async def test_future_and_absurd_days_are_clamped(client):
    _, token = await make_user("clamp", 17)
    res = client.post("/v1/stats", headers=auth(token), json=payload(
        day(TODAY + timedelta(days=2), prompts=5),
        day(TODAY, prompts=999_999),
        day(TODAY - timedelta(days=1), prompts=7),
    ))
    body = res.json()
    assert body["accepted"] == 1
    assert body["rejected"] == 2
    assert any("future" in n for n in body["notes"])

    board = client.get("/v1/board", headers=auth(token)).json()
    assert board["entries"][0]["prompts"] == 7


async def test_window_narrows_the_range(client):
    _, token = await make_user("windowed", 18)
    client.post("/v1/stats", headers=auth(token), json=payload(
        day(TODAY, prompts=1),
        day(TODAY - timedelta(days=20), prompts=100),
    ))
    week = client.get("/v1/board?window=7d", headers=auth(token)).json()
    month = client.get("/v1/board?window=30d", headers=auth(token)).json()
    assert week["entries"][0]["prompts"] == 1
    assert month["entries"][0]["prompts"] == 101


async def test_cost_is_absent_unless_shared(client):
    _, quiet = await make_user("quiet", 19)
    _, open_ = await make_user("sharer", 20)
    client.post("/v1/stats", headers=auth(quiet), json=payload(day(TODAY, prompts=1)))
    client.post("/v1/stats", headers=auth(open_),
                json=payload(day(TODAY, prompts=1, costUSD=4.20)))

    by_handle = {e["handle"]: e for e in
                 client.get("/v1/board", headers=auth(quiet)).json()["entries"]}
    assert by_handle["quiet"]["costUSD"] is None
    assert by_handle["sharer"]["costUSD"] == 4.20


async def test_streak_counts_consecutive_active_days(client):
    _, token = await make_user("streaky", 21)
    client.post("/v1/stats", headers=auth(token), json=payload(
        *[day(TODAY - timedelta(days=i), prompts=3) for i in range(4)]
    ))
    assert client.get("/v1/board", headers=auth(token)).json()["entries"][0]["streak"] == 4


async def test_bad_window_is_rejected(client):
    _, token = await make_user("badwin", 22)
    assert client.get("/v1/board?window=forever", headers=auth(token)).status_code == 400
