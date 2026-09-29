"""Poke Coins, snacks and gifts. Thin on purpose: the rules, caps and the
transaction order live in app/pantry.py.

Every route needs a paired device. Nothing here takes or returns a session id,
title, path, URL or command; which session ate a snack stays on the client.
A server without these routes answers a bare 404 "Not Found", which the client
reads as "this Arena doesn't have the store yet".
"""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from .. import pantry
from ..auth import Caller, require_device
from ..db import get_session
from ..schemas import (
    BuyRequest, BuyResponse, ClaimResponse, EatRequest, EatResponse, GiftsResponse,
    GiveRequest, GiveResponse, PantryState,
)

router = APIRouter(prefix="/v1", tags=["pantry"])


@router.get("/pantry", response_model=PantryState)
async def get_pantry(
    caller: Caller = Depends(require_device),
    db: AsyncSession = Depends(get_session),
) -> PantryState:
    # Read-only: a GET never claims the daily coins and never drains gifts.
    return PantryState(**await pantry.pantry_state(db, caller.user))


@router.post("/pantry/claim", response_model=ClaimResponse)
async def claim(
    caller: Caller = Depends(require_device),
    db: AsyncSession = Depends(get_session),
) -> ClaimResponse:
    # No body is read; the client sends {}.
    return await pantry.claim(db, caller.user)


@router.post("/pantry/buy", response_model=BuyResponse)
async def buy(
    body: BuyRequest,
    caller: Caller = Depends(require_device),
    db: AsyncSession = Depends(get_session),
) -> BuyResponse:
    return await pantry.buy(db, caller.user, body)


@router.post("/pantry/eat", response_model=EatResponse)
async def eat(
    body: EatRequest,
    caller: Caller = Depends(require_device),
    db: AsyncSession = Depends(get_session),
) -> EatResponse:
    return await pantry.eat(db, caller.user, body)


@router.post("/pantry/give", response_model=GiveResponse)
async def give(
    body: GiveRequest,
    caller: Caller = Depends(require_device),
    db: AsyncSession = Depends(get_session),
) -> GiveResponse:
    return await pantry.give(db, caller.user, body)


@router.post("/pantry/gifts/drain", response_model=GiftsResponse)
async def drain_gifts(
    caller: Caller = Depends(require_device),
    db: AsyncSession = Depends(get_session),
) -> GiftsResponse:
    # A POST, not a GET: it marks what it returns as delivered.
    return await pantry.drain(db, caller.user)
