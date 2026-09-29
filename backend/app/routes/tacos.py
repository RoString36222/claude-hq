"""California Burrito taco Tuesdays. Thin on purpose: the buy-1-get-1 rule, the
TT/TPP metrics and the ranking all live in app/tacos.py.

Every route needs a paired device. A server without these routes answers a bare
404 "Not Found", which the client reads as "this Arena doesn't have the taco
board yet".
"""
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from .. import tacos
from ..auth import Caller, require_device
from ..db import get_session
from ..schemas import CaliBoardResponse, LogOrderRequest, LogOrderResponse, OrdersResponse

router = APIRouter(prefix="/v1", tags=["cali"])


@router.post("/cali/orders", response_model=LogOrderResponse)
async def log_order(
    body: LogOrderRequest,
    caller: Caller = Depends(require_device),
    db: AsyncSession = Depends(get_session),
) -> LogOrderResponse:
    return await tacos.log_order(db, caller.user, body)


@router.get("/cali/orders", response_model=OrdersResponse)
async def list_orders(
    limit: int = Query(tacos.RECENT_ORDERS, ge=1, le=tacos.RECENT_ORDERS),
    caller: Caller = Depends(require_device),
    db: AsyncSession = Depends(get_session),
) -> OrdersResponse:
    return await tacos.list_orders(db, limit=limit)


@router.get("/cali/board", response_model=CaliBoardResponse)
async def get_board(
    window: str = Query("season"),
    caller: Caller = Depends(require_device),
    db: AsyncSession = Depends(get_session),
) -> CaliBoardResponse:
    return await tacos.build_board(db, window, viewer_id=caller.user.id)
