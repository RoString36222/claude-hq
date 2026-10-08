"""HQ 2.1: visit and customise HQs.

Each user may open their 3D HQ to visitors. A visitor sees the building (paint,
accent, sign), the owner's level and how many of their crew are working, need
them or are idle: counts and cosmetics only. The level is scored here from
daily_stats (all time, the same XP rules as the board), never taken from the
client, so a building cannot be grown by editing a request.
"""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import HqProfile, User
from .schemas import HqCrew, HqLook, HqProfileOut, HqUpdate

OPEN_LIST_MAX = 100


async def levels_for(db: AsyncSession, user_ids: list[str]) -> dict[str, int]:
    """The HQ level (progression): session XP plus game XP, scored here."""
    from .results import progress
    return {u: p["level"] for u, p in (await progress(db, user_ids)).items()}


def _out(user: User, prof: HqProfile | None, level: int, viewer_id: str | None) -> HqProfileOut:
    look = HqLook(**{k: v for k, v in ((prof.look if prof else None) or {}).items() if k in HqLook.model_fields})
    crew = HqCrew(**{k: v for k, v in ((prof.crew if prof else None) or {}).items() if k in HqCrew.model_fields})
    return HqProfileOut(
        userId=user.id, handle=user.handle, displayName=user.display_name or user.handle,
        trainerName=user.trainer_name or None, avatarUrl=user.avatar_url or "", level=level,
        open=bool(prof and prof.open), look=look, crew=crew,
        updatedAt=prof.updated_at.isoformat() if prof and prof.updated_at else None,
        isYou=user.id == viewer_id,
    )


async def get_me(db: AsyncSession, user: User) -> HqProfileOut:
    prof = await db.get(HqProfile, user.id)
    return _out(user, prof, (await levels_for(db, [user.id]))[user.id], user.id)


async def update_me(db: AsyncSession, user: User, body: HqUpdate) -> HqProfileOut:
    prof = await db.get(HqProfile, user.id)
    if prof is None:
        prof = HqProfile(user_id=user.id, open=False, look={}, crew={})
        db.add(prof)
    if body.open is not None:
        prof.open = body.open
    if body.look is not None:
        prof.look = body.look.model_dump(exclude_none=True)
    if body.crew is not None:
        prof.crew = body.crew.model_dump()
    await db.commit()
    await db.refresh(prof)
    return _out(user, prof, (await levels_for(db, [user.id]))[user.id], user.id)


async def list_open(db: AsyncSession, viewer: User) -> list[HqProfileOut]:
    rows = (await db.execute(
        select(User, HqProfile).join(HqProfile, HqProfile.user_id == User.id)
        .where(HqProfile.open.is_(True), User.is_active.is_(True))
        .order_by(HqProfile.updated_at.desc()).limit(OPEN_LIST_MAX)
    )).all()
    levels = await levels_for(db, [u.id for u, _ in rows])
    return [_out(u, p, levels[u.id], viewer.id) for u, p in rows]


async def get_one(db: AsyncSession, viewer: User, user_id: str) -> HqProfileOut | None:
    """Someone's HQ, if they opened it (your own, always)."""
    user = await db.get(User, user_id)
    if user is None or not user.is_active:
        return None
    prof = await db.get(HqProfile, user_id)
    if user_id != viewer.id and not (prof and prof.open):
        return None
    return _out(user, prof, (await levels_for(db, [user_id]))[user_id], viewer.id)
