"""Device tokens, pairing codes and short-lived websocket tickets."""
import hashlib
import secrets
from datetime import UTC, datetime, timedelta

from fastapi import Depends, Header, HTTPException, status
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import get_settings
from .db import get_session
from .models import Device, PairCode, User

# Excludes I/O/0/1 so a code read aloud or retyped cannot be ambiguous.
_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def new_device_token() -> str:
    return "hqd_" + secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_pair_code() -> str:
    body = "".join(secrets.choice(_CODE_ALPHABET) for _ in range(8))
    return f"HQ-{body[:4]}-{body[4:]}"


def _serializer(salt: str) -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(get_settings().secret_key, salt=salt)


def issue_ws_ticket(user_id: str, device_id: str | None = None) -> str:
    """The device id rides along so revoking a device can also close the
    sockets it opened (see RoomManager.evict_device)."""
    data = {"uid": user_id}
    if device_id:
        data["did"] = device_id
    return _serializer("ws-ticket").dumps(data)


def read_ws_ticket_claims(ticket: str) -> tuple[str, str | None] | None:
    """(user_id, device_id or None), or None when the ticket is bad/expired."""
    try:
        data = _serializer("ws-ticket").loads(ticket, max_age=get_settings().ws_ticket_ttl_secs)
    except (BadSignature, SignatureExpired):
        return None
    if not isinstance(data, dict) or not data.get("uid"):
        return None
    return data["uid"], data.get("did")


def read_ws_ticket(ticket: str) -> str | None:
    claims = read_ws_ticket_claims(ticket)
    return claims[0] if claims else None


def issue_oauth_state() -> str:
    return _serializer("oauth-state").dumps({"n": secrets.token_hex(8)})


def check_oauth_state(state: str) -> bool:
    try:
        _serializer("oauth-state").loads(state, max_age=600)
    except (BadSignature, SignatureExpired):
        return False
    return True


async def consume_pair_code(db: AsyncSession, code: str) -> User | None:
    """One-shot: a code redeems exactly once, and only before it expires."""
    row = await db.get(PairCode, code.strip().upper())
    if row is None or row.used_at is not None:
        return None
    expires = row.expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=UTC)
    if expires < datetime.now(UTC):
        return None
    row.used_at = datetime.now(UTC)
    return await db.get(User, row.user_id)


async def mint_pair_code(db: AsyncSession, user_id: str) -> str:
    code = new_pair_code()
    db.add(PairCode(
        code=code,
        user_id=user_id,
        expires_at=datetime.now(UTC) + timedelta(seconds=get_settings().pair_code_ttl_secs),
    ))
    return code


def _aware(dt: datetime) -> datetime:
    # SQLite hands back naive datetimes; everything here is written in UTC.
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt


def device_idle_expired(device: Device, now: datetime | None = None) -> bool:
    """True when the device has not been used for ARENA_DEVICE_IDLE_DAYS. A
    device never seen since pairing counts from when it was paired."""
    last = device.last_seen_at or device.created_at
    if last is None:
        return False
    now = now or datetime.now(UTC)
    return now - _aware(last) > timedelta(days=get_settings().device_idle_days)


async def device_usable(db: AsyncSession, device_id: str) -> bool:
    """For websocket admission: the device still exists, is not revoked, and
    has not idled out. An idled-out device is revoked on the spot."""
    device = await db.get(Device, device_id)
    if device is None or device.revoked:
        return False
    if device_idle_expired(device):
        device.revoked = True
        await db.commit()
        return False
    return True


class Caller:
    """An authenticated device and the user behind it."""

    def __init__(self, user: User, device: Device):
        self.user = user
        self.device = device


async def require_device(
    authorization: str = Header(default=""),
    db: AsyncSession = Depends(get_session),
) -> Caller:
    if not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing bearer token")
    token = authorization.split(" ", 1)[1].strip()

    device = (
        await db.execute(select(Device).where(Device.token_hash == hash_token(token)))
    ).scalar_one_or_none()
    if device is None or device.revoked:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "unknown or revoked device")
    if device_idle_expired(device):
        # Revoke for good, so a later fix to the clock or the setting does not
        # quietly bring a long-abandoned token back to life.
        device.revoked = True
        await db.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "device expired after inactivity; pair again")

    user = await db.get(User, device.user_id)
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "account disabled")

    device.last_seen_at = datetime.now(UTC)
    await db.commit()
    return Caller(user, device)
