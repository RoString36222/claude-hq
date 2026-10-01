"""Soundboard clips served from a directory on the Arena host.

The audio files live on the server (and are git-ignored), so the public repo
never carries them. Both listing and fetching require a paired device -- the
same gate as every other /v1 route -- so a clip is only reachable by an
authenticated member.

Adding a sound is just dropping a file into ARENA_SOUNDS_DIR; it appears in the
next GET /v1/sounds with no code change.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse

from ..auth import Caller, require_device
from ..config import get_settings

router = APIRouter(prefix="/v1", tags=["sounds"])

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
