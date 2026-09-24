"""
Seed a local Arena with fake friends so the board has something to look at.

Creates users + device tokens directly in the database, then publishes their
stats over HTTP through the real API -- so this exercises auth, the schema
allowlist and the ingest path, not just the ORM.

    uv run python scripts/seed_demo.py                 # 5 friends, 30 days
    uv run python scripts/seed_demo.py --friends 8     # more players
    uv run python scripts/seed_demo.py --reset         # wipe first

Never point this at production: it writes users it invented.
"""
import argparse
import asyncio
import os
import random
import sys
from datetime import UTC, datetime, timedelta

import httpx

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.auth import hash_token, new_device_token  # noqa: E402
from app.db import Base, SessionLocal, engine  # noqa: E402
from app.models import Device, User  # noqa: E402
from app.schemas import KNOWN_TOOLS  # noqa: E402

FRIENDS = [
    ("ash", "Ash Ketchum", 1.00),
    ("misty", "Misty", 0.72),
    ("brock", "Brock", 0.55),
    ("gary", "Gary Oak", 1.35),
    ("jessie", "Jessie", 0.30),
    ("james", "James", 0.28),
    ("prof-oak", "Professor Oak", 0.90),
    ("nurse-joy", "Nurse Joy", 0.45),
]

# Weighted so the mix looks like real usage rather than uniform noise.
TOOL_MIX = [("Bash", 40), ("Read", 22), ("Edit", 14), ("Grep", 8),
            ("Write", 6), ("Task", 4), ("WebSearch", 3), ("Other", 3)]


def make_days(intensity: float, days: int, rng: random.Random) -> list[dict]:
    today = datetime.now(UTC).date()
    out = []
    for i in range(days - 1, -1, -1):
        d = today - timedelta(days=i)
        # Weekends are quieter; some days are skipped entirely.
        weekend = d.weekday() >= 5
        if rng.random() < (0.35 if weekend else 0.12):
            continue
        base = rng.randint(4, 40) * intensity * (0.45 if weekend else 1.0)
        prompts = max(1, int(base))
        tools = int(prompts * rng.uniform(2.5, 6.0))

        remaining = tools
        breakdown = []
        total_w = sum(w for _, w in TOOL_MIX)
        for name, w in TOOL_MIX:
            n = int(tools * w / total_w)
            if n:
                breakdown.append({"name": name, "count": n})
                remaining -= n
        if remaining > 0 and breakdown:
            breakdown[0]["count"] += remaining

        out.append({
            "date": d.isoformat(),
            "prompts": prompts,
            "tools": tools,
            "artifacts": rng.randint(0, 3),
            "replies": int(prompts * rng.uniform(1.5, 2.5)),
            "tokens": {
                "input": prompts * rng.randint(200, 900),
                "output": prompts * rng.randint(2_000, 9_000),
                "cacheRead": prompts * rng.randint(80_000, 400_000),
                "cacheCreation": prompts * rng.randint(5_000, 40_000),
            },
            "toolBreakdown": breakdown,
        })
    return out


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8080")
    ap.add_argument("--friends", type=int, default=5)
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--reset", action="store_true", help="drop and recreate all tables")
    args = ap.parse_args()

    rng = random.Random(args.seed)

    if args.reset:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        print("database reset")

    chosen = FRIENDS[: max(1, min(args.friends, len(FRIENDS)))]
    tokens: list[tuple[str, str]] = []

    async with SessionLocal() as db:
        for i, (handle, name, _) in enumerate(chosen):
            token = new_device_token()
            db.add_all([
                u := User(github_id=900_000 + i, handle=handle, display_name=name,
                          trainer_name=name.split()[0],
                          avatar_url=f"https://avatars.githubusercontent.com/u/{i+1}?v=4"),
            ])
            await db.flush()
            db.add(Device(user_id=u.id, token_hash=hash_token(token), label="demo"))
            tokens.append((handle, token))
        await db.commit()

    print(f"created {len(tokens)} users\n")

    async with httpx.AsyncClient(base_url=args.url, timeout=30) as client:
        for (handle, token), (_, name, intensity) in zip(tokens, chosen):
            payload = {
                "schemaVersion": 1,
                "trainerName": name.split()[0],
                "days": make_days(intensity, args.days, rng),
            }
            r = await client.post("/v1/stats", json=payload,
                                  headers={"Authorization": f"Bearer {token}"})
            r.raise_for_status()
            body = r.json()
            print(f"  {handle:<10} published {body['accepted']:>2} days "
                  f"({body['rejected']} rejected)")

        board = (await client.get(
            "/v1/board?window=30d",
            headers={"Authorization": f"Bearer {tokens[0][1]}"},
        )).json()

    print(f"\n{board['seasonName']}  ·  {board['startsOn']} → {board['endsOn']}\n")
    print(f"  {'#':<3}{'trainer':<14}{'xp':>8}{'lvl':>5}{'prompts':>9}"
          f"{'tools':>8}{'days':>6}{'streak':>8}  rank")
    print("  " + "-" * 76)
    for e in board["entries"]:
        print(f"  {e['rank']:<3}{e['handle']:<14}{e['xp']:>8,}{e['level']:>5}"
              f"{e['prompts']:>9,}{e['tools']:>8,}{e['activeDays']:>6}"
              f"{e['streak']:>8}  {e['rankTitle']}")

    print("\nDevice tokens (use with: Authorization: Bearer <token>)")
    for handle, token in tokens:
        print(f"  {handle:<10} {token}")


if __name__ == "__main__":
    asyncio.run(main())
