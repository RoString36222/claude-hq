# Claude HQ Arena

The multiplayer backend for [Claude HQ](../README.md): a shared leaderboard,
seasons, and websocket rooms for minigames.

## What crosses the network

Claude HQ reads your transcripts. This backend never sees them.

The local client (`arena.py`) sends **daily counts only** — prompts, tool calls,
artifacts, tokens. It never sends prompt text, replies, file paths, project or
folder names, session ids, or titles. Two details worth knowing:

- **Tool names are allowlisted.** MCP tools are named `mcp__<server>__<tool>` and
  routinely carry an employer's or client's name, so anything that isn't a
  built-in Claude Code tool is bucketed as `Other` before it can reach the wire.
- **Cost is opt-in and off by default.** Spend is salary- and employer-adjacent.

`StatPayload` uses `extra="forbid"`, so a client that grows a new field cannot
silently start leaking it — the server rejects the whole submission until that
field is added to `app/schemas.py` deliberately.

## Scoring is the server's job

Clients submit raw activity, never a score. XP, levels, ranks and streaks are
derived in `app/scoring.py`. That means the formula can change without a client
release, and faking a score means faking plausible daily activity rather than
POSTing `{"xp": 999999}`.

There is no anti-cheat beyond sanity clamps (`ARENA_MAX_DAILY_*`), and that's
deliberate: the client runs on your friends' machines. The clamps exist so a
client bug or a prank can't permanently distort the board, not to stop a
determined faker.

## Layout

| Path | What |
|---|---|
| `app/schemas.py` | The wire allowlist. The privacy boundary. |
| `app/scoring.py` | XP / level / rank / streak. Mirrors `dashboard.py`. |
| `app/service.py` | Ingest (upsert per day) and leaderboard queries. |
| `app/rooms.py` | In-process websocket rooms: presence, broadcast, shared state. |
| `app/auth.py` | Device tokens, pairing codes, websocket tickets. |
| `alembic/` | Migrations. |

`daily_stats` is **upserted** per (user, day), never summed — the client rescans
whole transcripts, so each submission is authoritative for that day.
`stat_snapshots` keeps every raw submission so the board can be recomputed if
the scoring rules change.

## Running locally

```bash
cd backend
uv sync
cp .env.example .env          # defaults to SQLite; no Postgres needed
uv run uvicorn app.main:app --reload --port 8080
uv run pytest                 # 22 tests
```

## Deploying

`./deploy-wizard.sh` from the repo root walks through Neon, the GitHub OAuth
app, and `fly launch`. It only does the parts a script can; it stops and tells
you when a step needs a browser.

## Scale note

Rooms hold presence and shared state **in process memory**, so this service must
run as exactly one machine (`fly.toml` sets `min_machines_running = 1` and
`auto_stop_machines = false`). For a group of friends that is the right trade.
Scaling out means putting rooms behind Redis pub/sub first — `app/rooms.py` is
the only file that changes.

## API

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | |
| `GET` | `/v1/auth/github/start` | Redirects to GitHub |
| `GET` | `/v1/auth/github/callback` | Shows a one-shot pairing code |
| `POST` | `/v1/auth/pair` | Code → device token |
| `POST` | `/v1/auth/ticket` | Device token → 60s websocket ticket |
| `POST` | `/v1/stats` | Ingest. Bearer device token. |
| `GET` | `/v1/board?window=season\|30d\|7d\|all` | |
| `GET` | `/v1/board/stream` | SSE, pushes on ingest |
| `GET` | `/v1/me` | |
| `GET` | `/v1/rooms` | Open rooms |
| `WS` | `/v1/rooms/{room}/ws?ticket=` | Presence, `say`, `state`, `ping` |
