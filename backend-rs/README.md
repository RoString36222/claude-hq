# arena (backend-rs)

The Claude HQ Arena server: a shared leaderboard, seasons, pantry, crews, and
websocket rooms for the Valley games. axum + sqlx on SQLite. It applies
`migrations/` itself when it starts, and every game's data file in `data/`
(tracks, maps, courses, levels, creatures) is compiled in with `include_str!`.

How to deploy it (compose + Caddy, the self-host wizard, `ops/release.sh`) is in
[`backend/README.md`](../backend/README.md).

```bash
cargo build --release            # target/release/arena
cargo test
cargo clippy --locked --all-targets -- -D warnings
```

`arena --health` asks the running server's `/health` and exits 0 or 1 (the
container healthcheck).

## Where to find things

| Path | What |
|---|---|
| `src/main.rs` | Startup, routes, ingest and board endpoints. |
| `src/schemas.rs` | The wire allowlist. The privacy boundary. |
| `src/scoring.rs` | XP / level / rank / streak. |
| `src/service.rs` | Ingest (upsert per day) and leaderboard queries. |
| `src/auth.rs` | Device tokens, OAuth, pairing codes, websocket tickets. |
| `src/db.rs` | SQLite connection (WAL, busy timeout, foreign keys) and migrations. |
| `src/rooms.rs`, `src/realtime.rs` | Websocket rooms; the fixed-rate per-room tick and its budgets. |
| `src/valley.rs`, `src/valley/` | The Valley lobby and the turn-based / small games (pond, race, duel, mines, farm, golf, pokebattle, typerace, td, bowling, party, hq). |
| `src/kart.rs`, `src/platformer.rs`, `src/fps.rs`, `src/strike.rs` | The real-time games' referees. Each mirrors a shared block in its `games/*.js` client; `tests/test_*_sync.py` check the two agree. |
| `src/protocol.rs` | Protocol version + capabilities per game. |
| `src/pantry.rs`, `src/cali.rs`, `src/crews.rs`, `src/cosmetics.rs`, ... | The rest of the API, one module per area. |
| `data/` | Game data. Each file mirrors the client copy under `games/`, and a test checks they match. |
| `migrations/` | The schema. Migrations only ever add. |

## Design notes

**The tool allowlist is a type.** `mcp__acme_internal__query` deserialises to
`Tool::Other` and the original text is dropped — there is no representable value
that carries an MCP server name, so no code path can store one.

**`deny_unknown_fields` is generated code**, not a runtime setting, so a client
that grows a field fails to parse rather than relying on config being right.

**`Option<f64>` for cost** makes "did not share" and "spent nothing" different
types rather than a nullable column you must remember to check.

`src/bin/crosscheck.rs` prints the scoring for a fixed set of cases as JSON, for
diffing when the formula changes.
