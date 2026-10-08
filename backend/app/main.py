"""Claude HQ Arena -- the multiplayer backend."""
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .config import get_settings
from .db import Base, describe_backend, engine
from .routes import auth as auth_routes
from .routes import board as board_routes
from .routes import hq as hq_routes
from .routes import progress as progress_routes
from .routes import cosmetics as cosmetic_routes
from .routes import server as server_routes
from .routes import crews as crew_routes
from .routes import nudges as nudge_routes
from .routes import pantry as pantry_routes
from .routes import private_rooms as private_room_routes
from .routes import rooms as room_routes
from .routes import sounds as sound_routes
from .routes import stats as stats_routes
from .routes import tacos as taco_routes


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Alembic owns the schema in production; this only helps SQLite dev/test runs.
    if get_settings().is_sqlite:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    yield
    await engine.dispose()


app = FastAPI(title="Claude HQ Arena", version="0.1.0", lifespan=lifespan)


@app.exception_handler(RequestValidationError)
async def _scrub_422(_request: Request, exc: RequestValidationError) -> JSONResponse:
    safe = []
    for err in exc.errors():
        entry = {"loc": err.get("loc", []), "msg": err.get("msg", ""), "type": err.get("type", "")}
        safe.append(entry)
    return JSONResponse(status_code=422, content={"detail": safe})


# The dashboard proxies API calls server-side, so the browser never calls us
# cross-origin for authenticated routes. Websockets are exempt from CORS and are
# guarded by short-lived tickets instead.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:8765", "http://localhost:8765"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)

app.include_router(auth_routes.router)
app.include_router(stats_routes.router)
app.include_router(board_routes.router)
app.include_router(nudge_routes.router)
app.include_router(pantry_routes.router)
app.include_router(room_routes.router)
app.include_router(sound_routes.router)
app.include_router(private_room_routes.router)
app.include_router(taco_routes.router)
app.include_router(hq_routes.router)
app.include_router(progress_routes.router)
app.include_router(cosmetic_routes.router)
app.include_router(cosmetic_routes.market)
app.include_router(server_routes.router)
app.include_router(crew_routes.router)


# Stamped into the image by ops/release.sh (a date + commit, e.g. 2026.10.07-76ee057).
ARENA_VERSION = os.environ.get("ARENA_VERSION", "dev")


if os.environ.get("ARENA_EXPOSE_REALTIME_STATS") == "1":
    # Only for scripts/loadtest.py: per-room tick counts, overruns and bytes/s.
    from . import realtime

    @app.get("/v1/realtime/stats")
    async def realtime_stats() -> dict:
        return realtime.stats()


@app.get("/health")
async def health() -> dict:
    try:
        db = await describe_backend()
    except Exception as exc:
        # Report unhealthy rather than 200-with-a-broken-database.
        return {"ok": False, "service": "claude-hq-arena", "impl": "py", "version": ARENA_VERSION,
                "db": f"unreachable: {exc}"}
    return {"ok": True, "service": "claude-hq-arena", "impl": "py", "version": ARENA_VERSION, "db": db}
