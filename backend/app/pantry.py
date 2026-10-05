"""
Poke Coins, pantry and gifts. The server is the authority; arena.py FOOD_KINDS
and dashboard.py FOOD_EFFECTS mirror CATALOG.

Coins and food are cosmetic: they never touch XP, scoring or the board. The
store's stock follows the UTC season, and one in-stock food a day is the
special, a coin off; both are pure functions of the date (season_of,
special_of), so they need no storage. Every write is one transaction in a
fixed order:

1. the journal INSERT into `poke_ledger`, flushed. It is the first write, so on
   SQLite (pysqlite's lazy BEGIN) it takes the database write lock here, and it
   claims the request id under UNIQUE(user_id, request_id);
2. the daily cap counts, which are exact because they are read under that lock
   and include the row just inserted;
3. conditional debits (`WHERE qty >= n`);
4. conditional credits (`WHERE qty + n <= cap`);
5. commit.

Any refused guard rolls the whole thing back, journal row included, so a retry
with the same request id re-executes; a request id that already committed
replays its result instead of spending twice. CHECK(qty >= 0) is the backstop.
There are no savepoints: a failure always discards the whole transaction.
"""
import hashlib
from datetime import UTC, date, datetime, time, timedelta
from functools import lru_cache

from fastapi import HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.ext.asyncio import AsyncSession

from .models import PokeBalance, PokeLedger, User
from .rooms import manager
from .routes.nudges import _deliver_live
from .schemas import (
    BuyRequest, BuyResponse, ClaimResponse, DrainedGift, EatRequest, EatResponse,
    GiftsResponse, GiveRequest, GiveResponse, QuestRewardRequest, QuestRewardResponse,
    SentGift,
)

DAILY_COINS = 5
COIN_CAP = 30
ITEM_CAP = 10
BUY_MAX_QTY = 5
GIFT_MAX_COINS = 5
GIFT_MAX_QTY = 3
GIFTS_PER_DAY = 8
GIFTS_PER_PAIR_PER_DAY = 3
RECEIVE_COINS_PER_DAY = 15
RECEIVE_ITEMS_PER_DAY = 10
MAX_OPS_PER_DAY = 200
STARTER = ("riceball", 1)
RECENT_GIFTS = 5
RECENT_GIFT_DAYS = 7
DRAIN_LIMIT = 50

# A pure literal: the client's tests/test_catalog_sync.py ast-parses it, so keep
# it free of names and calls. Keys are in display order; schemas.FoodKind lists
# them too. "season" is when the store stocks it ("all" = year-round); food you
# already hold can be eaten or gifted in any season. A revive item wakes a
# fainted creature and then takes restoreMins off on top.
CATALOG = {
    "berry":       {"name": "Berry",              "plural": "Berries",              "emoji": "\U0001FAD0", "price": 1, "restoreMins": 20,  "revives": False, "season": "all"},
    "bread":       {"name": "Bread Loaf",         "plural": "Bread Loaves",         "emoji": "\U0001F35E", "price": 1, "restoreMins": 20,  "revives": False, "season": "all"},
    "riceball":    {"name": "Rice Ball",          "plural": "Rice Balls",           "emoji": "\U0001F359", "price": 2, "restoreMins": 45,  "revives": False, "season": "all"},
    "coffee":      {"name": "Coffee",             "plural": "Coffees",              "emoji": "☕",     "price": 2, "restoreMins": 45,  "revives": False, "season": "all"},
    "bento":       {"name": "Bento",              "plural": "Bentos",               "emoji": "\U0001F371", "price": 3, "restoreMins": 120, "revives": False, "season": "all"},
    "noodles":     {"name": "Noodle Bowl",        "plural": "Noodle Bowls",         "emoji": "\U0001F35C", "price": 3, "restoreMins": 120, "revives": False, "season": "all"},
    "hotpot":      {"name": "Hot Pot",            "plural": "Hot Pots",             "emoji": "\U0001F372", "price": 4, "restoreMins": 180, "revives": False, "season": "all"},
    "tonic":       {"name": "Revive Tonic",       "plural": "Revive Tonics",        "emoji": "\U0001F9C3", "price": 5, "restoreMins": 0,   "revives": True,  "season": "all"},
    "elixir":      {"name": "Honey Elixir",       "plural": "Honey Elixirs",        "emoji": "\U0001F36F", "price": 7, "restoreMins": 60,  "revives": True,  "season": "all"},
    "strawberry":  {"name": "Strawberry",         "plural": "Strawberries",         "emoji": "\U0001F353", "price": 1, "restoreMins": 25,  "revives": False, "season": "spring"},
    "dango":       {"name": "Hanami Dango",       "plural": "Hanami Dango",         "emoji": "\U0001F361", "price": 2, "restoreMins": 55,  "revives": False, "season": "spring"},
    "omelette":    {"name": "Garden Omelette",    "plural": "Garden Omelettes",     "emoji": "\U0001F373", "price": 3, "restoreMins": 135, "revives": False, "season": "spring"},
    "watermelon":  {"name": "Watermelon Slice",   "plural": "Watermelon Slices",    "emoji": "\U0001F349", "price": 1, "restoreMins": 25,  "revives": False, "season": "summer"},
    "shavedice":   {"name": "Shaved Ice",         "plural": "Shaved Ices",          "emoji": "\U0001F367", "price": 2, "restoreMins": 55,  "revives": False, "season": "summer"},
    "curry":       {"name": "Summer Curry",       "plural": "Summer Curries",       "emoji": "\U0001F35B", "price": 3, "restoreMins": 135, "revives": False, "season": "summer"},
    "apple":       {"name": "Apple",              "plural": "Apples",               "emoji": "\U0001F34E", "price": 1, "restoreMins": 25,  "revives": False, "season": "fall"},
    "sweetpotato": {"name": "Baked Sweet Potato", "plural": "Baked Sweet Potatoes", "emoji": "\U0001F360", "price": 2, "restoreMins": 55,  "revives": False, "season": "fall"},
    "pumpkinstew": {"name": "Pumpkin Stew",       "plural": "Pumpkin Stews",        "emoji": "\U0001F383", "price": 3, "restoreMins": 135, "revives": False, "season": "fall"},
    "chestnuts":   {"name": "Bag of Chestnuts",   "plural": "Bags of Chestnuts",    "emoji": "\U0001F330", "price": 1, "restoreMins": 25,  "revives": False, "season": "winter"},
    "cocoa":       {"name": "Hot Cocoa",          "plural": "Hot Cocoas",           "emoji": "\U0001F36B", "price": 2, "restoreMins": 55,  "revives": False, "season": "winter"},
    "oden":        {"name": "Oden Skewer",        "plural": "Oden Skewers",         "emoji": "\U0001F362", "price": 3, "restoreMins": 135, "revives": False, "season": "winter"},
}

# The UTC month (1-12) -> season, northern-hemisphere meteorological.
SEASON_BY_MONTH = (None, "winter", "winter", "spring", "spring", "spring", "summer",
                   "summer", "summer", "fall", "fall", "fall", "winter")
# Today's special: one in-stock food costing at least this much, this many coins off.
SPECIAL_MIN_PRICE = 2
SPECIAL_DISCOUNT = 1

QUEST_REWARDS_PER_DAY = 10

# A pure literal: quest/achievement id -> coins. The client's catalog matches
# this. The server verifies the claimed coins before crediting.
QUEST_REWARDS = {
    "d_prompts_10": 2, "d_prompts_25": 3, "d_prompts_50": 5,
    "d_tools_50": 2, "d_tools_150": 3, "d_tools_300": 5,
    "d_sessions_3": 2, "d_sessions_5": 3,
    "d_active": 1,
    "d_artifacts_1": 2, "d_artifacts_3": 3,
    "d_feed_creature": 1,
    "w_active_5": 5, "w_active_7": 8,
    "w_prompts_100": 5, "w_prompts_250": 8,
    "w_tools_500": 5,
    "w_streak_5": 5, "w_streak_7": 8,
    "w_folders_3": 3,
}

ACH_REWARDS = {
    "a_first_prompt": {"bronze": 2},
    "a_prompts": {"bronze": 3, "silver": 5, "gold": 10},
    "a_tools": {"bronze": 3, "silver": 5, "gold": 10},
    "a_streak": {"bronze": 3, "silver": 8, "gold": 15},
    "a_active_days": {"bronze": 3, "silver": 8, "gold": 15},
    "a_catch": {"bronze": 3, "silver": 5, "gold": 15},
    "a_shiny": {"bronze": 3, "silver": 5, "gold": 10},
    "a_evolve": {"bronze": 3, "silver": 8, "gold": 15},
    "a_level": {"bronze": 3, "silver": 5, "gold": 15},
    "a_artifacts": {"bronze": 3, "silver": 5, "gold": 10},
    "a_night_owl": {"bronze": 3},
    "a_polyglot": {"bronze": 3, "silver": 5},
    "a_gift": {"bronze": 2, "silver": 5, "gold": 10},
}

_REUSED = "that requestId was already used for a different request"
_BUSY = "busy, try again"


# Clock seams: tests monkeypatch these.
def _today() -> date:
    return datetime.now(UTC).date()


def _now() -> datetime:
    return datetime.now(UTC)


# --- seasons and today's special (pure, deterministic per UTC day) -------------

def season_of(day: date) -> str:
    return SEASON_BY_MONTH[day.month]


def in_stock(kind: str, day: date) -> bool:
    """Whether the store sells `kind` on `day`."""
    season = CATALOG[kind]["season"]
    return season == "all" or season == season_of(day)


@lru_cache(maxsize=16)
def special_of(day: date) -> str | None:
    """The day's special: an in-stock food priced at least SPECIAL_MIN_PRICE,
    picked by a hash of the date, so every server and client agrees all day."""
    pool = [k for k, v in CATALOG.items()
            if v["price"] >= SPECIAL_MIN_PRICE and in_stock(k, day)]
    if not pool:
        return None
    h = int(hashlib.sha256(("hq:special:" + day.isoformat()).encode("utf-8")).hexdigest()[:8], 16)
    return pool[h % len(pool)]


def price_of(kind: str, day: date) -> int:
    """What one `kind` costs on `day`: the base price, less the special's discount."""
    price = CATALOG[kind]["price"]
    return price - SPECIAL_DISCOUNT if kind == special_of(day) else price


class EconomyError(Exception):
    """A refused guard. The caller rolls back and surfaces it as HTTPException."""

    def __init__(self, code: int, msg: str):
        super().__init__(msg)
        self.code = code
        self.msg = msg


def _aware(dt: datetime) -> datetime:
    # SQLite hands back naive datetimes; everything here is written in UTC.
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt


def _next_claim_at(today: date) -> str:
    return datetime.combine(today + timedelta(days=1), time(0), tzinfo=UTC).isoformat()


async def _rollback(db: AsyncSession, user: User) -> None:
    """Roll back, then reload the caller. A rollback expires every object the
    session holds, and an expired attribute cannot lazy-load under asyncio, so a
    path that goes on to build a response needs the user fresh."""
    await db.rollback()
    if user in db:
        await db.refresh(user)


async def _find_op(db: AsyncSession, uid: str, rid: str) -> PokeLedger | None:
    return (
        await db.execute(
            select(PokeLedger).where(PokeLedger.user_id == uid, PokeLedger.request_id == rid)
        )
    ).scalar_one_or_none()


async def _qty(db: AsyncSession, uid: str, item: str) -> int | None:
    """The balance, or None when there is no row yet."""
    return (
        await db.execute(
            select(PokeBalance.qty).where(PokeBalance.user_id == uid, PokeBalance.item == item)
        )
    ).scalar_one_or_none()


def _not_enough(label: str, n: int, have: int) -> EconomyError:
    return EconomyError(409, f"not enough {label} (need {n}, you have {have})")


async def _afford(db: AsyncSession, uid: str, item: str, n: int, label: str) -> None:
    """Refuse as _debit would unless uid holds n. A read, not a hold: the
    conditional debit is still the guard."""
    have = await _qty(db, uid, item) or 0
    if have < n:
        raise _not_enough(label, n, have)


async def _debit(
    db: AsyncSession, uid: str, item: str, n: int, label: str, short: str | None = None
) -> None:
    """Take n, or refuse with 409 (`short` replaces the need/have message)."""
    res = await db.execute(
        update(PokeBalance)
        .where(PokeBalance.user_id == uid, PokeBalance.item == item, PokeBalance.qty >= n)
        .values(qty=PokeBalance.qty - n, updated_at=func.now())
        .execution_options(synchronize_session=False)
    )
    if res.rowcount != 1:
        if short:
            raise EconomyError(409, short)
        raise _not_enough(label, n, await _qty(db, uid, item) or 0)


async def _credit(db: AsyncSession, uid: str, item: str, n: int, cap: int, err: str) -> None:
    """Add n without passing cap, or refuse with 409 `err`."""
    res = await db.execute(
        update(PokeBalance)
        .where(PokeBalance.user_id == uid, PokeBalance.item == item, PokeBalance.qty + n <= cap)
        .values(qty=PokeBalance.qty + n, updated_at=func.now())
        .execution_options(synchronize_session=False)
    )
    if res.rowcount == 1:
        return
    if await _qty(db, uid, item) is not None or n > cap:
        raise EconomyError(409, err)
    db.add(PokeBalance(user_id=uid, item=item, qty=n))
    await db.flush()


async def _count(db: AsyncSession, *where) -> int:
    return (
        await db.execute(select(func.count()).select_from(PokeLedger).where(*where))
    ).scalar_one()


async def _sum(db: AsyncSession, col, *where) -> int:
    return (
        await db.execute(select(func.coalesce(func.sum(col), 0)).where(*where))
    ).scalar_one()


def _gift_item(row: PokeLedger, sender: User) -> dict:
    return {
        "fromHandle": sender.handle,
        "fromName": sender.display_name or sender.handle,
        "coins": row.coins,
        "kind": row.kind,
        "qty": row.qty,
        "note": row.note,
        "at": _aware(row.created_at).isoformat(),
    }


def _in_lobby(uid: str) -> bool:
    """Whether uid has a lobby socket open, as _deliver_live would find it."""
    room = manager.get("lobby")
    return room is not None and any(m.user_id == uid for m in list(room.members.values()))


async def pantry_state(db: AsyncSession, user: User) -> dict:
    """The PantryState every endpoint returns. Read-only: it creates no rows and
    marks nothing delivered, so a GET never claims and never drains."""
    uid = user.id
    today = _today()

    held = dict((
        await db.execute(
            select(PokeBalance.item, PokeBalance.qty).where(PokeBalance.user_id == uid)
        )
    ).all())
    coins = held.get("coins", 0)

    claimed_today = await _find_op(db, uid, "claim:" + today.isoformat()) is not None
    gives_today = await _count(
        db, PokeLedger.op == "give", PokeLedger.user_id == uid, PokeLedger.op_date == today
    )

    recent = (
        await db.execute(
            select(PokeLedger, User)
            .join(User, User.id == PokeLedger.user_id)
            .where(
                PokeLedger.op == "give",
                PokeLedger.to_user_id == uid,
                PokeLedger.op_date >= today - timedelta(days=RECENT_GIFT_DAYS),
            )
            .order_by(PokeLedger.created_at.desc(), PokeLedger.id.desc())
            .limit(RECENT_GIFTS)
        )
    ).all()

    special = special_of(today)
    return {
        "coins": coins,
        "coinCap": COIN_CAP,
        "items": {k: held.get(k, 0) for k in CATALOG},
        "itemCap": ITEM_CAP,
        # "price" is today's (the special's discount applied); "basePrice" is the usual.
        "catalog": [
            {"kind": k, **v, "basePrice": v["price"], "price": price_of(k, today),
             "inStock": in_stock(k, today), "special": k == special}
            for k, v in CATALOG.items()
        ],
        "season": season_of(today),
        "special": special,
        "claim": {
            "claimedToday": claimed_today,
            "claimable": not claimed_today and coins < COIN_CAP,
            "amount": DAILY_COINS,
            "today": today.isoformat(),
            "nextClaimAt": _next_claim_at(today),
        },
        "limits": {
            "buyMaxQty": BUY_MAX_QTY,
            "giftMaxCoins": GIFT_MAX_COINS,
            "giftMaxQty": GIFT_MAX_QTY,
            "giftsLeftToday": max(0, GIFTS_PER_DAY - gives_today),
        },
        "recentGifts": [_gift_item(row, sender) for row, sender in recent],
    }


# --- the spend recipe (buy, eat, give) ---------------------------------------

async def _prior(db: AsyncSession, uid: str, rid: str, want: tuple) -> PokeLedger | None:
    """The committed op for this request id, if any. `want` is (op, kind, qty,
    coins, to_user_id); a mismatch means the id was reused for something else."""
    prior = await _find_op(db, uid, rid)
    if prior is not None and (
        prior.op, prior.kind, prior.qty, prior.coins, prior.to_user_id
    ) != want:
        raise HTTPException(409, _REUSED)
    return prior


async def _spend(
    db: AsyncSession, user: User, rid: str, want: tuple, apply, note: str = "", check=None,
    day: date | None = None,
):
    """Run one spend in the journal-first order. Returns (row, replayed): the
    committed ledger row, or the prior one when this request id already ran.
    `check()` runs only when it did not (a replay wins over give's 404/400), and
    `apply(row)` does the op's caps, debits and credits, raising EconomyError.
    `day` is the row's op_date (default today): pass the date a price came from."""
    uid = user.id
    prior = await _prior(db, uid, rid, want)
    if prior is not None:
        return prior, True
    if check is not None:
        check()

    op, kind, qty, coins, to_uid = want
    row = PokeLedger(
        user_id=uid, request_id=rid, op=op, op_date=day or _today(), kind=kind, qty=qty,
        coins=coins, to_user_id=to_uid, note=note, created_at=_now(),
    )
    try:
        db.add(row)
        await db.flush()  # the first write: takes the lock and claims the key
        if await _count(
            db, PokeLedger.user_id == uid, PokeLedger.op_date == row.op_date
        ) > MAX_OPS_PER_DAY:
            raise EconomyError(
                429, "that's a lot of pantry activity for one day, try again tomorrow"
            )
        await apply(row)
        await db.commit()
    except IntegrityError:
        # Almost always a concurrent submit of the same request id that won the
        # race: replay it. Anything else is a transient conflict.
        await _rollback(db, user)
        prior = await _prior(db, uid, rid, want)
        if prior is not None:
            return prior, True
        raise HTTPException(503, _BUSY) from None
    except OperationalError:
        # SQLite's busy_timeout ran out under a burst of writers.
        await db.rollback()
        raise HTTPException(503, _BUSY) from None
    except EconomyError as e:
        await db.rollback()
        raise HTTPException(e.code, e.msg) from None
    return row, False


async def buy(db: AsyncSession, user: User, body: BuyRequest) -> BuyResponse:
    food = CATALOG[body.kind]
    # Priced on the day the buy runs. A request id that already committed a buy
    # is priced on ITS day, so a retry that crosses UTC midnight (when the
    # special changes) still replays instead of failing as a reused id.
    prior = await _find_op(db, user.id, body.requestId)
    day = prior.op_date if prior is not None and prior.op == "buy" else _today()
    spend = price_of(body.kind, day) * body.qty

    def check() -> None:
        if not in_stock(body.kind, day):
            raise HTTPException(409, f"{food['plural']} are out of season")

    async def apply(row: PokeLedger) -> None:
        await _debit(db, user.id, "coins", spend, "Poke Coins")
        await _credit(db, user.id, body.kind, body.qty, ITEM_CAP,
                      f"your pantry holds at most {ITEM_CAP} {food['plural']}")

    row, replayed = await _spend(
        db, user, body.requestId, ("buy", body.kind, body.qty, spend, None), apply,
        check=check, day=day,
    )
    return BuyResponse(
        **await pantry_state(db, user),
        replayed=replayed, kind=row.kind, qty=row.qty, spent=row.coins,
    )


async def eat(db: AsyncSession, user: User, body: EatRequest) -> EatResponse:
    """A plain conditional decrement. Which session ate is the client's business;
    the server never learns it."""
    plural = CATALOG[body.kind]["plural"]

    async def apply(row: PokeLedger) -> None:
        await _debit(db, user.id, body.kind, 1, plural, short=f"you have no {plural} left")

    row, replayed = await _spend(db, user, body.requestId, ("eat", body.kind, 1, 0, None), apply)
    food = CATALOG[row.kind]
    return EatResponse(
        **await pantry_state(db, user),
        replayed=replayed, kind=row.kind, restoreMins=food["restoreMins"],
        revives=food["revives"],
        # A replay returns the ORIGINAL time, so a reused id can't forge a later meal.
        at=_aware(row.created_at).isoformat(),
    )


async def give(db: AsyncSession, user: User, body: GiveRequest) -> GiveResponse:
    """Coins and/or one food kind to a person by handle, resolved now; the
    ledger stores ids. Delivered by exactly one channel: live over the lobby
    socket when the recipient is there at commit, otherwise their client's
    drain."""
    uid = user.id
    target = (
        await db.execute(select(User).where(User.handle == body.toHandle))
    ).scalar_one_or_none()
    # Plain values: a rollback on the way would expire the ORM object.
    to_id = target.id if target is not None else None
    to_handle = target.handle if target is not None else body.toHandle
    want = ("give", body.kind, body.qty, body.coins, to_id)

    def check() -> None:
        if target is None or not target.is_active:
            raise HTTPException(404, "no such person")
        if to_id == uid:
            raise HTTPException(400, "you can't give to yourself")

    async def apply(row: PokeLedger) -> None:
        gives = (PokeLedger.op == "give", PokeLedger.op_date == row.op_date)
        if await _count(db, *gives, PokeLedger.user_id == uid) > GIFTS_PER_DAY:
            raise EconomyError(429, f"you've sent {GIFTS_PER_DAY} gifts today, try again tomorrow")
        if await _count(
            db, *gives, PokeLedger.user_id == uid, PokeLedger.to_user_id == to_id
        ) > GIFTS_PER_PAIR_PER_DAY:
            raise EconomyError(
                429, f"you've already sent {to_handle} {GIFTS_PER_PAIR_PER_DAY} gifts today"
            )
        # A sender who can't pay is refused before anything reads the
        # recipient, whatever order the rows are touched in below. Otherwise
        # which 409 came back would tell a broke sender the recipient's balance
        # or today's receipts, for free: a refused gift writes nothing.
        if body.coins:
            await _afford(db, uid, "coins", body.coins, "Poke Coins")
        if body.qty:
            await _afford(db, uid, body.kind, body.qty, CATALOG[body.kind]["plural"])
        # Every recipient-side refusal reads the same, so their balance never leaks.
        refused = f"{to_handle} can't receive that right now"
        to_them = (*gives, PokeLedger.to_user_id == to_id)
        if (await _sum(db, PokeLedger.coins, *to_them) > RECEIVE_COINS_PER_DAY
                or await _sum(db, PokeLedger.qty, *to_them) > RECEIVE_ITEMS_PER_DAY):
            raise EconomyError(409, refused)

        async def send() -> None:
            if body.coins:
                await _debit(db, uid, "coins", body.coins, "Poke Coins")
            if body.qty:
                await _debit(db, uid, body.kind, body.qty, CATALOG[body.kind]["plural"])

        async def receive() -> None:
            if body.coins:
                await _credit(db, to_id, "coins", body.coins, COIN_CAP, refused)
            if body.qty:
                await _credit(db, to_id, body.kind, body.qty, ITEM_CAP, refused)

        # Touch rows in ascending user_id order so A->B and B->A gifts cannot
        # deadlock on Postgres. SQLite holds one database-wide lock, so there the
        # order is moot.
        first, second = (send, receive) if uid < to_id else (receive, send)
        await first()
        await second()

        # Pick the channel in this transaction. A gift that will go live
        # commits already marked delivered, so a drain racing the live send
        # finds nothing and the recipient is not told twice.
        if _in_lobby(to_id):
            row.delivered_at = _now()

    row, replayed = await _spend(
        db, user, body.requestId, want, apply, note=body.note, check=check
    )
    sent = SentGift(coins=row.coins, kind=row.kind, qty=row.qty)

    if replayed:
        # "Send again" replays after an unconfirmed send that has often landed,
        # and the page reads 0 as "queued". The socket count is not kept, so
        # report whether it has reached them by now, live or drained.
        live = int(row.delivered_at is not None)
    elif row.delivered_at is None:
        live = 0  # not in the lobby: their drain delivers it
    else:
        live = await _deliver_live(to_id, {
            "type": "gift",
            "id": row.id,
            "from": {
                "userId": uid,
                "handle": user.handle,
                "displayName": user.display_name or user.handle,
                "avatarUrl": user.avatar_url,
            },
            "coins": row.coins,
            "kind": row.kind,
            "qty": row.qty,
            "note": row.note,
        })
        if live == 0:
            # No socket took it: hand it back to their drain. Best-effort: if
            # this fails too they miss the notification, never the gift.
            try:
                await db.execute(
                    update(PokeLedger)
                    .where(PokeLedger.id == row.id)
                    .values(delivered_at=None)
                    .execution_options(synchronize_session=False)
                )
                await db.commit()
            except Exception:
                await _rollback(db, user)

    return GiveResponse(
        **await pantry_state(db, user),
        replayed=replayed, toHandle=to_handle, sent=sent, deliveredLive=live,
    )


# --- the daily claim -----------------------------------------------------------

async def claim(db: AsyncSession, user: User) -> ClaimResponse:
    """+DAILY_COINS once per UTC day, keyed by the reserved request id
    "claim:YYYY-MM-DD" (client ids cannot contain ":"). Lazy: missed days do not
    bank. The very first claim also brings a STARTER snack."""
    uid = user.id
    today = _today()
    rid = "claim:" + today.isoformat()

    async def respond(claimed=False, granted=0, starter=False, full=False) -> ClaimResponse:
        return ClaimResponse(
            **await pantry_state(db, user),
            claimed=claimed, granted=granted, starter=starter, full=full,
        )

    if await _find_op(db, uid, rid) is not None:
        return await respond()

    granted, starter = 0, False
    try:
        row = PokeLedger(
            user_id=uid, request_id=rid, op="claim", op_date=today, kind=None, qty=0,
            coins=0, to_user_id=None, note="", created_at=_now(),
        )
        db.add(row)
        await db.flush()  # the first write: takes the lock and claims today's key

        have = await _qty(db, uid, "coins") or 0
        grant = min(DAILY_COINS, COIN_CAP - have)
        if grant <= 0:
            # A full purse records nothing, so today's claim stays open for
            # after a spend or a gift.
            await _rollback(db, user)
            return await respond(full=True)

        row.coins = grant
        await _credit(db, uid, "coins", grant, COIN_CAP, "wallet full")
        if await _count(db, PokeLedger.op == "claim", PokeLedger.user_id == uid) == 1:
            kind, n = STARTER
            try:
                await _credit(db, uid, kind, n, ITEM_CAP, "")
                row.kind, row.qty, starter = kind, n, True
            except EconomyError:
                pass  # already holding a full stack: no starter, still a claim
        await db.commit()
        granted = grant
    except IntegrityError:
        # Another tab's claim for today won the race.
        await _rollback(db, user)
        if await _find_op(db, uid, rid) is None:
            raise HTTPException(503, _BUSY) from None
    except OperationalError:
        await db.rollback()
        raise HTTPException(503, _BUSY) from None
    except EconomyError as e:
        await db.rollback()
        raise HTTPException(e.code, e.msg) from None
    return await respond(claimed=granted > 0, granted=granted, starter=starter)


# --- gift inbox ------------------------------------------------------------------

async def drain(db: AsyncSession, user: User) -> GiftsResponse:
    """Undelivered gifts to me, oldest first, each returned exactly once. The
    conditional UPDATE is what makes it once: of two drains racing for the same
    row, only one sees delivered_at still NULL. A gift going live commits
    already delivered (see give), so the drain never returns that one too."""
    rows = (
        await db.execute(
            select(PokeLedger, User)
            .join(User, User.id == PokeLedger.user_id)
            .where(
                PokeLedger.op == "give",
                PokeLedger.to_user_id == user.id,
                PokeLedger.delivered_at.is_(None),
            )
            .order_by(PokeLedger.created_at, PokeLedger.id)
            .limit(DRAIN_LIMIT)
        )
    ).all()

    now = _now()
    gifts: list[DrainedGift] = []
    for row, sender in rows:
        res = await db.execute(
            update(PokeLedger)
            .where(PokeLedger.id == row.id, PokeLedger.delivered_at.is_(None))
            .values(delivered_at=now)
            .execution_options(synchronize_session=False)
        )
        if res.rowcount == 1:
            gifts.append(DrainedGift(id=row.id, **_gift_item(row, sender)))
    await db.commit()
    return GiftsResponse(gifts=gifts)


# --- quest / achievement rewards -----------------------------------------------

def reward_request_id(kind: str, quest_id: str, tier: str | None, today: date) -> str:
    """The ledger key for a reward, derived here rather than taken from the
    client, so one quest pays once per period however many requestIds a client
    invents. Daily quests (d_*) key on the UTC date, weekly ones (w_*) on the
    ISO week -- the same strings the page builds (todayStr / isoWeekStr) -- and
    an achievement tier pays once ever."""
    if kind == "achievement":
        return f"ach:{quest_id}:{tier}"
    if quest_id.startswith("w_"):
        year, week, _ = today.isocalendar()
        return f"quest:{quest_id}:{year}-W{week:02d}"
    return f"quest:{quest_id}:{today.isoformat()}"


async def reward(db: AsyncSession, user: User, body: QuestRewardRequest) -> QuestRewardResponse:
    """Credit coins for a completed quest or achievement, once per quest per
    period (see reward_request_id). Journal-first like _spend: the ledger row
    claims the key, then the daily cap is counted under that same write lock,
    so two concurrent claims cannot both slip under QUEST_REWARDS_PER_DAY."""
    uid = user.id
    today = _today()

    if body.kind == "quest":
        expected = QUEST_REWARDS.get(body.questId)
    else:
        tiers = ACH_REWARDS.get(body.questId)
        expected = tiers.get(body.tier) if tiers else None
    if expected is None:
        raise HTTPException(404, "unknown quest or achievement")
    if body.coins != expected:
        raise HTTPException(422, "reward amount does not match the catalog")

    rid = reward_request_id(body.kind, body.questId, body.tier, today)

    async def replay() -> QuestRewardResponse:
        bal = await _qty(db, uid, "coins") or 0
        return QuestRewardResponse(ok=True, coins=bal, reward=0)

    if await _find_op(db, uid, rid) is not None:
        return await replay()

    try:
        row = PokeLedger(
            user_id=uid, request_id=rid, op="quest", op_date=today,
            kind=None, qty=0, coins=body.coins, to_user_id=None,
            note=body.questId, created_at=_now(),
        )
        db.add(row)
        await db.flush()  # the first write: takes the lock and claims the key
        # Exact: read under the lock, and includes the row just inserted.
        if await _count(
            db, PokeLedger.user_id == uid, PokeLedger.op == "quest",
            PokeLedger.op_date == today,
        ) > QUEST_REWARDS_PER_DAY:
            raise EconomyError(429, "too many quest rewards today, try again tomorrow")
        await _credit(db, uid, "coins", body.coins, COIN_CAP, "wallet full")
        await db.commit()
    except IntegrityError:
        await _rollback(db, user)
        if await _find_op(db, uid, rid) is not None:
            return await replay()
        raise HTTPException(503, _BUSY) from None
    except OperationalError:
        await db.rollback()
        raise HTTPException(503, _BUSY) from None
    except EconomyError as e:
        await db.rollback()
        raise HTTPException(e.code, e.msg) from None

    bal = await _qty(db, uid, "coins") or 0
    return QuestRewardResponse(ok=True, coins=bal, reward=body.coins)
