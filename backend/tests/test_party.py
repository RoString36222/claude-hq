"""Party Mode (HQ 2.1): Kart -> Platformer -> Blaster -> Golf, one combined score."""
import pytest

from app import party
from app.auth import issue_ws_ticket
from tests.conftest import make_user


@pytest.fixture(autouse=True)
def clean():
    party.reset()
    yield
    party.reset()


class FakeOut:
    def __init__(self):
        self.sent = []

    def to(self, ws, ev, **d):
        self.sent.append(("to", ev, d))

    def all(self, ev, **d):
        self.sent.append(("all", ev, d))

    def err(self, ws, msg):
        self.sent.append(("err", msg, {}))


class M:
    def __init__(self, uid):
        self.user_id, self.ws = uid, object()

    def public(self):
        return {"userId": self.user_id, "handle": self.user_id, "displayName": self.user_id}


def res(*uids, dnf=()):
    return [{"user": {"userId": u}, "place": i + 1, "ms": None if u in dnf else 1000 + i} for i, u in enumerate(uids)]


def test_points_add_up_over_the_playlist():
    o = FakeOut()
    party.op("r", M("a"), "start", o)
    assert o.sent[-1][1] == "state" and o.sent[-1][2]["party"]["next"] == "kart"
    who = {u: M(u).public() for u in "abc"}
    assert party.on_done("r", "plat", {"results": res("a", "b")}, who) is None      # not the current game
    m = party.on_done("r", "kart", {"track": "oval", "results": res("a", "b", "c", dnf=("c",))}, who)
    assert m["party"]["next"] == "plat" and m["scored"] == "kart"
    party.on_done("r", "plat", {"level": "1", "mode": "race", "results": res("b", "a")}, who)
    party.on_done("r", "fps", {"results": [{"user": {"userId": "c"}, "place": 1, "kills": 5}, {"user": {"userId": "a"}, "place": 2, "kills": 1}]}, who)
    m = party.on_done("r", "golf", {"totals": {"a": 20, "b": 18}, "course": "x"}, who)
    v = m["party"]
    assert v["done"] and v["next"] is None
    pts = {s["user"]["userId"]: s["points"] for s in v["standings"]}
    # a: 10+8+8+8, b: 8+10+0+10, c: 1 (dnf kart) + 10
    assert pts == {"a": 34, "b": 28, "c": 11}
    assert v["standings"][0]["user"]["displayName"] == "a"
    assert party.on_done("r", "kart", {"results": res("a")}, who) is None             # over


def test_only_the_starter_ends_it_early():
    o = FakeOut()
    party.op("r", M("a"), "start", o)
    party.op("r", M("a"), "start", o)
    assert o.sent[-1][0] == "err"
    party.op("r", M("b"), "stop", o)
    assert o.sent[-1][0] == "err"
    party.op("r", M("a"), "stop", o)
    assert o.sent[-1][2]["party"]["on"] is False


async def test_party_over_the_room_socket(client):
    a, _ = await make_user("ann", 1)
    with client.websocket_connect(f"/v1/rooms/lobby/ws?ticket={issue_ws_ticket(a)}") as ws:
        w = ws.receive_json()
        assert w["arena"]["party"]["order"] == ["kart", "plat", "fps", "golf"]
        ws.send_json({"type": "game", "g": "party", "op": "start"})
        for _ in range(20):
            m = ws.receive_json()
            if m.get("g") == "party":
                break
        assert m["ev"] == "state" and m["party"]["on"] and m["started"]
