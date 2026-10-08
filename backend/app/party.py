"""Party Mode (HQ 2.1): a playlist of the room's games with one combined score.

Someone in a room starts a party; the room then plays Kart Racing, Platformer Rush,
Blaster Arena and Mini Golf in that order. Each finished game (its "done" event, the
same one the results are kept from) gives points by place, 10-8-6-5-4-3-2-1, and moves
the party on to the next game. After the last one everyone sees the final standings.
The Arena keeps the score; the page only shows it. In memory, per room."""
import time
from typing import Any

from . import results as resultsmod

ORDER = ("kart", "plat", "fps", "golf")
POINTS = (10, 8, 6, 5, 4, 3, 2, 1)
TTL = 2 * 3600.0

_parties: dict[str, dict] = {}     # room_id -> party


def _now() -> float:
    return time.monotonic()


def _get(room_id: str) -> dict | None:
    p = _parties.get(room_id)
    if p and _now() - p["at"] > TTL:
        _parties.pop(room_id, None)
        return None
    return p


def view(room_id: str) -> dict:
    p = _get(room_id)
    if not p:
        return {"on": False, "order": list(ORDER)}
    board = sorted(p["scores"].items(), key=lambda kv: (-kv[1], p["names"].get(kv[0], {}).get("handle", "")))
    return {
        "on": True, "order": list(ORDER), "idx": p["idx"], "done": p["idx"] >= len(ORDER),
        "next": ORDER[p["idx"]] if p["idx"] < len(ORDER) else None,
        "by": p["by"], "rounds": p["rounds"],
        "standings": [{"user": p["names"].get(uid, {"userId": uid}), "points": pts} for uid, pts in board],
    }


def op(room_id: str, member: Any, name: str, out: Any) -> None:
    p = _get(room_id)
    if name == "view":
        out.to(member.ws, "state", party=view(room_id))
    elif name == "start":
        if p and p["idx"] < len(ORDER):
            out.err(member.ws, "a party is already on in this room")
            return
        _parties[room_id] = {"by": member.public(), "idx": 0, "scores": {}, "names": {}, "rounds": [], "at": _now()}
        out.all("state", party=view(room_id), started=True)
    elif name == "stop":
        if not p:
            return
        if p["by"].get("userId") != member.user_id and p["idx"] < len(ORDER):
            out.err(member.ws, "only whoever started the party can end it early")
            return
        _parties.pop(room_id, None)
        out.all("state", party=view(room_id), stopped=True)
    else:
        out.err(member.ws, "unknown party op")


def on_done(room_id: str, game: str, data: dict, who: dict | None = None) -> dict | None:
    """A game in this room finished: score it if it is the party's current game.
    `who` is user_id -> public profile of the people in the room (for the standings).
    Returns the party message to send the room, or None."""
    p = _get(room_id)
    if not p or p["idx"] >= len(ORDER) or ORDER[p["idx"]] != game:
        return None
    rows = resultsmod.rows_from_done(game, data)
    if not rows:
        return None
    names = {uid: {k: u.get(k) for k in ("userId", "handle", "displayName")} for uid, u in (who or {}).items()}
    got = []
    for r in sorted(rows, key=lambda r: r["place"]):
        uid = r["user_id"]
        pts = POINTS[min(r["place"], len(POINTS)) - 1]
        if game in ("kart", "plat") and r.get("value") is None and data.get("mode") != "coop":
            pts = 1                                  # did not finish: a point for turning up
        p["scores"][uid] = p["scores"].get(uid, 0) + pts
        p["names"].setdefault(uid, names.get(uid, {"userId": uid}))
        got.append({"userId": uid, "place": r["place"], "points": pts})
    p["rounds"].append({"game": game, "got": got})
    p["idx"] += 1
    p["at"] = _now()
    return {"type": "game", "g": "party", "ev": "state", "pv": 1, "party": view(room_id), "scored": game}


def reset() -> None:     # tests
    _parties.clear()
