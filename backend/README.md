# Arena backend

The Claude HQ Arena server (Rust: axum + sqlx + SQLite). It began as a port of the
Python/FastAPI backend, ran next to it for a while, and replaced it; the Python one is
gone.

```bash
cargo run --bin arena                        # http://127.0.0.1:8080 (see .env.example)
cargo test --locked && cargo clippy --locked --all-targets -- -D warnings
```

- `src/`: the server; `migrations/`: the schema, applied at startup (`sqlx::migrate!`).
- `data/`: game data embedded at build time with `include_str!` (kart tracks,
  platformer levels, Blaster and Strikezone maps, golf courses, Pokemon). Each one is a
  byte copy of the browser's file under `games/`, checked by `tests/test_game_data_sync.py`.
- `Dockerfile` builds from this folder alone; `docker-compose.yml` + `Caddyfile` run it
  on a VPS behind Caddy (`../deploy-vps.sh` first, then `../ops/release.sh deploy`).

## Monitoring (Prometheus + Grafana)

The Arena serves Prometheus metrics on its own port when `ARENA_METRICS_BIND` is set
(`docker-compose.yml` sets `0.0.0.0:9091`). Caddy only proxies `app:8080`, so `/metrics`
is never public. Labels are the method, the route template (`/v1/rooms/:room_id/ws`,
never a raw path) and the status, so no room, user or handle ends up in a series.

On the VPS, from `backend/`:

```bash
echo 'GRAFANA_ADMIN_PASSWORD=<a strong password>' >> .env
echo 'COMPOSE_PROFILES=monitoring' >> .env      # keep it in every `docker compose` call
docker compose --profile monitoring up -d prometheus node-exporter grafana
ssh -L 3000:127.0.0.1:3000 <you>@<vps>          # from your machine; then open http://localhost:3000
```

- **Prometheus** (`monitoring/prometheus.yml`) scrapes the Arena and node-exporter every
  15 s and keeps 30 days (at most 2 GB). It is not published on the host.
- **node-exporter** reads the VPS's CPU, memory, disk and load from the host's `/proc`,
  `/sys` and root filesystem (read-only). It is not published on the host.
- **Grafana** listens on `127.0.0.1:3000` of the VPS only (reach it over SSH). It opens
  on the provisioned **Arena backend** dashboard (`monitoring/grafana/dashboards/arena.json`):
  - overview: up, version, uptime, requests/s, 5xx rate, p95 latency, open websockets, people in rooms
  - traffic and latency (p50/p95/p99) per route, a route table, 4xx and 5xx per route
  - websockets, rooms, game loops and tick overruns
  - the Arena process (CPU, RSS, threads, fds, SQLite and WAL size, DB pool)
  - the VPS (CPU, memory, disk, disk I/O)
  - restarts (deploys) as annotations
- `ops/release.sh` only restarts `app`, so deploys leave the monitoring containers running.
  Grafana's update checks and usage reporting are off.

| metric | type | what |
|---|---|---|
| `arena_http_requests_total{method,route,status}` | counter | requests |
| `arena_http_request_duration_seconds{method,route}` | histogram | time to the response head |
| `arena_http_requests_in_flight` | gauge | requests being handled |
| `arena_ws_connections`, `arena_ws_connections_total` | gauge, counter | room websockets |
| `arena_rooms{kind}`, `arena_room_members{kind}` | gauge | public/private rooms and people |
| `arena_game_loops`, `arena_game_loops_max`, `arena_game_loop_overruns` | gauge | real-time game ticks |
| `arena_db_pool_connections{state}`, `arena_db_size_bytes{file}` | gauge | SQLite |
| `arena_build_info{version}`, `arena_uptime_seconds`, `process_*` | gauge, counter | the process |

## Where Rust improves on the original

**The tool allowlist is a type.** In Python, `mcp__acme_internal__query`
arrives as a string that a validator must remember to bucket. Here it
deserialises to `Tool::Other` and the original text is dropped — there is no
representable value that carries an MCP server name, so no code path can store
one.

**`deny_unknown_fields` is generated code**, not a runtime setting, so a client
that grows a field fails to parse rather than relying on config being right.

**`Option<f64>` for cost** makes "did not share" and "spent nothing" different
types rather than a nullable column you must remember to check.

## Status

| | |
|---|---|
| `scoring.rs` | done, cross-checked against Python |
| `schemas.rs` | done, privacy tests ported |
| `db.rs` | next — sqlx against the existing schema |
| `service.rs` | ingest + board queries |
| `auth.rs` | device tokens, OAuth, WS tickets |
| `rooms.rs` | websocket rooms; room-wide broadcast plus a bounded direct queue per connection (one socket / one user / a lobby) |
| `realtime.rs` | done: fixed-rate per-room tick (tokio), process-wide ticker budget, per-room bytes/s budget with snapshot thinning, overrun counting, token `Bucket` — port of `app/realtime.py` |
| `kart.rs` | done: Kart Racing — track compile/geometry, referee (grid → race → done, laps, sender-clock speed check, fixes, drop/restore), the kart lobby and its tick loop — port of `app/kart.py` + the kart branch of `app/valley.py`. Kart and the platformer are the only Valley games here; any other `g` gets `unknown game` |
| `platformer.rs` | done: Platformer Rush — level compile/geometry, referee (grid → run → done; race and co-op; sender-clock speed, rise/fall and jump-envelope checks, never inside a platform, checkpoints in order, coins once per player / once per room, the flag, fixes, respawns, drop/restore), the plat lobby and its tick loop (sharing the process-wide `realtime::Registry` with kart) — port of `app/platformer.py` + the plat branch of `app/valley.py` |

Kart tracks are read from `backend/data/kart_tracks.json` with `include_str!`
at build time, so both backends race on the same file; a test checks the
embedded copy against it.
Platformer levels come from `backend/data/platformer_levels.json` the same way.

```bash
cargo test    # 97 tests
```
