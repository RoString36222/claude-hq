"""HQ 2.1: game results, progression, leaderboards and trainer profiles.

Every finished multiplayer game the Arena referees (Kart, Platformer, Blaster,
Golf) leaves one row per player in game_results, written here from the game's own
"done" event, never from a client. On top of that:

  progression   one HQ level from session XP (daily counts, as the board) plus
                game XP (finishing and placing), capped per day
  leaderboards  per game and track/level/course: best race time and best lap,
                platformer time, golf strokes, Blaster kills and K/D
  profiles      one trainer card: level, rank, streak, per-game stats, trophies
"""
import asyncio
from datetime import UTC, date, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .cosmetics import equipped as equipped_cosmetics
from .db import SessionLocal
from .models import DailyStat, GameResult, User
from .scoring import derive_level, rank_for_level, streak_from_dates, xp_for_level, xp_from_counts

GAMES = ("kart", "plat", "fps", "golf")
GAME_XP_DAY_CAP = 400
BOARD_SIZE = 20


def _uid(entry: dict) -> str | None:
    u = entry.get("user") if isinstance(entry, dict) else None
    uid = u.get("userId") if isinstance(u, dict) else None
    return uid if isinstance(uid, str) else None


def rows_from_done(game: str, data: dict) -> list[dict]:
    """The rows a game's "done" event becomes (pure, so it is easy to test)."""
    out: list[dict] = []
    if game in ("kart", "plat", "fps"):
        res = [r for r in (data.get("results") or []) if _uid(r)]
        n = len(res)
        for r in res:
            row = {"user_id": _uid(r), "game": game, "place": int(r.get("place") or n), "players": n, "extra": {}}
            if game == "kart":
                laps = [int(x) for x in (r.get("laps") or []) if isinstance(x, (int, float))]
                splits = [b - a for a, b in zip([0] + laps, laps)]
                row.update(key=str(data.get("track") or "")[:40], mode="%d laps" % len(laps) if laps else "",
                           value=None if r.get("dnf") else r.get("ms"))
                if splits and not r.get("dnf"):
                    row["extra"] = {"bestLap": min(splits)}
            elif game == "plat":
                row.update(key=str(data.get("level") or "")[:40], mode=str(data.get("mode") or "")[:16],
                           value=None if r.get("dnf") or data.get("mode") == "coop" else r.get("ms"),
                           extra={"coins": int(r.get("coins") or 0)})
            else:
                row.update(key="match", mode="", value=int(r.get("kills") or 0),
                           extra={"kills": int(r.get("kills") or 0), "deaths": int(r.get("deaths") or 0)})
            out.append(row)
    elif game == "golf":
        totals = data.get("totals") or {}
        ranked = sorted((v, uid) for uid, v in totals.items() if isinstance(uid, str) and isinstance(v, (int, float)))
        n = len(ranked)
        place, prev = 0, None
        for i, (v, uid) in enumerate(ranked):
            if v != prev:
                place, prev = i + 1, v
            out.append({"user_id": uid, "game": "golf", "key": str(data.get("course") or "")[:40], "mode": "",
                        "place": place, "players": n, "value": int(v), "extra": {}})
    for row in out:
        if row.get("value") is not None:
            row["value"] = int(row["value"])
    return out


async def record(game: str, data: dict) -> int:
    """Store a finished game's results. Never raises (a results hiccup must not
    disturb the game); returns how many rows were written."""
    if game not in GAMES or not isinstance(data, dict):
        return 0
    rows = rows_from_done(game, data)
    if not rows:
        return 0
    try:
        async with SessionLocal() as db:
            known = set((await db.execute(select(User.id).where(User.id.in_([r["user_id"] for r in rows])))).scalars())
            for r in rows:
                if r["user_id"] in known:
                    db.add(GameResult(**r))
            await db.commit()
        return len(rows)
    except Exception:
        return 0


_pending: set = set()


def record_later(game: str, data: dict) -> None:
    """Record without holding up the game's tick; drain() waits for these."""
    try:
        task = asyncio.get_running_loop().create_task(record(game, data))
    except RuntimeError:
        return
    _pending.add(task)
    task.add_done_callback(_pending.discard)


async def drain(timeout: float = 5.0) -> None:
    """Wait for results still being written (tests, shutdown). Polls rather than
    awaiting the tasks: they may belong to another event loop (the test client
    runs the app on its own thread)."""
    waited = 0.0
    while _pending and waited < timeout:
        await asyncio.sleep(0.02)
        waited += 0.02


def xp_for_result(place: int, players: int) -> int:
    """Finishing is worth 20; winning a game with others 30 more, 2nd 15, 3rd 8."""
    xp = 20
    if players >= 2:
        xp += {1: 30, 2: 15, 3: 8}.get(place, 0)
    return xp


async def game_xp(db: AsyncSession, user_ids: list[str]) -> dict[str, int]:
    out = {u: 0 for u in user_ids}
    if not user_ids:
        return out
    per_day: dict[tuple[str, date], int] = {}
    for uid, place, players, at in (await db.execute(
            select(GameResult.user_id, GameResult.place, GameResult.players, GameResult.at)
            .where(GameResult.user_id.in_(user_ids)))).all():
        k = (uid, (at or datetime.now(UTC)).date())
        per_day[k] = min(GAME_XP_DAY_CAP, per_day.get(k, 0) + xp_for_result(place, players))
    for (uid, _d), xp in per_day.items():
        out[uid] += xp
    return out


async def session_xp(db: AsyncSession, user_ids: list[str]) -> dict[str, int]:
    out = {u: 0 for u in user_ids}
    if not user_ids:
        return out
    for uid, p, t, a in (await db.execute(
            select(DailyStat.user_id, func.coalesce(func.sum(DailyStat.prompts), 0),
                   func.coalesce(func.sum(DailyStat.tools), 0), func.coalesce(func.sum(DailyStat.artifacts), 0))
            .where(DailyStat.user_id.in_(user_ids)).group_by(DailyStat.user_id))).all():
        out[uid] = xp_from_counts(int(p), int(t), int(a))
    return out


async def progress(db: AsyncSession, user_ids: list[str]) -> dict[str, dict]:
    """One HQ level per user: session XP + game XP."""
    sx, gx = await session_xp(db, user_ids), await game_xp(db, user_ids)
    out = {}
    for u in user_ids:
        xp = sx[u] + gx[u]
        level, into, need = derive_level(xp)
        out[u] = {"level": level, "xp": xp, "sessionXp": sx[u], "gameXp": gx[u], "xpIntoLevel": into,
                  "xpForLevel": need, "rank": rank_for_level(level), "nextLevelAt": xp_for_level(level + 1)}
    return out


async def leaderboard(db: AsyncSession, game: str, key: str | None, viewer_id: str | None) -> dict:
    """Per-key boards for one game, best result per player."""
    q = select(GameResult.key).where(GameResult.game == game).distinct()
    keys = sorted(k for k in (await db.execute(q)).scalars() if k)
    if key:
        keys = [k for k in keys if k == key]
    boards = []
    for k in keys:
        rows = (await db.execute(select(GameResult, User).join(User, User.id == GameResult.user_id)
                                 .where(GameResult.game == game, GameResult.key == k, User.is_active.is_(True)))).all()
        best: dict[str, dict] = {}
        for r, u in rows:
            b = best.setdefault(u.id, {"user": {"userId": u.id, "handle": u.handle, "displayName": u.display_name or u.handle,
                                                 "avatarUrl": u.avatar_url or ""},
                                        "played": 0, "wins": 0, "best": None, "bestLap": None, "kills": 0, "deaths": 0,
                                        "isYou": u.id == viewer_id})
            b["played"] += 1
            b["wins"] += 1 if r.place == 1 and r.players >= 2 else 0
            if game == "fps":
                b["kills"] += int((r.extra or {}).get("kills", 0)); b["deaths"] += int((r.extra or {}).get("deaths", 0))
            elif r.value is not None and (b["best"] is None or r.value < b["best"]):
                b["best"] = r.value
            lap = (r.extra or {}).get("bestLap")
            if isinstance(lap, int) and (b["bestLap"] is None or lap < b["bestLap"]):
                b["bestLap"] = lap
        entries = list(best.values())
        if game == "fps":
            for e in entries:
                e["kd"] = round(e["kills"] / max(1, e["deaths"]), 2)
            entries.sort(key=lambda e: (-e["kills"], -e["kd"], e["user"]["handle"]))
        else:
            entries = [e for e in entries if e["best"] is not None]
            entries.sort(key=lambda e: (e["best"], e["user"]["handle"]))
        for i, e in enumerate(entries, 1):
            e["rank"] = i
        boards.append({"key": k, "entries": entries[:BOARD_SIZE]})
    return {"game": game, "boards": boards}


TROPHIES = [  # (id, name, test over a player's stats)
    ("first-game", "First game", lambda s: s["games"] >= 1),
    ("first-win", "First win", lambda s: s["wins"] >= 1),
    ("ten-wins", "Ten wins", lambda s: s["wins"] >= 10),
    ("podium-5", "Five podiums", lambda s: s["podiums"] >= 5),
    ("all-rounder", "All-rounder: played all four games", lambda s: all(s["per"][g]["played"] for g in GAMES)),
    ("sharpshooter", "Sharpshooter: 100 Blaster kills", lambda s: s["per"]["fps"].get("kills", 0) >= 100),
    ("speedster", "Speedster: a lap under 15 s", lambda s: (s["per"]["kart"].get("bestLap") or 10 ** 9) < 15000),
    ("streak-7", "A week-long streak", lambda s: s["streak"] >= 7),
]


async def profile(db: AsyncSession, user: User, viewer_id: str | None) -> dict:
    pr = (await progress(db, [user.id]))[user.id]
    today = datetime.now(UTC).date()
    active = set((await db.execute(select(DailyStat.stat_date).where(
        DailyStat.user_id == user.id, DailyStat.stat_date >= today - timedelta(days=400),
        (DailyStat.prompts > 0) | (DailyStat.replies > 0)))).scalars())
    per: dict[str, dict[str, Any]] = {g: {"played": 0, "wins": 0} for g in GAMES}
    podiums = 0
    for r in (await db.execute(select(GameResult).where(GameResult.user_id == user.id))).scalars():
        p = per[r.game] if r.game in per else None
        if p is None:
            continue
        p["played"] += 1
        if r.players >= 2 and r.place == 1:
            p["wins"] += 1
        if r.players >= 2 and r.place <= 3:
            podiums += 1
        ex = r.extra or {}
        if r.game == "fps":
            p["kills"] = p.get("kills", 0) + int(ex.get("kills", 0)); p["deaths"] = p.get("deaths", 0) + int(ex.get("deaths", 0))
        elif r.value is not None:
            k = "best:" + r.key
            p[k] = r.value if p.get(k) is None else min(p[k], r.value)
        if isinstance(ex.get("bestLap"), int):
            p["bestLap"] = ex["bestLap"] if p.get("bestLap") is None else min(p["bestLap"], ex["bestLap"])
    if per["fps"].get("kills") is not None:
        per["fps"]["kd"] = round(per["fps"]["kills"] / max(1, per["fps"].get("deaths", 0)), 2)
    stats = {"games": sum(p["played"] for p in per.values()), "wins": sum(p["wins"] for p in per.values()),
             "podiums": podiums, "per": per, "streak": streak_from_dates(active, today)}
    return {
        "userId": user.id, "handle": user.handle, "displayName": user.display_name or user.handle,
        "trainerName": user.trainer_name or None, "avatarUrl": user.avatar_url or "",
        "progress": pr, "streak": stats["streak"], "games": per,
        "totals": {"played": stats["games"], "wins": stats["wins"], "podiums": podiums},
        "trophies": [{"id": t[0], "name": t[1]} for t in TROPHIES if t[2](stats)],
        "cos": (await equipped_cosmetics(db, [user.id]))[user.id],
        "isYou": user.id == viewer_id,
    }
