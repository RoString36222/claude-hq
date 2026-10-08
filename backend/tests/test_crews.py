"""HQ 2.1 crews: create, invite code, join, leave (owner hand-over, last one out
closes it), the crew board, and the tag on profiles."""
from tests.conftest import auth, make_user


async def test_crew_lifecycle(client):
    a, ta = await make_user("ann", 1)
    b, tb = await make_user("bob", 2)
    c, tc = await make_user("cat", 3)
    r = client.post("/v1/crews/create", headers=auth(ta), json={"name": "Night  Owls", "tag": "owl", "color": "#9b8cf0"})
    crew = r.json()["crew"]
    assert crew["name"] == "Night Owls" and crew["tag"] == "OWL" and len(crew["code"]) == 8 and crew["members"][0]["owner"]
    assert client.post("/v1/crews/create", headers=auth(ta), json={"name": "Again", "tag": "AG", "color": "#ffffff"}).status_code == 409
    assert client.post("/v1/crews/create", headers=auth(tb), json={"name": "night owls", "tag": "NO", "color": "#ffffff"}).status_code == 409
    for bad in ({"name": "x", "tag": "AB", "color": "#ffffff"}, {"name": "Good", "tag": "a b", "color": "#ffffff"},
                {"name": "Good", "tag": "AB", "color": "red"}, {"name": "<b>", "tag": "AB", "color": "#ffffff"}):
        assert client.post("/v1/crews/create", headers=auth(tb), json=bad).status_code in (400, 422), bad
    assert client.post("/v1/crews/join", headers=auth(tb), json={"code": "ZZZZZZZZ"}).status_code == 404
    j = client.post("/v1/crews/join", headers=auth(tb), json={"code": crew["code"].lower()}).json()["crew"]
    assert [m["handle"] for m in j["members"]] == ["ann", "bob"]
    board = client.get("/v1/crews", headers=auth(tc)).json()["crews"]
    assert board[0]["name"] == "Night Owls" and "code" not in board[0] and board[0]["isMine"] is False
    assert client.get(f"/v1/profile/{b}", headers=auth(tc)).json()["crew"] == {"tag": "OWL", "color": "#9b8cf0", "name": "Night Owls"}
    client.post("/v1/crews/leave", headers=auth(ta))                       # the owner leaves: bob takes over
    mine = client.get("/v1/crews/mine", headers=auth(tb)).json()["crew"]
    assert [m["handle"] for m in mine["members"]] == ["bob"] and mine["members"][0]["owner"]
    client.post("/v1/crews/leave", headers=auth(tb))                       # the last one out closes it
    assert client.get("/v1/crews", headers=auth(tc)).json()["crews"] == []
    assert client.get("/v1/crews/mine", headers=auth(ta)).json()["crew"] is None
