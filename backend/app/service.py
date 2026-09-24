"""Ingest and leaderboard queries."""
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import get_settings
from .models import DailyStat, DailyToolStat, Season, StatSnapshot, User
from .schemas import (
    BoardEntry, BoardResponse, DayStat, IngestResponse, StatPayload,
)
from .scoring import derive_level, rank_for_level, streak_from_dates, xp_from_counts

WINDOWS = ("season", "30d", "7d", "all")


def window_range(window: str, today: date) -> tuple[date, date]:
    if window == "7d":
        return today - timedelta(days=6), today
    if window == "30d":
        return today - timedelta(days=29), today
    if window == "all":
        return date(2020, 1, 1), today
    # "season" -- calendar month, which is what people intuitively reset around.
    return today.replace(day=1), today


async def ingest(
    db: AsyncSession, user: User, device_id: str | None, payload: StatPayload
) -> IngestResponse:
    settings = get_settings()
    today = datetime.now(UTC).date()
    oldest = today - timedelta(days=settings.max_backfill_days)

    db.add(StatSnapshot(
        user_id=user.id, device_id=device_id, payload=payload.model_dump(mode="json")
    ))

    if payload.trainerName and payload.trainerName != user.trainer_name:
        user.trainer_name = payload.trainerName

    accepted = rejected = 0
    notes: list[str] = []

    for day in payload.days:
        problem = _reject_reason(day, today, oldest, settings)
        if problem:
            rejected += 1
            if problem not in notes:
                notes.append(problem)
            continue
        await _upsert_day(db, user.id, day)
        accepted += 1

    await db.commit()
    return IngestResponse(accepted=accepted, rejected=rejected, notes=notes)


def _reject_reason(day: DayStat, today: date, oldest: date, settings) -> str | None:
    """Clamps exist so a client bug or a prank cannot permanently distort the board."""
    if day.date > today:
        return "future dates ignored"
    if day.date < oldest:
        return f"dates older than {settings.max_backfill_days} days ignored"
    if day.prompts > settings.max_daily_prompts:
        return f"daily prompts above {settings.max_daily_prompts} rejected"
    if day.tools > settings.max_daily_tools:
        return f"daily tool calls above {settings.max_daily_tools} rejected"
    return None


async def _upsert_day(db: AsyncSession, user_id: str, day: DayStat) -> None:
    row = (
        await db.execute(
            select(DailyStat).where(
                DailyStat.user_id == user_id, DailyStat.stat_date == day.date
            )
        )
    ).scalar_one_or_none()
    if row is None:
        row = DailyStat(user_id=user_id, stat_date=day.date)
        db.add(row)

    # A re-scan of the same day is authoritative: counts are recomputed from the
    # full transcript each time, so we replace rather than accumulate.
    row.prompts = day.prompts
    row.tools = day.tools
    row.artifacts = day.artifacts
    row.replies = day.replies
    row.tokens_input = day.tokens.input
    row.tokens_output = day.tokens.output
    row.tokens_cache_read = day.tokens.cacheRead
    row.tokens_cache_creation = day.tokens.cacheCreation
    row.cost_usd = day.costUSD

    if day.toolBreakdown:
        existing = {
            t.tool_name: t
            for t in (
                await db.execute(
                    select(DailyToolStat).where(
                        DailyToolStat.user_id == user_id,
                        DailyToolStat.stat_date == day.date,
                    )
                )
            ).scalars()
        }
        # Merge, because the client collapses unknown tools into "Other".
        merged: dict[str, int] = {}
        for tc in day.toolBreakdown:
            merged[tc.name] = merged.get(tc.name, 0) + tc.count
        for name, count in merged.items():
            if name in existing:
                existing[name].count = count
            else:
                db.add(DailyToolStat(
                    user_id=user_id, stat_date=day.date, tool_name=name, count=count
                ))


async def build_board(
    db: AsyncSession, window: str, viewer_id: str | None = None
) -> BoardResponse:
    today = datetime.now(UTC).date()
    starts, ends = window_range(window, today)

    rows = (
        await db.execute(
            select(
                User,
                func.coalesce(func.sum(DailyStat.prompts), 0),
                func.coalesce(func.sum(DailyStat.tools), 0),
                func.coalesce(func.sum(DailyStat.artifacts), 0),
                func.coalesce(
                    func.sum(
                        DailyStat.tokens_input
                        + DailyStat.tokens_output
                        + DailyStat.tokens_cache_read
                        + DailyStat.tokens_cache_creation
                    ),
                    0,
                ),
                func.sum(DailyStat.cost_usd),
                func.count(DailyStat.id),
            )
            .join(DailyStat, DailyStat.user_id == User.id)
            .where(
                DailyStat.stat_date >= starts,
                DailyStat.stat_date <= ends,
                User.is_active.is_(True),
            )
            .group_by(User.id)
        )
    ).all()

    # Streaks read the full activity history, not just the window, so a streak
    # does not appear to reset on the first of the month.
    active_by_user: dict[str, set[date]] = {}
    for uid, d in (
        await db.execute(
            select(DailyStat.user_id, DailyStat.stat_date).where(
                DailyStat.stat_date >= today - timedelta(days=400),
                (DailyStat.prompts > 0) | (DailyStat.replies > 0),
            )
        )
    ).all():
        active_by_user.setdefault(uid, set()).add(d)

    entries: list[BoardEntry] = []
    for user, prompts, tools, artifacts, tokens, cost, active_days in rows:
        xp = xp_from_counts(int(prompts), int(tools), int(artifacts))
        level, _, _ = derive_level(xp)
        entries.append(BoardEntry(
            rank=0,
            handle=user.handle,
            displayName=user.display_name or user.handle,
            trainerName=user.trainer_name,
            avatarUrl=user.avatar_url,
            xp=xp,
            level=level,
            rankTitle=rank_for_level(level),
            prompts=int(prompts),
            tools=int(tools),
            artifacts=int(artifacts),
            activeDays=int(active_days),
            streak=streak_from_dates(active_by_user.get(user.id, set()), today),
            tokensTotal=int(tokens),
            costUSD=round(float(cost), 2) if cost is not None else None,
            isYou=user.id == viewer_id,
        ))

    entries.sort(key=lambda e: (-e.xp, e.handle))
    for i, e in enumerate(entries, start=1):
        e.rank = i

    season = (
        await db.execute(select(Season).where(Season.is_active.is_(True)))
    ).scalars().first()

    return BoardResponse(
        window=window,
        startsOn=starts,
        endsOn=ends,
        seasonName=season.name if season else today.strftime("%B %Y"),
        generatedAt=datetime.now(UTC).isoformat(),
        entries=entries,
    )
