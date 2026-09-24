"""Async engine and session plumbing."""
from collections.abc import AsyncIterator

from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from .config import get_settings


class Base(DeclarativeBase):
    pass


_settings = get_settings()

if _settings.is_sqlite:
    # Self-hosted deployments run on SQLite, so this is a real database now,
    # not just a test convenience.
    engine = create_async_engine(_settings.database_url, echo=False)

    @event.listens_for(engine.sync_engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _record):
        cur = dbapi_conn.cursor()
        # WAL lets the SSE/board readers work while a publish is writing;
        # the default rollback journal would block them.
        cur.execute("PRAGMA journal_mode=WAL")
        # Wait rather than raising "database is locked" under a burst of
        # publishes from several friends at once.
        cur.execute("PRAGMA busy_timeout=5000")
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.close()
else:
    engine = create_async_engine(_settings.database_url, echo=False, pool_pre_ping=True)

SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def get_session() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        yield session


async def describe_backend() -> str:
    """One-line description of the live database, for /health."""
    async with engine.connect() as conn:
        if _settings.is_sqlite:
            mode = (await conn.execute(text("PRAGMA journal_mode"))).scalar()
            return f"sqlite (journal_mode={mode})"
        ver = (await conn.execute(text("SHOW server_version"))).scalar()
        return f"postgres {ver}"
