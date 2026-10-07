"""Arena load test: bots fill many 8-player rooms across the real-time games
(Kart Racing, Platformer Rush, Blaster Arena) and report server CPU and memory,
bandwidth, and late ticks.

    cd backend
    uv run python scripts/loadtest.py                       # Python Arena, 24 rooms x 8 bots, 60 s
    uv run python scripts/loadtest.py --impl rs             # the Rust Arena (cargo build --release first)
    uv run python scripts/loadtest.py --rooms 6 --seconds 20

It starts the Arena itself on a throwaway database, seeds one user per bot,
and puts each room on one game (round-robin). Every bot joins the game's lobby;
the room's first bot hosts and starts it; then every bot sends position frames
at --send-hz (holding still at its spawn point, which the referee accepts), and
Blaster bots also fire. That keeps every room's server loop applying its rules
and sending full snapshots, the way a real match does.

Measured:
  server   CPU % and RSS of the Arena process (ps, once a second)
  ticks    gaps between snapshots each bot received; a gap over one tick period
           plus SLOW (0.25 s, the server's own overrun threshold) counts as late.
           With the Python Arena, the server's own overrun counters too.
  network  bytes and messages per second received by bots (= sent by the server)

Exit status 1 when any room failed to start or the late-tick rate passes --max-late.
Nothing here touches a real Arena: it only talks to the one it started.
"""
import argparse
import math
import asyncio
import json
import os
import shutil
import signal
import socket
import statistics
import subprocess
import sys
import tempfile
import time

import httpx
import websockets

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
REPO = os.path.dirname(BACKEND)
GAMES = {"kart": 15, "plat": 15, "fps": 20}          # game -> server tick rate (Hz)
SLOW = 0.25                                          # matches realtime.SLOW_TICK
START = {"kart": {"track": "meadow", "laps": 9}, "plat": {"level": "meadow", "mode": "race"},
         "fps": {"minutes": 10, "kills": 999}}


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# ------------------------------------------------------------------ server --
def migrate(db_url: str, env: dict) -> None:
    subprocess.run(["uv", "run", "--no-dev", "alembic", "upgrade", "head"], cwd=BACKEND, check=True,
                   env=dict(env, ARENA_DATABASE_URL=db_url), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


async def seed(db_url: str, n: int, env: dict) -> list[str]:
    """One user + paired device per bot, written straight into the throwaway DB."""
    code = (
        "import asyncio,json,sys\n"
        "from app.auth import hash_token,new_device_token\n"
        "from app.db import SessionLocal\n"
        "from app.models import Device,User\n"
        "async def main(n):\n"
        "    toks=[]\n"
        "    async with SessionLocal() as db:\n"
        "        for i in range(n):\n"
        "            u=User(github_id=900000+i,handle=f'bot{i}',display_name=f'Bot {i}',avatar_url='')\n"
        "            db.add(u); await db.flush(); t=new_device_token(); toks.append(t)\n"
        "            db.add(Device(user_id=u.id,token_hash=hash_token(t),label='loadtest'))\n"
        "        await db.commit()\n"
        "    print(json.dumps(toks))\n"
        "asyncio.run(main(int(sys.argv[1])))\n"
    )
    r = subprocess.run(["uv", "run", "--no-dev", "python", "-c", code, str(n)], cwd=BACKEND, check=True,
                       env=dict(env, ARENA_DATABASE_URL=db_url), capture_output=True, text=True)
    return json.loads(r.stdout.strip().splitlines()[-1])


def start_server(impl: str, port: int, db_url: str, env: dict) -> subprocess.Popen:
    env = dict(env, ARENA_DATABASE_URL=db_url, ARENA_BIND_PORT=str(port), ARENA_BIND_HOST="127.0.0.1",
               ARENA_EXPOSE_REALTIME_STATS="1", RUST_LOG="warn")
    if impl == "py":
        cmd = ["uv", "run", "--no-dev", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port),
               "--log-level", "warning"]
        return subprocess.Popen(cmd, cwd=BACKEND, env=env, start_new_session=True,
                                stderr=open(os.path.join(os.path.dirname(db_url.split("///", 1)[1]), "server.log"), "w"))
    binary = os.path.join(REPO, "backend-rs", "target", "release", "arena")
    if not os.path.exists(binary):
        sys.exit("build the Rust Arena first: (cd backend-rs && cargo build --release)")
    return subprocess.Popen([binary], cwd=BACKEND, env=env, start_new_session=True,
                            stderr=open(os.path.join(os.path.dirname(db_url.split("///", 1)[1]), "server.log"), "w"))


def server_pid(proc: subprocess.Popen, impl: str) -> int:
    """`uv run` forks the real interpreter; measure that, not the uv wrapper."""
    if impl == "rs":
        return proc.pid
    try:
        out = subprocess.run(["pgrep", "-P", str(proc.pid)], capture_output=True, text=True).stdout.split()
        return int(out[0]) if out else proc.pid
    except (OSError, ValueError):
        return proc.pid


def ps_sample(pid: int) -> tuple[float, float] | None:
    try:
        out = subprocess.run(["ps", "-o", "%cpu=,rss=", "-p", str(pid)], capture_output=True, text=True).stdout.split()
        return float(out[0]), float(out[1]) / 1024.0
    except (OSError, ValueError, IndexError):
        return None


# -------------------------------------------------------------------- bots --
class Stats:
    def __init__(self) -> None:
        self.bytes = 0
        self.msgs = 0
        self.gaps: dict[str, list[float]] = {g: [] for g in GAMES}
        self.started: set[str] = set()
        self.errors: list[str] = []
        self.fixes = 0
        self.sent = 0


async def bot(i: int, base: str, token: str, room: str, game: str, host: bool, ready: asyncio.Event,
              joined: list, players: int, stop_at: float, hz: float, st: Stats) -> None:
    async with httpx.AsyncClient(base_url=base, timeout=10) as http:
        r = await http.post("/v1/auth/ticket", headers={"Authorization": f"Bearer {token}"})
        r.raise_for_status()
        ticket = r.json()["ticket"]
    url = base.replace("http", "ws", 1) + f"/v1/rooms/{room}/ws?ticket={ticket}"
    me = None
    pos = None             # my last server-confirmed position (what the referee holds)
    life = None
    live = False
    t0 = time.monotonic()
    async with websockets.connect(url, max_size=2 ** 22, ping_interval=None) as ws:
        async def send(op: str, **data) -> None:
            await ws.send(json.dumps({"type": "game", "g": game, "op": op, **data}))
            st.sent += 1

        async def reader() -> None:
            nonlocal me, pos, life, live
            last = None
            async for raw in ws:
                st.bytes += len(raw)
                st.msgs += 1
                m = json.loads(raw)
                if m.get("type") == "welcome":
                    me = m["you"]["userId"]
                    await send("join")
                    continue
                if m.get("type") != "game" or m.get("g") != game:
                    continue
                ev = m.get("ev")
                if ev == "lobby":
                    roster = m.get("members") or []
                    joined[:] = [p.get("userId") for p in roster]
                    host_id = next((p.get("userId") for p in roster if p.get("host")), None)
                    if len(roster) >= players and not ready.is_set():
                        ready.host = host_id
                        ready.set()
                elif ev == "error":
                    st.errors.append(f"{game}/{room}: {m.get('error')}")
                elif ev == "go":
                    live = True
                    st.started.add(room)
                elif ev == "fix":
                    st.fixes += 1
                    pos = {k: m[k] for k in ("x", "y", "z", "r") if k in m}
                elif ev == "fps" and isinstance(m.get("match"), dict):
                    for pl in m["match"].get("players") or []:
                        if (pl.get("user") or {}).get("userId") == me:
                            pos = {k: pl[k] for k in ("x", "y", "z", "r")}
                            life = pl.get("e")
                elif ev == "spawn" and m.get("user") == me:
                    pos = {k: m[k] for k in ("x", "y", "z") if k in m}
                    pos["r"] = 0
                    life = m.get("e", m.get("life"))
                elif ev == "snap":
                    now = time.monotonic()
                    if last is not None:
                        st.gaps[game].append(now - last)
                    last = now
                    if pos is None:
                        rows = m.get("cars") or m.get("ps") or []
                        for c in rows:
                            if isinstance(c, dict) and c.get("u") == me:
                                pos = {k: c[k] for k in ("x", "y", "z", "r") if k in c}

        task = asyncio.create_task(reader())
        try:
            await asyncio.wait_for(ready.wait(), 30)
        except asyncio.TimeoutError:
            if host:
                st.errors.append(f"{room}: only {len(joined)}/{players} bots joined")
        host = getattr(ready, "host", None) == me      # the game lobby's host starts and ends it
        if host:
            await asyncio.sleep(1.0)
            await send("start", **START[game])
        n = 0
        while time.monotonic() < stop_at and not task.done():
            await asyncio.sleep(1.0 / hz)
            if not live or pos is None:
                continue
            n += 1
            q = int((time.monotonic() - t0) * 100) + 1
            frame = dict(pos, q=q)
            if game == "kart":
                frame["s"] = 0
            if game == "fps":
                # Blaster only snapshots what changed, so a bot that stands still costs
                # nothing: sway 40 cm either side of the spawn (well under MAX_SPEED).
                frame["x"] = frame["x"] + int(40 * math.sin(n / hz * 2.0))
                frame.setdefault("y", 0)
                frame["p"] = 0
                if life is not None:
                    frame["e"] = life
            await send("pos", **frame)
            if game == "fps" and n % max(1, int(hz // 2)) == 0:        # two shots a second
                await send("fire", w=0, ox=frame["x"], oy=frame["y"] + 150, oz=frame["z"],
                           r=(i * 37) % 360, p=0, q=q, **({"e": life} if life is not None else {}))
        if host:
            await send("end")
            await asyncio.sleep(0.3)
        task.cancel()


# ------------------------------------------------------------------ report --
def pct(xs: list[float], p: float) -> float:
    if not xs:
        return 0.0
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(p / 100.0 * len(xs)))]


async def run(args) -> int:
    env = dict(os.environ, ARENA_SECRET_KEY="loadtest-secret", PYTHONUNBUFFERED="1")
    tmp = tempfile.mkdtemp(prefix="arena-load-")
    db_url = f"sqlite+aiosqlite:///{tmp}/arena.db"
    nbots = args.rooms * args.players
    print(f"Arena load test: {args.impl}, {args.rooms} rooms x {args.players} bots = {nbots} bots, "
          f"{args.seconds}s, frames at {args.send_hz} Hz")
    migrate(db_url, env)
    tokens = await seed(db_url, nbots, env)
    port = free_port()
    proc = start_server(args.impl, port, db_url, env)
    base = f"http://127.0.0.1:{port}"
    st = Stats()
    try:
        async with httpx.AsyncClient(base_url=base, timeout=2) as http:
            for _ in range(100):
                try:
                    if (await http.get("/health")).json().get("ok"):
                        break
                except (httpx.HTTPError, ValueError):
                    pass
                await asyncio.sleep(0.2)
            else:
                print("the Arena did not come up")
                return 1
        pid = server_pid(proc, args.impl)
        games = [g for g in args.games.split(",") if g in GAMES]
        stop_at = time.monotonic() + args.seconds + 8          # + join and countdown
        tasks = []
        for r in range(args.rooms):
            room, game = f"load-{r}", games[r % len(games)]
            ready, joined = asyncio.Event(), []
            for k in range(args.players):
                i = r * args.players + k
                tasks.append(bot(i, base, tokens[i], room, game, k == 0, ready, joined, args.players,
                                 stop_at, args.send_hz, st))
        samples = []
        srv = {"loops": 0, "overruns": {}, "thinned": set()}   # the Python Arena's own counters

        async def sampler() -> None:
            mark = (time.monotonic(), st.bytes, st.msgs)
            http = httpx.AsyncClient(base_url=base, timeout=2) if args.impl == "py" else None
            while time.monotonic() < stop_at:
                await asyncio.sleep(1.0)
                if http is not None:
                    try:
                        rs = (await http.get("/v1/realtime/stats")).json()
                        srv["loops"] = max(srv["loops"], rs.get("running", 0))
                        for k, r in rs.get("rooms", {}).items():
                            srv["overruns"][k] = r.get("overruns", 0)
                            if r.get("stride", 1) > 1:
                                srv["thinned"].add(k)
                    except (httpx.HTTPError, ValueError):
                        pass
                s = ps_sample(pid)
                now = time.monotonic()
                rate = ((st.bytes - mark[1]) / (now - mark[0]), (st.msgs - mark[2]) / (now - mark[0]))
                mark = (now, st.bytes, st.msgs)
                if s:
                    samples.append((s[0], s[1], rate[0], rate[1]))
                    if args.verbose:
                        print(f"  cpu {s[0]:5.1f}%  rss {s[1]:6.1f} MB  out {rate[0] / 1024:7.1f} KB/s  {rate[1]:6.0f} msg/s")
            if http is not None:
                await http.aclose()

        results = await asyncio.gather(sampler(), *tasks, return_exceptions=True)
        for res in results:
            if isinstance(res, Exception):
                st.errors.append(f"bot crashed: {type(res).__name__}: {res}")
    finally:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except OSError:
            pass
        try:
            proc.wait(5)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(tmp, ignore_errors=True)

    # Skip the first samples (joins, countdown) when there are enough.
    steady = samples[8:] if len(samples) > 12 else samples
    cpu = [s[0] for s in steady]
    rss = [s[1] for s in samples]
    bw = [s[2] for s in steady]
    mps = [s[3] for s in steady]
    print()
    print(f"rooms started   {len(st.started)}/{args.rooms}")
    if cpu:
        print(f"server CPU      mean {statistics.mean(cpu):.1f}%   p95 {pct(cpu, 95):.1f}%   max {max(cpu):.1f}%  (100% = one core)")
        print(f"server memory   peak {max(rss):.1f} MB")
        print(f"bandwidth out   mean {statistics.mean(bw) / 1024:.1f} KB/s   peak {max(bw) / 1024:.1f} KB/s   "
              f"({statistics.mean(bw) * 8 / 1e6:.2f} Mbit/s)")
        print(f"messages out    mean {statistics.mean(mps):.0f}/s")
    print(f"frames sent     {st.sent}   corrections back {st.fixes}")
    worst_late = 0.0
    for g, hz in GAMES.items():
        gaps = st.gaps[g]
        if not gaps:
            continue
        period = 1.0 / hz
        late = sum(1 for x in gaps if x > period + SLOW) / len(gaps)
        worst_late = max(worst_late, late)
        print(f"ticks {g:5}     {len(gaps)} gaps   p50 {pct(gaps, 50) * 1000:.0f} ms   p99 {pct(gaps, 99) * 1000:.0f} ms"
              f"   late {late * 100:.2f}%   (period {period * 1000:.0f} ms)")
    if args.impl == "py":
        print(f"server ticks    peak {srv['loops']} loops   overruns {sum(srv['overruns'].values())}   "
              f"rooms that thinned snapshots {len(srv['thinned'])}")
    if st.errors:
        print(f"errors          {len(st.errors)}: " + "; ".join(sorted(set(st.errors))[:6]))
    failed = len(st.started) < args.rooms or worst_late > args.max_late
    print("RESULT          " + ("FAIL" if failed else "PASS"))
    return 1 if failed else 0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--impl", choices=("py", "rs"), default="py")
    ap.add_argument("--rooms", type=int, default=24)
    ap.add_argument("--players", type=int, default=8)
    ap.add_argument("--seconds", type=int, default=60)
    ap.add_argument("--send-hz", type=float, default=20.0)
    ap.add_argument("--games", default="kart,plat,fps")
    ap.add_argument("--max-late", type=float, default=0.01, help="fail above this share of late ticks (0.01 = 1%%)")
    ap.add_argument("-v", "--verbose", action="store_true")
    sys.exit(asyncio.run(run(ap.parse_args())))


if __name__ == "__main__":
    main()
