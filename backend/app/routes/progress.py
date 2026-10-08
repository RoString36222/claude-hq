"""HQ 2.1: progression, leaderboards and trainer profiles, all scored here from
daily_stats and the game results the Arena itself recorded. Read-only routes;
nothing here takes session data. A server without them answers a bare 404."""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from .. import results
from ..auth import Caller, require_device
from ..db import get_session
from ..models import User

router = APIRouter(prefix="/v1", tags=["progress"])


@router.get("/progress/me")
async def my_progress(caller: Caller = Depends(require_device), db: AsyncSession = Depends(get_session)) -> dict:
    return (await results.progress(db, [caller.user.id]))[caller.user.id]


@router.get("/leaderboards/{game}")
async def leaderboards(game: str, key: str | None = Query(default=None, max_length=40),
                       caller: Caller = Depends(require_device), db: AsyncSession = Depends(get_session)) -> dict:
    if game not in results.GAMES:
        raise HTTPException(status_code=404, detail="no such game")
    return await results.leaderboard(db, game, key, caller.user.id)


@router.get("/profile/{user_id}")
async def profile(user_id: str, caller: Caller = Depends(require_device), db: AsyncSession = Depends(get_session)) -> dict:
    uid = caller.user.id if user_id == "me" else user_id[:36]
    user = await db.get(User, uid)
    if user is None or not user.is_active:
        raise HTTPException(status_code=404, detail="no such trainer")
    return await results.profile(db, user, caller.user.id)
