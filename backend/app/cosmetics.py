"""HQ 2.1 cosmetics: things you wear in games and on your HQ, shown to everyone.

One catalog. An item is bought with Poke Coins through the pantry ledger (owning
it is a PokeBalance row "cos:<id>", quantity 1) or unlocks at an HQ level. You
equip one per slot; every room you join carries your equipped cosmetics in your
public member info ("cos": {slot: value}), so every game draws them for everyone.
Cosmetic only: nothing here changes how a game plays.
"""
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import EquippedCosmetics, PokeBalance, User

SLOTS = {"kart": "Kart paint", "runner": "Runner colour", "blaster": "Blaster skin", "ball": "Golf ball",
         "frame": "Name frame", "decor": "HQ decor"}

# id -> (slot, name, value, price in coins (0 = not for sale), level needed (0 = none))
CATALOG: dict[str, tuple[str, str, str, int, int]] = {
    "k-neon": ("kart", "Neon green paint", "#39ff88", 20, 0),
    "k-midnight": ("kart", "Midnight paint", "#1d2b5c", 12, 0),
    "k-sunset": ("kart", "Sunset paint", "#ff7b54", 12, 0),
    "k-gold": ("kart", "Gold paint", "#d8b34a", 0, 20),
    "r-ember": ("runner", "Ember runner", "#ff6b5b", 10, 0),
    "r-aqua": ("runner", "Aqua runner", "#5fd3e6", 10, 0),
    "r-gold": ("runner", "Gold runner", "#d8b34a", 0, 25),
    "g-chrome": ("blaster", "Chrome blaster", "#c0c8d0", 10, 0),
    "g-ember": ("blaster", "Ember blaster", "#ff6b5b", 10, 0),
    "g-void": ("blaster", "Void blaster", "#2c2c34", 15, 0),
    "b-pink": ("ball", "Pink ball", "#ff9ad5", 6, 0),
    "b-lime": ("ball", "Lime ball", "#b6ff5c", 6, 0),
    "b-gold": ("ball", "Gold ball", "#d8b34a", 0, 15),
    "f-brass": ("frame", "Brass frame", "#d8b34a", 8, 0),
    "f-neon": ("frame", "Neon frame", "#5fd3e6", 8, 0),
    "f-crimson": ("frame", "Crimson frame", "#ff6b5b", 8, 0),
    "f-legend": ("frame", "Legend frame", "#9b8cf0", 0, 40),
    "d-flags": ("decor", "Rooftop flags", "flags", 10, 0),
    "d-gnomes": ("decor", "Plaza gnomes", "gnomes", 8, 0),
    "d-fireworks": ("decor", "Fireworks", "fireworks", 25, 0),
    "d-neon": ("decor", "Neon outline", "neon", 0, 30),
}


def item_key(cid: str) -> str:
    return "cos:" + cid


async def owned(db: AsyncSession, uid: str, level: int) -> set[str]:
    rows = (await db.execute(select(PokeBalance.item).where(PokeBalance.user_id == uid, PokeBalance.item.like("cos:%"),
                                                             PokeBalance.qty > 0))).scalars()
    have = {r[4:] for r in rows}
    have |= {cid for cid, it in CATALOG.items() if it[4] and level >= it[4]}
    return have


async def equipped(db: AsyncSession, user_ids: list[str]) -> dict[str, dict[str, str]]:
    """slot -> value (the colour or decor key) per user, for member info and profiles."""
    out = {u: {} for u in user_ids}
    if not user_ids:
        return out
    for row in (await db.execute(select(EquippedCosmetics).where(EquippedCosmetics.user_id.in_(user_ids)))).scalars():
        out[row.user_id] = {s: CATALOG[c][2] for s, c in (row.slots or {}).items() if c in CATALOG and CATALOG[c][0] == s}
    return out


async def state(db: AsyncSession, user: User) -> dict:
    from .pantry import _qty
    from .results import progress
    level = (await progress(db, [user.id]))[user.id]["level"]
    have = await owned(db, user.id, level)
    row = await db.get(EquippedCosmetics, user.id)
    on = (row.slots if row else {}) or {}
    items = [{"id": cid, "slot": it[0], "name": it[1], "value": it[2], "price": it[3], "level": it[4],
              "owned": cid in have, "equipped": on.get(it[0]) == cid,
              "locked": bool(it[4]) and level < it[4]} for cid, it in CATALOG.items()]
    return {"slots": SLOTS, "items": items, "coins": await _qty(db, user.id, "coins") or 0, "level": level}


async def equip(db: AsyncSession, user: User, slot: str, cid: str | None) -> dict:
    from .results import progress
    if slot not in SLOTS:
        raise HTTPException(400, "unknown slot")
    if cid is not None:
        it = CATALOG.get(cid)
        if it is None or it[0] != slot:
            raise HTTPException(400, "that item doesn't go in that slot")
        level = (await progress(db, [user.id]))[user.id]["level"]
        if cid not in await owned(db, user.id, level):
            raise HTTPException(409, "you don't own that yet")
    row = await db.get(EquippedCosmetics, user.id)
    if row is None:
        row = EquippedCosmetics(user_id=user.id, slots={})
        db.add(row)
    slots = dict(row.slots or {})
    if cid is None:
        slots.pop(slot, None)
    else:
        slots[slot] = cid
    row.slots = slots
    await db.commit()
    return await state(db, user)


async def buy(db: AsyncSession, user: User, rid: str, cid: str) -> dict:
    """Spend Poke Coins on one item, through the pantry journal (replay-safe)."""
    from . import pantry
    it = CATALOG.get(cid)
    if it is None or not it[3]:
        raise HTTPException(400, "that item isn't for sale")
    if await pantry._find_op(db, user.id, rid) is not None:
        return await state(db, user)          # a resent purchase: already done, never charged twice
    if await pantry._qty(db, user.id, item_key(cid)):
        raise HTTPException(409, "you already own that")
    price = it[3]

    async def apply(row):
        await pantry._debit(db, user.id, "coins", price, "Poke Coins")
        await pantry._credit(db, user.id, item_key(cid), 1, 1, "you already own that")

    await pantry._spend(db, user, rid, ("cosmetic", item_key(cid), 1, price, None), apply, note=it[1])
    return await state(db, user)


# --- the Valley market: sell Valley finds for Poke Coins ----------------------
# The Valley's fish, crops, ore and gems live in your own browser save, so the Arena
# cannot see them: like quest rewards, a sale is trusted but small and capped per day.
SELL_PRICE = {"fish": 1, "crop": 1, "ore": 1, "gem": 2, "misc": 1}
SELL_MAX_QTY = 10
SELL_COINS_PER_DAY = 10


async def sell(db: AsyncSession, user: User, rid: str, cat: str, qty: int) -> dict:
    from . import pantry
    from .models import PokeLedger
    if cat not in SELL_PRICE or not 1 <= qty <= SELL_MAX_QTY:
        raise HTTPException(400, "sell 1 to %d fish, crops, ore, gems or finds" % SELL_MAX_QTY)
    coins = SELL_PRICE[cat]*qty
    today = pantry._today()

    async def apply(row):
        sold = await pantry._sum(db, PokeLedger.coins, PokeLedger.user_id == user.id, PokeLedger.op == "sell",
                                 PokeLedger.op_date == today)
        if sold > SELL_COINS_PER_DAY:          # (this row is already counted)
            raise pantry.EconomyError(429, "the market buys up to %d coins of finds a day" % SELL_COINS_PER_DAY)
        await pantry._credit(db, user.id, "coins", coins, pantry.COIN_CAP, "your purse is full (%d coins)" % pantry.COIN_CAP)

    row, replay = await pantry._spend(db, user, rid, ("sell", cat, qty, coins, None), apply, note="valley market")
    return {"ok": True, "coins": await pantry._qty(db, user.id, "coins") or 0, "earned": 0 if replay else coins}
