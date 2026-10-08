"""HQ 2.1: visit and customise HQs. Counts and cosmetics only; closed by default;
the level is scored on the server; a visitor can only see an HQ its owner opened."""
from tests.conftest import auth, make_user

FORBIDDEN_KEYS = {"prompt", "reply", "text", "content", "path", "paths", "cwd", "folder", "project",
                  "projectName", "sessionId", "sessionTitle", "title", "file", "files"}


def walk(o):
    if isinstance(o, dict):
        for k, v in o.items():
            yield k
            yield from walk(v)
    elif isinstance(o, list):
        for v in o:
            yield from walk(v)


async def test_closed_by_default_and_visits_respect_it(client):
    a, ta = await make_user("ann", 1)
    b, tb = await make_user("bob", 2)
    me = client.get("/v1/hq/me", headers=auth(ta)).json()
    assert me["open"] is False and me["isYou"] and me["level"] == 1
    assert client.get(f"/v1/hq/{a}", headers=auth(tb)).status_code == 404       # not open yet
    assert client.get("/v1/hq/open", headers=auth(tb)).json()["hqs"] == []
    r = client.put("/v1/hq/me", headers=auth(ta), json={"open": True, "look": {"paint": "#224466", "sign": "Ann's  HQ"},
                                                          "crew": {"working": 3, "needs": 1, "idle": 2}})
    assert r.status_code == 200 and r.json()["look"] == {"paint": "#224466", "accent": None, "sign": "Ann's HQ"}
    seen = client.get(f"/v1/hq/{a}", headers=auth(tb)).json()
    assert seen["crew"] == {"working": 3, "needs": 1, "idle": 2} and seen["isYou"] is False and seen["handle"] == "ann"
    assert [h["handle"] for h in client.get("/v1/hq/open", headers=auth(tb)).json()["hqs"]] == ["ann"]
    assert not FORBIDDEN_KEYS & set(walk(seen))
    client.put("/v1/hq/me", headers=auth(ta), json={"open": False})
    assert client.get(f"/v1/hq/{a}", headers=auth(tb)).status_code == 404
    assert client.get(f"/v1/hq/{a}", headers=auth(ta)).status_code == 200       # your own, always


async def test_privacy_boundary_rejects_anything_else(client):
    _a, ta = await make_user("ann", 1)
    for bad in ({"open": True, "title": "my secret project"},
                {"look": {"paint": "#224466", "cwd": "/Users/me"}},
                {"crew": {"working": 1, "sessionId": "abc"}},
                {"crew": {"working": 500}},
                {"look": {"paint": "red"}},
                {"look": {"sign": "<script>"}},
                {"look": {"sign": "x" * 19}}):
        assert client.put("/v1/hq/me", headers=auth(ta), json=bad).status_code == 422, bad
    assert client.get("/v1/hq/me").status_code == 401


async def test_level_is_scored_on_the_server(client):
    a, ta = await make_user("ann", 1)
    from tests.test_stats import TODAY, day, payload
    assert client.post("/v1/stats", headers=auth(ta), json=payload(day(TODAY, prompts=400, tools=900, artifacts=20))).status_code == 200
    lvl = client.get("/v1/hq/me", headers=auth(ta)).json()["level"]
    assert lvl > 1
    # a client cannot send a level
    assert client.put("/v1/hq/me", headers=auth(ta), json={"level": 99}).status_code == 422


async def test_server_stats_for_settings(client):
    _a, ta = await make_user("ann", 1)
    assert client.get("/v1/server/stats").status_code == 401
    s = client.get("/v1/server/stats", headers=auth(ta)).json()
    assert s["impl"] == "py" and s["rssMb"] > 0 and s["uptimeSecs"] >= 0 and s["gameLoopsMax"] >= 1
    assert {"rooms", "online", "gameLoops", "overruns", "db", "cpuPct"} <= set(s)
