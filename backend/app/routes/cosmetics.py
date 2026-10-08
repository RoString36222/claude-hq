"""HQ 2.1 cosmetics: the catalog with what you own and wear, buying with Poke
Coins (replay-safe, through the pantry journal) and equipping one per slot."""
from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from .. import cosmetics
from ..auth import Caller, require_device
from ..db import get_session

router = APIRouter(prefix="/v1/cosmetics", tags=["cosmetics"])


class BuyBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    requestId: str = Field(min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    item: str = Field(max_length=16)


class EquipBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    slot: str = Field(max_length=12)
    item: str | None = Field(default=None, max_length=16)


@router.get("")
async def get_state(caller: Caller = Depends(require_device), db: AsyncSession = Depends(get_session)) -> dict:
    return await cosmetics.state(db, caller.user)


@router.post("/buy")
async def buy(body: BuyBody, caller: Caller = Depends(require_device), db: AsyncSession = Depends(get_session)) -> dict:
    return await cosmetics.buy(db, caller.user, body.requestId, body.item)


@router.post("/equip")
async def equip(body: EquipBody, caller: Caller = Depends(require_device), db: AsyncSession = Depends(get_session)) -> dict:
    return await cosmetics.equip(db, caller.user, body.slot, body.item)


market = APIRouter(prefix="/v1/market", tags=["cosmetics"])


class SellBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    requestId: str = Field(min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    cat: str = Field(max_length=8)
    qty: int = Field(ge=1, le=cosmetics.SELL_MAX_QTY)


@market.post("/sell")
async def sell(body: SellBody, caller: Caller = Depends(require_device), db: AsyncSession = Depends(get_session)) -> dict:
    return await cosmetics.sell(db, caller.user, body.requestId, body.cat, body.qty)
