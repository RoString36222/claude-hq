"""HQ 2.1: who is in an HQ right now, and where (g = "hq").

Each HQ has its own Arena room, "hq_<owner user id>" (routes/rooms.py lets in only
the owner, or anyone while the owner keeps the HQ open). Arena City, the street of
open HQs, is one more room, "hq_city", that anyone paired may walk. Everyone in it joins the
"hq" lobby and sends where they stand: which floor (base, lobby, mission), x/z in
centimetres, facing in degrees, and whether they walk. The room's loop sends the
whole list 8 times a second, so everyone sees everyone else move. Positions only:
no session data, and nothing is stored.
"""
from typing import Any

HZ = 8
MAX_PEOPLE = 16
CITY_ROOM = "hq_city"          # Arena City: the street of open HQs, open to anyone paired
MAX_CITY = 40
FLOORS = ("base", "lobby", "mission", "city")
POS_RATE, POS_BURST = 12.0, 24.0       # frames a second per person (clients send 8)
KEEPALIVE = 2.0                         # resend the list this often even when nobody moved


def _num(v: Any, lo: float, hi: float) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    v = float(v)
    return v if lo <= v <= hi else None


def cap(room_id: str) -> int:
    return MAX_CITY if room_id == CITY_ROOM else MAX_PEOPLE


def _frame(pub: dict) -> str | None:
    """The name frame they wear (a colour), so everyone draws their name tag in it."""
    f = (pub.get("cos") or {}).get("frame")
    return f if isinstance(f, str) and len(f) == 7 and f.startswith("#") else None


class Presence:
    def __init__(self) -> None:
        self.people: dict[str, dict] = {}
        self.dirty = False
        self.sent_at = 0.0

    def enter(self, uid: str, pub: dict, t: float) -> None:
        p = self.people.get(uid)
        if p is None:
            self.people[uid] = {"user": pub, "w": "base", "x": 0, "z": 1400, "r": 0, "a": 0,
                                "bucket": [POS_BURST, t]}
        self.dirty = True

    def drop(self, uid: str) -> bool:
        if self.people.pop(uid, None) is None:
            return False
        self.dirty = True
        return True

    def pos(self, uid: str, msg: dict, t: float) -> bool:
        p = self.people.get(uid)
        if p is None:
            return False
        b = p["bucket"]
        b[0] = min(POS_BURST, b[0] + (t - b[1])*POS_RATE)
        b[1] = t
        if b[0] < 1.0:
            return False
        b[0] -= 1.0
        w = msg.get("w")
        x, z, r = _num(msg.get("x"), -6000, 6000), _num(msg.get("z"), -6000, 6000), _num(msg.get("r"), -720, 720)
        a = msg.get("a", 0)
        if w not in FLOORS or x is None or z is None or r is None or a not in (0, 1, 2):
            return False
        p.update(w=w, x=int(x), z=int(z), r=int(r) % 360, a=a)
        self.dirty = True
        return True

    def listing(self) -> list[dict]:
        return [{"u": uid, "n": (p["user"].get("displayName") or p["user"].get("handle") or "")[:24],
                 "w": p["w"], "x": p["x"], "z": p["z"], "r": p["r"], "a": p["a"],
                 **({"f": _frame(p["user"])} if _frame(p["user"]) else {})}
                for uid, p in self.people.items()]
