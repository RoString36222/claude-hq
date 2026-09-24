"""
Database schema.

Modelling note: the local client reports **raw per-day activity counts**
(prompts, tool calls, artifacts, tokens). It does not report a score. XP,
levels, streaks and ranks are all derived server-side in `scoring.py`, so the
formula can change without a client release and so inflating a score means
faking plausible daily activity rather than POSTing `{"xp": 999999}`.

`daily_stats` is upserted per (user, day) because a day's counts only ever grow
as the client re-scans; `stat_snapshots` keeps every raw submission so the board
can be recomputed from scratch if the scoring rules change.
"""
import uuid
from datetime import date, datetime

from sqlalchemy import (
    JSON, BigInteger, Boolean, Date, DateTime, ForeignKey, Index, Integer,
    Numeric, String, UniqueConstraint, func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def _uuid() -> str:
    return str(uuid.uuid4())


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    github_id: Mapped[int] = mapped_column(BigInteger, unique=True, index=True)
    handle: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(128), default="")
    avatar_url: Mapped[str] = mapped_column(String(512), default="")
    # Set by the client; lets people show a Trainer name distinct from GitHub.
    trainer_name: Mapped[str] = mapped_column(String(32), default="")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    devices: Mapped[list["Device"]] = relationship(back_populates="user", cascade="all, delete-orphan")


class Device(Base):
    """One paired machine. A person may run Claude HQ on a laptop and a desktop."""

    __tablename__ = "devices"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    label: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)

    user: Mapped[User] = relationship(back_populates="devices")


class PairCode(Base):
    """Short-lived code handed to the browser after OAuth, pasted into the local app."""

    __tablename__ = "pair_codes"

    code: Mapped[str] = mapped_column(String(32), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class DailyStat(Base):
    """Authoritative per-user, per-day activity. Upserted; never summed twice."""

    __tablename__ = "daily_stats"
    __table_args__ = (
        UniqueConstraint("user_id", "stat_date", name="uq_daily_user_date"),
        Index("ix_daily_date", "stat_date"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    stat_date: Mapped[date] = mapped_column(Date)

    prompts: Mapped[int] = mapped_column(Integer, default=0)
    tools: Mapped[int] = mapped_column(Integer, default=0)
    artifacts: Mapped[int] = mapped_column(Integer, default=0)
    replies: Mapped[int] = mapped_column(Integer, default=0)

    tokens_input: Mapped[int] = mapped_column(BigInteger, default=0)
    tokens_output: Mapped[int] = mapped_column(BigInteger, default=0)
    tokens_cache_read: Mapped[int] = mapped_column(BigInteger, default=0)
    tokens_cache_creation: Mapped[int] = mapped_column(BigInteger, default=0)

    # Opt-in only. NULL means the user chose not to share spend.
    cost_usd: Mapped[float | None] = mapped_column(Numeric(10, 4), nullable=True)

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class DailyToolStat(Base):
    """Per-day tool usage. Tool names are allowlisted client-side before sending."""

    __tablename__ = "daily_tool_stats"
    __table_args__ = (
        UniqueConstraint("user_id", "stat_date", "tool_name", name="uq_tool_user_date_name"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    stat_date: Mapped[date] = mapped_column(Date)
    tool_name: Mapped[str] = mapped_column(String(48))
    count: Mapped[int] = mapped_column(Integer, default=0)


class StatSnapshot(Base):
    """Append-only raw submissions, kept so the board can be recomputed."""

    __tablename__ = "stat_snapshots"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    device_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
    payload: Mapped[dict] = mapped_column(JSON)


class Season(Base):
    __tablename__ = "seasons"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    slug: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(128))
    starts_on: Mapped[date] = mapped_column(Date)
    ends_on: Mapped[date] = mapped_column(Date)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
