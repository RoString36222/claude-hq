"""HQ 2.1 crews: yours (with its invite code), create, join by code, leave, and
the crew board. Signed-in devices only."""
from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from .. import crews
from ..auth import Caller, require_device
from ..db import get_session

router = APIRouter(prefix="/v1/crews", tags=["crews"])


class CreateBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(max_length=40)
    tag: str = Field(max_length=4)
    color: str = Field(max_length=7)


class JoinBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: str = Field(max_length=12)


@router.get("/mine")
async def mine(caller: Caller = Depends(require_device), db: AsyncSession = Depends(get_session)) -> dict:
    return {"crew": await crews.mine(db, caller.user)}


@router.get("")
async def board(caller: Caller = Depends(require_device), db: AsyncSession = Depends(get_session)) -> dict:
    return {"crews": await crews.board(db, caller.user.id)}


@router.post("/create")
async def create(body: CreateBody, caller: Caller = Depends(require_device), db: AsyncSession = Depends(get_session)) -> dict:
    return {"crew": await crews.create(db, caller.user, body.name, body.tag, body.color)}


@router.post("/join")
async def join(body: JoinBody, caller: Caller = Depends(require_device), db: AsyncSession = Depends(get_session)) -> dict:
    return {"crew": await crews.join(db, caller.user, body.code)}


@router.post("/leave")
async def leave(caller: Caller = Depends(require_device), db: AsyncSession = Depends(get_session)) -> dict:
    return await crews.leave(db, caller.user)
