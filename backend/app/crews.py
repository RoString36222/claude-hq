"""HQ 2.1 crews: create one (name, 4-letter tag, banner colour), share its private
invite code, and climb the crew board together. A crew's XP is its members'
combined XP (sessions + games, as progression scores it); one crew per person;
up to MAX_MEMBERS. When the owner leaves, the longest-standing member takes over;
the last one out closes the crew."""
import re
import secrets

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Crew, CrewMember, User
from .results import progress
from .scoring import derive_level

MAX_MEMBERS = 20
NAME_RE = re.compile(r"^[A-Za-z0-9 .'&!-]{3,32}$")
TAG_RE = re.compile(r"^[A-Z0-9]{2,4}$")
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def _code() -> str:
    return secrets.token_hex(4).upper()            # 8 characters: KX81B9QZ-style, hard to guess


async def _members(db: AsyncSession, crew_id: str) -> list[tuple[User, CrewMember]]:
    return list((await db.execute(select(User, CrewMember).join(CrewMember, CrewMember.user_id == User.id)
                                  .where(CrewMember.crew_id == crew_id).order_by(CrewMember.joined_at))).all())


async def describe(db: AsyncSession, crew: Crew, viewer_id: str | None, with_code: bool = False) -> dict:
    mem = await _members(db, crew.id)
    prog = await progress(db, [u.id for u, _ in mem])
    xp = sum(p["xp"] for p in prog.values())
    level = derive_level(xp // max(1, len(mem)))[0] + len(mem) - 1     # the average member's level, +1 per extra member
    out = {"id": crew.id, "name": crew.name, "tag": crew.tag, "color": crew.color, "xp": xp, "level": level,
           "members": [{"userId": u.id, "handle": u.handle, "displayName": u.display_name or u.handle,
                        "level": prog[u.id]["level"], "owner": u.id == crew.owner_id} for u, _ in mem],
           "isMine": any(u.id == viewer_id for u, _ in mem)}
    if with_code:
        out["code"] = crew.code
    return out


async def mine(db: AsyncSession, user: User) -> dict | None:
    m = await db.get(CrewMember, user.id)
    if m is None:
        return None
    crew = await db.get(Crew, m.crew_id)
    return await describe(db, crew, user.id, with_code=True) if crew else None


async def tag_of(db: AsyncSession, user_ids: list[str]) -> dict[str, dict]:
    """{userId: {tag, color, name}} for whoever is in a crew (profiles, rooms)."""
    if not user_ids:
        return {}
    rows = (await db.execute(select(CrewMember.user_id, Crew).join(Crew, Crew.id == CrewMember.crew_id)
                             .where(CrewMember.user_id.in_(user_ids)))).all()
    return {uid: {"tag": c.tag, "color": c.color, "name": c.name} for uid, c in rows}


async def create(db: AsyncSession, user: User, name: str, tag: str, color: str) -> dict:
    name, tag = " ".join((name or "").split()), (tag or "").upper()
    if not NAME_RE.fullmatch(name):
        raise HTTPException(400, "a crew name is 3 to 32 letters, numbers, spaces and . ' & ! -")
    if not TAG_RE.fullmatch(tag):
        raise HTTPException(400, "a tag is 2 to 4 capital letters or numbers")
    if not COLOR_RE.fullmatch(color or ""):
        raise HTTPException(400, "pick a banner colour")
    if await db.get(CrewMember, user.id):
        raise HTTPException(409, "leave your crew first")
    if (await db.execute(select(Crew).where(func.lower(Crew.name) == name.lower()))).scalars().first():
        raise HTTPException(409, "that name is taken")
    crew = Crew(name=name, tag=tag, color=color, code=_code(), owner_id=user.id)
    db.add(crew)
    await db.flush()
    db.add(CrewMember(user_id=user.id, crew_id=crew.id))
    await db.commit()
    return await describe(db, crew, user.id, with_code=True)


async def join(db: AsyncSession, user: User, code: str) -> dict:
    code = (code or "").strip().upper()
    crew = (await db.execute(select(Crew).where(Crew.code == code))).scalars().first() if re.fullmatch(r"[0-9A-F]{8}", code) else None
    if crew is None:
        raise HTTPException(404, "no crew has that invite code")
    if await db.get(CrewMember, user.id):
        raise HTTPException(409, "leave your crew first")
    if len(await _members(db, crew.id)) >= MAX_MEMBERS:
        raise HTTPException(409, "that crew is full")
    db.add(CrewMember(user_id=user.id, crew_id=crew.id))
    await db.commit()
    return await describe(db, crew, user.id, with_code=True)


async def leave(db: AsyncSession, user: User) -> dict:
    m = await db.get(CrewMember, user.id)
    if m is None:
        return {"ok": True}
    crew = await db.get(Crew, m.crew_id)
    await db.delete(m)
    await db.flush()
    rest = await _members(db, crew.id)
    if not rest:
        await db.delete(crew)
    elif crew.owner_id == user.id:
        crew.owner_id = rest[0][0].id
    await db.commit()
    return {"ok": True}


async def board(db: AsyncSession, viewer_id: str | None) -> list[dict]:
    crews = (await db.execute(select(Crew))).scalars().all()
    out = [await describe(db, c, viewer_id) for c in crews]
    out.sort(key=lambda c: (-c["xp"], c["name"]))
    for i, c in enumerate(out, 1):
        c["rank"] = i
    return out[:50]
