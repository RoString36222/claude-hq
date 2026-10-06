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


def issue_ws_ticket(user_id: str) -> str:
    return _serializer("ws-ticket").dumps({"uid": user_id})


def read_ws_ticket(ticket: str) -> str | None:
    try:
        data = _serializer("ws-ticket").loads(ticket, max_age=get_settings().ws_ticket_ttl_secs)
    except (BadSignature, SignatureExpired):
        return None
    return data.get("uid")


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

    user = await db.get(User, device.user_id)
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "account disabled")

    device.last_seen_at = datetime.now(UTC)
    await db.commit()
    return Caller(user, device)
