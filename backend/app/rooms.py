"""
Generic websocket rooms: presence, broadcast, and a shared state blob.

This is the thin version on purpose. It knows nothing about any game -- a game
is a module that owns the `state` dict and validates transitions. Right now any
member may patch state, which is fine for a closed group of friends and is the
seam where a real game's rules will go.

Rooms live in process memory, so the API must run as a single instance (see
fly.toml). That is the right trade at this size; moving to multiple machines
means putting this behind Redis pub/sub.
"""
import asyncio
import re
import weakref
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket

LOBBY = "lobby"
PRIVATE_PREFIX = "r_"
PRIVATE_ID_RE = re.compile(r"^r_[A-Za-z0-9_-]{22}$")


def is_private_id(room_id: str) -> bool:
    return room_id.startswith(PRIVATE_PREFIX)

MAX_ROOM_MEMBERS = 32
MAX_STATE_BYTES = 64 * 1024

# Lobby chat (see routes/rooms.py _chat): a room keeps its last CHAT_HISTORY messages in memory, never on
# disk, for whoever joins next; each connection may send CHAT_RATE_COUNT per CHAT_RATE_WINDOW seconds.
CHAT_HISTORY = 50
CHAT_MAX_CHARS = 500
CHAT_RATE_COUNT = 8
CHAT_RATE_WINDOW = 10.0


@dataclass
class Member:
    ws: WebSocket
    user_id: str
    handle: str
    display_name: str
    avatar_url: str
    chat_times: deque = field(default_factory=lambda: deque(maxlen=CHAT_RATE_COUNT))

    def public(self) -> dict[str, Any]:
        return {
            "userId": self.user_id,
            "handle": self.handle,
            "displayName": self.display_name,
            "avatarUrl": self.avatar_url,
        }

    def may_chat(self, now: float) -> bool:
        """Sliding-window flood guard: at most CHAT_RATE_COUNT messages per CHAT_RATE_WINDOW seconds."""
        times = self.chat_times
        if len(times) == times.maxlen and now - times[0] < CHAT_RATE_WINDOW:
            return False
        times.append(now)
        return True


@dataclass
class Room:
    room_id: str
    members: dict[WebSocket, Member] = field(default_factory=dict)
    state: dict[str, Any] = field(default_factory=dict)
    chat: deque = field(default_factory=lambda: deque(maxlen=CHAT_HISTORY))

    def roster(self) -> list[dict[str, Any]]:
        # One entry per person, not per socket -- a laptop and a desktop are one player.
        seen: dict[str, dict[str, Any]] = {}
        for m in self.members.values():
            seen.setdefault(m.user_id, m.public())
        return list(seen.values())

    async def broadcast(self, message: dict[str, Any], skip: WebSocket | None = None) -> None:
        dead: list[WebSocket] = []
        for ws in list(self.members):
            if ws is skip:
                continue
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.members.pop(ws, None)


class RoomManager:
    def __init__(self) -> None:
        self._rooms: dict[str, Room] = {}
        self._lock = asyncio.Lock()
        self._gates: weakref.WeakValueDictionary = weakref.WeakValueDictionary()

    async def join(self, room_id: str, member: Member) -> Room:
        async with self._lock:
            room = self._rooms.setdefault(room_id, Room(room_id))
            if len(room.members) >= MAX_ROOM_MEMBERS:
                raise ValueError("room is full")
            room.members[member.ws] = member
        await room.broadcast(
            {"type": "join", "member": member.public(), "members": room.roster()},
            skip=member.ws,
        )
        return room

    async def leave(self, room_id: str, ws: WebSocket) -> None:
        async with self._lock:
            room = self._rooms.get(room_id)
            if room is None:
                return
            member = room.members.pop(ws, None)
            empty = not room.members
            if empty:
                self._rooms.pop(room_id, None)
        if member is not None and not empty:
            await room.broadcast(
                {"type": "leave", "member": member.public(), "members": room.roster()}
            )

    def get(self, room_id: str) -> Room | None:
        return self._rooms.get(room_id)

    def gate(self, room_id: str) -> asyncio.Lock:
        lock = self._gates.get(room_id)
        if lock is None:
            lock = asyncio.Lock()
            self._gates[room_id] = lock
        return lock

    def online(self, room_id: str) -> int:
        room = self._rooms.get(room_id)
        if room is None:
            return 0
        return len(room.roster())

    def online_user_ids(self, room_id: str) -> set[str]:
        room = self._rooms.get(room_id)
        if room is None:
            return set()
        return {m.user_id for m in room.members.values()}

    async def evict(
        self,
        room_id: str,
        *,
        code: int,
        reason: str,
        user_id: str | None = None,
        keep_user_id: str | None = None,
    ) -> int:
        victims: list[tuple[WebSocket, Member]] = []
        room: Room | None = None
        async with self._lock:
            room = self._rooms.get(room_id)
            if room is None:
                return 0
            to_remove: list[WebSocket] = []
            for ws, m in list(room.members.items()):
                if user_id is not None and m.user_id != user_id:
                    continue
                if keep_user_id is not None and m.user_id == keep_user_id:
                    continue
                to_remove.append(ws)
                victims.append((ws, m))
            for ws in to_remove:
                room.members.pop(ws, None)
            if not room.members:
                self._rooms.pop(room_id, None)

        for ws, _m in victims:
            try:
                await ws.close(code=code, reason=reason)
            except Exception:
                pass

        if room is not None and room.members:
            seen_users: set[str] = set()
            for _ws, m in victims:
                if m.user_id not in seen_users:
                    seen_users.add(m.user_id)
                    await room.broadcast(
                        {"type": "leave", "member": m.public(), "members": room.roster()}
                    )
        return len(victims)

    async def deliver_to_user(self, user_id: str, payload: dict) -> int:
        sent = 0
        for room in list(self._rooms.values()):
            for ws, member in list(room.members.items()):
                if member.user_id == user_id:
                    try:
                        await ws.send_json(payload)
                        sent += 1
                    except Exception:
                        pass
        return sent

    def summary(self) -> list[dict[str, Any]]:
        return [
            {"roomId": r.room_id, "members": len(r.roster())}
            for r in self._rooms.values()
            if not is_private_id(r.room_id)
        ]


manager = RoomManager()
