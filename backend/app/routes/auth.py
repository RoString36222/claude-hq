"""GitHub OAuth, device pairing, and websocket tickets."""
import html
import re

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import (
    Caller, check_oauth_state, consume_pair_code, hash_token, issue_oauth_state,
    issue_ws_ticket, mint_pair_code, new_device_token, require_device,
)
from ..config import get_settings
from ..db import get_session
from ..models import Device, User
from ..schemas import PairRequest, PairResponse, TicketResponse

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
        access = tok.json().get("access_token")
        if not access:
            raise HTTPException(400, "GitHub did not return an access token")
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
  <p>Paste this code into <strong>Claude HQ &rarr; Settings &rarr; Arena</strong>:</p>
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
        ticket=issue_ws_ticket(caller.user.id),
        expiresIn=get_settings().ws_ticket_ttl_secs,
    )
