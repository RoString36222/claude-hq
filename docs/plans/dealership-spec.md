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

A class id is `<kind>.<type>.<band>`, e.g. `bike.naked.950`, `car.suv.3000`. The band is the
engine's displacement in cc, for bikes and cars alike (an electric drivetrain has its own band).
Class labels say it the same way: "Naked · up to 400 cc", "SUV · 2001-3000 cc".

### Bike bands (cc)

| band | cc | why this cut |
|---|---|---|
| `400` | up to 400 cc | the entry class: 300-400 cc singles and twins (A2 licence territory) |
| `950` | 401-950 cc | the twins and triples between the entry bikes and the litre bikes |
| `over950` | over 950 cc | litre bikes and up |

### Bike types

`naked` (no fairing, upright), `sport` (full fairing, tucked), `adventure` (long travel, tall,
on and off road), `cruiser`, `scooter`, `dirt` (off road only).

### Car bands (cc)

| band | cc |
|---|---|
| `2000` | up to 2000 cc |
| `3000` | 2001-3000 cc |
| `5000` | 3001-5000 cc |
| `over5000` | over 5000 cc |
| `ev` | battery-electric (no engine): banded on its own |

A plug-in hybrid is banded by its engine's cc (the BMW M5's 4395 cc V8 is `5000`).

### Car types

`hatch`, `sedan`, `coupe`, `suv`, `pickup`, `hyper` (hypercars: always `over5000` or `ev`).

### Rules

- A class exists when at least one vehicle in the catalogue belongs to it. It **is on sale**
  only with exactly 2 vehicles. A third candidate waits as a `reserve` until a slot is free.
- Class tier sets the price band, and the tier you need to buy (see Economy). Tiers:
  bikes `400` 1, `950` 2, `over950` 3; cars `2000` 1, `3000` 2, `5000` 3, `over5000` 4, `ev` by power
  (under 300 kW 2, under 500 kW 3, else 4), `hyper` always 5.

## The class grid, from the first player's picks (BMW and Bugatti cars, BMW and KTM Duke bikes)

Specs are approximate maker figures, to be checked when each vehicle is built.
"open" is a slot for the next players' brands.

### Bikes

| class | slot 1 | slot 2 |
|---|---|---|
| `bike.naked.400` | KTM 390 Duke: 399 cc single, 45 PS, ~165 kg, ~170 km/h | BMW G 310 R: 313 cc single, 34 PS, ~164 kg, ~145 km/h |
| `bike.naked.950` | KTM 990 Duke: 947 cc twin, 123 PS, ~179 kg, ~230 km/h | BMW F 900 R: 895 cc twin, 105 PS, ~211 kg, ~225 km/h |
| `bike.naked.over950` | KTM 1390 Super Duke R: 1350 cc V-twin, 190 PS, ~200 kg, ~290 km/h | BMW S 1000 R: 999 cc four, 165 PS, ~199 kg, ~250 km/h |
| `bike.sport.400` | BMW G 310 RR: 313 cc single, 34 PS, ~174 kg, ~160 km/h | KTM RC 390: 373 cc single, 43 PS, ~172 kg, ~170 km/h (KTM is a picked brand; the RC is not a Duke) |
| `bike.sport.over950` | BMW S 1000 RR: 999 cc four, 210 PS, ~197 kg, ~300 km/h | BMW M 1000 RR: 999 cc four, 212 PS, ~192 kg, ~306 km/h |
| `bike.adventure.400` | BMW G 310 GS: 313 cc single, 34 PS, ~175 kg, ~145 km/h | KTM 390 Adventure: 399 cc single, 45 PS, ~182 kg, ~165 km/h |
| `bike.adventure.over950` | BMW R 1300 GS: 1300 cc boxer, 145 PS, ~237 kg, ~220 km/h | KTM 1390 Super Adventure S Evo: 1350 cc V-twin, 173 PS, ~238 kg, ~240 km/h |

The Duke line fills every naked band; BMW fills the rest. Today's motorbike stays as the free
starter, outside the classes.

### Cars

| class | slot 1 | slot 2 |
|---|---|---|
| `car.hatch.2000` | BMW M135 xDrive: 1998 cc turbo four, 300 PS, ~1.6 t, AWD, 250 km/h | open |
| `car.sedan.2000` | BMW 330Li: 1998 cc turbo four, 258 PS, ~1.7 t, RWD, 250 km/h | open |
| `car.sedan.3000` | BMW M3 Competition (G80): 2993 cc twin-turbo six, 510 PS, ~1.7 t, RWD, 290 km/h | BMW M340i: 2998 cc turbo six, 374 PS, ~1.7 t, AWD, 250 km/h |
| `car.sedan.5000` | BMW M5 (G90): 4395 cc twin-turbo V8 plug-in hybrid, 727 PS, ~2.4 t, AWD, 305 km/h | open |
| `car.coupe.3000` | BMW M2 (G87): 2993 cc twin-turbo six, 480 PS, ~1.7 t, RWD, 285 km/h | BMW M4 CSL: 2993 cc twin-turbo six, 550 PS, ~1.6 t, RWD, 307 km/h |
| `car.suv.3000` | BMW X5 xDrive40i: 2998 cc turbo six, 381 PS, ~2.2 t, AWD, 250 km/h | BMW X3 M50: 2998 cc turbo six, 398 PS, ~2.0 t, AWD, 250 km/h |
| `car.suv.5000` | BMW X5 M Competition: 4395 cc twin-turbo V8, 625 PS, ~2.4 t, AWD, 290 km/h | BMW XM: 4395 cc twin-turbo V8 plug-in hybrid, 653 PS, ~2.7 t, AWD, 270 km/h |
| `car.hyper.over5000` | Bugatti Chiron Super Sport: 7993 cc quad-turbo W16, 1600 PS, ~2.0 t, AWD, 440 km/h | Bugatti Tourbillon: 8355 cc V16 hybrid, 1800 PS, ~2.0 t, AWD, 445 km/h |
| `car.sedan.ev` | BMW i4 M50: two motors, 544 PS, ~2.3 t, AWD, 225 km/h | BMW i7 M70: two motors, 660 PS, ~2.7 t, AWD, 250 km/h |

Reserve: Bugatti Veyron 16.4 (7993 cc W16, 1001 PS, 407 km/h), waiting for a third hyper slot or
a `car.hyper.over5000` swap. Today's hatchback stays as the free starter.

**Status after player 1:** 13 classes on sale (both slots filled; the three KTM bikes above fill
the bike classes' second slots), 3 car classes with one open slot (`car.hatch.2000`, `car.sedan.2000`,
`car.sedan.5000`). The catalogue is `games/vehicles/catalogue.json`.

## The catalogue (`games/vehicles/catalogue.json`, data only)

It sits in `games/vehicles/` (not `games/` itself) because the dashboard serves data and models only
from a game's own folder (dashboard-rs `GAME_ASSET_RE`, which lists `vehicles/` for `.json` and `.glb`).
`games/hqvehicles.js` (`HQV.hqVehicles`) loads it and has the pure helpers:
`load()`, `bandOf(kind, cc, electric)`, `classes(cat)`, `byClass(cat, classId)`, `onSale(cat)`, `get(cat, id)`.

```text
{ "version": 1,
  "classes": [{ "id": "bike.naked.400", "kind": "bike", "type": "naked", "band": "400",
                "label": "Naked · up to 400 cc", "tier": 1 },
              { "id": "starter", "kind": "any", "type": "starter", "band": "starter", "tier": 0, ... }],
  "vehicles": [{
    "id": "ktm-390-duke",                    // [a-z0-9-], at most 48, stable forever (owned vehicles point at it)
    "class": "bike.naked.400",
    "slot": 1,                               // 1 | 2 | "reserve" | "starter" (the free starters only)
    "brand": "KTM", "model": "390 Duke", "year": 2024,
    "pickedBy": ["owner"],                   // whose preference brought it in ("owner": the first player)
    "spec": { "cc": 399,                     // 0 for an electric drivetrain
              "cyl": 1,                      // 0 for electric
              "layout": "single",            // single | parallel-twin | v-twin | boxer-twin | inline-3 | inline-4 |
                                             // inline-6 | v8 | w16 | v16 | electric
              "aspiration": "na",            // na | turbo | twin-turbo | quad-turbo | electric
              "electric": false, "hybrid": false,
              "powerKw": 33, "torqueNm": 39, // torqueNm may be null (not published)
              "massKg": 171,                 // kerb / ready-to-ride
              "drive": "rwd",                // rwd | fwd | awd (bikes: always rwd)
              "topKmh": 170, "zeroTo100s": null, "gears": 6 },   // electric: 1 gear
    "dims": { "lengthM": 2.0, "widthM": 0.85, "heightM": 1.1, "wheelbaseM": 1.357 },
    "body": "naked",                         // the stand-in model's shape: the class type (hatch | sedan |
                                             // coupe | suv | hyper; naked | sport | adventure ...)
    "price": 1000,                           // coins, inside the class tier's band (see Economy)
    "paints": [{ "name": "Electronic Orange", "hex": "#ff5a00" }, ...],   // 4-6 real factory colours
    "model3d": null,                         // or { "file": "vehicles/<id>.glb", "licence", "author",
                                             //      "source": "https://...", "lengthM" } once fetched
    "sound": "single",                       // a games/engine.js voice: single | twin | vtwin | boxer | four |
                                             // six | v8 | w16 | v16 | electric
    "note": "..." }]}                        // optional: why it is here, what is approximate
```

- The two **starters** (`starter-car`, `starter-moto`: today's hatchback and motorbike) are in class
  `starter` (tier 0, price 0, never on sale): their specs reproduce hq3d.js `VEHICLES.car` / `.moto`.
- `tests/test_hqvehicles.py` checks it: class ids match kind/type/band and labels give the band in cc;
  ids unique and stable in form; each vehicle's class exists and its band matches `cc`/`electric`;
  `body` is the class type; at most 2 slot vehicles per class, no slot taken twice, slot 1 before 2;
  specs, dimensions and paints (hex) in sane ranges; prices inside the tier band; a `model3d` carries
  its licence, author and https source; and the loader's helpers under node.
- Names live only here, so renaming a model (for example to parody names, if the game is ever
  distributed publicly) is a data change.

### Adding a vehicle

1. Add one entry to `vehicles` in `games/vehicles/catalogue.json` (one object per line), with the
   maker's specs and dimensions, 4-6 factory paints, `model3d: null`, and `pickedBy` the player who
   asked for it. Its class is `<kind>.<type>.<bandOf(cc)>`: if that class is not in `classes` yet,
   add it too (label "Type · band in cc", tier from the band).
2. Slot: `1` or `2` if the class has room, else `"reserve"`.
3. `python3 -m unittest tests.test_hqvehicles`. Nothing else changes: the dealership and the physics
   read the catalogue.

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

## Models (`games/vehicles/<id>.glb`)

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
  (`backend/data/vehicles.json`, a byte copy of `games/vehicles/catalogue.json` checked by tests/test_game_data_sync.py, as the
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

## The vehicle garage (games/hqcarpark.js)

Every owned vehicle lives in a multi-storey garage: you call it out of there, and it goes back there.

- **One per city.** A generator site, civic kind `carpark` (backend/src/worldgen/civic.rs), the LAST row of
  the civic table, so it takes what the services left: 50 x 36 m on a lot by an arterial downtown (else
  commercial, the old town, civic; else any district), shrunk to 3/4 or 1/2 where nothing bigger fits. It is
  tier 1 (on an island the ring rule can make it 2), so every island has one from the start: your fleet is
  called from it. A city with no lot for it simply has none (it never fails the world). claude-hq@1 is
  unchanged; claude-hq@2 is re-pinned (CLAUDE_HQ_2) and the fixtures regenerated.
- **Levels:** 6 on the Commons (the biggest), 3 on an island (`find(W)` sets `levels` from the world id, so every
  client and every caller agrees). 3.2 m a level; the top one is an open roof deck.
- **The building, in the site's frame (+z its front):** a helix ramp tower at one end (one turn per level, a
  6 m lane round a core; narrower in a small garage, a 1.6 m core at least) and the deck beside it: a cross
  aisle along the tower, then aisles along the building with a row of 2.7 x 5.4 m bays either side. The helix
  meets every level on the deck's side through an opening in the tower's wall; the ground floor opens to the
  street at the front, at the cross aisle. Open sides with parapets and blue cladding, columns, white bay lines,
  ceiling lights that come on at night, lamp posts on the roof, a "P GARAGE" sign on the front, the crown of
  the tower and over the door. The Commons' holds 192 bays, the fixture island's 18.
- **Your fleet is in whichever city's garage you are in.** Each owned vehicle has its own bay:
  `assign(site, keys)` with key `<owner id>:<owned vehicle id>`: its hash picks a bay, a taken bay passes to the
  next free one, keys placed in hash order, so the same set of keys gives the same bays on every client. For now
  the fleet drawn is your own (`HQV.hqGarage.mine()`, without the ones parked out in the streets; before that
  exists, the Showroom's pick); other players' vehicles join once ownership is in presence.
- **Drawing:** the building is merged per material (under 12 draw calls); parked vehicles are instances of a
  car and a bike silhouette in their paint (two draw calls for the whole fleet) and the one nearest the camera
  (within 16 m) is its full model.
- **Driving in it:** `groundAt(site, x, z, y)` is the floor or the turn of the helix nearest your height, and
  `blockedAt(site, x, z, y)` the walls, the core, the tower's corners and the columns at your height; the City
  keeps your height in the garage (`cp.y`) for the queries round you, so you can drive up the helix and park on
  the roof.
- **Paths** (world m, with y): `exitPath(bay)` from the bay out to its aisle, along to the cross aisle, onto the
  helix and down to the ground, out of the front door to `entrance(site, G)` (the kerb in front of the door;
  with a road graph, its nearest road point); `entryPath(bay)` is the same backwards. Only ever down on the way
  out, no steeper than 15%, clear of every wall (tests/test_hqcarpark.py drives every level's).
- Go to (N) lists it ("Garage", 🅿️) and the minimap shows a blue P.

```text
HQV.hqCarpark = {find(W), layout(site), bays(site), assign(site, keys), exitPath(bay), entryPath(bay),
                 entrance(site, G?), groundAt(site, x, z, y), blockedAt(site, x, z, y), build(c, site, opts)}
```

## Calling your vehicle (games/hqcall.js)

- **C** (or the garage menu) lists your owned vehicles. Pick one, and it comes to you **from the garage**: it
  backs out of its bay, follows `exitPath(bay)` down the helix and out of the door, then drives along the roads
  (games/hqnav.js's route from `entrance(site, G)` to the nearest road point beside you), as traffic does
  (stopping at junctions, avoiding cars). Hazard lights on; a pin and an ETA on the minimap.
- If the garage is in another world, or no road reaches you, it **arrives from just out of sight**: it appears
  on the road behind the nearest corner and drives the last stretch.
- It parks by the kerb beside you and unlocks.
- **When you leave it**, it waits about 5 s, then drives itself back: along the roads to `entrance(site, G)`,
  then `entryPath(bay)` up the helix into its bay. Getting back in before it has gone (or while it is on its
  way) keeps it with you. T (Return to HQ) sends everything home as well.
- **A newly claimed vehicle** is delivered into your bay in the garage (the dealership's forecourt is only for
  the test drive).
- One vehicle on its way at a time; calling again redirects it.

## Build order

1. Catalogue + classes + `test_hqvehicles.py`, and `hqVehiclePhys.derive`. The starters
   reproduce today's feel. (No models needed.)
2. Engine voices.
3. Arena: ownership tables, buy and park, presence field; dashboard proxies.
4. Models for the 10 full classes, one brand at a time (BMW bikes, KTM Duke, BMW cars, Bugatti).
5. Dealership: the site, building, panel and test drive.
6. The vehicle garage (the `carpark` site, the building, bays, paths), then calling your vehicle out of it
   and its drive back.
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
