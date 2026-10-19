# Claude HQ Arena: deploying it

The multiplayer backend for [Claude HQ](../README.md): a shared leaderboard,
seasons, and websocket rooms for minigames. The server is the Rust one in
[`backend-rs/`](../backend-rs/README.md) (binary `arena`); this folder holds only
what you need to run it somewhere:

| File | What |
|---|---|
| `docker-compose.yml` | The Arena (built from `backend-rs/Dockerfile`) behind Caddy, plus the optional deploy panel. |
| `Caddyfile` | TLS, websockets, SSE, security headers. |
| `.env.example` | The settings the Arena reads from its environment. Copy to `.env`. |

The Arena applies `backend-rs/migrations/` itself when it starts, so there is no
separate migration step, and its game data (`backend-rs/data/`) is compiled into
the binary.

## What crosses the network

Claude HQ reads your transcripts. This backend never sees them.

The local client (the HQ server's `dashboard-rs/src/arena.rs`) sends **daily
counts only** — prompts, tool calls, artifacts, tokens. It never sends prompt
text, replies, file paths, project or folder names, session ids, or titles. Two
details worth knowing:

- **Tool names are allowlisted.** MCP tools are named `mcp__<server>__<tool>` and
  routinely carry an employer's or client's name, so anything that isn't a
  built-in Claude Code tool is bucketed as `Other` before it can reach the wire,
  and the server's `Tool` type (`backend-rs/src/schemas.rs`) has no value that
  could carry the original name.
- **Cost is opt-in and off by default.** Spend is salary- and employer-adjacent.

The stat payload is parsed with `deny_unknown_fields`, so a client that grows a
new field cannot silently start leaking it — the server rejects the whole
submission until that field is added to `backend-rs/src/schemas.rs` deliberately.

Poke Coins and snacks (`backend-rs/src/pantry.rs`) are the one other thing the
server stores. A pantry request carries a food kind, an amount, a recipient
handle and an optional note. It never says which session ate a snack: that stays
on your machine. Coins are cosmetic and never touch XP or the board.

## Scoring is the server's job

Clients submit raw activity, never a score. XP, levels, ranks and streaks are
derived in `backend-rs/src/scoring.rs`. That means the formula can change without
a client release, and faking a score means faking plausible daily activity rather
than POSTing `{"xp": 999999}`.

There is no anti-cheat beyond sanity clamps (`ARENA_MAX_DAILY_*`), and that's
deliberate: the client runs on your friends' machines. The clamps exist so a
client bug or a prank can't permanently distort the board, not to stop a
determined faker.

`daily_stats` is **upserted** per (user, day), never summed — the client rescans
whole transcripts, so each submission is authoritative for that day.
`stat_snapshots` keeps every raw submission so the board can be recomputed if
the scoring rules change.

## Running locally

```bash
cp backend/.env.example backend/.env       # SQLite; fill in GitHub OAuth to pair
cargo build --release --manifest-path backend-rs/Cargo.toml
(cd backend && set -a && . ./.env && set +a && ../backend-rs/target/release/arena)
```

It listens on `ARENA_BIND_HOST:ARENA_BIND_PORT` (default `0.0.0.0:8081`; set
`ARENA_BIND_PORT=8080` to match the example's `ARENA_PUBLIC_BASE_URL`). Tests:
`cd backend-rs && cargo test`.

## Deploying

### On your own Mac: `./selfhost-wizard.sh`

From the repo root. It builds the Arena with `cargo` (install Rust from
https://rustup.rs), writes `backend/.env` (SQLite at `backend/arena.db`), sets up
a Cloudflare Tunnel to your hostname, and installs LaunchAgents for the Arena and
the tunnel. It stops and tells you when a step needs a browser.

| | |
|---|---|
| Database | SQLite (one file) |
| Reachable via | Cloudflare Tunnel |
| Cost | free |
| Up when | your Mac is awake |

Your Mac sleeping is not destructive: publishes retry every 5 minutes and each
one carries a 30-day window, so nothing is lost. The board is simply
unreachable until the machine is back.

### On any VM with Docker

`docker-compose.yml` runs the app behind Caddy, which obtains and renews TLS
automatically — no certbot cron to forget. Works on Hetzner, DigitalOcean,
Oracle's free ARM tier, or anything else with Docker.

```bash
# point your domain's A record at the VM, then:
cp .env.example .env            # fill in the GitHub OAuth values
ARENA_DOMAIN=arena.example.com docker compose up -d --build
```

The app is only reachable through Caddy (`expose`, not `ports`), the database
lives on the `arena-data` volume so it survives a redeploy, and `caddy-data`
holds the certificates — keep both. The container's healthcheck is
`arena --health`.

You still need a domain: Let's Encrypt will not issue for a bare IP, and the
game rooms want `wss://`.

### Database notes

SQLite is the database. The Arena opens it in WAL mode (readers don't block
while a publish writes) with a busy timeout and foreign keys on. Back it up by
copying the file (`backend/arena.db` on a Mac, the `arena-data` volume on a VM).

`ARENA_DATABASE_URL` should be an absolute path, in the four-slash form
(`sqlite+aiosqlite:////abs/path/arena.db`; `sqlite:/abs/path/arena.db` works
too). launchd starts the service from a different working directory, and a
relative path would quietly create a second, empty database elsewhere.

## Releasing

`ops/release.sh` is the one command for shipping the Arena once it is deployed
on a VM:

```bash
ops/release.sh check                  # every test suite, locally, before you merge
ops/release.sh deploy                 # on the host: pull main, check CI, build, ship, verify
ops/release.sh rollback               # back to the previous release, no rebuild
ops/release.sh status                 # what runs now, history, kept images
```

Each release is an image tagged with the UTC date and commit (`2026.10.07-76ee057`),
shown by `/health` as `version`. The last three are kept, so a rollback just
starts the previous image. A deploy refuses a commit whose GitHub CI has not
passed, and rolls itself back if the new build is not healthy within two minutes.
CI runs the whole thing on every backend PR (`release-smoke.yml`).

A rollback restores code, not data: migrations only ever add, and an older build
skips ones it has not seen.

## Scale note

Rooms hold presence and shared state **in process memory**, so this service must
run as exactly one process. For a group of friends that is the right trade.
Scaling out means putting rooms behind a pub/sub first (`backend-rs/src/rooms.rs`).

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
| `GET` | `/v1/pantry` | Poke Coins, snacks, today's claim, limits, recent gifts. Read-only. |
| `POST` | `/v1/pantry/claim` | Today's 5 coins, once per UTC day (the first ever adds a Rice Ball) |
| `POST` | `/v1/pantry/buy` | `{requestId, kind, qty}` |
| `POST` | `/v1/pantry/eat` | `{requestId, kind}`. Never says which session ate. |
| `POST` | `/v1/pantry/give` | `{requestId, toHandle, coins, kind?, qty, note?}`, delivered live as a lobby `gift` |
| `POST` | `/v1/pantry/gifts/drain` | Undelivered gifts, each returned once |
| `POST` | `/v1/cali/orders` | Log one California Burrito dinner: `{requestId, date?, diners[], note?}`. Each diner is `{handle? , name?, tacos:{mildHard,mildSoft,wildHard,wildSoft}}`. Buy-1-get-1 is pooled across the table, so the server prices it (`paid = ceil(TT/2)`) rather than trusting a total. Idempotent by `requestId`. |
| `GET` | `/v1/cali/orders` | The shared dinner log, newest first |
| `GET` | `/v1/cali/board?window=season\|30d\|7d\|all` | The cali-leaderboard: Tuesdays attended, total tacos (TT) as the tiebreak, with tacos-per-person (TPP) per entry |
| `GET` | `/v1/rooms` | Open rooms |
| `WS` | `/v1/rooms/{room}/ws?ticket=` | Presence, `say` (a `{kind: "chat"}` payload is lobby chat: cleaned, rate-limited, last 50 kept in memory and sent in `welcome`), `state`, `nudge`, `signal` (WebRTC setup, to one member), `ping` |
