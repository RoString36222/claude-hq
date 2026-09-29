"""Named, password-protected private rooms."""
import unicodedata

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import private_rooms
from ..auth import Caller, require_device
from ..db import get_session
from ..models import PrivateRoom, PrivateRoomMember, User
from ..rooms import manager
from ..schemas import (
    CreateRoomRequest,
    JoinRoomRequest,
    LeaveRoomResponse,
    LobbyOut,
    RenameRoomRequest,
    RoomDirectoryResponse,
    RoomId,
    RoomLimits,
    RoomMemberOut,
    RoomMembersResponse,
    RoomOkResponse,
    RoomPasswordRequest,
    RoomPasswordResponse,
    RoomRefRequest,
    RoomResponse,
    RoomUserRequest,
    BannedOut,
)

router = APIRouter(prefix="/v1/rooms", tags=["rooms"])


async def _room(db: AsyncSession, rid: str) -> PrivateRoom:
    room = await db.get(PrivateRoom, rid)
    if room is None:
        raise HTTPException(404, "no such room")
    return room


def _owner(room: PrivateRoom, caller: Caller) -> None:
    if room.owner_user_id != caller.user.id:
        raise HTTPException(403, "only the room owner can do that")


# --- directory ---

@router.get("/directory", response_model=RoomDirectoryResponse)
async def directory(
    caller: Caller = Depends(require_device),
    db: AsyncSession = Depends(get_session),
) -> RoomDirectoryResponse:
    lobby = LobbyOut(online=manager.online("lobby"))

    rooms = (
        await db.execute(select(PrivateRoom))
    ).scalars().all()

    items = []
    for r in rooms:
        out = await private_rooms.room_out(db, r, caller.user.id)
        items.append(out)

    def sort_key(item: dict) -> tuple:
        role = item.get("role")
        rank = 0 if role == "owner" else (1 if role == "member" else 2)
        return (rank, -item["online"], item.get("name", "").casefold())

    items.sort(key=sort_key)
    items = items[:private_rooms.DIRECTORY_MAX]

    limits = RoomLimits(
        nameMax=private_rooms.NAME_MAX,
        passwordMin=private_rooms.PW_MIN,
        passwordMax=private_rooms.PW_MAX,
        maxOwned=private_rooms.MAX_OWNED,
        maxJoined=private_rooms.MAX_JOINED,
        maxMembers=private_rooms.MAX_MEMBERS,
    )
    return RoomDirectoryResponse(
        lobby=lobby,
        rooms=[_to_room_out(i) for i in items],
        limits=limits,
    )


def _to_room_out(d: dict):
    from ..schemas import RoomOut
    return RoomOut(**d)


# --- members ---

@router.get("/members", response_model=RoomMembersResponse)
async def members(
    roomId: RoomId = Query(...),
    caller: Caller = Depends(require_device),
    db: AsyncSession = Depends(get_session),
) -> RoomMembersResponse:
    room = await _room(db, roomId)

    caller_row = (
        await db.execute(
            select(PrivateRoomMember).where(
                PrivateRoomMember.room_id == roomId,
                PrivateRoomMember.user_id == caller.user.id,
            )
        )
    ).scalar_one_or_none()
    if caller_row is None or caller_row.role not in ("owner", "member"):
        raise HTTPException(403, "join this room first")

    online_ids = manager.online_user_ids(roomId)

    rows = (
        await db.execute(
            select(PrivateRoomMember, User)
            .join(User, User.id == PrivateRoomMember.user_id)
            .where(
                PrivateRoomMember.room_id == roomId,
                PrivateRoomMember.role.in_(["owner", "member"]),
            )
            .order_by(
                # owner first
                PrivateRoomMember.role,
                PrivateRoomMember.joined_at,
                PrivateRoomMember.id,
            )
        )
    ).all()

    member_list = [
        RoomMemberOut(
            userId=u.id,
            handle=u.handle,
            displayName=u.display_name or u.handle,
            avatarUrl=u.avatar_url,
            role=m.role,
            online=u.id in online_ids,
            joinedAt=private_rooms.iso(m.joined_at),
        )
        for m, u in rows
    ]

    banned_list: list[BannedOut] = []
    if caller_row.role == "owner":
        banned_rows = (
            await db.execute(
                select(PrivateRoomMember, User)
                .join(User, User.id == PrivateRoomMember.user_id)
                .where(
                    PrivateRoomMember.room_id == roomId,
                    PrivateRoomMember.role == "banned",
                )
                .order_by(PrivateRoomMember.joined_at)
            )
        ).all()
        banned_list = [
            BannedOut(
                userId=u.id,
                handle=u.handle,
                displayName=u.display_name or u.handle,
                avatarUrl=u.avatar_url,
            )
            for _m, u in banned_rows
        ]

    return RoomMembersResponse(roomId=roomId, members=member_list, banned=banned_list)


# --- create ---

@router.post("/create", response_model=RoomResponse)
async def create_room(
    body: CreateRoomRequest,
    caller: Caller = Depends(require_device),
    db: AsyncSession = Depends(get_session),
) -> RoomResponse:
    name = private_rooms.clean_room_name(body.name)
    if name is None:
        raise HTTPException(422, "room names are 1–40 characters")
    key = private_rooms.room_name_key(name)
    if key == "lobby":
        raise HTTPException(422, '"Lobby" is reserved — pick another name')

    pw = unicodedata.normalize("NFC", body.password)
    if not private_rooms.password_ok(pw):
        raise HTTPException(422, "passwords are 6–128 characters")

    owned = (
        await db.execute(
            select(func.count())
            .select_from(PrivateRoomMember)
            .where(
                PrivateRoomMember.user_id == caller.user.id,
                PrivateRoomMember.role == "owner",
            )
        )
    ).scalar() or 0
    if owned >= private_rooms.MAX_OWNED:
        raise HTTPException(
            409,
            f"you already own {private_rooms.MAX_OWNED} rooms — delete one first",
        )

    joined = (
        await db.execute(
            select(func.count())
            .select_from(PrivateRoomMember)
            .where(
                PrivateRoomMember.user_id == caller.user.id,
                PrivateRoomMember.role.in_(["owner", "member"]),
            )
        )
    ).scalar() or 0
    if joined >= private_rooms.MAX_JOINED:
        raise HTTPException(
            409,
            f"you're in {private_rooms.MAX_JOINED} rooms — leave one first",
        )

    existing = (
        await db.execute(
            select(PrivateRoom).where(PrivateRoom.name_key == key)
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(409, "a room with that name already exists")

    if not private_rooms.kdf_budget_ok(caller.user.id):
        return JSONResponse(
            status_code=429,
            content={"detail": "slow down — too many room requests; try again in a minute"},
            headers={"Retry-After": "60"},
        )

    hashed = await private_rooms.hash_password(pw)
    now = private_rooms._now()
    room = PrivateRoom(
        id=private_rooms.new_room_id(),
        name=name,
        name_key=key,
        owner_user_id=caller.user.id,
        password_hash=hashed,
        created_at=now,
        updated_at=now,
    )
    db.add(room)
    db.add(PrivateRoomMember(
        room_id=room.id,
        user_id=caller.user.id,
        role="owner",
        joined_at=now,
    ))
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(409, "a room with that name already exists")

    out = await private_rooms.room_out(db, room, caller.user.id)
    return RoomResponse(room=_to_room_out(out), already=False)


# --- join ---

@router.post("/join", response_model=RoomResponse)
async def join_room(
    body: JoinRoomRequest,
    caller: Caller = Depends(require_device),
    db: AsyncSession = Depends(get_session),
) -> RoomResponse | JSONResponse:
    room = await _room(db, body.roomId)

    existing = (
        await db.execute(
            select(PrivateRoomMember).where(
                PrivateRoomMember.room_id == body.roomId,
                PrivateRoomMember.user_id == caller.user.id,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        if existing.role in ("owner", "member"):
            out = await private_rooms.room_out(db, room, caller.user.id)
            return RoomResponse(room=_to_room_out(out), already=True)
        if existing.role == "banned":
            raise HTTPException(403, "you were removed from this room")

    joined = (
        await db.execute(
            select(func.count())
            .select_from(PrivateRoomMember)
            .where(
                PrivateRoomMember.user_id == caller.user.id,
                PrivateRoomMember.role.in_(["owner", "member"]),
            )
        )
    ).scalar() or 0
    if joined >= private_rooms.MAX_JOINED:
        raise HTTPException(
            409,
            f"you're in {private_rooms.MAX_JOINED} rooms — leave one first",
        )

    room_members = (
        await db.execute(
            select(func.count())
            .select_from(PrivateRoomMember)
            .where(
                PrivateRoomMember.room_id == body.roomId,
                PrivateRoomMember.role.in_(["owner", "member"]),
            )
        )
    ).scalar() or 0
    if room_members >= private_rooms.MAX_MEMBERS:
        raise HTTPException(
            409,
            f"this room is full ({private_rooms.MAX_MEMBERS} members)",
        )

    if not private_rooms.kdf_budget_ok(caller.user.id):
        return JSONResponse(
            status_code=429,
            content={"detail": "slow down — too many room requests; try again in a minute"},
            headers={"Retry-After": "60"},
        )

    attempt_id, throttled = await private_rooms.reserve_attempt(
        db, body.roomId, caller.user.id
    )
    if throttled is not None:
        msg, retry = throttled
        return JSONResponse(
            status_code=429,
            content={"detail": msg},
            headers={"Retry-After": str(retry)},
        )

    pw = unicodedata.normalize("NFC", body.password)
    if not private_rooms.password_ok(pw):
        ok = False
    else:
        ok = await private_rooms.verify_password(pw, room.password_hash)

    if not ok:
        k = private_rooms.FAILS_PER_PAIR - await private_rooms.pair_failures(
            db, body.roomId, caller.user.id
        )
        if k > 1:
            msg = f"wrong password — {k} tries left before a 15-minute pause"
        elif k == 1:
            msg = "wrong password — 1 try left before a 15-minute pause"
        else:
            msg = "wrong password — no tries left; wait 15 minutes"
        raise HTTPException(403, msg)

    # Password correct — join inside the gate
    async with manager.gate(body.roomId):
        room = await db.get(PrivateRoom, body.roomId)
        if room is None:
            raise HTTPException(404, "no such room")
        existing = (
            await db.execute(
                select(PrivateRoomMember).where(
                    PrivateRoomMember.room_id == body.roomId,
                    PrivateRoomMember.user_id == caller.user.id,
                )
            )
        ).scalar_one_or_none()
        if existing is not None:
            if existing.role == "banned":
                raise HTTPException(403, "you were removed from this room")
            out = await private_rooms.room_out(db, room, caller.user.id)
            return RoomResponse(room=_to_room_out(out), already=True)

        # Re-check caps
        joined2 = (
            await db.execute(
                select(func.count())
                .select_from(PrivateRoomMember)
                .where(
                    PrivateRoomMember.user_id == caller.user.id,
                    PrivateRoomMember.role.in_(["owner", "member"]),
                )
            )
        ).scalar() or 0
        if joined2 >= private_rooms.MAX_JOINED:
            raise HTTPException(409, f"you're in {private_rooms.MAX_JOINED} rooms — leave one first")

        room_members2 = (
            await db.execute(
                select(func.count())
                .select_from(PrivateRoomMember)
                .where(
                    PrivateRoomMember.room_id == body.roomId,
                    PrivateRoomMember.role.in_(["owner", "member"]),
                )
            )
        ).scalar() or 0
        if room_members2 >= private_rooms.MAX_MEMBERS:
            raise HTTPException(409, f"this room is full ({private_rooms.MAX_MEMBERS} members)")

        await private_rooms.clear_attempts(db, body.roomId, caller.user.id)
        db.add(PrivateRoomMember(
            room_id=body.roomId,
            user_id=caller.user.id,
            role="member",
            joined_at=private_rooms._now(),
        ))
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            out = await private_rooms.room_out(db, room, caller.user.id)
            return RoomResponse(room=_to_room_out(out), already=True)

    out = await private_rooms.room_out(db, room, caller.user.id)
    return RoomResponse(room=_to_room_out(out), already=False)


# --- leave ---

@router.post("/leave", response_model=LeaveRoomResponse)
async def leave_room(
    body: RoomRefRequest,
    caller: Caller = Depends(require_device),
    db: AsyncSession = Depends(get_session),
) -> LeaveRoomResponse:
    room = await _room(db, body.roomId)

    row = (
        await db.execute(
            select(PrivateRoomMember).where(
                PrivateRoomMember.room_id == body.roomId,
                PrivateRoomMember.user_id == caller.user.id,
            )
        )
    ).scalar_one_or_none()
    if row is None or row.role == "banned":
        return LeaveRoomResponse()

    async with manager.gate(body.roomId):
        # Re-read
        row = (
            await db.execute(
                select(PrivateRoomMember).where(
                    PrivateRoomMember.room_id == body.roomId,
                    PrivateRoomMember.user_id == caller.user.id,
                )
            )
        ).scalar_one_or_none()
        if row is None or row.role == "banned":
            return LeaveRoomResponse()

        if row.role == "member":
            await db.delete(row)
            await db.commit()
            await manager.evict(
                body.roomId, user_id=caller.user.id,
                code=4406, reason="you left this room",
            )
            return LeaveRoomResponse()

        # Owner leaving
        heir_row = (
            await db.execute(
                select(PrivateRoomMember)
                .where(
                    PrivateRoomMember.room_id == body.roomId,
                    PrivateRoomMember.role == "member",
                )
                .order_by(PrivateRoomMember.joined_at, PrivateRoomMember.id)
                .limit(1)
            )
        ).scalar_one_or_none()

        if heir_row is not None:
            heir_user = await db.get(User, heir_row.user_id)
            room.owner_user_id = heir_row.user_id
            heir_row.role = "owner"
            await db.delete(row)
            room.updated_at = private_rooms._now()
            await db.commit()
            await manager.evict(
                body.roomId, user_id=caller.user.id,
                code=4406, reason="you left this room",
            )
            # Broadcast room-updated
            live_room = manager.get(body.roomId)
            if live_room is not None:
                await live_room.broadcast({
                    "type": "room", "op": "updated",
                    "room": {"id": room.id, "name": room.name, "ownerUserId": room.owner_user_id},
                })
            return LeaveRoomResponse(
                newOwnerHandle=heir_user.handle if heir_user else None,
            )
        else:
            await private_rooms.delete_room_rows(db, body.roomId)
            await db.commit()
            await manager.evict(
                body.roomId, code=4404, reason="room deleted",
            )
            return LeaveRoomResponse(deleted=True)


# --- rename ---

@router.post("/rename", response_model=RoomResponse)
async def rename_room(
    body: RenameRoomRequest,
    caller: Caller = Depends(require_device),
    db: AsyncSession = Depends(get_session),
) -> RoomResponse:
    room = await _room(db, body.roomId)
    _owner(room, caller)

    name = private_rooms.clean_room_name(body.name)
    if name is None:
        raise HTTPException(422, "room names are 1–40 characters")
    key = private_rooms.room_name_key(name)
    if key == "lobby":
        raise HTTPException(422, '"Lobby" is reserved — pick another name')

    conflict = (
        await db.execute(
            select(PrivateRoom).where(
                PrivateRoom.name_key == key,
                PrivateRoom.id != body.roomId,
            )
        )
    ).scalar_one_or_none()
    if conflict is not None:
        raise HTTPException(409, "a room with that name already exists")

    room.name = name
    room.name_key = key
    room.updated_at = private_rooms._now()
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(409, "a room with that name already exists")

    live_room = manager.get(body.roomId)
    if live_room is not None:
        await live_room.broadcast({
            "type": "room", "op": "updated",
            "room": {"id": room.id, "name": room.name, "ownerUserId": room.owner_user_id},
        })

    out = await private_rooms.room_out(db, room, caller.user.id)
    return RoomResponse(room=_to_room_out(out))


# --- password ---

@router.post("/password", response_model=RoomPasswordResponse)
async def change_password(
    body: RoomPasswordRequest,
    caller: Caller = Depends(require_device),
    db: AsyncSession = Depends(get_session),
) -> RoomPasswordResponse | JSONResponse:
    room = await _room(db, body.roomId)
    _owner(room, caller)

    pw = unicodedata.normalize("NFC", body.password)
    if not private_rooms.password_ok(pw):
        raise HTTPException(422, "passwords are 6–128 characters")

    if not private_rooms.kdf_budget_ok(caller.user.id):
        return JSONResponse(
            status_code=429,
            content={"detail": "slow down — too many room requests; try again in a minute"},
            headers={"Retry-After": "60"},
        )

    hashed = await private_rooms.hash_password(pw)

    signed_out = 0
    async with manager.gate(body.roomId):
        room.password_hash = hashed
        room.updated_at = private_rooms._now()
        await private_rooms.clear_attempts(db, body.roomId)

        if body.signOutOthers:
            from sqlalchemy import delete as sa_delete
            result = await db.execute(
                sa_delete(PrivateRoomMember).where(
                    PrivateRoomMember.room_id == body.roomId,
                    PrivateRoomMember.role == "member",
                )
            )
            signed_out = result.rowcount
        await db.commit()

        if body.signOutOthers:
            await manager.evict(
                body.roomId,
                keep_user_id=caller.user.id,
                code=4406,
                reason="room password changed",
            )

    return RoomPasswordResponse(signedOut=signed_out)


# --- kick ---

@router.post("/kick", response_model=RoomOkResponse)
async def kick_member(
    body: RoomUserRequest,
    caller: Caller = Depends(require_device),
    db: AsyncSession = Depends(get_session),
) -> RoomOkResponse:
    room = await _room(db, body.roomId)
    _owner(room, caller)

    if body.userId == caller.user.id:
        raise HTTPException(400, "you can't remove yourself — use Leave")

    target_row = (
        await db.execute(
            select(PrivateRoomMember).where(
                PrivateRoomMember.room_id == body.roomId,
                PrivateRoomMember.user_id == body.userId,
            )
        )
    ).scalar_one_or_none()
    if target_row is None or target_row.role != "member":
        raise HTTPException(404, "they're not in this room")

    async with manager.gate(body.roomId):
        target_row.role = "banned"
        await db.commit()
        await manager.evict(
            body.roomId, user_id=body.userId,
            code=4406, reason="removed from this room",
        )

    return RoomOkResponse()


# --- unban ---

@router.post("/unban", response_model=RoomOkResponse)
async def unban_member(
    body: RoomUserRequest,
    caller: Caller = Depends(require_device),
    db: AsyncSession = Depends(get_session),
) -> RoomOkResponse:
    room = await _room(db, body.roomId)
    _owner(room, caller)

    target_row = (
        await db.execute(
            select(PrivateRoomMember).where(
                PrivateRoomMember.room_id == body.roomId,
                PrivateRoomMember.user_id == body.userId,
            )
        )
    ).scalar_one_or_none()
    if target_row is None or target_row.role != "banned":
        raise HTTPException(404, "they're not banned here")

    await db.delete(target_row)
    await db.commit()
    return RoomOkResponse()


# --- delete ---

@router.post("/delete", response_model=RoomOkResponse)
async def delete_room(
    body: RoomRefRequest,
    caller: Caller = Depends(require_device),
    db: AsyncSession = Depends(get_session),
) -> RoomOkResponse:
    room = await _room(db, body.roomId)
    _owner(room, caller)

    async with manager.gate(body.roomId):
        await private_rooms.delete_room_rows(db, body.roomId)
        await db.commit()
        await manager.evict(body.roomId, code=4404, reason="room deleted")

    return RoomOkResponse()
