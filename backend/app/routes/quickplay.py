"""Quick Play routes: join a game's queue, poll for a match, leave. A match is an
Arena room id ("qp_..."); the client moves there and opens the game."""
from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from .. import quickplay
from ..auth import Caller, require_device
from ..db import get_session

router = APIRouter(prefix="/v1/quickplay", tags=["quickplay"])


class JoinBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    game: str = Field(max_length=8)


@router.post("/join")
async def join(body: JoinBody, caller: Caller = Depends(require_device), db: AsyncSession = Depends(get_session)) -> dict:
    return await quickplay.join(db, caller.user.id, body.game)


@router.get("/status")
async def status(caller: Caller = Depends(require_device)) -> dict:
    return quickplay.status(caller.user.id)


@router.post("/leave")
async def leave(caller: Caller = Depends(require_device)) -> dict:
    return quickplay.leave(caller.user.id)
