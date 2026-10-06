"""
Scoring authority.

These formulas are deliberately duplicated from the local `dashboard.py` so the
numbers a person sees offline match the board. The server, not the client, is
the one that counts: clients submit raw activity only.
"""
from datetime import date, timedelta

XP_PER_PROMPT = 10
XP_PER_TOOL = 3
XP_PER_ARTIFACT = 40

RANKS = [
    (1, "Prompt Apprentice"),
    (3, "Prompt Adept"),
    (5, "Prompt Conjurer"),
    (8, "Prompt Sorcerer"),
    (12, "Prompt Archmage"),
    (18, "Prompt Ascendant"),
    (999, "Prompt Deity"),
]


def xp_from_counts(prompts: int, tools: int, artifacts: int) -> int:
    return prompts * XP_PER_PROMPT + tools * XP_PER_TOOL + artifacts * XP_PER_ARTIFACT


def xp_for_level(level: int) -> int:
    """XP needed to advance FROM the given level to the next."""
    return 400 + 120 * level


def derive_level(total_xp: int) -> tuple[int, int, int]:
    """Walk cumulative thresholds from level 1. Returns (level, xp_into, xp_for)."""
    level = 1
    remaining = total_xp
    while True:
        need = xp_for_level(level)
        if remaining < need:
            return level, int(remaining), int(need)
        remaining -= need
        level += 1
        if level > 999:
            return level, int(remaining), int(xp_for_level(level))


def rank_for_level(level: int) -> str:
    for threshold, title in RANKS:
        if level <= threshold:
            return title
    return RANKS[-1][1]


STREAK_WINDOW = 7
STREAK_MAX_MISSES = 2


def streak_from_dates(active: set[date], today: date, lookback: int = 400) -> int:
    """Flexible streak: it survives missed days as long as no 7-day stretch
    inside it has more than 2 of them (at least 5 active days in every 7).
    Today never counts as a miss while it is in progress. Mirrors
    flex_streak in the dashboard's dashboard.py."""
    start = today if today in active else today - timedelta(days=1)
    span: list[bool] = []
    d = start
    for _ in range(lookback):
        span.append(d in active)
        if span[-STREAK_WINDOW:].count(False) > STREAK_MAX_MISSES:
            span.pop()
            break
        d -= timedelta(days=1)
    if True not in span:
        return 0
    newest = span.index(True)
    oldest = len(span) - 1 - span[::-1].index(True)
    return oldest - newest + 1
