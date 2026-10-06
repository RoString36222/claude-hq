# arena-rs

A Rust port of the Arena backend, built **alongside** the Python one rather
than replacing it. Both read the same SQLite file and serve the same endpoints,
so you can switch which one Caddy proxies to and switch back.

This exists to learn Rust on something real. The Python backend is fine:
measured at 69 MB and 0.25% CPU under load, so this is not a performance fix.

## Why parallel, not a rewrite

Upstream merged 69 commits in one recent week, 61 of them touching `backend/`.
A replacement stops receiving that work. Running side by side means the Python
one keeps getting chat, voice and nudges from the other contributors while this
one catches up at its own pace — and abandoning it costs nothing.

## Correctness

The scoring must agree with the Python exactly, or the same user sees a
different level depending on which backend answered. `src/bin/crosscheck.rs`
prints scoring output as JSON for diffing against `app/scoring.py`:

```bash
cargo run --bin crosscheck > /tmp/rust.txt
# compare with the equivalent Python output
```

Currently byte-identical across 13 cases spanning level 1 to 126.

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
| `rooms.rs` | websocket rooms |

```bash
cargo test    # 18 tests
```
