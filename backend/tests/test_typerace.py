"""Code Typing Race (HQ 2.1): server-picked snippet, countdown, forward-only and
speed-capped progress, results with WPM and accuracy, recorded for the boards."""
import random

from app import typerace
from app.auth import issue_ws_ticket
from tests.conftest import auth, make_user


def test_rules():
    r = typerace.TypeRace()
    assert r.start({}, 0.0, random.Random(1)) == "join the lobby first"
    assert r.start({"a": {"userId": "a"}, "b": {"userId": "b"}}, 0.0, random.Random(1)) is None
    n = len(r.text)
    assert not r.prog("a", {"pos": 3, "err": 0}, 1.0)              # still counting down
    assert r.tick(3.0)[0][0] == "go"
    assert r.prog("a", {"pos": 10, "err": 1}, 3.5)
    assert not r.prog("a", {"pos": 5, "err": 1}, 3.6)              # never backwards
    assert not r.prog("a", {"pos": n, "err": 1}, 3.7)              # far too fast
    assert not r.prog("a", {"pos": "20", "err": 0}, 4.0) and not r.prog("a", {"pos": True, "err": 0}, 4.0)
    t = 3.5
    pos = 10
    while pos < n:                                                 # a fast but human typist
        t += 0.1; pos = min(n, pos + 2); assert r.prog("a", {"pos": pos, "err": 1}, t)
    assert r.players["a"]["fin"] is not None
    evs = r.tick(t + typerace.FINISH_GRACE + 1)
    done = [d for e, d in evs if e == "done"][0]
    first = done["results"][0]
    assert first["user"]["userId"] == "a" and first["place"] == 1 and first["wpm"] > 0 and first["acc"] < 100
    assert done["results"][1]["dnf"] is True


async def test_race_over_websockets_and_board(client):
    a, ta = await make_user("ann", 1)
    url = f"/v1/rooms/lobby/ws?ticket={issue_ws_ticket(a)}"
    with client.websocket_connect(url) as ws:
        ws.receive_json()
        ws.send_json({"type": "game", "g": "type", "op": "join"})
        ws.send_json({"type": "game", "g": "type", "op": "start"})
        for _ in range(40):
            m = ws.receive_json()
            if m.get("g") == "type" and m.get("ev") == "type" and m["race"]["phase"] == "countdown":
                break
        assert m["race"]["text"] and m["race"]["lang"] in {s[0] for s in typerace.SNIPPETS}
    # results recorded from a finished race feed the WPM board
    from app import results
    await results.record("type", {"lang": "python", "results": [
        {"user": {"userId": a}, "place": 1, "ms": 30000, "dnf": False, "wpm": 72.5, "acc": 97.0}]})
    board = client.get("/v1/leaderboards/type", headers=auth(ta)).json()["boards"][0]["entries"]
    assert board[0]["wpm"] == 72.5 and board[0]["acc"] == 97.0
