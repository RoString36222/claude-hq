# Minimap, waypoints, road navigation and the river (HQ 3.1)

The engineering contract for the 3.1 build. Tasks run in parallel against these shapes; nothing
here changes without updating this file. The Cities contract (cities-build-spec.md) still holds.

## Product (owner's ask, 2026-10-20)

- "How do I find the dock/port?" A **minimap** in the bottom-right corner, **waypoints**, and
  **turn-by-turn navigation along the roads**, fully interactive (click, zoom, keyboard, search).
- **A river through the city** so the port is not always on the edge of the city.

## Invariants

- `claude-hq@1` stays byte-identical (its fingerprint test). Every new serde field is `Option`,
  skipped when `None`, and `None` in @1. The Commons and the islands are re-pinned on purpose.
- Generator: integer math (cm, Q16), no floats or trig, a pure function of (id, edits).
- Client: pure helpers node-tested (tests/test_<module>.py, as tests/test_cities.py), frame-rate
  independent (`ease(k, dt)` / springs, never `Math.min(1, dt*k)`), textContent only (no innerHTML
  with data), nothing leaves the machine. Each new UI piece adds at most 3 draw calls.
- Keys pressed inside any panel or menu this build adds never reach the dashboard's shortcuts or
  drive the avatar (stopPropagation + preventDefault on keydown/keyup in the panel).
- Bearings (games/hqhud.js): yaw 0 faces +z, increasing yaw turns LEFT; clockwise heading = -yaw;
  N = +z, E = -x.

## The river (generator, Rust)

One river in every @2 world (the Commons and every island), from the sea inland to a harbour basin
near the city's middle.

- **Course:** it leaves the coast at a seeded bearing and meanders (integer value noise on its
  lateral offset) inland to a harbour basin whose centre is 25-45% of the city radius from the plaza
  (never inside the plaza block). Width: Commons 36 m, island 24 m; the basin is a disc, 2.2x that.
- **Water:** the river and basin are water at sea level: `Coast::shape` (or a sibling terrain hook)
  sinks them below `sea_cm` with banks blending up like the beach.
- **Roads:** no street, lot, block or site overlaps the river (plus 4 m of bank). Roads that must
  cross it do so on **bridges**: every road edge whose centreline crosses the water is
  `bridge: Some(true)` and stays straight and level across it (deck at the higher bank's height
  plus 1 m). Arterials, the ring road and highways always get a bridge; local streets stop at the
  bank unless a crossing keeps the street network connected (it must stay one connected network at
  every island tier, as today).
- **Docks move inland:** the `dock` site stands on the river bank inside the tier-1 ring (so a
  tier-1 island has a road to its dock); the `port` site stands on the harbour basin. Both keep
  their spec tiers and their pier (`front` faces the water). `layers.island.docks` still lists them.
- **Doc layer** (`layers.river`, `hashes.river`; both skipped when absent):
  ```text
  River = { center: [[x, z], ...],   // cm, from the mouth (on the coast) to the basin's centre
            width_cm: i64,           // the channel's width
            basin: { x, z, r },      // cm: the harbour basin
            poly: [[x, z], ...] }    // cm, CCW: the water outline (channel + basin), its mouth end
                                     // closed 30 m out past the coast so it overlaps the sea
  Edge += bridge: Option<bool>
  ```
- **Tests (Rust):** river mouth is on the coast and its water polygon is simple; nothing (street
  away from bridges, lot, block, site) overlaps the water + 4 m; every edge crossing the water is a
  bridge and every bridge crosses it; the dock is inside the tier-1 ring on an island, the port
  touches the basin; the road network is connected at every tier; same id -> same doc; @1 unchanged;
  generation time budget unchanged (Commons under 300 ms release).

## Client: the river (worldgeom/worldbuild/ocean)

- Water surface over `river.poly` at sea level (the ocean's material/colour, one mesh), banks
  shaded; bridges drawn as decks with railings over the water (the bridge edges), not ribbons on
  the riverbed.
- `HQV.ocean.seaOf(doc)`: `land(x, z)` is false on the river's water too (boats sail up it, walking
  and driving stop at its bank), except on a bridge deck. `groundAt` on a bridge is the deck.
- Boats moored at the river dock and port berths exactly as at a coast dock.

## Client: navigation (games/hqnav.js, pure)

```text
HQV.hqnav = {
  graph(W, tier)                  -> G     road graph of the world at this tier (cached per W+tier);
                                           edges with min_tier > tier excluded; bridges included
  snap(G, x, z)                   -> {ei, s, x, z, d}  nearest point on a road (m)
  route(G, from, to, mode)        -> R | null   from/to {x, z} (m); mode "drive" | "walk";
        R = { pts: Float64Array [x0, z0, x1, z1, ...] (m, along the road, start and end
              included off-road legs), len (m), eta_s,
              steps: [{at (m along), kind, road, x, z}] }
        kind: "start" | "left" | "right" | "slight-left" | "slight-right" | "sharp-left" |
              "sharp-right" | "straight" | "uturn" | "bridge" | "arrive"
        (a turn is a heading change over 30 deg at a junction; under 30 is "straight" and is
        merged away unless the road name changes; 30-60 "slight", 60-135 plain, 135+ "sharp")
  progress(R, x, z)               -> {along, left, off, next, toNext, arrived}
        along: m along pts nearest (x, z) (monotone: never jumps backwards more than 15 m);
        off: lateral distance (m); arrived: within 12 m (drive) / 6 m (walk) of the end
  needsReroute(P, mode)           -> bool   off > 25 m (drive) / 15 m (walk) for over 2 s
  places(W, tier, o)              -> [Place] o: {x, z, me, hqs: [{userId, name, lot}], island: bool}
        Place = {id, kind, label, icon, x, z, door: {x, z}, dist}
        kinds: dock, port, transit, airport, townhall, hospital, clinic, police, fire, school,
               university, market, mall, bank, library, post, stadium, fountain, skatepark,
               myhq, hq (a friend's), travel (another island or the Commons: its door is the
               nearest dock/port; label "The Commons (ferry)")
        sorted by straight-line distance; only sites present at this tier
}
```

Speeds for eta: walk 1.6 m/s, drive 12 m/s on local streets, 16 on arterials, 22 on highways.

## Client: the minimap (games/hqminimap.js)

```text
HQV.hqminimap = {
  mount(stageEl, {onPick(x, z), onExpand(), announce}) -> mm
    mm.setWorld(W, tier, {places, coast, river})   static layer redrawn only here (cached canvas)
    mm.frame({x, z, yaw, speed, route: Float64Array|null, waypoint: {x, z}|null,
              others: [{x, z, col}]})              cheap per-frame draw (< 1 ms)
    mm.setMode("heading" | "north")  (default heading-up), mm.zoom(+1|-1), mm.destroy()
  toMini(view, x, z) -> [px, py]; fromMini(view, px, py) -> [x, z]  (pure)
  zoomFor(speedMps) -> metres across  (walk 220 m ... 60 km/h+ 600 m, eased)
}
```

- 200 x 200 CSS px (160 under 700 px wide), rounded square, bottom-right (right 12px, bottom 12px),
  class `.hq3d-minimap`; draws: sea, coast, river, roads by class width, civic POI icons (dock,
  port, transit, townhall, hospital/clinic, police, fire, market, school, airport), your HQ,
  friends' HQs, other players, the route line, the waypoint pin, you (an arrow), N marker.
- Click / tap sets a waypoint there (`onPick`, snapped by the host). Wheel / +/- buttons zoom.
  A button toggles heading-up / north-up; another (or the existing M key) opens the full map.
- The driving dials (`.hq3d-drive`) move left of the minimap; nothing overlaps at 1280x800 or at
  700 px wide.

## Client: the route in 3D (games/hqroutefx.js)

```text
HQV.hqroutefx = {
  create(c, scene) -> fx      c: the hq3d ctx (THREE, mat, ...)
    fx.setRoute(pts|null, groundY(x, z))   chevrons along the route on the road surface
    fx.setWaypoint({x, y, z}|null)         a light pillar at the destination, seen from afar
    fx.update(dt, player {x, z}, cam)      chevrons within 250 m ahead of you, flowing forward
    fx.dispose()
}
```

One InstancedMesh for chevrons (every 4 m, lifted 6 cm over the road, depth-tested, the brand
colour, unlit glow), one mesh for the pillar; at most 3 draw calls.

## Client: the navigation UI (games/hqnavui.js)

```text
HQV.hqnavui = {
  mount(stageEl, {places(), onGo(place), onClear(), announce}) -> ui
    ui.open() / ui.close() / ui.isOpen()     the "Go to" panel: search box, places by distance
                                             (icon, label, distance), arrow keys + Enter, Esc
    ui.banner(info | null)                   top-centre: maneuver arrow, distance to it, road name,
                                             remaining distance + ETA, destination, an X to clear
    ui.arrived(label)                        a short "You have arrived" card
    ui.destroy()
  maneuverText(step, toNext) -> string       (pure) "In 120 m turn left onto Patch Lane"
  fmtDist(m), fmtEta(s)                      (pure)
}
```

- Key **N** (when not typing) opens the panel; a "Go to" button sits under "My island / The
  Commons" (top-left stack). Keys typed in the panel never leak (see Invariants).

## Integration (games/hqcity3d.js, games/hq3d.js, ui/app/22-hq.js, games/games.css)

- Mount minimap, routefx and navui in every 3D City world (v1 too: its roads route the same).
- Waypoint sources: a place from the panel, a minimap click, a click on the ground in map mode (M).
  The route starts from you, mode "drive" while riding a road vehicle, else "walk"; on a boat a
  straight line. Reroute on `needsReroute`; clear on arrival (with the card) or X.
- A `travel` place routes to its dock/port door; on arrival there the banner says
  "Press E for the ferry".
- Fix the known leak: keys while a stop/dock/travel menu is open must not reach the dashboard.
- Version 3.1.0 (app.rs, Cargo.toml, Cargo.lock, README changelog "Navigation and rivers").

## Checks

- Rust: `cargo test` + `cargo clippy --all-targets -- -D warnings` in backend; the Commons and
  island fixtures regenerated with `python3 tools/world_fixture.py`.
- JS: tests/test_hqnav.py, test_hqminimap.py, test_hqroutefx.py, test_hqnavui.py, river cases in
  the worldgeom/ocean tests, and tests/test_cities.py extended (a route from spawn to the dock exists
  on the Commons and on a tier-1 island; the minimap and banner mount; no key leaks).
- System: headless shots (tools/ui_smoke.py driver): minimap on foot and driving, the Go to panel,
  a route with chevrons, the banner, the river with a bridge, the river port with boats, a boat on
  the river; and a scripted drive that follows the route to the dock and arrives. No visible windows.
