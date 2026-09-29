"""
California Burrito taco Tuesdays: the order log and the cali-leaderboard.

The deal is **buy 1 get 1, pooled across the whole table**. That pooling is the
whole point of logging an order rather than a person: each founder can want an
odd number of tacos, and as long as the table's total is even nobody pays for a
leftover. So the price is a property of the order --

    paid = ceil(TT / 2)

-- and it is computed here, never submitted. Same rule as the XP board: a client
sends what it saw (who ate what), the server decides what it means.

Two metrics come out of that:

  TT   total tacos -- summed over every diner on the order
  TPP  tacos per person -- TT / people for one dinner, and, on the board,
       a person's tacos divided by the Tuesdays they showed up for

The board ranks by **Tuesdays attended**, with TT as the tiebreak: turning up is
the score, appetite only settles ties.
"""
from datetime import UTC, date, datetime

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.ext.asyncio import AsyncSession

from .models import TacoDiner, TacoOrder, User
from .schemas import (
    CaliBoardEntry, CaliBoardResponse, LogOrderRequest, LogOrderResponse, OrderDinerOut,
    OrderOut, OrdersResponse, TacoCounts,
)
from .service import WINDOWS, window_range

# (schema field, column name) for the four mild/wild x hard/soft variants.
VARIANTS = (
    ("mildHard", "mild_hard"),
    ("mildSoft", "mild_soft"),
    ("wildHard", "wild_hard"),
    ("wildSoft", "wild_soft"),
)

RECENT_ORDERS = 50

_BUSY = "busy, try again"
_REUSED = "that requestId was already used for a different order"


# Clock seam: tests monkeypatch this.
def _today() -> date:
    return datetime.now(UTC).date()


def _now() -> datetime:
    return datetime.now(UTC)


def _aware(dt: datetime) -> datetime:
    # SQLite hands back naive datetimes; everything here is written in UTC.
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt


def paid_tacos(total: int) -> int:
    """What the table actually pays for under a pooled buy-1-get-1.

    Every second taco is free regardless of mild/wild or hard/soft, so an odd
    total pays for the odd one out and nothing else. This is the one place the
    deal is encoded.
    """
    return (total + 1) // 2


def _round2(value: float) -> float:
    return round(value + 0.0, 2)


def _tpp(tacos: int, people: int) -> float:
    """Tacos per person. Zero people is not a dinner, but never divide by it."""
    return _round2(tacos / people) if people else 0.0


def _counts_of(row: TacoDiner) -> TacoCounts:
    return TacoCounts(
        mildHard=row.mild_hard, mildSoft=row.mild_soft,
        wildHard=row.wild_hard, wildSoft=row.wild_soft,
    )


def _order_out(order: TacoOrder, users: dict[str, User], logged_by: str) -> OrderOut:
    diners = []
    for row in order.diners:
        u = users.get(row.user_id) if row.user_id else None
        diners.append(OrderDinerOut(
            handle=u.handle if u else None,
            name=(u.display_name or u.handle) if u else row.diner_name,
            avatarUrl=u.avatar_url if u else "",
            tacos=_counts_of(row),
            total=row.tacos,
        ))
    people = len(order.diners)
    return OrderOut(
        id=order.id,
        date=order.order_date,
        people=people,
        totalTacos=order.total_tacos,
        paidTacos=order.paid_tacos,
        freeTacos=order.total_tacos - order.paid_tacos,
        tacosPerPerson=_tpp(order.total_tacos, people),
        note=order.note,
        loggedByHandle=logged_by,
        createdAt=_aware(order.created_at).isoformat(),
        diners=diners,
    )


async def _users_by_id(db: AsyncSession, ids: set[str]) -> dict[str, User]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    rows = (await db.execute(select(User).where(User.id.in_(ids)))).scalars().all()
    return {u.id: u for u in rows}


async def _find_order(db: AsyncSession, uid: str, rid: str) -> TacoOrder | None:
    return (
        await db.execute(
            select(TacoOrder).where(TacoOrder.user_id == uid, TacoOrder.request_id == rid)
        )
    ).scalar_one_or_none()


async def log_order(db: AsyncSession, user: User, body: LogOrderRequest) -> LogOrderResponse:
    """Record one dinner. Idempotent by requestId, so the phone that lost its
    connection mid-tap can retry without logging Tuesday twice."""
    when = body.date or _today()
    if when > _today():
        raise HTTPException(400, "that dinner hasn't happened yet")

    prior = await _find_order(db, user.id, body.requestId)
    if prior is not None:
        return LogOrderResponse(order=await _hydrate(db, prior, user), replayed=True)

    # Resolve every handle before writing, so an unknown one fails the whole
    # order rather than silently demoting that person to a name.
    handles = [d.handle for d in body.diners if d.handle]
    found: dict[str, User] = {}
    if handles:
        rows = (
            await db.execute(select(User).where(User.handle.in_(handles)))
        ).scalars().all()
        found = {u.handle: u for u in rows}
    for h in handles:
        if h not in found:
            raise HTTPException(404, f"no such person: {h}")

    total = sum(d.tacos.total for d in body.diners)
    order = TacoOrder(
        user_id=user.id, request_id=body.requestId, order_date=when,
        total_tacos=total, paid_tacos=paid_tacos(total), note=body.note,
        created_at=_now(),
    )
    for d in body.diners:
        u = found.get(d.handle) if d.handle else None
        order.diners.append(TacoDiner(
            user_id=u.id if u else None,
            # Always written, so the row keeps an identity after the account's
            # ondelete=SET NULL.
            diner_name=(u.display_name or u.handle) if u else d.name,
            **{col: getattr(d.tacos, field) for field, col in VARIANTS},
        ))

    try:
        db.add(order)
        await db.commit()
    except IntegrityError:
        # Almost always a concurrent submit of the same requestId that won the
        # race: replay it.
        await db.rollback()
        if user in db:
            await db.refresh(user)
        prior = await _find_order(db, user.id, body.requestId)
        if prior is not None:
            return LogOrderResponse(order=await _hydrate(db, prior, user), replayed=True)
        raise HTTPException(503, _BUSY) from None
    except OperationalError:
        # SQLite's busy_timeout ran out under a burst of writers.
        await db.rollback()
        raise HTTPException(503, _BUSY) from None

    return LogOrderResponse(order=await _hydrate(db, order, user), replayed=False)


async def _hydrate(db: AsyncSession, order: TacoOrder, logged_by: User) -> OrderOut:
    users = await _users_by_id(db, {d.user_id for d in order.diners})
    return _order_out(order, users, logged_by.handle)


async def list_orders(db: AsyncSession, limit: int = RECENT_ORDERS) -> OrdersResponse:
    """Recent dinners, newest first. Everyone with a paired device sees the same
    log -- it is one shared table, not a per-user diary."""
    orders = (
        await db.execute(
            select(TacoOrder)
            .order_by(TacoOrder.order_date.desc(), TacoOrder.created_at.desc())
            .limit(limit)
        )
    ).scalars().all()

    owners = await _users_by_id(db, {o.user_id for o in orders})
    diner_users = await _users_by_id(
        db, {d.user_id for o in orders for d in o.diners if d.user_id}
    )
    return OrdersResponse(orders=[
        _order_out(o, diner_users, owners[o.user_id].handle if o.user_id in owners else "")
        for o in orders
    ])


async def build_board(
    db: AsyncSession, window: str, viewer_id: str | None = None
) -> CaliBoardResponse:
    """The cali-leaderboard: Tuesdays attended, TT as the tiebreak.

    Aggregated in Python rather than SQL because a person is keyed by account
    when they have one and by name when they don't, which is a COALESCE over two
    columns of different provenance. A founders' dinner log is a few hundred rows
    a year, so the clarity is worth more than the pushdown.

    One consequence of that key: someone logged by handle one week and by a bare
    name the next is two people on the board. Pair the device, or spell the name
    the same way.
    """
    if window not in WINDOWS:
        raise HTTPException(400, f"window must be one of {', '.join(WINDOWS)}")

    today = _today()
    starts_on, ends_on = window_range(window, today)

    rows = (
        await db.execute(
            select(TacoDiner, TacoOrder)
            .join(TacoOrder, TacoOrder.id == TacoDiner.order_id)
            .where(TacoOrder.order_date >= starts_on, TacoOrder.order_date <= ends_on)
        )
    ).all()

    users = await _users_by_id(db, {d.user_id for d, _ in rows if d.user_id})

    people: dict[str, dict] = {}
    order_ids: set[str] = set()
    total = paid = 0

    for diner, order in rows:
        if order.id not in order_ids:
            order_ids.add(order.id)
            total += order.total_tacos
            paid += order.paid_tacos

        key = f"@{diner.user_id}" if diner.user_id else f"#{diner.diner_name.casefold()}"
        u = users.get(diner.user_id) if diner.user_id else None
        p = people.setdefault(key, {
            "handle": u.handle if u else None,
            "name": (u.display_name or u.handle) if u else diner.diner_name,
            "avatarUrl": u.avatar_url if u else "",
            "dates": set(),
            "tacos": 0, "mild": 0, "wild": 0, "hard": 0, "soft": 0,
            "isYou": bool(viewer_id and diner.user_id == viewer_id),
        })
        p["dates"].add(order.order_date)
        p["tacos"] += diner.tacos
        p["mild"] += diner.mild_hard + diner.mild_soft
        p["wild"] += diner.wild_hard + diner.wild_soft
        p["hard"] += diner.mild_hard + diner.wild_hard
        p["soft"] += diner.mild_soft + diner.wild_soft

    ranked = sorted(
        people.values(),
        # Tuesdays first, then TT, then name so the order is stable across calls.
        key=lambda p: (-len(p["dates"]), -p["tacos"], p["name"].casefold()),
    )

    entries = [
        CaliBoardEntry(
            rank=i,
            handle=p["handle"],
            name=p["name"],
            avatarUrl=p["avatarUrl"],
            tuesdays=len(p["dates"]),
            totalTacos=p["tacos"],
            tacosPerPerson=_tpp(p["tacos"], len(p["dates"])),
            mild=p["mild"], wild=p["wild"], hard=p["hard"], soft=p["soft"],
            isYou=p["isYou"],
        )
        for i, p in enumerate(ranked, start=1)
    ]

    return CaliBoardResponse(
        window=window,
        startsOn=starts_on,
        endsOn=ends_on,
        generatedAt=_now().isoformat(),
        orders=len(order_ids),
        totalTacos=total,
        paidTacos=paid,
        freeTacos=total - paid,
        entries=entries,
    )
