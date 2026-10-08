"""Quick Play (HQ 2.1): matchmaking across rooms, per game.

Queue for a game; the Arena groups people into a fresh room ("qp_<id>") and tells
each of them where to go. Crewmates are put together first, then whoever has
waited longest. A match forms as soon as MAX_GROUP are waiting, or once the oldest
has waited WAIT_SECS with at least one other person in the queue. In memory (one
Arena process); queue entries that stop polling drop out after STALE_SECS."""
import secrets
import time

from sqlalchemy.ext.asyncio import AsyncSession

GAMES = ("kart", "plat", "fps", "golf", "type")
MAX_GROUP = 8
WAIT_SECS = 8.0
STALE_SECS = 15.0
MATCH_TTL = 90.0

_queues: dict[str, dict[str, dict]] = {g: {} for g in GAMES}    # game -> uid -> {at, seen, crew}
_matched: dict[str, dict] = {}                                   # uid -> {room, game, at, with}
_rooms: dict[str, dict] = {}                                     # room -> {game, users, at}
ROOM_TTL = 3 * 3600.0
NAMES = {"kart": "Kart Racing", "plat": "Platformer Rush", "fps": "Blaster Arena", "golf": "Mini Golf", "type": "Code Typing Race"}


def _now() -> float:
    return time.monotonic()


def _form(game: str, t: float) -> None:
    q = _queues[game]
    for uid in [u for u, e in q.items() if t - e["seen"] > STALE_SECS]:
        q.pop(uid, None)
    while len(q) >= 2:
        order = sorted(q.items(), key=lambda kv: kv[1]["at"])
        oldest_uid, oldest = order[0]
        if len(q) < MAX_GROUP and t - oldest["at"] < WAIT_SECS:
            return
        group = [oldest_uid]
        if oldest["crew"]:                      # friends first: the oldest's crewmates
            group += [u for u, e in order[1:] if e["crew"] == oldest["crew"]][:MAX_GROUP - 1]
        group += [u for u, _ in order[1:] if u not in group][:MAX_GROUP - len(group)]
        room = "qp_" + secrets.token_hex(6)
        _rooms[room] = {"game": game, "users": set(group), "at": t}
        for u in group:
            q.pop(u, None)
            _matched[u] = {"room": room, "game": game, "at": t, "with": len(group)}


def _expire(t: float) -> None:
    for r in [r for r, v in _rooms.items() if t - v["at"] > ROOM_TTL]:
        _rooms.pop(r, None)
    for u in [u for u, m in _matched.items() if t - m["at"] > MATCH_TTL]:
        _matched.pop(u, None)


async def join(db: AsyncSession, uid: str, game: str) -> dict:
    from .models import CrewMember
    if game not in GAMES:
        return {"state": "error", "error": "Quick Play has Kart, Platformer, Blaster, Golf and Code Typing Race"}
    t = _now()
    _matched.pop(uid, None)
    for g in GAMES:
        if g != game:
            _queues[g].pop(uid, None)
    m = await db.get(CrewMember, uid)
    e = _queues[game].setdefault(uid, {"at": t, "seen": t, "crew": m.crew_id if m else None})
    e["seen"] = t
    return status(uid)


def status(uid: str) -> dict:
    t = _now()
    _expire(t)
    for g in GAMES:
        _form(g, t)
    if uid in _matched:
        m = _matched[uid]
        return {"state": "matched", "room": m["room"], "game": m["game"], "players": m["with"]}
    for g in GAMES:
        e = _queues[g].get(uid)
        if e:
            e["seen"] = t
            return {"state": "waiting", "game": g, "waiting": len(_queues[g]), "waitedSecs": int(t - e["at"])}
    return {"state": "idle"}


def leave(uid: str) -> dict:
    for g in GAMES:
        _queues[g].pop(uid, None)
    _matched.pop(uid, None)
    return {"state": "idle"}


def admits(room_id: str, uid: str) -> bool:
    """A Quick Play room is only for the people matched into it (for a few hours)."""
    _expire(_now())
    r = _rooms.get(room_id)
    return bool(r and uid in r["users"])


def room_info(room_id: str) -> dict | None:
    r = _rooms.get(room_id)
    if not r:
        return None
    return {"kind": "quickplay", "id": room_id, "game": r["game"], "name": "Quick Play: " + NAMES[r["game"]]}


def reset() -> None:             # tests
    for g in GAMES:
        _queues[g].clear()
    _matched.clear()
    _rooms.clear()
