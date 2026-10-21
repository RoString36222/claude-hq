# Vehicle classes and the dealership (HQ 3.2)

The contract for real cars and bikes in the 3D City: a class system, a catalogue of real
vehicles, spec-driven handling, ownership on the Arena, a dealership in every city, and calling
an owned vehicle to you. The Cities and navigation specs still hold.

## Product (owner's ask, 2026-10-21)

- Real cars and bikes, by real makers, chosen from each player's preferences. Brands are added
  as players add theirs.
- Vehicles are grouped into **classes** by engine size (cc) and body type: naked, sport,
  adventure and so on for bikes; hatchback, sedan, SUV and so on for cars.
- **Every class offers exactly 2 vehicles.** A class whose two slots aren't filled yet isn't
  sold until they are.
- A dealership to browse, test-drive and buy them; owned vehicles can be called to you.

## Classes

A class id is `<kind>.<type>.<band>`, e.g. `bike.naked.middle`, `car.suv.l3`. The band comes
from the engine's displacement (and, for an electric drivetrain, its own band).

### Bike bands (displacement)

| band | cc | why this cut |
|---|---|---|
| `small` | up to 400 cc | the entry class: 300-400 cc singles and twins (A2 licence territory) |
| `middle` | 401-950 cc | the twins and triples between the small bikes and the litre bikes |
| `big` | over 950 cc | litre bikes and up |

### Bike types

`naked` (no fairing, upright), `sport` (full fairing, tucked), `adventure` (long travel, tall,
on and off road), `cruiser`, `scooter`, `dirt` (off road only).

### Car bands (displacement)

| band | litres | electric |
|---|---|---|
| `l2` | up to 2.0 L | |
| `l3` | 2.1-3.0 L | |
| `l5` | 3.1-5.0 L | |
| `l8` | over 5.0 L | |
| `ev` | | any battery-electric car |

A plug-in hybrid is banded by its engine (the BMW M5 is `l5`).

### Car types

`hatch`, `sedan`, `coupe`, `suv`, `pickup`, `hyper` (hypercars: always `l8` or `ev`).

### Rules

- A class exists when at least one vehicle in the catalogue belongs to it. It **is on sale**
  only with exactly 2 vehicles. A third candidate waits as a `reserve` until a slot is free.
- Class tier sets the price band, and the tier you need to buy (see Economy). Tiers:
  bikes `small` 1, `middle` 2, `big` 3; cars `l2` 1, `l3` 2, `l5` 3, `l8` 4, `ev` by power
  (under 300 kW 2, under 500 kW 3, else 4), `hyper` always 5.

## The class grid, from the first player's picks (BMW and Bugatti cars, BMW and KTM Duke bikes)

Specs are approximate maker figures, to be checked when each vehicle is built.
"open" is a slot for the next players' brands.

### Bikes

| class | slot 1 | slot 2 |
|---|---|---|
| `bike.naked.small` | KTM 390 Duke: 399 cc single, 45 PS, ~165 kg, ~170 km/h | BMW G 310 R: 313 cc single, 34 PS, ~164 kg, ~145 km/h |
| `bike.naked.middle` | KTM 990 Duke: 947 cc twin, 123 PS, ~179 kg, ~230 km/h | BMW F 900 R: 895 cc twin, 105 PS, ~211 kg, ~225 km/h |
| `bike.naked.big` | KTM 1390 Super Duke R: 1350 cc V-twin, 190 PS, ~200 kg, ~290 km/h | BMW S 1000 R: 999 cc four, 165 PS, ~199 kg, ~250 km/h |
| `bike.sport.small` | BMW G 310 RR: 313 cc single, 34 PS, ~174 kg, ~160 km/h | open (KTM RC 390 fits; KTM is a picked brand, the RC is not a Duke) |
| `bike.sport.big` | BMW S 1000 RR: 999 cc four, 210 PS, ~197 kg, ~300 km/h | BMW M 1000 RR: 999 cc four, 212 PS, ~192 kg, ~306 km/h |
| `bike.adventure.small` | BMW G 310 GS: 313 cc single, 34 PS, ~175 kg, ~145 km/h | open (KTM 390 Adventure fits) |
| `bike.adventure.big` | BMW R 1300 GS: 1300 cc boxer, 145 PS, ~237 kg, ~220 km/h | open (KTM 1390 Super Adventure fits) |

The Duke line fills every naked band; BMW fills the rest. Today's motorbike stays as the free
starter, outside the classes.

### Cars

| class | slot 1 | slot 2 |
|---|---|---|
| `car.hatch.l2` | BMW M135 xDrive: 2.0 L turbo four, 300 PS, ~1.6 t, AWD, 250 km/h | open |
| `car.sedan.l2` | BMW 330Li: 2.0 L turbo four, 258 PS, ~1.7 t, RWD, 250 km/h | open |
| `car.sedan.l3` | BMW M3 Competition (G80): 3.0 L twin-turbo six, 510 PS, ~1.7 t, RWD, 290 km/h | BMW M340i: 3.0 L turbo six, 374 PS, ~1.7 t, AWD, 250 km/h |
| `car.sedan.l5` | BMW M5 (G90): 4.4 L twin-turbo V8 plug-in hybrid, 727 PS, ~2.4 t, AWD, 305 km/h | open |
| `car.coupe.l3` | BMW M2 (G87): 3.0 L twin-turbo six, 480 PS, ~1.7 t, RWD, 285 km/h | BMW M4 CSL: 3.0 L twin-turbo six, 550 PS, ~1.6 t, RWD, 307 km/h |
| `car.suv.l3` | BMW X5 xDrive40i: 3.0 L turbo six, 381 PS, ~2.2 t, AWD, 250 km/h | BMW X3 M50: 3.0 L turbo six, 398 PS, ~2.0 t, AWD, 250 km/h |
| `car.suv.l5` | BMW X5 M Competition: 4.4 L twin-turbo V8, 625 PS, ~2.4 t, AWD, 290 km/h | BMW XM: 4.4 L twin-turbo V8 plug-in hybrid, 653 PS, ~2.7 t, AWD, 270 km/h |
| `car.hyper.l8` | Bugatti Chiron Super Sport: 8.0 L quad-turbo W16, 1600 PS, ~2.0 t, AWD, 440 km/h | Bugatti Tourbillon: 8.3 L V16 hybrid, 1800 PS, ~2.0 t, AWD, 445 km/h |
| `car.sedan.ev` | BMW i4 M50: two motors, 544 PS, ~2.3 t, AWD, 225 km/h | BMW i7 M70: two motors, 660 PS, ~2.7 t, AWD, 250 km/h |

Reserve: Bugatti Veyron 16.4 (8.0 L W16, 1001 PS, 407 km/h), waiting for a third hyper slot or
a `car.hyper.l8` swap. Today's hatchback stays as the free starter.

**Status after player 1:** 10 classes on sale (both slots filled), 6 with one open slot.

## The catalogue (`games/hqvehicles.json`, data only)

```text
{ "classes": [{ "id": "bike.naked.small", "kind": "bike", "type": "naked", "band": "small",
                "label": "Naked · up to 400 cc", "tier": 1 }],
  "vehicles": [{
    "id": "ktm-390-duke",                     // [a-z0-9-], stable forever (owned vehicles point at it)
    "class": "bike.naked.small", "slot": 1,   // slot 1 | 2 | "reserve"
    "brand": "KTM", "model": "390 Duke", "year": 2024,
    "pickedBy": ["<user id>"],                // whose preference brought it in
    "spec": { "cc": 399, "cyl": 1, "layout": "single", "aspiration": "na", "electric": false,
              "powerKw": 33, "torqueNm": 39, "massKg": 165, "drive": "rwd" | "fwd" | "awd",
              "topKmh": 170, "zeroTo100s": null, "gears": 6 },
    "price": 1200,                            // coins (see Economy)
    "paints": ["#ff6a00", "#1b1b1b", "#f2f2f2"],
    "model3d": { "file": "vehicles/ktm-390-duke.glb", "licence": "CC-BY-4.0",
                 "author": "...", "source": "https://...", "lengthM": 2.0 },
    "sound": "single" }]}                    // a voice of games/engine.js (below)
```

- `tests/test_hqvehicles.py` checks it: ids unique and stable, every vehicle's class exists,
  the band matches `cc`/`electric`, at most 2 slots per class (slots 1 and 2, no duplicates),
  every on-sale vehicle has a model with a licence, author and source, specs in sane ranges.
- Names live only here, so renaming a model (for example to parody names, if the game is ever
  distributed publicly) is a data change.

## Handling from the specs (`games/hqvehiclephys.js`, pure, node-tested)

Today's `VEHICLES` entries in games/hq3d.js are hand-tuned numbers (`top`, `acc`, `gears`,
`lean`, `box`). They become derived:

```text
HQV.hqVehiclePhys = {
  derive(spec, kind) -> V    // the same shape games/hq3d.js VEHICLES uses, plus:
                             // drive, mass, grip, slip (rear-slide tendency), roll, brake
}
```

- `top` = `topKmh`/3.6, capped at the game cap for the class (city streets are short: cars cap
  at 300 km/h, bikes at 280 km/h; Bugatti keeps its lead by acceleration and the highway).
- `acc` from power-to-weight (kW/t), shaped so 0-100 km/h lands within 15% of the maker figure
  when one is given.
- Gear ratios spread over `gears` to `top`; electric drivetrains get one gear and full torque
  from standstill.
- `drive`: RWD raises `slip` (powerslides, as today's Shift + steer), AWD lowers it and adds
  launch grip, FWD understeers. Mass and an SUV or pickup body add body roll and longer braking.
- Bikes: `lean` from type (sport most, adventure and cruiser least); adventure and dirt bikes
  keep their speed on grass and gravel; sport bikes lose it there.
- The two starters keep today's feel: `derive` of their spec reproduces today's numbers within 10%.

**Engine voices** (games/engine.js): `single`, `twin`, `vtwin`, `boxer`, `four`, `six`, `v8`,
`w16`, `v16`, `electric` (a whine that rises with speed, no gears). Each is the existing synth
with its own firing pattern and filter, so no audio files.

## Models (`games/vehicles/*.glb`)

- Source: low-poly models of each real vehicle under a licence that allows use (CC0 or CC-BY
  preferred), credited in the catalogue and on an in-game credits card. No ripped game assets.
- Budget per vehicle: under 15k triangles, at most 3 materials (body paint, trim, glass) plus
  wheels. The body material is recoloured by the chosen paint. Draco or meshopt compressed,
  under 400 KB.
- `tools/vehicle_import.py` normalises each one: scale to `lengthM`, forward +z, wheels found
  and named (so they spin and steer), origin at the ground under the centre.
- Loaded lazily: a vehicle's model loads the first time it is seen, and a placeholder box with
  the right size and paint stands in meanwhile. A test checks the placeholder fits the model.

## Ownership and economy (Arena, Rust)

```text
migration 0016_vehicles.sql
  owned_vehicles(id, user_id, vehicle_id, paint, bought_at,
                 parked_world, parked_x, parked_z, parked_yaw)   -- where you left it

GET  /v1/vehicles/mine                   -> [{id, vehicle_id, paint, parked}]
POST /v1/vehicles/buy {vehicle_id, paint} -> 200 {id} | 402 not enough coins | 403 tier too low
POST /v1/vehicles/:id/park {world, x, z, yaw}
```

- The Arena keeps its own copy of the catalogue's ids, classes, tiers and prices
  (`backend/data/vehicles.json`, a byte copy checked by tests/test_game_data_sync.py, as the
  game data already is). The server sets the price, never the client.
- Paid in Poke Coins. Class price bands: tier 1 800-1500, 2 2500-5000, 3 8000-15000,
  4 25000-40000, 5 (hypercars) 100000+. To be tuned against what players actually earn.
- **Buying needs the class tier:** your level. To be confirmed: player level, or your island's
  city tier.
- Presence: the vehicle you're driving travels as its catalogue id and paint (a new optional
  field), so other players see the real car. Older clients fall back to today's car or motorbike.
- Dashboard proxies `/api/arena/vehicles/*` send only the validated vehicle id, paint and
  coordinates, with the device token.

## The dealership (games/hqdealer.js)

- A `dealer` site in every city from tier 2 (the Commons has a flagship one). Glass showroom,
  with the city's on-sale vehicles on turntables inside, one bay per class, and a forecourt. Its
  door opens the dealer panel (E).
- **Panel:** classes as tabs (Bikes / Cars, then type and band), the two vehicles of each class
  side by side with their real specs, price, paint swatches and a turning 3D preview. Locked
  classes show the tier they need. textContent only.
- **Test drive:** 3 minutes in the vehicle from the forecourt, then it drives itself back.
- **Buy:** pick the paint, pay; the vehicle waits on the forecourt and joins your garage.

## Calling your vehicle (games/hqcall.js)

- **C** (or the garage menu) lists your owned vehicles. Pick one, and it comes to you.
- If it's parked within 1.5 km of you in this world, it **drives itself** to the nearest road
  point next to you along games/hqnav.js's road route, as traffic does (stopping at junctions,
  avoiding cars). Hazard lights on; a pin and an ETA on the minimap.
- If it's farther, in another world, or no road reaches you, it **arrives from just out of
  sight**: it appears on the road behind the nearest corner and drives the last stretch.
- It parks by the kerb beside you and unlocks. A bike or car you leave stays where you left it
  (saved through `/park`); T (Return to HQ) still puts everything back in the garage.
- One vehicle on its way at a time; calling again redirects it.

## Build order

1. Catalogue + classes + `test_hqvehicles.py`, and `hqVehiclePhys.derive`. The starters
   reproduce today's feel. (No models needed.)
2. Engine voices.
3. Arena: ownership tables, buy and park, presence field; dashboard proxies.
4. Models for the 10 full classes, one brand at a time (BMW bikes, KTM Duke, BMW cars, Bugatti).
5. Dealership: the site, building, panel and test drive.
6. Calling your vehicle.
7. Fill open slots as players add brands.

## Open questions

1. Buying gate: player level, or island city tier?
2. Prices: are the coin bands right for what players earn?
3. Models: check licences per model before importing; any brand with no usable model waits.
4. The open slots: fill them from the next players' brands, or with BMW and KTM models in the
   meantime (KTM RC 390, KTM 390 Adventure, KTM 1390 Super Adventure)?

## Checks

- tests/test_hqvehicles.py (the catalogue), tests/test_hqvehiclephys.py (derived handling and
  the starters' feel), engine voice tests, Rust tests for buy/park (price from the server, coins
  and tier checked, other users' vehicles untouchable).
- Headless (tools/ui_smoke.py, HQ_GL=metal): the dealership and its panel, a test drive, a
  purchase, calling a vehicle from 300 m (it drives there along the road) and from another
  world (it arrives from out of sight), a second client seeing the real model.
