"""Directed "come to the Arena" nudges.

A nudge is persisted so it reaches a friend even when their Arena tab is closed:
their local Claude HQ drains GET /v1/nudges on a timer and shows a native
notification. If they happen to be in the lobby right now, we also deliver it
live over the websocket so it lands instantly.

By design a nudge carries no URL and no command -- only who it is from and an
optional short note. It can never make the recipient's machine open or run
anything; the recipient decides whether to act on it.
"""
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import Caller, require_device
from ..db import get_session
from ..models import Nudge, User
from ..rooms import manager
from ..schemas import (
    NudgeItem, NudgesResponse, SendNudgeRequest, SendNudgeResponse,
)

router = APIRouter(prefix="/v1", tags=["nudges"])

# A friendly cap so a nudge is a tap, not a spam cannon.
_MAX_UNDELIVERED_PER_PAIR = 5


async def _deliver_live(to_user_id: str, payload: dict) -> int:
    """Best-effort instant delivery to any of the target's lobby sockets."""
    room = manager.get("lobby")
    if room is None:
        return 0
    sent = 0
    for ws, member in list(room.members.items()):
        if member.user_id == to_user_id:
            try:
                await ws.send_json(payload)
                sent += 1
            except Exception:
                pass
    return sent


@router.post("/nudge", response_model=SendNudgeResponse)
async def send_nudge(
    body: SendNudgeRequest,
    caller: Caller = Depends(require_device),
    db: AsyncSession = Depends(get_session),
) -> SendNudgeResponse:
    target = (
        await db.execute(select(User).where(User.handle == body.toHandle))
    ).scalar_one_or_none()
    if target is None or not target.is_active:
        raise HTTPException(404, "no such person")
    if target.id == caller.user.id:
        raise HTTPException(400, "you cannot nudge yourself")

    # Don't let undelivered nudges pile up between the same two people.
    pending = (
        await db.execute(
            select(Nudge).where(
                Nudge.from_user_id == caller.user.id,
                Nudge.to_user_id == target.id,
                Nudge.delivered_at.is_(None),
            )
        )
    ).scalars().all()
    if len(pending) >= _MAX_UNDELIVERED_PER_PAIR:
        raise HTTPException(429, "they already have pending nudges from you")

    db.add(Nudge(from_user_id=caller.user.id, to_user_id=target.id, note=body.note))
    await db.commit()

    live = await _deliver_live(target.id, {
        "type": "nudge",
        "from": {
            "userId": caller.user.id,
            "handle": caller.user.handle,
            "displayName": caller.user.display_name or caller.user.handle,
            "avatarUrl": caller.user.avatar_url,
        },
        "note": body.note,
    })
    return SendNudgeResponse(queued=True, deliveredLive=live)


@router.get("/nudges", response_model=NudgesResponse)
async def drain_nudges(
    caller: Caller = Depends(require_device),
    db: AsyncSession = Depends(get_session),
) -> NudgesResponse:
    rows = (
        await db.execute(
            select(Nudge, User)
            .join(User, User.id == Nudge.from_user_id)
            .where(Nudge.to_user_id == caller.user.id, Nudge.delivered_at.is_(None))
            .order_by(Nudge.created_at)
        )
    ).all()

    now = datetime.now(UTC)
    items: list[NudgeItem] = []
    for nudge, sender in rows:
        nudge.delivered_at = now
        items.append(NudgeItem(
            fromHandle=sender.handle,
            fromName=sender.display_name or sender.handle,
            note=nudge.note,
            at=nudge.created_at.isoformat() if nudge.created_at else now.isoformat(),
        ))
    await db.commit()
    return NudgesResponse(nudges=items)
