"""
Real-time games on the Arena: a fixed-rate server tick per room, and the budgets that
keep one busy room from starving the rest.

Mini Golf is turn-based: the server only acts when a shot arrives. Kart Racing (and
the platformer and arena games after it) move continuously, so the server runs a loop
per room at a fixed rate: each tick it collects what the players sent since the last
one, applies the game's rules and sends everyone ONE batched snapshot, instead of
relaying every client frame the moment it lands.

Budgets, because the Arena is one process with in-memory rooms (see rooms.py):
  - MAX_TICKERS loops at once across the whole process (CPU). A game that can't get a
    slot says so to the host instead of starting.
  - ROOM_BYTES_PER_SEC of outgoing snapshot traffic per room (bandwidth). Over it, the
    loop thins snapshots to every 2nd, then 3rd tick until the room is back under;
    the rules still run every tick.
  - Bucket: a token bucket per player for inbound frames, so a flooding client costs
    the server nothing more than a dropped message.
Nothing here knows about any one game; app/kart.py is the first user.
"""
import asyncio
import time
from collections import deque
from typing import Any, Awaitable, Callable

MAX_TICKERS = 48                 # real-time game loops running at once, process-wide
ROOM_BYTES_PER_SEC = 160 * 1024  # snapshot bytes a room may send per second (all sockets)
MAX_STRIDE = 3                   # thinnest snapshot rate under pressure: every 3rd tick
SLOW_TICK = 0.25                 # a tick this late (seconds) is counted as an overrun


class Bucket:
    """Token bucket: `burst` deep, refilled `rate` per second."""

    __slots__ = ("rate", "burst", "tokens", "at")

    def __init__(self, rate: float, burst: float, t: float) -> None:
        self.rate, self.burst, self.tokens, self.at = rate, burst, float(burst), t

    def take(self, t: float) -> bool:
        self.tokens = min(self.burst, self.tokens + max(0.0, t - self.at) * self.rate)
        self.at = t
        if self.tokens < 1.0:
            return False
        self.tokens -= 1.0
        return True


# step(t, send) -> keep running? `send` is False on a tick whose snapshot is thinned out
# by the bandwidth budget; the step should still apply its rules and send events.
Step = Callable[[float, bool], Awaitable[bool]]


class Ticker:
    def __init__(self, key: str, hz: float, step: Step, clock: Callable[[], float]) -> None:
        self.key = key
        self.hz = hz
        self.step = step
        self.clock = clock
        self.task: asyncio.Task | None = None
        self.ticks = 0
        self.overruns = 0
        self.stride = 1
        self.sent: deque = deque()     # (monotonic time, bytes) over the last second
        self.bytes_1s = 0

    def count(self, nbytes: int) -> None:
        """The step reports what it just sent; this feeds the bandwidth budget."""
        t = time.monotonic()
        self.sent.append((t, nbytes))
        self.bytes_1s += nbytes
        while self.sent and t - self.sent[0][0] > 1.0:
            self.bytes_1s -= self.sent.popleft()[1]

    def _budget(self) -> None:
        if self.bytes_1s > ROOM_BYTES_PER_SEC and self.stride < MAX_STRIDE:
            self.stride += 1
        elif self.bytes_1s < ROOM_BYTES_PER_SEC // 2 and self.stride > 1:
            self.stride -= 1

    async def run(self) -> None:
        period = 1.0 / self.hz
        loop = asyncio.get_running_loop()
        due = loop.time()
        try:
            while True:
                due += period
                self._budget()
                send = self.ticks % self.stride == 0
                self.ticks += 1
                try:
                    keep = await self.step(self.clock(), send)
                except Exception:      # a bug in one game's tick must not take the loop down silently
                    keep = False
                if not keep:
                    return
                late = loop.time() - due
                if late > SLOW_TICK:
                    self.overruns += 1
                    due = loop.time()  # don't burst to catch up: skip the missed ticks
                await asyncio.sleep(max(0.0, due - loop.time()))
        finally:
            if _tickers.get(self.key) is self:
                _tickers.pop(self.key, None)


_tickers: dict[str, Ticker] = {}


def start(key: str, hz: float, step: Step, clock: Callable[[], float]) -> Ticker | None:
    """Start (or keep) the loop for `key` (e.g. "kart:<room>"). None when the process is
    at MAX_TICKERS or there is no running event loop."""
    tk = _tickers.get(key)
    if tk is not None and tk.task is not None and not tk.task.done():
        return tk
    if len(_tickers) >= MAX_TICKERS:
        return None
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return None
    tk = Ticker(key, hz, step, clock)
    _tickers[key] = tk
    tk.task = loop.create_task(tk.run())
    return tk


def get(key: str) -> Ticker | None:
    return _tickers.get(key)


def stop(key: str) -> None:
    tk = _tickers.pop(key, None)
    if tk is not None and tk.task is not None and tk.task is not asyncio.current_task():
        tk.task.cancel()


def stats() -> dict[str, Any]:
    return {"running": len(_tickers), "max": MAX_TICKERS,
            "rooms": {k: {"hz": t.hz, "ticks": t.ticks, "overruns": t.overruns, "stride": t.stride,
                          "bytesPerSec": t.bytes_1s} for k, t in _tickers.items()}}
