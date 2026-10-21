# 3D City & Camera Modes: build spec (the contract)

Status: approved plan, decisions taken (default camera chase, stylised procedural low-poly buildings,
vehicle FP = seat/bonnet camera, Classic isometric kept, City opens on the map). Revision 2: feasibility and coverage
reviews applied (see the Review log at the end).
Audience: 8 parallel builders working in ONE shared working tree, then one integrator.

**Working tree.** The launchd dashboard serves `~/claude-hq` live, so nobody edits it during the build. The integrator
creates one git worktree before step 0: `git -C ~/claude-hq worktree add ~/claude-hq/.claude/worktrees/3d-city -b feat/3d-city`
(from the current `feat/worldgen-p0` HEAD) and copies this spec there (it is untracked). Call that path `$WT`. All builders
edit only `$WT`. While the build runs, the owner's dashboard is unaffected. The integrator merges `feat/3d-city` back into the
live checkout at step 10 only (section 6).

Rule zero: **you only edit files you own (section 1)**. If you need a change in a file you do not own,
write it under "Requests to <owner>" at the bottom of your final report; the integrator applies it.
Code against the interfaces in section 2 even before the other side exists (stub with the documented shape).

House style (all JS): plain ES5-style `var`, one IIFE per file, `"use strict"`, exported as
`HQV.<name>`; no build step, no npm, no new vendored libs; three.js only via `HQV.engine.lib()`
(or passed in as a parameter); nothing leaves the machine except the existing Arena calls;
`localStorage` access always in try/catch; never `Math.random()` for anything a user sees twice. Pure parts never touch
`THREE`, `document` or `window` at load time so node can load the file with only a `window` stub. Rust: match the file's
existing style, `cargo clippy -D warnings` clean, `cargo test --locked` (no new crates; Cargo.lock must not change).
CSS: tokens only, all themes, every animation gated on `html.hq-calm` **and** `@media (prefers-reduced-motion: reduce)` (AGENTS.md).

Units and frames (everywhere, no exceptions):
- WorldDoc and the wire: integer **cm**, +y up, +z = "north" (generator), lot `facing:"north"` = door on +z side.
- Scene: **metres** (float) = cm / 100. Same axes (x, y up, z). Convert only at the world.js boundary.
- Yaw (avatar, vehicles, camera, wire `r`): radians in scene, **yaw 0 faces +z, facing vector = (sin yaw, cos yaw)**
  on (x, z), increasing yaw turns toward +x. This is today's hq3d convention (`Math.atan2(vx, vz)`).
  `lookYaw` (camrig) is the direction the camera LOOKS (camera -> target). hq3d's ortho `view.yaw` is the direction
  target -> camera, i.e. `view.yaw = lookYaw + PI`. Never mix them.
- **Model-local frame** (avatar, vehicles, peers, every anchor/offset in this spec): +z forward, +y up, **+x = LEFT**
  (a yaw 0 model faces +z, so its right-hand side is -x; hq3d's `seatDriver` puts the right-hand-drive seat at x = -0.38).
  "Right" in this spec always means model-local -x.
- Pitch: radians, positive = nose up. Roll: radians, positive = right side (-x) down.
  three.js mapping: `g.rotation.order = "YXZ"`, `rotation.y = yaw`, `rotation.x = -pitch`, `rotation.z = roll`
  (check the roll sign once in a test: a positive roll lowers model-local -x).
- Map screen orientation: camera up vector = (0, 0, -1), so +x is screen-right and +z is screen-down,
  exactly like `tools/worldgen_view.html`. The compass shows "N" at bearing +z.
- Time: seconds (dt clamped to 0.05 as today). FOV: vertical degrees.

---

## 0. Builders

| id | name | scope |
|---|---|---|
| B1 | WORLDGEN | Rust generator: road classes, junctions, city road resample+carve, sidewalks/lanes/refs, re-pin, fixtures, viewer |
| B2 | SERVER | backend presence v2 + `city3d` floor + dev login; dashboard-rs world proxy; local run script + dev-arena LaunchAgent; smoke + screenshot tools |
| B3 | WORLD | `games/world.js` data path + queries (pure core, IndexedDB cache) |
| B4 | GEOM | `games/worldgeom.js` (pure geometry), `games/worldbuild-worker.js`, `games/worldbuild.js` (THREE meshes, LOD, governor) |
| B5 | CAM | `games/camrig.js` pure camera solver |
| B6 | HUD | `games/hqhud.js` + `ui/hq.css` |
| B7 | CITY | `games/hqcity3d.js`, extraction into `games/hqcityparts.js`, `games/hqcity.js` rewire |
| B8 | HQ3D | `games/hq3d.js`, `ui/app/22-hq.js`, `games/multi.js` |
| I | INTEGRATOR | worktree, interim fixture, merges requests, load order checks, full test run, version/changelog, local bring-up, phase gates |

---

## 1. File ownership

All paths are relative to `$WT`.

| file | owner | new/edit |
|---|---|---|
| `backend/src/worldgen/roads.rs` | B1 | edit |
| `backend/src/worldgen/profile.rs` | B1 | edit |
| `backend/src/worldgen/city.rs` | B1 | edit (only if needed for carve/door heights) |
| `backend/src/worldgen/terrain.rs` | B1 | edit (only if needed for city carve) |
| `backend/src/worldgen/mod.rs` | B1 | edit (doc comments, VERSION stays 1) |
| `backend/src/worldgen/tests.rs` | B1 | edit |
| `backend/src/bin/worldgen.rs` | B1 | edit (`--samples`) |
| `tools/worldgen_view.html` | B1 | edit |
| `tools/world_fixture.py` | B1 | new |
| `tests/fixtures/claude-hq@1.json.gz`, `tests/fixtures/claude-hq@1.samples.json` | B1 | new (generated; an interim `.json.gz` is written by I at step 0, B1 overwrites it) |
| `backend/src/protocol.rs` | B2 | edit (incl. its `table_matches_python` test) |
| `backend/src/valley/hq.rs` | B2 | edit (incl. its existing tests that pin ±6000 and `FLOORS`) |
| `backend/src/main.rs` | B2 | edit (dev login + `mint_pair_code` refactor) |
| `backend/.env.example` | B2 | edit (comment only) |
| `dashboard-rs/src/arena.rs`, `dashboard-rs/src/server.rs`, `dashboard-rs/tests/http.rs` | B2 | edit |
| `tools/local_arena.sh`, `tests/test_local_arena.py` | B2 | new |
| `tools/ui_smoke.py` | B2 | edit |
| `tools/hq_shots.py` | B2 | new |
| `games/world.js`, `tests/test_world.py`, `tests/fixtures/world_tiny.json` | B3 | new |
| `games/worldgeom.js`, `games/worldbuild-worker.js`, `games/worldbuild.js`, `tests/test_worldgeom.py` | B4 | new |
| `games/camrig.js`, `tests/test_camrig.py` | B5 | new |
| `games/hqhud.js`, `tests/test_hqhud.py` | B6 | new |
| `ui/hq.css` | B6 | edit (append a `/* 3D city HUD */` section; do not touch existing rules) |
| `games/hqcity3d.js`, `games/hqcityparts.js`, `tests/test_hqcity3d.py`, `tests/fixtures/hqcity_legacy_golden.json` | B7 | new |
| `games/hqcity.js` | B7 | edit (use hqcityparts; fix the `:238` tree bug; legacy behaviour otherwise identical) |
| `games/hq3d.js`, `ui/app/22-hq.js`, `games/multi.js` | B8 | edit |
| `tests/test_hq3d_integration.py` | B8 | new (source-level checks, see section 4) |
| `dashboard-rs/src/app.rs` (`APP_VERSION` only), `README.md` (Changelog entry only) | I | edit |
| `docs/plans/3d-city-build-spec.md` | architect | this file |

**Nobody touches** (integrator only, and only if a request demands it): `games/engine.js`, `games/hqbase.js`,
`games/hqlobby.js`, `games/hqskate.js`, `games/avatar3d.js`, `games/vendor/*`, `index.html`,
`ui/app/*` other than `22-hq.js`, `backend/src/world.rs`, `backend/migrations/*`, `backend/Cargo.toml`,
`backend/Cargo.lock`, `dashboard-rs/Cargo.*`, `tests/test_protocol.py`, `tests/test_engine.py`,
`.github/workflows/*`, `~/claude-hq/config.json`, `~/claude-hq/arena-link.json`, the dashboard launchd plist.
`dashboard-rs/src/server.rs` `GAME_FILE_RE` already serves every new `games/*.js` name (incl. `worldbuild-worker.js`); do not change it.

Script load order (B8 owns the list in `ui/app/22-hq.js:18`):
`engine, avatar3d, hq3d, hqlobby, hqbase, hqskate, world, worldgeom, worldbuild, camrig, hqhud, hqcityparts, hqcity, hqcity3d`.

---

## 2. Interfaces

### 2.1 WorldDoc after B1 (wire format, cm)

Unchanged top level: `{id, seed, version:1, profile, size_cm:204800, layers:{terrain, districts, roads, blocks, lots, sites}, hashes}`.
Changes inside `layers.roads.edges[]` (all edges, every class):

```
{ id, a, b,
  class: "street" | "avenue" | "highway" | "ring",     // "country" no longer emitted
  width: cm,          // full road width incl. sidewalks: street 800, avenue 1200, highway 1000, ring 900
  walk: cm,           // sidewalk width EACH side, taken out of width: street 150, avenue 200, highway 0, ring 0
  lanes: int,         // lanes PER DIRECTION: 1 for every class (lane widths: street 2.5 m, avenue 4 m, highway 4 m
                      //   inside the 1 m shoulders, ring 3.5 m inside the shoulders; a 1.7 m car fits with margin)
  ref: string|null,   // route ref: highway "H1".."H6" (gate order, see 3.1.2), ring "R1", else null
  name, points: [[x,y,z],...]   // city edges resampled into n = ceil(len/800) equal steps (each <= 800 cm)
}
```
Carriageway width = `width - 2*walk`. Highway and ring get a 100 cm shoulder painted inside the carriageway (client only).
Ground under every road (city included) is carved to the road profile at the 8 m terrain vertices. The terrain grid is
NOT the road surface: bilinear `heightCm` across a graded road keeps part of the original ground. The road surface is the
edge polyline (y interpolated along it); `groundAt` uses it on roads (2.2).
Junction nodes appear wherever a ring edge and a highway edge touch (see 3.1). Node ids of the grid and gates do not change.
Lots, sites, blocks, districts keep their shapes (values of door y may move by the carve).

### 2.2 `games/world.js` (B3), `HQV.world`

Root: `var root = typeof window !== "undefined" ? window : self; var HQV = root.HQV = root.HQV || {};`
(must load in a page, a worker via `importScripts`, and node with `global.window = {HQV:{}}`).

Constants: `HQV.world.ID = "claude-hq@1"`, `URL = "/api/arena/world/claude-hq@1"`, `IDB = {db:"hq-world", store:"docs"}`.

**Pack** (pure). The packed doc is what everything else uses; it is structured-clone friendly:
```
pack(doc) -> W = {
  id, etag, hash: doc.hashes.world, sizeCm, half: sizeCm/2/100 (m),
  terrain: {cell: 800, origin: -102400, n: 257, h: Int32Array(n*n)},         // cm, row-major z then x
  districts: {cell: 800, origin: -102400, n: 256, k: Uint8Array(n*n), legend: [..11 names]},
  nodes: [{id, x, y, z}]  (cm),
  edges: [{id, a, b, cls, width, walk, lanes, ref, name, pts: Int32Array(3*m)}]  (cm),
  blocks, lots, sites: arrays as in the doc (cm),
  index: built lazily by query functions (64 m grid buckets of lot ids, edge-segment ids and tree indices)
}
```
Old docs (class "country", no walk/lanes/ref) must still pack: treat "country" as highway with `walk 0, lanes 1, ref null`
(the interim fixture of step 0 is such a doc).

**Queries** (pure, inputs and outputs in **metres** unless noted; W is the packed doc):

| function | returns | rule |
|---|---|---|
| `heightCm(W, xCm, zCm)` | int cm | bit-exact port of `terrain.rs:61-71` (ONE = 65536, clamp to grid, `Math.trunc` for every division, i.e. Rust truncation toward zero) |
| `heightAt(W, x, z)` | m | `heightCm(W, round(x*100), round(z*100)) / 100` (raw terrain; not the road surface) |
| `districtAt(W, x, z)` | `{k, name}` | cell `floor((xCm - origin)/800)`, clamped to 0..n-1 (same in z) |
| `lotAt(W, x, z)` | lot object or null | point in axis-aligned lot rect (`|x-lx|<=w/2 && |z-lz|<=d/2` in cm), grid-indexed |
| `siteAt(W, x, z)` | site or null | same rule over sites |
| `nearestRoad(W, x, z, maxM=40)` | `{edge, seg, t, dist, x, y, z, yaw, cls, name, half, carriage}` or null | nearest point on any edge polyline (y linearly interpolated along the segment); `half = width/200`, `carriage = (width-2*walk)/200` |
| `roadY(W, x, z)` | m or null | road surface where `surfaceAt` is road/sidewalk: `nearestRoad().y` (+0.15 on a sidewalk); null elsewhere. The ONE function ribbons, terrain clamping and `groundAt` share |
| `surfaceAt(W, x, z)` | `"road"`,`"sidewalk"`,`"lot"`,`"site"`,`"park"`,`"forest"`,`"grass"`,`"water"`(never yet),`"edge"` | road if dist <= carriage/2, sidewalk if <= half, then site, then lot, then district (park/forest), `"edge"` beyond `half` of the world |
| `padOf(W, x, z)` | `{y, rect}` or null | HQ lots: y = `door[1]/100`; sites: `y/100`; rect in m |
| `groundAt(W, x, z)` | m | 1. `roadY` when not null (roads win over pads; the pad blend is never applied over a road or sidewalk); 2. inside a pad rect: pad y; 3. within 4 m outside it: `lerp(pad, heightAt, smoothstep(d/4))`; 4. else `heightAt` |
| `normalAt(W, x, z)` | `{x,y,z}` | central difference of `groundAt` over 0.5 m |
| `slopeAlong(W, x, z, yaw, len=1.5)` | grade (dy/ds) | `(groundAt(front) - groundAt(back)) / (2*len)` along facing |
| `slopeFactor(grade, kind)` | speed multiplier | kind "foot": `clamp(1 - max(0,grade)*1.6 + max(0,-grade)*0.3, 0.45, 1.15)`; "bike": `clamp(1 - max(0,grade)*2.5 + max(0,-grade)*0.8, 0.35, 1.3)`; "skate": as bike; "car"/"moto": `clamp(1 - max(0,grade)*0.8, 0.7, 1.1)` |
| `buildingRect(lot)` | `{x0,x1,z0,z1}` m | building lots: lot rect inset by 1.0 m each side (the footprint B4 builds) |
| `blockedAt(W, x, z)` | bool | outside `±(half - 2)`; inside any `kind:"building"` lot's `buildingRect`; inside a tree trunk from `trees(W)` (radius 0.45). Lots AND trees are looked up through the 64 m bucket index (never a linear scan). HQ lots and sites are NOT blocked here (the City world adds its own placed items) |
| `trees(W)` | `[{x, z, s, kind}]` m, cached | deterministic: per 8 m cell in forest districts p=0.55, park p=0.18, residential p=0.04, never within `half+2` of a road nor inside lot/site rects; position jitter and `s` from `hash32(W.hash + ":" + ix + ":" + iz)` (FNV-1a 32, documented in the file); bucketed into the index on first call |
| `rayGround(W, from, to, step=2)` | t in [0,1] (1 = clear) | march `groundAt`; first sample where `y < ground + 0.25` |
| `roadLabels(W)` | `[{name, cls, ref, pts:[[x,z],..] m, len}]` | merges consecutive edges with same name into polylines (the map labels); highway/ring entries carry `ref` |
| `junctions(W)` | `[{node, x, y, z, deg, edges:[ids], names:[..]}]` | degree >= 3 nodes |
| `hash32(str)` | uint32 | FNV-1a 32 |

**Load** (browser only, not unit-tested under node except via injected fetch/IDB stubs):
```
load({fetch?, idb?, timeoutMs=6000}) -> Promise<W>
```
1. Read `{etag, packed}` from IndexedDB `hq-world/docs` key `claude-hq@1`. If found: resolve immediately with it
   (gate: < 100 ms from call to resolve, measured with `performance.now()` and logged as `hq-world cache <ms>`).
2. In the background (or in the foreground when nothing is cached): `fetch(URL, {cache: "no-cache", headers: etag ? {"If-None-Match": etag} : {}})`.
   - 304: keep the cached copy; log `hq-world 304` (no `pack` call; a test asserts `pack` is not called on this path).
   - 200: `pack(json)`, store `{etag: response ETag, packed}`; if a copy had already been returned and `hash` differs,
     call every `onChange(W)` listener.
   - Anything else / network error: if cached, keep it; else reject with `Error("world unavailable: <code>")`.
3. `onChange(cb)` registers a listener; `current()` returns the last W or null.
IDB failures (private mode) fall back to network only. Never store in localStorage (too big).

### 2.3 `games/worldgeom.js` (B4, pure) and the worker

`HQV.worldgeom` (same root trick as world.js; uses `HQV.world` queries; no THREE).

Tiling: the world (2048 m) is 32 x 32 **chunks** of 64 m; chunks are grouped into 8 x 8 **tiles** of 256 m (4 x 4 chunks).
`tileOf(x, z) -> {tx, tz}`, `tileKey(tx,tz) = tx+","+tz`, tx,tz in 0..7, tile origin `x = -1024 + tx*256`.

All builders return plain objects of typed arrays (metres, Float32Array positions/normals, Uint8Array or Float32Array colours,
Uint32Array indices):
```
Geo = {pos: Float32Array, nrm: Float32Array, col: Float32Array (rgb 0..1), uv?: Float32Array, idx: Uint32Array, bid?: Float32Array}
terrainTile(W, tx, tz, lods: [lod per chunk, 16 entries, 0|1|2]) -> Geo
   // lod 0: 8 m grid (9x9 verts/chunk), 1: 16 m, 2: 32 m; every chunk gets a 2 m skirt (one quad per edge step) to hide LOD cracks;
   // vertex y = heightAt-based ground: groundAt, then if any road lies within (lod cell/2 + its half) of the vertex,
   //   y = min(y, roadY at the nearest road point - 0.05) at EVERY lod (ribbons are never covered);
   // colour = district tint (table in file) darkened by slope; road cells not special
roadTile(W, tx, tz) -> {asphalt: Geo, marks: Geo, kerb: Geo, walk: Geo}
   // ribbons from edge polylines clipped to the tile; y = roadY + 0.04 (marks + 0.06), i.e. the same function groundAt uses;
   // markings by class (lanes = 1 per direction): street single dashed centre (3 m dash / 6 m gap); avenue double solid centre;
   //   highway double solid centre + solid edge lines + shoulders; ring dashed centre + solid edges;
   // kerbs: 0.15 m high strip at carriage edge where walk > 0; sidewalk ribbon raised 0.15 m;
   // crossings: zebra stripes on each street/avenue arm of junctions with deg >= 3, 2 m back from the junction patch;
   // junction patches: polygon from incident edge widths, emitted once by the tile containing the node
buildingTile(W, tx, tz, detail: 0|1) -> {body: Geo (with bid), win: Geo (with bid)}
   // one low-poly building per kind:"building" lot whose centre is in the tile; footprint buildingRect(lot);
   // floors from lot.floors, floor height 3.5 m; base = min groundAt of the 4 corners - 1 m, ground floor at max corner y;
   // style per district: residential pitched roofs + warm palette, commercial flat roofs + glass bands, industrial
   //   saw-tooth roofs + grey, civic columns; colour jitter from hash32(W.hash+":lot:"+id);
   // detail 0 = full (window quads in `win`); detail 1 = far LOD: body only (one box + flat roof, no extra vertex rings),
   //   `win` empty; floor/window bands are drawn by the building SHADER from fract(worldY/3.5) (worldbuild, 2.4),
   //   not baked into vertices. There is no billboard impostor (decision, section 7).
   // bid attribute = lot id (float) for see-through fading
props(W, tx, tz) -> {trees: [{x,y,z,s,kind}], lamps: [{x,y,z,yaw}], parked: [{x,y,z,yaw,color}], signs: [{x,y,z,yaw,name,ref}], gantries: [{x,y,z,yaw,ref,text}]}
   // lamps: every 30 m along street/avenue sidewalks, both sides, alternating; plus junction corners
   // parked: residential/commercial street sides, p=0.25 per 7 m slot, never within 12 m of a junction or at HQ lots
   // signs: one per junction arm (street-name plate), name = the arm's edge name, 4 m back from the node on the right-hand kerb
   // gantries: highway/ring only; one every 400 m of arc length along each graded route (measured from its gate / from
   //   the ring's first node), plus one 60 m before every junction on each graded approach; text = "<ref> <dest>" where
   //   dest = "City" when driving toward the city centre, else "Gate <k>" (gates are numbered as in 3.1.2; gates have no names);
   //   on the ring dest = the ref of the next highway it crosses ("R1 → H3")
nameAtlasLayout(names: [string]) -> {cols, rows, cell:{w:256,h:48}, index:{name: i}}   // pure; the canvas drawing is in worldbuild
```
Budgets (checked by tests on the real fixture): terrain at lod 0 everywhere <= 200k triangles total (grid 131,072 + skirts
65,536); one tile's roads <= 12k triangles; buildings detail 0 for the whole world <= 600k triangles, detail 1 <= 30k.

Worker `games/worldbuild-worker.js` (classic worker): `importScripts("/games/world.js", "/games/worldgeom.js")`.
Messages:
```
-> {op:"init", W}                                   <- {op:"ready", hash}
-> {op:"tile", id, tx, tz, lods, want:["terrain","roads","buildings0","buildings1","props"]}
<- {op:"tile", id, tx, tz, terrain?:Geo, roads?:{...}, buildings0?:{...}, buildings1?:{...}, props?:{...}}   // typed arrays transferred
<- {op:"error", id, message}
```
If `new Worker` throws or the worker errors at init, worldbuild calls the same worldgeom functions on the main thread in
idle slices: `(root.requestIdleCallback || function(f){ return setTimeout(function(){ f({timeRemaining: function(){ return 8; }}); }, 1); })`
(Safari has no `requestIdleCallback`). Node tests exercise the same functions directly.

### 2.4 `games/worldbuild.js` (B4), `HQV.worldbuild`

```
create(c, W, opts) -> wb          // c = the hq3d ctx (c.THREE, c.mat, c.canvasTex ...); opts = {scene, quality: 0|1|2}
wb.root            // THREE.Group added by the caller
wb.ready           // Promise: resolves when every tile has terrain lod2 + roads + buildings1 (the whole map is drawable)
wb.update(cam)     // cam = {x,y,z, fov, mode, frustum: THREE.Frustum}; picks per-chunk LOD
                   //   (lod0 < 160 m, lod1 < 480 m, lod2 beyond; map mode: lod2 everywhere),
                   //   requests missing tiles from the worker, swaps building detail (0 < 350 m, else 1),
                   //   frustum-culls tiles, shows signs/props/gantries only within 300 m (map: hidden)
wb.setNight(bool)  // window emissive + lamp glows + shader window bands lit
wb.setFaded(ids)   // up to 8 lot ids rendered with a dithered screen-door discard (uniform array in the building shader via onBeforeCompile)
wb.terrainMeshes() // array of current terrain meshes (click-to-walk picking)
wb.setQuality(q)   // 0 low, 1 medium, 2 high: pixel ratio is hq3d's job; here: LOD distances x(0.6,0.8,1), props density, shadow casters
wb.stats()         // {drawCalls, triangles, tiles, pending, worker: bool (false = main-thread fallback)}
wb.destroy()
```
Materials: asphalt, marks and kerb/walk use `polygonOffset: true` with factor/units -1/-1, -2/-2, -3/-3 (on top of the
geometric +0.04/+0.06 lift). The building body material gets an `onBeforeCompile` patch that (a) does the faded-id dither
and (b) darkens horizontal bands from `fract(vWorldY/3.5)` (window rows; lit at night) on walls whose normal is horizontal.
Signs and gantries: plates drawn once into a name-atlas canvas (`nameAtlasLayout`, `c.canvasTex`), one InstancedMesh for
all sign plates, one for gantry frames and one for gantry plates for the whole world (3 draw calls), uv offsets per instance.
Draw-call budget: per visible tile <= 8 within 300 m (terrain, asphalt, marks, kerb+walk, buildings body, buildings win,
instanced trees, lamps); beyond 300 m <= 5 (terrain, asphalt with marks merged into it, kerb+walk, body, and `win` only at
detail 0); world-wide InstancedMeshes: parked cars, sign plates, gantry frames, gantry plates. Worst case
(all 64 tiles visible, ~9 near): 9 x 8 + 55 x 5 + 4 = ~350. Target < 400 total, < ~1.5M visible triangles.
Shadows: only meshes within 120 m of the camera cast (HQ buildings, props); terrain receives. Fog hides the world edge.

**Quality governor** (pure, node-tested), `HQV.worldbuild.governor`:
```
gov = governor.create({target: 16.7})
q = governor.step(gov, frameMs)   // returns {level: 0|1|2, pixelRatio, shadows: bool, lodScale}
```
Rolling mean over the last 90 frames; if mean > 19 ms for 2 s step down one level; if mean < 13 ms for 6 s step up
one level (never above the start level); start at 2 (pixelRatio min(dpr,1.5)), level 1 = pixelRatio 1, level 0 = 0.75 + no shadows.

### 2.5 `games/camrig.js` (B5), `HQV.camrig` (pure)

Modes (data, exported as `HQV.camrig.MODES`; all distances metres, angles degrees in the table, radians in code; `side`
is in the model-local frame, so a positive "right" offset is model-local -x):

| mode | back | up | fov | side | lag (spring omega) | collide radius | near | notes |
|---|---|---|---|---|---|---|---|---|
| `map` | n/a | altitude = span / (2 tan 5deg): 252..11704 | 10 | 0 | 6 | 0 | alt*0.5 | straight down, up vector (0,0,-1); **span 44..2048 m** (span is the primary value, altitude derived); drag pan, wheel zoom (exp), click handled by host |
| `far` | 14 | 6 | 60 | 0 | 5 | 0.4 | 0.3 | chase family |
| `chase` | 6 | 2.2 | 65 | 0 | 6 | 0.35 | 0.3 | default |
| `near` | 2.8 | 1.8 | 70 | 0.6 right (model-local x = -0.6) | 8 | 0.3 | 0.3 | chase family |
| `fp` | 0 | eye 1.65 | 75 | 0 | 30 | 0.15 | 0.15 | pointer-lock mouse look, head bob (not under reduced motion) |
| `classic` | n/a | n/a | ortho | n/a | n/a | n/a | n/a | the host's existing orthographic camera (camrig only reports the mode) |
| `photo` | n/a | n/a | 60 | n/a | 10 | 0.3 | 0.15 | detached free camera |
| `cine` | n/a | n/a | 50 | n/a | 1.5 | 0.4 | 0.3 | idle orbits / fly-bys |

Far planes: 3000 for perspective modes, `alt*2` in map. The chase family = far, chase, near: they share look-ahead,
turn lag and the 2 s recentre (tested in all three).

`ORDER = ["far","chase","near","fp","classic"]` (V / Shift+V cycle; map, photo, cine are entered by M, P and idle).
Cycling (or `setMode` by the user) into any of far/chase/near/fp/classic sets `s.preferred` to that mode; the host
persists it in `hq_cam` (2.6) and passes it back to `create`.

Vehicle tuning `HQV.camrig.VEHICLE` (multipliers / overrides applied to chase-family modes and fp anchors; anchors in the
model-local frame, +z forward, +x LEFT, metres):
```
car:   {backMul 1.35, upMul 0.85, sideMul 1,   fovSpeedKick 1,   fpAnchor: {seat: [-0.38, 1.15, 0.1], bonnet: [0, 1.05, 1.6]}, roll 0}
moto:  {backMul 1.0,  upMul 0.75, sideMul 1,   fovSpeedKick 1,   fpAnchor: {seat: [0, 1.35, -0.1]}, roll 1.0 (lean follows vehicle lean)}
bike:  {backMul 0.9,  upMul 0.85, sideMul 1,   fovSpeedKick 1,   fpAnchor: {seat: [0, 1.55, -0.2]}, roll 0.6}
skate: {backMul 1.1,  upMul 0.55, sideMul 1.4, fovSpeedKick 1.6, fpAnchor: {seat: [0, 1.5, 0]}, roll 0.3}
```
(car seat x = -0.38 = the right-hand-drive seat of `seatDriver`.) Car FP: `fpView: "seat" | "bonnet"` in state; V while in
fp on a car goes seat -> bonnet -> next mode in ORDER; on any other vehicle (or on foot) V in fp goes straight to the next mode.

API:
```
s = create({mode:"map", preferred?, settings})  // settings: {fov: 60..100, sens: 0.2..3, invertY: bool, reduced: bool, headBob: bool}
                                             //   fov is an OFFSET: every perspective 3D mode uses table fov + (settings.fov - 65)
                                             //   (fp capped at 100); map/photo/cine are not offset
setSettings(s, settings)                     // runtime change (HUD panel, Calm toggle); takes effect within one blend (<= 0.5 s)
setMode(s, mode, {instant?, via?})          // starts a 0.5 s blend (reduced: 0.3 s, linear-ish); map<->3D uses dive/rise instead
cycle(s, dir)                               // dir +1 / -1 over ORDER (fp on a car: see fpView above); sets s.preferred
dive(s, target)                             // map -> 3D: 1.2 s (reduced 0.6 s) to near-chase framing behind target,
                                            //   lens 10 deg -> 70 deg with constant framing of the target (dolly-zoom style:
                                            //   distance = frameH / (2 tan(fov/2)), frameH eases from map span to 3 m),
                                            //   smootherstep easing, direction slerps from straight-down to behind-target;
                                            //   then automatically settle (0.5 s blend) into s.preferred (default "chase")
rise(s)                                     // 3D -> map: the reverse, 1.2 s, ends in map centred on the target, fov 10, up (0,0,-1)
flyMap(s, x, z, span?)                      // map mode: animate centre to (x,z) and span to span (default span*0.5, clamped 44..2048) over 0.8 s
input(s, ev)                                // ev: {orbit:[dx,dy] px (right-drag), look:[dx,dy] px (pointer lock / photo),
                                            //      zoom: wheel deltaY, swing: -1|0|1 (Q held / R held), lift: -1|0|1 (Z / C held),
                                            //      fly: {x,y,z} (-1..1, photo), fast: bool (Shift, photo), pan:[dx,dy] px (map drag), anyInput: bool}
pose = step(s, tgt, dt, q)                  // advance springs; returns the pose to render
   tgt = {x,y,z, yaw, pitch, roll, speed (m/s), vehicle: null|"car"|"moto"|"bike"|"skate", lean, moving: bool}
   q   = {ground(x,z)->y, hit(from,to)->t in [0,1], viewH (px), aspect}
   pose = {mode, pos:{x,y,z}, look:{x,y,z}, up:{x,y,z}, fov (deg), near, far, roll (rad), ortho: bool,
           blend: 0..1 (transition progress, 1 = settled), hideAvatar: bool (fp at blend>0.6), hud: bool (false in photo/cine),
           headBob: number (m, already applied), vignette: 0..1}
occluders(pos, look, items) -> [ids]        // items [{id, min:{x,y,z}, max:{x,y,z}}]; returns ids whose AABB intersects the
                                            //   segment pos->look shrunk by 0.5 m at the look end (the player is never "occluded")
fpAnchorWorld(tgt, anchor) -> {x,y,z}       // pure: model-local anchor rotated by yaw, pitch, roll (YXZ, pitch sign as in Units) + tgt
spring(x, v, goal, omega, dt) -> [x, v]     // critically damped, exact closed form (frame-rate independent)
smootherstep(t)
```
Map mode: wheel zoom multiplies span by `exp(deltaY*0.0015)`, clamped 44..2048; drag pan moves the centre by
`(dx, dy) * span / viewH` (screen +x = world +x, screen +y = world +z), centre clamped to `±(half - span/2)` (and to 0 when
span = 2048).
Chase-family behaviour (all in `step`):
- Desired look yaw = target yaw + user orbit offset; orbit offset decays to 0 after 2 s without orbit/swing input
  (recentre, spring omega 2). Q/R swing at 1.6 rad/s. Right-drag: `sens * 0.006 rad/px`, pitch clamp -0.2..1.2 rad.
  `s.lookYaw` is kept current in every 3D mode (chase family: the camera's look yaw; fp/photo: the pointer yaw).
- Look-ahead: look point = target + facing * min(4, speed*0.35) + yaw-rate lead (turn lag comes from the yaw spring).
- Speed FOV kick: +min(10, speed*0.5) deg x `VEHICLE.fovSpeedKick` (1 on foot), 0 under reduced motion.
- Horizon levelling: camera up stays world-up; camera height follows `max(target.y, ground under camera)` so slopes
  do not tilt the horizon. Roll: `pose.roll = VEHICLE.roll * tgt.lean * 0.5`, 0 under reduced motion and on foot.
- Z/C lift: changes the mode's `up` by +-2 m/s within [0.6, 3x mode up]; wheel scales `back` within [0.5x, 2.5x].
- Collision: `t = q.hit(lookPoint, desiredPos)`; if t < 1 pull in to `t*len - radius`, min 0.6 m from the target head;
  always `pos.y >= q.ground(pos.x,pos.z) + 0.3`. Pull-in is instant, push-out eases (omega 3).
- FP: position = head (avatar) or `fpAnchorWorld(tgt, VEHICLE[v].fpAnchor[fpView])`; look yaw/pitch from pointer
  (`sens*0.0022 rad/px`, invertY), pitch clamp +-1.45; head bob amplitude 0.04 m at 1.8 Hz x speed/4 when headBob and !reduced.
  Vignette: `clamp((speed - 4)/10, 0, 0.6)` in fp only, 0 when stopped and 0 in every other mode.
  Movement direction in FP = look yaw (host reads `s.lookYaw`).
- Photo: detached; fly 8 m/s (x3 with `fast`), Z/C down/up (`fly.y`), mouse look; never below ground + 0.3.
- Cine (`setMode(s,"cine")` by the host after 45 s idle): deterministic shots from `(t, seed)`: 12 s slow orbit
  (radius 18 m, height 8 m, 0.05 rad/s), then 12 s fly-by along the facing line, repeat; `input` with anyInput sets a flag
  and the host calls `setMode(s, s.prev)`; the 0.5 s blend returns to `s.prev`.
- Reduced motion (`settings.reduced`): the host passes `reduced = E.calm() || hudSettings.reduced`. `E.calm()` already
  covers both the system `prefers-reduced-motion` and HQ Calm. Effect: no bob, no kick, no roll, no vignette pulse,
  blends 0.3 s, dive/rise 0.6 s.
Exported for the host: `s.mode, s.prev, s.preferred, s.lookYaw, s.lookPitch, s.fpView, s.mapCentre:{x,z}, s.mapSpan`.

### 2.6 `games/hqhud.js` (B6), `HQV.hqhud`

```
hud = mount(el, {announce})   // creates inside el: div.hqhud (pointer-events:none root), div.hqhud-chip, div.hqhud-cross,
                              //   div.hqhud-prompt, div.hqhud-speed, div.hqhud-compass, canvas.hqhud-labels, div.hqhud-vignette,
                              //   button.hqhud-gear + div.hqhud-settings (pointer-events:auto)
hud.setMode(mode, label)      // chip "Chase camera" etc. for 1.4 s, then cleared; announce(label) once
hud.setLabels(L)              // L = {roads: HQV.world.roadLabels(W), hqs: [{userId, name, x, y, z, you}]}
hud.frame(f)                  // every frame:
   f = {mode, hudOn: bool, yaw (camera look yaw), speed (m/s) | null (not in a vehicle), vehicle,
        prompt: string|null ("E  Enter Maya's HQ", "E  Ride the car"), crosshair: bool (fp),
        vignette: 0..1, mapSpan (m, map mode), project: function(x,y,z) -> {x, y, vis} (CSS px in el),
        peers: [{n, x, y, z}] (friends' live positions, metres)}
hud.settings() -> {fov, sens, invertY, reduced, headBob, quality: "auto"|"low"|"medium"|"high", preferred}
hud.onSettings(cb)            // cb(settings) on every change; also writes localStorage "hq_cam"
hud.openSettings(open?)       // toggles the panel (also the gear button)
hud.labelCounts() -> {roads, shields, hqs, peers}   // what the last map frame drew (smoke hook)
hud.destroy()
HQV.hqhud.layoutLabels(cands, viewW, viewH) -> [kept]   // pure: greedy by priority, drops overlapping boxes; node-tested
HQV.hqhud.labelAngle(ax, ay, bx, by) -> rad              // pure: segment angle normalised into (-PI/2, PI/2] (never upside down)
HQV.hqhud.compassTicks(yaw) -> [{deg, x (-1..1 in the 180 deg window), label: "N"|"E"|"S"|"W"|null}]  // N at bearing +z, 15 deg ticks
HQV.hqhud.kmh(speed) -> int                              // round(speed*3.6)
HQV.hqhud.loadSettings(raw) / saveSettings(s)           // pure parse with defaults+clamps; persisted in localStorage "hq_cam" (try/catch)
```
Defaults: `{fov: 65, sens: 1, invertY: false, reduced: false, headBob: true, quality: "auto", preferred: "chase"}`; fov
clamped 60..100, sens 0.2..3, preferred must be one of camrig ORDER.
Settings panel: `button.hqhud-gear` with `aria-expanded` and `aria-controls`, keyboard reachable (Tab), Enter/Space opens,
Esc closes and returns focus to the gear; inside, labelled controls: FOV range 60..100, sensitivity range 0.2..3,
invert Y checkbox, reduced motion checkbox, head bob checkbox, quality select (auto/low/medium/high). Every change fires
`onSettings` and saves `hq_cam`.
Map labels (map mode only): street names along roads (text follows the polyline, rotated by `labelAngle` so it never reads
upside down), font size by class (street 11 px, avenue 13, ring 14, highway 15 bold) and hidden when the projected road is
shorter than the text; highway/ring route shields (rounded badge with `ref`) every ~300 px of screen length; HQ names on
their lots (yours in amber); friends as dots with names. Priority: shields > HQ names > friends > highway > ring > avenue > street.
Compass ribbon (3D modes): `compassTicks`. Speedometer only when `speed != null` (`kmh`). Everything hidden when `hudOn` is
false (photo, cine). CSS in `ui/hq.css`, theme tokens only, every theme styled; the chip/vignette transitions are
disabled under both `html.hq-calm` and `@media (prefers-reduced-motion: reduce)`.

### 2.7 `games/hqcityparts.js` and `games/hqcity3d.js` (B7)

`hqcityparts.js`, pure move of closures out of `hqcity.js`, behaviour byte-for-byte the same:
```
HQV.hqCityParts = {
  fountain(c, parent, x, y, z) -> {g, step(t), R: 4.4},
  bikePark(c, parent, x, y, z, rot?) -> [{g, x, z, yaw, color}],        // rot default 0 (legacy); city3d passes PI
  skatePark(c, parent, cx, y, cz, opts?) -> {cx, cz, boards: [...]}    // boards pushed with kind:"skate";
                                                                       //   opts.boardsSide default +1 (legacy: boards at local +HW-0.5, yaw -PI/2);
                                                                       //   city3d passes -1 (boards at -HW+0.5, yaw +PI/2, facing the fountain)
  lotExtras(c, g, col, rot, toWorld) -> {items: [{g, x, z, yaw, color, roof?, kind}], glows: [glow meshes], car: {g}|null},
                                                                       //   toWorld(lx,lz)->{x,z}; caller pushes glows into its lampGlows and sets L.car
  lamplit(gr)                                                          // same signature as legacy lamplit(gr)
}
```
`hqcity.js` keeps `HQV.hqWorlds.city` (the legacy City) using these parts; layout unchanged; it keeps the legacy push
order (`bikes = bikePark(...)` first, then skatepark boards, then each lot's `items`), pushes `glows` into `lampGlows`
and sets `L.car` exactly as today (`:162-184`, `:231-232`, `:370`, `:398`, `:409`).

`hqcity3d.js` registers `HQV.hqWorlds.city3d = function(c, w){ ...; return w }`. hq3d builds it under the world NAME
`"city"` (so `"@city"` doors, `cityReturn` and the `makeWorld("city")` routing keep working), and the world object sets
`w.net = "city3d"`: the presence floor it sends and filters peers by (2.8, 2.9). Legacy and 3D clients never share a room.

Pure, node-tested: `HQV.hqCity3d.assign(list, W) -> [{lot, h}]`: keep entries with a string `userId`, sort by `userId`
(plain `<` string compare), take HQ lots sorted by `rank` ascending, give the i-th HQ the i-th lot; if there are more HQs
than lots, keep the first N but if `isYou` is cut, it replaces the last kept entry. Same for every viewer.
`HQV.hqCity3d.placeLot(lot) -> {x, y, z, rot}` (m): `rot = facing==="north" ? 0 : PI`, `s = facing==="north" ? 1 : -1`,
`x = lot.x/100`, `z = lot.z/100 + 2*s`, `y = lot.door[1]/100`. `placeView(site) -> {x,y,z,rot}`:
`z = site.z/100 + s*(site.d/200 - 7)`. Fountain and skatepark at their site centres rot 0 (the skate sim is unrotated;
the skatepark site is exactly 11.5 x 22 m = 2HW x 2HD, at plaza +11 m per profile.rs:107); bike park at its site centre
(plaza -11 m) with rot PI so the bikes face the fountain; skatepark boards on the fountain side (`boardsSide -1`).

The world object (existing contract, see reader map) plus new fields:
```
w.net = "city3d"              // presence floor name (2.8)
w.floor                       // getter -> wb.terrainMeshes() (an ARRAY); hq3d picks with [].concat(cur.floor)
w.bounds = [-1018, 1018, -1018, 1018]
w.blocked(x,z)                // HQV.world.blockedAt || placed items (B.blockedLocal, hqLotExtraBlocked, skate walkBlocked, fountain R+0.35), as hqcity.js:400-412
w.groundY(x,z)                // HQV.world.groundAt; inside the skatepark site: the flat pad y (site.y/100). Ramps never count:
                              //   walkers cannot stand on them (walkBlocked: height > 0.05) and the skater adds st.y itself (2.8)
w.skateBase                   // site.y/100 of the skatepark (hq3d: rider y = skateBase + st.y; peer skater y = skateBase + y/10)
w.camHit(from, to)            // min(HQV.world.rayGround, ray vs AABBs of building lots + placed HQ/view buildings within 60 m); t in [0,1]
w.occluderItems(x,y,z)        // [{id, min, max}] within 40 m: building lots (id = lot id) and placed buildings (id = "hq:"+userId / "view:"+view)
w.setFaded(ids)               // building lots -> wb.setFaded; placed buildings -> their fade {g,on} (existing hqCutaway look)
w.camModes = ["map","far","chase","near","fp","classic","photo","cine"]
w.startMode = "map"
w.whenReady                   // Promise: HQV.world.load() then wb.ready; rejects when the world is unavailable
w.mapPick(x, z) -> {kind:"hq", you: bool, userId, door:{x,z}, name, lot:{x,z}} | {kind:"point", x, z}
w.mapInfo() -> {roads: HQV.world.roadLabels(W), hqs: [{userId, name, x, y, z, you}]}
w.update(t, dt, k, cam)       // existing signature + cam {x,y,z,fov,mode,frustum, avatar:{x,y,z}}; per frame: wb.update(cam),
                              //   fog (300..1600 m; map mode: scene fog off, restored on leaving map), sun shadow camera
                              //   centred on cam.avatar (+-60 m, 2048 map), animates buildings, fountain, traffic
w.setTime(night)              // sky colours, hemi + sun intensity, wb.setNight (only called on day/night flips)
w.spawn / w.spawnFrom         // at your HQ door (or cityReturn's), y from groundY; fallback the "spawn:0" site; camYaw = rot + 0.55
w.span = 18, zoom = 0.8, camY = 2.5, follow = 1, camPitch = 0.72   // Classic mode keeps today's framing (camY is above ground, 2.8)
w.onCity, w.onLook, w.hits, w.doors, w.bikes (getter), w.skatepark  // as hqcity.js
```
Placed per HQ: pad slab (box from y-3 to y+0.05 over the lot, district paving), `hqBuilding` (campus false, no prestige),
your amber ring, sub-label, `lotExtras` (garage/car/moto/bike; glows into the city's lamp glows, `L.car` set), door `@lobby`
for you, `visit:<uid>` for others.
13 `hqViewBuilding`s on `view-building:0..12` in id order (sites 13..15 get a small civic plaza: bench + tree, no door).
Plaza: fountain, bike park, skate park, "Arena City · N HQs" label 6.4 m above the fountain. HQ lots without an HQ
show an empty paved lot with a "Free lot" low sign.
**Fading (one system per mode, never both):** in `classic`, `w.update` runs `HQV.hqCutaway` for placed buildings every 0.15 s
exactly as today (it reads hq3d's ortho `view`). In every rig mode (far/chase/near/fp/photo/cine) hqCutaway does NOT run;
placed buildings and building lots fade only through `w.setFaded(ids)` from the occluder list hq3d passes (2.8).
Leaving classic clears hqCutaway's fades; entering classic clears `setFaded([])`.

### 2.8 `games/hq3d.js` integration (B8)

Routing: `makeWorld("city")` uses `HQV.hqWorlds.city3d` unless `cityImpl() === "old"`, where
`cityImpl()` = `new URLSearchParams(location.search).get("world") === "old"` or localStorage `hq_city_impl === "old"`.
If `w.whenReady` rejects (e.g. production Arena has no world route), log once, announce "The 3D city is not available,
showing the classic City", drop the cached city3d and build the legacy `HQV.hqWorlds.city` under the same name.
`enterWorld` awaits `w.whenReady` with the `.hq3d-loading` overlay (previous world keeps rendering; timeout 15 s -> fallback).
Re-entrancy: `enterWorld` sets `entering = name` before the await; a second call while `entering` is set is ignored (or,
for a different world, replaces the pending target and the first await's continuation checks `entering === name` before
switching). `fading` alone is not a guard (it is false during the await).

Cameras: keep `cam` (OrthographicCamera) for Classic and for worlds without `camModes` (lobby, base, mission are unchanged).
Add `pcam = new THREE.PerspectiveCamera(65, 1, 0.3, 3000)`. `curCam()` returns pcam when `rig.mode !== "classic"` and
`cur.camModes`; used in `pick`, both `renderer.render` calls and resize (`pcam.aspect`). Each frame in a rig world:
`pose = HQV.camrig.step(rig, tgt, dt, q)` with `q = {ground: groundAt, hit: cur.camHit, viewH, aspect}`; apply pos, up,
lookAt, fov, near/far from the pose (chase family 0.3, fp/photo 0.15, map alt*0.5 / alt*2), then `pcam.rotateZ(pose.roll)`
if non-zero; `cur.setFaded(HQV.camrig.occluders(pose.pos, pose.look, cur.occluderItems(...)))` (not in classic);
`avatar.g.visible = !pose.hideAvatar`; `cur.update(t, dt, k, {x,y,z,fov,mode,frustum, avatar:{x,y,z}})` every frame.
`c.view()` keeps returning hq3d's ortho `{yaw: view.yaw, pitch: view.pitch}` (only classic consumes it).
**Classic on terrain:** in every rig world (classic included) `view.goal.y = groundAt(avatar.x, avatar.z) + cur.camY`
(replaces the constant `cur.camY` at `:865`, `:907` (+ st.y*0.7 kept), `:1024`).

Rotations: `avatar.g.rotation.order = "YXZ"` and every peer group `P.g.rotation.order = "YXZ"`; apply `rotation.y = yaw`,
`rotation.x = -pitch`, `rotation.z = roll` (Units section).

Keys (handled only when `cur.camModes` exists; otherwise the page keeps its shortcuts). Same guard as E (`:1117`):
keydown, not typing, no Ctrl/Meta/Alt, running; always `preventDefault()` (page binds R, C, M, V). Held keys go in `keys`.

| key | action |
|---|---|
| V / Shift+V | `camrig.cycle(+1/-1)`; `hud.setMode`; persist `preferred` via the HUD settings (`hq_cam`) |
| M | map <-> 3D: `rise` / `dive` (dive target = avatar) |
| P | photo mode toggle (hud hidden); Enter in photo = screenshot (render, `canvas.toBlob`, download `claude-hq-YYYYMMDD-HHMMSS.png`, local time, via the pure helper `shotName(date)`) |
| Q / R (held) | swing camera left/right (chase family) |
| Z / C (held) | camera down/up (chase family height; photo: fly down/up) |
| W A S D / arrows | move. Chase family and classic-in-rig: camera-relative; W = (sin lookYaw, cos lookYaw) where lookYaw = `rig.lookYaw` (rig modes) or `view.yaw + PI` (classic; today's `:990` formula uses `view.yaw`, which points target -> camera, so its sign is kept as is for classic). FP: look-relative. Photo: fly (Shift = fast). Map: pan |
| E | unchanged ride toggle; additionally in fp: enter the door returned by `doorUnderCrosshair(pose, cur.doors, 3)` (`through(d)`) |
| Esc | browser releases pointer lock |
| mouse | **Required change:** today `onDown`/`onMove` (`:1046-1053`) orbit on a drag with any button and `:1070` picks with `[cur.floor]`. In rig worlds: map: left-drag pan, wheel zoom, click = `cur.mapPick` -> your HQ: teleport avatar to its door front, `dive`; another HQ: `flyMap` to its lot centre at span 44 and announce its name (no teleport); point: `flyMap(x, z)`. Chase family: right-drag orbit only (`e.button === 2`, `contextmenu` prevented only in chase-family modes), wheel distance, left click/left drag = today's pick/click-to-walk. Classic: today's behaviour (any-button orbit kept). Every pick uses `[].concat(cur.floor)`. FP/photo: click requests pointer lock; `movementX/Y` -> `input({look})`; picking disabled while locked |
| gamepad | polled only while a `gamepadconnected` has been seen and no `gamepaddisconnected` since: `navigator.getGamepads()` -> pure `padToInput(axes, buttons)` (dead zone 0.15; left stick move, right stick orbit/look, LB(4)/RB(5) cycle -1/+1 on press edge, Y(3) map, A(0) hop, X(2) = E) |

Pointer lock is released (`document.exitPointerLock()`) in `pause`, `destroy`, `enterWorld`, and when leaving fp/photo.
Pure helper `doorUnderCrosshair(pose, doors, maxM)`: nearest door whose 1.2 m-radius disc the pose ray hits within maxM.
Idle: no input for 45 s in a rig world, not in map or photo -> `setMode(rig,"cine")`; the timer is not armed in map/photo;
any key/mouse/pad input -> `setMode(rig, rig.prev)`.
HUD wiring: `hud.onSettings(function(s){ HQV.camrig.setSettings(rig, merge(s, {reduced: E.calm() || s.reduced})); quality... })`;
also re-call `setSettings` when `E.calm()` changes (checked once per second).

Ground following (rig worlds only; `groundAt(x,z) = cur.groundY ? cur.groundY(x,z) : 0`):
- Avatar: feet y = groundAt; hop and landing relative to groundAt (`:1011`, `:1017`, `:1021`); speed x `HQV.world.slopeFactor(slopeAlong, "foot")`.
- Rides (`:806`, `:819`, `:830`, `:863`): y = groundAt at the vehicle centre; pitch = `atan(slopeAlong over the wheelbase)`,
  roll = `atan` of the cross slope over 1.2 m (car) / 0 plus lean (moto, bike); both springs (omega 10); speed factor by kind.
  Skate (inside the park): rider y = `cur.skateBase + st.y` (`st.y` already contains `hqSkatePark.height`; do NOT add groundAt).
- Peers: y = received `h` when present, else groundAt at their x,z; pitch from `p`. Skater peers: y = `cur.skateBase + y/10`.
- `inst.where()` returns `{world: cur.net || cur.name, x, z, yaw, h: feet y (m), pitch: rad}`; peers are filtered by
  `P.w === (cur.net || cur.name)`.

Presence (22-hq.js `hqNetSend`): when `w.world === "city3d"` and `!hqNetCan("alt")`, send nothing (a v1 server rejects the
floor; the 3D city against a v1 Arena is offline-only). Else if `hqNetCan("alt") && w.h != null` add `h = round(h*100)` (cm),
`p = round(clamp(pitch deg, -90, 90))`; include both in the dedupe key. Receive (`setPeers`): `P.th = typeof p.h==="number" ? p.h/100 : null`,
`P.tp = typeof p.p==="number" ? p.p*PI/180 : 0`; `placePeers` eases y and pitch with the same `k`, snaps when the 3D gap > 6 m,
skater y as above (today's line is `hq3d.js:1243`). `games/multi.js:17` -> `hq:[1,2]` (B8; B2 changes the server side).

Quality: `gov = HQV.worldbuild.governor.create()`, step each frame with the frame time; apply pixel ratio, shadow map on/off
and `wb.setQuality`. Settings "quality" other than auto pins the level. Log `console.info("hq-frame", JSON.stringify({ms, dc, tri, q}))`
every 5 s when `?hqperf=1`.

Smoke/screenshot hooks (used by B2's tools; inert otherwise): URL params `?hqsmoke=1` opens the HQ view straight into the City
with a synthetic open list (3 HQs incl. you) and one synthetic friend peer 20 m from you; `&cam=<mode>` sets the camera mode
once ready (`fp-bonnet` = fp + fpView bonnet); `&at=x,z` teleports; `&night=1`; `&ride=car|moto|bike|skate` mounts that
vehicle at the spot; `&span=<m>` sets the map span; `&calm=1` forces reduced motion.
When the City has rendered 30 frames: `document.documentElement.dataset.hqSmoke = "ok " + JSON.stringify(Object.assign(wb.stats(), {labels: hud.labelCounts(), mode, cache: <ms of hq-world cache or null>, vehicle: {pitch, roll} | null}))`;
on any caught error: `"error " + message`. `window.HQ3D_DEBUG = {mode(m), teleport(x,z), ride(kind), stats()}` exists only with
`hqsmoke`; `stats()` = the same object.

### 2.9 Backend wire (B2)

Protocol (`backend/src/protocol.rs:33`): `("hq", 2, &["ride","look","skate","drive","alt"])`. Comment:
`"alt": pos may carry h (feet height, cm) and p (pitch, deg); x/z span +-102_400 cm; floor "city3d"`.
B2 updates `table_matches_python` (`:78`) to `{"v":2,"caps":["ride","look","skate","drive","alt"]}`.

`backend/src/valley/hq.rs`:
- `FLOORS` gains `"city3d"` (`["base","lobby","mission","city","city3d"]`); the pinning test at `:396` updated.
- `const XZ_MAX_CM: f64 = 102_400.0;` x,z `num_in(-XZ_MAX_CM, XZ_MAX_CM)` (version independent; fixes today's 60 m drop).
  The existing tests at `:506` (-6000.5 dropped) and `:530-532` (listing pinned at ±6000) are rewritten to the new bound.
- `Person.alt: Option<(i64, i64)>`, `None` on enter. In `pos`: if both `h` and `p` absent -> `None`; otherwise
  `h` in `num_in(-50_000, 50_000)`, `p` in `num_in(-90, 90)` (a missing one of the pair counts as 0); any bad value drops the frame.
  Stored with `py_trunc`. Per frame (absent clears). Applies to every `a`.
- Listing: after `k,y`, `if let Some((h,p)) = alt { "h", "p" }`. v1 listings byte-identical.
- Tests: absent -> no keys; both echoed; `h:50_001`, `p:91`, `p:true`, `h:"1"` drop; skater carries `y` and `h` together;
  x = 102_400 accepted, 102_400.5 rejected, 1e9 rejected; `w:"city3d"` accepted; listing order pinned.

Dev login (`backend/src/main.rs`): `mint_pair_code` refactor used by `github_callback`;
`dev_github_id(handle) = -(1 + (fnv1a32(handle) % 2_147_483_647) as i64)` (negative, so it never collides with a real
GitHub id; distinct handles give distinct users under `ix_users_github_id`);
`dev_login_allowed(flag, bind)` true only for `Some("1")` and a loopback bind (`127.0.0.1`, `localhost`, `::1`);
`POST /v1/auth/dev-login` with an OPTIONAL JSON body `{"handle": "<[a-z0-9-]{1,32}>"}`: the handler takes the raw `Bytes`
(not axum's `Json` extractor, which answers 415 to a body-less POST), parses when non-empty, else uses `ARENA_DEV_HANDLE`
default `"dev"`; bad handle -> 400. Returns `{code, handle, expiresInSecs}`; route mounted only when allowed (otherwise axum
404); `tracing::warn!` at startup when on.
Tests in `#[cfg(test)] mod dev_login_tests`: the allow matrix, `dev_user` idempotent per handle (one row), two handles ->
two rows with distinct negative github ids, empty body and `{"handle":"b"}` both accepted, `mint_pair_code` row unused and
matching `^HQ-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$`. `.env.example`: commented
`# ARENA_DEV_LOGIN=1  # local runs only, needs ARENA_BIND_HOST=127.0.0.1`. Not in Dockerfile/compose.

Dashboard proxy (`dashboard-rs`): `GET /api/arena/world/:id` as in the infra reader's code: `WORLD_ID_RE`
`^[A-Za-z0-9_:-]{1,64}@[0-9]{1,9}$`, raw GET to `<link url | config arenaUrl>/v1/world/<id>`, no device token,
forwards `If-None-Match`, passes status (incl. 304, 404 body), `Content-Type`, `ETag`, `Cache-Control: no-cache`;
unconfigured -> 400; upstream unreachable -> 502. Inserted after the sounds prefix block in `server.rs`.
Tests: the `arena_world_passes_etag_and_304_through` integration test, `WORLD_ID_RE` unit cases, link-url-wins.
If `py::quote` encodes `@`/`:`, use the regex-validated id unencoded.
Egress note (for the integrator's changelog): the route sends only the fixed world id and an ETag to the configured Arena;
no transcript-derived data.

---

## 3. Backend generator work (B1)

### 3.1 Roads
1. Profile: `highway_cm 1000`, `ring_cm 900`, `street_walk_cm 150`, `avenue_walk_cm 200`, lanes 1 per direction for every
   class. `country()` becomes `graded(a, b, path, name, class, width)`;
   radials -> `"highway"`, ring -> `"ring"`. `fn is_graded(class) -> bool { matches!(class, "highway" | "ring") }`
   used at roads.rs:191, :238 and tests.rs:96, :130. Both graded classes keep `country_grade_pm`.
2. `Edge` gains `walk: i64`, `lanes: u8`, `#[serde(rename="ref")] route: Option<String>` (serialized as `null` when none, always present).
   Refs: radial halves of gate k get `"H{k}"`; every ring edge `"R1"`. Gate order is integer-only (mod.rs forbids trig):
   sort gates by a comparator on `(x, z)`: half-plane first (`x < 0 || (x == 0 && z < 0)` comes first, i.e. the angle
   `atan2(x, z)` range (-PI, 0)), then within a half-plane by the cross product `a.x*b.z - a.z*b.x` (i64), which orders by
   `atan2(x,z)` ascending from -PI. Gates are numbered 1..6 in that order.
3. Junctions (`split_contacts`): build all graded polylines first, index interior vertices in a `BTreeMap<(x,z), Vec<(path, idx)>>`
   and diagonal steps per cell; walk contacts in (path, idx) order; single vertex or X crossing (insert the exact midpoint
   `(x+400, z+400)`) -> `push_node` + split both; overlapping run -> junctions at the run's first and last vertex, keep the
   shared section once as `highway`, drop the ring's copy; never 0-length pieces; within 1 cell of an existing node snap to it.
   New nodes appended after existing ones. Add a ring routing cost for stepping onto radial vertices (overlaps become crossings).
4. City edges: resample each edge (straight, axis-aligned between grid nodes) into `n = ceil(len/800)` equal steps:
   point i at `a + (b - a) * i / n` in integer cm (truncating division), y = terrain height there; carve under them with the
   same `carve` (blend reach from width); door y on lots re-read after carving. (Grid lines are at x = 2200 + 4400i and
   z = 1700 + 3400j, so the points are not on the 8 m lattice; nothing may assume they are.)
5. Fix the radial name bug (draw names without replacement from a seeded shuffle, never equal to a grid street's stem).
6. Doc comment at roads.rs:34 lists the classes. Viewer: colours/draw order for highway (orange, widest) and ring (yellow),
   min widths, gate dots, labels with refs.

### 3.2 Tests, re-pin, fixtures
- Keep connectivity and grade tests (class -> limit mapping). Add, over every seed in the seed list plus the 8 seeds in the
  worldgen reader table: no two graded edges cross except at a shared endpoint; no interior point shared by two edges;
  `points[0].y == nodes[a].y` and `points[last].y == nodes[b].y`; highway count >= 2 x gates, ring >= gates; every edge has
  `walk*2 < width`; city edge consecutive points are <= 800 cm apart and equally spaced within an edge (consecutive step
  lengths differ by at most 1 cm).
- Update the existing lot test (`tests.rs:107-110`): `strip(e)` uses `e.points[0]` and `e.points[last]` (city edges are
  straight), not `points[1]`.
- Re-pin `CLAUDE_HQ_1` at **VERSION 1** (not launched; no stored data). Comment at the constant:
  `// re-pinned 2026-10 for road classes highway/ring, sidewalks, city carve (3D City spec)`.
- `bin/worldgen.rs --samples`: prints `{"world": hash, "samples": [{x, z, height, district, lot, site}]}` for:
  a 20 x 20 grid over the world (cm, integers, offset by 37 cm so points are not on lattice vertices), every 25th lot centre,
  the first 3 points of every 20th edge, every site centre; `lot`/`site` = id by axis-aligned rect test (inclusive edges).
- `tools/world_fixture.py`: runs `~/.cargo/bin/cargo run --release --manifest-path backend/Cargo.toml --bin worldgen -- claude-hq@1 --json`
  and `--samples`, writes `tests/fixtures/claude-hq@1.json.gz` (gzip level 9, mtime 0) and `tests/fixtures/claude-hq@1.samples.json`.
- Rust test `fixture_matches_pin`: reads `../tests/fixtures/claude-hq@1.samples.json` at RUNTIME with `std::fs::read_to_string`
  (path from `env!("CARGO_MANIFEST_DIR")`; never `include_str!`, which would break `tests/test_rust_build_context.py` and the
  Docker build-context allowlist); skips with a message when the file is absent (the Docker build has no `tests/`) and asserts
  its `world` == `CLAUDE_HQ_1` otherwise (forces a fixture refresh on every re-pin).

---

## 4. Tests per module

All JS tests are Python unittest files running node like `tests/test_mapedit.py` (stub `global.window = {HQV:{}}`, load the
files in load order with `new Function(fs.readFileSync(...))()`, cases on stdin, JSON out), skipped when node is missing.
Tests that need `claude-hq@1.samples.json` skip (with a message) until B1's fixture lands; the interim `.json.gz` is enough
for the rest.

| file | owner | must cover |
|---|---|---|
| `tests/test_world.py` | B3 | `pack` of tiny fixture and real fixture (gunzip in node with `zlib`); `heightCm` equals every Rust sample exactly; `districtAt`, `lotAt`, `siteAt` equal samples; `groundAt` = pad y inside an HQ lot, continuous across the 4 m blend, = `roadY` on road and sidewalk samples, and never jumps more than 0.6 m per 1 m step along every road polyline; `blockedAt` true inside building footprints, false at every HQ lot door; `blockedAt` uses the index (a 10k-call loop finishes < 200 ms on the real fixture); **walkability flood fill**: a 1 m `blockedAt` grid over the real fixture, flood from the plaza spawn; every HQ door front, every site entrance and one point within 20 m of each world edge midpoint is reachable; `nearestRoad` on a known edge; `surfaceAt` classes on tiny fixture; `trees` deterministic and never on roads; `slopeFactor` monotone; `pack` accepts an old "country" doc; load() with stub fetch/IDB: 304 keeps cache and does not call `pack`, 200 replaces + fires onChange, error with cache resolves, error without cache rejects |
| `tests/test_worldgeom.py` | B4 | every tile builds on the real fixture; index buffers in range; no NaN; triangle budgets (2.3: terrain lod0 <= 200k, roads/tile <= 12k, buildings d0 <= 600k, d1 <= 30k); LOD skirts present; road ribbons per class have the right carriage width (+-2 cm); ribbon y == `roadY` + 0.04 at sampled points; terrain vertex y <= roadY - 0.05 next to roads at lod 0, 1 and 2; building base <= ground at all 4 corners; same input -> byte-identical output; **gantries**: per graded route exactly `floor(len/400)` periodic gantries (+-1) and one 60 m before every junction approach, every `text` starts with the edge `ref` and its dest is "City", "Gate <k>" or a ref; **signs**: one per junction arm, `name` = the arm edge's name; `nameAtlasLayout` indexes every name once; draw-call estimate from tile outputs <= 400 with all 64 tiles visible; governor steps down after 2 s of 25 ms frames and up after 6 s of 10 ms frames, never above start |
| `tests/test_camrig.py` | B5 | spring frame-rate independence (60 steps of 1/60 vs 30 of 1/30, within 1e-3); each mode's settled pose offsets equal the table (with settings.fov 65) and with fov setting 80 every 3D mode is table+15; **vehicle tuning**: for car, moto, bike, skate the settled chase pose = base offsets x backMul/upMul/sideMul; moto roll follows `lean` (0 when reduced); skate speed kick = base kick x 1.6; `fpAnchorWorld` with non-zero yaw, pitch and roll matches a hand-computed matrix, and the car seat lands on the right-hand side (model-local -x); **V in fp**: car seat -> bonnet -> next mode; other vehicles straight to next; cycle order; cycle sets `preferred`; dive reaches near-chase by 1.2 s then settles to `preferred` by 1.7 s (test with preferred chase and near), monotonic altitude, fov 10 -> 70; rise reverses and ends centred, fov 10, up (0,0,-1); **map**: wheel zoom keeps span in 44..2048 (altitude 252..11704); drag pan moves the centre by dx*span/viewH and clamps to the world; `flyMap` reaches its target at 0.8 s and span never < 44; collision: a wall hit at t=0.5 pulls in, never below ground+0.3 on a slope fixture; recentre after 2 s in far, chase and near; Q/R and Z/C bounds; `setSettings` mid-session: fov and reduced take effect within 0.5 s; reduced motion removes bob/kick/roll and shortens blends; vignette 0 when stopped, rises with speed in fp, 0 in every other mode; occluders returns the box between and never the player's; cine deterministic for a seed and `anyInput` -> back in `s.prev` within 0.5 s; photo: Z/C move vertically, `fast` gives x3, never below ground + 0.3; fp pitch clamp and invertY |
| `tests/test_hqhud.py` | B6 | `layoutLabels` drops overlaps by priority, keeps shields; `labelAngle` never returns an upside-down angle over a full turn; `compassTicks` (N at +z, 15 deg spacing, 180 deg window); `kmh`; `loadSettings` clamps and defaults on junk JSON (incl. `preferred`); with a minimal DOM stub (node, no jsdom: a tiny fake `document` with createElement/appendChild/classList/setAttribute/addEventListener): gear has `aria-expanded` in sync, Esc closes, every control has a label, FOV range is 60..100, a change fires `onSettings` and writes `hq_cam`; `frame({hudOn:false})` hides everything; chip clears after 1.4 s (fake clock); source check: every new animation/transition rule in the `/* 3D city HUD */` CSS section has matching `html.hq-calm` and `prefers-reduced-motion` overrides and uses only `var(--...)` colours |
| `tests/test_hqcity3d.py` | B7 | `assign` deterministic for shuffled input; `isYou` always placed when the list exceeds 64; rank order; `placeLot` both facings puts LOT_EXTRAS footprint inside the lot rect; every door front on unblocked ground (with stubbed blocked from world.js on the real fixture); skatepark site size == 2HW x 2HD; bike park rot PI faces the fountain; boards on the fountain side; legacy `hqCityLayout` output unchanged (golden `tests/fixtures/hqcity_legacy_golden.json` captured from the current code BEFORE editing); legacy `lotExtras` caller: glows pushed and `L.car` set (source check) |
| `tests/test_hq3d_integration.py` | B8 | load order list in 22-hq.js; `multi.js` hq range [1,2] and its max >= the hq version in `protocol.rs` (cross-check by parsing both files); hq3d source handles `KeyV, KeyM, KeyP, KeyQ, KeyR, KeyZ, KeyC` with preventDefault inside the camModes guard; `?world=old` routing string present; hqNetSend adds h/p only behind `hqNetCan("alt")` and skips `city3d` without it; picks use `[].concat(cur.floor)`; rig orbit gated on `button === 2`; `rotation.order = "YXZ"` set on avatar and peers; `exitPointerLock` called in pause, destroy, enterWorld and the fp/photo exit path; `contextmenu` preventDefault only behind a chase-family check; idle timer not armed in map/photo; gamepad polled only after `gamepadconnected`; pure (node): `padToInput` dead zone, LB/RB edges, Y map, A hop, X = E; `doorUnderCrosshair` hit/miss/range; `shotName(new Date(2026,9,19,8,5,3))` == `claude-hq-20261019-080503.png`; map click on another HQ calls `flyMap` (not `dive`/teleport) |
| `tests/test_local_arena.py` | B2 | runs `tools/local_arena.sh` end to end with `HQ_ROOT`, `ARENA_DEV_DATA`, `ARENA_PORT`, `HQ_PORT` pointed at a temp dir and free ports (a temp copy of a FAKE `config.json` + `arena-link.json`, never the real ones): `start`, `dashboard-tmp` (starts a temp `claudehq --root <tmp copy> --port <free>` instead of launchd), `pair`, `status`, `pair` again (idempotent: no new code minted), `restore`, `status`; asserts backups created once, restored byte-identical, two `pair2` handles -> two user rows; skipped when the release binaries are missing |
| Rust `backend/` | B1, B2 | 3.2; presence v2 + `city3d`; dev login; updated hq.rs/protocol.rs tests; `cargo test --locked` + clippy |
| Rust `dashboard-rs/` | B2 | proxy tests (2.9) |
| `tools/ui_smoke.py` | B2 | existing checks, then the 3D runs. Fake Arena: Python `http.server` on a free port serving `/v1/world/claude-hq@1` as the DECOMPRESSED JSON from the gz fixture (`Content-Type: application/json`, ETag, 304 on match), `/v1/hq/open` -> 3 synthetic HQs, everything else 404; `config.json` `{"arenaUrl": fake}` in the temp root. Chrome: `--headless=new --use-angle=swiftshader --enable-unsafe-swiftshader --user-data-dir=<tmp profile>`, driven over the DevTools pipe (`--remote-debugging-pipe`, stdlib only) or, if that is unavailable, repeated `--dump-dom --timeout=<ms>` launches; poll in REAL time (up to 60 s) until `data-hq-smoke` is set. Assertions: no JS error line; `data-hq-smoke` starts `ok`; at `cam=map`: `labels.roads, shields, hqs, peers` all > 0; at spawn, plaza and the H1 hill: `drawCalls < 400`, `triangles < 1.5M`; report `worker` true/false. **Cache gate C0**: load the page twice with the same `--user-data-dir`; the second run's `cache` value < 100 ms and the fake Arena logged a 304. **Fallback**: a second fake Arena that answers 401 on `/v1/world/*` -> the legacy City loads with the "not available" announce and no JS error |
| `tools/hq_shots.py` | B2 | same server setup; one shared `--user-data-dir` for all launches (IDB cache reused); for each mode in `map far chase near fp classic photo cine` at 3 fixed spots (your HQ door, the plaza, a hill on the H1 highway) day and night: `--screenshot=<out>/<mode>-<spot>-<day|night>.png --window-size=1280,800` on `/?hqsmoke=1&cam=<mode>&at=<x,z>[&night=1]`; plus: map at spans 2048, 400 and 44 (`&span=`); per vehicle (`&ride=car|moto|bike|skate`) chase and fp on the H1 hill, car also `fp-bonnet` (records `vehicle.pitch`, asserts non-zero on the hill); fp at your HQ door (prompt "E  Enter ..." visible); a night shot on H1 at a gantry; one `&calm=1` chase shot; writes `index.html` contact sheet to `docs/screenshots/3d-city/` (or `--out`); prints the `hq-frame` log lines |

---

## 5. Local run (I runs it; B2 writes the script)

The owner's rules: never run kubectl, nix or cabal builds; never open visible test windows without consent. Cargo builds,
the owner's own launchd dashboard restart and a user LaunchAgent for the dev Arena are in scope for this request
("fully running on local"); if a permission prompt refuses, hand the exact command to the owner.

Current state (checked): an Arena is already running as `./target/release/arena` (pid 11530 at review time) bound to
`0.0.0.0:8080` (no `ARENA_BIND_HOST`, no pid file). Its executable resolves to `~/claude-hq/backend/target/release/arena`.

`tools/local_arena.sh` subcommands (bash, `set -euo pipefail`, uses `~/.cargo/bin/cargo`; overridable env for tests:
`HQ_ROOT` (default `~/claude-hq`), `REPO` (default the script's repo), `ARENA_DEV_DATA` (default `~/.local/share/claude-hq-dev-arena`,
called `$DATA`), `ARENA_PORT` 8080, `HQ_PORT` 8765). Every subcommand starts with `mkdir -p "$DATA"` (mode 0700).

1. `build`: `~/.cargo/bin/cargo build --release --manifest-path "$REPO/backend/Cargo.toml"` and the same for `dashboard-rs`;
   then check that the dashboard plist's `ProgramArguments[0]` is `$HQ_ROOT/dashboard-rs/target/release/claudehq`
   (`plutil -extract ProgramArguments.0 raw`) and warn if `$REPO != $HQ_ROOT` (the launchd dashboard runs the live tree's
   binary, see section 6).
2. `start`: if the LaunchAgent `com.claudehq.devarena` is installed, `launchctl kickstart -k gui/$(id -u)/com.claudehq.devarena`
   and wait for health. Else stop any arena on `$ARENA_PORT`: the pid file first; else for each pid from
   `lsof -tiTCP:$ARENA_PORT -sTCP:LISTEN`, resolve its executable with `lsof -a -p $pid -d txt -Fn | sed -n 's/^n//p' | head -1`
   and kill it only if it equals `$REPO/backend/target/release/arena` or `$HQ_ROOT/backend/target/release/arena`
   (a relative `./target/release/arena` command line resolves correctly this way); any other listener -> fail with its
   command line, kill nothing. Wait until the port is free. Secret: if `$DATA/secret_key` is missing, write
   `openssl rand -hex 32` there with `umask 077`. Then from `$REPO/backend/`:
   ```
   ARENA_BIND_HOST=127.0.0.1 ARENA_BIND_PORT=$ARENA_PORT ARENA_WORLD_PREVIEW=1 ARENA_DEV_LOGIN=1 \
   ARENA_DATABASE_URL=sqlite:$DATA/arena.db ARENA_SOUNDS_DIR=$DATA/sounds \
   ARENA_SECRET_KEY="$(cat "$DATA/secret_key")" ARENA_PUBLIC_BASE_URL=http://127.0.0.1:$ARENA_PORT \
   nohup ./target/release/arena >> "$DATA/arena.log" 2>&1 &  echo $! > "$DATA/arena.pid"
   ```
   (`sqlite:/abs/path` is the form `db.rs::normalise_url` already accepts; the pool uses `create_if_missing(true)`.)
   Wait for `curl -fsS 127.0.0.1:$ARENA_PORT/health`, then assert `$DATA/arena.db` exists.
3. `dashboard`: `launchctl kickstart -k gui/$(id -u)/com.claudehq.dashboard`, wait for `127.0.0.1:$HQ_PORT/`.
   `dashboard-tmp <root> <port>` (tests and preview): runs `$REPO/dashboard-rs/target/release/claudehq --root <root> --port <port> --no-open`
   in the background with its own pid file `$DATA/hq-<port>.pid`.
4. `pair [port] [handle]` (default `$HQ_PORT`, handle `dev`): if `GET /api/arena/status` already shows `paired: true` and
   `url: http://127.0.0.1:$ARENA_PORT`, print "already paired" and exit 0. Else, if `config.json.prod-bak` /
   `arena-link.json.prod-bak` do not exist in that dashboard's root, `cp -p` both (0600 kept; the link holds the production
   token; never overwrite an existing backup). CSRF token from
   `curl -s 127.0.0.1:$port/ | sed -n 's/.*name="hq-csrf" content="\([0-9a-f]*\)".*/\1/p'`; `POST /api/config` with
   `X-HQ-Token` and `Origin: http://127.0.0.1:$port` (merge: read `GET /api/config` first and send it back with only arenaUrl changed);
   `code=$(curl -s -X POST -H 'Content-Type: application/json' -d "{\"handle\":\"$handle\"}" 127.0.0.1:$ARENA_PORT/v1/auth/dev-login | python3 -c 'import json,sys;print(json.load(sys.stdin)["code"])')`;
   `POST /api/arena/pair {"code":"$code","label":"local-dev"}`; verify `GET /api/arena/status` -> `paired: true`, `url: http://127.0.0.1:$ARENA_PORT`
   and `GET /api/arena/world/claude-hq@1` -> 200 with an ETag, then the same with `If-None-Match` -> 304.
5. `pair2`: the second browser for C5. Makes `$DATA/hq2/` with copies of `index.html`, `ui/`, `games/` from `$REPO`
   (rsync, refreshed each time) and an empty `config.json`; `dashboard-tmp $DATA/hq2 8766`; `pair 8766 dev2`. Then
   asserts the Arena's `users` table has two distinct rows for `dev` and `dev2` (`sqlite3 "$DATA/arena.db"`). The owner opens
   `http://127.0.0.1:8766/` in any second browser/profile. No Arena restart. `stop2` kills the 8766 dashboard and removes `$DATA/hq2`.
6. `status`: arena pid/health and which executable holds the port, LaunchAgent installed or not, dashboard health, current
   arena URL and `paired`, backup presence; flags "dashboard paired to local but arena down" loudly.
7. `restore`: `mv config.json.prod-bak config.json; mv arena-link.json.prod-bak arena-link.json` (fails loudly if a backup is
   missing; never `POST /api/arena/unpair`, it deletes the link); verify `GET /api/arena/status` shows `paired: true` and
   `https://arena.heshdev.tech`; leaves the local Arena running (`stop` stops it). No dashboard restart needed (both files
   are re-read per request). After restore, the City falls back to legacy (production has no world route) - ui_smoke's
   fallback run covers that path.
8. `stop`: kill the pid from the pid file (or `launchctl bootout` the agent when installed).
9. `install-agent` / `uninstall-agent`: write/remove `~/Library/LaunchAgents/com.claudehq.devarena.plist` (generated by the
   script: KeepAlive, RunAtLoad, WorkingDirectory `$HQ_ROOT/backend`, the same env as `start`, stdout/stderr to
   `$DATA/arena.log`) and `launchctl bootstrap`/`bootout gui/$(id -u)`. With it installed the local Arena survives logout
   and reboot, matching the KeepAlive dashboard paired to it.

Production note: until the production Arena serves `/v1/world/claude-hq@1` (and presence v2), a dashboard paired to
production falls back to the legacy City (2.8) and sends no `h/p` (no `alt` cap). Nothing here deploys to production.

---

## 6. Integration order and gates

Step 0 (integrator, before builders start): create the worktree `$WT` (top of file); build the current generator
(`~/.cargo/bin/cargo build --release --manifest-path $WT/backend/Cargo.toml --bin worldgen`) and write the interim fixture
`$WT/tests/fixtures/claude-hq@1.json.gz` from `$WT/backend/target/release/worldgen claude-hq@1 --json` (gzip level 9, mtime 0;
old "country" format, which `pack` accepts). B1 replaces it at step 1. Capture nothing else; B7 captures its own golden.

Builders run in parallel from the start, all in `$WT`. Steps 1-9 run the stack from `$WT` without touching the live tree:
the local Arena from `$WT/backend` and a preview dashboard `local_arena.sh dashboard-tmp $WT 8767` (its own
`config.json` in `$WT`, gitignored), paired with `pair 8767`. The owner's launchd dashboard stays on production until step 10.
Integrator merges in this order, running the listed checks after each step; a red check goes back to the owning builder.

| step | merges | checks (all must pass) | phase gate |
|---|---|---|---|
| 1 | B1, B2 backend | `cargo test --locked` + clippy in `backend/`; `tools/world_fixture.py` regenerated; fingerprint re-pinned once | - |
| 2 | B2 dashboard, local script | `cargo test` + clippy in `dashboard-rs/`; `tests/test_local_arena.py`; `local_arena.sh build start`, `dashboard-tmp $WT 8767`, `pair 8767`; proxy 200 + 304 | - |
| 3 | B3 | `test_world.py`; `ui_smoke.py` cache run: second load `cache` < 100 ms and a 304 | **C0** WorldDoc from cache < 100 ms |
| 4 | B4, B7 | `test_worldgeom.py`, `test_hqcity3d.py`, `test_world.py` flood fill; `ui_smoke.py` (`cam=classic` renders the generated City, budgets at spawn/plaza/hill); perf, see below | **C1** whole city walkable, 60 fps |
| 5 | B5, B8 camera part, B6 | `test_camrig.py`, `test_hqhud.py`, `test_hq3d_integration.py`; `hq_shots.py` shots reviewed: camera never inside walls/terrain in far/chase/near at the 3 spots, see-through fade on the building between camera and you, no flicker between fade systems | **C2** no clipping through walls or ground |
| 6 | B8 map/dive | `hq_shots.py` map spans + `ui_smoke` label counts; on the preview dashboard: open City -> map; click your HQ -> dive (1.2 s) -> chase (or the persisted `preferred`), no pop; M back up; click elsewhere flies the map; click another HQ flies to it | **C3** map, click your HQ, land in chase smoothly |
| 7 | B8 vehicles | `hq_shots.py` vehicle shots (pitch non-zero on H1); FP seat/bonnet on car, seat on moto/bike/skate; drive the car up a hill on H1 in FP: no clipping, pitch follows slope, slower uphill | **C4** up a hill in FP no clipping |
| 8 | B8 presence + B2 protocol | `tests/test_protocol.py`; `local_arena.sh pair2`; two browsers (8767 and 8766) both in the City (`w:"city3d"`): each sees the other at the right height on a slope, smooth; a `?world=old` tab does not see them | **C5** two browsers see each other on slopes |
| 9 | polish (B5 cine/photo, B4 governor, B6 settings, B8 gamepad) | settings persist (FOV, sensitivity, invert Y, reduced motion, quality, preferred mode); reduced motion visibly removes bob/kick/roll (calm shot); photo screenshot downloads; idle 45 s -> cine, key returns; gamepad moves and cycles modes (owner, if a pad is available; else source + `padToInput` tests only) | **C6** polish |
| 10 | switch-over | integrator bumps `APP_VERSION` (`dashboard-rs/src/app.rs`, minor: 2.7.0 -> 2.8.0) and adds the README Changelog entry incl. the egress note for `/api/arena/world` (2.9) and the dev-login flag (local only); full suite in `$WT`: `python3 -m unittest discover -s tests`, both cargo suites, `tools/ui_smoke.py`; `local_arena.sh stop2`; commit on `feat/3d-city`, then merge into the live checkout (`git -C ~/claude-hq merge --ff-only feat/3d-city`, or a normal merge if the live branch moved); `local_arena.sh build` (live tree), `install-agent`, `start`, `dashboard`, `pair`, `status` (the owner's launchd dashboard now paired to the local Arena); generated City is the default; `?world=old` still loads the legacy City; owner sign-off required before deleting `games/hqcity.js` legacy world (not in this build) | switch-over |

**Perf (C1).** This machine is a MacBook Pro M1 Pro (`hw.model` MacBookPro18,1), not an M1 Air. Automated: ui_smoke
asserts draw calls and triangles. Frame rate: needs real Chrome with the GPU (swiftshader numbers are meaningless) and so a
visible window. The integrator does NOT open it; it hands the owner one command:
`open -na "Google Chrome" --args --user-data-dir=/tmp/hqperf --new-window "http://127.0.0.1:8767/?hqsmoke=1&hqperf=1&at=<plaza>"`
(and the H1 hill), with settings quality pinned "high" and the window at the M1 Air's 1440x900, and reads the `hq-frame`
lines the owner pastes back. Gate: median ms <= 16.7 at quality high. On an M1 Pro this is a proxy for the M1 Air target;
recorded as an open point (section 7).

Final integrator report: what runs where (Arena 127.0.0.1:8080 pid / LaunchAgent, dashboard 127.0.0.1:8765 paired local),
test results, screenshot sheet path, gates passed/failed, the restore command `tools/local_arena.sh restore`, and open owner decisions.

---

## 7. Open points (defaults chosen; owner may override)

- Map click on a non-HQ point flies the map camera there (zoom one step). This is how the plan's "clicking anywhere on the
  map flies there" was read (a map-camera fly, not an avatar teleport); owner may revisit. Clicking your HQ dives; clicking
  someone else's HQ flies the map to it (span 44) and announces its name, no teleport. M from anywhere dives to the avatar.
- Skatepark at +11 m, bike park at -11 m (follow the WorldDoc, mirrored from the legacy City); the bike park is rotated by
  PI and the boards moved to the fountain side so both still face the fountain.
- Generator VERSION stays 1 and the fingerprint is re-pinned (world not launched).
- `?world=old` and the legacy City are kept until the owner signs off their deletion.
- Payload compression on the local Arena is not added (no new crates); 970 KB over loopback is fine, production Caddy compresses.
- "Distant buildings as impostors": met by the detail-1 low-poly body with shader window bands, not by billboards. A
  billboard/merged impostor beyond ~900 m is not built; the detail-1 budget (<= 30k triangles for the whole world) makes it
  unnecessary.
- Lanes: one per direction on every class (the given widths cannot fit two 1.7 m-car lanes per direction).
- The 60 fps gate is measured on the owner's M1 Pro as a proxy for the M1 Air.
- Minimap: out of scope (comes later with navigation). No builder adds one.

---

## Review log (revision 2)

Feasibility review:
1. City resample on 8 m lattice - ACCEPTED (equal steps n = ceil(len/800); lattice claim dropped; test changed). 2.1, 3.1.4, 3.2
2. tests.rs `strip` uses points[1] - ACCEPTED (first/last point; B1). 3.2
3. Terrain lod0 140k impossible with skirts - ACCEPTED (budget raised to 200k). 2.3
4. Detail-1 60k impossible with baked bands - ACCEPTED (shader bands from fract(worldY/3.5); budget 30k). 2.3, 2.4
5. Dev login constant github_id; C5 shares the link - ACCEPTED (per-handle negative id, optional raw body, `pair2` second dashboard on 8766). 2.9, 5
6. `start` misses the relative-path Arena - ACCEPTED (lsof txt executable resolution, mkdir, always write pid). Verified: pid 11530 resolves to backend/target/release/arena. 5
7. Skate height double-counted; wrong line cite - ACCEPTED (`skateBase + st.y`, peers `skateBase + y/10`, groundY = pad y in park; line is :1243). 2.7, 2.8
8. Classic camera on terrain - ACCEPTED (goal.y = groundAt + camY at :865/:907/:1024). 2.8
9. Two fade systems - ACCEPTED (hqCutaway in classic only; occluders in rig modes; c.view unchanged). 2.7, 2.8
10. Nested floor array; any-button orbit - ACCEPTED (required changes, `[].concat`, right-button orbit in rig modes). 2.8
11. Fog/shadow in setTime never run - ACCEPTED (moved into per-frame w.update with cam.mode/avatar). 2.7, 2.8
12. Euler order and pitch sign - ACCEPTED (YXZ, rotation.x = -pitch). Units, 2.8
13. Model frame +x is left; chase movement uses view.yaw - ACCEPTED (model-local frame defined, seat x -0.38, near side -0.6, lookYaw vs view.yaw defined). Units, 2.5, 2.8
14. Mixed City implementations in hq_city - ACCEPTED (`city3d` floor, `w.net`, peers filtered by it, no send to v1 servers). 2.7, 2.8, 2.9
15. Road z-fighting - ACCEPTED (near 0.3/0.15, polygonOffset). 2.4, 2.5, 2.8
16. heightAt on a road is not the road surface - ACCEPTED (`roadY` shared by groundAt and ribbons; terrain clamp at every LOD; no pad blend over roads). 2.1, 2.2, 2.3
17. Fixture missing on day one - ACCEPTED (interim fixture at step 0; samples-dependent tests skip). 6, 4
18. Existing hq.rs/protocol.rs tests not scoped - ACCEPTED (listed in B2). 1, 2.9
19. Map altitude vs span mismatch - ACCEPTED (span primary 44..2048, altitude 252..11704 derived). 2.5
20. FOV setting vs table - ACCEPTED (offset of setting - 65). 2.5
21. lotExtras drops glows/L.car; push order; lamplit signature - ACCEPTED (`{items, glows, car}`, legacy order kept, `lamplit(gr)`). 2.7
22. Parks mirrored, props not - ACCEPTED (bike park rot PI, boards -HW+0.5 yaw +PI/2). 2.7, 7
23. Smoke harness timing / gz passthrough - ACCEPTED (real-time polling via DevTools pipe or repeated dump-dom; decompressed JSON; shared user-data-dir in hq_shots). 4
24. Draw calls 512 > 400 - ACCEPTED (<= 5 calls beyond 300 m; ~350 worst case; tested). 2.4, 4
25. blockedAt linear tree scan - ACCEPTED (trees in the 64 m bucket index; perf test). 2.2, 4
26. Calm gating, APP_VERSION/README unowned - ACCEPTED (house style; integrator owns both). Header, 1, 6
27. atan2 gate order, include_str!, requestIdleCallback, enterWorld re-entrancy, lane widths - ACCEPTED all five (integer comparator; runtime std::fs read with skip; setTimeout fallback; `entering` guard; 1 lane per direction). 3.1.2, 3.2, 2.3, 2.8, 2.1

Coverage review:
1. Per-vehicle camera tests - ACCEPTED. 4 (test_camrig)
2. No runtime settings change - ACCEPTED (`setSettings`, wired from onSettings and E.calm()). 2.5, 2.8
3. Settings panel acceptance - ACCEPTED (aria/Esc/labels/tokens/calm + DOM-stub tests). 2.6, 4
4. Compass/speed/chip/vignette tests - ACCEPTED (`compassTicks`, `kmh`, hudOn, chip timer, vignette rule). 2.5, 2.6, 4
5. Gantries/signs untested and undrawn - ACCEPTED (placement and dest defined, atlas + 3 InstancedMeshes, tests, night gantry shot). 2.3, 2.4, 4
6. Map labels unchecked - ACCEPTED (3 spans in hq_shots, synthetic friend, `labelCounts` asserted, `labelAngle` test). 2.6, 2.8, 4
7. Click on another HQ undefined - ACCEPTED (flyMap to it, no teleport; tested; section 7 notes the reading). 2.8, 7
8. `preferred` never set - ACCEPTED (cycle sets it, persisted in hq_cam, dive test with near). 2.5, 2.6
9. Map pan/zoom/fly untested - ACCEPTED. 2.5, 4
10. Gamepad unchecked - ACCEPTED (`padToInput`, connect-gated polling, C6 line). 2.8, 4, 6
11. Pointer lock / FP interaction unchecked - ACCEPTED (source checks, `doorUnderCrosshair`, fp door shot). 2.8, 4
12. Vehicles missing from shots - ACCEPTED (`&ride=`, vehicle pitch/roll in stats, per-vehicle shots). 2.8, 4
13. Perf budget not enforced; M1 Air measurement - ACCEPTED (ui_smoke asserts dc/tri and worker flag; real-Chrome run handed to the owner as a command). Verified: this Mac is an M1 Pro, not an M1 Air; recorded in 6 and 7.
14. Impostors not met - ACCEPTED as an explicit decision in section 7 (no billboard tier).
15. C0 needs a headless check - ACCEPTED (two runs, same profile, cache < 100 ms, 304 without pack). 2.2, 4
16. Walkability by hand only - ACCEPTED (flood-fill test + road step test in test_world.py, owned by B3). 4
17. Reduced-motion source and calm shot - ACCEPTED (`E.calm() || setting`; calm shot; chip calm check). 2.5, 2.6, 4
18. CLIENT_PROTO ordering - ACCEPTED (B2 protocol.rs test, B8 multi.js, cross-check test). 2.8, 2.9, 4
19. Second C5 browser impractical - ACCEPTED (`pair2`/`stop2`, handle body, two-user assertion). 5, 6
20. Local Arena not persistent - ACCEPTED (`install-agent`/`uninstall-agent`, status flags arena down). The plist is generated by the script, so no extra owned file. 5
21. local_arena.sh missing steps - ACCEPTED: mkdir, ARENA_SOUNDS_DIR, generated 0600 secret, db file check, plist binary check, idempotent pair, restore verification. REJECTED in part: switching to `sqlite:///$DATA/arena.db` - `sqlite:/abs/path` is already accepted by `db.rs::normalise_url` (and the pool has create_if_missing), so no change is needed.
22. Integrator owns nothing / no script test - ACCEPTED (APP_VERSION, README changelog + egress note owned by I; `tests/test_local_arena.py` against temp copies, owned by B2 as the script's author). 1, 4, 6
23. Cine/photo headless coverage - ACCEPTED. 2.5, 2.8, 4
24. Recentre/look-ahead only for chase - ACCEPTED (shared by the chase family; recentre tested in all three). 2.5, 4
25. Minimap unmentioned - ACCEPTED (out of scope in 7).
26. Live tree risk - ACCEPTED (shared worktree `$WT`; preview dashboard on 8767; merge to the live tree at step 10). Header, 6
