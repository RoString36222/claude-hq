# Grand Prix: F1 circuits and the 2026 grid (HQ 3.17)

The owner asked for this on 2026-10-23: every F1 circuit, the popular teams' F1 cars in the dealership, and the cars
drivable everywhere (the circuits and the city streets alike). The Dealership spec still holds; this one adds to it.

Read `AGENTS.md` first. House style applies: `var`, defensive guards, `textContent` only, no `Math.random()` for
anything seen twice, frame-rate independent easing, and no build step. **No new Python.** Tools and data checks are
Rust (`dashboard-rs/`, `backend/`). Pure JS is checked under node from Rust integration tests (`dashboard-rs/tests/`,
which skip when node is missing). The Python tests already in `tests/` still run in CI and must stay green.

## 1. Decisions

1. **Each circuit is its own world, at true scale.** The Commons is about 900 m across and a circuit is 3.3 to
   7 km long, so no circuit fits in the city.
   - **Grand Prix** is a Valley game (`games/gp.js`, registered as `gp`). It is built on Valley Rally's car physics
     (`games/rally/physics.js`) and its scene (`games/rally/scene.js`). A circuit becomes a stage object of the same
     shape that `rallyScene.setStage` and the physics `env` already take.
   - In the City, a **Grand Prix Circuit** venue (section 5) opens the game.
2. **The circuits come from data, not by hand.**
   - The centre lines come from bacinger/f1-circuits (MIT, `games/gp/LICENSE-f1-circuits.md`) and are converted by
     `cargo run --bin f1circuits` (`dashboard-rs/src/bin/f1circuits.rs`, logic in `dashboard-rs/src/gp.rs`) into
     `games/gp/circuits.json`.
   - The file holds 40 circuits: the 23 on the source's 2026 calendar (`round` 1-23) and 17 classics (`round: null`).
   - Each circuit is local metres (x east, z south; heading 0 = north = -z, the rally frame). It is a closed loop
     from the start line in the race direction, scaled to the published length.
   - Nothing is fetched at runtime.
3. **The 2026 grid, all 11 teams, in one class.**
   - The class is `car.formula.2000` ("Formula 1 · 1600 cc V6 hybrid", tier 4). It sets `"slots": 11`, a new
     per-class field: a class may list up to its `slots` vehicles (cap 12; 4 when absent).
   - `games/hqvehicles.js`, `backend/src/vehicles.rs` and `dashboard-rs/tests/catalogue.rs` (the Rust port of the
     old `tests/test_hqvehicles.py`) honour it.
   - The 11 cars, one per team, in slots 1-11:

     | Team | Car |
     |---|---|
     | McLaren | MCL40 |
     | Ferrari | SF-26 |
     | Red Bull Racing | RB22 |
     | Mercedes-AMG | W17 |
     | Aston Martin | AMR26 |
     | Alpine | A526 |
     | Williams | FW48 |
     | Racing Bulls | VCARB 03 |
     | Haas | VF-26 |
     | Audi | R26 |
     | Cadillac | "F1 car (2026)" (a placeholder chassis name) |

   - Every car shares the 2026 spec: 1600 cc V6 turbo hybrid, about 750 kW, 768 kg, RWD, 345 km/h, 8 gears, sound
     `v6`, body `formula`.
   - Dimensions: 5.3 x 1.9 x 0.95 m, with a 3.4 m wheelbase.
   - Each car has 4 paints, plus a `livery` `{base, accent, trim}`: the team's colours, which the models paint on.
   - Real team names, as the catalogue already uses real makers. The names live only in the catalogue (a data
     change renames them). There are no logos, sponsor marks or driver names; the scene's sponsor banners stay the
     game's own made-up ones.
4. **Drivable everywhere.**
   - In the City, an F1 car is an ordinary catalogue car: the dealership, the garage, calling it, and the street
     physics (capped at the city's 300 km/h like every car).
   - At the circuit it uses its full spec (345 km/h, downforce).

## 2. Circuits as stages (`games/gp/circuit.js`, `HQV.gpCircuit`, pure)

```text
HQV.gpCircuit = {
  URL: "/games/gp/circuits.json",
  load() -> Promise<doc>                       fetched once (like hqVehicles.load)
  list(doc) -> [{id, name, location, lengthM, round}]   the calendar in round order, then the classics by name
  build(circuit, opts) -> stage                the rally stage shape, closed, plus the lap fields below
  carSpec(vehicle) -> physics spec             a rallyPhysics spec from a catalogue F1 car
}
```

- **The centre line.** A closed centripetal Catmull-Rom through `pts`, resampled every 2 m, with `s`, `h`, `k` and
  `bank` (0: circuits are flat) as `rallyStage` has them.
  - Heights come from gentle seeded noise of at most ±3 m over the lap, grade limited. Spa and Interlagos get more;
    every other circuit is flat to within 1 m.
- **Width.** The road half-width is 6.0 m. Street circuits get 4.6 m (Monaco) or 5.2 m (Baku, Singapore, Jeddah,
  Las Vegas, Miami, Madrid). Kerbs are 1.2 m, painted red and white on the inside and outside of corners where
  |k| > 1/120. Beyond the kerbs:
  - run-off on the outside of fast corners is gravel;
  - everywhere else is grass;
  - a barrier line stands 14 m from the edge (6 m on street circuits). Barriers are `obstacles`, so you can hit a
    wall but not leave the world.
- **Laps.**
  - `stage.loop = true`.
  - `stage.lapLength` is the loop's length.
  - `stage.sectors = [s1, s2]` sit at 1/3 and 2/3 of the lap.
  - The start line is at s = 0.
  - `locate(x, z, hint)` wraps round the loop.
  - The grid is 8 boxes behind the line, two by two, 8 m apart.
  - `crossesLine(s0, s1)` tells a lap from a cut. A lap only counts after passing both sectors in order and staying
    within 20 m of the centre line. A cut of more than 4 s against the centre line invalidates the lap, which the
    HUD shows as such.
- **Scenery** in the rally scenery format:
  - grandstands and a pit building along the start straight;
  - an arch and gantry lights over the line;
  - trees outside the barrier line;
  - the game's own sponsor banners.
- **The F1 physics spec (`carSpec`).**
  - Mass 798 kg (with fuel). A low centre of mass. Very stiff springs.
  - `cla` about 4.0 (downforce rises with speed squared; about 2.5 g of cornering at 250 km/h). `cda` about 1.1.
  - An 8-speed gearbox, a 12,500 rpm limit, RWD with a locked rear differential, big brakes.
  - Tuned so that 0-100 km/h is within 15% of the catalogue's `zeroTo100s` and top speed within 5% of `topKmh` on
    Monza's straight.
  - Each team's car is the same spec (the grid is equal); only the livery differs.

## 3. The car model

- **At the circuit** (`games/rally/scene.js` `addCar(spec, {body: "formula", livery, number})`): a procedural
  open-wheel car.
  - Body: nose and front wing, the halo, sidepods, the engine cover with its fin, the rear wing, and exposed wheels
    with slick tyres.
  - Painted from the livery: base, accent stripes, trim.
  - Toon-shaded and inked like the rally cars, at most 6 draw calls.
- **In the City** (`games/hqvehiclemodels.js`, body `formula`): the same silhouette at the catalogue's dimensions,
  in the house's rounded-part builder, with the seat and pedal anchors for the rider. Its paint is the chosen paint;
  the livery accents are fixed. The City's physics (`games/hqvehiclephys.js`) derives a `formula` body as very
  grippy, with almost no roll or slip, a short brake and a low ride.
- **Engine voice `v6`** (games/engine.js): a turbo-hybrid V6 at up to 12,500 rpm with a high whine and little
  rumble.

## 4. The game (`games/gp.js`)

- **Menu.**
  - Circuit: the 2026 calendar ("Round 6 · Circuit de Monaco · Monaco · 3,337 m"), then Classics.
  - Car: the 11 teams, as livery swatches with the team name.
  - Laps: 1, 3 or 5. Default 3.
  - Your best lap per circuit.
- **Time trial.**
  - A rolling start: you start on the grid box and the clock runs from the line.
  - The HUD shows lap n/N, the lap time, the delta to your best, sector times (purple for a best, green for a
    personal improvement), speed, gear and rpm, and a minimap of the circuit (a 2D canvas).
  - Your best lap's ghost drives beside you.
  - The save is `api.save.gp`: `{best: {circuitId: ms}, sectors: {circuitId: [ms, ms, ms]}, ghosts: {circuitId: …},
    opts}`. Ghosts are sampled at 10 Hz and capped like rally's.
- **Calm** slows nothing that matters to timing, but turns off camera shake and particles. Reduced motion does the
  same.
- **Hooks.**
  - `HQV.gpLaunch({circuit, vehicle})` opens the game with that circuit and car preselected. `vehicle` is a
    catalogue id, used when it is a formula car.
  - `V.startSolo`, `V.autopilot` and `V.debug` are for tests, as in rally.
- **No network.** Grand Prix is solo; nothing leaves the machine. Arena lap boards are a follow-up: they need an
  Arena referee like rally's.

## 5. The City venue

- A **Grand Prix Circuit** pavilion in the City: a grandstand and a pit garage with a gantry and a chequered arch.
  It is placed client side like the dealership (`HQV.hqDealer.place`): a deterministic `building` lot, a `gp:0`
  site, Go to (N) "Grand Prix Circuit" 🏁, and a minimap marker. E at its door opens a small panel:
  - the circuit list;
  - "Drive your F1 car", when you own one or are driving one; else the car picker;
  - "Go".
- Go opens the Valley Grand Prix through `api.grandPrix({circuit, vehicle})` (ui/app/22-hq.js). That sets the
  Valley view and, once the Valley has loaded, calls `HQV.gpLaunch`.
- Leaving the game brings you back to the Valley home. The City is where you left it.

## 6. Checks

- `dashboard-rs/src/gp.rs` tests:
  - the converter;
  - the committed circuits: 40 loops, lengths, gaps and rounds;
  - the grid in the catalogue;
  - the byte copy in backend/data.
- `dashboard-rs/tests/catalogue.rs`: the whole catalogue, and the loader under node.
- `dashboard-rs/tests/gp_js.rs`, under node:
  - every circuit builds a closed stage whose `locate` wraps;
  - the grid boxes are on the road;
  - the autopilot laps Monaco and Monza with valid laps, and Monza's top speed is within 5% of 345 km/h;
  - the F1 car's 0-100 km/h is within 15%;
  - the City's `formula` body builds;
  - `derive` of an F1 spec stays under the city cap.
- `backend/src/vehicles.rs`: a class's `slots` lists past 4, and the real grid of 11 is on sale.
- `dashboard-rs/tests/http.rs`: `gp/` serves its scripts and circuits.json, never its licence text or anything
  deeper.
