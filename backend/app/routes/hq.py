"""HQ 2.1 routes: your HQ's look and openness, the list of open HQs, and one HQ
to visit. Every route needs a paired device. Nothing here takes or returns a
session id, title, project, path or anything from a transcript: crew are counts.
A server without these routes answers a bare 404, which the client reads as
"this Arena doesn't have visits yet"."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from .. import hq
from ..auth import Caller, require_device
from ..db import get_session
from ..schemas import HqOpenList, HqProfileOut, HqUpdate

router = APIRouter(prefix="/v1/hq", tags=["hq"])


@router.get("/me", response_model=HqProfileOut)
async def get_me(caller: Caller = Depends(require_device), db: AsyncSession = Depends(get_session)) -> HqProfileOut:
    return await hq.get_me(db, caller.user)


@router.put("/me", response_model=HqProfileOut)
async def put_me(body: HqUpdate, caller: Caller = Depends(require_device),
                 db: AsyncSession = Depends(get_session)) -> HqProfileOut:
    return await hq.update_me(db, caller.user, body)


@router.get("/open", response_model=HqOpenList)
async def list_open(caller: Caller = Depends(require_device), db: AsyncSession = Depends(get_session)) -> HqOpenList:
    return HqOpenList(hqs=await hq.list_open(db, caller.user))


@router.get("/{user_id}", response_model=HqProfileOut)
async def get_one(user_id: str, caller: Caller = Depends(require_device),
                  db: AsyncSession = Depends(get_session)) -> HqProfileOut:
    got = await hq.get_one(db, caller.user, user_id[:36])
    if got is None:
        raise HTTPException(status_code=404, detail="that HQ is not open to visitors")
    return got
