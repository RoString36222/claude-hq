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
    JSON, BigInteger, Boolean, CheckConstraint, Date, DateTime, ForeignKey, Index,
    Integer, Numeric, String, UniqueConstraint, func,
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


class Nudge(Base):
    """A directed "come to the Arena" ping, persisted so it also reaches a friend
    whose Claude HQ is running but who has no Arena tab open. Carries no URL or
    command by design -- only who it is from and an optional short note. The
    recipient's client shows a notification; acting on it is their choice."""

    __tablename__ = "nudges"
    __table_args__ = (
        Index("ix_nudges_to_undelivered", "to_user_id", "delivered_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    from_user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    to_user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    note: Mapped[str] = mapped_column(String(120), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # NULL until the recipient's client has drained it via GET /v1/nudges.
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class PrivateRoom(Base):
    __tablename__ = "private_rooms"
    __table_args__ = (
        UniqueConstraint("name_key", name="uq_private_rooms_name_key"),
    )

    id: Mapped[str] = mapped_column(String(24), primary_key=True)
    name: Mapped[str] = mapped_column(String(40))
    name_key: Mapped[str] = mapped_column(String(255))
    owner_user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    password_hash: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class PrivateRoomMember(Base):
    __tablename__ = "private_room_members"
    __table_args__ = (
        UniqueConstraint("room_id", "user_id", name="uq_private_room_member"),
        CheckConstraint("role IN ('owner','member','banned')", name="ck_private_room_member_role"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    room_id: Mapped[str] = mapped_column(
        ForeignKey("private_rooms.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    role: Mapped[str] = mapped_column(String(8), default="member")
    joined_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class PrivateRoomJoinAttempt(Base):
    __tablename__ = "private_room_join_attempts"
    __table_args__ = (
        Index("ix_private_room_attempts_user_room_at", "user_id", "room_id", "created_at"),
        Index("ix_private_room_attempts_room_at", "room_id", "created_at"),
        Index("ix_private_room_attempts_user_at", "user_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    room_id: Mapped[str] = mapped_column(ForeignKey("private_rooms.id", ondelete="CASCADE"))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class PokeBalance(Base):
    """One row per (user, item). Poke Coins are just the item "coins", so the
    purse and the pantry share one code path. Every change is a conditional
    UPDATE in `pantry.py`; the CHECK is the backstop, and caps live in those
    WHERE clauses rather than the schema so they can change without a rebuild."""

    __tablename__ = "poke_balances"
    __table_args__ = (
        UniqueConstraint("user_id", "item", name="uq_poke_balances_user_item"),
        CheckConstraint("qty >= 0", name="ck_poke_balances_qty_nonneg"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    item: Mapped[str] = mapped_column(String(16))
    qty: Mapped[int] = mapped_column(Integer, server_default="0")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class PokeLedger(Base):
    """The pantry journal: one row per claim, buy, eat or give. It is also the
    idempotency store (UNIQUE per user and request id; the daily claim is the
    reserved id "claim:YYYY-MM-DD"), the source of the daily caps, and the gift
    inbox. It holds no session ids, titles or paths."""

    __tablename__ = "poke_ledger"
    __table_args__ = (
        UniqueConstraint("user_id", "request_id", name="uq_poke_ledger_user_request"),
        CheckConstraint("op IN ('claim','buy','eat','give','quest','cosmetic','sell')", name="ck_poke_ledger_op"),
        CheckConstraint("qty >= 0", name="ck_poke_ledger_qty_nonneg"),
        CheckConstraint("coins >= 0", name="ck_poke_ledger_coins_nonneg"),
        Index("ix_poke_ledger_user_date", "user_id", "op_date"),
        Index("ix_poke_ledger_to_date", "to_user_id", "op_date"),
        Index("ix_poke_ledger_to_undelivered", "to_user_id", "delivered_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    # The actor.
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    request_id: Mapped[str] = mapped_column(String(64))
    op: Mapped[str] = mapped_column(String(8))
    op_date: Mapped[date] = mapped_column(Date)  # UTC
    kind: Mapped[str | None] = mapped_column(String(16), nullable=True)
    qty: Mapped[int] = mapped_column(Integer, server_default="0")
    coins: Mapped[int] = mapped_column(Integer, server_default="0")
    # SET NULL, not CASCADE: deleting a recipient keeps the sender's history
    # and idempotency.
    to_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    note: Mapped[str] = mapped_column(String(80), server_default="")
    # Set in Python rather than by the server so a replay can return it.
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    # NULL until the gift reached the recipient, live or via the drain.
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class TacoOrder(Base):
    """One California Burrito dinner, logged by whoever picked up the tab.

    The deal is buy-1-get-1 pooled across the whole table, so the free tacos are
    a property of the *order*, not of any one diner: an odd count per person is
    fine as long as the table's total is even. `total_tacos` and `paid_tacos`
    are the receipt as priced at the time, computed server-side in `tacos.py` --
    a client never submits them, for the same reason it never submits an XP
    score.
    """

    __tablename__ = "taco_orders"
    __table_args__ = (
        UniqueConstraint("user_id", "request_id", name="uq_taco_orders_user_request"),
        CheckConstraint("total_tacos >= 0", name="ck_taco_orders_total_nonneg"),
        CheckConstraint("paid_tacos >= 0", name="ck_taco_orders_paid_nonneg"),
        CheckConstraint("paid_tacos <= total_tacos", name="ck_taco_orders_paid_le_total"),
        Index("ix_taco_orders_date", "order_date"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    # Who logged it. Not "who ate" -- that is taco_diners.
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    request_id: Mapped[str] = mapped_column(String(64))
    order_date: Mapped[date] = mapped_column(Date)

    total_tacos: Mapped[int] = mapped_column(Integer, server_default="0")
    paid_tacos: Mapped[int] = mapped_column(Integer, server_default="0")

    note: Mapped[str] = mapped_column(String(80), server_default="")
    # Set in Python rather than by the server so a replay can return it.
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    diners: Mapped[list["TacoDiner"]] = relationship(
        back_populates="order", cascade="all, delete-orphan", lazy="selectin"
    )


class TacoDiner(Base):
    """What one person at the table ordered, by variant.

    `user_id` is nullable on purpose: a founder who has paired a device gets a
    real account (and an avatar on the board), and anyone else is carried by
    name alone. SET NULL, not CASCADE, so deleting an account leaves the
    dinner's history intact -- `diner_name` is always written, so the row keeps
    an identity either way.
    """

    __tablename__ = "taco_diners"
    __table_args__ = (
        CheckConstraint(
            "user_id IS NOT NULL OR diner_name <> ''", name="ck_taco_diners_identity"
        ),
        CheckConstraint(
            "mild_hard >= 0 AND mild_soft >= 0 AND wild_hard >= 0 AND wild_soft >= 0",
            name="ck_taco_diners_counts_nonneg",
        ),
        Index("ix_taco_diners_user", "user_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    order_id: Mapped[str] = mapped_column(
        ForeignKey("taco_orders.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    diner_name: Mapped[str] = mapped_column(String(40), server_default="")

    mild_hard: Mapped[int] = mapped_column(Integer, server_default="0")
    mild_soft: Mapped[int] = mapped_column(Integer, server_default="0")
    wild_hard: Mapped[int] = mapped_column(Integer, server_default="0")
    wild_soft: Mapped[int] = mapped_column(Integer, server_default="0")
    # The rest of the menu, {menu key: count}: positive counts only, keys in
    # tacos.CALI_MENU order. Recorded and reported, never priced or scored.
    items: Mapped[dict] = mapped_column(JSON, server_default="{}", default=dict)

    order: Mapped[TacoOrder] = relationship(back_populates="diners")

    @property
    def tacos(self) -> int:
        return self.mild_hard + self.mild_soft + self.wild_hard + self.wild_soft


class RoomFarm(Base):
    """The Valley's shared garden for one room: plots, seeds and who gardens there.
    One small JSON document per room; water is read from daily_stats, not stored."""

    __tablename__ = "room_farms"

    room_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    data: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class HqProfile(Base):
    """Your 3D HQ as visitors see it (HQ 2.1): whether it is open to them, how the
    building looks, and how many of your crew are working / need you / idle.
    Counts and cosmetics only: no session titles, projects, paths or anything a
    transcript said ever reach this table. The level is never stored here; it is
    scored from daily_stats when someone visits."""

    __tablename__ = "hq_profiles"

    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    open: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    look: Mapped[dict] = mapped_column(JSON, default=dict)
    crew: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class GameResult(Base):
    """One player's result in one finished multiplayer game the Arena refereed
    (Kart, Platformer, Blaster, Golf). Written by the server when the game ends,
    never by a client, so leaderboards, profiles and game XP can be trusted."""

    __tablename__ = "game_results"
    __table_args__ = (Index("ix_game_results_board", "game", "key", "value"),
                      Index("ix_game_results_user", "user_id", "at"))

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"))
    game: Mapped[str] = mapped_column(String(8))          # kart | plat | fps | golf
    key: Mapped[str] = mapped_column(String(40))          # track / level / course ("match" for fps)
    mode: Mapped[str] = mapped_column(String(16), default="")
    place: Mapped[int] = mapped_column(Integer)
    players: Mapped[int] = mapped_column(Integer)
    value: Mapped[int | None] = mapped_column(Integer, nullable=True)   # ms, strokes or kills; lower is better except kills
    extra: Mapped[dict] = mapped_column(JSON, default=dict)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class EquippedCosmetics(Base):
    """What a trainer wears (HQ 2.1 cosmetics): slot -> item id. Owning an item is a
    PokeBalance row "cos:<id>" (bought through the pantry ledger) or a level unlock."""

    __tablename__ = "equipped_cosmetics"

    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    slots: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
