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
on and off road), `cruiser` (low seat, feet forward, wide bars), `classic` (a retro roadster, sat upright),
`hypersport` (the long, fast faired bikes: the H2, the Hayabusa), `scooter`, `dirt` (off road only).

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

`hatch`, `sedan`, `coupe`, `suv`, `pickup`, `super` (mid-engined supercars, banded by cc like the rest; 3.9),
`hyper` (hypercars: always `over5000` or `ev`).

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

### Added in 3.9 (Lamborghini, new bikes)

| class | slot 1 | slot 2 |
|---|---|---|
| `car.super.5000` | Lamborghini Temerario: 3995 cc twin-turbo V8 hybrid, 920 CV | Lamborghini Countach LP400 (1974): 3929 cc V12, 375 CV |
| `car.super.over5000` | Lamborghini Revuelto: 6498 cc V12 hybrid, 1015 CV | Lamborghini Huracán STO: 5204 cc V10, 640 CV |
| `bike.hypersport.over950` | Kawasaki Ninja H2: 998 cc supercharged four, 231 PS | Suzuki Hayabusa: 1340 cc four, 190 PS |
| `bike.classic.400` | Royal Enfield Classic 350: 349 cc single | open |
| `bike.classic.950` | Royal Enfield Interceptor 650: 648 cc twin | open |
| `bike.cruiser.over950` | Harley-Davidson Fat Boy 114: 1868 cc 45° V-twin | open |

Reserves: Lamborghini Urus Performante (`car.suv.5000`), Ducati Panigale V4 S and Yamaha R1
(`bike.sport.over950`), Triumph Street Triple 765 RS (`bike.naked.950`).

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

**Free for all for now:** every vehicle's `price` and every class's `minLevel` is 0 in the
catalogue, so buying is claiming. Prices and level gates are data: set them in the catalogue and
the server's checks apply unchanged (backend/src/vehicles.rs tests them on fixture data).

```text
migration 0017_vehicles.sql
  owned_vehicles(id, user_id, vehicle_id, paint, price, bought_at,
                 parked_world, parked_x, parked_z, parked_yaw)   -- parked_* NULL: in its garage

GET  /v1/vehicles/mine -> {vehicles: [{id, vehicle_id, paint, bought_at, parked: {world, x, z, yaw} | null}], max}
POST /v1/vehicles/buy {vehicle_id, paint} -> 200 {ok, vehicle, coins}
       | 404 unknown | 409 not on sale (a starter, a reserve, a class missing a slot) or garage full
       | 403 below the class's minLevel | 402 not enough Poke Coins | 422 a bad body or paint
POST /v1/vehicles/:id/park {world, x, z, yaw} | {garage: true} -> 200 {ok} | 404 not yours
```

- **Owned vehicles live in their city's multi-storey garage** and drive themselves back there when
  their owner leaves them. `parked` is null in the garage (the normal state) and set only for a
  vehicle out on a trip; `{garage: true}` puts it back.
- The Arena keeps its own copy of the catalogue (`backend/data/vehicles.json`, a byte copy of
  `games/vehicles/catalogue.json` checked by tests/test_game_data_sync.py) and reads ids, slots,
  prices, paints and each class's `minLevel` from it. The server sets the price, never the client.
- **Level gate:** a class's `minLevel` (catalogue, per class) against the player's HQ level (session
  + game XP, `cosmetics::hq_level`, the level on the Trainer card). The intended gates when they
  are switched on: tier 1 any, 2 L10, 3 L20, 4 L30, 5 (hypercars) L40. 0 = no gate.
- **Price:** Poke Coins from `poke_balances`, debited in the same `BEGIN IMMEDIATE` transaction as
  the `owned_vehicles` row, which records the price paid (`poke_ledger`'s op CHECK has no vehicle
  op). A price of 0 touches no balance. Price bands when set: tier 1 800-1500, 2 2500-5000,
  3 8000-15000, 4 25000-40000, 5 100000+.
- Several of the same vehicle may be owned (another paint); at most 20 vehicles per player.
- **Presence** (hq protocol v4, capability `vehicles`): while driving (a = 5 / 6) the page sends `v`,
  the catalogue id, and `vp`, the paint index. The Arena keeps them only for a known id and only
  while a is 5 or 6, and drops the whole frame on a bad one. Others draw the real model in its paint
  (games/hq3d.js placePeers with hqVehicleModels); an older client, or an Arena without the
  capability, shows the starter car or motorbike.
- Dashboard proxies: `GET /api/arena/vehicles/mine`, `POST /api/arena/vehicles/buy` and
  `POST /api/arena/vehicles/<id>/park` send only a catalogue id, a paint index, an owned vehicle's
  id, a world id and coordinates, with the device token.
- Client: `games/hqgarage.js`, `HQV.hqGarage = {mine(), buy(id, paint), park(id, pose | null),
  cached(), onChange(fn)}`, the API the dealership and calling your vehicle use.
- **Follow-up:** an unmanned vehicle driving to or from the garage is drawn locally by its owner
  only. Others see a vehicle only while someone drives it.

## The dealership (games/hqdealer.js)

- **Where (decided):** one dealership in every city from tier 2; the Commons' is the **Flagship
  Dealership**. It is **not a generator site**: a new civic row would take a lot before the HQ pool
  is drawn, and the Commons' HQ lots go by rank (`commons_lot.lot_rank`), so every player's HQ could
  move, and every world would need re-pinning. Instead the client turns one of the world's
  `building` lots into the dealership (`HQV.hqDealer.place(W, tier)`, pure and idempotent, the same
  lot on every client): the lot that fits the most of the lineup (26 vehicles; more room counts for
  no more), then the district (commercial, downtown, office, finance, the old town, tech...), its
  door within 30 m of an arterial, and about 300 m from the plaza. The lot's `kind` becomes
  `dealer` (worldbuild draws no building there, the building index skips it) and a `dealer:0` site
  (`kind: "dealer"`, `tier: 2`, the lot's footprint and front) joins `W.sites`, before worldbuild
  or anything else reads the lots. Go to (N) lists it ("Dealership" 🚘) and the minimap shows it (a
  car on blue). On today's fixtures the Commons gets a 64 x 39 m tech lot 390 m from the plaza (the
  whole lineup fits); an island gets a civic or downtown lot that fits a few of each.
- **The building:** a glass hall at the back of the lot (a white roof slab, a dark fascia with the
  name, a solid back wall, mullions, light strips), a forecourt in front with six bays and the walk
  to the door, a flag per brand on show, and a pylon sign. Inside, the on-sale vehicles (both of
  every class with two slots filled; cars first, then bikes) stand on slowly turning turntables
  (0.22 rad/s; Calm slows them), as many as fit (the flagship: all). Each vehicle is its stand-in
  body baked into one vertex-coloured mesh (one draw call each, shared by every showroom); the
  turntables and their glowing rims are two InstancedMeshes; the static parts are merged
  (hqMerge). At night the floor, back wall and glass glow and floodlights light the forecourt (no
  real lights). It is one of the City's civic buildings (its boxes block you, the far LOD box and
  the camera boxes as theirs). Measured headless: 56-78 draw calls for the whole view there.
- **The panel** (E at the door or anywhere on the forecourt; or click the door): Cars / Bikes, by
  type and cc band, the two vehicles of each class side by side (brand, model, the spec line, paint
  swatches), a turning 3D preview of the one picked (one small extra renderer, drawing only while
  the panel is open). **Everything is free and unlocked** (the owner's call): each card says
  "Free" and its button is **Get it**. The panel still reads `price` and `minLevel` (from the
  vehicle, else its class): a price shows as "12,000 coins" and "Buy · ...", a level the player
  lacks as "Needs level N" (the button disabled). textContent only; keys in the panel stay there
  (Escape closes).
- **Test drive:** you sit in the vehicle on the forecourt's first bay; the ride pill counts down 3
  minutes. When the time is up or you get out, it **drives itself back** along the roads (hqnav's
  drive route from where you left it to its bay, 9 m/s; nobody can get in meanwhile) and waits on
  its bay. Another test drive, Return to HQ or another world ends it at once.
- **Get it:** `HQV.hqGarage.buy(id, paint)` (games/hqgarage.js) delivers the vehicle to the city's
  garage; the panel says "Delivered to the garage — press C to call it". Without hqGarage the button
  reads "Getting vehicles opens soon".
- The temporary Showroom (G) is only there behind `?dev=1` now.
- Hooks for tools: `HQ3D.inst.dealer` (open, isOpen, test, testDrive, endTest), and
  `HQV.hqCity3d.dealer` (site, forecourt, route, inside).

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

Your vehicles live in the city's **multi-storey carpark** (games/hqcarpark.js, `HQV.hqCarpark`:
`find(W)` -> the city's carpark site or null, `bays(site)`, `exitPath(bay, site)` from the bay down
the ramps to the street entrance, `entryPath(bay, site)` the reverse, `entrance(site)` -> `{x, z, yaw}`
on the road graph; feature-detected, so calling works before it exists).

- **C** (a tap; held, C still raises the camera) or the **📞 Call (C)** button lists your vehicles:
  `HQV.hqGarage.mine()` (`own:<id>`) when the Arena's garage exists, until then the Showroom's vehicle,
  plus your HQ garage's car and motorbike. Each row: name, paint swatch, where it is ("In the carpark",
  "291 m away · ~53 s", "On its way · 120 m"). Keys inside never leak; textContent only.
- **Pick one** and it comes to you, picked in this order:
  1. It stands in this world within 1.5 km (`CALL_R`): it drives from there.
  2. It is in the carpark (a city with one): it leaves its bay (the bay is a stable hash of the
     vehicle), follows `exitPath` down the ramps at 7 m/s (`RAMP_V`, heights from the path), then
     drives the road route from `entrance()` to you.
  3. Else (no carpark, no route, another world) it **appears out of sight**: a street point
     45-320 m away, at least 40 m from you (`MIN_HIDE`) and outside the camera's frustum, with a
     road route under 900 m. It then drives the last stretch.
- **On the road** (games/hqnav.js route, drive mode) it keeps 1.8 m right of the centre line
  (`LANE`; everyone drives on the right) and cruises at 12 m/s. It slows for turns (4.5 m/s
  through a right angle, looked ahead 30 m) and keeps 6 m behind traffic and you
  (`aheadOf`, a 1.4 m half-lane). After 4 s held up by traffic it noses through for 3 s, since
  traffic stops for it too (`w.callRoad.obstacle`). It gives up and parks after 25 s stuck.
  Hazard lights blink, an orange dot shows on the minimap, and a pill reads
  "📞 BMW M3 on its way · 315 m · ~44 s". It never stops for you in its last 12 m.
- **It parks at the kerb beside you**, on the right of the way it came, 1.3 m in from the
  carriageway's edge and facing along the road. If you stand on that spot, it stops 6.5 m past
  you. E gets you in. It can't be boarded while it drives itself.
- **Calling again** redirects it at its current speed. Calling another vehicle parks the first one
  where it is.
- **When you get out**, 5 s later (`RETURN_S`) it drives itself back:
  - With a carpark: along the roads to `entrance()`, then `entryPath` up into its bay. There it
    leaves the world (no prop) and is marked stored. `HQV.hqCarpark.stored(site, bay, {key,
    vehicleId, color})` is called when it exists, so the carpark can show it.
  - With no carpark: back to its place by your HQ's garage.
  - Getting back in within the 5 s cancels it.
- **T (Return to HQ)** still puts everything back at your HQ.
- **A trip cut short** (you change world mid-trip) leaves the vehicle where it was. That pose is
  the only one saved through `hqGarage.park` (debounced). Otherwise the carpark is where your
  vehicles are.
- **World id, not `w.net`:** your vehicles are remembered by the City's world id (`w.world()`).
  `w.net` is `city3d` on the Commons and every island alike.
- **The Showroom's vehicle survives a world change:** it's remembered in this session and in
  localStorage (`hq3d.own.showroom.v1`). It stands where you left it in its own world, and
  anywhere else it arrives from out of sight.
- **Hooks for tools:** `HQ3D.inst.call` = `{open, pick(key), list, state, trips, own, prop(key),
  back(key), roads, isOpen}`. The City adds `w.callRoad = {snap, route, candidates, traffic, W,
  obstacle}`.
- **A newly claimed vehicle** is delivered into your bay in the carpark (the dealership's forecourt is only
  for the test drive).

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

1. Buying gate: decided, player level (each class's `minLevel`); free for all for now.
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
