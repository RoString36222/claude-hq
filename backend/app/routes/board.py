import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import Caller, require_device
from ..db import SessionLocal, get_session
from ..events import board_hub
from ..schemas import BoardResponse, MeResponse
from ..service import WINDOWS, build_board

router = APIRouter(prefix="/v1", tags=["board"])

# Long enough to stay quiet, short enough that proxies do not drop the stream.
_HEARTBEAT_SECS = 25


@router.get("/board", response_model=BoardResponse)
async def get_board(
    window: str = Query("season"),
    caller: Caller = Depends(require_device),
    db: AsyncSession = Depends(get_session),
) -> BoardResponse:
    if window not in WINDOWS:
        raise HTTPException(400, f"window must be one of {', '.join(WINDOWS)}")
    return await build_board(db, window, viewer_id=caller.user.id)


@router.get("/me", response_model=MeResponse)
async def get_me(caller: Caller = Depends(require_device)) -> MeResponse:
    return MeResponse(
        handle=caller.user.handle,
        displayName=caller.user.display_name or caller.user.handle,
        trainerName=caller.user.trainer_name,
        avatarUrl=caller.user.avatar_url,
        deviceLabel=caller.device.label,
    )


@router.get("/board/stream")
async def stream_board(
    window: str = Query("season"),
    caller: Caller = Depends(require_device),
) -> StreamingResponse:
    if window not in WINDOWS:
        raise HTTPException(400, f"window must be one of {', '.join(WINDOWS)}")
    user_id = caller.user.id

    async def gen():
        queue = board_hub.subscribe()
        try:
            while True:
                # Own session per tick: the request-scoped one closes when the
                # handler returns, which for a stream is immediately.
                async with SessionLocal() as db:
                    board = await build_board(db, window, viewer_id=user_id)
                yield f"data: {json.dumps(board.model_dump(mode='json'))}\n\n"
                try:
                    await asyncio.wait_for(queue.get(), timeout=_HEARTBEAT_SECS)
                except TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            board_hub.unsubscribe(queue)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )
