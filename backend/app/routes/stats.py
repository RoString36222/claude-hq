from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import Caller, require_device
from ..db import get_session
from ..events import board_hub
from ..schemas import IngestResponse, StatPayload
from ..service import ingest

router = APIRouter(prefix="/v1", tags=["stats"])


@router.post("/stats", response_model=IngestResponse)
async def post_stats(
    payload: StatPayload,
    caller: Caller = Depends(require_device),
    db: AsyncSession = Depends(get_session),
) -> IngestResponse:
    result = await ingest(db, caller.user, caller.device.id, payload)
    if result.accepted:
        board_hub.publish("stats")
    return result
