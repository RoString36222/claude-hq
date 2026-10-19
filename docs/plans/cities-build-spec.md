# Cities build spec (HQ 3.x)

The reviewed plan is the "Claude HQ: Cities Roadmap" doc (owner-approved 2026-10-19, all decisions
taken). This file is the engineering contract for building it: what each task owns, the data shapes
every task codes against, and how each task is checked. Tasks run in parallel against these shapes;
nothing here may change without updating this file.

## Product decisions (final)

- **Build order** (by dependency): organic layout, then civic, then NPCs, then personal cities, then islands.
  Tasks run in parallel against this contract; the order only matters where one module consumes another's output.
- **The Commons:** `claude-hq@2` (organic) replaces the gridded Arena City for everyone. `claude-hq@1`
  must keep generating byte-identical output (its fingerprint test stays green).
- **Where HQs live:** in both places. Every user has a tower in the Commons and an HQ next to the town hall on their own island.
- **XP tiers:** thresholds come from a server-side table (`city_tiers`). Seed it with the proposed values:
  0 / 2,000 / 10,000 / 40,000 / 120,000. The values are meant to be retuned against the real XP
  distribution (target: the median user reaches Town in about a month).
- **Economy:** the deep version:
  - passive tax
  - upgrades
  - a specialty good per city
  - supply chains (goods have inputs)
  - prices that move: an hourly market tick, a capped step per tick, inside a band
- **Owners don't place buildings.** Growth is automatic; owners only place parks and decorations on free lots.
- **Water:** a drivable boat (rowboat or jet ski) on open sea is in v1, alongside ferries.
- **Privacy:** a personal city is open to members of the arena its owner is in by default. The owner can
  switch it to friends-only or closed. Visitors walk, ride, shop and trade, but never edit.
- **Fast travel:** at most a token fee (1 coin). Visiting is never something to grind for. Ferries, rail and
  boats are free.
- **Public transport inside a city:**
  - buses from tier 2: loops through the transit hub, a stop about every 250 m on arterials
  - tram or metro from tier 4
  - the fare is a few coins (2), paid into the city treasury
- **Industry zones** are district kinds, each with a layout style, a building kit, a job table and a tier gate:
  - office district (tier 3)
  - tech campus, Silicon Valley style (tier 3, specialty "tech")
  - film studio (tier 4)
  - finance quarter, biotech park, media, harbour logistics, farming and fishing

## Invariants (every task)

- The world is a pure function of (world id, terrain edits). Integer math in the generator: cm, Q16,
  no floats, no trig. The same id gives a byte-identical doc.
- `claude-hq@1` output is unchanged byte for byte: every new serde field is `Option` with
  `skip_serializing_if = "Option::is_none"` and stays `None` in @1.
- Client sims (NPCs, traffic, buses, ferries) are pure functions of (world doc, city state, clock ms).
  Two clients with the same inputs show the same thing, with no server traffic.
- Follow AGENTS.md: privacy, XSS (textContent only, never innerHTML with data), IP and the egress rules.
  Every new dashboard proxy validates its path params with a regex before forwarding.
- Frame-rate independence: `ease(k, dt)` / springs, never `Math.min(1, dt*k)` (a test enforces this).
- Match the surrounding code style: comment density, naming, the module pattern (`HQV.<name>`, node-tested
  pure helpers).

## World ids and profiles

| Id | Profile | Generator |
| --- | --- | --- |
| `claude-hq@1` | `city` (grid) | today's code, frozen |
| `claude-hq@2` | `commons` (organic, 2 km, on an island) | new |
| `user:<uuid>@2` | `island` (organic, a personal city, 1.8 km square, coast at about 850 m) | new |

`worldgen::VERSION` becomes a set: versions 1 and 2 are both accepted. A seed starting `user:` selects
the `island` profile. `world.rs` LIVE accepts `claude-hq@1`, `claude-hq@2`, and any `user:<uuid>@2`
whose uuid matches `UUID_RE`.

## WorldDoc v2: the additions (all `Option`, skipped when `None`)

```text
Block  += poly: [[x,z],...]           // cm, CCW, the block's footprint (both @2 profiles)
Lot    += poly: [[x,z],...]           // cm, CCW
          front: [fx, fz]             // Q16 unit vector the door faces (out to its road)
          grow: u32                   // growth rank: 0 = nearest the core; lots appear in this order
          min_tier: u8                // the first city tier this lot exists in (1..5)
Site   += tier: u8                    // the first tier the site exists in
          poly: [[x,z],...], front: [fx, fz]
Edge   += class gains "arterial" | "local" (@2); @1 classes unchanged
          min_tier: u8 (island profile: the road appears at this tier)
Layers += transit: { lines: [ { id, kind: "bus"|"tram", tier, stops: [site id], path: [node id] } ] }
          island:  { coast: [[x,z],...], sea_cm: i64, docks: [site id], radius_by_tier: [r1..r5] }
Hashes += transit, island (only when present)
```

**District ids** (new values only; 0-10 unchanged):
- 11 OLDTOWN
- 12 DOWNTOWN
- 13 SUBURB
- 14 OFFICE
- 15 TECH
- 16 STUDIO
- 17 FINANCE
- 18 BIOTECH
- 19 MEDIA
- 20 LOGISTICS
- 21 FARM
- 22 WATER

Do not change the serialised `NAMES` that @1 emits: @2 serialises its own list.

**Site kinds (civic), each with `tier`:**
- townhall, clinic, hospital, fire, police, school, university
- market, mall, bank, library, post
- transit, busstop, tramstop
- port, dock, airport, power, water
- stadium
- zone buildings: office, campus, studio, finance, biotech, media, warehouse, farm

The fountain, skatepark, bikepark and spawn sites keep their kinds. The 16 `view-building` slots map onto
civic kinds (Store becomes market, Analytics becomes library, and so on). A site carries `view: "<tab>"`
when its door opens an HQ tab.

**Coverage rules** (checked by tests on a fully grown tier-5 city):
- every lot within 800 m road distance of a fire station
- a clinic within 600 m of at least 90% of lots
- every tier-2+ lot within 250 m of a bus stop

## Server API (backend, axum; dashboard proxies under `/api/arena/...`)

```text
GET  /v1/world/:id                     (exists) now also @2 ids
GET  /v1/city/:owner                   -> CityState (below); 404 if hidden from the caller
POST /v1/city/:owner/build   {upgrade}         owner only; debits the treasury
POST /v1/city/:owner/transfer {amount, dir:"in"|"out"}  owner only; 10% fee each way
POST /v1/city/:owner/privacy {mode:"arena"|"friends"|"closed"}
POST /v1/city/:owner/fare    {kind:"bus"|"tram"|"fast"}  rider pays: 2 bus/tram, 1 fast travel
GET  /v1/market/:owner                 -> {good, price, stock}[]
POST /v1/market/:owner/trade {good, qty, side:"buy"|"sell"}  any visitor
GET  /v1/archipelago                   -> {commons:{world,x,z}, islands:[{owner,name,world,x,z,tier}]}
                                          only islands visible to the caller
```

```text
CityState = { owner, name, world: "user:<uuid>@2", tier: 1..5, xp, tier_xp: [t1..t5],
              grow: 0..1000 (per-mille through the current tier), treasury, tax_pm,
              specialty, upgrades: {key: level}, privacy, population }
```

- **Tables (migration `0013_cities.sql`):**
  - `city` (owner pk, seed, treasury, tax_pm, specialty, privacy, created, last_accrual)
  - `city_upgrade`
  - `city_ledger` (append-only: id, owner, at, kind, amount, balance_after, ref)
  - `city_tiers`
  - `market_price` (owner, good, price, stock, updated)
  - `island_slot` (owner, slot index, x, z; join order, never moves)
- **Accrual:** lazy on read, plus an hourly job. Tax per hour = population × tax_pm × district multiplier / 1000,
  capped at 24 h of offline income. 2% of every accrual goes to the Commons treasury (owner `commons`).
- **Market tick:** hourly. price += clamp(k × (demand − supply), ±5%), kept within [0.5, 2.0] × base.
  Supply chains: a good's production needs its inputs in stock, else it runs at 25%.
- **Island slots:** golden-angle spiral, ~3 km apart, Commons at the origin, given out in join order.

## Task ownership (disjoint files; branch `cities/<key>` per task)

| Key | Owns | Consumes |
| --- | --- | --- |
| gen-organic | `backend/src/worldgen/organic/*` (new), `mod.rs` version + profile dispatch, `profile.rs` commons + island profiles (data only), `bin/worldgen.rs` | this contract |
| gen-civic | `backend/src/worldgen/civic.rs`, `zones.rs`, `transit.rs` (new) | gen-organic's branch |
| gen-island | `backend/src/worldgen/island.rs` (new): coast, docks, growth ranks, `min_tier` | gen-civic's branch |
| srv-economy | `backend/src/cities.rs`, `market.rs`, migration 0013, route registration in `main.rs` | contract only |
| srv-archipelago | `backend/src/archipelago.rs`, `world.rs` LIVE ids, privacy and visibility checks, server-side Commons HQ lot assignment | contract only |
| dash | `dashboard-rs/src/arena.rs` + `server.rs` proxies, `ui/app/` town hall panel (new file) + css | contract only |
| cl-mesh | `games/worldgeom.js`, `games/worldbuild*.js`: polygon blocks/lots (earcut), coast and water, `min_tier` filtering | contract (synthetic fixtures) |
| cl-civic | `games/hqcivic.js` (new): kit-of-parts civic and zone building models, under 40 draw calls each | contract |
| cl-npc | `games/npcsim.js` (pure), `games/npcdraw.js` (LOD: skinned under 40 m, instanced to 150 m) | contract |
| cl-traffic | `games/traffic.js`: cars, buses, trams on the road graph; pure timetable | contract |
| cl-water | `games/hqboat.js` (boat + jet ski physics and models), `games/ocean.js` (sea, island impostors) | contract |
| cl-travel | `games/hqtravel.js` (new): ferry, rail, plane and fast-travel trips that load the destination doc during the ride; per-island net room id `city3d:<world id>` | contract |
| integrate | `games/hqcity3d.js`, `games/hq3d.js`, `games/world.js`, `ui/app/22-hq.js` load order, `games/multi.js` CLIENT_PROTO, README + version | every branch |

A task that needs a change outside its files asks for it in its final report, and the integrator makes it.
It never edits another task's files.

## Checks per task

- **Rust:** `cargo test` + `cargo clippy --all-targets -- -D warnings` in the crate it touched. The @1
  fingerprint test stays unchanged, and the task's own "done when" tests are added.
- **JS:** a `tests/test_<module>.py` node-driven unittest, following `tests/test_camrig.py` and
  `tests/test_worldgeom.py`, plus the full `python3 -m unittest discover -s tests`.
- Each task's "done when" items from the doc become tests wherever they can be measured headless.
- **System (after integrate):** the full suites, `tools/ui_smoke.py`, and `tools/hq_shots.py` headless shots of
  the Commons @2, a tier-1 and a tier-5 island, a ferry ride, NPC crowds and a bus. Never open visible windows.
