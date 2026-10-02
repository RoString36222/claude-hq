"""Soundboard clips served from a directory on the Arena host.

The audio files live on the server (and are git-ignored), so the public repo
never carries them. Both listing and fetching require a paired device -- the
same gate as every other /v1 route -- so a clip is only reachable by an
authenticated member.

Adding a sound is just dropping a file into ARENA_SOUNDS_DIR; it appears in the
next GET /v1/sounds with no code change.
"""
from __future__ import annotations

import re
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse

from ..auth import Caller, require_device
from ..config import get_settings

router = APIRouter(prefix="/v1", tags=["sounds"])

# Characters we keep in a stored filename; everything else becomes "_". Keeps a
# label readable while blocking path tricks and shell-surprising names.
_SAFE_NAME = re.compile(r"[^A-Za-z0-9 ._()-]")
_MAX_NAME_LEN = 80

# Extensions we are willing to list and serve, mapped to their MIME type.
_AUDIO_TYPES = {
    ".ogg": "audio/ogg",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".webm": "audio/webm",
}


def _sounds_dir() -> Path:
    return Path(get_settings().sounds_dir).expanduser().resolve()


@router.get("/sounds")
async def list_sounds(caller: Caller = Depends(require_device)) -> dict:
    """List the available clips. `name` is the filename without extension --
    the label the soundboard shows; `file` is what GET /v1/sounds/{file} wants."""
    d = _sounds_dir()
    out = []
    if d.is_dir():
        for p in sorted(d.iterdir()):
            if p.is_file() and p.suffix.lower() in _AUDIO_TYPES:
                out.append({"name": p.stem, "file": p.name, "size": p.stat().st_size})
    return {"sounds": out}


@router.post("/sounds", status_code=201)
async def upload_sound(
    request: Request,
    name: str,
    caller: Caller = Depends(require_device),
) -> dict:
    """Store an uploaded clip so it joins the soundboard -- the web equivalent of
    SSHing in to drop a file in the sounds dir. The raw audio is the request
    body; `name` (a query param) is the desired filename, and its extension
    decides the type. Same device gate as the rest of /v1/sounds."""
    settings = get_settings()

    safe = _SAFE_NAME.sub("_", Path(name).name).strip()  # basename, tamed
    ext = Path(safe).suffix.lower()
    if not safe or safe.startswith(".") or ext not in _AUDIO_TYPES:
        allowed = ", ".join(sorted(_AUDIO_TYPES))
        raise HTTPException(400, f"name must be an audio file ({allowed})")
    if len(safe) > _MAX_NAME_LEN:
        safe = safe[: _MAX_NAME_LEN - len(ext)] + ext

    data = await request.body()
    if not data:
        raise HTTPException(400, "empty upload")
    if len(data) > settings.max_sound_bytes:
        mb = settings.max_sound_bytes // (1024 * 1024)
        raise HTTPException(413, f"file too large (max {mb} MB)")

    d = _sounds_dir()
    d.mkdir(parents=True, exist_ok=True)
    target = (d / safe).resolve()
    if d not in target.parents:  # last guard against any traversal
        raise HTTPException(400, "bad name")
    if target.exists():
        raise HTTPException(409, "a sound with that name already exists")

    # Write to a temp sibling then rename, so a half-sent upload never shows up
    # as a playable (truncated) clip.
    tmp = target.with_name(target.name + ".part")
    tmp.write_bytes(data)
    tmp.replace(target)
    return {"name": target.stem, "file": target.name, "size": len(data)}


@router.get("/sounds/{file}")
async def get_sound(file: str, caller: Caller = Depends(require_device)) -> FileResponse:
    d = _sounds_dir()
    # Resolve, then confirm the result is still inside the sounds dir: this
    # blocks "../" and absolute-path escapes before we touch the filesystem.
    target = (d / file).resolve()
    if d not in target.parents or target.suffix.lower() not in _AUDIO_TYPES or not target.is_file():
        raise HTTPException(404, "no such sound")
    return FileResponse(
        target,
        media_type=_AUDIO_TYPES[target.suffix.lower()],
        headers={"Cache-Control": "public, max-age=300"},
    )
