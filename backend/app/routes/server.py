"""The Arena's own numbers for the HQ Settings panel (HQ 2.1): memory, CPU,
uptime, rooms, people online, real-time game loops and the database size.
Signed-in devices only; counts, never who is where or what anyone sent."""
import os
import resource
import sys
import time

from fastapi import APIRouter, Depends

from .. import realtime
from ..auth import Caller, require_device
from ..config import get_settings
from ..db import describe_backend
from ..rooms import manager

router = APIRouter(prefix="/v1/server", tags=["server"])
STARTED = time.time()
_cpu_mark = {"t": time.time(), "cpu": 0.0}


def _rss_mb() -> float | None:
    try:
        with open("/proc/self/status") as f:            # Linux: current RSS
            for line in f:
                if line.startswith("VmRSS:"):
                    return round(int(line.split()[1]) / 1024, 1)
    except OSError:
        pass
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss   # macOS: bytes, Linux: KB (peak)
    return round(peak / (1048576 if sys.platform == "darwin" else 1024), 1)


def _cpu_pct() -> float:
    """CPU used by this process since the last call, as % of one core."""
    ru = resource.getrusage(resource.RUSAGE_SELF)
    cpu, now = ru.ru_utime + ru.ru_stime, time.time()
    dt = max(1e-3, now - _cpu_mark["t"])
    pct = (cpu - _cpu_mark["cpu"]) / dt * 100
    _cpu_mark.update(t=now, cpu=cpu)
    return round(max(0.0, pct), 1)


def _db_mb() -> float | None:
    s = get_settings()
    if not s.is_sqlite:
        return None
    path = s.database_url.split("///", 1)[-1]
    try:
        return round(os.path.getsize(path) / 1048576, 1)
    except OSError:
        return None


@router.get("/stats")
async def stats(caller: Caller = Depends(require_device)) -> dict:
    rooms = manager.summary()
    rt = realtime.stats()
    return {
        "impl": "py", "version": os.environ.get("ARENA_VERSION", "dev"), "python": sys.version.split()[0],
        "uptimeSecs": int(time.time() - STARTED), "rssMb": _rss_mb(), "cpuPct": _cpu_pct(),
        "rooms": len(rooms), "online": sum(r["members"] for r in rooms),
        "gameLoops": rt["running"], "gameLoopsMax": rt["max"],
        "overruns": sum(r.get("overruns", 0) for r in rt["rooms"].values()),
        "db": await describe_backend(), "dbMb": _db_mb(),
    }
