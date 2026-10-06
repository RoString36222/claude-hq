"""GitHub OAuth, device pairing, and websocket tickets."""
import html
import re

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import (
    Caller, _aware, check_oauth_state, consume_pair_code, hash_token, issue_oauth_state,
    issue_ws_ticket, mint_pair_code, new_device_token, require_device,
)
from ..config import get_settings
from ..db import get_session
from ..models import Device, User
from ..rooms import manager
from ..schemas import (
    DeviceInfo, DevicesResponse, PairRequest, PairResponse, RevokeResponse, TicketResponse,
)

router = APIRouter(prefix="/v1/auth", tags=["auth"])

_HANDLE_RE = re.compile(r"[^A-Za-z0-9_-]")


@router.get("/github/start")
async def github_start() -> RedirectResponse:
    s = get_settings()
    if not s.github_client_id:
        raise HTTPException(503, "GitHub OAuth is not configured on this server")
    url = (
        "https://github.com/login/oauth/authorize"
        f"?client_id={s.github_client_id}"
        f"&redirect_uri={s.public_base_url}/v1/auth/github/callback"
        f"&scope=read:user&state={issue_oauth_state()}"
    )
    return RedirectResponse(url)


@router.get("/github/callback", response_class=HTMLResponse)
async def github_callback(
    code: str = Query(...),
    state: str = Query(""),
    db: AsyncSession = Depends(get_session),
) -> HTMLResponse:
    s = get_settings()
    if not check_oauth_state(state):
        raise HTTPException(400, "invalid or expired state")

    async with httpx.AsyncClient(timeout=15) as client:
        tok = await client.post(
            "https://github.com/login/oauth/access_token",
            headers={"Accept": "application/json"},
            data={
                "client_id": s.github_client_id,
                "client_secret": s.github_client_secret,
                "code": code,
                "redirect_uri": f"{s.public_base_url}/v1/auth/github/callback",
            },
        )
        token_body = tok.json()
        access = token_body.get("access_token")
        if not access:
            # GitHub names the cause -- most often incorrect_client_credentials
            # (the secret here does not match the OAuth app) or a redirect_uri
            # mismatch. Passing it through turns a dead end into a fix.
            reason = token_body.get("error_description") or token_body.get("error") or "unknown reason"
            raise HTTPException(400, f"GitHub refused the token exchange: {reason}")
        profile = (
            await client.get(
                "https://api.github.com/user",
                headers={
                    "Authorization": f"Bearer {access}",
                    "Accept": "application/vnd.github+json",
                },
            )
        ).json()

    gh_id = profile.get("id")
    if not gh_id:
        raise HTTPException(400, "GitHub profile had no id")

    user = (
        await db.execute(select(User).where(User.github_id == int(gh_id)))
    ).scalar_one_or_none()
    login = _HANDLE_RE.sub("", str(profile.get("login") or f"user{gh_id}"))[:64]
    if user is None:
        user = User(
            github_id=int(gh_id),
            handle=login,
            display_name=str(profile.get("name") or login)[:128],
            avatar_url=str(profile.get("avatar_url") or "")[:512],
        )
        db.add(user)
        await db.flush()
    else:
        user.handle = login
        user.display_name = str(profile.get("name") or login)[:128]
        user.avatar_url = str(profile.get("avatar_url") or "")[:512]

    pair_code = await mint_pair_code(db, user.id)
    await db.commit()

    mins = get_settings().pair_code_ttl_secs // 60
    return HTMLResponse(_pair_page(html.escape(user.handle), html.escape(pair_code), mins))


def _pair_page(handle: str, code: str, mins: int) -> str:
    return f"""<!doctype html><meta charset="utf-8">
<title>Claude HQ Arena &middot; pairing code</title>
<style>
  :root {{ color-scheme: dark; }}
  body {{ margin:0; min-height:100vh; display:grid; place-items:center;
         background:#0e1117; color:#e6edf3;
         font:15px/1.5 ui-sans-serif,-apple-system,Segoe UI,Roboto,sans-serif; }}
  .card {{ max-width:30rem; padding:2rem; text-align:center; }}
  code {{ display:block; margin:1.5rem 0; padding:1rem; border-radius:.6rem;
          background:#161b22; border:1px solid #30363d; color:#7ee787;
          font:600 1.6rem/1 ui-monospace,SFMono-Regular,Menlo,monospace;
          letter-spacing:.12em; }}
  p {{ color:#8b949e; }}
</style>
<div class="card">
  <h1>Signed in as {handle}</h1>
  <p>Paste this code into the <strong>&#127942; Arena</strong> tab in Claude HQ:</p>
  <code>{code}</code>
  <p>It expires in {mins} minutes and can be used once.</p>
</div>"""


@router.post("/pair", response_model=PairResponse)
async def pair(req: PairRequest, db: AsyncSession = Depends(get_session)) -> PairResponse:
    user = await consume_pair_code(db, req.code)
    if user is None:
        raise HTTPException(400, "pairing code is invalid, used, or expired")

    token = new_device_token()
    db.add(Device(
        user_id=user.id,
        token_hash=hash_token(token),
        label=(req.label or "claude-hq")[:64],
    ))
    await db.commit()
    return PairResponse(
        token=token,
        handle=user.handle,
        displayName=user.display_name or user.handle,
        avatarUrl=user.avatar_url,
    )


@router.post("/ticket", response_model=TicketResponse)
async def ticket(caller: Caller = Depends(require_device)) -> TicketResponse:
    """Exchange a long-lived device token for a short-lived websocket ticket.

    Keeps the device token out of the browser page and out of WS query strings.
    """
    return TicketResponse(
        ticket=issue_ws_ticket(caller.user.id, caller.device.id),
        expiresIn=get_settings().ws_ticket_ttl_secs,
    )


# --- devices ---------------------------------------------------------------

@router.get("/devices", response_model=DevicesResponse)
async def list_devices(
    caller: Caller = Depends(require_device),
    db: AsyncSession = Depends(get_session),
) -> DevicesResponse:
    """The caller's paired devices that still work, most recently used first."""
    rows = (
        await db.execute(
            select(Device).where(Device.user_id == caller.user.id, Device.revoked.is_(False))
        )
    ).scalars().all()
    rows = sorted(
        rows,
        key=lambda d: (d.id != caller.device.id, -_ts(d.last_seen_at or d.created_at)),
    )
    return DevicesResponse(devices=[
        DeviceInfo(
            id=d.id, label=d.label, created=d.created_at, lastSeen=d.last_seen_at,
            current=d.id == caller.device.id,
        )
        for d in rows
    ])


def _ts(dt) -> float:
    return _aware(dt).timestamp() if dt is not None else 0.0


async def _revoke(db: AsyncSession, device: Device) -> RevokeResponse:
    device.revoked = True
    await db.commit()
    closed = await manager.evict_device(device.id)
    return RevokeResponse(revoked=device.id, closedSockets=closed)


@router.post("/devices/{device_id}/revoke", response_model=RevokeResponse)
async def revoke_device(
    device_id: str,
    caller: Caller = Depends(require_device),
    db: AsyncSession = Depends(get_session),
) -> RevokeResponse:
    """Sign out one of your own devices (a lost laptop, an old install)."""
    device = await db.get(Device, device_id[:36])
    # 404 for someone else's device too: never confirm another user's ids.
    if device is None or device.user_id != caller.user.id or device.revoked:
        raise HTTPException(404, "no such device")
    return await _revoke(db, device)


@router.post("/revoke-self", response_model=RevokeResponse)
async def revoke_self(
    caller: Caller = Depends(require_device),
    db: AsyncSession = Depends(get_session),
) -> RevokeResponse:
    """Revoke the calling device's own token. Claude HQ calls this on unpair."""
    device = await db.get(Device, caller.device.id)
    return await _revoke(db, device)
