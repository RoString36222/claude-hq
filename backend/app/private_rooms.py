"""Private room service: password hashing, throttle, admission, cleanup.

No routes here -- this is pure logic, called by routes/private_rooms.py and
routes/rooms.py. Constants are module-level so tests can monkeypatch them.
"""
import asyncio
import base64
import hashlib
import hmac
import math
import secrets
import threading
import time
import unicodedata
from collections import deque
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import PrivateRoom, PrivateRoomJoinAttempt, PrivateRoomMember, User
from .rooms import manager

# --- constants (monkeypatchable by tests) ---

NAME_MAX = 40
PW_MIN = 6
PW_MAX = 128

MAX_OWNED = 5
MAX_JOINED = 25
MAX_MEMBERS = 50
DIRECTORY_MAX = 200

SCRYPT_N = 2 ** 14
SCRYPT_R = 8
SCRYPT_P = 5
SCRYPT_MAXMEM = 64 * 1024 * 1024

KDF_CONCURRENCY = 2
KDF_OPS_PER_MIN = 10

FAILS_PER_PAIR = 5
PAIR_WINDOW = timedelta(minutes=15)
FAILS_PER_USER = 20
USER_WINDOW = timedelta(minutes=60)
FAILS_PER_ROOM = 50
ROOM_WINDOW = timedelta(minutes=60)
ATTEMPT_RETENTION = timedelta(hours=24)

_KDF_SLOTS = threading.BoundedSemaphore(KDF_CONCURRENCY)
_KDF_BUDGET: dict[str, deque] = {}


# --- time seam ---

def _now() -> datetime:
    return datetime.now(UTC)


def as_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt


def iso(dt: datetime) -> str:
    return as_utc(dt).isoformat(timespec="seconds")


# --- id ---

def new_room_id() -> str:
    return "r_" + secrets.token_urlsafe(16)


# --- name cleaning ---

def clean_room_name(raw: str) -> str | None:
    s = unicodedata.normalize("NFC", raw)
    # Replace non-printable characters with space
    s = "".join(ch if ch.isprintable() else " " for ch in s)
    # Drop excessive combining marks (Zalgo)
    out = []
    combo = 0
    for ch in s:
        if unicodedata.category(ch).startswith("M"):
            combo += 1
            if combo > 2:
                continue
        else:
            combo = 0
        out.append(ch)
    s = "".join(out)
    # Fold whitespace
    s = " ".join(s.split()).strip()
    if not s or len(s) > NAME_MAX:
        return None
    # Must have at least one letter, number, punctuation or symbol
    if not any(unicodedata.category(ch)[0] in ("L", "N", "P", "S") for ch in s):
        return None
    key = room_name_key(s)
    if len(key) > 255:
        return None
    return s


def room_name_key(name: str) -> str:
    return unicodedata.normalize("NFKC", name).casefold()


# --- password ---

def password_ok(pw: str) -> bool:
    return PW_MIN <= len(pw) <= PW_MAX


def _b64e(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _b64d(s: str) -> bytes | None:
    try:
        pad = 4 - len(s) % 4
        if pad < 4:
            s += "=" * pad
        return base64.urlsafe_b64decode(s)
    except Exception:
        return None


def _scrypt_sync(pw_bytes: bytes, salt: bytes, n: int, r: int, p: int) -> bytes:
    with _KDF_SLOTS:
        return hashlib.scrypt(
            pw_bytes, salt=salt, n=n, r=r, p=p, dklen=32, maxmem=SCRYPT_MAXMEM
        )


async def hash_password(pw: str) -> str:
    pw_bytes = unicodedata.normalize("NFC", pw).encode("utf-8")
    salt = secrets.token_bytes(16)
    dk = await asyncio.to_thread(_scrypt_sync, pw_bytes, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P)
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${_b64e(salt)}${_b64e(dk)}"


async def verify_password(pw: str, stored: str) -> bool:
    parts = stored.split("$")
    if len(parts) != 6 or parts[0] != "scrypt":
        return False
    try:
        n = int(parts[1])
        r = int(parts[2])
        p = int(parts[3])
    except ValueError:
        return False
    if n < 2 or n > 2 ** 20 or (n & (n - 1)) != 0:
        return False
    if not (1 <= r <= 16) or not (1 <= p <= 16):
        return False
    salt = _b64d(parts[4])
    expected_dk = _b64d(parts[5])
    if salt is None or expected_dk is None or len(expected_dk) != 32:
        return False
    try:
        pw_bytes = unicodedata.normalize("NFC", pw).encode("utf-8")
        actual_dk = await asyncio.to_thread(_scrypt_sync, pw_bytes, salt, n, r, p)
    except Exception:
        return False
    return hmac.compare_digest(actual_dk, expected_dk)


# --- KDF budget ---

def kdf_budget_ok(user_id: str) -> bool:
    now = time.monotonic()
    dq = _KDF_BUDGET.get(user_id)
    if dq is None:
        dq = deque()
        _KDF_BUDGET[user_id] = dq
    # Prune old entries
    cutoff = now - 60.0
    while dq and dq[0] < cutoff:
        dq.popleft()
    if len(dq) >= KDF_OPS_PER_MIN:
        return False
    dq.append(now)
    # Prune the dict when it grows too large
    if len(_KDF_BUDGET) > 10_000:
        to_del = [k for k, v in _KDF_BUDGET.items() if not v]
        for k in to_del:
            _KDF_BUDGET.pop(k, None)
    return True


# --- throttle ---

async def reserve_attempt(
    db: AsyncSession, room_id: str, user_id: str
) -> tuple[str | None, tuple[str, int] | None]:
    now = _now()
    attempt = PrivateRoomJoinAttempt(
        room_id=room_id, user_id=user_id, created_at=now
    )
    db.add(attempt)
    # Delete old rows
    await db.execute(
        delete(PrivateRoomJoinAttempt).where(
            PrivateRoomJoinAttempt.user_id == user_id,
            PrivateRoomJoinAttempt.created_at < now - ATTEMPT_RETENTION,
        )
    )
    await db.commit()

    # Count in each window
    windows = [
        (
            "pair",
            FAILS_PER_PAIR,
            PAIR_WINDOW,
            [
                PrivateRoomJoinAttempt.user_id == user_id,
                PrivateRoomJoinAttempt.room_id == room_id,
            ],
        ),
        (
            "user",
            FAILS_PER_USER,
            USER_WINDOW,
            [PrivateRoomJoinAttempt.user_id == user_id],
        ),
        (
            "room",
            FAILS_PER_ROOM,
            ROOM_WINDOW,
            [PrivateRoomJoinAttempt.room_id == room_id],
        ),
    ]

    for kind, cap, window, filters in windows:
        cutoff = now - window
        count_q = select(func.count()).select_from(PrivateRoomJoinAttempt).where(
            PrivateRoomJoinAttempt.created_at >= cutoff,
            *filters,
        )
        count = (await db.execute(count_q)).scalar() or 0
        if count > cap:
            # Delete our attempt
            await db.execute(
                delete(PrivateRoomJoinAttempt).where(
                    PrivateRoomJoinAttempt.id == attempt.id
                )
            )
            await db.commit()
            # Calculate retry
            oldest_q = (
                select(PrivateRoomJoinAttempt.created_at)
                .where(
                    PrivateRoomJoinAttempt.created_at >= cutoff,
                    PrivateRoomJoinAttempt.id != attempt.id,
                    *filters,
                )
                .order_by(PrivateRoomJoinAttempt.created_at)
                .limit(1)
            )
            oldest_row = (await db.execute(oldest_q)).scalar()
            if oldest_row is not None:
                oldest_dt = as_utc(oldest_row) if isinstance(oldest_row, datetime) else now
                retry = max(1, math.ceil((oldest_dt + window - now).total_seconds()))
            else:
                retry = max(1, int(window.total_seconds()))
            return None, (_throttle_message(kind, retry), retry)

    return attempt.id, None


def _throttle_message(kind: str, retry_secs: int) -> str:
    m = max(1, math.ceil(retry_secs / 60))
    if kind == "pair":
        return f"too many wrong passwords for this room — try again in {m} min"
    elif kind == "user":
        return f"too many wrong passwords — try again in {m} min"
    else:
        return f"this room has had too many wrong passwords — try again in {m} min"


async def pair_failures(db: AsyncSession, room_id: str, user_id: str) -> int:
    now = _now()
    cutoff = now - PAIR_WINDOW
    count = (
        await db.execute(
            select(func.count())
            .select_from(PrivateRoomJoinAttempt)
            .where(
                PrivateRoomJoinAttempt.user_id == user_id,
                PrivateRoomJoinAttempt.room_id == room_id,
                PrivateRoomJoinAttempt.created_at >= cutoff,
            )
        )
    ).scalar() or 0
    return count


async def clear_attempts(
    db: AsyncSession, room_id: str, user_id: str | None = None
) -> None:
    filters = [PrivateRoomJoinAttempt.room_id == room_id]
    if user_id is not None:
        filters.append(PrivateRoomJoinAttempt.user_id == user_id)
    await db.execute(delete(PrivateRoomJoinAttempt).where(*filters))


# --- admission ---

async def admission(
    db: AsyncSession, room_id: str, user_id: str
) -> tuple[str, str | None] | None:
    room = await db.get(PrivateRoom, room_id)
    if room is None:
        return None
    row = (
        await db.execute(
            select(PrivateRoomMember).where(
                PrivateRoomMember.room_id == room_id,
                PrivateRoomMember.user_id == user_id,
            )
        )
    ).scalar_one_or_none()
    return (room.name, row.role if row else None)


# --- cleanup ---

async def delete_room_rows(db: AsyncSession, room_id: str) -> None:
    await db.execute(
        delete(PrivateRoomJoinAttempt).where(PrivateRoomJoinAttempt.room_id == room_id)
    )
    await db.execute(
        delete(PrivateRoomMember).where(PrivateRoomMember.room_id == room_id)
    )
    await db.execute(
        delete(PrivateRoom).where(PrivateRoom.id == room_id)
    )


# --- room_out builder ---

async def room_out(db: AsyncSession, room: PrivateRoom, caller_id: str) -> dict:
    owner = await db.get(User, room.owner_user_id)
    member_count = (
        await db.execute(
            select(func.count())
            .select_from(PrivateRoomMember)
            .where(
                PrivateRoomMember.room_id == room.id,
                PrivateRoomMember.role.in_(["owner", "member"]),
            )
        )
    ).scalar() or 0
    caller_row = (
        await db.execute(
            select(PrivateRoomMember).where(
                PrivateRoomMember.room_id == room.id,
                PrivateRoomMember.user_id == caller_id,
            )
        )
    ).scalar_one_or_none()
    return {
        "id": room.id,
        "name": room.name,
        "ownerUserId": room.owner_user_id,
        "ownerHandle": owner.handle if owner else "",
        "ownerName": (owner.display_name or owner.handle) if owner else "",
        "online": manager.online(room.id),
        "memberCount": member_count,
        "role": caller_row.role if caller_row else None,
        "createdAt": iso(room.created_at),
    }
