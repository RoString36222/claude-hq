# dashboard-rs (`claudehq`)

The local Claude HQ server. It reads your Claude Code (and Cursor) sessions,
computes cost, creatures, seasons and analytics, serves the JSON API and the
page on `127.0.0.1`, and is the only client of the opt-in Arena. The frontend
(`index.html`, `ui/`, `games/`) is plain files in the repo, served as they are
on disk.

## Build and run

Needs Rust (https://rustup.rs).

```bash
cargo build --release --manifest-path dashboard-rs/Cargo.toml
dashboard-rs/target/release/claudehq            # http://127.0.0.1:8765
```

| flag | |
|---|---|
| `--port N` | port on 127.0.0.1 (default 8765) |
| `--no-open` | don't open a browser |
| `--install` / `--uninstall` | write / remove the launchd LaunchAgent (`com.claudehq.dashboard`), pointing at this binary |
| `--print-plist` | print that plist and exit |
| `--root DIR` | the Claude HQ folder. Defaults to `$CLAUDEHQ_ROOT`, else the folder above the binary that holds `index.html` + `ui/` (so `dashboard-rs/target/release/claudehq` finds the repo) |
| `--print-index` | print the assembled page and exit (the frontend tests read it) |

To start it at login:

```bash
dashboard-rs/target/release/claudehq --install
```

The in-app Update button pulls, runs `cargo build --release --locked` and
restarts into the new binary (re-exec, or a launchd kickstart when launchd
started it).

## Tests

```bash
cd dashboard-rs
cargo test
cargo clippy --locked --all-targets -- -D warnings
```

Unit tests sit next to the code: the cost model, config validation, atomic
state and quarantine, the meal ledger, the fatigue contract vectors, needs-you
detection, slim cards, the payload memo, flexible streaks, Cursor transcripts
and titles, work-signal classification, music parsing and the share loop, the
Arena wire allowlists (pantry, cali, rooms, portrait, gifts, nudges), every ext
proxy, the pantry eat flow, close/resume guards and the self-update (on
throwaway git repos). `tests/http.rs` checks the gates on a real 127.0.0.1
server, and `tests/scanner.rs` the transcript pass, busy spans and work signals.

## Notes

- **Invalid `Content-Length`** (`abc`, `-5`): hyper rejects the request itself
  with an empty `400`. A missing length is `411`, too big `413`.
- Arena HTTPS uses rustls with the Mozilla root set, not the macOS keychain:
  an Arena behind a private CA won't verify.
- macOS asks once before `claudehq` may script Spotify / Music / browsers for
  Now Playing.
- JSON lines with `NaN`/`Infinity` literals are skipped.

## Layout

| file | what |
|---|---|
| `src/main.rs` | CLI, binds `127.0.0.1` |
| `src/server.rs` | routes, the Host / CSRF / Origin gates, static files, `assemble_index`, SSE |
| `src/scan.rs` | the transcript scan, the Cursor scanner, prompt/markdown/error helpers |
| `src/app.rs` | paths, caches, `scan_file`, config / meta / meals / game save, dex salt, `APP_VERSION` |
| `src/payload.rs` | session cards, archived cards, season, feed, payload memo + stream signature, session detail |
| `src/analytics.rs` | search, history, Pokédex, project, digest, insights, transcript events, exports |
| `src/fatigue.rs`, `src/creature.rs`, `src/cost.rs` | fatigue walk, creatures/levels, prices |
| `src/handlers.rs` | pantry bodies + eat flow, quest rewards, cali orders, room bodies, soundboard |
| `src/arena.rs` | the Arena client and its wire allowlists |
| `src/ext.rs` | HQ 2.5 extensions: skills, loot, prestige, maps, cups, boss |
| `src/music.rs`, `src/worksignals.rs` | Now Playing + YouTube; work-signal classification (integers only) |
| `src/actions.rs` | resume / reveal / close, self-update, launchd, notifications |
| `src/py.rs`, `src/pyjson.rs`, `src/difflib.rs`, `src/state.rs` | string/number/JSON helpers that keep the byte format the frontend and state files expect, `SequenceMatcher`, atomic writes |
| `src/bin/creature_vectors.rs` | creature ground truth for HQ Notch's parity check (`notch/tools/parity_vectors.py`) |
