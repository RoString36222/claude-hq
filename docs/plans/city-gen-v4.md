# City Gen v4: phases

The plan (City Gen v4 Plan, 24 Oct 2026) rebuilds the 3D City's world generator so roads,
transit and lots are planned like a real city. It ships **a phase at a time**. Each phase
merges on its own and leaves the City playable:

- **The live world upgrades in place.** `@3` keeps its id. The id is in about 45 files, so
  v4 is not a new version.
- **The world doc only gains fields.** An older dashboard still renders the new world, and
  a newer dashboard falls back to today's look on an older Arena.
- **The validator is in CI** (`backend/src/worldgen/validate.rs`). Each phase makes its own
  rules hard.
- **Layout phases regenerate the cities.** Lots, and so HQs, stay where they are wherever
  possible.

| # | Phase | Status |
|---|---|---|
| 1 | Airport claims its land; highways and the ring go round it; validator; road classes as data | **3.24.0** |
| 2 | Real road classes: widths, lanes, markings, one-step changes | **3.25.0** |
| 3 | Junctions by road pair: give-way, roundabouts, signals as generator data | **3.26.0** |
| 4 | Curved roads: arcs, minimum radii by design speed | **3.27.0** |
| 5 | Capacity per segment and the 0–100 % NPC traffic slider | **3.28.0** |
| 6 | Flyovers, underpasses and interchanges; road tunnels | **3.29.0** (interchanges; tunnels next) |
| 7 | Metro and rail corridors: piers only in boulevard medians | |
| 8 | Trams on any road class, with stations | |
| 9 | HQ spacing and movable garages | |
| 10 | Graphics pass within 1,200 / 240 draw calls | |
| S | Ambient volume slider and proximity sound (any time) | |

## Phase 1 (3.24.0)

- **`claims.rs`:** the airport's claim, rebuilt from the airport site alone. It covers:
  - the landside the client draws, each piece with 4 m round it:
    - the forecourt
    - the terminal with its canopy and skybridge
    - the car park
    - the control tower
  - the airside for every runway offset the client tries (355–455 m)
  - the object-free areas
  - the runway protection zones: 61 m past each end, 518 m long, widening from 152 m to
    308 m (FAA AC 150/5300-13B)

  Roads keep off the whole claim. Only the terminal, the airside and the runway zones
  must be dry: on the live Commons, the client's car park already stands in a lake, and
  the validator lists that (`airport-water`) for a later phase.
- **The ring corridor:** the strip between the terminal's back and the airside.
  - The ring road alone may run there, under the terminal's skybridge, as the airport was
    designed (`airport-spec.md`). It is the user's call for phase 1 (27 Oct).
  - On the Commons the town's own street meets the airport's forecourt, so the ring has
    no room landside. Leaving it open cut the City's traffic from 197 to 118 cars.
  - Phase 6 takes the ring under the airport.
  - The airside claim starts where the client puts the airside with the ring there: the
    runway at 395 m, as on the Commons.
- **`civic::airport_first`:** places the airport before the graded roads. It uses the
  same search as before, plus these checks:
  - The claim stays clear of every block and site.
  - Its dry part stays clear of the river, its pools and the water bodies.
  - The client's platform rule must hold at one of its runway offsets: the airside ground
    no higher than the terminal's.
- **Roads (`roads.rs`):**
  - Highway and ring steps never enter the claim.
  - A gate inside the claim, or cut off from the city by it, slides along the world's
    edge until it is clear.
  - Highways keep out of the ring corridor too, so they meet the ring away from the
    airport.
  - A ring section whose only way past the airport is the long way round the city
    (beyond the far side of the city from its two ends) is left out, and the ring stops at
    the highway junctions either side. This happens on 1 of the 49 seeds; the Commons
    keeps all six sections.
- **Other layers keep off the claim:**
  - the dock, port and stadium (`civic::outside`)
  - the line planners' stations, depots and trenches (`lines::Land.taken`)
  - the Island Link's above-ground track (`railway.rs`)
  - trees: the claim's districts are wild, not forest or park
- **Validator:**
  - Hard rule: nothing but the airport stands in its claim.
  - What counts for track: underground (3 m of ground over the rails) is fine anywhere.
    A viaduct is fine over the landside, as the City Line's airport station is at the
    kerb. Nothing above ground may stand over the airside or the runway zones.
  - Listed only, for later phases: site overlaps, lot/site overlaps, roads through
    sites, roads over water, the landside over water.
- **`classes.rs`:** the 11 road classes with tram versions, capacity (one car per 7.5 m of
  lane; level of service D, 22 a km a lane), minimum radii, tapers, the one-step ladder,
  junction by road pair, and spacings.

### Before and after (`worldgen --validate`, release build)

The worlds are the Commons (`claude-hq@3`) and 49 Commons-profile seeds (`v4seed1@3` to
`v4seed50@3`). `v4seed7@3` fails to generate on main too, because it has too few HQ lots.

| | main | 3.24.0 |
|---|---|---|
| The Commons: roads in the airport's land | 5: Await Way, Stack Way, Ring Road 4–6 | 0 |
| Worlds breaking the airport rule | 50 of 50 | 0 of 50 |
| Client runway fits (`hqairfield.layout`) | 17 of 50 | 50 of 50 |
| HQ lots unchanged | — | 50 of 50 |
| Ring left open beside the airport | — | 1 of 50 (not the Commons) |
| The Commons: NPC cars, Monday 09:00 | 197 | 196 |

On the Commons, these are unchanged:
- the airport and its runway
- the ring behind the terminal
- the metro: 2 lines, 8 stations
- the rail stations
- the City's traffic
- every HQ lot

The changes there:
- The two west highways (Stack Way and Await Way) now meet the ring north and south of
  the airport, instead of boxing in the terminal.
- The airport's grounds have no trees.

### Tests that depended on the old world

Four browser tests asserted luck of the old fixture: which streets, spot or platoon the
hashes happened to pick. They now check the rule they meant, and pass on both the old
fixture and the new one:

- **`test_play_races`:** checkpoint 2 is missed on whichever side keeps the drive clear
  of it.
- **`test_play_street`:** the median of the ten busiest spots, not one spot.
- **`test_citylife_traffic`:**
  - The mix picks lorries, and only a platoon's first car drives one.
  - The view draws a lorry body.

## Phase 2 (3.25.0)

The user's calls (27 Oct): real widths; boulevards only where they fit, with no lot or HQ
moving.

### Generator

- **Each street's starting class** (`organic::v4_roles`):
  - main road: boulevard where every block along it is at least 50 m, else avenue
  - old-town or plaza street: shared street
  - dead end, or under 60 m: lane
  - 150 m or more and joining main roads at two places: collector
  - anything else: local street
- **Paving** (`widen.rs`): a street steps down its class ladder, as the 3.20.1 tiers did,
  where a lot can't give way, or where its carved ground would reach water.
  - A main road may step down below its layout width only to keep a bend one class at a
    time. Its lanes are then the class's, and the footpaths take the rest.
  - Where a road runs on through a bend, its two sides are at most one class apart.
- **New road fields** (only on `@3`; `@1` and `@2` stay byte-identical):
  - `v4`: the class
  - `lanes`: lanes each way
  - `median`: the median width (cm). Not set on a street a tram runs down until phase 8.

  `class` keeps today's kind, so older dashboards still work.
- **Validator, hard rules:**
  - `class-width`: carriageway, lanes and median are the class's, and footpaths at least
    the class's.
  - `class-step`: a town road at a bend is at most one class from its other side.
  - A step involving a highway or the ring is listed for phases 3 and 6.

### Browser

- **`world.js`:** carries `v4` and `median`. A median is raised paving, not carriageway.
- **`worldgeom.js`:**
  - kerbed medians: concrete, or planted on a boulevard
  - pavers on shared streets
  - lines by class: none on a shared street or lane; a dashed centre on a local street or
    collector; edge lines along a median and dashed lane lines
  - no zebras across a shared street or lane
- **`traffic.js`, `npcsim.js`:**
  - cars drive in the class's kerb-side lane between median and kerb
  - an emergency run never takes the middle of a road with a median
  - where the lanes in and out of a sharp bend cross, they are cut back, as at a hairpin
- **`citylife.js`:** a light's approach that leaves under 8 m to wait in, with a junction of
  three roads behind it, makes the two one box (as a short link already did).

### Results

The worlds are the Commons and 49 seeds, against phase 1:

| | phase 1 | 3.25.0 |
|---|---|---|
| Hard rules broken | 0 | 0 |
| Airports, runway fit, HQ lots unchanged | — | 50 / 50 each |
| Commons NPC cars, Monday 09:00 | 185 | 196 |
| Commons lorries (industrial test) | 0 | 4 |

The Commons' edges by class: 121 avenue (89 with a median), 102 collector, 253 local, 127
lane, 49 shared.

No boulevard fits yet. In today's organic layouts no main road has 50 m blocks all along,
and a 36.5 m road's junctions need them. In a first try that paved boulevards wherever the
lots allowed, their junctions overlapped and traffic jammed at the lights.

The ring and highways stay at today's widths. As 29 m expressways at at-grade junctions,
they cut the Commons' traffic from about 200 cars to 133. They become expressways with
their interchanges in phase 6.

## Phase 3 (3.26.0)

### Generator (`Roads::junctions`, `junction_kinds`)

Each junction of town roads gets `junction` (`priority`, `mini`, `roundabout` or
`signals`) and, for a roundabout, `island` (its radius, cm). The decision is by the two
highest *roads* that meet, not arms: a street running straight on through a junction is
one road, so a T stays a T.

- **Give-way** (`priority`): local streets, lanes and shared streets with each other or a
  collector, and a side street joining a main road at a T. The plan's table has no row for
  a side street onto a main road; a T gives way.
- **Mini roundabout:** a five-arm give-way junction, and collectors meeting each other or
  an avenue where a full roundabout has no room.
- **Full roundabout** (32 m, a 10 m planted island): collectors meeting each other or an
  avenue, only where every arm is at least 40 m long and the circle (plus 1 m) is clear of
  every lot and site. The line planners keep off its circle.
- **Signals:**
  - avenues and boulevards crossing
  - a main road crossing a side street (a four-way, as in 3.22.1): "main" means an arterial
    by function, even one paved narrow, and the light stays at least 60 m from any other
- **A tram line through a junction** never gets a roundabout: lights where a main road
  meets, else give-way.
- **Junctions with a highway or the ring** have no control yet. They are phase 6's
  interchanges.

Validator, hard rule `junction`: every junction carries the control its roads call for,
and a full roundabout has room on every arm.

### Browser

- **`citylife.signals`:** where the world carries junction data, lights stand exactly at
  its signals. The arms, stops, timings and links logic is unchanged. A world without the
  data is lit as before.
- **`worldgeom.js`:**
  - a mini roundabout's white dome
  - a full roundabout's paved circle, with a kerbed, planted island and no corner footpaths
    cutting into it
  - give-way lines across the way in on every arm of a roundabout, and on the lesser roads
    of a give-way junction
- **`world.js`:** a full roundabout's island reads as raised ground.
- **`traffic.js`:** turns at a roundabout go round its island (2 m out from a mini one's
  dome, 3 m into a full one's 6 m carriageway), circling with the island away from the kerb.
  A full roundabout's box is its circle.
- **`npcsim.js`:** residents' car routes take the same arc round a full roundabout
  (`roundRoute`).

### Results

- **The Commons:** 26 signals (24 lit, two pairs a short link apart are one junction), 11
  mini roundabouts and 225 give-ways.
- **50 worlds:** 411 mini roundabouts, 1,185 signals, 9,328 give-ways and no full roundabout. A
  32 m circle with three separate roads meeting rarely has room in today's organic
  layouts, so `test_junctions_v4.py` makes one at a busy Commons junction to test it.
- **Traffic:** cars on screen by day 16.7 against phase 2's 15.9; 173 cars in all against
  196, with fewer side streets lit than 3.22.1's 43.
- **No layout change:** airports, runway fit, HQ lots and the metro are the same as phase 2
  on all 50 worlds.

## Phase 4 (3.27.0): curved roads

- **Town streets** (`roads::fillet_bends`): every bend where a street runs on (a node of
  exactly two town edges, not a bridge) becomes a circular arc instead of a corner.
  - It's the widest arc whose middle sits no more than 25 cm inside the corner. That's the
    kerb's width, so the paved road still keeps off every lot and no lot or HQ moves.
  - Its tangents reach no further than 0.4 of either edge, and it's sampled every 2.5 m
    with at least one step per 15° of turn.
  - The node moves onto the arc's middle.
  - The maths is integer only: Q16 unit vectors, half angles from the cosine, and points
    round the centre by normalised interpolation.
- **Ring and highways** (`roads::smooth_path`): the A* path's 45° steps are eased by a
  three-pass moving average (4 points each side, ends fixed), then sampled every 4 m.
  Where a smoothed step meets a block, claimed land, the river or the coast's reach and
  the path's own step there didn't, the path's points come back over 5 steps either side.
- **Validator, listed for later phases** (organic layouts can't meet the plan's radii yet):
  - `bend`: a town street still turning over 20° at a bend, a sharp corner the kerb's
    25 cm can't round
  - `curve`: a curve tighter than its class's design-speed minimum

### Results

The worlds are the Commons and 49 seeds.

| | phase 3 | 3.27.0 |
|---|---|---|
| Commons town bends turning under 5° at the node | 78 of 199 | 133 of 199 |
| Ring and highway kinks over 17°, the Commons | 139 | 18 |
| Ring and highway kinks over 17°, all 50 worlds | 7,182 | 1,109 |
| Airports, runway fit, HQ lots unchanged | — | 50 / 50 |
| Commons cars on screen by day | 16.7 | 16.5 |

The metro shifted slightly on 8 synthetic seeds, because it follows the roads. The
Commons' metro is unchanged.

### Also in 3.27.0 (the user's requests for the street)

- **Wanted stars** (`playheat.js`):
  - Each offence adds about half as much: ramming +0.5, a red light +0.5, props +0.1.
  - Repeat cooldowns are longer.
  - Only an offence worth a whole star forces one. A lone fraction wears off while no
    police car is near.
  - A star goes every 6 + 3×stars s unseen (was 12 + 6×stars).
- **Garage cars in traffic** (`traffic.js` `streetCars` / `carLook`):
  - Six everyday catalogue cars (hatch, sedan, SUV, coupe in turn).
  - Model and paint from a hash of the vehicle id, the same on every client.
  - Each is baked into one instanced mesh, scaled to the sim's car footprint, for the 40
    cars nearest the camera. The box car is the fallback.
- **Carjack** (new city play feature `playcarjack.js`):
  - E by a traffic car going under 4 m/s and within 3.5 m.
  - `hq3d` builds the same model where it stood and seats you. The traffic car is hidden on
    this client while you hold it.
  - Getting out parks it; 150 m away it goes back.
  - +0.5 heat when a police car sees it.

## Phase 5 (3.28.0): capacity and the traffic slider

- **`traffic.js`:** a traffic level from 0 to 1 (`o.traffic`, `sim.setLevel`).
  - The sim fills every slot's candidate cars for the fullest level. The level keeps those
    whose fixed hash is under its share of the slots.
  - At 0.85 (`LEVEL0`) the share is today's, the tier's `DENS`. At 1 it's every slot the
    timetable has; at 0, none.
  - Each ring keeps at most `LOS_D` = 22 cars a km of its lane at the level (the plan's
    comfortable level of service D at 100%) and never more than one per `CAR_M` = 7.5 m
    (the hard cap). The cars kept are the ones with the lowest hash.
  - Changing the level rebuilds each ring's cars, its platoon leaders, room and groups, so
    it's exactly a sim made at that level.
  - Buses and trams keep their timetables.
- **Settings** (`index.html` `setTraffic`, `ui/app/16-settings.js`): an **NPC traffic**
  slider, saved in localStorage `hq_traffic` (unset means 85%). It sets the open City's
  level live through `HQV.cityTrafficLevel` (`games/hqcity3d.js`).

### What limits traffic today

On the Commons the light and junction timetables hold about 9 cars a km of loop even with
every slot filled (196 cars). That's well under the plan's comfortable 22 a km and far under
the hard cap of 133 a km. So the slider's top end is the timetable's room, and the 22 a km
cap trims only one short, dense loop by the lights.

| Level | Cars on the Commons | Out at 08:00 |
|---|---|---|
| 0 % | 0 | 0 |
| 25 % | 41 | 40 |
| 50 % | 98 | 90 |
| 85 % (default) | 167 | — |
| 100 % | 191 | 179 |

Before this phase the Commons had 172 cars. The new cap trims one loop by 5.

## Phase 6 (3.29.0): expressways and trumpet interchanges

- **Expressways:** the ring and the highways are `v4: "expressway"`: 29 m, three lanes each way, a 3 m barrier median
  and 2.5 m shoulders. They are routed with that width (profile `ring_cm`/`highway_cm`) and never into a lake's or the
  marina's bank (the carving of a 29 m road would reach the water).
- **Trumpets (`backend/src/worldgen/interchange.rs`):** where a highway meets the ring and one fits, a trumpet
  replaces the junction, laid on the base terrain in the ring's frame. Points sit along the ring's eased line and out
  along its normal at the junction, so the stretches beside the ring follow its curve and the loop keeps its shape.
  - **The flyover:** the highway's last stretch (`v4: "flyover"`, a lane each way) climbs at up to 5.5 % to a deck
    7 m (5.5 m clear + 1.5 m deck) over the ring.
  - **Four one-way ramps** (`v4: "ramp"`, `oneway: true`):
    - two slip roads on the city side;
    - a 30 m loop off the deck to the ring's outer kerb, passing under the flyover;
    - a ramp round the loop, climbing to the flyover's top end T.
  - **Lane balance:** every ramp junction (`junction: "ramps"`) has as many of the sim's lanes in as out. An
    expressway's sim lanes are its lanes less the one by the median. The ring has a lane fewer each way between a
    trumpet's two ramp junctions.
  - **Heights:** come in `seat`, a second pass raising a flyover's foot on an embankment where the graded ring is higher
    than the land. Land under a deck is not carved.
  - **No trumpet** where the coast, a lake or the river, a block, the airport's claim, another road, a bridge or another
    junction is in the way; where the ring is too curved; or where the highway is too short or meets at an angle.
- **Validator:** `ramps`, `deck-grade` (6 %) and `clearance` (7 m under every deck) are hard rules; `road-overlap` lists
  roads crossing at grade with no junction. Expressway junctions still at grade have no control (no lights on an
  expressway).
- **Client:**
  - `world.js`: stacked surfaces. `groundAt`, `roadY`, `surfaceAt`, `nearestRoad` and `blockedAt` take the height of
    whatever stands there; `decksOf` and `piersOf`. `hqcity3d.js` passes the avatar's height for points near it.
  - `worldgeom.js`: decks, parapets, piers, retaining walls, expressway lane lines and barrier.
  - `traffic.js`: several lanes a way, one-way ramps, lanes paired by where they end.
  - `npcsim.js` and `hqnav.js`: route one way on the ramps.

| | Commons | 50 seeds + the Commons |
|---|---|---|
| Trumpets | 3 of 6 junctions | 70 of 296 |
| Cars at the usual setting | 292 (167 before) | — |

Most junctions left at grade have a highway that is too short or meets the ring at an angle (91), or another junction
or a bridge too close on the ring (63). A later layout phase (or tunnels) can take more of them.
